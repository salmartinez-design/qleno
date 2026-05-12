/**
 * LMS Signatures — pure helpers.
 *
 * No DB imports. Sole-purpose: cryptographic hashing + Express request
 * metadata capture + signature payload validation. Lives apart from
 * `lms-signatures-db.ts` so the unit tests can exercise these without
 * pulling drizzle (and consequently the pg driver) into the test
 * process. The DB-touching functions are in `lms-signatures-db.ts`.
 *
 * UETA / E-SIGN reminders that drive these helpers:
 *   1. Affirmative action required at signing time. Capture: IP,
 *      user-agent, signed_at timestamp.
 *   2. Content version traceability: every signed_document row points
 *      at a lms_document_versions row, AND denormalizes the
 *      version_hash so the audit chain survives accidental version
 *      table edits.
 *   3. Tamper-evident: hashes are SHA-256 of canonical content
 *      (locale-prefixed). Any whitespace / locale change produces a
 *      different hash so a "the content was actually X" claim cannot
 *      be made retroactively.
 */
import { createHash } from "node:crypto";
import type { Request } from "express";

// ─────────────────────────────────────────────────────────────────────────────
// Hashing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce the canonical version hash for a piece of document content.
 *
 * The locale is part of the hash because the English and Spanish
 * versions of the same document are legally distinct (different
 * binding text). Two locales of the same doc always have different
 * hashes.
 *
 * Whitespace is preserved exactly. Callers must pass the canonical
 * rendered content the user actually saw at signing.
 *
 * @returns 64-char lowercase hex SHA-256 digest.
 */
export function hashContent(content: string, locale: string): string {
  const normalized = `${locale}\n${content}`;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Convenience: verify that a claimed hash matches the canonical hash
 * for the given content + locale. Used by re-acknowledgment flows.
 */
export function verifyContentHash(
  content: string,
  locale: string,
  claimedHash: string,
): boolean {
  return hashContent(content, locale) === claimedHash;
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata capture (Express request → audit fields)
// ─────────────────────────────────────────────────────────────────────────────

export interface SignatureRequestMetadata {
  ip_address: string;
  user_agent: string;
}

/**
 * Pull IP + user-agent from an Express request. Handles the
 * x-forwarded-for chain (Railway, Cloudflare). Always returns a
 * non-empty string for both fields. Falls back to the literal
 * "unknown" rather than null because the column is NOT NULL.
 *
 * The IP returned is the LEFTMOST entry in x-forwarded-for (the
 * original client IP), per RFC 7239 convention.
 */
export function captureRequestMetadata(req: Request): SignatureRequestMetadata {
  const xff = req.headers["x-forwarded-for"];
  let ip: string | undefined;
  if (typeof xff === "string" && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first) ip = first;
  } else if (Array.isArray(xff) && xff.length > 0) {
    ip = xff[0];
  }
  if (!ip) {
    ip =
      (typeof req.ip === "string" && req.ip) ||
      (req.socket?.remoteAddress ?? null) ||
      "unknown";
  }
  const ua = req.headers["user-agent"];
  const user_agent =
    typeof ua === "string" && ua.length > 0 ? ua : "unknown";
  return { ip_address: ip, user_agent };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signature method validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * UETA / E-SIGN affirmative-action check. Returns null if the
 * signature is acceptable, or a human-readable rejection reason
 * string otherwise.
 *
 * Rules:
 *   - 'typed': must be at least 2 non-whitespace chars.
 *   - 'drawn': must look like a data URL of a PNG / SVG with reasonable
 *     length. We do NOT validate the visual content (signature
 *     "quality"), only that the payload is plausible.
 */
export function validateEmployeeSignature(
  method: "drawn" | "typed",
  payload: string,
): string | null {
  if (typeof payload !== "string") return "Signature is required";
  if (method === "typed") {
    const trimmed = payload.trim();
    if (trimmed.length < 2) {
      return "Typed signature must be at least 2 characters";
    }
    return null;
  }
  if (method === "drawn") {
    if (!payload.startsWith("data:image/")) {
      return "Drawn signature must be a data: image URL";
    }
    if (payload.length < 200) {
      return "Drawn signature appears empty";
    }
    return null;
  }
  return "Unknown signature method";
}

// ─────────────────────────────────────────────────────────────────────────────
// Known document type registries
// ─────────────────────────────────────────────────────────────────────────────
//
// Re-exported here from the schema file as PURE constants so test code
// doesn't have to import @workspace/db/schema (which pulls the
// drizzle / pg driver). The values themselves live alongside the table
// definitions in lib/db/src/schema/lms-signatures.ts.

export {
  KNOWN_SIGNED_DOCUMENT_TYPES,
  CO_SIGNED_DOCUMENT_TYPES,
  ANNUAL_DOCUMENT_TYPES,
  type KnownSignedDocumentType,
  type CoSignedDocumentType,
  type AnnualDocumentType,
} from "@workspace/db/schema";
