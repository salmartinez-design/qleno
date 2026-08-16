import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireApiKey } from "../../lib/api-auth.js";
import { computePeriodPayLines } from "../../lib/period-pay.js";
import { parseDateParam, countFor, fail, companyOf, money } from "./_shared.js";

// [ai-access 2026-08-15] Payroll reads for Qleno Connect.
//
// EVERY DOLLAR HERE COMES FROM computePeriodPayLines — the same paycheck engine
// behind the payroll screens and the reports. This endpoint does not compute
// pay; it reshapes what the engine returned. Residential and commercial use
// different bases (35% of job total vs hourly × allowed hours), tiered service
// types have their own percentages, manual overrides win, and deductions come
// off the end. Re-deriving any of that here would produce numbers that disagree
// with the tenant's actual paychecks — and an assistant quoting a wrong pay
// figure to a cleaner is worse than one that can't answer.
// See CLAUDE.md "Commission engine routing".
const router = Router();

/** Mileage reimbursement that has actually been applied to pay in the window. */
async function appliedMileage(companyId: number, from: string, to: string) {
  // Only legs that reached 'applied' — computed and reviewed mileage is not
  // money yet, by design (CLAUDE.md, "No money until reviewed"). Reporting it as
  // pay would tell a tech they earned something the office has not approved.
  //
  // Sums the LEG's own amount, not the pay_adjustment's. Several legs can be
  // applied under one adjustment, so joining and summing pa.amount would count
  // that adjustment once per leg and inflate the reimbursement. The join to
  // pay_adjustments stays only as proof the leg really reached pay — the bridge
  // column is what makes every mileage dollar traceable to its leg.
  const rows = await db.execute(sql`
    SELECT ml.user_id, SUM(ml.miles) AS miles, SUM(ml.amount) AS amount
    FROM mileage_legs ml
    JOIN pay_adjustments pa ON pa.id = ml.applied_pay_adjustment_id
    WHERE ml.company_id = ${companyId}
      AND ml.status = 'applied'
      AND ml.leg_date BETWEEN ${from}::date AND ${to}::date
    GROUP BY ml.user_id
  `);
  const byUser = new Map<number, { miles: number; amount: number }>();
  for (const r of rows.rows as any[]) {
    byUser.set(Number(r.user_id), { miles: money(r.miles) ?? 0, amount: money(r.amount) ?? 0 });
  }
  return byUser;
}

function requireWindow(req: any, res: any): { from: string; to: string } | null {
  const from = parseDateParam(req.query.from);
  const to = parseDateParam(req.query.to);
  if (!from || !to) {
    fail(res, 400, "invalid_parameter", "from and to are required, as YYYY-MM-DD");
    return null;
  }
  if (from > to) { fail(res, 400, "invalid_parameter", "from is after to"); return null; }
  // A pay window is bounded work. Without a cap, "summarize payroll" over five
  // years would run the whole engine across every job the company has ever done.
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days > 366) { fail(res, 400, "invalid_parameter", "The window cannot exceed 366 days"); return null; }
  return { from, to };
}

/**
 * GET /api/v1/payroll/summary?from&to
 *
 * Dollars first, hours underneath and labeled — the house rule. Phes pays
 * commission plus mileage, not hourly, so leading with hours would invite an
 * assistant to describe a tech as earning an hourly wage they don't earn.
 */
router.get("/payroll/summary", requireApiKey("rest", "payroll:read"), async (req, res) => {
  const companyId = companyOf(req);
  const w = requireWindow(req, res);
  if (!w) return;

  const { lines } = await computePeriodPayLines(companyId, w.from, w.to);
  const mileage = await appliedMileage(companyId, w.from, w.to);

  const byUser = new Map<number, { commission: number; jobs: Set<number>; clocked: number }>();
  for (const l of lines) {
    const cur = byUser.get(l.user_id) ?? { commission: 0, jobs: new Set<number>(), clocked: 0 };
    cur.commission += l.amount;
    cur.jobs.add(l.job_id);
    cur.clocked += l.clockedHours;
    byUser.set(l.user_id, cur);
  }

  const ids = [...byUser.keys(), ...mileage.keys()];
  const uniqueIds = [...new Set(ids)];
  const names = new Map<number, string>();
  if (uniqueIds.length > 0) {
    // IN (...) with individually-bound params, never `= ANY(${jsArray})` — the
    // array form does not bind through Drizzle and throws at runtime.
    const nameRows = await db.execute(sql`
      SELECT id, TRIM(CONCAT(first_name, ' ', last_name)) AS name
      FROM users
      WHERE company_id = ${companyId}
        AND id IN (${sql.join(uniqueIds.map((i) => sql`${i}`), sql`, `)})
    `);
    for (const r of nameRows.rows as any[]) names.set(Number(r.id), String(r.name));
  }

  const employees = uniqueIds
    // A user id that appears in pay lines but not in this company's users table
    // would be a cross-tenant leak. Dropping unknown ids makes that impossible
    // to serve even if the engine ever returned one.
    .filter((id) => names.has(id))
    .map((id) => {
      const p = byUser.get(id) ?? { commission: 0, jobs: new Set<number>(), clocked: 0 };
      const m = mileage.get(id) ?? { miles: 0, amount: 0 };
      const commission = Number(p.commission.toFixed(2));
      const mileage_pay = Number(m.amount.toFixed(2));
      return {
        user_id: id,
        name: names.get(id)!,
        commission,
        mileage_pay,
        total_pay: Number((commission + mileage_pay).toFixed(2)),
        job_count: p.jobs.size,
        miles: Number(m.miles.toFixed(1)),
        // Recorded for visibility and the overtime check, not paid hourly.
        job_hours: Number(p.clocked.toFixed(2)),
      };
    })
    .sort((a, b) => b.total_pay - a.total_pay);

  const sum = (f: (e: (typeof employees)[number]) => number) =>
    Number(employees.reduce((s, e) => s + f(e), 0).toFixed(2));

  countFor(res, employees.length);
  res.json({
    from: w.from,
    to: w.to,
    totals: {
      commission: sum((e) => e.commission),
      mileage_pay: sum((e) => e.mileage_pay),
      total_pay: sum((e) => e.total_pay),
      job_hours: sum((e) => e.job_hours),
    },
    hours_note: "Hours are recorded for visibility and the overtime check. Pay is commission plus mileage reimbursement, not hourly.",
    employees,
  });
});

/**
 * GET /api/v1/payroll/employee/:id?from&to
 *
 * Job-by-job for one employee. Includes allowed vs actual hours per job, which
 * is the number the efficiency conversation actually turns on.
 */
router.get("/payroll/employee/:id", requireApiKey("rest", "payroll:read"), async (req, res) => {
  const companyId = companyOf(req);
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) { fail(res, 400, "invalid_parameter", "id must be a number"); return; }
  const w = requireWindow(req, res);
  if (!w) return;

  const who = await db.execute(sql`
    SELECT id, TRIM(CONCAT(first_name, ' ', last_name)) AS name
    FROM users WHERE id = ${userId} AND company_id = ${companyId} LIMIT 1
  `);
  const person = (who.rows as any[])[0];
  if (!person) { fail(res, 404, "not_found", "No employee with that id"); return; }

  const { lines } = await computePeriodPayLines(companyId, w.from, w.to);
  const mine = lines.filter((l) => l.user_id === userId);

  const jobIds = [...new Set(mine.map((l) => l.job_id))];
  const jobMeta = new Map<number, any>();
  if (jobIds.length > 0) {
    const jr = await db.execute(sql`
      SELECT j.id, j.scheduled_date, j.service_type, j.allowed_hours, j.actual_hours,
             COALESCE(TRIM(CONCAT(c.first_name, ' ', c.last_name)), a.account_name) AS customer
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN accounts a ON a.id = j.account_id
      WHERE j.company_id = ${companyId}
        AND j.id IN (${sql.join(jobIds.map((i) => sql`${i}`), sql`, `)})
    `);
    for (const r of jr.rows as any[]) jobMeta.set(Number(r.id), r);
  }

  const jobs = mine.map((l) => {
    const m = jobMeta.get(l.job_id) ?? {};
    return {
      job_id: l.job_id,
      date: m.scheduled_date ? String(m.scheduled_date).slice(0, 10) : null,
      customer: m.customer ?? null,
      service_type: m.service_type ?? null,
      pay: Number(l.amount.toFixed(2)),
      // The engine's own explanation of how it got there. Published verbatim so
      // an assistant can show the math instead of inventing a rationale for it.
      pay_basis: l.payBasisLabel,
      is_commercial: l.isCommercial,
      allowed_hours: money(m.allowed_hours),
      actual_hours: money(m.actual_hours),
      clocked_hours: Number(l.clockedHours.toFixed(2)),
      deduction: Number(l.deduction.toFixed(2)),
    };
  }).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

  const mileage = (await appliedMileage(companyId, w.from, w.to)).get(userId) ?? { miles: 0, amount: 0 };
  const commission = Number(jobs.reduce((s, j) => s + j.pay, 0).toFixed(2));
  const mileage_pay = Number(mileage.amount.toFixed(2));

  const allowed = jobs.reduce((s, j) => s + (j.allowed_hours ?? 0), 0);
  const clocked = jobs.reduce((s, j) => s + j.clocked_hours, 0);

  countFor(res, jobs.length);
  res.json({
    user_id: userId,
    name: person.name,
    from: w.from,
    to: w.to,
    totals: {
      commission,
      mileage_pay,
      total_pay: Number((commission + mileage_pay).toFixed(2)),
      job_count: jobs.length,
      miles: Number(mileage.miles.toFixed(1)),
      job_hours: Number(clocked.toFixed(2)),
      allowed_hours: Number(allowed.toFixed(2)),
      // ONE definition of efficiency, everywhere: allowed ÷ actual, where over
      // 100% means under budget. Any day-level ratio is a different metric and
      // is called Utilization, never this. See CLAUDE.md, Time Clock.
      efficiency_pct: clocked > 0 ? Number(((allowed / clocked) * 100).toFixed(1)) : null,
    },
    jobs,
  });
});

export default router;
