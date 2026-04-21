import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useListUsers } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders, getTokenRole } from "@/lib/auth";
import { useBranch } from "@/contexts/branch-context";
import { Download, Calendar, Plus, X, Zap, Trash2, ChevronDown, ChevronRight } from "lucide-react";

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
  bonus: 'Bonus', tips: 'Tips', mileage: 'Mileage',
  sick_pay: 'Sick Pay', holiday_pay: 'Holiday Pay', vacation_pay: 'Vacation Pay',
  compliment: 'Compliment', amount_owed: 'Amount Owed',
};

const PAY_GROUPS = [
  { label: 'Earnings',  types: ['bonus','tips','mileage'] },
  { label: 'Time Off',  types: ['sick_pay','holiday_pay','vacation_pay'] },
  { label: 'Other',     types: ['compliment','amount_owed'] },
];

function getDefaultPeriod() {
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay());
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
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

      {isLoading && <div style={{ padding: '40px', textAlign: 'center', color: '#9E9B94', fontSize: 13 }}>Loading…</div>}

      {!isLoading && employees.length === 0 && (
        <div style={{ padding: '40px', textAlign: 'center', color: '#9E9B94', fontSize: 13 }}>No completed jobs found for this period.</div>
      )}

      {employees.map((emp: any) => {
        const isOpen = expanded.includes(emp.user_id);
        const addlEntries = Object.entries(emp.additional_pay || {}).filter(([, v]) => (v as number) !== 0);
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
              <div style={{ display: 'flex', gap: 24 }}>
                <div style={{ textAlign: 'right' }}>
                  <p style={{ fontSize: 10, color: '#9E9B94', margin: '0 0 1px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Job Total</p>
                  <p style={{ fontSize: 14, fontWeight: 700, color: '#1A1917', margin: 0 }}>${emp.totals.job_total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p style={{ fontSize: 10, color: '#9E9B94', margin: '0 0 1px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Commission</p>
                  <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--brand)', margin: 0 }}>${emp.totals.commission.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p style={{ fontSize: 10, color: '#9E9B94', margin: '0 0 1px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Grand Total</p>
                  <p style={{ fontSize: 14, fontWeight: 700, color: '#1A1917', margin: 0 }}>${emp.totals.grand_total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                </div>
              </div>
            </div>

            {isOpen && (
              <div style={{ padding: '0 20px 16px' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 14 }}>
                    <thead>
                      <tr>
                        {['Date', 'Client', 'Scope', 'Job Total', 'Commission', 'Hrs Sched', 'Hrs Worked', 'Eff. Rate'].map(h => (
                          <th key={h} style={th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {emp.jobs.map((job: any) => (
                        <tr key={job.job_id}>
                          <td style={td}>{job.date}</td>
                          <td style={td}>{job.client}</td>
                          <td style={{ ...td, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.scope}</td>
                          <td style={td}>${job.job_total.toFixed(2)}</td>
                          <td style={{ ...td, color: 'var(--brand)', fontWeight: 600 }}>${job.commission.toFixed(2)}</td>
                          <td style={{ ...td, color: '#6B6860' }}>{job.hrs_scheduled.toFixed(1)}h</td>
                          <td style={{ ...td, color: '#6B6860' }}>{job.hrs_worked.toFixed(1)}h</td>
                          <td style={{ ...td, color: '#9E9B94', fontSize: 11 }}>{job.effective_rate != null ? `$${job.effective_rate.toFixed(2)}/hr` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: '#FAFAF8' }}>
                        <td style={{ ...td, fontWeight: 700 }} colSpan={3}>Subtotal</td>
                        <td style={{ ...td, fontWeight: 700 }}>${emp.totals.job_total.toFixed(2)}</td>
                        <td style={{ ...td, fontWeight: 700, color: 'var(--brand)' }}>${emp.totals.commission.toFixed(2)}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{emp.totals.hrs_scheduled.toFixed(1)}h</td>
                        <td style={{ ...td, fontWeight: 700 }}>{emp.totals.hrs_worked.toFixed(1)}h</td>
                        <td style={td}></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {addlEntries.length > 0 && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #F4F3F0' }}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>Additional Pay</p>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      {addlEntries.map(([type, amount]) => (
                        <div key={type} style={{ fontSize: 12 }}>
                          <span style={{ color: '#9E9B94' }}>{PAY_TYPE_LABELS[type] || type}:</span>{' '}
                          <span style={{ fontWeight: 600, color: (amount as number) < 0 ? '#EF4444' : '#1A1917' }}>${(amount as number).toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '2px solid #E5E2DC', display: 'flex', justifyContent: 'flex-end', gap: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#1A1917' }}>Period Grand Total:</span>
                  <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--brand)', marginLeft: 8 }}>${emp.totals.grand_total.toFixed(2)}</span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function PayrollPage() {
  const qc = useQueryClient();
  const { activeBranchId } = useBranch();
  const branchQuery = activeBranchId !== "all" ? { branch_id: String(activeBranchId) } : {};
  const { data, isLoading } = useListUsers(branchQuery, { request: { headers: getAuthHeaders() } });
  const employees = data?.data || [];
  const billableEmployees = employees.filter((e: any) => e.role !== 'owner');

  const totalGross = billableEmployees.reduce((sum: number, e: any) => {
    const rate = empRate(e);
    return sum + rate * 40;
  }, 0);

  const isOwnerAdmin = ['owner','admin'].includes(getTokenRole() || '');
  const [activeView, setActiveView] = useState<'overview' | 'weekly-detail'>('overview');

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
  const [newTpl, setNewTpl] = useState({ name: '', type: 'bonus', amount: '', notes: '' });
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
    setSavingTpl(true);
    try {
      await apiFetch('/payroll/templates', { method: 'POST', body: JSON.stringify(newTpl) });
      setNewTplModal(false);
      setNewTpl({ name: '', type: 'bonus', amount: '', notes: '' });
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
        {/* View Toggle */}
        <div style={{ display: 'flex', gap: 4, background: '#F4F3F0', padding: 4, borderRadius: 8, width: 'fit-content' }}>
          {[{ key: 'overview', label: 'Overview' }, { key: 'weekly-detail', label: 'Weekly Detail' }].map(v => (
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

        {activeView === 'weekly-detail' && <WeeklyDetailView />}

        {activeView === 'overview' && <>
        {/* Controls */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', border: '1px solid #E5E2DC', borderRadius: '8px', backgroundColor: 'transparent', color: '#6B7280', fontSize: '13px', cursor: 'pointer', fontFamily:'inherit' }}>
            <Calendar size={14} strokeWidth={1.5} />
            Current Period
          </button>
          <button
            onClick={() => {
              const csv = ['Employee,Role,Hours,Rate,Gross Pay',
                ...billableEmployees.map((e: any) => {
                  const rate = empRate(e);
                  return `${e.first_name} ${e.last_name},${e.role},40,$${rate},$${(rate * 40).toFixed(2)}`;
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
            { label: 'Gross Payroll', value: `$${totalGross.toLocaleString()}` },
            { label: 'Total Hours (Est.)', value: `${billableEmployees.length * 40} hrs` },
            { label: 'Employees Paid', value: billableEmployees.length },
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
                  {PAY_TYPE_LABELS[t.type] || t.type}
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
            <span style={{ fontSize: '12px', color: '#6B7280' }}>Current bi-weekly period</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #EEECE7' }}>
                {['Employee', 'Role', 'Hours (Est.)', 'Hourly Rate', 'Gross Pay', 'Status'].map(h => (
                  <th key={h} style={{ padding: '12px 20px', textAlign: 'left', fontSize: '11px', fontWeight: 500, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} style={{ padding: '40px', textAlign: 'center', color: '#6B7280', fontSize: '13px' }}>Loading payroll data...</td></tr>
              ) : billableEmployees.length > 0 ? billableEmployees.map((emp: any) => {
                const rate = empRate(emp);
                const gross = rate * 40;
                return (
                  <tr key={emp.id} style={{ borderBottom: '1px solid #F0EEE9', cursor: 'default' }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#F7F6F3')}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <td style={{ padding: '14px 20px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
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
                    <td style={{ padding: '14px 20px', fontSize: '13px', fontWeight: 500, color: '#1A1917' }}>40</td>
                    <td style={{ padding: '14px 20px', fontSize: '13px', fontWeight: 500, color: '#1A1917' }}>${rate}/hr</td>
                    <td style={{ padding: '14px 20px', fontSize: '22px', fontWeight: 700, color: '#1A1917' }}>${gross.toFixed(2)}</td>
                    <td style={{ padding: '14px 20px' }}>
                      <span style={{ background: '#DCFCE7', color: '#166534', border: '1px solid #BBF7D0', display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Ready</span>
                    </td>
                  </tr>
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
              <strong style={{ color:'#1A1917' }}>{applyTemplate.name}</strong> — ${parseFloat(applyTemplate.amount).toFixed(2)} · {PAY_TYPE_LABELS[applyTemplate.type] || applyTemplate.type}
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
                <label style={labelStyle}>Pay Type</label>
                <select value={newTpl.type} onChange={e => setNewTpl(p => ({...p,type:e.target.value}))} style={inputStyle}>
                  {PAY_GROUPS.map(g => (
                    <optgroup key={g.label} label={g.label}>
                      {g.types.map(t => <option key={t} value={t}>{PAY_TYPE_LABELS[t]}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
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
