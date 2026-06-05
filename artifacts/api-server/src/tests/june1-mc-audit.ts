/**
 * June 1, 2026 — MaidCentral ↔ Qleno commission reconciliation (full day).
 *
 * Feeds the EXACT MaidCentral June 1 timesheet data (MC Invoicing screen,
 * JobDate=06/01/2026 — every job/tech) through Qleno's REAL commission
 * engine (lib/commission-compute.ts) and prints a per-tech side-by-side so
 * we can see where Qleno reproduces MC's pay and where it diverges, tagged
 * by root cause.
 *
 * Run:
 *   node --experimental-strip-types --import /tmp/ts-register.mjs \
 *     src/tests/june1-mc-audit.ts
 *
 * This is a REPORT, not a DB writer. It cannot punch clocks into live
 * Qleno (no prod access from CI/sandbox). Its job is to prove the engine
 * is wired and surface the MC↔Qleno gaps before the office enters these
 * clocks via the Time Clock portal.
 *
 * KEY FINDING: MaidCentral pays a PER-TIMESHEET pay type (Allowed Hours /
 * Fee Split / Hourly) — two techs on ONE job can be paid differently
 * (see Cusimano: Norma=Fee Split, Jose=Hourly). Qleno derives ONE basis
 * per job from account_id (commercial→hourly, residential→pool). The
 * commercial jobs match by luck (allowed-hours ≈ commercial-hourly); the
 * moment a job uses Hourly pay, mixes pay types, or a service-set carries
 * a non-default %, Qleno diverges. The per-job pay-type override is the
 * durable fix.
 */
import {
  computeCommissionRows,
  type CommissionInputJob,
} from "../lib/commission-compute.js";

const resRates = { res_tech_pay_pct: 0.35, deep_clean_pay_pct: 0.32, move_in_out_pay_pct: 0.32 };
const commercial = { commercial_hourly_rate: 20, commercial_comp_mode: "allowed_hours" as const };

type PayType = "Allowed Hours" | "Fee Split" | "Hourly";
type McTech = { name: string; hours: number; payType: PayType; mcPay: number };
type McJob = {
  label: string;
  customer: string;
  serviceType: string; // Qleno jobs.service_type slug
  isCommercial: boolean; // Qleno account_id != null
  billedAmount: number; // Qleno billed_amount (invoice TOTAL, net of credits)
  baseFee: number; // MC "Fee Split" base (gross, pre-credit)
  allowedHrs: number;
  techs: McTech[];
};

// ── MaidCentral June 1 — full day (from the Invoicing screenshots) ────────
const JUNE1: McJob[] = [
  { label: "Common Areas Cleaning (Monthly Prepay)", customer: "Jennifer Halper",
    serviceType: "commercial_cleaning", isCommercial: true, billedAmount: 1050, baseFee: 0, allowedHrs: 3.5,
    techs: [{ name: "Alejandra Cuervo", hours: 1.77, payType: "Allowed Hours", mcPay: 70.0 }] },

  { label: "Weekly Commercial", customer: "Daniel Walter",
    serviceType: "commercial_cleaning", isCommercial: true, billedAmount: 225, baseFee: 225, allowedHrs: 3.0,
    techs: [{ name: "Jose Ardila", hours: 2.98, payType: "Allowed Hours", mcPay: 60.0 }] },

  { label: "Commercial | Common Areas (On Demand)", customer: "Richard Nitzsche",
    serviceType: "commercial_cleaning", isCommercial: true, billedAmount: 195, baseFee: 195, allowedHrs: 3.0,
    techs: [{ name: "Juliana Loredo", hours: 1.52, payType: "Allowed Hours", mcPay: 60.0 }] },

  { label: "PPM Unit Turnover", customer: "Daniel Walter",
    serviceType: "commercial_cleaning", isCommercial: true, billedAmount: 150, baseFee: 150, allowedHrs: 3.0,
    techs: [{ name: "Juan Salazar", hours: 2.23, payType: "Allowed Hours", mcPay: 60.0 }] },

  { label: "Carpet Cleaning", customer: "Richard Nitzsche",
    serviceType: "commercial_cleaning", isCommercial: true, billedAmount: 120, baseFee: 120, allowedHrs: 1.5,
    techs: [{ name: "Juliana Loredo", hours: 2.17, payType: "Hourly", mcPay: 54.25 }] }, // Hourly @ $25/hr

  { label: "Deep Clean or Move In/Out", customer: "Richard Nitzsche",
    serviceType: "deep_clean", isCommercial: false, billedAmount: 578.4, baseFee: 628.4, allowedHrs: 8.2,
    techs: [
      { name: "Alejandra Cuervo", hours: 3.28, payType: "Fee Split", mcPay: 100.54 },
      { name: "Juliana Loredo", hours: 3.28, payType: "Fee Split", mcPay: 100.54 },
    ] },

  { label: "Hourly Standard", customer: "Joe Cusimano",
    serviceType: "standard_clean", isCommercial: false, billedAmount: 540, baseFee: 540, allowedHrs: 9.0,
    techs: [
      { name: "Norma Puga", hours: 3.18, payType: "Fee Split", mcPay: 94.66 },
      { name: "Jose Ardila", hours: 3.17, payType: "Hourly", mcPay: 63.4 }, // Hourly @ $20/hr — SAME job, different pay type
    ] },

  { label: "Hourly Deep Clean or Move In/Out", customer: "Silas Hundt",
    serviceType: "deep_clean", isCommercial: false, billedAmount: 210, baseFee: 210, allowedHrs: 3.0,
    techs: [{ name: "Guadalupe Mejia", hours: 3.0, payType: "Fee Split", mcPay: 73.5 }] }, // MC paid 35%, not 32%

  { label: "Recurring Standard Clean", customer: "Greg Ward",
    serviceType: "standard_clean", isCommercial: false, billedAmount: 186, baseFee: 186, allowedHrs: 3.1,
    techs: [{ name: "Guadalupe Mejia", hours: 2.0, payType: "Fee Split", mcPay: 65.1 }] },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

function rootCause(t: McTech, delta: number): string {
  if (Math.abs(delta) < 0.01) return "";
  if (t.payType === "Hourly") return "pay type = Hourly (Qleno has no Hourly basis)";
  if (t.payType === "Fee Split") return "fee-split base/% (breakage credit or per-service-set %)";
  return "?";
}

console.log("\n=== June 1, 2026 — MaidCentral vs Qleno commission (full day) ===\n");
let mcTotal = 0, qTotal = 0;
const issues: string[] = [];

for (const job of JUNE1) {
  const actualSum = job.techs.reduce((s, t) => s + t.hours, 0);
  const input: CommissionInputJob = {
    id: 0, assigned_user_id: 1, service_type: job.serviceType,
    account_id: job.isCommercial ? 99 : null,
    base_fee: String(job.baseFee), billed_amount: String(job.billedAmount),
    allowed_hours: String(job.allowedHrs), actual_hours: String(actualSum),
    branch_id: 1, scheduled_date: "2026-06-01",
  };
  const pool = computeCommissionRows({ jobs: [input], resRates, commercial })[0]?.amount ?? 0;
  const basis = job.isCommercial ? "commercial_hourly" : "residential_pool";

  console.log(`▸ ${job.label}  —  ${job.customer}   [Qleno ${basis}, pool $${pool.toFixed(2)}]`);
  for (const t of job.techs) {
    // Qleno splits the job pool by actual hours across techs.
    const q = round2(actualSum > 0 ? (pool * t.hours) / actualSum : pool / job.techs.length);
    const delta = round2(q - t.mcPay);
    const ok = Math.abs(delta) < 0.01;
    const cause = rootCause(t, delta);
    console.log(
      `    ${t.name.padEnd(18)} MC ${t.payType.padEnd(13)} $${t.mcPay.toFixed(2).padStart(7)}  →  ` +
        `Qleno $${q.toFixed(2).padStart(7)}  ${ok ? "✅" : `❌ Δ${delta > 0 ? "+" : ""}${delta.toFixed(2)}  ${cause}`}`,
    );
    mcTotal += t.mcPay; qTotal += q;
    if (!ok) issues.push(`${t.name} / ${job.label}: MC $${t.mcPay.toFixed(2)} vs Qleno $${q.toFixed(2)} (Δ${delta.toFixed(2)}) — ${cause}`);
  }
  console.log("");
}

console.log("─".repeat(72));
console.log(`MC tech-pay total:    $${mcTotal.toFixed(2)}`);
console.log(`Qleno tech-pay total: $${qTotal.toFixed(2)}`);
console.log(`Day delta:            $${round2(qTotal - mcTotal).toFixed(2)}\n`);
console.log(`${issues.length} mismatch(es):`);
for (const m of issues) console.log("  • " + m);
console.log("");
