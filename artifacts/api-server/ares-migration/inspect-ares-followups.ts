// Read-only. Two questions:
//   1. How are the Cucci records wired right now?
//   2. Each of the 13 "already exists" skips — what did it match, and on what?
//      The skip test is email OR last-10-of-phone OR name. Sub-accounts of one
//      billing entity share an email, so a genuinely new property can be skipped
//      because its PARENT already exists. That is a false positive, not a dedup.
import { readFileSync } from "node:fs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const COMPANY_ID = 1;
const show = (t: string, rows: any[]) => {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 64 - t.length))}`);
  rows.length ? console.table(rows) : console.log("  (none)");
};

show("accounts", (await db.execute(sql`
  SELECT id, account_name, account_type, is_active FROM accounts
   WHERE company_id = ${COMPANY_ID} ORDER BY account_name
`)).rows);

show("clients matching 'cucci'", (await db.execute(sql`
  SELECT id, coalesce(nullif(company_name,''), first_name || ' ' || last_name) AS name,
         client_type, is_active, account_id, email, phone
    FROM clients
   WHERE company_id = ${COMPANY_ID}
     AND (lower(coalesce(company_name,'')) LIKE '%cucci%'
       OR lower(coalesce(first_name,''))   LIKE '%cucci%'
       OR lower(coalesce(last_name,''))    LIKE '%cucci%')
   ORDER BY id
`)).rows);

show("Ares subscriptions sitting on a Cucci client", (await db.execute(sql`
  SELECT s.id, s.client_id, s.status, s.cadence, s.rate, s.mrr
    FROM recurring_subscriptions s
    JOIN clients c ON c.id = s.client_id
   WHERE s.company_id = ${COMPANY_ID}
     AND (lower(coalesce(c.company_name,'')) LIKE '%cucci%'
       OR lower(coalesce(c.first_name,''))   LIKE '%cucci%')
   ORDER BY s.mrr DESC
`)).rows);

// ── the 13 skips ────────────────────────────────────────────────────────────
const csv = readFileSync(new URL("./new-clients.csv", import.meta.url), "utf8").trim().split("\n");
const hdr = csv[0].split(",").map(h => h.replace(/^"|"$/g, ""));
const parse = (line: string) => {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
    else if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur); return out;
};
const rows = csv.slice(1).map(l => Object.fromEntries(parse(l).map((v, i) => [hdr[i], v])) as any);

const digits = (s: string) => (s || "").replace(/\D/g, "").slice(-10);
const report: any[] = [];
for (const r of rows) {
  const name = r.ares_name, email = (r.email || "").trim().toLowerCase(), ph = digits(r.phone);
  const hit = (await db.execute(sql`
    SELECT id, coalesce(nullif(company_name,''), first_name || ' ' || last_name) AS name,
           lower(coalesce(email,'')) AS email, regexp_replace(coalesce(phone,''),'\D','','g') AS ph
      FROM clients WHERE company_id = ${COMPANY_ID}
       AND ( (${email} <> '' AND lower(coalesce(email,'')) = ${email})
          OR (${ph} <> ''  AND right(regexp_replace(coalesce(phone,''),'\D','','g'),10) = ${ph})
          OR  lower(trim(coalesce(nullif(company_name,''), first_name||' '||last_name))) = ${name.trim().toLowerCase()} )
     ORDER BY id LIMIT 3
  `)).rows as any[];

  const exactName = hit.find(h => String(h.name).trim().toLowerCase() === name.trim().toLowerCase());
  const basis = exactName ? "NAME — real duplicate"
    : hit.some(h => email && h.email === email) ? "EMAIL ONLY — suspect"
    : hit.length ? "PHONE ONLY — suspect" : "nothing matched";
  report.push({
    ares_name: name.slice(0, 42), mrr: r.mrr_monthly, basis,
    matched: hit.map(h => `#${h.id} ${String(h.name).slice(0, 26)}`).join(" | ") || "-",
  });
}
show("the 13 'already exists' skips — why each was skipped", report);
console.log("\nRows marked EMAIL ONLY / PHONE ONLY were NOT created and probably should have been.\n");
process.exit(0);
