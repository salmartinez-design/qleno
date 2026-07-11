import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { employeeAttendanceLogTable } from "./hr_logs";
import { usersTable } from "./users";

// [attendance-attachments 2026-07-11] Files the office attaches to an
// unexcused-absence / tardy record (injury photos the employee texted in,
// doctor's notes, work releases). One attendance-log row → many files.
// `file_url` holds the Cloudflare R2 object KEY (not a URL) — same convention
// as job_photos; reads sign a short-lived GET URL. Office-only; techs never
// see these (they don't see the attendance record at all).
export const attendanceAttachmentsTable = pgTable("attendance_attachments", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  attendance_log_id: integer("attendance_log_id")
    .references(() => employeeAttendanceLogTable.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  file_url: text("file_url").notNull(),
  file_type: text("file_type"),
  file_size: integer("file_size"),
  uploaded_by: integer("uploaded_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertAttendanceAttachmentSchema = createInsertSchema(attendanceAttachmentsTable).omit({ id: true, created_at: true });
export type InsertAttendanceAttachment = z.infer<typeof insertAttendanceAttachmentSchema>;
export type AttendanceAttachment = typeof attendanceAttachmentsTable.$inferSelect;
