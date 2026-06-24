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

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const BUCKET = process.env.R2_BUCKET || "qleno-photos";

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
        accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
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
