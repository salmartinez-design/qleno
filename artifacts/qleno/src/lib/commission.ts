/**
 * Commission calculation utility for Qleno.
 *
 * Rules:
 * - Residential commission rate: 35% of job total
 * - Before clock-in: split EQUALLY among assigned techs
 * - After any tech clocks in: split PROPORTIONALLY by actual minutes worked
 */

const COMMISSION_RATE = 0.35;

export interface ClockIn {
  techId: number;
  minutesWorked: number;
}

export interface CommissionSplit {
  totalCommission: number;
  commissionRate: number;
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
): CommissionSplit {
  const totalCommission = Math.round(jobTotal * COMMISSION_RATE * 100) / 100;

  // No techs assigned
  if (techCount === 0) {
    return {
      totalCommission,
      commissionRate: COMMISSION_RATE,
      perTech: [],
      mode: "unassigned",
    };
  }

  // Any tech has clocked in → proportional by actual minutes
  if (clockIns && clockIns.length > 0 && clockIns.some(c => c.minutesWorked > 0)) {
    const totalMinutes = clockIns.reduce((sum, c) => sum + c.minutesWorked, 0);
    return {
      totalCommission,
      commissionRate: COMMISSION_RATE,
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
    commissionRate: COMMISSION_RATE,
    perTech: Array.from({ length: techCount }, (_, i) => ({
      techId: null,
      hours: perTechHours,
      commission: perTechCommission,
    })),
    mode: "equal",
  };
}
