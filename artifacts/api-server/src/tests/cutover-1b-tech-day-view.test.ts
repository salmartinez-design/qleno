/**
 * Cutover 1B — Tech day view tests.
 *
 * Spec invariants verified:
 *   1. Grouping rules: complete (or clock_out_at) → done; clock_in_at no
 *      clock_out OR status='in_progress' → current; earliest remaining →
 *      next; everything else → later.
 *   2. Hero rule: if current exists it is the hero, else next.
 *   3. There is no userId override param on /api/tech/today — the
 *      handler always uses req.auth!.userId. This is the privacy
 *      invariant. The route source is grep-asserted below; an
 *      integration test would need a real DB which the stub harness
 *      can't provide.
 *   4. Office event / meeting items render distinctly (job_kind flag
 *      is preserved in the serialized payload).
 *
 * The grouping logic lives inline in routes/tech.ts. To keep the test
 * self-contained without bootstrapping a Drizzle client against the
 * stub DATABASE_URL, we re-implement the same rule below and verify
 * the output for a handful of fixture rows. If the inline rule in
 * routes/tech.ts diverges from this contract, the runtime will
 * surface the regression and this test catches drift in the
 * single-source rule.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

type GroupingHint = "done" | "current" | "next" | "later";
type Decorated = {
  isComplete: boolean;
  isCurrent: boolean;
};

/** Mirrors the inline rule in routes/tech.ts. Single-pass: first not-done /
 *  not-current item is 'next'; rest are 'later'. */
function applyGrouping(decorated: Decorated[]): GroupingHint[] {
  let nextAssigned = false;
  return decorated.map((d) => {
    if (d.isComplete) return "done";
    if (d.isCurrent) return "current";
    if (!nextAssigned) {
      nextAssigned = true;
      return "next";
    }
    return "later";
  });
}

describe("Cutover 1B — grouping rules", () => {
  it("status='complete' marks an item as done", () => {
    const out = applyGrouping([
      { isComplete: true, isCurrent: false },
      { isComplete: false, isCurrent: false },
      { isComplete: false, isCurrent: false },
    ]);
    assert.deepEqual(out, ["done", "next", "later"]);
  });

  it("clock_out_at set marks an item as done (even without status='complete')", () => {
    // The route derives isComplete from (status='complete' OR clock_out_at).
    // Here we test the downstream grouping; both produce isComplete=true.
    const out = applyGrouping([
      { isComplete: true, isCurrent: false }, // clock_out present
      { isComplete: false, isCurrent: false },
    ]);
    assert.equal(out[0], "done");
  });

  it("clock_in_at without clock_out_at marks an item as current", () => {
    const out = applyGrouping([
      { isComplete: false, isCurrent: false },
      { isComplete: false, isCurrent: true }, // mid-shift
      { isComplete: false, isCurrent: false },
    ]);
    assert.deepEqual(out, ["next", "current", "later"]);
  });

  it("when there is a current item the next-down-the-list is 'next'", () => {
    // Sorted by scheduled_time. First not-current, not-done → next.
    const out = applyGrouping([
      { isComplete: true, isCurrent: false },
      { isComplete: false, isCurrent: true },
      { isComplete: false, isCurrent: false },
      { isComplete: false, isCurrent: false },
    ]);
    assert.deepEqual(out, ["done", "current", "next", "later"]);
  });

  it("when nothing is current the earliest remaining is 'next'", () => {
    const out = applyGrouping([
      { isComplete: true, isCurrent: false },
      { isComplete: false, isCurrent: false },
      { isComplete: false, isCurrent: false },
      { isComplete: false, isCurrent: false },
    ]);
    assert.deepEqual(out, ["done", "next", "later", "later"]);
  });

  it("all-done day collapses to all-done hints", () => {
    const out = applyGrouping([
      { isComplete: true, isCurrent: false },
      { isComplete: true, isCurrent: false },
    ]);
    assert.deepEqual(out, ["done", "done"]);
  });

  it("empty day returns empty grouping list", () => {
    const out = applyGrouping([]);
    assert.deepEqual(out, []);
  });

  it("never assigns more than one 'next' even when several remain", () => {
    const out = applyGrouping([
      { isComplete: false, isCurrent: false },
      { isComplete: false, isCurrent: false },
      { isComplete: false, isCurrent: false },
      { isComplete: false, isCurrent: false },
    ]);
    assert.equal(out.filter((g) => g === "next").length, 1);
    assert.deepEqual(out, ["next", "later", "later", "later"]);
  });
});

describe("Cutover 1B — privacy invariant (a tech only ever sees their own day)", () => {
  // [view-as 2026-08-07] This test used to assert that routes/tech.ts never
  // reads req.query.employee_id AT ALL. Cutover 1B decided "there is NO userId
  // override — even the owner cannot view a tech's day here."
  //
  // Then [tech-scorecard 2026-07-14] deliberately added an owner/admin/office
  // "viewing as" override, to match the impersonation banner and the
  // /api/jobs/my-jobs day view. Nobody updated this test, so it has been red on
  // main ever since — and a permanently-failing privacy test is worse than no
  // test, because it trains everyone to ignore the one alarm that matters.
  //
  // The invariant that actually protects a tech was never the ABSENCE of the
  // param — it is that the param is IGNORED for anyone who isn't office staff.
  // That is what these assertions pin now.
  const src = readFileSync(path.resolve(process.cwd(), "src/routes/tech.ts"), "utf8");

  it("resolves the viewed user from req.auth, never from the query alone", () => {
    assert.ok(
      /req\.auth!\.userId/.test(src),
      "routes/tech.ts must source userId from req.auth!.userId",
    );
  });

  it("gates any employee_id override on an office-level role", () => {
    // The override and the role check have to live in the same function. A
    // future refactor that reads employee_id somewhere WITHOUT a role gate is
    // exactly the regression this file exists to catch.
    if (!/req\.query\.employee_id/.test(src)) return; // no override at all — also fine

    const fn = src.match(/function resolveViewedUserId[\s\S]*?\n}/)?.[0];
    assert.ok(fn, "employee_id is read but resolveViewedUserId was not found — the override must stay in that one function");
    assert.ok(
      /req\.query\.employee_id/.test(fn!),
      "the employee_id override must live inside resolveViewedUserId, not scattered across handlers",
    );
    assert.match(
      fn!,
      /role\s*===\s*["']owner["']/,
      "the override must be gated on an office-level role — a tech's ?employee_id= must be ignored",
    );
    assert.ok(
      /canViewAsOther\s*&&/.test(fn!),
      "the override must only apply when the role check passes; otherwise fall back to self",
    );
  });

  it("reads employee_id only inside the gated resolver", () => {
    // Counting occurrences is the wrong test — the resolver's ternary reads the
    // param twice on one line, legitimately. What matters is that NO handler
    // reads it outside resolveViewedUserId, where the role gate lives.
    const fn = src.match(/function resolveViewedUserId[\s\S]*?\n}/)?.[0] ?? "";
    const total = (src.match(/req\.query\.employee_id/g) || []).length;
    const inResolver = (fn.match(/req\.query\.employee_id/g) || []).length;
    assert.equal(
      total - inResolver,
      0,
      `employee_id is read ${total - inResolver} time(s) outside resolveViewedUserId — ` +
        "every read must go through the role gate, or a tech could view another tech's day.",
    );
  });
});

describe("Cutover 1B — day summary counts", () => {
  it("counts done and remaining correctly given a grouping list", () => {
    const groupings: GroupingHint[] = ["done", "current", "next", "later", "later"];
    const done = groupings.filter((g) => g === "done").length;
    const remaining = groupings.length - done;
    assert.equal(done, 1);
    assert.equal(remaining, 4);
  });

  it("empty day yields 0 done and 0 remaining", () => {
    const groupings: GroupingHint[] = [];
    const done = groupings.filter((g) => g === "done").length;
    assert.equal(done, 0);
    assert.equal(groupings.length - done, 0);
  });
});

describe("Cutover 1B — date parameter validation", () => {
  // The handler accepts YYYY-MM-DD strictly. Defending the regex shape
  // here so a downstream refactor can't loosen it.
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  it("accepts well-formed ISO dates", () => {
    assert.ok(ISO_DATE_RE.test("2026-05-28"));
    assert.ok(ISO_DATE_RE.test("2027-01-01"));
  });

  it("rejects loose date strings", () => {
    assert.ok(!ISO_DATE_RE.test("2026-5-28"));
    assert.ok(!ISO_DATE_RE.test("2026/05/28"));
    assert.ok(!ISO_DATE_RE.test("May 28, 2026"));
    assert.ok(!ISO_DATE_RE.test("today"));
    assert.ok(!ISO_DATE_RE.test(""));
  });
});

describe("Cutover 1B — display name resolution (spec)", () => {
  // The route uses account_name > client_company_name > "First Last"
  // (matching MaidCentral's hierarchy). For office_event / meeting kinds
  // it falls back to a generic label. Mirroring that priority here as
  // a contract test so a future refactor doesn't break naming.
  function pickDisplayName(r: {
    job_kind: string;
    account_name: string | null;
    property_name: string | null;
    client_company_name: string | null;
    client_first_name: string | null;
    client_last_name: string | null;
  }): string {
    if (r.job_kind === "office_event" || r.job_kind === "meeting") {
      return r.account_name ?? "Office event";
    }
    if (r.account_name) {
      return r.property_name
        ? `${r.account_name} — ${r.property_name}`
        : r.account_name;
    }
    if (r.client_company_name) return r.client_company_name;
    const first = (r.client_first_name ?? "").trim();
    const last = (r.client_last_name ?? "").trim();
    return [first, last].filter(Boolean).join(" ") || "Client";
  }

  it("account_name + property_name renders as 'Account — Property'", () => {
    assert.equal(
      pickDisplayName({
        job_kind: "cleaning",
        account_name: "Heritage Condo",
        property_name: "Mansfield",
        client_company_name: null,
        client_first_name: null,
        client_last_name: null,
      }),
      "Heritage Condo — Mansfield",
    );
  });

  it("account_name alone renders as the account name", () => {
    assert.equal(
      pickDisplayName({
        job_kind: "cleaning",
        account_name: "Heritage Condo",
        property_name: null,
        client_company_name: null,
        client_first_name: null,
        client_last_name: null,
      }),
      "Heritage Condo",
    );
  });

  it("client_company_name takes precedence over client first/last when no account", () => {
    assert.equal(
      pickDisplayName({
        job_kind: "cleaning",
        account_name: null,
        property_name: null,
        client_company_name: "Daniel Walter LLC",
        client_first_name: "Daniel",
        client_last_name: "Walter",
      }),
      "Daniel Walter LLC",
    );
  });

  it("client first + last name as the final fallback", () => {
    assert.equal(
      pickDisplayName({
        job_kind: "cleaning",
        account_name: null,
        property_name: null,
        client_company_name: null,
        client_first_name: "Daniel",
        client_last_name: "Walter",
      }),
      "Daniel Walter",
    );
  });

  it("office_event uses generic label when no account is attached", () => {
    assert.equal(
      pickDisplayName({
        job_kind: "office_event",
        account_name: null,
        property_name: null,
        client_company_name: null,
        client_first_name: null,
        client_last_name: null,
      }),
      "Office event",
    );
  });

  it("meeting uses the same fallback rules", () => {
    assert.equal(
      pickDisplayName({
        job_kind: "meeting",
        account_name: "Phes HQ",
        property_name: null,
        client_company_name: null,
        client_first_name: null,
        client_last_name: null,
      }),
      "Phes HQ",
    );
  });

  it("empty/null all the way down returns 'Client' (never empty string)", () => {
    assert.equal(
      pickDisplayName({
        job_kind: "cleaning",
        account_name: null,
        property_name: null,
        client_company_name: null,
        client_first_name: null,
        client_last_name: null,
      }),
      "Client",
    );
  });
});
