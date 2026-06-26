// [invoicing-engine 2026-06-16; weekly-cadence 2026-06-26] Consolidated
// invoicing — Sal's "one invoice per job, then merge them" model. Mounted at
// /api/batch-invoicing. Owner/admin/office.
//
// WHY two steps (per-job draft → merge), not one weekly invoice:
//   Each visit can differ — longer hours some days, a holiday with NO work other
//   days. So every job keeps its OWN locked per-visit invoice (created on
//   completion by ensure-invoice). The merge just sums whatever real visits
//   landed in the billing window. Skipped/holiday days simply have no draft;
//   long days carry their own higher total. Nothing is recomputed at merge time.
//
// How it works:
//   - A consolidated client (clients.billing_terms='batch_invoice') gets a
//     per-visit DRAFT on each completion (batch_status='pending'), NOT sent, NOT
//     charged, NOT pushed to QB — held for merging.
//   - This route lists those pending drafts grouped by client for a billing
//     WINDOW (cadence = 'weekly' Sun–Sat, or 'monthly'), keyed on the JOB's
//     SERVICE DATE (jobs.scheduled_date) — NOT invoice created_at, so the lines
//     and the window track when the work actually happened.
//   - "Consolidate" folds the window's pending visits into the EARLIEST visit's
//     invoice (the parent): the parent carries one line per visit (labeled with
//     the service date), totals the window, is issued 'sent' due-on-receipt
//     (due = today), and is pushed to QB. Every OTHER pending invoice is zeroed
//     and marked 'superseded' with parent_invoice_id → the parent. Only the
//     parent pushes to QB.
//   - Office may EXCLUDE individual visits before merging (exclude_invoice_ids)
//     — excluded drafts are left untouched (kept, just not in the parent).
//   - Idempotent per (client, window): once a superseded child exists for a
//     visit inside the window, that window can't be re-consolidated.
//
// per_visit clients (all residential + most commercial) never reach here: their
// completion invoice is issued 'sent' immediately and is its own document.
import { Router } from "express";
import { db } from "@workspace/db";
import { invoicesTable, clientsTable, jobsTable } from "@workspace/db/schema";
import { eq, and, gte, lte, sql, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { queueSync } from "../services/quickbooks-sync.js";

const router = Router();

type Cadence = "weekly" | "monthly";

// Resolve the billing window [start, end] (inclusive YYYY-MM-DD strings) for a
// cadence + an anchor date. weekly = Sunday..Saturday containing the anchor;
// monthly = first..last day of the anchor's month. All math on UTC calendar
// dates to match how jobs.scheduled_date (a DATE) is stored/compared — no TZ
// drift. Anchor defaults to today.
function resolveWindow(cadence: Cadence, anchorParam?: string): { start: string; end: string; label: string } {
  // Parse anchor as a pure calendar date (UTC midnight) to avoid TZ shifts.
  let anchor: Date;
  if (anchorParam && /^\d{4}-\d{2}-\d{2}$/.test(anchorParam)) {
    anchor = new Date(`${anchorParam}T00:00:00.000Z`);
  } else if (anchorParam && /^\d{4}-\d{2}$/.test(anchorParam)) {
    anchor = new Date(`${anchorParam}-01T00:00:00.000Z`);
  } else {
    const now = new Date();
    anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (cadence === "weekly") {
    const dow = anchor.getUTCDay(); // 0=Sun..6=Sat
    const start = new Date(anchor); start.setUTCDate(anchor.getUTCDate() - dow);
    const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
    return { start: iso(start), end: iso(end), label: `Week of ${iso(start)}` };
  }
  // monthly
  const y = anchor.getUTCFullYear(), m = anchor.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 0));
  return { start: iso(start), end: iso(end), label: `${y}-${String(m + 1).padStart(2, "0")}` };
}

function parseCadence(v: any): Cadence {
  return v === "weekly" ? "weekly" : "monthly";
}

// Friendly service-date label, e.g. "Mon Jun 22". Built from a YYYY-MM-DD string
// as a UTC date so it never shifts a day under the server's local TZ.
function svcDateLabel(ymd: string | null): string {
  if (!ymd) return "";
  const d = new Date(`${String(ymd).slice(0, 10)}T00:00:00.000Z`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// GET /api/batch-invoicing?cadence=weekly&date=YYYY-MM-DD
// Lists consolidated (batch_invoice) clients with pending per-visit drafts whose
// SERVICE DATE falls in the window, grouped by client (visit count + window
// total + each visit's service date).
router.get("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const cadence = parseCadence(req.query.cadence);
    const { start, end, label } = resolveWindow(cadence, (req.query.date || req.query.period) as string | undefined);

    const rows = await db
      .select({
        client_id: invoicesTable.client_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        company_name: clientsTable.company_name,
        client_email: clientsTable.email,
        invoice_id: invoicesTable.id,
        invoice_number: invoicesTable.invoice_number,
        total: invoicesTable.total,
        created_at: invoicesTable.created_at,
        line_items: invoicesTable.line_items,
        job_id: invoicesTable.job_id,
        service_date: jobsTable.scheduled_date,
      })
      .from(invoicesTable)
      .innerJoin(jobsTable, eq(invoicesTable.job_id, jobsTable.id))
      .leftJoin(clientsTable, eq(invoicesTable.client_id, clientsTable.id))
      .where(and(
        eq(invoicesTable.company_id, companyId),
        eq(invoicesTable.status, "draft"),
        eq(invoicesTable.batch_status, "pending"),
        gte(jobsTable.scheduled_date, start),
        lte(jobsTable.scheduled_date, end),
      ))
      .orderBy(invoicesTable.client_id, jobsTable.scheduled_date);

    const byClient = new Map<number, any>();
    for (const r of rows) {
      const cid = r.client_id as number;
      if (!byClient.has(cid)) {
        byClient.set(cid, {
          client_id: cid,
          client_name: (r.company_name && r.company_name.trim()) || r.client_name,
          client_email: r.client_email,
          visit_count: 0,
          window_total: 0,
          visits: [] as any[],
        });
      }
      const g = byClient.get(cid);
      g.visit_count += 1;
      g.window_total = Math.round((g.window_total + parseFloat(r.total || "0")) * 100) / 100;
      g.visits.push({
        invoice_id: r.invoice_id,
        invoice_number: r.invoice_number,
        total: parseFloat(r.total || "0"),
        service_date: r.service_date ? String(r.service_date).slice(0, 10) : null,
        service_label: svcDateLabel(r.service_date ? String(r.service_date) : null),
        job_id: r.job_id,
      });
    }

    return res.json({ cadence, period_start: start, period_end: end, label, clients: Array.from(byClient.values()) });
  } catch (err) {
    console.error("Consolidated invoicing list error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to list consolidated invoices" });
  }
});

// POST /api/batch-invoicing/:clientId/consolidate
// Body: { cadence?: 'weekly'|'monthly', date?: 'YYYY-MM-DD', exclude_invoice_ids?: number[] }
router.post("/:clientId/consolidate", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const clientId = parseInt(String(req.params.clientId));
    if (isNaN(clientId)) return res.status(400).json({ error: "Bad Request", message: "Invalid client id" });

    const cadence = parseCadence(req.body?.cadence);
    const { start, end, label } = resolveWindow(cadence, req.body?.date || req.body?.period);
    const excludeIds: number[] = Array.isArray(req.body?.exclude_invoice_ids)
      ? req.body.exclude_invoice_ids.map((n: any) => parseInt(n)).filter((n: number) => !isNaN(n))
      : [];

    // Pending per-visit drafts whose SERVICE DATE is in the window, earliest
    // service date first. (created_at is irrelevant here — service date is the
    // billing truth, so reschedules/backfills land in the right window.)
    const pending = await db
      .select({
        id: invoicesTable.id,
        invoice_number: invoicesTable.invoice_number,
        total: invoicesTable.total,
        line_items: invoicesTable.line_items,
        job_id: invoicesTable.job_id,
        service_date: jobsTable.scheduled_date,
      })
      .from(invoicesTable)
      .innerJoin(jobsTable, eq(invoicesTable.job_id, jobsTable.id))
      .where(and(
        eq(invoicesTable.company_id, companyId),
        eq(invoicesTable.client_id, clientId),
        eq(invoicesTable.status, "draft"),
        eq(invoicesTable.batch_status, "pending"),
        gte(jobsTable.scheduled_date, start),
        lte(jobsTable.scheduled_date, end),
      ))
      .orderBy(jobsTable.scheduled_date, invoicesTable.id);

    if (pending.length === 0) {
      return res.status(404).json({ error: "Not Found", message: `No pending visits to consolidate for ${label}` });
    }

    // Idempotency: if any visit in THIS window is already superseded, the window
    // is already consolidated. (Keyed on service date via the job join.)
    const [alreadyDone] = await db
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .innerJoin(jobsTable, eq(invoicesTable.job_id, jobsTable.id))
      .where(and(
        eq(invoicesTable.company_id, companyId),
        eq(invoicesTable.client_id, clientId),
        eq(invoicesTable.status, "superseded"),
        gte(jobsTable.scheduled_date, start),
        lte(jobsTable.scheduled_date, end),
      ))
      .limit(1);
    if (alreadyDone) {
      return res.status(409).json({ error: "Conflict", message: `${label} is already consolidated for this client` });
    }

    // The EARLIEST-service-date visit becomes the parent. Everything else folds in.
    const parent = pending[0];
    const folded = pending.slice(1).filter((p) => !excludeIds.includes(p.id));
    const excluded = pending.filter((p) => excludeIds.includes(p.id));
    if (excludeIds.includes(parent.id)) {
      return res.status(400).json({ error: "Bad Request", message: "Cannot exclude the earliest visit of the window (it is the consolidation parent)" });
    }

    // One line per visit, labeled with the SERVICE DATE. Amounts come straight
    // from each locked per-visit total — never recomputed.
    const visitLine = (inv: any) => ({
      description: `Cleaning — ${svcDateLabel(inv.service_date ? String(inv.service_date) : null)}${inv.invoice_number ? ` (#${inv.invoice_number})` : ""}`,
      quantity: 1,
      unit_price: parseFloat(inv.total || "0"),
      total: parseFloat(inv.total || "0"),
      source_invoice_id: inv.id,
      job_id: inv.job_id,
      service_date: inv.service_date ? String(inv.service_date).slice(0, 10) : null,
    });

    const parentLines = [visitLine(parent), ...folded.map(visitLine)];
    const parentTotal = Math.round(parentLines.reduce((s, l) => s + l.total, 0) * 100) / 100;
    const todayStr = new Date().toISOString().split("T")[0];

    await db.transaction(async (tx) => {
      // Parent: window total, one line per visit, issued 'sent' due-on-receipt.
      await tx.update(invoicesTable)
        .set({
          line_items: parentLines,
          subtotal: parentTotal.toFixed(2),
          total: parentTotal.toFixed(2),
          status: "sent",
          sent_at: new Date(),
          due_date: todayStr,
          payment_terms: "due_on_receipt",
          batch_status: "consolidated",
        })
        .where(and(eq(invoicesTable.id, parent.id), eq(invoicesTable.company_id, companyId)));

      // Folded children: zeroed, superseded, parent_invoice_id set. Records kept
      // (commission + job_history reference the job, not the invoice).
      if (folded.length > 0) {
        await tx.update(invoicesTable)
          .set({
            status: "superseded",
            subtotal: "0.00",
            total: "0.00",
            parent_invoice_id: parent.id,
            batch_status: "consolidated",
          })
          .where(and(
            eq(invoicesTable.company_id, companyId),
            inArray(invoicesTable.id, folded.map((f) => f.id)),
          ));
      }
      // Excluded drafts are intentionally left untouched.
    });

    logAudit(req, "UPDATE", "invoice", parent.id, null, {
      action: "consolidate", cadence, window: label, period_start: start, period_end: end,
      parent_invoice_id: parent.id, folded_count: folded.length, excluded_count: excluded.length, total: parentTotal,
    });

    // Push ONLY the parent to QB (one consolidated document). Children never push.
    queueSync(async () => {
      const { syncInvoice } = await import("../services/quickbooks-sync.js");
      await syncInvoice(companyId, parent.id);
    });

    return res.json({
      ok: true,
      cadence,
      window: label,
      period_start: start,
      period_end: end,
      parent_invoice_id: parent.id,
      parent_total: parentTotal,
      folded_invoice_ids: folded.map((f) => f.id),
      excluded_invoice_ids: excluded.map((e) => e.id),
      visit_count: parentLines.length,
    });
  } catch (err) {
    console.error("Consolidate error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to consolidate invoices" });
  }
});

export default router;
