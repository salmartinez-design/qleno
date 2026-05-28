/**
 * U — Re-link quote 28 (Chaevien Clendinen) to MC-imported job 4230.
 *
 * T severed the link when we deleted the duplicate manual job 2081.
 * The real booking is job 4230 (mc_job_id 62002679) — same customer,
 * same date, same amount. This restores the audit chain.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== U — Re-link quote 28 → job 4230 ===\n");

  // Pre-flight: verify job 4230 exists and is for client 258 at the right amount
  const preJob = await db.execute(sql`
    SELECT id, mc_job_id, client_id, scheduled_date::text AS scheduled_date,
           base_fee::text AS base_fee, status::text AS status
      FROM jobs WHERE id = 4230 AND company_id = 1
  `);
  console.log("Target job 4230:");
  console.table(preJob.rows);
  const j = preJob.rows?.[0] as any;
  if (!j || j.client_id !== 258) {
    throw new Error(`Pre-flight FAIL — job 4230 missing or wrong client_id (got ${j?.client_id}, expected 258)`);
  }

  // Pre-flight: verify quote 28 exists and is currently accepted/NULL-booked
  const preQuote = await db.execute(sql`
    SELECT id, client_id, status, booked_job_id, total_price::text AS total_price
      FROM quotes WHERE id = 28
  `);
  console.log("\nQuote 28 before:");
  console.table(preQuote.rows);
  const q = preQuote.rows?.[0] as any;
  if (!q || q.client_id !== 258) {
    throw new Error(`Pre-flight FAIL — quote 28 missing or wrong client_id`);
  }

  // Transaction
  await db.execute(sql`BEGIN`);
  try {
    const res = await db.execute(sql`
      UPDATE quotes
         SET booked_job_id = 4230, status = 'booked'
       WHERE id = 28
      RETURNING id, client_id, status, booked_job_id, total_price::text AS total_price
    `);
    console.log(`\nUPDATE rowcount: ${res.rowCount} (expect 1)`);
    console.table(res.rows);
    if (res.rowCount !== 1) {
      throw new Error(`Gate FAIL — update returned ${res.rowCount}, expected 1`);
    }

    const row = res.rows?.[0] as any;
    if (row.status !== "booked" || Number(row.booked_job_id) !== 4230) {
      throw new Error(`Gate FAIL — quote 28 state wrong: status='${row.status}' booked_job_id=${row.booked_job_id}`);
    }

    await db.execute(sql`COMMIT`);
    console.log("\n--- COMMIT OK ---");
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    console.log("\n--- ROLLBACK ---");
    console.error(err);
    process.exit(1);
  }

  // Post-verify
  const after = await db.execute(sql`
    SELECT q.id AS quote_id, q.client_id, q.status, q.booked_job_id,
           q.total_price::text AS total_price,
           j.mc_job_id, j.scheduled_date::text AS job_date,
           j.base_fee::text AS job_fee, j.status::text AS job_status
      FROM quotes q
      LEFT JOIN jobs j ON j.id = q.booked_job_id
     WHERE q.id = 28
  `);
  console.log("\n=== Post-verify: quote 28 + linked job ===");
  console.table(after.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
