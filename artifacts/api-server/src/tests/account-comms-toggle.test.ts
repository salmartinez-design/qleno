/**
 * Account-level "pause all communications" toggle.
 *
 * Stub-DB. Pins: the accounts.comms_enabled column + additive migration, the
 * shared helper, and that every automated client-resolving send path honors a
 * paused account (cron SQL guard, plus per-job helper checks).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { accountsTable } from "@workspace/db/schema";
import { isClientAccountCommsPaused } from "../lib/account-comms.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("account comms — schema + migration", () => {
  it("accounts.comms_enabled exists, defaults true", () => {
    const col = (accountsTable as any).comms_enabled;
    assert.ok(col, "accounts.comms_enabled should exist");
    assert.equal(col.name, "comms_enabled");
    assert.equal(col.default, true);
  });
  it("migration adds it idempotently", () => {
    assert.match(read("../phes-data-migration.ts"),
      /ALTER TABLE accounts ADD COLUMN IF NOT EXISTS comms_enabled boolean NOT NULL DEFAULT true/);
  });
  it("helper is exported", () => {
    assert.equal(typeof isClientAccountCommsPaused, "function");
  });
});

describe("account comms — enforced on every automated path", () => {
  const notif = read("../services/notificationService.ts");
  it("reminder cron (24h + 72h) excludes paused accounts", () => {
    // both reminder queries join accounts and gate on comms_enabled
    const matches = notif.match(/a\.id IS NULL OR a\.comms_enabled = true/g) || [];
    assert.ok(matches.length >= 3, `expected >=3 account guards (24h, 72h, review), got ${matches.length}`);
    assert.match(notif, /LEFT JOIN accounts a ON a\.id = c\.account_id/);
  });
  it("job completion checks the helper", () => {
    assert.match(read("../routes/jobs.ts"), /isClientAccountCommsPaused/);
  });
  it("payment receipt checks the helper", () => {
    assert.match(read("../routes/payments.ts"), /isClientAccountCommsPaused/);
  });
  it("on-my-way SMS checks the helper", () => {
    assert.match(read("../routes/tech-clock.ts"), /isClientAccountCommsPaused/);
  });
  it("accounts PATCH route accepts comms_enabled", () => {
    assert.match(read("../routes/accounts.ts"), /"comms_enabled"/);
  });
});
