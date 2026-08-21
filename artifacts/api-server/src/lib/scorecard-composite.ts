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
import { benefitYearStartDate } from "./leave-grant-reset.js";
import { countUnexcusedOccurrences } from "./attendance-compliance.js";

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
  /** [attendance-ladder 2026-08-21] How the attendance % was reached, so the UI
   *  can say "2 of 5 occurrences" instead of an unexplained percentage. */
  attendance_ladder: {
    benefit_year_start: string | null;
    tardy_occurrences: number;
    unexcused_occurrences: number;
    /** The worse of the two tracks — the one the score is actually based on. */
    worst_occurrences: number;
    /** The tenant's termination rung. 0 when no ladder is configured. */
    termination_occurrences: number;
    /** Null attendance is one of these, never a silent 0. */
    unavailable_reason: "missing_hire_date" | "no_ladder_configured" | null;
  };
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

/**
 * Attendance % from a position on the disciplinary ladder.
 *
 * [attendance-ladder 2026-08-21] Pure so the arithmetic is testable without a
 * database — the bug this replaced (a tardy visible on one tab and invisible on
 * another) survived precisely because nothing could assert the math directly.
 *
 * `worst` is the WORSE of the tardy and unexcused occurrence counts, not their
 * sum: the handbook runs them as two separate scales.
 * `terminationOccurrences` is the tenant's final rung — 5 for Phes today, but
 * read from company_attendance_policy, never assumed.
 */
export function ladderAttendancePct(worst: number, terminationOccurrences: number): number | null {
  if (!Number.isFinite(terminationOccurrences) || terminationOccurrences <= 0) return null;
  const w = Math.max(0, Number(worst) || 0);
  return clampPct(100 - (w / terminationOccurrences) * 100);
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

  // 2. Attendance — position on the handbook's disciplinary ladder, over the
  // employee's Benefit Year.
  //
  // [attendance-ladder 2026-08-21] THE BUG THIS CLOSES. Sal, looking at one
  // tech's profile: the Attendance tab read "Tardy 1" while the Performance
  // Score right beside it read "Attendance 100% — 0 issues". Both were telling
  // the truth about different windows. The tab looks back 180 days; this score
  // looked back 90. A tardy 91+ days old had aged out of the score while still
  // sitting on the tab. Two numbers about the same person, silently disagreeing.
  //
  // The old formula was also a ratio nobody was taught: (scheduled days minus
  // weighted violations) / scheduled days. Against a ~60-day denominator one
  // tardy moved the total score about 0.2 points — technically counted,
  // practically invisible. It appears in no policy document.
  //
  // What employees actually sign, are quizzed on in the LMS, and are
  // disciplined by is the Tardiness Scale in Section 3 of the handbook:
  // 1st/2nd recorded + coaching, 3rd written warning, 4th final warning,
  // 5th termination, counted per Benefit Year (work anniversary). So the score
  // now restates that ladder as a percentage. Each occurrence costs one rung;
  // at the termination step attendance is 0. "Your attendance is 60%" now means
  // "two occurrences, one more is a written warning" — a sentence you can say
  // out loud next to a write-up without the screen contradicting you.
  //
  // Tardy and unexcused are SEPARATE ladders in the handbook, so we take the
  // WORSE of the two rather than averaging: someone one tardy from termination
  // must not be averaged back into the middle by a clean absence record.
  const hireRow = await db.execute(sql`
    SELECT hire_date FROM users WHERE id = ${employeeId} AND company_id = ${companyId} LIMIT 1`);
  const hireDateRaw = (hireRow.rows[0] as any)?.hire_date ?? null;

  // The termination rung comes from the TENANT'S configured ladder, never a
  // hardcoded 5 — the office can edit those steps, and a score that disagreed
  // with the ladder it is supposed to mirror would recreate the exact bug above.
  let terminationOccurrences = 0;
  try {
    const stepRow = await db.execute(sql`
      SELECT tardy_occurrence_steps AS tardy, unexcused_occurrence_steps AS unex
        FROM company_attendance_policy WHERE company_id = ${companyId} LIMIT 1`);
    const lastOf = (steps: unknown): number => {
      const arr = Array.isArray(steps) ? (steps as Array<{ occurrence?: unknown }>) : [];
      return arr.reduce((mx, st) => Math.max(mx, Number(st?.occurrence ?? 0)), 0);
    };
    const row = (stepRow.rows[0] as any) ?? {};
    terminationOccurrences = Math.max(lastOf(row.tardy), lastOf(row.unex));
  } catch {
    terminationOccurrences = 0;
  }

  // Benefit-year occurrence counts. Null attendance (a dash, never a fake 100%)
  // when we can't establish the window or the tenant has no ladder configured:
  //   - no hire_date  -> benefitYearStartDate would collapse to a single day and
  //                      report a permanent 0 occurrences, which is a hole an
  //                      employee could sit in indefinitely. Show nothing and
  //                      let the roster flag the missing date instead.
  //   - no ladder     -> there is no scale to be a percentage OF.
  let attendance: number | null = null;
  let violCount = 0;
  let benefitYearStart: string | null = null;
  let tardyOccurrences = 0;
  let unexcusedOccurrences = 0;

  if (hireDateRaw != null && terminationOccurrences > 0) {
    benefitYearStart = benefitYearStartDate(String(hireDateRaw).slice(0, 10), toDate)
      .toISOString()
      .slice(0, 10);
    const occRows = await db.execute(sql`
      SELECT type, protected
        FROM employee_attendance_log
       WHERE company_id = ${companyId} AND employee_id = ${employeeId}
         AND type IN ('absent', 'ncns', 'tardy')
         AND log_date >= ${benefitYearStart} AND log_date <= ${toDate}`);
    const rows = (occRows.rows ?? []) as Array<{ type: string; protected: boolean | null }>;
    // Protected (PLAWA-covered) rows count zero on both tracks — the handbook is
    // explicit that protected leave never reaches a disciplinary threshold. The
    // old ratio ignored the protected flag entirely, so a protected absence
    // still dragged the score down. Going through the canonical counter fixes
    // that as a side effect.
    tardyOccurrences = rows.filter((r) => r.type === "tardy" && !r.protected).length;
    unexcusedOccurrences = countUnexcusedOccurrences(
      rows
        .filter((r) => r.type === "absent" || r.type === "ncns")
        .map((r) => ({ type: r.type, protected: r.protected })),
    );
    const worst = Math.max(tardyOccurrences, unexcusedOccurrences);
    violCount = tardyOccurrences + unexcusedOccurrences;
    attendance = ladderAttendancePct(worst, terminationOccurrences);
  }

  // Kept for the payload's `counts.scheduled_days` — context for the office
  // ("3 occurrences across 57 scheduled days"), no longer part of the math.
  const schedRow = await db.execute(sql`
    SELECT COUNT(DISTINCT j.scheduled_date)::int AS days
      FROM jobs j
      LEFT JOIN job_technicians jt ON jt.job_id = j.id AND jt.company_id = j.company_id
     WHERE j.company_id = ${companyId}
       AND j.scheduled_date >= ${fromDate} AND j.scheduled_date <= ${toDate}
       AND j.status <> 'cancelled'
       AND (jt.user_id = ${employeeId} OR j.assigned_user_id = ${employeeId})`);
  const scheduledDays = Number((schedRow.rows[0] as any)?.days ?? 0);

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
    attendance_ladder: {
      benefit_year_start: benefitYearStart,
      tardy_occurrences: tardyOccurrences,
      unexcused_occurrences: unexcusedOccurrences,
      worst_occurrences: Math.max(tardyOccurrences, unexcusedOccurrences),
      termination_occurrences: terminationOccurrences,
      unavailable_reason:
        attendance != null
          ? null
          : hireDateRaw == null
            ? "missing_hire_date"
            : "no_ladder_configured",
    },
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
