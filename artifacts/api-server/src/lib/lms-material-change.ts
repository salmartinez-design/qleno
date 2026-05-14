/**
 * Material-content-change fan-out worker (final sprint PR 4).
 *
 * When a new lms_document_versions row is created with is_material=true
 * (or when markVersionMaterial flips an existing version's flag), this
 * worker fans the re-acknowledgment requirement out to every active
 * employee in the tenant whose current signature is on an OUTDATED
 * version hash. Already-up-to-date employees are skipped.
 *
 * Two invocation paths:
 *   1. Automatic: getOrCreateDocumentVersion + markVersionMaterial
 *      call runMaterialChangeFanout() async when is_material becomes
 *      true on a new write. This is the "background worker" the spec
 *      asked for; it just rides on the existing write path instead
 *      of a separate poll loop.
 *   2. Manual: POST /api/lms/signatures/admin/material-change still
 *      delegates here (kept as an admin escape hatch).
 *
 * Idempotent: sweepForDocumentType skips users that already have an
 * unacknowledged pending_re_ack row for the same (user, doc, version).
 * Re-running is a no-op. Errors are caught + logged; the caller path
 * never throws upstream.
 *
 * Tenant-scoped: companyId is required on every call and threaded
 * through every query. Cross-tenant fanout is impossible.
 */
import { sweepForDocumentType } from "../routes/lms-annual-ack.js";

export interface MaterialChangeFanoutResult {
  document_type: string;
  swept_count: number;
  swept_user_ids: number[];
}

/**
 * Run the fanout for one (companyId, documentType). Calls
 * sweepForDocumentType with trigger_reason='material_content_change'
 * and onlyOutdated=true so up-to-date employees are skipped.
 *
 * Skips employees who haven't completed initial onboarding by virtue
 * of sweepForDocumentType only selecting users who already have an
 * active signed_document for this document_type. New hires that
 * haven't signed yet are naturally excluded.
 */
export async function runMaterialChangeFanout(args: {
  companyId: number;
  documentType: string;
  triggeredByUserId: number | null;
}): Promise<MaterialChangeFanoutResult> {
  const result = await sweepForDocumentType({
    companyId: args.companyId,
    documentType: args.documentType,
    triggeredByUserId: args.triggeredByUserId,
    triggerReason: "material_content_change",
    onlyOutdated: true,
  });
  if (result.swept_user_ids.length > 0) {
    console.log(
      `[material-change] fanout: company=${args.companyId} doc=${args.documentType} swept=${result.swept_user_ids.length}`,
    );
  }
  return {
    document_type: args.documentType,
    swept_count: result.swept_user_ids.length,
    swept_user_ids: result.swept_user_ids,
  };
}

/**
 * Fire-and-forget wrapper used by the version-creation hot path.
 * Never throws; errors are logged and swallowed so a content-version
 * insert is never blocked on a slow / failing fanout.
 */
export function fireMaterialChangeFanout(args: {
  companyId: number;
  documentType: string;
  triggeredByUserId: number | null;
}): void {
  void runMaterialChangeFanout(args).catch((err) => {
    console.error(
      `[material-change] fanout error company=${args.companyId} doc=${args.documentType}:`,
      err,
    );
  });
}
