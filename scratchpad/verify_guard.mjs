import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/node_modules/pg/lib/index.js";
const WRITE=/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i;
const c=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});await c.connect();
const q=async(s,p)=>{if(WRITE.test(s))throw new Error("REFUSING WRITE");return (await c.query(s,p)).rows;};

// OLD guard: job_id carrier only.
const OLD=`SELECT id,invoice_number,status FROM invoices
 WHERE company_id=$2 AND status<>'void' AND job_id=$1 LIMIT 1`;
// NEW guard: exactly what ensure-invoice.ts now issues.
const NEW=`SELECT id,invoice_number,status FROM invoices
 WHERE company_id=$2 AND status<>'void'
   AND (job_id=$1 OR line_items @> jsonb_build_array(jsonb_build_object('job_id',$1::int)))
 ORDER BY (job_id=$1) DESC, id LIMIT 1`;

const CASES=[
 [6096,1,"Azzarello Jul 7 — NAMED in the paid batch's line_items"],
 [15629,1,"Halper Jul 6 — NAMED in the paid batch's line_items"],
 [8748,1,"Cucci Jul 14 — NAMED on paid #7039"],
 [6134,1,"Azzarello Jul 14 — billed via qty=4, NOT named (known gap)"],
 [6098,1,"Azzarello Jul 21 — billed via qty=4, NOT named (known gap)"],
 [15630,1,"Halper Jul 13 — billed via qty=4, NOT named (known gap)"],
 [15631,1,"Halper Jul 20 — billed via qty=4, NOT named (known gap)"],
 [8721,1,"KMA Jul 1 — on #966 but line has NO job_id (known gap)"],
];
console.log("Re-running the ORIGINAL bug: after the void, would completion re-mint a duplicate?\n");
console.log("job    OLD guard finds        NEW guard finds        verdict");
console.log("─".repeat(96));
for(const [job,co,label] of CASES){
  const o=(await q(OLD,[job,co]))[0], n=(await q(NEW,[job,co]))[0];
  const of_=o?`#${o.invoice_number}(${o.status})`:"— nothing —";
  const nf=n?`#${n.invoice_number}(${n.status})`:"— nothing —";
  const verdict = n ? "✅ BLOCKED (no duplicate)" : "⚠️  would still re-mint";
  console.log(`${String(job).padEnd(6)} ${of_.padEnd(22)} ${nf.padEnd(22)} ${verdict}\n       ${label}`);
}
console.log("\nControl — a normal single-billed visit must still return its own invoice (no false block):");
for(const job of [8733,8734,8766,8725]){
  const n=(await q(NEW,[job,1]))[0];
  console.log(`  job ${job} → ${n?`#${n.invoice_number}(${n.status})`:"— nothing —"}  ${n?"✓ same as before":"⛔"}`);
}
console.log("\nControl — an UNINVOICED completed visit must return nothing (guard must not over-block):");
for(const job of [9117,9128]){
  const n=(await q(NEW,[job,1]))[0];
  console.log(`  job ${job} → ${n?`#${n.invoice_number} ⛔ FALSE POSITIVE`:"— nothing — ✓ free to invoice"}`);
}
await c.end();
