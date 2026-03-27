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
  if (freqFactor?.rate_override != null && freqFactor.rate_override !== "") {
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
      referral_source, sms_consent,
      scope_id, sqft, frequency, addon_ids, discount_code,
      bedrooms, bathrooms, half_baths, floors, people, pets, cleanliness,
      address, preferred_date,
      payment_method_id, stripe_customer_id,
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
            referral_source, sms_consent,
            stripe_customer_id, stripe_payment_method_id, payment_source,
            card_last_four, card_brand, card_expiry, card_saved_at,
            created_at
          ) VALUES (
            ${company_id}, ${first_name}, ${last_name}, ${phone}, ${email},
            ${referral_source || null}, ${sms_consent ? true : false},
            ${stripe_customer_id || null}, ${payment_method_id}, 'stripe',
            ${cardLast4}, ${cardBrand}, ${cardExpiry}, NOW(),
            NOW()
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
    const jobNotes = `Booked via online widget. Cleanliness: ${cleanliness || "N/A"}. People: ${people || "N/A"}. Floors: ${floors || "N/A"}. Home ID: ${homeId}.`;

    const jobResult = await db.execute(
      drizzleSql`
        INSERT INTO jobs (
          company_id, client_id, service_type, status,
          scheduled_date, frequency, base_fee, estimated_hours, hourly_rate, notes, created_at
        ) VALUES (
          ${company_id}, ${clientId}, ${scopeName}, 'unassigned',
          ${preferred_date || null}, ${frequency},
          ${pricing.final_total}, ${pricing.base_hours}, ${pricing.hourly_rate},
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

    console.log(`[STRIPE] Booking confirmed — client_id=${clientId} job_id=${jobId} PM=${payment_method_id} card=${cardBrand} *${cardLast4}`);
    return res.status(201).json({
      ok: true,
      client_id: clientId,
      job_id: jobId,
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

    const jobResult = await db.execute(
      drizzleSql`
        INSERT INTO jobs (
          company_id, client_id, service_type, status,
          scheduled_date, frequency, base_fee, estimated_hours, hourly_rate, notes, created_at
        ) VALUES (
          ${company_id}, ${clientId}, ${scopeName}, 'unassigned',
          ${preferred_date || null}, ${frequency}, ${pricing.final_total}, ${pricing.base_hours}, ${pricing.hourly_rate},
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

export default router;
