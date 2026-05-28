/**
 * Phase A — hover card data-availability audit. READ-ONLY.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // ========== A.2 — job_history last_service per upcoming job's customer ==========
  console.log("=== A.2 — Last service per client (5 sample customers) ===");
  const a2 = await db.execute(sql`
    SELECT customer_id,
           MAX(job_date)::text AS last_service_date,
           COUNT(*)::int AS history_rows
      FROM job_history
     WHERE company_id = 1
       AND customer_id IN (
         SELECT DISTINCT client_id
           FROM jobs
          WHERE company_id = 1 AND scheduled_date >= '2026-04-22'
            AND client_id IS NOT NULL
          LIMIT 5
       )
     GROUP BY customer_id
     ORDER BY last_service_date DESC
  `);
  console.table(a2.rows);

  // Full coverage — how many upcoming-job clients have job_history entries
  console.log("\n=== A.2b — Coverage of last-service lookup for upcoming jobs ===");
  const a2b = await db.execute(sql`
    WITH upcoming AS (
      SELECT DISTINCT client_id
        FROM jobs
       WHERE company_id = 1
         AND scheduled_date >= '2026-04-22'
         AND client_id IS NOT NULL
    )
    SELECT
      COUNT(*)::int AS total_upcoming_clients,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM job_history jh
         WHERE jh.company_id=1 AND jh.customer_id = u.client_id
      ))::int AS with_history,
      COUNT(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM job_history jh
         WHERE jh.company_id=1 AND jh.customer_id = u.client_id
      ))::int AS no_history
    FROM upcoming u
  `);
  console.table(a2b.rows);

  // ========== A.3 — Entry instruction / notes fields ==========
  console.log("\n=== A.3 — clients: note/access/instruction-like columns ===");
  const a3cols = await db.execute(sql`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_name = 'clients' AND table_schema = 'public'
       AND (column_name LIKE '%note%' OR column_name LIKE '%memo%'
            OR column_name LIKE '%instruction%' OR column_name LIKE '%entry%'
            OR column_name LIKE '%access%' OR column_name LIKE '%lockbox%'
            OR column_name LIKE '%alarm%' OR column_name LIKE '%pet%')
     ORDER BY ordinal_position
  `);
  console.table(a3cols.rows);

  console.log("\n=== A.3b — jobs: note-like columns ===");
  const a3jobs = await db.execute(sql`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_name = 'jobs' AND table_schema = 'public'
       AND (column_name LIKE '%note%' OR column_name LIKE '%memo%')
     ORDER BY ordinal_position
  `);
  console.table(a3jobs.rows);

  console.log("\n=== A.3c — clients.notes + home_access_notes population ===");
  const a3pop = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE notes IS NOT NULL AND TRIM(notes) != '')::int AS with_notes,
      COUNT(*) FILTER (WHERE home_access_notes IS NOT NULL AND TRIM(home_access_notes) != '')::int AS with_home_access,
      COUNT(*) FILTER (WHERE alarm_code IS NOT NULL AND TRIM(alarm_code) != '')::int AS with_alarm,
      COUNT(*) FILTER (WHERE pets IS NOT NULL AND TRIM(pets) != '')::int AS with_pets
    FROM clients WHERE company_id = 1
  `);
  console.table(a3pop.rows);

  console.log("\n=== A.3d — clients with non-empty home_access_notes (sample 8) ===");
  const a3sample = await db.execute(sql`
    SELECT id,
           first_name || ' ' || last_name AS name,
           LEFT(home_access_notes, 120) AS home_access_preview,
           LEFT(COALESCE(notes,''), 60) AS notes_preview,
           LEFT(COALESCE(alarm_code,''), 20) AS alarm,
           LEFT(COALESCE(pets,''), 30) AS pets
      FROM clients
     WHERE company_id = 1
       AND (home_access_notes IS NOT NULL AND TRIM(home_access_notes) != '')
     LIMIT 8
  `);
  console.table(a3sample.rows);

  console.log("\n=== A.3e — jobs.notes / jobs.office_notes population for upcoming jobs ===");
  const a3jobsPop = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total_upcoming,
      COUNT(*) FILTER (WHERE notes IS NOT NULL AND TRIM(notes) != '')::int AS with_notes,
      COUNT(*) FILTER (WHERE office_notes IS NOT NULL AND TRIM(office_notes) != '')::int AS with_office_notes
    FROM jobs
    WHERE company_id = 1 AND scheduled_date >= '2026-04-22'
  `);
  console.table(a3jobsPop.rows);

  // ========== A.4 — Payment method fields ==========
  console.log("\n=== A.4 — clients: payment/card/stripe columns ===");
  const a4cols = await db.execute(sql`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_name = 'clients' AND table_schema = 'public'
       AND (column_name LIKE '%payment%' OR column_name LIKE '%stripe%'
            OR column_name LIKE '%square%' OR column_name LIKE '%card%'
            OR column_name LIKE '%billing%')
     ORDER BY ordinal_position
  `);
  console.table(a4cols.rows);

  console.log("\n=== A.4b — payment_source distribution ===");
  const a4src = await db.execute(sql`
    SELECT COALESCE(payment_source, '(null)') AS payment_source,
           COUNT(*)::int AS n
      FROM clients WHERE company_id = 1
     GROUP BY payment_source ORDER BY n DESC
  `);
  console.table(a4src.rows);

  console.log("\n=== A.4c — payment_method distribution ===");
  const a4m = await db.execute(sql`
    SELECT COALESCE(payment_method, '(null)') AS payment_method,
           COUNT(*)::int AS n
      FROM clients WHERE company_id = 1
     GROUP BY payment_method ORDER BY n DESC
  `);
  console.table(a4m.rows);

  console.log("\n=== A.4d — auto_charge / stripe_payment_method_id coverage ===");
  const a4auto = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE auto_charge = true)::int AS auto_charge_on,
      COUNT(*) FILTER (WHERE stripe_payment_method_id IS NOT NULL)::int AS stripe_pm_set,
      COUNT(*) FILTER (WHERE default_card_last_4 IS NOT NULL)::int AS card_last4_set,
      COUNT(*) FILTER (WHERE card_brand IS NOT NULL)::int AS card_brand_set
    FROM clients WHERE company_id = 1
  `);
  console.table(a4auto.rows);

  // ========== A.5 — Zone colors ==========
  console.log("\n=== A.5 — Zone colors + client counts ===");
  const a5 = await db.execute(sql`
    SELECT z.id, z.name, z.color,
           COUNT(DISTINCT c.id)::int AS clients_in_zone
      FROM service_zones z
      LEFT JOIN clients c ON c.zone_id = z.id AND c.company_id = 1
     WHERE z.company_id = 1
     GROUP BY z.id, z.name, z.color
     ORDER BY clients_in_zone DESC
     LIMIT 20
  `);
  console.table(a5.rows);

  console.log("\n=== A.5b — service_zones schema (show branch linkage if any) ===");
  const a5schema = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name = 'service_zones' AND table_schema = 'public'
     ORDER BY ordinal_position
  `);
  console.table(a5schema.rows);

  // ========== A.6 — Branch determination ==========
  console.log("\n=== A.6 — jobs.branch_id + branches table ===");
  const a6jobs = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE branch_id IS NOT NULL)::int AS with_branch_id,
      COUNT(*) FILTER (WHERE branch IS NOT NULL AND TRIM(branch) != '')::int AS with_branch_text
    FROM jobs WHERE company_id = 1
  `);
  console.log("jobs branch coverage:");
  console.table(a6jobs.rows);

  const a6branches = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name LIKE '%branch%'
  `);
  console.log("\nbranch-related tables:");
  console.table(a6branches.rows);

  const a6schema = await db.execute(sql`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'branches'
     ORDER BY ordinal_position
  `);
  if ((a6schema.rowCount ?? 0) > 0) {
    console.log("\nbranches table schema:");
    console.table(a6schema.rows);

    const a6list = await db.execute(sql`
      SELECT * FROM branches WHERE company_id = 1 ORDER BY id LIMIT 10
    `);
    console.log("\nbranches for PHES:");
    console.table(a6list.rows);
  }

  // ========== A.7 — Clock tables ==========
  console.log("\n=== A.7 — clock/geofence tables ===");
  const a7tables = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND (table_name LIKE '%clock%' OR table_name LIKE '%geofence%' OR table_name LIKE '%timeclock%')
     ORDER BY table_name
  `);
  console.table(a7tables.rows);

  console.log("\n=== A.7b — timeclock schema ===");
  const a7schema = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'timeclock'
     ORDER BY ordinal_position
  `);
  console.table(a7schema.rows);

  console.log("\n=== A.7c — Sample clock entries for recent jobs ===");
  const a7sample = await db.execute(sql`
    SELECT tc.id, tc.job_id, tc.user_id,
           tc.clock_in_at::text AS clock_in_at,
           tc.clock_out_at::text AS clock_out_at,
           tc.distance_from_job_ft::text AS distance_ft,
           tc.flagged
      FROM timeclock tc
      JOIN jobs j ON j.id = tc.job_id
     WHERE j.company_id = 1
       AND j.scheduled_date >= '2026-04-15'
     ORDER BY tc.id DESC
     LIMIT 10
  `);
  console.table(a7sample.rows);

  console.log("\n=== A.7d — Count of clock entries per status of MC-imported jobs ===");
  const a7coverage = await db.execute(sql`
    SELECT j.status::text,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM timeclock t WHERE t.job_id = j.id))::int AS jobs_with_clock,
           COUNT(*)::int AS total_jobs
      FROM jobs j
     WHERE j.company_id = 1 AND j.mc_job_id IS NOT NULL
     GROUP BY j.status
     ORDER BY total_jobs DESC
  `);
  console.table(a7coverage.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
