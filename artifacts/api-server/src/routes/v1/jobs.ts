import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireApiKey } from "../../lib/api-auth.js";
import {
  parseLimit, parseDateParam, decodeCursor, paginate, countFor, fail,
  companyOf, money, iso, dateOnly, formatAddress, today,
} from "./_shared.js";

// [ai-access 2026-08-15] Jobs, schedule, and technician roster for Qleno
// Connect. Read-only — every write endpoint in the design doc lands in Phase 5,
// after these have run on real traffic. Design: docs/AI_ACCESS_DESIGN.md §3.
const router = Router();

/**
 * One SELECT shape for every job read, so /jobs, /jobs/:id, /schedule/day and
 * /schedule/unassigned cannot drift apart. A published API where the same record
 * has different fields depending on which endpoint returned it is the kind of
 * inconsistency an assistant has no way to reason about.
 *
 * The address falls back job → client → account property in that order: a job
 * carries its own address only when the office overrode it, which is exactly
 * when it should win.
 */
const JOB_SELECT = sql`
  SELECT
    j.id,
    j.status,
    j.service_type,
    j.job_kind,
    j.frequency,
    j.scheduled_date,
    j.scheduled_time,
    j.arrival_window,
    j.base_fee,
    j.billed_amount,
    j.allowed_hours,
    j.actual_hours,
    j.notes,
    j.office_notes,
    j.flagged,
    j.created_at,
    j.charge_succeeded_at,
    -- Clock times are NOT columns on jobs; they live in timeclock, one pair per
    -- tech per house (see CLAUDE.md, Time Clock). For a multi-tech job the job
    -- started when the first tech clocked in and ended when the last clocked
    -- out, so these aggregate rather than pick a row. clock_out_at stays null
    -- while anyone is still on site — MAX() would otherwise report the job
    -- finished because one tech left early.
    tc.first_clock_in                                        AS clock_in_at,
    tc.last_clock_out                                        AS clock_out_at,
    j.client_id,
    j.account_id,
    j.account_property_id,
    j.assigned_user_id,
    COALESCE(j.address_street, c.address, ap.address)        AS addr_street,
    COALESCE(j.address_city,   c.city,    ap.city)           AS addr_city,
    COALESCE(j.address_state,  c.state,   ap.state)          AS addr_state,
    COALESCE(j.address_zip,    c.zip,     ap.zip)            AS addr_zip,
    TRIM(CONCAT(c.first_name, ' ', c.last_name))             AS client_name,
    c.phone                                                  AS client_phone,
    c.email                                                  AS client_email,
    a.account_name,
    ap.property_name,
    z.id                                                     AS zone_id,
    z.name                                                   AS zone_name,
    -- Every assigned tech, not just the primary. The dispatch grid reads
    -- jobs.assigned_user_id, but an assistant asked "who is on this job" needs
    -- the whole crew or it will confidently answer with one name for a two-tech
    -- clean.
    COALESCE(
      (SELECT json_agg(json_build_object(
                'id', u.id,
                'name', TRIM(CONCAT(u.first_name, ' ', u.last_name))
              ) ORDER BY jt.is_primary DESC, u.id)
       FROM job_technicians jt
       JOIN users u ON u.id = jt.user_id
       WHERE jt.job_id = j.id),
      '[]'::json
    ) AS technicians
  FROM jobs j
  LEFT JOIN clients c            ON c.id  = j.client_id
  LEFT JOIN accounts a           ON a.id  = j.account_id
  LEFT JOIN account_properties ap ON ap.id = j.account_property_id
  LEFT JOIN LATERAL (
    SELECT MIN(t.clock_in_at) AS first_clock_in,
           CASE WHEN COUNT(*) FILTER (WHERE t.clock_out_at IS NULL) > 0
                THEN NULL ELSE MAX(t.clock_out_at) END AS last_clock_out
    FROM timeclock t
    WHERE t.job_id = j.id
  ) tc ON true
  -- Zone resolution mirrors the dispatch chain: the job's own zone first, then
  -- whichever zip we can find. A job with no zone is a data error, not a
  -- filtering condition, so it still comes back — with zone: null, visible.
  --
  -- LATERAL with LIMIT 1, not a plain LEFT JOIN: a job whose zone_id points at
  -- one zone while its zip belongs to another would match both rows, and a
  -- plain join would return that job TWICE in the list — silently inflating
  -- every count an assistant computes from the page.
  LEFT JOIN LATERAL (
    SELECT sz.id, sz.name
    FROM service_zones sz
    WHERE sz.company_id = j.company_id
      AND sz.is_active = true
      AND (sz.id = j.zone_id
           OR COALESCE(j.address_zip, c.zip, ap.zip) = ANY(sz.zip_codes))
    ORDER BY (sz.id = j.zone_id) DESC, sz.id
    LIMIT 1
  ) z ON true
`;

type JobRow = Record<string, any>;

function serializeJob(r: JobRow) {
  return {
    id: Number(r.id),
    status: r.status,
    service_type: r.service_type,
    job_kind: r.job_kind,
    frequency: r.frequency,
    scheduled_date: dateOnly(r.scheduled_date),
    // Web bookings put the customer's chosen time in arrival_window and leave
    // scheduled_time null. Reading only scheduled_time reports "no time" for
    // every job that came through the widget.
    scheduled_time: r.scheduled_time ?? r.arrival_window ?? null,
    arrival_window: r.arrival_window ?? null,
    address: formatAddress(r.addr_street, r.addr_city, r.addr_state, r.addr_zip),
    zip: r.addr_zip ?? null,
    zone: r.zone_id ? { id: Number(r.zone_id), name: r.zone_name } : null,
    client: r.client_id
      ? { id: Number(r.client_id), name: r.client_name || null, phone: r.client_phone ?? null, email: r.client_email ?? null }
      : null,
    account: r.account_id ? { id: Number(r.account_id), name: r.account_name ?? null } : null,
    property: r.account_property_id
      ? { id: Number(r.account_property_id), name: r.property_name ?? null }
      : null,
    technicians: (r.technicians ?? []).map((t: any) => ({ id: Number(t.id), name: t.name })),
    // Commercial jobs bill hourly; residential carry an all-in base_fee. Both
    // are published, and price is the one the office quoted.
    price: money(r.billed_amount ?? r.base_fee),
    base_fee: money(r.base_fee),
    billed_amount: money(r.billed_amount),
    allowed_hours: money(r.allowed_hours),
    actual_hours: money(r.actual_hours),
    clock_in_at: iso(r.clock_in_at),
    clock_out_at: iso(r.clock_out_at),
    paid_at: iso(r.charge_succeeded_at),
    flagged: !!r.flagged,
    notes: r.notes ?? null,
    office_notes: r.office_notes ?? null,
    created_at: iso(r.created_at),
  };
}

/**
 * GET /api/v1/jobs
 *
 * Sorted by (scheduled_date, id) — the order an operator thinks in, and stable
 * enough to page through safely while the board changes underneath.
 */
router.get("/jobs", requireApiKey("rest", "jobs:read"), async (req, res) => {
  const companyId = companyOf(req);
  const limit = parseLimit(req.query.limit);

  const from = req.query.from ? parseDateParam(req.query.from) : null;
  const to = req.query.to ? parseDateParam(req.query.to) : null;
  if (req.query.from && !from) { fail(res, 400, "invalid_parameter", "from must be a date as YYYY-MM-DD"); return; }
  if (req.query.to && !to) { fail(res, 400, "invalid_parameter", "to must be a date as YYYY-MM-DD"); return; }
  if (from && to && from > to) { fail(res, 400, "invalid_parameter", "from is after to"); return; }

  const cursor = decodeCursor(req.query.cursor);
  const num = (v: unknown) => (v === undefined ? null : Number(v));
  const techId = num(req.query.tech_id);
  const zoneId = num(req.query.zone_id);
  const clientId = num(req.query.client_id);
  const accountId = num(req.query.account_id);
  for (const [name, v] of [["tech_id", techId], ["zone_id", zoneId], ["client_id", clientId], ["account_id", accountId]] as const) {
    if (v !== null && !Number.isFinite(v)) { fail(res, 400, "invalid_parameter", `${name} must be a number`); return; }
  }

  const status = typeof req.query.status === "string" ? req.query.status : null;
  const VALID_STATUS = ["scheduled", "in_progress", "complete", "cancelled"];
  if (status && !VALID_STATUS.includes(status)) {
    fail(res, 400, "invalid_parameter", `status must be one of: ${VALID_STATUS.join(", ")}`, { valid: VALID_STATUS });
    return;
  }

  const rows = await db.execute(sql`
    ${JOB_SELECT}
    WHERE j.company_id = ${companyId}
      ${from ? sql`AND j.scheduled_date >= ${from}::date` : sql``}
      ${to ? sql`AND j.scheduled_date <= ${to}::date` : sql``}
      ${status ? sql`AND j.status = ${status}` : sql``}
      ${clientId !== null ? sql`AND j.client_id = ${clientId}` : sql``}
      ${accountId !== null ? sql`AND j.account_id = ${accountId}` : sql``}
      ${zoneId !== null ? sql`AND z.id = ${zoneId}` : sql``}
      ${techId !== null
        ? sql`AND (j.assigned_user_id = ${techId}
                   OR EXISTS (SELECT 1 FROM job_technicians jt2
                              WHERE jt2.job_id = j.id AND jt2.user_id = ${techId}))`
        : sql``}
      ${cursor
        ? sql`AND (j.scheduled_date, j.id) > (${String(cursor.k)}::date, ${cursor.id})`
        : sql``}
    ORDER BY j.scheduled_date ASC, j.id ASC
    LIMIT ${limit + 1}
  `);

  const out = paginate((rows.rows as JobRow[]).map(serializeJob), limit, (j) => ({
    k: j.scheduled_date, id: j.id,
  }));
  countFor(res, out.data.length);
  res.json(out);
});

/** GET /api/v1/jobs/:id — same shape as a list row, nothing extra to special-case. */
router.get("/jobs/:id", requireApiKey("rest", "jobs:read"), async (req, res) => {
  const companyId = companyOf(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { fail(res, 400, "invalid_parameter", "id must be a number"); return; }

  const rows = await db.execute(sql`
    ${JOB_SELECT}
    WHERE j.company_id = ${companyId} AND j.id = ${id}
    LIMIT 1
  `);

  const row = (rows.rows as JobRow[])[0];
  // 404 for another tenant's job as well as a nonexistent one. Distinguishing
  // them would confirm that id 20810 exists somewhere, which is a cross-tenant
  // leak however small.
  if (!row) { fail(res, 404, "not_found", "No job with that id"); return; }
  countFor(res, 1);
  res.json(serializeJob(row));
});

/**
 * GET /api/v1/schedule/day?date=YYYY-MM-DD
 *
 * Defaults to today in the tenant's own zone. "What's on today" is the single
 * most likely question an assistant will be asked, and making the date optional
 * means it doesn't have to guess the operating timezone to ask it — the server
 * knows the zone, the caller does not, so the server resolves it. GET /me
 * publishes that zone for callers who want to name the date themselves.
 */
router.get("/schedule/day", requireApiKey("rest", "jobs:read"), async (req, res) => {
  const companyId = companyOf(req);
  const date = req.query.date ? parseDateParam(req.query.date) : today(companyId);
  if (!date) { fail(res, 400, "invalid_parameter", "date must be YYYY-MM-DD"); return; }

  const rows = await db.execute(sql`
    ${JOB_SELECT}
    WHERE j.company_id = ${companyId} AND j.scheduled_date = ${date}::date
    ORDER BY j.scheduled_time NULLS LAST, j.id ASC
  `);

  const jobs = (rows.rows as JobRow[]).map(serializeJob);
  countFor(res, jobs.length);
  res.json({
    date,
    // The counts an operator actually opens the board to check, computed here so
    // an assistant doesn't have to derive them and get them subtly wrong.
    summary: {
      total: jobs.length,
      // Cancelled jobs are excluded from `unassigned`, matching what
      // GET /schedule/unassigned returns. They disagreed before: on 2026-08-13
      // this said 2 unassigned and that endpoint returned none, because both
      // were cancelled. One word must mean one thing across a published API, and
      // the useful meaning is "still needs a tech" — nobody staffs a cancelled
      // job. The cancelled count below is where those rows are visible.
      unassigned: jobs.filter((j) => j.technicians.length === 0 && j.status !== "cancelled").length,
      complete: jobs.filter((j) => j.status === "complete").length,
      cancelled: jobs.filter((j) => j.status === "cancelled").length,
      revenue: Number(jobs
        .filter((j) => j.status !== "cancelled")
        .reduce((s, j) => s + (j.price ?? 0), 0)
        .toFixed(2)),
    },
    jobs,
  });
});

/**
 * GET /api/v1/schedule/unassigned?from&to
 *
 * Unassigned means no tech at all — neither the mirrored primary on
 * jobs.assigned_user_id nor any row in job_technicians. Checking only
 * assigned_user_id would report the split-brain state as unassigned; checking
 * only job_technicians would miss jobs assigned before the mirror existed.
 * Cancelled jobs are excluded: nobody needs to staff them.
 */
router.get("/schedule/unassigned", requireApiKey("rest", "jobs:read"), async (req, res) => {
  const companyId = companyOf(req);
  const from = req.query.from ? parseDateParam(req.query.from) : today(companyId);
  const to = req.query.to ? parseDateParam(req.query.to) : null;
  if (!from) { fail(res, 400, "invalid_parameter", "from must be YYYY-MM-DD"); return; }
  if (req.query.to && !to) { fail(res, 400, "invalid_parameter", "to must be YYYY-MM-DD"); return; }

  const limit = parseLimit(req.query.limit);
  const rows = await db.execute(sql`
    ${JOB_SELECT}
    WHERE j.company_id = ${companyId}
      AND j.scheduled_date >= ${from}::date
      ${to ? sql`AND j.scheduled_date <= ${to}::date` : sql``}
      AND j.status <> 'cancelled'
      AND j.assigned_user_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM job_technicians jt2 WHERE jt2.job_id = j.id)
    ORDER BY j.scheduled_date ASC, j.id ASC
    LIMIT ${limit + 1}
  `);

  const out = paginate((rows.rows as JobRow[]).map(serializeJob), limit, (j) => ({
    k: j.scheduled_date, id: j.id,
  }));
  countFor(res, out.data.length);
  res.json(out);
});

/**
 * GET /api/v1/technicians
 *
 * The roster plus today's load, because "who is free tomorrow" is unanswerable
 * from a roster alone and an assistant would otherwise fetch every job and count
 * by hand.
 *
 * Deliberately publishes no pay rates, no bank details, no DOB, no address —
 * the key holder is an owner or admin who can see those in the app, but a
 * roster endpoint is not where that data belongs, and an assistant that never
 * receives it can never leak it.
 */
router.get("/technicians", requireApiKey("rest", "jobs:read"), async (req, res) => {
  const companyId = companyOf(req);
  const date = req.query.date ? parseDateParam(req.query.date) : today(companyId);
  if (!date) { fail(res, 400, "invalid_parameter", "date must be YYYY-MM-DD"); return; }

  const rows = await db.execute(sql`
    SELECT
      u.id, u.first_name, u.last_name, u.role, u.phone, u.email, u.is_active,
      COALESCE(load.job_count, 0)      AS job_count,
      COALESCE(load.allowed_hours, 0)  AS allowed_hours
    FROM users u
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS job_count, SUM(j.allowed_hours) AS allowed_hours
      FROM jobs j
      WHERE j.company_id = u.company_id
        AND j.scheduled_date = ${date}::date
        AND j.status <> 'cancelled'
        AND (j.assigned_user_id = u.id
             OR EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.user_id = u.id))
    ) load ON true
    WHERE u.company_id = ${companyId}
      AND u.role IN ('technician', 'trainee')
      AND u.is_active = true
    ORDER BY u.first_name, u.last_name
  `);

  const techs = (rows.rows as any[]).map((r) => ({
    id: Number(r.id),
    name: `${r.first_name} ${r.last_name}`.trim(),
    role: r.role,
    phone: r.phone ?? null,
    email: r.email ?? null,
    load_on: date,
    job_count: Number(r.job_count ?? 0),
    allowed_hours: money(r.allowed_hours) ?? 0,
  }));
  countFor(res, techs.length);
  res.json({ date, data: techs });
});

export default router;
