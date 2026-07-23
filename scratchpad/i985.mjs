import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/node_modules/pg/lib/index.js";
const WRITE=/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i;
const c=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});await c.connect();
const q=async s=>{if(WRITE.test(s))throw new Error("REFUSING WRITE");return (await c.query(s)).rows;};
for(const id of [985,1012,1093]){
 const [i]=await q(`SELECT id,account_id,invoice_number,status,total::float t,job_id,created_at,created_by,
   batch_status,parent_invoice_id,manually_edited_at,service_date,line_items FROM invoices WHERE id=${id}`);
 console.log(`\ninv#${i.id} acct=${i.account_id} ${i.invoice_number} ${i.status} $${i.t} created=${String(i.created_at).slice(0,19)} by=${i.created_by} batch=${i.batch_status??"—"} parent=${i.parent_invoice_id??"—"} edited=${i.manually_edited_at?String(i.manually_edited_at).slice(0,19):"NULL"}`);
 for(const l of i.line_items) console.log(`   ${JSON.stringify(l)}`);
 const kids=await q(`SELECT id,invoice_number,status,total::float t,job_id FROM invoices WHERE parent_invoice_id=${id} ORDER BY id`);
 console.log(`   children(parent_invoice_id=${id}): ${kids.length?kids.map(k=>`#${k.invoice_number}/${k.status}/$${k.t}/job${k.job_id}`).join(", "):"none"}`);
}
console.log("\n— all invoices with a collapsed line (quantity>1 AND a job_id) —");
for(const r of await q(`SELECT i.id,i.account_id,i.invoice_number,i.status,i.total::float t,i.created_at,i.manually_edited_at,i.batch_status,
   (li->>'quantity')::float qty,(li->>'unit_price')::float up,li->>'job_id' jid,li->>'description' d
   FROM invoices i, jsonb_array_elements(i.line_items) li
   WHERE jsonb_typeof(i.line_items)='array' AND (li->>'quantity')::float>1 AND li->>'job_id' ~ '^[0-9]+$'
     AND i.created_at>='2026-07-01' ORDER BY i.id`))
 console.log(`  inv#${String(r.id).padEnd(5)} acct=${String(r.account_id??"—").padEnd(4)} ${String(r.invoice_number).padEnd(24)} ${r.status.padEnd(11)} $${r.t.toFixed(2).padStart(8)} qty=${r.qty} unit=$${r.up} job=${r.jid} edited=${r.manually_edited_at?"Y":"NULL"} batch=${r.batch_status??"—"}  "${(r.d||"").slice(0,44)}"`);
await c.end();
