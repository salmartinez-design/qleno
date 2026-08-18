import { Router } from "express";
import { db } from "@workspace/db";
import {
  commissionsTable,
  commissionPaymentsTable,
  commissionLedgerTable,
  commissionStatusEventsTable,
  commissionChargebacksTable,
  commissionRateCardTable,
  usersTable,
} from "@workspace/db/schema";
import { and, eq, sql, desc, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../../lib/auth.js";
import {
  createSpecialtyBonus,
  handleLostClient,
  previewPayout,
  processPayout,
  getCommissionSummary,
  recordStatusEvent,
  recordLedger,
  seedRateCardIfEmpty,
  ARES_SEED_RATES,
  type Actor,
} from "../../lib/sales-commission.js";

// [ares-parity 2026-08-18] The Ares Commissions tab — VA SALES commission.
// Mirrors the legacy Ares admin portal (approval queue, payout, chargebacks,
// reports, settings) and the VA statement.
//
// GUARDRAIL, same as the rest of this module: writes ONLY commission* tables.
// clients / recurring_schedules / jobs are read-only here.
//
// NOT the technician-pay engine — see CLAUDE.md "Commission engine routing".

const router = Router();

const VIEW_ROLES = ["owner", "admin", "office", "super_admin"] as const;
const ACT_ROLES = ["owner", "admin", "super_admin"] as const;

// House convention: manual validation, no Zod.
const bad = (res: any, msg: string) => res.status(400).json({ error: "Bad Request", message: msg });
const numOrNull = (v: unknown) => (v == null || v === "" ? null : Number(v));
const actorOf = (req: any): Actor => ({ userId: req.auth?.userId ?? null });
const fail = (res: any, tag: string, err: unknown) => {
  console.error(`[recurring/commissions ${tag}]`, err);
  return res.status(500).json({ error: "Server error" });
};

// A VA may read their OWN statement; office roles may read anyone's.
function canReadVa(req: any, vaUserId: number): boolean {
  const role = req.auth?.role;
  if (VIEW_ROLES.includes(role)) return true;
  return req.auth?.userId === vaUserId;
}

// ── GET /api/recurring/commissions ───────────────────────────────────────────
// The approval queue and every filtered list behind it.
router.get("/commissions", requireAuth, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { status, va_user_id, client_type, commission_type, branch_id } = req.query;

    const rows = await db.select().from(commissionsTable)
      .where(and(
        eq(commissionsTable.company_id, companyId),
        status ? sql`${commissionsTable.status} = ${String(status)}` : sql`true`,
        va_user_id ? eq(commissionsTable.va_user_id, Number(va_user_id)) : sql`true`,
        client_type ? sql`${commissionsTable.client_type} = ${String(client_type)}` : sql`true`,
        commission_type ? sql`${commissionsTable.commission_type} = ${String(commission_type)}` : sql`true`,
        branch_id ? eq(commissionsTable.branch_id, Number(branch_id)) : sql`true`,
      ))
      .orderBy(desc(commissionsTable.created_at));

    // Overdue = approved and past the payout date it should have been paid on.
    // Ares sorted these first in the queue; the flag is computed, never stored.
    const today = new Date().toISOString().slice(0, 10);
    const out = rows.map(r => ({
      ...r,
      is_overdue: r.status === "approved" && !!r.first_cleaning_date && r.first_cleaning_date < today,
      dispute_open: r.status === "chargeback_pending" && !!r.chargeback_dispute_deadline
        && r.chargeback_dispute_deadline >= today,
    }));

    return res.json({ count: out.length, commissions: out });
  } catch (err) { return fail(res, "GET /commissions", err); }
});

// ── GET /api/recurring/commissions/metrics ───────────────────────────────────
// The Overview tab. Returns the full Ares admin-dashboard shape — every figure
// that screen renders — so the UI is a read, not a recomputation.
// Mirrors the legacy /api/commissions/metrics/admin-dashboard.
router.get("/commissions/metrics", requireAuth, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const branchId = numOrNull(req.query.branch_id);
    const branchSql = branchId != null ? sql`AND c.branch_id = ${branchId}` : sql``;

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);

    // Next payout = last Friday of this month; if that has passed, next month's.
    const lastFriday = (y: number, m1to12: number) => {
      const d = new Date(y, m1to12, 0);
      while (d.getDay() !== 5) d.setDate(d.getDate() - 1);
      return d;
    };
    let nextPayout = lastFriday(now.getFullYear(), now.getMonth() + 1);
    if (nextPayout < now) nextPayout = lastFriday(now.getFullYear(), now.getMonth() + 2);

    // ── Headline buckets ──
    const head = await db.execute(sql`
      SELECT
        -- 'earned' is the pre-review state and is listed under Pending in the
        -- queue, so it must count here too or the badge and the rows disagree.
        COUNT(*) FILTER (WHERE c.status IN ('earned','pending_review'))                  AS pending_count,
        COALESCE(SUM(c.amount) FILTER (WHERE c.status IN ('earned','pending_review')),0) AS pending_total,
        COUNT(*) FILTER (WHERE c.status = 'approved')                            AS approved_count,
        COALESCE(SUM(c.amount) FILTER (WHERE c.status = 'approved'),0)           AS approved_total,
        COUNT(*) FILTER (WHERE c.status = 'paid' AND c.paid_date >= ${startOfMonth})                    AS paid_month_count,
        COALESCE(SUM(c.amount) FILTER (WHERE c.status = 'paid' AND c.paid_date >= ${startOfMonth}),0)   AS paid_month_total,
        -- Chargeback risk: PAID residential lines still inside their window.
        COUNT(*) FILTER (WHERE c.status = 'paid' AND c.client_type = 'residential'
                           AND c.chargeback_until IS NOT NULL AND c.chargeback_until > CURRENT_DATE)   AS risk_count,
        COALESCE(SUM(c.amount) FILTER (WHERE c.status = 'paid' AND c.client_type = 'residential'
                           AND c.chargeback_until IS NOT NULL AND c.chargeback_until > CURRENT_DATE),0) AS risk_total,
        -- Windows closing inside 60 days — the tab badge tooltip.
        COUNT(*) FILTER (WHERE c.status = 'paid' AND c.client_type = 'residential'
                           AND c.chargeback_until IS NOT NULL
                           AND c.chargeback_until BETWEEN CURRENT_DATE AND CURRENT_DATE + 60)          AS risk_expiring_count,
        COUNT(*) FILTER (WHERE c.status = 'chargeback_pending')                  AS cb_pending_count,
        COALESCE(SUM(c.amount) FILTER (WHERE c.status = 'chargeback_confirmed'),0) AS cb_confirmed_total,
        -- A base line that priced at $0 is an unpriced cadence, not a free client.
        COUNT(*) FILTER (WHERE c.commission_type = 'base' AND c.amount = 0)      AS unpriced_count
      FROM commissions c
      WHERE c.company_id = ${companyId} ${branchSql}
    `);
    const h = head.rows[0] as Record<string, string>;
    const n = (k: string) => Number(h[k] ?? 0);

    // ── Per-VA payout breakdown (Overview rows) ──
    const payoutByVa = await db.execute(sql`
      SELECT c.va_user_id AS id,
             COALESCE(MAX(c.va_name), MAX(u.first_name || ' ' || u.last_name), 'Unknown') AS name,
             COALESCE(SUM(c.amount) FILTER (WHERE c.status = 'approved'),0)       AS subtotal,
             COUNT(*) FILTER (WHERE c.status = 'approved')                        AS approved_count,
             COALESCE(SUM(c.amount) FILTER (WHERE c.status IN ('earned','pending_review')),0) AS pending_total,
             COUNT(*) FILTER (WHERE c.status IN ('earned','pending_review'))                  AS pending_count
        FROM commissions c
        LEFT JOIN users u ON u.id = c.va_user_id
       WHERE c.company_id = ${companyId} ${branchSql}
       GROUP BY c.va_user_id
       ORDER BY 3 DESC
    `);

    // ── VA performance (leaderboard) ──
    // Client counts and MRR come from the subscriptions a VA is credited with —
    // excluding lines ruled not eligible, same as Ares.
    const vaPerf = await db.execute(sql`
      WITH credited AS (
        SELECT DISTINCT c.va_user_id, c.subscription_id
          FROM commissions c
         WHERE c.company_id = ${companyId} ${branchSql}
           AND c.status <> 'not_eligible'
           AND c.subscription_id IS NOT NULL
      )
      SELECT c.va_user_id AS id,
             COALESCE(MAX(c.va_name), MAX(u.first_name || ' ' || u.last_name), 'Unknown') AS name,
             (SELECT COUNT(*) FROM credited cr JOIN recurring_subscriptions rs ON rs.id = cr.subscription_id
               WHERE cr.va_user_id = c.va_user_id AND rs.status = 'active')                 AS total_clients,
             (SELECT COUNT(*) FROM credited cr JOIN recurring_subscriptions rs ON rs.id = cr.subscription_id
               WHERE cr.va_user_id = c.va_user_id AND rs.status = 'active'
                 AND rs.first_cleaning_date >= ${startOfMonth})                             AS clients_this_month,
             (SELECT COALESCE(SUM(rs.mrr),0) FROM credited cr JOIN recurring_subscriptions rs ON rs.id = cr.subscription_id
               WHERE cr.va_user_id = c.va_user_id AND rs.status = 'active')                 AS revenue_generated,
             (SELECT COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (now() - rs.first_cleaning_date::timestamp)) / 2592000)::numeric, 1), 0)
                FROM credited cr JOIN recurring_subscriptions rs ON rs.id = cr.subscription_id
               WHERE cr.va_user_id = c.va_user_id AND rs.first_cleaning_date IS NOT NULL)   AS avg_client_lifespan,
             COALESCE(SUM(c.amount) FILTER (WHERE c.status = 'paid'),0)           AS commissions_paid,
             COALESCE(SUM(c.amount) FILTER (WHERE c.status = 'approved'),0)       AS commissions_approved,
             COALESCE(SUM(c.amount) FILTER (WHERE c.status IN ('earned','pending_review')),0) AS commissions_pending,
             COUNT(*) FILTER (WHERE c.status IN ('charged_back','chargeback_pending','chargeback_confirmed','recouped')) AS cb_count,
             COUNT(*) FILTER (WHERE c.status <> 'not_eligible')                   AS scored_count
        FROM commissions c
        LEFT JOIN users u ON u.id = c.va_user_id
       WHERE c.company_id = ${companyId} ${branchSql}
       GROUP BY c.va_user_id
    `);

    const vaPerformance = (vaPerf.rows as Array<Record<string, any>>).map(r => {
      const paid = Number(r.commissions_paid), approved = Number(r.commissions_approved);
      const scored = Number(r.scored_count);
      return {
        id: Number(r.id),
        name: r.name as string,
        totalClients: Number(r.total_clients),
        clientsThisMonth: Number(r.clients_this_month),
        revenueGenerated: Number(r.revenue_generated),
        commissionsPaid: paid,
        commissionsApproved: approved,
        commissionsPending: Number(r.commissions_pending),
        commissionsEarned: Math.round((paid + approved) * 100) / 100,
        chargebackRate: scored > 0 ? Math.round((Number(r.cb_count) / scored) * 100) : 0,
        avgClientLifespan: Number(r.avg_client_lifespan),
      };
    }).sort((a, b) => b.revenueGenerated - a.revenueGenerated);

    return res.json({
      // Hero
      total_owed_to_vas: Math.round((n("approved_total") + n("pending_total")) * 100) / 100,
      nextPayoutDate: nextPayout.toISOString().slice(0, 10),
      pendingReview:  { count: n("pending_count"),    total: n("pending_total") },
      readyToPay:     { count: n("approved_count"),   total: n("approved_total") },
      paidThisMonth:  { count: n("paid_month_count"), total: n("paid_month_total") },
      chargebackRisk: { count: n("risk_count"), total: n("risk_total"), expiring_60d: n("risk_expiring_count") },
      totalPayoutAmount: n("approved_total"),
      chargeback_pending_count: n("cb_pending_count"),
      chargeback_confirmed_amount: n("cb_confirmed_total"),
      unpriced_count: n("unpriced_count"),
      payoutByVA: (payoutByVa.rows as Array<Record<string, any>>).map(r => ({
        id: Number(r.id), name: r.name as string,
        subtotal: Number(r.subtotal), approvedCount: Number(r.approved_count),
        pendingTotal: Number(r.pending_total), pendingCommissionCount: Number(r.pending_count),
      })),
      vaPerformance,
    });
  } catch (err) { return fail(res, "GET /commissions/metrics", err); }
});

// ── GET /api/recurring/commissions/statement/:vaUserId ───────────────────────
// The VA's own view. A VA may read their own; office roles may read anyone's.
router.get("/commissions/statement/:vaUserId", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const vaUserId = parseInt(String(req.params.vaUserId));
    if (!Number.isFinite(vaUserId)) return bad(res, "vaUserId must be a number");
    if (!canReadVa(req, vaUserId)) return res.status(403).json({ error: "Forbidden" });

    const summary = await getCommissionSummary(companyId, vaUserId);

    const lines = await db.select().from(commissionsTable)
      .where(and(
        eq(commissionsTable.company_id, companyId),
        eq(commissionsTable.va_user_id, vaUserId),
      ))
      .orderBy(desc(commissionsTable.created_at));

    const ledger = await db.select().from(commissionLedgerTable)
      .where(and(
        eq(commissionLedgerTable.company_id, companyId),
        eq(commissionLedgerTable.va_user_id, vaUserId),
      ))
      .orderBy(desc(commissionLedgerTable.created_at));

    const payouts = await db.select().from(commissionPaymentsTable)
      .where(and(
        eq(commissionPaymentsTable.company_id, companyId),
        eq(commissionPaymentsTable.va_user_id, vaUserId),
      ))
      .orderBy(desc(commissionPaymentsTable.processed_at));

    return res.json({ summary, lines, ledger, payouts });
  } catch (err) { return fail(res, "GET /commissions/statement", err); }
});

// ── GET /api/recurring/commissions/:id ───────────────────────────────────────
// One line with its full audit trail. Registered AFTER the literal paths above
// so it cannot shadow /metrics or /statement.
router.get("/commissions/:id", requireAuth, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) return bad(res, "id must be a number");

    const [line] = await db.select().from(commissionsTable)
      .where(and(eq(commissionsTable.company_id, companyId), eq(commissionsTable.id, id)));
    if (!line) return res.status(404).json({ error: "Not found" });

    const events = await db.select().from(commissionStatusEventsTable)
      .where(eq(commissionStatusEventsTable.commission_id, id))
      .orderBy(commissionStatusEventsTable.created_at);
    const ledger = await db.select().from(commissionLedgerTable)
      .where(eq(commissionLedgerTable.commission_id, id))
      .orderBy(commissionLedgerTable.created_at);
    const chargebacks = await db.select().from(commissionChargebacksTable)
      .where(eq(commissionChargebacksTable.commission_id, id))
      .orderBy(commissionChargebacksTable.created_at);

    return res.json({ commission: line, events, ledger, chargebacks });
  } catch (err) { return fail(res, "GET /commissions/:id", err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Approval queue actions
// ─────────────────────────────────────────────────────────────────────────────

// Shared transition helper. Every status change goes through here so the
// immutable event log can never be bypassed.
async function transition(opts: {
  req: any; res: any; id: number; to: string;
  from: string[];                       // statuses this transition is legal from
  note?: string | null;
  patch?: Record<string, unknown>;
}) {
  const companyId = opts.req.auth!.companyId!;
  const [line] = await db.select().from(commissionsTable)
    .where(and(eq(commissionsTable.company_id, companyId), eq(commissionsTable.id, opts.id)));
  if (!line) return { error: opts.res.status(404).json({ error: "Not found" }) };
  if (!opts.from.includes(line.status)) {
    return {
      error: bad(opts.res, `cannot go from '${line.status}' to '${opts.to}' — allowed from: ${opts.from.join(", ")}`),
    };
  }

  await db.update(commissionsTable)
    .set({ status: opts.to as any, updated_at: new Date(), ...(opts.patch ?? {}) })
    .where(eq(commissionsTable.id, opts.id));
  await recordStatusEvent(companyId, line.branch_id, opts.id, line.status, opts.to, actorOf(opts.req), opts.note ?? undefined);
  return { line };
}

// Approve — the line becomes payable in the next payout run.
router.post("/commissions/:id/approve", requireAuth, requireRole(...ACT_ROLES), async (req, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const r = await transition({
      req, res, id, to: "approved",
      from: ["earned", "pending_review", "on_hold"],
      note: req.body?.note ?? "Approved",
      patch: { approved_by: req.auth!.userId ?? null, approved_at: new Date() },
    });
    if ("error" in r) return r.error;
    return res.json({ ok: true, id, status: "approved" });
  } catch (err) { return fail(res, "POST /approve", err); }
});

// Reject — reverses the money in the ledger, since an approved line may have
// already been counted toward career earnings.
router.post("/commissions/:id/reject", requireAuth, requireRole(...ACT_ROLES), async (req, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const reason = req.body?.reason ? String(req.body.reason) : null;
    const r = await transition({
      req, res, id, to: "rejected",
      from: ["earned", "pending_review", "approved", "on_hold"],
      note: reason ? `Rejected — ${reason}` : "Rejected",
      patch: { notes: reason },
    });
    if ("error" in r) return r.error;

    const amt = Number(r.line.amount);
    if (amt !== 0) {
      await recordLedger({
        companyId: req.auth!.companyId!, branchId: r.line.branch_id, commissionId: id,
        subscriptionId: r.line.subscription_id, clientId: r.line.client_id,
        vaUserId: r.line.va_user_id, entryType: "adjustment", amount: -amt,
        description: reason ? `Rejected — ${reason}` : "Commission rejected",
        createdBy: req.auth!.userId ?? null,
      });
    }
    return res.json({ ok: true, id, status: "rejected" });
  } catch (err) { return fail(res, "POST /reject", err); }
});

// Not eligible — Ares' 9-category ruling. A category is mandatory: "not
// eligible" with no stated reason is what made the old queue unauditable.
router.post("/commissions/:id/not-eligible", requireAuth, requireRole(...ACT_ROLES), async (req, res) => {
  try {
    const id = parseInt(String(req.params.id));
    // Ares' 9 review categories (CommissionPortal.tsx:234-244), verbatim.
    const CATS = [
      "returning_90_days", "returning_no_agreement", "missing_agreement",
      "cancelled_before_clean", "duplicate", "data_error",
      "client_initiated", "previous_phes", "other",
    ];
    const category = String(req.body?.category ?? "");
    if (!CATS.includes(category)) return bad(res, `category must be one of: ${CATS.join(", ")}`);
    const reason = req.body?.reason ? String(req.body.reason) : null;
    if (category === "other" && !reason) return bad(res, "reason is required when category is 'other'");

    const r = await transition({
      req, res, id, to: "not_eligible",
      from: ["earned", "pending_review", "approved", "on_hold"],
      note: `Not eligible — ${category}${reason ? `: ${reason}` : ""}`,
      patch: { ineligibility_category: category as any, ineligibility_reason: reason },
    });
    if ("error" in r) return r.error;

    const amt = Number(r.line.amount);
    if (amt !== 0) {
      await recordLedger({
        companyId: req.auth!.companyId!, branchId: r.line.branch_id, commissionId: id,
        subscriptionId: r.line.subscription_id, clientId: r.line.client_id,
        vaUserId: r.line.va_user_id, entryType: "adjustment", amount: -amt,
        description: `Ruled not eligible — ${category}`,
        createdBy: req.auth!.userId ?? null,
      });
    }
    return res.json({ ok: true, id, status: "not_eligible" });
  } catch (err) { return fail(res, "POST /not-eligible", err); }
});

// Put a not-eligible line back in the queue, restoring the money.
router.post("/commissions/:id/make-eligible", requireAuth, requireRole(...ACT_ROLES), async (req, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const r = await transition({
      req, res, id, to: "pending_review",
      from: ["not_eligible", "rejected"],
      note: req.body?.note ?? "Returned to the queue",
      patch: { ineligibility_category: null, ineligibility_reason: null },
    });
    if ("error" in r) return r.error;

    const amt = Number(r.line.amount);
    if (amt !== 0) {
      await recordLedger({
        companyId: req.auth!.companyId!, branchId: r.line.branch_id, commissionId: id,
        subscriptionId: r.line.subscription_id, clientId: r.line.client_id,
        vaUserId: r.line.va_user_id, entryType: "adjustment", amount: amt,
        description: "Restored to the approval queue",
        createdBy: req.auth!.userId ?? null,
      });
    }
    return res.json({ ok: true, id, status: "pending_review" });
  } catch (err) { return fail(res, "POST /make-eligible", err); }
});

// Undo an approval that has not been paid yet.
router.post("/commissions/:id/revoke-approval", requireAuth, requireRole(...ACT_ROLES), async (req, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const r = await transition({
      req, res, id, to: "pending_review", from: ["approved"],
      note: req.body?.reason ? `Approval revoked — ${req.body.reason}` : "Approval revoked",
      patch: { approved_by: null, approved_at: null },
    });
    if ("error" in r) return r.error;
    return res.json({ ok: true, id, status: "pending_review" });
  } catch (err) { return fail(res, "POST /revoke-approval", err); }
});

// Bulk approve. Reports per-id outcomes rather than failing the whole batch —
// a queue action that silently skips rows is worse than one that says so.
router.post("/commissions/bulk-approve", requireAuth, requireRole(...ACT_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return bad(res, "ids must be a non-empty array");

    const rows = await db.select().from(commissionsTable)
      .where(and(eq(commissionsTable.company_id, companyId), inArray(commissionsTable.id, ids)));

    const approved: number[] = [];
    const skipped: Array<{ id: number; reason: string }> = [];
    for (const id of ids) {
      const line = rows.find(r => r.id === id);
      if (!line) { skipped.push({ id, reason: "not found in this company" }); continue; }
      if (!["earned", "pending_review", "on_hold"].includes(line.status)) {
        skipped.push({ id, reason: `status is '${line.status}'` }); continue;
      }
      await db.update(commissionsTable).set({
        status: "approved", approved_by: req.auth!.userId ?? null,
        approved_at: new Date(), updated_at: new Date(),
      }).where(eq(commissionsTable.id, id));
      await recordStatusEvent(companyId, line.branch_id, id, line.status, "approved", actorOf(req), "Bulk approved");
      approved.push(id);
    }
    return res.json({ approved_count: approved.length, approved, skipped });
  } catch (err) { return fail(res, "POST /bulk-approve", err); }
});

// Manual chargeback — step 1, opened by hand rather than by a classified loss.
router.post("/commissions/:id/chargeback", requireAuth, requireRole(...ACT_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(String(req.params.id));
    const [line] = await db.select().from(commissionsTable)
      .where(and(eq(commissionsTable.company_id, companyId), eq(commissionsTable.id, id)));
    if (!line) return res.status(404).json({ error: "Not found" });
    if (!line.subscription_id) return bad(res, "this line has no subscription — chargeback does not apply to bonuses");

    const out = await handleLostClient({
      companyId, branchId: line.branch_id, subscriptionId: line.subscription_id,
      lossDate: req.body?.loss_date ? new Date(String(req.body.loss_date)) : null,
      reason: req.body?.reason ? String(req.body.reason) : null,
      actor: actorOf(req),
    });
    return res.json(out);
  } catch (err) { return fail(res, "POST /chargeback", err); }
});

// A VA disputing a clawback parks it out of payout netting until it is resolved.
router.post("/commissions/:id/dispute", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(String(req.params.id));
    const [line] = await db.select().from(commissionsTable)
      .where(and(eq(commissionsTable.company_id, companyId), eq(commissionsTable.id, id)));
    if (!line) return res.status(404).json({ error: "Not found" });
    if (!canReadVa(req, line.va_user_id)) return res.status(403).json({ error: "Forbidden" });

    const r = await transition({
      req, res, id, to: "charged_back",
      from: ["chargeback_pending", "chargeback_confirmed"],
      note: req.body?.reason ? `Disputed by VA — ${req.body.reason}` : "Disputed by VA — under review",
    });
    if ("error" in r) return r.error;
    return res.json({ ok: true, id, status: "charged_back" });
  } catch (err) { return fail(res, "POST /dispute", err); }
});

// Specialty service bonus — a share of one-off job revenue (deep clean,
// move-in/out, post-renovation, seasonal, commercial add-on).
router.post("/commissions/specialty-bonus", requireAuth, requireRole(...ACT_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { va_user_id, va_name, subscription_id, client_id, client_name, service_type, revenue_amount, branch_id } = req.body ?? {};
    if (!va_user_id) return bad(res, "va_user_id is required");
    if (!service_type) return bad(res, "service_type is required");
    const revenue = Number(revenue_amount);
    if (!Number.isFinite(revenue) || revenue <= 0) return bad(res, "revenue_amount must be a positive number");

    const out = await createSpecialtyBonus({
      companyId, branchId: numOrNull(branch_id),
      vaUserId: Number(va_user_id), vaName: va_name ?? null,
      subscriptionId: numOrNull(subscription_id), clientId: numOrNull(client_id),
      clientName: client_name ?? null,
      serviceType: String(service_type), revenueAmount: revenue,
      actor: actorOf(req),
    });
    return res.status(201).json(out);
  } catch (err) { return fail(res, "POST /specialty-bonus", err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Payout
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Dry run. Shows exactly what processing would pay, including the chargebacks
// and carryover it would net out. Same code path as the real run.
router.get("/commissions/payout/preview", requireAuth, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const vaUserId = Number(req.query.va_user_id);
    const payoutMonth = String(req.query.payout_month ?? "");
    if (!Number.isFinite(vaUserId)) return bad(res, "va_user_id is required");
    if (!MONTH_RE.test(payoutMonth)) return bad(res, "payout_month must be YYYY-MM");

    const preview = await previewPayout({
      companyId, branchId: numOrNull(req.query.branch_id), vaUserId, payoutMonth,
    });
    return res.json(preview);
  } catch (err) { return fail(res, "GET /payout/preview", err); }
});

// The real run. Idempotent per (company, VA, month) — a second call returns the
// existing payment instead of paying twice.
router.post("/commissions/payout/process", requireAuth, requireRole(...ACT_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { va_user_id, payout_month, payment_method, notes, branch_id } = req.body ?? {};
    const vaUserId = Number(va_user_id);
    if (!Number.isFinite(vaUserId)) return bad(res, "va_user_id is required");
    if (!MONTH_RE.test(String(payout_month ?? ""))) return bad(res, "payout_month must be YYYY-MM");

    const out = await processPayout({
      companyId, branchId: numOrNull(branch_id), vaUserId,
      payoutMonth: String(payout_month),
      paymentMethod: payment_method ? String(payment_method) : null,
      notes: notes ? String(notes) : null,
      actor: actorOf(req),
    });

    if (out.already_paid) {
      return res.status(409).json({
        error: "Already paid",
        message: `${payout_month} has already been paid for this VA (${out.receipt_number ?? "no receipt"}).`,
        payment_id: out.payment_id,
      });
    }
    return res.status(201).json(out);
  } catch (err) { return fail(res, "POST /payout/process", err); }
});

// Payout history — the Payout History tab.
router.get("/commissions/payments", requireAuth, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const vaUserId = numOrNull(req.query.va_user_id);
    const branchId = numOrNull(req.query.branch_id);
    const rows = await db.select().from(commissionPaymentsTable)
      .where(and(
        eq(commissionPaymentsTable.company_id, companyId),
        vaUserId != null ? eq(commissionPaymentsTable.va_user_id, vaUserId) : sql`true`,
        // Same branch scope as the commission list — a payout history that
        // ignores the branch toggle makes the reconciliation screen lie.
        branchId != null ? eq(commissionPaymentsTable.branch_id, branchId) : sql`true`,
      ))
      .orderBy(desc(commissionPaymentsTable.processed_at));
    return res.json({ count: rows.length, payments: rows });
  } catch (err) { return fail(res, "GET /commissions/payments", err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings — the rate card
// ─────────────────────────────────────────────────────────────────────────────

// The Settings tab. Seeds Ares' rates on first read so a fresh company is never
// staring at an empty table.
router.get("/commissions/rate-card", requireAuth, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const seeded = await seedRateCardIfEmpty(companyId);

    const rows = await db.select().from(commissionRateCardTable)
      .where(eq(commissionRateCardTable.company_id, companyId))
      .orderBy(commissionRateCardTable.client_type, commissionRateCardTable.cadence,
               desc(commissionRateCardTable.effective_date));

    // Cadences a client can actually carry that this card does not price. These
    // are what make a base commission land at $0 — surfaced, never silent.
    const priced = new Set(rows.filter(r => !r.end_date).map(r => `${r.client_type}:${r.cadence}`));
    const allCadences = [...new Set(ARES_SEED_RATES.map(r => r.cadence))].concat(["custom", "weekdays"]);
    const gaps: Array<{ client_type: string; cadence: string }> = [];
    for (const ct of ["residential", "commercial"]) {
      for (const cad of allCadences) {
        if (!priced.has(`${ct}:${cad}`)) gaps.push({ client_type: ct, cadence: cad });
      }
    }

    return res.json({ seeded: seeded.seeded, rates: rows, unpriced: gaps });
  } catch (err) { return fail(res, "GET /commissions/rate-card", err); }
});

// Change a rate. Never edits a row in place — it end-dates the old one and adds
// a new one, so a commission earned last month stays explainable by last
// month's rate.
router.post("/commissions/rate-card", requireAuth, requireRole(...ACT_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { client_type, cadence, amount, effective_date, branch_id } = req.body ?? {};
    if (!["residential", "commercial"].includes(String(client_type))) {
      return bad(res, "client_type must be residential or commercial");
    }
    if (!cadence) return bad(res, "cadence is required");
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) return bad(res, "amount must be a number >= 0");
    const effective = String(effective_date ?? new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effective)) return bad(res, "effective_date must be YYYY-MM-DD");

    const branchId = numOrNull(branch_id);
    const dayBefore = new Date(new Date(effective + "T12:00:00").getTime() - 86400000)
      .toISOString().slice(0, 10);

    // End-date whatever is currently live for this key.
    await db.update(commissionRateCardTable)
      .set({ end_date: dayBefore, updated_at: new Date() })
      .where(and(
        eq(commissionRateCardTable.company_id, companyId),
        eq(commissionRateCardTable.client_type, String(client_type) as any),
        eq(commissionRateCardTable.cadence, String(cadence)),
        branchId == null
          ? sql`${commissionRateCardTable.branch_id} IS NULL`
          : eq(commissionRateCardTable.branch_id, branchId),
        sql`${commissionRateCardTable.end_date} IS NULL`,
        sql`${commissionRateCardTable.effective_date} < ${effective}`,
      ));

    const [row] = await db.insert(commissionRateCardTable).values({
      company_id: companyId,
      branch_id: branchId,
      client_type: String(client_type) as any,
      cadence: String(cadence),
      amount: amt.toFixed(2),
      effective_date: effective,
    }).returning();

    return res.status(201).json({ rate: row });
  } catch (err) { return fail(res, "POST /commissions/rate-card", err); }
});

export default router;
