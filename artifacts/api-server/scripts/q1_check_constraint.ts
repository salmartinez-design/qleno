import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
async function main() {
  // Find the check constraint definition
  const check = await db.execute(sql`
    SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid = 'public.clients'::regclass
       AND contype = 'c'
  `);
  console.log("CHECK constraints on clients table:");
  console.table(check.rows);

  // Also list all constraints for completeness
  const all = await db.execute(sql`
    SELECT conname, contype::text, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid = 'public.clients'::regclass
     ORDER BY conname
  `);
  console.log("\nAll constraints on clients:");
  console.table(all.rows);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
