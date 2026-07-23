import { Router } from "express";
import { db } from "@workspace/db";
import {
  accountsTable, accountRateCardsTable, accountPropertiesTable, accountContactsTable,
  jobsTable, invoicesTable, usersTable, clientsTable, recurringSchedulesTable,
  technicianPreferencesTable,
} from "@workspace/db/schema";
import { eq, and, sql, inArray, notExists, desc, gte, lte } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { utcIso } from "../lib/time-serialize.js";
import { INVOICE_CUTOVER_DATE } from "../lib/ensure-invoice.js";

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

// ─── TECHNICIAN PREFERENCES (account scope) ─────────────────────────────────
// [tech-pref-accounts 2026-07-21] Preferred / do-not-schedule cleaner for a
// commercial account (Sal: "for this account only send Rossy"). Mirrors the
// per-client tech-preferences routes in clients.ts, keyed on account_id. Same
// stored-reference model — the dispatch board surfaces the flag; nothing here
// auto-assigns.
//
// Idempotent boot migration: relax technician_preferences.client_id NOT NULL and
// add account_id so a row can be scoped to a client OR an account.
export async function ensureTechPrefAccountColumns(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE technician_preferences ADD COLUMN IF NOT EXISTS account_id integer`);
    await db.execute(sql`ALTER TABLE technician_preferences ALTER COLUMN client_id DROP NOT NULL`);
    console.log("[tech-pref-accounts] migration ok");
  } catch (err) {
    console.error("[tech-pref-accounts] migration (non-fatal):", err);
  }
}

router.get("/:id/tech-preferences", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const accountId = parseInt(req.params.id);
    if (isNaN(accountId)) return res.status(400).json({ error: "Invalid id" });
    const prefs = await db.select({
      id: technicianPreferencesTable.id,
      user_id: technicianPreferencesTable.user_id,
      preference: technicianPreferencesTable.preference,
      notes: technicianPreferencesTable.notes,
      created_at: technicianPreferencesTable.created_at,
      first_name: usersTable.first_name,
      last_name: usersTable.last_name,
      avatar_url: usersTable.avatar_url,
    }).from(technicianPreferencesTable)
      .leftJoin(usersTable, eq(technicianPreferencesTable.user_id, usersTable.id))
      .where(and(
        eq(technicianPreferencesTable.account_id, accountId),
        eq(technicianPreferencesTable.company_id, req.auth!.companyId!),
      ));
    return res.json(prefs);
  } catch (err) {
    console.error("[tech-pref-accounts] GET error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/tech-preferences", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const accountId = parseInt(req.params.id);
    if (isNaN(accountId)) return res.status(400).json({ error: "Invalid id" });
    const { user_id, preference, notes } = req.body;
    if (!user_id || !preference) return res.status(400).json({ error: "user_id and preference are required" });
    const [pref] = await db.insert(technicianPreferencesTable).values({
      company_id: req.auth!.companyId!, account_id: accountId, client_id: null,
      user_id: Number(user_id), preference, notes: notes ?? null,
    }).returning();
    return res.status(201).json(pref);
  } catch (err) {
    console.error("[tech-pref-accounts] POST error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/:id/tech-preferences/:prefId", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const prefId = parseInt(req.params.prefId);
    if (isNaN(prefId)) return res.status(400).json({ error: "Invalid id" });
    await db.delete(technicianPreferencesTable)
      .where(and(
        eq(technicianPreferencesTable.id, prefId),
        eq(technicianPreferencesTable.company_id, req.auth!.companyId!),
      ));
    return res.json({ success: true });
  } catch (err) {
    console.error("[tech-pref-accounts] DELETE error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── CUSTOMER NOTIFICATION PREFERENCES (account scope) ──────────────────────
// Which automated customer messages every job under this account receives, per
// channel. Applies to all of the account's properties/clients. This is the
// granular companion to the existing accounts.comms_enabled master pause.
router.get("/:id/notification-preferences", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const companyId = req.auth!.companyId!;
    const [account] = await db.select({ id: accountsTable.id })
      .from(accountsTable).where(and(eq(accountsTable.id, id), eq(accountsTable.company_id, companyId)));
    if (!account) return res.status(404).json({ error: "Account not found" });
    const { PREFERENCE_CATALOG, getScopeOverrides } = await import("../lib/notification-preferences.js");
    const overrides = await getScopeOverrides(companyId, "account", id);
    return res.json({ catalog: PREFERENCE_CATALOG, overrides, scope_type: "account" });
  } catch (err) {
    console.error("[notif-prefs] GET account prefs error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/:id/notification-preferences", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const companyId = req.auth!.companyId!;
    const [account] = await db.select({ id: accountsTable.id })
      .from(accountsTable).where(and(eq(accountsTable.id, id), eq(accountsTable.company_id, companyId)));
    if (!account) return res.status(404).json({ error: "Account not found" });
    const { setScopeOverrides, setAllOff } = await import("../lib/notification-preferences.js");
    if (req.body?.all_off === true) {
      await setAllOff(companyId, "account", id);
    } else {
      const overrides = Array.isArray(req.body?.overrides) ? req.body.overrides : [];
      await setScopeOverrides(companyId, "account", id, overrides);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("[notif-prefs] PUT account prefs error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
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
        // [manual-charging-policy 2026-07-22] Defaults OFF. An account only
        // auto-charges if the caller explicitly asks for it.
        auto_charge_on_completion: auto_charge_on_completion ?? false,
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
// [office-parity 2026-07-03] Office may edit an account's billing settings
// (payment terms / frequency / method / auto-charge) from the account Overview —
// consistent with the office-admin-parity elevation. Was owner/admin-only, which
// blocked the office manager from setting NET 30 → due-on-receipt etc.
router.patch("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const allowed = [
    "account_name", "account_type", "invoice_frequency", "payment_method",
    "payment_terms_days", "notes", "is_active", "billing_contact_id",
    "auto_charge_on_completion", "stripe_customer_id", "square_customer_id",
    // [account-comms-toggle] master "pause all communications" switch
    "comms_enabled",
    // [auto-issue-toggle 2026-07-22] per-account auto-invoicing on/off (default
    // on). Off = completed jobs for this account produce no invoice at all and
    // wait in the "not yet invoiced" queue for the office.
    "auto_issue_enabled",
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
// [office-admin-parity 2026-06-26] Office tier may delete customer accounts (Sal granted this).
router.delete("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
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

// GET /api/accounts/:id/properties/:propId/recent-job
// Most recent non-cancelled job at this property — powers the job-wizard
// "Rebook last service" suggestion. Returns null when the property has no
// prior jobs (the wizard then falls back to the property's
// default_service_type). Scoped to the property so each building remembers
// its own last service (e.g. a turnover at 1120 N La Salle, a common-area
// clean at 1555 N Astor).
router.get("/:id/properties/:propId/recent-job", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const id = parseInt(req.params.id);
  const propId = parseInt(req.params.propId);
  if (isNaN(id) || isNaN(propId)) return res.status(400).json({ error: "Invalid id" });

  try {
    const [job] = await db
      .select({
        id: jobsTable.id,
        service_type: jobsTable.service_type,
        billing_method: jobsTable.billing_method,
        hourly_rate: jobsTable.hourly_rate,
        allowed_hours: jobsTable.allowed_hours,
        estimated_hours: jobsTable.estimated_hours,
        base_fee: jobsTable.base_fee,
        frequency: jobsTable.frequency,
        scheduled_date: jobsTable.scheduled_date,
      })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.account_id, id),
          eq(jobsTable.account_property_id, propId),
          eq(jobsTable.company_id, req.auth!.companyId),
          sql`${jobsTable.status} <> 'cancelled'`,
        )
      )
      .orderBy(desc(jobsTable.scheduled_date), desc(jobsTable.id))
      .limit(1);

    res.json(job ?? null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch recent job" });
  }
});

// GET /api/accounts/:id/jobs-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
// Jobs for this account across ALL its properties within a date range —
// powers the simplified month calendar on the account detail page. Returns a
// flat list; the frontend buckets by scheduled_date and shows one count per
// day with a hover popover (per-job time / property / service / tech /
// amount / status).
router.get("/:id/jobs-calendar", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const from = typeof req.query.from === "string" ? req.query.from : null;
  const to = typeof req.query.to === "string" ? req.query.to : null;
  if (!from || !to) return res.status(400).json({ error: "from and to are required (YYYY-MM-DD)" });

  try {
    const rows = await db
      .select({
        id: jobsTable.id,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        status: jobsTable.status,
        service_type: jobsTable.service_type,
        base_fee: jobsTable.base_fee,
        billing_method: jobsTable.billing_method,
        allowed_hours: jobsTable.allowed_hours,
        account_property_id: jobsTable.account_property_id,
        property_name: accountPropertiesTable.property_name,
        property_address: accountPropertiesTable.address,
        // [account-calendar-address 2026-07-07] The job's OWN service address
        // (stamped from the schedule at generation). Dispatch displays this
        // first, so when a job's property link disagrees with it (Daveco: job
        // at 18440 Torrence linked to the 18428 property) the calendar must
        // show THIS, not the wrongly linked property — otherwise two visits at
        // two different buildings render with the same duplicated address.
        job_address_street: sql<string | null>`NULLIF(${jobsTable.address_street}, '')`,
        tech_first_name: usersTable.first_name,
        tech_last_name: usersTable.last_name,
      })
      .from(jobsTable)
      .leftJoin(accountPropertiesTable, eq(jobsTable.account_property_id, accountPropertiesTable.id))
      .leftJoin(usersTable, eq(jobsTable.assigned_user_id, usersTable.id))
      .where(and(
        eq(jobsTable.account_id, id),
        eq(jobsTable.company_id, req.auth!.companyId),
        gte(jobsTable.scheduled_date, from),
        lte(jobsTable.scheduled_date, to),
      ))
      .orderBy(jobsTable.scheduled_date, jobsTable.scheduled_time);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch jobs calendar" });
  }
});

// [account-activity 2026-07-07] GET /api/accounts/:id/activity — one
// chronological audit feed for the ACCOUNT, mirroring the client profile's
// /api/clients/:id/activity (Maribel: "Accounts do not have a communications
// log, or activity log … we need that to know if the invoices are going
// out"). Scope: everything on the account's jobs (jobs.account_id) + comms
// keyed to the account (communication_log.account_id, written by the invoice
// send path) + the account's invoices (created/sent trail). Each source is
// independently try/caught so a missing table never blanks the feed.
router.get("/:id/activity", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const accountId = parseInt(req.params.id);
  if (isNaN(accountId)) return res.status(400).json({ error: "Invalid id" });
  const companyId = req.auth!.companyId;
  const limit = Math.min(parseInt(String(req.query.limit ?? "200")) || 200, 500);

  type Ev = { event_type: string; occurred_at: string; user_name: string | null; field_name: string | null; old_value: any; new_value: any; related_job_id: number | null; related_job_date: string | null; action: string | null };
  const events: Ev[] = [];

  // Zone-less UTC timestamps → explicit-UTC ISO (shared utcIso, see
  // lib/time-serialize.ts) so the browser doesn't misparse them as local.
  const jobDate = (v: any): string | null => (v ? String(v).slice(0, 10) : null);

  // 1. Per-field job edits on the account's jobs
  try {
    const r = await db.execute(sql`
      SELECT jal.edited_at, jal.user_name, jal.field_name, jal.old_value, jal.new_value, jal.job_id, jal.cascade_scope, j.scheduled_date
      FROM job_audit_log jal JOIN jobs j ON jal.job_id = j.id
      WHERE j.account_id = ${accountId} AND jal.company_id = ${companyId}
      ORDER BY jal.edited_at DESC LIMIT ${limit}`);
    for (const x of r.rows as any[]) events.push({ event_type: "job_edit", occurred_at: x.edited_at, user_name: x.user_name, field_name: x.field_name, old_value: x.old_value, new_value: x.new_value, related_job_id: x.job_id != null ? Number(x.job_id) : null, related_job_date: jobDate(x.scheduled_date), action: x.cascade_scope ?? null });
  } catch (e) { console.error("[account-activity] job_audit_log:", (e as any)?.message); }

  // 2. Cancellations / reschedules on the account's jobs
  try {
    const r = await db.execute(sql`
      SELECT cl.cancelled_at, cl.cancel_action, cl.cancel_reason, cl.customer_charge_amount, cl.notes, cl.job_id, jb.scheduled_date,
             NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS user_name
      FROM cancellation_log cl JOIN jobs jb ON cl.job_id = jb.id LEFT JOIN users u ON cl.cancelled_by = u.id
      WHERE jb.account_id = ${accountId} AND cl.company_id = ${companyId}
      ORDER BY cl.cancelled_at DESC LIMIT ${limit}`);
    for (const x of r.rows as any[]) events.push({ event_type: (x.cancel_action === "move" || x.cancel_action === "bump") ? "job_rescheduled" : "job_cancelled", occurred_at: x.cancelled_at, user_name: x.user_name, field_name: x.cancel_action, old_value: null, new_value: { reason: x.cancel_reason, charge: x.customer_charge_amount, notes: x.notes }, related_job_id: x.job_id != null ? Number(x.job_id) : null, related_job_date: jobDate(x.scheduled_date), action: x.cancel_action });
  } catch (e) { console.error("[account-activity] cancellation_log:", (e as any)?.message); }

  // 3. Communications — account-keyed rows (invoice emails) + rows tied to
  // the account's jobs.
  try {
    const r = await db.execute(sql`
      SELECT com.logged_at, com.channel, com.direction, com.summary, com.subject, com.job_id, com.delivery_status, jb.scheduled_date,
             NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS user_name
      FROM communication_log com
      LEFT JOIN users u ON com.logged_by = u.id
      LEFT JOIN jobs jb ON com.job_id = jb.id
      WHERE com.company_id = ${companyId} AND (com.account_id = ${accountId} OR jb.account_id = ${accountId})
      ORDER BY com.logged_at DESC LIMIT ${limit}`);
    for (const x of r.rows as any[]) events.push({ event_type: "communication", occurred_at: x.logged_at, user_name: x.user_name, field_name: x.channel, old_value: null, new_value: { direction: x.direction, summary: x.summary, subject: x.subject, delivery_status: x.delivery_status }, related_job_id: x.job_id != null ? Number(x.job_id) : null, related_job_date: jobDate(x.scheduled_date), action: x.direction });
  } catch (e) { console.error("[account-activity] communication_log:", (e as any)?.message); }

  // 4. Job creations on the account's jobs
  try {
    const r = await db.execute(sql`
      SELECT aal.performed_at, aal.action, aal.target_id, aal.new_value, jj.scheduled_date,
             NULLIF(TRIM(COALESCE(au.first_name,'') || ' ' || COALESCE(au.last_name,'')), '') AS user_name
      FROM app_audit_log aal
      LEFT JOIN users au ON aal.performed_by = au.id
      JOIN jobs jj ON aal.target_type = 'job' AND aal.target_id ~ '^[0-9]+$' AND aal.target_id::int = jj.id
      WHERE aal.company_id = ${companyId} AND aal.action = 'CREATE' AND jj.account_id = ${accountId}
      ORDER BY aal.performed_at DESC LIMIT ${limit}`);
    for (const x of r.rows as any[]) events.push({ event_type: "job_created", occurred_at: x.performed_at, user_name: x.user_name, field_name: null, old_value: null, new_value: x.new_value, related_job_id: Number(x.target_id), related_job_date: jobDate(x.scheduled_date), action: x.action });
  } catch (e) { console.error("[account-activity] app_audit_log:", (e as any)?.message); }

  // 5. Invoice trail — created + sent, for account invoices AND per-job
  // invoices on the account's jobs. This is the "are the invoices going
  // out" answer even before the comm-log rows existed.
  try {
    const r = await db.execute(sql`
      SELECT iv.id, iv.invoice_number, iv.status, iv.total, iv.created_at, iv.sent_at, iv.job_id, jb.scheduled_date
      FROM invoices iv LEFT JOIN jobs jb ON iv.job_id = jb.id
      WHERE iv.company_id = ${companyId} AND (iv.account_id = ${accountId} OR jb.account_id = ${accountId})
      ORDER BY iv.created_at DESC LIMIT ${limit}`);
    for (const x of r.rows as any[]) {
      const num = x.invoice_number || `#${x.id}`;
      const rel = x.job_id != null ? Number(x.job_id) : null;
      events.push({ event_type: "invoice", occurred_at: x.created_at, user_name: null, field_name: "created", old_value: null, new_value: { summary: `Invoice ${num} created (${x.status})`, amount: x.total }, related_job_id: rel, related_job_date: jobDate(x.scheduled_date), action: "created" });
      if (x.sent_at) events.push({ event_type: "invoice", occurred_at: x.sent_at, user_name: null, field_name: "sent", old_value: null, new_value: { summary: `Invoice ${num} sent`, amount: x.total }, related_job_id: rel, related_job_date: jobDate(x.scheduled_date), action: "sent" });
    }
  } catch (e) { console.error("[account-activity] invoices:", (e as any)?.message); }

  for (const e of events) e.occurred_at = utcIso(e.occurred_at);
  events.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
  return res.json({ events: events.slice(0, limit) });
});

// [account-messages 2026-07-09] GET /api/accounts/:id/messages — a read-only
// communications log for the ACCOUNT, giving it parity with the client profile's
// /api/clients/:id/messages (Maribel: "Accounts still doesn't have a
// communications log, only activity"). Unlike clients, notification_log /
// sms_messages / message_log have NO account_id, so we resolve the account's
// contact emails + phones (account_contacts) and match those, plus
// communication_log by account_id / the account's jobs. Read-only — no compose
// endpoint yet (clients have one; accounts follow later). Each contact is
// normalized: email lowercased, phone to last-10-digits. Timestamps are
// UTC-normalized on the way out (utcIso) like the activity feed.
router.get("/:id/messages", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const accountId = parseInt(req.params.id);
    if (isNaN(accountId)) return res.status(400).json({ error: "Invalid id" });
    const companyId = req.auth!.companyId!;
    const [acct] = await db.select({ id: accountsTable.id }).from(accountsTable)
      .where(and(eq(accountsTable.id, accountId), eq(accountsTable.company_id, companyId))).limit(1);
    if (!acct) return res.status(404).json({ error: "Not Found" });

    // Resolve the account's contact emails + phones so the no-account_id tables
    // (notification_log / sms_messages / message_log) can still be matched.
    const contacts = await db.execute(sql`
      SELECT email, phone FROM account_contacts
       WHERE account_id = ${accountId} AND company_id = ${companyId}`);
    const emailSet = new Set<string>();
    const phoneSet = new Set<string>();
    for (const c of contacts.rows as any[]) {
      if (c.email) emailSet.add(String(c.email).toLowerCase().trim());
      const d = String(c.phone ?? "").replace(/\D/g, "");
      if (d.length >= 10) phoneSet.add(d.slice(-10));
    }
    const emails = Array.from(emailSet);
    const phones = Array.from(phoneSet);

    const result = await db.execute(sql`
      SELECT * FROM (
        SELECT nl.sent_at AS at, nl.channel::text AS channel, 'outbound'::text AS direction,
               nl.trigger::text AS type, nl.recipient::text AS recipient, nl.status::text AS status,
               (nl.metadata->>'subject')::text AS subject, (nl.metadata->>'body')::text AS body,
               (nl.metadata->>'html')::text AS email_html, 'automated'::text AS source
          FROM notification_log nl
         WHERE nl.company_id = ${companyId}
           AND ( lower(nl.recipient) = ANY(${emails}::text[])
              OR RIGHT(regexp_replace(COALESCE(nl.recipient, ''), '[^0-9]', '', 'g'), 10) = ANY(${phones}::text[]) )
        UNION ALL
        SELECT created_at AS at, 'sms'::text AS channel, direction::text AS direction,
               'sms'::text AS type, COALESCE(to_number, from_number)::text AS recipient,
               status::text AS status, NULL::text AS subject, body::text AS body,
               NULL::text AS email_html, 'two_way'::text AS source
          FROM sms_messages
         WHERE company_id = ${companyId} AND (
               RIGHT(regexp_replace(COALESCE(contact_phone, ''), '[^0-9]', '', 'g'), 10) = ANY(${phones}::text[])
            OR RIGHT(regexp_replace(COALESCE(to_number, ''),    '[^0-9]', '', 'g'), 10) = ANY(${phones}::text[])
            OR RIGHT(regexp_replace(COALESCE(from_number, ''),   '[^0-9]', '', 'g'), 10) = ANY(${phones}::text[]) )
        UNION ALL
        SELECT com.logged_at AS at, com.channel::text AS channel, com.direction::text AS direction,
               COALESCE(com.source, 'message')::text AS type, com.recipient::text AS recipient,
               com.delivery_status::text AS status, com.subject::text AS subject, com.body::text AS body,
               NULL::text AS email_html, 'logged'::text AS source
          FROM communication_log com
          LEFT JOIN jobs jb ON com.job_id = jb.id
         WHERE com.company_id = ${companyId} AND (com.account_id = ${accountId} OR jb.account_id = ${accountId})
        UNION ALL
        SELECT sent_at AS at, channel::text AS channel, 'outbound'::text AS direction,
               COALESCE(sequence_name, 'message')::text AS type,
               COALESCE(recipient_email, recipient_phone)::text AS recipient,
               status::text AS status, subject::text AS subject, body::text AS body,
               CASE WHEN channel = 'email' AND body ~ '<[a-zA-Z]' THEN body END AS email_html,
               'cadence'::text AS source
          FROM message_log
         WHERE company_id = ${companyId} AND (
               lower(recipient_email) = ANY(${emails}::text[])
            OR RIGHT(regexp_replace(COALESCE(recipient_phone, ''), '[^0-9]', '', 'g'), 10) = ANY(${phones}::text[]) )
      ) t
      ORDER BY at DESC NULLS LAST
      LIMIT 200`);

    const rows = (result.rows as any[]).map(r => ({ ...r, at: r.at ? utcIso(r.at) : null }));
    return res.json({ data: rows });
  } catch (err) {
    console.error("[account-messages]:", err);
    return res.status(500).json({ error: "Internal Server Error" });
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

  const notesChanged = "notes" in updates || "access_notes" in updates;
  try {
    const companyId = req.auth!.companyId;
    // Snapshot the previous building notes so propagation can tell a per-job
    // custom note apart from a stale copy of the old building note.
    const [before] = notesChanged
      ? await db.select({ notes: accountPropertiesTable.notes, access_notes: accountPropertiesTable.access_notes })
          .from(accountPropertiesTable)
          .where(and(eq(accountPropertiesTable.id, propId), eq(accountPropertiesTable.company_id, companyId))).limit(1)
      : [undefined as any];

    const [prop] = await db
      .update(accountPropertiesTable)
      .set(updates)
      .where(and(eq(accountPropertiesTable.id, propId), eq(accountPropertiesTable.company_id, companyId)))
      .returning();

    // [building-notes 2026-07-01 → REVERSED 2026-07-07] This used to COPY the
    // building's notes into every future job's per-visit columns
    // (property.notes → jobs.office_notes, property.access_notes → jobs.notes).
    // That's how Jirsa's one-off note from last week ("unit G1" + door code +
    // "fridge, oven") ended up on Jose's job this week labeled "Today's Job
    // Notes — this visit only": anything typed in the building box fanned out
    // to every empty future job, and the copy is indistinguishable from a real
    // per-visit note. Building notes now display LIVE from the property on
    // every surface (my-jobs "Building Access" + the dispatch card's building
    // sections) — same visibility, zero bleed. jobs.notes / jobs.office_notes
    // are per-visit only again. On edit, we UN-copy: future jobs still holding
    // a verbatim copy of the OLD building note get cleared.
    if (prop && notesChanged) {
      try {
        if ("notes" in updates && before?.notes) {
          await db.execute(sql`
            UPDATE jobs SET office_notes = NULL, office_notes_updated_at = NOW(), office_notes_updated_by = ${req.auth!.userId}
             WHERE account_property_id = ${propId} AND company_id = ${companyId}
               AND status = 'scheduled' AND scheduled_date >= CURRENT_DATE
               AND office_notes = ${before.notes}`);
        }
        if ("access_notes" in updates && before?.access_notes) {
          await db.execute(sql`
            UPDATE jobs SET notes = NULL
             WHERE account_property_id = ${propId} AND company_id = ${companyId}
               AND status = 'scheduled' AND scheduled_date >= CURRENT_DATE
               AND notes = ${before.access_notes}`);
        }
      } catch (e) { console.warn("[building-notes] un-copy from jobs failed:", e); }
    }

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
    // [account-batch 2026-07-02] Optionally include scheduled/in-progress visits
    // so the office can deliberately pre-bill upcoming jobs (e.g. a whole week of
    // National Able). Default = completed only.
    const includeScheduled = req.query.include_scheduled === "true";
    // [pre-bill-month 2026-07-03] The recurring engine pre-generates the whole
    // horizon (KMA had 47 future visits out to December), so turning on pre-bill
    // dumps every future job. Optional ?month=YYYY-MM scopes the list to one
    // service month (matches how the office thinks — "bill July's visits"), so
    // she isn't hunting two Ashland rows in a 47-row pile. Applies to the whole
    // query, always ANDed under the cutover floor.
    const month = String(req.query.month || "").trim();
    const monthValid = /^\d{4}-\d{2}$/.test(month);
    let monthFrom: string | null = null;
    let monthTo: string | null = null;
    if (monthValid) {
      const [yy, mm] = month.split("-").map(Number);
      const lastDay = new Date(yy, mm, 0).getDate();
      monthFrom = `${month}-01`;
      monthTo = `${month}-${String(lastDay).padStart(2, "0")}`;
    }
    const jobs = await db
      .select()
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.account_id, id),
          eq(jobsTable.company_id, companyId),
          // [billing-cutover 2026-07-02] Pre-cutover visits were billed + paid in
          // MaidCentral — hide them from this account's Uninvoiced Jobs queue.
          gte(jobsTable.scheduled_date, INVOICE_CUTOVER_DATE),
          // [pre-bill-month 2026-07-03] Optional single-month window.
          monthValid ? gte(jobsTable.scheduled_date, monthFrom!) : undefined,
          monthValid ? lte(jobsTable.scheduled_date, monthTo!) : undefined,
          includeScheduled
            ? inArray(jobsTable.status, ["complete", "scheduled", "in_progress"])
            : eq(jobsTable.status, "complete"),
          // Not already on a per-visit sent/paid invoice.
          notExists(
            db.select({ x: invoicesTable.id })
              .from(invoicesTable)
              .where(and(
                eq(invoicesTable.job_id, jobsTable.id),
                inArray(invoicesTable.status, ["sent", "paid"]),
              ))
          ),
          // [account-batch 2026-07-02] Not already folded into a consolidated
          // account invoice. Account consolidation stores each job_id inside the
          // invoice's line_items (not invoices.job_id), so without this a job
          // would keep showing as "uninvoiced" after consolidation and could be
          // double-billed. A non-void invoice whose line_items contains this
          // job_id means it's already consolidated.
          // [job-ids-preserve 2026-07-23] …as does one whose `job_ids` array
          // names it, which is where a hand-collapsed `quantity: N` line now
          // keeps the ids it used to discard.
          sql`NOT EXISTS (
            SELECT 1 FROM invoices i
             WHERE i.company_id = ${companyId}
               AND i.status <> 'void'
               AND (i.line_items @> jsonb_build_array(jsonb_build_object('job_id', ${jobsTable.id}))
                 OR i.line_items @> jsonb_build_array(jsonb_build_object('job_ids', jsonb_build_array(${jobsTable.id}))))
          )`
        )
      )
      .orderBy(desc(jobsTable.scheduled_date));

    res.json(jobs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch uninvoiced jobs" });
  }
});

// ─── ACCOUNT INVOICES (month-filterable) ──────────────────────────────────────

// GET /api/accounts/:id/invoices?month=YYYY-MM
// [account-invoices-month 2026-07-02] PPM (and other PM accounts) asked to pull
// "all our invoices for any given month." The account page had no way to see its
// GENERATED invoices, let alone filter them. Filter by SERVICE month — the linked
// job's scheduled_date (per-job invoices carry job_id), falling back to the
// invoice's created date for consolidated invoices (job_id null).
router.get("/:id/invoices", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const companyId = req.auth!.companyId;
  const month = String(req.query.month || "").trim();

  try {
    const svcDate = sql<string>`COALESCE((SELECT j.scheduled_date FROM jobs j WHERE j.id = ${invoicesTable.job_id}), ${invoicesTable.created_at}::date)`;
    const conds = [eq(invoicesTable.account_id, id), eq(invoicesTable.company_id, companyId)];
    if (/^\d{4}-\d{2}$/.test(month)) {
      conds.push(sql`to_char(${svcDate}, 'YYYY-MM') = ${month}`);
    }

    const rows = await db
      .select({
        id: invoicesTable.id,
        invoice_number: invoicesTable.invoice_number,
        status: invoicesTable.status,
        // [auto-issue 2026-07-08] sent_at lets the tab label sent-with-no-
        // sent_at as ISSUED (auto-issued at completion, never emailed).
        sent_at: invoicesTable.sent_at,
        total: invoicesTable.total,
        due_date: invoicesTable.due_date,
        created_at: invoicesTable.created_at,
        job_id: invoicesTable.job_id,
        service_date: svcDate,
        line_items: invoicesTable.line_items,
      })
      .from(invoicesTable)
      .where(and(...conds))
      .orderBy(desc(svcDate));

    const total = rows.reduce((s, r) => s + parseFloat((r.total as string) || "0"), 0);
    res.json({ data: rows, count: rows.length, total: total.toFixed(2), month: /^\d{4}-\d{2}$/.test(month) ? month : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list account invoices" });
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

    // [account-batch 2026-07-02] Selectable consolidation. When the office picks
    // specific visits (Mon/Tue/… on National Able), the frontend sends job_ids —
    // consolidate ONLY those. Explicit selection also allows scheduled/future
    // visits (deliberate pre-billing), so we don't force status='complete' on it.
    // With no job_ids, keep the legacy "all uninvoiced completed jobs" behavior.
    const selectedJobIds: number[] = Array.isArray(req.body?.job_ids)
      ? req.body.job_ids.map((x: any) => parseInt(String(x), 10)).filter((n: number) => Number.isInteger(n) && n > 0)
      : [];

    // [per-job-invoices 2026-07-02] Turnovers bill INDIVIDUALLY — one invoice per
    // job (each billed to the account), not folded into the monthly consolidated
    // bill. Common-areas keep the default consolidate path. Same dedup guards, so
    // a job can't land on both an individual and a consolidated invoice.
    const separate = req.body?.separate === true;

    const uninvoicedJobs = await db
      .select()
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.account_id, id),
          eq(jobsTable.company_id, companyId),
          selectedJobIds.length > 0
            ? inArray(jobsTable.id, selectedJobIds)
            : eq(jobsTable.status, "complete"),
          // Never bill a cancelled visit, even if explicitly selected.
          sql`${jobsTable.status} <> 'cancelled'`,
          // Not already on a per-visit sent/paid invoice.
          notExists(
            db.select({ x: invoicesTable.id })
              .from(invoicesTable)
              .where(and(
                eq(invoicesTable.job_id, jobsTable.id),
                inArray(invoicesTable.status, ["sent", "paid"]),
              ))
          ),
          // Not already folded into a consolidated account invoice (dedup —
          // matches the uninvoiced-jobs list guard; prevents double-billing).
          // [job-ids-preserve 2026-07-23] `job_ids` is the second line-item
          // carrier — the ids a hand-collapsed `quantity: N` line would otherwise
          // have dropped. Both shapes must be checked or a consolidated visit
          // reads as uninvoiced and gets billed twice.
          sql`NOT EXISTS (
            SELECT 1 FROM invoices i
             WHERE i.company_id = ${companyId}
               AND i.status <> 'void'
               AND (i.line_items @> jsonb_build_array(jsonb_build_object('job_id', ${jobsTable.id}))
                 OR i.line_items @> jsonb_build_array(jsonb_build_object('job_ids', jsonb_build_array(${jobsTable.id}))))
          )`
        )
      )
      .orderBy(jobsTable.scheduled_date);

    if (uninvoicedJobs.length === 0) {
      return res.json({ ok: true, invoice: null, message: "No uninvoiced jobs found" });
    }

    // [building-names 2026-07-02] property id → building name, so lines read by
    // building ("Lincoln Tower — Ppm Turnover — 2026-07-01") not "Prop #47".
    const propRows = await db
      .select({ id: accountPropertiesTable.id, name: accountPropertiesTable.property_name })
      .from(accountPropertiesTable)
      .where(eq(accountPropertiesTable.account_id, id));
    const propName = new Map(propRows.map((p) => [p.id, p.name]));

    const lineItems = uninvoicedJobs.map((j) => {
      const billedAmt = j.billed_amount ? parseFloat(j.billed_amount as string) : parseFloat(j.base_fee ?? "0");
      const svcLabel = toLabel(j.service_type ?? "cleaning");
      const bldg = j.account_property_id ? (propName.get(j.account_property_id) || `Prop #${j.account_property_id}`) : "";
      return {
        description: `${bldg ? bldg + " — " : ""}${svcLabel} — ${j.scheduled_date}`,
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

    // Individual mode: one draft invoice per job, each billed to the account.
    if (separate) {
      const perJobPayloads = lineItems.map((li, idx) => ({
        company_id: companyId,
        account_id: id,
        client_id: null as null | number,
        // Link the single job so service date resolves (month filter, list view)
        // and it matches the auto-draft-per-job path in ensure-invoice.ts.
        job_id: li.job_id,
        invoice_number: `ACC-${id}-${li.job_id}-${Date.now() + idx}`,
        status: "draft" as const,
        line_items: [li],
        subtotal: li.total.toFixed(2),
        tips: "0",
        total: li.total.toFixed(2),
        due_date: dueDateStr,
        payment_terms: termsLabel,
        created_by: req.auth!.userId,
      }));
      if (preview) {
        return res.json({ ok: true, preview: true, separate: true, invoices: perJobPayloads, jobs_count: perJobPayloads.length });
      }
      const created = [];
      for (const p of perJobPayloads) {
        const [inv] = await db.insert(invoicesTable).values(p).returning();
        created.push(inv);
      }
      return res.status(201).json({ ok: true, separate: true, invoices: created, invoices_created: created.length });
    }

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

// ─── CONVERT CLIENT(S) → ACCOUNT ──────────────────────────────────────────────
// [client-to-account 2026-07-03] Move commercial "client" records into the
// Account model. Creates (or reuses) an account, adds each property, re-points
// every job + recurring schedule from the source client records to the account
// property, creates a billing contact, and soft-retires the source client
// records. Historical invoices keep their client_id link (untouched), so past
// billing history is preserved. ?preview=true (or body.preview) = read-only
// plan (counts only, no writes). Execute wraps all writes in ONE transaction so
// a failure rolls the whole conversion back.
//
// Body: {
//   preview?: boolean,
//   account: { id?: number, name?: string, account_type?, invoice_frequency?, payment_terms_days? },
//   contact?: { name?, email?, phone?, from_client_id?: number },
//   properties: [{ property_name?, address, city?, state?, zip?, source_client_ids: number[] }],
//   retire_client_ids?: number[],   // extra empty duplicates to soft-retire
// }
router.post("/convert", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  const companyId = req.auth!.companyId as number;
  const preview = req.query.preview === "true" || req.body?.preview === true;
  const body = req.body ?? {};
  const acctIn = body.account ?? {};
  const props: any[] = Array.isArray(body.properties) ? body.properties : [];
  const retireIds: number[] = (Array.isArray(body.retire_client_ids) ? body.retire_client_ids : [])
    .map((x: any) => parseInt(String(x), 10)).filter((n: number) => Number.isInteger(n));

  // ── validate ──────────────────────────────────────────────────────────────
  if (!acctIn.id && !acctIn.name) {
    return res.status(400).json({ error: "Bad Request", message: "account.id (reuse) or account.name (create) is required" });
  }
  if (props.length === 0) {
    return res.status(400).json({ error: "Bad Request", message: "at least one property is required" });
  }
  for (const p of props) {
    if (!Array.isArray(p.source_client_ids) || p.source_client_ids.length === 0) {
      return res.status(400).json({ error: "Bad Request", message: `each entry needs source_client_ids` });
    }
    // [attach-mode 2026-07-03] A property entry can either CREATE a property
    // (has address), reference an EXISTING one (existing_property_id), or
    // ATTACH-ONLY (neither → jobs re-point to the account with property=null,
    // exactly like existing account jobs). Used for accounts that already have
    // their properties (PPM/KMA/Cucci/Halper) so we don't duplicate them.
  }
  const allSourceIds = [...new Set(props.flatMap((p) => p.source_client_ids.map((x: any) => parseInt(String(x), 10))))].filter((n) => Number.isInteger(n));

  try {
    // ── validate the account + source clients all belong to this company ──────
    if (acctIn.id) {
      const [a] = await db.select({ id: accountsTable.id }).from(accountsTable)
        .where(and(eq(accountsTable.id, acctIn.id), eq(accountsTable.company_id, companyId)));
      if (!a) return res.status(404).json({ error: "Not Found", message: "account not found" });
    }
    const srcClients = await db.select({
        id: clientsTable.id, first_name: clientsTable.first_name, last_name: clientsTable.last_name,
        email: clientsTable.email, phone: clientsTable.phone,
      }).from(clientsTable)
      .where(and(inArray(clientsTable.id, [...allSourceIds, ...retireIds].length ? [...allSourceIds, ...retireIds] : [-1]), eq(clientsTable.company_id, companyId)));
    const foundIds = new Set(srcClients.map((c) => c.id));
    const missing = [...allSourceIds, ...retireIds].filter((id) => !foundIds.has(id));
    if (missing.length) {
      return res.status(400).json({ error: "Bad Request", message: `client(s) not in this company: ${missing.join(", ")}` });
    }

    // ── PREVIEW: read-only counts, no writes ──────────────────────────────────
    if (preview) {
      const planProps = [];
      let totalJobs = 0, totalRecurring = 0;
      for (const p of props) {
        const ids = p.source_client_ids.map((x: any) => parseInt(String(x), 10));
        const [jc] = await db.select({ n: sql<number>`count(*)::int` }).from(jobsTable)
          .where(and(eq(jobsTable.company_id, companyId), inArray(jobsTable.client_id, ids)));
        const [rc] = await db.select({ n: sql<number>`count(*)::int` }).from(recurringSchedulesTable)
          .where(and(eq(recurringSchedulesTable.company_id, companyId), inArray(recurringSchedulesTable.customer_id, ids)));
        totalJobs += jc?.n ?? 0; totalRecurring += rc?.n ?? 0;
        planProps.push({ address: p.address, source_client_ids: ids, jobs: jc?.n ?? 0, recurring_schedules: rc?.n ?? 0 });
      }
      return res.json({
        ok: true, preview: true,
        account: acctIn.id ? { reuse: acctIn.id } : { create: acctIn.name },
        properties: planProps,
        retire_client_ids: retireIds,
        totals: { properties: props.length, jobs_repointed: totalJobs, recurring_repointed: totalRecurring, clients_retired: allSourceIds.length + retireIds.length },
      });
    }

    // ── EXECUTE: one transaction ──────────────────────────────────────────────
    const result = await db.transaction(async (tx) => {
      // 1. account
      let accountId = acctIn.id as number | undefined;
      if (!accountId) {
        const [created] = await tx.insert(accountsTable).values({
          company_id: companyId,
          account_name: acctIn.name,
          account_type: acctIn.account_type ?? "property_management",
          invoice_frequency: acctIn.invoice_frequency ?? "per_job",
          payment_method: acctIn.payment_method ?? "invoice_only",
          payment_terms_days: acctIn.payment_terms_days ?? 0,
        }).returning({ id: accountsTable.id });
        accountId = created.id;
      }

      let jobsMoved = 0, recurringMoved = 0;
      const propIds: number[] = [];
      for (const p of props) {
        const ids = p.source_client_ids.map((x: any) => parseInt(String(x), 10));
        // Resolve the target property id: existing → create → attach-only(null).
        let propId: number | null = null;
        if (p.existing_property_id) {
          const [ep] = await tx.select({ id: accountPropertiesTable.id }).from(accountPropertiesTable)
            .where(and(eq(accountPropertiesTable.id, Number(p.existing_property_id)), eq(accountPropertiesTable.account_id, accountId!), eq(accountPropertiesTable.company_id, companyId)));
          if (!ep) throw new Error(`existing_property_id ${p.existing_property_id} not on account ${accountId}`);
          propId = ep.id;
        } else if (p.address && String(p.address).trim() !== "") {
          const [prop] = await tx.insert(accountPropertiesTable).values({
            account_id: accountId!, company_id: companyId,
            property_name: p.property_name ?? null,
            address: p.address, city: p.city ?? null, state: p.state ?? null, zip: p.zip ?? null,
            client_id: ids[0] ?? null,
          }).returning({ id: accountPropertiesTable.id });
          propId = prop.id;
        }
        // attach-only (propId stays null): jobs re-point to the account with no
        // specific property, exactly like existing account jobs.
        if (propId != null) propIds.push(propId);
        // re-point jobs
        const jm = await tx.update(jobsTable)
          .set({ account_id: accountId!, account_property_id: propId, client_id: null })
          .where(and(eq(jobsTable.company_id, companyId), inArray(jobsTable.client_id, ids)))
          .returning({ id: jobsTable.id });
        jobsMoved += jm.length;
        // re-point recurring schedules (keep customer_id; set account fields)
        const rm = await tx.update(recurringSchedulesTable)
          .set({ account_id: accountId!, account_property_id: propId })
          .where(and(eq(recurringSchedulesTable.company_id, companyId), inArray(recurringSchedulesTable.customer_id, ids)))
          .returning({ id: recurringSchedulesTable.id });
        recurringMoved += rm.length;
      }

      // 2. billing contact (from explicit body.contact or the first source client)
      const c = body.contact ?? {};
      const fromId = c.from_client_id ?? props[0].source_client_ids[0];
      const fromClient = srcClients.find((s) => s.id === parseInt(String(fromId), 10));
      const contactName = c.name || (fromClient ? `${fromClient.first_name ?? ""} ${fromClient.last_name ?? ""}`.trim() : "") || acctIn.name || "Billing contact";
      await tx.insert(accountContactsTable).values({
        account_id: accountId!, company_id: companyId,
        name: contactName,
        email: c.email ?? fromClient?.email ?? null,
        phone: c.phone ?? fromClient?.phone ?? null,
        is_primary: true, receives_invoices: true,
      });

      // 3. soft-retire ALL source + extra dup client records (invoice history stays via client_id)
      const toRetire = [...new Set([...allSourceIds, ...retireIds])];
      if (toRetire.length) {
        await tx.update(clientsTable).set({ is_active: false })
          .where(and(eq(clientsTable.company_id, companyId), inArray(clientsTable.id, toRetire)));
      }

      return { account_id: accountId, property_ids: propIds, jobs_repointed: jobsMoved, recurring_repointed: recurringMoved, clients_retired: toRetire.length };
    });

    console.log(`[convert] account ${result.account_id} — ${result.jobs_repointed} jobs, ${result.recurring_repointed} schedules re-pointed, ${result.clients_retired} clients retired (by user ${req.auth!.userId})`);
    return res.status(201).json({ ok: true, ...result });
  } catch (err: any) {
    console.error("[convert] error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err?.message || "Conversion failed" });
  }
});

// ─── LEGACY CONSOLIDATE INVOICES ─────────────────────────────────────────────

// POST /api/accounts/:id/consolidate-invoices  (redirects to generate-invoice for backwards compat)
router.post("/:id/consolidate-invoices", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  req.url = `/${req.params.id}/generate-invoice`;
  res.redirect(307, req.url);
});

export default router;
