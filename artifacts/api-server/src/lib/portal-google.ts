// [portal-google 2026-08-06] "Sign in with Google" for CUSTOMERS on the portal.
// Staff sign-in is untouched and stays email + password (Sal, 2026-08-06:
// "just customers").
//
// Inert until GOOGLE_PORTAL_CLIENT_ID is set, exactly like Square is gated on
// its env vars. Nothing here runs, and the button never renders, until the
// tenant supplies a client id.
//
// ONLY A CLIENT ID IS NEEDED — no client secret. The browser uses Google
// Identity Services, which hands us a signed ID token (a JWT) rather than an
// authorization code, so there is no code-for-token exchange to authenticate.
// A client id is public by design. That means nothing secret is stored for this
// feature, which is a meaningful reduction in what can leak.
import { OAuth2Client } from "google-auth-library";

export interface GoogleIdentity {
  /** Google's stable subject id. The join key — NOT the email. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export const googlePortalClientId = () => process.env.GOOGLE_PORTAL_CLIENT_ID || null;
export const googlePortalEnabled = () => !!googlePortalClientId();

let client: OAuth2Client | null = null;
const getClient = () => (client ??= new OAuth2Client(googlePortalClientId()!));

/**
 * Verify a Google ID token and return the identity it asserts.
 *
 * `verifyIdToken` checks the signature against Google's rotating public keys,
 * the expiry, the issuer, AND that the audience is our client id. That last
 * check is the load-bearing one: without it, a token minted for any other
 * Google app would be accepted here, and anyone could sign in as anyone.
 *
 * Returns null on any failure — an invalid token is a failed sign-in, never an
 * error surfaced to the customer with detail about why.
 */
export async function verifyGoogleIdToken(credential: unknown): Promise<GoogleIdentity | null> {
  if (!googlePortalEnabled()) return null;
  if (typeof credential !== "string" || credential.length < 20 || credential.length > 8192) return null;
  try {
    const ticket = await getClient().verifyIdToken({
      idToken: credential,
      audience: googlePortalClientId()!,
    });
    const p = ticket.getPayload();
    if (!p?.sub) return null;
    return {
      subject: p.sub,
      email: p.email ?? null,
      // Google sets this false for unverified addresses. We refuse to match an
      // unverified email to an existing login — otherwise someone could claim a
      // customer's account by signing up to Google with their address.
      emailVerified: p.email_verified === true,
      name: p.name ?? null,
    };
  } catch (err) {
    console.error("[portal-google] ID token rejected:", (err as any)?.message);
    return null;
  }
}
