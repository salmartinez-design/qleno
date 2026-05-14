/**
 * Enrollment completion — the canonical truth gate.
 *
 * `enrollment.status === 'completed'` is a CACHED summary that can fall
 * out of sync with reality when the curriculum evolves (new modules
 * added, new required acks shipped). This module is the single source
 * of truth for "is this employee actually done?" — it never trusts the
 * cached column.
 *
 * Both the route handlers (POST /quiz/submit, POST /admin/bypass-module)
 * and the GET /api/lms/me read path call into this helper so they can
 * surface a corrected `enrollment.status` if the cache lies.
 *
 * Pure scoring delegates to `computeCompliance` in lms-admin-audit.ts
 * so the audit dashboard and the runtime gate stay in lockstep.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  lmsEnrollmentsTable,
  lmsModuleProgressTable,
  lmsSignedDocumentsTable,
  REQUIRED_PRE_FINAL_SIGNED_DOCS,
} from "@workspace/db/schema";
import { QUIZ_MODULE_IDS, FINAL_MODULE_ID } from "@workspace/lms-curriculum";
import { computeCompliance } from "./lms-admin-audit.js";

const HANDBOOK_DOCUMENT_TYPE = "handbook";

export interface CompletionBreakdown {
  /** True iff every gate the spec defines is satisfied right now. */
  complete: boolean;
  /** Quiz modules from QUIZ_MODULE_IDS that the user has NOT yet passed. */
  missing_modules: string[];
  /** REQUIRED_PRE_FINAL_SIGNED_DOCS the user has NOT yet signed. */
  missing_docs: string[];
  /** True iff there's a passed module_progress row for FINAL_MODULE_ID. */
  final_passed: boolean;
  /** True iff there's an active signed_document for document_type='handbook'. */
  handbook_signed: boolean;
}

/**
 * Run the full truth gate against the DB. Tenant-scoped: all five sub-
 * queries filter by (company_id, user_id) and the enrollment join is
 * implicit through module_progress.enrollment_id.
 *
 * Returns a breakdown so callers can surface "you're missing X modules
 * and Y acks" copy without an extra round trip.
 */
export async function isEnrollmentTrulyComplete(
  companyId: number,
  userId: number,
): Promise<CompletionBreakdown> {
  // Enrollment lookup. Without it the user has zero progress, which is
  // by definition not complete.
  const [enrollment] = await db
    .select({ id: lmsEnrollmentsTable.id })
    .from(lmsEnrollmentsTable)
    .where(
      and(
        eq(lmsEnrollmentsTable.company_id, companyId),
        eq(lmsEnrollmentsTable.user_id, userId),
      ),
    )
    .limit(1);

  if (!enrollment) {
    return {
      complete: false,
      missing_modules: [...QUIZ_MODULE_IDS],
      missing_docs: [...REQUIRED_PRE_FINAL_SIGNED_DOCS],
      final_passed: false,
      handbook_signed: false,
    };
  }

  // All passed module_progress rows for this enrollment.
  const progressRows = await db
    .select({
      module_id: lmsModuleProgressTable.module_id,
      status: lmsModuleProgressTable.status,
    })
    .from(lmsModuleProgressTable)
    .where(eq(lmsModuleProgressTable.enrollment_id, enrollment.id));

  const passedModuleIds = progressRows
    .filter((r) => r.status === "passed")
    .map((r) => r.module_id);

  // Active signed_document rows the user holds for the required types
  // + the handbook.
  const requiredPlusHandbook: string[] = [
    ...REQUIRED_PRE_FINAL_SIGNED_DOCS,
    HANDBOOK_DOCUMENT_TYPE,
  ];
  const signedRows = await db
    .select({
      document_type: lmsSignedDocumentsTable.document_type,
    })
    .from(lmsSignedDocumentsTable)
    .where(
      and(
        eq(lmsSignedDocumentsTable.company_id, companyId),
        eq(lmsSignedDocumentsTable.user_id, userId),
        eq(lmsSignedDocumentsTable.status, "active"),
        inArray(lmsSignedDocumentsTable.document_type, requiredPlusHandbook),
      ),
    );
  const signedTypes = new Set(signedRows.map((r) => r.document_type));

  // Hand off to the pure scorer so audit dashboard + runtime gate stay
  // in lockstep. We pass an explicit pending count of 0 because the
  // truth gate ignores pending re-acks (those are a separate signal
  // for annual cycles, not a prerequisite for being "complete").
  const compliance = computeCompliance({
    passed_module_ids: passedModuleIds,
    signed_document_types: [...signedTypes],
    handbook_signed: signedTypes.has(HANDBOOK_DOCUMENT_TYPE),
    pending_re_ack_count: 0,
    deadline_at: null,
  });

  const passedSet = new Set(passedModuleIds);
  const missing_modules = [...QUIZ_MODULE_IDS].filter(
    (m) => !passedSet.has(m),
  );
  const missing_docs = [...REQUIRED_PRE_FINAL_SIGNED_DOCS].filter(
    (d) => !signedTypes.has(d),
  );
  const final_passed = passedSet.has(FINAL_MODULE_ID);
  const handbook_signed = signedTypes.has(HANDBOOK_DOCUMENT_TYPE);

  return {
    complete: compliance.overall === "complete" && final_passed,
    missing_modules,
    missing_docs,
    final_passed,
    handbook_signed,
  };
}
