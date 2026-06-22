/**
 * MaidCentral → Qleno time-off LOADER (co1).
 *
 * Ingests the verified MC dataset and cascades it into the 3A leave tables:
 *   1. START DATES   → users.hire_date corrections (eligibility depends on it).
 *   2. BALANCES      → employee_leave_balances (granted_hours + used_hours),
 *                      upsert on (company_id, user_id, leave_type_id).
 *                      last_reset_at = the employee's current benefit-year start
 *                      (work anniversary ≤ as_of) so the accrual cron does NOT
 *                      immediately re-reset the imported balance.
 *   3. HISTORY       → employee_leave_usage rows (date_used, hours, notes),
 *                      deduped, prefixed "[MC import]".
 *
 * DRY-RUN BY DEFAULT — prints the full diff and writes NOTHING. Pass --apply
 * to write (wrapped in a transaction). Do NOT --apply until Sal signs off on
 * the dry-run. Idempotent: balances upsert; hire dates set; history NOT-EXISTS
 * deduped — safe to re-run.
 *
 * Usage:
 *   node scripts/timeoff-mc-loader.mjs --dataset path/to/mc.json            # dry-run
 *   node scripts/timeoff-mc-loader.mjs --dataset path/to/mc.json --apply    # write (HELD)
 *   node scripts/timeoff-mc-loader.mjs                                      # print expected schema
 *
 * Expected dataset JSON (see SCHEMA banner printed when --dataset is omitted).
 */
import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const datasetPath = args[(args.indexOf("--dataset") + 1) || -1];
const APPLY = args.includes("--apply");
const COMPANY = Number(args[(args.indexOf("--company") + 1) || -1]) || 1;

// Dataset bucket alias → Qleno co1 leave_types slug.
const BUCKET_TO_SLUG = {
  plawa: "plawa", sick: "plawa", sick_pay: "plawa", any_reason: "plawa",
  pto: "pto_phes", vacation: "pto_phes", vacation_pay: "pto_phes", pto_phes: "pto_phes",
  unpaid: "unpaid_leave", unpaid_personal: "unpaid_leave", personal: "unpaid_leave", unpaid_leave: "unpaid_leave",
};

const SCHEMA = `
Expected MC dataset JSON (the format the loader ingests):

{
  "as_of": "2026-06-20",            // date the MC balances were captured
  "company_id": 1,                   // Phes / Oak Lawn
  "employees": [
    {
      "match": { "qleno_user_id": 41, "name": "Alejandra Cuervo", "email": "..." },
      "mc_employee_id": 42877,       // for the audit trail (optional)
      "hire_date": "2025-08-01",     // MC start date (drives eligibility) — REQUIRED
      "balances": [
        // bucket ∈ {plawa|sick, pto|vacation, unpaid|personal}
        { "bucket": "plawa",  "granted_hours": 40, "used_hours": 29, "available_hours": 11 },
        { "bucket": "pto",    "granted_hours": 0,  "used_hours": 0,  "available_hours": 0  },
        { "bucket": "unpaid", "granted_hours": 40, "used_hours": 0,  "available_hours": 40 }
      ],
      "history": [
        { "bucket": "plawa", "date_used": "2026-01-07", "hours": 7, "notes": "Fever 11am-6pm" },
        { "bucket": "pto",   "date_used": "2025-09-15", "hours": 8, "notes": "Vacation day" }
      ]
    }
  ]
}

Notes:
- match: provide qleno_user_id (preferred). name/email used only as a fallback + sanity check.
- balances: one row per bucket the employee has. available_hours is validated against granted-used.
- history: optional but Sal wants it — each row → employee_leave_usage (date_used, hours, notes).
- buckets map: plawa/sick→PLAWA, pto/vacation→PTO, unpaid/personal→Unpaid Leave.
`;

if (!datasetPath || args.includes("--help")) {
  console.log(SCHEMA);
  console.log(`Run with --dataset <path> for a dry-run; add --apply to write (HELD for sign-off).`);
  process.exit(0);
}

// ── benefit-year start (work anniversary ≤ asOf) — matches the engine ──
function benefitYearStart(hire, asOf) {
  const h = new Date(`${hire}T00:00:00Z`), a = new Date(`${asOf}T00:00:00Z`);
  let anniv = new Date(Date.UTC(a.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate()));
  if (anniv > a) anniv = new Date(Date.UTC(a.getUTCFullYear() - 1, h.getUTCMonth(), h.getUTCDate()));
  return anniv.toISOString().slice(0, 10);
}
const r2 = (n) => Math.round(Number(n) * 100) / 100;

const ds = JSON.parse(readFileSync(datasetPath, "utf8"));
const asOf = ds.as_of || new Date().toISOString().slice(0, 10);
const companyId = ds.company_id || COMPANY;

const env = readFileSync("/Users/salvadormartinez/qleno/.env", "utf8");
const url = env.split("\n").find((l) => l.startsWith("DATABASE_URL=")).slice(13).trim().replace(/^["']|["']$/g, "");
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

// Resolve leave_types (slug → id) and users for the company.
const ltRows = (await client.query(`SELECT id, slug, display_name, is_paid FROM leave_types WHERE company_id=$1 AND active=true`, [companyId])).rows;
const slugToType = Object.fromEntries(ltRows.map((r) => [r.slug, r]));
const users = (await client.query(`SELECT id, first_name, last_name, lower(email) email, hire_date::text hire, is_active, company_id FROM users WHERE company_id=$1`, [companyId])).rows;
const byId = new Map(users.map((u) => [u.id, u]));
const byEmail = new Map(users.filter((u) => u.email).map((u) => [u.email, u]));
const byName = new Map(users.map((u) => [`${(u.first_name || "").toLowerCase()} ${(u.last_name || "").toLowerCase()}`.trim(), u]));

const hireFixes = [], balanceUpserts = [], historyInserts = [], flags = [];

for (const e of ds.employees || []) {
  const m = e.match || {};
  let u = m.qleno_user_id ? byId.get(m.qleno_user_id) : null;
  if (!u && m.email) u = byEmail.get(String(m.email).toLowerCase());
  if (!u && m.name) u = byName.get(String(m.name).toLowerCase());
  if (!u) { flags.push(`UNMATCHED employee: ${JSON.stringify(m)} — skipped`); continue; }
  if (!u.is_active) flags.push(`${u.first_name} ${u.last_name} (uid ${u.id}) is INACTIVE — included anyway, confirm`);

  // 1. hire-date correction
  if (e.hire_date && e.hire_date !== u.hire) {
    hireFixes.push({ uid: u.id, name: `${u.first_name} ${u.last_name}`, qleno_hire: u.hire, mc_hire: e.hire_date });
  }
  const effHire = e.hire_date || u.hire;
  const lastReset = effHire ? benefitYearStart(effHire, asOf) : null;

  // 2. balances
  for (const b of e.balances || []) {
    const slug = BUCKET_TO_SLUG[String(b.bucket).toLowerCase()];
    const lt = slug ? slugToType[slug] : null;
    if (!lt) { flags.push(`${u.first_name} ${u.last_name}: unknown bucket "${b.bucket}" — balance skipped`); continue; }
    const granted = r2(b.granted_hours ?? 0), used = r2(b.used_hours ?? 0);
    const avail = r2(granted - used);
    if (b.available_hours != null && r2(b.available_hours) !== avail) {
      flags.push(`${u.first_name} ${u.last_name}/${slug}: available mismatch (dataset ${b.available_hours} vs granted-used ${avail}) — using granted/used`);
    }
    balanceUpserts.push({ uid: u.id, name: `${u.first_name} ${u.last_name}`, slug, leave_type_id: lt.id, granted, used, available: avail, last_reset_at: lastReset });
  }

  // 3. history
  for (const h of e.history || []) {
    const hrs = r2(h.hours ?? 0);
    if (!(hrs > 0) || !h.date_used) { flags.push(`${u.first_name} ${u.last_name}: bad history row ${JSON.stringify(h)} — skipped`); continue; }
    const bucket = BUCKET_TO_SLUG[String(h.bucket || "").toLowerCase()] || h.bucket || "leave";
    historyInserts.push({ uid: u.id, name: `${u.first_name} ${u.last_name}`, date_used: h.date_used, hours: hrs, notes: `[MC import] ${bucket}${h.notes ? `: ${h.notes}` : ""}` });
  }
}

console.log(`\n=== MC TIME-OFF LOADER — co${companyId}, as_of ${asOf} — ${APPLY ? "APPLY (WRITING)" : "DRY-RUN (no writes)"} ===`);
console.log(`employees in dataset: ${(ds.employees || []).length}`);

console.log(`\n--- 1. HIRE-DATE CORRECTIONS (${hireFixes.length}) ---`);
console.table(hireFixes);
console.log(`\n--- 2. BALANCE UPSERTS (${balanceUpserts.length}) ---`);
console.table(balanceUpserts);
console.log(`\n--- 3. HISTORY INSERTS (${historyInserts.length}) --- (showing first 25)`);
console.table(historyInserts.slice(0, 25));
console.log(`\n--- FLAGS (${flags.length}) ---`);
flags.forEach((f) => console.log("  •", f));

if (!APPLY) {
  console.log(`\nDRY-RUN complete. No writes. Re-run with --apply to write (after Sal sign-off).`);
  await client.end();
  process.exit(0);
}

// ── APPLY (transactional) ──
console.log(`\nAPPLYING…`);
await client.query("BEGIN");
try {
  for (const f of hireFixes) {
    await client.query(`UPDATE users SET hire_date=$1 WHERE id=$2 AND company_id=$3`, [f.mc_hire, f.uid, companyId]);
  }
  for (const b of balanceUpserts) {
    await client.query(
      `INSERT INTO employee_leave_balances (company_id, user_id, leave_type_id, granted_hours, used_hours, last_reset_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, NOW(), NOW())
       ON CONFLICT (company_id, user_id, leave_type_id)
       DO UPDATE SET granted_hours=EXCLUDED.granted_hours, used_hours=EXCLUDED.used_hours, last_reset_at=EXCLUDED.last_reset_at, updated_at=NOW()`,
      [companyId, b.uid, b.leave_type_id, b.granted.toFixed(2), b.used.toFixed(2), b.last_reset_at ? `${b.last_reset_at}T12:00:00Z` : null],
    );
  }
  for (const h of historyInserts) {
    await client.query(
      `INSERT INTO employee_leave_usage (company_id, employee_id, date_used, hours, notes, logged_by, created_at)
       SELECT $1,$2,$3,$4,$5,NULL,NOW()
        WHERE NOT EXISTS (
          SELECT 1 FROM employee_leave_usage
           WHERE company_id=$1 AND employee_id=$2 AND date_used=$3 AND hours=$4 AND notes=$5)`,
      [companyId, h.uid, h.date_used, h.hours.toFixed(2), h.notes],
    );
  }
  await client.query("COMMIT");
  console.log(`APPLIED: ${hireFixes.length} hire fixes, ${balanceUpserts.length} balances, ${historyInserts.length} history rows.`);
} catch (err) {
  await client.query("ROLLBACK");
  console.error("APPLY FAILED — rolled back:", err.message);
  process.exitCode = 1;
}
await client.end();
