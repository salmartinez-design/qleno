/**
 * LMS Annual re-acknowledgment — routes (Phase 14, PR #15 of 16).
 *
 * Mounted at /api/lms/annual-ack.
 *
 * Admin / owner / office endpoints:
 *   POST   /admin/cycles                    open a cycle and sweep eligible users
 *   GET    /admin/cycles                    list cycles for the tenant
 *   GET    /admin/cycles/:id                cycle detail + status counts
 *   PATCH  /admin/cycles/:id/close          mark a cycle closed
 *   POST   /admin/force-resign              push a single user into re-ack
 *   PATCH  /admin/pending/:id/defer         set defer_until on a pending row
 *
 * Caller-self endpoints:
 *   GET    /me/pending                      caller's outstanding re-ack rows
 *
 * Tenant isolation: every read + write filters by req.auth.companyId.
 * Admin endpoints additionally gate on role (owner | admin | office).
 *
 * Sweep semantics: when a cycle is opened, the server walks every
 * non-terminated user in the tenant who has an active signed_document
 * for each required_documents type and inserts an lms_pending_re_ack
 * row pointing at the current canonical version (in the locale they
 * last signed in). Users with no prior handbook signature are skipped
 * because the original signing flow already gates them.
 *
 * Acknowledgment: when POST /api/lms/handbook/sign succeeds it calls
 * `acknowledgePendingReAcksForSign()` (below, exported) to flip any
 * matching pending rows to acknowledged_at = now. That keeps Phase 11
 * and Phase 14 decoupled — the handbook router doesn't need to know
 * about cycles, just that there might be pending rows to settle.
 */
import { Router } from "express";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  lmsAnnualAckCyclesTable,
  lmsPendingReAckTable,
  lmsSignedDocumentsTable,
  usersTable,
} from "@workspace/db/schema";
import { requireAuth, requireRole } from "../lib/auth.js";
import { getSignedDocumentContent } from "../lib/lms-signed-documents-content.js";
import { getOrCreateDocumentVersion } from "../lib/lms-signatures-db.js";
import {
  defaultCycleDeadline,
  isValidCycleYear,
  isValidTriggerReason,
  parseDeadlineInput,
  summarizePendingReAcks,
  validateRequiredDocuments,
  type TriggerReason,
} from "../lib/lms-annual-ack.js";
import { logAudit } from "../lib/audit.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (DB-touching)
// ─────────────────────────────────────────────────────────────────────────────

interface SweepResult {
  document_type: string;
  swept_user_ids: number[];
}

/**
 * Sweep every active employee in the tenant who currently has an
 * active signed_document for the given document_type, and insert a
 * pending_re_ack row for each. Skips users who already have a
 * non-acknowledged row for the same (document_type, current version)
 * so re-running a sweep is idempotent.
 *
 * Returns the user IDs that received a NEW pending row this call.
 */
export async function sweepForDocumentType(args: {
  companyId: number;
  documentType: string;
  triggeredByUserId: number | null;
  triggerReason: TriggerReason;
  /**
   * When true, only users whose active signed_document carries a
   * version_hash that does NOT match the current canonical hash get
   * a pending_re_ack row. Used by the material-content-change sweep
   * so already-up-to-date employees aren't pushed back into the
   * re-sign flow.
   */
  onlyOutdated?: boolean;
}): Promise<SweepResult> {
  const {
    companyId,
    documentType,
    triggeredByUserId,
    triggerReason,
    onlyOutdated,
  } = args;

  const activeSigners = await db
    .select({
      user_id: lmsSignedDocumentsTable.user_id,
      locale: lmsSignedDocumentsTable.locale,
      current_version_hash: lmsSignedDocumentsTable.version_hash,
    })
    .from(lmsSignedDocumentsTable)
    .innerJoin(
      usersTable,
      eq(lmsSignedDocumentsTable.user_id, usersTable.id),
    )
    .where(
      and(
        eq(lmsSignedDocumentsTable.company_id, companyId),
        eq(lmsSignedDocumentsTable.document_type, documentType),
        eq(lmsSignedDocumentsTable.status, "active"),
        eq(usersTable.company_id, companyId),
        isNull(usersTable.termination_date),
        isNull(usersTable.archived_at),
        // 2026-05-15 sprint: never sweep the QA sandbox into the
        // annual re-ack pending list.
        eq(usersTable.is_sandbox, false),
      ),
    );

  if (activeSigners.length === 0) {
    return { document_type: documentType, swept_user_ids: [] };
  }

  const sweptIds: number[] = [];
  const now = new Date();

  for (const signer of activeSigners) {
    const locale = signer.locale === "es" ? "es" : "en";
    const content = getSignedDocumentContent(documentType, locale);
    if (!content) continue;

    const version = await getOrCreateDocumentVersion({
      companyId,
      documentType,
      locale,
      contentHtml: content.contentHtml,
      isMaterial: triggerReason === "material_content_change",
      notes: content.notes,
    });

    // Material-change sweep: skip users already on the current hash.
    if (onlyOutdated && signer.current_version_hash === version.version_hash) {
      continue;
    }

    // Skip if user already has an unacknowledged row for this version.
    const existing = await db
      .select({ id: lmsPendingReAckTable.id })
      .from(lmsPendingReAckTable)
      .where(
        and(
          eq(lmsPendingReAckTable.company_id, companyId),
          eq(lmsPendingReAckTable.user_id, signer.user_id),
          eq(lmsPendingReAckTable.document_type, documentType),
          eq(lmsPendingReAckTable.new_version_id, version.id),
          isNull(lmsPendingReAckTable.acknowledged_at),
        ),
      )
      .limit(1);
    if (existing[0]) continue;

    await db.insert(lmsPendingReAckTable).values({
      company_id: companyId,
      user_id: signer.user_id,
      document_type: documentType,
      new_version_id: version.id,
      new_version_hash: version.version_hash,
      trigger_reason: triggerReason,
      triggered_at: now,
      triggered_by_user_id: triggeredByUserId,
    });
    sweptIds.push(signer.user_id);
  }

  return { document_type: documentType, swept_user_ids: sweptIds };
}

/**
 * Called by routes/lms-handbook.ts POST /sign after a successful sign.
 * Flips every unacknowledged pending row for this user+document_type
 * to acknowledged_at=now, pointing to the freshly inserted
 * signed_document row.
 *
 * Tenant-scoped (caller must pass companyId derived from req.auth).
 * Returns the number of rows updated for audit.
 */
export async function acknowledgePendingReAcksForSign(args: {
  companyId: number;
  userId: number;
  documentType: string;
  signedDocumentId: number;
  now?: Date;
}): Promise<number> {
  const now = args.now ?? new Date();
  const updated = await db
    .update(lmsPendingReAckTable)
    .set({
      acknowledged_at: now,
      acknowledged_signed_document_id: args.signedDocumentId,
      updated_at: now,
    })
    .where(
      and(
        eq(lmsPendingReAckTable.company_id, args.companyId),
        eq(lmsPendingReAckTable.user_id, args.userId),
        eq(lmsPendingReAckTable.document_type, args.documentType),
        isNull(lmsPendingReAckTable.acknowledged_at),
      ),
    )
    .returning({ id: lmsPendingReAckTable.id });
  return updated.length;
}

/**
 * Find the currently open cycle for a tenant. "Open" = closed_at IS
 * NULL. Returns the most recent cycle when more than one is open
 * (shouldn't happen in practice — uniqueIndex enforces one per year).
 */
export async function findOpenCycle(
  companyId: number,
): Promise<{ id: number; cycle_year: number } | null> {
  const rows = await db
    .select({
      id: lmsAnnualAckCyclesTable.id,
      cycle_year: lmsAnnualAckCyclesTable.cycle_year,
    })
    .from(lmsAnnualAckCyclesTable)
    .where(
      and(
        eq(lmsAnnualAckCyclesTable.company_id, companyId),
        isNull(lmsAnnualAckCyclesTable.closed_at),
      ),
    )
    .orderBy(desc(lmsAnnualAckCyclesTable.cycle_year))
    .limit(1);
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/cycles — open a cycle and sweep eligible users
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/admin/cycles",
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
      const body = req.body ?? {};

      if (!isValidCycleYear(body.cycle_year)) {
        return res.status(400).json({
          error: "Bad Request",
          message: "cycle_year must be an integer between 2025 and 2100",
        });
      }
      const cycleYear: number = body.cycle_year;

      const docs = validateRequiredDocuments(body.required_documents);
      if (!docs.ok) {
        return res.status(400).json({
          error: "Bad Request",
          message:
            "required_documents must be a non-empty array of known annual document types",
          data: { invalid: docs.invalid, not_annual: docs.notAnnual },
        });
      }

      const deadlineFromBody = parseDeadlineInput(body.deadline_at);
      if (
        body.deadline_at !== undefined &&
        body.deadline_at !== null &&
        body.deadline_at !== "" &&
        deadlineFromBody === null
      ) {
        return res.status(400).json({
          error: "Bad Request",
          message: "deadline_at must be a valid ISO timestamp",
        });
      }
      const deadlineAt = deadlineFromBody ?? defaultCycleDeadline(cycleYear);

      const notes =
        typeof body.notes === "string" && body.notes.length > 0
          ? body.notes
          : null;

      // Reject if a cycle already exists for this (company, year).
      const existing = await db
        .select({
          id: lmsAnnualAckCyclesTable.id,
          closed_at: lmsAnnualAckCyclesTable.closed_at,
        })
        .from(lmsAnnualAckCyclesTable)
        .where(
          and(
            eq(lmsAnnualAckCyclesTable.company_id, companyId),
            eq(lmsAnnualAckCyclesTable.cycle_year, cycleYear),
          ),
        )
        .limit(1);
      if (existing[0]) {
        return res.status(409).json({
          error: "Conflict",
          message: `A cycle for ${cycleYear} already exists`,
          data: existing[0],
        });
      }

      const inserted = await db
        .insert(lmsAnnualAckCyclesTable)
        .values({
          company_id: companyId,
          cycle_year: cycleYear,
          deadline_at: deadlineAt,
          required_documents: docs.documents,
          notes,
        })
        .returning();
      const cycle = inserted[0]!;

      // Sweep each required document type. Collect totals for the
      // response so the dashboard tile shows immediate confirmation.
      const sweeps: SweepResult[] = [];
      for (const documentType of docs.documents) {
        const result = await sweepForDocumentType({
          companyId,
          documentType,
          triggeredByUserId: adminId,
          triggerReason: "annual_cycle",
        });
        sweeps.push(result);
      }

      const total_swept = sweeps.reduce(
        (sum, r) => sum + r.swept_user_ids.length,
        0,
      );

      await logAudit(
        req,
        "lms_annual_cycle_opened",
        "lms_annual_ack_cycle",
        cycle.id,
        null,
        { cycle_year: cycleYear, total_swept, sweeps },
      );

      return res.json({
        data: {
          cycle,
          sweeps,
          total_swept,
        },
      });
    } catch (err) {
      console.error("[lms-annual-ack] POST /admin/cycles error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to open annual cycle",
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/cycles — list cycles for the tenant
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/admin/cycles",
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
      const rows = await db
        .select()
        .from(lmsAnnualAckCyclesTable)
        .where(eq(lmsAnnualAckCyclesTable.company_id, companyId))
        .orderBy(desc(lmsAnnualAckCyclesTable.cycle_year));
      return res.json({ data: rows });
    } catch (err) {
      console.error("[lms-annual-ack] GET /admin/cycles error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to load cycles",
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/cycles/:id — cycle detail + status counts
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/admin/cycles/:id",
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
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "Invalid id" });
      }
      const cycleRows = await db
        .select()
        .from(lmsAnnualAckCyclesTable)
        .where(
          and(
            eq(lmsAnnualAckCyclesTable.company_id, companyId),
            eq(lmsAnnualAckCyclesTable.id, id),
          ),
        )
        .limit(1);
      const cycle = cycleRows[0];
      if (!cycle) {
        return res.status(404).json({
          error: "Not Found",
          message: "Cycle not found",
        });
      }

      const required: string[] = Array.isArray(cycle.required_documents)
        ? (cycle.required_documents as string[])
        : [];

      // Pending re-ack rows triggered during this cycle's window.
      const windowStart = cycle.opened_at;
      const windowEnd = cycle.closed_at ?? new Date();
      const rows = required.length
        ? await db
            .select({
              id: lmsPendingReAckTable.id,
              user_id: lmsPendingReAckTable.user_id,
              document_type: lmsPendingReAckTable.document_type,
              triggered_at: lmsPendingReAckTable.triggered_at,
              acknowledged_at: lmsPendingReAckTable.acknowledged_at,
              defer_until: lmsPendingReAckTable.defer_until,
              trigger_reason: lmsPendingReAckTable.trigger_reason,
            })
            .from(lmsPendingReAckTable)
            .where(
              and(
                eq(lmsPendingReAckTable.company_id, companyId),
                inArray(lmsPendingReAckTable.document_type, required),
                eq(lmsPendingReAckTable.trigger_reason, "annual_cycle"),
              ),
            )
        : [];

      // Filter to the cycle window in-memory. Drizzle doesn't have
      // a "between" helper for tz-aware timestamps that pairs cleanly
      // with `inArray`; rows count is small (one per employee per
      // required doc) so this is cheap.
      const wsMs = (windowStart as Date).getTime();
      const weMs = (windowEnd as Date).getTime();
      const inWindow = rows.filter((r) => {
        const ts = (r.triggered_at as Date).getTime();
        return ts >= wsMs && ts <= weMs;
      });

      const summary = summarizePendingReAcks(inWindow);

      return res.json({
        data: {
          cycle,
          summary,
          pending: inWindow,
        },
      });
    } catch (err) {
      console.error("[lms-annual-ack] GET /admin/cycles/:id error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to load cycle detail",
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /admin/cycles/:id/close — mark a cycle closed
// ─────────────────────────────────────────────────────────────────────────────

router.patch(
  "/admin/cycles/:id/close",
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
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "Invalid id" });
      }
      const now = new Date();
      const updated = await db
        .update(lmsAnnualAckCyclesTable)
        .set({ closed_at: now })
        .where(
          and(
            eq(lmsAnnualAckCyclesTable.company_id, companyId),
            eq(lmsAnnualAckCyclesTable.id, id),
            isNull(lmsAnnualAckCyclesTable.closed_at),
          ),
        )
        .returning();
      if (!updated[0]) {
        return res.status(404).json({
          error: "Not Found",
          message: "Cycle not found or already closed",
        });
      }
      await logAudit(
        req,
        "lms_annual_cycle_closed",
        "lms_annual_ack_cycle",
        id,
      );
      return res.json({ data: updated[0] });
    } catch (err) {
      console.error("[lms-annual-ack] PATCH close error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to close cycle",
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/force-resign — push a single user into re-ack
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/admin/force-resign",
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
      const body = req.body ?? {};

      const targetUserId = Number(body.user_id);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({
          error: "Bad Request",
          message: "user_id is required",
        });
      }
      const documentType: unknown = body.document_type;
      if (typeof documentType !== "string" || documentType.length === 0) {
        return res.status(400).json({
          error: "Bad Request",
          message: "document_type is required",
        });
      }
      const reason: unknown = body.trigger_reason ?? "admin_force_resign";
      if (!isValidTriggerReason(reason)) {
        return res.status(400).json({
          error: "Bad Request",
          message: `trigger_reason must be one of admin_force_resign, policy_correction, material_content_change, annual_cycle`,
        });
      }

      // Tenant gate the target.
      const targetUser = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(
          and(
            eq(usersTable.id, targetUserId),
            eq(usersTable.company_id, companyId),
          ),
        )
        .limit(1);
      if (!targetUser[0]) {
        return res.status(404).json({
          error: "Not Found",
          message: "User not found in this tenant",
        });
      }

      // Pick the locale of their last signed handbook if any, else en.
      const lastSigned = await db
        .select({ locale: lmsSignedDocumentsTable.locale })
        .from(lmsSignedDocumentsTable)
        .where(
          and(
            eq(lmsSignedDocumentsTable.company_id, companyId),
            eq(lmsSignedDocumentsTable.user_id, targetUserId),
            eq(lmsSignedDocumentsTable.document_type, documentType),
          ),
        )
        .orderBy(desc(lmsSignedDocumentsTable.signed_at))
        .limit(1);
      const locale =
        lastSigned[0]?.locale === "es" ? "es" : "en";

      const content = getSignedDocumentContent(documentType, locale);
      if (!content) {
        return res.status(400).json({
          error: "Bad Request",
          message: `No canonical content registered for ${documentType}/${locale}`,
        });
      }

      const version = await getOrCreateDocumentVersion({
        companyId,
        documentType,
        locale,
        contentHtml: content.contentHtml,
        isMaterial: reason === "material_content_change",
        notes: content.notes,
      });

      const inserted = await db
        .insert(lmsPendingReAckTable)
        .values({
          company_id: companyId,
          user_id: targetUserId,
          document_type: documentType,
          new_version_id: version.id,
          new_version_hash: version.version_hash,
          trigger_reason: reason,
          triggered_by_user_id: adminId,
        })
        .returning();

      await logAudit(
        req,
        "lms_force_resign",
        "lms_pending_re_ack",
        inserted[0]!.id,
        null,
        { document_type: documentType, target_user_id: targetUserId, reason },
      );

      return res.json({ data: inserted[0] });
    } catch (err) {
      console.error("[lms-annual-ack] POST /admin/force-resign error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to force re-sign",
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /admin/pending/:id/defer — set defer_until on a pending row
// ─────────────────────────────────────────────────────────────────────────────

router.patch(
  "/admin/pending/:id/defer",
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
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "Invalid id" });
      }
      const deferUntil = parseDeadlineInput(req.body?.defer_until);
      if (deferUntil === null) {
        return res.status(400).json({
          error: "Bad Request",
          message: "defer_until must be a valid ISO timestamp",
        });
      }
      const updated = await db
        .update(lmsPendingReAckTable)
        .set({ defer_until: deferUntil, updated_at: new Date() })
        .where(
          and(
            eq(lmsPendingReAckTable.company_id, companyId),
            eq(lmsPendingReAckTable.id, id),
            isNull(lmsPendingReAckTable.acknowledged_at),
          ),
        )
        .returning();
      if (!updated[0]) {
        return res.status(404).json({
          error: "Not Found",
          message: "Pending re-ack row not found or already acknowledged",
        });
      }
      await logAudit(
        req,
        "lms_pending_re_ack_deferred",
        "lms_pending_re_ack",
        id,
        null,
        { defer_until: deferUntil.toISOString() },
      );
      return res.json({ data: updated[0] });
    } catch (err) {
      console.error("[lms-annual-ack] PATCH defer error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to set defer_until",
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /me/pending — caller's outstanding re-ack rows
// ─────────────────────────────────────────────────────────────────────────────

router.get("/me/pending", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res.status(400).json({
        error: "Bad Request",
        message: "User has no company assignment",
      });
    }
    const userId = req.auth!.userId;
    const rows = await db
      .select({
        id: lmsPendingReAckTable.id,
        document_type: lmsPendingReAckTable.document_type,
        new_version_hash: lmsPendingReAckTable.new_version_hash,
        trigger_reason: lmsPendingReAckTable.trigger_reason,
        triggered_at: lmsPendingReAckTable.triggered_at,
        defer_until: lmsPendingReAckTable.defer_until,
      })
      .from(lmsPendingReAckTable)
      .where(
        and(
          eq(lmsPendingReAckTable.company_id, companyId),
          eq(lmsPendingReAckTable.user_id, userId),
          isNull(lmsPendingReAckTable.acknowledged_at),
        ),
      )
      .orderBy(asc(lmsPendingReAckTable.triggered_at));

    const now = new Date();
    const active = rows.filter((r) => {
      if (!r.defer_until) return true;
      const def = r.defer_until as Date;
      return def.getTime() <= now.getTime();
    });
    const deferred = rows.filter((r) => {
      if (!r.defer_until) return false;
      const def = r.defer_until as Date;
      return def.getTime() > now.getTime();
    });

    return res.json({
      data: {
        active,
        deferred,
        total: rows.length,
      },
    });
  } catch (err) {
    console.error("[lms-annual-ack] GET /me/pending error:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      message: "Failed to load pending re-acks",
    });
  }
});

export default router;
