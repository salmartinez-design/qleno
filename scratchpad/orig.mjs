import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/node_modules/pg/lib/index.js";
const c=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});await c.connect();
const q=async(s,p)=>(await c.query(s,p)).rows;
console.log("— consolidated parents: was the line-item shape hand-edited? —");
for (const r of await q(`SELECT id, invoice_number, status, total, created_at, manually_edited_at, created_by, service_date
   FROM invoices WHERE id IN (985,1012,1092,1093,964,966) ORDER BY id`))
  console.log(`  inv#${r.id} ${r.invoice_number} ${r.status} $${r.total} created=${String(r.created_at).slice(0,19)} manually_edited_at=${r.manually_edited_at?String(r.manually_edited_at).slice(0,19):"NULL"} by_user=${r.created_by}`);
console.log("\n— Cucci #7039 (inv 1093) line items —");
console.log(JSON.stringify((await q(`SELECT line_items FROM invoices WHERE id=1093`))[0].line_items,null,1));
console.log("\n— audit trail on the 7 candidates (if any) —");
for (const r of await q(`SELECT entity_id, action, changes, created_at FROM audit_log
   WHERE entity_type='invoice' AND entity_id = ANY('{1010,1023,1083,1089,1100,1149,1158}'::int[]) ORDER BY entity_id, created_at`))
  console.log(`  inv#${r.entity_id} ${r.action} ${String(r.created_at).slice(0,19)} ${JSON.stringify(r.changes).slice(0,120)}`);
await c.end();
