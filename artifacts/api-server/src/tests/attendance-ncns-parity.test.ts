/**
 * [ncns-parity 2026-08-21] The Attendance card has to count what the
 * disciplinary ladder counts.
 *
 * Sal, 8/21: "so we do have problem and it's not working."
 *
 * THE BUG. `countUnexcusedOccurrences` is the canonical counter — absent = 1,
 * NCNS = 1, protected = 0 — and the ladder WRITER drives discipline through it
 * (driveOccurrenceLadder, over types ['absent','ncns']). Four readers on the
 * employee-profile Attendance card instead filtered to `type === 'absent'`
 * alone, so a No-Call/No-Show — the most unexcused thing on the list — counted
 * ZERO everywhere the office looks:
 *
 *   • unexcused.occurrences   (the "N of M occurrences to <step>" caption)
 *   • tiles.unexcused         (the 180-day Unexcused tile)
 *   • unexcused.hours_used    (the 40-hour bank, summary copy)
 *   • balances used_hours     (the 40-hour bank, balances-route copy)
 *
 * Net effect: one absence + one NCNS fires the ladder at 2 occurrences and can
 * mint a warning, while the card still reads "1 of 3 occurrences to written
 * warning". The office sees a write-up with nothing behind it.
 *
 * [ncns-weight 2026-08-21] NCNS was weighted 2 when this test was written.
 * It is 1 now — the parity property under test is unchanged (the card must
 * count what the ladder counts); only the arithmetic moved.
 *
 * A third reader — GET /leave/reliability — already used the canonical helper,
 * which is what made the disagreement visible.
 *
 * These are grep-asserts on the route source (the house pattern for this file's
 * neighbours: buildAttendanceSummary needs a live DB) plus real arithmetic
 * against countUnexcusedOccurrences so the WEIGHTS can't drift either.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  countUnexcusedOccurrences,
  NCNS_OCCURRENCE_WEIGHT,
} from "../lib/attendance-compliance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const leave = read("../routes/leave.ts");
const index = read("../index.ts");
const overlay = read("../routes/attendance-overlay.ts");
const scan = read("../lib/attendance-scan.ts");

/** The body of buildAttendanceSummary — where the card's numbers are built. */
const summary = () => {
  const from = leave.indexOf("async function buildAttendanceSummary");
  assert.ok(from > 0, "buildAttendanceSummary not found — anchor moved");
  const to = leave.indexOf("router.get(\"/attendance-summary\"");
  assert.ok(to > from, "attendance-summary route not found after the builder");
  return leave.slice(from, to);
};

describe("the weights themselves", () => {
  it("an NCNS is worth one occurrence — a plain unexcused absence", () => {
    // [ncns-weight 2026-08-21] Was 2. Qleno records the no-show; the office
    // decides whether it's a firing. See lib/attendance-compliance.ts.
    assert.equal(NCNS_OCCURRENCE_WEIGHT, 1);
  });

  it("one absence + one NCNS = 2, which is what the card must show", () => {
    const rows = [
      { type: "absent", protected: false },
      { type: "ncns", protected: false },
    ];
    assert.equal(countUnexcusedOccurrences(rows), 2);
  });

  it("a protected absence still counts zero — PLAWA covers it", () => {
    assert.equal(
      countUnexcusedOccurrences([{ type: "absent", protected: true }]),
      0,
    );
  });

  it("a protected NCNS still counts one — procedural, balance-independent", () => {
    // The WEIGHT dropped to 1; the balance-independence did not. A missing
    // call is a notice violation whatever the PLAWA bank says.
    assert.equal(
      countUnexcusedOccurrences([{ type: "ncns", protected: true }]),
      1,
    );
  });
});

describe("the card counts what the ladder counts", () => {
  it("the occurrence count goes through countUnexcusedOccurrences, not a hand-rolled filter", () => {
    const s = summary();
    const decl = s.slice(s.indexOf("const unexOccCount"), s.indexOf("const tardyOccCount"));
    assert.ok(
      decl.includes("countUnexcusedOccurrences"),
      "unexOccCount must reuse the canonical counter so it can't drift from the ladder",
    );
    assert.ok(
      !/type === "absent" && !r\.is_protected\)\.length/.test(decl),
      "the old absent-only .length filter must be gone",
    );
  });

  it("the occurrence count feeds it NCNS rows as well as absences", () => {
    const s = summary();
    const decl = s.slice(s.indexOf("const unexOccCount"), s.indexOf("const tardyOccCount"));
    assert.ok(decl.includes('r.type === "ncns"'), "NCNS must reach the counter");
  });

  it("the Unexcused tile includes NCNS", () => {
    const s = summary();
    const decl = s.slice(s.indexOf("const unexRows"), s.indexOf("const ptoRows"));
    assert.ok(decl.includes('r.type === "ncns"'));
  });

  it("the benefit-year history rows include NCNS", () => {
    const s = summary();
    const decl = s.slice(
      s.indexOf("const unexBenefitYearDays"),
      s.indexOf("const unexOccCount"),
    );
    assert.ok(decl.includes('r.type === "ncns"'));
  });

  it("the 40-hour bank (summary copy) spends on NCNS", () => {
    const s = summary();
    const decl = s.slice(s.indexOf("const unexHoursUsed"), s.indexOf("let unexHoursCap"));
    assert.ok(decl.includes('r.type === "ncns"'));
  });

  it("the tardy counter stays its own track — NCNS must NOT leak into it", () => {
    const s = summary();
    const decl = s.slice(s.indexOf("const tardyOccCount"), s.indexOf("let unexHoursCap"));
    const firstLine = decl.split("\n")[0];
    assert.ok(firstLine.includes('r.type === "tardy"'));
    assert.ok(!firstLine.includes("ncns"), "tardy and unexcused are separate ladders");
  });
});

describe("the 40-hour bank in the balances route agrees with the card", () => {
  it("queries both absent and ncns", () => {
    const bal = leave.slice(
      leave.indexOf('if (b.accrual_mode === "office_recorded")'),
      leave.indexOf("// [hire-date-lockout 2026-07-07]"),
    );
    assert.ok(
      bal.includes('inArray(employeeAttendanceLogTable.type, ["absent", "ncns"])'),
      "the bank must count NCNS days",
    );
    assert.ok(
      !/eq\(employeeAttendanceLogTable\.type, "absent"\)/.test(bal),
      "the absent-only equality filter must be gone",
    );
  });

  it("selects `type`, since the hours filter now reads it", () => {
    const bal = leave.slice(
      leave.indexOf('if (b.accrual_mode === "office_recorded")'),
      leave.indexOf("// [hire-date-lockout 2026-07-07]"),
    );
    assert.ok(
      bal.includes("type: employeeAttendanceLogTable.type"),
      "filtering on r.type without selecting it reads undefined and silently drops every row",
    );
  });
});

describe("the on-time ring can't contradict the Tardy tile", () => {
  it("the ring counts tardy dates that lost their job assignment", () => {
    const s = summary();
    const decl = s.slice(s.indexOf("const ringDates"), s.indexOf("const absentDayCount"));
    assert.ok(decl.includes("ringDates.add(d)"), "a tardy date must survive into the ring");
    assert.ok(
      !/const lateDayCount = workedDates\.filter/.test(s),
      "scoping lateDayCount to workedDates is what let '100% on time' sit beside 'Tardy 1'",
    );
  });

  it("the ring's denominator widens with it, so the rate stays <= 100%", () => {
    const s = summary();
    assert.ok(s.includes("const ringDayCount = ringDates.size"));
    assert.ok(
      s.includes("ringDayCount > 0"),
      "on_time_pct must divide by the same set it subtracts from",
    );
  });
});

describe("unexcused absences are detected without anyone clicking a button", () => {
  it("the scanner is callable outside the route", () => {
    assert.ok(scan.includes("export async function runAttendanceScanForCompany"));
    assert.ok(scan.includes("export async function runAttendanceScanCron"));
  });

  it("the route delegates to it instead of carrying its own copy", () => {
    assert.ok(overlay.includes("runAttendanceScanForCompany"));
    assert.ok(
      !overlay.includes("runScanInsertLoop(db, {"),
      "the scan body must live in one place now",
    );
  });

  it("a nightly cron runs it", () => {
    assert.ok(index.includes("runAttendanceScanCron()"), "nothing schedules the scan");
    assert.ok(
      index.includes('fired["attendance_scan"]'),
      "the cron needs a once-per-day guard like its neighbours",
    );
  });

  it("the cron scans yesterday, never a day still in progress", () => {
    const cron = scan.slice(scan.indexOf("export async function runAttendanceScanCron"));
    assert.ok(
      cron.includes("yd.setUTCDate(yd.getUTCDate() - 1)"),
      "a half-finished day would propose absences against techs who simply haven't arrived",
    );
  });

  it("the cron is behind backgroundWorkersAllowed, like every other worker", () => {
    // CLAUDE.md, hard rule: "Any new cron, interval worker or boot-time data
    // task must go behind backgroundWorkersAllowed() or RUN_DATA_MIGRATIONS."
    // This is load-bearing here in a way it isn't for a read-only job: every
    // Railway PR preview inherits the production DATABASE_URL byte for byte, so
    // an ungated scan would have a dozen preview environments inserting
    // proposals into the live database at 1 AM. The existing preview-isolation
    // suite tests the gate FUNCTION; nothing tested that a given cron actually
    // sits behind it.
    const fnStart = index.indexOf("function startNotificationCron()");
    assert.ok(fnStart > 0, "startNotificationCron not found — anchor moved");
    // Walk braces to find the function's real end rather than guessing.
    const open = index.indexOf("{", fnStart);
    let depth = 0, end = -1;
    for (let i = open; i < index.length; i++) {
      if (index[i] === "{") depth++;
      else if (index[i] === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    assert.ok(end > open, "could not find the end of startNotificationCron");
    const body = index.slice(open, end);
    assert.ok(
      body.includes("runAttendanceScanCron()"),
      "the scan cron must live inside startNotificationCron, which is gated",
    );
    // ...and that function must only ever be started behind the gate.
    const callSite = index.indexOf("startNotificationCron();");
    assert.ok(callSite > 0, "startNotificationCron is never started");
    const preceding = index.slice(Math.max(0, callSite - 400), callSite);
    assert.ok(
      preceding.includes("backgroundWorkersAllowed()"),
      "startNotificationCron must be started only when background workers are allowed",
    );
  });

  it("the cron only proposes — it never records attendance or discipline itself", () => {
    // The whole safety argument for running this unattended. If this ever
    // starts writing employee_attendance_log directly, the office loses the
    // review gate and a scan bug becomes a write-up.
    assert.ok(
      !scan.includes("employeeAttendanceLogTable"),
      "the scanner must not write attendance rows",
    );
    assert.ok(
      !scan.includes("recordUnexcusedEntryAndDriveLadder"),
      "the scanner must not drive the discipline ladder",
    );
  });
});

describe("recording or removing an absence moves the score now, not at 3 AM", () => {
  it("the record form the office actually uses recomputes the composite", () => {
    // /unexcused/record is the LAST route in the file, so slice to the end —
    // an earlier-declared anchor would give an empty (silently passing) slice.
    const start = leave.indexOf('router.post("/unexcused/record"');
    assert.ok(start > 0, "record route not found — anchor moved");
    const rec = leave.slice(start);
    assert.ok(rec.length > 500, "slice looks empty — end anchor is wrong");
    assert.ok(
      rec.includes("recomputeCompositeScore"),
      "POST /unexcused/record is the mounted path — POST /hr-attendance's UI is not mounted anywhere",
    );
  });

  it("deleting a mistaken entry gives the score back", () => {
    const delStart = leave.indexOf('router.delete("/attendance/:id"');
    const delEnd = leave.indexOf('router.get("/balance-log"', delStart);
    assert.ok(delStart > 0 && delEnd > delStart, "delete-route anchors moved");
    const del = leave.slice(delStart, delEnd);
    assert.ok(del.includes("recomputeCompositeScore"));
  });
});
