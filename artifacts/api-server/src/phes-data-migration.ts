/**
 * PHES Client Data Migration
 * Idempotent — safe to run on every server startup.
 *
 * Audit source: MC Active Clients PDF (March 24, 2026 — 99 clients).
 * Fixes:
 *   1. Activates 4 clients that exist but were incorrectly marked inactive.
 *   2. Creates ~25 missing clients (Cucci locations, KMA locations, Daveco
 *      properties, Bill Azzarello, Bill Garlanger, Caravel Health, etc.)
 *      using INSERT … WHERE NOT EXISTS so re-runs are safe.
 *   3. Corrects one name typo: "Cianan Lesley" → "Ciana Lesley".
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const PHES = 1; // company_id

export async function runPhesDataMigration(): Promise<void> {
  try {
    // ── 1. Activate + set cadence for 4 inactive clients ───────────────────
    // IDs confirmed from dev DB audit on 2026-03-24.
    await db.execute(sql`
      UPDATE clients
         SET is_active = true,
             frequency = 'monthly',
             base_fee  = 251.89
       WHERE id = 222 AND company_id = ${PHES}
    `);
    await db.execute(sql`
      UPDATE clients
         SET is_active = true,
             frequency = 'monthly',
             base_fee  = 224.25
       WHERE id = 145 AND company_id = ${PHES}
    `);
    await db.execute(sql`
      UPDATE clients
         SET is_active = true,
             frequency = 'monthly',
             base_fee  = 208.00
       WHERE id = 131 AND company_id = ${PHES}
    `);
    await db.execute(sql`
      UPDATE clients
         SET is_active = true,
             frequency = 'monthly',
             base_fee  = 230.10
       WHERE id = 83 AND company_id = ${PHES}
    `);

    // ── 2. Fix name typo: Cianan → Ciana (match by name, not ID) ──────────
    await db.execute(sql`
      UPDATE clients
         SET first_name = 'Ciana'
       WHERE company_id = ${PHES}
         AND LOWER(first_name) = 'cianan'
         AND LOWER(last_name) = 'lesley'
    `);

    // ── 3. Insert missing clients (idempotent) ─────────────────────────────
    // Each row: (first_name, last_name, frequency, base_fee, client_type)
    // last_name is NOT NULL in the schema — use '' for company/property clients
    type Row = [string, string, string, number, string];
    const missing: Row[] = [
      // Individuals
      ["Bill",   "Azzarello 9620 S Komensky", "weekly",       175.80, "residential"],
      ["Lauren", "Schultz",                   "biweekly",     240.00, "residential"],
      // Commercial / property clients (last_name = '')
      ["Bill Garlanger",                                  "", "weekly",       96.24,  "commercial"],
      ["Caravel Health",                                  "", "weekly",      160.00,  "commercial"],
      ["Cucci Property Management - 10410 Moody Avenue", "", "biweekly",    127.50,  "commercial"],
      ["Cucci Realty 10418 S Keating",                   "", "weekly",      130.00,  "commercial"],
      ["Cucci Realty 11901-05 South Lawndale",           "", "monthly",     175.00,  "commercial"],
      ["Cucci Realty Chicago Ridge",                     "", "biweekly",    146.60,  "commercial"],
      ["Cucci Realty Palos Hills",                       "", "monthly",     150.00,  "commercial"],
      ["Erickson Property Management 4001 W 93rd Pl",   "", "weekly",      121.15,  "commercial"],
      ["10308 Circle Drive",                             "", "semi-monthly", 150.00, "commercial"],
      ["5641 Circle Drive",                              "", "semi-monthly", 150.00, "commercial"],
      ["9708 South Nottingham Corporation.",             "", "monthly",     150.00,  "commercial"],
      ["PPM | 3510 N Pine Grove Ave",                   "", "weekly",      270.00,  "commercial"],
      ["Technology Resource Experts LLC",                "", "biweekly",    150.00,  "commercial"],
      ["WR ASSET ADMIN, INC",                           "", "semi-monthly", 175.00, "commercial"],
      // KMA locations
      ["KMA 4846 W North Offices", "", "monthly",  175.00, "commercial"],
      ["KMA 63rd",                 "", "monthly",  150.00, "commercial"],
      ["KMA Ashland",              "", "biweekly", 275.00, "commercial"],
      ["KMA Eggleston",            "", "monthly",  150.00, "commercial"],
      ["KMA Lamon",                "", "monthly",  150.00, "commercial"],
      ["KMA North Ave",            "", "monthly",  150.00, "commercial"],
      ["KMA Tracy",                "", "monthly",  150.00, "commercial"],
      // Daveco properties
      ["Daveco 18440 Torrence Lansing", "", "monthly", 99.00, "commercial"],
      ["Daveco 18428 Torrence Lansing", "", "monthly", 99.00, "commercial"],
    ];

    for (const [firstName, lastName, freq, fee, ctype] of missing) {
      await db.execute(sql`
        INSERT INTO clients
          (company_id, first_name, last_name, is_active,
           frequency, base_fee, client_type, created_at)
        SELECT
          ${PHES}, ${firstName}, ${lastName}, true,
          ${freq}, ${fee}, ${ctype}::client_type, NOW()
        WHERE NOT EXISTS (
          SELECT 1 FROM clients
           WHERE company_id = ${PHES}
             AND LOWER(TRIM(first_name)) = LOWER(TRIM(${firstName}))
             AND LOWER(TRIM(COALESCE(last_name, ''))) = LOWER(TRIM(${lastName}))
        )
      `);
    }

    console.log("[phes-migration] Client data migration complete.");
  } catch (err) {
    console.error("[phes-migration] Migration error (non-fatal):", err);
  }
}
