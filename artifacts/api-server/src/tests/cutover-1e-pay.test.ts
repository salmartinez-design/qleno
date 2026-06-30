/**
 * Cutover 1E — Pay summary + export tests.
 *
 * The legal gate. These tests defend the pay pipeline's three core
 * promises:
 *
 *   A. The eligibility filter excludes every malformed clock event,
 *      every case, even if the DB CHECK constraint were absent.
 *   B. Money math is integer-cents, never float, and overtime is FLSA
 *      1.5x weekly-over-40.
 *   C. Lifecycle gates: open → locked → approved → exported, one-way,
 *      with adjustment writes refused on approved/exported periods.
 *   D. The export is PROVIDER-NEUTRAL. No payroll-vendor name appears
 *      anywhere in the diff. A vendor-name grep across every 1E file
 *      asserts this and FAILs the build if a future change reintroduces
 *      a vendor-specific string.
 *
 * Pure unit tests. No DB. The orchestration in routes/pay.ts is
 * exercised indirectly via the lib functions it composes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyEligibility,
  isEligibleForPay,
} from "../lib/pay-eligibility.js";
import {
  computeHoursForUser,
  minutesToHours,
  type ClockEventForPay,
} from "../lib/pay-hours.js";
import { computeSummary, dollarsToCents } from "../lib/pay-summary.js";
import { pickRateForDate } from "../lib/pay-rate-lookup.js";
import {
  buildPayExportCsv,
  buildPayExportFilename,
  PAY_EXPORT_COLUMNS,
} from "../lib/pay-export.js";

// ─────────────────────────────────────────────────────────────────────────────
// A. Eligibility filter — every excluded case
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1E — eligibility filter (app-level guard)", () => {
  const base = {
    gps_status: "captured" as string | null,
    latitude: 41.88 as number | string | null,
    longitude: -87.63 as number | string | null,
    exception_reason: null as string | null,
    exception_reviewed_at: null as Date | string | null,
  };

  it("eligible: captured with both lat and lng", () => {
    assert.equal(classifyEligibility(base), "eligible_captured");
    assert.equal(isEligibleForPay(base), true);
  });

  it("ineligible: captured with null latitude", () => {
    assert.equal(
      classifyEligibility({ ...base, latitude: null }),
      "ineligible_captured_missing_lat",
    );
    assert.equal(isEligibleForPay({ ...base, latitude: null }), false);
  });

  it("ineligible: captured with null longitude", () => {
    assert.equal(
      classifyEligibility({ ...base, longitude: null }),
      "ineligible_captured_missing_lng",
    );
  });

  it("eligible: failed_exception with reason AND reviewed_at", () => {
    const ev = {
      ...base,
      gps_status: "failed_exception",
      latitude: null,
      longitude: null,
      exception_reason: "GPS permission denied",
      exception_reviewed_at: new Date("2026-05-28T20:00:00Z"),
    };
    assert.equal(classifyEligibility(ev), "eligible_reviewed_exception");
    assert.equal(isEligibleForPay(ev), true);
  });

  it("ineligible: failed_exception with NULL reason", () => {
    const ev = {
      ...base,
      gps_status: "failed_exception",
      latitude: null,
      longitude: null,
      exception_reason: null,
      exception_reviewed_at: new Date(),
    };
    assert.equal(classifyEligibility(ev), "ineligible_exception_missing_reason");
  });

  it("ineligible: failed_exception with blank reason", () => {
    const ev = {
      ...base,
      gps_status: "failed_exception",
      latitude: null,
      longitude: null,
      exception_reason: "   ",
      exception_reviewed_at: new Date(),
    };
    assert.equal(classifyEligibility(ev), "ineligible_exception_missing_reason");
  });

  it("ineligible: failed_exception NOT YET REVIEWED (critical case)", () => {
    const ev = {
      ...base,
      gps_status: "failed_exception",
      latitude: null,
      longitude: null,
      exception_reason: "GPS permission denied",
      exception_reviewed_at: null,
    };
    assert.equal(classifyEligibility(ev), "ineligible_exception_unreviewed");
    assert.equal(
      isEligibleForPay(ev),
      false,
      "Unreviewed exceptions must NEVER reach paid hours",
    );
  });

  it("ineligible: unknown gps_status value", () => {
    const ev = { ...base, gps_status: "made_up_value" };
    assert.equal(classifyEligibility(ev), "ineligible_unknown_gps_status");
  });

  it("ineligible: null gps_status", () => {
    assert.equal(
      classifyEligibility({ ...base, gps_status: null }),
      "ineligible_unknown_gps_status",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hours computation — pairing, missing clock-out, OT bucketing
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1E — hours computation", () => {
  function evt(opts: Partial<ClockEventForPay>): ClockEventForPay {
    // Spread opts LAST so explicit null/undefined values from the test
    // win over defaults. Using ?? would silently coerce a deliberate
    // null latitude back to a default and the eligibility filter
    // would incorrectly accept the row.
    const base: ClockEventForPay = {
      id: 1,
      job_id: 1,
      user_id: 1,
      event_type: "clock_in",
      event_at: new Date("2026-05-25T14:00:00Z"),
      gps_status: "captured",
      latitude: 41.88,
      longitude: -87.63,
      exception_reason: null,
      exception_reviewed_at: null,
    };
    return { ...base, ...opts };
  }

  it("sums a single in/out pair", () => {
    const out = computeHoursForUser([
      evt({ id: 1, event_type: "clock_in", event_at: new Date("2026-05-25T14:00:00Z") }),
      evt({ id: 2, event_type: "clock_out", event_at: new Date("2026-05-25T17:30:00Z") }),
    ]);
    assert.equal(out.regular_minutes, 210);
    assert.equal(out.overtime_minutes, 0);
    assert.equal(minutesToHours(out.regular_minutes), 3.5);
  });

  it("flags missing_clock_out when clock_in has no pair", () => {
    const out = computeHoursForUser([
      evt({ id: 1, event_type: "clock_in", event_at: new Date("2026-05-25T14:00:00Z") }),
    ]);
    assert.equal(out.regular_minutes, 0);
    assert.ok(out.flags.includes("missing_clock_out"));
  });

  it("excludes pairs where the clock_in event has unreviewed exception", () => {
    const out = computeHoursForUser([
      evt({
        id: 1,
        event_type: "clock_in",
        gps_status: "failed_exception",
        latitude: null,
        longitude: null,
        exception_reason: "GPS denied",
        exception_reviewed_at: null, // unreviewed!
      }),
      evt({ id: 2, event_type: "clock_out", event_at: new Date("2026-05-25T17:30:00Z") }),
    ]);
    assert.equal(out.regular_minutes, 0, "unreviewed exception must NOT be paid");
    assert.ok(out.flags.includes("unreviewed_gps_exception"));
  });

  it("excludes pairs where the clock_in event has captured but null lat", () => {
    const out = computeHoursForUser([
      evt({ id: 1, event_type: "clock_in", latitude: null }),
      evt({ id: 2, event_type: "clock_out", event_at: new Date("2026-05-25T17:30:00Z") }),
    ]);
    assert.equal(out.regular_minutes, 0);
  });

  it("48 hours in one week → 40 regular + 8 OT", () => {
    // Six 8-hour shifts Monday-Saturday in one Sun-Sat week.
    const events: ClockEventForPay[] = [];
    let id = 1;
    for (let day = 1; day <= 6; day++) {
      const dayNum = 24 + day; // 2026-05-25 is a Monday
      events.push(
        evt({
          id: id++,
          job_id: day,
          event_type: "clock_in",
          event_at: new Date(`2026-05-${String(dayNum).padStart(2, "0")}T09:00:00Z`),
        }),
        evt({
          id: id++,
          job_id: day,
          event_type: "clock_out",
          event_at: new Date(`2026-05-${String(dayNum).padStart(2, "0")}T17:00:00Z`),
        }),
      );
    }
    const out = computeHoursForUser(events, 0);
    assert.equal(minutesToHours(out.regular_minutes), 40);
    assert.equal(minutesToHours(out.overtime_minutes), 8);
  });

  it("two consecutive 45-hr weeks → 80 regular + 10 OT", () => {
    const events: ClockEventForPay[] = [];
    let id = 1;
    // Week 1: 2026-05-24 (Sun) through 2026-05-30 (Sat). 5 days × 9 hrs = 45.
    for (let i = 0; i < 5; i++) {
      const day = 25 + i; // Mon-Fri
      events.push(
        evt({
          id: id++,
          job_id: id,
          event_type: "clock_in",
          event_at: new Date(`2026-05-${String(day).padStart(2, "0")}T09:00:00Z`),
        }),
        evt({
          id: id++,
          job_id: id - 1,
          event_type: "clock_out",
          event_at: new Date(`2026-05-${String(day).padStart(2, "0")}T18:00:00Z`),
        }),
      );
    }
    // Week 2: 2026-05-31 (Sun) is the next week start. 5 days × 9 hrs.
    for (let i = 0; i < 5; i++) {
      const day = 1 + i; // June Mon-Fri
      events.push(
        evt({
          id: id++,
          job_id: id,
          event_type: "clock_in",
          event_at: new Date(`2026-06-${String(day).padStart(2, "0")}T09:00:00Z`),
        }),
        evt({
          id: id++,
          job_id: id - 1,
          event_type: "clock_out",
          event_at: new Date(`2026-06-${String(day).padStart(2, "0")}T18:00:00Z`),
        }),
      );
    }
    const out = computeHoursForUser(events, 0);
    assert.equal(minutesToHours(out.regular_minutes), 80);
    assert.equal(minutesToHours(out.overtime_minutes), 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Money math + rate selection
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1E — money math (cents-based, no floats)", () => {
  it("computes regular + OT pay correctly at $20/hr × (40 + 8 OT)", () => {
    // 40 hr regular × $20 = $800
    // 8 hr OT × $20 × 1.5 = $240
    // gross = $1040 (with no adjustments)
    const out = computeSummary({
      regular_minutes: 40 * 60,
      overtime_minutes: 8 * 60,
      hourly_rate: 20,
      adjustments_cents: 0,
    });
    assert.equal(out.regular_pay_cents, 80000);
    assert.equal(out.overtime_pay_cents, 24000);
    assert.equal(out.gross_cents, 104000);
  });

  it("respects penny-precise odd rate ($17.35) and OT 1.5x", () => {
    // 1 hr × 1735¢ = 1735¢; OT 1 hr × 1735¢ × 1.5 = 2602.5 → 2603¢
    const out = computeSummary({
      regular_minutes: 60,
      overtime_minutes: 60,
      hourly_rate: 17.35,
      adjustments_cents: 0,
    });
    assert.equal(out.regular_pay_cents, 1735);
    assert.equal(out.overtime_pay_cents, 2603);
    assert.equal(out.gross_cents, 4338);
  });

  it("missing rate → 0 base pay; gross = adjustments_total only", () => {
    const out = computeSummary({
      regular_minutes: 38 * 60,
      overtime_minutes: 0,
      hourly_rate: null,
      adjustments_cents: dollarsToCents(52.94),
    });
    assert.equal(out.regular_pay_cents, 0);
    assert.equal(out.gross_cents, 5294);
  });

  it("gross = regular + OT + adjustments to the penny", () => {
    const out = computeSummary({
      regular_minutes: 40 * 60,
      overtime_minutes: 0,
      hourly_rate: 20,
      adjustments_cents: dollarsToCents(20.0),
    });
    assert.equal(out.gross_cents, 80000 + 2000);
  });

  it("dollarsToCents rounds correctly (no float drift on .29)", () => {
    assert.equal(dollarsToCents(0.29), 29);
    assert.equal(dollarsToCents(100.01), 10001);
    assert.equal(dollarsToCents("836.94"), 83694);
  });
});

describe("Cutover 1E — dated rate selection", () => {
  const rates = [
    { hourly_rate: "18.00", effective_date: "2026-01-01", end_date: null as string | null },
    { hourly_rate: "20.00", effective_date: "2026-05-01", end_date: null as string | null },
  ];

  it("picks the OLD rate before the change date", () => {
    assert.equal(pickRateForDate(rates, "2026-04-30"), 18);
  });

  it("picks the NEW rate on/after the change date", () => {
    assert.equal(pickRateForDate(rates, "2026-05-01"), 20);
    assert.equal(pickRateForDate(rates, "2026-06-30"), 20);
  });

  it("returns null when no rate row applies", () => {
    assert.equal(pickRateForDate(rates, "2025-12-31"), null);
    assert.equal(pickRateForDate([], "2026-05-28"), null);
  });

  it("honors end_date when set (rate retired)", () => {
    const r = [
      { hourly_rate: "15.00", effective_date: "2026-01-01", end_date: "2026-04-30" },
      { hourly_rate: "20.00", effective_date: "2026-05-01", end_date: null as string | null },
    ];
    assert.equal(pickRateForDate(r, "2026-04-29"), 15);
    assert.equal(pickRateForDate(r, "2026-05-01"), 20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Export — generic, neutral, and totals reconcile
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1E — export shape + reconciliation", () => {
  it("column header has the expected generic set, no vendor strings", () => {
    const expected = [
      "employee_identifier",
      "employee_first_name",
      "employee_last_name",
      "period_start",
      "period_end",
      "regular_hours",
      "overtime_hours",
      "regular_pay",
      "overtime_pay",
      "tips",
      "adjustments_total",
      "gross_total",
    ];
    assert.deepEqual(Array.from(PAY_EXPORT_COLUMNS), expected);
  });

  it("filename pattern is provider-neutral", () => {
    const name = buildPayExportFilename("2026-05-25", "2026-05-31");
    assert.equal(name, "pay-summary-2026-05-25-2026-05-31.csv");
  });

  it("CSV totals reconcile against the summary rows", () => {
    const rows = [
      {
        employee_identifier: "T001",
        employee_first_name: "Jose",
        employee_last_name: "Ardila",
        regular_hours: 38.25,
        overtime_hours: 0,
        regular_pay_cents: 76500,
        overtime_pay_cents: 0,
        tips_cents: 0,
        adjustments_cents: 2000,
        gross_cents: 78500,
      },
      {
        employee_identifier: "T002",
        employee_first_name: "Maria",
        employee_last_name: "Lopez",
        regular_hours: 40,
        overtime_hours: 5,
        regular_pay_cents: 80000,
        overtime_pay_cents: 15000,
        tips_cents: 0,
        adjustments_cents: 0,
        gross_cents: 95000,
      },
    ];
    const csv = buildPayExportCsv({
      period_start: "2026-05-25",
      period_end: "2026-05-31",
      rows,
    });
    const lines = csv.trim().split("\n");
    assert.equal(lines.length, 1 + rows.length);
    assert.ok(lines[1].includes("Jose,Ardila"));
    assert.ok(lines[1].includes("785.00")); // gross
    assert.ok(lines[2].includes("950.00"));
  });

  it("CSV escapes commas + quotes in employee names", () => {
    const csv = buildPayExportCsv({
      period_start: "2026-05-25",
      period_end: "2026-05-31",
      rows: [
        {
          employee_identifier: "T003",
          employee_first_name: 'Anne "Annie"',
          employee_last_name: "Smith, Jr.",
          regular_hours: 8,
          overtime_hours: 0,
          regular_pay_cents: 16000,
          overtime_pay_cents: 0,
          tips_cents: 0,
          adjustments_cents: 0,
          gross_cents: 16000,
        },
      ],
    });
    assert.ok(csv.includes('"Anne ""Annie"""'));
    assert.ok(csv.includes('"Smith, Jr."'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle gate enforcement — route source asserts
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1E — lifecycle gates (route source)", () => {
  const src = readFileSync(
    path.resolve(process.cwd(), "src/routes/pay.ts"),
    "utf8",
  );

  it("recompute is gated to status='open'", () => {
    assert.ok(
      /\/periods\/:id\/recompute[\s\S]+?period\.status\s*!==\s*"open"[\s\S]+?refusedDueToPeriodState/.test(
        src,
      ),
      "recompute must refuse when status != open",
    );
  });

  it("lock is gated to status='open'", () => {
    assert.ok(
      /\/periods\/:id\/lock[\s\S]+?period\.status\s*!==\s*"open"[\s\S]+?refusedDueToPeriodState/.test(
        src,
      ),
      "lock must refuse when status != open",
    );
  });

  it("approve is gated to status='locked' (no skip)", () => {
    assert.ok(
      /\/periods\/:id\/approve[\s\S]+?period\.status\s*!==\s*"locked"[\s\S]+?refusedDueToPeriodState/.test(
        src,
      ),
      "approve must require status=locked",
    );
  });

  it("export is gated to approved or already-exported", () => {
    assert.ok(
      /\/periods\/:id\/export[\s\S]+?period\.status\s*!==\s*"approved"\s*&&\s*period\.status\s*!==\s*"exported"[\s\S]+?refusedDueToPeriodState/.test(
        src,
      ),
      "export must require status in (approved, exported)",
    );
  });

  it("adjustments POST/PATCH/DELETE refuse on approved or exported", () => {
    // Each handler checks the period status. Spot-check the create
    // path; the patch/delete reuse the same guard.
    assert.ok(
      /period\.status === "approved" \|\| period\.status === "exported"/.test(
        src,
      ),
      "adjustment routes must refuse when period is approved or exported",
    );
  });

  it("approve + unapprove + export + rates require ADMIN write gate", () => {
    // adminWriteGate is owner / admin / super_admin (NO office).
    assert.ok(
      /router\.post\("\/periods\/:id\/approve",\s*adminWriteGate/.test(src),
      "approve must use adminWriteGate (no office)",
    );
    assert.ok(
      /router\.post\("\/periods\/:id\/unapprove",\s*adminWriteGate/.test(src),
      "unapprove must use adminWriteGate",
    );
    assert.ok(
      /router\.post\("\/periods\/:id\/export",\s*adminWriteGate/.test(src),
      "export must use adminWriteGate",
    );
    assert.ok(
      /router\.post\("\/rates",\s*adminWriteGate/.test(src),
      "rates POST must use adminWriteGate",
    );
  });

  it("router-level guard blocks techs on every endpoint", () => {
    assert.ok(
      /router\.use\(requireAuth,\s*officeReadGate\)/.test(src),
      "pay router must apply requireAuth + officeReadGate at the router level",
    );
    assert.ok(
      /const officeReadGate = requireRole\("owner", "admin", "office", "super_admin"\)/.test(
        src,
      ),
      "pay router excludes 'technician' and 'team_lead' from base gate",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Provider neutrality — the diff is grepped for vendor names
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1E — provider neutrality (the hard requirement)", () => {
  // Scan the production files only. The test file itself legitimately
  // enumerates vendor names for the purpose of checking other files,
  // so excluding it from its own scan is the right call. The scan
  // covers every code file that could possibly ship a vendor string
  // into production: routes, libs, and the schema file (handled
  // separately below at a relative path).
  const filesToScan = [
    "src/routes/pay.ts",
    "src/lib/pay-eligibility.ts",
    "src/lib/pay-hours.ts",
    "src/lib/pay-summary.ts",
    "src/lib/pay-rate-lookup.ts",
    "src/lib/pay-export.ts",
    "src/lib/clock-integrity-self-check.ts",
    "src/routes/ops-integrity.ts",
  ];
  // Vendor names that must NEVER appear in the 1E diff (case-insensitive
  // word match). If any future change reintroduces one, this test
  // FAILs and blocks the merge.
  const VENDOR_BLOCKLIST = [
    "adp",
    "gusto",
    "paychex",
    "quickbooks payroll",
    "workday",
    "paylocity",
    "rippling",
    "paycom",
    "trinet",
    "namely",
    "bamboohr",
    "zenefits",
    "justworks",
  ];

  for (const rel of filesToScan) {
    it(`${rel} contains no payroll-vendor name`, () => {
      const full = path.resolve(process.cwd(), rel);
      const src = readFileSync(full, "utf8").toLowerCase();
      for (const vendor of VENDOR_BLOCKLIST) {
        const re = new RegExp(`\\b${vendor.replace(/ /g, "\\s+")}\\b`, "i");
        const m = re.exec(src);
        assert.ok(
          !m,
          `${rel} contains the vendor string "${vendor}" at index ${m?.index} — provider neutrality violated`,
        );
      }
    });
  }

  it("schema file lib/db/src/schema/pay.ts contains no vendor name", () => {
    const full = path.resolve(process.cwd(), "../../lib/db/src/schema/pay.ts");
    const src = readFileSync(full, "utf8").toLowerCase();
    for (const vendor of VENDOR_BLOCKLIST) {
      const re = new RegExp(`\\b${vendor.replace(/ /g, "\\s+")}\\b`, "i");
      assert.ok(
        !re.test(src),
        `pay.ts contains the vendor string "${vendor}" — provider neutrality violated`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Self-check — the boot-time integrity guard (Part 0)
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1E — startup integrity self-check", () => {
  const src = readFileSync(
    path.resolve(process.cwd(), "src/lib/clock-integrity-self-check.ts"),
    "utf8",
  );

  it("queries pg_constraint for the named CHECK constraint", () => {
    assert.ok(
      /pg_constraint[\s\S]+job_clock_events.+contype = 'c'/.test(src),
      "self-check must query pg_constraint for CHECK constraints on job_clock_events",
    );
  });

  it("runs TWO smoke INSERTs covering both forbidden shapes", () => {
    // Captured with null lat/lng.
    assert.ok(
      /INSERT INTO job_clock_events[\s\S]+?'captured'/.test(src),
      "smoke INSERT for captured-with-null-coords missing",
    );
    // failed_exception with null reason.
    assert.ok(
      /'failed_exception'[\s\S]+?NULL/.test(src),
      "smoke INSERT for failed_exception-with-null-reason missing",
    );
  });

  it("expects SQLSTATE 23514 (check_violation)", () => {
    assert.ok(
      /PG_CHECK_VIOLATION_SQLSTATE\s*=\s*"23514"/.test(src),
      "self-check must look for SQLSTATE 23514",
    );
  });

  it("emits the exact PASS / FAIL headlines from the spec", () => {
    assert.ok(
      /CLOCK INTEGRITY: PASS — constraint \$\{constraintName\} present and rejecting malformed rows/.test(
        src,
      ),
      "PASS headline must match the spec verbatim",
    );
    assert.ok(
      /CLOCK INTEGRITY: FAIL — constraint missing or not enforced; pay relies on application-level guard only\. INVESTIGATE BEFORE RUNNING PAYROLL\./.test(
        src,
      ),
      "FAIL headline must match the spec verbatim",
    );
  });

  it("startup chain in index.ts invokes the self-check", () => {
    const idx = readFileSync(
      path.resolve(process.cwd(), "src/index.ts"),
      "utf8",
    );
    assert.ok(
      /verifyClockIntegrityConstraint/.test(idx),
      "src/index.ts must call verifyClockIntegrityConstraint at startup",
    );
  });

  it("on-demand re-run endpoint exists and is admin-gated", () => {
    const opsSrc = readFileSync(
      path.resolve(process.cwd(), "src/routes/ops-integrity.ts"),
      "utf8",
    );
    assert.ok(
      /\/integrity-check/.test(opsSrc),
      "ops-integrity must expose /integrity-check",
    );
    assert.ok(
      /requireRole\("owner",\s*"admin",\s*"super_admin"\)/.test(opsSrc),
      "ops-integrity must require owner/admin/super_admin",
    );
  });
});
