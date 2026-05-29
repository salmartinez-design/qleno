/**
 * Cutover 1E — Application-level eligibility filter for clock events
 * entering the pay pipeline.
 *
 * The non-negotiable filter from the 1E spec:
 *
 *   An event contributes to paid hours ONLY if:
 *     (gps_status = 'captured'
 *        AND latitude IS NOT NULL
 *        AND longitude IS NOT NULL)
 *   OR
 *     (gps_status = 'failed_exception'
 *        AND exception_reason IS NOT NULL
 *        AND exception_reviewed_at IS NOT NULL)
 *
 * Anything else (unreviewed exception, malformed, half-set captured)
 * is EXCLUDED from pay. This guarantee holds even if the DB CHECK
 * constraint installed by cutover-data-migration.ts were somehow
 * absent — the pay pipeline does not trust the database alone.
 *
 * Excluded events DO NOT silently disappear: the surrounding hours-
 * computation logic flags the summary so the office sees the gap.
 */

export type EligibilityCheckInput = {
  gps_status: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
  exception_reason: string | null;
  exception_reviewed_at: Date | string | null;
};

export type EligibilityReason =
  | "eligible_captured"
  | "eligible_reviewed_exception"
  | "ineligible_captured_missing_lat"
  | "ineligible_captured_missing_lng"
  | "ineligible_exception_missing_reason"
  | "ineligible_exception_unreviewed"
  | "ineligible_unknown_gps_status";

export function classifyEligibility(
  event: EligibilityCheckInput,
): EligibilityReason {
  if (event.gps_status === "captured") {
    if (event.latitude === null) return "ineligible_captured_missing_lat";
    if (event.longitude === null) return "ineligible_captured_missing_lng";
    return "eligible_captured";
  }
  if (event.gps_status === "failed_exception") {
    if (!event.exception_reason || String(event.exception_reason).trim() === "") {
      return "ineligible_exception_missing_reason";
    }
    if (event.exception_reviewed_at == null) {
      return "ineligible_exception_unreviewed";
    }
    return "eligible_reviewed_exception";
  }
  return "ineligible_unknown_gps_status";
}

export function isEligibleForPay(event: EligibilityCheckInput): boolean {
  const r = classifyEligibility(event);
  return r === "eligible_captured" || r === "eligible_reviewed_exception";
}
