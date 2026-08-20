// [sms-merge-tag-blanks 2026-08-19] The Schaumburg "on my way" text was going out
// with holes in it:
//   "Hi Jane,  from Phes is on the way - arriving during your  window. Questions? ."
//
// Nothing was broken about the DATA. The template body was written against
// technician_name / appointment_window / company_phone, while the live sender
// (routes/tech-clock.ts, the field app's On My Way button) passes tech_name and
// arrival_window and no phone at all. applyMergeTags resolves an unknown tag to
// "" without complaining, so the send looked successful every time.
//
// It survived because Send Test LIES: testSendService supplies its own rich
// sample vars, so the office previews a perfect message and ships a broken one.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "@workspace/db";
import { renderCustomerTemplate } from "../lib/customer-messages.js";

// The real body on company 4 at the time of the fix.
const SCHAUMBURG_OMW =
  "Hi {{first_name}}, {{technician_name}} from Phes is on the way - arriving " +
  "during your {{appointment_window}} window. Questions? {{company_phone}}.";

// Exactly what routes/tech-clock.ts passes — no aliases, no phone.
const TECH_CLOCK_VARS = {
  first_name: "Jane",
  client_name: "Jane",
  company_name: "Phes Schaumburg",
  tech_name: "Maria",
  arrival_window: "8:00 AM - 10:00 AM",
  service_address: "123 Oak St, Schaumburg, IL 60193",
};

const COMPANY_ROW = { name: "Phes Schaumburg", phone: "(847) 538-3729", email: "schaumburg@phes.io" };

let realExecute: any;
let queue: any[][];
let calls: number;

function stub(...responses: any[][]) {
  queue = responses;
  calls = 0;
  (db as any).execute = async () => {
    calls++;
    return { rows: queue.shift() ?? [] };
  };
}

const tplRow = (body: string, is_active = true) => [
  { subject: null, body, body_html: null, body_text: body, is_active },
];

before(() => { realExecute = (db as any).execute; });
after(() => { (db as any).execute = realExecute; });
beforeEach(() => { calls = 0; });

describe("an SMS template never renders a tag as a blank hole", () => {
  it("the exact Schaumburg on-my-way body comes out whole", async () => {
    stub(tplRow(SCHAUMBURG_OMW), [COMPANY_ROW]);
    const r = await renderCustomerTemplate(4, "on_my_way", "sms", { ...TECH_CLOCK_VARS });
    assert.equal(
      r!.body,
      "Hi Jane, Maria from Phes is on the way - arriving during your " +
        "8:00 AM - 10:00 AM window. Questions? (847) 538-3729.",
    );
  });

  it("no leftover empty slots anywhere in the rendered text", async () => {
    stub(tplRow(SCHAUMBURG_OMW), [COMPANY_ROW]);
    const r = await renderCustomerTemplate(4, "on_my_way", "sms", { ...TECH_CLOCK_VARS });
    // The three symptoms of the bug, stated as they appeared to the customer.
    assert.ok(!/\s{2,}/.test(r!.body), "double space = a tag rendered to nothing");
    assert.ok(!/\byour\s+window\b/.test(r!.body), "the arrival window went missing");
    assert.ok(!/\?\s*\.$/.test(r!.body), "the phone number went missing");
    assert.ok(!r!.body.includes("{{"), "an unresolved tag reached the customer");
  });

  it("job_started's tech_first_names resolves too", async () => {
    // Currently paused on both branches, so this one is armed rather than live —
    // turning the message on must not reintroduce the blank.
    stub(tplRow("Hi {{first_name}}, {{tech_first_names}} just checked in."));
    const r = await renderCustomerTemplate(1, "job_started", "sms", {
      first_name: "Jane", tech_name: "Maria",
    });
    assert.equal(r!.body, "Hi Jane, Maria just checked in.");
  });
});

describe("filling a blank never overwrites a real value", () => {
  it("the caller's own tech_name wins over an alias", async () => {
    stub(tplRow("{{technician_name}} / {{tech_name}}"));
    const r = await renderCustomerTemplate(1, "on_my_way", "sms", {
      tech_name: "Maria", technician_name: "Maria R.",
    });
    assert.equal(r!.body, "Maria R. / Maria");
  });

  it("a caller-supplied phone beats the tenant row", async () => {
    // comms-sender resolves a BRANCH number; the companies row is the fallback.
    stub(tplRow("Call {{company_phone}}"), [COMPANY_ROW]);
    const r = await renderCustomerTemplate(4, "on_my_way", "sms", {
      company_phone: "(630) 884-4318",
    });
    assert.equal(r!.body, "Call (630) 884-4318");
  });

  it("an empty string counts as missing, not as a choice", async () => {
    stub(tplRow("{{technician_name}} is on the way"));
    const r = await renderCustomerTemplate(1, "on_my_way", "sms", {
      tech_name: "Maria", technician_name: "",
    });
    assert.equal(r!.body, "Maria is on the way");
  });
});

describe("the fix costs nothing when it isn't needed", () => {
  it("a body with no company tag does NOT hit the companies table", async () => {
    // The reminder loop renders per job; an extra query per job would be a
    // silent scaling cost for a tag most templates never use.
    stub(tplRow("Hi {{first_name}}, see you {{date}}."));
    await renderCustomerTemplate(1, "reminder_24h", "sms", { first_name: "Jane", date: "Monday" });
    assert.equal(calls, 1, "only the template lookup should have run");
  });

  it("a body that DOES ask for the phone looks it up once", async () => {
    stub(tplRow("Call {{company_phone}}"), [COMPANY_ROW]);
    await renderCustomerTemplate(4, "on_my_way", "sms", {});
    assert.equal(calls, 2);
  });

  it("a paused template still reports is_active=false", async () => {
    // The office's "off" switch must survive the enrichment.
    stub(tplRow("Hi {{first_name}}", false));
    const r = await renderCustomerTemplate(1, "job_started", "sms", { first_name: "Jane" });
    assert.equal(r!.is_active, false);
  });

  it("a missing template row is still null, not an empty message", async () => {
    stub([]);
    assert.equal(await renderCustomerTemplate(1, "nope", "sms", {}), null);
  });
});

describe("the caller's vars object is not mutated", () => {
  it("a reminder loop reusing one vars object doesn't leak between jobs", async () => {
    const vars: Record<string, string> = { first_name: "Jane", tech_name: "Maria" };
    stub(tplRow("{{technician_name}}"));
    await renderCustomerTemplate(1, "on_my_way", "sms", vars);
    assert.deepEqual(vars, { first_name: "Jane", tech_name: "Maria" });
  });
});
