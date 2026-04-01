import { Router } from "express";
import { db } from "@workspace/db";
import {
  pricingScopesTable,
  pricingTiersTable,
  pricingFrequenciesTable,
  pricingAddonsTable,
  pricingDiscountsTable,
} from "@workspace/db/schema";
import { companiesTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

const router = Router();

// ── Simple in-memory rate limiter: 30 req/min per IP ────────────────────────
const ipCounts = new Map<string, { count: number; resetAt: number }>();
function rateLimit(req: any, res: any, next: any) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  const entry = ipCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    ipCounts.set(ip, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  entry.count++;
  if (entry.count > 30) {
    return res.status(429).json({ error: "Too many requests. Please try again in a minute." });
  }
  return next();
}

// ── GET /api/public/company/:slug ────────────────────────────────────────────
router.get("/company/:slug", rateLimit, async (req, res) => {
  try {
    const { slug } = req.params;
    const [company] = await db
      .select({
        id: companiesTable.id,
        name: companiesTable.name,
        slug: companiesTable.slug,
        brand_color: companiesTable.brand_color,
        logo_url: companiesTable.logo_url,
        phone: companiesTable.phone,
        email: companiesTable.email,
        address: companiesTable.address,
        city: companiesTable.city,
        state: companiesTable.state,
        zip: companiesTable.zip,
        business_hours: companiesTable.business_hours,
        booking_policies: companiesTable.booking_policies,
        online_booking_lead_hours: companiesTable.online_booking_lead_hours,
      })
      .from(companiesTable)
      .where(eq(companiesTable.slug, slug));

    if (!company) return res.status(404).json({ error: "Company not found" });

    const scopes = await db
      .select({ id: pricingScopesTable.id, name: pricingScopesTable.name, scope_group: pricingScopesTable.scope_group })
      .from(pricingScopesTable)
      .where(and(eq(pricingScopesTable.company_id, company.id), eq(pricingScopesTable.is_active, true)))
      .orderBy(pricingScopesTable.sort_order, pricingScopesTable.id);

    return res.json({ ...company, active_scopes: scopes });
  } catch (err) {
    console.error("GET /public/company/:slug:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/public/scopes/:companyId ───────────────────────────────────────
router.get("/scopes/:companyId", rateLimit, async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId);
    if (isNaN(companyId)) return res.status(400).json({ error: "Invalid companyId" });

    const scopes = await db
      .select()
      .from(pricingScopesTable)
      .where(and(eq(pricingScopesTable.company_id, companyId), eq(pricingScopesTable.is_active, true)))
      .orderBy(pricingScopesTable.sort_order, pricingScopesTable.id);

    return res.json(scopes);
  } catch (err) {
    console.error("GET /public/scopes/:companyId:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/public/frequencies/:scopeId ────────────────────────────────────
router.get("/frequencies/:scopeId", rateLimit, async (req, res) => {
  try {
    const scopeId = parseInt(req.params.scopeId);
    if (isNaN(scopeId)) return res.status(400).json({ error: "Invalid scopeId" });

    const freqs = await db
      .select()
      .from(pricingFrequenciesTable)
      .where(eq(pricingFrequenciesTable.scope_id, scopeId))
      .orderBy(pricingFrequenciesTable.sort_order, pricingFrequenciesTable.id);

    return res.json(freqs);
  } catch (err) {
    console.error("GET /public/frequencies/:scopeId:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/public/addons/:scopeId ─────────────────────────────────────────
router.get("/addons/:scopeId", rateLimit, async (req, res) => {
  try {
    const scopeId = parseInt(req.params.scopeId);
    if (isNaN(scopeId)) return res.status(400).json({ error: "Invalid scopeId" });

    const { sql: drSql } = await import("drizzle-orm");
    const result = await db.execute(drSql`
      SELECT * FROM pricing_addons
       WHERE is_active = true
         AND show_online = true
         AND (scope_ids::jsonb @> ${JSON.stringify([scopeId])}::jsonb
              OR scope_id = ${scopeId})
       ORDER BY sort_order, id
    `);
    const addons = (result as any).rows ?? [];
    return res.json(addons);
  } catch (err) {
    console.error("GET /public/addons/:scopeId:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/public/offer-settings/:slug ────────────────────────────────────
router.get("/offer-settings/:slug", rateLimit, async (req, res) => {
  const { sql: drSql } = await import("drizzle-orm");
  try {
    const slug = req.params.slug;
    const companyRow = await db.execute(drSql`SELECT id FROM companies WHERE slug = ${slug} LIMIT 1`);
    if (!companyRow.rows.length) return res.status(404).json({ error: "Company not found" });
    const companyId = (companyRow.rows[0] as any).id;
    const result = await db.execute(drSql`SELECT * FROM offer_settings WHERE company_id = ${companyId} LIMIT 1`);
    if (!result.rows.length) {
      return res.json({ upsell_enabled: true, upsell_discount_percent: 15, rate_lock_enabled: true, rate_lock_duration_months: 24, overrun_threshold_percent: 20, overrun_jobs_trigger: 2, service_gap_days: 60 });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("GET offer-settings:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/public/booking-settings/:slug ──────────────────────────────────
router.get("/booking-settings/:slug", rateLimit, async (req, res) => {
  const { sql: drSql } = await import("drizzle-orm");
  const DEFAULT = {
    booking_lead_days: 7,
    max_advance_days: 60,
    available_sun: false,
    available_mon: true,
    available_tue: true,
    available_wed: true,
    available_thu: true,
    available_fri: true,
    available_sat: false,
  };
  try {
    const slug = req.params.slug;
    const companyRow = await db.execute(drSql`SELECT id FROM companies WHERE slug = ${slug} LIMIT 1`);
    if (!companyRow.rows.length) return res.json(DEFAULT);
    const companyId = (companyRow.rows[0] as any).id;
    const result = await db.execute(drSql`SELECT * FROM booking_settings WHERE company_id = ${companyId} LIMIT 1`);
    if (!result.rows.length) return res.json(DEFAULT);
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("GET booking-settings:", err);
    return res.json(DEFAULT);
  }
});

// ── GET /api/public/service-zones/check?zip=&companySlug= ───────────────────
router.get("/service-zones/check", rateLimit, async (req, res) => {
  try {
    const { zip, companySlug } = req.query as { zip?: string; companySlug?: string };
    if (!zip || !companySlug) return res.status(400).json({ error: "zip and companySlug required" });

    const cleanZip = zip.trim().replace(/\D/g, "").slice(0, 5);
    if (cleanZip.length !== 5) return res.json({ inZone: false, zoneName: null, location: null });

    const { sql: drSql } = await import("drizzle-orm");

    const companyRows = await db.execute(drSql`
      SELECT id FROM companies WHERE slug = ${companySlug} LIMIT 1
    `);
    const company = (companyRows as any).rows?.[0];
    if (!company) return res.json({ inZone: false, zoneName: null });

    const zoneRows = await db.execute(drSql`
      SELECT id, name, location, color FROM service_zones
      WHERE company_id = ${company.id}
        AND is_active = true
        AND zip_codes @> ARRAY[${cleanZip}]::text[]
      LIMIT 1
    `);
    const zone = (zoneRows as any).rows?.[0];
    return res.json({
      inZone: !!zone,
      zoneName: zone?.name ?? null,
      location: zone?.location ?? null,
      color: zone?.color ?? null,
    });
  } catch (err) {
    console.error("GET /public/service-zones/check:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/public/bundles/:companyId ──────────────────────────────────────
router.get("/bundles/:companyId", rateLimit, async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId);
    if (isNaN(companyId)) return res.status(400).json({ error: "Invalid companyId" });

    const { sql: drSql } = await import("drizzle-orm");
    const today = new Date().toISOString().split("T")[0];
    const result = await db.execute(drSql`
      SELECT
        b.id, b.name, b.description, b.discount_type, b.discount_value,
        b.valid_from, b.valid_until,
        COALESCE(
          json_agg(
            json_build_object('addon_id', bi.addon_id, 'addon_name', pa.name, 'price_type', pa.price_type)
            ORDER BY bi.id
          ) FILTER (WHERE bi.id IS NOT NULL),
          '[]'
        ) AS items
      FROM addon_bundles b
      LEFT JOIN addon_bundle_items bi ON bi.bundle_id = b.id
      LEFT JOIN pricing_addons pa ON pa.id = bi.addon_id
      WHERE b.company_id = ${companyId}
        AND b.active = true
        AND (b.valid_from IS NULL OR b.valid_from <= ${today}::date)
        AND (b.valid_until IS NULL OR b.valid_until >= ${today}::date)
      GROUP BY b.id
      ORDER BY b.discount_value DESC
    `);
    return res.json((result as any).rows ?? []);
  } catch (err) {
    console.error("GET /public/bundles/:companyId:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Map human-readable scope name → service_type enum ───────────────────────
function scopeNameToServiceType(name: string): string {
  const n = (name || "").toLowerCase();
  if (n.includes("move out") || n.includes("move-out")) return "move_out";
  if (n.includes("move in") || n.includes("move-in")) return "move_in";
  if (n.includes("deep clean") || n.includes("move in/out")) return "deep_clean";
  if (n.includes("recurring")) return "recurring";
  if (n.includes("ppm turnover")) return "ppm_turnover";
  if (n.includes("post construction") || n.includes("post_construction")) return "post_construction";
  if (n.includes("post event") || n.includes("post_event")) return "post_event";
  if (n.includes("office") || n.includes("commercial")) return "office_cleaning";
  if (n.includes("common area")) return "common_areas";
  if (n.includes("retail")) return "retail_store";
  if (n.includes("medical")) return "medical_office";
  return "standard_clean"; // fallback
}

// ── Shared calculate logic (used by both private and public calculate) ───────
export async function runCalculate(params: {
  scope_id: number;
  sqft: number;
  frequency: string;
  addon_ids?: number[];
  discount_code?: string;
  company_id: number;
  public_only?: boolean;
}) {
  const { scope_id, sqft, frequency, addon_ids, discount_code, company_id, public_only } = params;

  const [scope] = await db
    .select()
    .from(pricingScopesTable)
    .where(and(eq(pricingScopesTable.id, scope_id), eq(pricingScopesTable.company_id, company_id)));
  if (!scope) throw Object.assign(new Error("Scope not found"), { statusCode: 404 });

  const tiers = await db
    .select()
    .from(pricingTiersTable)
    .where(and(eq(pricingTiersTable.scope_id, scope_id), eq(pricingTiersTable.company_id, company_id)));

  const sortedTiers = [...tiers].sort((a, b) => a.min_sqft - b.min_sqft);
  const tier =
    sortedTiers.find(t => sqft >= t.min_sqft && sqft <= t.max_sqft) ??
    (sqft < Number(sortedTiers[0]?.min_sqft) ? sortedTiers[0] : sortedTiers[sortedTiers.length - 1]);

  if (!tier) throw Object.assign(new Error("No tier found for the given sqft"), { statusCode: 422 });

  const base_hours = parseFloat(String(tier.hours));

  const freqs = await db
    .select()
    .from(pricingFrequenciesTable)
    .where(and(eq(pricingFrequenciesTable.scope_id, scope_id), eq(pricingFrequenciesTable.company_id, company_id)));

  const freqFactor = freqs.find(f => f.frequency === frequency);
  const scope_hourly = parseFloat(String(scope.hourly_rate));
  let hourly_rate: number;
  // One-time bookings always use the base hourly rate — never a recurring multiplier or override.
  const isOneTime = ["onetime", "one_time", "on_demand"].includes((frequency || "").toLowerCase());
  if (isOneTime) {
    hourly_rate = scope_hourly;
  } else if (freqFactor?.rate_override != null && freqFactor.rate_override !== "") {
    hourly_rate = parseFloat(String(freqFactor.rate_override));
  } else {
    const mult = freqFactor ? parseFloat(String(freqFactor.multiplier)) : 1.0;
    hourly_rate = scope_hourly * mult;
  }

  let base_price = base_hours * hourly_rate;
  const minimum_bill = parseFloat(String(scope.minimum_bill));
  let minimum_applied = false;
  if (base_price < minimum_bill) {
    base_price = minimum_bill;
    minimum_applied = true;
  }

  let addons_total = 0;
  const addon_breakdown: Array<{ id: number; name: string; amount: number; price_type: string }> = [];
  if (Array.isArray(addon_ids) && addon_ids.length > 0) {
    const { sql: drSql } = await import("drizzle-orm");
    const validIds = addon_ids.map((id: any) => parseInt(String(id))).filter((n: number) => !isNaN(n));
    const addonResult = validIds.length > 0 ? await db.execute(drSql`
      SELECT * FROM pricing_addons
       WHERE company_id = ${company_id}
         AND id = ANY(ARRAY[${drSql.raw(validIds.join(','))}]::int[])
         AND is_active = true
    `) : { rows: [] };
    const addons = (addonResult as any).rows ?? [];
    for (const addon of addons) {
      if (addon.price_type === "time_only") continue;
      let amount = 0;
      const pv = parseFloat(String(addon.price_value ?? addon.price ?? 0));
      switch (addon.price_type) {
        case "flat":       amount = pv; break;
        case "percentage":
        case "percent":    amount = (Math.abs(pv) / 100) * base_price * (pv < 0 ? -1 : 1); break;
        case "sqft_pct":   amount = sqft ? (pv / 100) * sqft : 0; break;
        case "manual_adj": amount = pv; break;
        default:
          if (addon.percent_of_base != null) {
            amount = (parseFloat(String(addon.percent_of_base)) / 100) * base_price;
          } else if (addon.price != null) {
            amount = parseFloat(String(addon.price));
          }
      }
      addons_total += amount;
      addon_breakdown.push({ id: addon.id, name: addon.name, amount: Math.round(amount * 100) / 100, price_type: addon.price_type });
    }
  }

  // ── Bundle discounts ─────────────────────────────────────────────────────
  let bundle_discount = 0;
  const bundle_breakdown: Array<{ name: string; discount: number }> = [];
  if (Array.isArray(addon_ids) && addon_ids.length > 0) {
    const { sql: drSql2 } = await import("drizzle-orm");
    const validIds = addon_ids.map((id: any) => parseInt(String(id))).filter((n: number) => !isNaN(n));
    if (validIds.length > 0) {
      const bundleResult = await db.execute(drSql2`
        SELECT ab.id, ab.name, ab.discount_type, ab.discount_value,
               array_agg(abi.addon_id) as required_ids
          FROM addon_bundles ab
          JOIN addon_bundle_items abi ON abi.bundle_id = ab.id
         WHERE ab.company_id = ${company_id} AND ab.active = true
         GROUP BY ab.id, ab.name, ab.discount_type, ab.discount_value
      `);
      const bundles = (bundleResult as any).rows ?? [];
      for (const bundle of bundles) {
        const required: number[] = (bundle.required_ids ?? []).map((x: any) => parseInt(String(x)));
        const matched = required.filter(rid => validIds.includes(rid));
        if (matched.length === required.length && matched.length > 0) {
          const dv = parseFloat(String(bundle.discount_value));
          let disc = 0;
          if (bundle.discount_type === "flat_per_item") {
            disc = dv * matched.length;
          } else if (bundle.discount_type === "flat") {
            disc = dv;
          } else if (bundle.discount_type === "percentage") {
            disc = (dv / 100) * base_price;
          }
          bundle_discount += disc;
          bundle_breakdown.push({ name: bundle.name, discount: Math.round(disc * 100) / 100 });
        }
      }
    }
  }
  addons_total -= bundle_discount;

  let subtotal = base_price + addons_total;
  let discount_amount = 0;
  let final_total = subtotal;
  let discount_valid = false;

  if (discount_code) {
    const allDiscounts = await db
      .select()
      .from(pricingDiscountsTable)
      .where(eq(pricingDiscountsTable.company_id, company_id));
    const match = allDiscounts.find(d =>
      d.code.toUpperCase() === discount_code.toUpperCase() &&
      d.is_active &&
      (!public_only || (d as any).is_online !== false)
    );
    if (match) {
      discount_valid = true;
      if (match.discount_type === "flat") {
        discount_amount = parseFloat(String(match.discount_value));
      } else {
        discount_amount = (parseFloat(String(match.discount_value)) / 100) * subtotal;
      }
      final_total = Math.max(0, subtotal - discount_amount);
    }
  }

  return {
    scope_id,
    scope_name: scope.name,
    sqft,
    frequency,
    tier_id: tier.id,
    base_hours,
    hourly_rate: Math.round(hourly_rate * 100) / 100,
    base_price: Math.round(base_price * 100) / 100,
    minimum_applied,
    addons_total: Math.round(addons_total * 100) / 100,
    addon_breakdown,
    bundle_discount: Math.round(bundle_discount * 100) / 100,
    bundle_breakdown,
    subtotal: Math.round(subtotal * 100) / 100,
    discount_amount: Math.round(discount_amount * 100) / 100,
    discount_valid: discount_code ? discount_valid : undefined,
    final_total: Math.round(final_total * 100) / 100,
  };
}

// ── POST /api/public/calculate ───────────────────────────────────────────────
router.post("/calculate", rateLimit, async (req, res) => {
  try {
    const { scope_id, sqft, frequency, addon_ids, discount_code, company_id } = req.body;
    if (!scope_id || !sqft || !frequency || !company_id) {
      return res.status(400).json({ error: "scope_id, sqft, frequency, and company_id are required" });
    }
    const result = await runCalculate({ scope_id, sqft, frequency, addon_ids, discount_code, company_id, public_only: true });
    return res.json(result);
  } catch (err: any) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error("POST /public/calculate:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/public/book/setup ─────────────────────────────────────────────
// Phase 1: Create Stripe customer + SetupIntent. Returns client_secret for card capture.
// Does NOT create any DB records yet.
router.post("/book/setup", rateLimit, async (req, res) => {
  try {
    const { company_id, email, first_name, last_name, phone } = req.body;
    if (!company_id || !email) return res.status(400).json({ error: "Missing required fields" });

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const pubKey = process.env.STRIPE_PUBLISHABLE_KEY;
    if (!stripeKey || !pubKey) {
      return res.json({ stripe_enabled: false });
    }

    const { sql: drizzleSql } = await import("drizzle-orm");
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" });

    // Check for existing client with Stripe customer
    const existing = await db.execute(
      drizzleSql`SELECT id, stripe_customer_id FROM clients WHERE email = ${email} AND company_id = ${company_id} LIMIT 1`
    );

    let customerId: string;
    if (existing.rows.length > 0 && (existing.rows[0] as any).stripe_customer_id) {
      customerId = (existing.rows[0] as any).stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email,
        name: `${first_name || ""} ${last_name || ""}`.trim(),
        phone: phone || undefined,
        metadata: { company_id: String(company_id) },
      });
      customerId = customer.id;
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      usage: "off_session",
    });

    return res.json({
      stripe_enabled: true,
      publishable_key: pubKey,
      client_secret: setupIntent.client_secret,
      customer_id: customerId,
    });
  } catch (err: any) {
    console.error("POST /public/book/setup:", err);
    return res.status(500).json({ error: "Failed to initialize payment setup" });
  }
});

// ── POST /api/public/book/confirm ────────────────────────────────────────────
// Phase 2: Card has been confirmed client-side. Store payment method + create job.
router.post("/book/confirm", rateLimit, async (req, res) => {
  try {
    const {
      company_id,
      first_name, last_name, phone, email, zip,
      referral_source,
      scope_id, sqft, frequency, addon_ids, discount_code,
      bedrooms, bathrooms, half_baths, floors, people, pets, cleanliness,
      home_condition_rating, condition_multiplier,
      applied_bundle_id, bundle_discount_total,
      last_cleaned_response, last_cleaned_flag,
      overage_disclaimer_acknowledged, overage_rate,
      upsell_shown, upsell_accepted, upsell_declined, upsell_deferred,
      upsell_cadence_selected, upsell_locked_rate, upsell_first_visit_rate,
      recurring_date,
      arrival_window,
      property_vacant, move_in_notes,
      address, preferred_date,
      payment_method_id, stripe_customer_id,
      booking_location,
      address_street, address_city, address_state, address_zip,
      address_lat, address_lng, address_verified,
    } = req.body;

    if (!company_id || !first_name || !last_name || !phone || !email || !scope_id || !sqft || !frequency) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey || !payment_method_id) {
      return res.status(400).json({ error: "Card verification required" });
    }

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" });

    // Retrieve payment method details (card last4, brand)
    let cardLast4: string | null = null;
    let cardBrand: string | null = null;
    let cardExpiry: string | null = null;
    try {
      const pm = await stripe.paymentMethods.retrieve(payment_method_id);
      cardLast4 = pm.card?.last4 || null;
      cardBrand = pm.card?.brand || null;
      cardExpiry = pm.card?.exp_month && pm.card?.exp_year
        ? `${String(pm.card.exp_month).padStart(2, "0")}/${pm.card.exp_year}`
        : null;
      // Attach to customer if not already attached
      if (stripe_customer_id && !pm.customer) {
        await stripe.paymentMethods.attach(payment_method_id, { customer: stripe_customer_id });
        await stripe.customers.update(stripe_customer_id, {
          invoice_settings: { default_payment_method: payment_method_id },
        });
      }
    } catch (pmErr: any) {
      console.error("Stripe PM retrieve error:", pmErr);
      return res.status(422).json({
        error: "We were unable to verify your card. Please check your details or use a different card.",
      });
    }

    const pricing = await runCalculate({ scope_id, sqft, frequency, addon_ids, discount_code, company_id, public_only: true });
    const { sql: drizzleSql } = await import("drizzle-orm");

    // Find or create client
    const existingClients = await db.execute(
      drizzleSql`SELECT id FROM clients WHERE email = ${email} AND company_id = ${company_id} LIMIT 1`
    );

    let clientId: number;
    if (existingClients.rows.length > 0) {
      clientId = (existingClients.rows[0] as any).id;
      await db.execute(
        drizzleSql`UPDATE clients SET
          stripe_customer_id = COALESCE(stripe_customer_id, ${stripe_customer_id || null}),
          stripe_payment_method_id = ${payment_method_id},
          payment_source = 'stripe',
          card_last_four = ${cardLast4},
          card_brand = ${cardBrand},
          card_expiry = ${cardExpiry},
          card_saved_at = NOW()
          WHERE id = ${clientId}`
      );
    } else {
      const newClient = await db.execute(
        drizzleSql`
          INSERT INTO clients (
            company_id, first_name, last_name, phone, email,
            referral_source,
            stripe_customer_id, stripe_payment_method_id, payment_source,
            card_last_four, card_brand, card_expiry, card_saved_at, created_at
          ) VALUES (
            ${company_id}, ${first_name}, ${last_name}, ${phone}, ${email},
            ${referral_source || null},
            ${stripe_customer_id || null}, ${payment_method_id}, 'stripe',
            ${cardLast4}, ${cardBrand}, ${cardExpiry}, NOW(), NOW()
          ) RETURNING id
        `
      );
      clientId = (newClient.rows[0] as any).id;
    }

    const homeResult = await db.execute(
      drizzleSql`
        INSERT INTO client_homes (company_id, client_id, address, zip, bedrooms, bathrooms, sq_footage, is_primary, created_at)
        VALUES (${company_id}, ${clientId}, ${address || null}, ${zip || null}, ${bedrooms || null}, ${bathrooms || null}, ${sqft || null}, true, NOW())
        RETURNING id
      `
    );
    const homeId = (homeResult.rows[0] as any).id;

    const addonBreakdownJson = JSON.stringify(pricing.addon_breakdown);
    const scopeRow = await db.execute(drizzleSql`SELECT name FROM pricing_scopes WHERE id = ${scope_id} LIMIT 1`);
    const scopeName = (scopeRow.rows[0] as any)?.name || "Cleaning";
    const serviceTypeEnum = scopeNameToServiceType(scopeName);
    const condMult = parseFloat(String(condition_multiplier || 1)) || 1;
    const condRating = parseInt(String(home_condition_rating || 1)) || 1;
    const adjustedTotal = Math.round(pricing.final_total * condMult * 100) / 100;
    // Normalize frequency to match jobs.frequency enum: weekly|biweekly|every_3_weeks|monthly|on_demand
    const normalizeFreq = (f: string) => {
      const v = (f || "").toLowerCase().replace(/[\s-]/g, "_");
      if (v === "onetime" || v === "one_time" || v === "one_time_standard" || v === "on_demand") return "on_demand";
      if (v === "biweekly" || v === "every_2_weeks") return "biweekly";
      if (v === "every_3_weeks") return "every_3_weeks";
      if (v === "monthly" || v === "every_4_weeks") return "monthly";
      if (v === "weekly") return "weekly";
      return "on_demand";
    };
    const normalizedFreq = normalizeFreq(frequency);
    const jobNotes = `Booked via online widget. Cleanliness: ${cleanliness || "N/A"}. Condition rating: ${condRating}. People: ${people || "N/A"}. Floors: ${floors || "N/A"}. Home ID: ${homeId}.`;

    const bundleId = applied_bundle_id ? parseInt(String(applied_bundle_id)) : null;
    const bundleDiscount = bundle_discount_total ? parseFloat(String(bundle_discount_total)) : null;

    const lastCleanedResp = last_cleaned_response || null;
    const lastCleanedFl = last_cleaned_flag || null;
    const overageAck = overage_disclaimer_acknowledged === true || overage_disclaimer_acknowledged === "true" ? true : false;
    const overageRateVal = overage_rate ? parseFloat(String(overage_rate)) : null;
    const upsellShownVal = upsell_shown === true || upsell_shown === "true" ? true : false;
    const upsellAcceptedVal = upsell_accepted === true || upsell_accepted === "true" ? true : false;
    const upsellDeclinedVal = upsell_declined === true || upsell_declined === "true" ? true : false;
    const upsellDeferredVal = upsell_deferred === true || upsell_deferred === "true" ? true : false;
    const upsellCadenceVal = upsell_cadence_selected || null;
    const propertyVacantVal = property_vacant === true || property_vacant === "true" ? true : false;
    const arrivalWindowVal = (arrival_window === "morning" || arrival_window === "afternoon") ? arrival_window : null;

    const bookLocVal = (booking_location === "oak_lawn" || booking_location === "schaumburg") ? booking_location : null;
    const addrStreet = address_street || null;
    const addrCity = address_city || null;
    const addrState = address_state || null;
    const addrZip = address_zip || zip || null;
    const addrLat = address_lat ? parseFloat(String(address_lat)) : null;
    const addrLng = address_lng ? parseFloat(String(address_lng)) : null;
    const addrVerified = address_verified === true || address_verified === "true" ? true : false;

    const jobResult = await db.execute(
      drizzleSql`
        INSERT INTO jobs (
          company_id, client_id, service_type, status,
          scheduled_date, frequency, base_fee, estimated_hours, hourly_rate,
          home_condition_rating, condition_multiplier,
          applied_bundle_id, bundle_discount_total,
          last_cleaned_response, last_cleaned_flag,
          overage_disclaimer_acknowledged, overage_rate,
          upsell_shown, upsell_accepted, upsell_declined, upsell_deferred, upsell_cadence_selected,
          property_vacant, arrival_window,
          booking_location,
          address_street, address_city, address_state, address_zip,
          address_lat, address_lng, address_verified,
          notes, created_at
        ) VALUES (
          ${company_id}, ${clientId}, ${serviceTypeEnum}, 'unassigned',
          ${preferred_date || null}, ${normalizedFreq},
          ${adjustedTotal}, ${pricing.base_hours}, ${pricing.hourly_rate},
          ${condRating}, ${condMult},
          ${bundleId}, ${bundleDiscount},
          ${lastCleanedResp}, ${lastCleanedFl},
          ${overageAck}, ${overageRateVal},
          ${upsellShownVal}, ${upsellAcceptedVal}, ${upsellDeclinedVal}, ${upsellDeferredVal}, ${upsellCadenceVal},
          ${propertyVacantVal}, ${arrivalWindowVal},
          ${bookLocVal},
          ${addrStreet}, ${addrCity}, ${addrState}, ${addrZip},
          ${addrLat}, ${addrLng}, ${addrVerified},
          ${jobNotes}, NOW()
        ) RETURNING id
      `
    );
    const jobId = (jobResult.rows[0] as any).id;

    // ── Upsell accepted: create Job 2 (recurring start) + recurring_schedule + rate_lock ───
    let recurringJobId: number | null = null;
    if (upsellAcceptedVal && upsellCadenceVal && upsell_locked_rate) {
      const lockedRate = parseFloat(String(upsell_locked_rate));
      const firstVisitRate = upsell_first_visit_rate ? parseFloat(String(upsell_first_visit_rate)) : lockedRate;
      const recurringDateVal = recurring_date || null;
      const lockStart = recurringDateVal || new Date().toISOString().split("T")[0];
      const lockExpiry = new Date(lockStart + "T12:00:00");
      lockExpiry.setMonth(lockExpiry.getMonth() + 24);
      const lockExpiryStr = lockExpiry.toISOString().split("T")[0];
      const normalizedRecurFreq = normalizeFreq(upsellCadenceVal);
      try {
        // Create recurring_schedule with actual start date
        const recurSchedule = await db.execute(
          drizzleSql`
            INSERT INTO recurring_schedules (company_id, customer_id, frequency, start_date, service_type, base_fee, notes, is_active, created_at)
            VALUES (${company_id}, ${clientId}, ${upsellCadenceVal}::recurring_frequency, ${lockStart}::date, ${"recurring"}, ${lockedRate}, ${"Upsell accepted from online booking widget."}, true, NOW())
            RETURNING id
          `
        );
        const scheduleId = (recurSchedule.rows[0] as any).id;
        await db.execute(
          drizzleSql`
            INSERT INTO rate_locks (company_id, client_id, recurring_schedule_id, locked_rate, cadence, lock_start_date, lock_expires_at, active, created_at)
            VALUES (${company_id}, ${clientId}, ${scheduleId}, ${lockedRate}, ${upsellCadenceVal}, ${lockStart}::date, ${lockExpiryStr}::date, true, NOW())
          `
        );
        // Create Job 2: first recurring visit (discounted rate, no add-ons)
        if (recurringDateVal) {
          const recurJobNotes = `Recurring start (upsell). Rate locked at $${lockedRate}/visit for 24 months. First visit discounted 15% off. Schedule ID: ${scheduleId}. Home ID: ${homeId}.`;
          const recurJobResult = await db.execute(
            drizzleSql`
              INSERT INTO jobs (
                company_id, client_id, service_type, status,
                scheduled_date, frequency, base_fee,
                upsell_shown, upsell_accepted, upsell_cadence_selected,
                arrival_window,
                booking_location,
                address_street, address_city, address_state, address_zip,
                address_lat, address_lng, address_verified,
                notes, created_at
              ) VALUES (
                ${company_id}, ${clientId}, ${"recurring"}, ${"unassigned"},
                ${recurringDateVal}::date, ${normalizedRecurFreq}, ${firstVisitRate},
                false, false, ${upsellCadenceVal},
                ${arrivalWindowVal},
                ${bookLocVal},
                ${addrStreet}, ${addrCity}, ${addrState}, ${addrZip},
                ${addrLat}, ${addrLng}, ${addrVerified},
                ${recurJobNotes}, NOW()
              ) RETURNING id
            `
          );
          recurringJobId = (recurJobResult.rows[0] as any).id;
        }
        console.log(`[UPSELL] Rate lock + recurring job created — client_id=${clientId} schedule_id=${scheduleId} recurring_job_id=${recurringJobId} rate=${lockedRate} first_visit_rate=${firstVisitRate} cadence=${upsellCadenceVal} expires=${lockExpiryStr}`);
      } catch (upsellErr) {
        console.error("[UPSELL] Failed to create recurring_schedule/rate_lock/job2:", upsellErr);
      }
    }

    await db.execute(
      drizzleSql`
        INSERT INTO quotes (
          company_id, client_id, scope_id, sqft, frequency,
          base_price, discount_amount, discount_code, total_price,
          estimated_hours, addons, status, booked_job_id,
          bedrooms, bathrooms, pets, notes, created_at
        ) VALUES (
          ${company_id}, ${clientId}, ${scope_id}, ${sqft}, ${frequency},
          ${pricing.base_price}, ${pricing.discount_amount}, ${discount_code || null}, ${pricing.final_total},
          ${pricing.base_hours}, ${addonBreakdownJson}::jsonb, 'booked', ${jobId},
          ${bedrooms || null}, ${bathrooms || null}, ${pets || null},
          ${`Online booking: ${scopeName}, ${sqft} sqft, ${frequency}`},
          NOW()
        )
      `
    );

    // ── Create lead record (booking_widget source) ────────────────────────────
    try {
      const scopeLabel = scopeName;
      await db.execute(drizzleSql`
        INSERT INTO leads (
          company_id, first_name, last_name, phone, email, address, zip,
          scope, source, status, job_id, booked_at, created_at, updated_at
        ) VALUES (
          ${company_id}, ${first_name}, ${last_name}, ${phone}, ${email},
          ${address || null}, ${zip || null},
          ${scopeLabel}, 'booking_widget', 'booked', ${jobId}, NOW(), NOW(), NOW()
        )
      `);
      // Remove any abandoned booking for this email
      await db.execute(drizzleSql`
        DELETE FROM abandoned_bookings WHERE company_id = ${company_id} AND email = ${email}
      `);
    } catch (leadErr) {
      console.error("[confirm] Failed to create lead record:", leadErr);
    }

    // ── Confirmation emails ───────────────────────────────────────────────────
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      try {
        const { Resend } = await import("resend");
        const resend = new Resend(resendKey);
        const dateStr = preferred_date
          ? new Date(preferred_date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
          : "To be scheduled";
        const recurDateStr = recurring_date
          ? new Date(recurring_date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
          : null;
        const recurCadenceLabel = upsellCadenceVal === "weekly" ? "week" : upsellCadenceVal === "biweekly" ? "2 weeks" : "4 weeks";
        const arrivalWindowLabel = arrivalWindowVal === "morning" ? "9 AM – 12 PM" : arrivalWindowVal === "afternoon" ? "12 PM – 2 PM" : null;
        const recurLockedRate = upsell_locked_rate ? parseFloat(String(upsell_locked_rate)).toFixed(2) : null;
        const cardStr = cardLast4 ? `${(cardBrand || "Card").charAt(0).toUpperCase() + (cardBrand || "card").slice(1)} ending in ${cardLast4}` : "Card on file";
        const freqStr = frequency ? frequency.charAt(0).toUpperCase() + frequency.slice(1) : "";

        // Customer confirmation
        await resend.emails.send({
          from: "PHES Cleaning <noreply@phes.io>",
          to: [email],
          subject: "Your Cleaning Appointment is Confirmed",
          html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#F7F6F3;">
<div style="background:#fff;border:1px solid #E5E2DC;border-radius:8px;padding:32px;">
<div style="background:#5B9BD5;padding:16px 24px;border-radius:4px;margin-bottom:24px;">
  <span style="color:#fff;font-size:18px;font-weight:bold;">You're all set, ${first_name}!</span>
</div>
<p style="color:#1A1917;font-size:15px;margin:0 0 20px;">Your cleaning appointment has been confirmed. Here's a summary:</p>
<table style="width:100%;border-collapse:collapse;font-size:14px;color:#1A1917;">
  <tr><td style="padding:8px 0;color:#6B6860;width:160px;">Service</td><td style="padding:8px 0;font-weight:600;">${scopeName}${upsellAcceptedVal ? " + Recurring" : ""}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Deep Clean Date</td><td style="padding:8px 0;font-weight:600;">${dateStr}</td></tr>
  ${arrivalWindowLabel ? `<tr><td style="padding:8px 0;color:#6B6860;">Arrival Window</td><td style="padding:8px 0;">${arrivalWindowLabel}</td></tr>` : ""}
  ${upsellAcceptedVal && recurDateStr ? `<tr><td style="padding:8px 0;color:#6B6860;">First Recurring</td><td style="padding:8px 0;font-weight:600;">${recurDateStr}</td></tr>` : ""}
  ${upsellAcceptedVal && recurDateStr && recurLockedRate ? `<tr><td style="padding:8px 0;color:#6B6860;vertical-align:top;">Rate Lock</td><td style="padding:8px 0;">$${recurLockedRate}/visit every ${recurCadenceLabel} — locked for 24 months</td></tr>` : ""}
  ${!upsellAcceptedVal ? `<tr><td style="padding:8px 0;color:#6B6860;">Frequency</td><td style="padding:8px 0;">${freqStr}</td></tr>` : ""}
  <tr><td style="padding:8px 0;color:#6B6860;">Address</td><td style="padding:8px 0;">${address || "On file"}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Estimated Total</td><td style="padding:8px 0;font-weight:600;">$${adjustedTotal.toFixed(2)}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Payment</td><td style="padding:8px 0;">${cardStr}</td></tr>
</table>
${upsellAcceptedVal && recurDateStr ? `<p style="background:#F0F7FF;border-left:3px solid #5B9BD5;padding:10px 14px;font-size:13px;color:#1A1917;margin:20px 0 0;">Your Deep Clean is scheduled for <strong>${dateStr}</strong>. Your first recurring cleaning is scheduled for <strong>${recurDateStr}</strong>, then every ${recurCadenceLabel} from there — your rate is locked at $${recurLockedRate}/visit for 24 months.</p>` : ""}
<p style="color:#6B6860;font-size:13px;margin:24px 0 0;">Questions? Call us at (773) 706-6000 or reply to this email. We look forward to seeing you!</p>
</div></div>`,
        });

        // Internal notification
        await resend.emails.send({
          from: "Qleno <noreply@phes.io>",
          to: ["info@phes.io"],
          subject: `New Online Booking — ${first_name} ${last_name} — Job #${jobId}${recurringJobId ? ` + #${recurringJobId}` : ""}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#F7F6F3;">
<div style="background:#fff;border:1px solid #E5E2DC;border-radius:8px;padding:32px;">
<div style="background:#5B9BD5;padding:16px 24px;border-radius:4px;margin-bottom:24px;">
  <span style="color:#fff;font-size:18px;font-weight:bold;">New Online Booking — Job #${jobId}${recurringJobId ? ` + Recurring #${recurringJobId}` : ""}</span>
</div>
<table style="width:100%;border-collapse:collapse;font-size:14px;color:#1A1917;">
  <tr><td style="padding:8px 0;color:#6B6860;width:160px;">Customer</td><td style="padding:8px 0;font-weight:600;">${first_name} ${last_name}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Phone</td><td style="padding:8px 0;">${phone}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Email</td><td style="padding:8px 0;">${email}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Address</td><td style="padding:8px 0;">${address || "Not provided"}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Service</td><td style="padding:8px 0;">${scopeName}${upsellAcceptedVal ? " + Recurring (upsell)" : ""} — ${sqft} sqft</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Deep Clean Date</td><td style="padding:8px 0;font-weight:600;">${dateStr}</td></tr>
  ${arrivalWindowLabel ? `<tr><td style="padding:8px 0;color:#6B6860;">Arrival Window</td><td style="padding:8px 0;">${arrivalWindowLabel}</td></tr>` : ""}
  ${recurDateStr ? `<tr><td style="padding:8px 0;color:#6B6860;">First Recurring</td><td style="padding:8px 0;font-weight:600;">${recurDateStr}</td></tr>` : ""}
  ${recurLockedRate ? `<tr><td style="padding:8px 0;color:#6B6860;">Locked Rate</td><td style="padding:8px 0;">$${recurLockedRate}/visit every ${recurCadenceLabel} for 24 months</td></tr>` : ""}
  <tr><td style="padding:8px 0;color:#6B6860;">Deep Clean Total</td><td style="padding:8px 0;font-weight:600;">$${adjustedTotal.toFixed(2)}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Payment</td><td style="padding:8px 0;">${cardStr}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Client ID</td><td style="padding:8px 0;">#${clientId}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Job #1 (Deep Clean)</td><td style="padding:8px 0;">#${jobId} — UNASSIGNED</td></tr>
  ${recurringJobId ? `<tr><td style="padding:8px 0;color:#6B6860;">Job #2 (Recurring)</td><td style="padding:8px 0;">#${recurringJobId} — UNASSIGNED</td></tr>` : ""}
</table>
</div></div>`,
        });
      } catch (emailErr) {
        console.error("[confirm] Resend error:", emailErr);
      }
    }

    // ── Office SMS notification on confirm ───────────────────────────────────
    try {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken  = process.env.TWILIO_AUTH_TOKEN;
      const fromNum    = process.env.TWILIO_FROM_NUMBER;
      if (accountSid && authToken && fromNum) {
        const dateStr2 = preferred_date
          ? new Date(preferred_date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
          : "TBD";
        const windowLabel = arrivalWindowVal === "morning" ? "9AM–12PM" : arrivalWindowVal === "afternoon" ? "12PM–2PM" : "";
        const smsBody = `📋 New Booking — ${first_name} ${last_name} | ${scopeName} | ${sqft} sqft | ${dateStr2}${windowLabel ? ` ${windowLabel}` : ""} | Job #${jobId}${recurringJobId ? ` + #${recurringJobId}` : ""}`;
        const smsRes = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ To: "+17737869902", From: fromNum, Body: smsBody }).toString(),
          }
        );
        if (!smsRes.ok) console.error("[confirm] Twilio SMS failed:", await smsRes.text());
      }
    } catch (smsErr) {
      console.error("[confirm] Office SMS error:", smsErr);
    }

    console.log(`[STRIPE] Booking confirmed — client_id=${clientId} job_id=${jobId}${recurringJobId ? ` recurring_job_id=${recurringJobId}` : ""} PM=${payment_method_id} card=${cardBrand} *${cardLast4}`);
    return res.status(201).json({
      ok: true,
      client_id: clientId,
      job_id: jobId,
      recurring_job_id: recurringJobId,
      home_id: homeId,
      pricing,
      card_last4: cardLast4,
      card_brand: cardBrand,
    });
  } catch (err: any) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error("POST /public/book/confirm:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/public/book ─── (legacy / Stripe-disabled fallback) ─────────────
router.post("/book", rateLimit, async (req, res) => {
  try {
    const {
      company_id,
      first_name, last_name, phone, email, zip,
      referral_source, sms_consent,
      scope_id, sqft, frequency, addon_ids, discount_code,
      bedrooms, bathrooms, half_baths, floors, people, pets, cleanliness,
      address, preferred_date,
      booking_location,
      address_street, address_city, address_state, address_zip,
      address_lat, address_lng, address_verified,
    } = req.body;

    if (!company_id || !first_name || !last_name || !phone || !email || !scope_id || !sqft || !frequency) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (stripeKey) {
      return res.status(400).json({ error: "Card verification required. Please use the booking widget." });
    }

    const pricing = await runCalculate({ scope_id, sqft, frequency, addon_ids, discount_code, company_id, public_only: true });
    const { sql: drizzleSql } = await import("drizzle-orm");

    const existingClients = await db.execute(
      drizzleSql`SELECT id FROM clients WHERE email = ${email} AND company_id = ${company_id} LIMIT 1`
    );

    let clientId: number;
    if (existingClients.rows.length > 0) {
      clientId = (existingClients.rows[0] as any).id;
    } else {
      const newClient = await db.execute(
        drizzleSql`
          INSERT INTO clients (company_id, first_name, last_name, phone, email, referral_source, sms_consent, created_at)
          VALUES (${company_id}, ${first_name}, ${last_name}, ${phone}, ${email}, ${referral_source || null}, ${sms_consent ? true : false}, NOW())
          RETURNING id
        `
      );
      clientId = (newClient.rows[0] as any).id;
    }

    const homeResult = await db.execute(
      drizzleSql`
        INSERT INTO client_homes (company_id, client_id, address, zip, bedrooms, bathrooms, sq_footage, is_primary, created_at)
        VALUES (${company_id}, ${clientId}, ${address || null}, ${zip || null}, ${bedrooms || null}, ${bathrooms || null}, ${sqft || null}, true, NOW())
        RETURNING id
      `
    );
    const homeId = (homeResult.rows[0] as any).id;

    const addonBreakdownJson = JSON.stringify(pricing.addon_breakdown);
    const scopeRow = await db.execute(drizzleSql`SELECT name FROM pricing_scopes WHERE id = ${scope_id} LIMIT 1`);
    const scopeName = (scopeRow.rows[0] as any)?.name || "Cleaning";
    const jobNotes = `Booked via online widget. Cleanliness: ${cleanliness || "N/A"}. People: ${people || "N/A"}. Floors: ${floors || "N/A"}. Home ID: ${homeId}.`;

    const legBookLoc = (booking_location === "oak_lawn" || booking_location === "schaumburg") ? booking_location : null;
    const legAddrStreet = address_street || null;
    const legAddrCity = address_city || null;
    const legAddrState = address_state || null;
    const legAddrZip = address_zip || zip || null;
    const legAddrLat = address_lat ? parseFloat(String(address_lat)) : null;
    const legAddrLng = address_lng ? parseFloat(String(address_lng)) : null;
    const legAddrVerified = address_verified === true || address_verified === "true" ? true : false;
    const legNormFreq = (() => {
      const v = (frequency || "").toLowerCase().replace(/[\s-]/g, "_");
      if (v === "onetime" || v === "one_time" || v === "one_time_standard") return "on_demand";
      if (v === "biweekly" || v === "every_2_weeks") return "biweekly";
      if (v === "every_3_weeks") return "every_3_weeks";
      if (v === "monthly" || v === "every_4_weeks") return "monthly";
      if (v === "weekly") return "weekly";
      return "on_demand";
    })();
    const jobResult = await db.execute(
      drizzleSql`
        INSERT INTO jobs (
          company_id, client_id, service_type, status,
          scheduled_date, frequency, base_fee, estimated_hours, hourly_rate,
          booking_location, address_street, address_city, address_state, address_zip,
          address_lat, address_lng, address_verified,
          notes, created_at
        ) VALUES (
          ${company_id}, ${clientId}, ${scopeName}, 'unassigned',
          ${preferred_date || null}, ${legNormFreq}, ${pricing.final_total}, ${pricing.base_hours}, ${pricing.hourly_rate},
          ${legBookLoc}, ${legAddrStreet}, ${legAddrCity}, ${legAddrState}, ${legAddrZip},
          ${legAddrLat}, ${legAddrLng}, ${legAddrVerified},
          ${jobNotes}, NOW()
        ) RETURNING id
      `
    );
    const jobId = (jobResult.rows[0] as any).id;

    await db.execute(
      drizzleSql`
        INSERT INTO quotes (
          company_id, client_id, scope_id, sqft, frequency,
          base_price, discount_amount, discount_code, total_price,
          estimated_hours, addons, status, booked_job_id,
          bedrooms, bathrooms, pets, notes, created_at
        ) VALUES (
          ${company_id}, ${clientId}, ${scope_id}, ${sqft}, ${frequency},
          ${pricing.base_price}, ${pricing.discount_amount}, ${discount_code || null}, ${pricing.final_total},
          ${pricing.base_hours}, ${addonBreakdownJson}::jsonb, 'booked', ${jobId},
          ${bedrooms || null}, ${bathrooms || null}, ${pets || null},
          ${`Online booking: ${scopeName}, ${sqft} sqft, ${frequency}`},
          NOW()
        )
      `
    );

    return res.status(201).json({ ok: true, client_id: clientId, job_id: jobId, home_id: homeId, pricing });
  } catch (err: any) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error("POST /public/book:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/public/book/walkthrough ─────────────────────────────────────────
// Commercial walkthrough: no Stripe, sends alert email to info@phes.io
router.post("/book/walkthrough", rateLimit, async (req, res) => {
  try {
    const {
      company_id, first_name, last_name, phone, email, zip,
      referral_source, sms_consent, address, preferred_date,
      booking_location,
      address_street, address_city, address_state, address_zip,
      address_lat, address_lng, address_verified,
    } = req.body;

    if (!company_id || !first_name || !last_name || !phone || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { sql: drizzleSql } = await import("drizzle-orm");

    const existingClients = await db.execute(
      drizzleSql`SELECT id FROM clients WHERE email = ${email} AND company_id = ${company_id} LIMIT 1`
    );
    let clientId: number;
    if (existingClients.rows.length > 0) {
      clientId = (existingClients.rows[0] as any).id;
    } else {
      const newClient = await db.execute(
        drizzleSql`
          INSERT INTO clients (company_id, first_name, last_name, phone, email, referral_source, address, created_at)
          VALUES (${company_id}, ${first_name}, ${last_name}, ${phone}, ${email}, ${referral_source || null}, ${address || null}, NOW())
          RETURNING id
        `
      );
      clientId = (newClient.rows[0] as any).id;
    }

    const jobNotes = `Commercial Walkthrough — booked via online widget. Address: ${address || "N/A"}.`;
    const wtBookLoc = (booking_location === "oak_lawn" || booking_location === "schaumburg") ? booking_location : null;
    const wtAddrStreet = address_street || null;
    const wtAddrCity = address_city || null;
    const wtAddrState = address_state || null;
    const wtAddrZip = address_zip || zip || null;
    const wtAddrLat = address_lat ? parseFloat(String(address_lat)) : null;
    const wtAddrLng = address_lng ? parseFloat(String(address_lng)) : null;
    const wtAddrVerified = address_verified === true || address_verified === "true" ? true : false;
    const jobResult = await db.execute(
      drizzleSql`
        INSERT INTO jobs (
          company_id, client_id, service_type, status, scheduled_date, frequency, base_fee, estimated_hours, hourly_rate,
          booking_location, address_street, address_city, address_state, address_zip, address_lat, address_lng, address_verified,
          notes, created_at
        ) VALUES (
          ${company_id}, ${clientId}, 'office_cleaning', 'scheduled', ${preferred_date || null}, 'on_demand', 0, 0, 0,
          ${wtBookLoc}, ${wtAddrStreet}, ${wtAddrCity}, ${wtAddrState}, ${wtAddrZip}, ${wtAddrLat}, ${wtAddrLng}, ${wtAddrVerified},
          ${jobNotes}, NOW()
        ) RETURNING id
      `
    );
    const jobId = (jobResult.rows[0] as any).id;

    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      try {
        const { Resend } = await import("resend");
        const resend = new Resend(resendKey);
        const dateStr = preferred_date
          ? new Date(preferred_date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
          : "Not specified";
        await resend.emails.send({
          from: "Qleno <noreply@phes.io>",
          to: ["info@phes.io"],
          subject: "New Commercial Walkthrough Request",
          html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#F7F6F3;">
<div style="background:#fff;border:1px solid #E5E2DC;border-radius:8px;padding:32px;">
<div style="background:#5B9BD5;padding:16px 24px;border-radius:4px;margin-bottom:24px;">
  <span style="color:#fff;font-size:18px;font-weight:bold;">Phes — New Walkthrough Request</span>
</div>
<table style="width:100%;border-collapse:collapse;font-size:14px;color:#1A1917;">
  <tr><td style="padding:8px 0;color:#6B6860;width:140px;">Name</td><td style="padding:8px 0;font-weight:600;">${first_name} ${last_name}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Phone</td><td style="padding:8px 0;">${phone}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Email</td><td style="padding:8px 0;">${email}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Address</td><td style="padding:8px 0;">${address || "Not provided"}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Appointment</td><td style="padding:8px 0;font-weight:600;">${dateStr}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Source</td><td style="padding:8px 0;">Booking Widget — Commercial Walkthrough</td></tr>
</table>
</div></div>`,
        });
      } catch (emailErr) {
        console.error("[walkthrough] Resend error:", emailErr);
      }
    }

    console.log(`[WALKTHROUGH] Booked — client_id=${clientId} job_id=${jobId}`);
    return res.status(201).json({ ok: true, client_id: clientId, job_id: jobId });
  } catch (err: any) {
    console.error("POST /public/book/walkthrough:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/public/book/commercial-confirm ───────────────────────────────────
// Commercial single-visit: $180 flat, Stripe card capture required
router.post("/book/commercial-confirm", rateLimit, async (req, res) => {
  try {
    const {
      company_id, first_name, last_name, phone, email, zip,
      referral_source, sms_consent, address, preferred_date,
      payment_method_id, stripe_customer_id,
      booking_location,
      address_street, address_city, address_state, address_zip,
      address_lat, address_lng, address_verified,
    } = req.body;

    if (!company_id || !first_name || !last_name || !phone || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey || !payment_method_id) {
      return res.status(400).json({ error: "Card verification required" });
    }

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" });

    let cardLast4: string | null = null;
    let cardBrand: string | null = null;
    let cardExpiry: string | null = null;
    try {
      const pm = await stripe.paymentMethods.retrieve(payment_method_id);
      cardLast4 = pm.card?.last4 || null;
      cardBrand = pm.card?.brand || null;
      cardExpiry = pm.card?.exp_month && pm.card?.exp_year
        ? `${String(pm.card.exp_month).padStart(2, "0")}/${pm.card.exp_year}` : null;
      if (stripe_customer_id && !pm.customer) {
        await stripe.paymentMethods.attach(payment_method_id, { customer: stripe_customer_id });
        await stripe.customers.update(stripe_customer_id, { invoice_settings: { default_payment_method: payment_method_id } });
      }
    } catch {
      return res.status(422).json({ error: "We were unable to verify your card. Please check your details or use a different card." });
    }

    const { sql: drizzleSql } = await import("drizzle-orm");
    const existingClients = await db.execute(
      drizzleSql`SELECT id FROM clients WHERE email = ${email} AND company_id = ${company_id} LIMIT 1`
    );
    let clientId: number;
    if (existingClients.rows.length > 0) {
      clientId = (existingClients.rows[0] as any).id;
      await db.execute(
        drizzleSql`UPDATE clients SET stripe_customer_id = COALESCE(stripe_customer_id, ${stripe_customer_id || null}), stripe_payment_method_id = ${payment_method_id}, payment_source = 'stripe', card_last_four = ${cardLast4}, card_brand = ${cardBrand}, card_expiry = ${cardExpiry}, card_saved_at = NOW() WHERE id = ${clientId}`
      );
    } else {
      const newClient = await db.execute(
        drizzleSql`
          INSERT INTO clients (company_id, first_name, last_name, phone, email, referral_source, stripe_customer_id, stripe_payment_method_id, payment_source, card_last_four, card_brand, card_expiry, card_saved_at, created_at)
          VALUES (${company_id}, ${first_name}, ${last_name}, ${phone}, ${email}, ${referral_source || null}, ${stripe_customer_id || null}, ${payment_method_id}, 'stripe', ${cardLast4}, ${cardBrand}, ${cardExpiry}, NOW(), NOW())
          RETURNING id
        `
      );
      clientId = (newClient.rows[0] as any).id;
    }

    const jobNotes = `Commercial Single Visit — booked via online widget. Address: ${address || "N/A"}. $180 for up to 3 hours, $60/additional hour.`;
    const cBookLoc = (booking_location === "oak_lawn" || booking_location === "schaumburg") ? booking_location : null;
    const cAddrStreet = address_street || null;
    const cAddrCity = address_city || null;
    const cAddrState = address_state || null;
    const cAddrZip = address_zip || zip || null;
    const cAddrLat = address_lat ? parseFloat(String(address_lat)) : null;
    const cAddrLng = address_lng ? parseFloat(String(address_lng)) : null;
    const cAddrVerified = address_verified === true || address_verified === "true" ? true : false;
    const jobResult = await db.execute(
      drizzleSql`
        INSERT INTO jobs (
          company_id, client_id, service_type, status, scheduled_date, frequency, base_fee, estimated_hours, hourly_rate,
          booking_location, address_street, address_city, address_state, address_zip, address_lat, address_lng, address_verified,
          notes, created_at
        ) VALUES (
          ${company_id}, ${clientId}, 'office_cleaning', 'scheduled', ${preferred_date || null}, 'on_demand', 180, 3, 60,
          ${cBookLoc}, ${cAddrStreet}, ${cAddrCity}, ${cAddrState}, ${cAddrZip}, ${cAddrLat}, ${cAddrLng}, ${cAddrVerified},
          ${jobNotes}, NOW()
        ) RETURNING id
      `
    );
    const jobId = (jobResult.rows[0] as any).id;

    console.log(`[COMMERCIAL] Single visit confirmed — client_id=${clientId} job_id=${jobId} card=${cardBrand} *${cardLast4}`);
    return res.status(201).json({ ok: true, client_id: clientId, job_id: jobId, pricing: { final_total: 180 }, card_last4: cardLast4, card_brand: cardBrand });
  } catch (err: any) {
    console.error("POST /public/book/commercial-confirm:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/public/book/abandon-track ──────────────────────────────────────
// Called from the booking widget when a user completes Step 1 but hasn't paid yet.
// Upserts an abandoned_bookings record so office can follow up if they leave.
router.post("/book/abandon-track", rateLimit, async (req, res) => {
  try {
    const { company_id, first_name, last_name, email, phone, address, zip, scope, step_abandoned = 2 } = req.body;
    if (!company_id) return res.status(400).json({ error: "company_id required" });
    const { sql: drizzleSql } = await import("drizzle-orm");
    if (email) {
      const existing = await db.execute(
        drizzleSql`SELECT id FROM abandoned_bookings WHERE company_id = ${company_id} AND email = ${email} LIMIT 1`
      );
      if (existing.rows.length > 0) {
        await db.execute(drizzleSql`
          UPDATE abandoned_bookings SET
            first_name = COALESCE(${first_name || null}, first_name),
            last_name  = COALESCE(${last_name || null}, last_name),
            phone      = COALESCE(${phone || null}, phone),
            address    = COALESCE(${address || null}, address),
            zip        = COALESCE(${zip || null}, zip),
            scope      = COALESCE(${scope || null}, scope),
            step_abandoned = ${step_abandoned},
            updated_at = NOW()
          WHERE company_id = ${company_id} AND email = ${email}
        `);
        return res.json({ ok: true, action: "updated" });
      }
    }
    await db.execute(drizzleSql`
      INSERT INTO abandoned_bookings (company_id, first_name, last_name, email, phone, address, zip, scope, step_abandoned, created_at, updated_at)
      VALUES (${company_id}, ${first_name || null}, ${last_name || null}, ${email || null}, ${phone || null},
              ${address || null}, ${zip || null}, ${scope || null}, ${step_abandoned}, NOW(), NOW())
    `);
    return res.json({ ok: true, action: "created" });
  } catch (err: any) {
    console.error("POST /public/book/abandon-track:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/public/leads ────────────────────────────────────────────────────
// Stores a very-dirty callback request lead and sends alert to info@phes.io
router.post("/leads", rateLimit, async (req, res) => {
  try {
    const { company_id, first_name, last_name, phone, email, sqft, address, message, condition_flag } = req.body;
    if (!company_id || !first_name || !phone) {
      return res.status(400).json({ error: "company_id, first_name, and phone are required" });
    }
    const { sql: drizzleSql } = await import("drizzle-orm");
    const insertResult = await db.execute(drizzleSql`
      INSERT INTO leads (company_id, first_name, last_name, phone, email, sqft, address, message, condition_flag,
                         source, status, created_at, updated_at)
      VALUES (${company_id}, ${first_name || null}, ${last_name || null}, ${phone || null}, ${email || null},
              ${sqft || null}, ${address || null}, ${message || null}, ${condition_flag || null},
              'very_dirty', 'needs_contacted', NOW(), NOW())
      RETURNING id
    `);
    const leadId = (insertResult.rows[0] as any)?.id;

    // Office SMS alert
    try {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken  = process.env.TWILIO_AUTH_TOKEN;
      const from       = process.env.TWILIO_FROM_NUMBER;
      const officeNum  = "+17737869902";
      if (accountSid && authToken && from) {
        const smsRes = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              To: officeNum,
              From: from,
              Body: `Very Dirty Lead — ${first_name} ${last_name || ""} — ${phone}. Needs manual callback. Lead #${leadId || "N/A"}.`,
            }).toString(),
          }
        );
        if (!smsRes.ok) console.error("[very-dirty] Twilio SMS failed:", await smsRes.text());
      }
    } catch (smsErr) {
      console.error("[very-dirty] SMS error:", smsErr);
    }

    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      try {
        const { Resend } = await import("resend");
        const resend = new Resend(resendKey);
        await resend.emails.send({
          from: "Qleno <noreply@phes.io>",
          to: ["info@phes.io"],
          subject: `Callback Request — Needs Attention: ${first_name} ${last_name || ""}`.trim(),
          html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#F7F6F3;">
<div style="background:#fff;border:1px solid #E5E2DC;border-radius:8px;padding:32px;">
<div style="background:#5B9BD5;padding:16px 24px;border-radius:4px;margin-bottom:24px;">
  <span style="color:#fff;font-size:18px;font-weight:bold;">Phes — Callback Request</span>
</div>
<table style="width:100%;border-collapse:collapse;font-size:14px;color:#1A1917;">
  <tr><td style="padding:8px 0;color:#6B6860;width:140px;">Name</td><td style="padding:8px 0;font-weight:600;">${first_name} ${last_name || ""}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Phone</td><td style="padding:8px 0;">${phone}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Email</td><td style="padding:8px 0;">${email || "Not provided"}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Home Size</td><td style="padding:8px 0;">${sqft ? sqft + " sqft" : "Not provided"}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Address</td><td style="padding:8px 0;">${address || "Not provided"}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;">Flag</td><td style="padding:8px 0;font-weight:600;color:#DC2626;">${condition_flag || "—"}</td></tr>
  <tr><td style="padding:8px 0;color:#6B6860;vertical-align:top;">Message</td><td style="padding:8px 0;">${message || "No message provided"}</td></tr>
</table>
</div></div>`,
        });
      } catch (emailErr) {
        console.error("[leads] Resend error:", emailErr);
      }
    }

    return res.status(201).json({ ok: true });
  } catch (err: any) {
    console.error("POST /public/leads:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
