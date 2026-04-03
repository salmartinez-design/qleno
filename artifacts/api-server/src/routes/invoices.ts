import { Router } from "express";
import { db } from "@workspace/db";
import { invoicesTable, clientsTable, jobsTable, paymentsTable, notificationLogTable, usersTable, companiesTable } from "@workspace/db/schema";
import { eq, and, desc, count, sum, sql, lt, isNull, or, ne, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { syncInvoice, syncPayment, queueSync } from "../services/quickbooks-sync.js";
import { sendNotification } from "../services/notificationService.js";

const router = Router();

function generateInvoiceNumber(id: number): string {
  const year = new Date().getFullYear();
  return `INV-${year}-${String(id).padStart(4, "0")}`;
}

async function getNextInvoiceNumber(companyId: number, fallbackId: number): Promise<string> {
  try {
    const [company] = await db
      .select({ invoice_sequence_start: companiesTable.invoice_sequence_start })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .limit(1);

    const seqStart = company?.invoice_sequence_start ?? 1;

    // Get max numeric invoice number for this company
    const [maxRow] = await db.execute(
      sql`SELECT COALESCE(MAX(CAST(invoice_number AS INTEGER)), 0) as max_num
          FROM invoices
          WHERE company_id = ${companyId}
          AND invoice_number ~ '^[0-9]+$'`
    );
    const maxNum = parseInt((maxRow as any)?.max_num ?? "0") || 0;
    const next = Math.max(maxNum + 1, seqStart);
    return String(next);
  } catch {
    return generateInvoiceNumber(fallbackId);
  }
}

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
    const { status, client_id, date_from, date_to, page = "1", limit = "50", branch_id } = req.query;
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

router.put("/:id", requireAuth, async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);
    const { status, line_items, tips } = req.body;

    let subtotal: number | undefined;
    let total: number | undefined;

    if (line_items) {
      subtotal = line_items.reduce((s: number, item: any) => s + (item.total || 0), 0);
      total = subtotal + (tips || 0);
    }

    const [updated] = await db
      .update(invoicesTable)
      .set({
        ...(status && { status }),
        ...(line_items && { line_items }),
        ...(tips !== undefined && { tips: tips.toString() }),
        ...(subtotal !== undefined && { subtotal: subtotal.toString() }),
        ...(total !== undefined && { total: total.toString() }),
        ...(status === "sent" && { sent_at: new Date() }),
        ...(status === "paid" && { paid_at: new Date() }),
      })
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, req.auth!.companyId)))
      .returning();

    if (!updated) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });

    // QB sync on update (fire and forget)
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
    const invLink = `https://clean-ops-pro.replit.app/pay/${invoiceId}`;
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
      const payLink = `https://clean-ops-pro.replit.app/pay/${invoiceId}`;
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

export default router;
