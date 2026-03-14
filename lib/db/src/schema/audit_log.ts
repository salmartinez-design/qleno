import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const auditLogTable = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  admin_user_id: integer("admin_user_id").references(() => usersTable.id).notNull(),
  action: text("action").notNull(),
  target_company_id: integer("target_company_id"),
  target_user_id: integer("target_user_id"),
  metadata: text("metadata"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type AuditLog = typeof auditLogTable.$inferSelect;
