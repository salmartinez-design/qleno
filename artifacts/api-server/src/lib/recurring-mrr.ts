// [recurring-revenue 2026-07-12] MRR math for the native recurring-revenue
// engine. MRR = rate × monthly_multiplier, per cadence. `custom` and `weekdays`
// have NO deterministic multiplier — MRR is NOT COMPUTABLE for them, and a $0/
// missing rate is likewise not computable. Every non-computable case returns an
// explicit reason so Data Health can SHOW it, never silently drop it.

export const CADENCE_MULTIPLIERS: Record<string, number | null> = {
  weekly: 4.333,
  biweekly: 2.167,
  every_3_weeks: 1.444,
  every_6_weeks: 0.722,
  every_8_weeks: 0.542,
  semi_monthly: 2.0,
  monthly: 1.0,
  custom: null,   // NOT COMPUTABLE — flag + exclude + show
  weekdays: null, // NOT COMPUTABLE — flag + exclude + show
};

export const KNOWN_CADENCES = Object.keys(CADENCE_MULTIPLIERS);

export type MrrResult = {
  multiplier: number | null;
  mrr: number | null;         // null => not computable (never treat as $0)
  computable: boolean;
  reason: string | null;      // why it's not computable, for Data Health
};

// [custom-interval-recovery 2026-07-12] A 'custom' or 'weekdays' cadence has no
// fixed multiplier on its own — BUT Qleno stores custom_frequency_weeks ("every
// N weeks") on the schedule. When that's present, the schedule IS computable:
// monthly multiplier = 4.333 / N (52 weeks/yr ÷ 12 months ÷ N). Pass customWeeks
// to recover those instead of writing them off. Only a truly interval-less
// custom stays non-computable.
export function computeMrr(cadence: string | null | undefined, rate: unknown, customWeeks?: number | null): MrrResult {
  const c = String(cadence ?? "").trim();
  let mult: number | null;
  if (c in CADENCE_MULTIPLIERS && CADENCE_MULTIPLIERS[c] != null) {
    mult = CADENCE_MULTIPLIERS[c];
  } else if ((c === "custom" || c === "weekdays") && customWeeks && customWeeks > 0) {
    mult = Math.round((4.333 / customWeeks) * 1000) / 1000;   // e.g. every 4 wks → 1.083
  } else if (c in CADENCE_MULTIPLIERS) {
    return { multiplier: null, mrr: null, computable: false, reason: `cadence '${c}' has no interval — MRR indeterminate` };
  } else {
    return { multiplier: null, mrr: null, computable: false, reason: `unknown cadence '${c || "(blank)"}'` };
  }
  const r = typeof rate === "number" ? rate : parseFloat(String(rate ?? ""));
  if (!Number.isFinite(r) || r <= 0) {
    return { multiplier: mult, mrr: null, computable: false, reason: "rate is $0, null, or invalid" };
  }
  return { multiplier: mult, mrr: Math.round(r * mult * 100) / 100, computable: true, reason: null };
}

// Normalize a salesperson's name for grouping (trim, collapse inner whitespace,
// Title Case). This dedupes casing/spacing variants; true nickname collisions
// ("Sal" vs "Salvador") are resolved by linking salesperson_user_id to a real
// Qleno user and grouping the leaderboard on that id, not the name string.
export function normalizePersonName(name: string | null | undefined): string | null {
  const n = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!n) return null;
  return n
    .split(" ")
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}
