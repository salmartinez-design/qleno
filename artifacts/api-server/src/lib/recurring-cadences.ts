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

/**
 * Canonicalize the recurring-frequency vocabulary. The app carries TWO names for
 * the same cadence: the DB enum + this engine use `biweekly`/`monthly`, while the
 * quote/cadence UI and some business logic emit `every_2_weeks`/`every_4_weeks`
 * (and `bi-weekly`). Un-normalized, those legacy values silently fail the
 * fan-out gates in routes/jobs.ts (schedule created but only the FIRST job books
 * — Maribel's "every two weeks only books the first one") or fail the enum
 * INSERT outright. Every path that WRITES a recurring frequency must route it
 * through here so the gate, the enum column, and the date engine all agree.
 */
export function normalizeRecurringFreq(f: unknown): string {
  const s = String(f ?? "").trim().toLowerCase();
  if (s === "every_2_weeks" || s === "bi-weekly") return "biweekly";
  if (s === "every_4_weeks") return "monthly";
  return s;
}

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
  // [custom-recurring] Month step for monthly_weekday ("every N months on the
  // Nth weekday"). null/1 = every month (backward-compatible). Phase is anchored
  // on start_date's month, so N=2 emits the start month, +2, +4, …
  month_interval?: number | null;
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

  // [monthly-weekday-drift 2026-07-09] Genuine date-based monthly needs an
  // explicit days_of_month anchor. A `monthly` schedule with NO days_of_month
  // is the residential "Every 4 weeks" case — the job wizard / edit-job modal
  // label that option "Every 4 weeks" but STORE it as frequency='monthly'. The
  // office means "every 4 weeks on the SAME WEEKDAY", not "same date each
  // month". The old day-of-month path fell back to start.getDate() and then
  // snapToBusinessDay shoved any weekend date forward to Monday — so a
  // Wednesday cadence became Monday from the 2nd occurrence on (Crystal
  // Sanchez: Aug 19 Wed → Sep 21 Mon → Oct 19 Mon). When there's no
  // days_of_month we fall through to the weekday-anchored 28-day interval path
  // below (freq==='monthly' → intervalDays=28), which is stable and preserves
  // the weekday. This also self-heals every schedule already mis-stored this
  // way, with no data migration.
  if (freq === "monthly" && schedule.days_of_month && schedule.days_of_month.length > 0) {
    const dayOfMonth = schedule.days_of_month[0];
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
    // [custom-recurring] Month step, phase-anchored on the start month so
    // "every 2 months" lands on start, start+2, start+4 — never drifting to the
    // off-months. null/≤1 keeps the legacy every-month behavior.
    const step = Math.max(1, schedule.month_interval ?? 1);
    let cursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
    while (cursor <= effectiveEnd) {
      const monthsSinceStart =
        (cursor.getFullYear() - start.getFullYear()) * 12 + (cursor.getMonth() - start.getMonth());
      if (monthsSinceStart >= 0 && monthsSinceStart % step === 0) {
        const d = nthWeekdayOfMonth(cursor.getFullYear(), cursor.getMonth(), nth, targetDow);
        if (d >= start && d >= fromDate && d <= effectiveEnd) dates.push(d);
      }
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
  } else if (freq === "every_4_weeks" || freq === "monthly") {
    // every_4_weeks: explicit. monthly reaching here means it had NO
    // days_of_month anchor (the day-of-month branch above returns early when
    // one is set) — i.e. the residential "Every 4 weeks" cadence. Both walk the
    // same weekday every 28 days instead of snapping a day-of-month to Monday.
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
  // [phase-fix 2026-06-24] Anchor the interval grid on start_date, not on the
  // generation window. We take the first targetDow occurrence on/after
  // start_date, then step by intervalDays and fast-forward (in whole intervals)
  // up to the window. This preserves the alternate-week PHASE for biweekly /
  // every_3_weeks / every_4_weeks / custom — a biweekly customer stays on their
  // real week regardless of when the cron happens to run. The previous version
  // seeded `getFirstOccurrence` from max(fromDate, start), so the phase was
  // re-derived from the run date and a biweekly schedule could silently flip to
  // the wrong week each time generation ran on a different date. start_date is
  // the source of truth for the cadence anchor; day_of_week sets the weekday.
  let current = getFirstOccurrence(start, targetDow, start);
  while (current < fromDate) current = addDays(current, intervalDays);
  while (current <= effectiveEnd) {
    // current is guaranteed >= fromDate (fast-forwarded) and >= start (anchored).
    dates.push(new Date(current));
    current = addDays(current, intervalDays);
  }
  return dates;
}

// ── human labels ─────────────────────────────────────────────────────────────
// [cadence-label 2026-08-20] The English name for a cadence used to live as a
// private copy inside agreement-merge.ts. It is now needed in a second place
// (the hold notice quote, where the office has to see WHICH schedule produced
// the visit count it is about to bill), and a second copy is how the contract
// and the app start disagreeing about what "monthly" means. One map, here,
// next to the engine that actually walks these cadences.

export const FREQUENCY_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  every_3_weeks: "Every 3 weeks",
  monthly: "Every 4 weeks",
  monthly_weekday: "Monthly",
  semi_monthly: "Twice a month",
  daily: "Daily",
  weekdays: "Weekdays",
  custom_days: "Multiple days each week",
  custom: "Custom",
};

export const DAY_PLURALS: Record<string, string> = {
  monday: "Mondays", tuesday: "Tuesdays", wednesday: "Wednesdays",
  thursday: "Thursdays", friday: "Fridays", saturday: "Saturdays", sunday: "Sundays",
};

const DOW_PLURALS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

export function frequencyLabel(freq: unknown, customWeeks?: unknown): string {
  const key = normalizeRecurringFreq(freq);
  // A custom cadence carries its interval in custom_frequency_weeks; rendering
  // a bare "Custom" tells the reader nothing about how often we are coming,
  // which is the one thing the frequency line exists to say.
  if (key === "custom") {
    const w = Number(customWeeks);
    if (Number.isFinite(w) && w > 0) return w === 1 ? "Weekly" : `Every ${w} weeks`;
  }
  return FREQUENCY_LABELS[key] || "";
}

function ordinal(n: number): string {
  if (n === 0) return "last day";
  const s = ["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th";
  return `${n}${s}`;
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] || "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * One line of plain English for a schedule: "Weekly on Fridays", "Twice a month
 * on the 1st and 15th". Used wherever a person has to recognize their own
 * schedule in a number we derived from it — notably the hold notice quote,
 * where "4 visits" means nothing until you can see it came from a weekly
 * Friday cadence.
 */
export function describeCadence(s: CadenceInput): string {
  const key = normalizeRecurringFreq(s.frequency);
  const base = frequencyLabel(s.frequency, s.custom_frequency_weeks) || "Recurring";

  // Day-of-month cadences name their anchors, not a weekday.
  if (key === "semi_monthly" || (key === "monthly" && (s.days_of_month?.length ?? 0) > 0)) {
    const doms = (s.days_of_month ?? []).filter(n => Number.isInteger(n));
    // A plain `monthly` WITH explicit days_of_month is the day-of-month case;
    // without it, it is the residential "Every 4 weeks" weekday walk, which
    // falls through to the weekday branch below on purpose.
    if (doms.length > 0) {
      const label = key === "monthly" ? "Monthly" : base;
      return `${label} on the ${joinList(doms.map(ordinal))}`;
    }
  }

  const multi = resolveMultiDayPattern(key, s.days_of_week ?? null);
  if (multi && key === "custom_days") {
    return `${joinList(multi.map(n => DOW_PLURALS[n]))} each week`;
  }
  if (multi) return base; // daily / weekdays already say which days they mean

  const day = DAY_PLURALS[String(s.day_of_week || "").toLowerCase()];
  if (key === "monthly_weekday" && day) {
    const w = Number(s.week_of_month);
    const which = w === 5 ? "last" : w >= 1 && w <= 4 ? ordinal(w) : "";
    const every = Number(s.month_interval) > 1 ? `Every ${Number(s.month_interval)} months` : "Monthly";
    return which ? `${every} on the ${which} ${day.replace(/s$/, "")}` : `${every} on ${day}`;
  }
  return day ? `${base} on ${day}` : base;
}
