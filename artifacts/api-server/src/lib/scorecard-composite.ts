// ─────────────────────────────────────────────────────────────────────────────
// 90-Day Rolling Composite Tech Scorecard
//
// Extends the satisfaction-only MaidCentral model (lib/scorecard-engine.ts,
// users.scorecard_pct) into a weighted blend of THREE trailing-90-day signals:
//
//   1. Customer Satisfaction %  — mean of non-excluded 0–4 survey responses
//                                 (scorecard_entries) in the window, ÷max ×100.
//   2. Attendance %             — 100 − (occurrences ÷ the tenant's termination
//                                 rung) × 100, counted over the employee's
//                                 BENEFIT YEAR (floored at the cutover), on two
//                                 independent tracks with the worse one showing.
//                                 See lib/attendance-score.ts. Note this sub-score
//                                 does NOT use the 90-day window the other two do.
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
// Multi-tenant: every query is company_id-scoped.
//
// WINDOWS ARE NOT UNIFORM, and the UI must not claim they are. Satisfaction and
// complaint-free are trailing 90 days ending at `asOf`. Attendance is the
// employee's benefit year (work anniversary), floored at the cutover date —
// because that is the window the disciplinary ladder uses, and a score that
// disagreed with the ladder was the whole problem. [attendance-ladder 2026-08-21]
// ─────────────────────────────────────────────────────────────────────────────
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  attendanceWindowStart,
  tardyWindowStart,
  scoreAttendanceLadder,
  type AttendanceLadderScore,
} from "./attendance-score.js";

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
  // [attendance-ladder 2026-08-21] Where the attendance number came from: the
  // occurrence counts on each track, the tenant's termination rung, and which
  // track is driving. The UI needs this to say "2 of 5 occurrences" instead of
  // an unexplained percentage.
  attendance_detail: AttendanceLadderScore | null;
  /** Benefit-year start, floored at the cutover. Null when there's no hire date. */
  attendance_window_from: string | null;
  /** Why attendance is null, when it is. Null when a score was produced. */
  attendance_unavailable: "no_hire_date" | "no_ladder" | null;
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
       AND dismissed_at IS NULL
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

  // 2. Attendance — how far along the disciplinary ladder this employee stands.
  // [attendance-ladder 2026-08-21] This used to be a days ratio: scheduled days
  // minus weighted violations, over scheduled days. On a 60-day window that made
  // one tardy worth about a fifth of a point of the headline score, so a tech one
  // occurrence away from a written warning still showed green. The score now reads
  // the same occurrences the ladder reads. See lib/attendance-score.ts for the
  // reasoning behind the window floor, the two tracks, and protected rows.
  const hireRow = await db.execute(sql`
    SELECT to_char(hire_date, 'YYYY-MM-DD') AS hire_date
      FROM users WHERE id = ${employeeId} AND company_id = ${companyId} LIMIT 1`);
  const hireDate = (hireRow.rows[0] as any)?.hire_date ?? null;

  // Kept for display only — "N occurrences" reads better next to how many days
  // the tech actually worked. It no longer feeds the math.
  const schedRow = await db.execute(sql`
    SELECT COUNT(DISTINCT j.scheduled_date)::int AS days
      FROM jobs j
      LEFT JOIN job_technicians jt ON jt.job_id = j.id AND jt.company_id = j.company_id
     WHERE j.company_id = ${companyId}
       AND j.scheduled_date >= ${fromDate} AND j.scheduled_date <= ${toDate}
       AND j.status <> 'cancelled'
       AND (jt.user_id = ${employeeId} OR j.assigned_user_id = ${employeeId})`);
  const scheduledDays = Number((schedRow.rows[0] as any)?.days ?? 0);

  let attendance: number | null = null;
  let attendanceDetail: AttendanceLadderScore | null = null;
  let attendanceWindowFrom: string | null = null;
  // Why there's no score, when there isn't one. The UI shows a dash either way,
  // but the office needs to know whether to go fix a hire date or a policy.
  let attendanceUnavailable: "no_hire_date" | "no_ladder" | null = null;
  let violCount = 0;

  if (!hireDate) {
    // No hire date means no benefit year, and a benefit year is the window. The
    // old code silently scored these people anyway; showing a dash is honest and
    // it makes the missing field visible to whoever can fill it in.
    attendanceUnavailable = "no_hire_date";
  } else {
    // [tardy-clean-slate 2026-08-21] The two tracks open on different dates.
    // Tardies follow the plain benefit year, because the tardy slate was wiped
    // and there is no stale history left for a floor to guard against. Unexcused
    // absences keep the cutover floor; their pre-cutover rows are still on the
    // books. attendance_window_from reports the earlier of the two, so the UI
    // caption never claims a shorter window than something was counted from.
    const tardyFrom = tardyWindowStart(hireDate, toDate);
    const unexFrom = attendanceWindowStart(hireDate, toDate);
    attendanceWindowFrom = tardyFrom < unexFrom ? tardyFrom : unexFrom;

    const policyRow = await db.execute(sql`
      SELECT tardy_occurrence_steps, unexcused_occurrence_steps
        FROM company_attendance_policy WHERE company_id = ${companyId} LIMIT 1`);
    const tardySteps = ((policyRow.rows[0] as any)?.tardy_occurrence_steps ?? []) as any[];
    const unexSteps = ((policyRow.rows[0] as any)?.unexcused_occurrence_steps ?? []) as any[];

    // Fetch from the earlier window start and narrow each track below. log_date
    // <= toDate keeps a mis-keyed future date from counting against someone
    // before it has even happened.
    const occRows = await db.execute(sql`
      SELECT type, protected, to_char(log_date, 'YYYY-MM-DD') AS log_date
        FROM employee_attendance_log
       WHERE company_id = ${companyId} AND employee_id = ${employeeId}
         AND type IN ('absent','ncns','tardy')
         AND log_date >= ${attendanceWindowFrom} AND log_date <= ${toDate}`);

    const windowed = (occRows.rows as any[])
      .map(r => ({
        type: String(r.type),
        protected: r.protected === true,
        log_date: String(r.log_date),
      }))
      .filter(r => r.log_date >= (r.type === "tardy" ? tardyFrom : unexFrom));

    attendanceDetail = scoreAttendanceLadder({
      rows: windowed.map(r => ({ type: r.type, protected: r.protected })),
      tardySteps,
      unexcusedSteps: unexSteps,
    });
    attendance = attendanceDetail.score;
    if (attendance == null) attendanceUnavailable = "no_ladder";
    violCount = attendanceDetail.tardy_occurrences + attendanceDetail.unexcused_occurrences;
  }

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
    attendance_detail: attendanceDetail,
    attendance_window_from: attendanceWindowFrom,
    attendance_unavailable: attendanceUnavailable,
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

// [complaint-satisfaction 2026-07-24] A valid complaint / redo counts as a
// "number one" (1 of 4) in the CUSTOMER SATISFACTION score — not just the 15%
// complaint-free bucket (Sal: Jose's complaints weren't dragging his 91%
// satisfaction). It hits the ORIGINAL team who cleaned the job, never the tech
// who does the redo. Modeled as a real scorecard_entries row (source='complaint',
// score 1/4) so it flows through the existing satisfaction average and shows in
// Rating History. Idempotent per (job, tech): one synthetic 1 per original tech
// per complained-about job, however many complaints/redos that job accrues, and
// it's removed if the complaint is later un-validated with no redo.
//
// Trigger: a job "deserves" the 1 when ANY of its complaints is valid OR carries
// a redo (redo_job_id set / re_clean_required). Called from complaint validate
// and redo creation.
export async function syncJobComplaintScore(companyId: number, jobId: number): Promise<number[]> {
  // Should this job carry the complaint penalty?
  const flag = await db.execute(sql`
    SELECT EXISTS(
      SELECT 1 FROM quality_complaints
       WHERE company_id = ${companyId} AND job_id = ${jobId}
         AND (valid = true OR redo_job_id IS NOT NULL OR re_clean_required = true)
    ) AS deserves,
    (SELECT complaint_date FROM quality_complaints
       WHERE company_id = ${companyId} AND job_id = ${jobId}
       ORDER BY complaint_date DESC LIMIT 1) AS on_date`);
  const deserves = (flag.rows[0] as any)?.deserves === true;
  const onDate = (flag.rows[0] as any)?.on_date ?? null;

  // The ORIGINAL team who cleaned this job — job_technicians, falling back to the
  // job's primary assignee. The redo is a SEPARATE job with its own techs, so its
  // cleaner is never in this set and never gets the 1.
  const teamRows = await db.execute(sql`
    SELECT user_id FROM job_technicians WHERE job_id = ${jobId} AND company_id = ${companyId}
    UNION
    SELECT assigned_user_id AS user_id FROM jobs
     WHERE id = ${jobId} AND company_id = ${companyId} AND assigned_user_id IS NOT NULL`);
  const team = [...new Set((teamRows.rows as any[]).map(r => Number(r.user_id)).filter(Boolean))];

  // Reconcile: exactly one source='complaint' entry per original tech when the
  // job deserves it, none otherwise. Delete-then-insert keyed on (job, source).
  await db.execute(sql`
    DELETE FROM scorecard_entries
     WHERE company_id = ${companyId} AND job_id = ${jobId} AND source = 'complaint'`);
  if (deserves && team.length) {
    for (const uid of team) {
      await db.execute(sql`
        INSERT INTO scorecard_entries
          (company_id, employee_id, job_id, entry_date, score_value, max_value, source, excluded, notes)
        VALUES
          (${companyId}, ${uid}, ${jobId}, ${onDate ?? sql`CURRENT_DATE`}, 1, 4, 'complaint', false,
           'Auto: valid complaint / redo counts as 1 of 4')`);
    }
  }

  // Recompute every tech whose score this could have moved (current team; a
  // previously-penalized tech no longer on the job is rare, but recompute is
  // cheap and idempotent).
  for (const uid of team) {
    try { await recomputeCompositeScore(companyId, uid); } catch { /* non-fatal */ }
  }
  return team;
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
       -- [trainee-role] trainees get composite scorecards like technicians
       AND role IN ('technician', 'trainee', 'team_lead')
       -- [roster 2026-08-11] Don't burn a recompute per terminated employee on
       -- every run. Their stored 90d columns freeze at their last active value,
       -- which is correct: the report no longer lists them, and a rehire is
       -- picked up again on the next pass.
       -- [active-definition 2026-08-11] Same three signals the roster page uses
       -- (is_active / termination_date / archived_at) — is_active alone misses
       -- anyone terminated without the flag being flipped.
       AND is_active = true
       AND termination_date IS NULL
       AND archived_at IS NULL`);
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
