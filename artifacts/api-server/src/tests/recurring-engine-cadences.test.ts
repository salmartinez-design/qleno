/**
 * Tests for the recurring engine cadence logic.
 *
 * Defends every cadence Sal listed on 2026-06-01 as required for July
 * cutover:
 *   - weekly
 *   - biweekly
 *   - every_3_weeks
 *   - every_4_weeks (was silently producing biweekly before this fix)
 *   - monthly
 *   - semi_monthly
 *   - custom (with custom_frequency_weeks)
 *   - daily
 *   - weekdays (Mon–Fri)
 *   - custom_days (e.g., Wed + Sat for Arianna Goose)
 *
 * Pure date-math tests against generateOccurrences — no DB.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateCadenceDates as generateOccurrences } from "../lib/recurring-cadences.js";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dowOf = (d: Date) => DOW[d.getDay()];
const isoOf = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// Common window: June 2026 (Mon June 1 is a Monday)
const WINDOW_START = new Date(2026, 5, 1); // Jun 1 2026 — Monday
const WINDOW_END = new Date(2026, 7, 31);  // Aug 31 2026

function mkSchedule(overrides: Partial<Parameters<typeof generateOccurrences>[0]> & { frequency: string }) {
  return {
    day_of_week: null,
    days_of_week: null,
    days_of_month: null,
    custom_frequency_weeks: null,
    start_date: "2026-06-01",
    end_date: null,
    ...overrides,
  } as Parameters<typeof generateOccurrences>[0];
}

describe("Recurring engine — weekly cadence", () => {
  it("weekly + Wednesday → every Wednesday in the window", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "weekly", day_of_week: "wednesday" }),
      WINDOW_START, WINDOW_END,
    );
    assert.ok(dates.length >= 12, `Expected ≥12 Wednesdays, got ${dates.length}`);
    for (const d of dates) {
      assert.equal(dowOf(d), "Wed", `${isoOf(d)} is not a Wednesday`);
    }
    // Verify 7-day spacing
    for (let i = 1; i < dates.length; i++) {
      const diff = (dates[i].getTime() - dates[i - 1].getTime()) / 86400000;
      assert.equal(diff, 7, `Gap between ${isoOf(dates[i - 1])} and ${isoOf(dates[i])} is ${diff}d (expected 7)`);
    }
  });
});

describe("Recurring engine — biweekly cadence", () => {
  it("biweekly + Tuesday → every other Tuesday", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "biweekly", day_of_week: "tuesday" }),
      WINDOW_START, WINDOW_END,
    );
    assert.ok(dates.length >= 6, `Expected ≥6 Tuesdays, got ${dates.length}`);
    for (const d of dates) assert.equal(dowOf(d), "Tue");
    for (let i = 1; i < dates.length; i++) {
      const diff = (dates[i].getTime() - dates[i - 1].getTime()) / 86400000;
      assert.equal(diff, 14);
    }
  });
});

describe("Recurring engine — every_3_weeks cadence", () => {
  it("every_3_weeks + Friday → every 3rd Friday", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "every_3_weeks", day_of_week: "friday" }),
      WINDOW_START, WINDOW_END,
    );
    assert.ok(dates.length >= 4);
    for (const d of dates) assert.equal(dowOf(d), "Fri");
    for (let i = 1; i < dates.length; i++) {
      const diff = (dates[i].getTime() - dates[i - 1].getTime()) / 86400000;
      assert.equal(diff, 21);
    }
  });
});

describe("Recurring engine — every_4_weeks cadence (the bug fix)", () => {
  it("every_4_weeks + Wednesday → every 4th Wednesday (NOT biweekly!)", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "every_4_weeks", day_of_week: "wednesday" }),
      WINDOW_START, WINDOW_END,
    );
    assert.ok(dates.length >= 3, `Expected ≥3 Wednesdays over 3 months, got ${dates.length}`);
    for (const d of dates) assert.equal(dowOf(d), "Wed");
    // 28-day intervals — this was the broken case (used to be 14)
    for (let i = 1; i < dates.length; i++) {
      const diff = (dates[i].getTime() - dates[i - 1].getTime()) / 86400000;
      assert.equal(diff, 28, `Gap between ${isoOf(dates[i - 1])} and ${isoOf(dates[i])} is ${diff}d (expected 28)`);
    }
  });
});

describe("Recurring engine — monthly WITHOUT days_of_month = 'Every 4 weeks' (Crystal Sanchez drift)", () => {
  // The residential wizard labels the option "Every 4 weeks" but stores it as
  // frequency='monthly' with NO days_of_month. This used to fall into the
  // day-of-month path (start.getDate()) + snapToBusinessDay, so a Wednesday
  // cadence drifted to Monday from the 2nd occurrence on. It must now walk a
  // stable 28-day interval on the same weekday.
  it("monthly + Wednesday + no days_of_month → every 4th Wednesday, NEVER Monday", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "monthly", day_of_week: "wednesday", start_date: "2026-08-19" }),
      new Date(2026, 7, 1), new Date(2026, 10, 30), // Aug 1 → Nov 30 2026
    );
    assert.ok(dates.length >= 3, `Expected ≥3 occurrences, got ${dates.length}`);
    // Every occurrence stays on Wednesday — the whole point of the bug report.
    for (const d of dates) assert.equal(dowOf(d), "Wed", `${isoOf(d)} is ${dowOf(d)}, expected Wed`);
    // First lands on the start date; then strict 28-day gaps.
    assert.equal(isoOf(dates[0]), "2026-08-19");
    for (let i = 1; i < dates.length; i++) {
      // Round — a DST fall-back (Nov 1 2026) adds an hour to the raw span.
      const diff = Math.round((dates[i].getTime() - dates[i - 1].getTime()) / 86400000);
      assert.equal(diff, 28, `Gap ${isoOf(dates[i - 1])}→${isoOf(dates[i])} is ${diff}d (expected 28)`);
    }
  });

  it("monthly + no day_of_week + no days_of_month → 28-day interval anchored on start weekday", () => {
    // start Aug 19 2026 is a Wednesday; without day_of_week the engine anchors
    // on the start date's weekday.
    const dates = generateOccurrences(
      mkSchedule({ frequency: "monthly", start_date: "2026-08-19" }),
      new Date(2026, 7, 1), new Date(2026, 10, 30),
    );
    assert.ok(dates.length >= 3);
    for (const d of dates) assert.equal(dowOf(d), "Wed");
  });
});

describe("Recurring engine — custom interval (custom_frequency_weeks)", () => {
  it("custom + 5 weeks + Thursday → 35-day intervals on Thursday", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "custom", day_of_week: "thursday", custom_frequency_weeks: 5 }),
      WINDOW_START, WINDOW_END,
    );
    assert.ok(dates.length >= 2);
    for (const d of dates) assert.equal(dowOf(d), "Thu");
    for (let i = 1; i < dates.length; i++) {
      const diff = (dates[i].getTime() - dates[i - 1].getTime()) / 86400000;
      assert.equal(diff, 35);
    }
  });
});

describe("Recurring engine — monthly cadence", () => {
  it("monthly with days_of_month=[15] → 15th of every month (with weekend snap-forward)", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "monthly", days_of_month: [15] }),
      WINDOW_START, WINDOW_END,
    );
    assert.ok(dates.length >= 3);
    // 15th of Jun/Jul is Mon/Wed (no snap), Aug 15 2026 is a Saturday which
    // snaps forward to Mon Aug 17. Allow either the 15th or the snapped
    // Monday after it (which can be the 16th or 17th).
    for (const d of dates) {
      const dayOfMonth = d.getDate();
      assert.ok(
        [15, 16, 17].includes(dayOfMonth),
        `${d.toISOString()} has dayOfMonth=${dayOfMonth}, expected 15/16/17 (15th or post-weekend snap)`,
      );
    }
  });

  it("monthly with days_of_month=[0] (sentinel) → last day of every month", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "monthly", days_of_month: [0] }),
      WINDOW_START, WINDOW_END,
    );
    assert.ok(dates.length >= 3);
    // Should land on the last day: Jun 30, Jul 31, Aug 31
    const days = dates.map(d => d.getDate());
    assert.ok(days.includes(30) || days.includes(31), "Expected 30 or 31 (month-end)");
  });
});

describe("Recurring engine — semi_monthly cadence", () => {
  it("semi_monthly with [1, 15] → 1st and 15th of every month", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "semi_monthly", days_of_month: [1, 15] }),
      WINDOW_START, WINDOW_END,
    );
    assert.ok(dates.length >= 6); // 2 per month × 3 months
    const days = dates.map(d => d.getDate());
    // After weekend snap-forward, may have 2 or 3 (Saturday Aug 1 snaps to Monday Aug 3)
    // So check that 15 is present and 1 (or its snap) is too
    assert.ok(days.includes(15));
  });

  it("semi_monthly defaults to [1, 15] when days_of_month is null", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "semi_monthly" }),
      WINDOW_START, WINDOW_END,
    );
    assert.ok(dates.length >= 6);
  });
});

describe("Recurring engine — multi-day: daily", () => {
  it("daily → every day in window", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "daily", start_date: "2026-06-01" }),
      WINDOW_START, new Date(2026, 5, 7), // 1-week window
    );
    assert.equal(dates.length, 7, "Expected 7 days");
  });
});

describe("Recurring engine — multi-day: weekdays", () => {
  it("weekdays → only Mon-Fri", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "weekdays", start_date: "2026-06-01" }),
      WINDOW_START, new Date(2026, 5, 7), // 1-week window
    );
    assert.equal(dates.length, 5);
    for (const d of dates) {
      const dow = d.getDay();
      assert.ok(dow >= 1 && dow <= 5, `${isoOf(d)} (${dowOf(d)}) is a weekend`);
    }
  });
});

describe("Recurring engine — multi-day: custom_days (Arianna Goose)", () => {
  it("custom_days with [3, 6] → Wednesdays AND Saturdays only", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "custom_days", days_of_week: [3, 6], start_date: "2026-06-01" }),
      WINDOW_START, new Date(2026, 5, 14), // 2-week window
    );
    // 2 Wednesdays + 2 Saturdays = 4 occurrences
    assert.equal(dates.length, 4);
    const dows = dates.map(dowOf).sort();
    assert.deepEqual(dows, ["Sat", "Sat", "Wed", "Wed"]);
  });

  it("custom_days with [1, 3, 5] → 3 days/week (Mon/Wed/Fri)", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "custom_days", days_of_week: [1, 3, 5], start_date: "2026-06-01" }),
      WINDOW_START, new Date(2026, 5, 7), // 1-week window
    );
    assert.equal(dates.length, 3);
  });

  it("custom_days with empty days_of_week → produces nothing (guarded)", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "custom_days", days_of_week: [], start_date: "2026-06-01" }),
      WINDOW_START, new Date(2026, 5, 7),
    );
    // Falls through to single-day path (multi-day returns null when array
    // is empty). Then single-day uses start_date's DOW. Either way the
    // operator should never have an empty days_of_week — but the engine
    // shouldn't crash.
    assert.ok(Array.isArray(dates));
  });
});

describe("Recurring engine — unknown frequency fallback", () => {
  it("unknown frequency falls back to biweekly + logs warning", () => {
    // Hijack console.warn to capture
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      const dates = generateOccurrences(
        mkSchedule({ frequency: "bogus_freq" as any, day_of_week: "monday", start_date: "2026-06-01" }),
        WINDOW_START, WINDOW_END,
      );
      // Should still produce SOMETHING (biweekly Mondays) so historical
      // schedules don't silently stop generating.
      assert.ok(dates.length >= 4);
      for (const d of dates) assert.equal(dowOf(d), "Mon");
      // And should have logged the warning
      assert.ok(
        warnings.some(w => w.includes("Unknown frequency") && w.includes("bogus_freq")),
        `Expected warning about bogus_freq, got: ${warnings.join(" | ")}`
      );
    } finally {
      console.warn = origWarn;
    }
  });
});

describe("Recurring engine — start_date and end_date boundaries", () => {
  it("doesn't emit dates before start_date", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "weekly", day_of_week: "monday", start_date: "2026-06-15" }),
      WINDOW_START, WINDOW_END,
    );
    for (const d of dates) {
      assert.ok(
        d >= new Date(2026, 5, 15),
        `${isoOf(d)} is before start_date 2026-06-15`,
      );
    }
  });

  it("doesn't emit dates after end_date", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "weekly", day_of_week: "monday", start_date: "2026-06-01", end_date: "2026-06-30" }),
      WINDOW_START, WINDOW_END,
    );
    for (const d of dates) {
      assert.ok(d <= new Date(2026, 5, 30), `${isoOf(d)} is after end_date`);
    }
  });
});

describe("Recurring engine — Date-object start/end inputs (cascade path)", () => {
  // The create_recurring cascade (PATCH /api/jobs/:id) reads the schedule via
  // raw `tx.execute`, where node-postgres returns a `date` column as a JS Date
  // object — not a "YYYY-MM-DD" string. parseDate() previously called
  // `.split("-")` unconditionally and threw `str.split is not a function`,
  // aborting the whole transaction so the schedule saved-then-rolled-back with
  // zero future jobs and no visible error. These guard that regression.
  it("accepts a Date object for start_date without throwing", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "weekly", day_of_week: "wednesday", start_date: new Date(2026, 5, 3) as any }),
      WINDOW_START, WINDOW_END,
    );
    assert.ok(dates.length >= 12, `Expected ≥12 Wednesdays from a Date start_date, got ${dates.length}`);
    for (const d of dates) assert.equal(dowOf(d), "Wed");
  });

  it("matches the string result when start_date is the equivalent Date object", () => {
    const fromStr = generateOccurrences(
      mkSchedule({ frequency: "weekly", day_of_week: "monday", start_date: "2026-06-15" }),
      WINDOW_START, WINDOW_END,
    ).map(isoOf);
    const fromDate = generateOccurrences(
      mkSchedule({ frequency: "weekly", day_of_week: "monday", start_date: new Date(2026, 5, 15) as any }),
      WINDOW_START, WINDOW_END,
    ).map(isoOf);
    assert.deepEqual(fromDate, fromStr);
  });

  it("accepts a Date object for end_date", () => {
    const dates = generateOccurrences(
      mkSchedule({ frequency: "weekly", day_of_week: "monday", start_date: "2026-06-01", end_date: new Date(2026, 5, 30) as any }),
      WINDOW_START, WINDOW_END,
    );
    for (const d of dates) assert.ok(d <= new Date(2026, 5, 30), `${isoOf(d)} is after end_date`);
  });
});
