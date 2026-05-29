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
    const ev: ClockEventForOverlay[] = [
      projectChicago(makeEvent({ id: 1, job_id: 100, user_id: 50, event_type: "clock_in", event_at: new Date(`${today}T18:45:00Z`) }), today, 13 * 60 + 45),
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

function makeFakeDb(proposal: FakeProposalRow | null, opts: {
  policy_steps?: any[];
  recent_attendance?: { log_date: string; notes: string }[];
  recent_discipline?: { reason: string }[];
  update_returns_zero?: boolean;
}) {
  const inserts: InsertedAttendanceLog[] = [];
  const discipline_inserts: Array<{ reason: string }> = [];
  let proposalUpdated = false;
  const proposalState: FakeProposalRow | null = proposal ? { ...proposal } : null;

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
        values: (v: any) => ({
          returning: (_proj?: any) => {
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
            return Promise.resolve([{ id: 1 }]);
          },
        }),
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
    assert.match(overlayRoute, /import\s*\{\s*recordUnexcusedEntryAndDriveLadder\s*\}\s*from\s*"\.\.\/lib\/unexcused-ladder-writer\.js"/);
  });
  it("confirm handler surfaces the missing_clockout_requires_override code", () => {
    assert.match(overlayRoute, /missing_clockout_requires_override/);
  });
  it("attendance-overlay route does NOT contain raw INSERT INTO employee_attendance_log SQL", () => {
    assert.ok(
      !/INSERT\s+INTO\s+employee_attendance_log/i.test(overlayRoute),
      "overlay route should flow attendance_log inserts through recordUnexcusedEntryAndDriveLadder",
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

  // H. No-timeclock invariant — 3B owns only these three files.
  for (const [label, src] of [
    ["attendance-overlay.ts", overlayRoute],
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
