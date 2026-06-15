// Single source of truth for the public, customer-facing app base URL.
// APP_BASE_URL (Railway env) wins; defaults to the live Qleno domain.
// NEVER the old Replit backup (clean-ops-pro.replit.app) — that domain 404s.
// Trailing slashes are trimmed so callers can safely append "/estimate/<token>".
export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL || "https://app.qleno.com").replace(/\/+$/, "");
}
