// [message-switches 2026-08-20] The messages that had no working on/off switch.
//
// Four of them were sending with nothing in the settings screen to stop them
// (the reschedule notice, the invoice, the invoice reminder, the payment
// confirmation), and one had a switch on a screen the sender never read (the
// review request text). This file pins the wiring so a later edit cannot quietly
// take a switch back out.
//
// Pure - no live DB. Run with a stub URL:
//   DATABASE_URL=postgres://stub@stub/stub tsx --test src/tests/customer-message-switches.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CUSTOMER_MESSAGE_CATALOG,
  BILLING_MERGE_TAGS,
  TIME_CHANGE_MERGE_TAGS,
  OFFSET_ANCHORS,
  applyMergeTags,
} from "../lib/customer-messages.js";
import { PREFERENCE_TRIGGERS } from "../lib/notification-preferences.js";
import { readFileSync } from "node:fs";

const find = (t: string) => CUSTOMER_MESSAGE_CATALOG.find(m => m.trigger === t);

// Everything the new messages can reference, so a fully-filled render should
// leave no unresolved {{tag}} behind.
const VARS: Record<string, string> = {
  first_name: "Maria",
  client_name: "Maria Gomez",
  company_name: "Phes",
  company_phone: "(773) 706-6000",
  company_email: "info@phes.io",
  service_type: "Standard Cleaning",
  service_address: "123 Oak St, Oak Lawn, IL 60453",
  appointment_date: "Friday, June 27, 2026",
  appointment_time: "9:00 AM",
  date: "Friday, June 27, 2026",
  time: "9:00 AM",
  invoice_number: "1042",
  invoice_amount: "240.00",
  invoice_due_date: "Friday, July 4, 2026",
  invoice_link: "https://app.qleno.com/pay/sample",
  payment_amount: "240.00",
  payment_date: "Friday, June 27, 2026",
};

const NEW_TRIGGERS = ["job_time_updated", "invoice_sent", "invoice_reminder", "payment_received"];

describe("messages that had no switch are now in the catalog", () => {
  for (const trigger of NEW_TRIGGERS) {
    it(`${trigger} is catalogued with at least one channel`, () => {
      const m = find(trigger);
      assert.ok(m, `${trigger} missing from CUSTOMER_MESSAGE_CATALOG`);
      assert.ok(m!.channels.length >= 1);
      assert.ok(m!.label && m!.label.length > 0);
      assert.ok(m!.timing && m!.timing.length > 0);
    });

    it(`${trigger} renders with every tag resolved`, () => {
      for (const ch of find(trigger)!.channels) {
        const body = applyMergeTags(ch.body, VARS);
        assert.ok(!/\{\{/.test(body), `${trigger}/${ch.channel} left a raw tag: ${body}`);
        assert.ok(!/undefined/.test(body), `${trigger}/${ch.channel} rendered undefined`);
        if (ch.subject) {
          const subj = applyMergeTags(ch.subject, VARS);
          assert.ok(!/\{\{/.test(subj), `${trigger} subject left a raw tag: ${subj}`);
        }
      }
    });

    it(`${trigger} fires from its own call site, not the offset cron`, () => {
      // The cron only walks before_appointment / after_appointment. An event
      // message on one of those anchors would double-send.
      assert.ok(!OFFSET_ANCHORS.includes(find(trigger)!.anchor as any));
    });
  }
});

describe("billing messages", () => {
  const BILLING = ["invoice_sent", "invoice_reminder", "payment_received"];

  for (const trigger of BILLING) {
    it(`${trigger} sits in the Billing group`, () => {
      assert.equal(find(trigger)!.group, "billing");
    });

    it(`${trigger} offers billing tags, not booking tags`, () => {
      // A tag the sender never passes renders as an empty string with no
      // warning, so offering {{tech_name}} on an invoice invites a hole in
      // live customer copy.
      assert.deepEqual(find(trigger)!.mergeTags, BILLING_MERGE_TAGS);
    });

    it(`${trigger} stays out of the per-client preference grid`, () => {
      // Its send sites pass no client id, so a per-client toggle would be a
      // control that governs nothing.
      assert.ok(find(trigger)!.excludeFromPrefs);
      assert.ok(!PREFERENCE_TRIGGERS.some((p: any) => p.trigger === trigger));
    });

    it(`${trigger} seeds paused, so cataloguing it starts no new mail`, () => {
      // co2 / co3 have no rows for these and send nothing today. An active seed
      // would start brand-new billing mail on a tenant that never had it.
      for (const ch of find(trigger)!.channels) {
        assert.equal(ch.seedPaused, true, `${trigger}/${ch.channel} would seed ON`);
      }
    });
  }

  it("the invoice reminder is email only, matching what is live", () => {
    assert.deepEqual(find("invoice_reminder")!.channels.map(c => c.channel), ["email"]);
  });
});

describe("appointment time changed", () => {
  it("carries the reschedule tag list, not the billing one", () => {
    assert.deepEqual(find("job_time_updated")!.mergeTags, TIME_CHANGE_MERGE_TAGS);
  });

  it("has both an email and a text", () => {
    assert.deepEqual(
      find("job_time_updated")!.channels.map(c => c.channel).sort(),
      ["email", "sms"],
    );
  });

  it("stays in the per-client preference grid", () => {
    // Unlike billing, this send does know which client it is for, so a customer
    // who asked us to stop texting is honored.
    assert.ok(!find("job_time_updated")!.excludeFromPrefs);
  });
});

describe("review request", () => {
  it("still offers a text channel for the office to switch", () => {
    const m = find("review_request")!;
    assert.ok(m.channels.some(c => c.channel === "sms"));
    assert.ok(m.channels.some(c => c.channel === "email"));
  });
});

// ---------------------------------------------------------------------------
// The four Job Status SMS switches.
//
// Each one has to survive two separate deletions: the row disappearing from the
// settings screen, and the send path quietly stopping to read it. Both have
// happened. "Arrived" governed an event no code ever fired, and "Job Complete"
// governed a column none of the three completion senders read, so switching it
// off changed nothing while the texts kept going out. These read the source
// because that is where the coupling lives - there is no runtime object that
// holds both halves.
// ---------------------------------------------------------------------------
describe("job status sms switches", () => {
  const read = (rel: string) =>
    readFileSync(new URL(rel, import.meta.url), "utf8");

  it("keeps all four switches on the settings screen", () => {
    const src = read("../../../qleno/src/pages/company.tsx");
    const block = src.slice(src.indexOf("const SMS_TOGGLES = ["));
    for (const key of [
      "sms_on_my_way_enabled",
      "sms_arrived_enabled",
      "sms_paused_enabled",
      "sms_complete_enabled",
    ]) {
      assert.ok(block.includes(key), `${key} is missing from the Job Status card`);
    }
  });

  it("gates the completion and arrival texts on their columns", () => {
    const src = read("../services/notificationService.ts");
    const gate = src.slice(src.indexOf("const SMS_COLUMN_GATE"));
    assert.match(gate, /job_completed:\s*"sms_complete_enabled"/);
    assert.match(gate, /job_started:\s*"sms_arrived_enabled"/);
    // Only these two. Every other message is governed by its own template
    // switch, and a column gate on top of that would be a second hidden off.
    const map = gate.slice(gate.indexOf("= {") + 3, gate.indexOf("};"));
    assert.equal(map.split(":").length - 1, 2);
  });

  it("fires the arrived event when the cleaner clocks in", () => {
    const src = read("../../../qleno/src/pages/my-jobs.tsx");
    assert.ok(
      /clockInMutation[\s\S]{0,4000}event: "arrived"/.test(src),
      "clock-in no longer fires the arrived event, so its switch governs nothing",
    );
  });
});
