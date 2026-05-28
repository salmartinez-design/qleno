/**
 * AD — Read-only audit of Shannon Heidloff's client record + Apr 23 job.
 * No writes. Reports on:
 *   1. Shannon's client row(s)
 *   2. Whether schema supports multi-address per client (separate table? column on job?)
 *   3. Today's job — which address is it using?
 *   4. Historical jobs — any different addresses in use?
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== AD — Shannon Heidloff read-only audit ===\n");

  // 1. Shannon's client row(s)
  console.log("--- 1. clients row(s) matching Shannon / Heidloff ---");
  const client = await db.execute(sql`
    SELECT id, first_name, last_name, phone, email, address, city, state, zip, is_active,
           LEFT(COALESCE(notes, ''), 200) AS notes_preview
      FROM clients
     WHERE company_id = 1
       AND (first_name ILIKE 'shannon%' OR last_name ILIKE 'heidloff%')
     ORDER BY id
  `);
  console.table(client.rows);

  // 2. Address-related tables in the schema
  console.log("\n--- 2a. All schema tables with 'address' in the name ---");
  const addrTables = await db.execute(sql`
    SELECT table_schema, table_name
      FROM information_schema.tables
     WHERE table_schema IN ('public')
       AND (table_name ILIKE '%address%' OR table_name ILIKE '%location%')
     ORDER BY table_name
  `);
  console.table(addrTables.rows);

  // 2b. Any table with a client_id FK that could be a multi-address store?
  console.log("\n--- 2b. Tables with a client_id column (possible multi-address stores) ---");
  const clientFkTables = await db.execute(sql`
    SELECT table_schema, table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND column_name = 'client_id'
     ORDER BY table_name
  `);
  console.table(clientFkTables.rows);

  // 3. clients table structure — all columns (so we see what address-like fields exist)
  console.log("\n--- 3. clients table columns ---");
  const clientCols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'clients'
     ORDER BY ordinal_position
  `);
  console.table(clientCols.rows);

  // 4. jobs table columns with "address" in the name (overrides?)
  console.log("\n--- 4. jobs columns with 'address' in the name ---");
  const jobAddrCols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'jobs'
       AND column_name ILIKE '%address%'
     ORDER BY ordinal_position
  `);
  console.table(jobAddrCols.rows);

  // 5. Shannon's Apr 23 job — which address is it using?
  console.log("\n--- 5. Shannon's Apr 23 job: address state ---");
  const apr23Job = await db.execute(sql`
    SELECT j.id AS job_id, j.mc_job_id, j.scheduled_date, j.scheduled_time,
           j.address_street, j.address_city, j.address_state, j.address_zip,
           c.id AS client_id,
           c.first_name || ' ' || c.last_name AS client_name,
           c.address AS client_address,
           c.city    AS client_city,
           c.state   AS client_state,
           c.zip     AS client_zip
      FROM jobs j
      JOIN clients c ON c.id = j.client_id
     WHERE c.company_id = 1
       AND (c.first_name ILIKE 'shannon%' OR c.last_name ILIKE 'heidloff%')
       AND j.scheduled_date = '2026-04-23'
     ORDER BY j.scheduled_time
  `);
  console.table(apr23Job.rows);

  // 6. Historical — all Shannon jobs, address-per-job
  console.log("\n--- 6. Shannon's job history — distinct addresses used ---");
  const history = await db.execute(sql`
    SELECT j.scheduled_date, j.scheduled_time,
           j.address_street, j.address_city, j.address_zip,
           j.mc_job_id, j.status
      FROM jobs j
      JOIN clients c ON c.id = j.client_id
     WHERE c.company_id = 1
       AND (c.first_name ILIKE 'shannon%' OR c.last_name ILIKE 'heidloff%')
     ORDER BY j.scheduled_date DESC, j.scheduled_time DESC
     LIMIT 25
  `);
  console.table(history.rows);

  // 7. Distinct addresses across all Shannon's jobs — frequency count
  console.log("\n--- 7. Distinct addresses across Shannon's jobs (with counts) ---");
  const distinct = await db.execute(sql`
    SELECT TRIM(COALESCE(j.address_street, '')) AS street,
           TRIM(COALESCE(j.address_city, ''))   AS city,
           TRIM(COALESCE(j.address_zip, ''))    AS zip,
           COUNT(*)::int AS n_jobs,
           MIN(j.scheduled_date) AS first_seen,
           MAX(j.scheduled_date) AS last_seen
      FROM jobs j
      JOIN clients c ON c.id = j.client_id
     WHERE c.company_id = 1
       AND (c.first_name ILIKE 'shannon%' OR c.last_name ILIKE 'heidloff%')
     GROUP BY 1, 2, 3
     ORDER BY n_jobs DESC
  `);
  console.table(distinct.rows);

  // 8. Is there a mc_dispatch_staging row that shows what MC exported for this job?
  console.log("\n--- 8. MC staging row for Shannon's Apr 23 job (source-of-truth address) ---");
  const staging = await db.execute(sql`
    SELECT mcs.mc_job_id, mcs.scheduled_date,
           LEFT(COALESCE(mcs.address, ''), 80) AS mc_address,
           mcs.customer_name
      FROM jobs j
      JOIN clients c ON c.id = j.client_id
      LEFT JOIN mc_dispatch_staging mcs ON mcs.mc_job_id::bigint = j.mc_job_id
     WHERE c.company_id = 1
       AND (c.first_name ILIKE 'shannon%' OR c.last_name ILIKE 'heidloff%')
       AND j.scheduled_date = '2026-04-23'
  `);
  console.table(staging.rows);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
