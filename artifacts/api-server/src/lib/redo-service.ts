import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// [redo-service 2026-07-10] Additive schema for the "Create Redo Service" flow.
// Idempotent — safe to run on every cold start.
//   jobs.redo_of_job_id  — links a redo back to the original job.
//   jobs.non_billable    — $0 redo excluded from revenue counts + invoicing.
//   quality_complaints.reason_category / areas / redo_job_id — structured data
//     powering the Redos & Quality reports (by reason / by area) + the link to
//     the spawned redo job.
export async function runRedoServiceMigration(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS redo_of_job_id integer`);
    await db.execute(sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS non_billable boolean NOT NULL DEFAULT false`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS jobs_redo_of_job_id_idx ON jobs (redo_of_job_id) WHERE redo_of_job_id IS NOT NULL`);
    await db.execute(sql`ALTER TABLE quality_complaints ADD COLUMN IF NOT EXISTS reason_category text`);
    await db.execute(sql`ALTER TABLE quality_complaints ADD COLUMN IF NOT EXISTS areas text`);
    await db.execute(sql`ALTER TABLE quality_complaints ADD COLUMN IF NOT EXISTS redo_job_id integer`);
    console.log("[redo-service] migration ok");
  } catch (err) {
    console.error("[redo-service] migration error (non-fatal):", err);
  }
}
