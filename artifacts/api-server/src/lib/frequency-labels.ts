/**
 * Canonical recurring-frequency display labels (server side).
 *
 * MIRRORS artifacts/qleno/src/lib/frequency-labels.ts — the frontend and API
 * are separate packages so the map is duplicated, but the wording MUST stay
 * identical. Plain, customer-friendly language everywhere: "Every 2 Weeks" /
 * "Every 4 Weeks", never "Biweekly"/"Monthly" (Sal's call 2026-06-19). The DB
 * enum values are unchanged — this is display-only.
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

/** Display label for a stored frequency value; falls back to the raw value. */
export function frequencyLabel(freq?: string | null): string {
  if (!freq) return "";
  return FREQUENCY_LABELS[freq] ?? freq;
}
