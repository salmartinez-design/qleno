import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

export const branchesTable = pgTable("branches", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  name: text("name").notNull(),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  phone: text("phone"),
  // Per-location Twilio sender. Company holds the account creds + enable gate;
  // each branch sends from its own number (e.g. Oak Lawn vs Schaumburg).
  twilio_from_number: text("twilio_from_number"),
  // Per-location comms gate. A branch only sends when the global master
  // (COMMS_ENABLED) AND the company master (companies.twilio_enabled) AND this
  // flag are all on. Defaults OFF so adding a branch never opens a send path.
  comms_enabled: boolean("comms_enabled").notNull().default(false),
  is_default: boolean("is_default").notNull().default(false),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertBranchSchema = createInsertSchema(branchesTable).omit({ id: true, created_at: true });
export type InsertBranch = z.infer<typeof insertBranchSchema>;
export type Branch = typeof branchesTable.$inferSelect;
