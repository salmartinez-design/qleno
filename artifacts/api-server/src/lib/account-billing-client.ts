import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Resolve a representative "billing" client for a COMMERCIAL ACCOUNT job.
 *
 * Commercial jobs carry `account_id` / `account_property_id` but no
 * `client_id` — their identity is the account, not a person. Two tables
 * that anchor the job's lifecycle still require a client row, though:
 *   - `recurring_schedules.customer_id`  (NOT NULL, FK clients)
 *   - `cancellation_log.customer_id`     (FK clients)
 * Without a client, scheduling a recurrence (the schedule can't be
 * created) and skipping/cancelling (the log insert violated NOT NULL)
 * both broke for account jobs. This borrows the account's contact so the
 * office never sees a difference, matching how existing commercial
 * schedules (KMA, Cucci, Daveco) are already stored.
 *
 * Priority chain:
 *   1. the specific property's sub-account client (`account_properties.client_id`)
 *   2. the account's billing contact (`accounts.billing_contact_id`)
 *   3. any client linked to the account (`clients.account_id`), preferring active
 *
 * Returns null only when the account has no contact at all — callers
 * must treat null as "no anchor available" (skip fan-out / fall back).
 */
export async function resolveAccountBillingClientId(
  companyId: number,
  accountId: number | null | undefined,
  accountPropertyId: number | null | undefined,
): Promise<number | null> {
  // 1. The specific property's sub-account client.
  if (accountPropertyId != null) {
    const r = await db.execute(sql`
      SELECT client_id FROM account_properties
       WHERE id = ${accountPropertyId} AND company_id = ${companyId}
         AND client_id IS NOT NULL
       LIMIT 1
    `);
    const cid = (r.rows[0] as any)?.client_id;
    if (cid != null) return Number(cid);
  }

  if (accountId == null) return null;

  // 2. The account's billing contact — verify it still exists as a client
  //    in this company (billing_contact_id has no FK, so it can dangle).
  const b = await db.execute(sql`
    SELECT a.billing_contact_id
      FROM accounts a
      JOIN clients c ON c.id = a.billing_contact_id AND c.company_id = ${companyId}
     WHERE a.id = ${accountId} AND a.company_id = ${companyId}
       AND a.billing_contact_id IS NOT NULL
     LIMIT 1
  `);
  const bid = (b.rows[0] as any)?.billing_contact_id;
  if (bid != null) return Number(bid);

  // 3. Any client linked to the account (active first, oldest id wins).
  const c = await db.execute(sql`
    SELECT id FROM clients
     WHERE account_id = ${accountId} AND company_id = ${companyId}
     ORDER BY is_active DESC, id ASC
     LIMIT 1
  `);
  const anyId = (c.rows[0] as any)?.id;
  return anyId != null ? Number(anyId) : null;
}
