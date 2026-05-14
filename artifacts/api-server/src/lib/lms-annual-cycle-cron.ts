/**
 * Annual re-acknowledgment cycle — December cron auto-open.
 *
 * On December 1 at 9 AM CT each year, every active tenant gets a
 * fresh `lms_annual_ack_cycles` row for the current calendar year
 * (deadline Dec 31 23:59:59.999 UTC) plus a sweep into
 * `lms_pending_re_ack` for every employee with an active handbook
 * signature. The admin "Annual cycles" button still works for manual
 * overrides — this cron just makes sure compliance fires even when
 * the office forgets to hit the button.
 *
 * Idempotent: the unique index on (company_id, cycle_year) means a
 * second run on the same day is a no-op. The `fired` tracker in
 * `index.ts` prevents same-hour re-fires too.
 *
 * The cron writes pending_re_ack rows with `triggered_by_user_id = null`
 * and `trigger_reason = 'annual_cycle'`. The schema column is already
 * nullable so cron-triggered rows show up clearly in audit queries
 * (`WHERE triggered_by_user_id IS NULL` finds them).
 */
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  lmsAnnualAckCyclesTable,
  companiesTable,
  ANNUAL_DOCUMENT_TYPES,
} from "@workspace/db/schema";
import { sweepForDocumentType } from "../routes/lms-annual-ack.js";
import {
  cycleYearForAutoOpen,
  defaultCycleDeadline,
} from "./lms-annual-ack.js";

export interface AutoOpenResult {
  company_id: number;
  status: "opened" | "skipped_exists" | "error";
  cycle_id?: number;
  swept_count?: number;
  error?: string;
}

export { cycleYearForAutoOpen };

/**
 * Walk every tenant and open the annual cycle for the current year
 * if one doesn't already exist. Idempotent — safe to re-run.
 *
 * Returns one result row per tenant for logging / observability.
 */
export async function runAnnualCycleAutoOpen(
  now: Date = new Date(),
): Promise<AutoOpenResult[]> {
  const cycleYear = cycleYearForAutoOpen(now);
  const deadlineAt = defaultCycleDeadline(cycleYear);

  const companies = await db
    .select({ id: companiesTable.id, name: companiesTable.name })
    .from(companiesTable);

  const results: AutoOpenResult[] = [];

  for (const company of companies) {
    try {
      const existing = await db
        .select({ id: lmsAnnualAckCyclesTable.id })
        .from(lmsAnnualAckCyclesTable)
        .where(
          and(
            eq(lmsAnnualAckCyclesTable.company_id, company.id),
            eq(lmsAnnualAckCyclesTable.cycle_year, cycleYear),
          ),
        )
        .limit(1);

      if (existing[0]) {
        results.push({
          company_id: company.id,
          status: "skipped_exists",
          cycle_id: existing[0].id,
        });
        continue;
      }

      const inserted = await db
        .insert(lmsAnnualAckCyclesTable)
        .values({
          company_id: company.id,
          cycle_year: cycleYear,
          deadline_at: deadlineAt,
          required_documents: [...ANNUAL_DOCUMENT_TYPES],
          notes: "Auto-opened by December cron",
        })
        .onConflictDoNothing({
          target: [
            lmsAnnualAckCyclesTable.company_id,
            lmsAnnualAckCyclesTable.cycle_year,
          ],
        })
        .returning({ id: lmsAnnualAckCyclesTable.id });

      // Race: another caller (concurrent restart) inserted between our
      // SELECT and INSERT. Treat as a skip.
      if (!inserted[0]) {
        results.push({ company_id: company.id, status: "skipped_exists" });
        continue;
      }

      let swept = 0;
      for (const documentType of ANNUAL_DOCUMENT_TYPES) {
        const r = await sweepForDocumentType({
          companyId: company.id,
          documentType,
          triggeredByUserId: null,
          triggerReason: "annual_cycle",
        });
        swept += r.swept_user_ids.length;
      }

      results.push({
        company_id: company.id,
        status: "opened",
        cycle_id: inserted[0].id,
        swept_count: swept,
      });
    } catch (err) {
      results.push({
        company_id: company.id,
        status: "error",
        error: String((err as Error).message ?? err),
      });
    }
  }

  return results;
}
