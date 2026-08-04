import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

/**
 * [recurring-uniqueness 2026-08-04] Move the "one visit per house per day" rule
 * OUT of application code and INTO the database.
 *
 * Background. Three separate fixes (#1210, #1339, #1351) each added or repaired
 * an application-level dedupe check in the recurring engine, and duplicates kept
 * coming back — 88 duplicate-day visits were created in the 14 days before this
 * migration was written. The reason is structural: the ONLY unique index the
 * jobs table carried was
 *
 *     jobs_recurring_dedupe_idx (company_id, recurring_schedule_id, scheduled_date)
 *
 * which stops ONE schedule double-booking a day and does nothing when SIX
 * DIFFERENT schedules each book the same house on the same day. That is exactly
 * what happened to Kathryn Galley (client 1226): six active biweekly schedules,
 * all converging on 2026-10-29, six visits on the dispatch board. Every
 * client-level protection was a best-effort SELECT in the engine, and a
 * best-effort SELECT is only as good as the last person who edited it.
 *
 * Two guarantees, enforced by Postgres:
 *   1. jobs      — an ENGINE-CREATED recurring visit is unique per target per
 *                  day. Manual office visits (recurring_schedule_id IS NULL) are
 *                  deliberately NOT covered: the office must stay free to add a
 *                  second visit to a house by hand. Cancelled rows are excluded
 *                  so a cancelled slot can be re-booked.
 *   2. recurring_schedules — one ACTIVE schedule per target. This kills the
 *                  proliferation at its source (see findActiveScheduleForTarget
 *                  in lib/recurring-tombstone.ts).
 *
 * The engine's insert is `.onConflictDoNothing()` with NO conflict target, so it
 * already covers any unique index on jobs: a blocked duplicate is counted as a
 * dedupe skip and the run continues. No engine change is required.
 *
 * "target" = a residential client, or an account + PROPERTY. Never an account
 * alone — one account legitimately runs many buildings on their own cadences
 * (Daniel Walter, KMA, Cucci). account_property_id is COALESCEd because NULLs
 * compare as distinct in a unique index, which would let two NULL-property rows
 * through.
 *
 * FAILURE IS NOT SILENT. If pre-existing duplicates block index creation this
 * logs the offending rows under a [recurring-uniqueness] marker and rethrows.
 * A boot migration whose failure gets swallowed as "non-fatal" is how
 * invoice_job_links shipped empty to production (#1349 → #1352); an index that
 * quietly fails to create would leave the exact hole this migration exists to
 * close, while reading as done.
 */

type IndexSpec = { name: string; table: string; ddl: string; dupeProbe: string };

const INDEXES: IndexSpec[] = [
  {
    name: "jobs_recurring_one_per_client_day",
    table: "jobs",
    ddl: `
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_recurring_one_per_client_day
        ON jobs (company_id, client_id, scheduled_date)
       WHERE recurring_schedule_id IS NOT NULL
         AND client_id IS NOT NULL
         AND status <> 'cancelled'::job_status
    `,
    dupeProbe: `
      SELECT company_id, client_id, scheduled_date::text AS d, count(*) AS n,
             array_agg(id ORDER BY id) AS ids
        FROM jobs
       WHERE recurring_schedule_id IS NOT NULL
         AND client_id IS NOT NULL
         AND status <> 'cancelled'::job_status
       GROUP BY 1,2,3 HAVING count(*) > 1
       ORDER BY n DESC LIMIT 20
    `,
  },
  {
    name: "jobs_recurring_one_per_property_day",
    table: "jobs",
    ddl: `
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_recurring_one_per_property_day
        ON jobs (company_id, account_id, COALESCE(account_property_id, -1), scheduled_date)
       WHERE recurring_schedule_id IS NOT NULL
         AND account_id IS NOT NULL
         AND status <> 'cancelled'::job_status
    `,
    dupeProbe: `
      SELECT company_id, account_id, COALESCE(account_property_id, -1) AS prop,
             scheduled_date::text AS d, count(*) AS n, array_agg(id ORDER BY id) AS ids
        FROM jobs
       WHERE recurring_schedule_id IS NOT NULL
         AND account_id IS NOT NULL
         AND status <> 'cancelled'::job_status
       GROUP BY 1,2,3,4 HAVING count(*) > 1
       ORDER BY n DESC LIMIT 20
    `,
  },
  {
    name: "recurring_schedules_one_active_per_client",
    table: "recurring_schedules",
    ddl: `
      CREATE UNIQUE INDEX IF NOT EXISTS recurring_schedules_one_active_per_client
        ON recurring_schedules (company_id, customer_id)
       WHERE is_active AND account_id IS NULL AND customer_id IS NOT NULL
    `,
    dupeProbe: `
      SELECT company_id, customer_id, count(*) AS n, array_agg(id ORDER BY id) AS ids
        FROM recurring_schedules
       WHERE is_active AND account_id IS NULL AND customer_id IS NOT NULL
       GROUP BY 1,2 HAVING count(*) > 1
       ORDER BY n DESC LIMIT 20
    `,
  },
  {
    name: "recurring_schedules_one_active_per_property",
    table: "recurring_schedules",
    ddl: `
      CREATE UNIQUE INDEX IF NOT EXISTS recurring_schedules_one_active_per_property
        ON recurring_schedules (company_id, account_id, COALESCE(account_property_id, -1))
       WHERE is_active AND account_id IS NOT NULL
    `,
    dupeProbe: `
      SELECT company_id, account_id, COALESCE(account_property_id, -1) AS prop,
             count(*) AS n, array_agg(id ORDER BY id) AS ids
        FROM recurring_schedules
       WHERE is_active AND account_id IS NOT NULL
       GROUP BY 1,2,3 HAVING count(*) > 1
       ORDER BY n DESC LIMIT 20
    `,
  },
];

export async function ensureRecurringUniqueness(): Promise<void> {
  const failures: string[] = [];

  for (const spec of INDEXES) {
    const already = await db.execute(sql`
      SELECT 1 FROM pg_indexes WHERE indexname = ${spec.name} LIMIT 1
    `);
    if (already.rows.length > 0) continue;

    try {
      await db.execute(sql.raw(spec.ddl));
      console.log(`[recurring-uniqueness] created ${spec.name}`);
    } catch (err: any) {
      // Almost always 23505 — rows already violate the rule. Name them so the
      // cleanup is a lookup, not an investigation.
      failures.push(spec.name);
      console.error(
        `[recurring-uniqueness] FAILED to create ${spec.name} on ${spec.table}: ${err?.message ?? err}`,
      );
      try {
        const dupes = await db.execute(sql.raw(spec.dupeProbe));
        console.error(
          `[recurring-uniqueness] ${dupes.rows.length} blocking group(s) — the duplicates that must be cleaned first:`,
        );
        for (const r of dupes.rows as any[]) {
          console.error(`[recurring-uniqueness]   ${JSON.stringify(r)}`);
        }
      } catch {
        /* probe is diagnostic only — never let it mask the real error */
      }
    }
  }

  if (failures.length > 0) {
    // Rethrow. The caller logs this as "non-fatal" and the app still boots, but
    // the failure is LOUD and names the indexes that are missing. Silent success
    // on a protection migration is worse than a noisy failure.
    throw new Error(
      `[recurring-uniqueness] ${failures.length} uniqueness index(es) NOT created: ${failures.join(", ")}. ` +
      `Duplicate visits/schedules are UNPROTECTED until the blocking rows above are cleaned and the app restarts.`,
    );
  }
}
