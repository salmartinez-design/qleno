import { Router } from "express";
import { db } from "@workspace/db";
import { companiesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import multer from "multer";
import path from "path";
import { mkdirSync } from "fs";
import { requireAuth } from "../lib/auth.js";

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
    const company = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, req.auth!.companyId))
      .limit(1);

    if (!company[0]) {
      return res.status(404).json({ error: "Not Found", message: "Company not found" });
    }

    return res.json(company[0]);
  } catch (err) {
    console.error("Get company error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get company" });
  }
});

router.put("/me", requireAuth, async (req, res) => {
  try {
    if (!req.auth!.companyId) {
      return res.status(403).json({ error: "Forbidden", message: "No company to update" });
    }
    const { name, logo_url, pay_cadence, geo_fence_threshold_ft, brand_color } = req.body;

    const updated = await db
      .update(companiesTable)
      .set({
        ...(name && { name }),
        ...(logo_url !== undefined && { logo_url }),
        ...(pay_cadence && { pay_cadence }),
        ...(geo_fence_threshold_ft !== undefined && { geo_fence_threshold_ft }),
        ...(brand_color && { brand_color }),
      })
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
      geofence_override_allowed, geofence_soft_mode,
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
    if (geofence_enabled !== undefined) patch.geofence_enabled = geofence_enabled;
    if (geofence_clockin_radius_ft !== undefined) patch.geofence_clockin_radius_ft = geofence_clockin_radius_ft;
    if (geofence_clockout_radius_ft !== undefined) patch.geofence_clockout_radius_ft = geofence_clockout_radius_ft;
    if (geofence_override_allowed !== undefined) patch.geofence_override_allowed = geofence_override_allowed;
    if (geofence_soft_mode !== undefined) patch.geofence_soft_mode = geofence_soft_mode;
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

export default router;
