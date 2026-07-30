/**
 * Regression test for the 2026-07-30 "deleted recurring occurrence keeps coming
 * back" incident (Ashley Doss, client 151).
 *
 * The DELETE / SKIP flows tombstone an occurrence by appending its date to the
 * schedule's `skipped_dates` (a Postgres `date[]`). The engine then excludes
 * those dates when generating. The pg driver returns `date[]` elements as JS
 * Date objects (local midnight), NOT ISO strings — so the old
 * `String(x).slice(0,10)` produced "Thu Jul 30", which never matched the
 * occurrence side's `toDateStr(occ)` ("2026-07-30"). Every tombstone was
 * silently ignored and the deleted occurrence regenerated.
 *
 * normalizeSkipSet must yield "YYYY-MM-DD" regardless of whether an element
 * arrives as a Date object or as a text date, so the skip actually matches.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSkipSet } from "../lib/recurring-jobs.js";

describe("normalizeSkipSet", () => {
  it("normalizes Date objects (the pg date[] shape) to YYYY-MM-DD", () => {
    // Jul 30 2026 at LOCAL midnight — exactly what the pg date parser returns.
    const set = normalizeSkipSet([new Date(2026, 6, 30)]);
    assert.ok(set.has("2026-07-30"), "a Date must normalize to 2026-07-30");
    assert.ok(!set.has("Thu Jul 30"), "must not leak the Date.toString() form");
  });

  it("still accepts legacy text dates unchanged", () => {
    const set = normalizeSkipSet(["2026-07-30", "2026-08-13"]);
    assert.ok(set.has("2026-07-30"));
    assert.ok(set.has("2026-08-13"));
  });

  it("handles a mixed Date + string array", () => {
    const set = normalizeSkipSet([new Date(2026, 7, 13), "2026-07-30"]);
    assert.equal(set.size, 2);
    assert.ok(set.has("2026-08-13"));
    assert.ok(set.has("2026-07-30"));
  });

  it("treats null / undefined / non-arrays as an empty set", () => {
    assert.equal(normalizeSkipSet(null).size, 0);
    assert.equal(normalizeSkipSet(undefined).size, 0);
    assert.equal(normalizeSkipSet("2026-07-30" as unknown).size, 0);
  });

  it("matches the same key the occurrence side builds for that day", () => {
    // toDateStr(new Date(2026,6,30)) === "2026-07-30" (local getters). The skip
    // set must produce the identical key for the tombstone to bite.
    const occKey = (() => {
      const d = new Date(2026, 6, 30);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    })();
    const set = normalizeSkipSet([new Date(2026, 6, 30)]);
    assert.ok(set.has(occKey), `skip set must contain the occurrence key ${occKey}`);
  });
});
