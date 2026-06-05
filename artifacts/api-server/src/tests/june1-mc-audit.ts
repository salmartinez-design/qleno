/**
 * June 1, 2026 — MaidCentral ↔ Qleno commission reconciliation.
 *
 * Feeds the EXACT MaidCentral June 1 clock/job data (from the MC Invoicing
 * screen, JobDate=06/01/2026) through Qleno's REAL commission engine
 * (lib/commission-compute.ts) and prints a side-by-side so we can see, per
 * job/per tech, whether Qleno reproduces MC's pay — and where it diverges.
 *
 * Run:
 *   node --experimental-strip-types \
 *     --import ./../../../tmp/ts-resolve.mjs \
 *     src/tests/june1-mc-audit.ts
 * (or via the wrapper in /tmp). This is a report, not an assertion suite —
 * it imports the production engine so the numbers are what Qleno would pay.
 *
 * NOT a DB writer. It cannot punch clocks into live Qleno (no prod access
 * from CI/sandbox). Its job is to prove the engine is wired and to surface
 * the MC↔Qleno gaps before the office enters these clocks via the Time
 * Clock portal.
 */
import {
  computeCommissionRows,
  type CommissionInputJob,
} from "../lib/commission-compute.js";

// Phes config (matches companies row defaults + commission-rates.ts).
const resRates = {
  res_tech_pay_pct: 0.35,
  deep_clean_pay_pct: 0.32,
  move_in_out_pay_pct: 0.32,
};
const commercial = {
  commercial_hourly_rate: 20,
  commercial_comp_mode: "allowed_hours" as const,
};

type McTech = {
  name: string;
  clockIn: string;
  clockOut: string;
  actualHrs: number;
  payType: "Allowed Hours" | "Fee Split" | "Hourly";
  mcPay: number; // what MaidCentral actually paid this tech on this job
};

type McJob = {
  label: string;
  customer: string;
  mcJobId?: string;
  serviceType: string; // Qleno jobs.service_type slug
  isCommercial: boolean; // account_id != null on the Qleno side
  billedAmount: number; // Qleno billed_amount (invoice TOTAL, net of credits)
  baseFee: number; // MC "Fee Split" base (gross, pre-breakage)
  allowedHrs: number;
  techs: McTech[];
};

// ── MaidCentral June 1 dataset (from the four Invoicing screenshots) ──────
const JUNE1: McJob[] = [
  {
    label: "Common Areas Cleaning (Monthly Prepay)",
    customer: "Jennifer Halper — 8901 South Roberts Rd",
    mcJobId: "62011284",
    serviceType: "commercial_cleaning",
    isCommercial: true,
    billedAmount: 1050.0,
    baseFee: 0,
    allowedHrs: 3.5,
    techs: [
      { name: "Alejandra Cuervo", clockIn: "1:36 PM", clockOut: "3:22 PM", actualHrs: 1.77, payType: "Allowed Hours", mcPay: 70.0 },
    ],
  },
  {
    label: "Weekly Commercial",
    customer: "Daniel Walter",
    mcJobId: "59902865",
    serviceType: "commercial_cleaning",
    isCommercial: true, // ASSUMED commercial — needs Qleno account_id confirm
    billedAmount: 225.0,
    baseFee: 225.0,
    allowedHrs: 3.0,
    techs: [
      { name: "Jose Ardila", clockIn: "1:06 PM", clockOut: "4:05 PM", actualHrs: 2.98, payType: "Allowed Hours", mcPay: 60.0 },
    ],
  },
  {
    label: "Commercial | Common Areas (On Demand)",
    customer: "Richard Nitzsche — 338 South Oak Park Ave",
    mcJobId: "63336768",
    serviceType: "commercial_cleaning",
    isCommercial: true,
    billedAmount: 195.0,
    baseFee: 195.0,
    allowedHrs: 3.0,
    techs: [
      { name: "Juliana Loredo", clockIn: "3:51 PM", clockOut: "5:22 PM", actualHrs: 1.52, payType: "Allowed Hours", mcPay: 60.0 },
    ],
  },
  {
    label: "Deep Clean or Move In/Out",
    customer: "Richard Nitzsche — 338 South Oak Park Ave",
    mcJobId: "6660(inv)",
    serviceType: "deep_clean",
    isCommercial: false, // residential
    billedAmount: 578.4, // invoice TOTAL, AFTER -$50 breakage credit
    baseFee: 628.4, // MC "Fee Split" base, BEFORE the breakage credit
    allowedHrs: 8.2,
    techs: [
      { name: "Juliana Loredo", clockIn: "9:16 AM", clockOut: "12:33 PM", actualHrs: 3.28, payType: "Fee Split", mcPay: 100.54 },
      { name: "Alejandra Cuervo", clockIn: "9:16 AM", clockOut: "12:33 PM", actualHrs: 3.28, payType: "Fee Split", mcPay: 100.54 },
    ],
  },
];

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// Mirror the route-layer multi-tech split: post-clock-in, split the job's
// commission pool proportionally by actual minutes (equal when minutes equal).
function qlenoPerTech(jobPool: number, techs: McTech[]): number[] {
  const total = techs.reduce((s, t) => s + t.actualHrs, 0);
  if (total <= 0) return techs.map(() => round2(jobPool / techs.length));
  return techs.map((t) => round2((jobPool * t.actualHrs) / total));
}

console.log("\n=== June 1, 2026 — MaidCentral vs Qleno commission ===\n");

let mcDayTotal = 0;
let qlenoDayTotal = 0;
const mismatches: string[] = [];

for (const job of JUNE1) {
  // Build the Qleno engine input for this job (primary tech = first).
  const input: CommissionInputJob = {
    id: 0,
    assigned_user_id: 1, // placeholder — engine just needs non-null
    service_type: job.serviceType,
    account_id: job.isCommercial ? 99 : null,
    base_fee: String(job.baseFee),
    billed_amount: String(job.billedAmount),
    allowed_hours: String(job.allowedHrs),
    actual_hours: String(job.techs.reduce((s, t) => s + t.actualHrs, 0)),
    branch_id: 1,
    scheduled_date: "2026-06-01",
  };
  const rows = computeCommissionRows({ jobs: [input], resRates, commercial });
  const jobPool = rows[0]?.amount ?? 0;
  const basis = rows[0]?.basis ?? "(none)";
  const perTech = qlenoPerTech(jobPool, job.techs);

  console.log(`▸ ${job.label}  —  ${job.customer}`);
  console.log(
    `  Qleno basis: ${basis} · pool $${jobPool.toFixed(2)}` +
      (job.isCommercial
        ? ` (= $${commercial.commercial_hourly_rate}/hr × ${job.allowedHrs} allowed)`
        : ` (= billed $${job.billedAmount} × ${resRates.deep_clean_pay_pct})`),
  );
  job.techs.forEach((t, i) => {
    const q = perTech[i];
    const delta = round2(q - t.mcPay);
    const flag = Math.abs(delta) >= 0.01 ? `  ❌ Δ ${delta > 0 ? "+" : ""}${delta.toFixed(2)}` : "  ✅";
    console.log(
      `    ${t.name.padEnd(18)} MC ${t.payType.padEnd(13)} $${t.mcPay.toFixed(2).padStart(7)}` +
        `   Qleno $${q.toFixed(2).padStart(7)}${flag}`,
    );
    mcDayTotal += t.mcPay;
    qlenoDayTotal += q;
    if (Math.abs(delta) >= 0.01) {
      mismatches.push(`${t.name} / ${job.label}: MC $${t.mcPay.toFixed(2)} vs Qleno $${q.toFixed(2)} (Δ ${delta.toFixed(2)})`);
    }
  });
  console.log("");
}

console.log("─".repeat(64));
console.log(`MC tech-pay total (these jobs):    $${mcDayTotal.toFixed(2)}`);
console.log(`Qleno tech-pay total (these jobs): $${qlenoDayTotal.toFixed(2)}`);
console.log(`Day delta:                         $${round2(qlenoDayTotal - mcDayTotal).toFixed(2)}`);
console.log("");
if (mismatches.length) {
  console.log("MISMATCHES:");
  for (const m of mismatches) console.log("  • " + m);
} else {
  console.log("All matched ✅");
}
console.log("");
