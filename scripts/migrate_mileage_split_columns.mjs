/**
 * [shared-drive-split 2026-08-15] Add mileage_legs.split_group_size +
 * amount_before_split.
 *
 * Identical to ensureMileageSplitColumns() in cutover-data-migration.ts, which
 * runs on every cold start. This script only exists so the columns can be in
 * place before the deploy — the app adds them either way.
 *
 * Additive and nullable with no default: every existing row reads "not split",
 * no data is rewritten, and no existing query changes behavior.
 *
 * Idempotent. Dry-run by default; APPLY=1 to write.
 *
 * Run:
 *   node --env-file=/Users/salvadormartinez/qleno/.env scripts/migrate_mileage_split_columns.mjs
 *   APPLY=1 node --env-file=/Users/salvadormartinez/qleno/.env scripts/migrate_mileage_split_columns.mjs
 */
import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js";

const { Pool } = pg;
const APPLY = process.env.APPLY === "1";

const STMT = `
  ALTER TABLE mileage_legs
    ADD COLUMN IF NOT EXISTS split_group_size INTEGER,
    ADD COLUMN IF NOT EXISTS amount_before_split NUMERIC(10,2)
`;

async function present(pool) {
  const { rows } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'mileage_legs'
      AND column_name IN ('split_group_size', 'amount_before_split')
    ORDER BY column_name
  `);
  return rows.map((r) => r.column_name);
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const before = await present(pool);
  console.log(`before: [${before.join(", ")}]`);

  if (before.length === 2) {
    console.log("Both columns already exist — nothing to do.");
    await pool.end();
    return;
  }

  if (!APPLY) {
    console.log("\nDRY RUN. Would run:\n" + STMT);
    console.log("Re-run with APPLY=1 to write.");
    await pool.end();
    return;
  }

  await pool.query(STMT);
  const after = await present(pool);
  console.log(`after:  [${after.join(", ")}]`);

  // Nothing should have been rewritten — every row reads "not split".
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM mileage_legs WHERE split_group_size IS NOT NULL`,
  );
  console.log(`rows marked split: ${rows[0].n} (expected 0)`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
