/**
 * Step 2 — Add `timeclock.branch_id` and backfill from `jobs.branch_id`.
 *
 * - Adds column if missing (IF NOT EXISTS — idempotent).
 * - Backfills NULL branch_id from each row's linked job, defaulting NULL job
 *   branches to Oak Lawn (id=1) per the product call.
 * - Adds a FK constraint to branches(id) so the column is self-validating
 *   going forward.
 *
 * Dry-run by default; APPLY=1 to write. Read-only safe to run repeatedly.
 *
 * Run:
 *   node --env-file=/Users/salvadormartinez/qleno/.env scripts/migrate_timeclock_branch_id.cjs
 *   APPLY=1 node --env-file=/Users/salvadormartinez/qleno/.env scripts/migrate_timeclock_branch_id.cjs
 */
const { Pool } = require("/Users/salvadormartinez/qleno/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js");

const APPLY = process.env.APPLY === "1";
const COMPANY_ID = 1;
const DEFAULT_BRANCH_ID = 1; // Oak Lawn

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log(`[mode] ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}`);

  // 1. Schema check
  const colCheck = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='timeclock' AND column_name='branch_id'`,
  );
  const columnExists = colCheck.rows.length > 0;
  console.log(`[schema] timeclock.branch_id ${columnExists ? "exists" : "MISSING"}`);

  // 2. Pre-count: how many rows would be affected?
  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM timeclock)                                AS total_rows,
      (SELECT COUNT(*)::int FROM timeclock t JOIN jobs j ON j.id=t.job_id
        WHERE j.branch_id IS NOT NULL)                                     AS backfillable_from_job,
      (SELECT COUNT(*)::int FROM timeclock t JOIN jobs j ON j.id=t.job_id
        WHERE j.branch_id IS NULL)                                         AS job_null_branch
  `);
  console.table(counts.rows);

  // 3. Per-company × per-(soon-to-be) branch breakdown via the join.
  const breakdown = await pool.query(`
    SELECT
      t.company_id,
      COALESCE(j.branch_id, $1) AS effective_branch_id,
      b.name AS branch_name,
      COUNT(*)::int AS clock_rows
    FROM timeclock t
    JOIN jobs j     ON j.id=t.job_id
    LEFT JOIN branches b ON b.id = COALESCE(j.branch_id, $1)
    GROUP BY 1,2,3
    ORDER BY 1,2
  `, [DEFAULT_BRANCH_ID]);
  console.log(`\n[breakdown] clock rows by (company, effective branch):`);
  console.table(breakdown.rows);

  if (!APPLY) {
    console.log(`\n=== DRY-RUN ===`);
    console.log(`  next: ADD COLUMN timeclock.branch_id integer REFERENCES branches(id)`);
    console.log(`  then: UPDATE timeclock SET branch_id = COALESCE(j.branch_id, ${DEFAULT_BRANCH_ID}) FROM jobs j WHERE j.id = timeclock.job_id`);
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (!columnExists) {
      console.log(`\n[apply] adding column timeclock.branch_id`);
      await client.query(`ALTER TABLE timeclock ADD COLUMN branch_id integer`);
      await client.query(`ALTER TABLE timeclock ADD CONSTRAINT timeclock_branch_id_branches_id_fk FOREIGN KEY (branch_id) REFERENCES branches(id)`);
      console.log(`  ✓ column + FK constraint added`);
    } else {
      console.log(`\n[apply] column already exists, skipping ADD COLUMN`);
    }

    console.log(`[apply] backfilling NULL branch_id rows from jobs.branch_id (COALESCE → Oak Lawn ${DEFAULT_BRANCH_ID})`);
    const u = await client.query(
      `UPDATE timeclock t
          SET branch_id = COALESCE(j.branch_id, $1)
         FROM jobs j
        WHERE j.id = t.job_id
          AND t.branch_id IS NULL
       RETURNING t.id`,
      [DEFAULT_BRANCH_ID],
    );
    console.log(`  ✓ backfilled ${u.rowCount} rows`);

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(`  ROLLED BACK: ${e.message}`);
    throw e;
  } finally {
    client.release();
  }

  // 4. Verify
  const verify = await pool.query(`
    SELECT
      COUNT(*)::int                                          AS total,
      COUNT(*) FILTER (WHERE branch_id IS NULL)::int          AS null_branch,
      COUNT(*) FILTER (WHERE branch_id = 1)::int              AS oak_lawn,
      COUNT(*) FILTER (WHERE branch_id = 2)::int              AS schaumburg
      FROM timeclock
  `);
  console.log(`\n=== Verification ===`);
  console.table(verify.rows);

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
