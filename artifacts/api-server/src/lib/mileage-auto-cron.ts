/**
 * [mileage-auto 2026-07-08] Nightly mileage auto-compute.
 *
 * The mileage ENGINE (On My Way → clock-sequence → scheduled failsafe) has
 * existed since cutover 2A, but nothing ever TRIGGERED it — no cron, no button —
 * so `mileage_legs` were essentially never generated and payroll showed $0
 * (Sal: "none of the mileage was calculated... this should already have been
 * happening on its own"). This cron is the missing trigger.
 *
 * What it does each night (and once at boot): for every mileage-enabled tenant
 * (any company with a mileage_rates row), make sure the current week has an OPEN
 * pay period, then recompute mileage for every open period whose window is
 * recent. Recompute is idempotent (ON CONFLICT DO NOTHING on every leg source)
 * and cheap (distance_cache means only new address pairs hit the mapping API).
 *
 * It ONLY computes. Legs land status='computed' — the office still reviews and
 * applies them at the 2B gate before a dollar moves. Gated by
 * MILEAGE_AUTO_COMPUTE_ENABLED (default ON; set to "off" in Railway to kill it).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { computeAllMileageForPeriod } from "../routes/pay.js";

/** Today's date in America/Chicago as YYYY-MM-DD. */
function ctToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Sunday..Saturday window (YYYY-MM-DD) containing the given CT date. */
function weekOf(ctDate: string): { start: string; end: string } {
  const d = new Date(`${ctDate}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - dow);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/**
 * Resolve the pay period mileage should attach to for `today`. Prefer an
 * existing OPEN period that contains today (so we never duplicate the office's
 * own period); otherwise create a Sun..Sat open period. Returns null if a
 * containing period exists but is locked/approved (leave it alone).
 */
async function ensureOpenPeriodForToday(companyId: number, today: string): Promise<number | null> {
  const containing = (await db.execute(sql`
    SELECT id, status FROM pay_periods
     WHERE company_id = ${companyId}
       AND start_date <= ${today} AND end_date >= ${today}
     ORDER BY start_date DESC
     LIMIT 1
  `)).rows as any[];
  if (containing.length) {
    return containing[0].status === "open" ? Number(containing[0].id) : null;
  }
  const { start, end } = weekOf(today);
  // created_by_user_id is NOT NULL — a system-created period is attributed to
  // the tenant's owner (fallback: any user in the tenant). If the tenant has no
  // users, we can't create a period; bail.
  const creatorRows = (await db.execute(sql`
    SELECT id FROM users
     WHERE company_id = ${companyId}
     ORDER BY (role = 'owner') DESC, id ASC
     LIMIT 1
  `)).rows as any[];
  if (!creatorRows.length) return null;
  const creatorId = Number(creatorRows[0].id);
  // Create the current week's open period. Unique on (company,start,end) — a
  // race/re-run collapses to the existing row, which we then re-select.
  await db.execute(sql`
    INSERT INTO pay_periods (company_id, start_date, end_date, status, created_by_user_id, created_at, updated_at)
    VALUES (${companyId}, ${start}, ${end}, 'open', ${creatorId}, now(), now())
    ON CONFLICT DO NOTHING
  `);
  const created = (await db.execute(sql`
    SELECT id, status FROM pay_periods
     WHERE company_id = ${companyId} AND start_date = ${start} AND end_date = ${end}
     LIMIT 1
  `)).rows as any[];
  if (!created.length) return null;
  return created[0].status === "open" ? Number(created[0].id) : null;
}

/**
 * Run the auto-compute for one tenant (or all mileage-enabled tenants when
 * companyId is omitted). Computes the current-week open period plus any other
 * still-open period ending within the last ~10 days (catches late clock edits
 * to a week that hasn't been locked yet).
 */
export async function runMileageAutoCompute(
  companyId?: number,
): Promise<{ companies: number; periods: number; inserted: number }> {
  const today = ctToday();
  const cutoff = new Date(`${today}T12:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 10);
  const recentSince = cutoff.toISOString().slice(0, 10);

  // Mileage-enabled tenants = those with at least one dated rate row.
  const companyRows = (await db.execute(
    companyId != null
      ? sql`SELECT DISTINCT company_id FROM mileage_rates WHERE company_id = ${companyId}`
      : sql`SELECT DISTINCT company_id FROM mileage_rates`,
  )).rows as any[];

  let periods = 0;
  let inserted = 0;
  for (const row of companyRows) {
    const cid = Number(row.company_id);
    try {
      await ensureOpenPeriodForToday(cid, today);
      // Every open period whose window is recent — includes the one we just
      // ensured plus any prior week still open.
      const open = (await db.execute(sql`
        SELECT id, start_date::text AS start_date, end_date::text AS end_date
          FROM pay_periods
         WHERE company_id = ${cid} AND status = 'open' AND end_date >= ${recentSince}
         ORDER BY start_date
      `)).rows as any[];
      for (const p of open) {
        try {
          const r = await computeAllMileageForPeriod(cid, Number(p.id), String(p.start_date), String(p.end_date));
          inserted += r.inserted;
          periods += 1;
        } catch (e) {
          console.error(`[mileage-auto] compute failed company=${cid} period=${p.id}:`, e);
        }
      }
    } catch (e) {
      console.error(`[mileage-auto] company ${cid} failed:`, e);
    }
  }
  return { companies: companyRows.length, periods, inserted };
}
