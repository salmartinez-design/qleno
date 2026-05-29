/**
 * user-companies-migration.ts
 *
 * Idempotent startup migration:
 *  1. CREATE TABLE IF NOT EXISTS user_companies
 *  2. Seed Sal (user_id=1) into company 1 (Oak Lawn) and company 4 (Schaumburg)
 *     using ON CONFLICT DO NOTHING so this is safe to re-run.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export async function runUserCompaniesMigration(): Promise<void> {
  try {
    // Create the table if it doesn't exist
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS user_companies (
        user_id    INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        role       TEXT    NOT NULL DEFAULT 'member',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT user_companies_pkey UNIQUE (user_id, company_id)
      )
    `);

    // Seed Sal into both companies (only if those users/companies exist)
    await db.execute(sql`
      INSERT INTO user_companies (user_id, company_id, role)
      SELECT u.id, c.id, 'owner'
      FROM users u, companies c
      WHERE u.email = 'salmartinez@phes.io'
        AND c.id IN (1, 4)
      ON CONFLICT DO NOTHING
    `);

    console.log("[user-companies] Migration complete");
  } catch (err: any) {
    console.error("[user-companies] Migration error:", err?.message ?? err);
  }
}
