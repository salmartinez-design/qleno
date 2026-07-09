import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";

export const qbSyncQueueTable = pgTable("qb_sync_queue", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  entity_type: text("entity_type").notNull(),
  entity_id: integer("entity_id").notNull(),
  qb_entity_id: text("qb_entity_id"),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  last_error: text("last_error"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const qbCustomerMapTable = pgTable("qb_customer_map", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  qleno_customer_id: integer("qleno_customer_id").references(() => clientsTable.id).notNull(),
  qb_customer_id: text("qb_customer_id").notNull(),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  // [qb-cutover] One QB customer per (tenant, Qleno client). Backstops the
  // concurrency race where two near-simultaneous syncs for the same client
  // both miss the map lookup and each create a QB customer. The map insert in
  // syncCustomer uses ON CONFLICT against this index so the loser no-ops.
  companyCustomerUq: uniqueIndex("qb_customer_map_company_customer_uq").on(t.company_id, t.qleno_customer_id),
}));

export type QbSyncQueue = typeof qbSyncQueueTable.$inferSelect;
export type QbCustomerMap = typeof qbCustomerMapTable.$inferSelect;
