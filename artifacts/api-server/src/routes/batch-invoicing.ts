// [invoicing-engine 2026-06-16] Batch invoicing — Sal's "first invoice of the
// month" model (Scope 2). Mounted at /api/batch-invoicing. Owner/admin/office.
//
// How it works:
//   - batch_invoice clients still get a per-visit DRAFT invoice on every
//     completion (batch_status='pending'), created by the per-visit engine.
//   - This page lists those pending drafts grouped by client for a month.
//   - "Consolidate & Send" folds the month's pending visits into the FIRST
//     invoice of the month (the parent): the parent carries the full month total
//     as one line per visit; every OTHER pending invoice is zeroed and marked
//     'superseded' with parent_invoice_id pointing at the parent. Only the parent
//     is sent (net-0, due today) and pushed to QB. Superseded children never push.
//   - Office may EXCLUDE individual visits before sending (e.g. already billed in
//     QBO at month-start) via exclude_invoice_ids — excluded drafts are left
//     untouched (their amount is simply not in the parent), the record is kept.
//   - Idempotent: once a month is consolidated for a client (a superseded child
//     exists), it cannot be re-consolidated.
import { Router } from "express";
import { db } from "@workspace/db";
import { invoicesTable, clientsTable } from "@workspace/db/schema";
import { eq, and, gte, lte, sql, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { queueSync } from "../services/quickbooks-sync.js";

const router = Router();

// Resolve [start, end] timestamps for a YYYY-MM month (defaults to current month).
function monthWindow(monthParam?: string): { start: Date; end: Date; label: string } {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth(); // 0-based
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    const [y, m] = monthParam.split("-").map(Number);
    year = y; month = m - 1;
  }
  const start = new Date(year, month, 1, 0, 0, 0, 0);
  const end = new Date(year, month + 1, 0, 23, 59, 59, 999); // last day of month
  const label = `${year}-${String(month + 1).padStart(2, "0")}`;
  return { start, end, label };
}

// GET /api/batch-invoicing?month=YYYY-MM
// Lists batch_invoice clients with pending per-visit drafts in the month,
// grouped by client (visit count + month-to-date total).
router.get("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const { start, end, label } = monthWindow(req.query.month as string | undefined);

    const rows = await db
      .select({
        client_id: invoicesTable.client_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        client_email: clientsTable.email,
        invoice_id: invoicesTable.id,
        invoice_number: invoicesTable.invoice_number,
        total: invoicesTable.total,
        created_at: invoicesTable.created_at,
        due_date: invoicesTable.due_date,
        line_items: invoicesTable.line_items,
        job_id: invoicesTable.job_id,
      })
      .from(invoicesTable)
      .leftJoin(clientsTable, eq(invoicesTable.client_id, clientsTable.id))
      .where(and(
        eq(invoicesTable.company_id, companyId),
        eq(invoicesTable.status, "draft"),
        eq(invoicesTable.batch_status, "pending"),
        gte(invoicesTable.created_at, start),
        lte(invoicesTable.created_at, end),
      ))
      .orderBy(invoicesTable.client_id, invoicesTable.created_at);

    // Group by client.
    const byClient = new Map<number, any>();
    for (const r of rows) {
      const cid = r.client_id as number;
      if (!byClient.has(cid)) {
        byClient.set(cid, {
          client_id: cid,
          client_name: r.client_name,
          client_email: r.client_email,
          visit_count: 0,
          month_to_date_total: 0,
          first_invoice_id: r.invoice_id,         // earliest (ordered by created_at)
          first_invoice_created_at: r.created_at,
          visits: [] as any[],
        });
      }
      const g = byClient.get(cid);
      g.visit_count += 1;
      g.month_to_date_total = Math.round((g.month_to_date_total + parseFloat(r.total || "0")) * 100) / 100;
      g.visits.push({
        invoice_id: r.invoice_id,
        invoice_number: r.invoice_number,
        total: parseFloat(r.total || "0"),
        created_at: r.created_at,
        line_items: r.line_items,
        job_id: r.job_id,
      });
    }

    return res.json({ month: label, clients: Array.from(byClient.values()) });
  } catch (err) {
    console.error("Batch invoicing list error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to list batch invoices" });
  }
});

// POST /api/batch-invoicing/:clientId/consolidate
// Body: { month?: "YYYY-MM", exclude_invoice_ids?: number[] }
router.post("/:clientId/consolidate", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const clientId = parseInt(String(req.params.clientId));
    if (isNaN(clientId)) return res.status(400).json({ error: "Bad Request", message: "Invalid client id" });

    const { start, end, label } = monthWindow(req.body?.month);
    const excludeIds: number[] = Array.isArray(req.body?.exclude_invoice_ids)
      ? req.body.exclude_invoice_ids.map((n: any) => parseInt(n)).filter((n: number) => !isNaN(n))
      : [];

    // Idempotency guard: if a child has already been superseded into a parent
    // for this client in this month, the month is already consolidated.
    const [alreadyDone] = await db
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(and(
        eq(invoicesTable.company_id, companyId),
        eq(invoicesTable.client_id, clientId),
        eq(invoicesTable.status, "superseded"),
        gte(invoicesTable.created_at, start),
        lte(invoicesTable.created_at, end),
      ))
      .limit(1);
    if (alreadyDone) {
      return res.status(409).json({ error: "Conflict", message: `${label} is already consolidated for this client` });
    }

    // Pending per-visit drafts for the month, earliest first.
    const pending = await db
      .select({
        id: invoicesTable.id,
        invoice_number: invoicesTable.invoice_number,
        total: invoicesTable.total,
        subtotal: invoicesTable.subtotal,
        line_items: invoicesTable.line_items,
        created_at: invoicesTable.created_at,
        job_id: invoicesTable.job_id,
        payment_source: invoicesTable.payment_source,
      })
      .from(invoicesTable)
      .where(and(
        eq(invoicesTable.company_id, companyId),
        eq(invoicesTable.client_id, clientId),
        eq(invoicesTable.status, "draft"),
        eq(invoicesTable.batch_status, "pending"),
        gte(invoicesTable.created_at, start),
        lte(invoicesTable.created_at, end),
      ))
      .orderBy(invoicesTable.created_at, invoicesTable.id);

    if (pending.length === 0) {
      return res.status(404).json({ error: "Not Found", message: "No pending visits to consolidate for this month" });
    }

    // The FIRST invoice of the month becomes the parent. Everything else folds in.
    const parent = pending[0];
    const folded = pending.slice(1).filter((p) => !excludeIds.includes(p.id));
    const excluded = pending.filter((p) => excludeIds.includes(p.id));
    // The parent itself can be excluded only if it's the sole invoice — guard:
    if (excludeIds.includes(parent.id)) {
      return res.status(400).json({ error: "Bad Request", message: "Cannot exclude the first invoice of the month (it is the consolidation parent)" });
    }

    // Build the parent's consolidated line items: one line per visit (parent +
    // each folded child). Amounts come straight from each locked per-visit total
    // — never recomputed.
    const visitLine = (inv: any) => {
      const d = inv.created_at ? new Date(inv.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
      return {
        description: `Visit ${d}${inv.invoice_number ? ` (#${inv.invoice_number})` : ""}`,
        quantity: 1,
        unit_price: parseFloat(inv.total || "0"),
        total: parseFloat(inv.total || "0"),
        source_invoice_id: inv.id,
        job_id: inv.job_id,
      };
    };

    const parentLines = [visitLine(parent), ...folded.map(visitLine)];
    const parentTotal = Math.round(parentLines.reduce((s, l) => s + l.total, 0) * 100) / 100;
    const todayStr = new Date().toISOString().split("T")[0];

    await db.transaction(async (tx) => {
      // Parent: full month total, one line per visit, sent + due today (net-0).
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
      // Excluded drafts are intentionally left untouched (their amount is simply
      // not in the parent; the office handles them separately, e.g. already
      // billed in QBO). Record preserved per spec.
    });

    logAudit(req, "UPDATE", "invoice", parent.id, null, {
      action: "batch_consolidate", month: label, parent_invoice_id: parent.id,
      folded_count: folded.length, excluded_count: excluded.length, total: parentTotal,
    });

    // Push ONLY the parent to QB (one consolidated document). Children never push.
    queueSync(async () => {
      const { syncInvoice } = await import("../services/quickbooks-sync.js");
      await syncInvoice(companyId, parent.id);
    });

    return res.json({
      ok: true,
      month: label,
      parent_invoice_id: parent.id,
      parent_total: parentTotal,
      folded_invoice_ids: folded.map((f) => f.id),
      excluded_invoice_ids: excluded.map((e) => e.id),
      visit_count: parentLines.length,
    });
  } catch (err) {
    console.error("Batch consolidate error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to consolidate invoices" });
  }
});

export default router;
