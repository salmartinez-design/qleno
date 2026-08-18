import { db } from "@workspace/db";
import { usersTable, jobsTable } from "@workspace/db/schema";
import { eq, and, gte, lte, sql, inArray } from "drizzle-orm";
import { round2 } from "@workspace/payroll-metrics";
import { parseResRatesRow } from "./commission-rates.js";
import { computeCommissionRows } from "./commission-compute.js";
import { inIntList } from "./sql-lists.js";
import { payDaySql } from "./pay-day.js";
import {
  resolveOvertimeRules,
  computeWeekOvertime,
  computeOvertimePremium,
  FEDERAL_DEFAULT_RULES,
  type OvertimeRules,
} from "./overtime.js";

// ─────────────────────────────────────────────────────────────────────────────
// [overtime-one-engine 2026-08-17] The ONE overtime calculation.
//
// This is the body that used to live inside GET /payroll/overtime-check. It is
// here because a second surface — the Payroll Summary report — was computing
// its own "overtime" as:
//
//     Math.max(0, clock_hours - 40) * users.pay_rate * 0.5
//
// which is wrong three times over. It hardcodes 40 and 0.5× at a call site
// (CLAUDE.md: "Never hardcode 40 or 1.5× at a call site — go through the
// engine"), so a tenant on California daily-overtime rules would be told they
// owe nothing. It multiplies by `users.pay_rate`, a $15–$20 hourly figure that
// nothing in Qleno has ever paid anybody — Phes pays commission, and every one
// of the 14 active cleaners carries a stale `pay_type='hourly'` label. And it
// counts clock hours only, so the between-jobs drive time that IS hours worked
// under 29 CFR 785.38 never entered the threshold test.
//
// The number it produced was then added into that report's Gross Pay column.
// It was not a display quirk; it was invented money on a payroll screen.
//
// One definition now, used by both surfaces. See docs/OVERTIME_COMPLIANCE_DESIGN.md
// and the "Overtime — Jurisdiction-Aware" section of CLAUDE.md.
//
// WHAT THIS IS: an ESTIMATE for office review. It never moves money. Qleno does
// not run payroll — the office reads the number and pays it through ADP.
// ─────────────────────────────────────────────────────────────────────────────

/** Hours worked = per-house clock + between-jobs drive. Never the commute. */
export interface OvertimeWeek {
  user_id: number;
  week_start: string;
  job_hours: number;
  drive_hours: number;
  total_hours: number;
  /** Premium-bearing hours (1.5× + 2×). */
  overtime_hours: number;
  ot_hours: number;
  dt_hours: number;
  weekly_commission: number;
  weekly_bonus: number;
  weekly_regular_earnings: number;
  regular_rate: number;
  premium_estimate: number;
  name: string;
}

export interface OvertimeEstimate {
  weeks: OvertimeWeek[];
  rules: OvertimeRules;
  rules_source: string;
  has_daily_overtime: boolean;
  total_premium_estimate: number;
  /** user_id → premium owed across every week in the range. */
  premiumByUser: Map<number, number>;
}

/**
 * [lockout-pay 2026-06-17] Jobs charged via Cancel/Lockout pay the tech the
 * cancellation fee (an additional_pay 'cancellation_pay' row), NOT the job's
 * normal commission. Return the set of such job ids so callers can drop them
 * from the commission engine and avoid double-paying. Safe ANY(ARRAY[csv])
 * binding; ids are integers.
 */
export async function chargedCancelJobIds(companyId: number, jobIds: number[]): Promise<Set<number>> {
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

/**
 * Monday-of-week (ISO, matches Postgres date_trunc('week')) for a YYYY-MM-DD
 * date string. TZ-independent because scheduled_date carries no time.
 */
export function mondayOf(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 Sun..6 Sat
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return d.toISOString().slice(0, 10);
}

/**
 * Overtime premium owed on top of commission, per employee per workweek, for
 * every week touching [from, to].
 *
 * "Hours worked" = job clock time (timeclock) + drive time BETWEEN jobs
 * (mileage_legs.minutes). The home↔job commute never enters this — no clock
 * runs during it and the mileage engine excludes the commute legs (29 CFR
 * 785.35/785.38). Idle and breaks are excluded.
 *
 * Threshold is per-tenant: federal / most states (incl. Illinois) = weekly-40
 * only; CA/AK/CO/NV add daily overtime. The rules resolve from the company's OT
 * config, falling back to the preset for companies.state, then federal.
 *
 * For a commission shop the only money owed on OT is the PREMIUM portion (the
 * extra 0.5× / 1.0× of the regular rate) — straight time is already inside the
 * commission. regular rate = (workweek commission + nondiscretionary bonuses) ÷
 * hours worked. Tips (29 CFR 531.55) and mileage (778.217) are excluded.
 *
 * Pure read. Returns weeks that actually carry premium hours; a week under the
 * threshold is omitted.
 */
export async function computeOvertimeEstimate(
  companyId: number,
  from: string,
  to: string,
): Promise<OvertimeEstimate> {
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
        gte(jobsTable.scheduled_date, from),
        lte(jobsTable.scheduled_date, to),
      ));

    // Per-job final_pay overrides (one query for the whole range).
    const overrides = new Map<string, number>();
    const jobIds = cJobs.map(j => j.id);
    // [ANY(array) trap 2026-08-14] This lookup used `= ANY(${jobIds}::int[])`,
    // which throws at every length through Drizzle — and the catch below
    // swallowed it, so `overrides` was ALWAYS empty. Every hand-set final_pay
    // the office entered was silently dropped and this surface paid the
    // engine amount instead. The catch stays for a genuinely absent table on
    // a fresh tenant, but it is no longer hiding a query bug.
    const ovList = inIntList(jobIds);
    if (ovList) {
      try {
        const ov = await db.execute(sql`SELECT user_id, job_id, final_pay FROM job_technicians WHERE job_id IN (${ovList}) AND final_pay IS NOT NULL`);
        for (const r of ov.rows as any[]) overrides.set(`${r.user_id}:${r.job_id}`, parseFloat(String(r.final_pay)));
      } catch (e) { console.error("[overtime] final_pay override lookup failed:", (e as any)?.message); }
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
      weeklyCommission.set(key(row.user_id, wk), (weeklyCommission.get(key(row.user_id, wk)) || 0) + row.amount);
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
             to_char(date_trunc('week', ${payDaySql("additional_pay")}::timestamp), 'YYYY-MM-DD') AS week_start,
             COALESCE(SUM(amount), 0) AS bonus_total
      FROM additional_pay
      WHERE company_id = ${companyId}
        AND status <> 'voided'
        AND ${payDaySql("additional_pay")} BETWEEN ${from} AND ${to}
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

  const enriched: OvertimeWeek[] = weeks
    .map(w => ({ ...w, name: nameById.get(w.user_id) || `User ${w.user_id}` }))
    .sort((a, b) => b.total_hours - a.total_hours);

  const premiumByUser = new Map<number, number>();
  for (const w of enriched) {
    premiumByUser.set(w.user_id, round2((premiumByUser.get(w.user_id) ?? 0) + w.premium_estimate));
  }

  return {
    weeks: enriched,
    rules,
    rules_source: rulesSource,
    has_daily_overtime: rules.dailyThresholdHours != null,
    total_premium_estimate: round2(enriched.reduce((s, w) => s + w.premium_estimate, 0)),
    premiumByUser,
  };
}
