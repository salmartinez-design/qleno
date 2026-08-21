/**
 * The weekly bundle has to contain its own Friday.
 *
 * WHAT HAPPENED
 * -------------
 * National Able is billed weekly: every Mon-Fri visit is invoiced as it
 * completes, and one close folds the week into a single document that gets
 * emailed to their billing contact. On 2026-08-21 Maribel reported:
 *
 *   "for some reason Qleno is combining National Able's invoices on Friday,
 *    that for sure has to be something that was set up. The thing is it's not
 *    including Friday when it does."
 *
 * Both halves of that were correct. The bundling IS deliberate. And the bundle
 * really was missing its last day, every single week:
 *
 *   invoice 7344  Fri 08-07 11:00  $1680  Mon 8/3 - Thu 8/6   emailed
 *   invoice 7411  Fri 08-14 11:00  $1030  Mon 8/10 - Thu 8/13 emailed
 *   invoice 7466  Fri 08-21 11:00   $660  Tue 8/18 - Thu 8/20 emailed
 *
 * The Friday visit was then invoiced on its own that afternoon with nowhere to
 * go, and somebody in the office stitched the two together by hand afterwards
 * (7356 and 7413, both created by a real user hours after the automatic bill
 * had already left). A weekly repair job that nobody asked for.
 *
 * WHY
 * ---
 * The window is Mon-Fri and closes on its Friday. The close ran in the small
 * hours of that same Friday, when the Friday visit had not been worked yet, let
 * alone invoiced. `windowToClose` accepted the close date itself as "fully
 * elapsed" (`asOf >= close_date`), so Friday morning looked like a finished
 * week. It wasn't.
 *
 * The window arithmetic was never wrong - Mon-Fri is exactly right. The timing
 * was. A window is done when its last day is BEHIND us: the week closes
 * Saturday, the month closes on the 1st.
 *
 * These tests are pure date math, no database. They pin the one property that
 * matters: a close run can never bill a window whose last day is still being
 * worked.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { windowFor, windowToClose, windowsBetween } from "../lib/invoice-cadence.js";

// The week Maribel reported on. 2026-08-17 is a Monday, 2026-08-21 a Friday.
const MON = "2026-08-17";
const FRI = "2026-08-21";
const SAT = "2026-08-22";
const SUN = "2026-08-23";

describe("windowFor - the shape of the week is unchanged", () => {
  it("runs Monday through Friday", () => {
    const w = windowFor("weekly", "2026-08-19"); // a Wednesday
    assert.equal(w.start, MON);
    assert.equal(w.end, FRI);
    assert.equal(w.close_date, FRI);
  });

  it("puts Sunday with the week that just ended, not the one starting", () => {
    const w = windowFor("weekly", SUN);
    assert.equal(w.start, MON);
    assert.equal(w.end, FRI);
  });

  it("runs a month from the 1st to the last day", () => {
    const w = windowFor("monthly", "2026-08-14");
    assert.equal(w.start, "2026-08-01");
    assert.equal(w.end, "2026-08-31");
    assert.equal(w.close_date, "2026-08-31");
  });
});

describe("windowToClose - a week is not done until its Friday is", () => {
  it("does NOT close this week on the Friday itself - the National Able bug", () => {
    const w = windowToClose("weekly", FRI);
    assert.notEqual(
      w.start,
      MON,
      "closing the week on its own Friday is what left National Able's Friday visit off its weekly bill",
    );
    assert.equal(w.start, "2026-08-10", "on Friday the newest finished week is the one before");
    assert.equal(w.end, "2026-08-14");
  });

  it("closes the week on Saturday, Friday included", () => {
    const w = windowToClose("weekly", SAT);
    assert.equal(w.start, MON);
    assert.equal(w.end, FRI);
  });

  it("still points at that same week on Sunday, so a missed Saturday self-heals", () => {
    const w = windowToClose("weekly", SUN);
    assert.equal(w.start, MON);
    assert.equal(w.end, FRI);
  });

  it("mid-week, closes the week that ended - never the live one", () => {
    for (const day of ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20"]) {
      const w = windowToClose("weekly", day);
      assert.equal(w.end, "2026-08-14", `${day} must close the previous week`);
      assert.ok(w.close_date < day, `${day}: the close date has to already be behind us`);
    }
  });

  it("never returns a window whose close date has not passed, any day of the year", () => {
    const d = new Date(Date.UTC(2026, 0, 1));
    for (let i = 0; i < 400; i++) {
      const asOf = d.toISOString().slice(0, 10);
      for (const cadence of ["weekly", "monthly"] as const) {
        const w = windowToClose(cadence, asOf);
        assert.ok(
          w.close_date < asOf,
          `${cadence} on ${asOf} returned a window closing ${w.close_date} - that day is not over`,
        );
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
  });
});

describe("windowToClose - a month is not done until its last day is", () => {
  it("does NOT close August on August 31st", () => {
    const w = windowToClose("monthly", "2026-08-31");
    assert.equal(w.label, "2026-07", "the 31st is still a working day - August closes on September 1st");
  });

  it("closes August on September 1st", () => {
    const w = windowToClose("monthly", "2026-09-01");
    assert.equal(w.label, "2026-08");
    assert.equal(w.start, "2026-08-01");
    assert.equal(w.end, "2026-08-31");
  });
});

describe("windowsBetween - a backfill follows the same rule", () => {
  it("leaves out the week that is still running", () => {
    const weeks = windowsBetween("weekly", "2026-08-03", FRI);
    assert.deepEqual(
      weeks.map((w) => w.start),
      ["2026-08-03", "2026-08-10"],
      "the week ending on the range's own last day is not finished yet",
    );
  });

  it("takes that week in once it has ended", () => {
    const weeks = windowsBetween("weekly", "2026-08-03", SAT);
    assert.deepEqual(weeks.map((w) => w.start), ["2026-08-03", "2026-08-10", MON]);
  });
});
