import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // Find ALL tables with FKs to jobs.id (broader scan so we don't hit another surprise)
  console.log("=== All FKs pointing to jobs.id ===");
  const fks = await db.execute(sql`
    SELECT
      tc.table_name,
      kcu.column_name,
      tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'jobs'
      AND ccu.column_name = 'id'
    ORDER BY tc.table_name
  `);
  console.table(fks.rows);

  // Count refs to 703 / 2081 across ALL those tables
  console.log("\n=== Ref counts to 703 / 2081 across every FK table ===");
  const results: Array<{ tbl: string; col: string; refs: number; ids: string }> = [];
  for (const fk of fks.rows as any[]) {
    const q = await db.execute(
      sql.raw(`SELECT COUNT(*)::int AS n
                 FROM "${fk.table_name}"
                WHERE "${fk.column_name}" IN (703, 2081)`)
    );
    const n = Number((q.rows?.[0] as any)?.n ?? 0);
    results.push({ tbl: fk.table_name, col: fk.column_name, refs: n, ids: "" });
  }
  console.table(results);

  // Show the quotes row in detail
  console.log("\n=== quotes row referencing job 2081 ===");
  const q = await db.execute(sql`
    SELECT * FROM quotes WHERE booked_job_id IN (703, 2081)
  `);
  console.log(q.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
