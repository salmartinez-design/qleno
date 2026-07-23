// READ-ONLY duplicate-invoice discovery. Writes NOTHING.
// node --env-file=.env scratchpad/dupe_invoices.mjs
import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/node_modules/pg/lib/index.js";

const SRC = (await import("node:fs")).readFileSync(new URL(import.meta.url), "utf8");
for (const n of ["fet" + "ch(", "axi" + "os", "node-fet" + "ch", "http." + "request", "https." + "request", "quickbooks", "qbo"]) {
  if (SRC.toLowerCase().includes(n.toLowerCase()) && !SRC.includes(`"${n}"`) && !n.includes("+")) {
    console.log("network/QB primitive found:", n);
  }
}
const WRITE = /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i;

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (s, p) => {
  if (WRITE.test(s)) throw new Error("REFUSING WRITE: " + s.slice(0, 120));
  return (await c.query(s, p)).rows;
};
const H = (t) => console.log("\n" + "═".repeat(78) + "\n" + t + "\n" + "═".repeat(78));
const money = (n) => "$" + Number(n || 0).toFixed(2);

// ── 1. Every (invoice, job) attachment, from BOTH carriers ──────────────────
//    a) invoices.job_id      — per-visit link
//    b) line_items[].job_id  — consolidated/bundled link
const ATTACH = `
  WITH attach AS (
    SELECT i.id inv, i.job_id job FROM invoices i WHERE i.job_id IS NOT NULL
    UNION
    SELECT i.id inv, (li->>'job_id')::int job
      FROM invoices i, jsonb_array_elements(i.line_items) li
     WHERE jsonb_typeof(i.line_items) = 'array'
       AND li->>'job_id' ~ '^[0-9]+$'
  )
  SELECT a.job, a.inv,
         i.company_id, i.account_id, i.client_id, i.invoice_number, i.status,
         i.total::float total, i.created_at, i.sent_at, i.paid_at, i.due_date,
         i.batch_status, i.parent_invoice_id, i.service_date, i.qbo_invoice_id,
         i.created_by, i.manually_edited_at,
         j.scheduled_date, j.status jstatus, j.billed_amount::float jamt,
         j.base_fee::float jbase, j.account_id jacct,
         COALESCE(ac.account_name, cl.first_name || ' ' || cl.last_name, '(no account)') owner
    FROM attach a
    JOIN invoices i ON i.id = a.inv
    JOIN jobs j ON j.id = a.job
    LEFT JOIN accounts ac ON ac.id = i.account_id
    LEFT JOIN clients  cl ON cl.id = i.client_id
   WHERE i.status <> 'void'
`;

const rows = await q(ATTACH);
const byJob = new Map();
for (const r of rows) (byJob.get(r.job) ?? byJob.set(r.job, []).get(r.job)).push(r);

const dupes = [...byJob.entries()].filter(([, v]) => new Set(v.map((x) => x.inv)).size > 1);

H("1. VISITS ATTACHED TO MORE THAN ONE NON-VOID INVOICE");
console.log(`attachments scanned: ${rows.length}   distinct visits: ${byJob.size}   multi-invoice visits: ${dupes.length}`);

// group dupes by account/owner
const perOwner = new Map();
for (const [job, invs] of dupes) {
  const key = `${invs[0].account_id ?? "cl" + invs[0].client_id}|${invs[0].owner}`;
  (perOwner.get(key) ?? perOwner.set(key, []).get(key)).push({ job, invs });
}

const LIVE = new Set(["sent", "paid", "overdue", "draft"]); // superseded = zeroed fold, not AR
let phantomTotal = 0;
const perOwnerPhantom = [];

for (const [key, items] of [...perOwner.entries()].sort()) {
  const [aid, name] = key.split("|");
  console.log(`\n──────── ${name}   (account_id=${aid})   ${items.length} duplicated visit(s)`);
  let ownerPhantom = 0;
  const phantomInvs = new Map();
  for (const { job, invs } of items.sort((a, b) => String(a.invs[0].scheduled_date).localeCompare(String(b.invs[0].scheduled_date)))) {
    const j = invs[0];
    console.log(`  visit job#${job}  ${String(j.scheduled_date).slice(0, 10)}  ${j.jstatus}  billed ${money(j.jamt ?? j.jbase)}`);
    // rank: keep paid > sent-with-sent_at > consolidated parent > oldest
    for (const i of invs.sort((a, b) => a.inv - b.inv)) {
      const carrier = i.job_id_carrier;
      console.log(
        `      inv#${i.inv}  ${String(i.invoice_number ?? "(no number)").padEnd(18)} ${i.status.padEnd(11)}` +
        ` ${money(i.total).padStart(10)}  created ${String(i.created_at).slice(0, 19)}` +
        `  sent_at=${i.sent_at ? String(i.sent_at).slice(0, 10) : "—"}  paid_at=${i.paid_at ? String(i.paid_at).slice(0, 10) : "—"}` +
        `  batch=${i.batch_status ?? "—"}  parent=${i.parent_invoice_id ?? "—"}  qbo=${i.qbo_invoice_id ?? "—"}`
      );
    }
    // Which copy is redundant? Keep the one that is paid; else keep the
    // consolidated/batch document; else keep the oldest. Everything else that
    // is still UNPAID and carries money is phantom AR.
    const live = invs.filter((i) => LIVE.has(i.status));
    const paid = live.filter((i) => i.status === "paid");
    const batch = live.filter((i) => String(i.invoice_number ?? "").startsWith("ACC-") || i.batch_status === "consolidated");
    let keep;
    if (paid.length) keep = paid[0];
    else if (batch.length) keep = batch.sort((a, b) => a.inv - b.inv)[0];
    else keep = live.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
    for (const i of live) {
      if (!keep || i.inv === keep.inv) continue;
      if (i.status === "paid") continue;                 // never void a paid invoice
      if (Number(i.total) <= 0) continue;                 // zeroed, harmless
      if (!phantomInvs.has(i.inv)) { phantomInvs.set(i.inv, i); ownerPhantom += Number(i.total); }
    }
    if (keep) console.log(`      → KEEP inv#${keep.inv} (${keep.status})`);
  }
  console.log(`  redundant UNPAID on this account: ${money(ownerPhantom)}  across ${phantomInvs.size} invoice(s)`);
  phantomTotal += ownerPhantom;
  perOwnerPhantom.push({ name, aid, amount: ownerPhantom, invoices: [...phantomInvs.values()] });
}

H("2. PHANTOM TOTAL");
for (const p of perOwnerPhantom.sort((a, b) => b.amount - a.amount)) {
  console.log(`  ${p.name.padEnd(42)} ${money(p.amount).padStart(11)}   inv: ${p.invoices.map((i) => "#" + (i.invoice_number ?? i.inv)).join(", ")}`);
}
console.log(`  ${"TOTAL redundant unpaid".padEnd(42)} ${money(phantomTotal).padStart(11)}`);

// ── 3. Reconcile against total outstanding AR ────────────────────────────────
H("3. OUTSTANDING A/R RECONCILIATION");
const ar = await q(`
  SELECT COALESCE(ac.account_name, cl.first_name || ' ' || cl.last_name, '(unassigned)') owner,
         i.account_id, count(*)::int n, sum(i.total::float) amt
    FROM invoices i
    LEFT JOIN accounts ac ON ac.id = i.account_id
    LEFT JOIN clients  cl ON cl.id = i.client_id
   WHERE i.status IN ('sent','overdue','draft') AND i.total::float > 0
   GROUP BY 1,2 ORDER BY amt DESC`);
const arTotal = ar.reduce((s, r) => s + Number(r.amt), 0);
const phantomBy = new Map(perOwnerPhantom.map((p) => [p.name, p.amount]));
console.log("  owner                                      invoices    outstanding      of which duplicate     legit");
for (const r of ar) {
  const ph = phantomBy.get(r.owner) ?? 0;
  console.log(`  ${r.owner.padEnd(42)} ${String(r.n).padStart(6)} ${money(r.amt).padStart(14)} ${money(ph).padStart(22)} ${money(Number(r.amt) - ph).padStart(11)}`);
}
console.log(`  ${"TOTAL".padEnd(42)} ${String(ar.reduce((s, r) => s + r.n, 0)).padStart(6)} ${money(arTotal).padStart(14)} ${money(phantomTotal).padStart(22)} ${money(arTotal - phantomTotal).padStart(11)}`);

// ── 4. Bill Azzarello close-up (the reported case) ──────────────────────────
H("4. ACCOUNT 26 — BILL AZZARELLO, EVERY INVOICE");
const az = await q(`
  SELECT id, invoice_number, status, total::float total, job_id, created_at, sent_at, paid_at,
         batch_status, parent_invoice_id, service_date, created_by,
         jsonb_array_length(CASE WHEN jsonb_typeof(line_items)='array' THEN line_items ELSE '[]'::jsonb END) lines
    FROM invoices WHERE account_id = 26 ORDER BY created_at`);
for (const i of az) {
  console.log(`  inv#${String(i.id).padEnd(5)} ${String(i.invoice_number ?? "—").padEnd(20)} ${i.status.padEnd(11)} ${money(i.total).padStart(10)}` +
    `  job_id=${i.job_id ?? "—"}  lines=${i.lines}  created ${String(i.created_at).slice(0, 19)}  paid=${i.paid_at ? String(i.paid_at).slice(0, 10) : "—"}  batch=${i.batch_status ?? "—"}`);
}

H("5. HOW EACH DUPLICATE PAIR WAS CREATED (carrier + creator fingerprint)");
const fp = await q(`
  WITH attach AS (
    SELECT i.id inv, i.job_id job, 'job_id'::text carrier FROM invoices i WHERE i.job_id IS NOT NULL
    UNION ALL
    SELECT i.id, (li->>'job_id')::int, 'line_items'
      FROM invoices i, jsonb_array_elements(i.line_items) li
     WHERE jsonb_typeof(i.line_items)='array' AND li->>'job_id' ~ '^[0-9]+$'
  ), dup AS (
    SELECT job FROM attach a JOIN invoices i ON i.id=a.inv AND i.status<>'void'
     GROUP BY job HAVING count(DISTINCT a.inv) > 1
  )
  SELECT a.job, a.inv, a.carrier, i.invoice_number, i.status, i.created_at,
         CASE WHEN i.invoice_number LIKE 'ACC-%-%-%' THEN 'generate-invoice separate=true'
              WHEN i.invoice_number LIKE 'ACC-%'     THEN 'POST /accounts/:id/generate-invoice (consolidate)'
              WHEN i.batch_status = 'consolidated'   THEN 'invoice-cadence period close'
              ELSE 'ensure-invoice (completion auto-issue)' END creator
    FROM attach a JOIN invoices i ON i.id=a.inv AND i.status<>'void'
    JOIN dup d ON d.job=a.job
   ORDER BY a.job, i.created_at`);
let cur = null;
for (const r of fp) {
  if (r.job !== cur) { cur = r.job; console.log(`\n  job#${r.job}`); }
  console.log(`    inv#${String(r.inv).padEnd(5)} via ${r.carrier.padEnd(11)} ${String(r.invoice_number ?? "—").padEnd(20)} ${r.status.padEnd(11)} ${String(r.created_at).slice(0, 19)}  ← ${r.creator}`);
}

await c.end();
console.log("\nREAD-ONLY — nothing was written.\n");
