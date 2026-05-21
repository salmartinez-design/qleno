/**
 * LMS employee final status — pure computation layer.
 *
 * Separated from `lms-status.ts` so unit tests can exercise the
 * compute logic without spinning up Postgres. The DB-fronted wrappers
 * (`computeEmployeeFinalStatus`, `computeEmployeeFinalStatusBatch`)
 * live next door and re-export `computeStatusFromData` from here.
 */
import { REQUIRED_PRE_FINAL_SIGNED_DOCS } from "@workspace/db/schema";
import {
  FINAL_MODULE_ID,
  QUIZ_MODULE_IDS,
  QUIZ_PASS_THRESHOLD,
  MAX_FINAL_ATTEMPTS,
} from "@workspace/lms-curriculum";
import { computeCompliance, type ComplianceFlags } from "./lms-admin-audit.js";

const PASS_PERCENT = Math.round(QUIZ_PASS_THRESHOLD * 100);
const QUIZ_MODULE_SET = new Set<string>(QUIZ_MODULE_IDS as readonly string[]);
const REQUIRED_DOC_SET = new Set<string>(
  REQUIRED_PRE_FINAL_SIGNED_DOCS as readonly string[],
);

export type FinalExamStatus =
  | "not_started"
  | "in_progress"
  | "passed"
  | "failed";

export type EnrollmentStatus =
  | "not_started"
  | "in_progress"
  | "complete"
  | "overdue"
  | "sandbox";

export interface EmployeeFinalStatus {
  userId: number;
  companyId: number;
  modulesPassed: number;
  modulesTotal: number;
  passedModuleIds: string[];
  signedDocumentsCompleted: number;
  signedDocumentsTotal: number;
  signedDocumentTypes: string[];
  finalExamStatus: FinalExamStatus;
  finalExamBestScore: number | null;
  finalExamAttempts: number;
  handbookSigned: boolean;
  handbookSignedAt: Date | null;
  enrollmentStatus: EnrollmentStatus;
  currentModuleId: string | null;
  daysRemaining: number | null;
  lastActivityAt: Date | null;
  pendingReAcks: number;
  isSandbox: boolean;
  compliance: ComplianceFlags;
  computedAt: Date;
}

export interface ComputeStatusInput {
  userId: number;
  companyId: number;
  isSandbox: boolean;
  enrollment: {
    deadline_at: Date | string | null;
    last_activity_at: Date | string | null;
  } | null;
  progress: Array<{
    module_id: string;
    status: string;
    best_score: number | null;
    attempts: number;
  }>;
  signedDocumentTypes: string[];
  handbookSignedAt: Date | null;
  finalAttemptsCount: number;
  pendingReAcks: number;
  now?: Date;
}

/**
 * Defensive-passed predicate — the SINGLE rule that every read path
 * AND every write-path gate must use to decide "is this module passed?"
 *
 * Returns true if either:
 *   - The persisted status field is 'passed', OR
 *   - The best_score has crossed the pass threshold (>= 80)
 *
 * Why both clauses: the persisted status field can lag behind reality
 * in two scenarios:
 *   1. Cold-start race window: the recompute migration hasn't reached
 *      this row yet, so best_score=85 but status='in_progress'.
 *   2. Admin retake: status gets clobbered to 'failed' when an admin
 *      retakes a previously-passed module and scores low. best_score
 *      is preserved via GREATEST() but status regresses.
 *
 * The handbook eligibility gate, the truly-complete check, the cert
 * backfill, the admin roster, and the SSoT all share this rule. Any
 * gate that uses strict status='passed' alone is the Maribel-class
 * bug pattern.
 *
 * Exported so route handlers can call the same predicate the SSoT
 * uses; the unit test asserts this single source of truth.
 */
export function isModulePassed(row: {
  status: string;
  best_score: number | null;
}): boolean {
  if (row.status === "passed") return true;
  return (row.best_score ?? 0) >= PASS_PERCENT;
}

/**
 * Decides whether `POST /lms/module/start` is allowed to write
 * `status: 'in_progress'` into the module_progress row for this
 * (learner, module).
 *
 * Returns true (allowed to set in_progress) when:
 *   - no row exists yet (fresh insert path), OR
 *   - the row exists but does NOT satisfy `isModulePassed` (i.e. it's
 *     genuinely in-progress / failed / not_started)
 *
 * Returns false (must omit status from the patch) when the row already
 * satisfies `isModulePassed`. That guard prevents the Katie-class bug:
 *   - learner passes a quiz (status='passed', best_score=97, passed_at set)
 *   - learner later opens the module to review
 *   - frontend auto-fires `/module/start` on view
 *   - WITHOUT this guard the upsert clobbers status to 'in_progress',
 *     which re-enables the quiz UI and lets the learner retake an
 *     already-passed module — defeating the whole pass concept.
 *
 * Pure helper so the regression test can pin the decision matrix
 * without spinning up a DB. The route handler uses the same predicate.
 */
export function canDowngradeToInProgress(
  existing: { status: string; best_score: number | null } | undefined,
): boolean {
  if (!existing) return true;
  return !isModulePassed(existing);
}

export function computeStatusFromData(
  input: ComputeStatusInput,
): EmployeeFinalStatus {
  const now = input.now ?? new Date();

  const passedModuleIds: string[] = [];
  let finalBestScore: number | null = null;
  for (const p of input.progress) {
    if (p.module_id === FINAL_MODULE_ID) {
      finalBestScore = p.best_score ?? 0;
      continue;
    }
    if (!QUIZ_MODULE_SET.has(p.module_id)) continue;
    const score = p.best_score ?? 0;
    if (score >= PASS_PERCENT || p.status === "passed") {
      passedModuleIds.push(p.module_id);
    }
  }
  const modulesPassed = passedModuleIds.length;
  const modulesTotal = QUIZ_MODULE_IDS.length;

  const signedDocSet = new Set(
    input.signedDocumentTypes.filter((t) => REQUIRED_DOC_SET.has(t)),
  );
  const signedDocumentsCompleted = signedDocSet.size;
  const signedDocumentsTotal = REQUIRED_PRE_FINAL_SIGNED_DOCS.length;

  const handbookSigned = input.handbookSignedAt !== null;

  const finalExamBestScore = finalBestScore;
  const finalExamAttempts = Math.max(0, input.finalAttemptsCount | 0);
  let finalExamStatus: FinalExamStatus;
  if ((finalExamBestScore ?? 0) >= PASS_PERCENT) {
    finalExamStatus = "passed";
  } else if (finalExamAttempts >= MAX_FINAL_ATTEMPTS) {
    finalExamStatus = "failed";
  } else if (finalExamAttempts > 0) {
    finalExamStatus = "in_progress";
  } else {
    finalExamStatus = "not_started";
  }

  const passedForCompliance =
    finalExamStatus === "passed"
      ? [...passedModuleIds, FINAL_MODULE_ID]
      : passedModuleIds;
  const compliance = computeCompliance({
    passed_module_ids: passedForCompliance,
    signed_document_types: input.signedDocumentTypes,
    handbook_signed: handbookSigned,
    pending_re_ack_count: input.pendingReAcks,
    deadline_at: input.enrollment?.deadline_at ?? null,
    now,
  });

  const passedSet = new Set(passedModuleIds);
  let currentModuleId: string | null = null;
  for (const m of QUIZ_MODULE_IDS) {
    if (!passedSet.has(m)) {
      currentModuleId = m;
      break;
    }
  }
  if (currentModuleId === null && finalExamStatus !== "passed") {
    currentModuleId = FINAL_MODULE_ID;
  }

  let daysRemaining: number | null = null;
  if (input.enrollment?.deadline_at) {
    const dl =
      input.enrollment.deadline_at instanceof Date
        ? input.enrollment.deadline_at
        : new Date(input.enrollment.deadline_at);
    if (!Number.isNaN(dl.getTime())) {
      const ms = dl.getTime() - now.getTime();
      daysRemaining = Math.ceil(ms / (24 * 60 * 60 * 1000));
    }
  }

  let enrollmentStatus: EnrollmentStatus;
  if (input.isSandbox) {
    enrollmentStatus = "sandbox";
  } else if (compliance.overall === "complete") {
    enrollmentStatus = "complete";
  } else if (compliance.overall === "overdue") {
    enrollmentStatus = "overdue";
  } else if (
    modulesPassed > 0 ||
    finalExamAttempts > 0 ||
    signedDocumentsCompleted > 0 ||
    handbookSigned
  ) {
    enrollmentStatus = "in_progress";
  } else {
    enrollmentStatus = "not_started";
  }

  const lastActivityAt =
    input.enrollment?.last_activity_at instanceof Date
      ? input.enrollment.last_activity_at
      : input.enrollment?.last_activity_at
      ? new Date(input.enrollment.last_activity_at)
      : null;

  return {
    userId: input.userId,
    companyId: input.companyId,
    modulesPassed,
    modulesTotal,
    passedModuleIds,
    signedDocumentsCompleted,
    signedDocumentsTotal,
    signedDocumentTypes: input.signedDocumentTypes,
    finalExamStatus,
    finalExamBestScore,
    finalExamAttempts,
    handbookSigned,
    handbookSignedAt: input.handbookSignedAt,
    enrollmentStatus,
    currentModuleId,
    daysRemaining,
    lastActivityAt,
    pendingReAcks: input.pendingReAcks,
    isSandbox: input.isSandbox,
    compliance,
    computedAt: now,
  };
}
