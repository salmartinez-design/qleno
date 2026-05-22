/**
 * Qleno LMS Onboarding Intake — Drizzle schema
 *
 * Operational intake form collected on hire. Captures the data the
 * office needs to dispatch and route a tech that ADP does NOT already
 * hold. Excludes SSN, W-4, IL-W-4, I-9 documents, direct deposit
 * (those live with ADP — Phes's payroll provider). Including them in
 * Qleno would create duplicative PII risk.
 *
 * Multi-tenant: every row carries `company_id`. One row per
 * (company_id, user_id). Upserted via POST /api/lms/onboarding-intake.
 *
 * Role gating:
 *   - GET /me — the user reads / writes their own row.
 *   - GET /admin/learner/:userId — owner / admin / office can read any
 *     user's intake within their tenant.
 *   - GET /admin/export — owner / admin / office can export a CSV of
 *     all intakes within the tenant. Each export is audited.
 *
 * Cross-tenant access returns 404.
 */
import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  boolean,
  date,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
// integer is used for vehicle_year (4-digit year).
// boolean is used for drives_personal_vehicle and
// vehicle_protocol_acknowledged.
import { companiesTable } from "./companies";
import { usersTable } from "./users";

export const lmsOnboardingIntakeTable = pgTable(
  "lms_onboarding_intake",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    user_id: integer("user_id")
      .notNull()
      .references(() => usersTable.id),

    /** Preferred name if different from legal name on file. */
    preferred_name: text("preferred_name"),
    /** Pronouns (free text, e.g. "she/her", "they/them"). */
    pronouns: text("pronouns"),
    /** Personal email (NOT the work email). Used for offline contact. */
    personal_email: text("personal_email"),
    /** Personal cell phone (NOT the work line). */
    personal_cell_phone: text("personal_cell_phone"),

    /** Emergency-contact fields. Required to count as "submitted". */
    emergency_contact_name: text("emergency_contact_name"),
    emergency_contact_relationship: text("emergency_contact_relationship"),
    emergency_contact_phone: text("emergency_contact_phone"),

    /**
     * Home address fields (PR feature/onboarding-intake-vehicle-and-address
     * 2026-05-22). Required for tax compliance and emergency response. Phes
     * does NOT use home address for mileage reimbursement — mileage only
     * covers driving between client locations on the same workday.
     */
    home_address_street: text("home_address_street"),
    home_address_unit: text("home_address_unit"),
    home_address_city: text("home_address_city"),
    home_address_state: text("home_address_state").default("IL"),
    home_address_zip: text("home_address_zip"),

    /**
     * Languages the employee can communicate in with clients. Stored
     * as comma-separated text (e.g. "english,spanish") to keep the
     * schema simple. The frontend renders chips and writes back the
     * canonical comma-joined string. NULL = not specified yet.
     */
    languages_spoken: text("languages_spoken"),

    /** Uniform sizing for shirt and apron. Free text to allow XS / XXL etc. */
    shirt_size: text("shirt_size"),
    apron_size: text("apron_size"),

    /** True if the employee plans to use their personal vehicle for Phes work. */
    drives_personal_vehicle: boolean("drives_personal_vehicle")
      .notNull()
      .default(false),
    /**
     * Vehicle + insurance + DL fields (expanded for the
     * vehicle-and-address PR). Required when drives_personal_vehicle =
     * true. PII concern: drivers_license_number is sensitive; the
     * codebase does not currently have at-rest encryption infrastructure,
     * which is flagged as a follow-up security improvement (see PR
     * description). For now stored as plain text alongside the rest of
     * the operational PII.
     */
    vehicle_make: text("vehicle_make"),
    vehicle_model: text("vehicle_model"),
    vehicle_year: integer("vehicle_year"),
    vehicle_color: text("vehicle_color"),
    vehicle_license_plate: text("vehicle_license_plate"),
    vehicle_insurance_company: text("vehicle_insurance_company"),
    vehicle_insurance_policy_number: text("vehicle_insurance_policy_number"),
    vehicle_insurance_expires_at: date("vehicle_insurance_expires_at"),
    drivers_license_number: text("drivers_license_number"),
    drivers_license_state: text("drivers_license_state").default("IL"),
    drivers_license_expires_at: date("drivers_license_expires_at"),
    /**
     * Vehicle-use protocol acknowledgment. Required-true when the
     * employee checks `drives_personal_vehicle`. Captures the moment
     * the employee acknowledged the mileage / no-client-transport /
     * insurance-primary / notify-on-lapse terms.
     */
    vehicle_protocol_acknowledged: boolean("vehicle_protocol_acknowledged")
      .notNull()
      .default(false),
    vehicle_protocol_acknowledged_at: timestamp(
      "vehicle_protocol_acknowledged_at",
      { withTimezone: true },
    ),

    /** Free-form notes (allergies, dietary restrictions, accessibility). */
    notes: text("notes"),

    /**
     * Timestamp of the first save with all REQUIRED fields populated
     * (emergency contact name / relationship / phone). NULL until the
     * intake counts as "submitted" rather than just partially drafted.
     */
    submitted_at: timestamp("submitted_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uq_company_user: uniqueIndex(
      "lms_onboarding_intake_company_user_uq",
    ).on(t.company_id, t.user_id),
    idx_company_submitted: index(
      "lms_onboarding_intake_company_submitted_idx",
    ).on(t.company_id, t.submitted_at),
  }),
);

export type LmsOnboardingIntake =
  typeof lmsOnboardingIntakeTable.$inferSelect;
export type LmsOnboardingIntakeInsert =
  typeof lmsOnboardingIntakeTable.$inferInsert;

/**
 * Fields that, if all present and non-empty, mark the intake as
 * "submitted". Used by the route handler to set `submitted_at` on the
 * first save that completes the required-data set.
 */
export const REQUIRED_INTAKE_FIELDS = [
  "emergency_contact_name",
  "emergency_contact_relationship",
  "emergency_contact_phone",
] as const;
