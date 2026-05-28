/**
 * Live DB drift repair: users.branch_id column.
 *
 * Drizzle schema (lib/db/src/schema/users.ts) declares users.branch_id but
 * the live database is missing the column. The just-deployed
 * GET /api/users/techs-with-status?branch_id=N query references it and
 * fails with a 500, leaving the dispatch drawer's tech dropdown empty in
 * production.
 *
 * Idempotent: ADD COLUMN IF NOT EXISTS. Adds the FK to branches(id) since
 * that matches the schema declaration.
 */
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

(async () => {
  console.log("=== before ===");
  const before = await db.execute(sql`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users' AND column_name='branch_id'
  `);
  console.log(before.rows.length ? "branch_id present" : "branch_id MISSING");

  console.log("\n=== ALTER TABLE ===");
  await db.execute(sql`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id INTEGER
  `);
  // Foreign key constraint, skipped if already present.
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_schema='public'
          AND table_name='users'
          AND constraint_name='users_branch_id_fkey'
      ) THEN
        ALTER TABLE users
          ADD CONSTRAINT users_branch_id_fkey
          FOREIGN KEY (branch_id) REFERENCES branches(id);
      END IF;
    END $$;
  `);
  console.log("ALTER applied");

  console.log("\n=== after ===");
  const after = await db.execute(sql`
    SELECT column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users' AND column_name='branch_id'
  `);
  console.table(after.rows);

  console.log("\n=== row stats ===");
  const stats = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(branch_id)::int AS with_branch,
      (COUNT(*) - COUNT(branch_id))::int AS null_branch
    FROM users
  `);
  console.table(stats.rows);

  await pool.end();
})();
