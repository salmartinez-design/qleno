import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
(async () => {
  const r = await db.execute(sql`SELECT id, name, slug FROM companies WHERE id = 1`);
  console.table(r.rows);
  await pool.end();
})();
