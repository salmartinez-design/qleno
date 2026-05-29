/**
 * J5 — flip PHES engine flag.
 * Usage: tsx j5_flip_flag.ts [true|false]
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  const targetArg = process.argv[2];
  if (targetArg !== "true" && targetArg !== "false") {
    console.error(`Usage: j5_flip_flag.ts [true|false]`);
    process.exit(1);
  }
  const target = targetArg === "true";

  const before = await db.execute(sql`
    SELECT id, name, recurring_engine_enabled FROM companies WHERE id = 1
  `);
  console.log("Before:", before.rows);

  await db.execute(sql`BEGIN`);
  try {
    const res = await db.execute(sql`
      UPDATE companies SET recurring_engine_enabled = ${target} WHERE id = 1
    `);
    const rowCount = res.rowCount ?? 0;
    console.log(`UPDATE rowcount: ${rowCount} (expect 1)`);
    if (rowCount !== 1) throw new Error(`rowcount mismatch: ${rowCount}`);
    await db.execute(sql`COMMIT`);
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    throw err;
  }

  const after = await db.execute(sql`
    SELECT id, name, recurring_engine_enabled FROM companies WHERE id = 1
  `);
  console.log("After:", after.rows);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
