/**
 * L4 — Phase 4 main transaction. Writes 983 rows to jobs + populates
 * job_technicians from staging.
 *
 * Schema corrections applied vs prompt's SQL:
 *   customer_id    → client_id
 *   service_address→ address_street (MC has single-line address)
 *   actual_start_time/end_time → folded into notes tag
 *   updated_at     → doesn't exist, omitted
 *   service_type   → REQUIRED, defaulting to 'standard_clean'
 *   frequency      → mapped from MC frequency using jobs.frequency enum
 *                    (includes 'every_3_weeks' which exists on this enum)
 *   job_technicians.company_id → REQUIRED, included
 *
 * Gates (transaction rolls back on any fail):
 *   1. jobs INSERT rowcount == 983
 *   2. job_technicians INSERT rowcount == 1092
 *   3. total PHES jobs == 1066 (83 pre-existing + 983 imported)
 *   4. Apr 22-30 day-by-day == MC ground truth
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const MC_EXPECTED_APR = [
  { date: "2026-04-22", jobs: 12, total: "2238.60" },
  { date: "2026-04-23", jobs: 14, total: "2900.25" },
  { date: "2026-04-24", jobs: 11, total: "2401.54" },
  { date: "2026-04-25", jobs:  4, total: "1062.00" },
  { date: "2026-04-27", jobs:  7, total: "1811.32" },
  { date: "2026-04-28", jobs: 11, total: "2042.33" },
  { date: "2026-04-29", jobs: 13, total: "2385.35" },
  { date: "2026-04-30", jobs: 11, total: "2312.68" },
];
const MC_EXPECTED_MONTHLY = [
  { month: "2026-01", rows: 232, total: "52218.71" },
  { month: "2026-02", rows: 216, total: "45643.27" },
  { month: "2026-03", rows: 258, total: "58108.14" },
  { month: "2026-04", rows: 277, total: "61563.26" },
];

async function main() {
  console.log("=== L4 Phase 4 — execute ===\n");

  // --- Pre-flight ---
  const pre = await db.execute(sql`
    SELECT COUNT(*)::int AS stg, (SELECT COUNT(*)::int FROM jobs WHERE company_id=1) AS jobs_before
      FROM mc_dispatch_staging
  `);
  console.log("Pre-flight:", pre.rows);

  await db.execute(sql`BEGIN`);
  try {
    // ========== STEP 4.3 — INSERT jobs ==========
    console.log("\n--- Step 4.3a: INSERT INTO jobs ---");
    const jobsInsert = await db.execute(sql`
      INSERT INTO jobs (
        mc_job_id,
        company_id,
        client_id,
        service_type,
        frequency,
        status,
        scheduled_date,
        scheduled_time,
        base_fee,
        recurring_schedule_id,
        assigned_user_id,
        estimated_hours,
        actual_hours,
        address_street,
        notes
      )
      SELECT
        s.mc_job_id,
        1,
        s.matched_customer_id,
        'standard_clean'::service_type,
        (CASE s.frequency
           WHEN 'Every Week'        THEN 'weekly'
           WHEN 'Every Two Weeks'   THEN 'biweekly'
           WHEN 'Every Four Weeks'  THEN 'monthly'
           WHEN 'Every Three Weeks' THEN 'every_3_weeks'
           ELSE 'on_demand'
         END)::frequency,
        s.mapped_status::job_status,
        s.scheduled_date,
        s.scheduled_time_start,
        s.bill_rate,
        s.matched_schedule_id,
        CASE WHEN JSONB_ARRAY_LENGTH(s.parsed_techs) > 0
             THEN (s.parsed_techs->>0)::int
             ELSE NULL END,
        s.alwd_hours,
        s.act_hours,
        s.address,
        ('[mc_import_phase4 2026-04-22 mc_job_id=' || s.mc_job_id
         || CASE WHEN s.act_start IS NOT NULL OR s.act_end IS NOT NULL
                 THEN ' act: ' || COALESCE(s.act_start,'?') || '-' || COALESCE(s.act_end,'?')
                 ELSE '' END
         || ']')
      FROM mc_dispatch_staging s
      ON CONFLICT (mc_job_id) WHERE mc_job_id IS NOT NULL
      DO UPDATE SET
        client_id = EXCLUDED.client_id,
        service_type = EXCLUDED.service_type,
        frequency = EXCLUDED.frequency,
        status = EXCLUDED.status,
        scheduled_date = EXCLUDED.scheduled_date,
        scheduled_time = EXCLUDED.scheduled_time,
        base_fee = EXCLUDED.base_fee,
        recurring_schedule_id = EXCLUDED.recurring_schedule_id,
        assigned_user_id = EXCLUDED.assigned_user_id,
        estimated_hours = EXCLUDED.estimated_hours,
        actual_hours = EXCLUDED.actual_hours,
        address_street = EXCLUDED.address_street,
        notes = EXCLUDED.notes
    `);
    console.log(`jobs INSERT rowcount: ${jobsInsert.rowCount} (expect 983)`);
    if (jobsInsert.rowCount !== 983) {
      throw new Error(`Gate 1 FAIL — jobs INSERT rowcount ${jobsInsert.rowCount}, expected 983`);
    }

    // ========== STEP 4.3b — INSERT job_technicians ==========
    console.log("\n--- Step 4.3b: INSERT INTO job_technicians ---");
    // WITH ORDINALITY gives position in the array → use it to set is_primary
    // for the first tech (matches jobs.assigned_user_id).
    const jtInsert = await db.execute(sql`
      INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
      SELECT
        j.id,
        (tech_id)::int,
        1,
        (idx = 1)
      FROM mc_dispatch_staging s
      JOIN jobs j ON j.mc_job_id = s.mc_job_id AND j.company_id = 1
      CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(s.parsed_techs) WITH ORDINALITY AS t(tech_id, idx)
      WHERE JSONB_ARRAY_LENGTH(s.parsed_techs) > 0
      ON CONFLICT (job_id, user_id) DO NOTHING
    `);
    console.log(`job_technicians INSERT rowcount: ${jtInsert.rowCount} (expect 1092)`);
    if (jtInsert.rowCount !== 1092) {
      throw new Error(`Gate 2 FAIL — job_technicians rowcount ${jtInsert.rowCount}, expected 1092`);
    }

    // ========== Gate 3 — total PHES jobs ==========
    console.log("\n--- Gate 3: PHES jobs total ---");
    const total = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM jobs WHERE company_id = 1
    `);
    const totalN = Number((total.rows?.[0] as any)?.n ?? 0);
    console.log(`PHES jobs total: ${totalN} (expect 1066)`);
    if (totalN !== 1066) {
      throw new Error(`Gate 3 FAIL — PHES total ${totalN}, expected 1066`);
    }

    // ========== Gate 4 — Apr 22-30 daily reconciliation ==========
    console.log("\n--- Gate 4: Apr 22-30 daily reconciliation (MC ground truth) ---");
    const apr = await db.execute(sql`
      SELECT scheduled_date::text AS date,
             COUNT(*)::int AS jobs,
             SUM(base_fee)::numeric(14,2)::text AS total
        FROM jobs
       WHERE company_id = 1
         AND scheduled_date BETWEEN '2026-04-22' AND '2026-04-30'
         AND mc_job_id IS NOT NULL
       GROUP BY scheduled_date
       ORDER BY scheduled_date
    `);
    console.table(apr.rows);

    const aprMap = new Map((apr.rows as any[]).map(r => [r.date, r]));
    let mismatch = 0;
    for (const e of MC_EXPECTED_APR) {
      const got = aprMap.get(e.date) as any;
      const gotJobs = got?.jobs ?? 0;
      const gotTotal = got?.total ?? "0.00";
      const ok = Number(gotJobs) === e.jobs && gotTotal === e.total;
      console.log(
        `  ${e.date}  MC=${e.jobs}j/$${e.total}  DB=${gotJobs}j/$${gotTotal}  ${ok ? "✓" : "✗"}`
      );
      if (!ok) mismatch++;
    }
    if (mismatch > 0) {
      throw new Error(`Gate 4 FAIL — ${mismatch} daily Apr 22-30 mismatches vs MC ground truth`);
    }

    console.log("\nAll 4 gates passed — COMMIT");
    await db.execute(sql`COMMIT`);
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    console.log("\n--- ROLLBACK ---");
    console.error(err);
    process.exit(1);
  }

  // ========== STEP 4.4 — post-commit reconciliation ==========
  console.log("\n=== STEP 4.4 — post-commit reconciliation ===\n");

  console.log("--- Monthly reconciliation (MC-imported rows only) ---");
  const monthly = await db.execute(sql`
    SELECT TO_CHAR(scheduled_date, 'YYYY-MM') AS month,
           COUNT(*)::int AS jobs,
           SUM(base_fee)::numeric(14,2)::text AS total
      FROM jobs
     WHERE company_id = 1
       AND mc_job_id IS NOT NULL
       AND scheduled_date BETWEEN '2026-01-01' AND '2026-04-30'
     GROUP BY 1 ORDER BY 1
  `);
  console.table(monthly.rows);
  const monthlyMap = new Map((monthly.rows as any[]).map(r => [r.month, r]));
  for (const e of MC_EXPECTED_MONTHLY) {
    const got = monthlyMap.get(e.month) as any;
    const ok = got?.jobs === e.rows && got?.total === e.total;
    console.log(`  ${e.month}  MC=${e.rows}/$${e.total}  DB=${got?.jobs ?? 0}/$${got?.total ?? 0}  ${ok ? "✓" : "✗"}`);
  }
  const monthlyTotal = await db.execute(sql`
    SELECT COUNT(*)::int AS n, SUM(base_fee)::numeric(14,2)::text AS total
      FROM jobs WHERE company_id=1 AND mc_job_id IS NOT NULL
  `);
  console.log(`TOTAL: ${(monthlyTotal.rows?.[0] as any)?.n} / $${(monthlyTotal.rows?.[0] as any)?.total}  (expect 983 / $217,533.38)`);

  console.log("\n--- Overall jobs state ---");
  const overall = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total_rows,
      COUNT(*) FILTER (WHERE mc_job_id IS NOT NULL)::int AS mc_imported,
      COUNT(*) FILTER (WHERE mc_job_id IS NULL)::int AS legacy_or_manual,
      COUNT(*) FILTER (WHERE status = 'complete')::int AS complete,
      COUNT(*) FILTER (WHERE status = 'scheduled')::int AS scheduled,
      COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
      COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
    FROM jobs WHERE company_id = 1
  `);
  console.table(overall.rows);

  console.log("\n--- job_technicians populated ---");
  const jtStats = await db.execute(sql`
    SELECT COUNT(*)::int AS total_assignments,
           COUNT(DISTINCT job_id)::int AS jobs_with_at_least_one_tech,
           COUNT(DISTINCT user_id)::int AS unique_techs
      FROM job_technicians jt
      JOIN jobs j ON j.id = jt.job_id
     WHERE j.company_id = 1 AND j.mc_job_id IS NOT NULL
  `);
  console.table(jtStats.rows);

  console.log("\n--- Per-tech job counts ---");
  const perTech = await db.execute(sql`
    SELECT jt.user_id,
           u.first_name || ' ' || u.last_name AS tech,
           u.is_active,
           COUNT(*)::int AS jobs
      FROM job_technicians jt
      JOIN jobs j ON j.id = jt.job_id
      JOIN users u ON u.id = jt.user_id
     WHERE j.company_id = 1 AND j.mc_job_id IS NOT NULL
     GROUP BY jt.user_id, u.first_name, u.last_name, u.is_active
     ORDER BY jobs DESC
  `);
  console.table(perTech.rows);

  console.log("\n--- Engine flag sanity ---");
  const flags = await db.execute(sql`
    SELECT id, name, recurring_engine_enabled FROM companies ORDER BY id
  `);
  console.table(flags.rows);

  console.log("\n✅ L4 complete.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
