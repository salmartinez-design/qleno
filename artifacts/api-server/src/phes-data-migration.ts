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
import bcrypt from "bcryptjs";
import { geocodeWithComponents } from "./lib/geocode";

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
    { label: "jobs.office_notes_updated_by", stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS office_notes_updated_by INTEGER" },
    { label: "jobs.office_notes_updated_at", stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS office_notes_updated_at TIMESTAMP" },
    { label: "companies.flag_missing_gps", stmt: "ALTER TABLE companies ADD COLUMN IF NOT EXISTS flag_missing_gps BOOLEAN NOT NULL DEFAULT true" },
    { label: "jobs.last_cleaned_response", stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_cleaned_response TEXT" },
    { label: "jobs.last_cleaned_flag",     stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_cleaned_flag TEXT" },
    { label: "jobs.overage_disclaimer_acknowledged", stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS overage_disclaimer_acknowledged BOOLEAN DEFAULT false" },
    { label: "jobs.overage_rate",          stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS overage_rate NUMERIC(10,2)" },
    { label: "jobs.upsell_shown",          stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS upsell_shown BOOLEAN DEFAULT false" },
    { label: "jobs.upsell_accepted",       stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS upsell_accepted BOOLEAN DEFAULT false" },
    { label: "jobs.upsell_declined",       stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS upsell_declined BOOLEAN DEFAULT false" },
    { label: "jobs.upsell_deferred",       stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS upsell_deferred BOOLEAN DEFAULT false" },
    { label: "jobs.upsell_cadence_selected", stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS upsell_cadence_selected TEXT" },
    // [phes-lifecycle 2026-04-29] Manual no-show flag set by the field
    // app's "No Show" button. See lib/job-status.ts for the state model.
    { label: "jobs.no_show_marked_by_tech", stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS no_show_marked_by_tech TIMESTAMP" },
    { label: "jobs.no_show_marked_by_user_id", stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS no_show_marked_by_user_id INTEGER" },
    // [pay-matrix 2026-04-29] Per-employee 4-cell pay matrix. Schema
    // additions are idempotent (IF NOT EXISTS); backfill happens in
    // runPayMatrixBackfill() so the boot-order is: ensure columns
    // exist, then ensure every row has a sensible default.
    { label: "users.residential_pay_type", stmt: "ALTER TABLE users ADD COLUMN IF NOT EXISTS residential_pay_type TEXT DEFAULT 'commission'" },
    { label: "users.residential_pay_rate", stmt: "ALTER TABLE users ADD COLUMN IF NOT EXISTS residential_pay_rate NUMERIC(8,4) DEFAULT 0.35" },
    { label: "users.commercial_pay_type",  stmt: "ALTER TABLE users ADD COLUMN IF NOT EXISTS commercial_pay_type  TEXT DEFAULT 'hourly'" },
    { label: "users.commercial_pay_rate",  stmt: "ALTER TABLE users ADD COLUMN IF NOT EXISTS commercial_pay_rate  NUMERIC(8,4) DEFAULT 20.0000" },
    // [phes-chicago23 2026-05-12] One-shot password reset gate. NULL means
    // this user has not yet had their password set to Chicago23 by the
    // cold-start runPhesPasswordResetChicago23() function below. After that
    // function runs once per user, the timestamp is set and the user is
    // never auto-reset again — even on subsequent deploys.
    { label: "users.password_reset_to_chicago23_at", stmt: "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_to_chicago23_at TIMESTAMPTZ" },
    { label: "users.is_sandbox", stmt: "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT FALSE" },
    // Phes admin-view-consistency sprint (2026-05-15). Supersession
    // columns on lms_quiz_attempts. Backfilled by runSupersessionBackfill
    // for legacy Phes data that predates the per-module cap.
    { label: "lms_quiz_attempts.superseded", stmt: "ALTER TABLE lms_quiz_attempts ADD COLUMN IF NOT EXISTS superseded BOOLEAN NOT NULL DEFAULT FALSE" },
    { label: "lms_quiz_attempts.superseded_reason", stmt: "ALTER TABLE lms_quiz_attempts ADD COLUMN IF NOT EXISTS superseded_reason TEXT" },
    { label: "lms_quiz_attempts.superseded_at", stmt: "ALTER TABLE lms_quiz_attempts ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ" },
    // 2026-05-20 audit: add last_login_at to users. Populated by
    // /api/auth/login on success. Distinct from lms_enrollments.
    // last_activity_at (quiz-submit ticks only).
    { label: "users.last_login_at", stmt: "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ" },
    { label: "companies.default_residential_pay_type", stmt: "ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_residential_pay_type TEXT DEFAULT 'commission'" },
    { label: "companies.default_residential_pay_rate", stmt: "ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_residential_pay_rate NUMERIC(8,4) DEFAULT 0.35" },
    { label: "companies.default_commercial_pay_type",  stmt: "ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_commercial_pay_type  TEXT DEFAULT 'hourly'" },
    { label: "companies.default_commercial_pay_rate",  stmt: "ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_commercial_pay_rate  NUMERIC(8,4) DEFAULT 20.0000" },
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
    // [AF] Mark-complete flow columns — drawer "Mark Complete" sets these atomically
    { label: "jobs.actual_end_time",           stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS actual_end_time TIMESTAMP" },
    { label: "jobs.locked_at",                 stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP" },
    { label: "jobs.completed_by_user_id",      stmt: "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completed_by_user_id INTEGER" },
    // ── quotes extra columns ────────────────────────────────────────────────
    { label: "quotes.call_notes",              stmt: "ALTER TABLE quotes ADD COLUMN IF NOT EXISTS call_notes TEXT" },
    { label: "quotes.alternate_options",       stmt: "ALTER TABLE quotes ADD COLUMN IF NOT EXISTS alternate_options JSONB" },
    { label: "quotes.zone_override",           stmt: "ALTER TABLE quotes ADD COLUMN IF NOT EXISTS zone_override BOOLEAN DEFAULT FALSE" },
    { label: "quotes.address_verified",        stmt: "ALTER TABLE quotes ADD COLUMN IF NOT EXISTS address_verified BOOLEAN DEFAULT FALSE" },
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
    // ── acquisition_sources table ────────────────────────────────────────────
    // [scheduling-engine 2026-04-29] Tenant-managed acquisition sources
    // table. Replaces the hardcoded SOURCE_LABELS map in
    // customer-profile.tsx. Per-tenant rows; clients.referral_source
    // continues storing the slug as text. Idempotent — uniqueness on
    // (company_id, slug) so the seed step below can be safely re-run.
    { label: "CREATE acquisition_sources", stmt: `
      CREATE TABLE IF NOT EXISTS acquisition_sources (
        id            SERIAL PRIMARY KEY,
        company_id    INTEGER NOT NULL,
        slug          TEXT NOT NULL,
        name          TEXT NOT NULL,
        is_active     BOOLEAN NOT NULL DEFAULT true,
        display_order INTEGER NOT NULL DEFAULT 100,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (company_id, slug)
      )
    ` },
    // ── service_types table ──────────────────────────────────────────────────
    // [commercial-workflow 2026-04-29] Hierarchical service types
    // (parent_slug = residential | commercial). Replaces hardcoded
    // SERVICE_TYPES / COMMERCIAL_SERVICE_TYPES arrays in the wizard.
    // Slugs match the existing serviceTypeEnum so historical jobs
    // continue to type-check. UNIQUE (company_id, slug) lets the
    // seed below ON CONFLICT DO NOTHING.
    { label: "CREATE service_types", stmt: `
      CREATE TABLE IF NOT EXISTS service_types (
        id                    SERIAL PRIMARY KEY,
        company_id            INTEGER NOT NULL,
        parent_slug           TEXT NOT NULL CHECK (parent_slug IN ('residential', 'commercial')),
        slug                  TEXT NOT NULL,
        name                  TEXT NOT NULL,
        description           TEXT,
        is_active             BOOLEAN NOT NULL DEFAULT true,
        display_order         INTEGER NOT NULL DEFAULT 100,
        default_allowed_hours NUMERIC(5,2),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (company_id, slug)
      )
    ` },
    // ── recurring_schedule_addons_days table ─────────────────────────────────
    // [commercial-workflow 2026-04-29] Per-add-on, per-weekday
    // scoping for recurring schedule add-ons. CASCADE delete with
    // the parent recurring_schedule_add_ons row. Day convention:
    // 0=Sun..6=Sat (matches recurring_schedules.parking_fee_days).
    { label: "CREATE recurring_schedule_addons_days", stmt: `
      CREATE TABLE IF NOT EXISTS recurring_schedule_addons_days (
        id                          SERIAL PRIMARY KEY,
        recurring_schedule_addon_id INTEGER NOT NULL
                                    REFERENCES recurring_schedule_add_ons(id) ON DELETE CASCADE,
        day_of_week                 SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (recurring_schedule_addon_id, day_of_week)
      )
    ` },
    // ── quotes.client_type ───────────────────────────────────────────────────
    // [commercial-workflow 2026-04-29] Per-quote type override.
    // Quote flow's Type toggle (Residential/Commercial) defaults to
    // the client's primary client_type but can be overridden — the
    // bridge for first-time crossovers (residential client gets a
    // commercial quote, etc). Per Sal's decision: client primary
    // type stays sticky on conversion; the booked job carries the
    // quote's type, but clients.client_type is unchanged.
    { label: "quotes.client_type", stmt: "ALTER TABLE quotes ADD COLUMN IF NOT EXISTS client_type TEXT CHECK (client_type IS NULL OR client_type IN ('residential', 'commercial'))" },
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

    // ── Jobs page columns (2026-04-16) ──────────────────────────────────────
    { label: "jobs.flagged", stmt: `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT false` },
    { label: "idx_jobs_company_flagged", stmt: `CREATE INDEX IF NOT EXISTS idx_jobs_company_flagged ON jobs(company_id, flagged) WHERE flagged = true` },

    // ── Pricing discounts scope support (2026-04-16) ────────────────────────
    { label: "pricing_discounts.scope_ids", stmt: `ALTER TABLE pricing_discounts ADD COLUMN IF NOT EXISTS scope_ids TEXT NOT NULL DEFAULT '[]'` },
    { label: "pricing_discounts.frequency", stmt: `ALTER TABLE pricing_discounts ADD COLUMN IF NOT EXISTS frequency TEXT NOT NULL DEFAULT 'one_time'` },
    { label: "pricing_discounts.availability_office", stmt: `ALTER TABLE pricing_discounts ADD COLUMN IF NOT EXISTS availability_office BOOLEAN NOT NULL DEFAULT true` },
    { label: "uq_pricing_discounts_company_code_scopes", stmt: `CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_discounts_company_code_scopes ON pricing_discounts(company_id, code, scope_ids)` },

    // ── Per-tenant recurring engine flag (2026-04-17) ───────────────────────
    { label: "companies.recurring_engine_enabled", stmt: `ALTER TABLE companies ADD COLUMN IF NOT EXISTS recurring_engine_enabled BOOLEAN NOT NULL DEFAULT true` },

    // ── Client payment method + net terms (2026-04-18) ──────────────────────
    { label: "clients.payment_method", stmt: `ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'manual'` },
    { label: "clients.payment_method CHECK", stmt: `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.check_constraints WHERE constraint_name = 'clients_payment_method_check') THEN ALTER TABLE clients ADD CONSTRAINT clients_payment_method_check CHECK (payment_method IN ('card_on_file','check','zelle','net_30','manual')); END IF; END $$` },
    { label: "clients.net_terms", stmt: `ALTER TABLE clients ADD COLUMN IF NOT EXISTS net_terms INTEGER DEFAULT 0` },

    // ── User saved views + column preferences (2026-04-16) ──────────────────
    { label: "CREATE user_saved_views", stmt: `
      CREATE TABLE IF NOT EXISTS user_saved_views (
        id                SERIAL PRIMARY KEY,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_id        INTEGER NOT NULL,
        page              TEXT NOT NULL,
        name              TEXT NOT NULL,
        filter_json       TEXT NOT NULL DEFAULT '{}',
        column_config_json TEXT NOT NULL DEFAULT '[]',
        is_default        BOOLEAN NOT NULL DEFAULT false,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "idx_user_saved_views_user_page", stmt: `CREATE INDEX IF NOT EXISTS idx_user_saved_views_user_page ON user_saved_views(user_id, page)` },
    { label: "CREATE user_column_preferences", stmt: `
      CREATE TABLE IF NOT EXISTS user_column_preferences (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_id  INTEGER NOT NULL,
        page        TEXT NOT NULL,
        column_key  TEXT NOT NULL,
        visible     BOOLEAN NOT NULL DEFAULT true,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        UNIQUE (user_id, page, column_key)
      )
    ` },

    // ── AG: Job Edit modal — schema additions (2026-04-27) ───────────────────
    // Manual-rate flag on jobs: set true when a user overrides the
    // pricing-engine-calculated base_fee in the edit modal. Cleared when
    // scope/freq/add-ons change AND base_fee is omitted from the patch.
    { label: "jobs.manual_rate_override",
      stmt: `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS manual_rate_override BOOLEAN NOT NULL DEFAULT false` },

    // Add-ons traceability — link the per-job add-on row to the
    // tenant's pricing_addon row for recalc lookups.
    { label: "job_add_ons.pricing_addon_id",
      stmt: `ALTER TABLE job_add_ons ADD COLUMN IF NOT EXISTS pricing_addon_id INTEGER` },

    // Recurring schedule — fields that AG can cascade. Backfill is
    // intentionally not done; existing schedules stay null until edited.
    { label: "recurring_schedules.scheduled_time",
      stmt: `ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS scheduled_time TIME` },
    { label: "recurring_schedules.instructions",
      stmt: `ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS instructions TEXT` },
    { label: "recurring_schedules.manual_rate_override",
      stmt: `ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS manual_rate_override BOOLEAN NOT NULL DEFAULT false` },
    { label: "recurring_schedules.custom_frequency_weeks",
      stmt: `ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS custom_frequency_weeks INTEGER` },

    // [quote-attachments 2026-05-26] Files attached to a quote's Call
    // Notes panel — photos clients send, screenshots the office takes,
    // PDFs. Office-only on the quote screen. After convert-to-job,
    // assigned techs read them via GET /api/jobs/:id/attachments which
    // resolves back through quotes.booked_job_id.
    { label: "CREATE quote_attachments", stmt: `
      CREATE TABLE IF NOT EXISTS quote_attachments (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER NOT NULL REFERENCES companies(id),
        quote_id     INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        file_url     TEXT NOT NULL,
        file_type    TEXT,
        file_size    INTEGER,
        uploaded_by  INTEGER REFERENCES users(id),
        created_at   TIMESTAMP NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "idx_quote_attachments_quote",
      stmt: `CREATE INDEX IF NOT EXISTS idx_quote_attachments_quote ON quote_attachments(quote_id)` },

    // Recurring add-ons junction — parent template for what spawns onto
    // each child job.
    { label: "CREATE recurring_schedule_add_ons", stmt: `
      CREATE TABLE IF NOT EXISTS recurring_schedule_add_ons (
        id                     SERIAL PRIMARY KEY,
        recurring_schedule_id  INTEGER NOT NULL REFERENCES recurring_schedules(id) ON DELETE CASCADE,
        pricing_addon_id       INTEGER NOT NULL,
        qty                    NUMERIC(6,2) NOT NULL DEFAULT 1,
        created_at             TIMESTAMP NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "idx_rs_addons_schedule",
      stmt: `CREATE INDEX IF NOT EXISTS idx_rs_addons_schedule ON recurring_schedule_add_ons(recurring_schedule_id)` },

    // Recurring techs junction — multi-tech default for spawned jobs.
    { label: "CREATE recurring_schedule_technicians", stmt: `
      CREATE TABLE IF NOT EXISTS recurring_schedule_technicians (
        id                     SERIAL PRIMARY KEY,
        recurring_schedule_id  INTEGER NOT NULL REFERENCES recurring_schedules(id) ON DELETE CASCADE,
        user_id                INTEGER NOT NULL REFERENCES users(id),
        is_primary             BOOLEAN NOT NULL DEFAULT false,
        created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (recurring_schedule_id, user_id)
      )
    ` },
    { label: "idx_rs_techs_schedule",
      stmt: `CREATE INDEX IF NOT EXISTS idx_rs_techs_schedule ON recurring_schedule_technicians(recurring_schedule_id)` },

    // Job audit log — per-field diffs for the edit modal.
    { label: "CREATE job_audit_log", stmt: `
      CREATE TABLE IF NOT EXISTS job_audit_log (
        id             SERIAL PRIMARY KEY,
        job_id         INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        company_id     INTEGER NOT NULL,
        user_id        INTEGER NOT NULL REFERENCES users(id),
        user_name      TEXT NOT NULL,
        user_email     TEXT NOT NULL,
        field_name     TEXT NOT NULL,
        old_value      JSONB,
        new_value      JSONB,
        cascade_scope  TEXT,
        schedule_id    INTEGER,
        edited_at      TIMESTAMP NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "idx_job_audit_log_job_id",
      stmt: `CREATE INDEX IF NOT EXISTS idx_job_audit_log_job_id ON job_audit_log(job_id)` },
    { label: "idx_job_audit_log_user_id",
      stmt: `CREATE INDEX IF NOT EXISTS idx_job_audit_log_user_id ON job_audit_log(user_id)` },
    { label: "idx_job_audit_log_edited_at",
      stmt: `CREATE INDEX IF NOT EXISTS idx_job_audit_log_edited_at ON job_audit_log(edited_at DESC)` },

    // ── AH: Commercial pricing — per-client hourly rate (2026-04-27) ─────────
    // PHES's commercial clients (49 of them, e.g. Jaira Estrada at National
    // Able Network) bill at hourly_rate × allowed_hours + parking. The rate
    // varies by client; storing it per-client avoids the
    // accounts/account_rate_cards detour for single-location clients. Multi-
    // location accounts still use account_rate_cards — see KNOWN_BUGS.md.
    { label: "clients.commercial_hourly_rate",
      stmt: `ALTER TABLE clients ADD COLUMN IF NOT EXISTS commercial_hourly_rate NUMERIC(10,2)` },

    // Cascade-friendly column on the recurring template so future spawned
    // jobs inherit the rate. Parallel to AG's manual_rate_override.
    { label: "recurring_schedules.commercial_hourly_rate",
      stmt: `ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS commercial_hourly_rate NUMERIC(10,2)` },

    // Client-level audit log — mirrors job_audit_log for edits to the
    // client profile (currently only commercial_hourly_rate; future
    // expansion will add other tracked fields).
    { label: "CREATE client_audit_log", stmt: `
      CREATE TABLE IF NOT EXISTS client_audit_log (
        id           SERIAL PRIMARY KEY,
        client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        company_id   INTEGER NOT NULL,
        user_id      INTEGER NOT NULL REFERENCES users(id),
        user_name    TEXT NOT NULL,
        user_email   TEXT NOT NULL,
        field_name   TEXT NOT NULL,
        old_value    JSONB,
        new_value    JSONB,
        edited_at    TIMESTAMP NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "idx_client_audit_log_client_id",
      stmt: `CREATE INDEX IF NOT EXISTS idx_client_audit_log_client_id ON client_audit_log(client_id)` },
    { label: "idx_client_audit_log_edited_at",
      stmt: `CREATE INDEX IF NOT EXISTS idx_client_audit_log_edited_at ON client_audit_log(edited_at DESC)` },

    // ── AI: Multi-day scheduling (2026-04-27) ────────────────────────────────
    // New column on recurring_schedules to store the array of weekday indices
    // (0=Sunday … 6=Saturday) that a multi-day schedule fires on. Used by
    // frequency in (daily, weekdays, custom_days). Existing weekly/biweekly/
    // monthly/every_3_weeks schedules continue to use the string day_of_week
    // column. Inconsistency logged as design debt in KNOWN_BUGS.md.
    { label: "recurring_schedules.days_of_week",
      stmt: `ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS days_of_week INTEGER[]` },

    // Frequency enum extensions. These ALTER TYPE statements cannot run
    // inside a transaction; the schema-guard runs each statement individually
    // via db.execute, which is implicit-commit per-statement. Safe.
    //
    // jobs.frequency — three new values for the multi-day case. Child jobs
    // mirror their parent recurring_schedules.frequency.
    { label: "frequency.daily",
      stmt: `ALTER TYPE frequency ADD VALUE IF NOT EXISTS 'daily'` },
    { label: "frequency.weekdays",
      stmt: `ALTER TYPE frequency ADD VALUE IF NOT EXISTS 'weekdays'` },
    { label: "frequency.custom_days",
      stmt: `ALTER TYPE frequency ADD VALUE IF NOT EXISTS 'custom_days'` },

    // recurring_schedules.frequency (recurring_frequency type) — was missing
    // every_3_weeks (AG worked around via custom + custom_frequency_weeks);
    // adding it now closes that latent bug. Plus the three multi-day values.
    { label: "recurring_frequency.every_3_weeks",
      stmt: `ALTER TYPE recurring_frequency ADD VALUE IF NOT EXISTS 'every_3_weeks'` },
    { label: "recurring_frequency.daily",
      stmt: `ALTER TYPE recurring_frequency ADD VALUE IF NOT EXISTS 'daily'` },
    { label: "recurring_frequency.weekdays",
      stmt: `ALTER TYPE recurring_frequency ADD VALUE IF NOT EXISTS 'weekdays'` },
    { label: "recurring_frequency.custom_days",
      stmt: `ALTER TYPE recurring_frequency ADD VALUE IF NOT EXISTS 'custom_days'` },

    // ── AI.3: Tenant-managed commercial service types (2026-04-27) ──────────
    // Sal pushed back on the hardcoded COMMERCIAL_SERVICE_TYPES list in the
    // edit modal — missing PPM Common Areas, and the pattern was wrong:
    // service types should be tenant-editable with default rates.
    //
    // service_type stays a Postgres enum for jobs.service_type integrity.
    // The new commercial_service_types table provides display name, slug,
    // and default_hourly_rate for tenant-managed dropdown rows. Slug must
    // map to a valid service_type enum value; new slugs added via the UI
    // also extend the enum (sanitized server-side, regex ^[a-z][a-z0-9_]*$).
    //
    // PPM Common Areas is the trigger: missing from the enum entirely.
    // Add it here so the seed can reference it.
    { label: "service_type.ppm_common_areas",
      stmt: `ALTER TYPE service_type ADD VALUE IF NOT EXISTS 'ppm_common_areas'` },
    // [AI.4] Two more commercial slugs added to PHES seed; enum extension
    // is mandatory before the seed INSERT runs.
    { label: "service_type.commercial_cleaning",
      stmt: `ALTER TYPE service_type ADD VALUE IF NOT EXISTS 'commercial_cleaning'` },
    { label: "service_type.recurring_commercial_cleaning",
      stmt: `ALTER TYPE service_type ADD VALUE IF NOT EXISTS 'recurring_commercial_cleaning'` },
    // Generic commercial "turnover" (distinct from the PPM-specific
    // ppm_turnover) so plain commercial clients can book turnovers.
    { label: "service_type.turnover",
      stmt: `ALTER TYPE service_type ADD VALUE IF NOT EXISTS 'turnover'` },

    { label: "CREATE commercial_service_types", stmt: `
      CREATE TABLE IF NOT EXISTS commercial_service_types (
        id                   SERIAL PRIMARY KEY,
        company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name                 TEXT NOT NULL,
        slug                 TEXT NOT NULL,
        default_hourly_rate  NUMERIC(10,2),
        is_active            BOOLEAN NOT NULL DEFAULT true,
        sort_order           INTEGER NOT NULL DEFAULT 0,
        created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (company_id, slug)
      )
    ` },
    { label: "idx_cst_company_active",
      stmt: `CREATE INDEX IF NOT EXISTS idx_cst_company_active ON commercial_service_types(company_id, is_active)` },

    // ── AI.6: Parking fee per-occurrence on recurring schedules (2026-04-27) ─
    // Parking-fee selection at the schedule template level, applied per
    // generated occurrence based on day-of-week. Engine stamps a
    // job_add_ons row pointing at the tenant's Parking Fee pricing_addons
    // entry on each qualifying job.
    //
    // Weekday convention: 0=Sun..6=Sat, matching recurring_schedules.days_of_week
    // (same JS Date.getDay convention). NULL parking_fee_days means "apply
    // to all scheduled days"; populated array means "apply only to listed days."
    { label: "recurring_schedules.parking_fee_enabled",
      stmt: `ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS parking_fee_enabled BOOLEAN NOT NULL DEFAULT false` },
    { label: "recurring_schedules.parking_fee_amount",
      stmt: `ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS parking_fee_amount NUMERIC(10,2)` },
    { label: "recurring_schedules.parking_fee_days",
      stmt: `ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS parking_fee_days INTEGER[]` },

    // Per-client parking-fee default. Resolution waterfall at job-generation
    // time: schedule.parking_fee_amount > clients.parking_fee_amount >
    // pricing_addons.parking_fee.price (tenant default). The enabled flag
    // does NOT auto-stamp parking on every job — it only affects the default
    // pre-fill in the recurring-schedule editor and the edit-job modal so
    // operators don't have to re-type $15 every time. The actual gate for
    // whether parking gets stamped is still recurring_schedules.parking_fee_enabled
    // (per-occurrence) or the operator manually checking the addon in the
    // edit-job modal (one-off).
    { label: "clients.parking_fee_enabled",
      stmt: `ALTER TABLE clients ADD COLUMN IF NOT EXISTS parking_fee_enabled BOOLEAN NOT NULL DEFAULT false` },
    { label: "clients.parking_fee_amount",
      stmt: `ALTER TABLE clients ADD COLUMN IF NOT EXISTS parking_fee_amount NUMERIC(10,2)` },

    // [PR #58] Semi-monthly cadence support. Adds the enum value to both
    // jobs.frequency and recurring_schedules.frequency, plus the anchor
    // days_of_month INTEGER[] column on recurring_schedules. ALTER TYPE
    // ADD VALUE IF NOT EXISTS is idempotent on Postgres 12+.
    { label: "frequency enum: semi_monthly",
      stmt: `ALTER TYPE frequency ADD VALUE IF NOT EXISTS 'semi_monthly'` },
    { label: "recurring_frequency enum: semi_monthly",
      stmt: `ALTER TYPE recurring_frequency ADD VALUE IF NOT EXISTS 'semi_monthly'` },
    { label: "recurring_schedules.days_of_month",
      stmt: `ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS days_of_month INTEGER[]` },

    // [PR #60] Per-client hourly rate. Drives the recurring-schedule
    // editor's Schedule Rate auto-calc (hourly_rate × allowed_hours =
    // schedule_rate). Distinct from commercial_hourly_rate (commission
    // engine). Backfill below populates it for existing clients.
    { label: "clients.hourly_rate",
      stmt: `ALTER TABLE clients ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2)` },
    // [PR #60] Backfill clients.hourly_rate. Priority order:
    // 1) commercial_hourly_rate (already-set commercial value)
    // 2) base_fee / allowed_hours (residential — implied rate)
    // Skip rows that already have hourly_rate populated. Idempotent —
    // safe to run on every cold-start.
    { label: "clients.hourly_rate backfill",
      stmt: `
        UPDATE clients
        SET hourly_rate = COALESCE(
          commercial_hourly_rate,
          CASE
            WHEN base_fee IS NOT NULL
              AND allowed_hours IS NOT NULL
              AND allowed_hours::numeric > 0
            THEN ROUND((base_fee::numeric / allowed_hours::numeric)::numeric, 2)
            ELSE NULL
          END
        )
        WHERE hourly_rate IS NULL
      `,
    },

    // [PR #64] LMS — per-module quiz Learning Management System.
    // Schema source of truth: lib/db/src/schema/lms.ts. Replicated here
    // because the production deploy does NOT run drizzle-kit push — the
    // cold-start hook in this file is the only schema-init mechanism
    // wired into the Dockerfile. Without these guards, every /api/lms/*
    // request 500s on prod. Idempotent (CREATE TABLE IF NOT EXISTS +
    // DO/EXCEPTION blocks for the enums + CREATE INDEX IF NOT EXISTS).
    { label: "enum enrollment_status",
      stmt: `
        DO $$ BEGIN
          CREATE TYPE enrollment_status AS ENUM ('active', 'completed', 'expired');
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      ` },
    { label: "enum module_status",
      stmt: `
        DO $$ BEGIN
          CREATE TYPE module_status AS ENUM ('not_started', 'in_progress', 'passed', 'failed');
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      ` },
    { label: "CREATE lms_enrollments", stmt: `
      CREATE TABLE IF NOT EXISTS lms_enrollments (
        id                       SERIAL PRIMARY KEY,
        company_id               INTEGER NOT NULL REFERENCES companies(id),
        user_id                  INTEGER NOT NULL REFERENCES users(id),
        status                   enrollment_status NOT NULL DEFAULT 'active',
        enrolled_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deadline_at              TIMESTAMPTZ NOT NULL,
        completed_at             TIMESTAMPTZ,
        last_activity_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locale                   TEXT,
        acknowledgment_signature TEXT,
        acknowledgment_at        TIMESTAMPTZ,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "lms_enrollments_company_user_uq",
      stmt: `CREATE UNIQUE INDEX IF NOT EXISTS lms_enrollments_company_user_uq ON lms_enrollments(company_id, user_id)` },
    { label: "lms_enrollments_company_status_idx",
      stmt: `CREATE INDEX IF NOT EXISTS lms_enrollments_company_status_idx ON lms_enrollments(company_id, status)` },
    { label: "lms_enrollments_deadline_idx",
      stmt: `CREATE INDEX IF NOT EXISTS lms_enrollments_deadline_idx ON lms_enrollments(deadline_at)` },
    // Item 4 (P0 sprint, 2026-05-14): countdown starts on first quiz
    // attempt, not at enrollment time. Nullable so existing rows keep
    // their current behavior until the next /quiz/submit recomputes.
    { label: "lms_enrollments.deadline_started_at",
      stmt: `ALTER TABLE lms_enrollments ADD COLUMN IF NOT EXISTS deadline_started_at TIMESTAMPTZ` },
    // Item 3 (P0 sprint, 2026-05-14): LMS soft-delete on users.
    // Hides the row from LMS roster + audit dashboard while preserving
    // certificates, signatures, and attempt history for legal.
    { label: "users.archived_at",
      stmt: `ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ` },

    // Items 8 + 9 (P1 sprint, 2026-05-14): per-tenant LMS settings.
    // Single row per company. First inhabitant: admin_bypass_allowed
    // (default false). Future settings join the same row.
    { label: "CREATE lms_settings", stmt: `
      CREATE TABLE IF NOT EXISTS lms_settings (
        id                    SERIAL PRIMARY KEY,
        company_id            INTEGER NOT NULL REFERENCES companies(id),
        admin_bypass_allowed  BOOLEAN NOT NULL DEFAULT FALSE,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "lms_settings_company_uq",
      stmt: `CREATE UNIQUE INDEX IF NOT EXISTS lms_settings_company_uq ON lms_settings(company_id)` },
    // Add/Edit Employee admin toggles (2026-05-15). Mirror the
    // admin_bypass_allowed pattern. Default false so the gate stays
    // owner-only until the tenant owner enables it.
    { label: "lms_settings.admin_add_employee_allowed",
      stmt: `ALTER TABLE lms_settings ADD COLUMN IF NOT EXISTS admin_add_employee_allowed BOOLEAN NOT NULL DEFAULT FALSE` },
    { label: "lms_settings.admin_edit_employee_allowed",
      stmt: `ALTER TABLE lms_settings ADD COLUMN IF NOT EXISTS admin_edit_employee_allowed BOOLEAN NOT NULL DEFAULT FALSE` },

    { label: "CREATE lms_module_progress", stmt: `
      CREATE TABLE IF NOT EXISTS lms_module_progress (
        id               SERIAL PRIMARY KEY,
        company_id       INTEGER NOT NULL REFERENCES companies(id),
        enrollment_id    INTEGER NOT NULL REFERENCES lms_enrollments(id) ON DELETE CASCADE,
        module_id        TEXT NOT NULL,
        status           module_status NOT NULL DEFAULT 'not_started',
        best_score       INTEGER NOT NULL DEFAULT 0,
        attempts         INTEGER NOT NULL DEFAULT 0,
        started_at       TIMESTAMPTZ,
        passed_at        TIMESTAMPTZ,
        last_attempt_at  TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "lms_module_progress_enrollment_module_uq",
      stmt: `CREATE UNIQUE INDEX IF NOT EXISTS lms_module_progress_enrollment_module_uq ON lms_module_progress(enrollment_id, module_id)` },
    { label: "lms_module_progress_company_status_idx",
      stmt: `CREATE INDEX IF NOT EXISTS lms_module_progress_company_status_idx ON lms_module_progress(company_id, status)` },

    { label: "CREATE lms_quiz_state", stmt: `
      CREATE TABLE IF NOT EXISTS lms_quiz_state (
        id                      SERIAL PRIMARY KEY,
        company_id              INTEGER NOT NULL REFERENCES companies(id),
        enrollment_id           INTEGER NOT NULL REFERENCES lms_enrollments(id) ON DELETE CASCADE,
        module_id               TEXT NOT NULL,
        current_question_index  INTEGER NOT NULL DEFAULT 0,
        answers                 JSONB NOT NULL DEFAULT '[]'::jsonb,
        meta                    JSONB,
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "lms_quiz_state_enrollment_module_uq",
      stmt: `CREATE UNIQUE INDEX IF NOT EXISTS lms_quiz_state_enrollment_module_uq ON lms_quiz_state(enrollment_id, module_id)` },

    { label: "CREATE lms_quiz_attempts", stmt: `
      CREATE TABLE IF NOT EXISTS lms_quiz_attempts (
        id             SERIAL PRIMARY KEY,
        company_id     INTEGER NOT NULL REFERENCES companies(id),
        enrollment_id  INTEGER NOT NULL REFERENCES lms_enrollments(id) ON DELETE CASCADE,
        module_id      TEXT NOT NULL,
        answers        JSONB NOT NULL,
        question_ids   JSONB,
        score          INTEGER NOT NULL,
        passed         BOOLEAN NOT NULL,
        attempted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "lms_quiz_attempts_enrollment_module_attempted_idx",
      stmt: `CREATE INDEX IF NOT EXISTS lms_quiz_attempts_enrollment_module_attempted_idx ON lms_quiz_attempts(enrollment_id, module_id, attempted_at)` },
    { label: "lms_quiz_attempts_company_attempted_idx",
      stmt: `CREATE INDEX IF NOT EXISTS lms_quiz_attempts_company_attempted_idx ON lms_quiz_attempts(company_id, attempted_at)` },

    // ── [lms-signatures 2026-05-12] Onboarding / handbook signature infra ─
    // Six tables + three enums. UETA / E-SIGN compliance: tamper-evident
    // versioning, IP / device capture, audit log, annual cycles, forced
    // re-ack on material changes. Source of truth schema lives in
    // lib/db/src/schema/lms-signatures.ts; mirrored here so the
    // cold-start guard creates them before any signature endpoint runs.
    { label: "enum signature_method",
      stmt: `
        DO $$ BEGIN
          CREATE TYPE signature_method AS ENUM ('drawn', 'typed');
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      ` },
    { label: "enum signed_document_status",
      stmt: `
        DO $$ BEGIN
          CREATE TYPE signed_document_status AS ENUM ('active', 'superseded', 'revoked');
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      ` },
    { label: "enum signature_event_type",
      stmt: `
        DO $$ BEGIN
          CREATE TYPE signature_event_type AS ENUM ('sign_initiated', 'sign_completed', 'co_signed', 'pdf_downloaded', 'revoked');
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      ` },

    { label: "CREATE lms_document_versions", stmt: `
      CREATE TABLE IF NOT EXISTS lms_document_versions (
        id                  SERIAL PRIMARY KEY,
        company_id          INTEGER NOT NULL REFERENCES companies(id),
        document_type       TEXT NOT NULL,
        locale              TEXT NOT NULL,
        version_hash        TEXT NOT NULL,
        content_html        TEXT NOT NULL,
        is_material         BOOLEAN NOT NULL DEFAULT FALSE,
        notes               TEXT,
        effective_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by_user_id  INTEGER REFERENCES users(id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    // PR #2 backfill: if PR #1's lms_document_versions table already
    // exists from an earlier deploy without company_id, add the column.
    // Idempotent — guarded by IF NOT EXISTS so re-runs are no-ops.
    // Drops the legacy non-tenant-scoped indexes that PR #1 created so
    // the new tenant-scoped indexes below can take over.
    { label: "ALTER lms_document_versions add company_id (if missing)", stmt: `
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'lms_document_versions' AND column_name = 'company_id'
        ) THEN
          ALTER TABLE lms_document_versions
            ADD COLUMN company_id INTEGER REFERENCES companies(id);
          -- Backfill any pre-existing rows to Phes (company_id=1). PR #1
          -- shipped before any signing endpoints, so this should normally
          -- be a no-op.
          UPDATE lms_document_versions SET company_id = 1 WHERE company_id IS NULL;
          ALTER TABLE lms_document_versions ALTER COLUMN company_id SET NOT NULL;
        END IF;
      END $$
    ` },
    { label: "DROP legacy lms_document_versions indexes (if exist)",
      stmt: `DROP INDEX IF EXISTS lms_document_versions_type_locale_hash_uq` },
    { label: "DROP legacy lms_document_versions type_locale idx",
      stmt: `DROP INDEX IF EXISTS lms_document_versions_type_locale_idx` },
    { label: "lms_document_versions_company_type_locale_hash_uq",
      stmt: `CREATE UNIQUE INDEX IF NOT EXISTS lms_document_versions_company_type_locale_hash_uq ON lms_document_versions(company_id, document_type, locale, version_hash)` },
    { label: "lms_document_versions_company_type_locale_idx",
      stmt: `CREATE INDEX IF NOT EXISTS lms_document_versions_company_type_locale_idx ON lms_document_versions(company_id, document_type, locale)` },

    { label: "CREATE lms_signed_documents", stmt: `
      CREATE TABLE IF NOT EXISTS lms_signed_documents (
        id                                SERIAL PRIMARY KEY,
        company_id                        INTEGER NOT NULL REFERENCES companies(id),
        user_id                           INTEGER NOT NULL REFERENCES users(id),
        document_type                     TEXT NOT NULL,
        document_version_id               INTEGER NOT NULL REFERENCES lms_document_versions(id),
        locale                            TEXT NOT NULL,
        version_hash                      TEXT NOT NULL,
        employee_signature                TEXT NOT NULL,
        employee_signature_method         signature_method NOT NULL,
        signed_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ip_address                        TEXT NOT NULL,
        device_info                       TEXT NOT NULL,
        representative_user_id            INTEGER REFERENCES users(id),
        representative_signature          TEXT,
        representative_signature_method   signature_method,
        representative_signed_at          TIMESTAMPTZ,
        representative_ip_address         TEXT,
        representative_device_info        TEXT,
        status                            signed_document_status NOT NULL DEFAULT 'active',
        superseded_by_id                  INTEGER,
        superseded_at                     TIMESTAMPTZ,
        pdf_storage_url                   TEXT,
        cycle_id                          INTEGER,
        created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "lms_signed_documents_company_user_type_idx",
      stmt: `CREATE INDEX IF NOT EXISTS lms_signed_documents_company_user_type_idx ON lms_signed_documents(company_id, user_id, document_type)` },
    { label: "lms_signed_documents_company_status_idx",
      stmt: `CREATE INDEX IF NOT EXISTS lms_signed_documents_company_status_idx ON lms_signed_documents(company_id, status)` },
    { label: "lms_signed_documents_cycle_idx",
      stmt: `CREATE INDEX IF NOT EXISTS lms_signed_documents_cycle_idx ON lms_signed_documents(cycle_id)` },

    { label: "CREATE lms_signature_events", stmt: `
      CREATE TABLE IF NOT EXISTS lms_signature_events (
        id                  SERIAL PRIMARY KEY,
        company_id          INTEGER NOT NULL REFERENCES companies(id),
        user_id             INTEGER NOT NULL REFERENCES users(id),
        event_type          signature_event_type NOT NULL,
        signed_document_id  INTEGER REFERENCES lms_signed_documents(id),
        document_type       TEXT,
        ip_address          TEXT NOT NULL,
        user_agent          TEXT NOT NULL,
        event_data          JSONB,
        event_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "lms_signature_events_company_user_at_idx",
      stmt: `CREATE INDEX IF NOT EXISTS lms_signature_events_company_user_at_idx ON lms_signature_events(company_id, user_id, event_at)` },
    { label: "lms_signature_events_signed_document_idx",
      stmt: `CREATE INDEX IF NOT EXISTS lms_signature_events_signed_document_idx ON lms_signature_events(signed_document_id)` },

    { label: "CREATE lms_completion_certificates", stmt: `
      CREATE TABLE IF NOT EXISTS lms_completion_certificates (
        id                       SERIAL PRIMARY KEY,
        company_id               INTEGER NOT NULL REFERENCES companies(id),
        user_id                  INTEGER NOT NULL REFERENCES users(id),
        module_id                TEXT NOT NULL,
        quiz_attempt_id          INTEGER,
        score                    INTEGER,
        passed                   BOOLEAN NOT NULL,
        curriculum_version_hash  TEXT,
        locale                   TEXT NOT NULL,
        ip_address               TEXT NOT NULL,
        device_info              TEXT NOT NULL,
        issued_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pdf_storage_url          TEXT,
        revoked_at               TIMESTAMPTZ,
        revoked_reason           TEXT,
        cycle_id                 INTEGER,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "lms_completion_certificates_company_user_module_idx",
      stmt: `CREATE INDEX IF NOT EXISTS lms_completion_certificates_company_user_module_idx ON lms_completion_certificates(company_id, user_id, module_id)` },
    { label: "lms_completion_certificates_company_issued_idx",
      stmt: `CREATE INDEX IF NOT EXISTS lms_completion_certificates_company_issued_idx ON lms_completion_certificates(company_id, issued_at)` },

    { label: "CREATE lms_annual_ack_cycles", stmt: `
      CREATE TABLE IF NOT EXISTS lms_annual_ack_cycles (
        id                  SERIAL PRIMARY KEY,
        company_id          INTEGER NOT NULL REFERENCES companies(id),
        cycle_year          INTEGER NOT NULL,
        deadline_at         TIMESTAMPTZ NOT NULL,
        required_documents  JSONB NOT NULL,
        opened_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at           TIMESTAMPTZ,
        notes               TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "lms_annual_ack_cycles_company_year_uq",
      stmt: `CREATE UNIQUE INDEX IF NOT EXISTS lms_annual_ack_cycles_company_year_uq ON lms_annual_ack_cycles(company_id, cycle_year)` },

    { label: "CREATE lms_pending_re_ack", stmt: `
      CREATE TABLE IF NOT EXISTS lms_pending_re_ack (
        id                                SERIAL PRIMARY KEY,
        company_id                        INTEGER NOT NULL REFERENCES companies(id),
        user_id                           INTEGER NOT NULL REFERENCES users(id),
        document_type                     TEXT NOT NULL,
        new_version_id                    INTEGER NOT NULL REFERENCES lms_document_versions(id),
        new_version_hash                  TEXT NOT NULL,
        trigger_reason                    TEXT NOT NULL,
        triggered_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        triggered_by_user_id              INTEGER REFERENCES users(id),
        acknowledged_at                   TIMESTAMPTZ,
        acknowledged_signed_document_id   INTEGER REFERENCES lms_signed_documents(id),
        defer_until                       TIMESTAMPTZ,
        created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "lms_pending_re_ack_company_user_pending_idx",
      stmt: `CREATE INDEX IF NOT EXISTS lms_pending_re_ack_company_user_pending_idx ON lms_pending_re_ack(company_id, user_id, acknowledged_at)` },
    { label: "lms_pending_re_ack_document_type_idx",
      stmt: `CREATE INDEX IF NOT EXISTS lms_pending_re_ack_document_type_idx ON lms_pending_re_ack(document_type)` },

    // [lms-onboarding-intake 2026-05-13 PR #11] Operational intake form.
    // Excludes SSN / W-4 / I-9 / direct deposit (those live with ADP).
    // Stores emergency contact, sizing, personal vehicle + insurance for
    // techs who drive, languages, preferred name + pronouns.
    { label: "CREATE lms_onboarding_intake", stmt: `
      CREATE TABLE IF NOT EXISTS lms_onboarding_intake (
        id                                 SERIAL PRIMARY KEY,
        company_id                         INTEGER NOT NULL REFERENCES companies(id),
        user_id                            INTEGER NOT NULL REFERENCES users(id),
        preferred_name                     TEXT,
        pronouns                           TEXT,
        personal_email                     TEXT,
        personal_cell_phone                TEXT,
        emergency_contact_name             TEXT,
        emergency_contact_relationship     TEXT,
        emergency_contact_phone            TEXT,
        languages_spoken                   TEXT,
        shirt_size                         TEXT,
        apron_size                         TEXT,
        drives_personal_vehicle            BOOLEAN NOT NULL DEFAULT FALSE,
        vehicle_insurance_company          TEXT,
        vehicle_insurance_policy_number    TEXT,
        vehicle_insurance_expires_at       DATE,
        vehicle_license_plate              TEXT,
        drivers_license_state              TEXT,
        drivers_license_expires_at         DATE,
        notes                              TEXT,
        submitted_at                       TIMESTAMPTZ,
        created_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "lms_onboarding_intake_company_user_uq",
      stmt: `CREATE UNIQUE INDEX IF NOT EXISTS lms_onboarding_intake_company_user_uq ON lms_onboarding_intake(company_id, user_id)` },
    { label: "lms_onboarding_intake_company_submitted_idx",
      stmt: `CREATE INDEX IF NOT EXISTS lms_onboarding_intake_company_submitted_idx ON lms_onboarding_intake(company_id, submitted_at)` },

    // [feature/onboarding-intake-vehicle-and-address 2026-05-22]
    // Idempotent ALTER TABLE ADD COLUMN IF NOT EXISTS statements
    // (Postgres 9.6+). Re-running is a no-op once applied.
    //
    // Home address: required for tax compliance + emergency response.
    // Phes does NOT use home address for mileage reimbursement.
    { label: "lms_onboarding_intake.home_address_street",
      stmt: `ALTER TABLE lms_onboarding_intake ADD COLUMN IF NOT EXISTS home_address_street TEXT` },
    { label: "lms_onboarding_intake.home_address_unit",
      stmt: `ALTER TABLE lms_onboarding_intake ADD COLUMN IF NOT EXISTS home_address_unit TEXT` },
    { label: "lms_onboarding_intake.home_address_city",
      stmt: `ALTER TABLE lms_onboarding_intake ADD COLUMN IF NOT EXISTS home_address_city TEXT` },
    { label: "lms_onboarding_intake.home_address_state",
      stmt: `ALTER TABLE lms_onboarding_intake ADD COLUMN IF NOT EXISTS home_address_state TEXT DEFAULT 'IL'` },
    { label: "lms_onboarding_intake.home_address_zip",
      stmt: `ALTER TABLE lms_onboarding_intake ADD COLUMN IF NOT EXISTS home_address_zip TEXT` },

    // Expanded vehicle fields: make / model / year / color in addition
    // to existing insurance + license-plate columns.
    { label: "lms_onboarding_intake.vehicle_make",
      stmt: `ALTER TABLE lms_onboarding_intake ADD COLUMN IF NOT EXISTS vehicle_make TEXT` },
    { label: "lms_onboarding_intake.vehicle_model",
      stmt: `ALTER TABLE lms_onboarding_intake ADD COLUMN IF NOT EXISTS vehicle_model TEXT` },
    { label: "lms_onboarding_intake.vehicle_year",
      stmt: `ALTER TABLE lms_onboarding_intake ADD COLUMN IF NOT EXISTS vehicle_year INTEGER` },
    { label: "lms_onboarding_intake.vehicle_color",
      stmt: `ALTER TABLE lms_onboarding_intake ADD COLUMN IF NOT EXISTS vehicle_color TEXT` },

    // Driver's license number (sensitive PII; encryption-at-rest TODO).
    { label: "lms_onboarding_intake.drivers_license_number",
      stmt: `ALTER TABLE lms_onboarding_intake ADD COLUMN IF NOT EXISTS drivers_license_number TEXT` },

    // Vehicle-use protocol acknowledgment (boolean + timestamp).
    { label: "lms_onboarding_intake.vehicle_protocol_acknowledged",
      stmt: `ALTER TABLE lms_onboarding_intake ADD COLUMN IF NOT EXISTS vehicle_protocol_acknowledged BOOLEAN NOT NULL DEFAULT FALSE` },
    { label: "lms_onboarding_intake.vehicle_protocol_acknowledged_at",
      stmt: `ALTER TABLE lms_onboarding_intake ADD COLUMN IF NOT EXISTS vehicle_protocol_acknowledged_at TIMESTAMPTZ` },

    // ── Job rate mods (per-job time and fee adjustments) ──────────────────
    // Layered onto the flat jobs.amount/base_fee: each mod is either a
    // 'time' adjustment (minutes + computed amount) or a 'flat' fee adjustment.
    // The route handler recomputes jobs.amount = base_fee + SUM(mods.amount)
    // on every write.
    { label: "CREATE job_rate_mods", stmt: `
      CREATE TABLE IF NOT EXISTS job_rate_mods (
        id          SERIAL PRIMARY KEY,
        company_id  INT NOT NULL REFERENCES companies(id),
        job_id      INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        mod_type    TEXT NOT NULL CHECK (mod_type IN ('time', 'flat')),
        minutes     INT,
        amount      NUMERIC(10,2) NOT NULL,
        reason      TEXT NOT NULL,
        created_by  INT REFERENCES users(id),
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )
    ` },
    { label: "idx_job_rate_mods_job",
      stmt: `CREATE INDEX IF NOT EXISTS idx_job_rate_mods_job ON job_rate_mods(company_id, job_id)` },
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

  console.log("[scope-zone-fix] Completed.");
}

// ── Zone sync — correct all Oak Lawn + Schaumburg zones (2026-04-10) ──────────
// Idempotent UPSERT: inserts or updates every zone by name+company_id+location.
// Source: MaidCentral screenshots 2026-04-10.
// After upserting, runs a SQL pass to remove duplicate zips (first alphabetical
// zone by name wins any zip that appears in multiple zones).
async function runZoneSync(): Promise<void> {
  // Ensure location column exists (idempotent guard)
  await db.execute(sql`ALTER TABLE service_zones ADD COLUMN IF NOT EXISTS location TEXT DEFAULT 'oak_lawn'`);
  await db.execute(sql`ALTER TABLE service_zones ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#6B6860'`);

  // Rename "Homewood/Harvey/Markham" → "Homewood/Harvey" (Markham 60428 excluded)
  await db.execute(sql`
    UPDATE service_zones
    SET name = 'Homewood/Harvey'
    WHERE company_id = ${PHES}
      AND location = 'oak_lawn'
      AND name = 'Homewood/Harvey/Markham'
  `);

  type ZoneSpec = { name: string; location: string; color: string; zip_codes: string[] };

  // Colors synced from MaidCentral (2026-04-16)
  const OAK_LAWN_ZONES: ZoneSpec[] = [
    { name: "Chicago Central",                     location: "oak_lawn",   color: "#7D00A8", zip_codes: ["60632","60609","60615","60653","60608","60616","60623","60804","60638"] },
    { name: "Chicago Downtown/Loop Zone",           location: "oak_lawn",   color: "#4B0082", zip_codes: ["60605","60654","60601","60661","60606","60602","60603","60604","60699","60611","60610","60607"] },
    { name: "Chicago North Residential Zone",       location: "oak_lawn",   color: "#EC6F16", zip_codes: ["60622","60642","60614","60647","60651","60639","60641","60634"] },
    { name: "Chicago South",                        location: "oak_lawn",   color: "#D400C8", zip_codes: ["60628","60617","60619","60649","60620","60637"] },
    { name: "Chicago West Side",                    location: "oak_lawn",   color: "#FF7F50", zip_codes: ["60624","60644","60612"] },
    { name: "Company Zone",                         location: "oak_lawn",   color: "#FF00A8", zip_codes: ["60453","60418","60803","60652","60655","60415","60457","60456","60465","60482","60643","60805","60459","60455","60454"] },
    { name: "Homer Glen/Lemont/Burr Ridge",         location: "oak_lawn",   color: "#FF8D69", zip_codes: ["60491","60439","60527"] },
    { name: "Homewood/Harvey",                      location: "oak_lawn",   color: "#8C0000", zip_codes: ["60430","60426","60429"] },
    { name: "La Grange/Hodgkins/Berwyn",            location: "oak_lawn",   color: "#8D00FF", zip_codes: ["60534","60402","60304","60513","60546","60130","60141","60155","60526","60154","60525","60558","60501"] },
    { name: "Lake View/Lincoln Square/Lincolnwood", location: "oak_lawn",   color: "#0A7A09", zip_codes: ["60625","60646","60630","60659","60640","60660","60626","60645","60712","60618","60613","60657","60076"] },
    { name: "Maywood/Northlake/Schiller Park",      location: "oak_lawn",   color: "#FF6666", zip_codes: ["60176","60131","60164","60163","60162","60104","60160","60706","60171","60165","60153","60305","60707","60302","60301"] },
    { name: "Naperville/Woodridge/Lisle",           location: "oak_lawn",   color: "#FEB9FF", zip_codes: ["60540","60532","60517","60565","60516","60561"] },
    { name: "Norridge/Park Ridge/Des Plaines",      location: "oak_lawn",   color: "#00F20A", zip_codes: ["60016","60068","60631","60018","60666","60656","60706","60053"] },
    { name: "South Suburbs",                        location: "oak_lawn",   color: "#FF0000", zip_codes: ["60409","60633","60406","60472","60827","46311","60411","46324","60430","60429","60422","60428","60478","60426","60469","60473"] },
    { name: "Southwest Suburbs",                    location: "oak_lawn",   color: "#FFC900", zip_codes: ["60441","60446","60440","60490","60439","60527","60480","60491","60458","60451","60423"] },
    { name: "Tinley/Orlando/Palos Park",            location: "oak_lawn",   color: "#FFD700", zip_codes: ["60464","60463","60445","60452","60477","60467","60462","60487","60466"] },
    { name: "Westmont/Lombard/Elmhurst",            location: "oak_lawn",   color: "#D988FF", zip_codes: ["60559","60514","60521","60523","60515","60148","60126","60181"] },
  ];

  const SCHAUMBURG_ZONES: ZoneSpec[] = [
    { name: "Barrington / Streamwood / Elgin",             location: "schaumburg", color: "#42F411", zip_codes: ["60010","60011","60107","60120","60172","60179","60192","60201"] },
    { name: "Elk Grove / Des Plaines / Buffalo Grove",     location: "schaumburg", color: "#FFB200", zip_codes: ["60009","60017","60019","60089","60090","60007"] },
    { name: "Schaumburg / Palatine / Arlington Heights",   location: "schaumburg", color: "#00E6FF", zip_codes: ["60159","60168","60169","60173","60193","60194","60195","60196","60004","60005","60006","60008","60038","60055","60056","60067","60074","60078","60094","60095"] },
  ];

  const allZones = [...OAK_LAWN_ZONES, ...SCHAUMBURG_ZONES];

  for (const zone of allZones) {
    const zipArray = zone.zip_codes;
    const zipLiteral = zipArray.length > 0
      ? sql.raw(`ARRAY[${zipArray.map(z => `'${z}'`).join(",")}]`)
      : sql.raw(`ARRAY[]::text[]`);
    // Update existing zone if it exists (idempotent) — key: company_id + location + name
    await db.execute(sql`
      UPDATE service_zones
      SET color     = ${zone.color},
          zip_codes = ${zipLiteral}
      WHERE company_id = ${PHES}
        AND location  = ${zone.location}
        AND name      = ${zone.name}
    `);
    // Insert if it doesn't exist yet
    await db.execute(sql`
      INSERT INTO service_zones (company_id, name, location, color, zip_codes, is_active, sort_order)
      SELECT ${PHES}, ${zone.name}, ${zone.location}, ${zone.color}, ${zipLiteral}, true, 0
      WHERE NOT EXISTS (
        SELECT 1 FROM service_zones
        WHERE company_id = ${PHES}
          AND location   = ${zone.location}
          AND name       = ${zone.name}
      )
    `);
  }

  // Remove duplicate zips across ALL active PHES zones.
  // Canonical rule: lower sort_order wins; alphabetical name breaks ties.
  // COALESCE guards against NULL from array_agg when a zone loses all zips
  // (which would violate the NOT NULL constraint on zip_codes).
  await db.execute(sql`
    UPDATE service_zones sz
    SET zip_codes = COALESCE(
      (
        SELECT array_agg(z ORDER BY z)
        FROM unnest(sz.zip_codes) z
        WHERE NOT EXISTS (
          SELECT 1
          FROM service_zones winner
          WHERE winner.company_id = ${PHES}
            AND winner.is_active  = true
            AND winner.id        != sz.id
            AND z = ANY(winner.zip_codes)
            AND (
              winner.sort_order < sz.sort_order
              OR (winner.sort_order = sz.sort_order AND winner.name < sz.name)
            )
        )
      ),
      ARRAY[]::text[]
    )
    WHERE sz.company_id = ${PHES}
      AND sz.is_active  = true
  `);

  console.log("[zone-sync] Completed — all Oak Lawn and Schaumburg zones upserted and deduplicated.");
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

// ── Scope visibility — hide office-only scopes from public booking widget ────
async function runScopeVisibility(): Promise<void> {
  // Add show_online column if missing
  await db.execute(sql`ALTER TABLE pricing_scopes ADD COLUMN IF NOT EXISTS show_online BOOLEAN NOT NULL DEFAULT true`);
  // Hourly Deep Clean = office-only, hide from public widget
  await db.execute(sql`
    UPDATE pricing_scopes SET show_online = false
    WHERE company_id = ${PHES}
      AND name ILIKE '%hourly deep clean%'
  `);
  // Hourly Standard Cleaning = also office-only
  await db.execute(sql`
    UPDATE pricing_scopes SET show_online = false
    WHERE company_id = ${PHES}
      AND name ILIKE '%hourly standard%'
  `);
  console.log("[scope-visibility] Completed.");
}

// [hotfix 2026-04-29 / iter 2] Dedupe duplicate jobs + partial unique
// index that prevents the same client from booking two overlapping
// non-cancelled jobs at the same date+time going forward.
//
// Iter 1 (PR #10) added a unique index on raw scheduled_time. Postgres
// treats NULL = NULL as distinct in a unique constraint, so two rows
// with NULL scheduled_time and identical (company, client, date) did
// NOT collide — but the recurring engine creates jobs with NULL time
// (lib/recurring-jobs.ts ~256), so this gap was real.
//
// Iter 2 fix:
//   - Dedupe partition uses COALESCE(scheduled_time::text, '00:00:00')
//     so NULL-time duplicates collide into the same partition.
//   - Drop the old uq_jobs_no_double_book index and replace with one
//     keyed on the same COALESCE expression. Now NULL-time pairs DO
//     trip the constraint going forward.
//   - Keep MOST-RECENTLY-UPDATED row (created_at DESC, id DESC tie-
//     break), not lowest id. The newer row carries the latest tech /
//     time / address state from edits; the older row is the import
//     leftover. This keeps the operator's manual edits sticky.
//
// Constraint scope:
//   (company_id, client_id, scheduled_date, COALESCE(scheduled_time::text, '00:00:00'))
//   WHERE status NOT IN ('cancelled')
//
// Cancelled jobs can still coexist with active ones (cancel + rebook).
async function runJobsDedupeAndConstraint(): Promise<void> {
  // Step 1: dedupe. Partition collapses NULL scheduled_time into the
  // sentinel '00:00:00' so two NULL-time rows for the same client/date
  // are caught. Order by created_at DESC, id DESC to keep the latest
  // row — operator edits land via PATCH which doesn't change `id` but
  // does bump `updated_at` indirectly via the row itself; if both
  // share created_at, lowest id wins as a stable tiebreak.
  const deleted = await db.execute(sql`
    WITH dupes AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY company_id, client_id, scheduled_date,
                            COALESCE(scheduled_time::text, '00:00:00')
               ORDER BY created_at DESC NULLS LAST, id DESC
             ) AS rn
      FROM jobs
      WHERE status NOT IN ('cancelled')
    )
    DELETE FROM jobs
    WHERE id IN (SELECT id FROM dupes WHERE rn > 1)
    RETURNING id
  `);
  const removed = (deleted.rows ?? []).length;
  // [iter 2 logging] Always log — distinguishes "ran, found nothing"
  // from "didn't run at all" when staring at Railway logs.
  console.log(`[jobs-dedupe] Migration ran. Removed ${removed} duplicate job row(s).`);

  // Step 2: replace the old index with the COALESCE-keyed version.
  // Drop-then-create is safe because the dedupe in step 1 just ran;
  // no transient duplicates to trip the new index. IF EXISTS guards
  // first-run when the old name was never created.
  await db.execute(sql`DROP INDEX IF EXISTS uq_jobs_no_double_book`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_no_double_book
      ON jobs (
        company_id,
        client_id,
        scheduled_date,
        (COALESCE(scheduled_time::text, '00:00:00'))
      )
      WHERE status NOT IN ('cancelled')
  `);
}

// [pay-matrix 2026-04-29] Backfill the per-employee pay matrix and
// the tenant defaults. Postgres applies the column-level DEFAULT to
// rows inserted AFTER the column is added, but rows that pre-date the
// ALTER get NULL by default. We coalesce to the documented Phes
// values so dispatch never reads a NULL pay rate.
async function runPayMatrixBackfill(): Promise<void> {
  // Tenant defaults — set on every company that doesn't already have
  // them. Phes operational defaults: residential commission 0.35,
  // commercial hourly $20.
  await db.execute(sql`
    UPDATE companies SET
      default_residential_pay_type  = COALESCE(default_residential_pay_type,  'commission'),
      default_residential_pay_rate  = COALESCE(default_residential_pay_rate,  0.35),
      default_commercial_pay_type   = COALESCE(default_commercial_pay_type,   'hourly'),
      default_commercial_pay_rate   = COALESCE(default_commercial_pay_rate,   20.0000)
    WHERE default_residential_pay_type IS NULL
       OR default_residential_pay_rate IS NULL
       OR default_commercial_pay_type  IS NULL
       OR default_commercial_pay_rate  IS NULL
  `);
  // Per-user matrix — backfill from the tenant default. New employees
  // added after this runs will inherit via the application-level
  // create-user flow (see routes/employees.ts when it touches this).
  const updated = await db.execute(sql`
    UPDATE users u SET
      residential_pay_type = COALESCE(u.residential_pay_type, c.default_residential_pay_type, 'commission'),
      residential_pay_rate = COALESCE(u.residential_pay_rate, c.default_residential_pay_rate, 0.35),
      commercial_pay_type  = COALESCE(u.commercial_pay_type,  c.default_commercial_pay_type,  'hourly'),
      commercial_pay_rate  = COALESCE(u.commercial_pay_rate,  c.default_commercial_pay_rate,  20.0000)
    FROM companies c
    WHERE u.company_id = c.id
      AND (u.residential_pay_type IS NULL
        OR u.residential_pay_rate IS NULL
        OR u.commercial_pay_type  IS NULL
        OR u.commercial_pay_rate  IS NULL)
    RETURNING u.id
  `);
  const n = (updated.rows ?? []).length;
  console.log(`[pay-matrix] Backfill ran. Updated ${n} user(s) with tenant pay defaults.`);
}

// [scheduling-engine 2026-04-29] One-shot 60→90 day window backfill.
// Existing recurring schedules generated 60 days of jobs under the
// old DAYS_AHEAD; new schedules get 90 going forward. Without this
// one-shot, dispatchers see a ragged horizon (some clients 60 days,
// others 90) until each schedule is independently edited. Calls the
// engine once per company with the new horizon — engine's own
// recurring_schedule_id + scheduled_date dedupe makes it safe to
// re-run; we just pick up the 60→90 day delta.
//
// Boot-time only. No-ops on subsequent runs because the dedupe
// inside generateJobsFromSchedule means there's nothing new to
// insert once everyone's at 90 days. Logs the totals so the deploy
// effect is visible in Railway logs.
async function runScheduleHorizonBackfill(): Promise<void> {
  const { runRecurringJobGeneration } = await import("./lib/recurring-jobs.js");
  await runRecurringJobGeneration();
  console.log(`[schedule-horizon-backfill] Ran with 90-day window. (Per-company create counts in [recurring-jobs] log lines above.)`);
}

// [scheduling-engine 2026-04-29] Seed Phes-default acquisition sources.
// Idempotent — ON CONFLICT (company_id, slug) DO NOTHING so the seed
// step is safe to re-run on every cold-start. Operators can rename
// the display via UPDATE; we only insert, never overwrite. New
// tenants will need their own seed (or a default-tenant template
// later); this targets PHES (company_id=1) only.
async function runAcquisitionSourcesSeed(): Promise<void> {
  const sources = [
    { slug: "google_ads",            name: "Google Ads",             order: 10 },
    { slug: "google_business_profile", name: "Google Business Profile", order: 20 },
    { slug: "thumbtack",             name: "Thumbtack",              order: 30 },
    { slug: "yelp",                  name: "Yelp",                   order: 40 },
    { slug: "facebook",              name: "Facebook",               order: 50 },
    { slug: "instagram",             name: "Instagram",              order: 60 },
    { slug: "referral",              name: "Referral",               order: 70 },
    { slug: "word_of_mouth",         name: "Word of Mouth",          order: 80 },
    { slug: "repeat_customer",       name: "Repeat Customer",        order: 90 },
    { slug: "other",                 name: "Other",                  order: 999 },
  ];
  for (const s of sources) {
    await db.execute(sql`
      INSERT INTO acquisition_sources (company_id, slug, name, is_active, display_order)
      VALUES (${PHES}, ${s.slug}, ${s.name}, true, ${s.order})
      ON CONFLICT (company_id, slug) DO NOTHING
    `);
  }
  console.log(`[acquisition-sources-seed] Ensured ${sources.length} Phes default sources.`);
}

// [commercial-workflow 2026-04-29] Seed Phes-default service types
// (5 residential + 7 commercial = 12 rows). Each slug matches an
// existing serviceTypeEnum value so historical jobs stay valid;
// `name` is the display label per Sal's spec. default_allowed_hours
// stays NULL on first seed — operators set per-tenant defaults via
// the management UI in PR #2 (Sal will fill in 2.5 for Standard
// Clean, 4.0 for Deep Clean, etc., once that surface ships).
//
// Idempotent: ON CONFLICT (company_id, slug) DO NOTHING. Safe to
// re-run on every cold-start. Existing rows are not overwritten,
// so any operator edits to display name / order / default hours
// stick across deploys.
async function runServiceTypesSeed(): Promise<void> {
  const services = [
    // Residential (parent_slug='residential')
    { parent: "residential", slug: "standard_clean",     name: "Standard Clean",     order: 10 },
    { parent: "residential", slug: "deep_clean",         name: "Deep Clean",         order: 20 },
    { parent: "residential", slug: "move_in",            name: "Move In",            order: 30 },
    { parent: "residential", slug: "move_out",           name: "Move Out",           order: 40 },
    { parent: "residential", slug: "post_construction",  name: "Post-Construction",  order: 50 },
    // Commercial (parent_slug='commercial')
    { parent: "commercial",  slug: "office_cleaning",    name: "Office Cleaning",    order: 110 },
    { parent: "commercial",  slug: "common_areas",       name: "Common Areas",       order: 120 },
    { parent: "commercial",  slug: "turnover",           name: "Turnover",           order: 125 },
    { parent: "commercial",  slug: "ppm_common_areas",   name: "PPM Common Areas",   order: 130 },
    { parent: "commercial",  slug: "retail_store",       name: "Retail Store",       order: 140 },
    { parent: "commercial",  slug: "medical_office",     name: "Medical Office",     order: 150 },
    { parent: "commercial",  slug: "ppm_turnover",       name: "PPM Turnover",       order: 160 },
    { parent: "commercial",  slug: "post_event",         name: "Post Event",         order: 170 },
  ];
  for (const s of services) {
    await db.execute(sql`
      INSERT INTO service_types (company_id, parent_slug, slug, name, is_active, display_order)
      VALUES (${PHES}, ${s.parent}, ${s.slug}, ${s.name}, true, ${s.order})
      ON CONFLICT (company_id, slug) DO NOTHING
    `);
  }
  console.log(`[service-types-seed] Ensured ${services.length} Phes default service types (5 residential + 7 commercial).`);
}

// [PR / 2026-05-01] Backfill recurring_schedules.days_of_week from
// frequency for multi-day rows where the column is null/empty.
// MC-imported rows + schedules created before the days_of_week column
// existed have NULL there; the modal's parking-picker "Match schedule"
// button renders "Match schedule (—)" with an em-dash because the
// state has nothing to read. Idempotent — only fires when there's
// actually drift to fix. Single-day frequencies (weekly / biweekly /
// every_3_weeks / monthly) keep days_of_week NULL by design (they
// use the day_of_week enum); the modal handles the single-day case
// via the dayMap fallback at edit-job-modal.tsx:454.
async function runDaysOfWeekBackfill(): Promise<void> {
  // 'weekdays' frequency → Mon-Fri
  const weekdays = await db.execute(sql`
    UPDATE recurring_schedules
       SET days_of_week = '{1,2,3,4,5}'
     WHERE frequency = 'weekdays'
       AND (days_of_week IS NULL OR cardinality(days_of_week) = 0)
  `);
  // 'daily' frequency → Sun-Sat
  const daily = await db.execute(sql`
    UPDATE recurring_schedules
       SET days_of_week = '{0,1,2,3,4,5,6}'
     WHERE frequency = 'daily'
       AND (days_of_week IS NULL OR cardinality(days_of_week) = 0)
  `);
  const nWeekdays = (weekdays as any).rowCount ?? 0;
  const nDaily = (daily as any).rowCount ?? 0;
  if (nWeekdays > 0 || nDaily > 0) {
    console.log(
      `[phes-migration] days_of_week backfill: weekdays=${nWeekdays}, daily=${nDaily} row(s) updated`,
    );
  }
}

/**
 * [phes-chicago23 2026-05-12] One-shot password reset for every Phes
 * technician + office user. The user wanted every tech (Jose Ardila and
 * the rest) to be able to log in with `Chicago23` while we figure out
 * per-user invitations. Owners are excluded — sal's password stays
 * whatever he set it to.
 *
 * Gating: the migration only fires for a user where
 * `password_reset_to_chicago23_at IS NULL`. Once it runs, the timestamp
 * is set and the user is NEVER auto-reset again — so future deploys
 * leave a tech who has rotated their password alone, and the bulk-reset
 * admin tool is the way to push a new password later if needed.
 *
 * Why not just put the bcrypt hash in a SQL string? Bcrypt is salted —
 * we need the JS lib to generate the hash. Hence the JS function here
 * rather than another sql.raw entry.
 */
async function runPhesPasswordResetChicago23(): Promise<void> {
  const targets = await db.execute(sql`
    SELECT id FROM users
    WHERE company_id = ${PHES}
      AND role IN ('technician', 'office')
      AND password_reset_to_chicago23_at IS NULL
  `);
  const ids = (targets.rows as any[]).map((r) => r.id as number);
  if (ids.length === 0) {
    return; // Already reset every eligible user.
  }
  const hash = await bcrypt.hash("Chicago23", 10);
  await db.execute(sql`
    UPDATE users
    SET password_hash = ${hash}, password_reset_to_chicago23_at = NOW()
    WHERE id = ANY(${ids}::int[])
  `);
  console.log(
    `[phes-migration] chicago23-password-reset: ${ids.length} user(s) set (ids: ${ids.join(", ")})`,
  );
}

/**
 * Onboarding-readiness sprint 2026-05-15 (Item 10):
 * Archive the 10 phantom LMS learners that aren't on the active
 * Maid Central roster. Soft-delete via users.archived_at; cert /
 * signature history is preserved.
 *
 * Matching strategy: case-insensitive (first_name, last_name)
 * pair OR exact email match. Idempotent — once archived_at is set,
 * we skip. Each match is logged so Sal can see exactly which user
 * rows were touched.
 *
 * delia.martinez.former@phes.internal is matched by email
 * (the literal "former" disambiguates from any active Delia).
 */
const PHANTOM_LEARNERS_2026_05_15: Array<
  { first: string; last: string } | { email: string }
> = [
  { first: "Alma", last: "Salinas" },
  { first: "Ana", last: "Valdez" },
  { first: "Diana", last: "Vasquez" },
  { first: "Guadalupe", last: "Mejia" },
  { first: "Juan", last: "Salazar" },
  { first: "Juliana", last: "Loredo" },
  { first: "Norma", last: "Puga" },
  { first: "Rosa", last: "Gallegos" },
  { first: "Tatiana", last: "Merchan" },
  { email: "delia.martinez.former@phes.internal" },
];

async function runPhantomLearnerArchive(): Promise<void> {
  const tagged: number[] = [];
  const alreadyArchived: number[] = [];
  const notFound: string[] = [];

  for (const entry of PHANTOM_LEARNERS_2026_05_15) {
    const label = "email" in entry
      ? entry.email
      : `${entry.first} ${entry.last}`;
    const where = "email" in entry
      ? sql`LOWER(email) = LOWER(${entry.email})`
      : sql`LOWER(first_name) = LOWER(${entry.first}) AND LOWER(last_name) = LOWER(${entry.last})`;

    const matches = await db.execute<{
      id: number;
      archived_at: Date | null;
      email: string;
    }>(sql`
      SELECT id, archived_at, email
      FROM users
      WHERE ${where} AND role != 'owner'
    `);

    const rows = (matches as any).rows ?? matches;
    if (!rows.length) {
      notFound.push(label);
      continue;
    }

    for (const row of rows as Array<{ id: number; archived_at: Date | null; email: string }>) {
      if (row.archived_at) {
        alreadyArchived.push(row.id);
        continue;
      }
      await db.execute(sql`
        UPDATE users
        SET archived_at = NOW()
        WHERE id = ${row.id}
      `);
      tagged.push(row.id);
    }
  }

  console.log(
    `[phantom-archive] tagged=${tagged.length} (ids: ${tagged.join(", ") || "none"}) ` +
      `already_archived=${alreadyArchived.length} not_found=${notFound.length}` +
      (notFound.length ? ` (${notFound.join(" | ")})` : ""),
  );
}

/**
 * Restore-active-learner migration (2026-05-20 sprint).
 *
 * PR #125 archived 9 users as "phantom learners not on the active
 * MaidCentral roster." Sal's MaidCentral roster screenshots on 5/20
 * confirm 6 of those 9 ARE active employees who SHOULD be in the LMS.
 * The PR #125 spec was based on outdated info; this migration undoes
 * the over-archive for the 6 confirmed-active employees and creates
 * the missing lms_enrollments rows so they appear on the admin roster.
 *
 * Sal explicitly keeps these archived (not restored):
 *   - Ana Valdez
 *   - Norma Puga
 *   - Tatiana Merchan
 *   - delia.martinez.former@phes.internal (the .former placeholder)
 *   - Generic Cleaner (never restored; placeholder account)
 *
 * Idempotent: only fires for users where archived_at IS NOT NULL.
 * Once restored, the row's archived_at goes back to NULL and the
 * migration is a no-op on subsequent boots. lms_enrollments creation
 * is also idempotent (skip if a row exists for that user).
 */
const RESTORE_ACTIVE_LEARNERS_2026_05_20: Array<{ first: string; last: string }> = [
  { first: "Alma", last: "Salinas" },
  { first: "Diana", last: "Vasquez" },
  { first: "Guadalupe", last: "Mejia" },
  { first: "Juan", last: "Salazar" },
  { first: "Juliana", last: "Loredo" },
  { first: "Rosa", last: "Gallegos" },
];

async function runRestoreActiveLearners(): Promise<void> {
  const PHES = 1;
  const DEFAULT_DEADLINE_DAYS = 7;
  const restored: number[] = [];
  const alreadyActive: number[] = [];
  const notFound: string[] = [];
  const enrollmentsCreated: number[] = [];

  for (const entry of RESTORE_ACTIVE_LEARNERS_2026_05_20) {
    const label = `${entry.first} ${entry.last}`;
    const rows = await db.execute<{
      id: number;
      archived_at: Date | null;
    }>(sql`
      SELECT id, archived_at FROM users
      WHERE company_id = ${PHES}
        AND LOWER(first_name) = LOWER(${entry.first})
        AND LOWER(last_name) = LOWER(${entry.last})
        AND role != 'owner'
      ORDER BY id ASC
      LIMIT 1
    `);
    const row = ((rows as any).rows ?? rows)[0] as
      | { id: number; archived_at: Date | null }
      | undefined;

    if (!row) {
      notFound.push(label);
      continue;
    }

    if (row.archived_at === null) {
      alreadyActive.push(row.id);
    } else {
      await db.execute(sql`
        UPDATE users
        SET archived_at = NULL
        WHERE id = ${row.id}
      `);
      restored.push(row.id);
    }

    // Idempotent enrollment creation: only INSERT if no row exists.
    const enr = await db.execute<{ id: number }>(sql`
      SELECT id FROM lms_enrollments
      WHERE company_id = ${PHES} AND user_id = ${row.id}
      LIMIT 1
    `);
    const enrRow = ((enr as any).rows ?? enr)[0];
    if (!enrRow) {
      const created = await db.execute<{ id: number }>(sql`
        INSERT INTO lms_enrollments
          (company_id, user_id, status, enrolled_at, deadline_at, last_activity_at)
        VALUES
          (${PHES}, ${row.id}, 'active', NOW(),
           NOW() + INTERVAL '${sql.raw(String(DEFAULT_DEADLINE_DAYS))} days',
           NOW())
        RETURNING id
      `);
      const createdRow = ((created as any).rows ?? created)[0];
      if (createdRow) enrollmentsCreated.push(createdRow.id);
    }
  }

  console.log(
    `[restore-active-learners] restored=${restored.length} (ids: ${restored.join(", ") || "none"}) ` +
      `already_active=${alreadyActive.length} enrollments_created=${enrollmentsCreated.length} ` +
      `not_found=${notFound.length}` +
      (notFound.length ? ` (${notFound.join(" | ")})` : ""),
  );
}

/**
 * QA sandbox account repurpose (2026-05-15 sprint, pre-sprint task).
 *
 * Dispatch created an audit fixture user during Phase 6 — repurpose it
 * as the permanent QA sandbox so future audits, demos, and regression
 * tests have a stable home that doesn't pollute production metrics.
 *
 * Match strategy: prefer email match on the legacy audit address,
 * fall back to user_id=446 (the value Dispatch documented). Idempotent
 * via the `email = 'training.sandbox@phes.io'` AND `is_sandbox = true`
 * guard — re-runs after first success are a no-op.
 *
 * LMS progress data is wiped so the sandbox starts clean every time
 * we run the migration on a fresh restore. `lms_signature_events` is
 * preserved (audit trail; legal). The sandbox password is left at
 * whatever bcrypt the audit fixture used; Sal rotates it manually
 * from the admin UI before each use per docs/qa-sandbox-account.md.
 */
async function runSandboxAccountRepurpose(): Promise<void> {
  const LEGACY_EMAIL = "audit.test.persona3@phes.io";
  const NEW_EMAIL = "training.sandbox@phes.io";
  const FALLBACK_ID = 446;

  const lookup = await db.execute<{ id: number; email: string; is_sandbox: boolean }>(sql`
    SELECT id, email, is_sandbox FROM users
    WHERE email = ${LEGACY_EMAIL} OR email = ${NEW_EMAIL} OR id = ${FALLBACK_ID}
    ORDER BY id ASC
    LIMIT 1
  `);
  const row = ((lookup as any).rows ?? lookup)[0] as
    | { id: number; email: string; is_sandbox: boolean }
    | undefined;

  if (!row) {
    console.log(
      `[sandbox-repurpose] skip — no matching user (looked for email=${LEGACY_EMAIL}, ${NEW_EMAIL}, or id=${FALLBACK_ID})`,
    );
    return;
  }

  const userId = row.id;
  const alreadyDone = row.email === NEW_EMAIL && row.is_sandbox;

  if (alreadyDone) {
    console.log(`[sandbox-repurpose] skip — user_id=${userId} already repurposed`);
    return;
  }

  // Wipe LMS progress for this user. Order matters — children before
  // parents. enrollment_id FK on lms_module_progress / lms_quiz_attempts
  // / lms_quiz_state cascades when we delete the enrollment row, but
  // we delete explicitly to keep the row counts in the log auditable.
  const wipeCounts: Record<string, number> = {};
  const wipe = async (label: string, stmt: any) => {
    const result = await db.execute(stmt);
    const count = (result as any).rowCount ?? 0;
    wipeCounts[label] = count;
  };

  await wipe(
    "lms_module_progress",
    sql`DELETE FROM lms_module_progress
        WHERE enrollment_id IN (SELECT id FROM lms_enrollments WHERE user_id = ${userId})`,
  );
  await wipe(
    "lms_quiz_attempts",
    sql`DELETE FROM lms_quiz_attempts
        WHERE enrollment_id IN (SELECT id FROM lms_enrollments WHERE user_id = ${userId})`,
  );
  await wipe(
    "lms_quiz_state",
    sql`DELETE FROM lms_quiz_state
        WHERE enrollment_id IN (SELECT id FROM lms_enrollments WHERE user_id = ${userId})`,
  );
  await wipe(
    "lms_signed_documents",
    sql`DELETE FROM lms_signed_documents WHERE user_id = ${userId}`,
  );
  await wipe(
    "lms_completion_certificates",
    sql`DELETE FROM lms_completion_certificates WHERE user_id = ${userId}`,
  );
  await wipe(
    "lms_pending_re_ack",
    sql`DELETE FROM lms_pending_re_ack WHERE user_id = ${userId}`,
  );
  await wipe(
    "lms_enrollments",
    sql`DELETE FROM lms_enrollments WHERE user_id = ${userId}`,
  );

  await db.execute(sql`
    UPDATE users
    SET email = ${NEW_EMAIL},
        first_name = 'Training',
        last_name = 'Sandbox',
        is_sandbox = TRUE,
        archived_at = NULL,
        is_active = TRUE
    WHERE id = ${userId}
  `);

  const wipeSummary = Object.entries(wipeCounts)
    .map(([table, count]) => `${table}=${count}`)
    .join(" ");
  console.log(
    `[sandbox-repurpose] user_id=${userId} renamed ${LEGACY_EMAIL} → ${NEW_EMAIL} (is_sandbox=true); wiped: ${wipeSummary}`,
  );
}

/**
 * Phes admin-view-consistency sprint (2026-05-15) — Item 2.
 *
 * Marks legacy quiz attempts beyond the cap as superseded. For each
 * (user_id, module_id) pair in Phes, keep the 4 most recent attempts
 * (ORDER BY attempted_at DESC) active and flag the remainder as
 * superseded with reason 'exceeded_cap_legacy_backfill'.
 *
 * Idempotent — guards on WHERE superseded=false so a re-run is a no-op.
 *
 * Also recomputes lms_module_progress.attempts to the non-superseded
 * count, so the admin roster's per-row "attempts" column shows the
 * correct cap-relative value instead of the raw historical count.
 *
 * Phes only (company_id=1). Other tenants are out of scope until the
 * 2nd-tenant readiness sprint.
 */
const PHES_COMPANY_ID = 1;

async function runSupersessionBackfill(): Promise<void> {
  const cap = 4;
  // 2026-05-17: JOIN to users with is_sandbox=false so the QA sandbox
  // account (user 446) doesn't get its real test attempts superseded as
  // if they were a Phes employee's legacy data. Sandbox writes flow
  // through the same tables but should not be counted in tenant-wide
  // migration aggregates.
  const candidates = await db.execute<{
    enrollment_id: number;
    module_id: string;
    user_id: number;
    total: number;
  }>(sql`
    SELECT
      qa.enrollment_id,
      qa.module_id,
      e.user_id,
      COUNT(*)::int AS total
    FROM lms_quiz_attempts qa
    INNER JOIN lms_enrollments e ON e.id = qa.enrollment_id
    INNER JOIN users u ON u.id = e.user_id
    WHERE qa.company_id = ${PHES_COMPANY_ID}
      AND qa.superseded = FALSE
      AND u.is_sandbox = FALSE
    GROUP BY qa.enrollment_id, qa.module_id, e.user_id
    HAVING COUNT(*) > ${cap}
  `);
  const rows = ((candidates as any).rows ?? candidates) as Array<{
    enrollment_id: number;
    module_id: string;
    user_id: number;
    total: number;
  }>;

  if (rows.length === 0) {
    console.log("[supersession-backfill] tenant=1 users=0 attempts_superseded=0");
    return;
  }

  let totalSuperseded = 0;
  const touchedUsers = new Set<number>();
  for (const row of rows) {
    const result = await db.execute(sql`
      UPDATE lms_quiz_attempts
      SET
        superseded = TRUE,
        superseded_reason = 'exceeded_cap_legacy_backfill',
        superseded_at = NOW()
      WHERE id IN (
        SELECT id FROM lms_quiz_attempts
        WHERE enrollment_id = ${row.enrollment_id}
          AND module_id = ${row.module_id}
          AND superseded = FALSE
        ORDER BY attempted_at DESC
        OFFSET ${cap}
      )
    `);
    const n = (result as any).rowCount ?? 0;
    totalSuperseded += n;
    if (n > 0) touchedUsers.add(row.user_id);
  }

  // Sync lms_module_progress.attempts to the non-superseded count so
  // the admin roster's "X/Y attempts" cell respects the cap. Sandbox
  // excluded from the sub-query for the same reason as above.
  if (totalSuperseded > 0) {
    await db.execute(sql`
      UPDATE lms_module_progress mp
      SET attempts = sub.live_count
      FROM (
        SELECT
          qa.enrollment_id,
          qa.module_id,
          COUNT(*)::int AS live_count
        FROM lms_quiz_attempts qa
        INNER JOIN lms_enrollments e ON e.id = qa.enrollment_id
        INNER JOIN users u ON u.id = e.user_id
        WHERE qa.company_id = ${PHES_COMPANY_ID}
          AND qa.superseded = FALSE
          AND u.is_sandbox = FALSE
        GROUP BY qa.enrollment_id, qa.module_id
      ) sub
      WHERE mp.enrollment_id = sub.enrollment_id
        AND mp.module_id = sub.module_id
        AND mp.company_id = ${PHES_COMPANY_ID}
    `);
  }

  console.log(
    `[supersession-backfill] tenant=${PHES_COMPANY_ID} users=${touchedUsers.size} attempts_superseded=${totalSuperseded}`,
  );
}

/**
 * 2026-05-20 audit follow-up: idempotent resync of
 * lms_module_progress.attempts against the non-superseded
 * lms_quiz_attempts count. The original supersession-backfill above
 * has its own resync, but that one only fires when this run's
 * backfill touched something (`totalSuperseded > 0`). If supersession
 * was already done in a prior boot but the resync missed any rows,
 * the drift persists.
 *
 * This function runs on every boot and only UPDATEs rows where the
 * stored `attempts` actually differs from the live count — so a
 * tenant in steady state is a no-op. Phes only.
 */
async function runModuleProgressAttemptsResync(): Promise<void> {
  const result = await db.execute(sql`
    UPDATE lms_module_progress mp
    SET attempts = COALESCE(sub.live_count, 0)
    FROM (
      SELECT
        e.id AS enrollment_id,
        mp_inner.module_id,
        COALESCE(
          (
            SELECT COUNT(*)::int
            FROM lms_quiz_attempts qa
            WHERE qa.enrollment_id = e.id
              AND qa.module_id = mp_inner.module_id
              AND qa.superseded = FALSE
          ),
          0
        ) AS live_count
      FROM lms_module_progress mp_inner
      INNER JOIN lms_enrollments e ON e.id = mp_inner.enrollment_id
      INNER JOIN users u ON u.id = e.user_id
      WHERE mp_inner.company_id = ${PHES_COMPANY_ID}
        AND u.is_sandbox = FALSE
    ) sub
    WHERE mp.enrollment_id = sub.enrollment_id
      AND mp.module_id = sub.module_id
      AND mp.company_id = ${PHES_COMPANY_ID}
      AND mp.attempts != sub.live_count
  `);
  const n = (result as any).rowCount ?? 0;
  if (n > 0) {
    console.log(
      `[module-progress-attempts-resync] tenant=${PHES_COMPANY_ID} rows_updated=${n}`,
    );
  }
}

/**
 * Phes admin-view-consistency sprint (2026-05-15) — Item 3.
 *
 * Normalizes lms_module_progress rows where best_score >= 80 but
 * status != 'passed'. The Final Mixed Test bug surfaced this: Jose's
 * row had best_score=100 with status='in_progress'. The defensive
 * rule in the SSoT covers the read path; this migration corrects the
 * persisted data so downstream queries (and any cache layers) see
 * the right value too.
 *
 * Idempotent — WHERE clause filters out rows already at 'passed'.
 * Phes only (company_id=1).
 */
async function runStatusRecompute(): Promise<void> {
  // 2026-05-17: exclude sandbox via JOIN. Sandbox writes flow through
  // the same table; recompute should only normalize real Phes employee
  // rows so QA test data stays at whatever state the test left it in.
  const result = await db.execute(sql`
    UPDATE lms_module_progress mp
    SET
      status = 'passed',
      passed_at = COALESCE(mp.passed_at, NOW())
    FROM lms_enrollments e, users u
    WHERE mp.enrollment_id = e.id
      AND e.user_id = u.id
      AND mp.company_id = ${PHES_COMPANY_ID}
      AND u.is_sandbox = FALSE
      AND mp.best_score >= 80
      AND mp.status != 'passed'
  `);
  const n = (result as any).rowCount ?? 0;
  console.log(`[status-recompute] tenant=${PHES_COMPANY_ID} rows_updated=${n}`);
}

/**
 * Phes admin-view-consistency sprint (2026-05-15) — Item 4.
 *
 * Hard-deletes the two phantom users Dispatch found in the audit:
 *   - 447: crosstenant@evil.test, company_id=1, active. Origin unknown
 *          (not from Dispatch's fixture work).
 *   - 448: pwn@x.test (renamed by audit cleanup to AUDIT_CLEANUP/
 *          PLEASE_DELETE), is_active=false.
 *
 * Guard: if either user has any active signed_document with a real
 * signature, SKIP that user and log a warning. Legal trail can't be
 * deleted. Dispatch reported neither user advanced past sign-up, so
 * we expect zero blocked rows.
 *
 * Cascade order: children first, then users. Cascading FKs handle
 * most of it, but we delete explicitly so the row counts are auditable.
 */
const PHANTOM_USER_IDS = [447, 448] as const;

async function runPhantomUserCleanup(): Promise<void> {
  const deleted: number[] = [];
  const blocked: number[] = [];
  const notFound: number[] = [];

  for (const id of PHANTOM_USER_IDS) {
    const userRows = await db.execute<{
      id: number;
      email: string;
      company_id: number | null;
    }>(sql`
      SELECT id, email, company_id FROM users WHERE id = ${id}
    `);
    const row = ((userRows as any).rows ?? userRows)[0];
    if (!row) {
      notFound.push(id);
      continue;
    }
    if (row.company_id !== PHES_COMPANY_ID) {
      // Not Phes — out of scope. Don't touch.
      blocked.push(id);
      continue;
    }

    const signedRows = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count FROM lms_signed_documents
      WHERE user_id = ${id} AND status = 'active'
    `);
    const signedCount =
      ((signedRows as any).rows ?? signedRows)[0]?.count ?? 0;
    if (signedCount > 0) {
      console.warn(
        `[phantom-user-cleanup] user_id=${id} skipped — ${signedCount} active signed_document(s); legal trail preserved`,
      );
      blocked.push(id);
      continue;
    }

    // Children first.
    await db.execute(
      sql`DELETE FROM lms_quiz_attempts WHERE enrollment_id IN (SELECT id FROM lms_enrollments WHERE user_id = ${id})`,
    );
    await db.execute(
      sql`DELETE FROM lms_quiz_state WHERE enrollment_id IN (SELECT id FROM lms_enrollments WHERE user_id = ${id})`,
    );
    await db.execute(
      sql`DELETE FROM lms_module_progress WHERE enrollment_id IN (SELECT id FROM lms_enrollments WHERE user_id = ${id})`,
    );
    await db.execute(
      sql`DELETE FROM lms_completion_certificates WHERE user_id = ${id}`,
    );
    await db.execute(
      sql`DELETE FROM lms_pending_re_ack WHERE user_id = ${id}`,
    );
    await db.execute(
      sql`DELETE FROM lms_signature_events WHERE user_id = ${id}`,
    );
    await db.execute(
      sql`DELETE FROM lms_signed_documents WHERE user_id = ${id}`,
    );
    await db.execute(
      sql`DELETE FROM lms_enrollments WHERE user_id = ${id}`,
    );
    // audit_log has admin_user_id + target_user_id (no user_id column). The
    // original WHERE user_id = $id query threw `column "user_id" does not
    // exist`, which the outer try/catch swallowed as non-fatal — meaning the
    // DELETE FROM users below never ran. Phantom users 447/448 survived
    // every boot until this fix landed.
    await db.execute(
      sql`DELETE FROM audit_log WHERE admin_user_id = ${id} OR target_user_id = ${id}`,
    );

    await db.execute(sql`DELETE FROM users WHERE id = ${id}`);
    deleted.push(id);
  }

  console.log(
    `[phantom-user-cleanup] deleted_user_ids=${JSON.stringify(deleted)} ` +
      `blocked=${JSON.stringify(blocked)} not_found=${JSON.stringify(notFound)}`,
  );
}

/**
 * 2026-05-22 (Sal): "we need to enable Francisco and Maribel to also have
 * admin view." Bumps both to role='admin' on Phes (company_id=1). Idempotent:
 * only acts when current role is 'technician' or 'team_lead'; never touches
 * owners or accounts already at admin/office/super_admin. Match is by
 * first+last name (case-insensitive), scoped to Phes, excluding the owner row.
 *
 * The general affordance ("a setting for everyone to enable admin view")
 * already exists in the LMS Admin → Edit Employee dialog (role dropdown
 * includes technician / team_lead / admin / office). This migration is the
 * one-time grant for Francisco and Maribel so they have access immediately
 * after this commit deploys; future promotions go through the dialog.
 */
const PHES_ADMIN_PROMOTIONS_2026_05_22: ReadonlyArray<{ first: string; last: string }> = [
  { first: "Francisco", last: "Estevez" },
  { first: "Maribel", last: "Castillo" },
];

async function runPhesAdminPromotions(): Promise<void> {
  const PHES = 1;
  const promoted: number[] = [];
  const alreadyAdmin: number[] = [];
  const ownerSkipped: number[] = [];
  const otherRoleSkipped: Array<{ id: number; role: string }> = [];
  const notFound: string[] = [];

  for (const entry of PHES_ADMIN_PROMOTIONS_2026_05_22) {
    const label = `${entry.first} ${entry.last}`;
    const rows = await db.execute<{ id: number; role: string }>(sql`
      SELECT id, role FROM users
      WHERE company_id = ${PHES}
        AND LOWER(first_name) = LOWER(${entry.first})
        AND LOWER(last_name) = LOWER(${entry.last})
      ORDER BY id ASC
      LIMIT 1
    `);
    const row = ((rows as any).rows ?? rows)[0] as { id: number; role: string } | undefined;

    if (!row) {
      notFound.push(label);
      continue;
    }

    if (row.role === "owner") {
      ownerSkipped.push(row.id);
      continue;
    }
    if (row.role === "admin") {
      alreadyAdmin.push(row.id);
      continue;
    }
    if (row.role !== "technician" && row.role !== "team_lead") {
      otherRoleSkipped.push({ id: row.id, role: row.role });
      continue;
    }

    await db.execute(sql`
      UPDATE users
      SET role = 'admin'
      WHERE id = ${row.id} AND company_id = ${PHES}
    `);
    promoted.push(row.id);
  }

  console.log(
    `[phes-migration] admin-promotions — promoted=${promoted.length} (${promoted.join(",") || "none"})`
      + ` already-admin=${alreadyAdmin.length}`
      + ` owner-skipped=${ownerSkipped.length}`
      + ` other-role-skipped=${otherRoleSkipped.length}`
      + ` not-found=${notFound.length}${notFound.length ? ` [${notFound.join("; ")}]` : ""}`,
  );
}

// ─── PPM (Daniel Walter Properties) account cleanup ──────────────────────────
// Sal's cleanup pass on the PPM property-management account:
//   1. Rename "Daniel Walter Properties" → "PPM" (Daniel Walter is the on-site
//      manager, not the company name) — recorded as a property_manager contact.
//   2. Backfill the full 47-property roster from MaidCentral. Only MISSING
//      properties are inserted; existing rows are matched on a normalized
//      address key (number + direction + street name, suffix-stripped) so the
//      ~13 already imported under different spellings ("100 W Chestnut" vs
//      "100 W Chestnut St") are NOT duplicated.
//   3. Fix the W Addison zips MaidCentral had as 60657 → 60613 (verified: the
//      632-644 W Addison block is PPM and sits in 60613 / Lakeview).
// Fully idempotent: rename only fires while the old name is present, contact
// insert is guarded by NOT EXISTS, property inserts are dedup-checked, and the
// zip fix is a bounded UPDATE. Safe to re-run on every cold start.
function normalizeAddrKey(addr: string): string {
  const SUFFIX = new Set(["st", "street", "dr", "drive", "ave", "av", "avenue", "pl", "place",
    "pkwy", "parkway", "blvd", "boulevard", "ct", "court", "ln", "lane", "rd", "road",
    "ter", "terrace", "way", "ct.", "pl."]);
  const DIR: Record<string, string> = { n: "north", s: "south", e: "east", w: "west" };
  let s = (addr || "").toLowerCase();
  s = s.replace(/\b(unit|apt|apartment|ste|suite|#)\b.*$/i, "");
  s = s.replace(/[.,]/g, " ");
  return s.split(/\s+/).filter(Boolean)
    .map(w => (SUFFIX.has(w) ? "" : (DIR[w] ?? w)))
    .filter(Boolean)
    .join(" ")
    .trim();
}

async function runPpmAccountCleanup(): Promise<void> {
  // 47-property roster (zips corrected: W Addison → 60613, 55 W Chestnut → 60610).
  const ROSTER: { address: string; city: string; state: string; zip: string }[] = [
    { address: "1 E Schiller St Unit 9D", city: "Chicago", state: "IL", zip: "60610" },
    { address: "100 W Chestnut St", city: "Chicago", state: "IL", zip: "60610" },
    { address: "1000 N La Salle Dr", city: "Chicago", state: "IL", zip: "60610" },
    { address: "1049 W Oakdale Ave", city: "Chicago", state: "IL", zip: "60657" },
    { address: "1111 N Dearborn St", city: "Chicago", state: "IL", zip: "60610" },
    { address: "1120 N La Salle Dr", city: "Chicago", state: "IL", zip: "60610" },
    { address: "1133 N Dearborn St", city: "Chicago", state: "IL", zip: "60610" },
    { address: "1555 N Astor St", city: "Chicago", state: "IL", zip: "60610" },
    { address: "1940 N Lincoln Ave", city: "Chicago", state: "IL", zip: "60614" },
    { address: "20 E Scott St", city: "Chicago", state: "IL", zip: "60610" },
    { address: "2006 N Sedgwick St", city: "Chicago", state: "IL", zip: "60614" },
    { address: "2007 N Sedgwick St", city: "Chicago", state: "IL", zip: "60614" },
    { address: "2630 N Hampden Ct", city: "Chicago", state: "IL", zip: "60614" },
    { address: "2756 N Pine Grove Ave", city: "Chicago", state: "IL", zip: "60614" },
    { address: "2811 N Pine Grove Ave", city: "Chicago", state: "IL", zip: "60657" },
    { address: "350 W Oakdale Ave", city: "Chicago", state: "IL", zip: "60657" },
    { address: "3510 N Pine Grove Ave", city: "Chicago", state: "IL", zip: "60657" },
    { address: "430 W Diversey Pkwy", city: "Chicago", state: "IL", zip: "60614" },
    { address: "440 W Diversey Pkwy", city: "Chicago", state: "IL", zip: "60614" },
    { address: "441 W Barry Ave", city: "Chicago", state: "IL", zip: "60657" },
    { address: "441 W Oakdale Ave", city: "Chicago", state: "IL", zip: "60657" },
    { address: "446 W Diversey Pkwy", city: "Chicago", state: "IL", zip: "60657" },
    { address: "450 W Melrose St", city: "Chicago", state: "IL", zip: "60657" },
    { address: "455 W Wellington Ave", city: "Chicago", state: "IL", zip: "60657" },
    { address: "500 W Belmont Ave", city: "Chicago", state: "IL", zip: "60657" },
    { address: "515 W Briar Pl", city: "Chicago", state: "IL", zip: "60657" },
    { address: "536 W Addison St", city: "Chicago", state: "IL", zip: "60613" },
    { address: "537 W Melrose St", city: "Chicago", state: "IL", zip: "60657" },
    { address: "544 W Melrose St", city: "Chicago", state: "IL", zip: "60657" },
    { address: "55 Terrace Colony", city: "Olympia Fields", state: "IL", zip: "60461" },
    { address: "55 W Chestnut St", city: "Chicago", state: "IL", zip: "60610" },
    { address: "596 W Hawthorne Pl", city: "Chicago", state: "IL", zip: "60657" },
    { address: "632 W Addison St", city: "Chicago", state: "IL", zip: "60613" },
    { address: "634 W Addison St", city: "Chicago", state: "IL", zip: "60613" },
    { address: "634 W Cornelia Ave", city: "Chicago", state: "IL", zip: "60657" },
    { address: "636 W Addison St", city: "Chicago", state: "IL", zip: "60613" },
    { address: "636 W Cornelia Ave", city: "Chicago", state: "IL", zip: "60657" },
    { address: "638 W Addison St", city: "Chicago", state: "IL", zip: "60613" },
    { address: "638 W Cornelia Ave", city: "Chicago", state: "IL", zip: "60657" },
    { address: "640 W Addison St", city: "Chicago", state: "IL", zip: "60613" },
    { address: "640 W Cornelia Ave", city: "Chicago", state: "IL", zip: "60657" },
    { address: "641 W Cornelia Ave", city: "Chicago", state: "IL", zip: "60657" },
    { address: "642 W Addison St", city: "Chicago", state: "IL", zip: "60613" },
    { address: "644 W Addison St", city: "Chicago", state: "IL", zip: "60613" },
    { address: "750 N Rush St", city: "Chicago", state: "IL", zip: "60611" },
  ];

  // 1. Rename the account (idempotent — only fires while the old name exists).
  await db.execute(sql`
    UPDATE accounts SET account_name = 'PPM', updated_at = now()
    WHERE company_id = ${PHES} AND lower(account_name) = 'daniel walter properties'
  `);

  // Resolve the PPM account id (post-rename, or if it was already 'PPM').
  const acctRes = await db.execute(sql`
    SELECT id FROM accounts
    WHERE company_id = ${PHES} AND lower(account_name) = 'ppm'
    ORDER BY id LIMIT 1
  `);
  const acctRow = acctRes.rows[0] as { id: number } | undefined;
  if (!acctRow) {
    console.warn("[ppm-cleanup] No 'PPM' (or 'Daniel Walter Properties') account found — skipping.");
    return;
  }
  const acctId = acctRow.id;

  // 2. Record Daniel Walter as the property manager (guarded — won't duplicate).
  await db.execute(sql`
    INSERT INTO account_contacts (account_id, company_id, name, role, phone, email, is_primary)
    SELECT ${acctId}, ${PHES}, 'Daniel Walter', 'property_manager', '312-907-2512', 'dannyw@ppmapartments.com', false
    WHERE NOT EXISTS (
      SELECT 1 FROM account_contacts WHERE account_id = ${acctId} AND lower(name) = 'daniel walter'
    )
  `);

  // 3. Correct W Addison zips MaidCentral had wrong (or left null).
  await db.execute(sql`
    UPDATE account_properties
    SET zip = '60613', updated_at = now()
    WHERE account_id = ${acctId} AND address ILIKE '%addison%'
      AND (zip IS NULL OR zip = '60657')
  `);

  // 4. Insert only the MISSING properties (dedup on normalized address key).
  const existing = await db.execute(sql`
    SELECT address FROM account_properties WHERE account_id = ${acctId} AND company_id = ${PHES}
  `);
  const existingKeys = new Set(
    (existing.rows as { address: string }[]).map(r => normalizeAddrKey(r.address))
  );

  let inserted = 0;
  for (const p of ROSTER) {
    const key = normalizeAddrKey(p.address);
    if (existingKeys.has(key)) continue;
    await db.execute(sql`
      INSERT INTO account_properties
        (account_id, company_id, property_name, address, city, state, zip, property_type, is_active)
      VALUES
        (${acctId}, ${PHES}, ${p.address}, ${p.address}, ${p.city}, ${p.state}, ${p.zip}, 'apartment_building', true)
    `);
    existingKeys.add(key); // guard against intra-roster dup keys (e.g. 515 Briar)
    inserted++;
  }

  console.log(`[ppm-cleanup] Account ${acctId} → 'PPM'; inserted ${inserted} missing properties (roster ${ROSTER.length}).`);
}

// KMA Property Management — a commercial PM account like PPM, smaller. Created
// fresh in Qleno (the office-role attempt hit 'Forbidden'). Account + its
// properties seeded idempotently. Commercial work is quoted per visit, so no
// fixed property rates here. Dedup on normalized address (so 4846 W North Ave,
// which had two service sets in MaidCentral, lands as one property).
async function runKmaAccountSetup(): Promise<void> {
  const ROSTER: { address: string; city: string; state: string; zip: string }[] = [
    { address: "12013 S Eggleston Ave", city: "Chicago",   state: "IL", zip: "60628" },
    { address: "14050 S Tracy Ave",     city: "Riverdale", state: "IL", zip: "60827" },
    { address: "1641 N Lamon Ave",      city: "Chicago",   state: "IL", zip: "60639" },
    { address: "1930 S Wabash Ave",     city: "Chicago",   state: "IL", zip: "60616" },
    { address: "2503 W 63rd St",        city: "Chicago",   state: "IL", zip: "60629" },
    { address: "3421 N Ashland Ave",    city: "Chicago",   state: "IL", zip: "60657" },
    { address: "4846 W North Ave",      city: "Chicago",   state: "IL", zip: "60639" },
  ];

  // 1. Create the account if it doesn't exist.
  await db.execute(sql`
    INSERT INTO accounts
      (company_id, account_name, account_type, payment_method, invoice_frequency,
       payment_terms_days, auto_charge_on_completion, is_active, notes)
    SELECT ${PHES}, 'KMA Property Management', 'property_management'::account_type,
           'invoice_only'::account_payment_method, 'monthly'::invoice_frequency,
           30, false, true,
           'Commercial property management (common areas + office cleaning). Billing: lflores@kmapm.com'
    WHERE NOT EXISTS (
      SELECT 1 FROM accounts WHERE company_id = ${PHES} AND lower(account_name) = 'kma property management'
    )
  `);

  const acctRes = await db.execute(sql`
    SELECT id FROM accounts WHERE company_id = ${PHES} AND lower(account_name) = 'kma property management' ORDER BY id LIMIT 1
  `);
  const acctRow = acctRes.rows[0] as { id: number } | undefined;
  if (!acctRow) { console.warn("[kma-setup] account not found after insert — skipping"); return; }
  const acctId = acctRow.id;

  // 2. Billing contact (guarded).
  await db.execute(sql`
    INSERT INTO account_contacts (account_id, company_id, name, role, email, receives_invoices, is_primary)
    SELECT ${acctId}, ${PHES}, 'KMA Billing', 'billing'::account_contact_role, 'lflores@kmapm.com', true, true
    WHERE NOT EXISTS (
      SELECT 1 FROM account_contacts WHERE account_id = ${acctId} AND lower(email) = 'lflores@kmapm.com'
    )
  `);

  // 3. Insert missing properties (dedup on normalized address).
  const existing = await db.execute(sql`
    SELECT address FROM account_properties WHERE account_id = ${acctId} AND company_id = ${PHES}
  `);
  const existingKeys = new Set((existing.rows as { address: string }[]).map(r => normalizeAddrKey(r.address)));
  let inserted = 0;
  for (const p of ROSTER) {
    const key = normalizeAddrKey(p.address);
    if (existingKeys.has(key)) continue;
    await db.execute(sql`
      INSERT INTO account_properties
        (account_id, company_id, property_name, address, city, state, zip, property_type, is_active)
      VALUES
        (${acctId}, ${PHES}, ${p.address}, ${p.address}, ${p.city}, ${p.state}, ${p.zip}, 'apartment_building', true)
    `);
    existingKeys.add(key);
    inserted++;
  }
  console.log(`[kma-setup] Account ${acctId} ensured; inserted ${inserted} properties (roster ${ROSTER.length}).`);
}

// One-time June fill: the recurring engine only generates forward from when a
// schedule is saved, so schedules set up on/after Jun 3 left Jun 1-2 empty and
// the dashboard showed $0 for those days. This generates each active schedule's
// visits back to Jun 1, 2026. Idempotent — the engine dedupes on
// (recurring_schedule_id, scheduled_date), so it won't duplicate days that
// already have jobs and is safe to re-run on every cold start.
async function runJuneRecurringFill(): Promise<void> {
  const { generateJobsFromSchedule, DAYS_AHEAD } = await import("./lib/recurring-jobs.js");
  const from = new Date("2026-06-01T00:00:00");
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + DAYS_AHEAD);
  const scheds = await db.execute(sql`
    SELECT * FROM recurring_schedules WHERE company_id = ${PHES} AND is_active = true
  `);
  let created = 0;
  for (const s of scheds.rows as any[]) {
    try {
      const cl = await db.execute(sql`SELECT zip FROM clients WHERE id = ${s.customer_id} LIMIT 1`);
      const zip = (cl.rows[0] as any)?.zip ?? null;
      const gen = await generateJobsFromSchedule(s as any, from, horizon, null, zip);
      created += gen.created;
    } catch (err: any) {
      console.warn("[june-fill] schedule", s.id, "—", err?.message ?? err);
    }
  }
  console.log(`[june-fill] generated ${created} job(s) from Jun 1 across ${scheds.rows.length} schedules.`);
}

export async function runPhesDataMigration(): Promise<void> {
  await runBookingSchemaGuard();

  try {
    await runPhesPasswordResetChicago23();
  } catch (err: any) {
    console.warn("[phes-migration] chicago23-password-reset — non-fatal:", err?.message ?? err);
  }

  try {
    await runPhantomLearnerArchive();
  } catch (err: any) {
    console.warn("[phes-migration] phantom-learner-archive — non-fatal:", err?.message ?? err);
  }

  try {
    await runRestoreActiveLearners();
  } catch (err: any) {
    console.warn("[phes-migration] restore-active-learners — non-fatal:", err?.message ?? err);
  }

  try {
    await runSandboxAccountRepurpose();
  } catch (err: any) {
    console.warn("[phes-migration] sandbox-repurpose — non-fatal:", err?.message ?? err);
  }

  try {
    await runSupersessionBackfill();
  } catch (err: any) {
    console.warn("[phes-migration] supersession-backfill — non-fatal:", err?.message ?? err);
  }

  try {
    await runModuleProgressAttemptsResync();
  } catch (err: any) {
    console.warn("[phes-migration] module-progress-attempts-resync — non-fatal:", err?.message ?? err);
  }

  try {
    await runStatusRecompute();
  } catch (err: any) {
    console.warn("[phes-migration] status-recompute — non-fatal:", err?.message ?? err);
  }

  try {
    await runPhantomUserCleanup();
  } catch (err: any) {
    console.warn("[phes-migration] phantom-user-cleanup — non-fatal:", err?.message ?? err);
  }

  try {
    await runPhesAdminPromotions();
  } catch (err: any) {
    console.warn("[phes-migration] admin-promotions — non-fatal:", err?.message ?? err);
  }

  try {
    await runPayMatrixBackfill();
  } catch (err: any) {
    console.warn("[phes-migration] pay-matrix-backfill — non-fatal:", err?.message ?? err);
  }

  try {
    await runDaysOfWeekBackfill();
  } catch (err: any) {
    console.warn("[phes-migration] days-of-week-backfill — non-fatal:", err?.message ?? err);
  }

  try {
    await runJobsDedupeAndConstraint();
  } catch (err: any) {
    console.warn("[phes-migration] jobs-dedupe — non-fatal:", err?.message ?? err);
  }

  try {
    await runScheduleHorizonBackfill();
  } catch (err: any) {
    console.warn("[phes-migration] schedule-horizon-backfill — non-fatal:", err?.message ?? err);
  }

  try {
    await runAcquisitionSourcesSeed();
  } catch (err: any) {
    console.warn("[phes-migration] acquisition-sources-seed — non-fatal:", err?.message ?? err);
  }

  try {
    await runServiceTypesSeed();
  } catch (err: any) {
    console.warn("[phes-migration] service-types-seed — non-fatal:", err?.message ?? err);
  }

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

  try {
    await runPpmAccountCleanup();
  } catch (err: any) {
    console.warn("[phes-migration] ppm-account-cleanup — non-fatal:", err?.message ?? err);
  }

  try {
    await runKmaAccountSetup();
  } catch (err: any) {
    console.warn("[phes-migration] kma-account-setup — non-fatal:", err?.message ?? err);
  }

  try {
    await runJuneRecurringFill();
  } catch (err: any) {
    console.warn("[phes-migration] june-recurring-fill — non-fatal:", err?.message ?? err);
  }

  try {
    await runScopeVisibility();
  } catch (err: any) {
    console.warn("[phes-migration] scope-visibility — non-fatal:", err?.message ?? err);
  }

  try {
    await runZoneSync();
  } catch (err: any) {
    console.warn("[phes-migration] zone-sync — non-fatal:", err?.message ?? err);
  }

  // [AI.3] Seed PHES commercial service types. Idempotent —
  // ON CONFLICT (company_id, slug) DO NOTHING preserves any rate Sal has
  // already set via the UI. default_hourly_rate stays NULL on first seed;
  // Sal sets per-type rates in /settings/pricing.
  try {
    // [AI.4] Commercial Cleaning + Recurring Commercial Cleaning surface
    // first by sort_order so they're the easiest picks for the most common
    // PHES commercial use cases. Both default_hourly_rate=NULL → per-client
    // rate flow handles billing.
    const seedTypes: Array<{ name: string; slug: string; sort: number }> = [
      { name: "Commercial Cleaning",            slug: "commercial_cleaning",            sort: 5  },
      { name: "Recurring Commercial Cleaning",  slug: "recurring_commercial_cleaning",  sort: 7  },
      { name: "Office Cleaning",                slug: "office_cleaning",                sort: 10 },
      { name: "Common Areas",                   slug: "common_areas",                   sort: 20 },
      { name: "PPM Common Areas",               slug: "ppm_common_areas",               sort: 30 },
      { name: "Retail Store",                   slug: "retail_store",                   sort: 40 },
      { name: "Medical Office",                 slug: "medical_office",                 sort: 50 },
      { name: "PPM Turnover",                   slug: "ppm_turnover",                   sort: 60 },
      { name: "Post Event",                     slug: "post_event",                     sort: 70 },
    ];
    for (const t of seedTypes) {
      await db.execute(sql`
        INSERT INTO commercial_service_types
          (company_id, name, slug, sort_order)
        VALUES (${PHES}, ${t.name}, ${t.slug}, ${t.sort})
        ON CONFLICT (company_id, slug) DO NOTHING
      `);
    }
  } catch (err: any) {
    console.warn("[phes-migration] commercial-service-types seed — non-fatal:", err?.message ?? err);
  }

  // [AI.2] Jaira Estrada (id=21) was imported from MaidCentral with
  // client_type='residential' AND account_id=NULL despite being a commercial
  // National Able Network contact. Both signals fail, so AI.1's broadened
  // isCommercial check (client_type='commercial' OR account_id != null)
  // can't fire and the modal renders residential UI for her job.
  // Idempotent: only fires when the row is still residential. See
  // KNOWN_BUGS.md "MC import misflagged commercial clients as residential"
  // for the full audit recommendation.
  try {
    const r = await db.execute(sql`
      UPDATE clients
      SET client_type = 'commercial'
      WHERE id = 21 AND company_id = ${PHES} AND client_type = 'residential'
      RETURNING id
    `);
    if ((r.rows ?? []).length > 0) {
      console.log("[phes-migration] Flipped Jaira Estrada (id=21) client_type → commercial");
    }
  } catch (err: any) {
    console.warn("[phes-migration] jaira-client_type-fix — non-fatal:", err?.message ?? err);
  }

  // [AI.7.7] Multi-source clients.* backfill. Replaces the AI.7.6
  // narrow zip-only regex pass. Reality check on the schema: there
  // are NO address columns on recurring_schedules — the per-occurrence
  // job-level override (jobs.address_street/city/state/zip) is the
  // actual carrier the MC import populated. So for clients whose
  // clients.zip / city / state are null, the backfill walks:
  //
  //   1. Most recent jobs.address_zip / city / state / street for
  //      this client (preferred — that's what the import wrote)
  //   2. Parsed extraction from clients.address itself when the
  //      job-level path didn't yield a zip
  //
  // Idempotent: only fires when clients.zip IS NULL on entry. Logs
  // pre/post counts + source breakdown + remaining-NULL list so the
  // ship report has structured data without DB shell access.
  try {
    const preCountRow = await db.execute(sql`
      SELECT count(*)::int AS n
      FROM clients
      WHERE company_id = ${PHES} AND zip IS NULL
    `);
    const preCount = Number((preCountRow.rows[0] as any)?.n ?? 0);

    // Pull every client with NULL zip plus their most recent job's
    // address_* fields in one pass. LATERAL JOIN gets the latest job
    // per client (by scheduled_date desc, id desc).
    const candidates = await db.execute(sql`
      SELECT
        c.id, c.address AS client_address, c.city AS client_city,
        c.state AS client_state, c.zip AS client_zip,
        j.address_street, j.address_city, j.address_state, j.address_zip
      FROM clients c
      LEFT JOIN LATERAL (
        SELECT address_street, address_city, address_state, address_zip
        FROM jobs
        WHERE jobs.client_id = c.id
          AND jobs.company_id = c.company_id
          AND (jobs.address_zip IS NOT NULL OR jobs.address_street IS NOT NULL)
        ORDER BY jobs.scheduled_date DESC NULLS LAST, jobs.id DESC
        LIMIT 1
      ) j ON true
      WHERE c.company_id = ${PHES}
        AND c.zip IS NULL
    `);

    let fromJobZip = 0;
    let fromJobStreet = 0;
    let fromClientAddress = 0;
    let stillNull = 0;
    const stillNullIds: number[] = [];

    const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/;

    for (const row of candidates.rows as any[]) {
      const id = Number(row.id);
      const jobZip = row.address_zip ? String(row.address_zip).trim() : null;
      const jobStreet = row.address_street ? String(row.address_street).trim() : null;
      const jobCity = row.address_city ? String(row.address_city).trim() : null;
      const jobState = row.address_state ? String(row.address_state).trim() : null;
      const clientAddr = row.client_address ? String(row.client_address).trim() : null;

      let zip: string | null = null;
      let street: string | null = null;
      let city: string | null = null;
      let state: string | null = null;
      let source: "job_zip" | "job_street" | "client_address" | null = null;

      // Source 1: explicit job-level zip column
      if (jobZip) {
        const m = jobZip.match(ZIP_RE);
        if (m) {
          zip = m[1];
          street = jobStreet || null;
          city = jobCity || null;
          state = jobState || "IL";
          source = "job_zip";
        }
      }
      // Source 2: parse zip out of job's address_street text
      if (!zip && jobStreet) {
        const m = jobStreet.match(ZIP_RE);
        if (m) {
          zip = m[1];
          // Strip the zip block from the street text (best-effort)
          street = jobStreet.replace(/,?\s*\b\d{5}(?:-\d{4})?\b\s*$/, "").trim() || null;
          city = jobCity || null;
          state = jobState || "IL";
          source = "job_street";
        }
      }
      // Source 3: parse zip out of clients.address itself
      if (!zip && clientAddr) {
        const m = clientAddr.match(ZIP_RE);
        if (m) {
          zip = m[1];
          // Best-effort split: "123 Main St, Chicago, IL 60608" -> {street, city, state, zip}
          // Strip trailing ", IL 60608" or " IL 60608" first.
          const noZip = clientAddr.replace(/,?\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\s*$/, "").trim();
          // Now split on commas; last segment is city, rest is street.
          const parts = noZip.split(",").map(p => p.trim()).filter(Boolean);
          if (parts.length >= 2) {
            city = parts[parts.length - 1];
            street = parts.slice(0, -1).join(", ");
          } else {
            street = noZip || null;
          }
          state = "IL"; // Phes default per spec
          source = "client_address";
        }
      }

      if (!zip) {
        stillNull++;
        if (stillNullIds.length < 10) stillNullIds.push(id);
        continue;
      }

      try {
        await db.execute(sql`
          UPDATE clients
          SET
            zip   = ${zip},
            city  = COALESCE(NULLIF(city,  ''), ${city}),
            state = COALESCE(NULLIF(state, ''), ${state}),
            address = COALESCE(NULLIF(address, ''), ${street})
          WHERE id = ${id} AND company_id = ${PHES} AND zip IS NULL
        `);
      } catch (err: any) {
        console.warn(`[AI.7.7] backfill update failed for client ${id}:`, err?.message ?? err);
        continue;
      }

      if (source === "job_zip") fromJobZip++;
      else if (source === "job_street") fromJobStreet++;
      else if (source === "client_address") fromClientAddress++;
    }

    const postCountRow = await db.execute(sql`
      SELECT count(*)::int AS n
      FROM clients
      WHERE company_id = ${PHES} AND zip IS NULL
    `);
    const postCount = Number((postCountRow.rows[0] as any)?.n ?? 0);

    console.log(
      `[AI.7.7] clients.zip backfill: pre=${preCount} post=${postCount} ` +
      `sources={job_zip:${fromJobZip}, job_street:${fromJobStreet}, client_address:${fromClientAddress}} ` +
      `remaining=${stillNull}` +
      (stillNullIds.length > 0 ? ` first10_ids=[${stillNullIds.join(",")}]` : "")
    );
  } catch (err: any) {
    console.warn("[AI.7.7] clients backfill — non-fatal:", err?.message ?? err);
  }

  // [AI.7.6] Same backfill for account_properties.zip — commercial
  // properties imported from MC may have address but not zip.
  try {
    const r = await db.execute(sql`
      UPDATE account_properties
      SET zip = SUBSTRING(address FROM '\\y(\\d{5})\\y')
      WHERE zip IS NULL
        AND address IS NOT NULL
        AND SUBSTRING(address FROM '\\y(\\d{5})\\y') IS NOT NULL
      RETURNING id
    `);
    const n = (r.rows ?? []).length;
    if (n > 0) console.log(`[phes-migration] Backfilled account_properties.zip on ${n} rows`);
  } catch (err: any) {
    console.warn("[phes-migration] property-zip-backfill — non-fatal:", err?.message ?? err);
  }

  // [AI.10] Server-side zip auto-resolver. AI.7.7 handles the easy
  // case (regex-extract a 5-digit zip from address text). AI.10 picks
  // up everything AI.7.7 couldn't fix — clients whose address text
  // has no embedded zip — and resolves via Google Maps Geocoding.
  //
  // Replaces the retired AI.8 admin Zone Coverage page. No user
  // surface, no manual buttons. Runs on every cold start; idempotent
  // via `WHERE zip IS NULL` guard so subsequent boots are no-ops once
  // the row is filled.
  //
  // Cost ceiling: 1000 calls × $0.005 = $5 max per run, and Google's
  // first 10k/month is free. The hard cap is a runaway-bill guard —
  // a single boot can't burn through more than $5 even if every row
  // misses. Throttle 100ms between calls keeps us well under the
  // 50 req/sec free-tier ceiling.
  //
  // Skipped categories (logged separately so the residual gap is
  // visible without a UI):
  //   - no_address_string  → no clients.address AND no recent job
  //                          address text → can't geocode; needs
  //                          manual entry via existing client edit
  //                          modal
  //   - geocode_failed     → Google returned no result or no
  //                          postal_code component
  //   - api_key_missing    → GOOGLE_MAPS_API_KEY env var unset; skip
  //                          the whole pass with a warning
  try {
    if (!process.env.GOOGLE_MAPS_API_KEY) {
      console.warn("[AI.10] zip backfill skipped — GOOGLE_MAPS_API_KEY not set");
    } else {
      const HARD_CAP = 1000;
      const THROTTLE_MS = 100;

      const preCountRow = await db.execute(sql`
        SELECT count(*)::int AS n
        FROM clients
        WHERE company_id = ${PHES} AND zip IS NULL
      `);
      const preCount = Number((preCountRow.rows[0] as any)?.n ?? 0);

      if (preCount === 0) {
        console.log("[AI.10] zip backfill: pre=0 (nothing to do)");
      } else {
        // Pull NULL-zip clients with their best candidate address text.
        const candidates = await db.execute(sql`
          SELECT
            c.id,
            c.address AS clients_address,
            c.city    AS clients_city,
            c.state   AS clients_state,
            (SELECT j.address_street FROM jobs j
               WHERE j.client_id = c.id AND j.address_street IS NOT NULL
               ORDER BY j.scheduled_date DESC NULLS LAST, j.id DESC LIMIT 1) AS recent_job_street,
            (SELECT j.address_city FROM jobs j
               WHERE j.client_id = c.id AND j.address_street IS NOT NULL
               ORDER BY j.scheduled_date DESC NULLS LAST, j.id DESC LIMIT 1) AS recent_job_city,
            (SELECT j.address_state FROM jobs j
               WHERE j.client_id = c.id AND j.address_street IS NOT NULL
               ORDER BY j.scheduled_date DESC NULLS LAST, j.id DESC LIMIT 1) AS recent_job_state
          FROM clients c
          WHERE c.company_id = ${PHES}
            AND c.zip IS NULL
          ORDER BY c.id
          LIMIT ${HARD_CAP}
        `);

        const ZIP_TAIL_RE = /\b(\d{5})(?:-\d{4})?\s*$/;
        let geocoded = 0;
        let regexHit = 0;
        let skippedNoAddress = 0;
        let skippedFailed = 0;
        let firstCall = true;

        for (const row of candidates.rows as any[]) {
          const id = Number(row.id);
          const street = (row.clients_address ?? row.recent_job_street ?? "")?.trim() || null;
          const city   = (row.clients_city    ?? row.recent_job_city   ?? "")?.trim() || null;
          const state  = (row.clients_state   ?? row.recent_job_state  ?? "")?.trim() || null;

          if (!street && !city) {
            skippedNoAddress++;
            continue;
          }

          // Step 1: cheap path — if the assembled string already ends
          // with a 5-digit zip, extract it and skip the API call.
          const candidateString = [street, city, state].filter(Boolean).join(", ");
          const tailMatch = candidateString.match(ZIP_TAIL_RE);
          if (tailMatch) {
            const zip = tailMatch[1];
            try {
              await db.execute(sql`
                UPDATE clients
                SET zip   = ${zip},
                    city  = COALESCE(NULLIF(city,  ''), ${city}),
                    state = COALESCE(NULLIF(state, ''), ${state ?? "IL"})
                WHERE id = ${id} AND company_id = ${PHES} AND zip IS NULL
              `);
              regexHit++;
            } catch (err: any) {
              console.warn(`[AI.10] update failed for client ${id} (regex path):`, err?.message ?? err);
            }
            continue;
          }

          // Step 2: Google Maps fallback. Throttle between calls.
          if (!firstCall) await new Promise(r => setTimeout(r, THROTTLE_MS));
          firstCall = false;
          const geo = await geocodeWithComponents(candidateString);
          if (!geo || !geo.zip) {
            skippedFailed++;
            continue;
          }
          try {
            await db.execute(sql`
              UPDATE clients
              SET zip   = ${geo.zip},
                  lat   = COALESCE(lat, ${geo.lat}),
                  lng   = COALESCE(lng, ${geo.lng}),
                  city  = COALESCE(NULLIF(city,  ''), ${geo.city  ?? city}),
                  state = COALESCE(NULLIF(state, ''), ${geo.state ?? state ?? "IL"}),
                  address = COALESCE(NULLIF(address, ''), ${geo.street ?? geo.formatted_address ?? street})
              WHERE id = ${id} AND company_id = ${PHES} AND zip IS NULL
            `);
            geocoded++;
          } catch (err: any) {
            console.warn(`[AI.10] update failed for client ${id} (geocode path):`, err?.message ?? err);
            skippedFailed++;
          }
        }

        const postCountRow = await db.execute(sql`
          SELECT count(*)::int AS n
          FROM clients
          WHERE company_id = ${PHES} AND zip IS NULL
        `);
        const postCount = Number((postCountRow.rows[0] as any)?.n ?? 0);

        console.log(
          `[AI.10] zip backfill: pre=${preCount} post=${postCount} ` +
          `geocoded=${geocoded} regex_hit=${regexHit} ` +
          `skipped=${skippedNoAddress + skippedFailed} ` +
          `(no_address=${skippedNoAddress}, failed=${skippedFailed})`
        );
      }
    }
  } catch (err: any) {
    console.warn("[AI.10] zip backfill — non-fatal:", err?.message ?? err);
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

    // ── 3b. Backfill addresses for location-named commercial clients ─────────
    // These KMA location clients were imported with empty addresses, so their
    // dispatch tiles had NO zone color (the zone derives from the client's
    // zip). Sal: "Ashland has no zone color — this cannot happen." Set the
    // real address + zip so the zone resolves live on the board. Idempotent:
    // only fills when the zip is still blank.
    const clientAddrs: Array<[string, string, string, string, string]> = [
      ["KMA Ashland",              "3421 N Ashland Ave",   "Chicago",   "IL", "60657"],
      ["KMA Eggleston",            "12013 S Eggleston Ave", "Chicago",  "IL", "60628"],
      ["KMA Lamon",                "1641 N Lamon Ave",     "Chicago",   "IL", "60639"],
      ["KMA North Ave",            "4846 W North Ave",     "Chicago",   "IL", "60639"],
      ["KMA 4846 W North Offices", "4846 W North Ave",     "Chicago",   "IL", "60639"],
      ["KMA Tracy",                "14050 S Tracy Ave",    "Riverdale", "IL", "60827"],
      ["KMA 63rd",                 "2503 W 63rd St",       "Chicago",   "IL", "60629"],
    ];
    for (const [name, street, city, state, zip] of clientAddrs) {
      await db.execute(sql`
        UPDATE clients
           SET address = ${street}, city = ${city}, state = ${state}, zip = ${zip}
         WHERE company_id = ${PHES}
           AND LOWER(TRIM(first_name)) = LOWER(${name})
           AND (zip IS NULL OR zip = '')
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
      // Commercial scopes for plain commercial CLIENTS (not the PPM account).
      // scope_group = "Commercial" so the customer-profile recurring editor
      // surfaces them for commercial clients (e.g. the church) and hides them
      // from residential. Rates are DEFAULTS only — commercial is quoted per
      // visit (allowed hours × hourly rate), and the rate varies by account,
      // so the operator overrides on the job. min = 0 (no minimum bill).
      { name: "Common Areas",                        method: "hourly", rate: "45.00", min: "0.00", scopeGroup: "Commercial" },
      { name: "Turnover",                            method: "hourly", rate: "50.00", min: "0.00", scopeGroup: "Commercial" },
      { name: "Office Cleaning",                     method: "hourly", rate: "50.00", min: "0.00", scopeGroup: "Commercial" },
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
    // These were seeded before scope_group existed, so they defaulted to
    // 'Residential' — which both hid them from commercial clients AND showed
    // commercial work to residential ones. Reclassify to 'Commercial'.
    await db.execute(sql`
      UPDATE pricing_scopes
      SET scope_group = 'Commercial'
      WHERE company_id = ${PHES}
        AND name IN ('Commercial Cleaning', 'PPM Turnover')
        AND scope_group <> 'Commercial'
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
          // [baseboards-mc-parity 2026-05-26] Baseboards is now an office-only
          // add-on available on every scope ($30 flat / 45 min). MC's
          // production data has it on Deep Clean + Move In/Out + One-Time
          // Standard; Sal confirmed it should appear on ALL scopes including
          // Hourly + Commercial + PPM Turnover, and stay hidden from the
          // online widget + customer portal (office can still add it on a
          // quote or job).
          name: "Baseboards",
          addon_type: "cleaning_extras",
          scope_ids: [D, MIO, S, R, HD, HS, C, P].filter(Boolean),
          price_type: "flat", price_value: 30,
          time_minutes: 45, time_unit: "each",
          is_itemized: true, show_office: true, show_online: false, show_portal: false, sort_order: 40,
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
          // [windows-mc-parity 2026-05-26] Windows now uses 15% across every
          // flat-rate scope (was 12% on Standard/Recurring while Deep Clean
          // was already 15%). MC's source-of-truth screen showed both 12 and
          // 15 in different views; Sal called 15 as the canonical rate.
          name: "Windows (inside panes) — Standard / Recurring",
          addon_type: "cleaning_extras",
          scope_ids: [S, R].filter(Boolean),
          price_type: "percentage", price_value: 15,
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

  // [baseboards-windows-mc-parity 2026-05-26] Idempotent fix for
  // already-seeded Phes data (the addon block above is one-shot — it
  // only fires when pricing_addons is empty, so existing tenants need
  // an explicit UPDATE pass).
  await runBaseboardsWindowsParityMigration();

  // [top10-addons 2026-05-27] Seed the top-10 tenant-add-on catalog +
  // the Oven+Refrigerator bundle for Phes. Idempotent — checks by name
  // before insert, safe to re-run.
  await runTop10AddonsAndBundleMigration();

  // [hourly-addon-cleanup 2026-05-27] After the audit, Hourly scopes
  // should expose exactly 6 add-ons (Oven/Refrigerator/Cabinets/
  // Windows/Basement/Parking) with ZERO time impact (clients are
  // already billed by clock-time). Removes Baseboards + the +15%
  // markup from Hourly, renames the "Time Add" suffix, zeros time.
  await runHourlyAddonCleanupMigration();

  // Run employee-specific migrations
  await runAleCuervoMigration();

  // Run client job history migrations
  await runDamianJobHistoryMigration();

  // Seed notification templates
  await runNotificationTemplateSeed();

  // Seed MC discounts + remove placeholder discount add-ons
  await runDiscountMigration();
}

// ── MaidCentral Discount Migration (2026-04-16) ─────────────────────────────
// [baseboards-windows-mc-parity 2026-05-26] Bring already-seeded Phes
// pricing_addons in line with the corrected seed values above.
//   1. Baseboards becomes office-only ($30 / 45 min) on ALL active scopes.
//   2. Windows (inside panes) — Standard / Recurring goes 12% → 15%.
// Idempotent — UPDATEs converge to the same row regardless of starting
// state, so safe to re-run on every cold start.
// [top10-addons 2026-05-27] Seed 10 common tenant-add-on options as
// INACTIVE for Phes so the office can flip them on per-job from the
// Pricing & Scopes settings page. Also seeds the Oven+Refrigerator
// combo bundle as ACTIVE (per Sal — most-requested combo).
//
// Idempotent: checks pricing_addons.name uniqueness per company before
// inserting. Existing rows are not touched (no UPDATE pass — operators
// may have already customized the price/time after first seed).
// [hourly-addon-cleanup 2026-05-27] Bring Hourly scopes (Hourly Deep
// Clean + Hourly Standard Cleaning) in line with Sal's post-audit
// spec: exactly 6 add-ons (Oven, Refrigerator, Kitchen Cabinets,
// Windows, Basement, Parking Fee) with ZERO time impact — clients are
// already paying for clock-time, so a time-add would double-count.
// Also strips Baseboards (added in MC parity PR) and the +15% Second
// Appointment markup which don't belong on the Hourly add-on list.
// Idempotent — UPDATEs converge to the same end-state regardless of
// starting state.
async function runHourlyAddonCleanupMigration() {
  try {
    const scopeResult = await db.execute(sql`
      SELECT id, name FROM pricing_scopes WHERE company_id = ${PHES} AND is_active = true
    `);
    const scopeMap: Record<string, number> = {};
    for (const row of (scopeResult as any).rows ?? []) {
      scopeMap[row.name] = parseInt(row.id);
    }
    const HD = scopeMap["Hourly Deep Clean"];
    const HS = scopeMap["Hourly Standard Cleaning"];
    if (!HD && !HS) {
      console.log("[hourly-addon-cleanup] No active hourly scopes — skipping.");
      return;
    }

    // 1) Zero out time_add_minutes on every Hourly variant, drop the
    //    "— Time Add" suffix from the name, mirror price = 0 / time = 0.
    //    Match on the "(Hourly" substring to catch both naming styles.
    await db.execute(sql`
      UPDATE pricing_addons
      SET time_add_minutes = 0,
          price_value = 0,
          price_type = 'time_only',
          name = regexp_replace(name, '\\s*[—-]\\s*Time Add', '', 'gi')
      WHERE company_id = ${PHES}
        AND (name ILIKE '%(Hourly%' OR name ILIKE '%Hourly — Time Add%')
    `);

    // 2) Strip Baseboards from Hourly scope_ids. The MC parity migration
    //    put Baseboards on all 8 scopes; Hourly drops it per audit.
    const flatScopes = [
      scopeMap["Deep Clean"],
      scopeMap["Move In / Move Out"],
      scopeMap["One-Time Standard Clean"],
      scopeMap["Recurring Cleaning"],
      scopeMap["Commercial Cleaning"],
      scopeMap["PPM Turnover"],
    ].filter(Boolean);
    if (flatScopes.length > 0) {
      const flatScopesJson = JSON.stringify(flatScopes);
      const flatFirst = flatScopes[0];
      await db.execute(sql`
        UPDATE pricing_addons
        SET scope_ids = ${flatScopesJson},
            scope_id = ${flatFirst}
        WHERE company_id = ${PHES}
          AND name = 'Baseboards'
      `);
    }

    // 3) Deactivate the "+15% markup" Second Appointment row on HS.
    //    The discount version (-15%) stays — only the markup is wrong
    //    for the new Hourly add-on layout.
    await db.execute(sql`
      UPDATE pricing_addons
      SET is_active = false
      WHERE company_id = ${PHES}
        AND name = 'Second Appointment — +15% (markup)'
    `);

    console.log("[hourly-addon-cleanup] Hourly add-on list aligned (6 items, zero-time).");
  } catch (err) {
    console.error("[hourly-addon-cleanup] Migration error (non-fatal):", err);
  }
}

async function runTop10AddonsAndBundleMigration() {
  try {
    const scopeResult = await db.execute(sql`
      SELECT id, name FROM pricing_scopes WHERE company_id = ${PHES} AND is_active = true
    `);
    const scopeMap: Record<string, number> = {};
    for (const row of (scopeResult as any).rows ?? []) {
      scopeMap[row.name] = parseInt(row.id);
    }
    const D = scopeMap["Deep Clean"];
    const MIO = scopeMap["Move In / Move Out"];
    const S = scopeMap["One-Time Standard Clean"];
    const R = scopeMap["Recurring Cleaning"];
    const HD = scopeMap["Hourly Deep Clean"];
    const HS = scopeMap["Hourly Standard Cleaning"];

    const flatScopes = [D, MIO, S, R].filter(Boolean);
    const hourlyScopes = [HD, HS].filter(Boolean);

    if (flatScopes.length === 0) {
      console.log("[top10-addons] No active residential scopes — skipping.");
      return;
    }

    // Top-10 catalog. Sort orders 200+ to keep them after existing
    // add-ons. show_office=true so they appear in Pricing & Scopes
    // settings; is_active=false so they DON'T appear on quote screens
    // until Sal flips them on per add-on.
    const top10: Array<{
      name: string;
      price_type: string; price_value: number;
      time_minutes: number;
      sort_order: number;
    }> = [
      { name: "Laundry (wash + dry + fold)", price_type: "flat", price_value: 30, time_minutes: 60, sort_order: 200 },
      { name: "Make Beds",                   price_type: "flat", price_value: 10, time_minutes: 10, sort_order: 210 },
      { name: "Inside Window Tracks",        price_type: "flat", price_value: 20, time_minutes: 30, sort_order: 220 },
      { name: "Pet Hair / Pet Cleanup",      price_type: "flat", price_value: 25, time_minutes: 30, sort_order: 230 },
      { name: "Wash Dishes",                 price_type: "flat", price_value: 20, time_minutes: 30, sort_order: 240 },
      { name: "Patio / Balcony Sweep",       price_type: "flat", price_value: 25, time_minutes: 30, sort_order: 250 },
      { name: "Inside Microwave",            price_type: "flat", price_value: 15, time_minutes: 15, sort_order: 260 },
      { name: "Ceiling Fan Dusting",         price_type: "flat", price_value:  5, time_minutes: 15, sort_order: 270 },
      { name: "Blinds Detail Clean",         price_type: "flat", price_value:  5, time_minutes:  5, sort_order: 280 },
      { name: "Garage Sweep",                price_type: "flat", price_value: 40, time_minutes: 60, sort_order: 290 },
    ];

    for (const a of top10) {
      // Idempotency: skip if a row with this name already exists for Phes.
      const existing = await db.execute(sql`
        SELECT id FROM pricing_addons
         WHERE company_id = ${PHES} AND lower(name) = lower(${a.name}) LIMIT 1
      `);
      if (((existing as any).rows ?? []).length > 0) continue;

      const scopeIdsJson = JSON.stringify(flatScopes);
      const firstScopeId = flatScopes[0];
      await db.execute(sql`
        INSERT INTO pricing_addons
          (company_id, scope_id, name, addon_type, scope_ids,
           price_type, price_value, time_add_minutes, time_unit,
           is_itemized, show_office, show_online, show_portal,
           is_active, sort_order)
        VALUES
          (${PHES}, ${firstScopeId}, ${a.name}, 'cleaning_extras', ${scopeIdsJson},
           ${a.price_type}, ${a.price_value}, ${a.time_minutes}, 'each',
           true, true, false, false,
           false, ${a.sort_order})
      `);

      // Hourly variants — $0 time-only mirror, also inactive by default.
      if (hourlyScopes.length > 0) {
        const hourlyName = `${a.name} (Hourly — Time Add)`;
        const hourlyExists = await db.execute(sql`
          SELECT id FROM pricing_addons
           WHERE company_id = ${PHES} AND lower(name) = lower(${hourlyName}) LIMIT 1
        `);
        if (((hourlyExists as any).rows ?? []).length === 0) {
          const hourlyScopeJson = JSON.stringify(hourlyScopes);
          await db.execute(sql`
            INSERT INTO pricing_addons
              (company_id, scope_id, name, addon_type, scope_ids,
               price_type, price_value, time_add_minutes, time_unit,
               is_itemized, show_office, show_online, show_portal,
               is_active, sort_order)
            VALUES
              (${PHES}, ${hourlyScopes[0]}, ${hourlyName}, 'cleaning_extras', ${hourlyScopeJson},
               'time_only', 0, ${a.time_minutes}, 'each',
               false, true, false, false,
               false, ${a.sort_order + 1})
          `);
        }
      }
    }
    console.log("[top10-addons] Catalog seeded (inactive).");

    // ── Oven + Refrigerator combo bundle (ACTIVE) ─────────────────────
    // Pulls the canonical Oven Cleaning + Refrigerator Cleaning add-ons
    // by name. $15 off when both are on the quote. Bundle stays disabled
    // automatically if either constituent add-on is inactive.
    const bundleName = "Oven + Refrigerator Combo";
    const bundleExists = await db.execute(sql`
      SELECT id FROM addon_bundles
       WHERE company_id = ${PHES} AND lower(name) = lower(${bundleName}) LIMIT 1
    `);
    if (((bundleExists as any).rows ?? []).length > 0) {
      console.log("[top10-addons] Bundle already present — skipping.");
      return;
    }

    const ovenRow = await db.execute(sql`
      SELECT id FROM pricing_addons
       WHERE company_id = ${PHES} AND name = 'Oven Cleaning' LIMIT 1
    `);
    const fridgeRow = await db.execute(sql`
      SELECT id FROM pricing_addons
       WHERE company_id = ${PHES} AND name = 'Refrigerator Cleaning' LIMIT 1
    `);
    const ovenId = ((ovenRow as any).rows ?? [])[0]?.id;
    const fridgeId = ((fridgeRow as any).rows ?? [])[0]?.id;
    if (!ovenId || !fridgeId) {
      console.warn("[top10-addons] Oven or Refrigerator add-on missing — bundle skipped.");
      return;
    }

    const bundleInsert = await db.execute(sql`
      INSERT INTO addon_bundles (company_id, name, description, discount_type, discount_value, active)
      VALUES (${PHES}, ${bundleName}, 'Save $15 when both Oven and Refrigerator cleaning are added.',
              'flat_total', 15, true)
      RETURNING id
    `);
    const bundleId = ((bundleInsert as any).rows ?? [])[0]?.id;
    if (!bundleId) {
      console.warn("[top10-addons] Bundle insert returned no id — items not linked.");
      return;
    }
    await db.execute(sql`
      INSERT INTO addon_bundle_items (bundle_id, addon_id) VALUES (${bundleId}, ${ovenId})
    `);
    await db.execute(sql`
      INSERT INTO addon_bundle_items (bundle_id, addon_id) VALUES (${bundleId}, ${fridgeId})
    `);
    console.log("[top10-addons] Oven + Refrigerator Combo bundle seeded (active).");
  } catch (err) {
    console.error("[top10-addons] Migration error (non-fatal):", err);
  }
}

async function runBaseboardsWindowsParityMigration() {
  try {
    const scopeResult = await db.execute(sql`
      SELECT id, name FROM pricing_scopes WHERE company_id = ${PHES} AND is_active = true
    `);
    const scopeMap: Record<string, number> = {};
    for (const row of (scopeResult as any).rows ?? []) {
      scopeMap[row.name] = parseInt(row.id);
    }
    const allScopeIds = [
      scopeMap["Deep Clean"],
      scopeMap["Move In / Move Out"],
      scopeMap["One-Time Standard Clean"],
      scopeMap["Recurring Cleaning"],
      scopeMap["Hourly Deep Clean"],
      scopeMap["Hourly Standard Cleaning"],
      scopeMap["Commercial Cleaning"],
      scopeMap["PPM Turnover"],
    ].filter(Boolean);

    if (allScopeIds.length === 0) {
      console.log("[baseboards-windows-parity] No active scopes — skipping.");
      return;
    }

    const scopeIdsJson = JSON.stringify(allScopeIds);
    const firstScopeId = allScopeIds[0];

    // Baseboards: scope_ids → all 8 scopes, show_portal → false, price/time stable.
    // Match on name = 'Baseboards' (NOT the sqft% variant which has a longer name).
    await db.execute(sql`
      UPDATE pricing_addons
      SET scope_ids = ${scopeIdsJson},
          scope_id = ${firstScopeId},
          show_portal = false,
          show_online = false,
          show_office = true,
          price_type = 'flat',
          price_value = 30,
          time_add_minutes = 45,
          time_unit = 'each',
          is_active = true
      WHERE company_id = ${PHES}
        AND name = 'Baseboards'
    `);

    // Windows Standard/Recurring: 12 → 15. Other Windows variants untouched.
    await db.execute(sql`
      UPDATE pricing_addons
      SET price_value = 15
      WHERE company_id = ${PHES}
        AND name = 'Windows (inside panes) — Standard / Recurring'
        AND price_value <> 15
    `);

    console.log("[baseboards-windows-parity] Baseboards + Windows brought to MC parity.");
  } catch (err) {
    console.error("[baseboards-windows-parity] Migration error (non-fatal):", err);
  }
}

async function runDiscountMigration() {
  try {
    const scopeResult = await db.execute(sql`
      SELECT id, name FROM pricing_scopes WHERE company_id = ${PHES} AND is_active = true
    `);
    const scopeMap: Record<string, number> = {};
    for (const row of (scopeResult as any).rows ?? []) {
      scopeMap[row.name] = parseInt(row.id);
    }

    const OT  = scopeMap["One-Time Standard Clean"];
    const DC  = scopeMap["Deep Clean"];
    const MIO = scopeMap["Move In / Move Out"];
    const HS  = scopeMap["Hourly Standard Cleaning"];
    const HD  = scopeMap["Hourly Deep Clean"];
    const R   = scopeMap["Recurring Cleaning"];
    const C   = scopeMap["Commercial Cleaning"];

    // "Deep Clean or Move In/Out" maps to both DC + MIO
    const DC_MIO = [DC, MIO].filter(Boolean);

    const discounts: Array<{
      code: string; value: number; type: string;
      scope_ids: number[]; office: boolean; online: boolean;
    }> = [
      // Scope: One-Time Flat-Rate Standard Cleaning
      { code: "10% One time discount", value: 10, type: "percent", scope_ids: [OT].filter(Boolean), office: true, online: true },
      { code: "Chamber",               value: 15, type: "percent", scope_ids: [OT].filter(Boolean), office: true, online: true },
      { code: "fb15",                   value: 15, type: "percent", scope_ids: [OT].filter(Boolean), office: true, online: true },

      // Scope: Deep Clean or Move In/Out
      { code: "6-Month Promo",                    value: 20, type: "percent", scope_ids: DC_MIO, office: true, online: true },
      { code: "Chamber",                          value: 15, type: "percent", scope_ids: DC_MIO, office: true, online: true },
      { code: "Compass",                          value: 15, type: "percent", scope_ids: DC_MIO, office: true, online: true },
      { code: "Compass2026",                      value: 18, type: "percent", scope_ids: DC_MIO, office: true, online: true },
      { code: "Education Discount",               value: 12, type: "percent", scope_ids: DC_MIO, office: true, online: true },
      { code: "Existing client discount",         value: 12, type: "percent", scope_ids: DC_MIO, office: true, online: true },
      { code: "fbdeep15",                         value: 15, type: "percent", scope_ids: DC_MIO, office: true, online: true },
      { code: "Law Enforcement & First Responders", value: 12, type: "percent", scope_ids: DC_MIO, office: true, online: true },
      { code: "Manager Discretion Discount 25",   value: 25, type: "flat",    scope_ids: DC_MIO, office: true, online: true },
      { code: "Manager Discretion Discount 50",   value: 50, type: "flat",    scope_ids: DC_MIO, office: true, online: true },
      { code: "Realtor Discount",                 value: 12, type: "percent", scope_ids: DC_MIO, office: true, online: true },
      { code: "ROA",                              value: 15, type: "percent", scope_ids: DC_MIO, office: true, online: true },
      { code: "Senior Citizen Discount",          value: 12, type: "percent", scope_ids: DC_MIO, office: true, online: true },
      { code: "smartcity10",                      value: 10, type: "percent", scope_ids: DC_MIO, office: true, online: false },

      // Scope: Commercial Cleaning
      { code: "Adjustment", value: 100, type: "percent", scope_ids: [C].filter(Boolean), office: true, online: true },

      // Scope: Hourly Standard Cleaning
      { code: "Chamber", value: 15, type: "percent", scope_ids: [HS].filter(Boolean), office: true, online: true },

      // Scope: Hourly Deep Clean or Move In/Out
      { code: "Chamber",                        value: 15, type: "percent", scope_ids: [HD].filter(Boolean), office: true, online: true },
      { code: "Compass Discount",               value: 15, type: "percent", scope_ids: [HD].filter(Boolean), office: true, online: true },
      { code: "Manager Discretion Discount 25", value: 25, type: "flat",    scope_ids: [HD].filter(Boolean), office: true, online: true },

      // Scope: Recurring Cleaning
      { code: "fb15",      value: 15, type: "percent", scope_ids: [R].filter(Boolean), office: true, online: true },
      { code: "PHES10OFF", value: 10, type: "percent", scope_ids: [R].filter(Boolean), office: true, online: true },
    ];

    let seeded = 0;
    for (const d of discounts) {
      const scopeIdsJson = JSON.stringify([...d.scope_ids].sort((a, b) => a - b));
      await db.execute(sql`
        INSERT INTO pricing_discounts
          (company_id, code, description, discount_type, discount_value,
           scope_ids, frequency, availability_office, is_active, is_online)
        VALUES
          (${PHES}, ${d.code}, ${d.code}, ${d.type}, ${d.value},
           ${scopeIdsJson}, 'one_time', ${d.office}, true, ${d.online})
        ON CONFLICT (company_id, code, scope_ids)
          DO UPDATE SET
            discount_type = EXCLUDED.discount_type,
            discount_value = EXCLUDED.discount_value,
            availability_office = EXCLUDED.availability_office,
            is_online = EXCLUDED.is_online,
            frequency = EXCLUDED.frequency
      `);
      seeded++;
    }
    console.log(`[phes-migration] MC discounts seeded: ${seeded} rows`);

    // Delete placeholder discount add-ons
    const deleted = await db.execute(sql`
      DELETE FROM pricing_addons
      WHERE company_id = ${PHES}
        AND addon_type = 'other'
        AND (
          name LIKE 'Loyalty Discount%'
          OR name LIKE 'Promo Discount%'
          OR name LIKE 'Second Appointment Discount%'
        )
    `);
    console.log(`[phes-migration] Placeholder discount add-ons removed`);

  } catch (err) {
    console.error("[phes-migration] Discount migration error (non-fatal):", err);
  }
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
      // Tiered residential commission. Phes raised pricing on Deep Clean
      // and Move In/Out to $80/hr to client; tech share drops to 32% on
      // those two scopes. Standard residential remains 35%
      // (res_tech_pay_pct above). Resolved per-job by service_type:
      //   service_type IN ('deep_clean')          → deep_clean_pay_pct
      //   service_type IN ('move_in','move_out')  → move_in_out_pay_pct
      //   else                                    → res_tech_pay_pct
      ["companies.deep_clean_pay_pct",              sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS deep_clean_pay_pct NUMERIC(5,4) NOT NULL DEFAULT 0.32`],
      ["companies.move_in_out_pay_pct",             sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS move_in_out_pay_pct NUMERIC(5,4) NOT NULL DEFAULT 0.32`],
      // [AI.7.4] Commercial commission base rate + hours-source mode.
      // Without these columns, the dispatch SELECT throws and the whole
      // grid renders empty with a "Could not load schedule" toast.
      ["companies.commercial_hourly_rate",          sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS commercial_hourly_rate NUMERIC(10,2) NOT NULL DEFAULT 20.00`],
      ["companies.commercial_comp_mode",            sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS commercial_comp_mode TEXT NOT NULL DEFAULT 'allowed_hours'`],
      // [AI.10] AI.8's geocoded_at + geocode_source columns retired —
      // the user-facing Zone Coverage page is gone, and the boot-time
      // backfill runs unconditionally with a `WHERE zip IS NULL` guard
      // for idempotency. No need for per-row audit timestamps.
      // DROP COLUMN IF EXISTS is idempotent: if the column was never
      // created, this is a no-op; if AI.8 created it on a prior deploy,
      // this drops it. Either way safe to run on every cold start.
      ["clients.geocoded_at__drop",                 sql`ALTER TABLE clients DROP COLUMN IF EXISTS geocoded_at`],
      ["clients.geocode_source__drop",              sql`ALTER TABLE clients DROP COLUMN IF EXISTS geocode_source`],
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
