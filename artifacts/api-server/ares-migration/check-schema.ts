// Read-only. Reports which tables the Ares module needs and which exist.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const NEEDED = [
  ["clients", "core — must already exist"],
  ["recurring_schedules", "core — must already exist"],
  ["users", "core — must already exist"],
  ["companies", "core — must already exist"],
  ["recurring_subscriptions", "recurring module"],
  ["subscription_lifecycle_events", "recurring module"],
  ["sales_attribution", "recurring module"],
  ["commission_policy", "sales commission"],
  ["commissions", "sales commission"],
  ["commission_payments", "sales commission"],
  ["commission_status_events", "sales commission"],
  ["commission_chargebacks", "sales commission"],
  ["commission_rate_card", "NEW — ares parity"],
  ["commission_ledger", "NEW — ares parity"],
  ["subscription_cadence_history", "NEW — ares parity"],
];

const r = await db.execute(sql`
  SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
`);
const have = new Set((r.rows as Array<{ table_name: string }>).map(x => x.table_name));

console.log("\n  table                            exists   group");
console.log("  ─────────────────────────────────────────────────────────────");
let missing = 0;
for (const [t, grp] of NEEDED) {
  const ok = have.has(t);
  if (!ok) missing++;
  console.log(`  ${t.padEnd(32)} ${ok ? " yes  " : " NO   "}   ${grp}`);
}
console.log(`\n  ${have.size} tables in public schema · ${missing} of the ${NEEDED.length} needed are missing\n`);

const [c] = (await db.execute(sql`SELECT count(*)::int AS n FROM clients`)).rows as Array<{ n: number }>;
console.log(`  clients: ${c.n}`);
if (have.has("recurring_schedules")) {
  const [s] = (await db.execute(sql`SELECT count(*)::int AS n FROM recurring_schedules WHERE is_active = true`)).rows as Array<{ n: number }>;
  console.log(`  active recurring_schedules: ${s.n}`);
}
process.exit(0);
