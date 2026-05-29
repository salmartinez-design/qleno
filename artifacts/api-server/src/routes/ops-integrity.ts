/**
 * Cutover 1E — On-demand re-run of the startup clock-integrity self-check.
 *
 * GET /api/ops/integrity-check (owner/admin only). Same code path as
 * the boot self-check. Never crashes the server; returns the structured
 * IntegrityCheckResult so the office can re-verify in production
 * without waiting for the next deploy.
 */
import { Router } from "express";
import { requireAuth, requireRole } from "../lib/auth.js";
import { verifyClockIntegrityConstraint } from "../lib/clock-integrity-self-check.js";

const router = Router();

router.get(
  "/integrity-check",
  requireAuth,
  requireRole("owner", "admin", "super_admin"),
  async (_req, res) => {
    try {
      const result = await verifyClockIntegrityConstraint();
      return res.json({ data: result });
    } catch (err) {
      return res.status(500).json({
        error: "Internal Server Error",
        message: (err as Error).message,
      });
    }
  },
);

export default router;
