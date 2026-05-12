/**
 * LMS Signatures — DB-touching helpers.
 *
 * Separated from `lms-signatures.ts` so the pure helpers (hashing,
 * request metadata, signature validation) can be unit-tested without
 * pulling drizzle into the test process. The pure file imports
 * nothing from `@workspace/db`; this file does.
 *
 * Tenant isolation: every version + signature query is scoped by
 * `company_id`. Two tenants with identical handbook text get two
 * separate version rows, two separate signed_document chains, and
 * two separate audit trails. Deleting one tenant's history can
 * never touch another's.
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
 * Configurable per spec: changing a user's role to 'owner' makes them
 * the default co-signer. For now there's exactly one owner per tenant
 * (Phes = salmartinez@phes.io). If a future tenant has multiple
 * owners, this picks the most recently created one.
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
// Document version registry — TENANT SCOPED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find or create the lms_document_versions row for the given
 * (company_id, document_type, locale, content). Idempotent: identical
 * content in the same tenant always resolves to the same row.
 *
 * Two tenants with identical content get DIFFERENT rows. The unique
 * index is on (company_id, document_type, locale, version_hash) so
 * tenant A's audit chain cannot accidentally consume tenant B's row.
 */
export async function getOrCreateDocumentVersion(args: {
  companyId: number;
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
        eq(lmsDocumentVersionsTable.company_id, args.companyId),
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
      company_id: args.companyId,
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
        lmsDocumentVersionsTable.company_id,
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
        eq(lmsDocumentVersionsTable.company_id, args.companyId),
        eq(lmsDocumentVersionsTable.document_type, args.documentType),
        eq(lmsDocumentVersionsTable.locale, args.locale),
        eq(lmsDocumentVersionsTable.version_hash, versionHash),
      ),
    )
    .limit(1);
  if (!after[0]) {
    throw new Error(
      `getOrCreateDocumentVersion: failed to find or create version for ` +
        `company=${args.companyId} ${args.documentType}/${args.locale}`,
    );
  }
  return after[0];
}

/**
 * Find the currently active (most recent) version for a document
 * type in a locale, for a specific tenant. Returns null if no
 * version has been registered yet for that tenant.
 */
export async function getLatestDocumentVersion(
  companyId: number,
  documentType: string,
  locale: string,
): Promise<LmsDocumentVersion | null> {
  const rows = await db
    .select()
    .from(lmsDocumentVersionsTable)
    .where(
      and(
        eq(lmsDocumentVersionsTable.company_id, companyId),
        eq(lmsDocumentVersionsTable.document_type, documentType),
        eq(lmsDocumentVersionsTable.locale, locale),
      ),
    )
    .orderBy(desc(lmsDocumentVersionsTable.effective_at))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Find a specific document version by its hash, scoped to a tenant.
 * Used by audit / re-render flows that need to reproduce exactly
 * what was signed.
 */
export async function getDocumentVersionByHash(
  companyId: number,
  documentType: string,
  locale: string,
  versionHash: string,
): Promise<LmsDocumentVersion | null> {
  const rows = await db
    .select()
    .from(lmsDocumentVersionsTable)
    .where(
      and(
        eq(lmsDocumentVersionsTable.company_id, companyId),
        eq(lmsDocumentVersionsTable.document_type, documentType),
        eq(lmsDocumentVersionsTable.locale, locale),
        eq(lmsDocumentVersionsTable.version_hash, versionHash),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Mark a document version as material AFTER it was created.
 * Triggers a fan-out into lms_pending_re_ack (handled by a separate
 * worker in the annual-re-ack PR). Idempotent. Tenant-scoped by the
 * version's own company_id so admins from tenant A cannot mutate
 * tenant B's versions even if they learn the row id.
 */
export async function markVersionMaterial(
  companyId: number,
  versionId: number,
): Promise<void> {
  await db
    .update(lmsDocumentVersionsTable)
    .set({ is_material: true })
    .where(
      and(
        eq(lmsDocumentVersionsTable.id, versionId),
        eq(lmsDocumentVersionsTable.company_id, companyId),
      ),
    );
}
