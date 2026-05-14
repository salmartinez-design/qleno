/**
 * LMS Admin Audit dashboard — routes (Phase 15, PR #16 of 16).
 *
 * One comprehensive endpoint that returns per-learner compliance for
 * every employee in the tenant. Used by the /lms/admin "Audit" panel
 * to render the legal compliance grid, and by the CSV export for
 * payroll / HR records.
 *
 * Mounted at /api/lms/admin-audit. Every endpoint is owner / admin /
 * office only.
 *
 * Endpoints:
 *   GET  /summary           per-learner audit roster (JSON)
 *   GET  /summary.csv       same data, RFC-4180 CSV download
 *   GET  /learner/:userId   deep view: every cert, doc, pending re-ack
 *
 * Performance: one round-trip per table (enrollments, module_progress,
 * signed_documents, pending_re_ack, completion_certificates), then
 * in-memory aggregation. For Phes scale (under a few hundred employees
 * per tenant) this is well under 100 ms.
 *
 * Tenant isolation: every query filters by req.auth.companyId. Cross-
 * tenant reads return 404 — same pattern as the existing handbook
 * admin endpoints.
 */
import { Router } from "express";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  usersTable,
  lmsEnrollmentsTable,
  lmsModuleProgressTable,
  lmsSignedDocumentsTable,
  lmsPendingReAckTable,
  lmsCompletionCertificatesTable,
  REQUIRED_PRE_FINAL_SIGNED_DOCS,
} from "@workspace/db/schema";
import {
  QUIZ_MODULE_IDS,
  FINAL_MODULE_ID,
} from "@workspace/lms-curriculum";
import { requireAuth, requireRole } from "../lib/auth.js";
import {
  computeCompliance,
  buildAuditCsv,
  type ComplianceFlags,
  type AuditCsvRowInput,
} from "../lib/lms-admin-audit.js";
import { logAudit } from "../lib/audit.js";

const router = Router();

const HANDBOOK_DOCUMENT_TYPE = "handbook";

interface AuditRosterRow {
  user_id: number;
  full_name: string;
  email: string;
  role: string;
  hire_date: string | null;
  termination_date: string | null;
  enrollment: {
    id: number;
    status: string;
    enrolled_at: Date;
    deadline_at: Date | null;
    completed_at: Date | null;
    last_activity_at: Date | null;
  } | null;
  passed_module_ids: string[];
  signed_document_types: string[];
  handbook_signed_at: Date | null;
  final_passed_at: Date | null;
  pending_re_acks: Array<{
    id: number;
    document_type: string;
    trigger_reason: string;
    triggered_at: Date;
    defer_until: Date | null;
  }>;
  compliance: ComplianceFlags;
}

async function loadAuditRoster(
  companyId: number,
): Promise<AuditRosterRow[]> {
  // 1. All non-archived users in the tenant. Item 3 (P0 sprint):
  // archived_at IS NOT NULL hides the user from the LMS roster +
  // audit dashboard while preserving certs / signatures for legal.
  const users = await db
    .select({
      id: usersTable.id,
      first_name: usersTable.first_name,
      last_name: usersTable.last_name,
      email: usersTable.email,
      role: usersTable.role,
      hire_date: usersTable.hire_date,
      termination_date: usersTable.termination_date,
    })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.company_id, companyId),
        isNull(usersTable.archived_at),
      ),
    );

  if (users.length === 0) return [];

  const userIds = users.map((u) => u.id);

  // 2. Enrollments + module progress for the tenant.
  const enrollments = await db
    .select()
    .from(lmsEnrollmentsTable)
    .where(eq(lmsEnrollmentsTable.company_id, companyId));
  const enrollmentByUser = new Map<number, (typeof enrollments)[number]>();
  for (const e of enrollments) enrollmentByUser.set(e.user_id, e);
  const enrollmentIds = enrollments.map((e) => e.id);

  const progressRows = enrollmentIds.length
    ? await db
        .select()
        .from(lmsModuleProgressTable)
        .where(
          inArray(lmsModuleProgressTable.enrollment_id, enrollmentIds),
        )
    : [];
  const passedByUser = new Map<number, string[]>();
  const finalPassedAtByUser = new Map<number, Date>();
  for (const p of progressRows) {
    if (p.status !== "passed") continue;
    const enrollment = enrollments.find((e) => e.id === p.enrollment_id);
    if (!enrollment) continue;
    const arr = passedByUser.get(enrollment.user_id) ?? [];
    arr.push(p.module_id);
    passedByUser.set(enrollment.user_id, arr);
    if (p.module_id === FINAL_MODULE_ID && p.passed_at) {
      finalPassedAtByUser.set(enrollment.user_id, p.passed_at as Date);
    }
  }

  // 3. Active signed documents (all types).
  const signedDocs = await db
    .select({
      user_id: lmsSignedDocumentsTable.user_id,
      document_type: lmsSignedDocumentsTable.document_type,
      signed_at: lmsSignedDocumentsTable.signed_at,
    })
    .from(lmsSignedDocumentsTable)
    .where(
      and(
        eq(lmsSignedDocumentsTable.company_id, companyId),
        eq(lmsSignedDocumentsTable.status, "active"),
        inArray(lmsSignedDocumentsTable.user_id, userIds),
      ),
    );
  const signedByUser = new Map<number, string[]>();
  const handbookSignedAtByUser = new Map<number, Date>();
  for (const d of signedDocs) {
    const arr = signedByUser.get(d.user_id) ?? [];
    arr.push(d.document_type);
    signedByUser.set(d.user_id, arr);
    if (d.document_type === HANDBOOK_DOCUMENT_TYPE) {
      handbookSignedAtByUser.set(d.user_id, d.signed_at as Date);
    }
  }

  // 4. Open pending re-acks.
  const pendingRows = await db
    .select({
      id: lmsPendingReAckTable.id,
      user_id: lmsPendingReAckTable.user_id,
      document_type: lmsPendingReAckTable.document_type,
      trigger_reason: lmsPendingReAckTable.trigger_reason,
      triggered_at: lmsPendingReAckTable.triggered_at,
      defer_until: lmsPendingReAckTable.defer_until,
    })
    .from(lmsPendingReAckTable)
    .where(
      and(
        eq(lmsPendingReAckTable.company_id, companyId),
        isNull(lmsPendingReAckTable.acknowledged_at),
        inArray(lmsPendingReAckTable.user_id, userIds),
      ),
    );
  const pendingByUser = new Map<number, AuditRosterRow["pending_re_acks"]>();
  for (const p of pendingRows) {
    const arr = pendingByUser.get(p.user_id) ?? [];
    arr.push({
      id: p.id,
      document_type: p.document_type,
      trigger_reason: p.trigger_reason,
      triggered_at: p.triggered_at as Date,
      defer_until: (p.defer_until as Date | null) ?? null,
    });
    pendingByUser.set(p.user_id, arr);
  }

  // 5. Assemble rows + compute compliance.
  const rows: AuditRosterRow[] = users.map((u) => {
    const enrollment = enrollmentByUser.get(u.id) ?? null;
    const passed = passedByUser.get(u.id) ?? [];
    const signed = signedByUser.get(u.id) ?? [];
    const pending = pendingByUser.get(u.id) ?? [];
    const handbookAt = handbookSignedAtByUser.get(u.id) ?? null;
    const finalAt = finalPassedAtByUser.get(u.id) ?? null;
    const compliance = computeCompliance({
      passed_module_ids: passed,
      signed_document_types: signed,
      handbook_signed: handbookAt !== null,
      pending_re_ack_count: pending.length,
      deadline_at: enrollment?.deadline_at ?? null,
    });
    return {
      user_id: u.id,
      full_name:
        `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() ||
        `User #${u.id}`,
      email: u.email,
      role: u.role,
      hire_date: u.hire_date,
      termination_date: u.termination_date,
      enrollment: enrollment
        ? {
            id: enrollment.id,
            status: enrollment.status,
            enrolled_at: enrollment.enrolled_at as Date,
            deadline_at: (enrollment.deadline_at as Date | null) ?? null,
            completed_at: (enrollment.completed_at as Date | null) ?? null,
            last_activity_at:
              (enrollment.last_activity_at as Date | null) ?? null,
          }
        : null,
      passed_module_ids: passed,
      signed_document_types: signed,
      handbook_signed_at: handbookAt,
      final_passed_at: finalAt,
      pending_re_acks: pending,
      compliance,
    };
  });

  // Most-recent activity first, then by name for ties.
  rows.sort((a, b) => {
    const at = a.enrollment?.last_activity_at?.getTime() ?? 0;
    const bt = b.enrollment?.last_activity_at?.getTime() ?? 0;
    if (at !== bt) return bt - at;
    return a.full_name.localeCompare(b.full_name);
  });

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /summary — full audit roster (JSON)
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/summary",
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
      const rows = await loadAuditRoster(companyId);

      // Top-level tenant rollup so the dashboard tile can show totals
      // without iterating the array.
      const totals = {
        learners: rows.length,
        complete: 0,
        in_progress: 0,
        overdue: 0,
        needs_resign: 0,
        pending_re_acks: 0,
      };
      for (const r of rows) {
        totals[r.compliance.overall] += 1;
        totals.pending_re_acks += r.compliance.pending_count;
      }

      return res.json({
        data: {
          totals,
          rows,
          quiz_module_ids: [...QUIZ_MODULE_IDS],
          required_signed_docs: [...REQUIRED_PRE_FINAL_SIGNED_DOCS],
        },
      });
    } catch (err) {
      console.error("[lms-admin-audit] GET /summary error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to load audit summary",
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /summary.csv — same data, CSV download
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/summary.csv",
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
      const rows = await loadAuditRoster(companyId);
      const csvRows: AuditCsvRowInput[] = rows.map((r) => ({
        user_id: r.user_id,
        full_name: r.full_name,
        email: r.email,
        role: r.role,
        hire_date: r.hire_date,
        enrolled_at: r.enrollment?.enrolled_at ?? null,
        deadline_at: r.enrollment?.deadline_at ?? null,
        completed_at: r.enrollment?.completed_at ?? null,
        last_activity_at: r.enrollment?.last_activity_at ?? null,
        compliance: r.compliance,
        handbook_signed_at: r.handbook_signed_at,
        final_passed_at: r.final_passed_at,
      }));
      const csv = buildAuditCsv(csvRows);

      const today = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="phes-lms-audit-${today}.csv"`,
      );
      await logAudit(
        req,
        "lms_admin_audit_csv_exported",
        "lms_admin_audit",
        null,
        null,
        { learner_count: rows.length },
      );
      return res.send(csv);
    } catch (err) {
      console.error("[lms-admin-audit] GET /summary.csv error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to export audit CSV",
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /learner/:userId — deep view for a single employee
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/learner/:userId",
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

      const user = await db
        .select({
          id: usersTable.id,
          first_name: usersTable.first_name,
          last_name: usersTable.last_name,
          email: usersTable.email,
          role: usersTable.role,
          hire_date: usersTable.hire_date,
          termination_date: usersTable.termination_date,
        })
        .from(usersTable)
        .where(
          and(
            eq(usersTable.id, targetUserId),
            eq(usersTable.company_id, companyId),
          ),
        )
        .limit(1);
      if (!user[0]) {
        return res.status(404).json({
          error: "Not Found",
          message: "Learner not found in this tenant",
        });
      }

      const [enrollment] = await db
        .select()
        .from(lmsEnrollmentsTable)
        .where(
          and(
            eq(lmsEnrollmentsTable.company_id, companyId),
            eq(lmsEnrollmentsTable.user_id, targetUserId),
          ),
        )
        .limit(1);

      const progress = enrollment
        ? await db
            .select()
            .from(lmsModuleProgressTable)
            .where(eq(lmsModuleProgressTable.enrollment_id, enrollment.id))
        : [];

      const signedDocs = await db
        .select()
        .from(lmsSignedDocumentsTable)
        .where(
          and(
            eq(lmsSignedDocumentsTable.company_id, companyId),
            eq(lmsSignedDocumentsTable.user_id, targetUserId),
          ),
        )
        .orderBy(desc(lmsSignedDocumentsTable.signed_at));

      const certificates = await db
        .select()
        .from(lmsCompletionCertificatesTable)
        .where(
          and(
            eq(lmsCompletionCertificatesTable.company_id, companyId),
            eq(lmsCompletionCertificatesTable.user_id, targetUserId),
          ),
        )
        .orderBy(desc(lmsCompletionCertificatesTable.issued_at));

      const pending = await db
        .select()
        .from(lmsPendingReAckTable)
        .where(
          and(
            eq(lmsPendingReAckTable.company_id, companyId),
            eq(lmsPendingReAckTable.user_id, targetUserId),
          ),
        )
        .orderBy(desc(lmsPendingReAckTable.triggered_at));

      const passedModuleIds = progress
        .filter((p) => p.status === "passed")
        .map((p) => p.module_id);
      const activeSignedTypes = signedDocs
        .filter((d) => d.status === "active")
        .map((d) => d.document_type);
      const handbookRow = signedDocs.find(
        (d) => d.document_type === HANDBOOK_DOCUMENT_TYPE && d.status === "active",
      );
      const finalProgress = progress.find(
        (p) => p.module_id === FINAL_MODULE_ID && p.status === "passed",
      );
      const openPending = pending.filter((p) => p.acknowledged_at === null);
      const compliance = computeCompliance({
        passed_module_ids: passedModuleIds,
        signed_document_types: activeSignedTypes,
        handbook_signed: !!handbookRow,
        pending_re_ack_count: openPending.length,
        deadline_at: enrollment?.deadline_at ?? null,
      });

      return res.json({
        data: {
          user: {
            id: user[0].id,
            full_name:
              `${user[0].first_name ?? ""} ${user[0].last_name ?? ""}`.trim() ||
              `User #${user[0].id}`,
            email: user[0].email,
            role: user[0].role,
            hire_date: user[0].hire_date,
            termination_date: user[0].termination_date,
          },
          enrollment: enrollment ?? null,
          module_progress: progress,
          signed_documents: signedDocs,
          certificates,
          pending_re_acks: pending,
          compliance,
        },
      });
    } catch (err) {
      console.error("[lms-admin-audit] GET /learner/:userId error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to load learner audit",
      });
    }
  },
);

export default router;
