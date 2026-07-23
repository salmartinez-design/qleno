// READ-ONLY. Verifies the new jsonb containment shape + resolves the (ii)
// backfill candidate job lists. Writes nothing.
import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/node_modules/pg/lib/index.js";
const W = /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i;
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (s, p) => { if (W.test(s)) throw new Error("REFUSING WRITE: " + s.slice(0, 80)); return (await c.query(s, p)).rows; };
const H = (t) => console.log("\n" + "═".repeat(76) + "\n" + t + "\n" + "═".repeat(76));

H("A. jsonb `@>` nested-array semantics (the new predicate)");
for (const [lhs, rhs, expect] of [
  [`'[{"job_id":5,"job_ids":[5,6,7]}]'`, `jsonb_build_array(jsonb_build_object('job_ids', jsonb_build_array(6)))`, true],
  [`'[{"job_id":5,"job_ids":[5,6,7]}]'`, `jsonb_build_array(jsonb_build_object('job_ids', jsonb_build_array(9)))`, false],
  [`'[{"job_id":5}]'`, `jsonb_build_array(jsonb_build_object('job_ids', jsonb_build_array(5)))`, false],
  [`'[{"job_id":5,"job_ids":[5,6]}]'`, `jsonb_build_array(jsonb_build_object('job_id', 5))`, true],
]) {
  const r = (await q(`SELECT ${lhs}::jsonb @> ${rhs} AS hit`))[0].hit;
  console.log(`  ${r === expect ? "✓" : "⛔"} ${lhs} @> …${rhs.slice(30, 70)} → ${r} (expected ${expect})`);
}

H("B. new predicate over LIVE data — additive only, must not change any answer today");
const cmp = await q(`
  SELECT count(*) FILTER (WHERE old_hit) old_n, count(*) FILTER (WHERE new_hit) new_n,
         count(*) FILTER (WHERE old_hit <> new_hit) diff
    FROM (SELECT i.id,
            i.line_items @> jsonb_build_array(jsonb_build_object('job_id', j.id)) old_hit,
            (i.line_items @> jsonb_build_array(jsonb_build_object('job_id', j.id))
              OR i.line_items @> jsonb_build_array(jsonb_build_object('job_ids', jsonb_build_array(j.id)))) new_hit
          FROM invoices i, jobs j
         WHERE i.status <> 'void' AND j.company_id = i.company_id
           AND j.scheduled_date >= '2026-07-01') t`);
console.log(`  old matches ${cmp[0].old_n}, new matches ${cmp[0].new_n}, divergence ${cmp[0].diff}  (expect 0 — no job_ids exist yet)`);

H("C. (ii) BACKFILL CANDIDATES — which visits each collapsed invoice actually bills");
for (const [inv, acct, unit, label] of [[985, 4, 210, "Halper"], [1012, 26, 190.31, "Azzarello"], [1093, 6, 130, "Cucci"]]) {
  const i = (await q(`SELECT invoice_number, total::float t, created_at, service_date, line_items FROM invoices WHERE id=$1`, [inv]))[0];
  const named = i.line_items.flatMap((l) => (l.job_id ? [l.job_id] : []));
  console.log(`\n  inv#${inv} ${label}  ${i.invoice_number}  $${i.t}  — collapsed line names ONLY job ${named.join(",")}`);
  const jobs = await q(`
    SELECT j.id, j.scheduled_date, j.status, COALESCE(j.billed_amount, j.base_fee)::float amt,
           j.account_property_id,
           (SELECT string_agg(x.id::text || ':' || x.status, ',') FROM invoices x WHERE x.job_id = j.id) inv_links
      FROM jobs j
     WHERE j.account_id = $1 AND j.scheduled_date >= '2026-07-01' AND j.scheduled_date < '2026-08-01'
       AND j.status <> 'cancelled'
     ORDER BY j.scheduled_date`, [acct]);
  for (const j of jobs) {
    const match = Math.abs(Number(j.amt) - unit) < 0.005;
    console.log(`    ${match ? "◆" : " "} job#${String(j.id).padEnd(6)} ${String(j.scheduled_date).slice(0, 10)} ${String(j.status).padEnd(9)} $${String(j.amt).padStart(7)} prop=${j.account_property_id ?? "—"}  per-visit-inv: ${j.inv_links ?? "none"}`);
  }
  console.log(`    ◆ = amount matches the collapsed unit price $${unit}`);
}
await c.end();
console.log("\nREAD-ONLY — nothing written.\n");
