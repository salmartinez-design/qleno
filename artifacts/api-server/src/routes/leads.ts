/**
 * Lead Pipeline API
 * CRUD + activity log + messaging for the Qleno lead pipeline.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";

const router = Router();

// ── helpers ───────────────────────────────────────────────────────────────────

async function logActivity(
  leadId: number,
  companyId: number,
  actionType: string,
  note: string | null,
  performedBy: number | null
) {
  await db.execute(
    sql`INSERT INTO lead_activity_log (lead_id, company_id, action_type, note, performed_by, created_at)
        VALUES (${leadId}, ${companyId}, ${actionType}, ${note}, ${performedBy}, NOW())`
  );
}

// ── GET /api/leads ─────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const {
      status,
      source,
      assigned_to,
      scope,
      search,
      page = "1",
      limit = "25",
      date_from,
      date_to,
      referral_partner,
      location,
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, parseInt(limit) || 25);
    const offset = (pageNum - 1) * limitNum;

    const conditions: string[] = [`l.company_id = ${companyId}`];

    if (status) {
      const statuses = status.split(",").map(s => `'${s.replace(/'/g, "''")}'`).join(",");
      conditions.push(`l.status IN (${statuses})`);
    }
    if (source) {
      const sources = source.split(",").map(s => `'${s.replace(/'/g, "''")}'`).join(",");
      conditions.push(`l.source IN (${sources})`);
    }
    if (assigned_to) {
      if (assigned_to === "unassigned") {
        conditions.push(`l.assigned_to IS NULL`);
      } else {
        conditions.push(`l.assigned_to = ${parseInt(assigned_to)}`);
      }
    }
    if (scope) {
      const scopes = scope.split(",").map(s => `'${s.replace(/'/g, "''")}'`).join(",");
      conditions.push(`l.scope IN (${scopes})`);
    }
    if (search) {
      const q = search.replace(/'/g, "''");
      conditions.push(`(l.first_name ILIKE '%${q}%' OR l.last_name ILIKE '%${q}%' OR l.email ILIKE '%${q}%' OR l.phone ILIKE '%${q}%' OR l.address ILIKE '%${q}%' OR l.zip ILIKE '%${q}%')`);
    }
    if (date_from) conditions.push(`l.created_at >= '${date_from}'::date`);
    if (date_to) conditions.push(`l.created_at < ('${date_to}'::date + interval '1 day')`);
    if (referral_partner) {
      if (referral_partner === "none") {
        conditions.push(`l.referral_partner_id IS NULL`);
      } else {
        conditions.push(`l.referral_partner_id = ${parseInt(referral_partner)}`);
      }
    }
    if (location) {
      const loc = location.replace(/'/g, "''");
      conditions.push(`(l.city ILIKE '%${loc}%' OR l.zip ILIKE '%${loc}%' OR l.address ILIKE '%${loc}%')`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await db.execute(sql.raw(`SELECT COUNT(*) as total FROM leads l ${where}`));
    const total = parseInt((countResult.rows[0] as any).total) || 0;

    const rows = await db.execute(sql.raw(`
      SELECT
        l.*,
        u.first_name as assignee_first_name,
        u.last_name as assignee_last_name,
        rp.name as referral_partner_name
      FROM leads l
      LEFT JOIN users u ON u.id = l.assigned_to
      LEFT JOIN referral_partners rp ON rp.id = l.referral_partner_id
      ${where}
      ORDER BY l.created_at DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `));

    return res.json({ leads: rows.rows, total, page: pageNum, limit: limitNum });
  } catch (err) {
    console.error("GET /leads:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/leads/status-counts ───────────────────────────────────────────────
router.get("/status-counts", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const rows = await db.execute(
      sql`SELECT status, COUNT(*) as count FROM leads WHERE company_id = ${companyId} GROUP BY status`
    );
    const counts: Record<string, number> = {};
    for (const row of rows.rows as any[]) {
      counts[row.status] = parseInt(row.count);
    }
    return res.json(counts);
  } catch (err) {
    console.error("GET /leads/status-counts:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/leads/backfill-from-quotes ───────────────────────────────────────
// Create-or-link a lead for every quote that has no lead_id yet, and set the
// lead's stage from the quote status (booked→booked, sent/viewed→quoted,
// else needs_contacted). Idempotent; safe to re-run.
router.post("/backfill-from-quotes", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { upsertLeadForQuote, advanceLeadStage } = await import("../lib/lead-sync.js");
    const quotes = await db.execute(sql`
      SELECT id, lead_id, lead_name, lead_email, lead_phone, address,
             status, total_price, base_price, booked_job_id
        FROM quotes WHERE company_id = ${companyId} AND lead_id IS NULL`);
    let created = 0;
    for (const q of quotes.rows as any[]) {
      const leadId = await upsertLeadForQuote(companyId, q);
      if (!leadId) continue;
      created++;
      const amt = q.total_price ?? q.base_price ?? null;
      if (q.status === "booked" || q.booked_job_id) await advanceLeadStage(companyId, leadId, "booked", { jobId: q.booked_job_id ?? undefined, quoteAmount: amt });
      else if (q.status === "sent" || q.status === "viewed") await advanceLeadStage(companyId, leadId, "quoted", { quoteAmount: amt });
    }
    return res.json({ ok: true, quotes_processed: (quotes.rows as any[]).length, leads_linked: created });
  } catch (err) {
    console.error("[leads] backfill-from-quotes", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Backfill failed" });
  }
});

// ── GET /api/leads/:id ─────────────────────────────────────────────────────────
router.get("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(req.params.id);
    const rows = await db.execute(sql`
      SELECT l.*,
        u.first_name as assignee_first_name, u.last_name as assignee_last_name
      FROM leads l
      LEFT JOIN users u ON u.id = l.assigned_to
      WHERE l.id = ${id} AND l.company_id = ${companyId}
      LIMIT 1
    `);
    if (!rows.rows.length) return res.status(404).json({ error: "Not found" });
    return res.json(rows.rows[0]);
  } catch (err) {
    console.error("GET /leads/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/leads ────────────────────────────────────────────────────────────
router.post("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!; const userId = req.auth!.userId;
    const {
      first_name, last_name, email, phone,
      address, city, state, zip,
      source = "manual", status = "needs_contacted",
      scope, sqft, bedrooms, bathrooms, notes,
      quote_amount, assigned_to,
    } = req.body;

    if (!first_name) return res.status(400).json({ error: "first_name required" });

    const result = await db.execute(sql`
      INSERT INTO leads (
        company_id, first_name, last_name, email, phone,
        address, city, state, zip, source, status,
        scope, sqft, bedrooms, bathrooms, notes,
        quote_amount, assigned_to, created_at, updated_at
      ) VALUES (
        ${companyId}, ${first_name}, ${last_name || null}, ${email || null}, ${phone || null},
        ${address || null}, ${city || null}, ${state || null}, ${zip || null},
        ${source}, ${status},
        ${scope || null}, ${sqft ? parseInt(sqft) : null},
        ${bedrooms ? parseInt(bedrooms) : null}, ${bathrooms ? parseInt(bathrooms) : null},
        ${notes || null}, ${quote_amount ? parseFloat(quote_amount) : null},
        ${assigned_to ? parseInt(assigned_to) : null},
        NOW(), NOW()
      ) RETURNING id
    `);
    const leadId = (result.rows[0] as any).id;

    await logActivity(leadId, companyId, "status_change", `Lead created with status: ${status}`, userId);
    await logAudit(req, "lead.create", "lead", leadId, null, { first_name, last_name, email, phone, source, status });

    fireOfficeNotification(companyId, leadId, first_name, last_name, source, phone, scope).catch(() => {});

    return res.status(201).json({ id: leadId });
  } catch (err) {
    console.error("POST /leads:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── PATCH /api/leads/:id ───────────────────────────────────────────────────────
router.patch("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!; const userId = req.auth!.userId;
    const leadId = parseInt(req.params.id);

    const {
      first_name, last_name, email, phone,
      address, city, state, zip,
      source, status, assigned_to, scope, sqft,
      bedrooms, bathrooms, notes, quote_amount,
      quoted_at, contacted_at, booked_at,
      closed_reason, agreement_signed, referral_partner_id,
    } = req.body;

    const existing = await db.execute(
      sql`SELECT status FROM leads WHERE id = ${leadId} AND company_id = ${companyId} LIMIT 1`
    );
    if (!existing.rows.length) return res.status(404).json({ error: "Not found" });

    const prev = (existing.rows[0] as any).status;
    const stageChanged = status && status !== prev;

    await db.execute(sql`
      UPDATE leads SET
        first_name = COALESCE(${first_name ?? null}, first_name),
        last_name  = COALESCE(${last_name ?? null}, last_name),
        email      = COALESCE(${email ?? null}, email),
        phone      = COALESCE(${phone ?? null}, phone),
        address    = COALESCE(${address ?? null}, address),
        city       = COALESCE(${city ?? null}, city),
        state      = COALESCE(${state ?? null}, state),
        zip        = COALESCE(${zip ?? null}, zip),
        source     = COALESCE(${source ?? null}, source),
        status     = COALESCE(${status ?? null}, status),
        assigned_to = CASE WHEN ${assigned_to !== undefined ? "TRUE" : "FALSE"} = 'TRUE' THEN ${assigned_to !== undefined ? (assigned_to || null) : null} ELSE assigned_to END,
        referral_partner_id = ${referral_partner_id !== undefined ? (referral_partner_id ? parseInt(referral_partner_id) : null) : sql`referral_partner_id`},
        scope      = COALESCE(${scope ?? null}, scope),
        sqft       = COALESCE(${sqft != null ? parseInt(sqft) : null}, sqft),
        bedrooms   = COALESCE(${bedrooms != null ? parseInt(bedrooms) : null}, bedrooms),
        bathrooms  = COALESCE(${bathrooms != null ? parseInt(bathrooms) : null}, bathrooms),
        notes      = COALESCE(${notes ?? null}, notes),
        quote_amount = COALESCE(${quote_amount != null ? parseFloat(quote_amount) : null}, quote_amount),
        quoted_at  = COALESCE(${quoted_at ?? null}, quoted_at${stageChanged && status === "quoted" ? sql`, NOW()` : sql``}),
        contacted_at = COALESCE(${contacted_at ?? null}, contacted_at${stageChanged && status === "contacted" ? sql`, NOW()` : sql``}),
        booked_at  = COALESCE(${booked_at ?? null}, booked_at${stageChanged && status === "booked" ? sql`, NOW()` : sql``}),
        closed_reason = COALESCE(${closed_reason ?? null}, closed_reason),
        agreement_signed = COALESCE(${agreement_signed ?? null}, agreement_signed),
        updated_at = NOW()
      WHERE id = ${leadId} AND company_id = ${companyId}
    `);

    if (stageChanged) {
      await logActivity(leadId, companyId, "status_change", `Status changed from ${prev} to ${status}`, userId);
    }
    await logAudit(req, "lead.update", "lead", leadId,
      stageChanged ? { status: prev } : null,
      stageChanged ? { status } : { fields: Object.keys(req.body || {}) });

    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /leads/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── DELETE /api/leads/:id ──────────────────────────────────────────────────────
router.delete("/:id", requireAuth, requireRole("owner"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const leadId = parseInt(req.params.id);
    // Snapshot before delete so the audit trail keeps who/what was removed.
    const snap = await db.execute(
      sql`SELECT id, first_name, last_name, email, phone, status, source FROM leads WHERE id = ${leadId} AND company_id = ${companyId} LIMIT 1`
    );
    if (!snap.rows.length) return res.status(404).json({ error: "Not found" });
    await db.execute(
      sql`DELETE FROM leads WHERE id = ${leadId} AND company_id = ${companyId}`
    );
    await logAudit(req, "lead.delete", "lead", leadId, snap.rows[0] as Record<string, unknown>, null);
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /leads/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/leads/bulk-delete ────────────────────────────────────────────────
// Owner-only. Two modes:
//   { ids: number[] }   — delete an explicit selection (the bulk-select UI)
//   { generic: true }   — delete placeholder leads: no name (or first_name
//                         'Lead'), no email/phone/address, no quote, still
//                         needs_contacted. Empty strings count as empty.
// Child rows (activity log, follow-up enrollments) are removed and quote/sms
// back-references cleared in the same transaction so nothing orphans. Every
// deleted lead is audited (Sal: "all touches going to audit log").
router.post("/bulk-delete", requireAuth, requireRole("owner"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { ids, generic } = req.body as { ids?: unknown; generic?: boolean };

    // NULL-or-empty checks — these placeholder rows carry '' not NULL.
    const genericWhere = sql`
      (first_name IS NULL OR btrim(first_name) = '' OR lower(btrim(first_name)) = 'lead')
      AND (last_name IS NULL OR btrim(last_name) = '')
      AND (email IS NULL OR btrim(email) = '')
      AND (phone IS NULL OR btrim(phone) = '')
      AND (address IS NULL OR btrim(address) = '')
      AND quote_amount IS NULL
      AND status = 'needs_contacted'`;

    let targets;
    if (generic === true) {
      targets = await db.execute(sql`
        SELECT id, first_name, last_name, email, phone, status, source
        FROM leads WHERE company_id = ${companyId} AND ${genericWhere}`);
    } else {
      const idList = Array.isArray(ids) ? ids.map(Number).filter(n => Number.isInteger(n)) : [];
      if (idList.length === 0) return res.status(400).json({ error: "Provide ids[] or generic:true" });
      // [array-fix 2026-06-15] Build an integer CSV and use ANY(ARRAY[...]) via
      // sql.raw — drizzle's `ANY(${jsArray})` binding silently fails in raw
      // db.execute here (same issue that broke techs-with-status). idList is
      // already integer-filtered so the raw interpolation is injection-safe.
      const idsCsv = idList.join(",");
      targets = await db.execute(sql`
        SELECT id, first_name, last_name, email, phone, status, source
        FROM leads WHERE company_id = ${companyId} AND id = ANY(ARRAY[${sql.raw(idsCsv)}]::int[])`);
    }

    const rows = targets.rows as Array<Record<string, unknown>>;
    if (rows.length === 0) return res.json({ ok: true, deleted: 0 });
    const delIds = rows.map(r => Number(r.id)).filter(n => Number.isInteger(n));
    const delCsv = delIds.join(",");
    const delArr = sql`ANY(ARRAY[${sql.raw(delCsv)}]::int[])`;

    // [delete-fix 2026-06-15] NO shared transaction. leads has no FK
    // dependents, so the delete stands alone — and wrapping best-effort
    // cleanups + the delete in one transaction was the bug: when a cleanup
    // statement errored (e.g. a table/column absent on this DB), Postgres
    // aborted the whole transaction, so the subsequent DELETE FROM leads
    // failed with "current transaction is aborted" → 500. Delete the leads
    // first (the only statement that must succeed), then best-effort cleanup
    // in isolated autocommit statements where one failure can't poison another.
    const del = await db.execute(sql`DELETE FROM leads WHERE company_id = ${companyId} AND id = ${delArr}`);
    const deleted = (del as any).rowCount ?? rows.length;

    try { await db.execute(sql`DELETE FROM lead_activity_log WHERE company_id = ${companyId} AND lead_id = ${delArr}`); } catch { /* best-effort */ }
    try { await db.execute(sql`DELETE FROM follow_up_enrollments WHERE lead_id = ${delArr}`); } catch { /* best-effort */ }
    try { await db.execute(sql`UPDATE quotes SET lead_id = NULL WHERE lead_id = ${delArr}`); } catch { /* best-effort */ }
    try { await db.execute(sql`UPDATE sms_messages SET lead_id = NULL WHERE lead_id = ${delArr}`); } catch { /* best-effort */ }

    await logAudit(req, "lead.bulk_delete", "lead", null, null,
      { mode: generic ? "generic" : "selection", count: rows.length, ids: delIds });
    for (const r of rows) {
      await logAudit(req, "lead.delete", "lead", Number(r.id), r, null);
    }

    return res.json({ ok: true, deleted });
  } catch (err) {
    console.error("POST /leads/bulk-delete:", err);
    // Surface the real reason in `error` so the UI alert is actionable, not
    // a generic "Internal Server Error".
    return res.status(500).json({ error: `Delete failed: ${(err as Error).message}`, message: (err as Error).message });
  }
});

// ── GET /api/leads/:id/activity ───────────────────────────────────────────────
router.get("/:id/activity", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const leadId = parseInt(req.params.id);
    const rows = await db.execute(sql`
      SELECT a.*, u.first_name as performer_first_name, u.last_name as performer_last_name
      FROM lead_activity_log a
      LEFT JOIN users u ON u.id = a.performed_by
      WHERE a.lead_id = ${leadId} AND a.company_id = ${companyId}
      ORDER BY a.created_at DESC
      LIMIT 100
    `);
    return res.json(rows.rows);
  } catch (err) {
    console.error("GET /leads/:id/activity:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/leads/:id/activity ──────────────────────────────────────────────
router.post("/:id/activity", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!; const userId = req.auth!.userId;
    const leadId = parseInt(req.params.id);
    const { action_type = "note_added", note } = req.body;

    await logActivity(leadId, companyId, action_type, note || null, userId);

    if (action_type === "call_logged") {
      await db.execute(
        sql`UPDATE leads SET contacted_at = NOW(), contacted_by = ${userId}, updated_at = NOW() WHERE id = ${leadId} AND company_id = ${companyId}`
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /leads/:id/activity:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/leads/:id/messages ───────────────────────────────────────────────
// The lead's SMS conversation thread (inbound + outbound), chronological.
router.get("/:id/messages", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const leadId = parseInt(req.params.id);
    const rows = await db.execute(sql`
      SELECT id, direction, body, from_number, to_number, status, read_at, created_at
        FROM sms_messages
       WHERE company_id = ${companyId} AND lead_id = ${leadId}
       ORDER BY created_at ASC`);
    return res.json(rows.rows);
  } catch (err) {
    console.error("GET /leads/:id/messages:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/leads/:id/communications/sms — send an SMS to a lead ─────────────
// Per-tenant send via resolveSender; persists outbound into the sms_messages thread.
router.post("/:id/communications/sms", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const leadId = parseInt(req.params.id);
    const { message } = req.body;
    if (!message || typeof message !== "string") return res.status(400).json({ error: "message required" });
    const [lead] = (await db.execute(sql`SELECT phone FROM leads WHERE id = ${leadId} AND company_id = ${companyId} LIMIT 1`)).rows as any[];
    if (!lead?.phone) return res.status(400).json({ error: "Lead has no phone number" });

    let twilioResult: any = null, fromNumber: string | null = null, status = "suppressed";
    try {
      const { resolveSender, sendSmsVia } = await import("../lib/comms-sender.js");
      const sender = await resolveSender(companyId, null);
      fromNumber = sender.from_number;
      if (sender.reason) { console.log("[leads] SMS suppressed:", sender.reason); }
      else { twilioResult = await sendSmsVia(sender, lead.phone, message); status = "sent"; }
    } catch (e: any) { status = "failed"; console.error("[leads] SMS error:", e?.message || e); }

    const { recordOutboundSms } = await import("../lib/sms-store.js");
    const { id } = await recordOutboundSms({
      companyId, toRaw: lead.phone, fromNumber, body: message,
      providerId: twilioResult?.sid ?? null, sentBy: req.auth!.userId, leadId, status,
    });
    return res.status(201).json({ id, direction: "outbound", body: message, status, twilio: twilioResult });
  } catch (err) {
    console.error("POST /leads/:id/communications/sms:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/leads/:id/jobs ───────────────────────────────────────────────────
router.get("/:id/jobs", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const leadId = parseInt(req.params.id);
    const leadRow = await db.execute(
      sql`SELECT job_id, email FROM leads WHERE id = ${leadId} AND company_id = ${companyId} LIMIT 1`
    );
    if (!leadRow.rows.length) return res.status(404).json({ error: "Not found" });

    const { job_id, email } = leadRow.rows[0] as any;

    const rows = await db.execute(sql`
      SELECT j.id, j.service_type, j.status, j.scheduled_date, j.base_fee,
             u.first_name as tech_first_name, u.last_name as tech_last_name
      FROM jobs j
      LEFT JOIN users u ON u.id = j.assigned_employee_id
      WHERE j.company_id = ${companyId}
        AND (
          j.id = ${job_id || 0}
          OR j.client_id IN (
            SELECT id FROM clients WHERE company_id = ${companyId} AND email = ${email || ""}
          )
        )
      ORDER BY j.scheduled_date DESC
      LIMIT 20
    `);
    return res.json(rows.rows);
  } catch (err) {
    console.error("GET /leads/:id/jobs:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Office notification helper ─────────────────────────────────────────────────
export async function fireOfficeNotification(
  companyId: number,
  leadId: number,
  firstName: string,
  lastName: string | null,
  source: string,
  phone: string | null,
  scope: string | null
) {
  if (process.env.COMMS_ENABLED !== "true") {
    console.log("[COMMS BLOCKED] Lead office notification suppressed:", { leadId, firstName, lastName });
    return;
  }
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  const smsBody = `New lead — ${fullName} — ${source}${phone ? ` — ${phone}` : ""}. Log in to review.`;

  // Per-tenant routing. Email goes TO companies.lead_notify_email FROM
  // companies.email_from_address; SMS goes TO companies.lead_notify_phone FROM
  // the tenant's own number via resolveSender. NOTHING is hardcoded to Oak Lawn
  // anymore (the old +17737869902 / info@phes.io / global-env Twilio path is
  // gone), so a Schaumburg lead never alerts the Oak Lawn office.
  const cfgRows = await db.execute(sql`
    SELECT email_from_address, lead_notify_email, lead_notify_phone, email AS company_email
    FROM companies WHERE id = ${companyId} LIMIT 1
  `);
  const cfg: any = cfgRows.rows[0] ?? {};
  const notifyEmail = cfg.lead_notify_email || cfg.company_email || null;
  const notifyPhone = cfg.lead_notify_phone || null;
  const fromAddr = cfg.email_from_address ? `Qleno <${cfg.email_from_address}>` : "Qleno <noreply@phes.io>";

  // Internal office SMS — only when a per-tenant alert number is configured,
  // routed through resolveSender (tenant creds + from-number, full gate ladder).
  if (notifyPhone) {
    try {
      const { resolveSender, sendSmsVia } = await import("../lib/comms-sender.js");
      const sender = await resolveSender(companyId, null);
      if (sender.reason) {
        console.log(`[leads] office SMS suppressed (${sender.reason}) company=${companyId}`);
      } else {
        await sendSmsVia(sender, notifyPhone, smsBody);
      }
    } catch (err) {
      console.error("[leads] office SMS error:", err);
    }
  }

  try {
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey && notifyEmail) {
      const { Resend } = await import("resend");
      const resend = new Resend(resendKey);
      await resend.emails.send({
        from: fromAddr,
        to: [notifyEmail],
        subject: `New Lead: ${fullName}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#F7F6F3;">
<div style="background:#fff;border:1px solid #E5E2DC;border-radius:8px;padding:32px;">
<div style="background:#5B9BD5;padding:14px 20px;border-radius:4px;margin-bottom:20px;">
  <span style="color:#fff;font-size:16px;font-weight:bold;">New Lead — ${fullName}</span>
</div>
<table style="width:100%;font-size:14px;color:#1A1917;border-collapse:collapse;">
  <tr><td style="padding:6px 0;color:#6B6860;width:120px;">Name</td><td style="padding:6px 0;font-weight:600;">${fullName}</td></tr>
  <tr><td style="padding:6px 0;color:#6B6860;">Source</td><td style="padding:6px 0;">${source}</td></tr>
  ${scope ? `<tr><td style="padding:6px 0;color:#6B6860;">Scope</td><td style="padding:6px 0;">${scope}</td></tr>` : ""}
  ${phone ? `<tr><td style="padding:6px 0;color:#6B6860;">Phone</td><td style="padding:6px 0;">${phone}</td></tr>` : ""}
  <tr><td style="padding:6px 0;color:#6B6860;">Lead ID</td><td style="padding:6px 0;">#${leadId}</td></tr>
</table>
<p style="margin:20px 0 0;font-size:13px;color:#6B6860;">Log in to Qleno to review and assign this lead.</p>
</div></div>`,
      });
    }
  } catch (err) {
    console.error("[leads] office email error:", err);
  }
}

export default router;
