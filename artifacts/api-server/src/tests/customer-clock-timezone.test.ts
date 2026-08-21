/**
 * [omw-eta-tz 2026-08-21] Francisco, on the job card for Denise Gonzalez:
 * "worst part". Maribel: "lol what? I think something is wrong with Qleno".
 *
 * Guadalupe tapped On My Way at 8:32 AM for a 9:00 AM job. The customer's
 * phone buzzed with "Guadalupe from Phes is on the way and will arrive around
 * 1:40 PM." Nothing was wrong with the ETA itself - promised_arrival_at was
 * stored as the correct instant, 8:40 AM Central. What was wrong was the
 * LABEL: toLocaleTimeString() with no timeZone renders in the process's zone,
 * and Railway runs the container in UTC. 8:40 Central is 13:40 UTC, so the
 * text said 1:40 PM.
 *
 * That is a whole class of bug, not one line. Every date-only formatter in the
 * codebase is safe (a local-midnight Date formatted in UTC is still the same
 * calendar day), but every formatter that prints a CLOCK TIME off a real
 * instant shifts by the UTC offset. Three were doing it: the on-my-way ETA,
 * the e-signature Certificate of Completion, and the signed handbook
 * acknowledgment.
 *
 * So this file has two jobs:
 *   1. pin the exact regression with the real production instant, and
 *   2. sweep the whole server for the pattern, so the next one fails CI
 *      instead of a customer's phone.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..");
const CT = "America/Chicago";

/** The real event: on_my_way_events #74, job 20630, 2026-08-21. */
const PROMISED = new Date("2026-08-21T13:40:00Z");

describe("the on-my-way ETA label", () => {
  it("reads 8:40 AM in the tenant's zone, not 1:40 PM in the server's", () => {
    const label = PROMISED.toLocaleTimeString("en-US", {
      timeZone: CT, hour: "numeric", minute: "2-digit",
    });
    assert.equal(label, "8:40 AM");
  });

  it("is the exact string the customer was sent when the zone was missing", () => {
    // Not a hypothetical. This is what a UTC container produced, and it is
    // why the assertion above has to name a zone explicitly rather than
    // trusting whatever clock the test runner happens to sit in.
    const wrong = PROMISED.toLocaleTimeString("en-US", {
      timeZone: "UTC", hour: "numeric", minute: "2-digit",
    });
    assert.equal(wrong, "1:40 PM");
  });

  it("still sends the ETA ahead of the 9:00 AM start", () => {
    // The point of the text is reassurance. If the label ever lands after the
    // scheduled start, the message is doing the opposite of its job.
    const start = new Date("2026-08-21T14:00:00Z"); // 9:00 AM CT
    assert.ok(PROMISED.getTime() < start.getTime());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The sweep. Any formatter that prints a clock time must name its zone.
// ─────────────────────────────────────────────────────────────────────────────

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "tests" || name === "node_modules" || name === "dist") continue;
      out.push(...tsFiles(p));
    } else if (name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

/** Walk from the opening paren to its match so we see the whole options object. */
function callAt(src: string, from: number): string {
  let depth = 1, j = from;
  while (j < src.length && depth > 0) {
    const ch = src[j];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    j++;
  }
  return src.slice(from, j);
}

const FORMATTER = /toLocale(?:Time|Date)?String\s*\(|new Intl\.DateTimeFormat\s*\(/g;
/** `hour:` and `timeStyle:` are the two ways to ask for a clock time. */
const PRINTS_CLOCK_TIME = /\b(hour|timeStyle)\s*:/;
/**
 * [instant-date-tz 2026-08-21] The second class, found by re-reading the first
 * fix's own premise. "Date-only is safe" is true for a CONSTRUCTED date -
 * new Date(y, m-1, d) is local midnight and formats to the same calendar day
 * anywhere. It is false for a real instant. 7 PM Central is already tomorrow
 * in UTC, so a UTC container printed the NEXT day's date on documents people
 * keep: twenty-one signed employee handbooks and six payment receipts carried
 * the wrong day before this rule existed.
 *
 * A "known instant" is deliberately narrow, so this stays quiet: a bare
 * `new Date()`, or a value whose name ends in `At` / `_at` - sentAt, signedAt,
 * created_at. Those are unambiguous. Everything else is left alone.
 */
const KNOWN_INSTANT = /(?:new Date\(\s*\)|[A-Za-z_$][\w$]*(?:_at|At))\s*\)?\s*\.\s*$/;

describe("every server-side clock time names its timezone", () => {
  it("finds no formatter that prints an hour without a timeZone", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(FORMATTER)) {
        const call = callAt(src, m.index! + m[0].length);
        if (!PRINTS_CLOCK_TIME.test(call)) continue;      // date-only is safe
        if (call.includes("timeZone")) continue;          // zone named, fine
        const line = src.slice(0, m.index!).split("\n").length;
        offenders.push(`${path.relative(SRC, file)}:${line}`);
      }
    }
    assert.deepEqual(
      offenders, [],
      "These print a clock time in the server's zone, which on Railway is UTC. " +
      "Pass timeZone: tzOf(companyId) (or the tenant zone you already have). " +
      "Offenders:\n  " + offenders.join("\n  "),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The three that were broken, pinned by name so a revert is loud.
// ─────────────────────────────────────────────────────────────────────────────

const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

describe("the three fixed call sites stay fixed", () => {
  it("the on-my-way SMS formats in the tenant's zone", () => {
    const src = read("routes/tech-clock.ts");
    const i = src.indexOf("const promisedLabel");
    assert.ok(i > 0, "promisedLabel should still be where the ETA is worded");
    assert.match(src.slice(i, i + 400), /timeZone:\s*tzOf\(companyId\)/);
  });

  it("the e-signature certificate takes a zone from its caller", () => {
    assert.match(read("lib/agreement-certificate.ts"), /const fmt = \(iso: string, timeZone/);
    assert.match(read("routes/sign.ts"), /timeZone:\s*tzOf\(s\.company_id/);
  });

  it("the signed handbook acknowledgment takes a zone from its caller", () => {
    assert.match(read("lib/lms-handbook-pdf.ts"), /timeZone:\s*input\.timeZone/);
    assert.match(read("routes/lms-handbook.ts"), /timeZone:\s*tzOf\(companyId\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Class two: a DATE printed off a real instant.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The real row: lms_signed_documents #… signed at 9:12 PM Central on
 * 2026-08-19. Eight handbooks were signed that evening; every one of them
 * printed 2026-08-20 as its version date.
 */
const SIGNED_EVENING = new Date("2026-08-20T02:12:00Z");

describe("a date printed off a real instant", () => {
  it("reads the Central day the person actually signed", () => {
    const label = SIGNED_EVENING.toLocaleDateString("en-US", {
      timeZone: CT, year: "numeric", month: "long", day: "numeric",
    });
    assert.equal(label, "August 19, 2026");
  });

  it("is the wrong day when the zone is missing on a UTC container", () => {
    // Same instant, no tenant zone. This is what the signed PDFs carried.
    const wrong = SIGNED_EVENING.toLocaleDateString("en-US", {
      timeZone: "UTC", year: "numeric", month: "long", day: "numeric",
    });
    assert.equal(wrong, "August 20, 2026");
  });

  it("leaves a CONSTRUCTED date alone - that one really is safe", () => {
    // new Date(y, m-1, d) is local midnight. Formatted in UTC it is still the
    // same calendar day, which is why the sweep below does not flag it.
    const built = new Date(2026, 7, 19);
    assert.equal(
      built.toLocaleDateString("en-US", { timeZone: CT, month: "long", day: "numeric", year: "numeric" }),
      "August 19, 2026",
    );
  });
});

describe("every server-side date off an instant names its timezone", () => {
  it("finds no formatter that dates a real instant without a timeZone", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(FORMATTER)) {
        const call = callAt(src, m.index! + m[0].length);
        if (call.includes("timeZone")) continue;          // zone named, fine
        const before = src.slice(Math.max(0, m.index! - 160), m.index!);
        if (!KNOWN_INSTANT.test(before)) continue;        // constructed date, safe
        const line = src.slice(0, m.index!).split("\n").length;
        offenders.push(`${path.relative(SRC, file)}:${line}`);
      }
    }
    assert.deepEqual(
      offenders, [],
      "These date a real instant in the server's zone, which on Railway is UTC, " +
      "so anything after 7 PM Central prints tomorrow. Pass timeZone: tzOf(companyId). " +
      "Offenders:\n  " + offenders.join("\n  "),
    );
  });
});

describe("the date stamps people keep stay fixed", () => {
  it("the payment receipt dates in the tenant's zone", () => {
    assert.match(read("routes/payments.ts"), /payment_date:\s*new Date\(\)\.toLocaleDateString\("en-US", \{ timeZone: tzOf\(companyId\)/);
  });

  it("the booking-confirmation copy carries a zone from its gatherer", () => {
    const src = read("lib/confirmation-pdf.ts");
    assert.match(src, /timeZone:\s*tzOf\(companyId\)/);
    assert.equal((src.match(/timeZone: data\.timeZone \|\| "America\/Chicago"/g) || []).length, 2);
  });

  it("the job-completion PDF footer carries a zone from its caller", () => {
    assert.match(read("lib/generate-job-pdf.ts"), /timeZone: data\.timeZone \|\| "America\/Chicago"/);
    assert.match(read("routes/jobs.ts"), /timeZone:\s*tzOf\(req\.auth!\.companyId\),/);
  });

  it("the signed handbook version date and ack list use the tenant zone", () => {
    const src = read("lib/lms-handbook-pdf.ts");
    // version date, ack list, signature stamp - all three now.
    assert.equal((src.match(/timeZone: input\.timeZone \|\| "America\/Chicago"/g) || []).length, 3);
  });

  it("the employee document {{date}} tag uses the tenant zone", () => {
    assert.match(read("routes/document-requests.ts"), /toLocaleDateString\("en-US", \{ timeZone: tzOf\(first\.company_id\) \}\)/);
  });

  it("the sales bonus month label uses the tenant zone", () => {
    assert.match(read("lib/sales-commission.ts"), /timeZone: tzOf\(opts\.companyId\), month: "long", year: "numeric"/);
  });
});
