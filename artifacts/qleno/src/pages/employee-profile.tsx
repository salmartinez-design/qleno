import { useState, useEffect, useCallback } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { EmployeeAvatar } from "@/components/employee-avatar";
import { AvatarCropModal } from "@/components/avatar-crop-modal";
import { getAuthHeaders, getTokenRole } from "@/lib/auth";
import { CalendarPopover } from "@/components/calendar-popover";
import {
  ArrowLeft, Camera, Plus, X, ChevronLeft, ChevronRight,
  Star, Save, Trash2, Edit2, Check, AlertCircle, Mail, Phone, Eye,
  Ban, ChevronDown, ChevronUp, DollarSign, Clock, TrendingUp, Download, Users,
  RotateCcw,
} from "lucide-react";
import { useEmployeeView } from "@/contexts/employee-view-context";
import { EarningsPanel } from "@/components/earnings-panel";
import { HRAttendanceTab, LeaveBalanceTab, DisciplineTab, QualityTab } from "./employee-profile-hr-tabs";
import { parseLeaveNote, leaveBucketLabel, KIND_TONE_STYLE } from "@/lib/leave-note-format";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts?: RequestInit) {
  const r = await fetch(`${API}/api${path}`, {
    ...opts,
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...(opts?.headers || {}) },
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// Avatar upload now goes through AvatarCropModal (drag-to-reposition + zoom),
// which exports the framed square as a JPEG data URL directly. The old
// fileToAvatarDataUrl helper (raw downscale, no framing) is retired.

const ROLE_BADGES: Record<string, React.CSSProperties> = {
  owner:      { background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid rgba(91,155,213,0.3)' },
  admin:      { background: '#EDE9FE', color: '#5B21B6', border: '1px solid #DDD6FE' },
  technician: { background: '#DCFCE7', color: '#166534', border: '1px solid #BBF7D0' },
  office:     { background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A' },
  team_lead:  { background: '#FFF7ED', color: '#C2410C', border: '1px solid #FED7AA' },
  super_admin:{ background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid rgba(91,155,213,0.3)' },
  accountant: { background: '#F0FAF7', color: '#0A5A48', border: '1px solid #B8EBDF' },
};

const PAY_TYPE_COLORS: Record<string, { bg: string; color: string }> = {
  tips:          { bg: '#DCFCE7', color: '#166534' },
  bonus:         { bg: '#DBEAFE', color: '#1E40AF' },
  holiday_pay:   { bg: '#EDE9FE', color: '#5B21B6' },
  sick_pay:      { bg: '#FEF3C7', color: '#92400E' },
  vacation_pay:  { bg: '#CCFBF1', color: '#0F766E' },
  compliment:    { bg: '#FEE2E2', color: '#991B1B' },
  amount_owed:   { bg: '#F3F4F6', color: '#6B7280' },
  mileage:       { bg: '#FEF9C3', color: '#78350F' },
};

const TICKET_TYPE_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  breakage:               { bg: '#FEE2E2', color: '#991B1B', label: 'Breakage' },
  complaint_poor_cleaning:{ bg: '#FEF3C7', color: '#92400E', label: 'Complaint - Poor Cleaning' },
  complaint_attitude:     { bg: '#FEF3C7', color: '#92400E', label: 'Complaint - Attitude' },
  compliment:             { bg: '#DCFCE7', color: '#166534', label: 'Compliment' },
  incident:               { bg: '#FEE2E2', color: '#991B1B', label: 'Incident' },
  note:                   { bg: '#F3F4F6', color: '#6B7280', label: 'Note' },
  time_off_request:       { bg: '#E0F2FE', color: '#075985', label: 'Time-Off Request' },
};

const SCORE_LABELS = ['', 'Poor', 'Fair', 'Good', 'Excellent'];
const SCORE_COLORS = ['', '#991B1B', '#D97706', '#1E40AF', '#166534'];
const SCORE_BGS   = ['', '#FEE2E2', '#FEF3C7', '#DBEAFE', '#DCFCE7'];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_IDX: Record<string, number> = { Mon:0,Tue:1,Wed:2,Thu:3,Fri:4,Sat:5,Sun:6 };
const TABS = [
  'Information','Pay','Earnings','Attendance','Availability',
  'User Account','Contacts','Performance Score','Pay Configuration','Additional Pay',
  'Payroll History',
  'Contact Tickets','Jobs','Notes','Incentives',
  'HR Attendance','Leave Balance','Discipline','Quality','Onboarding',
];

// [Phase 1] Leave bucket display helpers. NOTE: this slug→color map is
// intentionally local + temporary — Phase 3 centralizes bucket config so it's
// tenant-dynamic (driven off leave_types), retiring this and the other
// hardcoded bucket maps. The tag mirrors the "/<bucket>" usage-note convention.
function leaveBucketTag(slug: string): string {
  const s = (slug || '').toLowerCase();
  if (s.includes('plawa') || s.includes('sick')) return '/plawa';
  if (s.includes('pto')) return '/pto';
  if (s.includes('unpaid')) return '/unpaid';
  if (s.includes('unexcused')) return '/unexcused';
  return '/' + s;
}
// Dispatch-board-consistent accent palette. White card + colored left bar /
// dot / label / number in this accent. (Phase 3 will source these per-tenant.)
// [Phase 3] Bucket accent/label are tenant-dynamic — resolved server-side from
// leave_types.display_config and delivered on each balance row (b.accent,
// b.chip_label). The chips look these up via a slug→display map built from the
// balances response (see bucketDisplayMap). Unknown slugs get a neutral accent.
type BucketDisp = { accent: string; label: string };
const NEUTRAL_ACCENT = '#374151';
const LEAVE_LOW = '#BA7517';  // amber — running low
const LEAVE_OUT = '#E24B4A';  // red — exhausted / step crossed
// Days until a YYYY-MM-DD date (UTC), and a "Mon DD" label.
function daysUntilYmd(ymd: string): number {
  const t = new Date(`${ymd}T00:00:00Z`).getTime();
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  return Math.round((t - today) / 86400000);
}
function shortDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// [Phase 4] Render a leave/attendance note as clean chips: a colored bucket
// chip + a status/kind chip + the human remainder. Presentation-only — parses
// both [MC import] and app-approved formats; falls back to plain text.
function NoteChips({ note, bucketMap }: { note: string | null | undefined; bucketMap?: Record<string, BucketDisp> }) {
  const p = parseLeaveNote(note);
  if (!p.bucketSlug && !p.kind && !p.clean) {
    return <span style={{ fontSize: 12, color: '#9E9B94' }}>—</span>;
  }
  const toneStyle = KIND_TONE_STYLE[p.kindTone];
  const disp = p.bucketSlug ? bucketMap?.[p.bucketSlug] : undefined;
  const chipAccent = disp?.accent || NEUTRAL_ACCENT;
  const chipLabel = disp?.label || leaveBucketLabel(p.bucketSlug);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {p.bucketSlug && (
        <span style={{ fontSize: 10.5, fontWeight: 700, color: chipAccent, background: '#FFFFFF', border: `1px solid ${chipAccent}`, borderRadius: 99, padding: '1px 7px', whiteSpace: 'nowrap' }}>{chipLabel}</span>
      )}
      {p.kind && (
        <span style={{ fontSize: 10.5, fontWeight: 600, color: toneStyle.fg, background: toneStyle.bg, borderRadius: 99, padding: '1px 7px', whiteSpace: 'nowrap' }}>{p.kind}</span>
      )}
      {p.clean && <span style={{ fontSize: 12, color: '#6B6860' }}>{p.clean}</span>}
    </div>
  );
}

const PAY_GROUPS: { label: string; types: string[] }[] = [
  { label: 'Earnings',    types: ['bonus', 'tips', 'mileage'] },
  { label: 'Time Off',   types: ['sick_pay', 'holiday_pay', 'vacation_pay'] },
  { label: 'Other',      types: ['compliment', 'amount_owed'] },
];

const PAY_LABELS: Record<string, string> = {
  bonus:        'Bonus',
  tips:         'Tips',
  mileage:      'Mileage',
  sick_pay:     'Sick Pay',
  holiday_pay:  'Holiday Pay',
  vacation_pay: 'Vacation Pay',
  compliment:   'Compliment',
  amount_owed:  'Amount Owed',
};

const STATUS_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  pending: { bg: '#FEF3C7', color: '#92400E',  label: 'Pending' },
  paid:    { bg: '#DCFCE7', color: '#166534',  label: 'Paid' },
  voided:  { bg: '#F3F4F6', color: '#6B7280',  label: 'Voided' },
};

const SKILLS_OPTIONS = [
  'Maintenance Cleaning','Deep Clean','Move In/Move Out','Commercial Cleaning',
  'Post-Construction','Window Cleaning','Carpet Cleaning',
];
const COMMON_TAGS = ['Scheduled','Team Lead','Bilingual','Driver','Key Holder'];

function InitialAvatar({ name, size = 96 }: { name: string; size?: number }) {
  const initials = name.split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: 12,
      background: 'var(--brand-dim)', color: 'var(--brand)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size / 3, fontWeight: 700, flexShrink: 0,
    }}>{initials}</div>
  );
}

function Badge({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px',
      borderRadius: 20, fontSize: 11, fontWeight: 600,
      background: 'var(--brand-dim)', color: 'var(--brand)',
      ...style,
    }}>{children}</span>
  );
}

function RemovableBadge({ label, onRemove, style }: { label: string; onRemove: () => void; style?: React.CSSProperties }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px',
      borderRadius: 20, fontSize: 12, fontWeight: 500,
      background: '#F3F4F6', color: '#374151', border: '1px solid #E5E7EB',
      ...style,
    }}>
      {label}
      <button onClick={onRemove} style={{ background:'none',border:'none',cursor:'pointer',padding:0,display:'flex',alignItems:'center',color:'#9CA3AF',lineHeight:1 }}>
        <X size={12} />
      </button>
    </span>
  );
}

function SectionCard({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, padding:'20px 24px', marginBottom:16 }}>
      {title && <p style={{ margin:'0 0 16px 0', fontSize:13, fontWeight:700, color:'#1A1917', letterSpacing:'0.03em', textTransform:'uppercase' }}>{title}</p>}
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
      <label style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.06em' }}>{label}</label>
      {children}
    </div>
  );
}

function Input({ value, onChange, type='text', readOnly }: { value: string; onChange?: (v: string) => void; type?: string; readOnly?: boolean }) {
  return (
    <input
      type={type}
      value={value || ''}
      readOnly={readOnly}
      onChange={e => onChange?.(e.target.value)}
      style={{
        height:36, padding:'0 12px', border:'1px solid #E5E2DC', borderRadius:8,
        fontSize:13, color:'#1A1917', background: readOnly ? '#F7F6F3' : '#FFFFFF',
        outline:'none', width:'100%',
      }}
    />
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      style={{
        height:36, padding:'0 10px', border:'1px solid #E5E2DC', borderRadius:8,
        fontSize:13, color:'#1A1917', background:'#FFFFFF', outline:'none', width:'100%',
      }}
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer' }}>
      <div
        onClick={() => onChange(!value)}
        style={{
          width:40, height:22, borderRadius:11, position:'relative', cursor:'pointer',
          background: value ? 'var(--brand)' : '#D1D5DB', transition:'background 0.2s',
        }}
      >
        <div style={{
          position:'absolute', top:3, left: value ? 21 : 3, width:16, height:16,
          borderRadius:8, background:'#FFFFFF', transition:'left 0.2s',
          boxShadow:'0 1px 3px rgba(0,0,0,0.15)',
        }} />
      </div>
      <span style={{ fontSize:13, color:'#1A1917' }}>{label}</span>
    </label>
  );
}

function StarRating({ score, max=4 }: { score: number; max?: number }) {
  return (
    <div style={{ display:'flex', gap:2 }}>
      {Array.from({ length: max }).map((_, i) => (
        <svg key={i} width={16} height={16} viewBox="0 0 24 24"
          fill={i < Math.floor(score) ? 'var(--brand)' : (i < score ? 'url(#half)' : 'none')}
          stroke="var(--brand)" strokeWidth={1.5}>
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      ))}
    </div>
  );
}

function AttendanceCalendar({ userId }: { userId: number }) {
  const isMobile = useIsMobile();
  const [monthDate, setMonthDate] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const year  = monthDate.getFullYear();
  const month = monthDate.getMonth();

  const from = `${year}-${String(month+1).padStart(2,'0')}-01`;
  const lastDay = new Date(year, month+1, 0).getDate();
  const to = `${year}-${String(month+1).padStart(2,'0')}-${lastDay}`;

  const { data: clockData } = useQuery({
    queryKey: ['timeclock', userId, from, to],
    queryFn: () => apiFetch(`/timeclock?user_id=${userId}&date_from=${from}&date_to=${to}`),
  });

  const clockMap: Record<string, { in: string; out: string }> = {};
  for (const entry of (clockData?.data || [])) {
    if (entry.clocked_in_at) {
      const d = entry.clocked_in_at.slice(0, 10);
      const tin  = new Date(entry.clocked_in_at).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
      const tout = entry.clocked_out_at ? new Date(entry.clocked_out_at).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }) : '';
      clockMap[d] = { in: tin, out: tout };
    }
  }

  const firstDow = new Date(year, month, 1).getDay();
  const blanks   = (firstDow + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const prevMonth = () => setMonthDate(new Date(year, month - 1, 1));
  const nextMonth = () => setMonthDate(new Date(year, month + 1, 1));

  const monthLabel = monthDate.toLocaleString('default', { month: 'long', year: 'numeric' });

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <button onClick={prevMonth} style={{ background:'none',border:'1px solid #E5E2DC',borderRadius:6,padding:'4px 6px',cursor:'pointer',display:'flex',alignItems:'center' }}><ChevronLeft size={14}/></button>
          <span style={{ fontSize:14,fontWeight:600,color:'#1A1917',minWidth:160,textAlign:'center' }}>{monthLabel}</span>
          <button onClick={nextMonth} style={{ background:'none',border:'1px solid #E5E2DC',borderRadius:6,padding:'4px 6px',cursor:'pointer',display:'flex',alignItems:'center' }}><ChevronRight size={14}/></button>
        </div>
        <button onClick={() => setMonthDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
          style={{ padding:'6px 12px',border:'1px solid #E5E2DC',borderRadius:7,fontSize:12,fontWeight:600,background:'#FFFFFF',cursor:'pointer',color:'#6B7280' }}>
          Today
        </button>
      </div>

      <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:12 }}>
        {[
          { label:'Worked', bg:'#DCFCE7', color:'#166534' },
          { label:'PTO', bg:'#DBEAFE', color:'#1E40AF' },
          { label:'Time Off', bg:'#FEF3C7', color:'#92400E' },
          { label:'Unexcused', bg:'#FEE2E2', color:'#991B1B' },
        ].map(l => (
          <div key={l.label} style={{ display:'flex',alignItems:'center',gap:5 }}>
            <div style={{ width:10,height:10,borderRadius:2,background:l.bg,border:`1px solid ${l.color}20` }}/>
            <span style={{ fontSize:11,color:'#6B7280' }}>{l.label}</span>
          </div>
        ))}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:1, background:'#E5E2DC', borderRadius:8, overflow:'hidden' }}>
        {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => (
          <div key={d} style={{ background:'#F7F6F3',padding:'6px 0',textAlign:'center',fontSize: isMobile ? 9 : 11,fontWeight:600,color:'#9E9B94' }}>{isMobile ? d.slice(0,1) : d}</div>
        ))}
        {Array.from({ length: blanks }).map((_,i) => (
          <div key={`b${i}`} style={{ background:'#F7F6F3', minHeight: isMobile ? 40 : 64 }} />
        ))}
        {Array.from({ length: daysInMonth }).map((_,i) => {
          const day  = i + 1;
          const key  = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
          const worked = clockMap[key];
          const today  = new Date().toISOString().slice(0,10) === key;
          return (
            <div key={key} style={{
              background: worked ? '#DCFCE7' : '#FFFFFF',
              minHeight: isMobile ? 40 : 64, padding: isMobile ? '4px 3px' : '6px 8px', position:'relative',
              outline: today ? '2px solid var(--brand)' : 'none',
              outlineOffset:'-1px',
            }}>
              <span style={{ fontSize: isMobile ? 9 : 11,fontWeight: today ? 700 : 500, color: worked ? '#166534' : '#9E9B94' }}>{day}</span>
              {worked && (
                <div style={{ marginTop:2 }}>
                  <p style={{ fontSize:9,color:'#166534',margin:0,fontWeight:600 }}>{worked.in}</p>
                  {worked.out && <p style={{ fontSize:9,color:'#6B7280',margin:0 }}>{worked.out}</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScoreTrendChart({ scores }: { scores: Array<{ month: string; score: number }> }) {
  if (!scores.length) return <div style={{ height:80,display:'flex',alignItems:'center',justifyContent:'center',color:'#9E9B94',fontSize:13 }}>No scorecard data</div>;
  const max = 4;
  const w = 400, h = 80, pad = 20;
  const pts = scores.map((s, i) => ({
    x: pad + (i / (scores.length - 1 || 1)) * (w - pad * 2),
    y: h - pad - (s.score / max) * (h - pad * 2),
    score: s.score,
  }));
  const path = pts.map((p, i) => `${i===0?'M':'L'}${p.x},${p.y}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width:'100%', height:80 }}>
      <path d={path} fill="none" stroke="var(--brand)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/>
      {pts.map((p,i) => (
        <circle key={i} cx={p.x} cy={p.y} r={4} fill="var(--brand)" />
      ))}
    </svg>
  );
}

function OnboardingTab({ employeeId }: { employeeId: number }) {
  const [showSendModal, setShowSendModal] = useState(false);
  const [selectedTemplates, setSelectedTemplates] = useState<number[]>([]);
  const [sending, setSending] = useState(false);
  const [sendDone, setSendDone] = useState(false);
  const [resendingId, setResendingId] = useState<number | null>(null);

  const { data: requests, refetch } = useQuery({
    queryKey: ['onboarding-requests', employeeId],
    queryFn: () => apiFetch(`/document-requests?employee_id=${employeeId}`),
  });
  const { data: templates } = useQuery({
    queryKey: ['doc-templates-onboarding'],
    queryFn: () => apiFetch('/document-templates?category=employee_onboarding'),
    enabled: showSendModal,
  });

  const handleSend = async () => {
    if (!selectedTemplates.length) return;
    setSending(true);
    try {
      await apiFetch('/document-requests/send', { method: 'POST', body: JSON.stringify({ template_ids: selectedTemplates, employee_id: employeeId }) });
      setSendDone(true);
      setTimeout(() => { setShowSendModal(false); setSendDone(false); setSelectedTemplates([]); refetch(); }, 1500);
    } catch { /* ignore */ }
    setSending(false);
  };

  const handleResend = async (requestId: number) => {
    setResendingId(requestId);
    try {
      await apiFetch(`/document-requests/${requestId}/resend`, { method: 'POST' });
      refetch();
    } catch { /* ignore */ }
    setResendingId(null);
  };

  const toggleTemplate = (id: number) => setSelectedTemplates(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);

  const TH = { padding: '10px 14px', textAlign: 'left' as const, fontSize: 11, fontWeight: 600, color: '#9E9B94', textTransform: 'uppercase' as const, letterSpacing: '0.05em', borderBottom: '1px solid #EEECE7' };

  const docList: any[] = requests || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={() => setShowSendModal(true)}
          style={{ display:'flex',alignItems:'center',gap:6,padding:'8px 16px',background:'var(--brand)',color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>
          Send Onboarding Packet
        </button>
      </div>

      {showSendModal && (
        <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000 }}>
          <div style={{ background:'#fff',borderRadius:12,padding:28,width:440,boxShadow:'0 20px 60px rgba(0,0,0,0.2)',maxHeight:'80vh',overflowY:'auto' }}>
            <h3 style={{ margin:'0 0 4px',fontSize:16,fontWeight:700,color:'#1A1917' }}>Send Onboarding Packet</h3>
            <p style={{ fontSize:13,color:'#6B7280',margin:'0 0 16px' }}>Select which documents to include.</p>
            {sendDone ? (
              <div style={{ textAlign:'center',padding:'20px 0' }}>
                <Check size={24} color="var(--brand)" style={{ display:'block',margin:'0 auto 8px' }}/>
                <p style={{ fontSize:14,fontWeight:600,color:'#1A1917' }}>Packet sent!</p>
              </div>
            ) : (
              <>
                <div style={{ display:'flex',flexDirection:'column',gap:8,marginBottom:16 }}>
                  {!templates || templates.length === 0 ? (
                    <p style={{ fontSize:13,color:'#9E9B94' }}>No onboarding templates yet. Add them in Company Settings → Documents.</p>
                  ) : templates.map((t: any) => (
                    <label key={t.id} style={{ display:'flex',alignItems:'center',gap:10,cursor:'pointer',padding:'10px 12px',border:`1px solid ${selectedTemplates.includes(t.id)?'var(--brand)':'#E5E2DC'}`,borderRadius:8,background:selectedTemplates.includes(t.id)?'#F0FBF8':'#fff' }}>
                      <input type="checkbox" checked={selectedTemplates.includes(t.id)} onChange={() => toggleTemplate(t.id)} style={{ accentColor:'var(--brand)',width:15,height:15 }}/>
                      <div>
                        <p style={{ fontSize:13,fontWeight:600,color:'#1A1917',margin:0 }}>{t.name}</p>
                        {t.requires_signature && <p style={{ fontSize:11,color:'#9E9B94',margin:0 }}>Requires signature</p>}
                      </div>
                    </label>
                  ))}
                </div>
                <div style={{ display:'flex',gap:8,justifyContent:'flex-end' }}>
                  <button onClick={() => { setShowSendModal(false); setSelectedTemplates([]); }}
                    style={{ padding:'8px 16px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,background:'#fff',cursor:'pointer',fontFamily:'inherit' }}>Cancel</button>
                  <button onClick={handleSend} disabled={sending || !selectedTemplates.length}
                    style={{ padding:'8px 16px',background:'var(--brand)',color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit',opacity:selectedTemplates.length?1:0.5 }}>
                    {sending ? 'Sending…' : 'Send Packet'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ background:'#fff',border:'1px solid #E5E2DC',borderRadius:10,overflow:'hidden' }}>
        <table style={{ width:'100%',borderCollapse:'collapse' }}>
          <thead><tr style={{ background:'#FAFAF8' }}>
            {['Document','Sent','Status',''].map(h => <th key={h} style={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {docList.length === 0 ? (
              <tr><td colSpan={4} style={{ padding:'40px',textAlign:'center',color:'#9E9B94',fontSize:13 }}>No onboarding documents sent yet</td></tr>
            ) : docList.map((d: any) => (
              <tr key={d.id} style={{ borderBottom:'1px solid #F3F4F6' }}>
                <td style={{ padding:'12px 14px',fontSize:13,fontWeight:600,color:'#1A1917' }}>{d.template_name || 'Document'}</td>
                <td style={{ padding:'12px 14px',fontSize:12,color:'#6B7280' }}>{d.sent_at ? new Date(d.sent_at).toLocaleDateString() : '—'}</td>
                <td style={{ padding:'12px 14px' }}>
                  {d.status === 'signed'
                    ? <span style={{ background:'#DCFCE7',color:'#166534',border:'1px solid #BBF7D0',padding:'2px 8px',borderRadius:20,fontSize:11,fontWeight:600 }}>Signed</span>
                    : d.status === 'expired'
                    ? <span style={{ background:'#F3F4F6',color:'#6B7280',border:'1px solid #E5E7EB',padding:'2px 8px',borderRadius:20,fontSize:11,fontWeight:600 }}>Expired</span>
                    : <span style={{ background:'#FEF3C7',color:'#92400E',border:'1px solid #FDE68A',padding:'2px 8px',borderRadius:20,fontSize:11,fontWeight:600 }}>Pending</span>
                  }
                </td>
                <td style={{ padding:'12px 14px' }}>
                  {(d.status === 'pending' || d.status === 'expired') && (
                    <button onClick={() => handleResend(d.id)} disabled={resendingId === d.id}
                      style={{ fontSize:12,color:'var(--brand)',background:'none',border:'none',cursor:'pointer',fontWeight:600,padding:0,fontFamily:'inherit' }}>
                      {resendingId === d.id ? '…' : 'Resend'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function EmployeeProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const userId = parseInt(id!);
  const qc = useQueryClient();
  const [photoBusy, setPhotoBusy] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);

  function onPhotoSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) setCropFile(file);   // open the adjust/crop modal instead of uploading raw
  }

  async function savePhoto(avatar_url: string) {
    setPhotoBusy(true);
    try {
      await apiFetch(`/users/${userId}`, { method: "PUT", body: JSON.stringify({ avatar_url }) });
      refetchUser();
      // Refresh the top-right header emblem (/me) so an owner editing their own
      // photo sees it update immediately, not just in this profile card.
      qc.invalidateQueries();
      setCropFile(null);
    } catch { /* leave existing photo */ }
    finally { setPhotoBusy(false); }
  }
  const isMobile = useIsMobile();
  const isOwner = getTokenRole() === 'owner';
  const { activateView } = useEmployeeView();

  const [activeTab, setActiveTab] = useState('Information');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3000); };

  const { data: user, isLoading, refetch: refetchUser } = useQuery({
    queryKey: ['user', userId],
    queryFn: () => apiFetch(`/users/${userId}`),
  });

  // [reactivate 2026-07-01] Un-archive an archived employee. An archived tech
  // (archived_at set) is off the active roster even though is_active=true —
  // this clears archived_at via the restore endpoint so they return to
  // dispatch, the time clock, payroll, and pickers.
  const [restoring, setRestoring] = useState(false);
  const reactivateEmployee = async () => {
    setRestoring(true);
    try {
      await apiFetch(`/users/${userId}/lms-restore`, { method: 'POST' });
      await refetchUser();
      qc.invalidateQueries({ queryKey: ['users'] });
      showToast('Employee reactivated');
    } catch (e: any) {
      showToast(e?.message || 'Reactivate failed');
    } finally {
      setRestoring(false);
    }
  };

  // [terminate 2026-07-01] HR separation flow. Records reason + dates, marks the
  // employee inactive, and archives them so they drop off the active roster.
  // Reversible via the Reactivate button (lms-restore clears it all).
  const TERMINATION_REASON_OPTIONS = [
    { value: 'resigned',        label: 'Resigned (voluntary)' },
    { value: 'job_abandonment', label: 'Job abandonment / no-call-no-show' },
    { value: 'performance',     label: 'Terminated – performance' },
    { value: 'misconduct',      label: 'Terminated – misconduct / policy' },
    { value: 'laid_off',        label: 'Laid off' },
    { value: 'end_of_season',   label: 'End of season / contract' },
    { value: 'other',           label: 'Other' },
  ];
  const reasonLabel = (v?: string | null) =>
    TERMINATION_REASON_OPTIONS.find(o => o.value === v)?.label ?? (v || '');
  const [termOpen, setTermOpen] = useState(false);
  const [termReason, setTermReason] = useState('');
  const [termDate, setTermDate] = useState('');
  const [termLastDay, setTermLastDay] = useState('');
  const [termRehire, setTermRehire] = useState<'' | 'yes' | 'no'>('');
  const [terminating, setTerminating] = useState(false);
  const submitTermination = async () => {
    if (!termReason) { showToast('Pick a reason'); return; }
    if (!termDate) { showToast('Pick a termination date'); return; }
    setTerminating(true);
    try {
      await apiFetch(`/users/${userId}/terminate`, {
        method: 'POST',
        body: JSON.stringify({
          termination_date: termDate,
          last_day_worked: termLastDay || null,
          termination_reason: termReason,
          rehire_eligible: termRehire === '' ? null : termRehire === 'yes',
        }),
      });
      await refetchUser();
      qc.invalidateQueries({ queryKey: ['users'] });
      setTermOpen(false);
      showToast('Employee terminated');
    } catch (e: any) {
      showToast(e?.message || 'Terminate failed');
    } finally {
      setTerminating(false);
    }
  };

  const { data: availabilityData } = useQuery({
    queryKey: ['availability', userId],
    queryFn: () => apiFetch(`/users/${userId}/availability`),
    enabled: activeTab === 'Availability',
  });

  // [profile-attendance-real-balances 2026-06-24 · Phase 1] Data-driven leave
  // cards: one per active tenant bucket from the real 3A balances endpoint
  // (same source as the Leave Balance tab). Usage history comes from the new
  // /leave/usage feed (the deprecated /hr-leave/balance/:id is retired here).
  // The bucket of each usage row lives in its note tag ("…/pto","…/plawa",…).
  const [historyBucket, setHistoryBucket] =
    useState<null | { slug: string; display_name: string; leave_type_id?: number }>(null);

  // [attendance-record 2026-06-25] Office record form for an unexcused absence
  // or a tardy, with a reason. Posts to /leave/unexcused/record (type
  // 'absent'|'tardy'); the server stores the reason behind the
  // "unexcused hours: X (reason)" marker and drives the occurrence ladder
  // live (real-time entries DO fire the ladder — unlike the historical backfill).
  const [recordModal, setRecordModal] =
    useState<null | { type: 'absent' | 'tardy'; title: string; accent: string }>(null);
  const [recDate, setRecDate] = useState('');
  const [recHours, setRecHours] = useState('');
  const [recReason, setRecReason] = useState('');
  const [recBusy, setRecBusy] = useState(false);
  const [recErr, setRecErr] = useState<string | null>(null);
  const openRecord = (type: 'absent' | 'tardy', accent: string) => {
    setRecDate(new Date().toISOString().slice(0, 10));
    setRecHours(''); setRecReason(''); setRecErr(null);
    setRecordModal({ type, accent, title: type === 'tardy' ? 'Record tardy' : 'Record unexcused absence' });
  };
  const submitRecord = async () => {
    setRecErr(null);
    const hrs = Number(recHours);
    if (!recDate) { setRecErr('Pick a date'); return; }
    if (!Number.isFinite(hrs) || hrs <= 0) { setRecErr('Hours must be a positive number'); return; }
    setRecBusy(true);
    try {
      await apiFetch('/leave/unexcused/record', {
        method: 'POST',
        body: JSON.stringify({
          employee_id: Number(userId),
          log_date: recDate,
          hours: hrs,
          type: recordModal!.type,
          notes: recReason.trim() || undefined,
        }),
      });
      qc.invalidateQueries({ queryKey: ['attendance-summary', userId] });
      qc.invalidateQueries({ queryKey: ['leave-usage', userId] });
      qc.invalidateQueries({ queryKey: ['leave-balances', userId] });
      setRecordModal(null);
    } catch (e: any) {
      setRecErr(e?.message || 'Could not record — try again');
    } finally {
      setRecBusy(false);
    }
  };
  // [mc-migration 2026-07-07] Balance editor — the "Update" button on accrual
  // buckets (PTO / PLAWA / Unpaid Leave) was a dead no-op. It now opens this
  // editor and persists via PUT /leave/balances (same office-tier gate as
  // the API), then refetches the buckets.
  const [balModal, setBalModal] =
    useState<null | { leave_type_id: number; display_name: string; accent: string }>(null);
  const [balGranted, setBalGranted] = useState('');
  const [balUsed, setBalUsed] = useState('');
  const [balBusy, setBalBusy] = useState(false);
  const [balErr, setBalErr] = useState<string | null>(null);
  // [office-parity 2026-07-07] office included — Maribel/Francisco approve
  // requests and correct balances day-to-day (API gate widened to match).
  const canEditBalance = ['owner', 'admin', 'office', 'super_admin'].includes(getTokenRole() || '');
  const openBalanceEdit = (b: any) => {
    setBalGranted(String(Number(b.granted || 0)));
    setBalUsed(String(Number(b.used || 0)));
    setBalErr(null);
    setBalModal({ leave_type_id: b.leave_type_id, display_name: b.display_name, accent: b.accent || NEUTRAL_ACCENT });
  };
  const submitBalanceEdit = async () => {
    setBalErr(null);
    const granted = Number(balGranted);
    const used = Number(balUsed);
    if (balGranted.trim() === '' || !Number.isFinite(granted) || granted < 0) { setBalErr('Granted hours must be 0 or more'); return; }
    if (balUsed.trim() === '' || !Number.isFinite(used) || used < 0) { setBalErr('Used hours must be 0 or more'); return; }
    setBalBusy(true);
    try {
      await apiFetch('/leave/balances', {
        method: 'PUT',
        body: JSON.stringify({
          user_id: Number(userId),
          leave_type_id: balModal!.leave_type_id,
          granted_hours: granted,
          used_hours: used,
        }),
      });
      qc.invalidateQueries({ queryKey: ['leave-balances', userId] });
      qc.invalidateQueries({ queryKey: ['leave-usage', userId] });
      setBalModal(null);
    } catch (e: any) {
      setBalErr(e?.message === '403' ? 'Only owners and admins can set balances' : 'Could not save — try again');
    } finally {
      setBalBusy(false);
    }
  };
  // [leave-log 2026-07-07] Mistake corrections: remove a wrong attendance
  // record (un-counts it from the disciplinary ladders) or a wrong usage
  // entry (gives the hours back to the bucket). Both audited server-side.
  const canDeleteAttendance = ['owner', 'admin', 'office', 'super_admin'].includes(getTokenRole() || '');
  const [entryDelBusy, setEntryDelBusy] = useState<string | null>(null);
  const deleteEntry = async (kind: 'attendance' | 'usage', id: number) => {
    const msg = kind === 'attendance'
      ? 'Remove this attendance entry? It will no longer count toward the disciplinary ladder.'
      : 'Remove this leave entry? The hours go back to the bucket.';
    if (!window.confirm(msg)) return;
    setEntryDelBusy(`${kind}:${id}`);
    try {
      await apiFetch(`/leave/${kind}/${id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['attendance-summary', userId] });
      qc.invalidateQueries({ queryKey: ['leave-usage', userId] });
      qc.invalidateQueries({ queryKey: ['leave-balances', userId] });
      qc.invalidateQueries({ queryKey: ['leave-balance-log', userId] });
      // statDrill holds a snapshot of rows from when it was opened — close it
      // so the deleted entry can't linger. The bucket history modal derives
      // its rows live from the query cache, so it stays open.
      if (kind === 'attendance') setStatDrill(null);
    } catch {
      window.alert('Could not remove the entry — try again.');
    } finally {
      setEntryDelBusy(null);
    }
  };
  // Provenance feed for the "Balance changes" section of View History —
  // office sets + engine grants with their trigger (deploy/nightly/apply).
  const { data: balanceLogResp } = useQuery({
    queryKey: ['leave-balance-log', userId],
    queryFn: () => apiFetch(`/leave/balance-log?userId=${userId}`),
    enabled: activeTab === 'Attendance' && historyBucket != null,
  });
  const balanceLog: any[] = balanceLogResp?.data || [];
  const { data: leaveBalancesResp } = useQuery({
    queryKey: ['leave-balances', userId],
    queryFn: () => apiFetch(`/leave/balances?userId=${userId}`),
    enabled: activeTab === 'Attendance',
  });
  const leaveBuckets: any[] = leaveBalancesResp?.data || [];
  // [Phase 3] slug → {accent, chip label} for the history chips, built from the
  // tenant's balance rows (which now carry display from leave_types config).
  const bucketDisplayMap: Record<string, BucketDisp> = Object.fromEntries(
    leaveBuckets.map((b: any) => [b.slug, { accent: b.accent || NEUTRAL_ACCENT, label: b.chip_label || b.display_name }]),
  );
  const { data: leaveUsageResp } = useQuery({
    queryKey: ['leave-usage', userId],
    queryFn: () => apiFetch(`/leave/usage?userId=${userId}`),
    enabled: activeTab === 'Attendance',
  });
  const leaveUsage: any[] = leaveUsageResp?.data || [];

  // [Phase 2] Real attendance stats + per-day drill-downs. Default 180-day
  // window (the API accepts windowDays 30/90/180/365 for a future selector).
  const [statDrill, setStatDrill] = useState<null | { label: string; days: any[] }>(null);
  const { data: attnSummaryResp } = useQuery({
    queryKey: ['attendance-summary', userId],
    queryFn: () => apiFetch(`/leave/attendance-summary?userId=${userId}&windowDays=180`),
    enabled: activeTab === 'Attendance',
  });
  const attnSummary: any = attnSummaryResp?.data || null;

  const { data: ticketsData, refetch: refetchTickets } = useQuery({
    queryKey: ['contact-tickets', userId],
    queryFn: () => apiFetch(`/users/${userId}/contact-tickets`),
    enabled: activeTab === 'Contact Tickets',
  });

  const { data: notesData, refetch: refetchNotes } = useQuery({
    queryKey: ['employee-notes', userId],
    queryFn: () => apiFetch(`/users/${userId}/notes`),
    enabled: activeTab === 'Notes',
  });

  const { data: zonesData } = useQuery({
    queryKey: ['zones'],
    queryFn: () => apiFetch('/zones'),
  });
  const zones: { id: number; name: string; color: string }[] = Array.isArray(zonesData) ? zonesData : [];
  const [zoneAssigning, setZoneAssigning] = useState(false);

  const { data: jobsData } = useQuery({
    queryKey: ['employee-jobs', userId],
    queryFn: () => apiFetch(`/users/${userId}/jobs`),
    enabled: activeTab === 'Jobs',
  });

  const { data: additionalPayData, refetch: refetchPay } = useQuery({
    queryKey: ['additional-pay', userId],
    queryFn: () => apiFetch(`/users/${userId}/additional-pay`),
    enabled: activeTab === 'Additional Pay',
  });

  const { data: payrollHistoryData } = useQuery({
    queryKey: ['payroll-history', userId],
    queryFn: () => apiFetch(`/users/${userId}/payroll-history`),
    enabled: activeTab === 'Payroll History',
  });

  // [Phase 2] Published-pay snapshots for this tech. Access-scoping is enforced
  // server-side: a technician token always gets its own pay regardless of the
  // user_id passed; office/admin/owner can view any tech.
  const { data: payData } = useQuery({
    queryKey: ['pay-history', userId],
    queryFn: () => apiFetch(`/payroll/pay-history?user_id=${userId}`),
    enabled: activeTab === 'Pay',
  });

  const [expandedPeriod, setExpandedPeriod] = useState<string | null>(null);
  const [expandedPayWeek, setExpandedPayWeek] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [bulkPayModal, setBulkPayModal] = useState(false);
  const [bulkStep, setBulkStep] = useState<1|2|3>(1);

  const { data: allEmployeesData } = useQuery({
    queryKey: ['all-employees-bulk'],
    queryFn: () => apiFetch('/users?is_active=true&limit=200'),
    enabled: bulkPayModal,
  });
  const [bulkSelectedEmps, setBulkSelectedEmps] = useState<number[]>([]);
  const [bulkPayType, setBulkPayType] = useState('bonus');
  const [bulkAmount, setBulkAmount] = useState('');
  const [bulkNotes, setBulkNotes] = useState('');
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkEmpSearch, setBulkEmpSearch] = useState('');
  const [printRecord, setPrintRecord] = useState<any | null>(null);

  const { data: scorecardsData, refetch: refetchScores } = useQuery({
    queryKey: ['scorecards-emp', userId],
    queryFn: () => apiFetch(`/users/${userId}/scorecards`),
    enabled: activeTab === 'Performance Score',
  });

  // MaidCentral % model: per-job history (scorecard_entries) + authoritative %.
  const { data: scEntriesData, refetch: refetchScEntries } = useQuery({
    queryKey: ['scorecard-entries', userId],
    queryFn: () => apiFetch(`/scorecards/entries/${userId}`),
    enabled: activeTab === 'Performance Score',
  });
  const scEntries: any[] = scEntriesData?.entries || [];

  // [90d-composite] Live 90-day rolling composite: three sub-scores + the
  // blended headline + counts. Drives the headline number and the breakdown
  // card below.
  const { data: compositeData } = useQuery({
    queryKey: ['scorecard-composite', userId],
    queryFn: () => apiFetch(`/scorecards/composite/${userId}`),
    enabled: activeTab === 'Performance Score',
  });

  // [GAP3] Office reply to customer feedback on a scorecard entry.
  const canReplyToFeedback = ['owner', 'admin', 'office'].includes(getTokenRole() || '');
  const [replyOpenId, setReplyOpenId] = useState<number | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replySaving, setReplySaving] = useState(false);
  async function submitFeedbackReply(entryId: number) {
    setReplySaving(true);
    try {
      await apiFetch(`/scorecards/entries/${entryId}/reply`, { method: 'POST', body: JSON.stringify({ reply: replyText }) });
      setReplyOpenId(null); setReplyText('');
      await refetchScEntries();
      showToast('Reply saved');
    } catch {
      showToast('Failed to save reply');
    } finally {
      setReplySaving(false);
    }
  }

  // Efficiency by Qleno package/scope (MaidCentral parity). catalog = every
  // Qleno package; rows = the ones with data. No-data packages render blank.
  const { data: efficiencyData } = useQuery({
    queryKey: ['efficiency-emp', userId],
    queryFn: () => apiFetch(`/efficiency/${userId}`),
    enabled: userId > 0,
  });
  const effCatalog: string[] = efficiencyData?.catalog || [];
  const effByPackage = new Map<string, number>(
    (efficiencyData?.rows || []).map((r: any) => [r.service_type, parseFloat(r.efficiency_pct)]),
  );
  // Only the budgeted/time-target packages (the catalog) are shown — pure-hourly
  // packages are intentionally excluded from efficiency entirely.
  const effPackages = effCatalog;

  const { data: incentivesData = [] } = useQuery<any[]>({
    queryKey: ['incentives-earned', userId],
    queryFn: () => apiFetch(`/incentives/earned?employee_id=${userId}`),
    enabled: activeTab === 'Incentives',
  });

  const [form, setForm] = useState<Record<string, any>>({});
  useEffect(() => { if (user) setForm(user); }, [user]);

  const setField = (k: string, v: any) => setForm(p => ({ ...p, [k]: v }));

  async function saveProfile() {
    setSaving(true);
    try {
      // [2026-06-02] Method is PUT, not PATCH. The backend only defines
      // PUT /api/users/:id (routes/users.ts:344); the previous PATCH call
      // returned 404 silently — toast showed "Save failed" but easy to
      // miss, so deactivations (is_active=false) never persisted. Reported
      // when Sal couldn't move Tatiana, Ana Valdez, Katie Fry to inactive.
      await apiFetch(`/users/${userId}`, { method: 'PUT', body: JSON.stringify(form) });
      showToast('Changes saved');
      refetchUser();
    } catch { showToast('Save failed'); }
    setSaving(false);
  }

  async function assignZone(zoneId: number | null) {
    setZoneAssigning(true);
    try {
      await apiFetch('/zones/user-zone', { method: 'PUT', body: JSON.stringify({ user_id: userId, zone_id: zoneId }) });
      showToast('Zone assignment updated');
      refetchUser();
    } catch { showToast('Failed to update zone'); }
    setZoneAssigning(false);
  }

  const [availability, setAvailability] = useState(
    DAYS.map((d, i) => ({ day_of_week: i, label: d, start_time: '08:00', end_time: '17:00', is_available: i < 5 }))
  );

  useEffect(() => {
    if (availabilityData?.data?.length) {
      setAvailability(prev =>
        prev.map(p => {
          const found = availabilityData.data.find((a: any) => a.day_of_week === p.day_of_week);
          return found ? { ...p, ...found } : p;
        })
      );
    }
  }, [availabilityData]);

  async function saveAvailability() {
    setSaving(true);
    try {
      await apiFetch(`/users/${userId}/availability`, { method: 'PUT', body: JSON.stringify({ availability }) });
      showToast('Availability saved');
    } catch { showToast('Save failed'); }
    setSaving(false);
  }

  const [noteModal, setNoteModal] = useState(false);
  const [noteContent, setNoteContent] = useState('');
  async function addNote() {
    if (!noteContent.trim()) return;
    await apiFetch(`/users/${userId}/notes`, { method: 'POST', body: JSON.stringify({ content: noteContent }) });
    setNoteModal(false); setNoteContent('');
    refetchNotes();
    showToast('Note added');
  }

  const [ticketModal, setTicketModal] = useState(false);
  const [newTicket, setNewTicket] = useState({ ticket_type: 'note', notes: '' });
  async function addTicket() {
    await apiFetch(`/users/${userId}/contact-tickets`, { method: 'POST', body: JSON.stringify(newTicket) });
    setTicketModal(false); setNewTicket({ ticket_type: 'note', notes: '' });
    refetchTickets();
    showToast('Ticket added');
  }

  const [payModal, setPayModal] = useState(false);
  const [newPay, setNewPay] = useState({ type: 'bonus', amount: '', notes: '', date: new Date().toISOString().slice(0, 10) });
  async function addPay() {
    await apiFetch(`/users/${userId}/additional-pay`, { method: 'POST', body: JSON.stringify(newPay) });
    setPayModal(false); setNewPay({ type: 'bonus', amount: '', notes: '', date: new Date().toISOString().slice(0, 10) });
    refetchPay();
    showToast('Pay entry added');
  }

  async function bulkPay() {
    if (!bulkSelectedEmps.length || !bulkAmount) return;
    setBulkSubmitting(true);
    try {
      const result = await apiFetch('/payroll/bulk-pay', {
        method: 'POST',
        body: JSON.stringify({ employee_ids: bulkSelectedEmps, type: bulkPayType, amount: bulkAmount, notes: bulkNotes }),
      });
      setBulkPayModal(false);
      refetchPay();
      showToast(`Bulk pay added for ${result.count} employee${result.count !== 1 ? 's' : ''}`);
    } catch { showToast('Failed to submit bulk pay'); }
    setBulkSubmitting(false);
  }

  async function voidPay(payId: number) {
    setVoidingId(payId);
    try {
      await apiFetch(`/users/${userId}/additional-pay/${payId}/void`, { method: 'PATCH' });
      refetchPay();
      showToast('Pay entry voided');
    } catch { showToast('Failed to void entry'); }
    setVoidingId(null);
  }

  async function deletePay(payId: number) {
    setDeletingId(payId);
    try {
      await apiFetch(`/users/${userId}/additional-pay/${payId}`, { method: 'DELETE' });
      refetchPay();
      showToast('Pay entry deleted');
    } catch { showToast('Cannot delete — only pending entries can be deleted'); }
    setDeletingId(null);
  }

  const [skillInput, setSkillInput] = useState('');
  const [tagInput, setTagInput] = useState('');

  if (isLoading) {
    return (
      <DashboardLayout>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:200, color:'#9E9B94', fontSize:14 }}>
          Loading employee profile…
        </div>
      </DashboardLayout>
    );
  }

  if (!user) {
    return (
      <DashboardLayout>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:200 }}>
          <p style={{ color:'#EF4444', fontSize:14 }}>Employee not found</p>
        </div>
      </DashboardLayout>
    );
  }

  const fullName = `${user.first_name} ${user.last_name}`;
  const scoreAvg = user.scorecard_avg ? parseFloat(user.scorecard_avg) : null;
  // MaidCentral-style percentage: prefer the authoritative imported %; fall back
  // to deriving from the legacy star average (score/4) until MC data is loaded.
  const scorePct = user.scorecard_pct != null ? parseFloat(user.scorecard_pct)
    : (scoreAvg != null ? Math.round(scoreAvg / 4 * 100) : null);

  // [90d-composite] Displayed headline = the rolling composite (falls back to
  // the satisfaction-only scorePct until the composite computes). Sub-scores +
  // counts power the breakdown card.
  const comp: any = compositeData || null;
  const compositeScore = comp?.composite != null ? Number(comp.composite) : scorePct;

  return (
    <DashboardLayout>
      <div style={{ display:'flex', flexDirection:'column', gap:0, maxWidth:1200, margin:'0 auto' }}>

        {/* Back nav */}
        <div style={{ marginBottom:16, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <button onClick={() => navigate('/employees')}
            style={{ display:'flex',alignItems:'center',gap:6,background:'none',border:'none',cursor:'pointer',color:'#6B7280',fontSize:13,padding:0,fontFamily:'inherit' }}>
            <ArrowLeft size={14}/> Back to Team
          </button>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            {/* [reactivate 2026-07-01] Un-archive control — only when the
                employee is actually archived (the state that hides them from
                the roster). Owner-only, mirrors the archive permission. */}
            {isOwner && user && user.role !== 'owner' && (user.archived_at || user.termination_date) && (
              <button
                onClick={reactivateEmployee}
                disabled={restoring}
                style={{
                  display:'flex', alignItems:'center', gap:6,
                  padding:'7px 14px', borderRadius:8,
                  border:'1px solid #00C9A0', background:'#00C9A0',
                  color:'#FFFFFF', fontSize:13, fontWeight:700,
                  cursor: restoring ? 'default' : 'pointer', fontFamily:'inherit',
                  opacity: restoring ? 0.6 : 1,
                }}
              >
                <RotateCcw size={14} strokeWidth={2} /> {restoring ? 'Reactivating…' : 'Reactivate'}
              </button>
            )}
            {isOwner && user && user.role !== 'owner' && (
              <button
                onClick={async () => {
                  await activateView({ employeeId: userId, employeeName: `${user.first_name} ${user.last_name}` });
                  navigate('/my-jobs');
                }}
                style={{
                  display:'flex', alignItems:'center', gap:6,
                  padding:'7px 14px', borderRadius:8,
                  border:'1px solid #E5E2DC', background:'#FFFFFF',
                  color:'#1A1917', fontSize:13, fontWeight:600,
                  cursor:'pointer', fontFamily:'inherit',
                }}
              >
                <Eye size={14} strokeWidth={1.5} /> View as Employee
              </button>
            )}
            {/* [terminate 2026-07-01] Terminate control — only for an active
                (non-separated) employee. Owner-only. Opens the reason/date modal. */}
            {isOwner && user && user.role !== 'owner' && !user.archived_at && !user.termination_date && (
              <button
                onClick={() => { setTermReason(''); setTermDate(''); setTermLastDay(''); setTermRehire(''); setTermOpen(true); }}
                style={{
                  display:'flex', alignItems:'center', gap:6,
                  padding:'7px 14px', borderRadius:8,
                  border:'1px solid #FECACA', background:'#FFFFFF',
                  color:'#B91C1C', fontSize:13, fontWeight:600,
                  cursor:'pointer', fontFamily:'inherit',
                }}
              >
                <Ban size={14} strokeWidth={1.75} /> Terminate
              </button>
            )}
          </div>
        </div>

        {/* [terminate 2026-07-01] Terminate modal — reason + dates + rehire. */}
        {termOpen && (
          <div style={{ position:'fixed', inset:0, background:'rgba(10,14,26,0.55)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:300, padding:16 }}>
            <div style={{ background:'#FFFFFF', borderRadius:16, padding:'22px 24px 20px', width:460, maxWidth:'100%', maxHeight:'90vh', overflowY:'auto', boxShadow:'0 24px 70px rgba(10,14,26,0.28)', fontFamily:'inherit' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:4 }}>
                <h3 style={{ margin:0, fontSize:17, fontWeight:700, color:'#0A0E1A' }}>Terminate {user.first_name} {user.last_name}</h3>
                <button onClick={() => setTermOpen(false)} aria-label="Close" style={{ background:'transparent', border:0, fontSize:22, color:'#9E9B94', cursor:'pointer', lineHeight:1, padding:'0 0 0 12px' }}>×</button>
              </div>
              <p style={{ margin:'0 0 16px', fontSize:12.5, color:'#6B6860' }}>
                Records the separation and removes them from the active roster (dispatch, time clock, payroll). Reversible via Reactivate.
              </p>
              <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                <div>
                  <label style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Reason</label>
                  <Select value={termReason} onChange={setTermReason}
                    options={[{ value:'', label:'Select a reason…' }, ...TERMINATION_REASON_OPTIONS]} />
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                  <div>
                    <label style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Termination date</label>
                    <CalendarPopover value={termDate} ariaLabel="Termination date" onChange={setTermDate} block />
                  </div>
                  <div>
                    <label style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Last day worked</label>
                    <CalendarPopover value={termLastDay} ariaLabel="Last day worked" onChange={setTermLastDay} block />
                  </div>
                </div>
                <div>
                  <label style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Eligible for rehire?</label>
                  <div style={{ display:'flex', gap:8 }}>
                    {([{v:'yes',l:'Yes'},{v:'no',l:'No'},{v:'',l:'Unspecified'}] as {v:''|'yes'|'no';l:string}[]).map(o => {
                      const on = termRehire === o.v;
                      return (
                        <button key={o.l} type="button" onClick={() => setTermRehire(o.v)}
                          style={{ padding:'6px 14px', borderRadius:999, fontSize:12.5, fontWeight:600, fontFamily:'inherit', cursor:'pointer',
                            border:`1px solid ${on ? '#00C9A0' : '#E5E2DC'}`, background:on ? '#F0FBF8' : '#FFFFFF', color:on ? '#0A6E5A' : '#6B6860' }}>
                          {o.l}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
                <button onClick={() => setTermOpen(false)} disabled={terminating}
                  style={{ padding:'9px 18px', border:'1px solid #E5E2DC', borderRadius:8, fontSize:13, fontWeight:600, color:'#6B6860', background:'#FFFFFF', cursor:'pointer', fontFamily:'inherit' }}>Cancel</button>
                <button onClick={submitTermination} disabled={terminating || !termReason || !termDate}
                  style={{ padding:'9px 22px', borderRadius:8, fontSize:13, fontWeight:700, fontFamily:'inherit', border:'none',
                    background:(terminating || !termReason || !termDate) ? '#E5E2DC' : '#DC2626',
                    color:(terminating || !termReason || !termDate) ? '#9E9B94' : '#FFFFFF',
                    cursor:(terminating || !termReason || !termDate) ? 'default' : 'pointer' }}>
                  {terminating ? 'Terminating…' : 'Terminate'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── PROFILE HEADER ── */}
        <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:12, padding: isMobile ? '16px' : '24px 32px', marginBottom:2, display:'flex', flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? 16 : 32, alignItems:'flex-start' }}>
          {/* Top row on mobile: avatar + info side-by-side */}
          <div style={{ display:'flex', flexDirection:'row', gap:16, alignItems:'flex-start', flex:1, minWidth:0 }}>
          {/* Left: avatar */}
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, flexShrink:0 }}>
            {user.avatar_url
              ? <img src={user.avatar_url} alt={fullName} style={{ width: isMobile ? 72 : 96, height: isMobile ? 72 : 96, borderRadius:12, objectFit:'cover' }} />
              : <InitialAvatar name={fullName} size={isMobile ? 72 : 96} />
            }
            <label style={{ fontSize:11, color:'var(--brand)', cursor: photoBusy ? 'default' : 'pointer', fontWeight:600, fontFamily:'inherit', opacity: photoBusy ? 0.6 : 1 }}>
              <Camera size={11} style={{ marginRight:3, verticalAlign:'middle' }}/> {photoBusy ? 'Saving…' : (user.avatar_url ? 'Change photo' : 'Add photo')}
              <input type="file" accept="image/*" disabled={photoBusy} onChange={onPhotoSelected} style={{ display:'none' }} />
            </label>
          </div>
          {cropFile && (
            <AvatarCropModal
              file={cropFile}
              saving={photoBusy}
              onCancel={() => setCropFile(null)}
              onSave={savePhoto}
            />
          )}

          {/* Center: info */}
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap', marginBottom:4 }}>
              <h1 style={{ fontSize:22, fontWeight:700, color:'#1A1917', margin:0 }}>{fullName}</h1>
              <span style={{ ...ROLE_BADGES[user.role], padding:'3px 10px', borderRadius:4, fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', display:'inline-block' }}>
                {user.role?.replace('_',' ')}
              </span>
              {/* A terminated employee shows a single TERMINATED badge (it
                  implies inactive + archived) rather than three redundant ones. */}
              {user.termination_date
                ? <span title={`${reasonLabel(user.termination_reason)} · ${new Date(user.termination_date + 'T00:00:00').toLocaleDateString()}${user.rehire_eligible === false ? ' · not eligible for rehire' : user.rehire_eligible === true ? ' · eligible for rehire' : ''}`}
                    style={{ background:'#FEE2E2', color:'#991B1B', border:'1px solid #FECACA', padding:'3px 8px', borderRadius:4, fontSize:11, fontWeight:700 }}>TERMINATED</span>
                : <>
                    {!user.is_active && <span style={{ background:'#FEE2E2', color:'#991B1B', border:'1px solid #FECACA', padding:'3px 8px', borderRadius:4, fontSize:11, fontWeight:600 }}>INACTIVE</span>}
                    {user.archived_at && <span title={`Archived ${new Date(user.archived_at).toLocaleDateString()}`} style={{ background:'#FEF3C7', color:'#92400E', border:'1px solid #FDE68A', padding:'3px 8px', borderRadius:4, fontSize:11, fontWeight:600 }}>ARCHIVED</span>}
                  </>
              }
            </div>
            <p style={{ fontSize:11, color:'#9E9B94', margin:'0 0 8px 0' }}>Employee #{String(user.id).padStart(5,'0')}</p>
            <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
              {user.email && <span style={{ display:'flex',alignItems:'center',gap:5,fontSize:13,color:'#6B6860' }}><Mail size={12}/>{user.email}</span>}
              {user.phone && <span style={{ display:'flex',alignItems:'center',gap:5,fontSize:13,color:'#6B6860' }}><Phone size={12}/>{user.phone}</span>}
            </div>
            {user.hire_date && <p style={{ fontSize:12, color:'#9E9B94', margin:'6px 0 0 0' }}>Hired {new Date(user.hire_date + 'T00:00:00').toLocaleDateString()}</p>}
          </div>
          </div>{/* end avatar+info row */}

          {/* Right: snapshot + productivity */}
          <div style={{ flexShrink:0, width: isMobile ? '100%' : 280, display:'flex', flexDirection: isMobile ? 'row' : 'column', flexWrap:'wrap', gap:12 }}>
            <div style={{ background:'#F7F6F3', borderRadius:10, padding:'14px 16px', flex: isMobile ? '1 1 0' : undefined, minWidth: isMobile ? 0 : undefined }}>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                  <span style={{ fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.05em' }}>Hire Date</span>
                  <span style={{ fontSize:12,fontWeight:600,color:'var(--brand)' }}>{user.hire_date ? new Date(user.hire_date + 'T00:00:00').toLocaleDateString() : '—'}</span>
                </div>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span style={{ fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.05em' }}>Score</span>
                  <div style={{ display:'flex',alignItems:'center',gap:6 }}>
                    {scorePct != null ? (
                      <span style={{ fontSize:18,fontWeight:700,color:'var(--brand)' }}>{scorePct.toFixed(0)}%</span>
                    ) : <span style={{ fontSize:11,color:'#9E9B94' }}>No scores yet</span>}
                  </div>
                </div>
              </div>
            </div>

            <div style={{ background:'#F7F6F3', borderRadius:10, padding:'14px 16px', flex: isMobile ? '1 1 0' : undefined, minWidth: isMobile ? 0 : undefined }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                <p style={{ fontSize:12,fontWeight:700,color:'#1A1917',margin:0 }}>Efficiency by Service</p>
                <span style={{ fontSize:10,color:'#9E9B94' }}>Allowed ÷ Actual</span>
              </div>
              <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                {effPackages.length === 0 && (
                  <p style={{ fontSize:11, color:'#9E9B94', margin:'4px 0' }}>No efficiency data yet.</p>
                )}
                {effPackages.map((type) => {
                  const pct = effByPackage.get(type);
                  const hasData = pct != null && Number.isFinite(pct) && pct > 0;
                  return (
                    <div key={type} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6, gap:8 }}>
                      <span style={{ fontSize:12,color:'#1A1917' }}>{type}</span>
                      {hasData ? (
                        <span style={{ fontSize:12,fontWeight: pct>100 ? 700 : 600, color: pct>100 ? 'var(--brand)' : pct>=80 ? '#1A1917' : '#EF4444', whiteSpace:'nowrap' }}>{Math.round(pct)}%</span>
                      ) : (
                        <span style={{ fontSize:12,color:'#C9C6BF',whiteSpace:'nowrap' }}>—</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* ── TAB BAR ── */}
        <div style={{ background:'#FFFFFF', borderLeft:'1px solid #E5E2DC', borderRight:'1px solid #E5E2DC', borderBottom:'1px solid #E5E2DC', overflowX:'auto', marginBottom:20 }}>
          <div style={{ display:'flex', borderBottom:'1px solid #E5E2DC', whiteSpace:'nowrap' }}>
            {TABS.map(tab => (
              <button key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding:'12px 18px', background:'none', border:'none', cursor:'pointer',
                  fontSize:13, fontWeight: activeTab===tab ? 600 : 400,
                  color: activeTab===tab ? 'var(--brand)' : '#6B6860',
                  borderBottom: activeTab===tab ? '2px solid var(--brand)' : '2px solid transparent',
                  marginBottom:-1, fontFamily:'inherit', whiteSpace:'nowrap',
                }}
              >{tab}</button>
            ))}
          </div>
        </div>

        {/* ── TAB CONTENT ── */}
        <div style={{ marginBottom:40 }}>

          {/* ── EARNINGS TAB ── (real-time commission/pay for the period) */}
          {activeTab === 'Earnings' && (
            <EarningsPanel userId={userId} />
          )}

          {/* ── PAY TAB ── published pay snapshots: current week + full history */}
          {activeTab === 'Pay' && (() => {
            const weeks: any[] = payData?.weeks ?? [];
            const money = (n: any) => `$${Number(n || 0).toFixed(2)}`;
            const fmtRange = (s: string, e: string) => {
              const d = (x: string) => { const [y, m, day] = x.split('-'); return `${parseInt(m)}/${parseInt(day)}`; };
              return `${d(s)} – ${d(e)}, ${s.slice(0, 4)}`;
            };
            return (
              <div>
                <SectionCard title="Published Pay">
                  {weeks.length === 0 ? (
                    <div style={{ padding:'24px', color:'#6B6860', fontSize:'14px' }}>No published pay yet. Once the office publishes a pay period, your weekly pay and history appear here.</div>
                  ) : (
                    <div style={{ display:'flex', flexDirection:'column', gap:'10px' }}>
                      {weeks.map((w: any) => {
                        const key = `${w.pay_period_start}_${w.pay_period_end}`;
                        const open = expandedPayWeek === key;
                        const jobs: any[] = Array.isArray(w.breakdown) ? w.breakdown : [];
                        return (
                          <div key={key} style={{ border:'1px solid #E5E2DC', borderRadius:'10px', overflow:'hidden', background:'#FFFFFF' }}>
                            <button onClick={() => setExpandedPayWeek(open ? null : key)}
                              style={{ width:'100%', display:'flex', justifyContent:'space-between', alignItems:'center', padding:'14px 16px', background:'none', border:'none', cursor:'pointer', textAlign:'left' }}>
                              <div>
                                <div style={{ fontWeight:700, color:'#1A1917', fontSize:'15px' }}>{fmtRange(w.pay_period_start, w.pay_period_end)}</div>
                                <div style={{ fontSize:'12px', color:'#9DA3B0', marginTop:'2px' }}>{Number(w.hours).toFixed(2)} hrs · published {String(w.published_at).slice(0, 10)}</div>
                              </div>
                              <div style={{ fontWeight:800, color:'#00C9A0', fontSize:'18px' }}>{money(w.gross)}</div>
                            </button>
                            {open && (
                              <div style={{ borderTop:'1px solid #E5E2DC', padding:'14px 16px', background:'#F7F6F3' }}>
                                <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:'8px 24px', fontSize:'13px', marginBottom:'14px' }}>
                                  {[['Base pay (jobs)', w.base], ['Tips', w.tips], ['Overtime', w.overtime], ['Bonus', w.bonus], ['Adjustments', w.adjustments], ['Gross', w.gross]].map(([lbl, val]: any, i: number) => (
                                    <div key={i} style={{ display:'flex', justifyContent:'space-between', borderBottom:'1px solid #E5E2DC', paddingBottom:'4px' }}>
                                      <span style={{ color:'#6B6860' }}>{lbl}</span>
                                      <span style={{ fontWeight: lbl === 'Gross' ? 800 : 600, color: lbl === 'Gross' ? '#00C9A0' : '#1A1917' }}>{money(val)}</span>
                                    </div>
                                  ))}
                                </div>
                                {jobs.length > 0 && (
                                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'12px' }}>
                                    <thead><tr style={{ textAlign:'left', color:'#9DA3B0' }}>
                                      <th style={{ padding:'4px 0' }}>Date</th><th>Job</th><th>Basis</th>
                                      <th style={{ textAlign:'right' }}>Hrs</th><th style={{ textAlign:'right' }}>Pay</th>
                                    </tr></thead>
                                    <tbody>
                                      {jobs.map((j: any, i: number) => (
                                        <tr key={i} style={{ borderTop:'1px solid #E5E2DC' }}>
                                          <td style={{ padding:'5px 0' }}>{String(j.date).slice(5)}</td>
                                          <td>{j.client}</td>
                                          <td style={{ color:'#6B6860' }}>{j.basis}</td>
                                          <td style={{ textAlign:'right' }}>{Number(j.hours).toFixed(2)}</td>
                                          <td style={{ textAlign:'right', fontWeight:600 }}>{money(j.amount)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </SectionCard>
              </div>
            );
          })()}

          {/* ── INFORMATION TAB ── */}
          {activeTab === 'Information' && (
            <div>
              <SectionCard title="Employee Info">
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'16px' }}>
                  <Field label="First Name"><Input value={form.first_name || ''} onChange={v => setField('first_name',v)}/></Field>
                  <Field label="Last Name"><Input value={form.last_name || ''} onChange={v => setField('last_name',v)}/></Field>
                  <Field label="Date of Birth"><CalendarPopover value={form.dob || ''} ariaLabel="Date of Birth" onChange={v => setField('dob',v)} block /></Field>
                  <Field label="Gender">
                    <Select value={form.gender||''} onChange={v=>setField('gender',v)} options={[
                      {value:'',label:'Select…'},{value:'male',label:'Male'},{value:'female',label:'Female'},{value:'non_binary',label:'Non-Binary'},{value:'prefer_not',label:'Prefer not to say'}
                    ]}/>
                  </Field>
                  <Field label="Employment Type">
                    <Select value={form.employment_type||''} onChange={v=>setField('employment_type',v)} options={[
                      {value:'',label:'Select…'},{value:'full_time',label:'Full Time'},{value:'part_time',label:'Part Time'},{value:'contractor',label:'Contractor'}
                    ]}/>
                  </Field>
                  <Field label="Personal Email"><Input value={form.personal_email || ''} onChange={v => setField('personal_email',v)}/></Field>
                  <Field label="Personal Phone"><Input value={form.phone || ''} onChange={v => setField('phone',v)}/></Field>
                  <Field label="Emergency Contact Name"><Input value={form.emergency_contact_name || ''} onChange={v => setField('emergency_contact_name',v)}/></Field>
                  <Field label="Emergency Contact Phone"><Input value={form.emergency_contact_phone || ''} onChange={v => setField('emergency_contact_phone',v)}/></Field>
                  <Field label="Emergency Relationship"><Input value={form.emergency_contact_relation || ''} onChange={v => setField('emergency_contact_relation',v)}/></Field>
                  <Field label="SSN Last 4"><Input value={form.ssn_last4 || ''} onChange={v => setField('ssn_last4',v)} type="password"/></Field>
                  <Field label="Hire Date"><CalendarPopover value={form.hire_date || ''} ariaLabel="Hire Date" onChange={v => setField('hire_date',v)} block /></Field>
                  {/* [terminate 2026-07-01] Read-only — termination is set via the
                      Terminate button (reason + dates + roster removal), not a bare
                      date field that silently did nothing on Save. */}
                  <Field label="Termination">
                    {user.termination_date
                      ? <div style={{ fontSize:13, color:'#1A1917', padding:'9px 0' }}>
                          {new Date(user.termination_date + 'T00:00:00').toLocaleDateString()} · {reasonLabel(user.termination_reason)}
                          {user.last_day_worked ? ` · last day ${new Date(user.last_day_worked + 'T00:00:00').toLocaleDateString()}` : ''}
                        </div>
                      : <div style={{ fontSize:13, color:'#9E9B94', padding:'9px 0' }}>Active — use the Terminate button to record a separation</div>}
                  </Field>
                </div>
                <div style={{ marginTop:16 }}>
                  <Field label="Internal Notes">
                    <textarea value={form.notes||''} onChange={e=>setField('notes',e.target.value)}
                      style={{ width:'100%',height:80,padding:'10px 12px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,color:'#1A1917',resize:'vertical',outline:'none',fontFamily:'inherit' }}/>
                  </Field>
                </div>
              </SectionCard>

              <SectionCard title="Address">
                <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr 1fr', gap:16 }}>
                  <Field label="Street"><Input value={form.address||''} onChange={v=>setField('address',v)}/></Field>
                  <Field label="City"><Input value={form.city||''} onChange={v=>setField('city',v)}/></Field>
                  <Field label="State"><Input value={form.state||''} onChange={v=>setField('state',v)}/></Field>
                  <Field label="Zip"><Input value={form.zip||''} onChange={v=>setField('zip',v)}/></Field>
                </div>
                {(form.address && form.city) && (
                  <div style={{ marginTop:12, borderRadius:8, overflow:'hidden', height:120 }}>
                    <iframe
                      title="map"
                      width="100%" height="120"
                      style={{ border:0 }}
                      loading="lazy"
                      src={`https://maps.google.com/maps?q=${encodeURIComponent(`${form.address}, ${form.city}, ${form.state} ${form.zip}`)}&z=15&output=embed`}
                    />
                  </div>
                )}
              </SectionCard>

              <SectionCard title="Pay & Tax Info">
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16 }}>
                  <Field label="Pay Type">
                    <Select value={form.pay_type||''} onChange={v=>setField('pay_type',v)} options={[
                      {value:'',label:'Select…'},{value:'hourly',label:'Hourly'},{value:'per_job',label:'Per Job'},{value:'fee_split',label:'Fee Split'}
                    ]}/>
                  </Field>
                  <Field label="Pay Rate ($)"><Input type="number" value={form.pay_rate||''} onChange={v=>setField('pay_rate',v)}/></Field>
                  <Field label="W2 / 1099">
                    <Select value={form.w2_1099||''} onChange={v=>setField('w2_1099',v)} options={[
                      {value:'',label:'Select…'},{value:'w2',label:'W2'},{value:'1099',label:'1099'}
                    ]}/>
                  </Field>
                  <Field label="Bank Name"><Input value={form.bank_name||''} onChange={v=>setField('bank_name',v)}/></Field>
                  <Field label="Account Last 4"><Input value={form.bank_account_last4||''} onChange={v=>setField('bank_account_last4',v)}/></Field>
                </div>
                <div style={{ marginTop:16, display:'flex', gap:16, flexWrap:'wrap' }}>
                  <Toggle value={!!form.overtime_eligible} onChange={v=>setField('overtime_eligible',v)} label="Overtime Eligible"/>
                </div>
              </SectionCard>

              {zones.length > 0 && (
                <SectionCard title="Service Zone">
                  <p style={{ margin: '0 0 10px', fontSize: 12, color: '#6B7280' }}>
                    Assign this employee to a service zone. Controls their territory on the dispatch board.
                  </p>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button onClick={() => assignZone(null)} disabled={zoneAssigning}
                      style={{ fontSize: 11, fontWeight: 700, padding: '5px 12px', borderRadius: 20, border: !user?.primary_zone ? '1.5px solid var(--brand)' : '1.5px solid #E5E2DC', backgroundColor: !user?.primary_zone ? 'var(--brand-dim)' : '#FAFAF9', color: !user?.primary_zone ? 'var(--brand)' : '#6B7280', cursor: 'pointer' }}>
                      No Zone
                    </button>
                    {zones.map((z: { id: number; name: string; color: string }) => (
                      <button key={z.id} onClick={() => assignZone(z.id)} disabled={zoneAssigning}
                        style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, padding: '5px 12px', borderRadius: 20, border: `1.5px solid ${user?.primary_zone?.zone_id === z.id ? z.color : '#E5E2DC'}`, backgroundColor: user?.primary_zone?.zone_id === z.id ? `${z.color}22` : '#FAFAF9', color: user?.primary_zone?.zone_id === z.id ? z.color : '#6B7280', cursor: 'pointer' }}>
                        <div style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: z.color }} />
                        {z.name}
                      </button>
                    ))}
                  </div>
                </SectionCard>
              )}

              <div style={{ display:'flex', justifyContent:'flex-end' }}>
                <button onClick={saveProfile} disabled={saving}
                  style={{ display:'flex',alignItems:'center',gap:8,padding:'10px 20px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>
                  <Save size={14}/>{saving ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </div>
          )}

          {/* [mc-cleanup 2026-06-17] Tags & Skills tab removed — leftover from
              MaidCentral, not used by Phes. */}

          {/* ── ATTENDANCE TAB ── */}
          {activeTab === 'Attendance' && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 300px', gap:20, alignItems:'start' }}>
              <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, padding:'20px 24px' }}>
                <AttendanceCalendar userId={userId}/>
              </div>

              <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
                {/* [Phase 4] Discipline flags — OFFICE/OWNER ONLY (never the
                    employee's own self-view). Sourced from employee_discipline_log
                    (the unexcused-ladder output). */}
                {['owner','admin','office','super_admin'].includes(getTokenRole() || '')
                  && Array.isArray(attnSummary?.discipline) && attnSummary.discipline.length > 0 && (
                  <div style={{ background:'#FFFFFF', border:'1px solid #E24B4A', borderLeft:'4px solid #E24B4A', borderRadius:10, padding:'12px 16px' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:7, marginBottom:8 }}>
                      <AlertCircle size={15} color="#E24B4A" />
                      <span style={{ fontSize:12, fontWeight:700, color:'#E24B4A', textTransform:'uppercase', letterSpacing:'0.04em' }}>Discipline on file</span>
                      <span style={{ marginLeft:'auto', fontSize:10.5, color:'#9E9B94' }}>office only</span>
                    </div>
                    {attnSummary.discipline.map((d: any, i: number) => (
                      <div key={i} style={{ padding:'6px 0', borderTop: i ? '1px solid #F3F4F6' : 'none' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                          <span style={{ fontSize:11, fontWeight:700, color:'#FFFFFF', background:'#E24B4A', borderRadius:99, padding:'1px 8px' }}>{d.label}</span>
                          <span style={{ fontSize:11, color:'#6B6860' }}>{shortDate(String(d.effective_date))}</span>
                          {d.pending_review && <span style={{ fontSize:10, fontWeight:600, color:'#92400E', background:'#FEF3C7', borderRadius:99, padding:'1px 7px' }}>pending review</span>}
                        </div>
                        {d.reason && <div style={{ fontSize:11.5, color:'#6B6860', marginTop:2 }}>{d.reason}</div>}
                      </div>
                    ))}
                  </div>
                )}
                {leaveBuckets.length === 0 && (
                  <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, padding:'14px 16px', fontSize:13, color:'#9E9B94' }}>
                    No leave buckets configured.
                  </div>
                )}
                {leaveBuckets.map((b: any) => {
                  const accent = b.accent || NEUTRAL_ACCENT;
                  const officeRecorded = b.accrual_mode === 'office_recorded';
                  const notVested = !officeRecorded && !b.past_waiting_period;
                  const granted = Number(b.granted || 0);
                  const used = Number(b.used || 0);
                  const avail = Number(b.available || 0);
                  const unex = officeRecorded ? (attnSummary?.unexcused || null) : null;

                  // Big number + usage bar geometry + smart color.
                  let bigNum = avail.toFixed(1);
                  let bigLabel = 'hours available';
                  let barPct = 0;
                  let barColor = accent;
                  let barCaption = '';
                  if (officeRecorded) {
                    // Occurrence-based disciplinary ladder (PHES): count incidents
                    // this benefit year toward the next step.
                    const occ = Number(unex?.occurrences || 0);
                    const nextOcc = Number(unex?.next_step?.occurrence || 0);
                    const nextLabel = (unex?.next_step?.label || 'discipline').toLowerCase();
                    bigNum = String(occ);
                    bigLabel = occ === 1 ? 'occurrence this year' : 'occurrences this year';
                    if (nextOcc > 0) {
                      barPct = Math.min(100, (occ / nextOcc) * 100);
                      barColor = occ >= nextOcc ? LEAVE_OUT : (nextOcc - occ <= 1 ? LEAVE_LOW : accent);
                      barCaption = `${occ} of ${nextOcc} occurrences to ${nextLabel}`;
                    } else {
                      barCaption = unex?.current_discipline ? 'At the final disciplinary step' : 'No disciplinary ladder set';
                    }
                  } else {
                    barPct = granted > 0 ? Math.min(100, (used / granted) * 100) : 0;
                    barColor = avail <= 0 ? LEAVE_OUT : (granted > 0 && avail <= 0.2 * granted) ? LEAVE_LOW : accent;
                    barCaption = `${used.toFixed(1)} used · ${avail.toFixed(1)} left · of ${granted.toFixed(1)} granted`;
                  }
                  const resetDays = !officeRecorded && b.next_reset_date ? daysUntilYmd(b.next_reset_date) : null;
                  const eligDays = b.eligible_on ? daysUntilYmd(b.eligible_on) : null;

                  return (
                    <div key={b.leave_type_id} style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderLeft:`4px solid ${accent}`, borderRadius:10, padding:'14px 16px' }}>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:7, minWidth:0 }}>
                          <span style={{ width:9, height:9, borderRadius:'50%', background:accent, flexShrink:0 }} />
                          <span style={{ fontSize:12, fontWeight:700, color:accent, textTransform:'uppercase', letterSpacing:'0.04em' }}>{b.display_name}</span>
                        </div>
                        {resetDays != null && resetDays >= 0 && !notVested && (
                          <span style={{ fontSize:10.5, color:'#9E9B94', whiteSpace:'nowrap' }}>resets in {resetDays}d · {shortDate(b.next_reset_date)}</span>
                        )}
                      </div>

                      {notVested ? (
                        <div style={{ marginTop:8 }}>
                          <p style={{ fontSize:14, fontWeight:700, color:accent, margin:0 }}>
                            {eligDays != null && eligDays > 0 ? `Unlocks in ${eligDays} day${eligDays === 1 ? '' : 's'}` : 'Eligible after waiting period'}
                          </p>
                          {b.eligible_on && eligDays != null && eligDays > 0 && (
                            <p style={{ fontSize:11, color:'#9E9B94', margin:'2px 0 0 0' }}>{b.display_name} available {shortDate(b.eligible_on)}</p>
                          )}
                        </div>
                      ) : (
                        <>
                          <div style={{ display:'flex', alignItems:'baseline', gap:6, marginTop:6 }}>
                            <span style={{ fontSize:30, fontWeight:800, color:accent, lineHeight:1.1 }}>{bigNum}</span>
                            <span style={{ fontSize:12, color:'#6B6860' }}>{bigLabel}</span>
                            {officeRecorded && unex?.current_discipline && (
                              <span style={{ marginLeft:'auto', fontSize:10.5, fontWeight:700, color:'#FFFFFF', background:LEAVE_OUT, borderRadius:99, padding:'2px 8px', whiteSpace:'nowrap' }}>{unex.current_discipline.label}</span>
                            )}
                          </div>
                          {/* usage / progress bar */}
                          <div style={{ height:6, borderRadius:99, background:'#EEEDEA', marginTop:8, overflow:'hidden' }}>
                            <div style={{ height:'100%', width:`${barPct}%`, background:barColor, borderRadius:99, transition:'width 0.3s ease' }} />
                          </div>
                          <p style={{ fontSize:11, color:'#6B6860', margin:'5px 0 0 0' }}>{barCaption}</p>
                          {!officeRecorded && (
                            <p style={{ fontSize:11, color:'#9E9B94', margin:'2px 0 0 0' }}>{used.toFixed(1)} hrs taken this year</p>
                          )}
                        </>
                      )}

                      <div style={{ display:'flex', gap:8, marginTop:10 }}>
                        <button onClick={() => setHistoryBucket({ slug:b.slug, display_name:b.display_name, leave_type_id:b.leave_type_id })} style={{ flex:1,padding:'6px 0',border:`1px solid ${accent}`,borderRadius:6,fontSize:12,color:accent,background:'none',cursor:'pointer',fontFamily:'inherit' }}>View History</button>
                        <button onClick={officeRecorded ? () => openRecord('absent', accent) : (canEditBalance ? () => openBalanceEdit(b) : undefined)} style={{ flex:1,padding:'6px 0',background:accent,border:'none',borderRadius:6,fontSize:12,color:'#FFFFFF',cursor: (officeRecorded || canEditBalance) ? 'pointer':'default',opacity: (officeRecorded || canEditBalance) ? 1 : 0.5,fontFamily:'inherit' }}>{officeRecorded ? 'Record' : 'Update'}</button>
                      </div>
                    </div>
                  );
                })}

                {/* [Occurrence ladder] Tardy/Late disciplinary indicator —
                    office/owner only (tardies aren't a leave bucket). */}
                {['owner','admin','office','super_admin'].includes(getTokenRole() || '')
                  && attnSummary?.tardy && (() => {
                  const t = attnSummary.tardy;
                  const occ = Number(t.occurrences || 0);
                  const nextOcc = Number(t.next_step?.occurrence || 0);
                  const nextLabel = (t.next_step?.label || 'discipline').toLowerCase();
                  const accent = '#BA7517'; // tardy = amber accent
                  const barPct = nextOcc > 0 ? Math.min(100, (occ / nextOcc) * 100) : (occ > 0 ? 100 : 0);
                  const barColor = nextOcc > 0 ? (occ >= nextOcc ? LEAVE_OUT : (nextOcc - occ <= 1 ? LEAVE_OUT : accent)) : LEAVE_OUT;
                  const caption = nextOcc > 0 ? `${occ} of ${nextOcc} occurrences to ${nextLabel}` : (occ > 0 ? 'At the final disciplinary step' : 'No disciplinary ladder set');
                  return (
                    <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderLeft:`4px solid ${accent}`, borderRadius:10, padding:'14px 16px' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                        <span style={{ width:9, height:9, borderRadius:'50%', background:accent, flexShrink:0 }} />
                        <span style={{ fontSize:12, fontWeight:700, color:accent, textTransform:'uppercase', letterSpacing:'0.04em' }}>Tardies</span>
                        <span style={{ marginLeft:'auto', fontSize:10.5, color:'#9E9B94' }}>office only</span>
                      </div>
                      <div style={{ display:'flex', alignItems:'baseline', gap:6, marginTop:6 }}>
                        <span style={{ fontSize:30, fontWeight:800, color:accent, lineHeight:1.1 }}>{occ}</span>
                        <span style={{ fontSize:12, color:'#6B6860' }}>{occ === 1 ? 'late this year' : 'lates this year'}</span>
                      </div>
                      <div style={{ height:6, borderRadius:99, background:'#EEEDEA', marginTop:8, overflow:'hidden' }}>
                        <div style={{ height:'100%', width:`${barPct}%`, background:barColor, borderRadius:99, transition:'width 0.3s ease' }} />
                      </div>
                      <p style={{ fontSize:11, color:'#6B6860', margin:'5px 0 0 0' }}>{caption}</p>
                      <div style={{ display:'flex', gap:8, marginTop:10 }}>
                        <button onClick={() => setStatDrill({ label:'Tardies', days: attnSummary?.tiles?.late?.days || [] })} style={{ flex:1,padding:'6px 0',border:`1px solid ${accent}`,borderRadius:6,fontSize:12,color:accent,background:'none',cursor:'pointer',fontFamily:'inherit' }}>View History</button>
                        <button onClick={() => openRecord('tardy', accent)} style={{ flex:1,padding:'6px 0',background:accent,border:'none',borderRadius:6,fontSize:12,color:'#FFFFFF',cursor:'pointer',fontFamily:'inherit' }}>Record</button>
                      </div>
                    </div>
                  );
                })()}

                {/* [attendance-record] Record an unexcused absence / tardy with a reason. */}
                {recordModal && (
                  <div onClick={() => !recBusy && setRecordModal(null)} style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000 }}>
                    <div onClick={e => e.stopPropagation()} style={{ background:'#FFFFFF',borderRadius:14,padding:'22px 22px 20px',width:380,maxWidth:'92vw',fontFamily:"'Plus Jakarta Sans',sans-serif",boxShadow:'0 12px 40px rgba(0,0,0,0.18)' }}>
                      <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14 }}>
                        <span style={{ fontSize:16,fontWeight:800,color:'#1A1917' }}>{recordModal.title}</span>
                        <button onClick={() => !recBusy && setRecordModal(null)} style={{ border:'none',background:'none',fontSize:22,lineHeight:1,cursor:'pointer',color:'#9E9B94' }}>×</button>
                      </div>
                      <label style={{ display:'block',fontSize:11.5,fontWeight:700,color:'#6B6860',marginBottom:4 }}>Date</label>
                      <input type="date" value={recDate} onChange={e => setRecDate(e.target.value)} style={{ width:'100%',padding:'9px 10px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,fontFamily:'inherit',marginBottom:12,boxSizing:'border-box' }} />
                      <label style={{ display:'block',fontSize:11.5,fontWeight:700,color:'#6B6860',marginBottom:4 }}>{recordModal.type === 'tardy' ? 'Hours late' : 'Hours missed'}</label>
                      <input type="number" min="0" step="0.25" value={recHours} onChange={e => setRecHours(e.target.value)} placeholder="e.g. 8" style={{ width:'100%',padding:'9px 10px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,fontFamily:'inherit',marginBottom:12,boxSizing:'border-box' }} />
                      <label style={{ display:'block',fontSize:11.5,fontWeight:700,color:'#6B6860',marginBottom:4 }}>Reason <span style={{ fontWeight:500,color:'#9E9B94' }}>(optional)</span></label>
                      <textarea value={recReason} onChange={e => setRecReason(e.target.value)} placeholder="e.g. no-show, didn't call" rows={2} style={{ width:'100%',padding:'9px 10px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,fontFamily:'inherit',marginBottom:12,boxSizing:'border-box',resize:'vertical' }} />
                      {recErr && <p style={{ fontSize:12,color:'#991B1B',margin:'0 0 10px' }}>{recErr}</p>}
                      <div style={{ display:'flex',gap:8 }}>
                        <button onClick={() => !recBusy && setRecordModal(null)} disabled={recBusy} style={{ flex:1,padding:'9px 0',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,fontWeight:600,color:'#6B6860',background:'none',cursor:'pointer',fontFamily:'inherit' }}>Cancel</button>
                        <button onClick={submitRecord} disabled={recBusy} style={{ flex:1,padding:'9px 0',border:'none',borderRadius:8,fontSize:13,fontWeight:700,color:'#FFFFFF',background:recordModal.accent,cursor:'pointer',fontFamily:'inherit',opacity:recBusy?0.6:1 }}>{recBusy ? 'Saving…' : 'Record'}</button>
                      </div>
                    </div>
                  </div>
                )}

                {/* [mc-migration] Set a bucket's granted/used balance (owner/admin).
                    Persists via PUT /leave/balances — the same manual-set endpoint
                    the Leave Review "Balances & Grants" section uses (#923). */}
                {balModal && (() => {
                  const g = Number(balGranted);
                  const u = Number(balUsed);
                  const preview = Number.isFinite(g) && Number.isFinite(u) ? Math.max(0, g - u) : null;
                  return (
                    <div onClick={() => !balBusy && setBalModal(null)} style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000 }}>
                      <div onClick={e => e.stopPropagation()} style={{ background:'#FFFFFF',borderRadius:14,padding:'22px 22px 20px',width:380,maxWidth:'92vw',fontFamily:"'Plus Jakarta Sans',sans-serif",boxShadow:'0 12px 40px rgba(0,0,0,0.18)' }}>
                        <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14 }}>
                          <span style={{ fontSize:16,fontWeight:800,color:'#1A1917' }}>Update {balModal.display_name}</span>
                          <button onClick={() => !balBusy && setBalModal(null)} style={{ border:'none',background:'none',fontSize:22,lineHeight:1,cursor:'pointer',color:'#9E9B94' }}>×</button>
                        </div>
                        <label style={{ display:'block',fontSize:11.5,fontWeight:700,color:'#6B6860',marginBottom:4 }}>Granted hours</label>
                        <input type="number" min="0" step="0.25" value={balGranted} onChange={e => setBalGranted(e.target.value)} style={{ width:'100%',padding:'9px 10px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,fontFamily:'inherit',marginBottom:12,boxSizing:'border-box' }} />
                        <label style={{ display:'block',fontSize:11.5,fontWeight:700,color:'#6B6860',marginBottom:4 }}>Used hours</label>
                        <input type="number" min="0" step="0.25" value={balUsed} onChange={e => setBalUsed(e.target.value)} style={{ width:'100%',padding:'9px 10px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,fontFamily:'inherit',marginBottom:12,boxSizing:'border-box' }} />
                        <p style={{ fontSize:12,color:'#6B6860',margin:'0 0 12px' }}>
                          {preview != null ? <>Available after save: <strong style={{ color: balModal.accent }}>{preview.toFixed(1)} hrs</strong></> : 'Enter granted and used hours'}
                        </p>
                        {balErr && <p style={{ fontSize:12,color:'#991B1B',margin:'0 0 10px' }}>{balErr}</p>}
                        <div style={{ display:'flex',gap:8 }}>
                          <button onClick={() => !balBusy && setBalModal(null)} disabled={balBusy} style={{ flex:1,padding:'9px 0',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,fontWeight:600,color:'#6B6860',background:'none',cursor:'pointer',fontFamily:'inherit' }}>Cancel</button>
                          <button onClick={submitBalanceEdit} disabled={balBusy} style={{ flex:1,padding:'9px 0',border:'none',borderRadius:8,fontSize:13,fontWeight:700,color:'#FFFFFF',background:balModal.accent,cursor:'pointer',fontFamily:'inherit',opacity:balBusy?0.6:1 }}>{balBusy ? 'Saving…' : 'Save'}</button>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Per-bucket usage history modal (data-driven over all buckets) */}
                {historyBucket && (() => {
                  const tag = leaveBucketTag(historyBucket.slug);
                  const rows = leaveUsage
                    .filter((u: any) => String(u.notes || '').includes(tag))
                    .sort((a: any, b: any) => String(b.date_used).localeCompare(String(a.date_used)));
                  return (
                    <div onClick={() => setHistoryBucket(null)} style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000 }}>
                      <div onClick={e => e.stopPropagation()} style={{ background:'#FFFFFF',borderRadius:12,padding:24,width:560,maxWidth:'92vw',maxHeight:'80vh',overflowY:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}>
                        <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16 }}>
                          <h3 style={{ margin:0,fontSize:16,fontWeight:700,color:'#1A1917' }}>{historyBucket.display_name} History</h3>
                          <button onClick={() => setHistoryBucket(null)} style={{ border:'none',background:'none',fontSize:22,lineHeight:1,cursor:'pointer',color:'#9E9B94' }}>×</button>
                        </div>
                        {rows.length === 0 ? (
                          <p style={{ color:'#9E9B94',fontSize:13,margin:0 }}>No {historyBucket.display_name} history recorded.</p>
                        ) : rows.map((u: any, i: number) => (
                          <div key={u.id ?? i} style={{ display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,padding:'10px 0',borderTop: i ? '1px solid #E5E2DC' : 'none' }}>
                            <div style={{ minWidth:0 }}>
                              <div style={{ fontSize:13,fontWeight:600,color:'#1A1917',marginBottom:3 }}>{shortDate(String(u.date_used).slice(0,10))} · {String(u.date_used).slice(0,10)}</div>
                              <NoteChips note={u.notes} bucketMap={bucketDisplayMap} />
                            </div>
                            <div style={{ display:'flex',alignItems:'center',gap:10,whiteSpace:'nowrap' }}>
                              <span style={{ fontSize:14,fontWeight:700,color:'#1A1917' }}>{Number(u.hours).toFixed(2)} h</span>
                              {canEditBalance && u.id != null && (
                                <button
                                  onClick={() => deleteEntry('usage', u.id)}
                                  disabled={entryDelBusy === `usage:${u.id}`}
                                  title="Remove this entry — the hours go back to the bucket"
                                  style={{ border:'1px solid #E5E2DC',background:'none',borderRadius:6,padding:'3px 9px',fontSize:11.5,fontWeight:600,color:'#991B1B',cursor:'pointer',fontFamily:'inherit',opacity: entryDelBusy === `usage:${u.id}` ? 0.5 : 1 }}
                                >Remove</button>
                              )}
                            </div>
                          </div>
                        ))}

                        {/* [leave-log] Provenance — every change to this bucket's
                            granted/used with who or what made it. */}
                        {(() => {
                          const logRows = balanceLog.filter((r: any) =>
                            (historyBucket.leave_type_id != null && r.leave_type_id === historyBucket.leave_type_id) ||
                            (r.slug && r.slug === historyBucket.slug));
                          if (!logRows.length) return null;
                          const fmtAt = (at: string) => {
                            const d = new Date(at);
                            return d.toLocaleDateString('en-US', { month:'short', day:'numeric' }) + ', ' +
                                   d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
                          };
                          const fmtPair = (g: number | null, u2: number | null) =>
                            `${g != null ? g.toFixed(1) : '—'} granted / ${u2 != null ? u2.toFixed(1) : '—'} used`;
                          const empName = `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || 'Employee';
                          const dayUnitLabel: Record<string, string> = { full_day: 'full day', morning: 'morning', afternoon: 'afternoon', custom: 'custom hours' };
                          // Headline: WHAT happened. For request-driven rows the
                          // full designation chain — the employee requested, the
                          // approver signed off, the hours moved — reads on one card.
                          const headline = (r: any) => {
                            const hrs = r.hours_delta != null ? Math.abs(r.hours_delta).toFixed(1) : null;
                            if (r.source === 'request_approved') return `Request approved — ${hrs ?? '?'} hrs deducted`;
                            if (r.source === 'request_cancelled') return `Approved request cancelled — ${hrs ?? '?'} hrs restored`;
                            if (r.source === 'usage_entry_deleted') return 'Usage entry removed — hours restored';
                            if (r.source === 'office_set') return 'Balance set manually';
                            if (r.engine_action === 'initial_grant') return 'Automatic grant (eligibility reached)';
                            if (r.engine_action === 'annual_reset') return 'Automatic benefit-year reset';
                            if (r.engine_action === 'tier_topup') return 'Automatic tenure top-up';
                            // Rows logged before the source field existed —
                            // fall back to the audit action.
                            if (r.action === 'leave_balance_set') return 'Balance set manually';
                            if (r.action === 'leave_request_approved') return 'Request approved';
                            if (r.action === 'leave_request_cancelled') return 'Approved request cancelled';
                            return 'Balance changed';
                          };
                          const chain = (r: any) => {
                            if (r.source === 'request_approved') return `${empName} requested · approved by ${r.actor}`;
                            if (r.source === 'request_cancelled') return `cancelled by ${r.actor}`;
                            return `by ${r.actor}`;
                          };
                          return (
                            <div style={{ marginTop:20 }}>
                              <h4 style={{ margin:'0 0 4px',fontSize:13,fontWeight:700,color:'#1A1917' }}>Balance changes</h4>
                              <p style={{ margin:'0 0 8px',fontSize:11.5,color:'#9E9B94' }}>The full audit trail for this bucket — requests and approvals, office edits, automatic grants.</p>
                              {logRows.map((r: any, i: number) => (
                                <div key={i} style={{ padding:'8px 0',borderTop: i ? '1px solid #F0EEE9' : '1px solid #E5E2DC' }}>
                                  <div style={{ display:'flex',justifyContent:'space-between',gap:10,fontSize:12 }}>
                                    <span style={{ fontWeight:700,color:'#1A1917' }}>{headline(r)}</span>
                                    <span style={{ color:'#9E9B94',whiteSpace:'nowrap' }}>{fmtAt(r.at)}</span>
                                  </div>
                                  <div style={{ fontSize:12,color:'#6B6860',marginTop:2 }}>
                                    {chain(r)}
                                    {r.start_date && (
                                      <span style={{ color:'#9E9B94' }}>
                                        {' '}· {shortDate(String(r.start_date))}{r.end_date && r.end_date !== r.start_date ? ` – ${shortDate(String(r.end_date))}` : ''}{r.day_unit ? ` (${dayUnitLabel[r.day_unit] ?? r.day_unit})` : ''}
                                      </span>
                                    )}
                                  </div>
                                  <div style={{ fontSize:12,color:'#6B6860',marginTop:2 }}>
                                    {fmtPair(r.granted_new, r.used_new)}
                                    {(r.granted_old != null || r.used_old != null) && (
                                      <span style={{ color:'#9E9B94' }}> (was {fmtPair(r.granted_old, r.used_old)})</span>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })()}

                <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, padding:'14px 16px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                    <p style={{ fontSize:13,fontWeight:700,color:'#1A1917',margin:0 }}>Attendance — Last 180 Days</p>
                  </div>
                  {(() => {
                    const t = attnSummary?.tiles;
                    const rows: Array<{ label:string; value:any; days?:any[] }> = [
                      { label:'Scheduled', value: user.total_jobs || 0 },
                      { label:'Late', value: t?.late?.count ?? 0, days: t?.late?.days },
                      { label:'Absent', value: t?.absent?.count ?? 0, days: t?.absent?.days },
                      { label:'Unexcused', value: t?.unexcused?.count ?? 0, days: t?.unexcused?.days },
                      { label:'Time Off', value: t?.time_off?.count ?? 0, days: t?.time_off?.days },
                      { label:'Paid Time Off', value: t?.pto?.count ?? 0, days: t?.pto?.days },
                      { label:'Sick', value: t?.sick?.count ?? 0, days: t?.sick?.days },
                      { label:'Score', value: scorePct != null ? `${scorePct.toFixed(0)}%` : '—' },
                    ];
                    return rows.map(row => {
                      const clickable = Array.isArray(row.days);
                      const hasRows = clickable && (row.days as any[]).length > 0;
                      return (
                        <div key={row.label}
                          onClick={hasRows ? () => setStatDrill({ label: row.label, days: row.days as any[] }) : undefined}
                          style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'6px 0', borderBottom:'1px solid #F3F4F6', cursor: hasRows ? 'pointer' : 'default' }}>
                          <span style={{ fontSize:12, color: hasRows ? 'var(--brand)' : '#6B7280' }}>{row.label}</span>
                          <span style={{ fontSize:12, fontWeight:600, color:'#1A1917' }}>{row.value}{hasRows ? ' ›' : ''}</span>
                        </div>
                      );
                    });
                  })()}
                  {!attnSummary && (
                    <p style={{ fontSize:11, color:'#9E9B94', margin:'8px 0 0 0' }}>Loading…</p>
                  )}
                </div>

                {/* [Phase 2] Stat-tile day-level drill-down (date + reason) */}
                {statDrill && (
                  <div onClick={() => setStatDrill(null)} style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000 }}>
                    <div onClick={e => e.stopPropagation()} style={{ background:'#FFFFFF',borderRadius:12,padding:24,width:560,maxWidth:'92vw',maxHeight:'80vh',overflowY:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}>
                      <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16 }}>
                        <h3 style={{ margin:0,fontSize:16,fontWeight:700,color:'#1A1917' }}>{statDrill.label} — last 180 days</h3>
                        <button onClick={() => setStatDrill(null)} style={{ border:'none',background:'none',fontSize:22,lineHeight:1,cursor:'pointer',color:'#9E9B94' }}>×</button>
                      </div>
                      {statDrill.days.length === 0 ? (
                        <p style={{ color:'#9E9B94',fontSize:13,margin:0 }}>No {statDrill.label.toLowerCase()} days recorded.</p>
                      ) : statDrill.days.map((d: any, i: number) => (
                        <div key={i} style={{ display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,padding:'10px 0',borderTop: i ? '1px solid #E5E2DC' : 'none' }}>
                          <div style={{ minWidth:0 }}>
                            <div style={{ fontSize:13,fontWeight:600,color:'#1A1917',marginBottom:3 }}>{shortDate(String(d.date))} · {String(d.date)}</div>
                            <NoteChips note={d.reason} bucketMap={bucketDisplayMap} />
                          </div>
                          <div style={{ display:'flex',alignItems:'center',gap:10,whiteSpace:'nowrap' }}>
                            {d.hours != null && <span style={{ fontSize:14,fontWeight:700,color:'#1A1917' }}>{Number(d.hours).toFixed(2)} h</span>}
                            {canDeleteAttendance && d.id != null && d.src === 'att' && (
                              <button
                                onClick={() => deleteEntry('attendance', d.id)}
                                disabled={entryDelBusy === `attendance:${d.id}`}
                                title="Remove this entry (mistake correction)"
                                style={{ border:'1px solid #E5E2DC',background:'none',borderRadius:6,padding:'3px 9px',fontSize:11.5,fontWeight:600,color:'#991B1B',cursor:'pointer',fontFamily:'inherit',opacity: entryDelBusy === `attendance:${d.id}` ? 0.5 : 1 }}
                              >Remove</button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── AVAILABILITY TAB ── */}
          {activeTab === 'Availability' && (
            <SectionCard title="Weekly Availability">
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                {availability.map((day, i) => (
                  <div key={day.label} style={{ display:'grid', gridTemplateColumns:'80px 1fr', alignItems:'center', gap:16, padding:'10px 0', borderBottom:'1px solid #F3F4F6' }}>
                    <span style={{ fontSize:13,fontWeight:600,color:'#1A1917' }}>{day.label}</span>
                    <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
                      <Toggle value={day.is_available}
                        onChange={v => setAvailability(prev => prev.map((d,j)=>j===i?{...d,is_available:v}:d))}
                        label={day.is_available ? 'Available' : 'Unavailable'}/>
                      {day.is_available && (
                        <>
                          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                            <span style={{ fontSize:12,color:'#6B7280' }}>From</span>
                            <input type="time" value={day.start_time}
                              onChange={e => setAvailability(prev => prev.map((d,j)=>j===i?{...d,start_time:e.target.value}:d))}
                              style={{ height:32,padding:'0 8px',border:'1px solid #E5E2DC',borderRadius:6,fontSize:13,color:'#1A1917',outline:'none' }}/>
                            <span style={{ fontSize:12,color:'#6B7280' }}>To</span>
                            <input type="time" value={day.end_time}
                              onChange={e => setAvailability(prev => prev.map((d,j)=>j===i?{...d,end_time:e.target.value}:d))}
                              style={{ height:32,padding:'0 8px',border:'1px solid #E5E2DC',borderRadius:6,fontSize:13,color:'#1A1917',outline:'none' }}/>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop:20, display:'flex', justifyContent:'flex-end' }}>
                <button onClick={saveAvailability} disabled={saving}
                  style={{ display:'flex',alignItems:'center',gap:8,padding:'10px 20px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>
                  <Save size={14}/>{saving ? 'Saving…' : 'Save Availability'}
                </button>
              </div>
            </SectionCard>
          )}

          {/* ── USER ACCOUNT TAB ── */}
          {activeTab === 'User Account' && (
            <div>
              <SectionCard title="Account Details">
                <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:16 }}>
                  <Field label="Login Email"><Input value={form.email||''} onChange={v=>setField('email',v)}/></Field>
                  <Field label="Role">
                    {/* Admin privileges are owner-controlled: only the owner can
                        change a role (grant/revoke admin). Everyone else sees it
                        read-only — the server enforces this too. */}
                    {isOwner ? (
                      <Select value={form.role||''} onChange={v=>setField('role',v)} options={[
                        {value:'owner',label:'Owner'},{value:'admin',label:'Admin'},
                        {value:'office',label:'Office'},{value:'technician',label:'Technician'},
                        {value:'accountant',label:'Accountant (View-only)'}
                      ]}/>
                    ) : (
                      <div style={{ padding:'8px 12px', border:'1px solid #E5E2DC', borderRadius:8, background:'#FAFAF8', fontSize:13, color:'#1A1917', textTransform:'capitalize' }}>
                        {(form.role||'').replace('_',' ') || '—'}
                        <span style={{ marginLeft:8, fontSize:11, color:'#9E9B94' }}>· only the owner can change this</span>
                      </div>
                    )}
                  </Field>
                </div>
                <div style={{ marginTop:16 }}>
                  <Toggle value={!!form.is_active} onChange={v=>setField('is_active',v)} label="Account Active"/>
                </div>
                {user.invite_sent_at && (
                  <div style={{ marginTop:12, padding:'10px 12px', background:'#FEF3C7', borderRadius:8 }}>
                    <p style={{ margin:0,fontSize:12,color:'#92400E' }}>
                      Invite sent {new Date(user.invite_sent_at).toLocaleDateString()}&nbsp;·&nbsp;
                      {user.invite_accepted_at ? 'Accepted' : 'Pending acceptance'}
                    </p>
                  </div>
                )}
                <div style={{ marginTop:16, display:'flex', gap:10 }}>
                  <button
                    onClick={async () => {
                      const np = window.prompt(`Set a new password for ${fullName} (min 6 characters).\nGive this password to the employee — they sign in with their email + this password.`);
                      if (np == null) return;
                      if (np.trim().length < 6) { showToast("Password must be at least 6 characters"); return; }
                      try {
                        await apiFetch("/users/bulk-reset-password", {
                          method: "POST",
                          body: JSON.stringify({ userIds: [userId], newPassword: np.trim() }),
                        });
                        showToast("Password set — give it to the employee");
                      } catch {
                        showToast("Couldn't set password (owner/admin only)");
                      }
                    }}
                    style={{ padding:'8px 14px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:12,fontWeight:600,background:'#FFFFFF',cursor:'pointer',color:'#6B7280',fontFamily:'inherit' }}>
                    Reset Password
                  </button>
                </div>
              </SectionCard>

              <SectionCard title="Permissions">
                <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
                  <Toggle value={false} onChange={()=>{}} label="Can view other employees' schedules"/>
                  <Toggle value={false} onChange={()=>{}} label="Can edit job notes"/>
                  <Toggle value={false} onChange={()=>{}} label="Can access invoices"/>
                  <Toggle value={false} onChange={()=>{}} label="Can approve time-off requests"/>
                </div>
              </SectionCard>

              <div style={{ display:'flex', justifyContent:'flex-end' }}>
                <button onClick={saveProfile} disabled={saving}
                  style={{ display:'flex',alignItems:'center',gap:8,padding:'10px 20px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>
                  <Save size={14}/>{saving ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </div>
          )}

          {/* ── CONTACTS TAB ── */}
          {activeTab === 'Contacts' && (
            <SectionCard title="Emergency Contacts">
              {(user.emergency_contact_name) ? (
                <div style={{ border:'1px solid #E5E2DC', borderRadius:8, padding:'14px 16px', marginBottom:12 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                    <div>
                      <p style={{ fontSize:13,fontWeight:600,color:'#1A1917',margin:'0 0 4px 0' }}>{user.emergency_contact_name}</p>
                      {user.emergency_contact_relation && (
                        <span style={{ fontSize:11,background:'#EDE9FE',color:'#5B21B6',padding:'2px 8px',borderRadius:10,fontWeight:600 }}>{user.emergency_contact_relation}</span>
                      )}
                      {user.emergency_contact_phone && (
                        <p style={{ fontSize:13,color:'#6B7280',margin:'6px 0 0 0',display:'flex',alignItems:'center',gap:5 }}>
                          <Phone size={12}/>{user.emergency_contact_phone}
                        </p>
                      )}
                    </div>
                    <button onClick={() => setActiveTab('Information')}
                      style={{ background:'none',border:'none',cursor:'pointer',color:'var(--brand)',fontSize:12,fontWeight:600,fontFamily:'inherit' }}>
                      <Edit2 size={13}/> Edit
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ textAlign:'center', padding:'32px 0', color:'#9E9B94' }}>
                  <p style={{ fontSize:14, margin:'0 0 12px 0' }}>No emergency contacts yet</p>
                  <button onClick={() => setActiveTab('Information')}
                    style={{ padding:'8px 16px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>
                    <Plus size={13}/> Add in Information Tab
                  </button>
                </div>
              )}
            </SectionCard>
          )}

          {/* ── SCORECARDS TAB ── */}
          {activeTab === 'Performance Score' && (
            <div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:20, marginBottom:20 }}>
                <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, padding:'24px', display:'flex', flexDirection:'column', alignItems:'center', gap:8 }}>
                  <p style={{ fontSize:44,fontWeight:700,color:'var(--brand)',margin:0 }}>
                    {compositeScore != null ? `${compositeScore.toFixed(0)}%` : '—'}
                  </p>
                  <p style={{ fontSize:13,color:'#9E9B94',margin:0,textTransform:'uppercase',letterSpacing:'0.05em' }}>Performance Score</p>
                  <p style={{ fontSize:12,color:'#6B7280',margin:0 }}>Rolling composite · trailing 90 days</p>
                </div>
                <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, padding:'20px 24px' }}>
                  <p style={{ fontSize:12,fontWeight:700,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.05em',margin:'0 0 12px 0' }}>Score Breakdown — Trailing 90 Days</p>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12 }}>
                    {[
                      { key:'satisfaction', label:'Customer Satisfaction', value: comp?.satisfaction, weight: comp?.weights?.satisfaction ?? 60,
                        sub: !comp ? '' : comp.satisfaction_source === 'mc_lifetime'
                          ? 'MaidCentral history'
                          : `${comp.counts?.survey_responses ?? 0} survey${(comp.counts?.survey_responses ?? 0) === 1 ? '' : 's'} (90d)` },
                      { key:'attendance', label:'Attendance', value: comp?.attendance, weight: comp?.weights?.attendance ?? 25,
                        sub: comp ? `${comp.counts?.attendance_violations ?? 0} issue${(comp.counts?.attendance_violations ?? 0) === 1 ? '' : 's'} · ${comp.counts?.scheduled_days ?? 0} day${(comp.counts?.scheduled_days ?? 0) === 1 ? '' : 's'}` : '' },
                      { key:'complaint_free', label:'Complaint-Free', value: comp?.complaint_free, weight: comp?.weights?.complaint_free ?? 15,
                        sub: comp ? `${comp.counts?.valid_complaints ?? 0} complaint${(comp.counts?.valid_complaints ?? 0) === 1 ? '' : 's'} · ${comp.counts?.completed_jobs ?? 0} job${(comp.counts?.completed_jobs ?? 0) === 1 ? '' : 's'}` : '' },
                    ].map((m) => (
                      <div key={m.key} style={{ background:'#F7F6F3', border:'1px solid #EEECE7', borderRadius:8, padding:'12px 14px', display:'flex', flexDirection:'column', gap:4 }}>
                        <span style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.04em' }}>{m.label}</span>
                        <span style={{ fontSize:26, fontWeight:700, color: m.value != null ? '#1A1917' : '#C4C1BA' }}>
                          {m.value != null ? `${Number(m.value).toFixed(0)}%` : '—'}
                        </span>
                        <span style={{ fontSize:11, color:'#6B7280' }}>{m.weight}% weight</span>
                        <span style={{ fontSize:11, color:'#9E9B94' }}>{m.sub}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, padding:'20px 24px', marginBottom:20 }}>
                <p style={{ fontSize:12,fontWeight:700,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.05em',margin:'0 0 12px 0' }}>Satisfaction Trend — Recent Jobs</p>
                <ScoreTrendChart scores={scEntries.slice(0, 12).reverse().map((s: any, i: number) => ({
                  month: String(i),
                  score: parseFloat(s.max_value) > 0 ? (parseFloat(s.score_value) / parseFloat(s.max_value)) * 4 : 0,
                }))}/>
              </div>

              <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, overflow:'hidden' }}>
                <div style={{ padding:'14px 20px', borderBottom:'1px solid #EEECE7', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <p style={{ fontSize:13,fontWeight:700,color:'#1A1917',margin:0 }}>Rating History</p>
                </div>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom:'1px solid #EEECE7' }}>
                      {['Date','Job','Source','Score','Notes'].map(h=>(
                        <th key={h} style={{ padding:'10px 16px',textAlign:'left',fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {scEntries.map((s: any) => {
                      const val = parseFloat(s.score_value);
                      const max = parseFloat(s.max_value) || 100;
                      const scoreLabel = max === 100 ? `${val.toFixed(0)}%` : `${val.toFixed(1)} / ${max.toFixed(0)}`;
                      return (
                        <tr key={s.id} style={{ borderBottom:'1px solid #F3F4F6' }}>
                          <td style={{ padding:'12px 16px',fontSize:13,color:'#1A1917' }}>{new Date(s.entry_date + 'T00:00:00').toLocaleDateString()}</td>
                          <td style={{ padding:'12px 16px',fontSize:13,color:'#6B7280' }}>{s.job_id ? `#${s.job_id}` : '—'}</td>
                          <td style={{ padding:'12px 16px',fontSize:13,color:'#6B7280' }}>{s.source === 'mc' ? 'MaidCentral' : 'Qleno'}</td>
                          <td style={{ padding:'12px 16px' }}>
                            <span style={{ background:'var(--brand-dim)', color:'var(--brand)', padding:'3px 10px', borderRadius:20, fontSize:12, fontWeight:600 }}>
                              {scoreLabel}
                            </span>
                          </td>
                          <td style={{ padding:'12px 16px',fontSize:13,color:'#6B7280' }}>
                            <div>{s.notes || '—'}</div>
                            {s.office_reply && (
                              <div style={{ marginTop:8, padding:'8px 10px', background:'#F3F8F6', border:'1px solid #D7EBE4', borderRadius:8, color:'#1A1917' }}>
                                <span style={{ fontSize:11, fontWeight:700, color:'#0A7C63', textTransform:'uppercase', letterSpacing:'0.04em' }}>Office reply</span>
                                <div style={{ fontSize:13, marginTop:2 }}>{s.office_reply}</div>
                              </div>
                            )}
                            {canReplyToFeedback && (
                              replyOpenId === s.id ? (
                                <div style={{ marginTop:8 }}>
                                  <textarea value={replyText} onChange={e => setReplyText(e.target.value)} rows={2} autoFocus
                                    placeholder="Write a reply to this feedback…"
                                    style={{ width:'100%', resize:'vertical', padding:'8px 10px', border:'1px solid #E5E2DC', borderRadius:8, fontSize:13, fontFamily:"'Plus Jakarta Sans', sans-serif" }} />
                                  <div style={{ display:'flex', gap:8, marginTop:6 }}>
                                    <button onClick={() => submitFeedbackReply(s.id)} disabled={replySaving}
                                      style={{ background:'var(--brand)', color:'#04241d', border:'none', borderRadius:6, padding:'5px 12px', fontSize:12, fontWeight:700, cursor:'pointer', opacity:replySaving?0.6:1 }}>
                                      {replySaving ? 'Saving…' : 'Save reply'}
                                    </button>
                                    <button onClick={() => { setReplyOpenId(null); setReplyText(''); }}
                                      style={{ background:'none', color:'#6B7280', border:'1px solid #E5E2DC', borderRadius:6, padding:'5px 12px', fontSize:12, cursor:'pointer' }}>
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <button onClick={() => { setReplyOpenId(s.id); setReplyText(s.office_reply || ''); }}
                                  style={{ marginTop:6, background:'none', color:'var(--brand)', border:'none', padding:0, fontSize:12, fontWeight:600, cursor:'pointer' }}>
                                  {s.office_reply ? 'Edit reply' : 'Reply'}
                                </button>
                              )
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {!scEntries.length && (
                      <tr><td colSpan={5} style={{ padding:'32px',textAlign:'center',color:'#9E9B94',fontSize:13 }}>No scorecard entries yet</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── PAY CONFIGURATION TAB (4-cell matrix) ── */}
          {activeTab === 'Pay Configuration' && <PayMatrixPanel userId={userId} />}

          {/* ── ADDITIONAL PAY TAB ── */}
          {activeTab === 'Additional Pay' && (() => {
            const pays: any[] = additionalPayData?.data || [];
            const pending = pays.filter(p => p.status === 'pending');
            const paid    = pays.filter(p => p.status === 'paid');
            const voided  = pays.filter(p => p.status === 'voided');
            const pendingTotal = pending.reduce((s: number, p: any) => s + (p.type === 'amount_owed' ? -parseFloat(p.amount||0) : parseFloat(p.amount||0)), 0);
            const paidTotal    = paid.reduce((s: number, p: any) => s + (p.type === 'amount_owed' ? -parseFloat(p.amount||0) : parseFloat(p.amount||0)), 0);

            return (
              <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                {/* Summary cards */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
                  {[
                    { label:'Pending', value:`$${pendingTotal.toFixed(2)}`, count: pending.length, color:'#92400E', bg:'#FEF3C7' },
                    { label:'Paid', value:`$${paidTotal.toFixed(2)}`, count: paid.length, color:'#166534', bg:'#DCFCE7' },
                    { label:'Voided', value:`${voided.length} entries`, count: voided.length, color:'#6B7280', bg:'#F3F4F6' },
                  ].map(c => (
                    <div key={c.label} style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:8, padding:'14px 16px' }}>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
                        <span style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase' as const, letterSpacing:'0.05em' }}>{c.label}</span>
                        <span style={{ fontSize:10, fontWeight:700, padding:'2px 6px', borderRadius:10, background:c.bg, color:c.color }}>{c.count}</span>
                      </div>
                      <div style={{ fontSize:22, fontWeight:800, color:c.color }}>{c.value}</div>
                    </div>
                  ))}
                </div>

                {/* Header + action buttons */}
                <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
                  <button onClick={() => { setBulkStep(1); setBulkSelectedEmps([]); setBulkPayType('bonus'); setBulkAmount(''); setBulkNotes(''); setBulkEmpSearch(''); setBulkPayModal(true); }}
                    style={{ display:'flex',alignItems:'center',gap:6,padding:'8px 16px',background:'#FFFFFF',color:'#1A1917',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>
                    <Users size={14}/> Bulk Pay
                  </button>
                  <button onClick={() => setPayModal(true)}
                    style={{ display:'flex',alignItems:'center',gap:6,padding:'8px 16px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>
                    <Plus size={14}/> Add Pay Entry
                  </button>
                </div>

                {/* Pay table */}
                <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, overflow:'hidden' }}>
                  <table style={{ width:'100%', borderCollapse:'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom:'1px solid #EEECE7', background:'#FAFAF9' }}>
                        {['Date','Type','Amount','Status','Notes',''].map(h=>(
                          <th key={h} style={{ padding:'10px 16px',textAlign:'left',fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase' as const,letterSpacing:'0.05em' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pays.map((p: any) => {
                        const typeStyle = PAY_TYPE_COLORS[p.type] || { bg:'#F3F4F6',color:'#6B7280' };
                        const statusStyle = STATUS_STYLES[p.status] || STATUS_STYLES.pending;
                        const isDeduction = p.type === 'amount_owed';
                        const isVoided = p.status === 'voided';
                        return (
                          <tr key={p.id} style={{ borderBottom:'1px solid #F3F4F6', opacity: isVoided ? 0.55 : 1 }}>
                            <td style={{ padding:'11px 16px',fontSize:13,color:'#1A1917' }}>{new Date(p.created_at).toLocaleDateString()}</td>
                            <td style={{ padding:'11px 16px' }}>
                              <span style={{ background:typeStyle.bg,color:typeStyle.color,padding:'3px 9px',borderRadius:20,fontSize:11,fontWeight:600 }}>
                                {PAY_LABELS[p.type] || p.type?.replace(/_/g,' ')}
                              </span>
                            </td>
                            <td style={{ padding:'11px 16px',fontSize:13,fontWeight:700,color: isDeduction ? '#EF4444' : '#166534', textDecoration: isVoided ? 'line-through' : undefined }}>
                              {isDeduction ? '-' : '+'} ${parseFloat(p.amount||0).toFixed(2)}
                            </td>
                            <td style={{ padding:'11px 16px' }}>
                              <span style={{ background:statusStyle.bg,color:statusStyle.color,padding:'3px 8px',borderRadius:4,fontSize:11,fontWeight:700 }}>
                                {statusStyle.label}
                              </span>
                            </td>
                            <td style={{ padding:'11px 16px',fontSize:13,color:'#6B7280',maxWidth:240,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>
                              {p.notes || '—'}
                            </td>
                            <td style={{ padding:'11px 16px', textAlign:'right' as const }}>
                              {!isVoided && (
                                <div style={{ display:'flex', gap:6, justifyContent:'flex-end' }}>
                                  {p.status === 'pending' && (
                                    <>
                                      <button
                                        onClick={() => voidPay(p.id)}
                                        disabled={voidingId === p.id}
                                        title="Void"
                                        style={{ display:'flex',alignItems:'center',gap:4,padding:'4px 10px',border:'1px solid #E5E2DC',borderRadius:6,fontSize:11,fontWeight:600,background:'#FFFFFF',cursor:'pointer',color:'#92400E',fontFamily:'inherit' }}>
                                        <Ban size={11}/> Void
                                      </button>
                                      {['owner', 'admin', 'office'].includes(getTokenRole() || '') && (
                                        <button
                                          onClick={() => deletePay(p.id)}
                                          disabled={deletingId === p.id}
                                          title="Delete"
                                          style={{ display:'flex',alignItems:'center',gap:4,padding:'4px 10px',border:'1px solid #FECACA',borderRadius:6,fontSize:11,fontWeight:600,background:'#FEF2F2',cursor:'pointer',color:'#EF4444',fontFamily:'inherit' }}>
                                          <Trash2 size={11}/>
                                        </button>
                                      )}
                                    </>
                                  )}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {!pays.length && (
                        <tr><td colSpan={6} style={{ padding:'40px',textAlign:'center',color:'#9E9B94',fontSize:13 }}>No additional pay entries yet</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {/* ── PAYROLL HISTORY TAB ── */}
          {activeTab === 'Payroll History' && (() => {
            const records: any[] = payrollHistoryData?.data || [];

            const fmt = (v: any) => `$${parseFloat(v||0).toFixed(2)}`;
            const fmtH = (v: any) => `${parseFloat(v||0).toFixed(1)} hrs`;

            const PERIOD_LABELS: Record<string, string> = {
              '2025-full': 'Full Year 2025',
              '2026-ytd':  'YTD 2026',
            };

            const highlightRows = [
              { key:'total_job_hours',   label:'Total Job Hours',     fmt: fmtH },
              { key:'clock_hours',       label:'Clock Hours',         fmt: fmtH },
              { key:'overtime_hours',    label:'Overtime Hours',      fmt: fmtH },
              { key:'commission_pay',    label:'Commission Pay',      fmt },
              { key:'hourly_pay',        label:'Hourly Pay',          fmt },
              { key:'tips',              label:'Tips',                fmt },
              { key:'bonus',             label:'Bonus',               fmt },
              { key:'overtime',          label:'Overtime Pay',        fmt },
              { key:'sick_pay',          label:'Sick Pay',            fmt },
              { key:'holiday_pay',       label:'Holiday Pay',         fmt },
              { key:'vacation_pay',      label:'Vacation Pay',        fmt },
              { key:'reimbursements',    label:'Reimbursements',      fmt },
              { key:'gross_wage',        label:'Gross Wage',          fmt },
              { key:'avg_wage',          label:'Avg Wage/Hr',         fmt },
            ];

            if (!records.length) {
              return (
                <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:12, padding:'60px 0', textAlign:'center', color:'#9E9B94', fontSize:14 }}>
                  <TrendingUp size={32} style={{ marginBottom:12, color:'#E5E2DC' }}/>
                  <p style={{ margin:'0 0 4px 0', fontWeight:600 }}>No payroll history</p>
                  <p style={{ margin:0, fontSize:12 }}>Imported MaidCentral data will appear here</p>
                </div>
              );
            }

            return (
              <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                {/* Source notice */}
                <div style={{ background:'var(--brand-dim)', border:'1px solid rgba(0,201,160,0.2)', borderRadius:8, padding:'10px 16px', display:'flex', alignItems:'center', gap:10 }}>
                  <TrendingUp size={14} style={{ color:'var(--brand)', flexShrink:0 }}/>
                  <span style={{ fontSize:12, color:'var(--brand)', fontWeight:600 }}>
                    Payroll data imported from MaidCentral — {records.length} period{records.length!==1?'s':''} on file
                  </span>
                </div>

                {/* Period cards */}
                {records.map((r: any) => {
                  const isExpanded = expandedPeriod === r.id?.toString();
                  const periodName = PERIOD_LABELS[r.period_label] || r.period_label;
                  const start = new Date(r.period_start + 'T12:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
                  const end   = new Date(r.period_end   + 'T12:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });

                  return (
                    <div key={r.id} style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:12, overflow:'hidden' }}>
                      {/* Card header */}
                      <div
                        onClick={() => setExpandedPeriod(isExpanded ? null : r.id?.toString())}
                        style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'16px 20px', cursor:'pointer', userSelect:'none' as const }}
                      >
                        <div>
                          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4 }}>
                            <span style={{ fontSize:15, fontWeight:700, color:'#1A1917' }}>{periodName}</span>
                            <span style={{ fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:10, background:'var(--brand-dim)', color:'var(--brand)' }}>
                              {r.migration_source === 'mc_import' ? 'MaidCentral' : r.migration_source}
                            </span>
                          </div>
                          <span style={{ fontSize:12, color:'#9E9B94' }}>{start} — {end}</span>
                        </div>
                        <div style={{ display:'flex', alignItems:'center', gap:16 }}>
                          {/* Quick stats */}
                          <div style={{ textAlign:'right' as const }}>
                            <div style={{ fontSize:11, color:'#9E9B94', marginBottom:2 }}>Gross Wage</div>
                            <div style={{ fontSize:18, fontWeight:800, color:'#1A1917' }}>{fmt(r.gross_wage)}</div>
                          </div>
                          <div style={{ textAlign:'right' as const }}>
                            <div style={{ fontSize:11, color:'#9E9B94', marginBottom:2 }}>Job Hours</div>
                            <div style={{ fontSize:18, fontWeight:800, color:'var(--brand)' }}>{fmtH(r.total_job_hours)}</div>
                          </div>
                          <button
                            onClick={e => { e.stopPropagation(); setPrintRecord({ ...r, periodName, start, end }); }}
                            title="Download PDF"
                            style={{ display:'flex',alignItems:'center',gap:5,padding:'6px 12px',border:'1px solid #E5E2DC',borderRadius:8,background:'#FFFFFF',cursor:'pointer',fontSize:12,fontWeight:600,color:'#6B7280',fontFamily:'inherit' }}>
                            <Download size={13}/> PDF
                          </button>
                          {isExpanded
                            ? <ChevronUp size={18} style={{ color:'#9E9B94' }}/>
                            : <ChevronDown size={18} style={{ color:'#9E9B94' }}/>
                          }
                        </div>
                      </div>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <div style={{ borderTop:'1px solid #EEECE7', padding:'20px', display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 40px' }}>
                          {highlightRows.map((row, idx) => {
                            const val = r[row.key];
                            const isZero = !val || parseFloat(val) === 0;
                            return (
                              <div key={row.key} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'7px 0', borderBottom:'1px solid #F3F4F6', gridColumn: idx === highlightRows.length - 1 && highlightRows.length % 2 !== 0 ? '1 / -1' : undefined }}>
                                <span style={{ fontSize:12, color: isZero ? '#C4C0B8' : '#6B7280' }}>{row.label}</span>
                                <span style={{ fontSize:13, fontWeight:700, color: isZero ? '#C4C0B8' : (row.key === 'gross_wage' ? 'var(--brand)' : '#1A1917') }}>
                                  {row.fmt(val)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* ── CONTACT TICKETS TAB ── */}
          {activeTab === 'Contact Tickets' && (
            <div>
              <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}>
                <button onClick={() => setTicketModal(true)}
                  style={{ display:'flex',alignItems:'center',gap:6,padding:'8px 16px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>
                  <Plus size={14}/> New Ticket
                </button>
              </div>
              <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, overflow:'hidden' }}>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom:'1px solid #EEECE7' }}>
                      {['Date','Type','Client','Notes'].map(h=>(
                        <th key={h} style={{ padding:'10px 16px',textAlign:'left',fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(ticketsData?.data || []).map((t: any) => {
                      const ts = TICKET_TYPE_STYLES[t.ticket_type] || { bg:'#F3F4F6', color:'#6B7280', label: t.ticket_type };
                      return (
                        <tr key={t.id} style={{ borderBottom:'1px solid #F3F4F6' }}>
                          <td style={{ padding:'12px 16px',fontSize:13,color:'#1A1917' }}>{new Date(t.created_at).toLocaleDateString()}</td>
                          <td style={{ padding:'12px 16px' }}>
                            <span style={{ background:ts.bg,color:ts.color,padding:'3px 10px',borderRadius:20,fontSize:11,fontWeight:600 }}>{ts.label}</span>
                          </td>
                          <td style={{ padding:'12px 16px',fontSize:13,color:'#6B7280' }}>{t.client_name || '—'}</td>
                          <td style={{ padding:'12px 16px',fontSize:13,color:'#6B7280', maxWidth:300 }}>{t.notes || '—'}</td>
                        </tr>
                      );
                    })}
                    {!(ticketsData?.data||[]).length && (
                      <tr><td colSpan={4} style={{ padding:'32px',textAlign:'center',color:'#9E9B94',fontSize:13 }}>No contact tickets</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── JOBS TAB ── */}
          {activeTab === 'Jobs' && (
            <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, overflow:'hidden' }}>
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead>
                  <tr style={{ borderBottom:'1px solid #EEECE7' }}>
                    {['Date','Client','Service Type','Status','Amount'].map(h=>(
                      <th key={h} style={{ padding:'10px 16px',textAlign:'left',fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.05em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(jobsData?.data || []).map((j: any) => (
                    <tr key={j.id} style={{ borderBottom:'1px solid #F3F4F6' }}>
                      <td style={{ padding:'12px 16px',fontSize:13,color:'#1A1917' }}>{new Date(j.scheduled_date+'T00:00:00').toLocaleDateString()}</td>
                      <td style={{ padding:'12px 16px',fontSize:13,color:'#1A1917' }}>{j.client_name}</td>
                      <td style={{ padding:'12px 16px',fontSize:13,color:'#6B7280',textTransform:'capitalize' }}>{j.service_type?.replace(/_/g,' ')}</td>
                      <td style={{ padding:'12px 16px' }}>
                        <span style={{
                          background: j.status==='complete'?'#DCFCE7':j.status==='in_progress'?'var(--brand-dim)':'#F3F4F6',
                          color: j.status==='complete'?'#166534':j.status==='in_progress'?'var(--brand)':'#6B7280',
                          padding:'3px 10px',borderRadius:20,fontSize:11,fontWeight:600,
                        }}>{j.status?.replace(/_/g,' ').toUpperCase()}</span>
                      </td>
                      <td style={{ padding:'12px 16px',fontSize:13,fontWeight:600,color:'#1A1917' }}>
                        ${parseFloat(j.base_fee || 0).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                  {!(jobsData?.data||[]).length && (
                    <tr><td colSpan={5} style={{ padding:'32px',textAlign:'center',color:'#9E9B94',fontSize:13 }}>No jobs assigned yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* ── NOTES TAB ── */}
          {activeTab === 'Incentives' && (() => {
            const thisYear = new Date().getFullYear();
            const ytdAll = incentivesData.filter((i: any) => i.earned_date && new Date(i.earned_date + 'T12:00').getFullYear() === thisYear);
            const ytdEarned = ytdAll.reduce((s: number, i: any) => s + parseFloat(i.amount || 0), 0);
            const ytdPaid = ytdAll.filter((i: any) => i.status === 'paid' || i.paid_date).reduce((s: number, i: any) => s + parseFloat(i.amount || 0), 0);
            const pendingUnpaid = ytdAll.filter((i: any) => i.status === 'approved' && !i.paid_date).reduce((s: number, i: any) => s + parseFloat(i.amount || 0), 0);
            const STATUS_S: Record<string, { bg: string; color: string; label: string }> = {
              pending_approval: { bg:'#FEF3C7', color:'#92400E', label:'Pending Approval' },
              approved:         { bg:'#DBEAFE', color:'#1E40AF', label:'Approved' },
              rejected:         { bg:'#F3F4F6', color:'#6B7280', label:'Rejected' },
              paid:             { bg:'#DCFCE7', color:'#166534', label:'Paid' },
            };
            return (
              <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                {/* YTD summary cards */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
                  {[
                    { label:'Earned YTD', value:`$${ytdEarned.toFixed(2)}`, color:'#1A1917' },
                    { label:'Paid YTD', value:`$${ytdPaid.toFixed(2)}`, color:'#166534' },
                    { label:'Approved — Unpaid', value:`$${pendingUnpaid.toFixed(2)}`, color: pendingUnpaid > 0 ? '#92400E' : '#9E9B94' },
                  ].map(c => (
                    <div key={c.label} style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:8, padding:'14px 16px', textAlign:'center' }}>
                      <div style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase' as const, letterSpacing:'0.05em', marginBottom:6 }}>{c.label}</div>
                      <div style={{ fontSize:22, fontWeight:800, color:c.color }}>{c.value}</div>
                    </div>
                  ))}
                </div>

                {/* History table */}
                <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, overflow:'hidden' }}>
                  <div style={{ padding:'12px 18px', borderBottom:'1px solid #EEECE7' }}>
                    <p style={{ margin:0, fontSize:13, fontWeight:700, color:'#1A1917' }}>Incentive History</p>
                  </div>
                  {incentivesData.length === 0 ? (
                    <div style={{ padding:'40px 0', textAlign:'center', color:'#9E9B94', fontSize:13 }}>No incentives earned yet</div>
                  ) : (
                    <table style={{ width:'100%', borderCollapse:'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom:'1px solid #EEECE7' }}>
                          {['Program','Amount','Earned Date','Status','Paid Date'].map(h => (
                            <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase' as const, letterSpacing:'0.05em' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {incentivesData.map((inc: any) => {
                          const s = STATUS_S[inc.status] ?? STATUS_S.approved;
                          return (
                            <tr key={inc.id} style={{ borderBottom:'1px solid #F3F4F6' }}>
                              <td style={{ padding:'12px 16px', fontSize:13, fontWeight:600, color:'#1A1917' }}>{inc.program_name || '—'}</td>
                              <td style={{ padding:'12px 16px', fontSize:13, fontWeight:700, color:'#166534' }}>${parseFloat(inc.amount || 0).toFixed(2)}</td>
                              <td style={{ padding:'12px 16px', fontSize:12, color:'#6B7280' }}>
                                {inc.earned_date ? new Date(inc.earned_date + 'T12:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—'}
                              </td>
                              <td style={{ padding:'12px 16px' }}>
                                <span style={{ padding:'2px 7px', borderRadius:4, fontSize:11, fontWeight:700, background:s.bg, color:s.color }}>{s.label}</span>
                              </td>
                              <td style={{ padding:'12px 16px', fontSize:12, color:'#6B7280' }}>
                                {inc.paid_date ? new Date(inc.paid_date + 'T12:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            );
          })()}

          {activeTab === 'Notes' && (
            <div>
              <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}>
                <button onClick={() => setNoteModal(true)}
                  style={{ display:'flex',alignItems:'center',gap:6,padding:'8px 16px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>
                  <Plus size={14}/> Add Note
                </button>
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                {(notesData?.data || []).map((n: any) => (
                  <div key={n.id} style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, padding:'14px 18px' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        {n.is_system && <span style={{ fontSize:10,background:'#F3F4F6',color:'#6B7280',padding:'2px 6px',borderRadius:10,fontWeight:600 }}>SYSTEM</span>}
                        <span style={{ fontSize:12,fontWeight:600,color:'#1A1917' }}>{n.note_type?.replace(/_/g,' ')}</span>
                      </div>
                      <span style={{ fontSize:11,color:'#9E9B94' }}>{new Date(n.created_at).toLocaleString()}</span>
                    </div>
                    <p style={{ fontSize:13,color:'#374151',margin:'0 0 4px 0',lineHeight:'1.5' }}>{n.content}</p>
                    {n.creator_name && <p style={{ fontSize:11,color:'#9E9B94',margin:0 }}>By {n.creator_name}</p>}
                  </div>
                ))}
                {!(notesData?.data||[]).length && (
                  <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, padding:'48px 0', textAlign:'center', color:'#9E9B94', fontSize:13 }}>
                    No notes yet
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'HR Attendance' && user && (
            <HRAttendanceTab employeeId={user.id} />
          )}

          {activeTab === 'Leave Balance' && user && (
            <LeaveBalanceTab employeeId={user.id} />
          )}

          {activeTab === 'Discipline' && user && (
            <DisciplineTab employeeId={user.id} />
          )}

          {activeTab === 'Quality' && user && (
            <QualityTab employeeId={user.id} />
          )}

          {activeTab === 'Onboarding' && user && (
            <OnboardingTab employeeId={user.id} />
          )}

        </div>

        {/* ── MODALS ── */}
        {noteModal && (
          <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000 }}>
            <div style={{ background:'#FFFFFF',borderRadius:12,padding:28,width:440,boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}>
              <h3 style={{ margin:'0 0 16px 0',fontSize:16,fontWeight:700,color:'#1A1917' }}>Add Note</h3>
              <textarea value={noteContent} onChange={e=>setNoteContent(e.target.value)} placeholder="Note content…"
                style={{ width:'100%',height:100,padding:'10px 12px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,resize:'vertical',outline:'none',fontFamily:'inherit',marginBottom:16 }}/>
              <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
                <button onClick={() => { setNoteModal(false); setNoteContent(''); }}
                  style={{ padding:'8px 16px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,background:'#FFFFFF',cursor:'pointer',fontFamily:'inherit' }}>Cancel</button>
                <button onClick={addNote} style={{ padding:'8px 16px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>Add Note</button>
              </div>
            </div>
          </div>
        )}

        {ticketModal && (
          <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000 }}>
            <div style={{ background:'#FFFFFF',borderRadius:12,padding:28,width:440,boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}>
              <h3 style={{ margin:'0 0 16px 0',fontSize:16,fontWeight:700,color:'#1A1917' }}>New Contact Ticket</h3>
              <div style={{ marginBottom:12 }}>
                <Field label="Type">
                  <select value={newTicket.ticket_type} onChange={e=>setNewTicket(p=>({...p,ticket_type:e.target.value}))}
                    style={{ height:36,padding:'0 10px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,color:'#1A1917',background:'#FFFFFF',outline:'none',width:'100%' }}>
                    {Object.entries(TICKET_TYPE_STYLES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
                  </select>
                </Field>
              </div>
              <div style={{ marginBottom:16 }}>
                <Field label="Notes">
                  <textarea value={newTicket.notes} onChange={e=>setNewTicket(p=>({...p,notes:e.target.value}))}
                    style={{ width:'100%',height:80,padding:'10px 12px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,resize:'vertical',outline:'none',fontFamily:'inherit' }}/>
                </Field>
              </div>
              <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
                <button onClick={() => setTicketModal(false)}
                  style={{ padding:'8px 16px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,background:'#FFFFFF',cursor:'pointer',fontFamily:'inherit' }}>Cancel</button>
                <button onClick={addTicket} style={{ padding:'8px 16px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>Add Ticket</button>
              </div>
            </div>
          </div>
        )}

        {payModal && (
          <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000 }}>
            <div style={{ background:'#FFFFFF',borderRadius:12,padding:28,width:460,boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}>
              <h3 style={{ margin:'0 0 4px 0',fontSize:16,fontWeight:700,color:'#1A1917' }}>Add Pay Entry</h3>
              <p style={{ margin:'0 0 18px 0', fontSize:12, color:'#9E9B94' }}>Entry will be marked <span style={{ fontWeight:700, color:'#92400E' }}>Pending</span> until the next day is closed.</p>
              <div style={{ display:'flex', flexDirection:'column', gap:12, marginBottom:16 }}>
                <Field label="Pay Type">
                  <select value={newPay.type} onChange={e=>setNewPay(p=>({...p,type:e.target.value}))}
                    style={{ height:38,padding:'0 10px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,color:'#1A1917',background:'#FFFFFF',outline:'none',width:'100%' }}>
                    {PAY_GROUPS.map(g => (
                      <optgroup key={g.label} label={g.label}>
                        {g.types.map(t => (
                          <option key={t} value={t}>{PAY_LABELS[t]}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </Field>
                <Field label="Date">
                  <CalendarPopover value={newPay.date} ariaLabel="Date" onChange={v=>setNewPay(p=>({...p,date:v}))} block />
                </Field>
                <Field label="Amount ($)">
                  <Input type="number" value={newPay.amount} onChange={v=>setNewPay(p=>({...p,amount:v}))} placeholder="0.00"/>
                </Field>
                <Field label="Notes (optional)">
                  <Input value={newPay.notes} onChange={v=>setNewPay(p=>({...p,notes:v}))} placeholder="Reason or reference…"/>
                </Field>
              </div>
              <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
                <button onClick={() => { setPayModal(false); setNewPay({ type:'bonus', amount:'', notes:'', date: new Date().toISOString().slice(0, 10) }); }}
                  style={{ padding:'8px 16px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,background:'#FFFFFF',cursor:'pointer',fontFamily:'inherit' }}>Cancel</button>
                <button onClick={addPay} disabled={!newPay.amount}
                  style={{ padding:'8px 20px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit',opacity:!newPay.amount?0.5:1 }}>
                  Add Entry
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── BULK PAY MODAL ── */}
        {bulkPayModal && (() => {
          const allEmps: any[] = (allEmployeesData?.data || []).filter((e: any) => e.role !== 'owner');
          const filtered = allEmps.filter((e: any) =>
            !bulkEmpSearch || `${e.first_name} ${e.last_name}`.toLowerCase().includes(bulkEmpSearch.toLowerCase())
          );
          const selectedEmpObjects = allEmps.filter((e: any) => bulkSelectedEmps.includes(e.id));

          return (
            <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.45)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1100 }}>
              <div style={{ background:'#FFFFFF',borderRadius:14,width:520,maxHeight:'85vh',display:'flex',flexDirection:'column',boxShadow:'0 24px 64px rgba(0,0,0,0.22)' }}>
                {/* Header */}
                <div style={{ padding:'20px 24px 16px', borderBottom:'1px solid #EEECE7' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <Users size={18} style={{ color:'var(--brand)' }}/>
                      <span style={{ fontSize:16, fontWeight:700, color:'#1A1917' }}>Bulk Pay</span>
                    </div>
                    <button onClick={() => setBulkPayModal(false)} style={{ background:'none',border:'none',cursor:'pointer',color:'#9E9B94',padding:4 }}><X size={18}/></button>
                  </div>
                  {/* Step indicators */}
                  <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                    {(['Select Employees','Pay Details','Confirm'] as const).map((label, i) => (
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <div style={{ width:22,height:22,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:700,background: bulkStep > i+1 ? 'var(--brand)' : bulkStep === i+1 ? 'var(--brand)' : '#E5E2DC',color: bulkStep >= i+1 ? '#fff' : '#9E9B94' }}>{i+1}</div>
                        <span style={{ fontSize:11,fontWeight:600,color: bulkStep === i+1 ? '#1A1917' : '#9E9B94' }}>{label}</span>
                        {i < 2 && <div style={{ width:20,height:1,background:'#E5E2DC' }}/>}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Body */}
                <div style={{ flex:1, overflowY:'auto', padding:'20px 24px' }}>
                  {/* STEP 1: Employee Selection */}
                  {bulkStep === 1 && (
                    <div>
                      <p style={{ fontSize:13,color:'#6B7280',margin:'0 0 12px 0' }}>Select employees who will receive this pay entry.</p>
                      <input
                        value={bulkEmpSearch}
                        onChange={e => setBulkEmpSearch(e.target.value)}
                        placeholder="Search employees…"
                        style={{ width:'100%',height:36,padding:'0 12px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,outline:'none',marginBottom:10,fontFamily:'inherit' }}
                      />
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                        <span style={{ fontSize:11,color:'#9E9B94',fontWeight:600 }}>{bulkSelectedEmps.length} selected</span>
                        <button onClick={() => setBulkSelectedEmps(bulkSelectedEmps.length === allEmps.length ? [] : allEmps.map((e: any) => e.id))}
                          style={{ fontSize:11,fontWeight:600,color:'var(--brand)',background:'none',border:'none',cursor:'pointer',padding:0 }}>
                          {bulkSelectedEmps.length === allEmps.length ? 'Deselect All' : 'Select All'}
                        </button>
                      </div>
                      <div style={{ border:'1px solid #E5E2DC',borderRadius:8,overflow:'hidden',maxHeight:260,overflowY:'auto' }}>
                        {filtered.map((e: any) => {
                          const isChecked = bulkSelectedEmps.includes(e.id);
                          return (
                            <label key={e.id} style={{ display:'flex',alignItems:'center',gap:12,padding:'10px 14px',borderBottom:'1px solid #F3F4F6',cursor:'pointer',background: isChecked ? '#F0FBF8' : '#FFFFFF' }}>
                              <input type="checkbox" checked={isChecked} onChange={() => setBulkSelectedEmps(prev => isChecked ? prev.filter(id => id !== e.id) : [...prev, e.id])}
                                style={{ accentColor:'var(--brand)',width:15,height:15,flexShrink:0 }}/>
                              <EmployeeAvatar name={`${e.first_name ?? ''} ${e.last_name ?? ''}`} avatarUrl={e.avatar_url} size={30} fontSize={11} />
                              <div>
                                <div style={{ fontSize:13,fontWeight:600,color:'#1A1917' }}>{e.first_name} {e.last_name}</div>
                                <div style={{ fontSize:11,color:'#9E9B94',textTransform:'capitalize' }}>{e.role}</div>
                              </div>
                            </label>
                          );
                        })}
                        {!filtered.length && <div style={{ padding:'24px',textAlign:'center',color:'#9E9B94',fontSize:13 }}>No employees found</div>}
                      </div>
                    </div>
                  )}

                  {/* STEP 2: Pay Details */}
                  {bulkStep === 2 && (
                    <div style={{ display:'flex',flexDirection:'column',gap:14 }}>
                      <p style={{ fontSize:13,color:'#6B7280',margin:'0 0 4px 0' }}>Choose pay type and amount for <strong>{bulkSelectedEmps.length}</strong> employee{bulkSelectedEmps.length !== 1 ? 's' : ''}.</p>
                      <Field label="Pay Type">
                        <select value={bulkPayType} onChange={e => setBulkPayType(e.target.value)}
                          style={{ height:38,padding:'0 10px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,color:'#1A1917',background:'#FFFFFF',outline:'none',width:'100%' }}>
                          {PAY_GROUPS.map(g => (
                            <optgroup key={g.label} label={g.label}>
                              {g.types.map(t => <option key={t} value={t}>{PAY_LABELS[t]}</option>)}
                            </optgroup>
                          ))}
                        </select>
                      </Field>
                      <Field label="Amount ($) — per employee">
                        <Input type="number" value={bulkAmount} onChange={v => setBulkAmount(v)} placeholder="0.00"/>
                      </Field>
                      <Field label="Notes (optional)">
                        <Input value={bulkNotes} onChange={v => setBulkNotes(v)} placeholder="Reason or reference…"/>
                      </Field>
                      <div style={{ background:'#FEF3C7',border:'1px solid #FDE68A',borderRadius:8,padding:'10px 14px',fontSize:12,color:'#92400E',fontWeight:600 }}>
                        Each entry will be marked Pending until the next day is closed.
                      </div>
                    </div>
                  )}

                  {/* STEP 3: Confirm */}
                  {bulkStep === 3 && (
                    <div>
                      <p style={{ fontSize:13,color:'#6B7280',margin:'0 0 12px 0' }}>Review before submitting.</p>
                      <div style={{ background:'#F7F6F3',borderRadius:8,padding:'12px 16px',marginBottom:12 }}>
                        <div style={{ fontSize:12,color:'#9E9B94',marginBottom:2 }}>Pay Type</div>
                        <div style={{ fontSize:14,fontWeight:700,color:'#1A1917' }}>{PAY_LABELS[bulkPayType] || bulkPayType}</div>
                        <div style={{ fontSize:12,color:'#9E9B94',marginTop:8,marginBottom:2 }}>Amount per Employee</div>
                        <div style={{ fontSize:22,fontWeight:800,color:'var(--brand)' }}>${parseFloat(bulkAmount||'0').toFixed(2)}</div>
                        <div style={{ fontSize:12,color:'#9E9B94',marginTop:8 }}>Total payout: <strong style={{ color:'#1A1917' }}>${(parseFloat(bulkAmount||'0') * bulkSelectedEmps.length).toFixed(2)}</strong></div>
                        {bulkNotes && <div style={{ fontSize:12,color:'#6B7280',marginTop:8 }}>Note: {bulkNotes}</div>}
                      </div>
                      <div style={{ border:'1px solid #E5E2DC',borderRadius:8,overflow:'hidden',maxHeight:220,overflowY:'auto' }}>
                        {selectedEmpObjects.map((e: any) => (
                          <div key={e.id} style={{ display:'flex',alignItems:'center',justifyContent:'space-between',padding:'9px 14px',borderBottom:'1px solid #F3F4F6' }}>
                            <div style={{ display:'flex',alignItems:'center',gap:10 }}>
                              <EmployeeAvatar name={`${e.first_name ?? ''} ${e.last_name ?? ''}`} avatarUrl={e.avatar_url} size={28} fontSize={10} />
                              <span style={{ fontSize:13,fontWeight:600,color:'#1A1917' }}>{e.first_name} {e.last_name}</span>
                            </div>
                            <span style={{ fontSize:13,fontWeight:700,color:'#166534' }}>${parseFloat(bulkAmount||'0').toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div style={{ padding:'16px 24px', borderTop:'1px solid #EEECE7', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <button onClick={() => bulkStep === 1 ? setBulkPayModal(false) : setBulkStep(s => (s - 1) as 1|2|3)}
                    style={{ padding:'8px 18px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,background:'#FFFFFF',cursor:'pointer',fontFamily:'inherit',color:'#1A1917' }}>
                    {bulkStep === 1 ? 'Cancel' : 'Back'}
                  </button>
                  {bulkStep < 3 ? (
                    <button
                      disabled={bulkStep === 1 ? !bulkSelectedEmps.length : !bulkAmount}
                      onClick={() => setBulkStep(s => (s + 1) as 1|2|3)}
                      style={{ padding:'8px 22px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit',opacity:(bulkStep === 1 ? !bulkSelectedEmps.length : !bulkAmount) ? 0.5 : 1 }}>
                      Next
                    </button>
                  ) : (
                    <button onClick={bulkPay} disabled={bulkSubmitting}
                      style={{ padding:'8px 22px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit',opacity:bulkSubmitting?0.6:1 }}>
                      {bulkSubmitting ? 'Submitting…' : `Submit (${bulkSelectedEmps.length})`}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── PRINT PAYROLL PDF ── */}
        {printRecord && (() => {
          const r = printRecord;
          const empName = user ? `${user.first_name} ${user.last_name}` : 'Employee';
          const fmt2 = (v: any) => `$${parseFloat(v||0).toFixed(2)}`;
          const fmtH2 = (v: any) => `${parseFloat(v||0).toFixed(1)} hrs`;
          const rows = [
            { label:'Total Job Hours',  val: fmtH2(r.total_job_hours) },
            { label:'Clock Hours',      val: fmtH2(r.clock_hours) },
            { label:'Overtime Hours',   val: fmtH2(r.overtime_hours) },
            { label:'Commission Pay',   val: fmt2(r.commission_pay) },
            { label:'Hourly Pay',       val: fmt2(r.hourly_pay) },
            { label:'Tips',             val: fmt2(r.tips) },
            { label:'Bonus',            val: fmt2(r.bonus) },
            { label:'Overtime Pay',     val: fmt2(r.overtime) },
            { label:'Sick Pay',         val: fmt2(r.sick_pay) },
            { label:'Holiday Pay',      val: fmt2(r.holiday_pay) },
            { label:'Vacation Pay',     val: fmt2(r.vacation_pay) },
            { label:'Reimbursements',   val: fmt2(r.reimbursements) },
            { label:'Gross Wage',       val: fmt2(r.gross_wage), bold: true },
            { label:'Avg Wage/Hr',      val: fmt2(r.avg_wage) },
          ];

          function triggerPrint() {
            const styleId = 'qleno-print-style';
            if (!document.getElementById(styleId)) {
              const s = document.createElement('style');
              s.id = styleId;
              s.innerHTML = `@media print { body > *:not(#qleno-print-root) { display:none!important; } #qleno-print-root { display:block!important; position:fixed;inset:0;z-index:99999;background:#fff;padding:40px; font-family:'Plus Jakarta Sans',sans-serif; } }`;
              document.head.appendChild(s);
            }
            const el = document.getElementById('qleno-print-root');
            if (el) el.style.display = 'none';
            setTimeout(() => { window.print(); }, 50);
          }

          return (
            <>
              {/* Hidden print-only element */}
              <div id="qleno-print-root" style={{ display:'none' }}>
                <div style={{ maxWidth:540,margin:'0 auto',fontFamily:"'Plus Jakarta Sans',sans-serif" }}>
                  <div style={{ display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:28,paddingBottom:16,borderBottom:'2px solid #00C9A0' }}>
                    <div>
                      <div style={{ fontSize:22,fontWeight:800,color:'#0A0E1A',letterSpacing:'-0.5px' }}>QLENO</div>
                      <div style={{ fontSize:11,color:'#9E9B94',marginTop:2 }}>PHES Cleaning LLC</div>
                    </div>
                    <div style={{ textAlign:'right' }}>
                      <div style={{ fontSize:13,fontWeight:700,color:'#1A1917' }}>Payroll Summary</div>
                      <div style={{ fontSize:11,color:'#9E9B94' }}>Printed {new Date().toLocaleDateString()}</div>
                    </div>
                  </div>
                  <div style={{ marginBottom:20 }}>
                    <div style={{ fontSize:18,fontWeight:800,color:'#1A1917' }}>{empName}</div>
                    <div style={{ fontSize:13,fontWeight:600,color:'#00C9A0',marginTop:2 }}>{r.periodName}</div>
                    <div style={{ fontSize:11,color:'#9E9B94',marginTop:2 }}>{r.start} — {r.end}</div>
                  </div>
                  <table style={{ width:'100%',borderCollapse:'collapse',fontSize:13 }}>
                    <tbody>
                      {rows.map(row => (
                        <tr key={row.label} style={{ borderBottom:'1px solid #F3F4F6' }}>
                          <td style={{ padding:'8px 0',color: row.bold ? '#1A1917' : '#6B7280',fontWeight: row.bold ? 700 : 400 }}>{row.label}</td>
                          <td style={{ padding:'8px 0',textAlign:'right',fontWeight: row.bold ? 800 : 600,color: row.bold ? '#00C9A0' : '#1A1917' }}>{row.val}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ marginTop:24,paddingTop:12,borderTop:'1px solid #E5E2DC',fontSize:10,color:'#C4C0B8',textAlign:'center' }}>
                    Data imported from MaidCentral · Generated by Qleno
                  </div>
                </div>
              </div>

              {/* Preview modal */}
              <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.45)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1100 }}>
                <div style={{ background:'#FFFFFF',borderRadius:14,width:500,boxShadow:'0 24px 64px rgba(0,0,0,0.22)' }}>
                  <div style={{ padding:'20px 24px 16px',borderBottom:'1px solid #EEECE7',display:'flex',justifyContent:'space-between',alignItems:'center' }}>
                    <div style={{ display:'flex',alignItems:'center',gap:8 }}>
                      <Download size={16} style={{ color:'var(--brand)' }}/>
                      <span style={{ fontSize:15,fontWeight:700,color:'#1A1917' }}>Payroll PDF — {r.periodName}</span>
                    </div>
                    <button onClick={() => setPrintRecord(null)} style={{ background:'none',border:'none',cursor:'pointer',color:'#9E9B94' }}><X size={18}/></button>
                  </div>
                  <div style={{ padding:'20px 24px' }}>
                    <p style={{ fontSize:13,color:'#6B7280',margin:'0 0 16px 0' }}>
                      Ready to print: <strong style={{ color:'#1A1917' }}>{empName} · {r.periodName}</strong> ({r.start} — {r.end})
                    </p>
                    <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:16 }}>
                      {[
                        { label:'Gross Wage',  val: fmt2(r.gross_wage) },
                        { label:'Job Hours',   val: fmtH2(r.total_job_hours) },
                      ].map(s => (
                        <div key={s.label} style={{ background:'#F7F6F3',borderRadius:8,padding:'12px 14px' }}>
                          <div style={{ fontSize:11,color:'#9E9B94',marginBottom:4 }}>{s.label}</div>
                          <div style={{ fontSize:18,fontWeight:800,color:'#1A1917' }}>{s.val}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ display:'flex',gap:10,justifyContent:'flex-end' }}>
                      <button onClick={() => setPrintRecord(null)}
                        style={{ padding:'8px 18px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,background:'#FFFFFF',cursor:'pointer',fontFamily:'inherit' }}>Cancel</button>
                      <button onClick={() => { triggerPrint(); setPrintRecord(null); }}
                        style={{ display:'flex',alignItems:'center',gap:6,padding:'8px 20px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>
                        <Download size={13}/> Print / Save PDF
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </>
          );
        })()}

        {/* ── TOAST ── */}
        {toast && (
          <div style={{ position:'fixed',bottom:24,right:24,background:'#1A1917',color:'#FFFFFF',padding:'12px 20px',borderRadius:10,fontSize:13,fontWeight:600,zIndex:2000,boxShadow:'0 8px 24px rgba(0,0,0,0.2)' }}>
            <Check size={14} style={{ marginRight:6,verticalAlign:'middle' }}/>{toast}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

// [pay-matrix 2026-04-29] Per-employee 4-cell pay matrix panel.
// Reads u.{residential,commercial}_pay_{type,rate} via GET /users/:id;
// saves via PATCH /users/:id. Type toggle changes the input label
// and validation: hourly is $/hr ($10–$100 reasonable), commission
// is % (0–100 in UI, persisted as 0–1 fraction). Tenant defaults
// inherit on new employee creation server-side.
function PayMatrixPanel({ userId }: { userId: string }) {
  const [resType, setResType] = useState<"commission" | "hourly">("commission");
  const [resRate, setResRate] = useState<string>("35");
  const [comType, setComType] = useState<"commission" | "hourly">("hourly");
  const [comRate, setComRate] = useState<string>("20");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Display-format helpers: residential commission is stored as a
  // fraction 0–1 but shown in the UI as 0–100. Hourly is stored and
  // shown in dollars. Same dual-meaning for commercial.
  const fmtRate = (type: "commission" | "hourly", rate: number) =>
    type === "commission" ? String(Math.round(rate * 100)) : rate.toFixed(2);
  const parseRate = (type: "commission" | "hourly", input: string): number =>
    type === "commission" ? parseFloat(input) / 100 : parseFloat(input);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch(`/users/${userId}`);
        if (cancelled) return;
        const d = r?.data ?? r;
        const rt = (d?.residential_pay_type === "hourly" ? "hourly" : "commission") as "commission" | "hourly";
        const ct = (d?.commercial_pay_type === "commission" ? "commission" : "hourly") as "commission" | "hourly";
        setResType(rt);
        setComType(ct);
        if (d?.residential_pay_rate != null) setResRate(fmtRate(rt, parseFloat(d.residential_pay_rate)));
        if (d?.commercial_pay_rate != null)  setComRate(fmtRate(ct, parseFloat(d.commercial_pay_rate)));
      } catch (err: any) {
        setError(err?.message ?? "Could not load pay configuration.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  function validate(type: "commission" | "hourly", input: string): string | null {
    const n = parseFloat(input);
    if (Number.isNaN(n) || n < 0) return "Must be a positive number.";
    if (type === "hourly" && (n < 10 || n > 100)) return "Hourly rates should be $10–$100/hr.";
    if (type === "commission" && (n < 0 || n > 100)) return "Commission must be 0–100%.";
    return null;
  }

  async function save() {
    const resErr = validate(resType, resRate);
    const comErr = validate(comType, comRate);
    if (resErr || comErr) {
      setError(resErr || comErr);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/users/${userId}`, {
        method: "PUT",
        body: JSON.stringify({
          residential_pay_type: resType,
          residential_pay_rate: parseRate(resType, resRate),
          commercial_pay_type: comType,
          commercial_pay_rate: parseRate(comType, comRate),
        }),
      });
      setToast("Pay configuration saved");
      setTimeout(() => setToast(null), 2400);
    } catch (err: any) {
      setError(err?.message ?? "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ padding: 24, color: "#9E9B94", fontSize: 13 }}>Loading…</div>;

  const sectionStyle: React.CSSProperties = {
    background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12,
    padding: "20px 22px", marginBottom: 16,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 12, fontWeight: 700, color: "#6B6860",
    textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6, display: "block",
  };
  const renderSection = (
    title: string,
    type: "commission" | "hourly",
    setType: (t: "commission" | "hourly") => void,
    rate: string,
    setRate: (s: string) => void,
  ) => (
    <div style={sectionStyle}>
      <h2 style={{ fontSize: 15, fontWeight: 800, color: "#1A1917", marginBottom: 12 }}>{title}</h2>
      <label style={labelStyle}>Type</label>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {(["hourly", "commission"] as const).map(opt => (
          <button key={opt} type="button" onClick={() => {
            // When switching type, normalize the rate field to the
            // new format's typical default so the input doesn't stay
            // at e.g. "0.35" when switching to hourly mode.
            if (opt !== type) {
              setRate(opt === "hourly" ? "20" : "35");
            }
            setType(opt);
          }}
          style={{
            flex: 1, padding: "9px 12px", borderRadius: 8, cursor: "pointer", textAlign: "center",
            border: `1.5px solid ${type === opt ? "var(--brand, #00C9A0)" : "#E5E2DC"}`,
            background: type === opt ? "rgba(0,201,160,0.10)" : "#FFFFFF",
            color: type === opt ? "var(--brand, #00C9A0)" : "#1A1917",
            fontSize: 13, fontWeight: 700, fontFamily: "'Plus Jakarta Sans', sans-serif",
          }}>
            {opt === "hourly" ? "Hourly" : "Commission %"}
          </button>
        ))}
      </div>
      <label style={labelStyle}>{type === "hourly" ? "Rate ($/hour)" : "Rate (% of revenue share)"}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {type === "hourly" && <span style={{ fontSize: 14, fontWeight: 600, color: "#1A1917" }}>$</span>}
        <input type="number" step={type === "hourly" ? 0.25 : 1} min={0} max={type === "commission" ? 100 : undefined}
          value={rate} onChange={e => setRate(e.target.value)}
          style={{ padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 14, fontFamily: "'Plus Jakarta Sans', sans-serif", color: "#1A1917", width: 120 }} />
        <span style={{ fontSize: 13, color: "#6B7280" }}>{type === "hourly" ? "/hr" : "%"}</span>
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: "#9E9B94" }}>
        {type === "hourly"
          ? "Tech earns this rate × estimated hours per visit."
          : "Tech earns this percentage of their share of the job's billable revenue (jobTotal ÷ techs on job)."}
      </div>
    </div>
  );

  return (
    <div style={{ padding: "20px 22px 60px", maxWidth: 720 }}>
      <h1 style={{ fontSize: 18, fontWeight: 800, color: "#1A1917", marginBottom: 4 }}>Pay configuration</h1>
      <p style={{ fontSize: 12, color: "#6B6860", marginBottom: 20, lineHeight: 1.5 }}>
        How this employee gets paid on residential vs commercial jobs. Each cell is independent — a tech can be on commission for residential and hourly for commercial. Rates apply per-tech to the job's commercial flag (driven by the client's <code>client_type</code>).
      </p>
      {renderSection("Residential pay", resType, setResType, resRate, setResRate)}
      {renderSection("Commercial pay", comType, setComType, comRate, setComRate)}
      {error && (
        <div style={{ background: "#FEF2F2", border: "1px solid #FCA5A5", color: "#991B1B", padding: "10px 14px", borderRadius: 8, fontSize: 12, marginBottom: 14 }}>
          {error}
        </div>
      )}
      <button onClick={save} disabled={saving}
        style={{ padding: "10px 22px", background: "var(--brand, #00C9A0)", color: "#FFFFFF", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 13, fontFamily: "'Plus Jakarta Sans', sans-serif", cursor: saving ? "wait" : "pointer" }}>
        {saving ? "Saving…" : "Save pay configuration"}
      </button>
      {toast && (
        <div style={{ position: "fixed", bottom: 24, right: 24, background: "#1A1917", color: "#FFFFFF", padding: "12px 20px", borderRadius: 10, fontSize: 13, fontWeight: 600, zIndex: 2000, boxShadow: "0 8px 24px rgba(0,0,0,0.2)" }}>
          {toast}
        </div>
      )}
    </div>
  );
}
