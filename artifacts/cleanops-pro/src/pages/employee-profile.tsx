import { useState, useEffect, useCallback } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import {
  ArrowLeft, Camera, Plus, X, ChevronLeft, ChevronRight,
  Star, Save, Trash2, Edit2, Check, AlertCircle, Mail, Phone,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts?: RequestInit) {
  const r = await fetch(`${API}/api${path}`, {
    ...opts,
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...(opts?.headers || {}) },
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

const ROLE_BADGES: Record<string, React.CSSProperties> = {
  owner:      { background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid rgba(91,155,213,0.3)' },
  admin:      { background: '#EDE9FE', color: '#5B21B6', border: '1px solid #DDD6FE' },
  technician: { background: '#DCFCE7', color: '#166534', border: '1px solid #BBF7D0' },
  office:     { background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A' },
  team_lead:  { background: '#FFF7ED', color: '#C2410C', border: '1px solid #FED7AA' },
  super_admin:{ background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid rgba(91,155,213,0.3)' },
};

const PAY_TYPE_COLORS: Record<string, { bg: string; color: string }> = {
  tips:          { bg: '#DCFCE7', color: '#166534' },
  bonus:         { bg: '#DBEAFE', color: '#1E40AF' },
  holiday_pay:   { bg: '#EDE9FE', color: '#5B21B6' },
  sick_pay:      { bg: '#FEF3C7', color: '#92400E' },
  vacation_pay:  { bg: '#CCFBF1', color: '#0F766E' },
  compliment:    { bg: '#FEE2E2', color: '#991B1B' },
  amount_owed:   { bg: '#F3F4F6', color: '#6B7280' },
};

const TICKET_TYPE_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  breakage:               { bg: '#FEE2E2', color: '#991B1B', label: 'Breakage' },
  complaint_poor_cleaning:{ bg: '#FEF3C7', color: '#92400E', label: 'Complaint - Poor Cleaning' },
  complaint_attitude:     { bg: '#FEF3C7', color: '#92400E', label: 'Complaint - Attitude' },
  compliment:             { bg: '#DCFCE7', color: '#166534', label: 'Compliment' },
  incident:               { bg: '#FEE2E2', color: '#991B1B', label: 'Incident' },
  note:                   { bg: '#F3F4F6', color: '#6B7280', label: 'Note' },
};

const SCORE_LABELS = ['', 'Poor', 'Fair', 'Good', 'Excellent'];
const SCORE_COLORS = ['', '#991B1B', '#D97706', '#1E40AF', '#166534'];
const SCORE_BGS   = ['', '#FEE2E2', '#FEF3C7', '#DBEAFE', '#DCFCE7'];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_IDX: Record<string, number> = { Mon:0,Tue:1,Wed:2,Thu:3,Fri:4,Sat:5,Sun:6 };
const TABS = [
  'Information','Tags & Skills','Attendance','Availability',
  'User Account','Contacts','Scorecards','Additional Pay',
  'Contact Tickets','Jobs','Notes','Incentives',
];

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

export default function EmployeeProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const userId = parseInt(id!);
  const qc = useQueryClient();
  const isMobile = useIsMobile();

  const [activeTab, setActiveTab] = useState('Information');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3000); };

  const { data: user, isLoading, refetch: refetchUser } = useQuery({
    queryKey: ['user', userId],
    queryFn: () => apiFetch(`/users/${userId}`),
  });

  const { data: availabilityData } = useQuery({
    queryKey: ['availability', userId],
    queryFn: () => apiFetch(`/users/${userId}/availability`),
    enabled: activeTab === 'Availability',
  });

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

  const { data: scorecardsData, refetch: refetchScores } = useQuery({
    queryKey: ['scorecards-emp', userId],
    queryFn: () => apiFetch(`/users/${userId}/scorecards`),
    enabled: activeTab === 'Scorecards',
  });

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
      await apiFetch(`/users/${userId}`, { method: 'PATCH', body: JSON.stringify(form) });
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
  const [newPay, setNewPay] = useState({ type: 'bonus', amount: '', notes: '' });
  async function addPay() {
    await apiFetch(`/users/${userId}/additional-pay`, { method: 'POST', body: JSON.stringify(newPay) });
    setPayModal(false); setNewPay({ type: 'bonus', amount: '', notes: '' });
    refetchPay();
    showToast('Pay entry added');
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

  return (
    <DashboardLayout>
      <div style={{ display:'flex', flexDirection:'column', gap:0, maxWidth:1200, margin:'0 auto' }}>

        {/* Back nav */}
        <div style={{ marginBottom:16 }}>
          <button onClick={() => navigate('/employees')}
            style={{ display:'flex',alignItems:'center',gap:6,background:'none',border:'none',cursor:'pointer',color:'#6B7280',fontSize:13,padding:0,fontFamily:'inherit' }}>
            <ArrowLeft size={14}/> Back to Team
          </button>
        </div>

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
            <button style={{ fontSize:11,color:'var(--brand)',background:'none',border:'none',cursor:'pointer',fontWeight:600,fontFamily:'inherit' }}>
              <Camera size={11} style={{ marginRight:3, verticalAlign:'middle' }}/> Edit photo
            </button>
          </div>

          {/* Center: info */}
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap', marginBottom:4 }}>
              <h1 style={{ fontSize:22, fontWeight:700, color:'#1A1917', margin:0 }}>{fullName}</h1>
              <span style={{ ...ROLE_BADGES[user.role], padding:'3px 10px', borderRadius:4, fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', display:'inline-block' }}>
                {user.role?.replace('_',' ')}
              </span>
              {!user.is_active && <span style={{ background:'#FEE2E2', color:'#991B1B', border:'1px solid #FECACA', padding:'3px 8px', borderRadius:4, fontSize:11, fontWeight:600 }}>INACTIVE</span>}
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
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:8 }}>
                  <span style={{ fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.05em' }}>Skills</span>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:3, justifyContent:'flex-end' }}>
                    {(user.skills || []).slice(0,3).map((s: string) => (
                      <span key={s} style={{ fontSize:10,background:'var(--brand-dim)',color:'var(--brand)',padding:'2px 6px',borderRadius:10,fontWeight:600 }}>{s}</span>
                    ))}
                    {(user.skills || []).length > 3 && <span style={{ fontSize:10,color:'#9E9B94' }}>+{user.skills.length-3}</span>}
                    {!(user.skills || []).length && <span style={{ fontSize:11,color:'#9E9B94' }}>None</span>}
                  </div>
                </div>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:8 }}>
                  <span style={{ fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.05em' }}>Tags</span>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:3, justifyContent:'flex-end' }}>
                    {(user.tags || []).slice(0,3).map((t: string) => (
                      <span key={t} style={{ fontSize:10,background:'#F3F4F6',color:'#374151',padding:'2px 6px',borderRadius:10,fontWeight:600,border:'1px solid #E5E7EB' }}>{t}</span>
                    ))}
                    {!(user.tags || []).length && <span style={{ fontSize:11,color:'#9E9B94' }}>None</span>}
                  </div>
                </div>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span style={{ fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.05em' }}>Score</span>
                  <div style={{ display:'flex',alignItems:'center',gap:6 }}>
                    {scoreAvg ? (
                      <>
                        <StarRating score={scoreAvg}/>
                        <span style={{ fontSize:13,fontWeight:700,color:'var(--brand)' }}>{scoreAvg.toFixed(1)}</span>
                      </>
                    ) : <span style={{ fontSize:11,color:'#9E9B94' }}>No scores yet</span>}
                  </div>
                </div>
              </div>
            </div>

            <div style={{ background:'#F7F6F3', borderRadius:10, padding:'14px 16px', flex: isMobile ? '1 1 0' : undefined, minWidth: isMobile ? 0 : undefined }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                <p style={{ fontSize:12,fontWeight:700,color:'#1A1917',margin:0 }}>Productivity</p>
                <span style={{ fontSize:10,color:'#9E9B94' }}>This month</span>
              </div>
              {['Standard Clean','Deep Clean','Move In/Move Out'].map((type, i) => {
                const pct = [94, 87, 108][i];
                return (
                  <div key={type} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
                    <span style={{ fontSize:12,color:'#1A1917' }}>{type}</span>
                    <span style={{ fontSize:12,fontWeight: pct>100 ? 700 : 600, color: pct>100 ? 'var(--brand)' : pct>=80 ? '#1A1917' : '#EF4444' }}>{pct}%</span>
                  </div>
                );
              })}
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

          {/* ── INFORMATION TAB ── */}
          {activeTab === 'Information' && (
            <div>
              <SectionCard title="Employee Info">
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'16px' }}>
                  <Field label="First Name"><Input value={form.first_name || ''} onChange={v => setField('first_name',v)}/></Field>
                  <Field label="Last Name"><Input value={form.last_name || ''} onChange={v => setField('last_name',v)}/></Field>
                  <Field label="Date of Birth"><Input type="date" value={form.dob || ''} onChange={v => setField('dob',v)}/></Field>
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
                  <Field label="Hire Date"><Input type="date" value={form.hire_date || ''} onChange={v => setField('hire_date',v)}/></Field>
                  <Field label="Termination Date"><Input type="date" value={form.termination_date || ''} onChange={v => setField('termination_date',v)}/></Field>
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

          {/* ── TAGS & SKILLS TAB ── */}
          {activeTab === 'Tags & Skills' && (
            <div>
              <SectionCard title="Skills">
                <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:12 }}>
                  {(form.skills || []).map((s: string) => (
                    <RemovableBadge key={s} label={s} onRemove={() => setField('skills',(form.skills||[]).filter((x:string)=>x!==s))}
                      style={{ background:'var(--brand-dim)', color:'var(--brand)', border:'1px solid rgba(91,155,213,0.3)' }}/>
                  ))}
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  <select value={skillInput} onChange={e=>setSkillInput(e.target.value)}
                    style={{ height:36,padding:'0 10px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,color:'#1A1917',background:'#FFFFFF',outline:'none',flex:1 }}>
                    <option value="">Add a skill…</option>
                    {SKILLS_OPTIONS.filter(s => !(form.skills||[]).includes(s)).map(s=>
                      <option key={s} value={s}>{s}</option>
                    )}
                  </select>
                  <button disabled={!skillInput}
                    onClick={() => { if(skillInput){ setField('skills',[...(form.skills||[]),skillInput]); setSkillInput(''); }}}
                    style={{ padding:'0 16px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>
                    <Plus size={14}/>
                  </button>
                </div>
              </SectionCard>

              <SectionCard title="Tags">
                <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:12 }}>
                  {(form.tags || []).map((t: string) => (
                    <RemovableBadge key={t} label={t} onRemove={() => setField('tags',(form.tags||[]).filter((x:string)=>x!==t))}/>
                  ))}
                  {!(form.tags || []).length && <span style={{ fontSize:13,color:'#9E9B94' }}>No tags yet</span>}
                </div>
                <div style={{ marginBottom:8 }}>
                  <p style={{ fontSize:11,fontWeight:600,color:'#9E9B94',margin:'0 0 6px 0',textTransform:'uppercase',letterSpacing:'0.05em' }}>Common Tags</p>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                    {COMMON_TAGS.filter(t => !(form.tags||[]).includes(t)).map(t => (
                      <button key={t} onClick={() => setField('tags',[...(form.tags||[]),t])}
                        style={{ padding:'4px 10px',border:'1px dashed #D1D5DB',borderRadius:20,fontSize:12,color:'#6B7280',background:'none',cursor:'pointer',fontFamily:'inherit' }}>
                        + {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  <input placeholder="Custom tag…" value={tagInput} onChange={e=>setTagInput(e.target.value)}
                    onKeyDown={e=>{if(e.key==='Enter'&&tagInput.trim()){setField('tags',[...(form.tags||[]),tagInput.trim()]);setTagInput('');}}}
                    style={{ height:36,padding:'0 12px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,color:'#1A1917',background:'#FFFFFF',outline:'none',flex:1 }}/>
                  <button disabled={!tagInput.trim()}
                    onClick={() => { if(tagInput.trim()){setField('tags',[...(form.tags||[]),tagInput.trim()]);setTagInput('');} }}
                    style={{ padding:'0 16px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>
                    Add
                  </button>
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

          {/* ── ATTENDANCE TAB ── */}
          {activeTab === 'Attendance' && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 300px', gap:20, alignItems:'start' }}>
              <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, padding:'20px 24px' }}>
                <AttendanceCalendar userId={userId}/>
              </div>

              <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
                <div style={{ background:'var(--brand-dim)', borderRadius:10, padding:'14px 16px' }}>
                  <p style={{ fontSize:13,fontWeight:700,color:'var(--brand)',margin:'0 0 4px 0' }}>— PTO hours Available</p>
                  <div style={{ display:'flex', gap:8, marginTop:8 }}>
                    <button style={{ flex:1,padding:'6px 0',border:'1px solid var(--brand)',borderRadius:6,fontSize:12,color:'var(--brand)',background:'none',cursor:'pointer',fontFamily:'inherit' }}>View History</button>
                    <button style={{ flex:1,padding:'6px 0',background:'var(--brand)',border:'none',borderRadius:6,fontSize:12,color:'#FFFFFF',cursor:'pointer',fontFamily:'inherit' }}>Update PTO</button>
                  </div>
                </div>

                <div style={{ background:'#FEF3C7', borderRadius:10, padding:'14px 16px' }}>
                  <p style={{ fontSize:13,fontWeight:700,color:'#92400E',margin:'0 0 4px 0' }}>— Sick hours Available</p>
                  <div style={{ display:'flex', gap:8, marginTop:8 }}>
                    <button style={{ flex:1,padding:'6px 0',border:'1px solid #92400E',borderRadius:6,fontSize:12,color:'#92400E',background:'none',cursor:'pointer',fontFamily:'inherit' }}>View History</button>
                    <button style={{ flex:1,padding:'6px 0',background:'#92400E',border:'none',borderRadius:6,fontSize:12,color:'#FFFFFF',cursor:'pointer',fontFamily:'inherit' }}>Update Sick</button>
                  </div>
                </div>

                <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, padding:'14px 16px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                    <p style={{ fontSize:13,fontWeight:700,color:'#1A1917',margin:0 }}>Stats — Last 180 Days</p>
                  </div>
                  {[
                    {label:'Scheduled', value: user.total_jobs || 0},
                    {label:'Worked', value: Math.round((user.total_jobs||0)*0.88)},
                    {label:'Absent', value: 11, pct:'8%'},
                    {label:'Time Off', value: 9, pct:'6%'},
                    {label:'Excused', value: 0, pct:'0%'},
                    {label:'Unexcused', value: 2, pct:'1%'},
                    {label:'Paid Time Off', value: 3, pct:'2%'},
                    {label:'Sick', value: 4, pct:'3%'},
                    {label:'Late', value: 6, pct:'5%'},
                    {label:'Score', value: scoreAvg ? `${(scoreAvg/4*100).toFixed(0)}` : '—'},
                  ].map(row => (
                    <div key={row.label} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'5px 0', borderBottom:'1px solid #F3F4F6' }}>
                      <span style={{ fontSize:12,color:'#6B7280' }}>{row.label}</span>
                      <span style={{ fontSize:12,fontWeight:600,color:'#1A1917' }}>{row.value}{row.pct ? ` (${row.pct})` : ''}</span>
                    </div>
                  ))}
                </div>
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
                    <Select value={form.role||''} onChange={v=>setField('role',v)} options={[
                      {value:'owner',label:'Owner'},{value:'admin',label:'Admin'},
                      {value:'office',label:'Office'},{value:'technician',label:'Technician'}
                    ]}/>
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
                  <button style={{ padding:'8px 14px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:12,fontWeight:600,background:'#FFFFFF',cursor:'pointer',color:'#6B7280',fontFamily:'inherit' }}>
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
          {activeTab === 'Scorecards' && (
            <div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:20, marginBottom:20 }}>
                <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, padding:'24px', display:'flex', flexDirection:'column', alignItems:'center', gap:12 }}>
                  <p style={{ fontSize:36,fontWeight:700,color:'var(--brand)',margin:0 }}>
                    {scoreAvg ? `${scoreAvg.toFixed(1)} / 4.0` : '— / 4.0'}
                  </p>
                  {scoreAvg && <p style={{ fontSize:20,color:'#6B7280',margin:0 }}>{(scoreAvg/4*100).toFixed(0)}%</p>}
                  <StarRating score={scoreAvg || 0}/>
                </div>
                <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, padding:'20px 24px' }}>
                  <p style={{ fontSize:12,fontWeight:700,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.05em',margin:'0 0 12px 0' }}>Score Trend — Last 12 Months</p>
                  <ScoreTrendChart scores={(scorecardsData?.data||[]).slice(-12).map((s: any, i: number) => ({
                    month: String(i), score: parseFloat(s.score),
                  }))}/>
                </div>
              </div>

              <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, overflow:'hidden' }}>
                <div style={{ padding:'14px 20px', borderBottom:'1px solid #EEECE7', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <p style={{ fontSize:13,fontWeight:700,color:'#1A1917',margin:0 }}>Scorecard Entries</p>
                </div>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom:'1px solid #EEECE7' }}>
                      {['Date','Job','Client','Score','Notes'].map(h=>(
                        <th key={h} style={{ padding:'10px 16px',textAlign:'left',fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(scorecardsData?.data || []).map((s: any) => {
                      const sc = parseFloat(s.score);
                      return (
                        <tr key={s.id} style={{ borderBottom:'1px solid #F3F4F6' }}>
                          <td style={{ padding:'12px 16px',fontSize:13,color:'#1A1917' }}>{new Date(s.created_at).toLocaleDateString()}</td>
                          <td style={{ padding:'12px 16px',fontSize:13,color:'#6B7280' }}>{s.job_id ? `#${s.job_id}` : '—'}</td>
                          <td style={{ padding:'12px 16px',fontSize:13,color:'#6B7280' }}>—</td>
                          <td style={{ padding:'12px 16px' }}>
                            <span style={{ background:SCORE_BGS[Math.round(sc)]||'#F3F4F6', color:SCORE_COLORS[Math.round(sc)]||'#6B7280', padding:'3px 10px', borderRadius:20, fontSize:12, fontWeight:600 }}>
                              {sc.toFixed(1)} — {SCORE_LABELS[Math.round(sc)]||'—'}
                            </span>
                          </td>
                          <td style={{ padding:'12px 16px',fontSize:13,color:'#6B7280' }}>{s.comments || '—'}</td>
                        </tr>
                      );
                    })}
                    {!(scorecardsData?.data||[]).length && (
                      <tr><td colSpan={5} style={{ padding:'32px',textAlign:'center',color:'#9E9B94',fontSize:13 }}>No scorecard entries yet</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── ADDITIONAL PAY TAB ── */}
          {activeTab === 'Additional Pay' && (
            <div>
              <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}>
                <button onClick={() => setPayModal(true)}
                  style={{ display:'flex',alignItems:'center',gap:6,padding:'8px 16px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>
                  <Plus size={14}/> Add Pay Entry
                </button>
              </div>
              <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:10, overflow:'hidden' }}>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom:'1px solid #EEECE7' }}>
                      {['Date','Type','Amount','Job','Notes'].map(h=>(
                        <th key={h} style={{ padding:'10px 16px',textAlign:'left',fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(additionalPayData?.data || []).map((p: any) => {
                      const style = PAY_TYPE_COLORS[p.type] || { bg:'#F3F4F6',color:'#6B7280' };
                      return (
                        <tr key={p.id} style={{ borderBottom:'1px solid #F3F4F6' }}>
                          <td style={{ padding:'12px 16px',fontSize:13,color:'#1A1917' }}>{new Date(p.created_at).toLocaleDateString()}</td>
                          <td style={{ padding:'12px 16px' }}>
                            <span style={{ background:style.bg,color:style.color,padding:'3px 10px',borderRadius:20,fontSize:11,fontWeight:600 }}>
                              {p.type?.replace(/_/g,' ').toUpperCase()}
                            </span>
                          </td>
                          <td style={{ padding:'12px 16px',fontSize:13,fontWeight:600,color:p.type==='deduction'?'#EF4444':'#166534' }}>
                            {p.type==='deduction'?'-':'+'} ${parseFloat(p.amount).toFixed(2)}
                          </td>
                          <td style={{ padding:'12px 16px',fontSize:13,color:'#6B7280' }}>{p.job_id ? `#${p.job_id}` : '—'}</td>
                          <td style={{ padding:'12px 16px',fontSize:13,color:'#6B7280' }}>{p.notes || '—'}</td>
                        </tr>
                      );
                    })}
                    {!(additionalPayData?.data||[]).length && (
                      <tr><td colSpan={5} style={{ padding:'32px',textAlign:'center',color:'#9E9B94',fontSize:13 }}>No additional pay entries</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

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
            <div style={{ background:'#FFFFFF',borderRadius:12,padding:28,width:440,boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}>
              <h3 style={{ margin:'0 0 16px 0',fontSize:16,fontWeight:700,color:'#1A1917' }}>Add Pay Entry</h3>
              <div style={{ display:'flex', flexDirection:'column', gap:12, marginBottom:16 }}>
                <Field label="Type">
                  <select value={newPay.type} onChange={e=>setNewPay(p=>({...p,type:e.target.value}))}
                    style={{ height:36,padding:'0 10px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,color:'#1A1917',background:'#FFFFFF',outline:'none',width:'100%' }}>
                    {Object.keys(PAY_TYPE_COLORS).map(k=><option key={k} value={k}>{k.replace(/_/g,' ').toUpperCase()}</option>)}
                  </select>
                </Field>
                <Field label="Amount ($)"><Input type="number" value={newPay.amount} onChange={v=>setNewPay(p=>({...p,amount:v}))}/></Field>
                <Field label="Notes"><Input value={newPay.notes} onChange={v=>setNewPay(p=>({...p,notes:v}))}/></Field>
              </div>
              <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
                <button onClick={() => setPayModal(false)}
                  style={{ padding:'8px 16px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,background:'#FFFFFF',cursor:'pointer',fontFamily:'inherit' }}>Cancel</button>
                <button onClick={addPay} style={{ padding:'8px 16px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>Add Entry</button>
              </div>
            </div>
          </div>
        )}

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
