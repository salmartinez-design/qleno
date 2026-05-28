/**
 * Cutover 1E — Startup self-check that confirms the 1C GPS-integrity
 * CHECK constraint is live AND enforced in the connected database.
 *
 * Runs at api-server startup after the DB connection is established
 * but before serving traffic. Non-fatal: log-only. The pay pipeline
 * also independently filters at the application layer
 * (lib/pay-eligibility.ts), so a missing constraint cannot leak bad
 * events into paid hours, but the boot log makes the constraint
 * presence visible to anyone watching the deploy.
 *
 * Re-runnable on demand via GET /api/ops/integrity-check (routes/
 * ops-integrity.ts). Same code path; never crashes.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_NAME,
} from "@workspace/db/schema";

/**
 * Postgres SQLSTATE for `check_violation`. The smoke INSERTs below
 * must each raise this code; any other failure (e.g. FK violation)
 * means the constraint is missing or weaker than expected.
 */
const PG_CHECK_VIOLATION_SQLSTATE = "23514";

export type IntegrityCheckResult = {
  ok: boolean;
  constraint_name: string | null;
  constraint_definition: string | null;
  captured_smoke_rejected: boolean;
  failed_exception_smoke_rejected: boolean;
  message: string;
  detail: string[];
};

export async function verifyClockIntegrityConstraint(): Promise<IntegrityCheckResult> {
  const detail: string[] = [];
  let constraintName: string | null = null;
  let constraintDefinition: string | null = null;

  // Step 1 — read the catalog.
  try {
    const rows: any = await db.execute(
      sql`SELECT conname, pg_get_constraintdef(oid) AS defn
          FROM pg_constraint
          WHERE conrelid = 'job_clock_events'::regclass AND contype = 'c'`,
    );
    const matches = (Array.isArray(rows) ? rows : rows?.rows ?? []) as Array<{
      conname: string;
      defn: string;
    }>;
    const target = matches.find(
      (r) => r.conname === JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_NAME,
    );
    if (target) {
      constraintName = target.conname;
      constraintDefinition = target.defn;
      detail.push(
        `catalog: ${constraintName} present, defn=${constraintDefinition}`,
      );
    } else if (matches.length > 0) {
      detail.push(
        `catalog: target constraint ${JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_NAME} NOT found; other CHECKs on table: ${matches
          .map((m) => m.conname)
          .join(", ")}`,
      );
    } else {
      detail.push(
        `catalog: NO check constraints found on job_clock_events`,
      );
    }
  } catch (err) {
    detail.push(`catalog lookup error: ${(err as Error).message}`);
  }

  // Step 2 — captured smoke INSERT (must be rejected).
  const capturedRejected = await runSmokeAndExpectRejection(
    sql`INSERT INTO job_clock_events
          (company_id, job_id, user_id, event_type, event_at,
           gps_status, created_by_user_id)
        VALUES
          (-999999, -999999, -999999, 'clock_in', now(),
           'captured', -999999)`,
    "captured with null lat/lng",
    detail,
  );

  // Step 3 — failed_exception smoke INSERT (must be rejected).
  const failedExceptionRejected = await runSmokeAndExpectRejection(
    sql`INSERT INTO job_clock_events
          (company_id, job_id, user_id, event_type, event_at,
           gps_status, exception_reason, created_by_user_id)
        VALUES
          (-999999, -999999, -999999, 'clock_in', now(),
           'failed_exception', NULL, -999999)`,
    "failed_exception with null reason",
    detail,
  );

  const ok =
    constraintName != null &&
    capturedRejected &&
    failedExceptionRejected;

  const result: IntegrityCheckResult = {
    ok,
    constraint_name: constraintName,
    constraint_definition: constraintDefinition,
    captured_smoke_rejected: capturedRejected,
    failed_exception_smoke_rejected: failedExceptionRejected,
    message: ok
      ? `CLOCK INTEGRITY: PASS — constraint ${constraintName} present and rejecting malformed rows`
      : `CLOCK INTEGRITY: FAIL — constraint missing or not enforced; pay relies on application-level guard only. INVESTIGATE BEFORE RUNNING PAYROLL.`,
    detail,
  };

  // Single-line headline log so the deploy log is easy to grep.
  console.log(result.message);
  for (const line of detail) console.log(`  · ${line}`);

  return result;
}

/**
 * Wrap one bad-row INSERT in a transaction and roll it back. We expect
 * Postgres to raise SQLSTATE 23514 (check_violation). Anything else is
 * a smoke failure.
 *
 * The bogus FK values (-999999) deliberately violate company_id /
 * job_id / user_id foreign keys too, but Postgres validates CHECK
 * constraints before FK constraints during row insertion, so the
 * check_violation will fire first when the constraint is present.
 * If the CHECK is missing the FK error fires instead and we treat
 * that as a smoke failure (constraint not enforcing).
 */
async function runSmokeAndExpectRejection(
  stmt: ReturnType<typeof sql>,
  label: string,
  detail: string[],
): Promise<boolean> {
  try {
    await db.transaction(async (tx) => {
      try {
        await tx.execute(stmt);
        // If we reach here, Postgres did NOT reject. Force rollback
        // via thrown error so nothing commits.
        throw new Error("INSERT_UNEXPECTEDLY_SUCCEEDED");
      } catch (err: any) {
        // Bubble up so the outer caller can classify, but always force
        // a rollback by re-throwing.
        throw err;
      }
    });
    // db.transaction resolved without throwing — shouldn't happen on
    // the unhappy path, but treat as failure.
    detail.push(`smoke (${label}): UNEXPECTEDLY SUCCEEDED, no error raised`);
    return false;
  } catch (err: any) {
    const code = err?.code ?? err?.cause?.code ?? null;
    const message = (err?.message ?? err?.cause?.message ?? "")
      .toString()
      .replace(/\s+/g, " ")
      .slice(0, 200);
    if (code === PG_CHECK_VIOLATION_SQLSTATE) {
      detail.push(`smoke (${label}): rejected as expected (23514)`);
      return true;
    }
    if (message.includes("INSERT_UNEXPECTEDLY_SUCCEEDED")) {
      detail.push(
        `smoke (${label}): UNEXPECTEDLY SUCCEEDED — constraint not enforced`,
      );
      return false;
    }
    // FK violation (23503) or anything else means the CHECK didn't
    // intercept — flag it.
    detail.push(
      `smoke (${label}): rejected by something OTHER than check (${code ?? "no-code"}): ${message}`,
    );
    return false;
  }
}
