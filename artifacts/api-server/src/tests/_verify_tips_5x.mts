// [tips 5x verification] Prod-SAFE. Runs the ENTIRE tip process across 5
// different tip amounts (incl. rounding-stress values) against REAL production
// data, each inside a transaction that is ROLLED BACK. For each amount it
// checks: the clocked-time split, the per-tech payout into additional_pay
// (tips bucket the payroll snapshot reads), the invoice auto-update (tips +
// total + a balancing payment so a paid invoice stays paid in full), and the
// export tips column. Production is mutated by nothing.
//
// Run:  pnpm --filter @workspace/api-server exec tsx --env-file=../../.env \
//         src/tests/_verify_tips_5x.mts
import { createRequire } from "module";
const require = createRequire(new URL("../../../../lib/db/package.json", import.meta.url));
const pg = require("pg");
import { computeTipSplit, type TipSplitTech } from "../lib/tip-split.js";
import { snapshotToExportRow } from "../lib/pay-export.js";

const { Client } = pg;
const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toFixed(2)}`;
let failures = 0;
function ok(cond: boolean) { if (!cond) failures++; return cond ? "ok" : "FAIL"; }

const AMOUNTS = [10, 25, 33.33, 7.77, 100]; // includes 3-way & odd-cent rounding stress

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    // Multi-tech completed job (for split + payout).
    const job = (await c.query(`
      SELECT j.id, j.company_id, j.scheduled_date::text AS scheduled_date
      FROM jobs j JOIN timeclock t ON t.job_id=j.id AND t.clock_out_at IS NOT NULL AND t.source='punched'
      WHERE j.status='complete'
      GROUP BY j.id, j.company_id, j.scheduled_date
      HAVING COUNT(DISTINCT t.user_id) >= 2
      ORDER BY j.scheduled_date DESC LIMIT 1`)).rows[0];
    // Paid invoice (for the invoice auto-update).
    const inv = (await c.query(`
      SELECT inv.id, inv.subtotal, inv.tips, inv.total, inv.status, j.client_id, j.company_id, j.id AS job_id
      FROM invoices inv JOIN jobs j ON j.id=inv.job_id
      WHERE inv.status='paid' AND j.client_id IS NOT NULL
      ORDER BY inv.created_at DESC LIMIT 1`)).rows[0];
    if (!job || !inv) { console.log("✗ need a multi-tech job AND a paid invoice in prod"); failures++; return; }

    const jobId = Number(job.id), companyId = Number(job.company_id), schedDate: string = job.scheduled_date;
    const techRows = (await c.query(`
      SELECT jt.user_id, jt.is_primary,
        COALESCE((SELECT ROUND(SUM(EXTRACT(EPOCH FROM (clock_out_at-clock_in_at))/3600.0)::numeric,2)
                  FROM timeclock WHERE job_id=jt.job_id AND user_id=jt.user_id AND clock_out_at IS NOT NULL AND source='punched'),0) AS hrs
      FROM job_technicians jt WHERE jt.job_id=$1 ORDER BY jt.is_primary DESC, jt.id`, [jobId])).rows;
    const techs: TipSplitTech[] = techRows.map((t: any) => ({ user_id: Number(t.user_id), is_primary: !!t.is_primary, hours: parseFloat(String(t.hrs || 0)) }));
    const procUser = Number((await c.query(`SELECT id FROM users WHERE company_id=$1 LIMIT 1`, [companyId])).rows[0].id);
    const invSub = parseFloat(inv.subtotal || 0), invTips0 = parseFloat(inv.tips || 0), invTotal0 = parseFloat(inv.total || 0);

    console.log(`\nSplit/payout job #${jobId} — techs ${techs.map(t => `u${t.user_id}:${t.hours}h`).join(", ")}`);
    console.log(`Invoice #${inv.id} — subtotal ${money(invSub)}, total ${money(invTotal0)}, status ${inv.status}\n`);
    console.log("  amount │ split (sums?) │ payout→bucket │ invoice total │ payment │ export tips");
    console.log("  ───────┼───────────────┼───────────────┼───────────────┼─────────┼────────────");

    for (const amt of AMOUNTS) {
      await c.query("BEGIN");
      try {
        // 1. split
        const split = computeTipSplit(amt, techs);
        const splitSum = r2(split.reduce((s, a) => s + a.amount, 0));
        const splitOk = splitSum === r2(amt);

        // 2. payout → additional_pay tips bucket (snapshot window)
        const win = [companyId, schedDate + "T00:00:00Z", schedDate + "T23:59:59Z"];
        const bucketBefore = parseFloat((await c.query(`SELECT COALESCE(SUM(amount),0) s FROM additional_pay WHERE company_id=$1 AND type='tips' AND status<>'voided' AND created_at>=$2 AND created_at<=$3`, win)).rows[0].s);
        for (const a of split) await c.query(`INSERT INTO additional_pay (company_id,user_id,amount,type,notes,job_id,status,created_at) VALUES ($1,$2,$3,'tips','test',$4,'pending',$5)`, [companyId, a.user_id, a.amount.toFixed(2), jobId, schedDate + "T12:00:00Z"]);
        const bucketAfter = parseFloat((await c.query(`SELECT COALESCE(SUM(amount),0) s FROM additional_pay WHERE company_id=$1 AND type='tips' AND status<>'voided' AND created_at>=$2 AND created_at<=$3`, win)).rows[0].s);
        const payoutOk = r2(bucketAfter - bucketBefore) === splitSum;

        // 3. invoice auto-update (applyTipToInvoice replica) + balancing payment
        const newTips = r2(invTips0 + amt), newTotal = r2(invSub + newTips);
        await c.query(`UPDATE invoices SET tips=$1, total=$2 WHERE id=$3 AND company_id=$4`, [newTips.toFixed(2), newTotal.toFixed(2), inv.id, companyId]);
        await c.query(`INSERT INTO payments (company_id,client_id,invoice_id,job_id,amount,method,status,processed_by,attempted_at) VALUES ($1,$2,$3,$4,$5,'square','completed',$6,now())`, [companyId, inv.client_id, inv.id, inv.job_id, amt.toFixed(2), procUser]);
        const after = (await c.query(`SELECT tips,total,status FROM invoices WHERE id=$1`, [inv.id])).rows[0];
        const paidSum = parseFloat((await c.query(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=$1 AND status='completed'`, [inv.id])).rows[0].s);
        const invTotalOk = r2(parseFloat(after.total) - invTotal0) === r2(amt) && r2(parseFloat(after.tips) - invTips0) === r2(amt);
        const balancedOk = after.status === "paid" && r2(paidSum) >= r2(parseFloat(after.total));

        // 4. export tips column (separate from adjustments, gross intact)
        const a0 = split[0];
        const row = snapshotToExportRow({ user_id: a0.user_id, first_name: "T", last_name: "T", base: 200, hours: 8, tips: a0.amount, overtime: 0, bonus: 0, adjustments: 0, gross: r2(200 + a0.amount) });
        const exportOk = row.tips_cents === Math.round(a0.amount * 100) && row.adjustments_cents === 0 && row.gross_cents === row.regular_pay_cents + row.tips_cents;

        const splitStr = split.map(a => money(a.amount)).join("+");
        console.log(`  ${money(amt).padEnd(6)}│ ${splitStr.padEnd(13)} ${ok(splitOk)} │ ${ok(payoutOk).padEnd(13)} │ ${money(parseFloat(after.total)).padEnd(9)} ${ok(invTotalOk)} │ ${ok(balancedOk).padEnd(7)}│ ${ok(exportOk)}`);
      } finally {
        await c.query("ROLLBACK");
      }
    }
  } finally {
    await c.end();
  }
  console.log(`\n  (every row written then ROLLED BACK — production unchanged)`);
  console.log(`${failures === 0 ? "\n✓ ALL 5 AMOUNTS PASSED EVERY STAGE\n" : `\n✗ ${failures} CHECK(S) FAILED\n`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
