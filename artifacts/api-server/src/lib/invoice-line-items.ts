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
import { jobsTable, jobAddOnsTable, addOnsTable, jobDiscountsTable, accountPropertiesTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { ensureAutoPromosForJob } from "./auto-promos.js";

export type InvoiceLineItem = { description: string; quantity: number; unit_price: number; total: number };

export async function buildJobLineItems(
  companyId: number,
  jobId: number,
  exec: any = db,
): Promise<{ lineItems: InvoiceLineItem[]; subtotal: number } | null> {
  // [auto-promos 2026-06-21] Single chokepoint: ensure the job carries exactly
  // the auto-promo it's entitled to (15% off 2nd recurring visit / any deep
  // clean) as a job_discounts row BEFORE we read job_discounts below. This makes
  // every invoice surface (completion, draft re-sync, office recalc) honor the
  // advertised offers with no per-call-site wiring. Idempotent + self-healing.
  // `exec` (pool by default) lets the verification harness run the whole flow in
  // a rolled-back transaction.
  await ensureAutoPromosForJob(companyId, jobId, exec);

  const [job] = await exec
    .select({
      service_type: jobsTable.service_type,
      base_fee: jobsTable.base_fee,
      billed_amount: jobsTable.billed_amount,
      billed_hours: jobsTable.billed_hours,
      allowed_hours: jobsTable.allowed_hours,
      hourly_rate: jobsTable.hourly_rate,
      manual_rate_override: jobsTable.manual_rate_override,
      account_property_id: jobsTable.account_property_id,
    })
    .from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)))
    .limit(1);
  if (!job) return null;

  // [hourly-line-fix 2026-07-03] Scope line, three modes:
  //  - metered (billed_amount set): the all-in metered total; add-ons rolled in.
  //  - hourly rate-driven (hourly_rate + hours, NOT a pinned flat price): bill
  //    LABOR = hours × rate, with add-ons (e.g. parking) as SEPARATE lines. We do
  //    NOT use base_fee here — on PPM/KMA it can bake parking into base_fee, so
  //    using it would DOUBLE-count parking (a $150 3h turnover + $20 parking was
  //    invoicing $190 instead of $170, on a nonsensical "qty 1 × $50 = $170" line).
  //  - flat: base_fee, qty 1.
  const rateNum = job.hourly_rate ? parseFloat(String(job.hourly_rate)) : 0;
  const hoursNum = job.billed_hours
    ? parseFloat(String(job.billed_hours))
    : (job.allowed_hours ? parseFloat(String(job.allowed_hours)) : 0);
  const isMetered = !!job.billed_amount;
  const isHourlyRateDriven = !isMetered && !job.manual_rate_override && rateNum > 0 && hoursNum > 0;
  const svcLabel = (job.service_type ?? "Cleaning Service")
    .split("_").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  // [building-names 2026-07-02] For account/commercial jobs, lead the line with
  // the BUILDING NAME (not "Prop #47") so a merged property-management invoice
  // reads by building — e.g. "Lincoln Tower — Ppm Turnover".
  let scopeDesc = svcLabel;
  if ((job as any).account_property_id) {
    try {
      const [prop] = await exec
        .select({ name: accountPropertiesTable.property_name })
        .from(accountPropertiesTable)
        .where(eq(accountPropertiesTable.id, (job as any).account_property_id))
        .limit(1);
      if (prop?.name) scopeDesc = `${prop.name} — ${svcLabel}`;
    } catch { /* non-fatal — fall back to the service label */ }
  }
  let scopeQty: number, scopeUnit: number, scopeAmount: number;
  if (isMetered) {
    scopeAmount = parseFloat(String(job.billed_amount));
    scopeQty = job.billed_hours ? parseFloat(String(job.billed_hours)) : 1;
    scopeUnit = rateNum || scopeAmount;
  } else if (isHourlyRateDriven) {
    scopeQty = hoursNum;
    scopeUnit = rateNum;
    scopeAmount = Math.round(hoursNum * rateNum * 100) / 100;   // labor only
  } else {
    scopeAmount = parseFloat(String(job.base_fee ?? "0"));
    scopeQty = 1;
    scopeUnit = scopeAmount;
  }

  const lineItems: InvoiceLineItem[] = [
    { description: scopeDesc, quantity: scopeQty, unit_price: scopeUnit, total: scopeAmount },
  ];
  let runningTotal = scopeAmount;

  if (!job.billed_amount) {
    const addons = await exec
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

  const jobDisc = await exec.select().from(jobDiscountsTable)
    .where(and(eq(jobDiscountsTable.job_id, jobId), eq(jobDiscountsTable.company_id, companyId)));
  for (const d of jobDisc) {
    const amt = parseFloat(String(d.amount));
    runningTotal -= amt;
    // Auto-promo rows (code AUTO_*) carry a human label in `reason` — show that
    // alone so the invoice reads "Deep Clean Promo (15% off)", not the internal
    // AUTO_ code. Other discounts keep the existing code/percent labeling.
    const isAuto = typeof d.code === "string" && d.code.startsWith("AUTO_");
    const label = isAuto && d.reason
      ? String(d.reason)
      : `Discount${d.code ? ` ${d.code}` : (d.type === "percent" ? ` ${parseFloat(String(d.value))}%` : "")}${d.reason && d.reason !== d.code ? ` — ${d.reason}` : ""}`;
    lineItems.push({ description: label, quantity: 1, unit_price: -amt, total: -amt });
  }

  const subtotal = Math.max(0, Math.round(runningTotal * 100) / 100);
  return { lineItems, subtotal };
}
