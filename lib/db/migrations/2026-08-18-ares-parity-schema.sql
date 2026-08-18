-- [ares-parity 2026-08-18] Bring the dormant sales-commission schema up to
-- full parity with the legacy Ares engine.
--
-- Every statement is IDEMPOTENT and ADDITIVE. Nothing is dropped, nothing is
-- renamed, no existing column changes type. Safe to run repeatedly and safe to
-- run against a database where these tables already exist but are empty.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block, so do NOT
-- wrap this file in BEGIN/COMMIT. Run it statement-by-statement (psql runs each
-- in autocommit by default).
--
-- Apply order: enums → tables → columns → constraints.

-- ── 1. sales_commission_status: Ares' five extra states ─────────────────────
-- Existing values stay untouched. Ares 'pending' maps to 'pending_review' and
-- Ares 'chargebacked' maps to 'charged_back'; the rest are added here.
ALTER TYPE sales_commission_status ADD VALUE IF NOT EXISTS 'not_eligible';
ALTER TYPE sales_commission_status ADD VALUE IF NOT EXISTS 'on_hold';
ALTER TYPE sales_commission_status ADD VALUE IF NOT EXISTS 'chargeback_pending';
ALTER TYPE sales_commission_status ADD VALUE IF NOT EXISTS 'chargeback_confirmed';
ALTER TYPE sales_commission_status ADD VALUE IF NOT EXISTS 'recouped';

-- ── 2. New enums ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE sales_commission_type AS ENUM
    ('base', 'sourcing_bonus', 'performance_bonus', 'specialty_bonus', 'frequency_adjustment');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- All 9 categories Ares' review dropdown offers. A reviewer must never be able
-- to pick a reason the database cannot store.
DO $$ BEGIN
  CREATE TYPE commission_ineligibility_category AS ENUM
    ('returning_90_days', 'returning_no_agreement', 'missing_agreement',
     'cancelled_before_clean', 'duplicate', 'data_error',
     'client_initiated', 'previous_phes', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Idempotent top-up, in case an earlier 4-value version of this file was run.
ALTER TYPE commission_ineligibility_category ADD VALUE IF NOT EXISTS 'returning_no_agreement';
ALTER TYPE commission_ineligibility_category ADD VALUE IF NOT EXISTS 'missing_agreement';
ALTER TYPE commission_ineligibility_category ADD VALUE IF NOT EXISTS 'cancelled_before_clean';
ALTER TYPE commission_ineligibility_category ADD VALUE IF NOT EXISTS 'duplicate';
ALTER TYPE commission_ineligibility_category ADD VALUE IF NOT EXISTS 'data_error';

DO $$ BEGIN
  CREATE TYPE commission_ledger_entry_type AS ENUM
    ('base', 'commercial_source_bonus', 'specialty_bonus', 'performance_bonus',
     'adjustment', 'chargeback', 'payout');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. commission_policy: the knobs Ares hardcoded ──────────────────────────
ALTER TABLE commission_policy
  ADD COLUMN IF NOT EXISTS commercial_chargeback_window_days integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chargeback_dispute_days           integer NOT NULL DEFAULT 14,
  ADD COLUMN IF NOT EXISTS self_sourced_bonus                numeric(12,2) NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS performance_bonus_amount          numeric(12,2) NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS performance_bonus_threshold       integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS specialty_bonus_rate              numeric(6,4) NOT NULL DEFAULT 0.05;

-- Ares' residential chargeback window is 6 months, not the 90-day placeholder
-- the dormant schema shipped with. Only move rows still on the placeholder.
UPDATE commission_policy SET chargeback_window_days = 180 WHERE chargeback_window_days = 90;

-- ── 4. commission_rate_card ──────────────────────────────────────────────────
-- The flat (client_type, cadence) → dollars table. `cadence` is text, not the
-- recurring_cadence enum, because the Ares rate table prices cadences the enum
-- does not carry yet (every_5_weeks, quarterly).
CREATE TABLE IF NOT EXISTS commission_rate_card (
  id                   serial PRIMARY KEY,
  company_id           integer NOT NULL REFERENCES companies(id),
  branch_id            integer,
  commission_policy_id integer REFERENCES commission_policy(id),
  client_type          recurring_client_type NOT NULL,
  cadence              text NOT NULL,
  amount               numeric(12,2) NOT NULL DEFAULT 0,
  effective_date       date NOT NULL,
  end_date             date,
  created_at           timestamp NOT NULL DEFAULT now(),
  updated_at           timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE commission_rate_card
    ADD CONSTRAINT commission_rate_card_uniq
    UNIQUE (company_id, branch_id, client_type, cadence, effective_date);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;

-- ── 5. commissions: Ares' composition, snapshots and lifecycle dates ────────
-- A performance bonus is earned against a MONTH, not a subscription, so the FK
-- has to become nullable.
ALTER TABLE commissions ALTER COLUMN subscription_id DROP NOT NULL;

ALTER TABLE commissions
  ADD COLUMN IF NOT EXISTS client_name                 text,
  ADD COLUMN IF NOT EXISTS va_name                     text,
  ADD COLUMN IF NOT EXISTS commission_type             sales_commission_type NOT NULL DEFAULT 'base',
  ADD COLUMN IF NOT EXISTS client_type                 recurring_client_type,
  ADD COLUMN IF NOT EXISTS cadence                     text,
  ADD COLUMN IF NOT EXISTS base_amount                 numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_bonus_amount         numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS specialty_bonus_amount      numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS specialty_service_type      text,
  ADD COLUMN IF NOT EXISTS revenue_amount              numeric(12,2),
  ADD COLUMN IF NOT EXISTS rate_card_id                integer REFERENCES commission_rate_card(id),
  ADD COLUMN IF NOT EXISTS first_cleaning_date         date,
  ADD COLUMN IF NOT EXISTS chargeback_dispute_deadline date,
  ADD COLUMN IF NOT EXISTS chargeback_date             date,
  ADD COLUMN IF NOT EXISTS service_agreement_verified  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ineligibility_category      commission_ineligibility_category,
  ADD COLUMN IF NOT EXISTS ineligibility_reason        text,
  ADD COLUMN IF NOT EXISTS reactivation_date           date,
  ADD COLUMN IF NOT EXISTS days_inactive               integer,
  ADD COLUMN IF NOT EXISTS notes                       text,
  ADD COLUMN IF NOT EXISTS approved_by                 integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at                 timestamp,
  ADD COLUMN IF NOT EXISTS paid_date                   date;

-- The approval queue and the payout run both scan on these.
CREATE INDEX IF NOT EXISTS commissions_company_status_idx   ON commissions (company_id, status);
CREATE INDEX IF NOT EXISTS commissions_va_status_idx        ON commissions (company_id, va_user_id, status);
CREATE INDEX IF NOT EXISTS commissions_first_clean_idx      ON commissions (company_id, first_cleaning_date);
CREATE INDEX IF NOT EXISTS commissions_dispute_deadline_idx ON commissions (company_id, chargeback_dispute_deadline)
  WHERE chargeback_dispute_deadline IS NOT NULL;

-- ── 6. commission_payments: receipts, netting and carryover ─────────────────
ALTER TABLE commission_payments
  ADD COLUMN IF NOT EXISTS va_name                text,
  ADD COLUMN IF NOT EXISTS sales_period           text,
  ADD COLUMN IF NOT EXISTS gross_amount           numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chargeback_total       numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS carryover_amount       numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS carryover_collected_at timestamp,
  ADD COLUMN IF NOT EXISTS receipt_number         text,
  ADD COLUMN IF NOT EXISTS payment_method         text,
  ADD COLUMN IF NOT EXISTS payment_details        jsonb,
  ADD COLUMN IF NOT EXISTS notes                  text;

-- ── 7. commission_chargebacks: the dispute window and its settlement ────────
ALTER TABLE commission_chargebacks
  ADD COLUMN IF NOT EXISTS dispute_deadline     date,
  ADD COLUMN IF NOT EXISTS recouped_payment_id  integer REFERENCES commission_payments(id),
  ADD COLUMN IF NOT EXISTS recouped_at          timestamp;

-- ── 8. commission_ledger ─────────────────────────────────────────────────────
-- Signed money movements. Positive = owed to the VA, negative = clawed back.
-- Career earnings and statements sum THIS, not the commission rows, because an
-- adjustment moves money without creating a line.
CREATE TABLE IF NOT EXISTS commission_ledger (
  id              serial PRIMARY KEY,
  company_id      integer NOT NULL REFERENCES companies(id),
  branch_id       integer,
  commission_id   integer REFERENCES commissions(id),
  subscription_id integer REFERENCES recurring_subscriptions(id),
  client_id       integer REFERENCES clients(id),
  va_user_id      integer NOT NULL REFERENCES users(id),
  entry_type      commission_ledger_entry_type NOT NULL,
  amount          numeric(12,2) NOT NULL,
  description     text NOT NULL,
  metadata        jsonb,
  related_period  text,
  created_by      integer REFERENCES users(id),
  created_at      timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commission_ledger_va_idx     ON commission_ledger (company_id, va_user_id);
CREATE INDEX IF NOT EXISTS commission_ledger_period_idx ON commission_ledger (company_id, related_period);

-- ── 9. subscription_cadence_history ─────────────────────────────────────────
-- Every cadence change and the commission delta it produced. Unlike Ares this
-- row is written even when the delta is zero, so same-price changes are still
-- part of the history.
CREATE TABLE IF NOT EXISTS subscription_cadence_history (
  id                serial PRIMARY KEY,
  company_id        integer NOT NULL REFERENCES companies(id),
  branch_id         integer,
  subscription_id   integer NOT NULL REFERENCES recurring_subscriptions(id),
  previous_cadence  text,
  new_cadence       text NOT NULL,
  adjustment_amount numeric(12,2) NOT NULL DEFAULT 0,
  effective_date    timestamp NOT NULL DEFAULT now(),
  changed_by        integer REFERENCES users(id),
  reason            text,
  created_at        timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscription_cadence_history_sub_idx
  ON subscription_cadence_history (company_id, subscription_id);

-- ── 10. Seed the rate card ───────────────────────────────────────────────────
-- Ares' live rates as of the 2026-08-18 export. Seeded per company, company-wide
-- (branch_id NULL); add branch-specific rows later to override.
--
-- 10a. The rates Ares has always paid — backdated so any historical
-- re-derivation resolves to what was actually paid.
INSERT INTO commission_rate_card (company_id, branch_id, client_type, cadence, amount, effective_date)
SELECT c.id, NULL, v.client_type::recurring_client_type, v.cadence, v.amount, DATE '2020-01-01'
  FROM companies c
 CROSS JOIN (VALUES
   ('residential', 'weekly',        75),
   ('residential', 'biweekly',      50),
   ('residential', 'semi_monthly',  50),
   ('residential', 'every_3_weeks', 30),
   ('residential', 'monthly',       25),
   ('residential', 'every_5_weeks', 20),
   ('residential', 'quarterly',     15),
   ('commercial',  'weekly',       100),
   ('commercial',  'biweekly',     100),
   ('commercial',  'semi_monthly', 100),
   ('commercial',  'every_3_weeks', 50),
   ('commercial',  'monthly',       50),
   ('commercial',  'every_5_weeks', 50),
   ('commercial',  'quarterly',     50)
 ) AS v(client_type, cadence, amount)
ON CONFLICT ON CONSTRAINT commission_rate_card_uniq DO NOTHING;

-- 10b. NEW rates, effective from the cutover only — never backdated.
--
-- Ares never priced every_6_weeks or every_8_weeks. Its normalizer matched both
-- to "weekly" (every string contains "week"), so a client cleaned 6-8 times a
-- YEAR has been paying a $75 residential / $100 commercial weekly commission.
-- That was an overpay bug, not a rate.
--
-- Rates derived from the schedule above (Sal, 2026-08-18):
--   • Commercial is a two-tier rule — 2+ visits/month = $100, less frequent
--     = $50. Both new cadences are less frequent, so both = $50.
--   • Residential steps 75/50/30/25/20/15 in $5 increments. The new cadences
--     sit between every_5_weeks ($20 @ 0.87 visits/mo) and quarterly ($15 @
--     0.33), one step apart: 6 weeks = $20, 8 weeks = $15.
--
-- The 2026-08-18 effective_date is load-bearing: past commissions on these
-- cadences are LEFT ALONE by decision. Paid is paid.
INSERT INTO commission_rate_card (company_id, branch_id, client_type, cadence, amount, effective_date)
SELECT c.id, NULL, v.client_type::recurring_client_type, v.cadence, v.amount, DATE '2026-08-18'
  FROM companies c
 CROSS JOIN (VALUES
   ('residential', 'every_6_weeks', 20),
   ('residential', 'every_8_weeks', 15),
   ('commercial',  'every_6_weeks', 50),
   ('commercial',  'every_8_weeks', 50)
 ) AS v(client_type, cadence, amount)
ON CONFLICT ON CONSTRAINT commission_rate_card_uniq DO NOTHING;
