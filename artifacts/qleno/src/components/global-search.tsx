import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { Search, User, UserPlus, Briefcase, FileText, X, Mic } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { formatInvoiceNumber } from "@/lib/invoice-number";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const SERVICE_LABELS: Record<string, string> = {
  standard_clean: 'Standard Clean', deep_clean: 'Deep Clean',
  move_out: 'Move Out Clean', recurring: 'Recurring', post_construction: 'Post-Construction',
  office_cleaning: 'Office Cleaning', move_in: 'Move In', common_areas: 'Common Areas',
};

interface SearchResults {
  clients: any[];
  leads: any[];
  jobs: any[];
  employees: any[];
  invoices: any[];
}

// Lead pipeline stage → short label + chip colors for the search row badge.
const LEAD_STATUS: Record<string, { label: string; bg: string; color: string }> = {
  needs_contacted: { label: 'New', bg: '#F3F4F6', color: '#6B7280' },
  contacted: { label: 'Contacted', bg: '#DBEAFE', color: '#1D4ED8' },
  quoted: { label: 'Quoted', bg: '#FEF3C7', color: '#92400E' },
  booked: { label: 'Booked', bg: '#DCFCE7', color: '#166534' },
  closed: { label: 'Lost', bg: '#FEE2E2', color: '#B91C1C' },
  lost: { label: 'Lost', bg: '#FEE2E2', color: '#B91C1C' },
};

interface Props {
  onClose: () => void;
}

export function GlobalSearch({ onClose }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [, navigate] = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
  const [listening, setListening] = useState(false);

  // Voice search via the browser Web Speech API (no backend / API key needed).
  // The mic dictates straight into the query box, which drives the existing
  // debounced search. Hidden on browsers without speech recognition.
  const voiceSupported = typeof window !== 'undefined' &&
    !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  const toggleVoice = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    if (listening) { recognitionRef.current?.stop(); return; }
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e: any) => {
      const transcript = Array.from(e.results).map((res: any) => res[0].transcript).join('');
      setQuery(transcript);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  }, [listening]);
  useEffect(() => () => { try { recognitionRef.current?.stop(); } catch { /* noop */ } }, []);
  const timerRef = useRef<any>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    setHighlighted(0);
    if (query.trim().length < 2) { setResults(null); return; }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`${API}/api/search?q=${encodeURIComponent(query)}`, { headers: getAuthHeaders() });
        const d = await r.json();
        setResults(d);
      } catch { }
      setLoading(false);
    }, 250);
    return () => clearTimeout(timerRef.current);
  }, [query]);

  const go = useCallback((path: string) => {
    navigate(path);
    setQuery('');
    onClose();
  }, [navigate, onClose]);

  // Build flat list of navigable items from results
  const items: { path: string }[] = results ? [
    ...results.clients.map(c => ({ path: `/customers/${c.id}` })),
    ...(results.leads ?? []).map(l => ({ path: `/leads?lead=${l.id}` })),
    ...results.employees.map(e => ({ path: `/employees/${e.id}` })),
    ...results.jobs.map(j => ({ path: `/customers/${j.client_id}` })),
    ...results.invoices.map(i => ({ path: `/invoices` })),
  ] : [];

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (items.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted(h => Math.min(h + 1, items.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); }
    if (e.key === 'Enter')     { e.preventDefault(); go(items[highlighted].path); }
  };

  let itemIndex = 0;
  const totalResults = results ? results.clients.length + (results.leads?.length ?? 0) + results.jobs.length + results.employees.length + results.invoices.length : 0;

  return (
    <div style={{ position:'fixed', inset:0, zIndex:9999, display:'flex', alignItems:'flex-start', justifyContent:'center', paddingTop:80 }}
      onClick={onClose}>
      <div style={{ background:'#FFFFFF', borderRadius:14, boxShadow:'0 20px 60px rgba(0,0,0,0.18)', width:'100%', maxWidth:560, overflow:'hidden', fontFamily:"'Plus Jakarta Sans', sans-serif" }}
        onClick={e => e.stopPropagation()}>

        {/* Input */}
        <div style={{ display:'flex', alignItems:'center', padding:'14px 16px', borderBottom:'1px solid #E5E2DC', gap:10 }}>
          <Search size={18} color="#9E9B94" style={{ flexShrink:0 }}/>
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search clients, leads, jobs, employees, invoices…"
            style={{ flex:1, border:'none', outline:'none', fontSize:15, color:'#1A1917', fontFamily:"'Plus Jakarta Sans', sans-serif", background:'transparent' }}/>
          {query && <button onClick={() => setQuery('')} style={{ background:'none', border:'none', cursor:'pointer', padding:2, color:'#9E9B94' }}><X size={16}/></button>}
          {voiceSupported && (
            <button onClick={toggleVoice} title={listening ? 'Stop listening' : 'Voice search'}
              style={{ background: listening ? 'var(--brand-dim)' : 'none', border:'none', cursor:'pointer', padding:4, borderRadius:6, color: listening ? 'var(--brand)' : '#9E9B94', display:'flex', alignItems:'center', flexShrink:0 }}>
              <Mic size={16}/>
            </button>
          )}
          <kbd style={{ fontSize:11, color:'#9E9B94', border:'1px solid #E5E2DC', borderRadius:4, padding:'2px 6px' }}>ESC</kbd>
        </div>

        {/* Results */}
        <div style={{ maxHeight:400, overflowY:'auto' }}>
          {loading && <p style={{ padding:'20px', textAlign:'center', fontSize:13, color:'#9E9B94' }}>Searching…</p>}

          {!loading && query.trim().length >= 2 && results && totalResults === 0 && (
            <p style={{ padding:'20px', textAlign:'center', fontSize:13, color:'#9E9B94' }}>No results for "{query}"</p>
          )}

          {!loading && results && results.clients.length > 0 && (
            <div>
              <p style={{ fontSize:10, fontWeight:700, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.08em', padding:'12px 16px 6px', margin:0 }}>Clients</p>
              {results.clients.map(c => {
                const idx = itemIndex++;
                const active = idx === highlighted;
                return (
                  <button key={c.id} onClick={() => go(`/customers/${c.id}`)}
                    style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding:'10px 16px', background: active ? '#F5F4F1' : 'none', border:'none', cursor:'pointer', textAlign:'left', fontFamily:'inherit' }}>
                    {/* [search-zone-chip 2026-07-19] Was a zone-colored ring with a
                        solid center dot ("nipple"). Replaced with a neutral initials
                        monogram + an explicit zone chip (colored dot + first segment
                        of the zone name) on the second line — reads as a tidy tag and
                        surfaces the zone by name, not just a color. */}
                    <div style={{ width:34, height:34, borderRadius:9, background:'#F1EFE8', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:12, fontWeight:700, color:'#6B6860' }}>
                      {`${(c.first_name?.[0] || '')}${(c.last_name?.[0] || '')}`.toUpperCase() || <User size={15} color="#5B9BD5"/>}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <p style={{ fontSize:13, fontWeight:600, color:'#1A1917', margin:0, marginBottom: (c.zone_name || c.address || c.email || c.phone) ? 3 : 0 }}>{c.first_name} {c.last_name}</p>
                      <div style={{ display:'flex', alignItems:'center', gap:7, minWidth:0 }}>
                        {c.zone_name && (
                          <span style={{ display:'inline-flex', alignItems:'center', gap:5, background:'#F1EFE8', borderRadius:20, padding:'2px 9px 2px 7px', fontSize:11, fontWeight:600, color:'#44413B', flexShrink:0, maxWidth:170 }}>
                            <span style={{ width:8, height:8, borderRadius:'50%', background: c.zone_color || '#B4B2A9', flexShrink:0 }}/>
                            <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.zone_name.split('/')[0].trim()}</span>
                          </span>
                        )}
                        <span style={{ fontSize:11, color:'#9E9B94', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.address || c.email || c.phone}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {!loading && results && (results.leads?.length ?? 0) > 0 && (
            <div>
              <p style={{ fontSize:10, fontWeight:700, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.08em', padding:'12px 16px 6px', margin:0 }}>Leads</p>
              {results.leads.map(l => {
                const idx = itemIndex++;
                const active = idx === highlighted;
                const st = LEAD_STATUS[l.status] || { label: l.status || '—', bg:'#F3F4F6', color:'#6B7280' };
                const name = `${l.first_name || ''} ${l.last_name || ''}`.trim() || l.email || l.phone || `Lead #${l.id}`;
                return (
                  <button key={l.id} onClick={() => go(`/leads?lead=${l.id}`)}
                    style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding:'10px 16px', background: active ? '#F5F4F1' : 'none', border:'none', cursor:'pointer', textAlign:'left', fontFamily:'inherit' }}>
                    <div style={{ width:32, height:32, borderRadius:8, background:'#F5F3FF', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <UserPlus size={15} color="#7C3AED"/>
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <p style={{ fontSize:13, fontWeight:600, color:'#1A1917', margin:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{name}</p>
                      <p style={{ fontSize:11, color:'#9E9B94', margin:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{l.email || l.phone || 'Lead'}</p>
                    </div>
                    <span style={{ fontSize:10, fontWeight:600, padding:'2px 8px', borderRadius:10, background: st.bg, color: st.color, flexShrink:0 }}>{st.label}</span>
                  </button>
                );
              })}
            </div>
          )}

          {!loading && results && results.employees.length > 0 && (
            <div>
              <p style={{ fontSize:10, fontWeight:700, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.08em', padding:'12px 16px 6px', margin:0 }}>Employees</p>
              {results.employees.map(e => {
                const idx = itemIndex++;
                const active = idx === highlighted;
                return (
                  <button key={e.id} onClick={() => go(`/employees/${e.id}`)}
                    style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding:'10px 16px', background: active ? '#F5F4F1' : 'none', border:'none', cursor:'pointer', textAlign:'left', fontFamily:'inherit' }}>
                    {e.avatar_url
                      ? <img src={e.avatar_url} style={{ width:32, height:32, borderRadius:16, objectFit:'cover', flexShrink:0 }}/>
                      : <div style={{ width:32, height:32, borderRadius:16, background:'#F3F4F6', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:700, color:'#6B7280', flexShrink:0 }}>{e.first_name?.[0]}{e.last_name?.[0]}</div>
                    }
                    <div>
                      <p style={{ fontSize:13, fontWeight:600, color:'#1A1917', margin:0 }}>{e.first_name} {e.last_name}</p>
                      <p style={{ fontSize:11, color:'#9E9B94', margin:0, textTransform:'capitalize' }}>{e.role?.replace('_', ' ')}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {!loading && results && results.jobs.length > 0 && (
            <div>
              <p style={{ fontSize:10, fontWeight:700, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.08em', padding:'12px 16px 6px', margin:0 }}>Jobs</p>
              {results.jobs.map(j => {
                const idx = itemIndex++;
                const active = idx === highlighted;
                return (
                  <button key={j.id} onClick={() => go(`/customers/${j.client_id}`)}
                    style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding:'10px 16px', background: active ? '#F5F4F1' : 'none', border:'none', cursor:'pointer', textAlign:'left', fontFamily:'inherit' }}>
                    <div style={{ width:32, height:32, borderRadius:8, background:'#F0FDF4', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <Briefcase size={15} color="#16A34A"/>
                    </div>
                    <div style={{ flex:1 }}>
                      <p style={{ fontSize:13, fontWeight:600, color:'#1A1917', margin:0 }}>{j.client_name}</p>
                      <p style={{ fontSize:11, color:'#9E9B94', margin:0 }}>{SERVICE_LABELS[j.service_type] || j.service_type} · {new Date(j.scheduled_date + 'T00:00:00').toLocaleDateString()}</p>
                    </div>
                    <span style={{ fontSize:10, fontWeight:600, padding:'2px 8px', borderRadius:10, background: j.status==='complete'?'#DCFCE7': j.status==='in_progress'?'#DBEAFE':'#F3F4F6', color: j.status==='complete'?'#166534': j.status==='in_progress'?'#1D4ED8':'#6B7280' }}>
                      {j.status.toUpperCase().replace('_',' ')}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {!loading && results && results.invoices.length > 0 && (
            <div>
              <p style={{ fontSize:10, fontWeight:700, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.08em', padding:'12px 16px 6px', margin:0 }}>Invoices</p>
              {results.invoices.map(i => {
                const idx = itemIndex++;
                const active = idx === highlighted;
                return (
                  <button key={i.id} onClick={() => go(`/invoices`)}
                    style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding:'10px 16px', background: active ? '#F5F4F1' : 'none', border:'none', cursor:'pointer', textAlign:'left', fontFamily:'inherit' }}>
                    <div style={{ width:32, height:32, borderRadius:8, background:'#FFFBEB', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <FileText size={15} color="#D97706"/>
                    </div>
                    <div style={{ flex:1 }}>
                      <p style={{ fontSize:13, fontWeight:600, color:'#1A1917', margin:0 }}>{formatInvoiceNumber(i)} · {i.client_name}</p>
                      <p style={{ fontSize:11, color:'#9E9B94', margin:0 }}>${parseFloat(i.total || '0').toFixed(2)} · {i.status}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {!query.trim() && (
            <div style={{ padding:'20px 16px' }}>
              <p style={{ fontSize:12, color:'#9E9B94', margin:'0 0 10px 0', fontWeight:600 }}>Quick Navigate</p>
              {[
                { label:'Dashboard', path:'/dashboard' },
                { label:'Jobs / Dispatch', path:'/jobs' },
                { label:'Employees', path:'/employees' },
                { label:'Customers', path:'/customers' },
                { label:'Invoices', path:'/invoices' },
                { label:'Insights', path:'/reports/insights' },
              ].map(item => (
                <button key={item.path} onClick={() => go(item.path)}
                  style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding:'8px 10px', background:'none', border:'none', cursor:'pointer', borderRadius:8, textAlign:'left', fontFamily:'inherit', marginBottom:2 }}>
                  <span style={{ width:6, height:6, borderRadius:3, background:'#C5C3BE', flexShrink:0 }}/>
                  <span style={{ fontSize:13, color:'#1A1917', fontWeight:500 }}>{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding:'8px 16px', borderTop:'1px solid #E5E2DC', display:'flex', gap:16 }}>
          {[['↵','Select'],['↑↓','Navigate'],['ESC','Close']].map(([k,l]) => (
            <span key={k} style={{ fontSize:11, color:'#9E9B94', display:'flex', alignItems:'center', gap:4 }}>
              <kbd style={{ fontSize:10, border:'1px solid #E5E2DC', borderRadius:3, padding:'1px 5px', color:'#6B7280' }}>{k}</kbd>{l}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
