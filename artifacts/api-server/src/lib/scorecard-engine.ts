import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// [GAP3] Idempotent startup migration for the office-reply columns on
// scorecard_entries. The drizzle schema declares them; this brings the live DB
// in line (no auto-migrate). Safe to re-run.
export async function ensureScorecardReplyColumns(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE scorecard_entries ADD COLUMN IF NOT EXISTS office_reply text`);
    await db.execute(sql`ALTER TABLE scorecard_entries ADD COLUMN IF NOT EXISTS office_reply_by_user_id integer`);
    await db.execute(sql`ALTER TABLE scorecard_entries ADD COLUMN IF NOT EXISTS office_reply_at timestamp`);
    console.log("[scorecard-reply] columns ready");
  } catch (err) {
    console.error("[scorecard-reply] ensure columns error (non-fatal):", err);
  }
}

// MaidCentral-verified scorecard formula: scorecard_pct = unweighted MEAN of
// non-excluded per-job customer responses (0–4 scale) ÷ max × 100. Written to
// users.scorecard_pct as the LIVE value (source='qleno'); the imported MC
// baseline is preserved in users.scorecard_pct_mc. Only recomputes employees
// who actually have qleno responses (others keep their MC baseline).

export async function recomputeEmployeeScorecard(companyId: number, employeeId: number): Promise<void> {
  await db.execute(sql`
    UPDATE users u SET scorecard_pct = sub.pct, scorecard_pct_source = 'qleno'
    FROM (
      SELECT employee_id, ROUND(AVG(score_value / NULLIF(max_value, 0)) * 100, 2) AS pct
        FROM scorecard_entries
       WHERE company_id = ${companyId} AND employee_id = ${employeeId}
         AND source = 'qleno' AND excluded = false
       GROUP BY employee_id
    ) sub
    WHERE u.id = sub.employee_id AND u.company_id = ${companyId}
  `);
}

export async function recomputeAllScorecards(companyId: number): Promise<{ employees_updated: number }> {
  const r = await db.execute(sql`
    UPDATE users u SET scorecard_pct = sub.pct, scorecard_pct_source = 'qleno'
    FROM (
      SELECT employee_id, ROUND(AVG(score_value / NULLIF(max_value, 0)) * 100, 2) AS pct
        FROM scorecard_entries
       WHERE company_id = ${companyId} AND source = 'qleno' AND excluded = false
       GROUP BY employee_id
    ) sub
    WHERE u.id = sub.employee_id AND u.company_id = ${companyId}
    RETURNING u.id
  `);
  return { employees_updated: (r.rows as any[]).length };
}

// Write per-tech scorecard_entries for a survey response (0–4), attributed to
// every tech on the job (job_technicians; falls back to assigned_user_id), then
// recompute each tech's scorecard. Idempotent per (job, employee) via the
// uq_scorecard_entries_survey upsert key. Returns the employee ids written.
export async function captureSurveyScore(args: {
  companyId: number; jobId: number; surveyId: number; score: number; entryDate: string; notes?: string | null;
}): Promise<number[]> {
  const { companyId, jobId, surveyId, score, entryDate, notes } = args;

  // Techs on the job: job_technicians, else the primary assigned_user_id.
  const techRows = await db.execute(sql`
    SELECT user_id FROM job_technicians WHERE job_id = ${jobId} AND company_id = ${companyId}
    UNION
    SELECT assigned_user_id AS user_id FROM jobs
     WHERE id = ${jobId} AND company_id = ${companyId} AND assigned_user_id IS NOT NULL
  `);
  const techIds = [...new Set((techRows.rows as any[]).map(r => Number(r.user_id)).filter(Boolean))];
  if (!techIds.length) return [];

  for (const uid of techIds) {
    // Idempotent without a unique constraint (avoids colliding with existing mc
    // rows): clear this job/tech's prior qleno entry, then insert fresh.
    await db.execute(sql`
      DELETE FROM scorecard_entries
       WHERE company_id = ${companyId} AND employee_id = ${uid} AND job_id = ${jobId} AND source = 'qleno'
    `);
    await db.execute(sql`
      INSERT INTO scorecard_entries (company_id, employee_id, job_id, entry_date, score_value, max_value, source, survey_id, notes)
      VALUES (${companyId}, ${uid}, ${jobId}, ${entryDate}, ${String(score)}, '4', 'qleno', ${surveyId}, ${notes ?? null})
    `);
  }
  for (const uid of techIds) await recomputeEmployeeScorecard(companyId, uid);
  return techIds;
}
