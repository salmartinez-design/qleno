// [service-suspension 2026-07-11] Unit tests for the suspension customer
// messages: catalog wiring, merge-tag resolution (no leftover {{tags}}), the
// preference-grid exclusion, the non-offset anchors, and the hold-date
// formatters. Pure — runs without a live DB (stub DATABASE_URL).
//
//   DATABASE_URL=postgres://stub@stub/stub tsx --test src/tests/service-suspension-messages.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CUSTOMER_MESSAGE_CATALOG,
  MERGE_TAGS,
  OFFSET_ANCHORS,
  applyMergeTags,
} from "../lib/customer-messages.js";
import { PREFERENCE_TRIGGERS } from "../lib/notification-preferences.js";
import { fmtHoldDateLong, fmtHoldDateShort } from "../lib/suspension.js";

const SUSPENSION_TRIGGERS = [
  "service_suspended",
  "suspension_resume_reminder",
  "suspension_expired",
];

// A superset of every merge tag the suspension templates reference, so a fully
// filled render should leave NO unresolved {{tags}}.
const VARS: Record<string, string> = {
  first_name: "Maria",
  company_name: "Phes",
  company_phone: "(773) 706-6000",
  company_email: "info@phes.io",
  service_summary: "Bi-weekly Standard Clean",
  service_price: "$180 per visit",
  start_date: "Monday, July 14, 2026",
  end_date: "Monday, October 12, 2026",
};

describe("suspension catalog entries", () => {
  for (const trigger of SUSPENSION_TRIGGERS) {
    const def = CUSTOMER_MESSAGE_CATALOG.find((m) => m.trigger === trigger);

    it(`${trigger} exists with email + sms channels`, () => {
      assert.ok(def, `catalog is missing ${trigger}`);
      const channels = def!.channels.map((c) => c.channel).sort();
      assert.deepEqual(channels, ["email", "sms"], `${trigger} should have both channels`);
    });

    it(`${trigger} email has a subject and non-empty body`, () => {
      const email = def!.channels.find((c) => c.channel === "email")!;
      assert.ok(email.subject && email.subject.trim().length > 0, "email needs a subject");
      assert.ok(email.body && email.body.trim().length > 0, "email needs a body");
    });

    it(`${trigger} renders with every tag resolved (no leftover {{}} / undefined)`, () => {
      for (const ch of def!.channels) {
        const rendered = applyMergeTags(ch.body, VARS) + applyMergeTags(ch.subject ?? "", VARS);
        assert.ok(!/\{\{/.test(rendered), `${trigger}:${ch.channel} left an unresolved {{tag}}`);
        assert.ok(!/undefined/.test(rendered), `${trigger}:${ch.channel} rendered "undefined"`);
      }
    });

    it(`${trigger} is a lifecycle anchor the offset cron ignores`, () => {
      assert.ok(
        !OFFSET_ANCHORS.includes(def!.anchor),
        `${trigger} anchor ${def!.anchor} must NOT be an offset anchor`,
      );
    });

    it(`${trigger} is excluded from the per-client preference grid`, () => {
      assert.equal(def!.excludeFromPrefs, true, `${trigger} must set excludeFromPrefs`);
      assert.ok(
        !PREFERENCE_TRIGGERS.includes(trigger),
        `${trigger} must not appear in PREFERENCE_TRIGGERS`,
      );
    });
  }
});

describe("suspension merge tags", () => {
  it("MERGE_TAGS advertises the suspension tags", () => {
    for (const tag of ["service_summary", "service_price", "start_date", "end_date"]) {
      assert.ok((MERGE_TAGS as readonly string[]).includes(tag), `MERGE_TAGS missing ${tag}`);
    }
  });
});

describe("hold-date formatters", () => {
  it("long form is weekday, month day, year", () => {
    assert.equal(fmtHoldDateLong("2026-10-12"), "Monday, October 12, 2026");
  });
  it("short form is abbreviated month day, year", () => {
    assert.equal(fmtHoldDateShort("2026-10-12"), "Oct 12, 2026");
  });
  it("date-only values do not shift across the day boundary", () => {
    // Anchored at local noon, so July 14 stays July 14 regardless of TZ.
    assert.match(fmtHoldDateLong("2026-07-14"), /July 14, 2026$/);
    assert.match(fmtHoldDateShort("2026-07-14"), /Jul 14, 2026$/);
  });
  it("passes a non-date string through unchanged", () => {
    assert.equal(fmtHoldDateShort("not-a-date"), "not-a-date");
  });
});
