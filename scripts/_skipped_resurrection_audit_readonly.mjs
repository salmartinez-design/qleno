// Skipped-service resurrection audit — READ ONLY, never writes.
//
// Answers one question: are there jobs sitting on the board whose date the
// office explicitly SKIPPED? That is the "skipped services are being restored
// to the schedule" complaint (Francisco, 7/30), stated as a query.
//
// ROOT CAUSE (fixed 2026-07-30): computeOccurrencesForSchedule read the skip
// list off the schedule OBJECT it was handed — `schedule.skipped_dates ?? []`.
// The nightly engine and /recurring load schedules via Drizzle (full row), so
// they honoured it. But the two cascade paths in routes/jobs.ts — the ones that
// run when the office edits a recurring job with "this and future" — loaded the
// schedule with a hand-written column list that never included skipped_dates.
// There the `?? []` produced an EMPTY skip set and the generator recreated every
// skipped date inside the 90-day horizon. `as any` meant TypeScript could not
// see the missing column. That is why it looked intermittent and kept coming
// back: nothing was wrong with the nightly run, so a skip held for days — until
// somebody edited that client's job.
//
// The generator now re-reads skipped_dates from the database by id, so no call
// site can defeat it. This script is the standing check that it stayed fixed:
// run it any time. A clean result means no skip has been overridden.
//
// Usage (repo root, .env holding DATABASE_URL):
//   node scripts/_skipped_resurrection_audit_readonly.mjs
//   node scripts/_skipped_resurrection_audit_readonly.mjs --client "Rone Tempest"
import pg from "pg";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const clientFilter = args.includes("--client") ? args[args.indexOf("--client") + 1] : null;
const ENV_PATH = process.env.QLENO_ENV ?? ".env";

const env = readFileSync(ENV_PATH, "utf8");
const line = env.split("\n").find((l) => l.startsWith("DATABASE_URL="));
if (!line) {
  console.error(`No DATABASE_URL in ${ENV_PATH}. Set QLENO_ENV to point at the right .env.`);
  process.exit(1);
}
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

console.log("=== Skipped-service resurrection audit (READ ONLY) ===\n");

// A resurrection = a LIVE job (not cancelled) whose cadence date appears in its
// schedule's skipped_dates. Matched on COALESCE(occurrence_date, scheduled_date)
// — the same key both the engine's dedup and the skip tombstone use — and also
// on scheduled_date, to catch a job that was moved off its slot after the fact.
//
// Checked two ways, because a resurrected job may have lost its link:
//   A. linked   — jobs.recurring_schedule_id points at the schedule
//   B. unlinked — recurring_schedule_id IS NULL (the MaidCentral-import norm),
//                 matched back to the client's / account's schedule the same
//                 way routes/cancellation.ts resolves it
const sql = `
WITH skips AS (
  SELECT rs.id AS schedule_id, rs.company_id, rs.customer_id, rs.account_id,
         rs.account_property_id, unnest(rs.skipped_dates)::date AS skipped_on
    FROM recurring_schedules rs
   WHERE rs.skipped_dates IS NOT NULL AND array_length(rs.skipped_dates, 1) > 0
)
SELECT s.schedule_id,
       s.skipped_on::text                              AS skipped_date,
       j.id                                            AS job_id,
       j.status,
       j.scheduled_date::text                          AS scheduled_date,
       j.occurrence_date::text                         AS occurrence_date,
       j.recurring_schedule_id,
       CASE WHEN j.recurring_schedule_id IS NULL THEN 'unlinked' ELSE 'linked' END AS link,
       COALESCE(cl.name, a.name)                       AS client,
       j.created_at
  FROM skips s
  JOIN jobs j
    ON j.company_id = s.company_id
   AND j.status <> 'cancelled'
   AND (COALESCE(j.occurrence_date, j.scheduled_date) = s.skipped_on
        OR j.scheduled_date = s.skipped_on)
   AND (
        j.recurring_schedule_id = s.schedule_id
        OR (j.recurring_schedule_id IS NULL
            AND ((s.account_id IS NOT NULL
                  AND j.account_id = s.account_id
                  AND j.account_property_id IS NOT DISTINCT FROM s.account_property_id)
              OR (s.account_id IS NULL AND j.client_id = s.customer_id)))
       )
  LEFT JOIN clients  cl ON cl.id = j.client_id
  LEFT JOIN accounts a  ON a.id = j.account_id
 ${clientFilter ? "WHERE COALESCE(cl.name, a.name) ILIKE $1" : ""}
 ORDER BY j.scheduled_date, j.id
`;

const rows = (await c.query(sql, clientFilter ? [`%${clientFilter}%`] : [])).rows;

if (!rows.length) {
  console.log(
    clientFilter
      ? `No resurrected skips for clients matching "${clientFilter}".`
      : "No resurrected skips. Every skipped date is still empty on the board.",
  );
} else {
  console.log(`RESURRECTED SKIPS: ${rows.length}\n`);
  console.table(rows);
  console.log(
    "\nEach row is a live job on a date the office skipped.\n" +
    "`created_at` tells you WHEN it came back — compare it against the skip to\n" +
    "see whether it predates the 2026-07-30 fix (historical residue, delete by\n" +
    "hand) or postdates it (a live regression — capture this output).",
  );
}

// Context: how much skip history exists at all. A company with zero skipped_dates
// would make a clean result above meaningless, so state it plainly.
const cov = (await c.query(
  `SELECT COUNT(*)::int AS schedules_with_skips,
          COALESCE(SUM(array_length(skipped_dates, 1)), 0)::int AS total_skipped_dates
     FROM recurring_schedules
    WHERE skipped_dates IS NOT NULL AND array_length(skipped_dates, 1) > 0`,
)).rows[0];
console.log(
  `\nCoverage: ${cov.total_skipped_dates} skipped date(s) recorded across ` +
  `${cov.schedules_with_skips} schedule(s). If this is 0, the audit above proves nothing — ` +
  `it would mean skips are not being RECORDED, a different failure from being overridden.`,
);

await c.end();
