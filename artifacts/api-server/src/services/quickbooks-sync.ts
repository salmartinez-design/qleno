import crypto from "crypto";
import { db } from "@workspace/db";
import {
  companiesTable,
  clientsTable,
  invoicesTable,
  paymentsTable,
  qbSyncQueueTable,
  qbCustomerMapTable,
  notificationLogTable,
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

    await db
      .update(companiesTable)
      .set({
        qb_access_token: encrypt(data.access_token),
        qb_refresh_token: encrypt(data.refresh_token),
        qb_token_expires_at: expiresAt,
      })
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
  const url = `${base}/v3/company/${realmId}${path}?${QB_MV}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`QB POST ${path} → ${resp.status}: ${await resp.text()}`);
  return resp.json();
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
      // Create new QB customer
      const createData = await qbPost(token, realmId, "/customer", payload);
      qbCustomerId = createData.Customer?.Id;

      await db.insert(qbCustomerMapTable).values({
        company_id: companyId,
        qleno_customer_id: customerId,
        qb_customer_id: qbCustomerId,
      });
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

    if (!qbCustomerId) {
      throw new Error(`No QB customer mapping for client ${invoice.client_id}`);
    }

    const serviceItemId = await getOrCreateServiceItem(token, realmId, companyId);

    // Build line items
    const lineItems: any[] = [];
    const rawLines = (invoice.line_items as any[]) || [];

    if (rawLines.length > 0) {
      for (const line of rawLines) {
        const amount = parseFloat(line.amount || line.total || line.unit_price || "0");
        if (amount > 0) {
          lineItems.push({
            DetailType: "SalesItemLineDetail",
            Amount: amount,
            Description: line.description || line.name || "Cleaning Service",
            SalesItemLineDetail: { ItemRef: { value: serviceItemId } },
          });
        }
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
      DocNumber: invoice.invoice_number || String(invoiceId),
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
      // Create new
      const createData = await qbPost(token, realmId, "/invoice", qbInvoicePayload);
      qbInvoiceId = createData.Invoice?.Id;

      // Save qbo_invoice_id to invoice record
      await db
        .update(invoicesTable)
        .set({ qbo_invoice_id: qbInvoiceId })
        .where(eq(invoicesTable.id, invoiceId));
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
  try {
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

    // Get QB customer ID
    const [map] = await db
      .select({ qb_customer_id: qbCustomerMapTable.qb_customer_id })
      .from(qbCustomerMapTable)
      .where(and(eq(qbCustomerMapTable.company_id, companyId), eq(qbCustomerMapTable.qleno_customer_id, invoice.client_id!)))
      .limit(1);

    if (!map?.qb_customer_id) throw new Error("No QB customer mapping for payment");

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

    await qbPost(token, realmId, "/payment", {
      CustomerRef: { value: map.qb_customer_id },
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

    await upsertQueue(companyId, "payment", invoiceId, "synced");
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

// ── Fire-and-forget wrapper ────────────────────────────────────────────────
export function queueSync(fn: () => Promise<void>): void {
  fn().catch((err) => console.error("[QB] Background sync error:", err));
}
