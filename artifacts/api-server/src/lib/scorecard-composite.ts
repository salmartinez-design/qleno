// ─────────────────────────────────────────────────────────────────────────────
// 90-Day Rolling Composite Tech Scorecard
//
// Extends the satisfaction-only MaidCentral model (lib/scorecard-engine.ts,
// users.scorecard_pct) into a weighted blend of THREE trailing-90-day signals:
//
//   1. Customer Satisfaction %  — mean of non-excluded 0–4 survey responses
//                                 (scorecard_entries) in the window, ÷max ×100.
//   2. Attendance %             — 100 × (scheduled tech-days − weighted
//                                 violations) / scheduled, from
//                                 employee_attendance_log (absent/ncns=1.0,
//                                 tardy=0.5).
//   3. Complaint-free %         — 100 × (1 − valid complaints / completed jobs),
//                                 from quality_complaints (valid=true).
//
// The composite is the weight-blended average of whichever sub-scores are
// non-null (weights re-normalize), so a tech with no surveys yet still gets a
// composite from attendance + complaints. Weights are per-tenant on
// companies.score_weight_*. The composite is the DISPLAYED headline scorecard %
// (replaces scorecard_pct on every surface); scorecard_pct stays as the
// satisfaction-only live value the survey recompute writes.
//
// Multi-tenant: every query is company_id-scoped. Window: trailing 90 days
// ending at `asOf` (default today, America/Chicago is implied by date columns).
// ─────────────────────────────────────────────────────────────────────────────
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export const COMPOSITE_WINDOW_DAYS = 90;

export interface CompositeWeights {
  satisfaction: number;
  attendance: number;
  complaint_free: number;
}

export interface CompositeResult {
  employee_id: number;
  window: { from: string; to: string; days: number };
  weights: CompositeWeights;
  // Sub-scores are 0–100 or null when there's no signal in the window.
  satisfaction: number | null;
  // How the satisfaction sub-score was sourced: the 90-day rolling window, the
  // imported MaidCentral / lifetime fallback, or null when neither exists.
  satisfaction_source: "rolling_90d" | "mc_lifetime" | null;
  attendance: number | null;
  complaint_free: number | null;
  composite: number | null;
  counts: {
    survey_responses: number;
    scheduled_days: number;
    attendance_violations: number;
    valid_complaints: number;
    completed_jobs: number;
  };
}

// Idempotent startup migration — brings the live DB in line with the drizzle
// schema (no auto-migrate). Mirrors ensureScorecardReplyColumns(). Safe to
// re-run on every boot.
export async function ensureCompositeScoreColumns(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS score_satisfaction_90d numeric(5,2)`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS score_attendance_90d numeric(5,2)`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS score_complaint_free_90d numeric(5,2)`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS scorecard_composite_90d numeric(5,2)`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS score_computed_at timestamptz`);
    await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS score_weight_satisfaction integer NOT NULL DEFAULT 60`);
    await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS score_weight_attendance integer NOT NULL DEFAULT 25`);
    await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS score_weight_complaint_free integer NOT NULL DEFAULT 15`);
    console.log("[scorecard-composite] columns ready");
  } catch (err) {
    console.error("[scorecard-composite] ensure columns error (non-fatal):", err);
  }
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 100) / 100));
}

const DEFAULT_WEIGHTS: CompositeWeights = { satisfaction: 60, attendance: 25, complaint_free: 15 };

async function getWeights(companyId: number): Promise<CompositeWeights> {
  try {
    const r = await db.execute(sql`
      SELECT score_weight_satisfaction AS s, score_weight_attendance AS a, score_weight_complaint_free AS c
        FROM companies WHERE id = ${companyId} LIMIT 1`);
    const row = (r.rows[0] as any) ?? {};
    return {
      satisfaction: Number(row.s ?? DEFAULT_WEIGHTS.satisfaction),
      attendance: Number(row.a ?? DEFAULT_WEIGHTS.attendance),
      complaint_free: Number(row.c ?? DEFAULT_WEIGHTS.complaint_free),
    };
  } catch {
    // Columns may not exist yet on a DB where the boot migration hasn't run —
    // fall back to the defaults so the read path never hard-fails.
    return { ...DEFAULT_WEIGHTS };
  }
}

// Pure read — compute the three sub-scores + the blended composite for one tech.
export async function computeCompositeForEmployee(
  companyId: number,
  employeeId: number,
  asOf?: string,
): Promise<CompositeResult> {
  const toDate = asOf ?? new Date().toISOString().slice(0, 10);
  const weights = await getWeights(companyId);

  // from = toDate − 90 days, computed in SQL so the date math is DB-consistent.
  const fromRow = await db.execute(
    sql`SELECT (${toDate}::date - ${COMPOSITE_WINDOW_DAYS} * INTERVAL '1 day')::date AS f`,
  );
  const fromDate = String((fromRow.rows[0] as any).f).slice(0, 10);

  // 1. Satisfaction — mean of non-excluded 0–4 responses in the window. When a
  // tech has NO ratings in the 90-day window, fall back to their imported
  // MaidCentral / lifetime headline (users.scorecard_pct) so the history isn't
  // dropped and they don't inflate to a fake-perfect score off the absence of
  // complaints. `satisfaction_source` records which was used.
  const satRow = await db.execute(sql`
    SELECT ROUND(AVG(score_value / NULLIF(max_value, 0)) * 100, 2) AS pct, COUNT(*)::int AS n
      FROM scorecard_entries
     WHERE company_id = ${companyId} AND employee_id = ${employeeId} AND excluded = false
       AND entry_date >= ${fromDate} AND entry_date <= ${toDate}`);
  const satN = Number((satRow.rows[0] as any)?.n ?? 0);
  let satisfaction = satN > 0 && (satRow.rows[0] as any)?.pct != null
    ? clampPct(Number((satRow.rows[0] as any).pct)) : null;
  let satisfaction_source: "rolling_90d" | "mc_lifetime" | null = satisfaction != null ? "rolling_90d" : null;
  if (satisfaction == null) {
    const lifeRow = await db.execute(sql`
      SELECT scorecard_pct FROM users WHERE id = ${employeeId} AND company_id = ${companyId} LIMIT 1`);
    const lifetime = (lifeRow.rows[0] as any)?.scorecard_pct;
    if (lifetime != null) { satisfaction = clampPct(Number(lifetime)); satisfaction_source = "mc_lifetime"; }
  }

  // 2. Attendance — scheduled tech-days (distinct, non-cancelled) vs weighted
  // violations from the confirmed attendance log.
  const schedRow = await db.execute(sql`
    SELECT COUNT(DISTINCT j.scheduled_date)::int AS days
      FROM jobs j
      LEFT JOIN job_technicians jt ON jt.job_id = j.id AND jt.company_id = j.company_id
     WHERE j.company_id = ${companyId}
       AND j.scheduled_date >= ${fromDate} AND j.scheduled_date <= ${toDate}
       AND j.status <> 'cancelled'
       AND (jt.user_id = ${employeeId} OR j.assigned_user_id = ${employeeId})`);
  const scheduledDays = Number((schedRow.rows[0] as any)?.days ?? 0);

  const violRow = await db.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN type IN ('absent','ncns') THEN 1.0
                        WHEN type = 'tardy' THEN 0.5 ELSE 0 END), 0) AS vweight,
      COUNT(*) FILTER (WHERE type IN ('absent','ncns','tardy'))::int AS vcount
      FROM employee_attendance_log
     WHERE company_id = ${companyId} AND employee_id = ${employeeId}
       AND log_date >= ${fromDate} AND log_date <= ${toDate}`);
  const violWeight = Number((violRow.rows[0] as any)?.vweight ?? 0);
  const violCount = Number((violRow.rows[0] as any)?.vcount ?? 0);
  const attendance = scheduledDays > 0
    ? clampPct((100 * (scheduledDays - violWeight)) / scheduledDays) : null;

  // 3. Complaint-free — valid complaints vs completed jobs in the window.
  const complaintRow = await db.execute(sql`
    SELECT COUNT(*) FILTER (WHERE valid = true)::int AS valid_complaints
      FROM quality_complaints
     WHERE company_id = ${companyId} AND employee_id = ${employeeId}
       AND complaint_date >= ${fromDate} AND complaint_date <= ${toDate}`);
  const validComplaints = Number((complaintRow.rows[0] as any)?.valid_complaints ?? 0);

  const jobsRow = await db.execute(sql`
    SELECT COUNT(DISTINCT j.id)::int AS n
      FROM jobs j
      LEFT JOIN job_technicians jt ON jt.job_id = j.id AND jt.company_id = j.company_id
     WHERE j.company_id = ${companyId} AND j.status = 'complete'
       AND j.scheduled_date >= ${fromDate} AND j.scheduled_date <= ${toDate}
       AND (jt.user_id = ${employeeId} OR j.assigned_user_id = ${employeeId})`);
  const completedJobs = Number((jobsRow.rows[0] as any)?.n ?? 0);
  const complaint_free = completedJobs > 0
    ? clampPct(100 * (1 - validComplaints / completedJobs)) : null;

  // Composite — weighted average over the non-null sub-scores (re-normalized).
  // A satisfaction signal (rolling OR MC-lifetime fallback) is REQUIRED: without
  // any customer-rating data a "Performance Score" is meaningless, and blending
  // attendance/complaint-free alone would inflate to ~100% off the absence of
  // complaints. Such techs return composite = null (UI shows "—").
  const parts: Array<{ v: number; w: number }> = [];
  if (satisfaction != null) parts.push({ v: satisfaction, w: weights.satisfaction });
  if (attendance != null) parts.push({ v: attendance, w: weights.attendance });
  if (complaint_free != null) parts.push({ v: complaint_free, w: weights.complaint_free });
  const totalW = parts.reduce((s, p) => s + p.w, 0);
  const composite = satisfaction != null && parts.length > 0 && totalW > 0
    ? clampPct(parts.reduce((s, p) => s + p.v * p.w, 0) / totalW) : null;

  return {
    employee_id: employeeId,
    window: { from: fromDate, to: toDate, days: COMPOSITE_WINDOW_DAYS },
    weights,
    satisfaction,
    satisfaction_source,
    attendance,
    complaint_free,
    composite,
    counts: {
      survey_responses: satN,
      scheduled_days: scheduledDays,
      attendance_violations: violCount,
      valid_complaints: validComplaints,
      completed_jobs: completedJobs,
    },
  };
}

// Compute + persist the five score columns on the user row.
export async function recomputeCompositeScore(
  companyId: number,
  employeeId: number,
  asOf?: string,
): Promise<CompositeResult> {
  const r = await computeCompositeForEmployee(companyId, employeeId, asOf);
  await db.execute(sql`
    UPDATE users SET
        score_satisfaction_90d   = ${r.satisfaction},
        score_attendance_90d     = ${r.attendance},
        score_complaint_free_90d = ${r.complaint_free},
        scorecard_composite_90d  = ${r.composite},
        score_computed_at        = NOW()
     WHERE id = ${employeeId} AND company_id = ${companyId}`);
  return r;
}

// Batch recompute for a tenant — every employee who could plausibly have a
// score (any tech with assignments, attendance, complaints, or survey entries
// in the window). Used by the nightly cron so the rolling window advances even
// on days with no events. Returns the number of employees updated.
export async function recomputeAllComposites(
  companyId: number,
  asOf?: string,
): Promise<{ employees_updated: number }> {
  const ids = await db.execute(sql`
    SELECT id FROM users
     WHERE company_id = ${companyId}
       AND role IN ('technician', 'team_lead')`);
  let updated = 0;
  for (const row of ids.rows as any[]) {
    try {
      await recomputeCompositeScore(companyId, Number(row.id), asOf);
      updated++;
    } catch (err) {
      console.error(`[scorecard-composite] recompute failed company=${companyId} employee=${row.id}:`, err);
    }
  }
  return { employees_updated: updated };
}

// Nightly cron entry — recompute composites for every tenant. Wired into the
// index.ts daily scheduler.
export async function runScorecardCompositeCron(): Promise<void> {
  try {
    const companies = await db.execute(sql`SELECT id FROM companies`);
    let total = 0;
    for (const row of companies.rows as any[]) {
      const { employees_updated } = await recomputeAllComposites(Number(row.id));
      total += employees_updated;
    }
    console.log(`[scorecard-composite] nightly recompute: ${total} employees across ${companies.rows.length} tenants`);
  } catch (err) {
    console.error("[scorecard-composite] nightly cron error:", err);
  }
}
