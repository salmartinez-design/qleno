import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== qb_sync_queue: entire table, any entity_type ===");
  const all = await db.execute(sql`
    SELECT id, company_id, entity_type, entity_id, status, attempts, created_at, updated_at,
           LEFT(COALESCE(last_error,''), 80) AS last_error
      FROM qb_sync_queue
     ORDER BY created_at DESC
     LIMIT 20
  `);
  if (all.rows.length === 0) console.log("(empty — no rows ever queued)");
  else console.table(all.rows);

  console.log("\n=== PHES company QB connection state ===");
  const co = await db.execute(sql`
    SELECT id, name,
           qb_connected, qb_realm_id,
           (qb_access_token IS NOT NULL) AS has_access_token,
           (qb_refresh_token IS NOT NULL) AS has_refresh_token
      FROM companies
     WHERE id = 1
  `);
  console.table(co.rows);

  console.log("\n=== Any complete jobs on Apr 23? ===");
  const done = await db.execute(sql`
    SELECT id, client_id, status, actual_end_time, locked_at, completed_by_user_id
      FROM jobs
     WHERE company_id = 1 AND scheduled_date = '2026-04-23' AND status = 'complete'
  `);
  if (done.rows.length === 0) console.log("(none complete yet — Mark Complete hasn't been clicked post-AF)");
  else console.table(done.rows);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
