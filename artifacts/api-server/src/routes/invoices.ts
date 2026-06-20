import { Router } from "express";
import { db } from "@workspace/db";
import { invoicesTable, clientsTable, jobsTable, paymentsTable, notificationLogTable, usersTable } from "@workspace/db/schema";
import { eq, and, desc, count, sum, sql, lt, isNull, or, ne, inArray } from "drizzle-orm";
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
    status: overdue ? "overdue" : inv.status,
    days_overdue: daysOverdue(inv.due_date),
    invoice_number: inv.invoice_number || generateInvoiceNumber(inv.id),
  };
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
    if (branch_id && branch_id !== "all") conditions.push(eq(invoicesTable.branch_id, parseInt(branch_id as string)));

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
        OR concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name}) ILIKE ${like}${idMatch}
      )`);
    }

    const invoices = await db
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
        service_date: sql<string | null>`(SELECT j.scheduled_date FROM jobs j WHERE j.id = ${invoicesTable.job_id})`,
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

    if (job_id && (!client_id || !rawLineItems)) {
      const [job] = await db
        .select({
          id: jobsTable.id,
          client_id: jobsTable.client_id,
          service_type: jobsTable.service_type,
          base_fee: jobsTable.base_fee,
        })
        .from(jobsTable)
        .where(and(eq(jobsTable.id, job_id), eq(jobsTable.company_id, req.auth!.companyId)))
        .limit(1);

      if (!job) return res.status(404).json({ error: "Not Found", message: "Job not found" });
      jobRecord = job;
      finalClientId = job.client_id;
      finalLineItems = [{
        description: (job.service_type || "").replace(/_/g, " "),
        quantity: 1,
        rate: parseFloat(job.base_fee || "0"),
        total: parseFloat(job.base_fee || "0"),
      }];
    }

    if (!finalClientId) return res.status(400).json({ error: "Bad Request", message: "client_id required" });

    const subtotal = (finalLineItems || []).reduce((s: number, item: any) => s + (item.total || 0), 0);
    const total = subtotal + (tips || 0);

    // Look up client to inherit payment terms, billing contact
    const [clientRecord] = await db
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

    const effectiveTerms = reqPaymentTerms || clientRecord?.payment_terms || "due_on_receipt";
    const daysToAdd = effectiveTerms === "net_30" ? 30 : effectiveTerms === "net_15" ? 15 : 0;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + daysToAdd);
    const dueDateStr = dueDate.toISOString().split("T")[0];

    const [newInvoice] = await db
      .insert(invoicesTable)
      .values({
        company_id: req.auth!.companyId,
        client_id: finalClientId,
        job_id: job_id || null,
        line_items: finalLineItems || [],
        subtotal: subtotal.toString(),
        tips: (tips || 0).toString(),
        total: total.toString(),
        due_date: dueDateStr,
        status: auto_send ? "sent" : "draft",
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
      client_name: `${client?.first_name || ""} ${client?.last_name || ""}`.trim(),
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
        // [invoice-service-date 2026-06-20] Live service date from the linked job
        // (see list select). Reschedule-proof; null when job gone/unlinked.
        service_date: sql<string | null>`(SELECT j.scheduled_date FROM jobs j WHERE j.id = ${invoicesTable.job_id})`,
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

router.put("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);
    const { status, line_items, tips } = req.body;

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
    // TODO(invoice-pay-token): the public /pay route resolves a payment_links
    // token, not a bare invoice id. Wiring invoice-send to mint a payment_links
    // row (Stripe setup-intent) is a separate task; for now this is on the
    // correct domain (no more Replit) but still id-based.
    const invLink = `${appBaseUrl()}/pay/${invoiceId}`;
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
      if (process.env.COMMS_ENABLED !== "true") {
        console.log("[COMMS BLOCKED] Invoice reminder email suppressed:", { to: clientEmail, invoiceId });
      } else {
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      const payLink = `${appBaseUrl()}/pay/${invoiceId}`;
      await resend.emails.send({
        from: "notifications@phes.io",
        to: clientEmail,
        subject: `Friendly reminder — Invoice ${invNum} is due`,
        html: `<p>Hi ${client?.first_name || "there"},</p>
               <p>This is a friendly reminder that invoice <strong>${invNum}</strong> for <strong>$${parseFloat(invoice.total || "0").toFixed(2)}</strong> is due.</p>
               <p><a href="${payLink}">Pay Now</a></p>
               <p>Thank you,<br>Phes</p>`,
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

export default router;
