/**
 * [cadence-label 2026-08-20] describeCadence() writes the one line of English a
 * customer reads to recognize their own schedule — on the agreement, on the hold
 * notice quote, and in the portal. A wrong line there is worse than no line: it
 * tells someone we are coming on a day we are not.
 *
 * The load-bearing case is `monthly` WITHOUT days_of_month. That is the
 * residential "Every 4 weeks" weekday walk, NOT a day-of-month cadence. If it
 * ever renders "Monthly on the 3rd" the label has drifted from the engine, which
 * is exactly the drift that produced the Monday-drift bug.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeCadence, frequencyLabel } from "../lib/recurring-cadences.js";

const base = { start_date: "2026-01-07" };

describe("describeCadence", () => {
  it("weekly names the weekday", () => {
    assert.equal(describeCadence({ ...base, frequency: "weekly", day_of_week: "friday" } as any),
      "Weekly on Fridays");
  });

  it("biweekly names the weekday", () => {
    assert.equal(describeCadence({ ...base, frequency: "biweekly", day_of_week: "tuesday" } as any),
      "Every 2 weeks on Tuesdays");
  });

  it("every 3 weeks names the weekday", () => {
    assert.equal(describeCadence({ ...base, frequency: "every_3_weeks", day_of_week: "monday" } as any),
      "Every 3 weeks on Mondays");
  });

  // THE ONE THAT MATTERS. monthly + no days_of_month is the 28-day weekday walk.
  it("monthly with NO days_of_month reads as Every 4 weeks on a weekday", () => {
    const out = describeCadence({ ...base, frequency: "monthly", day_of_week: "wednesday" } as any);
    assert.equal(out, "Every 4 weeks on Wednesdays");
    assert.ok(!/\bthe \d/.test(out), "must never name a day of the month");
  });

  it("monthly with an empty days_of_month array still reads as Every 4 weeks", () => {
    assert.equal(
      describeCadence({ ...base, frequency: "monthly", day_of_week: "wednesday", days_of_month: [] } as any),
      "Every 4 weeks on Wednesdays",
    );
  });

  it("monthly WITH days_of_month names the day of the month", () => {
    assert.equal(describeCadence({ ...base, frequency: "monthly", days_of_month: [15] } as any),
      "Monthly on the 15th");
  });

  it("twice a month names both anchors", () => {
    assert.equal(describeCadence({ ...base, frequency: "semi_monthly", days_of_month: [1, 15] } as any),
      "Twice a month on the 1st and 15th");
  });

  it("monthly_weekday names which weekday of the month", () => {
    assert.equal(
      describeCadence({ ...base, frequency: "monthly_weekday", day_of_week: "thursday", week_of_month: 2 } as any),
      "Monthly on the 2nd Thursday",
    );
  });

  it("monthly_weekday week 5 reads as last", () => {
    assert.equal(
      describeCadence({ ...base, frequency: "monthly_weekday", day_of_week: "friday", week_of_month: 5 } as any),
      "Monthly on the last Friday",
    );
  });

  it("monthly_weekday honors a month interval", () => {
    assert.equal(
      describeCadence({ ...base, frequency: "monthly_weekday", day_of_week: "friday", week_of_month: 1, month_interval: 2 } as any),
      "Every 2 months on the 1st Friday",
    );
  });

  it("custom_days lists every weekday it covers", () => {
    assert.equal(describeCadence({ ...base, frequency: "custom_days", days_of_week: [3, 6] } as any),
      "Wednesdays and Saturdays each week");
  });

  it("weekdays and daily already say which days they mean", () => {
    assert.equal(describeCadence({ ...base, frequency: "weekdays" } as any), "Weekdays");
    assert.equal(describeCadence({ ...base, frequency: "daily" } as any), "Daily");
  });

  it("a custom cadence renders its interval, never a bare Custom", () => {
    assert.equal(frequencyLabel("custom", 6), "Every 6 weeks");
    assert.equal(frequencyLabel("custom", 1), "Weekly");
    assert.equal(describeCadence({ ...base, frequency: "custom", custom_frequency_weeks: 6, day_of_week: "monday" } as any),
      "Every 6 weeks on Mondays");
  });

  it("falls back to the frequency alone when no weekday is known", () => {
    assert.equal(describeCadence({ ...base, frequency: "weekly" } as any), "Weekly");
  });

  it("never returns an empty string", () => {
    assert.notEqual(describeCadence({ ...base, frequency: "who_knows" } as any), "");
  });
});
