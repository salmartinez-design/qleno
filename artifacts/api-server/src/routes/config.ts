/**
 * Frontend runtime configuration.
 *
 * The dispatch popover and other inline editors load Google Maps Places
 * Autocomplete in the browser. The Vite build maps process.env.
 * GOOGLE_MAPS_API_KEY into import.meta.env.VITE_GOOGLE_MAPS_API_KEY at
 * compile time, but if the env var was not set on the build host the
 * bundle ships with an empty string. Fetching the key at runtime makes
 * the frontend resilient to that build state and lets us rotate keys
 * without a rebuild.
 *
 * Auth gated. The same key is already discoverable in any compiled
 * bundle that did receive it, so exposing it to authenticated users adds
 * no real attack surface.
 */
import { Router } from "express";
import { requireAuth } from "../lib/auth.js";

const router = Router();

/**
 * GET /api/config/google-maps-key
 *
 * 200 { key: string } — empty string when the server has no key configured.
 * Frontend treats empty as "Maps unavailable" and falls back to manual entry.
 */
router.get("/google-maps-key", requireAuth, (_req, res) => {
  return res.json({ key: process.env.GOOGLE_MAPS_API_KEY ?? "" });
});

/**
 * GET /api/config/feature-flags
 *
 * Runtime feature flags for the frontend. Values come from Railway env
 * vars so we can flip a flag without rebuilding the bundle. Auth-gated
 * (same reasoning as google-maps-key — flags are operator-facing,
 * exposing them to authenticated users adds no real attack surface).
 *
 * Add new flags here as they're introduced. Keep the response shape
 * flat — frontend code reads `flags.<name>` with a default.
 *
 *   cascade_preview  — gates the EditJobModal "Preview changes" button
 *                      that runs PATCH /api/jobs/:id with dry_run=true
 *                      and shows the would-change counters before the
 *                      operator commits to a real save. Default off
 *                      (Sal flips it on when ready).
 */
router.get("/feature-flags", requireAuth, (_req, res) => {
  return res.json({
    cascade_preview: process.env.CASCADE_PREVIEW_ENABLED === "true",
  });
});

export default router;
