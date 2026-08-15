// [company-timezone 2026-08-15] The tenant's local time zone, in one place.
//
// Maribel: "dates should follow the company's local time, not just Chicago."
// "America/Chicago" was a literal in ~70 spots across the API and the app —
// correct for two Illinois branches, silently wrong for any tenant outside
// Central, and impossible to fix per-tenant because there was no per-tenant
// value to read. companies.timezone (seeded from companies.state by the boot
// migration) is now that value, and this module is how you read it.
//
// The cache is deliberate. Almost every caller is inside a SQL builder or a
// synchronous formatting path with no place to await a lookup — ctDate(),
// ctToday(), a row formatter mid-map. A per-request DB round-trip for a value
// that changes maybe once in a tenant's lifetime is the wrong trade, so the
// whole (tiny) table is loaded at boot and refreshed on write.
//
// tzOf() falls back to America/Chicago for an unknown company id, which is both
// the pre-existing behavior and the seeded default — so a cache miss degrades
// to exactly what the code did before this module existed, never to a crash.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export const DEFAULT_TZ = "America/Chicago";

const cache = new Map<number, string>();
let loaded = false;

/** Reject anything Intl can't resolve — a bad zone would throw at format time. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Load every tenant's zone. Called once at boot and after any timezone write. */
export async function loadCompanyTimezones(): Promise<void> {
  try {
    const r = await db.execute(sql`SELECT id, timezone FROM companies`);
    cache.clear();
    for (const row of (r as any).rows ?? []) {
      const tz = (row as any).timezone;
      if (isValidTimeZone(tz)) cache.set(Number((row as any).id), tz);
    }
    loaded = true;
  } catch (err) {
    // Pre-migration boot (column not there yet) is the expected miss. Everything
    // keeps working on the Central default rather than failing startup.
    console.warn("[company-tz] could not load company timezones:", (err as Error).message);
  }
}

/** Refresh one tenant after an owner changes it in Settings. */
export async function refreshCompanyTz(companyId: number): Promise<void> {
  try {
    const r = await db.execute(sql`SELECT timezone FROM companies WHERE id = ${companyId}`);
    const tz = ((r as any).rows ?? [])[0]?.timezone;
    if (isValidTimeZone(tz)) cache.set(companyId, tz);
    else cache.delete(companyId);
  } catch { /* keep the old value rather than dropping to the default */ }
}

/**
 * The tenant's zone, synchronously. Central until the cache is warm — the same
 * answer every one of these call sites gave before, so an early request during
 * boot behaves exactly as it used to instead of erroring.
 */
export function tzOf(companyId: number | null | undefined): string {
  if (!loaded || companyId == null) return DEFAULT_TZ;
  return cache.get(Number(companyId)) ?? DEFAULT_TZ;
}

/** `YYYY-MM-DD` for "now" in the tenant's zone. */
export function companyDateStr(companyId: number | null | undefined, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tzOf(companyId) }).format(at);
}
