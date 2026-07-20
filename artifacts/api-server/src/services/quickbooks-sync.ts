import crypto from "crypto";
import { db } from "@workspace/db";
import {
  companiesTable,
  clientsTable,
  invoicesTable,
  jobsTable,
  paymentsTable,
  qbSyncQueueTable,
  qbCustomerMapTable,
  notificationLogTable,
  accountsTable,
  accountContactsTable,
} from "@workspace/db/schema";
import { eq, and, sql, max } from "drizzle-orm";

// ── Crypto helpers ─────────────────────────────────────────────────────────
function getEncKey(): Buffer {
  return crypto.createHash("sha256").update(process.env.JWT_SECRET || "qleno-default-key").digest();
}
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncKey(), iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}
export function decrypt(encoded: string): string {
  try {
    const data = Buffer.from(encoded, "base64");
    const iv = data.subarray(0, 16);
    const tag = data.subarray(16, 32);
    const enc = data.subarray(32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", getEncKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return encoded; // fallback: return as-is (for unencrypted legacy values)
  }
}

// ── QB API base URL ────────────────────────────────────────────────────────
export function getQbBaseUrl(): string {
  return process.env.NODE_ENV === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}
const QB_MV = "minorversion=65";
const QB_ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";
export { QB_ACCOUNTING_SCOPE };

// ── [qbo-ar-only 2026-07-20] Push mode: cash-basis, A/R-invoices-only ────────
// Problem this fixes: marking a job/invoice paid used to push BOTH a QBO Invoice
// AND a QBO Payment. The Payment (no DepositToAccountRef) landed in Undeposited
// Funds. But real money already arrives via the payment processors' own bank
// deposits (Stripe/Square) — so every card sale was counted twice and
// Undeposited Funds grew forever. Phes is cash-basis.
//
// New default behavior ('ar_invoices_only'):
//   • A QBO Payment / SalesReceipt is NEVER created (see syncPayment).
//   • A QBO Invoice is created ONLY for clients/accounts we bill on account
//     terms and wait for a check/ACH (billing types below) — so we keep A/R
//     for them. The office matches the eventual bank deposit to the open QBO
//     invoice manually.
//   • Card-on-file clients (and every other non-A/R billing type: zelle, cash,
//     the default 'manual', unknown) push NOTHING — no invoice, no payment.
//     Their income is recognized from the processor's bank deposit only.
//
// Reversible kill-switch: set QBO_PUSH_MODE=legacy in the Railway env to restore
// the original invoice+payment-for-everyone behavior. The old code paths are
// preserved below, just gated — nothing was deleted.
export type QboPushMode = "ar_invoices_only" | "legacy";
export function getQboPushMode(): QboPushMode {
  return (process.env.QBO_PUSH_MODE || "").toLowerCase() === "legacy"
    ? "legacy"
    : "ar_invoices_only";
}

// Billing types that require A/R in QBO (we send a bill and wait for payment).
// Covers both residential clients.payment_method (free text) and commercial
// accounts.payment_method (enum: card_on_file | check | ach | invoice_only).
const QBO_AR_BILLING_TYPES = new Set(["check", "ach", "net_30", "invoice_only"]);
export function billingTypeNeedsQboInvoice(paymentMethod: string | null | undefined): boolean {
  return QBO_AR_BILLING_TYPES.has((paymentMethod || "").trim().toLowerCase());
}

// Resolve the governing billing type for an invoice. Residential per-visit
// invoices carry client_id → use clients.payment_method. Commercial account
// invoices carry account_id (client_id NULL) → use accounts.payment_method.
// client_id wins when both are present (a residential client under an account
// is still billed by the client's own method).
async function resolveInvoiceBillingType(
  companyId: number,
  invoice: { client_id: number | null; account_id: number | null },
): Promise<string | null> {
  if (invoice.client_id) {
    const [c] = await db
      .select({ pm: clientsTable.payment_method })
      .from(clientsTable)
      .where(and(eq(clientsTable.id, invoice.client_id), eq(clientsTable.company_id, companyId)))
      .limit(1);
    return c?.pm ?? null;
  }
  if (invoice.account_id) {
    const [a] = await db
      .select({ pm: accountsTable.payment_method })
      .from(accountsTable)
      .where(and(eq(accountsTable.id, invoice.account_id), eq(accountsTable.company_id, companyId)))
      .limit(1);
    return a?.pm ?? null;
  }
  return null;
}

// ── Module-level caches ───────────────────────────────────────────────────
const serviceItemCache = new Map<number, string>(); // companyId → QB item ID
const qbCompanyCache = new Map<number, { realmId: string; token: string }>(); // companyId → QB info
// Per-tenant cache: "Net 30" → QB Term Id. First lookup queries QB, subsequent reuse.
const termRefCache = new Map<number, Map<string, string | null>>();

/**
 * Look up the QB Term Id for "Net N" days. Per-tenant cached.
 * Returns null if net_terms <= 0, term not found, or QB call fails —
 * caller should omit SalesTermRef in that case (QB will default to Due on Receipt).
 */
async function getQbTermRef(token: string, realmId: string, companyId: number, netTerms: number): Promise<string | null> {
  if (!netTerms || netTerms <= 0) return null;
  const termName = `Net ${netTerms}`;
  let cache = termRefCache.get(companyId);
  if (!cache) { cache = new Map(); termRefCache.set(companyId, cache); }
  if (cache.has(termName)) return cache.get(termName) ?? null;
  try {
    const q = await qbGet(token, realmId, `/query?query=${encodeURIComponent(`SELECT Id, Name FROM Term WHERE Name = '${termName}'`)}&`);
    const id = q.QueryResponse?.Term?.[0]?.Id ?? null;
    cache.set(termName, id);
    return id;
  } catch (err: any) {
    console.warn(`[QB] getQbTermRef failed for ${termName} (company ${companyId}):`, err.message);
    cache.set(termName, null);
    return null;
  }
}

// ── Token management ───────────────────────────────────────────────────────
export async function getValidToken(companyId: number): Promise<{ token: string; realmId: string } | null> {
  const [company] = await db
    .select({
      qb_connected: companiesTable.qb_connected,
      qb_access_token: companiesTable.qb_access_token,
      qb_refresh_token: companiesTable.qb_refresh_token,
      qb_realm_id: companiesTable.qb_realm_id,
      qb_token_expires_at: companiesTable.qb_token_expires_at,
    })
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId))
    .limit(1);

  if (!company || !company.qb_connected || !company.qb_access_token || !company.qb_realm_id) {
    return null;
  }

  const expiresAt = company.qb_token_expires_at ? new Date(company.qb_token_expires_at) : null;
  const thirtyMin = 30 * 60 * 1000;
  const needsRefresh = !expiresAt || expiresAt.getTime() - Date.now() < thirtyMin;

  if (!needsRefresh) {
    return { token: decrypt(company.qb_access_token), realmId: company.qb_realm_id };
  }

  // Refresh token
  return refreshQBToken(companyId, decrypt(company.qb_refresh_token!), company.qb_realm_id);
}

export async function refreshQBToken(companyId: number, refreshToken: string, realmId: string): Promise<{ token: string; realmId: string } | null> {
  try {
    const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString("base64");
    const resp = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${creds}`,
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });

    if (!resp.ok) {
      await markDisconnected(companyId);
      return null;
    }

    const data = await resp.json();
    const expiresAt = new Date(Date.now() + data.expires_in * 1000);

    // Intuit usually rotates the refresh_token on each access-token refresh, but the
    // bearer response can omit it. Only overwrite when present so we don't blow away
    // the existing refresh_token with `encrypt(undefined)`.
    const updates: Partial<typeof companiesTable.$inferInsert> = {
      qb_access_token: encrypt(data.access_token),
      qb_token_expires_at: expiresAt,
    };
    if (data.refresh_token) {
      updates.qb_refresh_token = encrypt(data.refresh_token);
    }

    await db
      .update(companiesTable)
      .set(updates)
      .where(eq(companiesTable.id, companyId));

    serviceItemCache.delete(companyId);
    return { token: data.access_token, realmId };
  } catch (err) {
    console.error("[QB] Token refresh failed:", err);
    await markDisconnected(companyId);
    return null;
  }
}

async function markDisconnected(companyId: number) {
  await db
    .update(companiesTable)
    .set({ qb_connected: false })
    .where(eq(companiesTable.id, companyId));

  // In-app notification to owner
  await db.insert(notificationLogTable).values({
    company_id: companyId,
    recipient: "owner",
    channel: "in_app",
    trigger: "qb_token_expired",
    status: "sent",
    metadata: { message: "Your QuickBooks connection has expired. Reconnect in Settings → Integrations to resume syncing." } as any,
  }).catch(() => {});
}

// ── QB API helpers ─────────────────────────────────────────────────────────
async function qbGet(token: string, realmId: string, path: string): Promise<any> {
  const base = getQbBaseUrl();
  const url = `${base}/v3/company/${realmId}${path}&${QB_MV}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`QB GET ${path} → ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function qbPost(token: string, realmId: string, path: string, body: object): Promise<any> {
  const base = getQbBaseUrl();
  // [qb-post-querysep 2026-07-03] Use '&' when the path already carries a query
  // string (e.g. "/invoice?operation=delete" / "?operation=void"), else '?'.
  // The old unconditional '?' produced "/invoice?operation=delete?minorversion=X"
  // — QB parsed operation as "delete?minorversion=X" and ignored it, so delete
  // AND void POSTs silently no-op'd (0 rows changed). This is why the first
  // dedupe apply deleted nothing.
  const sep = path.includes("?") ? "&" : "?";
  const url = `${base}/v3/company/${realmId}${path}${sep}${QB_MV}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`QB POST ${path} → ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ── Customer dedup lookup ──────────────────────────────────────────────────
// Match by PrimaryEmailAddr first, then DisplayName. Returns the QB Customer Id
// if a match exists, else null. Quote single-quotes per QB's QBO query syntax.
async function findExistingQbCustomer(
  token: string,
  realmId: string,
  email: string | null | undefined,
  displayName: string | null | undefined,
): Promise<string | null> {
  const qbQuote = (s: string) => s.replace(/'/g, "\\'");
  try {
    if (email) {
      const q = await qbGet(
        token,
        realmId,
        `/query?query=${encodeURIComponent(
          `SELECT Id, DisplayName, PrimaryEmailAddr FROM Customer WHERE PrimaryEmailAddr = '${qbQuote(email)}' MAXRESULTS 1`,
        )}&`,
      );
      const hit = q.QueryResponse?.Customer?.[0]?.Id;
      if (hit) return hit;
    }
    if (displayName) {
      const q = await qbGet(
        token,
        realmId,
        `/query?query=${encodeURIComponent(
          `SELECT Id, DisplayName FROM Customer WHERE DisplayName = '${qbQuote(displayName)}' MAXRESULTS 1`,
        )}&`,
      );
      const hit = q.QueryResponse?.Customer?.[0]?.Id;
      if (hit) return hit;
    }
  } catch (e: any) {
    console.warn(`[QB] findExistingQbCustomer failed (non-fatal):`, e.message);
  }
  return null;
}

// ── Invoice dedup lookup ───────────────────────────────────────────────────
// [qb-history-guard 2026-07-09] Adopt-by-DocNumber is now VERIFIED. The 07-03
// version adopted ANY QB invoice carrying the same DocNumber (oldest wins) and
// then updated it. That was written for retry-dedup of OUR OWN pushes, but it
// could not tell them apart from pre-Qleno history: when the Qleno number
// sequence collided with MaidCentral-era numbers (e.g. #6390), the sync
// ADOPTED the historical May invoice (De Arruda $195, QB txn 18065) and
// rewrote it into a July invoice (Cucci $150) — destroying the historical
// record. ~20+ Apr/May invoices were corrupted this way (see qb_sync_queue
// rows whose qb_entity_id is in the 179xx–180xx range).
//
// The fix: only adopt a same-DocNumber QB invoice when it demonstrably IS a
// prior push of THIS invoice — same CustomerRef and same TotalAmt (±1¢).
// Anything else is a doc-number collision with a foreign/historical invoice:
// return null so the caller CREATES a fresh QB invoice (QBO permits duplicate
// DocNumbers) and log loudly so the collision is visible.
async function findExistingQbInvoiceByDoc(
  token: string,
  realmId: string,
  docNumber: string,
  expectedCustomerId: string,
  expectedTotal: number,
  cutoverDate: string | null, // 'YYYY-MM-DD' — never adopt a QB invoice dated before this
): Promise<{ adoptId: string | null; collision: boolean }> {
  const qbQuote = (s: string) => s.replace(/'/g, "\\'");
  try {
    const q = await qbGet(
      token,
      realmId,
      `/query?query=${encodeURIComponent(
        `SELECT Id, DocNumber, TxnDate, TotalAmt, CustomerRef FROM Invoice WHERE DocNumber = '${qbQuote(docNumber)}'`,
      )}&`,
    );
    const hits: any[] = q.QueryResponse?.Invoice ?? [];
    for (const hit of hits) {
      const custMatch = String(hit.CustomerRef?.value ?? "") === String(expectedCustomerId);
      const amtMatch = Math.abs(Number(hit.TotalAmt ?? 0) - expectedTotal) < 0.01;
      // [qb-cutover-adopt-guard 2026-07-10] customer+amount matching CANNOT
      // distinguish a recurring client's May visit from their July visit (same
      // customer, same weekly price). The hard invariant: an invoice dated
      // before the tenant's qb_sync_start_date belongs to the PRIOR system's
      // history and must never be adopted, no matter how well it matches.
      const dateOk = !cutoverDate || String(hit.TxnDate ?? "") >= cutoverDate;
      if (custMatch && amtMatch && dateOk) return { adoptId: String(hit.Id), collision: false };
    }
    if (hits.length > 0) {
      console.warn(
        `[QB] DocNumber collision: ${hits.length} QB invoice(s) already carry #${docNumber} ` +
        `but none match customer ${expectedCustomerId} @ ${expectedTotal} — will create a NEW QB invoice ` +
        `under a suffixed DocNumber, NOT adopting. Existing ids: ${hits.map((h) => h.Id).join(",")}`,
      );
      return { adoptId: null, collision: true };
    }
    return { adoptId: null, collision: false };
  } catch (e: any) {
    console.warn(`[QB] findExistingQbInvoiceByDoc failed (non-fatal):`, e.message);
    return { adoptId: null, collision: false };
  }
}

// ── Service item resolution ────────────────────────────────────────────────
async function getOrCreateServiceItem(token: string, realmId: string, companyId: number): Promise<string> {
  if (serviceItemCache.has(companyId)) return serviceItemCache.get(companyId)!;

  try {
    const query = encodeURIComponent("SELECT * FROM Item WHERE Type = 'Service' MAXRESULTS 1");
    const data = await qbGet(token, realmId, `/query?query=${query}`);
    const items = data.QueryResponse?.Item || [];
    if (items.length > 0) {
      serviceItemCache.set(companyId, items[0].Id);
      return items[0].Id;
    }

    // No service item — create "Cleaning Services"
    const acctQuery = encodeURIComponent("SELECT * FROM Account WHERE AccountType = 'Income' MAXRESULTS 1");
    const acctData = await qbGet(token, realmId, `/query?query=${acctQuery}`);
    const accounts = acctData.QueryResponse?.Account || [];
    const incomeAcctRef = accounts.length > 0 ? { value: accounts[0].Id, name: accounts[0].Name } : { value: "1" };

    const createData = await qbPost(token, realmId, "/item", {
      Name: "Cleaning Services",
      Type: "Service",
      IncomeAccountRef: incomeAcctRef,
    });
    const itemId = createData.Item?.Id || "1";
    serviceItemCache.set(companyId, itemId);
    return itemId;
  } catch {
    return "1"; // fallback
  }
}

// ── Queue helper ───────────────────────────────────────────────────────────
async function upsertQueue(companyId: number, entityType: string, entityId: number, status: string, qbEntityId?: string, error?: string) {
  const [existing] = await db
    .select({ id: qbSyncQueueTable.id, attempts: qbSyncQueueTable.attempts })
    .from(qbSyncQueueTable)
    .where(and(eq(qbSyncQueueTable.company_id, companyId), eq(qbSyncQueueTable.entity_type, entityType), eq(qbSyncQueueTable.entity_id, entityId)))
    .limit(1);

  if (existing) {
    await db
      .update(qbSyncQueueTable)
      .set({
        status,
        qb_entity_id: qbEntityId ?? undefined,
        last_error: error ?? null,
        attempts: status === "failed" ? existing.attempts + 1 : existing.attempts,
        updated_at: new Date(),
      })
      .where(eq(qbSyncQueueTable.id, existing.id));
  } else {
    await db.insert(qbSyncQueueTable).values({
      company_id: companyId,
      entity_type: entityType,
      entity_id: entityId,
      status,
      qb_entity_id: qbEntityId,
      last_error: error,
      attempts: status === "failed" ? 1 : 0,
    });
  }
}

async function notifyOwnerSyncFailed(companyId: number, message: string) {
  await db.insert(notificationLogTable).values({
    company_id: companyId,
    recipient: "owner",
    channel: "in_app",
    trigger: "qb_sync_failed",
    status: "sent",
    metadata: { message } as any,
  }).catch(() => {});
}

// ── SYNC CUSTOMER ──────────────────────────────────────────────────────────
export async function syncCustomer(companyId: number, customerId: number): Promise<void> {
  try {
    const auth = await getValidToken(companyId);
    if (!auth) return; // not connected

    const [client] = await db
      .select()
      .from(clientsTable)
      .where(and(eq(clientsTable.id, customerId), eq(clientsTable.company_id, companyId)))
      .limit(1);
    if (!client) return;

    const { token, realmId } = auth;

    // Check existing map
    const [map] = await db
      .select()
      .from(qbCustomerMapTable)
      .where(and(eq(qbCustomerMapTable.company_id, companyId), eq(qbCustomerMapTable.qleno_customer_id, customerId)))
      .limit(1);

    const payload: any = {
      DisplayName: `${client.first_name} ${client.last_name}`.trim() || `Client ${customerId}`,
      GivenName: client.first_name || undefined,
      FamilyName: client.last_name || undefined,
    };
    if (client.email) payload.PrimaryEmailAddr = { Address: client.email };
    if ((client as any).phone) payload.PrimaryPhone = { FreeFormNumber: (client as any).phone };
    if ((client as any).address) {
      payload.BillAddr = {
        Line1: (client as any).address,
        City: (client as any).city || undefined,
        CountrySubDivisionCode: (client as any).state || undefined,
        PostalCode: (client as any).zip || undefined,
      };
    }

    // SalesTermRef — set only when client has net_terms > 0 AND QB has a matching Term entry.
    const clientNetTerms = Number((client as any).net_terms ?? 0) || 0;
    if (clientNetTerms > 0) {
      const termRef = await getQbTermRef(token, realmId, companyId, clientNetTerms);
      if (termRef) payload.SalesTermRef = { value: termRef };
    }

    let qbCustomerId: string;

    if (map?.qb_customer_id) {
      // Update existing QB customer
      const existing = await qbGet(token, realmId, `/customer/${map.qb_customer_id}?`);
      const syncToken = existing.Customer?.SyncToken;
      const updateData = await qbPost(token, realmId, "/customer", {
        ...payload,
        Id: map.qb_customer_id,
        SyncToken: syncToken,
        sparse: true,
      });
      qbCustomerId = updateData.Customer?.Id || map.qb_customer_id;
    } else {
      // No local map yet — dedup against QB first to avoid creating a duplicate
      // for a customer that already exists in QB (manual entry or earlier import).
      // Match by email first, then DisplayName.
      const existingQbId = await findExistingQbCustomer(token, realmId, client.email, payload.DisplayName);

      if (existingQbId) {
        qbCustomerId = existingQbId;
        // Refresh QB fields from Qleno (sparse merge), so the linked record stays current.
        try {
          const existing = await qbGet(token, realmId, `/customer/${qbCustomerId}?`);
          const syncToken = existing.Customer?.SyncToken;
          await qbPost(token, realmId, "/customer", {
            ...payload,
            Id: qbCustomerId,
            SyncToken: syncToken,
            sparse: true,
          });
        } catch (e: any) {
          console.warn(`[QB] dedup-merge update failed for QB customer ${qbCustomerId} (non-fatal):`, e.message);
        }
      } else {
        const createData = await qbPost(token, realmId, "/customer", payload);
        qbCustomerId = createData.Customer?.Id;
      }

      // [qb-cutover] Concurrency guard. Two near-simultaneous syncs for the
      // same client can both miss the map lookup above and each reach here.
      // The unique index (company_id, qleno_customer_id) lets the loser's
      // insert no-op; we then re-read the winner's qb_customer_id so both the
      // queue row and any invoice CustomerRef point at the single mapped QB
      // customer instead of a split-brain.
      const inserted = await db
        .insert(qbCustomerMapTable)
        .values({ company_id: companyId, qleno_customer_id: customerId, qb_customer_id: qbCustomerId })
        .onConflictDoNothing({ target: [qbCustomerMapTable.company_id, qbCustomerMapTable.qleno_customer_id] })
        .returning({ id: qbCustomerMapTable.id });

      if (inserted.length === 0) {
        const [winner] = await db
          .select({ qb_customer_id: qbCustomerMapTable.qb_customer_id })
          .from(qbCustomerMapTable)
          .where(and(eq(qbCustomerMapTable.company_id, companyId), eq(qbCustomerMapTable.qleno_customer_id, customerId)))
          .limit(1);
        if (winner?.qb_customer_id) qbCustomerId = winner.qb_customer_id;
      }
    }

    await upsertQueue(companyId, "customer", customerId, "synced", qbCustomerId);
  } catch (err: any) {
    console.error("[QB] syncCustomer failed:", err.message);
    await upsertQueue(companyId, "customer", customerId, "failed", undefined, err.message);

    // Check attempt count and notify if threshold hit
    const [entry] = await db
      .select({ attempts: qbSyncQueueTable.attempts })
      .from(qbSyncQueueTable)
      .where(and(eq(qbSyncQueueTable.company_id, companyId), eq(qbSyncQueueTable.entity_type, "customer"), eq(qbSyncQueueTable.entity_id, customerId)))
      .limit(1);
    if (entry && entry.attempts >= 3) {
      await notifyOwnerSyncFailed(companyId, `QuickBooks sync failed for Customer ID ${customerId}. Go to Settings → Integrations to review.`);
    }
  }
}

// ── SYNC INVOICE ──────────────────────────────────────────────────────────
// [qb-account-customer 2026-07-03] Account invoices have client_id=NULL — the
// account is the billing entity. QB still needs a Customer, so resolve/create
// one from the account (DisplayName = account name; email/phone from the primary
// contact). Find-or-create by name/email each time — idempotent via QB's own
// dedup, so no local account→QB map table is needed. Without this, every account
// invoice failed with "No QB customer mapping for client null" (all the newly
// converted commercial accounts: PPM, KMA, National Able, etc.).
async function resolveAccountQbCustomer(
  token: string, realmId: string, companyId: number, accountId: number,
): Promise<string | null> {
  const [acct] = await db
    .select({ name: accountsTable.account_name })
    .from(accountsTable)
    .where(and(eq(accountsTable.id, accountId), eq(accountsTable.company_id, companyId)))
    .limit(1);
  if (!acct?.name) return null;
  const [contact] = await db
    .select({ email: accountContactsTable.email, phone: accountContactsTable.phone })
    .from(accountContactsTable)
    .where(and(eq(accountContactsTable.account_id, accountId), eq(accountContactsTable.company_id, companyId)))
    .orderBy(sql`is_primary DESC, id ASC`)
    .limit(1);
  const displayName = acct.name;
  const existing = await findExistingQbCustomer(token, realmId, contact?.email ?? null, displayName);
  if (existing) return existing;
  const payload: any = { DisplayName: displayName, CompanyName: displayName };
  if (contact?.email) payload.PrimaryEmailAddr = { Address: contact.email };
  if (contact?.phone) payload.PrimaryPhone = { FreeFormNumber: contact.phone };
  const created = await qbPost(token, realmId, "/customer", payload);
  return created.Customer?.Id ?? null;
}

export async function syncInvoice(companyId: number, invoiceId: number): Promise<void> {
  try {
    const auth = await getValidToken(companyId);
    if (!auth) return;

    const [invoice] = await db
      .select()
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, companyId)))
      .limit(1);
    if (!invoice) return;

    // [qb-draft-guard 2026-07-09] Never push a draft/void/superseded invoice.
    // Drafts are working documents — several landed in QB as open receivables
    // (e.g. ACC-4, ACC-26, #6322) and became phantom/double A/R. Void cleanup
    // goes through voidQbInvoice, not a push. A draft that later issues will
    // sync on the issue transition like every other invoice.
    if (invoice.status === "draft" || invoice.status === "void" || invoice.status === "superseded") {
      await upsertQueue(companyId, "invoice", invoiceId, "skipped", undefined, `not pushed: status=${invoice.status}`);
      return;
    }

    // [qb-cutover] Cutover guard. Tenants migrating from another system that
    // already feeds the SAME QuickBooks company (e.g. Oak Lawn ← MaidCentral)
    // set companies.qb_sync_start_date. Any invoice created before the cutover
    // is never pushed — only invoices from the cutover forward — so we never
    // re-push the history the prior system already sent. NULL = sync all
    // (clean-slate tenants like Schaumburg are unaffected).
    const [cutoverCo] = await db
      .select({ cutover: companiesTable.qb_sync_start_date })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .limit(1);
    // Gate on the SERVICE date, not the invoice's created date. A per-visit
    // invoice carries job_id, so a July-1-forward job that happened to be
    // invoiced before the cutover (e.g. during the MC→Qleno reconciliation)
    // still pushes. Batch/no-job invoices fall back to created_at.
    let effectiveDate: Date | null = invoice.created_at ? new Date(invoice.created_at) : null;
    if (invoice.job_id) {
      const [jb] = await db
        .select({ d: jobsTable.scheduled_date })
        .from(jobsTable)
        .where(eq(jobsTable.id, invoice.job_id))
        .limit(1);
      if (jb?.d) effectiveDate = new Date(jb.d as any);
    }
    if (cutoverCo?.cutover && effectiveDate && effectiveDate < new Date(cutoverCo.cutover)) {
      await upsertQueue(companyId, "invoice", invoiceId, "skipped", undefined, "before qb_sync_start_date cutover");
      return;
    }

    // [qbo-ar-only 2026-07-20] A/R-invoices-only gate. Under the default push
    // mode we push an Invoice ONLY for clients/accounts billed on account terms
    // (check / ach / net_30 / invoice_only). Card-on-file and every other
    // billing type (zelle, cash, the default 'manual', unknown) push NOTHING —
    // their revenue comes from the processor's own bank deposits, so a QBO
    // invoice+payment would double-count it. 'legacy' mode restores the old
    // push-for-everyone behavior. Customer sync is unaffected (its own path).
    if (getQboPushMode() !== "legacy") {
      const billingType = await resolveInvoiceBillingType(companyId, invoice);
      if (!billingTypeNeedsQboInvoice(billingType)) {
        await upsertQueue(
          companyId,
          "invoice",
          invoiceId,
          "skipped",
          undefined,
          `qbo push mode ar_invoices_only: billing_type=${billingType ?? "none"} is not A/R (card-on-file/other → nothing pushed)`,
        );
        return;
      }
    }

    const { token, realmId } = auth;

    // Ensure customer is synced first
    if (invoice.client_id) {
      await syncCustomer(companyId, invoice.client_id);
    }

    // Get QB customer ID
    let qbCustomerId: string | null = null;
    if (invoice.client_id) {
      const [map] = await db
        .select({ qb_customer_id: qbCustomerMapTable.qb_customer_id })
        .from(qbCustomerMapTable)
        .where(and(eq(qbCustomerMapTable.company_id, companyId), eq(qbCustomerMapTable.qleno_customer_id, invoice.client_id)))
        .limit(1);
      qbCustomerId = map?.qb_customer_id ?? null;
    }

    // Account invoice (client_id NULL): resolve the QB customer from the account.
    if (!qbCustomerId && invoice.account_id) {
      qbCustomerId = await resolveAccountQbCustomer(token, realmId, companyId, invoice.account_id);
    }

    if (!qbCustomerId) {
      throw new Error(`No QB customer mapping for invoice ${invoiceId} (client ${invoice.client_id}, account ${invoice.account_id})`);
    }

    const serviceItemId = await getOrCreateServiceItem(token, realmId, companyId);

    // Build line items
    const lineItems: any[] = [];
    const rawLines = (invoice.line_items as any[]) || [];

    if (rawLines.length > 0) {
      for (const line of rawLines) {
        const amount = parseFloat(line.amount ?? line.total ?? line.unit_price ?? "0");
        // Skip only true zero/NaN lines. Discounts (auto-promo or manual) are
        // stored as NEGATIVE-total lines; QBO accepts a negative-Amount
        // SalesItemLine, so pushing them keeps the QB invoice total equal to
        // Qleno's net total. Previously the `amount > 0` guard DROPPED every
        // discount line, so QB overstated each discounted invoice by the
        // discount amount (e.g. Qleno $367.20 vs QB $432.00).
        if (Number.isNaN(amount) || amount === 0) continue;
        lineItems.push({
          DetailType: "SalesItemLineDetail",
          Amount: amount,
          Description: line.description || line.name || (amount < 0 ? "Discount" : "Cleaning Service"),
          SalesItemLineDetail: { ItemRef: { value: serviceItemId } },
        });
      }
    }

    // Tips as separate line
    const tipsAmt = parseFloat(invoice.tips || "0");
    if (tipsAmt > 0) {
      lineItems.push({
        DetailType: "SalesItemLineDetail",
        Amount: tipsAmt,
        Description: "Tip",
        SalesItemLineDetail: { ItemRef: { value: serviceItemId } },
      });
    }

    // Fallback: single total line if no line items
    if (lineItems.length === 0) {
      const total = parseFloat(invoice.total || "0");
      if (total > 0) {
        lineItems.push({
          DetailType: "SalesItemLineDetail",
          Amount: total,
          Description: `Invoice ${invoice.invoice_number || invoiceId}`,
          SalesItemLineDetail: { ItemRef: { value: serviceItemId } },
        });
      }
    }

    const qbInvoicePayload: any = {
      CustomerRef: { value: qbCustomerId },
      // [qb-docnumber 2026-07-03] QB's DocNumber max is 21 chars; account
      // per-job numbers (ACC-{id}-{jobid}-{ts}) exceed it and QB rejects the
      // invoice ("String length is too long"). Truncate to the last 21 chars
      // (keeps the most-unique tail).
      DocNumber: (invoice.invoice_number || String(invoiceId)).slice(-21),
      TxnDate: invoice.created_at ? new Date(invoice.created_at).toISOString().split("T")[0] : new Date().toISOString().split("T")[0],
      DueDate: invoice.due_date || undefined,
      Line: lineItems,
    };

    let qbInvoiceId: string;

    if (invoice.qbo_invoice_id) {
      // Update existing
      const existing = await qbGet(token, realmId, `/invoice/${invoice.qbo_invoice_id}?`);
      const syncToken = existing.Invoice?.SyncToken;
      const updateData = await qbPost(token, realmId, "/invoice", {
        ...qbInvoicePayload,
        Id: invoice.qbo_invoice_id,
        SyncToken: syncToken,
        sparse: false,
      });
      qbInvoiceId = updateData.Invoice?.Id || invoice.qbo_invoice_id;
    } else {
      // ── Create path — the ONLY place a duplicate can form ─────────────────
      // Two guards, layered:
      //
      // [qb-invoice-idempotency 2026-07-03, hardened 2026-07-09] (a) VERIFIED
      // find-by-DocNumber: before creating, check QB for an invoice already
      // carrying this DocNumber that ALSO matches this invoice's customer and
      // total — i.e. it is demonstrably our own earlier push (retry after a
      // crash between create and persist). Only then adopt + update. A
      // same-number invoice belonging to a different customer/amount is
      // pre-Qleno history (MaidCentral era) — NEVER adopt it; create a new QB
      // invoice instead. The unverified version of this guard rewrote ~20+
      // historical Apr/May invoices when the number sequences collided.
      //
      // [qb-invoice-lock 2026-07-03] (b) per-invoice advisory lock: serialize
      // concurrent syncs of THIS invoice so two SIMULTANEOUS first-time creates
      // can't both run the DocNumber check, both find nothing, and both create.
      // pg_advisory_xact_lock is transaction-scoped (auto-releases on commit —
      // no pooled-connection release mismatch like the session-scoped form) and
      // DB-level (so it holds ACROSS Railway instances, not just in-process).
      // Keyed on (namespace, invoiceId): different invoices never block or wait
      // on each other, so throughput is unaffected — only a genuine same-invoice
      // race waits (~one QB round-trip). Re-read qbo_invoice_id inside the lock
      // in case a racing sync just created + stored it while we waited. The lock
      // engages ONLY on first-time sync; every later re-sync takes the lock-free
      // update path above. Tradeoff: the QB round-trip runs inside the tx, so a
      // first-time sync briefly holds one pool connection — bounded per-invoice
      // and acceptable; revisit with a claim-column if first-sync bursts ever
      // pressure the pool.
      const QB_INV_LOCK_NS = 4243;
      const expectedTotal = parseFloat(invoice.total || "0");
      qbInvoiceId = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${QB_INV_LOCK_NS}, ${invoiceId})`);

        const [fresh] = await tx
          .select({ qbo: invoicesTable.qbo_invoice_id })
          .from(invoicesTable)
          .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, companyId)))
          .limit(1);

        const docNumber = (invoice.invoice_number || String(invoiceId)).slice(-21);
        let targetId: string | null = fresh?.qbo ?? null;
        let collision = false;
        if (!targetId) {
          const cutoverStr = cutoverCo?.cutover ? new Date(cutoverCo.cutover).toISOString().slice(0, 10) : null;
          const found = await findExistingQbInvoiceByDoc(token, realmId, docNumber, qbCustomerId!, expectedTotal, cutoverStr);
          targetId = found.adoptId;
          collision = found.collision;
        }

        let resolvedId: string;
        if (targetId) {
          const existing = await qbGet(token, realmId, `/invoice/${targetId}?`);
          const updateData = await qbPost(token, realmId, "/invoice", {
            ...qbInvoicePayload,
            Id: targetId,
            SyncToken: existing.Invoice?.SyncToken,
            sparse: false,
          });
          resolvedId = updateData.Invoice?.Id || targetId;
        } else {
          // [qb-collision-renumber 2026-07-10] If a FOREIGN QB invoice already
          // carries this DocNumber, creating with the same number is rejected
          // when QBO's duplicate-doc-number check is on (error 6140) — and the
          // failed/retried sync is exactly how the 07-10 backfill mislinked 21
          // historical invoices. Push under a unique suffixed DocNumber instead
          // ("<num>Q<qlenoId>", trimmed to QB's 21-char cap): the create
          // succeeds first try, qbo_invoice_id persists, and every later sync
          // takes the safe update path.
          if (collision) {
            const suffix = `Q${invoiceId}`;
            qbInvoicePayload.DocNumber = `${docNumber.slice(0, 21 - suffix.length)}${suffix}`;
          }
          const createData = await qbPost(token, realmId, "/invoice", qbInvoicePayload);
          resolvedId = createData.Invoice?.Id;
        }

        await tx
          .update(invoicesTable)
          .set({ qbo_invoice_id: resolvedId })
          .where(eq(invoicesTable.id, invoiceId));
        return resolvedId;
      });
    }

    await upsertQueue(companyId, "invoice", invoiceId, "synced", qbInvoiceId);
  } catch (err: any) {
    console.error("[QB] syncInvoice failed:", err.message);
    await upsertQueue(companyId, "invoice", invoiceId, "failed", undefined, err.message);

    const [entry] = await db
      .select({ attempts: qbSyncQueueTable.attempts })
      .from(qbSyncQueueTable)
      .where(and(eq(qbSyncQueueTable.company_id, companyId), eq(qbSyncQueueTable.entity_type, "invoice"), eq(qbSyncQueueTable.entity_id, invoiceId)))
      .limit(1);

    if (entry && entry.attempts >= 3) {
      const [inv] = await db
        .select({ invoice_number: invoicesTable.invoice_number })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, invoiceId))
        .limit(1);
      await notifyOwnerSyncFailed(
        companyId,
        `QuickBooks sync failed for Invoice #${inv?.invoice_number || invoiceId}. Go to Settings → Integrations to review.`
      );
    }
  }
}

// ── SYNC PAYMENT ──────────────────────────────────────────────────────────
export async function syncPayment(companyId: number, invoiceId: number): Promise<void> {
  // [qbo-ar-only 2026-07-20] Payments are NEVER pushed to QBO in the default
  // mode. Phes is cash-basis: real money already lands via the Stripe/Square
  // bank deposit (card clients) or a manually-recorded deposit (check/ACH), so
  // a QBO Payment on top double-counts revenue and inflates Undeposited Funds.
  // The check/ACH invoice stays open in QBO as A/R; the office matches the
  // deposit to it manually. Set QBO_PUSH_MODE=legacy to restore the original
  // payment-creation behavior below (preserved, just gated).
  if (getQboPushMode() !== "legacy") {
    await upsertQueue(
      companyId,
      "payment",
      invoiceId,
      "skipped",
      undefined,
      "qbo push mode ar_invoices_only: payments are never pushed to QBO",
    );
    return;
  }
  try {
    // Idempotency: if a payment for this invoice was already pushed (queue row
    // with status='synced' and a stored QB payment Id), do not double-push.
    // QB's /payment endpoint has no client-side dedup, so a retry would create
    // a duplicate Payment in the customer ledger.
    const [existingPaymentSync] = await db
      .select({ status: qbSyncQueueTable.status, qb_entity_id: qbSyncQueueTable.qb_entity_id })
      .from(qbSyncQueueTable)
      .where(and(
        eq(qbSyncQueueTable.company_id, companyId),
        eq(qbSyncQueueTable.entity_type, "payment"),
        eq(qbSyncQueueTable.entity_id, invoiceId),
      ))
      .limit(1);
    if (existingPaymentSync?.status === "synced" && existingPaymentSync.qb_entity_id) {
      return;
    }

    const auth = await getValidToken(companyId);
    if (!auth) return;

    const [invoice] = await db
      .select()
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, companyId)))
      .limit(1);
    if (!invoice || invoice.status !== "paid") return;

    const { token, realmId } = auth;

    // Ensure invoice is synced in QB
    if (!invoice.qbo_invoice_id) {
      await syncInvoice(companyId, invoiceId);
      const [refreshed] = await db.select({ qbo_invoice_id: invoicesTable.qbo_invoice_id }).from(invoicesTable).where(eq(invoicesTable.id, invoiceId)).limit(1);
      if (!refreshed?.qbo_invoice_id) throw new Error("Invoice not synced to QB, cannot create payment");
    }

    // Get QB customer ID. [qb-account-payment 2026-07-03] Mirror syncInvoice
    // (#874): a payment on an account/commercial invoice has client_id=NULL, so
    // the client→QB map returns nothing — resolve the QB customer FROM the
    // account instead. Without this, marking a KMA/PPM/Cucci invoice paid failed
    // with "No QB customer mapping for payment" and the payment never cascaded.
    let qbCustomerId: string | null = null;
    if (invoice.client_id) {
      const [map] = await db
        .select({ qb_customer_id: qbCustomerMapTable.qb_customer_id })
        .from(qbCustomerMapTable)
        .where(and(eq(qbCustomerMapTable.company_id, companyId), eq(qbCustomerMapTable.qleno_customer_id, invoice.client_id)))
        .limit(1);
      qbCustomerId = map?.qb_customer_id ?? null;
    }
    if (!qbCustomerId && invoice.account_id) {
      qbCustomerId = await resolveAccountQbCustomer(token, realmId, companyId, invoice.account_id);
    }
    if (!qbCustomerId) throw new Error("No QB customer mapping for payment");

    // Get payment record for method
    const [payment] = await db
      .select()
      .from(paymentsTable)
      .where(and(eq(paymentsTable.invoice_id, invoiceId), eq(paymentsTable.company_id, companyId)))
      .limit(1);

    const methodMap: Record<string, string> = {
      stripe: "CreditCard",
      square: "Square",
      check: "Check",
      ach: "Check",
      cash: "Cash",
      zelle: "Other",
      venmo: "Other",
    };
    const paymentMethod = methodMap[(payment?.method || "cash").toLowerCase()] || "Other";

    const re_invoice = await db.select({ qbo_invoice_id: invoicesTable.qbo_invoice_id }).from(invoicesTable).where(eq(invoicesTable.id, invoiceId)).limit(1);
    const qboInvId = re_invoice[0]?.qbo_invoice_id;

    const paymentResp = await qbPost(token, realmId, "/payment", {
      CustomerRef: { value: qbCustomerId },
      TotalAmt: parseFloat(invoice.total || "0"),
      TxnDate: invoice.paid_at ? new Date(invoice.paid_at).toISOString().split("T")[0] : new Date().toISOString().split("T")[0],
      PaymentMethodRef: { name: paymentMethod },
      Line: [
        {
          Amount: parseFloat(invoice.total || "0"),
          LinkedTxn: [{ TxnId: qboInvId, TxnType: "Invoice" }],
        },
      ],
    });

    const qbPaymentId = paymentResp.Payment?.Id;
    await upsertQueue(companyId, "payment", invoiceId, "synced", qbPaymentId);
  } catch (err: any) {
    console.error("[QB] syncPayment failed:", err.message);
    await upsertQueue(companyId, "payment", invoiceId, "failed", undefined, err.message);
  }
}

// ── VOID INVOICE ──────────────────────────────────────────────────────────
export async function voidQbInvoice(companyId: number, invoiceId: number): Promise<void> {
  try {
    const auth = await getValidToken(companyId);
    if (!auth) return;

    const [invoice] = await db
      .select({ qbo_invoice_id: invoicesTable.qbo_invoice_id })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, companyId)))
      .limit(1);

    if (!invoice?.qbo_invoice_id) return;

    const { token, realmId } = auth;
    const existing = await qbGet(token, realmId, `/invoice/${invoice.qbo_invoice_id}?`);
    const syncToken = existing.Invoice?.SyncToken;

    await qbPost(token, realmId, `/invoice?operation=void`, {
      Id: invoice.qbo_invoice_id,
      SyncToken: syncToken,
    });
  } catch (err: any) {
    console.error("[QB] voidQbInvoice failed:", err.message);
  }
}

// ── DEDUPE INVOICES ────────────────────────────────────────────────────────
// [qb-invoice-idempotency 2026-07-03, hardened 2026-07-09] One-time cleanup for
// duplicate QB invoices created before the idempotency guard landed. For every
// DocNumber that this company's synced invoices reference, query ALL matching QB
// invoices; if more than one exists, keep the CANONICAL copy (the Id stored on
// the Qleno row, else the oldest) and delete the rest.
//
// [qb-history-guard 2026-07-09] SAFETY: a copy is only deletable when it matches
// the kept canonical invoice on BOTH CustomerRef and TotalAmt (±1¢) — i.e. it is
// a true duplicate of the same bill. A same-DocNumber invoice for a DIFFERENT
// customer or amount is pre-Qleno history (MaidCentral-era numbering overlap) and
// is NEVER deleted — the group is reported with `skipped_foreign` for manual
// review instead. The unguarded version could destroy historical invoices that
// merely shared a number.
// Dry-run (default) only reports. Owner-triggered via POST /dedupe.
export async function dedupeQbInvoices(
  companyId: number,
  dryRun: boolean = true,
): Promise<{
  dry_run: boolean;
  connected: boolean;
  duplicate_groups: Array<{ doc_number: string; total: string | number; copies: number; keep: string; deleted: string[]; skipped_foreign: string[] }>;
  invoices_deleted: number;
}> {
  const auth = await getValidToken(companyId);
  if (!auth) return { dry_run: dryRun, connected: false, duplicate_groups: [], invoices_deleted: 0 };
  const { token, realmId } = auth;
  const qbQuote = (s: string) => s.replace(/'/g, "\\'");

  const qleno = await db
    .select({ id: invoicesTable.id, invoice_number: invoicesTable.invoice_number, qbo: invoicesTable.qbo_invoice_id })
    .from(invoicesTable)
    .where(and(eq(invoicesTable.company_id, companyId), sql`${invoicesTable.qbo_invoice_id} IS NOT NULL`));

  const groups: Array<{ doc_number: string; total: string | number; copies: number; keep: string; deleted: string[]; skipped_foreign: string[] }> = [];
  let deleted = 0;
  const seen = new Set<string>();

  for (const inv of qleno) {
    const docNumber = (inv.invoice_number || String(inv.id)).slice(-21);
    if (seen.has(docNumber)) continue;
    seen.add(docNumber);
    let hits: any[] = [];
    try {
      const q = await qbGet(
        token,
        realmId,
        `/query?query=${encodeURIComponent(
          `SELECT Id, SyncToken, DocNumber, TotalAmt, CustomerRef FROM Invoice WHERE DocNumber = '${qbQuote(docNumber)}'`,
        )}&`,
      );
      hits = q.QueryResponse?.Invoice ?? [];
    } catch (e: any) {
      console.warn(`[QB] dedupe query failed for DocNumber ${docNumber} (skipping):`, e.message);
      continue;
    }
    if (hits.length <= 1) continue;

    // Keep the canonical copy: the Id the Qleno row points to, else the oldest
    // (lowest numeric Id).
    const canonicalId = String(inv.qbo);
    const keep = hits.find((h) => String(h.Id) === canonicalId)
      ?? [...hits].sort((a, b) => Number(a.Id) - Number(b.Id))[0];

    // Partition the rest: true duplicates (same customer + same total as the
    // kept copy) are deletable; anything else is foreign history — skip it.
    const isTrueDuplicate = (h: any) =>
      String(h.CustomerRef?.value ?? "") === String(keep.CustomerRef?.value ?? "") &&
      Math.abs(Number(h.TotalAmt ?? 0) - Number(keep.TotalAmt ?? 0)) < 0.01;
    const others = hits.filter((h) => String(h.Id) !== String(keep.Id));
    const toDelete = others.filter(isTrueDuplicate);
    const skippedForeign = others.filter((h) => !isTrueDuplicate(h));
    if (skippedForeign.length > 0) {
      console.warn(
        `[QB] dedupe: DocNumber ${docNumber} has ${skippedForeign.length} same-number invoice(s) ` +
        `with a DIFFERENT customer/amount (ids ${skippedForeign.map((h) => h.Id).join(",")}) — ` +
        `foreign/historical, NOT deleting. Review manually.`,
      );
    }
    groups.push({
      doc_number: docNumber,
      total: hits[0].TotalAmt,
      copies: hits.length,
      keep: String(keep.Id),
      deleted: toDelete.map((h) => String(h.Id)),
      skipped_foreign: skippedForeign.map((h) => String(h.Id)),
    });

    if (!dryRun) {
      // If the surviving copy isn't the one Qleno referenced, re-point Qleno.
      if (String(keep.Id) !== canonicalId) {
        await db.update(invoicesTable).set({ qbo_invoice_id: String(keep.Id) }).where(eq(invoicesTable.id, inv.id));
      }
      for (const h of toDelete) {
        try {
          await qbPost(token, realmId, `/invoice?operation=delete`, { Id: h.Id, SyncToken: h.SyncToken });
          deleted++;
        } catch (e: any) {
          console.error(`[QB] dedupe delete failed for QB invoice ${h.Id} (DocNumber ${docNumber}):`, e.message);
        }
      }
    } else {
      deleted += toDelete.length;
    }
  }

  return { dry_run: dryRun, connected: true, duplicate_groups: groups, invoices_deleted: deleted };
}

// ── SYNC ALL (batch retry) ─────────────────────────────────────────────────
export async function syncAll(companyId: number): Promise<{ synced: number; failed: number; skipped: number }> {
  let synced = 0, failed = 0, skipped = 0;

  const queue = await db
    .select()
    .from(qbSyncQueueTable)
    .where(
      and(
        eq(qbSyncQueueTable.company_id, companyId),
        sql`${qbSyncQueueTable.status} IN ('pending', 'failed') AND ${qbSyncQueueTable.attempts} < 3`
      )
    );

  for (const item of queue) {
    try {
      if (item.entity_type === "customer") {
        await syncCustomer(companyId, item.entity_id);
      } else if (item.entity_type === "invoice") {
        await syncInvoice(companyId, item.entity_id);
      } else if (item.entity_type === "payment") {
        await syncPayment(companyId, item.entity_id);
      }
      synced++;
    } catch {
      failed++;
    }
  }

  if (synced > 0) {
    await db
      .update(companiesTable)
      .set({ qb_last_sync_at: new Date() })
      .where(eq(companiesTable.id, companyId));
  }

  return { synced, failed, skipped };
}

// ── BACKFILL (qb-cutover) ──────────────────────────────────────────────────
// Run when QB is (re)connected. The live push path no-ops while QB is
// disconnected and never queues, so any invoice/payment issued during a
// disconnected window would be stranded (syncAll only replays the queue). This
// re-queues every issued, not-yet-synced invoice whose SERVICE date is on/after
// qb_sync_start_date (+ a payment row for paid ones), then drains the queue.
// Idempotent: invoices already in QB (qbo_invoice_id set) and drafts are skipped.
export async function backfillFromCutover(
  companyId: number,
): Promise<{ queued: number; result: { synced: number; failed: number; skipped: number } }> {
  const empty = { synced: 0, failed: 0, skipped: 0 };
  const [co] = await db
    .select({ cutover: companiesTable.qb_sync_start_date, connected: companiesTable.qb_connected })
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId))
    .limit(1);
  if (!co?.connected || !co.cutover) return { queued: 0, result: empty };
  const cutoverStr = new Date(co.cutover).toISOString().slice(0, 10);

  const rows: any = await db.execute(sql`
    SELECT i.id, i.status
    FROM invoices i
    LEFT JOIN jobs j ON j.id = i.job_id
    WHERE i.company_id = ${companyId}
      AND i.qbo_invoice_id IS NULL
      AND i.status NOT IN ('draft', 'void', 'superseded')
      AND COALESCE(j.scheduled_date, i.created_at::date) >= ${cutoverStr}::date
  `);
  const list = rows.rows ?? rows;
  let queued = 0;
  for (const r of list) {
    await upsertQueue(companyId, "invoice", Number(r.id), "pending");
    if (r.status === "paid") await upsertQueue(companyId, "payment", Number(r.id), "pending");
    queued++;
  }
  const result = await syncAll(companyId);
  return { queued, result };
}

// ── Fire-and-forget wrapper ────────────────────────────────────────────────
export function queueSync(fn: () => Promise<void>): void {
  fn().catch((err) => console.error("[QB] Background sync error:", err));
}
