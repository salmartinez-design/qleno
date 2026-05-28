/**
 * Read-only revenue reconciliation — queries 2, 3, 5.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // Q2: job_history revenue by month
  console.log("=== Q2: job_history revenue by month (PHES, 2025-01+) ===");
  const q2 = await db.execute(sql`
    SELECT TO_CHAR(job_date, 'YYYY-MM') AS month,
           COUNT(*)::int AS jobs,
           SUM(revenue)::numeric(14,2) AS total_rev
      FROM job_history
     WHERE company_id = 1
       AND job_date >= '2025-01-01'
     GROUP BY 1
     ORDER BY 1 DESC
     LIMIT 16
  `);
  console.table(q2.rows);

  // Q3: jobs table revenue by month and status
  console.log("\n=== Q3: jobs table by month x status (PHES, 2025-01+) ===");
  const q3 = await db.execute(sql`
    SELECT TO_CHAR(scheduled_date, 'YYYY-MM') AS month,
           status,
           COUNT(*)::int AS jobs,
           SUM(base_fee::numeric)::numeric(14,2) AS total
      FROM jobs
     WHERE company_id = 1
       AND scheduled_date >= '2025-01-01'
     GROUP BY 1, 2
     ORDER BY 1 DESC, 2
     LIMIT 30
  `);
  console.table(q3.rows);

  // Q5: Arianna Goose (id 26) sample — 10 most recent job_history rows
  console.log("\n=== Q5: Arianna Goose id=26 — recent job_history ===");
  const q5 = await db.execute(sql`
    SELECT jh.job_date,
           jh.service_type,
           jh.revenue,
           jh.technician,
           COALESCE(LEFT(jh.notes, 80), '') AS notes_excerpt
      FROM job_history jh
     WHERE company_id = 1 AND customer_id = 26
     ORDER BY job_date DESC
     LIMIT 10
  `);
  console.table(q5.rows);

  // Bonus: total counts for sanity
  const phesJH = await db.execute(sql`
    SELECT COUNT(*)::int AS n, SUM(revenue)::numeric(14,2) AS rev_sum
      FROM job_history WHERE company_id = 1 AND job_date >= '2025-01-01'
  `);
  console.log("\n=== Totals — job_history 2025-01+ (PHES) ===");
  console.table(phesJH.rows);

  const phesJobsStatus = await db.execute(sql`
    SELECT status, COUNT(*)::int AS n, SUM(base_fee::numeric)::numeric(14,2) AS fee_sum
      FROM jobs WHERE company_id = 1
     GROUP BY status ORDER BY n DESC
  `);
  console.log("\n=== Totals — jobs by status (PHES, all time) ===");
  console.table(phesJobsStatus.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
