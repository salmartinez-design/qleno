import { useState, useEffect, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { Star, Calendar, Clock, ChevronRight, LogOut, Zap, DollarSign, Camera, User } from "lucide-react";

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

function InitialAvatar({ name }: { name: string }) {
  const initials = name.split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase();
  return (
    <div style={{ width:36, height:36, borderRadius:18, background:'#EBF4FF', color:'#5B9BD5', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:700, flexShrink:0 }}>
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
            stroke={`${(hover || value) >= i ? '#F59E0B' : '#D1D5DB'}`} strokeWidth={1.5}>
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </button>
      ))}
    </div>
  );
}

export default function PortalDashboardPage() {
  const { slug } = useParams<{ slug: string }>();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<'home'|'history'|'tip'>('home');

  const [client, setClient] = useState<any>(null);
  const [company, setCompany] = useState<any>(null);
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
        setJobs(j.upcoming ? j : { upcoming: [], past: [] });
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [slug]);

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

  function logout() {
    localStorage.removeItem(`portal_token_${slug}`);
    navigate(`/portal/${slug}/login`);
  }

  const brandColor = company?.brand_color || '#5B9BD5';
  const nextJob = jobs.upcoming[0];
  const lastJob = jobs.past[0];

  if (loading) {
    return (
      <div style={{ minHeight:'100vh', background:'#F7F6F3', display:'flex', alignItems:'center', justifyContent:'center' }}>
        <p style={{ color:'#9E9B94', fontSize:14 }}>Loading your portal…</p>
      </div>
    );
  }

  return (
    <div style={{ minHeight:'100vh', background:'#F7F6F3', fontFamily:"'Plus Jakarta Sans', sans-serif" }}>
      <style>{`@keyframes spin { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }`}</style>
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
            <span style={{ fontSize:13, color:'#6B7280' }}>Hi, {client?.first_name}</span>
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
            <div style={{ position:'fixed', bottom:20, left:'50%', transform:'translateX(-50%)', background:'#FEE2E2', color:'#DC2626', padding:'8px 16px', borderRadius:8, fontSize:12, fontWeight:600, zIndex:999 }}>
              {uploadError}
              <button onClick={() => setUploadError('')} style={{ marginLeft:8, background:'none', border:'none', cursor:'pointer', color:'#DC2626', fontWeight:800 }}>×</button>
            </div>
          )}
        </div>

        {/* Tab Bar */}
        <div style={{ maxWidth:680, margin:'0 auto', display:'flex', gap:0 }}>
          {([['home','Home'],['history','History'],['tip','Tip My Cleaner']] as const).map(([key, label]) => (
            <button key={key} onClick={() => setActiveTab(key as any)}
              style={{
                padding:'10px 16px', background:'none', border:'none', cursor:'pointer',
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
            {/* Next Cleaning */}
            {nextJob ? (
              <div style={{ background:`${brandColor}15`, border:`1px solid ${brandColor}30`, borderRadius:14, padding:'20px 22px' }}>
                <p style={{ fontSize:11, fontWeight:700, color:brandColor, textTransform:'uppercase', letterSpacing:'0.07em', margin:'0 0 12px 0' }}>Your Next Cleaning</p>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                  <div>
                    <p style={{ fontSize:18, fontWeight:700, color:'#1A1917', margin:'0 0 4px 0' }}>
                      {new Date(nextJob.scheduled_date + 'T00:00:00').toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' })}
                    </p>
                    {nextJob.scheduled_time && (
                      <p style={{ fontSize:14, color:'#6B7280', margin:'0 0 4px 0', display:'flex', alignItems:'center', gap:5 }}>
                        <Clock size={13}/>{nextJob.scheduled_time}
                      </p>
                    )}
                    <p style={{ fontSize:13, color:'#6B7280', margin:0 }}>{SERVICE_LABELS[nextJob.service_type] || nextJob.service_type}</p>
                  </div>
                  {(nextJob.cleaner_first) && (
                    <div style={{ textAlign:'center' }}>
                      <InitialAvatar name={`${nextJob.cleaner_first} ${nextJob.cleaner_last}`}/>
                      <p style={{ fontSize:11, color:'#6B7280', margin:'4px 0 0 0' }}>{nextJob.cleaner_first}</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:14, padding:'24px', textAlign:'center' }}>
                <Calendar size={32} color="#D1D5DB" style={{ marginBottom:10 }}/>
                <p style={{ fontSize:14, color:'#9E9B94', margin:0 }}>No upcoming cleanings scheduled</p>
              </div>
            )}

            {/* Last Cleaning — rate prompt */}
            {lastJob && !ratingSubmitted.has(lastJob.id) && (
              <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:14, padding:'20px 22px' }}>
                <p style={{ fontSize:13, fontWeight:700, color:'#1A1917', margin:'0 0 8px 0' }}>How was your last cleaning?</p>
                <p style={{ fontSize:12, color:'#6B7280', margin:'0 0 14px 0' }}>
                  {new Date(lastJob.scheduled_date + 'T00:00:00').toLocaleDateString()} · {SERVICE_LABELS[lastJob.service_type] || lastJob.service_type}
                </p>
                <StarRatingInput
                  value={rating[lastJob.id]?.score || 0}
                  onChange={v => setRating(p => ({ ...p, [lastJob.id]: { ...(p[lastJob.id]||{}), score:v, comment:p[lastJob.id]?.comment||'' } }))}/>
                {rating[lastJob.id]?.score > 0 && (
                  <>
                    <textarea placeholder="Leave a comment (optional)…"
                      value={rating[lastJob.id]?.comment || ''}
                      onChange={e => setRating(p => ({ ...p, [lastJob.id]: { ...p[lastJob.id], comment:e.target.value } }))}
                      style={{ width:'100%', height:60, padding:'8px 12px', border:'1px solid #E5E2DC', borderRadius:8, fontSize:13, resize:'none', outline:'none', fontFamily:'inherit', marginTop:10, marginBottom:10 }}/>
                    <button onClick={() => submitRating(lastJob.id)}
                      style={{ padding:'8px 18px', background:brandColor, color:'#FFFFFF', border:'none', borderRadius:8, fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:'inherit' }}>
                      Submit Rating
                    </button>
                  </>
                )}
              </div>
            )}
            {lastJob && ratingSubmitted.has(lastJob.id) && (
              <div style={{ background:'#DCFCE7', border:'1px solid #BBF7D0', borderRadius:14, padding:'16px 20px', display:'flex', alignItems:'center', gap:10 }}>
                <Star size={18} color="#166534" fill="#166534"/>
                <p style={{ fontSize:13, fontWeight:600, color:'#166534', margin:0 }}>Thank you for your rating!</p>
              </div>
            )}

            {/* Quick Actions */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              {[
                { icon: <DollarSign size={20} color={brandColor}/>, label:'Tip My Cleaner', action:()=>setActiveTab('tip') },
                { icon: <Calendar size={20} color={brandColor}/>, label:'Service History', action:()=>setActiveTab('history') },
              ].map(a => (
                <button key={a.label} onClick={a.action}
                  style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:12, padding:'16px 18px', display:'flex', alignItems:'center', gap:12, cursor:'pointer', textAlign:'left', fontFamily:'inherit' }}>
                  {a.icon}
                  <span style={{ fontSize:13, fontWeight:600, color:'#1A1917' }}>{a.label}</span>
                  <ChevronRight size={14} color="#9E9B94" style={{ marginLeft:'auto' }}/>
                </button>
              ))}
            </div>

            {/* Loyalty */}
            {client?.loyalty_points > 0 && (
              <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:14, padding:'16px 20px', display:'flex', alignItems:'center', gap:12 }}>
                <Zap size={20} color="#F59E0B" fill="#FEF3C7"/>
                <div style={{ flex:1 }}>
                  <p style={{ fontSize:13, fontWeight:700, color:'#1A1917', margin:'0 0 2px 0' }}>{client.loyalty_points} Loyalty Points</p>
                  <div style={{ height:6, borderRadius:3, background:'#F3F4F6', overflow:'hidden' }}>
                    <div style={{ height:'100%', width:`${Math.min((client.loyalty_points/500)*100,100)}%`, background:brandColor, borderRadius:3, transition:'width 0.4s' }}/>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── HISTORY TAB ── */}
        {activeTab === 'history' && (
          <div>
            <h2 style={{ fontSize:16, fontWeight:700, color:'#1A1917', margin:'0 0 16px 0' }}>Service History</h2>
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {jobs.past.length === 0 && (
                <div style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:12, padding:'40px 0', textAlign:'center' }}>
                  <p style={{ color:'#9E9B94', fontSize:13 }}>No past services yet</p>
                </div>
              )}
              {jobs.past.map(j => (
                <div key={j.id} style={{ background:'#FFFFFF', border:'1px solid #E5E2DC', borderRadius:12, padding:'16px 18px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                    <div>
                      <p style={{ fontSize:13, fontWeight:600, color:'#1A1917', margin:'0 0 3px 0' }}>
                        {new Date(j.scheduled_date + 'T00:00:00').toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric', year:'numeric' })}
                      </p>
                      <p style={{ fontSize:12, color:'#6B7280', margin:0 }}>{SERVICE_LABELS[j.service_type] || j.service_type}</p>
                    </div>
                    <div style={{ textAlign:'right' }}>
                      <span style={{ fontSize:11, background:j.status==='complete'?'#DCFCE7':'#F3F4F6', color:j.status==='complete'?'#166534':'#6B7280', padding:'3px 8px', borderRadius:10, fontWeight:600 }}>
                        {j.status?.toUpperCase()}
                      </span>
                      {j.cleaner_first && (
                        <p style={{ fontSize:11, color:'#9E9B94', margin:'5px 0 0 0' }}>Cleaner: {j.cleaner_first}</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── TIP TAB ── */}
        {activeTab === 'tip' && (
          <div>
            <h2 style={{ fontSize:16, fontWeight:700, color:'#1A1917', margin:'0 0 16px 0' }}>Tip My Cleaner</h2>
            {tipSent ? (
              <div style={{ background:'#DCFCE7', border:'1px solid #BBF7D0', borderRadius:14, padding:'32px', textAlign:'center' }}>
                <Star size={40} color="#166534" fill="#DCFCE7" style={{ marginBottom:12 }}/>
                <p style={{ fontSize:16, fontWeight:700, color:'#166534', margin:'0 0 6px 0' }}>Tip sent!</p>
                <p style={{ fontSize:13, color:'#6B7280', margin:0 }}>Your cleaner will love you for it.</p>
              </div>
            ) : (
              <>
                {/* Job selector */}
                <div style={{ marginBottom:16 }}>
                  <p style={{ fontSize:12, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.05em', margin:'0 0 8px 0' }}>Select a service to tip for</p>
                  <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                    {[...jobs.upcoming, ...jobs.past].slice(0,5).filter(j => j.cleaner_first).map(j => (
                      <button key={j.id} onClick={() => setTipJob(j)}
                        style={{ background: tipJob?.id===j.id ? `${brandColor}15` : '#FFFFFF', border:`1px solid ${tipJob?.id===j.id ? brandColor : '#E5E2DC'}`, borderRadius:10, padding:'12px 16px', display:'flex', alignItems:'center', gap:12, cursor:'pointer', textAlign:'left', fontFamily:'inherit', width:'100%' }}>
                        <InitialAvatar name={`${j.cleaner_first} ${j.cleaner_last}`}/>
                        <div>
                          <p style={{ fontSize:13, fontWeight:600, color:'#1A1917', margin:'0 0 2px 0' }}>{j.cleaner_first} {j.cleaner_last}</p>
                          <p style={{ fontSize:11, color:'#6B7280', margin:0 }}>{new Date(j.scheduled_date + 'T00:00:00').toLocaleDateString()} · {SERVICE_LABELS[j.service_type] || j.service_type}</p>
                        </div>
                      </button>
                    ))}
                    {[...jobs.upcoming, ...jobs.past].filter(j => j.cleaner_first).length === 0 && (
                      <p style={{ fontSize:13, color:'#9E9B94', margin:0 }}>No services with assigned cleaners found.</p>
                    )}
                  </div>
                </div>

                {tipJob && (
                  <>
                    <p style={{ fontSize:12, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.05em', margin:'0 0 8px 0' }}>Tip Amount</p>
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
                        style={{ width:'100%', height:42, padding:'0 14px', border:'1px solid #E5E2DC', borderRadius:9, fontSize:14, color:'#1A1917', outline:'none' }}/>
                    </div>
                    <button onClick={sendTip} disabled={!tipAmount && !customTip}
                      style={{ width:'100%', height:46, background:brandColor, color:'#FFFFFF', border:'none', borderRadius:9, fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:'inherit', opacity:(!tipAmount && !customTip) ? 0.5 : 1 }}>
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
