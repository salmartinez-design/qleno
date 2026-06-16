import { randomBytes } from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { appBaseUrl } from "./app-url.js";

// [sms Pass3] Internal short-link redirect — replaces the long hex-token URLs in
// customer SMS (e.g. app.qleno.com/quote/5272680c…) with a clean
// app.qleno.com/s/<code>. No third-party shortener. A small code→target table;
// GET /s/:code 302s to the stored target (the same token page).

let ready = false;
export async function ensureShortLinkTable(): Promise<void> {
  if (ready) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS short_links (
        id          serial PRIMARY KEY,
        code        text NOT NULL UNIQUE,
        target      text NOT NULL,
        company_id  integer,
        created_at  timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS short_links_target_key ON short_links (target)`);
    ready = true;
  } catch (err) {
    console.error("[short-link] ensure table failed (non-fatal):", err);
  }
}

// URL-safe short code (base62-ish). 7 chars ≈ 3.5e12 space — ample, unguessable.
function genCode(len = 7): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// Find-or-create a short link for a target URL; returns the public short URL.
// Idempotent per target (a re-sent quote/appointment reuses the same code).
// On any failure, falls back to the original target so a send never breaks.
export async function shortenUrl(target: string | null, companyId?: number | null): Promise<string | null> {
  if (!target) return target;
  try {
    await ensureShortLinkTable();
    const existing = await db.execute(sql`SELECT code FROM short_links WHERE target = ${target} LIMIT 1`);
    let code = (existing.rows[0] as any)?.code as string | undefined;
    if (!code) {
      // Retry a couple of times on the rare code collision.
      for (let attempt = 0; attempt < 3 && !code; attempt++) {
        const candidate = genCode();
        const ins = await db.execute(sql`
          INSERT INTO short_links (code, target, company_id)
          VALUES (${candidate}, ${target}, ${companyId ?? null})
          ON CONFLICT (target) DO UPDATE SET target = EXCLUDED.target
          RETURNING code
        `);
        code = (ins.rows[0] as any)?.code;
      }
    }
    return code ? `${appBaseUrl()}/s/${code}` : target;
  } catch (err) {
    console.error("[short-link] shortenUrl failed (using full URL):", err);
    return target;
  }
}

// Resolve a code to its target (for the /s/:code redirect). Null if unknown.
export async function resolveShortLink(code: string): Promise<string | null> {
  try {
    const row = await db.execute(sql`SELECT target FROM short_links WHERE code = ${code} LIMIT 1`);
    return (row.rows[0] as any)?.target ?? null;
  } catch {
    return null;
  }
}
