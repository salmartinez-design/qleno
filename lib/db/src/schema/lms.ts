/**
 * Qleno LMS — Drizzle schema
 *
 * Per-module quiz LMS replacing the previous single end-of-course quiz.
 * Multi-tenant: every table carries `company_id` for isolation, matching the
 * convention used everywhere else in this repo.
 *
 * Tables (4):
 *   enrollments       — one row per (company, user) currently in the course
 *   module_progress   — one row per (enrollment, module_id) — denormalized so
 *                       the admin roster query is a single join, not a scan
 *                       of quiz_attempts
 *   quiz_state        — autosave snapshot of an in-flight quiz, one row per
 *                       (enrollment, module_id). Updated every ~300 ms while
 *                       the tech is taking the quiz.
 *   quiz_attempts     — immutable history of every submission. Used to derive
 *                       best_score, attempt count, and audit trail.
 *
 * Enums (2):
 *   enrollment_status — active | completed | expired
 *   module_status     — not_started | in_progress | passed | failed
 *
 * Notes:
 * - `module_id` is a text column rather than an enum because the curriculum
 *   may add/remove modules over time. The list of valid IDs lives in the
 *   shared `@workspace/lms-curriculum` package; the DB does not enforce it.
 * - `module_id = "__final"` is the reserved ID for the final mixed test.
 * - Migrations are run via `drizzle-kit push` (no SQL migration files —
 *   matches the rest of `lib/db`).
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
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export const enrollmentStatusEnum = pgEnum("enrollment_status", [
  "active",
  "completed",
  "expired",
]);

export const moduleStatusEnum = pgEnum("module_status", [
  "not_started",
  "in_progress",
  "passed",
  "failed",
]);

// ─────────────────────────────────────────────────────────────────────────────
// enrollments
// ─────────────────────────────────────────────────────────────────────────────

export const lmsEnrollmentsTable = pgTable(
  "lms_enrollments",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    user_id: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    status: enrollmentStatusEnum("status").notNull().default("active"),
    enrolled_at: timestamp("enrolled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * 7 days out from `enrolled_at` by default. Admin can extend (bounded
     * 1–90 days from now) via POST /lms/admin/extend.
     *
     * Item 4 (P0 sprint): the countdown that uses this column should
     * not start until `deadline_started_at` is also set. Until then,
     * the deadline_at value is a placeholder; the UI surfaces "Not yet
     * started" instead of a days-remaining badge.
     */
    deadline_at: timestamp("deadline_at", { withTimezone: true }).notNull(),
    /**
     * Stamped on the FIRST quiz attempt (any module). Until set, the
     * employee hasn't engaged with the LMS at all and the deadline
     * countdown is suppressed in the UI. On first stamping, the
     * /quiz/submit handler also recomputes deadline_at = first_attempt
     * + the configured window (default 7 days). Admin's "Reset
     * deadline" action clears this back to null.
     */
    deadline_started_at: timestamp("deadline_started_at", {
      withTimezone: true,
    }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    /**
     * Stamped on every progress write (module start, quiz autosave, quiz
     * submit, acknowledgment). Powers the "Last activity" column on
     * /lms/admin.
     */
    last_activity_at: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    locale: text("locale"), // 'en' | 'es', null = unspecified
    acknowledgment_signature: text("acknowledgment_signature"),
    acknowledgment_at: timestamp("acknowledgment_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    /**
     * One active enrollment per (company, user). The frontend's grandfather
     * migration relies on this — enrolling an existing tech twice is a no-op.
     */
    uq_company_user: uniqueIndex("lms_enrollments_company_user_uq").on(
      t.company_id,
      t.user_id,
    ),
    idx_company_status: index("lms_enrollments_company_status_idx").on(
      t.company_id,
      t.status,
    ),
    idx_deadline: index("lms_enrollments_deadline_idx").on(t.deadline_at),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// module_progress
// ─────────────────────────────────────────────────────────────────────────────

export const lmsModuleProgressTable = pgTable(
  "lms_module_progress",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    enrollment_id: integer("enrollment_id")
      .notNull()
      .references(() => lmsEnrollmentsTable.id, { onDelete: "cascade" }),
    /**
     * Curriculum module id (e.g. "welcome", "attendance"). The reserved id
     * "__final" is used for the final mixed test.
     */
    module_id: text("module_id").notNull(),
    status: moduleStatusEnum("status").notNull().default("not_started"),
    /**
     * Best percent score across all attempts for this (enrollment, module).
     * Integer 0–100. Default 0 keeps the column non-null with a sensible
     * pre-attempt value.
     */
    best_score: integer("best_score").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    started_at: timestamp("started_at", { withTimezone: true }),
    passed_at: timestamp("passed_at", { withTimezone: true }),
    last_attempt_at: timestamp("last_attempt_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    /**
     * One progress row per (enrollment, module). Inserts use ON CONFLICT
     * DO UPDATE to keep this idempotent.
     */
    uq_enrollment_module: uniqueIndex("lms_module_progress_enrollment_module_uq").on(
      t.enrollment_id,
      t.module_id,
    ),
    idx_company_status: index("lms_module_progress_company_status_idx").on(
      t.company_id,
      t.status,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// quiz_state — autosave
// ─────────────────────────────────────────────────────────────────────────────

export const lmsQuizStateTable = pgTable(
  "lms_quiz_state",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    enrollment_id: integer("enrollment_id")
      .notNull()
      .references(() => lmsEnrollmentsTable.id, { onDelete: "cascade" }),
    module_id: text("module_id").notNull(),
    current_question_index: integer("current_question_index").notNull().default(0),
    /**
     * `answers[i]` is the selected option index for question i, or null if
     * the tech has not picked one yet. Stored as JSONB so partial saves stay
     * cheap and the array length tracks the question count.
     *
     * For the final mixed test, the array also encodes which questions the
     * server randomly served (the question IDs are stored under `question_ids`
     * in `meta` so the resume can replay the same set on a different device).
     */
    answers: jsonb("answers").notNull().default([]),
    /**
     * Free-form metadata. Used for the final mixed test to store the random
     * question id set (`{ question_ids: string[] }`) so cross-device resume
     * sees the same questions.
     */
    meta: jsonb("meta"),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uq_enrollment_module: uniqueIndex("lms_quiz_state_enrollment_module_uq").on(
      t.enrollment_id,
      t.module_id,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// quiz_attempts — immutable submission history
// ─────────────────────────────────────────────────────────────────────────────

export const lmsQuizAttemptsTable = pgTable(
  "lms_quiz_attempts",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    enrollment_id: integer("enrollment_id")
      .notNull()
      .references(() => lmsEnrollmentsTable.id, { onDelete: "cascade" }),
    module_id: text("module_id").notNull(),
    /** Selected option indexes, parallel to the question set served. */
    answers: jsonb("answers").notNull(),
    /**
     * For the final mixed test, the question ids that were scored. Lets us
     * audit a specific attempt later if curriculum changes.
     */
    question_ids: jsonb("question_ids"),
    score: integer("score").notNull(), // percent 0–100
    passed: boolean("passed").notNull(),
    attempted_at: timestamp("attempted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Phes admin-view-consistency sprint (2026-05-15). When true, the
     * attempt is excluded from the visible-attempts count + the
     * non-superseded best-score recomputation. Set by the supersession
     * backfill migration on legacy rows that predate the per-module
     * attempt cap, and by future cap-enforcement on write if the cap
     * ever changes mid-flight. Immutable history is preserved (no
     * DELETE), but cap math now respects it.
     */
    superseded: boolean("superseded").notNull().default(false),
    superseded_reason: text("superseded_reason"),
    superseded_at: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => ({
    idx_enrollment_module_attempted: index(
      "lms_quiz_attempts_enrollment_module_attempted_idx",
    ).on(t.enrollment_id, t.module_id, t.attempted_at),
    idx_company_attempted: index("lms_quiz_attempts_company_attempted_idx").on(
      t.company_id,
      t.attempted_at,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Insert / select schemas (drizzle-zod) — match the convention used by other
// schema files in this repo. We do NOT enforce these in the routes (no Zod
// validation per project convention), but they're useful for type-level
// contracts in services.
// ─────────────────────────────────────────────────────────────────────────────

export const insertLmsEnrollmentSchema = createInsertSchema(lmsEnrollmentsTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export const insertLmsModuleProgressSchema = createInsertSchema(
  lmsModuleProgressTable,
).omit({ id: true, created_at: true, updated_at: true });

export const insertLmsQuizStateSchema = createInsertSchema(lmsQuizStateTable).omit({
  id: true,
  updated_at: true,
});

export const insertLmsQuizAttemptSchema = createInsertSchema(
  lmsQuizAttemptsTable,
).omit({ id: true, attempted_at: true });

export type LmsEnrollment = typeof lmsEnrollmentsTable.$inferSelect;
export type LmsModuleProgress = typeof lmsModuleProgressTable.$inferSelect;
export type LmsQuizState = typeof lmsQuizStateTable.$inferSelect;
export type LmsQuizAttempt = typeof lmsQuizAttemptsTable.$inferSelect;

// Re-export zod for downstream callers that want to compose schemas
export { z };
