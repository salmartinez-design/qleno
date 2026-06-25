/**
 * Phase 3 — Estimate auto-drip (native cadence).
 *
 * Stub-DB (no connection). Guards:
 *  - follow_up_enrollments.estimate_id on schema + additive migration.
 *  - The 8-touch estimate_followup copy is well-formed (channels, ordering,
 *    Day-0 email+SMS, merge fields present).
 *  - SAFETY: the sequence is seeded INACTIVE and enrollment requires an ACTIVE
 *    sequence, so the drip is inert until the office turns it on — independent
 *    of COMMS_ENABLED.
 *  - enroll/stop API surface exists.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { followUpEnrollmentsTable } from "@workspace/db/schema";
import {
  ESTIMATE_SEQUENCE_STEPS,
} from "../phes-data-migration.ts";
import {
  enrollForEstimateSent,
  stopEnrollmentsForEstimate,
  stopEstimateEnrollmentsByPhone,
} from "../services/followUpService.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");
const migration = read("../phes-data-migration.ts");
const engine = read("../services/followUpService.ts");
const route = read("../routes/estimates.ts");

describe("Phase 3 — schema + migration", () => {
  it("follow_up_enrollments.estimate_id on the Drizzle schema", () => {
    const col = (followUpEnrollmentsTable as any).estimate_id;
    assert.ok(col, "estimate_id should exist");
    assert.equal(col.name, "estimate_id");
  });
  it("migration adds estimate_id idempotently", () => {
    assert.match(migration, /ALTER TABLE follow_up_enrollments ADD COLUMN IF NOT EXISTS estimate_id INTEGER/);
  });
});

describe("Phase 3 — SAFETY: drip is inert by default", () => {
  it("sequence is seeded INACTIVE (is_active=false)", () => {
    assert.match(migration, /'estimate_followup', 'Estimate Follow-Up', false/,
      "estimate_followup must be seeded with is_active=false");
  });
  it("enrollment requires an ACTIVE estimate_followup sequence", () => {
    assert.match(engine, /sequence_type = 'estimate_followup' AND is_active = true/,
      "enrollForEstimateSent must only enroll when the sequence is active");
  });
  it("the send cron still gates on COMMS_ENABLED (unchanged)", () => {
    assert.match(engine, /COMMS_ENABLED.*!==.*"true"/);
  });
  it("enroll/stop API surface is exported", () => {
    assert.equal(typeof enrollForEstimateSent, "function");
    assert.equal(typeof stopEnrollmentsForEstimate, "function");
    assert.equal(typeof stopEstimateEnrollmentsByPhone, "function");
  });
});

describe("Phase 3 — 8-touch cadence copy", () => {
  it("has 8 steps numbered 1..8", () => {
    assert.equal(ESTIMATE_SEQUENCE_STEPS.length, 8);
    ESTIMATE_SEQUENCE_STEPS.forEach((s, i) => assert.equal(s.step_number, i + 1));
  });
  it("Day-0 is an email then an SMS heads-up", () => {
    assert.equal(ESTIMATE_SEQUENCE_STEPS[0].channel, "email");
    assert.equal(ESTIMATE_SEQUENCE_STEPS[1].channel, "sms");
    assert.equal(ESTIMATE_SEQUENCE_STEPS[0].delay_hours, 0);
  });
  it("channel mix matches the spec (email/sms/email/sms/email/sms/email/email)", () => {
    assert.deepEqual(
      ESTIMATE_SEQUENCE_STEPS.map((s) => s.channel),
      ["email", "sms", "email", "sms", "email", "sms", "email", "email"],
    );
  });
  it("every email step has a subject, every sms step has none", () => {
    for (const s of ESTIMATE_SEQUENCE_STEPS) {
      if (s.channel === "email") assert.ok(s.subject && s.subject.length > 0, `step ${s.step_number} subject`);
      else assert.equal(s.subject, null, `step ${s.step_number} sms has no subject`);
    }
  });
  it("every touch carries the view link + personalization merge fields", () => {
    for (const s of ESTIMATE_SEQUENCE_STEPS) {
      assert.match(s.message_template, /\{\{estimate_link\}\}/, `step ${s.step_number} has link`);
      assert.match(s.message_template, /\{\{first_name\}\}/, `step ${s.step_number} personalized`);
      assert.match(s.message_template, /\{\{property\}\}/, `step ${s.step_number} references property`);
    }
  });
});

describe("Phase 3 — wiring", () => {
  it("send enrolls; accept + decline stop the drip", () => {
    assert.match(route, /enrollForEstimateSent\(/);
    assert.match(route, /stopEnrollmentsForEstimate\(Number\(est\.id\), "accepted"\)/);
    assert.match(route, /stopEnrollmentsForEstimate\(Number\(est\.id\), "declined"\)/);
  });
  it("estimate merge vars resolve property + monthly + link", () => {
    assert.match(engine, /buildEstimateMergeVars/);
    assert.match(engine, /property:/);
    assert.match(engine, /monthly:/);
  });
});
