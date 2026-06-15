import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

const VERSION =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GIT_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  "unknown";
const DEPLOYED_AT = process.env.DEPLOYED_AT || new Date().toISOString();
const DB_PING_TIMEOUT_MS = 200;

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/health", async (_req, res) => {
  const timestamp = new Date().toISOString();

  const dbPing = await Promise.race([
    db
      .execute(sql`SELECT 1`)
      .then(() => ({ ok: true as const }))
      .catch((err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      })),
    new Promise<{ ok: false; error: string }>((resolve) =>
      setTimeout(
        () => resolve({ ok: false, error: `timeout after ${DB_PING_TIMEOUT_MS}ms` }),
        DB_PING_TIMEOUT_MS
      )
    ),
  ]);

  const dbStatus = dbPing.ok ? "ok" : `error: ${dbPing.error}`;
  const status = dbPing.ok ? "ok" : "degraded";

  return res.status(status === "ok" ? 200 : 503).json({
    ok: dbPing.ok,
    status,
    timestamp,
    version: VERSION,
    deployed_at: DEPLOYED_AT,
    db: dbStatus,
    dispatch_autonomous_mode: process.env.DISPATCH_AUTONOMOUS_MODE === "true",
    recurring_engine_enabled: process.env.RECURRING_ENGINE_ENABLED !== "false",
    // Global comms master gate. Non-secret boolean (not the value of any
    // credential) — reports whether email/SMS are allowed to leave the box.
    comms_enabled: process.env.COMMS_ENABLED === "true",
    services: {
      stripe: process.env.STRIPE_SECRET_KEY ? "configured" : "not_configured",
      resend: process.env.RESEND_API_KEY ? "configured" : "not_configured",
      twilio: process.env.TWILIO_ACCOUNT_SID ? "configured" : "not_configured",
    },
  });
});

export default router;
