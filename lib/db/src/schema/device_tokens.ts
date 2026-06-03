import { pgTable, serial, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Push-notification device tokens. One user can have several devices (phone +
// tablet); a token is globally unique (APNs/FCM mint one per app install). On
// logout or when APNs/FCM reports a token invalid, the row is removed.
export const deviceTokensTable = pgTable("device_tokens", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  user_id: integer("user_id").references(() => usersTable.id).notNull(),
  token: text("token").notNull(),
  platform: text("platform").notNull().default("unknown"), // ios | android | web | unknown
  last_seen_at: timestamp("last_seen_at").notNull().defaultNow(),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  tokenUnique: uniqueIndex("device_tokens_token_key").on(t.token),
}));

export const insertDeviceTokenSchema = createInsertSchema(deviceTokensTable).omit({ id: true, created_at: true, last_seen_at: true });
export type InsertDeviceToken = z.infer<typeof insertDeviceTokenSchema>;
export type DeviceToken = typeof deviceTokensTable.$inferSelect;
