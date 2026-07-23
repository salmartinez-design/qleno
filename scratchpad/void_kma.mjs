// Void the 7 confirmed duplicate invoices.
//   MODE=dryrun  → BEGIN … ROLLBACK, measure, report, revert. Default.
//   MODE=commit  → snapshot table + BEGIN … COMMIT + rollback script emitted.
// node --env-file=.env scratchpad/void_dupes.mjs
// NO QuickBooks calls. Only invoices.status is written — never number, amount,
// line_items, or any paid invoice.
import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/node_modules/pg/lib/index.js";
import fs from "node:fs";

const MODE = process.env.MODE === "commit" ? "commit" : "dryrun";
const TARGETS = [964, 966];
const SNAP = "invoice_void_snapshot_kma_20260722";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;
const H = (t) => console.log("\n" + "═".repeat(78) + "\n" + t + "\n" + "═".repeat(78));
const money = (n) => "$" + Number(n || 0).toFixed(2);

console.log(`MODE = ${MODE}   targets = ${TARGETS.join(", ")}`);

// ── PRE-FLIGHT SAFETY ASSERTIONS ────────────────────────────────────────────
H("0. PRE-FLIGHT — refuse if any target is paid, zero, or already void");
const pre = await q(
  `SELECT id, invoice_number, status, total::float total, job_id, account_id,
          paid_at, sent_at, qbo_invoice_id, stripe_payment_intent_id, square_payment_id,
          refunded_amount, created_at
     FROM invoices WHERE id = ANY($1::int[]) ORDER BY id`, [TARGETS]);

if (pre.length !== TARGETS.length) throw new Error(`expected ${TARGETS.length} invoices, found ${pre.length}`);
for (const i of pre) {
  const flags = [];
  if (i.status === "paid") flags.push("PAID");
  if (i.paid_at) flags.push("HAS paid_at");
  if (i.status === "void") flags.push("ALREADY VOID");
  if (Number(i.total) <= 0) flags.push("ZERO TOTAL");
  if (i.stripe_payment_intent_id) flags.push("STRIPE PI");
  if (i.square_payment_id) flags.push("SQUARE PAYMENT");
  if (i.refunded_amount) flags.push("REFUNDED");
  console.log(`  inv#${String(i.id).padEnd(5)} ${String(i.invoice_number).padEnd(8)} ${i.status.padEnd(7)}` +
    ` ${money(i.total).padStart(9)}  job=${i.job_id ?? "—"}  acct=${i.account_id ?? "—"}` +
    `  qbo=${i.qbo_invoice_id ?? "—"}  ${flags.length ? "⛔ " + flags.join(", ") : "✓ safe to void"}`);
  if (flags.length) throw new Error(`REFUSING: inv#${i.id} is not a safe void target (${flags.join(", ")})`);
}
const targetSum = pre.reduce((s, i) => s + Number(i.total), 0);
console.log(`  all ${pre.length} clear. combined total ${money(targetSum)}`);

// ── The keeper invoices must still be PAID and untouched afterwards ─────────
const KEEPERS = [967, 1006, 1028, 1151, 1166, 1167, 1168]; // the nine per-property KMA docs that must survive
const keepBefore = await q(
  `SELECT id, invoice_number, status, total::float total, paid_at
     FROM invoices WHERE id = ANY($1::int[]) ORDER BY id`, [KEEPERS]);
console.log("\n  keepers (must be untouched):");
for (const k of keepBefore) console.log(`    inv#${k.id} ${String(k.invoice_number).padEnd(22)} ${k.status.padEnd(7)} ${money(k.total).padStart(9)} paid=${k.paid_at ? String(k.paid_at).slice(0, 10) : "—"}`);

const arQ = `SELECT count(*)::int n, COALESCE(sum(total::float),0) amt FROM invoices
              WHERE account_id IS NOT NULL AND status IN ('sent','overdue','draft') AND total::float > 0`;
const kmaQ = `SELECT count(*)::int n, COALESCE(sum(total::float),0) amt FROM invoices
              WHERE account_id = 5 AND status IN ('sent','overdue','draft') AND total::float > 0`;
const arBefore = (await q(arQ))[0];
const kmaBefore = (await q(kmaQ))[0];
console.log(`\n  KMA outstanding before: ${kmaBefore.n} invoices, ${money(kmaBefore.amt)}`);

// KMA must end the run with ZERO paid invoices added — July service stays unpaid.
const kmaPaidQ = `SELECT count(*)::int n, COALESCE(sum(total::float),0) amt FROM invoices WHERE account_id = 5 AND status = 'paid'`;
const kmaPaidBefore = (await q(kmaPaidQ))[0];
console.log(`  KMA paid before:        ${kmaPaidBefore.n} invoices, ${money(kmaPaidBefore.amt)}  (must not change)`);

// ── SNAPSHOT (commit mode only) ─────────────────────────────────────────────
if (MODE === "commit") {
  H("1. SNAPSHOT");
  await c.query(`CREATE TABLE IF NOT EXISTS ${SNAP} AS SELECT * FROM invoices WHERE 1=0`);
  await c.query(`DELETE FROM ${SNAP} WHERE id = ANY($1::int[])`, [TARGETS]);
  await c.query(`INSERT INTO ${SNAP} SELECT * FROM invoices WHERE id = ANY($1::int[])`, [TARGETS]);
  const n = (await q(`SELECT count(*)::int n FROM ${SNAP}`))[0].n;
  console.log(`  ${SNAP}: ${n} full row(s) captured (every column, pre-write).`);

  const rb = `-- Rollback for the 2026-07-22 KMA batch-duplicate void.
-- Restores status (and nothing else — nothing else was written).
BEGIN;
UPDATE invoices i SET status = s.status
  FROM ${SNAP} s
 WHERE i.id = s.id AND i.id = ANY(ARRAY[${TARGETS.join(",")}]::int[]);
-- verify: expect 7 rows back at 'sent'
SELECT id, invoice_number, status, total FROM invoices
 WHERE id = ANY(ARRAY[${TARGETS.join(",")}]::int[]) ORDER BY id;
COMMIT;
`;
  fs.writeFileSync("/Users/salvadormartinez/qleno/scratchpad/rollback_void_kma.sql", rb);
  console.log("  rollback script → scratchpad/rollback_void_kma.sql");
}

// ── THE WRITE ───────────────────────────────────────────────────────────────
H(`2. WRITE  (${MODE === "commit" ? "BEGIN … COMMIT" : "BEGIN … ROLLBACK"})`);
await c.query("BEGIN");
let committed = false;
try {
  const upd = await q(
    `UPDATE invoices SET status = 'void'
      WHERE id = ANY($1::int[])
        AND status = 'sent' AND paid_at IS NULL AND total::float > 0
      RETURNING id, invoice_number, status, total::float total`, [TARGETS]);
  console.log(`  rows voided: ${upd.length}`);
  for (const u of upd) console.log(`    inv#${String(u.id).padEnd(5)} ${String(u.invoice_number).padEnd(8)} → ${u.status}  ${money(u.total)}`);
  if (upd.length !== TARGETS.length) throw new Error(`expected ${TARGETS.length} updates, got ${upd.length} — aborting`);

  // in-transaction verification
  const keepAfter = await q(
    `SELECT id, invoice_number, status, total::float total, paid_at
       FROM invoices WHERE id = ANY($1::int[]) ORDER BY id`, [KEEPERS]);
  console.log("\n  keepers after write:");
  for (const k of keepAfter) {
    const b = keepBefore.find((x) => x.id === k.id);
    const same = b.status === k.status && Number(b.total) === Number(k.total) && String(b.paid_at) === String(k.paid_at);
    console.log(`    inv#${k.id} ${String(k.invoice_number).padEnd(22)} ${k.status.padEnd(7)} ${money(k.total).padStart(9)}  ${same ? "✓ unchanged" : "⛔ CHANGED"}`);
    if (!same) throw new Error(`keeper inv#${k.id} changed — aborting`);
  }

  // nothing but status moved on the targets
  const drift = await q(
    `SELECT s.id FROM ${MODE === "commit" ? SNAP : "invoices"} s JOIN invoices i ON i.id = s.id
      WHERE s.id = ANY($1::int[]) AND (i.invoice_number IS DISTINCT FROM s.invoice_number
         OR i.total IS DISTINCT FROM s.total OR i.line_items IS DISTINCT FROM s.line_items
         OR i.paid_at IS DISTINCT FROM s.paid_at OR i.qbo_invoice_id IS DISTINCT FROM s.qbo_invoice_id)`,
    [TARGETS]);
  console.log(`\n  number/amount/line_items/paid_at/qbo drift on targets: ${drift.length} row(s) ${drift.length ? "⛔" : "✓ none"}`);
  if (drift.length) throw new Error("unexpected column drift — aborting");

  const arAfter = (await q(arQ))[0];
  console.log(`\n  account A/R  before: ${arBefore.n} inv  ${money(arBefore.amt)}`);
  console.log(`  account A/R   after: ${arAfter.n} inv  ${money(arAfter.amt)}`);
  console.log(`  delta:              -${arAfter.n - arBefore.n === 0 ? 0 : arBefore.n - arAfter.n} inv  -${money(arBefore.amt - arAfter.amt)}`);
  if (Math.abs((arBefore.amt - arAfter.amt) - targetSum) > 0.005) throw new Error("A/R delta != target sum — aborting");

  // paid/income must not move at all
  const paidQ = `SELECT count(*)::int n, COALESCE(sum(total::float),0) amt FROM invoices WHERE status='paid'`;
  const paidAfter = (await q(paidQ))[0];
  console.log(`  PAID invoices after: ${paidAfter.n} / ${money(paidAfter.amt)}  (income untouched)`);

  const kmaAfter = (await q(kmaQ))[0];
  const kmaPaidAfter = (await q(kmaPaidQ))[0];
  console.log(`\n  KMA outstanding  ${kmaBefore.n} inv ${money(kmaBefore.amt)}  →  ${kmaAfter.n} inv ${money(kmaAfter.amt)}`);
  console.log(`  KMA paid         ${kmaPaidBefore.n} inv ${money(kmaPaidBefore.amt)}  →  ${kmaPaidAfter.n} inv ${money(kmaPaidAfter.amt)}` +
    `  ${kmaPaidBefore.n === kmaPaidAfter.n && Math.abs(kmaPaidBefore.amt - kmaPaidAfter.amt) < 0.005 ? "✓ nothing marked paid" : "⛔ CHANGED"}`);
  if (kmaPaidBefore.n !== kmaPaidAfter.n) throw new Error("KMA paid set changed — aborting");
  if (Math.abs(kmaAfter.amt - 1325) > 0.005) throw new Error(`KMA outstanding is ${money(kmaAfter.amt)}, expected $1325.00 — aborting`);
  console.log(`  ✓ KMA lands on the expected $1,325.00 = one document per real July visit`);

  const survivors = await q(`SELECT id, invoice_number, status, total::float total FROM invoices
     WHERE account_id = 5 AND status IN ('sent','overdue','draft') AND total::float > 0 ORDER BY created_at`);
  console.log("\n  KMA surviving documents:");
  for (const s of survivors) console.log(`    inv#${String(s.id).padEnd(5)} ${String(s.invoice_number).padEnd(24)} ${s.status.padEnd(7)} ${money(s.total).padStart(9)}`);

  if (MODE === "commit") { await c.query("COMMIT"); committed = true; console.log("\n  ✅ COMMITTED"); }
  else { await c.query("ROLLBACK"); console.log("\n  ↩️  ROLLED BACK — nothing persisted. Proof only."); }
} catch (e) {
  if (!committed) await c.query("ROLLBACK");
  console.error("\n  ⛔ ABORTED:", e.message);
  await c.end();
  process.exit(1);
}

// ── POST-STATE ──────────────────────────────────────────────────────────────
H("3. POST-STATE (fresh read, outside the transaction)");
const post = await q(`SELECT id, invoice_number, status, total::float total FROM invoices WHERE id = ANY($1::int[]) ORDER BY id`, [TARGETS]);
for (const i of post) console.log(`  inv#${String(i.id).padEnd(5)} ${String(i.invoice_number).padEnd(8)} ${i.status.padEnd(7)} ${money(i.total).padStart(9)}`);
const arNow = (await q(arQ))[0];
console.log(`\n  account A/R now: ${arNow.n} invoices, ${money(arNow.amt)}`);

await c.end();
