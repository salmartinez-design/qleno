import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../../lib/auth.js";
import { computeMrr } from "../../lib/recurring-mrr.js";

// [recurring-revenue 2026-07-12] READ-ONLY reporting for the recurring module.
// Every query here is a SELECT — it computes MRR / Data Health / dashboard
// figures live from Qleno's own recurring_schedules + clients + jobs, and the
// (additive) capture tables when present. It NEVER writes clients /
// recurring_schedules / jobs. Residential-only (RES) for Phase 1.

const router = Router();
const VIEW_ROLES = ["owner", "admin", "office", "super_admin"] as const;
const RES = "residential";

const CADENCE_LABEL: Record<string, string> = {
  weekly: "Weekly", biweekly: "Biweekly", every_3_weeks: "Every 3 weeks",
  every_6_weeks: "Every 6 weeks", every_8_weeks: "Every 8 weeks",
  semi_monthly: "Semi-monthly", monthly: "Monthly", custom: "Custom", weekdays: "Weekdays",
};

// GET /api/recurring/overview?branch_id= — powers Data Health + Dashboard.
router.get("/overview", requireAuth, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const branchId = req.query.branch_id != null ? parseInt(String(req.query.branch_id)) : null;

    // Active residential recurring schedules — the MRR universe (SELECT only).
    const schedRows = await db.execute(sql`
      SELECT rs.id, rs.frequency::text AS cadence, rs.base_fee::numeric AS rate,
             rs.custom_frequency_weeks AS custom_weeks, c.branch_id AS branch_id,
             concat(c.first_name, ' ', c.last_name) AS client_name, c.id AS client_id
        FROM recurring_schedules rs
        JOIN clients c ON c.id = rs.customer_id
       WHERE rs.company_id = ${companyId} AND rs.is_active = true AND c.client_type = ${RES}
         ${branchId != null ? sql`AND c.branch_id = ${branchId}` : sql``}
    `);
    const scheds = schedRows.rows as Array<{ id: number; cadence: string; rate: string | null; custom_weeks: number | null; client_id: number; client_name: string }>;

    let computable = 0, blockedZeroRate = 0, blockedNoMultiplier = 0, derivedMrr = 0;
    const byCadence = new Map<string, { count: number; mrr: number; computable: number }>();
    for (const s of scheds) {
      const r = computeMrr(s.cadence, s.rate, s.custom_weeks);
      const key = s.cadence + (s.cadence === "custom" ? (s.custom_weeks ? `_${s.custom_weeks}w` : "_noint") : "");
      const bucket = byCadence.get(key) ?? { count: 0, mrr: 0, computable: 0 };
      bucket.count++;
      if (r.computable && r.mrr != null) {
        computable++; derivedMrr += r.mrr; bucket.mrr += r.mrr; bucket.computable++;
      } else if (parseFloat(String(s.rate ?? "0")) <= 0) {
        blockedZeroRate++;
      } else {
        blockedNoMultiplier++;
      }
      byCadence.set(key, bucket);
    }
    const totalActive = scheds.length;
    derivedMrr = Math.round(derivedMrr * 100) / 100;
    const confidence = totalActive ? Math.round((computable / totalActive) * 100) : 0;

    // Blocking checks beyond the schedule math — real counts (SELECT only).
    const dupRows = await db.execute(sql`
      WITH d AS (
        SELECT lower(trim(email)) AS k FROM clients WHERE company_id=${companyId} AND client_type=${RES}
          AND email IS NOT NULL AND trim(email)<>'' GROUP BY 1 HAVING count(*)>1
        UNION ALL
        SELECT right(regexp_replace(coalesce(phone,''),'\\D','','g'),10) AS k FROM clients
          WHERE company_id=${companyId} AND client_type=${RES}
          AND length(regexp_replace(coalesce(phone,''),'\\D','','g'))>=10 GROUP BY 1 HAVING count(*)>1
      ) SELECT count(*)::int AS n FROM d`);
    const dupGroups = Number((dupRows.rows[0] as any)?.n ?? 0);

    const noClientRows = await db.execute(sql`
      SELECT count(*)::int AS n FROM jobs
       WHERE company_id=${companyId} AND client_id IS NULL AND account_id IS NULL
         AND scheduled_date >= date_trunc('month', CURRENT_DATE)`);
    const noClientJobs = Number((noClientRows.rows[0] as any)?.n ?? 0);

    // Capture-derived metrics (paused / lost / starting). The additive tables may
    // be empty or not yet created — never let that break the read. 0 until capture.
    const cap = async (q: any): Promise<number> => {
      try { const r = await db.execute(q); return Number((r.rows[0] as any)?.n ?? 0); } catch { return 0; }
    };
    const paused = await cap(sql`SELECT count(*)::int AS n FROM recurring_subscriptions WHERE company_id=${companyId} AND client_type=${RES} AND status='paused'`);
    const lost = await cap(sql`SELECT count(*)::int AS n FROM recurring_subscriptions WHERE company_id=${companyId} AND client_type=${RES} AND status='lost'`);
    const startingWeek = await cap(sql`SELECT count(*)::int AS n FROM recurring_subscriptions WHERE company_id=${companyId} AND client_type=${RES} AND first_cleaning_date >= date_trunc('week', CURRENT_DATE) AND first_cleaning_date < date_trunc('week', CURRENT_DATE) + interval '7 days'`);
    const captureActive = await cap(sql`SELECT count(*)::int AS n FROM recurring_subscriptions WHERE company_id=${companyId}`);

    const cadenceBreakdown = [...byCadence.entries()]
      .map(([key, v]) => {
        const base = key.replace(/_\d+w$/, "").replace(/_noint$/, "");
        const label = key.endsWith("_noint") ? "Custom · no interval"
          : /_\d+w$/.test(key) ? `Custom · every ${key.match(/_(\d+)w$/)![1]} wks`
          : (CADENCE_LABEL[base] ?? base);
        return { cadence: label, count: v.count, mrr: Math.round(v.mrr * 100) / 100, computable: v.computable };
      })
      .sort((a, b) => b.count - a.count);

    return res.json({
      client_type: RES,
      data_health: {
        total_active: totalActive,
        computable,
        blocked_zero_rate: blockedZeroRate,
        blocked_no_multiplier: blockedNoMultiplier,
        derived_mrr: derivedMrr,
        confidence,
        issues: [
          blockedZeroRate ? { severity: "blocker", key: "zero_rate", title: "Active schedule with a $0.00 rate", detail: "MRR can't be computed without a rate.", count: blockedZeroRate } : null,
          blockedNoMultiplier ? { severity: "blocker", key: "no_interval", title: "Custom cadence with no interval set", detail: "No “every N weeks”, so MRR is indeterminate.", count: blockedNoMultiplier } : null,
          noClientJobs ? { severity: "high", key: "no_client", title: "Job with no client attached", detail: "Untraceable revenue — commercial, excluded from Phase 1.", count: noClientJobs } : null,
          dupGroups ? { severity: "high", key: "dup", title: "Clients sharing an email or phone", detail: "Includes shared-household contacts; review to catch true duplicates.", count: dupGroups } : null,
        ].filter(Boolean),
      },
      dashboard: {
        active_recurring: computable,
        active_total: totalActive,
        mrr: derivedMrr,
        confidence,
        paused, lost, starting_this_week: startingWeek,
        capture_started: captureActive > 0,
        cadence_breakdown: cadenceBreakdown,
      },
    });
  } catch (err) {
    console.error("[recurring/overview]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/recurring/clients?branch_id= — the recurring-clients list. Reads live
// from recurring_schedules + clients + the assigned cleaner (SELECT only).
router.get("/clients", requireAuth, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const branchId = req.query.branch_id != null ? parseInt(String(req.query.branch_id)) : null;
    const rows = await db.execute(sql`
      SELECT rs.id AS schedule_id, c.id AS client_id,
             concat(c.first_name, ' ', c.last_name) AS client_name,
             c.city, c.client_type,
             rs.frequency::text AS cadence, rs.base_fee::numeric AS rate,
             rs.custom_frequency_weeks AS custom_weeks, rs.start_date,
             concat(u.first_name, ' ', u.last_name) AS cleaner
        FROM recurring_schedules rs
        JOIN clients c ON c.id = rs.customer_id
        LEFT JOIN users u ON u.id = rs.assigned_employee_id
       WHERE rs.company_id = ${companyId} AND rs.is_active = true AND c.client_type = ${RES}
         ${branchId != null ? sql`AND c.branch_id = ${branchId}` : sql``}
       ORDER BY c.first_name, c.last_name`);
    const clients = (rows.rows as any[]).map((r) => {
      const m = computeMrr(r.cadence, r.rate, r.custom_weeks);
      return {
        client_id: r.client_id, name: r.client_name, city: r.city, client_type: r.client_type,
        cadence: CADENCE_LABEL[r.cadence] ?? r.cadence, cadence_key: r.cadence,
        rate: r.rate != null ? Number(r.rate) : null,
        mrr: m.mrr, mrr_computable: m.computable, mrr_reason: m.reason,
        cleaner: r.cleaner && r.cleaner.trim() ? r.cleaner : null,
        start_date: r.start_date, status: "active",
      };
    });
    const totalMrr = Math.round(clients.reduce((s, c) => s + (c.mrr ?? 0), 0) * 100) / 100;
    return res.json({ client_type: RES, count: clients.length, total_mrr: totalMrr, clients });
  } catch (err) {
    console.error("[recurring/clients]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
