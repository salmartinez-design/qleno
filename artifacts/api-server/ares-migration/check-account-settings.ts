// Read-only. What behaviour would a client INHERIT by being linked to an account?
// comms_enabled=false silences all automated SMS/email for every linked client.
// auto_charge_on_completion=true charges a card when a job completes.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
const r = (await db.execute(sql`
  SELECT a.id, a.account_name, a.comms_enabled, a.auto_charge_on_completion,
         a.auto_issue_enabled, a.invoice_frequency, a.payment_method, a.is_active,
         (SELECT count(*)::int FROM account_properties p WHERE p.account_id = a.id) AS props
    FROM accounts a WHERE a.company_id = 1 ORDER BY a.id
`)).rows as any[];
console.table(r);
const risky = r.filter(x => x.comms_enabled === false || x.auto_charge_on_completion === true || x.is_active === false);
console.log(risky.length
  ? `\n!! ${risky.length} account(s) would change behaviour for any client linked to them:`
  : "\nAll accounts: comms on, auto-charge off, active. Linking changes no live behaviour.");
for (const x of risky) {
  const why = [
    x.comms_enabled === false && "comms_enabled=false — silences ALL automated SMS/email",
    x.auto_charge_on_completion === true && "auto_charge_on_completion=true — charges card on job completion",
    x.is_active === false && "account is inactive",
  ].filter(Boolean).join("; ");
  console.log(`   #${x.id} ${x.account_name} — ${why}`);
}
process.exit(0);
