/**
 * [time-mod-order 2026-08-15] Repair jobs whose stored price was stamped before
 * adjustAllowedHours grew allowed_hours, so the added time billed at $0.
 *
 * Writes exactly two columns — billed_amount, commission_base — the same two the
 * app's own recomputeJobBilledAmount writes for a commercial job. Commercial pay
 * is commercial_hourly_rate x allowed_hours and reads NEITHER column, and
 * allowed_hours is not touched here, so no pay moves.
 *
 * Dry-run by default. Pass --apply to write. Backup JSON is written either way.
 */
import fs from "node:fs";
import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js";

const APPLY = process.argv.includes("--apply");
const BACKUP = process.argv[process.argv.indexOf("--backup") + 1] || "./repair-backup.json";
const money = (n) => `$${Number(n).toFixed(2)}`;

// Jobs whose already-paid invoice independently confirms the corrected price.
// 18551 is deliberately EXCLUDED: its paid invoice says $225 while the formula
// says $375, because its time mod carries $225 for 90 min at a $50/hr rate.
// That disagreement is a judgement call for the office, not a mechanical repair.
const TARGETS = [20309, 19915, 19356, 19354, 18466, 18467, 13538, 13535];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const backup = [];
const rollback = [];
let changed = 0;

for (const id of TARGETS) {
  const { rows: [j] } = await pool.query(
    `SELECT j.id, j.company_id, j.billed_amount, j.commission_base, j.allowed_hours,
            j.hourly_rate, j.base_fee, j.account_id,
            co.commercial_hourly_rate AS comm_rate,
            to_char(j.scheduled_date,'YYYY-MM-DD') AS d
       FROM jobs j LEFT JOIN companies co ON co.id = j.company_id
      WHERE j.id = $1`, [id]);
  if (!j) { console.log(`job ${id}: NOT FOUND — skipped`); continue; }

  const { rows: mods } = await pool.query(
    `SELECT mod_type, amount, minutes, affects_commission FROM job_rate_mods WHERE job_id = $1`, [id]);
  const { rows: [ad] } = await pool.query(
    `SELECT COALESCE(SUM(subtotal),0)::numeric AS t,
            COALESCE(SUM(subtotal) FILTER (WHERE affects_commission),0)::numeric AS ct
       FROM job_add_ons WHERE job_id = $1`, [id]);

  const rate = Number(j.hourly_rate), hrs = Number(j.allowed_hours);
  const flat = mods.filter(m => m.mod_type === "flat").reduce((s, m) => s + Number(m.amount), 0);
  const tAmt = mods.filter(m => m.mod_type === "time").reduce((s, m) => s + Number(m.amount), 0);
  const tMin = mods.filter(m => m.mod_type === "time").reduce((s, m) => s + Number(m.minutes || 0), 0);
  const addons = Number(ad.t);

  // recomputeJobBilledAmount's commercial branch, with allowed_hours already grown.
  const billed = Math.round((rate * hrs + flat + (tAmt - (rate * tMin) / 60) + addons) * 100) / 100;
  // commission_base mirrors the pay engine's commercial pool: the TENANT
  // commission rate x hours + only the flagged flat mods / add-ons. NOT the
  // billing rate — commRate is companies.commercial_hourly_rate ($20), the pay
  // rate. Time mods already live in allowed_hours, same as the billing branch.
  const commFlat = mods
    .filter(m => m.mod_type === "flat" && m.affects_commission)
    .reduce((s, m) => s + Number(m.amount), 0);
  const commBase = Math.round(
    (Number(j.comm_rate || 0) * hrs + commFlat + Number(ad.ct)) * 100) / 100;

  const oldBilled = Number(j.billed_amount || 0);
  const oldBase = j.commission_base == null ? null : Number(j.commission_base);
  if (Math.abs(billed - oldBilled) < 0.01 && oldBase != null && Math.abs(commBase - oldBase) < 0.01) {
    console.log(`job ${id} ${j.d}: already correct — skipped`);
    continue;
  }

  // Confirm the paid invoice agrees before writing. Never repair blind.
  const { rows: inv } = await pool.query(
    `SELECT invoice_number, status, total FROM invoices
      WHERE company_id = $1 AND (job_id = $2 OR line_items @> $3::jsonb) AND status <> 'void'
      ORDER BY id DESC LIMIT 1`,
    [j.company_id, id, JSON.stringify([{ job_id: id }])]);
  const on = inv[0];
  if (!on || Math.abs(Number(on.total) - billed) >= 0.011) {
    console.log(`job ${id} ${j.d}: invoice does NOT confirm ${money(billed)} ` +
      `(${on ? `${on.invoice_number} = ${money(on.total)}` : "no invoice"}) — SKIPPED`);
    continue;
  }

  backup.push({ id, company_id: j.company_id, billed_amount: j.billed_amount, commission_base: j.commission_base });
  rollback.push(`UPDATE jobs SET billed_amount = ${j.billed_amount}, ` +
    `commission_base = ${j.commission_base == null ? "NULL" : j.commission_base} WHERE id = ${id};`);
  changed++;

  console.log(`job ${id} ${j.d}  billed ${money(oldBilled)} -> ${money(billed)}   ` +
    `commission_base ${oldBase == null ? "NULL" : money(oldBase)} -> ${money(commBase)}   ` +
    `[invoice ${on.invoice_number} ${on.status} ${money(on.total)} confirms]`);

  if (APPLY) {
    await pool.query(
      `UPDATE jobs SET billed_amount = $1, commission_base = $2 WHERE id = $3 AND company_id = $4`,
      [billed.toFixed(2), commBase.toFixed(2), id, j.company_id]);
  }
}

fs.writeFileSync(BACKUP, JSON.stringify({ takenAt: new Date().toISOString(), rows: backup, rollback }, null, 2));
console.log(`\n${changed} job(s) ${APPLY ? "UPDATED" : "would change (DRY RUN — nothing written)"}`);
console.log(`backup + rollback SQL: ${BACKUP}`);
if (!APPLY) console.log(`re-run with --apply to write.`);
await pool.end();
