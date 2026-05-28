/**
 * N — backfill jobs.allowed_hours from estimated_hours for MC-imported rows.
 *
 * Why: L4 populated estimated_hours but NOT allowed_hours. The Dispatch
 * endpoint (artifacts/api-server/src/routes/dispatch.ts:53) reads
 * allowed_hours to compute durationMinutes (default 120 when NULL), so all
 * 983 MC-imported rows render as 2-hour Gantt blocks. Backfill fixes this.
 *
 * Rollback:
 *   UPDATE jobs SET allowed_hours = NULL
 *    WHERE company_id = 1 AND mc_job_id IS NOT NULL
 *      AND allowed_hours = estimated_hours
 *      AND notes LIKE '%mc_import_phase4%';
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== N — allowed_hours backfill ===\n");

  // ---- Dry-run ----
  console.log("Step 1 — DRY RUN: count rows matching backfill predicate");
  const dryRun = await db.execute(sql`
    SELECT COUNT(*)::int AS n
      FROM jobs
     WHERE company_id = 1
       AND mc_job_id IS NOT NULL
       AND allowed_hours IS NULL
       AND estimated_hours IS NOT NULL
  `);
  const n = Number((dryRun.rows?.[0] as any)?.n ?? 0);
  console.log(`Matching rows: ${n}`);

  // Also show how many MC rows exist in total and how many would still be skipped
  const totalMc = await db.execute(sql`
    SELECT COUNT(*)::int AS total_mc,
           COUNT(*) FILTER (WHERE allowed_hours IS NOT NULL)::int AS already_set,
           COUNT(*) FILTER (WHERE estimated_hours IS NULL)::int AS no_estimate
      FROM jobs
     WHERE company_id = 1 AND mc_job_id IS NOT NULL
  `);
  console.log("MC rows context:");
  console.table(totalMc.rows);

  // Sanity: sample 5 rows
  const sample = await db.execute(sql`
    SELECT id, mc_job_id, client_id,
           estimated_hours::text AS estimated_hours,
           allowed_hours::text AS allowed_hours
      FROM jobs
     WHERE company_id = 1
       AND mc_job_id IS NOT NULL
       AND allowed_hours IS NULL
       AND estimated_hours IS NOT NULL
     ORDER BY id
     LIMIT 5
  `);
  console.log("\nSample pre-update rows:");
  console.table(sample.rows);

  if (n === 0) {
    console.log("No matching rows — nothing to do. Exiting.");
    process.exit(0);
  }

  // ---- Transaction ----
  console.log("\nStep 2 — TRANSACTION: UPDATE with rowcount gate");
  await db.execute(sql`BEGIN`);
  try {
    const update = await db.execute(sql`
      UPDATE jobs
         SET allowed_hours = estimated_hours
       WHERE company_id = 1
         AND mc_job_id IS NOT NULL
         AND allowed_hours IS NULL
         AND estimated_hours IS NOT NULL
      RETURNING id
    `);
    const updated = update.rowCount ?? 0;
    console.log(`UPDATE rowcount: ${updated} (expect ${n})`);
    if (updated !== n) {
      throw new Error(`rowcount mismatch: got ${updated}, expected ${n}`);
    }
    await db.execute(sql`COMMIT`);
    console.log("--- COMMIT OK ---");
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    console.log("--- ROLLBACK ---");
    throw err;
  }

  // ---- Post-verify ----
  console.log("\nStep 3 — post-verify");
  const post = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total_mc,
      COUNT(*) FILTER (WHERE allowed_hours IS NOT NULL)::int AS has_allowed,
      COUNT(*) FILTER (WHERE allowed_hours IS NULL)::int AS null_allowed,
      MIN(allowed_hours)::text AS min_allowed,
      MAX(allowed_hours)::text AS max_allowed,
      AVG(allowed_hours)::numeric(6,2)::text AS avg_allowed
    FROM jobs
    WHERE company_id = 1 AND mc_job_id IS NOT NULL
  `);
  console.table(post.rows);

  // Distribution of allowed_hours after backfill
  const dist = await db.execute(sql`
    SELECT allowed_hours::text AS hours, COUNT(*)::int AS n
      FROM jobs
     WHERE company_id = 1 AND mc_job_id IS NOT NULL
     GROUP BY allowed_hours
     ORDER BY allowed_hours
     LIMIT 20
  `);
  console.log("\nTop allowed_hours distribution (first 20 buckets):");
  console.table(dist.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
