/**
 * Commission calculation utility for Qleno.
 *
 * Rules:
 * - Residential — Standard: 35% of job total. Pre-clock-in split
 *   EQUALLY among assigned techs; post-clock-in split PROPORTIONALLY
 *   by actual minutes.
 * - Residential — Deep Clean / Move In-Out: 32% of job total. Phes
 *   raised pricing to $80/hr to client on those scopes; tech share
 *   adjusts to keep margins stable. Same split structure as standard.
 *   Pass `serviceType: "deep_clean" | "move_in" | "move_out"` to opt
 *   into the 32% tier.
 * - [AI.7.4] Commercial: hourly rate × hours (default $20/hr). Same
 *   split structure as residential, but the base is hourly-rate × hours,
 *   NOT a fraction of jobTotal. Routing is on the caller — pass
 *   `basis: "commercial"` for commercial scopes.
 */

const RESIDENTIAL_STANDARD_RATE = 0.35;
const RESIDENTIAL_DEEP_MOVE_RATE = 0.32;
const COMMERCIAL_HOURLY_RATE = 20;
const DEEP_OR_MOVE_TYPES = new Set(["deep_clean", "move_in", "move_out"]);

/**
 * Pick the right residential commission rate for a service_type slug
 * OR a human-readable scope name. Quote-builder works with names
 * (e.g. "Deep Clean"); the dispatch + payroll APIs work with the
 * jobs.service_type enum slugs (e.g. "deep_clean", "move_in").
 * Both paths land here.
 *
 * Caller should NOT use this for commercial scopes — pass
 * `basis: "commercial"` to calculateCommissionSplit instead.
 */
export function getResidentialRate(serviceTypeOrName?: string): number {
  if (!serviceTypeOrName) return RESIDENTIAL_STANDARD_RATE;
  const t = serviceTypeOrName.toLowerCase();
  if (DEEP_OR_MOVE_TYPES.has(t)) return RESIDENTIAL_DEEP_MOVE_RATE;
  // Name-pattern fallback for quote-builder (which has no slug).
  if (/\bdeep\s*clean\b/.test(t)) return RESIDENTIAL_DEEP_MOVE_RATE;
  if (/\bmove[-\s]?(in|out)\b/.test(t)) return RESIDENTIAL_DEEP_MOVE_RATE;
  return RESIDENTIAL_STANDARD_RATE;
}

export interface ClockIn {
  techId: number;
  minutesWorked: number;
}

export type CommissionBasis = "residential" | "commercial";

export interface CommissionSplit {
  totalCommission: number;
  /** Residential pool fraction (e.g. 0.35) when basis='residential', else null. */
  commissionRate: number | null;
  /** Commercial hourly rate ($/hr) when basis='commercial', else null. */
  commercialHourlyRate: number | null;
  basis: CommissionBasis;
  perTech: {
    techId: number | null;
    hours: number;
    commission: number;
  }[];
  mode: "equal" | "proportional" | "unassigned";
}

export function calculateCommissionSplit(
  jobTotal: number,
  estimatedHours: number,
  techCount: number,
  clockIns?: ClockIn[],
  basis: CommissionBasis = "residential",
  serviceType?: string,
): CommissionSplit {
  // [tiered-residential] Residential rate is now scope-dependent: 32%
  // for deep_clean / move_in / move_out, 35% for everything else
  // (standard, recurring, etc). Commercial is unaffected.
  const residentialRate = getResidentialRate(serviceType);
  const totalCommission = basis === "commercial"
    ? Math.round(COMMERCIAL_HOURLY_RATE * estimatedHours * 100) / 100
    : Math.round(jobTotal * residentialRate * 100) / 100;
  const commissionRate = basis === "residential" ? residentialRate : null;
  const commercialHourlyRate = basis === "commercial" ? COMMERCIAL_HOURLY_RATE : null;

  // No techs assigned
  if (techCount === 0) {
    return {
      totalCommission,
      commissionRate,
      commercialHourlyRate,
      basis,
      perTech: [],
      mode: "unassigned",
    };
  }

  // Any tech has clocked in → proportional by actual minutes
  if (clockIns && clockIns.length > 0 && clockIns.some(c => c.minutesWorked > 0)) {
    const totalMinutes = clockIns.reduce((sum, c) => sum + c.minutesWorked, 0);
    return {
      totalCommission,
      commissionRate,
      commercialHourlyRate,
      basis,
      perTech: clockIns.map(c => ({
        techId: c.techId,
        hours: Math.round((c.minutesWorked / 60) * 100) / 100,
        commission: totalMinutes > 0
          ? Math.round((c.minutesWorked / totalMinutes) * totalCommission * 100) / 100
          : 0,
      })),
      mode: "proportional",
    };
  }

  // Pre-clock-in → equal split
  const perTechHours = Math.round((estimatedHours / techCount) * 100) / 100;
  const perTechCommission = Math.round((totalCommission / techCount) * 100) / 100;

  return {
    totalCommission,
    commissionRate,
    commercialHourlyRate,
    basis,
    perTech: Array.from({ length: techCount }, (_, i) => ({
      techId: null,
      hours: perTechHours,
      commission: perTechCommission,
    })),
    mode: "equal",
  };
}
