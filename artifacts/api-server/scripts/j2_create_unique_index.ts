/**
 * J2 — CREATE UNIQUE INDEX CONCURRENTLY on jobs to prevent dedupe-race dupes.
 *
 * Uses a partial index so manual one-off jobs (recurring_schedule_id IS NULL)
 * are not constrained — only auto-generated recurring jobs must be unique on
 * (company_id, recurring_schedule_id, scheduled_date).
 *
 * CONCURRENTLY cannot run inside a transaction; we run it at session level.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== J2 — create partial unique index ===\n");

  // Check if index already exists (idempotent)
  const existing = await db.execute(sql`
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'jobs'
       AND indexname = 'jobs_recurring_dedupe_idx'
  `);
  if ((existing.rowCount ?? 0) > 0) {
    console.log("Index already exists. Skipping.");
    process.exit(0);
  }

  // Final safety check: no dup tuples
  const dupes = await db.execute(sql`
    SELECT company_id, recurring_schedule_id, scheduled_date, COUNT(*)::int AS n
      FROM jobs
     WHERE recurring_schedule_id IS NOT NULL
     GROUP BY company_id, recurring_schedule_id, scheduled_date
    HAVING COUNT(*) > 1
  `);
  const dupCount = dupes.rowCount ?? 0;
  if (dupCount > 0) {
    console.log(`!! ${dupCount} dup tuples remain. Aborting index creation.`);
    console.log(dupes.rows);
    process.exit(1);
  }
  console.log("Pre-flight: zero dup tuples. Safe to create unique index.");

  console.log("\nCreating index (CONCURRENTLY, may take a few seconds)...");
  await db.execute(sql`
    CREATE UNIQUE INDEX CONCURRENTLY jobs_recurring_dedupe_idx
        ON jobs (company_id, recurring_schedule_id, scheduled_date)
     WHERE recurring_schedule_id IS NOT NULL
  `);
  console.log("Index created.");

  // Verify
  const after = await db.execute(sql`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'jobs'
       AND indexname = 'jobs_recurring_dedupe_idx'
  `);
  console.log("\nPost-verify:");
  console.log(after.rows);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
