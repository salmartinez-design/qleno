// READ-ONLY. Confirmed-duplicate classifier. Writes NOTHING.
import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/node_modules/pg/lib/index.js";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });
await c.connect();
const q = async (s,p)=>(await c.query(s,p)).rows;
const H=t=>console.log("\n"+"═".repeat(78)+"\n"+t+"\n"+"═".repeat(78));
const $=n=>"$"+Number(n||0).toFixed(2);
const LIVE=["sent","overdue","draft"];

// Consolidated documents created post-cutover.
const cons = await q(`
  SELECT i.id, i.account_id, a.account_name acct, i.invoice_number num, i.status, i.total::float total,
         i.created_at, i.paid_at, i.line_items, i.parent_invoice_id
    FROM invoices i JOIN accounts a ON a.id=i.account_id
   WHERE i.status<>'void' AND i.created_at >= '2026-07-01'
     AND jsonb_typeof(i.line_items)='array'
     AND (i.invoice_number LIKE 'ACC-%' OR i.batch_status='consolidated'
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(i.line_items) li
                      WHERE (li->>'quantity')::numeric > 1 AND (li->>'unit_price')::numeric > 0))
   ORDER BY i.account_id, i.id`);

const confirmed=[], review=[];

for (const r of cons) {
  const month = new Date(r.created_at).toISOString().slice(0,8)+"01";
  const covered = new Map(); // job_id -> reason
  for (const li of r.line_items) if (li.job_id) covered.set(li.job_id, "named in line_items");

  // Quantity gap: a line billing N visits at unit price U covers N visits of
  // that price in the period, but records at most one job_id.
  for (const li of r.line_items) {
    const qty = Number(li.quantity||1), unit = Number(li.unit_price||0);
    if (!(qty > 1) || !(unit > 0)) continue;
    const cands = await q(`
      SELECT j.id, j.scheduled_date, COALESCE(j.billed_amount,j.base_fee)::float amt
        FROM jobs j WHERE j.account_id=$1 AND j.status='complete'
         AND j.scheduled_date >= $2::date AND j.scheduled_date < ($2::date + interval '1 month')
         AND ROUND(COALESCE(j.billed_amount,j.base_fee)::numeric,2) = ROUND($3::numeric,2)
       ORDER BY j.scheduled_date`, [r.account_id, month, unit]);
    for (const v of cands.slice(0, qty)) if (!covered.has(v.id)) covered.set(v.id, `qty=${qty} × ${$(unit)} line, same price + period`);
  }

  // Lines with NO job_id and qty<=1 can't be resolved mechanically.
  const unresolvable = r.line_items.filter(li => !li.job_id && Number(li.quantity||1) <= 1 && Number(li.total||0) > 0);

  for (const [job, why] of covered) {
    const own = await q(`SELECT id, invoice_number num, status, total::float total, created_at, paid_at, sent_at
        FROM invoices WHERE job_id=$1 AND status<>'void' AND id<>$2 ORDER BY id`, [job, r.id]);
    const j = (await q(`SELECT scheduled_date, status FROM jobs WHERE id=$1`,[job]))[0];
    for (const o of own) {
      if (!LIVE.includes(o.status) || o.total <= 0) continue;
      confirmed.push({acct:r.acct, account_id:r.account_id, parent:r.id, parentNum:r.num, parentStatus:r.status,
        parentPaid:r.paid_at, job, date:String(j.scheduled_date).slice(0,10), why,
        inv:o.id, num:o.num, status:o.status, total:o.total, created:o.created_at});
    }
  }
  if (unresolvable.length) review.push({r, unresolvable});
}

// Dedup: an invoice can be flagged by more than one parent — keep the strongest
// (a PAID parent beats an unpaid one).
const best=new Map();
for (const f of confirmed) {
  const cur = best.get(f.inv);
  const rank = x => x.parentStatus==="paid" ? 2 : x.parentStatus==="superseded" ? 1 : 0;
  if (!cur || rank(f) > rank(cur)) best.set(f.inv, f);
}
const finals=[...best.values()];

H("CONFIRMED DUPLICATES — visit provably on a consolidated invoice AND on its own live invoice");
const byAcct=new Map();
for (const f of finals) (byAcct.get(f.acct) ?? byAcct.set(f.acct,[]).get(f.acct)).push(f);
let grand=0;
for (const [acct, fs] of [...byAcct].sort()) {
  const sum=fs.reduce((s,f)=>s+f.total,0); grand+=sum;
  console.log(`\n  ${acct} (acct ${fs[0].account_id})  —  ${fs.length} redundant, ${$(sum)}`);
  for (const f of fs.sort((a,b)=>a.date.localeCompare(b.date)))
    console.log(`    VOID inv#${f.inv} #${String(f.num).padEnd(6)} ${f.status.padEnd(6)} ${$(f.total).padStart(9)}  job#${String(f.job).padEnd(6)} ${f.date}\n` +
      `         created ${String(f.created).slice(0,19)}  |  KEEP #${f.parentNum} (${f.parentStatus}${f.parentPaid?", paid "+String(f.parentPaid).slice(0,10):""})\n` +
      `         coverage: ${f.why}`);
}
console.log(`\n  CONFIRMED PHANTOM TOTAL: ${$(grand)}  across ${finals.length} invoice(s)`);

H("NEEDS HUMAN REVIEW — consolidated lines with no job_id that can't be matched mechanically");
for (const {r, unresolvable} of review) {
  console.log(`\n  inv#${r.id} ${r.num} — ${r.acct} (acct ${r.account_id}) ${r.status} ${$(r.total)}  created ${String(r.created_at).slice(0,10)}`);
  for (const li of unresolvable) console.log(`     line: ${$(li.total).padStart(9)}  "${li.description}"   (no job_id)`);
  const others = await q(`SELECT id, invoice_number num, status, total::float total, job_id,
      (SELECT scheduled_date FROM jobs WHERE id=i.job_id) sd
     FROM invoices i WHERE account_id=$1 AND status IN ('sent','overdue','draft') AND total::float>0 AND id<>$2 ORDER BY id`, [r.account_id, r.id]);
  if (others.length) { console.log(`     other live invoices on this account:`);
    for (const o of others) console.log(`       #${String(o.num).padEnd(8)} ${o.status.padEnd(6)} ${$(o.total).padStart(9)} job#${o.job_id ?? "—"} ${o.sd?String(o.sd).slice(0,10):""}`); }
}

H("RECONCILIATION vs $6,942.96 OUTSTANDING (accounts, sent+overdue+draft)");
const ar = await q(`SELECT a.account_name acct, count(*)::int n, sum(i.total::float) amt
   FROM invoices i JOIN accounts a ON a.id=i.account_id
  WHERE i.status IN ('sent','overdue','draft') AND i.total::float>0 GROUP BY 1 ORDER BY amt DESC`);
const ph=new Map([...byAcct].map(([k,v])=>[k, v.reduce((s,f)=>s+f.total,0)]));
let tA=0,tP=0;
console.log("  account                                    inv    outstanding     duplicate        legit");
for (const r of ar) { const p=ph.get(r.acct)??0; tA+=Number(r.amt); tP+=p;
  console.log(`  ${r.acct.padEnd(42)}${String(r.n).padStart(3)} ${$(r.amt).padStart(14)} ${$(p).padStart(13)} ${$(Number(r.amt)-p).padStart(12)}`); }
console.log(`  ${"TOTAL".padEnd(42)}${String(ar.reduce((s,r)=>s+r.n,0)).padStart(3)} ${$(tA).padStart(14)} ${$(tP).padStart(13)} ${$(tA-tP).padStart(12)}`);
await c.end();
console.log("\nREAD-ONLY — nothing written.\n");
