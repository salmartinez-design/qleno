// [invoice-line-items 2026-06-17] Single source of truth for building an
// invoice's line items from a job's LOCKED pricing. Used by:
//   - ensureInvoiceForCompletedJob (creation on completion)
//   - syncJobInvoiceDraft (re-sync a draft when the job is edited in dispatch)
//   - POST /api/invoices/:id/recalc (office "recalc from job" action)
// Previously the draft-sync rebuilt scope + discounts only and DROPPED add-ons;
// centralizing here makes all three identical so they can never diverge again.
//
// Composition (never recomputed from the pricing engine — uses stored values):
//   scope line  — hourly jobs bill billed_amount (qty = billed_hours,
//                 unit = hourly_rate); flat jobs bill base_fee (qty 1).
//   add-on lines — one per job_add_ons row (covers add-ons AND fee rules like
//                 parking), named from add_ons. Skipped for hourly jobs whose
//                 billed_amount already rolls everything into the metered total.
//   discount lines — each job_discounts row as a negative line so the total nets.
import { db } from "@workspace/db";
import { jobsTable, jobAddOnsTable, addOnsTable, jobDiscountsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

export type InvoiceLineItem = { description: string; quantity: number; unit_price: number; total: number };

export async function buildJobLineItems(
  companyId: number,
  jobId: number,
): Promise<{ lineItems: InvoiceLineItem[]; subtotal: number } | null> {
  const [job] = await db
    .select({
      service_type: jobsTable.service_type,
      base_fee: jobsTable.base_fee,
      billed_amount: jobsTable.billed_amount,
      billed_hours: jobsTable.billed_hours,
      hourly_rate: jobsTable.hourly_rate,
    })
    .from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)))
    .limit(1);
  if (!job) return null;

  const scopeAmount = job.billed_amount
    ? parseFloat(String(job.billed_amount))
    : parseFloat(String(job.base_fee ?? "0"));
  const svcLabel = (job.service_type ?? "Cleaning Service")
    .split("_").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const scopeQty = job.billed_hours ? parseFloat(String(job.billed_hours)) : 1;
  const scopeUnit = job.hourly_rate ? parseFloat(String(job.hourly_rate)) : scopeAmount;

  const lineItems: InvoiceLineItem[] = [
    { description: svcLabel, quantity: scopeQty, unit_price: scopeUnit, total: scopeAmount },
  ];
  let runningTotal = scopeAmount;

  if (!job.billed_amount) {
    const addons = await db
      .select({
        name: addOnsTable.name,
        quantity: jobAddOnsTable.quantity,
        unit_price: jobAddOnsTable.unit_price,
        subtotal: jobAddOnsTable.subtotal,
      })
      .from(jobAddOnsTable)
      .leftJoin(addOnsTable, eq(jobAddOnsTable.add_on_id, addOnsTable.id))
      .where(eq(jobAddOnsTable.job_id, jobId));
    for (const a of addons) {
      const lineTotal = parseFloat(String(a.subtotal ?? "0"));
      runningTotal += lineTotal;
      lineItems.push({
        description: a.name || "Add-on",
        quantity: a.quantity ?? 1,
        unit_price: parseFloat(String(a.unit_price ?? "0")),
        total: lineTotal,
      });
    }
  }

  const jobDisc = await db.select().from(jobDiscountsTable)
    .where(and(eq(jobDiscountsTable.job_id, jobId), eq(jobDiscountsTable.company_id, companyId)));
  for (const d of jobDisc) {
    const amt = parseFloat(String(d.amount));
    runningTotal -= amt;
    const label = `Discount${d.code ? ` ${d.code}` : (d.type === "percent" ? ` ${parseFloat(String(d.value))}%` : "")}${d.reason && d.reason !== d.code ? ` — ${d.reason}` : ""}`;
    lineItems.push({ description: label, quantity: 1, unit_price: -amt, total: -amt });
  }

  const subtotal = Math.max(0, Math.round(runningTotal * 100) / 100);
  return { lineItems, subtotal };
}
