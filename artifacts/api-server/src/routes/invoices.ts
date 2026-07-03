import { Router } from "express";
import { db } from "@workspace/db";
import { invoicesTable, clientsTable, jobsTable, paymentsTable, notificationLogTable, usersTable, paymentLinksTable, accountsTable } from "@workspace/db/schema";
import crypto from "crypto";
import { eq, and, desc, count, sum, sql, lt, isNull, isNotNull, or, ne, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { syncInvoice, syncPayment, queueSync } from "../services/quickbooks-sync.js";
import { sendNotification } from "../services/notificationService.js";
import { appBaseUrl } from "../lib/app-url.js";
import { generateInvoiceNumber, getNextInvoiceNumber } from "../lib/invoice-number.js";
import { chargeInvoice } from "../lib/charge-invoice.js";
import { buildJobLineItems } from "../lib/invoice-line-items.js";
import { normalizeInvoiceLineItems } from "../lib/normalize-line-items.js";

const router = Router();

function daysOverdue(dueDateStr: string | null): number {
  if (!dueDateStr) return 0;
  const due = new Date(dueDateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.floor((today.getTime() - due.getTime()) / 86400000);
  return diff > 0 ? diff : 0;
}

function formatInvoice(inv: any) {
  const overdue = inv.status === "sent" && inv.due_date && new Date(inv.due_date) < new Date();
  return {
    ...inv,
    subtotal: parseFloat(inv.subtotal || "0"),
    tips: parseFloat(inv.tips || "0"),
    total: parseFloat(inv.total || "0"),
    refunded_amount: inv.refunded_amount != null ? parseFloat(inv.refunded_amount) : null,
    status: overdue ? "overdue" : inv.status,
    days_overdue: daysOverdue(inv.due_date),
    invoice_number: inv.invoice_number || generateInvoiceNumber(inv.id),
  };
}

// [invoice-pay-token 2026-06-22] Mint a one-per-invoice payment_links row
// (purpose 'pay_invoice') so the emailed "View and Pay" button resolves on the
// public /pay/:token page and charges the invoice total via Stripe. Reuses an
// existing unused/unexpired link for the invoice so re-sends don't pile up.
// Falls back to the legacy id-based URL if the insert fails (never blocks send).
async function mintInvoicePayLink(
  companyId: number, clientId: number | null, invoiceId: number,
  amount: string | null, userId?: number,
): Promise<string> {
  if (clientId == null) return `${appBaseUrl()}/pay/${invoiceId}`;
  try {
    const token = crypto.randomBytes(20).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // 30 days
    await db.insert(paymentLinksTable).values({
      company_id: companyId, client_id: clientId, token,
      purpose: "pay_invoice", invoice_id: invoiceId, amount: amount ?? null,
      expires_at: expiresAt, created_by: userId ?? null,
    });
    return `${appBaseUrl()}/pay/${token}`;
  } catch (err) {
    console.error("mintInvoicePayLink failed, falling back to id link:", err);
    return `${appBaseUrl()}/pay/${invoiceId}`;
  }
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const { status, client_id, date_from, date_to, page = "1", limit = "50", branch_id, search } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    const today = new Date().toISOString().split("T")[0];

    const conditions: any[] = [eq(invoicesTable.company_id, req.auth!.companyId)];

    if (status === "overdue") {
      conditions.push(eq(invoicesTable.status, "sent"));
      conditions.push(lt(invoicesTable.due_date as any, today));
    } else if (status) {
      conditions.push(eq(invoicesTable.status, status as any));
    }
    if (client_id) conditions.push(eq(invoicesTable.client_id, parseInt(client_id as string)));
    // [account-visibility 2026-07-02] Commercial/account invoices are
    // branch-agnostic — an account (e.g. PPM) can span branches, and the office
    // wants them visible "from one window" regardless of the branch switcher.
    // Invoices also aren't stamped with a branch_id today, so a plain
    // `branch_id = X` filter hid every account invoice. Show invoices whose
    // branch matches OR that belong to an account.
    if (branch_id && branch_id !== "all") {
      conditions.push(or(eq(invoicesTable.branch_id, parseInt(branch_id as string)), isNotNull(invoicesTable.account_id)));
    }

    // [invoice-date-range 2026-06-21] Filter by the invoice's EFFECTIVE service
    // date = the linked job's scheduled_date, falling back to created_at when the
    // invoice has no job. Same date the list now displays, so the range filter
    // matches what the office sees. Inclusive bounds (YYYY-MM-DD).
    const effDate = sql`COALESCE((SELECT j.scheduled_date FROM jobs j WHERE j.id = ${invoicesTable.job_id}), ${invoicesTable.created_at}::date)`;
    if (date_from && String(date_from).trim()) conditions.push(sql`${effDate} >= ${String(date_from)}`);
    if (date_to && String(date_to).trim()) conditions.push(sql`${effDate} <= ${String(date_to)}`);

    // [invoice-future-hide 2026-06-20] Maribel: "the invoice tab should only
    // show invoices up to date, not in advance." Recurring/auto draft invoices
    // tied to a not-yet-performed job are billing-in-advance noise that makes
    // the dates look wrong. Hide DRAFT invoices whose linked job is scheduled
    // after today from the default view. Only drafts with a future job date are
    // hidden — sent/paid/overdue/void, manual drafts (no job_id), and drafts for
    // today-or-earlier jobs all stay. Pass ?include_future=1 to show everything.
    const includeFuture = String(req.query.include_future || "") === "1";
    if (!includeFuture) {
      conditions.push(sql`NOT (
        ${invoicesTable.status} = 'draft'
        AND ${invoicesTable.job_id} IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.id = ${invoicesTable.job_id}
            AND j.scheduled_date > ${today}
        )
      )`);
    }

    // [invoice-search 2026-06-20] Server-side search so it works across ALL
    // invoices, not just the 50 the page loaded. Matches the invoice_number,
    // the client name, AND the displayed "INV-00622" id form (the UI pads the
    // numeric id, so "INV-00622" / "00622" / "622" all resolve to id 622).
    if (search && String(search).trim()) {
      const s = String(search).trim();
      const like = `%${s}%`;
      const digits = s.replace(/\D/g, "");
      const idMatch = digits ? sql` OR ${invoicesTable.id} = ${parseInt(digits, 10)}` : sql``;
      conditions.push(sql`(
        ${invoicesTable.invoice_number} ILIKE ${like}
        OR concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name}) ILIKE ${like}
        OR (SELECT a.account_name FROM accounts a WHERE a.id = ${invoicesTable.account_id}) ILIKE ${like}${idMatch}
      )`);
    }

    const invoices = await db
      .select({
        id: invoicesTable.id,
        client_id: invoicesTable.client_id,
        client_name: sql<string>`COALESCE(NULLIF(concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name}), ' '), (SELECT a.account_name FROM accounts a WHERE a.id = ${invoicesTable.account_id}), 'Unknown')`,
        account_name: sql<string | null>`(SELECT a.account_name FROM accounts a WHERE a.id = ${invoicesTable.account_id})`,
        client_email: clientsTable.email,
        job_id: invoicesTable.job_id,
        invoice_number: invoicesTable.invoice_number,
        status: invoicesTable.status,
        line_items: invoicesTable.line_items,
        subtotal: invoicesTable.subtotal,
        tips: invoicesTable.tips,
        total: invoicesTable.total,
        due_date: invoicesTable.due_date,
        sent_at: invoicesTable.sent_at,
        last_reminder_sent_at: invoicesTable.last_reminder_sent_at,
        payment_failed: invoicesTable.payment_failed,
        created_at: invoicesTable.created_at,
        paid_at: invoicesTable.paid_at,
        po_number: invoicesTable.po_number,
        payment_terms: invoicesTable.payment_terms,
        billing_contact_name: invoicesTable.billing_contact_name,
        billing_contact_email: invoicesTable.billing_contact_email,
        // [invoice-service-date 2026-06-20] Live service date = the linked job's
        // scheduled_date, read at query time. The invoice has no service-date
        // column (created_at/due_date are creation snapshots), and a reschedule
        // moves jobs.scheduled_date WITHOUT touching the invoice — so a snapshot
        // would go stale (office saw "the 17th" for a job moved to the 19th).
        // Reading it live can never drift; null when the job is gone/unlinked.
        service_date: sql<string | null>`COALESCE(
          ${invoicesTable.service_date},
          (SELECT j.scheduled_date FROM jobs j WHERE j.id = ${invoicesTable.job_id}),
          (SELECT MIN(j2.scheduled_date) FROM jobs j2 WHERE j2.id IN (
            SELECT (li->>'job_id')::int FROM jsonb_array_elements(${invoicesTable.line_items}) li WHERE li->>'job_id' IS NOT NULL
          ))
        )`,
        // [charge-card 2026-06-21] Card-on-file info so the list/detail can show
        // a "Charge Card on File" action when a reusable Stripe PaymentMethod exists
        // OR the client has a Square customer ID with a card vaulted there.
        card_last_four: sql<string | null>`COALESCE(${clientsTable.card_last_four}, ${clientsTable.square_card_last4})`,
        card_brand: sql<string | null>`COALESCE(${clientsTable.card_brand}, ${clientsTable.square_card_brand})`,
        client_payment_source: clientsTable.payment_source,
        has_card_on_file: sql<boolean>`(
          (${clientsTable.stripe_payment_method_id} IS NOT NULL AND ${clientsTable.stripe_customer_id} IS NOT NULL)
          OR ${clientsTable.square_customer_id} IS NOT NULL
        )`,
        refunded_amount: invoicesTable.refunded_amount,
        refunded_at: invoicesTable.refunded_at,
      })
      .from(invoicesTable)
      .leftJoin(clientsTable, eq(invoicesTable.client_id, clientsTable.id))
      .where(and(...conditions))
      .orderBy(desc(invoicesTable.created_at))
      .limit(parseInt(limit as string))
      .offset(offset);

    const totalResult = await db
      .select({ count: count() })
      .from(invoicesTable)
      .leftJoin(clientsTable, eq(invoicesTable.client_id, clientsTable.id))
      .where(and(...conditions));

    const compCond = eq(invoicesTable.company_id, req.auth!.companyId);

    const [outstandingRes, overdueRes, paid30dRes, ytdRes] = await Promise.all([
      db.select({ total: sum(invoicesTable.total) })
        .from(invoicesTable)
        .where(and(compCond, inArray(invoicesTable.status, ["sent", "overdue"]))),
      db.select({ total: sum(invoicesTable.total) })
        .from(invoicesTable)
        .where(and(compCond, eq(invoicesTable.status, "sent"), lt(invoicesTable.due_date as any, today))),
      db.select({ total: sum(invoicesTable.total) })
        .from(invoicesTable)
        .where(and(compCond, eq(invoicesTable.status, "paid"),
          sql`${invoicesTable.paid_at} >= now() - interval '30 days'`)),
      db.select({ total: sum(invoicesTable.total) })
        .from(invoicesTable)
        .where(and(compCond, eq(invoicesTable.status, "paid"),
          sql`extract(year from ${invoicesTable.paid_at}) = extract(year from now())`)),
    ]);

    return res.json({
      data: invoices.map(formatInvoice),
      total: totalResult[0].count,
      page: parseInt(page as string),
      limit: parseInt(limit as string),
      stats: {
        total_outstanding: parseFloat(outstandingRes[0].total || "0"),
        total_overdue: parseFloat(overdueRes[0].total || "0"),
        total_paid: parseFloat(paid30dRes[0].total || "0"),
        total_revenue: parseFloat(ytdRes[0].total || "0"),
      },
    });
  } catch (err) {
    console.error("List invoices error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to list invoices" });
  }
});

router.post("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const {
      client_id, job_id, line_items: rawLineItems, tips = 0, auto_send = false,
      po_number, payment_terms: reqPaymentTerms, billing_contact_name: reqBillingName,
      billing_contact_email: reqBillingEmail,
    } = req.body;

    let finalClientId = client_id;
    let finalLineItems = rawLineItems;
    let jobRecord: any = null;
    let finalAccountId: number | null = null;

    if (job_id && (!client_id || !rawLineItems)) {
      const [job] = await db
        .select({
          id: jobsTable.id,
          client_id: jobsTable.client_id,
          account_id: jobsTable.account_id,
          service_type: jobsTable.service_type,
          base_fee: jobsTable.base_fee,
          billed_amount: jobsTable.billed_amount,
        })
        .from(jobsTable)
        .where(and(eq(jobsTable.id, job_id), eq(jobsTable.company_id, req.auth!.companyId)))
        .limit(1);

      if (!job) return res.status(404).json({ error: "Not Found", message: "Job not found" });
      jobRecord = job;
      finalClientId = job.client_id;
      finalAccountId = job.account_id ?? null;

      // [account-invoice 2026-07-02] Account (commercial/PPM) jobs have NO
      // client_id — their identity is the account. Build line items from the
      // shared canonical builder (same as the completion auto-draft in
      // ensure-invoice) so a manual "create invoice" / batch produces a real
      // invoice billed to the account, instead of 400-ing on the missing
      // client_id (the bug that left completed PPM turnovers uninvoiced).
      if (finalAccountId) {
        const built = await buildJobLineItems(req.auth!.companyId as number, job_id);
        const amt = job.billed_amount ? parseFloat(job.billed_amount as string) : parseFloat(job.base_fee || "0");
        finalLineItems = (built && built.lineItems.length)
          ? built.lineItems
          : [{ description: (job.service_type || "cleaning").replace(/_/g, " "), quantity: 1, unit_price: amt, total: amt }];
      } else {
        finalLineItems = [{
          description: (job.service_type || "").replace(/_/g, " "),
          quantity: 1,
          rate: parseFloat(job.base_fee || "0"),
          total: parseFloat(job.base_fee || "0"),
        }];
      }
    }

    if (!finalClientId && !finalAccountId) {
      return res.status(400).json({ error: "Bad Request", message: "client_id or account_id required" });
    }

    const subtotal = (finalLineItems || []).reduce((s: number, item: any) => s + (item.total || 0), 0);
    const total = subtotal + (tips || 0);

    // Look up the client (residential) to inherit terms/billing contact. Account
    // (commercial) invoices have no client — pull the name + terms from the
    // account instead so the invoice bills to the account correctly.
    let clientRecord: any = null;
    let accountName: string | null = null;
    let acctTermsDays: number | null = null;
    if (finalClientId) {
      const [cr] = await db
        .select({
          payment_terms: clientsTable.payment_terms,
          billing_contact_name: clientsTable.billing_contact_name,
          billing_contact_email: clientsTable.billing_contact_email,
          auto_charge: clientsTable.auto_charge,
          stripe_customer_id: clientsTable.stripe_customer_id,
          card_last_four: clientsTable.card_last_four,
          first_name: clientsTable.first_name,
          last_name: clientsTable.last_name,
          email: clientsTable.email,
        })
        .from(clientsTable)
        .where(eq(clientsTable.id, finalClientId));
      clientRecord = cr;
    } else if (finalAccountId) {
      const [acct] = await db
        .select({ account_name: accountsTable.account_name, payment_terms_days: accountsTable.payment_terms_days })
        .from(accountsTable)
        .where(eq(accountsTable.id, finalAccountId))
        .limit(1);
      accountName = acct?.account_name ?? null;
      acctTermsDays = acct?.payment_terms_days ?? 30;
    }

    const acctTermsLabel = acctTermsDays === 30 ? "net_30" : acctTermsDays === 15 ? "net_15" : acctTermsDays === 7 ? "net_7" : acctTermsDays != null ? "due_on_receipt" : null;
    const effectiveTerms = reqPaymentTerms || clientRecord?.payment_terms || acctTermsLabel || "due_on_receipt";
    const daysToAdd = effectiveTerms === "net_30" ? 30 : effectiveTerms === "net_15" ? 15 : effectiveTerms === "net_7" ? 7 : 0;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + daysToAdd);
    const dueDateStr = dueDate.toISOString().split("T")[0];

    const [newInvoice] = await db
      .insert(invoicesTable)
      .values({
        company_id: req.auth!.companyId,
        client_id: finalClientId || null,
        account_id: finalAccountId || null,
        job_id: job_id || null,
        line_items: finalLineItems || [],
        subtotal: subtotal.toString(),
        tips: (tips || 0).toString(),
        total: total.toString(),
        due_date: dueDateStr,
        status: auto_send ? "sent" : "draft",
        // Always stamp sent_at when the invoice is finalized 'sent' — whether
        // by auto_send OR by an explicit status='sent' in the request body.
        // Without this, BatchInvoiceDrawer-created invoices without auto_send
        // ended up with status='sent' but sent_at=null, showing "Sent: —".
        sent_at: auto_send ? new Date() : null,
        created_by: req.auth!.userId,
        po_number: po_number || null,
        payment_terms: effectiveTerms,
        billing_contact_name: reqBillingName || clientRecord?.billing_contact_name || null,
        billing_contact_email: reqBillingEmail || clientRecord?.billing_contact_email || null,
      })
      .returning();

    const invNumber = await getNextInvoiceNumber(req.auth!.companyId, newInvoice.id);
    await db.update(invoicesTable).set({ invoice_number: invNumber }).where(eq(invoicesTable.id, newInvoice.id));
    logAudit(req, "CREATE", "invoice", newInvoice.id, null, { total, client_id: finalClientId, job_id: job_id || null });

    // QB sync (fire and forget)
    queueSync(() => syncInvoice(req.auth!.companyId, newInvoice.id));

    const client = clientRecord;

    await db.insert(notificationLogTable).values({
      company_id: req.auth!.companyId,
      recipient: client?.email || "system",
      channel: "system",
      trigger: "invoice_created",
      status: "sent",
      metadata: { invoice_id: newInvoice.id, amount: total, job_id } as any,
    });

    if (auto_send && client?.email) {
      await db.insert(notificationLogTable).values({
        company_id: req.auth!.companyId,
        recipient: client.email,
        channel: "email",
        trigger: "invoice_sent",
        status: "sent",
        metadata: { invoice_id: newInvoice.id, amount: total } as any,
      });
    }

    // ── Auto-charge if client has card on file and auto_charge is enabled ────
    let autoChargeResult: { success: boolean; error?: string } | null = null;
    if (client?.auto_charge && client?.stripe_customer_id && client?.card_last_four) {
      const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
      if (stripeSecretKey && stripeSecretKey !== "payments disabled") {
        try {
          const Stripe = (await import("stripe")).default;
          const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-06-20" as any });
          const customer = await stripe.customers.retrieve(client.stripe_customer_id) as any;
          const defaultPm = customer.invoice_settings?.default_payment_method;
          if (defaultPm) {
            const intent = await stripe.paymentIntents.create({
              amount: Math.round(total * 100),
              currency: "usd",
              customer: client.stripe_customer_id,
              payment_method: defaultPm,
              confirm: true,
              off_session: true,
              metadata: { invoice_id: String(newInvoice.id), company_id: String(req.auth!.companyId) },
            });
            if (intent.status === "succeeded") {
              await db.update(invoicesTable)
                .set({ status: "paid", paid_at: new Date(), stripe_payment_intent_id: intent.id })
                .where(eq(invoicesTable.id, newInvoice.id));
              await db.insert(paymentsTable).values({
                company_id: req.auth!.companyId,
                client_id: finalClientId,
                invoice_id: newInvoice.id,
                amount: total.toString(),
                method: "card",
                stripe_payment_intent_id: intent.id,
                notes: `Auto-charged •••• ${client.card_last_four}`,
              } as any).catch(() => {});
              autoChargeResult = { success: true };
            }
          }
        } catch (err: any) {
          console.error("Auto-charge failed:", err.message);
          await db.update(invoicesTable)
            .set({ payment_failed: true })
            .where(eq(invoicesTable.id, newInvoice.id));
          autoChargeResult = { success: false, error: err.message };
        }
      }
    }

    return res.status(201).json({
      ...newInvoice,
      invoice_number: invNumber,
      client_name: finalClientId ? `${client?.first_name || ""} ${client?.last_name || ""}`.trim() : (accountName || ""),
      subtotal,
      tips: tips || 0,
      total,
      auto_charge_result: autoChargeResult,
    });
  } catch (err) {
    console.error("Create invoice error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to create invoice" });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);

    const [invoice] = await db
      .select({
        id: invoicesTable.id,
        client_id: invoicesTable.client_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        client_email: clientsTable.email,
        job_id: invoicesTable.job_id,
        invoice_number: invoicesTable.invoice_number,
        status: invoicesTable.status,
        line_items: invoicesTable.line_items,
        subtotal: invoicesTable.subtotal,
        tips: invoicesTable.tips,
        total: invoicesTable.total,
        due_date: invoicesTable.due_date,
        sent_at: invoicesTable.sent_at,
        last_reminder_sent_at: invoicesTable.last_reminder_sent_at,
        payment_failed: invoicesTable.payment_failed,
        created_at: invoicesTable.created_at,
        paid_at: invoicesTable.paid_at,
        // [invoice-redesign 2026-06-22] Billing address for the invoice document.
        // Client address covers residential; account jobs fall back to account_name.
        client_address: clientsTable.address,
        client_city: clientsTable.city,
        client_state: clientsTable.state,
        client_zip: clientsTable.zip,
        client_phone: clientsTable.phone,
        account_name: sql<string | null>`(SELECT a.account_name FROM accounts a WHERE a.id = ${invoicesTable.account_id})`,
        // [invoice-bill-to 2026-07-03] Manual Bill-to override (HOA name, etc.).
        bill_to_name: invoicesTable.bill_to_name,
        // [invoice-service-date 2026-06-20] Live service date from the linked job
        // (see list select). Reschedule-proof; null when job gone/unlinked.
        service_date: sql<string | null>`COALESCE(
          ${invoicesTable.service_date},
          (SELECT j.scheduled_date FROM jobs j WHERE j.id = ${invoicesTable.job_id}),
          (SELECT MIN(j2.scheduled_date) FROM jobs j2 WHERE j2.id IN (
            SELECT (li->>'job_id')::int FROM jsonb_array_elements(${invoicesTable.line_items}) li WHERE li->>'job_id' IS NOT NULL
          ))
        )`,
        // [charge-card 2026-06-21] Card-on-file info — Stripe OR Square.
        card_last_four: sql<string | null>`COALESCE(${clientsTable.card_last_four}, ${clientsTable.square_card_last4})`,
        card_brand: sql<string | null>`COALESCE(${clientsTable.card_brand}, ${clientsTable.square_card_brand})`,
        client_payment_source: clientsTable.payment_source,
        has_card_on_file: sql<boolean>`(
          (${clientsTable.stripe_payment_method_id} IS NOT NULL AND ${clientsTable.stripe_customer_id} IS NOT NULL)
          OR ${clientsTable.square_customer_id} IS NOT NULL
        )`,
        // Needed for refund modal: routes Stripe API call vs offline-only notice.
        stripe_payment_intent_id: invoicesTable.stripe_payment_intent_id,
        payment_source: invoicesTable.payment_source,
        refunded_amount: invoicesTable.refunded_amount,
        refund_reason: invoicesTable.refund_reason,
        refunded_at: invoicesTable.refunded_at,
      })
      .from(invoicesTable)
      .leftJoin(clientsTable, eq(invoicesTable.client_id, clientsTable.id))
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .limit(1);

    if (!invoice) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });

    return res.json(formatInvoice(invoice));
  } catch (err) {
    console.error("Get invoice error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get invoice" });
  }
});

// ── Invoice PDF ──────────────────────────────────────────────────────────────
// Branded, downloadable PDF of the invoice — same look as the estimate PDF.
// Inline disposition so it opens in a browser tab.
router.get("/:id/pdf", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const invoiceId = parseInt(req.params.id);
    const [inv] = await db
      .select({
        invoice_number: invoicesTable.invoice_number,
        status: invoicesTable.status,
        line_items: invoicesTable.line_items,
        subtotal: invoicesTable.subtotal,
        tips: invoicesTable.tips,
        total: invoicesTable.total,
        due_date: invoicesTable.due_date,
        created_at: invoicesTable.created_at,
        paid_at: invoicesTable.paid_at,
        first_name: clientsTable.first_name,
        last_name: clientsTable.last_name,
        email: clientsTable.email,
        phone: clientsTable.phone,
        address: clientsTable.address,
        city: clientsTable.city,
        state: clientsTable.state,
        zip: clientsTable.zip,
        account_name: sql<string | null>`(SELECT a.account_name FROM accounts a WHERE a.id = ${invoicesTable.account_id})`,
        bill_to_name: invoicesTable.bill_to_name,
        service_date: sql<string | null>`COALESCE(
          ${invoicesTable.service_date},
          (SELECT j.scheduled_date FROM jobs j WHERE j.id = ${invoicesTable.job_id}),
          (SELECT MIN(j2.scheduled_date) FROM jobs j2 WHERE j2.id IN (
            SELECT (li->>'job_id')::int FROM jsonb_array_elements(${invoicesTable.line_items}) li WHERE li->>'job_id' IS NOT NULL
          ))
        )`,
      })
      .from(invoicesTable)
      .leftJoin(clientsTable, eq(invoicesTable.client_id, clientsTable.id))
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, companyId)))
      .limit(1);
    if (!inv) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });

    const co = await db.execute(sql`SELECT name, logo_url FROM companies WHERE id = ${companyId} LIMIT 1`);
    const company: any = (co as any).rows[0] ?? {};
    let logo: Buffer | null = null;
    if (company.logo_url) {
      try {
        const abs = /^https?:\/\//i.test(company.logo_url) ? company.logo_url : `${appBaseUrl()}${company.logo_url}`;
        const r = await fetch(abs);
        if (r.ok && /image\/(png|jpe?g)/i.test(r.headers.get("content-type") || "")) logo = Buffer.from(await r.arrayBuffer());
      } catch { logo = null; }
    }

    const rawItems = Array.isArray(inv.line_items) ? inv.line_items : [];
    const items = rawItems.map((it: any) => ({
      description: it.description ?? it.name ?? "Service",
      quantity: it.quantity ?? 1,
      unit_price: it.unit_price ?? it.unit_rate ?? it.total ?? 0,
      total: it.total ?? it.amount ?? 0,
    }));
    const billName = inv.bill_to_name || [inv.first_name, inv.last_name].filter(Boolean).join(" ") || inv.account_name || "Customer";
    const billAddr = [inv.address, [inv.city, inv.state].filter(Boolean).join(", "), inv.zip].filter(Boolean).join(", ");

    const { renderInvoicePdf } = await import("../lib/invoice-pdf.js");
    const pdf = await renderInvoicePdf({
      companyName: company.name || "Invoice",
      logo,
      invoiceNumber: inv.invoice_number || generateInvoiceNumber(invoiceId),
      status: inv.status || "sent",
      billToName: billName,
      billToAddress: billAddr || null,
      billToEmail: inv.email || null,
      billToPhone: inv.phone || null,
      serviceDate: inv.service_date ? String(inv.service_date) : null,
      issuedDate: inv.created_at ? String(inv.created_at) : null,
      dueDate: inv.due_date ? String(inv.due_date) : null,
      items,
      subtotal: inv.subtotal ?? inv.total ?? 0,
      tips: inv.tips ?? 0,
      total: inv.total ?? 0,
      paid: !!inv.paid_at,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${inv.invoice_number || `invoice-${invoiceId}`}.pdf"`);
    return res.end(pdf);
  } catch (err) {
    console.error("Invoice PDF error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to render invoice PDF" });
  }
});

router.put("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);
    const { status, line_items, tips, due_date, created_date, service_date, bill_to_name } = req.body;

    // [invoice-bill-to 2026-07-03] Manual "Bill to" name override. Empty/null
    // clears it (→ falls back to client/account name). Trim + length-cap.
    const billToProvided = bill_to_name !== undefined;
    const billToValue = bill_to_name === null || String(bill_to_name).trim() === ""
      ? null : String(bill_to_name).trim().slice(0, 200);

    // [invoice-service-date 2026-07-03] Manual service-date override. YYYY-MM-DD
    // sets it; empty/null clears it (→ API re-derives from job / line-item dates).
    const svcProvided = service_date !== undefined;
    const svcValue = service_date === null || service_date === "" ? null : String(service_date);
    if (svcProvided && svcValue !== null && !/^\d{4}-\d{2}-\d{2}$/.test(svcValue)) {
      return res.status(400).json({ error: "Bad Request", message: "service_date must be YYYY-MM-DD or empty" });
    }

    // [invoice-edit-dates 2026-07-03] Due date is editable on a draft/sent
    // invoice (Maribel: "can't edit any of these"). Empty string / null clears
    // it (→ due on receipt). Reject anything that isn't YYYY-MM-DD so a bad
    // value can't reach the date column.
    const dueProvided = due_date !== undefined;
    const dueValue = due_date === null || due_date === "" ? null : String(due_date);
    if (dueProvided && dueValue !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dueValue)) {
      return res.status(400).json({ error: "Bad Request", message: "due_date must be YYYY-MM-DD or empty" });
    }

    // [invoice-date 2026-07-03] The "Created" date IS the invoice date the office
    // bills by (Maribel: "the issue is the creation date"). Editable on
    // non-paid/void invoices. Stored at noon UTC so it renders as the same
    // calendar day in US timezones (bare midnight would show the prior day).
    // created_at is NOT NULL — an empty value is ignored, never cleared.
    const createdProvided = created_date !== undefined && created_date !== null && created_date !== "";
    if (createdProvided && !/^\d{4}-\d{2}-\d{2}$/.test(String(created_date))) {
      return res.status(400).json({ error: "Bad Request", message: "created_date must be YYYY-MM-DD" });
    }

    // Edit guard: a paid or void invoice is immutable. Editing happens on
    // draft / sent / overdue (overdue is a display-derivation of sent). Paid →
    // reverse via refund flow; void → already inert. Keeps the books honest.
    const [current] = await db
      .select({ status: invoicesTable.status, subtotal: invoicesTable.subtotal, tips: invoicesTable.tips })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .limit(1);
    if (!current) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });
    if (current.status === "paid" || current.status === "void" || current.status === "superseded") {
      return res.status(409).json({ error: "Conflict", message: `A ${current.status} invoice cannot be edited` });
    }

    // [invoice-view-crash 2026-06-20] Normalize line_items numeric fields to
    // real numbers before persisting. The edit UI's qty/rate inputs hand back
    // raw e.target.value STRINGS; storing them as strings in the jsonb is what
    // crashed the invoice View (the read render called .toFixed() on a string →
    // TypeError → ErrorBoundary "Something went wrong"). Coercing here is the
    // durable fix — it protects every reader of line_items (View, PDF, QB sync,
    // recalc), not just the one render path. The total is still derived from the
    // (now numeric) line totals, so it can never drift.
    const normLineItems = normalizeInvoiceLineItems(line_items);

    // Total ALWAYS = sum(line items) + tips, so it can never silently drift from
    // the lines. Use the new lines if provided, else the stored subtotal; use
    // the new tip if provided, else the stored tip.
    const subtotal = normLineItems
      ? Math.round(normLineItems.reduce((s: number, item: any) => s + (Number(item.total) || 0), 0) * 100) / 100
      : parseFloat(current.subtotal || "0");
    const tipVal = tips !== undefined ? (Number(tips) || 0) : parseFloat(current.tips || "0");
    const total = Math.round((subtotal + tipVal) * 100) / 100;

    const [updated] = await db
      .update(invoicesTable)
      .set({
        ...(status && { status }),
        ...(normLineItems && { line_items: normLineItems }),
        ...(dueProvided && { due_date: dueValue }),
        ...(createdProvided && { created_at: new Date(String(created_date) + "T12:00:00Z") }),
        ...(svcProvided && { service_date: svcValue }),
        ...(billToProvided && { bill_to_name: billToValue }),
        tips: tipVal.toFixed(2),
        subtotal: subtotal.toFixed(2),
        total: total.toFixed(2),
        ...(status === "sent" && { sent_at: new Date() }),
        ...(status === "paid" && { paid_at: new Date() }),
      })
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .returning();

    if (!updated) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });

    logAudit(req, "UPDATE", "invoice", invoiceId, { status: current.status }, { line_items, tips: tipVal, total });

    // QB re-push on edit (fire and forget, one-way; no-op when not connected).
    queueSync(() => syncInvoice(req.auth!.companyId, invoiceId));
    if (status === "paid") {
      queueSync(() => syncPayment(req.auth!.companyId, invoiceId));
    }

    const [client] = await db
      .select({ first_name: clientsTable.first_name, last_name: clientsTable.last_name, email: clientsTable.email })
      .from(clientsTable)
      .where(eq(clientsTable.id, updated.client_id))
      .limit(1);

    return res.json(formatInvoice({
      ...updated,
      client_name: `${client?.first_name || ""} ${client?.last_name || ""}`.trim(),
      client_email: client?.email,
    }));
  } catch (err) {
    console.error("Update invoice error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to update invoice" });
  }
});

router.post("/:id/send", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);

    const [invoice] = await db
      .select({ id: invoicesTable.id, client_id: invoicesTable.client_id, total: invoicesTable.total,
                invoice_number: invoicesTable.invoice_number, due_date: invoicesTable.due_date })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .limit(1);

    if (!invoice) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });

    const [updated] = await db
      .update(invoicesTable)
      .set({ status: "sent", sent_at: new Date() })
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .returning();

    const [client] = await db
      .select({ first_name: clientsTable.first_name, last_name: clientsTable.last_name,
                email: clientsTable.email, phone: clientsTable.phone,
                address: clientsTable.address, city: clientsTable.city })
      .from(clientsTable)
      .where(eq(clientsTable.id, invoice.client_id))
      .limit(1);

    const companyId = req.auth!.companyId;
    const invNum  = invoice.invoice_number || generateInvoiceNumber(invoiceId);
    // Mint a Stripe pay-token so the email's "View and Pay" button charges the
    // invoice total on the public /pay/:token page.
    const invLink = await mintInvoicePayLink(companyId, invoice.client_id, invoiceId, invoice.total, req.auth!.userId);
    const mergeVars = {
      first_name:       client?.first_name || "",
      invoice_number:   invNum,
      invoice_amount:   parseFloat(invoice.total || "0").toFixed(2),
      invoice_due_date: invoice.due_date ? new Date(invoice.due_date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "upon receipt",
      invoice_link:     invLink,
      service_address:  [client?.address, client?.city].filter(Boolean).join(", "),
    };
    sendNotification("invoice_sent", "email", companyId, client?.email ?? null, null, mergeVars).catch(() => {});
    sendNotification("invoice_sent", "sms",   companyId, null, client?.phone ?? null, mergeVars).catch(() => {});

    return res.json(formatInvoice({
      ...updated,
      client_name: `${client?.first_name || ""} ${client?.last_name || ""}`.trim(),
      client_email: client?.email,
    }));
  } catch (err) {
    console.error("Send invoice error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to send invoice" });
  }
});

router.post("/:id/remind", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);

    const [invoice] = await db
      .select({
        id: invoicesTable.id,
        client_id: invoicesTable.client_id,
        invoice_number: invoicesTable.invoice_number,
        total: invoicesTable.total,
        status: invoicesTable.status,
      })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .limit(1);

    if (!invoice) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });

    const [client] = await db
      .select({ first_name: clientsTable.first_name, last_name: clientsTable.last_name, email: clientsTable.email })
      .from(clientsTable)
      .where(eq(clientsTable.id, invoice.client_id))
      .limit(1);

    const clientEmail = client?.email;
    const invNum = invoice.invoice_number || generateInvoiceNumber(invoiceId);

    if (clientEmail && process.env.RESEND_API_KEY) {
      const { isEmailOptedOut, buildEmailUnsubData } = await import("../lib/opt-out.js");
      if (process.env.COMMS_ENABLED !== "true") {
        console.log("[COMMS BLOCKED] Invoice reminder email suppressed:", { to: clientEmail, invoiceId });
      } else if (await isEmailOptedOut(req.auth!.companyId!, clientEmail)) {
        console.log("[comms-opt-out] Invoice reminder email suppressed (opt-out):", { to: clientEmail, invoiceId });
      } else {
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      const payLink = await mintInvoicePayLink(req.auth!.companyId!, invoice.client_id, invoiceId, invoice.total, req.auth!.userId);
      const unsub = await buildEmailUnsubData(req.auth!.companyId!, clientEmail);
      await resend.emails.send({
        from: "notifications@phes.io",
        to: clientEmail,
        subject: `Friendly reminder — Invoice ${invNum} is due`,
        html: `<p>Hi ${client?.first_name || "there"},</p>
               <p>This is a friendly reminder that invoice <strong>${invNum}</strong> for <strong>$${parseFloat(invoice.total || "0").toFixed(2)}</strong> is due.</p>
               <p><a href="${payLink}">Pay Now</a></p>
               <p>Thank you,<br>Phes</p>${unsub?.footerHtml ?? ""}`,
        ...(unsub?.headers ? { headers: unsub.headers } : {}),
      });
      }
    }

    await db.update(invoicesTable)
      .set({ last_reminder_sent_at: new Date() })
      .where(eq(invoicesTable.id, invoiceId));

    await db.insert(notificationLogTable).values({
      company_id: req.auth!.companyId,
      recipient: clientEmail || "system",
      channel: "email",
      trigger: "invoice_reminder",
      status: "sent",
      metadata: { invoice_id: invoiceId, amount: parseFloat(invoice.total || "0") } as any,
    });

    return res.json({ ok: true, sent_to: clientEmail || null });
  } catch (err) {
    console.error("Remind invoice error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to send reminder" });
  }
});

router.post("/:id/mark-paid", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);
    const { method = "cash", amount, date: payDate, notes } = req.body;

    // [mark-paid-recalc 2026-07-02] Never record a STALE amount. If this invoice
    // is tied to a single job, re-derive its lines/total from the job's CURRENT
    // price + add-ons + discounts before recording payment — the "invoice
    // mirrors the job" rule, enforced at the one moment money is captured. This
    // closes the gap where a job was edited (e.g. Shellie 4h→3h, $220→$165) but
    // the sync was missed and Mark Paid would otherwise bank the old figure.
    // Only single-job invoices (job_id set) and only when still unpaid; account/
    // consolidated invoices (job_id NULL, jobs live in line_items) are untouched.
    const [pre] = await db
      .select({ job_id: invoicesTable.job_id, status: invoicesTable.status, tips: invoicesTable.tips })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId as number)))
      .limit(1);
    const preJobId: number | null = pre?.job_id ?? null;
    if (preJobId != null && !["paid", "void", "superseded"].includes((pre?.status ?? "") as string)) {
      try {
        const built = await buildJobLineItems(req.auth!.companyId as number, preJobId);
        if (built) {
          const tipVal = parseFloat(pre.tips || "0");
          const freshTotal = Math.round((built.subtotal + tipVal) * 100) / 100;
          await db.update(invoicesTable)
            .set({ line_items: built.lineItems, subtotal: built.subtotal.toFixed(2), total: freshTotal.toFixed(2) })
            .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId as number)));
        }
      } catch (e) {
        console.error("[mark-paid] pre-payment recalc non-fatal:", e);
      }
    }

    const [invoice] = await db
      .select({ id: invoicesTable.id, client_id: invoicesTable.client_id, total: invoicesTable.total })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .limit(1);

    if (!invoice) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });

    const payAmount = amount ?? parseFloat(invoice.total || "0");

    await db.insert(paymentsTable).values({
      company_id: req.auth!.companyId,
      client_id: invoice.client_id,
      invoice_id: invoiceId,
      amount: payAmount.toString(),
      method,
      status: "completed",
      processed_by: req.auth!.userId,
    });

    const [updated] = await db
      .update(invoicesTable)
      .set({ status: "paid", paid_at: payDate ? new Date(payDate) : new Date() })
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .returning();

    await db.insert(notificationLogTable).values({
      company_id: req.auth!.companyId,
      recipient: "system",
      channel: "system",
      trigger: "payment_collected",
      status: "sent",
      metadata: { invoice_id: invoiceId, amount: payAmount, method } as any,
    });

    logAudit(req, "PAYMENT_CHARGED", "invoice", invoiceId, null, { amount: payAmount, method, invoice_id: invoiceId });

    // QB sync (fire and forget)
    queueSync(async () => {
      await syncInvoice(req.auth!.companyId, invoiceId);
      await syncPayment(req.auth!.companyId, invoiceId);
    });

    return res.json(formatInvoice({ ...updated, client_name: null }));
  } catch (err) {
    console.error("Mark paid error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to mark invoice as paid" });
  }
});

// ── Mark UNPAID (undo a manual Mark Paid) ───────────────────────────────────
// Office-only. Reverts a manually-marked-paid invoice back to the finalized,
// outstanding ('sent') state and clears paid_at so the KPIs move it back out of
// Paid/YTD into Outstanding. Removes the manual payment record(s) created by
// Mark Paid. Refuses to touch an invoice that carries a real processor payment
// (Stripe/Square) — that must be reversed via a refund, not an unmark.
router.post("/:id/mark-unpaid", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);
    if (isNaN(invoiceId)) return res.status(400).json({ error: "Bad Request", message: "Invalid invoice id" });

    const [invoice] = await db
      .select({
        id: invoicesTable.id,
        status: invoicesTable.status,
        stripe_payment_intent_id: invoicesTable.stripe_payment_intent_id,
        square_payment_id: invoicesTable.square_payment_id,
      })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .limit(1);

    if (!invoice) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });
    if (invoice.status !== "paid") {
      return res.status(409).json({ error: "Conflict", message: "Only a paid invoice can be marked unpaid" });
    }
    if (invoice.stripe_payment_intent_id || invoice.square_payment_id) {
      return res.status(409).json({ error: "Conflict", message: "This invoice has a processor payment — issue a refund instead of marking it unpaid" });
    }

    // Back to finalized/outstanding so the Outstanding KPI picks it up again.
    const [updated] = await db
      .update(invoicesTable)
      .set({ status: "sent", paid_at: null })
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .returning();

    // Drop the manual payment record(s) the Mark Paid action inserted. (Guarded
    // above against processor payments, so these are office manual marks only.)
    await db.delete(paymentsTable)
      .where(and(eq(paymentsTable.invoice_id, invoiceId), eq(paymentsTable.company_id, req.auth!.companyId)));

    logAudit(req, "UPDATE", "invoice", invoiceId, { status: "paid" }, { status: "sent", unmarked_paid: true });

    // Reflect the reversal in QuickBooks (one-way push; no-op when not connected).
    queueSync(() => syncInvoice(req.auth!.companyId, invoiceId));

    return res.json(formatInvoice({ ...updated, client_name: null }));
  } catch (err) {
    console.error("Mark unpaid error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to mark invoice unpaid" });
  }
});

// ── Office-triggered charge (Scope 3) ──────────────────────────────────────
// Routes by the invoice's effective payment_source. Office-only. Charges at most
// once — NO auto-retry. stripe → off-session charge; square → Square (when
// configured); check/ach → no charge, office marks paid manually.
router.post("/:id/charge", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);
    if (isNaN(invoiceId)) return res.status(400).json({ error: "Bad Request", message: "Invalid invoice id" });

    const result = await chargeInvoice(req.auth!.companyId, invoiceId, req.auth!.userId);

    logAudit(req, "PAYMENT_CHARGED", "invoice", invoiceId, null, {
      outcome: result.outcome, source: result.source, amount: result.amount ?? null,
    });

    // 200 for paid + the no-charge routes (manual is a valid routing outcome);
    // 402 for a real charge failure so the UI can flag it; 409 for bad state.
    const httpStatus =
      result.outcome === "paid" || result.outcome === "needs_manual" ? 200 :
      result.outcome === "failed" ? 402 : 409;
    return res.status(httpStatus).json(result);
  } catch (err) {
    console.error("Charge invoice error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to charge invoice" });
  }
});

// ── Void (Scope 4) ──────────────────────────────────────────────────────────
// Office-only. Voids a draft/sent/overdue invoice. Paid invoices must be
// refunded, not voided; superseded children are already inert.
router.post("/:id/void", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);
    if (isNaN(invoiceId)) return res.status(400).json({ error: "Bad Request", message: "Invalid invoice id" });

    const [invoice] = await db
      .select({ id: invoicesTable.id, status: invoicesTable.status })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .limit(1);
    if (!invoice) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });
    if (invoice.status === "paid") return res.status(409).json({ error: "Conflict", message: "A paid invoice cannot be voided — issue a refund instead" });
    if (invoice.status === "superseded") return res.status(409).json({ error: "Conflict", message: "A superseded (folded) invoice is already inert" });
    if (invoice.status === "void") return res.json({ ok: true, already_void: true });

    const [updated] = await db
      .update(invoicesTable)
      .set({ status: "void" })
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .returning();

    logAudit(req, "UPDATE", "invoice", invoiceId, { status: invoice.status }, { status: "void" });

    // Reflect the void in QuickBooks (one-way; no-op when not connected).
    queueSync(async () => {
      const { voidQbInvoice } = await import("../services/quickbooks-sync.js");
      await voidQbInvoice(req.auth!.companyId, invoiceId);
    });

    return res.json(formatInvoice({ ...updated, client_name: null }));
  } catch (err) {
    console.error("Void invoice error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to void invoice" });
  }
});

// ── Recalc from job (Fix 2) ─────────────────────────────────────────────────
// Rebuild an invoice's line items from its job's CURRENT locked pricing (scope +
// ALL add-ons + ALL discounts) via the shared builder. This is how the office
// pulls a post-completion dispatch change (e.g. an add-on added after the
// per-visit invoice already went 'sent') onto the invoice — since sent invoices
// are not auto-resynced. Preserves any manually-entered tip. Blocked on
// paid/void/superseded. Re-pushes to QB.
router.post("/:id/recalc", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);
    if (isNaN(invoiceId)) return res.status(400).json({ error: "Bad Request", message: "Invalid invoice id" });

    const [inv] = await db
      .select({ id: invoicesTable.id, status: invoicesTable.status, job_id: invoicesTable.job_id, tips: invoicesTable.tips })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .limit(1);
    if (!inv) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });
    if (inv.status === "paid" || inv.status === "void" || inv.status === "superseded") {
      return res.status(409).json({ error: "Conflict", message: `A ${inv.status} invoice cannot be recalculated` });
    }
    if (!inv.job_id) {
      return res.status(400).json({ error: "Bad Request", message: "This invoice is not linked to a job — edit its line items directly" });
    }

    const built = await buildJobLineItems(req.auth!.companyId, inv.job_id);
    if (!built) return res.status(404).json({ error: "Not Found", message: "Linked job not found" });

    const tipVal = parseFloat(inv.tips || "0");
    const total = Math.round((built.subtotal + tipVal) * 100) / 100;

    const [updated] = await db
      .update(invoicesTable)
      .set({ line_items: built.lineItems, subtotal: built.subtotal.toFixed(2), total: total.toFixed(2) })
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .returning();

    logAudit(req, "UPDATE", "invoice", invoiceId, null, { action: "recalc_from_job", job_id: inv.job_id, total });
    queueSync(() => syncInvoice(req.auth!.companyId, invoiceId));

    return res.json(formatInvoice({ ...updated, client_name: null }));
  } catch (err) {
    console.error("Recalc invoice error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to recalc invoice" });
  }
});

// ── Refund (partial or full) ────────────────────────────────────────────────
// Issues a refund against a paid invoice. For Stripe-charged invoices the
// refund is initiated via the Stripe API before the DB is updated — so money
// actually moves. For manual payments (check, ACH, Square) the refund is
// recorded in the DB only; money is returned offline by the office.
//
// Guards:
//   - Invoice must be 'paid' (not draft / sent / void / superseded)
//   - amount must be > 0 and ≤ total (no double-refunding beyond face value)
//   - Re-refunding is blocked when refunded_amount already equals total
//
// Status stays 'paid' — a refunded invoice is still a completed transaction;
// the net owed is (total − refunded_amount). No new enum value needed.
router.post("/:id/refund", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);
    if (isNaN(invoiceId)) return res.status(400).json({ error: "Bad Request", message: "Invalid invoice id" });

    const { amount, reason } = req.body ?? {};
    const refundAmount = parseFloat(amount);
    if (!refundAmount || refundAmount <= 0) {
      return res.status(400).json({ error: "Bad Request", message: "amount must be a positive number" });
    }

    const [invoice] = await db
      .select({
        id: invoicesTable.id,
        status: invoicesTable.status,
        total: invoicesTable.total,
        refunded_amount: invoicesTable.refunded_amount,
        stripe_payment_intent_id: invoicesTable.stripe_payment_intent_id,
        payment_source: invoicesTable.payment_source,
      })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .limit(1);

    if (!invoice) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });
    if (invoice.status !== "paid") {
      return res.status(409).json({ error: "Conflict", message: "Only paid invoices can be refunded" });
    }

    const invoiceTotal = parseFloat(invoice.total || "0");
    const alreadyRefunded = parseFloat(invoice.refunded_amount || "0");
    const maxRefundable = invoiceTotal - alreadyRefunded;

    if (maxRefundable <= 0) {
      return res.status(409).json({ error: "Conflict", message: "This invoice has already been fully refunded" });
    }
    if (refundAmount > maxRefundable + 0.005) {
      return res.status(400).json({
        error: "Bad Request",
        message: `Refund amount $${refundAmount.toFixed(2)} exceeds the refundable balance of $${maxRefundable.toFixed(2)}`,
      });
    }

    // For Stripe-charged invoices, initiate the refund via the API so money
    // actually moves. Fire before the DB write so a Stripe failure aborts the
    // request before any local state changes.
    if (invoice.stripe_payment_intent_id && invoice.payment_source === "stripe") {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey || stripeKey === "payments disabled") {
        return res.status(503).json({ error: "Service Unavailable", message: "Stripe is not configured" });
      }
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" as any });
      await stripe.refunds.create({
        payment_intent: invoice.stripe_payment_intent_id,
        amount: Math.round(refundAmount * 100), // cents
      });
    }

    const newRefundedTotal = alreadyRefunded + refundAmount;
    const [updated] = await db
      .update(invoicesTable)
      .set({
        refunded_amount: newRefundedTotal.toFixed(2),
        refund_reason: (reason as string | undefined) || null,
        refunded_at: new Date(),
      })
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .returning();

    logAudit(req, "UPDATE", "invoice", invoiceId, { refunded_amount: alreadyRefunded }, {
      refunded_amount: newRefundedTotal,
      refund_reason: reason || null,
      source: invoice.stripe_payment_intent_id ? "stripe" : "manual",
    });

    return res.json({
      ...formatInvoice({ ...updated, client_name: null }),
      refunded_amount: newRefundedTotal,
      refund_reason: reason || null,
      refunded_at: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("Refund invoice error:", err);
    const msg = err?.message || "Failed to issue refund";
    return res.status(500).json({ error: "Internal Server Error", message: msg });
  }
});

// ── POST /api/invoices/merge ───────────────────────────────────────────────
// [invoice-merge 2026-07-02] Bulk-fold a selected set of invoices into ONE.
// The office filters (e.g. all of an account's June turnovers across buildings)
// and picks invoices; this rolls them into a single draft parent that carries
// every folded line + the summed total, and marks the sources 'superseded'
// (parent_invoice_id set) so they drop out of AR and the customer sees/pays one
// bill. Only the parent pushes to QuickBooks. Guards: all invoices same company,
// same customer (one account_id OR one client_id), and unpaid (draft/sent/
// overdue) — never paid/void/already-superseded.
router.post("/merge", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const ids: number[] = Array.isArray(req.body?.invoice_ids)
      ? req.body.invoice_ids.map((x: any) => parseInt(String(x), 10)).filter((n: number) => Number.isInteger(n) && n > 0)
      : [];
    if (ids.length < 2) return res.status(400).json({ error: "Bad Request", message: "Select at least 2 invoices to merge" });

    const rows = await db.select().from(invoicesTable)
      .where(and(eq(invoicesTable.company_id, companyId), inArray(invoicesTable.id, ids)));
    if (rows.length !== new Set(ids).size) {
      return res.status(404).json({ error: "Not Found", message: "One or more invoices not found" });
    }

    const bad = rows.find((r) => !["draft", "sent", "overdue"].includes(r.status as string));
    if (bad) {
      return res.status(409).json({ error: "Conflict", message: `Invoice ${bad.invoice_number || bad.id} is '${bad.status}' — only unpaid invoices can be merged` });
    }

    // Same customer only — one account, or (if no account) one client.
    const accountIds = new Set(rows.map((r) => r.account_id ?? null));
    const clientIds = new Set(rows.map((r) => r.client_id ?? null));
    const sameAccount = accountIds.size === 1 && [...accountIds][0] != null;
    const sameClient = clientIds.size === 1 && [...clientIds][0] != null;
    if (!sameAccount && !sameClient) {
      return res.status(400).json({ error: "Bad Request", message: "All selected invoices must belong to the same customer" });
    }

    // Parent = every folded invoice's lines flattened + summed total.
    const parentLines: any[] = [];
    let parentTotal = 0;
    for (const r of rows) {
      parentTotal += parseFloat(String(r.total ?? "0"));
      const childLines = Array.isArray(r.line_items) ? (r.line_items as any[]) : [];
      if (childLines.length > 0) {
        for (const l of childLines) parentLines.push(l);
      } else {
        const t = parseFloat(String(r.total ?? "0"));
        parentLines.push({ description: `Invoice ${r.invoice_number || r.id}`, quantity: 1, unit_price: t, total: t });
      }
    }
    parentTotal = Math.round(parentTotal * 100) / 100;
    const first = rows[0];

    const [parent] = await db.insert(invoicesTable).values({
      company_id: companyId,
      account_id: sameAccount ? first.account_id : null,
      client_id: sameAccount ? null : first.client_id,
      status: "draft",
      line_items: parentLines,
      subtotal: parentTotal.toFixed(2),
      total: parentTotal.toFixed(2),
      payment_terms: first.payment_terms,
      due_date: first.due_date,
      created_by: req.auth!.userId,
    }).returning();

    try {
      const invNum = await getNextInvoiceNumber(companyId, parent.id);
      await db.update(invoicesTable).set({ invoice_number: invNum }).where(eq(invoicesTable.id, parent.id));
    } catch (numErr) {
      console.error("[invoice-merge] number assignment non-fatal:", numErr);
    }

    // Fold the sources: superseded + parent link (drops them from AR).
    await db.update(invoicesTable)
      .set({ status: "superseded", parent_invoice_id: parent.id })
      .where(and(eq(invoicesTable.company_id, companyId), inArray(invoicesTable.id, ids)));

    logAudit(req, "MERGE", "invoice", parent.id, null, { merged_invoice_ids: ids, count: ids.length, total: parentTotal });

    // Only the parent goes to QuickBooks (one consolidated document).
    queueSync(() => syncInvoice(companyId, parent.id));

    return res.status(201).json({ ok: true, invoice: parent, merged_count: ids.length, total: parentTotal });
  } catch (err) {
    console.error("Invoice merge error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to merge invoices" });
  }
});

export default router;
