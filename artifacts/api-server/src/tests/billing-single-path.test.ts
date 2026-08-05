/**
 * Billing coverage — the single-writer guard.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * docs/BATCH_INVOICING_DESIGN.md §5 is explicit that convention already failed
 * here four times, so the guarantees have to be structural: "a future code path
 * *cannot* reintroduce the bug." S-1 put the load-bearing rule in the database
 * (a partial unique index on invoice_job_links), and that rule works — but only
 * for writers that actually insert a link row.
 *
 * On 2026-08-05 an audit found that POST /api/invoices did not. It built its own
 * INSERT, checked no coverage, and wrote no link. The consequences were not
 * subtle:
 *   - the unique index had nothing to conflict with, so it could not fire;
 *   - runBillingIntegrityCheck's double-bill query reads the same table, so the
 *     duplicate was invisible to the nightly sweep too;
 *   - and its jobs came from `?uninvoiced=true`, which still asked the RETIRED
 *     question (`status IN ('sent','paid')`) — so drafts and 'batched' members
 *     of an already-combined invoice read back as unbilled work.
 * Every alarm in the system read clean while the office was one click from
 * billing a customer twice.
 *
 * These tests are source-level on purpose. The invariant being defended is
 * "there is no fifth writer" — a property of the codebase, not of any one
 * function's return value, and not something a DB-free unit test of a single
 * module can express. They run with no database, same as the rest of the suite.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(fileURLToPath(new URL("../", import.meta.url)));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "tests") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

// `code` strips line comments and block comments. The retired predicate is
// quoted in several explanatory comments (accounts.ts documents exactly why it
// was wrong) and flagging those would train people to delete the history rather
// than fix the query.
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const FILES = walk(SRC).map((f) => {
  const text = readFileSync(f, "utf8");
  return { path: relative(SRC, f), text, code: stripComments(text) };
});

describe("billing coverage — one writer, one predicate (design D-3 / S-1 / S-2)", () => {
  /**
   * The allow-list IS the design decision. Adding a file here means claiming
   * that it writes an invoice_job_links row in the same transaction — if it
   * doesn't, it can double-bill and neither the index nor the integrity sweep
   * will notice. Prefer delegating to ensurePerVisitInvoice or combineInvoices.
   */
  const ALLOWED_INVOICE_WRITERS = new Set([
    // The completion engine. Checks getVisitBillingState, writes coverage.
    "lib/ensure-invoice.ts",
    // The coverage engine itself: ensurePerVisitInvoice + combineInvoices.
    "lib/invoice-billing.ts",
    // The ad-hoc path only — client_id + explicit line_items, no job, so there
    // is no visit to claim. Its job-keyed branch delegates to the engine.
    "routes/invoices.ts",
    // Demo/seed fixtures, never a tenant's real billing.
    "seed-demo.ts",
  ]);

  it("no module creates an invoice outside the allow-list", () => {
    const writers = FILES.filter(
      (f) => /insert\(invoicesTable\)/.test(f.code) || /INSERT\s+INTO\s+invoices\b/i.test(f.code),
    ).map((f) => f.path);

    const unexpected = writers.filter((p) => !ALLOWED_INVOICE_WRITERS.has(p));
    assert.deepEqual(
      unexpected,
      [],
      `New invoice writer(s) found: ${unexpected.join(", ")}. ` +
        "Every path that creates an invoice must claim its visits via " +
        "setInvoiceCoverage in the SAME transaction, or the unique index and " +
        "the integrity sweep both go blind. Delegate to ensurePerVisitInvoice.",
    );
  });

  it("the retired uninvoiced predicate is gone everywhere", () => {
    // `status IN ('sent','paid')` as an is-this-billed test treats a draft and
    // a 'batched' member as unbilled. D-1/D-3: a draft counts as billed.
    const offenders = FILES.filter((f) =>
      /status\s+IN\s*\(\s*'sent'\s*,\s*'paid'\s*\)/i.test(f.code),
    ).map((f) => f.path);

    assert.deepEqual(
      offenders,
      [],
      `Retired billing predicate found in: ${offenders.join(", ")}. ` +
        "Use NOT EXISTS (SELECT 1 FROM invoice_job_links l WHERE l.company_id = … " +
        "AND l.job_id = … AND l.is_live) — the one predicate every surface shares.",
    );
  });

  it("the job-keyed create route delegates instead of hand-rolling an insert", () => {
    const route = FILES.find((f) => f.path === "routes/invoices.ts")!;
    assert.match(
      route.text,
      /ensurePerVisitInvoice/,
      "routes/invoices.ts must delegate job-keyed invoice creation to the coverage engine.",
    );
  });

  it("every surface that answers 'is this visit billed?' reads the ledger", () => {
    // The three consumers named in D-3. Each must reference invoice_job_links;
    // if one starts inferring coverage from invoice.status or a line_items
    // jsonb probe again, it will disagree with the others exactly as before.
    for (const path of ["routes/jobs.ts", "routes/accounts.ts", "lib/ensure-invoice.ts"]) {
      const f = FILES.find((x) => x.path === path);
      assert.ok(f, `${path} not found`);
      assert.match(
        f!.text,
        /invoice_job_links|getVisitBillingState|findLiveInvoiceForJob/,
        `${path} must resolve billing coverage through the shared ledger (design D-3).`,
      );
    }
  });
});
