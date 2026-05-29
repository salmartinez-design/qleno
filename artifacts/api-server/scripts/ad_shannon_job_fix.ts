/**
 * AD — Backfill jobs.address_city / address_state / address_zip for Shannon
 * Heidloff's Apr 23 one-off at 1111 Whitfield Rd, Northbrook IL 60062.
 *
 * Gate: target row MUST match (id=4231 AND mc_job_id=62088584 AND
 * scheduled_date=2026-04-23 AND street LIKE '%Whitfield%'). If not →
 * ROLLBACK and abort. Single-row UPDATE, wrapped in a transaction.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== AD — Shannon job 4231 address backfill (Northbrook IL 60062) ===\n");

  // Dry-run: confirm the target row state pre-update.
  console.log("--- Pre-update state ---");
  const pre = await db.execute(sql`
    SELECT id, mc_job_id, scheduled_date, scheduled_time,
           address_street, address_city, address_state, address_zip
      FROM jobs
     WHERE id = 4231 AND company_id = 1
  `);
  console.table(pre.rows);

  const row = (pre.rows as any[])[0];
  if (!row) {
    console.error("✗ No row found for job id 4231. Aborting.");
    process.exit(1);
  }
  if (String(row.mc_job_id) !== "62088584") {
    console.error(`✗ mc_job_id mismatch: expected 62088584, got ${row.mc_job_id}. Aborting.`);
    process.exit(1);
  }
  if (row.scheduled_date !== "2026-04-23") {
    console.error(`✗ scheduled_date mismatch: expected 2026-04-23, got ${row.scheduled_date}. Aborting.`);
    process.exit(1);
  }
  if (!row.address_street || !/whitfield/i.test(row.address_street)) {
    console.error(`✗ address_street doesn't look like a Whitfield address: "${row.address_street}". Aborting.`);
    process.exit(1);
  }
  console.log("✓ Target row verified (id=4231, mc_job_id=62088584, Apr 23, Whitfield street).\n");

  // Transaction
  console.log("--- UPDATE transaction ---");
  await db.execute(sql`BEGIN`);
  try {
    const res = await db.execute(sql`
      UPDATE jobs
         SET address_city  = 'Northbrook',
             address_state = 'IL',
             address_zip   = '60062'
       WHERE id = 4231
         AND company_id = 1
         AND mc_job_id = 62088584
    `);
    const n = res.rowCount ?? 0;
    console.log(`UPDATE rowcount: ${n} (expected 1)`);
    if (n !== 1) throw new Error(`rowcount mismatch: got ${n}, expected 1`);

    // In-transaction verify
    const check = await db.execute(sql`
      SELECT id, address_street, address_city, address_state, address_zip
        FROM jobs WHERE id = 4231
    `);
    console.log("In-transaction post-state:");
    console.table(check.rows);
    const r = (check.rows as any[])[0];
    if (r.address_city !== "Northbrook" || r.address_state !== "IL" || r.address_zip !== "60062") {
      throw new Error(`post-UPDATE state wrong: ${JSON.stringify(r)}`);
    }

    await db.execute(sql`COMMIT`);
    console.log("\n--- COMMIT OK ---");
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    console.error("\n--- ROLLBACK ---");
    console.error(err);
    process.exit(1);
  }

  console.log("\n=== Post-commit state ===");
  const post = await db.execute(sql`
    SELECT id, mc_job_id, scheduled_date, scheduled_time,
           address_street, address_city, address_state, address_zip
      FROM jobs WHERE id = 4231
  `);
  console.table(post.rows);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
