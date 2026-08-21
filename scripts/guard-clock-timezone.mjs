#!/usr/bin/env node
/**
 * [server clock-timezone guard]
 *
 * On 2026-08-21 Guadalupe tapped "On My Way" at 8:32 AM for a 9:00 AM job.
 * Denise Gonzalez's phone buzzed with:
 *
 *   "Guadalupe from Phes is on the way and will arrive around 1:40 PM."
 *
 * The cleaner was eight minutes out. The ETA was right, the instant stored in
 * promised_arrival_at was right, the send was right. The only thing wrong was
 * the LABEL:
 *
 *   promisedArrivalAt.toLocaleTimeString("en-US", { hour: "numeric", ... })
 *
 * With no `timeZone`, that renders in the PROCESS's zone. Railway runs the
 * container in UTC. 8:40 AM Central is 13:40 UTC, so it printed 1:40 PM and
 * told a customer her cleaner was five hours out.
 *
 * It passes tsc. It bundles. It renders perfectly on a developer's Mac,
 * because a Mac in Chicago IS in Central — the bug only appears in production.
 * Nothing else in this pipeline can see it, so it gets its own gate.
 *
 * WHAT IS SAFE, and why this guard is narrow:
 *
 *   date only     new Date(y, m-1, d).toLocaleDateString(...)     fine
 *                 A local-midnight Date formatted in UTC is still the same
 *                 calendar day. Most of the codebase is this, and flagging it
 *                 would bury the real hits in noise.
 *
 *   clock time    someInstant.toLocaleTimeString("en-US", { hour: ... })
 *                 Shifts by the whole UTC offset. This is what we block.
 *
 * So the rule is exactly: if the options object asks for an hour (`hour:` or
 * `timeStyle:`), it must also name a `timeZone`.
 *
 * THE FIX — tzOf() from artifacts/api-server/src/lib/company-tz.ts, which
 * resolves the tenant's own zone and falls back to Central:
 *
 *     at.toLocaleTimeString("en-US", {
 *       timeZone: tzOf(companyId),
 *       hour: "numeric",
 *       minute: "2-digit",
 *     })
 *
 * If the value is genuinely meant to be UTC (a log line, a webhook payload),
 * say so explicitly with `timeZone: "UTC"` — that satisfies the guard and
 * documents the intent for the next reader.
 *
 * SERVER CODE ONLY. In the browser the process zone IS the viewer's zone, so a
 * bare call there is correct on purpose.
 *
 * Run locally:  node scripts/guard-clock-timezone.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
/** Everything that runs in the Railway container. Not the frontend. */
const ROOTS = ["artifacts/api-server/src", "lib", "packages"];
const SKIP = new Set(["node_modules", "dist", "build", ".git", "coverage", "tests"]);
const EXT = /\.(ts|mts|cts)$/;

/** Both ways to format a date in JS. */
const FORMATTER = /toLocale(?:Time|Date)?String\s*\(|new Intl\.DateTimeFormat\s*\(/g;
/** Both ways to ask for a clock time. */
const PRINTS_CLOCK_TIME = /\b(hour|timeStyle)\s*:/;

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (EXT.test(name) && !name.endsWith(".d.ts") && !name.includes(".test.")) out.push(full);
  }
  return out;
}

/**
 * Walk from the opening paren to its match. A regex cannot do this — the
 * options object spans lines and nests braces, and the argument we care about
 * is the LAST one, so we need the whole call.
 */
function callBody(src, from) {
  let depth = 1, j = from;
  while (j < src.length && depth > 0) {
    const ch = src[j];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    j++;
  }
  return src.slice(from, j);
}

const findings = [];
for (const root of ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(FORMATTER)) {
      const call = callBody(src, m.index + m[0].length);
      if (!PRINTS_CLOCK_TIME.test(call)) continue;   // date-only — safe
      if (call.includes("timeZone")) continue;       // zone named — safe
      const line = src.slice(0, m.index).split("\n").length;
      findings.push({
        file: relative(ROOT, file),
        line,
        text: call.replace(/\s+/g, " ").slice(0, 100).trim(),
      });
    }
  }
}

if (findings.length === 0) {
  console.log("every server-side clock time names its timezone — proceeding");
  process.exit(0);
}

console.log("::error::A server-side clock time is formatted without a timeZone.");
console.log("");
console.log(`Found ${findings.length} occurrence(s):`);
console.log("");
for (const f of findings) console.log(`  ${f.file}:${f.line}\n      ...(${f.text}`);
console.log("");
console.log("Railway runs the container in UTC, so this prints five hours ahead");
console.log("of Central. It looks correct on a Mac in Chicago and wrong to every");
console.log("customer. Pass the tenant's zone:");
console.log("");
console.log('    import { tzOf } from "../lib/company-tz.js";');
console.log("");
console.log('    at.toLocaleTimeString("en-US", {');
console.log("      timeZone: tzOf(companyId),");
console.log('      hour: "numeric",');
console.log('      minute: "2-digit",');
console.log("    })");
console.log("");
console.log('If UTC really is intended, write timeZone: "UTC" explicitly.');
process.exit(1);
