/**
 * LMS Signed Document signatures — routes (Phase 3+ PR #4 of 16).
 *
 * Generic surface used by every signed legal acknowledgment in the
 * 2026 onboarding system. PR #4 wires the first document_type
 * (drug_alcohol). PR #5+ add code_of_conduct, video_photo_release,
 * non_solicitation, supply_kit, social_media without changing this
 * file.
 *
 * Mounted at /api/lms/signatures.
 *
 * Endpoints:
 *   GET  /content?documentType=X&locale=Y   render-ready content
 *   POST /sign                              capture employee signature
 *   POST /admin/co-sign                     capture rep co-signature
 *                                            (owner / admin / office)
 *   GET  /me                                list caller's signed docs
 *   GET  /admin/learner/:userId             list signed docs for user
 *   GET  /:id/pdf                           render + stream signed PDF
 *
 * Tenant gate: every read is scoped by company_id. Co-sign and admin
 * list endpoints additionally gate on role (owner / admin / office).
 *
 * UETA / E-SIGN compliance:
 *   - Affirmative-action: the POST /sign body MUST include
 *     `affirmation: true` AND a non-empty signature payload. Server
 *     rejects otherwise.
 *   - Version binding: the content is fetched from the server-side
 *     registry at sign time. The hash captured into the row IS the
 *     hash of the exact bytes the user agreed to (registry is the
 *     source of truth, not client-supplied).
 *   - Audit: IP, device info, signed_at all stamped server-side.
 */
import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  lmsSignedDocumentsTable,
  lmsSignatureEventsTable,
  KNOWN_SIGNED_DOCUMENT_TYPES,
  CO_SIGNED_DOCUMENT_TYPES,
  type LmsSignedDocument,
} from "@workspace/db/schema";
import { requireAuth, requireRole } from "../lib/auth.js";
import {
  captureRequestMetadata,
  parseMinimalDeviceInfo,
  validateEmployeeSignature,
} from "../lib/lms-signatures.js";
import {
  getOrCreateDocumentVersion,
  getTenantOwnerForSignature,
  markVersionMaterial,
} from "../lib/lms-signatures-db.js";
import { sweepForDocumentType } from "./lms-annual-ack.js";
import {
  getSignedDocumentContent,
  isSpanishPendingTranslationReview,
} from "../lib/lms-signed-documents-content.js";
import {
  getCertificateLearnerSummary,
} from "../lib/lms-certificates.js";
import { generateSignedDocumentPdf } from "../lib/pdf-gen.js";
import { logAudit } from "../lib/audit.js";

const router = Router();

const KNOWN_TYPES = new Set<string>(KNOWN_SIGNED_DOCUMENT_TYPES);
const CO_SIGNED_TYPES = new Set<string>(CO_SIGNED_DOCUMENT_TYPES);

function isLocale(v: unknown): v is "en" | "es" {
  return v === "en" || v === "es";
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /content — render-ready content for a (documentType, locale)
// ─────────────────────────────────────────────────────────────────────────────
//
// Used by the signing UI BEFORE the user signs. The response includes
// the title, the canonical body text, and the translation-review flag
// so the UI can render the amber banner.

router.get("/content", requireAuth, async (req, res) => {
  try {
    const documentType = String(req.query.documentType ?? "");
    const locale = String(req.query.locale ?? "en");
    if (!KNOWN_TYPES.has(documentType)) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "Unknown documentType" });
    }
    if (!isLocale(locale)) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "locale must be 'en' or 'es'" });
    }
    const entry = getSignedDocumentContent(documentType, locale);
    if (!entry) {
      return res
        .status(404)
        .json({
          error: "Not Found",
          message: `No registered content for ${documentType}/${locale}`,
        });
    }
    return res.json({
      data: {
        documentType,
        locale,
        title: entry.title,
        contentHtml: entry.contentHtml,
        pendingTranslationReview: entry.pendingTranslationReview ?? false,
      },
    });
  } catch (err) {
    console.error("[lms-signatures] GET /content error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to load content" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /sign — capture employee signature for a signed document
// ─────────────────────────────────────────────────────────────────────────────
//
// Body:
//   {
//     documentType: 'drug_alcohol' | etc.,
//     locale: 'en' | 'es',
//     signatureMethod: 'drawn' | 'typed',
//     signature: string,
//     affirmation: true   // E-SIGN affirmative-action gate
//   }
//
// Server fetches the canonical content from the server-side registry,
// hashes it, upserts a version row, then inserts a new
// lms_signed_documents row scoped to the caller's tenant and userId.
// Old signatures for the same (user, document_type) are auto-marked
// 'superseded' so the latest active row is the binding one.

router.post("/sign", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const userId = req.auth!.userId;

    const documentType: string | undefined = req.body?.documentType;
    const locale: string | undefined = req.body?.locale;
    const signatureMethod: string | undefined = req.body?.signatureMethod;
    const signature: string | undefined = req.body?.signature;
    const affirmation = req.body?.affirmation === true;

    if (!documentType || !KNOWN_TYPES.has(documentType)) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "Unknown documentType" });
    }
    if (!isLocale(locale)) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "locale must be 'en' or 'es'" });
    }
    if (signatureMethod !== "drawn" && signatureMethod !== "typed") {
      return res
        .status(400)
        .json({
          error: "Bad Request",
          message: "signatureMethod must be 'drawn' or 'typed'",
        });
    }
    if (typeof signature !== "string") {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "signature is required" });
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

    const content = getSignedDocumentContent(documentType, locale);
    if (!content) {
      return res.status(404).json({
        error: "Not Found",
        message: `No registered content for ${documentType}/${locale}`,
      });
    }

    const version = await getOrCreateDocumentVersion({
      companyId,
      documentType,
      locale,
      contentHtml: content.contentHtml,
      isMaterial: false,
      notes: content.notes,
    });

    const meta = captureRequestMetadata(req);
    const deviceInfo = parseMinimalDeviceInfo(meta.user_agent);
    const now = new Date();

    // Supersede any prior active signature for this (user, document_type).
    await db
      .update(lmsSignedDocumentsTable)
      .set({ status: "superseded", superseded_at: now, updated_at: now })
      .where(
        and(
          eq(lmsSignedDocumentsTable.company_id, companyId),
          eq(lmsSignedDocumentsTable.user_id, userId),
          eq(lmsSignedDocumentsTable.document_type, documentType),
          eq(lmsSignedDocumentsTable.status, "active"),
        ),
      );

    const inserted = await db
      .insert(lmsSignedDocumentsTable)
      .values({
        company_id: companyId,
        user_id: userId,
        document_type: documentType,
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
      .returning();
    const newDoc = inserted[0];

    // Audit log
    await db.insert(lmsSignatureEventsTable).values({
      company_id: companyId,
      user_id: userId,
      event_type: "sign_completed",
      signed_document_id: newDoc.id,
      document_type: documentType,
      ip_address: meta.ip_address,
      user_agent: meta.user_agent,
      event_data: { locale, signature_method: signatureMethod },
      event_at: now,
    });
    await logAudit(
      req,
      "lms.signature.sign",
      "lms_signed_document",
      newDoc.id,
      null,
      { document_type: documentType, locale },
    );

    return res.json({
      data: {
        id: newDoc.id,
        document_type: documentType,
        locale,
        version_hash: version.version_hash,
        signed_at: now.toISOString(),
        requires_co_sign: CO_SIGNED_TYPES.has(documentType),
      },
    });
  } catch (err) {
    console.error("[lms-signatures] POST /sign error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to record signature" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/co-sign — capture Phes representative co-signature
// ─────────────────────────────────────────────────────────────────────────────
//
// Body:
//   { signed_document_id, signatureMethod, signature, affirmation }
//
// Used for Non-Solicitation Agreement (PR #7) and Video/Photo Release
// (PR #6). PR #4 ships the endpoint scaffold; the first co-signed
// document is PR #6. Caller must be owner / admin / office.

router.post(
  "/admin/co-sign",
  requireAuth,
  requireRole("owner", "admin", "office"),
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      if (companyId == null) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "User has no company assignment" });
      }
      const signedDocumentId = Number(req.body?.signed_document_id);
      const signatureMethod: string | undefined = req.body?.signatureMethod;
      const signature: string | undefined = req.body?.signature;
      const affirmation = req.body?.affirmation === true;
      if (!Number.isFinite(signedDocumentId) || signedDocumentId <= 0) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "signed_document_id is required" });
      }
      if (signatureMethod !== "drawn" && signatureMethod !== "typed") {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "signatureMethod must be drawn or typed" });
      }
      if (typeof signature !== "string") {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "signature is required" });
      }
      if (!affirmation) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "affirmation: true required" });
      }
      const validationErr = validateEmployeeSignature(signatureMethod, signature);
      if (validationErr) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: validationErr });
      }

      // Tenant gate via the signed_document row.
      const existing = await db
        .select()
        .from(lmsSignedDocumentsTable)
        .where(
          and(
            eq(lmsSignedDocumentsTable.id, signedDocumentId),
            eq(lmsSignedDocumentsTable.company_id, companyId),
          ),
        )
        .limit(1);
      if (!existing[0]) {
        return res
          .status(404)
          .json({ error: "Not Found", message: "Signed document not found" });
      }
      if (!CO_SIGNED_TYPES.has(existing[0].document_type)) {
        return res.status(400).json({
          error: "Bad Request",
          message: `Document type '${existing[0].document_type}' does not require co-signature`,
        });
      }

      const meta = captureRequestMetadata(req);
      const deviceInfo = parseMinimalDeviceInfo(meta.user_agent);
      const now = new Date();

      const updated = await db
        .update(lmsSignedDocumentsTable)
        .set({
          representative_user_id: req.auth!.userId,
          representative_signature: signature,
          representative_signature_method: signatureMethod,
          representative_signed_at: now,
          representative_ip_address: meta.ip_address,
          representative_device_info: deviceInfo,
          updated_at: now,
        })
        .where(eq(lmsSignedDocumentsTable.id, signedDocumentId))
        .returning();

      await db.insert(lmsSignatureEventsTable).values({
        company_id: companyId,
        user_id: req.auth!.userId,
        event_type: "co_signed",
        signed_document_id: signedDocumentId,
        document_type: existing[0].document_type,
        ip_address: meta.ip_address,
        user_agent: meta.user_agent,
        event_data: { signature_method: signatureMethod },
        event_at: now,
      });
      await logAudit(
        req,
        "lms.signature.co_sign",
        "lms_signed_document",
        signedDocumentId,
        null,
        { document_type: existing[0].document_type },
      );

      return res.json({ data: updated[0] });
    } catch (err) {
      console.error("[lms-signatures] POST /admin/co-sign error:", err);
      return res
        .status(500)
        .json({ error: "Internal Server Error", message: "Failed to record co-signature" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /me — caller's signed documents (newest first)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/me", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const userId = req.auth!.userId;
    const rows = await db
      .select()
      .from(lmsSignedDocumentsTable)
      .where(
        and(
          eq(lmsSignedDocumentsTable.company_id, companyId),
          eq(lmsSignedDocumentsTable.user_id, userId),
        ),
      )
      .orderBy(desc(lmsSignedDocumentsTable.signed_at));
    return res.json({ data: rows });
  } catch (err) {
    console.error("[lms-signatures] GET /me error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to list signatures" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/learner/:userId — admin: list signed docs for a user
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/admin/learner/:userId",
  requireAuth,
  requireRole("owner", "admin", "office"),
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      if (companyId == null) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "User has no company assignment" });
      }
      const targetUserId = Number(req.params.userId);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "Invalid userId" });
      }
      const rows = await db
        .select()
        .from(lmsSignedDocumentsTable)
        .where(
          and(
            eq(lmsSignedDocumentsTable.company_id, companyId),
            eq(lmsSignedDocumentsTable.user_id, targetUserId),
          ),
        )
        .orderBy(desc(lmsSignedDocumentsTable.signed_at));
      return res.json({ data: rows });
    } catch (err) {
      console.error("[lms-signatures] GET /admin/learner error:", err);
      return res
        .status(500)
        .json({
          error: "Internal Server Error",
          message: "Failed to list signed documents",
        });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id/pdf — render + stream the signed PDF
// ─────────────────────────────────────────────────────────────────────────────
//
// Caller must own the doc OR hold a privileged role. Revoked docs
// return 410. Out-of-tenant returns 404.

router.get("/:id/pdf", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const docId = Number(req.params.id);
    if (!Number.isFinite(docId) || docId <= 0) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "Invalid id" });
    }
    const rows = await db
      .select()
      .from(lmsSignedDocumentsTable)
      .where(
        and(
          eq(lmsSignedDocumentsTable.id, docId),
          eq(lmsSignedDocumentsTable.company_id, companyId),
        ),
      )
      .limit(1);
    const doc = rows[0] as LmsSignedDocument | undefined;
    if (!doc) {
      return res
        .status(404)
        .json({ error: "Not Found", message: "Signed document not found" });
    }

    // Access gate: owner of the doc OR privileged role.
    const callerRole = req.auth!.role;
    const isPrivileged =
      callerRole === "owner" ||
      callerRole === "admin" ||
      callerRole === "office" ||
      callerRole === "super_admin";
    if (!isPrivileged && doc.user_id !== req.auth!.userId) {
      return res
        .status(404)
        .json({ error: "Not Found", message: "Signed document not found" });
    }
    if (doc.status === "revoked") {
      return res
        .status(410)
        .json({ error: "Gone", message: "This signed document was revoked" });
    }

    // Resolve the canonical content again from the registry to render
    // the body. This ensures the PDF reflects EXACTLY what was hashed,
    // even if the version row's content_html in the DB drifts somehow.
    const content = getSignedDocumentContent(
      doc.document_type,
      doc.locale === "es" ? "es" : "en",
    );
    if (!content) {
      return res
        .status(404)
        .json({
          error: "Not Found",
          message: `Cannot render: ${doc.document_type}/${doc.locale} content not in registry`,
        });
    }

    const learner = await getCertificateLearnerSummary(companyId, doc.user_id);
    if (!learner) {
      return res
        .status(404)
        .json({ error: "Not Found", message: "Learner not found" });
    }

    // Representative name for co-signed docs
    let representativeName: string | null = null;
    if (doc.representative_user_id) {
      const owner = await getTenantOwnerForSignature(companyId);
      if (owner && owner.user_id === doc.representative_user_id) {
        representativeName =
          `${owner.first_name ?? ""} ${owner.last_name ?? ""}`.trim() ||
          owner.email;
      }
    }

    const pdfBytes = await generateSignedDocumentPdf({
      tenantName: "Phes",
      employeeName: learner.fullName,
      documentTitle: content.title,
      documentType: doc.document_type,
      contentBody: content.contentHtml,
      locale: doc.locale,
      pendingTranslationReview:
        doc.locale === "es" && isSpanishPendingTranslationReview(doc.document_type),
      employeeSignature: doc.employee_signature,
      employeeSignatureMethod: doc.employee_signature_method as "drawn" | "typed",
      signedAt: doc.signed_at,
      ipAddress: doc.ip_address,
      deviceInfo: doc.device_info,
      versionHash: doc.version_hash,
      representativeName,
      representativeSignature: doc.representative_signature,
      representativeSignatureMethod: doc.representative_signature_method as
        | "drawn"
        | "typed"
        | null,
      representativeSignedAt: doc.representative_signed_at,
    });

    // Audit the download
    await db.insert(lmsSignatureEventsTable).values({
      company_id: companyId,
      user_id: req.auth!.userId,
      event_type: "pdf_downloaded",
      signed_document_id: doc.id,
      document_type: doc.document_type,
      ip_address: captureRequestMetadata(req).ip_address,
      user_agent: captureRequestMetadata(req).user_agent,
      event_data: { downloader_is_owner: doc.user_id !== req.auth!.userId },
      event_at: new Date(),
    });

    const safeName = learner.fullName.replace(/[^a-zA-Z0-9_-]+/g, "_");
    const filename = `phes-${doc.document_type}-${safeName}-${doc.id}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.end(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("[lms-signatures] GET /:id/pdf error:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      message: "Failed to render signed document",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/material-change
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner / admin marks the current canonical content for a documentType
// as material and fans out a forced re-acknowledgment to every employee
// in the tenant whose active signed_document is on an OUTDATED version
// hash. Users whose active signature already matches the current hash
// are skipped — they signed the new version voluntarily and don't need
// to be pushed back into the re-sign flow.
//
// Use case: an admin edits a signed-doc content file (e.g. Drug &
// Alcohol Policy), ships the change, then calls this endpoint to flag
// the new version as legally material and force everyone on the old
// version to re-sign. Inserts pending_re_ack rows with trigger_reason
// = 'material_content_change'.
//
// Body: { documentType: KnownSignedDocumentType, notes?: string }
//
// Returns: { document_type, version_id, version_hash, swept_user_ids,
//   swept_count }

router.post(
  "/admin/material-change",
  requireAuth,
  requireRole("owner", "admin"),
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      if (companyId == null) {
        return res.status(400).json({
          error: "Bad Request",
          message: "User has no company assignment",
        });
      }
      const adminId = req.auth!.userId;
      const documentType: string | undefined = req.body?.documentType;
      const notes: string | undefined =
        typeof req.body?.notes === "string" && req.body.notes.length > 0
          ? req.body.notes
          : undefined;

      if (!documentType || !KNOWN_TYPES.has(documentType)) {
        return res.status(400).json({
          error: "Bad Request",
          message: "Unknown documentType",
        });
      }

      // Get the current canonical content for the English version
      // (English is the binding version per the brand legal pages).
      // We materialize both locales' version rows below; English
      // drives the response shape.
      const enContent = getSignedDocumentContent(documentType, "en");
      if (!enContent) {
        return res.status(404).json({
          error: "Not Found",
          message: `No registered EN content for ${documentType}`,
        });
      }

      // Materialize and mark both locales' version rows as material so
      // the audit chain reflects the policy intent in both languages.
      const enVersion = await getOrCreateDocumentVersion({
        companyId,
        documentType,
        locale: "en",
        contentHtml: enContent.contentHtml,
        isMaterial: true,
        notes,
        createdByUserId: adminId,
      });
      await markVersionMaterial(companyId, enVersion.id);

      const esContent = getSignedDocumentContent(documentType, "es");
      if (esContent) {
        const esVersion = await getOrCreateDocumentVersion({
          companyId,
          documentType,
          locale: "es",
          contentHtml: esContent.contentHtml,
          isMaterial: true,
          notes,
          createdByUserId: adminId,
        });
        await markVersionMaterial(companyId, esVersion.id);
      }

      // Sweep users whose active signature is on an outdated hash.
      const sweep = await sweepForDocumentType({
        companyId,
        documentType,
        triggeredByUserId: adminId,
        triggerReason: "material_content_change",
        onlyOutdated: true,
      });

      await logAudit(
        req,
        "lms_material_change_triggered",
        "lms_document_version",
        enVersion.id,
        null,
        {
          document_type: documentType,
          swept_count: sweep.swept_user_ids.length,
          notes: notes ?? null,
        },
      );

      return res.json({
        data: {
          document_type: documentType,
          version_id: enVersion.id,
          version_hash: enVersion.version_hash,
          swept_user_ids: sweep.swept_user_ids,
          swept_count: sweep.swept_user_ids.length,
        },
      });
    } catch (err) {
      console.error("[lms-signatures] POST /admin/material-change error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to trigger material content change",
      });
    }
  },
);

export default router;
