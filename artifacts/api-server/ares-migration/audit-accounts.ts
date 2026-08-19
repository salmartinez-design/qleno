// Read-only audit. Finds every group of client records that is really ONE
// customer with several buildings, and reports how organised each one is.
//
// Three independent signals, because no single one catches everything:
//   EMAIL  — same non-empty email on 2+ clients
//   PHONE  — same last-10 digits on 2+ clients
//   NAME   — same leading words, with a street number in the remainder
//            ("Cucci Realty 10418 S Keating", "Daveco 18440 Torrence Lansing")
//
// Writes a CSV for review and prints a ranked summary.
import { writeFileSync } from "node:fs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const C = 1;

type Row = {
  id: number; name: string; email: string | null; phone: string | null;
  is_active: boolean; account_id: number | null; client_type: string;
  jobs: number; schedules: number; subs: number; mrr: string | null;
};

const clients = (await db.execute(sql`
  SELECT c.id,
         trim(coalesce(nullif(c.company_name,''), c.first_name || ' ' || c.last_name)) AS name,
         lower(nullif(trim(coalesce(c.email,'')),'')) AS email,
         right(regexp_replace(coalesce(c.phone,''),'\D','','g'),10) AS phone,
         c.is_active, c.account_id, c.client_type,
         (SELECT count(*)::int FROM jobs j                   WHERE j.client_id  = c.id) AS jobs,
         (SELECT count(*)::int FROM recurring_schedules r    WHERE r.customer_id = c.id) AS schedules,
         (SELECT count(*)::int FROM recurring_subscriptions s WHERE s.client_id = c.id) AS subs,
         (SELECT sum(s.mrr)::text FROM recurring_subscriptions s
           WHERE s.client_id = c.id AND s.status IN ('active','on_demand'))              AS mrr
    FROM clients c WHERE c.company_id = ${C}
`)).rows as unknown as Row[];

const accounts = new Map<number, string>();
for (const a of (await db.execute(sql`
  SELECT id, account_name FROM accounts WHERE company_id = ${C}
`)).rows as any[]) accounts.set(Number(a.id), String(a.account_name));

const propCount = new Map<number, number>();
for (const p of (await db.execute(sql`
  SELECT account_id, count(*)::int AS n FROM account_properties
   WHERE company_id = ${C} GROUP BY account_id
`)).rows as any[]) propCount.set(Number(p.account_id), Number(p.n));

// ── build clusters ──────────────────────────────────────────────────────────
const STOP = new Set(["the","and","of","llc","inc","corp","co","ltd"]);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
// leading words up to the first token that looks like a street number
const namePrefix = (raw: string) => {
  const t = norm(raw).split(" ").filter(w => w && !STOP.has(w));
  const at = t.findIndex((w, i) => i > 0 && /^\d{2,6}(-\d+)?$/.test(w));
  if (at < 1) return null;
  const pre = t.slice(0, at).join(" ");
  return pre.length >= 4 ? pre : null;   // "j 123 main" is not a group
};

const groups = new Map<string, { key: string; basis: string; ids: Set<number> }>();
const add = (key: string, basis: string, id: number) => {
  const g = groups.get(key) ?? { key, basis, ids: new Set<number>() };
  g.ids.add(id); groups.set(key, g);
};
for (const c of clients) {
  if (c.email) add(`email:${c.email}`, "EMAIL", c.id);
  if (c.phone && c.phone.length === 10) add(`phone:${c.phone}`, "PHONE", c.id);
  const p = namePrefix(c.name); if (p) add(`name:${p}`, "NAME", c.id);
}

// merge overlapping groups — one customer found by both email and name is one cluster
const byId = new Map(clients.map(c => [c.id, c]));
const parent = new Map<number, number>();
const find = (x: number): number => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
for (const c of clients) parent.set(c.id, c.id);
for (const g of groups.values()) {
  if (g.ids.size < 2) continue;
  const ids = [...g.ids]; const a = find(ids[0]);
  for (const b of ids.slice(1)) parent.set(find(b), a);
}
const clusters = new Map<number, number[]>();
for (const c of clients) {
  const r = find(c.id);
  clusters.set(r, [...(clusters.get(r) ?? []), c.id]);
}

const bases = new Map<number, Set<string>>();
for (const g of groups.values()) {
  if (g.ids.size < 2) continue;
  const r = find([...g.ids][0]);
  bases.set(r, new Set([...(bases.get(r) ?? []), g.basis]));
}

// ── assess ──────────────────────────────────────────────────────────────────
const money = (s: string | null) => Number(s ?? 0);
const rows: any[] = [];
const csv: string[] = ["cluster,verdict,client_id,name,type,active,account_id,account_name,jobs,schedules,subs,active_mrr"];
let n = 0;

const assessed = [...clusters.entries()]
  .filter(([, ids]) => ids.length >= 2)
  .map(([root, ids]) => {
    const members = ids.map(i => byId.get(i)!).sort((a, b) => a.id - b.id);
    const accts = [...new Set(members.map(m => m.account_id).filter(Boolean))] as number[];
    const linked = members.filter(m => m.account_id != null).length;
    const mrr = members.reduce((t, m) => t + money(m.mrr), 0);
    const deadWeight = members.some(m => !m.is_active && m.subs > 0);
    const verdict =
      accts.length > 1                       ? "SPLIT — members on different accounts"
      : linked === 0 && accts.length === 0    ? "NO ACCOUNT — nothing linked"
      : linked < members.length               ? "PARTIAL — some members unlinked"
      :                                         "OK";
    return { root, members, accts, linked, mrr, deadWeight, verdict, basis: [...(bases.get(root) ?? [])].join("+") };
  })
  .sort((a, b) => b.mrr - a.mrr || b.members.length - a.members.length);

for (const c of assessed) {
  if (c.verdict === "OK" && !c.deadWeight) continue;   // already organised
  n++;
  const label = c.members[0].name.slice(0, 34);
  rows.push({
    cluster: label, verdict: c.verdict + (c.deadWeight ? " +INACTIVE-WITH-REVENUE" : ""),
    clients: c.members.length, linked: c.linked,
    account: c.accts.map(a => `#${a} ${accounts.get(a) ?? "?"}`).join(" | ") || "-",
    active_mrr: c.mrr ? `$${c.mrr.toFixed(2)}` : "-", found_by: c.basis,
  });
  for (const m of c.members) {
    csv.push([
      `"${label}"`, `"${c.verdict}"`, m.id, `"${m.name.replace(/"/g, '""')}"`, m.client_type,
      m.is_active, m.account_id ?? "", `"${m.account_id ? (accounts.get(m.account_id) ?? "") : ""}"`,
      m.jobs, m.schedules, m.subs, money(m.mrr).toFixed(2),
    ].join(","));
  }
}

console.log(`\n${clients.length} clients · ${accounts.size} accounts · ${assessed.length} multi-record customers found`);
console.log(`${assessed.length - n} already organised · ${n} need attention\n`);
console.table(rows.slice(0, 40));
if (rows.length > 40) console.log(`… and ${rows.length - 40} more, all in the CSV.`);

show_accounts();
function show_accounts() {
  const orphan = [...accounts.entries()]
    .filter(([id]) => !clients.some(c => c.account_id === id))
    .map(([id, name]) => ({ account: `#${id} ${name}`, properties: propCount.get(id) ?? 0, clients_linked: 0 }));
  if (orphan.length) {
    console.log(`\n── accounts with NO client linked to them (${orphan.length})`);
    console.table(orphan);
  }
}

writeFileSync("ares-migration/account-audit.csv", csv.join("\n"));
console.log(`\nFull detail: ares-migration/account-audit.csv (${csv.length - 1} rows)\n`);
process.exit(0);
