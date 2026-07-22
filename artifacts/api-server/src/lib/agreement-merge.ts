// [agreement-merge 2026-07-22] Merge variables for e-signable agreements.
//
// Agreement bodies used to be plain static text, so a contract with the client
// name, service address, rate and frequency baked in had to be retyped for every
// client (which is why the commercial agreement still lived in Jotform). Authors
// can now write {{client_name}} / {{rate}} / {{frequency}} etc. and Qleno fills
// them in from the client + estimate + company records at SEND time.
//
// Why at send time (not at view time): the signer must see exactly the text that
// gets stored and hashed. The rendered body is persisted onto the submission's
// terms_body_override, which sign.ts already prefers over the template body, so
// the signing page, the stored record and the Certificate of Completion all show
// the same words. Rendering at view time would let a later edit to the template
// silently change what a signed agreement appears to say.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type AgreementVars = Record<string, string>;

// The catalog the UI shows authors. Keep token names snake_case and stable —
// they appear in saved template bodies, so renaming one breaks existing
// templates. Add new ones; don't repurpose.
export const AGREEMENT_VARIABLES: { token: string; label: string; example: string }[] = [
  { token: "client_name",      label: "Client full name",        example: "Jennifer Nuno" },
  { token: "client_first_name",label: "Client first name",       example: "Jennifer" },
  { token: "client_company",   label: "Client company name",     example: "5721 W 103rd St Condominium Association" },
  { token: "service_address",  label: "Service address",         example: "2935 Lancelot Lane, Naperville, IL 60564" },
  { token: "client_email",     label: "Client email",            example: "jennienuno@gmail.com" },
  { token: "client_phone",     label: "Client phone",            example: "6308283098" },
  { token: "rate",             label: "Rate / price",            example: "$150.00" },
  { token: "frequency",        label: "Service frequency",       example: "Monthly" },
  { token: "effective_date",   label: "Effective date",          example: "July 22, 2026" },
  { token: "today",            label: "Today's date",            example: "July 22, 2026" },
  { token: "company_name",     label: "Your company name",       example: "Phes" },
  { token: "company_phone",    label: "Your company phone",      example: "773-706-6000" },
  { token: "company_email",    label: "Your company email",      example: "info@phes.io" },
  { token: "late_fee",         label: "Late-payment terms (Company Settings)", example: "1.5% per month on balances over 10 days past due" },
  // Contract numbers — all editable under Company Settings → Service Agreement Terms.
  { token: "termination_notice_days", label: "Termination notice (days)",  example: "30" },
  { token: "rate_notice_days",        label: "Rate-change notice (days)",  example: "30" },
  { token: "damage_report_days",      label: "Damage reporting window (business days)", example: "5" },
  { token: "damage_cap",              label: "Damage liability cap",       example: "$500.00" },
  { token: "nonsolicit_months",       label: "Non-solicit period (months)",example: "12" },
  { token: "nonsolicit_fee",          label: "Non-solicit placement fee",  example: "$2,500.00" },
  // Only resolves when the agreement is sent from an estimate — a contract sent
  // straight off a client record has no scope to draw from.
  { token: "scope_of_work",    label: "Scope of work (from the estimate)", example: "Lobby & entrance\nCommon hallways & stairwells" },
];

function money(n: any): string {
  const v = Number(n);
  // Thousands separators — "$2,500.00" is how a dollar figure reads in a
  // contract; "$2500.00" looks like a typo in a signed document.
  return Number.isFinite(v)
    ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "";
}

function longDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

// Join address parts the same way the rest of the app does:
// "<street>, <city>, <state> <zip>". If zip is shown, state is shown.
function joinAddress(street?: any, city?: any, state?: any, zip?: any): string {
  const line1 = String(street || "").trim();
  const cityPart = String(city || "").trim();
  const stateZip = [String(state || "").trim(), String(zip || "").trim()].filter(Boolean).join(" ");
  return [line1, cityPart, stateZip].filter(Boolean).join(", ");
}

// Gather the values available to a given send. Every source is optional — a
// template sent from the client record has no estimate, and vice versa.
export async function buildAgreementVars(
  companyId: number,
  opts: { clientId?: number | null; estimateId?: number | null } = {},
): Promise<AgreementVars> {
  const vars: AgreementVars = {};
  const now = new Date();
  vars.today = longDate(now);
  vars.effective_date = longDate(now);

  const co: any = (await db.execute(sql`
    SELECT name, phone, email, late_fee_terms,
           agr_termination_notice_days, agr_rate_notice_days,
           agr_damage_report_days, agr_damage_cap,
           agr_nonsolicit_months, agr_nonsolicit_fee
      FROM companies WHERE id = ${companyId} LIMIT 1
  `)).rows[0];
  if (co) {
    vars.company_name = co.name ?? "";
    vars.company_phone = co.phone ?? "";
    vars.company_email = co.email ?? "";
    // [agreement-late-fee 2026-07-22] Falls back to a deliberately soft sentence
    // when the office hasn't configured terms. A BLANK here would leave "Late
    // Payments:" dangling in a signed contract, and a hardcoded percentage
    // would assert a fee the office never agreed to charge.
    vars.late_fee = String(co.late_fee_terms || "").trim()
      || "Late payments may be subject to a late fee.";
    // [agreement-clauses 2026-07-22] Tunable contract numbers. These fall back
    // to the approved defaults rather than empty — a blank in "limited to ___"
    // would make the clause unenforceable, which is worse than a stale number.
    vars.termination_notice_days = String(co.agr_termination_notice_days ?? 30);
    vars.rate_notice_days = String(co.agr_rate_notice_days ?? 30);
    vars.damage_report_days = String(co.agr_damage_report_days ?? 5);
    vars.damage_cap = money(co.agr_damage_cap ?? 500);
    vars.nonsolicit_months = String(co.agr_nonsolicit_months ?? 12);
    vars.nonsolicit_fee = money(co.agr_nonsolicit_fee ?? 2500);
  }

  if (opts.clientId) {
    const c: any = (await db.execute(sql`
      SELECT first_name, last_name, company_name, email, phone, address, city, state, zip
        FROM clients WHERE id = ${opts.clientId} AND company_id = ${companyId} LIMIT 1
    `)).rows[0];
    if (c) {
      vars.client_name = [c.first_name, c.last_name].filter(Boolean).join(" ");
      vars.client_first_name = c.first_name ?? "";
      vars.client_company = c.company_name ?? "";
      vars.client_email = c.email ?? "";
      vars.client_phone = c.phone ?? "";
      vars.service_address = joinAddress(c.address, c.city, c.state, c.zip);
    }
  }

  if (opts.estimateId) {
    const e: any = (await db.execute(sql`
      SELECT contact_name, property_name, service_address, total, frequency, scope_note
        FROM estimates WHERE id = ${opts.estimateId} AND company_id = ${companyId} LIMIT 1
    `)).rows[0];
    if (e) {
      // The estimate is the more specific source for this agreement, so it wins
      // over the client record where both have a value.
      if (e.contact_name) vars.client_name = e.contact_name;
      if (e.property_name) vars.client_company = e.property_name;
      if (e.service_address) vars.service_address = e.service_address;
      if (e.total != null) vars.rate = money(e.total);
      if (e.frequency) vars.frequency = e.frequency;
    }

    // Scope of work: the estimate's own scope paragraph when the office wrote
    // one, else the line items as a list. This is what makes one commercial
    // template reusable across buildings — the per-property scope comes from
    // the estimate instead of being retyped into the contract.
    const scopeNote = String(e?.scope_note ?? "").trim();
    if (scopeNote) {
      vars.scope_of_work = scopeNote;
    } else {
      const items: any[] = (await db.execute(sql`
        SELECT name, description, frequency FROM estimate_line_items
         WHERE estimate_id = ${opts.estimateId} AND company_id = ${companyId}
         ORDER BY sort_order ASC, id ASC
      `)).rows as any[];
      const lines = items
        .map(i => {
          const label = String(i.name || i.description || "").trim();
          if (!label) return "";
          const freq = String(i.frequency || "").trim();
          return freq ? `${label} — ${freq}` : label;
        })
        .filter(Boolean);
      if (lines.length) vars.scope_of_work = lines.join("\n");
    }
  }

  return vars;
}

// Replace {{token}} occurrences. Tolerant of inner whitespace and case
// ({{ Client_Name }} works). An UNKNOWN token is left exactly as written rather
// than blanked — a visible {{cient_name}} tells the author they typo'd, whereas
// silently deleting it would ship a contract with a hole in it.
export function renderAgreementBody(body: string | null | undefined, vars: AgreementVars): string {
  const text = String(body ?? "");
  if (!text) return "";
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, token) => {
    const key = String(token).toLowerCase();
    const val = vars[key];
    // A known token with an empty value (e.g. client has no phone) renders empty
    // — that is a real data gap and should be visible as a blank, not as syntax.
    return Object.prototype.hasOwnProperty.call(vars, key) ? val : whole;
  });
}

// Convenience: look up the values and render in one call.
export async function renderAgreementFor(
  companyId: number,
  body: string | null | undefined,
  opts: { clientId?: number | null; estimateId?: number | null } = {},
): Promise<string> {
  const vars = await buildAgreementVars(companyId, opts);
  return renderAgreementBody(body, vars);
}
