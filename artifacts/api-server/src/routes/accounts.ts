import { Router } from "express";
import { db } from "@workspace/db";
import {
  accountsTable, accountRateCardsTable, accountPropertiesTable, accountContactsTable,
  jobsTable, invoicesTable,
} from "@workspace/db/schema";
import { eq, and, sql, inArray, notExists, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function startOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

function startOf12Months() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString();
}

function toLabel(s: string) {
  return s.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

async function getAccountStats(companyId: number, accountId: number) {
  const [revRow] = await db
    .select({
      revenue_mtd: sql<string>`COALESCE(SUM(CASE WHEN ${invoicesTable.status} = 'paid' AND ${invoicesTable.created_at} >= ${startOfMonth()} THEN ${invoicesTable.total}::numeric ELSE 0 END), 0)`,
      revenue_12m: sql<string>`COALESCE(SUM(CASE WHEN ${invoicesTable.status} = 'paid' THEN ${invoicesTable.total}::numeric ELSE 0 END), 0)`,
      outstanding_balance: sql<string>`COALESCE(SUM(CASE WHEN ${invoicesTable.status} IN ('draft','sent') THEN ${invoicesTable.total}::numeric ELSE 0 END), 0)`,
    })
    .from(invoicesTable)
    .where(and(eq(invoicesTable.account_id, accountId), eq(invoicesTable.company_id, companyId)));

  const [jobRow] = await db
    .select({
      open_jobs: sql<string>`COUNT(CASE WHEN ${jobsTable.status} IN ('scheduled','in_progress') THEN 1 END)`,
      jobs_completed: sql<string>`COUNT(CASE WHEN ${jobsTable.status} = 'complete' THEN 1 END)`,
    })
    .from(jobsTable)
    .where(and(eq(jobsTable.account_id, accountId), eq(jobsTable.company_id, companyId)));

  const [propRow] = await db
    .select({ active_properties: sql<string>`COUNT(*)` })
    .from(accountPropertiesTable)
    .where(and(eq(accountPropertiesTable.account_id, accountId), eq(accountPropertiesTable.company_id, companyId), eq(accountPropertiesTable.is_active, true)));

  return {
    revenue_mtd: Number(revRow?.revenue_mtd ?? 0),
    revenue_12m: Number(revRow?.revenue_12m ?? 0),
    outstanding_balance: Number(revRow?.outstanding_balance ?? 0),
    open_jobs: Number(jobRow?.open_jobs ?? 0),
    jobs_completed: Number(jobRow?.jobs_completed ?? 0),
    active_properties: Number(propRow?.active_properties ?? 0),
  };
}

// ─── ACCOUNTS ────────────────────────────────────────────────────────────────

// GET /api/accounts
router.get("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { type, active } = req.query;

    const conditions: any[] = [eq(accountsTable.company_id, companyId)];
    if (type) conditions.push(eq(accountsTable.account_type, type as any));
    if (active !== undefined) conditions.push(eq(accountsTable.is_active, active !== "false"));

    const accounts = await db
      .select()
      .from(accountsTable)
      .where(and(...conditions))
      .orderBy(accountsTable.account_name);

    // Attach stats for each account
    const withStats = await Promise.all(
      accounts.map(async (a) => {
        const stats = await getAccountStats(companyId, a.id);
        return { ...a, ...stats };
      })
    );

    res.json(withStats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch accounts" });
  }
});

// GET /api/accounts/:id
router.get("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const companyId = req.auth!.companyId;
    const [account] = await db
      .select()
      .from(accountsTable)
      .where(and(eq(accountsTable.id, id), eq(accountsTable.company_id, companyId)));

    if (!account) return res.status(404).json({ error: "Account not found" });

    const [rateCards, properties, contacts, stats] = await Promise.all([
      db.select().from(accountRateCardsTable).where(and(eq(accountRateCardsTable.account_id, id), eq(accountRateCardsTable.is_active, true))).orderBy(accountRateCardsTable.service_type),
      db.select().from(accountPropertiesTable).where(and(eq(accountPropertiesTable.account_id, id), eq(accountPropertiesTable.is_active, true))).orderBy(accountPropertiesTable.property_name),
      db.select().from(accountContactsTable).where(eq(accountContactsTable.account_id, id)).orderBy(accountContactsTable.is_primary),
      getAccountStats(companyId, id),
    ]);

    res.json({ ...account, rate_cards: rateCards, properties, contacts, stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch account" });
  }
});

// POST /api/accounts
router.post("/", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  const {
    account_name, account_type, invoice_frequency, payment_method,
    payment_terms_days, notes, auto_charge_on_completion,
    stripe_customer_id, square_customer_id,
  } = req.body;
  if (!account_name) return res.status(400).json({ error: "account_name is required" });

  try {
    const [account] = await db
      .insert(accountsTable)
      .values({
        company_id: req.auth!.companyId,
        account_name,
        account_type: account_type ?? "property_management",
        invoice_frequency: invoice_frequency ?? "per_job",
        payment_method: payment_method ?? "card_on_file",
        payment_terms_days: payment_terms_days ?? 0,
        auto_charge_on_completion: auto_charge_on_completion ?? true,
        notes: notes ?? null,
        stripe_customer_id: stripe_customer_id ?? null,
        square_customer_id: square_customer_id ?? null,
      })
      .returning();
    res.status(201).json(account);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create account" });
  }
});

// PATCH /api/accounts/:id
router.patch("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const allowed = [
    "account_name", "account_type", "invoice_frequency", "payment_method",
    "payment_terms_days", "notes", "is_active", "billing_contact_id",
    "auto_charge_on_completion", "stripe_customer_id", "square_customer_id",
  ];
  const updates: Record<string, unknown> = { updated_at: new Date() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  try {
    const [account] = await db
      .update(accountsTable)
      .set(updates)
      .where(and(eq(accountsTable.id, id), eq(accountsTable.company_id, req.auth!.companyId)))
      .returning();

    if (!account) return res.status(404).json({ error: "Account not found" });
    res.json(account);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update account" });
  }
});

// DELETE /api/accounts/:id  (soft delete)
router.delete("/:id", requireAuth, requireRole("owner"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    await db
      .update(accountsTable)
      .set({ is_active: false, updated_at: new Date() })
      .where(and(eq(accountsTable.id, id), eq(accountsTable.company_id, req.auth!.companyId)));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to deactivate account" });
  }
});

// ─── RATE CARDS ──────────────────────────────────────────────────────────────

// GET /api/accounts/:id/rate-cards  (optionally ?service_type= for rate lookup)
router.get("/:id/rate-cards", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const cards = await db
      .select()
      .from(accountRateCardsTable)
      .where(and(eq(accountRateCardsTable.account_id, id), eq(accountRateCardsTable.company_id, req.auth!.companyId)))
      .orderBy(accountRateCardsTable.service_type);

    if (req.query.service_type) {
      const match = cards.find((c) => c.service_type === req.query.service_type && c.is_active);
      return res.json(match ?? null);
    }

    res.json(cards);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch rate cards" });
  }
});

// GET /api/accounts/:id/rates/lookup?service_type=
router.get("/:id/rates/lookup", requireAuth, requireRole("owner", "admin", "office", "tech"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const { service_type } = req.query;
  if (!service_type) return res.status(400).json({ error: "service_type is required" });

  try {
    const cards = await db
      .select()
      .from(accountRateCardsTable)
      .where(
        and(
          eq(accountRateCardsTable.account_id, id),
          eq(accountRateCardsTable.company_id, req.auth!.companyId),
          eq(accountRateCardsTable.is_active, true),
        )
      );

    const exact = cards.find((c) => c.service_type === service_type);
    const fallback = cards.find((c) => c.service_type === "default");
    const match = exact ?? fallback ?? null;

    res.json(match);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to lookup rate" });
  }
});

// POST /api/accounts/:id/rate-cards
router.post("/:id/rate-cards", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const { service_type, billing_method, rate_amount, unit_label, notes } = req.body;
  if (!service_type || !rate_amount) return res.status(400).json({ error: "service_type and rate_amount are required" });

  try {
    const [card] = await db
      .insert(accountRateCardsTable)
      .values({
        account_id: id,
        company_id: req.auth!.companyId,
        service_type,
        billing_method: billing_method ?? "hourly",
        rate_amount,
        unit_label: unit_label ?? "hr",
        notes: notes ?? null,
      })
      .returning();
    res.status(201).json(card);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create rate card" });
  }
});

// PATCH /api/accounts/:id/rate-cards/:cardId
router.patch("/:id/rate-cards/:cardId", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  const cardId = parseInt(req.params.cardId);
  if (isNaN(cardId)) return res.status(400).json({ error: "Invalid cardId" });

  const allowed = ["service_type", "billing_method", "rate_amount", "unit_label", "is_active", "notes"];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  try {
    const [card] = await db
      .update(accountRateCardsTable)
      .set(updates)
      .where(and(eq(accountRateCardsTable.id, cardId), eq(accountRateCardsTable.company_id, req.auth!.companyId)))
      .returning();
    res.json(card);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update rate card" });
  }
});

// DELETE /api/accounts/:id/rate-cards/:cardId
router.delete("/:id/rate-cards/:cardId", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  const cardId = parseInt(req.params.cardId);
  if (isNaN(cardId)) return res.status(400).json({ error: "Invalid cardId" });

  try {
    await db
      .update(accountRateCardsTable)
      .set({ is_active: false })
      .where(and(eq(accountRateCardsTable.id, cardId), eq(accountRateCardsTable.company_id, req.auth!.companyId)));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete rate card" });
  }
});

// ─── PROPERTIES ──────────────────────────────────────────────────────────────

// GET /api/accounts/:id/properties
router.get("/:id/properties", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const props = await db
      .select()
      .from(accountPropertiesTable)
      .where(and(eq(accountPropertiesTable.account_id, id), eq(accountPropertiesTable.company_id, req.auth!.companyId)))
      .orderBy(accountPropertiesTable.property_name);
    res.json(props);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch properties" });
  }
});

// POST /api/accounts/:id/properties
router.post("/:id/properties", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const { property_name, address, city, state, zip, unit_count, property_type, lat, lng, zone_id, default_service_type, access_notes, notes } = req.body;
  if (!address) return res.status(400).json({ error: "address is required" });

  try {
    const [prop] = await db
      .insert(accountPropertiesTable)
      .values({
        account_id: id,
        company_id: req.auth!.companyId,
        property_name: property_name ?? null,
        address,
        city: city ?? null,
        state: state ?? null,
        zip: zip ?? null,
        unit_count: unit_count ?? null,
        property_type: property_type ?? "apartment_building",
        lat: lat ?? null,
        lng: lng ?? null,
        zone_id: zone_id ?? null,
        default_service_type: default_service_type ?? null,
        access_notes: access_notes ?? null,
        notes: notes ?? null,
      })
      .returning();
    res.status(201).json(prop);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create property" });
  }
});

// PATCH /api/accounts/:id/properties/:propId
router.patch("/:id/properties/:propId", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const propId = parseInt(req.params.propId);
  if (isNaN(propId)) return res.status(400).json({ error: "Invalid propId" });

  const allowed = ["property_name", "address", "city", "state", "zip", "unit_count", "property_type", "lat", "lng", "zone_id", "default_service_type", "access_notes", "notes", "is_active"];
  const updates: Record<string, unknown> = { updated_at: new Date() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  try {
    const [prop] = await db
      .update(accountPropertiesTable)
      .set(updates)
      .where(and(eq(accountPropertiesTable.id, propId), eq(accountPropertiesTable.company_id, req.auth!.companyId)))
      .returning();
    res.json(prop);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update property" });
  }
});

// DELETE /api/accounts/:id/properties/:propId (soft)
router.delete("/:id/properties/:propId", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  const propId = parseInt(req.params.propId);
  if (isNaN(propId)) return res.status(400).json({ error: "Invalid propId" });

  try {
    await db
      .update(accountPropertiesTable)
      .set({ is_active: false, updated_at: new Date() })
      .where(and(eq(accountPropertiesTable.id, propId), eq(accountPropertiesTable.company_id, req.auth!.companyId)));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete property" });
  }
});

// ─── CONTACTS ────────────────────────────────────────────────────────────────

// GET /api/accounts/:id/contacts
router.get("/:id/contacts", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const contacts = await db
      .select()
      .from(accountContactsTable)
      .where(and(eq(accountContactsTable.account_id, id), eq(accountContactsTable.company_id, req.auth!.companyId)))
      .orderBy(accountContactsTable.is_primary);
    res.json(contacts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch contacts" });
  }
});

// POST /api/accounts/:id/contacts
router.post("/:id/contacts", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const {
    name, role, email, phone,
    receives_invoices, receives_receipts, receives_on_way_sms,
    receives_completion_notifications, is_primary, notes,
  } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  try {
    const [contact] = await db
      .insert(accountContactsTable)
      .values({
        account_id: id,
        company_id: req.auth!.companyId,
        name,
        role: role ?? "other",
        email: email ?? null,
        phone: phone ?? null,
        receives_invoices: receives_invoices ?? false,
        receives_receipts: receives_receipts ?? false,
        receives_on_way_sms: receives_on_way_sms ?? false,
        receives_completion_notifications: receives_completion_notifications ?? false,
        is_primary: is_primary ?? false,
        notes: notes ?? null,
      })
      .returning();
    res.status(201).json(contact);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create contact" });
  }
});

// PATCH /api/accounts/:id/contacts/:contactId
router.patch("/:id/contacts/:contactId", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const contactId = parseInt(req.params.contactId);
  if (isNaN(contactId)) return res.status(400).json({ error: "Invalid contactId" });

  const allowed = [
    "name", "role", "email", "phone",
    "receives_invoices", "receives_receipts", "receives_on_way_sms",
    "receives_completion_notifications", "is_primary", "notes",
  ];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  try {
    const [contact] = await db
      .update(accountContactsTable)
      .set(updates)
      .where(and(eq(accountContactsTable.id, contactId), eq(accountContactsTable.company_id, req.auth!.companyId)))
      .returning();
    res.json(contact);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update contact" });
  }
});

// DELETE /api/accounts/:id/contacts/:contactId
router.delete("/:id/contacts/:contactId", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  const contactId = parseInt(req.params.contactId);
  if (isNaN(contactId)) return res.status(400).json({ error: "Invalid contactId" });

  try {
    await db
      .delete(accountContactsTable)
      .where(and(eq(accountContactsTable.id, contactId), eq(accountContactsTable.company_id, req.auth!.companyId)));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete contact" });
  }
});

// ─── UNINVOICED JOBS ──────────────────────────────────────────────────────────

// GET /api/accounts/:id/uninvoiced-jobs
router.get("/:id/uninvoiced-jobs", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const companyId = req.auth!.companyId;
    const jobs = await db
      .select()
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.account_id, id),
          eq(jobsTable.company_id, companyId),
          eq(jobsTable.status, "complete"),
          notExists(
            db.select({ x: invoicesTable.id })
              .from(invoicesTable)
              .where(and(
                eq(invoicesTable.job_id, jobsTable.id),
                inArray(invoicesTable.status, ["sent", "paid"]),
              ))
          )
        )
      )
      .orderBy(desc(jobsTable.scheduled_date));

    res.json(jobs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch uninvoiced jobs" });
  }
});

// ─── GENERATE INVOICE ─────────────────────────────────────────────────────────

// POST /api/accounts/:id/generate-invoice   (?preview=true for dry run)
router.post("/:id/generate-invoice", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const preview = req.query.preview === "true";

  try {
    const companyId = req.auth!.companyId;
    const [account] = await db
      .select()
      .from(accountsTable)
      .where(and(eq(accountsTable.id, id), eq(accountsTable.company_id, companyId)));

    if (!account) return res.status(404).json({ error: "Account not found" });

    // Find all uninvoiced completed jobs
    const uninvoicedJobs = await db
      .select()
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.account_id, id),
          eq(jobsTable.company_id, companyId),
          eq(jobsTable.status, "complete"),
          notExists(
            db.select({ x: invoicesTable.id })
              .from(invoicesTable)
              .where(and(
                eq(invoicesTable.job_id, jobsTable.id),
                inArray(invoicesTable.status, ["sent", "paid"]),
              ))
          )
        )
      )
      .orderBy(jobsTable.scheduled_date);

    if (uninvoicedJobs.length === 0) {
      return res.json({ ok: true, invoice: null, message: "No uninvoiced jobs found" });
    }

    const lineItems = uninvoicedJobs.map((j) => {
      const billedAmt = j.billed_amount ? parseFloat(j.billed_amount as string) : parseFloat(j.base_fee ?? "0");
      const svcLabel = toLabel(j.service_type ?? "cleaning");
      const propInfo = j.account_property_id ? ` (Prop #${j.account_property_id})` : "";
      return {
        description: `${svcLabel}${propInfo} — ${j.scheduled_date}`,
        quantity: j.billed_hours ? parseFloat(j.billed_hours as string) : 1,
        unit_price: j.hourly_rate ? parseFloat(j.hourly_rate as string) : parseFloat(j.base_fee ?? "0"),
        total: billedAmt,
        job_id: j.id,
      };
    });

    const subtotal = lineItems.reduce((s, li) => s + li.total, 0);
    const termsDays = account.payment_terms_days ?? 0;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + termsDays);
    const dueDateStr = dueDate.toISOString().split("T")[0];
    const termsLabel = termsDays === 30 ? "net_30" : termsDays === 15 ? "net_15" : termsDays === 7 ? "net_7" : "due_on_receipt";
    const invoiceNumber = `ACC-${id}-${Date.now()}`;

    const invoicePayload = {
      company_id: companyId,
      account_id: id,
      client_id: null as null | number,
      invoice_number: invoiceNumber,
      status: "draft" as const,
      line_items: lineItems,
      subtotal: subtotal.toFixed(2),
      tips: "0",
      total: subtotal.toFixed(2),
      due_date: dueDateStr,
      payment_terms: termsLabel,
      created_by: req.auth!.userId,
    };

    if (preview) {
      return res.json({ ok: true, preview: true, invoice: invoicePayload, jobs_count: uninvoicedJobs.length });
    }

    const [invoice] = await db
      .insert(invoicesTable)
      .values(invoicePayload)
      .returning();

    res.status(201).json({ ok: true, invoice, jobs_consolidated: uninvoicedJobs.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate invoice" });
  }
});

// ─── CHARGE ──────────────────────────────────────────────────────────────────

// POST /api/accounts/:id/charge  — attempt payment on all outstanding invoices
router.post("/:id/charge", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const companyId = req.auth!.companyId;
    const [account] = await db
      .select()
      .from(accountsTable)
      .where(and(eq(accountsTable.id, id), eq(accountsTable.company_id, companyId)));

    if (!account) return res.status(404).json({ error: "Account not found" });

    // Find all outstanding invoices for this account
    const outstanding = await db
      .select()
      .from(invoicesTable)
      .where(and(
        eq(invoicesTable.account_id, id),
        eq(invoicesTable.company_id, companyId),
        inArray(invoicesTable.status, ["draft", "sent"]),
      ));

    if (outstanding.length === 0) {
      return res.json({ ok: true, charged: 0, message: "No outstanding invoices" });
    }

    const total = outstanding.reduce((s, i) => s + parseFloat(i.total ?? "0"), 0);

    // Stub: mark charge attempted on related jobs
    const jobIds = outstanding.map((i) => i.job_id).filter(Boolean) as number[];
    if (jobIds.length > 0) {
      await db
        .update(jobsTable)
        .set({ charge_attempted_at: new Date() })
        .where(and(eq(jobsTable.company_id, companyId), inArray(jobsTable.id, jobIds)));
    }

    res.json({
      ok: true,
      charged: outstanding.length,
      total: total.toFixed(2),
      message: `Charge initiated for ${outstanding.length} invoice(s) totaling $${total.toFixed(2)}`,
      payment_method: account.payment_method,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to process charge" });
  }
});

// GET /api/accounts/:id/payment-status
router.get("/:id/payment-status", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const companyId = req.auth!.companyId;
    const invoices = await db
      .select()
      .from(invoicesTable)
      .where(and(eq(invoicesTable.account_id, id), eq(invoicesTable.company_id, companyId)))
      .orderBy(desc(invoicesTable.created_at))
      .limit(20);

    const summary = {
      paid: invoices.filter((i) => i.status === "paid").reduce((s, i) => s + parseFloat(i.total ?? "0"), 0),
      outstanding: invoices.filter((i) => ["draft", "sent"].includes(i.status)).reduce((s, i) => s + parseFloat(i.total ?? "0"), 0),
      count_paid: invoices.filter((i) => i.status === "paid").length,
      count_outstanding: invoices.filter((i) => ["draft", "sent"].includes(i.status)).length,
    };

    res.json({ summary, recent_invoices: invoices });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch payment status" });
  }
});

// ─── LEGACY CONSOLIDATE INVOICES ─────────────────────────────────────────────

// POST /api/accounts/:id/consolidate-invoices  (redirects to generate-invoice for backwards compat)
router.post("/:id/consolidate-invoices", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  req.url = `/${req.params.id}/generate-invoice`;
  res.redirect(307, req.url);
});

export default router;
