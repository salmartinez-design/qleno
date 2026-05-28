import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== jobs columns (db truth) ===");
  const jc = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema='public' AND table_name='jobs'
       AND (column_name ILIKE '%complet%' OR column_name ILIKE '%end%'
            OR column_name ILIKE '%lock%' OR column_name ILIKE '%finish%')
     ORDER BY ordinal_position
  `);
  console.table(jc.rows);

  console.log("\n=== Tables that look QB/queue related ===");
  const t = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema='public'
       AND (table_name ILIKE '%qb%' OR table_name ILIKE '%quickbooks%'
            OR table_name ILIKE '%sync%' OR table_name ILIKE '%queue%')
     ORDER BY table_name
  `);
  console.table(t.rows);

  console.log("\n=== qb_tokens columns ===");
  const qt = await db.execute(sql`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name='qb_tokens'
     ORDER BY ordinal_position
  `);
  console.table(qt.rows);

  console.log("\n=== job_technicians columns ===");
  const jt = await db.execute(sql`
    SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema='public' AND table_name='job_technicians'
     ORDER BY ordinal_position
  `);
  console.table(jt.rows);

  console.log("\n=== timeclock_entries (clock-in probe) ===");
  const te = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND (table_name ILIKE '%clock%' OR table_name ILIKE '%time%')
     ORDER BY table_name
  `);
  console.table(te.rows);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
