import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// [ai-access-superadmin 2026-08-16] Which tenants may one credential read?
//
// THE RULE THIS FILE EXISTS TO PROTECT
// ------------------------------------
// Cross-tenant reach is implemented by letting the resolved company_id VARY per
// request. It is NOT implemented by widening or removing the company filter.
//
// That distinction is the whole design. Qleno's tenant isolation is one clause —
// `WHERE company_id = $1` — repeated across every query in the read API, and it
// was proven correct for a single scalar. The tempting version of this feature
// turns that scalar into an array and rewrites ~25 handlers to match; each
// rewrite is a fresh chance to drop the clause, and a dropped clause does not
// throw, it just quietly returns another business's customers. So instead every
// request still resolves to exactly ONE company before it reaches a query, and
// not a single handler changes. An assistant that wants two tenants asks twice.
//
// A second, quieter benefit: because each call names one company, the activity
// log still records which tenant was actually read. An array would have collapsed
// that into "some of them".
//
// THE FOUR GATES, in the order they apply:
//   1. companies.api_access_enabled — each tenant's own switch, honored here for
//      EVERY tenant in the list, including under a super-admin credential. A
//      business that has not turned this on is not readable by anyone through
//      this door. Platform authority does not override a tenant's off switch.
//   2. users.is_super_admin / role — read LIVE, never frozen into a token.
//   3. oauth_grants.all_companies — what the approver actually consented to.
//   4. the granted scopes — unchanged, checked in routes/mcp.ts.

export interface CompanyRef {
  id: number;
  name: string;
}

/** Does this live user row carry platform-wide authority? */
export function isSuperAdminRow(row: { role?: unknown; is_super_admin?: unknown }): boolean {
  // Two representations because both exist in production: the dedicated column,
  // and the legacy `role = 'super_admin'` that predates it. routes/admin.ts
  // accepts either, and disagreeing with it here would mean a person who can
  // reach the admin console cannot reach it through an assistant.
  return row.is_super_admin === true || row.is_super_admin === "t" || String(row.role) === "super_admin";
}

/**
 * The companies this credential may read, home company first.
 *
 * Returns exactly one entry unless the credential is a live super-admin grant
 * that was approved for platform-wide reach. The home company is always present
 * and always first: the door already verified it is enabled, and an assistant
 * that omits the `company` argument must land somewhere predictable.
 */
export async function readableCompanies(
  homeCompanyId: number,
  allCompanies: boolean,
): Promise<CompanyRef[]> {
  if (!allCompanies) {
    const rows: any = await db.execute(sql`
      SELECT id, name FROM companies WHERE id = ${homeCompanyId} LIMIT 1
    `);
    const r = (rows.rows ?? rows)[0];
    return r ? [{ id: Number(r.id), name: String(r.name) }] : [];
  }

  // Gate 1, applied to every tenant and not just the home one. A company that
  // has not switched AI & API access on is absent from this list entirely, so
  // there is no id a caller could name to reach it.
  const rows: any = await db.execute(sql`
    SELECT id, name FROM companies
     WHERE api_access_enabled IS TRUE
     ORDER BY (id = ${homeCompanyId}) DESC, name ASC
  `);
  return (rows.rows ?? rows).map((r: any) => ({ id: Number(r.id), name: String(r.name) }));
}

export type TargetFailure = { error: string };

/**
 * Turn a caller-supplied `company` argument into a company id it is allowed to read.
 *
 * The argument is a HINT, never an authority: it is matched against the list
 * above, which was computed from the credential. An id that is not in the list —
 * because the tenant is switched off, or because this grant is single-tenant —
 * is refused with the same message either way. Telling a caller "that company
 * exists but you may not read it" would make this endpoint a directory of every
 * business on Qleno.
 *
 * Omitted means the home company, which is what every existing single-tenant
 * connection sends and why nothing changes for them.
 */
export function resolveTargetCompany(
  arg: unknown,
  allowed: CompanyRef[],
  homeCompanyId: number,
): { companyId: number; company: CompanyRef } | TargetFailure {
  const home = allowed.find((c) => c.id === homeCompanyId) ?? allowed[0];
  if (!home) return { error: "No company on this connection is currently enabled for AI access." };

  if (arg === undefined || arg === null || arg === "") {
    return { companyId: home.id, company: home };
  }

  if (allowed.length <= 1) {
    return {
      error:
        `This connection covers ${home.name} only, so it cannot be pointed at another company. ` +
        `Drop the company argument and ask again.`,
    };
  }

  const raw = String(arg).trim();

  // Numeric first: an id is unambiguous and is what list_companies hands back.
  if (/^\d+$/.test(raw)) {
    const byId = allowed.find((c) => c.id === Number(raw));
    return byId
      ? { companyId: byId.id, company: byId }
      : { error: `No company with id ${raw} is readable here. Call list_companies for the ones that are.` };
  }

  // Then by name, because a model that heard "Schaumburg" in a question should
  // not have to guess an integer. Exact match wins outright so that a company
  // whose name is a substring of another's is still reachable.
  const lower = raw.toLowerCase();
  const exact = allowed.filter((c) => c.name.toLowerCase() === lower);
  const hits = exact.length > 0 ? exact : allowed.filter((c) => c.name.toLowerCase().includes(lower));

  if (hits.length === 1) return { companyId: hits[0].id, company: hits[0] };
  if (hits.length === 0) {
    return { error: `No readable company matches "${raw}". Call list_companies for the exact names.` };
  }
  // Ambiguity is refused rather than guessed. Picking the first match would
  // answer a question about one business with another business's numbers, and
  // nothing downstream would look wrong.
  return {
    error:
      `"${raw}" matches more than one company (${hits.map((c) => c.name).join(", ")}). ` +
      `Pass the numeric id from list_companies instead.`,
  };
}
