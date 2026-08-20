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
  { token: "rate_increase_limit",     label: "Rate-increase frequency limit (full sentence; empty when off)", example: "Rates will not be adjusted more than once in any 12-month period." },
  // Only resolves when the agreement is sent from an estimate — a contract sent
  // straight off a client record has no scope to draw from.
  { token: "scope_of_work",    label: "Scope of work (from the estimate)", example: "Lobby & entrance\nCommon hallways & stairwells" },
  // [agreement-from-client 2026-08-19] Sourced from the client's PROPERTY and
  // their live RECURRING SCHEDULE, so a residential agreement sent off the
  // client profile fills in the same way a commercial one does off an estimate.
  // Before this, rate/frequency/start date resolved ONLY from an estimate, so a
  // residential recurring signup produced a contract with the price blank.
  { token: "service_day",        label: "Service day of week",       example: "Wednesdays" },
  { token: "start_date",         label: "First service date",        example: "October 15, 2025" },
  { token: "bedrooms",           label: "Bedrooms",                  example: "2" },
  { token: "bathrooms",          label: "Bathrooms",                 example: "2" },
  { token: "square_feet",        label: "Square footage",            example: "1,150" },
  { token: "pets",               label: "Pets",                      example: "One dog" },
  { token: "access_notes",       label: "Entry instructions",        example: "Someone will grant access" },
  // Hold terms — editable under Company Settings → Service Agreement Terms.
  { token: "hold_max_days",         label: "Maximum service hold (days)", example: "90" },
  { token: "hold_notice_free_days", label: "Hold length that needs no notice authorization (days)", example: "30" },
];

// Human labels for the recurring cadence. The enum values read like column
// names ("every_3_weeks"); a signed contract has to read like English.
const FREQUENCY_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  every_3_weeks: "Every 3 weeks",
  monthly: "Every 4 weeks",
  monthly_weekday: "Monthly",
  semi_monthly: "Twice a month",
  daily: "Daily",
  weekdays: "Weekdays",
  custom_days: "Multiple days each week",
  custom: "Custom",
};

const DAY_PLURALS: Record<string, string> = {
  monday: "Mondays", tuesday: "Tuesdays", wednesday: "Wednesdays",
  thursday: "Thursdays", friday: "Fridays", saturday: "Saturdays", sunday: "Sundays",
};

function frequencyLabel(freq: any, customWeeks: any): string {
  const key = String(freq || "").toLowerCase();
  // A custom cadence carries its interval in custom_frequency_weeks; rendering
  // a bare "Custom" in a contract tells the client nothing about how often we
  // are coming, which is the one thing the frequency line exists to say.
  if (key === "custom") {
    const w = Number(customWeeks);
    if (Number.isFinite(w) && w > 0) return w === 1 ? "Weekly" : `Every ${w} weeks`;
  }
  return FREQUENCY_LABELS[key] || "";
}

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
  opts: { clientId?: number | null; estimateId?: number | null; clientHomeId?: number | null } = {},
): Promise<AgreementVars> {
  const vars: AgreementVars = {};
  const now = new Date();
  vars.today = longDate(now);
  vars.effective_date = longDate(now);

  const co: any = (await db.execute(sql`
    SELECT name, phone, email, late_fee_terms,
           agr_termination_notice_days, agr_rate_notice_days,
           agr_damage_report_days, agr_damage_cap,
           agr_nonsolicit_months, agr_nonsolicit_fee, agr_rate_increase_limit_months,
           agr_hold_max_days, agr_hold_notice_free_days
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
    // [rate-increase-limit 2026-07-22] Renders a WHOLE SENTENCE, or nothing when
    // the limit is switched off. A bare number would leave "once every 0 months"
    // in a signed contract, so the on/off decision lives here — the renderer has
    // no conditionals by design.
    const rateLimitMonths = Number(co.agr_rate_increase_limit_months ?? 12);
    vars.rate_increase_limit = rateLimitMonths > 0
      ? `Rates will not be adjusted more than once in any ${rateLimitMonths}-month period.`
      : "";
    // [service-hold 2026-08-19] Hold terms. Defaults match the suspension
    // engine's MAX_SUSPEND_DAYS so the contract can never promise a longer hold
    // than the software will actually grant.
    vars.hold_max_days = String(co.agr_hold_max_days ?? 90);
    vars.hold_notice_free_days = String(co.agr_hold_notice_free_days ?? 30);
  }

  if (opts.clientId) {
    const c: any = (await db.execute(sql`
      SELECT first_name, last_name, company_name, email, phone, address, city, state, zip, pets
        FROM clients WHERE id = ${opts.clientId} AND company_id = ${companyId} LIMIT 1
    `)).rows[0];
    if (c) {
      vars.client_name = [c.first_name, c.last_name].filter(Boolean).join(" ");
      vars.client_first_name = c.first_name ?? "";
      vars.client_company = c.company_name ?? "";
      vars.client_email = c.email ?? "";
      vars.client_phone = c.phone ?? "";
      vars.service_address = joinAddress(c.address, c.city, c.state, c.zip);
      // clients.pets is the office's free-text note ("Two cats, friendly").
      // The property row's has_pets/pet_notes wins below when there is one.
      vars.pets = String(c.pets || "").trim();
    }

    // [agreement-from-client 2026-08-19] The property being cleaned. Uses the
    // home the caller named, else the client's primary. A client with several
    // homes gets the contract for the one the office picked, not whichever row
    // happened to sort first.
    const home: any = (await db.execute(sql`
      SELECT address, city, state, zip, bedrooms, bathrooms, half_baths,
             sq_footage, access_notes, has_pets, pet_notes
        FROM client_homes
       WHERE client_id = ${opts.clientId} AND company_id = ${companyId}
         ${opts.clientHomeId ? sql`AND id = ${opts.clientHomeId}` : sql``}
       ORDER BY is_primary DESC NULLS LAST, id ASC
       LIMIT 1
    `)).rows[0];
    if (home) {
      const homeAddr = joinAddress(home.address, home.city, home.state, home.zip);
      if (homeAddr) vars.service_address = homeAddr;
      if (home.bedrooms != null) vars.bedrooms = String(home.bedrooms);
      // Half baths are counted separately in the schema but a contract reads
      // them together: 2 full + 1 half is "2.5".
      if (home.bathrooms != null) {
        const half = Number(home.half_baths || 0);
        vars.bathrooms = half > 0
          ? String(Number(home.bathrooms) + half * 0.5)
          : String(home.bathrooms);
      }
      if (home.sq_footage != null) vars.square_feet = Number(home.sq_footage).toLocaleString("en-US");
      if (home.access_notes) vars.access_notes = String(home.access_notes).trim();
      const petNote = String(home.pet_notes || "").trim();
      if (petNote) vars.pets = petNote;
      else if (home.has_pets === true && !vars.pets) vars.pets = "Yes";
      else if (home.has_pets === false && !vars.pets) vars.pets = "None";
    }

    // [agreement-from-client 2026-08-19] Last resort for the home details.
    // client_homes is the right home for this, but the MaidCentral import never
    // populated it: of Phes's 64 active residential recurring clients only 3
    // have a bedroom count on a property row. The quote does carry them, because
    // the booking widget and the quote builder both ask, so anyone who signs up
    // from here forward has the numbers there. Only fills what the property row
    // left empty, so a real property record always wins.
    if (!vars.bedrooms || !vars.bathrooms) {
      const q: any = (await db.execute(sql`
        SELECT bedrooms, bathrooms, half_baths, pets
          FROM quotes
         WHERE client_id = ${opts.clientId} AND company_id = ${companyId}
           AND (bedrooms IS NOT NULL OR bathrooms IS NOT NULL)
         ORDER BY id DESC
         LIMIT 1
      `)).rows[0];
      if (q) {
        if (!vars.bedrooms && q.bedrooms != null) vars.bedrooms = String(q.bedrooms);
        if (!vars.bathrooms && q.bathrooms != null) {
          const half = Number(q.half_baths || 0);
          vars.bathrooms = half > 0
            ? String(Number(q.bathrooms) + half * 0.5)
            : String(q.bathrooms);
        }
        // quotes.pets is a COUNT, not a note. Render it as one so the contract
        // does not end up saying "Pets: 2" next to a client_homes note that
        // would have said "Two cats, friendly".
        const petCount = Number(q.pets);
        if (!vars.pets && Number.isFinite(petCount) && petCount > 0) {
          vars.pets = petCount === 1 ? "1 pet" : `${petCount} pets`;
        }
      }
    }

    // The live recurring schedule is where a residential agreement's rate,
    // cadence, service day and start date come from. Account schedules are
    // excluded — those bill through the account, not this client's contract.
    const sch: any = (await db.execute(sql`
      SELECT frequency, custom_frequency_weeks, day_of_week, start_date, base_fee
        FROM recurring_schedules
       WHERE customer_id = ${opts.clientId} AND company_id = ${companyId}
         AND is_active = true AND account_id IS NULL
       ORDER BY start_date DESC, id DESC
       LIMIT 1
    `)).rows[0];
    if (sch) {
      const fee = Number(sch.base_fee);
      if (Number.isFinite(fee) && fee > 0) vars.rate = money(fee);
      const freq = frequencyLabel(sch.frequency, sch.custom_frequency_weeks);
      if (freq) vars.frequency = freq;
      const day = DAY_PLURALS[String(sch.day_of_week || "").toLowerCase()];
      if (day) vars.service_day = day;
      if (sch.start_date) {
        // pg hands back DATE as a JS Date in this driver, so parse the string
        // form rather than trusting the local-timezone rendering of midnight.
        const iso = String(sch.start_date).slice(0, 10);
        const [y, m, d] = iso.split("-").map(Number);
        if (y && m && d) vars.start_date = longDate(new Date(y, m - 1, d));
      }
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
          return freq ? `${label} (${freq})` : label;
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
  const substituted = text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, token) => {
    const key = String(token).toLowerCase();
    const val = vars[key];
    // A known token with an empty value (e.g. client has no phone) renders empty
    // — that is a real data gap and should be visible as a blank, not as syntax.
    return Object.prototype.hasOwnProperty.call(vars, key) ? val : whole;
  });
  // A variable that renders empty (the rate-increase limit when switched off)
  // leaves the space before it dangling. Tidy up so a signed contract never
  // carries stray whitespace. Only runs of spaces/tabs are touched — never
  // newlines, so paragraph structure is preserved exactly.
  return substituted
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "");
}

// Convenience: look up the values and render in one call.
export async function renderAgreementFor(
  companyId: number,
  body: string | null | undefined,
  opts: { clientId?: number | null; estimateId?: number | null; clientHomeId?: number | null } = {},
): Promise<string> {
  const vars = await buildAgreementVars(companyId, opts);
  return renderAgreementBody(body, vars);
}
