// Clears the Ares module tables for ONE company so the import can be re-run clean.
//
// These 9 tables were created today and contain nothing but migration output, so
// emptying them loses nothing that isn't reproducible by re-running the import.
//
// It will NOT touch: clients, companies, users, recurring_schedules,
// commission_policy, commission_rate_card — or any table not on the list below.
//
//   pnpm exec tsx ares-migration/reset-ares-import.ts --company 1
//   pnpm exec tsx ares-migration/reset-ares-import.ts --company 1 --commit
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const argv = process.argv;
const COMMIT = argv.includes("--commit");
const ci = argv.indexOf("--company");
const COMPANY_ID = ci >= 0 ? Number(argv[ci + 1]) : NaN;
if (!Number.isInteger(COMPANY_ID) || COMPANY_ID <= 0) {
  console.error("usage: tsx ares-migration/reset-ares-import.ts --company <id> [--commit]");
  process.exit(1);
}

// Children first — every one of these is FK-dependent on something later in the list.
const TABLES = [
  "commission_status_events",
  "commission_chargebacks",
  "commission_payments",
  "commission_ledger",
  "commissions",
  "subscription_cadence_history",
  "subscription_lifecycle_events",
  "sales_attribution",
  "recurring_subscriptions",
];

// Anything here is off limits. Belt and braces against a typo above.
const PROTECTED = new Set([
  "clients", "companies", "users", "recurring_schedules",
  "commission_policy", "commission_rate_card", "jobs", "invoices",
]);
for (const t of TABLES) {
  if (PROTECTED.has(t)) { console.error(`REFUSING: ${t} is protected.`); process.exit(1); }
}

console.log(`company ${COMPANY_ID} — ${COMMIT ? "DELETING" : "dry run, nothing will be deleted"}\n`);
console.log("table                            rows");
console.log("──────────────────────────────────────");

let total = 0;
const counts: Record<string, number> = {};
for (const t of TABLES) {
  const r = await db.execute(
    sql.raw(`SELECT COUNT(*)::int AS n FROM ${t} WHERE company_id = ${COMPANY_ID}`),
  );
  const n = Number((r.rows[0] as any).n);
  counts[t] = n; total += n;
  console.log(`${t.padEnd(32)} ${String(n).padStart(5)}`);
}
console.log("──────────────────────────────────────");
console.log(`${"total".padEnd(32)} ${String(total).padStart(5)}\n`);

if (!COMMIT) {
  console.log("Dry run. Re-run with --commit to delete these rows.");
  process.exit(0);
}

for (const t of TABLES) {
  if (!counts[t]) { console.log(`  skip   ${t} (already empty)`); continue; }
  const r = await db.execute(
    sql.raw(`DELETE FROM ${t} WHERE company_id = ${COMPANY_ID}`),
  );
  console.log(`  cleared ${String(r.rowCount ?? counts[t]).padStart(5)}  ${t}`);
}

console.log("\nVerifying all nine are empty for this company…");
let bad = 0;
for (const t of TABLES) {
  const r = await db.execute(
    sql.raw(`SELECT COUNT(*)::int AS n FROM ${t} WHERE company_id = ${COMPANY_ID}`),
  );
  const n = Number((r.rows[0] as any).n);
  if (n !== 0) { console.error(`  ${t} still has ${n} rows`); bad++; }
}
console.log(bad === 0 ? "All clear — safe to re-run the import." : `${bad} table(s) not empty.`);
process.exit(bad === 0 ? 0 : 1);
