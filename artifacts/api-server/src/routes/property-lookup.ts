import { Router } from "express";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

// [rentcast 2026-07-27] Office property-data lookup. Given a service address,
// query RentCast (https://api.rentcast.io/v1/properties) for square footage /
// beds / baths so the office quote's Property Details can auto-fill instead of
// being typed by hand (Sal). Gated on RENTCAST_API_KEY — returns
// { configured: false } and never calls out until the key is set in Railway, so
// this is inert until then (same pattern as the Square env gates). Office-only.
router.get("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const key = process.env.RENTCAST_API_KEY;
    if (!key) return res.json({ configured: false });

    const address = String(req.query.address ?? "").trim();
    if (!address) return res.status(400).json({ error: "address is required" });

    const url = `https://api.rentcast.io/v1/properties?address=${encodeURIComponent(address)}`;
    const r = await fetch(url, { headers: { "X-Api-Key": key, Accept: "application/json" } });

    if (!r.ok) {
      // 404 = RentCast has no record for that address (common for new construction
      // or a mistyped address) — surface it as "not found", not a hard error.
      if (r.status === 404) return res.json({ configured: true, found: false });
      const body = await r.text().catch(() => "");
      console.error(`[rentcast] lookup ${r.status}: ${body.slice(0, 200)}`);
      return res.status(502).json({ configured: true, found: false, error: `RentCast error (${r.status})` });
    }

    const data: any = await r.json();
    const rec = Array.isArray(data) ? data[0] : data;
    if (!rec) return res.json({ configured: true, found: false });

    // [half-baths 2026-08-12] RentCast reports bathrooms as ONE decimal — a
    // house with 2 full and 1 half is `2.5`. We were passing that straight
    // through to a field the quote builder parseInt()s, so the .5 was dropped
    // on the floor and half baths never reached the quote (Francisco: "the
    // system only displays the full bathrooms and does not show the half baths
    // at all"). Split it here, at the boundary that knows the provider's
    // convention: floor is full baths, a fractional part is one half bath.
    // `bathrooms` keeps its original meaning for any existing consumer;
    // full_bathrooms / half_bathrooms are the split view.
    const rawBaths = rec.bathrooms != null ? Number(rec.bathrooms) : null;
    const fullBaths = rawBaths != null && Number.isFinite(rawBaths) ? Math.floor(rawBaths) : null;
    const halfBaths = rawBaths != null && Number.isFinite(rawBaths)
      ? (rawBaths - Math.floor(rawBaths) >= 0.25 ? 1 : 0)
      : null;

    return res.json({
      configured: true,
      found: true,
      square_footage: rec.squareFootage ?? null,
      bedrooms: rec.bedrooms ?? null,
      bathrooms: rec.bathrooms ?? null,
      full_bathrooms: fullBaths,
      half_bathrooms: halfBaths,
      lot_size: rec.lotSize ?? null,
      year_built: rec.yearBuilt ?? null,
      property_type: rec.propertyType ?? null,
      matched_address: rec.formattedAddress ?? null,
    });
  } catch (err) {
    console.error("GET /property-lookup:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
