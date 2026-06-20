// ============================================================================
// DRY-RUN ONLY — NO WRITES. Legacy-pricing pin plan for co1 (Oak Lawn).
//
// Prints EXACTLY what the live pin would do, executes nothing. Live writes are
// HELD for Sal's confirmation (he is approving pinning all 72).
//
// Plan (when approved, run as a separate write script):
//   1. recurring_schedules.manual_rate_override = true   (base_fee unchanged)
//   2. future uncompleted jobs of those schedules: manual_rate_override = true
//      (each job's existing base_fee unchanged — non-destructive)
//
// Scope: client_type='residential', co1, with a job in May/Jun 2026.
// Excludes: Anthony Saguto (NULL agreed price — flag for a real price) and the
//           6 commercial-typed (client_type='commercial') single-location
//           clients (out of residential scope).
// ============================================================================
import pg from '/Users/salvadormartinez/qleno/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js';
import { readFileSync } from 'node:fs';
const env = readFileSync('/Users/salvadormartinez/qleno/.env','utf8');
const url = env.split('\n').find(l=>l.startsWith('DATABASE_URL='))?.slice(13).trim().replace(/^["']|["']$/g,'');
const c = new pg.Client({connectionString:url, ssl:{rejectUnauthorized:false}}); await c.connect();
const q=(t,p)=>c.query(t,p).then(r=>r.rows);
const CO1=1, FROM='2026-05-01', TO='2026-06-30';

console.log('============================================================');
console.log(' DRY-RUN — legacy-pricing pin plan (co1). NO WRITES EXECUTED.');
console.log('============================================================\n');

// ---- population: residential recurring schedules with May/Jun 2026 jobs ----
const pop = await q(`
  SELECT rs.id schedule_id, rs.customer_id, rs.service_type, rs.frequency,
         rs.base_fee::numeric agreed_fee, rs.manual_rate_override sched_ovr, rs.is_active,
         c.first_name, c.last_name, c.client_type
  FROM recurring_schedules rs
  JOIN clients c ON c.id=rs.customer_id AND c.company_id=$1
  WHERE rs.company_id=$1
    AND c.client_type='residential'
    AND EXISTS (SELECT 1 FROM jobs j WHERE j.recurring_schedule_id=rs.id AND j.company_id=$1
                  AND j.account_id IS NULL AND j.scheduled_date BETWEEN $2 AND $3)
  ORDER BY c.last_name, c.first_name`,[CO1,FROM,TO]);

// exclusions
const NULL_PRICE = pop.filter(r=>r.agreed_fee==null || Number(r.agreed_fee)===0);
const pinSet = pop.filter(r=>!(r.agreed_fee==null || Number(r.agreed_fee)===0));

// future-uncompleted job predicate (what we'd pin at job level)
const FUTURE_PRED = `j.company_id=${CO1} AND j.recurring_schedule_id = $1
  AND j.status='scheduled' AND j.scheduled_date >= CURRENT_DATE
  AND j.completed_by_user_id IS NULL AND j.locked_at IS NULL
  AND j.charge_succeeded_at IS NULL AND j.charge_attempted_at IS NULL
  AND j.actual_hours IS NULL`;

let totalFutureJobs=0, totalAlreadyPinnedJobs=0;
const planRows=[]; const driftDetail=[];
for (const s of pinSet){
  const fut = await q(`
    SELECT j.id, j.scheduled_date::text d, j.base_fee::numeric jf, j.manual_rate_override jo
    FROM jobs j WHERE ${FUTURE_PRED} ORDER BY j.scheduled_date`,[s.schedule_id]);
  totalFutureJobs += fut.length;
  totalAlreadyPinnedJobs += fut.filter(j=>j.jo).length;
  const agreed = Number(s.agreed_fee);
  const divergent = fut.filter(j=>j.jf!=null && Math.abs(Number(j.jf)-agreed)>0.01);
  planRows.push({
    sid:s.schedule_id, name:`${s.first_name||''} ${s.last_name||''}`.trim(),
    lock_base:agreed, freq:s.frequency, sched_ovr_now:s.sched_ovr,
    future_jobs:fut.length, jobs_already_pinned:fut.filter(j=>j.jo).length,
    future_jobs_diverging:divergent.length,
  });
  if (divergent.length) driftDetail.push({s, agreed, divergent});
}

console.log(`-- SCOPE --`);
console.log(`residential recurring schedules w/ May–Jun 2026 jobs : ${pop.length}`);
console.log(`  → PIN SET (real agreed price)                       : ${pinSet.length}`);
console.log(`  → EXCLUDED (null/zero agreed price)                 : ${NULL_PRICE.length}`);
console.log('');

console.log('================= STEP 1: schedule-level pin =================');
console.log('WOULD RUN (one statement, parameterized over the pin set):');
console.log("  UPDATE recurring_schedules SET manual_rate_override = true");
console.log(`  WHERE company_id = ${CO1} AND id = ANY($1)   -- base_fee untouched`);
console.log(`  ids = [${pinSet.map(s=>s.schedule_id).join(', ')}]`);
console.log(`  rows affected (est): ${pinSet.length} (all currently sched_ovr=false)\n`);

console.log('================= STEP 2: future-job pin ====================');
console.log('WOULD RUN (per schedule, future uncompleted jobs only):');
console.log("  UPDATE jobs SET manual_rate_override = true");
console.log("  WHERE company_id=1 AND recurring_schedule_id=$1 AND status='scheduled'");
console.log("    AND scheduled_date >= CURRENT_DATE AND completed_by_user_id IS NULL");
console.log("    AND locked_at IS NULL AND charge_succeeded_at IS NULL");
console.log("    AND charge_attempted_at IS NULL AND actual_hours IS NULL");
console.log("  -- each job's base_fee is LEFT AS-IS (non-destructive)");
console.log(`  total future uncompleted jobs to pin: ${totalFutureJobs}`);
console.log(`  (of which already manual_rate_override=true: ${totalAlreadyPinnedJobs})\n`);

console.log('================= PER-SCHEDULE PIN PLAN =====================');
console.table(planRows);

console.log('\n================= DRIFT CASES — SAL TO EYEBALL =============');
console.log('Schedules whose FUTURE jobs have base_fee != agreed schedule price.');
console.log('Pin locks each job at its CURRENT base_fee. If the current job price is');
console.log('wrong, realign base_fee to the agreed value BEFORE pinning (needs confirm).\n');
if (!driftDetail.length) console.log('  (none among future uncompleted jobs)');
for (const {s, agreed, divergent} of driftDetail){
  console.log(`• ${s.first_name||''} ${s.last_name||''}`.trim()+` (sid ${s.schedule_id}) — agreed $${agreed.toFixed(2)} / ${s.frequency}`);
  console.table(divergent.map(j=>({job_id:j.id, date:j.d, job_base_fee:Number(j.jf), agreed, delta:Math.round((Number(j.jf)-agreed)*100)/100, note: Number(j.jf)===0?'likely cancelled/credited occurrence':''})));
}

// also surface the broader (incl. past) schedule->job drift for context
console.log('\n================= HISTORICAL DRIFT (all May/Jun jobs, context) ====');
const histDrift = await q(`
  SELECT c.first_name, c.last_name, rs.id sid, rs.base_fee::numeric agreed,
         MIN(j.base_fee::numeric) jmin, MAX(j.base_fee::numeric) jmax,
         BOOL_OR(j.manual_rate_override) job_ovr
  FROM recurring_schedules rs
  JOIN clients c ON c.id=rs.customer_id AND c.company_id=$1 AND c.client_type='residential'
  JOIN jobs j ON j.recurring_schedule_id=rs.id AND j.company_id=$1 AND j.account_id IS NULL
       AND j.scheduled_date BETWEEN $2 AND $3
  WHERE rs.company_id=$1 AND rs.base_fee IS NOT NULL
  GROUP BY 1,2,3,4
  HAVING MIN(j.base_fee::numeric) <> rs.base_fee::numeric OR MAX(j.base_fee::numeric) <> rs.base_fee::numeric
  ORDER BY c.last_name`,[CO1,FROM,TO]);
console.table(histDrift.map(r=>({name:`${r.first_name||''} ${r.last_name||''}`.trim(), sid:r.sid, agreed:Number(r.agreed), job_min:Number(r.jmin), job_max:Number(r.jmax), job_ovr:r.job_ovr})));

console.log('\n================= EXCLUSIONS ================================');
console.log('A) NULL/zero agreed price — NOT pinned, needs a real price set:');
console.table(NULL_PRICE.map(r=>({sid:r.schedule_id, name:`${r.first_name||''} ${r.last_name||''}`.trim(), agreed_fee:r.agreed_fee, svc:r.service_type})));

const commercial = await q(`
  SELECT rs.id sid, c.first_name, c.last_name, rs.service_type, rs.base_fee::numeric fee
  FROM recurring_schedules rs
  JOIN clients c ON c.id=rs.customer_id AND c.company_id=$1
  WHERE rs.company_id=$1 AND c.client_type='commercial'
    AND EXISTS (SELECT 1 FROM jobs j WHERE j.recurring_schedule_id=rs.id AND j.company_id=$1
                  AND j.account_id IS NULL AND j.scheduled_date BETWEEN $2 AND $3)
  ORDER BY c.last_name`,[CO1,FROM,TO]);
console.log('\nB) Commercial-typed (client_type=commercial) — OUT OF RESIDENTIAL SCOPE, not touched:');
console.table(commercial.map(r=>({sid:r.sid, name:`${r.first_name||''} ${r.last_name||''}`.trim(), svc:r.service_type, fee:r.fee})));

console.log('\n============================================================');
console.log(` SUMMARY: would pin ${pinSet.length} schedules + ${totalFutureJobs} future jobs.`);
console.log(` Excluded: ${NULL_PRICE.length} null-price (residential), ${commercial.length} commercial-typed.`);
console.log(` Co4 (Schaumburg) untouched. NOTHING WRITTEN — dry run only.`);
console.log('============================================================');

await c.end();
