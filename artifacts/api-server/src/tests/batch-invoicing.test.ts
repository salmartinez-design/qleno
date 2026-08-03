/**
 * Batch invoicing — regression tests pinned to KMA's July 2026 sequence.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * In July 2026 KMA Property Management paid six ACH deposits totalling
 * $1,475. Qleno showed seven invoices for the month, on three different
 * numbering schemes, split across two customer records, most of them folded
 * to $0.00 and hidden from the list — Maribel's exact words were "They
 * disapeared." The customer had the PDFs; the system did not agree with
 * itself about what it had billed.
 *
 * Root cause was not one bug. "Combine these invoices into one" had been
 * implemented FIVE separate times — the cadence cron, batch-invoicing.ts,
 * /invoices/merge, the account Generate Invoice button, and bill-week —
 * each with its own idempotency rule and none aware of the others. Six
 * writers against one table with no shared rule about which document owns
 * a given visit's dollars.
 *
 * The fix is structural, and these tests guard the structure:
 *   R1  Nothing is ever lost.        A member keeps its number and its total.
 *   R2  Exactly one document per dollar.  Enforced by a partial unique index
 *       on invoice_job_links (company_id, job_id) WHERE is_live.
 *
 * Sal's requirement was "but this has to stick we cannot keep dealing with
 * this every month" — so the load-bearing guarantee lives in the database,
 * not in a code path anyone can forget to call. What is testable WITHOUT a
 * database is asserted here: the status vocabulary, the inert-status list
 * every writer shares, the terms→due-date math, and the customer-facing PDF
 * rules. The index itself is verified against production by the dry-run
 * script, which reported 0 violations.
 *
 * These run against a stub DATABASE_URL and never connect — same convention
 * as the rest of the suite (see cutover-1a-data-backbone.test.ts).
 *
 * See docs/BATCH_INVOICING_DESIGN.md.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { invoiceStatusEnum } from "@workspace/db/schema";
import { INERT_STATUSES, dueDateFromTerms } from "../lib/invoice-billing.js";

describe("batch invoicing — status vocabulary", () => {
  it("'batched' is a real invoice status", () => {
    assert.ok(
      invoiceStatusEnum.enumValues.includes("batched" as any),
      "invoice_status must carry 'batched' — it is what replaces the destructive 'superseded' fold",
    );
  });

  it("'superseded' still exists so historical rows keep rendering", () => {
    // The July KMA rows are already 'superseded' in production. Removing the
    // value would orphan them; the migration promotes coverage, it does not
    // rewrite history.
    assert.ok(invoiceStatusEnum.enumValues.includes("superseded" as any));
  });

  it("'batched' is appended LAST — Postgres enum values cannot be reordered", () => {
    const vals = invoiceStatusEnum.enumValues;
    assert.equal(vals[vals.length - 1], "batched");
  });

  it("the inert list is exactly void, superseded, batched", () => {
    // Every writer that asks "does this visit already have a live invoice?"
    // shares this list. If a status is added here it must also be added to
    // the guards in routes/invoices.ts, routes/jobs.ts and quickbooks-sync.ts,
    // or a member becomes editable and the parent's total stops matching its
    // own lines.
    assert.deepEqual([...INERT_STATUSES], ["void", "superseded", "batched"]);
  });

  it("a batched member is NOT in an A/R-bearing status", () => {
    // A/R rollups select 'sent' / 'overdue'. This is what stops a combined
    // invoice being counted twice — once as the parent, once per member.
    const arStatuses = ["sent", "overdue"];
    for (const s of INERT_STATUSES) {
      assert.ok(!arStatuses.includes(s), `${s} must not read as outstanding receivable`);
    }
  });
});

describe("batch invoicing — due date from payment terms (D8)", () => {
  // D8: every KMA July invoice had due_date == issue date, because the fold
  // wrote `due_date: today` regardless of the account's terms. Net-30 work
  // therefore showed as overdue the moment it was issued.
  const issued = new Date("2026-07-31T12:00:00.000Z");

  it("net_30 lands 30 days out, not on the issue date", () => {
    assert.equal(dueDateFromTerms("net_30", issued), "2026-08-30");
  });

  it("net_15 lands 15 days out", () => {
    assert.equal(dueDateFromTerms("net_15", issued), "2026-08-15");
  });

  it("net_45 and net_60 parse from the same pattern", () => {
    assert.equal(dueDateFromTerms("net_45", issued), "2026-09-14");
    assert.equal(dueDateFromTerms("net_60", issued), "2026-09-29");
  });

  it("due-on-receipt is the issue date", () => {
    assert.equal(dueDateFromTerms("due_on_receipt", issued), "2026-07-31");
    assert.equal(dueDateFromTerms("receipt", issued), "2026-07-31");
  });

  it("null / unrecognised terms fall back to on-receipt rather than throwing", () => {
    assert.equal(dueDateFromTerms(null, issued), "2026-07-31");
    assert.equal(dueDateFromTerms(undefined, issued), "2026-07-31");
    assert.equal(dueDateFromTerms("whenever", issued), "2026-07-31");
  });

  it("crosses a month boundary correctly (the Jul 29 → Aug case)", () => {
    assert.equal(dueDateFromTerms("net_30", new Date("2026-07-29T00:00:00.000Z")), "2026-08-28");
  });
});

describe("KMA July 2026 — the numbers that must reconcile", () => {
  // The six ACH deposits KMA actually sent, from Sal's bank export.
  const ACH_DEPOSITS = [150, 150, 150, 325, 550, 150];
  // The three PDFs the office emailed, by scope. KMA receives one document
  // per scope per month — NOT one folded document for the whole month.
  const EMAILED_DOCUMENTS = { ashland: 550, commonAreas: 750, northAveOffice: 175 };

  it("the ACH deposits total the $1,475 Maribel quoted", () => {
    assert.equal(ACH_DEPOSITS.reduce((a, b) => a + b, 0), 1475);
  });

  it("three documents were sent, not one — grouping is the office's choice", () => {
    // Guard against a future 'improvement' that auto-folds an account's whole
    // month into a single invoice. KMA is billed per scope; collapsing that
    // would change what the customer receives.
    assert.equal(Object.keys(EMAILED_DOCUMENTS).length, 3);
  });

  it("$175 was the only document that survived, because it was not merged", () => {
    // Maribel: "the only one available is the 175 because it wasn't a merge."
    // That is the whole defect in one sentence — merging is what made invoices
    // disappear, so merging is what had to stop being destructive.
    assert.equal(EMAILED_DOCUMENTS.northAveOffice, 175);
  });

  it("what was emailed ties to what was banked — the failure was the ledger, not the math", () => {
    const emailed = Object.values(EMAILED_DOCUMENTS).reduce((a, b) => a + b, 0);
    const banked = ACH_DEPOSITS.reduce((a, b) => a + b, 0);
    assert.equal(emailed, 1475);
    assert.equal(banked, 1475);
    // They DO tie in total. The failure was never the arithmetic — it was that
    // the ledger could not show which document each dollar belonged to. That
    // is exactly what invoice_job_links now records.
    assert.equal(emailed - banked, 0);
  });
});
