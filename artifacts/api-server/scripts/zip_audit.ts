/**
 * Audit zip coverage and zone derivation success.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // 1. clients.zip coverage overall
  console.log("=== clients.zip coverage (all PHES clients) ===");
  const overall = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE zip IS NOT NULL AND TRIM(zip) != '')::int AS with_zip,
      COUNT(*) FILTER (WHERE zip IS NULL OR TRIM(zip) = '')::int AS no_zip
    FROM clients WHERE company_id = 1
  `);
  console.table(overall.rows);

  // 2. For upcoming-job clients specifically
  console.log("\n=== Upcoming-job clients (scheduled_date >= today) ===");
  const upcoming = await db.execute(sql`
    WITH upcoming_clients AS (
      SELECT DISTINCT j.client_id
        FROM jobs j
       WHERE j.company_id = 1 AND j.scheduled_date >= CURRENT_DATE
         AND j.client_id IS NOT NULL
    )
    SELECT
      COUNT(*)::int AS total_upcoming_clients,
      COUNT(*) FILTER (WHERE c.zip IS NOT NULL AND TRIM(c.zip) != '')::int AS with_zip,
      COUNT(*) FILTER (WHERE c.zip IS NULL OR TRIM(c.zip) = '')::int AS no_zip
    FROM upcoming_clients u
    LEFT JOIN clients c ON c.id = u.client_id
  `);
  console.table(upcoming.rows);

  // 3. Of the zip-populated clients, how many resolve to a zone?
  console.log("\n=== Zone-derivation success: zip→service_zones.zip_codes match ===");
  const zoneSuccess = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total_with_zip,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM service_zones z
         WHERE z.company_id = 1 AND z.is_active = true
           AND c.zip = ANY(z.zip_codes)
      ))::int AS zip_matches_zone,
      COUNT(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM service_zones z
         WHERE z.company_id = 1 AND z.is_active = true
           AND c.zip = ANY(z.zip_codes)
      ))::int AS zip_no_zone_match
    FROM clients c
    WHERE c.company_id = 1
      AND c.zip IS NOT NULL AND TRIM(c.zip) != ''
  `);
  console.table(zoneSuccess.rows);

  // 4. Sample zips from upcoming clients
  console.log("\n=== Sample: upcoming jobs with zip (first 15) ===");
  const sample = await db.execute(sql`
    SELECT DISTINCT
      c.id, c.first_name || ' ' || c.last_name AS name,
      c.zip,
      (SELECT z.name FROM service_zones z
         WHERE z.company_id = 1 AND z.is_active = true
           AND c.zip = ANY(z.zip_codes) LIMIT 1) AS derived_zone
    FROM jobs j
    JOIN clients c ON c.id = j.client_id
    WHERE j.company_id = 1 AND j.scheduled_date >= CURRENT_DATE
    ORDER BY c.zip NULLS LAST, c.id
    LIMIT 15
  `);
  console.table(sample.rows);

  // 5. What zips are in our upcoming cohort and do they map to zones?
  console.log("\n=== Distinct zips in upcoming job cohort ===");
  const zips = await db.execute(sql`
    SELECT c.zip, COUNT(DISTINCT c.id)::int AS clients,
           (SELECT z.name FROM service_zones z
              WHERE z.company_id = 1 AND z.is_active = true
                AND c.zip = ANY(z.zip_codes) LIMIT 1) AS zone_name
    FROM jobs j
    JOIN clients c ON c.id = j.client_id
    WHERE j.company_id = 1 AND j.scheduled_date >= CURRENT_DATE
      AND c.zip IS NOT NULL AND TRIM(c.zip) != ''
    GROUP BY c.zip
    ORDER BY clients DESC, c.zip
    LIMIT 20
  `);
  console.table(zips.rows);

  // 6. Do we have MC address strings that might contain zip we could extract?
  console.log("\n=== MC staging address tail — does it contain a ZIP pattern? ===");
  const stagingAddr = await db.execute(sql`
    SELECT customer_name, address
      FROM mc_dispatch_staging
     WHERE address IS NOT NULL
     ORDER BY mc_job_id
     LIMIT 10
  `);
  console.table(stagingAddr.rows);

  // 7. Any trailing-zip pattern in existing clients.address text?
  console.log("\n=== Clients with zip pattern in address text (alternative source) ===");
  const addrZip = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total_with_address,
      COUNT(*) FILTER (WHERE address ~ '\\y\\d{5}(-\\d{4})?\\y')::int AS address_has_zip_pattern,
      COUNT(*) FILTER (WHERE zip IS NULL OR TRIM(zip) = '')::int AS zip_col_null,
      COUNT(*) FILTER (WHERE (zip IS NULL OR TRIM(zip) = '')
                           AND address ~ '\\y\\d{5}(-\\d{4})?\\y')::int AS null_zip_but_address_has_pattern
    FROM clients
    WHERE company_id = 1 AND address IS NOT NULL
  `);
  console.table(addrZip.rows);

  // 8. Total zones + their zip_codes count + clients they'd cover if we had all zips
  console.log("\n=== Service zones — active w/ zip_codes ===");
  const zonesZips = await db.execute(sql`
    SELECT z.id, z.name, ARRAY_LENGTH(z.zip_codes, 1)::int AS zip_count, z.color
      FROM service_zones z
     WHERE z.company_id = 1 AND z.is_active = true
     ORDER BY zip_count DESC NULLS LAST
  `);
  console.table(zonesZips.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
