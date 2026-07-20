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
import { getBranchByZip } from "../lib/branchRouter";
import { computePetFee, petFeeConfigFromRow } from "../lib/pet-fee";
import { buildOfficeNotificationEmail } from "../lib/emailTemplates";
import { enrollForAbandonedBooking, stopEnrollmentsForAbandonedBooking, enrollForLeadDrip } from "../services/followUpService.js";
import { geocodeWithComponents } from "../lib/geocode";

const router = Router();

// [address-capture 2026-07-10] Resolve a booking's address into clean street/city/
// state/zip. The widget only parses these when the customer PICKS a Google
// autocomplete suggestion — a manually typed address arrives with just the full
// string (and maybe a zip), so the job + client ended up with only "IL 60655" on
// the dispatch card (Maribel: "the address wasn't picked up"). When the parsed
// street is missing but we have a full address string, geocode it server-side to
// recover the components. Best-effort: if geocoding is unavailable or fails, we
// keep whatever the widget sent (never worse than before).
async function resolveBookingAddress(p: {
  address?: string | null; address_street?: string | null; address_city?: string | null;
  address_state?: string | null; address_zip?: string | null; zip?: string | null;
  address_lat?: any; address_lng?: any;
}): Promise<{ street: string | null; city: string | null; state: string | null; zip: string | null; lat: number | null; lng: number | null }> {
  const trim = (v: any) => { const s = v == null ? "" : String(v).trim(); return s || null; };
  let street = trim(p.address_street);
  let city = trim(p.address_city);
  let state = trim(p.address_state);
  let zip = trim(p.address_zip) ?? trim(p.zip);
  let lat = p.address_lat != null && p.address_lat !== "" ? parseFloat(String(p.address_lat)) : null;
  let lng = p.address_lng != null && p.address_lng !== "" ? parseFloat(String(p.address_lng)) : null;
  const full = trim(p.address);
  if (!street && full) {
    try {
      const g = await geocodeWithComponents(full);
      if (g) {
        street = trim(g.street) ?? street;
        city = city ?? trim(g.city);
        state = state ?? trim(g.state);
        zip = zip ?? trim(g.zip);
        if (lat == null) lat = g.lat;
        if (lng == null) lng = g.lng;
      }
    } catch (e) {
      console.warn("[address-capture] geocode fallback failed:", (e as any)?.message ?? e);
    }
    // Last resort — if geocoding produced no street, store the typed string so the
    // card shows the real address instead of just the zip.
    if (!street) street = full;
  }
  return { street, city, state, zip, lat, lng };
}

// ── Normalize referral_source to match production ENUM values ────────────────
// Production DB has: google, nextdoor, facebook, yelp, client_referral,
//                    door_hanger, yard_sign, website, other
const REFERRAL_MAP: Record<string, string> = {
  google: "google",
  facebook: "facebook",
  instagram: "other",
  nextdoor: "nextdoor",
  "friend/family": "client_referral",
  "client referral": "client_referral",
  client_referral: "client_referral",
  yelp: "yelp",
  door_hanger: "door_hanger",
  "door hanger": "door_hanger",
  yard_sign: "yard_sign",
  "yard sign": "yard_sign",
  website: "website",
  other: "other",
};
function normalizeReferral(value: string | null | undefined): string | null {
  if (!value) return null;
  return REFERRAL_MAP[value.toLowerCase().trim()] ?? "other";
}

// [widget-lead-upsert 2026-07-04] Find-or-create the Lead Pipeline lead for a
// public booking-widget action, deduped by email/phone within the company. An
// online residential QUOTE (abandon-track) creates a needs_contacted lead so it
// shows up in Leads; a later booking (confirm) UPGRADES that same lead to booked
// instead of creating a duplicate. Status only advances, never downgrades.
// Contact fields fill in but never clobber. Non-fatal.
const LEAD_STATUS_RANK: Record<string, number> = { needs_contacted: 0, contacted: 1, quoted: 2, booked: 3 };
async function upsertWidgetLead(companyId: number, opts: {
  email?: string | null; phone?: string | null; first_name?: string | null; last_name?: string | null;
  address?: string | null; zip?: string | null; scope?: string | null;
  source: string; status: string; jobId?: number | null; booked?: boolean; quoteAmount?: number | null;
  // [quote-details-carry 2026-07-07] Sanitized snapshot of what the visitor
  // filled in on the widget (bedrooms/bathrooms/sqft/frequency/add-ons/
  // referral/step_reached). Merged into leads.details so the Lead Pipeline
  // shows the full quote picture; newer keys win over older ones.
  details?: Record<string, unknown> | null;
}): Promise<number | null> {
  try {
    const { sql: s } = await import("drizzle-orm");
    const email = opts.email ? String(opts.email).toLowerCase().trim() : null;
    const phone10 = (opts.phone ?? "").replace(/[^0-9]/g, "").slice(-10) || null;
    let existing: any = null;
    if (email || phone10) {
      const found = await db.execute(s`
        SELECT id, status FROM leads
         WHERE company_id = ${companyId}
           AND (${email ? s`LOWER(email) = ${email}` : s`FALSE`}
                OR ${phone10 ? s`RIGHT(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 10) = ${phone10}` : s`FALSE`})
         ORDER BY created_at DESC LIMIT 1`);
      existing = (found.rows as any[])[0] ?? null;
    }
    if (existing) {
      const upgrade = (LEAD_STATUS_RANK[opts.status] ?? 0) > (LEAD_STATUS_RANK[String(existing.status)] ?? 0);
      await db.execute(s`
        UPDATE leads SET
          first_name = COALESCE(first_name, ${opts.first_name ?? null}),
          last_name  = COALESCE(last_name, ${opts.last_name ?? null}),
          email      = COALESCE(email, ${opts.email ?? null}),
          phone      = COALESCE(phone, ${opts.phone ?? null}),
          address    = COALESCE(address, ${opts.address ?? null}),
          zip        = COALESCE(zip, ${opts.zip ?? null}),
          scope      = COALESCE(scope, ${opts.scope ?? null}),
          status     = ${upgrade ? s`${opts.status}` : s`status`},
          quote_amount = COALESCE(${opts.quoteAmount ?? null}, quote_amount),
          quoted_at  = ${opts.status === "quoted" ? s`COALESCE(quoted_at, NOW())` : s`quoted_at`},
          job_id     = COALESCE(job_id, ${opts.jobId ?? null}),
          booked_at  = ${opts.booked ? s`COALESCE(booked_at, NOW())` : s`booked_at`},
          details    = COALESCE(details, '{}'::jsonb) || COALESCE(${opts.details ? JSON.stringify(opts.details) : null}::jsonb, '{}'::jsonb),
          updated_at = NOW()
        WHERE id = ${existing.id}`);
      // [booked-drip-stop 2026-07-09] The public booking-confirm paths upgrade a
      // lead to booked THROUGH this helper (raw SQL) and used to call NO stop
      // function — so an existing lead's drips kept firing after they booked
      // online (Francisco: booked clients still getting follow-ups). Stop the
      // lead's cadences here when this upsert marks it booked. advanceLeadStage
      // owns this for the internal paths; this is the widget equivalent.
      if (opts.status === "booked" || opts.booked) {
        import("../services/followUpService.js").then(({ stopEnrollmentsForLead }) =>
          stopEnrollmentsForLead(Number(existing.id), "lead_booked").catch(() => {})).catch(() => {});
      }
      return Number(existing.id);
    }
    // [source-precedence 2026-07-09] Stamp lead_source = source (not the DB
    // default 'manual'). Without this, every online/widget lead landed with
    // lead_source='manual' and rendered as the "Office" chip in the pipeline,
    // misrepresenting client-submitted leads as office-created ones.
    const ins = await db.execute(s`
      INSERT INTO leads (company_id, first_name, last_name, phone, email, address, zip, scope, source, lead_source, status, quote_amount, quoted_at, job_id, booked_at, details, created_at, updated_at)
      VALUES (${companyId}, ${opts.first_name ?? null}, ${opts.last_name ?? null}, ${opts.phone ?? null}, ${opts.email ?? null},
              ${opts.address ?? null}, ${opts.zip ?? null}, ${opts.scope ?? null}, ${opts.source}, ${opts.source}, ${opts.status},
              ${opts.quoteAmount ?? null}, ${opts.status === "quoted" ? s`NOW()` : s`NULL`},
              ${opts.jobId ?? null}, ${opts.booked ? s`NOW()` : s`NULL`},
              COALESCE(${opts.details ? JSON.stringify(opts.details) : null}::jsonb, '{}'::jsonb), NOW(), NOW())
      RETURNING id`);
    return Number((ins.rows as any[])[0]?.id) || null;
  } catch (e) {
    // Non-fatal by design (a DB hiccup must not break the customer's widget),
    // but log with enough context to diagnose a dropped lead — this catch is
    // what silently swallowed the Georgann Gambill lead. Callers now also log
    // when this returns null.
    console.error("[widget-lead] upsert failed:", {
      companyId, email: opts.email, phone: opts.phone, source: opts.source, status: opts.status,
    }, e);
    return null;
  }
}

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

// ── GET /api/public/config/google-maps-key ───────────────────────────────────
// Public (no requireAuth) so the booking widget can load Maps Places at runtime.
// The build-time VITE_GOOGLE_MAPS_API_KEY is empty in the Railway build, so the
// browser key is served from the server-side GOOGLE_MAPS_API_KEY env instead.
router.get("/config/google-maps-key", rateLimit, (_req, res) => {
  return res.json({ key: process.env.GOOGLE_MAPS_API_KEY ?? "" });
});

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
      .where(and(
        eq(pricingScopesTable.company_id, companyId),
        eq(pricingScopesTable.is_active, true),
        eq(pricingScopesTable.show_online, true),
      ))
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

// ── GET /api/public/quote/:token ────────────────────────────────────────────
// Hands the booking widget a quote's saved answers so a "Book this quote" link
// can PRE-FILL the flow instead of restarting it. Public (rate-limited), keyed
// on the customer-facing sign_token. Only still-open quotes resolve (a booked /
// expired quote returns 410 so the widget can fall back to a fresh booking).
router.get("/quote/:token", rateLimit, async (req, res) => {
  const { sql: drSql } = await import("drizzle-orm");
  try {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(400).json({ error: "Missing token" });
    const r = await db.execute(drSql`
      SELECT q.id, q.company_id, q.lead_name, q.lead_email, q.lead_phone, q.address,
             q.service_type, q.frequency, q.scope_id, q.addons, q.total_price,
             q.estimated_hours, q.manual_hours,
             q.bedrooms, q.bathrooms, q.half_baths, q.sqft, q.dirt_level, q.pets,
             q.status, q.special_instructions, c.slug AS company_slug
      FROM quotes q JOIN companies c ON c.id = q.company_id
      WHERE q.sign_token = ${token} LIMIT 1
    `);
    const q: any = (r as any).rows?.[0];
    if (!q) return res.status(404).json({ error: "Quote not found" });
    if (["booked", "accepted", "converted", "expired", "declined", "lost"].includes(String(q.status))) {
      return res.status(410).json({ error: "Quote no longer available", status: q.status });
    }
    // Split lead_name → first/last for the contact step.
    const name = String(q.lead_name || "").trim();
    const sp = name.indexOf(" ");
    const first_name = sp > 0 ? name.slice(0, sp) : name;
    const last_name = sp > 0 ? name.slice(sp + 1) : "";
    // addons jsonb → addon_ids where the stored item carries a numeric id.
    const addons = Array.isArray(q.addons) ? q.addons : [];
    const addon_ids = addons
      .map((a: any) => Number(a?.id))
      .filter((x: any) => Number.isFinite(x));
    return res.json({
      quote_id: q.id,
      company_id: q.company_id,
      company_slug: q.company_slug,
      first_name, last_name,
      email: q.lead_email || "",
      phone: q.lead_phone || "",
      address: q.address || "",
      service_type: q.service_type || null,
      frequency: q.frequency || null,
      scope_id: q.scope_id ?? null,
      addon_ids, addons,
      bedrooms: q.bedrooms ?? null,
      bathrooms: q.bathrooms ?? null,
      half_baths: q.half_baths ?? null,
      sqft: q.sqft ?? null,
      dirt_level: q.dirt_level ?? null,
      pets: q.pets ?? null,
      special_instructions: q.special_instructions || null,
      total_price: q.total_price ?? null,
      // manual_hours is the office override; estimated_hours the computed stamp.
      estimated_hours: (Number(q.manual_hours) > 0 ? q.manual_hours : q.estimated_hours) ?? null,
    });
  } catch (err) {
    console.error("GET /public/quote/:token:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// [referral-program 2026-07-17] Customer-facing referral messages fired on a
// referral submit. The referred FRIEND gets EMAIL ONLY (they never opted in — a
// cold SMS would be a TCPA gray area; the office alert still lets staff call).
// The REFERRER gets an SMS + email thank-you. Gate-respecting (COMMS_ENABLED +
// per-tenant/branch) and opt-out-checked; best-effort, never blocks the submit.
async function sendReferralComms(companyId: number, p: {
  referrerFirst: string; referrerEmail: string; referrerPhone: string;
  friendFirst: string; friendEmail: string;
}): Promise<void> {
  try {
    const { sql: rSql } = await import("drizzle-orm");
    const { resolveSender, sendSmsVia } = await import("../lib/comms-sender.js");
    const { isEmailOptedOut, isSmsOptedOut } = await import("../lib/opt-out.js");
    const { appBaseUrl } = await import("../lib/app-url.js");
    const co: any = (await db.execute(rSql`SELECT name, phone, email_from_address FROM companies WHERE id = ${companyId} LIMIT 1`)).rows[0] || {};
    const companyName = co.name || "Phes Cleaning";
    const companyPhone = co.phone || "";
    const bookLink = `${appBaseUrl()}/book`;
    const sender: any = await resolveSender(companyId, null);
    const emailGate = process.env.COMMS_ENABLED === "true" && sender.company_comms_enabled && sender.enabled && sender.branch_comms_enabled;
    const resendKey = process.env.RESEND_API_KEY;
    const fromAddr = co.email_from_address ? `${companyName} <${co.email_from_address}>` : "Phes Cleaning <noreply@phes.io>";
    const esc = (v: string) => String(v ?? "").replace(/[<>&]/g, (ch) => (ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&amp;"));
    const wrap = (inner: string) => `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#F7F6F3;"><div style="background:#fff;border:1px solid #E5E2DC;border-radius:8px;padding:32px;">${inner}<p style="font-size:13px;color:#9E9B94;margin:20px 0 0;">${esc(companyName)}${companyPhone ? ` — ${esc(companyPhone)}` : ""}</p></div></div>`;
    const sendMail = async (to: string, subject: string, inner: string) => {
      if (!emailGate || !resendKey || !to) return;
      if (await isEmailOptedOut(companyId, to)) return;
      const { Resend } = await import("resend");
      await new Resend(resendKey).emails.send({ from: fromAddr, to: [to], subject, html: wrap(inner) }).catch(() => {});
    };
    const para = (t: string) => `<p style="font-size:15px;color:#1A1917;line-height:1.7;margin:0 0 14px;">${t}</p>`;

    // 1. Referred friend — EMAIL ONLY.
    await sendMail(
      p.friendEmail,
      `${p.referrerFirst || "A friend"} thinks you'll love ${companyName} — $25 off your first clean`,
      para(`Hi ${esc(p.friendFirst || "there")},`) +
      para(`${esc(p.referrerFirst || "A friend")} recommended <strong>${esc(companyName)}</strong> for a cleaning — and gifted you <strong>$25 off</strong> your first visit.`) +
      para(`Get an instant quote and book your first clean:`) +
      `<p><a href="${bookLink}" style="display:inline-block;background:#00C9A0;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:6px;">Book my clean</a></p>`,
    );

    // 2. Referrer — SMS thank-you.
    if (p.referrerPhone && !sender.reason && !(await isSmsOptedOut(companyId, p.referrerPhone))) {
      const smsBody = `Hi ${p.referrerFirst || "there"}! Thanks for referring ${p.friendFirst || "your friend"} to ${companyName}. Once their first cleaning is done, you'll get $25 off your next visit. Reply STOP to opt out.`;
      await sendSmsVia(sender, p.referrerPhone, smsBody).catch(() => {});
    }

    // 3. Referrer — EMAIL thank-you.
    await sendMail(
      p.referrerEmail,
      `Thanks for referring ${p.friendFirst || "a friend"} to ${companyName}`,
      para(`Hi ${esc(p.referrerFirst || "there")},`) +
      para(`Thanks for referring <strong>${esc(p.friendFirst || "your friend")}</strong> to ${esc(companyName)}! Once their first cleaning is complete, you'll get <strong>$25 off</strong> your next visit.`) +
      para(`We appreciate you spreading the word.`),
    );
  } catch (e: any) {
    console.error("[referral] customer comms error (non-fatal):", e?.message ?? e);
  }
}

// ── POST /api/public/referral ────────────────────────────────────────────────
// [referral-program] Give $25 / Get $25 — the confirmation-page "Refer a friend
// or business" form. Creates (a) a Lead Pipeline lead for the referred person
// (deduped via upsertWidgetLead, source 'referral', tagged with who referred
// them + the promo) and (b) a referrals row linked to that lead — the link is
// what lets the Referrals report derive booked/completed/credited later. Fires
// the office new-lead alert. Public + rate-limited; never exposes internal ids.
router.post("/referral", rateLimit, async (req, res) => {
  const { sql: s } = await import("drizzle-orm");
  try {
    const b: any = req.body ?? {};
    const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
    const companySlug = clip(b.company_slug, 80);
    const referredName = clip(b.referred_name, 120);
    const referredPhone = clip(b.referred_phone, 40);
    const referredEmail = clip(b.referred_email, 160);
    const referralType = b.referral_type === "commercial" ? "commercial" : "residential";
    const ref: any = b.referrer ?? {};
    const referrerFirst = clip(ref.first_name, 80);
    const referrerLast = clip(ref.last_name, 80);
    const referrerEmail = clip(ref.email, 160).toLowerCase();
    const referrerPhone = clip(ref.phone, 40);
    const referrerName = [referrerFirst, referrerLast].filter(Boolean).join(" ");

    if (!companySlug) return res.status(400).json({ error: "Missing company" });
    if (!referredName) return res.status(400).json({ error: "Please tell us who you're referring." });
    if (!referredPhone && !referredEmail) return res.status(400).json({ error: "A phone number or email for them is required." });

    const companyRow = await db.execute(s`SELECT id FROM companies WHERE slug = ${companySlug} LIMIT 1`);
    const companyId = Number((companyRow.rows[0] as any)?.id);
    if (!companyId) return res.status(404).json({ error: "Company not found" });

    // Match the referrer to an existing client by email/phone (they usually
    // just booked, so this normally hits). Kept nullable — a lead who refers
    // before their client record exists still counts.
    let referrerClientId: number | null = null;
    const refPhone10 = referrerPhone.replace(/\D/g, "").slice(-10);
    if (referrerEmail || refPhone10) {
      const m = await db.execute(s`
        SELECT id FROM clients
         WHERE company_id = ${companyId}
           AND (${referrerEmail ? s`LOWER(email) = ${referrerEmail}` : s`FALSE`}
                OR ${refPhone10 ? s`RIGHT(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 10) = ${refPhone10}` : s`FALSE`})
         ORDER BY id DESC LIMIT 1`);
      referrerClientId = Number((m.rows[0] as any)?.id) || null;
    }

    const sp = referredName.indexOf(" ");
    const referredFirst = sp > 0 ? referredName.slice(0, sp) : referredName;
    const referredLast = sp > 0 ? referredName.slice(sp + 1) : null;
    const { REFERRAL_PROMO } = await import("../lib/referrals.js");

    const leadId = await upsertWidgetLead(companyId, {
      first_name: referredFirst,
      last_name: referredLast,
      phone: referredPhone || null,
      email: referredEmail || null,
      scope: referralType === "commercial" ? "Commercial Cleaning" : null,
      source: "referral",
      status: "needs_contacted",
      details: {
        referred_by: referrerName || referrerEmail || "a customer",
        referral_type: referralType,
        referral_promo: REFERRAL_PROMO,
      },
    });

    await db.execute(s`
      INSERT INTO referrals
        (company_id, referrer_client_id, referrer_name, referrer_email, referrer_phone,
         referred_name, referred_phone, referred_email, referral_type,
         source, status, promo, lead_id, created_at, updated_at)
      VALUES
        (${companyId}, ${referrerClientId}, ${referrerName || null}, ${referrerEmail || null}, ${referrerPhone || null},
         ${referredName}, ${referredPhone || null}, ${referredEmail || null}, ${referralType},
         'widget', 'pending', ${REFERRAL_PROMO}, ${leadId}, NOW(), NOW())
    `);

    // Office alert — same channel every other new lead uses. Fire-and-forget.
    try {
      const { fireOfficeNotification } = await import("./leads.js");
      void fireOfficeNotification(
        companyId, leadId ?? 0, referredFirst, referredLast,
        `Referral — from ${referrerName || "a customer"} ($25/$25 promo)`,
        referredPhone || null,
        referralType === "commercial" ? "Commercial Cleaning" : null,
      ).catch((e: any) => console.error("[referral] office alert failed:", e?.message ?? e));
    } catch (e: any) {
      console.error("[referral] office alert failed:", e?.message ?? e);
    }

    // [referral-program] Fire the customer-facing referral messages (friend email
    // + referrer SMS/email). Fire-and-forget so a comms hiccup never fails the
    // submit; gating + opt-out are enforced inside.
    void sendReferralComms(companyId, {
      referrerFirst, referrerEmail, referrerPhone,
      friendFirst: referredFirst, friendEmail: referredEmail,
    }).catch((e: any) => console.error("[referral] comms dispatch failed:", e?.message ?? e));

    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error("POST /public/referral:", err);
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

// ── GET /api/public/referral-sources/:slug ──────────────────────────────────
// Returns active acquisition sources for the booking widget. Falls back to
// hardcoded defaults when no custom sources have been configured.
router.get("/referral-sources/:slug", rateLimit, async (req, res) => {
  const { sql: drSql } = await import("drizzle-orm");
  const DEFAULTS = [
    { name: "Google", slug: "google" },
    { name: "Facebook", slug: "facebook" },
    { name: "Instagram", slug: "instagram" },
    { name: "Nextdoor", slug: "nextdoor" },
    { name: "Friend / Family", slug: "client_referral" },
    { name: "Other", slug: "other" },
  ];
  try {
    const slug = req.params.slug;
    const companyRow = await db.execute(drSql`SELECT id FROM companies WHERE slug = ${slug} LIMIT 1`);
    if (!companyRow.rows.length) return res.json(DEFAULTS);
    const companyId = (companyRow.rows[0] as any).id;
    const result = await db.execute(drSql`
      SELECT name, slug FROM acquisition_sources
       WHERE company_id = ${companyId} AND is_active = true
       ORDER BY display_order, id
    `);
    return res.json((result as any).rows.length ? (result as any).rows : DEFAULTS);
  } catch {
    return res.json(DEFAULTS);
  }
});

// ── POST /api/public/referral-source ────────────────────────────────────────
// Persist the "How did you hear about us?" answer AFTER booking. The question
// was moved off the critical-path Step 1 to the confirmation screen (internal
// reporting only), so it's set here against the client the booking created.
// Best-effort: scoped by company_id, normalized to the production enum.
router.post("/referral-source", rateLimit, async (req, res) => {
  const { sql: drSql } = await import("drizzle-orm");
  try {
    const { company_id, client_id, referral_source } = req.body ?? {};
    if (!company_id || !client_id) {
      return res.status(400).json({ error: "company_id and client_id required" });
    }
    await db.execute(drSql`
      UPDATE clients SET referral_source = ${normalizeReferral(referral_source)}
       WHERE id = ${Number(client_id)} AND company_id = ${Number(company_id)}`);
    return res.json({ ok: true });
  } catch {
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
  pets?: number;
  public_only?: boolean;
}) {
  const { scope_id, sqft, frequency, addon_ids, discount_code, company_id, pets, public_only } = params;

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
  let addon_minutes = 0;
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
      addon_minutes += parseInt(String(addon.time_add_minutes ?? 0)) || 0;
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
  const addon_hours = Math.round((addon_minutes / 60) * 100) / 100;
  const total_hours = Math.round((base_hours + addon_hours) * 100) / 100;

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
      // [combo-discount-fix 2026-06-17] (#13 public twin) Previously EVERY
      // matching bundle was applied and summed, so two bundles covering the same
      // add-ons stacked — "Appliance Combo" (-$20) AND "Oven + Refrigerator
      // Combo" (-$15), both = {Oven, Refrigerator}. Select a NON-OVERLAPPING set:
      // most specific bundle first (largest required set), tie → larger discount,
      // and never let two bundles claim the same add-on. Disjoint bundles still
      // stack. Mirrors the office /pricing/calculate fix exactly. (Only the
      // combo-discount logic changes — nothing else in the public quote tool.)
      const candidates = bundles.map((bundle: any) => {
        const required: number[] = [...new Set((bundle.required_ids ?? []).map((x: any) => parseInt(String(x))).filter((n: number) => !isNaN(n)))] as number[];
        const matched = required.filter(rid => validIds.includes(rid));
        if (required.length === 0 || matched.length !== required.length) return null;
        const dv = parseFloat(String(bundle.discount_value));
        let disc = 0;
        if (bundle.discount_type === "flat_per_item") {
          disc = dv * matched.length;
        } else if (bundle.discount_type === "flat" || bundle.discount_type === "flat_total") {
          disc = dv;
        } else if (bundle.discount_type === "percentage") {
          disc = (dv / 100) * base_price;
        }
        return { name: String(bundle.name), required, disc };
      }).filter(Boolean) as Array<{ name: string; required: number[]; disc: number }>;
      candidates.sort((a, b) => (b.required.length - a.required.length) || (b.disc - a.disc));
      const consumedAddons = new Set<number>();
      for (const c of candidates) {
        if (c.required.some(rid => consumedAddons.has(rid))) continue; // overlaps a higher-priority bundle
        c.required.forEach(rid => consumedAddons.add(rid));
        bundle_discount += c.disc;
        bundle_breakdown.push({ name: c.name, discount: Math.round(c.disc * 100) / 100 });
      }
    }
  }
  addons_total -= bundle_discount;

  // ── Pet fee (optional, per-company on offer_settings; ships DISABLED) ───────
  // Applied to base_price only, when the company has enabled it AND the home has
  // pets. Wrapped defensively so a missing column / read error can never break a
  // quote — it just yields no fee (fail-safe, matching the disabled default).
  let pet_fee = 0;
  let pet_fee_type: string | null = null;
  if (pets && pets > 0) {
    try {
      const { sql: petSql } = await import("drizzle-orm");
      const osRes = await db.execute(petSql`
        SELECT pet_fee_enabled, pet_fee_type, pet_fee_amount
          FROM offer_settings WHERE company_id = ${company_id} LIMIT 1
      `);
      const cfg = petFeeConfigFromRow((osRes as any).rows?.[0] ?? {});
      pet_fee = computePetFee(cfg, pets, base_price);
      if (pet_fee > 0) pet_fee_type = cfg.type;
    } catch (e) {
      pet_fee = 0;
    }
  }

  let subtotal = base_price + addons_total + pet_fee;
  let discount_amount = 0;
  let final_total = subtotal;
  let discount_valid = false;

  if (discount_code) {
    const allDiscounts = await db
      .select()
      .from(pricingDiscountsTable)
      .where(eq(pricingDiscountsTable.company_id, company_id));
    const match = allDiscounts.find(d => {
      if (d.code.toUpperCase() !== discount_code.toUpperCase() || !d.is_active) return false;
      if (public_only && (d as any).is_online === false) return false;
      let scopes: number[] = []; try { scopes = JSON.parse((d as any).scope_ids || "[]"); } catch {}
      return scopes.length === 0 || scopes.includes(scope_id);
    });
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
    addon_hours,
    total_hours,
    hourly_rate: Math.round(hourly_rate * 100) / 100,
    base_price: Math.round(base_price * 100) / 100,
    minimum_applied,
    addons_total: Math.round(addons_total * 100) / 100,
    addon_breakdown,
    bundle_discount: Math.round(bundle_discount * 100) / 100,
    bundle_breakdown,
    pet_fee: Math.round(pet_fee * 100) / 100,
    pet_fee_type,
    subtotal: Math.round(subtotal * 100) / 100,
    discount_amount: Math.round(discount_amount * 100) / 100,
    discount_valid: discount_code ? discount_valid : undefined,
    final_total: Math.round(final_total * 100) / 100,
  };
}

// ── POST /api/public/calculate ───────────────────────────────────────────────
router.post("/calculate", rateLimit, async (req, res) => {
  try {
    const { scope_id, sqft, frequency, addon_ids, discount_code, company_id, pets } = req.body;
    if (!scope_id || !sqft || !frequency || !company_id) {
      return res.status(400).json({ error: "scope_id, sqft, frequency, and company_id are required" });
    }
    const result = await runCalculate({ scope_id, sqft, frequency, addon_ids, discount_code, company_id, pets, public_only: true });
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

    let setupIntent;
    try {
      setupIntent = await stripe.setupIntents.create({
        customer: customerId,
        payment_method_types: ["card"],
        usage: "off_session",
      });
    } catch (siErr: any) {
      // A saved stripe_customer_id can be stale (e.g. created under a different
      // Stripe account or in test mode) → Stripe returns "No such customer".
      // Recover transparently by minting a fresh customer + repairing the row,
      // so a returning client can still book instead of hitting a 500.
      const stale = siErr?.code === "resource_missing" ||
        siErr?.statusCode === 404 || /no such customer/i.test(siErr?.message || "");
      if (!stale) throw siErr;
      const fresh = await stripe.customers.create({
        email,
        name: `${first_name || ""} ${last_name || ""}`.trim(),
        phone: phone || undefined,
        metadata: { company_id: String(company_id) },
      });
      customerId = fresh.id;
      setupIntent = await stripe.setupIntents.create({
        customer: customerId,
        payment_method_types: ["card"],
        usage: "off_session",
      });
      try {
        await db.execute(drizzleSql`UPDATE clients SET stripe_customer_id = ${customerId} WHERE email = ${email} AND company_id = ${company_id}`);
      } catch { /* best-effort repair */ }
    }

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
      preferred_contact_method,
      address_line2,
      property_vacant, move_in_notes,
      address, preferred_date,
      payment_method_id, stripe_customer_id,
      booking_location,
      address_street, address_city, address_state, address_zip,
      address_lat, address_lng, address_verified,
      quote_id, // set when the booking came from a quote email's "Book" link
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

    const pricing = await runCalculate({ scope_id, sqft, frequency, addon_ids, discount_code, company_id, pets, public_only: true });
    const { sql: drizzleSql } = await import("drizzle-orm");

    // Find or create client
    const existingClients = await db.execute(
      drizzleSql`SELECT id FROM clients WHERE email = ${email} AND company_id = ${company_id} LIMIT 1`
    );

    // [address-capture 2026-07-10] Resolve street/city/state/zip up front so the
    // client row actually stores the address (it never did before — the dispatch
    // card fell back to clients.* and showed only "IL 60655"). Geocodes a
    // manually-typed address when the widget didn't parse it.
    const resolvedAddr = await resolveBookingAddress({ address, address_street, address_city, address_state, address_zip, zip, address_lat, address_lng });

    const isReturningClient = existingClients.rows.length > 0;
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
          card_saved_at = NOW(),
          address = COALESCE(NULLIF(address, ''), ${resolvedAddr.street}),
          city    = COALESCE(NULLIF(city, ''),    ${resolvedAddr.city}),
          state   = COALESCE(NULLIF(state, ''),   ${resolvedAddr.state}),
          zip     = COALESCE(NULLIF(zip, ''),     ${resolvedAddr.zip})
          WHERE id = ${clientId}`
      );
    } else {
      const newClient = await db.execute(
        drizzleSql`
          INSERT INTO clients (
            company_id, first_name, last_name, phone, email,
            referral_source, address, city, state, zip,
            stripe_customer_id, stripe_payment_method_id, payment_source,
            card_last_four, card_brand, card_expiry, card_saved_at, created_at
          ) VALUES (
            ${company_id}, ${first_name}, ${last_name}, ${phone}, ${email},
            ${normalizeReferral(referral_source)}, ${resolvedAddr.street}, ${resolvedAddr.city}, ${resolvedAddr.state}, ${resolvedAddr.zip},
            ${stripe_customer_id || null}, ${payment_method_id}, 'stripe',
            ${cardLast4}, ${cardBrand}, ${cardExpiry}, NOW(), NOW()
          ) RETURNING id
        `
      );
      clientId = (newClient.rows[0] as any).id;
    }

    // [address-dedup 2026-07-19] Reuse an existing home at the SAME address
    // instead of stacking a duplicate property on every booking — repeat
    // bookings at one address were piling up identical "Home" rows on the
    // profile. Match on case-insensitive trimmed address + zip; refresh details.
    const homeAddr = address || address_street || "(address pending)";
    const homeZip = zip || address_zip || null;
    const existingHome = await db.execute(drizzleSql`
      SELECT id FROM client_homes
       WHERE company_id = ${company_id} AND client_id = ${clientId}
         AND lower(trim(COALESCE(address, ''))) = lower(trim(${homeAddr}))
         AND COALESCE(zip, '') = COALESCE(${homeZip}::text, '')
       ORDER BY is_primary DESC NULLS LAST, id ASC LIMIT 1`);
    let homeId: number;
    if (existingHome.rows.length) {
      homeId = (existingHome.rows[0] as any).id;
      await db.execute(drizzleSql`
        UPDATE client_homes SET bedrooms = COALESCE(${bedrooms || null}, bedrooms),
               bathrooms = COALESCE(${bathrooms || null}, bathrooms),
               sq_footage = COALESCE(${sqft || null}, sq_footage)
         WHERE id = ${homeId}`).catch(() => {});
    } else {
      const homeResult = await db.execute(drizzleSql`
        INSERT INTO client_homes (company_id, client_id, address, zip, bedrooms, bathrooms, sq_footage, is_primary, created_at)
        VALUES (${company_id}, ${clientId}, ${homeAddr}, ${homeZip}, ${bedrooms || null}, ${bathrooms || null}, ${sqft || null}, true, NOW())
        RETURNING id`);
      homeId = (homeResult.rows[0] as any).id;
    }

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
    // [time-picker 2026-07-15] arrival_window now carries a specific requested
    // start time (e.g. "10:00 AM") instead of the old morning/afternoon enum.
    // Store the trimmed label as-is (cap length); legacy morning/afternoon rows
    // still render via the display fallbacks below.
    const arrivalWindowVal = (typeof arrival_window === "string" && arrival_window.trim())
      ? arrival_window.trim().slice(0, 40)
      : null;
    // [scheduled-time cascade 2026-07-19] The widget's requested start time lives
    // in arrival_window ("9:30 AM") — ALSO write it to jobs.scheduled_time (the
    // HH:MM:SS column the dispatch board + job drawer read for the start slot), so
    // the booked time actually cascades to the job. Legacy window keywords
    // (morning/afternoon) or blanks don't parse → scheduled_time stays null.
    const schedTimeVal = (() => {
      const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(String(arrivalWindowVal ?? "").trim());
      if (!m) return null;
      let h = parseInt(m[1], 10); const min = m[2]; const ap = m[3]?.toUpperCase();
      if (ap === "PM" && h < 12) h += 12;
      if (ap === "AM" && h === 12) h = 0;
      return `${String(h).padStart(2, "0")}:${min}:00`;
    })();

    const bookLocVal = (booking_location === "oak_lawn" || booking_location === "schaumburg") ? booking_location : null;
    // [address-capture 2026-07-10] Use the resolved address (parsed or geocoded) so
    // the job itself carries a real street/city, not just state+zip.
    const addrStreet = resolvedAddr.street;
    const addrCity = resolvedAddr.city;
    const addrState = resolvedAddr.state;
    const addrZip = resolvedAddr.zip;
    const addrLat = resolvedAddr.lat;
    const addrLng = resolvedAddr.lng;
    const addrVerified = address_verified === true || address_verified === "true" ? true : false;

    const branchConfig = getBranchByZip(resolvedAddr.zip || zip || address_zip || "");

    const jobResult = await db.execute(
      drizzleSql`
        INSERT INTO jobs (
          company_id, client_id, service_type, status,
          scheduled_date, scheduled_time, frequency, base_fee, estimated_hours, allowed_hours, hourly_rate,
          home_condition_rating, condition_multiplier,
          applied_bundle_id, bundle_discount_total,
          last_cleaned_response, last_cleaned_flag,
          overage_disclaimer_acknowledged, overage_rate,
          upsell_shown, upsell_accepted, upsell_declined, upsell_deferred, upsell_cadence_selected,
          property_vacant, arrival_window, preferred_contact_method,
          address_line2,
          booking_location,
          address_street, address_city, address_state, address_zip,
          address_lat, address_lng, address_verified,
          branch, reminder_72h_sent, reminder_24h_sent, job_type,
          notes, created_at
        ) VALUES (
          ${company_id}, ${clientId}, ${serviceTypeEnum}, 'scheduled',
          ${preferred_date || new Date().toISOString().split("T")[0]}, ${schedTimeVal}, ${normalizedFreq},
          ${adjustedTotal}, ${pricing.total_hours ?? pricing.base_hours}, ${pricing.total_hours ?? pricing.base_hours}, ${pricing.hourly_rate},
          ${condRating}, ${condMult},
          ${bundleId}, ${bundleDiscount},
          ${lastCleanedResp}, ${lastCleanedFl},
          ${overageAck}, ${overageRateVal},
          ${upsellShownVal}, ${upsellAcceptedVal}, ${upsellDeclinedVal}, ${upsellDeferredVal}, ${upsellCadenceVal},
          ${propertyVacantVal}, ${arrivalWindowVal}, ${preferred_contact_method || null},
          ${address_line2 || null},
          ${bookLocVal},
          ${addrStreet}, ${addrCity}, ${addrState}, ${addrZip},
          ${addrLat}, ${addrLng}, ${addrVerified},
          ${branchConfig.branch}, false, false, 'residential',
          ${jobNotes}, NOW()
        ) RETURNING id
      `
    );
    const jobId = (jobResult.rows[0] as any).id;

    // [booking-itemize 2026-07-10] Persist the customer's selected add-ons AND any
    // discounts as job line items. Before this, booking priced them into the total
    // but never wrote the rows, so the job card, invoice, and confirmation email all
    // showed just "Deep Clean $X" with the add-ons invisible and any discount folded
    // silently into the base (Maribel: "didn't pick up any of the add ons"). All
    // three surfaces already itemize off job_add_ons via the same subtract-from-base
    // math (dispatch card baseInit, buildJobLineItems scope line), so populating these
    // rows fixes every surface at once. base_fee stays the all-in NET total — these
    // rows are the breakdown of money already inside it: positives for add-ons,
    // negatives for discounts (the established "negative add-on = discount" pattern
    // the card + invoice already render). Scaled by condMult to match base_fee
    // (= final_total × condMult) so base + add-ons − discounts reconciles exactly.
    // Best-effort — a failure here never blocks the booking.
    try {
      const lineAddOns: Array<{ pricing_addon_id?: number; name?: string; qty?: number; unit_price?: number; subtotal?: number }> = [];
      for (const a of ((pricing as any).addon_breakdown ?? [])) {
        const amt = Math.round((Number(a.amount) || 0) * condMult * 100) / 100;
        if (amt === 0) continue;
        lineAddOns.push({ pricing_addon_id: Number(a.id) || undefined, name: a.name, qty: 1, unit_price: amt, subtotal: amt });
      }
      for (const b of ((pricing as any).bundle_breakdown ?? [])) {
        const d = Math.round((Number(b.discount) || 0) * condMult * 100) / 100;
        if (d <= 0) continue;
        lineAddOns.push({ name: b.name || "Bundle discount", qty: 1, unit_price: -d, subtotal: -d });
      }
      const codeDisc = Math.round((Number((pricing as any).discount_amount) || 0) * condMult * 100) / 100;
      if (codeDisc > 0) {
        lineAddOns.push({ name: discount_code ? `Discount (${String(discount_code).toUpperCase()})` : "Discount", qty: 1, unit_price: -codeDisc, subtotal: -codeDisc });
      }
      if (lineAddOns.length > 0) {
        const { persistJobAddOns } = await import("./jobs.js");
        await persistJobAddOns(db, jobId, Number(company_id), lineAddOns);
      }
    } catch (itemErr) {
      console.error("[booking-itemize] failed to persist add-ons/discounts for job", jobId, itemErr);
    }

    // [online-recurring 2026-07-20] When a customer picks a recurring cadence in
    // the widget (weekly/biweekly/every_3_weeks/monthly), stand up a real
    // recurring_schedule so the visits actually repeat. Before this, confirm only
    // stamped jobs.frequency and inserted ONE job — no schedule, so the engine had
    // nothing to repeat from and the customer's "monthly" became a single orphan
    // visit (Jennifer Nuno). Mirror the office quote-convert path: create the
    // schedule, adopt THIS first job as its first occurrence (recurring_schedule_id
    // + occurrence_date so the engine's dedup skips it and edit-cascades treat it
    // as a member), stamp allowed_hours on it (the panel/efficiency read it — the
    // engine sets it on every OTHER occurrence, so the first job would otherwise be
    // the odd one out with a blank hours cell), then materialize the upcoming
    // visits inline. The inline call is the SAFE single-schedule pattern
    // (clients.ts / jobs.ts) — the dup cascade the startup guard warns about was
    // the GLOBAL run; without it the 2 AM cron would be the first time the series
    // appeared. Skip when the upsell block ran, since that builds its own recurring
    // schedule (no double series). Only the Stripe confirm path is patched here —
    // Phes runs Stripe-on, so this is the live booking path.
    if (["weekly", "biweekly", "every_3_weeks", "monthly"].includes(normalizedFreq) && !upsellAcceptedVal) {
      const firstVisitDate = preferred_date || new Date().toISOString().split("T")[0];
      const recurHours = pricing.total_hours ?? pricing.base_hours;
      const recurDurationMin = (recurHours != null && Number(recurHours) > 0) ? Math.round(Number(recurHours) * 60) : null;
      const recurAllowedHrs = (recurHours != null && Number(recurHours) > 0) ? Number(recurHours).toFixed(2) : null;
      try {
        const { recurringSchedulesTable } = await import("@workspace/db/schema");
        const [recurSched] = await db.insert(recurringSchedulesTable).values({
          company_id: Number(company_id),
          customer_id: clientId,
          frequency: normalizedFreq as any,
          day_of_week: null,                 // null → cadence anchors on start_date's weekday
          start_date: firstVisitDate as any,
          end_date: null,
          service_type: serviceTypeEnum,
          scheduled_time: schedTimeVal as any,
          duration_minutes: recurDurationMin,
          base_fee: String(adjustedTotal),   // = the first job's agreed per-visit price
          notes: `Created from online booking widget — customer selected ${normalizedFreq}.`,
        }).returning();

        // Adopt the already-created first visit into the series (dedup skips this
        // slot; allowed_hours stamped so the first job's hours cell isn't blank).
        await db.execute(drizzleSql`
          UPDATE jobs
             SET recurring_schedule_id = ${recurSched.id},
                 occurrence_date = ${firstVisitDate}::date,
                 allowed_hours = COALESCE(allowed_hours, ${recurAllowedHrs})
           WHERE id = ${jobId} AND company_id = ${Number(company_id)}
        `);

        // Materialize the upcoming occurrences now so the office sees the full
        // series immediately (single-schedule generation is safe; the first date
        // is deduped via the occurrence_date we just stamped on the first job).
        try {
          const { generateJobsFromSchedule, DAYS_AHEAD } = await import("../lib/recurring-jobs.js");
          const genNow = new Date();
          const genHorizon = new Date(genNow.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);
          const gen = await generateJobsFromSchedule(recurSched as any, genNow, genHorizon, null, addrZip ?? null);
          console.log(`[online-recurring] schedule ${recurSched.id} client ${clientId} (${normalizedFreq}) — first job ${jobId} adopted, ${gen.created} upcoming visit(s) generated`);
        } catch (genErr) {
          console.error("[online-recurring] inline generation failed (schedule created; 2 AM cron will backfill):", genErr);
        }
      } catch (recurErr) {
        console.error("[online-recurring] failed to create recurring_schedule for booking job", jobId, recurErr);
      }
    }

    // [book-from-quote] If this booking came from a quote email's "Book" link,
    // mark that quote booked (linked to the new job) + stop its follow-up drip,
    // so the customer isn't chased after they've already booked. Non-blocking.
    if (quote_id) {
      try {
        await db.execute(drizzleSql`
          UPDATE quotes SET status = 'booked', booked_job_id = ${jobId}, accepted_at = NOW()
          WHERE id = ${Number(quote_id)} AND company_id = ${Number(company_id)}`);
        import("../services/followUpService.js")
          .then(({ stopEnrollmentsForQuote }) => stopEnrollmentsForQuote(Number(quote_id), "booked").catch(() => {}))
          .catch(() => {});
      } catch (qErr) {
        console.error("[book-from-quote] mark quote booked failed:", qErr);
      }
    }

    // ── In-app notification: new booking ────────────────────────────────────
    try {
      const notifBody = `${first_name} ${last_name} booked a ${scopeName} for ${preferred_date || "an upcoming date"} — $${adjustedTotal.toFixed(2)}`;
      // Deep-link to THIS booking on the dispatch board (date + job) so the
      // office can act on it (assign a tech) — not the generic /customers list.
      const notifLink = `/dispatch?date=${preferred_date || new Date().toISOString().split("T")[0]}&job=${jobId}`;
      await db.execute(
        drizzleSql`INSERT INTO notifications (company_id, type, title, body, link, meta)
          VALUES (${Number(company_id)}, 'new_booking', ${'New Booking — ' + first_name + ' ' + last_name}, ${notifBody}, ${notifLink}, ${JSON.stringify({ job_id: jobId, client_name: `${first_name} ${last_name}` })}::jsonb)`
      );
    } catch (notifErr) {
      console.error("[new_booking notify] failed:", notifErr);
    }

    // [booking-confirmation GAP1] Customer booking confirmation (email + SMS w/
    // appointment-view link). Gate-respecting + per-tenant. Non-blocking.
    import("../lib/booking-confirmation.js").then(({ sendJobScheduledConfirmation }) =>
      sendJobScheduledConfirmation(req, jobId)
    ).catch(() => {});

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
                -- [recurring-dup-fix 2026-07-13] Link Job 2 to the schedule we just
                -- created and stamp its occurrence slot. Without these the job was
                -- an orphan (rs=NULL, occ=NULL) the engine couldn't see, so it
                -- regenerated a DUPLICATE first visit onto the same date.
                recurring_schedule_id, occurrence_date,
                upsell_shown, upsell_accepted, upsell_cadence_selected,
                arrival_window,
                booking_location,
                address_street, address_city, address_state, address_zip,
                address_lat, address_lng, address_verified,
                job_type, notes, created_at
              ) VALUES (
                ${company_id}, ${clientId}, ${"recurring"}, ${"scheduled"},
                ${recurringDateVal}::date, ${normalizedRecurFreq}, ${firstVisitRate},
                ${scheduleId}, ${recurringDateVal}::date,
                false, false, ${upsellCadenceVal},
                ${arrivalWindowVal},
                ${bookLocVal},
                ${addrStreet}, ${addrCity}, ${addrState}, ${addrZip},
                ${addrLat}, ${addrLng}, ${addrVerified},
                'residential', ${recurJobNotes}, NOW()
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

    // [booking-conversion 2026-07-13] Capture the quote id so the confirm response
    // hands it back — the parent-page conversion event includes quoteId.
    const bookingQuoteRes = await db.execute(
      drizzleSql`
        INSERT INTO quotes (
          company_id, client_id, scope_id, sqft, frequency,
          base_price, discount_amount, discount_code, total_price,
          estimated_hours, addons, status, booked_job_id,
          bedrooms, bathrooms, pets, notes, created_at
        ) VALUES (
          ${company_id}, ${clientId}, NULL, ${sqft}, ${frequency},
          ${pricing.base_price}, ${pricing.discount_amount}, ${discount_code || null}, ${pricing.final_total},
          ${pricing.base_hours}, ${addonBreakdownJson}::jsonb, 'booked', ${jobId},
          ${bedrooms || null}, ${bathrooms || null}, ${pets || null},
          ${`Online booking: ${scopeName}, ${sqft} sqft, ${frequency}`},
          NOW()
        ) RETURNING id
      `
    );
    const bookingQuoteId = (bookingQuoteRes.rows[0] as any)?.id ?? null;

    // ── Create/advance lead record (booking_widget source) ────────────────────
    try {
      // Dedup: if this customer already got an online quote (needs_contacted
      // lead from abandon-track), UPGRADE that same lead to booked rather than
      // create a second one. Else insert a fresh booked lead.
      const bookedLeadId = await upsertWidgetLead(company_id, {
        email, phone, first_name, last_name, address: address || null, zip: zip || null,
        scope: scopeName, source: "booking_widget", status: "booked", jobId, booked: true,
      });
      // Log the booking as a lead activity so the pipeline's Activity tab shows
      // it (the lead status flips to "booked", but that alone left the timeline
      // empty — "no activity yet" on a freshly-booked lead).
      if (bookedLeadId) {
        await db.execute(drizzleSql`
          INSERT INTO lead_activity_log (lead_id, company_id, action_type, note, performed_by, created_at)
          VALUES (${bookedLeadId}, ${company_id}, 'booked',
                  ${`Booked ${scopeName} for ${preferred_date || "an upcoming date"} via website — $${adjustedTotal.toFixed(2)}`},
                  NULL, NOW())
        `).catch((e) => console.error("[confirm] lead activity log failed (non-fatal):", e));
      }
      // Booking finished — stop any abandoned-booking drip first (FK is
      // ON DELETE SET NULL, so the delete below only nulls an already-stopped
      // enrollment), then remove the abandoned booking for this email.
      await stopEnrollmentsForAbandonedBooking(company_id, email, "booking_completed");
      await db.execute(drizzleSql`
        DELETE FROM abandoned_bookings WHERE company_id = ${company_id} AND email = ${email}
      `);
    } catch (leadErr) {
      console.error("[confirm] Failed to create lead record:", leadErr);
    }

    // ── Confirmation emails ───────────────────────────────────────────────────
    // COMMS_ENABLED does NOT gate transactional booking confirmations — only
    // automated outbound (reminders, drip, promos) is suppressed by that flag.
    // This is the same bypass used by /api/contact for inbound lead signals.
    const resendKey = process.env.RESEND_API_KEY;
    const emailDateStr = preferred_date
      ? new Date(preferred_date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
      : "To be scheduled";
    const emailWindowLabel = arrivalWindowVal === "morning" ? "9:00 AM – 12:00 PM" : arrivalWindowVal === "afternoon" ? "12:00 PM – 2:00 PM" : (arrivalWindowVal || "To be confirmed");
    const emailAddonBreakdown: Array<{ name: string; amount: number }> = (pricing.addon_breakdown || []).map((a: any) => ({ name: a.name, amount: parseFloat(String(a.amount || 0)) }));
    const emailBundleDiscount = bundleDiscount ? Math.abs(parseFloat(String(bundleDiscount))) : 0;

    // Read per-tenant office email settings to gate zone + techs queries
    let officeEmailShowZone = true;
    let officeEmailShowTechs = true;
    try {
      const settingsRow = await db.execute(drizzleSql`
        SELECT office_email_show_zone, office_email_show_available_techs
        FROM companies WHERE id = ${company_id} LIMIT 1
      `);
      if ((settingsRow as any).rows?.length > 0) {
        const r = (settingsRow as any).rows[0];
        officeEmailShowZone = r.office_email_show_zone !== false;
        officeEmailShowTechs = r.office_email_show_available_techs !== false;
      }
    } catch {}

    // Zone lookup for office notification subject and body
    let bookingZoneName: string | null = null;
    let bookingZoneColor: string | null = null;
    if (officeEmailShowZone) {
      try {
        const zipForZone = (address_zip || zip || "").trim().replace(/\D/g, "").slice(0, 5);
        if (zipForZone.length === 5) {
          const zoneResult = await db.execute(drizzleSql`
            SELECT name, color FROM service_zones
            WHERE company_id = ${company_id}
              AND is_active = true
              AND zip_codes @> ARRAY[${zipForZone}]::text[]
            LIMIT 1
          `);
          if ((zoneResult as any).rows?.length > 0) {
            bookingZoneName = (zoneResult as any).rows[0].name || null;
            bookingZoneColor = (zoneResult as any).rows[0].color || null;
          }
        }
      } catch {}
    }

    // Available techs: active techs with no jobs assigned on the booking date
    let availableTechs: Array<{ name: string }> | null = null;
    if (officeEmailShowTechs) {
      try {
        if (preferred_date) {
          const techResult = await db.execute(drizzleSql`
            SELECT u.first_name, u.last_name
            FROM users u
            WHERE u.company_id = ${company_id}
              AND u.is_active = true
              -- [avail-techs-fix 2026-07-19] Was 'u.role = tech' — there is NO
              -- 'tech' value in the role enum (it's 'technician'), so this query
              -- threw an invalid-enum error every time, got swallowed by the
              -- catch, and the "Available This Window" block silently never
              -- rendered. Use the SAME field-staff predicate the dispatch board
              -- uses (routes/dispatch.ts): technician + team_lead, plus office/
              -- admin only if field-tagged, and hide placeholder/QA accounts.
              -- This also correctly excludes office staff (e.g. Maribel/Francisco).
              AND u.show_on_dispatch IS NOT FALSE
              AND (
                u.role NOT IN ('admin', 'owner', 'office', 'super_admin', 'accountant')
                OR (COALESCE(u.tags, '{}') && ARRAY['field','technician']::text[])
              )
              AND u.id NOT IN (
                SELECT jt.user_id FROM job_technicians jt
                JOIN jobs j ON j.id = jt.job_id
                WHERE j.company_id = ${company_id}
                  AND j.scheduled_date = ${preferred_date}::date
                  AND j.status != 'cancelled'
                UNION
                SELECT j.assigned_user_id FROM jobs j
                WHERE j.company_id = ${company_id}
                  AND j.scheduled_date = ${preferred_date}::date
                  AND j.assigned_user_id IS NOT NULL
                  AND j.status != 'cancelled'
              )
            ORDER BY u.first_name
          `);
          availableTechs = ((techResult as any).rows ?? []).map((r: any) => ({
            name: `${r.first_name || ""} ${r.last_name || ""}`.trim(),
          }));
        }
      } catch {}
    }

    const emailParams = {
      firstName: first_name,
      lastName: last_name,
      email,
      phone,
      serviceType: scopeName,
      scheduledDate: emailDateStr,
      arrivalWindow: emailWindowLabel,
      serviceAddress: address || addrStreet || "",
      addressLine2: address_line2 || null,
      preferredContactMethod: preferred_contact_method || "Phone",
      basePrice: pricing.base_price || 0,
      addons: emailAddonBreakdown,
      bundleDiscount: emailBundleDiscount,
      firstVisitTotal: adjustedTotal,
      specialNotes: move_in_notes || null,
      sqft: sqft ? parseInt(String(sqft)) : null,
      branchConfig,
      jobId,
      quoteId: bookingQuoteId,
      clientId,
      stripeCustomerId: stripe_customer_id || null,
      stripePaymentMethodId: payment_method_id || null,
      bedrooms: bedrooms ? parseInt(String(bedrooms)) : null,
      fullBathrooms: bathrooms ? parseInt(String(bathrooms)) : null,
      halfBathrooms: half_baths ? parseInt(String(half_baths)) : null,
      floors: floors ? parseInt(String(floors)) : null,
      people: people ? parseInt(String(people)) : null,
      pets: pets ? parseInt(String(pets)) : null,
      cleanlinessRating: cleanliness ? parseInt(String(cleanliness)) : null,
      acquisitionSource: normalizeReferral(referral_source),
      isReturningClient,
      zoneName: bookingZoneName,
      zoneColor: bookingZoneColor,
      availableTechs,
    };
    if (resendKey) {
      try {
        const { Resend } = await import("resend");
        const resend = new Resend(resendKey);
        // [dedup 2026-07-19] The CUSTOMER confirmation is sent by
        // sendJobScheduledConfirmation() above (the branded email WITH the
        // Add-to-Calendar Google/Apple/Outlook buttons + logo). Do NOT also send
        // the legacy buildClientConfirmationEmail here — it was a second,
        // calendar-less "Your Phes Deep Clean is Confirmed" email to the same
        // customer. Only the office notification remains in this block.
        const { subject: officeSubject, html: officeHtml } = buildOfficeNotificationEmail(emailParams);
        await resend.emails.send({
          from: `Phes <${branchConfig.officeEmail}>`,
          replyTo: branchConfig.officeEmail,
          to: [branchConfig.officeEmail],
          subject: officeSubject,
          html: officeHtml,
        });
      } catch (emailErr) {
        console.error("[confirm] Resend error:", emailErr);
      }
    }

    // ── Office SMS notification on confirm (per-tenant) ──────────────────────
    // FROM the tenant's own number via resolveSender; TO the tenant's configured
    // lead_notify_phone. No global-env number, no hardcoded Oak Lawn recipient.
    try {
      const { resolveSender, sendSmsVia } = await import("../lib/comms-sender.js");
      const sender = await resolveSender(Number(company_id), null);
      const notifyRow = await db.execute(drizzleSql`SELECT lead_notify_phone FROM companies WHERE id = ${company_id} LIMIT 1`);
      const officeTo = (notifyRow.rows[0] as any)?.lead_notify_phone || null;
      if (sender.reason) {
        console.log("[confirm] Office SMS suppressed:", sender.reason);
      } else if (officeTo) {
        const dateStr2 = preferred_date
          ? new Date(preferred_date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
          : "TBD";
        const windowLabel = arrivalWindowVal === "morning" ? "9AM–12PM" : arrivalWindowVal === "afternoon" ? "12PM–2PM" : (arrivalWindowVal || "");
        const smsBody = `📋 New Booking — ${first_name} ${last_name} | ${scopeName} | ${sqft} sqft | ${dateStr2}${windowLabel ? ` ${windowLabel}` : ""} | Job #${jobId}${recurringJobId ? ` + #${recurringJobId}` : ""}`;
        await sendSmsVia(sender, officeTo, smsBody);
      }
    } catch (smsErr) {
      console.error("[confirm] Office SMS error:", smsErr);
    }

    console.log(`[STRIPE] Booking confirmed — client_id=${clientId} job_id=${jobId}${recurringJobId ? ` recurring_job_id=${recurringJobId}` : ""} PM=${payment_method_id} card=${cardBrand} *${cardLast4} branch=${branchConfig.branch}`);
    return res.status(201).json({
      ok: true,
      client_id: clientId,
      job_id: jobId,
      recurring_job_id: recurringJobId,
      home_id: homeId,
      pricing,
      card_last4: cardLast4,
      card_brand: cardBrand,
      branch: branchConfig.branch,
      branch_phone: branchConfig.clientPhoneFormatted,
      branch_email: branchConfig.officeEmail,
    });
  } catch (err: any) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    const cause = err?.cause ?? {};
    console.error("POST /public/book/confirm CRASH:", {
      outerMsg: String(err?.message ?? "").substring(0, 300),
      pgCode: cause?.code,
      pgMsg: cause?.message,
      pgDetail: cause?.detail,
      pgHint: cause?.hint,
      pgSchema: cause?.schema,
      pgTable: cause?.table,
      pgColumn: cause?.column,
      pgConstraint: cause?.constraint,
      stack: String(err?.stack ?? "").split("\n").slice(0, 8).join(" | "),
    });
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
      preferred_contact_method,
      address_line2,
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

    const pricing = await runCalculate({ scope_id, sqft, frequency, addon_ids, discount_code, company_id, pets, public_only: true });
    const { sql: drizzleSql } = await import("drizzle-orm");

    const existingClients = await db.execute(
      drizzleSql`SELECT id FROM clients WHERE email = ${email} AND company_id = ${company_id} LIMIT 1`
    );

    // [address-capture 2026-07-10] Same address resolution as /book/confirm so the
    // client + job carry a real street, not just state+zip.
    const legResolvedAddr = await resolveBookingAddress({ address, address_street, address_city, address_state, address_zip, zip, address_lat, address_lng });

    let clientId: number;
    if (existingClients.rows.length > 0) {
      clientId = (existingClients.rows[0] as any).id;
      await db.execute(
        drizzleSql`UPDATE clients SET
          address = COALESCE(NULLIF(address, ''), ${legResolvedAddr.street}),
          city    = COALESCE(NULLIF(city, ''),    ${legResolvedAddr.city}),
          state   = COALESCE(NULLIF(state, ''),   ${legResolvedAddr.state}),
          zip     = COALESCE(NULLIF(zip, ''),     ${legResolvedAddr.zip})
          WHERE id = ${clientId}`
      );
    } else {
      const newClient = await db.execute(
        drizzleSql`
          INSERT INTO clients (company_id, first_name, last_name, phone, email, referral_source, address, city, state, zip, sms_consent, created_at)
          VALUES (${company_id}, ${first_name}, ${last_name}, ${phone}, ${email}, ${normalizeReferral(referral_source)}, ${legResolvedAddr.street}, ${legResolvedAddr.city}, ${legResolvedAddr.state}, ${legResolvedAddr.zip}, ${sms_consent ? true : false}, NOW())
          RETURNING id
        `
      );
      clientId = (newClient.rows[0] as any).id;
    }

    // [address-dedup 2026-07-19] Reuse an existing home at the SAME address
    // instead of stacking a duplicate property on every booking — repeat
    // bookings at one address were piling up identical "Home" rows on the
    // profile. Match on case-insensitive trimmed address + zip; refresh details.
    const homeAddr = address || address_street || "(address pending)";
    const homeZip = zip || address_zip || null;
    const existingHome = await db.execute(drizzleSql`
      SELECT id FROM client_homes
       WHERE company_id = ${company_id} AND client_id = ${clientId}
         AND lower(trim(COALESCE(address, ''))) = lower(trim(${homeAddr}))
         AND COALESCE(zip, '') = COALESCE(${homeZip}::text, '')
       ORDER BY is_primary DESC NULLS LAST, id ASC LIMIT 1`);
    let homeId: number;
    if (existingHome.rows.length) {
      homeId = (existingHome.rows[0] as any).id;
      await db.execute(drizzleSql`
        UPDATE client_homes SET bedrooms = COALESCE(${bedrooms || null}, bedrooms),
               bathrooms = COALESCE(${bathrooms || null}, bathrooms),
               sq_footage = COALESCE(${sqft || null}, sq_footage)
         WHERE id = ${homeId}`).catch(() => {});
    } else {
      const homeResult = await db.execute(drizzleSql`
        INSERT INTO client_homes (company_id, client_id, address, zip, bedrooms, bathrooms, sq_footage, is_primary, created_at)
        VALUES (${company_id}, ${clientId}, ${homeAddr}, ${homeZip}, ${bedrooms || null}, ${bathrooms || null}, ${sqft || null}, true, NOW())
        RETURNING id`);
      homeId = (homeResult.rows[0] as any).id;
    }

    const addonBreakdownJson = JSON.stringify(pricing.addon_breakdown);
    const scopeRow = await db.execute(drizzleSql`SELECT name FROM pricing_scopes WHERE id = ${scope_id} LIMIT 1`);
    const scopeName = (scopeRow.rows[0] as any)?.name || "Cleaning";
    const jobNotes = `Booked via online widget. Cleanliness: ${cleanliness || "N/A"}. People: ${people || "N/A"}. Floors: ${floors || "N/A"}. Home ID: ${homeId}.`;

    const legBookLoc = (booking_location === "oak_lawn" || booking_location === "schaumburg") ? booking_location : null;
    const legAddrStreet = legResolvedAddr.street;
    const legAddrCity = legResolvedAddr.city;
    const legAddrState = legResolvedAddr.state;
    const legAddrZip = legResolvedAddr.zip;
    const legAddrLat = legResolvedAddr.lat;
    const legAddrLng = legResolvedAddr.lng;
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
          preferred_contact_method,
          address_line2,
          booking_location, address_street, address_city, address_state, address_zip,
          address_lat, address_lng, address_verified,
          job_type, notes, created_at
        ) VALUES (
          ${company_id}, ${clientId}, ${scopeName}, 'scheduled',
          ${preferred_date || new Date().toISOString().split("T")[0]}, ${legNormFreq}, ${pricing.final_total}, ${pricing.base_hours}, ${pricing.hourly_rate},
          ${preferred_contact_method || null},
          ${address_line2 || null},
          ${legBookLoc}, ${legAddrStreet}, ${legAddrCity}, ${legAddrState}, ${legAddrZip},
          ${legAddrLat}, ${legAddrLng}, ${legAddrVerified},
          'residential', ${jobNotes}, NOW()
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
          ${company_id}, ${clientId}, NULL, ${sqft}, ${frequency},
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
          VALUES (${company_id}, ${first_name}, ${last_name}, ${phone}, ${email}, ${normalizeReferral(referral_source)}, ${address || null}, NOW())
          RETURNING id
        `
      );
      clientId = (newClient.rows[0] as any).id;
    }

    const wtBookLoc = (booking_location === "oak_lawn" || booking_location === "schaumburg") ? booking_location : null;
    const wtAddrZip = address_zip || zip || null;

    // [walkthrough-no-job 2026-07-09] A walkthrough is a SALES step, NOT a
    // cleaning. Do NOT create a $0 job on the dispatch board — it clutters the
    // grid and skews revenue/hours (Maribel: "did the walkthrough create a
    // job?"). Instead land it in the Lead Pipeline (needs_contacted) carrying
    // the requested date + address in details, so the office can schedule the
    // actual walkthrough and then quote. The alert email below still fires.
    await upsertWidgetLead(company_id, {
      email, phone, first_name, last_name,
      address: address || null, zip: wtAddrZip,
      scope: "Commercial Walkthrough", source: "booking_widget", status: "needs_contacted",
      details: {
        requested_walkthrough_date: preferred_date || null,
        walkthrough_address: address || null,
        booking_location: wtBookLoc,
      },
    });

    const resendKey = process.env.RESEND_API_KEY;
    if (process.env.COMMS_ENABLED !== "true") {
      console.log("[COMMS BLOCKED] Walkthrough notification email suppressed:", { email, first_name, last_name });
    } else if (resendKey) {
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

    console.log(`[WALKTHROUGH] Lead created — client_id=${clientId} (no dispatch job)`);
    return res.status(201).json({ ok: true, client_id: clientId });
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
          VALUES (${company_id}, ${first_name}, ${last_name}, ${phone}, ${email}, ${normalizeReferral(referral_source)}, ${stripe_customer_id || null}, ${payment_method_id}, 'stripe', ${cardLast4}, ${cardBrand}, ${cardExpiry}, NOW(), NOW())
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
          job_type, notes, created_at
        ) VALUES (
          ${company_id}, ${clientId}, 'office_cleaning', 'scheduled', ${preferred_date || new Date().toISOString().split('T')[0]}, 'on_demand', 180, 3, 60,
          ${cBookLoc}, ${cAddrStreet}, ${cAddrCity}, ${cAddrState}, ${cAddrZip}, ${cAddrLat}, ${cAddrLng}, ${cAddrVerified},
          'commercial', ${jobNotes}, NOW()
        ) RETURNING id
      `
    );
    const jobId = (jobResult.rows[0] as any).id;

    // [widget-lead 2026-07-04] Surface this booking in the Lead Pipeline.
    // Only /book/confirm (residential) created a lead — the commercial paths
    // didn't, so paid commercial bookings from the widget never appeared in
    // Leads. Mirror the /book/confirm insert. Non-fatal (never fails a booking).
    await upsertWidgetLead(company_id, { email, phone, first_name, last_name, address: address || null, zip: cAddrZip, scope: "Commercial Cleaning", source: "booking_widget", status: "booked", jobId, booked: true });

    console.log(`[COMMERCIAL] Single visit confirmed — client_id=${clientId} job_id=${jobId} card=${cardBrand} *${cardLast4}`);
    return res.status(201).json({ ok: true, client_id: clientId, job_id: jobId, pricing: { final_total: 180 }, card_last4: cardLast4, card_brand: cardBrand });
  } catch (err: any) {
    console.error("POST /public/book/commercial-confirm:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// [quote-details-carry 2026-07-07] Office alert for a web quote lead — carries
// EVERYTHING the visitor filled in (Sal: "how many bedrooms, how many
// bathrooms, what's the square footage, how did they hear about us… this
// basic information is not enough") plus a direct "Open this lead in Qleno"
// button. kind 'new' = first capture (contact + home details entered);
// kind 'quoted' = same visitor reached the price step and saw a real number.
// Bypasses COMMS_ENABLED — inbound lead signal, same as /api/contact.
async function sendQuoteLeadAlert(companyId: number, kind: "new" | "quoted", lead: {
  first_name?: string | null; last_name?: string | null; email?: string | null;
  phone?: string | null; address?: string | null; zip?: string | null; scope?: string | null;
  quoteAmount?: number | null; details?: Record<string, unknown> | null; leadId?: number | null;
}): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  const { sql: s } = await import("drizzle-orm");
  const cfgRows = await db.execute(s`
    SELECT lead_notify_email, email AS company_email, email_from_address
    FROM companies WHERE id = ${companyId} LIMIT 1
  `);
  const cfg: any = cfgRows.rows[0] ?? {};
  const notifyEmail = cfg.lead_notify_email || cfg.company_email || null;
  if (!notifyEmail) return;
  const fromAddr = cfg.email_from_address ? `Qleno <${cfg.email_from_address}>` : "Qleno <noreply@phes.io>";
  const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Unknown";
  const d: any = lead.details ?? {};
  const esc = (v: unknown) => String(v ?? "").replace(/[<>&]/g, ch => (ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&amp;"));
  const row = (label: string, value: unknown) =>
    value == null || value === "" ? "" :
    `<tr><td style="padding:6px 0;color:#6B6860;width:150px;vertical-align:top;">${label}</td><td style="padding:6px 0;font-weight:600;">${esc(value)}</td></tr>`;
  const stepLabel =
    Number(d.step_reached) >= 4 ? "Saw their price (reached the payment step)" :
    Number(d.step_reached) >= 2 ? "Entered contact + home details (left before seeing the price)" : null;
  const { appBaseUrl } = await import("../lib/app-url.js");
  const leadLink = `${appBaseUrl()}/leads${lead.leadId ? `?lead=${lead.leadId}` : ""}`;
  // [addr-dup-zip 2026-07-17] The widget's `address` is the Google-formatted
  // string, which ALREADY ends in the zip — appending `zip` again printed it
  // twice ("IL 60805 60805"). Only append when the address doesn't already
  // contain it (covers the rare street-only address), else show address as-is.
  const addrLine = (() => {
    const a = String(lead.address ?? "").trim();
    const z = String(lead.zip ?? "").trim();
    if (!a) return z || null;
    return z && !a.includes(z) ? `${a} ${z}` : a;
  })();
  const subject = kind === "quoted"
    ? `Quote Viewed${lead.quoteAmount != null ? ` ($${Number(lead.quoteAmount).toFixed(2)})` : ""} — ${fullName}`
    : `New Quote Request — ${fullName}`;
  const intro = kind === "quoted"
    ? "This visitor reached the price step and saw their quote, but has not completed the booking."
    : "Someone requested a quote on the website but has not yet completed their booking.";
  const { Resend } = await import("resend");
  const resend = new Resend(resendKey);
  await resend.emails.send({
    from: fromAddr,
    to: [notifyEmail],
    subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#F7F6F3;">
<div style="background:#fff;border:1px solid #E5E2DC;border-radius:8px;padding:32px;">
<div style="background:#00C9A0;padding:14px 20px;border-radius:4px;margin-bottom:20px;">
  <span style="color:#fff;font-size:16px;font-weight:bold;">${esc(subject)}</span>
</div>
<p style="color:#6B6860;font-size:13px;margin:0 0 16px;">${intro}</p>
<table style="width:100%;font-size:14px;color:#1A1917;border-collapse:collapse;">
  ${row("Name", fullName)}
  ${row("Email", lead.email)}
  ${row("Phone", lead.phone)}
  ${row("Address", addrLine)}
  ${row("Service", lead.scope)}
  ${row("Frequency", d.frequency)}
  ${row("Bedrooms", d.bedrooms)}
  ${row("Bathrooms", d.bathrooms)}
  ${row("Square footage", d.sqft ? `${d.sqft} sq ft` : null)}
  ${row("Add-ons", Array.isArray(d.add_ons) && d.add_ons.length ? d.add_ons.join(", ") : null)}
  ${row("How they heard about us", d.referral_source)}
  ${row("Quote shown", lead.quoteAmount != null ? `$${Number(lead.quoteAmount).toFixed(2)}` : null)}
  ${row("How far they got", stepLabel)}
</table>
<div style="text-align:center;margin:24px 0 0;">
  <a href="${leadLink}" style="display:inline-block;background:#00C9A0;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 24px;border-radius:6px;">Open This Lead in Qleno</a>
</div>
</div></div>`,
  });
}

// ── GET /api/public/resume/:token ────────────────────────────────────────────
// [resume-link 2026-07-18] Powers the abandoned-cart recovery {{resume_link}}:
// returns the captured contact + home details for a resume token so the booking
// widget can pre-fill and drop the visitor back where they left off. Read-only,
// token-gated (unguessable md5) — exposes only what the visitor themselves typed.
router.get("/resume/:token", rateLimit, async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(400).json({ error: "token required" });
    const { sql: drizzleSql } = await import("drizzle-orm");
    const r = await db.execute(drizzleSql`
      SELECT company_id, first_name, last_name, email, phone, address, zip, scope, details
        FROM abandoned_bookings WHERE resume_token = ${token} LIMIT 1`);
    const row = r.rows[0] as any;
    if (!row) return res.status(404).json({ error: "not found" });
    const d = (row.details && typeof row.details === "object") ? row.details : {};
    return res.json({
      company_id: row.company_id,
      first_name: row.first_name ?? null, last_name: row.last_name ?? null,
      email: row.email ?? null, phone: row.phone ?? null,
      address: row.address ?? null, zip: row.zip ?? null,
      scope: row.scope ?? null,
      bedrooms: d.bedrooms ?? null, bathrooms: d.bathrooms ?? null, sqft: d.sqft ?? null,
    });
  } catch (err) {
    console.error("GET /public/resume:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/public/book/abandon-track ──────────────────────────────────────
// Called from the booking widget when a user completes Step 1 but hasn't paid yet.
// Upserts an abandoned_bookings record so office can follow up if they leave.
router.post("/book/abandon-track", rateLimit, async (req, res) => {
  try {
    const { company_id, first_name, last_name, email, phone, address, zip, scope, step_abandoned = 2, stage, quote_amount, details: rawDetails } = req.body;
    if (!company_id) return res.status(400).json({ error: "company_id required" });

    // [booked-guard 2026-07-17] If this contact ALREADY has a booked lead, they're
    // a paying customer poking the widget again — not an abandoner. Skip the whole
    // abandon flow: no "you didn't finish" office alert, no recovery-drip enroll,
    // and don't merge stale abandoned details onto their booked card. (Surfaced by
    // Sal testing with one email: a booked lead kept getting incomplete-booking
    // alerts and its card showed "left before the price" over a real booking.)
    {
      const { sql: s } = await import("drizzle-orm");
      const em = email ? String(email).toLowerCase().trim() : null;
      const ph = (phone ?? "").replace(/[^0-9]/g, "").slice(-10) || null;
      if (em || ph) {
        const booked = await db.execute(s`
          SELECT id FROM leads
           WHERE company_id = ${company_id} AND status = 'booked'
             AND (${em ? s`LOWER(email) = ${em}` : s`FALSE`}
                  OR ${ph ? s`RIGHT(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 10) = ${ph}` : s`FALSE`})
           LIMIT 1`);
        if ((booked.rows as any[]).length) {
          console.log("[abandon-track] skip — contact already booked:", { company_id, email: em, phone: ph });
          return res.json({ ok: true, action: "skipped_already_booked" });
        }
      }
    }

    // [quote-details-carry 2026-07-07] Sanitized snapshot of the widget form —
    // whitelisted keys only, strings capped, so a hostile payload can't stuff
    // the jsonb. This is what makes the office alert + Lead Pipeline show the
    // FULL quote picture (beds/baths/sqft/frequency/add-ons/heard-about-us/how
    // far they got) instead of just contact info.
    const details: Record<string, unknown> = {};
    if (rawDetails && typeof rawDetails === "object") {
      const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);
      const d: any = rawDetails;
      if (num(d.bedrooms)) details.bedrooms = num(d.bedrooms);
      if (num(d.bathrooms)) details.bathrooms = num(d.bathrooms);
      if (num(d.sqft)) details.sqft = num(d.sqft);
      if (str(d.frequency)) details.frequency = str(d.frequency);
      if (str(d.referral_source)) details.referral_source = str(d.referral_source);
      if (Array.isArray(d.add_ons)) {
        const ads = d.add_ons.map(str).filter(Boolean).slice(0, 20);
        if (ads.length) details.add_ons = ads;
      }
      if (num(d.step_reached)) details.step_reached = num(d.step_reached);
    }
    const detailsOrNull = Object.keys(details).length ? details : null;
    // [quote-not-booked 2026-07-06] The widget passes stage='quoted' (+ quote_amount)
    // once the visitor reaches the payment step and has seen a real price, so an
    // un-booked online quote lands in the Pipeline's QUOTED column. Default stays
    // needs_contacted (the early step-1 capture). Only these two stages are accepted;
    // upsertWidgetLead only ever UPGRADES stage, so this never downgrades a booking.
    const leadStage = stage === "quoted" ? "quoted" : "needs_contacted";
    const quoteAmt = quote_amount != null && !isNaN(Number(quote_amount)) ? Number(quote_amount) : null;

    // [widget-lead-first 2026-07-09] Create/upgrade the pipeline Lead FIRST —
    // before the abandoned_bookings write and drip enrollment. The lead (contact
    // + full quote snapshot in details) is what the office actually needs; it
    // must never again be the order-last, failure-swallowed afterthought that let
    // a completed online quote fire the "you didn't finish" recovery drip while
    // leaving NO lead in the pipeline (the Georgann Gambill incident). Deduped by
    // email/phone; upgrades to booked later. Non-fatal, but we now log loudly on
    // failure so a dropped lead is diagnosable instead of silent.
    const leadId = await upsertWidgetLead(company_id, {
      email, phone, first_name, last_name, address, zip, scope,
      source: "web_quote", status: leadStage, quoteAmount: quoteAmt, details: detailsOrNull,
    });
    if (leadId == null) {
      console.error("[abandon-track] LEAD CREATION FAILED — recording abandoned booking + drip, but NO pipeline lead was created:", { company_id, email, phone, stage: leadStage });
    }

    const { sql: drizzleSql } = await import("drizzle-orm");
    if (email) {
      const existing = await db.execute(
        drizzleSql`SELECT id, step_abandoned FROM abandoned_bookings WHERE company_id = ${company_id} AND email = ${email} LIMIT 1`
      );
      if (existing.rows.length > 0) {
        const abId = (existing.rows[0] as any).id;
        const prevStep = Number((existing.rows[0] as any).step_abandoned) || 0;
        await db.execute(drizzleSql`
          UPDATE abandoned_bookings SET
            first_name = COALESCE(${first_name || null}, first_name),
            last_name  = COALESCE(${last_name || null}, last_name),
            phone      = COALESCE(${phone || null}, phone),
            address    = COALESCE(${address || null}, address),
            zip        = COALESCE(${zip || null}, zip),
            scope      = COALESCE(${scope || null}, scope),
            step_abandoned = ${step_abandoned},
            details    = COALESCE(details, '{}'::jsonb) || COALESCE(${detailsOrNull ? JSON.stringify(detailsOrNull) : null}::jsonb, '{}'::jsonb),
            resume_token = COALESCE(resume_token, md5(random()::text || clock_timestamp()::text)),
            updated_at = NOW()
          WHERE company_id = ${company_id} AND email = ${email}
        `);
        // Idempotent enroll (no-ops if already enrolled or sequence inactive).
        // The Lead was already created/upgraded above (widget-lead-first) as
        // `leadId`. [cart-drip-visible 2026-07-09] Pass that lead id so the cart
        // drip links to the lead and surfaces on the lead card + Drip tab.
        await enrollForAbandonedBooking(company_id, abId, leadId);
        // [quote-details-carry 2026-07-07] Second office alert when the SAME
        // visitor advances to the price step ("did they only click this
        // quote?" — this says they saw a real number). Fires once: only on
        // the step 2→4 upgrade.
        if (leadStage === "quoted" && prevStep < 4 && Number(step_abandoned) >= 4) {
          await sendQuoteLeadAlert(company_id, "quoted", {
            first_name, last_name, email, phone, address, zip, scope,
            quoteAmount: quoteAmt, details: detailsOrNull, leadId,
          }).catch((e: any) => console.error("[abandon-track] quoted alert error:", e));
        }
        return res.json({ ok: true, action: "updated" });
      }
    }
    const inserted = await db.execute(drizzleSql`
      INSERT INTO abandoned_bookings (company_id, first_name, last_name, email, phone, address, zip, scope, step_abandoned, details, resume_token, created_at, updated_at)
      VALUES (${company_id}, ${first_name || null}, ${last_name || null}, ${email || null}, ${phone || null},
              ${address || null}, ${zip || null}, ${scope || null}, ${step_abandoned},
              COALESCE(${detailsOrNull ? JSON.stringify(detailsOrNull) : null}::jsonb, '{}'::jsonb),
              md5(random()::text || clock_timestamp()::text || ${company_id}::text), NOW(), NOW())
      RETURNING id, resume_token
    `);
    const newAbId = (inserted.rows[0] as any)?.id;
    const newResumeToken = (inserted.rows[0] as any)?.resume_token ?? null;
    // Lead already created above (widget-lead-first) as `leadId`.
    // [cart-drip-visible 2026-07-09] Enroll with that lead id so the cart drip
    // links to the lead and shows on the lead card + Drip tab.
    if (newAbId) await enrollForAbandonedBooking(company_id, newAbId, leadId);

    // Immediate office notification — bypass COMMS_ENABLED (this is an inbound
    // lead signal, not automated outbound). Same bypass logic as /api/contact.
    // [quote-details-carry 2026-07-07] Full quote picture + Open-in-Qleno link.
    try {
      await sendQuoteLeadAlert(company_id, "new", {
        first_name, last_name, email, phone, address, zip, scope,
        quoteAmount: quoteAmt, details: detailsOrNull, leadId,
      });
      // Office SMS alert via per-tenant sender
      const { resolveSender, sendSmsVia } = await import("../lib/comms-sender.js");
      const sender = await resolveSender(Number(company_id), null);
      const notifyRows = await db.execute(drizzleSql`SELECT lead_notify_phone FROM companies WHERE id = ${company_id} LIMIT 1`);
      const officeTo = (notifyRows.rows[0] as any)?.lead_notify_phone || null;
      const fullName = [first_name, last_name].filter(Boolean).join(" ") || "Unknown";
      if (!sender.reason && officeTo) {
        await sendSmsVia(sender, officeTo, `New quote request — ${fullName}${phone ? ` — ${phone}` : ""}${scope ? ` — ${scope}` : ""}. Did not complete booking.`);
      }
    } catch (notifyErr) {
      console.error("[abandon-track] Office notification error:", notifyErr);
    }

    return res.json({ ok: true, action: "created", resume_token: newResumeToken });
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

    // [lead-drip-autoenroll] Un-booked online lead → start the online-quote
    // nurture drip (lead_drip_web), same as the office path does. Idempotent +
    // fire-and-forget; no-ops if the sequence is inactive.
    if (leadId) enrollForLeadDrip(Number(company_id), leadId, "web_quote").catch(() => {});

    // Office SMS alert (per-tenant) — FROM the tenant's own number via
    // resolveSender, TO the tenant's lead_notify_phone. No global-env / Oak Lawn.
    try {
      const { resolveSender, sendSmsVia } = await import("../lib/comms-sender.js");
      const sender = await resolveSender(Number(company_id), null);
      const notifyRow = await db.execute(drizzleSql`SELECT lead_notify_phone FROM companies WHERE id = ${company_id} LIMIT 1`);
      const officeTo = (notifyRow.rows[0] as any)?.lead_notify_phone || null;
      if (sender.reason) {
        console.log("[very-dirty] Office SMS suppressed:", sender.reason);
      } else if (officeTo) {
        await sendSmsVia(sender, officeTo, `Very Dirty Lead — ${first_name} ${last_name || ""} — ${phone}. Needs manual callback. Lead #${leadId || "N/A"}.`);
      }
    } catch (smsErr) {
      console.error("[very-dirty] SMS error:", smsErr);
    }

    const resendKey = process.env.RESEND_API_KEY;
    if (process.env.COMMS_ENABLED !== "true") {
      console.log("[COMMS BLOCKED] Very-dirty lead office email suppressed:", { first_name, last_name, phone });
    } else if (resendKey) {
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

// ── POST /api/public/leads/post-construction ─────────────────────────────────
router.post("/leads/post-construction", rateLimit, async (req, res) => {
  try {
    const {
      company_id, first_name, last_name, email, phone,
      address, sqft, construction_type, completion_date, notes,
      photos = [],
    } = req.body as {
      company_id: number; first_name: string; last_name: string;
      email: string; phone?: string; address?: string;
      sqft?: string; construction_type?: string; completion_date?: string; notes?: string;
      photos?: { name: string; data: string; mimeType: string }[];
    };

    if (!company_id || !first_name || !email || !construction_type || !completion_date) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ── Insert lead ───────────────────────────────────────────────────────────
    const { sql: drizzleSql } = await import("drizzle-orm");
    const pcInsert = await db.execute(drizzleSql`
      INSERT INTO leads (company_id, first_name, last_name, email, phone, address, lead_type, source, status, construction_type, completion_date, notes, sqft, created_at, updated_at)
      VALUES (${company_id}, ${first_name}, ${last_name || null}, ${email}, ${phone || null}, ${address || null},
              'post_construction', 'widget', 'new', ${construction_type}, ${completion_date}, ${notes || null},
              ${sqft ? parseInt(sqft) : null}, NOW(), NOW())
      RETURNING id
    `);
    // [lead-drip-autoenroll] Online post-construction inquiry → online-quote drip.
    const pcLeadId = (pcInsert.rows[0] as any)?.id;
    if (pcLeadId) enrollForLeadDrip(Number(company_id), pcLeadId, "web_quote").catch(() => {});

    // ── Send email to PHES office ─────────────────────────────────────────────
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      try {
        const { Resend } = await import("resend");
        const resend = new Resend(resendKey);

        const constructionTypeLabels: Record<string, string> = {
          new_construction: "New Construction",
          renovation: "Renovation / Remodel",
          addition: "Home Addition",
          commercial_buildout: "Commercial Build-Out",
          other: "Other",
        };
        const ctLabel = constructionTypeLabels[construction_type] ?? construction_type;

        const attachments = (photos as { name: string; data: string; mimeType: string }[])
          .slice(0, 10)
          .map(p => ({
            filename: p.name,
            content: p.data,
          }));

        const html = `
<h2 style="font-family:sans-serif;color:#1A1917;">New Post-Construction Lead</h2>
<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse;width:100%;max-width:480px;">
  <tr><td style="padding:6px 12px 6px 0;color:#6B6860;font-weight:600;">Name</td><td style="padding:6px 0;">${first_name} ${last_name || ""}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#6B6860;font-weight:600;">Email</td><td style="padding:6px 0;"><a href="mailto:${email}">${email}</a></td></tr>
  ${phone ? `<tr><td style="padding:6px 12px 6px 0;color:#6B6860;font-weight:600;">Phone</td><td style="padding:6px 0;">${phone}</td></tr>` : ""}
  ${address ? `<tr><td style="padding:6px 12px 6px 0;color:#6B6860;font-weight:600;">Service Zip/Address</td><td style="padding:6px 0;">${address}</td></tr>` : ""}
  <tr><td style="padding:6px 12px 6px 0;color:#6B6860;font-weight:600;">Construction Type</td><td style="padding:6px 0;">${ctLabel}</td></tr>
  ${sqft ? `<tr><td style="padding:6px 12px 6px 0;color:#6B6860;font-weight:600;">Square Footage</td><td style="padding:6px 0;">${sqft} sq ft</td></tr>` : ""}
  <tr><td style="padding:6px 12px 6px 0;color:#6B6860;font-weight:600;">Completion Date</td><td style="padding:6px 0;">${completion_date}</td></tr>
  ${notes ? `<tr><td style="padding:6px 12px 6px 0;color:#6B6860;font-weight:600;vertical-align:top;">Notes</td><td style="padding:6px 0;">${notes.replace(/\n/g, "<br>")}</td></tr>` : ""}
  <tr><td style="padding:6px 12px 6px 0;color:#6B6860;font-weight:600;">Photos</td><td style="padding:6px 0;">${attachments.length} attached</td></tr>
</table>
        `.trim();

        await resend.emails.send({
          from: "Qleno Leads <noreply@phes.io>",
          to: ["info@phes.io"],
          replyTo: email,
          subject: `Post-Construction Lead: ${first_name} ${last_name || ""} — ${ctLabel}`,
          html,
          attachments: attachments.length > 0 ? attachments : undefined,
        });
      } catch (emailErr) {
        console.error("[leads/post-construction] Resend error:", emailErr);
      }
    }

    return res.status(201).json({ ok: true });
  } catch (err: any) {
    console.error("POST /public/leads/post-construction:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
