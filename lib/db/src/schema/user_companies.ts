import { pgTable, integer, text, timestamp, unique } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

export const userCompaniesTable = pgTable("user_companies", {
  user_id: integer("user_id").references(() => usersTable.id).notNull(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  role: text("role").notNull().default("member"),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  uniq: unique().on(t.user_id, t.company_id),
}));

export type UserCompany = typeof userCompaniesTable.$inferSelect;
