// [team-photo-notes] Idempotent boot migration. Creates the team_photo_notes
// table via raw SQL so the feature works on a fresh deploy WITHOUT a separate
// drizzle-kit push. Safe to call on every cold start. Mirrors runGuidesMigration.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export async function runTeamPhotoNotesMigration(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS team_photo_notes (
        id serial PRIMARY KEY,
        company_id integer NOT NULL,
        job_id integer,
        client_id integer,
        account_id integer,
        account_property_id integer,
        is_sticky boolean NOT NULL DEFAULT false,
        image_url text,
        note text,
        uploaded_by integer,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    // The job panel reads job-specific notes by job_id; the customer/account
    // pages and the sticky-match query read by client_id / account scope.
    await db.execute(sql`CREATE INDEX IF NOT EXISTS team_photo_notes_job_idx ON team_photo_notes (company_id, job_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS team_photo_notes_sticky_idx ON team_photo_notes (company_id, is_sticky, client_id, account_id, account_property_id)`);
    console.log("[team-photo-notes] migration ok — table ready");
  } catch (err) {
    console.error("[team-photo-notes] migration error (non-fatal):", err);
  }
}
