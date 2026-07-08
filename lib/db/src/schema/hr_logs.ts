import {
  pgTable, serial, integer, boolean, text, timestamp, date, pgEnum, numeric, time
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { jobsTable } from "./jobs";

export const attendanceLogTypeEnum = pgEnum("attendance_log_type", [
  "tardy", "absent", "ncns", "plawa_leave", "protected_leave", "present",
]);

export const disciplineTypeEnum = pgEnum("discipline_type", [
  "tardy_warning", "absence_warning", "final_warning",
  "quality_probation", "termination", "custom",
]);

export const employeeAttendanceLogTable = pgTable("employee_attendance_log", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").notNull().references(() => companiesTable.id),
  employee_id: integer("employee_id").notNull().references(() => usersTable.id),
  log_date: date("log_date").notNull(),
  type: attendanceLogTypeEnum("type").notNull(),
  protected: boolean("protected").default(false),
  notes: text("notes"),
  // [time-block 2026-07-08] Optional block the entry covers (e.g. Jose worked
  // his morning job and called off 2-6 PM). NULL = whole day. Display-only:
  // the occurrence still counts fully for the discipline ladder; the dispatch
  // board tints just this window instead of the entire row.
  start_time: time("start_time"),
  end_time: time("end_time"),
  logged_by: integer("logged_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const employeeDisciplineLogTable = pgTable("employee_discipline_log", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").notNull().references(() => companiesTable.id),
  employee_id: integer("employee_id").notNull().references(() => usersTable.id),
  discipline_type: disciplineTypeEnum("discipline_type").notNull(),
  custom_label: text("custom_label"),
  reason: text("reason"),
  effective_date: date("effective_date").notNull(),
  issued_by: integer("issued_by").references(() => usersTable.id),
  pending_review: boolean("pending_review").default(false),
  dismissed: boolean("dismissed").default(false),
  acknowledged: boolean("acknowledged").default(false),
  acknowledged_at: timestamp("acknowledged_at"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const qualityComplaintsTable = pgTable("quality_complaints", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").notNull().references(() => companiesTable.id),
  job_id: integer("job_id").references(() => jobsTable.id),
  employee_id: integer("employee_id").notNull().references(() => usersTable.id),
  complaint_date: date("complaint_date").notNull(),
  description: text("description"),
  valid: boolean("valid").default(false),
  validated_by: integer("validated_by").references(() => usersTable.id),
  validated_at: timestamp("validated_at"),
  re_clean_required: boolean("re_clean_required").default(false),
  recovery_tech_id: integer("recovery_tech_id").references(() => usersTable.id),
  resolved: boolean("resolved").default(false),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const employeeLeaveUsageTable = pgTable("employee_leave_usage", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").notNull().references(() => companiesTable.id),
  employee_id: integer("employee_id").notNull().references(() => usersTable.id),
  date_used: date("date_used").notNull(),
  hours: numeric("hours", { precision: 6, scale: 2 }).notNull(),
  notes: text("notes"),
  // [time-block 2026-07-08] Which bucket this deduction came from — was only a
  // notes-string tag before, so the dispatch board had to GUESS "PTO" for
  // every office deduction (Hilda's 4h unpaid block rendered as full-day PTO).
  leave_type_id: integer("leave_type_id"),
  // Optional block the deduction covers. NULL = whole day.
  start_time: time("start_time"),
  end_time: time("end_time"),
  logged_by: integer("logged_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type EmployeeAttendanceLog = typeof employeeAttendanceLogTable.$inferSelect;
export type EmployeeDisciplineLog = typeof employeeDisciplineLogTable.$inferSelect;
export type QualityComplaint = typeof qualityComplaintsTable.$inferSelect;
export type EmployeeLeaveUsage = typeof employeeLeaveUsageTable.$inferSelect;
