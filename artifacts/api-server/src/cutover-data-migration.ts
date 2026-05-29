/**
 * Cutover data migrations.
 *
 * Runs once per cold start (idempotent). Mirrors phes-data-migration's
 * pattern but scoped to the MaidCentral cutover pieces (1A onward).
 *
 * Currently does ONE thing — installs the integrity CHECK constraint
 * on job_clock_events (1C). The constraint is the legal backbone of
 * the wage record; without it the route layer would be the only line
 * of defense and a future direct-INSERT (admin tool, script, migration
 * helper) could silently produce a bad row. With it, the bad shape is
 * rejected by the database itself.
 *
 * The constraint name + SQL text come from the schema file so the
 * runtime SQL and the test assertion read the same string.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_NAME,
  JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_SQL,
} from "@workspace/db/schema";

export async function runCutoverDataMigration(): Promise<void> {
  try {
    await runClockEventsIntegrityConstraint();
  } catch (err) {
    console.error("[cutover-migration] failed (non-fatal):", err);
  }
  try {
    await runMileageAdjustmentUniqueIndex();
  } catch (err) {
    console.error("[cutover-migration] mileage idx failed (non-fatal):", err);
  }
}

/**
 * Cutover 2A — partial unique index on
 * (company_id, source_on_my_way_event_id) WHERE
 * adjustment_type = 'mileage' AND source_on_my_way_event_id IS NOT NULL.
 *
 * Stops a recompute from double-writing the same leg as two mileage
 * adjustment rows. Drizzle-kit cannot express partial uniqueness
 * directly, so we install it via runtime SQL with the same idempotent
 * pattern as the CHECK constraint above.
 */
const MILEAGE_ADJUSTMENT_UNIQUE_INDEX_NAME =
  "pay_adjustments_mileage_source_uq";

async function runMileageAdjustmentUniqueIndex(): Promise<void> {
  await db.execute(sql.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'pay_adjustments'
      ) THEN
        RAISE NOTICE 'cutover-migration: pay_adjustments not present yet, skipping mileage idx';
        RETURN;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'pay_adjustments'
          AND column_name = 'source_on_my_way_event_id'
      ) THEN
        RAISE NOTICE 'cutover-migration: source_on_my_way_event_id column not present yet, skipping mileage idx';
        RETURN;
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = '${MILEAGE_ADJUSTMENT_UNIQUE_INDEX_NAME}'
      ) THEN
        RAISE NOTICE 'cutover-migration: mileage idx already present';
        RETURN;
      END IF;
      EXECUTE 'CREATE UNIQUE INDEX ${MILEAGE_ADJUSTMENT_UNIQUE_INDEX_NAME} ON pay_adjustments (company_id, source_on_my_way_event_id) WHERE adjustment_type = ''mileage'' AND source_on_my_way_event_id IS NOT NULL';
      RAISE NOTICE 'cutover-migration: installed ${MILEAGE_ADJUSTMENT_UNIQUE_INDEX_NAME}';
    END
    $$;
  `));
}

export { MILEAGE_ADJUSTMENT_UNIQUE_INDEX_NAME };

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
  // Skip when the table is not yet provisioned (drizzle-kit push hasn't
  // run for this deploy). The DO block guards both lookups.
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
