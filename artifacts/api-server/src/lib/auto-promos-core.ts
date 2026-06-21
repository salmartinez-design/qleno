// [auto-promos 2026-06-21] PURE promo logic — math + the rule selector. Kept in
// its own module with NO `@workspace/db` import so unit tests can import it
// without triggering the Drizzle connection init (same pattern as
// recurring-cadences.ts). The DB-backed helpers live in auto-promos.ts and
// re-export everything here.

export const SECOND_RECURRING = "second_recurring";
export const DEEP_CLEAN = "deep_clean";

export type ActivePromo = { kind: string; pct: number; label: string };

const r2 = (n: number) => Math.round(n * 100) / 100;

// Default labels when a tenant row doesn't set one. Kept here so the invoice
// reads cleanly regardless of how the auto_promos row was seeded.
export function defaultPromoLabel(kind: string, pct: number): string {
  const p = Number.isInteger(pct) ? String(pct) : pct.toFixed(2);
  if (kind === SECOND_RECURRING) return `Second Visit Promo (${p}% off)`;
  if (kind === DEEP_CLEAN) return `Deep Clean Promo (${p}% off)`;
  return `Promo (${p}% off)`;
}

// The job_discounts.code stamped for a kind — stable per kind so re-stamping is
// idempotent and the rows are easy to find/clean.
export function promoCode(kind: string): string {
  return `AUTO_${kind.toUpperCase()}`;
}

// Pure: dollars off for a percent against a base. Clamps junk to 0.
export function promoAmount(pct: number, base: number): number {
  if (!(pct > 0) || !(base > 0)) return 0;
  return r2((pct / 100) * base);
}

// Pure: pick the single applicable promo for a job context. NON-STACKING by
// design — a job gets at most ONE auto-promo (the highest-percent applicable
// one), so a 2nd-visit deep clean is 15% off, never 30%. Returns null when none
// apply.
export function selectAutoPromo(ctx: {
  serviceType: string | null;
  isSecondRecurringVisit: boolean;
  active: ActivePromo[];
}): ActivePromo | null {
  const applicable: ActivePromo[] = [];
  for (const p of ctx.active) {
    if (!(p.pct > 0)) continue;
    if (p.kind === DEEP_CLEAN && ctx.serviceType === "deep_clean") applicable.push(p);
    if (p.kind === SECOND_RECURRING && ctx.isSecondRecurringVisit) applicable.push(p);
  }
  if (!applicable.length) return null;
  applicable.sort((a, b) => b.pct - a.pct);
  return applicable[0];
}
