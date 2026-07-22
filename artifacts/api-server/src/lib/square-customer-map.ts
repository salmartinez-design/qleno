// [square-map 2026-07-22] Square ↔ Qleno customer map — build + refresh.
//
// READ-ONLY AGAINST SQUARE. This module calls only GET /v2/customers and
// GET /v2/cards. It NEVER creates a payment, never merges Square customers,
// never mutates anything in Square, and never touches QuickBooks. Storing a
// card_id here is a lookup key for reconciliation, NOT authorisation to charge
// — charging stays office-triggered in charge-invoice.ts.
//
// WHAT IT DOES
//   1. Pulls every Square customer + every card on file.
//   2. Matches each Square customer to a Qleno client, or to an account
//      (+ the specific property, for the one-Square-record-per-building
//      pattern that property-management accounts use).
//   3. Writes the result to square_customer_map, upserted on
//      (company_id, square_customer_id) so re-running is safe and idempotent.
//   4. Mirrors CONFIDENT links onto clients.square_customer_id /
//      accounts.square_customer_id — but only into NULLs. An existing value is
//      never overwritten.
//
// MATCH PRIORITY (first rule that produces a UNIQUE answer wins):
//   existing_link → property_address → email → name → address
// Anything ambiguous, duplicated, or fuzzy lands in status='needs_review'
// instead of being auto-linked. The matcher never guesses.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const SQUARE_API = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-10-17";

export type SquareCustomer = {
  id: string;
  given_name?: string; family_name?: string; nickname?: string;
  company_name?: string; email_address?: string; phone_number?: string;
  address?: { address_line_1?: string; address_line_2?: string; locality?: string; administrative_district_level_1?: string; postal_code?: string };
  created_at?: string;
};
export type SquareCard = {
  id: string; customer_id?: string; enabled?: boolean;
  card_brand?: string; last_4?: string; exp_month?: number; exp_year?: number;
};

export type QlClient = {
  id: number; company_id: number; first_name: string; last_name: string;
  company_name: string | null; email: string | null; address: string | null;
  city: string | null; zip: string | null; account_id: number | null;
  is_active: boolean; square_customer_id: string | null;
};
export type QlAccount = { id: number; company_id: number; account_name: string; billing_contact_id: number | null; square_customer_id: string | null; is_active: boolean };
export type QlProperty = { id: number; account_id: number; company_id: number; property_name: string | null; address: string; city: string | null; zip: string | null; is_active: boolean };

export type MapRow = {
  square_customer_id: string;
  square_customer_name: string | null;
  square_email: string | null;
  square_company_name: string | null;
  square_phone: string | null;
  square_address: string | null;
  square_postal: string | null;
  square_created_at: string | null;
  client_id: number | null;
  account_id: number | null;
  account_property_id: number | null;
  square_card_id: string | null;
  card_brand: string | null;
  card_last4: string | null;
  card_exp: string | null;
  card_count: number;
  status: "linked" | "needs_review" | "unmatched";
  match_method: string | null;
  match_score: number | null;
  review_reason: string | null;
  email_mismatch: boolean;
  candidates: unknown;
};

// ---------------------------------------------------------------- normalizers

const normEmail = (s?: string | null) => (s ?? "").trim().toLowerCase();

const normName = (s?: string | null) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const STREET_WORDS: Record<string, string> = {
  avenue: "ave", av: "ave", street: "st", road: "rd", drive: "dr", court: "ct",
  place: "pl", boulevard: "blvd", lane: "ln", terrace: "ter", parkway: "pkwy",
  circle: "cir", highway: "hwy", square: "sq", north: "n", south: "s",
  east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
};

// Canonical street form so "11810 South Komensky Avenue" == "11810 s Komensky Ave".
// Deliberately lossy on suffixes/directionals — those are the parts that differ
// between Square's free-text names and Qleno's structured address column.
export function normAddr(s?: string | null): string {
  const base = (s ?? "").toLowerCase().replace(/[^a-z0-9\- ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!base) return "";
  return base.split(" ").map(w => STREET_WORDS[w] ?? w).join(" ").trim();
}

const DIRECTIONALS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw"]);

// Same as normAddr but with directionals dropped, so "11810 South Komensky Ave"
// and "11810 Komensky Ave" compare equal. Both sides of an address comparison
// MUST use this form — comparing a directional-stripped key against a
// directional-bearing string silently never matches.
export function normAddrLoose(s?: string | null): string {
  return normAddr(s).split(" ").filter(t => !DIRECTIONALS.has(t)).join(" ").trim();
}

// The leading house number + first street token — a cheap, high-signal key for
// "does this free-text blob mention this property?".
function addrKey(s?: string | null): string {
  const n = normAddrLoose(s);
  const m = n.match(/^(\d+[a-z]?(?:-\d+)?)\s+(.+)$/);
  if (!m) return "";
  const [, num, rest] = m;
  return `${num} ${rest.split(" ").slice(0, 2).join(" ")}`.trim();
}

const sqName = (s: SquareCustomer) =>
  [s.given_name, s.family_name].filter(Boolean).join(" ").trim() || s.nickname || s.company_name || "";

const sqAddrLine = (s: SquareCustomer) => s.address?.address_line_1 ?? null;

// Placeholder / shared-inbox emails that must never drive a match. Detected
// structurally: an email carried by Square records with 2+ DISTINCT surnames is
// an office inbox, not a person (admin@phes.io sits on 6 unrelated records).
export function findGenericEmails(customers: SquareCustomer[]): Set<string> {
  const byEmail = new Map<string, Set<string>>();
  for (const s of customers) {
    const e = normEmail(s.email_address);
    if (!e) continue;
    if (!byEmail.has(e)) byEmail.set(e, new Set());
    byEmail.get(e)!.add(normName(s.family_name) || normName(sqName(s)));
  }
  const generic = new Set<string>();
  for (const [e, surnames] of byEmail) if (surnames.size >= 2) generic.add(e);
  // Belt and braces: our own inboxes are never a customer identity.
  for (const e of ["admin@phes.io", "info@phes.io", "sample@gmail.com", "test@test.com"]) generic.add(e);
  return generic;
}

// Square records that duplicate each other on name+email. Per the build rules
// these ALWAYS go to review — never auto-linked, even when the email is unique
// enough to match, because we cannot tell which twin the payment came from.
export function findDuplicateGroups(customers: SquareCustomer[]): Map<string, string[]> {
  const groups = new Map<string, SquareCustomer[]>();
  for (const s of customers) {
    const key = `${normName(s.given_name)}|${normName(s.family_name)}|${normEmail(s.email_address)}`;
    if (key === "||") continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const dup = new Map<string, string[]>();
  for (const [, v] of groups) {
    if (v.length < 2) continue;
    const ids = v.map(x => x.id);
    for (const id of ids) dup.set(id, ids);
  }
  return dup;
}

// ------------------------------------------------------------------- matching

export function buildMatchPlan(input: {
  companyId: number;
  customers: SquareCustomer[];
  cards: SquareCard[];
  clients: QlClient[];
  accounts: QlAccount[];
  properties: QlProperty[];
}): MapRow[] {
  const { companyId, customers, cards, clients, accounts, properties } = input;

  const clientsCo = clients.filter(c => c.company_id === companyId);
  const accountsCo = accounts.filter(a => a.company_id === companyId);
  const propsCo = properties.filter(p => p.company_id === companyId);

  const generic = findGenericEmails(customers);
  const dupGroups = findDuplicateGroups(customers);

  // ---- indexes over the Qleno side
  const byExistingSquareId = new Map<string, QlClient[]>();
  const byEmail = new Map<string, QlClient[]>();
  const byFullName = new Map<string, QlClient[]>();
  const byClientAddr = new Map<string, QlClient[]>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { if (!m.has(k)) m.set(k, []); m.get(k)!.push(v); };

  for (const c of clientsCo) {
    if (c.square_customer_id) push(byExistingSquareId, c.square_customer_id, c);
    const e = normEmail(c.email); if (e) push(byEmail, e, c);
    const n = normName(`${c.first_name} ${c.last_name}`); if (n) push(byFullName, n, c);
    const a = addrKey(c.address); if (a) push(byClientAddr, a, c);
  }
  const byPropAddr = new Map<string, QlProperty[]>();
  for (const p of propsCo) { const a = addrKey(p.address); if (a) push(byPropAddr, a, p); }

  // Square-side name index, to detect "two Square records share this name".
  const sqByName = new Map<string, SquareCustomer[]>();
  for (const s of customers) { const n = normName(sqName(s)); if (n) push(sqByName, n, s); }

  // ---- cards, newest-usable first
  const cardsByCustomer = new Map<string, SquareCard[]>();
  for (const k of cards) { if (k.customer_id) push(cardsByCustomer, k.customer_id, k); }

  const pickActive = (list: QlClient[]) => {
    const active = list.filter(c => c.is_active);
    return active.length === 1 ? active[0] : null;
  };

  const rows: MapRow[] = [];

  for (const s of customers) {
    const custCards = cardsByCustomer.get(s.id) ?? [];
    const enabled = custCards.filter(k => k.enabled !== false);
    const primary = enabled[0] ?? custCards[0] ?? null;
    const email = normEmail(s.email_address);
    const name = sqName(s);

    const row: MapRow = {
      square_customer_id: s.id,
      square_customer_name: name || null,
      square_email: s.email_address ?? null,
      square_company_name: s.company_name ?? null,
      square_phone: s.phone_number ?? null,
      square_address: sqAddrLine(s),
      square_postal: s.address?.postal_code ?? null,
      square_created_at: s.created_at ?? null,
      client_id: null, account_id: null, account_property_id: null,
      square_card_id: primary?.id ?? null,
      card_brand: primary?.card_brand ?? null,
      card_last4: primary?.last_4 ?? null,
      card_exp: primary ? `${String(primary.exp_month ?? "").padStart(2, "0")}/${primary.exp_year ?? ""}` : null,
      card_count: enabled.length,
      status: "unmatched",
      match_method: null, match_score: null, review_reason: null,
      email_mismatch: false, candidates: null,
    };

    const link = (
      target: { client_id?: number; account_id?: number; account_property_id?: number },
      method: string, score: number,
    ) => {
      row.client_id = target.client_id ?? null;
      row.account_id = target.account_id ?? null;
      row.account_property_id = target.account_property_id ?? null;
      row.match_method = method;
      row.match_score = score;
      row.status = "linked";
    };
    const review = (reason: string, candidates?: unknown, method?: string) => {
      row.status = "needs_review";
      row.review_reason = reason;
      if (method) row.match_method = method;
      if (candidates) row.candidates = candidates;
    };

    // --- 0. Square-flagged / detected duplicates always go to review.
    const dupIds = dupGroups.get(s.id);

    // --- 1. Property-address match → an account + its specific property.
    // This is the property-management pattern: Square keeps one customer per
    // building, named/addressed after that building.
    //
    // Runs BEFORE existing_link on purpose. The MaidCentral import created a
    // throwaway per-building CLIENT stub for each of these (cl#1265..1269 for
    // Cucci) and pointed square_customer_id at it. Those stubs are not the
    // billing entity — the ACCOUNT is. A building-address hit is high
    // specificity (house number + street, unique across all properties), so
    // when it fires it is a strictly better answer than the legacy stub, and
    // it is what consolidates Cucci's four Square records onto one account.
    {
      const blob = [name, s.company_name, sqAddrLine(s)].filter(Boolean).join(" ");
      const hits: QlProperty[] = [];
      for (const [key, plist] of byPropAddr) {
        if (!key) continue;
        if (normAddrLoose(blob).includes(key)) hits.push(...plist);
      }
      const uniqueProps = Array.from(new Map(hits.map(p => [p.id, p])).values());
      const acctIds = new Set(uniqueProps.map(p => p.account_id));

      if (uniqueProps.length === 1) {
        link({ account_id: uniqueProps[0].account_id, account_property_id: uniqueProps[0].id }, "property_address", 95);
      } else if (uniqueProps.length > 1 && acctIds.size === 1) {
        // One Square record covering SEVERAL buildings of the same account
        // (Cucci's master record lists three). The account is certain, the
        // property is not — link the account, leave the property for review.
        link({ account_id: [...acctIds][0] }, "property_address", 85);
        row.review_reason = `Square record spans ${uniqueProps.length} properties of this account — confirm which property (or treat as the account-level billing record)`;
        row.candidates = uniqueProps.map(p => ({ property_id: p.id, address: p.address, name: p.property_name }));
      } else if (uniqueProps.length > 1) {
        review(
          `Address matches ${uniqueProps.length} properties across ${acctIds.size} accounts`,
          uniqueProps.map(p => ({ property_id: p.id, account_id: p.account_id, address: p.address })),
          "property_address",
        );
      }
    }

    // --- 2. Existing link (a prior import already wrote square_customer_id).
    if (row.status === "unmatched") {
      const existing = byExistingSquareId.get(s.id) ?? [];
      if (existing.length === 1) {
        link({ client_id: existing[0].id }, "existing_link", 100);
        const qe = normEmail(existing[0].email);
        if (qe && email && qe !== email) {
          row.email_mismatch = true;
          row.review_reason = `Linked, but emails differ: Qleno <${existing[0].email}> vs Square <${s.email_address}>`;
        }
      } else if (existing.length > 1) {
        review(
          `${existing.length} Qleno clients already claim this Square customer`,
          existing.map(c => ({ client_id: c.id, name: `${c.first_name} ${c.last_name}`, active: c.is_active })),
          "existing_link",
        );
      }
    }

    // --- 3. Email match (exact, non-generic).
    if (row.status === "unmatched" && email && !generic.has(email)) {
      const cands = byEmail.get(email) ?? [];
      if (cands.length === 1) {
        link({ client_id: cands[0].id }, "email", 90);
      } else if (cands.length > 1) {
        const only = pickActive(cands);
        if (only) {
          link({ client_id: only.id }, "email", 85);
          row.review_reason = `Email matched ${cands.length} Qleno clients; linked to the only active one (cl#${only.id})`;
          row.candidates = cands.map(c => ({ client_id: c.id, active: c.is_active }));
        } else {
          review(
            `Email matches ${cands.length} Qleno clients, none uniquely active`,
            cands.map(c => ({ client_id: c.id, name: `${c.first_name} ${c.last_name}`, active: c.is_active })),
            "email",
          );
        }
      }
    }

    // --- 4. Name match — only when unique on BOTH sides.
    if (row.status === "unmatched" && name) {
      const n = normName(name);
      const sqTwins = (sqByName.get(n) ?? []).length;
      const cands = byFullName.get(n) ?? [];
      if (cands.length === 1 && sqTwins === 1) {
        link({ client_id: cands[0].id }, "name", 75);
        const qe = normEmail(cands[0].email);
        if (qe && email && qe !== email) row.email_mismatch = true;
      } else if (cands.length > 1 || (cands.length === 1 && sqTwins > 1)) {
        review(
          sqTwins > 1
            ? `Name "${name}" is on ${sqTwins} Square records — cannot tell them apart`
            : `Name matches ${cands.length} Qleno clients`,
          cands.map(c => ({ client_id: c.id, name: `${c.first_name} ${c.last_name}`, active: c.is_active })),
          "name",
        );
      }
    }

    // --- 5. Address match against client addresses (weakest signal; Square
    // usually stores only a postal code, so this fires rarely).
    if (row.status === "unmatched") {
      const k = addrKey(sqAddrLine(s));
      const cands = k ? (byClientAddr.get(k) ?? []) : [];
      const zipOk = (c: QlClient) => !s.address?.postal_code || !c.zip || c.zip.trim() === s.address.postal_code.trim();
      const narrowed = cands.filter(zipOk);
      if (narrowed.length === 1) {
        link({ client_id: narrowed[0].id }, "address", 70);
        row.review_reason = "Matched on street address only — confirm identity";
        // Address-only is the weakest rule we accept; keep it visible.
        row.status = "needs_review";
      } else if (narrowed.length > 1) {
        review(`Address matches ${narrowed.length} Qleno clients`, narrowed.map(c => ({ client_id: c.id })), "address");
      }
    }

    // --- 6. Duplicates override everything: keep whatever we resolved as a
    // suggestion, but force a human confirmation.
    if (dupIds && dupIds.length > 1) {
      const prior = row.review_reason ? ` ${row.review_reason}` : "";
      row.status = "needs_review";
      row.review_reason = `Duplicate Square record (${dupIds.length} share this name+email).${prior}`;
      row.candidates = row.candidates ?? dupIds.map(id => ({ square_customer_id: id }));
    }

    if (row.status === "unmatched" && !row.review_reason) {
      row.review_reason = "No Qleno client, account or property matched on email, name or address";
    }
    rows.push(row);
  }

  return rows;
}

// ----------------------------------------------------------------- Square I/O

async function squareGetAll<T>(token: string, path: string, key: string, extra = ""): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const url = `${SQUARE_API}${path}?limit=100${extra}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "Square-Version": SQUARE_VERSION } });
    const body: any = await res.json();
    if (!res.ok) throw new Error(`Square ${path} ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    out.push(...((body[key] ?? []) as T[]));
    cursor = body.cursor ?? null;
  } while (cursor);
  return out;
}

export const fetchSquareCustomers = (token: string) => squareGetAll<SquareCustomer>(token, "/customers", "customers");
export const fetchSquareCards = (token: string) => squareGetAll<SquareCard>(token, "/cards", "cards", "&include_disabled=true");

// -------------------------------------------------------------- orchestration

export type SyncSummary = {
  squareCustomers: number;
  squareCards: number;
  linked: number;
  needsReview: number;
  unmatched: number;
  withCardOnFile: number;
  emailMismatches: number;
  byMethod: Record<string, number>;
  mirroredToClients: number;
  mirroredToAccounts: number;
  unmatchedQlenoAccounts: { id: number; name: string }[];
  unmatchedActiveClients: number;
  dryRun: boolean;
};

export async function syncSquareCustomerMap(opts: { companyId: number; dryRun?: boolean; token?: string }): Promise<{ summary: SyncSummary; rows: MapRow[] }> {
  const { companyId, dryRun = false } = opts;
  const token = opts.token ?? process.env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new Error("SQUARE_ACCESS_TOKEN is not configured");

  const [customers, cards] = await Promise.all([fetchSquareCustomers(token), fetchSquareCards(token)]);

  const clients = (await db.execute(sql`
    SELECT id, company_id, first_name, last_name, company_name, email, address, city, zip,
           account_id, is_active, square_customer_id
    FROM clients WHERE company_id = ${companyId}`)).rows as unknown as QlClient[];
  const accounts = (await db.execute(sql`
    SELECT id, company_id, account_name, billing_contact_id, square_customer_id, is_active
    FROM accounts WHERE company_id = ${companyId}`)).rows as unknown as QlAccount[];
  const properties = (await db.execute(sql`
    SELECT id, account_id, company_id, property_name, address, city, zip, is_active
    FROM account_properties WHERE company_id = ${companyId}`)).rows as unknown as QlProperty[];

  const rows = buildMatchPlan({ companyId, customers, cards, clients, accounts, properties });

  let mirroredToClients = 0, mirroredToAccounts = 0;

  if (!dryRun) {
    for (const r of rows) {
      await db.execute(sql`
        INSERT INTO square_customer_map (
          company_id, square_customer_id, square_customer_name, square_email,
          square_company_name, square_phone, square_address, square_postal, square_created_at,
          client_id, account_id, account_property_id,
          square_card_id, card_brand, card_last4, card_exp, card_count,
          status, match_method, match_score, review_reason, email_mismatch,
          candidates, linked_at, last_synced_at
        ) VALUES (
          ${companyId}, ${r.square_customer_id}, ${r.square_customer_name}, ${r.square_email},
          ${r.square_company_name}, ${r.square_phone}, ${r.square_address}, ${r.square_postal},
          ${r.square_created_at ? new Date(r.square_created_at) : null},
          ${r.client_id}, ${r.account_id}, ${r.account_property_id},
          ${r.square_card_id}, ${r.card_brand}, ${r.card_last4}, ${r.card_exp}, ${r.card_count},
          ${r.status}, ${r.match_method}, ${r.match_score}, ${r.review_reason}, ${r.email_mismatch},
          ${r.candidates ? JSON.stringify(r.candidates) : null}::jsonb,
          ${r.status === "linked" ? sql`now()` : sql`NULL`}, now()
        )
        ON CONFLICT (company_id, square_customer_id) DO UPDATE SET
          square_customer_name = EXCLUDED.square_customer_name,
          square_email         = EXCLUDED.square_email,
          square_company_name  = EXCLUDED.square_company_name,
          square_phone         = EXCLUDED.square_phone,
          square_address       = EXCLUDED.square_address,
          square_postal        = EXCLUDED.square_postal,
          square_card_id       = EXCLUDED.square_card_id,
          card_brand           = EXCLUDED.card_brand,
          card_last4           = EXCLUDED.card_last4,
          card_exp             = EXCLUDED.card_exp,
          card_count           = EXCLUDED.card_count,
          last_synced_at       = now(),
          -- An office decision is authoritative: once a row has been reviewed
          -- or manually linked, the matcher refreshes the Square snapshot but
          -- never re-decides the link.
          client_id           = CASE WHEN square_customer_map.reviewed_at IS NOT NULL
                                       OR square_customer_map.match_method = 'manual'
                                     THEN square_customer_map.client_id ELSE EXCLUDED.client_id END,
          account_id          = CASE WHEN square_customer_map.reviewed_at IS NOT NULL
                                       OR square_customer_map.match_method = 'manual'
                                     THEN square_customer_map.account_id ELSE EXCLUDED.account_id END,
          account_property_id = CASE WHEN square_customer_map.reviewed_at IS NOT NULL
                                       OR square_customer_map.match_method = 'manual'
                                     THEN square_customer_map.account_property_id ELSE EXCLUDED.account_property_id END,
          status              = CASE WHEN square_customer_map.reviewed_at IS NOT NULL
                                       OR square_customer_map.match_method = 'manual'
                                     THEN square_customer_map.status ELSE EXCLUDED.status END,
          match_method        = CASE WHEN square_customer_map.reviewed_at IS NOT NULL
                                       OR square_customer_map.match_method = 'manual'
                                     THEN square_customer_map.match_method ELSE EXCLUDED.match_method END,
          match_score         = CASE WHEN square_customer_map.reviewed_at IS NOT NULL
                                       OR square_customer_map.match_method = 'manual'
                                     THEN square_customer_map.match_score ELSE EXCLUDED.match_score END,
          review_reason       = CASE WHEN square_customer_map.reviewed_at IS NOT NULL
                                       OR square_customer_map.match_method = 'manual'
                                     THEN square_customer_map.review_reason ELSE EXCLUDED.review_reason END,
          email_mismatch      = EXCLUDED.email_mismatch,
          candidates          = EXCLUDED.candidates
      `);
    }

    // Mirror confident CLIENT links onto clients.square_customer_id — only into
    // NULLs, so a value written by an earlier import is never clobbered.
    const cl = await db.execute(sql`
      UPDATE clients c SET square_customer_id = m.square_customer_id
      FROM square_customer_map m
      WHERE m.company_id = ${companyId} AND c.company_id = ${companyId}
        AND m.client_id = c.id AND m.status = 'linked'
        AND c.square_customer_id IS NULL`);
    mirroredToClients = cl.rowCount ?? 0;

    // Mirror ACCOUNT links only when exactly ONE Square record maps to that
    // account. Several records (Cucci: 4) means "which card is the default?" is
    // a business decision — left NULL for the office to confirm.
    const ac = await db.execute(sql`
      UPDATE accounts a SET square_customer_id = one.square_customer_id
      FROM (
        SELECT account_id, MIN(square_customer_id) AS square_customer_id
        FROM square_customer_map
        WHERE company_id = ${companyId} AND status = 'linked' AND account_id IS NOT NULL
        GROUP BY account_id HAVING COUNT(*) = 1
      ) one
      WHERE a.id = one.account_id AND a.company_id = ${companyId}
        AND a.square_customer_id IS NULL`);
    mirroredToAccounts = ac.rowCount ?? 0;
  }

  const byMethod: Record<string, number> = {};
  for (const r of rows) if (r.match_method) byMethod[r.match_method] = (byMethod[r.match_method] ?? 0) + 1;

  const linkedClientIds = new Set(rows.filter(r => r.status === "linked" && r.client_id).map(r => r.client_id));
  // An account is "covered" either by a direct account link OR by a linked
  // client that belongs to it (PPM's Square record is the person Daniel Walter,
  // whose client row carries account_id=3). Counting only direct links would
  // report PPM as missing when it is in fact reachable.
  const clientById = new Map(clients.map(c => [c.id, c]));
  const linkedAccountIds = new Set<number>();
  for (const r of rows) {
    if (r.status !== "linked") continue;
    if (r.account_id) linkedAccountIds.add(r.account_id);
    const viaClient = r.client_id ? clientById.get(r.client_id)?.account_id : null;
    if (viaClient) linkedAccountIds.add(viaClient);
  }

  const summary: SyncSummary = {
    squareCustomers: customers.length,
    squareCards: cards.length,
    linked: rows.filter(r => r.status === "linked").length,
    needsReview: rows.filter(r => r.status === "needs_review").length,
    unmatched: rows.filter(r => r.status === "unmatched").length,
    withCardOnFile: rows.filter(r => r.card_count > 0).length,
    emailMismatches: rows.filter(r => r.email_mismatch).length,
    byMethod,
    mirroredToClients,
    mirroredToAccounts,
    unmatchedQlenoAccounts: accounts
      .filter(a => a.is_active && !linkedAccountIds.has(a.id))
      .map(a => ({ id: a.id, name: a.account_name })),
    unmatchedActiveClients: clients.filter(c => c.is_active && !linkedClientIds.has(c.id)).length,
    dryRun,
  };

  return { summary, rows };
}
