import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export async function ensureCommissionOverrideColumn(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS commission_override_pct NUMERIC(5,4)
  `);
}
