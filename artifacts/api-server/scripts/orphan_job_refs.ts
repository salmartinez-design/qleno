import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // 1. Show the 2 orphan rows. Note: clients has first_name/last_name, not name.
  console.log("=== Orphan jobs 703, 2081 ===");
  const jobs = await db.execute(sql`
    SELECT j.id,
           c.first_name || ' ' || c.last_name AS client_name,
           j.scheduled_time,
           j.base_fee::text AS base_fee,
           j.status::text AS status,
           j.recurring_schedule_id,
           j.assigned_user_id,
           j.created_at::text AS created_at,
           LEFT(COALESCE(j.notes,''), 100) AS notes_preview
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
     WHERE j.id IN (703, 2081)
     ORDER BY j.id
  `);
  console.table(jobs.rows);

  // 2. Detect which reference tables actually exist in this schema
  console.log("\n=== Reference tables present in schema ===");
  const tables = await db.execute(sql`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN (
         'timeclock', 'timeclock_entries',
         'additional_pay',
         'commissions',
         'job_technicians', 'job_photos',
         'invoices', 'notifications'
       )
     ORDER BY table_name
  `);
  console.table(tables.rows);

  // 3. Count references per-table (defensive — check each before query)
  const present = new Set((tables.rows as any[]).map(r => r.table_name));

  const candidates: Array<{ tbl: string; col: string }> = [
    { tbl: "timeclock",        col: "job_id" },
    { tbl: "additional_pay",   col: "job_id" },
    { tbl: "commissions",      col: "job_id" },
    { tbl: "job_technicians",  col: "job_id" },
    { tbl: "job_photos",       col: "job_id" },
    { tbl: "invoices",         col: "job_id" },
  ];

  console.log("\n=== Reference counts for job_id IN (703, 2081) ===");
  const results: Array<{ tbl: string; count: number; note: string }> = [];
  for (const c of candidates) {
    if (!present.has(c.tbl)) {
      results.push({ tbl: c.tbl, count: 0, note: "TABLE NOT PRESENT" });
      continue;
    }
    // Confirm the column exists
    const hasCol = await db.execute(sql`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name = ${c.tbl} AND column_name = ${c.col}
    `);
    if ((hasCol.rowCount ?? 0) === 0) {
      results.push({ tbl: c.tbl, count: 0, note: `no column ${c.col}` });
      continue;
    }
    const q = await db.execute(sql.raw(`SELECT COUNT(*)::int AS n FROM "${c.tbl}" WHERE "${c.col}" IN (703, 2081)`));
    const n = Number((q.rows?.[0] as any)?.n ?? 0);
    results.push({ tbl: c.tbl, count: n, note: n > 0 ? "HAS REFS" : "clean" });
  }
  console.table(results);

  // 4. Show any actual reference rows for the tables that have refs
  for (const r of results.filter(r => r.count > 0)) {
    console.log(`\n=== Detail: ${r.tbl} rows referencing 703 / 2081 ===`);
    const detail = await db.execute(sql.raw(`SELECT * FROM "${r.tbl}" WHERE "job_id" IN (703, 2081)`));
    console.log(detail.rows);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
