import { Router } from "express";
import { db } from "@workspace/db";
import { apiRequestLogTable, companiesTable } from "@workspace/db/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import {
  mintApiKey, revokeApiKey, rotateApiKey, listApiKeys,
  canMintApiKeys, isValidScope, maskedToken,
  ALL_SCOPES, READ_SCOPES, WRITE_SCOPES, DEFAULT_SCOPES, HIGH_RISK_SCOPES,
  type ApiScope,
} from "../lib/api-keys.js";

// [ai-access 2026-08-15] Management for the tenant's own API keys — the data
// behind Settings → AI & API Access. These are ordinary internal endpoints
// authenticated by a login session; an API key can NOT reach them (requireAuth
// rejects qlno_ tokens), which is deliberate: a credential must never be able
// to mint another credential or widen its own scopes.
const router = Router();

router.use(requireAuth);

// Owner/admin only (decision 2026-08-15) — NOT requireRole("admin"), because
// that helper grants 'office' parity everywhere it appears, and minting machine
// credentials is exactly the capability we don't want to hand the whole office.
// Enforced here as well as inside mintApiKey so neither layer is load-bearing
// alone.
function gateMinters(req: any, res: any, next: any) {
  if (!canMintApiKeys(req.auth?.role)) {
    res.status(403).json({ error: "Forbidden", message: "Only an owner or admin can manage API keys" });
    return;
  }
  next();
}

/** Scope catalog for the Settings UI, so the list lives in one place (the lib). */
router.get("/scopes", (_req, res) => {
  res.json({
    read: READ_SCOPES,
    write: WRITE_SCOPES,
    defaults: DEFAULT_SCOPES,
    high_risk: HIGH_RISK_SCOPES,
  });
});

/**
 * Is this tenant switched on, and how much have they used?
 *
 * Usage is COUNTED but never billed or throttled on volume (decision
 * 2026-08-15) — the point is that the number exists from day one, because a
 * counter added later can't reconstruct history it never recorded.
 */
router.get("/status", async (req, res) => {
  const companyId = req.auth!.companyId;
  if (!companyId) { res.status(400).json({ error: "No company context" }); return; }

  const [co] = await db
    .select({ plan: companiesTable.plan, enabled: companiesTable.api_access_enabled })
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId))
    .limit(1);

  // Calendar month to date. Deliberately a live COUNT over api_request_log
  // rather than a maintained counter column: at this volume the index on
  // (company_id, created_at) makes it cheap, and a derived number can't drift
  // out of step with the log the way an incremented column would.
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [usage] = await db
    .select({
      requests: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) FILTER (WHERE ${apiRequestLogTable.status} >= 400)::int`,
    })
    .from(apiRequestLogTable)
    .where(and(
      eq(apiRequestLogTable.company_id, companyId),
      gte(apiRequestLogTable.created_at, monthStart),
    ));

  res.json({
    enabled: !!co?.enabled,
    plan: co?.plan ?? null,
    // Pro is the 'enterprise' plan value. Surfaced so the UI can explain WHY
    // access is off rather than just showing a dead switch.
    plan_qualifies: co?.plan === "enterprise",
    can_manage: canMintApiKeys(req.auth!.role),
    usage_this_month: { requests: usage?.requests ?? 0, errors: usage?.errors ?? 0, since: monthStart.toISOString() },
  });
});

/**
 * The company-wide on/off switch.
 *
 * Deliberately asymmetric: turning access ON requires the qualifying plan,
 * turning it OFF never does. This is the switch an owner reaches for when a
 * laptop goes missing and they cannot remember which key was on it — gating
 * that behind a plan check, a support ticket, or anything else that takes
 * minutes would make the one control that has to work in an emergency the one
 * that doesn't. Every key stops on its next request; nothing is deleted, so
 * flipping it back on restores exactly what was there.
 */
router.put("/access", gateMinters, async (req, res) => {
  const companyId = req.auth!.companyId;
  if (!companyId) { res.status(400).json({ error: "No company context" }); return; }
  if (typeof req.body?.enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be true or false" });
    return;
  }
  const enabled: boolean = req.body.enabled;

  const [co] = await db
    .select({ plan: companiesTable.plan, enabled: companiesTable.api_access_enabled })
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId))
    .limit(1);
  if (!co) { res.status(404).json({ error: "Company not found" }); return; }

  if (enabled && co.plan !== "enterprise") {
    res.status(403).json({
      error: "plan_required",
      message: "AI and API access is a Pro plan feature. Turning it off is always available.",
    });
    return;
  }

  await db
    .update(companiesTable)
    .set({ api_access_enabled: enabled })
    .where(eq(companiesTable.id, companyId));

  await logAudit(req, enabled ? "api_access_enabled" : "api_access_disabled", "company", companyId,
    { api_access_enabled: !!co.enabled }, { api_access_enabled: enabled });

  res.json({ enabled });
});

router.get("/", gateMinters, async (req, res) => {
  const companyId = req.auth!.companyId;
  if (!companyId) { res.status(400).json({ error: "No company context" }); return; }
  const keys = await listApiKeys(companyId);
  res.json(keys.map((k) => ({ ...k, masked: maskedToken(k.key_id) })));
});

/**
 * Mint a key. The full token is in this response and nowhere else, ever — it is
 * hashed at rest and cannot be recovered, only rotated.
 */
router.post("/", gateMinters, async (req, res) => {
  const companyId = req.auth!.companyId;
  if (!companyId) { res.status(400).json({ error: "No company context" }); return; }

  const name = String(req.body?.name ?? "").trim();
  if (!name) { res.status(400).json({ error: "A name is required" }); return; }

  const requested: string[] = Array.isArray(req.body?.scopes) ? req.body.scopes.map(String) : [];
  const unknown = requested.filter((s) => !isValidScope(s));
  if (unknown.length > 0) {
    res.status(400).json({ error: `Unknown scope(s): ${unknown.join(", ")}`, valid: ALL_SCOPES });
    return;
  }
  const scopes = (requested.length > 0 ? requested : DEFAULT_SCOPES) as ApiScope[];

  // comms:send and payments:charge send real messages and move real money. The
  // UI asks a second time; the server requires proof that it did, so the
  // confirmation can't be skipped by calling this endpoint directly.
  const highRisk = scopes.filter((s) => HIGH_RISK_SCOPES.includes(s));
  if (highRisk.length > 0 && req.body?.confirm_high_risk !== true) {
    res.status(400).json({
      error: "confirmation_required",
      message: `The ${highRisk.join(" and ")} scope lets an assistant contact customers or charge cards. Re-submit with confirm_high_risk: true.`,
      scopes: highRisk,
    });
    return;
  }

  // The key acts as the minting user unless another user in the company is
  // named. mintApiKey re-verifies that user's company and role, so a crafted
  // user_id can't point a key at another tenant or at a technician.
  const ownerId = Number(req.body?.user_id ?? req.auth!.userId);

  try {
    const minted = await mintApiKey({
      companyId,
      userId: ownerId,
      createdBy: req.auth!.userId,
      name,
      scopes,
      expiresAt: req.body?.expires_at ? new Date(req.body.expires_at) : null,
    });

    // Audit records the key id and scopes — never the token.
    await logAudit(req, "api_key_created", "api_key", minted.id, null, {
      name: minted.name, key_id: minted.key_id, scopes: minted.scopes, owner_user_id: ownerId,
    });

    res.status(201).json({
      id: minted.id,
      key_id: minted.key_id,
      name: minted.name,
      scopes: minted.scopes,
      expires_at: minted.expires_at,
      token: minted.token,
      warning: "Copy this key now. It is stored hashed and cannot be shown again.",
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Could not create key" });
  }
});

/** Rotate: a new token now, the old one valid for 24h so nothing breaks mid-swap. */
router.post("/:id/rotate", gateMinters, async (req, res) => {
  const companyId = req.auth!.companyId;
  const id = Number(req.params.id);
  if (!companyId || !Number.isFinite(id)) { res.status(400).json({ error: "Bad request" }); return; }

  const minted = await rotateApiKey(companyId, id, req.auth!.userId);
  if (!minted) { res.status(404).json({ error: "Key not found or already revoked" }); return; }

  await logAudit(req, "api_key_rotated", "api_key", minted.id, { rotated_from: id }, {
    name: minted.name, key_id: minted.key_id, scopes: minted.scopes,
  });

  res.json({
    id: minted.id,
    key_id: minted.key_id,
    name: minted.name,
    scopes: minted.scopes,
    token: minted.token,
    warning: "Copy this key now. The previous key keeps working for 24 hours, then stops. Revoke it instead if it was leaked.",
  });
});

/** Revoke: immediate and irreversible. This is the leak response. */
router.delete("/:id", gateMinters, async (req, res) => {
  const companyId = req.auth!.companyId;
  const id = Number(req.params.id);
  if (!companyId || !Number.isFinite(id)) { res.status(400).json({ error: "Bad request" }); return; }

  const ok = await revokeApiKey(companyId, id, req.auth!.userId);
  if (!ok) { res.status(404).json({ error: "Key not found or already revoked" }); return; }

  await logAudit(req, "api_key_revoked", "api_key", id, null, { revoked_by: req.auth!.userId });
  res.json({ ok: true });
});

/** Recent calls for one key — the tenant's own "what has this thing been doing" view. */
router.get("/:id/activity", gateMinters, async (req, res) => {
  const companyId = req.auth!.companyId;
  const id = Number(req.params.id);
  if (!companyId || !Number.isFinite(id)) { res.status(400).json({ error: "Bad request" }); return; }

  const rows = await db
    .select({
      route: apiRequestLogTable.route,
      method: apiRequestLogTable.method,
      status: apiRequestLogTable.status,
      duration_ms: apiRequestLogTable.duration_ms,
      ip: apiRequestLogTable.ip,
      created_at: apiRequestLogTable.created_at,
    })
    .from(apiRequestLogTable)
    // company_id is in the predicate as well as api_key_id: the key id alone
    // would be enough today, but every query in this codebase filters by tenant
    // and this one is not going to be the exception that teaches otherwise.
    .where(and(
      eq(apiRequestLogTable.company_id, companyId),
      eq(apiRequestLogTable.api_key_id, id),
    ))
    .orderBy(sql`${apiRequestLogTable.created_at} DESC`)
    .limit(100);

  res.json(rows);
});

export default router;
