import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/node_modules/pg/lib/index.js";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (s,p)=> (await c.query(s,p)).rows;
const H=t=>console.log("\n=== "+t+" ===");

H("inv#1012 ACC-26 line_items (raw)");
console.log(JSON.stringify((await q(`SELECT line_items, subtotal, total, service_date, due_date FROM invoices WHERE id=1012`))[0], null, 2));

H("other single-line ACC-* consolidated invoices — do their line_items name every job?");
for (const r of await q(`SELECT id, invoice_number, total, jsonb_array_length(line_items) n, line_items
   FROM invoices WHERE invoice_number LIKE 'ACC-%' AND status<>'void' ORDER BY id`)) {
  console.log(`inv#${r.id} ${r.invoice_number} $${r.total} lines=${r.n}`);
  for (const li of r.line_items) console.log(`    job_id=${li.job_id ?? "MISSING"} qty=${li.quantity} unit=${li.unit_price} tot=${li.total} :: ${li.description}`);
}

H("account 26 — every job July onward + its invoice attachments");
for (const r of await q(`
  SELECT j.id, j.scheduled_date, j.status, j.billed_amount, j.base_fee,
    (SELECT string_agg(DISTINCT i.invoice_number||'/'||i.status,', ')
       FROM invoices i WHERE i.status<>'void' AND (i.job_id=j.id
         OR i.line_items @> jsonb_build_array(jsonb_build_object('job_id', j.id)))) invs
    FROM jobs j WHERE j.account_id=26 AND j.scheduled_date >= '2026-07-01' ORDER BY j.scheduled_date`))
  console.log(`  job#${r.id} ${String(r.scheduled_date).slice(0,10)} ${r.status.padEnd(9)} billed=${r.billed_amount ?? r.base_fee}  → ${r.invs ?? "(none)"}`);

H("A/R slices — which one equals $6,943?");
for (const [label, where] of [
  ["sent+overdue, all",              `status IN ('sent','overdue')`],
  ["sent+overdue, accounts only",    `status IN ('sent','overdue') AND account_id IS NOT NULL`],
  ["sent+overdue+draft, accts only", `status IN ('sent','overdue','draft') AND account_id IS NOT NULL`],
  ["sent+overdue, residential only", `status IN ('sent','overdue') AND account_id IS NULL`],
]) {
  const r = (await q(`SELECT count(*)::int n, sum(total::float) amt FROM invoices WHERE ${where} AND total::float>0`))[0];
  console.log(`  ${label.padEnd(34)} ${r.n} inv  $${Number(r.amt||0).toFixed(2)}`);
}
await c.end();
