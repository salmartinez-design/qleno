// [invoicing-engine 2026-06-16] Office-triggered invoice charging + routing.
//
// HARD RULES (spec §3):
//   - Charging is OFFICE-triggered only. There is NO auto-charge on completion
//     and NO auto-retry. This function charges AT MOST once per call and never
//     loops or reschedules.
//   - Routing is by the invoice's effective payment_source:
//       stripe     → charge the client's stored stripe_payment_method_id off-session
//       square     → Square charge (env-guarded; see note below)
//       check/ach  → NO charge; stays 'sent' for the office to mark paid manually
//   - On success: invoice → 'paid', payment row created, jobs.charge_succeeded_at
//     set, invoice + payment pushed to QB.
//   - On failure: invoice stays 'sent', payment_failed=true, failure stamped on
//     the job, office notified. Never retried.
//
// SQUARE NOTE: the `square` SDK (v44, the rewritten SquareClient API) IS
// installed and the Square branch uses it directly. It is still runtime-guarded
// by SQUARE_ACCESS_TOKEN (+ SQUARE_ENV=production) so a deploy without creds
// returns outcome 'needs_manual' instead of crashing — but with creds present it
// performs a real card-on-file charge. Uses the v44 surface: SquareClient /
// SquareEnvironment, cards.list({ customerId }) (returns a pager → .data), and
// payments.create({...}) (resolves to the body directly, no .result wrapper).
import { db } from "@workspace/db";
import { invoicesTable, clientsTable, accountsTable, jobsTable, paymentsTable, notificationLogTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { resolveInvoicePaymentSource } from "./payment-source.js";
import { cascadeBatchPayment } from "./invoice-billing.js";

export type ChargeOutcome = "paid" | "failed" | "needs_manual" | "invalid_state";

export type ChargeResult = {
  outcome: ChargeOutcome;
  source: string;
  message: string;
  invoiceId: number;
  amount?: number;
};

const CHARGEABLE_STATUSES = new Set(["sent", "overdue"]);

export async function chargeInvoice(
  companyId: number,
  invoiceId: number,
  userId: number | null,
): Promise<ChargeResult> {
  const [invoice] = await db
    .select({
      id: invoicesTable.id,
      client_id: invoicesTable.client_id,
      account_id: invoicesTable.account_id,
      job_id: invoicesTable.job_id,
      total: invoicesTable.total,
      status: invoicesTable.status,
      payment_source: invoicesTable.payment_source,
    })
    .from(invoicesTable)
    .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, companyId)))
    .limit(1);

  if (!invoice) return { outcome: "invalid_state", source: "", message: "Invoice not found", invoiceId };

  // Only an issued, unpaid invoice can be charged. draft → send first;
  // paid/void/superseded → nothing to charge. (An invoice past its due date is
  // still stored as 'sent'; 'overdue' is a display-only derivation.)
  if (!CHARGEABLE_STATUSES.has(invoice.status)) {
    return { outcome: "invalid_state", source: invoice.payment_source || "", message: `Cannot charge an invoice in status '${invoice.status}'`, invoiceId };
  }

  const amount = parseFloat(invoice.total || "0");
  if (amount <= 0) {
    return { outcome: "invalid_state", source: invoice.payment_source || "", message: "Invoice total is zero", invoiceId };
  }

  // Resolve the payer's card. A residential invoice carries client_id → the
  // client's card. A COMMERCIAL/account invoice has client_id = NULL and instead
  // carries account_id — the card lives on the account (accounts.square_customer_id
  // / stripe_customer_id). [square-default 2026-07-24] Without this account
  // fallback, "Charge" on an account invoice found no card and always failed.
  let payer:
    | {
        first_name?: string | null;
        stripe_customer_id?: string | null;
        stripe_payment_method_id?: string | null;
        square_customer_id?: string | null;
        payment_source?: string | null;
        card_last_four?: string | null;
      }
    | undefined;
  // An account invoice can carry an explicit billing method (check/ach/invoice_only)
  // that overrides the derived source; a residential invoice uses its own stamp.
  let stampedSource: string | null | undefined = invoice.payment_source;

  if (invoice.client_id) {
    [payer] = await db
      .select({
        id: clientsTable.id,
        first_name: clientsTable.first_name,
        last_name: clientsTable.last_name,
        stripe_customer_id: clientsTable.stripe_customer_id,
        stripe_payment_method_id: clientsTable.stripe_payment_method_id,
        square_customer_id: clientsTable.square_customer_id,
        payment_source: clientsTable.payment_source,
        card_last_four: clientsTable.card_last_four,
      })
      .from(clientsTable)
      .where(eq(clientsTable.id, invoice.client_id as number))
      .limit(1);
  } else if (invoice.account_id) {
    const [account] = await db
      .select({
        account_name: accountsTable.account_name,
        payment_method: accountsTable.payment_method,
        stripe_customer_id: accountsTable.stripe_customer_id,
        square_customer_id: accountsTable.square_customer_id,
      })
      .from(accountsTable)
      .where(and(eq(accountsTable.id, invoice.account_id as number), eq(accountsTable.company_id, companyId)))
      .limit(1);
    if (account) {
      // invoice_only accounts never have a card — collect + mark paid by hand.
      if (account.payment_method === "invoice_only") {
        return { outcome: "needs_manual", source: "", message: "This account is invoice-only — no card on file. Collect payment and mark the invoice paid manually.", invoiceId, amount };
      }
      // Map the account's billing method onto the charge source. card_on_file
      // derives (square unless a Stripe method exists — accounts hold none, so
      // square, matching Phes where account cards live in Square).
      if (account.payment_method === "check") stampedSource = "check";
      else if (account.payment_method === "ach") stampedSource = "ach";
      payer = {
        first_name: account.account_name,
        stripe_customer_id: account.stripe_customer_id,
        stripe_payment_method_id: null,
        square_customer_id: account.square_customer_id,
        payment_source: null,
        card_last_four: null,
      };
    }
  }

  const client = payer;
  const source = resolveInvoicePaymentSource(stampedSource, client ?? {});

  // check / ach — no electronic charge. Office collects + marks paid manually.
  if (source === "check" || source === "ach") {
    return { outcome: "needs_manual", source, message: `${source.toUpperCase()} account — collect payment and mark the invoice paid manually`, invoiceId, amount };
  }

  if (source === "stripe") {
    return chargeViaStripe(companyId, invoice, client, amount, userId);
  }

  // square
  return chargeViaSquare(companyId, invoice, client, amount, userId);
}

async function markPaid(
  companyId: number, invoiceId: number, jobId: number | null, clientId: number | null,
  amount: number, method: string, userId: number | null,
  ids: { stripe?: string; square?: string }, note: string,
): Promise<void> {
  await db.update(invoicesTable)
    .set({
      status: "paid",
      paid_at: new Date(),
      payment_failed: false,
      ...(ids.stripe ? { stripe_payment_intent_id: ids.stripe } : {}),
      ...(ids.square ? { square_payment_id: ids.square } : {}),
    })
    .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, companyId)));

  // [batch-invoicing 2026-08-03] A combined invoice settles its members too.
  // They stay 'batched' (never back into A/R) but carry the paid_at, so per-visit
  // revenue reporting sees the money.
  await cascadeBatchPayment(db as any, companyId, invoiceId, new Date())
    .catch((e) => console.error("[charge] batch cascade non-fatal:", e));

  await db.insert(paymentsTable).values({
    company_id: companyId,
    client_id: clientId,
    invoice_id: invoiceId,
    job_id: jobId,
    amount: amount.toString(),
    method,
    status: "completed",
    processed_by: userId,
    ...(ids.stripe ? { stripe_payment_id: ids.stripe } : {}),
  } as any).catch((e) => console.error("[charge] payment row insert non-fatal:", e));

  // Stamp the job as charged so it can never be re-invoiced (engine idempotency).
  if (jobId) {
    await db.update(jobsTable)
      .set({ charge_succeeded_at: new Date(), charge_failure_reason: null })
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)))
      .catch(() => {});
  }

  // Push invoice + payment to QB (fire-and-forget; no-op when not connected).
  try {
    const { syncInvoice, syncPayment } = await import("../services/quickbooks-sync.js");
    syncInvoice(companyId, invoiceId)
      .then(() => syncPayment(companyId, invoiceId))
      .catch((e) => console.error("[charge] QB push non-fatal:", e));
  } catch (e) {
    console.error("[charge] QB module load non-fatal:", e);
  }
}

async function flagFailure(
  companyId: number, invoiceId: number, jobId: number | null, reason: string,
): Promise<void> {
  // Invoice stays 'sent'; flag payment_failed. NEVER retried.
  await db.update(invoicesTable)
    .set({ payment_failed: true })
    .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, companyId)));

  if (jobId) {
    await db.update(jobsTable)
      .set({ charge_attempted_at: new Date(), charge_failed_at: new Date(), charge_failure_reason: reason.slice(0, 500) })
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)))
      .catch(() => {});
  }

  // Notify office (system log row — surfaces in the office feed). Not customer comms.
  await db.insert(notificationLogTable).values({
    company_id: companyId,
    recipient: "office",
    channel: "system",
    trigger: "invoice_charge_failed",
    status: "sent",
    metadata: { invoice_id: invoiceId, reason } as any,
  }).catch(() => {});
}

async function chargeViaStripe(
  companyId: number, invoice: any, client: any, amount: number, userId: number | null,
): Promise<ChargeResult> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret || secret === "payments disabled") {
    return { outcome: "needs_manual", source: "stripe", message: "Stripe is not configured in this environment", invoiceId: invoice.id, amount };
  }
  const pm = client?.stripe_payment_method_id;
  const customer = client?.stripe_customer_id;
  if (!pm || !customer) {
    await flagFailure(companyId, invoice.id, invoice.job_id, "No Stripe card on file");
    return { outcome: "failed", source: "stripe", message: "No Stripe card on file — office must contact client for backup payment", invoiceId: invoice.id, amount };
  }
  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secret, { apiVersion: "2024-06-20" as any });
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: "usd",
      customer,
      payment_method: pm,
      confirm: true,
      off_session: true,
      metadata: { invoice_id: String(invoice.id), company_id: String(companyId) },
    });
    if (intent.status === "succeeded") {
      await markPaid(companyId, invoice.id, invoice.job_id, invoice.client_id, amount, "card", userId,
        { stripe: intent.id }, `Charged •••• ${client?.card_last_four ?? ""}`);
      return { outcome: "paid", source: "stripe", message: "Charged successfully", invoiceId: invoice.id, amount };
    }
    await flagFailure(companyId, invoice.id, invoice.job_id, `Stripe intent status: ${intent.status}`);
    return { outcome: "failed", source: "stripe", message: `Charge not completed (status: ${intent.status})`, invoiceId: invoice.id, amount };
  } catch (err: any) {
    const reason = err?.message || "Stripe charge failed";
    await flagFailure(companyId, invoice.id, invoice.job_id, reason);
    return { outcome: "failed", source: "stripe", message: reason, invoiceId: invoice.id, amount };
  }
}

async function chargeViaSquare(
  companyId: number, invoice: any, client: any, amount: number, userId: number | null,
): Promise<ChargeResult> {
  // [square-per-branch 2026-08-18] Credentials belong to the company that owns
  // the invoice. A Schaumburg invoice must settle into Schaumburg's Square
  // account, and its client's card only exists on that merchant.
  const { resolveSquareCredentials } = await import("./square-credentials.js");
  const creds = await resolveSquareCredentials(companyId);
  const token = creds.accessToken;
  // Guarded: only attempt a live Square charge when both the SDK and creds
  // are present. Otherwise return needs_manual (no crash, no false 'paid').
  if (!creds.configured || !token) {
    return { outcome: "needs_manual", source: "square", message: "Square charging not configured — collect payment and mark the invoice paid manually", invoiceId: invoice.id, amount };
  }
  if (!client?.square_customer_id) {
    await flagFailure(companyId, invoice.id, invoice.job_id, "No Square card on file");
    return { outcome: "failed", source: "square", message: "No Square card on file — office must contact client for backup payment", invoiceId: invoice.id, amount };
  }
  try {
    // Dynamic import so a missing 'square' dep never breaks the bundle/build.
    const squareMod: any = await import("square" as any).catch(() => null);
    if (!squareMod?.SquareClient) {
      return { outcome: "needs_manual", source: "square", message: "Square SDK not available — collect payment and mark the invoice paid manually", invoiceId: invoice.id, amount };
    }
    const { SquareClient, SquareEnvironment } = squareMod;
    const environment = (creds.environment === "production") ? SquareEnvironment.Production : SquareEnvironment.Sandbox;
    const square = new SquareClient({ token, environment });
    // Charge the customer's card on file. Square needs a stored card id; we read
    // the default enabled card from the customer's cards. (v44: cards.list returns
    // a pager — the first page's .data holds the (few) cards a customer has.)
    // sortOrder MUST be passed: the v44 SDK serializes an omitted sortOrder to
    // `sort_order=` (empty), which Square rejects with INVALID_ENUM_VALUE.
    const cardsPage = await square.cards.list({ customerId: client.square_customer_id, sortOrder: "DESC" });
    const cardList: any[] = cardsPage?.data ?? [];
    const cardId = cardList.find((c: any) => c.enabled)?.id ?? cardList[0]?.id;
    if (!cardId) {
      await flagFailure(companyId, invoice.id, invoice.job_id, "No enabled Square card on file");
      return { outcome: "failed", source: "square", message: "No usable Square card on file", invoiceId: invoice.id, amount };
    }
    // Stable per-invoice key: if the office double-clicks Charge, Square returns
    // the original result instead of double-charging. (A genuine retry after a
    // decline also returns that first decline — office collects manually then.)
    const idempotencyKey = `inv-${invoice.id}-${companyId}`;
    const resp = await square.payments.create({
      sourceId: cardId,
      idempotencyKey,
      customerId: client.square_customer_id,
      amountMoney: { amount: BigInt(Math.round(amount * 100)), currency: "USD" },
    });
    const payment = resp?.payment;
    if (payment && (payment.status === "COMPLETED" || payment.status === "APPROVED")) {
      await markPaid(companyId, invoice.id, invoice.job_id, invoice.client_id, amount, "square", userId,
        { square: payment.id }, "Charged via Square");
      return { outcome: "paid", source: "square", message: "Charged successfully via Square", invoiceId: invoice.id, amount };
    }
    await flagFailure(companyId, invoice.id, invoice.job_id, `Square payment status: ${payment?.status ?? "unknown"}`);
    return { outcome: "failed", source: "square", message: `Square charge not completed (status: ${payment?.status ?? "unknown"})`, invoiceId: invoice.id, amount };
  } catch (err: any) {
    const reason = err?.message || "Square charge failed";
    await flagFailure(companyId, invoice.id, invoice.job_id, reason);
    return { outcome: "failed", source: "square", message: reason, invoiceId: invoice.id, amount };
  }
}
