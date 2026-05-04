/**
 * Parking-fee resolution waterfall tests.
 *
 * Coverage: `resolveParkingAddon` from `lib/recurring-jobs.ts` — verifies the
 * 3-tier waterfall added in PR #51:
 *
 *   schedule.parking_fee_amount > clients.parking_fee_amount > pricing_addons.price
 *
 * Pure unit tests — mocks `txOrDb.execute` so no live DB or running API needed.
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:parking
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveParkingAddon } from "../lib/recurring-jobs.js";

// Mock execute that routes by inspecting the rendered SQL string. Lets each
// test declare what each table lookup returns without depending on the call
// order — and lets us assert which queries fired (e.g. the clients lookup
// must NOT fire when the schedule override is set).
type MockResults = {
  pricing_addons: { rows: any[] };
  clients?: { rows: any[] };
  add_ons: { rows: any[] };
};
function makeMockExecute(results: MockResults) {
  const callLog: Array<"pricing_addons" | "clients" | "add_ons"> = [];
  const execute = async (sqlChunk: any) => {
    // drizzle's `sql` template returns an SQL object; serialize via toString
    // (sufficient for keyword matching — we just need to know which table).
    const text = String(sqlChunk?.queryChunks ? JSON.stringify(sqlChunk.queryChunks) : sqlChunk);
    if (text.includes("pricing_addons")) {
      callLog.push("pricing_addons");
      return results.pricing_addons;
    }
    if (text.includes("FROM clients")) {
      callLog.push("clients");
      if (!results.clients) {
        throw new Error("mock: clients lookup fired but test expected short-circuit");
      }
      return results.clients;
    }
    if (text.includes("add_ons")) {
      callLog.push("add_ons");
      return results.add_ons;
    }
    throw new Error(`mock execute: unrecognized query: ${text.slice(0, 100)}`);
  };
  return { execute, callLog };
}

describe("resolveParkingAddon — 3-tier waterfall", () => {
  it("schedule override wins; clients lookup is skipped", async () => {
    const mock = makeMockExecute({
      pricing_addons: { rows: [{ id: 100, name: "Parking Fee", price: "20" }] },
      // No `clients` entry — if the resolver tries to query it, the mock throws.
      add_ons: { rows: [{ id: 200 }] },
    });

    const result = await resolveParkingAddon(
      { company_id: 1, customer_id: 42, parking_fee_amount: "15" },
      mock,
    );

    assert.ok(result, "expected non-null result");
    assert.equal(result!.unit_price, "15", "schedule override $15 must win");
    assert.equal(result!.override_amount, "15", "override_amount reflects schedule value");
    assert.equal(result!.pricing_addon_id, 100);
    assert.equal(result!.add_on_id, 200);
    assert.deepEqual(mock.callLog, ["pricing_addons", "add_ons"], "clients lookup must be skipped");
  });

  it("client default wins when schedule override is null", async () => {
    const mock = makeMockExecute({
      pricing_addons: { rows: [{ id: 100, name: "Parking Fee", price: "20" }] },
      clients: { rows: [{ parking_fee_amount: "15" }] },
      add_ons: { rows: [{ id: 200 }] },
    });

    const result = await resolveParkingAddon(
      { company_id: 1, customer_id: 42, parking_fee_amount: null },
      mock,
    );

    assert.ok(result);
    assert.equal(result!.unit_price, "15", "client default $15 used when schedule blank");
    assert.equal(result!.override_amount, "15", "override_amount surfaces client value");
    assert.deepEqual(mock.callLog, ["pricing_addons", "clients", "add_ons"]);
  });

  it("tenant default fallback when neither schedule nor client set", async () => {
    const mock = makeMockExecute({
      pricing_addons: { rows: [{ id: 100, name: "Parking Fee", price: "20" }] },
      clients: { rows: [{ parking_fee_amount: null }] },
      add_ons: { rows: [{ id: 200 }] },
    });

    const result = await resolveParkingAddon(
      { company_id: 1, customer_id: 42, parking_fee_amount: null },
      mock,
    );

    assert.ok(result);
    assert.equal(result!.unit_price, "20", "tenant default $20 wins when schedule + client blank");
    assert.equal(result!.override_amount, null, "override_amount null when only tenant default used");
  });
});
