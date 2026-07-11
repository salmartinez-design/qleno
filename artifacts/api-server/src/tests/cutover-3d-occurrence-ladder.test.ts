/**
 * Cutover 3D — occurrence-based disciplinary ladder (PHES, Sal 2026-06-24).
 *
 * Pure evaluator tests + a fake-tx integration confirming the ladder fires the
 * written warning at the 3rd occurrence, is idempotent within a benefit year,
 * and drives the tardy counter independently.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateOccurrenceLadder,
  nextOccurrenceStep,
  type OccurrenceStep,
} from "../lib/unexcused-ladder.js";
import { recordUnexcusedEntryAndDriveLadder } from "../lib/unexcused-ladder-writer.js";

const PHES_UNEX: OccurrenceStep[] = [
  { occurrence: 3, discipline_type: "absence_warning", label: "Written warning", notify: true },
  { occurrence: 4, discipline_type: "final_warning", label: "Final warning", notify: true },
  { occurrence: 5, discipline_type: "termination", label: "Termination", notify: true },
];
const PHES_TARDY: OccurrenceStep[] = [
  { occurrence: 3, discipline_type: "tardy_warning", label: "Written warning", notify: true },
  { occurrence: 4, discipline_type: "final_warning", label: "Final warning", notify: true },
  { occurrence: 5, discipline_type: "termination", label: "Termination", notify: true },
];

describe("evaluateOccurrenceLadder", () => {
  it("fires nothing below the first step", () => {
    assert.equal(evaluateOccurrenceLadder(PHES_UNEX, 2, new Set()).triggered_step, null);
  });
  it("fires written warning at the 3rd occurrence", () => {
    const e = evaluateOccurrenceLadder(PHES_UNEX, 3, new Set());
    assert.equal(e.triggered_step?.discipline_type, "absence_warning");
    assert.equal(e.triggered_step?.label, "Written warning");
  });
  it("fires the HIGHEST crossed step on a jump (→5 = termination, once)", () => {
    const e = evaluateOccurrenceLadder(PHES_UNEX, 5, new Set());
    assert.equal(e.triggered_step?.discipline_type, "termination");
  });
  it("does not re-fire an already-fired step", () => {
    assert.equal(evaluateOccurrenceLadder(PHES_UNEX, 3, new Set([3])).triggered_step, null);
    // but the next step still fires once count reaches it
    assert.equal(evaluateOccurrenceLadder(PHES_UNEX, 4, new Set([3])).triggered_step?.discipline_type, "final_warning");
  });
});

describe("nextOccurrenceStep — card progress", () => {
  it("returns the next un-reached step", () => {
    assert.equal(nextOccurrenceStep(PHES_UNEX, 0)?.occurrence, 3);
    assert.equal(nextOccurrenceStep(PHES_UNEX, 3)?.occurrence, 4);
    assert.equal(nextOccurrenceStep(PHES_UNEX, 4)?.occurrence, 5);
  });
  it("null once all steps crossed / none configured", () => {
    assert.equal(nextOccurrenceStep(PHES_UNEX, 5), null);
    assert.equal(nextOccurrenceStep([], 0), null);
  });
});

// ── Fake tx integration ──────────────────────────────────────────────────────
function makeFakeTx(opts: {
  unexSteps?: OccurrenceStep[];
  tardySteps?: OccurrenceStep[];
  hire_date?: string;
  attendance?: Array<{ type?: string; is_protected?: boolean }>;
  discipline?: Array<{ reason: string }>;
}) {
  const disciplineInserts: any[] = [];
  const NAME = Symbol.for("drizzle:Name");
  const tx: any = {
    insert: (table: any) => ({
      values: (v: any) => ({
        returning: () => {
          const name = String(table?.[NAME] ?? "");
          if (name === "employee_discipline_log") {
            disciplineInserts.push(v);
            return Promise.resolve([{ id: 99 }]);
          }
          return Promise.resolve([{ id: 1 }]); // attendance_log
        },
      }),
    }),
    select: () => {
      const chain: any = {
        _table: "",
        from(t: any) { chain._table = String(t?.[NAME] ?? ""); return chain; },
        where() { return chain; },
        limit() {
          if (chain._table === "company_attendance_policy")
            return Promise.resolve([{ unexcused_hours_steps: [], unexcused_occurrence_steps: opts.unexSteps ?? [], tardy_occurrence_steps: opts.tardySteps ?? [] }]);
          if (chain._table === "users") return Promise.resolve([{ hire_date: opts.hire_date ?? "2023-01-01" }]);
          return Promise.resolve([]);
        },
        then(resolve: any) {
          // Real attendance rows carry a `type`; the writer's counting is now
          // type-aware (absent=1, ncns=2). These fixtures model absences unless
          // a row overrides `type`, so default to "absent".
          if (chain._table === "employee_attendance_log")
            return resolve((opts.attendance ?? []).map((a) => ({ type: a.type ?? "absent", is_protected: a.is_protected ?? false })));
          if (chain._table === "employee_discipline_log") return resolve((opts.discipline ?? []).map((d) => ({ reason: d.reason })));
          return resolve([]);
        },
      };
      return chain;
    },
  };
  return { tx, disciplineInserts };
}

describe("recordUnexcusedEntryAndDriveLadder — occurrence path", () => {
  it("3rd unexcused absence → fires written warning (absence_warning) with occ marker", async () => {
    const fake = makeFakeTx({ unexSteps: PHES_UNEX, attendance: [{}, {}, {}], discipline: [] });
    const r = await recordUnexcusedEntryAndDriveLadder(fake.tx, {
      company_id: 1, employee_id: 42, log_date: "2026-05-29", hours: 8, type: "absent", logged_by: 1,
    });
    assert.equal(fake.disciplineInserts.length, 1);
    assert.equal(fake.disciplineInserts[0].discipline_type, "absence_warning");
    assert.match(fake.disciplineInserts[0].reason, /unexcused-occ s=3 by=2026-01-01 count=3/);
    assert.equal(r.discipline_log_id, 99);
  });
  it("2nd unexcused absence → no discipline", async () => {
    const fake = makeFakeTx({ unexSteps: PHES_UNEX, attendance: [{}, {}], discipline: [] });
    await recordUnexcusedEntryAndDriveLadder(fake.tx, {
      company_id: 1, employee_id: 42, log_date: "2026-05-29", hours: 8, type: "absent", logged_by: 1,
    });
    assert.equal(fake.disciplineInserts.length, 0);
  });
  it("idempotent: step already fired this benefit year → no re-fire", async () => {
    const fake = makeFakeTx({
      unexSteps: PHES_UNEX,
      attendance: [{}, {}, {}],
      discipline: [{ reason: "unexcused-occ s=3 by=2026-01-01 count=3" }],
    });
    await recordUnexcusedEntryAndDriveLadder(fake.tx, {
      company_id: 1, employee_id: 42, log_date: "2026-05-29", hours: 8, type: "absent", logged_by: 1,
    });
    assert.equal(fake.disciplineInserts.length, 0);
  });
  it("protected absences don't count toward the ladder", async () => {
    const fake = makeFakeTx({ unexSteps: PHES_UNEX, attendance: [{}, {}, { is_protected: true }], discipline: [] });
    await recordUnexcusedEntryAndDriveLadder(fake.tx, {
      company_id: 1, employee_id: 42, log_date: "2026-05-29", hours: 8, type: "absent", logged_by: 1,
    });
    assert.equal(fake.disciplineInserts.length, 0); // only 2 count
  });
  it("NCNS weighs +2 on the unexcused counter (2 NCNS = 4 occ → highest crossed step fires)", async () => {
    const fake = makeFakeTx({
      unexSteps: PHES_UNEX, // 3/4/5
      attendance: [{ type: "ncns" }, { type: "ncns" }], // 2 × 2 = 4 occurrences
      discipline: [],
    });
    await recordUnexcusedEntryAndDriveLadder(fake.tx, {
      company_id: 1, employee_id: 42, log_date: "2026-05-29", hours: 8, type: "ncns", logged_by: 1,
    });
    assert.equal(fake.disciplineInserts.length, 1);
    // 4 crosses steps 3 and 4 → highest not-yet-fired = 4 = final_warning.
    assert.equal(fake.disciplineInserts[0].discipline_type, "final_warning");
    assert.match(fake.disciplineInserts[0].reason, /unexcused-occ s=4 .* count=4/);
  });
  it("tardy counter is independent (uses tardy_occurrence_steps, tardy_warning)", async () => {
    const fake = makeFakeTx({ tardySteps: PHES_TARDY, attendance: [{}, {}, {}], discipline: [] });
    await recordUnexcusedEntryAndDriveLadder(fake.tx, {
      company_id: 1, employee_id: 42, log_date: "2026-05-29", hours: 0, type: "tardy", logged_by: 1,
    });
    assert.equal(fake.disciplineInserts.length, 1);
    assert.equal(fake.disciplineInserts[0].discipline_type, "tardy_warning");
    assert.match(fake.disciplineInserts[0].reason, /tardy-occ s=3/);
  });
});
