// READ-ONLY time-off migration design audit. SELECT only. No writes. Throwaway.
import pg from '/Users/salvadormartinez/qleno/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js';
import { readFileSync } from 'node:fs';

const env = readFileSync('/Users/salvadormartinez/qleno/.env', 'utf8');
const url = env.split('\n').find(l => l.startsWith('DATABASE_URL='))?.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
if (!url) { console.error('no DATABASE_URL'); process.exit(1); }

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
const CO1 = 1;

console.log('=== co1 ACTIVE USERS: id, name, hire_date, status ===');
const users = await client.query(`
  SELECT id, first_name, last_name, role, is_active,
         hire_date::text AS hire_date,
         pto_balance_hours, sick_balance_hours, leave_balance_hours,
         leave_balance_activated, benefit_year_start::text AS benefit_year_start
  FROM users
  WHERE company_id = $1 AND COALESCE(is_active, true) = true
  ORDER BY hire_date NULLS FIRST, last_name`, [CO1]);
console.table(users.rows);

console.log('\n=== employee_pay_rates (current effective hourly rate per user) ===');
try {
  const rates = await client.query(`
    SELECT DISTINCT ON (user_id) user_id, hourly_rate, effective_date::text eff, end_date::text endd
    FROM employee_pay_rates WHERE company_id = $1
    ORDER BY user_id, effective_date DESC`, [CO1]);
  console.table(rates.rows);
} catch (e) { console.log('employee_pay_rates:', e.message); }

console.log('\n=== additional_pay TIME-OFF entries for co1 in 2026 (the "used" question) ===');
const addl = await client.query(`
  SELECT user_id, type, COUNT(*) n, SUM(amount)::numeric(12,2) total_dollars,
         MIN(created_at)::date first_dt, MAX(created_at)::date last_dt
  FROM additional_pay
  WHERE company_id = $1
    AND COALESCE(status,'pending') <> 'voided'
    AND created_at >= '2026-01-01'
    AND lower(type) IN ('sick','sick_pay','vacation','vacation_pay','holiday','holiday_pay','pto','pto_pay','personal')
  GROUP BY user_id, type ORDER BY user_id, type`, [CO1]);
console.table(addl.rows);
console.log('time-off additional_pay rows in 2026:', addl.rowCount);

console.log('\n=== does additional_pay encode HOURS anywhere? (column check + sample notes) ===');
const cols = await client.query(`
  SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name = 'additional_pay' ORDER BY ordinal_position`);
console.table(cols.rows);
const sample = await client.query(`
  SELECT user_id, type, amount, notes FROM additional_pay
  WHERE company_id = $1 AND lower(type) IN ('sick','sick_pay','vacation','vacation_pay','holiday','holiday_pay','pto')
  ORDER BY created_at DESC LIMIT 15`, [CO1]);
console.table(sample.rows);

console.log('\n=== leave_types seeded for co1 (active) ===');
const lt = await client.query(`
  SELECT id, slug, display_name, is_paid, annual_cap_hours, accrual_mode, accrual_rate,
         waiting_period_days, carryover_allowed, active
  FROM leave_types WHERE company_id = $1 ORDER BY active DESC, slug`, [CO1]);
console.table(lt.rows);

console.log('\n=== employee_leave_balances for co1 (are 3A balances populated or inert?) ===');
const elb = await client.query(`
  SELECT COUNT(*) AS rows, COALESCE(SUM(granted_hours),0) AS sum_granted, COALESCE(SUM(used_hours),0) AS sum_used
  FROM employee_leave_balances WHERE company_id = $1`, [CO1]);
console.table(elb.rows);

console.log('\n=== company_leave_policy for co1 ===');
try {
  const pol = await client.query(`SELECT leave_program_enabled, leave_reset_basis, balance_ceiling_hours, carryover_enabled, payout_on_separation, eligibility_trigger_days FROM company_leave_policy WHERE company_id = $1`, [CO1]);
  console.table(pol.rows);
} catch (e) { console.log('company_leave_policy:', e.message); }

console.log('\n=== employee_leave_usage (office-logged) for co1 in 2026 ===');
try {
  const usg = await client.query(`
    SELECT employee_id, COUNT(*) n, SUM(hours)::numeric(10,2) hrs, MIN(date_used)::text first, MAX(date_used)::text last
    FROM employee_leave_usage WHERE company_id = $1 AND date_used >= '2026-01-01'
    GROUP BY employee_id ORDER BY employee_id`, [CO1]);
  console.table(usg.rows);
  console.log('leave_usage rows in 2026:', usg.rowCount);
} catch (e) { console.log('employee_leave_usage:', e.message); }

await client.end();
