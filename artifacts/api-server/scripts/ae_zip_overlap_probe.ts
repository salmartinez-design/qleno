import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  const r = await db.execute(sql`
    SELECT name, zip_codes,
           array_length(zip_codes, 1) AS n,
           ARRAY(SELECT unnest(zip_codes) INTERSECT
                 SELECT unnest(ARRAY['60062','60025','60026','60091','60093','60015','60035'])) AS overlap_with_proposed
      FROM service_zones
     WHERE company_id = 1
       AND (zip_codes && ARRAY['60062','60025','60026','60091','60093','60015','60035']
            OR name IN ('North Shore','Chicago North Residential Zone'))
  `);
  for (const row of r.rows as any[]) {
    console.log(`\n${row.name} (${row.n} zips)`);
    console.log(`  zip_codes: [${(row.zip_codes as string[]).join(", ")}]`);
    console.log(`  overlap with proposed North Shore zips: [${(row.overlap_with_proposed as string[]).join(", ")}]`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
