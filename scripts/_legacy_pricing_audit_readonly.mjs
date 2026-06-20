// READ-ONLY legacy-pricing audit. NO writes. Throwaway diagnostic.
// Phase 1: residential recurring clients (co1) with a job in May/June 2026,
// stored agreed price vs current-engine price, flag legacy/custom-priced.
import pg from '/Users/salvadormartinez/qleno/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js';
import { readFileSync } from 'node:fs';

const env = readFileSync('/Users/salvadormartinez/qleno/.env', 'utf8');
const url = env.split('\n').find(l => l.startsWith('DATABASE_URL='))?.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
if (!url) { console.error('no DATABASE_URL'); process.exit(1); }
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const CO1 = 1;
const q = (text, params) => client.query(text, params).then(r => r.rows);

// 0. sanity: companies
console.log('=== COMPANIES ===');
console.table(await q(`SELECT id, name FROM companies ORDER BY id`));

// 1. pricing catalog snapshot for co1
console.log('\n=== co1 pricing_scopes ===');
console.table(await q(`SELECT id, name, scope_group, pricing_method, hourly_rate, minimum_bill, is_active FROM pricing_scopes WHERE company_id=$1 ORDER BY id`, [CO1]));

console.log('\n=== co1 pricing_frequencies ===');
console.table(await q(`SELECT scope_id, frequency, multiplier, rate_override FROM pricing_frequencies WHERE company_id=$1 ORDER BY scope_id, frequency`, [CO1]));

console.log('\n=== co1 pricing_tiers ===');
console.table(await q(`SELECT scope_id, min_sqft, max_sqft, hours FROM pricing_tiers WHERE company_id=$1 ORDER BY scope_id, min_sqft`, [CO1]));

// 2. distinct service_type values used by co1 residential recurring schedules feeding May/Jun 2026 jobs
console.log('\n=== distinct recurring service_type (residential, co1) feeding May/Jun 2026 ===');
console.table(await q(`
  SELECT rs.service_type, rs.frequency, COUNT(DISTINCT rs.id) schedules
  FROM recurring_schedules rs
  WHERE rs.company_id=$1
    AND EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.recurring_schedule_id = rs.id
        AND j.company_id=$1
        AND j.account_id IS NULL
        AND j.scheduled_date BETWEEN '2026-05-01' AND '2026-06-30'
    )
  GROUP BY 1,2 ORDER BY 3 DESC`, [CO1]));

// 3. The core dataset: one row per residential recurring schedule with a May/Jun 2026 job.
console.log('\n=== CORE: residential recurring schedules (co1) with May/Jun 2026 jobs ===');
const core = await q(`
  WITH sched AS (
    SELECT rs.id AS schedule_id, rs.customer_id, rs.service_type, rs.frequency,
           rs.base_fee::numeric AS sched_base_fee, rs.duration_minutes,
           rs.manual_rate_override AS sched_override, rs.is_active AS sched_active
    FROM recurring_schedules rs
    WHERE rs.company_id=$1
      AND EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.recurring_schedule_id = rs.id AND j.company_id=$1
          AND j.account_id IS NULL
          AND j.scheduled_date BETWEEN '2026-05-01' AND '2026-06-30'
      )
  ),
  jobagg AS (
    SELECT j.recurring_schedule_id,
           COUNT(*) FILTER (WHERE j.scheduled_date BETWEEN '2026-05-01' AND '2026-06-30') AS mayjun_jobs,
           MIN(j.base_fee::numeric) FILTER (WHERE j.scheduled_date BETWEEN '2026-05-01' AND '2026-06-30') AS min_job_fee,
           MAX(j.base_fee::numeric) FILTER (WHERE j.scheduled_date BETWEEN '2026-05-01' AND '2026-06-30') AS max_job_fee,
           BOOL_OR(j.manual_rate_override) FILTER (WHERE j.scheduled_date BETWEEN '2026-05-01' AND '2026-06-30') AS any_job_override
    FROM jobs j WHERE j.company_id=$1 AND j.recurring_schedule_id IS NOT NULL
    GROUP BY 1
  )
  SELECT s.schedule_id, s.customer_id,
         c.first_name, c.last_name, c.client_type,
         s.service_type, s.frequency, s.sched_base_fee, s.duration_minutes,
         s.sched_override, s.sched_active,
         ja.mayjun_jobs, ja.min_job_fee, ja.max_job_fee, ja.any_job_override,
         ch.sq_footage AS home_sqft, ch.bedrooms, ch.bathrooms, ch.base_fee::numeric AS home_base_fee,
         c.base_fee::numeric AS client_base_fee, c.hourly_rate::numeric AS client_hourly_rate
  FROM sched s
  JOIN clients c ON c.id = s.customer_id AND c.company_id=$1
  LEFT JOIN LATERAL (
    SELECT sq_footage, bedrooms, bathrooms, base_fee
    FROM client_homes ch WHERE ch.client_id = s.customer_id AND ch.company_id=$1
    ORDER BY ch.is_primary DESC NULLS LAST, ch.id ASC LIMIT 1
  ) ch ON true
  JOIN jobagg ja ON ja.recurring_schedule_id = s.schedule_id
  ORDER BY c.last_name, c.first_name`, [CO1]);

console.log(`rows: ${core.length}`);
console.table(core.map(r => ({
  sid: r.schedule_id, name: `${r.first_name||''} ${r.last_name||''}`.trim(),
  type: r.client_type, svc: r.service_type, freq: r.frequency,
  sched_fee: r.sched_base_fee, job_fee_min: r.min_job_fee, job_fee_max: r.max_job_fee,
  sqft: r.home_sqft, dur_min: r.duration_minutes,
  sched_ovr: r.sched_override, job_ovr: r.any_job_override, jobs: r.mayjun_jobs,
})));

// 4. dump raw JSON for engine-compute step (next pass)
console.log('\n=== RAW_JSON_START ===');
console.log(JSON.stringify(core));
console.log('=== RAW_JSON_END ===');

await client.end();
