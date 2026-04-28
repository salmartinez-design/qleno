import { pgTable, integer, numeric, primaryKey } from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";
import { addOnsTable } from "./add_ons";

// [AI.15a breadcrumb] Any future writer that INSERTs/UPDATEs/DELETEs rows
// in this table MUST invoke recalcJobCommissions(jobId, companyId) from
// artifacts/api-server/src/lib/commission-engine.ts so that:
//   1. job_technicians.final_pay reflects the new job total
//   2. jobs.last_recalculated_at gets stamped (drives dispatch polling)
// There is no addon toggle UI in dispatch today. AI.15a does not write
// to this table. When AI.15b adds the toggle, the recalc must come for
// free.
export const jobAddOnsTable = pgTable("job_add_ons", {
  job_id: integer("job_id").references(() => jobsTable.id).notNull(),
  add_on_id: integer("add_on_id").references(() => addOnsTable.id).notNull(),
  quantity: integer("quantity").notNull().default(1),
  unit_price: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
  subtotal: numeric("subtotal", { precision: 10, scale: 2 }).notNull(),
}, (t) => [primaryKey({ columns: [t.job_id, t.add_on_id] })]);

export type JobAddOn = typeof jobAddOnsTable.$inferSelect;
