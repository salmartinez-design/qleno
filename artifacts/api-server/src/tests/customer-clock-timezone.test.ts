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
