/**
 * LMS Completion Certificates — routes (Phase 12, PR #3 of 16).
 *
 * Endpoints (mounted at /api/lms/certificates):
 *   GET  /me                        list caller's certificates
 *   GET  /:id/pdf                   download a specific cert as PDF
 *                                   (tenant-gated; 404 if not in tenant
 *                                   or if the cert was revoked)
 *   GET  /admin/learner/:userId     list certs for a user in caller's
 *                                   tenant (owner / admin / office)
 *
 * PDFs are rendered on-demand from the cert row + learner identity.
 * No on-disk storage — pdf_storage_url stays null. This keeps Railway
 * deploys disk-free and gives the renderer a single source of truth.
 *
 * Issuance happens elsewhere (routes/lms.ts on /quiz/submit,
 * /module/acknowledge, /admin/bypass-module). This file only serves
 * already-issued certs.
 */
import { Router } from "express";
import { requireAuth, requireRole } from "../lib/auth.js";
import {
  getCertificateById,
  getCertificateLearnerSummary,
  listCertificatesForUser,
} from "../lib/lms-certificates.js";
import { generateCertificatePdf } from "../lib/pdf-gen.js";
import { getCurriculumModuleTitle } from "../lib/lms-curriculum-titles.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /me — caller's certificates (newest first)
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
    const rows = await listCertificatesForUser(companyId, userId);
    return res.json({ data: rows });
  } catch (err) {
    console.error("[lms-certificates] GET /me error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to list certificates" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/learner/:userId — admin-side certificate audit
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner / admin / office can list certs for any user in their tenant.
// Used by /lms/admin per-learner detail panel.

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
      const rows = await listCertificatesForUser(companyId, targetUserId);
      return res.json({ data: rows });
    } catch (err) {
      console.error("[lms-certificates] GET /admin/learner error:", err);
      return res
        .status(500)
        .json({ error: "Internal Server Error", message: "Failed to list certificates" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id/pdf — render and stream the certificate as a PDF
// ─────────────────────────────────────────────────────────────────────────────
//
// Tenant gate: the cert is fetched by (id, company_id). Anyone outside
// the tenant gets 404. Within the tenant, both the learner themselves
// AND any owner / admin / office user can download. The route does NOT
// require the admin role; it requires that the caller either owns the
// cert (caller.userId === cert.user_id) OR holds a privileged role.

router.get("/:id/pdf", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const certificateId = Number(req.params.id);
    if (!Number.isFinite(certificateId) || certificateId <= 0) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "Invalid certificate id" });
    }

    const cert = await getCertificateById(companyId, certificateId);
    if (!cert) {
      return res
        .status(404)
        .json({ error: "Not Found", message: "Certificate not found" });
    }

    // Access gate: caller is the cert owner OR a privileged role.
    const callerRole = req.auth!.role;
    const isPrivileged =
      callerRole === "owner" ||
      callerRole === "admin" ||
      callerRole === "office" ||
      callerRole === "super_admin";
    if (!isPrivileged && cert.user_id !== req.auth!.userId) {
      return res
        .status(404)
        .json({ error: "Not Found", message: "Certificate not found" });
    }

    if (cert.revoked_at) {
      return res
        .status(410)
        .json({
          error: "Gone",
          message: "This certificate was revoked",
          revoked_reason: cert.revoked_reason,
        });
    }

    const learner = await getCertificateLearnerSummary(companyId, cert.user_id);
    if (!learner) {
      return res
        .status(404)
        .json({ error: "Not Found", message: "Learner not found" });
    }

    // Tenant brand name on the cert. For Phes that's "Phes"; future
    // tenants would resolve from `companies.name` — for now we use the
    // curriculum tenant label since that's already the source of truth
    // for the LMS surface.
    const tenantName = "Phes"; // TODO PR #15: resolve via companies.name

    const moduleTitle = getCurriculumModuleTitle(
      cert.module_id,
      cert.locale === "es" ? "es" : "en",
    );

    const pdfBytes = await generateCertificatePdf({
      tenantName,
      employeeName: learner.fullName,
      moduleTitle,
      moduleId: cert.module_id,
      score: cert.score,
      issuedAt: cert.issued_at,
      curriculumVersionHash: cert.curriculum_version_hash,
      locale: cert.locale,
      ipAddress: cert.ip_address,
      deviceInfo: cert.device_info,
    });

    const safeName = learner.fullName.replace(/[^a-zA-Z0-9_-]+/g, "_");
    const filename = `phes-${cert.module_id}-${safeName}-${cert.id}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    return res.end(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("[lms-certificates] GET /:id/pdf error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to render certificate" });
  }
});

export default router;
