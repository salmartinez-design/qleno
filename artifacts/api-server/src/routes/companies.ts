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
