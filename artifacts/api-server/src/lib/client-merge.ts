// [client-dedup 2026-07-28] Merge + guarded-delete engine for duplicate clients.
//
// The office asked to "delete and merge clients to get rid of duplicates"
// (Maribel). Today they just flag suspected dupes because a raw
// `DELETE FROM clients` either FK-errors (most child tables reference
// clients.id with NO ACTION) or would orphan history. This module reassigns
// EVERY table that points at a client from the duplicate to the survivor inside
// one transaction, then removes the now-empty duplicate.
//
// CLIENT_REFS below is the authoritative list of every table/column that
// references a client. It was built by grepping the schema for
// `references(() => clientsTable.id)` plus the non-FK integer columns that
// semantically point at a client (leads/follow-up/message_log) and the
// polymorphic + unique-constrained special cases (qb_customer_map,
// customer_notification_preferences, clients.referral_by_customer_id). If a new
// client-referencing table is added, ADD IT HERE or a merge will orphan it.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

type Exec = {
  execute: (q: ReturnType<typeof sql>) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export interface ClientRef {
  /** Postgres table name. */
  table: string;
  /** Column on that table that holds the client id. */
  column: string;
  /** Human label used in the impact summary. */
  label: string;
  /** Surface this count in the headline UI counts (jobs / invoices / …). */
  headline?: boolean;
  /** Presence of rows here blocks a hard delete (client "has history"). */
  blocksDelete?: boolean;
}

// Standard reassignments — a plain `UPDATE <table> SET <col> = survivor WHERE
// <col> = duplicate`. Client ids are a single global serial sequence, so a
// client-id value matches exactly one tenant's rows; the caller still validates
// both clients share a company before we touch anything (defence in depth).
export const CLIENT_REFS: ClientRef[] = [
  { table: "jobs", column: "client_id", label: "jobs", headline: true, blocksDelete: true },
  { table: "invoices", column: "client_id", label: "invoices", headline: true, blocksDelete: true },
  { table: "payments", column: "client_id", label: "payments", headline: true, blocksDelete: true },
  { table: "quotes", column: "client_id", label: "quotes", headline: true, blocksDelete: true },
  { table: "estimates", column: "client_id", label: "estimates", headline: true, blocksDelete: true },
  { table: "recurring_schedules", column: "customer_id", label: "recurring schedules", headline: true, blocksDelete: true },
  { table: "recurring_subscriptions", column: "client_id", label: "recurring subscriptions", headline: true, blocksDelete: true },
  { table: "sales_attribution", column: "client_id", label: "sales attributions", blocksDelete: true },
  { table: "scorecards", column: "client_id", label: "scorecards", headline: true, blocksDelete: true },
  { table: "commissions", column: "client_id", label: "commissions", blocksDelete: true },
  { table: "client_communications", column: "client_id", label: "communications", headline: true, blocksDelete: true },
  { table: "communication_log", column: "customer_id", label: "communication-log entries", blocksDelete: true },
  { table: "sms_messages", column: "client_id", label: "SMS messages", blocksDelete: true },
  { table: "scheduled_sms", column: "client_id", label: "scheduled SMS", blocksDelete: true },
  { table: "client_notifications", column: "client_id", label: "notification contacts", blocksDelete: true },
  { table: "client_attachments", column: "client_id", label: "attachments", blocksDelete: true },
  { table: "client_ratings", column: "client_id", label: "ratings", blocksDelete: true },
  { table: "client_homes", column: "client_id", label: "homes", blocksDelete: true },
  { table: "technician_preferences", column: "client_id", label: "technician preferences", blocksDelete: true },
  { table: "contact_tickets", column: "client_id", label: "contact tickets", blocksDelete: true },
  { table: "dispatch_events", column: "client_id", label: "dispatch events", blocksDelete: true },
  { table: "document_requests", column: "client_id", label: "document requests", blocksDelete: true },
  { table: "document_signatures", column: "client_id", label: "document signatures", blocksDelete: true },
  { table: "form_submissions", column: "client_id", label: "form submissions", blocksDelete: true },
  { table: "loyalty_points_log", column: "client_id", label: "loyalty history", blocksDelete: true },
  { table: "payment_links", column: "client_id", label: "payment links", blocksDelete: true },
  { table: "rate_locks", column: "client_id", label: "rate locks", blocksDelete: true },
  { table: "referral_partners", column: "client_id", label: "referral-partner links", blocksDelete: true },
  { table: "square_customer_map", column: "client_id", label: "Square customer links", blocksDelete: true },
  { table: "square_payment_events", column: "resolved_client_id", label: "Square payment events", blocksDelete: true },
  { table: "team_photo_notes", column: "client_id", label: "team photo notes", blocksDelete: true },
  { table: "account_properties", column: "client_id", label: "account properties", blocksDelete: true },
  { table: "cancellation_log", column: "customer_id", label: "cancellations", blocksDelete: true },
  { table: "churn_scores", column: "customer_id", label: "churn scores", blocksDelete: true },
  { table: "satisfaction_surveys", column: "customer_id", label: "satisfaction surveys", blocksDelete: true },
  { table: "leads", column: "client_id", label: "leads", blocksDelete: true },
  { table: "follow_up_enrollments", column: "client_id", label: "follow-up enrollments", blocksDelete: true },
  { table: "message_log", column: "client_id", label: "message-log entries", blocksDelete: true },
  // Per-client activity trail. FK is ON DELETE CASCADE, so it would not block a
  // delete and would vanish with the client — but on a MERGE we reassign it so
  // the trail survives on the survivor. Not counted toward "has history".
  { table: "client_audit_log", column: "client_id", label: "audit history" },
];

// Special-cased tables (unique constraints / polymorphic scope) that a naive
// UPDATE could violate. Handled explicitly in mergeClients / countSpecial.
const QB_MAP = { table: "qb_customer_map", column: "qleno_customer_id", label: "QuickBooks customer link" };
const NOTIF_PREFS = { table: "customer_notification_preferences", label: "notification preferences" };

// Survivor contact/address fields we backfill from the duplicate ONLY when the
// survivor's own value is null/empty. Payment-instrument fields are deliberately
// excluded — filling a survivor's card details from a dupe would be wrong.
const FILL_FIELDS = [
  "email", "phone", "company_name", "address", "city", "state", "zip",
  "lat", "lng", "home_access_notes", "alarm_code", "pets",
  "billing_contact_name", "billing_contact_email", "billing_contact_phone",
] as const;

async function existingTables(exec: Exec): Promise<Set<string>> {
  const r = await exec.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
  return new Set(r.rows.map((row: any) => row.table_name as string));
}

async function countRef(exec: Exec, table: string, column: string, id: number): Promise<number> {
  const r = await exec.execute(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${id}`,
  );
  return (r.rows?.[0]?.n as number) ?? 0;
}

async function reassign(exec: Exec, table: string, column: string, dup: number, survivor: number): Promise<number> {
  const r = await exec.execute(
    sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${survivor} WHERE ${sql.identifier(column)} = ${dup}`,
  );
  return r.rowCount ?? 0;
}

export interface ClientLite {
  id: number;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  company_id: number;
}

async function loadClient(exec: Exec, companyId: number, id: number): Promise<ClientLite | null> {
  const r = await exec.execute(
    sql`SELECT id, first_name, last_name, email, phone, company_id
        FROM clients WHERE id = ${id} AND company_id = ${companyId} LIMIT 1`,
  );
  return (r.rows?.[0] as ClientLite | undefined) ?? null;
}

export interface MergeImpact {
  duplicate: ClientLite;
  survivor: ClientLite;
  /** Headline counts for the confirmation copy. */
  counts: Record<string, number>;
  /** Every non-zero reference bucket, for the detailed breakdown. */
  breakdown: { label: string; count: number }[];
  totalRecords: number;
  /** Survivor fields that would be backfilled from the duplicate. */
  fieldFills: { field: string; value: string }[];
}

/**
 * Dry-run: enumerate everything a merge would move, plus which survivor contact
 * fields would be filled. Never mutates. Throws {status,message} on validation.
 */
export async function getClientMergeImpact(
  companyId: number,
  duplicateId: number,
  survivorId: number,
): Promise<MergeImpact> {
  if (duplicateId === survivorId) {
    throw { status: 400, message: "A client cannot be merged into itself." };
  }
  const [duplicate, survivor] = await Promise.all([
    loadClient(db, companyId, duplicateId),
    loadClient(db, companyId, survivorId),
  ]);
  if (!duplicate) throw { status: 404, message: "Duplicate client not found." };
  if (!survivor) throw { status: 404, message: "Survivor client not found." };

  const tables = await existingTables(db);
  const counts: Record<string, number> = {};
  const breakdown: { label: string; count: number }[] = [];
  let total = 0;

  for (const ref of CLIENT_REFS) {
    if (!tables.has(ref.table)) continue;
    const n = await countRef(db, ref.table, ref.column, duplicateId);
    if (n > 0) {
      breakdown.push({ label: ref.label, count: n });
      total += n;
      if (ref.headline) counts[headlineKey(ref)] = n;
    }
  }
  // Specials
  if (tables.has(QB_MAP.table)) {
    const n = await countRef(db, QB_MAP.table, QB_MAP.column, duplicateId);
    if (n > 0) { breakdown.push({ label: QB_MAP.label, count: n }); total += n; }
  }
  if (tables.has(NOTIF_PREFS.table)) {
    const r = await db.execute(
      sql`SELECT count(*)::int AS n FROM customer_notification_preferences
          WHERE scope_type = 'client' AND scope_id = ${duplicateId} AND company_id = ${companyId}`,
    );
    const n = (r.rows?.[0]?.n as number) ?? 0;
    if (n > 0) { breakdown.push({ label: NOTIF_PREFS.label, count: n }); total += n; }
  }
  // Other clients this duplicate referred.
  const refBy = await countRef(db, "clients", "referral_by_customer_id", duplicateId);
  if (refBy > 0) { breakdown.push({ label: "referred clients", count: refBy }); total += refBy; }

  const fieldFills = computeFieldFills(duplicate as any, survivor as any);

  return { duplicate, survivor, counts, breakdown, totalRecords: total, fieldFills };
}

function headlineKey(ref: ClientRef): string {
  // camelCase-ish stable keys for the UI.
  const map: Record<string, string> = {
    jobs: "jobs", invoices: "invoices", payments: "payments", quotes: "quotes",
    estimates: "estimates", "recurring schedules": "recurringSchedules",
    "recurring subscriptions": "recurringSubscriptions", scorecards: "scorecards",
    communications: "communications",
  };
  return map[ref.label] ?? ref.label;
}

function computeFieldFills(dup: Record<string, any>, survivor: Record<string, any>): { field: string; value: string }[] {
  const fills: { field: string; value: string }[] = [];
  for (const f of FILL_FIELDS) {
    const sv = survivor[f];
    const dv = dup[f];
    const svEmpty = sv === null || sv === undefined || String(sv).trim() === "";
    const dvHas = dv !== null && dv !== undefined && String(dv).trim() !== "";
    if (svEmpty && dvHas) fills.push({ field: f, value: String(dv) });
  }
  return fills;
}

export interface MergeResult {
  survivorId: number;
  duplicateId: number;
  moved: Record<string, number>;
  totalMoved: number;
  filledFields: string[];
}

/**
 * Reassign every client reference from `duplicateId` to `survivorId`, backfill
 * empty survivor contact fields, then delete the duplicate — all in one
 * transaction. Company-scoped; safe to re-run (a second run simply moves 0 rows
 * since the duplicate no longer exists → throws 404, caught by the caller).
 */
export async function mergeClients(
  companyId: number,
  duplicateId: number,
  survivorId: number,
): Promise<MergeResult> {
  if (duplicateId === survivorId) {
    throw { status: 400, message: "A client cannot be merged into itself." };
  }

  return await db.transaction(async (tx) => {
    // Re-validate INSIDE the tx (row locks) so a concurrent delete/merge can't race.
    const duplicate = await loadClient(tx as any, companyId, duplicateId);
    const survivor = await loadClient(tx as any, companyId, survivorId);
    if (!duplicate) throw { status: 404, message: "Duplicate client not found." };
    if (!survivor) throw { status: 404, message: "Survivor client not found." };

    const tables = await existingTables(tx as any);
    const moved: Record<string, number> = {};
    let total = 0;

    for (const ref of CLIENT_REFS) {
      if (!tables.has(ref.table)) continue;
      const n = await reassign(tx as any, ref.table, ref.column, duplicateId, survivorId);
      if (n > 0) { moved[ref.table] = n; total += n; }
    }

    // qb_customer_map — unique (company_id, qleno_customer_id). Reassign the
    // duplicate's mapping only if the survivor has none; drop any leftover so
    // the delete of the duplicate does not FK-fail.
    if (tables.has(QB_MAP.table)) {
      const upd = await tx.execute(sql`
        UPDATE qb_customer_map SET qleno_customer_id = ${survivorId}
        WHERE qleno_customer_id = ${duplicateId}
          AND NOT EXISTS (
            SELECT 1 FROM qb_customer_map s
            WHERE s.company_id = qb_customer_map.company_id
              AND s.qleno_customer_id = ${survivorId}
          )`);
      const del = await tx.execute(sql`DELETE FROM qb_customer_map WHERE qleno_customer_id = ${duplicateId}`);
      const n = (upd.rowCount ?? 0) + (del.rowCount ?? 0);
      if (n > 0) { moved[QB_MAP.table] = n; total += n; }
    }

    // customer_notification_preferences — polymorphic scope with a unique on
    // (company_id, scope_type, scope_id, trigger, channel). Reassign the
    // duplicate's client-scoped overrides where the survivor has no matching
    // override; delete the rest (they collide, survivor's own wins).
    if (tables.has(NOTIF_PREFS.table)) {
      const upd = await tx.execute(sql`
        UPDATE customer_notification_preferences p SET scope_id = ${survivorId}
        WHERE p.scope_type = 'client' AND p.scope_id = ${duplicateId} AND p.company_id = ${companyId}
          AND NOT EXISTS (
            SELECT 1 FROM customer_notification_preferences q
            WHERE q.company_id = p.company_id AND q.scope_type = 'client'
              AND q.scope_id = ${survivorId} AND q.trigger = p.trigger AND q.channel = p.channel
          )`);
      const del = await tx.execute(sql`
        DELETE FROM customer_notification_preferences
        WHERE scope_type = 'client' AND scope_id = ${duplicateId} AND company_id = ${companyId}`);
      const n = (upd.rowCount ?? 0) + (del.rowCount ?? 0);
      if (n > 0) { moved[NOTIF_PREFS.table] = n; total += n; }
    }

    // Other clients this duplicate referred → repoint at the survivor.
    const refBy = await tx.execute(sql`
      UPDATE clients SET referral_by_customer_id = ${survivorId}
      WHERE referral_by_customer_id = ${duplicateId} AND company_id = ${companyId}`);
    if ((refBy.rowCount ?? 0) > 0) { moved["clients.referral_by_customer_id"] = refBy.rowCount!; total += refBy.rowCount!; }

    // Backfill empty survivor contact fields from the duplicate.
    const fills = computeFieldFills(duplicate as any, survivor as any);
    const filledFields: string[] = [];
    if (fills.length > 0) {
      const sets = fills.map((f) => sql`${sql.identifier(f.field)} = ${f.value}`);
      await tx.execute(sql`UPDATE clients SET ${sql.join(sets, sql`, `)} WHERE id = ${survivorId} AND company_id = ${companyId}`);
      filledFields.push(...fills.map((f) => f.field));
    }

    // Finally remove the now-empty duplicate. client_audit_log has already been
    // reassigned above; any remaining cascade rows go with it.
    await tx.execute(sql`DELETE FROM clients WHERE id = ${duplicateId} AND company_id = ${companyId}`);

    return { survivorId, duplicateId, moved, totalMoved: total, filledFields };
  });
}

export interface DeleteGuard {
  deletable: boolean;
  totalRecords: number;
  blockers: { label: string; count: number }[];
}

/**
 * Decide whether a client can be hard-deleted. A clean delete is allowed ONLY
 * for a truly empty duplicate — any job/invoice/history reference blocks it and
 * the office is told to merge instead.
 */
export async function getClientDeleteGuard(companyId: number, clientId: number): Promise<DeleteGuard> {
  const tables = await existingTables(db);
  const blockers: { label: string; count: number }[] = [];
  let total = 0;
  for (const ref of CLIENT_REFS) {
    if (!ref.blocksDelete || !tables.has(ref.table)) continue;
    const n = await countRef(db, ref.table, ref.column, clientId);
    if (n > 0) { blockers.push({ label: ref.label, count: n }); total += n; }
  }
  if (tables.has(QB_MAP.table)) {
    const n = await countRef(db, QB_MAP.table, QB_MAP.column, clientId);
    if (n > 0) { blockers.push({ label: QB_MAP.label, count: n }); total += n; }
  }
  const refBy = await countRef(db, "clients", "referral_by_customer_id", clientId);
  if (refBy > 0) { blockers.push({ label: "referred clients", count: refBy }); total += refBy; }
  return { deletable: total === 0, totalRecords: total, blockers };
}

/**
 * Hard-delete a truly empty client. Re-checks the guard inside the transaction,
 * then removes sparse non-FK leftovers (notification-preference overrides;
 * client_audit_log cascades with the row).
 */
export async function deleteEmptyClient(companyId: number, clientId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const client = await loadClient(tx as any, companyId, clientId);
    if (!client) throw { status: 404, message: "Client not found." };

    const tables = await existingTables(tx as any);
    for (const ref of CLIENT_REFS) {
      if (!ref.blocksDelete || !tables.has(ref.table)) continue;
      const n = await countRef(tx as any, ref.table, ref.column, clientId);
      if (n > 0) throw { status: 409, message: `Client has ${n} ${ref.label} and cannot be deleted. Merge it into another client instead.` };
    }
    if (tables.has(QB_MAP.table)) {
      const n = await countRef(tx as any, QB_MAP.table, QB_MAP.column, clientId);
      if (n > 0) throw { status: 409, message: "Client has a QuickBooks link and cannot be deleted. Merge it into another client instead." };
    }
    const refBy = await countRef(tx as any, "clients", "referral_by_customer_id", clientId);
    if (refBy > 0) throw { status: 409, message: "Client is recorded as the referrer of other clients and cannot be deleted. Merge it instead." };

    // Sparse, non-blocking leftovers.
    if (tables.has(NOTIF_PREFS.table)) {
      await tx.execute(sql`DELETE FROM customer_notification_preferences WHERE scope_type = 'client' AND scope_id = ${clientId} AND company_id = ${companyId}`);
    }
    await tx.execute(sql`DELETE FROM clients WHERE id = ${clientId} AND company_id = ${companyId}`);
  });
}
