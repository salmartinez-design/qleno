// [square-default 2026-07-24] Public Square Web Payments SDK configuration.
//
// The card-capture FORM (both the office "Enter card now" flow and the public
// /pay link when provider='square') runs client-side against Square's Web
// Payments SDK, which needs two PUBLIC values:
//   - SQUARE_APPLICATION_ID  (production: starts `sq0idp-…`)
//   - SQUARE_LOCATION_ID     (production: starts `L…`)
// Both are safe to expose to the browser — they only identify the merchant + app
// so Square can tokenize a card into a one-time `cnon:` nonce. The SECRET
// SQUARE_ACCESS_TOKEN never leaves the server (it turns the nonce into a saved
// card via lib/square-card-onfile.ts and charges it via lib/square-charge.ts).
//
// `environment` mirrors the charge path: SQUARE_ENV=production → real money;
// anything else → sandbox. The SDK script host differs by environment, so the
// frontend picks the URL from `environment` returned here.
export interface SquarePublicConfig {
  configured: boolean;
  applicationId: string | null;
  locationId: string | null;
  environment: "production" | "sandbox";
}

export function getSquarePublicConfig(): SquarePublicConfig {
  const applicationId = process.env.SQUARE_APPLICATION_ID?.trim() || null;
  const locationId = process.env.SQUARE_LOCATION_ID?.trim() || null;
  const environment = process.env.SQUARE_ENV === "production" ? "production" : "sandbox";
  // A card can only be tokenized AND then saved server-side, so "configured"
  // requires the browser creds (app + location) AND the server token together.
  const hasServerToken = !!process.env.SQUARE_ACCESS_TOKEN;
  return {
    configured: !!applicationId && !!locationId && hasServerToken,
    applicationId,
    locationId,
    environment,
  };
}
