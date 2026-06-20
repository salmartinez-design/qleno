// READ-ONLY. NO writes. Phase 1 classifier: residential recurring (co1) with
// May/Jun 2026 jobs → stored agreed price vs current-engine price → legacy flag.
import pg from '/Users/salvadormartinez/qleno/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js';
import { readFileSync } from 'node:fs';
const env = readFileSync('/Users/salvadormartinez/qleno/.env','utf8');
const url = env.split('\n').find(l=>l.startsWith('DATABASE_URL='))?.slice(13).trim().replace(/^["']|["']$/g,'');
const c = new pg.Client({connectionString:url, ssl:{rejectUnauthorized:false}}); await c.connect();
const q=(t,p)=>c.query(t,p).then(r=>r.rows);
const CO1=1, FROM='2026-05-01', TO='2026-06-30';
const r2=n=>Math.round(n*100)/100;

// ---- load catalog into memory ----
const scopes = await q(`SELECT id,name,pricing_method,hourly_rate::numeric h,minimum_bill::numeric mb,is_active FROM pricing_scopes WHERE company_id=$1`,[CO1]);
const freqs  = await q(`SELECT scope_id,frequency,multiplier::numeric mult,rate_override::numeric ro FROM pricing_frequencies WHERE company_id=$1`,[CO1]);
const tiers  = await q(`SELECT scope_id,min_sqft,max_sqft,hours::numeric hrs FROM pricing_tiers WHERE company_id=$1`,[CO1]);

// service_type text -> scope. Match by name (ci), with known aliases.
const norm = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const byName = new Map(scopes.map(s=>[norm(s.name), s]));
const ALIAS = {
  standardclean:'Standard Clean', standard_clean:'Standard Clean',
  recurring:'Standard Clean',
  deepclean:'Deep Clean',
  commercialcleaning:'Commercial Cleaning', commercial_cleaning:'Commercial Cleaning',
  housecleaningdeepcleanormoveinout:'Move In / Move Out',
};
function resolveScope(svc){
  const n = norm(svc);
  if (byName.has(n)) return byName.get(n);
  const alias = ALIAS[n] || ALIAS[String(svc||'').toLowerCase().replace(/\s+/g,'')];
  if (alias) return byName.get(norm(alias));
  return null;
}
// engine price (mirrors computeQuotePricing) — returns {total,detail} or {total:null,reason}
function enginePrice(scope, sqft, frequency){
  if(!scope) return {total:null, reason:'no_scope_match'};
  if((scope.pricing_method||'sqft')!=='sqft') return {total:null, reason:`scope_${scope.pricing_method}_not_sqft`};
  // freq map: recurring frequencies in catalog use weekly/biweekly/monthly/onetime
  const fmap = {weekly:'weekly', biweekly:'biweekly', monthly:'monthly', every_3_weeks:'biweekly', custom:'biweekly', weekdays:'weekly', custom_days:'weekly', semi_monthly:'biweekly', onetime:'onetime'};
  const fk = fmap[frequency] || frequency;
  const fr = freqs.find(f=>f.scope_id===scope.id && f.frequency===fk);
  let rate;
  if(fr && fr.ro!=null) rate=Number(fr.ro);
  else rate=Number(scope.h)*(fr?Number(fr.mult):1);
  if(sqft==null) return {total:null, reason:'no_sqft'};
  const st = tiers.filter(t=>t.scope_id===scope.id).sort((a,b)=>a.min_sqft-b.min_sqft);
  if(!st.length) return {total:null, reason:'no_tiers'};
  let tier = st.find(t=>sqft>=t.min_sqft && sqft<=t.max_sqft) ?? (sqft<st[0].min_sqft?st[0]:st[st.length-1]);
  const base_hours=Number(tier.hrs);
  let bp=base_hours*rate;
  const mb=Number(scope.mb||0); let minApplied=false;
  if(mb>0 && bp<mb){bp=mb; minApplied=true;}
  return {total:r2(bp), rate:r2(rate), base_hours, freq_used:fk, min_applied:minApplied, reason:'ok'};
}

// ---- core dataset: residential recurring schedules with May/Jun 2026 jobs ----
const core = await q(`
  WITH sched AS (
    SELECT rs.id schedule_id, rs.customer_id, rs.service_type, rs.frequency,
           rs.base_fee::numeric sched_fee, rs.duration_minutes, rs.manual_rate_override sched_ovr, rs.is_active sched_active
    FROM recurring_schedules rs
    WHERE rs.company_id=$1 AND EXISTS (
      SELECT 1 FROM jobs j WHERE j.recurring_schedule_id=rs.id AND j.company_id=$1
        AND j.account_id IS NULL AND j.scheduled_date BETWEEN $2 AND $3)
  ),
  jobagg AS (
    SELECT j.recurring_schedule_id rsid,
      COUNT(*) FILTER (WHERE j.scheduled_date BETWEEN $2 AND $3) mj,
      MIN(j.base_fee::numeric) FILTER (WHERE j.scheduled_date BETWEEN $2 AND $3) jmin,
      MAX(j.base_fee::numeric) FILTER (WHERE j.scheduled_date BETWEEN $2 AND $3) jmax,
      BOOL_OR(j.manual_rate_override) FILTER (WHERE j.scheduled_date BETWEEN $2 AND $3) job_ovr,
      COUNT(*) FILTER (WHERE j.scheduled_date BETWEEN $2 AND $3 AND EXISTS(SELECT 1 FROM job_add_ons ja WHERE ja.job_id=j.id)) jobs_with_addons,
      COUNT(*) FILTER (WHERE j.scheduled_date BETWEEN $2 AND $3 AND EXISTS(SELECT 1 FROM job_discounts jd WHERE jd.job_id=j.id)) jobs_with_disc
    FROM jobs j WHERE j.company_id=$1 AND j.recurring_schedule_id IS NOT NULL GROUP BY 1
  )
  SELECT s.*, c.first_name, c.last_name, c.client_type,
         ch.sq_footage home_sqft,
         ja.mj, ja.jmin, ja.jmax, ja.job_ovr, ja.jobs_with_addons, ja.jobs_with_disc
  FROM sched s
  JOIN clients c ON c.id=s.customer_id AND c.company_id=$1
  LEFT JOIN LATERAL (SELECT sq_footage FROM client_homes ch WHERE ch.client_id=s.customer_id AND ch.company_id=$1
      ORDER BY ch.is_primary DESC NULLS LAST, ch.id ASC LIMIT 1) ch ON true
  JOIN jobagg ja ON ja.rsid=s.schedule_id
  WHERE c.client_type='residential'
  ORDER BY c.last_name, c.first_name`,[CO1,FROM,TO]);

const rows = core.map(r=>{
  const scope = resolveScope(r.service_type);
  const eng = enginePrice(scope, r.home_sqft!=null?Number(r.home_sqft):null, r.frequency);
  const stored = r.sched_fee!=null?Number(r.sched_fee):(r.jmax!=null?Number(r.jmax):null);
  let cls, delta=null;
  if(stored==null){ cls='NO_PRICE'; }
  else if(eng.total==null){ cls='LEGACY_UNREPRODUCIBLE'; }
  else { delta=r2(stored-eng.total); cls = Math.abs(delta)<=1 ? 'STANDARD_MATCHES' : 'LEGACY_DELTA'; }
  return {
    sid:r.schedule_id, name:`${r.first_name||''} ${r.last_name||''}`.trim(),
    svc:r.service_type, freq:r.frequency, scope:scope?scope.name:'—',
    sqft:r.home_sqft, stored, engine:eng.total, eng_reason:eng.reason, delta, cls,
    sched_fee:r.sched_fee!=null?Number(r.sched_fee):null,
    jmin:r.jmin!=null?Number(r.jmin):null, jmax:r.jmax!=null?Number(r.jmax):null,
    sched_ovr:r.sched_ovr, job_ovr:r.job_ovr, mj:Number(r.mj),
    addon_jobs:Number(r.jobs_with_addons), disc_jobs:Number(r.jobs_with_disc),
    drift: (r.jmin!=null && r.jmax!=null && r.sched_fee!=null && (Number(r.jmin)!==Number(r.sched_fee) || Number(r.jmax)!==Number(r.sched_fee))),
  };
});

console.log(`\n=== RESIDENTIAL RECURRING (co1) with May/Jun 2026 jobs: ${rows.length} schedules ===\n`);
console.table(rows.map(r=>({name:r.name, svc:r.svc, freq:r.freq, scope:r.scope, sqft:r.sqft, stored:r.stored, engine:r.engine, delta:r.delta, why:r.eng_reason, class:r.cls})));

const by = k => rows.filter(r=>r.cls===k);
console.log('\n=== CLASSIFICATION COUNTS ===');
console.table([
  {class:'STANDARD_MATCHES (engine reproduces stored)', n:by('STANDARD_MATCHES').length},
  {class:'LEGACY_DELTA (engine computes but differs)', n:by('LEGACY_DELTA').length},
  {class:'LEGACY_UNREPRODUCIBLE (engine cannot compute)', n:by('LEGACY_UNREPRODUCIBLE').length},
  {class:'NO_PRICE (no stored fee)', n:by('NO_PRICE').length},
]);

console.log('\n=== reasons engine could not compute ===');
const reasons={}; for(const r of rows) if(r.engine==null){reasons[r.eng_reason]=(reasons[r.eng_reason]||0)+1;}
console.table(Object.entries(reasons).map(([reason,n])=>({reason,n})));

console.log('\n=== schedule->job price DRIFT (agreed fee already diverging on generated jobs) ===');
console.table(rows.filter(r=>r.drift).map(r=>({name:r.name, sched_fee:r.sched_fee, job_min:r.jmin, job_max:r.jmax, job_ovr:r.job_ovr, addon_jobs:r.addon_jobs, disc_jobs:r.disc_jobs})));

console.log('\n=== PROPOSED PIN SET (legacy + no_price; sched_ovr currently false) ===');
const pin = rows.filter(r=>r.cls!=='STANDARD_MATCHES');
console.log(`${pin.length} schedules. ${pin.filter(r=>!r.sched_ovr).length} not yet pinned at schedule level.`);
console.table(pin.map(r=>({sid:r.sid, name:r.name, lock_base:r.stored, class:r.cls, sched_ovr:r.sched_ovr})));

console.log('\n=== currently STANDARD (engine reproduces) — would NOT pin ===');
console.table(by('STANDARD_MATCHES').map(r=>({name:r.name, stored:r.stored, engine:r.engine})));

await c.end();
