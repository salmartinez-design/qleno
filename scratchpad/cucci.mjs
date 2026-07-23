import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/node_modules/pg/lib/index.js";
const c=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});await c.connect();
const q=async s=>(await c.query(s)).rows;
console.log("— invoices carrying job 8748 (any status) —");
for(const i of await q(`SELECT id,invoice_number,status,total::float t,job_id,parent_invoice_id,paid_at,line_items FROM invoices
 WHERE job_id=8748 OR line_items @> '[{"job_id":8748}]'::jsonb ORDER BY id`)){
 console.log(`inv#${i.id} ${String(i.invoice_number).padEnd(24)} ${i.status.padEnd(11)} $${i.t.toFixed(2).padStart(8)} job_id=${i.job_id??"—"} parent=${i.parent_invoice_id??"—"} paid=${i.paid_at?String(i.paid_at).slice(0,10):"—"}`);
 for(const l of (Array.isArray(i.line_items)?i.line_items:[])) console.log(`    line job_id=${l.job_id??"NONE"} qty=${l.quantity} unit=$${l.unit_price} tot=$${l.total} "${l.description??""}"`);
}
console.log("\n— paid #7039 (inv 1093) full lines —");
for(const i of await q(`SELECT id,invoice_number,status,total::float t,job_id,line_items FROM invoices WHERE id=1093`)){
 console.log(`inv#${i.id} ${i.invoice_number} ${i.status} $${i.t} job_id=${i.job_id}`);
 for(const l of i.line_items) console.log(`    line job_id=${l.job_id??"NONE"} qty=${l.quantity} unit=$${l.unit_price} tot=$${l.total} "${l.description??""}"`);
}
console.log("\n— Cucci completed visits Jul 10-20 —");
for(const j of await q(`SELECT id,scheduled_date,status,ROUND(COALESCE(billed_amount,base_fee),2)::float amt FROM jobs
 WHERE account_id=6 AND scheduled_date BETWEEN '2026-07-10' AND '2026-07-21' ORDER BY scheduled_date,id`))
 console.log(`  job#${j.id} ${String(j.scheduled_date).slice(0,10)} ${j.status} $${j.amt}`);
await c.end();
