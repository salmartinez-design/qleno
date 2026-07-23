import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/node_modules/pg/lib/index.js";
const c=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});await c.connect();
const r=(await c.query(`SELECT id,account_id,invoice_number,status,total::float total,paid_at,manually_edited_at,
  jsonb_array_length(CASE WHEN jsonb_typeof(line_items)='array' THEN line_items ELSE '[]'::jsonb END) lines
  FROM invoices WHERE account_id IN (4,6,26) AND status='paid' AND total::float>0 ORDER BY account_id,id`)).rows;
for(const i of r)console.log(`acct=${String(i.account_id).padEnd(3)} inv#${String(i.id).padEnd(5)} ${String(i.invoice_number).padEnd(24)} ${i.status.padEnd(6)} $${Number(i.total).toFixed(2).padStart(8)} lines=${i.lines} paid=${String(i.paid_at).slice(0,10)} edited=${i.manually_edited_at?'Y':'-'}`);
await c.end();
