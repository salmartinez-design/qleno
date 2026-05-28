/**
 * L4 — Phase 4 schema probe + dry-run preview. READ-ONLY.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== 4.1a — jobs table schema ===");
  const jobsCols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'jobs' AND table_schema = 'public'
     ORDER BY ordinal_position
  `);
  console.table(jobsCols.rows);

  console.log("\n=== 4.1b — jobs required (NOT NULL, no default) columns ===");
  const jobsReq = await db.execute(sql`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_name = 'jobs' AND table_schema = 'public'
       AND is_nullable = 'NO' AND column_default IS NULL
     ORDER BY ordinal_position
  `);
  console.table(jobsReq.rows);

  console.log("\n=== 4.1c — job_technicians schema ===");
  const jtCols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'job_technicians' AND table_schema = 'public'
     ORDER BY ordinal_position
  `);
  console.table(jtCols.rows);

  console.log("\n=== 4.1d — job_technicians indexes/unique constraints ===");
  const jtIdx = await db.execute(sql`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'job_technicians'
  `);
  console.table(jtIdx.rows);

  console.log("\n=== 4.2a — INSERT vs UPDATE split ===");
  const splitPreview = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE j.mc_job_id IS NULL)::int AS will_insert,
      COUNT(*) FILTER (WHERE j.mc_job_id IS NOT NULL)::int AS will_update
      FROM mc_dispatch_staging s
      LEFT JOIN jobs j ON j.mc_job_id = s.mc_job_id AND j.company_id = 1
  `);
  console.table(splitPreview.rows);

  console.log("\n=== 4.2b — Monthly preview ===");
  const monthly = await db.execute(sql`
    SELECT TO_CHAR(scheduled_date, 'YYYY-MM') AS month,
           COUNT(*)::int AS staging_rows,
           SUM(bill_rate)::numeric(14,2) AS total_bill_rate
      FROM mc_dispatch_staging
     GROUP BY 1 ORDER BY 1
  `);
  console.table(monthly.rows);
  const monthlyTotal = await db.execute(sql`
    SELECT COUNT(*)::int AS n, SUM(bill_rate)::numeric(14,2) AS total
      FROM mc_dispatch_staging
  `);
  console.log("Total across all months:", monthlyTotal.rows);

  console.log("\n=== 4.2c — Apr 22-30 daily preview ===");
  const daily = await db.execute(sql`
    SELECT scheduled_date::text AS date,
           COUNT(*)::int AS jobs,
           SUM(bill_rate)::numeric(14,2) AS total
      FROM mc_dispatch_staging
     WHERE scheduled_date BETWEEN '2026-04-22' AND '2026-04-30'
     GROUP BY scheduled_date
     ORDER BY scheduled_date
  `);
  console.table(daily.rows);

  console.log("\n=== 4.2d — 5-row Apr 23 sample ===");
  const sample = await db.execute(sql`
    SELECT mc_job_id, scheduled_date::text AS scheduled_date,
           scheduled_time_start, matched_customer_id,
           matched_schedule_id, bill_rate, mapped_status, parsed_techs,
           team_raw, LEFT(COALESCE(address,''), 40) AS addr_head
      FROM mc_dispatch_staging
     WHERE scheduled_date = '2026-04-23'
     ORDER BY scheduled_time_start NULLS LAST, mc_job_id
     LIMIT 5
  `);
  console.table(sample.rows);

  console.log("\n=== 4.2e — Expected job_technicians row count ===");
  const techCount = await db.execute(sql`
    SELECT SUM(JSONB_ARRAY_LENGTH(parsed_techs))::int AS total_tech_assignments,
           COUNT(*) FILTER (WHERE JSONB_ARRAY_LENGTH(parsed_techs) > 0)::int AS jobs_with_tech,
           COUNT(*) FILTER (WHERE JSONB_ARRAY_LENGTH(parsed_techs) = 0)::int AS jobs_no_tech
      FROM mc_dispatch_staging
  `);
  console.table(techCount.rows);

  console.log("\n=== 4.2f — Tech ids that will be referenced (must all exist in users) ===");
  const techIds = await db.execute(sql`
    SELECT DISTINCT (tech_id)::int AS user_id
      FROM mc_dispatch_staging s,
           LATERAL JSONB_ARRAY_ELEMENTS_TEXT(s.parsed_techs) AS tech_id
      ORDER BY user_id
  `);
  const ids = (techIds.rows as any[]).map(r => r.user_id);
  console.log("Unique tech ids in staging:", ids);
  const verifyUsers = await db.execute(sql`
    SELECT id, first_name, last_name, is_active, role
      FROM users
     WHERE id = ANY(${ids}::int[])
     ORDER BY id
  `);
  console.table(verifyUsers.rows);
  const missing = ids.filter((x: number) => !(verifyUsers.rows as any[]).some(u => u.id === x));
  if (missing.length > 0) {
    console.log("!!! MISSING USER IDS:", missing);
  } else {
    console.log("All tech ids resolve to existing users. ✓");
  }

  console.log("\n=== 4.2g — Confirm all mc_job_id values are unique and present ===");
  const staging = await db.execute(sql`
    SELECT COUNT(*)::int AS total,
           COUNT(DISTINCT mc_job_id)::int AS unique_ids,
           COUNT(*) FILTER (WHERE mc_job_id IS NULL)::int AS null_ids
      FROM mc_dispatch_staging
  `);
  console.table(staging.rows);

  console.log("\n=== 4.2h — Column coverage map (what we need vs what staging has) ===");
  const coverage = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE matched_customer_id IS NOT NULL)::int AS has_customer,
      COUNT(*) FILTER (WHERE scheduled_date IS NOT NULL)::int AS has_date,
      COUNT(*) FILTER (WHERE mapped_status IS NOT NULL)::int AS has_status,
      COUNT(*) FILTER (WHERE bill_rate IS NOT NULL)::int AS has_bill_rate,
      COUNT(*) FILTER (WHERE bill_rate IS NULL)::int AS null_bill_rate,
      COUNT(*) FILTER (WHERE alwd_hours IS NOT NULL)::int AS has_alwd,
      COUNT(*) FILTER (WHERE act_hours IS NOT NULL)::int AS has_act_hrs,
      COUNT(*) FILTER (WHERE address IS NOT NULL)::int AS has_address
    FROM mc_dispatch_staging
  `);
  console.table(coverage.rows);

  // Look at rows with NULL bill_rate specifically
  const nullFee = await db.execute(sql`
    SELECT status_raw, COUNT(*)::int AS n
      FROM mc_dispatch_staging
     WHERE bill_rate IS NULL
     GROUP BY status_raw
  `);
  console.log("\nRows with NULL bill_rate (if any):");
  console.table(nullFee.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
