/**
 * Who is this tenant? — the one place the product asks.
 *
 * Sal, 2026-08-19: "Phes is a tenant not the crm."
 *
 * Qleno grew out of running one cleaning company, and that company's identity
 * leaked into the product as literals: `company_name || "Phes"` in twenty
 * customer-facing places, `info@phes.io` and two Chicago phone numbers compiled
 * into branchRouter, `noreply@phes.io` as the sending address of last resort.
 * Every one of those is correct for exactly one customer and wrong for the next
 * one who signs up — and wrong in the worst possible place, on an email a
 * stranger's client receives.
 *
 * ── THE FALLBACKS WERE NEVER LOAD-BEARING ────────────────────────────────────
 *
 * `companies.name` is NOT NULL. There is no row in the table without a name, so
 * `co.name || "Phes"` can only fire when the query FORGOT TO JOIN the company —
 * a bug the fallback was quietly hiding by printing another tenant's name over
 * it. Removing them is not a behaviour change for a correct call site; it turns
 * a silent mislabel into a visible missing join.
 *
 * ── WHAT REPLACES THEM ───────────────────────────────────────────────────────
 *
 * One resolver, reading the tenant's own record. Everything a customer can see
 * comes from here: the company's name, phone, reply-to, sending address, logo
 * and brand colour. Where a tenant runs several locations, the branch's own
 * phone and SMS number win over the company's — that is what `branches` is for,
 * and it is already how Phes's two numbers are meant to be stored.
 *
 * Nothing in here has a Phes-shaped default. When a tenant has not filled a
 * field in, the caller gets null and decides — omitting a phone number is
 * honest; printing someone else's is not.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface TenantBrand {
  company_id: number;
  /** companies.name — NOT NULL, so always a real name. */
  name: string;
  /** Branch phone when the job/booking resolves to one, else the company's. */
  phone: string | null;
  /** "(773) 706-6000" style, derived — never stored twice. */
  phone_formatted: string | null;
  /** Where a customer's reply should land. */
  reply_to: string | null;
  /** The envelope From. Null when the tenant has not configured a sender. */
  from_address: string | null;
  logo_url: string | null;
  brand_color: string | null;
  /** Branch-level SMS sender, falling back to the company's. */
  sms_from: string | null;
  /** Which branch answered, when one did. */
  branch_id: number | null;
  branch_name: string | null;
}

/** "7737066000" / "773-706-6000" → "(773) 706-6000". Anything else, unchanged. */
export function formatPhone(raw: string | null | undefined): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (ten.length !== 10) return raw?.trim() || null;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

const clean = (v: unknown) => {
  const s = String(v ?? "").trim();
  return s ? s : null;
};

/**
 * Resolve a tenant's public identity.
 *
 * `zip` routes to a branch when the tenant has zones mapped — a booking in a
 * Schaumburg zip answers with Schaumburg's phone and Schaumburg's SMS number,
 * because that is the number the customer will call back.
 */
export async function resolveTenantBrand(
  companyId: number,
  opts: { zip?: string | null; branchId?: number | null } = {},
): Promise<TenantBrand | null> {
  const rows = (await db.execute(sql`
    SELECT c.id, c.name, c.phone, c.email, c.email_from_address,
           c.logo_url, c.brand_color, c.twilio_from_number
      FROM companies c
     WHERE c.id = ${companyId}
     LIMIT 1`) as any).rows;
  const co = rows[0];
  // A missing company is a caller bug. Returning a Phes-shaped object here is
  // exactly the habit this module exists to end — the caller gets null and has
  // to deal with it.
  if (!co) return null;

  // Branch, when one is asked for or when the zip maps to one. `is_default`
  // is NOT used as a catch-all: a zip outside every zone belongs to the
  // company, not to whichever branch happens to be marked default.
  let branch: any = null;
  try {
    if (opts.branchId != null) {
      branch = (await db.execute(sql`
        SELECT id, name, phone, twilio_from_number FROM branches
         WHERE id = ${opts.branchId} AND company_id = ${companyId} AND is_active LIMIT 1`) as any).rows[0] ?? null;
    } else if (clean(opts.zip)) {
      const z = String(opts.zip).replace(/\D/g, "").slice(0, 5);
      if (z.length === 5) {
        // service_zones.branch_id is the link. It is added and backfilled at
        // boot (ensureZoneBranchLink) from the legacy `location` slug — a TEXT
        // column whose DEFAULT was literally 'oak_lawn', i.e. one tenant's
        // branch name compiled into every other tenant's schema. The slug stays
        // for now because reports read it; the foreign key is what this asks.
        branch = (await db.execute(sql`
          SELECT b.id, b.name, b.phone, b.twilio_from_number
            FROM service_zones z
            JOIN branches b ON b.id = z.branch_id AND b.company_id = z.company_id
           WHERE z.company_id = ${companyId} AND z.is_active = true
             AND z.branch_id IS NOT NULL
             AND z.zip_codes @> ARRAY[${z}]::text[]
             AND b.is_active
           LIMIT 1`) as any).rows[0] ?? null;
      }
    }
  } catch {
    // A tenant without zones or branches configured is normal, not an error.
    branch = null;
  }

  const phone = clean(branch?.phone) ?? clean(co.phone);
  return {
    company_id: Number(co.id),
    name: String(co.name),
    phone,
    phone_formatted: formatPhone(phone),
    reply_to: clean(co.email),
    from_address: clean(co.email_from_address),
    logo_url: clean(co.logo_url),
    brand_color: clean(co.brand_color),
    sms_from: clean(branch?.twilio_from_number) ?? clean(co.twilio_from_number),
    branch_id: branch ? Number(branch.id) : null,
    branch_name: clean(branch?.name),
  };
}

/**
 * The `"Name <address>"` header, or null when the tenant has no sending address
 * configured yet.
 *
 * Null rather than a house default on purpose. Sending a tenant's mail from
 * another tenant's domain is worse than not sending it: it fails SPF/DKIM,
 * lands in spam, and puts a stranger's brand in the customer's inbox. The
 * caller logs and skips.
 */
export function emailFrom(brand: TenantBrand | null): string | null {
  if (!brand?.from_address) return null;
  return `${brand.name} <${brand.from_address}>`;
}
