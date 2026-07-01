import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { unionHoursByKey } from "../lib/timeclock-hours.js";

const iso = (d: string) => `2026-07-01T${d}`;

describe("unionHoursByKey — overlapping punches don't double-count", () => {
  it("two overlapping punches on one job count once (the Juliana bug)", () => {
    // Field-app punch + a near-identical duplicate → ~80 min, NOT 160.
    const m = unionHoursByKey([
      { job_id: 5397, user_id: 42, clock_in_at: iso("08:04:28"), clock_out_at: iso("09:24:27") },
      { job_id: 5397, user_id: 42, clock_in_at: iso("08:04:46"), clock_out_at: iso("09:24:22") },
    ]);
    // 08:04:28 → 09:24:27 = 79m59s ≈ 1.333h; the overlapping dup adds nothing.
    assert.ok(Math.abs(m.get("5397:42")! - 1.3331) < 0.001, `got ${m.get("5397:42")}`);
  });

  it("a real split shift (disjoint punches) still sums", () => {
    const m = unionHoursByKey([
      { job_id: 1, user_id: 1, clock_in_at: iso("08:00:00"), clock_out_at: iso("10:00:00") },
      { job_id: 1, user_id: 1, clock_in_at: iso("13:00:00"), clock_out_at: iso("15:00:00") },
    ]);
    assert.equal(m.get("1:1"), 4);
  });

  it("partial overlap merges to the union span", () => {
    // 08–10 and 09–11 → union 08–11 = 3h (not 4h).
    const m = unionHoursByKey([
      { job_id: 2, user_id: 1, clock_in_at: iso("08:00:00"), clock_out_at: iso("10:00:00") },
      { job_id: 2, user_id: 1, clock_in_at: iso("09:00:00"), clock_out_at: iso("11:00:00") },
    ]);
    assert.equal(m.get("2:1"), 3);
  });

  it("keeps techs and jobs separate", () => {
    const m = unionHoursByKey([
      { job_id: 1, user_id: 1, clock_in_at: iso("08:00:00"), clock_out_at: iso("10:00:00") },
      { job_id: 1, user_id: 2, clock_in_at: iso("08:00:00"), clock_out_at: iso("09:00:00") },
    ]);
    assert.equal(m.get("1:1"), 2);
    assert.equal(m.get("1:2"), 1);
  });

  it("skips open / invalid intervals", () => {
    const m = unionHoursByKey([
      { job_id: 1, user_id: 1, clock_in_at: iso("08:00:00"), clock_out_at: null },
      { job_id: 1, user_id: 1, clock_in_at: iso("10:00:00"), clock_out_at: iso("09:00:00") }, // out < in
      { job_id: 1, user_id: 1, clock_in_at: iso("08:00:00"), clock_out_at: iso("09:00:00") },
    ]);
    assert.equal(m.get("1:1"), 1);
  });
});
