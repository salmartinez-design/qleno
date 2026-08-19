// Applies lib/db/migrations/2026-08-19-ares-tables-create-only.sql.
//
// This is the safe replacement for `drizzle-kit push`. It executes exactly the
// statements in that file and nothing else — no diffing, no reconciliation, no
// rename prompts, no possibility of dropping anything.
//
//   pnpm exec tsx ares-migration/apply-ares-tables.ts          # dry run: list statements
//   pnpm exec tsx ares-migration/apply-ares-tables.ts --commit # actually run them
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const COMMIT = process.argv.includes("--commit");
const FILE = resolve(
  import.meta.dirname,
  "../../../lib/db/migrations/2026-08-19-ares-tables-create-only.sql",
);

/** Split on semicolons that are not inside a string, comment, or $tag$ block. */
function splitStatements(src: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  let inSingle = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      buf += c; i++; continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") { inBlockComment = false; buf += "*/"; i += 2; continue; }
      buf += c; i++; continue;
    }
    if (dollarTag) {
      if (src.startsWith(dollarTag, i)) { buf += dollarTag; i += dollarTag.length; dollarTag = null; continue; }
      buf += c; i++; continue;
    }
    if (inSingle) {
      if (c === "'" && next === "'") { buf += "''"; i += 2; continue; }
      if (c === "'") { inSingle = false; }
      buf += c; i++; continue;
    }

    if (c === "-" && next === "-") { inLineComment = true; buf += "--"; i += 2; continue; }
    if (c === "/" && next === "*") { inBlockComment = true; buf += "/*"; i += 2; continue; }
    if (c === "'") { inSingle = true; buf += c; i++; continue; }

    const dollar = /^\$[A-Za-z_]*\$/.exec(src.slice(i));
    if (c === "$" && dollar) { dollarTag = dollar[0]; buf += dollarTag; i += dollarTag.length; continue; }

    if (c === ";") { out.push(buf.trim()); buf = ""; i++; continue; }
    buf += c; i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
}

const raw = readFileSync(FILE, "utf8");
const statements = splitStatements(raw);

// Belt and braces: refuse to run if anything in this file can destroy data.
const stripped = raw.replace(/--[^\n]*/g, "");
const banned = /\b(drop|truncate|delete\s+from|rename\s+to)\b/i.exec(stripped);
if (banned) {
  console.error(`REFUSING TO RUN: found "${banned[0]}" in the SQL file. Nothing was executed.`);
  process.exit(1);
}

const label = (s: string) =>
  (s.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim().slice(0, 90));

console.log(`${statements.length} statements in ${FILE.split("/").slice(-1)[0]}`);
console.log(COMMIT ? "MODE: COMMIT — executing\n" : "MODE: dry run — nothing will be executed\n");

let ok = 0;
for (const [n, stmt] of statements.entries()) {
  const tag = String(n + 1).padStart(2, " ");
  if (!COMMIT) { console.log(`${tag}. ${label(stmt)}`); continue; }
  try {
    await db.execute(sql.raw(stmt));
    ok++;
    console.log(`${tag}. ok    ${label(stmt)}`);
  } catch (e: any) {
    console.error(`${tag}. FAIL  ${label(stmt)}`);
    console.error(`    ${e?.message ?? e}`);
    console.error(`\nStopped at statement ${n + 1}. ${ok} succeeded. Nothing was dropped.`);
    process.exit(1);
  }
}

if (COMMIT) console.log(`\nDone — ${ok}/${statements.length} statements applied.`);
else console.log(`\nDry run only. Re-run with --commit to apply.`);
process.exit(0);
