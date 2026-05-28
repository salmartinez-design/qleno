/**
 * AI.14 Apply — Arianna Goose (CL-0026 / clients.id=26)
 *
 * Confirmations from operator:
 *  1. State/zip use CASE WHEN known-bad-value pattern (state='IL', zip='14813').
 *  2. UPDATE recurring_schedules id=14 (Wed) and id=15 (Sat) in place. No INSERT.
 *  3. Backfill 43 rows / $6,880 expected net new in job_history.
 *  4. Notes tag '[manual_ai14 2026-04-28]'.
 *  5. Flat $160 — no retroactive pricing engine run.
 *
 * All steps wrapped in a single transaction. Idempotent — safe to re-run.
 */
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

const COMPANY_ID = 1;
const CLIENT_ID  = 26;
const ROSA_ID    = 36;
const TAG        = "[manual_ai14 2026-04-28]";
const WED_ANCHOR = "2025-01-08";
const SAT_ANCHOR = "2025-01-04";
const WINDOW_END = "2026-04-25";

async function main() {
  // Final guard: per-tenant flag must still be off before we touch schedules.
  const flag = await db.execute(sql`
    SELECT recurring_engine_enabled FROM companies WHERE id = ${COMPANY_ID}
  `);
  const enabled = (flag.rows[0] as any)?.recurring_engine_enabled;
  if (enabled !== false) {
    throw new Error(
      `ABORT: companies.recurring_engine_enabled for id=${COMPANY_ID} is ${enabled}, expected false`
    );
  }
  console.log(`[guard] recurring_engine_enabled=false for company ${COMPANY_ID}  OK`);

  await db.execute(sql`BEGIN`);
  try {
    // ── Step 1: Patch client row ─────────────────────────────────────────────
    const clientUpd = await db.execute(sql`
      UPDATE clients
         SET city  = COALESCE(city,  'Dyer'),
             state = CASE WHEN state IS NULL OR state = 'IL'    THEN 'IN'    ELSE state END,
             zip   = CASE WHEN zip   IS NULL OR zip   = '14813' THEN '46311' ELSE zip   END,
             address = COALESCE(address, '14813 West 101st Avenue'),
             client_type = 'commercial'
       WHERE id = ${CLIENT_ID} AND company_id = ${COMPANY_ID}
       RETURNING id, address, city, state, zip, client_type, first_name, last_name, email, phone
    `);
    console.log("[step1] client patched:");
    console.table(clientUpd.rows);

    // ── Step 2: UPDATE existing recurring_schedules in place ────────────────
    const wedSched = await db.execute(sql`
      UPDATE recurring_schedules
         SET day_of_week      = COALESCE(day_of_week, 'wednesday'),
             start_date       = LEAST(start_date, ${WED_ANCHOR}::date),
             duration_minutes = COALESCE(duration_minutes, 180)
       WHERE id = 14 AND customer_id = ${CLIENT_ID} AND company_id = ${COMPANY_ID}
       RETURNING id, day_of_week, start_date, duration_minutes, base_fee, assigned_employee_id, service_type, is_active
    `);
    const satSched = await db.execute(sql`
      UPDATE recurring_schedules
         SET day_of_week      = COALESCE(day_of_week, 'saturday'),
             start_date       = LEAST(start_date, ${SAT_ANCHOR}::date),
             duration_minutes = COALESCE(duration_minutes, 180)
       WHERE id = 15 AND customer_id = ${CLIENT_ID} AND company_id = ${COMPANY_ID}
       RETURNING id, day_of_week, start_date, duration_minutes, base_fee, assigned_employee_id, service_type, is_active
    `);
    console.log("[step2] schedules updated:");
    console.table([...(wedSched.rows as any[]), ...(satSched.rows as any[])]);

    // ── Step 3: Backfill job_history (idempotent NOT EXISTS dedup by date) ──
    // We insert from a generated series; rows where (customer_id, job_date)
    // already exists are skipped. Re-running this script is a no-op.
    const wedIns = await db.execute(sql`
      INSERT INTO job_history (company_id, customer_id, job_date, revenue, service_type, technician, notes)
      SELECT ${COMPANY_ID},
             ${CLIENT_ID},
             gs::date,
             160.00,
             'Commercial Cleaning',
             'Rosa Gallegos',
             ${TAG}
        FROM generate_series(${WED_ANCHOR}::date, ${WINDOW_END}::date, interval '7 days') AS gs
       WHERE NOT EXISTS (
               SELECT 1 FROM job_history jh
                WHERE jh.customer_id = ${CLIENT_ID}
                  AND jh.company_id  = ${COMPANY_ID}
                  AND jh.job_date    = gs::date
             )
      RETURNING job_date::text AS d
    `);

    const satIns = await db.execute(sql`
      INSERT INTO job_history (company_id, customer_id, job_date, revenue, service_type, technician, notes)
      SELECT ${COMPANY_ID},
             ${CLIENT_ID},
             gs::date,
             160.00,
             'Commercial Cleaning',
             'Rosa Gallegos',
             ${TAG}
        FROM generate_series(${SAT_ANCHOR}::date, ${WINDOW_END}::date, interval '7 days') AS gs
       WHERE NOT EXISTS (
               SELECT 1 FROM job_history jh
                WHERE jh.customer_id = ${CLIENT_ID}
                  AND jh.company_id  = ${COMPANY_ID}
                  AND jh.job_date    = gs::date
             )
      RETURNING job_date::text AS d
    `);

    const wedDates = (wedIns.rows as any[]).map(r => r.d).sort();
    const satDates = (satIns.rows as any[]).map(r => r.d).sort();
    console.log(`[step3] wed inserted: ${wedDates.length} -> ${JSON.stringify(wedDates)}`);
    console.log(`[step3] sat inserted: ${satDates.length}`);
    console.log(`         first 5: ${JSON.stringify(satDates.slice(0, 5))}`);
    console.log(`         last  5: ${JSON.stringify(satDates.slice(-5))}`);

    const insertedTotal = wedDates.length + satDates.length;
    if (insertedTotal !== 43) {
      console.warn(
        `[warn] inserted ${insertedTotal} rows; dry-run projected 43. ` +
        `If this is a fresh run, this is a problem. If it's a re-run after a partial apply, expect 0.`
      );
    }

    await db.execute(sql`COMMIT`);
    console.log("[tx] COMMIT");
  } catch (e) {
    await db.execute(sql`ROLLBACK`);
    console.error("[tx] ROLLBACK", e);
    process.exit(1);
  }

  // ── Step 4: Verification queries (printed after commit) ──────────────────
  console.log("\n========== STEP 4: VERIFICATION ==========\n");

  console.log("V1) clients id=26 (CL-0026):");
  const v1 = await db.execute(sql`
    SELECT id, first_name, last_name, address, city, state, zip,
           client_type, branch_id, is_active
    FROM clients WHERE id = ${CLIENT_ID} AND company_id = ${COMPANY_ID}
  `);
  console.table(v1.rows);

  console.log("\nV2) recurring_schedules for customer_id=26:");
  const v2 = await db.execute(sql`
    SELECT id, frequency, day_of_week, start_date, duration_minutes,
           base_fee, assigned_employee_id, service_type, is_active
    FROM recurring_schedules
    WHERE customer_id = ${CLIENT_ID} AND company_id = ${COMPANY_ID}
    ORDER BY id
  `);
  console.table(v2.rows);
  console.log(`   row count: ${v2.rows.length} (expected 2)`);

  console.log("\nV3) job_history rows tagged [manual_ai14]:");
  const v3 = await db.execute(sql`
    SELECT count(*)::int AS rows,
           COALESCE(SUM(revenue), 0)::numeric AS revenue,
           MIN(job_date)::text AS first_date,
           MAX(job_date)::text AS last_date
    FROM job_history
    WHERE customer_id = ${CLIENT_ID} AND company_id = ${COMPANY_ID}
      AND notes LIKE '%manual_ai14%'
  `);
  console.table(v3.rows);

  console.log("\nV4) job_history total for customer_id=26 (all sources):");
  const v4 = await db.execute(sql`
    SELECT count(*)::int AS rows,
           COALESCE(SUM(revenue), 0)::numeric AS revenue,
           MIN(job_date)::text AS first_date,
           MAX(job_date)::text AS last_date
    FROM job_history
    WHERE customer_id = ${CLIENT_ID} AND company_id = ${COMPANY_ID}
  `);
  console.table(v4.rows);

  console.log("\nV5) coverage breakdown by year (sanity check):");
  const v5 = await db.execute(sql`
    SELECT EXTRACT(YEAR FROM job_date)::int AS yr,
           count(*)::int AS rows,
           COALESCE(SUM(revenue), 0)::numeric AS revenue
    FROM job_history
    WHERE customer_id = ${CLIENT_ID} AND company_id = ${COMPANY_ID}
    GROUP BY 1 ORDER BY 1
  `);
  console.table(v5.rows);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
