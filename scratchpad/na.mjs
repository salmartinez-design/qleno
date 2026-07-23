import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/node_modules/pg/lib/index.js";
const c=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});await c.connect();
const q=async s=>(await c.query(s)).rows;
console.log("National Able (24) live invoices:");
for (const r of await q(`SELECT id,invoice_number,status,total,job_id,batch_status,parent_invoice_id,created_at,
    jsonb_array_length(line_items) n FROM invoices WHERE account_id=24 AND status IN ('sent','overdue','draft') AND total::float>0 ORDER BY id`))
  console.log(`  inv#${r.id} #${r.invoice_number} ${r.status} $${r.total} job=${r.job_id} lines=${r.n} batch=${r.batch_status} created=${String(r.created_at).slice(0,10)}`);
console.log("\nKMA (5) live invoices:");
for (const r of await q(`SELECT id,invoice_number,status,total,job_id,created_at FROM invoices WHERE account_id=5 AND status IN ('sent','overdue','draft') AND total::float>0 ORDER BY id`))
  console.log(`  inv#${r.id} #${r.invoice_number} ${r.status} $${r.total} job=${r.job_id} created=${String(r.created_at).slice(0,10)}`);
await c.end();
