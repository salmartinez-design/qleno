import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== AF — Add jobs.actual_end_time / locked_at / completed_by_user_id ===\n");
  await db.execute(sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS actual_end_time      TIMESTAMP`);
  await db.execute(sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS locked_at            TIMESTAMP`);
  await db.execute(sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completed_by_user_id INTEGER`);

  const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema='public' AND table_name='jobs'
       AND column_name IN ('actual_end_time','locked_at','completed_by_user_id')
  `);
  console.table(cols.rows);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
