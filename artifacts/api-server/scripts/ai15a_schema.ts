/**
 * AI.15a foundation. Idempotent schema migration.
 *
 * Adds the following column:
 *   * jobs.last_recalculated_at TIMESTAMP (nullable)
 *
 * Used by /api/dispatch?since=<iso> polling to return only changed jobs.
 * NULL on all historical rows is fine. Those rows simply never trigger a
 * "changed since" match until someone mutates them.
 *
 * Safe to rerun. Uses ADD COLUMN IF NOT EXISTS.
 */
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("[ai15a] adding jobs.last_recalculated_at if missing...");

  await db.execute(sql`
    ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS last_recalculated_at TIMESTAMP
  `);

  // Verify
  const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'jobs'
      AND column_name = 'last_recalculated_at'
  `);
  if (!cols.rows.length) {
    throw new Error("ABORT: last_recalculated_at column not found after ALTER");
  }
  console.log("[ai15a] verified:");
  console.table(cols.rows);

  // Coverage stats for sanity.
  const stats = await db.execute(sql`
    SELECT
      COUNT(*)::int                                AS total,
      COUNT(last_recalculated_at)::int             AS stamped,
      (COUNT(*) - COUNT(last_recalculated_at))::int AS unstamped
    FROM jobs
  `);
  console.log("[ai15a] jobs row stats:");
  console.table(stats.rows);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
