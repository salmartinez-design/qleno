/**
 * [integrity-alert 2026-08-19] The nightly billing sweep must reach a person.
 *
 * Walter Nunchuck's $195 clean invoiced at "Standard Clean · $0.00" and sat
 * unbilled for six weeks until a hand audit found it. The sweep had detected it
 * the whole time — "invoice totals $0" is finding #3 by name — and reported it
 * to console.warn, which nobody in the office reads.
 *
 * #1500 stops the zero being written. This is the backstop: if one ever appears
 * again, by some other route or on work that was never priced at all, somebody
 * is told the next morning.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const integrity = read("../lib/billing-integrity.ts");
const notifications = read("../routes/notifications.ts");
const index = read("../index.ts");
const cron = integrity.slice(integrity.indexOf("export async function runBillingIntegrityCron"));

describe("the sweep still runs, and still detects the Walter shape", () => {
  it("is scheduled nightly", () => {
    assert.ok(index.includes("runBillingIntegrityCron"), "an unscheduled sweep detects nothing");
    assert.ok(index.includes('fired["billing_integrity"]'));
  });

  it("still flags an invoice that totals $0 on completed billable work", () => {
    assert.ok(integrity.includes("'invoice totals $0'"));
    assert.ok(integrity.includes("COALESCE(${liveInvoiceTotal}, ${effectivePrice}) = 0"));
  });

  it("still excludes a charged cancellation — a fee is not an unset rate", () => {
    assert.ok(integrity.includes("AND NOT ${feeAlreadyCollected}"));
  });
});

describe("findings reach the office", () => {
  it("the cron writes a notification, not only a log line", () => {
    assert.ok(cron.includes("INSERT INTO notifications"));
    assert.ok(cron.includes("'billing_integrity'"));
  });

  it("office only — a tech never sees unbilled revenue", () => {
    // user_id NULL is the office/owner/admin broadcast; techs are scoped to
    // their own targeted rows.
    assert.ok(/VALUES \(\$\{c\.id\}, NULL, 'billing_integrity'/.test(cron), "must broadcast with user_id NULL");
    assert.ok(
      notifications.includes("isOffice ? sql`(user_id = ${userId} OR user_id IS NULL)` : sql`user_id = ${userId}`"),
      "the scoping rule this relies on must still hold",
    );
  });

  it("raises nothing when the books are clean", () => {
    assert.ok(integrity.includes("if (r.ok) return null;"));
  });

  it("never lets the alert break the sweep", () => {
    const block = cron.slice(cron.indexOf("const alert = buildIntegrityAlert"));
    assert.ok(block.includes("catch"), "one tenant's alert failure must not stop the rest");
  });
});

describe("it stays visible without becoming wallpaper", () => {
  it("does not stack a new bell every night on the same unresolved problem", () => {
    // The office inbox already carries 987 unread. A nightly duplicate is how a
    // real alert becomes invisible — the exact failure this is fixing.
    assert.ok(cron.includes("AND read = false AND user_id IS NULL"), "skip while one is standing");
    assert.ok(cron.includes("if (!standing.length)"));
  });
});

describe("the alert says something worth clicking", () => {
  const build = integrity.slice(integrity.indexOf("function buildIntegrityAlert"), integrity.indexOf("export async function runBillingIntegrityCron"));

  it("leads with the money", () => {
    assert.ok(build.includes("uncovered_total.toFixed(2)"), "the office triages by amount");
  });

  it("names real customers rather than a bare count", () => {
    assert.ok(build.includes("v.customer"), "'Walter Nunchuck, Aug 4' gets opened; '3 findings' gets deferred");
    assert.ok(build.includes("scheduled_date"));
  });

  it("puts double-billing first whatever the amounts", () => {
    // Charging a customer twice outranks any sum of unbilled work.
    assert.ok(build.includes("bits.unshift"), "contested visits lead");
    assert.ok(build.includes("billed twice"));
  });

  it("carries the job ids so the finding can be acted on", () => {
    assert.ok(build.includes("job_ids"));
  });
});
