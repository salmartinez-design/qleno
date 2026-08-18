/**
 * [2026-08-18] Francisco, on job 20994: "hours and time clock are not giving the
 * right info" — Allowed 3.0h / Actual 0.0h / Variance -3.0h, printed directly
 * above a clock reading 9:45 AM - 1:46 PM.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const timeclock = read("../routes/timeclock.ts");
const jobs = read("../routes/jobs.ts");
const index = read("../index.ts");
const panel = read("../../../qleno/src/pages/jobs.tsx");

describe("actual_hours: unknown is NULL, never 0", () => {
  it("the recompute returns NULL when no punch is closed", () => {
    // GREATEST ignores NULL in Postgres, so GREATEST(NULL, 0) = 0 — that is
    // how "nobody has clocked out yet" got stamped as "worked no time".
    const fn = timeclock.slice(
      timeclock.indexOf("async function recomputeJobActualHours"),
      timeclock.indexOf('router.get("/", requireAuth'),
    );
    assert.ok(fn.includes("CASE WHEN COUNT(*) = 0 THEN NULL"), "the empty case must stay unknown");
    assert.ok(fn.includes("GREATEST"), "an inverted pair must still clamp at 0, not go negative");
  });

  it("the reopen path in jobs.ts uses the identical expression", () => {
    const block = jobs.slice(jobs.indexOf("[reopen] hours recompute non-fatal") - 1400);
    assert.ok(block.includes("CASE WHEN COUNT(*) = 0 THEN NULL"), "the two copies must not drift");
  });
});

describe("the field clock-out writes the hours it just measured", () => {
  it("calls the recompute", () => {
    const route = timeclock.slice(
      timeclock.indexOf('router.post("/:id/clock-out"'),
      timeclock.indexOf('router.patch("/:id/unflag"'),
    );
    assert.ok(route.length > 0, "clock-out route not found — anchors moved");
    assert.ok(
      route.includes("await recomputeJobActualHours(updated.job_id"),
      "the app's clock-out is how nearly every punch closes; without this jobs.actual_hours never advances",
    );
  });
});

describe("existing wrong rows are repaired, narrowly", () => {
  const repair = index.slice(index.indexOf("[actual-hours-repair 2026-08-18]"), index.indexOf('recordStartupFailure("repairJobActualHours"'));

  it("only touches rows that are NULL or 0", () => {
    assert.ok(repair.includes("j.actual_hours IS NULL OR j.actual_hours = 0"));
  });

  it("never overwrites a real value with a zero", () => {
    assert.ok(repair.includes("tc.h > 0"), "no closed span, no write");
  });

  it("recomputes from the clock entries rather than estimating", () => {
    assert.ok(repair.includes("FROM timeclock"));
    assert.ok(repair.includes("clock_out_at IS NOT NULL"));
  });
});

describe("the panel stops trusting a stale zero", () => {
  it("falls back to the clock pair when the stored value is 0", () => {
    const block = panel.slice(panel.indexOf("const clockSpan ="), panel.indexOf("if (allowed == null && actual == null"));
    assert.ok(block.includes("actual === 0"), "a 0 beside a real closed punch is a stamp, not an answer");
    assert.ok(block.includes("clockSpan > 0"), "and a genuinely zero-length punch stays 0");
  });
});
