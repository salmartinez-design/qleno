// [attendance-attachments] Idempotent boot migration. Creates the
// attendance_attachments table via raw SQL so the feature works on a fresh
// deploy WITHOUT a separate drizzle-kit push. Safe on every cold start.
// Mirrors runTeamPhotoNotesMigration.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export async function runAttendanceAttachmentsMigration(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS attendance_attachments (
        id serial PRIMARY KEY,
        company_id integer NOT NULL,
        attendance_log_id integer NOT NULL REFERENCES employee_attendance_log (id) ON DELETE CASCADE,
        name text NOT NULL,
        file_url text NOT NULL,
        file_type text,
        file_size integer,
        uploaded_by integer,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    // History + record modals list attachments per attendance-log row, scoped
    // by company on every read.
    await db.execute(sql`CREATE INDEX IF NOT EXISTS attendance_attachments_log_idx ON attendance_attachments (company_id, attendance_log_id)`);
    console.log("[attendance-attachments] migration ok — table ready");
  } catch (err) {
    console.error("[attendance-attachments] migration error (non-fatal):", err);
  }
}
