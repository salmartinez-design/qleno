import { pgTable, integer, numeric, primaryKey } from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";
import { supplyItemsTable } from "./supply_items";

export const jobSuppliesTable = pgTable("job_supplies", {
  job_id: integer("job_id").references(() => jobsTable.id).notNull(),
  supply_item_id: integer("supply_item_id").references(() => supplyItemsTable.id).notNull(),
  quantity_used: numeric("quantity_used", { precision: 8, scale: 3 }).notNull(),
  total_cost: numeric("total_cost", { precision: 10, scale: 2 }).notNull(),
}, (t) => [primaryKey({ columns: [t.job_id, t.supply_item_id] })]);

export type JobSupply = typeof jobSuppliesTable.$inferSelect;
