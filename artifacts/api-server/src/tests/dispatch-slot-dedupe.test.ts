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
  id: number;
  client_id: number | null;
  account_id: number | null;
  account_property_id: number | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
};

// Replicates the slotKey function exactly as it lives in
// artifacts/api-server/src/routes/dispatch.ts around line 720.
// [FOLLOW-UP A / 2026-06-02] job.id appended so two distinct DB rows
// never share a key, no matter what the rest of the row looks like.
function slotKey(j: SlotInput): string {
  const identity = j.client_id != null
    ? `c${j.client_id}`
    : `a${j.account_id ?? "n"}p${j.account_property_id ?? "n"}`;
  return `${identity}|${j.scheduled_date ?? ""}|${j.scheduled_time ?? "00:00:00"}|${j.id}`;
}

describe("dispatch slotKey — BUG-1 regression", () => {
  it("residential jobs at the same time on the same date for different clients have distinct slot keys", () => {
    const a = slotKey({
      id: 9001,
      client_id: 100, account_id: null, account_property_id: null,
      scheduled_date: "2026-06-01", scheduled_time: "13:00:00",
    });
    const b = slotKey({
      id: 9002,
      client_id: 101, account_id: null, account_property_id: null,
      scheduled_date: "2026-06-01", scheduled_time: "13:00:00",
    });
    assert.notEqual(a, b, `Expected distinct slot keys, got "${a}" and "${b}"`);
  });

  it("two commercial jobs at the same (date, time) for the same account but different properties have distinct slot keys", () => {
    // Real-world repro: Daniel Walter Properties had two 13:00 jobs on
    // 2026-06-01 — PPM Unit Turnover at property 18 (job 5661) and PPM
    // Common Areas at property 21 (job 5663). Same account, same time,
    // different properties.
    const ppmUnit = slotKey({
      id: 5661,
      client_id: null, account_id: 3, account_property_id: 18,
      scheduled_date: "2026-06-01", scheduled_time: "13:00:00",
    });
    const ppmCommon = slotKey({
      id: 5663,
      client_id: null, account_id: 3, account_property_id: 21,
      scheduled_date: "2026-06-01", scheduled_time: "13:00:00",
    });
    assert.notEqual(ppmUnit, ppmCommon,
      `BUG-1 regression: commercial jobs at same time on different properties collapsed to ${ppmUnit}`);
  });

  it("residential and commercial jobs never share a slot key even when their numeric IDs collide", () => {
    const resi = slotKey({
      id: 100,
      client_id: 3, account_id: null, account_property_id: null,
      scheduled_date: "2026-06-01", scheduled_time: "13:00:00",
    });
    const comm = slotKey({
      id: 101,
      client_id: null, account_id: 3, account_property_id: 1,
      scheduled_date: "2026-06-01", scheduled_time: "13:00:00",
    });
    assert.notEqual(resi, comm);
    assert.ok(resi.startsWith("c3|"));
    assert.ok(comm.startsWith("a3p1|"));
  });

  it("handles null date and null time gracefully (legacy/orphan jobs)", () => {
    const k = slotKey({
      id: 9999,
      client_id: 100, account_id: null, account_property_id: null,
      scheduled_date: null, scheduled_time: null,
    });
    assert.equal(k, "c100||00:00:00|9999");
  });

  // ── [FOLLOW-UP A / 2026-06-02] Cases Sal called out explicitly ─────

  it("two commercial jobs at the same (date, time) on DIFFERENT accounts produce distinct keys", () => {
    // Live repro: 5654 (Jennifer Halper, acct=4/prop=28 @14:00) collapsed
    // with 5663 (Daniel Walter, acct=3/prop=21 @14:00). Different accounts
    // entirely. Identity discriminator already distinguishes them, but
    // job.id appended at the end guarantees the key is unique regardless
    // of whether account_id is populated correctly on the row at runtime.
    const halper = slotKey({
      id: 5654,
      client_id: null, account_id: 4, account_property_id: 28,
      scheduled_date: "2026-06-01", scheduled_time: "14:00:00",
    });
    const walter = slotKey({
      id: 5663,
      client_id: null, account_id: 3, account_property_id: 21,
      scheduled_date: "2026-06-01", scheduled_time: "14:00:00",
    });
    assert.notEqual(halper, walter);
  });

  it("two commercial jobs same account+property+date+time but DIFFERENT job.id still render as distinct cards", () => {
    // The persisted-rows-are-truth principle: if the DB has two rows with
    // matching account/property/time (whether legitimate split-bookings or
    // a data quirk), dispatch should render both. The old slotKey would
    // collapse them; the id-suffixed key keeps them distinct.
    const a = slotKey({
      id: 5660,
      client_id: null, account_id: 3, account_property_id: 18,
      scheduled_date: "2026-06-01", scheduled_time: "13:00:00",
    });
    const b = slotKey({
      id: 5661,
      client_id: null, account_id: 3, account_property_id: 18,
      scheduled_date: "2026-06-01", scheduled_time: "13:00:00",
    });
    assert.notEqual(a, b,
      `Distinct DB rows ${a} and ${b} must remain distinct in dispatch output`);
  });

  it("commercial jobs with NULL account_property_id at the same time on different accounts still distinct", () => {
    // Defense in depth: even if account_property_id is missing on both
    // rows (legacy migration data), account_id+id keeps them distinct.
    const a = slotKey({
      id: 7001,
      client_id: null, account_id: 3, account_property_id: null,
      scheduled_date: "2026-06-01", scheduled_time: "10:00:00",
    });
    const b = slotKey({
      id: 7002,
      client_id: null, account_id: 4, account_property_id: null,
      scheduled_date: "2026-06-01", scheduled_time: "10:00:00",
    });
    assert.notEqual(a, b);
  });

  it("commercial jobs with EVERYTHING null except job.id remain distinct", () => {
    // The ultimate guarantee: even if every other field is null/garbled,
    // appending job.id to the key ensures two distinct DB rows never
    // collapse — operator never sees a missing chip from a dedup race.
    const a = slotKey({
      id: 1,
      client_id: null, account_id: null, account_property_id: null,
      scheduled_date: null, scheduled_time: null,
    });
    const b = slotKey({
      id: 2,
      client_id: null, account_id: null, account_property_id: null,
      scheduled_date: null, scheduled_time: null,
    });
    assert.notEqual(a, b);
  });
});
