// Read-only. What account structure already exists for Cucci / Daveco?
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
const C = 1;
const show = (t: string, r: any[]) => { console.log(`\n── ${t}`); r.length ? console.table(r) : console.log("  (none)"); };

show("all accounts", (await db.execute(sql`
  SELECT id, account_name, account_type, is_active FROM accounts
   WHERE company_id = ${C} ORDER BY id
`)).rows);

show("account_properties for cucci/daveco accounts", (await db.execute(sql`
  SELECT p.id, p.account_id, a.account_name, p.property_name, p.address, p.client_id, p.is_active
    FROM account_properties p JOIN accounts a ON a.id = p.account_id
   WHERE p.company_id = ${C}
     AND (lower(a.account_name) LIKE '%cucci%' OR lower(a.account_name) LIKE '%daveco%')
   ORDER BY a.account_name, p.id
`)).rows);

show("cucci clients: account_id + active", (await db.execute(sql`
  SELECT id, coalesce(nullif(company_name,''), first_name||' '||last_name) AS name,
         is_active, account_id
    FROM clients
   WHERE company_id = ${C}
     AND (lower(coalesce(company_name,'')) LIKE '%cucci%' OR lower(coalesce(first_name,'')) LIKE '%cucci%')
   ORDER BY id
`)).rows);
process.exit(0);
