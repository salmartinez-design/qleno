-- [ares 2026-08-19] Create the 11 tables the Ares module needs.
--
-- WHY THIS FILE EXISTS INSTEAD OF `drizzle-kit push`:
-- the live database has 212 tables; the Drizzle schema defines 153. Push
-- reconciles in both directions, so it can propose DROPPING the 59 tables it
-- doesn't know about. This file only ever CREATEs. It cannot drop, cannot
-- alter, and cannot touch a single existing row.
--
-- Idempotent — safe to run more than once. Run it top to bottom; do NOT wrap it
-- in a transaction (CREATE TYPE inside a DO block is fine, but keep the habit).

-- ── Enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE recurring_client_type AS ENUM ('residential','commercial'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE recurring_status AS ENUM ('active','paused','lost','on_demand'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE recurring_price_basis AS ENUM ('monthly','per_visit','unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE recurring_cadence AS ENUM ('weekly','biweekly','every_3_weeks','every_6_weeks','every_8_weeks','semi_monthly','monthly','custom','weekdays'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE subscription_loss_reason AS ENUM ('price_budget_change','moved_no_longer_needs','internal_personal','service_quality'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE subscription_pause_reason AS ENUM ('seasonal_pause','home_renovation'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE subscription_lifecycle_event_type AS ENUM ('pause','resume','notice','loss'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE subscription_no_commission_reason AS ENUM ('reactivation','marketing','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ares' 10 live commission states, in Qleno naming.
DO $$ BEGIN CREATE TYPE sales_commission_status AS ENUM
  ('earned','pending_review','approved','paid','rejected','charged_back',
   'not_eligible','on_hold','chargeback_pending','chargeback_confirmed','recouped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sales_commission_type AS ENUM ('base','sourcing_bonus','performance_bonus','specialty_bonus','frequency_adjustment'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- All 9 categories the review dropdown offers.
DO $$ BEGIN CREATE TYPE commission_ineligibility_category AS ENUM
  ('returning_90_days','returning_no_agreement','missing_agreement','cancelled_before_clean',
   'duplicate','data_error','client_initiated','previous_phes','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE commission_ledger_entry_type AS ENUM
  ('base','commercial_source_bonus','specialty_bonus','performance_bonus','adjustment','chargeback','payout');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Recurring module ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recurring_subscriptions (
  id                    serial PRIMARY KEY,
  company_id            integer NOT NULL REFERENCES companies(id),
  branch_id             integer,
  client_id             integer REFERENCES clients(id),
  recurring_schedule_id integer REFERENCES recurring_schedules(id),
  client_type           recurring_client_type NOT NULL DEFAULT 'residential',
  status                recurring_status NOT NULL DEFAULT 'active',
  cadence               recurring_cadence,
  monthly_multiplier    numeric(6,3),
  rate                  numeric(12,2),
  price_basis           recurring_price_basis NOT NULL DEFAULT 'unknown',
  -- NULL = MRR not computable. Never silently $0.
  mrr                   numeric(12,2),
  first_cleaning_date   date,
  created_at            timestamp NOT NULL DEFAULT now(),
  updated_at            timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recurring_subscriptions_company_status_idx ON recurring_subscriptions (company_id, status);
CREATE INDEX IF NOT EXISTS recurring_subscriptions_client_idx         ON recurring_subscriptions (company_id, client_id);

CREATE TABLE IF NOT EXISTS subscription_lifecycle_events (
  id                  serial PRIMARY KEY,
  company_id          integer NOT NULL REFERENCES companies(id),
  branch_id           integer,
  subscription_id     integer NOT NULL REFERENCES recurring_subscriptions(id),
  event_type          subscription_lifecycle_event_type NOT NULL,
  loss_reason         subscription_loss_reason,
  loss_date           date,
  notice_given_date   date,
  final_service_date  date,
  pause_reason        subscription_pause_reason,
  pause_end_date      date,
  original_cadence    recurring_cadence,
  original_mrr        numeric(12,2),
  attachment_url      text,
  notes               text,
  source              text NOT NULL DEFAULT 'captured',
  cancellation_log_id integer,
  created_by          integer REFERENCES users(id),
  created_at          timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscription_lifecycle_events_sub_idx ON subscription_lifecycle_events (company_id, subscription_id);

CREATE TABLE IF NOT EXISTS sales_attribution (
  id                  serial PRIMARY KEY,
  company_id          integer NOT NULL REFERENCES companies(id),
  branch_id           integer,
  subscription_id     integer NOT NULL REFERENCES recurring_subscriptions(id),
  client_id           integer REFERENCES clients(id),
  salesperson         text,
  salesperson_user_id integer REFERENCES users(id),
  subscribed_by       text,
  is_self_sourced     boolean NOT NULL DEFAULT false,
  commission_eligible boolean NOT NULL DEFAULT true,
  no_commission_reason subscription_no_commission_reason,
  created_by          integer REFERENCES users(id),
  created_at          timestamp NOT NULL DEFAULT now(),
  updated_at          timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_attribution_sub_idx ON sales_attribution (company_id, subscription_id);

-- ── Sales commission ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commission_policy (
  id                                serial PRIMARY KEY,
  company_id                        integer NOT NULL REFERENCES companies(id),
  branch_id                         integer,
  commission_rate                   numeric(6,4) NOT NULL DEFAULT 0,
  chargeback_window_days            integer NOT NULL DEFAULT 180,
  commercial_chargeback_window_days integer NOT NULL DEFAULT 0,
  chargeback_dispute_days           integer NOT NULL DEFAULT 14,
  self_sourced_bonus                numeric(12,2) NOT NULL DEFAULT 100,
  performance_bonus_amount          numeric(12,2) NOT NULL DEFAULT 100,
  performance_bonus_threshold       integer NOT NULL DEFAULT 5,
  specialty_bonus_rate              numeric(6,4) NOT NULL DEFAULT 0.05,
  payout_schedule                   text NOT NULL DEFAULT 'monthly',
  effective_date                    date NOT NULL,
  end_date                          date,
  created_at                        timestamp NOT NULL DEFAULT now(),
  updated_at                        timestamp NOT NULL DEFAULT now()
);

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
  updated_at           timestamp NOT NULL DEFAULT now(),
  CONSTRAINT commission_rate_card_uniq UNIQUE (company_id, branch_id, client_type, cadence, effective_date)
);

CREATE TABLE IF NOT EXISTS commission_payments (
  id                     serial PRIMARY KEY,
  company_id             integer NOT NULL REFERENCES companies(id),
  branch_id              integer,
  va_user_id             integer NOT NULL REFERENCES users(id),
  va_name                text,
  period_start           date NOT NULL,
  period_end             date NOT NULL,
  sales_period           text,
  total_amount           numeric(12,2) NOT NULL DEFAULT 0,
  gross_amount           numeric(12,2) NOT NULL DEFAULT 0,
  chargeback_total       numeric(12,2) NOT NULL DEFAULT 0,
  carryover_amount       numeric(12,2) NOT NULL DEFAULT 0,
  carryover_collected_at timestamp,
  item_count             integer NOT NULL DEFAULT 0,
  status                 text NOT NULL DEFAULT 'processed',
  idempotency_key        text NOT NULL,
  receipt_number         text,
  payment_method         text,
  payment_details        jsonb,
  notes                  text,
  processed_by           integer REFERENCES users(id),
  processed_at           timestamp NOT NULL DEFAULT now(),
  CONSTRAINT commission_payments_idem_uniq UNIQUE (company_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS commissions (
  id                          serial PRIMARY KEY,
  company_id                  integer NOT NULL REFERENCES companies(id),
  branch_id                   integer,
  subscription_id             integer REFERENCES recurring_subscriptions(id),
  client_id                   integer REFERENCES clients(id),
  client_name                 text,
  va_user_id                  integer NOT NULL REFERENCES users(id),
  va_name                     text,
  status                      sales_commission_status NOT NULL DEFAULT 'earned',
  commission_type             sales_commission_type NOT NULL DEFAULT 'base',
  client_type                 recurring_client_type,
  cadence                     text,
  base_amount                 numeric(12,2) NOT NULL DEFAULT 0,
  source_bonus_amount         numeric(12,2) NOT NULL DEFAULT 0,
  specialty_bonus_amount      numeric(12,2) NOT NULL DEFAULT 0,
  amount                      numeric(12,2) NOT NULL DEFAULT 0,
  specialty_service_type      text,
  revenue_amount              numeric(12,2),
  mrr_basis                   numeric(12,2),
  commission_rate             numeric(6,4),
  commission_policy_id        integer REFERENCES commission_policy(id),
  rate_card_id                integer REFERENCES commission_rate_card(id),
  earned_date                 date,
  first_cleaning_date         date,
  chargeback_until            date,
  chargeback_dispute_deadline date,
  chargeback_date             date,
  service_agreement_verified  boolean NOT NULL DEFAULT false,
  ineligibility_category      commission_ineligibility_category,
  ineligibility_reason        text,
  reactivation_date           date,
  days_inactive               integer,
  notes                       text,
  approved_by                 integer REFERENCES users(id),
  approved_at                 timestamp,
  paid_date                   date,
  payment_id                  integer REFERENCES commission_payments(id),
  created_at                  timestamp NOT NULL DEFAULT now(),
  updated_at                  timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commissions_company_status_idx   ON commissions (company_id, status);
CREATE INDEX IF NOT EXISTS commissions_va_status_idx        ON commissions (company_id, va_user_id, status);
CREATE INDEX IF NOT EXISTS commissions_first_clean_idx      ON commissions (company_id, first_cleaning_date);
CREATE INDEX IF NOT EXISTS commissions_dispute_deadline_idx ON commissions (company_id, chargeback_dispute_deadline)
  WHERE chargeback_dispute_deadline IS NOT NULL;

CREATE TABLE IF NOT EXISTS commission_status_events (
  id            serial PRIMARY KEY,
  company_id    integer NOT NULL REFERENCES companies(id),
  branch_id     integer,
  commission_id integer NOT NULL REFERENCES commissions(id),
  from_status   sales_commission_status,
  to_status     sales_commission_status NOT NULL,
  actor_user_id integer REFERENCES users(id),
  note          text,
  created_at    timestamp NOT NULL DEFAULT now()
);

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

CREATE TABLE IF NOT EXISTS commission_chargebacks (
  id                  serial PRIMARY KEY,
  company_id          integer NOT NULL REFERENCES companies(id),
  branch_id           integer,
  commission_id       integer NOT NULL REFERENCES commissions(id),
  subscription_id     integer REFERENCES recurring_subscriptions(id),
  reason              text,
  clawback_amount     numeric(12,2) NOT NULL DEFAULT 0,
  chargeback_date     date NOT NULL,
  dispute_deadline    date,
  recouped_payment_id integer REFERENCES commission_payments(id),
  recouped_at         timestamp,
  created_by          integer REFERENCES users(id),
  created_at          timestamp NOT NULL DEFAULT now()
);

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
CREATE INDEX IF NOT EXISTS subscription_cadence_history_sub_idx ON subscription_cadence_history (company_id, subscription_id);

-- ── Seed the rate card ───────────────────────────────────────────────────────
-- The rates Ares has always paid, backdated so historical lines resolve to what
-- was actually paid.
INSERT INTO commission_rate_card (company_id, branch_id, client_type, cadence, amount, effective_date)
SELECT c.id, NULL, v.t::recurring_client_type, v.cad, v.amt, DATE '2020-01-01'
  FROM companies c CROSS JOIN (VALUES
   ('residential','weekly',75),('residential','biweekly',50),('residential','semi_monthly',50),
   ('residential','every_3_weeks',30),('residential','monthly',25),('residential','every_5_weeks',20),
   ('residential','quarterly',15),
   ('commercial','weekly',100),('commercial','biweekly',100),('commercial','semi_monthly',100),
   ('commercial','every_3_weeks',50),('commercial','monthly',50),('commercial','every_5_weeks',50),
   ('commercial','quarterly',50)
  ) AS v(t,cad,amt)
ON CONFLICT ON CONSTRAINT commission_rate_card_uniq DO NOTHING;

-- NEW rates, effective from the cutover only — never backdated. Ares never
-- priced these two and its normalizer matched both to "weekly", paying $75/$100
-- for a client cleaned 6-8 times a YEAR. Past overpays are left alone.
INSERT INTO commission_rate_card (company_id, branch_id, client_type, cadence, amount, effective_date)
SELECT c.id, NULL, v.t::recurring_client_type, v.cad, v.amt, DATE '2026-08-18'
  FROM companies c CROSS JOIN (VALUES
   ('residential','every_6_weeks',20),('residential','every_8_weeks',15),
   ('commercial','every_6_weeks',50),('commercial','every_8_weeks',50)
  ) AS v(t,cad,amt)
ON CONFLICT ON CONSTRAINT commission_rate_card_uniq DO NOTHING;
