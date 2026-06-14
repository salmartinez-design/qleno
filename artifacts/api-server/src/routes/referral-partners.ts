/**
 * Referral Partners API
 * First-class referral partners per tenant (realtors, property managers,
 * past clients, chambers, etc.). Leads attribute via leads.referral_partner_id.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

const TYPES = new Set(["realtor", "property_mgr", "past_client", "chamber", "other"]);

// ── GET /api/referral-partners ──────────────────────────────────────────────────
// Returns partners with attributed-lead + booked counts for the management UI.
router.get("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const includeInactive = String(req.query.include_inactive ?? "") === "1";
    const rows = await db.execute(sql`
      SELECT p.*,
        c.first_name AS client_first_name, c.last_name AS client_last_name,
        COUNT(l.id) AS lead_count,
        COUNT(l.id) FILTER (WHERE l.status = 'booked') AS booked_count,
        COALESCE(SUM(l.quote_amount) FILTER (WHERE l.status = 'booked'), 0) AS booked_value
      FROM referral_partners p
      LEFT JOIN clients c ON c.id = p.client_id
      LEFT JOIN leads l ON l.referral_partner_id = p.id AND l.company_id = p.company_id
      WHERE p.company_id = ${companyId}
        ${includeInactive ? sql`` : sql`AND p.is_active = true`}
      GROUP BY p.id, c.first_name, c.last_name
      ORDER BY p.is_active DESC, p.name ASC
    `);
    return res.json(rows.rows);
  } catch (err) {
    console.error("GET /referral-partners:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/referral-partners ─────────────────────────────────────────────────
router.post("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { name, type = "other", contact_name, contact_email, contact_phone, client_id, notes } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name required" });
    const safeType = TYPES.has(type) ? type : "other";
    const result = await db.execute(sql`
      INSERT INTO referral_partners
        (company_id, name, type, contact_name, contact_email, contact_phone, client_id, notes, is_active, created_at)
      VALUES (${companyId}, ${String(name).trim()}, ${safeType},
              ${contact_name || null}, ${contact_email || null}, ${contact_phone || null},
              ${client_id ? parseInt(client_id) : null}, ${notes || null}, true, NOW())
      RETURNING id`);
    return res.status(201).json({ id: (result.rows[0] as any).id });
  } catch (err) {
    console.error("POST /referral-partners:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── PATCH /api/referral-partners/:id ────────────────────────────────────────────
router.patch("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(req.params.id);
    const { name, type, contact_name, contact_email, contact_phone, client_id, notes, is_active } = req.body;
    const safeType = type !== undefined ? (TYPES.has(type) ? type : "other") : null;
    const result = await db.execute(sql`
      UPDATE referral_partners SET
        name          = COALESCE(${name ?? null}, name),
        type          = COALESCE(${safeType}, type),
        contact_name  = ${contact_name !== undefined ? (contact_name || null) : sql`contact_name`},
        contact_email = ${contact_email !== undefined ? (contact_email || null) : sql`contact_email`},
        contact_phone = ${contact_phone !== undefined ? (contact_phone || null) : sql`contact_phone`},
        client_id     = ${client_id !== undefined ? (client_id ? parseInt(client_id) : null) : sql`client_id`},
        notes         = ${notes !== undefined ? (notes || null) : sql`notes`},
        is_active     = COALESCE(${is_active ?? null}, is_active)
      WHERE id = ${id} AND company_id = ${companyId}
      RETURNING id`);
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /referral-partners/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── DELETE /api/referral-partners/:id ───────────────────────────────────────────
// Soft-delete (deactivate) so attributed leads keep their link.
router.delete("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(req.params.id);
    await db.execute(sql`UPDATE referral_partners SET is_active = false WHERE id = ${id} AND company_id = ${companyId}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /referral-partners/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
