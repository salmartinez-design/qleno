/**
 * PHES Data Migration
 * Idempotent — safe to run on every server startup.
 *
 * Sections:
 *   1. Client activations + typo fixes (2026-03-24 audit)
 *   2. Missing client inserts (MC PDF reconciliation)
 *   3. PHES pricing scope seeding (7 scopes)
 *   4. PHES rate modification / addon seeding (MC data)
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const PHES = 1; // company_id

export async function runPhesDataMigration(): Promise<void> {
  try {
    // ── 1. Activate + set cadence for 4 inactive clients ───────────────────
    await db.execute(sql`
      UPDATE clients
         SET is_active = true, frequency = 'monthly', base_fee = 251.89
       WHERE id = 222 AND company_id = ${PHES}
    `);
    await db.execute(sql`
      UPDATE clients
         SET is_active = true, frequency = 'bi-weekly', base_fee = 195.00
       WHERE id = 206 AND company_id = ${PHES}
    `);
    await db.execute(sql`
      UPDATE clients
         SET is_active = true, frequency = 'monthly', base_fee = 185.00
       WHERE id = 248 AND company_id = ${PHES}
    `);
    await db.execute(sql`
      UPDATE clients
         SET is_active = true, frequency = 'bi-weekly', base_fee = 165.00
       WHERE id = 239 AND company_id = ${PHES}
    `);

    // ── 2. Fix typo: Cianan → Ciana Lesley ─────────────────────────────────
    await db.execute(sql`
      UPDATE clients SET first_name = 'Ciana'
       WHERE company_id = ${PHES}
         AND LOWER(TRIM(first_name)) = 'cianan'
         AND LOWER(TRIM(last_name)) = 'lesley'
    `);

    // ── 3. Insert 25 missing clients from MC PDF ───────────────────────────
    const missingClients: Array<[string, string, string, number, string]> = [
      ["Cucci Property Management - 10410 Moody Avenue", "", "bi-weekly", 0,  "commercial"],
      ["Cucci Realty Palos Hills",                       "", "bi-weekly", 0,  "commercial"],
      ["Cucci Realty 11901-05 South Lawndale",           "", "bi-weekly", 0,  "commercial"],
      ["Cucci Realty 10418 S Keating",                   "", "bi-weekly", 0,  "commercial"],
      ["Cucci Realty Chicago Ridge",                     "", "bi-weekly", 0,  "commercial"],
      ["KMA 4846 W North Offices",                       "", "weekly",    0,  "commercial"],
      ["KMA Eggleston",                                  "", "weekly",    0,  "commercial"],
      ["KMA Ashland",                                    "", "weekly",    0,  "commercial"],
      ["KMA Lamon",                                      "", "weekly",    0,  "commercial"],
      ["KMA North Ave",                                  "", "weekly",    0,  "commercial"],
      ["KMA Tracy",                                      "", "weekly",    0,  "commercial"],
      ["KMA 63rd",                                       "", "weekly",    0,  "commercial"],
      ["Daveco 18440 Torrence Lansing",                  "", "bi-weekly", 0,  "commercial"],
      ["Daveco 18428 Torrence Lansing",                  "", "bi-weekly", 0,  "commercial"],
      ["Bill",       "Azzarello 9620 S Komensky",        "monthly",  0,  "residential"],
      ["Bill",       "Garlanger",                        "monthly",  0,  "residential"],
      ["Caravel",    "Health",                           "bi-weekly", 0, "commercial"],
      ["WR ASSET ADMIN, INC",                            "", "bi-weekly", 0, "commercial"],
      ["4128 W Cullom Condominium Assoc.",                "", "monthly",  0, "commercial"],
      ["Hickory Hills Condominium",                       "", "monthly",  0, "commercial"],
      ["Heritage Condominium",                            "", "monthly",  0, "commercial"],
      ["413 N Noble St Condominium Association",          "", "monthly",  0, "commercial"],
      ["City Light Church",                               "", "bi-weekly", 0, "commercial"],
      ["Amber",      "Swanson",                          "bi-weekly", 0, "residential"],
      ["Jordan",     "Szczepanski",                      "bi-weekly", 0, "residential"],
      ["Kristen",    "Ivy",                              "bi-weekly", 0, "residential"],
      ["Molly",      "Leonard",                          "bi-weekly", 0, "residential"],
    ];

    for (const [firstName, lastName, freq, fee, ctype] of missingClients) {
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

    // ── 4. Ensure PHES pricing scopes exist ────────────────────────────────
    const scopeDefs = [
      { name: "Deep Clean or Move In/Out",  method: "sqft",   rate: "70.00", min: "210.00" },
      { name: "One-Time Standard Clean",    method: "sqft",   rate: "60.00", min: "150.00" },
      { name: "Recurring Cleaning",         method: "sqft",   rate: "55.00", min: "120.00" },
      { name: "Hourly Deep Clean",          method: "hourly", rate: "70.00", min: "210.00" },
      { name: "Hourly Standard Cleaning",   method: "hourly", rate: "60.00", min: "150.00" },
      { name: "Commercial Cleaning",        method: "hourly", rate: "65.00", min: "200.00" },
      { name: "PPM Turnover",              method: "sqft",   rate: "65.00", min: "250.00" },
    ];

    for (const s of scopeDefs) {
      await db.execute(sql`
        INSERT INTO pricing_scopes
          (company_id, name, pricing_method, hourly_rate, minimum_bill,
           displayed_for_office, is_active, sort_order)
        SELECT ${PHES}, ${s.name}, ${s.method}, ${s.rate}, ${s.min}, true, true,
               (SELECT COALESCE(MAX(sort_order),0)+1 FROM pricing_scopes WHERE company_id=${PHES})
        WHERE NOT EXISTS (
          SELECT 1 FROM pricing_scopes WHERE company_id=${PHES} AND name=${s.name}
        )
      `);
    }

    // Build scope name → id map
    const scopeResult = await db.execute(sql`
      SELECT id, name FROM pricing_scopes WHERE company_id = ${PHES}
    `);
    const scopeMap: Record<string, number> = {};
    for (const row of (scopeResult as any).rows ?? []) {
      scopeMap[row.name] = parseInt(row.id);
    }

    console.log("[phes-migration] Pricing scopes ensured:", Object.keys(scopeMap).length, "scopes");

    // ── 4b. Seed default frequencies for each scope (idempotent) ───────────
    type FreqDef = { freq: string; mult: string; override?: string; showOffice: boolean; showOnline: boolean };
    const sqftFreqs: FreqDef[] = [
      { freq: "onetime",  mult: "1.00", showOffice: true,  showOnline: true  },
      { freq: "weekly",   mult: "0.80", showOffice: true,  showOnline: true  },
      { freq: "biweekly", mult: "0.90", showOffice: true,  showOnline: true  },
      { freq: "monthly",  mult: "1.00", showOffice: true,  showOnline: true  },
    ];
    const hourlyFreqs: FreqDef[] = [
      { freq: "onetime",  mult: "1.00", showOffice: true, showOnline: true },
    ];
    // Deep Clean existing frequencies take priority — only fill gaps
    const existingFreqResult = await db.execute(sql`
      SELECT scope_id, frequency FROM pricing_frequencies WHERE company_id = ${PHES}
    `);
    const existingFreqSet = new Set<string>(
      ((existingFreqResult as any).rows ?? []).map((r: any) => `${r.scope_id}:${r.frequency}`)
    );

    for (const [name, method] of Object.entries({ ...Object.fromEntries(scopeDefs.map(s => [s.name, s.method])) })) {
      const sid = scopeMap[name];
      if (!sid) continue;
      const freqList = method === "sqft" ? sqftFreqs : hourlyFreqs;
      for (const f of freqList) {
        if (existingFreqSet.has(`${sid}:${f.freq}`)) continue;
        await db.execute(sql`
          INSERT INTO pricing_frequencies
            (company_id, scope_id, frequency, multiplier, rate_override, label, show_office, sort_order)
          VALUES
            (${PHES}, ${sid}, ${f.freq}, ${f.mult}, ${f.override ?? null}, '',
             ${f.showOffice},
             (SELECT COALESCE(MAX(sort_order),0)+1 FROM pricing_frequencies WHERE scope_id=${sid}))
          ON CONFLICT DO NOTHING
        `);
      }
    }
    // Also seed for pre-existing "Standard Clean" (scope 2)
    const stdCleanId = scopeMap["Standard Clean"];
    if (stdCleanId) {
      for (const f of sqftFreqs) {
        if (existingFreqSet.has(`${stdCleanId}:${f.freq}`)) continue;
        await db.execute(sql`
          INSERT INTO pricing_frequencies
            (company_id, scope_id, frequency, multiplier, rate_override, label, show_office, sort_order)
          VALUES
            (${PHES}, ${stdCleanId}, ${f.freq}, ${f.mult}, ${f.override ?? null}, '',
             ${f.showOffice},
             (SELECT COALESCE(MAX(sort_order),0)+1 FROM pricing_frequencies WHERE scope_id=${stdCleanId}))
          ON CONFLICT DO NOTHING
        `);
      }
    }
    console.log("[phes-migration] Frequencies ensured for all scopes");

    // ── 5. Seed MC rate modifications / add-ons ────────────────────────────
    // Only run if no addons with scope_ids have been seeded yet
    const addonCheckResult = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM pricing_addons
       WHERE company_id = ${PHES} AND scope_ids != '[]' AND scope_ids != ''
    `);
    const addonCount = parseInt(((addonCheckResult as any).rows ?? [{}])[0]?.cnt ?? "0");

    if (addonCount === 0) {
      // Clear any stale legacy addon records (pre-scope_ids era)
      await db.execute(sql`DELETE FROM pricing_addons WHERE company_id = ${PHES}`);

      const D  = scopeMap["Deep Clean or Move In/Out"];
      const S  = scopeMap["One-Time Standard Clean"];
      const R  = scopeMap["Recurring Cleaning"];
      const HD = scopeMap["Hourly Deep Clean"];
      const HS = scopeMap["Hourly Standard Cleaning"];
      const C  = scopeMap["Commercial Cleaning"];
      const P  = scopeMap["PPM Turnover"];

      type AddonSeed = {
        name: string;
        addon_type: string;
        scope_ids: number[];
        price_type: string;
        price_value: number;
        time_minutes: number;
        time_unit: string;
        is_itemized: boolean;
        show_office: boolean;
        show_online: boolean;
        show_portal: boolean;
        sort_order: number;
      };

      const addons: AddonSeed[] = [
        // ── CLEANING EXTRAS ──────────────────────────────────────────────
        {
          name: "Oven Cleaning",
          addon_type: "cleaning_extras",
          scope_ids: [D, S, R].filter(Boolean),
          price_type: "flat", price_value: 50,
          time_minutes: 45, time_unit: "each",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 10,
        },
        {
          name: "Oven Cleaning (Hourly — Time Add)",
          addon_type: "cleaning_extras",
          scope_ids: [HD, HS].filter(Boolean),
          price_type: "time_only", price_value: 0,
          time_minutes: 45, time_unit: "each",
          is_itemized: false, show_office: true, show_online: true, show_portal: true, sort_order: 11,
        },
        {
          name: "Refrigerator Cleaning",
          addon_type: "cleaning_extras",
          scope_ids: [D, S, R].filter(Boolean),
          price_type: "flat", price_value: 50,
          time_minutes: 45, time_unit: "each",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 20,
        },
        {
          name: "Refrigerator Cleaning (Hourly — Time Add)",
          addon_type: "cleaning_extras",
          scope_ids: [HD, HS].filter(Boolean),
          price_type: "time_only", price_value: 0,
          time_minutes: 45, time_unit: "each",
          is_itemized: false, show_office: true, show_online: true, show_portal: true, sort_order: 21,
        },
        {
          name: "Kitchen Cabinets (must be empty upon arrival)",
          addon_type: "cleaning_extras",
          scope_ids: [D, S].filter(Boolean),
          price_type: "flat", price_value: 50,
          time_minutes: 45, time_unit: "each",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 30,
        },
        {
          name: "Kitchen Cabinets — Hourly (Time Add)",
          addon_type: "cleaning_extras",
          scope_ids: [HD, HS].filter(Boolean),
          price_type: "time_only", price_value: 0,
          time_minutes: 45, time_unit: "each",
          is_itemized: false, show_office: true, show_online: true, show_portal: true, sort_order: 31,
        },
        {
          name: "Baseboards",
          addon_type: "cleaning_extras",
          scope_ids: [S].filter(Boolean),
          price_type: "flat", price_value: 50,
          time_minutes: 45, time_unit: "each",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 40,
        },
        {
          name: "Baseboards — Deep Clean (Sq Ft %)",
          addon_type: "cleaning_extras",
          scope_ids: [HD].filter(Boolean),
          price_type: "sqft_pct", price_value: 12,
          time_minutes: 45, time_unit: "sqft",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 41,
        },
        // Windows — 3 variants
        {
          name: "Windows (inside panes) — Deep Clean",
          addon_type: "cleaning_extras",
          scope_ids: [D].filter(Boolean),
          price_type: "sqft_pct", price_value: 15,
          time_minutes: 45, time_unit: "sqft",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 50,
        },
        {
          name: "Windows (inside panes) — Standard / Recurring",
          addon_type: "cleaning_extras",
          scope_ids: [S, R].filter(Boolean),
          price_type: "percentage", price_value: 12,
          time_minutes: 45, time_unit: "each",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 51,
        },
        {
          name: "Windows (inside panes) — Hourly (Time Add)",
          addon_type: "cleaning_extras",
          scope_ids: [HD, HS].filter(Boolean),
          price_type: "time_only", price_value: 0,
          time_minutes: 45, time_unit: "each",
          is_itemized: false, show_office: true, show_online: true, show_portal: true, sort_order: 52,
        },
        // Clean Basement — 3 variants
        {
          name: "Clean Basement — Deep / Standard",
          addon_type: "cleaning_extras",
          scope_ids: [D, S].filter(Boolean),
          price_type: "sqft_pct", price_value: 15,
          time_minutes: 45, time_unit: "sqft",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 60,
        },
        {
          name: "Clean Basement — Recurring",
          addon_type: "cleaning_extras",
          scope_ids: [R].filter(Boolean),
          price_type: "sqft_pct", price_value: 12,
          time_minutes: 45, time_unit: "sqft",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 61,
        },
        {
          name: "Clean Basement — Hourly (Time Add)",
          addon_type: "cleaning_extras",
          scope_ids: [HD, HS].filter(Boolean),
          price_type: "time_only", price_value: 0,
          time_minutes: 0, time_unit: "each",
          is_itemized: false, show_office: true, show_online: true, show_portal: true, sort_order: 62,
        },
        // Parking Fee — all scopes
        {
          name: "Parking Fee",
          addon_type: "cleaning_extras",
          scope_ids: [D, S, R, HD, HS, C, P].filter(Boolean),
          price_type: "flat", price_value: 20,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 70,
        },
        // Manual Adjustment (replaces MC $1 increment hack)
        {
          name: "Manual Adjustment",
          addon_type: "cleaning_extras",
          scope_ids: [D, S, R].filter(Boolean),
          price_type: "manual_adj", price_value: 0,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: false, show_portal: false, sort_order: 99,
        },
        // ── DISCOUNTS ────────────────────────────────────────────────────
        {
          name: "Loyalty Discount — $100",
          addon_type: "other",
          scope_ids: [D, S, R, HS, P].filter(Boolean),
          price_type: "flat", price_value: -100,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 110,
        },
        {
          name: "Loyalty Discount — $50",
          addon_type: "other",
          scope_ids: [D, S, R, HD, HS, P].filter(Boolean),
          price_type: "flat", price_value: -50,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 111,
        },
        {
          name: "Loyalty Discount — 20% Off",
          addon_type: "other",
          scope_ids: [HD].filter(Boolean),
          price_type: "percentage", price_value: -20,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 112,
        },
        {
          name: "Promo Discount — 10% Off",
          addon_type: "other",
          scope_ids: [S, R, HD, HS, P].filter(Boolean),
          price_type: "percentage", price_value: -10,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 120,
        },
        {
          name: "Promo Discount — 15% Off",
          addon_type: "other",
          scope_ids: [S, HD].filter(Boolean),
          price_type: "percentage", price_value: -15,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 121,
        },
        {
          name: "Second Appointment Discount — 15% Off",
          addon_type: "other",
          scope_ids: [S, HD].filter(Boolean),
          price_type: "percentage", price_value: -15,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 130,
        },
        {
          name: "Second Appointment — +15% (markup)",
          addon_type: "other",
          scope_ids: [HS].filter(Boolean),
          price_type: "percentage", price_value: 15,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 131,
        },
        // Commercial Adjustment
        {
          name: "Commercial Adjustment",
          addon_type: "other",
          scope_ids: [C].filter(Boolean),
          price_type: "percentage", price_value: -100,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: true, show_portal: true, sort_order: 140,
        },
      ];

      let order = 0;
      for (const a of addons) {
        const scopeIdsJson = JSON.stringify(a.scope_ids);
        const firstScopeId = a.scope_ids[0] ?? null;
        await db.execute(sql`
          INSERT INTO pricing_addons
            (company_id, scope_id, name, addon_type, scope_ids,
             price_type, price_value, time_add_minutes, time_unit,
             is_itemized, show_office, show_online, show_portal,
             is_active, sort_order)
          VALUES
            (${PHES}, ${firstScopeId}, ${a.name}, ${a.addon_type}, ${scopeIdsJson},
             ${a.price_type}, ${a.price_value}, ${a.time_minutes}, ${a.time_unit},
             ${a.is_itemized}, ${a.show_office}, ${a.show_online}, ${a.show_portal},
             true, ${a.sort_order + order})
        `);
        order++;
      }
      console.log("[phes-migration] Rate modifications seeded:", addons.length, "add-ons");

      // Ensure "Standard Clean" (pre-existing scope) gets same addons as "One-Time Standard Clean"
      const stdClean = scopeMap["Standard Clean"];
      const otStdClean = scopeMap["One-Time Standard Clean"];
      if (stdClean && otStdClean) {
        await db.execute(sql`
          UPDATE pricing_addons
          SET scope_ids = (scope_ids::jsonb || ${JSON.stringify([stdClean])}::jsonb)::text
          WHERE company_id = ${PHES}
            AND scope_ids::jsonb @> ${JSON.stringify([otStdClean])}::jsonb
            AND NOT scope_ids::jsonb @> ${JSON.stringify([stdClean])}::jsonb
        `);
      }
    } else {
      console.log("[phes-migration] Rate modifications already seeded — skipping.");
    }

  } catch (err) {
    console.error("[phes-migration] Migration error (non-fatal):", err);
  }

  // Run employee-specific migrations
  await runAleCuervoMigration();
}

// ── Alejandra Cuervo — Full MC data migration ─────────────────────────────────
async function runAleCuervoMigration() {
  try {
    const PHES = 1;

    // ── DDL Phase: schema changes (always idempotent) ────────────────────────

    // Extend additional_pay_type enum (guarded: no-op if type was dropped)
    for (const val of ["other_additional", "bonus_other", "amount_owed_non_taxed"]) {
      await db.execute(sql.raw(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'additional_pay_type') THEN
            ALTER TYPE additional_pay_type ADD VALUE IF NOT EXISTS '${val}';
          END IF;
        END $$;
      `));
    }

    // Add missing columns to users
    const userCols = [
      "mc_employee_id text",
      "drivers_license_number text",
      "drivers_license_state text",
      "pto_hours_available numeric(8,2) DEFAULT 0",
      "sick_hours_available numeric(8,2) DEFAULT 0",
    ];
    for (const col of userCols) {
      await db.execute(sql.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col}`));
    }

    // Create job_history (MC historical job data — columns: revenue, job_date, customer_id)
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS job_history (
        id           serial PRIMARY KEY,
        company_id   integer NOT NULL,
        customer_id  integer,
        job_date     date NOT NULL,
        revenue      numeric(10,2) NOT NULL DEFAULT 0,
        service_type text,
        technician   text,
        notes        text,
        created_at   timestamp NOT NULL DEFAULT now()
      )
    `));
    await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS idx_job_history_company_date ON job_history(company_id, job_date)`));
    await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS idx_job_history_customer ON job_history(customer_id, company_id)`));

    // Create employee_employment_history
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS employee_employment_history (
        id            serial PRIMARY KEY,
        company_id    integer NOT NULL REFERENCES companies(id),
        employee_id   integer NOT NULL REFERENCES users(id),
        hire_date     date NOT NULL,
        termination_date date,
        recorded_by   text,
        recorded_at   timestamp,
        created_at    timestamp NOT NULL DEFAULT now()
      )
    `));

    // Create employee_pto_history
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS employee_pto_history (
        id            serial PRIMARY KEY,
        company_id    integer NOT NULL REFERENCES companies(id),
        employee_id   integer NOT NULL REFERENCES users(id),
        date_changed  timestamp NOT NULL,
        pto_adj       numeric(8,2) NOT NULL DEFAULT 0,
        pto_bal       numeric(8,2) NOT NULL DEFAULT 0,
        sick_adj      numeric(8,2) NOT NULL DEFAULT 0,
        sick_bal      numeric(8,2) NOT NULL DEFAULT 0,
        notes         text,
        created_at    timestamp NOT NULL DEFAULT now()
      )
    `));

    // Create employee_pay_structure
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS employee_pay_structure (
        id            serial PRIMARY KEY,
        company_id    integer NOT NULL REFERENCES companies(id),
        employee_id   integer NOT NULL REFERENCES users(id),
        scope_slug    text NOT NULL,
        pay_type      text NOT NULL DEFAULT 'flat',
        solo_pay      numeric(10,2),
        captain_pay   numeric(10,2),
        teammate_pay  numeric(10,2),
        travel_pay    numeric(10,2) DEFAULT 0,
        solo_pct      numeric(6,2),
        captain_pct   numeric(6,2),
        teammate_pct  numeric(6,2),
        created_at    timestamp NOT NULL DEFAULT now(),
        UNIQUE(company_id, employee_id, scope_slug)
      )
    `));

    // Create employee_productivity
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS employee_productivity (
        id               serial PRIMARY KEY,
        company_id       integer NOT NULL REFERENCES companies(id),
        employee_id      integer NOT NULL REFERENCES users(id),
        scope_slug       text NOT NULL,
        productivity_pct numeric(6,2) NOT NULL,
        period_start     date,
        period_end       date,
        created_at       timestamp NOT NULL DEFAULT now(),
        UNIQUE(company_id, employee_id, scope_slug)
      )
    `));

    // Create employee_attendance_stats
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS employee_attendance_stats (
        id           serial PRIMARY KEY,
        company_id   integer NOT NULL REFERENCES companies(id),
        employee_id  integer NOT NULL REFERENCES users(id),
        period_start date,
        period_end   date,
        scheduled    integer DEFAULT 0,
        worked       integer DEFAULT 0,
        absent       integer DEFAULT 0,
        time_off     integer DEFAULT 0,
        excused      integer DEFAULT 0,
        unexcused    integer DEFAULT 0,
        paid_time_off integer DEFAULT 0,
        sick         integer DEFAULT 0,
        late         integer DEFAULT 0,
        score        integer DEFAULT 0,
        created_at   timestamp NOT NULL DEFAULT now(),
        UNIQUE(company_id, employee_id, period_start, period_end)
      )
    `));

    console.log("[alecuervo-migration] DDL complete");

    // Find Alejandra's user record (id=41 under PHES)
    const empResult = await db.execute(sql`
      SELECT id FROM users
      WHERE company_id = ${PHES}
        AND LOWER(first_name || ' ' || last_name) = 'alejandra cuervo'
    `);
    const emp = ((empResult as any).rows ?? [])[0];
    if (!emp) {
      console.log("[alecuervo-migration] Alejandra Cuervo not found — skipping data migration");
      return;
    }
    const EID = parseInt(emp.id);

    // ── Section 1+2+3: Core update ───────────────────────────────────────────
    await db.execute(sql`
      UPDATE users SET
        mc_employee_id           = '42877',
        dob                      = '1992-01-16',
        hire_date                = '2023-05-11',
        email                    = 'acuervo68@yahoo.com',
        phone                    = '773-812-2419',
        drivers_license_number   = 'C61501592616',
        drivers_license_state    = 'IL',
        employment_type          = 'full_time',
        hr_status                = 'active',
        address                  = '5371 South Rockwell Street',
        city                     = 'Chicago',
        state                    = 'IL',
        zip                      = '60632',
        skills                   = ARRAY['Maintenance Cleaning'],
        tags                     = ARRAY['Scheduled', 'Full Time'],
        pto_hours_available      = 0,
        sick_hours_available     = 20
      WHERE id = ${EID} AND company_id = ${PHES}
    `);
    console.log("[alecuervo-migration] Core record updated");

    // ── Section 5: Employment history ────────────────────────────────────────
    type EmpHistRow = { hire_date: string; termination_date: string | null; recorded_by: string; recorded_at: string };
    const empHistory: EmpHistRow[] = [
      { hire_date: "2023-05-11", termination_date: null, recorded_by: "M. Castillo", recorded_at: "2025-12-31 16:07:00" },
      { hire_date: "2025-08-08", termination_date: null, recorded_by: "S. Martinez",  recorded_at: "2025-08-08 10:52:00" },
    ];
    for (const h of empHistory) {
      await db.execute(sql`
        INSERT INTO employee_employment_history
          (company_id, employee_id, hire_date, termination_date, recorded_by, recorded_at)
        SELECT ${PHES}, ${EID}, ${h.hire_date}, ${h.termination_date}, ${h.recorded_by}, ${h.recorded_at}
        WHERE NOT EXISTS (
          SELECT 1 FROM employee_employment_history
          WHERE company_id=${PHES} AND employee_id=${EID} AND hire_date=${h.hire_date}
        )
      `);
    }

    // ── Section 6: PTO history ───────────────────────────────────────────────
    type PtoRow = { date_changed: string; pto_adj: number; pto_bal: number; sick_adj: number; sick_bal: number; notes: string };
    const ptoHistory: PtoRow[] = [
      { date_changed: "2026-02-23 14:26:00", pto_adj: 0,  pto_bal: 0, sick_adj: -6, sick_bal: 20, notes: "Approved" },
      { date_changed: "2026-02-11 14:18:00", pto_adj: 0,  pto_bal: 0, sick_adj:  5, sick_bal: 26, notes: "Cancelled" },
      { date_changed: "2026-02-07 10:46:00", pto_adj: 0,  pto_bal: 0, sick_adj: -5, sick_bal: 21, notes: "Approved" },
      { date_changed: "2025-12-31 15:56:00", pto_adj: 0,  pto_bal: 0, sick_adj: -6, sick_bal: 26, notes: "Approved" },
      { date_changed: "2025-12-16 07:43:00", pto_adj: 0,  pto_bal: 0, sick_adj: -8, sick_bal: 32, notes: "Approved" },
      { date_changed: "2025-12-10 15:27:00", pto_adj: 0,  pto_bal: 0, sick_adj: 40, sick_bal: 40, notes: "Over 90 Days" },
    ];
    for (const p of ptoHistory) {
      await db.execute(sql`
        INSERT INTO employee_pto_history
          (company_id, employee_id, date_changed, pto_adj, pto_bal, sick_adj, sick_bal, notes)
        SELECT ${PHES}, ${EID}, ${p.date_changed}, ${p.pto_adj}, ${p.pto_bal}, ${p.sick_adj}, ${p.sick_bal}, ${p.notes}
        WHERE NOT EXISTS (
          SELECT 1 FROM employee_pto_history
          WHERE company_id=${PHES} AND employee_id=${EID} AND date_changed=${p.date_changed}
        )
      `);
    }

    // ── Section 7: Pay structure ─────────────────────────────────────────────
    type PayRow = { scope_slug: string; pay_type: string; solo_pay?: number; captain_pay?: number; teammate_pay?: number; travel_pay: number; solo_pct?: number; captain_pct?: number; teammate_pct?: number };
    const payStructure: PayRow[] = [
      // Commercial — flat dollar
      { scope_slug: "commercial-cleaning",     pay_type: "flat", solo_pay: 20, captain_pay: 0, teammate_pay: 20, travel_pay: 0 },
      { scope_slug: "ppm-common-areas",        pay_type: "flat", solo_pay: 20, captain_pay: 0, teammate_pay: 20, travel_pay: 0 },
      { scope_slug: "ppm-turnover",            pay_type: "flat", solo_pay: 20, captain_pay: 0, teammate_pay: 20, travel_pay: 0 },
      { scope_slug: "multi-unit-common-areas", pay_type: "flat", solo_pay: 20, captain_pay: 0, teammate_pay: 20, travel_pay: 0 },
      // House cleaning — percentage
      { scope_slug: "recurring-cleaning",         pay_type: "percentage", solo_pct: 35, captain_pct: 0, teammate_pct: 35, travel_pay: 0 },
      { scope_slug: "deep-clean-move-in-out",     pay_type: "percentage", solo_pct: 35, captain_pct: 0, teammate_pct: 35, travel_pay: 0 },
      { scope_slug: "one-time-standard",          pay_type: "percentage", solo_pct: 35, captain_pct: 0, teammate_pct: 35, travel_pay: 0 },
      { scope_slug: "hourly-deep-clean",          pay_type: "percentage", solo_pct: 35, captain_pct: 0, teammate_pct: 35, travel_pay: 0 },
      { scope_slug: "hourly-standard-cleaning",   pay_type: "percentage", solo_pct: 35, captain_pct: 0, teammate_pct: 35, travel_pay: 0 },
    ];
    for (const p of payStructure) {
      await db.execute(sql`
        INSERT INTO employee_pay_structure
          (company_id, employee_id, scope_slug, pay_type, solo_pay, captain_pay, teammate_pay, travel_pay, solo_pct, captain_pct, teammate_pct)
        VALUES
          (${PHES}, ${EID}, ${p.scope_slug}, ${p.pay_type},
           ${p.solo_pay ?? null}, ${p.captain_pay ?? null}, ${p.teammate_pay ?? null}, ${p.travel_pay},
           ${p.solo_pct ?? null}, ${p.captain_pct ?? null}, ${p.teammate_pct ?? null})
        ON CONFLICT (company_id, employee_id, scope_slug) DO UPDATE SET
          pay_type     = EXCLUDED.pay_type,
          solo_pay     = EXCLUDED.solo_pay,
          captain_pay  = EXCLUDED.captain_pay,
          teammate_pay = EXCLUDED.teammate_pay,
          travel_pay   = EXCLUDED.travel_pay,
          solo_pct     = EXCLUDED.solo_pct,
          captain_pct  = EXCLUDED.captain_pct,
          teammate_pct = EXCLUDED.teammate_pct
      `);
    }

    // ── Section 8: Additional pay (31 records) ───────────────────────────────
    type AddlPay = { date: string; amount: number; hours: number; type: string; notes: string };
    const addlPay: AddlPay[] = [
      { date: "2026-03-04", amount: 100.00, hours: 5,   type: "sick_pay",             notes: "Doctor's Appointment - Approved on 2/23 by MC" },
      { date: "2026-02-23", amount: 49.87,  hours: 0,   type: "amount_owed",           notes: "Lockout: 2/23/2026 - Stanley Kuba / Hourly Standard" },
      { date: "2026-02-10", amount: 10.00,  hours: 0,   type: "tips",                  notes: "Tip - Hourly Standard" },
      { date: "2026-02-06", amount: 20.77,  hours: 0,   type: "amount_owed_non_taxed", notes: "$4.10 and $16.67" },
      { date: "2026-01-21", amount: 10.00,  hours: 0,   type: "other_additional",      notes: "Jeanette Smith's waiting time" },
      { date: "2026-01-16", amount: 3.48,   hours: 0,   type: "amount_owed",           notes: "Aaron Decker to Heather Kelly 4.8x0.725 = $3.48" },
      { date: "2026-01-16", amount: 160.00, hours: 0,   type: "bonus_other",           notes: "Birthday Bonus" },
      { date: "2026-01-12", amount: 51.18,  hours: 0,   type: "amount_owed",           notes: "Skip: 1/12/2026 - Sally Ozinga / Hourly Standard" },
      { date: "2026-01-12", amount: 120.00, hours: 6,   type: "sick_pay",              notes: "Dentist Appointment in the afternoon - Approved by MC 12/31/25" },
      { date: "2026-01-09", amount: 30.00,  hours: 1.5, type: "other_additional",      notes: "Meeting at the Office 01/09/26" },
      { date: "2026-01-07", amount: 140.00, hours: 7,   type: "sick_pay",              notes: "Fever - called Francisco, couldn't work 11am-6pm" },
      { date: "2026-01-02", amount: 160.00, hours: 0,   type: "holiday_pay",           notes: "Holiday Pay" },
      { date: "2025-12-25", amount: 144.00, hours: 0,   type: "holiday_pay",           notes: "Christmas Day" },
      { date: "2025-12-23", amount: 11.20,  hours: 0,   type: "amount_owed",           notes: "" },
      { date: "2025-12-20", amount: 2.80,   hours: 0,   type: "amount_owed",           notes: "FE - 12/20/2025 - Excess - Jillian Devitt - 4 miles x $0.70" },
      { date: "2025-12-19", amount: 12.60,  hours: 0,   type: "amount_owed",           notes: "FE - 12-18-2025 Mileage Ashley Wedge/Jamie Pokusa - 18mi x$0.70" },
      { date: "2025-12-19", amount: 11.90,  hours: 0,   type: "amount_owed",           notes: "FE - 12-18-2025 Heather Kelly/Adam Coppelman - 11.9 x $0.70" },
      { date: "2025-12-16", amount: 144.00, hours: 8,   type: "sick_pay",              notes: "Wasn't feeling well - MC" },
      { date: "2025-12-12", amount: 2.38,   hours: 0,   type: "amount_owed",           notes: "Heather Kelly 1.70 miles @ $0.70" },
      { date: "2025-11-28", amount: 13.30,  hours: 0,   type: "amount_owed",           notes: "Mileage Patrick Patel to Chris Cucci 12-01-2025 - 19 miles" },
      { date: "2025-11-27", amount: 144.00, hours: 8,   type: "holiday_pay",           notes: "Thanksgiving" },
      { date: "2025-11-26", amount: 4.06,   hours: 0,   type: "amount_owed",           notes: "Mileage Heather Kelly to Laurita Lui 11-26-2025 - 5.8 miles" },
      { date: "2025-10-31", amount: 6.09,   hours: 0,   type: "amount_owed",           notes: "Mileage" },
      { date: "2025-10-24", amount: 4.27,   hours: 0,   type: "amount_owed_non_taxed", notes: "Mileage" },
      { date: "2025-10-24", amount: 9.10,   hours: 0,   type: "amount_owed_non_taxed", notes: "Mileage" },
      { date: "2025-10-17", amount: 9.80,   hours: 0,   type: "amount_owed",           notes: "Mileage Reimbursement" },
      { date: "2025-10-10", amount: 16.10,  hours: 0,   type: "other_additional",      notes: "Tom and Carol Butler" },
      { date: "2025-09-26", amount: 9.10,   hours: 0,   type: "amount_owed_non_taxed", notes: "Nicholas Cooper $1.40 and $7.70" },
      { date: "2025-09-23", amount: 30.00,  hours: 0,   type: "amount_owed_non_taxed", notes: "Meeting 9/23" },
      { date: "2025-09-19", amount: 13.44,  hours: 0,   type: "amount_owed_non_taxed", notes: "Heather Kelly 18mi=$12.60 + Ran Sengupita 1.2mi=$0.84" },
      { date: "2025-08-20", amount: 34.98,  hours: 0,   type: "tips",                  notes: "Tip - Flat Standard" },
    ];
    for (const a of addlPay) {
      const notesWithHours = a.hours > 0 ? `${a.notes}${a.notes ? " " : ""}(${a.hours}h)`.trim() : (a.notes || null);
      const ts = `${a.date} 12:00:00`;
      await db.execute(sql`
        INSERT INTO additional_pay (company_id, user_id, amount, type, notes, status, created_at)
        SELECT ${PHES}, ${EID}, ${a.amount}, ${a.type}, ${notesWithHours}, 'paid', ${ts}::timestamp
        WHERE NOT EXISTS (
          SELECT 1 FROM additional_pay
          WHERE company_id=${PHES} AND user_id=${EID}
            AND amount=${a.amount}
            AND type=${a.type}
            AND created_at::date = ${a.date}::date
        )
      `);
    }

    // ── Section 9: Contact tickets (5 complaints) ────────────────────────────
    type TicketRow = { created_date: string; job_date: string; notes: string };
    const tickets: TicketRow[] = [
      { created_date: "2026-03-21", job_date: "2026-03-20", notes: "Client complained bathroom was not done even though more important than powder room. Cabinets still had dust." },
      { created_date: "2026-02-25", job_date: "2026-02-24", notes: "Loves Alejandra's cleaning but this time didn't finish one bathroom, forgot the other, left one hour early. Resolution: gave free hour for next service." },
      { created_date: "2025-12-21", job_date: "2025-12-20", notes: "Missed spots on counters, dust still present, kitchen island cabinets not wiped. Oven sprayed but not cleaned. Client had to clean next day themselves. Has pictures if needed." },
      { created_date: "2025-11-21", job_date: "2025-11-21", notes: "Arrived early, nice and polite, worked fast. Cleaning slightly below expectation. (Logged by franciscojestevezs@gmail.com)" },
      { created_date: "2025-10-27", job_date: "2025-10-23", notes: "Adam mentioned some areas were missed and cleaning was not up to usual standards." },
    ];
    for (const t of tickets) {
      const fullNotes = `[Job date: ${t.job_date}] ${t.notes}`;
      await db.execute(sql`
        INSERT INTO contact_tickets (company_id, user_id, ticket_type, notes, created_at)
        SELECT ${PHES}, ${EID}, 'complaint_poor_cleaning'::contact_ticket_type, ${fullNotes}, ${t.created_date}::date
        WHERE NOT EXISTS (
          SELECT 1 FROM contact_tickets
          WHERE company_id=${PHES} AND user_id=${EID}
            AND created_at::date = ${t.created_date}::date
            AND ticket_type = 'complaint_poor_cleaning'
        )
      `);
    }

    // ── Section 10: Productivity metrics ─────────────────────────────────────
    type ProdRow = { scope_slug: string; productivity_pct: number };
    const productivity: ProdRow[] = [
      { scope_slug: "deep-clean-move-in-out",   productivity_pct: 123 },
      { scope_slug: "commercial-cleaning",       productivity_pct: 164 },
      { scope_slug: "hourly-deep-clean",         productivity_pct: 113 },
      { scope_slug: "hourly-standard-cleaning",  productivity_pct: 123 },
      { scope_slug: "one-time-standard",         productivity_pct: 167 },
      { scope_slug: "ppm-common-areas",          productivity_pct: 138 },
      { scope_slug: "ppm-turnover",              productivity_pct: 0   },
      { scope_slug: "recurring-cleaning",        productivity_pct: 161 },
    ];
    for (const p of productivity) {
      await db.execute(sql`
        INSERT INTO employee_productivity
          (company_id, employee_id, scope_slug, productivity_pct, period_start, period_end)
        VALUES
          (${PHES}, ${EID}, ${p.scope_slug}, ${p.productivity_pct}, '2025-09-27', '2026-03-14')
        ON CONFLICT (company_id, employee_id, scope_slug) DO UPDATE SET
          productivity_pct = EXCLUDED.productivity_pct,
          period_start     = EXCLUDED.period_start,
          period_end       = EXCLUDED.period_end
      `);
    }

    // ── Section 11: Attendance stats ─────────────────────────────────────────
    await db.execute(sql`
      INSERT INTO employee_attendance_stats
        (company_id, employee_id, period_start, period_end,
         scheduled, worked, absent, time_off, excused, unexcused, paid_time_off, sick, late, score)
      VALUES
        (${PHES}, ${EID}, '2025-09-25', '2026-03-24',
         129, 119, 16, 15, 0, 1, 0, 4, 17, 79)
      ON CONFLICT (company_id, employee_id, period_start, period_end) DO UPDATE SET
        scheduled    = 129, worked = 119, absent = 16, time_off = 15,
        excused      = 0,   unexcused = 1, paid_time_off = 0, sick = 4,
        late         = 17, score = 79
    `);

    console.log("[alecuervo-migration] All sections complete: core, employment, PTO, pay, additional pay, tickets, productivity, attendance");
  } catch (err) {
    console.error("[alecuervo-migration] Migration error (non-fatal):", err);
  }
}
