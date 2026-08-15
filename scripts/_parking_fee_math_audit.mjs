/**
 * [time-mod-order 2026-08-15] READ-ONLY audit of commercial hourly jobs that
 * carry a Time adjustment. Writes nothing.
 *
 * Background: POST /api/jobs/:id/rate-mods recomputed the job's price BEFORE
 * growing allowed_hours, so the added time was priced against the old hours and
 * billed at $0. The drift then broke the invoice builder's reconciliation
 * check, which withheld the add-on lines — so a parking fee stopped appearing
 * on the document while still being charged inside the service line. That is
 * the "the math doesn't match, it's everytime we add a parking fee" report.
 *
 * The route is fixed going forward. This script reports jobs already stamped
 * with the wrong price, so the office can decide what to do about invoices that
 * have already gone out. It does not change anything.
 *
 * Run:
 *   node --env-file=/Users/salvadormartinez/qleno/.env scripts/_parking_fee_math_audit.mjs
 */
import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js";

const { Pool } = pg;
const money = (n) => `$${Number(n).toFixed(2)}`;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const { rows: jobs } = await pool.query(`
    SELECT j.id, j.company_id, j.billed_amount, j.allowed_hours, j.hourly_rate,
           to_char(j.scheduled_date, 'YYYY-MM-DD') AS d,
           COALESCE(a.account_name, c.first_name || ' ' || COALESCE(c.last_name, '')) AS who
      FROM jobs j
      LEFT JOIN clients c  ON c.id = j.client_id
      LEFT JOIN accounts a ON a.id = j.account_id
     WHERE (j.account_id IS NOT NULL OR c.client_type = 'commercial')
       AND COALESCE(j.manual_rate_override, false) = false
       AND j.hourly_rate::numeric > 0
       AND j.allowed_hours::numeric > 0
       AND EXISTS (SELECT 1 FROM job_rate_mods m
                    WHERE m.job_id = j.id AND m.mod_type = 'time')
     ORDER BY j.scheduled_date DESC
  `);

  let wrong = 0;
  let gapTotal = 0;
  const lines = [];

  for (const j of jobs) {
    const { rows: mods } = await pool.query(
      `SELECT mod_type, amount, minutes FROM job_rate_mods WHERE job_id = $1`, [j.id]);
    const { rows: add } = await pool.query(
      `SELECT COALESCE(SUM(subtotal), 0)::numeric AS t FROM job_add_ons WHERE job_id = $1`, [j.id]);

    const rate = Number(j.hourly_rate);
    const hrs = Number(j.allowed_hours);
    const flat = mods.filter((m) => m.mod_type === "flat").reduce((s, m) => s + Number(m.amount), 0);
    const timeAmt = mods.filter((m) => m.mod_type === "time").reduce((s, m) => s + Number(m.amount), 0);
    const timeMin = mods.filter((m) => m.mod_type === "time").reduce((s, m) => s + Number(m.minutes || 0), 0);
    const addons = Number(add[0].t);
    const stored = Number(j.billed_amount || 0);

    // recomputeJobBilledAmount's commercial formula, with allowed_hours already
    // grown by the time mods (which is what the fixed ordering guarantees).
    const correct = Math.round((rate * hrs + flat + (timeAmt - (rate * timeMin) / 60) + addons) * 100) / 100;
    const gap = Math.round((correct - stored) * 100) / 100;
    if (Math.abs(gap) < 0.01) continue;

    wrong++;
    gapTotal += gap;

    // Was the invoice ALSO missing its add-on lines? That happens when the
    // stored price no longer reconciles with labor + add-ons + mods.
    const reconciled = Math.abs(Math.round(hrs * rate * 100) / 100 + addons + flat + timeAmt - stored) < 0.011;
    const droppedAddons = !reconciled && addons > 0;

    const { rows: inv } = await pool.query(
      `SELECT id, invoice_number, status FROM invoices
        WHERE company_id = $1 AND (job_id = $2 OR line_items @> $3::jsonb)
        ORDER BY id DESC LIMIT 1`,
      [j.company_id, j.id, JSON.stringify([{ job_id: j.id }])]);
    const on = inv[0];

    lines.push(
      `  job ${String(j.id).padEnd(6)} ${j.d}  ${(j.who || "").trim().slice(0, 26).padEnd(26)}` +
      ` billed ${money(stored)} → should be ${money(correct)}  (${gap > 0 ? "under" : "over"} ${money(Math.abs(gap))})` +
      (on ? `\n         invoice ${on.invoice_number} [${on.status}]` : `\n         no invoice`) +
      (droppedAddons ? `  — add-ons (${money(addons)}) missing from the document` : ""),
    );
  }

  console.log(`commercial hourly jobs with a Time adjustment: ${jobs.length}`);
  console.log(`  priced wrong: ${wrong}`);
  console.log(`  net not billed to customers: ${money(gapTotal)}\n`);
  console.log(lines.join("\n"));
  console.log(`\nREAD-ONLY — nothing was changed.`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
