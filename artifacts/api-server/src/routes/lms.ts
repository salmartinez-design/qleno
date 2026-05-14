/**
 * LMS routes — per-module quiz LMS for Qleno.
 *
 * Replaces the previous frontend-only single end-of-course quiz. Persists
 * enrollment, per-module progress, in-flight quiz state (autosaved every
 * 300 ms by the client), and immutable submission history.
 *
 * Endpoints (mounted at /api/lms):
 *   POST   /enroll                   self-enroll the calling user (idempotent)
 *   GET    /me                       full state for the calling user
 *   POST   /module/start             mark a module as in_progress
 *   GET    /quiz/state               resume an in-flight quiz (cross-device)
 *   POST   /quiz/state               autosave answers + cursor
 *   POST   /quiz/submit              score + persist a submission; fire webhooks
 *   POST   /module/acknowledge       advance a content-only module (or final ack)
 *   POST   /grandfather              one-shot migrate an existing tech (idempotent)
 *   GET    /admin/learners           Owner+Admin roster view (403 otherwise)
 *   POST   /admin/extend             Owner+Admin: extend a learner's deadline
 *
 * Auth: every endpoint requires a valid JWT (`requireAuth`). Admin endpoints
 * additionally require role IN ('owner', 'admin') — `requireRole`.
 *
 * Tenancy: all queries filter by req.auth.companyId. A user from company A
 * can never see, modify, or score against an enrollment from company B.
 *
 * Webhooks: when a module quiz passes we fire `module_complete`. When the
 * final mixed test passes we fire `all_complete`. Webhook URL is read from
 * MAKE_LMS_WEBHOOK_URL — never hardcoded. Webhook firing is fire-and-forget;
 * a webhook failure must not block the user-visible response.
 *
 * Validation: per repo convention, no Zod. We coerce/sanity-check inline
 * and reject malformed bodies with a 400.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import {
  lmsEnrollmentsTable,
  lmsModuleProgressTable,
  lmsQuizStateTable,
  lmsQuizAttemptsTable,
  usersTable,
  type LmsEnrollment,
  type LmsModuleProgress,
} from "@workspace/db/schema";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import {
  MODULE_ORDER,
  QUIZ_MODULE_IDS,
  QUESTIONS_BY_MODULE,
  FINAL_MODULE_ID,
  FINAL_TEST_SIZE,
  QUIZ_PASS_THRESHOLD,
  MAX_MODULE_ATTEMPTS,
  MAX_FINAL_ATTEMPTS,
  maxAttemptsFor,
  isModuleUnlocked,
  isFinalUnlocked,
  sampleFinalQuestionIds,
  scoreQuiz,
  type ModuleId,
} from "@workspace/lms-curriculum";
import { SERVER_ANSWER_KEY } from "@workspace/training";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { addDays, daysUntil, fireLmsWebhook } from "../lib/lms-helpers.js";
import { isEnrollmentTrulyComplete } from "../lib/lms-completion.js";
import {
  captureRequestMetadata,
  parseMinimalDeviceInfo,
} from "../lib/lms-signatures.js";
import { getMissingRequiredSignedDocs } from "../lib/lms-signatures-db.js";
import { issueCertificate } from "../lib/lms-certificates.js";

const router = Router();
// Re-export so existing callers (and any future module that wants the
// webhook firing without the route file) can keep working.
export { fireLmsWebhook };

// ─────────────────────────────────────────────────────────────────────────────
// Constants & helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Default deadline = 7 days from enrollment, per spec. */
const DEFAULT_DEADLINE_DAYS = 7;
/** Admin extend bounds (days from now), per spec. */
const MIN_EXTEND_DAYS = 1;
const MAX_EXTEND_DAYS = 90;

/** Set of module ids that have graded quizzes. */
const QUIZ_MODULE_SET = new Set<string>(QUIZ_MODULE_IDS);
/** Set of every legitimate module id, including the final-test pseudo-id. */
const KNOWN_MODULE_IDS = new Set<string>([...MODULE_ORDER, FINAL_MODULE_ID]);

function isQuizModuleId(id: string): boolean {
  return QUIZ_MODULE_SET.has(id);
}

function isContentOnlyModule(id: string): boolean {
  // Modules that are in MODULE_ORDER but not in QUIZ_MODULE_IDS — currently
  // qleno-app and acknowledgment.
  return (
    (MODULE_ORDER as readonly string[]).includes(id) && !QUIZ_MODULE_SET.has(id)
  );
}

/**
 * Resolve (or lazily create) the enrollment row for the calling user. Used
 * by the /me endpoint and the autosave endpoints so a tech who lands on
 * the LMS without explicitly enrolling still gets a row created.
 */
async function getOrCreateEnrollment(
  companyId: number,
  userId: number,
  now: Date = new Date(),
): Promise<LmsEnrollment> {
  const existing = await db
    .select()
    .from(lmsEnrollmentsTable)
    .where(
      and(
        eq(lmsEnrollmentsTable.company_id, companyId),
        eq(lmsEnrollmentsTable.user_id, userId),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];
  const inserted = await db
    .insert(lmsEnrollmentsTable)
    .values({
      company_id: companyId,
      user_id: userId,
      status: "active",
      enrolled_at: now,
      deadline_at: addDays(now, DEFAULT_DEADLINE_DAYS),
      last_activity_at: now,
    })
    .returning();
  return inserted[0];
}

/**
 * Stamp `last_activity_at` for an enrollment. Called on every progress
 * write (start, autosave, submit, acknowledge) so the admin roster shows
 * a useful "last activity" timestamp.
 */
async function touchEnrollment(enrollmentId: number, now: Date = new Date()): Promise<void> {
  await db
    .update(lmsEnrollmentsTable)
    .set({ last_activity_at: now, updated_at: now })
    .where(eq(lmsEnrollmentsTable.id, enrollmentId));
}

/**
 * Read all module-progress rows for an enrollment. Used to compute gating
 * on every state-returning endpoint.
 */
async function loadProgress(enrollmentId: number): Promise<LmsModuleProgress[]> {
  return db
    .select()
    .from(lmsModuleProgressTable)
    .where(eq(lmsModuleProgressTable.enrollment_id, enrollmentId));
}

/** Module ids that have status='passed'. */
function completedModuleIds(progress: readonly LmsModuleProgress[]): string[] {
  return progress.filter((p) => p.status === "passed").map((p) => p.module_id);
}

/**
 * Upsert a module_progress row. Drizzle pg dialect supports
 * .onConflictDoUpdate; we key on (enrollment_id, module_id).
 */
async function upsertModuleProgress(args: {
  companyId: number;
  enrollmentId: number;
  moduleId: string;
  patch: Partial<{
    status: "not_started" | "in_progress" | "passed" | "failed";
    best_score: number;
    attempts: number;
    started_at: Date;
    passed_at: Date | null;
    last_attempt_at: Date | null;
  }>;
  now: Date;
}): Promise<LmsModuleProgress> {
  const { companyId, enrollmentId, moduleId, patch, now } = args;
  // The unique index lms_module_progress_enrollment_module_uq makes
  // INSERT ... ON CONFLICT DO UPDATE the cleanest path. Defaults are picked
  // up from the schema for unspecified columns.
  const inserted = await db
    .insert(lmsModuleProgressTable)
    .values({
      company_id: companyId,
      enrollment_id: enrollmentId,
      module_id: moduleId,
      status: patch.status ?? "not_started",
      best_score: patch.best_score ?? 0,
      attempts: patch.attempts ?? 0,
      started_at: patch.started_at ?? null,
      passed_at: patch.passed_at ?? null,
      last_attempt_at: patch.last_attempt_at ?? null,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        lmsModuleProgressTable.enrollment_id,
        lmsModuleProgressTable.module_id,
      ],
      set: {
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.best_score !== undefined && {
          // Keep the highest score across attempts.
          best_score: sql`GREATEST(${lmsModuleProgressTable.best_score}, ${patch.best_score})`,
        }),
        ...(patch.attempts !== undefined && {
          attempts: sql`${lmsModuleProgressTable.attempts} + 1`,
        }),
        ...(patch.started_at !== undefined && { started_at: patch.started_at }),
        ...(patch.passed_at !== undefined && { passed_at: patch.passed_at }),
        ...(patch.last_attempt_at !== undefined && {
          last_attempt_at: patch.last_attempt_at,
        }),
        updated_at: now,
      },
    })
    .returning();
  return inserted[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /enroll — self-enroll (idempotent)
// ─────────────────────────────────────────────────────────────────────────────
//
// Body: { locale?: 'en' | 'es' }
//
// Idempotent: if the user already has an enrollment, returns it unchanged.
// Useful for the frontend's "land on /training, ensure I'm enrolled" flow.

router.post("/enroll", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const userId = req.auth!.userId;
    const locale = req.body?.locale === "es" ? "es" : req.body?.locale === "en" ? "en" : null;

    const now = new Date();
    const enrollment = await getOrCreateEnrollment(companyId, userId, now);
    if (locale && enrollment.locale !== locale) {
      const updated = await db
        .update(lmsEnrollmentsTable)
        .set({ locale, updated_at: now })
        .where(eq(lmsEnrollmentsTable.id, enrollment.id))
        .returning();
      return res.json({ data: updated[0] });
    }
    return res.json({ data: enrollment });
  } catch (err) {
    console.error("[lms] /enroll error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to enroll" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /me — caller's full LMS state
// ─────────────────────────────────────────────────────────────────────────────
//
// Returns:
//   { enrollment, progress: ModuleProgress[], unlocked: { [moduleId]: bool,
//     __final: bool }, days_remaining: number }
//
// Lazy-creates the enrollment if missing — first hit on the LMS page enrolls
// the user automatically. This keeps the frontend's grandfather migration
// simple (it just calls /me once).

router.get("/me", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const userId = req.auth!.userId;
    const now = new Date();

    let enrollment = await getOrCreateEnrollment(companyId, userId, now);
    const progress = await loadProgress(enrollment.id);
    const completed = completedModuleIds(progress);

    const unlocked: Record<string, boolean> = {};
    for (const m of MODULE_ORDER) {
      unlocked[m] = isModuleUnlocked(m, completed);
    }
    // PR #4: the final exam also requires every standalone signed
    // acknowledgment to be in place. We compute the missing list and
    // bake it into the unlocked flag too, so the existing frontend
    // sequential-gating logic naturally treats the final card as
    // locked when signed docs are pending. The frontend also reads
    // missing_required_signed_docs directly to show WHAT'S missing.
    const missingSignedDocs = await getMissingRequiredSignedDocs(
      companyId,
      userId,
    );
    unlocked[FINAL_MODULE_ID] =
      isFinalUnlocked(completed) && missingSignedDocs.length === 0;

    // Bug-fix sprint #2: stale enrollment.status='completed' rows from
    // earlier curriculum eras must not bypass the current gates. If the
    // cached column lies, lazily heal it here AND set a one-shot flag
    // so the frontend can show a friendly "we expanded the requirements"
    // banner. The flag is computed; not persisted on the row.
    let statusWasRecomputed = false;
    if (enrollment.status === "completed") {
      const truth = await isEnrollmentTrulyComplete(companyId, userId);
      if (!truth.complete) {
        await db
          .update(lmsEnrollmentsTable)
          .set({ status: "active", completed_at: null, updated_at: now })
          .where(eq(lmsEnrollmentsTable.id, enrollment.id));
        enrollment = {
          ...enrollment,
          status: "active",
          completed_at: null,
          updated_at: now,
        };
        statusWasRecomputed = true;
      }
    }

    const limits: Record<string, number> = {};
    for (const m of MODULE_ORDER) limits[m] = MAX_MODULE_ATTEMPTS;
    limits[FINAL_MODULE_ID] = MAX_FINAL_ATTEMPTS;

    // Bypass capability: owners, admins, and office staff can skip
    // modules. This `is_owner` field is kept for the existing frontend
    // prop name; semantically it now means "can_bypass".
    const canBypass =
      req.auth!.role === "owner" ||
      req.auth!.role === "admin" ||
      req.auth!.role === "office";

    return res.json({
      data: {
        enrollment,
        progress,
        unlocked,
        days_remaining: daysUntil(enrollment.deadline_at, now),
        limits,
        is_owner: canBypass,
        missing_required_signed_docs: missingSignedDocs,
        can_bypass: canBypass,
        status_was_recomputed: statusWasRecomputed,
      },
    });
  } catch (err) {
    console.error("[lms] /me error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to load LMS state" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /module/start — mark a module as in_progress
// ─────────────────────────────────────────────────────────────────────────────
//
// Body: { moduleId }
// 403 if the module is locked by sequential gating.

router.post("/module/start", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const userId = req.auth!.userId;
    const moduleId: string | undefined = req.body?.moduleId;
    if (typeof moduleId !== "string" || !KNOWN_MODULE_IDS.has(moduleId)) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "Unknown moduleId" });
    }
    const now = new Date();

    const enrollment = await getOrCreateEnrollment(companyId, userId, now);
    const progress = await loadProgress(enrollment.id);
    const completed = completedModuleIds(progress);

    if (moduleId === FINAL_MODULE_ID) {
      if (!isFinalUnlocked(completed)) {
        return res.status(403).json({
          error: "Forbidden",
          message: "Final mixed test is locked — finish all modules first",
        });
      }
    } else if (!isModuleUnlocked(moduleId, completed)) {
      return res.status(403).json({
        error: "Forbidden",
        message: `Module "${moduleId}" is locked — pass the prior module first`,
      });
    }

    const row = await upsertModuleProgress({
      companyId,
      enrollmentId: enrollment.id,
      moduleId,
      patch: {
        status: "in_progress",
        started_at: now,
      },
      now,
    });
    await touchEnrollment(enrollment.id, now);
    return res.json({ data: row });
  } catch (err) {
    console.error("[lms] /module/start error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to start module" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /quiz/state — cross-device resume
// ─────────────────────────────────────────────────────────────────────────────
//
// Query: ?moduleId=...
// Returns an existing autosave row, or null if the tech has not started this
// module's quiz on any device. For the final mixed test, the row's `meta`
// also carries the question_ids the server served originally so resuming on
// a different device sees the same set.

router.get("/quiz/state", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const userId = req.auth!.userId;
    const moduleId = String(req.query.moduleId ?? "");
    if (!KNOWN_MODULE_IDS.has(moduleId)) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "Unknown moduleId" });
    }

    const enrollment = await getOrCreateEnrollment(companyId, userId);
    const rows = await db
      .select()
      .from(lmsQuizStateTable)
      .where(
        and(
          eq(lmsQuizStateTable.enrollment_id, enrollment.id),
          eq(lmsQuizStateTable.module_id, moduleId),
        ),
      )
      .limit(1);

    return res.json({ data: rows[0] ?? null });
  } catch (err) {
    console.error("[lms] GET /quiz/state error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to load quiz state" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /quiz/state — autosave
// ─────────────────────────────────────────────────────────────────────────────
//
// Body: { moduleId, currentQuestionIndex, answers: (number|null)[],
//         questionIds?: string[] }
//
// Called every ~300 ms by the client (debounced). Idempotent upsert into
// lms_quiz_state, keyed on (enrollment, module). Stamps last_activity_at.
// `questionIds` is required for the final mixed test (so resume sees the
// same questions); optional for fixed-set per-module quizzes.

router.post("/quiz/state", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const userId = req.auth!.userId;
    const moduleId: string | undefined = req.body?.moduleId;
    const currentQuestionIndex = Number(req.body?.currentQuestionIndex ?? 0);
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const questionIds: string[] | undefined = Array.isArray(req.body?.questionIds)
      ? req.body.questionIds
      : undefined;

    if (typeof moduleId !== "string" || !KNOWN_MODULE_IDS.has(moduleId)) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "Unknown moduleId" });
    }
    if (!Number.isFinite(currentQuestionIndex) || currentQuestionIndex < 0) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "Invalid currentQuestionIndex" });
    }
    const now = new Date();

    const enrollment = await getOrCreateEnrollment(companyId, userId, now);

    // Upsert state row keyed on (enrollment, module).
    const inserted = await db
      .insert(lmsQuizStateTable)
      .values({
        company_id: companyId,
        enrollment_id: enrollment.id,
        module_id: moduleId,
        current_question_index: currentQuestionIndex,
        answers,
        meta: questionIds ? { question_ids: questionIds } : null,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [
          lmsQuizStateTable.enrollment_id,
          lmsQuizStateTable.module_id,
        ],
        set: {
          current_question_index: currentQuestionIndex,
          answers,
          // Only overwrite meta if the caller provided one — preserves the
          // original served question_ids for the final test resume case.
          ...(questionIds && {
            meta: { question_ids: questionIds },
          }),
          updated_at: now,
        },
      })
      .returning();

    await touchEnrollment(enrollment.id, now);
    return res.json({ data: inserted[0] });
  } catch (err) {
    console.error("[lms] POST /quiz/state error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to autosave quiz state" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /quiz/submit — score and persist a submission
// ─────────────────────────────────────────────────────────────────────────────
//
// Body: { moduleId, answers: number[], questionIds?: string[] }
//
// For per-module quizzes: questionIds is optional; the server uses the full
// list from QUESTIONS_BY_MODULE[moduleId] as the source of truth.
//
// For the final mixed test (moduleId === '__final'): questionIds is REQUIRED
// (the client echoes the set the server originally served via /quiz/state's
// meta); the server scores against those.
//
// Server-authoritative scoring uses SERVER_ANSWER_KEY. If the score meets
// QUIZ_PASS_THRESHOLD, marks the module as passed, fires module_complete (or
// all_complete for __final), and on all_complete marks the enrollment as
// completed.

router.post("/quiz/submit", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const userId = req.auth!.userId;
    const moduleId: string | undefined = req.body?.moduleId;
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : null;
    const clientQuestionIds: string[] | undefined = Array.isArray(req.body?.questionIds)
      ? req.body.questionIds
      : undefined;

    if (typeof moduleId !== "string" || !KNOWN_MODULE_IDS.has(moduleId)) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "Unknown moduleId" });
    }
    if (!answers) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "answers must be an array" });
    }

    let questionIds: string[];
    if (moduleId === FINAL_MODULE_ID) {
      if (!clientQuestionIds || clientQuestionIds.length === 0) {
        return res.status(400).json({
          error: "Bad Request",
          message: "questionIds is required for the final mixed test",
        });
      }
      questionIds = clientQuestionIds;
    } else if (isQuizModuleId(moduleId)) {
      questionIds = [...QUESTIONS_BY_MODULE[moduleId as Exclude<ModuleId, "acknowledgment">]];
    } else {
      // Content-only module — submit makes no sense; route them to acknowledge.
      return res.status(400).json({
        error: "Bad Request",
        message: `Module "${moduleId}" has no quiz; use /lms/module/acknowledge`,
      });
    }

    const now = new Date();
    const enrollment = await getOrCreateEnrollment(companyId, userId, now);
    const progress = await loadProgress(enrollment.id);
    const completed = completedModuleIds(progress);

    // Gate: per-module quizzes follow MODULE_ORDER; final test needs every
    // preceding module complete.
    if (moduleId === FINAL_MODULE_ID) {
      if (!isFinalUnlocked(completed)) {
        return res.status(403).json({
          error: "Forbidden",
          message: "Final mixed test is locked",
        });
      }
      // PR #4 policy: final exam additionally requires every standalone
      // signed acknowledgment to be in place. Bypass: owners / admins /
      // office are exempt from this gate (they don't need to sign their
      // own training to take the exam).
      const callerRole = req.auth!.role;
      const exemptFromSignGate =
        callerRole === "owner" ||
        callerRole === "admin" ||
        callerRole === "office" ||
        callerRole === "super_admin";
      if (!exemptFromSignGate) {
        const missing = await getMissingRequiredSignedDocs(companyId, userId);
        if (missing.length > 0) {
          return res.status(403).json({
            error: "Forbidden",
            message:
              "Final mixed test is locked: sign all required acknowledgments first",
            missing_required_signed_docs: missing,
          });
        }
      }
    } else if (!isModuleUnlocked(moduleId, completed)) {
      return res.status(403).json({
        error: "Forbidden",
        message: `Module "${moduleId}" is locked`,
      });
    }

    // Attempts gate: 3 per module, 4 for the final. Owners / admins / office
    // staff are exempt — they can still submit but the cap doesn't apply to
    // them. Already-passed modules are also exempt (re-takes for review).
    const canBypassCap =
      req.auth!.role === "owner" ||
      req.auth!.role === "admin" ||
      req.auth!.role === "office";
    const existing = progress.find((p) => p.module_id === moduleId);
    const attemptsSoFar = existing?.attempts ?? 0;
    const alreadyPassed = existing?.status === "passed";
    const maxAttempts = maxAttemptsFor(moduleId);
    if (!canBypassCap && !alreadyPassed && attemptsSoFar >= maxAttempts) {
      return res.status(403).json({
        error: "Forbidden",
        message:
          moduleId === FINAL_MODULE_ID
            ? `You've used all ${maxAttempts} final-exam attempts. Ask your admin to extend or bypass.`
            : `You've used all ${maxAttempts} attempts on this module. Ask your admin to extend or bypass.`,
        attempts_used: attemptsSoFar,
        max_attempts: maxAttempts,
      });
    }

    // Server-authoritative scoring.
    const result = scoreQuiz(answers, questionIds, QUIZ_PASS_THRESHOLD, SERVER_ANSWER_KEY);

    // Always insert the immutable attempt row first.
    const attemptInsert = await db
      .insert(lmsQuizAttemptsTable)
      .values({
        company_id: companyId,
        enrollment_id: enrollment.id,
        module_id: moduleId,
        answers,
        question_ids: moduleId === FINAL_MODULE_ID ? questionIds : null,
        score: result.score,
        passed: result.passed,
        attempted_at: now,
      })
      .returning({ id: lmsQuizAttemptsTable.id });
    const quizAttemptId = attemptInsert[0]?.id ?? null;

    // Update module_progress: bump attempts, update best_score, set passed_at
    // if this attempt cleared the bar (and the module wasn't already passed).
    const passedNow = result.passed;
    await upsertModuleProgress({
      companyId,
      enrollmentId: enrollment.id,
      moduleId,
      patch: {
        status: passedNow ? "passed" : "failed",
        best_score: result.score,
        attempts: 1, // sql adds, not assigns — see helper
        last_attempt_at: now,
        ...(passedNow ? { passed_at: now } : {}),
      },
      now,
    });

    // Clear autosave state after every submit — pass or fail — so the next
    // entry to the module starts from a blank slate. Without this, a failed
    // attempt's answers reload on the next visit (and on a different device)
    // and the learner ends up re-submitting the same wrong answers without
    // realizing it. (Bug surfaced by Dispatch 2026-05-11.)
    await db
      .delete(lmsQuizStateTable)
      .where(
        and(
          eq(lmsQuizStateTable.enrollment_id, enrollment.id),
          eq(lmsQuizStateTable.module_id, moduleId),
        ),
      );
    await touchEnrollment(enrollment.id, now);

    // Phase 12: issue a completion certificate on every successful pass.
    // Historical rows stay (no auto-revoke); the most recent active row
    // is the "current" cert. PDF is rendered on download, not stored
    // here. Tenant-scoped by company_id at the row level.
    let issuedCertId: number | null = null;
    if (passedNow) {
      try {
        const meta = captureRequestMetadata(req);
        const cert = await issueCertificate({
          companyId,
          userId,
          moduleId,
          score: result.score,
          passed: true,
          locale: enrollment.locale === "es" ? "es" : "en",
          ipAddress: meta.ip_address,
          deviceInfo: parseMinimalDeviceInfo(meta.user_agent),
          quizAttemptId,
        });
        issuedCertId = cert.id;
      } catch (err) {
        // A cert-issue failure must not block the user's pass response.
        console.error("[lms] cert issuance failed (non-fatal):", err);
      }
    }

    // Webhook fire — do this AFTER all DB writes commit, but before the
    // response so we can still surface a logged failure. Fire-and-forget so
    // a slow webhook doesn't slow the response.
    if (passedNow) {
      const webhookPayload = {
        company_id: companyId,
        user_id: userId,
        enrollment_id: enrollment.id,
        module_id: moduleId,
        score: result.score,
        attempted_at: now.toISOString(),
      };
      if (moduleId === FINAL_MODULE_ID) {
        // Bug-fix sprint #2: passing the final exam alone is not enough
        // to mark the enrollment "completed". The curriculum may have
        // grown (new modules, new required acks) since this learner
        // started, so we re-check the full truth gate before stamping.
        const truth = await isEnrollmentTrulyComplete(companyId, userId);
        if (truth.complete) {
          await db
            .update(lmsEnrollmentsTable)
            .set({
              status: "completed",
              completed_at: now,
              updated_at: now,
            })
            .where(eq(lmsEnrollmentsTable.id, enrollment.id));
          void fireLmsWebhook("all_complete", webhookPayload);
        } else {
          // Final pass recorded, but more prerequisites remain. Stay
          // on the standard module_complete webhook so downstream
          // consumers don't get a false "all_complete" signal.
          void fireLmsWebhook("module_complete", webhookPayload);
        }
      } else {
        void fireLmsWebhook("module_complete", webhookPayload);
      }
    }

    await logAudit(
      req,
      passedNow ? "lms.quiz.pass" : "lms.quiz.fail",
      "lms_enrollment",
      enrollment.id,
      null,
      { module_id: moduleId, score: result.score },
    );

    const attemptsAfter = attemptsSoFar + 1;
    return res.json({
      data: {
        score: result.score,
        passed: result.passed,
        correctCount: result.correctCount,
        totalCount: result.totalCount,
        // Do NOT echo correct answers for the final test — frontend never
        // sees them per spec. For per-module, it's already in the bundle so
        // there's no secret to keep.
        perQuestion: moduleId === FINAL_MODULE_ID ? undefined : result.perQuestion,
        attempts_used: attemptsAfter,
        max_attempts: maxAttempts,
        attempts_remaining: Math.max(0, maxAttempts - attemptsAfter),
        certificate_id: issuedCertId,
      },
    });
  } catch (err) {
    console.error("[lms] /quiz/submit error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to submit quiz" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /module/acknowledge — advance a content-only module
// ─────────────────────────────────────────────────────────────────────────────
//
// Body: { moduleId, signature?: string }
//
// For content-only modules (qleno-app, acknowledgment), this is what
// advances them. For the acknowledgment module specifically, requires a
// non-empty `signature` string and stamps the enrollment with the typed
// signature. Quiz modules do NOT use this — they use /quiz/submit.

router.post("/module/acknowledge", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const userId = req.auth!.userId;
    const moduleId: string | undefined = req.body?.moduleId;
    const signature: string | undefined = req.body?.signature;

    if (typeof moduleId !== "string" || !KNOWN_MODULE_IDS.has(moduleId)) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "Unknown moduleId" });
    }
    if (isQuizModuleId(moduleId) || moduleId === FINAL_MODULE_ID) {
      return res.status(400).json({
        error: "Bad Request",
        message: `Module "${moduleId}" has a quiz; use /lms/quiz/submit`,
      });
    }
    if (moduleId === "acknowledgment" && (!signature || signature.trim().length < 2)) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Acknowledgment requires a typed signature",
      });
    }

    const now = new Date();
    const enrollment = await getOrCreateEnrollment(companyId, userId, now);
    const progress = await loadProgress(enrollment.id);
    const completed = completedModuleIds(progress);

    if (!isModuleUnlocked(moduleId, completed)) {
      return res.status(403).json({
        error: "Forbidden",
        message: `Module "${moduleId}" is locked`,
      });
    }

    await upsertModuleProgress({
      companyId,
      enrollmentId: enrollment.id,
      moduleId,
      patch: {
        status: "passed",
        passed_at: now,
        best_score: 100, // content-only modules count as 100% on ack
      },
      now,
    });

    if (moduleId === "acknowledgment") {
      await db
        .update(lmsEnrollmentsTable)
        .set({
          acknowledgment_signature: signature!.trim(),
          acknowledgment_at: now,
          updated_at: now,
        })
        .where(eq(lmsEnrollmentsTable.id, enrollment.id));
    }

    await touchEnrollment(enrollment.id, now);

    // Phase 12: issue a completion certificate for content-only modules
    // (e.g. qleno-app, acknowledgment). No score because there's no quiz.
    let issuedCertId: number | null = null;
    try {
      const meta = captureRequestMetadata(req);
      const cert = await issueCertificate({
        companyId,
        userId,
        moduleId,
        score: null,
        passed: true,
        locale: enrollment.locale === "es" ? "es" : "en",
        ipAddress: meta.ip_address,
        deviceInfo: parseMinimalDeviceInfo(meta.user_agent),
        quizAttemptId: null,
      });
      issuedCertId = cert.id;
    } catch (err) {
      console.error("[lms] cert issuance failed on acknowledge (non-fatal):", err);
    }

    await logAudit(
      req,
      "lms.module.acknowledge",
      "lms_enrollment",
      enrollment.id,
      null,
      { module_id: moduleId },
    );

    return res.json({ data: { ok: true, certificate_id: issuedCertId } });
  } catch (err) {
    console.error("[lms] /module/acknowledge error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to acknowledge module" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /grandfather — one-shot migration for existing techs
// ─────────────────────────────────────────────────────────────────────────────
//
// The frontend calls this on first load after the per-module rollout. The
// previous LMS persisted progress in localStorage as a flat
// `completedModules: string[]`. The frontend reads localStorage, then POSTs
// the array here. The server creates an enrollment if missing and seeds
// passing module_progress rows for every legacy module the tech had
// completed. Idempotent — safe to call multiple times.
//
// Body: { completedModules?: string[], acknowledged?: boolean,
//         acknowledgmentName?: string }

router.post("/grandfather", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const userId = req.auth!.userId;
    const completedModules: string[] = Array.isArray(req.body?.completedModules)
      ? req.body.completedModules.filter((s: unknown) => typeof s === "string")
      : [];
    const acknowledged = !!req.body?.acknowledged;
    const acknowledgmentName: string | null =
      typeof req.body?.acknowledgmentName === "string"
        ? req.body.acknowledgmentName.trim() || null
        : null;

    const now = new Date();
    const enrollment = await getOrCreateEnrollment(companyId, userId, now);

    // Seed progress rows for every legacy completed module that we recognize.
    for (const m of completedModules) {
      if (!(MODULE_ORDER as readonly string[]).includes(m)) continue;
      await upsertModuleProgress({
        companyId,
        enrollmentId: enrollment.id,
        moduleId: m,
        patch: {
          status: "passed",
          best_score: 100,
          passed_at: now,
        },
        now,
      });
    }

    // If the tech had previously acknowledged on the old LMS, port that over.
    if (acknowledged && acknowledgmentName) {
      await db
        .update(lmsEnrollmentsTable)
        .set({
          acknowledgment_signature: acknowledgmentName,
          acknowledgment_at: enrollment.acknowledgment_at ?? now,
          updated_at: now,
        })
        .where(eq(lmsEnrollmentsTable.id, enrollment.id));

      await upsertModuleProgress({
        companyId,
        enrollmentId: enrollment.id,
        moduleId: "acknowledgment",
        patch: {
          status: "passed",
          best_score: 100,
          passed_at: now,
        },
        now,
      });
    }

    await touchEnrollment(enrollment.id, now);
    await logAudit(
      req,
      "lms.grandfather",
      "lms_enrollment",
      enrollment.id,
      null,
      { module_count: completedModules.length, acknowledged },
    );

    return res.json({ data: { ok: true, enrollment_id: enrollment.id } });
  } catch (err) {
    console.error("[lms] /grandfather error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to grandfather progress" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/learners — Owner+Admin only
// ─────────────────────────────────────────────────────────────────────────────
//
// Returns roster rows for the calling user's tenant: tech name, % progress,
// days remaining, current module, last activity. Powers the /lms/admin
// page.

router.get(
  "/admin/learners",
  requireAuth,
  requireRole("owner", "admin", "office"),
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      if (companyId == null) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "User has no company assignment" });
      }

      const enrollments = await db
        .select({
          id: lmsEnrollmentsTable.id,
          user_id: lmsEnrollmentsTable.user_id,
          status: lmsEnrollmentsTable.status,
          enrolled_at: lmsEnrollmentsTable.enrolled_at,
          deadline_at: lmsEnrollmentsTable.deadline_at,
          completed_at: lmsEnrollmentsTable.completed_at,
          last_activity_at: lmsEnrollmentsTable.last_activity_at,
          first_name: usersTable.first_name,
          last_name: usersTable.last_name,
          role: usersTable.role,
        })
        .from(lmsEnrollmentsTable)
        .innerJoin(
          usersTable,
          eq(usersTable.id, lmsEnrollmentsTable.user_id),
        )
        .where(eq(lmsEnrollmentsTable.company_id, companyId))
        .orderBy(desc(lmsEnrollmentsTable.last_activity_at));

      if (enrollments.length === 0) {
        return res.json({ data: [] });
      }

      const enrollmentIds = enrollments.map((e) => e.id);
      const progressRows =
        enrollmentIds.length > 0
          ? await db
              .select()
              .from(lmsModuleProgressTable)
              .where(inArray(lmsModuleProgressTable.enrollment_id, enrollmentIds))
          : [];

      const progressByEnrollment = new Map<number, LmsModuleProgress[]>();
      for (const p of progressRows) {
        const arr = progressByEnrollment.get(p.enrollment_id) ?? [];
        arr.push(p);
        progressByEnrollment.set(p.enrollment_id, arr);
      }

      const now = new Date();
      // Total modules used in the % progress calc = count of MODULE_ORDER
      // (every module a learner must clear). The final mixed test is
      // a separate gate and is NOT in this percentage.
      const totalModules = MODULE_ORDER.length;

      const rows = enrollments.map((e) => {
        const progress = progressByEnrollment.get(e.id) ?? [];
        // Count only modules in MODULE_ORDER toward the percentage — the
        // final mixed test is a SEPARATE gate. Without this filter a learner
        // who passed all 6 modules + the final test reported 7/6 = 117%.
        const passedCount = progress.filter(
          (p) =>
            p.status === "passed" &&
            (MODULE_ORDER as readonly string[]).includes(p.module_id),
        ).length;
        const passedRatio = totalModules > 0 ? passedCount / totalModules : 0;
        const completed = progress
          .filter((p) => p.status === "passed")
          .map((p) => p.module_id);

        let currentModule: string | null = null;
        for (const m of MODULE_ORDER) {
          if (!completed.includes(m)) {
            currentModule = m;
            break;
          }
        }
        if (currentModule === null && isFinalUnlocked(completed)) {
          currentModule = FINAL_MODULE_ID;
        }

        // Per-module attempt + status snapshot keyed by module_id so the
        // admin UI can render "2/3 attempts" or "passed" without an extra
        // round trip. Includes `__final` if the learner has touched it.
        const modules: Record<
          string,
          { status: string; best_score: number; attempts: number; max_attempts: number }
        > = {};
        for (const p of progress) {
          modules[p.module_id] = {
            status: p.status,
            best_score: p.best_score,
            attempts: p.attempts,
            max_attempts: maxAttemptsFor(p.module_id),
          };
        }

        return {
          enrollment_id: e.id,
          user_id: e.user_id,
          tech_name: `${e.first_name ?? ""} ${e.last_name ?? ""}`.trim() || `User #${e.user_id}`,
          role: e.role,
          status: e.status,
          progress_pct: Math.round(passedRatio * 100),
          passed_count: passedCount,
          total_modules: totalModules,
          current_module: currentModule,
          days_remaining: daysUntil(e.deadline_at, now),
          deadline_at: e.deadline_at,
          completed_at: e.completed_at,
          last_activity_at: e.last_activity_at,
          enrolled_at: e.enrolled_at,
          modules,
        };
      });

      return res.json({ data: rows });
    } catch (err) {
      console.error("[lms] /admin/learners error:", err);
      return res
        .status(500)
        .json({ error: "Internal Server Error", message: "Failed to load roster" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/extend — Owner+Admin only
// ─────────────────────────────────────────────────────────────────────────────
//
// Body: { enrollmentId, days }   (days: 1..90 from now; absolute set)
//
// Sets the enrollment's deadline_at to now + days. Bounded per spec.

router.post(
  "/admin/extend",
  requireAuth,
  requireRole("owner", "admin", "office"),
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      if (companyId == null) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "User has no company assignment" });
      }
      const enrollmentId = Number(req.body?.enrollmentId);
      const days = Number(req.body?.days);

      if (!Number.isFinite(enrollmentId) || enrollmentId <= 0) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "enrollmentId is required" });
      }
      if (
        !Number.isFinite(days) ||
        days < MIN_EXTEND_DAYS ||
        days > MAX_EXTEND_DAYS
      ) {
        return res.status(400).json({
          error: "Bad Request",
          message: `days must be an integer between ${MIN_EXTEND_DAYS} and ${MAX_EXTEND_DAYS}`,
        });
      }

      // Tenant gate — caller can only extend their own tenant's enrollments.
      const existing = await db
        .select()
        .from(lmsEnrollmentsTable)
        .where(
          and(
            eq(lmsEnrollmentsTable.id, enrollmentId),
            eq(lmsEnrollmentsTable.company_id, companyId),
          ),
        )
        .limit(1);
      if (!existing[0]) {
        return res
          .status(404)
          .json({ error: "Not Found", message: "Enrollment not found" });
      }

      const now = new Date();
      const newDeadline = addDays(now, Math.floor(days));

      const updated = await db
        .update(lmsEnrollmentsTable)
        .set({
          deadline_at: newDeadline,
          // If the enrollment was expired, reactivate.
          status: existing[0].status === "expired" ? "active" : existing[0].status,
          updated_at: now,
          last_activity_at: now,
        })
        .where(eq(lmsEnrollmentsTable.id, enrollmentId))
        .returning();

      await logAudit(
        req,
        "lms.admin.extend",
        "lms_enrollment",
        enrollmentId,
        { deadline_at: existing[0].deadline_at },
        { deadline_at: newDeadline, days_from_now: Math.floor(days) },
      );

      return res.json({ data: updated[0] });
    } catch (err) {
      console.error("[lms] /admin/extend error:", err);
      return res
        .status(500)
        .json({ error: "Internal Server Error", message: "Failed to extend deadline" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/bypass-module — Owner+Admin only
// ─────────────────────────────────────────────────────────────────────────────
//
// Body: { moduleId, userId? }
//
// Marks the given module as passed (score 100) for the target user. Used by:
//   - The business owner skipping their own training modules from /training.
//     (They call this without `userId` — bypass applies to themselves.)
//   - Admins unblocking a learner who hit the attempts cap or has a
//     legitimate exemption (e.g. credentialed hire).
//
// If `userId` is omitted, the caller bypasses for themselves. Otherwise the
// target user must belong to the caller's tenant.
//
// For the final mixed test, bypassing it also marks the enrollment as
// `completed` (and stamps `completed_at`) — matching the natural pass path.

router.post(
  "/admin/bypass-module",
  requireAuth,
  requireRole("owner", "admin", "office"),
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      if (companyId == null) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "User has no company assignment" });
      }
      const moduleId: string | undefined = req.body?.moduleId;
      if (typeof moduleId !== "string" || !KNOWN_MODULE_IDS.has(moduleId)) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "Unknown moduleId" });
      }
      const targetUserId =
        req.body?.userId != null ? Number(req.body.userId) : req.auth!.userId;
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "Invalid userId" });
      }

      // Tenant gate when the target is someone else — caller can only bypass
      // for users in their own company.
      if (targetUserId !== req.auth!.userId) {
        const targetUser = await db
          .select({ company_id: usersTable.company_id })
          .from(usersTable)
          .where(eq(usersTable.id, targetUserId))
          .limit(1);
        if (!targetUser[0] || targetUser[0].company_id !== companyId) {
          return res
            .status(404)
            .json({ error: "Not Found", message: "User not found in tenant" });
        }
      }

      const now = new Date();
      const enrollment = await getOrCreateEnrollment(companyId, targetUserId, now);

      await upsertModuleProgress({
        companyId,
        enrollmentId: enrollment.id,
        moduleId,
        patch: {
          status: "passed",
          best_score: 100,
          passed_at: now,
        },
        now,
      });

      // Bypassing the final mixed test completes the enrollment ONLY if
      // every other prerequisite is also satisfied. Otherwise we'd
      // re-introduce the stale-status bug surfaced by Jose's audit
      // (final passed back when there were 5 modules, still owes 8
      // new modules + 6 acks today). Bug-fix sprint #2.
      if (moduleId === FINAL_MODULE_ID) {
        const truth = await isEnrollmentTrulyComplete(companyId, targetUserId);
        if (truth.complete) {
          await db
            .update(lmsEnrollmentsTable)
            .set({ status: "completed", completed_at: now, updated_at: now })
            .where(eq(lmsEnrollmentsTable.id, enrollment.id));
        }
      }

      // Clear any in-flight autosave for this module so a re-open shows clean.
      await db
        .delete(lmsQuizStateTable)
        .where(
          and(
            eq(lmsQuizStateTable.enrollment_id, enrollment.id),
            eq(lmsQuizStateTable.module_id, moduleId),
          ),
        );

      await touchEnrollment(enrollment.id, now);

      // PR #4 policy decision: bypass marks the quiz passed for
      // navigation purposes but does NOT issue a completion certificate
      // and does NOT create a signed_document row. Certificates and
      // signed documents represent ACTUAL employee action; admin bypass
      // is a separate audit-logged event ("bypassed_by") that must stay
      // distinct from a learner-driven "signed_by" / "certified" event.
      // (This reverts the cert auto-issue that PR #3 wired in.)
      const bypassingUserId = req.auth!.userId;
      const self = targetUserId === bypassingUserId;

      await logAudit(
        req,
        "lms.admin.bypass",
        "lms_enrollment",
        enrollment.id,
        null,
        {
          module_id: moduleId,
          target_user_id: targetUserId,
          bypassed_by_user_id: bypassingUserId,
          self,
          // Explicit marker so the audit dashboard can distinguish
          // bypasses from actual sign / cert events at a glance.
          source: "admin_bypass",
        },
      );

      return res.json({
        data: {
          ok: true,
          enrollment_id: enrollment.id,
          certificate_id: null,
        },
      });
    } catch (err) {
      console.error("[lms] /admin/bypass-module error:", err);
      return res
        .status(500)
        .json({ error: "Internal Server Error", message: "Failed to bypass module" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/reset — Owner+Admin only
// ─────────────────────────────────────────────────────────────────────────────
//
// Body: { userId, mode?: 'progress' | 'full' }
//
// `progress` (default): wipes every module_progress row, quiz_state row, and
//   quiz_attempts row for the learner. Resets the enrollment to status='active',
//   bumps deadline_at to now+7d, clears completed_at + acknowledgment fields.
//   The learner keeps their enrollment row id but starts fresh on every module.
//
// `full`: deletes the enrollment outright (cascades via FK ON DELETE CASCADE,
//   so progress/state/attempts go with it). The learner's next visit to
//   /training lazy-creates a brand-new enrollment with a fresh 7-day deadline.
//
// Either mode also writes an audit log row.

router.post(
  "/admin/reset",
  requireAuth,
  requireRole("owner", "admin", "office"),
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      if (companyId == null) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "User has no company assignment" });
      }
      const targetUserId = Number(req.body?.userId);
      const mode: "progress" | "full" =
        req.body?.mode === "full" ? "full" : "progress";

      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "userId is required" });
      }

      // Tenant gate — caller can only reset users in their own tenant.
      const targetUser = await db
        .select({ company_id: usersTable.company_id })
        .from(usersTable)
        .where(eq(usersTable.id, targetUserId))
        .limit(1);
      if (!targetUser[0] || targetUser[0].company_id !== companyId) {
        return res
          .status(404)
          .json({ error: "Not Found", message: "User not found in tenant" });
      }

      const existing = await db
        .select()
        .from(lmsEnrollmentsTable)
        .where(
          and(
            eq(lmsEnrollmentsTable.company_id, companyId),
            eq(lmsEnrollmentsTable.user_id, targetUserId),
          ),
        )
        .limit(1);
      if (!existing[0]) {
        return res
          .status(404)
          .json({ error: "Not Found", message: "No enrollment to reset" });
      }
      const enrollmentId = existing[0].id;
      const now = new Date();

      if (mode === "full") {
        // FK ON DELETE CASCADE wipes progress, state, and attempts.
        await db
          .delete(lmsEnrollmentsTable)
          .where(eq(lmsEnrollmentsTable.id, enrollmentId));
      } else {
        // Progress-only reset: clear children, keep the enrollment row but
        // reset all its lifecycle fields so the learner sees a clean slate.
        await db
          .delete(lmsModuleProgressTable)
          .where(eq(lmsModuleProgressTable.enrollment_id, enrollmentId));
        await db
          .delete(lmsQuizStateTable)
          .where(eq(lmsQuizStateTable.enrollment_id, enrollmentId));
        await db
          .delete(lmsQuizAttemptsTable)
          .where(eq(lmsQuizAttemptsTable.enrollment_id, enrollmentId));
        await db
          .update(lmsEnrollmentsTable)
          .set({
            status: "active",
            enrolled_at: now,
            deadline_at: addDays(now, DEFAULT_DEADLINE_DAYS),
            completed_at: null,
            acknowledgment_signature: null,
            acknowledgment_at: null,
            last_activity_at: now,
            updated_at: now,
          })
          .where(eq(lmsEnrollmentsTable.id, enrollmentId));
      }

      await logAudit(
        req,
        mode === "full" ? "lms.admin.reset.full" : "lms.admin.reset.progress",
        "lms_enrollment",
        enrollmentId,
        { previous_status: existing[0].status },
        { target_user_id: targetUserId, mode },
      );

      return res.json({ data: { ok: true, mode } });
    } catch (err) {
      console.error("[lms] /admin/reset error:", err);
      return res
        .status(500)
        .json({ error: "Internal Server Error", message: "Failed to reset enrollment" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/learners/:userId/attempts — Owner+Admin only
// ─────────────────────────────────────────────────────────────────────────────
//
// Returns the full quiz-attempt history for one learner in the caller's
// tenant. Per spec, admins use this to spot comprehension gaps ("Carlos
// failed compensation 3× — which question keeps tripping him?") and to
// resolve disputes ("I passed!" / "I never took that").
//
// Response shape:
//   {
//     learner: { user_id, tech_name, enrollment_id },
//     attempts: [
//       {
//         attempt_id, module_id, score, passed, attempted_at,
//         answers: (number | null)[],       // parallel to question_ids
//         question_ids: string[],            // for per-module = the fixed
//                                            //   list; for __final = the
//                                            //   random sample served
//         correct_indexes: number[],         // server-authoritative
//         per_question_correct: boolean[],   // convenience for the UI
//       },
//       ...
//     ]
//   }
//
// Tenant-gated. Sorted attempted_at DESC so newest is first.

router.get(
  "/admin/learners/:userId/attempts",
  requireAuth,
  requireRole("owner", "admin", "office"),
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      if (companyId == null) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "User has no company assignment" });
      }
      const targetUserId = Number(req.params.userId);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "Invalid userId" });
      }

      // Tenant gate + locate the enrollment.
      const enrollmentRow = await db
        .select({
          id: lmsEnrollmentsTable.id,
          user_id: lmsEnrollmentsTable.user_id,
          first_name: usersTable.first_name,
          last_name: usersTable.last_name,
        })
        .from(lmsEnrollmentsTable)
        .innerJoin(usersTable, eq(usersTable.id, lmsEnrollmentsTable.user_id))
        .where(
          and(
            eq(lmsEnrollmentsTable.company_id, companyId),
            eq(lmsEnrollmentsTable.user_id, targetUserId),
          ),
        )
        .limit(1);
      if (!enrollmentRow[0]) {
        return res
          .status(404)
          .json({ error: "Not Found", message: "Enrollment not found in tenant" });
      }
      const enrollment = enrollmentRow[0];

      const rows = await db
        .select()
        .from(lmsQuizAttemptsTable)
        .where(eq(lmsQuizAttemptsTable.enrollment_id, enrollment.id))
        .orderBy(desc(lmsQuizAttemptsTable.attempted_at));

      const attempts = rows.map((r) => {
        // For per-module quizzes the question_ids column is null because
        // the set is fixed; resolve it from QUESTIONS_BY_MODULE. For the
        // final mixed test, the column carries the random sample served.
        const isFinal = r.module_id === FINAL_MODULE_ID;
        const questionIds: string[] = isFinal
          ? Array.isArray(r.question_ids)
            ? (r.question_ids as string[])
            : []
          : [
              ...((QUESTIONS_BY_MODULE as Record<string, readonly string[]>)[
                r.module_id
              ] ?? []),
            ];
        const correctIndexes = questionIds.map(
          (qid) => SERVER_ANSWER_KEY[qid] ?? -1,
        );
        const answers = Array.isArray(r.answers) ? (r.answers as (number | null)[]) : [];
        const perQuestionCorrect = questionIds.map((_qid, i) => {
          const exp = correctIndexes[i];
          const got = answers[i];
          return exp !== -1 && got === exp;
        });
        return {
          attempt_id: r.id,
          module_id: r.module_id,
          score: r.score,
          passed: r.passed,
          attempted_at: r.attempted_at,
          answers,
          question_ids: questionIds,
          correct_indexes: correctIndexes,
          per_question_correct: perQuestionCorrect,
        };
      });

      return res.json({
        data: {
          learner: {
            user_id: enrollment.user_id,
            tech_name:
              `${enrollment.first_name ?? ""} ${enrollment.last_name ?? ""}`.trim() ||
              `User #${enrollment.user_id}`,
            enrollment_id: enrollment.id,
          },
          attempts,
        },
      });
    } catch (err) {
      console.error("[lms] /admin/learners/:userId/attempts error:", err);
      return res
        .status(500)
        .json({ error: "Internal Server Error", message: "Failed to load attempt history" });
    }
  },
);

export default router;
