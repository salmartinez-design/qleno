import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { computePayLines, type PayrollJob, type ClockEntry, type TechCell, type CompanyPayConfig, type HoursBasis } from "./payroll-compute.js";
import { parseResRatesRow } from "./commission-rates.js";
import { snapshotToExportRow, type PayExportRow } from "./pay-export.js";

/**
 * Phase 2 — PUBLISH PAYROLL: snapshot each tech's computed pay for a pay period
 * into a locked per-(period, tech) record, and read it back for the
 * employee-profile Pay section. Idempotent: re-publishing a period upserts.
 *
 * The snapshot is the SOURCE OF TRUTH for what a tech is shown — once published
 * it doesn't drift if jobs/clocks change later. Breakdown columns mirror the
 * MaidCentral grid the team is used to (base / hours / tips / OT / bonus /
 * adjustments) plus a per-job JSON for the expandable detail.
 */
export async function ensurePayrollSnapshotSetup(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS payroll_period_snapshots (
        id serial PRIMARY KEY,
        company_id integer NOT NULL,
        pay_period_start date NOT NULL,
        pay_period_end date NOT NULL,
        user_id integer NOT NULL,
        gross numeric(10,2) NOT NULL DEFAULT 0,
        base numeric(10,2) NOT NULL DEFAULT 0,
        hours numeric(8,2) NOT NULL DEFAULT 0,
        tips numeric(10,2) NOT NULL DEFAULT 0,
        overtime numeric(10,2) NOT NULL DEFAULT 0,
        bonus numeric(10,2) NOT NULL DEFAULT 0,
        adjustments numeric(10,2) NOT NULL DEFAULT 0,
        breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
        published_at timestamptz NOT NULL DEFAULT now(),
        published_by_user_id integer,
        CONSTRAINT payroll_snap_uniq UNIQUE (company_id, pay_period_start, pay_period_end, user_id)
      )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_payroll_snap_user ON payroll_period_snapshots (company_id, user_id, pay_period_start DESC)`);
    console.log("[payroll-snapshot] schema ready");
  } catch (err) {
    console.error("[payroll-snapshot] ensure setup error (non-fatal):", err);
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const intList = (a: number[]) => a.map(Number).filter(Number.isFinite).join(",");

export interface PeriodPay {
  user_id: number;
  name: string;
  gross: number;
  base: number;
  hours: number;
  tips: number;
  overtime: number;
  bonus: number;
  adjustments: number; // sick + other adjustment-type additional_pay
  jobs: Array<{ job_id: number; date: string; client: string; amount: number; hours: number; basis: string }>;
  additional_pay: Record<string, number>;
}

/**
 * Compute each tech's pay for a period using the MC-parity engine + additional_pay.
 * Same inputs/rules as GET /payroll/detail; returned in snapshot shape.
 */
export async function computePeriodPay(companyId: number, start: string, end: string): Promise<PeriodPay[]> {
  const co = (await db.execute(sql`SELECT res_tech_pay_pct, deep_clean_pay_pct, move_in_out_pay_pct, commercial_hourly_rate, commercial_comp_mode, payroll_hours_basis FROM companies WHERE id = ${companyId} LIMIT 1`)).rows[0] as any;
  const resRates = parseResRatesRow(co);
  const hb = co?.payroll_hours_basis;
  const config: CompanyPayConfig = {
    resRates,
    commercial_hourly_rate: parseFloat(String(co?.commercial_hourly_rate ?? 20)),
    commercial_comp_mode: co?.commercial_comp_mode === "actual_hours" ? "actual_hours" : "allowed_hours",
    hours_basis: (hb === "actual_clocked" || hb === "allowed_hours" || hb === "greater_of" ? hb : "greater_of") as HoursBasis,
  };
  const jr = (await db.execute(sql`
    SELECT j.id, j.account_id, cl.client_type, cl.first_name, cl.last_name, a.account_name, j.service_type,
           j.base_fee, j.billed_amount, j.allowed_hours, j.actual_hours, j.scheduled_date::text AS scheduled_date, j.branch_id
    FROM jobs j LEFT JOIN clients cl ON cl.id = j.client_id LEFT JOIN accounts a ON a.id = j.account_id
    WHERE j.company_id = ${companyId} AND j.status = 'complete'
      AND j.scheduled_date >= ${start} AND j.scheduled_date <= ${end}`)).rows as any[];
  const jobs: PayrollJob[] = jr.map(j => ({ id: j.id, account_id: j.account_id, client_type: j.client_type, service_type: j.service_type, base_fee: j.base_fee, billed_amount: j.billed_amount, allowed_hours: j.allowed_hours, actual_hours: j.actual_hours, scheduled_date: j.scheduled_date, branch_id: j.branch_id }));
  const nameOfJob = new Map<number, string>(jr.map(j => [j.id, (`${j.first_name ?? ""} ${j.last_name ?? ""}`.trim() || j.account_name || "")]));
  const ids = jobs.map(j => j.id);
  if (!ids.length) return [];

  const clocks: ClockEntry[] = ((await db.execute(sql`
    SELECT user_id, job_id, ROUND(SUM(EXTRACT(EPOCH FROM (clock_out_at - clock_in_at)) / 3600.0)::numeric, 2) AS hrs
    FROM timeclock WHERE company_id = ${companyId} AND job_id = ANY(ARRAY[${sql.raw(intList(ids))}]::int[]) AND clock_out_at IS NOT NULL
    GROUP BY user_id, job_id`)).rows as any[]).map(r => ({ user_id: Number(r.user_id), job_id: Number(r.job_id), clocked_hours: parseFloat(String(r.hrs || 0)) }));

  const clockedUserIds = [...new Set(clocks.map(c => c.user_id))];
  const cellByUser = new Map<number, TechCell>();
  const userMap = new Map<number, string>();
  // [sandbox-exclude 2026-06-20] Test/sandbox fixtures (is_sandbox=true) never
  // belong in a payroll run — must match GET /payroll/detail exactly. Excluded
  // at the OUTPUT (folds below skip them) so real techs' pool shares don't move.
  // is_sandbox, NOT is_active: a deactivated-but-real tech (is_active=false,
  // is_sandbox=false) is still owed clocked pay and stays in.
  const sandboxUserIds = new Set<number>();
  if (clockedUserIds.length) {
    const us = (await db.execute(sql`SELECT id, first_name, last_name, is_sandbox, residential_pay_type, residential_pay_rate, commercial_pay_type, commercial_pay_rate FROM users WHERE company_id = ${companyId} AND id = ANY(ARRAY[${sql.raw(intList(clockedUserIds))}]::int[])`)).rows as any[];
    for (const u of us) {
      if (u.is_sandbox === true) { sandboxUserIds.add(Number(u.id)); continue; }
      userMap.set(Number(u.id), `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim());
      cellByUser.set(Number(u.id), {
        residential_pay_type: u.residential_pay_type === "hourly" ? "hourly" : "commission",
        residential_pay_rate: parseFloat(String(u.residential_pay_rate ?? resRates.res_tech_pay_pct)),
        commercial_pay_type: u.commercial_pay_type === "commission" ? "commission" : "hourly",
        commercial_pay_rate: parseFloat(String(u.commercial_pay_rate ?? config.commercial_hourly_rate)),
      });
    }
  }
  const paidOv = new Map<string, number>();
  try { for (const r of (await db.execute(sql`SELECT user_id, job_id, paid_hours FROM payroll_hours_overrides WHERE company_id = ${companyId} AND job_id = ANY(ARRAY[${sql.raw(intList(ids))}]::int[])`)).rows as any[]) if (r.paid_hours != null) paidOv.set(`${r.user_id}:${r.job_id}`, parseFloat(String(r.paid_hours))); } catch { /* table absent */ }
  const finalOv = new Map<string, number>();
  try { for (const r of (await db.execute(sql`SELECT user_id, job_id, final_pay FROM job_technicians WHERE job_id = ANY(ARRAY[${sql.raw(intList(ids))}]::int[]) AND final_pay IS NOT NULL`)).rows as any[]) if (r.final_pay != null) finalOv.set(`${r.user_id}:${r.job_id}`, parseFloat(String(r.final_pay))); } catch { /* */ }

  const lines = computePayLines({ jobs, clocks, cellByUser, config, paidHoursOverride: paidOv, finalPayOverride: finalOv });

  // additional_pay by user + type, bucketed by created_at in the window
  const addlByUser = new Map<number, Record<string, number>>();
  for (const r of (await db.execute(sql`
    SELECT user_id, type, COALESCE(SUM(amount), 0) AS t FROM additional_pay
    WHERE company_id = ${companyId} AND status <> 'voided'
      AND created_at >= ${start + "T00:00:00Z"} AND created_at <= ${end + "T23:59:59Z"}
    GROUP BY user_id, type`)).rows as any[]) {
    const uid = Number(r.user_id);
    if (!addlByUser.has(uid)) addlByUser.set(uid, {});
    addlByUser.get(uid)![String(r.type)] = parseFloat(String(r.t || 0));
  }

  // Fold pay_adjustments (the 2B applied-mileage promotion + any office
  // adjustments) into the SAME per-(user,type) map. GET /payroll/detail counts
  // these in its grand_total, so the snapshot must too — otherwise the published
  // number under-reports applied mileage vs. the on-screen detail. Window +
  // additive merge mirror the /detail route exactly. Raw SQL + try/catch so a
  // tenant without the table degrades gracefully. [one-engine 2026-06-19]
  try {
    for (const r of (await db.execute(sql`
      SELECT user_id, adjustment_type, COALESCE(SUM(amount), 0) AS t FROM pay_adjustments
      WHERE company_id = ${companyId}
        AND created_at >= ${start} AND created_at <= ${end + " 23:59:59"}
      GROUP BY user_id, adjustment_type`)).rows as any[]) {
      const uid = Number(r.user_id);
      if (!addlByUser.has(uid)) addlByUser.set(uid, {});
      const m = addlByUser.get(uid)!;
      m[String(r.adjustment_type)] = (m[String(r.adjustment_type)] || 0) + parseFloat(String(r.t || 0));
    }
  } catch { /* pay_adjustments absent for this tenant — skip */ }

  const byUser = new Map<number, PeriodPay>();
  for (const l of lines) {
    if (sandboxUserIds.has(l.user_id)) continue; // [sandbox-exclude] drop test fixtures
    if (!byUser.has(l.user_id)) byUser.set(l.user_id, { user_id: l.user_id, name: userMap.get(l.user_id) || "", gross: 0, base: 0, hours: 0, tips: 0, overtime: 0, bonus: 0, adjustments: 0, jobs: [], additional_pay: {} });
    const p = byUser.get(l.user_id)!;
    p.base = r2(p.base + l.amount);
    p.hours = r2(p.hours + (l.paid_hours > 0 ? l.paid_hours : l.clocked_hours));
    p.jobs.push({ job_id: l.job_id, date: l.scheduled_date, client: nameOfJob.get(l.job_id) || "", amount: l.amount, hours: l.paid_hours > 0 ? l.paid_hours : l.clocked_hours, basis: l.pay_basis_label });
  }
  // fold additional_pay
  for (const [uid, types] of addlByUser) {
    if (sandboxUserIds.has(uid)) continue; // [sandbox-exclude] a test fixture earns no additional_pay either
    if (!byUser.has(uid)) byUser.set(uid, { user_id: uid, name: userMap.get(uid) || "", gross: 0, base: 0, hours: 0, tips: 0, overtime: 0, bonus: 0, adjustments: 0, jobs: [], additional_pay: {} });
    const p = byUser.get(uid)!;
    p.additional_pay = types;
    for (const [t, amt] of Object.entries(types)) {
      if (t === "tips") p.tips = r2(p.tips + amt);
      else if (t === "overtime" || t === "overtime_pay") p.overtime = r2(p.overtime + amt);
      else if (t === "bonus") p.bonus = r2(p.bonus + amt);
      else p.adjustments = r2(p.adjustments + amt); // sick_pay, holiday_pay, adjustment, mileage, etc.
    }
  }
  for (const p of byUser.values()) p.gross = r2(p.base + p.tips + p.overtime + p.bonus + p.adjustments);
  return [...byUser.values()];
}

/** Publish (idempotent upsert) a period's snapshots. Returns the published rows. */
export async function publishPeriod(companyId: number, start: string, end: string, byUserId: number): Promise<{ published: number; total_gross: number }> {
  await ensurePayrollSnapshotSetup();
  const pay = await computePeriodPay(companyId, start, end);
  // [prune-stale 2026-06-20] Publish was upsert-only, so a tech who drops out of
  // a period between publishes (a now-excluded sandbox fixture, or a tech who
  // lost all their jobs) left an ORPHAN snapshot row behind — re-publishing the
  // May 31 week recomputed 10 techs but the phantom "Generic Cleaner" row from a
  // prior publish survived, so the locked snapshot still read 11. Delete any
  // existing rows for this (company, period) that aren't in the freshly computed
  // set BEFORE upserting, so the snapshot always reflects exactly the current
  // computation.
  const keepIds = pay.map(p => p.user_id);
  if (keepIds.length) {
    await db.execute(sql`DELETE FROM payroll_period_snapshots WHERE company_id = ${companyId} AND pay_period_start = ${start} AND pay_period_end = ${end} AND user_id <> ALL(ARRAY[${sql.raw(intList(keepIds))}]::int[])`);
  } else {
    await db.execute(sql`DELETE FROM payroll_period_snapshots WHERE company_id = ${companyId} AND pay_period_start = ${start} AND pay_period_end = ${end}`);
  }
  let total = 0;
  for (const p of pay) {
    total += p.gross;
    await db.execute(sql`
      INSERT INTO payroll_period_snapshots (company_id, pay_period_start, pay_period_end, user_id, gross, base, hours, tips, overtime, bonus, adjustments, breakdown, published_at, published_by_user_id)
      VALUES (${companyId}, ${start}, ${end}, ${p.user_id}, ${p.gross}, ${p.base}, ${p.hours}, ${p.tips}, ${p.overtime}, ${p.bonus}, ${p.adjustments}, ${JSON.stringify(p.jobs)}::jsonb, now(), ${byUserId})
      ON CONFLICT (company_id, pay_period_start, pay_period_end, user_id)
      DO UPDATE SET gross = EXCLUDED.gross, base = EXCLUDED.base, hours = EXCLUDED.hours, tips = EXCLUDED.tips,
        overtime = EXCLUDED.overtime, bonus = EXCLUDED.bonus, adjustments = EXCLUDED.adjustments,
        breakdown = EXCLUDED.breakdown, published_at = now(), published_by_user_id = EXCLUDED.published_by_user_id`);
  }
  return { published: pay.length, total_gross: r2(total) };
}

/**
 * Build the export rows for a period, ONE ENGINE end to end.
 *
 * Prefers the PUBLISHED snapshot (payroll_period_snapshots) so the export
 * matches exactly what the office locked in. When a period hasn't been
 * published yet, falls back to a LIVE computePeriodPay run (the same engine the
 * snapshot is built from and the same one GET /payroll/detail uses) so the
 * download still works — the returned `source` says which path produced it.
 */
export async function buildPeriodExportRows(
  companyId: number, start: string, end: string,
): Promise<{ source: "published" | "live"; rows: PayExportRow[] }> {
  await ensurePayrollSnapshotSetup();
  const snap = (await db.execute(sql`
    SELECT s.user_id, u.first_name, u.last_name,
           s.base, s.hours, s.tips, s.overtime, s.bonus, s.adjustments, s.gross
    FROM payroll_period_snapshots s
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.company_id = ${companyId} AND s.pay_period_start = ${start} AND s.pay_period_end = ${end}
    ORDER BY u.first_name, u.last_name`)).rows as any[];
  if (snap.length) {
    return {
      source: "published",
      rows: snap.map(r => snapshotToExportRow({
        user_id: Number(r.user_id), first_name: r.first_name ?? "", last_name: r.last_name ?? "",
        base: parseFloat(String(r.base || 0)), hours: parseFloat(String(r.hours || 0)),
        tips: parseFloat(String(r.tips || 0)), overtime: parseFloat(String(r.overtime || 0)),
        bonus: parseFloat(String(r.bonus || 0)), adjustments: parseFloat(String(r.adjustments || 0)),
        gross: parseFloat(String(r.gross || 0)),
      })),
    };
  }
  // Not published yet — compute live off the same engine.
  const pay = await computePeriodPay(companyId, start, end);
  const nameById = new Map<number, { first: string; last: string }>();
  const ids = pay.map(p => p.user_id);
  if (ids.length) {
    for (const u of (await db.execute(sql`SELECT id, first_name, last_name FROM users WHERE company_id = ${companyId} AND id = ANY(ARRAY[${sql.raw(intList(ids))}]::int[])`)).rows as any[]) {
      nameById.set(Number(u.id), { first: u.first_name ?? "", last: u.last_name ?? "" });
    }
  }
  return {
    source: "live",
    rows: pay
      .sort((a, b) => (nameById.get(a.user_id)?.first || "").localeCompare(nameById.get(b.user_id)?.first || ""))
      .map(p => snapshotToExportRow({
        user_id: p.user_id,
        first_name: nameById.get(p.user_id)?.first ?? p.name.split(" ")[0] ?? "",
        last_name: nameById.get(p.user_id)?.last ?? p.name.split(" ").slice(1).join(" ") ?? "",
        base: p.base, hours: p.hours, tips: p.tips, overtime: p.overtime, bonus: p.bonus, adjustments: p.adjustments, gross: p.gross,
      })),
  };
}
