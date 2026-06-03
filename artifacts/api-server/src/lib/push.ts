// Push notifications (Capacitor native app)
// ---------------------------------------------------------------------------
// Sends to a user's registered devices via APNs (iOS) and FCM (Android). The
// device tokens are persisted by routes/devices.ts into the device_tokens
// table. Everything here is:
//   - gated by COMMS_ENABLED (mirrors the SMS/email discipline — nothing fires
//     until the env var is "true"), and
//   - a no-op when the platform's credentials are absent, so this is safe to
//     ship before the APNs/FCM keys exist; it "switches on" the moment they're
//     added to Railway env vars.
//
// No new dependency: APNs (ES256) and the FCM OAuth assertion (RS256) are both
// signed with the existing `jsonwebtoken`. APNs uses node's built-in HTTP/2.
//
// Required env vars to go live:
//   iOS  — APNS_KEY_P8 (the .p8 contents), APNS_KEY_ID, APNS_TEAM_ID,
//          APNS_BUNDLE_ID (default io.phes.qleno), APNS_PRODUCTION ("true"|"false")
//   Andr — FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY

import http2 from "node:http2";
import jwt from "jsonwebtoken";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type PushPayload = {
  title: string;
  body: string;
  // Arbitrary deep-link data, e.g. { type: "job", jobId: "123" }. Values are
  // coerced to strings (FCM data values must be strings).
  data?: Record<string, string | number>;
};

type DeviceRow = { id: number; token: string; platform: string };

// ── Token persistence ──────────────────────────────────────────────────────

export async function upsertDeviceToken(opts: {
  companyId: number;
  userId: number;
  token: string;
  platform: string;
}): Promise<void> {
  const platform = ["ios", "android", "web"].includes(opts.platform) ? opts.platform : "unknown";
  // A token is globally unique (one per app install). If it reappears for a
  // different user (shared device, re-login), repoint it and refresh last_seen.
  await db.execute(sql`
    INSERT INTO device_tokens (company_id, user_id, token, platform, last_seen_at)
    VALUES (${opts.companyId}, ${opts.userId}, ${opts.token}, ${platform}, NOW())
    ON CONFLICT (token) DO UPDATE
      SET company_id = EXCLUDED.company_id,
          user_id    = EXCLUDED.user_id,
          platform   = EXCLUDED.platform,
          last_seen_at = NOW()
  `);
}

export async function deleteDeviceToken(token: string): Promise<void> {
  await db.execute(sql`DELETE FROM device_tokens WHERE token = ${token}`);
}

async function tokensForUser(companyId: number, userId: number): Promise<DeviceRow[]> {
  const r = await db.execute(sql`
    SELECT id, token, platform FROM device_tokens
    WHERE company_id = ${companyId} AND user_id = ${userId}
  `);
  return (r.rows as any[]).map((row) => ({ id: Number(row.id), token: String(row.token), platform: String(row.platform) }));
}

// ── APNs (iOS) ───────────────────────────────────────────────────────────────

let apnsJwt: { token: string; iat: number } | null = null;

function apnsConfigured(): boolean {
  return !!(process.env.APNS_KEY_P8 && process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID);
}

function apnsAuthToken(): string {
  // APNs JWTs are valid up to 1h; refresh every ~50 minutes.
  const now = Math.floor(Date.now() / 1000);
  if (apnsJwt && now - apnsJwt.iat < 3000) return apnsJwt.token;
  const key = (process.env.APNS_KEY_P8 || "").replace(/\\n/g, "\n");
  const token = jwt.sign({ iss: process.env.APNS_TEAM_ID, iat: now }, key, {
    algorithm: "ES256",
    header: { alg: "ES256", kid: process.env.APNS_KEY_ID! },
  });
  apnsJwt = { token, iat: now };
  return token;
}

// Returns the set of tokens APNs reported as permanently invalid (to prune).
async function sendApns(tokens: string[], payload: PushPayload): Promise<string[]> {
  if (!tokens.length || !apnsConfigured()) return [];
  const host = process.env.APNS_PRODUCTION === "true"
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";
  const topic = process.env.APNS_BUNDLE_ID || "io.phes.qleno";
  const auth = apnsAuthToken();
  const body = JSON.stringify({
    aps: { alert: { title: payload.title, body: payload.body }, sound: "default" },
    ...Object.fromEntries(Object.entries(payload.data ?? {}).map(([k, v]) => [k, String(v)])),
  });

  const dead: string[] = [];
  const client = http2.connect(host);
  try {
    await Promise.all(tokens.map((deviceToken) => new Promise<void>((resolve) => {
      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${auth}`,
        "apns-topic": topic,
        "apns-push-type": "alert",
        "content-type": "application/json",
      });
      let status = 0;
      let respBody = "";
      req.on("response", (h) => { status = Number(h[":status"]); });
      req.on("data", (c) => { respBody += c; });
      req.on("end", () => {
        // 410 = device no longer registered; 400 BadDeviceToken = invalid.
        if (status === 410 || (status === 400 && /BadDeviceToken|Unregistered/i.test(respBody))) {
          dead.push(deviceToken);
        } else if (status !== 200) {
          console.warn(`[push:apns] status ${status} ${respBody.slice(0, 120)}`);
        }
        resolve();
      });
      req.on("error", (e) => { console.warn("[push:apns] req error", e.message); resolve(); });
      req.setTimeout(8000, () => { req.close(); resolve(); });
      req.end(body);
    })));
  } finally {
    client.close();
  }
  return dead;
}

// ── FCM (Android) ─────────────────────────────────────────────────────────────

let fcmAccess: { token: string; exp: number } | null = null;

function fcmConfigured(): boolean {
  return !!(process.env.FCM_PROJECT_ID && process.env.FCM_CLIENT_EMAIL && process.env.FCM_PRIVATE_KEY);
}

async function fcmAccessToken(): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (fcmAccess && fcmAccess.exp - now > 60) return fcmAccess.token;
  const key = (process.env.FCM_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const assertion = jwt.sign(
    {
      iss: process.env.FCM_CLIENT_EMAIL,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    key,
    { algorithm: "RS256" },
  );
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!res.ok) {
    console.warn(`[push:fcm] token exchange failed ${res.status}`);
    return null;
  }
  const j = (await res.json()) as { access_token: string; expires_in: number };
  fcmAccess = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return j.access_token;
}

async function sendFcm(tokens: string[], payload: PushPayload): Promise<string[]> {
  if (!tokens.length || !fcmConfigured()) return [];
  const access = await fcmAccessToken();
  if (!access) return [];
  const url = `https://fcm.googleapis.com/v1/projects/${process.env.FCM_PROJECT_ID}/messages:send`;
  const data = Object.fromEntries(Object.entries(payload.data ?? {}).map(([k, v]) => [k, String(v)]));

  const dead: string[] = [];
  await Promise.all(tokens.map(async (deviceToken) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: { token: deviceToken, notification: { title: payload.title, body: payload.body }, data },
        }),
      });
      if (res.status === 404) {
        dead.push(deviceToken); // UNREGISTERED
      } else if (!res.ok) {
        const t = await res.text().catch(() => "");
        if (/UNREGISTERED|INVALID_ARGUMENT/i.test(t)) dead.push(deviceToken);
        else console.warn(`[push:fcm] status ${res.status} ${t.slice(0, 120)}`);
      }
    } catch (e: any) {
      console.warn("[push:fcm] send error", e?.message);
    }
  }));
  return dead;
}

// ── Public API ─────────────────────────────────────────────────────────────

export type PushResult =
  | { status: "sent"; devices: number }
  | { status: "no_devices" }
  | { status: "suppressed_comms_disabled" }
  | { status: "not_configured" };

/**
 * Send a push to every device a user has registered. Fire-and-forget friendly:
 * never throws, returns a structured result. Dead tokens are pruned.
 */
export async function notifyUser(
  userId: number,
  companyId: number,
  payload: PushPayload,
): Promise<PushResult> {
  if (process.env.COMMS_ENABLED !== "true") {
    console.log("[COMMS BLOCKED] push suppressed — COMMS_ENABLED!=true", { userId, title: payload.title });
    return { status: "suppressed_comms_disabled" };
  }
  if (!apnsConfigured() && !fcmConfigured()) return { status: "not_configured" };

  const devices = await tokensForUser(companyId, userId);
  if (!devices.length) return { status: "no_devices" };

  const ios = devices.filter((d) => d.platform === "ios").map((d) => d.token);
  const android = devices.filter((d) => d.platform !== "ios").map((d) => d.token);

  const [deadIos, deadAndroid] = await Promise.all([
    sendApns(ios, payload).catch((e) => { console.warn("[push:apns] batch error", e?.message); return [] as string[]; }),
    sendFcm(android, payload).catch((e) => { console.warn("[push:fcm] batch error", e?.message); return [] as string[]; }),
  ]);

  const dead = [...deadIos, ...deadAndroid];
  if (dead.length) {
    await db.execute(sql`DELETE FROM device_tokens WHERE token = ANY(${dead})`).catch(() => {});
  }
  return { status: "sent", devices: devices.length - dead.length };
}

/** Convenience wrapper for callers that don't care about the result. */
export function notifyUserAsync(userId: number, companyId: number, payload: PushPayload): void {
  void notifyUser(userId, companyId, payload).catch((e) => console.warn("[push] notifyUser error", e?.message));
}
