import { Router } from "express";
import { db } from "@workspace/db";
import { quotesTable, clientsTable, pricingScopesTable, recurringSchedulesTable, usersTable } from "@workspace/db/schema";
import { eq, and, desc, count, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { getBranchByZip } from "../lib/branchRouter";
import { randomBytes } from "crypto";
import { generateJobsFromSchedule, DAYS_AHEAD } from "../lib/recurring-jobs.js";
import { persistJobAddOns } from "./jobs.js";

const router = Router();

// [quote-convert-stickiness 2026-06-10] Map the quote's `addons` jsonb
// (addon_breakdown rows: { id: pricing_addons.id, name, amount, price_type })
// into the shape persistJobAddOns expects. The convert previously dropped
// every sold add-on on the floor — the booked job had no job_add_ons rows, so
// the tech card's "Services this visit", the edit-job modal, and invoicing all
// lost the extras the office sold on the quote.
function quoteAddonsToJobAddOns(addons: unknown): { pricing_addon_id?: number; qty: number; unit_price?: number; subtotal?: number }[] {
  if (!Array.isArray(addons)) return [];
  return addons
    .map((a: any) => ({
      pricing_addon_id: Number(a?.id) || undefined,
      qty: 1,
      unit_price: a?.amount != null ? Number(a.amount) : undefined,
      subtotal: a?.amount != null ? Number(a.amount) : undefined,
    }))
    .filter(a => a.pricing_addon_id);
}

async function getQuoteWithDetails(id: number, companyId: number) {
  const [quote] = await db
    .select({
      id: quotesTable.id,
      company_id: quotesTable.company_id,
      client_id: quotesTable.client_id,
      lead_name: quotesTable.lead_name,
      lead_email: quotesTable.lead_email,
      lead_phone: quotesTable.lead_phone,
      address: quotesTable.address,
      service_type: quotesTable.service_type,
      frequency: quotesTable.frequency,
      estimated_hours: quotesTable.estimated_hours,
      base_price: quotesTable.base_price,
      total_price: quotesTable.total_price,
      discount_amount: quotesTable.discount_amount,
      discount_code: quotesTable.discount_code,
      status: quotesTable.status,
      sent_at: quotesTable.sent_at,
      viewed_at: quotesTable.viewed_at,
      accepted_at: quotesTable.accepted_at,
      booked_job_id: quotesTable.booked_job_id,
      notes: quotesTable.notes,
      created_by: quotesTable.created_by,
      created_at: quotesTable.created_at,
      scope_id: quotesTable.scope_id,
      pricing_method: quotesTable.pricing_method,
      addons: quotesTable.addons,
      bedrooms: quotesTable.bedrooms,
      bathrooms: quotesTable.bathrooms,
      half_baths: quotesTable.half_baths,
      sqft: quotesTable.sqft,
      dirt_level: quotesTable.dirt_level,
      pets: quotesTable.pets,
      special_instructions: quotesTable.special_instructions,
      internal_memo: quotesTable.internal_memo,
      client_notes: quotesTable.client_notes,
      call_notes: quotesTable.call_notes,
      manual_hours: quotesTable.manual_hours,
      office_notes: quotesTable.office_notes,
      manual_adjustments: quotesTable.manual_adjustments,
      expires_at: quotesTable.expires_at,
      sign_token: quotesTable.sign_token,
      client_first: clientsTable.first_name,
      client_last: clientsTable.last_name,
      client_email: clientsTable.email,
      client_phone: clientsTable.phone,
      scope_name: pricingScopesTable.name,
      scope_category: pricingScopesTable.scope_group,
    })
    .from(quotesTable)
    .leftJoin(clientsTable, eq(quotesTable.client_id, clientsTable.id))
    .leftJoin(pricingScopesTable, eq(quotesTable.scope_id, pricingScopesTable.id))
    .where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, companyId)))
    .limit(1);
  return quote;
}

router.get("/stats", requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    // NOTE: quotes are NOT branch-columned (the quotes table has no branch_id),
    // so we do NOT filter by branch here. A prior branch_id filter referenced a
    // nonexistent column and made the whole query fail → empty list + KPIs at 0
    // whenever a branch was selected (which single-branch tenants always do).
    const statsConds: any[] = [eq(quotesTable.company_id, req.auth!.companyId)];

    const allQuotes = await db.select({ status: quotesTable.status, accepted_at: quotesTable.accepted_at, booked_job_id: quotesTable.booked_job_id })
      .from(quotesTable)
      .where(and(...statsConds));

    const total = allQuotes.length;
    const pending = allQuotes.filter(q => q.status === "sent" || q.status === "viewed").length;
    const accepted_this_month = allQuotes.filter(q => q.status === "accepted" && q.accepted_at && new Date(q.accepted_at) >= monthStart).length;
    const converted = allQuotes.filter(q => q.status === "booked" || q.booked_job_id).length;

    return res.json({ total, pending, accepted_this_month, converted });
  } catch (err) {
    console.error("Quote stats error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const { status, client_id } = req.query;
    const conditions: any[] = [eq(quotesTable.company_id, req.auth!.companyId)];
    if (status && status !== "all") conditions.push(eq(quotesTable.status, status as string));
    if (client_id) conditions.push(eq(quotesTable.client_id, parseInt(client_id as string)));
    // No branch filter: quotes have no branch_id column. Filtering by it
    // referenced a nonexistent column and broke the list whenever a branch was
    // selected (see /stats note above).

    const quotes = await db
      .select({
        id: quotesTable.id,
        company_id: quotesTable.company_id,
        client_id: quotesTable.client_id,
        lead_name: quotesTable.lead_name,
        lead_email: quotesTable.lead_email,
        address: quotesTable.address,
        frequency: quotesTable.frequency,
        estimated_hours: quotesTable.estimated_hours,
        base_price: quotesTable.base_price,
        total_price: quotesTable.total_price,
        discount_amount: quotesTable.discount_amount,
        status: quotesTable.status,
        sent_at: quotesTable.sent_at,
        accepted_at: quotesTable.accepted_at,
        created_at: quotesTable.created_at,
        scope_id: quotesTable.scope_id,
        bedrooms: quotesTable.bedrooms,
        bathrooms: quotesTable.bathrooms,
        sqft: quotesTable.sqft,
        client_first: clientsTable.first_name,
        client_last: clientsTable.last_name,
        client_email: clientsTable.email,
        scope_name: pricingScopesTable.name,
        // [quote-breakdown 2026-06-08] who quoted + residential/commercial split.
        created_by: quotesTable.created_by,
        quoted_by_first: usersTable.first_name,
        quoted_by_last: usersTable.last_name,
        client_type: clientsTable.client_type,
      })
      .from(quotesTable)
      .leftJoin(clientsTable, eq(quotesTable.client_id, clientsTable.id))
      .leftJoin(pricingScopesTable, eq(quotesTable.scope_id, pricingScopesTable.id))
      .leftJoin(usersTable, eq(quotesTable.created_by, usersTable.id))
      .where(and(...conditions))
      .orderBy(desc(quotesTable.created_at));

    return res.json(quotes);
  } catch (err) {
    console.error("List quotes error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const quote = await getQuoteWithDetails(parseInt(req.params.id), req.auth!.companyId);
    if (!quote) return res.status(404).json({ error: "Not Found" });
    return res.json(quote);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const {
      client_id, lead_name, lead_email, lead_phone, address,
      scope_id, pricing_method, frequency, estimated_hours, manual_hours,
      base_price, total_price, discount_amount, discount_code, addons,
      bedrooms, bathrooms, half_baths, sqft, dirt_level, pets,
      special_instructions, internal_memo, client_notes, notes, status,
      unit_suite, referral_source, office_notes, manual_adjustments,
    } = req.body;

    const scope = scope_id ? await db.select().from(pricingScopesTable).where(eq(pricingScopesTable.id, scope_id)).limit(1) : null;

    // Resolve branch from client zip for branch tagging
    let quoteBranch = "oak_lawn";
    if (client_id) {
      try {
        const [cl] = await db.select({ zip: clientsTable.zip }).from(clientsTable).where(eq(clientsTable.id, client_id)).limit(1);
        if (cl?.zip) quoteBranch = getBranchByZip(cl.zip).branch;
      } catch {}
    }

    const [q] = await db.insert(quotesTable).values({
      company_id: req.auth!.companyId,
      client_id: client_id || null,
      lead_name, lead_email, lead_phone, address,
      service_type: scope?.[0]?.name || null,
      frequency, estimated_hours: estimated_hours ? String(estimated_hours) : null,
      manual_hours: manual_hours ? String(manual_hours) : null,
      base_price: base_price ? String(base_price) : null,
      total_price: total_price ? String(total_price) : null,
      discount_amount: discount_amount ? String(discount_amount) : "0",
      discount_code: discount_code || null,
      addons: addons || [],
      scope_id: scope_id || null,
      pricing_method: pricing_method || scope?.[0]?.pricing_method || null,
      bedrooms, bathrooms, half_baths, sqft,
      dirt_level: dirt_level || "standard",
      pets: pets || 0,
      special_instructions, internal_memo, client_notes, notes,
      office_notes: office_notes || null,
      manual_adjustments: manual_adjustments || [],
      unit_suite: unit_suite || null,
      referral_source: referral_source || null,
      address_verified: req.body.address_verified === true,
      photo_urls: req.body.photo_urls || [],
      status: status || "draft",
      created_by: req.auth!.userId,
      branch: quoteBranch,
    } as any).returning();

    logAudit(req, "CREATE", "quote", q.id, null, { status: q.status, total_price: q.total_price });
    // Quote→lead: find-or-create the lead + link it (non-blocking).
    import("../lib/lead-sync.js").then(({ upsertLeadForQuote }) =>
      upsertLeadForQuote(req.auth!.companyId, q).catch(() => {})).catch(() => {});
    // [multi-frequency] snapshot the comparison tiers (non-blocking).
    import("../lib/quote-pricing.js").then(({ snapshotQuoteFrequencyOptions }) =>
      snapshotQuoteFrequencyOptions(req.auth!.companyId!, q.id).catch(() => {})).catch(() => {});
    return res.status(201).json(q);
  } catch (err) {
    console.error("Create quote error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const allowed = [
      "status", "base_price", "total_price", "estimated_hours", "manual_hours",
      "notes", "client_notes", "internal_memo", "special_instructions", "call_notes",
      "frequency", "scope_id", "pricing_method", "addons",
      "discount_code", "discount_amount", "bedrooms", "bathrooms", "half_baths",
      "sqft", "dirt_level", "pets", "sent_at", "viewed_at", "accepted_at",
      "lead_name", "lead_email", "lead_phone", "address", "client_id",
      "alternate_options", "zone_override", "unit_suite", "referral_source", "address_verified",
      "photo_urls", "office_notes", "manual_adjustments",
    ];
    const updates: any = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        if (["base_price", "total_price", "estimated_hours", "manual_hours", "discount_amount"].includes(k)) {
          updates[k] = req.body[k] !== null ? String(req.body[k]) : null;
        } else {
          updates[k] = req.body[k];
        }
      }
    }

    const [q] = await db.update(quotesTable).set(updates)
      .where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, req.auth!.companyId)))
      .returning();

    if (!q) return res.status(404).json({ error: "Not found" });
    const auditAction = updates.status === "draft" ? "DRAFT_SAVED" : "UPDATE";
    logAudit(req, auditAction, "quote", id, null, { status: q.status, total_price: q.total_price });
    // Keep the linked lead's name/contact/scope in step with quote edits. The
    // lead is often created bare during draft autosave (empty fields); this
    // enriches it once the office fills the quote in. Non-blocking.
    import("../lib/lead-sync.js").then(({ upsertLeadForQuote }) =>
      upsertLeadForQuote(req.auth!.companyId, q).catch(() => {})).catch(() => {});
    // [multi-frequency] re-snapshot tiers when scope/sqft/add-ons may have changed.
    import("../lib/quote-pricing.js").then(({ snapshotQuoteFrequencyOptions }) =>
      snapshotQuoteFrequencyOptions(req.auth!.companyId!, id).catch(() => {})).catch(() => {});
    return res.json(q);
  } catch (err) {
    console.error("Update quote error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Quote PDF ────────────────────────────────────────────────────────────────
// Branded, downloadable PDF of the quote — reuses the estimate PDF renderer so
// quotes and estimates look identical to the customer. Inline disposition.
router.get("/:id/pdf", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    const [q] = await db
      .select({
        client_id: quotesTable.client_id,
        lead_name: quotesTable.lead_name,
        address: quotesTable.address,
        service_type: quotesTable.service_type,
        frequency: quotesTable.frequency,
        base_price: quotesTable.base_price,
        total_price: quotesTable.total_price,
        discount_amount: quotesTable.discount_amount,
        status: quotesTable.status,
        notes: quotesTable.notes,
        created_at: quotesTable.created_at,
        client_first: clientsTable.first_name,
        client_last: clientsTable.last_name,
      })
      .from(quotesTable)
      .leftJoin(clientsTable, eq(quotesTable.client_id, clientsTable.id))
      .where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, companyId)))
      .limit(1);
    if (!q) return res.status(404).json({ error: "Not Found" });

    const co = await db.execute(sql`SELECT name, logo_url FROM companies WHERE id = ${companyId} LIMIT 1`);
    const company: any = (co as any).rows[0] ?? {};
    let logo: Buffer | null = null;
    if (company.logo_url && /^https?:\/\//i.test(company.logo_url)) {
      try {
        const r = await fetch(company.logo_url);
        if (r.ok && /image\/(png|jpe?g)/i.test(r.headers.get("content-type") || "")) logo = Buffer.from(await r.arrayBuffer());
      } catch { logo = null; }
    }

    const total = Number(q.total_price ?? q.base_price ?? 0);
    const discount = Number(q.discount_amount ?? 0);
    const contactName = [q.client_first, q.client_last].filter(Boolean).join(" ") || q.lead_name || null;
    const svcLabel = (q.service_type || "Cleaning Service").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

    const { renderEstimatePdf } = await import("../lib/estimate-pdf.js");
    const pdf = await renderEstimatePdf({
      companyName: company.name || "Quote",
      logo,
      estimateNumber: `Q-${id}`,
      status: q.status || "draft",
      title: svcLabel,
      introNote: null,
      contactName,
      propertyName: null,
      serviceAddress: q.address || null,
      billingMode: "flat",
      flatPriceUnit: q.frequency && q.frequency !== "one_time" ? "visit" : "total",
      scopeNote: q.notes || null,
      items: [{ name: svcLabel, pricing_type: "flat", frequency: q.frequency || null, quantity: 1, unit_rate: total, amount: total }],
      subtotal: total + discount,
      discount,
      total,
      terms: null,
      validUntil: null,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="quote-${id}.pdf"`);
    return res.end(pdf);
  } catch (err) {
    console.error("Quote PDF error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to render quote PDF" });
  }
});

router.post("/:id/send", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const [q] = await db.update(quotesTable)
      .set({ status: "sent", sent_at: new Date() })
      .where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, companyId)))
      .returning();
    if (!q) return res.status(404).json({ error: "Not found" });

    // Ensure a public sign_token exists so the customer-facing quote page
    // (app.qleno.com/estimate/<token>, served by the estimates public endpoint
    // with a quote fallback) resolves instead of 404ing. Generated once and
    // reused; idempotent on re-send.
    if (!(q as any).sign_token) {
      const tok = randomBytes(24).toString("hex");
      await db.execute(sql`UPDATE quotes SET sign_token = ${tok} WHERE id = ${id}`);
      (q as any).sign_token = tok;
    }
    console.log(`[QUOTE SENT] id=${id} lead_email=${q.lead_email}`);
    // [multi-frequency] Snapshot the comparison tiers BEFORE the cadence sends
    // the link, so the public page has stable options when the customer opens it.
    try {
      const { snapshotQuoteFrequencyOptions } = await import("../lib/quote-pricing.js");
      await snapshotQuoteFrequencyOptions(companyId!, id);
    } catch { /* non-fatal — page falls back to single total */ }
    // Enroll in quote_followup sequence (non-blocking)
    import("../services/followUpService.js").then(({ enrollForQuoteSent }) => {
      enrollForQuoteSent(
        companyId,
        id,
        (q as any).client_id ?? null,
        (q as any).lead_name?.split(" ")[0] || "",
        (q as any).lead_email ?? null,
        (q as any).lead_phone ?? null,
      ).catch(() => {});
    });
    // Quote→lead: advance the lead to Quoted + link the enrollment (non-blocking).
    import("../lib/lead-sync.js").then(async ({ upsertLeadForQuote, advanceLeadStage, linkEnrollmentToLead }) => {
      const leadId = await upsertLeadForQuote(companyId, q);
      if (leadId) {
        await advanceLeadStage(companyId, leadId, "quoted", { quoteAmount: (q as any).total_price ?? (q as any).base_price ?? null, userId: req.auth!.userId });
        await linkEnrollmentToLead(companyId, id, leadId);
      }
    }).catch(() => {});
    // NOTE: the quote email + SMS are delivered by the quote-followup CADENCE
    // (touch 1 = the MaidCentral-styled quote email, touch 2 = the quote SMS),
    // enrolled just above via enrollForQuoteSent. The old immediate `quote_sent`
    // notification was removed — it was the source of the broken Replit link and
    // the wrong (global-env Oak Lawn) SMS number, and it double-sent on top of
    // cadence touch 1. The cadence renders the link from sign_token via the
    // per-tenant sender (resolveSender), so this consolidates quote comms onto a
    // single correct path.
    return res.json({ success: true, quote: q });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/accept", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [q] = await db.update(quotesTable)
      .set({ status: "accepted", accepted_at: new Date() })
      .where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, req.auth!.companyId)))
      .returning();
    if (!q) return res.status(404).json({ error: "Not found" });
    // Stop quote_followup enrollment (non-blocking)
    import("../services/followUpService.js").then(({ stopEnrollmentsForQuote }) => {
      stopEnrollmentsForQuote(id, "booked").catch(() => {});
    });
    return res.json({ success: true, quote: q });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/convert", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const { scheduled_date, scheduled_time, assigned_user_id, team_user_ids } = req.body || {};

    // Mark quote as booked
    const [q] = await db.update(quotesTable)
      .set({ status: "booked" })
      .where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, companyId)))
      .returning();
    if (!q) return res.status(404).json({ error: "Not found" });

    // Create the actual job
    const jobDate = scheduled_date || new Date().toISOString().split("T")[0];
    // Map scope name → service_type enum value
    const SCOPE_TO_ENUM: Record<string, string> = {
      "deep clean": "deep_clean",
      "standard clean": "standard_clean",
      "move in / move out": "move_out",
      "move in/move out": "move_out",
      "one-time standard clean": "standard_clean",
      "recurring cleaning": "recurring",
      "recurring cleaning - weekly": "recurring",
      "recurring cleaning - every 2 weeks": "recurring",
      "recurring cleaning - every 4 weeks": "recurring",
      "hourly deep clean": "deep_clean",
      "hourly standard cleaning": "standard_clean",
      // (#11) Hourly Move In/Out → move_out enum (the clean TYPE); the hourly
      // billing is carried by the scope's method + the quote's hours, exactly
      // like "hourly deep clean" → deep_clean. Without this it fell back to
      // standard_clean and the office "didn't recognize the hourly option".
      "hourly move in / move out": "move_out",
      "hourly move in/move out": "move_out",
      "commercial cleaning": "office_cleaning",
      "ppm turnover": "ppm_turnover",
      "ppm common areas": "common_areas",
      "multi-unit common areas": "common_areas",
    };
    let serviceType = "standard_clean";
    if (q.scope_id) {
      const scopeResult = await db.execute(sql`SELECT name FROM pricing_scopes WHERE id = ${q.scope_id} LIMIT 1`);
      const scopeName = ((scopeResult.rows[0] as any)?.name || "").toLowerCase().trim();
      serviceType = SCOPE_TO_ENUM[scopeName] || "standard_clean";
    }

    // [multi-frequency] Book the customer's CHOSEN tier. Override precedence:
    // request body (office picks on convert) → quote.selected_frequency
    // (customer's pick on the public page) → quote.frequency (stored default).
    // Price/hours come from the snapshot so the booked figures match exactly
    // what the customer saw. Decision (d): the FIRST visit is the one-time price;
    // recurring visits use the lower per-visit recurring price.
    const SNAP_KEY: Record<string, string> = {
      onetime: "onetime", one_time: "onetime", on_demand: "onetime",
      weekly: "weekly", biweekly: "biweekly", every_2_weeks: "biweekly",
      monthly: "monthly", every_4_weeks: "monthly",
    };
    // selected_frequency + frequency_options live on columns added via raw ALTER
    // (not in the drizzle schema), so the updated `q` above doesn't carry them —
    // read them with raw SQL.
    const snap = (await db.execute(sql`SELECT selected_frequency, frequency_options FROM quotes WHERE id = ${id} AND company_id = ${companyId} LIMIT 1`)).rows[0] as any;
    const chosenRaw = String(req.body?.frequency || snap?.selected_frequency || q.frequency || "onetime").toLowerCase().replace(/[- ]/g, "_");
    const snapKey = SNAP_KEY[chosenRaw] || "onetime";
    const snapOptions = Array.isArray(snap?.frequency_options) ? snap.frequency_options : [];
    const chosenOpt = snapOptions.find((o: any) => o.frequency === snapKey) || null;
    const FREQ_MAP: Record<string, string> = {
      onetime: "on_demand", weekly: "weekly", biweekly: "biweekly", monthly: "monthly",
    };
    const jobFreq = FREQ_MAP[snapKey] || "on_demand";
    // Booked price: recurring tiers bill the recurring per-visit rate on the
    // schedule; the first job gets the one-time first-visit price. One-time bills
    // the one-time price. Falls back to the quote's stored total when no snapshot.
    const fallbackFee = q.total_price != null ? Number(q.total_price) : (q.base_price != null ? Number(q.base_price) : null);
    const recurringFee = chosenOpt ? (snapKey === "onetime" ? chosenOpt.first_visit_price : chosenOpt.recurring_price) : fallbackFee;
    const firstVisitFee = chosenOpt ? chosenOpt.first_visit_price : fallbackFee;
    const chosenHours = chosenOpt ? Number(chosenOpt.hours) : (q.estimated_hours != null ? Number(q.estimated_hours) : null);

    // [recurring-convert-fix 2026-06-05] A recurring quote must create a
    // recurring_schedule and GENERATE THE SERIES — not a single job. The
    // convert previously inserted one job with frequency='weekly' and stopped,
    // so "scheduling a recurrence" only ever produced the first visit
    // (Maribel's bug). When the quote is recurring and tied to a client, build
    // the schedule and synchronously generate the next 90 days (first
    // occurrence included). This calls generateJobsFromSchedule directly, so it
    // works regardless of the RECURRING_ENGINE_ENABLED cron flag.
    // [multi-frequency] Resolve/materialize the client UP FRONT so a recurring
    // choice on a lead-only quote creates a schedule (not a one-off) and the
    // booking confirmation has contact info. Find by email/phone, else create.
    let clientId: number | null = q.client_id || null;
    // [convert-client-fix 2026-06-16] (#3) Previously a client was only
    // materialized when the quote had an email OR phone. The office form does
    // not require either — a new lead can convert with just a name and/or
    // address. In that case clientId stayed null, the job was inserted with
    // client_id=null and the address as raw text, and the customer's
    // name/address/email were never saved as a client. Broaden the gate to any
    // identifying field (name or address too); email/phone still drive dedupe,
    // and a name-only lead falls through to a fresh insert.
    const _hasIdentity = (q as any).lead_email || (q as any).lead_phone || (q as any).lead_name || (q as any).address;
    if (!clientId && _hasIdentity) {
      const emailLc = (q as any).lead_email ? String((q as any).lead_email).toLowerCase().trim() : null;
      const phone10 = String((q as any).lead_phone || "").replace(/\D/g, "").slice(-10) || null;
      // Dedupe only when we have an email or phone to match on; a name-only
      // lead has no reliable key, so it always inserts a fresh client.
      const match = (emailLc || phone10) ? await db.execute(sql`
        SELECT id FROM clients WHERE company_id = ${companyId} AND (
          (${emailLc}::text IS NOT NULL AND lower(email) = ${emailLc}) OR
          (${phone10}::text IS NOT NULL AND right(regexp_replace(coalesce(phone,''),'\\D','','g'),10) = ${phone10})
        ) ORDER BY id DESC LIMIT 1`) : { rows: [] as any[] };
      clientId = (match.rows[0] as any)?.id ?? null;
      if (!clientId) {
        const np = String((q as any).lead_name ?? "").trim().split(/\s+/).filter(Boolean);
        const cIns = await db.execute(sql`
          INSERT INTO clients (company_id, first_name, last_name, email, phone, address)
          VALUES (${companyId}, ${np[0] || (q as any).lead_name || "Client"}, ${np.slice(1).join(" ") || ""}, ${(q as any).lead_email ?? null}, ${(q as any).lead_phone ?? null}, ${(q as any).address ?? null})
          RETURNING id`);
        clientId = (cIns.rows[0] as any)?.id ?? null;
      }
      if (clientId) { try { await db.execute(sql`UPDATE quotes SET client_id = ${clientId} WHERE id = ${id} AND company_id = ${companyId}`); } catch { /* noop */ } }
    }

    const isRecurring = jobFreq !== "on_demand";
    if (isRecurring && clientId) {
      // [rebook-preserve 2026-06-20] Re-booking an existing recurring client must
      // NOT reset them to catalog pricing/timing or spawn a duplicate schedule.
      // If this client already has an ACTIVE recurring schedule for the SAME
      // service, reuse it: keep its agreed base_fee + visit length, and only
      // layer on any NEWLY-sold add-ons (folded into the all-in residential
      // base). A different service, or a brand-new client, still creates a
      // fresh schedule at the quoted catalog price. Fixes: re-book dropping
      // Todd's $220 to the $195 menu, re-book ignoring his real visit length,
      // and re-book duplicating his recurring schedule.
      const schedAddons = quoteAddonsToJobAddOns(q.addons);

      const priorRows = await db.execute(sql`
        SELECT id, base_fee, duration_minutes, scheduled_time, assigned_employee_id
          FROM recurring_schedules
         WHERE company_id = ${companyId} AND customer_id = ${clientId}
           AND is_active = true AND service_type = ${serviceType}
         ORDER BY id DESC LIMIT 1
      `);
      const prior = (priorRows.rows as any[])[0];
      const reusedSchedule = !!prior;

      // Which sold add-ons are genuinely new for this schedule? Idempotent —
      // re-booking the same add-on twice can never double-charge.
      let newAddons = schedAddons;
      if (prior) {
        const existingAddonRows = await db.execute(sql`
          SELECT pricing_addon_id FROM recurring_schedule_add_ons WHERE recurring_schedule_id = ${prior.id}
        `);
        const have = new Set((existingAddonRows.rows as any[]).map(r => Number(r.pricing_addon_id)));
        newAddons = schedAddons.filter(a => !have.has(Number(a.pricing_addon_id)));
      }
      const newAddonSubtotal = Math.round(newAddons.reduce((s, a) => s + (a.subtotal ?? 0), 0) * 100) / 100;

      let sched: any;
      let allInBase = 0;
      if (prior) {
        // Reuse the existing schedule (don't spawn a duplicate). Agreed base +
        // visit length stay as-is; new add-ons fold into the all-in base. But a
        // re-book at a DIFFERENT cadence is a deliberate change, so update the
        // frequency to the quoted one — previously the DB row kept its old
        // cadence even though the office picked a new one on the quote.
        const agreedBase = prior.base_fee != null ? parseFloat(prior.base_fee) : (recurringFee ?? 0);
        allInBase = Math.round((agreedBase + newAddonSubtotal) * 100) / 100;
        await db.execute(sql`
          UPDATE recurring_schedules
             SET base_fee = ${String(allInBase)},
                 frequency = ${jobFreq},
                 scheduled_time = COALESCE(${scheduled_time || null}, scheduled_time),
                 assigned_employee_id = COALESCE(${assigned_user_id ? parseInt(String(assigned_user_id)) : null}, assigned_employee_id)
           WHERE id = ${prior.id} AND company_id = ${companyId}
        `);
        sched = {
          id: Number(prior.id), company_id: companyId, customer_id: clientId,
          frequency: jobFreq, day_of_week: null, start_date: jobDate, end_date: null,
          assigned_employee_id: assigned_user_id ? parseInt(String(assigned_user_id)) : prior.assigned_employee_id,
          service_type: serviceType,
          scheduled_time: scheduled_time || prior.scheduled_time || null,
          duration_minutes: prior.duration_minutes,
          base_fee: String(allInBase),
          notes: q.internal_memo || null,
        };
      } else {
        [sched] = await db.insert(recurringSchedulesTable).values({
          company_id: companyId,
          customer_id: clientId,
          frequency: jobFreq,
          day_of_week: null, // cadence anchors on start_date's weekday when null
          start_date: jobDate,
          end_date: null,
          assigned_employee_id: assigned_user_id ? parseInt(String(assigned_user_id)) : null,
          service_type: serviceType,
          scheduled_time: scheduled_time || null,
          duration_minutes: chosenHours != null ? Math.round(chosenHours * 60) : null,
          base_fee: recurringFee != null ? String(recurringFee) : null,
          notes: q.internal_memo || null,
        }).returning();
      }

      // [quote-convert-stickiness 2026-06-10] Persist the (new) add-ons onto the
      // schedule template so the edit-job cascade machinery sees them.
      for (const a of newAddons) {
        try {
          await db.execute(sql`
            INSERT INTO recurring_schedule_add_ons (recurring_schedule_id, pricing_addon_id, qty)
            VALUES (${sched.id}, ${a.pricing_addon_id}, ${a.qty})
          `);
        } catch (e) { console.warn("[quote convert] schedule add-on insert failed:", e); }
      }

      let generated = { created: 0, skipped: 0 };
      try {
        const cl = await db.select({ zip: clientsTable.zip }).from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
        const clientZip = (cl[0]?.zip as any) ?? null;
        const today = new Date();
        const horizon = new Date(today.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);
        generated = await generateJobsFromSchedule(sched as any, today, horizon, null, clientZip);
      } catch (genErr: any) {
        console.warn("[quote convert] recurring generation failed:", genErr?.message ?? genErr);
      }

      // [quote-notes-convert 2026-07-01] Carry the quote's Call Notes into the
      // office notes of every generated recurring visit, so the office can find
      // them after convert (same as the one-time path below).
      try {
        const recurringOfficeNotes = [(q as any).call_notes, (q as any).office_notes]
          .filter((x: any) => x && String(x).trim()).join("\n\n");
        if (recurringOfficeNotes) {
          await db.execute(sql`
            UPDATE jobs SET office_notes = ${recurringOfficeNotes}
             WHERE recurring_schedule_id = ${sched.id} AND company_id = ${companyId}
               AND (office_notes IS NULL OR office_notes = '')`);
        }
      } catch (e) { console.warn("[quote convert] office-notes stamp failed:", e); }

      if (reusedSchedule) {
        // Reused schedule: move every UPCOMING visit to the agreed all-in price
        // and give it the new add-on line items. Past/completed visits are left
        // untouched. Setting base_fee = allInBase (not a += delta) is idempotent
        // — newly generated visits already carry allInBase, existing ones get
        // corrected up to it, and a repeat re-book is a no-op.
        try {
          const futureRows = await db.execute(sql`
            SELECT id FROM jobs
             WHERE recurring_schedule_id = ${sched.id} AND company_id = ${companyId}
               AND status = 'scheduled' AND scheduled_date >= CURRENT_DATE`);
          for (const row of (futureRows.rows as any[])) {
            if (newAddons.length) { try { await persistJobAddOns(db, Number(row.id), companyId, newAddons); } catch { /* idempotent */ } }
            await db.execute(sql`UPDATE jobs SET base_fee = ${String(allInBase)} WHERE id = ${Number(row.id)} AND company_id = ${companyId}`);
          }
        } catch (e) { console.warn("[quote convert] reuse base/add-on stamp failed:", e); }
      } else {
        // New schedule: stamp add-ons on every generated occurrence (the engine
        // only stamps the parking fee at generation time, not schedule add-ons).
        if (schedAddons.length) {
          try {
            const genRows = await db.execute(sql`SELECT id FROM jobs WHERE recurring_schedule_id = ${sched.id} AND company_id = ${companyId}`);
            for (const row of (genRows as any).rows) {
              await persistJobAddOns(db, Number(row.id), companyId, schedAddons);
            }
          } catch (e) { console.warn("[quote convert] stamping add-ons on generated jobs failed:", e); }
        }

        // [multi-frequency, decision d] First visit is priced at the one-time
        // first-visit rate; recurring visits keep the schedule's recurring price.
        // Only for a genuinely NEW schedule — a reused one keeps the client's
        // agreed price on every visit.
        if (firstVisitFee != null && firstVisitFee !== recurringFee) {
          try {
            await db.execute(sql`
              UPDATE jobs SET base_fee = ${String(firstVisitFee)}
              WHERE id = (SELECT id FROM jobs WHERE recurring_schedule_id = ${sched.id} AND company_id = ${companyId}
                          ORDER BY scheduled_date ASC, id ASC LIMIT 1)`);
          } catch (e) { console.warn("[quote convert] first-visit price stamp failed:", e); }
        }
      }
      logAudit(req, "CONVERTED", "quote", id, null, { status: "booked", recurring_schedule_id: sched.id, jobs_generated: generated.created });
      import("../services/followUpService.js").then(({ stopEnrollmentsForQuote }) => {
        stopEnrollmentsForQuote(id, "booked").catch(() => {});
      });
      // Quote→lead: advance to Booked + link first generated job (non-blocking).
      import("../lib/lead-sync.js").then(async ({ upsertLeadForQuote, advanceLeadStage }) => {
        const leadId = await upsertLeadForQuote(companyId, { ...(q as any), id });
        if (leadId) {
          const firstJobRow = await db.execute(sql`SELECT id FROM jobs WHERE recurring_schedule_id = ${sched.id} AND company_id = ${companyId} ORDER BY scheduled_date ASC, id ASC LIMIT 1`);
          const firstJobId = (firstJobRow.rows[0] as any)?.id ?? null;
          await advanceLeadStage(companyId, leadId, "booked", { jobId: firstJobId ?? undefined, clientId: clientId ?? undefined, userId: req.auth!.userId });
        }
      }).catch(() => {});
      return res.json({
        success: true, quote: q, recurring_schedule_id: sched.id, jobs_generated: generated.created,
        message: `Quote converted — recurring schedule created with ${generated.created} visit${generated.created === 1 ? "" : "s"} over the next ${DAYS_AHEAD} days.`,
      });
    }

    // (Client already resolved/materialized above so recurring + one-time share it.)

    // [addon-hours 2026-06-04] Carry the quote's estimated hours (which now
    // include add-on time-adds) onto the job as BOTH allowed_hours and
    // estimated_hours. Previously the convert wrote neither, so every
    // quote-booked job landed with NULL allowed_hours — the dispatch Gantt
    // rendered a flat default block and the add-on time never showed up.
    // [quote-notes-convert 2026-07-01] Carry the quote's Call Notes into the
    // job's OFFICE NOTES so the office can find them after convert (Maribel:
    // "these notes should go to office notes, can't find them"). Combine with
    // the quote's own office_notes if both are present.
    const jobOfficeNotes = [(q as any).call_notes, (q as any).office_notes]
      .filter((x: any) => x && String(x).trim())
      .join("\n\n") || null;
    const jobResult = await db.execute(sql`
      INSERT INTO jobs (
        company_id, client_id, scheduled_date, scheduled_time,
        service_type, base_fee, status, assigned_user_id,
        frequency, notes, office_notes, allowed_hours, estimated_hours, address_street, created_at
      ) VALUES (
        ${companyId},
        ${clientId},
        ${jobDate},
        ${scheduled_time || null},
        ${sql.raw(`'${serviceType}'::service_type`)},
        ${firstVisitFee != null ? String(firstVisitFee) : (q.total_price || '0')},
        'scheduled',
        ${assigned_user_id || null},
        ${sql.raw(`'${jobFreq}'::frequency`)},
        ${q.internal_memo || null},
        ${jobOfficeNotes},
        ${chosenHours != null ? String(chosenHours) : (q.estimated_hours || null)},
        ${chosenHours != null ? String(chosenHours) : (q.estimated_hours || null)},
        ${(q as any).address || null},
        NOW()
      ) RETURNING id
    `);
    const jobId = (jobResult.rows[0] as any)?.id;

    // Link job back to quote (safe — column may not exist yet)
    if (jobId) {
      try {
        await db.execute(sql`UPDATE quotes SET booked_job_id = ${jobId} WHERE id = ${id}`);
      } catch { /* column may not exist */ }
    }

    // [quote-convert-stickiness 2026-06-10] Two more things that previously
    // didn't stick through the convert:
    // 1. branch_id — stamped from the client's home branch. NULL branch was
    //    papered over in the dispatch filter, but timeclock branch attribution
    //    (stamps branch at clock-in, defaults Oak Lawn) and hours-by-branch
    //    reporting still misattributed Schaumburg work.
    // 2. add-ons — the extras sold on the quote now land in job_add_ons, so
    //    the tech card's "Services this visit", the edit-job modal, and
    //    invoicing keep them.
    if (jobId && q.client_id) {
      try {
        await db.execute(sql`
          UPDATE jobs SET branch_id = (SELECT branch_id FROM clients WHERE id = ${q.client_id})
          WHERE id = ${jobId} AND branch_id IS NULL
        `);
      } catch (e) { console.warn("[quote convert] branch stamp failed:", e); }
    }
    const jobAddons = quoteAddonsToJobAddOns(q.addons);
    if (jobId && jobAddons.length) {
      try {
        await persistJobAddOns(db, jobId, companyId, jobAddons);
      } catch (e) { console.warn("[quote convert] add-on persistence failed:", e); }
    }

    // [quote-convert-assignment-mirror] When the office assigns a tech on the
    // Review step, the INSERT above already mirrors onto jobs.assigned_user_id,
    // but the convert previously NEVER wrote job_technicians. That split-brain
    // left the chip in the dispatch Unassigned row ("job needs assignment")
    // even though a tech was chosen in the quote tool. Per the assignment-mirror
    // invariant, every code path that assigns a tech MUST write both. Promote
    // the chosen tech to primary (is_primary=true) so the dispatch grid and the
    // per-tech fan-out recognize the assignment.
    // Multi-tech assignment. team_user_ids carries the full crew chosen on the
    // Review step; assigned_user_id is the primary (already mirrored onto
    // jobs.assigned_user_id by the INSERT above). Write a job_technicians row
    // per cleaner, flagging ONLY the primary, so the dispatch grid and the
    // per-tech fan-out recognize every assigned tech and the labor splits.
    const primaryTechId = assigned_user_id ? parseInt(String(assigned_user_id)) : NaN;
    const teamIds: number[] = (Array.isArray(team_user_ids) ? team_user_ids : [])
      .map((t: any) => parseInt(String(t)))
      .filter((n: number) => !isNaN(n));
    // Primary first, then the remaining crew (deduped). Falls back to the lone
    // primary when no team array is sent (older clients / single assignment).
    const orderedTechIds = [
      ...(!isNaN(primaryTechId) ? [primaryTechId] : []),
      ...teamIds.filter(t => t !== primaryTechId),
    ];
    if (jobId && orderedTechIds.length) {
      for (let i = 0; i < orderedTechIds.length; i++) {
        const techId = orderedTechIds[i];
        const isPrimary = !isNaN(primaryTechId) ? techId === primaryTechId : i === 0;
        await db.execute(sql`
          INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
          VALUES (${jobId}, ${techId}, ${companyId}, ${isPrimary})
          ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
        `);
        // [notifications A.2] Alert each assigned tech of the new booking (in-app).
        import("../lib/notify.js").then(({ notifyUser }) => notifyUser({
          companyId, userId: techId, type: "job_assigned",
          title: "New job assigned",
          body: `${String(serviceType).replace(/_/g, " ")} on ${jobDate}`,
          link: "/my-jobs", meta: { job_id: jobId },
        })).catch(() => {});
      }
    }

    logAudit(req, "CONVERTED", "quote", id, null, { status: "booked", total_price: q.total_price, job_id: jobId });

    // Booking confirmation (job_scheduled) — email AND SMS, both carrying a
    // no-login customer appointment-view link. Per-tenant via sendNotification
    // (company gate + global COMMS_ENABLED + tenant from-address/number all
    // enforced inside). Fetches client email+phone from the job. Non-blocking.
    if (jobId) {
      import("../lib/booking-confirmation.js").then(({ sendJobScheduledConfirmation }) =>
        sendJobScheduledConfirmation(req, jobId)
      ).catch(() => {});
    }

    // Stop quote_followup enrollment (non-blocking)
    import("../services/followUpService.js").then(({ stopEnrollmentsForQuote }) => {
      stopEnrollmentsForQuote(id, "booked").catch(() => {});
    });
    // Quote→lead: advance to Booked + link the job (non-blocking).
    import("../lib/lead-sync.js").then(async ({ upsertLeadForQuote, advanceLeadStage }) => {
      const leadId = await upsertLeadForQuote(companyId, { ...(q as any), id });
      if (leadId) await advanceLeadStage(companyId, leadId, "booked", { jobId, clientId: clientId ?? undefined, userId: req.auth!.userId });
    }).catch(() => {});

    return res.json({ success: true, quote: q, job_id: jobId, message: "Quote converted and job created." });
  } catch (err) {
    console.error("Convert quote error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(quotesTable).where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, req.auth!.companyId)));
    logAudit(req, "DELETE", "quote", id, null, null);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
