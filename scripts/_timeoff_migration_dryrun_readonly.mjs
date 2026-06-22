// READ-ONLY time-off migration DRY-RUN for Oak Lawn (co1). SELECT only.
// NO writes. Produces the per-employee × bucket diff (eligibility, granted,
// used, remaining) for Sal's sign-off BEFORE any balance is written.
//
// Granted   = engine entitlement (mirrors lib/leave-grant-reset.ts):
//             PLAWA 40 after 90d; PTO 40 after 1yr, 80 after 2yr; Unpaid 40 day-one.
// Used      = derived from Qleno additional_pay (Sal's chosen source):
//             sick_pay → PLAWA, vacation_pay → PTO. Hours parsed from the
//             "(Xh)" note when present, else amount ÷ $20/h (the apparent
//             standard day rate). holiday_pay is a SEPARATE benefit, not a
//             bucket — reported, not deducted. WINDOW = each employee's
//             current BENEFIT YEAR (most recent hire anniversary → today),
//             since the reset basis is work_anniversary (Sal 2026-06-20).
// Remaining = max(0, granted - used).
import pg from '/Users/salvadormartinez/qleno/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js';
import { readFileSync } from 'node:fs';

const env = readFileSync('/Users/salvadormartinez/qleno/.env', 'utf8');
const url = env.split('\n').find(l => l.startsWith('DATABASE_URL='))?.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
if (!url) { console.error('no DATABASE_URL'); process.exit(1); }

const ASOF = '2026-06-20';      // today; calendar-year reset basis (Sal 2026-06-20)
const LEAVE_RATE = 20;          // $/h fallback for dollars→hours (flagged for Sal)
const CEILING = 80;

// MC-authoritative roster (hire dates Sal pulled) mapped to Qleno user ids
// from the Phase-1 reconciliation. Alejandra uses the MC-correct 2025-08-01
// (Qleno still has the wrong 2023-05-11 — fix tracked separately).
const ROSTER = [
  { uid: 36, name: 'Rosa Gallegos', hire: '2020-04-01' },
  { uid: 35, name: 'Maribel Castillo', hire: '2023-02-21', office: true },
  { uid: 32, name: 'Norma Puga', hire: '2023-05-11' },
  { uid: 37, name: 'Francisco Estevez', hire: '2024-06-03', office: true },
  { uid: 38, name: 'Diana Vasquez', hire: '2024-06-18' },
  { uid: 39, name: 'Alma Salinas', hire: '2025-06-03' },
  { uid: 40, name: 'Guadalupe Mejia', hire: '2025-06-11' },
  { uid: 41, name: 'Alejandra Cuervo', hire: '2025-08-01' },
  { uid: 42, name: 'Juliana Loredo', hire: '2026-01-26' },
  { uid: 44, name: 'Jose Ardila', hire: '2026-05-01' },
  { uid: 516, name: 'Hilda Gallegos', hire: '2026-05-25' },
  // Resolved (Sal 2026-06-20): include Maryury (real active co1 tech, just
  // post-dated the MC list pull). Owner (Sal, uid 1) EXCLUDED from accrual;
  // office staff (Maribel, Francisco) INCLUDED.
  { uid: 817, name: 'Maryury Colmenares', hire: '2026-06-16' },
];

const daysBetween = (a, b) => Math.floor((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
function completedYears(hire, asOf) {
  const h = new Date(`${hire}T00:00:00Z`), a = new Date(`${asOf}T00:00:00Z`);
  let y = a.getUTCFullYear() - h.getUTCFullYear();
  const anniv = new Date(Date.UTC(a.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate()));
  if (a < anniv) y -= 1;
  return Math.max(0, y);
}
const plawaGrant = hire => (daysBetween(hire, ASOF) >= 90 ? 40 : 0);
const ptoGrant = hire => (daysBetween(hire, ASOF) >= 365 ? (completedYears(hire, ASOF) >= 2 ? CEILING : 40) : 0);
const unpaidGrant = () => 40;
// Most recent hire-anniversary on/before ASOF = start of current benefit year.
function benefitYearStart(hire, asOf) {
  const h = new Date(`${hire}T00:00:00Z`), a = new Date(`${asOf}T00:00:00Z`);
  let anniv = new Date(Date.UTC(a.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate()));
  if (anniv > a) anniv = new Date(Date.UTC(a.getUTCFullYear() - 1, h.getUTCMonth(), h.getUTCDate()));
  return anniv.toISOString().slice(0, 10);
}

// hours from an additional_pay row: "(Xh)" note first, else amount/$20
function rowHours(amount, notes) {
  const m = (notes || '').match(/\((\d+(?:\.\d+)?)\s*h\)/i);
  if (m) return { hrs: parseFloat(m[1]), src: 'note' };
  return { hrs: Math.round((parseFloat(amount) / LEAVE_RATE) * 100) / 100, src: '$/' + LEAVE_RATE };
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

// time-off additional_pay for the roster (wide window; filtered per
// employee's benefit-year start below — work-anniversary reset basis)
const uids = ROSTER.map(r => r.uid);
const bysByUid = Object.fromEntries(ROSTER.map(r => [r.uid, benefitYearStart(r.hire, ASOF)]));
const ap = await client.query(`
  SELECT user_id, lower(type) AS type, amount, notes, created_at::date AS created
  FROM additional_pay
  WHERE company_id = 1 AND COALESCE(status,'pending') <> 'voided'
    AND created_at >= '2024-01-01'
    AND lower(type) IN ('sick_pay','vacation_pay','holiday_pay')
    AND user_id = ANY($1::int[])
  ORDER BY user_id, type`, [uids]);

const used = {}; // uid → { plawa, pto, holiday }
for (const u of uids) used[u] = { plawa: 0, pto: 0, holiday: 0 };
const derivation = [];
for (const r of ap.rows) {
  const createdStr = (r.created instanceof Date ? r.created.toISOString().slice(0, 10) : String(r.created).slice(0, 10));
  const inBenefitYear = createdStr >= bysByUid[r.user_id];
  const { hrs, src } = rowHours(r.amount, r.notes);
  const bucket = r.type === 'sick_pay' ? 'plawa' : r.type === 'vacation_pay' ? 'pto' : 'holiday';
  if (inBenefitYear) used[r.user_id][bucket] += hrs;
  derivation.push({ uid: r.user_id, type: r.type, created: createdStr, in_BY: inBenefitYear ? 'yes' : 'PRIOR', amount: r.amount, hrs, via: src });
}

console.log(`\n=== TIME-OFF MIGRATION DRY-RUN (co1 / Oak Lawn) — as of ${ASOF}, WORK-ANNIVERSARY reset ===`);
console.log('granted = engine entitlement; used = current-benefit-year additional_pay (sick→PLAWA, vacation→PTO); remaining = max(0, granted-used)\n');

const out = [];
for (const e of ROSTER) {
  const bys = benefitYearStart(e.hire, ASOF);
  const buckets = [
    { slug: 'PLAWA (sick)', granted: plawaGrant(e.hire), used: round(used[e.uid].plawa) },
    { slug: 'PTO', granted: ptoGrant(e.hire), used: round(used[e.uid].pto) },
    { slug: 'Unpaid', granted: unpaidGrant(), used: 0 },
  ];
  for (const b of buckets) {
    const eligible = b.granted > 0 || b.slug === 'Unpaid';
    const remaining = Math.max(0, round(b.granted - b.used));
    const over = b.used > b.granted ? '  ⚠ used>granted' : '';
    // Leave pays $20/hr flat on approval (sick + PTO). Unpaid = $0.
    const paid = b.slug === 'PLAWA (sick)' || b.slug === 'PTO';
    out.push({
      employee: e.name + (e.office ? ' (office)' : ''),
      hire: e.hire,
      benefit_yr: bys,
      bucket: b.slug,
      eligible: eligible ? 'yes' : 'NO',
      granted: b.granted,
      used: b.used,
      remaining: remaining + over,
      'rem_$@20': paid ? `$${(remaining * LEAVE_RATE).toFixed(0)}` : '—',
    });
  }
}
console.table(out);

console.log('\n=== USED-HOURS DERIVATION (from 2026 additional_pay) ===');
console.table(derivation);

console.log('\n=== FLAGS ===');
console.log('• Alejandra Cuervo (uid 41): dry-run uses MC hire 2025-08-01; Qleno DB still has 2023-05-11 (WRONG) — fix before write.');
console.log('• RESOLVED (Sal 2026-06-20): Maryury Colmenares (uid 817) INCLUDED; owner (Sal, uid 1) EXCLUDED from accrual; office staff (Maribel, Francisco) INCLUDED.');
console.log(`• RESOLVED: leave pays a FLAT $${LEAVE_RATE}/hr (company floor) on approval. rem_$@20 = remaining hours × $${LEAVE_RATE} (sick + PTO; unpaid = $0). Dollars→hours of past usage also normalized at $${LEAVE_RATE}/h where note lacked "(Xh)".`);
console.log('• holiday_pay reported in derivation but NOT a balance bucket (separate 8h benefit) — not deducted.');
console.log('• Unpaid personal: granted 40 day-one, used 0 (no additional_pay maps to it; tracked going forward).');
console.log('• WORK-ANNIVERSARY basis: "used" counts only additional_pay in the current benefit year (since benefit_yr). Entries before it (in_BY=PRIOR) are last year — NOT deducted. This is why Norma (anniv 5/11) shows ~0 used despite Jan–Mar PTO.');

await client.end();
function round(n) { return Math.round(n * 100) / 100; }
