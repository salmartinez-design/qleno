/**
 * Cutover 2A (corrective) — Provider selection point.
 *
 * One place decides which DistanceProvider a tenant gets. The route
 * NEVER imports a vendor adapter directly. Today the default is the
 * Google Distance Matrix + haversine adapter, wrapped in the per-
 * tenant cache. A future env-var or per-company setting swap goes
 * here, not in the route call site.
 *
 * The cache wrapper is applied here too (not in the route) so every
 * mileage call benefits without each call site remembering to
 * compose it.
 */
import { defaultDistanceProvider } from "./distance-provider.js";
import { withDistanceCache } from "./distance-cache.js";
import type { DistanceProvider } from "./distance-provider.js";

/** Resolve the DistanceProvider for `companyId`. Currently every
 *  tenant gets the default adapter behind the per-tenant cache. A
 *  future tenant.distance_provider setting plugs in here. */
export function getDistanceProvider(companyId: number): DistanceProvider {
  return withDistanceCache(defaultDistanceProvider, companyId);
}
