/**
 * Reminder cron query guard.
 *
 * The 24h/72h reminder cron silently crashed on every run because its SQL
 * filtered `status NOT IN ('cancelled','void','done','complete')` — but the
 * job_status enum only has scheduled|in_progress|complete|cancelled, so Postgres
 * threw "invalid input value for enum job_status: void" and NO reminder ever
 * sent. These assertions pin the fix: only valid enum statuses, and a
 * per-company comms gate so disabled tenants are never texted.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../services/notificationService.ts"),
  "utf8",
);

describe("reminder cron query", () => {
  it("never references the non-existent statuses 'void' or 'done'", () => {
    assert.doesNotMatch(src, /'void'/, "remove invalid enum status 'void'");
    assert.doesNotMatch(src, /'done'/, "remove invalid enum status 'done'");
  });
  it("filters on valid enum statuses only", () => {
    assert.match(src, /status NOT IN \('cancelled', 'complete'\)/);
  });
  it("gates on per-company comms_enabled (won't text disabled tenants)", () => {
    assert.match(src, /JOIN companies co ON co\.id = j\.company_id/);
    assert.match(src, /co\.comms_enabled = true/);
  });
  // [stale-alert-fix 2026-07-07] A charged cancellation/lockout is stored as
  // status='complete' (fee billed) with its original FUTURE date — the
  // after-appointment branch used to send the post-visit thank-you/review
  // message for it, so cancelled clients kept getting texts "as if they are
  // still booked". Pin the cancellation_log exclusion.
  it("after-appointment branch excludes charged cancellations/lockouts", () => {
    assert.match(src, /NOT EXISTS \([\s\S]{0,200}?cl\.job_id = j\.id AND cl\.cancel_action IN \('cancel', 'lockout'\)/);
  });
});
