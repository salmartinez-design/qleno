import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/node_modules/pg/lib/index.js";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });
await c.connect();
const q = async (s,p)=>(await c.query(s,p)).rows;
const H=t=>console.log("\n"+"═".repeat(76)+"\n"+t+"\n"+"═".repeat(76));
const $=n=>"$"+Number(n||0).toFixed(2);

H("A. A/R SLICES");
for (const [label, where] of [
  ["sent+overdue, all",              `status IN ('sent','overdue')`],
  ["sent+overdue, ACCOUNTS only",    `status IN ('sent','overdue') AND account_id IS NOT NULL`],
  ["sent+overdue+draft, accts only", `status IN ('sent','overdue','draft') AND account_id IS NOT NULL`],
  ["sent+overdue, residential only", `status IN ('sent','overdue') AND account_id IS NULL`],
  ["sent+overdue, svc July only",    `status IN ('sent','overdue') AND COALESCE(service_date, due_date) >= '2026-07-01'`],
]) {
  const r=(await q(`SELECT count(*)::int n, sum(total::float) amt FROM invoices WHERE ${where} AND total::float>0`))[0];
  console.log(`  ${label.padEnd(34)} ${String(r.n).padStart(3)} inv  ${$(r.amt).padStart(11)}`);
}

H("B. EVERY CONSOLIDATED / BUNDLE INVOICE — what it BILLED vs what it NAMES");
const cons = await q(`
  SELECT i.id, i.account_id, a.account_name, i.invoice_number, i.status, i.total::float total,
         i.created_at, i.paid_at, i.line_items, i.service_date, i.due_date
    FROM invoices i JOIN accounts a ON a.id=i.account_id
   WHERE i.status<>'void' AND jsonb_typeof(i.line_items)='array'
     AND i.created_at >= '2026-07-01'
     AND (i.invoice_number LIKE 'ACC-%' OR i.batch_status = 'consolidated')
   ORDER BY i.account_id, i.id`);
for (const r of cons) {
  const named = r.line_items.filter(l=>l.job_id).map(l=>l.job_id);
  const qty = r.line_items.reduce((s,l)=>s+Number(l.quantity||1),0);
  console.log(`\n  inv#${r.id} ${r.invoice_number} — ${r.account_name} (acct ${r.account_id}) ${r.status} ${$(r.total)}`);
  console.log(`     billed quantity=${qty} visits, but names job_id for only ${named.length}: [${named.join(",")}]`);
  console.log(`     ⇒ ${qty-named.length} visit(s) it paid for are INVISIBLE to every job-based dedup guard`);
}

H("C. PERIOD OVERLAP — visits covered by a consolidated invoice that ALSO have their own live invoice");
// For each consolidated invoice, take the account + the service month implied by
// its line descriptions/created_at, list that account's completed visits in that
// month, and show each visit's own invoices.
const findings=[];
for (const r of cons) {
  const month = (r.line_items.map(l=>String(l.description||"").match(/(\d{4})-(\d{2})/)?.[0]).find(Boolean))
    || String(r.created_at).slice(0,10);
  const anchor = /^\d{4}-\d{2}$/.test(month) ? month+"-01" : new Date(r.created_at).toISOString().slice(0,8)+"01";
  const visits = await q(`
    SELECT j.id, j.scheduled_date, j.status, COALESCE(j.billed_amount,j.base_fee)::float amt
      FROM jobs j WHERE j.account_id=$1
       AND j.scheduled_date >= $2::date AND j.scheduled_date < ($2::date + interval '1 month')
       AND j.status='complete' AND COALESCE(j.billed_amount,j.base_fee)::float > 0
     ORDER BY j.scheduled_date`, [r.account_id, anchor]);
  const named = new Set(r.line_items.filter(l=>l.job_id).map(l=>l.job_id));
  console.log(`\n  inv#${r.id} ${r.invoice_number} ${r.status} ${$(r.total)} — covers ${anchor.slice(0,7)} for ${r.account_name}`);
  for (const v of visits) {
    const own = await q(`SELECT id, invoice_number, status, total::float total, created_at
        FROM invoices WHERE job_id=$1 AND status NOT IN ('void') ORDER BY id`, [v.id]);
    const tag = named.has(v.id) ? "NAMED" : "unnamed";
    const live = own.filter(o=>["sent","overdue","draft"].includes(o.status) && o.total>0);
    console.log(`     job#${v.id} ${String(v.scheduled_date).slice(0,10)} ${$(v.amt).padStart(9)} [${tag}]` +
      `  own invoices: ${own.length?own.map(o=>`#${o.invoice_number}/${o.status}/${$(o.total)}`).join(", "):"—"}`);
    for (const o of live) findings.push({acct:r.account_name, account_id:r.account_id, parent:r.id, parentNum:r.invoice_number,
      parentStatus:r.status, job:v.id, date:String(v.scheduled_date).slice(0,10), inv:o.id, num:o.invoice_number, status:o.status, total:o.total, created:o.created_at});
  }
}

H("D. REDUNDANT UNPAID PER-VISIT INVOICES (candidates to void)");
const byAcct=new Map();
for (const f of findings) (byAcct.get(f.acct) ?? byAcct.set(f.acct,[]).get(f.acct)).push(f);
let grand=0;
for (const [acct, fs] of [...byAcct].sort()) {
  const sum=fs.reduce((s,f)=>s+f.total,0); grand+=sum;
  console.log(`\n  ${acct}  —  ${fs.length} redundant invoice(s), ${$(sum)}`);
  for (const f of fs) console.log(`     inv#${f.inv} #${f.num} ${f.status} ${$(f.total).padStart(9)}  job#${f.job} ${f.date}` +
    `   already covered by #${f.parentNum} (${f.parentStatus})  created ${String(f.created).slice(0,19)}`);
}
console.log(`\n  GRAND TOTAL redundant unpaid: ${$(grand)}`);
await c.end();
