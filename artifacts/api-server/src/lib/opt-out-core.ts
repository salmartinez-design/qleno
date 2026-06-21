// [comms-opt-out 2026-06-21] PURE helpers for the opt-out layer — no
// `@workspace/db` import, so unit tests load them without triggering Drizzle
// init (same pattern as auto-promos-core.ts). The DB-backed helpers live in
// opt-out.ts and re-export everything here.

// Last-10-digits of a phone, the match key used across the SMS store + opt-out.
export function phoneDigits(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/\D/g, "").slice(-10);
}

// SMS STOP / START keyword sets (mirror Twilio's carrier-level keywords).
const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES", "UNCANCEL", "RESUME"]);

export function isStopKeyword(body: string): boolean {
  return STOP_WORDS.has(String(body ?? "").trim().toUpperCase());
}
export function isStartKeyword(body: string): boolean {
  return START_WORDS.has(String(body ?? "").trim().toUpperCase());
}

// Public base URL for the unsubscribe link. Configurable; defaults to prod.
export function appBaseUrl(): string {
  return (
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_APP_URL ||
    "https://workspaceapi-server-production-b9d4.up.railway.app"
  ).replace(/\/+$/, "");
}

export type EmailUnsubData = {
  token: string;
  unsubUrl: string;
  headers: Record<string, string>;
  footerHtml: string;
};

// Build the List-Unsubscribe headers + footer link for a known token (no DB).
export function buildUnsubDataFromToken(token: string): EmailUnsubData {
  const unsubUrl = `${appBaseUrl()}/api/comms/unsubscribe?token=${encodeURIComponent(token)}`;
  return {
    token,
    unsubUrl,
    headers: {
      // RFC 2369 + RFC 8058 one-click. Gmail/Outlook render the native
      // "Unsubscribe" affordance and POST to this URL on click.
      "List-Unsubscribe": `<${unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    footerHtml:
      `<div style="margin-top:16px;font-size:11px;color:#9E9B94;text-align:center;line-height:1.5">` +
      `Don't want these emails? ` +
      `<a href="${unsubUrl}" style="color:#9E9B94;text-decoration:underline">Unsubscribe</a>.` +
      `</div>`,
  };
}
