/**
 * Bill a late-reschedule fee.
 *
 * ── WHY ITS OWN INVOICE, NOT A LINE ON THE JOB ───────────────────────────────
 *
 * The visit still happens, on the new date, and will invoice for its own full
 * price when it completes. The fee is a SEPARATE charge for the short notice.
 * Folding it into the job would make the cleaning cost more than the cleaning
 * costs, and the customer would receive one line they could not reconcile.
 *
 * ── WHY IT DOES NOT CLAIM THE VISIT ──────────────────────────────────────────
 *
 * Critically, this invoice must NOT record billing coverage for the job. The
 * coverage ledger (invoice_job_links, design D-3) is the one predicate every
 * billing path shares to answer "has this visit been billed?". If a fee invoice
 * claimed the visit, `ensureInvoiceForCompletedJob` would find live coverage
 * when the job finally completes and skip it — and the cleaning would never be
 * billed at all. So: no setInvoiceCoverage call, and `invoices.job_id` is left
 * NULL rather than risk any older "is this job invoiced" probe reading it.
 *
 * Traceability instead lives where it cannot do damage: the line description
 * names the job and the date it was moved from, and the cancellation_log row
 * for the move carries the job id and the amount.
 */
import { db } from "@workspace/db";
import { invoicesTable, clientsTable, notificationLogTable } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { getNextInvoiceNumber } from "./invoice-number.js";
import { syncInvoice, queueSync } from "../services/quickbooks-sync.js";

const TERM_DAYS: Record<string, number> = { net_30: 30, net_15: 15, net_7: 7 };

export interface RescheduleFeeInvoice {
  id: number;
  invoice_number: string;
  total: string;
  status: string;
}

export async function createRescheduleFeeInvoice(opts: {
  companyId: number;
  clientId: number;
  jobId: number;
  /** The date the visit was moved OFF — what the customer is being charged about. */
  originalDate: string | null;
  amount: number;
  userId: number | null;
  /** Issue it straight away vs leave a draft for the office to review. */
  autoSend?: boolean;
}): Promise<RescheduleFeeInvoice | null> {
  const amount = Math.round(opts.amount * 100) / 100;
  if (!(amount > 0)) return null;

  const [client] = await db
    .select({
      payment_terms: clientsTable.payment_terms,
      billing_contact_name: clientsTable.billing_contact_name,
      billing_contact_email: clientsTable.billing_contact_email,
      email: clientsTable.email,
    })
    .from(clientsTable)
    .where(and(eq(clientsTable.id, opts.clientId), eq(clientsTable.company_id, opts.companyId)))
    .limit(1);

  const terms = client?.payment_terms || "due_on_receipt";
  const due = new Date();
  due.setDate(due.getDate() + (TERM_DAYS[terms] ?? 0));

  const movedFrom = opts.originalDate
    ? new Date(`${opts.originalDate}T12:00:00Z`).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
      })
    : null;
  // Named for what the customer actually did, with the appointment they moved
  // away from — a fee line nobody can place is a fee line that gets disputed.
  const description = movedFrom
    ? `Late reschedule fee — visit of ${movedFrom} moved on short notice (job #${opts.jobId})`
    : `Late reschedule fee — short notice (job #${opts.jobId})`;

  const lineItems = [{ description, quantity: 1, unit_price: amount, total: amount }];

  const [inv] = await db
    .insert(invoicesTable)
    .values({
      company_id: opts.companyId,
      client_id: opts.clientId,
      account_id: null,
      // Deliberately NULL — see the header note. This invoice never claims the
      // visit; the visit bills itself when it completes on its new date.
      job_id: null,
      line_items: lineItems as any,
      subtotal: amount.toFixed(2),
      tips: "0",
      total: amount.toFixed(2),
      due_date: due.toISOString().slice(0, 10),
      status: opts.autoSend ? "sent" : "draft",
      sent_at: opts.autoSend ? new Date() : null,
      created_by: opts.userId,
      payment_terms: terms,
      billing_contact_name: client?.billing_contact_name ?? null,
      billing_contact_email: client?.billing_contact_email ?? null,
    })
    .returning();

  const number = await getNextInvoiceNumber(opts.companyId, inv.id);
  await db.update(invoicesTable).set({ invoice_number: number }).where(eq(invoicesTable.id, inv.id));

  try {
    await db.insert(notificationLogTable).values({
      company_id: opts.companyId,
      recipient: client?.email || "system",
      channel: "system",
      trigger: "invoice_created",
      status: "sent",
      metadata: { invoice_id: inv.id, amount, job_id: opts.jobId, reason: "late_reschedule_fee" } as any,
    });
  } catch { /* the log is a nicety; the invoice is the record */ }

  queueSync(() => syncInvoice(opts.companyId, inv.id));

  return {
    id: inv.id,
    invoice_number: number,
    total: amount.toFixed(2),
    status: opts.autoSend ? "sent" : "draft",
  };
}
