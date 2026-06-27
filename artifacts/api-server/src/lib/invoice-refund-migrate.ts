import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export async function ensureInvoiceRefundColumns(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS refunded_amount  NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS refund_reason    TEXT,
      ADD COLUMN IF NOT EXISTS refunded_at      TIMESTAMPTZ
  `);
}
