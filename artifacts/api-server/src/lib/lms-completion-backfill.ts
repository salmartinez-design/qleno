/**
 * Bug-fix sprint #2 — one-time idempotent backfill.
 *
 * Two passes:
 *   1. Enrollment cache correction: any enrollment row stamped
 *      `status='completed'` whose underlying data fails the current
 *      truth gate is reverted to `status='active', completed_at=null`.
 *   2. Stale FINAL revoke: any `module_progress.__final` row marked
 *      `passed` for an enrollment that doesn't meet today's prereqs
 *      is rolled back to `in_progress` so the learner retakes the
 *      final once they finish the new modules + acks. Their attempt
 *      history (best_score, attempts) stays intact.
 *
 * Idempotent — runs on every cold start, like the existing Phes data
 * migration. Once a row is healed it never matches the next sweep.
 *
 * Logs `[lms-backfill]` lines that pair with the existing
 * `[Qleno] Notification cron scheduler started` startup banner.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  lmsEnrollmentsTable,
  lmsModuleProgressTable,
} from "@workspace/db/schema";
import { FINAL_MODULE_ID } from "@workspace/lms-curriculum";
import { isEnrollmentTrulyComplete } from "./lms-completion.js";

export interface CompletionBackfillResult {
  enrollments_scanned: number;
  enrollments_reverted: number;
  final_rows_revoked: number;
}

export async function runLmsCompletionBackfill(): Promise<CompletionBackfillResult> {
  const result: CompletionBackfillResult = {
    enrollments_scanned: 0,
    enrollments_reverted: 0,
    final_rows_revoked: 0,
  };

  const stamped = await db
    .select({
      id: lmsEnrollmentsTable.id,
      company_id: lmsEnrollmentsTable.company_id,
      user_id: lmsEnrollmentsTable.user_id,
    })
    .from(lmsEnrollmentsTable)
    .where(eq(lmsEnrollmentsTable.status, "completed"));

  result.enrollments_scanned = stamped.length;
  if (stamped.length === 0) return result;

  const now = new Date();

  for (const e of stamped) {
    const truth = await isEnrollmentTrulyComplete(e.company_id, e.user_id);
    if (truth.complete) continue;

    // Revert the stamped status so the lazy-heal in GET /me doesn't
    // need to fire on first login.
    await db
      .update(lmsEnrollmentsTable)
      .set({ status: "active", completed_at: null, updated_at: now })
      .where(eq(lmsEnrollmentsTable.id, e.id));
    result.enrollments_reverted += 1;

    // If the FINAL row is stamped passed but the prereqs aren't met,
    // roll it back to in_progress so the learner retakes it.
    // best_score + attempts are preserved so the office can see they
    // did historically pass.
    const finalRow = await db
      .select({
        id: lmsModuleProgressTable.id,
        status: lmsModuleProgressTable.status,
      })
      .from(lmsModuleProgressTable)
      .where(
        and(
          eq(lmsModuleProgressTable.enrollment_id, e.id),
          eq(lmsModuleProgressTable.module_id, FINAL_MODULE_ID),
        ),
      )
      .limit(1);

    if (finalRow[0] && finalRow[0].status === "passed") {
      await db
        .update(lmsModuleProgressTable)
        .set({
          status: "in_progress",
          passed_at: null,
          updated_at: now,
        })
        .where(eq(lmsModuleProgressTable.id, finalRow[0].id));
      result.final_rows_revoked += 1;
    }
  }

  return result;
}
