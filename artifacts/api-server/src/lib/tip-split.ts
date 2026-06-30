/**
 * Tip allocation — split a single tip total across the techs on one job.
 *
 * Mirrors the commission minute-split basis (commission-paytype.ts): a tip is
 * apportioned by each tech's ACTUAL clocked hours on the job, so the tech who
 * spent more time on site gets the larger share, exactly as commission already
 * does. A tip is a pass-through to the tech — it never touches commission math.
 *
 * Pure + DB-free so the API endpoint and the tests share one source of truth.
 * Works in integer cents (no float drift); the leftover cent(s) from an
 * uneven divide go to the "anchor" tech (most hours, tiebreak primary, then
 * first listed) so no cents are ever lost.
 *
 * Edge cases (locked decision):
 *   - total <= 0 or no techs            → [] (nothing to allocate)
 *   - at least one tech clocked time    → proportional to clocked hours;
 *                                          techs with 0 hours get $0 (they
 *                                          weren't on site — same as commission).
 *                                          The UI still lists them at $0 so the
 *                                          office can hand-edit a share to them.
 *   - NObody clocked any time           → even split across all techs.
 */

export interface TipSplitTech {
  user_id: number;
  is_primary: boolean;
  /** Clocked hours on this job (punched, clocked-out pairs). 0 if none. */
  hours: number;
}

export interface TipAllocation {
  user_id: number;
  amount: number; // dollars, 2dp
}

export function computeTipSplit(
  totalDollars: number | string,
  techs: ReadonlyArray<TipSplitTech>,
): TipAllocation[] {
  const totalCents = Math.round((Number(totalDollars) || 0) * 100);
  if (totalCents <= 0 || techs.length === 0) return [];

  const hoursOf = (t: TipSplitTech) => Math.max(0, Number(t.hours) || 0);
  const clockedTotal = techs.reduce((s, t) => s + hoursOf(t), 0);
  const proportional = clockedTotal > 0;

  // Recipients: when anyone clocked, only the techs who did (their hours are
  // the weights). When nobody clocked, everyone shares evenly (weight 1 each).
  const recipients = proportional ? techs.filter((t) => hoursOf(t) > 0) : [...techs];
  const weightOf = (t: TipSplitTech) => (proportional ? hoursOf(t) : 1);
  const totalWeight = recipients.reduce((s, t) => s + weightOf(t), 0);
  if (totalWeight <= 0) return [];

  // Floor each share to whole cents; track what's allocated so the rounding
  // remainder can be handed to the anchor tech.
  let allocated = 0;
  const cents = recipients.map((t) => {
    const c = Math.floor((totalCents * weightOf(t)) / totalWeight);
    allocated += c;
    return c;
  });

  // Anchor = most hours, tiebreak primary, tiebreak first in list.
  let anchorIdx = 0;
  for (let i = 1; i < recipients.length; i++) {
    const a = recipients[anchorIdx];
    const b = recipients[i];
    if (
      hoursOf(b) > hoursOf(a) ||
      (hoursOf(b) === hoursOf(a) && b.is_primary && !a.is_primary)
    ) {
      anchorIdx = i;
    }
  }
  cents[anchorIdx] += totalCents - allocated; // remainder → anchor

  return recipients
    .map((t, i) => ({ user_id: t.user_id, amount: cents[i] / 100 }))
    .filter((a) => a.amount > 0);
}
