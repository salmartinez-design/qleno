import { db } from "@workspace/db";
import { efficiencyEntriesTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";

// Resolve a completed job's service_type → the Qleno package name efficiency is
// keyed to. Commercial: service_type enum === commercial_service_types.slug.
// Residential: explicit map; standard_clean splits by recurrence. Returns null
// for non-scored scopes (carpet, hourly, anything not in the 12-package catalog).
export function resolvePackage(
  serviceType: string,
  isRecurring: boolean,
  commercialNameBySlug: ReadonlyMap<string, string>,
): string | null {
  const st = (serviceType || "").toLowerCase();
  if (commercialNameBySlug.has(st)) return commercialNameBySlug.get(st)!;
  switch (st) {
    case "deep_clean":
    case "move_in":
    case "move_out":
      return "Deep Clean or Move In/Out";
    case "recurring":
      return "Recurring Cleaning";
    case "standard_clean":
      return isRecurring ? "Recurring Cleaning" : "One-Time Flat-Rate Standard Cleaning";
    default:
      return null;
  }
}

const RECURRING_FREQUENCIES = new Set(["weekly", "biweekly", "bi-weekly", "every_2_weeks", "every_4_weeks", "monthly", "quarterly", "custom_days", "weekdays", "daily"]);
function jobIsRecurring(frequency: string | null, recurringScheduleId: number | null): boolean {
  if (recurringScheduleId != null) return true;
  const f = (frequency || "").toLowerCase();
  return RECURRING_FREQUENCIES.has(f);
}

async function commercialMap(companyId: number): Promise<Map<string, string>> {
  const r = await db.execute(sql`SELECT slug, name FROM commercial_service_types WHERE company_id = ${companyId} AND is_active = true`);
  return new Map((r.rows as any[]).map(x => [String(x.slug).toLowerCase(), String(x.name)]));
}

// Recompute the hours-weighted qleno rollup for one (employee, package):
// efficiency_pct = 100 × Σ allowed_share ÷ Σ actual_hours over that employee's
// qleno efficiency_entries for the package. Upserts employee_efficiency.
async function rollupEmployeePackage(companyId: number, employeeId: number, pkg: string): Promise<void> {
  const agg = await db.execute(sql`
    SELECT SUM(allowed_share)::numeric AS a, SUM(actual_hours)::numeric AS h
      FROM efficiency_entries
     WHERE company_id = ${companyId} AND employee_id = ${employeeId} AND package = ${pkg} AND source = 'qleno'
  `);
  const row: any = agg.rows[0];
  const a = row?.a != null ? parseFloat(row.a) : 0;
  const h = row?.h != null ? parseFloat(row.h) : 0;
  if (h <= 0) return;
  const pct = Math.round((100 * a / h) * 100) / 100;
  await db.execute(sql`
    INSERT INTO employee_efficiency (company_id, employee_id, service_type, efficiency_pct, source, period, updated_at)
    VALUES (${companyId}, ${employeeId}, ${pkg}, ${String(pct)}, 'qleno', 'all_time', NOW())
    ON CONFLICT (company_id, employee_id, service_type, period)
    DO UPDATE SET efficiency_pct = ${String(pct)}, source = 'qleno', updated_at = NOW()
  `);
}

// Compute + persist per-(job,tech) efficiency for ONE completed job, then refresh
// the affected (employee, package) rollups. Idempotent (upserts by job+employee).
// Returns the number of per-tech entries written. Non-fatal on bad data (skips).
export async function recomputeJobEfficiency(jobId: number, companyId: number): Promise<number> {
  const jr = await db.execute(sql`
    SELECT id, service_type, frequency, recurring_schedule_id, allowed_hours, scheduled_date, status
      FROM jobs WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1
  `);
  const job: any = jr.rows[0];
  if (!job || job.status !== "complete") return 0;
  const allowed = job.allowed_hours != null ? parseFloat(job.allowed_hours) : 0;
  if (!Number.isFinite(allowed) || allowed <= 0) return 0;

  const cmap = await commercialMap(companyId);
  const pkg = resolvePackage(job.service_type, jobIsRecurring(job.frequency, job.recurring_schedule_id), cmap);
  if (!pkg) return 0;

  // Per-tech clocked hours from punched timeclock entries (same basis as pay).
  const hr = await db.execute(sql`
    SELECT user_id, SUM(EXTRACT(EPOCH FROM (clock_out_at - clock_in_at)) / 3600.0)::numeric AS hours
      FROM timeclock
     WHERE company_id = ${companyId} AND job_id = ${jobId}
       AND clock_out_at IS NOT NULL AND source = 'punched'
     GROUP BY user_id
  `);
  const techHours = (hr.rows as any[])
    .map(r => ({ user_id: Number(r.user_id), hours: parseFloat(r.hours) }))
    .filter(t => Number.isFinite(t.hours) && t.hours > 0);
  const total = techHours.reduce((s, t) => s + t.hours, 0);
  if (total <= 0) return 0;

  const entryDate = String(job.scheduled_date).slice(0, 10);
  const affected: number[] = [];
  for (const t of techHours) {
    const allowedShare = allowed * (t.hours / total);
    const ratio = Math.round((100 * allowedShare / t.hours) * 100) / 100; // = 100×allowed/total
    await db.execute(sql`
      INSERT INTO efficiency_entries (company_id, employee_id, job_id, package, allowed_share, actual_hours, ratio, source, entry_date)
      VALUES (${companyId}, ${t.user_id}, ${jobId}, ${pkg}, ${String(allowedShare.toFixed(3))}, ${String(t.hours.toFixed(3))}, ${String(ratio)}, 'qleno', ${entryDate})
      ON CONFLICT (job_id, employee_id)
      DO UPDATE SET package = ${pkg}, allowed_share = ${String(allowedShare.toFixed(3))},
                    actual_hours = ${String(t.hours.toFixed(3))}, ratio = ${String(ratio)}, entry_date = ${entryDate}
    `);
    affected.push(t.user_id);
  }
  for (const uid of affected) await rollupEmployeePackage(companyId, uid, pkg);
  return affected.length;
}

// Backfill: recompute qleno efficiency from every completed job for a company.
// Batched/set-based (a handful of queries, not per-job round-trips) so it
// completes well within the HTTP proxy window even at thousands of jobs.
// Returns { jobs_scanned, entries_written }.
export async function recomputeAllEfficiency(companyId: number): Promise<{ jobs_scanned: number; entries_written: number }> {
  const cmap = await commercialMap(companyId);

  const jr = await db.execute(sql`
    SELECT id, service_type, frequency, recurring_schedule_id,
           allowed_hours::numeric AS allowed, scheduled_date::text AS dt
      FROM jobs
     WHERE company_id = ${companyId} AND status = 'complete'
       AND allowed_hours IS NOT NULL AND allowed_hours::numeric > 0
  `);
  const jobs = jr.rows as any[];
  if (!jobs.length) return { jobs_scanned: 0, entries_written: 0 };
  const jobIds = jobs.map(j => Number(j.id));

  // All per-(job,tech) clocked hours in ONE grouped query.
  const hr = await db.execute(sql`
    SELECT job_id, user_id, SUM(EXTRACT(EPOCH FROM (clock_out_at - clock_in_at)) / 3600.0)::numeric AS hours
      FROM timeclock
     WHERE company_id = ${companyId} AND job_id = ANY(${jobIds}::int[])
       AND clock_out_at IS NOT NULL AND source = 'punched'
     GROUP BY job_id, user_id
  `);
  const byJob = new Map<number, Array<{ user: number; hours: number }>>();
  for (const r of hr.rows as any[]) {
    const h = parseFloat(r.hours);
    if (!Number.isFinite(h) || h <= 0) continue;
    const jid = Number(r.job_id);
    if (!byJob.has(jid)) byJob.set(jid, []);
    byJob.get(jid)!.push({ user: Number(r.user_id), hours: h });
  }

  const rows: any[] = [];
  for (const j of jobs) {
    const techs = byJob.get(Number(j.id));
    if (!techs || !techs.length) continue;
    const isRec = j.recurring_schedule_id != null || RECURRING_FREQUENCIES.has(String(j.frequency || "").toLowerCase());
    const pkg = resolvePackage(j.service_type, isRec, cmap);
    if (!pkg) continue;
    const allowed = parseFloat(j.allowed);
    const total = techs.reduce((s, t) => s + t.hours, 0);
    if (!(allowed > 0) || total <= 0) continue;
    const dt = String(j.dt).slice(0, 10);
    for (const t of techs) {
      const share = allowed * (t.hours / total);
      const ratio = Math.round((100 * share / t.hours) * 100) / 100;
      rows.push({
        company_id: companyId, employee_id: t.user, job_id: Number(j.id), package: pkg,
        allowed_share: share.toFixed(3), actual_hours: t.hours.toFixed(3),
        ratio: String(ratio), source: "qleno", entry_date: dt,
      });
    }
  }

  // Replace this company's qleno entries, then bulk insert (chunked).
  await db.execute(sql`DELETE FROM efficiency_entries WHERE company_id = ${companyId} AND source = 'qleno'`);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    if (chunk.length) await db.insert(efficiencyEntriesTable).values(chunk);
  }

  // Set-based rollup → employee_efficiency (source='qleno'): hours-weighted
  // 100 × Σallowed_share ÷ Σactual_hours per (employee, package).
  await db.execute(sql`DELETE FROM employee_efficiency WHERE company_id = ${companyId} AND source = 'qleno'`);
  await db.execute(sql`
    INSERT INTO employee_efficiency (company_id, employee_id, service_type, efficiency_pct, source, period, updated_at)
    SELECT company_id, employee_id, package,
           ROUND(100 * SUM(allowed_share) / NULLIF(SUM(actual_hours), 0), 2), 'qleno', 'all_time', NOW()
      FROM efficiency_entries
     WHERE company_id = ${companyId} AND source = 'qleno'
     GROUP BY company_id, employee_id, package
    ON CONFLICT (company_id, employee_id, service_type, period)
    DO UPDATE SET efficiency_pct = EXCLUDED.efficiency_pct, source = 'qleno', updated_at = NOW()
  `);

  return { jobs_scanned: jobs.length, entries_written: rows.length };
}
