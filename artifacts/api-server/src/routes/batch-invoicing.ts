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
//   - "Consolidate" hands the window's pending visits to the ONE combine engine
//     (lib/invoice-billing.ts combineInvoices). It mints a NEW parent carrying
//     one line per visit and marks each member 'batched' — members keep their
//     number and their total and stay visible on the client. Nothing is zeroed.
//   - Office may EXCLUDE individual visits before merging (exclude_invoice_ids)
//     — excluded drafts are left untouched (kept, just not in the parent).
//   - Idempotent per (client, window): consolidated visits leave the pending
//     pool (status 'batched'), so a re-run finds nothing and reports the parent
//     that already covers the window.
//
// [batch-invoicing 2026-08-03] This route used to be its own fold — one of five
// separate implementations of "combine invoices." It now delegates. Do NOT
// reintroduce a local fold here; see docs/BATCH_INVOICING_DESIGN.md §5 S-2.
// The QuickBooks push was removed with the disconnect (D-9).
//
// per_visit clients (all residential + most commercial) never reach here: their
// completion invoice is issued 'sent' immediately and is its own document.
import { Router } from "express";
import { db } from "@workspace/db";
import { invoicesTable, clientsTable, jobsTable } from "@workspace/db/schema";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { combineInvoices } from "../lib/invoice-billing.js";

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
      // Nothing pending. Either there was never any work in this window, or the
      // window is already consolidated — members left the pending pool when they
      // became 'batched'. Name the parent so the office isn't left guessing.
      const [done] = await db
        .select({ parent_id: invoicesTable.parent_invoice_id })
        .from(invoicesTable)
        .innerJoin(jobsTable, eq(invoicesTable.job_id, jobsTable.id))
        .where(and(
          eq(invoicesTable.company_id, companyId),
          eq(invoicesTable.client_id, clientId),
          eq(invoicesTable.status, "batched"),
          gte(jobsTable.scheduled_date, start),
          lte(jobsTable.scheduled_date, end),
        ))
        .limit(1);
      if (done?.parent_id) {
        return res.status(409).json({
          error: "Conflict",
          message: `${label} is already consolidated for this client (invoice ${done.parent_id})`,
          parent_invoice_id: done.parent_id,
        });
      }
      return res.status(404).json({ error: "Not Found", message: `No pending visits to consolidate for ${label}` });
    }

    const members = pending.filter((p) => !excludeIds.includes(p.id));
    const excluded = pending.filter((p) => excludeIds.includes(p.id));
    if (members.length === 0) {
      return res.status(400).json({ error: "Bad Request", message: "Every visit in the window was excluded — nothing left to consolidate" });
    }

    // A single visit is already its own document. Issue it rather than minting a
    // one-line parent on top of it (that would be two rows for one dollar).
    if (members.length === 1) {
      const only = members[0];
      const todayStr = new Date().toISOString().split("T")[0];
      await db.update(invoicesTable)
        .set({
          status: "sent",
          sent_at: new Date(),
          due_date: todayStr,
          payment_terms: "due_on_receipt",
          batch_status: "consolidated",
        })
        .where(and(eq(invoicesTable.id, only.id), eq(invoicesTable.company_id, companyId)));

      logAudit(req, "UPDATE", "invoice", only.id, null, {
        action: "consolidate", cadence, window: label, period_start: start, period_end: end,
        parent_invoice_id: only.id, folded_count: 0, excluded_count: excluded.length, total: parseFloat(only.total || "0"),
      });

      return res.json({
        ok: true, cadence, window: label, period_start: start, period_end: end,
        parent_invoice_id: only.id, parent_number: only.invoice_number, parent_total: parseFloat(only.total || "0"),
        folded_invoice_ids: [], excluded_invoice_ids: excluded.map((e) => e.id), visit_count: 1,
      });
    }

    // Two or more visits: hand them to the one combine engine. It mints the
    // parent, marks members 'batched' (numbers and totals intact), and moves the
    // billing coverage onto the parent so no visit can be billed twice.
    const combined = await combineInvoices({
      companyId,
      memberInvoiceIds: members.map((m) => m.id),
      actorUserId: req.auth!.userId,
      paymentTerms: "due_on_receipt",
    });

    logAudit(req, "UPDATE", "invoice", combined.parent_id, null, {
      action: "consolidate", cadence, window: label, period_start: start, period_end: end,
      parent_invoice_id: combined.parent_id, folded_count: combined.member_ids.length,
      excluded_count: excluded.length, total: combined.total,
    });

    return res.json({
      ok: true,
      cadence,
      window: label,
      period_start: start,
      period_end: end,
      parent_invoice_id: combined.parent_id,
      parent_number: combined.parent_number,
      parent_total: combined.total,
      folded_invoice_ids: combined.member_ids,
      excluded_invoice_ids: excluded.map((e) => e.id),
      visit_count: combined.member_ids.length,
    });
  } catch (err: any) {
    console.error("Consolidate error:", err);
    const msg = err?.message || "Failed to consolidate invoices";
    const conflict = /already|combine|same customer|at least two/i.test(msg);
    return res.status(conflict ? 409 : 500).json({
      error: conflict ? "Conflict" : "Internal Server Error",
      message: conflict ? msg : "Failed to consolidate invoices",
    });
  }
});

// ---------------------------------------------------------------------------
// [cadence 2026-07-22] ACCOUNT-keyed bundling. The routes above key on
// client_id (residential batch_invoice clients) and push the merged parent to
// QuickBooks. Commercial ACCOUNTS need the same fold but grouped by account_id
// and with NO QB push, so they get their own pair of endpoints over
// lib/invoice-cadence.ts rather than a client_id-shaped workaround.
// ---------------------------------------------------------------------------

// GET /api/batch-invoicing/accounts/preview?as_of=YYYY-MM-DD&force=1
// Dry run: what the close WOULD bill, per bundled account. Writes nothing.
router.get("/accounts/preview", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const { runInvoiceCadenceClose } = await import("../lib/invoice-cadence.js");
    const out = await runInvoiceCadenceClose({
      companyId: req.auth!.companyId as number,
      asOf: typeof req.query.as_of === "string" ? req.query.as_of : undefined,
      force: req.query.force === "1" || req.query.force === "true",
      accountId: req.query.account_id ? parseInt(String(req.query.account_id)) : undefined,
      dryRun: true,
    });
    return res.json(out);
  } catch (err) {
    console.error("Account cadence preview error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to preview account billing windows" });
  }
});

// POST /api/batch-invoicing/accounts/close
// Body: { as_of?: 'YYYY-MM-DD', force?: boolean, account_id?: number }
// Runs the close for real. Same code the nightly 5 AM cron runs — this is the
// manual trigger (and what the July backfill uses with force).
router.post("/accounts/close", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const { runInvoiceCadenceClose } = await import("../lib/invoice-cadence.js");
    const out = await runInvoiceCadenceClose({
      companyId,
      asOf: typeof req.body?.as_of === "string" ? req.body.as_of : undefined,
      force: req.body?.force === true,
      accountId: req.body?.account_id ? parseInt(String(req.body.account_id)) : undefined,
      dryRun: false,
      userId: req.auth!.userId,
    });
    for (const r of out.results.filter((x: any) => x.status === "closed")) {
      logAudit(req, "UPDATE", "invoice", r.parent_invoice_id!, null, {
        action: "account_cadence_close", account_id: r.account_id, cadence: r.cadence,
        window: r.window, visit_count: r.visit_count, total: r.total, emailed: r.emailed,
      });
    }
    return res.json(out);
  } catch (err) {
    console.error("Account cadence close error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to close account billing windows" });
  }
});

export default router;
