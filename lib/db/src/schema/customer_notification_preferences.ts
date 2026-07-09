import { pgTable, serial, integer, text, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

// [notif-prefs] Sparse per-client / per-account override of which customer
// messages fire on which channel. A row exists ONLY for an explicit deviation
// from the tenant default (which is ON). No row = inherit default = send.
// scope_type is 'client' (clients.account_id IS NULL) or 'account'
// (clients.account_id set → controlled at the account level). Distinct from the
// tech-push `notification_prefs` table — this is customer-message control.
export const customerNotificationPreferencesTable = pgTable(
  "customer_notification_preferences",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id").references(() => companiesTable.id).notNull(),
    scope_type: text("scope_type").notNull(), // 'client' | 'account'
    scope_id: integer("scope_id").notNull(),
    trigger: text("trigger").notNull(),
    channel: text("channel").notNull(), // 'email' | 'sms'
    enabled: boolean("enabled").notNull().default(true),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqScope: unique().on(t.company_id, t.scope_type, t.scope_id, t.trigger, t.channel),
  }),
);

export const insertCustomerNotificationPreferenceSchema = createInsertSchema(
  customerNotificationPreferencesTable,
).omit({ id: true, updated_at: true });
export type InsertCustomerNotificationPreference = z.infer<
  typeof insertCustomerNotificationPreferenceSchema
>;
export type CustomerNotificationPreference =
  typeof customerNotificationPreferencesTable.$inferSelect;
