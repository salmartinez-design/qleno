import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, timeclockTable, additionalPayTable, jobsTable, clientsTable, accountsTable } from "@workspace/db/schema";
import { eq, ne, and, gte, lte, sum, count, sql, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { parseResRatesRow, resolveResidentialPayPct } from "../lib/commission-rates.js";
import { computeCommissionRows } from "../lib/commission-compute.js";
// [payroll-P0] per-tech-clocked attribution + 4-cell pay-type + hourly basis.
import { computePayLines, type PayrollJob, type ClockEntry, type TechCell, type CompanyPayConfig, type HoursBasis } from "../lib/payroll-compute.js";
import {
  resolveOvertimeRules,
  computeWeekOvertime,
  computeOvertimePremium,
  STATE_OVERTIME_PRESETS,
  FEDERAL_DEFAULT_RULES,
  type OvertimeRules,
} from "../lib/overtime.js";

const router = Router();

// [lockout-pay 2026-06-17] Jobs charged via Cancel/Lockout pay the tech the
// cancellation fee (an additional_pay 'cancellation_pay' row), NOT the job's
// normal commission. Return the set of such job ids so callers can drop them
// from the commission engine and avoid double-paying. Safe ANY(ARRAY[csv])
// binding; ids are integers.
async function chargedCancelJobIds(companyId: number, jobIds: number[]): Promise<Set<number>> {
  const set = new Set<number>();
  if (!jobIds.length) return set;
  try {
    const cc = await db.execute(sql`
      SELECT DISTINCT job_id FROM cancellation_log
       WHERE company_id = ${companyId}
         AND job_id IN (${sql.raw(jobIds.join(","))})
         AND cancel_action IN ('cancel','lockout')`);
    for (const r of cc.rows as any[]) set.add(Number(r.job_id));
  } catch { /* cancellation_log absent — no exclusion */ }
  return set;
}

router.get("/summary", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const { pay_period_start, pay_period_end, branch_id } = req.query;
    const branchFilter = branch_id && branch_id !== "all" ? parseInt(branch_id as string) : null;

    if (!pay_period_start || !pay_period_end) {
      return res.status(400).json({ error: "Bad Request", message: "pay_period_start and pay_period_end are required" });
    }

    const empConds: any[] = [eq(usersTable.company_id, req.auth!.companyId), eq(usersTable.is_active, true)];
    if (branchFilter) empConds.push(eq(usersTable.branch_id, branchFilter));
    const employees = await db.select().from(usersTable).where(and(...empConds));

    const timeclockData = await db
      .select({
        user_id: timeclockTable.user_id,
        duration: sql<number>`EXTRACT(EPOCH FROM (${timeclockTable.clock_out_at} - ${timeclockTable.clock_in_at})) / 3600`,
      })
      .from(timeclockTable)
      .where(and(
        eq(timeclockTable.company_id, req.auth!.companyId),
        gte(timeclockTable.clock_in_at, new Date(pay_period_start as string)),
        lte(timeclockTable.clock_in_at, new Date(pay_period_end as string))
      ));

    const jobSumConds: any[] = [
      eq(jobsTable.company_id, req.auth!.companyId),
      eq(jobsTable.status, "complete"),
      gte(jobsTable.scheduled_date, pay_period_start as string),
      lte(jobsTable.scheduled_date, pay_period_end as string),
    ];
    if (branchFilter) jobSumConds.push(eq(jobsTable.branch_id, branchFilter));
    const jobsData = await db
      .select({ user_id: jobsTable.assigned_user_id, cnt: count(), total_fee: sum(jobsTable.base_fee) })
      .from(jobsTable).where(and(...jobSumConds)).groupBy(jobsTable.assigned_user_id);

    const additionalPayData = await db
      .select({
        user_id: additionalPayTable.user_id,
        type: additionalPayTable.type,
        total: sum(additionalPayTable.amount),
      })
      .from(additionalPayTable)
      .where(and(
        eq(additionalPayTable.company_id, req.auth!.companyId),
        ne(additionalPayTable.status, "voided"),
        gte(additionalPayTable.created_at, new Date(`${String(pay_period_start)}T00:00:00Z`)),
        lte(additionalPayTable.created_at, new Date(`${String(pay_period_end)}T23:59:59Z`))
      ))
      .groupBy(additionalPayTable.user_id, additionalPayTable.type);

    const hoursMap = new Map<number, number>();
    for (const row of timeclockData) {
      const current = hoursMap.get(row.user_id) || 0;
      hoursMap.set(row.user_id, current + (row.duration || 0));
    }

    const jobsMap = new Map<number, { count: number; total_fee: number }>();
    for (const row of jobsData) {
      if (row.user_id) {
        jobsMap.set(row.user_id, { count: row.cnt, total_fee: parseFloat(row.total_fee || "0") });
      }
    }

    const additionalMap = new Map<number, Record<string, number>>();
    for (const row of additionalPayData) {
      if (!additionalMap.has(row.user_id)) additionalMap.set(row.user_id, {});
      const entry = additionalMap.get(row.user_id)!;
      entry[row.type] = parseFloat(row.total || "0");
    }

    const payrollEmployees = employees.map(emp => {
      const hours = hoursMap.get(emp.id) || 0;
      const jobs = jobsMap.get(emp.id) || { count: 0, total_fee: 0 };
      const additional = additionalMap.get(emp.id) || {};
      const payRate = parseFloat(emp.pay_rate || "0");

      let base_pay = 0;
      if (emp.pay_type === "hourly") {
        base_pay = hours * payRate;
      } else if (emp.pay_type === "per_job") {
        base_pay = jobs.count * payRate;
      } else if (emp.pay_type === "fee_split") {
        const splitPct = parseFloat(emp.fee_split_pct || "0") / 100;
        base_pay = jobs.total_fee * splitPct;
      }

      const tips = additional.tips || 0;
      const bonuses = additional.bonus || 0;
      const sick_pay = additional.sick_pay || 0;
      const holiday_pay = additional.holiday_pay || 0;
      const vacation_pay = additional.vacation_pay || 0;
      const deductions = additional.amount_owed || 0;
      const gross_pay = base_pay + tips + bonuses + sick_pay + holiday_pay + vacation_pay - deductions;

      return {
        user_id: emp.id,
        name: `${emp.first_name} ${emp.last_name}`,
        pay_type: emp.pay_type || "hourly",
        pay_rate: payRate,
        hours_worked: Math.round(hours * 100) / 100,
        jobs_completed: jobs.count,
        base_pay: Math.round(base_pay * 100) / 100,
        tips,
        bonuses,
        sick_pay,
        holiday_pay,
        vacation_pay,
        deductions,
        gross_pay: Math.round(gross_pay * 100) / 100,
      };
    });

    const total_gross = payrollEmployees.reduce((s, e) => s + e.gross_pay, 0);
    const total_hours = payrollEmployees.reduce((s, e) => s + e.hours_worked, 0);
    const total_jobs = payrollEmployees.reduce((s, e) => s + e.jobs_completed, 0);

    return res.json({
      pay_period_start,
      pay_period_end,
      employees: payrollEmployees,
      total_gross: Math.round(total_gross * 100) / 100,
      total_hours: Math.round(total_hours * 100) / 100,
      total_jobs,
    });
  } catch (err) {
    console.error("Payroll summary error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get payroll summary" });
  }
});

// ── Overtime check ────────────────────────────────────────────────────────────
// [overtime 2026-06-04] Jurisdiction-aware overtime review signal. Per
// CLAUDE.md "Time Clock — Workflow Model" + docs/OVERTIME_COMPLIANCE_DESIGN.md.
//
// "Hours worked" = job clock time (timeclock) + drive time BETWEEN jobs
// (mileage_legs.minutes). The home↔job commute never enters this — no clock
// runs during it and the mileage engine excludes the commute legs (29 CFR
// 785.35/785.38). Idle/breaks excluded.
//
// Threshold is per-tenant: federal/most states (incl. Illinois) = weekly-40
// only; CA/AK/CO/NV add daily overtime. The rules resolve from the company's
// OT config (falls back to the preset for companies.state, then federal).
//
// For a commission shop the only money owed on OT is the PREMIUM portion
// (extra 0.5×/1.0× the regular rate) — straight time is already in commission.
// regular rate = workweek commission ÷ hours worked; mileage excluded
// (29 CFR 778.117/778.217). The premium is an ESTIMATE for office review — it
// does not auto-move money. Pure read.
router.get("/overtime-check", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: "Bad Request", message: "from and to are required (YYYY-MM-DD)" });
    }
    const companyId = req.auth!.companyId;
    const toEnd = `${to} 23:59:59`;

    // Resolve this tenant's overtime rules (state preset unless overridden).
    let rules: OvertimeRules = { ...FEDERAL_DEFAULT_RULES };
    let rulesSource = "preset:Federal baseline";
    try {
      const cRow = await db.execute(sql`
        SELECT state, ot_rules_source, ot_weekly_threshold_hours, ot_daily_threshold_hours,
               ot_daily_doubletime_hours, ot_seventh_day_rule, ot_multiplier, ot_doubletime_multiplier
        FROM companies WHERE id = ${companyId} LIMIT 1`);
      if (cRow.rows[0]) {
        const resolved = resolveOvertimeRules(cRow.rows[0] as any);
        rules = resolved.rules;
        rulesSource = resolved.source;
      }
    } catch { /* OT columns absent pre-migration — keep federal default */ }

    // Job hours per (user, week, day) from the per-house clock.
    const jobRows = await db.execute(sql`
      SELECT user_id,
             to_char(date_trunc('week', clock_in_at), 'YYYY-MM-DD') AS week_start,
             to_char(date_trunc('day',  clock_in_at), 'YYYY-MM-DD') AS day,
             COALESCE(SUM(EXTRACT(EPOCH FROM (clock_out_at - clock_in_at)) / 3600), 0) AS job_hours
      FROM timeclock
      WHERE company_id = ${companyId}
        AND clock_out_at IS NOT NULL
        AND clock_in_at >= ${from} AND clock_in_at <= ${toEnd}
      GROUP BY user_id, week_start, day
    `);

    // Drive hours per (user, week, day) from the between-jobs mileage legs.
    const driveRows = await db.execute(sql`
      SELECT user_id,
             to_char(date_trunc('week', leg_date::timestamp), 'YYYY-MM-DD') AS week_start,
             to_char(date_trunc('day',  leg_date::timestamp), 'YYYY-MM-DD') AS day,
             COALESCE(SUM(minutes) / 60.0, 0) AS drive_hours
      FROM mileage_legs
      WHERE company_id = ${companyId}
        AND status <> 'discarded'
        AND leg_date >= ${from} AND leg_date <= ${to}
      GROUP BY user_id, week_start, day
    `);

    // Assemble per (user, week): a map of day → {job, drive} so we can feed the
    // daily-hours array to the rules engine (needed for daily-OT states).
    type WeekBucket = { user_id: number; week_start: string; days: Map<string, { job: number; drive: number }> };
    const map = new Map<string, WeekBucket>();
    const key = (u: number, w: string) => `${u}|${w}`;
    const touch = (u: number, w: string, d: string) => {
      const k = key(u, w);
      let b = map.get(k);
      if (!b) { b = { user_id: u, week_start: w, days: new Map() }; map.set(k, b); }
      let day = b.days.get(d);
      if (!day) { day = { job: 0, drive: 0 }; b.days.set(d, day); }
      return day;
    };
    for (const r of jobRows.rows as any[]) {
      touch(Number(r.user_id), String(r.week_start), String(r.day)).job += Number(r.job_hours) || 0;
    }
    for (const r of driveRows.rows as any[]) {
      touch(Number(r.user_id), String(r.week_start), String(r.day)).drive += Number(r.drive_hours) || 0;
    }

    // Weekly commission per (user, week) → the regular rate for the OT premium.
    // Reuse the canonical commission engine + per-job final_pay overrides so the
    // rate matches what the office sees on the payroll detail screen.
    const weeklyCommission = new Map<string, number>(); // user|mondayWeek → $
    try {
      let comp: any = { res_tech_pay_pct: 0.35, deep_clean_pay_pct: 0.32, move_in_out_pay_pct: 0.32, commercial_hourly_rate: 20, commercial_comp_mode: "allowed_hours" };
      try {
        const cr = await db.execute(sql`SELECT res_tech_pay_pct, deep_clean_pay_pct, move_in_out_pay_pct, commercial_hourly_rate, commercial_comp_mode FROM companies WHERE id = ${companyId} LIMIT 1`);
        if (cr.rows[0]) comp = cr.rows[0];
      } catch { /* keep defaults */ }
      const resRates = parseResRatesRow(comp);

      const cJobs = await db
        .select({
          id: jobsTable.id, assigned_user_id: jobsTable.assigned_user_id,
          service_type: jobsTable.service_type, account_id: jobsTable.account_id,
          base_fee: jobsTable.base_fee, billed_amount: jobsTable.billed_amount,
          allowed_hours: jobsTable.allowed_hours, actual_hours: jobsTable.actual_hours,
          branch_id: jobsTable.branch_id, scheduled_date: jobsTable.scheduled_date,
        })
        .from(jobsTable)
        .where(and(
          eq(jobsTable.company_id, companyId),
          eq(jobsTable.status, "complete"),
          gte(jobsTable.scheduled_date, from as string),
          lte(jobsTable.scheduled_date, to as string),
        ));

      // Per-job final_pay overrides (one query for the whole range).
      const overrides = new Map<string, number>();
      const jobIds = cJobs.map(j => j.id);
      if (jobIds.length) {
        try {
          const ov = await db.execute(sql`SELECT user_id, job_id, final_pay FROM job_technicians WHERE job_id = ANY(${jobIds}::int[]) AND final_pay IS NOT NULL`);
          for (const r of ov.rows as any[]) overrides.set(`${r.user_id}:${r.job_id}`, parseFloat(String(r.final_pay)));
        } catch { /* job_technicians may be absent */ }
      }

      const ccOut = await chargedCancelJobIds(companyId, jobIds);
      const rows = computeCommissionRows({
        jobs: cJobs.filter(j => !ccOut.has(j.id)) as any,
        resRates,
        commercial: {
          commercial_hourly_rate: parseFloat(String(comp.commercial_hourly_rate ?? 20)),
          commercial_comp_mode: (String(comp.commercial_comp_mode ?? "allowed_hours") as any),
        },
        overrides,
      });
      for (const row of rows) {
        const wk = mondayOf(row.scheduled_date);
        const k = key(row.user_id, wk);
        weeklyCommission.set(k, (weeklyCommission.get(k) || 0) + row.amount);
      }
    } catch (e) {
      console.error("Overtime commission regular-rate calc failed (non-fatal):", e);
    }

    // Nondiscretionary wage augmentations (bonuses, referrals, manual pay
    // adjustments) ARE part of the FLSA regular rate (29 CFR 778.208–.211) and
    // must be folded into it — this is what MaidCentral does and is the source
    // of the prior discrepancy (Qleno used commission only). EXCLUDED from the
    // regular rate: tips (pass-through, 29 CFR 531.55), mileage/reimbursements
    // (expense, 778.217), and paid-leave-not-worked (sick/vacation/holiday —
    // not "hours worked"). `type` is free text, so we exclude by a known list
    // and treat everything else as regular-rate wages.
    const weeklyBonus = new Map<string, number>(); // user|mondayWeek → $ bonus
    try {
      const bonusRows = await db.execute(sql`
        SELECT user_id,
               to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week_start,
               COALESCE(SUM(amount), 0) AS bonus_total
        FROM additional_pay
        WHERE company_id = ${companyId}
          AND status <> 'voided'
          AND created_at >= ${from} AND created_at <= ${toEnd}
          AND lower(type) NOT IN (
            'tips','tip','mileage','mileage_reimbursement','reimbursement',
            'sick','sick_pay','vacation','holiday','holiday_pay','pto'
          )
        GROUP BY user_id, week_start
      `);
      for (const r of bonusRows.rows as any[]) {
        weeklyBonus.set(key(Number(r.user_id), String(r.week_start)), Number(r.bonus_total) || 0);
      }
    } catch (e) {
      console.error("Overtime bonus regular-rate calc failed (non-fatal):", e);
    }

    const round1 = (n: number) => Math.round(n * 10) / 10;
    const round2 = (n: number) => Math.round(n * 100) / 100;

    const weeks = [...map.values()].map(b => {
      const dayEntries = [...b.days.entries()].sort((a, c) => a[0].localeCompare(c[0]));
      const dailyHours = dayEntries.map(([, v]) => v.job + v.drive);
      const job = dayEntries.reduce((s, [, v]) => s + v.job, 0);
      const drive = dayEntries.reduce((s, [, v]) => s + v.drive, 0);

      const ot = computeWeekOvertime(dailyHours, rules);
      const commission = weeklyCommission.get(key(b.user_id, b.week_start)) || 0;
      const bonus = weeklyBonus.get(key(b.user_id, b.week_start)) || 0;
      // Regular rate = (commission + nondiscretionary bonuses) ÷ hours worked,
      // matching MaidCentral / FLSA. Tips & mileage are excluded above.
      const regularEarnings = commission + bonus;
      const regularRate = ot.totalHours > 0 ? regularEarnings / ot.totalHours : 0;
      const premium = computeOvertimePremium({ otHours: ot.otHours, dtHours: ot.dtHours, regularRate, rules });

      return {
        user_id: b.user_id,
        week_start: b.week_start,
        job_hours: round1(job),
        drive_hours: round1(drive),
        total_hours: round1(ot.totalHours),
        // overtime_hours = premium-bearing hours (1.5× + 2×). For weekly-40
        // tenants this equals max(0, total − 40); daily-OT states may exceed it.
        overtime_hours: round1(ot.otHours + ot.dtHours),
        ot_hours: round1(ot.otHours),
        dt_hours: round1(ot.dtHours),
        weekly_commission: round2(commission),
        weekly_bonus: round2(bonus),
        weekly_regular_earnings: round2(regularEarnings),
        regular_rate: round2(regularRate),
        premium_estimate: round2(premium),
      };
    }).filter(w => w.ot_hours > 0 || w.dt_hours > 0);

    const userIds = [...new Set(weeks.map(w => w.user_id))];
    const names = userIds.length
      ? await db.select({ id: usersTable.id, first_name: usersTable.first_name, last_name: usersTable.last_name })
          .from(usersTable).where(inArray(usersTable.id, userIds))
      : [];
    const nameById = new Map(names.map(n => [n.id, `${n.first_name ?? ""} ${n.last_name ?? ""}`.trim()]));

    const enriched = weeks
      .map(w => ({ ...w, name: nameById.get(w.user_id) || `User ${w.user_id}` }))
      .sort((a, b) => b.total_hours - a.total_hours);

    const totalPremium = round2(enriched.reduce((s, w) => s + w.premium_estimate, 0));

    return res.json({
      any_over_40: enriched.length > 0,
      count: enriched.length,
      weeks: enriched,
      total_premium_estimate: totalPremium,
      rules,
      rules_source: rulesSource,
      has_daily_overtime: rules.dailyThresholdHours != null,
    });
  } catch (err) {
    console.error("Overtime check error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to run overtime check" });
  }
});

// Monday-of-week (ISO, matches Postgres date_trunc('week')) for a YYYY-MM-DD
// date string. TZ-independent because scheduled_date carries no time.
function mondayOf(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 Sun..6 Sat
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return d.toISOString().slice(0, 10);
}

// ── Overtime rules config (read + save) ───────────────────────────────────────
// Powers the Overtime section of company settings. GET returns the resolved
// rules + the state preset + all presets for the picker; PUT persists owner
// overrides onto the companies OT columns (source flips to 'custom').
router.get("/overtime-rules", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const cRow = await db.execute(sql`
      SELECT state, ot_rules_source, ot_weekly_threshold_hours, ot_daily_threshold_hours,
             ot_daily_doubletime_hours, ot_seventh_day_rule, ot_multiplier, ot_doubletime_multiplier
      FROM companies WHERE id = ${companyId} LIMIT 1`);
    const company = (cRow.rows[0] as any) || {};
    const resolved = resolveOvertimeRules(company);
    return res.json({
      state: company.state ?? null,
      rules: resolved.rules,
      source: resolved.source,
      state_preset: resolved.statePreset,
      is_custom: company.ot_rules_source === "custom",
      presets: STATE_OVERTIME_PRESETS,
    });
  } catch (err) {
    console.error("Get overtime rules error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get overtime rules" });
  }
});

router.put("/overtime-rules", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const b = req.body ?? {};

    // "reset" clears overrides → source NULL → resolver falls back to the
    // state preset again.
    if (b.reset === true) {
      await db.execute(sql`UPDATE companies SET ot_rules_source = NULL WHERE id = ${companyId}`);
      return res.json({ ok: true, reset: true });
    }

    const numOrNull = (v: any) => (v === null || v === undefined || v === "" ? null : Number(v));
    const weekly = numOrNull(b.weeklyThresholdHours) ?? 40;
    const daily = numOrNull(b.dailyThresholdHours);
    const dt = numOrNull(b.dailyDoubleTimeHours);
    const seventh = b.seventhConsecutiveDayRule === true;
    const otMult = numOrNull(b.otMultiplier) ?? 1.5;
    const dtMult = numOrNull(b.dtMultiplier) ?? 2.0;

    await db.execute(sql`
      UPDATE companies SET
        ot_rules_source = 'custom',
        ot_weekly_threshold_hours = ${weekly},
        ot_daily_threshold_hours = ${daily},
        ot_daily_doubletime_hours = ${dt},
        ot_seventh_day_rule = ${seventh},
        ot_multiplier = ${otMult},
        ot_doubletime_multiplier = ${dtMult}
      WHERE id = ${companyId}`);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Save overtime rules error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to save overtime rules" });
  }
});

// ── Pre-payroll health check ──────────────────────────────────────────────────
// [payroll-preflight 2026-06-04] The "fix before you run payroll" safety net —
// a cleaner take on MaidCentral's "Uh oh! issues with your data" screen, but
// PAYROLL-only: it flags only things that affect what a tech is PAID. Invoicing
// is deliberately excluded — billing the customer is A/R, not payroll, and the
// tech is paid regardless of whether the invoice went out (Sal, 2026-06-04).
// Checks: completed jobs with no clock punch, techs still clocked in (blocking),
// and tipped invoices with no matching tip pay (warning). Office-only, pure read.
router.get("/preflight", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "Bad Request", message: "from and to are required (YYYY-MM-DD)" });
    const companyId = req.auth!.companyId;
    const f = String(from), t = String(to), tEnd = `${to} 23:59:59`;

    let row: any = {};
    try {
      const r = await db.execute(sql`
        SELECT
          (SELECT COUNT(*) FROM jobs j
             WHERE j.company_id = ${companyId} AND j.status = 'complete'
               AND j.scheduled_date BETWEEN ${f} AND ${t}
               AND NOT EXISTS (SELECT 1 FROM timeclock tc WHERE tc.job_id = j.id)) AS no_clocks,
          (SELECT COUNT(DISTINCT tc.user_id) FROM timeclock tc
             WHERE tc.company_id = ${companyId} AND tc.clock_out_at IS NULL
               AND tc.clock_in_at::date BETWEEN ${f} AND ${t}) AS open_clocks,
          (SELECT COUNT(*) FROM invoices i
             JOIN jobs j ON j.id = i.job_id
             WHERE i.company_id = ${companyId} AND COALESCE(i.tips, 0) > 0
               AND j.scheduled_date BETWEEN ${f} AND ${t}
               AND j.assigned_user_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM additional_pay ap
                 WHERE ap.user_id = j.assigned_user_id AND ap.type = 'tips'
                   AND ap.created_at BETWEEN ${f} AND ${tEnd})) AS missing_tips
      `);
      row = r.rows[0] || {};
    } catch (e) {
      console.error("Preflight query failed (non-fatal):", e);
      return res.json({ ok: true, available: false, issues: [] });
    }

    const n = (v: any) => Number(v || 0);
    const issues = [
      { key: "jobs_without_clocks", severity: "block", count: n(row.no_clocks),    label: "completed job(s) with no clock punch", action: "Add a clock or cancel the job" },
      { key: "still_clocked_in",    severity: "block", count: n(row.open_clocks),   label: "employee(s) still clocked in",         action: "Review clock data" },
      { key: "missing_tips",        severity: "warn",  count: n(row.missing_tips),  label: "tipped invoice(s) with no tip pay",    action: "Review tips — won't block payroll" },
    ].filter(i => i.count > 0);

    const blocking = issues.filter(i => i.severity === "block");
    return res.json({
      ok: blocking.length === 0,
      available: true,
      total_blocking: blocking.reduce((s, i) => s + i.count, 0),
      issues,
    });
  } catch (err) {
    console.error("Preflight error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to run payroll preflight" });
  }
});

// ── Payroll Detail (per-job breakdown) ────────────────────────────────────────

router.get("/detail", requireAuth, async (req, res) => {
  try {
    const { pay_period_start, pay_period_end, user_id } = req.query;
    if (!pay_period_start || !pay_period_end) {
      return res.status(400).json({ error: "pay_period_start and pay_period_end are required" });
    }

    const role = (req as any).auth!.role;
    const myUserId = (req as any).auth!.userId;
    const companyId = (req as any).auth!.companyId;

    // Techs can only see their own data
    const filterUserId = role === "technician" ? myUserId : (user_id ? parseInt(user_id as string) : null);

    // Get company payroll settings (using raw SQL since columns added via ALTER TABLE)
    // [AI.7.5.hotfix] Resilient SELECT — see routes/dispatch.ts for the
    // same pattern. If commercial_* columns are absent (migration hadn't
    // run), fall back to res_tech_pay_pct only and default the rest.
    let compSettings: any = {
      res_tech_pay_pct: 0.35,
      deep_clean_pay_pct: 0.32,
      move_in_out_pay_pct: 0.32,
      commercial_hourly_rate: 20.00,
      commercial_comp_mode: "allowed_hours",
    };
    try {
      const compRows = await db.execute(sql`SELECT res_tech_pay_pct, deep_clean_pay_pct, move_in_out_pay_pct, commercial_hourly_rate, commercial_comp_mode FROM companies WHERE id = ${companyId} LIMIT 1`);
      if (compRows.rows[0]) compSettings = compRows.rows[0];
    } catch {
      // Tiered columns absent — fall back to legacy SELECT, keep tier defaults
      try {
        const compRows = await db.execute(sql`SELECT res_tech_pay_pct, commercial_hourly_rate, commercial_comp_mode FROM companies WHERE id = ${companyId} LIMIT 1`);
        if (compRows.rows[0]) compSettings = { ...compSettings, ...(compRows.rows[0] as any) };
      } catch {
        try {
          const fallback = await db.execute(sql`SELECT res_tech_pay_pct FROM companies WHERE id = ${companyId} LIMIT 1`);
          if (fallback.rows[0]) compSettings = { ...compSettings, res_tech_pay_pct: (fallback.rows[0] as any).res_tech_pay_pct };
        } catch { /* keep defaults */ }
      }
    }
    const resRates = parseResRatesRow(compSettings);
    const resPct = resRates.res_tech_pay_pct; // Standard residential — kept for legacy response payload
    const commercialHourlyRate = parseFloat(String(compSettings.commercial_hourly_rate ?? 20));
    const commercialCompMode = String(compSettings.commercial_comp_mode ?? "allowed_hours");

    // Get all techs (to calculate num_techs_on_job approximation)
    const jobConditions: any[] = [
      eq(jobsTable.company_id, companyId),
      eq(jobsTable.status, "complete"),
      gte(jobsTable.scheduled_date, pay_period_start as string),
      lte(jobsTable.scheduled_date, pay_period_end as string),
    ];
    // [payroll-P0] No assigned_user_id filter here — attribution is now
    // per-tech-CLOCKED, so we load every in-scope job and filter the computed
    // pay LINES by filterUserId below. A tech earns from any job they clocked,
    // including ones where they were a helper (not the primary).

    const jobs = await db
      .select({
        id: jobsTable.id,
        scheduled_date: jobsTable.scheduled_date,
        service_type: jobsTable.service_type,
        base_fee: jobsTable.base_fee,
        billed_amount: jobsTable.billed_amount,
        allowed_hours: jobsTable.allowed_hours,
        actual_hours: jobsTable.actual_hours,
        assigned_user_id: jobsTable.assigned_user_id,
        // [AI.7.4] account_id drives the commercial-vs-residential branch.
        account_id: jobsTable.account_id,
        // [Model A — Step 5] branch_id surfaces in every job row so the
        // per-branch commission rollup below can group without a re-fetch.
        branch_id: jobsTable.branch_id,
        client_first: clientsTable.first_name,
        client_last: clientsTable.last_name,
        // [account-name 2026-06-12] Commercial account jobs carry account_id
        // with NO client_id, so the clients join is all-NULL and the
        // per-client breakdown rendered "—" (Sal: 5/31 + 6/1 rows nameless).
        // Surface the account's name as the display fallback.
        account_name: accountsTable.account_name,
        // Commercial CLIENTS (no account_id) are still commercial for pay —
        // never a residential %. Routing below keys on account_id OR this.
        client_type: clientsTable.client_type,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
      .where(and(...jobConditions))
      .orderBy(jobsTable.scheduled_date);

    // [payroll-quality 2026-06-08] Per-job customer quality score (0–4) from the
    // scorecards table, keyed by job_id. Powers the quality-forward payroll view
    // (Sal's "emphasis on customer quality"): weekly avg quality per tech + a
    // per-job rating column. Office-excluded scorecards drop out of the average.
    // Raw SQL + try/catch so a tenant without the table degrades gracefully.
    const scoreByJob = new Map<number, { score: number; excluded: boolean }>();
    {
      const allJobIds = jobs.map(j => j.id);
      if (allJobIds.length) {
        try {
          const sc = await db.execute(
            sql`SELECT job_id, score, excluded FROM scorecards WHERE company_id = ${companyId} AND job_id = ANY(${allJobIds}::int[])`,
          );
          for (const r of sc.rows as any[]) scoreByJob.set(Number(r.job_id), { score: Number(r.score), excluded: !!r.excluded });
        } catch { /* scorecards table absent — skip quality */ }
      }
    }

    // Look up branch names once so the rollup carries a human label, not just id.
    const branchNameMap = new Map<number, string>();
    try {
      const branchRows = await db.execute(
        sql`SELECT id, name FROM branches WHERE company_id = ${companyId}`,
      );
      for (const r of branchRows.rows as any[]) {
        branchNameMap.set(r.id, r.name);
      }
    } catch { /* branches table not in some seeded tenants; rollup degrades to ids */ }

    // Get additional pay for the period (tips, mileage — period level, not per job)
    // Bucket additional pay by its effective date (created_at), inclusive of the
    // whole end day in UTC so an entry dated on the last day of the period lands
    // in the period. [additional-pay-date 2026-06-08]
    const addlPayConditions: any[] = [
      eq(additionalPayTable.company_id, companyId),
      ne(additionalPayTable.status, "voided"),
      gte(additionalPayTable.created_at, new Date(`${String(pay_period_start)}T00:00:00Z`)),
      lte(additionalPayTable.created_at, new Date(`${String(pay_period_end)}T23:59:59Z`)),
    ];
    if (filterUserId) addlPayConditions.push(eq(additionalPayTable.user_id, filterUserId));

    const addlPay = await db
      .select({ user_id: additionalPayTable.user_id, type: additionalPayTable.type, amount: additionalPayTable.amount, notes: additionalPayTable.notes })
      .from(additionalPayTable)
      .where(and(...addlPayConditions));

    // [payroll-summary 2026-06-04] pay_adjustments (the 2B mileage-reimbursement
    // promotion + any office adjustments) never reached the payroll summary —
    // /detail only read additional_pay, so applied mileage was invisible here.
    // Pull them grouped per (user, adjustment_type) and fold into each
    // employee's breakdown + grand total below. Filtered by created_at to match
    // the additional_pay window. Raw SQL + try/catch so a tenant without the
    // table degrades gracefully.
    const adjByUser = new Map<number, Record<string, number>>();
    try {
      const adjRows = await db.execute(sql`
        SELECT user_id, adjustment_type, COALESCE(SUM(amount), 0) AS total
        FROM pay_adjustments
        WHERE company_id = ${companyId}
          AND created_at >= ${String(pay_period_start)}
          AND created_at <= ${String(pay_period_end) + " 23:59:59"}
          ${filterUserId ? sql`AND user_id = ${filterUserId}` : sql``}
        GROUP BY user_id, adjustment_type
      `);
      for (const r of adjRows.rows as any[]) {
        const uid = Number(r.user_id);
        if (!adjByUser.has(uid)) adjByUser.set(uid, {});
        adjByUser.get(uid)![String(r.adjustment_type)] = parseFloat(String(r.total || 0));
      }
    } catch { /* pay_adjustments absent for this tenant — skip */ }

    // [tech-rewards 2026-06-04] Per-tech mileage accrued in the window (any
    // non-discarded leg). Powers the tech's "total rewards" tracker. Reported
    // separately as totals.mileage — display-only; applied mileage already
    // counts in grand_total via pay_adjustments above, so this isn't re-added.
    const mileageByUser = new Map<number, number>();
    try {
      const mRows = await db.execute(sql`
        SELECT user_id, COALESCE(SUM(amount), 0) AS total
        FROM mileage_legs
        WHERE company_id = ${companyId}
          AND status <> 'discarded'
          AND leg_date >= ${String(pay_period_start)} AND leg_date <= ${String(pay_period_end)}
          ${filterUserId ? sql`AND user_id = ${filterUserId}` : sql``}
        GROUP BY user_id
      `);
      for (const r of mRows.rows as any[]) mileageByUser.set(Number(r.user_id), parseFloat(String(r.total || 0)));
    } catch { /* mileage_legs absent — skip */ }

    // ── [payroll-P0] per-tech-CLOCKED attribution via computePayLines ────────
    // A tech earns from every job they personally clocked (helpers included).
    // Residential commission is a pool split among the job's clocked commission
    // techs (weighted by minutes); clocked hourly techs are paid hourly and
    // excluded from the pool. Pay type comes from the 4-cell matrix.
    const jobById = new Map<number, typeof jobs[number]>(jobs.map(j => [j.id, j]));
    const inScopeJobIds = jobs.map(j => j.id);
    // [payroll-P0 hotfix] Use the codebase-proven inline int-array form
    // (ARRAY[…]::int[] via sql.raw) for raw db.execute IN-lists. The drizzle
    // `ANY(${jsArray}::int[])` param form does NOT bind correctly here and was
    // silently caught, zeroing out the clocked attribution. Ids are our own
    // integers (number-coerced, finite-filtered) — no injection surface.
    const intList = (a: number[]) => a.map(Number).filter(Number.isFinite).join(",");

    // per-(tech, job) clocked hours, summed
    const clocks: ClockEntry[] = [];
    if (inScopeJobIds.length) {
      try {
        const cr = await db.execute(sql`
          SELECT user_id, job_id, ROUND(SUM(EXTRACT(EPOCH FROM (clock_out_at - clock_in_at)) / 3600.0)::numeric, 2) AS hrs
          FROM timeclock
          WHERE company_id = ${companyId} AND job_id = ANY(ARRAY[${sql.raw(intList(inScopeJobIds))}]::int[]) AND clock_out_at IS NOT NULL
          GROUP BY user_id, job_id`);
        for (const r of cr.rows as any[]) clocks.push({ user_id: Number(r.user_id), job_id: Number(r.job_id), clocked_hours: parseFloat(String(r.hrs || 0)) });
      } catch (err) { console.error("[payroll/detail] clocks query failed:", err); }
    }

    // 4-cell pay matrix per clocked tech (single source of truth for pay type)
    const clockedUserIds = [...new Set(clocks.map(c => c.user_id))];
    const cellByUser = new Map<number, TechCell>();
    const userMap = new Map<number, { first_name: string; last_name: string }>();
    if (clockedUserIds.length) {
      const urows = await db.execute(sql`
        SELECT id, first_name, last_name, residential_pay_type, residential_pay_rate, commercial_pay_type, commercial_pay_rate
        FROM users WHERE company_id = ${companyId} AND id = ANY(ARRAY[${sql.raw(intList(clockedUserIds))}]::int[])`);
      for (const u of urows.rows as any[]) {
        userMap.set(Number(u.id), { first_name: u.first_name ?? "", last_name: u.last_name ?? "" });
        cellByUser.set(Number(u.id), {
          residential_pay_type: u.residential_pay_type === "hourly" ? "hourly" : "commission",
          residential_pay_rate: parseFloat(String(u.residential_pay_rate ?? resRates.res_tech_pay_pct)),
          commercial_pay_type: u.commercial_pay_type === "commission" ? "commission" : "hourly",
          commercial_pay_rate: parseFloat(String(u.commercial_pay_rate ?? commercialHourlyRate)),
        });
      }
    }

    // company hours-basis default for hourly techs (greater_of when unset/absent)
    let hoursBasis: HoursBasis = "greater_of";
    try {
      const hb = await db.execute(sql`SELECT payroll_hours_basis FROM companies WHERE id = ${companyId} LIMIT 1`);
      const v = (hb.rows[0] as any)?.payroll_hours_basis;
      if (v === "actual_clocked" || v === "allowed_hours" || v === "greater_of") hoursBasis = v;
    } catch { /* column absent pre-migration — keep greater_of default */ }

    // per-job HOURS overrides (office hand-adjusted paid hours; never dollars)
    const paidHoursOverride = new Map<string, number>();
    if (inScopeJobIds.length) {
      try {
        const po = await db.execute(sql`
          SELECT user_id, job_id, paid_hours FROM payroll_hours_overrides
          WHERE company_id = ${companyId} AND job_id = ANY(ARRAY[${sql.raw(intList(inScopeJobIds))}]::int[])`);
        for (const r of po.rows as any[]) if (r.paid_hours != null) paidHoursOverride.set(`${r.user_id}:${r.job_id}`, parseFloat(String(r.paid_hours)));
      } catch { /* payroll_hours_overrides table absent pre-migration — none */ }
    }

    // existing per-job final_pay DOLLAR overrides (job_technicians) still win
    const finalPayOverride = new Map<string, number>();
    if (inScopeJobIds.length) {
      try {
        const fp = await db.execute(sql`SELECT user_id, job_id, final_pay FROM job_technicians WHERE job_id = ANY(ARRAY[${sql.raw(intList(inScopeJobIds))}]::int[]) AND final_pay IS NOT NULL`);
        for (const r of fp.rows as any[]) if (r.final_pay != null) finalPayOverride.set(`${r.user_id}:${r.job_id}`, parseFloat(String(r.final_pay)));
      } catch { /* job_technicians absent — no overrides */ }
    }

    const payConfig: CompanyPayConfig = {
      resRates,
      commercial_hourly_rate: commercialHourlyRate,
      commercial_comp_mode: commercialCompMode === "actual_hours" ? "actual_hours" : "allowed_hours",
      hours_basis: hoursBasis,
    };
    const jobsForPay: PayrollJob[] = jobs.map(j => ({
      id: j.id, account_id: (j as any).account_id ?? null, client_type: (j as any).client_type ?? null,
      service_type: j.service_type, base_fee: j.base_fee, billed_amount: j.billed_amount,
      allowed_hours: j.allowed_hours, actual_hours: j.actual_hours,
      scheduled_date: String(j.scheduled_date), branch_id: (j as any).branch_id ?? null,
    }));
    const payLines = computePayLines({ jobs: jobsForPay, clocks, cellByUser, config: payConfig, paidHoursOverride, finalPayOverride });

    // group lines by tech (filterUserId applied here — techs see only their own)
    const linesByUser = new Map<number, typeof payLines>();
    for (const l of payLines) {
      if (filterUserId && l.user_id !== filterUserId) continue;
      if (!linesByUser.has(l.user_id)) linesByUser.set(l.user_id, []);
      linesByUser.get(l.user_id)!.push(l);
    }

    const result = [];
    for (const [uid, userLines] of linesByUser) {
      const user = userMap.get(uid) || { first_name: "Unknown", last_name: "" };
      const userAddlPay = addlPay.filter(p => p.user_id === uid);

      const jobRows = userLines.map(l => {
        const job = jobById.get(l.job_id);
        const jobTotal = job ? parseFloat(String(job.billed_amount || job.base_fee || 0)) : 0;
        const allowedHrs = job ? parseFloat(String(job.allowed_hours || 0)) : 0;
        const scEntry = scoreByJob.get(l.job_id);
        const quality_score = scEntry && !scEntry.excluded ? scEntry.score : null;
        return {
          job_id: l.job_id,
          date: job ? job.scheduled_date : l.scheduled_date,
          client: job ? (`${job.client_first || ""} ${job.client_last || ""}`.trim() || job.account_name || "") : "",
          scope: job ? job.service_type : null,
          job_total: jobTotal,
          // `commission` keeps its field name for UI compat but now carries the
          // tech's PAY for this job (hourly, commission-pool-share, or override).
          commission: l.amount,
          commission_overridden: l.basis === "manual_override",
          commission_basis: l.pay_type === "hourly" ? "hourly" : l.basis,
          // explain-the-math label straight from the engine.
          pay_basis: l.pay_basis_label,
          pay_type: l.pay_type,
          hours_overridden: l.hours_overridden,
          quality_score,
          branch_id: l.branch_id ?? null,
          branch_name: l.branch_id != null ? (branchNameMap.get(l.branch_id) ?? null) : null,
          hrs_scheduled: allowedHrs,
          // per-tech CLOCKED hours now (not the job's single actual_hours);
          // paid_hours when an hourly line floored/overrode above the clock.
          hrs_worked: l.paid_hours > 0 ? l.paid_hours : l.clocked_hours,
          hrs_actual: l.clocked_hours,
          hrs_estimated: false,
          effective_rate: l.clocked_hours > 0 ? Math.round((l.amount / l.clocked_hours) * 100) / 100 : null,
        };
      });

      // [Model A — Step 5] Per-branch commission rollup. Adds a sub-table to
      // each employee's panel so techs and office immediately see "Oak Lawn
      // $X / Schaumburg $Y" without scanning individual rows. Branchless
      // legacy jobs roll up under a synthetic "(no branch)" bucket.
      const commissionByBranch = new Map<number | "none", { branch_id: number | null; branch_name: string; commission: number; jobs: number; hrs_worked: number }>();
      for (const r of jobRows) {
        const key: number | "none" = r.branch_id ?? "none";
        const cur = commissionByBranch.get(key) ?? {
          branch_id: r.branch_id,
          branch_name: r.branch_name ?? "(no branch)",
          commission: 0,
          jobs: 0,
          hrs_worked: 0,
        };
        cur.commission += r.commission;
        cur.jobs += 1;
        cur.hrs_worked += r.hrs_worked;
        commissionByBranch.set(key, cur);
      }
      const branchRollup = [...commissionByBranch.values()].map(r => ({
        branch_id: r.branch_id,
        branch_name: r.branch_name,
        commission: Math.round(r.commission * 100) / 100,
        jobs: r.jobs,
        hrs_worked: Math.round(r.hrs_worked * 100) / 100,
      })).sort((a, b) => b.commission - a.commission);

      // Additional pay by type
      const addlByType: Record<string, number> = {};
      for (const p of userAddlPay) {
        addlByType[p.type] = (addlByType[p.type] || 0) + parseFloat(String(p.amount || 0));
      }
      // Fold pay_adjustments (e.g. mileage_reimbursement from the 2B apply gate)
      // into the same breakdown so they show as a line AND land in grand_total.
      for (const [adjType, amt] of Object.entries(adjByUser.get(uid) || {})) {
        addlByType[adjType] = (addlByType[adjType] || 0) + amt;
      }

      const totalCommission = jobRows.reduce((s, j) => s + j.commission, 0);
      const totalJobTotal = jobRows.reduce((s, j) => s + j.job_total, 0);
      const totalHrsScheduled = jobRows.reduce((s, j) => s + j.hrs_scheduled, 0);
      const totalHrsWorked = jobRows.reduce((s, j) => s + j.hrs_worked, 0);
      // [payroll-quality 2026-06-08] Weekly customer-quality avg = mean of the
      // non-excluded per-job ratings. null when nothing was rated this period.
      const scoredJobs = jobRows.filter(j => j.quality_score != null);
      const qualityAvg = scoredJobs.length
        ? Math.round((scoredJobs.reduce((s, j) => s + (j.quality_score as number), 0) / scoredJobs.length) * 100) / 100
        : null;
      const grandTotal = totalCommission + Object.values(addlByType).reduce((s, v) => s + v, 0);

      result.push({
        user_id: uid,
        name: `${user.first_name} ${user.last_name}`.trim(),
        jobs: jobRows,
        additional_pay: addlByType,
        // [Model A — Step 5] commission_by_branch is the "where did your
        // commission come from" sub-table the UI renders inside each
        // employee's expanded panel.
        commission_by_branch: branchRollup,
        totals: {
          job_count: jobRows.length,
          job_total: Math.round(totalJobTotal * 100) / 100,
          commission: Math.round(totalCommission * 100) / 100,
          hrs_scheduled: Math.round(totalHrsScheduled * 100) / 100,
          hrs_worked: Math.round(totalHrsWorked * 100) / 100,
          mileage: Math.round((mileageByUser.get(uid) || 0) * 100) / 100,
          effective_rate: totalHrsWorked > 0 ? Math.round((totalCommission / totalHrsWorked) * 100) / 100 : null,
          quality_avg: qualityAvg,
          quality_count: scoredJobs.length,
          grand_total: Math.round(grandTotal * 100) / 100,
        },
      });
    }

    return res.json({ data: result, res_tech_pay_pct: resPct });
  } catch (err) {
    console.error("Payroll detail error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get payroll detail" });
  }
});

// ── Reconciliation audit (MC transition) ─────────────────────────────────────
// [recon-audit 2026-06-12] One screen instead of tab-flipping into MaidCentral.
// For a pay window, surfaces every job/day whose pay inputs look wrong, in the
// exact categories the Juan Salazar penny-reconciliation exposed:
//   1. commercial_misroutes — job's service type is a commercial scope (from
//      the tenant-managed commercial_service_types table + the built-in legacy
//      slugs) but the client carries no account link / commercial flag, so the
//      engine paid the residential % instead of commercial hourly. Reports the
//      paid-vs-expected delta per job (4009 W 93rd Condo: $145.87 vs $44).
//   2. solo_pools — big residential pool jobs (allowed >= 5h) carrying <= 1
//      tech: the likely missing-split-partner case (Cameron Goth: one tech
//      took the whole 32% pool that MC split two ways).
//   3. stale_scheduled — past jobs in the window never marked complete. They
//      pay nobody and bill nothing (the May revenue hole + the all-$0 current
//      week both come from this).
//   4. clocked_no_job — tech punched a clock on a day with no completed job
//      attached to them (job missing from Qleno entirely, e.g. Issa Sweis 6/6).
//   5. unlinked_jobs — completed jobs with neither client_id nor account_id.
// Read-only; office fixes the data through the normal surfaces.
router.get("/reconciliation-audit", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: "Bad Request", message: "from and to (YYYY-MM-DD) are required" });
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;

    // Company comp config — same resilient waterfall as /detail.
    let compSettings: any = {
      res_tech_pay_pct: 0.35, deep_clean_pay_pct: 0.32, move_in_out_pay_pct: 0.32,
      commercial_hourly_rate: 20.0, commercial_comp_mode: "allowed_hours",
    };
    try {
      const rows = await db.execute(sql`SELECT res_tech_pay_pct, deep_clean_pay_pct, move_in_out_pay_pct, commercial_hourly_rate, commercial_comp_mode FROM companies WHERE id = ${companyId} LIMIT 1`);
      if (rows.rows[0]) compSettings = rows.rows[0];
    } catch { /* tiered columns absent — defaults */ }
    const resRates = parseResRatesRow(compSettings);
    const commercialRate = parseFloat(String(compSettings.commercial_hourly_rate ?? 20));

    // Commercial scopes: tenant-managed slugs (active AND deactivated — old
    // jobs keep their slug) plus the built-in legacy set that predates the
    // commercial_service_types table.
    const commercialSlugs = new Set<string>(["commercial_cleaning", "office_cleaning", "common_areas", "ppm_turnover"]);
    try {
      const r = await db.execute(sql`SELECT slug FROM commercial_service_types WHERE company_id = ${companyId}`);
      for (const row of r.rows as any[]) commercialSlugs.add(String(row.slug).toLowerCase());
    } catch { /* table absent on a fresh tenant */ }

    const [completedRows, staleRows, staleCountRow, clockRows] = await Promise.all([
      db.execute(sql`
        SELECT j.id, j.scheduled_date::text AS date, j.service_type::text AS service_type,
               j.account_id, j.client_id, j.base_fee, j.billed_amount, j.allowed_hours,
               COALESCE(NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), ''), a.account_name) AS name,
               c.client_type,
               NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS tech,
               (SELECT COUNT(*)::int FROM job_technicians jt WHERE jt.job_id = j.id) AS tech_count,
               COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (tc.clock_out_at - tc.clock_in_at)) / 3600.0)
                           FROM timeclock tc WHERE tc.job_id = j.id AND tc.clock_out_at IS NOT NULL), 0) AS clocked_hours
          FROM jobs j
          LEFT JOIN clients c ON c.id = j.client_id
          LEFT JOIN accounts a ON a.id = j.account_id
          LEFT JOIN users u ON u.id = j.assigned_user_id
         WHERE j.company_id = ${companyId} AND j.status = 'complete'
           AND j.scheduled_date >= ${from} AND j.scheduled_date <= ${to}
      `),
      db.execute(sql`
        SELECT j.id, j.scheduled_date::text AS date, j.status::text AS status,
               COALESCE(NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), ''), a.account_name) AS name,
               NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS tech,
               COALESCE(CAST(j.billed_amount AS NUMERIC), CAST(j.base_fee AS NUMERIC), 0) AS amount
          FROM jobs j
          LEFT JOIN clients c ON c.id = j.client_id
          LEFT JOIN accounts a ON a.id = j.account_id
          LEFT JOIN users u ON u.id = j.assigned_user_id
         WHERE j.company_id = ${companyId}
           AND j.status IN ('scheduled', 'in_progress')
           AND j.scheduled_date >= ${from} AND j.scheduled_date <= ${to}
           AND j.scheduled_date <= (now() AT TIME ZONE 'America/Chicago')::date
         ORDER BY j.scheduled_date, j.id
         LIMIT 50
      `),
      db.execute(sql`
        SELECT COUNT(*)::int AS n FROM jobs j
         WHERE j.company_id = ${companyId}
           AND j.status IN ('scheduled', 'in_progress')
           AND j.scheduled_date >= ${from} AND j.scheduled_date <= ${to}
           AND j.scheduled_date <= (now() AT TIME ZONE 'America/Chicago')::date
      `),
      db.execute(sql`
        SELECT tc.user_id,
               NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS name,
               tc.clock_in_at::date::text AS date,
               ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(tc.clock_out_at, tc.clock_in_at) - tc.clock_in_at)) / 3600.0)::numeric, 1) AS hours
          FROM timeclock tc
          JOIN users u ON u.id = tc.user_id
         WHERE tc.company_id = ${companyId}
           AND tc.clock_in_at::date >= ${from} AND tc.clock_in_at::date <= ${to}
           AND COALESCE(u.is_sandbox, false) = false
           AND NOT EXISTS (
             SELECT 1 FROM jobs j
              WHERE j.company_id = ${companyId} AND j.status = 'complete'
                AND j.assigned_user_id = tc.user_id
                AND j.scheduled_date = tc.clock_in_at::date)
           AND NOT EXISTS (
             SELECT 1 FROM job_technicians jt
              JOIN jobs j2 ON j2.id = jt.job_id
              WHERE jt.user_id = tc.user_id AND j2.status = 'complete'
                AND j2.scheduled_date = tc.clock_in_at::date)
         GROUP BY tc.user_id, u.first_name, u.last_name, tc.clock_in_at::date
         ORDER BY tc.clock_in_at::date, name
      `),
    ]);

    const commercial_misroutes: any[] = [];
    const solo_pools: any[] = [];
    const unlinked_jobs: any[] = [];
    for (const r of completedRows.rows as any[]) {
      const st = String(r.service_type ?? "").toLowerCase();
      const allowed = parseFloat(String(r.allowed_hours ?? "0")) || 0;
      const clocked = r2(parseFloat(String(r.clocked_hours ?? "0")) || 0);
      const jobTotal = parseFloat(String(r.billed_amount ?? "")) || parseFloat(String(r.base_fee ?? "")) || 0;
      const isCommercialRouted = r.account_id != null || r.client_type === "commercial";

      if (r.client_id == null && r.account_id == null) {
        unlinked_jobs.push({ job_id: r.id, date: r.date, service_type: st, tech: r.tech, amount: r2(jobTotal) });
      }
      if (!isCommercialRouted && commercialSlugs.has(st)) {
        const pct = resolveResidentialPayPct(st, resRates);
        const paid = r2(jobTotal * pct);
        // Hours signal mirrors the engine: allowed when present, else clocked.
        const hrs = allowed > 0 ? allowed : clocked;
        const expected = r2(commercialRate * hrs);
        commercial_misroutes.push({
          job_id: r.id, client_id: r.client_id ?? null, date: r.date, name: r.name, service_type: st, tech: r.tech,
          job_total: r2(jobTotal), pct_paid: Math.round(pct * 100), paid_residential: paid,
          hours: r2(hrs), expected_commercial: expected, delta: r2(paid - expected),
        });
      }
      if (!isCommercialRouted && !commercialSlugs.has(st) && allowed >= 5 && Number(r.tech_count) <= 1) {
        const pct = resolveResidentialPayPct(st, resRates);
        solo_pools.push({
          job_id: r.id, date: r.date, name: r.name, service_type: st, tech: r.tech,
          allowed_hours: r2(allowed), clocked_hours: clocked,
          tech_count: Number(r.tech_count), pool_paid: r2(jobTotal * pct),
        });
      }
    }
    commercial_misroutes.sort((a, b) => b.delta - a.delta);

    return res.json({
      data: {
        from, to,
        commercial_misroutes,
        solo_pools,
        stale_scheduled: { total: Number((staleCountRow.rows[0] as any)?.n ?? 0), rows: staleRows.rows },
        clocked_no_job: clockRows.rows,
        unlinked_jobs,
        potential_overpay: r2(commercial_misroutes.reduce((s, m) => s + m.delta, 0)),
      },
    });
  } catch (err) {
    console.error("Payroll reconciliation-audit error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to run reconciliation audit" });
  }
});

// ── Payroll-to-Revenue trend (weekly, with YOY overlay) ───────────────────────
// [payroll-trend 2026-06-08] Company-level weekly revenue vs payroll for the
// Payroll summary chart (MaidCentral "Payroll to Revenue" parity + a YOY
// overlay). Revenue = completed-job totals by week; payroll = commission
// (canonical engine) + additional_pay + applied pay_adjustments by week. The
// prior-year series is the same weeks shifted −364 days (52 wks — keeps the
// Monday alignment); it's plumbed in even though Phes has no pre-cutover data
// yet, so it lights up automatically once a year of history exists. Office-only.
router.get("/revenue-trend", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const weeks = Math.min(Math.max(parseInt(String(req.query.weeks ?? "26"), 10) || 26, 4), 104);

    const addDays = (ymd: string, n: number) => {
      const d = new Date(`${ymd}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const curWeekMon = mondayOf(new Date().toISOString().slice(0, 10));
    const curStart = addDays(curWeekMon, -(weeks - 1) * 7);
    const curEnd = addDays(curWeekMon, 6); // Sunday of the current week
    const priorStart = addDays(curStart, -364);
    const priorEnd = addDays(curEnd, -364);

    // Company comp settings (same resolution as the rest of the payroll build).
    let comp: any = { res_tech_pay_pct: 0.35, deep_clean_pay_pct: 0.32, move_in_out_pay_pct: 0.32, commercial_hourly_rate: 20, commercial_comp_mode: "allowed_hours" };
    try {
      const cr = await db.execute(sql`SELECT res_tech_pay_pct, deep_clean_pay_pct, move_in_out_pay_pct, commercial_hourly_rate, commercial_comp_mode FROM companies WHERE id = ${companyId} LIMIT 1`);
      if (cr.rows[0]) comp = cr.rows[0];
    } catch { /* keep defaults */ }
    const resRates = parseResRatesRow(comp);
    const commercial = {
      commercial_hourly_rate: parseFloat(String(comp.commercial_hourly_rate ?? 20)),
      commercial_comp_mode: String(comp.commercial_comp_mode ?? "allowed_hours") as "allowed_hours" | "actual_hours",
    };

    // Build a week(MondayYMD) → {revenue, payroll} map for one [from,to] window.
    const buildWindow = async (from: string, to: string) => {
      const bucket = new Map<string, { revenue: number; payroll: number }>();
      const touch = (wk: string) => {
        let b = bucket.get(wk);
        if (!b) { b = { revenue: 0, payroll: 0 }; bucket.set(wk, b); }
        return b;
      };

      // any[] conditions array (matches /detail) so drizzle's and()/where()
      // overload inference stays happy.
      const trendConds: any[] = [
        eq(jobsTable.company_id, companyId),
        eq(jobsTable.status, "complete"),
        gte(jobsTable.scheduled_date, from),
        lte(jobsTable.scheduled_date, to),
      ];
      const cJobs = await db
        .select({
          id: jobsTable.id, assigned_user_id: jobsTable.assigned_user_id,
          service_type: jobsTable.service_type, account_id: jobsTable.account_id,
          base_fee: jobsTable.base_fee, billed_amount: jobsTable.billed_amount,
          allowed_hours: jobsTable.allowed_hours, actual_hours: jobsTable.actual_hours,
          branch_id: jobsTable.branch_id, scheduled_date: jobsTable.scheduled_date,
        })
        .from(jobsTable)
        .where(and(...trendConds));

      // Revenue = every completed job's total by week (incl. unassigned).
      for (const j of cJobs) {
        const total = parseFloat(String(j.billed_amount ?? j.base_fee ?? 0)) || 0;
        touch(mondayOf(j.scheduled_date)).revenue += total;
      }

      // Commission via the canonical engine (+ per-job final_pay overrides).
      const overrides = new Map<string, number>();
      const jobIds = cJobs.map(j => j.id);
      if (jobIds.length) {
        try {
          const ov = await db.execute(sql`SELECT user_id, job_id, final_pay FROM job_technicians WHERE job_id = ANY(${jobIds}::int[]) AND final_pay IS NOT NULL`);
          for (const r of ov.rows as any[]) overrides.set(`${r.user_id}:${r.job_id}`, parseFloat(String(r.final_pay)));
        } catch { /* job_technicians absent */ }
      }
      const ccOut2 = await chargedCancelJobIds(companyId, jobIds);
      const rows = computeCommissionRows({ jobs: cJobs.filter(j => !ccOut2.has(j.id)) as any, resRates, commercial, overrides });
      for (const row of rows) touch(mondayOf(row.scheduled_date)).payroll += row.amount;

      // Additional pay + applied pay_adjustments by their created_at week.
      try {
        const ap = await db.execute(sql`
          SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS wk, COALESCE(SUM(amount),0) AS total
          FROM additional_pay WHERE company_id = ${companyId} AND status <> 'voided' AND created_at >= ${from} AND created_at <= ${to + " 23:59:59"}
          GROUP BY wk`);
        for (const r of ap.rows as any[]) touch(String(r.wk)).payroll += parseFloat(String(r.total || 0));
      } catch { /* additional_pay absent — skip */ }
      try {
        const adj = await db.execute(sql`
          SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS wk, COALESCE(SUM(amount),0) AS total
          FROM pay_adjustments WHERE company_id = ${companyId} AND created_at >= ${from} AND created_at <= ${to + " 23:59:59"}
          GROUP BY wk`);
        for (const r of adj.rows as any[]) touch(String(r.wk)).payroll += parseFloat(String(r.total || 0));
      } catch { /* pay_adjustments absent — skip */ }

      return bucket;
    };

    const [cur, prior] = await Promise.all([
      buildWindow(curStart, curEnd),
      buildWindow(priorStart, priorEnd),
    ]);

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const labelFmt = (ymd: string) => { const d = new Date(`${ymd}T00:00:00Z`); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };

    const series = [];
    for (let i = 0; i < weeks; i++) {
      const wk = addDays(curStart, i * 7);
      const c = cur.get(wk) || { revenue: 0, payroll: 0 };
      const p = prior.get(addDays(wk, -364)) || { revenue: 0, payroll: 0 };
      series.push({
        week_start: wk,
        label: labelFmt(wk),
        revenue: round2(c.revenue),
        payroll: round2(c.payroll),
        ratio: c.revenue > 0 ? Math.round((c.payroll / c.revenue) * 1000) / 10 : null,
        prior_revenue: round2(p.revenue),
        prior_payroll: round2(p.payroll),
      });
    }

    const totRev = series.reduce((s, w) => s + w.revenue, 0);
    const totPay = series.reduce((s, w) => s + w.payroll, 0);

    return res.json({
      weeks: series,
      from: curStart,
      to: curEnd,
      total_revenue: round2(totRev),
      total_payroll: round2(totPay),
      payroll_pct: totRev > 0 ? Math.round((totPay / totRev) * 1000) / 10 : null,
      has_prior_data: series.some(w => w.prior_revenue > 0 || w.prior_payroll > 0),
    });
  } catch (err) {
    console.error("Payroll revenue-trend error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get revenue trend" });
  }
});

// ── Pay Templates ─────────────────────────────────────────────────────────────

router.get("/templates", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const rows = await db.execute(
      sql`SELECT * FROM pay_templates WHERE company_id = ${req.auth!.companyId} ORDER BY id`
    );
    return res.json({ data: rows.rows });
  } catch (err) {
    console.error("GET /payroll/templates:", err);
    return res.status(500).json({ error: "Failed to load templates" });
  }
});

router.post("/templates", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const { name, type, amount, notes } = req.body;
    if (!name || !type || !amount) return res.status(400).json({ error: "name, type, amount required" });
    const rows = await db.execute(
      sql`INSERT INTO pay_templates (company_id, name, type, amount, notes) VALUES (${req.auth!.companyId}, ${name}, ${type}, ${parseFloat(amount)}, ${notes || null}) RETURNING *`
    );
    return res.json({ data: rows.rows[0] });
  } catch (err) {
    console.error("POST /payroll/templates:", err);
    return res.status(500).json({ error: "Failed to create template" });
  }
});

router.delete("/templates/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    await db.execute(
      sql`DELETE FROM pay_templates WHERE id = ${parseInt(req.params.id)} AND company_id = ${req.auth!.companyId}`
    );
    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE /payroll/templates/:id:", err);
    return res.status(500).json({ error: "Failed to delete template" });
  }
});

// ── Bulk Pay ──────────────────────────────────────────────────────────────────

router.post("/bulk-pay", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const { employee_ids, type, amount, notes } = req.body;
    if (!Array.isArray(employee_ids) || !employee_ids.length || !type || !amount) {
      return res.status(400).json({ error: "employee_ids (array), type, amount required" });
    }
    const companyId = req.auth!.companyId;
    const parsedAmount = parseFloat(amount);

    // Verify all employees belong to this company
    const emps = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.company_id, companyId), inArray(usersTable.id, employee_ids)));

    if (emps.length !== employee_ids.length) {
      return res.status(403).json({ error: "One or more employees not found in your company" });
    }

    const inserts = emps.map(e => ({
      company_id: companyId,
      user_id: e.id,
      type,
      amount: parsedAmount.toFixed(2),
      notes: notes || null,
      status: "pending" as const,
    }));

    await db.insert(additionalPayTable).values(inserts);
    return res.json({ success: true, count: inserts.length });
  } catch (err) {
    console.error("POST /payroll/bulk-pay:", err);
    return res.status(500).json({ error: "Failed to create bulk pay entries" });
  }
});

// ── [Phase 2] PUBLISH PAYROLL — snapshot a period's pay into locked records ───
// Office/admin/owner only. Idempotent: re-publish upserts the snapshot.
router.post("/publish", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = (req as any).auth!.companyId;
    const byUserId = (req as any).auth!.userId;
    const { pay_period_start, pay_period_end } = req.body || {};
    if (!pay_period_start || !pay_period_end) return res.status(400).json({ error: "pay_period_start and pay_period_end are required" });
    const { publishPeriod } = await import("../lib/payroll-snapshot.js");
    const out = await publishPeriod(companyId, String(pay_period_start), String(pay_period_end), byUserId);
    return res.json({ ok: true, ...out, pay_period_start, pay_period_end });
  } catch (err: any) {
    console.error("POST /payroll/publish:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err?.message });
  }
});

// ── [Phase 2] PUBLISH STATUS — has this period been snapshotted? ──────────────
// Office/admin/owner. Drives the payroll page's Publish button label + the
// "exporting unpublished" warning. Company-wide (not per-tech). [one-engine 2026-06-19]
router.get("/publish-status", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = (req as any).auth!.companyId;
    const { pay_period_start, pay_period_end } = req.query;
    if (!pay_period_start || !pay_period_end) return res.status(400).json({ error: "pay_period_start and pay_period_end are required" });
    const { ensurePayrollSnapshotSetup } = await import("../lib/payroll-snapshot.js");
    await ensurePayrollSnapshotSetup();
    const row = (await db.execute(sql`
      SELECT COUNT(*)::int AS cnt, COALESCE(SUM(gross), 0) AS total_gross, MAX(published_at) AS published_at
      FROM payroll_period_snapshots
      WHERE company_id = ${companyId} AND pay_period_start = ${String(pay_period_start)} AND pay_period_end = ${String(pay_period_end)}`)).rows[0] as any;
    const cnt = Number(row?.cnt || 0);
    return res.json({
      published: cnt > 0,
      count: cnt,
      total_gross: parseFloat(String(row?.total_gross || 0)),
      published_at: row?.published_at ?? null,
    });
  } catch (err: any) {
    console.error("GET /payroll/publish-status:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err?.message });
  }
});

// ── [Phase 2] PAYROLL EXPORT — provider-neutral CSV for the payroll processor ─
// Office/admin/owner only. ONE ENGINE: rows come from the published snapshot
// when present, else a live computePeriodPay run (same engine as the on-screen
// detail and the snapshot). Columns: identifier, name, period, regular hours,
// OT hours, regular pay, OT pay, adjustments total, gross. [one-engine 2026-06-19]
router.get("/export", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = (req as any).auth!.companyId;
    const { pay_period_start, pay_period_end } = req.query;
    if (!pay_period_start || !pay_period_end) return res.status(400).json({ error: "pay_period_start and pay_period_end are required" });
    const start = String(pay_period_start), end = String(pay_period_end);
    const { buildPeriodExportRows } = await import("../lib/payroll-snapshot.js");
    const { buildPayExportCsv, buildPayExportFilename } = await import("../lib/pay-export.js");
    const { source, rows } = await buildPeriodExportRows(companyId, start, end);
    const csv = buildPayExportCsv({ period_start: start, period_end: end, rows });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${buildPayExportFilename(start, end)}"`);
    res.setHeader("X-Export-Source", source); // "published" | "live" — UI can warn when exporting unpublished
    return res.send(csv);
  } catch (err: any) {
    console.error("GET /payroll/export:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err?.message });
  }
});

// ── [Phase 2] PAY HISTORY — published snapshots for the employee-profile Pay
// section. ACCESS SCOPING: a technician sees ONLY their own; office/admin/owner
// may pass ?user_id= to view any tech. A tech who passes someone else's id is
// silently forced back to their own (never another tech's pay).
router.get("/pay-history", requireAuth, async (req, res) => {
  try {
    const companyId = (req as any).auth!.companyId;
    const role = (req as any).auth!.role;
    const myId = (req as any).auth!.userId;
    const canSeeAll = role === "owner" || role === "admin" || role === "office";
    const requested = req.query.user_id ? parseInt(String(req.query.user_id)) : myId;
    const targetUserId = canSeeAll ? requested : myId; // techs locked to self
    const { db } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");
    const rows = (await db.execute(sql`
      SELECT pay_period_start::text AS pay_period_start, pay_period_end::text AS pay_period_end,
             gross, base, hours, tips, overtime, bonus, adjustments, breakdown, published_at
      FROM payroll_period_snapshots
      WHERE company_id = ${companyId} AND user_id = ${targetUserId}
      ORDER BY pay_period_start DESC`)).rows;
    return res.json({ user_id: targetUserId, scoped: canSeeAll ? "all" : "self", weeks: rows });
  } catch (err: any) {
    console.error("GET /payroll/pay-history:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err?.message });
  }
});

export default router;
