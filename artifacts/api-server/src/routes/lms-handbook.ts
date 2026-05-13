/**
 * LMS Comprehensive Handbook — routes (Phase 11, PR #13 of 16).
 *
 * The final step of the onboarding (and annual) flow: a single signed
 * comprehensive PDF that bundles cover + handbook contents summary +
 * every standalone signed acknowledgment + the final at-will /
 * commission consent / wage deduction notice / annual re-ack page.
 *
 * Mounted at /api/lms/handbook.
 *
 * Endpoints:
 *   GET  /eligibility               { eligible, missing_modules, missing_docs }
 *   GET  /preview                   PDF preview without signature
 *                                    (owner / admin only; for review)
 *   POST /sign                      capture signature + generate + store PDF
 *   GET  /me/pdf                    caller's active signed handbook PDF
 *   GET  /admin/learner/:userId/pdf admin pulls any learner's PDF
 *
 * Eligibility gate: caller must have status='passed' on every
 * QUIZ_MODULE_IDS module AND an active signed_document for every
 * REQUIRED_PRE_FINAL_SIGNED_DOCS slug. Phase 13 will add "final exam
 * passed" as a third gate; for now the 13 modules + 6 docs are the
 * full gate.
 *
 * Owner / admin bypass: /preview rejects employees but accepts owner /
 * admin, returning a PREVIEW-watermarked PDF without a signature
 * block. Signing endpoint still requires an actual eligibility pass.
 *
 * Tenant isolation: every read filters by req.auth.companyId. Admin
 * cross-tenant reads return 404 not 403 to avoid information leak.
 *
 * UETA / E-SIGN: POST /sign requires affirmation:true + a non-empty
 * signature payload + a server-side fetch of the canonical content.
 * IP and user-agent stamped server-side; pdf_storage_url stays null
 * because pdfs render on-demand from the row (same pattern as
 * lms-certificates.ts).
 */
import { Router } from "express";
import { and, eq, desc, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  lmsSignedDocumentsTable,
  lmsSignatureEventsTable,
  lmsCompletionCertificatesTable,
  lmsEnrollmentsTable,
  lmsModuleProgressTable,
  REQUIRED_PRE_FINAL_SIGNED_DOCS,
  type LmsSignedDocument,
} from "@workspace/db/schema";
import { QUIZ_MODULE_IDS, FINAL_MODULE_ID } from "@workspace/lms-curriculum";
import { requireAuth, requireRole } from "../lib/auth.js";
import {
  captureRequestMetadata,
  parseMinimalDeviceInfo,
  validateEmployeeSignature,
  hashContent,
} from "../lib/lms-signatures.js";
import {
  getOrCreateDocumentVersion,
  getMissingRequiredSignedDocs,
} from "../lib/lms-signatures-db.js";
import {
  getSignedDocumentContent,
} from "../lib/lms-signed-documents-content.js";
import { getCertificateLearnerSummary } from "../lib/lms-certificates.js";
import { getCurriculumModuleTitle } from "../lib/lms-curriculum-titles.js";
import {
  generateComprehensiveHandbookPdf,
  type SignedAckSummary,
} from "../lib/lms-handbook-pdf.js";
import { acknowledgePendingReAcksForSign } from "./lms-annual-ack.js";
import { logAudit } from "../lib/audit.js";

const router = Router();

const HANDBOOK_DOCUMENT_TYPE = "handbook";
const HANDBOOK_MODULE_ID = "__handbook";

function isLocale(v: unknown): v is "en" | "es" {
  return v === "en" || v === "es";
}

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getPassedModuleIds(
  companyId: number,
  userId: number,
): Promise<string[]> {
  // Find the enrollment, then the passed modules.
  const enrollment = await db
    .select({ id: lmsEnrollmentsTable.id })
    .from(lmsEnrollmentsTable)
    .where(
      and(
        eq(lmsEnrollmentsTable.company_id, companyId),
        eq(lmsEnrollmentsTable.user_id, userId),
      ),
    )
    .limit(1);
  if (!enrollment[0]) return [];
  const rows = await db
    .select({ module_id: lmsModuleProgressTable.module_id })
    .from(lmsModuleProgressTable)
    .where(
      and(
        eq(lmsModuleProgressTable.enrollment_id, enrollment[0].id),
        eq(lmsModuleProgressTable.status, "passed"),
      ),
    );
  return rows.map((r) => r.module_id);
}

interface EligibilityResult {
  eligible: boolean;
  missing_modules: string[];
  missing_signed_docs: string[];
  passed_modules: string[];
  /**
   * Phase 13 (PR #14): the final comprehensive exam is the third gate.
   * Returns true iff the learner has a passed module_progress row with
   * module_id === FINAL_MODULE_ID. The final exam itself is wired via
   * routes/lms.ts /quiz/submit which already accepts the __final id.
   */
  final_exam_passed: boolean;
}

async function checkEligibility(
  companyId: number,
  userId: number,
): Promise<EligibilityResult> {
  const [passed, missingDocs] = await Promise.all([
    getPassedModuleIds(companyId, userId),
    getMissingRequiredSignedDocs(companyId, userId),
  ]);
  const passedSet = new Set(passed);
  const missingModules = [...QUIZ_MODULE_IDS].filter(
    (m) => !passedSet.has(m),
  );
  const finalExamPassed = passedSet.has(FINAL_MODULE_ID);
  return {
    eligible:
      missingModules.length === 0 &&
      missingDocs.length === 0 &&
      finalExamPassed,
    missing_modules: missingModules,
    missing_signed_docs: missingDocs,
    passed_modules: passed,
    final_exam_passed: finalExamPassed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /eligibility — gating signal for the frontend
// ─────────────────────────────────────────────────────────────────────────────

router.get("/eligibility", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res.status(400).json({
        error: "Bad Request",
        message: "User has no company assignment",
      });
    }
    const result = await checkEligibility(companyId, req.auth!.userId);
    return res.json({ data: result });
  } catch (err) {
    console.error("[lms-handbook] GET /eligibility error:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      message: "Failed to check handbook eligibility",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /sign — capture signature + create signed_document + cert
// ─────────────────────────────────────────────────────────────────────────────

router.post("/sign", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res.status(400).json({
        error: "Bad Request",
        message: "User has no company assignment",
      });
    }
    const userId = req.auth!.userId;
    const locale = req.body?.locale;
    const signatureMethod = req.body?.signatureMethod;
    const signature = req.body?.signature;
    const affirmation = req.body?.affirmation === true;

    if (!isLocale(locale)) {
      return res.status(400).json({
        error: "Bad Request",
        message: "locale must be 'en' or 'es'",
      });
    }
    if (signatureMethod !== "drawn" && signatureMethod !== "typed") {
      return res.status(400).json({
        error: "Bad Request",
        message: "signatureMethod must be 'drawn' or 'typed'",
      });
    }
    if (typeof signature !== "string") {
      return res.status(400).json({
        error: "Bad Request",
        message: "signature is required",
      });
    }
    if (!affirmation) {
      return res.status(400).json({
        error: "Bad Request",
        message:
          "UETA / E-SIGN requires affirmative agreement. Send affirmation: true.",
      });
    }
    const validationErr = validateEmployeeSignature(signatureMethod, signature);
    if (validationErr) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: validationErr });
    }

    // Eligibility gate — owners are NOT exempt here; the handbook
    // signature is a record-of-completion, not a content gate.
    // If you need a preview, use /preview (admin-only).
    const eligibility = await checkEligibility(companyId, userId);
    if (!eligibility.eligible) {
      return res.status(409).json({
        error: "Conflict",
        message:
          "Not eligible to sign the comprehensive handbook yet. Finish missing modules and standalone acknowledgments first.",
        data: eligibility,
      });
    }

    // Canonical content + version registry.
    const content = getSignedDocumentContent(HANDBOOK_DOCUMENT_TYPE, locale);
    if (!content) {
      return res.status(404).json({
        error: "Not Found",
        message: `No registered handbook content for locale ${locale}`,
      });
    }
    const version = await getOrCreateDocumentVersion({
      companyId,
      documentType: HANDBOOK_DOCUMENT_TYPE,
      locale,
      contentHtml: content.contentHtml,
      isMaterial: false,
      notes: content.notes,
    });

    const meta = captureRequestMetadata(req);
    const deviceInfo = parseMinimalDeviceInfo(meta.user_agent);
    const now = new Date();

    // Supersede any prior active handbook signature (annual recurrence).
    await db
      .update(lmsSignedDocumentsTable)
      .set({ status: "superseded", superseded_at: now, updated_at: now })
      .where(
        and(
          eq(lmsSignedDocumentsTable.company_id, companyId),
          eq(lmsSignedDocumentsTable.user_id, userId),
          eq(lmsSignedDocumentsTable.document_type, HANDBOOK_DOCUMENT_TYPE),
          eq(lmsSignedDocumentsTable.status, "active"),
        ),
      );

    // Insert the new signed_document row.
    const inserted = await db
      .insert(lmsSignedDocumentsTable)
      .values({
        company_id: companyId,
        user_id: userId,
        document_type: HANDBOOK_DOCUMENT_TYPE,
        document_version_id: version.id,
        locale,
        version_hash: version.version_hash,
        employee_signature: signature,
        employee_signature_method: signatureMethod,
        signed_at: now,
        ip_address: meta.ip_address,
        device_info: deviceInfo,
        status: "active",
      })
      .returning({ id: lmsSignedDocumentsTable.id });
    const signedDocumentId = inserted[0]!.id;

    // Mirror as a completion certificate so the admin roster lights
    // up. module_id "__handbook" is the reserved id for this event.
    await db.insert(lmsCompletionCertificatesTable).values({
      company_id: companyId,
      user_id: userId,
      module_id: HANDBOOK_MODULE_ID,
      quiz_attempt_id: null,
      score: null,
      passed: true,
      curriculum_version_hash: hashContent(content.contentHtml, locale),
      locale,
      ip_address: meta.ip_address,
      device_info: deviceInfo,
      issued_at: now,
    });

    // Audit event.
    await db.insert(lmsSignatureEventsTable).values({
      company_id: companyId,
      user_id: userId,
      event_type: "sign_completed",
      signed_document_id: signedDocumentId,
      document_type: HANDBOOK_DOCUMENT_TYPE,
      ip_address: meta.ip_address,
      user_agent: meta.user_agent,
      event_data: {
        signature_method: signatureMethod,
        version_hash: version.version_hash,
      },
    });

    // Settle any outstanding annual / forced re-ack rows for this user
    // and document. Tenant-scoped; runs even when no cycle is active
    // because admin force-resign rows live outside cycles.
    const acknowledgedCount = await acknowledgePendingReAcksForSign({
      companyId,
      userId,
      documentType: HANDBOOK_DOCUMENT_TYPE,
      signedDocumentId,
      now,
    });

    await logAudit(req, "lms_handbook_signed", "lms_signed_document", signedDocumentId, null, {
      pending_re_acks_settled: acknowledgedCount,
    });

    return res.json({
      data: {
        signed_document_id: signedDocumentId,
        version_hash: version.version_hash,
        signed_at: now,
      },
    });
  } catch (err) {
    console.error("[lms-handbook] POST /sign error:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      message: "Failed to sign the comprehensive handbook",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal: build the PDF for a (companyId, userId) — used by both
// /me/pdf and /admin/learner/:userId/pdf and /preview.
// ─────────────────────────────────────────────────────────────────────────────

async function buildHandbookPdfForUser(args: {
  companyId: number;
  userId: number;
  preview: boolean;
  /** When preview=false, the signed_document row to render. */
  signedDoc?: LmsSignedDocument;
  /** When preview=true, the locale to render in. */
  previewLocale?: "en" | "es";
}): Promise<Uint8Array | null> {
  const { companyId, userId, preview, signedDoc, previewLocale } = args;

  const learner = await getCertificateLearnerSummary(companyId, userId);
  if (!learner) return null;

  const locale = preview
    ? previewLocale ?? "en"
    : ((signedDoc!.locale === "es" ? "es" : "en") as "en" | "es");

  const content = getSignedDocumentContent(HANDBOOK_DOCUMENT_TYPE, locale);
  if (!content) return null;

  // Pull all active standalone acks for this user (for the table page).
  const required = [...REQUIRED_PRE_FINAL_SIGNED_DOCS];
  const ackRows = required.length
    ? await db
        .select({
          document_type: lmsSignedDocumentsTable.document_type,
          signed_at: lmsSignedDocumentsTable.signed_at,
          version_hash: lmsSignedDocumentsTable.version_hash,
          locale: lmsSignedDocumentsTable.locale,
        })
        .from(lmsSignedDocumentsTable)
        .where(
          and(
            eq(lmsSignedDocumentsTable.company_id, companyId),
            eq(lmsSignedDocumentsTable.user_id, userId),
            eq(lmsSignedDocumentsTable.status, "active"),
            inArray(lmsSignedDocumentsTable.document_type, required),
          ),
        )
    : [];

  const includedAcks: SignedAckSummary[] = ackRows.map((row) => {
    const ackContent = getSignedDocumentContent(
      row.document_type,
      isLocale(row.locale) ? row.locale : locale,
    );
    return {
      documentType: row.document_type,
      title: ackContent?.title ?? row.document_type,
      signedAt: row.signed_at as Date,
      versionHash: row.version_hash,
    };
  });

  // Module titles for the contents page.
  const moduleTitles: Record<string, string> = {};
  for (const m of QUIZ_MODULE_IDS) {
    moduleTitles[m] = getCurriculumModuleTitle(m, locale);
  }

  const passed = await getPassedModuleIds(companyId, userId);

  const versionHash = signedDoc?.version_hash ?? hashContent(content.contentHtml, locale);

  return generateComprehensiveHandbookPdf({
    tenantName: "Phes",
    employeeName: learner.fullName,
    locale,
    pendingTranslationReview: content.pendingTranslationReview ?? false,
    contentBody: content.contentHtml,
    employeeSignature: preview ? null : signedDoc!.employee_signature,
    employeeSignatureMethod: preview
      ? null
      : (signedDoc!.employee_signature_method as "drawn" | "typed"),
    signedAt: preview ? null : (signedDoc!.signed_at as Date),
    ipAddress: preview ? null : signedDoc!.ip_address,
    deviceInfo: preview ? null : signedDoc!.device_info,
    versionHash,
    includedAcks,
    completedModuleIds: passed,
    moduleTitles,
    preview,
  });
}

async function findActiveHandbook(
  companyId: number,
  userId: number,
): Promise<LmsSignedDocument | null> {
  const rows = await db
    .select()
    .from(lmsSignedDocumentsTable)
    .where(
      and(
        eq(lmsSignedDocumentsTable.company_id, companyId),
        eq(lmsSignedDocumentsTable.user_id, userId),
        eq(lmsSignedDocumentsTable.document_type, HANDBOOK_DOCUMENT_TYPE),
        eq(lmsSignedDocumentsTable.status, "active"),
      ),
    )
    .orderBy(desc(lmsSignedDocumentsTable.signed_at))
    .limit(1);
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /me/pdf — caller's active signed handbook PDF
// ─────────────────────────────────────────────────────────────────────────────

router.get("/me/pdf", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res.status(400).json({
        error: "Bad Request",
        message: "User has no company assignment",
      });
    }
    const userId = req.auth!.userId;
    const signedDoc = await findActiveHandbook(companyId, userId);
    if (!signedDoc) {
      return res.status(404).json({
        error: "Not Found",
        message: "No active signed handbook on file",
      });
    }
    const pdf = await buildHandbookPdfForUser({
      companyId,
      userId,
      preview: false,
      signedDoc,
    });
    if (!pdf) {
      return res.status(404).json({
        error: "Not Found",
        message: "Handbook content not available",
      });
    }
    // Log the download as an audit event.
    const meta = captureRequestMetadata(req);
    await db.insert(lmsSignatureEventsTable).values({
      company_id: companyId,
      user_id: userId,
      event_type: "pdf_downloaded",
      signed_document_id: signedDoc.id,
      document_type: HANDBOOK_DOCUMENT_TYPE,
      ip_address: meta.ip_address,
      user_agent: meta.user_agent,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="phes-handbook-${userId}.pdf"`,
    );
    return res.end(Buffer.from(pdf));
  } catch (err) {
    console.error("[lms-handbook] GET /me/pdf error:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      message: "Failed to render handbook PDF",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/learner/:userId/pdf — admin pulls any learner's PDF
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/admin/learner/:userId/pdf",
  requireAuth,
  requireRole("owner", "admin", "office"),
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      if (companyId == null) {
        return res.status(400).json({
          error: "Bad Request",
          message: "User has no company assignment",
        });
      }
      const targetUserId = Number(req.params.userId);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "Invalid userId" });
      }
      const signedDoc = await findActiveHandbook(companyId, targetUserId);
      if (!signedDoc) {
        return res.status(404).json({
          error: "Not Found",
          message: "No active signed handbook on file for that learner",
        });
      }
      const pdf = await buildHandbookPdfForUser({
        companyId,
        userId: targetUserId,
        preview: false,
        signedDoc,
      });
      if (!pdf) return res.status(404).json({ error: "Not Found" });
      await logAudit(
        req,
        "lms_handbook_admin_pulled",
        "lms_signed_document",
        signedDoc.id,
      );
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="phes-handbook-${targetUserId}.pdf"`,
      );
      return res.end(Buffer.from(pdf));
    } catch (err) {
      console.error("[lms-handbook] GET /admin/:userId/pdf error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to render handbook PDF",
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /preview — owner / admin can preview the PDF format without signing
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/preview",
  requireAuth,
  requireRole("owner", "admin", "office"),
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      if (companyId == null) {
        return res.status(400).json({
          error: "Bad Request",
          message: "User has no company assignment",
        });
      }
      const userId = req.auth!.userId;
      const locale = req.query.locale === "es" ? "es" : "en";
      const pdf = await buildHandbookPdfForUser({
        companyId,
        userId,
        preview: true,
        previewLocale: locale,
      });
      if (!pdf) {
        return res
          .status(404)
          .json({ error: "Not Found", message: "Preview unavailable" });
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="phes-handbook-preview.pdf"`,
      );
      return res.end(Buffer.from(pdf));
    } catch (err) {
      console.error("[lms-handbook] GET /preview error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to render preview",
      });
    }
  },
);

export default router;
