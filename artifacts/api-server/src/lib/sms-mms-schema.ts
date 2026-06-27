// [sms-mms-scheduling] MMS + scheduled SMS schema migration.
// - sms_messages.media_urls text[] — R2 object keys for inbound/outbound MMS
// - sms_messages.scheduled_sms_id int — back-link to scheduled_sms when fired by scheduler
// - scheduled_sms table — future-dated outbound messages queued for delivery
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export async function ensureSmsMmsSchema(): Promise<void> {
  // Add media_urls column to sms_messages
  await db.execute(sql.raw(
    `ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS media_urls text[]`
  ));
  await db.execute(sql.raw(
    `ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS scheduled_sms_id integer`
  ));

  // Create scheduled_sms table
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS scheduled_sms (
      id serial PRIMARY KEY,
      company_id integer NOT NULL REFERENCES companies(id),
      contact_phone text NOT NULL,
      client_id integer REFERENCES clients(id),
      lead_id integer,
      message text NOT NULL,
      media_urls text[],
      scheduled_for timestamp NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      sent_sms_id integer,
      failure_reason text,
      created_by integer REFERENCES users(id),
      created_at timestamp NOT NULL DEFAULT now()
    )
  `));
  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS scheduled_sms_pending_idx ON scheduled_sms(company_id, scheduled_for, status)`
  ));
  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS scheduled_sms_phone_idx ON scheduled_sms(company_id, contact_phone)`
  ));
}
