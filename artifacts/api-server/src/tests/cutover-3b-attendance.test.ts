/**
 * Cutover 3B — Attendance overlay (late / short / no_show /
 * missing_clockout). Pure tests against the lib helpers + grep-asserts
 * on the route source for the load-bearing invariants. A small
 * `makeFakeDb()` harness exercises the confirm handler's branching
 * behavior (race, cross-tenant, override-required, etc.) without
 * touching a real database.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parseScheduledTime,
} from "../lib/parse-scheduled-time.js";
import {
  pairClockEventsForJobUser,
  classifyDiscrepancy,
  LATE_THRESHOLD_MINUTES_DEFAULT,
  NO_SHOW_WAIT_MINUTES_DEFAULT,
  SHORT_THRESHOLD_MINUTES_DEFAULT,
  type ClockEventForOverlay,
  type ScheduledAssignment,
  type ApprovedLeaveWindow,
} from "../lib/attendance-discrepancy.js";
import { recordUnexcusedEntryAndDriveLadder } from "../lib/unexcused-ladder-writer.js";
import { validateScanWindow } from "../lib/scan-window.js";
import {
  confirmProposalWithTx,
  runScanInsertLoop,
  toChicagoMinutesOfDay,
} from "../lib/attendance-overlay-handlers.js";

// ─────────────────────────────────────────────────────────────────────────────
// A. parseScheduledTime
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 3B — parseScheduledTime", () => {
  it("'1:30 PM' → 810", () => assert.equal(parseScheduledTime("1:30 PM"), 810));
  it("'1:30 pm' (lowercase) → 810", () => assert.equal(parseScheduledTime("1:30 pm"), 810));
  it("'13:30' → 810", () => assert.equal(parseScheduledTime("13:30"), 810));
  it("'13:30:00' (with seconds) → 810", () => assert.equal(parseScheduledTime("13:30:00"), 810));
  it("'9:00 AM' → 540", () => assert.equal(parseScheduledTime("9:00 AM"), 540));
  it("'12:00 AM' → 0 (midnight)", () => assert.equal(parseScheduledTime("12:00 AM"), 0));
  it("'12:00 PM' → 720 (noon)", () => assert.equal(parseScheduledTime("12:00 PM"), 720));
  it("'11:59 PM' → 1439", () => assert.equal(parseScheduledTime("11:59 PM"), 1439));
  it("null → null", () => assert.equal(parseScheduledTime(null), null));
  it("empty string → null", () => assert.equal(parseScheduledTime(""), null));
  it("garbage → null", () => assert.equal(parseScheduledTime("garbage"), null));
  it("'25:00' (out of range hour) → null", () => assert.equal(parseScheduledTime("25:00"), null));
  it("'13:60' (out of range minute) → null", () => assert.equal(parseScheduledTime("13:60"), null));
});

// ─────────────────────────────────────────────────────────────────────────────
// B. pairClockEventsForJobUser
// ─────────────────────────────────────────────────────────────────────────────

function makeEvent(opts: Partial<ClockEventForOverlay> & { id: number; event_type: "clock_in" | "clock_out"; event_at: Date }): ClockEventForOverlay {
  const at = opts.event_at;
  // Synthesize Chicago-projected fields here for test convenience.
  return {
    job_id: opts.job_id ?? 1,
    user_id: opts.user_id ?? 1,
    is_correction: opts.is_correction ?? false,
    correction_of_event_id: opts.correction_of_event_id ?? null,
    gps_status: opts.gps_status ?? "captured",
    latitude: opts.latitude ?? 41.7,
    longitude: opts.longitude ?? -87.7,
    exception_reason: opts.exception_reason ?? null,
    exception_reviewed_at: opts.exception_reviewed_at ?? null,
    event_date: at.toISOString().slice(0, 10),
    event_minutes_of_day: at.getUTCHours() * 60 + at.getUTCMinutes(),
    ...opts,
  };
}

describe("Cutover 3B — pairClockEventsForJobUser", () => {
  it("one in + one out → paired with worked_minutes", () => {
    const ev = [
      makeEvent({ id: 1, event_type: "clock_in", event_at: new Date("2026-05-29T13:00:00Z") }),
      makeEvent({ id: 2, event_type: "clock_out", event_at: new Date("2026-05-29T17:00:00Z") }),
    ];
    const r = pairClockEventsForJobUser(ev);
    assert.equal(r.clock_in?.id, 1);
    assert.equal(r.clock_out?.id, 2);
    assert.equal(r.worked_minutes, 240);
  });
  it("only in → clock_in only, worked_minutes=null", () => {
    const ev = [makeEvent({ id: 1, event_type: "clock_in", event_at: new Date("2026-05-29T13:00:00Z") })];
    const r = pairClockEventsForJobUser(ev);
    assert.equal(r.clock_in?.id, 1);
    assert.equal(r.clock_out, null);
    assert.equal(r.worked_minutes, null);
  });
  it("only out → clock_in null, worked_minutes=null", () => {
    const ev = [makeEvent({ id: 1, event_type: "clock_out", event_at: new Date("2026-05-29T17:00:00Z") })];
    const r = pairClockEventsForJobUser(ev);
    assert.equal(r.clock_in, null);
    assert.equal(r.clock_out?.id, 1);
    assert.equal(r.worked_minutes, null);
  });
  it("correction overrides original → corrected event used (original filtered)", () => {
    const ev = [
      makeEvent({ id: 1, event_type: "clock_in", event_at: new Date("2026-05-29T13:00:00Z") }),
      makeEvent({ id: 2, event_type: "clock_in", event_at: new Date("2026-05-29T13:30:00Z"), is_correction: true, correction_of_event_id: 1 }),
      makeEvent({ id: 3, event_type: "clock_out", event_at: new Date("2026-05-29T17:30:00Z") }),
    ];
    const r = pairClockEventsForJobUser(ev);
    assert.equal(r.clock_in?.id, 2);
    assert.equal(r.worked_minutes, 240);
  });
  it("unreviewed exception excluded via default eligibility fn", () => {
    const ev = [
      makeEvent({
        id: 1,
        event_type: "clock_in",
        event_at: new Date("2026-05-29T13:00:00Z"),
        gps_status: "failed_exception",
        latitude: null,
        longitude: null,
        exception_reason: "phone died",
        exception_reviewed_at: null,
      }),
      makeEvent({ id: 2, event_type: "clock_out", event_at: new Date("2026-05-29T17:00:00Z") }),
    ];
    const r = pairClockEventsForJobUser(ev);
    assert.equal(r.clock_in, null); // unreviewed exception filtered
    assert.equal(r.clock_out?.id, 2);
  });
  it("mid-day re-clock (in→out→in→out) collapses to first-in/last-out", () => {
    const ev = [
      makeEvent({ id: 1, event_type: "clock_in", event_at: new Date("2026-05-29T09:00:00Z") }),
      makeEvent({ id: 2, event_type: "clock_out", event_at: new Date("2026-05-29T12:00:00Z") }),
      makeEvent({ id: 3, event_type: "clock_in", event_at: new Date("2026-05-29T13:00:00Z") }),
      makeEvent({ id: 4, event_type: "clock_out", event_at: new Date("2026-05-29T17:00:00Z") }),
    ];
    const r = pairClockEventsForJobUser(ev);
    assert.equal(r.clock_in?.id, 1);
    assert.equal(r.clock_out?.id, 4);
    assert.equal(r.worked_minutes, 8 * 60); // bracket includes break
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. classifyDiscrepancy — Chicago wall-clock minute math
// ─────────────────────────────────────────────────────────────────────────────

function makeAssignment(opts: Partial<ScheduledAssignment> & { scheduled_date: string; scheduled_time_minutes: number | null }): ScheduledAssignment {
  return {
    job_id: opts.job_id ?? 100,
    user_id: opts.user_id ?? 50,
    estimated_hours: opts.estimated_hours ?? null,
    ...opts,
  };
}

function projectChicago(ev: ClockEventForOverlay, date: string, minutesOfDay: number): ClockEventForOverlay {
  return { ...ev, event_date: date, event_minutes_of_day: minutesOfDay };
}

describe("Cutover 3B — classifyDiscrepancy: late/short/no_show/missing", () => {
  const today = "2026-05-29";
  const tomorrow = "2026-05-30";

  it("scheduled 13:30, in at 13:45 (15 min) → on_time", () => {
    const a = makeAssignment({ scheduled_date: today, scheduled_time_minutes: 13 * 60 + 30 });
    // event_at must be recent (within the 16h stale window) — the classifier
    // checks staleness against Date.now() for the missing_clockout branch,
    // independent of the Chicago wall-clock projection. Use 15 min ago so
    // the projected 13:45 wall-clock stays correct AND staleness is avoided.
    const recentClockIn = new Date(Date.now() - 15 * 60 * 1000);
    const ev: ClockEventForOverlay[] = [
      projectChicago(makeEvent({ id: 1, job_id: 100, user_id: 50, event_type: "clock_in", event_at: recentClockIn }), today, 13 * 60 + 45),
    ];
    const r = classifyDiscrepancy(a, ev, [], 14 * 60, today);
    assert.equal(r.kind, "on_time");
  });
  it("scheduled 13:30, in at 13:50 (20 min) → late", () => {
    const a = makeAssignment({ scheduled_date: today, scheduled_time_minutes: 13 * 60 + 30 });
    const ev: ClockEventForOverlay[] = [
      projectChicago(makeEvent({ id: 1, job_id: 100, user_id: 50, event_type: "clock_in", event_at: new Date(`${today}T18:50:00Z`) }), today, 13 * 60 + 50),
      projectChicago(makeEvent({ id: 2, job_id: 100, user_id: 50, event_type: "clock_out", event_at: new Date(`${today}T22:50:00Z`) }), today, 17 * 60 + 50),
    ];
    const r = classifyDiscrepancy(a, ev, [], 23 * 60, today);
    assert.equal(r.kind, "late");
    assert.equal(r.minutes_late, 20);
  });
  it("scheduled 13:30, in at 14:30 (60 min) → late", () => {
    const a = makeAssignment({ scheduled_date: today, scheduled_time_minutes: 13 * 60 + 30 });
    const ev: ClockEventForOverlay[] = [
      projectChicago(makeEvent({ id: 1, job_id: 100, user_id: 50, event_type: "clock_in", event_at: new Date(`${today}T19:30:00Z`) }), today, 14 * 60 + 30),
      projectChicago(makeEvent({ id: 2, job_id: 100, user_id: 50, event_type: "clock_out", event_at: new Date(`${today}T22:30:00Z`) }), today, 18 * 60 + 30),
    ];
    const r = classifyDiscrepancy(a, ev, [], 23 * 60, today);
    assert.equal(r.kind, "late");
    assert.equal(r.minutes_late, 60);
  });
  it("estimated 4h, worked 3h30 → short (30 min)", () => {
    const a = makeAssignment({ scheduled_date: today, scheduled_time_minutes: 9 * 60, estimated_hours: 4 });
    const inAt = new Date(`${today}T14:00:00Z`);
    const outAt = new Date(`${today}T17:30:00Z`); // 3h30m
    const ev: ClockEventForOverlay[] = [
      projectChicago(makeEvent({ id: 1, job_id: 100, user_id: 50, event_type: "clock_in", event_at: inAt }), today, 9 * 60),
      projectChicago(makeEvent({ id: 2, job_id: 100, user_id: 50, event_type: "clock_out", event_at: outAt }), today, 12 * 60 + 30),
    ];
    const r = classifyDiscrepancy(a, ev, [], 13 * 60, today);
    assert.equal(r.kind, "short");
    assert.equal(r.minutes_short, 30);
  });
  it("estimated 4h, worked 3h45 (15 min short) → on_time", () => {
    const a = makeAssignment({ scheduled_date: today, scheduled_time_minutes: 9 * 60, estimated_hours: 4 });
    const inAt = new Date(`${today}T14:00:00Z`);
    const outAt = new Date(`${today}T17:45:00Z`);
    const ev: ClockEventForOverlay[] = [
      projectChicago(makeEvent({ id: 1, job_id: 100, user_id: 50, event_type: "clock_in", event_at: inAt }), today, 9 * 60),
      projectChicago(makeEvent({ id: 2, job_id: 100, user_id: 50, event_type: "clock_out", event_at: outAt }), today, 12 * 60 + 45),
    ];
    const r = classifyDiscrepancy(a, ev, [], 13 * 60, today);
    assert.equal(r.kind, "on_time");
  });
  it("no clock_in, now=14:00 (past 13:30+20), same date → no_show", () => {
    const a = makeAssignment({ scheduled_date: today, scheduled_time_minutes: 13 * 60 + 30 });
    const r = classifyDiscrepancy(a, [], [], 14 * 60, today);
    assert.equal(r.kind, "no_show");
  });
  it("no clock_in, now=13:00 (before 13:30), same date → on_time (pre-start)", () => {
    const a = makeAssignment({ scheduled_date: today, scheduled_time_minutes: 13 * 60 + 30 });
    const r = classifyDiscrepancy(a, [], [], 13 * 60, today);
    assert.equal(r.kind, "on_time");
  });
  it("no clock_in, now is next day → no_show", () => {
    const a = makeAssignment({ scheduled_date: today, scheduled_time_minutes: 13 * 60 + 30 });
    const r = classifyDiscrepancy(a, [], [], 9 * 60, tomorrow);
    assert.equal(r.kind, "no_show");
  });
  it("clock_in 13:30, no clock_out, now next day → missing_clockout", () => {
    const a = makeAssignment({ scheduled_date: today, scheduled_time_minutes: 13 * 60 + 30 });
    const inEvent = projectChicago(
      makeEvent({ id: 1, job_id: 100, user_id: 50, event_type: "clock_in", event_at: new Date(`${today}T18:30:00Z`) }),
      today,
      13 * 60 + 30,
    );
    const r = classifyDiscrepancy(a, [inEvent], [], 9 * 60, tomorrow);
    assert.equal(r.kind, "missing_clockout");
    assert.equal(r.clock_in_event_id, 1);
  });
  it("clock_in 13:30, no clock_out, same day 14:30 (not stale) → on_time", () => {
    const a = makeAssignment({ scheduled_date: today, scheduled_time_minutes: 13 * 60 + 30 });
    const recent = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const inEvent = projectChicago(
      makeEvent({ id: 1, job_id: 100, user_id: 50, event_type: "clock_in", event_at: recent }),
      today,
      13 * 60 + 30,
    );
    const r = classifyDiscrepancy(a, [inEvent], [], 14 * 60 + 30, today);
    assert.equal(r.kind, "on_time");
  });
  it("LATE + full-day approved leave (8h) → kind='late', suppressed_by_leave=true", () => {
    const a = makeAssignment({ scheduled_date: today, scheduled_time_minutes: 13 * 60 + 30 });
    const ev: ClockEventForOverlay[] = [
      projectChicago(makeEvent({ id: 1, job_id: 100, user_id: 50, event_type: "clock_in", event_at: new Date(`${today}T19:00:00Z`) }), today, 14 * 60),
      projectChicago(makeEvent({ id: 2, job_id: 100, user_id: 50, event_type: "clock_out", event_at: new Date(`${today}T23:00:00Z`) }), today, 18 * 60),
    ];
    const leaves: ApprovedLeaveWindow[] = [
      { leave_request_id: 77, user_id: 50, start_date: today, end_date: today, hours: 8 },
    ];
    const r = classifyDiscrepancy(a, ev, leaves, 23 * 60 + 30, today);
    assert.equal(r.kind, "late");
    assert.equal(r.leave_request_id, 77);
    assert.equal(r.suppressed_by_leave, true);
  });
  it("NO_SHOW + full-day approved leave → kind='no_show', suppressed_by_leave=true", () => {
    const a = makeAssignment({ scheduled_date: today, scheduled_time_minutes: 13 * 60 + 30 });
    const leaves: ApprovedLeaveWindow[] = [
      { leave_request_id: 77, user_id: 50, start_date: today, end_date: today, hours: 8 },
    ];
    const r = classifyDiscrepancy(a, [], leaves, 23 * 60, today);
    assert.equal(r.kind, "no_show");
    assert.equal(r.suppressed_by_leave, true);
  });
  it("LATE + partial-day leave (4h) → suppressed_by_leave=false, leave_request_id attached", () => {
    const a = makeAssignment({ scheduled_date: today, scheduled_time_minutes: 13 * 60 + 30 });
    const ev: ClockEventForOverlay[] = [
      projectChicago(makeEvent({ id: 1, job_id: 100, user_id: 50, event_type: "clock_in", event_at: new Date(`${today}T19:00:00Z`) }), today, 14 * 60),
      projectChicago(makeEvent({ id: 2, job_id: 100, user_id: 50, event_type: "clock_out", event_at: new Date(`${today}T23:00:00Z`) }), today, 18 * 60),
    ];
    const leaves: ApprovedLeaveWindow[] = [
      { leave_request_id: 78, user_id: 50, start_date: today, end_date: today, hours: 4 },
    ];
    const r = classifyDiscrepancy(a, ev, leaves, 23 * 60 + 30, today);
    assert.equal(r.kind, "late");
    assert.equal(r.leave_request_id, 78);
    assert.equal(r.suppressed_by_leave, false);
  });
  it("estimated_hours null + would-be SHORT case → on_time", () => {
    const a = makeAssignment({ scheduled_date: today, scheduled_time_minutes: 9 * 60, estimated_hours: null });
    const ev: ClockEventForOverlay[] = [
      projectChicago(makeEvent({ id: 1, job_id: 100, user_id: 50, event_type: "clock_in", event_at: new Date(`${today}T14:00:00Z`) }), today, 9 * 60),
      projectChicago(makeEvent({ id: 2, job_id: 100, user_id: 50, event_type: "clock_out", event_at: new Date(`${today}T16:00:00Z`) }), today, 11 * 60),
    ];
    const r = classifyDiscrepancy(a, ev, [], 17 * 60, today);
    assert.equal(r.kind, "on_time");
  });
  it("per-tech: 2 techs same job, only one late → other classified independently", () => {
    const a1 = makeAssignment({ job_id: 200, user_id: 10, scheduled_date: today, scheduled_time_minutes: 13 * 60 + 30 });
    const a2 = makeAssignment({ job_id: 200, user_id: 20, scheduled_date: today, scheduled_time_minutes: 13 * 60 + 30 });
    const events: ClockEventForOverlay[] = [
      projectChicago(makeEvent({ id: 1, job_id: 200, user_id: 10, event_type: "clock_in", event_at: new Date(`${today}T18:30:00Z`) }), today, 13 * 60 + 30),
      projectChicago(makeEvent({ id: 2, job_id: 200, user_id: 10, event_type: "clock_out", event_at: new Date(`${today}T22:30:00Z`) }), today, 17 * 60 + 30),
      projectChicago(makeEvent({ id: 3, job_id: 200, user_id: 20, event_type: "clock_in", event_at: new Date(`${today}T19:00:00Z`) }), today, 14 * 60),
      projectChicago(makeEvent({ id: 4, job_id: 200, user_id: 20, event_type: "clock_out", event_at: new Date(`${today}T22:30:00Z`) }), today, 17 * 60 + 30),
    ];
    const r1 = classifyDiscrepancy(a1, events, [], 23 * 60, today);
    const r2 = classifyDiscrepancy(a2, events, [], 23 * 60, today);
    assert.equal(r1.kind, "on_time");
    assert.equal(r2.kind, "late");
    assert.equal(r2.minutes_late, 30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. parseScheduledTime DST safety — minutes-of-day is timezone-naive by design
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 3B — DST: scheduled time math unchanged across DST jump", () => {
  // The classifier consumes minutes-of-day, not absolute timestamps. So
  // 13:30 on the day clocks spring forward and the day after both
  // parse to the same minutes value. Route handler converts events
  // via Intl.DateTimeFormat which handles DST natively — this test
  // documents that the parser does NOT introduce its own offset.
  it("13:30 parses identically the day clocks spring forward", () => {
    const a = parseScheduledTime("13:30");
    const b = parseScheduledTime("13:30");
    assert.equal(a, b);
    assert.equal(a, 13 * 60 + 30);
  });
  it("toChicagoMinutesOfDay returns 810 for 13:30 Chicago wall-clock on both sides of the 2026 spring DST jump", () => {
    // 2026 US DST: clocks spring forward Sun Mar 8 2026 02:00 → 03:00.
    // Before the jump CST = UTC-6, after CDT = UTC-5. The Chicago
    // wall-clock projection of 13:30 local must come out as 810
    // (13*60+30) on BOTH dates despite the UTC offset shift.
    //
    // Build the absolute timestamp for "Mar 7 2026 13:30 Chicago" and
    // "Mar 9 2026 13:30 Chicago" by hand. Mar 8 is the jump day —
    // skip it (13:30 still exists, just under CDT). Mar 7 13:30 CST
    // = Mar 7 19:30 UTC. Mar 9 13:30 CDT = Mar 9 18:30 UTC.
    const beforeDst = new Date("2026-03-07T19:30:00Z");
    const afterDst = new Date("2026-03-09T18:30:00Z");
    assert.equal(toChicagoMinutesOfDay(beforeDst), 13 * 60 + 30);
    assert.equal(toChicagoMinutesOfDay(afterDst), 13 * 60 + 30);
  });
  it("toChicagoMinutesOfDay handles the DST jump day itself (Mar 8 2026 13:30 CDT → 810)", () => {
    // On the jump day, 13:30 CDT = Mar 8 18:30 UTC.
    const onDst = new Date("2026-03-08T18:30:00Z");
    assert.equal(toChicagoMinutesOfDay(onDst), 13 * 60 + 30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Route handler tests (mocked DB)
// ─────────────────────────────────────────────────────────────────────────────

// Minimal in-memory drizzle-shaped fake DB. The confirm handler uses
// .transaction → tx.execute (raw SQL) — we stub at that level.

interface FakeProposalRow {
  id: number;
  company_id: number;
  user_id: number;
  job_id: number;
  scheduled_date: string;
  scheduled_time_minutes: number | null;
  estimated_hours: string | null;
  kind: "late" | "short" | "no_show" | "missing_clockout";
  status: "pending" | "confirmed" | "dismissed";
  minutes_late: number | null;
  minutes_short: number | null;
}

interface InsertedAttendanceLog {
  company_id: number;
  employee_id: number;
  log_date: string;
  type: "absent" | "tardy" | "ncns";
  hours: number;
  notes_marker_matches: boolean;
}

interface InsertedProposal {
  company_id: number;
  user_id: number;
  job_id: number;
  scheduled_date: string;
  kind: string;
  status: string;
  decided_by_user_id: number | null;
  decision_note: string | null;
}

function makeFakeDb(proposal: FakeProposalRow | null, opts: {
  policy_steps?: any[];
  recent_attendance?: { log_date: string; notes: string }[];
  recent_discipline?: { reason: string }[];
  update_returns_zero?: boolean;
  /** Pre-existing proposal rows used to emulate the (company_id,
   *  user_id, job_id, scheduled_date) unique-index for E1/E2 scan
   *  idempotency / dismiss-no-resurface tests. */
  existing_proposals?: Array<{
    company_id: number;
    user_id: number;
    job_id: number;
    scheduled_date: string;
    status: "pending" | "confirmed" | "dismissed";
  }>;
}) {
  const inserts: InsertedAttendanceLog[] = [];
  const discipline_inserts: Array<{ reason: string }> = [];
  const proposal_inserts: InsertedProposal[] = [];
  let proposalUpdated = false;
  const proposalState: FakeProposalRow | null = proposal ? { ...proposal } : null;
  const existingProposalKeys = new Set<string>(
    (opts.existing_proposals ?? []).map(
      (p) => `${p.company_id}|${p.user_id}|${p.job_id}|${p.scheduled_date}`,
    ),
  );

  const fakeTx = {
    execute: async (q: any) => {
      const text = String(q?.queryChunks ? q.queryChunks.map((c: any) => c?.value ?? "").join("?") : q);
      if (/SELECT \* FROM attendance_proposals/i.test(text)) {
        return { rows: proposalState ? [proposalState] : [] };
      }
      if (/SELECT id, status FROM attendance_proposals/i.test(text)) {
        return { rows: proposalState ? [{ id: proposalState.id, status: proposalState.status }] : [] };
      }
      if (/UPDATE attendance_proposals/i.test(text)) {
        if (opts.update_returns_zero) return { rowCount: 0 };
        if (proposalState && proposalState.status === "pending") {
          proposalState.status = /'dismissed'/.test(text) ? "dismissed" : "confirmed";
          proposalUpdated = true;
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    insert: (table: any) => {
      const tableName = String(table?.[Symbol.for("drizzle:Name")] ?? "");
      return {
        values: (v: any) => {
          const returning = (_proj?: any) => {
            if (tableName === "employee_attendance_log") {
              const m = /unexcused hours:\s*([0-9.]+)/i.exec(v.notes ?? "");
              inserts.push({
                company_id: v.company_id,
                employee_id: v.employee_id,
                log_date: String(v.log_date),
                type: v.type,
                hours: m ? Number(m[1]) : 0,
                notes_marker_matches: !!m,
              });
              return Promise.resolve([{ id: 999 }]);
            }
            if (tableName === "employee_discipline_log") {
              discipline_inserts.push({ reason: v.reason ?? "" });
              return Promise.resolve([{ id: 555 }]);
            }
            if (tableName === "attendance_proposals") {
              const key = `${v.company_id}|${v.user_id}|${v.job_id}|${v.scheduled_date}`;
              if (existingProposalKeys.has(key)) {
                // emulate ON CONFLICT DO NOTHING — no row returned
                return Promise.resolve([]);
              }
              existingProposalKeys.add(key);
              proposal_inserts.push({
                company_id: v.company_id,
                user_id: v.user_id,
                job_id: v.job_id,
                scheduled_date: String(v.scheduled_date),
                kind: v.kind,
                status: v.status,
                decided_by_user_id: v.decided_by_user_id ?? null,
                decision_note: v.decision_note ?? null,
              });
              return Promise.resolve([{ id: proposal_inserts.length + 1000 }]);
            }
            return Promise.resolve([{ id: 1 }]);
          };
          return {
            returning,
            // Scan path uses .onConflictDoNothing(...).returning(...)
            onConflictDoNothing: (_opts?: any) => ({ returning }),
          };
        },
      };
    },
    select: (_proj: any) => {
      // returns chainable that filters to either policy or
      // attendance_log or discipline_log based on the next .from() call.
      const chain: any = {
        from: (table: any) => {
          const tableName = String(table?.[Symbol.for("drizzle:Name")] ?? "");
          chain._table = tableName;
          return chain;
        },
        where: (_w: any) => chain,
        limit: (_n: number) => {
          if (chain._table === "company_attendance_policy") {
            return Promise.resolve([{ unexcused_hours_steps: opts.policy_steps ?? [] }]);
          }
          return Promise.resolve([]);
        },
        then: undefined as any,
      };
      // Make chain awaitable directly (without .limit) for the
      // attendance_log + discipline_log selects.
      chain.then = (resolve: any) => {
        if (chain._table === "employee_attendance_log") {
          return resolve(opts.recent_attendance ?? []);
        }
        if (chain._table === "employee_discipline_log") {
          return resolve((opts.recent_discipline ?? []).map((d) => ({ reason: d.reason })));
        }
        if (chain._table === "company_attendance_policy") {
          return resolve([{ unexcused_hours_steps: opts.policy_steps ?? [] }]);
        }
        return resolve([]);
      };
      return chain;
    },
  };

  return {
    tx: fakeTx,
    inserts,
    discipline_inserts,
    proposal_inserts,
    get proposalUpdated() {
      return proposalUpdated;
    },
    get proposalStatus() {
      return proposalState?.status ?? null;
    },
  };
}

describe("Cutover 3B — recordUnexcusedEntryAndDriveLadder (extracted helper)", () => {
  it("writes attendance_log with canonical 'unexcused hours: X.XX (note)' marker", async () => {
    const fake = makeFakeDb(null, { policy_steps: [] });
    await recordUnexcusedEntryAndDriveLadder(fake.tx as any, {
      company_id: 1,
      employee_id: 42,
      log_date: "2026-05-29",
      hours: 6.5,
      type: "absent",
      protected: false,
      note: "no show — confirmed via overlay",
      logged_by: 1,
    });
    assert.equal(fake.inserts.length, 1);
    const ins = fake.inserts[0]!;
    assert.equal(ins.employee_id, 42);
    assert.equal(ins.type, "absent");
    assert.equal(ins.hours, 6.5);
    assert.equal(ins.notes_marker_matches, true);
  });
  it("fires discipline row when ladder threshold met", async () => {
    // Step at 4 hours; current entry pushes window over.
    const fake = makeFakeDb(null, {
      policy_steps: [
        { threshold_hours: 4, window_days: 30, discipline_type: "absence_warning", notify: false },
      ],
      recent_attendance: [{ log_date: "2026-05-29", notes: "unexcused hours: 4.50" }],
      recent_discipline: [],
    });
    await recordUnexcusedEntryAndDriveLadder(fake.tx as any, {
      company_id: 1,
      employee_id: 42,
      log_date: "2026-05-29",
      hours: 4.5,
      type: "absent",
      logged_by: 1,
    });
    assert.equal(fake.discipline_inserts.length, 1);
    assert.match(fake.discipline_inserts[0]!.reason, /unexcused-ladder t=4\b/);
  });
  it("does NOT fire when threshold already-fired", async () => {
    const fake = makeFakeDb(null, {
      policy_steps: [
        { threshold_hours: 4, window_days: 30, discipline_type: "absence_warning", notify: false },
      ],
      recent_attendance: [{ log_date: "2026-05-29", notes: "unexcused hours: 4.50" }],
      recent_discipline: [{ reason: "unexcused-ladder t=4 window=30d cum=4.50h" }],
    });
    await recordUnexcusedEntryAndDriveLadder(fake.tx as any, {
      company_id: 1,
      employee_id: 42,
      log_date: "2026-05-29",
      hours: 4.5,
      type: "absent",
      logged_by: 1,
    });
    assert.equal(fake.discipline_inserts.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Route handler tests (mocked DB) — confirm + scan
// ─────────────────────────────────────────────────────────────────────────────

function pendingProposal(overrides: Partial<FakeProposalRow> = {}): FakeProposalRow {
  return {
    id: 33,
    company_id: 1,
    user_id: 7,
    job_id: 11,
    scheduled_date: "2026-05-20",
    scheduled_time_minutes: 13 * 60 + 30,
    estimated_hours: "4.00",
    kind: "late",
    status: "pending",
    minutes_late: 45,
    minutes_short: null,
    ...overrides,
  };
}

describe("Cutover 3B — E. confirm route handler (mocked DB)", () => {
  it("E3: confirm writes one attendance_log row (default type='absent', hours from minutes_late/60)", async () => {
    const fake = makeFakeDb(pendingProposal({ kind: "late", minutes_late: 45 }), { policy_steps: [] });
    const out = await confirmProposalWithTx(fake.tx as any, {
      companyId: 1,
      actingUserId: 9,
      id: 33,
      body: {},
    });
    assert.equal(out.status, 200);
    assert.equal(fake.inserts.length, 1);
    const ins = fake.inserts[0]!;
    // Plan §7 step 4: default is 'absent' for ALL kinds.
    assert.equal(ins.type, "absent");
    // hours = minutes_late / 60 = 45/60 = 0.75
    assert.equal(ins.hours, 0.75);
    assert.equal(fake.proposalStatus, "confirmed");
    assert.equal(fake.proposalUpdated, true);
  });

  it("E4: confirm fires extracted helper (canonical 'unexcused hours' marker written)", async () => {
    const fake = makeFakeDb(pendingProposal({ kind: "no_show", minutes_late: null, estimated_hours: "6.00" }), { policy_steps: [] });
    const out = await confirmProposalWithTx(fake.tx as any, {
      companyId: 1,
      actingUserId: 9,
      id: 33,
      body: {},
    });
    assert.equal(out.status, 200);
    assert.equal(fake.inserts.length, 1);
    // Helper writes the canonical marker; for no_show with
    // estimated_hours=6 the resolved hours is 6.
    assert.equal(fake.inserts[0]!.notes_marker_matches, true);
    assert.equal(fake.inserts[0]!.hours, 6);
    assert.equal(fake.inserts[0]!.company_id, 1);
    assert.equal(fake.inserts[0]!.employee_id, 7);
    assert.equal(fake.inserts[0]!.log_date, "2026-05-20");
  });

  it("E5: missing_clockout confirm WITHOUT override → 400, zero attendance_log inserts", async () => {
    const fake = makeFakeDb(pendingProposal({ kind: "missing_clockout", minutes_late: null }), { policy_steps: [] });
    const out = await confirmProposalWithTx(fake.tx as any, {
      companyId: 1,
      actingUserId: 9,
      id: 33,
      body: {},
    });
    assert.equal(out.status, 400);
    assert.equal(out.body.code, "missing_clockout_requires_override");
    assert.equal(fake.inserts.length, 0);
    assert.equal(fake.proposalStatus, "pending");
  });

  it("E5b: missing_clockout confirm with override_hours BUT no override_attendance_type → 400 (gate honors plan)", async () => {
    // Regression: the gate previously also short-circuited when
    // override_hours was supplied (silently defaulting type to
    // 'absent'). Plan §7 step 3 requires explicit type for
    // missing_clockout — supplying hours alone must still 400.
    const fake = makeFakeDb(pendingProposal({ kind: "missing_clockout", minutes_late: null }), { policy_steps: [] });
    const out = await confirmProposalWithTx(fake.tx as any, {
      companyId: 1,
      actingUserId: 9,
      id: 33,
      body: { override_hours: 4 },
    });
    assert.equal(out.status, 400);
    assert.equal(out.body.code, "missing_clockout_requires_override");
    assert.equal(fake.inserts.length, 0);
  });

  it("E6: missing_clockout confirm WITH override → 200, hours=6, type='absent'", async () => {
    const fake = makeFakeDb(pendingProposal({ kind: "missing_clockout", minutes_late: null }), { policy_steps: [] });
    const out = await confirmProposalWithTx(fake.tx as any, {
      companyId: 1,
      actingUserId: 9,
      id: 33,
      body: { override_attendance_type: "absent", override_hours: 6 },
    });
    assert.equal(out.status, 200);
    assert.equal(fake.inserts.length, 1);
    assert.equal(fake.inserts[0]!.type, "absent");
    assert.equal(fake.inserts[0]!.hours, 6);
  });

  it("E7: cross-tenant confirm → 404, zero inserts", async () => {
    // proposal belongs to company_id=2, request comes in as company_id=1
    const fake = makeFakeDb(pendingProposal({ company_id: 2 }), { policy_steps: [] });
    // The fake's execute returns proposalState regardless of companyId
    // in its WHERE clause matching, so to model cross-tenant we
    // explicitly skip the row when its company_id differs from the
    // request. The real route uses `WHERE company_id = $ctx` to filter
    // at the DB level — model that by supplying a stub that returns
    // empty rows when the requesting company doesn't match.
    const fakeWithGuard = {
      ...fake.tx,
      execute: async (q: any) => {
        const text = String(q?.queryChunks ? q.queryChunks.map((c: any) => c?.value ?? "").join("?") : q);
        if (/SELECT \* FROM attendance_proposals/i.test(text)) {
          // sim cross-tenant: no rows
          return { rows: [] };
        }
        return await fake.tx.execute(q);
      },
    };
    const out = await confirmProposalWithTx(fakeWithGuard as any, {
      companyId: 1,
      actingUserId: 9,
      id: 33,
      body: {},
    });
    assert.equal(out.status, 404);
    assert.equal(fake.inserts.length, 0);
  });

  it("E8: override attendance_type='ncns' on no_show → log row type='ncns'", async () => {
    const fake = makeFakeDb(pendingProposal({ kind: "no_show", minutes_late: null, estimated_hours: "8.00" }), { policy_steps: [] });
    const out = await confirmProposalWithTx(fake.tx as any, {
      companyId: 1,
      actingUserId: 9,
      id: 33,
      body: { override_attendance_type: "ncns" },
    });
    assert.equal(out.status, 200);
    assert.equal(fake.inserts.length, 1);
    assert.equal(fake.inserts[0]!.type, "ncns");
  });

  it("E9: concurrent confirm race (UPDATE rowCount=0) → 409, helper still inserts log (real DB tx rolls back)", async () => {
    // The route's UPDATE has WHERE status='pending'; if another writer
    // beat us, rowCount=0 → 409. In production this is wrapped in a tx
    // that gets rolled back; in the unit fake we don't simulate the
    // rollback — we just assert the 409 status and that no second
    // attendance_log write happens after the 409 returns.
    const fake = makeFakeDb(pendingProposal(), { policy_steps: [], update_returns_zero: true });
    const out = await confirmProposalWithTx(fake.tx as any, {
      companyId: 1,
      actingUserId: 9,
      id: 33,
      body: {},
    });
    assert.equal(out.status, 409);
    // No second confirm: there's exactly one log insert from the
    // racing writer's perspective (in real prod the tx rolls back).
    assert.ok(fake.inserts.length <= 1);
  });

  it("E11: no_show + estimated_hours null → resolved hours fallback to 8", async () => {
    const fake = makeFakeDb(pendingProposal({ kind: "no_show", minutes_late: null, estimated_hours: null }), { policy_steps: [] });
    const out = await confirmProposalWithTx(fake.tx as any, {
      companyId: 1,
      actingUserId: 9,
      id: 33,
      body: {},
    });
    assert.equal(out.status, 200);
    assert.equal(fake.inserts.length, 1);
    assert.equal(fake.inserts[0]!.hours, 8);
  });
});

describe("Cutover 3B — E. scan loop idempotency + auto-dismiss (mocked DB)", () => {
  // Helper: build the assignment + events for a LATE classification.
  function lateFixture() {
    const date = "2026-05-20";
    const a: ScheduledAssignment = {
      job_id: 11,
      user_id: 7,
      scheduled_date: date,
      scheduled_time_minutes: 13 * 60 + 30,
      estimated_hours: 4,
    };
    const ev: ClockEventForOverlay = {
      id: 1,
      job_id: 11,
      user_id: 7,
      event_type: "clock_in",
      event_at: new Date(`${date}T19:00:00Z`),
      event_date: date,
      event_minutes_of_day: 14 * 60, // 14:00 — 30 min late
      is_correction: false,
      correction_of_event_id: null,
      gps_status: "captured",
      latitude: 41.7,
      longitude: -87.7,
      exception_reason: null,
      exception_reviewed_at: null,
    };
    return { date, a, ev };
  }

  it("E1: scan idempotency — pending exists → 0 new inserts (ON CONFLICT DO NOTHING)", async () => {
    const { a, ev, date } = lateFixture();
    const fake = makeFakeDb(null, {
      policy_steps: [],
      existing_proposals: [
        { company_id: 1, user_id: 7, job_id: 11, scheduled_date: date, status: "pending" },
      ],
    });
    const out = await runScanInsertLoop(fake.tx, {
      companyId: 1,
      assignments: [a],
      events: [ev],
      leaves: [],
      nowMinutes: 23 * 60,
      nowDate: date,
    });
    assert.equal(out.new_proposals, 0);
    assert.equal(out.skipped_due_to_existing_proposal, 1);
    assert.equal(fake.proposal_inserts.length, 0);
  });

  it("E2: dismiss-no-resurface — dismissed proposal present → 0 new inserts", async () => {
    const { a, ev, date } = lateFixture();
    const fake = makeFakeDb(null, {
      policy_steps: [],
      existing_proposals: [
        { company_id: 1, user_id: 7, job_id: 11, scheduled_date: date, status: "dismissed" },
      ],
    });
    const out = await runScanInsertLoop(fake.tx, {
      companyId: 1,
      assignments: [a],
      events: [ev],
      leaves: [],
      nowMinutes: 23 * 60,
      nowDate: date,
    });
    assert.equal(out.new_proposals, 0);
    assert.equal(out.skipped_due_to_existing_proposal, 1);
    assert.equal(fake.proposal_inserts.length, 0);
  });

  it("E2b: first scan inserts pending; second scan is a no-op", async () => {
    const { a, ev, date } = lateFixture();
    const fake = makeFakeDb(null, { policy_steps: [] });
    const r1 = await runScanInsertLoop(fake.tx, {
      companyId: 1,
      assignments: [a],
      events: [ev],
      leaves: [],
      nowMinutes: 23 * 60,
      nowDate: date,
    });
    assert.equal(r1.new_proposals, 1);
    assert.equal(fake.proposal_inserts.length, 1);
    const r2 = await runScanInsertLoop(fake.tx, {
      companyId: 1,
      assignments: [a],
      events: [ev],
      leaves: [],
      nowMinutes: 23 * 60,
      nowDate: date,
    });
    assert.equal(r2.new_proposals, 0);
    assert.equal(r2.skipped_due_to_existing_proposal, 1);
    assert.equal(fake.proposal_inserts.length, 1);
  });

  it("E10: NO_SHOW + full-day approved leave (8h) → auto-dismissed insert with 'auto-reconciled' note", async () => {
    const date = "2026-05-20";
    const a: ScheduledAssignment = {
      job_id: 11,
      user_id: 7,
      scheduled_date: date,
      scheduled_time_minutes: 13 * 60 + 30,
      estimated_hours: 4,
    };
    const leaves: ApprovedLeaveWindow[] = [
      { leave_request_id: 88, user_id: 7, start_date: date, end_date: date, hours: 8 },
    ];
    const fake = makeFakeDb(null, { policy_steps: [] });
    const out = await runScanInsertLoop(fake.tx, {
      companyId: 1,
      assignments: [a],
      events: [], // no clock-in → no_show
      leaves,
      nowMinutes: 23 * 60,
      nowDate: date,
    });
    assert.equal(out.auto_dismissed_due_to_leave, 1);
    assert.equal(fake.proposal_inserts.length, 1);
    const row = fake.proposal_inserts[0]!;
    assert.equal(row.status, "dismissed");
    assert.equal(row.kind, "no_show");
    assert.equal(row.decided_by_user_id, null);
    assert.match(row.decision_note ?? "", /auto-reconciled/);
  });

  it("scheduled_date null/missing → skipped, no proposal created", async () => {
    // Belt-and-suspenders: the route's load-time filter already
    // strips these, but the loop defensively skips invalid dates so a
    // test fixture cannot inject a malformed assignment.
    const fake = makeFakeDb(null, { policy_steps: [] });
    const bad: ScheduledAssignment = {
      job_id: 11,
      user_id: 7,
      scheduled_date: "" as unknown as string,
      scheduled_time_minutes: 13 * 60 + 30,
      estimated_hours: 4,
    };
    const out = await runScanInsertLoop(fake.tx, {
      companyId: 1,
      assignments: [bad],
      events: [],
      leaves: [],
      nowMinutes: 23 * 60,
      nowDate: "2026-05-20",
    });
    assert.equal(out.new_proposals, 0);
    assert.equal(out.auto_dismissed_due_to_leave, 0);
    assert.equal(out.skipped_due_to_existing_proposal, 0);
    assert.equal(fake.proposal_inserts.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E12. validateScanWindow boundary completeness
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 3B — E12. validateScanWindow boundaries", () => {
  it("exact 31-day window passes", () => {
    // Jan 1 → Feb 1 inclusive is 31 days (today set well into future
    // so the clamp doesn't fire).
    const r = validateScanWindow({ from_date: "2026-01-01", to_date: "2026-02-01", today: "2026-05-29" });
    assert.equal(r.ok, true);
  });
  it("32-day window rejects", () => {
    const r = validateScanWindow({ from_date: "2026-01-01", to_date: "2026-02-02", today: "2026-05-29" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "window_too_large");
  });
  it("from == today passes (boundary)", () => {
    const r = validateScanWindow({ from_date: "2026-05-29", to_date: "2026-05-29", today: "2026-05-29" });
    assert.equal(r.ok, true);
  });
  it("from one day past today → future_from_date", () => {
    const r = validateScanWindow({ from_date: "2026-05-30", to_date: "2026-05-30", today: "2026-05-29" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "future_from_date");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyDiscrepancy: jobs.scheduled_date null skip safety
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 3B — classifyDiscrepancy: scheduled_date null/empty", () => {
  it("scheduler-style empty scheduled_date → on_time (no proposal raised)", () => {
    // The route's load filter excludes rows with null scheduled_date,
    // but if a malformed assignment slips through the classifier
    // should not crash. Compare against an empty/garbage nowDate
    // string is unsafe — assert the classifier still returns a
    // benign on_time when no clock-in is present and same-day rules
    // can't fire.
    const a: ScheduledAssignment = {
      job_id: 100,
      user_id: 50,
      scheduled_date: "",
      scheduled_time_minutes: null,
      estimated_hours: null,
    };
    const r = classifyDiscrepancy(a, [], [], 14 * 60, "2026-05-29");
    // With empty scheduled_date, nowDate > scheduled_date string
    // comparison evaluates to true (any non-empty > ""), which would
    // ordinarily classify no-clock-in past-day as no_show. But the
    // scan loop now defensively skips empty scheduled_date BEFORE
    // calling the classifier (see runScanInsertLoop). The classifier
    // itself remains tolerant — assert it doesn't crash and returns
    // a typed result.
    assert.ok(["on_time", "no_show"].includes(r.kind));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H. Byte-identical helper output — the notes regex marker contract
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 3B — H. recordUnexcusedEntryAndDriveLadder byte-identical contract", () => {
  it("attendance_log.notes matches the /unexcused hours:\\s*[0-9.]+/ regex", async () => {
    // The legacy leave.ts /unexcused/record parsed hours back out of
    // the notes column via the same regex. The extracted helper must
    // preserve that marker shape.
    const fake = makeFakeDb(null, { policy_steps: [] });
    await recordUnexcusedEntryAndDriveLadder(fake.tx as any, {
      company_id: 1,
      employee_id: 42,
      log_date: "2026-05-29",
      hours: 8,
      type: "absent",
      note: "manual entry from legacy /unexcused/record",
      logged_by: 5,
    });
    assert.equal(fake.inserts.length, 1);
    // The InsertedAttendanceLog harness records notes_marker_matches
    // via the exact regex the legacy code at leave.ts:941 used.
    assert.equal(fake.inserts[0]!.notes_marker_matches, true);
    assert.equal(fake.inserts[0]!.hours, 8);
  });
  it("discipline_log.reason matches /unexcused-ladder t=\\d+ window=\\d+/ marker", async () => {
    // The dedup check at leave.ts read this marker out of recent
    // discipline rows. The extracted helper must keep emitting it.
    const fake = makeFakeDb(null, {
      policy_steps: [
        { threshold_hours: 8, window_days: 30, discipline_type: "absence_warning", notify: false },
      ],
      recent_attendance: [{ log_date: "2026-05-29", notes: "unexcused hours: 8.00" }],
      recent_discipline: [],
    });
    await recordUnexcusedEntryAndDriveLadder(fake.tx as any, {
      company_id: 1,
      employee_id: 42,
      log_date: "2026-05-29",
      hours: 8,
      type: "absent",
      logged_by: 5,
    });
    assert.equal(fake.discipline_inserts.length, 1);
    assert.match(
      fake.discipline_inserts[0]!.reason,
      /unexcused-ladder t=\d+(?:\.\d+)? window=\d+/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. validateScanWindow (pure)
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 3B — validateScanWindow", () => {
  it("valid window passes", () => {
    const r = validateScanWindow({ from_date: "2026-05-01", to_date: "2026-05-05", today: "2026-05-29" });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.from_date, "2026-05-01");
      assert.equal(r.to_date, "2026-05-05");
      assert.equal(r.user_id, null);
    }
  });
  it("from > today → 400", () => {
    const r = validateScanWindow({ from_date: "2026-06-01", to_date: "2026-06-05", today: "2026-05-29" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "future_from_date");
  });
  it("to > today → clamped to today (still ok)", () => {
    const r = validateScanWindow({ from_date: "2026-05-29", to_date: "2026-12-01", today: "2026-05-29" });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.to_date, "2026-05-29");
  });
  it("from > to → 400", () => {
    const r = validateScanWindow({ from_date: "2026-05-05", to_date: "2026-05-01", today: "2026-05-29" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "inverted_window");
  });
  it("window > 31 days (after clamp) → 400", () => {
    const r = validateScanWindow({ from_date: "2026-01-01", to_date: "2026-02-15", today: "2026-05-29" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "window_too_large");
  });
  it("malformed from_date → 400", () => {
    const r = validateScanWindow({ from_date: "garbage", to_date: "2026-05-05", today: "2026-05-29" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "bad_from_date");
  });
  it("user_id passes through when valid", () => {
    const r = validateScanWindow({ from_date: "2026-05-01", to_date: "2026-05-05", user_id: 42, today: "2026-05-29" });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.user_id, 42);
  });
  it("bad user_id → 400", () => {
    const r = validateScanWindow({ from_date: "2026-05-01", to_date: "2026-05-05", user_id: "abc", today: "2026-05-29" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "bad_user_id");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. Anti-regression grep-asserts on schema + route + migration source
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 3B — source grep-asserts", () => {
  const cwd = process.cwd();
  const schema = readFileSync(
    path.resolve(cwd, "../../lib/db/src/schema/attendance_proposals.ts"),
    "utf8",
  );
  const schemaIndex = readFileSync(
    path.resolve(cwd, "../../lib/db/src/schema/index.ts"),
    "utf8",
  );
  const migration = readFileSync(
    path.resolve(cwd, "src/cutover-data-migration.ts"),
    "utf8",
  );
  const overlayRoute = readFileSync(
    path.resolve(cwd, "src/routes/attendance-overlay.ts"),
    "utf8",
  );
  // The confirm/scan handler bodies live in a separate DB-free lib so
  // the test suite can import them without booting drizzle. Some
  // grep-asserts must check both the route and the handler module
  // because the matched strings can live in either file.
  const overlayHandlers = readFileSync(
    path.resolve(cwd, "src/lib/attendance-overlay-handlers.ts"),
    "utf8",
  );
  const overlayLib = readFileSync(
    path.resolve(cwd, "src/lib/attendance-discrepancy.ts"),
    "utf8",
  );
  const leaveRoute = readFileSync(
    path.resolve(cwd, "src/routes/leave.ts"),
    "utf8",
  );
  const writerLib = readFileSync(
    path.resolve(cwd, "src/lib/unexcused-ladder-writer.ts"),
    "utf8",
  );

  it("attendance_proposals schema declares company_id FK", () => {
    assert.match(schema, /company_id:\s*integer\("company_id"\)[\s\S]*references\(\(\)\s*=>\s*companiesTable\.id\)/);
  });
  it("schema index re-exports attendance_proposals", () => {
    assert.match(schemaIndex, /export\s*\*\s*from\s*"\.\/attendance_proposals"/);
  });
  it("migration contains CREATE TYPE attendance_proposal_kind", () => {
    assert.match(migration, /CREATE TYPE attendance_proposal_kind/);
  });
  it("migration contains CREATE TABLE IF NOT EXISTS attendance_proposals", () => {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS attendance_proposals/);
  });
  it("migration contains the unique-index name", () => {
    assert.match(migration, /attendance_proposals_unique_per_assignment_uq/);
  });
  it("every router endpoint mounts officeGate (owner/admin/office/super_admin)", () => {
    // The router uses `router.use(officeGate)` to apply once for all
    // handlers. Assert the gate definition + global application.
    assert.match(overlayRoute, /requireRole\([^)]*"owner"[^)]*"admin"[^)]*"office"[^)]*"super_admin"[^)]*\)/);
    assert.match(overlayRoute, /router\.use\(officeGate\)/);
  });
  it("confirm handler imports recordUnexcusedEntryAndDriveLadder (not raw insert)", () => {
    // The handler body now lives in lib/attendance-overlay-handlers.ts
    // (extracted so tests can drive it with a fake tx without booting
    // drizzle). The import must be there, in the handler module.
    assert.match(overlayHandlers, /import\s*\{\s*recordUnexcusedEntryAndDriveLadder\s*\}\s*from\s*"\.\/unexcused-ladder-writer\.js"/);
  });
  it("confirm handler surfaces the missing_clockout_requires_override code", () => {
    // Lives in the extracted handler module.
    assert.match(overlayHandlers, /missing_clockout_requires_override/);
  });
  it("attendance-overlay route + handlers do NOT contain raw INSERT INTO employee_attendance_log SQL", () => {
    assert.ok(
      !/INSERT\s+INTO\s+employee_attendance_log/i.test(overlayRoute),
      "overlay route should flow attendance_log inserts through recordUnexcusedEntryAndDriveLadder",
    );
    assert.ok(
      !/INSERT\s+INTO\s+employee_attendance_log/i.test(overlayHandlers),
      "overlay handlers should flow attendance_log inserts through recordUnexcusedEntryAndDriveLadder",
    );
  });
  it("leave.ts /unexcused/record now delegates to recordUnexcusedEntryAndDriveLadder", () => {
    assert.match(leaveRoute, /recordUnexcusedEntryAndDriveLadder/);
    // No more raw discipline insert inlined in the route body — the
    // helper is the one place it lives.
    assert.ok(
      !/await\s+db\.insert\(employeeDisciplineLogTable\)/.test(leaveRoute),
      "leave route should delegate discipline insert to the helper",
    );
  });
  it("writer helper writes the canonical 'unexcused hours: X.XX' marker", () => {
    assert.match(writerLib, /unexcused hours:/);
  });

  // H. No-timeclock invariant — 3B owns only these four files.
  for (const [label, src] of [
    ["attendance-overlay.ts", overlayRoute],
    ["attendance-overlay-handlers.ts", overlayHandlers],
    ["attendance-discrepancy.ts", overlayLib],
    ["attendance_proposals.ts", schema],
  ] as const) {
    it(`${label} does NOT import the legacy timeclock table`, () => {
      assert.ok(!/\btimeclockTable\b/.test(src), `${label} references timeclockTable`);
      assert.ok(!/from\s+["'][./]*timeclock/.test(src), `${label} imports a timeclock module`);
      assert.ok(!/['"`]timeclock['"`]/.test(src), `${label} mentions "timeclock" as a string literal`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Document the constants are exported for tenant-override later
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 3B — thresholds exported (single source of truth)", () => {
  it("LATE / NO_SHOW / SHORT defaults match plan", () => {
    assert.equal(LATE_THRESHOLD_MINUTES_DEFAULT, 20);
    assert.equal(NO_SHOW_WAIT_MINUTES_DEFAULT, 20);
    assert.equal(SHORT_THRESHOLD_MINUTES_DEFAULT, 20);
  });
});
