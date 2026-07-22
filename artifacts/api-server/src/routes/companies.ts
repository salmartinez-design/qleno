import { Router } from "express";
import { db } from "@workspace/db";
import { companiesTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import multer from "multer";
import path from "path";
import { mkdirSync } from "fs";
import { requireAuth } from "../lib/auth.js";
import { renderW9 } from "../lib/w9-pdf.js";

function getLogosDir(): string {
  const base = process.env.UPLOADS_DIR || path.resolve(process.cwd(), "uploads");
  const dir = path.join(base, "logos");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => { cb(null, getLogosDir()); },
  filename: (req, _file, cb) => {
    cb(null, `company_${req.auth!.companyId}_logo.jpg`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PNG, JPG, and WebP files are allowed"));
    }
  },
});

const router = Router();

router.get("/me", requireAuth, async (req, res) => {
  try {
    if (!req.auth!.companyId) {
      return res.status(404).json({ error: "Not Found", message: "No company for this user" });
    }
    const rows = await db.execute(sql`
      SELECT c.*
      FROM companies c
      WHERE c.id = ${req.auth!.companyId}
      LIMIT 1
    `);
    const company = ((rows as any).rows ?? [])[0];

    if (!company) {
      return res.status(404).json({ error: "Not Found", message: "Company not found" });
    }

    // Never expose the Twilio auth token to the client; surface a boolean so the
    // Integrations UI can show "connected" without the secret.
    if (company.twilio_auth_token !== undefined) {
      company.twilio_auth_token_set = !!company.twilio_auth_token;
      delete company.twilio_auth_token;
    }

    return res.json(company);
  } catch (err) {
    console.error("Get company error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get company" });
  }
});

// ─── Company W-9 / tax info (for the fillable IRS W-9) ────────────────────────
const W9_S = (v: unknown): string | null => { const s = String(v ?? "").trim(); return s ? s.slice(0, 200) : null; };

// Save the tenant's W-9 tax info.
router.put("/w9", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (!companyId) return res.status(403).json({ error: "Forbidden" });
    const b = req.body ?? {};
    await db.execute(sql`
      UPDATE companies SET
        w9_legal_name = ${W9_S(b.w9_legal_name)},
        w9_business_name = ${W9_S(b.w9_business_name)},
        w9_classification = ${W9_S(b.w9_classification)},
        w9_llc_class = ${W9_S(b.w9_llc_class)},
        w9_ein = ${W9_S(b.w9_ein)},
        w9_exempt_payee_code = ${W9_S(b.w9_exempt_payee_code)},
        w9_fatca_code = ${W9_S(b.w9_fatca_code)}
      WHERE id = ${companyId}
    `);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Save W-9 error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Download the filled official IRS W-9 from saved tax info.
router.get("/w9.pdf", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (!companyId) return res.status(403).json({ error: "Forbidden" });
    const rows = await db.execute(sql`
      SELECT name, address, city, state, zip, invoice_business_name,
             w9_legal_name, w9_business_name, w9_classification, w9_llc_class, w9_ein, w9_exempt_payee_code, w9_fatca_code
      FROM companies WHERE id = ${companyId} LIMIT 1
    `);
    const c: any = (rows as any).rows[0];
    if (!c) return res.status(404).json({ error: "Not Found" });
    if (!c.w9_ein) return res.status(422).json({ error: "Unprocessable", reason: "no_ein", message: "Add your EIN in Settings → Tax / W-9 first." });
    const cityStateZip = [c.city, [c.state, c.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null;
    const pdf = await renderW9({
      legalName: c.w9_legal_name || c.invoice_business_name || c.name || "",
      businessName: c.w9_business_name,
      classification: (c.w9_classification || "other") as any,
      llcClass: c.w9_llc_class,
      ein: c.w9_ein,
      address: c.address,
      cityStateZip,
      exemptPayeeCode: c.w9_exempt_payee_code,
      fatcaCode: c.w9_fatca_code,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="W-9-${String(c.w9_legal_name || c.name || "company").replace(/[^a-z0-9]+/gi, "-")}.pdf"`);
    return res.end(pdf);
  } catch (err) {
    console.error("W-9 PDF error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/me", requireAuth, async (req, res) => {
  try {
    if (!req.auth!.companyId) {
      return res.status(403).json({ error: "Forbidden", message: "No company to update" });
    }
    const {
      name, logo_url, pay_cadence, geo_fence_threshold_ft, brand_color,
      payment_terms_days, dispatch_start_hour, dispatch_end_hour,
      review_link, overhead_rate_pct,
    } = req.body;

    const setObj: Record<string, unknown> = {};
    if (name !== undefined) setObj.name = name;
    if (logo_url !== undefined) setObj.logo_url = logo_url;
    if (pay_cadence !== undefined) setObj.pay_cadence = pay_cadence;
    if (geo_fence_threshold_ft !== undefined) setObj.geo_fence_threshold_ft = geo_fence_threshold_ft;
    if (brand_color !== undefined) setObj.brand_color = brand_color;
    if (payment_terms_days !== undefined) setObj.payment_terms_days = Number(payment_terms_days);
    if (dispatch_start_hour !== undefined) setObj.dispatch_start_hour = Number(dispatch_start_hour);
    if (dispatch_end_hour !== undefined) setObj.dispatch_end_hour = Number(dispatch_end_hour);
    if (review_link !== undefined) setObj.review_link = review_link || null;
    if (overhead_rate_pct !== undefined) setObj.overhead_rate_pct = String(parseFloat(String(overhead_rate_pct)));

    const updated = await db
      .update(companiesTable)
      .set(setObj as any)
      .where(eq(companiesTable.id, req.auth!.companyId))
      .returning();

    return res.json(updated[0]);
  } catch (err) {
    console.error("Update company error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to update company" });
  }
});

router.patch("/me", requireAuth, async (req, res) => {
  try {
    if (!req.auth!.companyId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const {
      name, logo_url, pay_cadence, geo_fence_threshold_ft, brand_color,
      sms_on_my_way_enabled, sms_arrived_enabled, sms_paused_enabled,
      sms_complete_enabled, twilio_from_number,
      geofence_enabled, geofence_clockin_radius_ft, geofence_clockout_radius_ft,
      geofence_override_allowed, geofence_soft_mode, flag_missing_gps,
      require_after_photo_for_clockout,
    } = req.body;

    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (logo_url !== undefined) patch.logo_url = logo_url;
    if (pay_cadence !== undefined) patch.pay_cadence = pay_cadence;
    if (geo_fence_threshold_ft !== undefined) patch.geo_fence_threshold_ft = geo_fence_threshold_ft;
    if (brand_color !== undefined) patch.brand_color = brand_color;
    if (sms_on_my_way_enabled !== undefined) patch.sms_on_my_way_enabled = sms_on_my_way_enabled;
    if (sms_arrived_enabled !== undefined) patch.sms_arrived_enabled = sms_arrived_enabled;
    if (sms_paused_enabled !== undefined) patch.sms_paused_enabled = sms_paused_enabled;
    if (sms_complete_enabled !== undefined) patch.sms_complete_enabled = sms_complete_enabled;
    if (twilio_from_number !== undefined) patch.twilio_from_number = twilio_from_number;
    // [lead-alerts 2026-07-06] Office "new lead" alert recipients. The
    // abandon-track office notification emails lead_notify_email (falling back
    // to company_email when null) and, when a number is present, texts
    // lead_notify_phone. Phone has NO fallback, so a null/blank phone = lead
    // text alerts OFF. Both trim; blank → null.
    {
      const { lead_notify_email, lead_notify_phone } = req.body;
      const cleanContact = (v: unknown) => {
        const s = String(v ?? "").trim();
        return s ? s.slice(0, 200) : null;
      };
      if (lead_notify_email !== undefined) patch.lead_notify_email = cleanContact(lead_notify_email);
      if (lead_notify_phone !== undefined) patch.lead_notify_phone = cleanContact(lead_notify_phone);
    }
    // [scorecard-survey 2026-06-12] Per-tenant post-job survey config (Customer
    // Comms) + Twilio connection (Integrations). twilio_enabled is the go-live
    // gate; auth token is write-only (only set when a non-empty value is sent).
    {
      const {
        survey_enabled, survey_message_template, survey_send_after_hours,
        twilio_enabled, twilio_account_sid, twilio_auth_token,
      } = req.body;
      if (survey_enabled !== undefined) patch.survey_enabled = !!survey_enabled;
      if (survey_message_template !== undefined) patch.survey_message_template = survey_message_template;
      if (survey_send_after_hours !== undefined) patch.survey_send_after_hours = Number(survey_send_after_hours) || 0;
      if (twilio_enabled !== undefined) patch.twilio_enabled = !!twilio_enabled;
      if (twilio_account_sid !== undefined) patch.twilio_account_sid = twilio_account_sid || null;
      if (twilio_auth_token !== undefined && twilio_auth_token !== "") patch.twilio_auth_token = twilio_auth_token;
    }
    // [ghl-estimate-bridge 2026-06-10] GoHighLevel webhook URLs (estimate drip).
    // https-only; empty string clears (disables the bridge).
    {
      const { ghl_estimate_sent_webhook, ghl_estimate_outcome_webhook } = req.body;
      const cleanGhlUrl = (v: unknown) => {
        const s = String(v ?? "").trim();
        return s && /^https:\/\//i.test(s) ? s.slice(0, 500) : null;
      };
      if (ghl_estimate_sent_webhook !== undefined) patch.ghl_estimate_sent_webhook = cleanGhlUrl(ghl_estimate_sent_webhook);
      if (ghl_estimate_outcome_webhook !== undefined) patch.ghl_estimate_outcome_webhook = cleanGhlUrl(ghl_estimate_outcome_webhook);
    }
    if (geofence_enabled !== undefined) patch.geofence_enabled = geofence_enabled;
    if (geofence_clockin_radius_ft !== undefined) patch.geofence_clockin_radius_ft = geofence_clockin_radius_ft;
    if (geofence_clockout_radius_ft !== undefined) patch.geofence_clockout_radius_ft = geofence_clockout_radius_ft;
    if (geofence_override_allowed !== undefined) patch.geofence_override_allowed = geofence_override_allowed;
    if (geofence_soft_mode !== undefined) patch.geofence_soft_mode = geofence_soft_mode;
    if (flag_missing_gps !== undefined) patch.flag_missing_gps = flag_missing_gps;
    if (require_after_photo_for_clockout !== undefined) patch.require_after_photo_for_clockout = require_after_photo_for_clockout;
    const {
      default_payment_terms_residential, default_payment_terms_commercial,
      default_invoice_notes_residential, default_invoice_notes_commercial,
      auto_send_invoices, auto_charge_on_invoice,
    } = req.body;
    if (default_payment_terms_residential !== undefined) patch.default_payment_terms_residential = default_payment_terms_residential;
    if (default_payment_terms_commercial !== undefined) patch.default_payment_terms_commercial = default_payment_terms_commercial;
    if (default_invoice_notes_residential !== undefined) patch.default_invoice_notes_residential = default_invoice_notes_residential;
    if (default_invoice_notes_commercial !== undefined) patch.default_invoice_notes_commercial = default_invoice_notes_commercial;
    if (auto_send_invoices !== undefined) patch.auto_send_invoices = auto_send_invoices;
    if (auto_charge_on_invoice !== undefined) patch.auto_charge_on_invoice = auto_charge_on_invoice;
    // [invoice-branding 2026-06-23] Per-tenant invoice header/footer/terms text.
    // Empty string clears (falls back to the generic default in the template).
    {
      const cleanText = (v: unknown) =>
        v === undefined ? undefined : (v === null || String(v).trim() === "" ? null : String(v).slice(0, 4000));
      const fields = ["invoice_business_name", "invoice_tagline", "invoice_address",
        "invoice_footer_message", "invoice_payment_instructions", "invoice_guarantee", "invoice_terms",
        // [agreement-late-fee 2026-07-22] Late-payment wording for {{late_fee}}
        // in service agreements. Same clear-on-empty semantics as the rest.
        "late_fee_terms"];
      // [agreement-clauses 2026-07-22] Numeric contract terms. Clamped to sane
      // ranges so a stray keystroke can't put "0 days" or a negative cap into a
      // signed agreement.
      const clampInt = (v: unknown, min: number, max: number) => {
        if (v === undefined || v === null || String(v).trim() === "") return undefined;
        const n = parseInt(String(v), 10);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
      };
      const clampMoney = (v: unknown) => {
        if (v === undefined || v === null || String(v).trim() === "") return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(1_000_000, Math.max(0, n)).toFixed(2) : undefined;
      };
      const dayFields: [string, number, number][] = [
        ["agr_termination_notice_days", 0, 365],
        ["agr_rate_notice_days", 0, 365],
        ["agr_damage_report_days", 1, 90],
        ["agr_nonsolicit_months", 0, 60],
      ];
      for (const [f, lo, hi] of dayFields) {
        const cv = clampInt(req.body[f], lo, hi);
        if (cv !== undefined) patch[f] = cv;
      }
      for (const f of ["agr_damage_cap", "agr_nonsolicit_fee"]) {
        const cv = clampMoney(req.body[f]);
        if (cv !== undefined) patch[f] = cv;
      }
      for (const f of fields) {
        const cv = cleanText(req.body[f]);
        if (cv !== undefined) patch[f] = cv;
      }
    }
    // [office-email-settings] Zone + available-techs toggles for office booking email.
    const { office_email_show_zone, office_email_show_available_techs } = req.body;
    if (office_email_show_zone !== undefined) patch.office_email_show_zone = !!office_email_show_zone;
    if (office_email_show_available_techs !== undefined) patch.office_email_show_available_techs = !!office_email_show_available_techs;

    const { online_booking_lead_hours } = req.body;
    if (online_booking_lead_hours !== undefined) patch.online_booking_lead_hours = online_booking_lead_hours;
    const { dispatch_start_hour, dispatch_end_hour } = req.body;
    if (dispatch_start_hour !== undefined) patch.dispatch_start_hour = Number(dispatch_start_hour);
    if (dispatch_end_hour !== undefined) patch.dispatch_end_hour = Number(dispatch_end_hour);
    const { arrival_alert_window_minutes } = req.body;
    if (arrival_alert_window_minutes !== undefined) patch.arrival_alert_window_minutes = Number(arrival_alert_window_minutes);
    const { res_tech_pay_pct, deep_clean_pay_pct, move_in_out_pay_pct, commercial_hourly_rate, commercial_comp_mode } = req.body;
    if (res_tech_pay_pct !== undefined) patch.res_tech_pay_pct = String(res_tech_pay_pct);
    if (deep_clean_pay_pct !== undefined) patch.deep_clean_pay_pct = String(deep_clean_pay_pct);
    if (move_in_out_pay_pct !== undefined) patch.move_in_out_pay_pct = String(move_in_out_pay_pct);
    if (commercial_hourly_rate !== undefined) patch.commercial_hourly_rate = String(commercial_hourly_rate);
    if (commercial_comp_mode !== undefined) patch.commercial_comp_mode = commercial_comp_mode;
    const { addon_time_method, addon_minimum_minutes, addon_pct_of_base } = req.body;
    if (addon_time_method !== undefined) patch.addon_time_method = addon_time_method;
    if (addon_minimum_minutes !== undefined) patch.addon_minimum_minutes = Number(addon_minimum_minutes);
    if (addon_pct_of_base !== undefined) patch.addon_pct_of_base = String(addon_pct_of_base);
    const { review_link } = req.body;
    if (review_link !== undefined) patch.review_link = review_link || null;
    const { overhead_rate_pct, payment_terms_days } = req.body;
    if (overhead_rate_pct !== undefined) patch.overhead_rate_pct = String(parseFloat(String(overhead_rate_pct)));
    if (payment_terms_days !== undefined) patch.payment_terms_days = Number(payment_terms_days);

    // [arrival-window] Written via raw SQL (not the drizzle patch) so this new
    // column doesn't require a schema/type regen. Clamped 5–240 min.
    const { arrival_window_minutes } = req.body;
    if (arrival_window_minutes !== undefined) {
      const n = Math.max(5, Math.min(240, Number(arrival_window_minutes) || 45));
      await db.execute(sql`UPDATE companies SET arrival_window_minutes = ${n} WHERE id = ${req.auth!.companyId}`);
    }

    // [leave-pay-cascade 2026-07-11] Flat $/hr rate for paid leave (PLAWA/PTO).
    // Raw SQL for the same reason as arrival_window_minutes (not in the Drizzle
    // model). Clamped to a sane 0–200 range; invalid input falls back to $20.
    const { leave_pay_rate } = req.body;
    if (leave_pay_rate !== undefined) {
      const raw = Number(leave_pay_rate);
      const n = Number.isFinite(raw) && raw > 0 ? Math.min(200, Math.round(raw * 100) / 100) : 20;
      await db.execute(sql`UPDATE companies SET leave_pay_rate = ${n} WHERE id = ${req.auth!.companyId}`);
    }

    if (Object.keys(patch).length === 0) return res.json({ success: true });

    const [updated] = await db
      .update(companiesTable)
      .set(patch as any)
      .where(eq(companiesTable.id, req.auth!.companyId))
      .returning();

    return res.json({ data: updated });
  } catch (err) {
    console.error("PATCH company error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/logo", requireAuth, (req, res) => {
  if (!req.auth!.companyId) {
    return res.status(403).json({ error: "Forbidden", message: "No company for this user" });
  }

  upload.single("file")(req, res, async (err) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large. Maximum 2MB allowed." });
    }
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    const logoUrl = `/api/uploads/logos/${req.file.filename}`;
    try {
      await db
        .update(companiesTable)
        .set({ logo_url: logoUrl })
        .where(eq(companiesTable.id, req.auth!.companyId!));
      return res.json({ logo_url: logoUrl });
    } catch (dbErr) {
      console.error("Logo DB update error:", dbErr);
      return res.status(500).json({ error: "Failed to update company logo" });
    }
  });
});

// ── GET /api/companies/booking-settings ──────────────────────────────────────
router.get("/booking-settings", requireAuth, async (req, res) => {
  try {
    const { sql: drSql } = await import("drizzle-orm");
    const companyId = req.auth!.companyId;
    const result = await db.execute(drSql`SELECT * FROM booking_settings WHERE company_id = ${companyId} LIMIT 1`);
    if (!result.rows.length) {
      return res.json({
        booking_lead_days: 7,
        max_advance_days: 60,
        available_sun: false,
        available_mon: true,
        available_tue: true,
        available_wed: true,
        available_thu: true,
        available_fri: true,
        available_sat: false,
      });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("GET booking-settings:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── PUT /api/companies/booking-settings ──────────────────────────────────────
router.put("/booking-settings", requireAuth, async (req, res) => {
  try {
    const { sql: drSql } = await import("drizzle-orm");
    const companyId = req.auth!.companyId;
    const {
      booking_lead_days,
      max_advance_days,
      available_sun,
      available_mon,
      available_tue,
      available_wed,
      available_thu,
      available_fri,
      available_sat,
    } = req.body;

    await db.execute(drSql`
      INSERT INTO booking_settings
        (company_id, booking_lead_days, max_advance_days,
         available_sun, available_mon, available_tue, available_wed,
         available_thu, available_fri, available_sat, updated_at)
      VALUES
        (${companyId},
         ${booking_lead_days ?? 7},
         ${max_advance_days ?? 60},
         ${available_sun ?? false},
         ${available_mon ?? true},
         ${available_tue ?? true},
         ${available_wed ?? true},
         ${available_thu ?? true},
         ${available_fri ?? true},
         ${available_sat ?? false},
         NOW())
      ON CONFLICT (company_id) DO UPDATE SET
        booking_lead_days = EXCLUDED.booking_lead_days,
        max_advance_days  = EXCLUDED.max_advance_days,
        available_sun     = EXCLUDED.available_sun,
        available_mon     = EXCLUDED.available_mon,
        available_tue     = EXCLUDED.available_tue,
        available_wed     = EXCLUDED.available_wed,
        available_thu     = EXCLUDED.available_thu,
        available_fri     = EXCLUDED.available_fri,
        available_sat     = EXCLUDED.available_sat,
        updated_at        = NOW()
    `);

    const updated = await db.execute(drSql`SELECT * FROM booking_settings WHERE company_id = ${companyId} LIMIT 1`);
    return res.json(updated.rows[0]);
  } catch (err) {
    console.error("PUT booking-settings:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/companies/cancellation-policy ───────────────────────────────────
// Tenant-level cancellation policy: customer fee % defaults + tech-pay mode.
// Per-client overrides live on clients.cancel_fee_pct / .lockout_fee_pct.
router.get("/cancellation-policy", requireAuth, async (req, res) => {
  try {
    const { sql: drSql } = await import("drizzle-orm");
    const companyId = req.auth!.companyId;
    const r = await db.execute(drSql`
      SELECT default_cancel_fee_pct, default_lockout_fee_pct,
             default_cancel_fee_flat, default_lockout_fee_flat,
             cancellation_tech_pay_mode, cancellation_tech_pay_amount
        FROM companies
       WHERE id = ${companyId}
       LIMIT 1
    `);
    const row = r.rows[0] as any;
    if (!row) return res.status(404).json({ error: "Company not found" });
    return res.json({
      default_cancel_fee_pct: parseFloat(String(row.default_cancel_fee_pct ?? 100)),
      default_lockout_fee_pct: parseFloat(String(row.default_lockout_fee_pct ?? 100)),
      default_cancel_fee_flat: parseFloat(String(row.default_cancel_fee_flat ?? 0)),
      default_lockout_fee_flat: parseFloat(String(row.default_lockout_fee_flat ?? 0)),
      cancellation_tech_pay_mode: row.cancellation_tech_pay_mode ?? "flat",
      cancellation_tech_pay_amount: parseFloat(String(row.cancellation_tech_pay_amount ?? 60)),
    });
  } catch (err) {
    console.error("GET cancellation-policy:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── PUT /api/companies/cancellation-policy ───────────────────────────────────
router.put("/cancellation-policy", requireAuth, async (req, res) => {
  try {
    const { sql: drSql } = await import("drizzle-orm");
    const companyId = req.auth!.companyId;
    const {
      default_cancel_fee_pct,
      default_lockout_fee_pct,
      default_cancel_fee_flat,
      default_lockout_fee_flat,
      cancellation_tech_pay_mode,
      cancellation_tech_pay_amount,
    } = req.body ?? {};

    // Validate ranges. Pct fields are 0-100, mode is enum, amount must be
    // non-negative. Clamp rather than reject so the UI can't get stuck.
    const cancelPct = clampPct(default_cancel_fee_pct, 100);
    const lockoutPct = clampPct(default_lockout_fee_pct, 100);
    // [cancel-fee-flat 2026-06-17] Flat $ fees (>= 0). When > 0 they override
    // the percentage at charge time (resolveCancellationPolicy).
    const nonNeg = (v: any) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
    const cancelFlat = nonNeg(default_cancel_fee_flat);
    const lockoutFlat = nonNeg(default_lockout_fee_flat);
    const mode = cancellation_tech_pay_mode === "percent" ? "percent" : "flat";
    const amount = Number.isFinite(Number(cancellation_tech_pay_amount))
      ? Math.max(0, Number(cancellation_tech_pay_amount))
      : 60;

    await db.execute(drSql`
      UPDATE companies
         SET default_cancel_fee_pct = ${cancelPct.toFixed(2)},
             default_lockout_fee_pct = ${lockoutPct.toFixed(2)},
             default_cancel_fee_flat = ${cancelFlat.toFixed(2)},
             default_lockout_fee_flat = ${lockoutFlat.toFixed(2)},
             cancellation_tech_pay_mode = ${mode},
             cancellation_tech_pay_amount = ${amount.toFixed(4)}
       WHERE id = ${companyId}
    `);

    return res.json({
      default_cancel_fee_pct: cancelPct,
      default_lockout_fee_pct: lockoutPct,
      default_cancel_fee_flat: cancelFlat,
      default_lockout_fee_flat: lockoutFlat,
      cancellation_tech_pay_mode: mode,
      cancellation_tech_pay_amount: amount,
    });
  } catch (err) {
    console.error("PUT cancellation-policy:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

function clampPct(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

export default router;
