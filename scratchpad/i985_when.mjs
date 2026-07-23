import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/node_modules/pg/lib/index.js";
const W=/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i;
const c=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
await c.connect();
const q=async(s,p)=>{if(W.test(s))throw new Error("REFUSING WRITE");return (await c.query(s,p)).rows;};
for(const r of await q(`SELECT id, invoice_number, status, total::float total, created_at, sent_at, paid_at,
   manually_edited_at, created_by, jsonb_array_length(line_items) lines, line_items
   FROM invoices WHERE id = ANY('{985,1012,1093}'::int[]) ORDER BY id`)){
  console.log(`\ninv#${r.id} ${r.invoice_number} ${r.status} $${r.total} lines=${r.lines}`);
  console.log(`  created=${String(r.created_at).slice(0,19)}  paid=${String(r.paid_at).slice(0,19)}  edited=${r.manually_edited_at?String(r.manually_edited_at).slice(0,19):"NULL"}  by=${r.created_by}`);
  for(const li of r.line_items) console.log("   ", JSON.stringify(li));
}
// the sibling per-visit invoices that would have been folded, per account
for(const a of [4,26,6]){
  console.log(`\n---- account ${a}: all July invoices ----`);
  for(const r of await q(`SELECT id, invoice_number, status, total::float t, job_id, created_at, parent_invoice_id, batch_status
     FROM invoices WHERE account_id=$1 AND created_at >= '2026-07-01' ORDER BY id`,[a]))
    console.log(`  inv#${String(r.id).padEnd(5)} ${String(r.invoice_number).padEnd(22)} ${r.status.padEnd(11)} $${r.t}  job=${r.job_id??"—"} parent=${r.parent_invoice_id??"—"} batch=${r.batch_status??"—"} ${String(r.created_at).slice(0,19)}`);
}
await c.end();
