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

/** Adjustment_type slug 2B writes to pay_adjustments. Distinct from
 *  any free-form "mileage" string an office user might type into a
 *  manual adjustment, so reports can join legs <-> adjustments by
 *  type cleanly. */
export const MILEAGE_REIMBURSEMENT_ADJUSTMENT_TYPE = "mileage_reimbursement";
