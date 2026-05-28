import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // 1. Find any business-hours-shaped columns on companies
  console.log("=== companies columns (business/hours/dispatch) ===");
  const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name = 'companies' AND table_schema = 'public'
       AND (column_name LIKE '%hour%' OR column_name LIKE '%business%'
            OR column_name LIKE '%schedule%' OR column_name LIKE '%day%'
            OR column_name LIKE '%dispatch%')
     ORDER BY ordinal_position
  `);
  console.table(cols.rows);

  // 2. Full PHES company row — see what's actually populated
  console.log("\n=== PHES company row (company_id=1) ===");
  const phes = await db.execute(sql`SELECT * FROM companies WHERE id = 1`);
  console.log(phes.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
