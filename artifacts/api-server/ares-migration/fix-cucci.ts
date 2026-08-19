// Links the Cucci clients to the account that already exists (#6), matching the
// shape Daveco already has: one surviving client, one account, properties on
// the account. Does NOT create per-building clients — the six buildings are
// already account_properties 70-75, and duplicating them as clients is exactly
// what accounts.ts attach-mode was written to avoid.
//
//   pnpm exec tsx ares-migration/fix-cucci.ts            # preview
//   pnpm exec tsx ares-migration/fix-cucci.ts --commit
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const COMMIT = process.argv.includes("--commit");
const C = 1;
const ACCOUNT = 6;      // Cucci Property Management
const KEEP = 1359;      // Cucci Property Management — matches the account name
const DUP  = 1358;      // Cucci Association Management — same billing entity

const show = (t: string, r: any[]) => { console.log(`\n── ${t}`); r.length ? console.table(r) : console.log("  (none)"); };

// ── sanity: everything referenced here must actually exist ──────────────────
const [acct] = (await db.execute(sql`
  SELECT id, account_name FROM accounts WHERE id = ${ACCOUNT} AND company_id = ${C}
`)).rows as any[];
if (!acct) { console.error(`account ${ACCOUNT} not found — aborting.`); process.exit(1); }
console.log(`account ${acct.id}: ${acct.account_name}`);

show("subscriptions that will end up on the account", (await db.execute(sql`
  SELECT s.id, s.client_id, s.status, s.cadence, s.mrr
    FROM recurring_subscriptions s
   WHERE s.company_id = ${C} AND s.client_id IN (${KEEP}, ${DUP})
   ORDER BY s.mrr DESC
`)).rows);

// Are the per-building client stubs actually carrying anything? If they hold
// jobs or schedules they are load-bearing and must not be retired.
show("per-building client stubs — jobs / schedules they carry", (await db.execute(sql`
  SELECT c.id, coalesce(nullif(c.company_name,''), c.first_name||' '||c.last_name) AS name,
         c.is_active,
         (SELECT count(*)::int FROM jobs j WHERE j.client_id = c.id)                       AS jobs,
         (SELECT count(*)::int FROM recurring_schedules r WHERE r.customer_id = c.id)      AS schedules,
         (SELECT count(*)::int FROM recurring_subscriptions s WHERE s.client_id = c.id)    AS subs
    FROM clients c
   WHERE c.company_id = ${C} AND c.id IN (1265,1266,1267,1268,1269,1358,1359)
   ORDER BY c.id
`)).rows);

const plan = [
  `clients #${KEEP}, #${DUP} and #1265-#1269  ->  account_id = ${ACCOUNT}`,
  `client  #${KEEP}                           ->  is_active = true  (holds 6 live subscriptions)`,
  `account_properties 70-75                   ->  client_id = ${KEEP}  (Daveco pattern)`,
  `client  #${DUP}                            ->  note: duplicate of #${KEEP}`,
];
console.log(`\n── plan\n${plan.map(p => "  " + p).join("\n")}`);

if (!COMMIT) {
  console.log("\nPreview only — nothing written. Re-run with --commit to apply.");
  console.log("Note: no client is retired and no subscription is moved. Reversible.\n");
  process.exit(0);
}

const out = await db.transaction(async (tx) => {
  const a = await tx.execute(sql`
    UPDATE clients SET account_id = ${ACCOUNT}
     WHERE company_id = ${C} AND id IN (1265,1266,1267,1268,1269,${DUP},${KEEP})`);
  const b = await tx.execute(sql`
    UPDATE clients SET is_active = true WHERE company_id = ${C} AND id = ${KEEP}`);
  const c2 = await tx.execute(sql`
    UPDATE account_properties SET client_id = ${KEEP}
     WHERE company_id = ${C} AND account_id = ${ACCOUNT} AND client_id IS NULL`);
  const d = await tx.execute(sql`
    UPDATE clients
       SET notes = coalesce(nullif(notes,'') || ' ', '') ||
                   '[ares 2026-08-19] Same billing entity as Cucci Property Management (#${sql.raw(String(KEEP))}). Use that record; this one is retained for invoice history only.'
     WHERE company_id = ${C} AND id = ${DUP}
       AND coalesce(notes,'') NOT LIKE '%[ares 2026-08-19]%'`);
  return { linked: a.rowCount, reactivated: b.rowCount, properties: c2.rowCount, noted: d.rowCount };
});

console.log(`\n  ${out.linked} clients linked to account ${ACCOUNT}`);
console.log(`  ${out.reactivated} client reactivated`);
console.log(`  ${out.properties} account_properties given client_id ${KEEP}`);
console.log(`  ${out.noted} duplicate annotated`);

show("verify — cucci clients", (await db.execute(sql`
  SELECT id, coalesce(nullif(company_name,''), first_name||' '||last_name) AS name, is_active, account_id
    FROM clients WHERE company_id = ${C} AND id IN (1265,1266,1267,1268,1269,${DUP},${KEEP}) ORDER BY id
`)).rows);
process.exit(0);
