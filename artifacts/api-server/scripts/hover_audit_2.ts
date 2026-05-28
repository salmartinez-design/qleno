import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // Sample jobs.notes content to see if it's the MC import tag or real content
  console.log("=== jobs.notes sample for upcoming jobs ===");
  const notesSample = await db.execute(sql`
    SELECT id, mc_job_id, LEFT(COALESCE(notes,''), 120) AS notes_preview,
           CASE
             WHEN notes LIKE '%mc_import_phase4%' THEN 'mc_import_tag'
             WHEN notes IS NULL OR TRIM(notes) = '' THEN 'empty'
             ELSE 'real_content'
           END AS kind
      FROM jobs
     WHERE company_id = 1 AND scheduled_date >= '2026-04-22'
     ORDER BY id
     LIMIT 15
  `);
  console.table(notesSample.rows);

  // Categorize upcoming job notes by kind
  const notesKind = await db.execute(sql`
    SELECT
      CASE
        WHEN notes IS NULL OR TRIM(notes) = '' THEN 'empty'
        WHEN notes LIKE '%mc_import_phase4%' AND LENGTH(notes) < 80 THEN 'mc_import_tag_only'
        WHEN notes LIKE '%mc_import_phase4%' THEN 'mc_import_tag_plus_content'
        ELSE 'real_content'
      END AS kind,
      COUNT(*)::int AS n
    FROM jobs
    WHERE company_id = 1 AND scheduled_date >= '2026-04-22'
    GROUP BY kind
    ORDER BY n DESC
  `);
  console.log("\nUpcoming jobs notes categorization:");
  console.table(notesKind.rows);

  // Sample a job row with all hover-card-relevant fields
  console.log("\n=== Full row sample (first upcoming PHES job) ===");
  const full = await db.execute(sql`
    SELECT j.id, j.mc_job_id, j.client_id, j.scheduled_date::text AS scheduled_date,
           j.scheduled_time, j.base_fee::text AS base_fee, j.status,
           j.assigned_user_id, j.estimated_hours::text AS estimated_hours,
           j.actual_hours::text AS actual_hours, j.allowed_hours::text AS allowed_hours,
           j.address_street, j.zone_id, j.branch_id,
           LEFT(COALESCE(j.notes,''), 100) AS notes,
           c.first_name || ' ' || c.last_name AS client_name,
           c.phone AS client_phone,
           c.address AS client_address,
           c.city, c.zip,
           c.zone_id AS client_zone_id,
           z.name AS zone_name,
           z.color AS zone_color,
           b.name AS branch_name
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN service_zones z ON z.id = j.zone_id
      LEFT JOIN branches b ON b.id = j.branch_id
     WHERE j.company_id = 1 AND j.scheduled_date >= '2026-04-22'
     ORDER BY j.scheduled_date, j.id
     LIMIT 3
  `);
  console.log(full.rows);

  // zone_id coverage on jobs
  console.log("\n=== jobs.zone_id vs clients.zone_id coverage ===");
  const zoneCov = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total_jobs,
      COUNT(*) FILTER (WHERE j.zone_id IS NOT NULL)::int AS jobs_with_zone,
      COUNT(*) FILTER (WHERE c.zone_id IS NOT NULL)::int AS clients_with_zone,
      COUNT(*) FILTER (WHERE j.zone_id IS NULL AND c.zone_id IS NOT NULL)::int AS client_zone_but_no_job_zone
    FROM jobs j
    LEFT JOIN clients c ON c.id = j.client_id
    WHERE j.company_id = 1 AND j.scheduled_date >= '2026-04-22'
  `);
  console.table(zoneCov.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
