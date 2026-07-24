import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { syncJobComplaintScore } from "./scorecard-composite.js";

// [complaint-satisfaction 2026-07-24] One-time backfill for the
// complaints-cascade-into-Customer-Satisfaction feature (PR #1241).
//
// The live triggers (complaint validate, redo creation) only fire on NEW
// activity, so cleaners who already had valid complaints / redos when the
// feature shipped — e.g. Jose's 2 — never got their synthetic 1-of-4 into the
// satisfaction average. This walks every job that ALREADY deserves the penalty
// and runs the same reconcile the live path uses.
//
// Self-terminating: it only looks at jobs that do NOT yet have a
// source='complaint' scorecard entry, so once a job is synced it drops out of
// the scan. After the first successful cold start this finds nothing and does
// no work — safe to leave in the boot sequence permanently.
export async function runComplaintScoreBackfill(): Promise<{
  jobs_scanned: number;
  jobs_synced: number;
  errors: number;
}> {
  // Jobs with a valid / redo / re-clean complaint that haven't been scored yet.
  const rows = await db.execute(sql`
    SELECT DISTINCT qc.company_id, qc.job_id
      FROM quality_complaints qc
     WHERE qc.job_id IS NOT NULL
       AND (qc.valid = true OR qc.redo_job_id IS NOT NULL OR qc.re_clean_required = true)
       AND NOT EXISTS (
         SELECT 1 FROM scorecard_entries se
          WHERE se.company_id = qc.company_id
            AND se.job_id = qc.job_id
            AND se.source = 'complaint'
       )`);

  const jobs = rows.rows as Array<{ company_id: number; job_id: number }>;
  let synced = 0;
  let errors = 0;
  for (const j of jobs) {
    try {
      await syncJobComplaintScore(Number(j.company_id), Number(j.job_id));
      synced++;
    } catch (e: any) {
      errors++;
      console.error(
        `[complaint-score-backfill] job ${j.job_id} (company ${j.company_id}) failed — non-fatal:`,
        e?.message ?? e,
      );
    }
  }
  return { jobs_scanned: jobs.length, jobs_synced: synced, errors };
}
