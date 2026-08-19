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
import { onOrAfterCutover, cutoverDate } from "../lib/billing-cutover.js";
import { normalizeInvoiceLineItems } from "../lib/normalize-line-items.js";
import { preserveJobIds } from "../lib/invoice-job-ids.js";
import { combineInvoices, splitBatchInvoice, cascadeBatchPayment, ensurePerVisitInvoice } from "../lib/invoice-billing.js";

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
  // [auto-issue 2026-07-08] Aging starts when the invoice was actually
  // COMMUNICATED (sent_at) — an auto-issued due-on-receipt invoice was
  // reading OVERDUE the day after completion, before any customer ever saw
  // it. "Due on receipt" can't start before receipt.
  const overdue = inv.status === "sent" && inv.sent_at && inv.due_date && new Date(inv.due_date) < new Date();
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

// [invoice-recipient 2026-08-09] ONE recipient chain for every invoice email.
// An invoice is addressed to whoever is on it: the invoice-level override first,
// then the client, then the account's billing contact. That last hop is not an
// edge case — 386 of Phes's 1,211 invoices (every ACCOUNT invoice) have a null
// client_id, so a chain that stops at clients.email cannot address a third of
// the book. POST /:id/send grew this chain in #964; POST /:id/remind never did,
// and kept looking up clients.email alone — which is why Maribel's "Send
// Reminder" on invoice #7329 (account 44, "Maribel Test") answered "No recipient
// email" even though account_contacts had maribel@phes.io sitting right there,
// and why the plain Send on that same invoice worked.
//
// Shared so the two can't drift again. The ORDER BY is the priority the office
// set: an explicitly flagged invoice recipient, then the billing role, then the
// primary contact, then oldest.
async function resolveInvoiceRecipient(
  companyId: number,
  invoice: { billing_contact_email?: string | null; billing_contact_name?: string | null; account_id?: number | null },
  client?: { email?: string | null; first_name?: string | null } | null,
): Promise<{ email: string | null; name: string | null }> {
  let email: string | null = invoice.billing_contact_email || client?.email || null;
  let name: string | null = invoice.billing_contact_name || client?.first_name || null;
  if (!email && invoice.account_id) {
    const ac = await db.execute(sql`
      SELECT name, email FROM account_contacts
      WHERE account_id = ${invoice.account_id} AND company_id = ${companyId} AND email IS NOT NULL AND email <> ''
      ORDER BY receives_invoices DESC, (role = 'billing') DESC, is_primary DESC, id ASC
      LIMIT 1`);
    const row = ac.rows[0] as any;
    if (row?.email) { email = row.email; name = name || row.name || null; }
  }
  return { email, name };
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
    } else {
      // [hide-inert 2026-07-04] The default "All" view hides void + superseded
      // invoices. They're kept as records (audit trail / invoice-number
      // continuity) but shouldn't clutter the working list — voiding an invoice
      // shouldn't leave a dead NET-30 row on screen. Still reachable via the
      // explicit "Void" filter (status=void).
      // [batch-invoicing 2026-08-03] ONE exception: a 'superseded' row that
      // points at a parent is not clutter — it is a visit that was merged in
      // July by the old destructive fold, and hiding it is literally what
      // Maribel meant by "They disapeared." 28 rows company-wide, all July 2026,
      // all still carrying their real amount. They come back into the list
      // labelled COMBINED with a "Billed on #<parent>" chip, so the money is
      // traceable from either end. Superseded rows with no parent (the ~1,050
      // MaidCentral-mirror leftovers) stay hidden — those really are clutter.
      conditions.push(sql`(
        ${invoicesTable.status}::text NOT IN ('void', 'superseded')
        OR (${invoicesTable.status}::text = 'superseded' AND ${invoicesTable.parent_invoice_id} IS NOT NULL)
      )`);
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
      // [account-draft-visible 2026-07-10] The future-hide was built to hide
      // RESIDENTIAL recurring auto-drafts (billing-in-advance noise). But ACCOUNT
      // (commercial) invoicing is per-job DRAFT invoices that the office
      // deliberately accumulates and merges into one bill — hiding a future-dated
      // account draft broke that: Maribel couldn't merge Autochlor's 7/20 draft
      // because it never appeared in the list. Only hide NON-account future drafts.
      conditions.push(sql`NOT (
        ${invoicesTable.status} = 'draft'
        AND ${invoicesTable.job_id} IS NOT NULL
        AND ${invoicesTable.account_id} IS NULL
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
        // [batch-invoicing 2026-08-03] Combining used to blank a member out and
        // hide it — Maribel's "They disapeared." Members now stay in the list at
        // full value with status 'batched', so the list has to say WHERE the
        // money went. These three fields are what the row renders that with:
        // a member shows "Billed on #<parent>", a parent shows "N visits".
        batch_status: invoicesTable.batch_status,
        parent_invoice_id: invoicesTable.parent_invoice_id,
        parent_invoice_number: sql<string | null>`(SELECT p.invoice_number FROM invoices p WHERE p.id = ${invoicesTable.parent_invoice_id})`,
        // ::text on the status compare, deliberately — a bare 'batched' literal
        // is parsed as the enum and errors outright on a database that has not
        // run the migration yet, taking the whole invoice list down with it.
        batch_member_count: sql<number>`(SELECT COUNT(*)::int FROM invoices m WHERE m.parent_invoice_id = ${invoicesTable.id} AND m.status::text = 'batched')`,
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
      // [revenue-qleno-only 2026-07-04] Paid(30d) and YTD Revenue count ONLY
      // Qleno-native revenue — invoices whose effective service date is on/after
      // the cutover. The MaidCentral history import (paid invoices back-dated into
      // 2026) otherwise dominated both figures (~95% of "YTD"), so the cards
      // reported old MC money as Qleno revenue. Outstanding/Overdue are unchanged
      // (they only contain live sent invoices, all post-cutover already).
      db.select({ total: sum(invoicesTable.total) })
        .from(invoicesTable)
        .where(and(compCond, eq(invoicesTable.status, "paid"),
          sql`${invoicesTable.paid_at} >= now() - interval '30 days'`,
          sql`${effDate} >= ${cutoverDate(req.auth!.companyId as number)}`)),
      db.select({ total: sum(invoicesTable.total) })
        .from(invoicesTable)
        .where(and(compCond, eq(invoicesTable.status, "paid"),
          sql`extract(year from ${invoicesTable.paid_at}) = extract(year from now())`,
          sql`${effDate} >= ${cutoverDate(req.auth!.companyId as number)}`)),
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
    let finalAccountId: number | null = null;

    // [single-path 2026-08-05] A job-keyed invoice is created by ONE function,
    // ensurePerVisitInvoice — the same one completion and the account button
    // use (design D-3/D-6). This route used to build its own INSERT here, and
    // that fork is what made the whole safety net decorative:
    //
    //   - it never checked getVisitBillingState, so it would happily mint a
    //     second invoice for a visit that already had one;
    //   - it never wrote an invoice_job_links row, so the partial unique index
    //     (S-1 — "the only guarantee that doesn't depend on the next developer
    //     knowing about this doc") had nothing to conflict with, and the
    //     nightly integrity sweep's double-bill check could not see the
    //     duplicate either. Both alarms read clean while the customer got two
    //     invoices.
    //   - for residential jobs it built its line from `base_fee` alone, so
    //     every add-on and discount silently fell off the document.
    //
    // Delegating fixes all three at once. Ad-hoc invoices (client_id +
    // explicit line_items, no job) keep the manual path below — there is no
    // visit to claim coverage on.
    //
    // NARROWING: job_id now always routes here. The old guard was
    // `job_id && (!client_id || !rawLineItems)`, so a caller could pass a
    // job_id AND its own line_items and land in the manual path — creating a
    // job-keyed invoice with no coverage claim, which is precisely the hole.
    // Caller-supplied lines are ignored for job-keyed creates; the job's locked
    // pricing is the source of truth. To adjust them, PUT line_items after.
    //
    // DELIBERATE DROP: the job path no longer runs the Stripe auto-charge block
    // below. That block fired on any client with auto_charge + a Stripe
    // customer REGARDLESS of whether the invoice was a draft, so "create a
    // draft for review" could move money. Both callers (the batch selector and
    // the job panel) send auto_send:false, so nothing in the UI ever wanted it,
    // and card capture is Square's rail now anyway. Charging is an explicit
    // action via /payments/charge-card.
    if (job_id) {
      const r = await ensurePerVisitInvoice({
        companyId: req.auth!.companyId as number,
        jobId: job_id,
        userId: req.auth!.userId,
        // [rebill 2026-08-05] D-5 makes void a tombstone, so the documented
        // re-issue flow (void the wrong invoice, then re-create from the job)
        // has to say out loud that it means to re-bill. `rebill: true` IS that
        // explicit office action — without it a voided visit returns 409 and
        // the office is told why, which is the whole point of the tombstone.
        force: req.body?.rebill === true || req.body?.force === true,
        overrides: {
          paymentTerms: reqPaymentTerms || null,
          issue: auto_send === true,
          poNumber: po_number || null,
          billingContactName: reqBillingName || null,
          billingContactEmail: reqBillingEmail || null,
          tips: tips || 0,
        },
      });

      // Refused. The visit is cancelled, non-billable, or deliberately voided
      // (D-5: void is a tombstone — re-billing is an explicit office action,
      // never a side effect of clicking Create).
      if (!r.invoiceId) {
        const status = r.reason === "job_not_found" ? 404 : 409;
        const message =
          r.reason === "job_not_found" ? "Job not found"
          : r.reason === "cancelled" ? "This visit was cancelled — nothing to bill"
          : r.reason === "non_billable" ? "This visit is marked non-billable (redo/guarantee)"
          : r.reason === "voided" ? "This visit's invoice was voided. Re-billing it is an explicit action — resend with rebill: true to create a new one."
          : "Could not create an invoice for this visit";
        return res.status(status).json({ error: status === 404 ? "Not Found" : "Conflict", message, reason: r.reason });
      }

      const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, r.invoiceId)).limit(1);

      // Already covered by a live invoice. Hand back the one that exists rather
      // than a duplicate — this is what makes the batch selector safe to click
      // twice, and safe to click on a job whose draft the office forgot about.
      if (!r.created) {
        return res.status(200).json({
          ...inv,
          total: parseFloat(inv?.total || "0"),
          already_invoiced: true,
          message: `This visit is already on invoice ${inv?.invoice_number || r.invoiceId}`,
        });
      }

      logAudit(req, "CREATE", "invoice", r.invoiceId, null, {
        total: parseFloat(inv?.total || "0"), client_id: inv?.client_id ?? null,
        account_id: inv?.account_id ?? null, job_id,
      });
      queueSync(() => syncInvoice(req.auth!.companyId as number, r.invoiceId!));

      await db.insert(notificationLogTable).values({
        company_id: req.auth!.companyId as number,
        recipient: "system",
        channel: "system",
        trigger: "invoice_created",
        status: "sent",
        metadata: { invoice_id: r.invoiceId, amount: parseFloat(inv?.total || "0"), job_id } as any,
      });

      return res.status(201).json({
        ...inv,
        subtotal: parseFloat(inv?.subtotal || "0"),
        tips: parseFloat(inv?.tips || "0"),
        total: parseFloat(inv?.total || "0"),
      });
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

// [batch-invoicing 2026-08-03] GET /api/invoices/integrity — the same read-only
// sweep the 6 AM cron runs, on demand. Answers "is our billing actually whole
// right now?" without anyone opening a psql session. Writes nothing.
router.get("/integrity", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const { runBillingIntegrityCheck } = await import("../lib/billing-integrity.js");
    const report = await runBillingIntegrityCheck(
      req.auth!.companyId as number,
      typeof req.query.as_of === "string" ? req.query.as_of : undefined,
    );
    return res.json(report);
  } catch (err) {
    console.error("Billing integrity error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to run the billing integrity check" });
  }
});

// NOTE: registered BEFORE /:id — a literal path after a param route is dead.
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
        // [batch-invoicing 2026-08-03] Which side of a combine this invoice is on.
        batch_status: invoicesTable.batch_status,
        parent_invoice_id: invoicesTable.parent_invoice_id,
        parent_invoice_number: sql<string | null>`(SELECT p.invoice_number FROM invoices p WHERE p.id = ${invoicesTable.parent_invoice_id})`,
      })
      .from(invoicesTable)
      .leftJoin(clientsTable, eq(invoicesTable.client_id, clientsTable.id))
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .limit(1);

    if (!invoice) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });

    // [batch-invoicing 2026-08-03] A combined invoice carries its members with
    // it. Before this, the parent showed line items and the members were gone
    // from the list — there was no way to get from the bill back to the visits
    // it covers. The detail page renders these as links, and they are what the
    // Split action puts back.
    const batchMembers = (await db.execute(sql`
      SELECT i.id, i.invoice_number, i.total::text AS total, i.status::text AS status,
             COALESCE(i.service_date, (SELECT j.scheduled_date FROM jobs j WHERE j.id = i.job_id))::text AS service_date
        FROM invoices i
       WHERE i.company_id = ${req.auth!.companyId} AND i.parent_invoice_id = ${invoiceId}
       ORDER BY COALESCE(i.service_date, (SELECT j.scheduled_date FROM jobs j WHERE j.id = i.job_id)) NULLS LAST, i.id`) as any).rows;

    return res.json({ ...formatInvoice(invoice), batch_members: batchMembers });
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

    // [invoice-pdf-parity 2026-07-07] Pull the same per-tenant branding columns
    // the web invoice reads (invoice-detail.tsx) so the PDF shows the identical
    // masthead and footer block, with the same fallbacks.
    const co = await db.execute(sql`SELECT name, logo_url, phone, email, address,
        invoice_business_name, invoice_tagline, invoice_address, invoice_footer_message,
        invoice_payment_instructions, invoice_guarantee, invoice_terms
      FROM companies WHERE id = ${companyId} LIMIT 1`);
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
      // [batch-invoicing 2026-08-03] Carried through so the PDF can print a
      // service PERIOD on a combined invoice instead of one arbitrary date.
      service_date: it.service_date ?? null,
    }));
    const billName = inv.bill_to_name || [inv.first_name, inv.last_name].filter(Boolean).join(" ") || inv.account_name || "Customer";
    const billAddr = [inv.address, [inv.city, inv.state].filter(Boolean).join(", "), inv.zip].filter(Boolean).join(", ");

    const bizName = company.invoice_business_name || company.name || "Invoice";
    const contactLine = [company.phone, company.email].filter(Boolean).join(" · ");
    const { renderInvoicePdf } = await import("../lib/invoice-pdf.js");
    const pdf = await renderInvoicePdf({
      companyName: bizName,
      logo,
      tagline: company.invoice_tagline || null,
      businessAddress: company.invoice_address || company.address || null,
      contactLine: contactLine || null,
      footerMessage: company.invoice_footer_message || `Thank you for choosing ${bizName}.`,
      paymentInstructions: company.invoice_payment_instructions
        || `Pay securely online using the link on this invoice.${contactLine ? ` Questions? Contact us at ${contactLine}.` : ""}`,
      guaranteeText: company.invoice_guarantee || null,
      termsText: company.invoice_terms || null,
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
    const { status, line_items, tips, due_date, created_date, service_date, bill_to_name, payment_terms } = req.body;

    // [invoice-terms 2026-07-03] Editable payment terms (fix invoices that
    // inherited the wrong terms — e.g. PPM invoices created while PPM was a
    // net-30 client that should be due-on-receipt now it's an account).
    const TERMS = new Set(["due_on_receipt", "net_7", "net_15", "net_30"]);
    const termsProvided = payment_terms !== undefined;
    if (termsProvided && !TERMS.has(String(payment_terms))) {
      return res.status(400).json({ error: "Bad Request", message: "payment_terms must be due_on_receipt | net_7 | net_15 | net_30" });
    }

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
    // [batch-invoicing 2026-08-03] 'batched' joins them: a member's dollars now
    // live on the combined parent, so editing it here would silently desync the
    // two. Split the batch first, then edit.
    const [current] = await db
      .select({ status: invoicesTable.status, subtotal: invoicesTable.subtotal, tips: invoicesTable.tips, line_items: invoicesTable.line_items, job_id: invoicesTable.job_id })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .limit(1);
    if (!current) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });
    if (["paid", "void", "superseded", "batched"].includes(current.status)) {
      return res.status(409).json({
        error: "Conflict",
        message: current.status === "batched"
          ? "This visit is part of a combined invoice — edit the combined invoice, or split it first"
          : `A ${current.status} invoice cannot be edited`,
      });
    }

    // [invoice-view-crash 2026-06-20] Normalize line_items numeric fields to
    // real numbers before persisting. The edit UI's qty/rate inputs hand back
    // raw e.target.value STRINGS; storing them as strings in the jsonb is what
    // crashed the invoice View (the read render called .toFixed() on a string →
    // TypeError → ErrorBoundary "Something went wrong"). Coercing here is the
    // durable fix — it protects every reader of line_items (View, PDF, QB sync,
    // recalc), not just the one render path. The total is still derived from the
    // (now numeric) line totals, so it can never drift.
    // [job-ids-preserve 2026-07-23] Carry forward any job id this edit dropped.
    // The edit UI sends whatever lines the office left on screen, so collapsing
    // four job lines into one `quantity: 4` line used to discard three job_ids —
    // leaving those visits billed but unnamed, invisible to every "already
    // invoiced?" guard, and free to re-mint as duplicate per-visit invoices
    // (Halper #985, Azzarello #1012, Cucci #1093). Amounts are untouched; only
    // the additive `job_ids` carrier is written.
    const normLineItems = normalizeInvoiceLineItems(line_items);
    const keptLineItems = normLineItems
      ? (preserveJobIds(current.line_items, normLineItems) as typeof normLineItems)
      : undefined;

    // Total ALWAYS = sum(line items) + tips, so it can never silently drift from
    // the lines. Use the new lines if provided, else the stored subtotal; use
    // the new tip if provided, else the stored tip.
    const subtotal = normLineItems
      ? Math.round(normLineItems.reduce((s: number, item: any) => s + (Number(item.total) || 0), 0) * 100) / 100
      : parseFloat(current.subtotal || "0");
    const tipVal = tips !== undefined ? (Number(tips) || 0) : parseFloat(current.tips || "0");
    const total = Math.round((subtotal + tipVal) * 100) / 100;

    // [zero-paid-ok 2026-08-18] A $0 invoice CAN be marked paid, deliberately.
    // An earlier revision of this file blocked it, on the reasoning that "paid"
    // is a claim money moved. That was wrong about how the business actually
    // runs, and it broke real work. A commercial account that bills the month
    // on one visit shows $0 on the others, and those documents get closed out
    // as settled. A comped clean nets to $0 against its own discount line and
    // is likewise settled, not owed. Invoices 7038 (Cucci zero week), 7402
    // (Baffoe, comped) and 7020 (Loe, credit) are all legitimately $0 and paid;
    // forcing them to be voided instead would erase the record that the visit
    // happened, which is the opposite of what the document is for.
    //
    // Nothing is protected by a rule at this point in the flow. The case it was
    // meant to catch — a job that carries a price whose invoice came out empty
    // anyway — is caught where the document is BUILT (lib/invoice-line-items.ts),
    // before a wrong $0 total can exist to be paid. Re-guarding it here only
    // blocks the legitimate zeros, and those are most of them.

    // [manual-edit-detach 2026-07-06] A hand-edit to the document's amounts
    // (line items or tip) detaches the invoice from job mirroring: mark-paid's
    // pre-payment recalc and the job-edit draft re-sync both skip invoices
    // with manually_edited_at set. Without this, the office edited an amount,
    // clicked Mark Paid, and watched it snap back to the job-derived figure
    // (Maribel: "as soon as we click paid, goes back to the old amount").
    // Date/terms/bill-to edits don't touch amounts, so they don't detach —
    // and a save that resends identical amounts doesn't either (the edit UI
    // sends line_items on every save, changed or not).
    const amountsEdited =
      (normLineItems ? JSON.stringify(normLineItems) !== JSON.stringify(normalizeInvoiceLineItems(current.line_items as any) ?? current.line_items) : false)
      || (tips !== undefined && tipVal !== parseFloat(current.tips || "0"));

    const [updated] = await db
      .update(invoicesTable)
      .set({
        ...(status && { status }),
        ...(keptLineItems && { line_items: keptLineItems }),
        ...(amountsEdited && { manually_edited_at: new Date() }),
        ...(dueProvided && { due_date: dueValue }),
        ...(createdProvided && { created_at: new Date(String(created_date) + "T12:00:00Z") }),
        ...(svcProvided && { service_date: svcValue }),
        ...(billToProvided && { bill_to_name: billToValue }),
        ...(termsProvided && { payment_terms: String(payment_terms) }),
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

    // [invoice-edit-mirror 2026-08-18] A discount typed onto the invoice is a
    // pricing decision about the visit, so record it against the visit. Until
    // now it lived only in this document's jsonb, which meant the next rebuild
    // — a job edit, a Recalc from Job — silently put the customer's price back
    // on and the comp was gone. Writing it to job_discounts is what lets the
    // "invoice mirrors the job" rule and "the comp survives" both be true.
    // Single-job invoices only: on a combined/account invoice a negative line
    // cannot be attributed to one visit, so there is nothing honest to write.
    // Never allowed to fail the save — the office's edit is already stored, and
    // an invoice must not be held hostage to bookkeeping behind it.
    if (amountsEdited && normLineItems && current.job_id) {
      try {
        const { mirrorInvoiceDiscountToJob } = await import("../lib/invoice-line-items.js");
        await mirrorInvoiceDiscountToJob({
          companyId: req.auth!.companyId as number,
          jobId: current.job_id,
          invoiceLineItems: normLineItems as any,
          userId: req.auth!.userId ?? null,
        });
      } catch (e) {
        console.error("[invoice-edit-mirror] non-fatal:", e);
      }
    }

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

// [invoice-send-truth 2026-07-07] Rebuilt around three lies Maribel hit ("I
// tried to send one to myself and nothing happened"):
//   1. The invoice was stamped status='sent' BEFORE the gated send fired, so
//      a suppressed email still read as sent. Now the stamp happens only when
//      a channel actually reached the provider.
//   2. The recipient came from invoice.client_id only — a pure ACCOUNT
//      invoice (client_id NULL) had nobody to send to and failed silently.
//      Now: invoice.billing_contact_email → client email → the account's
//      receives_invoices/billing contact.
//   3. Nothing visible recorded the outcome. Now every attempt writes a
//      communication_log row (client- or account-keyed, delivery_status
//      sent/suppressed) and the response tells the office exactly what
//      happened so the UI can say so.
// [invoice-pdf-attach 2026-07-14] Build the invoice PDF buffer for emailing
// (Maribel: "sending should generate a pdf file along with the email"). Mirrors
// the GET /:id/pdf render exactly — keep the two in sync. Returns null if the
// invoice isn't found; the caller treats a null / thrown result as "email
// without an attachment" so a PDF hiccup never blocks the send.
// [cadence 2026-07-22] Exported so the bundled-account close
// (lib/invoice-cadence.ts) attaches the SAME PDF a hand-sent invoice carries —
// one renderer, so the two can't drift.
export async function buildInvoicePdfBuffer(companyId: number, invoiceId: number): Promise<{ buffer: Buffer; filename: string } | null> {
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
  if (!inv) return null;

  const co = await db.execute(sql`SELECT name, logo_url, phone, email, address,
      invoice_business_name, invoice_tagline, invoice_address, invoice_footer_message,
      invoice_payment_instructions, invoice_guarantee, invoice_terms
    FROM companies WHERE id = ${companyId} LIMIT 1`);
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
  const items = (rawItems as any[]).map((it: any) => ({
    description: it.description ?? it.name ?? "Service",
    quantity: it.quantity ?? 1,
    unit_price: it.unit_price ?? it.unit_rate ?? it.total ?? 0,
    total: it.total ?? it.amount ?? 0,
    service_date: it.service_date ?? null,
  }));
  const billName = inv.bill_to_name || [inv.first_name, inv.last_name].filter(Boolean).join(" ") || inv.account_name || "Customer";
  const billAddr = [inv.address, [inv.city, inv.state].filter(Boolean).join(", "), inv.zip].filter(Boolean).join(", ");
  const bizName = company.invoice_business_name || company.name || "Invoice";
  const contactLine = [company.phone, company.email].filter(Boolean).join(" · ");
  const { renderInvoicePdf } = await import("../lib/invoice-pdf.js");
  const pdf = await renderInvoicePdf({
    companyName: bizName,
    logo,
    tagline: company.invoice_tagline || null,
    businessAddress: company.invoice_address || company.address || null,
    contactLine: contactLine || null,
    footerMessage: company.invoice_footer_message || `Thank you for choosing ${bizName}.`,
    paymentInstructions: company.invoice_payment_instructions
      || `Pay securely online using the link on this invoice.${contactLine ? ` Questions? Contact us at ${contactLine}.` : ""}`,
    guaranteeText: company.invoice_guarantee || null,
    termsText: company.invoice_terms || null,
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
  return { buffer: pdf, filename: `${inv.invoice_number || `invoice-${invoiceId}`}.pdf` };
}

// [invoice-email-lines 2026-08-05] Render an invoice's line items as an email-safe
// HTML table for the {{invoice_lines_html}} merge tag, so the emailed invoice
// SHOWS the work instead of only naming an amount. Table-based with inline
// styles and no flex/grid — Outlook renders nothing else reliably. Brand palette
// matches invoice-pdf.ts and invoice-detail.tsx, so the email, the PDF and the
// web invoice are one document in three places.
//
// Returns "" on any failure: the tag then merges to empty and the email still
// goes out with the summary card. A line-item render must never block a send.
const escHtml = (s: any) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function renderInvoiceLinesHtml(companyId: number, invoiceId: number): Promise<string> {
  try {
    const [inv] = await db
      .select({ line_items: invoicesTable.line_items, subtotal: invoicesTable.subtotal,
                tips: invoicesTable.tips, total: invoicesTable.total })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, companyId)))
      .limit(1);
    const items = Array.isArray(inv?.line_items) ? (inv!.line_items as any[]) : [];
    if (!items.length) return "";

    const money = (n: any) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const cap = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    // Service date as a pure calendar date — never `new Date("2026-08-05")`,
    // which parses as UTC midnight and prints the previous day west of GMT.
    const svcDate = (d: any) => {
      if (!d) return "";
      const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
      if (!y || !m || !day) return "";
      return new Date(y, m - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    };

    const rows = items.map((it) => {
      const when = svcDate(it.service_date);
      const desc = cap(String(it.description ?? it.name ?? "Service"));
      const qty  = Number(it.quantity ?? 1);
      const rate = it.unit_price ?? it.unit_rate ?? it.total ?? 0;
      const amt  = it.total ?? it.amount ?? 0;
      return `<tr>
<td style="padding:9px 0;border-bottom:1px solid #F0EEE9;font-size:14px;color:#1A1917">${escHtml(desc)}${
        when ? `<div style="font-size:12px;color:#9E9B94;margin-top:2px">${escHtml(when)}</div>` : ""
      }</td>
<td style="padding:9px 0;border-bottom:1px solid #F0EEE9;font-size:13px;color:#6B6860;text-align:right;white-space:nowrap">${escHtml(qty)}</td>
<td style="padding:9px 0 9px 14px;border-bottom:1px solid #F0EEE9;font-size:13px;color:#6B6860;text-align:right;white-space:nowrap">${escHtml(money(rate))}</td>
<td style="padding:9px 0 9px 14px;border-bottom:1px solid #F0EEE9;font-size:14px;color:#1A1917;font-weight:600;text-align:right;white-space:nowrap">${escHtml(money(amt))}</td>
</tr>`;
    }).join("");

    const tips = Number(inv?.tips || 0);
    const tipRow = tips > 0
      ? `<tr><td colspan="3" style="padding:8px 0;text-align:right;font-size:13px;color:#6B6860">Tips</td>
<td style="padding:8px 0 8px 14px;text-align:right;font-size:14px;color:#1A1917;font-weight:600;white-space:nowrap">${escHtml(money(tips))}</td></tr>`
      : "";

    return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;margin:0 0 24px">
<tr>
<th align="left" style="padding:0 0 7px;font-size:11px;font-weight:600;color:#9E9B94;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #E5E2DC">Description</th>
<th align="right" style="padding:0 0 7px;font-size:11px;font-weight:600;color:#9E9B94;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #E5E2DC">Qty</th>
<th align="right" style="padding:0 0 7px 14px;font-size:11px;font-weight:600;color:#9E9B94;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #E5E2DC">Rate</th>
<th align="right" style="padding:0 0 7px 14px;font-size:11px;font-weight:600;color:#9E9B94;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #E5E2DC">Amount</th>
</tr>
${rows}${tipRow}
<tr>
<td colspan="3" style="padding:12px 0 0;text-align:right;font-size:14px;font-weight:700;color:#1A1917;border-top:2px solid #1A1917">Total due</td>
<td style="padding:12px 0 0 14px;text-align:right;font-size:18px;font-weight:700;color:#1A1917;border-top:2px solid #1A1917;white-space:nowrap">${escHtml(money(inv?.total))}</td>
</tr>
</table>`;
  } catch (err) {
    console.error("[invoice-email-lines] render failed, sending without the table:", (err as any)?.message);
    return "";
  }
}

// [bulk-invoice-ops 2026-08-05] How many invoices one bulk request may touch.
// Guards the ZIP (no Zip64) and keeps a bulk email from becoming an unbounded
// loop against Resend. Well above a month of PPM invoices (~45 buildings).
const BULK_INVOICE_LIMIT = 200;

// Shared parse/validate for both bulk endpoints: a clean list of this company's
// invoice ids, or an error string.
function parseBulkIds(body: any): { ids: number[]; error?: string } {
  const raw = Array.isArray(body?.invoice_ids) ? body.invoice_ids : null;
  if (!raw) return { ids: [], error: "invoice_ids must be an array" };
  const ids: number[] = Array.from(new Set<number>(raw.map((n: any) => parseInt(String(n))).filter((n: number) => Number.isFinite(n))));
  if (!ids.length) return { ids: [], error: "Select at least one invoice" };
  if (ids.length > BULK_INVOICE_LIMIT) {
    return { ids: [], error: `Too many invoices — select ${BULK_INVOICE_LIMIT} or fewer (got ${ids.length})` };
  }
  return { ids };
}

// POST /api/invoices/bulk-pdf  Body: { invoice_ids: number[] }
// Returns a ZIP with one PDF per invoice — Maribel's "select invoices and
// download in bulk generating a zip file with all the invoices separately".
// Deliberately NOT one merged PDF: each invoice has to stay its own document so
// it can be filed and forwarded per building.
router.post("/bulk-pdf", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const { ids, error } = parseBulkIds(req.body);
    if (error) return res.status(400).json({ error: "Bad Request", message: error });

    // Scope to this company FIRST — a tenant must never zip another tenant's
    // invoices by guessing ids. Ordered by invoice number so the archive reads
    // in the same order as the list the office selected from.
    const owned = await db
      .select({ id: invoicesTable.id, invoice_number: invoicesTable.invoice_number })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.company_id, companyId), inArray(invoicesTable.id, ids)))
      .orderBy(invoicesTable.invoice_number, invoicesTable.id);
    if (!owned.length) return res.status(404).json({ error: "Not Found", message: "No matching invoices found" });

    // Render sequentially: pdfkit is CPU-bound and each render may fetch the
    // company logo over the network. 200 parallel renders would spike the
    // Railway dyno for no wall-clock win.
    const entries: { name: string; content: Buffer }[] = [];
    const failed: string[] = [];
    for (const row of owned) {
      const label = row.invoice_number || generateInvoiceNumber(row.id);
      try {
        const out = await buildInvoicePdfBuffer(companyId, row.id);
        if (out) entries.push({ name: out.filename, content: out.buffer });
        else failed.push(label);
      } catch (e) {
        console.error(`[bulk-pdf] invoice ${row.id} failed to render:`, (e as any)?.message);
        failed.push(label);
      }
    }
    if (!entries.length) {
      return res.status(500).json({ error: "Internal Server Error", message: "None of the selected invoices could be rendered" });
    }

    const { buildZip } = await import("../lib/zip.js");
    const zip = buildZip(entries);
    const stamp = new Date().toISOString().slice(0, 10);

    logAudit(req, "BULK_PDF_DOWNLOAD", "invoice", owned[0].id, null, {
      requested: ids.length, included: entries.length, failed: failed.length,
      invoice_ids: owned.map((o) => o.id),
    });

    // Any invoice that couldn't render is named in a response header rather than
    // silently dropped — a short zip must not read as a complete one.
    if (failed.length) res.setHeader("X-Invoice-Render-Failures", failed.join(","));
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Length", String(zip.length));
    res.setHeader("Content-Disposition", `attachment; filename="invoices-${stamp}.zip"`);
    return res.end(zip);
  } catch (err) {
    console.error("Bulk invoice PDF error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to build the invoice archive" });
  }
});

// POST /api/invoices/bulk-send  Body: { invoice_ids: number[] }
// Emails each selected invoice through the SAME path as the single send (PDF
// attached, line items in the body, comm-log trace, resend-safe status rules).
// Always 200 with a per-invoice verdict — a partial failure has to be readable
// per row, not collapsed into one error the office can't act on.
router.post("/bulk-send", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const { ids, error } = parseBulkIds(req.body);
    if (error) return res.status(400).json({ error: "Bad Request", message: error });

    const owned = await db
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.company_id, companyId), inArray(invoicesTable.id, ids)))
      .orderBy(invoicesTable.invoice_number, invoicesTable.id);
    if (!owned.length) return res.status(404).json({ error: "Not Found", message: "No matching invoices found" });

    // Sequential on purpose: each send mints a pay link, renders a PDF and hits
    // Resend. Firing 200 at once invites provider rate-limiting, and a partial
    // rate-limited batch is far harder for the office to reconcile than a
    // slightly slower one that reports cleanly.
    const results: any[] = [];
    for (const row of owned) {
      try {
        const out = await sendOneInvoice(companyId, row.id, req.auth!.userId ?? null);
        results.push(out.ok
          ? { invoice_id: row.id, invoice_number: out.invoice_number, sent: true, recipient: out.recipient }
          : { invoice_id: row.id, invoice_number: out.invoice_number ?? generateInvoiceNumber(row.id), sent: false, message: out.message, reason: out.reason ?? null });
      } catch (e) {
        console.error(`[bulk-send] invoice ${row.id} threw:`, (e as any)?.message);
        results.push({ invoice_id: row.id, invoice_number: generateInvoiceNumber(row.id), sent: false, message: "Failed to send invoice" });
      }
    }

    const sent = results.filter((r) => r.sent).length;
    logAudit(req, "UPDATE", "invoice", owned[0].id, null, {
      action: "bulk_send", requested: ids.length, sent, failed: results.length - sent,
    });
    return res.json({ requested: ids.length, sent, failed: results.length - sent, results });
  } catch (err) {
    console.error("Bulk invoice send error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to send the selected invoices" });
  }
});

// [bulk-invoice-ops 2026-08-05] The single-invoice send, extracted verbatim so
// the BULK sender runs this exact path — recipient chain, pay link, PDF
// attachment, comm-log trace, resend status rules, QB push. "Email these 30
// invoices" must never become a second, subtly-different implementation of
// "email this invoice"; five parallel implementations of "combine invoices" is
// what produced the KMA mess (docs/BATCH_INVOICING_DESIGN.md §5 S-2).
type SendInvoiceResult =
  | { ok: true; invoice: any; recipient: string; invoice_number: string }
  | { ok: false; status: number; message: string; reason?: string | null; invoice_number?: string };

async function sendOneInvoice(
  companyId: number,
  invoiceId: number,
  actorUserId: number | null,
): Promise<SendInvoiceResult> {
    const [invoice] = await db
      .select({ id: invoicesTable.id, client_id: invoicesTable.client_id, account_id: invoicesTable.account_id,
                job_id: invoicesTable.job_id, total: invoicesTable.total,
                invoice_number: invoicesTable.invoice_number, due_date: invoicesTable.due_date,
                billing_contact_name: invoicesTable.billing_contact_name,
                billing_contact_email: invoicesTable.billing_contact_email,
                status: invoicesTable.status })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, companyId)))
      .limit(1);

    if (!invoice) return { ok: false, status: 404, message: "Invoice not found" };

    const [client] = invoice.client_id ? await db
      .select({ first_name: clientsTable.first_name, last_name: clientsTable.last_name,
                email: clientsTable.email, phone: clientsTable.phone,
                address: clientsTable.address, city: clientsTable.city,
                // [invoice-email-address 2026-08-09] state + zip so {{service_address}}
                // renders the canonical "street, city, ST zip" — the old two-field
                // concat dropped both, and the designed template now SHOWS this field.
                state: clientsTable.state, zip: clientsTable.zip })
      .from(clientsTable)
      .where(eq(clientsTable.id, invoice.client_id))
      .limit(1) : [];

    // Recipient chain: invoice-level override → client → account contact.
    // Shared with POST /:id/remind — see resolveInvoiceRecipient.
    const { email: recipientEmail, name: recipientName } =
      await resolveInvoiceRecipient(companyId, invoice, client);

    const invNum  = invoice.invoice_number || generateInvoiceNumber(invoiceId);

    if (!recipientEmail && !client?.phone) {
      return {
        ok: false,
        status: 400,
        invoice_number: invNum,
        message: invoice.account_id
          ? "No billing email on file — add an account contact with an email (mark it 'receives invoices') and try again."
          : "This client has no email or phone on file — add one and try again.",
      };
    }

    // Mint a Stripe pay-token so the email's "View and Pay" button charges the
    // invoice total on the public /pay/:token page.
    const invLink = await mintInvoicePayLink(companyId, invoice.client_id, invoiceId, invoice.total, actorUserId ?? undefined);
    // [invoice-email-lines 2026-08-05] The emailed invoice now shows the actual
    // WORK — one row per visit with its service date, qty, rate and amount —
    // not just a number and an amount due (Maribel: "the email should display
    // the invoice but also generate a pdf file"). An account contact approving
    // a $2,400 month needs to see the visits inside the email, without opening
    // an attachment. Rendered here and injected as {{invoice_lines_html}};
    // templates that don't reference the tag are unaffected.
    const linesHtml = await renderInvoiceLinesHtml(companyId, invoiceId);

    // [invoice-email-address 2026-08-09] The template's Address row was fed by
    // `[client.address, client.city].join(", ")`, which dropped state and zip
    // (CLAUDE.md: if an address is shown, zip MUST be shown) and resolved to ""
    // for an ACCOUNT invoice, where client_id is null — a third of all invoices.
    // That stayed invisible only because the legacy plaintext template never
    // rendered {{service_address}}; the designed template does. Canonical format
    // here, with a fallback to the account's property when it is unambiguous.
    // A multi-property account keeps it blank on purpose: one address line would
    // misrepresent an invoice spanning several buildings, and the line-item table
    // already names the site for every visit.
    const fmtAddr = (street?: string | null, city?: string | null, state?: string | null, zip?: string | null): string => {
      const head = [street, city].map((p) => (p || "").trim()).filter(Boolean).join(", ");
      const tail = [state, zip].map((p) => (p || "").trim()).filter(Boolean).join(" ");
      return [head, tail].filter(Boolean).join(", ");
    };
    let serviceAddress = fmtAddr(client?.address, client?.city, client?.state, client?.zip);
    if (!serviceAddress && invoice.account_id) {
      const props = await db.execute(sql`
        SELECT address, city, state, zip FROM account_properties
         WHERE account_id = ${invoice.account_id} AND company_id = ${companyId} AND is_active = true
         LIMIT 2`);
      if (props.rows.length === 1) {
        const p = props.rows[0] as any;
        serviceAddress = fmtAddr(p.address, p.city, p.state, p.zip);
      }
    }

    const mergeVars = {
      first_name:       recipientName || "",
      invoice_number:   invNum,
      invoice_amount:   parseFloat(invoice.total || "0").toFixed(2),
      invoice_due_date: invoice.due_date ? new Date(invoice.due_date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "upon receipt",
      invoice_link:     invLink,
      service_address:  serviceAddress,
      invoice_lines_html: linesHtml,
    };
    // [invoice-pdf-attach 2026-07-14] Attach the invoice PDF to the email so the
    // customer gets a real file, not just the info in the body (Maribel).
    // Best-effort — a PDF render failure still sends the email, just without it.
    const pdfOut = recipientEmail ? await buildInvoicePdfBuffer(companyId as number, invoiceId).catch(() => null) : null;
    const emailSent = recipientEmail
      ? await sendNotification("invoice_sent", "email", companyId, recipientEmail, null, mergeVars, false, undefined, null,
          pdfOut ? [{ filename: pdfOut.filename, content: pdfOut.buffer }] : undefined).catch(() => false)
      : false;
    const smsSent = client?.phone
      ? await sendNotification("invoice_sent", "sms", companyId, null, client.phone, mergeVars).catch(() => false)
      : false;
    const delivered = emailSent || smsSent;

    // Why didn't it go out? sendNotification just wrote the reason to
    // notification_log — read the freshest row back so the office sees
    // "suppressed — company_comms_disabled" instead of silence.
    let failReason: string | null = null;
    if (!delivered) {
      try {
        const nl = await db.execute(sql`
          SELECT status, error_message FROM notification_log
          WHERE company_id = ${companyId} AND trigger = 'invoice_sent'
          ORDER BY id DESC LIMIT 1`);
        const row = nl.rows[0] as any;
        if (row) failReason = row.error_message || row.status || null;
      } catch { /* reason stays null */ }
    }

    // [invoice-log-building 2026-07-14] For an ACCOUNT invoice, resolve WHICH
    // building/property it was for (via the invoice's job → account_property,
    // falling back to the job's own street) so the account's Communication Log
    // ties the send to that address (Maribel: an account has many buildings —
    // the log must say which one). Best-effort; null for merged/no-job invoices.
    let buildingLabel: string | null = null;
    if (invoice.account_id && invoice.job_id) {
      try {
        const br = await db.execute(sql`
          SELECT COALESCE(NULLIF(btrim(ap.property_name), ''), NULLIF(btrim(ap.address), ''), NULLIF(btrim(j.address_street), '')) AS label
            FROM jobs j
            LEFT JOIN account_properties ap ON ap.id = j.account_property_id
           WHERE j.id = ${invoice.job_id} AND j.company_id = ${companyId}
           LIMIT 1`);
        buildingLabel = ((br.rows[0] as any)?.label as string | null) || null;
      } catch { /* label stays null */ }
    }
    const bldg = buildingLabel ? ` · ${buildingLabel}` : "";

    // Trace row for the client/account communications + activity feeds —
    // written for suppressed attempts too, so "did the invoice go out?" has
    // a visible answer either way. Account entries carry the building address.
    try {
      await db.execute(sql`
        INSERT INTO communication_log (company_id, customer_id, account_id, job_id, direction, channel, summary, subject, recipient, delivery_status, source, logged_by)
        VALUES (${companyId}, ${invoice.client_id ?? null}, ${invoice.account_id ?? null}, ${invoice.job_id ?? null}, 'outbound', 'email',
                ${delivered ? `Invoice ${invNum} emailed${bldg}` : `Invoice ${invNum} email NOT sent${bldg}${failReason ? ` — ${failReason}` : ""}`},
                ${`Invoice ${invNum}${bldg}`}, ${recipientEmail ?? client?.phone ?? "unknown"},
                ${delivered ? "sent" : "suppressed"}, 'system', ${actorUserId})`);
    } catch (e) { console.error("[invoice-send] comm-log trace non-fatal:", (e as any)?.message); }

    if (!delivered) {
      const human =
        failReason === "company_comms_disabled" ? "communications are turned OFF for this company — the email was suppressed, not sent" :
        failReason === "COMMS_ENABLED=false" ? "communications are globally disabled — the email was suppressed, not sent" :
        failReason ? failReason.replace(/_/g, " ") : "the message could not be delivered";
      return { ok: false, status: 422, message: `Invoice was NOT sent: ${human}.`, reason: failReason, invoice_number: invNum };
    }

    // [invoice-resend 2026-07-14] Sending records sent_at, but must NOT downgrade
    // a settled invoice — re-emailing a PAID (or void/refunded/partial) invoice
    // keeps that status (Maribel: "email invoices before AND after marked paid").
    // Only a not-yet-sent (draft) invoice flips to 'sent'.
    const keepStatus = ["paid", "void", "refunded", "partial"].includes(invoice.status || "");
    const [updated] = await db
      .update(invoicesTable)
      .set({ ...(keepStatus ? {} : { status: "sent" }), sent_at: new Date() })
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, companyId)))
      .returning();

    // [no-auto-issue 2026-07-06] Completion invoices no longer push to QB at
    // creation (they start as drafts), so finalizing here must push. One-way,
    // fire-and-forget, no-op when QB isn't connected.
    queueSync(() => syncInvoice(companyId, invoiceId));

    return {
      ok: true,
      invoice_number: invNum,
      recipient: recipientEmail ?? client?.phone ?? "unknown",
      invoice: formatInvoice({
        ...updated,
        client_name: `${client?.first_name || ""} ${client?.last_name || ""}`.trim() || recipientName || "",
        client_email: recipientEmail,
      }),
    };
}

router.post("/:id/send", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const out = await sendOneInvoice(req.auth!.companyId as number, parseInt(req.params.id), req.auth!.userId ?? null);
    if (!out.ok) {
      const error = out.status === 404 ? "Not Found" : out.status === 400 ? "Bad Request" : "Not Sent";
      return res.status(out.status).json({ error, message: out.message, ...(out.reason !== undefined ? { reason: out.reason } : {}) });
    }
    return res.json(out.invoice);
  } catch (err) {
    console.error("Send invoice error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to send invoice" });
  }
});

// [invoice-reminder 2026-08-09] Maribel: "Sending the reminder doesn't work" —
// invoice #7329 answered "Reminder was NOT sent: No recipient email." Three
// separate defects, all in this one handler:
//
//  1. It resolved the recipient from clients.email alone, so every ACCOUNT
//     invoice (386 of 1,211 — client_id is null on all of them) was
//     unreachable. Now shares resolveInvoiceRecipient with POST /:id/send.
//  2. It hand-rolled the email: raw Resend, `from: "notifications@phes.io"`
//     hardcoded, and a literal "Thank you, Phes" signature — so it ignored the
//     tenant's send-from address and signed every Schaumburg (co4) reminder as
//     Oak Lawn, with none of the branded shell, logo or accent every other
//     customer email now carries. It goes through sendNotification and an
//     invoice_reminder template like everything else, which also means the
//     office can edit the copy in Settings instead of asking for a deploy.
//  3. It minted a pay link unconditionally. mintInvoicePayLink falls back to
//     /pay/<invoice_id> when there's no client, and that URL is resolved as a
//     payment_links TOKEN — so an account invoice's "Pay Now" was a guaranteed
//     404 (INVALID_LINK). Same reason the account invoice email omits the
//     button: payment_links.client_id is NOT NULL. No link, no button.
//
// The old body also dunned settled invoices — nothing stopped a reminder going
// out on a paid or voided one. #7329 is void today.
router.post("/:id/remind", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);
    const companyId = req.auth!.companyId!;

    const [invoice] = await db
      .select({
        id: invoicesTable.id,
        client_id: invoicesTable.client_id,
        account_id: invoicesTable.account_id,
        job_id: invoicesTable.job_id,
        invoice_number: invoicesTable.invoice_number,
        total: invoicesTable.total,
        due_date: invoicesTable.due_date,
        status: invoicesTable.status,
        billing_contact_name: invoicesTable.billing_contact_name,
        billing_contact_email: invoicesTable.billing_contact_email,
      })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, companyId)))
      .limit(1);

    if (!invoice) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });

    const invNum = invoice.invoice_number || generateInvoiceNumber(invoiceId);

    // Never chase money on a settled invoice. A reminder is a dunning notice;
    // sending one for an invoice that is paid, voided or refunded is a real
    // customer-facing error, not a harmless no-op.
    const settled: Record<string, string> = { paid: "already paid", void: "voided", refunded: "refunded" };
    const settledLabel = settled[String(invoice.status || "")];
    if (settledLabel) {
      return res.status(422).json({
        error: "Not Sent",
        message: `Invoice ${invNum} is ${settledLabel} — no reminder was sent.`,
        reason: `invoice_${invoice.status}`,
      });
    }

    const [client] = invoice.client_id ? await db
      .select({ first_name: clientsTable.first_name, last_name: clientsTable.last_name,
                email: clientsTable.email, phone: clientsTable.phone })
      .from(clientsTable)
      .where(eq(clientsTable.id, invoice.client_id))
      .limit(1) : [];

    const { email: recipientEmail, name: recipientName } =
      await resolveInvoiceRecipient(companyId, invoice, client);

    if (!recipientEmail) {
      return res.status(400).json({
        error: "No Recipient",
        message: invoice.account_id
          ? "No billing email on file — add an account contact with an email (mark it 'receives invoices') and try again."
          : "This client has no email on file — add one and try again.",
        reason: "no_recipient_email",
      });
    }

    // Only a client invoice can carry a working pay button (see the note above).
    const payLink = invoice.client_id
      ? await mintInvoicePayLink(companyId, invoice.client_id, invoiceId, invoice.total, req.auth!.userId)
      : null;

    const overdueDays = daysOverdue(invoice.due_date as any);
    const mergeVars: Record<string, string> = {
      first_name:       recipientName || "",
      invoice_number:   invNum,
      invoice_amount:   parseFloat(invoice.total || "0").toFixed(2),
      invoice_due_date: invoice.due_date
        ? new Date(invoice.due_date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
        : "upon receipt",
      // "past due by 3 days" vs "due soon" — the template picks the wording, but
      // the number has to come from the same daysOverdue() the invoice list uses
      // so the email can't disagree with the OVERDUE badge on screen.
      days_overdue:     String(overdueDays),
      invoice_link:     payLink || "",
      // Explicit empty string, not undefined: sendNotification builds the button
      // from invoice_link only when the caller hasn't supplied the block itself.
      ...(payLink ? {} : { invoice_cta_html: "" }),
    };

    const reminderSent = await sendNotification(
      "invoice_reminder", "email", companyId, recipientEmail, null, mergeVars,
    ).catch(() => false);

    // sendNotification already wrote the notification_log row (including the
    // suppression reason). Read the freshest one back so the office sees
    // "company_comms_disabled" rather than a silent failure.
    let failReason: string | null = null;
    if (!reminderSent) {
      try {
        const nl = await db.execute(sql`
          SELECT status, error_message FROM notification_log
          WHERE company_id = ${companyId} AND trigger = 'invoice_reminder'
          ORDER BY id DESC LIMIT 1`);
        const row = nl.rows[0] as any;
        if (row) failReason = row.error_message || row.status || null;
      } catch { /* reason stays null */ }
    }

    // Trace row for the client/account communication log — written for
    // suppressed attempts too, same as the invoice send, so "did we chase this
    // one?" has a visible answer either way.
    try {
      await db.execute(sql`
        INSERT INTO communication_log (company_id, customer_id, account_id, job_id, direction, channel, summary, subject, recipient, delivery_status, source, logged_by)
        VALUES (${companyId}, ${invoice.client_id ?? null}, ${invoice.account_id ?? null}, ${invoice.job_id ?? null}, 'outbound', 'email',
                ${reminderSent ? `Payment reminder sent for invoice ${invNum}` : `Payment reminder NOT sent for invoice ${invNum}${failReason ? ` — ${failReason}` : ""}`},
                ${`Reminder: Invoice ${invNum}`}, ${recipientEmail},
                ${reminderSent ? "sent" : "suppressed"}, 'system', ${req.auth!.userId ?? null})`);
    } catch (e) { console.error("[invoice-remind] comm-log trace non-fatal:", (e as any)?.message); }

    if (!reminderSent) {
      const human =
        failReason === "company_comms_disabled" ? "communications are turned OFF for this company — the email was suppressed, not sent" :
        failReason === "email_opt_out" ? "this recipient unsubscribed from emails" :
        failReason === "Template not found or inactive" ? "no invoice reminder template is set up for this company" :
        failReason ? failReason.replace(/_/g, " ") : "the message could not be delivered";
      return res.status(422).json({ error: "Not Sent", message: `Reminder was NOT sent: ${human}.`, reason: failReason });
    }

    await db.update(invoicesTable)
      .set({ last_reminder_sent_at: new Date() })
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, companyId)));

    return res.json({ ok: true, sent_to: recipientEmail });
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
    // [manual-edit-detach 2026-07-06] Also skipped when the office hand-edited
    // the invoice (manually_edited_at set) — recording payment must bank the
    // amount the office deliberately set, not clobber it back to the
    // job-derived figure. Explicit "Recalc from job" re-attaches.
    const [pre] = await db
      .select({ job_id: invoicesTable.job_id, status: invoicesTable.status, tips: invoicesTable.tips, manually_edited_at: invoicesTable.manually_edited_at, total: invoicesTable.total })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId as number)))
      .limit(1);
    const preJobId: number | null = pre?.job_id ?? null;
    if (preJobId != null && !pre?.manually_edited_at && !["paid", "void", "superseded", "batched"].includes((pre?.status ?? "") as string)) {
      try {
        // [rebuild-context 2026-08-18] Pass the total already on the document.
        // This recalc is automatic and it fires at the exact moment money is
        // recorded, so it is the last place a silent re-price should be allowed
        // to happen: a $0 comped visit being closed out must bank $0, not the
        // job's underlying price. See lib/invoice-line-items.ts.
        const built = await buildJobLineItems(req.auth!.companyId as number, preJobId, db, {
          existingTotal: pre.total == null ? null : parseFloat(String(pre.total)),
        });
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

    // [zero-paid-ok 2026-08-18] Same correction as the PATCH endpoint above: a
    // $0 invoice may be settled, and closing out a zero week or a comped visit
    // is ordinary office work. The $0 payment rows already on file (161, 444,
    // 454) are the record of exactly that.

    await db.insert(paymentsTable).values({
      company_id: req.auth!.companyId,
      client_id: invoice.client_id,
      invoice_id: invoiceId,
      amount: payAmount.toString(),
      method,
      status: "completed",
      processed_by: req.auth!.userId,
    });

    const paidAt = payDate ? new Date(payDate) : new Date();
    const [updated] = await db
      .update(invoicesTable)
      .set({ status: "paid", paid_at: paidAt })
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .returning();

    // [batch-invoicing 2026-08-03] If this is a combined invoice, stamp its
    // members paid too. They stay 'batched' (so they never re-enter A/R), but
    // per-visit revenue reporting needs to know the money landed.
    await cascadeBatchPayment(db as any, req.auth!.companyId as number, invoiceId, paidAt);

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

    // Reverse the batch cascade too, or members keep a paid_at their parent no
    // longer has.
    await cascadeBatchPayment(db as any, req.auth!.companyId as number, invoiceId, null);

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
    // [batch-invoicing 2026-08-03] Voiding a member would leave the parent
    // billing for work that no longer has a document behind it. Split first.
    if (invoice.status === "batched") return res.status(409).json({ error: "Conflict", message: "This visit is part of a combined invoice — split the batch before voiding it" });
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
    if (["paid", "void", "superseded", "batched"].includes(inv.status)) {
      return res.status(409).json({
        error: "Conflict",
        message: inv.status === "batched"
          ? "This visit is part of a combined invoice — recalculate the combined invoice, or split it first"
          : `A ${inv.status} invoice cannot be recalculated`,
      });
    }
    if (!inv.job_id) {
      return res.status(400).json({ error: "Bad Request", message: "This invoice is not linked to a job — edit its line items directly" });
    }

    // Refresh the job's billed_amount BEFORE rebuilding lines — recalc is the
    // office's repair action, so it must pull CURRENT job pricing, not the
    // stale stamp the invoice was originally built from (invoice #6387 kept
    // reproducing a $150 total because billed_amount never re-folded a later
    // fee adjustment).
    try {
      const { recomputeJobBilledAmount } = await import("./jobs.js");
      await recomputeJobBilledAmount(inv.job_id, req.auth!.companyId!);
    } catch (e) { console.error("[invoice-recalc] billed_amount refresh non-fatal:", e); }

    // [rebuild-context 2026-08-18] Deliberately does NOT pass existingTotal,
    // unlike the job-edit sync and the mark-paid recalc. Those two fire on their
    // own, so if they re-priced a $0 comp back up to the job's figure nobody
    // would see it happen. This one is a button the office pressed, on a screen
    // showing the result, meaning "make this invoice match the job" — and it is
    // the repair action for the Walter Nunchuck shape, a real price that printed
    // as $0. Suppressing recovery here would take that repair away. Paid
    // invoices are already refused above, so the legitimate $0 documents on file
    // cannot be reached by this path at all.
    const built = await buildJobLineItems(req.auth!.companyId, inv.job_id);
    if (!built) return res.status(404).json({ error: "Not Found", message: "Linked job not found" });

    const tipVal = parseFloat(inv.tips || "0");
    const total = Math.round((built.subtotal + tipVal) * 100) / 100;

    // [manual-edit-detach 2026-07-06] An explicit recalc-from-job deliberately
    // re-attaches the invoice to its job — clear the manual-edit detach flag so
    // mirroring (job-edit re-sync, mark-paid recalc) resumes.
    const [updated] = await db
      .update(invoicesTable)
      .set({ line_items: built.lineItems, subtotal: built.subtotal.toFixed(2), total: total.toFixed(2), manually_edited_at: null })
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

    // [batch-invoicing 2026-08-03] The fold lives in ONE place now (design S-2).
    // This route had its own copy — as did the cadence cron, batch-invoicing.ts,
    // bill-week, and the account generate button. Five implementations of
    // "combine invoices", each with its own idempotency rule, none aware of the
    // others. That is why this broke every month, and it is why the fix was
    // consolidation rather than repair.
    //
    // The behaviour change the office will notice: the merged invoices no longer
    // go 'superseded' with their totals zeroed and vanish from the list. They
    // stay, at their real amounts, marked 'batched' and linked to the parent.
    const combined = await combineInvoices({
      companyId, memberInvoiceIds: ids, actorUserId: req.auth!.userId,
    });
    const [parent] = await db.select().from(invoicesTable)
      .where(and(eq(invoicesTable.company_id, companyId), eq(invoicesTable.id, combined.parent_id)));

    logAudit(req, "MERGE", "invoice", combined.parent_id, null,
      { merged_invoice_ids: ids, count: ids.length, total: combined.total });

    // [D-9] No QuickBooks push. QB is disconnected until exactly-one-document-
    // per-dollar is verified in production; the old `queueSync` here is what
    // put duplicate invoices in the books in the first place.

    return res.status(201).json({ ok: true, invoice: parent, merged_count: ids.length, total: parseFloat(combined.total) });
  } catch (err: any) {
    // combineInvoices rejects with a message the office can act on ("job 4344 is
    // already on invoice 933 — void the duplicate first"). Surface it as a 409
    // rather than burying it in a generic 500; a refused merge that explains
    // itself is the whole point of moving the guard into the engine.
    console.error("Invoice merge error:", err);
    const msg = err?.message || "Failed to merge invoices";
    const conflict = /already|combine|same customer|at least two/i.test(msg);
    return res.status(conflict ? 409 : 500).json({ error: conflict ? "Conflict" : "Internal Server Error", message: msg });
  }
});

// [batch-invoicing 2026-08-03] POST /api/invoices/:id/split — undo a combine.
//
// Every guard that refuses to edit, void, or recalc a 'batched' member tells the
// office to "split the batch first", so the undo has to actually exist. It
// returns each member to 'sent' at its own number and its own total, moves the
// billing coverage back down to the members, and voids the now-empty parent.
//
// Refused on a PAID parent: money has moved against that document, so unwinding
// it silently would leave a payment pointing at a voided invoice. Unmark it paid
// (or refund) first — the same rule every other terminal transition follows.
router.post("/:id/split", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const invoiceId = parseInt(req.params.id);
    if (isNaN(invoiceId)) return res.status(400).json({ error: "Bad Request", message: "Invalid invoice id" });

    const result = await splitBatchInvoice(companyId, invoiceId);

    logAudit(req, "UPDATE", "invoice", invoiceId, { batch_status: "batch_parent" },
      { action: "split", member_ids: result.member_ids, count: result.member_ids.length });

    return res.json({ ok: true, split_count: result.member_ids.length, member_invoice_ids: result.member_ids });
  } catch (err: any) {
    console.error("Invoice split error:", err);
    const msg = err?.message || "Failed to split invoice";
    const conflict = /paid|no combined members/i.test(msg);
    const missing = /not found/i.test(msg);
    return res.status(missing ? 404 : conflict ? 409 : 500).json({
      error: missing ? "Not Found" : conflict ? "Conflict" : "Internal Server Error",
      message: msg,
    });
  }
});

// [auto-issue-hold 2026-07-22] Hold / release a single job's invoice.
//
// The office's manual escape hatch on automatic invoicing, for the case that
// isn't "never bill this" (non_billable) and isn't "turn the whole account off"
// (accounts.auto_issue_enabled): THIS visit is billable but shouldn't go out yet
// — a complaint is open, a rate is unsettled, the scope is being argued.
//
// A held job produces no invoice on completion and stays in the "not yet
// invoiced" queue, which is the point: it must remain visible, not vanish.
// Releasing the hold does NOT invoice it — the office invoices it when ready, or
// the next completion write does. Holding a job that ALREADY has an invoice is
// rejected: at that point the tools are edit and void, not hold.
router.post("/job/:jobId/hold", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const jobId = parseInt(req.params.jobId);
    const companyId = req.auth!.companyId!;
    if (!Number.isFinite(jobId)) return res.status(400).json({ error: "Invalid job id" });
    const hold = req.body?.hold !== false; // default true; pass {hold:false} to release

    const [job] = await db
      .select({ id: jobsTable.id, invoice_hold: jobsTable.invoice_hold, status: jobsTable.status })
      .from(jobsTable)
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)))
      .limit(1);
    if (!job) return res.status(404).json({ error: "Job not found" });

    if (hold) {
      const [live] = await db
        .select({ id: invoicesTable.id, invoice_number: invoicesTable.invoice_number })
        .from(invoicesTable)
        .where(and(
          eq(invoicesTable.job_id, jobId),
          eq(invoicesTable.company_id, companyId),
          ne(invoicesTable.status, "void"),
        ))
        .limit(1);
      if (live) {
        return res.status(409).json({
          error: "Already invoiced",
          message: `Job #${jobId} already has invoice #${live.invoice_number ?? live.id}. Edit or void it instead of holding the job.`,
          invoice_id: live.id,
        });
      }
    }

    await db.update(jobsTable)
      .set({ invoice_hold: hold })
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)));
    logAudit(req, "UPDATE", "job", jobId, { invoice_hold: job.invoice_hold }, { invoice_hold: hold });

    return res.json({ ok: true, job_id: jobId, invoice_hold: hold });
  } catch (err) {
    console.error("Invoice hold error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to set invoice hold" });
  }
});

export default router;
