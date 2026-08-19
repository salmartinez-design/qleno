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

// [rebuild-context 2026-08-18] Callers that are REBUILDING an existing document
// pass its current total. Callers that are CREATING one pass nothing. The
// distinction matters exactly once, at the zero-price-drop guard below: a fresh
// $0 line is a bug worth correcting, while a $0 line on a document that already
// totals $0 is far more likely to be a deliberate zero the office typed in, and
// "correcting" it re-bills a customer who was told the visit was free.
export type BuildLineItemsOpts = { existingTotal?: number | null };

export async function buildJobLineItems(
  companyId: number,
  jobId: number,
  exec: any = db,
  opts?: BuildLineItemsOpts,
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

  // [cancel-fee-invoice 2026-08-13] A charged cancellation or lockout bills a
  // FEE, not a cleaning. The visit sets status='complete' with billed_amount =
  // the fee (so revenue reports pick it up), which means every rule below would
  // otherwise describe it by service_type — a customer who locked the crew out
  // would receive an invoice reading "Commercial Cleaning $60" for a clean that
  // never happened. That is a dispute waiting to happen, and it is not what the
  // office agreed to charge for.
  //
  // So: one line, named for what actually happened, and nothing else. No
  // add-ons and no discounts — nobody entered the house, so there is no parking
  // to bill and no promo to apply. billed_amount IS the agreed fee (the policy
  // engine already applied the pct/flat rules and any waiver), so it is used
  // verbatim rather than recomputed here.
  const cancelRow = (await exec.execute(sql`
    SELECT cancel_action
      FROM cancellation_log
     WHERE job_id = ${jobId} AND company_id = ${companyId}
       AND cancel_action IN ('cancel','lockout')
     ORDER BY id DESC
     LIMIT 1
  `)).rows?.[0] as { cancel_action: string } | undefined;
  if (cancelRow) {
    const feeAmount = parseFloat(String(job.billed_amount ?? "0"));
    // A fully-waived fee produces no invoice at all — there is nothing to bill.
    if (!(feeAmount > 0)) return null;
    const label = cancelRow.cancel_action === "lockout" ? "Lockout fee" : "Cancellation fee";
    return {
      lineItems: [{ description: label, quantity: 1, unit_price: feeAmount, total: feeAmount, job_id: jobId }],
      subtotal: feeAmount,
    };
  }

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
    SELECT reason, amount, mod_type, minutes
      FROM job_rate_mods
     WHERE job_id = ${jobId} AND company_id = ${companyId}
     ORDER BY created_at ASC
  `);
  const mods = (modRows.rows as Array<{ reason: string | null; amount: string; mod_type: string; minutes: number | null }>);
  const modsTotal = mods.reduce((s, m) => s + parseFloat(String(m.amount ?? "0")), 0);
  // Minutes that a 'time' mod already pushed INTO allowed_hours (adjustAllowedHours).
  const timeModMinutes = mods.reduce(
    (s, m) => s + (m.mod_type === "time" ? Number(m.minutes ?? 0) : 0),
    0,
  );

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
  // [hourly-invoice-itemize 2026-08-13] Fetched unconditionally now — the metered
  // branch needs the add-on total to decide whether it can safely itemize.
  const allAddons: Array<{ name: string | null; quantity: number | null; unit_price: string | null; subtotal: string | null }> =
    await exec
      .select({
        name: addOnsTable.name,
        quantity: jobAddOnsTable.quantity,
        unit_price: jobAddOnsTable.unit_price,
        subtotal: jobAddOnsTable.subtotal,
      })
      .from(jobAddOnsTable)
      .leftJoin(addOnsTable, eq(jobAddOnsTable.add_on_id, addOnsTable.id))
      .where(eq(jobAddOnsTable.job_id, jobId));
  const allAddOnsSubtotal = allAddons.reduce((s, a) => s + parseFloat(String(a.subtotal ?? "0")), 0);

  // [hourly-invoice-itemize 2026-08-13] Francisco, on PPM turnover #20571: "Why
  // is it correct in the breakdown of the jobcard but not on the actual invoice?"
  //
  // The job card reads $50/hr × 3.5h = $175 plus Parking $20 = $195. The invoice
  // read ONE line — "Ppm Turnover · qty 1 × $50.00 = $195.00" — with no parking
  // on it at all. Same total, but a line that cannot survive being read: 1 × $50
  // is not $195, and the customer is billed $20 for parking the document never
  // mentions.
  //
  // Cause: a commercial hourly job is "metered", and that branch prints
  // billed_amount verbatim with qty = billed_hours (usually null → 1) and unit =
  // the hourly rate. Those three numbers were never required to agree. Add-ons
  // were then deliberately withheld because the metered total already contains
  // them.
  //
  // But billed_amount for a commercial job IS rate×hours + flat mods + add-ons
  // (recomputeJobBilledAmount), so the parts are recoverable: bill LABOR as
  // hours × rate and let the add-ons be their own lines — exactly what the job
  // card and the isHourlyRateDriven branch below already do.
  //
  // Guarded on the arithmetic reconciling to the penny. Where a job's
  // billed_amount has drifted from rate×hours + mods + add-ons (manual override,
  // legacy row), splitting it would silently change what the customer owes, so
  // those fall through to the existing behavior untouched. This can make an
  // invoice clearer; it can never make it a different total.
  // [time-mod-doublecount 2026-08-15] The scope line bills the hours that are
  // NOT already itemized as a time adjustment below. A "+30 min · $25" mod grew
  // allowed_hours to 3.5, so rate×3.5 = $175 ALREADY contains that $25; printing
  // the $25 again as its own line (which the mods loop does, and should) made
  // the parts sum to $25 more than the invoice total. The reconciliation check
  // then failed, add-ons were withheld, and the parking fee vanished from the
  // document while still being charged inside the service line. That is what
  // Maribel has been reporting every time a parking fee is on the job — the fee
  // itself was never the trigger, it was just the line that disappeared.
  //
  // Billing the base hours instead makes the decomposition EXACT, not merely
  // within a tolerance:
  //   rate×baseHours + all mods + add-ons
  //     = rate×allowed_hours − rate×(time minutes) + time mods + flat mods + add-ons
  //     = billed_amount   (recomputeJobBilledAmount's commercial formula)
  //
  // Only allowed_hours carries the added minutes — adjustAllowedHours writes
  // that column alone. A clock-metered job (billed_hours set) reports the hours
  // the crew actually stood in the house, which no adjustment inflates, so its
  // hours are billed as-is.
  const hoursIncludeTimeMods = !job.billed_hours;
  const laborHours = hoursIncludeTimeMods
    ? Math.max(0, Math.round((hoursNum - timeModMinutes / 60) * 100) / 100)
    : hoursNum;
  const laborAmount = Math.round(laborHours * rateNum * 100) / 100;
  const meteredItemizable = isMetered
    && rateNum > 0 && laborHours > 0
    && Math.abs(laborAmount + allAddOnsSubtotal + modsTotal - billedNum) < 0.011;

  const addons = (!isMetered || meteredItemizable) ? allAddons : [];
  const addOnsSubtotal = addons.reduce((s, a) => s + parseFloat(String(a.subtotal ?? "0")), 0);

  let scopeQty: number, scopeUnit: number, scopeAmount: number;
  if (meteredItemizable) {
    // Labor only, at the hours not already covered by a time adjustment. Add-ons
    // and mods are their own lines below, and the three together land back
    // exactly on billed_amount.
    scopeQty = laborHours;
    scopeUnit = rateNum;
    scopeAmount = laborAmount;
  } else if (isMetered) {
    // Pull flat mods back out of the metered total — they get their own lines
    // below, so leaving them in the scope would double-count.
    scopeAmount = parseFloat(String(job.billed_amount)) - modsTotal;
    // [unreadable-line 2026-08-14] This is the branch a job lands in when its
    // billed_amount has DRIFTED from rate×hours + mods + add-ons, so the total
    // cannot be safely split (see meteredItemizable above). Holding the total
    // steady is right. Printing `qty 1 · unit $50.00 · $170.00` was not — three
    // numbers that do not multiply, on a document the customer reads. Maribel,
    // verbatim: "the math on the invoices doesn't make sense: says 1 x $50 =
    // $170."
    //
    // The rate is only meaningful as a unit price when it actually meters the
    // amount. When it doesn't, quote the line as a single priced item: qty 1 ×
    // the amount. Same dollars, and the arithmetic on the page holds.
    const meteredQty = job.billed_hours ? parseFloat(String(job.billed_hours)) : 1;
    const reconciles = rateNum > 0
      && Math.abs(meteredQty * rateNum - scopeAmount) < 0.011;
    scopeQty = reconciles ? meteredQty : 1;
    scopeUnit = reconciles ? rateNum : scopeAmount;
  } else if (isHourlyRateDriven) {
    // Same time-mod carve-out as the metered branch: the adjustment is printed
    // as its own line below, so its hours must not also be inside this one.
    scopeQty = laborHours;
    scopeUnit = rateNum;
    scopeAmount = laborAmount;   // labor only
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

  // [zero-price-drop 2026-08-18] A job that carries a real price must never
  // print a $0 service line.
  //
  // recomputeJobBilledAmount stamps billed_amount on EVERY job, so a job whose
  // billed_amount is literally 0 still has it SET — and `isMetered` above reads
  // the string "0.00" as truthy, which routes that job down the metered branch.
  // That branch prints billed_amount verbatim (minus mods) with no fallback, so
  // the price on the job never reaches the document. Walter Nunchuck's $195
  // clean (job 5958, base_fee $195, billed_amount 0) invoiced on 2026-07-04 as
  // one line reading "Standard Clean · $0.00", and the invoice was then marked
  // paid. The work was done, the customer was never billed for it, and no
  // screen anywhere said so — it only surfaced in a hand audit six weeks later.
  //
  // base_fee is the job's own record of what the work is worth, so it is the
  // right recovery anchor: subtract the add-ons that are itemized separately
  // (the same arithmetic the flat branch already uses) and bill that. A job
  // that really is free has base_fee 0 too, so this can never invent a price
  // nobody agreed to. Logged rather than silent so the upstream cause stays
  // findable.
  //
  // Deliberately left as a floor rather than a re-classification: the
  // [flat-addon-itemize 2026-07-11] guard above scoped itself to positive
  // billed_amount on purpose, and widening it would move totals on jobs that
  // are billing correctly today. This moves a total only when it is $0 and the
  // job says it should not be.
  //
  // [zero-price-drop CORRECTION 2026-08-18] The original note here claimed "a
  // job zeroed by a credit or a discount keeps a POSITIVE scope with the
  // offsetting line below it — that case does not reach here." That is FALSE,
  // and the mistake was mine. A comped clean is typed straight onto the
  // invoice: the discount lands in invoices.line_items as hand-entered JSON and
  // NOTHING is written to job_discounts. So on a rebuild, modsTotal is 0,
  // billed_amount is "0.00", the metered branch computes scope 0 - 0 = 0, this
  // guard sees base_fee $180 and recovers it, and no discount line comes back
  // to offset it. Michael Baffoe's free clean (job 8657, invoice 7402) would
  // have rebuilt as a $180 bill to a customer who was told it was free. That is
  // a worse failure than the silent $0 this guard exists to prevent: under-
  // billing costs the company money, over-billing costs the customer's trust.
  //
  // So the guard only fires when the document does not already state a zero.
  // Creating an invoice: recover, because a fresh $0 line is the Walter bug.
  // Rebuilding one that already totals $0: leave it alone and log, because the
  // office put that zero there on purpose and it is not this function's place
  // to overrule it. See the [rebuild-context 2026-08-18] note on the signature.
  // Read the job's discounts here rather than at their render loop below: the
  // guard needs to know whether the job can explain a zero on its own.
  const jobDisc = await exec.select().from(jobDiscountsTable)
    .where(and(eq(jobDiscountsTable.job_id, jobId), eq(jobDiscountsTable.company_id, companyId)));
  const jobDiscountTotal = jobDisc.reduce(
    (s: number, d: any) => s + parseFloat(String(d.amount ?? "0")),
    0,
  );

  const baseFeeNum = parseFloat(String(job.base_fee ?? "0"));
  if (scopeAmount <= 0 && baseFeeNum > 0) {
    // Suppression is only for a zero the job CANNOT account for. Once the comp
    // is a job_discounts row (mirrorInvoiceDiscountToJob below), the job explains
    // itself: the scope line is restored to the real price and the discount line
    // takes it back off, which is both the honest document and the same total.
    // Suppressing in that case would print "Standard Clean $0.00" above
    // "Discount -$180.00", which nets correctly but reads as nonsense.
    const documentAlreadyZero = opts?.existingTotal != null
      && opts.existingTotal <= 0
      && jobDiscountTotal <= 0;
    const recovered = Math.max(0, Math.round((baseFeeNum - addOnsSubtotal) * 100) / 100);
    if (documentAlreadyZero) {
      console.warn(
        `[invoice-line-items] job ${jobId}: scope computed $${scopeAmount.toFixed(2)} and base_fee is `
        + `$${baseFeeNum.toFixed(2)}, but the invoice being rebuilt already totals `
        + `$${Number(opts?.existingTotal ?? 0).toFixed(2)}; leaving the zero alone rather than re-billing `
        + `$${recovered.toFixed(2)} (a comp or zero week explains it)`,
      );
    } else if (recovered > 0) {
      console.warn(
        `[invoice-line-items] job ${jobId}: scope computed $${scopeAmount.toFixed(2)} but base_fee is `
        + `$${baseFeeNum.toFixed(2)}; recovered scope to $${recovered.toFixed(2)} so the price is not dropped`,
      );
      scopeAmount = recovered;
      scopeQty = 1;
      scopeUnit = recovered;
    }
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

  for (const d of jobDisc) {
    const amt = parseFloat(String(d.amount));
    runningTotal -= amt;
    // Auto-promo rows (code AUTO_*) carry a human label in `reason` — show that
    // alone so the invoice reads "Deep Clean Promo (15% off)", not the internal
    // AUTO_ code. Other discounts keep the existing code/percent labeling.
    // [invoice-edit-mirror 2026-08-18] INVOICE_EDIT rows carry the office's own
    // wording in `reason` (see mirrorInvoiceDiscountToJob below) — print it
    // verbatim, same as an auto-promo, so a comp reads back exactly as it was
    // typed instead of being re-wrapped in a second "Discount — " prefix every
    // time the document is rebuilt.
    const isAuto = typeof d.code === "string" && (d.code.startsWith("AUTO_") || d.code === INVOICE_EDIT_DISCOUNT_CODE);
    const label = isAuto && d.reason
      ? String(d.reason)
      : `Discount${d.code ? ` ${d.code}` : (d.type === "percent" ? ` ${parseFloat(String(d.value))}%` : "")}${d.reason && d.reason !== d.code ? ` — ${d.reason}` : ""}`;
    lineItems.push({ description: label, quantity: 1, unit_price: -amt, total: -amt });
  }

  const subtotal = Math.max(0, Math.round(runningTotal * 100) / 100);

  // [unreadable-line 2026-08-14] Last line of defence: an invoice is a document
  // a customer reads and checks. Every line on it must survive being multiplied
  // out. Any line whose qty × unit does not equal its own total collapses to a
  // single priced item — same dollars, arithmetic intact — and is logged so the
  // upstream cause is findable rather than merely papered over.
  //
  // This is deliberately a normalization, not a throw. A malformed line should
  // never block an invoice from being produced; it should just stop being
  // printed in a form that reads as a mistake to the customer.
  for (const li of lineItems) {
    const product = Math.round(li.quantity * li.unit_price * 100) / 100;
    const stated = Math.round(li.total * 100) / 100;
    if (Math.abs(product - stated) >= 0.011) {
      console.warn(
        `[invoice-line-items] job ${jobId}: "${li.description}" had ${li.quantity} × ${li.unit_price} = ${product} but stated ${stated}; collapsed to 1 × ${stated}`,
      );
      li.quantity = 1;
      li.unit_price = stated;
    }
  }

  return { lineItems, subtotal };
}

// ── Mirroring a hand-typed discount back onto the job ────────────────────────
//
// [invoice-edit-mirror 2026-08-18] Why this exists.
//
// The office comps a clean by typing a negative line straight onto the invoice:
// "$180 Standard Clean" and "-$180 Discount". That reads correctly and the
// customer is told it is free. But the comp lived ONLY in invoices.line_items,
// as hand-entered JSON — nothing was ever written against the job. The job kept
// its $180 price, and the two documents disagreed with no way to tell which was
// right.
//
// That disagreement is only survivable while the invoice is never rebuilt. The
// moment it is — a job edit re-syncs it, the office presses Recalc from Job —
// the builder above reads the job, sees $180 and no discount anywhere in
// job_discounts, and prints a $180 bill. The comp is gone and the customer who
// was told the visit was free gets charged for it. Michael Baffoe's invoice
// 7402 is exactly this shape and was one rebuild away from it.
//
// The [always-mirror 2026-07-24] rule is not the problem and is not being
// weakened: job pricing IS the source of truth, and job edits SHOULD flow to the
// unpaid invoice in real time. The problem was that a comp is a pricing fact
// that was never allowed to reach the job. So put it there. Once the discount
// is a job_discounts row, "the invoice mirrors the job" and "the comp survives"
// stop being in tension — the rebuild reproduces the comp because the job now
// knows about it.
//
// How the amount is decided: rebuild the job's lines with the previous mirror
// row removed, and compare how much discount the invoice shows against how much
// the job can already account for on its own. The difference is what would be
// lost, and only that difference is written. Matching by label was the obvious
// alternative and it is worse — an auto-promo whose wording drifts by a
// character would be mirrored a second time and quietly double the discount.
// Comparing totals cannot double-count.
export const INVOICE_EDIT_DISCOUNT_CODE = "INVOICE_EDIT";

export async function mirrorInvoiceDiscountToJob(opts: {
  companyId: number;
  jobId: number;
  invoiceLineItems: InvoiceLineItem[];
  userId?: number | null;
  exec?: any;
}): Promise<{ mirrored: number }> {
  const { companyId, jobId, invoiceLineItems, userId = null, exec = db } = opts;

  const negLines = invoiceLineItems.filter((li) => Number(li.total) < 0);
  const invoiceDiscount = Math.round(
    negLines.reduce((s, li) => s - Number(li.total), 0) * 100,
  ) / 100;

  return await exec.transaction(async (tx: any) => {
    // Clear the previous mirror FIRST so the rebuild below sees the job exactly
    // as it stands without our own bookkeeping, and the comparison stays a
    // comparison rather than an echo. This is what makes repeated saves
    // idempotent: the same edit saved twice writes the same single row.
    await tx.delete(jobDiscountsTable).where(and(
      eq(jobDiscountsTable.job_id, jobId),
      eq(jobDiscountsTable.company_id, companyId),
      eq(jobDiscountsTable.code, INVOICE_EDIT_DISCOUNT_CODE),
    ));

    const built = await buildJobLineItems(companyId, jobId, tx);
    if (!built) return { mirrored: 0 };
    const builtDiscount = Math.round(
      built.lineItems.filter((li) => li.total < 0).reduce((s, li) => s - li.total, 0) * 100,
    ) / 100;

    const delta = Math.round((invoiceDiscount - builtDiscount) * 100) / 100;
    if (delta < 0.01) {
      // Either the job already explains every discount on the invoice (nothing
      // to do), or the invoice shows LESS discount than the job carries. The
      // second case is left alone on purpose: removing a discount is a decision
      // about the job's price, and an invoice screen is not where job pricing
      // gets deleted. Logged so it is findable if it ever turns out to matter.
      if (delta <= -0.01) {
        console.warn(
          `[invoice-edit-mirror] job ${jobId}: invoice shows $${invoiceDiscount.toFixed(2)} of discount but the `
          + `job carries $${builtDiscount.toFixed(2)}; leaving the job's discounts alone (remove them on the job)`,
        );
      }
      return { mirrored: 0 };
    }

    // One un-mirrored line keeps its own wording, which is what the office typed
    // and what the customer already read. Several collapse to a neutral label —
    // guessing which of them the leftover dollars belong to would put words on a
    // customer's bill that nobody wrote.
    const label = negLines.length === 1
      ? String(negLines[0].description || "Discount").slice(0, 200)
      : "Invoice adjustment";

    await tx.insert(jobDiscountsTable).values({
      company_id: companyId,
      job_id: jobId,
      code: INVOICE_EDIT_DISCOUNT_CODE,
      type: "flat",
      value: delta.toFixed(2),
      amount: delta.toFixed(2),
      reason: label,
      applied_by: userId,
    });

    console.warn(
      `[invoice-edit-mirror] job ${jobId}: recorded $${delta.toFixed(2)} ("${label}") on the job so a rebuild `
      + `reproduces it instead of re-billing the customer`,
    );
    return { mirrored: delta };
  });
}
