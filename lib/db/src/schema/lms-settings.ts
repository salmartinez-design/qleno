/**
 * LMS per-tenant settings (Items 8 + 9, P1 sprint 2026-05-14).
 *
 * Single row per tenant, keyed by company_id. The first inhabitant
 * is `admin_bypass_allowed` (default false). Future inhabitants
 * (deadline window, passing threshold, attempt cap, reminder
 * cadence, notification triggers, bilingual toggle per module,
 * LMS-specific branding) live here too — keep the table general so
 * adding a column doesn't require a new table per setting.
 */
import {
  pgTable,
  serial,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const lmsSettingsTable = pgTable(
  "lms_settings",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    /**
     * Item 8 (P1 sprint): owners always see Bypass buttons in the
     * /lms/admin per-employee drawer. Admins only see them when the
     * owner explicitly enables this setting via /lms/admin/settings.
     * Default false because misclick risk on a long roster is real
     * and bypass is a destructive write that mutates the "Passed"
     * record on a learner.
     */
    admin_bypass_allowed: boolean("admin_bypass_allowed")
      .notNull()
      .default(false),
    /**
     * When true, admins can use the "Add Employee" UI on /lms/admin
     * to onboard new hires. When false (default), only owner can.
     * Backend enforces the gate; frontend hides the button when off.
     */
    admin_add_employee_allowed: boolean("admin_add_employee_allowed")
      .notNull()
      .default(false),
    /**
     * When true, admins can use the per-row Edit button on /lms/admin
     * to modify employee name / email / role / hire date. When false
     * (default), only owner can.
     */
    admin_edit_employee_allowed: boolean("admin_edit_employee_allowed")
      .notNull()
      .default(false),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uq_company: uniqueIndex("lms_settings_company_uq").on(t.company_id),
  }),
);

export type LmsSettings = typeof lmsSettingsTable.$inferSelect;
