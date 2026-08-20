// [on-my-way-creds 2026-08-20] Between 2026-06-10 and 2026-08-19 techs tapped
// "On my way" 72 times and not one customer was ever texted. Every gate passed:
// comms on, tenant flag on, client opted in, phone present, template active,
// from-number resolved. The send itself failed, because sendOnMyWaySms
// authenticated to Twilio with process.env.TWILIO_AUTH_TOKEN — a token rotated
// out from under it. Every other sender reads companies.twilio_auth_token, so
// reminders kept flowing and this one failed alone. Twilio answered 20003
// Authenticate to all 72, and the route stored only client_notified=false, so a
// rejected send looked exactly like a customer who had opted out.
//
// Three things are pinned here: send with the tenant's credentials, supply the
// {{company_phone}} the templates ask for, and keep the failure reason.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendOnMyWaySms } from "../lib/comms.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const BASE = {
  toPhone: "(708) 996-5466",
  fromPhone: "+17737869902",
  companyName: "Phes",
  techName: "Maria",
  clientFirstName: "Cynthiia",
  serviceAddress: "1 Main St, Oak Lawn, IL 60453",
  promisedArrivalLabel: "9:35 AM",
  tenantSmsEnabled: true,
  clientOptedIn: true,
};

let realFetch: typeof globalThis.fetch;
let seen: { url: string; auth: string; body: URLSearchParams } | null;

before(() => { realFetch = globalThis.fetch; });
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => {
  seen = null;
  process.env.COMMS_ENABLED = "true";
  process.env.TWILIO_ACCOUNT_SID = "ACenvstale";
  process.env.TWILIO_AUTH_TOKEN = "envstaletoken";
  globalThis.fetch = (async (url: any, init: any) => {
    seen = {
      url: String(url),
      auth: String(init?.headers?.Authorization ?? ""),
      body: new URLSearchParams(String(init?.body ?? "")),
    };
    return { ok: true, json: async () => ({ sid: "SMtest" }) } as any;
  }) as any;
});

const decode = (auth: string) =>
  Buffer.from(auth.replace(/^Basic /, ""), "base64").toString().split(":");

describe("the on-my-way text authenticates as the tenant, not as the environment", () => {
  it("sends with the tenant's own Twilio credentials", async () => {
    const r = await sendOnMyWaySms({
      ...BASE, accountSid: "ACtenant", authToken: "tenanttoken",
    });
    assert.equal(r.status, "sent");
    const [sid, token] = decode(seen!.auth);
    assert.equal(sid, "ACtenant");
    assert.equal(token, "tenanttoken");
    // The stale env token must not be what reaches Twilio — that is the bug.
    assert.notEqual(token, "envstaletoken");
  });

  it("posts to the tenant's account, not the environment's", async () => {
    await sendOnMyWaySms({ ...BASE, accountSid: "ACtenant", authToken: "tenanttoken" });
    assert.ok(seen!.url.includes("/Accounts/ACtenant/"), seen!.url);
  });

  it("still falls back to the environment for a tenant with no credentials", async () => {
    // A tenant that never configured Twilio should behave exactly as before.
    const r = await sendOnMyWaySms({ ...BASE, accountSid: null, authToken: null });
    assert.equal(r.status, "sent");
    assert.deepEqual(decode(seen!.auth), ["ACenvstale", "envstaletoken"]);
  });

  it("reports the reason when Twilio rejects, rather than a bare failure", async () => {
    globalThis.fetch = (async () => ({
      ok: false, status: 401, text: async () => '{"code":20003,"message":"Authenticate"}',
    })) as any;
    const r = await sendOnMyWaySms({ ...BASE, accountSid: "ACtenant", authToken: "bad" });
    assert.equal(r.status, "error");
    assert.match((r as any).message, /401/);
    assert.match((r as any).message, /20003/);
  });
});

describe("the route hands the send everything the message needs", () => {
  const route = read("../routes/tech-clock.ts");

  it("passes the resolved tenant credentials to the sender", () => {
    assert.match(route, /accountSid: sender\.account_sid/);
    assert.match(route, /authToken: sender\.auth_token/);
  });

  it("supplies company_phone, which every on_my_way template asks for", () => {
    // Both tenants' templates end "Questions? Call {{company_phone}}." and
    // applyMergeTags renders an unknown tag as "", so without this the text
    // ships as "Questions? Call ."
    assert.match(route, /company_phone: \(await resolveBranchForCompany\(companyId\)\)\.clientPhoneFormatted/);
  });

  it("takes that number from the branch stamp so Schaumburg quotes its own line", () => {
    assert.ok(
      !/company_phone:\s*tenant\?\.phone/.test(route),
      "the company row would give a Schaumburg customer Oak Lawn's number",
    );
  });

  it("records why a send did not happen", () => {
    assert.match(route, /sms_result: smsResult\?\.status \?\? null/);
    assert.match(route, /sms_error:/);
  });
});

describe("the reason columns ship before anything writes them", () => {
  const migration = read("../phes-data-migration.ts");
  it("both are added on cold start, idempotently", () => {
    assert.match(migration, /on_my_way_events ADD COLUMN IF NOT EXISTS sms_result TEXT/);
    assert.match(migration, /on_my_way_events ADD COLUMN IF NOT EXISTS sms_error TEXT/);
  });
});
