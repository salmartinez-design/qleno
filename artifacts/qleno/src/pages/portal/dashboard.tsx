import { useState, useEffect, useRef } from "react";
import { useParams, useLocation } from "wouter";
import {
  Star, Calendar, Clock, ChevronRight, LogOut, Zap, DollarSign, Camera,
  FileText, PauseCircle, PlayCircle, Plus, Users, ShieldAlert, Download,
  AlertTriangle, CheckCircle2,
} from "lucide-react";

// [portal-service-account 2026-08-20] The customer's whole account, not a
// landing page with three cards on it.
//
// This screen used to be Home / History / Tip. Everything else a residential
// customer might want to know — when we are coming, what they owe, what they
// signed, how much pause time their agreement gives them — was a phone call to
// the office. The routes for all of it now exist (routes/portal.ts), and this
// is the other side of that glass.
//
// Two things to preserve when adding to this file:
//
//  1. EVERY screen here reads from an /api/portal/* route that scopes to the
//     session's own client. Never reach for a staff endpoint with the portal
//     token: it is refused by design (docs/CUSTOMER_PORTAL_DESIGN.md §3), and
//     wanting to means the portal is missing a route.
//  2. Capabilities decide what renders, not the component. `caps` comes from
//     GET /me and already accounts for a read-only support session, so a button
//     hidden here is a button the server would refuse anyway. Gate on `caps`,
//     never on "is this commercial" or "is this impersonated" re-derived here.

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

function portalHeaders(slug: string) {
  const token = localStorage.getItem(`portal_token_${slug}`);
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

const SERVICE_LABELS: Record<string, string> = {
  standard_clean: 'Standard Clean',
  deep_clean: 'Deep Clean',
  move_out: 'Move Out Clean',
  move_in: 'Move In Clean',
  recurring: 'Recurring Clean',
  post_construction: 'Post-Construction',
  office_cleaning: 'Office Cleaning',
  common_areas: 'Common Areas',
  retail_store: 'Retail Store',
  medical_office: 'Medical Office',
};

const CARD: React.CSSProperties = {
  background: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: 14, padding: '20px 22px',
};
const EYEBROW: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em',
  color: '#9E9B94', margin: '0 0 10px 0',
};
const INPUT: React.CSSProperties = {
  width: '100%', height: 42, padding: '0 12px', border: '1px solid #E5E2DC',
  borderRadius: 9, fontSize: 14, color: '#1A1917', outline: 'none',
  fontFamily: 'inherit', background: '#FFFFFF', boxSizing: 'border-box',
};
const TEXTAREA: React.CSSProperties = {
  ...INPUT, height: 80, padding: '10px 12px', resize: 'vertical',
};

const usd = (n: number) =>
  `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A YYYY-MM-DD from the API is a calendar day, not an instant. Parse it at
 *  local midnight or every date west of UTC renders one day early. */
const dayOf = (ymd: string) => new Date(`${ymd}T00:00:00`);

const longDate = (ymd?: string | null) =>
  ymd ? dayOf(ymd).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : '';
const shortDate = (ymd?: string | null) =>
  ymd ? dayOf(ymd).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

function InitialAvatar({ name }: { name: string }) {
  const initials = name.split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase();
  return (
    <div style={{ width:36, height:36, borderRadius:18, background:'var(--brand-soft)', color:'var(--brand)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:700, flexShrink:0 }}>
      {initials}
    </div>
  );
}

function StarRatingInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [hover, setHover] = useState(0);
  return (
    <div style={{ display:'flex', gap:4 }}>
      {[1,2,3,4].map(i => (
        <button key={i} type="button"
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover(0)}
          onClick={() => onChange(i)}
          style={{ background:'none', border:'none', cursor:'pointer', padding:2 }}>
          <svg width={24} height={24} viewBox="0 0 24 24"
            fill={(hover || value) >= i ? '#F59E0B' : 'none'}
            stroke={`${(hover || value) >= i ? '#F59E0B' : '#E5E2DC'}`} strokeWidth={1.5}>
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </button>
      ))}
    </div>
  );
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div style={{ ...CARD, padding:'36px 22px', textAlign:'center' }}>
      <div style={{ marginBottom:10, display:'flex', justifyContent:'center' }}>{icon}</div>
      <p style={{ fontSize:13, color:'#9E9B94', margin:0 }}>{text}</p>
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: 'good' | 'warn' | 'bad' | 'quiet' }) {
  const tones = {
    good:  { bg:'#E6F6F1', fg:'#0F7A63' },
    warn:  { bg:'#FDF3E4', fg:'#8A5A00' },
    bad:   { bg:'#FCEBEA', fg:'#B3261E' },
    quiet: { bg:'#F0EEE9', fg:'#6B6860' },
  }[tone];
  return (
    <span style={{ fontSize:11, fontWeight:700, padding:'3px 9px', borderRadius:10, background:tones.bg, color:tones.fg, whiteSpace:'nowrap' }}>
      {label}
    </span>
  );
}

type TabKey = 'home' | 'schedule' | 'billing' | 'plan' | 'requests' | 'refer' | 'tip';
const TABS: Array<[TabKey, string]> = [
  ['home', 'Home'],
  ['schedule', 'Schedule'],
  ['billing', 'Billing'],
  ['plan', 'My Plan'],
  ['requests', 'Request Service'],
  ['refer', 'Refer a Friend'],
  ['tip', 'Tip My Cleaner'],
];

export default function PortalDashboardPage() {
  const { slug } = useParams<{ slug: string }>();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<TabKey>('home');

  const [client, setClient] = useState<any>(null);
  const [company, setCompany] = useState<any>(null);
  // `upcoming` already includes anything scheduled for today: the route filters
  // on scheduled_date >= its own today. There is no separate today bucket.
  const [jobs, setJobs] = useState<{ upcoming: any[]; past: any[] }>({ upcoming: [], past: [] });
  const [loading, setLoading] = useState(true);

  const [rating, setRating] = useState<Record<number, { score: number; comment: string }>>({});
  const [ratingSubmitted, setRatingSubmitted] = useState<Set<number>>(new Set());

  const [tipJob, setTipJob] = useState<any>(null);
  const [tipAmount, setTipAmount] = useState(0);
  const [customTip, setCustomTip] = useState('');
  const [tipSent, setTipSent] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Lazily loaded, one fetch per section the customer actually opens.
  const [plan, setPlan] = useState<any>(null);
  const [billing, setBilling] = useState<{ invoices: any[]; outstanding: number } | null>(null);
  const [requests, setRequests] = useState<any[] | null>(null);

  // Pause flow
  const [pauseUntil, setPauseUntil] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [previewError, setPreviewError] = useState('');
  const [holdBusy, setHoldBusy] = useState(false);
  const [holdResult, setHoldResult] = useState('');

  // Request service form
  const [reqWhat, setReqWhat] = useState('');
  const [reqWhen, setReqWhen] = useState('');
  const [reqNotes, setReqNotes] = useState('');
  const [reqBusy, setReqBusy] = useState(false);
  const [reqResult, setReqResult] = useState('');
  const [reqError, setReqError] = useState('');

  // Referral form
  const [refName, setRefName] = useState('');
  const [refPhone, setRefPhone] = useState('');
  const [refEmail, setRefEmail] = useState('');
  const [refZip, setRefZip] = useState('');
  const [refNote, setRefNote] = useState('');
  const [refType, setRefType] = useState<'residential' | 'commercial'>('residential');
  const [refBusy, setRefBusy] = useState(false);
  const [refResult, setRefResult] = useState('');
  const [refError, setRefError] = useState('');

  const token = localStorage.getItem(`portal_token_${slug}`);
  if (!token) { navigate(`/portal/${slug}/login`); }

  useEffect(() => {
    const headers = portalHeaders(slug!);
    Promise.all([
      fetch(`${API}/api/portal/company/${slug}`).then(r => r.json()),
      fetch(`${API}/api/portal/me`, { headers }).then(r => r.json()),
      fetch(`${API}/api/portal/jobs`, { headers }).then(r => r.json()),
    ])
      .then(([comp, cl, j]) => {
        setCompany(comp);
        setClient(cl);
        setJobs({ upcoming: j.upcoming || [], past: j.past || [] });
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [slug]);

  // Each section loads once, the first time it is opened. Loading all of it up
  // front would put an invoice query and a schedule query in front of a
  // customer who only wanted to know when we are coming next.
  useEffect(() => {
    const headers = portalHeaders(slug!);
    if ((activeTab === 'plan' || activeTab === 'home') && plan == null) {
      fetch(`${API}/api/portal/plan`, { headers }).then(r => r.json()).then(setPlan).catch(console.error);
    }
    if (activeTab === 'billing' && billing == null) {
      fetch(`${API}/api/portal/invoices`, { headers }).then(r => r.json())
        .then(d => setBilling({ invoices: d.invoices || [], outstanding: d.outstanding || 0 }))
        .catch(console.error);
    }
    if (activeTab === 'requests' && requests == null) {
      fetch(`${API}/api/portal/service-requests`, { headers }).then(r => r.json())
        .then(d => setRequests(Array.isArray(d) ? d : []))
        .catch(console.error);
    }
  }, [activeTab, slug, plan, billing, requests]);

  const reloadPlan = () =>
    fetch(`${API}/api/portal/plan`, { headers: portalHeaders(slug!) }).then(r => r.json()).then(setPlan).catch(console.error);

  async function submitRating(jobId: number) {
    const r = rating[jobId];
    if (!r?.score) return;
    await fetch(`${API}/api/portal/rate`, {
      method: 'POST',
      headers: portalHeaders(slug!),
      body: JSON.stringify({ job_id: jobId, score: r.score, comment: r.comment || '' }),
    });
    setRatingSubmitted(prev => new Set([...prev, jobId]));
  }

  async function handlePhotoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { setUploadError('Please select an image file.'); return; }
    if (file.size > 5 * 1024 * 1024) { setUploadError('Image must be under 5MB.'); return; }
    setUploadError('');
    setUploading(true);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result as string;
      try {
        // Resize to max 400px using canvas
        const img = new Image();
        img.onload = async () => {
          const canvas = document.createElement('canvas');
          const MAX = 400;
          const ratio = Math.min(MAX / img.width, MAX / img.height, 1);
          canvas.width = Math.round(img.width * ratio);
          canvas.height = Math.round(img.height * ratio);
          canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
          const compressed = canvas.toDataURL('image/jpeg', 0.8);
          const resp = await fetch(`${API}/api/portal/profile-picture`, {
            method: 'POST',
            headers: portalHeaders(slug!),
            body: JSON.stringify({ image_data: compressed }),
          });
          if (resp.ok) {
            setClient((prev: any) => ({ ...prev, profile_picture_url: compressed }));
          } else {
            const err = await resp.json();
            setUploadError(err.error || 'Upload failed');
          }
          setUploading(false);
        };
        img.src = dataUrl;
      } catch { setUploadError('Upload failed'); setUploading(false); }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  async function sendTip() {
    if (!tipJob) return;
    const amount = customTip ? parseFloat(customTip) : tipAmount;
    if (!amount) return;
    await fetch(`${API}/api/portal/tip`, {
      method: 'POST',
      headers: portalHeaders(slug!),
      body: JSON.stringify({ job_id: tipJob.id, amount }),
    });
    setTipSent(true);
  }

  /** The PDF route needs the portal token, so it cannot be a plain link. Fetch
   *  it, then hand the browser a blob it can open in its own viewer. */
  async function openInvoicePdf(id: number) {
    try {
      const resp = await fetch(`${API}/api/portal/invoices/${id}/pdf`, {
        headers: { Authorization: `Bearer ${localStorage.getItem(`portal_token_${slug}`)}` },
      });
      if (!resp.ok) return;
      const blob = await resp.blob();
      window.open(URL.createObjectURL(blob), '_blank');
    } catch (e) { console.error(e); }
  }

  async function checkPause(until: string) {
    setPauseUntil(until);
    setPreview(null);
    setPreviewError('');
    setHoldResult('');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return;
    try {
      const resp = await fetch(`${API}/api/portal/hold/preview?until=${until}`, { headers: portalHeaders(slug!) });
      const data = await resp.json();
      if (!resp.ok) { setPreviewError(data.message || 'We could not check those dates'); return; }
      setPreview(data);
    } catch { setPreviewError('We could not check those dates'); }
  }

  async function confirmPause() {
    if (!pauseUntil) return;
    setHoldBusy(true);
    try {
      const resp = await fetch(`${API}/api/portal/hold`, {
        method: 'POST', headers: portalHeaders(slug!),
        body: JSON.stringify({ until: pauseUntil }),
      });
      const data = await resp.json();
      if (!resp.ok && resp.status !== 202) { setPreviewError(data.message || 'We could not pause your service'); return; }
      setHoldResult(data.message || 'Done');
      setPreview(null);
      setPauseUntil('');
      await reloadPlan();
      if (data.needs_office) setRequests(null); // it landed in the request queue
    } catch { setPreviewError('We could not pause your service'); }
    finally { setHoldBusy(false); }
  }

  async function resumeService() {
    setHoldBusy(true);
    try {
      const resp = await fetch(`${API}/api/portal/hold/resume`, { method: 'POST', headers: portalHeaders(slug!) });
      const data = await resp.json();
      setHoldResult(data.message || 'Your service is running again.');
      await reloadPlan();
    } catch { setPreviewError('We could not restart your service'); }
    finally { setHoldBusy(false); }
  }

  async function sendRequest() {
    setReqBusy(true); setReqError(''); setReqResult('');
    try {
      const resp = await fetch(`${API}/api/portal/service-requests`, {
        method: 'POST', headers: portalHeaders(slug!),
        body: JSON.stringify({ service_description: reqWhat, preferred_date: reqWhen || undefined, notes: reqNotes || undefined }),
      });
      const data = await resp.json();
      if (!resp.ok) { setReqError(data.message || 'We could not send your request'); return; }
      setReqResult(data.message);
      setReqWhat(''); setReqWhen(''); setReqNotes('');
      setRequests(null);
    } catch { setReqError('We could not send your request'); }
    finally { setReqBusy(false); }
  }

  async function sendReferral() {
    setRefBusy(true); setRefError(''); setRefResult('');
    try {
      const resp = await fetch(`${API}/api/portal/referrals`, {
        method: 'POST', headers: portalHeaders(slug!),
        body: JSON.stringify({ name: refName, phone: refPhone, email: refEmail, zip: refZip, note: refNote, referral_type: refType }),
      });
      const data = await resp.json();
      if (!resp.ok) { setRefError(data.message || 'We could not send that'); return; }
      setRefResult(data.message);
      setRefName(''); setRefPhone(''); setRefEmail(''); setRefZip(''); setRefNote(''); setRefType('residential');
    } catch { setRefError('We could not send that'); }
    finally { setRefBusy(false); }
  }

  function logout() {
    localStorage.removeItem(`portal_token_${slug}`);
    navigate(`/portal/${slug}/login`);
  }

  const brandColor = company?.brand_color || '#00C9A0';
  const caps = client?.capabilities || {};
  const impersonated = client?.impersonated === true;
  const nextJob = jobs.upcoming[0];
  const lastJob = jobs.past[0];
  const hold = plan?.hold || null;

  const primaryBtn = (extra?: React.CSSProperties): React.CSSProperties => ({
    height: 44, padding: '0 20px', background: brandColor, color: '#FFFFFF', border: 'none',
    borderRadius: 9, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', ...extra,
  });
  const quietBtn: React.CSSProperties = {
    height: 44, padding: '0 20px', background: '#FFFFFF', color: '#1A1917', border: '1px solid #E5E2DC',
    borderRadius: 9, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  };

  if (loading) {
    return (
      <div style={{ minHeight:'100vh', background:'#F7F6F3', display:'flex', alignItems:'center', justifyContent:'center' }}>
        <p style={{ color:'#9E9B94', fontSize:14 }}>Loading your portal...</p>
      </div>
    );
  }

  return (
    <div style={{ minHeight:'100vh', background:'#F7F6F3', fontFamily:"'Plus Jakarta Sans', sans-serif" }}>
      <style>{`
        @keyframes spin { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }
        .qleno-tabs::-webkit-scrollbar { display:none }
      `}</style>

      {/* Support session banner. Design doc §7: the portal must SAY when the
          office is looking, and the office must not be able to act. */}
      {impersonated && (
        <div style={{ background:'#0A0E1A', color:'#FFFFFF', padding:'10px 16px', display:'flex', alignItems:'center', gap:10, justifyContent:'center' }}>
          <ShieldAlert size={16} color="#F59E0B"/>
          <span style={{ fontSize:12.5, fontWeight:600 }}>
            Support view. You are seeing this account exactly as the customer does. Nothing here can be changed from this session.
          </span>
        </div>
      )}

      {/* Portal Header */}
      <div style={{ background:'#FFFFFF', borderBottom:'1px solid #E5E2DC', padding:'0 24px' }}>
        <div style={{ maxWidth:680, margin:'0 auto', height:60, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            {company?.logo_url
              ? <img src={company.logo_url} alt={company.name} style={{ height:32, objectFit:'contain' }}/>
              : <div style={{ width:32, height:32, borderRadius:8, background:`${brandColor}20`, display:'flex', alignItems:'center', justifyContent:'center' }}>
                  <span style={{ fontSize:12, fontWeight:800, color:brandColor }}>CP</span>
                </div>
            }
            <span style={{ fontSize:14, fontWeight:700, color:'#1A1917' }}>{company?.name}</span>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <span style={{ fontSize:13, color:'#6B6860' }}>Hi, {client?.first_name}</span>
            {/* Profile picture with upload */}
            <div style={{ position:'relative', flexShrink:0 }}>
              <button
                onClick={() => fileInputRef.current?.click()}
                title="Change profile photo"
                style={{ background:'none', border:'none', cursor:'pointer', padding:0, display:'flex', position:'relative', borderRadius:'50%' }}>
                {client?.profile_picture_url
                  ? <img src={client.profile_picture_url} alt="Profile" style={{ width:34, height:34, borderRadius:'50%', objectFit:'cover', border:`2px solid ${brandColor}40` }} />
                  : <div style={{ width:34, height:34, borderRadius:'50%', background:`${brandColor}20`, border:`2px solid ${brandColor}40`, display:'flex', alignItems:'center', justifyContent:'center' }}>
                      <span style={{ fontSize:12, fontWeight:800, color:brandColor }}>
                        {client ? `${client.first_name?.[0]||''}${client.last_name?.[0]||''}`.toUpperCase() : '?'}
                      </span>
                    </div>
                }
                <div style={{ position:'absolute', bottom:0, right:0, width:14, height:14, borderRadius:'50%', background:brandColor, display:'flex', alignItems:'center', justifyContent:'center', border:'1.5px solid white' }}>
                  {uploading
                    ? <div style={{ width:8, height:8, borderRadius:'50%', border:'1.5px solid white', borderTopColor:'transparent', animation:'spin 0.6s linear infinite' }}/>
                    : <Camera size={8} color="white" />
                  }
                </div>
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handlePhotoSelect} style={{ display:'none' }} />
            </div>
            <button onClick={logout} style={{ background:'none', border:'none', cursor:'pointer', color:'#9E9B94', padding:4, display:'flex', alignItems:'center' }}>
              <LogOut size={16}/>
            </button>
          </div>
          {uploadError && (
            <div style={{ position:'fixed', bottom:20, left:'50%', transform:'translateX(-50%)', background:'#FCEBEA', color:'#B3261E', padding:'8px 16px', borderRadius:8, fontSize:12, fontWeight:600, zIndex:999 }}>
              {uploadError}
              <button onClick={() => setUploadError('')} style={{ marginLeft:8, background:'none', border:'none', cursor:'pointer', color:'#B3261E', fontWeight:800 }}>x</button>
            </div>
          )}
        </div>

        {/* Tab Bar. Scrolls sideways on a phone rather than wrapping into two
            rows that push the content down. */}
        <div className="qleno-tabs" style={{ maxWidth:680, margin:'0 auto', display:'flex', gap:0, overflowX:'auto', scrollbarWidth:'none' }}>
          {TABS.map(([key, label]) => (
            <button key={key} onClick={() => setActiveTab(key)}
              style={{
                padding:'10px 14px', background:'none', border:'none', cursor:'pointer', whiteSpace:'nowrap',
                fontSize:13, fontWeight: activeTab===key ? 600 : 400,
                color: activeTab===key ? brandColor : '#6B6860',
                borderBottom: activeTab===key ? `2px solid ${brandColor}` : '2px solid transparent',
                marginBottom:-1, fontFamily:'inherit',
              }}>{label}</button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth:680, margin:'0 auto', padding:'24px 16px' }}>

        {/* ── HOME TAB ── */}
        {activeTab === 'home' && (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

            {/* Service paused / ending. This sits above everything because a
                customer whose service is paused is asking exactly one question,
                and it should not be four taps away. */}
            {hold && (
              <div style={{ background: hold.ends_service ? '#FCEBEA' : '#FDF3E4',
                            border: `1px solid ${hold.ends_service ? '#F3C9C5' : '#F0DCB4'}`,
                            borderRadius:14, padding:'18px 20px' }}>
                <div style={{ display:'flex', alignItems:'flex-start', gap:10 }}>
                  {hold.ends_service ? <AlertTriangle size={18} color="#B3261E"/> : <PauseCircle size={18} color="#8A5A00"/>}
                  <div style={{ flex:1 }}>
                    <p style={{ fontSize:14, fontWeight:700, color: hold.ends_service ? '#B3261E' : '#8A5A00', margin:'0 0 4px 0' }}>
                      {hold.ends_service ? 'Your service is ending' : 'Your service is paused'}
                    </p>
                    <p style={{ fontSize:13, color:'#6B6860', margin:0 }}>
                      {hold.ends_service
                        ? `Your last visits run through ${shortDate(hold.end_date)}. If you want to keep your cleanings, restart any time before then and nothing changes.`
                        : `We are holding your spot through ${shortDate(hold.end_date)}. Nothing is charged while you are paused.`}
                    </p>
                    {caps.manageHold && (
                      <button onClick={resumeService} disabled={holdBusy}
                        style={{ ...primaryBtn({ marginTop:12, height:40 }), opacity: holdBusy ? 0.6 : 1 }}>
                        <span style={{ display:'flex', alignItems:'center', gap:7 }}><PlayCircle size={15}/> Restart my service</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Next Cleaning */}
            {nextJob ? (
              <div style={{ background:`${brandColor}15`, border:`1px solid ${brandColor}30`, borderRadius:14, padding:'20px 22px' }}>
                <p style={{ ...EYEBROW, color:brandColor, margin:'0 0 12px 0' }}>Your Next Cleaning</p>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                  <div>
                    <p style={{ fontSize:18, fontWeight:700, color:'#1A1917', margin:'0 0 4px 0' }}>
                      {longDate(nextJob.scheduled_date)}
                    </p>
                    {(nextJob.scheduled_time || nextJob.arrival_window) && (
                      <p style={{ fontSize:14, color:'#6B6860', margin:'0 0 4px 0', display:'flex', alignItems:'center', gap:5 }}>
                        <Clock size={13}/>{nextJob.scheduled_time || nextJob.arrival_window}
                      </p>
                    )}
                    <p style={{ fontSize:13, color:'#6B6860', margin:0 }}>{SERVICE_LABELS[nextJob.service_type] || nextJob.service_type}</p>
                  </div>
                  {(nextJob.cleaner_first) && (
                    <div style={{ textAlign:'center' }}>
                      <InitialAvatar name={`${nextJob.cleaner_first} ${nextJob.cleaner_last}`}/>
                      <p style={{ fontSize:11, color:'#6B6860', margin:'4px 0 0 0' }}>{nextJob.cleaner_first}</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <EmptyState icon={<Calendar size={30} color="#E5E2DC"/>} text="No upcoming cleanings scheduled" />
            )}

            {/* How often we come, straight from the agreement. */}
            {plan?.cadence && (
              <div style={{ ...CARD, display:'flex', alignItems:'center', gap:12 }}>
                <Calendar size={18} color={brandColor}/>
                <div style={{ flex:1 }}>
                  <p style={{ fontSize:13, fontWeight:700, color:'#1A1917', margin:'0 0 2px 0' }}>{plan.cadence}</p>
                  <p style={{ fontSize:12, color:'#6B6860', margin:0 }}>
                    {plan.schedules?.[0]?.rate ? `${usd(plan.schedules[0].rate)} per visit` : 'Your regular service'}
                  </p>
                </div>
                <button onClick={() => setActiveTab('plan')} style={{ background:'none', border:'none', cursor:'pointer', padding:4 }}>
                  <ChevronRight size={16} color="#9E9B94"/>
                </button>
              </div>
            )}

            {/* Last Cleaning — rate prompt */}
            {lastJob && caps.rateClean && !ratingSubmitted.has(lastJob.id) && (
              <div style={CARD}>
                <p style={{ fontSize:13, fontWeight:700, color:'#1A1917', margin:'0 0 8px 0' }}>How was your last cleaning?</p>
                <p style={{ fontSize:12, color:'#6B6860', margin:'0 0 14px 0' }}>
                  {shortDate(lastJob.scheduled_date)} · {SERVICE_LABELS[lastJob.service_type] || lastJob.service_type}
                </p>
                <StarRatingInput
                  value={rating[lastJob.id]?.score || 0}
                  onChange={v => setRating(p => ({ ...p, [lastJob.id]: { ...(p[lastJob.id]||{}), score:v, comment:p[lastJob.id]?.comment||'' } }))}/>
                {rating[lastJob.id]?.score > 0 && (
                  <>
                    <textarea placeholder="Leave a comment (optional)"
                      value={rating[lastJob.id]?.comment || ''}
                      onChange={e => setRating(p => ({ ...p, [lastJob.id]: { ...p[lastJob.id], comment:e.target.value } }))}
                      style={{ ...TEXTAREA, height:60, marginTop:10, marginBottom:10 }}/>
                    <button onClick={() => submitRating(lastJob.id)} style={primaryBtn({ height:38, padding:'0 18px', fontSize:13 })}>
                      Submit Rating
                    </button>
                  </>
                )}
              </div>
            )}
            {lastJob && ratingSubmitted.has(lastJob.id) && (
              <div style={{ background:'#E6F6F1', border:'1px solid #C7E7DE', borderRadius:14, padding:'16px 20px', display:'flex', alignItems:'center', gap:10 }}>
                <Star size={18} color="#0F7A63" fill="#0F7A63"/>
                <p style={{ fontSize:13, fontWeight:600, color:'#0F7A63', margin:0 }}>Thank you for your rating!</p>
              </div>
            )}

            {/* Quick Actions */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              {[
                { icon: <Plus size={18} color={brandColor}/>,      label:'Request a service', tab:'requests' as TabKey, show: caps.requestService },
                { icon: <FileText size={18} color={brandColor}/>,  label:'My invoices',       tab:'billing' as TabKey,  show: caps.viewInvoices },
                { icon: <Users size={18} color={brandColor}/>,     label:'Refer a friend',    tab:'refer' as TabKey,    show: caps.submitReferral },
                { icon: <DollarSign size={18} color={brandColor}/>,label:'Tip my cleaner',    tab:'tip' as TabKey,      show: caps.payInvoice },
                { icon: <Calendar size={18} color={brandColor}/>,  label:'My schedule',       tab:'schedule' as TabKey, show: true },
                { icon: <PauseCircle size={18} color={brandColor}/>,label:'My plan',          tab:'plan' as TabKey,     show: true },
              ].filter(a => a.show).map(a => (
                <button key={a.label} onClick={() => setActiveTab(a.tab)}
                  style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:12, padding:'14px 16px', display:'flex', alignItems:'center', gap:10, cursor:'pointer', textAlign:'left', fontFamily:'inherit' }}>
                  {a.icon}
                  <span style={{ fontSize:13, fontWeight:600, color:'#1A1917' }}>{a.label}</span>
                  <ChevronRight size={14} color="#9E9B94" style={{ marginLeft:'auto' }}/>
                </button>
              ))}
            </div>

            {/* Loyalty */}
            {client?.loyalty_points > 0 && (
              <div style={{ ...CARD, padding:'16px 20px', display:'flex', alignItems:'center', gap:12 }}>
                <Zap size={20} color="#F59E0B" fill="#FDF3E4"/>
                <div style={{ flex:1 }}>
                  <p style={{ fontSize:13, fontWeight:700, color:'#1A1917', margin:'0 0 2px 0' }}>{client.loyalty_points} Loyalty Points</p>
                  <div style={{ height:6, borderRadius:3, background:'#F0EEE9', overflow:'hidden' }}>
                    <div style={{ height:'100%', width:`${Math.min((client.loyalty_points/500)*100,100)}%`, background:brandColor, borderRadius:3, transition:'width 0.4s' }}/>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── SCHEDULE TAB ── upcoming and past in one place, because "when are
             you coming" and "when were you here" are the same question asked in
             two directions. */}
        {activeTab === 'schedule' && (
          <div style={{ display:'flex', flexDirection:'column', gap:22 }}>
            <div>
              <h2 style={{ fontSize:16, fontWeight:700, color:'#1A1917', margin:'0 0 12px 0' }}>Coming up</h2>
              {jobs.upcoming.length === 0
                ? <EmptyState icon={<Calendar size={30} color="#E5E2DC"/>} text="Nothing scheduled right now" />
                : (
                  <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                    {jobs.upcoming.map(j => (
                      <div key={j.id} style={{ ...CARD, padding:'16px 18px', display:'flex', alignItems:'center', gap:12 }}>
                        <div style={{ width:4, alignSelf:'stretch', borderRadius:2, background:brandColor }}/>
                        <div style={{ flex:1 }}>
                          <p style={{ fontSize:13.5, fontWeight:700, color:'#1A1917', margin:'0 0 3px 0' }}>{longDate(j.scheduled_date)}</p>
                          <p style={{ fontSize:12, color:'#6B6860', margin:0 }}>
                            {(j.scheduled_time || j.arrival_window) ? `${j.scheduled_time || j.arrival_window} · ` : ''}
                            {SERVICE_LABELS[j.service_type] || j.service_type}
                          </p>
                        </div>
                        {j.cleaner_first && <InitialAvatar name={`${j.cleaner_first} ${j.cleaner_last}`}/>}
                      </div>
                    ))}
                  </div>
                )}
            </div>

            <div>
              <h2 style={{ fontSize:16, fontWeight:700, color:'#1A1917', margin:'0 0 12px 0' }}>Service history</h2>
              {jobs.past.length === 0
                ? <EmptyState icon={<Clock size={30} color="#E5E2DC"/>} text="No past services yet" />
                : (
                  <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                    {jobs.past.map(j => (
                      <div key={j.id} style={{ ...CARD, padding:'16px 18px', display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12 }}>
                        <div>
                          <p style={{ fontSize:13, fontWeight:600, color:'#1A1917', margin:'0 0 3px 0' }}>{shortDate(j.scheduled_date)}</p>
                          <p style={{ fontSize:12, color:'#6B6860', margin:0 }}>{SERVICE_LABELS[j.service_type] || j.service_type}</p>
                        </div>
                        <div style={{ textAlign:'right' }}>
                          <StatusPill
                            label={j.status === 'complete' ? 'Complete' : j.status === 'cancelled' ? 'Cancelled' : 'Scheduled'}
                            tone={j.status === 'complete' ? 'good' : j.status === 'cancelled' ? 'quiet' : 'quiet'} />
                          {j.cleaner_first && (
                            <p style={{ fontSize:11, color:'#9E9B94', margin:'5px 0 0 0' }}>Cleaner: {j.cleaner_first}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
            </div>
          </div>
        )}

        {/* ── BILLING TAB ── */}
        {activeTab === 'billing' && (
          <div>
            <h2 style={{ fontSize:16, fontWeight:700, color:'#1A1917', margin:'0 0 12px 0' }}>Billing</h2>
            {billing == null ? (
              <p style={{ fontSize:13, color:'#9E9B94' }}>Loading your invoices...</p>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
                <div style={{ ...CARD, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <div>
                    <p style={{ ...EYEBROW, margin:'0 0 4px 0' }}>Balance</p>
                    <p style={{ fontSize:22, fontWeight:800, color: billing.outstanding > 0 ? '#B3261E' : '#0F7A63', margin:0, fontVariantNumeric:'tabular-nums' }}>
                      {usd(billing.outstanding)}
                    </p>
                  </div>
                  {billing.outstanding === 0 && <CheckCircle2 size={22} color="#0F7A63"/>}
                </div>

                {billing.invoices.length === 0
                  ? <EmptyState icon={<FileText size={30} color="#E5E2DC"/>} text="No invoices yet" />
                  : billing.invoices.map(inv => (
                    <div key={inv.id} style={{ ...CARD, padding:'16px 18px', display:'flex', alignItems:'center', gap:12 }}>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3 }}>
                          <p style={{ fontSize:13.5, fontWeight:700, color:'#1A1917', margin:0 }}>
                            {inv.invoice_number || `Invoice #${inv.id}`}
                          </p>
                          <StatusPill
                            label={inv.status === 'paid' ? 'Paid' : inv.status === 'overdue' ? 'Past due' : 'Due'}
                            tone={inv.status === 'paid' ? 'good' : inv.status === 'overdue' ? 'bad' : 'warn'} />
                        </div>
                        <p style={{ fontSize:12, color:'#6B6860', margin:0 }}>
                          {inv.service_date ? `Service ${shortDate(inv.service_date)}` : ''}
                          {inv.due_date && inv.status !== 'paid' ? `${inv.service_date ? ' · ' : ''}Due ${shortDate(inv.due_date)}` : ''}
                        </p>
                      </div>
                      <p style={{ fontSize:15, fontWeight:700, color:'#1A1917', margin:0, fontVariantNumeric:'tabular-nums' }}>{usd(inv.total)}</p>
                      {caps.downloadInvoicePdf && (
                        <button onClick={() => openInvoicePdf(inv.id)} title="Open PDF"
                          style={{ background:'none', border:'1px solid #E5E2DC', borderRadius:8, padding:'7px 9px', cursor:'pointer', display:'flex' }}>
                          <Download size={14} color="#6B6860"/>
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        {/* ── MY PLAN TAB ── the agreement, in the customer's words, plus the
             two things it entitles them to do: pause, and read what they signed. */}
        {activeTab === 'plan' && (
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <h2 style={{ fontSize:16, fontWeight:700, color:'#1A1917', margin:0 }}>My Plan</h2>

            {plan == null ? <p style={{ fontSize:13, color:'#9E9B94' }}>Loading your plan...</p> : (
              <>
                {holdResult && (
                  <div style={{ background:'#E6F6F1', border:'1px solid #C7E7DE', borderRadius:12, padding:'14px 16px' }}>
                    <p style={{ fontSize:13, fontWeight:600, color:'#0F7A63', margin:0 }}>{holdResult}</p>
                  </div>
                )}

                {/* What we do for you */}
                {plan.schedules?.length ? plan.schedules.map((s: any) => (
                  <div key={s.id} style={CARD}>
                    <p style={EYEBROW}>Your service</p>
                    <p style={{ fontSize:17, fontWeight:700, color:'#1A1917', margin:'0 0 4px 0' }}>{s.cadence}</p>
                    <p style={{ fontSize:13, color:'#6B6860', margin:0 }}>
                      {s.rate ? `${usd(s.rate)} per visit` : 'Rate on your agreement'}
                      {s.since ? ` · with us since ${shortDate(s.since)}` : ''}
                    </p>
                    {s.paused && (
                      <p style={{ fontSize:12.5, color:'#8A5A00', margin:'10px 0 0 0', fontWeight:600 }}>Paused right now</p>
                    )}
                  </div>
                )) : (
                  <EmptyState icon={<Calendar size={30} color="#E5E2DC"/>} text="No recurring service on file" />
                )}

                {/* Pause time */}
                <div style={CARD}>
                  <p style={EYEBROW}>Pause time</p>
                  <p style={{ fontSize:17, fontWeight:700, color:'#1A1917', margin:'0 0 4px 0', fontVariantNumeric:'tabular-nums' }}>
                    {plan.pause_days?.remaining ?? 0} of {plan.pause_days?.allowed ?? 0} days left
                  </p>
                  <p style={{ fontSize:12.5, color:'#6B6860', margin:0 }}>
                    Your agreement includes {plan.pause_days?.allowed ?? 0} paused days a year. Vacations, travel, anything you like. Nothing is charged while you are paused.
                  </p>

                  {hold ? (
                    <div style={{ marginTop:14, padding:'14px 16px', borderRadius:10, background: hold.ends_service ? '#FCEBEA' : '#FDF3E4' }}>
                      <p style={{ fontSize:13, fontWeight:700, color: hold.ends_service ? '#B3261E' : '#8A5A00', margin:'0 0 4px 0' }}>
                        {hold.ends_service ? `Service ends ${shortDate(hold.end_date)}` : `Paused through ${shortDate(hold.end_date)}`}
                      </p>
                      <p style={{ fontSize:12.5, color:'#6B6860', margin:0 }}>
                        {hold.ends_service
                          ? 'Restart before that date and your agreement carries on as normal, with nothing charged for the pause.'
                          : 'We are holding your regular spot. Come back any time.'}
                      </p>
                      {caps.manageHold && (
                        <button onClick={resumeService} disabled={holdBusy}
                          style={{ ...primaryBtn({ marginTop:12, height:40 }), opacity: holdBusy ? 0.6 : 1 }}>
                          <span style={{ display:'flex', alignItems:'center', gap:7 }}><PlayCircle size={15}/> Restart my service</span>
                        </button>
                      )}
                    </div>
                  ) : caps.manageHold ? (
                    <div style={{ marginTop:16, paddingTop:16, borderTop:'1px solid #E5E2DC' }}>
                      <label style={{ fontSize:12.5, fontWeight:600, color:'#1A1917', display:'block', marginBottom:6 }}>
                        Pause my service through
                      </label>
                      <input type="date" value={pauseUntil} onChange={e => checkPause(e.target.value)} style={INPUT}/>

                      {previewError && (
                        <p style={{ fontSize:12.5, color:'#B3261E', margin:'10px 0 0 0' }}>{previewError}</p>
                      )}

                      {/* A pause inside the free days costs nothing, but it still
                          goes to the office rather than executing itself. The
                          screen has to say which one it is: promising "paused"
                          and then having the schedule keep running is worse than
                          asking. */}
                      {preview && !preview.ends_service && (
                        <div style={{ marginTop:14, padding:'14px 16px', borderRadius:10, background:'#F7F6F3', border:'1px solid #E5E2DC' }}>
                          <p style={{ fontSize:13, fontWeight:700, color:'#1A1917', margin:'0 0 6px 0' }}>
                            {preview.days} days paused, through {shortDate(preview.until)}
                          </p>
                          <p style={{ fontSize:12.5, color:'#6B6860', margin:'0 0 12px 0' }}>
                            This uses {preview.pause_days?.this_pause ?? preview.days} of your {preview.pause_days?.allowed ?? 0} paused days. Nothing is charged, and we hold your regular spot.
                            {preview.needs_office ? ' Send it over and someone from the office will confirm it with you. Your visits stay on the calendar until then.' : ''}
                          </p>
                          <button onClick={confirmPause} disabled={holdBusy}
                            style={{ ...primaryBtn({ opacity: holdBusy ? 0.6 : 1 }) }}>
                            {preview.needs_office ? 'Request this pause' : 'Confirm pause'}
                          </button>
                        </div>
                      )}

                      {/* The one screen this whole feature exists for. A pause
                          past the free days is a termination notice: it ends the
                          agreement and bills the visits the customer's own
                          cadence would have had in the notice period. They read
                          the dates and the dollars BEFORE they can send it, and
                          even then they cannot execute it. */}
                      {preview && preview.ends_service && (
                        <div style={{ marginTop:14, padding:'16px 18px', borderRadius:10, background:'#FCEBEA', border:'1px solid #F3C9C5' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                            <AlertTriangle size={16} color="#B3261E"/>
                            <p style={{ fontSize:13.5, fontWeight:800, color:'#B3261E', margin:0 }}>This would end your service</p>
                          </div>
                          <p style={{ fontSize:12.5, color:'#1A1917', margin:'0 0 10px 0', lineHeight:1.5 }}>
                            A pause of {preview.days} days runs past the {preview.pause_days?.allowed ?? 0} paused days your agreement includes, so it counts as your {preview.notice?.days ?? 30} days notice to end service.
                          </p>
                          {preview.notice && (
                            <div style={{ background:'#FFFFFF', borderRadius:9, padding:'12px 14px', marginBottom:12 }}>
                              <p style={{ fontSize:12, color:'#6B6860', margin:'0 0 6px 0' }}>
                                You are on {preview.cadence}, so your last {preview.notice.visits} {preview.notice.visits === 1 ? 'visit' : 'visits'} would be:
                              </p>
                              <ul style={{ margin:'0 0 8px 0', paddingLeft:18 }}>
                                {preview.notice.dates.map((d: string) => (
                                  <li key={d} style={{ fontSize:12.5, color:'#1A1917', marginBottom:2 }}>{shortDate(d)}</li>
                                ))}
                              </ul>
                              <p style={{ fontSize:13, fontWeight:700, color:'#1A1917', margin:0, fontVariantNumeric:'tabular-nums' }}>
                                Total {usd(preview.notice.amount)}
                              </p>
                            </div>
                          )}
                          <p style={{ fontSize:12.5, color:'#6B6860', margin:'0 0 12px 0' }}>
                            If you only need a break, pick an earlier date and nothing is charged. If you do want to end service, send this to us and someone will call you first.
                          </p>
                          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                            <button onClick={confirmPause} disabled={holdBusy}
                              style={{ ...quietBtn, borderColor:'#B3261E', color:'#B3261E', opacity: holdBusy ? 0.6 : 1 }}>
                              Send this request
                            </button>
                            <button onClick={() => { setPauseUntil(''); setPreview(null); }} style={quietBtn}>
                              Pick another date
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>

                {/* The agreement itself */}
                <div style={CARD}>
                  <p style={EYEBROW}>Your agreement</p>
                  {plan.agreements?.length ? (
                    <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                      {plan.agreements.map((a: any) => (
                        <div key={a.id} style={{ display:'flex', alignItems:'center', gap:10 }}>
                          <FileText size={16} color="#9E9B94"/>
                          <div style={{ flex:1, minWidth:0 }}>
                            <p style={{ fontSize:13, fontWeight:600, color:'#1A1917', margin:'0 0 2px 0' }}>{a.name}</p>
                            <p style={{ fontSize:11.5, color:'#6B6860', margin:0 }}>
                              {a.signed_at ? `Signed ${shortDate(String(a.signed_at).slice(0,10))}${a.signed_by ? ` by ${a.signed_by}` : ''}` : 'Waiting for your signature'}
                            </p>
                          </div>
                          {a.pdf_url && (
                            <a href={`${API}${a.pdf_url}`} target="_blank" rel="noreferrer"
                               style={{ fontSize:12.5, fontWeight:600, color:brandColor, textDecoration:'none' }}>
                              {a.signed_at ? 'View' : 'Sign'}
                            </a>
                          )}
                          {a.certificate_url && (
                            <a href={`${API}${a.certificate_url}`} target="_blank" rel="noreferrer"
                               style={{ fontSize:12.5, fontWeight:600, color:'#6B6860', textDecoration:'none' }}>
                              Receipt
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p style={{ fontSize:13, color:'#9E9B94', margin:0 }}>Nothing on file yet.</p>
                  )}
                  <p style={{ fontSize:11.5, color:'#9E9B94', margin:'12px 0 0 0' }}>
                    To end service we ask for {plan.notice_days} days notice, which we count in visits at your own cadence.
                  </p>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── REQUEST SERVICE TAB ── */}
        {activeTab === 'requests' && (
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <h2 style={{ fontSize:16, fontWeight:700, color:'#1A1917', margin:0 }}>Request a service</h2>

            {caps.requestService ? (
              <div style={CARD}>
                <p style={{ fontSize:12.5, color:'#6B6860', margin:'0 0 14px 0' }}>
                  Extra clean, a deep clean, oven or fridge, anything you need on top of your regular visits. Tell us what you are after and we will call you with a date and a price.
                </p>
                <label style={{ fontSize:12.5, fontWeight:600, color:'#1A1917', display:'block', marginBottom:6 }}>What do you need?</label>
                <input value={reqWhat} onChange={e => setReqWhat(e.target.value)}
                  placeholder="Deep clean before we host" style={{ ...INPUT, marginBottom:12 }}/>

                <label style={{ fontSize:12.5, fontWeight:600, color:'#1A1917', display:'block', marginBottom:6 }}>Any day in mind? (optional)</label>
                <input type="date" value={reqWhen} onChange={e => setReqWhen(e.target.value)} style={{ ...INPUT, marginBottom:12 }}/>

                <label style={{ fontSize:12.5, fontWeight:600, color:'#1A1917', display:'block', marginBottom:6 }}>Anything else we should know? (optional)</label>
                <textarea value={reqNotes} onChange={e => setReqNotes(e.target.value)} style={{ ...TEXTAREA, marginBottom:14 }}/>

                {reqError && <p style={{ fontSize:12.5, color:'#B3261E', margin:'0 0 10px 0' }}>{reqError}</p>}
                {reqResult && <p style={{ fontSize:12.5, color:'#0F7A63', fontWeight:600, margin:'0 0 10px 0' }}>{reqResult}</p>}

                <button onClick={sendRequest} disabled={reqBusy || reqWhat.trim().length < 3}
                  style={primaryBtn({ opacity: (reqBusy || reqWhat.trim().length < 3) ? 0.5 : 1 })}>
                  Send request
                </button>
              </div>
            ) : (
              <div style={CARD}>
                <p style={{ fontSize:13, color:'#6B6860', margin:0 }}>
                  {impersonated
                    ? 'Requests can only be sent by the customer themselves.'
                    : 'Give us a call and we will get this on the schedule for you.'}
                </p>
              </div>
            )}

            <div>
              <p style={EYEBROW}>Your requests</p>
              {requests == null ? (
                <p style={{ fontSize:13, color:'#9E9B94' }}>Loading...</p>
              ) : requests.length === 0 ? (
                <EmptyState icon={<Plus size={30} color="#E5E2DC"/>} text="You have not asked for anything extra yet" />
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                  {requests.map(r => (
                    <div key={r.id} style={{ ...CARD, padding:'16px 18px' }}>
                      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:10 }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <p style={{ fontSize:13.5, fontWeight:600, color:'#1A1917', margin:'0 0 3px 0' }}>{r.service}</p>
                          <p style={{ fontSize:12, color:'#6B6860', margin:0 }}>
                            {r.preferred_date ? `You asked for ${shortDate(r.preferred_date)}` : 'No date requested'}
                          </p>
                        </div>
                        <StatusPill
                          label={r.status === 'scheduled' ? 'On the schedule' : r.status === 'declined' ? 'We will call you' : 'With the office'}
                          tone={r.status === 'scheduled' ? 'good' : r.status === 'declined' ? 'quiet' : 'warn'} />
                      </div>
                      {r.office_note && (
                        <p style={{ fontSize:12.5, color:'#6B6860', margin:'10px 0 0 0', paddingTop:10, borderTop:'1px solid #E5E2DC' }}>
                          {r.office_note}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── REFER A FRIEND TAB ── */}
        {activeTab === 'refer' && (
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <h2 style={{ fontSize:16, fontWeight:700, color:'#1A1917', margin:0 }}>Refer a friend</h2>
            {caps.submitReferral ? (
              <div style={CARD}>
                {/* [referral-one-program 2026-08-20] The portal used to promise
                    nothing while the booking confirmation page promised $25 each
                    way. Same program, same words, wherever the customer is
                    standing. */}
                <div style={{ background:'#F7F6F3', border:'1px solid #E5E2DC', borderRadius:10, padding:'14px 16px', marginBottom:14 }}>
                  <span style={{ display:'inline-block', background:'#E1F5EE', color:'#085041', fontSize:10.5, fontWeight:700, letterSpacing:'.05em', textTransform:'uppercase', padding:'3px 10px', borderRadius:999, marginBottom:7 }}>Referral program</span>
                  <p style={{ margin:'0 0 4px', fontWeight:800, fontSize:15, color:'#1A1917' }}>Give $25, get $25</p>
                  <p style={{ margin:0, fontSize:12.5, color:'#6B6860', lineHeight:1.6 }}>
                    Know someone who could use a cleaning, a friend's home or a business? They get $25 off their first clean, and you get $25 off your next one after their first visit. We will always mention it came from you.
                  </p>
                </div>

                <label style={{ fontSize:12.5, fontWeight:600, color:'#1A1917', display:'block', marginBottom:6 }}>Who are you referring?</label>
                <div style={{ display:'flex', border:'1px solid #E5E2DC', borderRadius:8, overflow:'hidden', marginBottom:12 }}>
                  {(['residential', 'commercial'] as const).map(t => (
                    <button key={t} onClick={() => setRefType(t)}
                      style={{ flex:1, textAlign:'center', padding:'9px 0', fontSize:13, fontWeight:700, fontFamily:'inherit', border:'none', cursor:'pointer',
                        background: refType === t ? brandColor : '#fff', color: refType === t ? '#fff' : '#6B6860' }}>
                      {t === 'residential' ? 'A home' : 'A business'}
                    </button>
                  ))}
                </div>

                <label style={{ fontSize:12.5, fontWeight:600, color:'#1A1917', display:'block', marginBottom:6 }}>{refType === 'commercial' ? 'Business or contact name' : 'Their name'}</label>
                <input value={refName} onChange={e => setRefName(e.target.value)} placeholder={refType === 'commercial' ? 'Company or contact' : 'First and last'} style={{ ...INPUT, marginBottom:12 }}/>

                <div style={{ display:'flex', gap:10, marginBottom:12, flexWrap:'wrap' }}>
                  <div style={{ flex:'1 1 160px' }}>
                    <label style={{ fontSize:12.5, fontWeight:600, color:'#1A1917', display:'block', marginBottom:6 }}>Phone</label>
                    <input value={refPhone} onChange={e => setRefPhone(e.target.value)} placeholder="(773) 555 0134" style={INPUT}/>
                  </div>
                  <div style={{ flex:'1 1 160px' }}>
                    <label style={{ fontSize:12.5, fontWeight:600, color:'#1A1917', display:'block', marginBottom:6 }}>Email</label>
                    <input value={refEmail} onChange={e => setRefEmail(e.target.value)} placeholder="name@email.com" style={INPUT}/>
                  </div>
                </div>

                <label style={{ fontSize:12.5, fontWeight:600, color:'#1A1917', display:'block', marginBottom:6 }}>Their zip code (optional)</label>
                <input value={refZip} onChange={e => setRefZip(e.target.value)} placeholder="60453" style={{ ...INPUT, marginBottom:12 }}/>

                <label style={{ fontSize:12.5, fontWeight:600, color:'#1A1917', display:'block', marginBottom:6 }}>Anything we should know? (optional)</label>
                <textarea value={refNote} onChange={e => setRefNote(e.target.value)} style={{ ...TEXTAREA, marginBottom:14 }}/>

                <p style={{ fontSize:11.5, color:'#9E9B94', margin:'0 0 12px 0' }}>
                  Please make sure they are happy to hear from us before you send their details.
                </p>

                {refError && <p style={{ fontSize:12.5, color:'#B3261E', margin:'0 0 10px 0' }}>{refError}</p>}
                {refResult && <p style={{ fontSize:12.5, color:'#0F7A63', fontWeight:600, margin:'0 0 10px 0' }}>{refResult}</p>}

                <button onClick={sendReferral} disabled={refBusy || refName.trim().length < 2 || (!refPhone.trim() && !refEmail.trim())}
                  style={primaryBtn({ opacity: (refBusy || refName.trim().length < 2 || (!refPhone.trim() && !refEmail.trim())) ? 0.5 : 1 })}>
                  Send referral
                </button>
              </div>
            ) : (
              <div style={CARD}>
                <p style={{ fontSize:13, color:'#6B6860', margin:0 }}>
                  {impersonated
                    ? 'A referral has to come from the customer themselves.'
                    : 'Give us a call and we will take their details.'}
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── TIP TAB ── */}
        {activeTab === 'tip' && (
          <div>
            <h2 style={{ fontSize:16, fontWeight:700, color:'#1A1917', margin:'0 0 16px 0' }}>Tip My Cleaner</h2>
            {tipSent ? (
              <div style={{ background:'#E6F6F1', border:'1px solid #C7E7DE', borderRadius:14, padding:'32px', textAlign:'center' }}>
                <Star size={40} color="#0F7A63" fill="#E6F6F1" style={{ marginBottom:12 }}/>
                <p style={{ fontSize:16, fontWeight:700, color:'#0F7A63', margin:'0 0 6px 0' }}>Tip sent!</p>
                <p style={{ fontSize:13, color:'#6B6860', margin:0 }}>Your cleaner will love you for it.</p>
              </div>
            ) : (
              <>
                {/* Job selector */}
                <div style={{ marginBottom:16 }}>
                  <p style={EYEBROW}>Select a service to tip for</p>
                  <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                    {[...jobs.past, ...jobs.upcoming].slice(0,5).filter(j => j.cleaner_first).map(j => (
                      <button key={j.id} onClick={() => setTipJob(j)}
                        style={{ background: tipJob?.id===j.id ? `${brandColor}15` : '#FFFFFF', border:`1px solid ${tipJob?.id===j.id ? brandColor : '#E5E2DC'}`, borderRadius:10, padding:'12px 16px', display:'flex', alignItems:'center', gap:12, cursor:'pointer', textAlign:'left', fontFamily:'inherit', width:'100%' }}>
                        <InitialAvatar name={`${j.cleaner_first} ${j.cleaner_last}`}/>
                        <div>
                          <p style={{ fontSize:13, fontWeight:600, color:'#1A1917', margin:'0 0 2px 0' }}>{j.cleaner_first} {j.cleaner_last}</p>
                          <p style={{ fontSize:11, color:'#6B6860', margin:0 }}>{shortDate(j.scheduled_date)} · {SERVICE_LABELS[j.service_type] || j.service_type}</p>
                        </div>
                      </button>
                    ))}
                    {[...jobs.past, ...jobs.upcoming].filter(j => j.cleaner_first).length === 0 && (
                      <p style={{ fontSize:13, color:'#9E9B94', margin:0 }}>No services with assigned cleaners found.</p>
                    )}
                  </div>
                </div>

                {tipJob && (
                  <>
                    <p style={EYEBROW}>Tip Amount</p>
                    <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap' }}>
                      {[5,10,15,20].map(a => (
                        <button key={a} onClick={() => { setTipAmount(a); setCustomTip(''); }}
                          style={{ flex:1, minWidth:64, height:44, border:`2px solid ${tipAmount===a&&!customTip ? brandColor : '#E5E2DC'}`, borderRadius:10, background: tipAmount===a&&!customTip ? `${brandColor}15` : '#FFFFFF', fontSize:15, fontWeight:700, color: tipAmount===a&&!customTip ? brandColor : '#1A1917', cursor:'pointer', fontFamily:'inherit' }}>
                          ${a}
                        </button>
                      ))}
                    </div>
                    <div style={{ marginBottom:20 }}>
                      <input type="number" placeholder="Custom amount" value={customTip}
                        onChange={e => { setCustomTip(e.target.value); setTipAmount(0); }}
                        style={INPUT}/>
                    </div>
                    <button onClick={sendTip} disabled={(!tipAmount && !customTip) || !caps.payInvoice}
                      style={primaryBtn({ width:'100%', opacity:((!tipAmount && !customTip) || !caps.payInvoice) ? 0.5 : 1 })}>
                      Send Tip ${customTip || tipAmount}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
