/**
 * L3.1 — users schema probe + tech user shape sample. READ-ONLY.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== D.1 — users table schema ===");
  const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'users' AND table_schema = 'public'
     ORDER BY ordinal_position
  `);
  console.table(cols.rows);

  console.log("\n=== D.1b — existing tech users (full row shape) ===");
  const techs = await db.execute(sql`
    SELECT * FROM users
     WHERE company_id = 1 AND role = 'technician'
     ORDER BY id
     LIMIT 3
  `);
  console.log(techs.rows);

  console.log("\n=== D.1c — NOT NULL columns without defaults (required on insert) ===");
  const required = await db.execute(sql`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_name = 'users' AND table_schema = 'public'
       AND is_nullable = 'NO'
       AND column_default IS NULL
     ORDER BY ordinal_position
  `);
  console.table(required.rows);

  // Sample full row for one tech to see what field values look like
  console.log("\n=== D.1d — existing Norma Puga (id=32) full row ===");
  const norma = await db.execute(sql`SELECT * FROM users WHERE id = 32`);
  console.log(norma.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
