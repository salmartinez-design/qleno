// [engagement-tracking-phase4 2026-06-25] Native engagement layer.
// One append-only timeline (engagement_events) that every source fans into, plus
// our own click-redirect / open-pixel tokens (tracked_links) so opens & clicks
// are recorded natively — not just via Resend. No external analytics.

import { randomBytes } from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { appBaseUrl } from "./app-url.js";

export type EngagementEventType =
  | "sent" | "delivered" | "opened" | "clicked" | "replied"
  | "viewed" | "accepted" | "declined" | "bounced" | "failed";

export interface RecordEventArgs {
  companyId: number;
  eventType: EngagementEventType;
  estimateId?: number | null;
  enrollmentId?: number | null;
  channel?: string | null;
  recipient?: string | null;
  meta?: Record<string, unknown> | null;
}

// Append one engagement event. Never throws — engagement is observability, it
// must never break the calling request (a send, a page view, a webhook).
export async function recordEngagementEvent(a: RecordEventArgs): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO engagement_events
        (company_id, estimate_id, enrollment_id, event_type, channel, recipient, meta)
      VALUES
        (${a.companyId}, ${a.estimateId ?? null}, ${a.enrollmentId ?? null},
         ${a.eventType}, ${a.channel ?? null}, ${a.recipient ?? null},
         ${a.meta ? JSON.stringify(a.meta) : null}::jsonb)
    `);
  } catch (err) {
    console.error("[engagement] recordEngagementEvent failed (non-fatal):", err);
  }
}

function genToken(len = 18): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// Mint a click-redirect link. Returns a public URL (/api/track/c/<token>) that,
// when hit, records a 'clicked' event tied to the estimate + enrollment then
// 302s to target_url. Falls back to target_url on any DB failure.
export async function createTrackedLink(args: {
  companyId: number; targetUrl: string; estimateId?: number | null; enrollmentId?: number | null; recipient?: string | null;
}): Promise<string> {
  try {
    const token = genToken();
    await db.execute(sql`
      INSERT INTO tracked_links (token, company_id, estimate_id, enrollment_id, kind, target_url, recipient)
      VALUES (${token}, ${args.companyId}, ${args.estimateId ?? null}, ${args.enrollmentId ?? null}, 'click', ${args.targetUrl}, ${args.recipient ?? null})
    `);
    return `${appBaseUrl()}/api/track/c/${token}`;
  } catch (err) {
    console.error("[engagement] createTrackedLink failed (non-fatal):", err);
    return args.targetUrl;
  }
}

// Mint an open-pixel URL (/api/track/o/<token>.png). Returns "" on failure so
// callers can simply skip the pixel.
export async function createOpenPixel(args: {
  companyId: number; estimateId?: number | null; enrollmentId?: number | null; recipient?: string | null;
}): Promise<string> {
  try {
    const token = genToken();
    await db.execute(sql`
      INSERT INTO tracked_links (token, company_id, estimate_id, enrollment_id, kind, target_url, recipient)
      VALUES (${token}, ${args.companyId}, ${args.estimateId ?? null}, ${args.enrollmentId ?? null}, 'open', NULL, ${args.recipient ?? null})
    `);
    return `${appBaseUrl()}/api/track/o/${token}.png`;
  } catch (err) {
    console.error("[engagement] createOpenPixel failed (non-fatal):", err);
    return "";
  }
}
