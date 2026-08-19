// [branch-stamp 2026-08-19] Sal: "there is going to be times where through
// networking or organic calls a lead might come in to Schaumburg, but it might
// have an Oak Lawn ZIP Code ... it is only right that that lead stays in
// Schaumburg."
//
// Oak Lawn and Schaumburg are separate businesses — different owners, different
// bank accounts. Who ANSWERS a customer therefore has to follow who OWNS the
// work. Before this, every comm surface picked its office email, its customer
// phone number and its Twilio sender from `getBranchByZip(zip)`, which only ever
// sees five digits: a Schaumburg-owned lead living at a 60453 address came back
// "oak_lawn" and was answered from the other partner's number and inbox.
//
// The stamp is the COMPANY the record lives in, made explicit by
// `companies.branch_key`. NULL keeps the old zip behavior exactly, so company 1
// is untouched while Schaumburg-zip clients still sit in its books.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "@workspace/db";
import {
  getBranchByZip,
  resolveBranchForCompany,
  clearBranchPinCache,
} from "../lib/branchRouter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const OAK_LAWN_ZIP = "60453";
const SCHAUMBURG_ZIP = "60193";

// Company 4 (Phes Schaumburg) is pinned; company 1 (Phes) is not.
const PINS = [{ id: 4, branch_key: "schaumburg" }];

let realExecute: any;
function stubDb(rows: any[] | Error) {
  (db as any).execute = async () => {
    if (rows instanceof Error) throw rows;
    return { rows };
  };
}

before(() => { realExecute = (db as any).execute; });
after(() => { (db as any).execute = realExecute; });
beforeEach(() => { clearBranchPinCache(); stubDb(PINS); });

describe("a branch-pinned tenant answers as itself, whatever the zip says", () => {
  it("a Schaumburg-owned lead at an OAK LAWN zip still answers from Schaumburg", async () => {
    // The whole point. This is the case that was broken.
    const b = await resolveBranchForCompany(4, OAK_LAWN_ZIP);
    assert.equal(b.branch, "schaumburg");
    assert.equal(b.clientPhoneFormatted, "(847) 538-3729");
    assert.equal(b.officeEmail, "schaumburg@phes.io");
    assert.equal(b.twilioFrom, "+16308844318");
  });

  it("and never leaks Oak Lawn's number, inbox or sender into it", async () => {
    const b = await resolveBranchForCompany(4, OAK_LAWN_ZIP);
    const leaked = [b.officeEmail, b.clientPhone, b.clientPhoneFormatted, b.twilioFrom];
    for (const bad of ["info@phes.io", "773-706-6000", "(773) 706-6000", "+17737869902"]) {
      assert.ok(!leaked.includes(bad), `Oak Lawn's ${bad} must not reach a Schaumburg comm`);
    }
  });

  it("holds with no zip at all — an event-driven send still knows its branch", async () => {
    // comms-sender's default-sender path has a company but never a zip.
    for (const zip of [undefined, null, ""]) {
      assert.equal((await resolveBranchForCompany(4, zip)).branch, "schaumburg");
    }
  });

  it("a Schaumburg zip is of course still Schaumburg", async () => {
    assert.equal((await resolveBranchForCompany(4, SCHAUMBURG_ZIP)).branch, "schaumburg");
  });
});

describe("an unpinned tenant is left exactly as it was", () => {
  it("company 1 still routes by zip, both ways", async () => {
    assert.equal((await resolveBranchForCompany(1, OAK_LAWN_ZIP)).branch, "oak_lawn");
    // Company 1 keeps serving Schaumburg zips until those clients move to co4 —
    // pinning it would silently re-point them, so it stays NULL on purpose.
    assert.equal((await resolveBranchForCompany(1, SCHAUMBURG_ZIP)).branch, "schaumburg");
  });

  it("matches getBranchByZip byte for byte, so nothing about co1 changed", async () => {
    for (const zip of [OAK_LAWN_ZIP, SCHAUMBURG_ZIP, "60007", "99999", ""]) {
      assert.deepEqual(await resolveBranchForCompany(1, zip), getBranchByZip(zip));
    }
  });

  it("a null/unknown company falls back to the zip rather than guessing", async () => {
    assert.deepEqual(await resolveBranchForCompany(null, SCHAUMBURG_ZIP), getBranchByZip(SCHAUMBURG_ZIP));
    assert.deepEqual(await resolveBranchForCompany(undefined, OAK_LAWN_ZIP), getBranchByZip(OAK_LAWN_ZIP));
    assert.deepEqual(await resolveBranchForCompany(999, OAK_LAWN_ZIP), getBranchByZip(OAK_LAWN_ZIP));
  });
});

describe("the pin can't take comms down", () => {
  it("a failed lookup degrades to the zip instead of throwing", async () => {
    // If the column is missing on an older DB, or the DB is briefly unreachable,
    // a reminder must still go out — just routed the old way.
    clearBranchPinCache();
    stubDb(new Error("relation \"companies\" does not exist"));
    assert.equal((await resolveBranchForCompany(4, OAK_LAWN_ZIP)).branch, "oak_lawn");
  });

  it("an unrecognized branch_key is ignored, not trusted", async () => {
    clearBranchPinCache();
    stubDb([{ id: 4, branch_key: "naperville" }]);
    assert.equal((await resolveBranchForCompany(4, OAK_LAWN_ZIP)).branch, "oak_lawn");
  });

  it("pins are memoized — a reminder loop doesn't re-query per job", async () => {
    clearBranchPinCache();
    let calls = 0;
    (db as any).execute = async () => { calls++; return { rows: PINS }; };
    for (let i = 0; i < 25; i++) await resolveBranchForCompany(4, OAK_LAWN_ZIP);
    assert.equal(calls, 1);
  });
});

describe("every comm surface asks the stamp, not the zip", () => {
  const files: Record<string, string> = {
    "services/notificationService.ts": read("../services/notificationService.ts"),
    "services/followUpService.ts": read("../services/followUpService.ts"),
    "services/testSendService.ts": read("../services/testSendService.ts"),
    "lib/comms-sender.ts": read("../lib/comms-sender.ts"),
    "routes/public.ts": read("../routes/public.ts"),
    "routes/quotes.ts": read("../routes/quotes.ts"),
  };

  it("no comm surface calls getBranchByZip directly any more", () => {
    // getBranchByZip stays exported — resolveBranchForCompany and
    // resolveBranchByZip both still use it — but a surface that knows its
    // company must never reach past the stamp to the zip.
    for (const [name, src] of Object.entries(files)) {
      const live = src
        .split("\n")
        .filter(l => !/^\s*(\/\/|\*)/.test(l) && !/^import /.test(l))
        .join("\n");
      assert.ok(
        !/getBranchByZip\(/.test(live),
        `${name} still resolves a branch from the zip`,
      );
    }
  });

  it("each one passes the company it already has in hand", () => {
    assert.match(files["services/notificationService.ts"], /resolveBranchForCompany\(job\.company_id, jobZip\)/);
    assert.match(files["services/followUpService.ts"], /resolveBranchForCompany\(enr\.company_id, zip\)/);
    assert.match(files["services/followUpService.ts"], /resolveBranchForCompany\(companyId, zip\)/);
    assert.match(files["lib/comms-sender.ts"], /resolveBranchForCompany\(companyId\)/);
    assert.match(files["routes/public.ts"], /resolveBranchForCompany\(\s*Number\(company_id\)/);
    assert.match(files["routes/quotes.ts"], /resolveBranchForCompany\(req\.auth!\.companyId, clientZip\)/);
  });

  it("both reminder loops were converted, not just the first", () => {
    // notificationService carries two near-identical loops; fixing one and
    // leaving the other is exactly how the mobile card-capture gate survived.
    const hits = files["services/notificationService.ts"].match(/await resolveBranchForCompany\(/g) || [];
    assert.equal(hits.length, 2);
  });

  it("the office quote tags the branch it was written in, not the client's zip", () => {
    // Sal: doing the quote from the office is the ONE place any zip is allowed.
    const q = files["routes/quotes.ts"];
    assert.ok(!/getBranchByZip\(cl\.zip\)/.test(q), "the zip must not decide an office quote's branch");
    assert.match(q, /quoteBranch = \(await resolveBranchForCompany\(req\.auth!\.companyId, clientZip\)\)\.branch/);
  });
});

describe("the pin column ships before anything reads it", () => {
  const migration = read("../phes-data-migration.ts");

  it("branch_key is added on cold start, idempotently", () => {
    assert.match(migration, /ADD COLUMN IF NOT EXISTS branch_key TEXT/);
  });

  it("the Schaumburg tenant is seeded off its merchant, not its name", () => {
    // Keying on square_account_key means the branch a tenant SPEAKS as can never
    // disagree with the merchant it BANKS into.
    const seed = migration.slice(migration.indexOf("seed branch_key for the Schaumburg tenant"));
    assert.match(seed.slice(0, 400), /UPPER\(TRIM\(COALESCE\(square_account_key,''\)\)\) = 'SCHAUMBURG'/);
  });

  it("the seed never overwrites a pin set in the app", () => {
    const seed = migration.slice(migration.indexOf("seed branch_key for the Schaumburg tenant"));
    assert.match(seed.slice(0, 400), /WHERE branch_key IS NULL/);
  });

  it("company 1 is deliberately left unpinned", () => {
    // Pinning co1 would re-point the Schaumburg-zip clients still in its books.
    assert.ok(
      !/SET branch_key = 'oak_lawn'/.test(migration),
      "co1 must stay zip-routed until its Schaumburg-zip clients move to co4",
    );
  });
});
