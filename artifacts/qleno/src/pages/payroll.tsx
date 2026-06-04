import { useState, useMemo, Fragment } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useListUsers } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders, getTokenRole } from "@/lib/auth";
import { useBranch } from "@/contexts/branch-context";
import { Download, Calendar, Plus, X, Zap, Trash2, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
async function apiFetch(path: string, opts?: RequestInit) {
  const r = await fetch(`${API}/api${path}`, {
    ...opts,
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...(opts?.headers || {}) },
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

const FALLBACK_RATES: Record<string, number> = {
  owner: 0,
  admin: 22,
  technician: 18,
};
function empRate(emp: any): number {
  const r = parseFloat(emp.pay_rate);
  if (!isNaN(r) && r > 0) return r;
  return FALLBACK_RATES[emp.role] ?? 18;
}

const PAY_TYPE_LABELS: Record<string, string> = {
  bonus: 'Bonus', tips: 'Tips', mileage: 'Mileage', mileage_reimbursement: 'Mileage',
  sick_pay: 'Sick Pay', holiday_pay: 'Holiday Pay', vacation_pay: 'Vacation Pay',
  compliment: 'Compliment', amount_owed: 'Amount Owed',
};

const PAY_GROUPS = [
  { label: 'Earnings',  types: ['bonus','tips'] },
  { label: 'Reimbursements', types: ['mileage','mileage_reimbursement'] },
  { label: 'Time Off',  types: ['sick_pay','holiday_pay','vacation_pay'] },
  { label: 'Other',     types: ['compliment','amount_owed'] },
];

// Label any additional-pay type. Known types use the map; custom categories
// (free-text types like 'google_review_bonus', 'birthday') fall back to a
// readable title-case so owner-defined pay categories display cleanly.
const labelType = (t: string) => PAY_TYPE_LABELS[t] || String(t || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function getDefaultPeriod() {
  // Match the Overview bi-weekly window (Sun..Sat, 14 days ending this Saturday)
  // so switching tabs shows the same period.
  const t = new Date();
  const end = new Date(t); end.setDate(t.getDate() + (6 - t.getDay()));
  const start = new Date(end); start.setDate(end.getDate() - 13);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  return { start: ymd(start), end: ymd(end) };
}

function WeeklyDetailView() {
  const [period, setPeriod] = useState(getDefaultPeriod());
  const [expanded, setExpanded] = useState<number[]>([]);
  const FF = "inherit";
  const { activeBranchId } = useBranch();
  const branchQ = activeBranchId !== "all" ? `&branch_id=${activeBranchId}` : "";

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['payroll-detail', period.start, period.end, activeBranchId],
    queryFn: () => apiFetch(`/payroll/detail?pay_period_start=${period.start}&pay_period_end=${period.end}${branchQ}`),
    enabled: !!period.start && !!period.end,
  });

  const employees: any[] = data?.data || [];
  const resPct = data?.res_tech_pay_pct ? Math.round(data.res_tech_pay_pct * 100) : 35;
  // [reconciliation 2026-06-04] Day totals so the office can set both dates to a
  // single day and reconcile Revenue · Commission · Allowed hrs against MC.
  const dayTotals = employees.reduce((a: any, e: any) => ({
    revenue: a.revenue + Number(e.totals?.job_total || 0),
    commission: a.commission + Number(e.totals?.commission || 0),
    allowed: a.allowed + Number(e.totals?.hrs_scheduled || 0),
    worked: a.worked + Number(e.totals?.hrs_worked || 0),
  }), { revenue: 0, commission: 0, allowed: 0, worked: 0 });
  const money2 = (n: number) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const isSingleDay = period.start === period.end;

  const inputStyle: React.CSSProperties = { height: 34, padding: '0 10px', border: '1px solid #E5E2DC', borderRadius: 6, fontSize: 13, color: '#1A1917', background: '#fff', outline: 'none', fontFamily: FF };
  const th: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '0 10px 8px 0', textAlign: 'left', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { fontSize: 12, color: '#1A1917', padding: '6px 10px 6px 0', borderTop: '1px solid #F4F3F0', verticalAlign: 'middle' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ backgroundColor: '#fff', border: '1px solid #E5E2DC', borderRadius: 10, padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#1A1917', fontFamily: FF }}>Pay Period:</span>
          <input type="date" value={period.start} onChange={e => setPeriod(p => ({ ...p, start: e.target.value }))} style={inputStyle} />
          <span style={{ fontSize: 12, color: '#9E9B94' }}>to</span>
          <input type="date" value={period.end} onChange={e => setPeriod(p => ({ ...p, end: e.target.value }))} style={inputStyle} />
          <button onClick={() => refetch()}
            style={{ padding: '7px 16px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FF }}>
            Load
          </button>
          <span style={{ fontSize: 11, color: '#9E9B94', marginLeft: 'auto' }}>Commission rate: {resPct}% of job total</span>
        </div>
      </div>

      <p style={{ fontSize: 11, color: '#9E9B94', margin: '-4px 2px 0', fontFamily: FF }}>
        During the transition, hours fall back to a job's <b>scheduled</b> hours (shown with ≈) when it
        hasn't been clocked yet — real clocked time takes over automatically as the team adopts clock-in/out.
        Set both dates to the same day to reconcile that day against MaidCentral.
      </p>

      {employees.length > 0 && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', background: '#fff', border: '1px solid #E5E2DC', borderRadius: 10, padding: '14px 18px' }}>
          {[
            { k: isSingleDay ? 'Revenue · this day' : 'Revenue', v: money2(dayTotals.revenue), accent: true },
            { k: 'Commission', v: money2(dayTotals.commission), accent: true },
            { k: 'Allowed hrs', v: dayTotals.allowed.toFixed(1) },
            { k: 'Worked hrs', v: dayTotals.worked.toFixed(1) },
            { k: 'Employees', v: String(employees.length) },
          ].map(s => (
            <div key={s.k} style={{ minWidth: 104 }}>
              <div style={{ fontSize: 10, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily: FF }}>{s.k}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: s.accent ? 'var(--brand)' : '#1A1917', fontFamily: FF }}>{s.v}</div>
            </div>
          ))}
        </div>
      )}

      {isLoading && <div style={{ padding: '40px', textAlign: 'center', color: '#9E9B94', fontSize: 13 }}>Loading…</div>}

      {!isLoading && employees.length === 0 && (
        <div style={{ padding: '40px', textAlign: 'center', color: '#9E9B94', fontSize: 13 }}>No completed jobs found for this period.</div>
      )}

      {employees.map((emp: any) => {
        const isOpen = expanded.includes(emp.user_id);
        const addlEntries = Object.entries(emp.additional_pay || {}).filter(([, v]) => (v as number) !== 0);
        // At-a-glance roll-up so the office sees each person's pay essentials
        // inline — no horizontal scrolling (the MaidCentral pain).
        const ap: Record<string, number> = emp.additional_pay || {};
        const sumK = (...ks: string[]) => ks.reduce((s, k) => s + (Number(ap[k]) || 0), 0);
        const tipsAmt = sumK('tips');
        const mileageAmt = sumK('mileage', 'mileage_reimbursement');
        const timeOffAmt = sumK('sick_pay', 'holiday_pay', 'vacation_pay');
        const hoursWorked = Number(emp.totals?.hrs_worked ?? 0);
        const money = (n: number) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const eff = Number(emp.totals?.hrs_worked) > 0 ? Math.round((Number(emp.totals?.hrs_scheduled || 0) / Number(emp.totals.hrs_worked)) * 100) : null;
        const rollup: any[] = [
          { label: 'Hours', value: hoursWorked.toFixed(1) },
          { label: 'Commission', value: money(emp.totals.commission), accent: true },
          ...(tipsAmt > 0 ? [{ label: 'Tips', value: money(tipsAmt) }] : []),
          ...(mileageAmt > 0 ? [{ label: 'Mileage', value: money(mileageAmt) }] : []),
          ...(timeOffAmt > 0 ? [{ label: 'Time Off', value: money(timeOffAmt) }] : []),
          { label: 'Total Pay', value: money(emp.totals.grand_total), strong: true },
        ];
        return (
          <div key={emp.user_id} style={{ backgroundColor: '#fff', border: '1px solid #E5E2DC', borderRadius: 10, overflow: 'hidden' }}>
            <div
              onClick={() => setExpanded(p => isOpen ? p.filter(id => id !== emp.user_id) : [...p, emp.user_id])}
              style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', borderBottom: isOpen ? '1px solid #EEECE7' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {isOpen ? <ChevronDown size={14} style={{ color: '#9E9B94' }} /> : <ChevronRight size={14} style={{ color: '#9E9B94' }} />}
                <span style={{ fontSize: 14, fontWeight: 700, color: '#1A1917' }}>{emp.name}</span>
                <span style={{ fontSize: 12, color: '#9E9B94' }}>{emp.totals.job_count} jobs</span>
              </div>
              <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {rollup.map((s: any) => (
                  <div key={s.label} style={{ textAlign: 'right', minWidth: 64 }}>
                    <p style={{ fontSize: 10, color: '#9E9B94', margin: '0 0 1px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</p>
                    <p style={{ fontSize: 14, fontWeight: s.strong ? 800 : 700, color: s.accent ? 'var(--brand)' : '#1A1917', margin: 0 }}>{s.value}</p>
                  </div>
                ))}
              </div>
            </div>

            {isOpen && (
              <div style={{ padding: '16px 20px 18px' }}>
                {/* Total pay hero */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', background: '#F0FDF9', border: '1px solid #99E6D3', borderRadius: 12, padding: '16px 18px' }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#0A6E5A', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Total pay</div>
                    <div style={{ fontSize: 28, fontWeight: 800, color: '#04241d', lineHeight: 1 }}>{money(emp.totals.grand_total)}</div>
                    <div style={{ marginTop: 10 }}>
                      {[
                        { label: 'Commission', v: emp.totals.commission, show: true },
                        { label: 'Tips', v: tipsAmt, show: tipsAmt > 0 },
                        { label: 'Mileage', v: mileageAmt, show: mileageAmt > 0 },
                        { label: 'Time Off', v: timeOffAmt, show: timeOffAmt > 0 },
                      ].filter(p => p.show).map(p => (
                        <span key={p.label} style={{ display: 'inline-block', fontSize: 11, fontWeight: 700, color: '#0A6E5A', background: '#D7F5EC', borderRadius: 999, padding: '3px 10px', marginRight: 6, marginBottom: 5 }}>
                          {p.label} {money(p.v)}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Hours & efficiency — for records */}
                <p style={{ fontSize: 11, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '18px 0 8px' }}>Hours &amp; efficiency · for records</p>
                <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
                  {[
                    { k: 'Hours worked', v: `${emp.totals.hrs_worked.toFixed(1)}` },
                    { k: 'Allowed', v: `${emp.totals.hrs_scheduled.toFixed(1)}` },
                    ...(eff != null ? [{ k: 'Efficiency', v: `${eff}%` }] : []),
                  ].map(s => (
                    <div key={s.k}>
                      <div style={{ fontSize: 10, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{s.k}</div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: '#1A1917' }}>{s.v}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: '#9E9B94', marginTop: 6 }}>Hours shown for records — paid on commission + mileage, not hourly.</div>

                {/* Per-client breakdown */}
                <p style={{ fontSize: 11, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '18px 0 2px' }}>Per-client breakdown</p>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={th}>Date</th>
                        <th style={th}>Client</th>
                        <th style={th}>Scope</th>
                        <th style={{ ...th, textAlign: 'right' }}>Allowed</th>
                        <th style={{ ...th, textAlign: 'right' }}>Done</th>
                        <th style={{ ...th, textAlign: 'right' }}>Pay</th>
                      </tr>
                    </thead>
                    <tbody>
                      {emp.jobs.map((job: any) => (
                        <tr key={job.job_id}>
                          <td style={{ ...td, color: '#6B6860', whiteSpace: 'nowrap' }}>{job.date}</td>
                          <td style={{ ...td, fontWeight: 600 }}>{job.client || '—'}</td>
                          <td style={{ ...td, color: '#6B6860', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.scope}</td>
                          <td style={{ ...td, textAlign: 'right', color: '#6B6860' }}>{job.hrs_scheduled.toFixed(1)}h</td>
                          <td style={{ ...td, textAlign: 'right', color: job.hrs_estimated ? '#B45309' : '#6B6860' }} title={job.hrs_estimated ? 'Scheduled — not clocked yet' : 'Clocked'}>{job.hrs_estimated ? '≈' : ''}{job.hrs_worked.toFixed(1)}h</td>
                          <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: 'var(--brand)' }}>${job.commission.toFixed(2)}</td>
                        </tr>
                      ))}
                      <tr>
                        <td style={{ ...td, fontWeight: 800, borderTop: '2px solid #E5E2DC' }} colSpan={3}>{emp.totals.job_count} jobs</td>
                        <td style={{ ...td, fontWeight: 800, textAlign: 'right', borderTop: '2px solid #E5E2DC' }}>{emp.totals.hrs_scheduled.toFixed(1)}h</td>
                        <td style={{ ...td, fontWeight: 800, textAlign: 'right', borderTop: '2px solid #E5E2DC' }}>{emp.totals.hrs_worked.toFixed(1)}h</td>
                        <td style={{ ...td, fontWeight: 800, textAlign: 'right', color: 'var(--brand)', borderTop: '2px solid #E5E2DC' }}>${emp.totals.commission.toFixed(2)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Additional pay & reimbursements */}
                {addlEntries.length > 0 && (
                  <>
                    <p style={{ fontSize: 11, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '18px 0 8px' }}>Additional pay &amp; reimbursements</p>
                    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                      {addlEntries.map(([type, amount]) => (
                        <span key={type} style={{ fontSize: 12, color: '#6B6860' }}>
                          {labelType(type)}: <b style={{ color: (amount as number) < 0 ? '#EF4444' : '#1A1917' }}>${(amount as number).toFixed(2)}</b>
                        </span>
                      ))}
                    </div>
                  </>
                )}

                {/* Commission by branch */}
                {Array.isArray(emp.commission_by_branch) && emp.commission_by_branch.length > 1 && (
                  <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #F4F3F0' }}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>Commission by Branch</p>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      {emp.commission_by_branch.map((b: any) => (
                        <div key={b.branch_id ?? 'none'} style={{ padding: '8px 12px', borderRadius: 8, background: '#F7F6F3', border: '1px solid #E5E2DC', fontSize: 12 }}>
                          <span style={{ color: '#6B6860', fontWeight: 600 }}>{b.branch_name}:</span>{' '}
                          <span style={{ fontWeight: 700, color: 'var(--brand)' }}>${b.commission.toFixed(2)}</span>
                          <span style={{ color: '#9E9B94', marginLeft: 6 }}>({b.jobs} job{b.jobs !== 1 ? 's' : ''}, {b.hrs_worked.toFixed(1)}h)</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// [overtime 2026-06-04] Office-only overtime review banner. Hits
// /payroll/overtime-check (job clock hours + between-jobs drive hours, bucketed
// by workweek under the tenant's jurisdiction rules) and surfaces both the
// overtime HOURS and the estimated premium DOLLARS for any week that crosses
// the limit — so the office can pay it. Endpoint is role-gated to office/admin/
// owner, so this never reaches a technician. Renders nothing when all clear.
function OvertimeBanner({ from, to }: { from: string; to: string }) {
  const { data } = useQuery<any>({
    queryKey: ['ot-check', from, to],
    queryFn: () => apiFetch(`/payroll/overtime-check?from=${from}&to=${to}`),
    enabled: !!from && !!to,
  });
  if (!data?.any_over_40) return null;
  const money = (n: number) => `$${(n ?? 0).toFixed(2)}`;
  const totalPremium = data.total_premium_estimate ?? 0;
  return (
    <div style={{ background: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: 10, padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <AlertTriangle size={15} color="#92400E" />
        <span style={{ fontWeight: 800, color: '#92400E', fontSize: 13 }}>
          Overtime review — {data.count} {data.count === 1 ? 'week' : 'weeks'} over the limit
          {totalPremium > 0 && <> · est. premium {money(totalPremium)}</>}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {data.weeks.map((w: any, i: number) => (
          <div key={i} style={{ fontSize: 12, color: '#92400E' }}>
            <b>{w.name}</b> · week of {w.week_start}: <b>{w.total_hours}h</b>{' '}
            ({w.job_hours}h job + {w.drive_hours}h drive) —{' '}
            <b>{w.ot_hours}h OT</b>{w.dt_hours > 0 ? <> + <b>{w.dt_hours}h double-time</b></> : null}
            {w.premium_estimate > 0 && (
              <> · est. premium <b>{money(w.premium_estimate)}</b>{w.regular_rate > 0 ? <> (reg. rate {money(w.regular_rate)}/h)</> : null}</>
            )}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: '#92400E', opacity: 0.85, marginTop: 6, lineHeight: 1.5 }}>
        Hours worked = job clock time + between-jobs drive (home↔job commute excluded). Premium is the
        extra owed over commission ({data.has_daily_overtime ? 'daily + weekly' : 'weekly'} rules
        {data.rules_source ? ` · ${String(data.rules_source).replace(/^preset:/, '')}` : ''}).
        Estimate for review — confirm with your payroll provider before paying. Configure thresholds in Settings → Payroll.
      </div>
    </div>
  );
}

// [payroll-preflight 2026-06-04] Office-only "fix before you run payroll" banner.
// Hits /payroll/preflight (jobs without clocks, not invoiced, still clocked in,
// missing tips). Red when blocking issues exist, amber for warnings only, green
// when clean. Role-gated server-side so it never reaches a technician.
function PreflightBanner({ from, to }: { from: string; to: string }) {
  const { data } = useQuery<any>({
    queryKey: ['payroll-preflight', from, to],
    queryFn: () => apiFetch(`/payroll/preflight?from=${from}&to=${to}`),
    enabled: !!from && !!to,
  });
  if (!data || !data.available) return null;
  const issues: any[] = data.issues || [];
  if (issues.length === 0) {
    return (
      <div style={{ background: '#F0FDF9', border: '1px solid #99E6D3', borderRadius: 10, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: '#00C9A0', display: 'inline-block' }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: '#0A6E5A' }}>Payroll looks clean — no issues to fix before you run it.</span>
      </div>
    );
  }
  const blocking = issues.filter(i => i.severity === 'block');
  const hasBlock = blocking.length > 0;
  return (
    <div style={{ background: hasBlock ? '#FEF2F2' : '#FEF3C7', border: `1px solid ${hasBlock ? '#FCA5A5' : '#FCD34D'}`, borderRadius: 10, padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <AlertTriangle size={15} color={hasBlock ? '#B91C1C' : '#92400E'} />
        <span style={{ fontWeight: 800, color: hasBlock ? '#B91C1C' : '#92400E', fontSize: 13 }}>
          {hasBlock
            ? `${blocking.length} thing${blocking.length > 1 ? 's' : ''} to fix before you run payroll`
            : 'Heads up before you run payroll'}
        </span>
      </div>
      <ul style={{ margin: 0, padding: '0 0 0 20px', display: 'flex', flexDirection: 'column', gap: 3 }}>
        {issues.map((i, idx) => (
          <li key={idx} style={{ fontSize: 12, color: i.severity === 'block' ? '#991B1B' : '#92400E' }}>
            <b>{i.count}</b> {i.label} <span style={{ opacity: 0.8 }}>— {i.action}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PayrollPage() {
  const qc = useQueryClient();
  const { activeBranchId } = useBranch();
  const branchQuery = activeBranchId !== "all" ? { branch_id: String(activeBranchId) } : {};
  const { data, isLoading } = useListUsers(branchQuery, { request: { headers: getAuthHeaders() } });
  const employees = data?.data || [];
  // Payroll only includes ACTIVE, real employees. Excludes owners, QA/sandbox
  // fixtures, archived/terminated/inactive accounts, and non-production test
  // logins (e.g. *.internal, @phes-test.*, *.former@) so test auditors and
  // former staff don't clutter the run.
  const billableEmployees = employees.filter((e: any) => {
    if (e.role === 'owner') return false;
    if (e.is_sandbox) return false;
    if (e.is_active === false) return false;
    if (e.hr_status === 'inactive') return false;
    if (e.archived_at) return false;
    if (e.termination_date) return false;
    const email = String(e.email || '').toLowerCase();
    if (/@phes-test\.|\.internal$|\.former@/.test(email)) return false;
    return true;
  });

  // Real payroll for the current bi-weekly period (Sun..Sat, 14 days) — same
  // source as the detail view and the Earnings panel. Replaces the old stub
  // that showed everyone a flat 40 hrs × rate.
  const payPeriod = useMemo(() => {
    const t = new Date();
    const end = new Date(t); end.setDate(t.getDate() + (6 - t.getDay()));
    const start = new Date(end); start.setDate(end.getDate() - 13);
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    return { start: ymd(start), end: ymd(end) };
  }, []);
  const periodLabel = useMemo(() => {
    const fmt = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const yr = new Date(`${payPeriod.end}T00:00:00`).getFullYear();
    return `${fmt(payPeriod.start)} – ${fmt(payPeriod.end)}, ${yr}`;
  }, [payPeriod]);
  const { data: payData } = useQuery({
    queryKey: ['payroll-overview', payPeriod.start, payPeriod.end, activeBranchId],
    queryFn: () => apiFetch(`/payroll/detail?pay_period_start=${payPeriod.start}&pay_period_end=${payPeriod.end}${activeBranchId !== 'all' ? `&branch_id=${activeBranchId}` : ''}`),
  });
  const payMap = useMemo(() => {
    const m: Record<number, { hours: number; gross: number }> = {};
    for (const e of (payData?.data || [])) {
      m[e.user_id] = { hours: e.totals?.hrs_worked ?? 0, gross: e.totals?.grand_total ?? e.totals?.commission ?? 0 };
    }
    return m;
  }, [payData]);
  // Full per-employee detail (jobs + additional pay) keyed by user_id, so the
  // Overview rows can expand into a per-client breakdown without another fetch.
  const payDetailMap = useMemo(() => {
    const m: Record<number, any> = {};
    for (const e of (payData?.data || [])) m[e.user_id] = e;
    return m;
  }, [payData]);

  const totalGross = billableEmployees.reduce((sum: number, e: any) => sum + (payMap[e.id]?.gross ?? 0), 0);
  const totalHours = billableEmployees.reduce((sum: number, e: any) => sum + (payMap[e.id]?.hours ?? 0), 0);

  const isOwnerAdmin = ['owner','admin'].includes(getTokenRole() || '');
  const [activeView, setActiveView] = useState<'overview' | 'weekly-detail'>('weekly-detail');
  const [expandedOverview, setExpandedOverview] = useState<number[]>([]);

  // Templates
  const { data: templatesData, refetch: refetchTemplates } = useQuery({
    queryKey: ['pay-templates'],
    queryFn: () => apiFetch('/payroll/templates'),
  });
  const templates: any[] = templatesData?.data || [];

  // Apply modal
  const [applyTemplate, setApplyTemplate] = useState<any | null>(null);
  const [applyEmpId, setApplyEmpId] = useState('');
  const [applyNotes, setApplyNotes] = useState('');
  const [applying, setApplying] = useState(false);

  // New template modal
  const [newTplModal, setNewTplModal] = useState(false);
  const [newTpl, setNewTpl] = useState({ name: '', type: 'bonus', amount: '', notes: '', customName: '' });
  const [savingTpl, setSavingTpl] = useState(false);

  async function handleApplyTemplate() {
    if (!applyTemplate || !applyEmpId) return;
    setApplying(true);
    try {
      await apiFetch(`/users/${applyEmpId}/additional-pay`, {
        method: 'POST',
        body: JSON.stringify({ type: applyTemplate.type, amount: applyTemplate.amount, notes: applyNotes || applyTemplate.notes }),
      });
      setApplyTemplate(null);
      setApplyEmpId('');
      setApplyNotes('');
    } catch { alert('Failed to apply template'); }
    setApplying(false);
  }

  async function handleSaveTpl() {
    if (!newTpl.name || !newTpl.amount) return;
    // Custom category → slugify into a reusable additional_pay type, e.g.
    // "Google Review Bonus" → "google_review_bonus". Lets the office define
    // their own pay categories (review bonus, birthday, etc.).
    const resolvedType = newTpl.type === '__custom__'
      ? (newTpl.customName || newTpl.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      : newTpl.type;
    if (!resolvedType) return;
    setSavingTpl(true);
    try {
      await apiFetch('/payroll/templates', { method: 'POST', body: JSON.stringify({ name: newTpl.name, type: resolvedType, amount: newTpl.amount, notes: newTpl.notes }) });
      setNewTplModal(false);
      setNewTpl({ name: '', type: 'bonus', amount: '', notes: '', customName: '' });
      refetchTemplates();
    } catch { alert('Failed to save template'); }
    setSavingTpl(false);
  }

  async function handleDeleteTpl(id: number) {
    if (!confirm('Delete this template?')) return;
    await apiFetch(`/payroll/templates/${id}`, { method: 'DELETE' });
    refetchTemplates();
  }

  const inputStyle: React.CSSProperties = { height:36,padding:'0 12px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,color:'#1A1917',background:'#FFFFFF',outline:'none',width:'100%',fontFamily:'inherit' };
  const labelStyle: React.CSSProperties = { fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.06em',display:'block',marginBottom:4 };

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <PreflightBanner from={payPeriod.start} to={payPeriod.end} />
        <OvertimeBanner from={payPeriod.start} to={payPeriod.end} />
        {/* View Toggle + current pay period */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', gap: 4, background: '#F4F3F0', padding: 4, borderRadius: 8, width: 'fit-content' }}>
            {[{ key: 'weekly-detail', label: 'By Employee' }, { key: 'overview', label: 'Summary' }].map(v => (
              <button key={v.key} onClick={() => setActiveView(v.key as any)}
                style={{ padding: '6px 16px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                  background: activeView === v.key ? '#fff' : 'transparent',
                  color: activeView === v.key ? '#1A1917' : '#9E9B94',
                  boxShadow: activeView === v.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                }}>
                {v.label}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 13, color: '#6B7280', fontWeight: 500, fontFamily: 'inherit' }}>
            Pay period: <span style={{ color: '#1A1917', fontWeight: 700 }}>{periodLabel}</span>
          </div>
        </div>

        {activeView === 'weekly-detail' && <WeeklyDetailView />}

        {activeView === 'overview' && <>
        {/* Controls */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', border: '1px solid #E5E2DC', borderRadius: '8px', backgroundColor: 'transparent', color: '#6B7280', fontSize: '13px', cursor: 'pointer', fontFamily:'inherit' }}>
            <Calendar size={14} strokeWidth={1.5} />
            {periodLabel}
          </button>
          <button
            onClick={() => {
              const csv = ['Employee,Role,Hours,Effective $/hr,Gross Pay',
                ...billableEmployees.map((e: any) => {
                  const p = payMap[e.id] || { hours: 0, gross: 0 };
                  const eff = p.hours > 0 ? (p.gross / p.hours).toFixed(2) : '0.00';
                  return `${e.first_name} ${e.last_name},${e.role},${p.hours.toFixed(1)},$${eff},$${p.gross.toFixed(2)}`;
                })
              ].join('\n');
              const blob = new Blob([csv], { type: 'text/csv' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a'); a.href = url; a.download = 'payroll.csv'; a.click();
            }}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', backgroundColor: 'var(--brand)', color: '#FFFFFF', borderRadius: '8px', fontSize: '13px', fontWeight: 600, border: 'none', cursor: 'pointer', fontFamily:'inherit' }}>
            <Download size={14} strokeWidth={1.5} />
            Export CSV
          </button>
        </div>

        {/* Summary Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
          {[
            { label: 'Gross Payroll', value: `$${totalGross.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
            { label: 'Total Hours', value: `${totalHours.toFixed(1)} hrs` },
            { label: 'Employees Paid', value: billableEmployees.filter((e: any) => (payMap[e.id]?.gross ?? 0) > 0).length },
          ].map(c => (
            <div key={c.label} style={{ backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '10px', padding: '20px' }}>
              <p style={{ fontSize: '11px', fontWeight: 500, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px 0' }}>{c.label}</p>
              <p style={{ fontSize: '22px', fontWeight: 700, color: '#1A1917', margin: 0 }}>{c.value}</p>
            </div>
          ))}
        </div>

        {/* ── Pay Templates ── */}
        <div style={{ backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '10px', overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid #EEECE7', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <p style={{ fontSize: '15px', fontWeight: 600, color: '#1A1917', margin: '0 0 2px 0' }}>Pay Templates</p>
              <p style={{ fontSize: '12px', color: '#9E9B94', margin: 0 }}>Pre-configured pay types — click Apply to send to an employee</p>
            </div>
            {isOwnerAdmin && (
              <button onClick={() => setNewTplModal(true)}
                style={{ display:'flex',alignItems:'center',gap:6,padding:'7px 14px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>
                <Plus size={13}/> New Template
              </button>
            )}
          </div>
          <div style={{ padding: '16px 20px', display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
            {templates.length === 0 ? (
              <div style={{ gridColumn:'1/-1',padding:'32px 0',textAlign:'center',color:'#9E9B94',fontSize:13 }}>No pay templates yet</div>
            ) : templates.map((t: any) => (
              <div key={t.id} style={{ border:'1px solid #E5E2DC',borderRadius:10,padding:'16px 18px',display:'flex',flexDirection:'column',gap:8 }}>
                <div style={{ display:'flex',justifyContent:'space-between',alignItems:'flex-start' }}>
                  <span style={{ fontSize:13,fontWeight:700,color:'#1A1917' }}>{t.name}</span>
                  {isOwnerAdmin && (
                    <button onClick={() => handleDeleteTpl(t.id)} style={{ background:'none',border:'none',cursor:'pointer',color:'#C4C0B8',padding:0 }} title="Delete"><Trash2 size={13}/></button>
                  )}
                </div>
                <span style={{ fontSize:11,fontWeight:600,padding:'2px 8px',borderRadius:10,background:'#DBEAFE',color:'#1E40AF',alignSelf:'flex-start' }}>
                  {labelType(t.type)}
                </span>
                <div style={{ fontSize:22,fontWeight:800,color:'var(--brand)' }}>${parseFloat(t.amount).toFixed(2)}</div>
                {t.notes && <div style={{ fontSize:11,color:'#9E9B94' }}>{t.notes}</div>}
                <button onClick={() => { setApplyTemplate(t); setApplyEmpId(''); setApplyNotes(''); }}
                  style={{ display:'flex',alignItems:'center',justifyContent:'center',gap:6,padding:'8px 0',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit',marginTop:4 }}>
                  <Zap size={12}/> Apply
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Employee Payroll Table */}
        <div style={{ backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '10px', overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid #EEECE7', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <p style={{ fontSize: '15px', fontWeight: 600, color: '#1A1917', margin: 0 }}>Employee Payroll Summary</p>
            <span style={{ fontSize: '12px', color: '#6B7280' }}>Bi-weekly · {periodLabel}</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #EEECE7' }}>
                {['Employee', 'Role', 'Hours', 'Effective $/hr', 'Gross Pay', 'Status'].map(h => (
                  <th key={h} style={{ padding: '12px 20px', textAlign: 'left', fontSize: '11px', fontWeight: 500, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} style={{ padding: '40px', textAlign: 'center', color: '#6B7280', fontSize: '13px' }}>Loading payroll data...</td></tr>
              ) : billableEmployees.length > 0 ? billableEmployees.map((emp: any) => {
                const pay = payMap[emp.id] || { hours: 0, gross: 0 };
                const effRate = pay.hours > 0 ? pay.gross / pay.hours : null;
                const detail = payDetailMap[emp.id];
                const jobs: any[] = detail?.jobs || [];
                const addl = Object.entries(detail?.additional_pay || {}).filter(([, v]) => (v as number) !== 0);
                const canOpen = jobs.length > 0 || addl.length > 0;
                const isOpen = expandedOverview.includes(emp.id);
                return (
                  <Fragment key={emp.id}>
                  <tr style={{ borderBottom: isOpen ? 'none' : '1px solid #F0EEE9', cursor: canOpen ? 'pointer' : 'default' }}
                    onClick={() => canOpen && setExpandedOverview(p => isOpen ? p.filter(id => id !== emp.id) : [...p, emp.id])}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#F7F6F3')}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <td style={{ padding: '14px 20px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        {canOpen
                          ? (isOpen ? <ChevronDown size={14} style={{ color: '#9E9B94', flexShrink: 0 }} /> : <ChevronRight size={14} style={{ color: '#9E9B94', flexShrink: 0 }} />)
                          : <span style={{ width: 14, flexShrink: 0 }} />}
                        <div style={{ width: '32px', height: '32px', borderRadius: '50%', backgroundColor: 'var(--brand-dim)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 600, flexShrink: 0 }}>
                          {emp.first_name?.[0]}{emp.last_name?.[0]}
                        </div>
                        <div>
                          <p style={{ fontSize: '13px', fontWeight: 600, color: '#1A1917', margin: 0 }}>{emp.first_name} {emp.last_name}</p>
                          <p style={{ fontSize: '12px', color: '#6B7280', margin: 0 }}>{emp.email}</p>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '14px 20px' }}>
                      <span style={{ padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', background: 'var(--brand-dim)', color: 'var(--brand)' }}>
                        {emp.role}
                      </span>
                    </td>
                    <td style={{ padding: '14px 20px', fontSize: '13px', fontWeight: 500, color: '#1A1917' }}>{pay.hours.toFixed(1)}</td>
                    <td style={{ padding: '14px 20px', fontSize: '13px', fontWeight: 500, color: '#6B6860' }}>{effRate != null ? `$${effRate.toFixed(2)}/hr` : '—'}</td>
                    <td style={{ padding: '14px 20px', fontSize: '22px', fontWeight: 700, color: '#1A1917' }}>${pay.gross.toFixed(2)}</td>
                    <td style={{ padding: '14px 20px' }}>
                      {pay.gross > 0
                        ? <span style={{ background: '#DCFCE7', color: '#166534', border: '1px solid #BBF7D0', display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Ready</span>
                        : <span style={{ background: '#F3F4F6', color: '#6B7280', border: '1px solid #E5E2DC', display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>No pay yet</span>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={6} style={{ padding: '0 20px 16px 64px', background: '#FBFBFA', borderBottom: '1px solid #F0EEE9' }}>
                        {jobs.length > 0 && (
                          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead><tr>
                              {['Date', 'Client', 'Scope', 'Hours', 'Pay'].map(h => (
                                <th key={h} style={{ fontSize: 10, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'left', padding: '10px 12px 6px 0' }}>{h}</th>
                              ))}
                            </tr></thead>
                            <tbody>
                              {jobs.map((job: any) => (
                                <tr key={job.job_id}>
                                  <td style={{ fontSize: 12, padding: '6px 12px 6px 0', borderTop: '1px solid #F0EEE9', color: '#6B6860', whiteSpace: 'nowrap' }}>{job.date}</td>
                                  <td style={{ fontSize: 12, padding: '6px 12px 6px 0', borderTop: '1px solid #F0EEE9' }}>{job.client}</td>
                                  <td style={{ fontSize: 12, padding: '6px 12px 6px 0', borderTop: '1px solid #F0EEE9', color: '#6B6860' }}>{job.scope}</td>
                                  <td style={{ fontSize: 12, padding: '6px 12px 6px 0', borderTop: '1px solid #F0EEE9', color: job.hrs_estimated ? '#B45309' : '#6B6860' }} title={job.hrs_estimated ? 'Scheduled hours — not clocked yet' : 'Clocked hours'}>{job.hrs_estimated ? '≈' : ''}{Number(job.hrs_worked ?? 0).toFixed(1)}h</td>
                                  <td style={{ fontSize: 12, padding: '6px 12px 6px 0', borderTop: '1px solid #F0EEE9', fontWeight: 600, color: 'var(--brand)' }}>${Number(job.commission ?? 0).toFixed(2)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {addl.length > 0 && (
                          <div style={{ marginTop: 10, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                            {addl.map(([type, amt]) => (
                              <span key={type} style={{ fontSize: 12, color: '#6B6860' }}>{labelType(type)}: <b style={{ color: '#1A1917' }}>${Number(amt).toFixed(2)}</b></span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              }) : (
                <tr><td colSpan={6} style={{ padding: '40px', textAlign: 'center', color: '#6B7280', fontSize: '13px' }}>No employees found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </>}
      </div>

      {/* ── Apply Template Modal ── */}
      {applyTemplate && (
        <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000 }}>
          <div style={{ background:'#FFFFFF',borderRadius:12,padding:28,width:440,boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}>
            <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4 }}>
              <h3 style={{ margin:0,fontSize:16,fontWeight:700,color:'#1A1917' }}>Apply Template</h3>
              <button onClick={() => setApplyTemplate(null)} style={{ background:'none',border:'none',cursor:'pointer',color:'#9E9B94' }}><X size={18}/></button>
            </div>
            <p style={{ margin:'0 0 20px 0',fontSize:12,color:'#9E9B94' }}>
              <strong style={{ color:'#1A1917' }}>{applyTemplate.name}</strong> — ${parseFloat(applyTemplate.amount).toFixed(2)} · {labelType(applyTemplate.type)}
            </p>
            <div style={{ display:'flex',flexDirection:'column',gap:12,marginBottom:20 }}>
              <div>
                <label style={labelStyle}>Employee</label>
                <select value={applyEmpId} onChange={e => setApplyEmpId(e.target.value)} style={inputStyle}>
                  <option value="">Select an employee…</option>
                  {billableEmployees.map((e: any) => (
                    <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Notes (optional)</label>
                <input value={applyNotes} onChange={e => setApplyNotes(e.target.value)} placeholder={applyTemplate.notes || 'Override note…'} style={inputStyle}/>
              </div>
            </div>
            <div style={{ display:'flex',gap:10,justifyContent:'flex-end' }}>
              <button onClick={() => setApplyTemplate(null)}
                style={{ padding:'8px 16px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,background:'#FFFFFF',cursor:'pointer',fontFamily:'inherit' }}>Cancel</button>
              <button onClick={handleApplyTemplate} disabled={!applyEmpId || applying}
                style={{ display:'flex',alignItems:'center',gap:6,padding:'8px 20px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit',opacity:(!applyEmpId||applying)?0.5:1 }}>
                <Zap size={13}/> {applying ? 'Applying…' : 'Apply Pay Entry'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── New Template Modal ── */}
      {newTplModal && (
        <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000 }}>
          <div style={{ background:'#FFFFFF',borderRadius:12,padding:28,width:440,boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}>
            <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20 }}>
              <h3 style={{ margin:0,fontSize:16,fontWeight:700,color:'#1A1917' }}>New Pay Template</h3>
              <button onClick={() => setNewTplModal(false)} style={{ background:'none',border:'none',cursor:'pointer',color:'#9E9B94' }}><X size={18}/></button>
            </div>
            <div style={{ display:'flex',flexDirection:'column',gap:12,marginBottom:20 }}>
              <div>
                <label style={labelStyle}>Template Name</label>
                <input value={newTpl.name} onChange={e => setNewTpl(p => ({...p,name:e.target.value}))} placeholder="e.g. Holiday Pay" style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>Category</label>
                <select value={newTpl.type} onChange={e => setNewTpl(p => ({...p,type:e.target.value}))} style={inputStyle}>
                  {PAY_GROUPS.map(g => (
                    <optgroup key={g.label} label={g.label}>
                      {g.types.map(t => <option key={t} value={t}>{PAY_TYPE_LABELS[t]}</option>)}
                    </optgroup>
                  ))}
                  <option value="__custom__">+ Custom category…</option>
                </select>
              </div>
              {newTpl.type === '__custom__' && (
                <div>
                  <label style={labelStyle}>Custom category name</label>
                  <input value={newTpl.customName} onChange={e => setNewTpl(p => ({...p,customName:e.target.value}))} placeholder="e.g. Google Review Bonus, Birthday Pay" style={inputStyle}/>
                  <p style={{ fontSize:11,color:'#9E9B94',margin:'4px 0 0' }}>Reusable pay category — e.g. $10 per Google/FB review, birthday pay. Techs see it in their tips &amp; bonuses.</p>
                </div>
              )}
              <div>
                <label style={labelStyle}>Default Amount ($)</label>
                <input type="number" value={newTpl.amount} onChange={e => setNewTpl(p => ({...p,amount:e.target.value}))} placeholder="0.00" style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>Notes (optional)</label>
                <input value={newTpl.notes} onChange={e => setNewTpl(p => ({...p,notes:e.target.value}))} placeholder="Description…" style={inputStyle}/>
              </div>
            </div>
            <div style={{ display:'flex',gap:10,justifyContent:'flex-end' }}>
              <button onClick={() => setNewTplModal(false)}
                style={{ padding:'8px 16px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,background:'#FFFFFF',cursor:'pointer',fontFamily:'inherit' }}>Cancel</button>
              <button onClick={handleSaveTpl} disabled={!newTpl.name || !newTpl.amount || savingTpl}
                style={{ padding:'8px 20px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit',opacity:(!newTpl.name||!newTpl.amount||savingTpl)?0.5:1 }}>
                {savingTpl ? 'Saving…' : 'Save Template'}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
