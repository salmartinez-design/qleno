// [account-comms-toggle 2026-06-25] Per-account "pause all communications".
// Property-management accounts (PPM, KMA, …) with many properties can be silenced
// via accounts.comms_enabled = false. Any customer record linked to the account
// (clients.account_id) is then excluded from ALL automated SMS/email.
//
// Two enforcement shapes:
//  - Bulk/cron queries: LEFT JOIN accounts and require (a.id IS NULL OR a.comms_enabled = true).
//  - Per-job send paths: call isClientAccountCommsPaused(clientId) and skip when true.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// True when the client belongs to an account whose comms are paused.
// Never throws — comms gating must never break the calling request.
export async function isClientAccountCommsPaused(
  clientId: number | null | undefined,
): Promise<boolean> {
  if (!clientId) return false;
  try {
    const r = await db.execute(sql`
      SELECT 1
        FROM clients c
        JOIN accounts a ON a.id = c.account_id
       WHERE c.id = ${clientId} AND a.comms_enabled = false
       LIMIT 1
    `);
    return ((r as any).rows?.length ?? 0) > 0;
  } catch (err) {
    console.error("[account-comms] isClientAccountCommsPaused failed (non-fatal):", err);
    return false;
  }
}
