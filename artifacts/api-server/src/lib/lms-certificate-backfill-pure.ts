/**
 * Pure helpers extracted from `lms-certificate-backfill.ts` so unit
 * tests can import them without pulling Drizzle / Postgres in at
 * module-load time. The runner file re-exports these so the public
 * API is unchanged.
 */
export interface PassedModuleRowForBackfill {
  module_progress_id: number;
  module_id: string;
  best_score: number;
  passed_at: Date | null;
  enrollment_company_id: number;
  user_id: number;
  user_company_id: number;
}

/**
 * Decide whether to issue a cert for one passed-module row.
 *
 * Returns:
 *   - { issue: true, score }                        — write cert
 *   - { issue: false, reason: "already_issued" }     — idempotent skip
 *   - { issue: false, reason: "company_id_mismatch" }— defense-in-depth
 */
export function shouldIssueCertificate(
  row: PassedModuleRowForBackfill,
  existingKey: Set<string>,
): { issue: true; score: number } | { issue: false; reason: string } {
  // Defense-in-depth: refuse to bridge across tenants. Should never
  // happen in real data; the existing enrollment-user invariant
  // guarantees match. If it does happen, skip + log instead of
  // silently writing the wrong company_id.
  if (row.enrollment_company_id !== row.user_company_id) {
    return { issue: false, reason: "company_id_mismatch" };
  }
  const key = `${row.user_id}:${row.module_id}`;
  if (existingKey.has(key)) {
    return { issue: false, reason: "already_issued" };
  }
  return { issue: true, score: row.best_score };
}
