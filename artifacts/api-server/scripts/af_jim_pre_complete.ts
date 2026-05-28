import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  const r = await db.execute(sql`
    SELECT j.id, j.status, j.actual_end_time, j.locked_at, j.completed_by_user_id,
           j.completion_pdf_url, j.completion_pdf_sent_at,
           c.first_name || ' ' || c.last_name AS client
      FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
     WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
       AND (c.first_name ILIKE 'jim%' OR c.last_name ILIKE 'schultz%')
  `);
  console.table(r.rows);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
