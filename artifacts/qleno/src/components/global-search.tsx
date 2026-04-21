import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { Search, User, Briefcase, FileText, X } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const SERVICE_LABELS: Record<string, string> = {
  standard_clean: 'Standard Clean', deep_clean: 'Deep Clean',
  move_out: 'Move Out Clean', recurring: 'Recurring', post_construction: 'Post-Construction',
  office_cleaning: 'Office Cleaning', move_in: 'Move In', common_areas: 'Common Areas',
};

interface SearchResults {
  clients: any[];
  jobs: any[];
  employees: any[];
  invoices: any[];
}

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
  const totalResults = results ? results.clients.length + results.jobs.length + results.employees.length + results.invoices.length : 0;

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
            placeholder="Search clients, jobs, employees, invoices…"
            style={{ flex:1, border:'none', outline:'none', fontSize:15, color:'#1A1917', fontFamily:"'Plus Jakarta Sans', sans-serif", background:'transparent' }}/>
          {query && <button onClick={() => setQuery('')} style={{ background:'none', border:'none', cursor:'pointer', padding:2, color:'#9E9B94' }}><X size={16}/></button>}
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
                    <div style={{ width:32, height:32, borderRadius:16, background: c.zone_color ? `${c.zone_color}22` : '#EBF4FF', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, border: c.zone_color ? `2px solid ${c.zone_color}` : 'none' }}>
                      {c.zone_color
                        ? <span style={{ width:10, height:10, borderRadius:'50%', background: c.zone_color, display:'inline-block' }}/>
                        : <User size={15} color="#5B9BD5"/>
                      }
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <p style={{ fontSize:13, fontWeight:600, color:'#1A1917', margin:0 }}>{c.first_name} {c.last_name}</p>
                      <p style={{ fontSize:11, color:'#9E9B94', margin:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.address || c.email || c.phone}{c.zone_name ? ` · ${c.zone_name}` : ''}</p>
                    </div>
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
                      <p style={{ fontSize:13, fontWeight:600, color:'#1A1917', margin:0 }}>INV-{String(i.id).padStart(4,'0')} · {i.client_name}</p>
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
