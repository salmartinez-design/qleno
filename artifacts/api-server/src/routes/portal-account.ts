// [customer-portal 2026-08-06] The COMMERCIAL half of the portal, mounted at
// /api/portal/account. Design: docs/CUSTOMER_PORTAL_DESIGN.md.
//
// Everything here answers for ONE account — the one the signed-in contact is
// attached to. That account id comes from `portal_users.account_contact_id`,
// resolved server-side on every request; it is never read from a query string
// or a body. An endpoint here that accepted an account_id would be a way for
// one property manager to read another's buildings and invoices.
//
// These are deliberately NOT the office endpoints with a different guard. The
// office routes scope by company and trust the caller to be staff; reusing them
// for customers is exactly the mistake that put a portal token on 320 staff
// routes (#1357). Separate routes, narrower queries, capability-gated.
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requirePortalAuth, requireCapability, portalCapabilities } from "../lib/portal-auth.js";
import type { Request, Response, NextFunction } from "express";

const router = Router();

/**
 * Resolve the caller's account from their contact row, once per request.
 *
 * Residential sessions have no account_contact_id and are refused here — their
 * routes live at /api/portal/*. Anything that cannot resolve an account is a
 * 403, never a query that quietly returns everything.
 */
async function requireAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = req.portalSession;
  if (!session?.accountContactId) {
    res.status(403).json({ error: "Forbidden", message: "Not available on this account" });
    return;
  }
  const rows = await db.execute(sql`
    SELECT account_id FROM account_contacts
     WHERE id = ${session.accountContactId} AND company_id = ${session.companyId}
     LIMIT 1`);
  const accountId = (rows.rows[0] as any)?.account_id;
  if (!accountId) {
    // The contact was deleted or moved companies while the session was alive.
    res.status(403).json({ error: "Forbidden", message: "This login is no longer linked to an account" });
    return;
  }
  (req as any).portalAccountId = Number(accountId);
  next();
}

const accountId = (req: Request) => (req as any).portalAccountId as number;
const money = (v: any) => (v == null ? 0 : parseFloat(String(v)));

// ── GET /api/portal/account ─────────────────────────────────────────────────
// Who am I looking at, and what may I do here?
router.get("/", requirePortalAuth, requireAccount, async (req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT a.account_name, a.payment_terms,
             (SELECT COUNT(*)::int FROM account_properties p
               WHERE p.account_id = a.id AND p.is_active = true) AS building_count
        FROM accounts a
       WHERE a.id = ${accountId(req)} AND a.company_id = ${req.portalSession!.companyId}
       LIMIT 1`);
    const a = rows.rows[0] as any;
    if (!a) return res.status(404).json({ error: "Not Found", message: "Account not found" });
    return res.json({
      account_name: a.account_name,
      payment_terms: a.payment_terms,
      building_count: a.building_count ?? 0,
      capabilities: portalCapabilities(req.portalSession!),
      // Drives the "you are viewing as a customer" banner.
      impersonated: req.portalSession!.impersonatedBy != null,
    });
  } catch (err) {
    console.error("Portal account error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not load your account" });
  }
});

// ── GET /api/portal/account/buildings ───────────────────────────────────────
// The properties this account has with us, each with its next and last visit.
router.get("/buildings", requirePortalAuth, requireAccount, requireCapability("viewBuildings"), async (req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT p.id, p.property_name, p.address, p.city, p.state, p.zip, p.unit_count,
             (SELECT MIN(j.scheduled_date) FROM jobs j
               WHERE j.account_property_id = p.id AND j.status = 'scheduled'
                 AND j.scheduled_date >= CURRENT_DATE) AS next_visit,
             (SELECT MAX(j.scheduled_date) FROM jobs j
               WHERE j.account_property_id = p.id AND j.status = 'complete') AS last_visit
        FROM account_properties p
       WHERE p.account_id = ${accountId(req)} AND p.company_id = ${req.portalSession!.companyId}
         AND p.is_active = true
       ORDER BY COALESCE(NULLIF(btrim(p.property_name), ''), p.address)`);
    // Deliberately omits access_notes and internal notes — gate codes and
    // "dog is friendly, owner is not" are OUR operational notes, not the
    // customer's, even though the customer owns the building.
    return res.json((rows.rows as any[]).map((r) => ({
      id: r.id,
      name: (r.property_name && String(r.property_name).trim()) || r.address,
      address: [r.address, [r.city, r.state].filter(Boolean).join(", "), r.zip].filter(Boolean).join(", "),
      unit_count: r.unit_count,
      next_visit: r.next_visit ? String(r.next_visit).slice(0, 10) : null,
      last_visit: r.last_visit ? String(r.last_visit).slice(0, 10) : null,
    })));
  } catch (err) {
    console.error("Portal buildings error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not load your buildings" });
  }
});

// ── GET /api/portal/account/visits?from&to ──────────────────────────────────
// Scheduled and completed work across every building on the account.
router.get("/visits", requirePortalAuth, requireAccount, requireCapability("viewVisits"), async (req, res) => {
  try {
    const ymd = (v: any, fallback: string) =>
      typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback;
    const today = new Date().toISOString().slice(0, 10);
    const from = ymd(req.query.from, new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10));
    const to = ymd(req.query.to, new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10));

    const rows = await db.execute(sql`
      SELECT j.id, j.scheduled_date, j.scheduled_time, j.status, j.service_type,
             COALESCE(NULLIF(btrim(p.property_name), ''), p.address, j.address_street) AS building
        FROM jobs j
        LEFT JOIN account_properties p ON p.id = j.account_property_id
       WHERE j.account_id = ${accountId(req)} AND j.company_id = ${req.portalSession!.companyId}
         AND j.scheduled_date BETWEEN ${from} AND ${to}
       ORDER BY j.scheduled_date DESC, j.scheduled_time`);

    // The customer gets date, building, service and whether it happened. Not the
    // cleaner's name, not the crew size, not what we pay — that's our operation.
    const visits = (rows.rows as any[]).map((r) => ({
      id: r.id,
      date: String(r.scheduled_date).slice(0, 10),
      time: r.scheduled_time ?? null,
      building: r.building ?? null,
      service: String(r.service_type ?? "").replace(/_/g, " "),
      status: r.status,
    }));
    return res.json({
      from, to, today,
      upcoming: visits.filter((v) => v.date >= today && v.status === "scheduled"),
      past: visits.filter((v) => v.date < today || v.status === "complete"),
    });
  } catch (err) {
    console.error("Portal visits error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not load your visits" });
  }
});

// ── GET /api/portal/account/invoices?month=YYYY-MM ──────────────────────────
router.get("/invoices", requirePortalAuth, requireAccount, requireCapability("viewInvoices"), async (req, res) => {
  try {
    const month = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month)
      ? req.query.month
      : new Date().toISOString().slice(0, 7);

    // Mirrors the office account-invoices list: one row per document the
    // customer actually owes. Members of a combined invoice are excluded, or
    // the month total would count the same dollars twice.
    const rows = await db.execute(sql`
      SELECT i.id, i.invoice_number, i.status, i.total, i.due_date, i.paid_at,
             COALESCE(i.service_date,
               (SELECT j.scheduled_date FROM jobs j WHERE j.id = i.job_id)) AS service_date,
             (SELECT COUNT(*)::int FROM invoices m WHERE m.parent_invoice_id = i.id) AS visit_count
        FROM invoices i
       WHERE i.account_id = ${accountId(req)} AND i.company_id = ${req.portalSession!.companyId}
         AND i.status NOT IN ('draft', 'void', 'batched', 'superseded')
         AND to_char(COALESCE(i.service_date,
               (SELECT j.scheduled_date FROM jobs j WHERE j.id = i.job_id),
               i.created_at::date), 'YYYY-MM') = ${month}
       ORDER BY service_date DESC NULLS LAST, i.id DESC`);

    const invoices = (rows.rows as any[]).map((r) => ({
      id: r.id,
      invoice_number: r.invoice_number,
      // 'sent' is our word. The customer reads "Due" or "Paid".
      status: r.paid_at ? "paid"
        : r.due_date && String(r.due_date) < new Date().toISOString().slice(0, 10) ? "overdue"
        : "due",
      total: money(r.total),
      due_date: r.due_date ? String(r.due_date).slice(0, 10) : null,
      service_date: r.service_date ? String(r.service_date).slice(0, 10) : null,
      visit_count: r.visit_count ?? 0,
    }));
    return res.json({
      month,
      invoices,
      total: invoices.reduce((s, i) => s + i.total, 0),
      outstanding: invoices.filter((i) => i.status !== "paid").reduce((s, i) => s + i.total, 0),
    });
  } catch (err) {
    console.error("Portal invoices error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not load your invoices" });
  }
});

// Confirm a set of invoice ids all belong to the caller's account. Returns the
// owned ids; anything not on the account is silently absent rather than
// reported, so this cannot be used to probe which invoice ids exist.
async function ownedInvoiceIds(req: Request, raw: any): Promise<number[]> {
  const ids: number[] = Array.from(new Set<number>(
    (Array.isArray(raw) ? raw : []).map((n: any) => parseInt(String(n))).filter((n: number) => Number.isFinite(n)),
  ));
  if (!ids.length) return [];
  const rows = await db.execute(sql`
    SELECT id FROM invoices
     WHERE company_id = ${req.portalSession!.companyId}
       AND account_id = ${accountId(req)}
       AND id = ANY(${sql.raw(`ARRAY[${ids.join(",")}]::int[]`)})
       AND status NOT IN ('draft', 'void', 'batched', 'superseded')`);
  return (rows.rows as any[]).map((r) => Number(r.id));
}

// ── GET /api/portal/account/invoices/:id/pdf ────────────────────────────────
router.get("/invoices/:id/pdf", requirePortalAuth, requireAccount, requireCapability("downloadInvoicePdf"), async (req, res) => {
  try {
    const [id] = await ownedInvoiceIds(req, [req.params.id]);
    if (!id) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });
    const { buildInvoicePdfBuffer } = await import("./invoices.js");
    const out = await buildInvoicePdfBuffer(req.portalSession!.companyId, id);
    if (!out) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${out.filename}"`);
    return res.end(out.buffer);
  } catch (err) {
    console.error("Portal invoice PDF error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not build that invoice" });
  }
});

// ── POST /api/portal/account/invoices/bulk-pdf ──────────────────────────────
// The customer-facing half of what shipped for the office in #1359: select a
// month's invoices, get one zip with each as its own PDF. Same renderer, same
// zip writer — scoped to this account instead of the whole tenant.
router.post("/invoices/bulk-pdf", requirePortalAuth, requireAccount, requireCapability("bulkDownloadInvoices"), async (req, res) => {
  try {
    const ids = await ownedInvoiceIds(req, req.body?.invoice_ids);
    if (!ids.length) return res.status(400).json({ error: "Bad Request", message: "Select at least one invoice" });
    if (ids.length > 200) return res.status(400).json({ error: "Bad Request", message: "Select 200 invoices or fewer" });

    const { buildInvoicePdfBuffer } = await import("./invoices.js");
    const { buildZip } = await import("../lib/zip.js");
    const entries: { name: string; content: Buffer }[] = [];
    for (const id of ids) {
      try {
        const out = await buildInvoicePdfBuffer(req.portalSession!.companyId, id);
        if (out) entries.push({ name: out.filename, content: out.buffer });
      } catch (e) {
        console.error(`[portal bulk-pdf] invoice ${id} failed:`, (e as any)?.message);
      }
    }
    if (!entries.length) {
      return res.status(500).json({ error: "Internal Server Error", message: "Those invoices could not be prepared" });
    }
    const zip = buildZip(entries);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Length", String(zip.length));
    res.setHeader("Content-Disposition", `attachment; filename="invoices-${new Date().toISOString().slice(0, 10)}.zip"`);
    return res.end(zip);
  } catch (err) {
    console.error("Portal bulk PDF error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not build the download" });
  }
});

export default router;
