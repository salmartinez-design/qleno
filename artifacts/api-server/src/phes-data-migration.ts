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

// ── Booking Schema Guard ──────────────────────────────────────────────────────
// Ensures all columns/tables used by the booking widget and rate-lock system
// exist in the database. Each statement is wrapped individually so a single
// failure never blocks the rest. This runs before Drizzle ORM queries so that
// raw SQL inserts in the booking route can never fail with "column does not exist".
async function runBookingSchemaGuard(): Promise<void> {
  const guards: Array<{ label: string; stmt: string }> = [
    // ── jobs extra columns ──────────────────────────────────────────────────
    { label: "jobs.home_condition_rating", stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS home_condition_rating INTEGER" },
    { label: "jobs.condition_multiplier",  stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS condition_multiplier NUMERIC(5,3)" },
    { label: "jobs.applied_bundle_id",     stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS applied_bundle_id INTEGER" },
    { label: "jobs.bundle_discount_total", stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS bundle_discount_total NUMERIC(10,2)" },
    { label: "jobs.last_cleaned_response", stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_cleaned_response TEXT" },
    { label: "jobs.last_cleaned_flag",     stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_cleaned_flag TEXT" },
    { label: "jobs.overage_disclaimer_acknowledged", stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS overage_disclaimer_acknowledged BOOLEAN DEFAULT false" },
    { label: "jobs.overage_rate",          stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS overage_rate NUMERIC(10,2)" },
    { label: "jobs.upsell_shown",          stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS upsell_shown BOOLEAN DEFAULT false" },
    { label: "jobs.upsell_accepted",       stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS upsell_accepted BOOLEAN DEFAULT false" },
    { label: "jobs.upsell_declined",       stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS upsell_declined BOOLEAN DEFAULT false" },
    { label: "jobs.upsell_deferred",       stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS upsell_deferred BOOLEAN DEFAULT false" },
    { label: "jobs.upsell_cadence_selected", stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS upsell_cadence_selected TEXT" },
    { label: "jobs.property_vacant",       stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS property_vacant BOOLEAN DEFAULT false" },
    { label: "jobs.arrival_window",        stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS arrival_window TEXT" },
    { label: "jobs.first_recurring_discounted", stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS first_recurring_discounted BOOLEAN DEFAULT false" },
    { label: "jobs.booking_location",          stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS booking_location TEXT" },
    { label: "jobs.booking_street",            stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS booking_street TEXT" },
    { label: "jobs.booking_unit",              stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS booking_unit TEXT" },
    { label: "jobs.booking_city",              stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS booking_city TEXT" },
    { label: "jobs.booking_state",             stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS booking_state TEXT" },
    { label: "jobs.booking_zip",               stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS booking_zip TEXT" },
    { label: "jobs.booking_apt",               stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS booking_apt TEXT" },
    { label: "jobs.preferred_contact_method",  stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS preferred_contact_method TEXT" },
    { label: "jobs.address_line2",             stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS address_line2 TEXT" },
    { label: "jobs.branch",                    stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS branch TEXT" },
    { label: "jobs.reminder_72h_sent",         stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS reminder_72h_sent BOOLEAN DEFAULT false" },
    { label: "jobs.reminder_24h_sent",         stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS reminder_24h_sent BOOLEAN DEFAULT false" },
    { label: "jobs.office_notes",              stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS office_notes TEXT" },
    // ── quotes extra columns ────────────────────────────────────────────────
    { label: "quotes.call_notes",              stmt: "ALTER TABLE quotes ADD COLUMN IF NOT EXISTS call_notes TEXT" },
    { label: "quotes.alternate_options",       stmt: "ALTER TABLE quotes ADD COLUMN IF NOT EXISTS alternate_options JSONB" },
    { label: "quotes.zone_override",           stmt: "ALTER TABLE quotes ADD COLUMN IF NOT EXISTS zone_override BOOLEAN DEFAULT FALSE" },
    // ── service_zones extra columns ─────────────────────────────────────────
    { label: "service_zones.location",         stmt: "ALTER TABLE service_zones ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT 'oak_lawn'" },
    // ── rate_locks table ────────────────────────────────────────────────────
    { label: "CREATE rate_locks", stmt: `
      CREATE TABLE IF NOT EXISTS rate_locks (
        id                    SERIAL PRIMARY KEY,
        company_id            INTEGER NOT NULL,
        client_id             INTEGER NOT NULL,
        recurring_schedule_id INTEGER,
        locked_rate           NUMERIC(10,2) NOT NULL,
        cadence               TEXT,
        lock_start_date       DATE,
        lock_expires_at       DATE,
        active                BOOLEAN NOT NULL DEFAULT true,
        void_reason           TEXT,
        voided_at             TIMESTAMPTZ,
        renewal_alert_30_sent BOOLEAN NOT NULL DEFAULT false,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    // ── offer_settings table ────────────────────────────────────────────────
    { label: "CREATE offer_settings", stmt: `
      CREATE TABLE IF NOT EXISTS offer_settings (
        id                        SERIAL PRIMARY KEY,
        company_id                INTEGER NOT NULL UNIQUE,
        overrun_threshold_percent NUMERIC(5,2) DEFAULT 20,
        overrun_jobs_trigger      INTEGER DEFAULT 2,
        service_gap_days          INTEGER DEFAULT 60,
        rate_lock_duration_months INTEGER DEFAULT 24,
        renewal_alert_days        INTEGER DEFAULT 30
      )
    ` },
    // ── booking_settings table ──────────────────────────────────────────────
    { label: "CREATE booking_settings", stmt: `
      CREATE TABLE IF NOT EXISTS booking_settings (
        id                SERIAL PRIMARY KEY,
        company_id        INTEGER NOT NULL UNIQUE,
        booking_lead_days INTEGER NOT NULL DEFAULT 7,
        max_advance_days  INTEGER NOT NULL DEFAULT 60,
        available_sun     BOOLEAN NOT NULL DEFAULT false,
        available_mon     BOOLEAN NOT NULL DEFAULT true,
        available_tue     BOOLEAN NOT NULL DEFAULT true,
        available_wed     BOOLEAN NOT NULL DEFAULT true,
        available_thu     BOOLEAN NOT NULL DEFAULT true,
        available_fri     BOOLEAN NOT NULL DEFAULT true,
        available_sat     BOOLEAN NOT NULL DEFAULT false,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    // ── leads table ─────────────────────────────────────────────────────────
    { label: "CREATE leads", stmt: `
      CREATE TABLE IF NOT EXISTS leads (
        id             SERIAL PRIMARY KEY,
        company_id     INTEGER NOT NULL,
        first_name     TEXT,
        last_name      TEXT,
        phone          TEXT,
        email          TEXT,
        sqft           INTEGER,
        address        TEXT,
        message        TEXT,
        condition_flag TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    // ── follow_up_sequences table ────────────────────────────────────────────
    { label: "CREATE follow_up_sequences", stmt: `
      CREATE TABLE IF NOT EXISTS follow_up_sequences (
        id            SERIAL PRIMARY KEY,
        company_id    INTEGER NOT NULL,
        sequence_type TEXT NOT NULL,
        name          TEXT NOT NULL,
        is_active     BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    // ── follow_up_steps table ────────────────────────────────────────────────
    { label: "CREATE follow_up_steps", stmt: `
      CREATE TABLE IF NOT EXISTS follow_up_steps (
        id               SERIAL PRIMARY KEY,
        sequence_id      INTEGER NOT NULL,
        step_number      INTEGER NOT NULL,
        delay_hours      INTEGER NOT NULL,
        channel          TEXT NOT NULL,
        subject          TEXT,
        message_template TEXT NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    // ── follow_up_enrollments table ──────────────────────────────────────────
    { label: "CREATE follow_up_enrollments", stmt: `
      CREATE TABLE IF NOT EXISTS follow_up_enrollments (
        id             SERIAL PRIMARY KEY,
        company_id     INTEGER NOT NULL,
        sequence_id    INTEGER NOT NULL,
        quote_id       INTEGER,
        client_id      INTEGER,
        current_step   INTEGER NOT NULL DEFAULT 1,
        enrolled_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        next_fire_at   TIMESTAMPTZ NOT NULL,
        completed_at   TIMESTAMPTZ,
        stopped_at     TIMESTAMPTZ,
        stopped_reason TEXT
      )
    ` },
    // ── message_log table ────────────────────────────────────────────────────
    { label: "CREATE message_log", stmt: `
      CREATE TABLE IF NOT EXISTS message_log (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER NOT NULL,
        enrollment_id   INTEGER NOT NULL,
        client_id       INTEGER,
        channel         TEXT NOT NULL,
        recipient_phone TEXT,
        recipient_email TEXT,
        subject         TEXT,
        body            TEXT NOT NULL,
        status          TEXT NOT NULL,
        sequence_name   TEXT,
        step_number     INTEGER,
        sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },

    // ── clients: card + payment columns ──────────────────────────────────────
    { label: "clients.card_last_four",           stmt: `ALTER TABLE clients ADD COLUMN IF NOT EXISTS card_last_four TEXT` },
    { label: "clients.card_brand",               stmt: `ALTER TABLE clients ADD COLUMN IF NOT EXISTS card_brand TEXT` },
    { label: "clients.card_expiry",              stmt: `ALTER TABLE clients ADD COLUMN IF NOT EXISTS card_expiry TEXT` },
    { label: "clients.card_saved_at",            stmt: `ALTER TABLE clients ADD COLUMN IF NOT EXISTS card_saved_at TIMESTAMP` },
    { label: "clients.stripe_payment_method_id", stmt: `ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_payment_method_id TEXT` },
    { label: "clients.payment_source",           stmt: `ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_source TEXT` },
    { label: "clients.referral_source",          stmt: `ALTER TABLE clients ADD COLUMN IF NOT EXISTS referral_source TEXT` },

    // ── leads: extended columns added after initial schema ───────────────────
    { label: "leads.status",            stmt: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'new'` },
    { label: "leads.source",            stmt: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS source TEXT` },
    { label: "leads.updated_at",        stmt: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ` },
    { label: "leads.construction_type", stmt: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS construction_type TEXT` },
    { label: "leads.completion_date",   stmt: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS completion_date TEXT` },
    { label: "leads.lead_type",         stmt: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_type TEXT DEFAULT 'standard'` },
    { label: "leads.notes",             stmt: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT` },

    // ── Commission Engine columns (2026-04-08) ───────────────────────────────
    { label: "jobs.job_type",                stmt: `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_type TEXT DEFAULT 'residential'` },
    { label: "jobs.commission_pool_rate",    stmt: `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS commission_pool_rate NUMERIC(5,4)` },
    { label: "jobs.estimated_hours_per_tech",stmt: `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS estimated_hours_per_tech NUMERIC(6,2)` },

    // ── job_technicians table ────────────────────────────────────────────────
    { label: "CREATE job_technicians", stmt: `
      CREATE TABLE IF NOT EXISTS job_technicians (
        id           SERIAL PRIMARY KEY,
        job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_id   INTEGER NOT NULL,
        is_primary   BOOLEAN NOT NULL DEFAULT false,
        pay_override NUMERIC(10,2),
        final_pay    NUMERIC(10,2),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (job_id, user_id)
      )
    ` },
    { label: "CREATE idx_job_technicians_job_id", stmt: `CREATE INDEX IF NOT EXISTS idx_job_technicians_job_id ON job_technicians(job_id)` },
    { label: "CREATE idx_job_technicians_user_id", stmt: `CREATE INDEX IF NOT EXISTS idx_job_technicians_user_id ON job_technicians(user_id)` },
  ];

  for (const { label, stmt } of guards) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (err: any) {
      console.warn(`[schema-guard] ${label} — non-fatal:`, err?.message ?? err);
    }
  }
  console.log("[schema-guard] Booking schema guard complete.");
}

// ── Scope + Zone cleanup (idempotent) ────────────────────────────────────────
async function runScopeZoneFix(): Promise<void> {
  // 1. Deactivate legacy combined "Deep Clean or Move In/Out" scope (production only)
  await db.execute(sql`
    UPDATE pricing_scopes
    SET is_active = false
    WHERE company_id = ${PHES}
      AND name = 'Deep Clean or Move In/Out'
  `);

  // 2. Deactivate old standalone "Recurring Cleaning" (Residential group, no sub-frequencies)
  //    The recurring sub-frequencies have scope_group='Recurring Cleaning', keep those.
  await db.execute(sql`
    UPDATE pricing_scopes
    SET is_active = false
    WHERE company_id = ${PHES}
      AND name = 'Recurring Cleaning'
      AND scope_group != 'Recurring Cleaning'
  `);

  // 3. Ensure service_zones has location column (idempotent)
  await db.execute(sql`ALTER TABLE service_zones ADD COLUMN IF NOT EXISTS location TEXT DEFAULT 'oak_lawn'`);
  await db.execute(sql`ALTER TABLE service_zones ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#6B6860'`);

  // 4. Add 60805 (Evergreen Park) to the Southwest Zone or Company Zone if missing
  //    First try a named match; if 60805 still not in any zone, add to first oak_lawn zone.
  await db.execute(sql`
    UPDATE service_zones
    SET zip_codes = array_append(zip_codes, '60805')
    WHERE id = (
      SELECT id FROM service_zones
      WHERE company_id = ${PHES}
        AND (name ILIKE '%southwest%' OR name ILIKE '%company zone%' OR name ILIKE '%oak lawn%')
        AND NOT ('60805' = ANY(zip_codes))
      ORDER BY id LIMIT 1
    )
  `);
  // Fallback: add to first oak_lawn zone if 60805 is still not in any zone
  await db.execute(sql`
    UPDATE service_zones
    SET zip_codes = array_append(zip_codes, '60805')
    WHERE id = (
      SELECT id FROM service_zones
      WHERE company_id = ${PHES}
        AND location = 'oak_lawn'
        AND is_active = true
        AND NOT ('60805' = ANY(zip_codes))
      ORDER BY id LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM service_zones
      WHERE company_id = ${PHES} AND '60805' = ANY(zip_codes)
    )
  `);

  // 5. Create Schaumburg zone with key zips if none exist for this company
  await db.execute(sql`
    INSERT INTO service_zones (company_id, name, location, zip_codes, color, is_active)
    SELECT ${PHES}, 'Schaumburg / Palatine / Arlington Heights', 'schaumburg',
           ARRAY['60173','60194','60195','60196','60107','60169','60159','60168',
                 '60004','60005','60006','60007','60008','60067','60070','60074',
                 '60090','60192','60193','60010','60011'],
           '#C96969', true
    WHERE NOT EXISTS (
      SELECT 1 FROM service_zones
      WHERE company_id = ${PHES}
        AND location = 'schaumburg'
        AND '60173' = ANY(zip_codes)
    )
  `);

  console.log("[scope-zone-fix] Completed.");
}

// ── Addon visibility + price fix (2026-03-31) ─────────────────────────────────
// Idempotent: hides admin-only and discount add-ons from the online widget,
// and ensures correct prices for the 5 customer-facing add-ons.
async function runAddonFix(): Promise<void> {
  // Hide baseboards (all variants) + correct price to $30
  await db.execute(sql`
    UPDATE pricing_addons SET show_online = false, price_value = 30
    WHERE company_id = ${PHES} AND name ILIKE '%baseboard%' AND price_type = 'flat'
  `);
  await db.execute(sql`
    UPDATE pricing_addons SET show_online = false
    WHERE company_id = ${PHES} AND name ILIKE '%baseboard%' AND price_type != 'flat'
  `);
  // Hide loyalty, promo, discount, adjustment, second-appointment, commercial, parking
  await db.execute(sql`
    UPDATE pricing_addons SET show_online = false
    WHERE company_id = ${PHES} AND (
      name ILIKE '%loyalty%' OR
      name ILIKE '%promo%' OR
      name ILIKE '%discount%' OR
      name ILIKE '%adjustment%' OR
      name ILIKE '%second appointment%' OR
      name ILIKE '%commercial adjust%' OR
      name ILIKE '%parking%'
    )
  `);
  // Hide all hourly time-add variants from online widget
  await db.execute(sql`
    UPDATE pricing_addons SET show_online = false
    WHERE company_id = ${PHES} AND (name ILIKE '%hourly%' OR name ILIKE '%time add%' OR price_type = 'time_only')
  `);
  // Correct prices for the 5 customer-facing add-ons
  await db.execute(sql`
    UPDATE pricing_addons SET price_value = 50, price_type = 'flat'
    WHERE company_id = ${PHES} AND name ILIKE '%oven%' AND name NOT ILIKE '%hourly%'
  `);
  await db.execute(sql`
    UPDATE pricing_addons SET price_value = 50, price_type = 'flat'
    WHERE company_id = ${PHES} AND name ILIKE '%refrigerator%' AND name NOT ILIKE '%hourly%'
  `);
  await db.execute(sql`
    UPDATE pricing_addons SET price_value = 50, price_type = 'flat'
    WHERE company_id = ${PHES} AND name ILIKE '%cabinet%' AND name NOT ILIKE '%hourly%'
  `);
  await db.execute(sql`
    UPDATE pricing_addons SET price_value = 15, price_type = 'percentage'
    WHERE company_id = ${PHES} AND name ILIKE '%window%' AND name NOT ILIKE '%hourly%'
  `);
  await db.execute(sql`
    UPDATE pricing_addons SET price_value = 15, price_type = 'percentage'
    WHERE company_id = ${PHES} AND name ILIKE '%basement%' AND name NOT ILIKE '%hourly%'
  `);
  // Map addons from old scope 1 ("Deep Clean or Move In/Out") to new scopes 11 (Deep Clean) + 12 (Move In/Out)
  // scope_ids is stored as JSON text like "[1,2,3]" — append new IDs idempotently
  await db.execute(sql`
    UPDATE pricing_addons
    SET scope_ids = (scope_ids::jsonb || '[11]'::jsonb)::text
    WHERE company_id = ${PHES}
      AND scope_ids::jsonb @> '[1]'::jsonb
      AND NOT (scope_ids::jsonb @> '[11]'::jsonb)
  `);
  await db.execute(sql`
    UPDATE pricing_addons
    SET scope_ids = (scope_ids::jsonb || '[12]'::jsonb)::text
    WHERE company_id = ${PHES}
      AND scope_ids::jsonb @> '[1]'::jsonb
      AND NOT (scope_ids::jsonb @> '[12]'::jsonb)
  `);
  console.log("[addon-fix] Completed.");
}

export async function runPhesDataMigration(): Promise<void> {
  await runBookingSchemaGuard();

  try {
    await runScopeZoneFix();
  } catch (err: any) {
    console.warn("[phes-migration] scope-zone-fix — non-fatal:", err?.message ?? err);
  }

  try {
    await runAddonFix();
  } catch (err: any) {
    console.warn("[phes-migration] addon-fix — non-fatal:", err?.message ?? err);
  }

  // ── Seed booking_settings for PHES (company_id=1) ──────────────────────────
  try {
    await db.execute(sql`
      INSERT INTO booking_settings
        (company_id, booking_lead_days, max_advance_days,
         available_sun, available_mon, available_tue, available_wed,
         available_thu, available_fri, available_sat)
      VALUES
        (${PHES}, 7, 60, false, true, true, true, true, true, false)
      ON CONFLICT (company_id) DO NOTHING
    `);
  } catch (err: any) {
    console.warn("[phes-migration] booking_settings seed — non-fatal:", err?.message ?? err);
  }

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
    // NOTE: "Recurring Cleaning" kept for backward-compat with scope 11 (inactive)
    // Active recurring scopes are: Recurring Cleaning - Weekly/Every 2 Weeks/Every 4 Weeks
    const scopeDefs = [
      { name: "Deep Clean",                          method: "sqft",   rate: "70.00", min: "210.00" },
      { name: "Move In / Move Out",                  method: "sqft",   rate: "70.00", min: "210.00" },
      { name: "One-Time Standard Clean",             method: "sqft",   rate: "60.00", min: "150.00" },
      { name: "Recurring Cleaning",                  method: "sqft",   rate: "55.00", min: "120.00" },
      { name: "Hourly Deep Clean",                   method: "hourly", rate: "70.00", min: "210.00" },
      { name: "Hourly Standard Cleaning",            method: "hourly", rate: "60.00", min: "150.00" },
      { name: "Commercial Cleaning",                 method: "hourly", rate: "65.00", min: "200.00" },
      { name: "PPM Turnover",                       method: "sqft",   rate: "65.00", min: "250.00" },
      // Recurring variants — each with a single frequency (handled in separate block below)
      { name: "Recurring Cleaning - Weekly",         method: "sqft",   rate: "55.00", min: "180.00", noDefaultFreqs: true, scopeGroup: "Recurring Cleaning" },
      { name: "Recurring Cleaning - Every 2 Weeks",  method: "sqft",   rate: "60.00", min: "195.00", noDefaultFreqs: true, scopeGroup: "Recurring Cleaning" },
      { name: "Recurring Cleaning - Every 4 Weeks",  method: "sqft",   rate: "65.00", min: "210.00", noDefaultFreqs: true, scopeGroup: "Recurring Cleaning" },
    ] as Array<{ name: string; method: string; rate: string; min: string; noDefaultFreqs?: boolean; scopeGroup?: string }>;

    for (const s of scopeDefs) {
      if (s.scopeGroup) {
        await db.execute(sql`
          INSERT INTO pricing_scopes
            (company_id, name, pricing_method, hourly_rate, minimum_bill,
             displayed_for_office, is_active, scope_group, sort_order)
          SELECT ${PHES}, ${s.name}, ${s.method}, ${s.rate}, ${s.min}, true, true,
                 ${s.scopeGroup},
                 (SELECT COALESCE(MAX(sort_order),0)+1 FROM pricing_scopes WHERE company_id=${PHES})
          WHERE NOT EXISTS (
            SELECT 1 FROM pricing_scopes WHERE company_id=${PHES} AND name=${s.name}
          )
        `);
      } else {
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
    }

    // Ensure Recurring Weekly minimum_bill = $180.00 (3 hrs × $60/hr)
    await db.execute(sql`
      UPDATE pricing_scopes
      SET minimum_bill = 180.00
      WHERE company_id = ${PHES} AND name = 'Recurring Cleaning - Weekly' AND minimum_bill != 180.00
    `);
    // Ensure Recurring Monthly minimum_bill = $210.00 (3 hrs × $70/hr)
    await db.execute(sql`
      UPDATE pricing_scopes
      SET minimum_bill = 210.00
      WHERE company_id = ${PHES} AND name = 'Recurring Cleaning - Every 4 Weeks' AND minimum_bill != 210.00
    `);

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

    for (const s of scopeDefs) {
      if (s.noDefaultFreqs) continue; // recurring variants handled separately
      const sid = scopeMap[s.name];
      if (!sid) continue;
      const freqList = s.method === "sqft" ? sqftFreqs : hourlyFreqs;
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
    // Seed exactly one frequency per recurring variant scope
    const recurringVariants = [
      { name: "Recurring Cleaning - Weekly",        freq: "weekly",   label: "Weekly",        mult: "1.0" },
      { name: "Recurring Cleaning - Every 2 Weeks", freq: "biweekly", label: "Every 2 Weeks",  mult: "1.0" },
      { name: "Recurring Cleaning - Every 4 Weeks", freq: "monthly",  label: "Every 4 Weeks",  mult: "1.0" },
    ];
    for (const rv of recurringVariants) {
      const sid = scopeMap[rv.name];
      if (!sid) continue;
      if (existingFreqSet.has(`${sid}:${rv.freq}`)) continue;
      await db.execute(sql`
        INSERT INTO pricing_frequencies
          (company_id, scope_id, frequency, multiplier, rate_override, label, show_office, sort_order)
        VALUES
          (${PHES}, ${sid}, ${rv.freq}, ${rv.mult}, NULL, ${rv.label}, true, 1)
        ON CONFLICT DO NOTHING
      `);
    }
    console.log("[phes-migration] Frequencies ensured for all scopes");

    // ── 4c. Seed pricing tiers for each scope (idempotent — only inserts if scope has 0 tiers) ───
    type TierRow = { min: number; max: number; hours: string };
    const dcTiers: TierRow[] = [
      { min: 0,    max: 749,  hours: "3.00" }, { min: 750,  max: 999,  hours: "3.20" },
      { min: 1000, max: 1249, hours: "5.20" }, { min: 1250, max: 1499, hours: "6.00" },
      { min: 1500, max: 1749, hours: "6.20" }, { min: 1750, max: 1999, hours: "6.50" },
      { min: 2000, max: 2249, hours: "7.60" }, { min: 2250, max: 2499, hours: "8.00" },
      { min: 2500, max: 2749, hours: "8.00" }, { min: 2750, max: 2999, hours: "8.40" },
      { min: 3000, max: 3249, hours: "9.50" }, { min: 3250, max: 3499, hours: "10.00" },
      { min: 3500, max: 3749, hours: "10.50" }, { min: 3750, max: 3999, hours: "11.00" },
      { min: 4000, max: 4249, hours: "13.00" }, { min: 4250, max: 4499, hours: "14.00" },
      { min: 4500, max: 4749, hours: "16.00" }, { min: 4750, max: 5000, hours: "18.00" },
      { min: 5001, max: 5500, hours: "20.00" }, { min: 5501, max: 6000, hours: "29.00" },
    ];
    const stdTiers: TierRow[] = [
      { min: 0,    max: 749,  hours: "2.50" }, { min: 750,  max: 999,  hours: "3.00" },
      { min: 1000, max: 1249, hours: "3.30" }, { min: 1250, max: 1499, hours: "3.50" },
      { min: 1500, max: 1749, hours: "3.70" }, { min: 1750, max: 1999, hours: "3.80" },
      { min: 2000, max: 2249, hours: "4.20" }, { min: 2250, max: 2499, hours: "4.50" },
      { min: 2500, max: 2749, hours: "5.00" }, { min: 2750, max: 2999, hours: "5.50" },
      { min: 3000, max: 3249, hours: "7.00" }, { min: 3250, max: 3499, hours: "7.60" },
      { min: 3500, max: 3749, hours: "8.00" }, { min: 3750, max: 3999, hours: "8.50" },
      { min: 4000, max: 4249, hours: "9.20" }, { min: 4250, max: 4499, hours: "9.80" },
      { min: 4500, max: 4749, hours: "10.00" }, { min: 4750, max: 4999, hours: "10.50" },
      { min: 5000, max: 5249, hours: "11.00" }, { min: 5250, max: 5499, hours: "11.50" },
    ];
    const otscTiers: TierRow[] = [
      { min: 0,    max: 749,  hours: "2.50" }, { min: 750,  max: 999,  hours: "3.00" },
      { min: 1000, max: 1249, hours: "3.30" }, { min: 1250, max: 1499, hours: "3.50" },
      { min: 1500, max: 1749, hours: "3.70" }, { min: 1750, max: 1999, hours: "3.80" },
      { min: 2000, max: 2249, hours: "4.20" }, { min: 2250, max: 2499, hours: "4.50" },
      { min: 2500, max: 2749, hours: "5.00" }, { min: 2750, max: 3499, hours: "5.50" },
      { min: 3500, max: 3749, hours: "8.00" }, { min: 3750, max: 3999, hours: "8.50" },
      { min: 4000, max: 4249, hours: "9.20" }, { min: 4250, max: 4499, hours: "9.80" },
      { min: 4500, max: 4749, hours: "10.00" }, { min: 4750, max: 4999, hours: "10.50" },
      { min: 5000, max: 5249, hours: "11.00" }, { min: 5250, max: 6000, hours: "11.50" },
    ];
    const ppmTiers: TierRow[] = [
      { min: 1000, max: 1200, hours: "5.20" }, { min: 1200, max: 1400, hours: "6.00" },
      { min: 1400, max: 1600, hours: "7.00" }, { min: 1600, max: 1800, hours: "8.00" },
      { min: 1800, max: 2000, hours: "9.00" }, { min: 2000, max: 2200, hours: "10.00" },
      { min: 2200, max: 2400, hours: "11.20" }, { min: 2400, max: 2600, hours: "12.40" },
      { min: 2600, max: 2800, hours: "13.60" }, { min: 2800, max: 3000, hours: "14.80" },
      { min: 3000, max: 3200, hours: "16.00" }, { min: 3200, max: 3400, hours: "17.40" },
      { min: 3400, max: 3600, hours: "18.80" }, { min: 3600, max: 3800, hours: "20.20" },
      { min: 3800, max: 4000, hours: "21.60" }, { min: 4000, max: 4400, hours: "23.20" },
      { min: 4400, max: 4800, hours: "25.00" }, { min: 4800, max: 5200, hours: "26.60" },
      { min: 5200, max: 5600, hours: "28.00" }, { min: 5600, max: 6000, hours: "29.00" },
    ];
    const recurWeeklyTiers: TierRow[] = [
      { min: 0,    max: 749,  hours: "2.90" }, { min: 750,  max: 999,  hours: "2.91" },
      { min: 1000, max: 1249, hours: "3.00" }, { min: 1250, max: 1499, hours: "3.18" },
      { min: 1500, max: 1749, hours: "3.30" }, { min: 1750, max: 1999, hours: "3.82" },
      { min: 2000, max: 2249, hours: "4.00" }, { min: 2250, max: 2499, hours: "4.50" },
      { min: 2500, max: 2749, hours: "5.00" }, { min: 2750, max: 3499, hours: "5.45" },
      { min: 3500, max: 3749, hours: "5.45" }, { min: 3750, max: 3999, hours: "7.00" },
      { min: 4000, max: 4999, hours: "9.50" }, { min: 5000, max: 5499, hours: "11.00" },
    ];
    const recurBiweeklyTiers: TierRow[] = [
      { min: 0,    max: 749,  hours: "3.00" }, { min: 750,  max: 999,  hours: "3.00" },
      { min: 1000, max: 1249, hours: "3.10" }, { min: 1250, max: 1499, hours: "3.27" },
      { min: 1500, max: 1749, hours: "3.45" }, { min: 1750, max: 1999, hours: "4.00" },
      { min: 2000, max: 2249, hours: "4.09" }, { min: 2250, max: 2499, hours: "4.70" },
      { min: 2500, max: 2749, hours: "5.27" }, { min: 2750, max: 3499, hours: "5.60" },
      { min: 3500, max: 3749, hours: "6.20" }, { min: 3750, max: 3999, hours: "7.27" },
      { min: 4000, max: 4999, hours: "10.00" }, { min: 5000, max: 5499, hours: "12.00" },
    ];
    const recurMonthlyTiers: TierRow[] = [
      { min: 0,    max: 749,  hours: "3.09" }, { min: 750,  max: 999,  hours: "3.09" },
      { min: 1000, max: 1249, hours: "3.20" }, { min: 1250, max: 1499, hours: "3.45" },
      { min: 1500, max: 1749, hours: "3.54" }, { min: 1750, max: 1999, hours: "4.18" },
      { min: 2000, max: 2249, hours: "4.54" }, { min: 2250, max: 2499, hours: "5.00" },
      { min: 2500, max: 2749, hours: "5.45" }, { min: 2750, max: 3499, hours: "6.00" },
      { min: 3500, max: 3749, hours: "6.60" }, { min: 3750, max: 3999, hours: "8.00" },
      { min: 4000, max: 4999, hours: "10.50" }, { min: 5000, max: 5499, hours: "13.00" },
    ];

    const tierSeedMap: Array<{ scopeName: string; tiers: TierRow[] }> = [
      { scopeName: "Deep Clean",                         tiers: dcTiers },
      { scopeName: "Move In / Move Out",                 tiers: dcTiers },
      { scopeName: "Standard Clean",                     tiers: stdTiers },
      { scopeName: "One-Time Standard Clean",            tiers: otscTiers },
      { scopeName: "PPM Turnover",                       tiers: ppmTiers },
      { scopeName: "Recurring Cleaning - Weekly",        tiers: recurWeeklyTiers },
      { scopeName: "Recurring Cleaning - Every 2 Weeks", tiers: recurBiweeklyTiers },
      { scopeName: "Recurring Cleaning - Every 4 Weeks", tiers: recurMonthlyTiers },
    ];

    let tiersSeeded = 0;
    for (const { scopeName, tiers } of tierSeedMap) {
      const sid = scopeMap[scopeName];
      if (!sid) continue;
      const countRes = await db.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM pricing_tiers WHERE scope_id = ${sid} AND company_id = ${PHES}
      `);
      const existingCount = parseInt(((countRes as any).rows ?? [{}])[0]?.cnt ?? "0");
      if (existingCount > 0) continue; // already has tiers
      for (const t of tiers) {
        await db.execute(sql`
          INSERT INTO pricing_tiers (scope_id, company_id, min_sqft, max_sqft, hours)
          VALUES (${sid}, ${PHES}, ${t.min}, ${t.max}, ${t.hours})
        `);
      }
      tiersSeeded += tiers.length;
    }
    if (tiersSeeded > 0) console.log(`[phes-migration] Pricing tiers seeded: ${tiersSeeded} rows`);
    else console.log("[phes-migration] Pricing tiers already present — skipping.");

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

      const D   = scopeMap["Deep Clean"];
      const MIO = scopeMap["Move In / Move Out"];
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
          scope_ids: [D, MIO, S, R].filter(Boolean),
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
          is_itemized: false, show_office: true, show_online: false, show_portal: true, sort_order: 11,
        },
        {
          name: "Refrigerator Cleaning",
          addon_type: "cleaning_extras",
          scope_ids: [D, MIO, S, R].filter(Boolean),
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
          is_itemized: false, show_office: true, show_online: false, show_portal: true, sort_order: 21,
        },
        {
          name: "Kitchen Cabinets (must be empty upon arrival)",
          addon_type: "cleaning_extras",
          scope_ids: [D, MIO, S].filter(Boolean),
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
          is_itemized: false, show_office: true, show_online: false, show_portal: true, sort_order: 31,
        },
        {
          name: "Baseboards",
          addon_type: "cleaning_extras",
          scope_ids: [S].filter(Boolean),
          price_type: "flat", price_value: 30,
          time_minutes: 45, time_unit: "each",
          is_itemized: true, show_office: true, show_online: false, show_portal: true, sort_order: 40,
        },
        {
          name: "Baseboards — Deep Clean (Sq Ft %)",
          addon_type: "cleaning_extras",
          scope_ids: [HD].filter(Boolean),
          price_type: "sqft_pct", price_value: 12,
          time_minutes: 45, time_unit: "sqft",
          is_itemized: true, show_office: true, show_online: false, show_portal: true, sort_order: 41,
        },
        // Windows — 3 variants
        {
          name: "Windows (inside panes) — Deep Clean",
          addon_type: "cleaning_extras",
          scope_ids: [D, MIO].filter(Boolean),
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
          is_itemized: false, show_office: true, show_online: false, show_portal: true, sort_order: 52,
        },
        // Clean Basement — 3 variants
        {
          name: "Clean Basement — Deep / Standard",
          addon_type: "cleaning_extras",
          scope_ids: [D, MIO, S].filter(Boolean),
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
          is_itemized: false, show_office: true, show_online: false, show_portal: true, sort_order: 62,
        },
        // Parking Fee — all scopes
        {
          name: "Parking Fee",
          addon_type: "cleaning_extras",
          scope_ids: [D, MIO, S, R, HD, HS, C, P].filter(Boolean),
          price_type: "flat", price_value: 20,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: false, show_portal: true, sort_order: 70,
        },
        // Manual Adjustment (replaces MC $1 increment hack)
        {
          name: "Manual Adjustment",
          addon_type: "cleaning_extras",
          scope_ids: [D, MIO, S, R].filter(Boolean),
          price_type: "manual_adj", price_value: 0,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: false, show_portal: false, sort_order: 99,
        },
        // ── DISCOUNTS ────────────────────────────────────────────────────
        {
          name: "Loyalty Discount — $100",
          addon_type: "other",
          scope_ids: [D, MIO, S, R, HS, P].filter(Boolean),
          price_type: "flat", price_value: -100,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: false, show_portal: true, sort_order: 110,
        },
        {
          name: "Loyalty Discount — $50",
          addon_type: "other",
          scope_ids: [D, MIO, S, R, HD, HS, P].filter(Boolean),
          price_type: "flat", price_value: -50,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: false, show_portal: true, sort_order: 111,
        },
        {
          name: "Loyalty Discount — 20% Off",
          addon_type: "other",
          scope_ids: [HD].filter(Boolean),
          price_type: "percentage", price_value: -20,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: false, show_portal: true, sort_order: 112,
        },
        {
          name: "Promo Discount — 10% Off",
          addon_type: "other",
          scope_ids: [S, R, HD, HS, P].filter(Boolean),
          price_type: "percentage", price_value: -10,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: false, show_portal: true, sort_order: 120,
        },
        {
          name: "Promo Discount — 15% Off",
          addon_type: "other",
          scope_ids: [S, HD].filter(Boolean),
          price_type: "percentage", price_value: -15,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: false, show_portal: true, sort_order: 121,
        },
        {
          name: "Second Appointment Discount — 15% Off",
          addon_type: "other",
          scope_ids: [S, HD].filter(Boolean),
          price_type: "percentage", price_value: -15,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: false, show_portal: true, sort_order: 130,
        },
        {
          name: "Second Appointment — +15% (markup)",
          addon_type: "other",
          scope_ids: [HS].filter(Boolean),
          price_type: "percentage", price_value: 15,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: false, show_portal: true, sort_order: 131,
        },
        // Commercial Adjustment
        {
          name: "Commercial Adjustment",
          addon_type: "other",
          scope_ids: [C].filter(Boolean),
          price_type: "percentage", price_value: -100,
          time_minutes: 0, time_unit: "each",
          is_itemized: true, show_office: true, show_online: false, show_portal: true, sort_order: 140,
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

  // Run client job history migrations
  await runDamianJobHistoryMigration();

  // Seed notification templates
  await runNotificationTemplateSeed();
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

// ── Damian Ehrlicher — Job History (18 MC historical records) ─────────────────
async function runDamianJobHistoryMigration() {
  try {
    const PHES = 1;
    const CUSTOMER_ID = 75;

    // First: clean up any duplicate rows (keeping min id per unique job_date/technician/revenue)
    await db.execute(sql`
      DELETE FROM job_history
      WHERE company_id = ${PHES} AND customer_id = ${CUSTOMER_ID}
        AND id NOT IN (
          SELECT MIN(id) FROM job_history
          WHERE company_id = ${PHES} AND customer_id = ${CUSTOMER_ID}
          GROUP BY job_date, technician, revenue
        )
    `);

    const existing = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM job_history
      WHERE company_id = ${PHES} AND customer_id = ${CUSTOMER_ID}
    `);
    const cnt = (existing.rows[0] as any).cnt;
    if (cnt >= 18) {
      console.log(`[damian-migration] Job history already present (${cnt} records after dedup) — skipping`);
      return;
    }

    const records = [
      { job_date: "2026-03-18", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Generic Cleaner",       notes: "3.98h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2025-12-23", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Guadalupe Mejia",       notes: "3.33h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2025-11-26", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Evelyna Resendez",      notes: "3.70h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2025-10-01", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Evelyna Resendez",      notes: "4.25h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2025-09-03", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Guadalupe Mejia",       notes: "3.75h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2025-08-06", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Norma Puga",            notes: "4.73h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2025-06-11", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Norma Puga",            notes: "4.03h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2025-05-14", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Yohana Velasquez",      notes: "5.83h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2025-03-18", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Monica Ruiz",           notes: "4.70h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2025-02-19", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Monica Ruiz",           notes: "4.23h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2025-01-22", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Liz Hernandez",         notes: "5.20h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2024-12-24", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Monica Ruiz",           notes: "4.88h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2024-11-27", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Monica Ruiz",           notes: "4.38h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2024-10-30", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Monica Ruiz",           notes: "4.77h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2024-09-25", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Mercedes Chinchilla",   notes: "3.88h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2024-07-10", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Erika Guevara",         notes: "4.75h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2024-06-12", revenue: "285.60", service_type: "Flat Rate Standard", technician: "Erika Guevara",         notes: "2.77h · add-on: Basement · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
      { job_date: "2024-05-15", revenue: "580.60", service_type: "Hourly Deep Clean or Move In/Out", technician: "Erika Guevara", notes: "5.50h · tech 2: Ana Valdez · add-on: Basement · frequency: On Demand · address: 7251 W Fitch Ave Chicago IL 60631 · source: mc_import" },
    ];

    for (const r of records) {
      await db.execute(sql`
        INSERT INTO job_history (company_id, customer_id, job_date, revenue, service_type, technician, notes)
        VALUES (${PHES}, ${CUSTOMER_ID}, ${r.job_date}::date, ${r.revenue}::numeric, ${r.service_type}, ${r.technician}, ${r.notes})
      `);
    }

    console.log(`[damian-migration] Inserted ${records.length} job history records for client #${CUSTOMER_ID}`);
  } catch (err) {
    console.error("[damian-migration] Migration error (non-fatal):", err);
  }
}

// ── Notification Template Seeding ────────────────────────────────────────────
async function runNotificationTemplateSeed() {
  try {
    const PHES = 1;

    // Ensure DDL columns exist (safe to run repeatedly — each statement is individually guarded)
    const ddlStmts: Array<[string, ReturnType<typeof sql.raw>]> = [
      ["notification_templates.body_html",         sql`ALTER TABLE notification_templates ADD COLUMN IF NOT EXISTS body_html TEXT`],
      ["notification_templates.body_text",          sql`ALTER TABLE notification_templates ADD COLUMN IF NOT EXISTS body_text TEXT`],
      ["notification_log.error_message",            sql`ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS error_message TEXT`],
      ["clients.survey_last_sent",                  sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS survey_last_sent TIMESTAMP`],
      ["companies.review_link",                     sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS review_link TEXT`],
      ["companies.dispatch_start_hour",             sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS dispatch_start_hour INTEGER NOT NULL DEFAULT 8`],
      ["companies.dispatch_end_hour",               sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS dispatch_end_hour INTEGER NOT NULL DEFAULT 18`],
      ["companies.res_tech_pay_pct",                sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS res_tech_pay_pct NUMERIC(5,4) NOT NULL DEFAULT 0.35`],
      ["clients.stripe_payment_method_id",          sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_payment_method_id TEXT`],
      ["clients.payment_source",                    sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_source TEXT`],
      ["payments.job_id",                           sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS job_id INTEGER`],
      ["payments.stripe_error_code",                sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_error_code TEXT`],
      ["payments.stripe_error_message",             sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_error_message TEXT`],
      ["payments.attempted_at",                     sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS attempted_at TIMESTAMP`],
      ["users.reset_token",                         sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT`],
      ["users.reset_token_expires_at",              sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMP`],
      ["jobs.supply_cost",                          sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS supply_cost NUMERIC(8,2) DEFAULT 0.00`],
      ["companies.overhead_rate_pct",               sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS overhead_rate_pct NUMERIC(5,2) DEFAULT 10.00`],
      ["notifications.create_table",                sql`CREATE TABLE IF NOT EXISTS notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id integer NOT NULL, type varchar(50) NOT NULL, title varchar(255) NOT NULL, body text, link varchar(500), meta jsonb, read boolean DEFAULT false, created_at timestamptz DEFAULT now())`],
      ["notifications.idx_company_unread",          sql`CREATE INDEX IF NOT EXISTS idx_notifications_company_unread ON notifications(company_id, read, created_at DESC)`],
    ];
    for (const [label, stmt] of ddlStmts) {
      try {
        await db.execute(stmt);
      } catch (ddlErr: any) {
        console.warn(`[notification-templates] DDL non-fatal (${label}):`, ddlErr?.message ?? ddlErr);
      }
    }

    // Set default review link for PHES
    await db.execute(sql`
      UPDATE companies SET review_link = 'https://g.page/r/phes/review'
      WHERE id = ${PHES} AND review_link IS NULL
    `);

    type TplDef = {
      trigger: string;
      channel: string;
      subject: string | null;
      body_html: string | null;
      body_text: string | null;
    };

    const templates: TplDef[] = [
      // ── 1. REMINDER 3 DAY ───────────────────────────────────────────────
      {
        trigger: "reminder_3day", channel: "email",
        subject: "Your cleaning appointment is coming up \u2014 {{appointment_date}}",
        body_html: `<p style="margin:0 0 20px">Hi {{first_name}},</p>
<p style="margin:0 0 20px">Just a heads-up that your cleaning is scheduled for <strong>{{appointment_date}}</strong>. Here is everything you need to know before we arrive.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E2DC;border-radius:6px;background:#FFFFFF;margin:0 0 24px">
<tr><td style="padding:20px">
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Date</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917;font-weight:600">{{appointment_date}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Arrival Window</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917">{{appointment_window}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Service</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917">{{scope}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Address</p>
  <p style="margin:0;font-size:15px;color:#1A1917">{{service_address}}</p>
</td></tr>
</table>
<p style="margin:0 0 8px;font-weight:600;color:#1A1917">A few things to have ready</p>
<ul style="margin:0 0 20px;padding-left:20px;color:#1A1917;line-height:1.8">
  <li>Countertops and surfaces cleared</li>
  <li>Running water and electricity available</li>
  <li>Pets secured before arrival</li>
  <li>Confirm your entry method is current (key, code, or be home)</li>
</ul>
<p style="margin:0 0 8px;font-weight:600;color:#1A1917">Need to reschedule?</p>
<p style="margin:0 0 24px;color:#1A1917">We require 48 business hours notice to avoid a cancellation fee. Sundays do not count toward that window. Call or text us at <strong>{{company_phone}}</strong> or reply to this email.</p>
<p style="margin:0">We look forward to seeing you.</p>`,
        body_text: "Hi {{first_name}}, your cleaning with {{company_name}} is confirmed for {{appointment_date}}, {{appointment_window}}. Need to reschedule? Call/text {{company_phone}} (48hr notice required).",
      },
      {
        trigger: "reminder_3day", channel: "sms",
        subject: null,
        body_html: null,
        body_text: "Hi {{first_name}}, your cleaning with {{company_name}} is confirmed for {{appointment_date}}, {{appointment_window}}. Need to reschedule? Call/text {{company_phone}} (48hr notice required).",
      },

      // ── 2. REMINDER 1 DAY ───────────────────────────────────────────────
      {
        trigger: "reminder_1day", channel: "email",
        subject: "Your cleaning is tomorrow \u2014 {{appointment_date}}",
        body_html: `<p style="margin:0 0 20px">Hi {{first_name}},</p>
<p style="margin:0 0 20px">Your appointment is tomorrow. Here are your details one more time.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E2DC;border-radius:6px;background:#FFFFFF;margin:0 0 24px">
<tr><td style="padding:20px">
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Date</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917;font-weight:600">{{appointment_date}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Arrival Window</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917">{{appointment_window}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Service</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917">{{scope}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Address</p>
  <p style="margin:0;font-size:15px;color:#1A1917">{{service_address}}</p>
</td></tr>
</table>
<p style="margin:0 0 8px;font-weight:600;color:#1A1917">Last-minute checklist</p>
<ul style="margin:0 0 20px;padding-left:20px;color:#1A1917;line-height:1.8">
  <li>Countertops and surfaces cleared</li>
  <li>Dishes out of the sink</li>
  <li>Pets secured</li>
  <li>Entry method confirmed</li>
  <li>Special instructions on file \u2014 if anything changed, call us tonight at {{company_phone}}</li>
</ul>
<table width="100%" cellpadding="0" cellspacing="0" style="border-left:4px solid #5B9BD5;background:#F0F6FC;border-radius:0 6px 6px 0;margin:0 0 24px">
<tr><td style="padding:16px;color:#1A1917;font-size:14px;line-height:1.6">
  Cancellations made less than 48 business hours before your appointment result in a full service charge. Call us as soon as possible if you need to cancel: <strong>{{company_phone}}</strong>.
</td></tr>
</table>
<p style="margin:0">We will see you tomorrow.</p>`,
        body_text: "Hi {{first_name}}, reminder: your cleaning with {{company_name}} is TOMORROW {{appointment_date}}, arrival {{appointment_window}} at {{service_address}}. Questions? {{company_phone}}.",
      },
      {
        trigger: "reminder_1day", channel: "sms",
        subject: null,
        body_html: null,
        body_text: "Hi {{first_name}}, reminder: your cleaning with {{company_name}} is TOMORROW {{appointment_date}}, arrival {{appointment_window}} at {{service_address}}. Questions? {{company_phone}}.",
      },

      // ── 3. ON MY WAY ────────────────────────────────────────────────────
      {
        trigger: "on_my_way", channel: "email",
        subject: "Your cleaner is on the way",
        body_html: `<p style="margin:0 0 20px">Hi {{first_name}},</p>
<p style="margin:0 0 20px"><strong>{{technician_name}}</strong> is on the way and will arrive during your scheduled window.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E2DC;border-radius:6px;background:#FFFFFF;margin:0 0 24px">
<tr><td style="padding:20px">
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Cleaner</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917;font-weight:600">{{technician_name}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Arriving</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917">{{appointment_window}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Address</p>
  <p style="margin:0;font-size:15px;color:#1A1917">{{service_address}}</p>
</td></tr>
</table>
<p style="margin:0">Need to reach us before arrival? Call or text <strong>{{company_phone}}</strong>.</p>`,
        body_text: "Hi {{first_name}}, {{technician_name}} from {{company_name}} is on the way \u2014 arriving during your {{appointment_window}} window. Questions? {{company_phone}}.",
      },
      {
        trigger: "on_my_way", channel: "sms",
        subject: null,
        body_html: null,
        body_text: "Hi {{first_name}}, {{technician_name}} from {{company_name}} is on the way \u2014 arriving during your {{appointment_window}} window. Questions? {{company_phone}}.",
      },

      // ── 4. JOB COMPLETED ────────────────────────────────────────────────
      {
        trigger: "job_completed", channel: "email",
        subject: "Your cleaning is complete \u2014 thank you, {{first_name}}",
        body_html: `<p style="margin:0 0 20px">Hi {{first_name}},</p>
<p style="margin:0 0 20px">Your home has been cleaned. Thank you for trusting <strong>{{company_name}}</strong>.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E2DC;border-radius:6px;background:#FFFFFF;margin:0 0 24px">
<tr><td style="padding:20px">
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Completed</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917;font-weight:600">{{appointment_date}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Service</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917">{{scope}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Address</p>
  <p style="margin:0;font-size:15px;color:#1A1917">{{service_address}}</p>
</td></tr>
</table>
<p style="margin:0 0 8px;font-weight:600;color:#1A1917">Our 24-Hour Guarantee</p>
<p style="margin:0 0 20px;color:#1A1917">If we missed anything, contact us within 24 hours and we will return to re-clean that area at no charge. No questions asked.</p>
<p style="margin:0 0 20px;color:#1A1917">Reach us at <strong>{{company_phone}}</strong> or <strong>{{company_email}}</strong>.</p>
<p style="margin:0">We look forward to your next visit.</p>`,
        body_text: "Hi {{first_name}}, your cleaning is complete! If we missed anything contact us within 24 hours and we will make it right. Thank you \u2014 {{company_name}} {{company_phone}}.",
      },
      {
        trigger: "job_completed", channel: "sms",
        subject: null,
        body_html: null,
        body_text: "Hi {{first_name}}, your cleaning is complete! If we missed anything contact us within 24 hours and we will make it right. Thank you \u2014 {{company_name}} {{company_phone}}.",
      },

      // ── 5. REVIEW REQUEST ────────────────────────────────────────────────
      {
        trigger: "review_request", channel: "email",
        subject: "How did we do, {{first_name}}?",
        body_html: `<p style="margin:0 0 20px">Hi {{first_name}},</p>
<p style="margin:0 0 24px">We hope your home is feeling great. We would love to hear about your experience.</p>
<div style="text-align:center;margin:0 0 24px">
  <a href="{{review_link}}" style="display:inline-block;background:#5B9BD5;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 28px;border-radius:6px">Leave Us a Review</a>
</div>
<p style="margin:0 0 20px;color:#1A1917">Your feedback helps our team improve and helps other families in the Chicagoland area find a service they can trust. It takes less than two minutes.</p>
<p style="margin:0">If anything fell short of your expectations, please reach out before posting \u2014 we want the chance to make it right. Call or text <strong>{{company_phone}}</strong>.</p>`,
        body_text: "Hi {{first_name}}, thank you for your recent cleaning with {{company_name}}. Would you mind leaving a quick review? {{review_link}} \u2014 means a lot to our team.",
      },
      {
        trigger: "review_request", channel: "sms",
        subject: null,
        body_html: null,
        body_text: "Hi {{first_name}}, thank you for your recent cleaning with {{company_name}}. Would you mind leaving a quick review? {{review_link}} \u2014 means a lot to our team.",
      },

      // ── 6. INVOICE SENT ──────────────────────────────────────────────────
      {
        trigger: "invoice_sent", channel: "email",
        subject: "Invoice #{{invoice_number}} from {{company_name}} \u2014 ${{invoice_amount}} due {{invoice_due_date}}",
        body_html: `<p style="margin:0 0 20px">Hi {{first_name}},</p>
<p style="margin:0 0 20px">Your invoice is ready. Payment is due by <strong>{{invoice_due_date}}</strong>.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E2DC;border-radius:6px;background:#FFFFFF;margin:0 0 24px">
<tr><td style="padding:20px">
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Invoice</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917;font-weight:600">#{{invoice_number}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Amount Due</p>
  <p style="margin:0 0 16px;font-size:18px;color:#1A1917;font-weight:700">\${{invoice_amount}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Due Date</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917">{{invoice_due_date}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Address</p>
  <p style="margin:0;font-size:15px;color:#1A1917">{{service_address}}</p>
</td></tr>
</table>
<div style="text-align:center;margin:0 0 24px">
  <a href="{{invoice_link}}" style="display:inline-block;background:#5B9BD5;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 28px;border-radius:6px">View and Pay Invoice</a>
</div>
<p style="margin:0 0 20px;color:#6B6860;font-size:14px">If your card on file is set to auto-charge, no action is needed. Payment will process automatically on or before the due date.</p>
<p style="margin:0;color:#1A1917">Questions? <strong>{{company_phone}}</strong> or <strong>{{company_email}}</strong>.</p>`,
        body_text: "Hi {{first_name}}, invoice #{{invoice_number}} for ${{invoice_amount}} from {{company_name}} is ready. Due {{invoice_due_date}}. Pay: {{invoice_link}} or call {{company_phone}}.",
      },
      {
        trigger: "invoice_sent", channel: "sms",
        subject: null,
        body_html: null,
        body_text: "Hi {{first_name}}, invoice #{{invoice_number}} for ${{invoice_amount}} from {{company_name}} is ready. Due {{invoice_due_date}}. Pay: {{invoice_link}} or call {{company_phone}}.",
      },

      // ── 7. PAYMENT RECEIVED ──────────────────────────────────────────────
      {
        trigger: "payment_received", channel: "email",
        subject: "Payment confirmed \u2014 thank you, {{first_name}}",
        body_html: `<p style="margin:0 0 20px">Hi {{first_name}},</p>
<p style="margin:0 0 20px">We have received your payment. Thank you.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E2DC;border-radius:6px;background:#FFFFFF;margin:0 0 24px">
<tr><td style="padding:20px">
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Amount Paid</p>
  <p style="margin:0 0 16px;font-size:18px;color:#1A1917;font-weight:700">\${{payment_amount}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Date</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917">{{payment_date}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Invoice</p>
  <p style="margin:0;font-size:15px;color:#1A1917">#{{invoice_number}}</p>
</td></tr>
</table>
<p style="margin:0 0 20px;color:#1A1917">Please save this email as your receipt. Questions? <strong>{{company_phone}}</strong> or <strong>{{company_email}}</strong>.</p>
<p style="margin:0">We look forward to your next appointment.</p>`,
        body_text: "Hi {{first_name}}, payment of ${{payment_amount}} received for invoice #{{invoice_number}}. Thank you! {{company_name}} {{company_phone}}.",
      },
      {
        trigger: "payment_received", channel: "sms",
        subject: null,
        body_html: null,
        body_text: "Hi {{first_name}}, payment of ${{payment_amount}} received for invoice #{{invoice_number}}. Thank you! {{company_name}} {{company_phone}}.",
      },

      // ── 8. NEW CLIENT WELCOME ────────────────────────────────────────────
      {
        trigger: "new_client_welcome", channel: "email",
        subject: "Welcome to {{company_name}}, {{first_name}}",
        body_html: `<p style="margin:0 0 20px">Hi {{first_name}},</p>
<p style="margin:0 0 24px">Welcome to <strong>{{company_name}}</strong>. We are glad to have you.</p>
<p style="margin:0 0 8px;font-weight:600;color:#1A1917">What to expect</p>
<p style="margin:0 0 20px;color:#1A1917">Our team arrives within your scheduled window fully equipped. We bring all supplies \u2014 you do not need to provide anything unless noted in your service instructions.</p>
<p style="margin:0 0 20px;color:#1A1917">After every cleaning you will receive a completion confirmation. If anything is ever less than excellent, contact us within 24 hours and we will return to make it right at no charge.</p>
<p style="margin:0 0 8px;font-weight:600;color:#1A1917">Service policies at a glance</p>
<ul style="margin:0 0 20px;padding-left:20px;color:#1A1917;line-height:1.9">
  <li>48-hour cancellation notice required (Sundays do not count)</li>
  <li>Monday appointments: notify us by Friday at 6:00 PM CT</li>
  <li>Tuesday appointments: notify us by Saturday at 12:00 PM CT</li>
  <li>Late cancellations and no-shows are charged at 100% of the service fee</li>
  <li>One reschedule per appointment \u2014 additional reschedules are treated as cancellations</li>
</ul>
<p style="margin:0 0 8px;font-weight:600;color:#1A1917">How to reach us</p>
<p style="margin:0 0 4px;color:#1A1917">Call or text: <strong>{{company_phone}}</strong></p>
<p style="margin:0 0 4px;color:#1A1917">Email: <strong>{{company_email}}</strong></p>
<p style="margin:0 0 4px;color:#1A1917">Website: phes.io</p>
<p style="margin:0 0 24px;color:#1A1917">Hours: Monday through Saturday, 8:00 AM to 6:00 PM CT</p>
<p style="margin:0">Thank you for choosing <strong>{{company_name}}</strong>.</p>`,
        body_text: "Hi {{first_name}}, welcome to {{company_name}}! We look forward to your first cleaning. Questions anytime: {{company_phone}}. See you soon.",
      },
      {
        trigger: "new_client_welcome", channel: "sms",
        subject: null,
        body_html: null,
        body_text: "Hi {{first_name}}, welcome to {{company_name}}! We look forward to your first cleaning. Questions anytime: {{company_phone}}. See you soon.",
      },

      // ── 9. QUOTE SENT ────────────────────────────────────────────────────
      {
        trigger: "quote_sent", channel: "email",
        subject: "Your quote from {{company_name}} \u2014 #{{quote_number}}",
        body_html: `<p style="margin:0 0 20px">Hi {{first_name}},</p>
<p style="margin:0 0 20px">Thank you for reaching out. Your quote is ready.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E2DC;border-radius:6px;background:#FFFFFF;margin:0 0 24px">
<tr><td style="padding:20px">
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Quote</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917;font-weight:600">#{{quote_number}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Estimate</p>
  <p style="margin:0 0 16px;font-size:18px;color:#1A1917;font-weight:700">\${{quote_total}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Valid Until</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917">{{quote_expires}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Address</p>
  <p style="margin:0;font-size:15px;color:#1A1917">{{service_address}}</p>
</td></tr>
</table>
<div style="text-align:center;margin:0 0 24px">
  <a href="{{quote_link}}" style="display:inline-block;background:#5B9BD5;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 28px;border-radius:6px">Review Your Quote</a>
</div>
<p style="margin:0 0 20px;color:#6B6860;font-size:14px">This estimate is based on the information provided. If your home\u2019s condition differs significantly, we may revise it before or at the start of service. Additional time is billed at $65 per hour per cleaner.</p>
<p style="margin:0">To book, approve the quote online or call us at <strong>{{company_phone}}</strong>.</p>`,
        body_text: "Hi {{first_name}}, your quote #{{quote_number}} from {{company_name}} is ready \u2014 ${{quote_total}} estimated. Review: {{quote_link}} or call {{company_phone}} to book.",
      },
      {
        trigger: "quote_sent", channel: "sms",
        subject: null,
        body_html: null,
        body_text: "Hi {{first_name}}, your quote #{{quote_number}} from {{company_name}} is ready \u2014 ${{quote_total}} estimated. Review: {{quote_link}} or call {{company_phone}} to book.",
      },

      // ── 10. PASSWORD RESET ───────────────────────────────────────────────
      {
        trigger: "password_reset", channel: "email",
        subject: "Reset your Qleno password",
        body_html: `<p style="margin:0 0 20px">Hi {{first_name}},</p>
<p style="margin:0 0 20px">We received a request to reset the password for your Qleno account. Use the button below to set a new password.</p>
<div style="text-align:center;margin:0 0 24px">
  <a href="{{reset_link}}" style="display:inline-block;background:#5B9BD5;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 28px;border-radius:6px">Reset My Password</a>
</div>
<p style="margin:0 0 20px;color:#6B6860;font-size:14px">This link expires in {{reset_expiry}}. If you did not request this, ignore this email \u2014 your password will not change.</p>
<p style="margin:0;color:#6B6860;font-size:14px">Trouble accessing your account? Contact your administrator or email <strong>{{company_email}}</strong>.</p>`,
        body_text: null,
      },
    ];

    let seeded = 0;
    for (const t of templates) {
      await db.execute(sql`
        INSERT INTO notification_templates
          (company_id, trigger, channel, subject, body, body_html, body_text, is_active)
        SELECT
          ${PHES}, ${t.trigger}, ${t.channel}::notification_channel,
          ${t.subject}, '', ${t.body_html}, ${t.body_text}, true
        WHERE NOT EXISTS (
          SELECT 1 FROM notification_templates
          WHERE company_id = ${PHES} AND trigger = ${t.trigger} AND channel = ${t.channel}::notification_channel
        )
      `);
      seeded++;
    }

    // Verify count
    const emailCount = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM notification_templates
      WHERE company_id = ${PHES} AND channel = 'email' AND is_active = true
    `);
    const smsCount = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM notification_templates
      WHERE company_id = ${PHES} AND channel = 'sms' AND is_active = true
    `);
    const ec = (emailCount.rows[0] as any).cnt;
    const sc = (smsCount.rows[0] as any).cnt;
    console.log(`TEMPLATE SYSTEM READY \u2014 ${ec} email templates, ${sc} SMS templates active for PHES tenant`);
  } catch (err) {
    console.error("[notification-templates] Seed error (non-fatal):", err);
  }

  // ── Follow-Up Sequence Seed (PHES) ────────────────────────────────────────
  try {
    const existing = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM follow_up_sequences WHERE company_id = ${PHES}
    `);
    if ((existing.rows[0] as any).cnt > 0) {
      console.log("[follow-up-seed] Sequences already seeded — skipping.");
      return;
    }

    // Sequence A — quote_followup
    const seqA = await db.execute(sql`
      INSERT INTO follow_up_sequences (company_id, sequence_type, name, is_active)
      VALUES (${PHES}, 'quote_followup', 'Quote Follow-Up', true)
      RETURNING id
    `);
    const seqAId = (seqA.rows[0] as any).id;

    const quoteSteps = [
      { step_number: 1, delay_hours: 0,   channel: 'email', subject: 'Your Phes Cleaning Estimate',
        message_template: 'Hi {{first_name}}, thank you for reaching out to Phes. Your estimate is attached. We would love to get you scheduled — reply to this email or call us at (773) 706-6000 with any questions.' },
      { step_number: 2, delay_hours: 24,  channel: 'sms', subject: null,
        message_template: 'Hi {{first_name}}, this is the Phes office checking in on your cleaning estimate. Any questions? Reply here or call (773) 706-6000.' },
      { step_number: 3, delay_hours: 72,  channel: 'email', subject: 'Still thinking it over?',
        message_template: 'Hi {{first_name}}, we wanted to follow up on your estimate. We have availability coming up and would love to hold a spot for you. Reply here or call us at (773) 706-6000.' },
      { step_number: 4, delay_hours: 168, channel: 'sms', subject: null,
        message_template: 'Hi {{first_name}}, last check-in from Phes. We are still here when you are ready — call or text (773) 706-6000 anytime.' },
    ];
    for (const st of quoteSteps) {
      await db.execute(sql`
        INSERT INTO follow_up_steps (sequence_id, step_number, delay_hours, channel, subject, message_template)
        VALUES (${seqAId}, ${st.step_number}, ${st.delay_hours}, ${st.channel}, ${st.subject ?? null}, ${st.message_template})
      `);
    }

    // Sequence B — post_job_retention
    const seqB = await db.execute(sql`
      INSERT INTO follow_up_sequences (company_id, sequence_type, name, is_active)
      VALUES (${PHES}, 'post_job_retention', 'Post-Job Retention', true)
      RETURNING id
    `);
    const seqBId = (seqB.rows[0] as any).id;

    const retentionSteps = [
      { step_number: 1, delay_hours: 2,    channel: 'sms', subject: null,
        message_template: 'Hi {{first_name}}, your Phes team just finished up. How did everything look? Reply here and let us know.' },
      { step_number: 2, delay_hours: 720,  channel: 'email', subject: 'Time for your next clean?',
        message_template: 'Hi {{first_name}}, it has been about a month since your last Phes cleaning. Ready to get back on the schedule? Reply here or book online at phes.io.' },
      { step_number: 3, delay_hours: 1440, channel: 'sms', subject: null,
        message_template: 'Hi {{first_name}}, it has been about two months since your last clean. We would love to have you back — call or text us at (773) 706-6000.' },
      { step_number: 4, delay_hours: 2160, channel: 'email', subject: 'We miss you',
        message_template: 'Hi {{first_name}}, it has been three months since your last Phes cleaning. We would love to reconnect and get your home back on schedule. Reply here or call (773) 706-6000.' },
      { step_number: 5, delay_hours: 4320, channel: 'sms', subject: null,
        message_template: 'Hi {{first_name}}, six months is a long time between cleans. We are here whenever you are ready — (773) 706-6000.' },
      { step_number: 6, delay_hours: 8760, channel: 'email', subject: 'It has been a year',
        message_template: 'Hi {{first_name}}, it has been a full year since your last Phes cleaning. We would love to earn your business back. Reply here or call (773) 706-6000 — we will make it right.' },
    ];
    for (const st of retentionSteps) {
      await db.execute(sql`
        INSERT INTO follow_up_steps (sequence_id, step_number, delay_hours, channel, subject, message_template)
        VALUES (${seqBId}, ${st.step_number}, ${st.delay_hours}, ${st.channel}, ${st.subject ?? null}, ${st.message_template})
      `);
    }

    console.log("[follow-up-seed] Sequences A+B seeded for PHES.");
  } catch (err) {
    console.error("[follow-up-seed] Seed error (non-fatal):", err);
  }
}
