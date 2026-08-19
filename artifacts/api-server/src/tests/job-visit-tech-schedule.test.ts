/**
 * [no-visit 2026-08-19] Maribel: "Very important. When we skip a service with
 * fee, it doesn't disappear from the cleaners schedule." — "They can still see
 * it."
 *
 * Peggy Hanlon, every-2-weeks visit #10, 1:00–4:00 PM, job notes reading
 * `[cancel_fee_charged: $195.00 (100%)]`, still sitting on the cleaner's day
 * with allowed hours, an arrival window, Add note and Before Photos.
 *
 * A CHARGED cancellation is stored as status='complete' so the fee reaches
 * revenue; a FREE one is stored as status='cancelled', which the tech app
 * already greys out. So the charged case — bills the customer, sends nobody —
 * was the single case the cleaner's screen could not recognise.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NO_VISIT_ACTIONS, CHARGING_ACTIONS, CANCEL_ACTIONS } from "../lib/cancellation-policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const tech = read("../routes/tech.ts");
const jobs = read("../routes/jobs.ts");
const dispatch = read("../routes/dispatch.ts");
const cancellation = read("../routes/cancellation.ts");
const jobVisit = read("../lib/job-visit.ts");

describe("NO_VISIT_ACTIONS — nobody drives there", () => {
  it("covers every action that calls the visit off", () => {
    for (const a of ["skip", "cancel", "lockout", "cancel_service"] as const) {
      assert.ok(NO_VISIT_ACTIONS.has(a), `${a} means no cleaner goes`);
    }
  });

  it("leaves move and bump alone — that visit still happens", () => {
    assert.ok(!NO_VISIT_ACTIONS.has("move"), "a moved visit must show on its new day");
    assert.ok(!NO_VISIT_ACTIONS.has("bump"));
  });

  it("is NOT the same question as whether the customer was charged", () => {
    // The distinction is the bug. A charged cancel bills $195 and sends no one;
    // a free skip bills nothing and also sends no one. Both come off the
    // schedule; only one shows in revenue.
    assert.ok(NO_VISIT_ACTIONS.has("cancel") && CHARGING_ACTIONS.has("cancel"));
    assert.ok(NO_VISIT_ACTIONS.has("skip") && !CHARGING_ACTIONS.has("skip"));
  });

  it("names only real actions", () => {
    for (const a of NO_VISIT_ACTIONS) assert.ok(CANCEL_ACTIONS.includes(a), `${a} is not a cancel action`);
  });
});

describe("the predicate asks the log, not the status column", () => {
  it("reads cancellation_log", () => {
    assert.ok(jobVisit.includes("FROM cancellation_log cl"));
    assert.ok(jobVisit.includes("cl.cancel_action IN"));
  });

  it("does not key on jobs.status", () => {
    // status is overloaded — 'complete' means both "cleaned" and "billed a fee
    // for nothing" — which is exactly why this bug existed.
    const fn = jobVisit.slice(jobVisit.indexOf("export function jobVisitStillHappens"));
    assert.ok(!/status/.test(fn), "status cannot distinguish a charged cancellation from a real visit");
  });

  it("builds its IN list from NO_VISIT_ACTIONS rather than a literal", () => {
    assert.ok(jobVisit.includes("NO_VISIT_ACTIONS"), "one definition, or the two lists drift");
  });
});

describe("both cleaner-facing schedules filter; office surfaces do not", () => {
  it("/api/tech/today (My Day) filters", () => {
    const route = tech.slice(tech.indexOf('router.get("/today"'), tech.indexOf('router.get("/scorecard"'));
    assert.ok(route.includes("jobVisitStillHappens(jobsTable.id, userId)"));
  });

  it("/api/jobs/my-jobs filters", () => {
    const route = jobs.slice(jobs.indexOf('router.get("/my-jobs"'));
    const where = route.slice(0, route.indexOf(".orderBy(jobsTable.scheduled_time)"));
    assert.ok(where.includes("jobVisitStillHappens(jobsTable.id, userId)"));
  });

  it("the dispatch board does NOT — the office has to see a charged cancellation", () => {
    assert.ok(
      !dispatch.includes("jobVisitStillHappens"),
      "dispatch renders the charged_cancel badge and the fee; hiding it there would lose the money",
    );
  });
});

describe("reopen puts the job back", () => {
  it("deletes the same four log actions this filter reads", () => {
    // If these lists disagree, a reopened job stays invisible to the cleaner it
    // was just handed back to.
    const reopen = cancellation.slice(cancellation.indexOf("DELETE FROM cancellation_log"));
    for (const a of NO_VISIT_ACTIONS) {
      assert.ok(reopen.includes(`'${a}'`), `reopen must clear a '${a}' row or the job never comes back`);
    }
  });
});

describe("a tech who is already clocked in keeps the job", () => {
  // A lockout is discovered ON SITE — the crew may already be punched in when
  // the office records it. Hiding the job then would strand an open punch, and
  // an open punch BLOCKS the next clock-in ("You're still clocked in at …",
  // the one-clock-at-a-time rule), so they'd have to phone the office to get
  // to their next house.
  it("the predicate has an open-punch escape hatch", () => {
    const fn = jobVisit.slice(jobVisit.indexOf("export function jobVisitStillHappens"));
    assert.ok(fn.includes("FROM timeclock tc"), "an unclosed punch keeps the job visible");
    assert.ok(fn.includes("tc.clock_out_at IS NULL"));
    assert.ok(fn.includes("OR EXISTS"), "it must widen the filter, not narrow it");
  });

  it("scopes the hatch to the tech holding the punch", () => {
    const fn = jobVisit.slice(jobVisit.indexOf("export function jobVisitStillHappens"));
    assert.ok(fn.includes("tc.user_id = ${userId}"), "a teammate's open punch must not resurrect it for everyone");
  });

  it("both routes pass the viewing tech", () => {
    assert.ok(tech.includes("jobVisitStillHappens(jobsTable.id, userId)"));
    assert.ok(jobs.includes("jobVisitStillHappens(jobsTable.id, userId)"));
  });
});

describe("the cleaner still gets paid for it", () => {
  it("cancellation pay is its own additional_pay row, not the job card", () => {
    // Hiding the job must not hide the money: a charged cancellation writes a
    // 'cancellation_pay' row naming the client and job, which the pay screens
    // read independently of the schedule.
    assert.ok(cancellation.includes("'cancellation_pay'"));
    assert.ok(cancellation.includes("INSERT INTO additional_pay"));
  });
});
