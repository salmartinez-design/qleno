import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== client_homes schema + Shannon rows ===\n");
  const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'client_homes'
     ORDER BY ordinal_position
  `);
  console.table(cols.rows);

  console.log("\n=== client_homes rows for Shannon (client_id=77) ===");
  const rows = await db.execute(sql`SELECT * FROM client_homes WHERE client_id = 77`);
  console.table(rows.rows);

  console.log("\n=== client_homes total coverage (how widely is it populated?) ===");
  const stats = await db.execute(sql`
    SELECT COUNT(*)::int AS total_rows,
           COUNT(DISTINCT client_id)::int AS distinct_clients
      FROM client_homes
  `);
  console.table(stats.rows);

  console.log("\n=== jobs.address_* usage across PHES (is the jobs-level address the real source of truth?) ===");
  const jobAddrCoverage = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total_jobs,
      COUNT(*) FILTER (WHERE address_street IS NOT NULL AND TRIM(address_street) != '')::int AS with_address_street,
      COUNT(*) FILTER (WHERE address_zip IS NOT NULL    AND TRIM(address_zip) != '')::int    AS with_address_zip,
      COUNT(*) FILTER (WHERE address_city IS NOT NULL   AND TRIM(address_city) != '')::int   AS with_address_city
    FROM jobs WHERE company_id = 1
  `);
  console.table(jobAddrCoverage.rows);

  // Does the dispatch endpoint already pull j.address_street? Probing 5 random Apr 23 rows to see:
  console.log("\n=== Sample Apr 23 jobs: do they have their own address_street (job-level) vs client address? ===");
  const sample = await db.execute(sql`
    SELECT j.id, c.first_name || ' ' || c.last_name AS client,
           LEFT(COALESCE(j.address_street, ''), 35) AS job_addr,
           LEFT(COALESCE(c.address, ''), 35)       AS client_addr,
           (TRIM(COALESCE(j.address_street,'')) != TRIM(COALESCE(c.address,''))) AS addrs_differ
      FROM jobs j JOIN clients c ON c.id = j.client_id
     WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
     ORDER BY c.id
  `);
  console.table(sample.rows);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
