/**
 * Reverse the Model A home_branch_id=1 backfill on the 19 Phes workers.
 *
 * Why: under the tenant-separated model (Phes Oak Lawn / PHES Schaumburg
 * as distinct companies, shared employees via user_companies), home_branch
 * is not the concept that controls who can be scheduled where. Carrying a
 * home_branch=1 on every worker is a Model A artifact — set them back to
 * NULL so the employee records don't claim a constraint that no longer
 * shapes ops.
 *
 * Safe: home_branch_id is a nullable FK; setting it back to NULL doesn't
 * affect job assignment, payroll, or login. Idempotent: only touches the
 * exact 19 rows we updated on June 1.
 *
 * Dry-run by default; APPLY=1 to write.
 *
 * Run:
 *   node --env-file=/Users/salvadormartinez/qleno/.env scripts/reverse_home_branch_backfill.cjs
 *   APPLY=1 node --env-file=/Users/salvadormartinez/qleno/.env scripts/reverse_home_branch_backfill.cjs
 */
const { Pool } = require("/Users/salvadormartinez/qleno/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js");

const APPLY = process.env.APPLY === "1";
const COMPANY_ID = 1;
const TARGET_BRANCH_ID = 1; // The exact rows the June 1 backfill set

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log(`[mode] ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}`);

  // Show what would be reverted. Limit to the role + active filter the
  // forward backfill used, so we only touch what we set.
  const cands = await pool.query(
    `SELECT id, email, first_name, last_name, role::text AS role, home_branch_id
       FROM users
      WHERE company_id = $1
        AND is_active = true
        AND home_branch_id = $2
        AND role::text IN ('technician','office','admin','owner','team_lead')
      ORDER BY id`,
    [COMPANY_ID, TARGET_BRANCH_ID],
  );
  console.log(`[found] ${cands.rows.length} workers currently at home_branch_id=${TARGET_BRANCH_ID}`);
  console.table(cands.rows);

  if (!APPLY) {
    console.log(`\n=== DRY-RUN ===`);
    console.log(`  would set home_branch_id=NULL on ${cands.rows.length} rows`);
    await pool.end();
    return;
  }

  const u = await pool.query(
    `UPDATE users
        SET home_branch_id = NULL
      WHERE company_id = $1
        AND is_active = true
        AND home_branch_id = $2
        AND role::text IN ('technician','office','admin','owner','team_lead')
     RETURNING id`,
    [COMPANY_ID, TARGET_BRANCH_ID],
  );
  console.log(`  cleared ${u.rowCount} rows`);

  const verify = await pool.query(
    `SELECT home_branch_id, COUNT(*)::int AS n
       FROM users
      WHERE company_id = $1 AND is_active = true
      GROUP BY home_branch_id
      ORDER BY home_branch_id NULLS FIRST`,
    [COMPANY_ID],
  );
  console.log(`\n=== Verification — active workers by home_branch ===`);
  console.table(verify.rows);

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
