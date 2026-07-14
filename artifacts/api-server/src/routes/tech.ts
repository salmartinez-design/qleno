/**
 * Cutover 1B — `/api/tech/today` (now-focused tech day view, read-only).
 *
 * Returns the authenticated tech's jobs + office events for a given date,
 * grouped server-side into done | current | next | later so the UI
 * (1B's /my-day page) renders a timeline with one hero, not a flat list.
 * Tenant-scoped via req.auth!.companyId; assigned_user_id always = the
 * authenticated user (no userId override param — privacy rule from
 * the 1B spec: the tech sees only their own day, full stop).
 *
 * No writes. No clock semantics. Clock-in / on-my-way / GPS arrive in 1C.
 * The 1B UI's primary-action button routes to a 1C stub.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import {
  jobsTable,
  clientsTable,
  accountsTable,
  accountPropertiesTable,
  serviceTypesTable,
  serviceZonesTable,
  timeclockTable,
  scorecardEntriesTable,
  usersTable,
} from "@workspace/db/schema";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { computeCompositeForEmployee } from "../lib/scorecard-composite.js";

const router = Router();

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// [tech-scorecard 2026-07-14] Resolve which employee's data to return. A tech
// only ever sees their OWN (req.auth.userId). owner/admin/office can pass
// ?employee_id= to preview a tech's screen — the SAME "viewing as" override the
// /api/jobs/my-jobs day view uses, so the scorecard/history panels follow the
// impersonation banner. A regular tech's override is ignored.
function resolveViewedUserId(req: any): number {
  const self = Number(req.auth!.userId);
  const role = req.auth!.role;
  const canViewAsOther = role === "owner" || role === "admin" || role === "office" || role === "super_admin";
  const override = req.query.employee_id != null ? parseInt(String(req.query.employee_id), 10) : NaN;
  return canViewAsOther && Number.isFinite(override) ? override : self;
}

type GroupingHint = "done" | "current" | "next" | "later";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tech/today?date=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────
//
// Returns the authenticated tech's items for the date (default today),
// ordered by scheduled_time. Each item carries a grouping hint so the
// UI doesn't re-derive it client-side. Day summary at the top of the
// payload counts done vs remaining for the header subtitle.
//
// Privacy: there is NO userId override param. Even the owner cannot
// view a tech's day through this endpoint. Admin-side "see anyone's
// day" is a separate route (later piece). 1B's surface is strictly
// the tech's own day.

router.get("/today", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const userId = req.auth!.userId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }

    const dateRaw = (req.query.date as string | undefined) ?? "";
    let date: string;
    if (dateRaw === "") {
      const today = new Date();
      date = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
    } else if (ISO_DATE_RE.test(dateRaw)) {
      date = dateRaw;
    } else {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "date must be YYYY-MM-DD" });
    }

    // Pull the day's jobs + everything we need to render the timeline.
    // Address resolves account_property → client fallback to mirror the
    // pattern in /api/jobs/my-jobs so the day view never renders a
    // partial address. Zone resolves via clients.zone_id when present.
    const rows = await db
      .select({
        id: jobsTable.id,
        client_id: jobsTable.client_id,
        account_id: jobsTable.account_id,
        account_property_id: jobsTable.account_property_id,
        client_first_name: clientsTable.first_name,
        client_last_name: clientsTable.last_name,
        client_company_name: clientsTable.company_name,
        account_name: accountsTable.account_name,
        property_name: accountPropertiesTable.property_name,
        address_street: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.address} ELSE ${clientsTable.address} END`,
        address_city: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.city} ELSE ${clientsTable.city} END`,
        address_state: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.state} ELSE ${clientsTable.state} END`,
        address_zip: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.zip} ELSE ${clientsTable.zip} END`,
        zone_name: serviceZonesTable.name,
        service_type_slug: jobsTable.service_type,
        service_type_name: serviceTypesTable.name,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        allowed_hours: jobsTable.allowed_hours,
        status: jobsTable.status,
        job_kind: jobsTable.job_kind,
        frequency: jobsTable.frequency,
        scope_first_time_in: jobsTable.scope_first_time_in,
        special_equipment_needed: jobsTable.special_equipment_needed,
        out_of_rotation: jobsTable.out_of_rotation,
        scope_deep_clean: jobsTable.scope_deep_clean,
        scope_priority: jobsTable.scope_priority,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
      .leftJoin(
        accountPropertiesTable,
        eq(jobsTable.account_property_id, accountPropertiesTable.id),
      )
      .leftJoin(serviceZonesTable, eq(clientsTable.zone_id, serviceZonesTable.id))
      .leftJoin(
        serviceTypesTable,
        and(
          eq(serviceTypesTable.company_id, companyId),
          eq(serviceTypesTable.slug, jobsTable.service_type),
        ),
      )
      .where(
        and(
          eq(jobsTable.company_id, companyId),
          // [2026-06-17] Was assigned_user_id only — missed helpers/teammates
          // (same fix as /api/jobs/my-jobs). Dispatch reads job_technicians
          // as truth; this read path must match or a tech added via Add Team
          // Member as a non-primary helper sees nothing on /my-day. The
          // privacy rule from the 1B spec ("tech sees only their own day")
          // is preserved — we still anchor on req.auth!.userId.
          or(
            eq(jobsTable.assigned_user_id, userId),
            sql`EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = ${jobsTable.id} AND jt.user_id = ${userId})`,
          ),
          eq(jobsTable.scheduled_date, date),
        ),
      )
      .orderBy(asc(jobsTable.scheduled_time), asc(jobsTable.id));

    // Pull clock entries so a job with clock_in (no clock_out) flips to
    // 'current' even when jobs.status hasn't been updated to in_progress
    // yet. Mirrors the dispatch UI's source-of-truth pattern.
    let clockMap = new Map<number, { clock_in_at: Date | null; clock_out_at: Date | null }>();
    if (rows.length > 0) {
      const jobIds = rows.map((r) => r.id);
      const clockRows = await db
        .select({
          job_id: timeclockTable.job_id,
          clock_in_at: timeclockTable.clock_in_at,
          clock_out_at: timeclockTable.clock_out_at,
        })
        .from(timeclockTable)
        .where(
          and(
            eq(timeclockTable.company_id, companyId),
            eq(timeclockTable.user_id, userId),
            sql`${timeclockTable.job_id} = ANY(${sql.raw(`ARRAY[${jobIds.join(",")}]`)})`,
          ),
        );
      // Prefer the open (no clock_out) entry per job; otherwise the
      // latest closed one. The "current" hint depends on a still-open
      // entry, so we must surface that one when present.
      for (const r of clockRows) {
        const prev = clockMap.get(r.job_id);
        if (!prev || (!r.clock_out_at && prev.clock_out_at)) {
          clockMap.set(r.job_id, {
            clock_in_at: r.clock_in_at ?? null,
            clock_out_at: r.clock_out_at ?? null,
          });
        }
      }
    }

    // Decorate + apply grouping rules per the 1B spec:
    //   done    — status='complete' OR clock_out_at is set
    //   current — clock_in_at is set AND clock_out_at is null
    //              (also accept status='in_progress' as a fallback)
    //   next    — earliest scheduled_time among not-done, not-current
    //   later   — everything else not-done, not-current
    // If there is a current item it is the hero; otherwise the next.
    // The serializer below sorts by scheduled_time and assigns hints
    // in a single pass.
    const decorated = rows.map((r) => {
      const clock = clockMap.get(r.id) ?? { clock_in_at: null, clock_out_at: null };
      const isComplete = r.status === "complete" || !!clock.clock_out_at;
      const isCurrent =
        !isComplete &&
        (!!clock.clock_in_at || r.status === "in_progress");
      return { row: r, clock, isComplete, isCurrent };
    });

    // Find the first not-done, not-current item — that's 'next'. The
    // rows are already sorted by scheduled_time so the first match is
    // the canonical earliest.
    let nextAssigned = false;
    const items = decorated.map((d) => {
      let grouping: GroupingHint;
      if (d.isComplete) {
        grouping = "done";
      } else if (d.isCurrent) {
        grouping = "current";
      } else if (!nextAssigned) {
        grouping = "next";
        nextAssigned = true;
      } else {
        grouping = "later";
      }
      return serializeItem(d.row, d.clock, grouping);
    });

    const doneCount = items.filter((i) => i.grouping === "done").length;
    const remainingCount = items.length - doneCount;

    return res.json({
      data: {
        date,
        summary: {
          total: items.length,
          done: doneCount,
          remaining: remainingCount,
        },
        items,
      },
    });
  } catch (err) {
    console.error("[tech] GET /today error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to load today" });
  }
});

function serializeItem(
  r: any,
  clock: { clock_in_at: Date | null; clock_out_at: Date | null },
  grouping: GroupingHint,
) {
  // Display name: account_name > client_company_name > "First Last".
  // For office_event / meeting kinds we fall back to a generic label
  // since these rows don't carry a client.
  let displayName: string;
  if (r.job_kind === "office_event" || r.job_kind === "meeting") {
    displayName = r.account_name ?? "Office event";
  } else if (r.account_name) {
    displayName = r.property_name
      ? `${r.account_name} — ${r.property_name}`
      : r.account_name;
  } else if (r.client_company_name) {
    displayName = r.client_company_name;
  } else {
    const first = (r.client_first_name ?? "").trim();
    const last = (r.client_last_name ?? "").trim();
    displayName = [first, last].filter(Boolean).join(" ") || "Client";
  }
  return {
    id: r.id,
    grouping,
    display_name: displayName,
    service_type_slug: r.service_type_slug,
    service_type_name: r.service_type_name ?? null,
    job_kind: r.job_kind,
    // Address fields kept separate so the UI can route through
    // formatAddress() — never inline string-concat addresses.
    address_street: r.address_street,
    address_city: r.address_city,
    address_state: r.address_state,
    address_zip: r.address_zip,
    zone_name: r.zone_name ?? null,
    scheduled_date: r.scheduled_date,
    scheduled_time: r.scheduled_time,
    allowed_hours: r.allowed_hours != null ? Number(r.allowed_hours) : null,
    status: r.status,
    frequency: r.frequency,
    flags: {
      scope_first_time_in: !!r.scope_first_time_in,
      special_equipment_needed: !!r.special_equipment_needed,
      out_of_rotation: !!r.out_of_rotation,
      scope_deep_clean: !!r.scope_deep_clean,
      scope_priority: !!r.scope_priority,
    },
    clock_in_at: clock.clock_in_at ? new Date(clock.clock_in_at).toISOString() : null,
    clock_out_at: clock.clock_out_at ? new Date(clock.clock_out_at).toISOString() : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// [tech-scorecard 2026-07-14] GET /api/tech/scorecard
// The tech's OWN scorecard for their My Jobs home: headline score + the rolling
// 90-day composite sub-scores + the full rating history (customer comments,
// positive AND negative — Sal). Self-scoped via resolveViewedUserId.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/scorecard", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) return res.status(400).json({ error: "Bad Request", message: "User has no company assignment" });
    const userId = resolveViewedUserId(req);

    let composite: any = null;
    try { composite = await computeCompositeForEmployee(companyId, userId); }
    catch (e) { console.error("tech scorecard composite failed (non-fatal):", e); }

    const [u] = await db
      .select({
        scorecard_pct: usersTable.scorecard_pct,
        composite_90d: usersTable.scorecard_composite_90d,
        first_name: usersTable.first_name,
        last_name: usersTable.last_name,
      })
      .from(usersTable)
      .where(and(eq(usersTable.id, userId), eq(usersTable.company_id, companyId)))
      .limit(1);

    // Full rating history — non-excluded rows, newest first, all comments.
    const entries = await db
      .select({
        id: scorecardEntriesTable.id,
        entry_date: scorecardEntriesTable.entry_date,
        score_value: scorecardEntriesTable.score_value,
        max_value: scorecardEntriesTable.max_value,
        source: scorecardEntriesTable.source,
        notes: scorecardEntriesTable.notes,
        job_id: scorecardEntriesTable.job_id,
        // [tech-scorecard 2026-07-14] Who left the rating — resolve the client
        // via the entry's job (client, or account name for commercial), falling
        // back to the linked survey's customer. Null for MC-imported rows with
        // no job/survey link.
        client_name: sql<string | null>`COALESCE(
          (SELECT CASE WHEN j.account_id IS NOT NULL THEN a.account_name
                       ELSE NULLIF(btrim(concat(c.first_name, ' ', c.last_name)), '') END
             FROM jobs j
             LEFT JOIN clients c ON c.id = j.client_id
             LEFT JOIN accounts a ON a.id = j.account_id
            WHERE j.id = ${scorecardEntriesTable.job_id}),
          (SELECT NULLIF(btrim(concat(c.first_name, ' ', c.last_name)), '')
             FROM satisfaction_surveys ss
             JOIN clients c ON c.id = ss.customer_id
            WHERE ss.id = ${scorecardEntriesTable.survey_id})
        )`,
      })
      .from(scorecardEntriesTable)
      .where(and(
        eq(scorecardEntriesTable.company_id, companyId),
        eq(scorecardEntriesTable.employee_id, userId),
        eq(scorecardEntriesTable.excluded, false),
      ))
      .orderBy(desc(scorecardEntriesTable.entry_date), desc(scorecardEntriesTable.id))
      .limit(100);

    const headline =
      composite?.composite ??
      (u?.composite_90d != null ? Number(u.composite_90d) : null) ??
      (u?.scorecard_pct != null ? Number(u.scorecard_pct) : null);

    return res.json({
      score_pct: headline,
      composite: composite?.composite ?? null,
      satisfaction: composite?.satisfaction ?? null,
      attendance: composite?.attendance ?? null,
      complaint_free: composite?.complaint_free ?? null,
      window: composite?.window ?? null,
      rating_count: entries.length,
      name: u ? `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() : null,
      entries,
    });
  } catch (err) {
    console.error("tech scorecard error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// [tech-scorecard 2026-07-14] GET /api/tech/job-history?limit=&offset=
// The tech's OWN completed-job history (beyond just today). Matches primary
// (jobs.assigned_user_id) AND team-member (job_technicians) jobs — same OR
// clause the day view uses. Newest first, paged. Self-scoped.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/job-history", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) return res.status(400).json({ error: "Bad Request", message: "User has no company assignment" });
    const userId = resolveViewedUserId(req);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "30"), 10) || 30, 1), 100);
    const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

    const rows = await db
      .select({
        id: jobsTable.id,
        scheduled_date: jobsTable.scheduled_date,
        service_type: jobsTable.service_type,
        base_fee: jobsTable.base_fee,
        client_name: sql<string>`CASE WHEN ${jobsTable.account_id} IS NOT NULL THEN ${accountsTable.account_name} ELSE btrim(concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})) END`,
        rating: sql<number | null>`(SELECT AVG(sc.score)::float FROM scorecards sc WHERE sc.job_id = ${jobsTable.id} AND sc.user_id = ${userId} AND sc.excluded = false)`,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
      .where(and(
        eq(jobsTable.company_id, companyId),
        eq(jobsTable.status, "complete"),
        or(
          eq(jobsTable.assigned_user_id, userId),
          sql`EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = ${jobsTable.id} AND jt.user_id = ${userId})`,
        ),
      ))
      .orderBy(desc(jobsTable.scheduled_date), desc(jobsTable.id))
      .limit(limit + 1)
      .offset(offset);

    const has_more = rows.length > limit;
    return res.json({ jobs: rows.slice(0, limit), has_more });
  } catch (err) {
    console.error("tech job-history error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
