import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireApiKey } from "../../lib/api-auth.js";
import {
  parseLimit, parseDateParam, decodeCursor, paginate, countFor, fail,
  companyOf, money, iso, dateOnly,
} from "./_shared.js";

// [ai-access 2026-08-15] Invoice reads for Qleno Connect. Read-only; issuing and
// sending are Phase 5 and both require an explicit confirm.
const router = Router();

type Row = Record<string, any>;

function serializeInvoice(r: Row) {
  return {
    id: Number(r.id),
    invoice_number: r.invoice_number ?? null,
    status: r.status,
    client: r.client_id ? { id: Number(r.client_id), name: r.client_name ?? null } : null,
    account: r.account_id ? { id: Number(r.account_id), name: r.account_name ?? null } : null,
    subtotal: money(r.subtotal) ?? 0,
    tips: money(r.tips) ?? 0,
    total: money(r.total) ?? 0,
    // What is actually still owed. An assistant asked "how much is outstanding"
    // must not sum `total` across unpaid invoices — a partially refunded invoice
    // would be overstated, and a paid one would be counted at all.
    balance_due: r.status === "paid" || r.status === "void"
      ? 0
      : Number(((money(r.total) ?? 0) - (money(r.refunded_amount) ?? 0)).toFixed(2)),
    refunded_amount: money(r.refunded_amount) ?? 0,
    service_date: dateOnly(r.service_date),
    due_date: dateOnly(r.due_date),
    sent_at: iso(r.sent_at),
    paid_at: iso(r.paid_at),
    created_at: iso(r.created_at),
    po_number: r.po_number ?? null,
    payment_terms: r.payment_terms ?? null,
    job_count: Number(r.job_count ?? 0),
  };
}

const INVOICE_SELECT = sql`
  SELECT
    i.id, i.invoice_number, i.status, i.subtotal, i.tips, i.total,
    i.refunded_amount, i.service_date, i.due_date, i.sent_at, i.paid_at,
    i.created_at, i.po_number, i.payment_terms,
    i.client_id, i.account_id,
    TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS client_name,
    a.account_name,
    -- Visits covered, counted from the coverage ledger. invoices.job_id names at
    -- most one job, and a collapsed "quantity: 4" line names one job_id while
    -- hiding three more — the ledger is the only carrier that sees all of them.
    COALESCE((SELECT COUNT(*)::int FROM invoice_job_links l
              WHERE l.invoice_id = i.id AND l.company_id = i.company_id AND l.is_live), 0) AS job_count
  FROM invoices i
  LEFT JOIN clients c ON c.id = i.client_id
  LEFT JOIN accounts a ON a.id = i.account_id
`;

/** GET /api/v1/invoices?status&from&to&account_id&client_id */
router.get("/invoices", requireApiKey("rest", "invoices:read"), async (req, res) => {
  const companyId = companyOf(req);
  const limit = parseLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);

  const from = req.query.from ? parseDateParam(req.query.from) : null;
  const to = req.query.to ? parseDateParam(req.query.to) : null;
  if (req.query.from && !from) { fail(res, 400, "invalid_parameter", "from must be YYYY-MM-DD"); return; }
  if (req.query.to && !to) { fail(res, 400, "invalid_parameter", "to must be YYYY-MM-DD"); return; }

  const accountId = req.query.account_id === undefined ? null : Number(req.query.account_id);
  const clientId = req.query.client_id === undefined ? null : Number(req.query.client_id);
  if (accountId !== null && !Number.isFinite(accountId)) { fail(res, 400, "invalid_parameter", "account_id must be a number"); return; }
  if (clientId !== null && !Number.isFinite(clientId)) { fail(res, 400, "invalid_parameter", "client_id must be a number"); return; }

  const status = typeof req.query.status === "string" ? req.query.status : null;
  // "unpaid" is not a stored status — it's the question people actually ask, so
  // it's accepted as a filter and expanded here rather than making every caller
  // know which of the stored statuses count as owing money.
  const STORED = ["draft", "sent", "paid", "overdue", "void", "superseded", "batched"];
  if (status && status !== "unpaid" && !STORED.includes(status)) {
    fail(res, 400, "invalid_parameter", `status must be 'unpaid' or one of: ${STORED.join(", ")}`, {
      valid: ["unpaid", ...STORED],
    });
    return;
  }

  const rows = await db.execute(sql`
    ${INVOICE_SELECT}
    WHERE i.company_id = ${companyId}
      ${status === "unpaid"
        // 'batched' and 'superseded' are excluded as well as paid and void: a
        // batched invoice is a member of a combined invoice that is itself in
        // this list, so counting both would bill the same work twice in any
        // total an assistant computes.
        ? sql`AND i.status NOT IN ('paid', 'void', 'superseded', 'batched')`
        : status ? sql`AND i.status = ${status}` : sql``}
      ${from ? sql`AND COALESCE(i.service_date, i.created_at::date) >= ${from}::date` : sql``}
      ${to ? sql`AND COALESCE(i.service_date, i.created_at::date) <= ${to}::date` : sql``}
      ${accountId !== null ? sql`AND i.account_id = ${accountId}` : sql``}
      ${clientId !== null ? sql`AND i.client_id = ${clientId}` : sql``}
      ${cursor ? sql`AND i.id < ${cursor.id}` : sql``}
    ORDER BY i.id DESC
    LIMIT ${limit + 1}
  `);

  const out = paginate((rows.rows as Row[]).map(serializeInvoice), limit, (i) => ({ k: null, id: i.id }));
  countFor(res, out.data.length);
  res.json(out);
});

/** GET /api/v1/invoices/:id — adds line items and the visits the invoice covers. */
router.get("/invoices/:id", requireApiKey("rest", "invoices:read"), async (req, res) => {
  const companyId = companyOf(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { fail(res, 400, "invalid_parameter", "id must be a number"); return; }

  const rows = await db.execute(sql`
    ${INVOICE_SELECT}
    WHERE i.company_id = ${companyId} AND i.id = ${id}
    LIMIT 1
  `);
  const row = (rows.rows as Row[])[0];
  if (!row) { fail(res, 404, "not_found", "No invoice with that id"); return; }

  // Scoped again even though the SELECT above already proved this invoice belongs
  // to this tenant. A second lookup by bare id is the shape that gets copied into
  // a handler that DIDN'T check first, and line_items carry customer addresses
  // and prices. The scope costs nothing here and removes the pattern.
  const items = await db.execute(sql`
    SELECT line_items FROM invoices WHERE id = ${id} AND company_id = ${companyId} LIMIT 1
  `);
  const raw = (items.rows[0] as any)?.line_items;
  const line_items = Array.isArray(raw) ? raw : [];

  const links = await db.execute(sql`
    SELECT l.job_id, j.scheduled_date, j.service_type
    FROM invoice_job_links l
    LEFT JOIN jobs j ON j.id = l.job_id AND j.company_id = ${companyId}
    WHERE l.invoice_id = ${id} AND l.company_id = ${companyId} AND l.is_live
    ORDER BY j.scheduled_date NULLS LAST, l.job_id
  `);

  countFor(res, 1);
  res.json({
    ...serializeInvoice(row),
    line_items,
    covered_jobs: (links.rows as any[]).map((l) => ({
      job_id: Number(l.job_id),
      date: dateOnly(l.scheduled_date),
      service_type: l.service_type ?? null,
    })),
  });
});

export default router;
