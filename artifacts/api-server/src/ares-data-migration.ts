/**
 * [ares-migration 2026-08-18] Import the legacy Ares data into Qleno.
 *
 * Ares ran its own Postgres with its own root `subscriptions` table — 48
 * columns holding BOTH the customer (name, address, phone, email) and the
 * recurring-revenue state (cadence, rate, status, VA attribution). Qleno
 * already owns the customer. So this migration deliberately imports only the
 * SECOND half: it matches each Ares subscription to an existing Qleno client
 * and writes the Ares-owned state into the module's own additive tables.
 *
 * It NEVER creates or edits a client. If a subscription has no confident match,
 * it is reported and skipped — inventing a customer record to make an import
 * succeed is how you end up with a duplicate book.
 *
 * DRY RUN BY DEFAULT. Nothing is written without --commit.
 *
 *   tsx src/ares-data-migration.ts --file ares-data.sql --company 1
 *   tsx src/ares-data-migration.ts --file ares-data.sql --company 1 --report matches.csv
 *   tsx src/ares-data-migration.ts --file ares-data.sql --company 1 --commit
 *
 * Match confidence, highest first. Only EXACT and STRONG are imported.
 *   EXACT   email equal, or phone (last 10 digits) equal
 *   STRONG  normalised full name equal, unique in the company
 *   WEAK    name matched more than one client, or only a partial token match
 *   NONE    nothing plausible
 */

import { readFileSync, writeFileSync } from "node:fs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const flag = (name: string) => argv.includes(`--${name}`);

const FILE = arg("file");
const COMPANY_ID = Number(arg("company") ?? NaN);
const BRANCH_ID = arg("branch") ? Number(arg("branch")) : null;
const REPORT = arg("report");
const COMMIT = flag("commit");

if (!FILE || !Number.isFinite(COMPANY_ID)) {
  console.error("usage: tsx src/ares-data-migration.ts --file <dump.sql> --company <id> [--branch <id>] [--report out.csv] [--commit]");
  process.exit(1);
}

// ── pg_dump COPY parser ──────────────────────────────────────────────────────
// `pg_dump --data-only` emits, per table:
//   COPY public.subscriptions (col, col, …) FROM stdin;
//   tab\tseparated\tvalues
//   \.
// Values are tab-delimited with \N for NULL and backslash escapes.

type Row = Record<string, string | null>;

function parseDump(text: string): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^COPY\s+(?:[\w"]+\.)?"?(\w+)"?\s*\(([^)]*)\)\s+FROM stdin;/i);
    if (!m) { i++; continue; }
    const table = m[1];
    const cols = m[2].split(",").map(c => c.trim().replace(/^"|"$/g, ""));
    const rows: Row[] = [];
    i++;
    while (i < lines.length && lines[i] !== "\\.") {
      if (lines[i] !== "") {
        const vals = lines[i].split("\t");
        const row: Row = {};
        cols.forEach((c, k) => {
          const v = vals[k];
          row[c] = v === undefined || v === "\\N" ? null
            : v.replace(/\\t/g, "\t").replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\\\/g, "\\");
        });
        rows.push(row);
      }
      i++;
    }
    out.set(table, (out.get(table) ?? []).concat(rows));
    i++;
  }
  return out;
}

// ── Normalisers ──────────────────────────────────────────────────────────────

const normName = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().normalize("NFKD").replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();

const normEmail = (s: string | null | undefined) => (s ?? "").toLowerCase().trim();

// Last 10 digits — the only part of a US number that is reliably comparable.
const normPhone = (s: string | null | undefined) => {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
};

// Ares stores one free-text name; Qleno stores first + last (+ company). Compare
// as a bag of tokens so "Smith, John" and "John Smith" agree.
const tokens = (s: string) => new Set(normName(s).split(" ").filter(t => t.length > 1));
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / (a.size + b.size - hit);
};

// ── Cadence: Ares' free text → Qleno's recurring_cadence keys ────────────────

const CADENCE_MAP: Record<string, string> = {
  weekly: "weekly", biweekly: "biweekly", bi_weekly: "biweekly",
  every_other_week: "biweekly", semi_monthly: "semi_monthly", semimonthly: "semi_monthly",
  every_3_weeks: "every_3_weeks", every3weeks: "every_3_weeks", tri_weekly: "every_3_weeks",
  every_5_weeks: "every_5_weeks", every_6_weeks: "every_6_weeks", every_8_weeks: "every_8_weeks",
  monthly: "monthly", quarterly: "quarterly", custom: "custom", weekdays: "weekdays",
};
function mapCadence(raw: string | null): string | null {
  if (!raw) return null;
  const k = raw.toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (CADENCE_MAP[k]) return CADENCE_MAP[k];
  const n = k.match(/every_?(\d+)_?weeks?/);
  if (n) {
    const v = Number(n[1]);
    if (v === 1) return "weekly";
    if (v === 2) return "biweekly";
    return `every_${v}_weeks`;
  }
  return null;
}

// Ares status → Qleno recurring_status. Ares' "notice" has no Qleno equivalent;
// a client serving notice is still active until their final service date, which
// is how Ares counted them in MRR, so that is what they become here.
const STATUS_MAP: Record<string, string> = {
  active: "active", paused: "paused", lost: "lost",
  "on-demand": "on_demand", "on demand": "on_demand", on_demand: "on_demand",
  notice: "active", canceled: "lost", cancelled: "lost",
};

// ── Matching ─────────────────────────────────────────────────────────────────

interface QlenoClient {
  id: number; first_name: string; last_name: string; company_name: string | null;
  email: string | null; phone: string | null; branch_id: number | null;
}
type Confidence = "EXACT" | "STRONG" | "WEAK" | "NONE";
interface Match {
  ares_id: string; ares_client: string; ares_email: string | null; ares_phone: string | null;
  ares_status: string | null; ares_cadence: string | null; ares_mrr: string | null;
  client_id: number | null; client_label: string | null;
  confidence: Confidence; basis: string; candidates: number;
}

function matchOne(sub: Row, clients: QlenoClient[], byEmail: Map<string, QlenoClient[]>, byPhone: Map<string, QlenoClient[]>): Match {
  const base = {
    ares_id: sub.id ?? "", ares_client: sub.client ?? "",
    ares_email: sub.email, ares_phone: sub.phone,
    ares_status: sub.status, ares_cadence: sub.cadence, ares_mrr: sub.monthly,
  };
  const label = (c: QlenoClient) =>
    `${c.company_name || `${c.first_name} ${c.last_name}`.trim()} (#${c.id})`;

  const e = normEmail(sub.email);
  if (e) {
    const hit = byEmail.get(e);
    if (hit?.length === 1) return { ...base, client_id: hit[0].id, client_label: label(hit[0]), confidence: "EXACT", basis: "email", candidates: 1 };
    if (hit && hit.length > 1) return { ...base, client_id: null, client_label: hit.map(label).join(" | "), confidence: "WEAK", basis: "email matched several clients", candidates: hit.length };
  }

  const p = normPhone(sub.phone);
  if (p) {
    const hit = byPhone.get(p);
    if (hit?.length === 1) return { ...base, client_id: hit[0].id, client_label: label(hit[0]), confidence: "EXACT", basis: "phone", candidates: 1 };
    if (hit && hit.length > 1) return { ...base, client_id: null, client_label: hit.map(label).join(" | "), confidence: "WEAK", basis: "phone matched several clients", candidates: hit.length };
  }

  const want = normName(sub.client);
  if (!want) return { ...base, client_id: null, client_label: null, confidence: "NONE", basis: "Ares row has no client name", candidates: 0 };

  const exactName = clients.filter(c =>
    normName(`${c.first_name} ${c.last_name}`) === want || normName(c.company_name) === want);
  if (exactName.length === 1) return { ...base, client_id: exactName[0].id, client_label: label(exactName[0]), confidence: "STRONG", basis: "exact name", candidates: 1 };
  if (exactName.length > 1) return { ...base, client_id: null, client_label: exactName.map(label).join(" | "), confidence: "WEAK", basis: `name matched ${exactName.length} clients`, candidates: exactName.length };

  const wantTok = tokens(sub.client ?? "");
  let best: { c: QlenoClient; score: number } | null = null;
  for (const c of clients) {
    const s = Math.max(
      jaccard(wantTok, tokens(`${c.first_name} ${c.last_name}`)),
      jaccard(wantTok, tokens(c.company_name ?? "")),
    );
    if (!best || s > best.score) best = { c, score: s };
  }
  if (best && best.score >= 0.6) {
    return { ...base, client_id: null, client_label: label(best.c), confidence: "WEAK", basis: `partial name match (${best.score.toFixed(2)})`, candidates: 1 };
  }
  return { ...base, client_id: null, client_label: best ? label(best.c) : null, confidence: "NONE", basis: best ? `closest was ${best.score.toFixed(2)}` : "no candidates", candidates: 0 };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[ares-migration] reading ${FILE}`);
  const tables = parseDump(readFileSync(FILE!, "utf8"));
  const subs = tables.get("subscriptions") ?? [];
  const aresUsers = tables.get("users") ?? [];
  const aresCommissions = tables.get("commission_submissions") ?? [];
  console.log(`[ares-migration] parsed: ${subs.length} subscriptions, ${aresUsers.length} users, ${aresCommissions.length} commissions`);
  if (!subs.length) { console.error("No `subscriptions` COPY block found — is this a --data-only dump?"); process.exit(1); }

  const clientRows = await db.execute(sql`
    SELECT id, first_name, last_name, company_name, email, phone, branch_id
      FROM clients WHERE company_id = ${COMPANY_ID}
  `);
  const clients = clientRows.rows as unknown as QlenoClient[];
  console.log(`[ares-migration] company ${COMPANY_ID} has ${clients.length} clients to match against`);

  const byEmail = new Map<string, QlenoClient[]>();
  const byPhone = new Map<string, QlenoClient[]>();
  for (const c of clients) {
    const e = normEmail(c.email); if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), c]);
    const p = normPhone(c.phone); if (p) byPhone.set(p, [...(byPhone.get(p) ?? []), c]);
  }

  const matches = subs.map(s => matchOne(s, clients, byEmail, byPhone));

  // One Qleno client must not receive two Ares subscriptions — that would double
  // its MRR. Demote the later duplicates rather than silently importing both.
  const claimed = new Map<number, string>();
  for (const m of matches) {
    if (m.client_id == null) continue;
    const prior = claimed.get(m.client_id);
    if (prior) {
      m.confidence = "WEAK";
      m.basis = `client already matched by Ares row ${prior} — would double-count MRR`;
      m.client_id = null;
    } else claimed.set(m.client_id, m.ares_id);
  }

  const tally = (c: Confidence) => matches.filter(m => m.confidence === c).length;
  console.log("\n── Match report ──────────────────────────────────────────────");
  console.log(`  EXACT   ${String(tally("EXACT")).padStart(4)}   email or phone — will import`);
  console.log(`  STRONG  ${String(tally("STRONG")).padStart(4)}   unique exact name — will import`);
  console.log(`  WEAK    ${String(tally("WEAK")).padStart(4)}   ambiguous — SKIPPED, needs a human`);
  console.log(`  NONE    ${String(tally("NONE")).padStart(4)}   no candidate — SKIPPED`);
  console.log(`  ─────────────`);
  console.log(`  total   ${String(matches.length).padStart(4)}`);

  const importable = matches.filter(m => m.confidence === "EXACT" || m.confidence === "STRONG");
  const mrrIn = importable.reduce((t, m) => t + Number(m.ares_mrr ?? 0), 0);
  const mrrAll = matches.reduce((t, m) => t + Number(m.ares_mrr ?? 0), 0);
  console.log(`\n  MRR covered: $${mrrIn.toFixed(2)} of $${mrrAll.toFixed(2)} (${mrrAll ? ((mrrIn / mrrAll) * 100).toFixed(1) : "0"}%)`);

  if (REPORT) {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [
      "confidence,basis,ares_id,ares_client,ares_email,ares_phone,ares_status,ares_cadence,ares_mrr,qleno_client_id,qleno_client",
      ...matches
        .sort((a, b) => ["NONE", "WEAK", "STRONG", "EXACT"].indexOf(a.confidence) - ["NONE", "WEAK", "STRONG", "EXACT"].indexOf(b.confidence))
        .map(m => [m.confidence, m.basis, m.ares_id, m.ares_client, m.ares_email, m.ares_phone,
                   m.ares_status, m.ares_cadence, m.ares_mrr, m.client_id, m.client_label].map(esc).join(",")),
    ].join("\n");
    writeFileSync(REPORT, csv);
    console.log(`\n  Full match report written to ${REPORT} — review the WEAK and NONE rows before committing.`);
  }

  if (!COMMIT) {
    console.log("\n[ares-migration] DRY RUN — nothing written. Re-run with --commit to apply.");
    process.exit(0);
  }

  console.log(`\n[ares-migration] committing ${importable.length} subscriptions…`);
  let wrote = 0;
  for (const m of importable) {
    const sub = subs.find(s => s.id === m.ares_id)!;
    const cadence = mapCadence(sub.cadence);
    const status = STATUS_MAP[(sub.status ?? "active").toLowerCase()] ?? "active";
    const client = clients.find(c => c.id === m.client_id)!;

    await db.execute(sql`
      INSERT INTO recurring_subscriptions
        (company_id, branch_id, client_id, client_type, status, cadence, rate, price_basis,
         mrr, first_cleaning_date, created_at)
      VALUES
        (${COMPANY_ID}, ${BRANCH_ID ?? client.branch_id}, ${m.client_id},
         ${(sub.client_type ?? "residential").toLowerCase() === "commercial" ? "commercial" : "residential"},
         ${status}::recurring_status,
         ${cadence}::recurring_cadence,
         ${sub.rpv}, ${(sub.price_basis ?? "unknown")}::recurring_price_basis,
         ${sub.monthly}, ${sub.start_date}, COALESCE(${sub.created_at}::timestamp, now()))
    `);
    wrote++;
  }
  console.log(`[ares-migration] wrote ${wrote} recurring_subscriptions.`);
  console.log("[ares-migration] Commissions are NOT imported by this pass — run the");
  console.log("                 commission import only after these matches are signed off,");
  console.log("                 because every commission hangs off a subscription id.");
}

main().catch(e => { console.error("[ares-migration] failed:", e); process.exit(1); });
