/**
 * LMS Completion Certificates — DB-touching helpers + PDF orchestration.
 *
 * Phase 12 (PR #3 of 16). Wired into:
 *   - POST /api/lms/quiz/submit  (on pass)
 *   - POST /api/lms/module/acknowledge  (on content-only completion)
 *   - POST /api/lms/admin/bypass-module  (on bypass)
 *
 * Behavior:
 *   - Every successful pass / acknowledgment / bypass issues a NEW row
 *     in lms_completion_certificates. Old rows for the same (user,
 *     module) are NOT auto-revoked — the most recent active row is the
 *     "current" cert, but the historical chain is preserved for audit.
 *   - PDFs are rendered ON DEMAND when downloaded (no on-disk storage
 *     this PR). pdf_storage_url stays null. The download endpoint
 *     regenerates from the cert row + curriculum lookup.
 *   - Tenant-scoped on every read.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  lmsCompletionCertificatesTable,
  usersTable,
  type LmsCompletionCertificate,
} from "@workspace/db/schema";

export interface IssueCertificateArgs {
  companyId: number;
  userId: number;
  /** Curriculum module id, "__final" for the final mixed test. */
  moduleId: string;
  /** 0-100; pass null for content-only modules (acknowledgment). */
  score: number | null;
  /** Always true for issuance (failures don't issue certs). */
  passed: boolean;
  /**
   * SHA-256 of the curriculum state at issuance. Optional — pass null
   * if not yet wired. Future PRs (annual recurrence) will use this to
   * detect outdated certs.
   */
  curriculumVersionHash?: string | null;
  /** 'en' or 'es' — the locale the learner was using. */
  locale: string;
  /** IP captured from the request. */
  ipAddress: string;
  /** Already-parsed minimal device string (Browser / OS). */
  deviceInfo: string;
  /** Links the cert back to lms_quiz_attempts when applicable. */
  quizAttemptId?: number | null;
  /** Annual cycle context, populated by PR #14. */
  cycleId?: number | null;
}

/**
 * Issue a fresh certificate row. Idempotent at the call-site level —
 * callers should not double-call within the same submission. This
 * function itself just inserts.
 *
 * Returns the inserted row so the caller can return its id to the
 * client (which then knows where to download from).
 */
export async function issueCertificate(
  args: IssueCertificateArgs,
): Promise<LmsCompletionCertificate> {
  const inserted = await db
    .insert(lmsCompletionCertificatesTable)
    .values({
      company_id: args.companyId,
      user_id: args.userId,
      module_id: args.moduleId,
      quiz_attempt_id: args.quizAttemptId ?? null,
      score: args.score,
      passed: args.passed,
      curriculum_version_hash: args.curriculumVersionHash ?? null,
      locale: args.locale,
      ip_address: args.ipAddress,
      device_info: args.deviceInfo,
      issued_at: new Date(),
      cycle_id: args.cycleId ?? null,
    })
    .returning();
  return inserted[0];
}

/**
 * List all certificates for a user, scoped to a tenant. Newest first.
 * Used by the learner's "my certificates" view and the admin's
 * per-learner audit panel.
 */
export async function listCertificatesForUser(
  companyId: number,
  userId: number,
): Promise<LmsCompletionCertificate[]> {
  return db
    .select()
    .from(lmsCompletionCertificatesTable)
    .where(
      and(
        eq(lmsCompletionCertificatesTable.company_id, companyId),
        eq(lmsCompletionCertificatesTable.user_id, userId),
      ),
    )
    .orderBy(desc(lmsCompletionCertificatesTable.issued_at));
}

/**
 * Get the most recent NON-revoked certificate for a (user, module),
 * scoped to a tenant. Returns null if no active cert exists.
 *
 * This is the "current" cert per module that the learner UI uses to
 * decide whether to show a Download button next to a passed module.
 */
export async function getLatestActiveCertificate(
  companyId: number,
  userId: number,
  moduleId: string,
): Promise<LmsCompletionCertificate | null> {
  const rows = await db
    .select()
    .from(lmsCompletionCertificatesTable)
    .where(
      and(
        eq(lmsCompletionCertificatesTable.company_id, companyId),
        eq(lmsCompletionCertificatesTable.user_id, userId),
        eq(lmsCompletionCertificatesTable.module_id, moduleId),
      ),
    )
    .orderBy(desc(lmsCompletionCertificatesTable.issued_at))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // Treat revoked rows as no-active-cert. Caller can still query the
  // full history via listCertificatesForUser.
  if (row.revoked_at) return null;
  return row;
}

/**
 * Get a single certificate by id, tenant-scoped. Returns null when not
 * found or out-of-tenant — caller treats both as 404.
 */
export async function getCertificateById(
  companyId: number,
  certificateId: number,
): Promise<LmsCompletionCertificate | null> {
  const rows = await db
    .select()
    .from(lmsCompletionCertificatesTable)
    .where(
      and(
        eq(lmsCompletionCertificatesTable.id, certificateId),
        eq(lmsCompletionCertificatesTable.company_id, companyId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Look up basic user identity for the cert PDF rendering. Tenant-
 * scoped. Returns the learner's display name and the tenant company
 * name (used to print the "Phes" header on the cert).
 */
export async function getCertificateLearnerSummary(
  companyId: number,
  userId: number,
): Promise<{
  fullName: string;
  email: string;
} | null> {
  const rows = await db
    .select({
      first_name: usersTable.first_name,
      last_name: usersTable.last_name,
      email: usersTable.email,
    })
    .from(usersTable)
    .where(
      and(eq(usersTable.id, userId), eq(usersTable.company_id, companyId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const fullName =
    `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() ||
    row.email ||
    `User #${userId}`;
  return { fullName, email: row.email };
}

/**
 * Bulk lookup for admin views: latest active cert per (user, module)
 * for every module a given user has. Returns a map keyed by
 * module_id so the admin UI can build a "checklist" view.
 *
 * If the user has multiple historical certs per module, the most
 * recent non-revoked one wins.
 */
export async function getLatestCertificateMapForUser(
  companyId: number,
  userId: number,
): Promise<Record<string, LmsCompletionCertificate>> {
  const all = await listCertificatesForUser(companyId, userId);
  const map: Record<string, LmsCompletionCertificate> = {};
  for (const cert of all) {
    if (cert.revoked_at) continue;
    // listCertificatesForUser is newest-first, so the FIRST insert
    // wins per module_id.
    if (!(cert.module_id in map)) {
      map[cert.module_id] = cert;
    }
  }
  return map;
}

/**
 * Re-export a tiny utility so callers that already have the route's
 * userIds list can fetch a batch of names without one query per user.
 * Used by the admin roster expand panel.
 */
export async function getCertCountsForUsers(
  companyId: number,
  userIds: number[],
): Promise<Record<number, number>> {
  if (userIds.length === 0) return {};
  const rows = await db
    .select({
      user_id: lmsCompletionCertificatesTable.user_id,
    })
    .from(lmsCompletionCertificatesTable)
    .where(
      and(
        eq(lmsCompletionCertificatesTable.company_id, companyId),
        inArray(lmsCompletionCertificatesTable.user_id, userIds),
      ),
    );
  const counts: Record<number, number> = {};
  for (const r of rows) {
    counts[r.user_id] = (counts[r.user_id] ?? 0) + 1;
  }
  return counts;
}
