// Schaumburg (co4) leave-config cleanup — mirror the Oak Lawn (co1) fixes.
// Dry-run by default (SELECT only, prints before + planned changes). --apply
// runs the 4 UPDATEs in a transaction. Idempotent.
import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js";
import { readFileSync } from "node:fs";
const APPLY = process.argv.includes("--apply");
const CO = 4;
const env = readFileSync("/Users/salvadormartinez/qleno/.env", "utf8");
const url = env.split("\n").find((l) => l.startsWith("DATABASE_URL=")).slice(13).trim().replace(/^["']|["']$/g, "");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

console.log(`=== Schaumburg (co${CO}) leave cleanup — ${APPLY ? "APPLY" : "DRY-RUN"} ===\n`);
console.log("BEFORE — active leave_types:");
console.table((await c.query(`SELECT slug, accrual_mode, carryover_allowed, active FROM leave_types WHERE company_id=$1 ORDER BY active DESC, slug`, [CO])).rows);
console.log("BEFORE — policy:");
console.table((await c.query(`SELECT leave_reset_basis, leave_program_enabled FROM company_leave_policy WHERE company_id=$1`, [CO])).rows);

console.log(`\nPLANNED CHANGES (co${CO}):`);
console.log("  1. PLAWA → flat_grant, accrual_rate 0, carryover_allowed false (was accrue_per_hours/carryover)");
console.log("  2. Deactivate duplicate generic 'pto' (keep 'pto_phes')");
console.log("  3. Deactivate duplicate generic 'sick' (keep 'plawa')");
console.log("  4. company_leave_policy.leave_reset_basis → work_anniversary (was calendar_year)");

if (!APPLY) {
  console.log("\nDRY-RUN: no writes. Re-run with --apply to execute.");
  await c.end();
  process.exit(0);
}

await c.query("BEGIN");
try {
  await c.query(`UPDATE leave_types SET accrual_mode='flat_grant', accrual_rate=0, carryover_allowed=false WHERE company_id=$1 AND slug='plawa'`, [CO]);
  await c.query(`UPDATE leave_types SET active=false WHERE company_id=$1 AND slug='pto'`, [CO]);
  await c.query(`UPDATE leave_types SET active=false WHERE company_id=$1 AND slug='sick'`, [CO]);
  await c.query(`UPDATE company_leave_policy SET leave_reset_basis='work_anniversary' WHERE company_id=$1`, [CO]);
  await c.query("COMMIT");
  console.log("\nAPPLIED.");
} catch (e) {
  await c.query("ROLLBACK");
  console.error("FAILED — rolled back:", e.message);
  process.exitCode = 1;
  await c.end();
  process.exit(1);
}
console.log("\nAFTER — active leave_types:");
console.table((await c.query(`SELECT slug, accrual_mode, carryover_allowed, active FROM leave_types WHERE company_id=$1 ORDER BY active DESC, slug`, [CO])).rows);
console.log("AFTER — policy:");
console.table((await c.query(`SELECT leave_reset_basis FROM company_leave_policy WHERE company_id=$1`, [CO])).rows);
await c.end();
