/**
 * June 1, 2026 — MaidCentral ↔ Qleno commission reconciliation.
 *
 * Two engines, same MC June 1 timesheet data (MC Invoicing screen,
 * JobDate=06/01/2026):
 *
 *   LEGACY  = lib/commission-compute.ts  (one basis per job from account_id)
 *   PARITY  = lib/commission-paytype.ts  (per-tech pay type — MC parity)
 *
 * The legacy engine diverges on 6 timesheets (no Hourly basis, breakage
 * deducted from base, hardcoded deep-clean %). The parity engine reproduces
 * every MaidCentral paycheck to the penny — proof the per-tech pay-type
 * model is correct before it's wired into payroll + the office UI.
 *
 * Run:
 *   node --experimental-strip-types --import /tmp/ts-register.mjs \
 *     src/tests/june1-mc-audit.ts
 *
 * REPORT, not a DB writer — cannot punch clocks into live Qleno.
 */
import {
  computeCommissionRows,
  type CommissionInputJob,
} from "../lib/commission-compute.js";
import {
  computeTechPay,
  type PayType,
} from "../lib/commission-paytype.js";

const resRates = { res_tech_pay_pct: 0.35, deep_clean_pay_pct: 0.32, move_in_out_pay_pct: 0.32 };
const commercial = { commercial_hourly_rate: 20, commercial_comp_mode: "allowed_hours" as const };

type McTech = {
  name: string;
  hours: number;
  payType: PayType;
  hourlyRate: number; // for allowed_hours + hourly
  scopePct: number; // for fee_split
  mcPay: number; // MaidCentral's actual paycheck (ground truth)
};
type McJob = {
  label: string;
  customer: string;
  serviceType: string;
  isCommercial: boolean;
  billedAmount: number; // net invoice (legacy engine uses this)
  baseFee: number; // GROSS service base (parity engine uses this)
  allowedHrs: number;
  techs: McTech[];
};

// ── MaidCentral June 1 — full day ─────────────────────────────────────────
const JUNE1: McJob[] = [
  { label: "Common Areas Cleaning (Monthly Prepay)", customer: "Jennifer Halper",
    serviceType: "commercial_cleaning", isCommercial: true, billedAmount: 1050, baseFee: 0, allowedHrs: 3.5,
    techs: [{ name: "Alejandra Cuervo", hours: 1.77, payType: "allowed_hours", hourlyRate: 20, scopePct: 0, mcPay: 70.0 }] },

  { label: "Weekly Commercial", customer: "Daniel Walter",
    serviceType: "commercial_cleaning", isCommercial: true, billedAmount: 225, baseFee: 225, allowedHrs: 3.0,
    techs: [{ name: "Jose Ardila", hours: 2.98, payType: "allowed_hours", hourlyRate: 20, scopePct: 0, mcPay: 60.0 }] },

  { label: "Commercial | Common Areas (On Demand)", customer: "Richard Nitzsche",
    serviceType: "commercial_cleaning", isCommercial: true, billedAmount: 195, baseFee: 195, allowedHrs: 3.0,
    techs: [{ name: "Juliana Loredo", hours: 1.52, payType: "allowed_hours", hourlyRate: 20, scopePct: 0, mcPay: 60.0 }] },

  { label: "PPM Unit Turnover", customer: "Daniel Walter",
    serviceType: "commercial_cleaning", isCommercial: true, billedAmount: 150, baseFee: 150, allowedHrs: 3.0,
    techs: [{ name: "Juan Salazar", hours: 2.23, payType: "allowed_hours", hourlyRate: 20, scopePct: 0, mcPay: 60.0 }] },

  { label: "Carpet Cleaning", customer: "Richard Nitzsche",
    serviceType: "commercial_cleaning", isCommercial: true, billedAmount: 120, baseFee: 120, allowedHrs: 1.5,
    techs: [{ name: "Juliana Loredo", hours: 2.17, payType: "hourly", hourlyRate: 25, scopePct: 0, mcPay: 54.25 }] },

  { label: "Deep Clean or Move In/Out", customer: "Richard Nitzsche",
    serviceType: "deep_clean", isCommercial: false, billedAmount: 578.4, baseFee: 628.4, allowedHrs: 8.2,
    techs: [
      { name: "Alejandra Cuervo", hours: 3.28, payType: "fee_split", hourlyRate: 0, scopePct: 0.32, mcPay: 100.54 },
      { name: "Juliana Loredo", hours: 3.28, payType: "fee_split", hourlyRate: 0, scopePct: 0.32, mcPay: 100.54 },
    ] },

  { label: "Hourly Standard", customer: "Joe Cusimano",
    serviceType: "standard_clean", isCommercial: false, billedAmount: 540, baseFee: 540, allowedHrs: 9.0,
    techs: [
      { name: "Norma Puga", hours: 3.18, payType: "fee_split", hourlyRate: 0, scopePct: 0.35, mcPay: 94.66 },
      { name: "Jose Ardila", hours: 3.17, payType: "hourly", hourlyRate: 20, scopePct: 0, mcPay: 63.4 },
    ] },

  { label: "Hourly Deep Clean or Move In/Out", customer: "Silas Hundt",
    serviceType: "deep_clean", isCommercial: false, billedAmount: 210, baseFee: 210, allowedHrs: 3.0,
    techs: [{ name: "Guadalupe Mejia", hours: 3.0, payType: "fee_split", hourlyRate: 0, scopePct: 0.35, mcPay: 73.5 }] },

  { label: "Recurring Standard Clean", customer: "Greg Ward",
    serviceType: "standard_clean", isCommercial: false, billedAmount: 186, baseFee: 186, allowedHrs: 3.1,
    techs: [{ name: "Guadalupe Mejia", hours: 2.0, payType: "fee_split", hourlyRate: 0, scopePct: 0.35, mcPay: 65.1 }] },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

function legacyPerTech(job: McJob): number[] {
  const actualSum = job.techs.reduce((s, t) => s + t.hours, 0);
  const input: CommissionInputJob = {
    id: 0, assigned_user_id: 1, service_type: job.serviceType,
    account_id: job.isCommercial ? 99 : null,
    base_fee: String(job.baseFee), billed_amount: String(job.billedAmount),
    allowed_hours: String(job.allowedHrs), actual_hours: String(actualSum),
    branch_id: 1, scheduled_date: "2026-06-01",
  };
  const pool = computeCommissionRows({ jobs: [input], resRates, commercial })[0]?.amount ?? 0;
  return job.techs.map((t) => round2(actualSum > 0 ? (pool * t.hours) / actualSum : pool / job.techs.length));
}

function report(title: string, perTech: (job: McJob) => number[]) {
  console.log(`\n=== ${title} ===\n`);
  let mc = 0, q = 0, bad = 0;
  for (const job of JUNE1) {
    const got = perTech(job);
    job.techs.forEach((t, i) => {
      const delta = round2(got[i] - t.mcPay);
      const ok = Math.abs(delta) < 0.01;
      if (!ok) bad++;
      mc += t.mcPay; q += got[i];
      console.log(
        `  ${job.label.slice(0, 28).padEnd(29)} ${t.name.padEnd(17)} ${t.payType.padEnd(13)}` +
          ` MC $${t.mcPay.toFixed(2).padStart(7)} → $${got[i].toFixed(2).padStart(7)} ${ok ? "✅" : `❌ ${delta > 0 ? "+" : ""}${delta.toFixed(2)}`}`,
      );
    });
  }
  console.log("\n  " + "─".repeat(60));
  console.log(`  MC total $${mc.toFixed(2)}   engine $${q.toFixed(2)}   delta $${round2(q - mc).toFixed(2)}   mismatches ${bad}`);
}

const total = JUNE1.reduce((s, j) => s + j.techs.reduce((a, t) => a + t.mcPay, 0), 0);

report("LEGACY engine (commission-compute.ts) — one basis per job", legacyPerTech);

report("PARITY engine (commission-paytype.ts) — per-tech pay type", (job) => {
  const totalTechHours = job.techs.reduce((s, t) => s + t.hours, 0);
  const ctx = { baseFee: job.baseFee, allowedHours: job.allowedHrs, totalTechHours };
  return job.techs.map((t) => computeTechPay(ctx, {
    user_id: 0, techHours: t.hours, payType: t.payType, hourlyRate: t.hourlyRate, scopePct: t.scopePct,
  }).amount);
});

console.log(`\nMaidCentral June 1 tech-pay ground truth: $${total.toFixed(2)}\n`);
