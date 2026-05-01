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
// Cold-start tolerant. The original 200 ms was too tight for CI's
// freshly-spun Postgres service container — the first SELECT 1
// takes longer than 200 ms while pg connects + warms up, leading
// to /api/health returning 503 until ~5 s in. 2 s is well below
// Railway's 100 s healthcheck default and still fast enough that
// a real prod outage surfaces as 503 in under 3 s.
const DB_PING_TIMEOUT_MS = 2_000;

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
    services: {
      stripe: process.env.STRIPE_SECRET_KEY ? "configured" : "not_configured",
      resend: process.env.RESEND_API_KEY ? "configured" : "not_configured",
      twilio: process.env.TWILIO_ACCOUNT_SID ? "configured" : "not_configured",
    },
  });
});

export default router;
