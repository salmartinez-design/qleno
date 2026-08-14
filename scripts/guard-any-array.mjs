#!/usr/bin/env node
/**
 * [ANY(array) trap guard]
 *
 * Drizzle's `sql` template does NOT bind a JS array as one array parameter — it
 * spreads the elements into separate placeholders. So `= ANY(${ids}::int[])`
 * emits:
 *
 *   one element   → ANY(($2)::int[])        malformed array literal: "9099"
 *   two elements  → ANY(($2,$3)::int[])     cannot cast type record to integer[]
 *   zero elements → ANY(()::int[])          syntax error
 *
 * It throws at every length. There is no input for which that pattern works.
 *
 * This has been fixed eighteen times in this repo. Warning comments at each
 * site did not stop it recurring — and the worst instances sat inside a
 * `catch {}` that turned the throw into "no rows found", so every hand-set
 * final_pay override was silently dropped from payroll for weeks with nothing
 * in a log. Comments don't block a merge. This does.
 *
 * THE FIX — inList / inIntList from artifacts/api-server/src/lib/sql-lists.ts:
 *
 *     const list = inIntList(ids);
 *     if (!list) return [];              // caller decides what empty means
 *     sql`WHERE job_id IN (${list})`
 *
 * ALSO ACCEPTED — a pre-built literal fragment, which older code uses:
 *
 *     const zipLit = sql.raw(`ARRAY[${zips.map(z => `'${z}'`).join(",")}]::text[]`);
 *     sql`WHERE zip = ANY(${zipLit})`
 *
 * That form is safe because the array is already a literal by the time it
 * reaches the template. The guard recognises it by checking whether the
 * interpolated identifier is assigned from sql.raw anywhere in the same file —
 * so it does not matter which line the fragment was built on.
 *
 * Run locally:  node scripts/guard-any-array.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ROOTS = ["artifacts", "lib", "packages", "scripts"];
const SKIP = new Set(["node_modules", "dist", "build", ".git", ".next", "coverage"]);
const EXT = /\.(ts|tsx|mts|cts)$/;

/** `= ANY(${ expr })` — capture the interpolated expression. */
const ANY_CALL = /=\s*ANY\(\s*\$\{([^}]*)\}/g;
/** A line that is entirely a comment — the historical fix notes quote the bad pattern. */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (EXT.test(name)) out.push(full);
  }
  return out;
}

const findings = [];

for (const root of ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("ANY(")) continue;
    const lines = src.split("\n");

    // Identifiers in this file that hold a pre-built literal fragment.
    const rawVars = new Set();
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*sql\.raw\b/g)) {
      rawVars.add(m[1]);
    }

    lines.forEach((line, i) => {
      if (COMMENT_LINE.test(line)) return;
      for (const m of line.matchAll(ANY_CALL)) {
        const expr = m[1].trim();
        // Inline sql.raw(...) in the interpolation itself.
        if (expr.startsWith("sql.raw")) continue;
        // A bare identifier that this file assigns from sql.raw.
        if (rawVars.has(expr)) continue;
        findings.push({ file: relative(ROOT, file), line: i + 1, text: line.trim() });
      }
    });
  }
}

if (findings.length === 0) {
  console.log("no ANY(array) trap found — proceeding");
  process.exit(0);
}

console.log(`::error::ANY(array) trap — this pattern throws at EVERY input length.`);
console.log("");
console.log(`Found ${findings.length} occurrence(s):`);
console.log("");
for (const f of findings) console.log(`  ${f.file}:${f.line}\n      ${f.text}`);
console.log("");
console.log("Drizzle spreads a JS array into separate placeholders, so");
console.log("  = ANY(${ids}::int[])  →  ANY(($2,$3)::int[])  →  cannot cast type record to integer[]");
console.log("");
console.log("Use inList / inIntList from artifacts/api-server/src/lib/sql-lists.ts:");
console.log("");
console.log("    const list = inIntList(ids);");
console.log("    if (!list) return [];");
console.log("    sql`WHERE job_id IN (${list})`");
console.log("");
console.log("A pre-built sql.raw(`ARRAY[...]`) fragment is also accepted.");
process.exit(1);
