// Single source of truth for the public, customer-facing app base URL.
// APP_BASE_URL (Railway env) wins; defaults to the live Qleno domain.
// NEVER the old Replit backup (clean-ops-pro.replit.app) — that domain 404s.
// Trailing slashes are trimmed so callers can safely append "/estimate/<token>".
export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL || "https://app.qleno.com").replace(/\/+$/, "");
}

// Absolute logo URL for emails. companies.logo_url is often a RELATIVE path
// (e.g. "/images/phes-logo.jpeg"), which never loads in an email client — they
// have no base to resolve against. Prefix relative paths with the public app
// origin; pass through already-absolute http(s) URLs untouched. Falls back to
// the bundled Phes mark so the header is never empty.
export function emailLogoUrl(logoUrl?: string | null): string {
  const base = appBaseUrl();
  if (!logoUrl) return `${base}/phes-logo.jpeg`;
  if (/^https?:\/\//i.test(logoUrl)) return logoUrl;
  return `${base}${logoUrl.startsWith("/") ? "" : "/"}${logoUrl}`;
}
