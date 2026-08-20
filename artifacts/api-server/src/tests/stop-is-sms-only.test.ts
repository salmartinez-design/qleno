// [stop-is-sms-only 2026-08-20] Sal: "STOP should only affect sms shouldnt it?"
//
// STOP is a text-message word. It means "quit texting me", not "quit contacting
// me" -- that is what the email unsubscribe link in the footer is for, and it
// sets email_opt_out_at instead. Before this, an inbound STOP ended the whole
// follow-up enrollment, so the email steps died with the texts. That is how the
// Pious Projects estimate lost its Friday follow-up email: the contact texted
// STOP at the Thursday reminder and never once unsubscribed from email.
//
// The fix is subtraction, not a new mechanism. Only a real REPLY stops the
// cadence (a person is in the conversation, the office takes over). On STOP the
// enrollment keeps running, and the cadence runner's existing per-step check
// (isSmsOptedOut in processEnrollment) marks each SMS touch 'blocked' and
// advances to the next step. Texts go quiet, email carries on.
//
// These are source assertions, not behavior tests: the guard is one `if` in two
// files and it is easy to delete by accident while refactoring inbound SMS.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

describe("STOP silences texts only, never email", () => {
  const inbound = read("../routes/comms-inbound.ts");
  const leadSync = read("../lib/lead-sync.ts");
  const runner = read("../services/followUpService.ts");

  it("keeps STOP out of the client cadence stop", () => {
    const call = inbound.indexOf("stopEnrollmentsForClient(match.client_id");
    assert.ok(call > 0, "stopEnrollmentsForClient call moved or was renamed");
    const guard = inbound.lastIndexOf("if (!optOut)", call);
    assert.ok(guard > 0, "client cadence stop is no longer guarded by if (!optOut)");
    assert.ok(
      inbound.slice(guard, call).includes("{"),
      "expected the guard to open a block before the stop call",
    );
  });

  it("keeps STOP out of the estimate cadence stop", () => {
    const call = inbound.indexOf("stopEstimateEnrollmentsByPhone(companyId");
    assert.ok(call > 0, "stopEstimateEnrollmentsByPhone call moved or was renamed");
    assert.ok(
      inbound.lastIndexOf("if (!optOut)", call) > 0,
      "estimate cadence stop is no longer guarded by if (!optOut)",
    );
  });

  it("never passes an opted_out reason to a cadence stop", () => {
    assert.ok(
      !/stopEnrollmentsForClient\([^)]*opted_out/.test(inbound),
      "a STOP must not stop the client cadence, so no opted_out reason belongs here",
    );
    assert.ok(
      !/stopEstimateEnrollmentsByPhone\([^)]*opted_out/.test(inbound),
      "a STOP must not stop the estimate cadence, so no opted_out reason belongs here",
    );
  });

  it("keeps STOP out of the lead cadence stop", () => {
    const update = leadSync.indexOf("UPDATE follow_up_enrollments SET stopped_at = NOW()");
    assert.ok(update > 0, "the lead enrollment stop moved or was rewritten");
    assert.ok(
      leadSync.lastIndexOf("if (!optOut)", update) > 0,
      "lead enrollment stop is no longer guarded by if (!optOut)",
    );
  });

  it("still records the text opt-out itself", () => {
    assert.ok(
      inbound.includes("setSmsOptOutByPhone"),
      "STOP must still record the SMS opt-out, otherwise the texts keep going",
    );
  });

  it("relies on the runner blocking each SMS step and moving on", () => {
    // This is what makes leaving the enrollment alive safe. If either half of
    // it goes away, STOP starts texting again.
    assert.ok(
      /isSmsOptedOut\(/.test(runner),
      "the cadence runner must still check isSmsOptedOut before an SMS step",
    );
    assert.ok(
      /sendStatus = "blocked"/.test(runner),
      "a suppressed SMS step must still be logged as blocked, not sent",
    );
    assert.ok(
      /UPDATE follow_up_enrollments\s+SET current_step =/.test(runner),
      "the runner must still advance to the next step after a blocked touch",
    );
  });
});
