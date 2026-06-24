// [photos-r2 2026-06-24] Cloudflare R2 object storage (S3-compatible).
// Replaces the Replit-sidecar object storage (lib/objectStorage.ts) that does
// NOT work on Railway — which is why job photos were being shoved into the DB
// as base64 (1.4 GB in job_photos.url). Job photos now live in R2; the DB row
// stores only the object key in job_photos.url.
//
// Required env (set in Railway → api-server → Variables):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// [photos-r2 fix] Strip ALL non-printable-ASCII chars (newlines, tabs, control,
// non-ASCII), not just trim the ends — a stray character anywhere in a pasted
// Railway variable corrupts the S3 SigV4 auth header ("Invalid character in
// header content [authorization]") and every upload fails. R2 keys are hex, so
// this only ever removes paste artifacts, never legitimate characters.
const clean = (s: string | undefined): string =>
  (s || "").replace(/[^\x20-\x7E]/g, "").trim();

const ACCOUNT_ID = clean(process.env.R2_ACCOUNT_ID);
const BUCKET = clean(process.env.R2_BUCKET) || "qleno-photos";

// Safe diagnostic — lengths only, never the values. `stripped > 0` means that
// variable had non-printable paste junk in it.
export function r2CredFingerprint() {
  const fp = (k: string) => {
    const raw = process.env[k] || "";
    return { raw_len: raw.length, clean_len: clean(raw).length };
  };
  return {
    account: fp("R2_ACCOUNT_ID"),
    access_key_id: fp("R2_ACCESS_KEY_ID"),
    secret: fp("R2_SECRET_ACCESS_KEY"),
    bucket: fp("R2_BUCKET"),
  };
}

let _client: S3Client | null = null;

/** True once all R2 env vars are present. Routes fall back to legacy base64
 *  storage while this is false, so nothing breaks before R2 is wired up. */
export function r2Configured(): boolean {
  return Boolean(
    ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY
  );
}

function client(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: "auto",
      endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: clean(process.env.R2_ACCESS_KEY_ID),
        secretAccessKey: clean(process.env.R2_SECRET_ACCESS_KEY),
      },
      // [photos-r2 fix] AWS SDK v3 (≥3.729) adds default CRC32 integrity
      // checksums + a streaming trailer that R2 rejects ("not implemented" /
      // signature mismatch on PutObject). Force checksums to WHEN_REQUIRED so
      // they're omitted for normal puts. This is the standard R2 + aws-sdk fix.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return _client;
}

export async function r2Upload(
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  await client().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

/** Short-lived signed GET URL the browser can load directly (<img src>). */
export async function r2SignedGetUrl(
  key: string,
  expiresIn = 3600
): Promise<string> {
  return getSignedUrl(
    client(),
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn }
  );
}

export async function r2Delete(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

/** A stored job_photos.url is a legacy inline image when it's a data: URL.
 *  Anything starting with http(s):// or / is already a servable URL. Otherwise
 *  it's an R2 object key that must be signed before serving. */
export function isLegacyDataUrl(url: string | null | undefined): boolean {
  return Boolean(url && url.startsWith("data:"));
}
export function isAlreadyUrl(url: string | null | undefined): boolean {
  return Boolean(url && (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/")));
}
export function isR2Key(url: string | null | undefined): boolean {
  return Boolean(url) && !isLegacyDataUrl(url) && !isAlreadyUrl(url);
}

/** Build the object key for a job photo. */
export function jobPhotoKey(
  companyId: number,
  jobId: number,
  ext: string,
  rand: string
): string {
  const safeExt = (ext || "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
  return `companies/${companyId}/jobs/${jobId}/${rand}.${safeExt}`;
}
