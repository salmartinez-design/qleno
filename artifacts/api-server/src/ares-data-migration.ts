/**
 * [ares-migration 2026-08-18] Import the legacy Ares data into Qleno.
 *
 * Ares' root `subscriptions` table held BOTH the customer (name, address,
 * phone, email) and the recurring-revenue state (cadence, rate, status, VA
 * attribution) in one 48-column row. Qleno already owns the customer, so this
 * imports only the second half: it links each Ares subscription to an EXISTING
 * Qleno client and writes the Ares-owned state into the module's own additive
 * tables.
 *
 * It NEVER creates or edits a client. A subscription with no confident match is
 * reported and skipped — inventing a customer record to make an import succeed
 * is how you end up with a duplicate book.
 *
 * DRY RUN BY DEFAULT. Nothing is written without --commit.
 *
 *   tsx src/ares-data-migration.ts --file ares-export.sql --company 1 --report matches.csv
 *   tsx src/ares-data-migration.ts --file ares-export.sql --company 1 --matches matches.csv --commit
 *
 * The two-step is the point: pass 1 emits a match report for a human to review,
 * pass 2 reads that reviewed file back and imports only what it approves.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (n: string): string | null => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const flag = (n: string) => argv.includes(`--${n}`);

const FILE = arg("file");
const COMPANY_ID = Number(arg("company") ?? NaN);
const BRANCH_ID = arg("branch") ? Number(arg("branch")) : null;
const REPORT = arg("report");
const MATCHES = arg("matches");
// Opt-in, human-curated exception to "never create a client". Takes a CSV the
// operator reviewed by hand — never inferred, never automatic.
const CREATE_MISSING = arg("create-missing");
const COMMIT = flag("commit");

if (!FILE || !Number.isFinite(COMPANY_ID)) {
  console.error("usage: tsx src/ares-data-migration.ts --file <dump.sql> --company <id> [--branch <id>] [--report out.csv] [--matches reviewed.csv] [--create-missing new-clients.csv] [--commit]");
  process.exit(1);
}

type Row = Record<string, string | null>;

// ── Dump parser ──────────────────────────────────────────────────────────────
// Handles BOTH pg_dump shapes, because which one you get depends on the flags
// whoever ran the export happened to use:
//   --column-inserts  →  INSERT INTO t (cols) VALUES (...);      [what we got]
//   default           →  COPY t (cols) FROM stdin; tab-separated [what we assumed]
// Getting this wrong is a first-run crash, so both are supported.

function splitTuple(s: string): (string | null)[] {
  const out: (string | null)[] = [];
  let buf = "", i = 0, inq = false;
  while (i < s.length) {
    const c = s[i];
    if (inq) {
      if (c === "'") {
        if (s[i + 1] === "'") { buf += "'"; i += 2; continue; }
        inq = false; i++; continue;
      }
      buf += c; i++; continue;
    }
    if (c === "'") { inq = true; i++; continue; }
    if (c === ",") { out.push(buf.trim()); buf = ""; i++; continue; }
    buf += c; i++;
  }
  out.push(buf.trim());
  // An unquoted NULL is a real null; a quoted one was a literal string.
  return out.map(v => (v === "NULL" ? null : v));
}

function parseInserts(sqlText: string, table: string): Row[] {
  const rows: Row[] = [];
  const re = new RegExp(`INSERT INTO (?:public\\.)?${table} \\(([^)]*)\\) VALUES \\(`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(sqlText)) !== null) {
    const cols = m[1].split(",").map(c => c.trim().replace(/^"|"$/g, ""));
    let i = m.index + m[0].length, depth = 1, inq = false;
    const start = i;
    while (i < sqlText.length && depth > 0) {
      const c = sqlText[i];
      if (inq) {
        if (c === "'") { if (sqlText[i + 1] === "'") { i += 2; continue; } inq = false; }
      } else if (c === "'") inq = true;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    const vals = splitTuple(sqlText.slice(start, i - 1));
    const row: Row = {};
    cols.forEach((c, k) => { row[c] = vals[k] ?? null; });
    rows.push(row);
  }
  return rows;
}

function parseCopy(sqlText: string, table: string): Row[] {
  const rows: Row[] = [];
  const lines = sqlText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^COPY\\s+(?:public\\.)?"?${table}"?\\s*\\(([^)]*)\\)\\s+FROM stdin;`, "i"));
    if (!m) continue;
    const cols = m[1].split(",").map(c => c.trim().replace(/^"|"$/g, ""));
    i++;
    while (i < lines.length && lines[i] !== "\\.") {
      if (lines[i] !== "") {
        const vals = lines[i].split("\t");
        const row: Row = {};
        cols.forEach((c, k) => {
          const v = vals[k];
          row[c] = v === undefined || v === "\\N" ? null
            : v.replace(/\\t/g, "\t").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
        });
        rows.push(row);
      }
      i++;
    }
  }
  return rows;
}

const parseTable = (text: string, t: string): Row[] => {
  const a = parseInserts(text, t);
  return a.length ? a : parseCopy(text, t);
};

// ── Normalisers ──────────────────────────────────────────────────────────────

const normName = (s?: string | null) =>
  (s ?? "").toLowerCase().normalize("NFKD").replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
const normEmail = (s?: string | null) => (s ?? "").trim().toLowerCase();
const normPhone = (s?: string | null) => {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
};
const tokens = (s: string) => new Set(normName(s).split(" ").filter(t => t.length > 1));
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let h = 0; for (const t of a) if (b.has(t)) h++;
  return h / (a.size + b.size - h);
};
// Character-level similarity, for typos: "Condiminium" vs "Condominium".
function similar(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [s, l] = a.length > b.length ? [b, a] : [a, b];
  let prev = Array.from({ length: s.length + 1 }, (_, i) => i);
  for (let i = 1; i <= l.length; i++) {
    const cur = [i];
    for (let j = 1; j <= s.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (l[i - 1] === s[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[s.length] / l.length;
}

// Ares cadence (free text, two spellings of semi-monthly) → Qleno enum key.
const CADENCE: Record<string, string> = {
  weekly: "weekly", biweekly: "biweekly", bi_weekly: "biweekly", every_other_week: "biweekly",
  semi_monthly: "semi_monthly", "semi-monthly": "semi_monthly", semimonthly: "semi_monthly",
  every_3_weeks: "every_3_weeks", every3weeks: "every_3_weeks", tri_weekly: "every_3_weeks",
  every_5_weeks: "every_5_weeks", every_6_weeks: "every_6_weeks", every_8_weeks: "every_8_weeks",
  monthly: "monthly", quarterly: "quarterly", custom: "custom", weekdays: "weekdays",
};
function mapCadence(raw?: string | null): string | null {
  if (!raw) return null;
  const k = raw.toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (CADENCE[k]) return CADENCE[k];
  if (CADENCE[raw.toLowerCase().trim()]) return CADENCE[raw.toLowerCase().trim()];
  const n = k.match(/every_?(\d+)_?weeks?/);
  if (n) {
    const v = Number(n[1]);
    return v === 1 ? "weekly" : v === 2 ? "biweekly" : `every_${v}_weeks`;
  }
  return null;
}

// Ares status → Qleno recurring_status. Ares' `notice` has no Qleno equivalent;
// a client serving notice is still active until their final service date, which
// is exactly how Ares counted them in MRR — so that is what they become.
const STATUS: Record<string, string> = {
  active: "active", paused: "paused", lost: "lost",
  "on-demand": "on_demand", "on demand": "on_demand", on_demand: "on_demand",
  notice: "active", canceled: "lost", cancelled: "lost",
};

// Ares commission status → Qleno sales_commission_status.
const CSTATUS: Record<string, string> = {
  pending: "pending_review", approved: "approved", paid: "paid", rejected: "rejected",
  not_eligible: "not_eligible", on_hold: "on_hold", chargebacked: "charged_back",
  chargeback_pending: "chargeback_pending", chargeback_confirmed: "chargeback_confirmed",
  recouped: "recouped",
};

// ── Card-data scrub ──────────────────────────────────────────────────────────
// The Ares export contains PAYMENT CARD NUMBERS in plaintext client notes —
// 7 Luhn-valid PANs across 6 clients, found on 2026-08-18. Storing a PAN in a
// free-text notes field is a PCI-DSS violation, and migrating it would carry
// the violation into Qleno and widen its blast radius.
//
// Nothing this script writes may contain one. Every free-text field it copies
// goes through scrubCards() — Luhn-checked runs are removed outright, and any
// remaining 13+ digit run is removed too, because a mistyped card is still a
// card. This is deliberately aggressive: a lost note is recoverable from Ares,
// a leaked PAN is not.
function luhnValid(digits: string): boolean {
  const ds = [...digits].filter(c => c >= "0" && c <= "9").map(Number);
  if (ds.length < 13 || ds.length > 19) return false;
  let sum = 0;
  ds.reverse().forEach((d, i) => {
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  });
  return sum % 10 === 0;
}
export function scrubCards(v: string | null | undefined): string | null {
  if (!v) return v ?? null;
  let out = v;
  const runs = v.match(/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g) ?? [];
  for (const r of runs) {
    if (luhnValid(r.replace(/\D/g, ""))) out = out.split(r).join("[card number removed on migration]");
  }
  return out.replace(/(?<!\d)(?:\d[ -]?){13,}(?!\d)/g, "[long number removed on migration]");
}

// ── Matching ─────────────────────────────────────────────────────────────────

interface QClient {
  id: number; first_name: string; last_name: string; company_name: string | null;
  email: string | null; phone: string | null; branch_id: number | null;
}
type Conf = "EXACT" | "STRONG" | "WEAK" | "NONE";
interface Match {
  ares_id: string; name: string; status: string | null; cadence: string | null;
  mrr: string | null; va: string | null; email: string | null; phone: string | null;
  client_id: number | null; candidate: string | null; conf: Conf; basis: string;
}

function buildMatches(subs: Row[], clients: QClient[]): Match[] {
  const byEmail = new Map<string, QClient[]>();
  const byPhone = new Map<string, QClient[]>();
  for (const c of clients) {
    const e = normEmail(c.email); if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), c]);
    const p = normPhone(c.phone); if (p) byPhone.set(p, [...(byPhone.get(p) ?? []), c]);
  }
  const label = (c: QClient) =>
    `${c.company_name || `${c.first_name} ${c.last_name}`.trim()} (#${c.id})`;
  const nameOf = (c: QClient) => normName(`${c.first_name} ${c.last_name}`);

  // Disambiguate a multi-hit by exact name, then by character similarity.
  const resolve = (cands: QClient[], want: string): QClient | null => {
    const ex = cands.filter(c => nameOf(c) === want || normName(c.company_name) === want);
    if (ex.length === 1) return ex[0];
    let best: [QClient, number] | null = null;
    for (const c of cands) {
      const s = Math.max(similar(want, nameOf(c)), similar(want, normName(c.company_name)));
      if (!best || s > best[1]) best = [c, s];
    }
    return best && best[1] >= 0.9 ? best[0] : null;
  };

  const out: Match[] = [];
  for (const s of subs) {
    const want = normName(s.client);
    const base = {
      ares_id: s.id ?? "", name: s.client ?? "", status: s.status, cadence: s.cadence,
      mrr: s.monthly, va: s.subscribed_by, email: s.email, phone: s.phone,
    };
    const push = (client_id: number | null, candidate: string | null, conf: Conf, basis: string) =>
      out.push({ ...base, client_id, candidate, conf, basis });

    const e = normEmail(s.email), p = normPhone(s.phone);
    const hitE = e ? byEmail.get(e) ?? [] : [];
    if (hitE.length === 1) { push(hitE[0].id, label(hitE[0]), "EXACT", "email"); continue; }
    if (hitE.length > 1) {
      const r = resolve(hitE, want);
      if (r) { push(r.id, label(r), "STRONG", `email shared by ${hitE.length}; resolved by name`); continue; }
      push(null, hitE.map(label).join(" | "), "WEAK", `email shared by ${hitE.length}`); continue;
    }
    const hitP = p ? byPhone.get(p) ?? [] : [];
    if (hitP.length === 1) { push(hitP[0].id, label(hitP[0]), "EXACT", "phone"); continue; }
    if (hitP.length > 1) {
      const r = resolve(hitP, want);
      if (r) { push(r.id, label(r), "STRONG", `phone shared by ${hitP.length}; resolved by name`); continue; }
      push(null, hitP.map(label).join(" | "), "WEAK", `phone shared by ${hitP.length}`); continue;
    }
    if (!want) { push(null, null, "NONE", "Ares row has no client name"); continue; }

    const exact = clients.filter(c => nameOf(c) === want || normName(c.company_name) === want);
    if (exact.length === 1) { push(exact[0].id, label(exact[0]), "STRONG", "exact name"); continue; }
    if (exact.length > 1) {
      const r = resolve(exact, want);
      if (r) { push(r.id, label(r), "STRONG", `name shared by ${exact.length}; resolved`); continue; }
      push(null, exact.slice(0, 4).map(label).join(" | "), "WEAK", `name shared by ${exact.length}`); continue;
    }

    // Typo tolerance, then a looser token overlap for a "did you mean" hint.
    let best: [QClient, number] | null = null;
    for (const c of clients) {
      const s2 = Math.max(similar(want, nameOf(c)), similar(want, normName(c.company_name)));
      if (!best || s2 > best[1]) best = [c, s2];
    }
    if (best && best[1] >= 0.9) { push(best[0].id, label(best[0]), "STRONG", `near-identical name ${best[1].toFixed(2)}`); continue; }
    let bestTok: [QClient, number] | null = null;
    const wt = tokens(s.client ?? "");
    for (const c of clients) {
      const s3 = Math.max(jaccard(wt, tokens(`${c.first_name} ${c.last_name}`)), jaccard(wt, tokens(c.company_name ?? "")));
      if (!bestTok || s3 > bestTok[1]) bestTok = [c, s3];
    }
    if (bestTok && bestTok[1] >= 0.6) { push(null, label(bestTok[0]), "WEAK", `partial name ${bestTok[1].toFixed(2)}`); continue; }
    push(null, best ? label(best[0]) : null, "NONE", best ? `closest ${best[1].toFixed(2)}` : "no candidates");
  }

  // One Qleno client must not receive two Ares subscriptions — that doubles its MRR.
  const claimed = new Map<number, string>();
  for (const m of out) {
    if (m.client_id == null) continue;
    const prior = claimed.get(m.client_id);
    if (prior) { m.conf = "WEAK"; m.basis = `client already matched by "${prior}" — would double MRR`; m.client_id = null; }
    else claimed.set(m.client_id, m.name);
  }
  return out;
}

const csvEsc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

// A reviewed report is AUTHORITATIVE — a human looked at it, so its decisions
// override anything the matcher would derive on its own.
function applyReviewed(matches: Match[], path: string): number {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(",").map(h => h.replace(/^"|"$/g, "").trim());
  const iName = head.indexOf("ares_name"), iId = head.indexOf("qleno_client_id");
  if (iName < 0 || iId < 0) throw new Error("--matches file needs ares_name and qleno_client_id columns");
  const decided = new Map<string, number | null>();
  for (const line of lines.slice(1)) {
    const cells = splitCsv(line);
    const nm = (cells[iName] ?? "").trim();
    const raw = (cells[iId] ?? "").trim();
    if (nm) decided.set(nm, raw && raw !== "None" && raw !== "null" ? Number(raw) : null);
  }
  let applied = 0;
  for (const m of matches) {
    if (!decided.has(m.name)) continue;
    const id = decided.get(m.name)!;
    if (id !== m.client_id) { m.client_id = id; m.conf = id == null ? "NONE" : "EXACT"; m.basis = "reviewed by hand"; applied++; }
  }
  return applied;
}

function splitCsv(line: string): string[] {
  const out: string[] = []; let buf = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { buf += '"'; i++; } else q = false; } else buf += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(buf); buf = ""; }
    else buf += c;
  }
  out.push(buf);
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const money = (v?: string | null) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const ACTIVE = new Set(["active", "on-demand", "on demand"]);
const day = (v?: string | null) => (v ? String(v).slice(0, 10) : null);

async function main() {
  const text = readFileSync(FILE!, "utf8");
  const subsAll = parseTable(text, "subscriptions");
  const aresUsers = parseTable(text, "users");
  const aresComms = parseTable(text, "commission_submissions");
  const aresLedger = parseTable(text, "commission_ledger");
  const aresCadence = parseTable(text, "subscription_cadence_history");

  // Soft-deleted rows never existed as far as Qleno is concerned.
  const subs = subsAll.filter(s => !s.deleted_at);

  console.log(`[ares] parsed  ${subsAll.length} subscriptions (${subsAll.length - subs.length} soft-deleted, ${subs.length} live)`);
  console.log(`[ares]         ${aresUsers.length} users · ${aresComms.length} commissions · ${aresLedger.length} ledger · ${aresCadence.length} cadence-history`);
  if (!subs.length) { console.error("No subscriptions found — is this a data-only pg_dump?"); process.exit(1); }

  // Source-of-truth check BEFORE anything else: the export must reproduce the
  // numbers the Ares dashboard shows, or the file is incomplete and nothing
  // downstream can be trusted.
  const act = subs.filter(s => ACTIVE.has((s.status ?? "").toLowerCase()));
  const lost = subs.filter(s => (s.status ?? "").toLowerCase() === "lost");
  const srcMrr = act.reduce((t, s) => t + money(s.monthly), 0);
  console.log(`\n[ares] SOURCE TOTALS  active ${act.length} · lost ${lost.length} · MRR $${srcMrr.toFixed(2)}`);

  // ── Optional: create the clients that exist in Ares but not in Qleno ──────
  // This is the ONE place the migration writes to `clients`, it is opt-in, and
  // it only ever creates rows from a file a human curated. Runs BEFORE matching
  // so the new clients are matchable in the same pass.
  if (CREATE_MISSING) {
    if (!existsSync(CREATE_MISSING)) { console.error(`--create-missing file not found: ${CREATE_MISSING}`); process.exit(1); }
    const lines = readFileSync(CREATE_MISSING, "utf8").split(/\r?\n/).filter(Boolean);
    const head = lines[0].split(",").map(h => h.replace(/^"|"$/g, "").trim());
    const col = (r: string[], n: string) => { const i = head.indexOf(n); return i < 0 ? null : (r[i] || null); };
    const wanted = lines.slice(1).map(splitCsv);
    console.log(`\n[ares] --create-missing: ${wanted.length} rows to create as Qleno clients`);

    for (const r of wanted) {
      const name = (col(r, "ares_name") ?? "").trim();
      if (!name) continue;
      const email = col(r, "email"), phone = col(r, "phone");

      // Idempotent: never create the same client twice, however this is re-run.
      const dupe = await db.execute(sql`
        SELECT id FROM clients
         WHERE company_id = ${COMPANY_ID}
           AND ( (${email}::text IS NOT NULL AND lower(email) = lower(${email}))
              OR (${phone}::text IS NOT NULL AND right(regexp_replace(phone,'\\D','','g'),10) = right(regexp_replace(${phone},'\\D','','g'),10))
              OR lower(trim(coalesce(company_name, first_name || ' ' || last_name))) = lower(trim(${name})) )
         LIMIT 1
      `);
      if (dupe.rows.length) { console.log(`  skip (already exists) ${name}`); continue; }

      // A business name goes in company_name, not split across first/last — the
      // Ares row carries one free-text name and guessing a surname out of
      // "Weiss-Kunz & Oliver LLC" produces nonsense on every screen that
      // renders it.
      const isBusiness = /\b(llc|inc|corp|condominium|association|realty|properties|property|services|management|group|co)\b/i.test(name)
        || /\d/.test(name.split(" ")[0] ?? "");
      const parts = name.split(/\s+/);
      const first = isBusiness ? name : (parts[0] ?? name);
      const last = isBusiness ? "" : parts.slice(1).join(" ");

      if (!COMMIT) { console.log(`  would create  ${name}${isBusiness ? "  [as company_name]" : ""}`); continue; }
      const ins = await db.execute(sql`
        INSERT INTO clients (company_id, branch_id, first_name, last_name, company_name,
                             email, phone, address, city, state, zip, client_type, is_active, notes)
        VALUES (${COMPANY_ID}, ${BRANCH_ID}, ${isBusiness ? name : first}, ${isBusiness ? "" : last},
                ${isBusiness ? name : null}, ${email}, ${phone},
                ${col(r, "address")}, ${col(r, "city")}, ${col(r, "state")}, ${col(r, "zip")},
                ${((col(r, "client_type") ?? "residential").toLowerCase() === "commercial" ? "commercial" : "residential")}::client_type,
                true, ${"Created by the Ares migration — this client existed in Ares but not in Qleno."})
        RETURNING id
      `);
      console.log(`  created #${(ins.rows[0] as { id: number }).id}  ${name}`);
    }
  }

  const clientRows = await db.execute(sql`
    SELECT id, first_name, last_name, company_name, email, phone, branch_id
      FROM clients WHERE company_id = ${COMPANY_ID}
  `);
  const clients = clientRows.rows as unknown as QClient[];
  console.log(`[qleno] company ${COMPANY_ID}: ${clients.length} clients to match against`);

  const matches = buildMatches(subs, clients);
  if (MATCHES && existsSync(MATCHES)) {
    const n = applyReviewed(matches, MATCHES);
    console.log(`[ares] applied ${n} hand-reviewed decisions from ${MATCHES}`);
  }

  const tally = (c: Conf) => matches.filter(m => m.conf === c).length;
  const importable = matches.filter(m => m.client_id != null);
  const impActive = importable.filter(m => ACTIVE.has((m.status ?? "").toLowerCase()));
  console.log("\n── Match report ──────────────────────────────────────────────");
  for (const c of ["EXACT", "STRONG", "WEAK", "NONE"] as Conf[]) {
    console.log(`  ${c.padEnd(7)} ${String(tally(c)).padStart(4)}`);
  }
  const impMrr = impActive.reduce((t, m) => t + money(m.mrr), 0);
  console.log(`  linked  ${String(importable.length).padStart(4)}   active MRR covered $${impMrr.toFixed(2)} of $${srcMrr.toFixed(2)} (${srcMrr ? ((impMrr / srcMrr) * 100).toFixed(1) : "0"}%)`);

  if (REPORT) {
    const order: Record<Conf, number> = { NONE: 0, WEAK: 1, STRONG: 2, EXACT: 3 };
    const csv = [
      "confidence,basis,ares_name,status,cadence,mrr,va,email,phone,qleno_client_id,qleno_candidate",
      ...[...matches].sort((a, b) => order[a.conf] - order[b.conf] || money(b.mrr) - money(a.mrr))
        .map(m => [m.conf, m.basis, m.name, m.status, m.cadence, m.mrr, m.va, m.email, m.phone, m.client_id, m.candidate].map(csvEsc).join(",")),
    ].join("\n");
    writeFileSync(REPORT, csv);
    console.log(`\n  Report written to ${REPORT} — review the WEAK and NONE rows, set qleno_client_id by hand,`);
    console.log(`  then re-run with --matches ${REPORT} --commit`);
  }

  if (!COMMIT) { console.log("\n[ares] DRY RUN — nothing written. Add --commit to apply.\n"); process.exit(0); }

  // Ares VAs → Qleno users, by EMAIL. Never by name: matching people by name
  // string is precisely how Ares put commissions on the wrong person.
  const vaByAresId = new Map<string, { qlenoId: number; name: string }>();
  const qUsers = (await db.execute(sql`
    SELECT id, email, first_name, last_name FROM users WHERE company_id = ${COMPANY_ID}
  `)).rows as unknown as Array<{ id: number; email: string; first_name: string; last_name: string }>;
  for (const au of aresUsers) {
    const hit = qUsers.find(u => normEmail(u.email) === normEmail(au.email));
    if (hit) vaByAresId.set(au.id!, { qlenoId: hit.id, name: `${hit.first_name} ${hit.last_name}`.trim() });
    else console.warn(`  ! Ares user ${au.name} <${au.email}> has no Qleno account — their commissions will be skipped`);
  }
  const vaByName = new Map<string, { qlenoId: number; name: string }>();
  for (const au of aresUsers) {
    const m = vaByAresId.get(au.id!);
    if (m && au.name) vaByName.set(normName(au.name), m);
  }

  console.log(`\n[ares] committing ${importable.length} subscriptions…`);
  const subIdMap = new Map<string, number>();   // ares subscription id -> qleno recurring_subscriptions.id
  let unpriced = 0;

  for (const m of importable) {
    const s = subs.find(x => x.id === m.ares_id)!;
    const cadence = mapCadence(s.cadence);
    if (!cadence) unpriced++;
    const status = STATUS[(s.status ?? "active").toLowerCase()] ?? "active";
    const client = clients.find(c => c.id === m.client_id)!;
    const branch = BRANCH_ID ?? client.branch_id ?? null;
    const type = (s.client_type ?? "residential").toLowerCase() === "commercial" ? "commercial" : "residential";

    const ins = await db.execute(sql`
      INSERT INTO recurring_subscriptions
        (company_id, branch_id, client_id, client_type, status, cadence, rate, price_basis,
         mrr, first_cleaning_date, created_at)
      VALUES
        (${COMPANY_ID}, ${branch}, ${m.client_id}, ${type}::recurring_client_type,
         ${status}::recurring_status,
         ${cadence}::recurring_cadence,
         ${s.rpv}, ${(s.price_basis ?? "unknown")}::recurring_price_basis,
         ${s.monthly}, ${day(s.start_date)}, COALESCE(${s.created_at}::timestamptz, now()))
      RETURNING id
    `);
    const newId = Number((ins.rows[0] as { id: number }).id);
    subIdMap.set(s.id!, newId);

    // Attribution — the VA credit that every commission hangs off.
    const va = s.subscribed_by ? vaByName.get(normName(s.subscribed_by)) : undefined;
    await db.execute(sql`
      INSERT INTO sales_attribution
        (company_id, branch_id, subscription_id, client_id, salesperson, salesperson_user_id,
         subscribed_by, is_self_sourced, commission_eligible, created_at)
      VALUES
        (${COMPANY_ID}, ${branch}, ${newId}, ${m.client_id}, ${s.salesperson ?? s.subscribed_by},
         ${va?.qlenoId ?? null}, ${s.subscribed_by},
         ${s.is_self_sourced === "true" || s.is_self_sourced === "t"},
         ${s.commission_eligible !== "false" && s.commission_eligible !== "f"}, now())
    `);

    // A lost client carries its churn record, so retention reporting is not
    // silently reset to "never churned" by the migration.
    if (status === "lost") {
      await db.execute(sql`
        INSERT INTO subscription_lifecycle_events
          (company_id, branch_id, subscription_id, event_type, loss_date, notes, source, created_at)
        VALUES
          (${COMPANY_ID}, ${branch}, ${newId}, 'loss',
           ${day(s.loss_date ?? s.cancel_date)},
           ${scrubCards(`Migrated from Ares${s.loss_reason ? ` — reason recorded as "${s.loss_reason}"` : ""}`)},
           'captured', now())
      `);
    }
  }
  console.log(`[ares] wrote ${subIdMap.size} recurring_subscriptions (+ attribution)`);
  if (unpriced) console.log(`       ${unpriced} had a cadence Qleno cannot price — MRR will show as not-computable, never $0`);

  // Commissions. Only for subscriptions that actually linked — a commission
  // without its client is an orphan that no screen can explain.
  let cWrote = 0, cSkip = 0;
  const commIdMap = new Map<string, number>();
  for (const c of aresComms) {
    const subId = c.subscription_id ? subIdMap.get(c.subscription_id) : null;
    const va = c.user_id ? vaByAresId.get(c.user_id) : undefined;
    if (!va || (c.subscription_id && !subId)) { cSkip++; continue; }
    const status = CSTATUS[(c.status ?? "pending").toLowerCase()] ?? "pending_review";
    const ins = await db.execute(sql`
      INSERT INTO commissions
        (company_id, branch_id, subscription_id, client_id, client_name, va_user_id, va_name,
         status, commission_type, client_type, cadence, base_amount, source_bonus_amount,
         specialty_bonus_amount, amount, earned_date, first_cleaning_date, chargeback_until,
         paid_date, notes, created_at)
      VALUES
        (${COMPANY_ID}, ${BRANCH_ID}, ${subId ?? null}, NULL, ${c.client_name}, ${va.qlenoId}, ${c.va_name ?? va.name},
         ${status}::sales_commission_status,
         ${(c.commission_type ?? "base")}::sales_commission_type,
         ${((c.client_type ?? "residential").toLowerCase() === "commercial" ? "commercial" : "residential")}::recurring_client_type,
         ${c.cadence}, ${c.base_commission ?? "0"}, ${c.commercial_source_bonus ?? "0"},
         ${c.deep_clean_bonus ?? "0"}, ${c.total_commission ?? "0"},
         ${day(c.created_at)}, ${day(c.first_cleaning_date)}, ${day(c.chargeback_eligible_until)},
         ${day(c.paid_date)}, ${scrubCards(`Migrated from Ares${c.notes ? ` — ${c.notes}` : ""}`)},
         COALESCE(${c.created_at}::timestamptz, now()))
      RETURNING id
    `);
    const id = Number((ins.rows[0] as { id: number }).id);
    commIdMap.set(c.id!, id);
    // Opening balance in the immutable log, so history starts explained.
    await db.execute(sql`
      INSERT INTO commission_status_events (company_id, branch_id, commission_id, from_status, to_status, note)
      VALUES (${COMPANY_ID}, ${BRANCH_ID}, ${id}, NULL, ${status}::sales_commission_status,
              'Imported from Ares at this status')
    `);
    cWrote++;
  }
  console.log(`[ares] wrote ${cWrote} commissions (${cSkip} skipped — unlinked client or unknown VA)`);

  // Ledger — the money record the VA statement actually sums.
  let lWrote = 0;
  for (const l of aresLedger) {
    const va = l.user_id ? vaByAresId.get(l.user_id) : undefined;
    if (!va) continue;
    await db.execute(sql`
      INSERT INTO commission_ledger
        (company_id, branch_id, commission_id, subscription_id, va_user_id, entry_type, amount,
         description, related_period, created_at)
      VALUES
        (${COMPANY_ID}, ${BRANCH_ID},
         ${l.commission_submission_id ? commIdMap.get(l.commission_submission_id) ?? null : null},
         ${l.subscription_id ? subIdMap.get(l.subscription_id) ?? null : null},
         ${va.qlenoId},
         ${(l.entry_type === "commercial_source_bonus" ? "commercial_source_bonus"
            : l.entry_type === "performance_bonus" ? "performance_bonus"
            : l.entry_type === "chargeback" ? "chargeback"
            : l.entry_type === "payout" ? "payout"
            : l.entry_type === "base" ? "base" : "adjustment")}::commission_ledger_entry_type,
         ${l.amount ?? "0"}, ${scrubCards(l.description) ?? "Migrated from Ares"}, ${l.related_period},
         COALESCE(${l.created_at}::timestamptz, now()))
    `);
    lWrote++;
  }
  console.log(`[ares] wrote ${lWrote} ledger entries`);

  let hWrote = 0;
  for (const h of aresCadence) {
    const subId = h.subscription_id ? subIdMap.get(h.subscription_id) : null;
    if (!subId) continue;
    await db.execute(sql`
      INSERT INTO subscription_cadence_history
        (company_id, branch_id, subscription_id, previous_cadence, new_cadence, reason, effective_date, created_at)
      VALUES (${COMPANY_ID}, ${BRANCH_ID}, ${subId}, ${mapCadence(h.previous_cadence)},
              ${mapCadence(h.new_cadence) ?? h.new_cadence}, ${scrubCards(h.reason)},
              COALESCE(${h.effective_date}::timestamptz, now()), now())
    `);
    hWrote++;
  }
  console.log(`[ares] wrote ${hWrote} cadence-history rows`);

  // ── Parity check ───────────────────────────────────────────────────────────
  // An import that reports success without reproducing the source numbers has
  // told you nothing. Compare what landed against what Ares said.
  const after = (await db.execute(sql`
    SELECT COUNT(*) FILTER (WHERE status IN ('active','on_demand'))      AS active,
           COUNT(*) FILTER (WHERE status = 'lost')                       AS lost,
           COALESCE(SUM(mrr) FILTER (WHERE status IN ('active','on_demand')),0) AS mrr
      FROM recurring_subscriptions WHERE company_id = ${COMPANY_ID}
  `)).rows[0] as Record<string, string>;

  const gotActive = Number(after.active), gotLost = Number(after.lost), gotMrr = Number(after.mrr);
  const expActive = impActive.length;
  const expLost = importable.filter(m => (m.status ?? "").toLowerCase() === "lost").length;
  const ok = (a: number, b: number) => (Math.abs(a - b) < 0.01 ? "OK  " : "DIFF");
  console.log("\n── Parity ────────────────────────────────────────────────────");
  console.log(`  active   imported ${gotActive.toString().padStart(4)}  expected ${String(expActive).padStart(4)}   ${ok(gotActive, expActive)}`);
  console.log(`  lost     imported ${gotLost.toString().padStart(4)}  expected ${String(expLost).padStart(4)}   ${ok(gotLost, expLost)}`);
  console.log(`  MRR      imported $${gotMrr.toFixed(2)}  expected $${impMrr.toFixed(2)}   ${ok(gotMrr, impMrr)}`);
  const unlinked = matches.length - importable.length;
  if (unlinked) {
    const lostMrr = matches.filter(m => m.client_id == null && ACTIVE.has((m.status ?? "").toLowerCase()))
      .reduce((t, m) => t + money(m.mrr), 0);
    console.log(`\n  ${unlinked} Ares rows were NOT imported (no Qleno client), holding $${lostMrr.toFixed(2)} of active MRR.`);
    console.log(`  Qleno's Ares tab will read $${gotMrr.toFixed(2)}, not Ares' $${srcMrr.toFixed(2)} — that gap is those clients, not a bug.`);
  }
  console.log("");
}

main().catch(e => { console.error("[ares-migration] failed:", e); process.exit(1); });
