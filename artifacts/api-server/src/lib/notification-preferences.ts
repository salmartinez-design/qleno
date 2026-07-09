// ─────────────────────────────────────────────────────────────────────────────
// Customer notification PREFERENCES — per-client / per-account control over
// WHICH customer messages fire and on WHICH channel.
//
// WHY THIS EXISTS: notifications used to be all-or-nothing per tenant — every
// active customer message went to every client. The office needs finer control:
// a PPM account that wants nothing, a weekly client that only wants the
// day-before reminder, a client who wants email but no SMS. This module stores
// those choices and resolves them at send time.
//
// MODEL — sparse override table. A row exists ONLY when the office has
// explicitly turned a (trigger, channel) OFF (or back ON after an off) for a
// scope. NO ROW = inherit the tenant default = ON. This is load-bearing: it
// means every existing client keeps receiving everything with zero backfill,
// and "default on" can never silently flip to off.
//
// SCOPE — residential clients (clients.account_id IS NULL) keep their prefs on
// the CLIENT scope. Commercial/account clients (clients.account_id set) are
// controlled at the ACCOUNT scope — an account has many properties/jobs, so
// per-client toggling is unmanageable. Resolution: if the client belongs to an
// account, the ACCOUNT's prefs win wholesale; otherwise the CLIENT's prefs
// apply. This mirrors how accounts.comms_enabled / isClientAccountCommsPaused
// already gate at the account level.
//
// This module is the ONLY source of truth for the resolution rule. Both send
// paths (the offset cron and sendNotification + the on-my-way direct path) call
// isMessageEnabledForJob(); none of them re-derive the rule inline.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { CUSTOMER_MESSAGE_CATALOG, type MsgChannel } from "./customer-messages.js";

export type PrefScopeType = "client" | "account";

// The triggers the office can toggle. Drawn from the canonical catalog so this
// list can never drift from what actually sends.
export const PREFERENCE_TRIGGERS = CUSTOMER_MESSAGE_CATALOG.map((m) => m.trigger);

// Catalog shape the UI grid renders: one row per message, the channels it
// supports, its office-facing label and timing.
export interface PreferenceCatalogRow {
  trigger: string;
  label: string;
  timing: string;
  description: string;
  channels: MsgChannel[];
}

export const PREFERENCE_CATALOG: PreferenceCatalogRow[] = CUSTOMER_MESSAGE_CATALOG.map((m) => ({
  trigger: m.trigger,
  label: m.label,
  timing: m.timing,
  description: m.description,
  channels: m.channels.map((c) => c.channel),
}));

// Quick membership check used by the send paths — only customer messages are
// pref-gated; transactional sends (reset/invite) and non-catalog triggers
// (invoice_sent, payment_received, …) are never suppressed by this layer.
const PREFERENCE_TRIGGER_SET = new Set(PREFERENCE_TRIGGERS);
export function isPreferenceTrigger(trigger: string): boolean {
  return PREFERENCE_TRIGGER_SET.has(trigger);
}

// ── Migration ────────────────────────────────────────────────────────────────
// Sparse override table. NOTE the distinct name: a `notification_prefs` table
// already exists for TECH push prefs (messages_push / new_jobs_push) — this is
// a different thing (customer-facing message/channel control), so it gets its
// own clearly-named table to avoid any collision.
export async function runNotificationPreferencesMigration(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS customer_notification_preferences (
      id          SERIAL PRIMARY KEY,
      company_id  INTEGER NOT NULL,
      scope_type  TEXT NOT NULL,
      scope_id    INTEGER NOT NULL,
      trigger     TEXT NOT NULL,
      channel     TEXT NOT NULL,
      enabled     BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, scope_type, scope_id, trigger, channel)
    )`);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_cnp_scope
      ON customer_notification_preferences (company_id, scope_type, scope_id)`);
}

// ── Read: overrides for one scope (drives the UI grid) ───────────────────────
// Returns the sparse override map keyed `${trigger}:${channel}` → enabled.
// Absence of a key means "default (on)". Never throws.
export async function getScopeOverrides(
  companyId: number,
  scopeType: PrefScopeType,
  scopeId: number,
): Promise<Record<string, boolean>> {
  try {
    const r = await db.execute(sql`
      SELECT trigger, channel, enabled
        FROM customer_notification_preferences
       WHERE company_id = ${companyId}
         AND scope_type = ${scopeType}
         AND scope_id = ${scopeId}`);
    const out: Record<string, boolean> = {};
    for (const row of (r as any).rows as any[]) {
      out[`${row.trigger}:${row.channel}`] = !!row.enabled;
    }
    return out;
  } catch (err) {
    console.error("[notif-prefs] getScopeOverrides failed (non-fatal):", err);
    return {};
  }
}

// ── Write: replace the override set for a scope ──────────────────────────────
// Receives the FULL desired override map (only the entries the office wants
// stored as explicit overrides). To keep the table sparse, an entry equal to
// the tenant default (enabled=true) is DELETED rather than stored — so the row
// set always means "these are the deviations from default-on". An entry with
// enabled=false is upserted. Entries omitted from `overrides` are left
// untouched ONLY if `replace` is false; with replace=true the scope's whole set
// is reconciled to exactly `overrides`.
export async function setScopeOverrides(
  companyId: number,
  scopeType: PrefScopeType,
  scopeId: number,
  overrides: Array<{ trigger: string; channel: string; enabled: boolean }>,
): Promise<void> {
  // Validate triggers/channels against the catalog so a typo can't poison the
  // table with rows that never match a real send.
  const valid = overrides.filter(
    (o) => PREFERENCE_TRIGGER_SET.has(o.trigger) && (o.channel === "email" || o.channel === "sms"),
  );
  // Full reconcile: delete the scope's existing rows, then insert only the
  // explicit OFFs. enabled=true == default, so we don't persist it (keeps the
  // table sparse and "no row = on" invariant intact).
  await db.execute(sql`
    DELETE FROM customer_notification_preferences
     WHERE company_id = ${companyId} AND scope_type = ${scopeType} AND scope_id = ${scopeId}`);
  for (const o of valid) {
    if (o.enabled) continue; // default-on → no row
    await db.execute(sql`
      INSERT INTO customer_notification_preferences
        (company_id, scope_type, scope_id, trigger, channel, enabled, updated_at)
      VALUES (${companyId}, ${scopeType}, ${scopeId}, ${o.trigger}, ${o.channel}, false, NOW())
      ON CONFLICT (company_id, scope_type, scope_id, trigger, channel)
        DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`);
  }
}

// Convenience: turn EVERY (trigger, channel) off for a scope in one shot — the
// "none" button for PPM-style accounts.
export async function setAllOff(
  companyId: number,
  scopeType: PrefScopeType,
  scopeId: number,
): Promise<void> {
  const all: Array<{ trigger: string; channel: string; enabled: boolean }> = [];
  for (const m of PREFERENCE_CATALOG) {
    for (const ch of m.channels) all.push({ trigger: m.trigger, channel: ch, enabled: false });
  }
  await setScopeOverrides(companyId, scopeType, scopeId, all);
}

// ── Resolve the scope for a client (client vs account) ───────────────────────
// Joins clients → accounts once. Returns the scope the send paths should consult
// for THIS client's jobs. Never throws (falls back to client scope).
export interface ResolvedScope {
  scopeType: PrefScopeType;
  scopeId: number;
  accountId: number | null;
}
export async function resolveScopeForClient(
  clientId: number | null | undefined,
): Promise<ResolvedScope | null> {
  if (!clientId) return null;
  try {
    const r = await db.execute(sql`
      SELECT id, account_id FROM clients WHERE id = ${clientId} LIMIT 1`);
    const row = (r as any).rows?.[0];
    if (!row) return null;
    const accountId = row.account_id != null ? Number(row.account_id) : null;
    return accountId
      ? { scopeType: "account", scopeId: accountId, accountId }
      : { scopeType: "client", scopeId: Number(row.id), accountId: null };
  } catch (err) {
    console.error("[notif-prefs] resolveScopeForClient failed (non-fatal):", err);
    return { scopeType: "client", scopeId: Number(clientId), accountId: null };
  }
}

// ── THE send-time gate ───────────────────────────────────────────────────────
// Resolves account → client → tenant-default and answers "should this message,
// on this channel, go to this client?" SAFE DEFAULT: returns TRUE on any
// missing input, missing row, or error. Only an explicit enabled=false override
// suppresses. This is deliberate — a wrong gate here regresses to "nobody gets
// notifications", the exact bug the prior session spent a day fixing.
//
// Pass EITHER a clientId (the helper resolves the scope) OR a pre-resolved
// scope (cron loops that already know it, to avoid a per-job extra query).
export async function isMessageEnabledForJob(
  args: {
    companyId: number;
    clientId?: number | null;
    scope?: ResolvedScope | null;
  },
  trigger: string,
  channel: MsgChannel | string,
): Promise<boolean> {
  // Non-catalog triggers are never gated by this layer.
  if (!PREFERENCE_TRIGGER_SET.has(trigger)) return true;
  try {
    const scope = args.scope ?? (await resolveScopeForClient(args.clientId));
    if (!scope) return true; // can't resolve → default on
    const r = await db.execute(sql`
      SELECT enabled
        FROM customer_notification_preferences
       WHERE company_id = ${args.companyId}
         AND scope_type = ${scope.scopeType}
         AND scope_id = ${scope.scopeId}
         AND trigger = ${trigger}
         AND channel = ${channel}
       LIMIT 1`);
    const row = (r as any).rows?.[0];
    if (!row) return true; // no override → default on
    return !!row.enabled;
  } catch (err) {
    console.error("[notif-prefs] isMessageEnabledForJob failed (non-fatal, defaulting ON):", err);
    return true;
  }
}
