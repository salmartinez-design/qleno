import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireApiKey } from "../../lib/api-auth.js";
import {
  parseLimit, decodeCursor, paginate, countFor, fail,
  companyOf, money, iso, dateOnly, formatAddress,
} from "./_shared.js";

// [ai-access 2026-08-15] Clients and commercial accounts for Qleno Connect.
// Read-only. Design: docs/AI_ACCESS_DESIGN.md §3.
const router = Router();

type Row = Record<string, any>;

function serializeClient(r: Row) {
  return {
    id: Number(r.id),
    name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || null,
    first_name: r.first_name ?? null,
    last_name: r.last_name ?? null,
    company_name: r.company_name ?? null,
    email: r.email ?? null,
    phone: r.phone ?? null,
    address: formatAddress(r.address, r.city, r.state, r.zip),
    zip: r.zip ?? null,
    zone: r.zone_id ? { id: Number(r.zone_id), name: r.zone_name } : null,
    client_type: r.client_type,
    is_active: !!r.is_active,
    frequency: r.frequency ?? null,
    service_type: r.service_type ?? null,
    base_fee: money(r.base_fee),
    allowed_hours: money(r.allowed_hours),
    client_since: dateOnly(r.client_since),
    loyalty_tier: r.loyalty_tier ?? null,
    payment_terms: r.payment_terms ?? null,
    // Free text written by staff and customers. Published because an assistant
    // answering "what do I need to know before this clean" is exactly the job —
    // but see UNTRUSTED_TEXT_FIELDS in _shared.ts: once write scopes exist, this
    // is the field an injected instruction arrives in.
    notes: r.notes ?? null,
    office_notes: r.office_notes ?? null,
    home_access_notes: r.home_access_notes ?? null,
    pets: r.pets ?? null,
    // Deliberately NOT published: alarm_code, and every card/customer id
    // (stripe_customer_id, square_customer_id, card brand and expiry). An alarm
    // code in an assistant's context window is a physical-security fact leaving
    // the building, and the card ids are payment-rail handles no integration
    // needs to read. Neither is recoverable once it has been sent somewhere.
    last_job_date: dateOnly(r.last_job_date),
    job_count: Number(r.job_count ?? 0),
  };
}

const CLIENT_SELECT = sql`
  SELECT
    c.id, c.first_name, c.last_name, c.company_name, c.email, c.phone,
    c.address, c.city, c.state, c.zip,
    c.client_type, c.is_active, c.frequency, c.service_type,
    c.base_fee, c.allowed_hours, c.client_since, c.loyalty_tier, c.payment_terms,
    c.notes, c.office_notes, c.home_access_notes, c.pets,
    z.id AS zone_id, z.name AS zone_name,
    h.last_job_date, COALESCE(h.job_count, 0) AS job_count
  FROM clients c
  LEFT JOIN LATERAL (
    SELECT sz.id, sz.name FROM service_zones sz
    WHERE sz.company_id = c.company_id AND sz.is_active = true
      AND c.zip = ANY(sz.zip_codes)
    ORDER BY sz.id LIMIT 1
  ) z ON true
  LEFT JOIN LATERAL (
    SELECT MAX(j.scheduled_date) AS last_job_date, COUNT(*)::int AS job_count
    FROM jobs j
    WHERE j.client_id = c.id AND j.company_id = c.company_id AND j.status <> 'cancelled'
  ) h ON true
`;

/**
 * GET /api/v1/clients?q&type&active
 *
 * Sorted by id, not by name: an assistant paging through the book needs a stable
 * key, and a rename mid-page would reorder a name sort under it.
 */
router.get("/clients", requireApiKey("rest", "clients:read"), async (req, res) => {
  const companyId = companyOf(req);
  const limit = parseLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);

  const type = typeof req.query.type === "string" ? req.query.type : null;
  if (type && !["residential", "commercial"].includes(type)) {
    fail(res, 400, "invalid_parameter", "type must be residential or commercial");
    return;
  }

  // Absent means "all", which is what an assistant asking about the book wants.
  // Only an explicit true/false filters.
  const activeRaw = req.query.active;
  const active = activeRaw === undefined ? null : String(activeRaw) === "true";

  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  // Escape LIKE metacharacters: a search for "50%" should look for that text,
  // not match every client.
  const like = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;

  const rows = await db.execute(sql`
    ${CLIENT_SELECT}
    WHERE c.company_id = ${companyId}
      ${type ? sql`AND c.client_type = ${type}` : sql``}
      ${active !== null ? sql`AND c.is_active = ${active}` : sql``}
      ${like
        ? sql`AND (c.first_name ILIKE ${like} ESCAPE '\\'
                OR c.last_name ILIKE ${like} ESCAPE '\\'
                OR TRIM(CONCAT(c.first_name, ' ', c.last_name)) ILIKE ${like} ESCAPE '\\'
                OR c.company_name ILIKE ${like} ESCAPE '\\'
                OR c.email ILIKE ${like} ESCAPE '\\'
                OR c.phone ILIKE ${like} ESCAPE '\\')`
        : sql``}
      ${cursor ? sql`AND c.id > ${cursor.id}` : sql``}
    ORDER BY c.id ASC
    LIMIT ${limit + 1}
  `);

  const out = paginate((rows.rows as Row[]).map(serializeClient), limit, (c) => ({ k: null, id: c.id }));
  countFor(res, out.data.length);
  res.json(out);
});

router.get("/clients/:id", requireApiKey("rest", "clients:read"), async (req, res) => {
  const companyId = companyOf(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { fail(res, 400, "invalid_parameter", "id must be a number"); return; }

  const rows = await db.execute(sql`
    ${CLIENT_SELECT}
    WHERE c.company_id = ${companyId} AND c.id = ${id}
    LIMIT 1
  `);
  const row = (rows.rows as Row[])[0];
  if (!row) { fail(res, 404, "not_found", "No client with that id"); return; }
  countFor(res, 1);
  res.json(serializeClient(row));
});

/** GET /api/v1/accounts — commercial accounts (property management, offices). */
router.get("/accounts", requireApiKey("rest", "clients:read"), async (req, res) => {
  const companyId = companyOf(req);
  const limit = parseLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const activeRaw = req.query.active;
  const active = activeRaw === undefined ? null : String(activeRaw) === "true";

  const rows = await db.execute(sql`
    SELECT
      a.id, a.account_name, a.account_type, a.payment_method, a.invoice_frequency,
      a.payment_terms_days, a.is_active, a.notes, a.created_at,
      COALESCE(p.property_count, 0) AS property_count,
      COALESCE(o.open_invoice_count, 0) AS open_invoice_count,
      COALESCE(o.open_invoice_total, 0) AS open_invoice_total
    FROM accounts a
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS property_count FROM account_properties ap
      WHERE ap.account_id = a.id AND ap.is_active = true
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS open_invoice_count, SUM(i.total) AS open_invoice_total
      FROM invoices i
      WHERE i.account_id = a.id AND i.status NOT IN ('paid', 'void')
    ) o ON true
    WHERE a.company_id = ${companyId}
      ${active !== null ? sql`AND a.is_active = ${active}` : sql``}
      ${cursor ? sql`AND a.id > ${cursor.id}` : sql``}
    ORDER BY a.id ASC
    LIMIT ${limit + 1}
  `);

  const mapped = (rows.rows as Row[]).map((r) => ({
    id: Number(r.id),
    name: r.account_name,
    account_type: r.account_type,
    payment_method: r.payment_method,
    invoice_frequency: r.invoice_frequency,
    payment_terms_days: Number(r.payment_terms_days ?? 0),
    is_active: !!r.is_active,
    property_count: Number(r.property_count ?? 0),
    open_invoice_count: Number(r.open_invoice_count ?? 0),
    open_invoice_total: money(r.open_invoice_total) ?? 0,
    notes: r.notes ?? null,
    created_at: iso(r.created_at),
  }));

  const out = paginate(mapped, limit, (a) => ({ k: null, id: a.id }));
  countFor(res, out.data.length);
  res.json(out);
});

/** GET /api/v1/accounts/:id/properties — the buildings under one commercial account. */
router.get("/accounts/:id/properties", requireApiKey("rest", "clients:read"), async (req, res) => {
  const companyId = companyOf(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { fail(res, 400, "invalid_parameter", "id must be a number"); return; }

  // Confirm the account belongs to this tenant before returning its children.
  // Filtering the properties by company_id alone would be correct today, but
  // this way a mis-scoped property row can never surface under someone else's
  // account id either.
  const owner = await db.execute(sql`
    SELECT 1 FROM accounts WHERE id = ${id} AND company_id = ${companyId} LIMIT 1
  `);
  if (owner.rows.length === 0) { fail(res, 404, "not_found", "No account with that id"); return; }

  const rows = await db.execute(sql`
    SELECT ap.id, ap.property_name, ap.address, ap.city, ap.state, ap.zip,
           ap.property_type, ap.unit_count, ap.is_active, ap.access_notes, ap.notes,
           z.id AS zone_id, z.name AS zone_name
    FROM account_properties ap
    LEFT JOIN LATERAL (
      SELECT sz.id, sz.name FROM service_zones sz
      WHERE sz.company_id = ap.company_id AND sz.is_active = true
        AND (sz.id = ap.zone_id OR ap.zip = ANY(sz.zip_codes))
      ORDER BY (sz.id = ap.zone_id) DESC, sz.id LIMIT 1
    ) z ON true
    WHERE ap.account_id = ${id} AND ap.company_id = ${companyId}
    ORDER BY ap.id ASC
  `);

  const data = (rows.rows as Row[]).map((r) => ({
    id: Number(r.id),
    name: r.property_name ?? null,
    address: formatAddress(r.address, r.city, r.state, r.zip),
    zip: r.zip ?? null,
    zone: r.zone_id ? { id: Number(r.zone_id), name: r.zone_name } : null,
    property_type: r.property_type,
    unit_count: r.unit_count === null ? null : Number(r.unit_count),
    is_active: !!r.is_active,
    access_notes: r.access_notes ?? null,
    notes: r.notes ?? null,
  }));
  countFor(res, data.length);
  res.json({ account_id: id, data });
});

export default router;
