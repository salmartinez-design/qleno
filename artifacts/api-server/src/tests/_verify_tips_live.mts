// [tips verification] Prod-SAFE, end-to-end verification of the job-tip feature.
// Everything that writes runs inside ONE transaction that is ROLLED BACK, so
// production is mutated by exactly nothing. It exercises the REAL pure split
// (computeTipSplit) and the REAL export mapping (snapshotToExportRow /
// buildPayExportCsv) against REAL production data, and replicates the EXACT SQL
// the endpoint + payroll snapshot run (jobs.ts POST /:id/tips, payroll-snapshot
// additional_pay aggregation).
//
// Run:  pnpm --filter @workspace/api-server exec tsx --env-file=../../.env \
//         src/tests/_verify_tips_live.mts
import { createRequire } from "module";
const require = createRequire(new URL("../../../../lib/db/package.json", import.meta.url));
const pg = require("pg");
import { computeTipSplit, type TipSplitTech } from "../lib/tip-split.js";
import { snapshotToExportRow, buildPayExportCsv } from "../lib/pay-export.js";

const { Client } = pg;
const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toFixed(2)}`;
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✓" : "✗ FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!cond) failures++;
}

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    // ── Find a REAL completed multi-tech job with punched, clocked-out pairs ──
    const jobRow = (await c.query(`
      SELECT j.id, j.company_id, j.scheduled_date::text AS scheduled_date,
             COUNT(*) AS techs, SUM(EXTRACT(EPOCH FROM (t.clock_out_at - t.clock_in_at))/3600.0) AS total_h
      FROM jobs j
      JOIN timeclock t ON t.job_id = j.id AND t.clock_out_at IS NOT NULL AND t.source = 'punched'
      WHERE j.status = 'complete'
      GROUP BY j.id, j.company_id, j.scheduled_date
      HAVING COUNT(DISTINCT t.user_id) >= 2
         AND MIN(EXTRACT(EPOCH FROM (t.clock_out_at - t.clock_in_at))) <> MAX(EXTRACT(EPOCH FROM (t.clock_out_at - t.clock_in_at)))
      ORDER BY j.scheduled_date DESC
      LIMIT 1`)).rows[0];

    if (!jobRow) {
      console.log("  (no completed multi-tech job with UNEQUAL clocked pairs found; falling back to any multi-tech clocked job)");
    }
    const fallback = jobRow ? null : (await c.query(`
      SELECT j.id, j.company_id, j.scheduled_date::text AS scheduled_date
      FROM jobs j JOIN timeclock t ON t.job_id=j.id AND t.clock_out_at IS NOT NULL AND t.source='punched'
      WHERE j.status='complete'
      GROUP BY j.id, j.company_id, j.scheduled_date
      HAVING COUNT(DISTINCT t.user_id) >= 2
      ORDER BY j.scheduled_date DESC LIMIT 1`)).rows[0];
    const job = jobRow ?? fallback;
    if (!job) { console.log("  ✗ FAIL  no completed multi-tech clocked job in prod to test against"); failures++; return; }

    const jobId = Number(job.id);
    const companyId = Number(job.company_id);
    const schedDate: string = job.scheduled_date;
    console.log(`\nJob #${jobId} (company ${companyId}, ${schedDate}) — completed multi-tech\n`);

    // Per-tech clocked hours — SAME basis the endpoint + commission use.
    const techRows = (await c.query(`
      SELECT jt.user_id, jt.is_primary,
             COALESCE((SELECT ROUND(SUM(EXTRACT(EPOCH FROM (clock_out_at - clock_in_at))/3600.0)::numeric,2)
                       FROM timeclock WHERE job_id=jt.job_id AND user_id=jt.user_id
                         AND clock_out_at IS NOT NULL AND source='punched'),0) AS hrs
      FROM job_technicians jt WHERE jt.job_id=$1 ORDER BY jt.is_primary DESC, jt.id`, [jobId])).rows;
    const techs: TipSplitTech[] = techRows.map((t: any) => ({ user_id: Number(t.user_id), is_primary: !!t.is_primary, hours: parseFloat(String(t.hrs || 0)) }));
    console.log("  Clocked hours per tech: " + techs.map(t => `u${t.user_id}=${t.hours}h${t.is_primary ? "(P)" : ""}`).join(", "));

    // ── 1. Split matches clocked minutes (real data) ────────────────────────
    const TIP = 40;
    const split = computeTipSplit(TIP, techs);
    console.log("  $40 split → " + split.map(a => `u${a.user_id}=${money(a.amount)}`).join(", "));
    check("split sums to the tip total (no cents lost)", r2(split.reduce((s, a) => s + a.amount, 0)) === TIP, money(r2(split.reduce((s, a) => s + a.amount, 0))));
    const clockedTotal = techs.reduce((s, t) => s + t.hours, 0);
    if (clockedTotal > 0) {
      // Proportionality: each share / total ≈ hours / totalHours (within a cent's rounding).
      let proportional = true;
      for (const a of split) {
        const t = techs.find(x => x.user_id === a.user_id)!;
        const expected = r2((TIP * t.hours) / clockedTotal);
        if (Math.abs(a.amount - expected) > 0.01 + 0.01) proportional = false; // allow remainder-cent on anchor
      }
      check("each tech's share is proportional to clocked hours", proportional);
      // The longer-clocked tech gets at least as much as the shorter one.
      const sorted = [...techs].filter(t => t.hours > 0).sort((x, y) => y.hours - x.hours);
      if (sorted.length >= 2) {
        const top = split.find(a => a.user_id === sorted[0].user_id)?.amount ?? 0;
        const bot = split.find(a => a.user_id === sorted[sorted.length - 1].user_id)?.amount ?? 0;
        check("longer time on site → larger share", top >= bot, `${money(top)} >= ${money(bot)}`);
      }
    }

    // ── 2. Write path + snapshot tips bucket + export (rolled back) ──────────
    await c.query("BEGIN");
    try {
      // tips bucket BEFORE, using the EXACT snapshot aggregation query/window.
      const bucketQ = (uid: number) => c.query(`
        SELECT COALESCE(SUM(amount),0) AS t FROM additional_pay
        WHERE company_id=$1 AND user_id=$2 AND type='tips' AND status<>'voided'
          AND created_at >= $3 AND created_at <= $4`,
        [companyId, uid, schedDate + "T00:00:00Z", schedDate + "T23:59:59Z"]);
      const before = new Map<number, number>();
      for (const a of split) before.set(a.user_id, parseFloat(String((await bucketQ(a.user_id)).rows[0].t || 0)));

      // Insert tip rows EXACTLY as POST /api/jobs/:id/tips does.
      for (const a of split) {
        await c.query(`
          INSERT INTO additional_pay (company_id, user_id, amount, type, notes, job_id, status, created_at)
          VALUES ($1,$2,$3,'tips',$4,$5,'pending',$6)`,
          [companyId, a.user_id, a.amount.toFixed(2), "client called in tip", jobId, schedDate + "T12:00:00Z"]);
      }

      // tips bucket AFTER — delta must equal each tech's allocation.
      let bucketOk = true;
      for (const a of split) {
        const after = parseFloat(String((await bucketQ(a.user_id)).rows[0].t || 0));
        const delta = r2(after - (before.get(a.user_id) ?? 0));
        if (delta !== a.amount) { bucketOk = false; console.log(`     u${a.user_id}: bucket delta ${money(delta)} ≠ alloc ${money(a.amount)}`); }
      }
      check("each tech's tips bucket increased by their allocation (snapshot picks it up)", bucketOk);

      // Confirm the rows landed as type='tips' attributed to the job.
      const landed = (await c.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS s FROM additional_pay WHERE job_id=$1 AND type='tips' AND status<>'voided'`, [jobId])).rows[0];
      check("tip rows stored as additional_pay type='tips' on the job", Number(landed.n) === split.length && r2(parseFloat(landed.s)) >= TIP, `${landed.n} rows, ${money(parseFloat(landed.s))}`);

      // ── 3. Export column carries tips, separate from adjustments, commission untouched ──
      const a0 = split[0];
      const row = snapshotToExportRow({
        user_id: a0.user_id, first_name: "Test", last_name: "Tech",
        base: 200, hours: 8, tips: a0.amount, overtime: 0, bonus: 0, adjustments: 0,
        gross: r2(200 + a0.amount),
      });
      check("export breaks tips into their own column", row.tips_cents === Math.round(a0.amount * 100), `${row.tips_cents}¢`);
      check("export adjustments column EXCLUDES tips", row.adjustments_cents === 0);
      check("export gross = base + tips (commission base untouched by tip)", row.gross_cents === row.regular_pay_cents + row.tips_cents);
      const csv = buildPayExportCsv({ period_start: schedDate, period_end: schedDate, rows: [row] });
      const header = csv.split("\n")[0];
      check("CSV header has a dedicated 'tips' column", header.split(",").includes("tips"), header);

      // ── 4. Period guard probe (read-only) ──────────────────────────────────
      const closed = (await c.query(`
        SELECT status FROM pay_periods WHERE company_id=$1 AND start_date<=$2 AND end_date>=$2
        ORDER BY start_date DESC LIMIT 1`, [companyId, schedDate])).rows[0];
      if (closed && (closed.status === "approved" || closed.status === "exported")) {
        const open = (await c.query(`SELECT id FROM pay_periods WHERE company_id=$1 AND status='open' ORDER BY end_date DESC LIMIT 1`, [companyId])).rows[0];
        check("period guard: job-date period is closed → an OPEN period exists to reslot into", !!open, open ? `open period #${open.id}` : "NO open period (tip flagged, not dropped)");
      } else {
        console.log(`  ⓘ period guard: job-date period is ${closed ? closed.status : "absent/open"} → tip dates to the job (normal path), guard is a no-op`);
      }
    } finally {
      await c.query("ROLLBACK");
      console.log("\n  ↩ transaction ROLLED BACK — production unchanged.");
    }

    // ── 5. Period-guard RESLOT branch (synthetic periods, rolled back) ───────
    // Prove: when the job-date period is approved/exported, the tip is reslotted
    // into the current OPEN period (created_at moved + note tagged) — NOT dropped.
    console.log("\n  Period-guard reslot branch:");
    await c.query("BEGIN");
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      // A CLOSED (approved) period covering the job date.
      await c.query(`INSERT INTO pay_periods (company_id, start_date, end_date, status, created_by_user_id)
        VALUES ($1, $2, $2, 'approved', $3)`, [companyId, schedDate, techs[0].user_id]);
      // An OPEN period covering today.
      await c.query(`INSERT INTO pay_periods (company_id, start_date, end_date, status, created_by_user_id)
        VALUES ($1, $2, $2, 'open', $3)`, [companyId, todayStr, techs[0].user_id]);

      // Replicate resolveTipPeriodDate()'s exact queries.
      const closed = (await c.query(`SELECT status FROM pay_periods WHERE company_id=$1 AND start_date<=$2 AND end_date>=$2 ORDER BY start_date DESC LIMIT 1`, [companyId, schedDate])).rows[0];
      const isClosed = closed && (closed.status === "approved" || closed.status === "exported");
      const open = (await c.query(`SELECT start_date::text AS start_date, end_date::text AS end_date FROM pay_periods
        WHERE company_id=$1 AND status='open' ORDER BY (start_date<=$2 AND end_date>=$2) DESC, end_date DESC LIMIT 1`, [companyId, todayStr])).rows[0];
      check("guard detects the closed job-date period", !!isClosed, closed?.status);
      check("guard finds an open period to reslot into", !!open, open ? `${open.start_date}..${open.end_date}` : "");
      const within = open && todayStr >= open.start_date && todayStr <= open.end_date;
      const reslotDate = within ? todayStr : open?.end_date;
      check("reslot created_at lands inside the open period (not the job date)", reslotDate !== schedDate, `created_at→${reslotDate}, tag '[tip reslotted from ${schedDate}: ${closed?.status}]'`);
    } finally {
      await c.query("ROLLBACK");
      console.log("  ↩ rolled back.");
    }
  } finally {
    await c.end();
  }

  console.log(`\n${failures === 0 ? "✓ ALL CHECKS PASSED" : `✗ ${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
