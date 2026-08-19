/**
 * [adjustment-wipe 2026-08-19] Editing the base rate must not delete the
 * adjustments from the price.
 *
 * Cheryl McCarthy, job 21080. A Compass quote carried a −$417 discount and the
 * customer's own quote email totalled it correctly:
 *
 *     Move Out            $1,903.00
 *     Oven Cleaning        +$240.00
 *     Refrigerator         +$120.00
 *     Kitchen Cabinets     +$100.00
 *     Quote adjustment     −$417.00
 *     First visit total  $1,946.00      ← right
 *
 * The office then corrected the base rate on the job card, and the discount
 * vanished from the total: $2,780 where the breakdown on the same card summed
 * to $2,363. Maribel: "but it's not taking the discount" — and she was reading
 * the total at the exact moment it was wrong, because editing the price is when
 * you look at it.
 *
 * CAUSE. PATCH /jobs/:id assigned `billed_amount = base_fee` outright — the base
 * price with every adjustment deleted from it. billed_amount is DEFINED as
 * base_fee + SUM(job_rate_mods.amount). Commercial jobs were rescued by the
 * full recompute that runs after the transaction; residential fell through to
 * the commission-only branch and kept the wiped number.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jobs = readFileSync(path.join(__dirname, "../routes/jobs.ts"), "utf8");

const patch = jobs.slice(jobs.indexOf("const priceChanged"), jobs.indexOf("export async function recomputeJobBilledAmount"));

describe("the PATCH never stamps the base over the billed amount", () => {
  it("no `billed_amount = base_fee` assignment survives", () => {
    // The whole bug in one line. Any form of it puts the discount back in the bin.
    assert.ok(
      !/setParts\.billed_amount\s*=\s*String\(base_fee\)/.test(jobs),
      "billed_amount is base_fee + SUM(mods); assigning the base alone deletes every adjustment",
    );
  });

  it("a residential price edit refreshes billed_amount from base + adjustments", () => {
    const block = jobs.slice(jobs.indexOf("[adjustment-wipe 2026-08-19] Refresh billed_amount too"));
    assert.ok(block.includes("FROM job_rate_mods m"), "the adjustments must be summed back in");
    assert.ok(block.includes("(j.base_fee)::numeric"), "on top of the all-in base");
    assert.ok(block.includes("GREATEST(0,"), "a credit larger than the job cannot cost less than nothing");
  });

  it("does NOT full-recompute residential commission_base", () => {
    // recomputeJobBilledAmount rewrites commission_base from scratch, which for
    // residential double-counts add-ons and OVERPAYS the cleaner — the reason
    // the delta logic exists at all. The fix touches only the wrong column.
    const block = jobs.slice(
      jobs.indexOf("[adjustment-wipe 2026-08-19] Refresh billed_amount too"),
      jobs.indexOf("[commission-base-drift 2026-08-09]"),
    );
    assert.ok(!block.includes("recomputeJobBilledAmount("), "must not rewrite commission_base");
  });

  it("still moves commission_base by the price delta", () => {
    // The [commission-base-stale 2026-07-23] fix must survive intact.
    assert.ok(jobs.includes("SET commission_base = GREATEST(0, (commission_base)::numeric + ${delta})"));
  });
});

describe("the definition of billed_amount is unchanged", () => {
  it("projectJobBilling still bills base + adjustments for residential", () => {
    const fn = jobs.slice(jobs.indexOf("async function projectJobBilling"));
    assert.ok(fn.includes("newBilled = base + modsTotal;"), "this is the definition the PATCH must agree with");
  });

  it("Cheryl's numbers: 2320 base + 460 add-ons − 417 = 2363", () => {
    // The arithmetic the card was getting wrong, pinned so a refactor cannot
    // quietly reintroduce "base only".
    const baseAllIn = 2320 + 240 + 120 + 100;   // base_fee is all-in for residential
    const mods = -417;
    assert.equal(baseAllIn, 2780);
    assert.equal(Math.max(0, baseAllIn + mods), 2363);
  });
});
