/**
 * Bug-fix sprint #3 — certificate backfill.
 *
 * Historical paths (/grandfather, /admin/bypass-module) seeded
 * lms_module_progress rows with status='passed' but never issued a
 * matching lms_completion_certificates row. Jose Ardila's audit
 * surfaced this: 7 modules passed at 100%, zero certs.
 *
 * The route-level fix (issueCertificate in both endpoints) prevents
 * the bug going forward. This backfill catches the historical rows
 * that already exist in the DB.
 *
 * Idempotent: only inserts when no matching non-revoked cert exists
 * for the (company_id, user_id, module_id) tuple. Tenant-scoped: every
 * INSERT derives company_id from lms_enrollments.company_id (joined
 * to module_progress), never a global constant. Defense-in-depth:
 * before each insert we verify users.company_id matches the
 * enrollment's company_id; mismatches are skipped + logged (should
 * be impossible in normal data — the check is paranoia).
 *
 * Runs on every cold start in the seedIfNeeded → runPhesDataMigration
 * → runLmsCompletionBackfill → runLmsCertificateBackfill chain.
 */
import { and, eq, gte, isNull, or } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  lmsModuleProgressTable,
  lmsEnrollmentsTable,
  lmsCompletionCertificatesTable,
  usersTable,
} from "@workspace/db/schema";
import { issueCertificate } from "./lms-certificates.js";
import {
  shouldIssueCertificate,
  type PassedModuleRowForBackfill,
} from "./lms-certificate-backfill-pure.js";

// Re-export so the existing public surface is unchanged.
export {
  shouldIssueCertificate,
  type PassedModuleRowForBackfill,
};

export interface CertificateBackfillResult {
  rows_scanned: number;
  certs_issued: number;
  tenant_mismatches_skipped: number;
  errors: number;
}

export async function runLmsCertificateBackfill(): Promise<CertificateBackfillResult> {
  const result: CertificateBackfillResult = {
    rows_scanned: 0,
    certs_issued: 0,
    tenant_mismatches_skipped: 0,
    errors: 0,
  };

  // 1. Every passed module_progress row, joined to its enrollment for
  //    tenant context, plus the user's own company_id for the
  //    defense-in-depth check.
  const passedRows = await db
    .select({
      module_progress_id: lmsModuleProgressTable.id,
      module_id: lmsModuleProgressTable.module_id,
      best_score: lmsModuleProgressTable.best_score,
      passed_at: lmsModuleProgressTable.passed_at,
      enrollment_company_id: lmsEnrollmentsTable.company_id,
      enrollment_locale: lmsEnrollmentsTable.locale,
      user_id: lmsEnrollmentsTable.user_id,
      user_company_id: usersTable.company_id,
    })
    .from(lmsModuleProgressTable)
    .innerJoin(
      lmsEnrollmentsTable,
      eq(lmsModuleProgressTable.enrollment_id, lmsEnrollmentsTable.id),
    )
    .innerJoin(
      usersTable,
      eq(lmsEnrollmentsTable.user_id, usersTable.id),
    )
    // Defensive predicate (Maribel-class bug fix, 2026-05-17): mirror
    // the SSoT in lms-status-pure.ts:96. Without this, rows that hit the
    // cold-start race window (best_score>=80 but status hasn't been
    // recomputed yet) would be skipped by the backfill and never get
    // their cert.
    //
    // Also exclude sandbox (is_sandbox=true) so QA test data doesn't
    // generate real certs in production tables.
    .where(and(
      or(
        eq(lmsModuleProgressTable.status, "passed"),
        gte(lmsModuleProgressTable.best_score, 80),
      ),
      eq(usersTable.is_sandbox, false),
    ));

  result.rows_scanned = passedRows.length;
  if (passedRows.length === 0) return result;

  // 2. Existing non-revoked certs, keyed by (user_id, module_id). Used
  //    to make the loop idempotent without per-row SELECT round trips.
  const existing = await db
    .select({
      user_id: lmsCompletionCertificatesTable.user_id,
      module_id: lmsCompletionCertificatesTable.module_id,
    })
    .from(lmsCompletionCertificatesTable)
    .where(isNull(lmsCompletionCertificatesTable.revoked_at));
  const existingKey = new Set(
    existing.map((c) => `${c.user_id}:${c.module_id}`),
  );

  // 3. Per-row issuance loop. The pure helper makes the issue/skip
  //    decision; the runner writes the row when the helper says yes.
  for (const row of passedRows) {
    const decision = shouldIssueCertificate(
      {
        module_progress_id: row.module_progress_id,
        module_id: row.module_id,
        best_score: row.best_score,
        passed_at: (row.passed_at as Date | null) ?? null,
        enrollment_company_id: row.enrollment_company_id,
        user_id: row.user_id,
        user_company_id: row.user_company_id as number,
      },
      existingKey,
    );

    if (!decision.issue) {
      if (decision.reason === "company_id_mismatch") {
        result.tenant_mismatches_skipped += 1;
        console.warn(
          `[lms-cert-backfill] tenant mismatch on module_progress.id=${row.module_progress_id} (enrollment.company=${row.enrollment_company_id}, user.company=${row.user_company_id}); skipping`,
        );
      }
      continue;
    }

    try {
      await issueCertificate({
        companyId: row.enrollment_company_id,
        userId: row.user_id,
        moduleId: row.module_id,
        score: decision.score,
        passed: true,
        locale: row.enrollment_locale === "es" ? "es" : "en",
        // Backfill provenance: ip + device are not preserved by the
        // legacy localStorage import, so we mark them clearly.
        ipAddress: "backfill",
        deviceInfo: "backfill",
        quizAttemptId: null,
      });
      // Add to the set so a duplicate row in the same scan doesn't
      // re-insert (e.g. a user with two enrollments for one module).
      existingKey.add(`${row.user_id}:${row.module_id}`);
      result.certs_issued += 1;
    } catch (err) {
      result.errors += 1;
      console.error(
        `[lms-cert-backfill] issuance failed on module_progress.id=${row.module_progress_id}:`,
        err,
      );
    }
  }

  return result;
}
