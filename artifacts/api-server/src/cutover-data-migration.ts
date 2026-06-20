/**
 * Cutover data migrations.
 *
 * Runs once per cold start (idempotent). Mirrors phes-data-migration's
 * pattern but scoped to the MaidCentral cutover pieces (1A onward).
 *
 * Today it does three things:
 *   1C. Installs the integrity CHECK constraint on job_clock_events
 *       (the legal backbone of the wage record).
 *   2A. Backs out the first-cut 2A schema (structured mileage columns
 *       + partial unique index on pay_adjustments). Those moved to
 *       the new mileage_legs table where they belong.
 *   2A. Seeds an initial mileage_rates row from companies.mileage_rate
 *       for every tenant that has no rate row yet, so the dated rate
 *       table starts populated and past behavior is preserved.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_NAME,
  JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_SQL,
} from "@workspace/db/schema";

export async function runCutoverDataMigration(): Promise<void> {
  try {
    await reconcileUsersSchemaColumns();
  } catch (err) {
    console.error(
      "[cutover-migration] users column reconcile failed (non-fatal):",
      err,
    );
  }
  try {
    await runClockEventsIntegrityConstraint();
  } catch (err) {
    console.error("[cutover-migration] failed (non-fatal):", err);
  }
  try {
    await backoutFirstCut2AMileageOnPayAdjustments();
  } catch (err) {
    console.error(
      "[cutover-migration] 2A back-out (pay_adjustments) failed (non-fatal):",
      err,
    );
  }
  try {
    await seedMileageRatesFromCompaniesScalar();
  } catch (err) {
    console.error(
      "[cutover-migration] mileage_rates seed failed (non-fatal):",
      err,
    );
  }
  try {
    await seedLeaveTypesPerTenant();
  } catch (err) {
    console.error(
      "[cutover-migration] leave_types seed failed (non-fatal):",
      err,
    );
  }
  try {
    await seedPhesLeavePolicy3A();
  } catch (err) {
    console.error(
      "[cutover-migration] Phes 3A leave policy seed failed (non-fatal):",
      err,
    );
  }
  try {
    await runAttendanceProposalsMigration();
  } catch (err) {
    console.error(
      "[cutover-migration] 3B attendance_proposals migration failed (non-fatal):",
      err,
    );
  }
  try {
    await addCancellationPolicyColumns();
  } catch (err) {
    console.error(
      "[cutover-migration] cancellation policy columns failed (non-fatal):",
      err,
    );
  }
  try {
    await addCancellationTechPayColumns();
  } catch (err) {
    console.error(
      "[cutover-migration] cancellation tech-pay columns failed (non-fatal):",
      err,
    );
  }
  try {
    await addLeaveCascadeColumns();
  } catch (err) {
    console.error(
      "[cutover-migration] leave cascade columns failed (non-fatal):",
      err,
    );
  }
  try {
    await addOvertimeColumns();
  } catch (err) {
    console.error(
      "[cutover-migration] overtime columns failed (non-fatal):",
      err,
    );
  }
  try {
    await ensureAbandonedBookingsTable();
  } catch (err) {
    console.error(
      "[cutover-migration] abandoned_bookings table ensure failed (non-fatal):",
      err,
    );
  }
  try {
    await ensureAbandonedBookingFollowup();
  } catch (err) {
    console.error(
      "[cutover-migration] abandoned_booking follow-up seed failed (non-fatal):",
      err,
    );
  }
}

/**
 * Abandoned-booking follow-up drip — mirrors the quote_followup /
 * post_job_retention sequences. Two parts, both idempotent:
 *
 *   1. Add follow_up_enrollments.abandoned_booking_id (FK → abandoned_bookings,
 *      ON DELETE SET NULL) so an enrollment can hang off an abandoned booking
 *      the same way others hang off quote_id / client_id / lead_id. SET NULL so
 *      the /book/confirm cleanup DELETE of the abandoned row doesn't block.
 *   2. Seed an 'abandoned_booking' sequence + its 5 steps for every company that
 *      already has follow-up sequences but not this one yet. Runs for co1 + co4
 *      identically (same content), matching how the other sequences are shaped.
 *
 * Step-1 timing (+20 min) is set by enrollForAbandonedBooking() at enroll time
 * (delay_hours is integer-hours and can't express 20 min); steps 2–5 advance via
 * delay_hours from the prior step (2h, 22h, 48h, 72h ≈ +2h, +1d, +3d, +6d from
 * abandon). Seeded is_active=true to match the other sequences — note co4 has
 * comms ON, so enrollments there will fire once deployed (gate via is_active if
 * a hold is wanted).
 */
async function ensureAbandonedBookingFollowup(): Promise<void> {
  // Part 1 — link column (no-op if follow_up_enrollments or abandoned_bookings
  // isn't present yet; both are created earlier / by phes-data-migration).
  await db.execute(
    sql.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='follow_up_enrollments'
      ) THEN
        RAISE NOTICE 'cutover-migration: follow_up_enrollments not present, skipping abandoned_booking_id add';
        RETURN;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='follow_up_enrollments'
          AND column_name='abandoned_booking_id'
      ) THEN
        ALTER TABLE follow_up_enrollments
          ADD COLUMN abandoned_booking_id integer
            REFERENCES abandoned_bookings(id) ON DELETE SET NULL;
      END IF;
    END
    $$;
  `),
  );

  // Part 2 — seed the sequence + steps per company (idempotent: only companies
  // that have follow-up sequences but lack an 'abandoned_booking' one).
  const companies = await db.execute(
    sql`
      SELECT DISTINCT company_id FROM follow_up_sequences
      WHERE company_id NOT IN (
        SELECT company_id FROM follow_up_sequences WHERE sequence_type = 'abandoned_booking'
      )
    `,
  );

  const step2Email =
    `<h2 style="font-size:22px;color:#1A1917;margin:0 0 12px;">Still want that cleaning, {{first_name}}?</h2>` +
    `<p style="font-size:15px;color:#1A1917;line-height:1.6;margin:0 0 16px;">You started booking with {{company_name}} but didn't quite finish. No worries — your details are saved and you can pick up right where you left off.</p>` +
    `<p style="text-align:center;margin:24px 0;"><a href="{{resume_link}}" style="background:#00C9A0;color:#0A0E1A;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:8px;display:inline-block;font-size:15px;">Finish my booking</a></p>` +
    `<p style="font-size:14px;color:#1A1917;line-height:1.6;margin:0;">Why customers choose us: every cleaner is vetted and background-checked, every clean is backed by our satisfaction guarantee (if we miss a spot, we come back and re-clean for free), and rescheduling is always easy.</p>` +
    `<p style="font-size:14px;color:#1A1917;line-height:1.6;margin:16px 0 0;">Questions? Call or text {{office_phone}} or just reply to this email.</p>` +
    `<p style="font-size:14px;color:#1A1917;margin:16px 0 0;">The {{company_name}} Team</p>`;

  const step4Email =
    `<h2 style="font-size:22px;color:#1A1917;margin:0 0 12px;">Here's 10% off to finish up, {{first_name}}</h2>` +
    `<p style="font-size:15px;color:#1A1917;line-height:1.6;margin:0 0 16px;">We'd love to get your home on the schedule — so here's <strong>10% off your first clean</strong> when you complete your booking. Your saved details are ready to go.</p>` +
    `<p style="text-align:center;margin:24px 0;"><a href="{{resume_link}}" style="background:#00C9A0;color:#0A0E1A;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:8px;display:inline-block;font-size:15px;">Finish my booking &amp; save 10%</a></p>` +
    `<p style="font-size:14px;color:#1A1917;line-height:1.6;margin:0;">Offer applies to your first clean. Questions? Call or text {{office_phone}} or reply to this email.</p>` +
    `<p style="font-size:14px;color:#1A1917;margin:16px 0 0;">The {{company_name}} Team</p>`;

  const steps = [
    { n: 1, h: 0, ch: "sms", subj: null,
      body: "Hi {{first_name}}, looks like you started booking your {{company_name}} cleaning but didn't finish — want me to hold your spot? Pick up where you left off: {{resume_link}}" },
    { n: 2, h: 2, ch: "email", subj: "Still want that cleaning, {{first_name}}?", body: step2Email },
    { n: 3, h: 22, ch: "sms", subj: null,
      body: "Hi {{first_name}}, your {{company_name}} booking is still saved and we have openings this week. Want me to get you on the schedule? {{resume_link}}" },
    { n: 4, h: 48, ch: "email", subj: "Here's 10% to finish up", body: step4Email },
    { n: 5, h: 72, ch: "sms", subj: null,
      body: "Hi {{first_name}}, I'll close out your booking for now — reply anytime and we'll pick right back up. Thanks from the {{company_name}} team." },
  ];

  for (const row of companies.rows as any[]) {
    const companyId = row.company_id;
    const seq = await db.execute(
      sql`
        INSERT INTO follow_up_sequences (company_id, sequence_type, name, is_active)
        VALUES (${companyId}, 'abandoned_booking', 'Abandoned Booking Follow-Up', true)
        RETURNING id
      `,
    );
    const seqId = (seq.rows[0] as any).id;
    for (const s of steps) {
      await db.execute(
        sql`
          INSERT INTO follow_up_steps (sequence_id, step_number, delay_hours, channel, subject, message_template)
          VALUES (${seqId}, ${s.n}, ${s.h}, ${s.ch}, ${s.subj}, ${s.body})
        `,
      );
    }
    console.log(
      `[cutover-migration] seeded abandoned_booking sequence ${seqId} (5 steps) for company ${companyId}`,
    );
  }
}

/**
 * Online-booking abandon capture — install the abandoned_bookings table
 * that POST /api/public/book/abandon-track upserts into (and the cleanup
 * DELETE in /book/confirm targets). The table was referenced in code but
 * never created, so abandon-track was returning 500 and the confirm-time
 * DELETE was silently swallowed by its surrounding try/catch. This fixes
 * both co1 (Oak Lawn) and co4 (Schaumburg).
 *
 * Columns match exactly what the raw-SQL upsert reads/writes
 * (company_id + email lookup key, contact fields, scope, step_abandoned).
 * Idempotent: CREATE TABLE / INDEX IF NOT EXISTS — safe every cold start.
 */
async function ensureAbandonedBookingsTable(): Promise<void> {
  await db.execute(
    sql.raw(`
    DO $$
    BEGIN
      CREATE TABLE IF NOT EXISTS abandoned_bookings (
        id              serial PRIMARY KEY,
        company_id      integer NOT NULL REFERENCES companies(id),
        first_name      text,
        last_name       text,
        email           text,
        phone           text,
        address         text,
        zip             text,
        scope           text,
        step_abandoned  integer DEFAULT 2,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS abandoned_bookings_company_email_idx
        ON abandoned_bookings (company_id, email);

      RAISE NOTICE 'cutover-migration: ensured abandoned_bookings table + index';
    END
    $$;
  `),
  );
}

/**
 * Cutover 3B — install the attendance_proposals table + its two
 * pgEnums (kind, status) + indexes (status, user, job) + the unique
 * index that guarantees scan idempotency on
 * (company_id, user_id, job_id, scheduled_date).
 *
 * Idempotent: every CREATE is IF NOT EXISTS / pg_type guarded. Safe
 * to run on every cold start.
 */
async function runAttendanceProposalsMigration(): Promise<void> {
  await db.execute(
    sql.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_proposal_kind') THEN
        CREATE TYPE attendance_proposal_kind AS ENUM
          ('late', 'short', 'no_show', 'missing_clockout');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_proposal_status') THEN
        CREATE TYPE attendance_proposal_status AS ENUM
          ('pending', 'confirmed', 'dismissed');
      END IF;

      CREATE TABLE IF NOT EXISTS attendance_proposals (
        id                          serial PRIMARY KEY,
        company_id                  integer NOT NULL REFERENCES companies(id),
        user_id                     integer NOT NULL REFERENCES users(id),
        job_id                      integer NOT NULL REFERENCES jobs(id),
        scheduled_date              date    NOT NULL,
        scheduled_time_minutes      integer,
        estimated_hours             numeric(5,2),
        kind                        attendance_proposal_kind   NOT NULL,
        status                      attendance_proposal_status NOT NULL DEFAULT 'pending',
        minutes_late                integer,
        minutes_short               integer,
        clock_in_event_id           integer REFERENCES job_clock_events(id),
        clock_out_event_id          integer REFERENCES job_clock_events(id),
        leave_request_id            integer REFERENCES leave_requests(id),
        created_at                  timestamptz NOT NULL DEFAULT now(),
        decided_at                  timestamptz,
        decided_by_user_id          integer REFERENCES users(id),
        decision_note               text,
        created_attendance_log_id   integer REFERENCES employee_attendance_log(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS attendance_proposals_unique_per_assignment_uq
        ON attendance_proposals (company_id, user_id, job_id, scheduled_date);

      CREATE INDEX IF NOT EXISTS attendance_proposals_company_status_idx
        ON attendance_proposals (company_id, status, scheduled_date);
      CREATE INDEX IF NOT EXISTS attendance_proposals_company_user_idx
        ON attendance_proposals (company_id, user_id, scheduled_date);
      CREATE INDEX IF NOT EXISTS attendance_proposals_company_job_idx
        ON attendance_proposals (company_id, job_id);

      RAISE NOTICE 'cutover-migration: ensured attendance_proposals table + indexes';
    END
    $$;
  `),
  );
}

/**
 * Leave bucket cascade — add the two columns that let multi-bucket
 * fall-through requests (PTO → PLAWA → Unpaid Leave) be created as N
 * linked leave_requests rows sharing one group id. Both NULL on the
 * 3A single-bucket flow so nothing existing changes.
 *
 *   cascade_group_id  text     shared id for one cascade
 *   cascade_order     integer  per-bucket index within the cascade
 *
 * Plus a btree index on cascade_group_id so "show me the whole
 * cascade" lookups stay O(group-size). Idempotent: skips when columns
 * + index already present, no-ops cleanly if leave_requests itself
 * isn't there yet (table comes from 3A, runs above this block).
 */
async function addLeaveCascadeColumns(): Promise<void> {
  await db.execute(
    sql.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'leave_requests'
      ) THEN
        RAISE NOTICE 'cutover-migration: leave_requests not present yet, skipping cascade column add';
        RETURN;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='leave_requests' AND column_name='cascade_group_id'
      ) THEN
        ALTER TABLE leave_requests ADD COLUMN cascade_group_id text;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='leave_requests' AND column_name='cascade_order'
      ) THEN
        ALTER TABLE leave_requests ADD COLUMN cascade_order integer;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname='public' AND tablename='leave_requests'
          AND indexname='leave_requests_cascade_group_idx'
      ) THEN
        CREATE INDEX leave_requests_cascade_group_idx
          ON leave_requests (cascade_group_id);
      END IF;
    END $$;
  `),
  );
}

/**
 * Cancellation policy + action picker columns.
 *
 * Three migrations bundled because they shape one feature:
 *   1. companies.default_cancel_fee_pct + default_lockout_fee_pct
 *      (per-tenant defaults; 100% for Phes per stated policy).
 *   2. clients.cancel_fee_pct + lockout_fee_pct
 *      (nullable per-client overrides).
 *   3. cancellation_log.cancel_action + customer_charge_amount +
 *      affects_future_jobs (the per-event audit + reporting hooks).
 *
 * Idempotent guards on every ADD. Defaults match the schema definition
 * so the row default and the migration default never drift.
 */
async function addCancellationPolicyColumns(): Promise<void> {
  await db.execute(
    sql.raw(`
    DO $$
    BEGIN
      -- companies: per-tenant defaults
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='companies' AND column_name='default_cancel_fee_pct'
      ) THEN
        ALTER TABLE companies ADD COLUMN default_cancel_fee_pct numeric(5,2) NOT NULL DEFAULT 100.00;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='companies' AND column_name='default_lockout_fee_pct'
      ) THEN
        ALTER TABLE companies ADD COLUMN default_lockout_fee_pct numeric(5,2) NOT NULL DEFAULT 100.00;
      END IF;

      -- clients: per-record overrides (nullable on purpose)
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='clients' AND column_name='cancel_fee_pct'
      ) THEN
        ALTER TABLE clients ADD COLUMN cancel_fee_pct numeric(5,2);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='clients' AND column_name='lockout_fee_pct'
      ) THEN
        ALTER TABLE clients ADD COLUMN lockout_fee_pct numeric(5,2);
      END IF;

      -- cancellation_log: action picker + charged amount + future-jobs flag
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='cancellation_log' AND column_name='cancel_action'
      ) THEN
        ALTER TABLE cancellation_log ADD COLUMN cancel_action text;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='cancellation_log' AND column_name='customer_charge_amount'
      ) THEN
        ALTER TABLE cancellation_log ADD COLUMN customer_charge_amount numeric(10,2) NOT NULL DEFAULT 0;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='cancellation_log' AND column_name='affects_future_jobs'
      ) THEN
        ALTER TABLE cancellation_log ADD COLUMN affects_future_jobs boolean NOT NULL DEFAULT false;
      END IF;
    END $$;
  `),
  );
}

/**
 * Cancellation tech-pay policy columns. Adds:
 *   companies.cancellation_tech_pay_mode  ('flat' | 'percent', default 'flat')
 *   companies.cancellation_tech_pay_amount (numeric(10,4), default 60.0000)
 *
 * Phes default: $60 flat per cancel/lockout, matching the cleanup-trip
 * fee techs were historically paid. Tenants flip to 'percent' to share
 * the customer charge instead.
 */
async function addCancellationTechPayColumns(): Promise<void> {
  await db.execute(
    sql.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='companies' AND column_name='cancellation_tech_pay_mode'
      ) THEN
        ALTER TABLE companies ADD COLUMN cancellation_tech_pay_mode text NOT NULL DEFAULT 'flat';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='companies' AND column_name='cancellation_tech_pay_amount'
      ) THEN
        ALTER TABLE companies ADD COLUMN cancellation_tech_pay_amount numeric(10,4) NOT NULL DEFAULT 60.0000;
      END IF;
    END $$;
  `),
  );
}

/**
 * Overtime (2026-06-04) — add the jurisdiction-aware overtime config columns
 * to companies. Idempotent (every ADD is column-guarded).
 *
 * ot_rules_source is intentionally left NULL on add: a NULL source means "not
 * yet configured", and resolveOvertimeRules() falls back to the preset for
 * companies.state at read time. So a fresh column add immediately yields the
 * correct per-state rules (federal/weekly-40 for IL and most states; daily OT
 * for CA/AK/CO/NV) without seeding state-specific values into every row. The
 * source flips to 'custom' only when an owner edits the settings.
 */
async function addOvertimeColumns(): Promise<void> {
  await db.execute(
    sql.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='companies' AND column_name='ot_rules_source') THEN
        ALTER TABLE companies ADD COLUMN ot_rules_source text;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='companies' AND column_name='ot_weekly_threshold_hours') THEN
        ALTER TABLE companies ADD COLUMN ot_weekly_threshold_hours numeric(5,2) DEFAULT 40.00;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='companies' AND column_name='ot_daily_threshold_hours') THEN
        ALTER TABLE companies ADD COLUMN ot_daily_threshold_hours numeric(5,2);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='companies' AND column_name='ot_daily_doubletime_hours') THEN
        ALTER TABLE companies ADD COLUMN ot_daily_doubletime_hours numeric(5,2);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='companies' AND column_name='ot_seventh_day_rule') THEN
        ALTER TABLE companies ADD COLUMN ot_seventh_day_rule boolean NOT NULL DEFAULT false;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='companies' AND column_name='ot_multiplier') THEN
        ALTER TABLE companies ADD COLUMN ot_multiplier numeric(4,2) NOT NULL DEFAULT 1.50;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='companies' AND column_name='ot_doubletime_multiplier') THEN
        ALTER TABLE companies ADD COLUMN ot_doubletime_multiplier numeric(4,2) NOT NULL DEFAULT 2.00;
      END IF;
    END $$;
  `),
  );
}

/**
 * Cutover 3A — seed leave_types for tenants. Default new-tenant
 * shape is PTO (paid, flat_grant, NOT exempt from blackout) + Sick
 * (paid, accrue_per_hours placeholder, exempt). Phes (company_id 1)
 * gets the four-bucket shape:
 *   - PLAWA (paid, accrue_per_hours, 1/40, 40 cap, 90-day wait, carryover, exempt)
 *   - PTO   (paid, flat_grant, 40 cap, 365-day wait, NOT exempt)
 *   - Unpaid Leave (unpaid, flat_grant, 40 cap, 0-day wait, NOT exempt)
 *   - Unexcused (unpaid, office_recorded, 40 cap, requestable=false)
 *
 * Idempotent on each (company_id, slug) — uses ON CONFLICT DO NOTHING
 * against the unique index leave_types_company_slug_uq.
 */
async function seedLeaveTypesPerTenant(): Promise<void> {
  await db.execute(
    sql.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'leave_types'
      ) THEN
        RAISE NOTICE 'cutover-migration: leave_types not present yet, skipping seed';
        RETURN;
      END IF;

      -- Default new-tenant shape: PTO + Sick. No PLAWA in the default
      -- so multi-state platform tenants are not silently given an
      -- Illinois-specific bucket.
      INSERT INTO leave_types (
        company_id, slug, display_name, is_paid, annual_cap_hours,
        accrual_mode, accrual_rate, waiting_period_days,
        carryover_allowed, documentation_required, requestable,
        exempt_from_blackout
      )
      SELECT c.id, 'pto', 'PTO', true, 40,
             'flat_grant', 0, 365,
             false, false, true,
             false
      FROM companies c
      WHERE NOT EXISTS (
        SELECT 1 FROM leave_types lt
        WHERE lt.company_id = c.id AND lt.slug = 'pto'
      )
      ON CONFLICT DO NOTHING;

      INSERT INTO leave_types (
        company_id, slug, display_name, is_paid, annual_cap_hours,
        accrual_mode, accrual_rate, waiting_period_days,
        carryover_allowed, documentation_required, requestable,
        exempt_from_blackout
      )
      SELECT c.id, 'sick', 'Sick Time', true, 40,
             'flat_grant', 0, 0,
             false, false, true,
             true
      FROM companies c
      WHERE NOT EXISTS (
        SELECT 1 FROM leave_types lt
        WHERE lt.company_id = c.id AND lt.slug = 'sick'
      )
      ON CONFLICT DO NOTHING;

      -- Phes-specific buckets. Only seeded for company_id=1.
      INSERT INTO leave_types (
        company_id, slug, display_name, is_paid, annual_cap_hours,
        accrual_mode, accrual_rate, waiting_period_days,
        carryover_allowed, documentation_required, requestable,
        exempt_from_blackout
      )
      -- PLAWA: 40h FRONT-LOADED after 90 days, NO carryover (reset to 40
      -- each calendar year). This is Phes's actual policy per the handbook
      -- ("40 paid hours per Benefit Year, front-loaded after 90 days …
      -- unused PLAWA hours … do not carry over"), confirmed by Sal
      -- 2026-06-20. NOT accrue_per_hours — that earlier seed encoded the
      -- IL statutory MINIMUM (1hr/40 worked), which Phes exceeds.
      VALUES
        (1, 'plawa', 'PLAWA', true, 40,
         'flat_grant', 0, 90,
         false, false, true, true),
        (1, 'pto_phes', 'PTO', true, 40,
         'flat_grant', 0, 365,
         true, false, true, false),
        (1, 'unpaid_leave', 'Unpaid Leave', false, 40,
         'flat_grant', 0, 0,
         false, false, true, false),
        (1, 'unexcused', 'Unexcused', false, 40,
         'office_recorded', 0, 0,
         false, false, false, false)
      ON CONFLICT DO NOTHING;

      -- Correct any pre-existing Phes PLAWA row (deployed before the fix
      -- above) to the front-loaded policy. ON CONFLICT DO NOTHING leaves
      -- existing rows untouched, so this UPDATE is the path that fixes
      -- prod. Idempotent.
      UPDATE leave_types
      SET accrual_mode = 'flat_grant',
          accrual_rate = 0,
          carryover_allowed = false
      WHERE company_id = 1
        AND slug = 'plawa';

      -- The default-seeded "pto" row for company_id=1 collides with
      -- the Phes-specific PTO (slug 'pto_phes' is intentional to keep
      -- both rows distinguishable). If the default 'pto' row was
      -- already seeded for Phes from a prior deploy, deactivate it
      -- so the Phes-specific row is the only one shown.
      UPDATE leave_types
      SET active = false
      WHERE company_id = 1
        AND slug = 'pto';

      -- Likewise deactivate the generic default 'sick' bucket for Phes —
      -- PLAWA is the single sick bucket for co1. Two active sick-like
      -- buckets (generic 'sick' + 'plawa') is a seeding leftover.
      UPDATE leave_types
      SET active = false
      WHERE company_id = 1
        AND slug = 'sick';

      RAISE NOTICE 'cutover-migration: seeded leave_types per tenant';
    END
    $$;
  `),
  );
}

/**
 * Cutover 3A — seed the Phes company_leave_policy with the
 * WORK-ANNIVERSARY reset (per-employee benefit year) + ceiling +
 * lead-days. Each employee's buckets (PLAWA, PTO, Unpaid) reset on their
 * own hire anniversary — matches the handbook's individualized "Benefit
 * Year" (confirmed by Sal 2026-06-20: NOT a Jan-1 calendar reset).
 * Idempotent: COALESCE-preserves any tenant customization.
 */
async function seedPhesLeavePolicy3A(): Promise<void> {
  await db.execute(
    sql.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'company_leave_policy'
      ) THEN
        RAISE NOTICE 'cutover-migration: company_leave_policy not present yet, skipping 3A seed';
        RETURN;
      END IF;
      INSERT INTO company_leave_policy (
        company_id, leave_reset_basis,
        use_it_or_lose_it_alert_lead_days, balance_ceiling_hours
      )
      VALUES (1, 'work_anniversary', 60, 80)
      ON CONFLICT (company_id) DO UPDATE SET
        leave_reset_basis = COALESCE(EXCLUDED.leave_reset_basis, company_leave_policy.leave_reset_basis),
        use_it_or_lose_it_alert_lead_days = COALESCE(EXCLUDED.use_it_or_lose_it_alert_lead_days, company_leave_policy.use_it_or_lose_it_alert_lead_days),
        balance_ceiling_hours = COALESCE(EXCLUDED.balance_ceiling_hours, company_leave_policy.balance_ceiling_hours);
      RAISE NOTICE 'cutover-migration: ensured Phes 3A leave policy (work-anniversary reset)';
    END
    $$;
  `),
  );
}

/**
 * Cutover 2A (corrective) — back out the first-cut mileage shape from
 * pay_adjustments. The first 2A added 8 columns + a partial unique
 * index on pay_adjustments for adjustment_type='mileage' rows; the
 * corrective version moved all of that to mileage_legs, where a
 * computed-but-not-applied lifecycle exists. Safe to drop because no
 * production data uses the columns yet (mileage hasn't been computed
 * against a real period; the office workflow wasn't shipped).
 */
const PAY_ADJUSTMENTS_OLD_MILEAGE_INDEX_NAME =
  "pay_adjustments_mileage_source_uq";
const PAY_ADJUSTMENTS_OLD_MILEAGE_COLUMNS = [
  "source_on_my_way_event_id",
  "from_job_id",
  "to_job_id",
  "miles",
  "minutes",
  "rate_per_mile",
  "measurement_source",
  "measurement_is_estimated",
];

async function backoutFirstCut2AMileageOnPayAdjustments(): Promise<void> {
  // Drop the partial unique index. IF EXISTS keeps this idempotent
  // across deploys whether or not the first 2A ever landed in this
  // tenant's DB.
  await db.execute(
    sql.raw(`
    DROP INDEX IF EXISTS public.${PAY_ADJUSTMENTS_OLD_MILEAGE_INDEX_NAME};
  `),
  );
  for (const col of PAY_ADJUSTMENTS_OLD_MILEAGE_COLUMNS) {
    await db.execute(
      sql.raw(`
      ALTER TABLE IF EXISTS public.pay_adjustments
        DROP COLUMN IF EXISTS ${col};
    `),
    );
  }
}

/**
 * Cutover 2A (corrective) — seed mileage_rates row 1 from
 * companies.mileage_rate. Runs idempotently: only inserts when the
 * tenant has zero rate rows. effective_date defaults to a far-past
 * date so the seeded row covers every historical period.
 *
 * Future rate changes happen via INSERTs to mileage_rates, NOT by
 * editing companies.mileage_rate. The scalar stays on companies for
 * backwards-compatibility (other parts of the codebase may read it
 * for display) but is no longer the source of truth for pay.
 */
async function seedMileageRatesFromCompaniesScalar(): Promise<void> {
  await db.execute(
    sql.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'mileage_rates'
      ) THEN
        RAISE NOTICE 'cutover-migration: mileage_rates not present yet, skipping seed';
        RETURN;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'companies'
      ) THEN
        RAISE NOTICE 'cutover-migration: companies not present yet, skipping seed';
        RETURN;
      END IF;
      INSERT INTO mileage_rates (
        company_id, rate, effective_date, end_date,
        created_by_user_id
      )
      SELECT
        c.id,
        c.mileage_rate,
        DATE '2000-01-01',
        NULL,
        (SELECT u.id FROM users u WHERE u.company_id = c.id ORDER BY u.id LIMIT 1)
      FROM companies c
      WHERE c.mileage_rate IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM mileage_rates mr WHERE mr.company_id = c.id
        )
        AND EXISTS (
          SELECT 1 FROM users u WHERE u.company_id = c.id
        );
      RAISE NOTICE 'cutover-migration: seeded mileage_rates from companies.mileage_rate';
    END
    $$;
  `),
  );
}

/**
 * Reconcile additive `users` columns that exist in the Drizzle schema
 * but were never given a runtime `ALTER TABLE ... ADD COLUMN` migration.
 *
 * Background: production deploys do NOT run `drizzle-kit push` (the
 * Dockerfile boots `node dist/index.mjs` directly), so a column only
 * reaches the live database if an explicit `ADD COLUMN IF NOT EXISTS`
 * runs at startup. Cutover 1A (#195) added home_lat / home_lng /
 * default_team / default_position to the `users` schema for the
 * geofence + day-view work but shipped no such migration. The columns
 * are nullable and unused by the live read paths, so the gap stayed
 * invisible — until any `INSERT INTO users ... RETURNING *` ran.
 * Drizzle's `.returning()` names every schema column in the RETURNING
 * clause, so the LMS "Add Employee" insert (POST /api/users/lms-add)
 * threw `column "home_lat" does not exist` and surfaced as a 500
 * "Failed to add employee".
 *
 * Each statement is `IF NOT EXISTS`, so this is idempotent and safe to
 * run on every cold start and on tenants that already have the columns.
 * Keep this list in sync with any future additive `users` column that
 * lands in the schema without its own migration.
 */
const USERS_RECONCILE_COLUMNS: string[] = [
  // Cutover 1A (#195) — the confirmed regression cause.
  "home_lat numeric(10,7)",
  "home_lng numeric(10,7)",
  "default_team text",
  "default_position text",
  // Earlier additive columns that also shipped without a runtime
  // migration. Almost certainly already present in prod (added in the
  // project's drizzle-push era), but included defensively: every
  // statement is IF NOT EXISTS, so a present column is a no-op and a
  // missing one is healed. This guarantees the INSERT ... RETURNING in
  // POST /api/users/lms-add can name every users column.
  "home_branch_id integer",
  "crew_id integer",
  "benefit_year_start date",
  'leave_balance_hours numeric(8,2) DEFAULT \'0\'',
  "leave_balance_activated boolean DEFAULT false",
];

async function reconcileUsersSchemaColumns(): Promise<void> {
  const tables = await db.execute(
    sql.raw(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'users'
  `),
  );
  // Drizzle returns { rows } for db.execute; bail if users isn't there
  // yet (first deploy before drizzle-kit push has ever run).
  const rowCount = (tables as { rows?: unknown[] }).rows?.length ?? 0;
  if (rowCount === 0) {
    console.log(
      "[cutover-migration] users table not present yet, skipping column reconcile",
    );
    return;
  }
  for (const col of USERS_RECONCILE_COLUMNS) {
    await db.execute(
      sql.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col};`),
    );
  }
}

/**
 * Install the CHECK constraint on job_clock_events. Idempotent:
 *   - skips when the table doesn't exist yet (first deploy where
 *     drizzle-kit push has not run)
 *   - skips when the constraint already exists
 *   - never alters existing rows; the constraint is added with NOT
 *     VALID semantics on PostgreSQL only if we ever need to introduce
 *     it onto a table with legacy data. As of 1C the table is brand
 *     new so the constraint is added in full-validate mode.
 */
async function runClockEventsIntegrityConstraint(): Promise<void> {
  await db.execute(sql.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'job_clock_events'
      ) THEN
        RAISE NOTICE 'cutover-migration: job_clock_events table not present yet, skipping CHECK install';
        RETURN;
      END IF;

      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = '${JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_NAME}'
      ) THEN
        RAISE NOTICE 'cutover-migration: CHECK constraint already present';
        RETURN;
      END IF;

      EXECUTE 'ALTER TABLE job_clock_events ADD CONSTRAINT ${JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_NAME} CHECK ${JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_SQL.replace(/'/g, "''")}';
      RAISE NOTICE 'cutover-migration: installed ${JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_NAME}';
    END
    $$;
  `));
}
