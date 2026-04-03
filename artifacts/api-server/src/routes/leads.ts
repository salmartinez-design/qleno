/**
 * Lead Pipeline API
 * CRUD + activity log + messaging for the Qleno lead pipeline.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

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

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await db.execute(sql.raw(`SELECT COUNT(*) as total FROM leads l ${where}`));
    const total = parseInt((countResult.rows[0] as any).total) || 0;

    const rows = await db.execute(sql.raw(`
      SELECT
        l.*,
        u.first_name as assignee_first_name,
        u.last_name as assignee_last_name
      FROM leads l
      LEFT JOIN users u ON u.id = l.assigned_to
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
      closed_reason, agreement_signed,
    } = req.body;

    const existing = await db.execute(
      sql`SELECT status FROM leads WHERE id = ${leadId} AND company_id = ${companyId} LIMIT 1`
    );
    if (!existing.rows.length) return res.status(404).json({ error: "Not found" });

    const prev = (existing.rows[0] as any).status;

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
        scope      = COALESCE(${scope ?? null}, scope),
        sqft       = COALESCE(${sqft != null ? parseInt(sqft) : null}, sqft),
        bedrooms   = COALESCE(${bedrooms != null ? parseInt(bedrooms) : null}, bedrooms),
        bathrooms  = COALESCE(${bathrooms != null ? parseInt(bathrooms) : null}, bathrooms),
        notes      = COALESCE(${notes ?? null}, notes),
        quote_amount = COALESCE(${quote_amount != null ? parseFloat(quote_amount) : null}, quote_amount),
        quoted_at  = COALESCE(${quoted_at ?? null}, quoted_at),
        contacted_at = COALESCE(${contacted_at ?? null}, contacted_at),
        booked_at  = COALESCE(${booked_at ?? null}, booked_at),
        closed_reason = COALESCE(${closed_reason ?? null}, closed_reason),
        agreement_signed = COALESCE(${agreement_signed ?? null}, agreement_signed),
        updated_at = NOW()
      WHERE id = ${leadId} AND company_id = ${companyId}
    `);

    if (status && status !== prev) {
      await logActivity(leadId, companyId, "status_change", `Status changed from ${prev} to ${status}`, userId);
    }

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
    await db.execute(
      sql`DELETE FROM leads WHERE id = ${leadId} AND company_id = ${companyId}`
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /leads/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
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
// Returns activity log entries of type email_sent or sms_sent for the lead
router.get("/:id/messages", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const leadId = parseInt(req.params.id);

    const rows = await db.execute(sql`
      SELECT a.*, u.first_name as performer_first_name, u.last_name as performer_last_name
      FROM lead_activity_log a
      LEFT JOIN users u ON u.id = a.performed_by
      WHERE a.lead_id = ${leadId}
        AND a.company_id = ${companyId}
        AND a.action_type IN ('email_sent', 'sms_sent')
      ORDER BY a.created_at DESC
      LIMIT 100
    `);
    return res.json(rows.rows);
  } catch (err) {
    console.error("GET /leads/:id/messages:", err);
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

  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    const from       = process.env.TWILIO_FROM_NUMBER;
    const officeNum  = "+17737869902";
    if (accountSid && authToken && from) {
      const smsRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ To: officeNum, From: from, Body: smsBody }).toString(),
        }
      );
      if (!smsRes.ok) console.error("[leads] Twilio SMS failed:", await smsRes.text());
    }
  } catch (err) {
    console.error("[leads] office SMS error:", err);
  }

  try {
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      const { Resend } = await import("resend");
      const resend = new Resend(resendKey);
      await resend.emails.send({
        from: "Qleno <noreply@phes.io>",
        to: ["info@phes.io"],
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
