// [mileage-rate-editor 2026-08-17] Re-pricing computed-but-unpaid drive legs
// after a rate correction.
//
// Why this exists: a leg stores the rate it was priced at, at the moment it was
// computed. That is deliberate — it is what makes a past period reproducible.
// The cost is that fixing the rate afterwards does NOT reach the legs already
// sitting in the review queue; they would still pay out at the old number. The
// office would set the rate correctly, see the right figure on the settings
// screen, and still under-reimburse.
//
// The boundary that keeps this safe: ONLY legs still at `computed` are touched.
// A leg that has been reviewed, applied, or discarded is history — money has
// moved or a person has made a call — and history does not get rewritten by a
// settings change. That is the same "no money until reviewed" rule the whole
// mileage chain runs on, read from the other direction.
//
// Split legs are skipped rather than guessed at. An even split distributes
// leftover pennies across the whole group (planEvenSplit), so a leg cannot be
// correctly re-priced on its own — you would have to re-plan the group. Skipping
// and reporting the count is honest; silently mis-allocating a shared drive is
// not. Undo the split, re-price, re-split.
import { computeAmountCents } from "./mileage-compute.js";
import { pickMileageRateForDate, type MileageRateRowInput } from "./mileage-rate-lookup.js";

export type RepriceLegInput = {
  id: number;
  leg_date: string; // YYYY-MM-DD
  miles: string | number;
  rate_per_mile: string | number;
  amount: string | number;
  split_group_size: number | null;
};

export type RepriceChange = {
  leg_id: number;
  leg_date: string;
  miles: number;
  old_rate: number;
  new_rate: number;
  old_amount: number;
  new_amount: number;
};

export type RepricePlan = {
  changes: RepriceChange[];
  /** Legs left alone, by reason. Surfaced so nothing is dropped in silence. */
  skipped: { already_correct: number; split: number; no_rate: number };
  totals: { old_amount: number; new_amount: number; delta: number; miles: number };
};

const toNum = (v: string | number) => (typeof v === "number" ? v : Number(v));
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Work out what a rate change does to the unpaid queue.
 *
 * `legs` must already be filtered to status='computed' for one company; this
 * function does not re-check status because it never sees it. `rates` is that
 * company's full dated rate history INCLUDING the row being added, so a dry run
 * and the real write plan from exactly the same input.
 */
export function planReprice(
  legs: ReadonlyArray<RepriceLegInput>,
  rates: ReadonlyArray<MileageRateRowInput>,
): RepricePlan {
  const changes: RepriceChange[] = [];
  const skipped = { already_correct: 0, split: 0, no_rate: 0 };
  let oldTotal = 0;
  let newTotal = 0;
  let miles = 0;

  for (const leg of legs) {
    if (leg.split_group_size != null) {
      skipped.split += 1;
      continue;
    }
    const newRate = pickMileageRateForDate(rates as MileageRateRowInput[], leg.leg_date);
    if (newRate == null) {
      // No row covers this date. Leave the leg exactly as it is rather than
      // zeroing it — the same rule mileage-compute follows.
      skipped.no_rate += 1;
      continue;
    }
    const legMiles = toNum(leg.miles);
    const oldRate = toNum(leg.rate_per_mile);
    const oldAmount = round2(toNum(leg.amount));
    const newAmount = round2(computeAmountCents(legMiles, newRate) / 100);
    if (newRate === oldRate && newAmount === oldAmount) {
      skipped.already_correct += 1;
      continue;
    }
    changes.push({
      leg_id: leg.id,
      leg_date: leg.leg_date,
      miles: legMiles,
      old_rate: oldRate,
      new_rate: newRate,
      old_amount: oldAmount,
      new_amount: newAmount,
    });
    oldTotal += oldAmount;
    newTotal += newAmount;
    miles += legMiles;
  }

  return {
    changes,
    skipped,
    totals: {
      old_amount: round2(oldTotal),
      new_amount: round2(newTotal),
      delta: round2(newTotal - oldTotal),
      miles: round2(miles),
    },
  };
}
