import { Router } from "express";
import jwt from "jsonwebtoken";
import { db } from "@workspace/db";
import { companiesTable, qbSyncQueueTable } from "@workspace/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../../lib/auth.js";
import {
  encrypt,
  decrypt,
  getQbBaseUrl,
  QB_ACCOUNTING_SCOPE,
  syncAll,
  refreshQBToken,
} from "../../services/quickbooks-sync.js";

const router = Router();

const QB_CLIENT_ID = process.env.QB_CLIENT_ID!;
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET!;
const JWT_SECRET = process.env.JWT_SECRET || "qleno-secret";

function getRedirectUri(req: any): string {
  // Prefer env-configured value for production
  if (process.env.QB_REDIRECT_URI) return process.env.QB_REDIRECT_URI;

  // Construct from Replit domain
  const domain = process.env.REPLIT_DEV_DOMAIN || req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const proto = process.env.NODE_ENV === "production" ? "https" : "https";
  return `${proto}://${domain}/qleno/api/integrations/quickbooks/callback`;
}

// ── GET /api/integrations/quickbooks/connect ───────────────────────────────
router.get("/connect", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const state = jwt.sign({ companyId }, JWT_SECRET, { expiresIn: "10m" });
    const redirectUri = getRedirectUri(req);

    const params = new URLSearchParams({
      client_id: QB_CLIENT_ID,
      scope: QB_ACCOUNTING_SCOPE,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
    });

    const authUrl = `https://appcenter.intuit.com/connect/oauth2?${params.toString()}`;
    return res.redirect(authUrl);
  } catch (err) {
    console.error("[QB] Connect error:", err);
    return res.status(500).json({ error: "Failed to initiate QB connection" });
  }
});

// ── GET /api/integrations/quickbooks/callback ─────────────────────────────
router.get("/callback", async (req, res) => {
  const baseFrontend = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}/qleno`
    : "";

  try {
    const { code, state, realmId } = req.query as Record<string, string>;

    if (!code || !state || !realmId) {
      return res.redirect(`${baseFrontend}/company?tab=integrations&qb=error`);
    }

    // Verify state JWT
    let payload: any;
    try {
      payload = jwt.verify(state, JWT_SECRET);
    } catch {
      return res.redirect(`${baseFrontend}/company?tab=integrations&qb=error`);
    }

    const companyId: number = payload.companyId;
    const redirectUri = getRedirectUri(req);

    // Exchange code for tokens
    const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString("base64");
    const tokenResp = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${creds}`,
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    });

    if (!tokenResp.ok) {
      console.error("[QB] Token exchange failed:", await tokenResp.text());
      return res.redirect(`${baseFrontend}/company?tab=integrations&qb=error`);
    }

    const tokenData = await tokenResp.json();
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

    // Fetch QB company info
    const baseUrl = getQbBaseUrl();
    let qbCompanyName = "";
    try {
      const companyResp = await fetch(
        `${baseUrl}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=65`,
        {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            Accept: "application/json",
          },
        }
      );
      if (companyResp.ok) {
        const companyInfo = await companyResp.json();
        qbCompanyName = companyInfo?.CompanyInfo?.CompanyName || "";
      }
    } catch { /* non-fatal */ }

    // Store tokens encrypted
    await db
      .update(companiesTable)
      .set({
        qb_access_token: encrypt(tokenData.access_token),
        qb_refresh_token: encrypt(tokenData.refresh_token),
        qb_realm_id: realmId,
        qb_token_expires_at: expiresAt,
        qb_connected: true,
        qb_company_name: qbCompanyName,
        qb_last_sync_at: new Date(),
      })
      .where(eq(companiesTable.id, companyId));

    return res.redirect(`${baseFrontend}/company?tab=integrations&qb=connected`);
  } catch (err) {
    console.error("[QB] Callback error:", err);
    return res.redirect(`${baseFrontend}/company?tab=integrations&qb=error`);
  }
});

// ── POST /api/integrations/quickbooks/disconnect ──────────────────────────
router.post("/disconnect", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;

    const [company] = await db
      .select({ qb_access_token: companiesTable.qb_access_token, qb_refresh_token: companiesTable.qb_refresh_token })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .limit(1);

    // Revoke token with Intuit
    if (company?.qb_refresh_token) {
      const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString("base64");
      await fetch("https://developer.api.intuit.com/v2/oauth2/tokens/revoke", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${creds}`,
        },
        body: new URLSearchParams({ token: decrypt(company.qb_refresh_token) }),
      }).catch(() => {}); // non-fatal
    }

    await db
      .update(companiesTable)
      .set({
        qb_access_token: null,
        qb_refresh_token: null,
        qb_realm_id: null,
        qb_token_expires_at: null,
        qb_connected: false,
        qb_company_name: null,
      })
      .where(eq(companiesTable.id, companyId));

    return res.json({ ok: true });
  } catch (err) {
    console.error("[QB] Disconnect error:", err);
    return res.status(500).json({ error: "Failed to disconnect" });
  }
});

// ── GET /api/integrations/quickbooks/status ───────────────────────────────
router.get("/status", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;

    const [company] = await db
      .select({
        qb_connected: companiesTable.qb_connected,
        qb_realm_id: companiesTable.qb_realm_id,
        qb_company_name: companiesTable.qb_company_name,
        qb_last_sync_at: companiesTable.qb_last_sync_at,
        invoice_sequence_start: companiesTable.invoice_sequence_start,
      })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .limit(1);

    if (!company) return res.status(404).json({ error: "Company not found" });

    // Sync stats
    const allQueue = await db
      .select({
        status: qbSyncQueueTable.status,
        entity_type: qbSyncQueueTable.entity_type,
      })
      .from(qbSyncQueueTable)
      .where(eq(qbSyncQueueTable.company_id, companyId));

    const stats = {
      customers_synced: allQueue.filter(q => q.entity_type === "customer" && q.status === "synced").length,
      invoices_synced: allQueue.filter(q => q.entity_type === "invoice" && q.status === "synced").length,
      payments_synced: allQueue.filter(q => q.entity_type === "payment" && q.status === "synced").length,
      pending: allQueue.filter(q => q.status === "pending").length,
      failed: allQueue.filter(q => q.status === "failed").length,
    };

    return res.json({
      connected: company.qb_connected,
      company_name: company.qb_company_name,
      last_sync_at: company.qb_last_sync_at,
      realm_id: company.qb_realm_id,
      invoice_sequence_start: company.invoice_sequence_start,
      stats,
    });
  } catch (err) {
    console.error("[QB] Status error:", err);
    return res.status(500).json({ error: "Failed to get status" });
  }
});

// ── POST /api/integrations/quickbooks/sync ────────────────────────────────
router.post("/sync", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const result = await syncAll(companyId);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[QB] Manual sync error:", err);
    return res.status(500).json({ error: "Sync failed" });
  }
});

// ── GET /api/integrations/quickbooks/log ──────────────────────────────────
router.get("/log", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const logs = await db
      .select()
      .from(qbSyncQueueTable)
      .where(eq(qbSyncQueueTable.company_id, companyId))
      .orderBy(desc(qbSyncQueueTable.updated_at))
      .limit(50);

    return res.json(logs);
  } catch (err) {
    console.error("[QB] Log error:", err);
    return res.status(500).json({ error: "Failed to fetch log" });
  }
});

export default router;
