/**
 * Migration — add cascade_group_id + cascade_order to leave_requests.
 *
 * Why: leave bucket cascade (PTO → PLAWA → Unpaid Leave fall-through)
 * needs to create N linked leave_requests rows in one shot. The shared
 * group id makes the rows queryable as a unit; cascade_order remembers
 * the bucket sequence. Both NULL on single-bucket requests so the
 * 3A flow keeps working unchanged.
 *
 * Adds an index on cascade_group_id so "show the whole cascade" lookups
 * stay O(group-size).
 *
 * Idempotent. Dry-run by default; APPLY=1 to write.
 *
 * Run:
 *   node --env-file=/Users/salvadormartinez/qleno/.env scripts/migrate_leave_cascade_columns.cjs
 *   APPLY=1 node --env-file=/Users/salvadormartinez/qleno/.env scripts/migrate_leave_cascade_columns.cjs
 */
const { Pool } = require("/Users/salvadormartinez/qleno/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js");

const APPLY = process.env.APPLY === "1";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log(`[mode] ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}`);

  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='leave_requests'
        AND column_name IN ('cascade_group_id','cascade_order')`,
  );
  const have = new Set(cols.rows.map((r) => r.column_name));
  console.log(`[schema] cascade_group_id ${have.has("cascade_group_id") ? "exists" : "MISSING"}`);
  console.log(`[schema] cascade_order    ${have.has("cascade_order")    ? "exists" : "MISSING"}`);

  const ixCheck = await pool.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND tablename='leave_requests'
        AND indexname='leave_requests_cascade_group_idx'`,
  );
  console.log(`[index]  leave_requests_cascade_group_idx ${ixCheck.rows.length ? "exists" : "MISSING"}`);

  if (!APPLY) {
    console.log(`\n=== DRY-RUN ===`);
    if (!have.has("cascade_group_id")) console.log(`  next: ALTER TABLE leave_requests ADD COLUMN cascade_group_id text`);
    if (!have.has("cascade_order")) console.log(`  next: ALTER TABLE leave_requests ADD COLUMN cascade_order integer`);
    if (ixCheck.rows.length === 0) console.log(`  next: CREATE INDEX leave_requests_cascade_group_idx ON leave_requests (cascade_group_id)`);
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!have.has("cascade_group_id")) {
      await client.query(`ALTER TABLE leave_requests ADD COLUMN cascade_group_id text`);
      console.log(`  ✓ added cascade_group_id`);
    }
    if (!have.has("cascade_order")) {
      await client.query(`ALTER TABLE leave_requests ADD COLUMN cascade_order integer`);
      console.log(`  ✓ added cascade_order`);
    }
    if (ixCheck.rows.length === 0) {
      await client.query(`CREATE INDEX leave_requests_cascade_group_idx ON leave_requests (cascade_group_id)`);
      console.log(`  ✓ created leave_requests_cascade_group_idx`);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(`  ROLLED BACK: ${e.message}`);
    throw e;
  } finally {
    client.release();
  }

  const verify = await pool.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='leave_requests'
        AND column_name IN ('cascade_group_id','cascade_order')
      ORDER BY column_name`,
  );
  console.log(`\n=== Verification ===`);
  console.table(verify.rows);

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
