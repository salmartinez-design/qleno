/**
 * Geocode validation route.
 *
 * Standalone endpoint for verifying that an address resolves on Google
 * Maps before we let it land in the database. The dispatch popover and
 * drawer address editor call this first; if it returns 422 the form
 * rejects the save inline without round tripping through clients or
 * jobs writes.
 *
 * Read only with respect to the database. Hits Google Maps Geocoding
 * API via the existing `geocodeAddress` helper, which reads
 * GOOGLE_MAPS_API_KEY (server side, unrestricted key).
 *
 * Mounted at /api/geocode in routes/index.ts.
 */
import { Router } from "express";
import { requireAuth } from "../lib/auth.js";
// Future cleanup: consolidate with the divergent helper at routes/clients.ts.
import { geocodeAddress } from "../lib/geocode.js";

const router = Router();

/**
 * POST /api/geocode/validate
 *
 * Body: { address: string, city?: string, state?: string, zip?: string }
 *
 * 200 on success: { valid: true, lat: number, lng: number }
 * 400 on missing address (street is the only required field)
 * 422 on geocode failure (no results, ambiguous, or non OK status)
 *
 * No DB writes. Safe to call repeatedly while the user types.
 */
router.post("/validate", requireAuth, async (req, res) => {
  const { address, city, state, zip } = (req.body ?? {}) as {
    address?: string; city?: string; state?: string; zip?: string;
  };

  if (!address || !address.trim()) {
    return res.status(400).json({
      valid: false,
      error: "Street address is required.",
    });
  }

  const full = [address, city, state, zip].filter(Boolean).join(", ");
  const coords = await geocodeAddress(full);

  if (!coords) {
    return res.status(422).json({
      valid: false,
      error: "Could not verify address. Check spelling, city, and zip.",
    });
  }

  return res.json({
    valid: true,
    lat: coords.lat,
    lng: coords.lng,
  });
});

export default router;
