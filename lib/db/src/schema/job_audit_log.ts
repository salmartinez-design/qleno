import { pgTable, serial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";
import { usersTable } from "./users";

export const jobAuditLogTable = pgTable("job_audit_log", {
  id: serial("id").primaryKey(),
  job_id: integer("job_id").references(() => jobsTable.id, { onDelete: "cascade" }).notNull(),
  company_id: integer("company_id").notNull(),
  user_id: integer("user_id").references(() => usersTable.id).notNull(),
  user_name: text("user_name").notNull(),
  user_email: text("user_email").notNull(),
  field_name: text("field_name").notNull(),
  old_value: jsonb("old_value"),
  new_value: jsonb("new_value"),
  cascade_scope: text("cascade_scope"),
  schedule_id: integer("schedule_id"),
  edited_at: timestamp("edited_at").notNull().defaultNow(),
});

export type JobAuditLog = typeof jobAuditLogTable.$inferSelect;
