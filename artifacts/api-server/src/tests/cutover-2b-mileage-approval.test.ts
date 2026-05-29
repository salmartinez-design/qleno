/**
 * Cutover 2B — Mileage approval gate tests.
 *
 * Pure unit tests for the 2B logic. The route's DB I/O is exercised
 * indirectly through the helpers it composes; the route SOURCE is
 * file-grep'd for the load-bearing assertions (apply creates one
 * pay_adjustment + bridge id, discard never inserts, apply blocks
 * approved/exported periods).
 *
 * What this suite defends:
 *
 *   A. Lifecycle transitions — every (from, action) pair returns
 *      the right allow/refuse, including the terminal applied +
 *      discarded states.
 *   B. Carpool detection — groups by (date, from_job, to_job),
 *      only surfaces multi-tech groups, ignores applied + discarded.
 *   C. Apply contract — route source proves apply INSERTs exactly
 *      one pay_adjustments row with type 'mileage_reimbursement',
 *      sets applied_pay_adjustment_id, transitions status to
 *      'applied'.
 *   D. Discard contract — route source proves discard does NOT
 *      insert into pay_adjustments.
 *   E. Period-state gate — apply (single + batch) refuses on
 *      approved/exported periods.
 *   F. Auth gating — apply requires admin role.
 *   G. Provider neutrality — 2B files contain no payroll vendor.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  refusalForTransition,
  detectCarpoolCandidates,
  MILEAGE_REIMBURSEMENT_ADJUSTMENT_TYPE,
  type LegForCarpoolCheck,
} from "../lib/mileage-approval.js";

// ─────────────────────────────────────────────────────────────────────────────
// A. Lifecycle transitions
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2B — lifecycle transitions", () => {
  it("computed → review allowed; reviewed → review refused", () => {
    assert.equal(refusalForTransition("computed", "review"), null);
    assert.match(
      refusalForTransition("reviewed", "review")!,
      /only computed legs/i,
    );
  });

  it("computed → discard allowed; reviewed → discard allowed", () => {
    assert.equal(refusalForTransition("computed", "discard"), null);
    assert.equal(refusalForTransition("reviewed", "discard"), null);
  });

  it("reviewed → apply allowed; computed → apply REFUSED (must review first)", () => {
    assert.equal(refusalForTransition("reviewed", "apply"), null);
    assert.match(
      refusalForTransition("computed", "apply")!,
      /only reviewed legs can be applied/i,
    );
  });

  it("applied is terminal — every action refused", () => {
    for (const action of ["review", "discard", "apply"] as const) {
      const r = refusalForTransition("applied", action);
      assert.ok(r, `applied → ${action} must be refused`);
      assert.match(r!, /already applied/i);
    }
  });

  it("discarded is terminal — every action refused", () => {
    for (const action of ["review", "discard", "apply"] as const) {
      const r = refusalForTransition("discarded", action);
      assert.ok(r, `discarded → ${action} must be refused`);
      assert.match(r!, /terminal/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Carpool detection
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2B — carpool candidate detection", () => {
  const baseLeg = (
    over: Partial<LegForCarpoolCheck>,
  ): LegForCarpoolCheck => ({
    id: 1,
    user_id: 1,
    leg_date: "2026-05-20",
    from_job_id: 100,
    to_job_id: 200,
    status: "computed",
    ...over,
  });

  it("two techs, same date + same job pair → ONE candidate", () => {
    const legs: LegForCarpoolCheck[] = [
      baseLeg({ id: 1, user_id: 11 }),
      baseLeg({ id: 2, user_id: 22 }),
    ];
    const out = detectCarpoolCandidates(legs);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.tech_count, 2);
    assert.equal(out[0]!.legs.length, 2);
  });

  it("same tech with two legs same date/pair → NOT a candidate (single tech)", () => {
    const legs: LegForCarpoolCheck[] = [
      baseLeg({ id: 1, user_id: 11 }),
      baseLeg({ id: 2, user_id: 11 }),
    ];
    assert.equal(detectCarpoolCandidates(legs).length, 0);
  });

  it("different days with same pair → NOT a candidate", () => {
    const legs: LegForCarpoolCheck[] = [
      baseLeg({ id: 1, user_id: 11, leg_date: "2026-05-20" }),
      baseLeg({ id: 2, user_id: 22, leg_date: "2026-05-21" }),
    ];
    assert.equal(detectCarpoolCandidates(legs).length, 0);
  });

  it("different job pairs same day → NOT a candidate", () => {
    const legs: LegForCarpoolCheck[] = [
      baseLeg({ id: 1, user_id: 11, to_job_id: 200 }),
      baseLeg({ id: 2, user_id: 22, to_job_id: 300 }),
    ];
    assert.equal(detectCarpoolCandidates(legs).length, 0);
  });

  it("applied + discarded legs are EXCLUDED from carpool consideration", () => {
    // Two techs would normally trigger, but one is already applied
    // and the other discarded — both decided, no decision left for
    // the office to make.
    const legs: LegForCarpoolCheck[] = [
      baseLeg({ id: 1, user_id: 11, status: "applied" }),
      baseLeg({ id: 2, user_id: 22, status: "discarded" }),
    ];
    assert.equal(detectCarpoolCandidates(legs).length, 0);
  });

  it("mixed: one applied + one reviewed + one computed (different techs) → 1 candidate of size 2", () => {
    const legs: LegForCarpoolCheck[] = [
      baseLeg({ id: 1, user_id: 11, status: "applied" }),
      baseLeg({ id: 2, user_id: 22, status: "reviewed" }),
      baseLeg({ id: 3, user_id: 33, status: "computed" }),
    ];
    const out = detectCarpoolCandidates(legs);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.tech_count, 2); // applied excluded
  });

  it("three techs same leg → tech_count = 3", () => {
    const legs: LegForCarpoolCheck[] = [
      baseLeg({ id: 1, user_id: 11 }),
      baseLeg({ id: 2, user_id: 22 }),
      baseLeg({ id: 3, user_id: 33 }),
    ];
    const out = detectCarpoolCandidates(legs);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.tech_count, 3);
  });

  it("candidates sorted by leg_date ascending", () => {
    const legs: LegForCarpoolCheck[] = [
      baseLeg({ id: 1, user_id: 11, leg_date: "2026-05-22", to_job_id: 200 }),
      baseLeg({ id: 2, user_id: 22, leg_date: "2026-05-22", to_job_id: 200 }),
      baseLeg({ id: 3, user_id: 11, leg_date: "2026-05-20", to_job_id: 201 }),
      baseLeg({ id: 4, user_id: 22, leg_date: "2026-05-20", to_job_id: 201 }),
    ];
    const out = detectCarpoolCandidates(legs);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.leg_date, "2026-05-20");
    assert.equal(out[1]!.leg_date, "2026-05-22");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Apply contract — file-grep on route source
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2B — apply contract (route source)", () => {
  const src = readFileSync(
    path.resolve(process.cwd(), "src/routes/pay.ts"),
    "utf8",
  );

  it("applyLegInternal INSERTs into payAdjustmentsTable", () => {
    const fnMatch = src.match(
      /async function applyLegInternal\([\s\S]+?\n\}/,
    );
    assert.ok(fnMatch, "applyLegInternal function body not found");
    assert.match(fnMatch![0], /\.insert\(payAdjustmentsTable\)/);
  });

  it("applyLegInternal uses MILEAGE_REIMBURSEMENT_ADJUSTMENT_TYPE", () => {
    const fnMatch = src.match(
      /async function applyLegInternal\([\s\S]+?\n\}/,
    );
    assert.match(
      fnMatch![0],
      /adjustment_type:\s*MILEAGE_REIMBURSEMENT_ADJUSTMENT_TYPE/,
    );
  });

  it("applyLegInternal sets applied_pay_adjustment_id on the leg", () => {
    const fnMatch = src.match(
      /async function applyLegInternal\([\s\S]+?\n\}/,
    );
    assert.match(fnMatch![0], /applied_pay_adjustment_id:\s*adjustmentId/);
    assert.match(fnMatch![0], /status:\s*"applied"/);
  });

  it("apply (single + batch) is admin-only via adminWriteGate", () => {
    assert.match(
      src,
      /router\.post\(\s*\n?\s*"\/mileage-legs\/:id\/apply",\s*\n?\s*adminWriteGate/,
    );
    assert.match(
      src,
      /router\.post\(\s*\n?\s*"\/periods\/:id\/mileage-legs\/apply-all-reviewed",\s*\n?\s*adminWriteGate/,
    );
  });

  it("MILEAGE_REIMBURSEMENT_ADJUSTMENT_TYPE is a distinct slug", () => {
    assert.equal(MILEAGE_REIMBURSEMENT_ADJUSTMENT_TYPE, "mileage_reimbursement");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Discard contract — never pays
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2B — discard never pays", () => {
  const src = readFileSync(
    path.resolve(process.cwd(), "src/routes/pay.ts"),
    "utf8",
  );

  it("discard endpoint body does NOT insert into pay_adjustments", () => {
    const m = src.match(
      /router\.post\(\s*\n?\s*"\/mileage-legs\/:id\/discard"[\s\S]+?^\);/m,
    );
    assert.ok(m, "discard route not found");
    assert.ok(
      !/insert\(payAdjustmentsTable\)/.test(m![0]),
      "discard must not write into pay_adjustments — money never moves on discard",
    );
  });

  it("discard requires a non-empty reason", () => {
    const m = src.match(
      /router\.post\(\s*\n?\s*"\/mileage-legs\/:id\/discard"[\s\S]+?^\);/m,
    );
    assert.match(m![0], /reason is required for discard/);
  });

  it("discard records discarded_by_user_id + discard_reason", () => {
    const m = src.match(
      /router\.post\(\s*\n?\s*"\/mileage-legs\/:id\/discard"[\s\S]+?^\);/m,
    );
    assert.match(m![0], /discarded_by_user_id:\s*userId/);
    assert.match(m![0], /discard_reason:\s*reason/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Period-state gate — apply refuses on approved/exported
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2B — apply blocked on approved/exported periods", () => {
  const src = readFileSync(
    path.resolve(process.cwd(), "src/routes/pay.ts"),
    "utf8",
  );

  it("single-leg apply checks period state before money moves", () => {
    const m = src.match(
      /router\.post\(\s*\n?\s*"\/mileage-legs\/:id\/apply"[\s\S]+?^\);/m,
    );
    assert.ok(m, "apply route not found");
    assert.match(m![0], /period\.status === "approved" \|\| period\.status === "exported"/);
    assert.match(m![0], /refusedDueToPeriodState/);
  });

  it("batch apply-all-reviewed checks period state up front", () => {
    const m = src.match(
      /router\.post\(\s*\n?\s*"\/periods\/:id\/mileage-legs\/apply-all-reviewed"[\s\S]+?^\);/m,
    );
    assert.ok(m, "batch apply route not found");
    assert.match(m![0], /period\.status === "approved" \|\| period\.status === "exported"/);
    assert.match(m![0], /refusedDueToPeriodState/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. Auth gating
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2B — auth gating", () => {
  const src = readFileSync(
    path.resolve(process.cwd(), "src/routes/pay.ts"),
    "utf8",
  );

  it("review + discard are office-tier (router-level officeReadGate)", () => {
    // review + discard are not adminWriteGate'd explicitly — they
    // inherit the file-level officeReadGate which excludes 'technician'
    // and 'team_lead'. That's correct: office staff can triage but
    // only owners/admins press the money button.
    assert.match(
      src,
      /const officeReadGate = requireRole\("owner", "admin", "office", "super_admin"\)/,
    );
    assert.match(src, /router\.use\(requireAuth, officeReadGate\)/);
    // Sanity: review + discard do NOT pass adminWriteGate.
    const review = src.match(
      /router\.post\(\s*\n?\s*"\/mileage-legs\/:id\/review",\s*[\s\S]+?^\);/m,
    );
    assert.ok(review);
    assert.ok(
      !/adminWriteGate/.test(review![0]),
      "review should NOT add adminWriteGate — office can mark reviewed",
    );
  });

  it("apply (single + batch) DOES pass adminWriteGate", () => {
    assert.match(
      src,
      /"\/mileage-legs\/:id\/apply",\s*\n?\s*adminWriteGate/,
    );
    assert.match(
      src,
      /"\/periods\/:id\/mileage-legs\/apply-all-reviewed",\s*\n?\s*adminWriteGate/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. Provider neutrality — 2B files
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2B — provider neutrality", () => {
  const PAYROLL_VENDOR_BLOCKLIST = [
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

  it("src/lib/mileage-approval.ts contains no payroll-vendor name", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/lib/mileage-approval.ts"),
      "utf8",
    ).toLowerCase();
    for (const v of PAYROLL_VENDOR_BLOCKLIST) {
      const re = new RegExp(`\\b${v.replace(/ /g, "\\s+")}\\b`, "i");
      assert.ok(
        !re.test(src),
        `mileage-approval.ts contains vendor "${v}"`,
      );
    }
  });
});
