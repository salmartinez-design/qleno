import { pgTable, integer, numeric, primaryKey } from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";
import { addOnsTable } from "./add_ons";

export const jobAddOnsTable = pgTable("job_add_ons", {
  job_id: integer("job_id").references(() => jobsTable.id).notNull(),
  add_on_id: integer("add_on_id").references(() => addOnsTable.id).notNull(),
  quantity: integer("quantity").notNull().default(1),
  unit_price: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
  subtotal: numeric("subtotal", { precision: 10, scale: 2 }).notNull(),
  // [AG] Traceability link to pricing_addons.id for recalc lookups. Nullable
  // for backward compat with rows seeded before AG.
  pricing_addon_id: integer("pricing_addon_id"),
}, (t) => [primaryKey({ columns: [t.job_id, t.add_on_id] })]);

export type JobAddOn = typeof jobAddOnsTable.$inferSelect;
