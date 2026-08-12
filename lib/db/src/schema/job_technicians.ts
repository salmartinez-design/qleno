import { pgTable, serial, integer, boolean, numeric, text, timestamp, unique } from "drizzle-orm/pg-core";
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
  // [paytype-parity 2026-06-05] Per-tech pay type for MaidCentral parity.
  // NULL on every column = inherit the job's smart default (commercial →
  // allowed_hours @ company $/hr; residential → fee_split @ service-type %).
  // The office overrides per timesheet so two techs on one job can be paid
  // differently (e.g. Norma fee_split + Jose hourly). See
  // lib/commission-paytype.ts. pay_type ∈ fee_split|allowed_hours|hourly.
  pay_type: text("pay_type"),
  hourly_rate: numeric("hourly_rate", { precision: 8, scale: 4 }),
  commission_pct: numeric("commission_pct", { precision: 8, scale: 6 }),
  // Optional breakage/damage deduction (default off). A customer breakage
  // credit does NOT auto-dock the cleaner; the office applies a deduction
  // here only when the tech should share the cost — percent of pay and/or
  // flat dollars, both editable.
  pay_deduction_pct: numeric("pay_deduction_pct", { precision: 6, scale: 4 }),
  pay_deduction_flat: numeric("pay_deduction_flat", { precision: 10, scale: 2 }),
  // [pay-note 2026-08-12] Free text explaining WHY this line was paid the way
  // it was — "paid for trainees", "$30/hr on this one", "we paid an extra hour
  // because Alma forgot to clock out". Maribel + Francisco asked for it after
  // the clock HISTORY landed, and it answers a different question: the history
  // is what the system knows (who moved a clock), this is what only a person
  // knows (why the money is what it is). Keyed per (job, tech) because that is
  // exactly one pay line on the Time Clock screen.
  pay_note: text("pay_note"),
  pay_note_by: integer("pay_note_by").references(() => usersTable.id),
  pay_note_at: timestamp("pay_note_at", { withTimezone: true }),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (t) => [unique().on(t.job_id, t.user_id)]);

export type JobTechnician = typeof jobTechniciansTable.$inferSelect;
