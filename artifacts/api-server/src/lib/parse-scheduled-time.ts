/**
 * Cutover 3B — Canonical scheduled-time parser (server-side).
 *
 * The dispatch frontend has its own `timeToMins` at
 * artifacts/qleno/src/pages/jobs.tsx (~line 83). This helper mirrors
 * the same semantics so the attendance-overlay classifier and the
 * dispatch UI both interpret `jobs.scheduled_time` identically.
 *
 * Returns minutes-since-midnight (0..1439), Chicago wall-clock
 * naive — the caller is responsible for any timezone context. Returns
 * null when the input is null, empty, or syntactically unparseable.
 *
 * Accepted formats:
 *   - "1:30 PM" / "1:30 pm"     (12-hour with AM/PM)
 *   - "12:00 AM" → 0           (midnight)
 *   - "12:00 PM" → 720          (noon)
 *   - "11:59 PM" → 1439
 *   - "13:30"                   (24-hour)
 *   - "13:30:00"                (24-hour with seconds)
 *
 * Anything else → null. This is intentionally strict — a garbage
 * scheduled_time should NOT be silently coerced to 0 (which would
 * paint every unparseable job as "late at midnight").
 */

export function parseScheduledTime(s: string | null | undefined): number | null {
  if (s == null) return null;
  const trimmed = String(s).trim();
  if (trimmed === "") return null;

  // 12-hour form with AM/PM: hours 1..12, minutes 00..59.
  const ampm = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampm) {
    const h = parseInt(ampm[1], 10);
    const m = parseInt(ampm[2], 10);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    if (h < 1 || h > 12) return null;
    if (m < 0 || m > 59) return null;
    const isPM = ampm[3].toUpperCase() === "PM";
    let hour24: number;
    if (h === 12) hour24 = isPM ? 12 : 0; // 12 AM → 0, 12 PM → 12
    else hour24 = isPM ? h + 12 : h; // 1..11 PM → 13..23
    return hour24 * 60 + m;
  }

  // 24-hour form: optional seconds. Hours 0..23, minutes 0..59,
  // seconds 0..59 (seconds discarded).
  const h24 = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (h24) {
    const h = parseInt(h24[1], 10);
    const m = parseInt(h24[2], 10);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    if (h < 0 || h > 23) return null;
    if (m < 0 || m > 59) return null;
    return h * 60 + m;
  }

  return null;
}
