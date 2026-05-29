/**
 * T — Option B: unlink quote 28 + revert to 'accepted', then delete orphan jobs.
 *
 * Transaction gates (ROLLBACK on any fail):
 *   1. quotes UPDATE returns exactly 1 row (id 28, booked_job_id was 2081)
 *   2. job_technicians cleanup — no expected count (0 known; belt-and-suspenders)
 *   3. jobs DELETE returns exactly 2 rows (703, 2081)
 *   4. Post Apr 23 totals = 14 jobs / $2,900.25 / 52.25h
 *   5. quote 28 ends with status='accepted', booked_job_id=NULL
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== T — Option B: unlink quote + delete 2 orphan jobs ===\n");

  await db.execute(sql`BEGIN`);
  try {
    // --- Gate 1: quote unlink ---
    const quoteUpd = await db.execute(sql`
      UPDATE quotes
         SET booked_job_id = NULL, status = 'accepted'
       WHERE id = 28 AND booked_job_id = 2081
      RETURNING id, status, booked_job_id
    `);
    console.log(`quotes UPDATE rowcount: ${quoteUpd.rowCount} (expect 1)`);
    console.log("Returning:", quoteUpd.rows);
    if (quoteUpd.rowCount !== 1) {
      throw new Error(`Gate 1 FAIL — quote update returned ${quoteUpd.rowCount}, expected 1`);
    }

    // --- Gate 2: job_technicians cleanup ---
    const jtDel = await db.execute(sql`
      DELETE FROM job_technicians WHERE job_id IN (703, 2081)
    `);
    console.log(`\njob_technicians cleanup: ${jtDel.rowCount} rows (0 known pre-audit)`);

    // --- Gate 3: main DELETE ---
    const del = await db.execute(sql`
      DELETE FROM jobs
       WHERE id IN (703, 2081)
         AND company_id = 1
         AND mc_job_id IS NULL
      RETURNING id, client_id, scheduled_time, base_fee::text AS base_fee
    `);
    const delCount = del.rowCount ?? 0;
    console.log(`\njobs DELETE rowcount: ${delCount} (expect 2)`);
    console.table(del.rows);
    if (delCount !== 2) {
      throw new Error(`Gate 3 FAIL — delete returned ${delCount}, expected 2`);
    }

    // --- Gate 4: Apr 23 final totals ---
    const after = await db.execute(sql`
      SELECT COUNT(*)::int AS job_count,
             SUM(base_fee::numeric)::numeric(14,2)::text AS revenue,
             SUM(allowed_hours::numeric)::numeric(14,2)::text AS hours
        FROM jobs
       WHERE company_id = 1 AND scheduled_date = '2026-04-23'
    `);
    const row = after.rows?.[0] as any;
    const gotJobs = Number(row?.job_count ?? 0);
    const gotRev = String(row?.revenue ?? "");
    const gotHrs = String(row?.hours ?? "");
    console.log(`\nApr 23 post: job_count=${gotJobs}  revenue=$${gotRev}  hours=${gotHrs}`);
    console.log(`Expected:    job_count=14         revenue=$2900.25       hours=52.25`);
    const ok = gotJobs === 14 && gotRev === "2900.25" && gotHrs === "52.25";
    if (!ok) {
      throw new Error(`Gate 4 FAIL — Apr 23 totals don't match MC ground truth`);
    }

    // --- Gate 5: quote 28 final state ---
    const quoteCheck = await db.execute(sql`
      SELECT id, client_id, status, booked_job_id, total_price::text AS total_price
        FROM quotes WHERE id = 28
    `);
    const qRow = quoteCheck.rows?.[0] as any;
    console.log("\nQuote 28 final state:");
    console.table([qRow]);
    if (qRow.status !== "accepted" || qRow.booked_job_id !== null) {
      throw new Error(`Gate 5 FAIL — quote 28 status='${qRow.status}' booked_job_id=${qRow.booked_job_id}`);
    }

    await db.execute(sql`COMMIT`);
    console.log("\n--- COMMIT OK ---");
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    console.log("\n--- ROLLBACK ---");
    console.error(err);
    process.exit(1);
  }

  // ---- Post-verify ----
  console.log("\n=== Post-commit final state ===");

  const apr23 = await db.execute(sql`
    SELECT
      CASE WHEN mc_job_id IS NULL THEN 'NO_MC_ID' ELSE 'MC_IMPORTED' END AS source,
      COUNT(*)::int AS job_count,
      SUM(base_fee::numeric)::numeric(14,2)::text AS revenue
    FROM jobs
    WHERE company_id = 1 AND scheduled_date = '2026-04-23'
    GROUP BY 1
  `);
  console.log("Apr 23 by source:");
  console.table(apr23.rows);

  const idsGone = await db.execute(sql`
    SELECT id FROM jobs WHERE id IN (703, 2081)
  `);
  console.log(`\nIds 703 / 2081 still present: ${idsGone.rowCount} (expect 0)`);

  const quote = await db.execute(sql`
    SELECT id, status, booked_job_id, total_price::text AS total_price FROM quotes WHERE id = 28
  `);
  console.log("\nQuote 28:");
  console.table(quote.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
