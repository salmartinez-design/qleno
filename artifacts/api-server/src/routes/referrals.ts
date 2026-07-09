import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { jobRevenueExpr } from "../lib/job-revenue-sql.js";

const router = Router();

// ── GET /api/referrals/report?year=YYYY ────────────────────────────────────────
// [referral-program] Office tracking for Give $25 / Get $25. Row status is
// DERIVED from the linked lead — nobody maintains it by hand:
//   credited   — office marked the referrer's $25 given (credited_at set)
//   completed  — the referred lead's first job is complete → credit is OWED
//   booked     — the lead booked (status/booked_at) but first job not done yet
//   new        — submitted, office hasn't converted it yet
// Referred revenue = every completed job billed to clients who arrived via a
// referral this year (canonical jobRevenueExpr, deduped by client).
router.get("/report", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    const year = Math.min(Math.max(parseInt(String(req.query.year ?? "")) || now.getFullYear(), 2020), now.getFullYear() + 1);
    const from = `${year}-01-01`, to = `${year + 1}-01-01`;

    const rowsQ = await db.execute(sql`
      SELECT r.id, r.referred_name, r.referred_phone, r.referred_email, r.referral_type,
             r.referrer_name, r.referrer_client_id, r.credited_at, r.created_at, r.lead_id, r.source,
             l.status AS lead_status, l.booked_at, l.job_id,
             lj.status AS first_job_status, lj.client_id AS referred_client_id
      FROM referrals r
      LEFT JOIN leads l ON l.id = r.lead_id AND l.company_id = r.company_id
      LEFT JOIN jobs lj ON lj.id = l.job_id AND lj.company_id = r.company_id
      WHERE r.company_id = ${companyId}
        AND r.created_at >= ${from}::date AND r.created_at < ${to}::date
      ORDER BY r.created_at DESC
    `);

    const rows = (rowsQ.rows as any[]).map((r) => {
      const booked = r.lead_status === "booked" || !!r.booked_at || !!r.job_id;
      const completed = r.first_job_status === "complete";
      const status = r.credited_at ? "credited" : completed ? "completed" : booked ? "booked" : "new";
      return {
        id: r.id,
        referred_name: r.referred_name,
        referred_phone: r.referred_phone,
        referred_email: r.referred_email,
        referral_type: r.referral_type || "residential",
        referrer_name: r.referrer_name,
        referrer_client_id: r.referrer_client_id,
        lead_id: r.lead_id,
        source: r.source,
        created_at: r.created_at,
        credited_at: r.credited_at,
        status,
      };
    });

    // Revenue from referred customers: all completed jobs of every client who
    // arrived via one of this year's referrals (distinct clients, so two
    // referral rows for the same person never double-count).
    const revQ = await db.execute(sql`
      WITH referred_clients AS (
        SELECT DISTINCT lj.client_id
        FROM referrals r
        JOIN leads l ON l.id = r.lead_id AND l.company_id = r.company_id
        JOIN jobs lj ON lj.id = l.job_id AND lj.company_id = r.company_id
        WHERE r.company_id = ${companyId}
          AND r.created_at >= ${from}::date AND r.created_at < ${to}::date
          AND lj.client_id IS NOT NULL
      )
      SELECT COALESCE(SUM(${jobRevenueExpr(sql`CAST(j.base_fee AS NUMERIC)`)}), 0)::numeric AS revenue
      FROM jobs j
      JOIN referred_clients rc ON rc.client_id = j.client_id
      LEFT JOIN clients c ON c.id = j.client_id
      WHERE j.company_id = ${companyId} AND j.status = 'complete'
    `);
    const referredRevenue = Number((revQ.rows[0] as any)?.revenue ?? 0);

    const credited = rows.filter((r) => r.status === "credited").length;
    return res.json({
      year,
      kpis: {
        referred: rows.length,
        booked: rows.filter((r) => r.status === "booked" || r.status === "completed" || r.status === "credited").length,
        completed: rows.filter((r) => r.status === "completed" || r.status === "credited").length,
        credits_owed: rows.filter((r) => r.status === "completed").length,
        credited,
        credits_given_dollars: credited * 25,
        referred_revenue: referredRevenue,
      },
      rows,
    });
  } catch (err) {
    console.error("GET /referrals/report:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/referrals/:id/credit ─────────────────────────────────────────────
// Office marks the referrer's $25 as given (applied to their next job). Stamps
// credited_at + the legacy reward_issued flag; the report reads credited_at.
router.post("/:id/credit", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(String(req.params.id));
    const result = await db.execute(sql`
      UPDATE referrals
      SET credited_at = COALESCE(credited_at, NOW()), reward_issued = TRUE, status = 'credited', updated_at = NOW()
      WHERE id = ${id} AND company_id = ${companyId}
      RETURNING id, credited_at
    `);
    if (!result.rows.length) return res.status(404).json({ error: "Referral not found" });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("POST /referrals/:id/credit:", err);
    return res.status(500).json({ error: "Failed to mark credited" });
  }
});

router.patch("/:id", requireAuth, async (req, res) => {
  const companyId = req.auth!.companyId;
  const referralId = parseInt(String(req.params.id));
  const { status, reward_issued } = req.body;
  try {
    const result = await db.execute(sql`
      UPDATE referrals SET
        status = COALESCE(${status ?? null}, status),
        reward_issued = COALESCE(${reward_issued ?? null}, reward_issued),
        updated_at = NOW()
      WHERE id = ${referralId} AND company_id = ${companyId}
      RETURNING *
    `);
    if (result.rows.length === 0) return res.status(404).json({ error: "Referral not found" });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("PATCH referral:", err);
    return res.status(500).json({ error: "Failed to update referral" });
  }
});

export default router;
