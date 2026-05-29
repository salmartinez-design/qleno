/**
 * Deeper dive — why are 25 jobs on Apr 23 and 50 on Apr 27?
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // Frequency / day_of_week breakdown of schedules that landed on Apr 23 and Apr 27
  console.log("=== Apr 23 schedules — frequency / day_of_week / start_date ===");
  const apr23 = await db.execute(sql`
    SELECT rs.id, rs.frequency, rs.day_of_week,
           rs.start_date::text AS start_date,
           rs.last_generated_date::text AS last_generated_date,
           c.first_name || ' ' || c.last_name AS client
      FROM jobs j
      JOIN recurring_schedules rs ON rs.id = j.recurring_schedule_id
      JOIN clients c ON c.id = rs.customer_id
     WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
     ORDER BY rs.frequency, rs.day_of_week, rs.id
  `);
  console.table(apr23.rows);
  const f23: Record<string, number> = {};
  for (const r of apr23.rows as any[]) {
    const key = `${r.frequency}/${r.day_of_week || 'anchor_dom'}`;
    f23[key] = (f23[key] ?? 0) + 1;
  }
  console.log("Apr 23 freq breakdown:", f23);

  console.log("\n=== Apr 27 schedules — frequency / day_of_week / start_date ===");
  const apr27 = await db.execute(sql`
    SELECT rs.id, rs.frequency, rs.day_of_week,
           rs.start_date::text AS start_date,
           rs.last_generated_date::text AS last_generated_date,
           c.first_name || ' ' || c.last_name AS client
      FROM jobs j
      JOIN recurring_schedules rs ON rs.id = j.recurring_schedule_id
      JOIN clients c ON c.id = rs.customer_id
     WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-27'
     ORDER BY rs.frequency, rs.day_of_week, rs.id
  `);
  console.table(apr27.rows);
  const f27: Record<string, number> = {};
  for (const r of apr27.rows as any[]) {
    const key = `${r.frequency}/${r.day_of_week || 'anchor_dom'}`;
    f27[key] = (f27[key] ?? 0) + 1;
  }
  console.log("Apr 27 freq breakdown:", f27);

  // Expected distribution across the full 79 active schedules
  console.log("\n=== All 79 active PHES schedules — frequency × day_of_week ===");
  const all = await db.execute(sql`
    SELECT frequency, day_of_week, COUNT(*)::int AS n
      FROM recurring_schedules
     WHERE company_id = 1 AND is_active = true
     GROUP BY 1, 2
     ORDER BY 1, 2
  `);
  console.table(all.rows);

  // What MC says: Apr 22–30 has 83 jobs across 8 working days. Show what the
  // engine OUGHT to have produced (day-by-day count for the 60-day horizon
  // from today 2026-04-22 forward) and how many land on Apr 23 vs Apr 27.
  console.log("\n=== Engine-generated distribution Apr 22 – May 21 (all 79 schedules, from jobs table) ===");
  const horizon = await db.execute(sql`
    SELECT scheduled_date::text AS date,
           EXTRACT(DOW FROM scheduled_date)::int AS dow,
           TO_CHAR(scheduled_date, 'Dy') AS dow_name,
           COUNT(*)::int AS jobs,
           SUM(base_fee::numeric)::numeric(14,2) AS fee_sum
      FROM jobs
     WHERE company_id = 1
       AND recurring_schedule_id IS NOT NULL
       AND scheduled_date BETWEEN '2026-04-22' AND '2026-05-21'
     GROUP BY 1, 2, 3 ORDER BY 1
  `);
  console.table(horizon.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
