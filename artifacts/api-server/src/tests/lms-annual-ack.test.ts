/**
 * Annual re-acknowledgment helpers — unit tests (Phase 14, PR #15).
 *
 * Covers the pure helpers in `lib/lms-annual-ack.ts`. The DB-touching
 * route handlers are exercised via integration testing on a live
 * Postgres; that path is gated by Express + JWT + Supabase RLS and
 * intentionally not mocked here (same pattern as lms-handbook.test.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ANNUAL_DOCUMENT_TYPE_SET,
  TRIGGER_REASONS,
  defaultCycleDeadline,
  isValidCycleYear,
  isValidLocale,
  isValidTriggerReason,
  parseDeadlineInput,
  summarizePendingReAcks,
  validateRequiredDocuments,
} from "../lib/lms-annual-ack.js";
import { ANNUAL_DOCUMENT_TYPES } from "@workspace/db/schema";

describe("defaultCycleDeadline", () => {
  it("returns Dec 31 23:59:59.999 UTC for the cycle year", () => {
    const d = defaultCycleDeadline(2026);
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(), 11);
    assert.equal(d.getUTCDate(), 31);
    assert.equal(d.getUTCHours(), 23);
    assert.equal(d.getUTCMinutes(), 59);
    assert.equal(d.getUTCSeconds(), 59);
    assert.equal(d.getUTCMilliseconds(), 999);
  });

  it("crosses year correctly (returns 2027-12-31, not 2028-01-01)", () => {
    const d = defaultCycleDeadline(2027);
    assert.equal(d.getUTCFullYear(), 2027);
    assert.equal(d.toISOString().slice(0, 10), "2027-12-31");
  });
});

describe("isValidCycleYear", () => {
  it("accepts integers in [2025, 2100]", () => {
    assert.equal(isValidCycleYear(2025), true);
    assert.equal(isValidCycleYear(2026), true);
    assert.equal(isValidCycleYear(2100), true);
  });
  it("rejects out-of-range values", () => {
    assert.equal(isValidCycleYear(2024), false);
    assert.equal(isValidCycleYear(2101), false);
  });
  it("rejects non-integers", () => {
    assert.equal(isValidCycleYear(2026.5), false);
    assert.equal(isValidCycleYear("2026"), false);
    assert.equal(isValidCycleYear(null), false);
    assert.equal(isValidCycleYear(undefined), false);
  });
});

describe("isValidTriggerReason", () => {
  it("accepts every TRIGGER_REASONS member", () => {
    for (const r of TRIGGER_REASONS) {
      assert.equal(isValidTriggerReason(r), true);
    }
  });
  it("rejects unknown reasons", () => {
    assert.equal(isValidTriggerReason("rebrand"), false);
    assert.equal(isValidTriggerReason(""), false);
    assert.equal(isValidTriggerReason(null), false);
  });
});

describe("isValidLocale", () => {
  it("accepts en/es", () => {
    assert.equal(isValidLocale("en"), true);
    assert.equal(isValidLocale("es"), true);
  });
  it("rejects everything else", () => {
    assert.equal(isValidLocale("EN"), false);
    assert.equal(isValidLocale("fr"), false);
    assert.equal(isValidLocale(null), false);
  });
});

describe("parseDeadlineInput", () => {
  it("parses a valid ISO timestamp", () => {
    const d = parseDeadlineInput("2026-12-31T23:59:59Z");
    assert.ok(d instanceof Date);
    assert.equal(d!.toISOString(), "2026-12-31T23:59:59.000Z");
  });
  it("returns null for invalid strings", () => {
    assert.equal(parseDeadlineInput("not a date"), null);
    assert.equal(parseDeadlineInput(""), null);
  });
  it("returns null for non-strings", () => {
    assert.equal(parseDeadlineInput(123), null);
    assert.equal(parseDeadlineInput(null), null);
    assert.equal(parseDeadlineInput(undefined), null);
  });
});

describe("validateRequiredDocuments", () => {
  it("defaults to ANNUAL_DOCUMENT_TYPES when input is undefined", () => {
    const v = validateRequiredDocuments(undefined);
    assert.equal(v.ok, true);
    assert.deepEqual(v.documents, [...ANNUAL_DOCUMENT_TYPES]);
  });

  it("defaults to ANNUAL_DOCUMENT_TYPES when input is an empty array", () => {
    const v = validateRequiredDocuments([]);
    assert.equal(v.ok, true);
    assert.deepEqual(v.documents, [...ANNUAL_DOCUMENT_TYPES]);
  });

  it("accepts the canonical list", () => {
    const v = validateRequiredDocuments(["handbook"]);
    assert.equal(v.ok, true);
    assert.deepEqual(v.documents, ["handbook"]);
  });

  it("rejects unknown document types via `invalid`", () => {
    const v = validateRequiredDocuments(["handbook", "definitely_made_up"]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.invalid, ["definitely_made_up"]);
  });

  it("rejects known-but-non-annual docs via `notAnnual`", () => {
    const v = validateRequiredDocuments(["handbook", "supply_kit"]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.notAnnual, ["supply_kit"]);
  });

  it("dedupes input", () => {
    const v = validateRequiredDocuments(["handbook", "handbook"]);
    assert.equal(v.ok, true);
    assert.deepEqual(v.documents, ["handbook"]);
  });

  it("rejects non-array input", () => {
    const v = validateRequiredDocuments("handbook");
    assert.equal(v.ok, false);
  });

  it("rejects non-string entries", () => {
    const v = validateRequiredDocuments([42]);
    assert.equal(v.ok, false);
  });
});

describe("ANNUAL_DOCUMENT_TYPE_SET", () => {
  it("includes handbook", () => {
    assert.equal(ANNUAL_DOCUMENT_TYPE_SET.has("handbook"), true);
  });

  it("does NOT include one-time docs", () => {
    assert.equal(ANNUAL_DOCUMENT_TYPE_SET.has("non_solicitation"), false);
    assert.equal(ANNUAL_DOCUMENT_TYPE_SET.has("supply_kit"), false);
    assert.equal(ANNUAL_DOCUMENT_TYPE_SET.has("video_photo_release"), false);
  });
});

describe("summarizePendingReAcks", () => {
  const now = new Date("2026-05-13T12:00:00Z");
  const past = new Date("2026-04-01T00:00:00Z").toISOString();
  const future = new Date("2026-12-31T00:00:00Z").toISOString();
  const beforeNow = new Date("2026-05-01T00:00:00Z").toISOString();

  it("returns all-zero counts for an empty array", () => {
    const s = summarizePendingReAcks([], now);
    assert.deepEqual(s, { total: 0, acknowledged: 0, pending: 0, deferred: 0 });
  });

  it("counts acknowledged rows separately", () => {
    const s = summarizePendingReAcks(
      [
        { acknowledged_at: now, defer_until: null, triggered_at: past },
        { acknowledged_at: null, defer_until: null, triggered_at: past },
      ],
      now,
    );
    assert.equal(s.acknowledged, 1);
    assert.equal(s.pending, 1);
    assert.equal(s.deferred, 0);
    assert.equal(s.total, 2);
  });

  it("counts a future defer_until as deferred (not pending)", () => {
    const s = summarizePendingReAcks(
      [
        {
          acknowledged_at: null,
          defer_until: future,
          triggered_at: past,
        },
      ],
      now,
    );
    assert.equal(s.deferred, 1);
    assert.equal(s.pending, 0);
  });

  it("counts a past defer_until as pending (deferral has expired)", () => {
    const s = summarizePendingReAcks(
      [
        {
          acknowledged_at: null,
          defer_until: beforeNow,
          triggered_at: past,
        },
      ],
      now,
    );
    assert.equal(s.pending, 1);
    assert.equal(s.deferred, 0);
  });

  it("acknowledged beats deferred (acknowledged wins regardless of defer_until)", () => {
    const s = summarizePendingReAcks(
      [
        {
          acknowledged_at: now,
          defer_until: future,
          triggered_at: past,
        },
      ],
      now,
    );
    assert.equal(s.acknowledged, 1);
    assert.equal(s.deferred, 0);
    assert.equal(s.pending, 0);
  });
});

describe("TRIGGER_REASONS", () => {
  it("includes the four expected reasons", () => {
    const set = new Set<string>(TRIGGER_REASONS);
    assert.ok(set.has("annual_cycle"));
    assert.ok(set.has("material_content_change"));
    assert.ok(set.has("admin_force_resign"));
    assert.ok(set.has("policy_correction"));
    assert.equal(set.size, 4);
  });
});
