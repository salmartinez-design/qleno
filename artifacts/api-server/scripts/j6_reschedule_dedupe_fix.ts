/**
 * J6 — Fix reschedule-onto-voided-date failure (#6, June-13 punch-list).
 *
 * Problem: rescheduling a recurring job onto a date that already holds a
 * VOIDED/cancelled occurrence of the SAME schedule returns
 * {"error":"Failed to reschedule job"}. Root cause: the partial unique index
 * `jobs_recurring_dedupe_idx` is
 *     ON jobs (company_id, recurring_schedule_id, scheduled_date)
 *   WHERE recurring_schedule_id IS NOT NULL
 * with NO status exclusion. A cancelled occurrence still occupies its
 * (company_id, recurring_schedule_id, scheduled_date) slot, so moving another
 * occurrence onto that date violates the unique index (SQLSTATE 23505) and the
 * reschedule handler's catch-all returns the generic error.
 *
 * Fix: recreate the index with `AND status <> 'cancelled'` so a cancelled
 * occupant no longer reserves the slot. This matches the (now-dropped)
 * `uq_jobs_no_double_book` constraint, which deliberately carried
 * `WHERE status NOT IN ('cancelled')` exactly so cancel+rebook worked.
 *
 * The dedupe purpose (stop the recurring engine from generating duplicate LIVE
 * occurrences) is preserved — two live occupants on the same slot are still
 * rejected; only cancelled ones stop blocking.
 *
 * CONCURRENTLY cannot run inside a transaction; run at session level.
 * Idempotent: skips if the index already carries the status predicate.
 *
 *   tsx scripts/j6_reschedule_dedupe_fix.ts
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const IDX = "jobs_recurring_dedupe_idx";

async function main() {
  console.log("=== J6 — reschedule dedupe index fix (exclude cancelled) ===\n");

  const cur = await db.execute(sql`
    SELECT indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'jobs' AND indexname = ${IDX}
  `);
  const curDef = (cur.rows[0] as any)?.indexdef as string | undefined;
  console.log("Current definition:", curDef ?? "(index does not exist)");

  if (curDef && /status\b/i.test(curDef)) {
    console.log("\nIndex already excludes cancelled. Nothing to do.");
    process.exit(0);
  }

  // Pre-flight: would the new (stricter-on-live, looser-on-cancelled) index
  // have any duplicate LIVE tuples? If so, abort — data needs cleanup first.
  const dupes = await db.execute(sql`
    SELECT company_id, recurring_schedule_id, scheduled_date, COUNT(*)::int AS n
      FROM jobs
     WHERE recurring_schedule_id IS NOT NULL AND status <> 'cancelled'
     GROUP BY company_id, recurring_schedule_id, scheduled_date
    HAVING COUNT(*) > 1
  `);
  if ((dupes.rowCount ?? 0) > 0) {
    console.log(`!! ${dupes.rowCount} duplicate LIVE tuples remain — aborting.`);
    console.log(dupes.rows);
    process.exit(1);
  }
  console.log("Pre-flight: zero duplicate live tuples. Safe to rebuild.\n");

  if (curDef) {
    console.log("Dropping old index (CONCURRENTLY)...");
    await db.execute(sql`DROP INDEX CONCURRENTLY IF EXISTS ${sql.raw(IDX)}`);
  }

  console.log("Creating index with status exclusion (CONCURRENTLY)...");
  await db.execute(sql`
    CREATE UNIQUE INDEX CONCURRENTLY ${sql.raw(IDX)}
        ON jobs (company_id, recurring_schedule_id, scheduled_date)
     WHERE recurring_schedule_id IS NOT NULL AND status <> 'cancelled'
  `);
  console.log("Index recreated.");

  const after = await db.execute(sql`
    SELECT indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'jobs' AND indexname = ${IDX}
  `);
  console.log("\nPost-verify:", (after.rows[0] as any)?.indexdef);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
