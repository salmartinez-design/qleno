import { useState, useMemo, useEffect, Fragment } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useListUsers } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders, getTokenRole } from "@/lib/auth";
import { useBranch } from "@/contexts/branch-context";
import { Download, Calendar, Plus, X, Zap, Trash2, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";

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

// [pay-cadence 2026-06-08] The default pay-period window is sized by the
// tenant's pay cadence (companies.pay_cadence) — weekly = 7 days, bi-weekly =
// 14, semi-monthly = 15 — instead of a hardcoded 14. Phes pays weekly.
const CADENCE_DAYS: Record<string, number> = { weekly: 7, biweekly: 14, semimonthly: 15 };
const CADENCE_LABEL: Record<string, string> = { weekly: 'Weekly', biweekly: 'Bi-weekly', semimonthly: 'Semi-monthly' };

function periodForCadence(cadence: string) {
  const days = CADENCE_DAYS[cadence] ?? 7;
  const t = new Date();
  const end = new Date(t); end.setDate(t.getDate() + (6 - t.getDay())); // Saturday of this week
  const start = new Date(end); start.setDate(end.getDate() - (days - 1));
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  return { start: ymd(start), end: ymd(end) };
}

// Tenant pay cadence from companies.pay_cadence. Defaults to 'weekly' while
// loading / when unset (Phes pays weekly; bi-weekly tenants opt in via Settings).
function useCadence(): string {
  const { data } = useQuery<any>({ queryKey: ['company-me-cadence'], queryFn: () => apiFetch('/companies/me') });
  return data?.pay_cadence || data?.data?.pay_cadence || 'weekly';
}

// Customer-quality score is 0–4 (matches the Scorecards report scale):
// ≥3.5 green, ≥2.5 amber, else red; muted when nothing's been rated.
const qualityColor = (q: number | null | undefined) =>
  q == null ? '#9E9B94' : q >= 3.5 ? '#16A34A' : q >= 2.5 ? '#D97706' : '#DC2626';

function WeeklyDetailView() {
  const cadence = useCadence();
  const [period, setPeriod] = useState(() => periodForCadence('weekly'));
  // Re-seed the default window from the tenant's cadence once it loads, unless
  // the office has manually picked dates.
  const [periodEdited, setPeriodEdited] = useState(false);
  useEffect(() => { if (!periodEdited) setPeriod(periodForCadence(cadence)); }, [cadence, periodEdited]);
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
  // Company-wide customer-quality avg across every rated job in the period.
  const allQ = employees.flatMap((e: any) => (e.jobs || []).map((j: any) => j.quality_score).filter((v: any) => v != null));
  const avgQuality = allQ.length ? allQ.reduce((a: number, b: number) => a + b, 0) / allQ.length : null;
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
          <input type="date" value={period.start} onChange={e => { setPeriodEdited(true); setPeriod(p => ({ ...p, start: e.target.value })); }} style={inputStyle} />
          <span style={{ fontSize: 12, color: '#9E9B94' }}>to</span>
          <input type="date" value={period.end} onChange={e => { setPeriodEdited(true); setPeriod(p => ({ ...p, end: e.target.value })); }} style={inputStyle} />
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
        Set both dates to the same day to reconcile a single day's pay.
      </p>

      {employees.length > 0 && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', background: '#fff', border: '1px solid #E5E2DC', borderRadius: 10, padding: '14px 18px' }}>
          {[
            { k: isSingleDay ? 'Revenue · this day' : 'Revenue', v: money2(dayTotals.revenue), accent: true },
            { k: 'Commission', v: money2(dayTotals.commission), accent: true },
            { k: 'Allowed hrs', v: dayTotals.allowed.toFixed(1) },
            { k: 'Worked hrs', v: dayTotals.worked.toFixed(1) },
            { k: 'Avg Quality', v: avgQuality != null ? `${avgQuality.toFixed(1)}/4` : '—', quality: avgQuality },
            { k: 'Employees', v: String(employees.length) },
          ].map((s: any) => (
            <div key={s.k} style={{ minWidth: 104 }}>
              <div style={{ fontSize: 10, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily: FF }}>{s.k}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: 'quality' in s ? qualityColor(s.quality) : s.accent ? 'var(--brand)' : '#1A1917', fontFamily: FF }}>{s.v}</div>
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
        const effRate = emp.totals?.effective_rate;
        const rollup: any[] = [
          { label: 'Hours', value: hoursWorked.toFixed(1) },
          ...(eff != null ? [{ label: 'Eff', value: `${eff}%` }] : []),
          ...(effRate != null ? [{ label: '$/hr', value: money(effRate) }] : []),
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
                {emp.totals.quality_avg != null ? (
                  <span title={`${emp.totals.quality_count} of ${emp.totals.job_count} jobs rated by customers`}
                    style={{ fontSize: 11, fontWeight: 800, color: '#fff', background: qualityColor(emp.totals.quality_avg), borderRadius: 999, padding: '2px 9px' }}>
                    ★ {emp.totals.quality_avg.toFixed(1)}/4
                  </span>
                ) : (
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#C4C0B8' }}>No quality scores</span>
                )}
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

                {/* Customer quality — the emphasis: how well the customer was served */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', marginTop: 12, background: '#fff', border: `1px solid ${emp.totals.quality_avg != null ? qualityColor(emp.totals.quality_avg) + '66' : '#E5E2DC'}`, borderRadius: 12, padding: '14px 18px' }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Customer quality</div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span style={{ fontSize: 26, fontWeight: 800, color: qualityColor(emp.totals.quality_avg), lineHeight: 1 }}>
                        {emp.totals.quality_avg != null ? emp.totals.quality_avg.toFixed(1) : '—'}
                      </span>
                      <span style={{ fontSize: 13, color: '#9E9B94', fontWeight: 700 }}>/ 4</span>
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: '#6B6860', maxWidth: 320 }}>
                    {emp.totals.quality_count > 0
                      ? `${emp.totals.quality_count} of ${emp.totals.job_count} job${emp.totals.job_count !== 1 ? 's' : ''} rated by customers this period.`
                      : 'No customer ratings logged for this period yet.'}
                  </div>
                </div>

                {/* Hours & efficiency — for records */}
                <p style={{ fontSize: 11, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '18px 0 8px' }}>Hours &amp; efficiency · for records</p>
                <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
                  {[
                    { k: 'Hours worked', v: `${emp.totals.hrs_worked.toFixed(1)}` },
                    { k: 'Allowed', v: `${emp.totals.hrs_scheduled.toFixed(1)}` },
                    ...(eff != null ? [{ k: 'Efficiency', v: `${eff}%` }] : []),
                    ...(emp.totals?.effective_rate != null ? [{ k: 'Effective $/hr', v: money(emp.totals.effective_rate) }] : []),
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
                        <th style={th}>Basis</th>
                        <th style={{ ...th, textAlign: 'right' }}>Allowed</th>
                        <th style={{ ...th, textAlign: 'right' }}>Done</th>
                        <th style={{ ...th, textAlign: 'right' }}>Quality</th>
                        <th style={{ ...th, textAlign: 'right' }}>Pay</th>
                      </tr>
                    </thead>
                    <tbody>
                      {emp.jobs.map((job: any) => (
                        <tr key={job.job_id}>
                          <td style={{ ...td, color: '#6B6860', whiteSpace: 'nowrap' }}>{job.date}</td>
                          <td style={{ ...td, fontWeight: 600 }}>{job.client || '—'}</td>
                          <td style={{ ...td, color: '#6B6860', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.scope}</td>
                          <td style={{ ...td, color: '#9E9B94', whiteSpace: 'nowrap' }} title="How this line's pay was computed">{job.pay_basis || '—'}</td>
                          <td style={{ ...td, textAlign: 'right', color: '#6B6860' }}>{job.hrs_scheduled.toFixed(1)}h</td>
                          <td style={{ ...td, textAlign: 'right', color: job.hrs_estimated ? '#B45309' : '#6B6860' }} title={job.hrs_estimated ? 'Scheduled — not clocked yet' : 'Clocked'}>{job.hrs_estimated ? '≈' : ''}{job.hrs_worked.toFixed(1)}h</td>
                          <td style={{ ...td, textAlign: 'right' }}>
                            {job.quality_score != null
                              ? <span style={{ fontWeight: 700, color: qualityColor(job.quality_score) }}>{job.quality_score}/4</span>
                              : <span style={{ color: '#C4C0B8' }}>—</span>}
                          </td>
                          <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: 'var(--brand)' }}>${job.commission.toFixed(2)}</td>
                        </tr>
                      ))}
                      <tr>
                        <td style={{ ...td, fontWeight: 800, borderTop: '2px solid #E5E2DC' }} colSpan={4}>{emp.totals.job_count} jobs</td>
                        <td style={{ ...td, fontWeight: 800, textAlign: 'right', borderTop: '2px solid #E5E2DC' }}>{emp.totals.hrs_scheduled.toFixed(1)}h</td>
                        <td style={{ ...td, fontWeight: 800, textAlign: 'right', borderTop: '2px solid #E5E2DC' }}>{emp.totals.hrs_worked.toFixed(1)}h</td>
                        <td style={{ ...td, fontWeight: 800, textAlign: 'right', borderTop: '2px solid #E5E2DC', color: qualityColor(emp.totals.quality_avg) }}>{emp.totals.quality_avg != null ? `${emp.totals.quality_avg.toFixed(1)}/4` : '—'}</td>
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

// [payroll-trend 2026-06-08] Company-level weekly Payroll-to-Revenue chart with
// a YOY overlay (MaidCentral parity). Revenue vs payroll lines for the current
// window + dashed prior-year lines (hidden until a year of history exists).
// Headline shows payroll as % of revenue — the labor-cost KPI.
function PayrollToRevenueChart() {
  const [weeks, setWeeks] = useState(26);
  const { data, isLoading } = useQuery<any>({
    queryKey: ['payroll-revenue-trend', weeks],
    queryFn: () => apiFetch(`/payroll/revenue-trend?weeks=${weeks}`),
  });
  const series: any[] = data?.weeks || [];
  const hasPrior = !!data?.has_prior_data;
  const money0 = (n: number) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const pct = data?.payroll_pct;
  // Payroll % of revenue: <40% healthy (mint), 40–50% watch (amber), >50% hot (red).
  const pctColor = pct == null ? '#9E9B94' : pct < 40 ? '#16A34A' : pct <= 50 ? '#D97706' : '#DC2626';

  return (
    <div style={{ backgroundColor: '#fff', border: '1px solid #E5E2DC', borderRadius: 10, padding: '16px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
        <div>
          <p style={{ fontSize: 15, fontWeight: 700, color: '#1A1917', margin: '0 0 2px' }}>Payroll to Revenue</p>
          <p style={{ fontSize: 12, color: '#9E9B94', margin: 0 }}>
            {data ? <>Revenue {money0(data.total_revenue)} · Payroll {money0(data.total_payroll)} · last {weeks} weeks</> : 'Weekly labor cost vs revenue'}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {pct != null && (
            <div style={{ textAlign: 'right' }}>
              <p style={{ fontSize: 10, color: '#9E9B94', margin: '0 0 1px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Payroll % of rev</p>
              <p style={{ fontSize: 20, fontWeight: 800, color: pctColor, margin: 0 }}>{pct}%</p>
            </div>
          )}
          <div style={{ display: 'flex', gap: 4, background: '#F4F3F0', padding: 4, borderRadius: 8 }}>
            {[13, 26, 52].map(w => (
              <button key={w} onClick={() => setWeeks(w)}
                style={{ padding: '4px 10px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                  background: weeks === w ? '#fff' : 'transparent', color: weeks === w ? '#1A1917' : '#9E9B94',
                  boxShadow: weeks === w ? '0 1px 3px rgba(0,0,0,0.08)' : 'none' }}>
                {w}w
              </button>
            ))}
          </div>
        </div>
      </div>

      {isLoading ? (
        <div style={{ padding: '60px', textAlign: 'center', color: '#9E9B94', fontSize: 13 }}>Loading…</div>
      ) : series.length === 0 ? (
        <div style={{ padding: '60px', textAlign: 'center', color: '#9E9B94', fontSize: 13 }}>No completed jobs in this window yet.</div>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F0EDE8" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#9E9B94' }} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tick={{ fontSize: 11, fill: '#9E9B94' }} tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`} width={44} />
            <Tooltip formatter={(v: any, name: string) => [money0(Number(v)), name]} labelFormatter={(l: string) => `Week of ${l}`}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #E5E2DC' }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="revenue" name="Revenue" stroke="#5B9BD5" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="payroll" name="Payroll" stroke="#00C9A0" strokeWidth={2} dot={false} />
            {hasPrior && <Line type="monotone" dataKey="prior_revenue" name="Revenue (last yr)" stroke="#B5D4F4" strokeWidth={1.5} strokeDasharray="4 4" dot={false} />}
            {hasPrior && <Line type="monotone" dataKey="prior_payroll" name="Payroll (last yr)" stroke="#9FE9D8" strokeWidth={1.5} strokeDasharray="4 4" dot={false} />}
          </LineChart>
        </ResponsiveContainer>
      )}
      <p style={{ fontSize: 11, color: '#9E9B94', margin: '8px 2px 0' }}>
        Payroll = commission + tips/additional + applied mileage. Revenue = completed-job totals.
        {hasPrior ? ' Dashed lines = same weeks last year.' : ' Year-over-year overlay turns on automatically once a year of history exists.'}
      </p>
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

  // Real payroll for the current pay period, sized by the tenant's pay cadence
  // (weekly for Phes) — same source as the detail view and the Earnings panel.
  const cadence = useCadence();
  const payPeriod = useMemo(() => periodForCadence(cadence), [cadence]);
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

  // Pay Templates removed per Sal (2026-06-08): additional pay is added directly
  // on the employee profile and cascades into the payroll summary by date.

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

        {/* Payroll-to-Revenue trend + YOY */}
        <PayrollToRevenueChart />

        {/* Employee Payroll Table */}
        <div style={{ backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '10px', overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid #EEECE7', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <p style={{ fontSize: '15px', fontWeight: 600, color: '#1A1917', margin: 0 }}>Employee Payroll Summary</p>
            <span style={{ fontSize: '12px', color: '#6B7280' }}>{CADENCE_LABEL[cadence] || 'Weekly'} · {periodLabel}</span>
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

    </DashboardLayout>
  );
}
