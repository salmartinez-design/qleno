/**
 * Cutover 2B — Mileage approval gate (pure logic).
 *
 * The 2B office workflow promotes mileage_legs from `computed` to
 * `applied` (via `reviewed`), or sidelines them as `discarded`. This
 * module owns the pure, DB-free pieces: lifecycle transition rules,
 * the carpool-candidate grouping, and the per-tech summary shape the
 * review screen renders.
 *
 * No money math lives here — amounts come straight off the leg row;
 * 2A already computed them in integer cents and persisted them as
 * numeric(10,2) strings. 2B never recomputes; it only promotes.
 *
 * Lifecycle (enforced by canTransition):
 *
 *   computed ── review ──► reviewed ── apply ──► applied
 *      │                       │
 *      └──── discard ──────────┴────► discarded
 *
 *   applied + discarded are TERMINAL. No re-open path. If an applied
 *   row needs to be unwound the operator removes the pay_adjustment
 *   via the existing 1E DELETE endpoint and explicitly creates a new
 *   leg (or recomputes the period). This keeps the audit trail clean
 *   — every "money moved" event corresponds to exactly one apply.
 */
export type MileageLegStatus = "computed" | "reviewed" | "applied" | "discarded";
export type MileageLegAction = "review" | "discard" | "apply";

/** Returns null when the transition is allowed; a human-readable
 *  refusal message otherwise. */
export function refusalForTransition(
  from: MileageLegStatus,
  action: MileageLegAction,
): string | null {
  if (from === "applied") return "Leg is already applied; reverse via the pay_adjustments delete flow.";
  if (from === "discarded") return "Leg is discarded; this state is terminal.";
  if (action === "review") {
    if (from === "computed") return null;
    return `Leg is ${from}, only computed legs can be marked reviewed.`;
  }
  if (action === "discard") {
    if (from === "computed" || from === "reviewed") return null;
    return `Leg is ${from}, only computed or reviewed legs can be discarded.`;
  }
  if (action === "apply") {
    if (from === "reviewed") return null;
    return `Leg is ${from}, only reviewed legs can be applied.`;
  }
  return `Unknown action: ${action}`;
}

/** Shape used by the carpool-grouping helper. Pulled out so unit
 *  tests can build minimal rows without dragging the full leg type. */
export type LegForCarpoolCheck = {
  id: number;
  user_id: number;
  leg_date: string; // YYYY-MM-DD
  from_job_id: number;
  to_job_id: number;
  status: MileageLegStatus;
};

/** One carpool candidate group: same calendar day, same from_job +
 *  to_job, multiple distinct techs. The office decides which leg to
 *  apply and which to discard — 2B never auto-resolves. */
export type CarpoolCandidate = {
  leg_date: string;
  from_job_id: number;
  to_job_id: number;
  legs: LegForCarpoolCheck[];
  /** Distinct tech count. > 1 by construction; helpers may display
   *  "3 techs sharing this leg" without recomputing. */
  tech_count: number;
};

/** Group `legs` into carpool candidates: same (date, from, to) with
 *  multiple distinct user_ids. ONLY pre-apply legs (computed or
 *  reviewed) are considered — applied + discarded rows are decided
 *  and should not pollute the queue.
 *
 *  Returns groups sorted by leg_date ascending for stable rendering. */
export function detectCarpoolCandidates(
  legs: ReadonlyArray<LegForCarpoolCheck>,
): CarpoolCandidate[] {
  const buckets = new Map<string, LegForCarpoolCheck[]>();
  for (const leg of legs) {
    if (leg.status !== "computed" && leg.status !== "reviewed") continue;
    const key = `${leg.leg_date}|${leg.from_job_id}|${leg.to_job_id}`;
    const arr = buckets.get(key) ?? [];
    arr.push(leg);
    buckets.set(key, arr);
  }
  const out: CarpoolCandidate[] = [];
  for (const [, arr] of buckets) {
    const distinctTechs = new Set(arr.map((l) => l.user_id));
    if (distinctTechs.size < 2) continue;
    out.push({
      leg_date: arr[0]!.leg_date,
      from_job_id: arr[0]!.from_job_id,
      to_job_id: arr[0]!.to_job_id,
      legs: arr,
      tech_count: distinctTechs.size,
    });
  }
  out.sort((a, b) => a.leg_date.localeCompare(b.leg_date));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// [shared-drive-split 2026-08-15] Splitting one drive between its riders
// ─────────────────────────────────────────────────────────────────────────────
//
// detectCarpoolCandidates finds the groups; this decides the money. The engine
// writes one leg per tech at the FULL amount, so a shared drive currently pays
// twice. Splitting rewrites each leg's amount to that tech's share.
//
// Cents, not floats — the shares must sum to the original to the penny or
// payroll drifts. base = floor(full / n) and the leftover pennies go to the
// first legs in id order, so a $7.29 drive between two techs is $3.65 + $3.64,
// never $3.645 twice.

/** Parse a numeric(10,2) string ("7.29") into integer cents. */
function toCents(amount: string): number {
  return Math.round(Number(amount) * 100);
}

/** Format integer cents back into a numeric(10,2) string. */
function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export type SplitShare = {
  leg_id: number;
  /** What the leg carried before the split — persisted to amount_before_split. */
  amount_before: string;
  /** This tech's share — persisted to amount. */
  amount_after: string;
};

export type SplitPlan = {
  /** The one drive's full cost, i.e. what the group SHOULD pay in total. */
  full_amount: string;
  /** What the group pays today, before the split (full × n). */
  current_total: string;
  shares: SplitShare[];
};

/**
 * Plan an even split of one shared drive across its legs.
 *
 * `legs` must be the full group — pass them in a stable order (id ascending);
 * the leftover pennies land on the front of the list, so the same input always
 * produces the same plan.
 *
 * The full cost is taken as the MAX leg amount rather than assuming they match.
 * They should all be identical (same distance, same day, so the same dated
 * rate), but if one differs the office should not be shorted by a low outlier.
 */
export function planEvenSplit(
  legs: ReadonlyArray<{ id: number; amount: string }>,
): SplitPlan {
  const n = legs.length;
  const fullCents = Math.max(...legs.map((l) => toCents(l.amount)));
  const base = Math.floor(fullCents / n);
  let leftover = fullCents - base * n;
  const shares: SplitShare[] = legs.map((leg) => {
    const extra = leftover > 0 ? 1 : 0;
    leftover -= extra;
    return {
      leg_id: leg.id,
      amount_before: leg.amount,
      amount_after: fromCents(base + extra),
    };
  });
  return {
    full_amount: fromCents(fullCents),
    current_total: fromCents(
      legs.reduce((sum, l) => sum + toCents(l.amount), 0),
    ),
    shares,
  };
}

/** Returns null when `legs` can be split as a group; a refusal message
 *  otherwise. Guards the things that make a split wrong rather than merely
 *  unusual: fewer than two legs, legs from different drives, legs whose money
 *  has already moved, and legs that are already split. */
export function refusalForSplit(
  legs: ReadonlyArray<{
    id: number;
    user_id: number;
    leg_date: string;
    from_job_id: number;
    to_job_id: number;
    status: MileageLegStatus;
    split_group_size: number | null;
  }>,
): string | null {
  if (legs.length < 2) return "A split needs at least two legs.";
  const first = legs[0]!;
  for (const leg of legs) {
    if (
      leg.leg_date !== first.leg_date ||
      leg.from_job_id !== first.from_job_id ||
      leg.to_job_id !== first.to_job_id
    ) {
      return "These legs are not the same drive — a split only applies to one drive on one day.";
    }
    if (leg.status === "applied") {
      return "One of these legs is already applied; reverse the pay adjustment before splitting.";
    }
    if (leg.status === "discarded") {
      return "One of these legs is discarded; remove it from the group before splitting.";
    }
    if (leg.split_group_size != null) {
      return "This drive is already split. Undo the split first if you want to redo it.";
    }
  }
  const distinctTechs = new Set(legs.map((l) => l.user_id));
  if (distinctTechs.size !== legs.length) {
    return "A tech appears twice in this group — that's a duplicate leg, not a shared drive.";
  }
  return null;
}

/** Returns null when `legs` can be un-split; a refusal message otherwise. */
export function refusalForUnsplit(
  legs: ReadonlyArray<{
    status: MileageLegStatus;
    split_group_size: number | null;
    amount_before_split: string | null;
  }>,
): string | null {
  if (legs.length === 0) return "No legs to undo.";
  for (const leg of legs) {
    if (leg.split_group_size == null || leg.amount_before_split == null) {
      return "This drive is not split.";
    }
    if (leg.status === "applied") {
      return "One of these legs is already applied; reverse the pay adjustment instead.";
    }
    if (leg.status === "discarded") {
      return "One of these legs is discarded; its amount is already out of pay.";
    }
  }
  return null;
}

/** Adjustment_type slug 2B writes to pay_adjustments. Distinct from
 *  any free-form "mileage" string an office user might type into a
 *  manual adjustment, so reports can join legs <-> adjustments by
 *  type cleanly. */
export const MILEAGE_REIMBURSEMENT_ADJUSTMENT_TYPE = "mileage_reimbursement";
