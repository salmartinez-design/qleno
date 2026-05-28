import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // 1. For Apr 23 clients missing zip, what fields DO they have?
  console.log("=== Apr 23 clients — address fields (where zip=NULL) ===");
  const noZip = await db.execute(sql`
    SELECT DISTINCT
      c.id,
      c.first_name || ' ' || c.last_name AS name,
      c.zip AS client_zip,
      LEFT(COALESCE(c.address,''), 50) AS client_address,
      c.city AS client_city,
      c.state AS client_state,
      LEFT(COALESCE(j.address_street,''), 50) AS job_address_street,
      j.address_city AS job_city,
      j.address_state AS job_state,
      j.address_zip AS job_zip
    FROM jobs j
    LEFT JOIN clients c ON c.id = j.client_id
    WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
    ORDER BY c.id
  `);
  console.table(noZip.rows);

  // 2. Zip pattern in address text? We can extract via regex
  console.log("\n=== Extractable ZIP from address text? ===");
  const extract = await db.execute(sql`
    SELECT DISTINCT
      c.id,
      c.first_name || ' ' || c.last_name AS name,
      c.zip AS current_zip,
      SUBSTRING(COALESCE(c.address,'') FROM '\\y(\\d{5})\\y') AS extracted_from_address,
      SUBSTRING(COALESCE(j.address_street,'') FROM '\\y(\\d{5})\\y') AS extracted_from_job_addr
    FROM jobs j
    LEFT JOIN clients c ON c.id = j.client_id
    WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
      AND c.zip IS NULL
    ORDER BY c.id
  `);
  console.table(extract.rows);

  // 3. Check if the mc_dispatch_staging has address data with a zip for these jobs
  console.log("\n=== Staging address for Apr 23 jobs ===");
  const staging = await db.execute(sql`
    SELECT DISTINCT
      j.mc_job_id,
      j.client_id,
      c.first_name || ' ' || c.last_name AS name,
      c.zip AS current_client_zip,
      LEFT(mcs.address, 60) AS mc_address,
      SUBSTRING(COALESCE(mcs.address,'') FROM '\\y(\\d{5})\\y') AS mc_extracted_zip
    FROM jobs j
    LEFT JOIN clients c ON c.id = j.client_id
    LEFT JOIN mc_dispatch_staging mcs ON mcs.mc_job_id::bigint = j.mc_job_id
    WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
    ORDER BY c.id
  `);
  console.table(staging.rows);

  // 4. Zone zip coverage — what zip codes does the South Suburbs zone cover?
  // And Hickory Hills-area candidates?
  console.log("\n=== Active zones with zip_codes ===");
  const zones = await db.execute(sql`
    SELECT id, name, color, zip_codes
      FROM service_zones
     WHERE company_id = 1 AND is_active = true
     ORDER BY name
  `);
  console.log(JSON.stringify(zones.rows, null, 2));

  // 5. For PHES clients overall, what's the zip-source-availability breakdown?
  console.log("\n=== Full PHES client zip-source breakdown ===");
  const sources = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE zip IS NOT NULL AND TRIM(zip) != '')::int AS has_zip_col,
      COUNT(*) FILTER (WHERE zip IS NULL
                        AND address IS NOT NULL
                        AND address ~ '\\y\\d{5}\\y')::int AS null_zip_but_addr_has_pattern
    FROM clients WHERE company_id = 1
  `);
  console.table(sources.rows);

  // 6. Jobs.address_zip — is this ever populated for L4 rows?
  console.log("\n=== jobs.address_zip / address_city coverage for MC rows ===");
  const jobAddr = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total_mc,
      COUNT(*) FILTER (WHERE address_zip IS NOT NULL AND TRIM(address_zip) != '')::int AS with_addr_zip,
      COUNT(*) FILTER (WHERE address_city IS NOT NULL AND TRIM(address_city) != '')::int AS with_addr_city,
      COUNT(*) FILTER (WHERE address_street ~ '\\y\\d{5}\\y')::int AS addr_street_has_zip_pattern
    FROM jobs WHERE company_id = 1 AND mc_job_id IS NOT NULL
  `);
  console.table(jobAddr.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
