// Read-only. Shows how the Cucci records are wired today.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const COMPANY_ID = 1;

const show = (title: string, rows: any[]) => {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`);
  if (!rows.length) { console.log("  (none)"); return; }
  console.table(rows);
};

show("accounts", (await db.execute(sql`
  SELECT id, account_name, account_type, is_active
    FROM accounts WHERE company_id = ${COMPANY_ID}
   ORDER BY account_name
`)).rows);

show("clients matching 'cucci'", (await db.execute(sql`
  SELECT id, coalesce(company_name, first_name || ' ' || last_name) AS name,
         client_type, is_active, account_id
    FROM clients
   WHERE company_id = ${COMPANY_ID}
     AND (lower(coalesce(company_name,'')) LIKE '%cucci%'
       OR lower(coalesce(first_name,'')) LIKE '%cucci%'
       OR lower(coalesce(last_name,''))  LIKE '%cucci%')
   ORDER BY id
`)).rows);

show("imported Ares subscriptions on those clients", (await db.execute(sql`
  SELECT s.id, s.client_id,
         coalesce(c.company_name, c.first_name || ' ' || c.last_name) AS client,
         s.status, s.cadence, s.rate, s.mrr
    FROM recurring_subscriptions s
    JOIN clients c ON c.id = s.client_id
   WHERE s.company_id = ${COMPANY_ID}
     AND (lower(coalesce(c.company_name,'')) LIKE '%cucci%'
       OR lower(coalesce(c.first_name,'')) LIKE '%cucci%')
   ORDER BY s.id
`)).rows);

show("account_properties already on file", (await db.execute(sql`
  SELECT p.id, p.account_id, a.account_name, p.property_name, p.address, p.client_id
    FROM account_properties p
    LEFT JOIN accounts a ON a.id = p.account_id
   WHERE p.company_id = ${COMPANY_ID}
     AND (lower(coalesce(a.account_name,'')) LIKE '%cucci%'
       OR lower(coalesce(p.property_name,'')) LIKE '%cucci%')
   ORDER BY p.id
`)).rows);

process.exit(0);
