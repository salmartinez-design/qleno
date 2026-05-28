import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // Schema probe for clients table
  const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'clients' AND table_schema = 'public'
     ORDER BY ordinal_position
  `);
  console.log("clients columns:");
  console.table(cols.rows);

  // Check which specifically matter
  const check = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name='clients' AND table_schema='public'
       AND column_name IN ('migration_source','updated_at','created_at','is_active','client_type','source')
  `);
  console.log("\nInteresting columns present:");
  console.table(check.rows);

  // Inspect client id=22 current state
  const c22 = await db.execute(sql`
    SELECT * FROM clients WHERE id = 22
  `);
  console.log("\nClient id=22 row:");
  console.log(c22.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
