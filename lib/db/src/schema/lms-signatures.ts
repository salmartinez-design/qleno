/**
 * Qleno LMS Signatures — Drizzle schema
 *
 * Foundation tables for the 2026 onboarding / training / acknowledgment
 * system. Every legally binding document signed by an employee (handbook,
 * code of conduct, drug & alcohol policy, video/photo release,
 * non-solicitation, supply kit, social media policy, etc.) goes through
 * this schema.
 *
 * Multi-tenant: every row carries `company_id`. UETA / E-SIGN compliance:
 * captures affirmative action, IP, device info, signed content version
 * hash, and tamper-evident storage. Annual recurrence + forced
 * re-acknowledgment for material policy changes.
 *
 * Tables (6):
 *   lms_signed_documents       — one row per signed instance (per user,
 *                                 per document type, per signing event)
 *   lms_document_versions      — content version registry keyed by
 *                                 (document_type, locale, version_hash)
 *   lms_signature_events       — audit log of every signature action
 *                                 (initiated, completed, co-signed,
 *                                 PDF downloaded, revoked)
 *   lms_completion_certificates — per-module + final exam certificates
 *                                  with score and quiz attempt link
 *   lms_annual_ack_cycles      — annual re-acknowledgment cycles
 *                                 (one row per tenant per cycle_year)
 *   lms_pending_re_ack         — material policy changes that need
 *                                 immediate forced re-sign per user
 *
 * Enums (3):
 *   signature_method           — drawn | typed
 *   signed_document_status     — active | superseded | revoked
 *   signature_event_type       — sign_initiated | sign_completed |
 *                                 co_signed | pdf_downloaded |
 *                                 revoked
 *
 * Notes:
 * - `document_type` is a text column (not an enum) so future PRs can
 *   add document types without a migration. The allowlist of valid
 *   document_type values lives in the shared `@workspace/lms-curriculum`
 *   package (see KNOWN_SIGNED_DOCUMENT_TYPES).
 * - Version hashes are SHA-256 of (locale + canonical content HTML).
 *   The version registry stores the canonical content so we can replay
 *   exactly what was signed for any audit.
 * - PDF storage URL is nullable. The generation pipeline (pdf-lib) is
 *   wired in PR #3+; for now signatures are valid without a PDF render.
 *
 * Migrations run via `drizzle-kit push` (no SQL files) and the
 * idempotent CREATE TABLE blocks in phes-data-migration.ts.
 */
import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
  date,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export const signatureMethodEnum = pgEnum("signature_method", [
  "drawn",
  "typed",
]);

export const signedDocumentStatusEnum = pgEnum("signed_document_status", [
  "active",
  "superseded",
  "revoked",
]);

export const signatureEventTypeEnum = pgEnum("signature_event_type", [
  "sign_initiated",
  "sign_completed",
  "co_signed",
  "pdf_downloaded",
  "revoked",
]);

// ─────────────────────────────────────────────────────────────────────────────
// lms_document_versions — content version registry
// ─────────────────────────────────────────────────────────────────────────────
//
// One row per (company_id, document_type, locale, version_hash). Each
// tenant maintains its own version chain — Phes's handbook content is
// hashed separately from any future tenant's, even if two tenants
// happened to author identical text. This keeps the audit chain
// tenant-isolated: deleting tenant A's history cannot touch tenant B's
// signed contracts.
//
// `is_material` triggers forced re-acknowledgment for all employees in
// THAT TENANT who signed earlier versions (see lms_pending_re_ack).

export const lmsDocumentVersionsTable = pgTable(
  "lms_document_versions",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    document_type: text("document_type").notNull(),
    locale: text("locale").notNull(), // 'en' | 'es'
    version_hash: text("version_hash").notNull(), // SHA-256 of canonical content
    content_html: text("content_html").notNull(),
    /**
     * Material content change. When true, an active-employee sweep
     * inserts rows into lms_pending_re_ack so each employee with a
     * superseded signature is forced to re-sign before next shift.
     */
    is_material: boolean("is_material").notNull().default(false),
    /** Optional change notes shown to admins in the audit dashboard. */
    notes: text("notes"),
    effective_at: timestamp("effective_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_by_user_id: integer("created_by_user_id").references(
      () => usersTable.id,
    ),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uq_company_type_locale_hash: uniqueIndex(
      "lms_document_versions_company_type_locale_hash_uq",
    ).on(t.company_id, t.document_type, t.locale, t.version_hash),
    idx_company_type_locale: index(
      "lms_document_versions_company_type_locale_idx",
    ).on(t.company_id, t.document_type, t.locale),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// lms_signed_documents — one signed instance
// ─────────────────────────────────────────────────────────────────────────────

export const lmsSignedDocumentsTable = pgTable(
  "lms_signed_documents",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    user_id: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    document_type: text("document_type").notNull(),
    document_version_id: integer("document_version_id")
      .notNull()
      .references(() => lmsDocumentVersionsTable.id),
    /**
     * Locale the user signed in. Stored separately for fast filtering
     * even though it's also recoverable from document_version_id.
     */
    locale: text("locale").notNull(),
    /**
     * The hash of the content version at signing. Denormalized from
     * lms_document_versions so old signatures stay verifiable even if
     * the version row is somehow modified (defense in depth).
     */
    version_hash: text("version_hash").notNull(),
    /** drawn = data URL of canvas; typed = the typed legal name string. */
    employee_signature: text("employee_signature").notNull(),
    employee_signature_method: signatureMethodEnum(
      "employee_signature_method",
    ).notNull(),
    signed_at: timestamp("signed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * x-forwarded-for or req.ip, captured at signing. Required for
     * UETA / E-SIGN audit trail.
     */
    ip_address: text("ip_address").notNull(),
    /** user-agent string at signing. */
    device_info: text("device_info").notNull(),
    /**
     * For documents requiring a Phes co-signature (Non-Solicitation
     * Agreement, Video/Photo Release). Default-resolved to the tenant
     * owner via getTenantOwnerForSignature() but admin can override.
     */
    representative_user_id: integer("representative_user_id").references(
      () => usersTable.id,
    ),
    representative_signature: text("representative_signature"),
    representative_signature_method: signatureMethodEnum(
      "representative_signature_method",
    ),
    representative_signed_at: timestamp("representative_signed_at", {
      withTimezone: true,
    }),
    representative_ip_address: text("representative_ip_address"),
    representative_device_info: text("representative_device_info"),
    status: signedDocumentStatusEnum("status").notNull().default("active"),
    /**
     * When this signature is superseded by a re-acknowledgment, points
     * to the new lms_signed_documents row. Kept for audit chain.
     */
    superseded_by_id: integer("superseded_by_id"),
    superseded_at: timestamp("superseded_at", { withTimezone: true }),
    /**
     * Storage URL for the generated PDF. Nullable in PR #1; will be
     * populated by the pdf-lib pipeline in PR #3+. URL is opaque (could
     * be S3, could be inline base64 served from /api/lms/signatures/:id/pdf,
     * whichever PR #3 picks).
     */
    pdf_storage_url: text("pdf_storage_url"),
    /**
     * Annual cycle this signature belongs to. Nullable for
     * non-recurring documents (Non-Solicitation, Video Release, Supply
     * Kit) that are signed once at hire. Populated for recurring
     * documents (Handbook, IL Sexual Harassment) so the December
     * sweep can find them.
     */
    cycle_id: integer("cycle_id"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idx_company_user_type: index("lms_signed_documents_company_user_type_idx").on(
      t.company_id,
      t.user_id,
      t.document_type,
    ),
    idx_company_status: index("lms_signed_documents_company_status_idx").on(
      t.company_id,
      t.status,
    ),
    idx_cycle: index("lms_signed_documents_cycle_idx").on(t.cycle_id),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// lms_signature_events — audit log
// ─────────────────────────────────────────────────────────────────────────────

export const lmsSignatureEventsTable = pgTable(
  "lms_signature_events",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    user_id: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    event_type: signatureEventTypeEnum("event_type").notNull(),
    signed_document_id: integer("signed_document_id").references(
      () => lmsSignedDocumentsTable.id,
    ),
    document_type: text("document_type"),
    ip_address: text("ip_address").notNull(),
    user_agent: text("user_agent").notNull(),
    /** Free-form additional event context. */
    event_data: jsonb("event_data"),
    event_at: timestamp("event_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idx_company_user_at: index("lms_signature_events_company_user_at_idx").on(
      t.company_id,
      t.user_id,
      t.event_at,
    ),
    idx_signed_document: index("lms_signature_events_signed_document_idx").on(
      t.signed_document_id,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// lms_completion_certificates — per-module + final exam certs
// ─────────────────────────────────────────────────────────────────────────────

export const lmsCompletionCertificatesTable = pgTable(
  "lms_completion_certificates",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    user_id: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    /**
     * Curriculum module id (e.g. "phes-policies", "il-sexual-harassment").
     * "__final" = the final mixed test certificate.
     * "__handbook" = the final comprehensive handbook PDF signing event.
     */
    module_id: text("module_id").notNull(),
    /**
     * Links to the lms_quiz_attempts row that earned this cert when
     * applicable. Null for content-only modules + the comprehensive
     * handbook certificate.
     */
    quiz_attempt_id: integer("quiz_attempt_id"),
    score: integer("score"), // 0..100, null for content-only
    passed: boolean("passed").notNull(),
    /**
     * Curriculum version hash at issuance. Lets us reproduce what was
     * tested if curriculum drifts.
     */
    curriculum_version_hash: text("curriculum_version_hash"),
    /** Locale the learner completed in. */
    locale: text("locale").notNull(),
    /** IP + device at issuance, mirrored from the underlying quiz/sign event. */
    ip_address: text("ip_address").notNull(),
    device_info: text("device_info").notNull(),
    issued_at: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** PDF storage URL. Populated when the pdf-lib pipeline runs. */
    pdf_storage_url: text("pdf_storage_url"),
    /** When superseded by a re-issuance (annual re-take). */
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    revoked_reason: text("revoked_reason"),
    cycle_id: integer("cycle_id"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idx_company_user_module: index(
      "lms_completion_certificates_company_user_module_idx",
    ).on(t.company_id, t.user_id, t.module_id),
    idx_company_issued: index(
      "lms_completion_certificates_company_issued_idx",
    ).on(t.company_id, t.issued_at),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// lms_annual_ack_cycles — annual re-acknowledgment cycles
// ─────────────────────────────────────────────────────────────────────────────

export const lmsAnnualAckCyclesTable = pgTable(
  "lms_annual_ack_cycles",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    /** 2026, 2027, etc. One cycle per tenant per year. */
    cycle_year: integer("cycle_year").notNull(),
    /** End-of-cycle deadline. Typically Dec 31 23:59 local time. */
    deadline_at: timestamp("deadline_at", { withTimezone: true }).notNull(),
    /**
     * Document types due in this cycle. Drives the annual sweep that
     * pushes employees into re-sign flows. Typically includes the
     * handbook + IL sexual harassment. Other documents (non-solicit,
     * supply kit) are one-time at hire.
     */
    required_documents: jsonb("required_documents").notNull(),
    opened_at: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closed_at: timestamp("closed_at", { withTimezone: true }),
    notes: text("notes"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uq_company_year: uniqueIndex("lms_annual_ack_cycles_company_year_uq").on(
      t.company_id,
      t.cycle_year,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// lms_pending_re_ack — forced immediate re-sign (material changes)
// ─────────────────────────────────────────────────────────────────────────────

export const lmsPendingReAckTable = pgTable(
  "lms_pending_re_ack",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    user_id: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    document_type: text("document_type").notNull(),
    new_version_id: integer("new_version_id")
      .notNull()
      .references(() => lmsDocumentVersionsTable.id),
    new_version_hash: text("new_version_hash").notNull(),
    /**
     * Reason this re-ack was triggered. Typically
     * 'material_content_change' but could be 'admin_force_resign'
     * or 'policy_correction'.
     */
    trigger_reason: text("trigger_reason").notNull(),
    triggered_at: timestamp("triggered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    triggered_by_user_id: integer("triggered_by_user_id").references(
      () => usersTable.id,
    ),
    acknowledged_at: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledged_signed_document_id: integer(
      "acknowledged_signed_document_id",
    ).references(() => lmsSignedDocumentsTable.id),
    /**
     * If the employee is on shift before re-acknowledging, this lets
     * the office grant a temporary deferral. Null = no deferral, must
     * sign before next shift.
     */
    defer_until: timestamp("defer_until", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idx_company_user_pending: index(
      "lms_pending_re_ack_company_user_pending_idx",
    ).on(t.company_id, t.user_id, t.acknowledged_at),
    idx_document_type: index("lms_pending_re_ack_document_type_idx").on(
      t.document_type,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Inferred types — convenient downstream
// ─────────────────────────────────────────────────────────────────────────────

export type LmsDocumentVersion = typeof lmsDocumentVersionsTable.$inferSelect;
export type LmsSignedDocument = typeof lmsSignedDocumentsTable.$inferSelect;
export type LmsSignatureEvent = typeof lmsSignatureEventsTable.$inferSelect;
export type LmsCompletionCertificate =
  typeof lmsCompletionCertificatesTable.$inferSelect;
export type LmsAnnualAckCycle = typeof lmsAnnualAckCyclesTable.$inferSelect;
export type LmsPendingReAck = typeof lmsPendingReAckTable.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Known document types (signed legal documents). Listed here so PR #1
// can validate input on the routes that arrive in PR #2+. Each later PR
// that adds a new document just appends to this array.
// ─────────────────────────────────────────────────────────────────────────────

export const KNOWN_SIGNED_DOCUMENT_TYPES = [
  "handbook",
  "code_of_conduct",
  "drug_alcohol",
  "video_photo_release",
  "non_solicitation",
  "supply_kit",
  "social_media",
] as const;

export type KnownSignedDocumentType =
  (typeof KNOWN_SIGNED_DOCUMENT_TYPES)[number];

/**
 * Documents that require co-signature by a Phes representative (the
 * tenant owner by default). PR #2+ uses this to drive UI + insert flow.
 */
export const CO_SIGNED_DOCUMENT_TYPES = [
  "non_solicitation",
  "video_photo_release",
] as const;

export type CoSignedDocumentType = (typeof CO_SIGNED_DOCUMENT_TYPES)[number];

/**
 * Documents that recur on an annual cycle (December re-acknowledgment).
 * Other documents (non-solicit, supply kit) are one-time at hire.
 */
export const ANNUAL_DOCUMENT_TYPES = [
  "handbook",
  // il-sexual-harassment is tracked as a completion certificate (annual
  // quiz) rather than a signed legal document; it has its own re-issue
  // path via the existing admin Reset action.
] as const;

export type AnnualDocumentType = (typeof ANNUAL_DOCUMENT_TYPES)[number];

/**
 * Standalone legal acknowledgments that an employee must sign BEFORE
 * the final mixed test unlocks. Per phes-2026-policy (PR #4 review):
 * the final exam triggers the comprehensive handbook PDF flow and is
 * not reachable until every legally binding standalone document is
 * captured.
 *
 * `handbook` is NOT in this list — it is signed AFTER the final exam
 * as part of the comprehensive PDF (PR #13).
 *
 * Each successive standalone-signed-document PR (#5 code_of_conduct,
 * #6 video_photo_release, #7 non_solicitation, #8 social_media,
 * #10 supply_kit) appends its slug to this array. Server gating reads
 * directly from it.
 */
export const REQUIRED_PRE_FINAL_SIGNED_DOCS = [
  "drug_alcohol",
  "code_of_conduct",
  "video_photo_release",
  "non_solicitation",
  // PR #8 will add: "social_media"
  // PR #10 will add: "supply_kit"
] as const;

export type RequiredPreFinalSignedDoc =
  (typeof REQUIRED_PRE_FINAL_SIGNED_DOCS)[number];
