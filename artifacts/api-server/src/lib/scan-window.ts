/**
 * Cutover 3B — Pure scan-window validator for /api/attendance-overlay/scan.
 *
 * Lives in its own file (DB-free) so the unit test can import it
 * without triggering the @workspace/db drizzle initializer that the
 * full route module would pull in.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const MAX_SCAN_WINDOW_DAYS = 31;

export interface ScanWindowInput {
  from_date?: unknown;
  to_date?: unknown;
  user_id?: unknown;
  /** Caller-supplied "today" in Chicago wall-clock (YYYY-MM-DD).
   *  Injectable for tests. */
  today: string;
}

export type ScanWindowResult =
  | { ok: true; from_date: string; to_date: string; user_id: number | null }
  | { ok: false; status: number; message: string; code?: string };

export function validateScanWindow(input: ScanWindowInput): ScanWindowResult {
  const todayStr = input.today;
  const from = typeof input.from_date === "string" ? input.from_date : "";
  const to = typeof input.to_date === "string" ? input.to_date : "";
  if (!ISO_DATE_RE.test(from)) {
    return {
      ok: false,
      status: 400,
      message: "from_date YYYY-MM-DD required",
      code: "bad_from_date",
    };
  }
  if (!ISO_DATE_RE.test(to)) {
    return {
      ok: false,
      status: 400,
      message: "to_date YYYY-MM-DD required",
      code: "bad_to_date",
    };
  }
  if (from > to) {
    return {
      ok: false,
      status: 400,
      message: "from_date must be <= to_date",
      code: "inverted_window",
    };
  }
  if (from > todayStr) {
    return {
      ok: false,
      status: 400,
      message: "from_date cannot be in the future",
      code: "future_from_date",
    };
  }
  // Defensive clamp: caller may have asked for a multi-week window
  // ending in the future. We clamp upper bound to today rather than
  // scanning days that haven't happened.
  const toClamped = to > todayStr ? todayStr : to;
  const daysBetween = daysFromIsoStrings(from, toClamped);
  if (daysBetween > MAX_SCAN_WINDOW_DAYS) {
    return {
      ok: false,
      status: 400,
      message: `Scan window cannot exceed ${MAX_SCAN_WINDOW_DAYS} days`,
      code: "window_too_large",
    };
  }
  let userId: number | null = null;
  if (input.user_id != null && input.user_id !== "") {
    const n = Number(input.user_id);
    if (!Number.isFinite(n) || n <= 0) {
      return {
        ok: false,
        status: 400,
        message: "user_id must be a positive integer",
        code: "bad_user_id",
      };
    }
    userId = n;
  }
  return { ok: true, from_date: from, to_date: toClamped, user_id: userId };
}

function daysFromIsoStrings(from: string, to: string): number {
  const a = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10)),
  );
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}
