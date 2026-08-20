// Start times the public booking widget offers, and the rules for which of
// them a given date may use.
//
// This lives in its own module because three places need the same list and
// they must not drift: the widget's two time pickers (one-time and recurring),
// and Settings → Online Booking, where the office picks the Saturday cutoff
// from it. A cutoff the widget has no slot for would silently offer nothing.

// Client-selectable start times, 9:00 AM–2:00 PM in 30-minute steps. The 2:00
// PM cap leaves enough of the workday to finish the job. `label` is what we
// store (arrival_window) and show everywhere; `minutes` drives the filters.
export const BOOKING_TIME_SLOTS: { label: string; minutes: number }[] = (() => {
  const out: { label: string; minutes: number }[] = [];
  for (let m = 9 * 60; m <= 14 * 60; m += 30) {
    const h24 = Math.floor(m / 60), mm = m % 60;
    const h12 = ((h24 + 11) % 12) + 1;
    const ampm = h24 < 12 ? "AM" : "PM";
    out.push({ label: `${h12}:${String(mm).padStart(2, "0")} ${ampm}`, minutes: m });
  }
  return out;
})();

// [sat-cutoff 2026-08-19] Saturday is a short crew day, so the office caps how
// late a Saturday job may start (booking_settings.sat_last_start_minutes,
// 600 = 10:00 AM). Every other weekday keeps the full list. A null cutoff means
// no Saturday-specific limit, which is how every other tenant reads and how
// this behaved before the setting existed.
//
// The date string is parsed at local NOON on purpose: "2026-08-22T00:00:00"
// sits on the midnight boundary, and getDay() on a date built from a bare
// YYYY-MM-DD is UTC-based in some engines — either one can report Friday for a
// Saturday and hand the customer the full afternoon list.
export function slotsForDate(
  dateStr: string,
  satLastStartMinutes: number | null | undefined,
): { label: string; minutes: number }[] {
  if (!dateStr || satLastStartMinutes == null) return BOOKING_TIME_SLOTS;
  const isSaturday = new Date(dateStr + "T12:00:00").getDay() === 6;
  if (!isSaturday) return BOOKING_TIME_SLOTS;
  return BOOKING_TIME_SLOTS.filter(s => s.minutes <= satLastStartMinutes);
}
