/**
 * Cutover 3A — Availability + leave catalog + request workflow +
 * blackouts + unexcused ladder.
 *
 * Pure tests against the lib helpers. The route's DB I/O is
 * exercised indirectly via the helpers it composes + via file-grep
 * on the route source for the load-bearing invariants.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  computeCurrentBalance,
  applyReset,
  accrueFromWorkedHours,
  isPastWaitingPeriod,
} from "../lib/leave-balance.js";
import {
  checkRequestable,
  checkWaitingPeriod,
  checkBalance,
  detectBlackoutOverlap,
  datesOverlap,
  type BucketForValidation,
} from "../lib/leave-request-rules.js";
import {
  evaluateLadder,
  type UnexcusedStep,
  type UnexcusedEntry,
} from "../lib/unexcused-ladder.js";
import {
  evaluateUseItOrLoseItAlert,
  nextAnniversary,
  nextCalendarYearReset,
} from "../lib/leave-alerts.js";

// ─────────────────────────────────────────────────────────────────────────────
// A. Balance + accrual math
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 3A — balance math (current available)", () => {
  it("granted 40 used 10 → available 30", () => {
    assert.deepEqual(
      computeCurrentBalance({
        accrual_mode: "flat_grant",
        granted_hours: 40,
        used_hours: 10,
        annual_cap_hours: 40,
      }),
      { granted: 40, used: 10, available: 30 },
    );
  });
  it("never goes negative", () => {
    const b = computeCurrentBalance({
      accrual_mode: "flat_grant",
      granted_hours: 10,
      used_hours: 99,
      annual_cap_hours: 40,
    });
    assert.equal(b.available, 0);
  });
});

describe("Cutover 3A — accrue_per_hours math (PLAWA)", () => {
  it("1 hour per 40 worked, 200 hours worked = 5 accrued, capped at 40", () => {
    assert.equal(accrueFromWorkedHours(200, 1 / 40, 40), 5);
    assert.equal(accrueFromWorkedHours(2000, 1 / 40, 40), 40); // hits cap
    assert.equal(accrueFromWorkedHours(0, 1 / 40, 40), 0);
    assert.equal(accrueFromWorkedHours(80, 1 / 40, 40), 2);
  });
});

describe("Cutover 3A — PTO ceiling at reset", () => {
  // The Phes scenario the user described, plus the canonical
  // forfeiture case.
  const PHES_PTO = {
    accrual_mode: "flat_grant" as const,
    annual_cap_hours: 40,
    carryover_allowed: true,
    balance_ceiling_hours: 80,
  };

  it("prior 40 + 40 grant capped at 80 (no forfeit)", () => {
    const r = applyReset({ ...PHES_PTO, prior_balance: 40 });
    assert.equal(r.new_granted, 80);
    assert.equal(r.forfeited_hours, 0);
  });
  it("prior 60 + 40 grant capped at 80, FORFEITS 20", () => {
    const r = applyReset({ ...PHES_PTO, prior_balance: 60 });
    assert.equal(r.new_granted, 80);
    assert.equal(r.forfeited_hours, 20);
  });
  it("prior 0 + 40 grant = 40 (no forfeit, room below ceiling)", () => {
    const r = applyReset({ ...PHES_PTO, prior_balance: 0 });
    assert.equal(r.new_granted, 40);
    assert.equal(r.forfeited_hours, 0);
  });
  it("prior 90 + 40 grant: carryover capped at ceiling 80 first, then +40 capped → forfeits 50", () => {
    const r = applyReset({ ...PHES_PTO, prior_balance: 90 });
    assert.equal(r.new_granted, 80);
    assert.equal(r.forfeited_hours, 50);
  });
  it("carryover disallowed → grant only; ceiling still applies", () => {
    const r = applyReset({
      ...PHES_PTO,
      carryover_allowed: false,
      prior_balance: 30,
    });
    assert.equal(r.new_granted, 40); // pre_grant=0, +grant=40
    assert.equal(r.forfeited_hours, 0);
  });
  it("office_recorded resets to cap; no forfeit semantics", () => {
    const r = applyReset({
      accrual_mode: "office_recorded",
      annual_cap_hours: 40,
      carryover_allowed: false,
      balance_ceiling_hours: 80,
      prior_balance: 10,
    });
    assert.equal(r.new_granted, 40);
    assert.equal(r.forfeited_hours, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Waiting period
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 3A — waiting period gate", () => {
  it("0-day waiting period: always past", () => {
    assert.equal(isPastWaitingPeriod("2026-05-29", 0, "2026-05-29"), true);
  });
  it("90-day PLAWA: hired 2026-03-01 → on 2026-05-29 past (89 days? check)", () => {
    // 2026-03-01 to 2026-05-29 = 89 days → NOT past 90
    assert.equal(isPastWaitingPeriod("2026-03-01", 90, "2026-05-29"), false);
    // 2026-03-01 to 2026-05-30 = 90 days → exactly past
    assert.equal(isPastWaitingPeriod("2026-03-01", 90, "2026-05-30"), true);
  });
  it("365-day PTO: hired exactly a year ago → past", () => {
    assert.equal(isPastWaitingPeriod("2025-05-29", 365, "2026-05-29"), true);
    assert.equal(isPastWaitingPeriod("2025-05-30", 365, "2026-05-29"), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Request validation rules
// ─────────────────────────────────────────────────────────────────────────────

const PTO_BUCKET: BucketForValidation = {
  requestable: true,
  waiting_period_days: 365,
  accrual_mode: "flat_grant",
  exempt_from_blackout: false,
  display_name: "PTO",
};
const PLAWA_BUCKET: BucketForValidation = {
  requestable: true,
  waiting_period_days: 90,
  accrual_mode: "accrue_per_hours",
  exempt_from_blackout: true,
  display_name: "PLAWA",
};
const UNEXCUSED_BUCKET: BucketForValidation = {
  requestable: false,
  waiting_period_days: 0,
  accrual_mode: "office_recorded",
  exempt_from_blackout: false,
  display_name: "Unexcused",
};

describe("Cutover 3A — request validation", () => {
  it("non-requestable bucket refuses with bucket_not_requestable", () => {
    const r = checkRequestable(UNEXCUSED_BUCKET);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "bucket_not_requestable");
  });

  it("waiting period blocks early request", () => {
    const r = checkWaitingPeriod(PTO_BUCKET, "2026-05-29", "2026-08-01");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "before_waiting_period");
  });

  it("waiting period passes when past", () => {
    const r = checkWaitingPeriod(PTO_BUCKET, "2024-05-29", "2026-05-29");
    assert.equal(r.ok, true);
  });

  it("missing hire date is a clear failure, not a silent allow", () => {
    const r = checkWaitingPeriod(PTO_BUCKET, null, "2026-05-29");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "missing_hire_date");
  });

  it("over-balance request is refused", () => {
    const r = checkBalance(PTO_BUCKET, 50, 40);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "over_balance");
  });

  it("non-positive hours refused", () => {
    const r = checkBalance(PTO_BUCKET, 0, 40);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "non_positive_hours");
  });

  it("balance check is a no-op for office_recorded bucket", () => {
    const r = checkBalance(UNEXCUSED_BUCKET, 99, 0);
    assert.equal(r.ok, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Blackout overlap detection
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 3A — blackout overlap", () => {
  const HOLIDAY = {
    start_date: "2026-12-23",
    end_date: "2026-12-30",
    label: "Holiday week — all hands",
  };

  it("datesOverlap is inclusive on both endpoints", () => {
    assert.equal(datesOverlap("2026-05-20", "2026-05-25", "2026-05-25", "2026-05-30"), true);
    assert.equal(datesOverlap("2026-05-20", "2026-05-25", "2026-05-26", "2026-05-30"), false);
  });

  it("request inside the blackout overlaps + fully_inside", () => {
    const o = detectBlackoutOverlap("2026-12-24", "2026-12-26", [HOLIDAY]);
    assert.equal(o.overlaps, true);
    if (o.overlaps) {
      assert.equal(o.fully_inside, true);
      assert.equal(o.spans_outside, false);
      assert.equal(o.blackout.label, HOLIDAY.label);
    }
  });

  it("request spanning blackout + open days overlaps + spans_outside", () => {
    const o = detectBlackoutOverlap("2026-12-20", "2026-12-27", [HOLIDAY]);
    assert.equal(o.overlaps, true);
    if (o.overlaps) {
      assert.equal(o.fully_inside, false);
      assert.equal(o.spans_outside, true);
    }
  });

  it("request before the blackout does NOT overlap", () => {
    const o = detectBlackoutOverlap("2026-12-15", "2026-12-22", [HOLIDAY]);
    assert.equal(o.overlaps, false);
  });

  it("first matching blackout is returned", () => {
    const o = detectBlackoutOverlap(
      "2026-12-24",
      "2026-12-26",
      [
        { start_date: "2026-07-04", end_date: "2026-07-05", label: "Independence" },
        HOLIDAY,
      ],
    );
    assert.equal(o.overlaps, true);
    if (o.overlaps) assert.equal(o.blackout.label, HOLIDAY.label);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Unexcused-hours ladder
// ─────────────────────────────────────────────────────────────────────────────

const PHES_LADDER: UnexcusedStep[] = [
  { threshold_hours: 8, window_days: 90, discipline_type: "tardy_warning", notify: true, label: "Written warning" },
  { threshold_hours: 16, window_days: 90, discipline_type: "final_warning", notify: true, label: "Final warning" },
  { threshold_hours: 24, window_days: 90, discipline_type: "termination", notify: true, label: "Termination review" },
];

describe("Cutover 3A — unexcused-hours ladder", () => {
  it("no entries → no step", () => {
    const out = evaluateLadder(PHES_LADDER, [], "2026-05-29", new Set());
    assert.equal(out.triggered_step, null);
  });

  it("8 hours in window → tardy_warning fires", () => {
    const entries: UnexcusedEntry[] = [
      { date: "2026-04-01", hours: 4 },
      { date: "2026-05-01", hours: 4 },
    ];
    const out = evaluateLadder(PHES_LADDER, entries, "2026-05-29", new Set());
    assert.ok(out.triggered_step);
    assert.equal(out.triggered_step!.discipline_type, "tardy_warning");
    assert.equal(out.cumulative_hours, 8);
  });

  it("16 hours in window → fires the HIGHEST eligible (final_warning)", () => {
    const entries: UnexcusedEntry[] = [
      { date: "2026-04-01", hours: 8 },
      { date: "2026-05-01", hours: 8 },
    ];
    const out = evaluateLadder(PHES_LADDER, entries, "2026-05-29", new Set());
    assert.equal(out.triggered_step!.discipline_type, "final_warning");
  });

  it("already-fired threshold is NOT re-fired (idempotent)", () => {
    const entries: UnexcusedEntry[] = [
      { date: "2026-04-01", hours: 4 },
      { date: "2026-05-01", hours: 4 },
    ];
    const out = evaluateLadder(
      PHES_LADDER,
      entries,
      "2026-05-29",
      new Set([8]),
    );
    assert.equal(out.triggered_step, null);
  });

  it("entries outside the window are excluded", () => {
    // 91 days old > 90-day window
    const entries: UnexcusedEntry[] = [
      { date: "2026-02-27", hours: 4 },
      { date: "2026-05-29", hours: 4 },
    ];
    const out = evaluateLadder(PHES_LADDER, entries, "2026-05-29", new Set());
    // Only 4 hours in window → below threshold of 8
    assert.equal(out.triggered_step, null);
    assert.equal(out.cumulative_hours, 0); // no step crossed
  });

  it("empty ladder disabled = no fires", () => {
    const entries: UnexcusedEntry[] = [{ date: "2026-05-29", hours: 99 }];
    const out = evaluateLadder([], entries, "2026-05-29", new Set());
    assert.equal(out.triggered_step, null);
  });

  it("tenant-configurable — different thresholds work the same way", () => {
    const tenantLadder: UnexcusedStep[] = [
      { threshold_hours: 4, window_days: 30, discipline_type: "custom", notify: false, label: "Verbal coaching" },
    ];
    const out = evaluateLadder(
      tenantLadder,
      [{ date: "2026-05-25", hours: 4 }],
      "2026-05-29",
      new Set(),
    );
    assert.equal(out.triggered_step!.discipline_type, "custom");
    assert.equal(out.triggered_step!.notify, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. Use-it-or-lose-it alerts
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 3A — use-it-or-lose-it alerts", () => {
  it("nextAnniversary: hire 2024-08-15, today 2026-05-29 → 2026-08-15", () => {
    assert.equal(nextAnniversary("2024-08-15", "2026-05-29"), "2026-08-15");
  });
  it("nextAnniversary: today is AFTER this year's anniversary → next year", () => {
    assert.equal(nextAnniversary("2024-03-10", "2026-05-29"), "2027-03-10");
  });
  it("nextCalendarYearReset: today is mid-year → Dec 31 same year", () => {
    assert.equal(nextCalendarYearReset("2026-05-29"), "2026-12-31");
  });
  it("nextCalendarYearReset: today is Jan 1 → Dec 31 same year", () => {
    assert.equal(nextCalendarYearReset("2026-01-01"), "2026-12-31");
  });

  it("anniversary-basis alert fires within lead_days (60)", () => {
    // Today 2026-05-29, hired 2024-07-15 → next anniversary 2026-07-15
    // = 47 days out → within 60 → fires.
    const a = evaluateUseItOrLoseItAlert({
      reset_basis: "work_anniversary",
      hire_date: "2024-07-15",
      today: "2026-05-29",
      lead_days: 60,
    });
    assert.equal(a.should_alert, true);
    assert.equal(a.next_reset, "2026-07-15");
    assert.equal(a.days_until_reset, 47);
  });

  it("anniversary-basis alert does NOT fire when too far out", () => {
    // Today 2026-01-15, hired 2024-07-15 → next anniversary 2026-07-15
    // = 181 days out → way past 60 → silent.
    const a = evaluateUseItOrLoseItAlert({
      reset_basis: "work_anniversary",
      hire_date: "2024-07-15",
      today: "2026-01-15",
      lead_days: 60,
    });
    assert.equal(a.should_alert, false);
  });

  it("calendar_year alert fires within lead_days of Dec 31", () => {
    const a = evaluateUseItOrLoseItAlert({
      reset_basis: "calendar_year",
      hire_date: null,
      today: "2026-11-15",
      lead_days: 60,
    });
    assert.equal(a.should_alert, true);
    assert.equal(a.next_reset, "2026-12-31");
  });

  it("anniversary alert requires hire_date — no silent allow when missing", () => {
    const a = evaluateUseItOrLoseItAlert({
      reset_basis: "work_anniversary",
      hire_date: null,
      today: "2026-05-29",
      lead_days: 60,
    });
    assert.equal(a.should_alert, false);
    assert.equal(a.next_reset, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. Schema + reuse invariants — make sure we did not repurpose existing
//    columns and existing schema we built ON is still intact
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 3A — schema + reuse invariants", () => {
  const hr = readFileSync(
    path.resolve(process.cwd(), "../../lib/db/src/schema/hr_policies.ts"),
    "utf8",
  );

  it("carryover_max_hours is UNTOUCHED — allowance model preserved", () => {
    // Definition still present with the original precision (8,2) +
    // default "0". This catches any repurposing of the column to mean
    // ceiling.
    assert.match(
      hr,
      /carryover_max_hours:\s*numeric\("carryover_max_hours",\s*\{\s*precision:\s*8,\s*scale:\s*2\s*\}\)\.default\("0"\)/,
    );
  });

  it("balance_ceiling_hours is a NEW column with default 80, distinct from carryover_max_hours", () => {
    assert.match(
      hr,
      /balance_ceiling_hours:\s*numeric\("balance_ceiling_hours",\s*\{\s*precision:\s*8,\s*scale:\s*2\s*\}\)\.default\("80"\)/,
    );
  });

  it("use_it_or_lose_it_alert_lead_days is a NEW column with default 60", () => {
    assert.match(
      hr,
      /use_it_or_lose_it_alert_lead_days:\s*integer\("use_it_or_lose_it_alert_lead_days"\)\.default\(60\)/,
    );
  });

  it("tardy_steps + absence_steps are UNTOUCHED (per-event ladders preserved)", () => {
    assert.match(hr, /tardy_steps:\s*jsonb\("tardy_steps"\)\.\$type<any\[\]>\(\)\.default\(\[\]\)/);
    assert.match(hr, /absence_steps:\s*jsonb\("absence_steps"\)\.\$type<any\[\]>\(\)\.default\(\[\]\)/);
  });

  it("unexcused_hours_steps is a NEW column (cumulative-hours ladder, NOT a repurpose)", () => {
    assert.match(
      hr,
      /unexcused_hours_steps:\s*jsonb\("unexcused_hours_steps"\)\.\$type<any\[\]>\(\)\.default\(\[\]\)/,
    );
  });

  it("new leave schema file exists and exports the five tables", () => {
    const leave = readFileSync(
      path.resolve(process.cwd(), "../../lib/db/src/schema/leave.ts"),
      "utf8",
    );
    for (const t of [
      "employeeAvailabilityTable",
      "leaveTypesTable",
      "employeeLeaveBalancesTable",
      "leaveRequestsTable",
      "leaveBlackoutsTable",
    ]) {
      assert.match(leave, new RegExp(`export const ${t}`));
    }
  });
});
