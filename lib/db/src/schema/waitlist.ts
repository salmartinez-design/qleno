import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const waitlistTable = pgTable("waitlist", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  email: text("email").notNull(),
  zip_code: text("zip_code").notNull(),
  created_at: timestamp("created_at").notNull().defaultNow(),
});
