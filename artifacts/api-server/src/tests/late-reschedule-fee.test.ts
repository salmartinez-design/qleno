/**
 * [late-reschedule-fee 2026-08-19] Maribel: "when rescheduling a job within 48
 * hours, we should be able to charge fee or to generate an invoice" — and on the
 * workaround: "doesnt make sense to have to cancel it and schedule it again,
 * this messes with the stats and isn't practical."
 *
 * The invariants that matter:
 *   - the visit still HAPPENS, so the job keeps its status and its price
 *   - the log row stays cancel_action='move', so reports still call it a
 *     reschedule and not a cancellation
 *   - the fee invoice must NOT claim the visit, or the cleaning never bills
 *   - the window is decided by the SERVER from the job's own row
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveRescheduleNotice, scheduledStartWallClock, LATE_RESCHEDULE_WINDOW_HOURS,
} from "../lib/reschedule-fee.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const route = read("../routes/cancellation.ts");
const feeInvoice = read("../lib/reschedule-fee-invoice.ts");
/** Comments explain why a thing is absent; strip them so the absence is tested. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const feeInvoiceCode = stripComments(feeInvoice);

// A fixed instant so these never depend on when the suite runs.
// 2026-08-19 09:00 Chicago = 14:00 UTC (CDT).
const NOW = new Date("2026-08-19T14:00:00Z");
const CT = "America/Chicago";
const notice = (date: string | null, time: string | null) =>
  resolveRescheduleNotice({ scheduledDate: date, scheduledTime: time, now: NOW, tz: CT });

describe("scheduledStartWallClock", () => {
  it("parses 24h and 12h times", () => {
    assert.equal(scheduledStartWallClock("2026-08-20", "13:00")!.toISOString(), "2026-08-20T13:00:00.000Z");
    assert.equal(scheduledStartWallClock("2026-08-20", "1:00 PM")!.toISOString(), "2026-08-20T13:00:00.000Z");
    assert.equal(scheduledStartWallClock("2026-08-20", "09:00:00")!.toISOString(), "2026-08-20T09:00:00.000Z");
  });

  it("anchors a timeless job at midnight — the reading that favours the customer", () => {
    assert.equal(scheduledStartWallClock("2026-08-20", null)!.toISOString(), "2026-08-20T00:00:00.000Z");
  });

  it("returns null without a date", () => {
    assert.equal(scheduledStartWallClock(null, "13:00"), null);
  });
});

describe("the 48-hour window", () => {
  it("Rachel Stark, moved Aug 19 for an Aug 20 visit — late", () => {
    // The move in Maribel's screenshot: 9 AM on the 19th, visit at 9 AM on the
    // 20th. 24 hours' notice.
    const n = notice("2026-08-20", "09:00");
    assert.equal(n.hours_notice, 24);
    assert.equal(n.is_late, true);
  });

  it("a visit four days out is not late", () => {
    const n = notice("2026-08-23", "09:00");
    assert.equal(n.is_late, false);
    assert.ok((n.hours_notice ?? 0) > LATE_RESCHEDULE_WINDOW_HOURS);
  });

  it("the boundary belongs to the customer — exactly 48h is NOT late", () => {
    const n = notice("2026-08-21", "09:00");
    assert.equal(n.hours_notice, 48);
    assert.equal(n.is_late, false);
  });

  it("one minute inside the window is late", () => {
    const n = notice("2026-08-21", "08:59");
    assert.equal(n.is_late, true);
  });

  it("a visit already in the past is the most short-notice case there is", () => {
    const n = notice("2026-08-18", "09:00");
    assert.ok((n.hours_notice ?? 0) < 0);
    assert.equal(n.is_late, true);
  });

  it("no scheduled date means no window and no fee", () => {
    assert.deepEqual(notice(null, "09:00").is_late, false);
  });
});

describe("the route decides the window, not the caller", () => {
  it("re-resolves the notice from the job's own row", () => {
    const block = route.slice(route.indexOf("const notice = resolveRescheduleNotice("), route.indexOf("const feeBasis"));
    assert.ok(block.includes("row.scheduled_date"), "must read the job, not the request");
    assert.ok(block.includes("row.scheduled_time"));
    assert.ok(block.includes("tzOf(companyId)"), "measured in the tenant's own clock");
  });

  it("refuses a fee on a move with plenty of notice instead of dropping it", () => {
    const block = route.slice(route.indexOf("if (rescheduleFeeRequested && !notice.is_late)"));
    assert.ok(block.includes("NOT_A_LATE_RESCHEDULE"));
    assert.ok(block.includes("422"), "silently ignoring it would let the office believe a fee was billed");
  });

  it("only move and bump can carry one", () => {
    const block = route.slice(route.indexOf("const rescheduleFeeRequested"), route.indexOf("const rescheduleFee ="));
    assert.ok(block.includes("isReschedule"));
  });
});

describe("the visit is untouched — this is the whole point", () => {
  it("no branch flips status or billed_amount for a reschedule fee", () => {
    // A cancellation fee REPLACES the price (status='complete', billed_amount =
    // fee). Doing that here would destroy the price of a job still on the
    // calendar. The fee must live only on its own invoice.
    const block = route.slice(route.indexOf("const rescheduleFee ="), route.indexOf("const feeBasis"));
    assert.ok(!/billed_amount/.test(block));
    assert.ok(!/next_job_status|status = 'complete'/.test(block));
  });

  it("the log row stays a move, so the reports still call it a reschedule", () => {
    const insert = route.slice(route.indexOf("cancel_action: action,"), route.indexOf("affects_future_jobs: policy.affects_future_jobs"));
    assert.ok(insert.includes("rescheduleFee > 0 ? rescheduleFee : finalCharge"), "the money changes; the action does not");
    assert.ok(!insert.includes("cancel_action: \"cancel\""));
  });
});

describe("the fee invoice must not claim the visit", () => {
  it("leaves invoices.job_id NULL", () => {
    assert.ok(/job_id: null/.test(feeInvoiceCode), "a fee invoice carrying the job could read as coverage");
  });

  it("never records billing coverage", () => {
    // invoice_job_links is the one predicate every billing path shares. If the
    // fee claimed the visit, ensureInvoiceForCompletedJob would find live
    // coverage on the new date and skip it — the cleaning would never bill.
    assert.ok(!feeInvoiceCode.includes("setInvoiceCoverage"), "must not claim the visit");
    assert.ok(!feeInvoiceCode.includes("invoice_job_links"), "must not touch the coverage ledger");
    assert.ok(!feeInvoiceCode.includes("ensureInvoiceForCompletedJob"));
  });

  it("names the visit it is charging about", () => {
    assert.ok(feeInvoice.includes("Late reschedule fee"));
    assert.ok(feeInvoice.includes("moved on short notice"), "an unplaceable fee line gets disputed");
  });

  it("bills nothing when the amount is zero", () => {
    assert.ok(feeInvoice.includes("if (!(amount > 0)) return null;"));
  });
});

describe("an account job has no client to bill", () => {
  it("reports it rather than dropping it", () => {
    const block = route.slice(route.indexOf("if (rescheduleFee > 0) {"));
    assert.ok(block.includes("row.client_id == null"));
    assert.ok(block.includes("feeInvoiceError = true"));
  });
});
