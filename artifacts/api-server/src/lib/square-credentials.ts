// [square-per-branch 2026-08-18] Which Square MERCHANT a company transacts on.
//
// Phes Oak Lawn and PHES Schaumburg are separate businesses with separate
// ownership (Sal vs Sal+Ivan), so they hold separate Square ACCOUNTS — not two
// locations under one account. Money from a Schaumburg job has to settle into
// Schaumburg's Square account, never Oak Lawn's.
//
// That makes Square credentials a per-company concern. Every Square call that
// used to read `process.env.SQUARE_*` directly now resolves through here with a
// companyId, so a Schaumburg job cannot silently transact on the Oak Lawn
// merchant just because it inherited the process environment.
//
// ── Why the secrets stay in Railway ──────────────────────────────────────────
// The obvious alternative is columns on `companies` holding the access token.
// That moves a live payment credential into Postgres in plaintext, which is a
// real downgrade from an env var and needs an encryption story we do not have.
// Instead the company row stores only a KEY naming which credential set to use,
// and the secrets stay in Railway where they already live:
//
//   square_account_key = NULL          → SQUARE_ACCESS_TOKEN, SQUARE_APPLICATION_ID, …
//   square_account_key = 'SCHAUMBURG'  → SQUARE_ACCESS_TOKEN_SCHAUMBURG, …
//
// NULL resolving to the unsuffixed vars is what keeps Oak Lawn's behavior
// bit-for-bit identical to before this change. Adding a branch is three Railway
// vars plus one column value — no schema change, no secret in the database.
//
// ── The consequence to remember ──────────────────────────────────────────────
// Square customers and saved cards are MERCHANT-SCOPED. A card saved under the
// Oak Lawn account cannot be charged by the Schaumburg account, and there is no
// API to move it. So `clients.square_customer_id` is only meaningful together
// with the company that owns the client. Never charge a client through a
// merchant other than the one their card was saved on — the charge will fail,
// or worse, hit the wrong customer id on the wrong account.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface SquareCredentials {
  /** True only when the access token AND both public ids are present. */
  configured: boolean;
  /** Server-side secret. NEVER send this to a browser. */
  accessToken: string | null;
  /** Public — safe to hand to the Web Payments SDK. */
  applicationId: string | null;
  /** Public — safe to hand to the Web Payments SDK. */
  locationId: string | null;
  environment: "production" | "sandbox";
  /** Which credential set answered, for logging. NULL = the default/unsuffixed set. */
  accountKey: string | null;
}

// Only A-Z, 0-9 and _ can appear in an env var name. A key that doesn't fit is
// a typo in the company row, and we must NOT quietly fall back to the default
// merchant — that would route Schaumburg money to Oak Lawn. Callers get
// configured:false instead, which surfaces as "payment setup unavailable".
const VALID_KEY = /^[A-Z][A-Z0-9_]*$/;

function readEnvSet(key: string | null): SquareCredentials {
  const suffix = key ? `_${key}` : "";
  const accessToken = process.env[`SQUARE_ACCESS_TOKEN${suffix}`]?.trim() || null;
  const applicationId = process.env[`SQUARE_APPLICATION_ID${suffix}`]?.trim() || null;
  const locationId = process.env[`SQUARE_LOCATION_ID${suffix}`]?.trim() || null;
  // A branch may run in a different Square environment than the default (e.g. a
  // new account still in sandbox while the established one is live), so the env
  // is per-set too — falling back to the global one when not overridden.
  const envRaw = process.env[`SQUARE_ENV${suffix}`] ?? process.env.SQUARE_ENV;
  return {
    configured: !!accessToken && !!applicationId && !!locationId,
    accessToken,
    applicationId,
    locationId,
    environment: envRaw === "production" ? "production" : "sandbox",
    accountKey: key,
  };
}

const NOT_CONFIGURED: SquareCredentials = {
  configured: false,
  accessToken: null,
  applicationId: null,
  locationId: null,
  environment: "sandbox",
  accountKey: null,
};

/**
 * Resolve the Square merchant credentials a company transacts on.
 *
 * Pass the company that OWNS the money — for a booking that is the branch the
 * zip routes to, not whichever tenant the widget happened to be loaded under.
 * A null companyId falls back to the default set, which is only correct for
 * genuinely tenant-less contexts (health checks).
 */
export async function resolveSquareCredentials(companyId: number | null | undefined): Promise<SquareCredentials> {
  if (companyId == null) return readEnvSet(null);
  let key: string | null = null;
  try {
    const rows = await db.execute(
      sql`SELECT square_account_key FROM companies WHERE id = ${companyId} LIMIT 1`,
    );
    const row = (rows as any).rows?.[0];
    // A company id that doesn't exist is a bug in the caller, not a reason to
    // bill through the default merchant.
    if (!row) {
      console.error(`[square-credentials] no company ${companyId} — refusing to fall back to the default merchant`);
      return NOT_CONFIGURED;
    }
    key = (row.square_account_key || "").trim() || null;
  } catch (err: any) {
    console.error("[square-credentials] lookup failed:", err?.message ?? err);
    return NOT_CONFIGURED;
  }

  if (key && !VALID_KEY.test(key)) {
    console.error(`[square-credentials] company ${companyId} has an invalid square_account_key ${JSON.stringify(key)} — refusing to fall back`);
    return NOT_CONFIGURED;
  }

  const creds = readEnvSet(key);
  if (key && !creds.configured) {
    // The branch is CONFIGURED to use its own merchant but the Railway vars for
    // it are missing. Falling through to the default set would put this
    // branch's money in the other branch's bank account, so we refuse loudly.
    console.error(
      `[square-credentials] company ${companyId} wants Square account '${key}' but SQUARE_ACCESS_TOKEN_${key} / SQUARE_APPLICATION_ID_${key} / SQUARE_LOCATION_ID_${key} are not all set`,
    );
  }
  return creds;
}

/** The browser-safe subset. The access token is deliberately not included. */
export function publicPart(c: SquareCredentials) {
  return {
    configured: c.configured,
    applicationId: c.applicationId,
    locationId: c.locationId,
    environment: c.environment,
  };
}
