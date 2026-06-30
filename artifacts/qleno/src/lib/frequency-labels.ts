/**
 * Canonical recurring-frequency display labels — single source of truth.
 *
 * Sal's rule (2026-06-19): every surface shows recurring cadence in plain,
 * customer-friendly language. No "Biweekly" (ambiguous — many read it as
 * twice a week) and no "Monthly" for the 4-week cadence (misleads a customer
 * into expecting the same calendar date). Online quotes set the standard;
 * the office screens now match them.
 *
 *   weekly        → "Weekly"
 *   biweekly      → "Every 2 Weeks"
 *   every_3_weeks → "Every 3 Weeks"
 *   monthly       → "Every 4 Weeks"   (Phes runs 28-day cycles, not calendar
 *   every_4_weeks → "Every 4 Weeks"    months; both collapse to one label)
 *
 * The DB enum values (weekly / biweekly / every_3_weeks / monthly / …) are
 * UNCHANGED — this is display-only. Any surface that renders a frequency MUST
 * route through here. Do NOT inline a new freqMap — that is exactly the drift
 * (Biweekly vs Every 2 Weeks vs Every 2 weeks) this file exists to kill.
 */
export const FREQUENCY_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 Weeks",
  every_2_weeks: "Every 2 Weeks",
  every_3_weeks: "Every 3 Weeks",
  monthly: "Every 4 Weeks",
  every_4_weeks: "Every 4 Weeks",
  semi_monthly: "Twice a Month",
  daily: "Daily",
  weekdays: "Weekdays",
  custom_days: "Custom Days",
  custom: "Custom",
  on_demand: "One-Time",
  onetime: "One-Time",
  one_time: "One-Time",
};

/** Values that mean "not recurring" — callers can gate on an empty label. */
const NON_RECURRING = new Set(["on_demand", "onetime", "one_time"]);

/**
 * Display label for a stored frequency value. Falls back to the raw value
 * when unknown so a new enum value is still visible (and obviously needs a
 * label added here) rather than silently blank.
 */
export function frequencyLabel(freq?: string | null): string {
  if (!freq) return "";
  return FREQUENCY_LABELS[freq] ?? freq;
}

/**
 * Like frequencyLabel but returns "" for one-time / on-demand, so dispatch
 * and list cards can show a recurrence chip only when the job actually
 * repeats.
 */
export function recurrenceLabel(freq?: string | null): string {
  if (!freq || NON_RECURRING.has(freq)) return "";
  return frequencyLabel(freq);
}

/**
 * Build ordered [{ value, label }] dropdown options from a list of enum
 * values, each labeled through the canonical map. Keeps every selector's
 * value set local while guaranteeing the labels stay consistent.
 */
export function freqOptions(values: string[]): Array<{ value: string; label: string }> {
  return values.map((value) => ({ value, label: frequencyLabel(value) }));
}
