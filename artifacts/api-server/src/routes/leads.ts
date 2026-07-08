/**
 * Lead Pipeline API
 * CRUD + activity log + messaging for the Qleno lead pipeline.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { enrollForLeadDrip, stopEnrollmentsForLead, sendSingleEnrollmentTouch } from "../services/followUpService.js";

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
      id,
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, parseInt(limit) || 25);
    const offset = (pageNum - 1) * limitNum;

    const conditions: string[] = [`l.company_id = ${companyId}`];

    // [quote-details-carry 2026-07-07] Fetch one specific lead — powers the
    // /leads?lead=<id> deep link from the office lead-alert email when the
    // lead isn't on the loaded page.
    if (id && Number.isInteger(parseInt(id))) {
      conditions.push(`l.id = ${parseInt(id)}`);
    }

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
        rp.name as referral_partner_name,
        (SELECT q.total_price FROM quotes q WHERE q.lead_id = l.id ORDER BY q.created_at DESC LIMIT 1) as linked_quote_price,
        (SELECT q.id FROM quotes q WHERE q.lead_id = l.id ORDER BY q.created_at DESC LIMIT 1) as linked_quote_id,
        (SELECT q.status FROM quotes q WHERE q.lead_id = l.id ORDER BY q.created_at DESC LIMIT 1) as linked_quote_status,
        drip.current_step as drip_step,
        drip.total_steps as drip_total_steps,
        drip.next_fire_at as drip_next_fire_at,
        (SELECT MAX(ml.sent_at) FROM message_log ml
          JOIN follow_up_enrollments fe2 ON fe2.id = ml.enrollment_id
         WHERE fe2.lead_id = l.id AND ml.status = 'sent') as last_drip_touch_at
      FROM leads l
      LEFT JOIN users u ON u.id = l.assigned_to
      LEFT JOIN referral_partners rp ON rp.id = l.referral_partner_id
      LEFT JOIN LATERAL (
        SELECT fe.current_step,
               fe.next_fire_at,
               (SELECT COUNT(*) FROM follow_up_steps fst WHERE fst.sequence_id = fe.sequence_id) as total_steps
        FROM follow_up_enrollments fe
        JOIN follow_up_sequences fs ON fs.id = fe.sequence_id
        WHERE fe.lead_id = l.id
          AND fs.sequence_type IN ('lead_drip_web','lead_drip_phone')
          AND fe.completed_at IS NULL AND fe.stopped_at IS NULL
        ORDER BY fe.id DESC LIMIT 1
      ) drip ON TRUE
      ${where}
      ORDER BY l.replied_at DESC NULLS LAST, l.created_at DESC
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
router.get("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res, next) => {
  try {
    // Non-numeric ids (e.g. "reports") are sibling routes registered later —
    // fall through so GET /leads/reports isn't swallowed here (the "No data" bug).
    if (!/^\d+$/.test(String(req.params.id))) return next();
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
      lead_source,
      scope, sqft, bedrooms, bathrooms, notes,
      quote_amount, assigned_to,
    } = req.body;

    if (!first_name) return res.status(400).json({ error: "first_name required" });

    // Resolve lead_source: explicit > infer from source > default 'manual'.
    const resolvedLeadSource = lead_source || (source === "website" || source === "booking_widget" ? "web_quote" : "manual");

    // Auto-assign phone-in leads to the creating user (the rep on the call).
    const resolvedAssignedTo = assigned_to
      ? parseInt(assigned_to)
      : resolvedLeadSource === "phone_in" ? userId
      : null;

    const result = await db.execute(sql`
      INSERT INTO leads (
        company_id, first_name, last_name, email, phone,
        address, city, state, zip, source, status, lead_source,
        scope, sqft, bedrooms, bathrooms, notes,
        quote_amount, assigned_to, created_at, updated_at
      ) VALUES (
        ${companyId}, ${first_name}, ${last_name || null}, ${email || null}, ${phone || null},
        ${address || null}, ${city || null}, ${state || null}, ${zip || null},
        ${source}, ${status}, ${resolvedLeadSource},
        ${scope || null}, ${sqft ? parseInt(sqft) : null},
        ${bedrooms ? parseInt(bedrooms) : null}, ${bathrooms ? parseInt(bathrooms) : null},
        ${notes || null}, ${quote_amount ? parseFloat(quote_amount) : null},
        ${resolvedAssignedTo},
        NOW(), NOW()
      ) RETURNING id
    `);
    const leadId = (result.rows[0] as any).id;

    await logActivity(leadId, companyId, "status_change", `Lead created with status: ${status}`, userId);
    await logAudit(req, "lead.create", "lead", leadId, null, { first_name, last_name, email, phone, source, lead_source: resolvedLeadSource, status });

    fireOfficeNotification(companyId, leadId, first_name, last_name, source, phone, scope).catch(() => {});

    // Enroll in the lead drip ONLY for top-of-funnel leads (new / needs contact).
    // A lead created already contacted/quoted/booked (e.g. office logs a won job)
    // must NOT start a nurture drip — that's the "booked leads at step 1" bug.
    // (Option A: stage tracks manual status; the drip runs on its own schedule for
    // un-worked leads, so needs_contacted still enrolls.)
    if (!status || status === "new" || status === "needs_contacted") {
      enrollForLeadDrip(companyId, leadId, resolvedLeadSource).catch(() => {});
    }

    return res.status(201).json({ id: leadId, lead_source: resolvedLeadSource, assigned_to: resolvedAssignedTo });
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
      // Stop lead drip when the lead books — they're now a client.
      if (status === "booked") {
        stopEnrollmentsForLead(leadId, "lead_booked").catch(() => {});
      }
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
// [office-admin-parity 2026-06-26] Office tier may delete leads (Sal granted this).
router.delete("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
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
router.post("/bulk-delete", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
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
      // A logged call IS contact: stamp it, clear the un-answered-reply badge,
      // and move a Needs Contact card to Contacted so the board keeps itself
      // honest (Sal 2026-07-08: cards must move on real events, not memory).
      await db.execute(
        sql`UPDATE leads SET contacted_at = NOW(), contacted_by = ${userId}, replied_at = NULL,
              status = CASE WHEN status IN ('new','needs_contacted') THEN 'contacted' ELSE status END,
              updated_at = NOW()
            WHERE id = ${leadId} AND company_id = ${companyId}`
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /leads/:id/activity:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/leads/:id/messages ───────────────────────────────────────────────
// Union of direct SMS thread + drip message_log, chronological.
router.get("/:id/messages", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const leadId = parseInt(req.params.id);
    const rows = await db.execute(sql`
      SELECT id, direction, body, NULL AS channel, status, created_at, NULL AS step_number
        FROM sms_messages
       WHERE company_id = ${companyId} AND lead_id = ${leadId}
      UNION ALL
      SELECT ml.id, 'outbound' AS direction, ml.body, fs.channel, ml.status, ml.sent_at AS created_at,
             fst.step_number
        FROM message_log ml
        JOIN follow_up_enrollments fe ON fe.id = ml.enrollment_id
        JOIN follow_up_steps fst ON fst.id = ml.step_id
        JOIN follow_up_sequences fs ON fs.id = fe.sequence_id
       WHERE fe.company_id = ${companyId} AND fe.lead_id = ${leadId}
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
    // A manual text is contact made AND answers any outstanding reply: clear
    // the badge and advance a Needs Contact card to Contacted.
    await db.execute(
      sql`UPDATE leads SET contacted_at = COALESCE(contacted_at, NOW()), replied_at = NULL,
            status = CASE WHEN status IN ('new','needs_contacted') THEN 'contacted' ELSE status END,
            updated_at = NOW()
          WHERE id = ${leadId} AND company_id = ${companyId}`
    ).catch(() => {});
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

// ── GET /api/leads/reports ─────────────────────────────────────────────────────
router.get("/reports", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { from, to } = req.query as Record<string, string>;
    const fromClause = from ? `AND l.created_at >= '${from}'::date` : "";
    const toClause = to ? `AND l.created_at < ('${to}'::date + interval '1 day')` : "";

    const [totals, bySource, byOwner, touchConv, dripSummary] = await Promise.all([
      db.execute(sql.raw(`
        SELECT
          COUNT(*) FILTER (WHERE TRUE) AS total,
          COUNT(*) FILTER (WHERE status = 'booked') AS booked,
          COUNT(*) FILTER (WHERE status IN ('no_response','not_interested','closed')) AS lost,
          COUNT(*) FILTER (WHERE status NOT IN ('booked','no_response','not_interested','closed')) AS active,
          COUNT(*) FILTER (WHERE status IN ('new','needs_contacted')) AS needs_contact,
          COUNT(*) FILTER (WHERE status = 'contacted') AS contacted,
          COUNT(*) FILTER (WHERE status = 'quoted') AS quoted
        FROM leads l WHERE company_id = ${companyId} ${fromClause} ${toClause}
      `)),
      db.execute(sql.raw(`
        SELECT
          -- Show the real intake channel (source: quote / very_dirty /
          -- booking_widget / widget / manual). lead_source is NOT NULL with a
          -- 'manual' default that's never overridden, so reading it first made
          -- every lead read as "manual" — fall back to it only when source is
          -- null.
          COALESCE(NULLIF(source, ''), lead_source, 'manual') AS source_label,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'booked') AS booked,
          ROUND(COUNT(*) FILTER (WHERE status = 'booked') * 100.0 / NULLIF(COUNT(*),0), 1) AS close_rate
        FROM leads l WHERE company_id = ${companyId} ${fromClause} ${toClause}
        GROUP BY 1 ORDER BY total DESC
      `)),
      db.execute(sql.raw(`
        SELECT
          u.first_name || ' ' || COALESCE(u.last_name,'') AS owner_name,
          COUNT(l.id) AS total,
          COUNT(l.id) FILTER (WHERE l.status = 'booked') AS booked,
          ROUND(COUNT(l.id) FILTER (WHERE l.status = 'booked') * 100.0 / NULLIF(COUNT(l.id),0), 1) AS close_rate
        FROM leads l
        LEFT JOIN users u ON u.id = l.assigned_to
        WHERE l.company_id = ${companyId} ${fromClause} ${toClause}
        GROUP BY 1 ORDER BY booked DESC
      `)),
      db.execute(sql.raw(`
        SELECT
          fs.sequence_type,
          fs.name AS sequence_name,
          fst.step_number,
          fst.channel,
          COUNT(ml.id) AS sent,
          COUNT(fe.id) FILTER (WHERE fe.completed_at IS NOT NULL OR fe.stopped_reason = 'lead_booked') AS converted
        FROM follow_up_enrollments fe
        JOIN follow_up_sequences fs ON fs.id = fe.sequence_id
        JOIN follow_up_steps fst ON fst.sequence_id = fe.sequence_id
        LEFT JOIN message_log ml ON ml.enrollment_id = fe.id AND ml.step_number = fst.step_number
        WHERE fe.company_id = ${companyId}
          AND fs.sequence_type IN ('lead_drip_web','lead_drip_phone')
          ${from ? `AND fe.enrolled_at >= '${from}'::date` : ""}
          ${to ? `AND fe.enrolled_at < ('${to}'::date + interval '1 day')` : ""}
        GROUP BY fs.sequence_type, fs.name, fst.step_number, fst.channel
        ORDER BY fs.sequence_type, fst.step_number
      `)),
      // Per-sequence enrollment health across ALL sequences (not just lead
      // drips): who's in it right now, who finished, and why people left.
      db.execute(sql.raw(`
        SELECT
          fs.id AS sequence_id,
          fs.name AS sequence_name,
          fs.sequence_type,
          fs.is_active,
          COUNT(fe.id) FILTER (WHERE fe.completed_at IS NULL AND fe.stopped_at IS NULL) AS in_progress,
          COUNT(fe.id) FILTER (WHERE fe.completed_at IS NOT NULL) AS completed,
          COUNT(fe.id) FILTER (WHERE fe.stopped_reason IN ('replied','lead_replied')) AS stopped_replied,
          COUNT(fe.id) FILTER (WHERE fe.stopped_reason IN ('lead_booked','booked','quote_accepted')) AS stopped_booked,
          COUNT(fe.id) FILTER (WHERE fe.stopped_at IS NOT NULL
            AND fe.stopped_reason NOT IN ('replied','lead_replied','lead_booked','booked','quote_accepted')) AS stopped_other
        FROM follow_up_sequences fs
        LEFT JOIN follow_up_enrollments fe ON fe.sequence_id = fs.id
          ${from ? `AND fe.enrolled_at >= '${from}'::date` : ""}
          ${to ? `AND fe.enrolled_at < ('${to}'::date + interval '1 day')` : ""}
        WHERE fs.company_id = ${companyId}
        GROUP BY fs.id, fs.name, fs.sequence_type, fs.is_active
        ORDER BY fs.id
      `)),
    ]);

    return res.json({
      totals: totals.rows[0],
      bySource: bySource.rows,
      byOwner: byOwner.rows,
      touchConversion: touchConv.rows,
      dripSummary: dripSummary.rows,
    });
  } catch (err) {
    console.error("GET /leads/reports:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/leads/:id/drip ────────────────────────────────────────────────────
router.get("/:id/drip", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const leadId = parseInt(req.params.id);

    const enrollment = await db.execute(sql`
      SELECT fe.id, fe.sequence_id, fe.current_step, fe.enrolled_at, fe.next_fire_at,
             fe.completed_at, fe.stopped_at, fe.stopped_reason, fe.paused_at,
             fs.name AS sequence_name, fs.sequence_type
      FROM follow_up_enrollments fe
      JOIN follow_up_sequences fs ON fs.id = fe.sequence_id
      WHERE fe.lead_id = ${leadId} AND fe.company_id = ${companyId}
        AND fe.completed_at IS NULL AND fe.stopped_at IS NULL
      ORDER BY fe.enrolled_at DESC LIMIT 1
    `);

    if (!enrollment.rows.length) {
      return res.json({ enrollment: null, steps: [] });
    }

    const enr = enrollment.rows[0] as any;
    const steps = await db.execute(sql`
      SELECT fst.id, fst.step_number, fst.delay_hours, fst.channel, fst.subject, fst.message_template,
             ml.id AS log_id, ml.sent_at, ml.status AS send_status
      FROM follow_up_steps fst
      LEFT JOIN message_log ml ON ml.enrollment_id = ${enr.id} AND ml.step_number = fst.step_number
      WHERE fst.sequence_id = ${enr.sequence_id}
      ORDER BY fst.step_number ASC
    `);

    return res.json({ enrollment: enr, steps: steps.rows });
  } catch (err) {
    console.error("GET /leads/:id/drip:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/leads/:id/drip/send-now ─────────────────────────────────────────
router.post("/:id/drip/send-now", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const leadId = parseInt(req.params.id);

    const enrRows = await db.execute(sql`
      SELECT fe.id FROM follow_up_enrollments fe
      WHERE fe.lead_id = ${leadId} AND fe.company_id = ${companyId}
        AND fe.completed_at IS NULL AND fe.stopped_at IS NULL
      ORDER BY fe.enrolled_at DESC LIMIT 1
    `);
    if (!enrRows.rows.length) return res.status(404).json({ error: "No active enrollment" });

    const enrollmentId = (enrRows.rows[0] as any).id;
    const result = await sendSingleEnrollmentTouch(companyId, enrollmentId);
    return res.json(result ?? { ok: true });
  } catch (err) {
    console.error("POST /leads/:id/drip/send-now:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/leads/:id/drip/skip ─────────────────────────────────────────────
router.post("/:id/drip/skip", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const leadId = parseInt(req.params.id);

    const enrRows = await db.execute(sql`
      SELECT fe.id, fe.current_step, fe.sequence_id FROM follow_up_enrollments fe
      WHERE fe.lead_id = ${leadId} AND fe.company_id = ${companyId}
        AND fe.completed_at IS NULL AND fe.stopped_at IS NULL
      ORDER BY fe.enrolled_at DESC LIMIT 1
    `);
    if (!enrRows.rows.length) return res.status(404).json({ error: "No active enrollment" });

    const enr = enrRows.rows[0] as any;
    const nextStep = enr.current_step + 1;

    const nextStepRows = await db.execute(sql`
      SELECT delay_hours FROM follow_up_steps
      WHERE sequence_id = ${enr.sequence_id} AND step_number = ${nextStep}
      LIMIT 1
    `);

    if (!nextStepRows.rows.length) {
      await db.execute(sql`
        UPDATE follow_up_enrollments SET completed_at = NOW() WHERE id = ${enr.id}
      `);
      return res.json({ ok: true, completed: true });
    }

    const delayHours = (nextStepRows.rows[0] as any).delay_hours as number;
    await db.execute(sql`
      UPDATE follow_up_enrollments
      SET current_step = ${nextStep},
          next_fire_at = NOW() + (${delayHours} * interval '1 hour')
      WHERE id = ${enr.id}
    `);

    return res.json({ ok: true, next_step: nextStep });
  } catch (err) {
    console.error("POST /leads/:id/drip/skip:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── PATCH /api/leads/:id/drip/pause ───────────────────────────────────────────
router.patch("/:id/drip/pause", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const leadId = parseInt(req.params.id);

    await db.execute(sql`
      UPDATE follow_up_enrollments
      SET paused_at = CASE WHEN paused_at IS NULL THEN NOW() ELSE NULL END
      WHERE lead_id = ${leadId} AND company_id = ${companyId}
        AND completed_at IS NULL AND stopped_at IS NULL
    `);

    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /leads/:id/drip/pause:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── PATCH /api/leads/:id/drip/stop ────────────────────────────────────────────
router.patch("/:id/drip/stop", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const leadId = parseInt(req.params.id);
    await stopEnrollmentsForLead(leadId, (req.body as any)?.reason || "office_stopped");
    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /leads/:id/drip/stop:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/leads/:id/ack-reply ─────────────────────────────────────────────
// Clears the un-answered-reply badge (leads.replied_at). Fired when the office
// opens the lead's detail panel — seeing the reply counts as acknowledging it.
router.post("/:id/ack-reply", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const leadId = parseInt(req.params.id);
    await db.execute(
      sql`UPDATE leads SET replied_at = NULL, updated_at = NOW()
          WHERE id = ${leadId} AND company_id = ${companyId} AND replied_at IS NOT NULL`
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /leads/:id/ack-reply:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/leads/:id/drip/enroll ──────────────────────────────────────────
router.post("/:id/drip/enroll", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const leadId = parseInt(req.params.id);
    const { sequence_type } = req.body as { sequence_type?: string };
    if (!sequence_type) return res.status(400).json({ error: "sequence_type required" });
    await enrollForLeadDrip(companyId, leadId, sequence_type === "lead_drip_web" ? "web_quote" : "phone_in");
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /leads/:id/drip/enroll:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
