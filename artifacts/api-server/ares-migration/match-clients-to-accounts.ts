// Read-only. Proposes which client belongs to which account, by ADDRESS.
//
// The audit found 25 accounts with properties on file and zero clients linked.
// account_properties carries a street address for every building; clients carry
// one too. Matching those is far more reliable than matching names, because a
// building's address is the one field that cannot be spelled two ways.
//
// Writes account-links-proposed.csv. Nothing is written to the database.
import { writeFileSync } from "node:fs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const C = 1;

// "10418 South Keating Ave" and "10418 S Keating" must compare equal.
const SUFFIX: Record<string, string> = {
  street: "st", str: "st", st: "st", avenue: "ave", ave: "ave", av: "ave",
  road: "rd", rd: "rd", drive: "dr", dr: "dr", boulevard: "blvd", blvd: "blvd",
  court: "ct", ct: "ct", place: "pl", pl: "pl", lane: "ln", ln: "ln",
  terrace: "ter", parkway: "pkwy", circle: "cir", cir: "cir", highway: "hwy",
  north: "n", south: "s", east: "e", west: "w",
};
const key = (addr: string | null) => {
  if (!addr) return null;
  const first = addr.split(",")[0];                     // drop city/state/zip
  const toks = first.toLowerCase().replace(/[^a-z0-9\- ]+/g, " ").split(/\s+/).filter(Boolean)
    .map(t => SUFFIX[t] ?? t)
    .filter(t => !["unit","apt","ste","suite","#"].includes(t));
  if (!toks.length) return null;
  const num = toks[0].match(/^\d+/) ? toks[0].split("-")[0] : null;   // 11901-05 -> 11901
  if (!num) return null;
  const rest = toks.slice(1).filter(t => t !== "common" && t !== "areas").join(" ");
  return rest ? `${num} ${rest}` : null;
};

const props = (await db.execute(sql`
  SELECT p.id AS property_id, p.account_id, a.account_name, p.property_name, p.address, p.client_id
    FROM account_properties p JOIN accounts a ON a.id = p.account_id
   WHERE p.company_id = ${C}
`)).rows as any[];

const clients = (await db.execute(sql`
  SELECT c.id, trim(coalesce(nullif(c.company_name,''), c.first_name||' '||c.last_name)) AS name,
         c.address, c.is_active, c.account_id,
         (SELECT count(*)::int FROM recurring_subscriptions s WHERE s.client_id = c.id) AS subs,
         (SELECT coalesce(sum(s.mrr),0)::text FROM recurring_subscriptions s
           WHERE s.client_id = c.id AND s.status IN ('active','on_demand')) AS mrr
    FROM clients c WHERE c.company_id = ${C}
`)).rows as any[];

const byAddr = new Map<string, any[]>();
for (const p of props) {
  const k = key(p.address); if (!k) continue;
  byAddr.set(k, [...(byAddr.get(k) ?? []), p]);
}

const out: string[] = ["client_id,client_name,client_address,match,account_id,account_name,property_id,property_address,subs,active_mrr,current_account_id"];
const hits: any[] = [];
for (const c of clients) {
  const k = key(c.address); if (!k) continue;
  const m = byAddr.get(k); if (!m) continue;
  const accts = [...new Set(m.map(x => x.account_id))];
  const match = accts.length === 1 ? "ADDRESS" : "AMBIGUOUS — address on 2+ accounts";
  const p = m[0];
  hits.push({
    client: `#${c.id} ${String(c.name).slice(0, 30)}`, address: String(c.address).split(",")[0].slice(0, 30),
    account: `#${p.account_id} ${String(p.account_name).slice(0, 26)}`, match,
    subs: c.subs, mrr: Number(c.mrr) ? `$${Number(c.mrr).toFixed(2)}` : "-",
    already: c.account_id ?? "-",
  });
  out.push([c.id, `"${String(c.name).replace(/"/g,'""')}"`, `"${String(c.address).replace(/"/g,'""')}"`,
            match, p.account_id, `"${p.account_name}"`, p.property_id, `"${p.address}"`,
            c.subs, Number(c.mrr).toFixed(2), c.account_id ?? ""].join(","));
}

console.log(`\n${props.length} account properties · ${clients.length} clients`);
console.log(`${byAddr.size} distinct property addresses · ${hits.length} clients matched an account by address\n`);
console.table(hits.slice(0, 50));
if (hits.length > 50) console.log(`… ${hits.length - 50} more in the CSV.`);

// which accounts still have no client after address matching?
const matched = new Set(hits.map(h => h.account.split(" ")[0]));
const orphan = [...new Set(props.map(p => `#${p.account_id} ${p.account_name}`))]
  .filter(a => !matched.has(a.split(" ")[0]));
if (orphan.length) {
  console.log(`\n── accounts still with no client matched by address (${orphan.length})`);
  for (const o of orphan) console.log(`   ${o}`);
  console.log("   These need their buildings identified another way — name, or by hand.");
}

writeFileSync("ares-migration/account-links-proposed.csv", out.join("\n"));
console.log(`\nProposal written to ares-migration/account-links-proposed.csv — nothing was written to the database.\n`);
process.exit(0);
