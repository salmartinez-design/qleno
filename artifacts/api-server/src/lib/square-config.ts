// [square-default 2026-07-24] Public Square Web Payments SDK configuration.
//
// The card-capture FORM (the office "Enter card now" flow, the public booking
// widget, and the public /pay link) runs client-side against Square's Web
// Payments SDK, which needs two PUBLIC values:
//   - the application id  (production: starts `sq0idp-…`)
//   - the location id     (production: starts `L…`)
// Both are safe to expose to the browser — they only identify the merchant + app
// so Square can tokenize a card into a one-time `cnon:` nonce. The SECRET access
// token never leaves the server (it turns the nonce into a saved card via
// lib/square-card-onfile.ts and charges it via lib/square-charge.ts).
//
// [square-per-branch 2026-08-18] These are now per-COMPANY. Oak Lawn and
// Schaumburg are separate businesses on separate Square accounts, so the
// application id handed to the browser decides which merchant the card is
// tokenized for — get it wrong and the card is saved to the other business.
// Resolution lives in lib/square-credentials.ts; this file is the public view
// of it.
import { resolveSquareCredentials, publicPart } from "./square-credentials.js";

export interface SquarePublicConfig {
  configured: boolean;
  applicationId: string | null;
  locationId: string | null;
  environment: "production" | "sandbox";
}

/**
 * Public Square config for ONE company.
 *
 * `configured` requires the browser creds (application + location) AND the
 * server token together, because a card can only be tokenized and then saved.
 */
export async function getSquarePublicConfig(companyId: number | null | undefined): Promise<SquarePublicConfig> {
  return publicPart(await resolveSquareCredentials(companyId));
}
