/**
 * LMS Signatures — DB-touching helpers.
 *
 * Separated from `lms-signatures.ts` so the pure helpers (hashing,
 * request metadata, signature validation) can be unit-tested without
 * pulling drizzle into the test process. The pure file imports
 * nothing from `@workspace/db`; this file does.
 *
 * Functions here are called from route handlers in PR #2+ when each
 * signed document gets wired up (handbook, code of conduct, drug &
 * alcohol, video / photo release, non-solicit, supply kit, social
 * media).
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  lmsDocumentVersionsTable,
  usersTable,
  type LmsDocumentVersion,
} from "@workspace/db/schema";
import { hashContent } from "./lms-signatures.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tenant owner lookup (default co-signer for legal documents)
// ─────────────────────────────────────────────────────────────────────────────

export interface TenantOwnerSummary {
  user_id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

/**
 * Return the user designated as the Phes representative co-signer for
 * a tenant. Default: the single user with role='owner' in the tenant.
 *
 * Per spec: configurable "owner of the tenant" lookup. For now there's
 * exactly one owner per tenant (Phes = salmartinez@phes.io). If a
 * future tenant has multiple owners, this picks the most recently
 * created one. Adjust here when that ambiguity becomes real.
 *
 * Returns null when no owner is found (defensive — should never
 * happen in production but the caller must handle it).
 */
export async function getTenantOwnerForSignature(
  companyId: number,
): Promise<TenantOwnerSummary | null> {
  const rows = await db
    .select({
      user_id: usersTable.id,
      email: usersTable.email,
      first_name: usersTable.first_name,
      last_name: usersTable.last_name,
    })
    .from(usersTable)
    .where(
      and(eq(usersTable.company_id, companyId), eq(usersTable.role, "owner")),
    )
    .orderBy(desc(usersTable.created_at))
    .limit(1);
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Document version registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find or create the lms_document_versions row for the given
 * (document_type, locale, content). Idempotent: identical content
 * always resolves to the same row.
 *
 * Use cases:
 *   - At signing time, the route calls this with the rendered content
 *     the user saw. The returned row's id + version_hash are stamped
 *     onto lms_signed_documents.
 *   - At policy-change time, the office UI calls this with the new
 *     content; if it produces a new hash, the row is created and can
 *     be marked is_material=true to trigger forced re-ack.
 *
 * @param createdByUserId  Optional user id that introduced this
 *                         version. Null for system-generated
 *                         (cold-start seed) versions.
 * @param isMaterial       Marks the new version as a material change
 *                         when true. ONLY honored on first insert;
 *                         on a hit (existing row) the flag is left
 *                         alone. Caller wanting to flip an existing
 *                         row to material should use markVersionMaterial.
 */
export async function getOrCreateDocumentVersion(args: {
  documentType: string;
  locale: string;
  contentHtml: string;
  createdByUserId?: number | null;
  isMaterial?: boolean;
  notes?: string;
}): Promise<LmsDocumentVersion> {
  const versionHash = hashContent(args.contentHtml, args.locale);

  const existing = await db
    .select()
    .from(lmsDocumentVersionsTable)
    .where(
      and(
        eq(lmsDocumentVersionsTable.document_type, args.documentType),
        eq(lmsDocumentVersionsTable.locale, args.locale),
        eq(lmsDocumentVersionsTable.version_hash, versionHash),
      ),
    )
    .limit(1);

  if (existing[0]) return existing[0];

  const inserted = await db
    .insert(lmsDocumentVersionsTable)
    .values({
      document_type: args.documentType,
      locale: args.locale,
      version_hash: versionHash,
      content_html: args.contentHtml,
      is_material: args.isMaterial ?? false,
      notes: args.notes ?? null,
      created_by_user_id: args.createdByUserId ?? null,
      effective_at: new Date(),
    })
    .onConflictDoNothing({
      target: [
        lmsDocumentVersionsTable.document_type,
        lmsDocumentVersionsTable.locale,
        lmsDocumentVersionsTable.version_hash,
      ],
    })
    .returning();

  if (inserted[0]) return inserted[0];

  // Race: another caller inserted between our SELECT and INSERT.
  const after = await db
    .select()
    .from(lmsDocumentVersionsTable)
    .where(
      and(
        eq(lmsDocumentVersionsTable.document_type, args.documentType),
        eq(lmsDocumentVersionsTable.locale, args.locale),
        eq(lmsDocumentVersionsTable.version_hash, versionHash),
      ),
    )
    .limit(1);
  if (!after[0]) {
    throw new Error(
      `getOrCreateDocumentVersion: failed to find or create version for ` +
        `${args.documentType}/${args.locale}`,
    );
  }
  return after[0];
}

/**
 * Find the currently active (most recent) version for a document type
 * in a locale. Returns null if no version has been registered yet.
 * Used by the signature page to determine which content to render.
 */
export async function getLatestDocumentVersion(
  documentType: string,
  locale: string,
): Promise<LmsDocumentVersion | null> {
  const rows = await db
    .select()
    .from(lmsDocumentVersionsTable)
    .where(
      and(
        eq(lmsDocumentVersionsTable.document_type, documentType),
        eq(lmsDocumentVersionsTable.locale, locale),
      ),
    )
    .orderBy(desc(lmsDocumentVersionsTable.effective_at))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Find a specific document version by its hash. Returns null if no
 * such version exists. Used by audit / re-render flows that need to
 * reproduce exactly what was signed.
 */
export async function getDocumentVersionByHash(
  documentType: string,
  locale: string,
  versionHash: string,
): Promise<LmsDocumentVersion | null> {
  const rows = await db
    .select()
    .from(lmsDocumentVersionsTable)
    .where(
      and(
        eq(lmsDocumentVersionsTable.document_type, documentType),
        eq(lmsDocumentVersionsTable.locale, locale),
        eq(lmsDocumentVersionsTable.version_hash, versionHash),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Mark a document version as material AFTER it was created. This is
 * the admin-edit path that triggers a fan-out into lms_pending_re_ack
 * (handled by a separate worker in the annual-re-ack PR). Idempotent.
 */
export async function markVersionMaterial(versionId: number): Promise<void> {
  await db
    .update(lmsDocumentVersionsTable)
    .set({ is_material: true })
    .where(eq(lmsDocumentVersionsTable.id, versionId));
}
