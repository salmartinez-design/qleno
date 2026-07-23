/**
 * [job-ids-preserve 2026-07-23] Unit tests for the second line-item job carrier.
 *
 * The bug these lock down: the invoice edit UI sends whatever lines the office
 * left on screen, so collapsing four $210 job lines into one `quantity: 4` line
 * silently dropped three job_ids. Those visits stayed billed but unnamed, every
 * "already invoiced?" guard read them as never-billed, and they re-minted as
 * duplicate per-visit invoices (Halper #985 → jobs 15630/15631, voided as $420
 * of phantom A/R). preserveJobIds keeps the orphans; the guards read both shapes.
 *
 * No DB — pure functions, same as the normalize-line-items tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lineItemJobIds, collectJobIds, preserveJobIds } from "../lib/invoice-job-ids.js";

describe("lineItemJobIds", () => {
  it("reads the classic single job_id carrier", () => {
    assert.deepEqual(lineItemJobIds({ job_id: 15629, total: 210 }), [15629]);
  });

  it("reads the job_ids array carrier", () => {
    assert.deepEqual(lineItemJobIds({ job_ids: [1, 2, 3] }), [1, 2, 3]);
  });

  it("unions both carriers without duplicating the shared id", () => {
    assert.deepEqual(lineItemJobIds({ job_id: 7, job_ids: [7, 8] }), [7, 8]);
  });

  it("ignores junk, nulls and non-positive ids", () => {
    assert.deepEqual(lineItemJobIds({ job_id: null, job_ids: ["x", 0, -3, "12"] }), [12]);
    assert.deepEqual(lineItemJobIds({}), []);
    assert.deepEqual(lineItemJobIds(undefined), []);
  });
});

describe("collectJobIds", () => {
  it("gathers every id across lines, deduped and in first-seen order", () => {
    const lines = [
      { job_id: 4353 }, { job_id: 4354 }, { job_id: 4355, job_ids: [4355, 4356] },
    ];
    assert.deepEqual(collectJobIds(lines), [4353, 4354, 4355, 4356]);
  });

  it("returns empty for a non-array or a line set with no ids", () => {
    assert.deepEqual(collectJobIds(null), []);
    assert.deepEqual(collectJobIds([{ description: "Parking fee", total: 25 }]), []);
  });
});

describe("preserveJobIds", () => {
  it("keeps the orphans when four job lines collapse into one qty-4 line", () => {
    // Exactly the Halper #985 shape: four $210 visits hand-collapsed to $840.
    const before = [
      { job_id: 15629, total: 210 }, { job_id: 15630, total: 210 },
      { job_id: 15631, total: 210 }, { job_id: 15632, total: 210 },
    ];
    const after = [{ description: "Common Areas — July 2026", quantity: 4, unit_price: 210, total: 840, job_id: 15629 }];
    const out = preserveJobIds(before, after);
    assert.deepEqual(out[0].job_ids, [15629, 15630, 15631, 15632]);
    // amounts untouched — this carrier never re-prices anything
    assert.equal(out[0].total, 840);
    assert.equal(out[0].quantity, 4);
    assert.equal(out.length, 1);
  });

  it("leaves an unchanged save completely alone (no spurious job_ids)", () => {
    const lines = [{ job_id: 1, total: 100 }, { job_id: 2, total: 100 }];
    const out = preserveJobIds(lines, lines.map((l) => ({ ...l })));
    assert.equal(out[0].job_ids, undefined);
    assert.equal(out[1].job_ids, undefined);
  });

  it("does not invent ids when the invoice never had any", () => {
    const out = preserveJobIds([{ description: "Deep clean", total: 300 }], [{ description: "Deep clean", total: 350 }]);
    assert.equal(out[0].job_ids, undefined);
  });

  it("recognises an id already preserved in job_ids and adds nothing", () => {
    const before = [{ job_id: 5, job_ids: [5, 6] }];
    const after = [{ job_id: 5, job_ids: [5, 6], total: 400 }];
    assert.deepEqual(preserveJobIds(before, after)[0].job_ids, [5, 6]);
  });

  it("merges orphans onto the first line without disturbing later lines", () => {
    const before = [{ job_id: 10 }, { job_id: 11 }, { job_id: 12 }];
    const after = [{ job_id: 10, total: 200 }, { description: "Parking fee", total: 25 }];
    const out = preserveJobIds(before, after);
    assert.deepEqual(out[0].job_ids, [10, 11, 12]);
    assert.deepEqual(out[1], { description: "Parking fee", total: 25 });
  });

  it("is a no-op on an empty or non-array edit rather than throwing", () => {
    assert.deepEqual(preserveJobIds([{ job_id: 1 }], []), []);
    assert.equal(preserveJobIds([{ job_id: 1 }], undefined as unknown as any[]), undefined);
  });

  it("never treats quantity as a visit count", () => {
    // National Able: quantity 8 = HOURS for ONE visit, not eight visits.
    const before = [{ job_id: 4353, quantity: 8, unit_price: 50, total: 400 }];
    const after = [{ job_id: 4353, quantity: 8, unit_price: 50, total: 400 }];
    assert.deepEqual(collectJobIds(preserveJobIds(before, after)), [4353]);
  });
});
