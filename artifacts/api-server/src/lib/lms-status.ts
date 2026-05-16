/**
 * LMS employee final status — single source of truth (DB layer).
 *
 * Phes admin-view-consistency sprint (2026-05-15). Before this module
 * existed, three admin views (Roster, Audit Dashboard, Employee
 * Journey) each rolled their own pass-counting and final-exam state
 * logic. Jose Ardila's record disagreed across all three: 5/13 on
 * Roster, 6/13 on Audit Dashboard, 7/13 on Employee Journey — same
 * underlying data, three answers.
 *
 * Pure compute lives in `lms-status-pure.ts` so unit tests can
 * exercise it without Postgres. This file is the DB-fronted wrapper
 * the route handlers call.
 *
 * Defensive read rule for the Final Mixed Test (and every module):
 * if `lms_module_progress.best_score >= 80`, the SSoT reports the
 * module as PASSED regardless of the stored `status` field. This
 * closes the Jose bug (best_score=100, status='in_progress'). The
 * status recompute migration normalizes the persisted data; this
 * defensive rule is the belt to that suspenders.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  lmsEnrollmentsTable,
  lmsModuleProgressTable,
  lmsPendingReAckTable,
  lmsQuizAttemptsTable,
  lmsSignedDocumentsTable,
  usersTable,
  type LmsModuleProgress,
} from "@workspace/db/schema";
import { FINAL_MODULE_ID } from "@workspace/lms-curriculum";
import {
  computeStatusFromData,
  type EmployeeFinalStatus,
} from "./lms-status-pure.js";

export {
  computeStatusFromData,
  type EmployeeFinalStatus,
  type EnrollmentStatus,
  type FinalExamStatus,
  type ComputeStatusInput,
} from "./lms-status-pure.js";

const HANDBOOK_DOCUMENT_TYPE = "handbook" as const;

/**
 * Batched DB-fronted variant. Loads every record for `userIds` in
 * one round-trip per table, then computes the SSoT shape for each.
 * Tenant-scoped via companyId — cross-tenant userIds are silently
 * dropped (the SELECT for users filters them out).
 */
export async function computeEmployeeFinalStatusBatch(
  userIds: number[],
  companyId: number,
): Promise<Map<number, EmployeeFinalStatus>> {
  const out = new Map<number, EmployeeFinalStatus>();
  if (userIds.length === 0) return out;
  const now = new Date();

  const users = await db
    .select({
      id: usersTable.id,
      is_sandbox: usersTable.is_sandbox,
    })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.company_id, companyId),
        inArray(usersTable.id, userIds),
      ),
    );
  if (users.length === 0) return out;
  const scopedUserIds = users.map((u) => u.id);

  const enrollments = await db
    .select({
      user_id: lmsEnrollmentsTable.user_id,
      id: lmsEnrollmentsTable.id,
      deadline_at: lmsEnrollmentsTable.deadline_at,
      last_activity_at: lmsEnrollmentsTable.last_activity_at,
    })
    .from(lmsEnrollmentsTable)
    .where(
      and(
        eq(lmsEnrollmentsTable.company_id, companyId),
        inArray(lmsEnrollmentsTable.user_id, scopedUserIds),
      ),
    );
  const enrollmentByUser = new Map<number, (typeof enrollments)[number]>();
  for (const e of enrollments) enrollmentByUser.set(e.user_id, e);
  const enrollmentIds = enrollments.map((e) => e.id);
  const userByEnrollment = new Map<number, number>();
  for (const e of enrollments) userByEnrollment.set(e.id, e.user_id);

  const progressRows: Pick<
    LmsModuleProgress,
    "enrollment_id" | "module_id" | "status" | "best_score" | "attempts"
  >[] = enrollmentIds.length
    ? await db
        .select({
          enrollment_id: lmsModuleProgressTable.enrollment_id,
          module_id: lmsModuleProgressTable.module_id,
          status: lmsModuleProgressTable.status,
          best_score: lmsModuleProgressTable.best_score,
          attempts: lmsModuleProgressTable.attempts,
        })
        .from(lmsModuleProgressTable)
        .where(inArray(lmsModuleProgressTable.enrollment_id, enrollmentIds))
    : [];
  const progressByUser = new Map<number, typeof progressRows>();
  for (const p of progressRows) {
    const uid = userByEnrollment.get(p.enrollment_id);
    if (uid === undefined) continue;
    const arr = progressByUser.get(uid) ?? [];
    arr.push(p);
    progressByUser.set(uid, arr);
  }

  const signedDocs = await db
    .select({
      user_id: lmsSignedDocumentsTable.user_id,
      document_type: lmsSignedDocumentsTable.document_type,
      signed_at: lmsSignedDocumentsTable.signed_at,
    })
    .from(lmsSignedDocumentsTable)
    .where(
      and(
        eq(lmsSignedDocumentsTable.company_id, companyId),
        eq(lmsSignedDocumentsTable.status, "active"),
        inArray(lmsSignedDocumentsTable.user_id, scopedUserIds),
      ),
    );
  const signedByUser = new Map<number, string[]>();
  const handbookSignedAtByUser = new Map<number, Date>();
  for (const d of signedDocs) {
    const arr = signedByUser.get(d.user_id) ?? [];
    arr.push(d.document_type);
    signedByUser.set(d.user_id, arr);
    if (d.document_type === HANDBOOK_DOCUMENT_TYPE && d.signed_at) {
      handbookSignedAtByUser.set(d.user_id, d.signed_at as Date);
    }
  }

  const pendingRows = await db
    .select({
      user_id: lmsPendingReAckTable.user_id,
    })
    .from(lmsPendingReAckTable)
    .where(
      and(
        eq(lmsPendingReAckTable.company_id, companyId),
        isNull(lmsPendingReAckTable.acknowledged_at),
        inArray(lmsPendingReAckTable.user_id, scopedUserIds),
      ),
    );
  const pendingByUser = new Map<number, number>();
  for (const r of pendingRows) {
    pendingByUser.set(r.user_id, (pendingByUser.get(r.user_id) ?? 0) + 1);
  }

  const finalAttemptsRows = enrollmentIds.length
    ? await db
        .select({
          enrollment_id: lmsQuizAttemptsTable.enrollment_id,
        })
        .from(lmsQuizAttemptsTable)
        .where(
          and(
            eq(lmsQuizAttemptsTable.company_id, companyId),
            eq(lmsQuizAttemptsTable.module_id, FINAL_MODULE_ID),
            eq(lmsQuizAttemptsTable.superseded, false),
            inArray(lmsQuizAttemptsTable.enrollment_id, enrollmentIds),
          ),
        )
    : [];
  const finalAttemptsByUser = new Map<number, number>();
  for (const r of finalAttemptsRows) {
    const uid = userByEnrollment.get(r.enrollment_id);
    if (uid === undefined) continue;
    finalAttemptsByUser.set(uid, (finalAttemptsByUser.get(uid) ?? 0) + 1);
  }

  for (const u of users) {
    const enrollment = enrollmentByUser.get(u.id);
    out.set(
      u.id,
      computeStatusFromData({
        userId: u.id,
        companyId,
        isSandbox: !!u.is_sandbox,
        enrollment: enrollment
          ? {
              deadline_at: enrollment.deadline_at,
              last_activity_at: enrollment.last_activity_at,
            }
          : null,
        progress: progressByUser.get(u.id) ?? [],
        signedDocumentTypes: signedByUser.get(u.id) ?? [],
        handbookSignedAt: handbookSignedAtByUser.get(u.id) ?? null,
        finalAttemptsCount: finalAttemptsByUser.get(u.id) ?? 0,
        pendingReAcks: pendingByUser.get(u.id) ?? 0,
        now,
      }),
    );
  }

  return out;
}

export async function computeEmployeeFinalStatus(
  userId: number,
  companyId: number,
): Promise<EmployeeFinalStatus | null> {
  const batch = await computeEmployeeFinalStatusBatch([userId], companyId);
  return batch.get(userId) ?? null;
}
