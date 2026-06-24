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
  backfillFromCutover,
  queueSync,
  refreshQBToken,
} from "../../services/quickbooks-sync.js";

const router = Router();

const QB_CLIENT_ID = process.env.QB_CLIENT_ID!;
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET!;
const JWT_SECRET = process.env.JWT_SECRET || "qleno-secret";

function getPublicBase(req: any): string {
  // Prefer the proxied / forwarded host (Railway sets x-forwarded-host),
  // then req.host, then the Replit fallback. The proto follows the same chain.
  const host =
    (req.headers["x-forwarded-host"] as string) ||
    (req.headers.host as string) ||
    process.env.REPLIT_DEV_DOMAIN ||
    "localhost";
  const proto =
    (req.headers["x-forwarded-proto"] as string) ||
    (process.env.NODE_ENV === "production" ? "https" : "http");
  return `${proto}://${host}`;
}

function getRedirectUri(req: any): string {
  // Prefer env-configured value for production
  if (process.env.QB_REDIRECT_URI) return process.env.QB_REDIRECT_URI;
  // The callback route is mounted at /api/integrations/quickbooks/callback
  // (the main router mounts at /api). The earlier `/qleno` prefix pointed at a
  // non-existent path, so the Intuit handshake's redirect_uri never matched a
  // real route. QB_REDIRECT_URI still overrides this for prod.
  return `${getPublicBase(req)}/api/integrations/quickbooks/callback`;
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
    // Return the URL as JSON instead of a 302. The frontend calls this endpoint
    // with the Bearer token attached (a fetch), then navigates the browser to
    // authUrl. A direct 302 here can't be reached: a top-level navigation to
    // /connect carries no Authorization header, so requireAuth would 401.
    return res.json({ authUrl });
  } catch (err) {
    console.error("[QB] Connect error:", err);
    return res.status(500).json({ error: "Failed to initiate QB connection" });
  }
});

// ── GET /api/integrations/quickbooks/callback ─────────────────────────────
router.get("/callback", async (req, res) => {
  // Derive the frontend base from the request (Railway-safe). The frontend is
  // served at the domain root (e.g. app.qleno.com), so redirect straight to
  // /company. The legacy `/qleno` base-path prefix is a Replit artifact — on
  // Railway it made every successful connect land on a 404 at /qleno/company.
  const baseFrontend = getPublicBase(req);

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

    // [qb-cutover] On connect, backfill any invoices/payments issued while QB was
    // disconnected (service date >= qb_sync_start_date) so nothing is stranded.
    // Fire-and-forget so the OAuth redirect isn't blocked on the QB round-trips.
    queueSync(() => backfillFromCutover(companyId).then(
      r => console.log(`[QB] cutover backfill: queued ${r.queued}, synced ${r.result.synced}, failed ${r.result.failed}`),
    ));

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
        qb_sync_start_date: companiesTable.qb_sync_start_date,
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
      sync_start_date: company.qb_sync_start_date,
      stats,
    });
  } catch (err) {
    console.error("[QB] Status error:", err);
    return res.status(500).json({ error: "Failed to get status" });
  }
});

// ── PATCH /api/integrations/quickbooks/cutover ────────────────────────────
// Configure the migration guardrails for a tenant moving onto QuickBooks from
// another system that already feeds the same QB company (e.g. Oak Lawn ←
// MaidCentral). `sync_start_date` makes Qleno push ONLY invoices created on/
// after that date, so it never re-pushes history the prior system already
// sent. `invoice_sequence_start` continues the prior system's invoice numbers
// instead of restarting at 1. Both are owner/admin-only.
router.patch("/cutover", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { sync_start_date, invoice_sequence_start } = req.body as {
      sync_start_date?: string | null;
      invoice_sequence_start?: number;
    };

    const updates: Record<string, any> = {};

    if (sync_start_date !== undefined) {
      if (sync_start_date === null || sync_start_date === "") {
        updates.qb_sync_start_date = null;
      } else {
        const d = new Date(sync_start_date);
        if (isNaN(d.getTime())) {
          return res.status(400).json({ error: "Invalid sync_start_date" });
        }
        updates.qb_sync_start_date = d;
      }
    }

    if (invoice_sequence_start !== undefined) {
      const n = Number(invoice_sequence_start);
      if (!Number.isInteger(n) || n < 1) {
        return res.status(400).json({ error: "invoice_sequence_start must be a positive integer" });
      }
      updates.invoice_sequence_start = n;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    await db.update(companiesTable).set(updates).where(eq(companiesTable.id, companyId));

    const [company] = await db
      .select({
        qb_sync_start_date: companiesTable.qb_sync_start_date,
        invoice_sequence_start: companiesTable.invoice_sequence_start,
      })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .limit(1);

    return res.json({
      ok: true,
      sync_start_date: company?.qb_sync_start_date ?? null,
      invoice_sequence_start: company?.invoice_sequence_start,
    });
  } catch (err) {
    console.error("[QB] Cutover config error:", err);
    return res.status(500).json({ error: "Failed to update cutover config" });
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

// ── POST /api/integrations/quickbooks/backfill ────────────────────────────
// [qb-cutover] Manually re-run the post-connect backfill (idempotent). Pushes
// every issued, not-yet-synced invoice with service date >= qb_sync_start_date.
router.post("/backfill", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const out = await backfillFromCutover(companyId);
    return res.json({ ok: true, ...out });
  } catch (err) {
    console.error("[QB] Backfill error:", err);
    return res.status(500).json({ error: "Backfill failed" });
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
