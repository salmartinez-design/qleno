import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  const r = await db.execute(sql`
    SELECT id, company_id, entity_type, entity_id, status, attempts, created_at
      FROM qb_sync_queue
     WHERE entity_type = 'invoice'
     ORDER BY created_at DESC
     LIMIT 5
  `);
  if (r.rows.length === 0) console.log("(no rows)");
  else console.table(r.rows);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
