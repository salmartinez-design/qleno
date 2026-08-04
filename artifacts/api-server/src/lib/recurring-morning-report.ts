import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

/**
 * [morning-report 2026-08-04] The nightly recurring run used to leave no trace
 * anyone would ever read. 88 duplicate visits were created across 14 days — 27
 * on 7/27, 17 on 8/1, 27 on 8/3 — and the office found out from the dispatch
 * board, one client at a time, weeks later. Everything the engine did was in the
 * Railway logs and nowhere else.
 *
 * This runs immediately after the 2 AM generation and answers three questions
 * the office actually asks:
 *   - what did last night create?
 *   - what did it refuse to create, and why?
 *   - is anything double-booked right now?
 *
 * When something is wrong it writes a `recurring_report` notification into the
 * office feed — the same channel as the "Unassigned Job" alerts, so it lands
 * somewhere people already look, not in a log nobody tails. When the night is
 * clean it stays silent and only logs, so the feed doesn't become noise the
 * office learns to scroll past.
 *
 * The duplicate counts SHOULD be permanently zero now that the uniqueness
 * indexes exist (lib/recurring-uniqueness-migrate.ts). A nonzero count means an
 * index is missing — which is exactly the failure this report is here to catch,
 * since a missing index is silent by nature.
 */

export type MorningReport = {
  company_id: number;
  date: string;
  created_last_night: number;
  blocked_as_duplicate: number;
  duplicate_days_now: number;
  duplicate_visits_now: number;
  schedules_active: number;
  targets_with_two_schedules: number;
  missing_indexes: string[];
  detail: Array<{ who: string; date: string; count: number }>;
};

const REQUIRED_INDEXES = [
  "jobs_recurring_one_per_client_day",
  "jobs_recurring_one_per_property_day",
  "recurring_schedules_one_active_per_client",
  "recurring_schedules_one_active_per_property",
];

export async function buildMorningReport(
  companyId: number,
  runResult?: { jobs_created?: number; skipped_duplicates?: number } | null,
): Promise<MorningReport> {
  const clientName = sql`COALESCE(NULLIF(TRIM(cl.company_name),''), TRIM(COALESCE(cl.first_name,'')||' '||COALESCE(cl.last_name,'')))`;

  // Duplicates as the office sees them: two live recurring visits, same house,
  // same day. Residential and account/property counted separately because the
  // "house" key is different — an account can legitimately run many buildings.
  const dupClients = await db.execute(sql`
    SELECT ${clientName} AS who, j.scheduled_date::text AS d, count(*)::int AS n
      FROM jobs j JOIN clients cl ON cl.id = j.client_id
     WHERE j.company_id = ${companyId}
       AND j.recurring_schedule_id IS NOT NULL
       AND j.client_id IS NOT NULL
       AND j.status <> 'cancelled'
       AND j.scheduled_date >= CURRENT_DATE
     GROUP BY 1, 2 HAVING count(*) > 1
     ORDER BY 2 LIMIT 50
  `);

  const dupProps = await db.execute(sql`
    SELECT COALESCE(ap.property_name, ac.account_name, 'account ' || j.account_id::text) AS who,
           j.scheduled_date::text AS d, count(*)::int AS n
      FROM jobs j
      LEFT JOIN accounts ac ON ac.id = j.account_id
      LEFT JOIN account_properties ap ON ap.id = j.account_property_id
     WHERE j.company_id = ${companyId}
       AND j.recurring_schedule_id IS NOT NULL
       AND j.account_id IS NOT NULL
       AND j.status <> 'cancelled'
       AND j.scheduled_date >= CURRENT_DATE
     GROUP BY 1, 2, j.account_id HAVING count(*) > 1
     ORDER BY 2 LIMIT 50
  `);

  const detail = [...dupClients.rows, ...dupProps.rows].map((r: any) => ({
    who: String(r.who || "").trim() || "(unnamed)",
    date: String(r.d),
    count: Number(r.n),
  }));

  // A target holding two active schedules is the UPSTREAM cause — it precedes
  // the visible double-booking by days, so it's the number worth alarming on.
  const twoSchedules = await db.execute(sql`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM recurring_schedules
       WHERE company_id = ${companyId} AND is_active
         AND account_id IS NULL AND customer_id IS NOT NULL
       GROUP BY customer_id HAVING count(*) > 1
      UNION ALL
      SELECT 1 FROM recurring_schedules
       WHERE company_id = ${companyId} AND is_active AND account_id IS NOT NULL
       GROUP BY account_id, COALESCE(account_property_id, -1) HAVING count(*) > 1
    ) t
  `);

  const active = await db.execute(sql`
    SELECT count(*)::int AS n FROM recurring_schedules
     WHERE company_id = ${companyId} AND is_active
  `);

  const createdLastNight = await db.execute(sql`
    SELECT count(*)::int AS n FROM jobs
     WHERE company_id = ${companyId}
       AND recurring_schedule_id IS NOT NULL
       AND created_at >= CURRENT_DATE - INTERVAL '1 day'
  `);

  // The indexes are the protection. If one is missing the whole guarantee is
  // off, and nothing else in the system would say so out loud.
  const present = await db.execute(sql`SELECT indexname FROM pg_indexes`);
  const have = new Set((present.rows as any[]).map((r) => String(r.indexname)));
  const missing = REQUIRED_INDEXES.filter((n) => !have.has(n));

  return {
    company_id: companyId,
    date: new Date().toISOString().slice(0, 10),
    created_last_night: runResult?.jobs_created ?? Number((createdLastNight.rows[0] as any)?.n ?? 0),
    blocked_as_duplicate: runResult?.skipped_duplicates ?? 0,
    duplicate_days_now: detail.length,
    duplicate_visits_now: detail.reduce((s, d) => s + (d.count - 1), 0),
    schedules_active: Number((active.rows[0] as any)?.n ?? 0),
    targets_with_two_schedules: Number((twoSchedules.rows[0] as any)?.n ?? 0),
    missing_indexes: missing,
    detail,
  };
}

/** Build the report, log it, and alert the office only when something is wrong. */
export async function runMorningReport(
  companyId: number,
  runResult?: { jobs_created?: number; skipped_duplicates?: number } | null,
): Promise<MorningReport | null> {
  let rep: MorningReport;
  try {
    rep = await buildMorningReport(companyId, runResult);
  } catch (err: any) {
    console.error(`[morning-report] company ${companyId} — failed to build:`, err?.message ?? err);
    return null;
  }

  console.log(
    `[morning-report] co${companyId} ${rep.date} — created ${rep.created_last_night}, ` +
    `blocked-as-duplicate ${rep.blocked_as_duplicate}, active schedules ${rep.schedules_active}, ` +
    `double-booked days ${rep.duplicate_days_now} (${rep.duplicate_visits_now} extra visits), ` +
    `houses with 2 schedules ${rep.targets_with_two_schedules}` +
    (rep.missing_indexes.length ? `, MISSING INDEXES: ${rep.missing_indexes.join(", ")}` : ""),
  );

  const broken =
    rep.duplicate_days_now > 0 ||
    rep.targets_with_two_schedules > 0 ||
    rep.missing_indexes.length > 0;
  if (!broken) return rep;

  const lines: string[] = [];
  if (rep.duplicate_days_now > 0) {
    lines.push(`${rep.duplicate_visits_now} extra visit(s) across ${rep.duplicate_days_now} day(s).`);
    for (const d of rep.detail.slice(0, 8)) lines.push(`${d.date} — ${d.who} booked ${d.count} times`);
    if (rep.detail.length > 8) lines.push(`...and ${rep.detail.length - 8} more`);
  }
  if (rep.targets_with_two_schedules > 0) {
    lines.push(`${rep.targets_with_two_schedules} customer(s) have more than one repeating schedule running.`);
  }
  if (rep.missing_indexes.length > 0) {
    lines.push(`Duplicate protection is NOT active — missing: ${rep.missing_indexes.join(", ")}.`);
  }

  try {
    await db.execute(sql`
      INSERT INTO notifications (company_id, type, title, body, link, meta)
      VALUES (
        ${companyId}, 'recurring_report',
        ${`Repeating schedule check — ${rep.duplicate_visits_now} duplicate visit(s)`},
        ${lines.join("\n")}, ${"/dispatch"}, ${JSON.stringify(rep)}::jsonb
      )
    `);
  } catch (err: any) {
    console.error(`[morning-report] could not write notification:`, err?.message ?? err);
  }
  return rep;
}
