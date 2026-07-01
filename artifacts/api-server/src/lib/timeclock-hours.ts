/**
 * [punch-union 2026-07-01] Clocked-hours-per-(job, tech), counting the UNION of
 * a cleaner's punch intervals — NOT the raw sum.
 *
 * Why: the fee split weights by clocked minutes summed per (job, tech). A
 * duplicate/overlapping punch (a field-app double-tap, or a manual office punch
 * on top of a field punch) was double-counting the cleaner's minutes and
 * skewing the split (Juliana got ⅔ of a shared job, Norma ⅓, instead of 50/50).
 * The office can't even see the duplicate — the Time Clocks grid collapses every
 * entry for a (job, tech) into one row — so it silently poisons payroll.
 *
 * Union semantics fix it at the source of the math, regardless of how the
 * duplicate got there:
 *   - Two OVERLAPPING punches (08:04–09:24 twice) → counted once (~80 min).
 *   - Two DISJOINT punches (a real split shift: 08–10, then 13–15) → summed, as
 *     they should be.
 */

export interface ClockInterval {
  job_id: number | string;
  user_id: number | string;
  clock_in_at: string | Date | null;
  clock_out_at: string | Date | null;
}

/**
 * Returns a map keyed "job_id:user_id" → total clocked hours = the union of that
 * tech's punch intervals on that job. Open/invalid intervals are skipped.
 */
export function unionHoursByKey(rows: ReadonlyArray<ClockInterval>): Map<string, number> {
  const byKey = new Map<string, Array<[number, number]>>();
  for (const r of rows) {
    if (!r.clock_in_at || !r.clock_out_at) continue;
    const start = new Date(r.clock_in_at as any).getTime();
    const end = new Date(r.clock_out_at as any).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const k = `${Number(r.job_id)}:${Number(r.user_id)}`;
    const arr = byKey.get(k);
    if (arr) arr.push([start, end]);
    else byKey.set(k, [[start, end]]);
  }

  const out = new Map<string, number>();
  for (const [k, ivs] of byKey) {
    ivs.sort((a, b) => a[0] - b[0]);
    let totalMs = 0;
    let curStart = ivs[0][0];
    let curEnd = ivs[0][1];
    for (let i = 1; i < ivs.length; i++) {
      const [s, e] = ivs[i];
      if (s > curEnd) {
        totalMs += curEnd - curStart; // gap → close the current span
        curStart = s;
        curEnd = e;
      } else if (e > curEnd) {
        curEnd = e; // overlap → extend
      }
    }
    totalMs += curEnd - curStart;
    out.set(k, totalMs / 3_600_000);
  }
  return out;
}
