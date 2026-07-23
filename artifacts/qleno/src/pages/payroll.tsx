import { useState, useMemo, useEffect, Fragment } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { CalendarPopover } from "@/components/calendar-popover";
import { useListUsers } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders, getTokenRole } from "@/lib/auth";
import { useBranch } from "@/contexts/branch-context";
import { EmployeeAvatar } from "@/components/employee-avatar";
import { Download, Calendar, Plus, X, Zap, Trash2, ChevronDown, ChevronRight, AlertTriangle, Navigation } from "lucide-react";
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
  sick_pay: 'Sick Pay', holiday_pay: 'Holiday Pay', vacation_pay: 'Vacation Pay', pto: 'PTO',
  compliment: 'Compliment', amount_owed: 'Amount Owed',
};

const PAY_GROUPS = [
  { label: 'Earnings',  types: ['bonus','tips'] },
  { label: 'Reimbursements', types: ['mileage','mileage_reimbursement'] },
  { label: 'Time Off',  types: ['sick_pay','holiday_pay','vacation_pay','pto'] },
  { label: 'Other',     types: ['compliment','amount_owed'] },
];

// Label any additional-pay type. Known types use the map; custom categories
// (free-text types like 'google_review_bonus', 'birthday') fall back to a
// readable title-case so owner-defined pay categories display cleanly.
// [mdy 2026-06-12] Display dates month-first (mm/dd/yy) — Sal: "stop
// displaying year first, i know what year we are in."
const mdy = (s: string) => {
  const [y, m, d] = String(s || '').slice(0, 10).split('-');
  return y && m && d ? `${m}/${d}/${y.slice(2)}` : String(s || '');
};

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

// [period-dropdown 2026-06-13] The last N pay periods, newest first, so the
// office can jump between weeks from a menu instead of hand-picking dates
// (Sal: "no dropdown with all the other payroll weeks"). Built client-side
// off the cadence — same window math as periodForCadence, walked backward.
function recentPeriods(cadence: string, count = 10) {
  const days = CADENCE_DAYS[cadence] ?? 7;
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const cur = periodForCadence(cadence);
  const out: { start: string; end: string }[] = [];
  let end = new Date(`${cur.end}T00:00:00`);
  for (let i = 0; i < count; i++) {
    const start = new Date(end); start.setDate(end.getDate() - (days - 1));
    out.push({ start: ymd(start), end: ymd(end) });
    end = new Date(start); end.setDate(start.getDate() - 1);
  }
  return out;
}
const fmtPeriod = (start: string, end: string) => {
  const f = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${f(start)} – ${f(end)}, ${new Date(`${end}T00:00:00`).getFullYear()}`;
};

// Dropdown of recent pay periods + a custom-range escape hatch.
function PeriodPicker({ period, onPeriodChange }:
  { period: { start: string; end: string }; onPeriodChange: (p: { start: string; end: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const cadence = useCadence();
  const weeks = useMemo(() => recentPeriods(cadence, 10), [cadence]);
  const todayPeriod = useMemo(() => periodForCadence(cadence), [cadence]);
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fff', border: '1px solid #E5E2DC', borderRadius: 10, padding: '9px 14px', cursor: 'pointer', fontFamily: 'inherit', boxShadow: '0 1px 2px rgba(0,0,0,.03)' }}>
        <span style={{ textAlign: 'left' }}>
          <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Pay period</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#1A1917' }}>{fmtPeriod(period.start, period.end)}</span>
        </span>
        <span style={{ color: '#9E9B94', fontSize: 12 }}>▾</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, width: 300, background: '#fff', border: '1px solid #E5E2DC', borderRadius: 12, boxShadow: '0 18px 50px rgba(10,14,26,.16)', padding: 6, zIndex: 41 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.07em', padding: '8px 12px 4px' }}>{CADENCE_LABEL[cadence] || 'Weekly'} periods</div>
            {weeks.map(w => {
              const sel = w.start === period.start && w.end === period.end;
              const isCurrent = w.start === todayPeriod.start && w.end === todayPeriod.end;
              return (
                <div key={w.start} onClick={() => { onPeriodChange(w); setOpen(false); setCustom(false); }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13, background: sel ? 'var(--brand-dim, #E9FBF5)' : 'transparent', color: sel ? 'var(--brand)' : '#1A1917', fontWeight: sel ? 700 : 500 }}
                  onMouseEnter={e => { if (!sel) e.currentTarget.style.background = '#F7F6F3'; }}
                  onMouseLeave={e => { if (!sel) e.currentTarget.style.background = 'transparent'; }}>
                  <span>{fmtPeriod(w.start, w.end)}{isCurrent ? <span style={{ color: '#9E9B94', fontSize: 11, fontWeight: 600 }}> · current</span> : ''}</span>
                </div>
              );
            })}
            <div style={{ borderTop: '1px solid #EEECE7', marginTop: 4, paddingTop: 4 }}>
              <div onClick={() => setCustom(c => !c)} style={{ padding: '9px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: '#6B6860', fontWeight: 600 }}>
                Custom range…
              </div>
              {custom && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px 8px', flexWrap: 'wrap' }}>
                  <CalendarPopover value={period.start} onChange={v => onPeriodChange({ ...period, start: v })} ariaLabel="Pay period start" />
                  <span style={{ fontSize: 12, color: '#9E9B94' }}>to</span>
                  <CalendarPopover value={period.end} onChange={v => onPeriodChange({ ...period, end: v })} ariaLabel="Pay period end" />
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// [one-engine 2026-06-19] Minimal per-tech / per-period entry for tips, OT,
// bonus, and time-off pay, posting straight to the existing additional_pay
// endpoint. Stamps created_at to the chosen date so the entry lands in the
// right pay period (same mechanism employee-profile uses). Lets the office run
// the whole weekly payroll from this one page instead of hopping to each
// employee profile. Additive pay types only — deductions stay on the profile
// where their negative-amount semantics are explicit.
const ADD_PAY_TYPES = [
  { v: 'tips', l: 'Tips' },
  { v: 'overtime', l: 'Overtime' },
  { v: 'bonus', l: 'Bonus' },
  { v: 'sick_pay', l: 'Sick Pay' },
  { v: 'holiday_pay', l: 'Holiday Pay' },
  { v: 'vacation_pay', l: 'Vacation Pay' },
  { v: 'mileage', l: 'Mileage' },
  { v: 'compliment', l: 'Compliment' },
];
function AddPayModal({ employees, period, onClose, onSaved }:
  { employees: any[]; period: { start: string; end: string }; onClose: () => void; onSaved: () => void }) {
  // [bulk-pay 2026-07-08] One-at-a-time was painful for shop-wide items like
  // holiday pay (Sal added "4th Of July" to every tech by hand). Modal now has
  // a Single / Everyone toggle: Everyone selects all field techs at once (each
  // toggleable off) and posts through /payroll/bulk-pay. Effective date drives
  // the pay period on both paths — the bulk route now stamps created_at too.
  const [mode, setMode] = useState<'single' | 'bulk'>('single');
  const [userId, setUserId] = useState<string>('');
  const [selected, setSelected] = useState<Set<number>>(() => new Set(employees.map((e: any) => Number(e.id))));
  const [type, setType] = useState('tips');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(period.end);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const amt = parseFloat(amount);
  const bulkIds = employees.map((e: any) => Number(e.id)).filter(id => selected.has(id));
  const hasWho = mode === 'single' ? userId !== '' : bulkIds.length > 0;
  const valid = hasWho && Number.isFinite(amt) && amt > 0 && !!date;
  const toggle = (id: number) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  async function save() {
    if (!valid) return;
    setSaving(true);
    try {
      if (mode === 'bulk') {
        await apiFetch('/payroll/bulk-pay', {
          method: 'POST',
          body: JSON.stringify({ employee_ids: bulkIds, amount: amt.toFixed(2), type, notes: notes || null, date }),
        });
      } else {
        await apiFetch(`/users/${userId}/additional-pay`, {
          method: 'POST',
          body: JSON.stringify({ amount: amt.toFixed(2), type, notes: notes || null, date }),
        });
      }
      onSaved();
    } catch (e: any) {
      window.alert(`Could not add pay: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  }
  const field: React.CSSProperties = { height: 38, padding: '0 12px', border: '1px solid #E5E2DC', borderRadius: 8, fontSize: 13, color: '#1A1917', background: '#fff', outline: 'none', width: '100%', fontFamily: 'inherit' };
  const lbl: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 5 };
  const tab = (active: boolean): React.CSSProperties => ({ flex: 1, padding: '7px 0', textAlign: 'center', fontSize: 12, fontWeight: 700, cursor: 'pointer', borderRadius: 7, background: active ? '#fff' : 'transparent', color: active ? '#1A1917' : '#9E9B94', boxShadow: active ? '0 1px 3px rgba(10,14,26,.1)' : 'none' });
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(10,14,26,.4)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 420, maxWidth: '100%', boxShadow: '0 24px 70px rgba(10,14,26,.28)', overflow: 'hidden', fontFamily: 'inherit' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #EEECE7' }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#1A1917' }}>Add pay adjustment</span>
          <X size={18} style={{ color: '#9E9B94', cursor: 'pointer' }} onClick={onClose} />
        </div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={lbl}>Apply to</label>
            <div style={{ display: 'flex', gap: 4, background: '#F4F2EE', borderRadius: 9, padding: 3 }}>
              <div style={tab(mode === 'single')} onClick={() => setMode('single')}>One employee</div>
              <div style={tab(mode === 'bulk')} onClick={() => setMode('bulk')}>Everyone</div>
            </div>
          </div>
          {mode === 'single' ? (
            <div>
              <label style={lbl}>Employee</label>
              <select style={field} value={userId} onChange={e => setUserId(e.target.value)}>
                <option value="">Select employee…</option>
                {employees.map((e: any) => (
                  <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                <label style={{ ...lbl, marginBottom: 0 }}>Field techs <span style={{ textTransform: 'none', fontWeight: 500, color: '#C4C0B8' }}>({bulkIds.length} of {employees.length})</span></label>
                <div style={{ display: 'flex', gap: 10, fontSize: 11, fontWeight: 700 }}>
                  <span style={{ color: 'var(--brand)', cursor: 'pointer' }} onClick={() => setSelected(new Set(employees.map((e: any) => Number(e.id))))}>All</span>
                  <span style={{ color: '#9E9B94', cursor: 'pointer' }} onClick={() => setSelected(new Set())}>None</span>
                </div>
              </div>
              <div style={{ maxHeight: 168, overflowY: 'auto', border: '1px solid #E5E2DC', borderRadius: 8 }}>
                {employees.map((e: any, i: number) => {
                  const id = Number(e.id);
                  const on = selected.has(id);
                  return (
                    <div key={id} onClick={() => toggle(id)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 12px', cursor: 'pointer', borderTop: i === 0 ? 'none' : '1px solid #F0EEE8', background: on ? '#F3FBF8' : '#fff' }}>
                      <span style={{ width: 16, height: 16, borderRadius: 4, border: on ? 'none' : '1.5px solid #C4C0B8', background: on ? 'var(--brand)' : '#fff', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 900, flexShrink: 0 }}>{on ? '✓' : ''}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#1A1917' }}>{e.first_name} {e.last_name}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Type</label>
              <select style={field} value={type} onChange={e => setType(e.target.value)}>
                {ADD_PAY_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Amount ($) {mode === 'bulk' && <span style={{ textTransform: 'none', fontWeight: 500, color: '#C4C0B8' }}>each</span>}</label>
              <input style={field} type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
            </div>
          </div>
          <div>
            <label style={lbl}>Effective date <span style={{ textTransform: 'none', fontWeight: 500, color: '#C4C0B8' }}>(determines pay period)</span></label>
            <input style={field} type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div>
            <label style={lbl}>Notes <span style={{ textTransform: 'none', fontWeight: 500, color: '#C4C0B8' }}>(optional)</span></label>
            <input style={field} value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. 4th of July holiday pay" />
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '0 20px 20px' }}>
          <button onClick={onClose} style={{ padding: '9px 16px', border: '1px solid #E5E2DC', borderRadius: 8, background: '#fff', color: '#6B7280', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          <button onClick={save} disabled={!valid || saving} style={{ padding: '9px 18px', border: 'none', borderRadius: 8, background: valid && !saving ? 'var(--brand)' : '#C4C0B8', color: '#fff', fontSize: 13, fontWeight: 700, cursor: valid && !saving ? 'pointer' : 'default', fontFamily: 'inherit' }}>{saving ? 'Saving…' : (mode === 'bulk' ? `Add pay · ${bulkIds.length}` : 'Add pay')}</button>
        </div>
      </div>
    </div>
  );
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

// [period-sync 2026-06-12] Period state lives in PayrollPage now (shared with
// the Summary tab, banners, and the top-right label) — this view just reads
// and reports changes up.
// [hours-override-ui 2026-06-22] Inline office control to flip ONE job's pay
// from its default basis (commercial allowed-hours / residential pool) to HOURLY
// on a chosen number of hours — the per-job "this one ran over, pay the actual"
// lever Sal needs to match MaidCentral's hand-adjusted overage jobs. Writes
// payroll_hours_overrides via PUT; Clear reverts to default. Pre-fills with the
// clocked hours since "pay on actual" is the common case. Office-only (the
// caller gates rendering on role).
function HoursOverrideControl({ userId, jobId, clockedHours, overridden, onChanged }: {
  userId: number; jobId: number; clockedHours: number; overridden: boolean; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState(clockedHours > 0 ? clockedHours.toFixed(2) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const h = Number(val);
    if (!Number.isFinite(h) || h <= 0 || h > 24) { setErr('Enter hours between 0 and 24'); return; }
    setBusy(true); setErr(null);
    try {
      await apiFetch('/payroll/job-hours-override', {
        method: 'PUT',
        body: JSON.stringify({ user_id: userId, job_id: jobId, paid_hours: h }),
      });
      setOpen(false); onChanged();
    } catch { setErr('Save failed'); } finally { setBusy(false); }
  }
  async function clear() {
    setBusy(true); setErr(null);
    try {
      await apiFetch(`/payroll/job-hours-override?user_id=${userId}&job_id=${jobId}`, { method: 'DELETE' });
      setOpen(false); onChanged();
    } catch { setErr('Clear failed'); } finally { setBusy(false); }
  }

  return (
    <span style={{ position: 'relative', display: 'inline-block', marginTop: 4 }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        style={{
          fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
          color: overridden ? '#B45309' : '#6B6860',
          background: overridden ? '#FEF3C7' : '#F4F2EE',
          border: '1px solid ' + (overridden ? '#F2D08A' : '#E5E2DC'),
          borderRadius: 6, padding: '2px 8px',
        }}>
        {overridden ? 'Edit hourly override' : 'Pay hourly'}
      </button>
      {open && (
        <>
          <div onClick={(e) => { e.stopPropagation(); setOpen(false); }} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
          <div onClick={(e) => e.stopPropagation()}
            style={{ position: 'absolute', zIndex: 51, top: 'calc(100% + 6px)', left: 0, width: 234, background: '#fff', border: '1px solid #E5E2DC', borderRadius: 10, boxShadow: '0 12px 34px rgba(10,14,26,.16)', padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: '#0A0E1A', marginBottom: 2 }}>Pay this job hourly</div>
            <div style={{ fontSize: 10.5, color: '#9B9890', marginBottom: 8, lineHeight: 1.35 }}>Overrides the default basis — pays the company hourly rate × these hours for this one job.</div>
            <label style={{ fontSize: 10.5, fontWeight: 700, color: '#9B9890', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Paid hours</label>
            <input type="number" step="0.25" min="0" value={val} autoFocus
              onChange={(e) => setVal(e.target.value)}
              style={{ display: 'block', width: '100%', marginTop: 4, padding: '7px 9px', border: '1px solid #E5E2DC', borderRadius: 8, fontFamily: 'inherit', fontSize: 13, boxSizing: 'border-box' }} />
            {clockedHours > 0 && (
              <button onClick={() => setVal(clockedHours.toFixed(2))}
                style={{ marginTop: 6, fontSize: 11, color: '#00A383', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
                Use clocked: {clockedHours.toFixed(2)}h
              </button>
            )}
            {err && <div style={{ fontSize: 11, color: '#DC2626', marginTop: 6 }}>{err}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button disabled={busy} onClick={save}
                style={{ flex: 1, padding: '7px 0', background: '#0A0E1A', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit', opacity: busy ? 0.6 : 1 }}>
                {busy ? '…' : 'Save'}
              </button>
              {overridden && (
                <button disabled={busy} onClick={clear}
                  style={{ padding: '7px 12px', background: '#fff', color: '#B45309', border: '1px solid #E5E2DC', borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit' }}>
                  Clear
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </span>
  );
}

function WeeklyDetailView({ period, onPeriodChange }: { period: { start: string; end: string }; onPeriodChange: (p: { start: string; end: string }) => void }) {
  const [expanded, setExpanded] = useState<number[]>([]);
  const FF = "inherit";
  const { activeBranchId } = useBranch();
  const branchQ = activeBranchId !== "all" ? `&branch_id=${activeBranchId}` : "";
  const qc = useQueryClient();
  // [hours-override-ui 2026-06-22] Office-only: the per-job "pay hourly" lever.
  const canManage = ['owner', 'admin', 'office'].includes(getTokenRole() || '');
  const onOverrideChanged = () => {
    qc.invalidateQueries({ queryKey: ['payroll-detail'] });
    qc.invalidateQueries({ queryKey: ['payroll-overview'] });
  };

  const { data, isLoading } = useQuery({
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
    // Total pay (commission + tips + mileage + additional) for the labor-cost ratio.
    payroll: a.payroll + Number(e.totals?.grand_total ?? e.totals?.commission ?? 0),
    allowed: a.allowed + Number(e.totals?.hrs_scheduled || 0),
    worked: a.worked + Number(e.totals?.hrs_worked || 0),
  }), { revenue: 0, commission: 0, payroll: 0, allowed: 0, worked: 0 });
  const money2 = (n: number) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const isSingleDay = period.start === period.end;
  // Payroll as % of revenue — the labor-cost target to "stay under" (MC parity).
  // <40% healthy (mint), 40–50% watch (amber), >50% hot (red).
  const payrollPct = dayTotals.revenue > 0 ? Math.round((dayTotals.payroll / dayTotals.revenue) * 1000) / 10 : null;
  const payrollPctColor = payrollPct == null ? '#9E9B94' : payrollPct < 40 ? '#16A34A' : payrollPct <= 50 ? '#D97706' : '#DC2626';

  const th: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '0 10px 8px 0', textAlign: 'left', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { fontSize: 12, color: '#1A1917', padding: '6px 10px 6px 0', borderTop: '1px solid #F4F3F0', verticalAlign: 'middle' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <PeriodPicker period={period} onPeriodChange={onPeriodChange} />
        <span style={{ fontSize: 11, color: '#9E9B94' }}>Pay rules: {resPct}% residential · tiered deep/move % · commercial hourly</span>
      </div>

      {employees.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 1, background: '#E5E2DC', border: '1px solid #E5E2DC', borderRadius: 14, overflow: 'hidden' }}>
          {[
            { k: isSingleDay ? 'Billed · this day' : 'Billed', v: money2(dayTotals.revenue) },
            { k: 'Commission', v: money2(dayTotals.commission), accent: true },
            { k: 'Labor %', v: payrollPct != null ? `${payrollPct}%` : '—', color: payrollPctColor },
            { k: 'Allowed hrs', v: dayTotals.allowed.toFixed(1) },
            { k: 'Worked hrs', v: dayTotals.worked.toFixed(1) },
            { k: 'Employees', v: String(employees.length) },
          ].map((s: any) => (
            <div key={s.k} style={{ background: '#fff', padding: '16px 18px' }}>
              <div style={{ fontSize: 10, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: FF }}>{s.k}</div>
              <div style={{ fontSize: 21, fontWeight: 800, marginTop: 4, color: s.color ?? (s.accent ? 'var(--brand)' : '#1A1917'), fontFamily: FF }}>{s.v}</div>
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
        const timeOffAmt = sumK('sick_pay', 'holiday_pay', 'vacation_pay', 'pto');
        const hoursWorked = Number(emp.totals?.hrs_worked ?? 0);
        const allowedHrs = Number(emp.totals?.hrs_scheduled ?? 0);
        const money = (n: number) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const eff = Number(emp.totals?.hrs_worked) > 0 ? Math.round((Number(emp.totals?.hrs_scheduled || 0) / Number(emp.totals.hrs_worked)) * 100) : null;
        const effRate = emp.totals?.effective_rate;
        const billedTotal = Number(emp.totals?.job_total ?? 0);
        const laborPct = billedTotal > 0 ? Math.round((emp.totals.commission / billedTotal) * 100) : null;
        const rollup: any[] = [
          // Allowed + Worked hrs side by side per tech — mirrors the team
          // header so the office reads budget-vs-actual on each row, not just
          // in the aggregate (Sal request 2026-06-17).
          { label: 'Allowed', value: allowedHrs.toFixed(1) },
          { label: 'Worked', value: hoursWorked.toFixed(1) },
          ...(eff != null ? [{ label: 'Eff', value: `${eff}%` }] : []),
          { label: 'Billed', value: money(billedTotal) },
          { label: 'Total Pay', value: money(emp.totals.grand_total), strong: true, accent: true },
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
                {/* [hierarchy-pass 2026-06-15] Total Pay box — mint (#00A383)
                    only on the Total Pay headline + Commission chip; every
                    other figure navy, labels grey. No red/amber. */}
                {(() => {
                  const deductAmt = sumK('amount_owed');
                  const bonusAmt = sumK('bonus');
                  const chips = [
                    { label: 'Commission', v: emp.totals.commission, mint: true, neg: false },
                    ...(tipsAmt ? [{ label: 'Tips', v: tipsAmt, mint: false, neg: false }] : []),
                    ...(mileageAmt ? [{ label: 'Mileage', v: mileageAmt, mint: false, neg: false }] : []),
                    ...(bonusAmt ? [{ label: 'Bonus', v: bonusAmt, mint: false, neg: bonusAmt < 0 }] : []),
                    ...(timeOffAmt ? [{ label: 'Time Off', v: timeOffAmt, mint: false, neg: false }] : []),
                    ...(deductAmt ? [{ label: 'Deductions', v: deductAmt, mint: false, neg: true }] : []),
                  ];
                  return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 30, flexWrap: 'wrap', background: 'linear-gradient(120deg,#F0FDF9,#E9FBF5)', border: '1px solid #B7ECDD', borderRadius: 12, padding: '18px 22px' }}>
                  <div style={{ minWidth: 200 }}>
                    <div style={{ fontSize: 11, fontWeight: 500, color: '#9B9890', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>Total pay</div>
                    <div style={{ fontSize: 30, fontWeight: 800, color: '#00A383', lineHeight: 1 }}>{money(emp.totals.grand_total)}</div>
                    <div style={{ marginTop: 11 }}>
                      {chips.map(p => (
                        <span key={p.label} style={{ display: 'inline-block', fontSize: 11, fontWeight: 500, marginRight: 7, marginBottom: 5, borderRadius: 999, padding: '4px 11px', color: p.mint ? '#00A383' : '#6B6860', background: p.mint ? '#E9FBF5' : '#F4F3F0' }}>
                          {p.label} {p.neg && p.v > 0 ? '−' : ''}{money(Math.abs(p.v))}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 26, flexWrap: 'wrap' }}>
                    {[
                      { k: 'Billed to clients', v: money(billedTotal) },
                      ...(laborPct != null ? [{ k: 'Labor %', v: `${laborPct}%` }] : []),
                      ...(eff != null ? [{ k: 'Efficiency', v: `${eff}%` }] : []),
                      ...(effRate != null ? [{ k: 'Eff. $/hr', v: money(effRate) }] : []),
                    ].map(s => (
                      <div key={s.k}><div style={{ fontSize: 10, color: '#9B9890', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{s.k}</div><div style={{ fontSize: 15, fontWeight: 500, color: '#0A0E1A', marginTop: 3 }}>{s.v}</div></div>
                    ))}
                  </div>
                </div>
                  );
                })()}

                {/* Customer quality — only when something was actually rated.
                    [panel-cleanup 2026-06-12] The always-on empty-state card
                    was pure noise (Sal: "lots going on, needs to look
                    cleaner"); the collapsed header already says
                    "No quality scores". */}
                {emp.totals.quality_count > 0 && (
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
                    {`${emp.totals.quality_count} of ${emp.totals.job_count} job${emp.totals.job_count !== 1 ? 's' : ''} rated by customers this period.`}
                  </div>
                </div>
                )}

                <div style={{ fontSize: 11, color: '#9E9B94', marginTop: 6 }}>Hours shown for records — paid on commission + mileage, not hourly.</div>

                {/* Per-client breakdown */}
                <p style={{ fontSize: 11, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '18px 0 2px' }}>Per-client breakdown</p>
                {/* [panel-cleanup 2026-06-12] Day-grouped, 4-5 columns instead
                    of the old 9-column wall: date becomes a slim day header
                    with a per-day subtotal, scope + basis tuck under the
                    client name, done/allowed merge into one Hours cell, Eff
                    renders as a colored pill, and the Quality column only
                    exists when at least one job in the panel was rated. */}
                <div style={{ overflowX: 'auto' }}>
                  {(() => {
                    const hasQuality = emp.jobs.some((j: any) => j.quality_score != null);
                    // [payroll-v2 2026-06-13] Billed + Labor % columns. Billed =
                    // job.job_total (billed_amount ?? base_fee from the server);
                    // Labor % = pay ÷ billed (the margin per job). Quality column
                    // only when something's rated.
                    const cols = hasQuality ? 6 : 5;
                    const fmtScope = (s: string) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
                    const dayName = (d: string) => new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
                    const byDay: Record<string, any[]> = {};
                    for (const j of emp.jobs) { const k = String(j.date).slice(0, 10); (byDay[k] = byDay[k] || []).push(j); }
                    const days = Object.keys(byDay).sort();
                    // [mileage-visibility 2026-07-08] Per-day mileage legs so the
                    // office SEES each drive right on this screen (Sal: "Monday's
                    // mileage is not populating" — it was computed, just never shown
                    // here). Grouped by date; rendered under each day band. Pending
                    // = not yet applied to pay (office reviews on the mileage screen).
                    const milesByDate: Record<string, any[]> = {};
                    for (const leg of (emp.mileage_legs || [])) { const k = String(leg.leg_date).slice(0, 10); (milesByDate[k] = milesByDate[k] || []).push(leg); }
                    // [payroll-scan 2026-06-20] Eff as a colored pill so the eye
                    // scans the column: green = at/under budget (≥100%), amber =
                    // over budget (<100%). "—" stays plain when not yet clocked.
                    const effPill = (job: any) => {
                      if (job.hrs_estimated || !(job.hrs_worked > 0) || !(job.hrs_scheduled > 0)) {
                        return <span style={{ color: '#9B9890' }} title={job.hrs_estimated ? 'Not clocked yet' : 'No hours'}>—</span>;
                      }
                      const e = Math.round((job.hrs_scheduled / job.hrs_worked) * 100);
                      const good = e >= 100;
                      return <span style={{ display: 'inline-block', minWidth: 46, textAlign: 'center', fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: good ? '#E7F7F1' : '#FEF3C7', color: good ? '#0A7C66' : '#B45309' }} title="Allowed ÷ actual — under 100% ran over budget">{e}%</span>;
                    };
                    const laborOf = (billed: number, pay: number) => billed > 0 ? `${Math.round((pay / billed) * 100)}%` : '—';
                    return (
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>
                            <th style={th}>Client</th>
                            <th style={{ ...th, textAlign: 'right' }}>Billed</th>
                            <th style={{ ...th, textAlign: 'right' }}>Done / Allowed</th>
                            <th style={{ ...th, textAlign: 'center' }} title="Allowed hours ÷ actual hours — over 100% means under budget">Eff</th>
                            {hasQuality && <th style={{ ...th, textAlign: 'center' }}>Quality</th>}
                            <th style={{ ...th, textAlign: 'right' }} title="Pay (the small tag is labor % = pay ÷ billed)">Pay</th>
                          </tr>
                        </thead>
                        <tbody>
                          {days.map(d => {
                            const dayBilled = byDay[d].reduce((s, j) => s + Number(j.job_total || 0), 0);
                            const dayPay = byDay[d].reduce((s, j) => s + Number(j.commission || 0), 0);
                            // [payroll 2026-07-08] Per-day worked hours + effective
                            // $/hr on the day band — MaidCentral parity ("Daily Hours"
                            // + "Daily Pay $X/hr"). Rate is dayPay ÷ dayWorked; only
                            // clocked jobs carry hours so unclocked days show "—/hr".
                            const dayWorked = byDay[d].reduce((s, j) => s + Number(j.hrs_worked || 0), 0);
                            const dayRate = dayWorked > 0 ? dayPay / dayWorked : 0;
                            const dayLegs = milesByDate[d] || [];
                            const dayMiles = dayLegs.reduce((s: number, l: any) => s + Number(l.miles || 0), 0);
                            const dayMileagePay = dayLegs.reduce((s: number, l: any) => s + Number(l.amount || 0), 0);
                            return (
                            <Fragment key={d}>
                              {/* [payroll-scan 2026-06-20] Day band — a shaded
                                  strip the eye lands on, with the day's billed,
                                  pay, AND labor% (pay ÷ billed) so per-day margin
                                  reads at the same place as the per-job tag. */}
                              <tr>
                                <td colSpan={cols} style={{ padding: '9px 14px', background: '#F4F2EE', borderTop: '1px solid #E5E2DC', borderBottom: '1px solid #E5E2DC' }}>
                                  <span style={{ fontSize: 11, fontWeight: 800, color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{dayName(d)} · {mdy(d)}</span>
                                  <span style={{ float: 'right', fontSize: 12, color: '#6B6860' }}>
                                    <span style={{ color: '#1A1917', fontWeight: 700 }}>{money(dayBilled)}</span> billed · <span style={{ color: '#00A383', fontWeight: 700 }}>{money(dayPay)}</span> pay
                                    <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 700, color: '#6B6860', background: '#fff', border: '1px solid #E5E2DC', borderRadius: 5, padding: '2px 7px', marginLeft: 8 }} title="Hours worked this day (for records — not paid hourly)">{dayWorked > 0 ? `${dayWorked.toFixed(1)}h` : '—'}</span>
                                    <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 700, color: '#0A7C66', background: '#E7F7F1', border: '1px solid #C9EDE2', borderRadius: 5, padding: '2px 7px', marginLeft: 6 }} title="Effective rate this day = pay ÷ hours worked">{dayRate > 0 ? `${money(dayRate)}/hr` : '—/hr'}</span>
                                    <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 700, color: '#6B6860', background: '#fff', border: '1px solid #E5E2DC', borderRadius: 5, padding: '2px 7px', marginLeft: 6 }}>{laborOf(dayBilled, dayPay)} labor</span>
                                    <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 700, color: dayMiles > 0 ? '#0A6E8A' : '#9B9890', background: dayMiles > 0 ? '#E0F2F9' : '#fff', border: `1px solid ${dayMiles > 0 ? '#BFE4F0' : '#E5E2DC'}`, borderRadius: 5, padding: '2px 7px', marginLeft: 6 }} title="Driving mileage between this day's jobs (pending office review)">{dayMiles > 0 ? `${dayMiles.toFixed(1)} mi · ${money(dayMileagePay)}` : '0 mi'}</span>
                                  </span>
                                </td>
                              </tr>
                              {/* [mileage-visibility 2026-07-08] The actual drives for
                                  this day, so mileage is visible where the office lives
                                  (not just a weekly total). Pending until applied. */}
                              {dayLegs.map((leg: any, li: number) => (
                                <tr key={`mi-${d}-${li}`}>
                                  <td colSpan={cols} style={{ ...td, borderTop: '0.5px dashed #E7EEF2', paddingTop: 6, paddingBottom: 6, background: '#FAFCFD' }}>
                                    <span style={{ fontSize: 12, color: '#0A6E8A', fontWeight: 700 }}>↳ Drive</span>
                                    <span style={{ fontSize: 12, color: '#6B6860', marginLeft: 8 }}>{leg.from} → {leg.to}</span>
                                    <span style={{ float: 'right', fontSize: 12, color: '#6B6860' }}>
                                      <span style={{ color: '#1A1917', fontWeight: 700 }}>{Number(leg.miles).toFixed(1)} mi</span> · <span style={{ color: '#0A6E8A', fontWeight: 700 }}>{money(Number(leg.amount))}</span>
                                      <span style={{ display: 'inline-block', fontSize: 9, fontWeight: 700, color: '#9B7B17', background: '#FEF6E0', border: '1px solid #F0E4BE', borderRadius: 5, padding: '1px 6px', marginLeft: 8, textTransform: 'uppercase' }}>{leg.status === 'applied' ? 'Applied' : 'Pending'}</span>
                                    </span>
                                  </td>
                                </tr>
                              ))}
                              {byDay[d].map((job: any) => {
                                const billed = Number(job.job_total || 0);
                                return (
                                <tr key={job.job_id}>
                                  <td style={{ ...td, borderTop: '0.5px solid #F0EEE8', paddingTop: 9, paddingBottom: 9 }}>
                                    <div style={{ fontSize: 14, fontWeight: 700, color: '#0A0E1A' }}>{job.client || '—'}</div>
                                    <div style={{ fontSize: 12, color: '#9B9890' }} title="How this line's pay was computed">
                                      {fmtScope(job.scope)}
                                      {job.pay_basis ? <> · {String(job.pay_basis).split('(override)').map((part: string, i: number, arr: string[]) => <Fragment key={i}>{part}{i < arr.length - 1 && <span style={{ color: '#B45309', fontWeight: 600 }}>(override)</span>}</Fragment>)}</> : ''}
                                    </div>
                                    {canManage && (
                                      <HoursOverrideControl
                                        userId={emp.user_id}
                                        jobId={job.job_id}
                                        clockedHours={Number(job.hrs_actual ?? job.hrs_worked ?? 0)}
                                        overridden={!!job.hours_overridden}
                                        onChanged={onOverrideChanged}
                                      />
                                    )}
                                  </td>
                                  <td style={{ ...td, borderTop: '0.5px solid #F0EEE8', textAlign: 'right', fontSize: 14, fontWeight: 400, color: '#0A0E1A', whiteSpace: 'nowrap' }}>{billed > 0 ? money(billed) : '—'}</td>
                                  <td style={{ ...td, borderTop: '0.5px solid #F0EEE8', textAlign: 'right', fontSize: 14, fontWeight: 400, whiteSpace: 'nowrap' }}>
                                    <span style={{ color: '#0A0E1A' }} title={job.hrs_estimated ? 'Scheduled — not clocked yet' : 'Clocked'}>{job.hrs_estimated ? '≈' : ''}{job.hrs_worked.toFixed(1)}h</span>
                                    <span style={{ color: '#9B9890' }}> / {job.hrs_scheduled.toFixed(1)}h</span>
                                  </td>
                                  <td style={{ ...td, borderTop: '0.5px solid #F0EEE8', textAlign: 'center' }}>{effPill(job)}</td>
                                  {hasQuality && (
                                    <td style={{ ...td, borderTop: '0.5px solid #F0EEE8', textAlign: 'center' }}>
                                      {job.quality_score != null
                                        ? <span style={{ fontSize: 12, fontWeight: 400, color: '#9B9890' }}>{job.quality_score}/4</span>
                                        : <span style={{ color: '#9B9890' }}>—</span>}
                                    </td>
                                  )}
                                  <td style={{ ...td, borderTop: '0.5px solid #F0EEE8', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                    <span style={{ fontSize: 15, fontWeight: 800, color: '#00A383' }}>${job.commission.toFixed(2)}</span>
                                    <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 700, color: '#9B9890', background: '#F4F2EE', borderRadius: 5, padding: '2px 6px', marginLeft: 8 }}>{laborOf(billed, Number(job.commission || 0))}</span>
                                  </td>
                                </tr>
                                );
                              })}
                            </Fragment>
                            );
                          })}
                          {/* Footer total — weight 500, 1.5px divider, mint pay. */}
                          <tr>
                            <td style={{ ...td, fontWeight: 500, color: '#0A0E1A', borderTop: '1.5px solid #D8D5CD' }}>{emp.totals.job_count} jobs</td>
                            <td style={{ ...td, fontWeight: 500, color: '#0A0E1A', textAlign: 'right', borderTop: '1.5px solid #D8D5CD', whiteSpace: 'nowrap' }}>{money(billedTotal)}</td>
                            <td style={{ ...td, fontWeight: 500, color: '#0A0E1A', textAlign: 'right', borderTop: '1.5px solid #D8D5CD', whiteSpace: 'nowrap' }}>{emp.totals.hrs_worked.toFixed(1)}h / {emp.totals.hrs_scheduled.toFixed(1)}h</td>
                            <td style={{ ...td, fontWeight: 500, color: '#9B9890', textAlign: 'center', borderTop: '1.5px solid #D8D5CD' }}>{emp.totals.hrs_worked > 0 && emp.totals.hrs_scheduled > 0 ? `${Math.round((emp.totals.hrs_scheduled / emp.totals.hrs_worked) * 100)}%` : '—'}</td>
                            {hasQuality && <td style={{ ...td, fontWeight: 500, color: '#9B9890', textAlign: 'center', borderTop: '1.5px solid #D8D5CD' }}>{emp.totals.quality_avg != null ? `${emp.totals.quality_avg.toFixed(1)}/4` : '—'}</td>}
                            <td style={{ ...td, fontWeight: 500, textAlign: 'right', borderTop: '1.5px solid #D8D5CD', whiteSpace: 'nowrap' }}>
                              <span style={{ color: '#00A383' }}>${emp.totals.commission.toFixed(2)}</span>
                              <span style={{ fontSize: 11, fontWeight: 400, color: '#9B9890', marginLeft: 6 }}>{laborPct != null ? `${laborPct}%` : '—'}</span>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    );
                  })()}
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
        <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--brand)', display: 'inline-block' }} />
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
            <Line type="monotone" dataKey="revenue" name="Revenue" stroke="var(--brand)" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="payroll" name="Payroll" stroke="var(--brand)" strokeWidth={2} dot={false} />
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
  // Payroll only includes ACTIVE, real FIELD TECHS. Excludes owners, office
  // staff, admins, and the external accountant/CPA (role='accountant', e.g.
  // Maribel) — payroll pays field techs on commission + mileage, so non-field
  // roles have no place in the run or the Add-pay dropdown (Sal: "only field
  // techs should be here. why is our cpa here"). Also drops QA/sandbox
  // fixtures, archived/terminated/inactive accounts, and non-production test
  // logins so test auditors and former staff don't clutter the run.
  const NON_FIELD_ROLES = ['owner', 'admin', 'office', 'super_admin', 'accountant'];
  const billableEmployees = employees.filter((e: any) => {
    if (NON_FIELD_ROLES.includes(e.role)) return false;
    if (e.is_sandbox) return false;
    if (e.is_active === false) return false;
    if (e.hr_status === 'inactive') return false;
    if (e.archived_at) return false;
    if (e.termination_date) return false;
    const email = String(e.email || '').toLowerCase();
    if (/@phes-test\.|\.internal$|\.former@/.test(email)) return false;
    return true;
  });

  // Pay window shared by BOTH tabs, the top-right label, and the banners.
  // [period-sync 2026-06-12] Previously By Employee kept its own period state,
  // so loading May 31 – Jun 6 there left the top-right label, the Summary tab
  // cards, and the Employee Payroll Summary pinned to the current week (Sal:
  // "dates on top right not updating based on filter"). One state, one window.
  const cadence = useCadence();
  const [periodEdited, setPeriodEdited] = useState(false);
  const [payPeriod, setPayPeriod] = useState(() => periodForCadence('weekly'));
  useEffect(() => { if (!periodEdited) setPayPeriod(periodForCadence(cadence)); }, [cadence, periodEdited]);
  const onPeriodChange = (p: { start: string; end: string }) => { setPeriodEdited(true); setPayPeriod(p); };
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
  // Publish, Export, and Add-pay are office-grade actions (owner/admin/office) —
  // same gate as the POST /payroll/publish + /payroll/export routes. [one-engine]
  const canManagePayroll = ['owner','admin','office'].includes(getTokenRole() || '');
  const [activeView, setActiveView] = useState<'overview' | 'weekly-detail'>('weekly-detail');
  const [expandedOverview, setExpandedOverview] = useState<number[]>([]);

  // ── Publish / Export / Add-pay (run weekly payroll from the app) ────────────
  const { data: pubStatus, refetch: refetchPub } = useQuery<any>({
    queryKey: ['payroll-publish-status', payPeriod.start, payPeriod.end],
    queryFn: () => apiFetch(`/payroll/publish-status?pay_period_start=${payPeriod.start}&pay_period_end=${payPeriod.end}`),
    enabled: canManagePayroll && !!payPeriod.start && !!payPeriod.end,
  });
  const isPublished = !!pubStatus?.published;
  const [publishing, setPublishing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showAddPay, setShowAddPay] = useState(false);

  const money2s = (n: number) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  async function handlePublish() {
    const verb = isPublished ? 'Re-publish' : 'Publish';
    if (!window.confirm(`${verb} payroll for ${periodLabel}?\n\nThis snapshots each employee's pay as the locked record for this period. Re-publishing overwrites the existing snapshot with current numbers.`)) return;
    setPublishing(true);
    try {
      const r = await apiFetch('/payroll/publish', { method: 'POST', body: JSON.stringify({ pay_period_start: payPeriod.start, pay_period_end: payPeriod.end }) });
      await refetchPub();
      window.alert(`Published ${r.published} employee${r.published === 1 ? '' : 's'} for ${periodLabel}.\nTotal gross: $${money2s(r.total_gross)}`);
    } catch (e: any) {
      window.alert(`Publish failed: ${e?.message || e}`);
    } finally {
      setPublishing(false);
    }
  }

  async function handleExport() {
    if (!isPublished && !window.confirm(`This period hasn't been published yet. Export live (unpublished) numbers?\n\nThey match the on-screen detail but aren't locked. Publish first if you want a fixed record.`)) return;
    setExporting(true);
    try {
      const resp = await fetch(`${API}/api/payroll/export?pay_period_start=${payPeriod.start}&pay_period_end=${payPeriod.end}`, { headers: { ...getAuthHeaders() } });
      if (!resp.ok) throw new Error(`${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pay-summary-${payPeriod.start}-${payPeriod.end}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      window.alert(`Export failed: ${e?.message || e}`);
    } finally {
      setExporting(false);
    }
  }

  // [mileage-auto 2026-07-08] On-demand mileage recompute — the manual twin of
  // the nightly cron. Runs On My Way → clock-sequence → scheduled failsafe for
  // the tenant's recent open periods, then refreshes the detail so new legs
  // surface. Compute only; nothing becomes pay until the office reviews.
  const [recomputingMi, setRecomputingMi] = useState(false);
  async function handleRecomputeMileage() {
    setRecomputingMi(true);
    try {
      const r = await apiFetch('/pay/recompute-mileage-now', { method: 'POST' });
      const n = r?.data?.inserted ?? 0;
      qc.invalidateQueries({ queryKey: ['payroll-detail'] });
      window.alert(n > 0
        ? `Mileage recomputed — ${n} new leg${n === 1 ? '' : 's'} added for review.`
        : `Mileage recomputed — no new legs (already up to date).`);
    } catch (e: any) {
      window.alert(`Recompute failed: ${e?.message || e}`);
    } finally {
      setRecomputingMi(false);
    }
  }

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, color: '#6B7280', fontWeight: 500, fontFamily: 'inherit' }}>
              Pay period: <span style={{ color: '#1A1917', fontWeight: 700 }}>{periodLabel}</span>
            </div>
            {canManagePayroll && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {pubStatus && (
                  <span title={isPublished && pubStatus.published_at ? `Published ${new Date(pubStatus.published_at).toLocaleString()}` : 'Not yet published'}
                    style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999, color: isPublished ? '#00A383' : '#9E9B94', background: isPublished ? '#E9FBF5' : '#F4F3F0' }}>
                    {isPublished ? 'Published' : 'Draft'}
                  </span>
                )}
                <button onClick={() => setShowAddPay(true)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', border: '1px solid #E5E2DC', borderRadius: 8, background: '#fff', color: '#1A1917', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                  <Plus size={14} strokeWidth={1.8} /> Add pay
                </button>
                <button onClick={handleRecomputeMileage} disabled={recomputingMi} title="Recalculate driving mileage from clock-ins, On My Way taps, and the schedule. Pends for review — nothing is paid until you apply it."
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', border: '1px solid #E5E2DC', borderRadius: 8, background: '#fff', color: '#1A1917', fontSize: 13, fontWeight: 600, cursor: recomputingMi ? 'default' : 'pointer', fontFamily: 'inherit' }}>
                  <Navigation size={14} strokeWidth={1.8} /> {recomputingMi ? 'Recomputing…' : 'Recompute mileage'}
                </button>
                <button onClick={handlePublish} disabled={publishing}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: '1px solid #E5E2DC', borderRadius: 8, background: '#fff', color: '#1A1917', fontSize: 13, fontWeight: 600, cursor: publishing ? 'default' : 'pointer', fontFamily: 'inherit' }}>
                  {publishing ? 'Publishing…' : (isPublished ? 'Re-publish' : 'Publish')}
                </button>
                <button onClick={handleExport} disabled={exporting}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: 'none', borderRadius: 8, background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: exporting ? 'default' : 'pointer', fontFamily: 'inherit' }}>
                  <Download size={14} strokeWidth={1.8} /> {exporting ? 'Exporting…' : 'Export'}
                </button>
              </div>
            )}
          </div>
        </div>
        {showAddPay && (
          <AddPayModal
            employees={billableEmployees}
            period={payPeriod}
            onClose={() => setShowAddPay(false)}
            onSaved={() => {
              setShowAddPay(false);
              qc.invalidateQueries({ queryKey: ['payroll-detail'] });
              qc.invalidateQueries({ queryKey: ['payroll-overview'] });
            }}
          />
        )}

        {activeView === 'weekly-detail' && <WeeklyDetailView period={payPeriod} onPeriodChange={onPeriodChange} />}

        {activeView === 'overview' && <>
        {/* Controls */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', border: '1px solid #E5E2DC', borderRadius: '8px', backgroundColor: 'transparent', color: '#6B7280', fontSize: '13px', cursor: 'pointer', fontFamily:'inherit' }}>
            <Calendar size={14} strokeWidth={1.5} />
            {periodLabel}
          </button>
          {/* One source of truth: routes through the same /payroll/export
              (published snapshot or live computePeriodPay) as the header
              Export button, so the CSV can never diverge from the on-screen
              numbers. [one-engine 2026-06-19] */}
          <button
            onClick={handleExport}
            disabled={exporting}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', backgroundColor: 'var(--brand)', color: '#FFFFFF', borderRadius: '8px', fontSize: '13px', fontWeight: 600, border: 'none', cursor: exporting ? 'default' : 'pointer', fontFamily:'inherit' }}>
            <Download size={14} strokeWidth={1.5} />
            {exporting ? 'Exporting…' : 'Export CSV'}
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
        <div style={{ backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '10px', overflowX: 'auto', WebkitOverflowScrolling: 'touch' as any }}>
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
                        <EmployeeAvatar name={`${emp.first_name ?? ''} ${emp.last_name ?? ''}`} avatarUrl={emp.avatar_url} size={32} fontSize={12} />

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
                                  <td style={{ fontSize: 12, padding: '6px 12px 6px 0', borderTop: '1px solid #F0EEE9', color: '#6B6860', whiteSpace: 'nowrap' }}>{mdy(job.date)}</td>
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
