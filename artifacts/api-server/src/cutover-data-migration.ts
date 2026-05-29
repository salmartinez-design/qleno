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
