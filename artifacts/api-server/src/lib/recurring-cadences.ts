/**
 * Pure date-math for the recurring engine. Extracted from recurring-jobs.ts
 * so unit tests can import without dragging in the Drizzle DB binding.
 *
 * Handles every cadence Sal listed on 2026-06-01 as required for July
 * cutover:
 *   - weekly / biweekly / every_3_weeks / every_4_weeks
 *   - custom + custom_frequency_weeks (N-week interval, N >= 1)
 *   - monthly (day-of-month, sentinel 0 = last day)
 *   - semi_monthly (two day-of-month anchors)
 *   - daily / weekdays / custom_days (multi-day per week)
 *
 * This file MUST NOT import @workspace/db or any IO-bound module — keeping
 * it pure is what lets the test suite run without provisioning a DB.
 */

export const DAY_NAME_TO_NUM: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

export function parseDate(str: string | Date): Date {
  // Accept a JS Date as well as a "YYYY-MM-DD" string. The cadence engine
  // is fed schedule rows from two sources: Drizzle typed selects (the
  // `date()` column codec yields a string) and raw `tx.execute`/`db.execute`
  // SELECTs (node-postgres' default `date` parser yields a JS Date at local
  // midnight). The create_recurring cascade uses the raw-execute path, so a
  // Date object reaches here — `.split` then threw `str.split is not a
  // function`, aborting the whole transaction and silently rolling back the
  // schedule + its fan-out. Reading the local Y/M/D components (matches how
  // pg parses a bare `date`) normalizes both forms to a clean local-midnight
  // Date so downstream day-of-week math is stable.
  if (str instanceof Date) {
    return new Date(str.getFullYear(), str.getMonth(), str.getDate());
  }
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function getFirstOccurrence(start: Date, targetDow: number, fromDate: Date): Date {
  const d = new Date(fromDate);
  const diff = (targetDow - d.getDay() + 7) % 7;
  return addDays(d, diff);
}

// daily      → every day 0..6
// weekdays   → Mon-Fri
// custom_days → operator-picked days_of_week array (e.g., Arianna Wed+Sat)
// Returns null for all other frequencies (which use the single-day path).
export function resolveMultiDayPattern(
  freq: string,
  daysOfWeek: number[] | null,
): number[] | null {
  if (freq === "daily") return [0, 1, 2, 3, 4, 5, 6];
  if (freq === "weekdays") return [1, 2, 3, 4, 5];
  if (freq === "custom_days") {
    const arr = (daysOfWeek ?? []).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
    return arr.length > 0 ? Array.from(new Set(arr)).sort() : null;
  }
  return null;
}

// Saturday/Sunday → next Monday. Used for monthly + semi_monthly anchors
// only, matching Sal's "snap forward" decision (CLAUDE.md, Apr 16).
export function snapToBusinessDay(d: Date): Date {
  const dow = d.getDay();
  if (dow === 6) return addDays(d, 2);
  if (dow === 0) return addDays(d, 1);
  return d;
}

// Resolves day-of-month with two specials:
//   day=0    → last day of the month
//   day>last → clamps to last day of the month (e.g., Feb 30 → Feb 28)
export function resolveDayOfMonth(year: number, month: number, day: number): number {
  const lastDay = new Date(year, month + 1, 0).getDate();
  if (day === 0 || day > lastDay) return lastDay;
  return day;
}

// [commercial-cadence] Nth weekday of a month — "3rd Wednesday", "last Friday".
// nth: 1..4 = first..fourth; 5 (or anything >=5) = LAST occurrence in the
// month. weekday: 0=Sun..6=Sat. Used by the monthly_weekday cadence.
export function nthWeekdayOfMonth(year: number, month: number, nth: number, weekday: number): Date {
  if (nth >= 5) {
    const last = new Date(year, month + 1, 0);
    const back = (last.getDay() - weekday + 7) % 7;
    return new Date(year, month, last.getDate() - back);
  }
  const first = new Date(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + offset + (nth - 1) * 7);
}

export interface CadenceInput {
  frequency: string;
  day_of_week: string | null;
  days_of_week?: number[] | null;
  days_of_month?: number[] | null;
  custom_frequency_weeks?: number | null;
  // [commercial-cadence] 1..4 = first..fourth, 5 = last. Pairs with
  // day_of_week for the monthly_weekday cadence ("3rd Wednesday" etc).
  week_of_month?: number | null;
  // string from a Drizzle typed select; Date from a raw pg `date` column.
  start_date: string | Date;
  end_date?: string | Date | null;
}

export function generateCadenceDates(
  schedule: CadenceInput,
  fromDate: Date,
  toDate: Date,
): Date[] {
  const start = parseDate(schedule.start_date);
  const endLimit = schedule.end_date ? parseDate(schedule.end_date) : toDate;
  const effectiveEnd = endLimit < toDate ? endLimit : toDate;

  const freq = schedule.frequency;
  const dates: Date[] = [];

  if (schedule.day_of_week && (schedule.days_of_week?.length ?? 0) > 0) {
    console.warn(
      `[recurring-engine] schedule has BOTH day_of_week and days_of_week populated — preferring days_of_week`,
    );
  }

  // ── Multi-day path: daily / weekdays / custom_days ──────────────────────
  const multiDay = resolveMultiDayPattern(freq, schedule.days_of_week ?? null);
  if (multiDay) {
    const targetSet = new Set(multiDay);
    let current = new Date(fromDate);
    while (current <= effectiveEnd) {
      if (current >= start && targetSet.has(current.getDay())) {
        dates.push(new Date(current));
      }
      current = addDays(current, 1);
    }
    return dates;
  }

  // ── Single-day path ────────────────────────────────────────────────────
  const targetDow = schedule.day_of_week
    ? (DAY_NAME_TO_NUM[schedule.day_of_week.toLowerCase()] ?? start.getDay())
    : start.getDay();

  if (freq === "semi_monthly") {
    const anchors = schedule.days_of_month && schedule.days_of_month.length > 0
      ? schedule.days_of_month
      : [1, 15];
    let cursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
    while (cursor <= effectiveEnd) {
      const y = cursor.getFullYear();
      const m = cursor.getMonth();
      for (const a of anchors) {
        const day = resolveDayOfMonth(y, m, a);
        const raw = new Date(y, m, day);
        const snapped = snapToBusinessDay(raw);
        if (snapped >= start && snapped >= fromDate && snapped <= effectiveEnd) {
          dates.push(snapped);
        }
      }
      cursor = addMonths(cursor, 1);
    }
    dates.sort((a, b) => a.getTime() - b.getTime());
    return dates;
  }

  if (freq === "monthly") {
    const dayOfMonth = schedule.days_of_month && schedule.days_of_month.length > 0
      ? schedule.days_of_month[0]
      : start.getDate();
    let cursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
    while (cursor <= effectiveEnd) {
      const day = resolveDayOfMonth(cursor.getFullYear(), cursor.getMonth(), dayOfMonth);
      const raw = new Date(cursor.getFullYear(), cursor.getMonth(), day);
      const snapped = snapToBusinessDay(raw);
      if (snapped >= start && snapped >= fromDate && snapped <= effectiveEnd) {
        dates.push(snapped);
      }
      cursor = addMonths(cursor, 1);
    }
    return dates;
  }

  // ── Nth-weekday path: "3rd Wednesday", "last Friday" ────────────────────
  // [commercial-cadence] week_of_month (1..4, or 5=last) + day_of_week.
  if (freq === "monthly_weekday") {
    const nth = schedule.week_of_month ?? 1;
    let cursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
    while (cursor <= effectiveEnd) {
      const d = nthWeekdayOfMonth(cursor.getFullYear(), cursor.getMonth(), nth, targetDow);
      if (d >= start && d >= fromDate && d <= effectiveEnd) dates.push(d);
      cursor = addMonths(cursor, 1);
    }
    return dates;
  }

  // Interval picker for weekly/biweekly/every_3_weeks/every_4_weeks/custom.
  // [2026-06-01] every_4_weeks added as first-class to fix Sal's "monthly"
  // recurring (Wednesdays every 4 weeks) which previously fell through to
  // the silent biweekly fallback and produced jobs every other week.
  let intervalDays: number;
  if (freq === "weekly") {
    intervalDays = 7;
  } else if (freq === "biweekly") {
    intervalDays = 14;
  } else if (freq === "every_3_weeks") {
    intervalDays = 21;
  } else if (freq === "every_4_weeks") {
    intervalDays = 28;
  } else if (freq === "custom" && schedule.custom_frequency_weeks != null) {
    intervalDays = schedule.custom_frequency_weeks * 7;
  } else {
    console.warn(
      `[recurring-engine] Unknown frequency "${freq}" on schedule (start_date=${schedule.start_date}). ` +
      `Falling back to biweekly intervalDays=14. Add an explicit branch if this frequency is supposed to be supported.`
    );
    intervalDays = 14;
  }
  // Seed at the later of fromDate or start so we never emit before
  // start_date. The previous version only gated on fromDate, which let
  // pre-start dates slip into the output when fromDate < start.
  const seed = fromDate > start ? fromDate : start;
  let current = getFirstOccurrence(start, targetDow, seed);
  while (current <= effectiveEnd) {
    if (current >= fromDate && current >= start) dates.push(new Date(current));
    current = addDays(current, intervalDays);
  }
  return dates;
}
