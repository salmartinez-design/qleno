import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/node_modules/pg/lib/index.js";
const WRITE=/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i;
const c=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});await c.connect();
const q=async(s,p)=>{if(WRITE.test(s))throw new Error("REFUSING WRITE");return (await c.query(s,p)).rows;};
const H=t=>console.log("\n"+"═".repeat(90)+"\n"+t+"\n"+"═".repeat(90));
const m=n=>"$"+Number(n||0).toFixed(2);

H("A. EVERY KMA INVOICE SINCE 2026-07-01 (account 5) — full line detail");
const inv=await q(`SELECT id,invoice_number,status,total::float total,job_id,created_at,sent_at,paid_at,
  service_date,due_date,batch_status,parent_invoice_id,bill_to_name,manually_edited_at,line_items,po_number
  FROM invoices WHERE account_id=5 AND created_at>='2026-07-01' ORDER BY created_at`);
for(const i of inv){
  console.log(`\ninv#${String(i.id).padEnd(5)} ${String(i.invoice_number).padEnd(24)} ${i.status.padEnd(7)} ${m(i.total).padStart(9)}`+
    `  job_id=${i.job_id??"—"}  created=${String(i.created_at).slice(0,16)}  paid=${i.paid_at?String(i.paid_at).slice(0,10):"—"}`+
    `  svc=${i.service_date??"—"}  batch=${i.batch_status??"—"}  billto=${i.bill_to_name??"—"}  edited=${i.manually_edited_at?"Y":"-"}`);
  const li=Array.isArray(i.line_items)?i.line_items:[];
  for(const l of li) console.log(`      line: job_id=${String(l.job_id??"NONE").padEnd(6)} qty=${String(l.quantity??"—").padEnd(5)} unit=${m(l.unit_price)} total=${m(l.total)}  "${l.description??""}"`);
}

H("B. KMA COMPLETED VISITS SINCE 2026-06-25 — property, date, amount, invoice attachment");
const jobs=await q(`
 WITH attach AS (
   SELECT i.id inv,i.job_id job FROM invoices i WHERE i.job_id IS NOT NULL AND i.status<>'void'
   UNION
   SELECT i.id,(li->>'job_id')::int FROM invoices i, jsonb_array_elements(i.line_items) li
    WHERE i.status<>'void' AND jsonb_typeof(i.line_items)='array' AND li->>'job_id' ~ '^[0-9]+$')
 SELECT j.id,j.scheduled_date,j.status,ROUND(COALESCE(j.billed_amount,j.base_fee),2)::float amt,
        COALESCE(ap.property_name,'')||' / '||COALESCE(ap.address,'')||' '||COALESCE(ap.city,'') prop,
        COALESCE(j.address_street,'')||' '||COALESCE(j.address_city,'') jaddr,
        (SELECT string_agg(DISTINCT '#'||i2.invoice_number||'('||i2.status||')',', ')
           FROM attach a JOIN invoices i2 ON i2.id=a.inv WHERE a.job=j.id) invs
   FROM jobs j
   LEFT JOIN account_properties ap ON ap.id=j.account_property_id
  WHERE j.account_id=5 AND j.scheduled_date>='2026-06-25'
  ORDER BY j.scheduled_date,j.id`);
for(const j of jobs) console.log(`  job#${String(j.id).padEnd(6)} ${String(j.scheduled_date).slice(0,10)} ${String(j.status).padEnd(9)} ${m(j.amt).padStart(9)}  ${String(j.prop||j.jaddr).slice(0,52).padEnd(52)}  ${j.invs??"— NOT ON ANY INVOICE —"}`);

H("C. KMA PAYMENTS ON RECORD (paid invoices + any payment refs)");
const paid=await q(`SELECT id,invoice_number,status,total::float total,paid_at,payment_source,
  square_payment_id,stripe_payment_intent_id,po_number,service_date
  FROM invoices WHERE account_id=5 AND status='paid' ORDER BY paid_at DESC NULLS LAST LIMIT 40`);
for(const i of paid) console.log(`  inv#${String(i.id).padEnd(5)} ${String(i.invoice_number).padEnd(24)} ${m(i.total).padStart(9)} paid=${i.paid_at?String(i.paid_at).slice(0,10):"—"} src=${i.payment_source??"—"} sq=${i.square_payment_id??"—"} po=${i.po_number??"—"}`);
console.log(`  paid count=${paid.length}  sum=${m(paid.reduce((s,i)=>s+i.total,0))}`);

H("D. KMA OUTSTANDING NOW");
const out=await q(`SELECT id,invoice_number,status,total::float total,job_id,created_at,service_date
  FROM invoices WHERE account_id=5 AND status IN ('sent','overdue','draft') AND total::float>0 ORDER BY created_at`);
for(const i of out) console.log(`  inv#${String(i.id).padEnd(5)} ${String(i.invoice_number).padEnd(24)} ${i.status.padEnd(7)} ${m(i.total).padStart(9)} job=${i.job_id??"—"} created=${String(i.created_at).slice(0,10)} svc=${i.service_date??"—"}`);
console.log(`  TOTAL ${m(out.reduce((s,i)=>s+i.total,0))} across ${out.length}`);

H("E. SQUARE PAYMENT EVENTS mentioning KMA (read-only reconciler table)");
try{
 const sq=await q(`SELECT * FROM square_payment_events ORDER BY id DESC LIMIT 30`);
 for(const e of sq) console.log("  "+JSON.stringify(e).slice(0,300));
}catch(e){console.log("  (no square_payment_events readable: "+e.message+")");}
await c.end();
