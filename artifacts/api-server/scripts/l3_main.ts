/**
 * L3 — MC dispatch Phase 3.
 *   3.2  Schedule linking   (UPDATE matched_schedule_id)
 *   3.3  Tech parsing       (UPDATE parsed_techs JSONB)
 *   3.4  Status mapping     (UPDATE mapped_status)
 *   3.5  Final integrity + April 22-30 reconciliation
 *
 * Writes only to mc_dispatch_staging. jobs / recurring_schedules / clients
 * are read-only here.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Known tech roster — MC name form on left, Qleno users.id on right.
// Sorted DESC by name length for greedy prefix matching in the parser.
const TECHS: Array<{ name: string; userId: number | null }> = [
  { name: "Norma Guerrero Puga", userId: 32 }, // DB has "Norma Puga" id=32
  { name: "Alejandra Cuervo",    userId: 41 },
  { name: "Guadalupe Mejia",     userId: 40 },
  { name: "Tatiana Merchan",     userId: 33 },
  { name: "Delia Martinez",      userId: null }, // not in users — drop like Cleaner
  { name: "Juliana Loredo",      userId: 42 },
  { name: "Diana Vasquez",       userId: 38 },
  { name: "Rosa Gallegos",       userId: 36 },
  { name: "Alma Salinas",        userId: 39 },
  { name: "Juan Salazar",        userId: 43 },
  { name: "Norma Puga",          userId: 32 }, // short form fallback (none in data, but safe)
  { name: "Ana Valdez",          userId: 34 },
];
const PLACEHOLDER = "Cleaner";

function parseTeam(raw: string | null): { ids: number[]; unparsed: string | null } {
  if (!raw) return { ids: [], unparsed: null };
  let remaining = raw.trim().replace(/\s+/g, " ");
  const ids: number[] = [];
  const sorted = [...TECHS].sort((a, b) => b.name.length - a.name.length);
  while (remaining.length > 0) {
    let matched = false;
    for (const t of sorted) {
      if (remaining === t.name || remaining.startsWith(t.name + " ")) {
        if (t.userId != null) ids.push(t.userId);
        remaining = remaining.slice(t.name.length).trim();
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (remaining === PLACEHOLDER || remaining.startsWith(PLACEHOLDER + " ")) {
      remaining = remaining.slice(PLACEHOLDER.length).trim();
      continue;
    }
    return { ids, unparsed: remaining };
  }
  return { ids, unparsed: null };
}

async function step3_2_linkSchedules() {
  console.log("\n=== 3.2 — Schedule linking ===");
  // MC freq → Qleno freq. Qleno enum = {weekly, biweekly, monthly, custom}.
  // "Every Three Weeks" → custom (no triweekly enum).
  // "Other Recurring" → custom.
  // "Single" / "On Demand" → NULL (no link).
  await db.execute(sql`BEGIN`);
  try {
    const res = await db.execute(sql`
      UPDATE mc_dispatch_staging s
         SET matched_schedule_id = sub.schedule_id
        FROM (
          SELECT DISTINCT ON (st.mc_job_id)
                 st.mc_job_id,
                 rs.id AS schedule_id
            FROM mc_dispatch_staging st
            JOIN recurring_schedules rs
              ON rs.customer_id = st.matched_customer_id
             AND rs.company_id = 1
             AND rs.is_active = true
             AND rs.frequency::text = CASE st.frequency
                   WHEN 'Every Week'        THEN 'weekly'
                   WHEN 'Every Two Weeks'   THEN 'biweekly'
                   WHEN 'Every Four Weeks'  THEN 'monthly'
                   WHEN 'Every Three Weeks' THEN 'custom'
                   WHEN 'Other Recurring'   THEN 'custom'
                   ELSE NULL
                 END
           WHERE st.frequency NOT IN ('Single', 'On Demand')
             AND st.matched_customer_id IS NOT NULL
           ORDER BY st.mc_job_id, rs.created_at ASC, rs.id ASC
        ) sub
       WHERE s.mc_job_id = sub.mc_job_id
    `);
    console.log(`UPDATE rowcount: ${res.rowCount}`);
    await db.execute(sql`COMMIT`);
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    throw err;
  }

  const rate = await db.execute(sql`
    SELECT frequency,
           COUNT(*)::int AS total_rows,
           COUNT(matched_schedule_id)::int AS linked,
           (COUNT(*) - COUNT(matched_schedule_id))::int AS unlinked
      FROM mc_dispatch_staging
     GROUP BY frequency
     ORDER BY total_rows DESC
  `);
  console.log("\nLinking rate per MC frequency:");
  console.table(rate.rows);

  // Unlinked recurring (informational — these have MC history but no matching Qleno schedule)
  const orphan = await db.execute(sql`
    SELECT s.customer_name,
           s.frequency,
           COUNT(*)::int AS n,
           s.matched_customer_id
      FROM mc_dispatch_staging s
     WHERE s.matched_schedule_id IS NULL
       AND s.frequency NOT IN ('Single', 'On Demand')
     GROUP BY s.customer_name, s.frequency, s.matched_customer_id
     ORDER BY n DESC, customer_name
     LIMIT 40
  `);
  console.log(`\nUnlinked recurring rows (informational): ${orphan.rowCount} distinct (customer, freq) pairs`);
  console.table(orphan.rows);

  // Summary: unlinked breakdown by MC frequency
  const orphanBreakdown = await db.execute(sql`
    SELECT s.frequency,
           COUNT(*)::int AS unlinked_rows,
           COUNT(DISTINCT s.matched_customer_id)::int AS unlinked_clients
      FROM mc_dispatch_staging s
     WHERE s.matched_schedule_id IS NULL
       AND s.frequency NOT IN ('Single', 'On Demand')
     GROUP BY s.frequency
     ORDER BY unlinked_rows DESC
  `);
  console.log("\nUnlinked-recurring breakdown by frequency:");
  console.table(orphanBreakdown.rows);
}

async function step3_3_parseTechs() {
  console.log("\n=== 3.3 — Tech parsing ===");

  const rows = await db.execute(sql`
    SELECT mc_job_id, team_raw
      FROM mc_dispatch_staging
     ORDER BY mc_job_id
  `);
  const allRows = rows.rows as any[];
  console.log(`Rows to parse: ${allRows.length}`);

  let unparsed = 0;
  const sampleUnparsed: any[] = [];
  const parsed: Array<{ mc_job_id: number; ids: number[] }> = [];

  for (const r of allRows) {
    const p = parseTeam(r.team_raw);
    if (p.unparsed !== null) {
      unparsed++;
      if (sampleUnparsed.length < 10) {
        sampleUnparsed.push({ mc_job_id: r.mc_job_id, team_raw: r.team_raw, remaining: p.unparsed });
      }
    }
    parsed.push({ mc_job_id: Number(r.mc_job_id), ids: p.ids });
  }
  console.log(`Unparsed: ${unparsed} (expect 0)`);
  if (unparsed > 0) {
    console.log("Sample:");
    console.table(sampleUnparsed);
    throw new Error(`Tech parser failed on ${unparsed} rows`);
  }

  // Bulk update — chunked UPDATE VALUES
  const chunkSize = 200;
  await db.execute(sql`BEGIN`);
  try {
    let done = 0;
    for (let off = 0; off < parsed.length; off += chunkSize) {
      const chunk = parsed.slice(off, off + chunkSize);
      for (const p of chunk) {
        await db.execute(sql`
          UPDATE mc_dispatch_staging
             SET parsed_techs = ${JSON.stringify(p.ids)}::jsonb
           WHERE mc_job_id = ${p.mc_job_id}
        `);
        done++;
      }
      console.log(`  ...updated ${done}/${parsed.length}`);
    }
    await db.execute(sql`COMMIT`);
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    throw err;
  }

  const dist = await db.execute(sql`
    SELECT JSONB_ARRAY_LENGTH(parsed_techs)::int AS tech_count,
           COUNT(*)::int AS rows
      FROM mc_dispatch_staging
     GROUP BY 1
     ORDER BY 1
  `);
  console.log("\nTech-count distribution:");
  console.table(dist.rows);

  const totalAssignments = await db.execute(sql`
    SELECT SUM(JSONB_ARRAY_LENGTH(parsed_techs))::int AS total_assignments
      FROM mc_dispatch_staging
  `);
  console.log("Total tech assignments:", totalAssignments.rows);

  const nullTechs = await db.execute(sql`
    SELECT COUNT(*)::int AS n
      FROM mc_dispatch_staging
     WHERE parsed_techs IS NULL
  `);
  console.log(`Rows with NULL parsed_techs: ${(nullTechs.rows?.[0] as any)?.n} (should be 0)`);
}

async function step3_4_mapStatus() {
  console.log("\n=== 3.4 — Status mapping ===");
  await db.execute(sql`BEGIN`);
  try {
    const res = await db.execute(sql`
      UPDATE mc_dispatch_staging
         SET mapped_status = CASE status_raw
               WHEN 'Closed'      THEN 'complete'
               WHEN 'Completed'   THEN 'complete'
               WHEN 'Pending'     THEN 'scheduled'
               WHEN 'In Progress' THEN 'in_progress'
               ELSE NULL
             END
    `);
    console.log(`UPDATE rowcount: ${res.rowCount} (expect 983)`);
    if (res.rowCount !== 983) throw new Error(`rowcount mismatch: ${res.rowCount}`);
    await db.execute(sql`COMMIT`);
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    throw err;
  }

  const dist = await db.execute(sql`
    SELECT status_raw, mapped_status, COUNT(*)::int AS n
      FROM mc_dispatch_staging
     GROUP BY status_raw, mapped_status
     ORDER BY status_raw
  `);
  console.log("\nStatus mapping distribution:");
  console.table(dist.rows);

  const nulls = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM mc_dispatch_staging WHERE mapped_status IS NULL
  `);
  console.log(`Rows with NULL mapped_status: ${(nulls.rows?.[0] as any)?.n} (should be 0)`);
}

async function step3_5_finalSummary() {
  console.log("\n=== 3.5 — Final staging integrity ===");

  const summary = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(matched_customer_id)::int AS with_customer,
      COUNT(matched_schedule_id)::int AS with_schedule,
      COUNT(parsed_techs)::int AS with_techs,
      COUNT(mapped_status)::int AS with_status,
      SUM(JSONB_ARRAY_LENGTH(COALESCE(parsed_techs, '[]'::jsonb)))::int AS total_tech_assignments,
      MIN(scheduled_date)::text AS min_date,
      MAX(scheduled_date)::text AS max_date,
      SUM(bill_rate)::numeric(14,2) AS total_bill_rate
    FROM mc_dispatch_staging
  `);
  console.table(summary.rows);

  // Apr 22-30 reconciliation vs MC ground truth
  const apr2230 = await db.execute(sql`
    SELECT scheduled_date::text AS date,
           COUNT(*)::int AS jobs,
           SUM(bill_rate)::numeric(14,2) AS total
      FROM mc_dispatch_staging
     WHERE scheduled_date BETWEEN '2026-04-22' AND '2026-04-30'
     GROUP BY scheduled_date
     ORDER BY scheduled_date
  `);
  console.log("\nApril 22–30 daily distribution (MUST match MC ground truth):");
  console.table(apr2230.rows);

  // Sanity: every row ready for Phase 4
  const ready = await db.execute(sql`
    SELECT COUNT(*)::int AS n
      FROM mc_dispatch_staging
     WHERE matched_customer_id IS NOT NULL
       AND mapped_status IS NOT NULL
       AND parsed_techs IS NOT NULL
       AND scheduled_date IS NOT NULL
  `);
  console.log(`\nRows fully ready for Phase 4 (all 4 required fields non-null): ${(ready.rows?.[0] as any)?.n} / 983`);
}

async function main() {
  console.log("=== L3 — Phase 3 main ===");
  await step3_2_linkSchedules();
  await step3_3_parseTechs();
  await step3_4_mapStatus();
  await step3_5_finalSummary();
  console.log("\nPhase 3 complete.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
