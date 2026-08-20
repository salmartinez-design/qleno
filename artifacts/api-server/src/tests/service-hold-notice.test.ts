// [hold-allowance 2026-08-20] Unit tests for the notice-period math behind
// service holds.
//
// The rule these protect: when a hold that counted as the client's notice runs
// out without a resume, we bill the visits THEIR OWN schedule would have had in
// the final notice window. Not one flat visit. Sal's words: "for a client where
// we're going out every week we're still gonna bill them about four additional
// services, biweekly or semi-monthly two or so, sometimes maybe three depending
// on the month, and for monthly just one more" — and then, decisively,
// "shouldnt it depend on the month and year they quit".
//
// So the count is a calendar question, not a constant, and these tests pin that
// down with real dates. A regression that flattens this to "one final visit"
// undercharges a weekly client by roughly four visits every time.
//
//   DATABASE_URL=postgres://stub@stub/stub tsx --test src/tests/service-hold-notice.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateCadenceDates, type CadenceInput } from "../lib/recurring-cadences.js";
import { shiftYmd, inclusiveDays, ymdToDate, dateToYmd, ymdToDayStart, ymdToDayEnd } from "../lib/service-hold.js";

// Mirrors quoteNoticeVisits: the window is the last `noticeDays` days of the
// hold, inclusive of BOTH the first day and the hold's end date.
function noticeWindow(endYmd: string, noticeDays = 30) {
  const startYmd = shiftYmd(endYmd, -(noticeDays - 1));
  return { startYmd, endYmd, start: ymdToDayStart(startYmd), end: ymdToDayEnd(endYmd) };
}

function visitsInNotice(schedule: CadenceInput, endYmd: string, noticeDays = 30): string[] {
  const w = noticeWindow(endYmd, noticeDays);
  return generateCadenceDates(schedule, w.start, w.end).map(dateToYmd);
}

describe("notice window", () => {
  it("is inclusive of both ends and exactly the notice length", () => {
    const w = noticeWindow("2026-10-09", 30);
    assert.equal(w.startYmd, "2026-09-10");
    assert.equal(inclusiveDays(w.startYmd, w.endYmd), 30);
  });

  it("crosses a month boundary without losing a day", () => {
    assert.equal(inclusiveDays("2026-09-10", "2026-10-09"), 30);
    // Leap-year February is the classic off-by-one.
    assert.equal(inclusiveDays("2028-02-01", "2028-03-01"), 30);
  });
});

describe("notice visits follow the client's own cadence", () => {
  it("weekly bills about four visits", () => {
    const weeklyFri: CadenceInput = { frequency: "weekly", day_of_week: "friday", start_date: "2026-01-02" };
    assert.deepEqual(visitsInNotice(weeklyFri, "2026-10-08"), [
      "2026-09-11", "2026-09-18", "2026-09-25", "2026-10-02",
    ]);
  });

  it("weekly bills five when the calendar puts five service days in the window", () => {
    // Same client, hold ending one day later. The extra Friday IS a visit they
    // would have received, so it IS billed. This is the "about four" in Sal's
    // description behaving like a real calendar rather than a constant.
    const weeklyFri: CadenceInput = { frequency: "weekly", day_of_week: "friday", start_date: "2026-01-02" };
    assert.equal(visitsInNotice(weeklyFri, "2026-10-09").length, 5);
  });

  it("biweekly bills two", () => {
    const biweeklyWed: CadenceInput = { frequency: "biweekly", day_of_week: "wednesday", start_date: "2026-01-07" };
    assert.deepEqual(visitsInNotice(biweeklyWed, "2026-10-07"), ["2026-09-16", "2026-09-30"]);
  });

  it("semi-monthly bills two or one depending where the window lands", () => {
    const semi: CadenceInput = {
      frequency: "semi_monthly", day_of_week: null, days_of_month: [1, 15], start_date: "2026-01-01",
    };
    assert.deepEqual(visitsInNotice(semi, "2026-10-15"), ["2026-10-01", "2026-10-15"]);
    // A hold ending Oct 31 opens the window on Oct 2, past that month's 1st, so
    // only the 15th falls inside. Same client, same cadence, different month.
    assert.deepEqual(visitsInNotice(semi, "2026-10-31"), ["2026-10-15"]);
  });

  it("every-four-weeks bills one", () => {
    // frequency='monthly' with NO days_of_month is the residential
    // "Every 4 weeks" cadence — weekday-anchored, 28 day walk.
    const everyFour: CadenceInput = { frequency: "monthly", day_of_week: "wednesday", start_date: "2026-01-07" };
    assert.deepEqual(visitsInNotice(everyFour, "2026-10-07"), ["2026-09-16"]);
  });

  it("counts a visit that lands on the FIRST day of the window", () => {
    // [notice-window-boundary 2026-08-20] The window opens on Fri Sep 25 and
    // that is a service day. Bounding the replay at noon instead of midnight
    // dropped it, quietly undercharging a whole visit. Both edges are inclusive.
    const weeklyFri: CadenceInput = { frequency: "weekly", day_of_week: "friday", start_date: "2026-01-02" };
    assert.deepEqual(visitsInNotice(weeklyFri, "2026-10-08", 14), ["2026-09-25", "2026-10-02"]);
  });

  it("counts a visit that lands on the LAST day of the window", () => {
    const weeklyFri: CadenceInput = { frequency: "weekly", day_of_week: "friday", start_date: "2026-01-02" };
    const dates = visitsInNotice(weeklyFri, "2026-10-09", 30);
    assert.equal(dates[dates.length - 1], "2026-10-09");
  });

  it("a shorter notice period bills fewer visits", () => {
    const weeklyFri: CadenceInput = { frequency: "weekly", day_of_week: "friday", start_date: "2026-01-02" };
    assert.equal(visitsInNotice(weeklyFri, "2026-10-08", 14).length, 2);
    assert.equal(visitsInNotice(weeklyFri, "2026-10-08", 30).length, 4);
  });

  it("the same cadence quits in a different month and bills a different count", () => {
    // Sal: "shouldnt it depend on the month and year they quit". It does.
    const semi: CadenceInput = {
      frequency: "semi_monthly", day_of_week: null, days_of_month: [1, 15], start_date: "2026-01-01",
    };
    const counts = ["2026-10-15", "2026-10-31"].map((e) => visitsInNotice(semi, e).length);
    assert.notEqual(counts[0], counts[1]);
  });
});

describe("date helpers", () => {
  it("shiftYmd walks calendar days across month and year ends", () => {
    assert.equal(shiftYmd("2026-01-01", -1), "2025-12-31");
    assert.equal(shiftYmd("2026-12-31", 1), "2027-01-01");
    assert.equal(shiftYmd("2028-02-28", 1), "2028-02-29"); // leap year
  });

  it("ymdToDate / dateToYmd round-trip without drifting a day", () => {
    for (const d of ["2026-01-01", "2026-07-14", "2026-11-01", "2026-12-31"]) {
      assert.equal(dateToYmd(ymdToDate(d)), d);
    }
  });
});
