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
import { jobsTable, jobAddOnsTable, addOnsTable, jobDiscountsTable, accountPropertiesTable, clientsTable } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { ensureAutoPromosForJob } from "./auto-promos.js";

// job_id on the SCOPE line makes the job discoverable from the invoice via the
// dispatch `line_items @> [{job_id}]` containment lookup — without it, a job
// folded into a merged/account invoice shows "No invoice yet" on its card.
export type InvoiceLineItem = { description: string; quantity: number; unit_price: number; total: number; job_id?: number };

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
      // [flat-addon-itemize 2026-07-11] account_id + client_type mirror the
      // commercial test in recomputeJobBilledAmount so we can tell a genuinely
      // metered job (rate × hours) apart from a residential/flat job whose
      // billed_amount is merely base_fee + mods (see isMetered below).
      account_id: jobsTable.account_id,
      client_type: clientsTable.client_type,
    })
    .from(jobsTable)
    .leftJoin(clientsTable, eq(clientsTable.id, jobsTable.client_id))
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)))
    .limit(1);
  if (!job) return null;

  // [rate-mod-lines 2026-07-03] Time & Fee Adjustments (job_rate_mods) never
  // reached the invoice — the office adds e.g. a "$0 — Unit 2001" or a "+1 hr
  // Additional Time $50" adjustment on a PPM turnover, and it silently vanished
  // ("mirrors to the invoice… but it didnt"). Surface EACH mod (flat AND time)
  // as its own labeled line. billed_amount already FOLDS IN every mod's dollar
  // amount (recomputeJobBilledAmount: non-commercial = base + SUM(all mods);
  // commercial = rate×allowed_hours [time mods grew allowed_hours] + flat mods +
  // add-ons — so a time mod's amount = rate×its-hours is inside rate×allowed_hours).
  // Either way the mod's `amount` is in billed_amount, so we SUBTRACT the total
  // back out of the scope line and re-add it as labeled lines — net total is
  // byte-identical, only now each adjustment (and its unit / reason) is visible.
  // [rate-mod-lines-time 2026-07-03] Extended from flat-only to time+flat:
  // Maribel "we saw it work with flat fee, but not with Time". A time mod's
  // amount is stored (e.g. 60 min → $50) and lives in billed_amount too, so it
  // gets the identical subtract-then-line treatment.
  const modRows = await exec.execute(sql`
    SELECT reason, amount, mod_type
      FROM job_rate_mods
     WHERE job_id = ${jobId} AND company_id = ${companyId}
     ORDER BY created_at ASC
  `);
  const mods = (modRows.rows as Array<{ reason: string | null; amount: string; mod_type: string }>);
  const modsTotal = mods.reduce((s, m) => s + parseFloat(String(m.amount ?? "0")), 0);

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
  // [flat-addon-itemize 2026-07-11] billed_amount being SET is not enough to
  // treat a job as metered. recomputeJobBilledAmount stamps billed_amount for
  // EVERY job — commercial as rate×allowed_hours+add-ons+mods, but residential/
  // flat as plain base_fee + mods. In the residential case the add-ons still
  // live in base_fee and must be itemized (base_fee − add-ons scope). Treating
  // it as "metered" skipped that (add-ons roll into the scope line), so the
  // moment the office added an adjustment — which is what stamps billed_amount —
  // the add-on silently folded into the base "service" line (Joni Schildgen:
  // a $62.40 window vanished into a $478.40 "Deep Clean" line). Only a genuine
  // metered total rolls add-ons in: commercial hourly (the exact commercial
  // condition recomputeJobBilledAmount uses) or a clock-metered job (billed_hours
  // set). Everything else itemizes, so an adjustment can never move the base line.
  const isCommercial = job.account_id != null || job.client_type === "commercial";
  const allowedHrsNum = job.allowed_hours ? parseFloat(String(job.allowed_hours)) : 0;
  const commercialMetered = isCommercial && !job.manual_rate_override && rateNum > 0 && allowedHrsNum > 0;
  const clockMetered = !!job.billed_hours;
  // Numeric guard: only a POSITIVE billed_amount can be re-classified. A zero/
  // blank billed_amount stays on the exact legacy path (`!!billed_amount`, which
  // is truthy for the string "0.00") so this change's blast radius is strictly
  // positive-billed residential/flat jobs — the population where adding an
  // adjustment stamped billed_amount = base_fee + mods and folded add-ons into
  // the base line. Legacy $0-billed rows are left byte-for-byte unchanged.
  const billedNum = parseFloat(String(job.billed_amount ?? "0"));
  const isMetered = billedNum > 0 ? (commercialMetered || clockMetered) : !!job.billed_amount;
  // Gate on billed_amount being ABSENT (its original domain — this was
  // `!isMetered` back when isMetered === !!billed_amount). Keeping it tied to
  // billed_amount, not the new narrowed isMetered, means a residential job that
  // now falls out of the metered branch lands in the FLAT branch (scope =
  // base_fee − add-ons) rather than hours × rate — so its total is provably
  // unchanged (base_fee + mods = the stamped billed_amount).
  const isHourlyRateDriven = !job.billed_amount && !job.manual_rate_override && rateNum > 0 && hoursNum > 0;
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
  // Add-ons are fetched up front because the FLAT branch below must subtract
  // their subtotal from the scope line (see comment there). Itemized whenever
  // the job is NOT genuinely metered — a true metered total (commercial hourly /
  // clock-metered) already rolls them in, but a residential/flat job's add-ons
  // sit in base_fee and have to be split back out. Gated on isMetered (not raw
  // billed_amount) so a residential job with a stamped billed_amount still
  // itemizes (the [flat-addon-itemize] fix).
  const addons: Array<{ name: string | null; quantity: number | null; unit_price: string | null; subtotal: string | null }> = !isMetered
    ? await exec
        .select({
          name: addOnsTable.name,
          quantity: jobAddOnsTable.quantity,
          unit_price: jobAddOnsTable.unit_price,
          subtotal: jobAddOnsTable.subtotal,
        })
        .from(jobAddOnsTable)
        .leftJoin(addOnsTable, eq(jobAddOnsTable.add_on_id, addOnsTable.id))
        .where(eq(jobAddOnsTable.job_id, jobId))
    : [];
  const addOnsSubtotal = addons.reduce((s, a) => s + parseFloat(String(a.subtotal ?? "0")), 0);

  let scopeQty: number, scopeUnit: number, scopeAmount: number;
  if (isMetered) {
    // Pull flat mods back out of the metered total — they get their own lines
    // below, so leaving them in the scope would double-count.
    scopeAmount = parseFloat(String(job.billed_amount)) - modsTotal;
    scopeQty = job.billed_hours ? parseFloat(String(job.billed_hours)) : 1;
    scopeUnit = rateNum || scopeAmount;
  } else if (isHourlyRateDriven) {
    scopeQty = hoursNum;
    scopeUnit = rateNum;
    scopeAmount = Math.round(hoursNum * rateNum * 100) / 100;   // labor only
  } else {
    // [addon-doublecount 2026-07-08] base_fee is the ALL-IN residential total
    // (the wizard/quote/edit-modal convention — it already CONTAINS the add-on
    // subtotals; same invariant the dispatch card fix documented). The add-ons
    // are itemized as their own lines below, so they must come OUT of the
    // scope line — printing base_fee verbatim and re-adding them told Joni's
    // customer $640.80 in the booking-confirmation email while the office
    // quote correctly said $528.40 (Francisco: "the email is adding the total
    // with add ons and adding again the add ons").
    // [flat-addon-itemize 2026-07-11] When a positive billed_amount is present
    // (a residential/flat job whose adjustment stamped billed_amount = base_fee
    // + mods), anchor the pure-service line on billed_amount − mods − add-ons.
    // The mods and add-ons are re-added as their own lines below, so the invoice
    // total lands on exactly billed_amount − discounts — BYTE-IDENTICAL to the
    // pre-fix metered path — while the add-on becomes its own line instead of
    // hiding inside "Deep Clean" (Joni Schildgen's $62.40 window). Anchoring on
    // billed_amount (not base_fee) also keeps the total stable when a legacy
    // job's billed_amount is stale relative to base_fee + mods. With no
    // billed_amount, fall back to the base_fee − add-ons legacy path unchanged.
    const flatAnchor = billedNum > 0
      ? billedNum - modsTotal - addOnsSubtotal
      : parseFloat(String(job.base_fee ?? "0")) - addOnsSubtotal;
    scopeAmount = Math.max(0, Math.round(flatAnchor * 100) / 100);
    scopeQty = 1;
    scopeUnit = scopeAmount;
  }

  const lineItems: InvoiceLineItem[] = [
    { description: scopeDesc, quantity: scopeQty, unit_price: scopeUnit, total: scopeAmount, job_id: jobId },
  ];
  let runningTotal = scopeAmount;

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

  // Time & Fee Adjustments (flat AND time) as their own labeled lines — e.g.
  // "Unit 2001" or "Additional Time: 1 hour". Their dollars were subtracted from
  // the metered scope above, so this restores the exact same total while making
  // each adjustment (and its unit/reason) visible on the invoice.
  for (const m of mods) {
    const amt = parseFloat(String(m.amount ?? "0"));
    runningTotal += amt;
    const fallback = m.mod_type === "time" ? "Time adjustment" : "Fee adjustment";
    const label = (m.reason && String(m.reason).trim()) ? String(m.reason).trim() : fallback;
    lineItems.push({ description: label, quantity: 1, unit_price: amt, total: amt });
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
