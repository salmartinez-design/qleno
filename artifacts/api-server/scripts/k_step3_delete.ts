/**
 * Commit K Step 3 REVISED — delete 313 engine-generated rows from 2026-04-01 on.
 *
 * Scope: scheduled_date >= '2026-04-01'
 *        AND recurring_schedule_id IS NOT NULL
 *        AND status = 'scheduled'
 *        AND company_id = 1
 *
 * Preserves: manual jobs (recurring_schedule_id IS NULL), completed rows,
 * cancelled rows, and anything pre-April.
 *
 * Single BEGIN/COMMIT with rowcount gate (expect 313). Rolls back on mismatch.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const EXPECTED = 313;

async function main() {
  console.log(`=== Commit K Step 3 — DELETE ${EXPECTED} engine rows ===\n`);

  // Pre-flight: confirm count matches expectation
  const pre = await db.execute(sql`
    SELECT COUNT(*)::int AS n,
           SUM(base_fee::numeric)::numeric(14,2) AS total
      FROM jobs
     WHERE company_id = 1
       AND scheduled_date >= '2026-04-01'
       AND recurring_schedule_id IS NOT NULL
       AND status = 'scheduled'
  `);
  const preN = Number((pre.rows?.[0] as any)?.n ?? 0);
  const preTotal = String((pre.rows?.[0] as any)?.total ?? '');
  console.log(`Pre-flight: ${preN} rows / $${preTotal}  (expect ${EXPECTED})`);
  if (preN !== EXPECTED) {
    console.log(`\n!! Pre-flight count mismatch (got ${preN}, expected ${EXPECTED}). Aborting — no writes.`);
    process.exit(1);
  }

  // Baseline snapshot BEFORE delete
  const baselineTotal = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM jobs WHERE company_id = 1
  `);
  console.log(`Baseline PHES jobs total before delete: ${(baselineTotal.rows?.[0] as any)?.n}\n`);

  // --- Transaction ---
  console.log("--- BEGIN TRANSACTION ---");
  await db.execute(sql`BEGIN`);
  try {
    const del = await db.execute(sql`
      DELETE FROM jobs
       WHERE company_id = 1
         AND scheduled_date >= '2026-04-01'
         AND recurring_schedule_id IS NOT NULL
         AND status = 'scheduled'
      RETURNING id, scheduled_date::text AS scheduled_date,
                client_id AS customer_id,
                base_fee::text AS base_fee,
                recurring_schedule_id
    `);
    const delCount = del.rowCount ?? 0;
    console.log(`DELETE rowcount: ${delCount}  (expect ${EXPECTED})`);

    if (delCount !== EXPECTED) {
      throw new Error(`Delete rowcount mismatch: got ${delCount}, expected ${EXPECTED}`);
    }

    // In-txn: verify no engine-generated scheduled rows survive in the target window
    const postWindow = await db.execute(sql`
      SELECT COUNT(*)::int AS n
        FROM jobs
       WHERE company_id = 1
         AND scheduled_date >= '2026-04-01'
         AND recurring_schedule_id IS NOT NULL
         AND status = 'scheduled'
    `);
    const postWindowN = Number((postWindow.rows?.[0] as any)?.n ?? -1);
    console.log(`In-txn verify: engine scheduled rows from 2026-04-01 onward remaining = ${postWindowN} (expect 0)`);
    if (postWindowN !== 0) {
      throw new Error(`Engine rows still present after delete: ${postWindowN}`);
    }

    await db.execute(sql`COMMIT`);
    console.log("--- COMMIT OK ---\n");

    // Preserve RETURNING sample for the log
    const sample = (del.rows as any[]).slice(0, 10);
    console.log("First 10 deleted rows (sample from RETURNING):");
    console.table(sample);
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    console.log("--- ROLLBACK ---");
    console.error(err);
    process.exit(1);
  }

  // ---- POST-DELETE SANITY ----
  console.log("\n=== POST-DELETE SANITY ===\n");

  console.log("--- April 23-30 now (expect mostly empty + Apr 23 = 2 manuals) ---");
  const apr2330 = await db.execute(sql`
    SELECT scheduled_date::text AS scheduled_date,
           COUNT(*)::int AS n,
           SUM(base_fee::numeric)::numeric(14,2) AS sum_fee
      FROM jobs
     WHERE company_id = 1 AND scheduled_date BETWEEN '2026-04-23' AND '2026-04-30'
     GROUP BY scheduled_date ORDER BY scheduled_date
  `);
  console.table(apr2330.rows);

  console.log("\n--- Full April 2026 state ---");
  const aprAll = await db.execute(sql`
    SELECT scheduled_date::text AS scheduled_date,
           status,
           (recurring_schedule_id IS NULL) AS is_manual,
           COUNT(*)::int AS n,
           SUM(base_fee::numeric)::numeric(14,2) AS sum_fee
      FROM jobs
     WHERE company_id = 1 AND scheduled_date BETWEEN '2026-04-01' AND '2026-04-30'
     GROUP BY scheduled_date, status, is_manual
     ORDER BY scheduled_date, status, is_manual
  `);
  console.table(aprAll.rows);

  const aprTotal = await db.execute(sql`
    SELECT COUNT(*)::int AS n, SUM(base_fee::numeric)::numeric(14,2) AS total
      FROM jobs WHERE company_id = 1 AND scheduled_date BETWEEN '2026-04-01' AND '2026-04-30'
  `);
  console.log("April total remaining:", aprTotal.rows);

  console.log("\n--- PHES jobs total (all time) ---");
  const allTotal = await db.execute(sql`
    SELECT status,
           COUNT(*)::int AS n,
           SUM(base_fee::numeric)::numeric(14,2) AS total
      FROM jobs WHERE company_id = 1
     GROUP BY status ORDER BY status
  `);
  console.table(allTotal.rows);

  console.log("\n--- Engine flag state ---");
  const flags = await db.execute(sql`
    SELECT id, name, recurring_engine_enabled FROM companies ORDER BY id
  `);
  console.table(flags.rows);

  console.log("\n--- Future engine-generated rows remaining (should be ZERO) ---");
  const futureEngine = await db.execute(sql`
    SELECT COUNT(*)::int AS n
      FROM jobs
     WHERE company_id = 1
       AND recurring_schedule_id IS NOT NULL
       AND status = 'scheduled'
       AND scheduled_date >= CURRENT_DATE
  `);
  console.log(futureEngine.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
