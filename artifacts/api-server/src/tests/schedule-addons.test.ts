/**
 * Schedule add-on resolution tests.
 *
 * Coverage: `resolveScheduleAddOns` from `lib/recurring-jobs.ts` — the
 * per-add-on quantity + first-visit/every-visit carry-through added for the
 * hourly/recurring add-ons feature. Verifies:
 *   - qty is preserved (and floored to >= 1),
 *   - every_visit true/false round-trips,
 *   - the add_ons.id FK is resolved from an existing row (no create),
 *   - a missing add_ons row is created and its new id used.
 *
 * Pure unit tests — mocks `txOrDb.execute` so no live DB or running API needed.
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:schedule-addons
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveScheduleAddOns } from "../lib/recurring-jobs.js";

// Route each query by inspecting the rendered SQL. `junction` = the
// recurring_schedule_add_ons ⋈ pricing_addons SELECT; `add_ons_select` = the
// FK lookup; `add_ons_insert` = the create-if-missing path.
function makeMockExecute(opts: {
  junction: { rows: any[] };
  addOnsSelect: { rows: any[] };
  addOnsInsert?: { rows: any[] };
}) {
  const callLog: string[] = [];
  const execute = async (sqlChunk: any) => {
    const text = String(sqlChunk?.queryChunks ? JSON.stringify(sqlChunk.queryChunks) : sqlChunk);
    if (text.includes("recurring_schedule_add_ons")) {
      callLog.push("junction");
      return opts.junction;
    }
    if (text.includes("INSERT INTO add_ons")) {
      callLog.push("add_ons_insert");
      return opts.addOnsInsert ?? { rows: [{ id: 999 }] };
    }
    if (text.includes("add_ons")) {
      callLog.push("add_ons_select");
      return opts.addOnsSelect;
    }
    throw new Error(`mock execute: unrecognized query: ${text.slice(0, 120)}`);
  };
  return { execute, callLog };
}

describe("resolveScheduleAddOns — qty + recurrence carry-through", () => {
  it("preserves qty and every_visit=false; reuses an existing add_ons row", async () => {
    const mock = makeMockExecute({
      junction: { rows: [{ pricing_addon_id: 100, qty: "2", every_visit: false, addon_name: "Oven Cleaning" }] },
      addOnsSelect: { rows: [{ id: 200 }] },
    });

    const result = await resolveScheduleAddOns({ id: 7, company_id: 1 }, mock);

    assert.equal(result.length, 1);
    assert.equal(result[0].pricing_addon_id, 100);
    assert.equal(result[0].add_on_id, 200, "existing add_ons.id reused");
    assert.equal(result[0].qty, 2, "office-set quantity preserved");
    assert.equal(result[0].every_visit, false, "first-visit-only flag round-trips");
    assert.deepEqual(mock.callLog, ["junction", "add_ons_select"], "no add_ons create when one exists");
  });

  it("defaults every_visit true and floors qty to >= 1", async () => {
    const mock = makeMockExecute({
      junction: { rows: [{ pricing_addon_id: 101, qty: "0", every_visit: true, addon_name: "Refrigerator Cleaning" }] },
      addOnsSelect: { rows: [{ id: 201 }] },
    });

    const result = await resolveScheduleAddOns({ id: 7, company_id: 1 }, mock);

    assert.equal(result[0].qty, 1, "qty floored to a minimum of 1");
    assert.equal(result[0].every_visit, true);
  });

  it("creates the add_ons row when none exists and uses the new id", async () => {
    const mock = makeMockExecute({
      junction: { rows: [{ pricing_addon_id: 102, qty: "3", every_visit: true, addon_name: "Kitchen Cabinets" }] },
      addOnsSelect: { rows: [] },
      addOnsInsert: { rows: [{ id: 555 }] },
    });

    const result = await resolveScheduleAddOns({ id: 7, company_id: 1 }, mock);

    assert.equal(result[0].add_on_id, 555, "newly-created add_ons.id used");
    assert.equal(result[0].qty, 3);
    assert.deepEqual(mock.callLog, ["junction", "add_ons_select", "add_ons_insert"]);
  });

  it("returns [] when the schedule sold no add-ons (no FK work)", async () => {
    const mock = makeMockExecute({
      junction: { rows: [] },
      addOnsSelect: { rows: [] },
    });

    const result = await resolveScheduleAddOns({ id: 7, company_id: 1 }, mock);

    assert.deepEqual(result, []);
    assert.deepEqual(mock.callLog, ["junction"], "no add_ons queries for an empty schedule");
  });
});
