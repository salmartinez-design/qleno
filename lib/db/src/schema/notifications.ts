import { pgTable, uuid, integer, varchar, text, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

export const inAppNotificationsTable = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  company_id: integer("company_id").notNull(),
  // Target user. NULL = company/office broadcast (legacy, e.g. new-booking
  // alerts seen by office). Set = a specific user (per-user targeting — a tech's
  // job alerts, an office user's message alerts).
  user_id: integer("user_id"),
  type: varchar("type", { length: 50 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  body: text("body"),
  link: varchar("link", { length: 500 }),
  meta: jsonb("meta"),
  read: boolean("read").default(false),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
