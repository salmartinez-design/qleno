import { Router } from "express";
import { db } from "@workspace/db";
import {
  accountsTable, accountRateCardsTable, accountPropertiesTable, accountContactsTable,
  jobsTable, invoicesTable,
} from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

// ─── ACCOUNTS ────────────────────────────────────────────────────────────────

// GET /api/accounts
router.get("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const accounts = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.company_id, req.auth!.companyId))
      .orderBy(accountsTable.account_name);

    // Attach contact/property counts
    const withCounts = await Promise.all(
      accounts.map(async (a) => {
        const [propCount] = await db
          .select({ count: sql<number>`count(*)` })
          .from(accountPropertiesTable)
          .where(and(eq(accountPropertiesTable.account_id, a.id), eq(accountPropertiesTable.is_active, true)));
        const [contactCount] = await db
          .select({ count: sql<number>`count(*)` })
          .from(accountContactsTable)
          .where(eq(accountContactsTable.account_id, a.id));
        return { ...a, property_count: Number(propCount?.count ?? 0), contact_count: Number(contactCount?.count ?? 0) };
      })
    );

    res.json(withCounts);
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
    const [account] = await db
      .select()
      .from(accountsTable)
      .where(and(eq(accountsTable.id, id), eq(accountsTable.company_id, req.auth!.companyId)));

    if (!account) return res.status(404).json({ error: "Account not found" });

    const [rateCards, properties, contacts] = await Promise.all([
      db.select().from(accountRateCardsTable).where(eq(accountRateCardsTable.account_id, id)),
      db.select().from(accountPropertiesTable).where(eq(accountPropertiesTable.account_id, id)).orderBy(accountPropertiesTable.property_name),
      db.select().from(accountContactsTable).where(eq(accountContactsTable.account_id, id)),
    ]);

    res.json({ ...account, rate_cards: rateCards, properties, contacts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch account" });
  }
});

// POST /api/accounts
router.post("/", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  const { account_name, account_type, invoice_frequency, payment_method, payment_terms_days, notes } = req.body;
  if (!account_name) return res.status(400).json({ error: "account_name is required" });

  try {
    const [account] = await db
      .insert(accountsTable)
      .values({
        company_id: req.auth!.companyId,
        account_name,
        account_type: account_type ?? "commercial",
        invoice_frequency: invoice_frequency ?? "per_job",
        payment_method: payment_method ?? null,
        payment_terms_days: payment_terms_days ?? 30,
        notes: notes ?? null,
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

  const allowed = ["account_name", "account_type", "invoice_frequency", "payment_method", "payment_terms_days", "notes", "is_active", "billing_contact_id"];
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

// GET /api/accounts/:id/rate-cards  (optionally ?service_type=xxx for auto-fill)
router.get("/:id/rate-cards", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    let query = db
      .select()
      .from(accountRateCardsTable)
      .where(and(eq(accountRateCardsTable.account_id, id), eq(accountRateCardsTable.company_id, req.auth!.companyId)));

    const cards = await query;

    if (req.query.service_type) {
      const match = cards.filter((c) => c.service_type === req.query.service_type && c.is_active);
      return res.json(match[0] ?? null);
    }

    res.json(cards);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch rate cards" });
  }
});

// POST /api/accounts/:id/rate-cards
router.post("/:id/rate-cards", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const { service_type, billing_method, rate_amount, unit_label } = req.body;
  if (!service_type || !rate_amount) return res.status(400).json({ error: "service_type and rate_amount are required" });

  try {
    const [card] = await db
      .insert(accountRateCardsTable)
      .values({
        account_id: id,
        company_id: req.auth!.companyId,
        service_type,
        billing_method: billing_method ?? "flat",
        rate_amount,
        unit_label: unit_label ?? "job",
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

  const allowed = ["service_type", "billing_method", "rate_amount", "unit_label", "is_active"];
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

  const { property_name, address, unit_count, property_type, lat, lng, zone_id, notes } = req.body;
  if (!property_name || !address) return res.status(400).json({ error: "property_name and address are required" });

  try {
    const [prop] = await db
      .insert(accountPropertiesTable)
      .values({
        account_id: id,
        company_id: req.auth!.companyId,
        property_name,
        address,
        unit_count: unit_count ?? null,
        property_type: property_type ?? "other",
        lat: lat ?? null,
        lng: lng ?? null,
        zone_id: zone_id ?? null,
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

  const allowed = ["property_name", "address", "unit_count", "property_type", "lat", "lng", "zone_id", "notes", "is_active"];
  const updates: Record<string, unknown> = {};
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
      .set({ is_active: false })
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
      .where(and(eq(accountContactsTable.account_id, id), eq(accountContactsTable.company_id, req.auth!.companyId)));
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

  const { name, role, email, phone, receives_invoices, receives_on_way_notifications, receives_completion_notifications } = req.body;
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
        receives_on_way_notifications: receives_on_way_notifications ?? false,
        receives_completion_notifications: receives_completion_notifications ?? false,
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

  const allowed = ["name", "role", "email", "phone", "receives_invoices", "receives_on_way_notifications", "receives_completion_notifications"];
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

// ─── INVOICE CONSOLIDATION ────────────────────────────────────────────────────

// POST /api/accounts/:id/consolidate-invoices
// Collects all uninvoiced completed jobs for this account and creates one invoice
router.post("/:id/consolidate-invoices", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const [account] = await db
      .select()
      .from(accountsTable)
      .where(and(eq(accountsTable.id, id), eq(accountsTable.company_id, req.auth!.companyId)));

    if (!account) return res.status(404).json({ error: "Account not found" });

    // Find all completed jobs for this account that are not yet invoiced
    const uninvoicedJobs = await db
      .select()
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.account_id, id),
          eq(jobsTable.company_id, req.auth!.companyId),
          eq(jobsTable.status, "complete"),
        )
      );

    // Filter out jobs that already have an invoice
    const existingInvoices = await db
      .select({ job_id: invoicesTable.job_id })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.account_id, id), eq(invoicesTable.company_id, req.auth!.companyId)));

    const invoicedJobIds = new Set(existingInvoices.map((i) => i.job_id).filter(Boolean));
    const jobs = uninvoicedJobs.filter((j) => !invoicedJobIds.has(j.id));

    if (jobs.length === 0) {
      return res.json({ ok: true, invoice: null, message: "No uninvoiced jobs found" });
    }

    const lineItems = jobs.map((j) => ({
      description: `${j.service_type.replace(/_/g, " ")} — ${j.scheduled_date}`,
      quantity: 1,
      unit_price: parseFloat(j.base_fee ?? "0"),
      total: parseFloat(j.base_fee ?? "0"),
      job_id: j.id,
    }));

    const subtotal = lineItems.reduce((sum, li) => sum + li.total, 0);
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + (account.payment_terms_days ?? 30));
    const dueDateStr = dueDate.toISOString().split("T")[0];

    const invoiceNumber = `ACC-${id}-${Date.now()}`;

    const [invoice] = await db
      .insert(invoicesTable)
      .values({
        company_id: req.auth!.companyId,
        account_id: id,
        client_id: null,
        invoice_number: invoiceNumber,
        status: "draft",
        line_items: lineItems,
        subtotal: subtotal.toFixed(2),
        tips: "0",
        total: subtotal.toFixed(2),
        due_date: dueDateStr,
        payment_terms: `net_${account.payment_terms_days}`,
      })
      .returning();

    res.status(201).json({ ok: true, invoice, jobs_consolidated: jobs.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to consolidate invoices" });
  }
});

export default router;
