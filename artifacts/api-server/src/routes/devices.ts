// Device-token registration for native push notifications.
// The Capacitor app (src/lib/native-push.ts) calls POST /api/devices/register
// after APNs/FCM issues a token, and DELETE on logout.
import { Router } from "express";
import { requireAuth } from "../lib/auth.js";
import { upsertDeviceToken, deleteDeviceToken } from "../lib/push.js";

const router = Router();

// POST /api/devices/register  { token, platform }
router.post("/register", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    const platform = typeof req.body?.platform === "string" ? req.body.platform : "unknown";
    if (!token) return res.status(400).json({ error: "token required" });

    await upsertDeviceToken({ companyId, userId, token, platform });
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /devices/register error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// DELETE /api/devices/register  { token }  — called on logout / opt-out.
router.delete("/register", requireAuth, async (req, res) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (token) await deleteDeviceToken(token);
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /devices/register error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
