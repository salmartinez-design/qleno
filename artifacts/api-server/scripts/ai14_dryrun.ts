/**
 * AI.14 Dry-Run — Arianna Goose (CL-0026 / clients.id=26) backfill audit
 * READ-ONLY. No INSERT/UPDATE/DELETE.
 */
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

const COMPANY_ID = 1; // PHES
const CLIENT_ID = 26; // CL-0026 → Arianna Goose
const WINDOW_END = "2026-04-25"; // last Saturday before 2026-04-28
const WED_ANCHOR = "2025-01-08";
const SAT_ANCHOR = "2025-01-04";

async function main() {
  const existing = await db.execute(sql`
    SELECT job_date::text AS d, revenue::text AS rev,
           service_type, technician, notes
    FROM job_history
    WHERE customer_id = ${CLIENT_ID} AND company_id = ${COMPANY_ID}
    ORDER BY job_date
  `);
  const existingByDate = new Map<string, any>();
  for (const r of existing.rows as any[]) existingByDate.set(r.d, r);

  const ai14Tagged = (existing.rows as any[]).filter(r =>
    typeof r.notes === "string" && r.notes.toLowerCase().includes("manual_ai14")
  );

  const wedDates = await db.execute(sql`
    SELECT generate_series(${WED_ANCHOR}::date, ${WINDOW_END}::date, interval '7 days')::date::text AS d
  `);
  const satDates = await db.execute(sql`
    SELECT generate_series(${SAT_ANCHOR}::date, ${WINDOW_END}::date, interval '7 days')::date::text AS d
  `);

  const wedAll = (wedDates.rows as any[]).map(r => r.d);
  const satAll = (satDates.rows as any[]).map(r => r.d);

  const wedExists = wedAll.filter(d => existingByDate.has(d));
  const satExists = satAll.filter(d => existingByDate.has(d));
  const wedAdd = wedAll.filter(d => !existingByDate.has(d));
  const satAdd = satAll.filter(d => !existingByDate.has(d));

  const targetSet = new Set([...wedAll, ...satAll]);
  const offCadence = (existing.rows as any[])
    .filter(r => !targetSet.has(r.d))
    .map(r => ({ d: r.d, rev: r.rev, svc: r.service_type, notes: (r.notes ?? "").slice(0, 60) }));

  const head = (a: string[]) => a.slice(0, 5);
  const tail = (a: string[]) => a.slice(-5);

  console.log("─────────── AI.14 BACKFILL DELTA ───────────");
  console.log("Existing job_history rows for CL-0026:", existing.rows.length);
  console.log("Rows already tagged [manual_ai14]:    ", ai14Tagged.length);
  console.log("");
  console.log("WED series (anchor 2025-01-08, weekly through 2026-04-22):");
  console.log("  total occurrences:    ", wedAll.length);
  console.log("  already in history:   ", wedExists.length);
  console.log("  WOULD INSERT:         ", wedAdd.length);
  console.log("  first 5 to insert:    ", head(wedAdd));
  console.log("  last  5 to insert:    ", tail(wedAdd));
  console.log("");
  console.log("SAT series (anchor 2025-01-04, weekly through 2026-04-25):");
  console.log("  total occurrences:    ", satAll.length);
  console.log("  already in history:   ", satExists.length);
  console.log("  WOULD INSERT:         ", satAdd.length);
  console.log("  first 5 to insert:    ", head(satAdd));
  console.log("  last  5 to insert:    ", tail(satAdd));
  console.log("");
  console.log("Existing dates NOT on Wed-08 or Sat-04 cadence (will be left alone):");
  console.log("  count:                ", offCadence.length);
  console.table(offCadence.slice(0, 30));
  console.log("");
  const projected = (wedAdd.length + satAdd.length) * 160;
  console.log("PROJECTED RESULT IF APPLIED:");
  console.log("  rows added:           ", wedAdd.length + satAdd.length);
  console.log("  $ added:              $" + projected.toFixed(2));
  console.log("  ending row count:     ", existing.rows.length + wedAdd.length + satAdd.length);
  console.log("  ending revenue:       $" + (15230 + projected).toFixed(2));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
