import { pgTable, serial, integer, boolean, numeric, timestamp, unique } from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";
import { usersTable } from "./users";

export const jobTechniciansTable = pgTable("job_technicians", {
  id: serial("id").primaryKey(),
  job_id: integer("job_id").references(() => jobsTable.id, { onDelete: "cascade" }).notNull(),
  user_id: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull(),
  company_id: integer("company_id").notNull(),
  is_primary: boolean("is_primary").notNull().default(false),
  pay_override: numeric("pay_override", { precision: 10, scale: 2 }),
  final_pay: numeric("final_pay", { precision: 10, scale: 2 }),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (t) => [unique().on(t.job_id, t.user_id)]);

export type JobTechnician = typeof jobTechniciansTable.$inferSelect;
