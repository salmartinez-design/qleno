// ─────────────────────────────────────────────────────────────────────────────
// Appointment merge-var builder — the ONE place that emits the date/time/window
// tags every customer message needs.
//
// WHY THIS EXISTS: customer messages broke because the send paths and the
// stored templates disagreed on tag NAMES. The deployed Phes templates use
// {{appointment_date}} / {{appointment_time}} / {{appointment_window}}, but the
// reminder cron only supplied {{date}} / {{arrival_window}} (and no time at
// all) — so reminders went out reading "scheduled for (blank) with a (blank)
// arrival window." Both naming conventions are legitimate (the catalog defaults
// use the short names, the imported MaidCentral templates use the appointment_*
// names), so the fix is to ALWAYS emit BOTH. Spread this into any customer
// message's merge vars and every date/time/window tag resolves, regardless of
// which name the template author picked. Applies to email AND SMS — they share
// the same merge-var object per send path.
// ─────────────────────────────────────────────────────────────────────────────

// "Friday, June 27, 2026" — accepts a Date (pg timestamp) or a YYYY-MM-DD string.
function fmtApptDate(raw: string | Date | null | undefined): string {
  if (!raw) return "";
  const iso = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw).slice(0, 10);
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return String(raw);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}

// "9:00 AM" — handles "09:00", "9:00 AM", "09:00:00", "9:00 PM".
function fmtApptTime(raw: string | null | undefined): string {
  if (!raw) return "";
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i.exec(String(raw).trim());
  if (!m) return String(raw);
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ap = m[3]?.toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  const h12 = h % 12 || 12;
  const mer = h < 12 ? "AM" : "PM";
  return `${h12}:${min} ${mer}`;
}

export function buildAppointmentVars(opts: {
  scheduledDate?: string | Date | null;
  scheduledTime?: string | null;
  // A pre-formatted arrival-window label (e.g. computeArrivalWindow() output).
  // When omitted, the exact time is used as the window so the tag never renders
  // blank.
  arrivalWindow?: string | null;
}): Record<string, string> {
  const out: Record<string, string> = {};
  const date = fmtApptDate(opts.scheduledDate);
  if (date) {
    out.date = date;
    out.appointment_date = date;
  }
  const time = fmtApptTime(opts.scheduledTime);
  if (time) {
    out.time = time;
    out.appointment_time = time;
  }
  const window = opts.arrivalWindow ? String(opts.arrivalWindow) : time;
  if (window) {
    out.arrival_window = window;
    out.appointment_window = window;
  }
  return out;
}
