/**
 * Step 6 — Backfill users.home_branch_id for the 19 NULL active workers.
 *
 * Per Sal: home_branch is a default/preference, not a constraint. A
 * Schaumburg tech can still be assigned to Oak Lawn jobs and vice versa.
 * For the initial backfill we default everyone to Oak Lawn (id=1), since
 * that's where the active 19 NULL workers operate today. Schaumburg techs
 * can be moved individually via the Employee edit screen later.
 *
 * Only touches: company_id=1, role IN ('technician','office','admin','owner','team_lead'),
 * is_active=true, home_branch_id IS NULL.
 *
 * Dry-run by default; APPLY=1 to write.
 */
const { Pool } = require("/Users/salvadormartinez/qleno/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js");

const APPLY = process.env.APPLY === "1";
const COMPANY_ID = 1;
const DEFAULT_BRANCH_ID = 1; // Oak Lawn

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log(`[mode] ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}`);

  const cands = await pool.query(
    `SELECT id, email, first_name, last_name, role::text AS role, home_branch_id
       FROM users
      WHERE company_id = $1
        AND is_active = true
        AND home_branch_id IS NULL
        AND role::text IN ('technician','office','admin','owner','team_lead')
      ORDER BY id`,
    [COMPANY_ID],
  );
  console.log(`[found] ${cands.rows.length} active workers with NULL home_branch_id`);
  console.table(cands.rows);

  if (!APPLY) {
    console.log(`\n=== DRY-RUN ===`);
    console.log(`  would set home_branch_id=${DEFAULT_BRANCH_ID} on ${cands.rows.length} rows`);
    await pool.end();
    return;
  }

  const u = await pool.query(
    `UPDATE users
        SET home_branch_id = $1
      WHERE company_id = $2
        AND is_active = true
        AND home_branch_id IS NULL
        AND role::text IN ('technician','office','admin','owner','team_lead')
     RETURNING id`,
    [DEFAULT_BRANCH_ID, COMPANY_ID],
  );
  console.log(`  updated ${u.rowCount} rows`);

  const verify = await pool.query(
    `SELECT home_branch_id, COUNT(*)::int AS n
       FROM users
      WHERE company_id = $1 AND is_active = true
      GROUP BY home_branch_id
      ORDER BY home_branch_id NULLS LAST`,
    [COMPANY_ID],
  );
  console.log(`\n=== Verification — active workers by home_branch ===`);
  console.table(verify.rows);

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
