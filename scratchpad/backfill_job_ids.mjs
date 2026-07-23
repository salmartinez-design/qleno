// One-time backfill: re-attach the job ids a hand-collapse dropped, on the three
// already-collapsed invoices. WRITES line_items ONLY — never amount, number,
// status, paid_at, or qbo. No QuickBooks calls.
//   MODE=dryrun  → BEGIN … ROLLBACK, prove, revert. Default.
//   MODE=commit  → snapshot + BEGIN … COMMIT + rollback script.
// node --env-file=.env scratchpad/backfill_job_ids.mjs
import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/node_modules/pg/lib/index.js";
import fs from "node:fs";

const MODE = process.env.MODE === "commit" ? "commit" : "dryrun";
const SNAP = "invoice_jobids_snapshot_20260723";

// Resolved read-only from prod: for each collapsed invoice, the visits its
// quantity actually bills — same property, same unit price, weekly cadence,
// count == quantity. See scratchpad/jobids_verify.mjs section C.
const PLAN = [
  { inv: 985,  label: "Halper    ACC-4-1783354215196  $840.00 = 4 x $210.00   prop 28, Mondays",
    jobs: [15629, 15630, 15631, 15632] },
  { inv: 1012, label: "Azzarello ACC-26-1783435800301 $761.24 = 4 x $190.31   prop 94, Tuesdays",
    jobs: [6096, 6134, 6098, 6099] },
  { inv: 1093, label: "Cucci     #7039                $520.00 = 4 x $130.00   prop 73",
    jobs: [8732, 8748, 8773, 8785] },
];
const IDS = PLAN.map((p) => p.inv);

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;
const H = (t) => console.log("\n" + "═".repeat(78) + "\n" + t + "\n" + "═".repeat(78));
const money = (n) => "$" + Number(n || 0).toFixed(2);

console.log(`MODE = ${MODE}   invoices = ${IDS.join(", ")}   (line_items only)`);

// ── 0. PRE-FLIGHT ───────────────────────────────────────────────────────────
H("0. PRE-FLIGHT — the plan, and proof each named visit is real and belongs here");
const before = await q(
  `SELECT id, invoice_number, status, total::float total, subtotal::float subtotal, account_id,
          paid_at, qbo_invoice_id, manually_edited_at, line_items
     FROM invoices WHERE id = ANY($1::int[]) ORDER BY id`, [IDS]);
if (before.length !== PLAN.length) throw new Error(`expected ${PLAN.length} invoices, found ${before.length}`);

for (const p of PLAN) {
  const inv = before.find((b) => b.id === p.inv);
  console.log(`\n  inv#${p.inv}  ${p.label}`);
  console.log(`    status=${inv.status}  total=${money(inv.total)}  paid=${inv.paid_at ? String(inv.paid_at).slice(0, 10) : "—"}  qbo=${inv.qbo_invoice_id ?? "—"}  lines=${inv.line_items.length}`);
  console.log(`    line today: ${JSON.stringify(inv.line_items[0])}`);
  if (inv.line_items.length !== 1) throw new Error(`inv#${p.inv} is not a single collapsed line — aborting`);
  const qty = Number(inv.line_items[0].quantity);
  if (qty !== p.jobs.length) throw new Error(`inv#${p.inv} quantity ${qty} != ${p.jobs.length} named jobs — aborting`);

  const jobs = await q(
    `SELECT id, scheduled_date, status, COALESCE(billed_amount, base_fee)::float amt, account_property_id, account_id
       FROM jobs WHERE id = ANY($1::int[]) ORDER BY scheduled_date`, [p.jobs]);
  if (jobs.length !== p.jobs.length) throw new Error(`inv#${p.inv}: some named jobs do not exist — aborting`);
  const unit = Number(inv.line_items[0].unit_price);
  for (const j of jobs) {
    const ok = j.account_id === inv.account_id && Math.abs(Number(j.amt) - unit) < 0.005 && j.status !== "cancelled";
    console.log(`      job#${String(j.id).padEnd(6)} ${String(j.scheduled_date).slice(0, 10)} ${String(j.status).padEnd(9)} ${money(j.amt).padStart(9)} prop=${j.account_property_id}  ${ok ? "✓" : "⛔ MISMATCH"}`);
    if (!ok) throw new Error(`job#${j.id} does not match inv#${p.inv} (account/amount/cancelled) — aborting`);
  }
  const sum = jobs.reduce((s, j) => s + Number(j.amt), 0);
  const agrees = Math.abs(sum - Number(inv.total)) < 0.005;
  console.log(`    sum of named visits ${money(sum)} vs invoice total ${money(inv.total)}  ${agrees ? "✓ ties" : "⛔ DOES NOT TIE"}`);
  if (!agrees) throw new Error(`inv#${p.inv}: named visits do not sum to the invoice total — aborting`);
}

// ── 1. SNAPSHOT ─────────────────────────────────────────────────────────────
if (MODE === "commit") {
  H("1. SNAPSHOT");
  await c.query(`CREATE TABLE IF NOT EXISTS ${SNAP} AS SELECT * FROM invoices WHERE 1=0`);
  await c.query(`DELETE FROM ${SNAP} WHERE id = ANY($1::int[])`, [IDS]);
  await c.query(`INSERT INTO ${SNAP} SELECT * FROM invoices WHERE id = ANY($1::int[])`, [IDS]);
  console.log(`  ${SNAP}: ${(await q(`SELECT count(*)::int n FROM ${SNAP}`))[0].n} full row(s) captured.`);
  fs.writeFileSync("/Users/salvadormartinez/qleno/scratchpad/rollback_job_ids.sql",
`-- Rollback for the 2026-07-23 job_ids backfill. Restores line_items only.
BEGIN;
UPDATE invoices i SET line_items = s.line_items
  FROM ${SNAP} s
 WHERE i.id = s.id AND i.id = ANY(ARRAY[${IDS.join(",")}]::int[]);
SELECT id, invoice_number, status, total, line_items FROM invoices
 WHERE id = ANY(ARRAY[${IDS.join(",")}]::int[]) ORDER BY id;
COMMIT;
`);
  console.log("  rollback script → scratchpad/rollback_job_ids.sql");
}

// ── 2. THE WRITE ────────────────────────────────────────────────────────────
H(`2. WRITE  (${MODE === "commit" ? "BEGIN … COMMIT" : "BEGIN … ROLLBACK"})`);
await c.query("BEGIN");
let committed = false;
try {
  for (const p of PLAN) {
    const [r] = await q(
      `UPDATE invoices
          SET line_items = jsonb_set(line_items, '{0,job_ids}', $2::jsonb)
        WHERE id = $1 AND jsonb_array_length(line_items) = 1
        RETURNING id, line_items`, [p.inv, JSON.stringify(p.jobs)]);
    if (!r) throw new Error(`inv#${p.inv} not updated — aborting`);
    console.log(`  inv#${p.inv} → ${JSON.stringify(r.line_items[0])}`);
  }

  // every column that matters must be byte-identical
  const after = await q(
    `SELECT id, invoice_number, status, total::float total, subtotal::float subtotal,
            paid_at, qbo_invoice_id, manually_edited_at, line_items
       FROM invoices WHERE id = ANY($1::int[]) ORDER BY id`, [IDS]);
  console.log("\n  drift check (everything except line_items must be unchanged):");
  for (const a of after) {
    const b = before.find((x) => x.id === a.id);
    const same = b.invoice_number === a.invoice_number && b.status === a.status
      && Number(b.total) === Number(a.total) && Number(b.subtotal) === Number(a.subtotal)
      && String(b.paid_at) === String(a.paid_at) && String(b.qbo_invoice_id) === String(a.qbo_invoice_id)
      && String(b.manually_edited_at) === String(a.manually_edited_at);
    console.log(`    inv#${a.id} ${String(a.invoice_number).padEnd(22)} ${a.status.padEnd(7)} ${money(a.total).padStart(9)} paid=${a.paid_at ? String(a.paid_at).slice(0, 10) : "—"}  ${same ? "✓ unchanged" : "⛔ DRIFT"}`);
    if (!same) throw new Error(`inv#${a.id} drifted outside line_items — aborting`);
    // line amounts themselves must be untouched
    const lb = b.line_items[0], la = a.line_items[0];
    if (Number(lb.total) !== Number(la.total) || Number(lb.quantity) !== Number(la.quantity)
      || Number(lb.unit_price) !== Number(la.unit_price) || lb.description !== la.description
      || Number(lb.job_id) !== Number(la.job_id)) throw new Error(`inv#${a.id} line amounts/description changed — aborting`);
  }
  console.log("  ✓ only line_items[0].job_ids was added; amounts, description and job_id identical");

  // A/R must not move at all — this writes no money
  const arQ = `SELECT count(*)::int n, COALESCE(sum(total::float),0) amt FROM invoices
                WHERE account_id IS NOT NULL AND status IN ('sent','overdue','draft') AND total::float > 0`;
  const paidQ = `SELECT count(*)::int n, COALESCE(sum(total::float),0) amt FROM invoices WHERE status='paid'`;
  const ar = (await q(arQ))[0], paid = (await q(paidQ))[0];
  console.log(`\n  account A/R:  ${ar.n} inv  ${money(ar.amt)}   (unchanged — no money written)`);
  console.log(`  PAID:         ${paid.n} inv  ${money(paid.amt)}`);

  // the payoff: those visits now read as billed
  const allJobs = PLAN.flatMap((p) => p.jobs);
  const covered = await q(
    `SELECT j.id, j.scheduled_date, j.status,
            EXISTS (SELECT 1 FROM invoices i WHERE i.status <> 'void'
                      AND (i.job_id = j.id
                        OR i.line_items @> jsonb_build_array(jsonb_build_object('job_id', j.id))
                        OR i.line_items @> jsonb_build_array(jsonb_build_object('job_ids', jsonb_build_array(j.id))))) guarded
       FROM jobs j WHERE j.id = ANY($1::int[]) ORDER BY j.scheduled_date`, [allJobs]);
  console.log("\n  post-write guard check — does the duplicate guard now see each visit as billed?");
  for (const g of covered) console.log(`    job#${String(g.id).padEnd(6)} ${String(g.scheduled_date).slice(0, 10)} ${String(g.status).padEnd(9)} ${g.guarded ? "✓ billed — cannot re-mint" : "⛔ still re-mintable"}`);
  if (covered.some((g) => !g.guarded)) throw new Error("a target visit is still unguarded — aborting");

  if (MODE === "commit") { await c.query("COMMIT"); committed = true; console.log("\n  ✅ COMMITTED"); }
  else { await c.query("ROLLBACK"); console.log("\n  ↩️  ROLLED BACK — nothing persisted. Proof only."); }
} catch (e) {
  if (!committed) await c.query("ROLLBACK");
  console.error("\n  ⛔ ABORTED:", e.message);
  await c.end();
  process.exit(1);
}

H("3. POST-STATE (fresh read, outside the transaction)");
for (const r of await q(`SELECT id, invoice_number, status, total::float t, line_items FROM invoices WHERE id = ANY($1::int[]) ORDER BY id`, [IDS]))
  console.log(`  inv#${r.id} ${String(r.invoice_number).padEnd(22)} ${r.status.padEnd(7)} ${money(r.t).padStart(9)}  job_ids=${JSON.stringify(r.line_items[0].job_ids ?? null)}`);
await c.end();
