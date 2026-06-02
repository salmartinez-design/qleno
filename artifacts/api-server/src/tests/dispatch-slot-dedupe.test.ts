/**
 * BUG-1 regression — dispatch slotKey must distinguish commercial jobs
 * that share (date, time) but live on different account properties.
 *
 * Before the fix: slotKey was `${client_id ?? "n"}|date|time`. Commercial
 * jobs have client_id=NULL, so two commercial jobs at the same time on
 * the same date collapsed to "n|date|time" — the second one was silently
 * dropped from the dispatch payload.
 *
 * After the fix: slotKey uses (account_id, account_property_id) when
 * client_id is null, so each property gets its own slot.
 *
 * Pure unit test — replicates the slotKey logic from routes/dispatch.ts.
 * If that helper ever moves into a shared module, swap to importing it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

type SlotInput = {
  client_id: number | null;
  account_id: number | null;
  account_property_id: number | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
};

// Replicates the slotKey function exactly as it lives in
// artifacts/api-server/src/routes/dispatch.ts around line 691.
function slotKey(j: SlotInput): string {
  const identity = j.client_id != null
    ? `c${j.client_id}`
    : `a${j.account_id ?? "n"}p${j.account_property_id ?? "n"}`;
  return `${identity}|${j.scheduled_date ?? ""}|${j.scheduled_time ?? "00:00:00"}`;
}

describe("dispatch slotKey — BUG-1 regression", () => {
  it("residential jobs at the same time on the same date for different clients have distinct slot keys", () => {
    const a = slotKey({
      client_id: 100, account_id: null, account_property_id: null,
      scheduled_date: "2026-06-01", scheduled_time: "13:00:00",
    });
    const b = slotKey({
      client_id: 101, account_id: null, account_property_id: null,
      scheduled_date: "2026-06-01", scheduled_time: "13:00:00",
    });
    assert.notEqual(a, b, `Expected distinct slot keys, got "${a}" and "${b}"`);
  });

  it("two commercial jobs at the same (date, time) for the same account but different properties have distinct slot keys", () => {
    // The real-world repro: Daniel Walter Properties had two 13:00 jobs on
    // 2026-06-01 — PPM Unit Turnover at property 18 (job 5661, tech 516)
    // and PPM Common Areas at property 21 (job 5663, tech 44). Same
    // account, same date/time, different properties.
    const ppmUnit = slotKey({
      client_id: null, account_id: 3, account_property_id: 18,
      scheduled_date: "2026-06-01", scheduled_time: "13:00:00",
    });
    const ppmCommon = slotKey({
      client_id: null, account_id: 3, account_property_id: 21,
      scheduled_date: "2026-06-01", scheduled_time: "13:00:00",
    });
    assert.notEqual(ppmUnit, ppmCommon,
      `BUG-1 regression: commercial jobs at same time on different properties collapsed to ${ppmUnit}`);
  });

  it("two commercial jobs at the same (date, time) at the same property still collapse (intentional dedupe)", () => {
    // The dedupe still has to catch genuine duplicates — same account
    // AND same property AND same time means somebody double-booked.
    // (Backed by the partial unique index per the comment around line 685.)
    const a = slotKey({
      client_id: null, account_id: 3, account_property_id: 18,
      scheduled_date: "2026-06-01", scheduled_time: "13:00:00",
    });
    const b = slotKey({
      client_id: null, account_id: 3, account_property_id: 18,
      scheduled_date: "2026-06-01", scheduled_time: "13:00:00",
    });
    assert.equal(a, b);
  });

  it("residential and commercial jobs never share a slot key even when their numeric IDs collide", () => {
    // client_id=3 and account_id=3 must NOT produce the same key.
    const resi = slotKey({
      client_id: 3, account_id: null, account_property_id: null,
      scheduled_date: "2026-06-01", scheduled_time: "13:00:00",
    });
    const comm = slotKey({
      client_id: null, account_id: 3, account_property_id: 1,
      scheduled_date: "2026-06-01", scheduled_time: "13:00:00",
    });
    assert.notEqual(resi, comm);
    // The prefix discriminator ("c" vs "a") guarantees this.
    assert.ok(resi.startsWith("c3|"));
    assert.ok(comm.startsWith("a3p1|"));
  });

  it("handles null date and null time gracefully (legacy/orphan jobs)", () => {
    const k = slotKey({
      client_id: 100, account_id: null, account_property_id: null,
      scheduled_date: null, scheduled_time: null,
    });
    assert.equal(k, "c100||00:00:00");
  });
});
