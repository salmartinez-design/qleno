import { Router } from "express";
import { db } from "@workspace/db";
import {
  companiesTable, clientsTable, jobsTable, usersTable,
  clientRatingsTable, additionalPayTable
} from "@workspace/db/schema";
import { eq, and, desc, gte, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { signToken, verifyToken } from "../lib/auth.js";
import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

const router = Router();

declare global {
  namespace Express {
    interface Request {
      portal?: { clientId: number; companyId: number };
    }
  }
}

function requirePortalAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  try {
    const payload = verifyToken(authHeader.substring(7)) as any;
    if (payload.role !== "portal_client") {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    req.portal = { clientId: payload.userId, companyId: payload.companyId };
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

router.get("/company/:slug", async (req, res) => {
  try {
    const company = await db
      .select({ id: companiesTable.id, name: companiesTable.name, slug: companiesTable.slug, logo_url: companiesTable.logo_url, brand_color: companiesTable.brand_color })
      .from(companiesTable)
      .where(eq(companiesTable.slug, req.params.slug))
      .limit(1);
    if (!company[0]) return res.status(404).json({ error: "Company not found" });
    return res.json(company[0]);
  } catch (err) { return res.status(500).json({ error: "Internal Server Error" }); }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password, company_slug } = req.body;
    if (!email || !password || !company_slug) {
      return res.status(400).json({ error: "Email, password, and company_slug required" });
    }

    const company = await db
      .select({ id: companiesTable.id })
      .from(companiesTable)
      .where(eq(companiesTable.slug, company_slug))
      .limit(1);
    if (!company[0]) return res.status(404).json({ error: "Company not found" });

    const client = await db
      .select()
      .from(clientsTable)
      .where(and(
        eq(clientsTable.email, email.toLowerCase()),
        eq(clientsTable.company_id, company[0].id),
      ))
      .limit(1);

    if (!client[0]) return res.status(401).json({ error: "Invalid credentials" });
    if (!client[0].portal_access || !client[0].portal_password_hash) {
      return res.status(403).json({ error: "Portal access not enabled for this account" });
    }

    const valid = await bcrypt.compare(password, client[0].portal_password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    await db.update(clientsTable).set({ portal_last_login: new Date() }).where(eq(clientsTable.id, client[0].id));

    const token = signToken({ userId: client[0].id, companyId: company[0].id, role: "portal_client", email: client[0].email || '' });
    return res.json({ token, client: { id: client[0].id, first_name: client[0].first_name, last_name: client[0].last_name, email: client[0].email } });
  } catch (err) {
    console.error("Portal login error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/me", requirePortalAuth, async (req, res) => {
  try {
    const client = await db
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, req.portal!.clientId))
      .limit(1);
    if (!client[0]) return res.status(404).json({ error: "Not found" });
    const { portal_password_hash: _, ...safe } = client[0];
    return res.json(safe);
  } catch { return res.status(500).json({ error: "Internal Server Error" }); }
});

router.get("/jobs", requirePortalAuth, async (req, res) => {
  try {
    const jobs = await db
      .select({
        id: jobsTable.id,
        service_type: jobsTable.service_type,
        status: jobsTable.status,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        base_fee: jobsTable.base_fee,
        cleaner_first: usersTable.first_name,
        cleaner_last: usersTable.last_name,
        cleaner_avatar: usersTable.avatar_url,
      })
      .from(jobsTable)
      .leftJoin(usersTable, eq(jobsTable.assigned_user_id, usersTable.id))
      .where(and(
        eq(jobsTable.client_id, req.portal!.clientId),
        eq(jobsTable.company_id, req.portal!.companyId),
      ))
      .orderBy(desc(jobsTable.scheduled_date))
      .limit(20);

    const today = new Date().toISOString().slice(0, 10);
    const upcoming = jobs.filter(j => j.scheduled_date >= today && j.status !== 'cancelled');
    const past = jobs.filter(j => j.scheduled_date < today || j.status === 'complete');

    return res.json({ upcoming, past });
  } catch { return res.status(500).json({ error: "Internal Server Error" }); }
});

router.post("/rate", requirePortalAuth, async (req, res) => {
  try {
    const { job_id, score, comment } = req.body;
    if (!job_id || !score) return res.status(400).json({ error: "job_id and score required" });

    const existing = await db
      .select({ id: clientRatingsTable.id })
      .from(clientRatingsTable)
      .where(and(eq(clientRatingsTable.job_id, job_id), eq(clientRatingsTable.client_id, req.portal!.clientId)))
      .limit(1);

    if (existing[0]) {
      await db.update(clientRatingsTable)
        .set({ score, comment })
        .where(eq(clientRatingsTable.id, existing[0].id));
    } else {
      await db.insert(clientRatingsTable).values({
        company_id: req.portal!.companyId,
        client_id: req.portal!.clientId,
        job_id,
        score,
        comment,
      });
    }
    return res.json({ success: true });
  } catch { return res.status(500).json({ error: "Internal Server Error" }); }
});

router.post("/tip", requirePortalAuth, async (req, res) => {
  try {
    const { job_id, amount } = req.body;
    if (!job_id || !amount) return res.status(400).json({ error: "job_id and amount required" });

    const job = await db
      .select({ assigned_user_id: jobsTable.assigned_user_id, company_id: jobsTable.company_id })
      .from(jobsTable)
      .where(and(eq(jobsTable.id, job_id), eq(jobsTable.client_id, req.portal!.clientId)))
      .limit(1);

    if (!job[0] || !job[0].assigned_user_id) {
      return res.status(404).json({ error: "Job not found or no cleaner assigned" });
    }

    await db.insert(additionalPayTable).values({
      company_id: job[0].company_id,
      user_id: job[0].assigned_user_id,
      amount: String(amount),
      type: "tips",
      notes: `Client tip via portal for job #${job_id}`,
      job_id,
    });

    return res.json({ success: true, message: `Tip of $${amount} recorded` });
  } catch { return res.status(500).json({ error: "Internal Server Error" }); }
});

// ── POST /api/portal/profile-picture ────────────────────────────────────────
router.post("/profile-picture", requirePortalAuth, async (req, res) => {
  try {
    const { image_data } = req.body; // base64 data URL e.g. "data:image/jpeg;base64,..."
    if (!image_data || typeof image_data !== "string") {
      return res.status(400).json({ error: "image_data is required" });
    }
    // Basic validation: must be a data URL
    if (!image_data.startsWith("data:image/")) {
      return res.status(400).json({ error: "Invalid image format" });
    }
    // Limit to ~2MB base64 (~1.5MB actual image)
    if (image_data.length > 2_800_000) {
      return res.status(413).json({ error: "Image too large. Please use an image under 1.5MB." });
    }
    await db
      .update(clientsTable)
      .set({ profile_picture_url: image_data } as any)
      .where(and(
        eq(clientsTable.id, req.portal!.clientId),
        eq(clientsTable.company_id, req.portal!.companyId),
      ));
    return res.json({ success: true });
  } catch { return res.status(500).json({ error: "Internal Server Error" }); }
});

router.post("/invite-client", async (req, res) => {
  try {
    const { client_id, company_id, temp_password } = req.body;
    if (!client_id || !company_id || !temp_password) {
      return res.status(400).json({ error: "client_id, company_id, and temp_password required" });
    }

    const password_hash = await bcrypt.hash(temp_password, 10);
    const token = crypto.randomBytes(32).toString("hex");

    await db.update(clientsTable)
      .set({
        portal_password_hash: password_hash,
        portal_access: true,
        portal_invite_token: token,
        portal_invite_sent_at: new Date(),
      })
      .where(and(eq(clientsTable.id, client_id), eq(clientsTable.company_id, company_id)));

    return res.json({ success: true, portal_invite_token: token });
  } catch { return res.status(500).json({ error: "Internal Server Error" }); }
});

export default router;
