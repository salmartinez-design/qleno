import { Router } from "express";
import { db } from "@workspace/db";
import { quotesTable, clientsTable, pricingScopesTable, recurringSchedulesTable, usersTable } from "@workspace/db/schema";
import { eq, and, desc, count, sql, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { fillAddressGaps } from "../lib/parse-address.js";
import { resolveZoneForZip } from "./zones.js";
import { logAudit } from "../lib/audit.js";
import { resolveBranchForCompany } from "../lib/branchRouter";
import { randomBytes, randomUUID } from "crypto";
import { generateJobsFromSchedule, DAYS_AHEAD } from "../lib/recurring-jobs.js";
import { persistJobAddOns } from "./jobs.js";
import { resolveServiceType } from "../lib/serviceType.js";
import { serviceTypeEnum } from "@workspace/db/schema";
import { materializeClientForQuote } from "../lib/materialize-client.js";
import { commissionBaseFollowsBaseFee } from "../lib/commission-base-sync.js";

const router = Router();

// [subtype-coinflip 2026-08-14] Every valid jobs.service_type value, taken from
// the enum itself so it cannot drift as slugs are added.
//
// This is a SECURITY boundary, not a tidiness one: convert stamps the job with
// sql.raw(`'${serviceType}'::service_type`), so any value that reaches it is
// concatenated into SQL. The name-resolved path can only ever return a literal
// from its own table, but service_type_slug arrives from a client. It is
// checked against this set before it is allowed anywhere near that template.
//
// Tenant-added commercial slugs are ALTERed into the Postgres enum at runtime
// (POST /api/commercial-service-types) but are not in this compiled list, so a
// brand-new one falls back to name resolution rather than being injected. That
// is the correct failure direction.
const SERVICE_TYPE_SLUGS = new Set<string>(serviceTypeEnum.enumValues);

// [quote-discount-adjustment 2026-08-09] Francisco: "Quote discounts should
// appear as adjustments on the Job Card and should not affect cleaner
// commissions. When a discount is applied through the Quoting Tool, it should
// be carried over to the Job Card as a separate discount adjustment rather than
// reducing the base service rate."
//
// Before this the discount was invisible on the job: convert booked the job at
// whatever price it had and the Job Card's ADJUSTMENTS panel read "No
// adjustments". Worse, the two price sources disagreed about whether the
// discount was already applied — the frequency snapshot
// (quotes.frequency_options) is priced PRE-discount by the pricing engine,
// while quotes.total_price is the POST-discount final total. So a discounted
// quote with a snapshot silently booked at full price (the customer never got
// their discount), and one without a snapshot booked at the discounted price
// with the discount buried inside base_fee.
//
// Now base_fee is ALWAYS the full pre-discount service rate and the discount is
// its own negative flat row in job_rate_mods — the exact carrier the
// ADJUSTMENTS panel renders. affects_commission=false, so
// recomputeJobBilledAmount lands billed_amount = base − discount (what the
// client pays) and commission_base = base (the full price the cleaner is paid
// on). No commission_base pin needed: the engine derives it.
async function applyQuoteDiscountAdjustment(
  companyId: number,
  jobId: number | null | undefined,
  discount: number,
  code: string | null,
  userId: number | null,
): Promise<void> {
  if (!jobId || !(discount > 0)) return;
  try {
    const reason = `Quote discount${code ? ` (${code})` : ""}`;
    // Idempotent — a re-convert must not stack a second discount row.
    const dupe = await db.execute(sql`
      SELECT 1 FROM job_rate_mods
       WHERE job_id = ${jobId} AND company_id = ${companyId} AND reason LIKE 'Quote discount%'
       LIMIT 1`);
    if (dupe.rows.length > 0) return;
    await db.execute(sql`
      INSERT INTO job_rate_mods (company_id, job_id, mod_type, minutes, amount, reason, created_by, affects_commission)
      VALUES (${companyId}, ${jobId}, 'flat', NULL, ${(-discount).toFixed(2)}, ${reason}, ${userId}, false)`);
    const { recomputeJobBilledAmount } = await import("./jobs.js");
    await recomputeJobBilledAmount(jobId, companyId);
  } catch (e) {
    console.warn("[convert] quote discount adjustment non-fatal:", e);
  }
}

// [manual-adj-to-job 2026-08-14] Carry the office's manual +/- adjustments from
// the quote onto the booked job.
//
// Francisco: "a discount applied in the Quoting Tool should appear on the Job
// Card as a separate adjustment [...] manual or with code." The CODE path has
// worked since 2026-08-09 (applyQuoteDiscountAdjustment, off discount_amount).
// The MANUAL path never has: the office's own +/- rows are stored in
// quotes.manual_adjustments and, until now, convert SELECTed that column and
// then ignored it. The only consumer was the quote email. So a hand-typed
// discount showed on the quote the customer received and then vanished the
// moment the quote became a job — ADJUSTMENTS read "No adjustments" and the
// client was billed the undiscounted total.
//
// Mirrors applyQuoteDiscountAdjustment exactly: negative flat rows for a
// subtract, positive for an add, affects_commission=false so the cleaner is
// still paid on the full pre-adjustment base, then one recompute.
//
// Only the PRIMARY scope's adjustments are carried — the same filter
// followUpService.quoteAdjustmentLines uses. A multi-option quote holds rows
// for scopes that were never booked, and only the primary scope's are baked
// into the total_price this job is priced from.
async function applyQuoteManualAdjustments(
  companyId: number,
  jobId: number | null | undefined,
  rawAdjustments: unknown,
  bookedScopeId: number | null | undefined,
  userId: number | null,
): Promise<void> {
  if (!jobId) return;
  const adjs = Array.isArray(rawAdjustments) ? rawAdjustments : [];
  if (!adjs.length) return;
  try {
    // Idempotent — a re-convert must not stack a second set.
    const dupe = await db.execute(sql`
      SELECT 1 FROM job_rate_mods
       WHERE job_id = ${jobId} AND company_id = ${companyId} AND reason LIKE 'Quote adjustment%'
       LIMIT 1`);
    if (dupe.rows.length > 0) return;

    const scopeId = bookedScopeId != null ? Number(bookedScopeId) : null;
    let wrote = 0;
    for (const a of adjs as any[]) {
      if (scopeId != null && a?.scope_id != null && Number(a.scope_id) !== scopeId) continue;
      const amt = Number(a?.amount) || 0;
      if (!(amt > 0)) continue;
      const isSubtract = a?.type === "subtract";
      const signed = isSubtract ? -amt : amt;
      const why = String(a?.reason ?? "").trim();
      // Prefixed so the dupe guard above can find them, and so the office can
      // tell a quote-time adjustment from one added later on the job card.
      const reason = `Quote adjustment${why ? ` (${why})` : ""}`;
      await db.execute(sql`
        INSERT INTO job_rate_mods (company_id, job_id, mod_type, minutes, amount, reason, created_by, affects_commission)
        VALUES (${companyId}, ${jobId}, 'flat', NULL, ${signed.toFixed(2)}, ${reason}, ${userId}, false)`);
      wrote++;
    }
    if (wrote > 0) {
      const { recomputeJobBilledAmount } = await import("./jobs.js");
      await recomputeJobBilledAmount(jobId, companyId);
    }
  } catch (e) {
    console.warn("[convert] quote manual adjustments non-fatal:", e);
  }
}

// [quote-convert-stickiness 2026-06-10] Map the quote's `addons` jsonb
// (addon_breakdown rows: { id: pricing_addons.id, name, amount, price_type })
// into the shape persistJobAddOns expects. The convert previously dropped
// every sold add-on on the floor — the booked job had no job_add_ons rows, so
// the tech card's "Services this visit", the edit-job modal, and invoicing all
// lost the extras the office sold on the quote.
// [addon-qty+recurrence 2026-07-28] Carry the office's real per-add-on quantity
// and first-visit/every-visit flag from the quote JSON into job_add_ons /
// recurring_schedule_add_ons. The quote row's `amount` is the priced TOTAL
// (qty × unit, as the pricing engine folds it), so unit_price = amount / qty and
// subtotal = amount. Older quotes without `qty` behave exactly as before (qty 1).
function quoteAddonsToJobAddOns(addons: unknown): { pricing_addon_id?: number; qty: number; unit_price?: number; subtotal?: number; every_visit: boolean }[] {
  if (!Array.isArray(addons)) return [];
  return addons
    .map((a: any) => {
      const qty = Math.max(1, Number(a?.qty ?? 1) || 1);
      const total = a?.amount != null ? Number(a.amount) : undefined;
      return {
        pricing_addon_id: Number(a?.id) || undefined,
        qty,
        unit_price: total != null ? Math.round((total / qty) * 100) / 100 : undefined,
        subtotal: total,
        every_visit: a?.every_visit !== false,
      };
    })
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
      hourly_rate_override: quotesTable.hourly_rate_override,
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
      referral_source: quotesTable.referral_source,
      // [quote-dropped-columns 2026-07-27] Select the newly-added columns so the
      // builder re-hydrates them when a saved/parked quote is reopened.
      unit_suite: quotesTable.unit_suite,
      address_verified: quotesTable.address_verified,
      photo_urls: quotesTable.photo_urls,
      alternate_options: quotesTable.alternate_options,
      zone_override: quotesTable.zone_override,
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
      base_price, total_price, discount_amount, discount_code, addons, hourly_rate_override,
      bedrooms, bathrooms, half_baths, sqft, dirt_level, pets,
      special_instructions, internal_memo, client_notes, notes, status,
      unit_suite, referral_source, office_notes, call_notes, manual_adjustments,
    } = req.body;

    const scope = scope_id ? await db.select().from(pricingScopesTable).where(eq(pricingScopesTable.id, scope_id)).limit(1) : null;

    // Resolve branch from client zip for branch tagging
    // The office quote is the one place ANY zip is allowed (Sal, 2026-08-19),
    // so the branch tag comes from the tenant the office is working in — a
    // Schaumburg quote for an Oak Lawn address stays Schaumburg.
    let quoteBranch = "oak_lawn";
    try {
      let clientZip: string | null = null;
      if (client_id) {
        const [cl] = await db.select({ zip: clientsTable.zip }).from(clientsTable).where(eq(clientsTable.id, client_id)).limit(1);
        clientZip = cl?.zip ?? null;
      }
      quoteBranch = (await resolveBranchForCompany(req.auth!.companyId, clientZip)).branch;
    } catch {}

    const [q] = await db.insert(quotesTable).values({
      company_id: req.auth!.companyId,
      client_id: client_id || null,
      lead_name, lead_email, lead_phone, address,
      service_type: scope?.[0]?.name || null,
      // [subtype-coinflip 2026-08-14] The exact type the office picked, when the
      // UI knows it. Validated at convert, not here — an unrecognised value is
      // ignored there and name resolution stands, so a bad one can never be
      // stamped on a job.
      service_type_slug: (req.body.service_type_slug ?? null) || null,
      frequency, estimated_hours: estimated_hours ? String(estimated_hours) : null,
      manual_hours: manual_hours ? String(manual_hours) : null,
      base_price: base_price ? String(base_price) : null,
      total_price: total_price ? String(total_price) : null,
      // [rate-override 2026-07-11] Explicit per-quote $/hr override (null = none).
      hourly_rate_override: hourly_rate_override != null && hourly_rate_override !== "" ? String(hourly_rate_override) : null,
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
      // [call-notes-fix 2026-07-08] POST dropped call_notes entirely, so a
      // freshly-created quote's Call Notes never reached the column — and thus
      // never carried to the job's office_notes on convert (Maribel: "these
      // notes should go to office notes and be visible from the job card").
      // Only PATCH saved it, so it worked only after an edit. Mirror office_notes.
      call_notes: call_notes || null,
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
      "status", "base_price", "total_price", "estimated_hours", "manual_hours", "hourly_rate_override",
      "notes", "client_notes", "internal_memo", "special_instructions", "call_notes",
      "frequency", "scope_id", "pricing_method", "addons", "service_type_slug",
      "discount_code", "discount_amount", "bedrooms", "bathrooms", "half_baths",
      "sqft", "dirt_level", "pets", "sent_at", "viewed_at", "accepted_at",
      "lead_name", "lead_email", "lead_phone", "address", "client_id",
      "alternate_options", "zone_override", "unit_suite", "referral_source", "address_verified",
      "photo_urls", "office_notes", "manual_adjustments",
    ];
    const updates: any = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        if (["base_price", "total_price", "estimated_hours", "manual_hours", "discount_amount", "hourly_rate_override"].includes(k)) {
          updates[k] = req.body[k] !== null && req.body[k] !== "" ? String(req.body[k]) : null;
        } else {
          updates[k] = req.body[k];
        }
      }
    }

    // [stale-quote-label 2026-08-14] `quotes.service_type` holds the scope NAME
    // (set once at creation, quotes.ts:277) and is what every human-readable
    // surface prints: the quote list, the quote email, and the customer's
    // booking page. `scope_id` is in the allowlist above; service_type is not.
    //
    // So re-picking a scope on an existing quote moved scope_id and left the
    // label frozen. Convert stamps the job from the CURRENT scope_id, and the
    // customer-facing accept page posts scope_id while displaying the OLD name
    // — every surface a person reads says one service while the booked job says
    // another. That is the "quoting tool mixes up Move in/out with Deep Clean"
    // report, and it needs no oddly-named scope to happen.
    //
    // Re-derived from scope_id rather than accepted from the client, so the
    // label cannot be set to something the scope isn't.
    if (updates.scope_id !== undefined && updates.scope_id !== null) {
      try {
        const scopeRow = (await db.execute(sql`
          SELECT name FROM pricing_scopes
           WHERE id = ${updates.scope_id} AND company_id = ${req.auth!.companyId} LIMIT 1`)).rows[0] as any;
        if (scopeRow?.name) updates.service_type = scopeRow.name;
      } catch (e) {
        // Non-fatal: a stale label is bad, but it must not block saving the quote.
        console.warn(`[quotes] could not refresh service_type label for quote ${id}:`, e);
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
    // [quote-send-now 2026-07-17] Enroll in the quote_followup sequence AND fire
    // the Day-0 quote email immediately (was cron-only, up to 30 min late). We
    // AWAIT it so the response can carry the send outcome — if the email failed
    // (unverified domain, comms gate, opt-out) the office finds out NOW instead
    // of a silent never-arrives. Best-effort: a comms error never fails /send.
    let emailResult: any = null;
    try {
      const { enrollForQuoteSent, fireQuoteEmailNow } = await import("../services/followUpService.js");
      await enrollForQuoteSent(
        companyId,
        id,
        (q as any).client_id ?? null,
        (q as any).lead_name?.split(" ")[0] || "",
        (q as any).lead_email ?? null,
        (q as any).lead_phone ?? null,
      );
      emailResult = await fireQuoteEmailNow(companyId!, id);
    } catch (e) {
      console.error("[quote send-now] error:", e);
    }
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
    return res.json({ success: true, quote: q, email: emailResult });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// [quote-email-tracking 2026-07-16] Email delivery status for a quote — powers
// the "Email status" card on the quote detail page (Maribel: "see if the email
// was delivered, opened or if it bounced"). Reads communication_log rows the
// quote-followup cadence wrote for this quote; the Resend webhook
// (POST /api/comms/email/webhook) advances delivery_status/opened_at over time.
// Returns newest-first so the frontend shows the latest send's status.
router.get("/:id/email-status", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const rows = await db.execute(sql`
      SELECT id, subject, recipient, resend_email_id, delivery_status,
             opened_at, clicked_at, logged_at
        FROM communication_log
       WHERE company_id = ${companyId} AND quote_id = ${id} AND channel = 'email'
       ORDER BY COALESCE(logged_at, NOW()) DESC
       LIMIT 10
    `);
    return res.json(rows.rows ?? []);
  } catch (err) {
    console.error("[quote email-status]", err);
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

// [lead-card-link 2026-08-08] POST /api/quotes/:id/ensure-client
//
// Give me a client id for this quote, creating one from the lead's details if it
// doesn't have one yet. Exists because `payment_links.client_id` is NOT NULL, so
// a save-card link cannot be created for a lead — which meant the office could
// only text or email a card link to customers who were ALREADY in the system.
// Sal, 2026-08-08: "for a new quote while on the phone i still need the ability
// to text or send the email."
//
// Uses the same helper convert does, so the client created here is the one
// convert later finds — no twins. Safe to call repeatedly: it returns the
// existing client once the quote has one.
router.post("/:id/ensure-client", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    // String() because this router's `req.params.id` types as string | string[];
    // the sibling handlers' bare parseInt is a pre-existing tsc error, not a
    // pattern to copy.
    const id = parseInt(String(req.params.id));
    const companyId = req.auth!.companyId;
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid quote id" });
    if (companyId == null) return res.status(400).json({ error: "No company on session" });

    const q = await getQuoteWithDetails(id, companyId);
    if (!q) return res.status(404).json({ error: "Quote not found" });

    const clientId = await materializeClientForQuote(companyId, id, q as any);
    if (!clientId) {
      // Nothing to build a customer from — name, email, phone and address were
      // all blank. Say which, rather than failing opaquely at the link step.
      return res.status(400).json({
        error: "Add a name, phone, email or address to this quote before sending a card link.",
      });
    }
    return res.json({ client_id: clientId });
  } catch (err) {
    console.error("ensure-client error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/convert", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const { scheduled_date, scheduled_time, assigned_user_id, team_user_ids, custom_recurrence } = req.body || {};

    // [custom-recurring] The quote builder's Custom recurring card / Hourly
    // "Custom…" cadence ships a flexible pattern. Normalize it here into the
    // recurring_schedules cadence columns:
    //   unit=weeks  → frequency='custom' + custom_frequency_weeks=interval
    //   unit=months → frequency='monthly_weekday' + week_of_month + month_interval
    // Both carry day_of_week. Invalid/absent payload leaves cadence untouched.
    const CUSTOM_DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    let customCadence: {
      frequency: string; day_of_week: string;
      custom_frequency_weeks: number | null; week_of_month: number | null; month_interval: number | null;
    } | null = null;
    if (custom_recurrence && typeof custom_recurrence === "object") {
      const cr = custom_recurrence as any;
      const interval = Math.max(1, Math.min(52, parseInt(String(cr.interval)) || 1));
      const weekday = CUSTOM_DAY_NAMES[Number(cr.weekday)] ? Number(cr.weekday) : 2;
      const dayName = CUSTOM_DAY_NAMES[weekday];
      if (cr.unit === "months") {
        const wom = Math.max(1, Math.min(5, parseInt(String(cr.week_of_month)) || 1));
        customCadence = { frequency: "monthly_weekday", day_of_week: dayName, custom_frequency_weeks: null, week_of_month: wom, month_interval: interval };
      } else {
        customCadence = { frequency: "custom", day_of_week: dayName, custom_frequency_weeks: interval, week_of_month: null, month_interval: null };
      }
    }

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
    // [hourly-invisible 2026-08-14] The scope knows whether it bills hourly and
    // at what rate; the job never learned either. `billing_method` was never
    // written at all, and `hourly_rate` came only from the office's per-quote
    // override — so a residential job booked off "Hourly Deep Clean" landed
    // with billing_method NULL and hourly_rate NULL and read on the card as a
    // plain flat total. Maribel: "scheduled as hourly. Doesn't say it anywhere."
    // Carry the scope's own pricing_method + hourly_rate through, with the
    // per-quote override still winning when the office set one.
    let scopeBillingMethod: string | null = null;
    let scopeHourlyRate: string | null = null;
    if (q.scope_id) {
      const scopeResult = await db.execute(sql`
        SELECT name, pricing_method, hourly_rate FROM pricing_scopes WHERE id = ${q.scope_id} LIMIT 1`);
      const scopeRow = scopeResult.rows[0] as any;
      const scopeName = (scopeRow?.name || "").toLowerCase().trim();
      // Strict table first (preserves exact commercial mappings), then a robust
      // keyword resolver so punctuation/spacing variants of hourly scopes
      // (e.g. "Hourly Move-In / Move-Out") resolve to the right enum instead of
      // silently collapsing to standard_clean. See lib/serviceType.ts.
      // [hourly-subtype-persist 2026-08-14] What the office ACTUALLY picked wins
      // over anything re-derived from the scope name. The Hourly group's "Deep
      // Clean" and "Move In / Move Out" buttons share one combined scope, so the
      // name below genuinely cannot tell them apart — it names both, and the
      // resolver has to pick one. That guess is what stamped Deep Clean bookings
      // as Move Out. Older quotes have no recorded choice and fall through to
      // the resolver, which is correct for every unambiguous scope.
      serviceType = SCOPE_TO_ENUM[scopeName] || resolveServiceType(scopeName);

      if (String(scopeRow?.pricing_method ?? "").toLowerCase() === "hourly") {
        scopeBillingMethod = "hourly";
        const r = parseFloat(String(scopeRow?.hourly_rate ?? "0"));
        if (Number.isFinite(r) && r > 0) scopeHourlyRate = String(r);
      } else if (scopeRow) {
        scopeBillingMethod = "flat_rate";
      }
    }

    // [subtype-coinflip 2026-08-14] An EXPLICIT pick beats anything inferred
    // from wording, so this runs AFTER the name resolution above and overrides
    // it. Phes has one scope, "Hourly Deep Clean or Move In/Out", behind BOTH
    // the Deep Clean and the Move In/Out hourly buttons — name resolution
    // answered identically for both, so one of them was always wrong whichever
    // way the matching leaned. Sal, picking Move In/Out: "it should not display
    // deep clean." Maribel, on the same thing from the other side: "it should
    // just mirror what we are selecting here."
    //
    // Only the TYPE is overridden. Billing method and rate still come from the
    // scope, because those are properties of the scope and not of the choice.
    //
    // Validated against the enum rather than merely non-empty: this value is
    // interpolated into raw SQL below via sql.raw, so an unchecked string would
    // be an injection. Anything unrecognised is ignored and the name-resolved
    // answer stands, which is also what makes this safe for every existing
    // quote (the column is NULL on all of them).
    const pickedSlug = String((q as any).service_type_slug ?? "").trim().toLowerCase();
    if (pickedSlug) {
      if (SERVICE_TYPE_SLUGS.has(pickedSlug)) {
        serviceType = pickedSlug;
      } else {
        console.warn(`[quotes] quote ${id}: ignoring unrecognised service_type_slug "${pickedSlug}"`);
      }
    }
    const jobHourlyRate = q.hourly_rate_override != null
      ? String(q.hourly_rate_override)
      : scopeHourlyRate;

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
    // [quote-discount-adjustment 2026-08-09] Every fee below is the PRE-discount
    // service rate. The snapshot options already are (the pricing engine never
    // applies discount_amount); the stored total_price fallback is POST-discount,
    // so add the discount back. The discount then lands as its own adjustment row
    // on the booked job — see applyQuoteDiscountAdjustment.
    const convertDiscount = Math.max(0, Number((q as any).discount_amount ?? 0) || 0);
    const fallbackFee = q.total_price != null
      ? Math.round((Number(q.total_price) + convertDiscount) * 100) / 100
      : (q.base_price != null ? Number(q.base_price) : null);
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
    // [lead-card-link 2026-08-08] Body moved verbatim to
    // lib/materialize-client.ts so /ensure-client can run the IDENTICAL match.
    // Both paths must dedupe the same way: if the office texts a card link first
    // (which creates the client) and then books, convert has to find that same
    // client instead of inserting a twin.
    if (!clientId && companyId != null) {
      clientId = await materializeClientForQuote(companyId, id, q as any);
    }

    // [service-address-cascade 2026-07-08] A newly-converted client had their
    // address on the clients row but NO client_homes row — so the profile's
    // Property tab showed an empty "Add Another Home" even though we knew
    // exactly where the job is (Sal: "her being a new client it only makes
    // sense it defaults to the first service address"). Seed a PRIMARY home
    // from the client's address + the quote's property details, only when the
    // client has none yet (NOT EXISTS guard never clobbers an existing home).
    // Placed here so it covers BOTH the recurring and single-job convert paths.
    if (clientId) {
      try {
        await db.execute(sql`
          INSERT INTO client_homes (company_id, client_id, address, city, state, zip, sq_footage, bedrooms, bathrooms, half_baths, is_primary)
          SELECT ${companyId}, c.id, COALESCE(NULLIF(c.address,''), ${(q as any).address ?? null}), c.city, c.state, c.zip,
                 ${(q as any).sqft ?? null}, ${(q as any).bedrooms ?? null}, ${(q as any).bathrooms ?? null},
                 ${(q as any).half_baths ?? null}, true
            FROM clients c
           WHERE c.id = ${clientId} AND c.company_id = ${companyId}
             AND COALESCE(NULLIF(c.address,''), ${(q as any).address ?? null}) IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM client_homes h WHERE h.client_id = ${clientId})`);
      } catch (e) { console.error("[convert] seed client_home non-fatal:", (e as any)?.message); }
    }

    // [quote-notes-durable 2026-08-09] Two fields the quote builder captured and
    // then effectively threw away. Both land on the CLIENT here, before either
    // convert branch, so recurring and one-time behave identically.
    //
    // call_notes — already copied onto the generated job(s) below
    // ([quote-notes-convert 2026-07-01]), but only there. Maribel: "the 'call
    // notes' during the quote should be saved there too. Because right now they
    // go nowhere" / "After the job is booked." A note taken on the phone is
    // about the CLIENT, not about one visit, so it also appends to the standing
    // office-only note and stays findable after that first job is done.
    //
    // unit_suite — written by the builder, stored on the quote, and read by
    // NOTHING. Maribel: "Same with the unit number, doesn't save anywhere." It
    // goes to home_access_notes ("Entry Instructions"), which is the field the
    // tech actually sees in my-jobs — a unit number the cleaner can't see is
    // the same as no unit number.
    //
    // Both appends are guarded by a containment check so re-converting the same
    // quote (or converting a re-booked quote) doesn't stack duplicates.
    if (clientId) {
      const callNotes = String((q as any).call_notes ?? "").trim();
      if (callNotes) {
        try {
          await db.execute(sql`
            UPDATE clients
               SET office_notes = CASE
                     WHEN COALESCE(NULLIF(btrim(office_notes), ''), '') = '' THEN ${callNotes}
                     ELSE office_notes || E'\n\n' || ${callNotes}
                   END,
                   office_notes_updated_by = ${req.auth!.userId ?? null},
                   office_notes_updated_at = NOW()
             WHERE id = ${clientId} AND company_id = ${companyId}
               AND POSITION(${callNotes} IN COALESCE(office_notes, '')) = 0`);
        } catch (e) { console.error("[convert] call_notes -> client office_notes non-fatal:", (e as any)?.message); }
      }

      const unit = String((q as any).unit_suite ?? "").trim();
      if (unit) {
        const unitLine = `Unit / Suite: ${unit}`;
        try {
          await db.execute(sql`
            UPDATE clients
               SET home_access_notes = CASE
                     WHEN COALESCE(NULLIF(btrim(home_access_notes), ''), '') = '' THEN ${unitLine}
                     ELSE ${unitLine} || E'\n' || home_access_notes
                   END
             WHERE id = ${clientId} AND company_id = ${companyId}
               AND POSITION(${unitLine} IN COALESCE(home_access_notes, '')) = 0`);
        } catch (e) { console.error("[convert] unit_suite -> client home_access_notes non-fatal:", (e as any)?.message); }
      }
    }

    // [lead-card-capture 2026-08-08] Attach a card the office took DURING the
    // call, before this client existed.
    //
    // A card on file has to hang off a client record, so the quote builder could
    // only offer card capture once an existing client was selected — for a brand
    // new customer the whole Payment Method block was replaced with "select an
    // existing client above". That's backwards: the call is exactly when someone
    // is willing to read out a card, and Maribel was having to convert, go find
    // the customer, and ask a second time. (Sal, 2026-08-08: "all of this being
    // enabled should take priority with a new client.")
    //
    // The browser tokenizes the card with the Web Payments SDK and posts the
    // one-time `cnon:` nonce here. We're past the block above, so `clientId` is
    // now materialized either way — existing match or freshly inserted. Nothing
    // is charged; this is card-on-file only.
    //
    // Deliberately non-fatal: the job is already booked by this point. A card
    // that fails to save must not fail the booking — the office gets told, and
    // can retry from the customer profile or send a link.
    const squareCardToken = req.body?.square_card_token;
    let cardSaved: { ok: boolean; brand?: string | null; last4?: string | null; error?: string } | null = null;
    // `companyId` is `number | null` on this handler, and both calls below
    // require a real tenant — narrow rather than assert, so a tokenless session
    // can never write a card against a null company.
    if (squareCardToken && clientId && companyId != null) {
      try {
        const { saveSquareCardOnFile } = await import("../lib/square-card-onfile.js");
        const r = await saveSquareCardOnFile({
          companyId, clientId, sourceId: squareCardToken,
          idempotencyKey: randomUUID(),
        });
        if (r.ok) {
          cardSaved = { ok: true, brand: r.brand, last4: r.last4 };
          const { alertCardSaved } = await import("../lib/card-saved-alert.js");
          await alertCardSaved({
            companyId, clientId, brand: r.brand, last4: r.last4,
            processor: "square", source: "office",
          });
        } else {
          cardSaved = { ok: false, error: r.message };
          console.error("[convert] card save failed:", r.code, r.message);
        }
      } catch (e: any) {
        cardSaved = { ok: false, error: e?.message || "Could not save the card" };
        console.error("[convert] card save threw:", e?.message ?? e);
      }
    } else if (squareCardToken && !clientId) {
      // No identifying detail at all on the quote, so no client was created and
      // there is nothing to attach to. Tell the office rather than dropping it.
      cardSaved = { ok: false, error: "No client record was created for this quote, so the card could not be saved." };
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

      // [custom-recurring 2026-07-24] If the office chose a Custom cadence in the
      // quote builder (Custom recurring card / Hourly "Custom…"), the frontend
      // still sends a real recurring frequency (weekly/monthly) so pricing +
      // isRecurring resolve correctly — but the actual pattern lives in
      // custom_recurrence. Stamp it onto the schedule row (weeks → 'custom' +
      // custom_frequency_weeks; months → 'monthly_weekday' + week_of_month +
      // month_interval) and patch the in-memory sched so generation below walks
      // the right cadence. Applied uniformly to both the reused and new rows.
      if (customCadence) {
        await db.execute(sql`
          UPDATE recurring_schedules
             SET frequency = ${customCadence.frequency}::recurring_frequency,
                 day_of_week = ${customCadence.day_of_week}::recurring_day,
                 custom_frequency_weeks = ${customCadence.custom_frequency_weeks},
                 week_of_month = ${customCadence.week_of_month},
                 month_interval = ${customCadence.month_interval},
                 days_of_week = NULL,
                 days_of_month = NULL
           WHERE id = ${sched.id} AND company_id = ${companyId}
        `);
        sched.frequency = customCadence.frequency;
        sched.day_of_week = customCadence.day_of_week;
        sched.custom_frequency_weeks = customCadence.custom_frequency_weeks;
        sched.week_of_month = customCadence.week_of_month;
        sched.month_interval = customCadence.month_interval;
        sched.days_of_week = null;
        sched.days_of_month = null;
      }

      // [quote-convert-stickiness 2026-06-10] Persist the (new) add-ons onto the
      // schedule template so the edit-job cascade machinery sees them.
      for (const a of newAddons) {
        try {
          await db.execute(sql`
            INSERT INTO recurring_schedule_add_ons (recurring_schedule_id, pricing_addon_id, qty, every_visit)
            VALUES (${sched.id}, ${a.pricing_addon_id}, ${a.qty}, ${a.every_visit})
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
            // [commission-base-drift 2026-08-09] Re-booking at a new agreed
            // rate re-prices every upcoming visit; commission_base has to
            // follow or the cleaner keeps getting paid on the old rate.
            // Same statement — the expression reads the pre-update base_fee.
            await db.execute(sql`UPDATE jobs SET base_fee = ${String(allInBase)}, commission_base = ${commissionBaseFollowsBaseFee(String(allInBase))} WHERE id = ${Number(row.id)} AND company_id = ${companyId}`);
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
              UPDATE jobs SET base_fee = ${String(firstVisitFee)},
                              commission_base = ${commissionBaseFollowsBaseFee(String(firstVisitFee))}
              WHERE id = (SELECT id FROM jobs WHERE recurring_schedule_id = ${sched.id} AND company_id = ${companyId}
                          ORDER BY scheduled_date ASC, id ASC LIMIT 1)`);
          } catch (e) { console.warn("[quote convert] first-visit price stamp failed:", e); }
        }
      }

      // [quote-discount-adjustment 2026-08-09] A quote-level discount is a
      // one-off, so it rides the FIRST visit of the series as its own
      // adjustment row. Every visit keeps the full agreed rate as its base fee.
      if (convertDiscount > 0) {
        try {
          const firstRow = await db.execute(sql`
            SELECT id FROM jobs
             WHERE recurring_schedule_id = ${sched.id} AND company_id = ${companyId}
             ORDER BY scheduled_date ASC, id ASC LIMIT 1`);
          const firstId = (firstRow.rows[0] as any)?.id ?? null;
          await applyQuoteDiscountAdjustment(companyId, firstId, convertDiscount, (q as any).discount_code ?? null, req.auth!.userId ?? null);
          await applyQuoteManualAdjustments(companyId, firstId, (q as any).manual_adjustments, q.scope_id, req.auth!.userId ?? null);
        } catch (e) { console.warn("[quote convert] recurring discount adjustment non-fatal:", e); }
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
    // [quote-address-cascade 2026-08-19] Resolve the service address into its
    // parts, and the zone from its zip, BEFORE the insert.
    //
    // The client record wins where it has a component: it is the canonical
    // customer address and the office may already have corrected it. The quote's
    // one-line string only fills the gaps — which is the usual case for a
    // brand-new lead, whose client row was just created from that same line.
    //
    // The zone is resolved here rather than left for a later edit because
    // "assign the zone automatically" is the whole point: an unzoned job is a
    // grey tile the board cannot route. A zip in none of the tenant's zones
    // resolves null, same as everywhere else — visible and fixable, never guessed.
    const clientAddrRow = clientId ? (await db.execute(sql`
      SELECT address, city, state, zip FROM clients
       WHERE id = ${clientId} AND company_id = ${companyId} LIMIT 1`)).rows[0] as any : null;
    const jobAddr = fillAddressGaps(
      {
        street: clientAddrRow?.address ?? null,
        city: clientAddrRow?.city ?? null,
        state: clientAddrRow?.state ?? null,
        zip: clientAddrRow?.zip ?? null,
      },
      (q as any).address ?? null,
    );
    let jobZoneId: number | null = null;
    try {
      jobZoneId = jobAddr.zip ? await resolveZoneForZip(companyId, jobAddr.zip) : null;
    } catch (e) {
      console.warn("[convert] zone resolve non-fatal:", (e as any)?.message ?? e);
    }

    const jobResult = await db.execute(sql`
      INSERT INTO jobs (
        company_id, client_id, scheduled_date, scheduled_time,
        service_type, base_fee, status, assigned_user_id,
        frequency, notes, office_notes, allowed_hours, estimated_hours, hourly_rate, billing_method,
        -- [quote-address-cascade 2026-08-19] All FOUR components and the zone,
        -- not just the street. Convert used to write address_street alone and
        -- leave city/state/zip and zone_id NULL, so a converted quote produced a
        -- job the dispatch board could not colour, routing could not place, and
        -- the card rendered as a street with no town. Maribel: "it's not
        -- cascading from the quote, so we can't see the city and for some reason
        -- doesnt assign the zone automatically."
        address_street, address_city, address_state, address_zip, zone_id, created_at,
        -- [job-created-audit 2026-08-08] Who booked it, from where. Convert
        -- never wrote a CREATE audit row, so the activity feed could show
        -- every later edit to this visit but not the booking itself.
        created_by_user_id, created_source
      ) VALUES (
        ${companyId},
        ${clientId},
        ${jobDate},
        ${scheduled_time || null},
        ${serviceType}::service_type,
        ${firstVisitFee != null ? String(firstVisitFee) : (q.total_price || '0')},
        'scheduled',
        ${assigned_user_id || null},
        ${sql.raw(`'${jobFreq}'::frequency`)},
        ${q.internal_memo || null},
        ${jobOfficeNotes},
        ${chosenHours != null ? String(chosenHours) : (q.estimated_hours || null)},
        ${chosenHours != null ? String(chosenHours) : (q.estimated_hours || null)},
        ${jobHourlyRate},
        ${scopeBillingMethod ? sql.raw(`'${scopeBillingMethod}'::billing_method`) : sql`NULL`},
        ${jobAddr.street},
        ${jobAddr.city},
        ${jobAddr.state},
        ${jobAddr.zip},
        ${jobZoneId},
        NOW(),
        ${req.auth!.userId ?? null},
        'quote'
      ) RETURNING id
    `);
    const jobId = (jobResult.rows[0] as any)?.id;

    // [discount-commission-fix 2026-07-11] Discounts must never dock the
    // cleaner's pay (Francisco). That used to be done by pinning commission_base
    // to base_fee + discount, because the discount was baked INTO base_fee.
    // [quote-discount-adjustment 2026-08-09] base_fee is now the full
    // pre-discount rate and the discount is a separate non-commissionable
    // adjustment row, so the pin is gone — recomputeJobBilledAmount derives
    // commission_base = base_fee (full price) and billed_amount = base − discount
    // (what the client pays) from the row itself.
    await applyQuoteDiscountAdjustment(companyId, jobId, convertDiscount, (q as any).discount_code ?? null, req.auth!.userId ?? null);
    await applyQuoteManualAdjustments(companyId, jobId, (q as any).manual_adjustments, q.scope_id, req.auth!.userId ?? null);

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

    // Booking confirmation (job_scheduled) — carries a no-login customer
    // appointment-view link. Per-tenant via sendNotification (company gate +
    // global COMMS_ENABLED + tenant from-address/number all enforced inside).
    // Non-blocking.
    // [convert-schedule-prompt 2026-08-17] Convert used to ALWAYS send both
    // email and SMS with no way to opt out — the office had no say, so an
    // internal re-book still texted the client. Same notify_client_via contract
    // as POST /api/jobs ('none'|'sms'|'email'|'both'); absent or invalid →
    // 'both', which is the pre-existing behavior.
    if (jobId) {
      const via = String((req.body as any)?.notify_client_via ?? "both");
      const channels: Array<"email" | "sms"> =
        via === "none" ? [] : via === "sms" ? ["sms"] : via === "email" ? ["email"] : ["email", "sms"];
      if (channels.length) {
        import("../lib/booking-confirmation.js").then(({ sendJobScheduledConfirmation }) =>
          sendJobScheduledConfirmation(req, jobId, { channels })
        ).catch(() => {});
      }
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

    // `card_saved` rides along so the builder can tell the office the card
    // landed — or that it didn't, which must never be silent when someone just
    // read their card number down the phone.
    return res.json({
      success: true, quote: q, job_id: jobId, client_id: clientId,
      card_saved: cardSaved, message: "Quote converted and job created.",
    });
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

// [bulk-quote-delete 2026-08-15] Maribel clears out stale quotes one row, one
// menu, one confirm at a time — 267 of the 445 quotes on the books are drafts.
//
// This is a HARD delete, exactly like the single-row route above it: there is no
// archive column, no soft-delete, nothing to restore from. Deleting fifty rows
// at once therefore deserves more care than deleting one, so:
//   - the ids are re-read and re-scoped to the caller's company BEFORE deleting,
//     so a hand-crafted id list can't reach another tenant's quotes,
//   - each deleted quote gets its OWN audit row (id, client, status, price), so
//     the log can answer "what was in that batch" after the rows are gone,
//   - the response reports what actually went, including how many were `booked`
//     — those are quotes attached to real jobs, and the UI warns before sending.
//
// GET /api/quotes/bulk-delete/preview?ids=1,2,3 answers the same question
// without deleting, which is what the confirm dialog reads.
//
// `quote_attachments` is the only table with an FK to quotes and it is ON DELETE
// CASCADE, so nothing else is orphaned by this.
//
// Route-order note: these sit below `/:id` and that is fine today — `/:id` is a
// single segment and there is no `POST /:id`. If one is ever added, move these
// two registrations ABOVE it or "bulk-delete" starts arriving as an id.
const MAX_BULK_DELETE = 200;

function parseIdList(raw: unknown): number[] {
  const arr = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  const ids = arr.map(v => parseInt(String(v), 10)).filter(n => Number.isInteger(n) && n > 0);
  return [...new Set(ids)];
}

router.get("/bulk-delete/preview", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) return res.status(400).json({ error: "No company context" });
    const ids = parseIdList(req.query.ids);
    if (!ids.length) return res.json({ total: 0, booked: 0, quotes: [] });
    const rows = await db.select({ id: quotesTable.id, status: quotesTable.status })
      .from(quotesTable)
      .where(and(inArray(quotesTable.id, ids.slice(0, MAX_BULK_DELETE)), eq(quotesTable.company_id, companyId)));
    return res.json({
      total: rows.length,
      booked: rows.filter(r => r.status === "booked").length,
      quotes: rows,
    });
  } catch (err) {
    console.error("Bulk delete preview error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/bulk-delete", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) return res.status(400).json({ error: "No company context" });
    const ids = parseIdList(req.body?.ids);
    if (!ids.length) return res.status(400).json({ error: "ids required" });
    if (ids.length > MAX_BULK_DELETE) {
      return res.status(400).json({ error: `Too many quotes at once — ${MAX_BULK_DELETE} max per batch.` });
    }

    // Re-read under the caller's company_id. Anything not returned here either
    // doesn't exist or belongs to another tenant; either way it is never touched.
    const targets = await db.select({
      id: quotesTable.id, status: quotesTable.status, client_id: quotesTable.client_id,
      total_price: quotesTable.total_price,
    })
      .from(quotesTable)
      .where(and(inArray(quotesTable.id, ids), eq(quotesTable.company_id, companyId)));

    if (!targets.length) return res.json({ deleted: 0, skipped: ids.length, booked: 0 });

    const targetIds = targets.map(t => t.id);
    await db.delete(quotesTable)
      .where(and(inArray(quotesTable.id, targetIds), eq(quotesTable.company_id, companyId)));

    // One row per quote, with the values captured before the delete — the whole
    // point is that this is the only surviving record of what was removed.
    for (const t of targets) {
      logAudit(req, "DELETE", "quote", t.id,
        { status: t.status, client_id: t.client_id, total_price: t.total_price, bulk: true }, null);
    }

    return res.json({
      deleted: targets.length,
      skipped: ids.length - targets.length,
      booked: targets.filter(t => t.status === "booked").length,
    });
  } catch (err) {
    console.error("Bulk delete quotes error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// [discount-commission-fix 2026-07-11] READ-ONLY audit: existing jobs converted
// from a discounted quote whose commission_base was never pinned (NULL), so the
// pay engine fell through to the discounted base_fee — i.e. the cleaner was
// likely underpaid by discount × the fee-split %. Changes NOTHING; the office
// reviews this list before deciding on any correction.
//   GET /api/quotes/audit/discount-commission
router.get("/audit/discount-commission", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const rows = await db.execute(sql`
      SELECT j.id AS job_id, j.scheduled_date, j.base_fee, j.billed_amount, j.commission_base,
             q.id AS quote_id, q.discount_code, q.discount_amount,
             cl.first_name, cl.last_name,
             COALESCE(co.res_tech_pay_pct, 0.35) AS pct
        FROM quotes q
        JOIN jobs j ON j.id = q.booked_job_id AND j.company_id = q.company_id
        LEFT JOIN clients cl ON cl.id = j.client_id
        JOIN companies co ON co.id = q.company_id
       WHERE q.company_id = ${companyId}
         AND q.discount_amount IS NOT NULL AND q.discount_amount::numeric > 0
         AND j.commission_base IS NULL
         AND j.account_id IS NULL
       ORDER BY j.scheduled_date DESC`);
    const jobs = (rows.rows as any[]).map((r) => {
      const disc = Number(r.discount_amount) || 0;
      const pct = Number(r.pct) || 0.35;
      return {
        job_id: r.job_id,
        quote_id: r.quote_id,
        scheduled_date: r.scheduled_date,
        client: [r.first_name, r.last_name].filter(Boolean).join(" ") || null,
        discount_code: r.discount_code,
        discount_amount: disc,
        base_fee: r.base_fee != null ? Number(r.base_fee) : null,
        est_underpaid_commission: Math.round(disc * pct * 100) / 100,
      };
    });
    const estimated_total_underpaid_commission =
      Math.round(jobs.reduce((s, j) => s + j.est_underpaid_commission, 0) * 100) / 100;
    return res.json({ affected_jobs: jobs.length, estimated_total_underpaid_commission, jobs });
  } catch (err) {
    console.error("GET /quotes/audit/discount-commission:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
