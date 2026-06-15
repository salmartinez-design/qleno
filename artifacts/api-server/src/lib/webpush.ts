// Web Push (VAPID + RFC 8291 aes128gcm) — pure node crypto, no dependency.
// Internal staff push for the installable PWA. Sends an encrypted payload to a
// browser PushManager subscription. Signed with VAPID (ES256 via jsonwebtoken,
// already a dep). Private key comes from VAPID_PRIVATE_KEY (Railway env);
// public key is safe to commit/expose.

import crypto from "node:crypto";
import jwt from "jsonwebtoken";

// Public VAPID key (safe to expose). The matching PRIVATE key lives ONLY in the
// VAPID_PRIVATE_KEY env var — never committed.
export const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY ||
  "BAAo4rf4pvdWalal3Nde7NCcP-v7J3ypMyDCng5ofJvpsh-KWIiuriOeDaMHbsnawSAexjl5IGz0jxUQsSVGEY8";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@phes.io";

export function webPushConfigured(): boolean {
  return !!process.env.VAPID_PRIVATE_KEY;
}

const b64uDecode = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const b64uEncode = (b: Buffer | Uint8Array) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// VAPID Authorization header for a given push endpoint origin.
function vapidAuthHeader(endpoint: string): string {
  const u = new URL(endpoint);
  const aud = `${u.protocol}//${u.host}`;
  const pub = b64uDecode(VAPID_PUBLIC_KEY); // 0x04 | x(32) | y(32)
  const keyObj = crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: process.env.VAPID_PRIVATE_KEY!, x: b64uEncode(pub.subarray(1, 33)), y: b64uEncode(pub.subarray(33, 65)) },
    format: "jwk",
  });
  const token = jwt.sign(
    { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT },
    keyObj as any,
    { algorithm: "ES256" },
  );
  return `vapid t=${token}, k=${VAPID_PUBLIC_KEY}`;
}

// RFC 8291 aes128gcm encryption of `payload` for the subscription keys.
function encryptPayload(payload: string, p256dh: string, auth: string): Buffer {
  const uaPublic = b64uDecode(p256dh);   // 65-byte uncompressed point
  const authSecret = b64uDecode(auth);   // 16 bytes
  const salt = crypto.randomBytes(16);

  const local = crypto.createECDH("prime256v1");
  local.generateKeys();
  const asPublic = local.getPublicKey();              // 65 bytes
  const sharedSecret = local.computeSecret(uaPublic); // ECDH

  // ikm = HKDF(salt=auth_secret, ikm=ecdh, info="WebPush: info\0"|ua_pub|as_pub, 32)
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32));

  // RFC 8188 content encoding from ikm + salt.
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  // single record: plaintext + 0x02 delimiter (last record)
  const plaintext = Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  // header: salt(16) | rs(uint32 BE) | idlen(1) | keyid(as_public) | ciphertext
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096, 0);
  const idlen = Buffer.from([asPublic.length]); // 65
  return Buffer.concat([salt, rs, idlen, asPublic, ciphertext]);
}

export interface PushSub { endpoint: string; p256dh: string; auth: string }
export type WebPushResult = { ok: boolean; status?: number; dead?: boolean; reason?: string };

// Send one web push. dead=true when the endpoint is gone (404/410) → prune.
export async function sendWebPush(sub: PushSub, payload: Record<string, any>): Promise<WebPushResult> {
  if (!webPushConfigured()) return { ok: false, reason: "no_vapid" };
  try {
    const body = encryptPayload(JSON.stringify(payload), sub.p256dh, sub.auth);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidAuthHeader(sub.endpoint),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "2419200",
      },
      body,
    });
    if (res.status === 404 || res.status === 410) return { ok: false, status: res.status, dead: true };
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status };
  } catch (e: any) {
    return { ok: false, reason: e?.message || "send_error" };
  }
}
