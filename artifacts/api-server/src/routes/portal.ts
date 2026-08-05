import { Router } from "express";
import { db } from "@workspace/db";
import {
  companiesTable, clientsTable, jobsTable, usersTable,
  clientRatingsTable, additionalPayTable
} from "@workspace/db/schema";
import { eq, and, desc, gte, sql } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import { requirePortalAuth, requireCapability } from "../lib/portal-auth.js";

const router = Router();

// [customer-portal 2026-08-05] This file used to own its own login and its own
// session guard. Both are gone:
//
//  - The LOGIN was dead code. It gated on `clients.portal_password_hash`, a
//    column absent from the Drizzle schema (it existed in ebda8989 / 2ac5a4c2
//    and was removed), so `db.select()` never returned it and every attempt hit
//    "Portal access not enabled". Nobody could ever sign in. Replaced by
//    POST /api/portal/auth/login (routes/portal-auth.ts).
//
//  - The local GUARD read `payload.userId` as a CLIENT id. Under the new
//    identity model that field is a portal_users id, so keeping it would have
//    silently scoped every route below to the wrong customer's rows. It now
//    uses the shared requirePortalAuth, which re-reads portal_users on each
//    request and hands back the attachment.
//
// Also removed: an UNAUTHENTICATED POST /invite-client that accepted client_id,
// company_id and a caller-chosen temp_password, then flipped portal_access on.
// It took the tenant from the request body, so it was cross-tenant by
// construction. Superseded by POST /api/portal/auth/invite, which is
// staff-gated and reads the email off the record rather than the body.
//
// The routes here are residential (client-scoped) by nature. Commercial
// customers reach their account through the /api/portal/account/* routes;
// requireResidential below is what keeps the two from crossing.

/**
 * These routes address a single residential client. A commercial portal user
 * has no client_id, so rather than letting `clientId` fall through as null and
 * quietly matching nothing (or, worse, matching a row with a NULL client_id),
 * refuse the request outright.
 */
function requireResidential(req: Request, res: Response, next: NextFunction): void {
  const session = req.portalSession;
  if (!session?.clientId) {
    res.status(403).json({ error: "Forbidden", message: "Not available on a commercial account" });
    return;
  }
  next();
}

// Resolve the client + company this request may touch. Straight off the
// session, which came off the portal_users row — never off the request.
const scope = (req: Request) => ({
  clientId: req.portalSession!.clientId as number,
  companyId: req.portalSession!.companyId,
});

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

router.get("/me", requirePortalAuth, requireResidential, async (req, res) => {
  try {
    // Scoped to the session's own client AND company — a client id alone would
    // match across tenants.
    const client = await db
      .select()
      .from(clientsTable)
      .where(and(
        eq(clientsTable.id, scope(req).clientId),
        eq(clientsTable.company_id, scope(req).companyId),
      ))
      .limit(1);
    if (!client[0]) return res.status(404).json({ error: "Not found" });
    // This used to strip `portal_password_hash` before replying. That column is
    // no longer on `clients` — credentials live on portal_users now and never
    // travel through this route — so there is nothing to strip.
    return res.json(client[0]);
  } catch { return res.status(500).json({ error: "Internal Server Error" }); }
});

router.get("/jobs", requirePortalAuth, requireResidential, async (req, res) => {
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
        eq(jobsTable.client_id, scope(req).clientId),
        eq(jobsTable.company_id, scope(req).companyId),
      ))
      .orderBy(desc(jobsTable.scheduled_date))
      .limit(20);

    const today = new Date().toISOString().slice(0, 10);
    const upcoming = jobs.filter(j => j.scheduled_date >= today && j.status !== 'cancelled');
    const past = jobs.filter(j => j.scheduled_date < today || j.status === 'complete');

    return res.json({ upcoming, past });
  } catch { return res.status(500).json({ error: "Internal Server Error" }); }
});

router.post("/rate", requirePortalAuth, requireResidential, requireCapability("rateClean"), async (req, res) => {
  try {
    const { job_id, score, comment } = req.body;
    if (!job_id || !score) return res.status(400).json({ error: "job_id and score required" });

    const existing = await db
      .select({ id: clientRatingsTable.id })
      .from(clientRatingsTable)
      .where(and(eq(clientRatingsTable.job_id, job_id), eq(clientRatingsTable.client_id, scope(req).clientId)))
      .limit(1);

    if (existing[0]) {
      await db.update(clientRatingsTable)
        .set({ score, comment })
        .where(eq(clientRatingsTable.id, existing[0].id));
    } else {
      await db.insert(clientRatingsTable).values({
        company_id: scope(req).companyId,
        client_id: scope(req).clientId,
        job_id,
        score,
        comment,
      });
    }

    // [client-scoring → scorecard] A portal star rating (1–4) is a customer
    // rating of the job → flow it to the job's tech(s) Performance Score, same
    // as a tokenized survey response. Idempotent per (job, tech); a later
    // survey/portal rating of the same job replaces it. Non-fatal — the rating
    // is already saved above; the scorecard write is derived.
    try {
      const [job] = await db.select({ dt: jobsTable.scheduled_date })
        .from(jobsTable).where(eq(jobsTable.id, job_id)).limit(1);
      const entryDate = job?.dt ? String(job.dt).slice(0, 10) : new Date().toISOString().slice(0, 10);
      const { captureJobScore } = await import("../lib/scorecard-engine.js");
      await captureJobScore({
        companyId: scope(req).companyId, jobId: job_id,
        score: Math.max(0, Math.min(4, Math.round(Number(score)))),
        entryDate, notes: comment || null,
      });
    } catch (e: any) {
      console.error("[portal/rate] scorecard capture failed (non-fatal):", e?.message ?? e);
    }

    return res.json({ success: true });
  } catch { return res.status(500).json({ error: "Internal Server Error" }); }
});

router.post("/tip", requirePortalAuth, requireResidential, requireCapability("payInvoice"), async (req, res) => {
  try {
    const { job_id, amount } = req.body;
    if (!job_id || !amount) return res.status(400).json({ error: "job_id and amount required" });

    const job = await db
      .select({ assigned_user_id: jobsTable.assigned_user_id, company_id: jobsTable.company_id })
      .from(jobsTable)
      .where(and(eq(jobsTable.id, job_id), eq(jobsTable.client_id, scope(req).clientId)))
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
router.post("/profile-picture", requirePortalAuth, requireResidential, async (req, res) => {
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
        eq(clientsTable.id, scope(req).clientId),
        eq(clientsTable.company_id, scope(req).companyId),
      ));
    return res.json({ success: true });
  } catch { return res.status(500).json({ error: "Internal Server Error" }); }
});

export default router;
