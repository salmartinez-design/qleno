import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { VAPID_PUBLIC_KEY, webPushConfigured } from "../lib/webpush.js";

const router = Router();

// GET /api/push/vapid-public-key — the frontend needs this to subscribe.
// `configured` reports whether VAPID_PRIVATE_KEY is set on this instance (i.e.
// the server can actually send, vs the safe no-op). Public diagnostic, no secret.
router.get("/vapid-public-key", (_req, res) => res.json({ key: VAPID_PUBLIC_KEY, configured: webPushConfigured() }));

// POST /api/push/subscribe — store a PushManager subscription for this user+device.
// Body: { endpoint, keys: { p256dh, auth } } (the browser PushSubscription JSON).
router.post("/subscribe", requireAuth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body ?? {};
    const p256dh = keys?.p256dh;
    const auth = keys?.auth;
    if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: "endpoint + keys.p256dh + keys.auth required" });
    const ua = String(req.headers["user-agent"] ?? "").slice(0, 300);
    // Endpoint is globally unique (one per browser+device). Repoint to the
    // current user on conflict (re-login / shared device).
    await db.execute(sql`
      INSERT INTO push_subscriptions (user_id, company_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at)
      VALUES (${req.auth!.userId}, ${req.auth!.companyId}, ${endpoint}, ${p256dh}, ${auth}, ${ua}, NOW(), NOW())
      ON CONFLICT (endpoint) DO UPDATE SET
        user_id = EXCLUDED.user_id, company_id = EXCLUDED.company_id,
        p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent, last_seen_at = NOW()`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /push/subscribe:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /api/push/unsubscribe — remove a subscription by endpoint.
router.post("/unsubscribe", requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body ?? {};
    if (!endpoint) return res.status(400).json({ error: "endpoint required" });
    await db.execute(sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint} AND user_id = ${req.auth!.userId}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /push/unsubscribe:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /api/push/status — does this user have any registered push device?
router.get("/status", requireAuth, async (req, res) => {
  try {
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = ${req.auth!.userId}`);
    return res.json({ devices: (r.rows[0] as any)?.n ?? 0 });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
