import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function PortalLoginPage() {
  const { slug } = useParams<{ slug: string }>();
  const [, navigate] = useLocation();

  const [company, setCompany] = useState<{ name: string; logo_url: string | null; brand_color: string } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/portal/company/${slug}`)
      .then(r => r.json())
      .then(d => { if (d.id) setCompany(d); else setError('Company not found'); })
      .catch(() => setError('Could not load company'))
      .finally(() => setLoading(false));
  }, [slug]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const r = await fetch(`${API}/api/portal/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, company_slug: slug }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Login failed'); setSubmitting(false); return; }
      localStorage.setItem(`portal_token_${slug}`, d.token);
      navigate(`/portal/${slug}/dashboard`);
    } catch { setError('Network error'); setSubmitting(false); }
  }

  const brandColor = company?.brand_color || '#5B9BD5';

  if (loading) {
    return (
      <div style={{ minHeight:'100vh', background:'#F7F6F3', display:'flex', alignItems:'center', justifyContent:'center' }}>
        <p style={{ color:'#9E9B94', fontSize:14 }}>Loading…</p>
      </div>
    );
  }

  return (
    <div style={{ minHeight:'100vh', background:'#F7F6F3', display:'flex', alignItems:'center', justifyContent:'center', padding:20, fontFamily:"'Plus Jakarta Sans', sans-serif" }}>
      <div style={{ background:'#FFFFFF', borderRadius:14, padding:'40px 36px', width:'100%', maxWidth:420, boxShadow:'0 4px 32px rgba(0,0,0,0.10)' }}>

        <div style={{ textAlign:'center', marginBottom:28 }}>
          {company?.logo_url ? (
            <img src={company.logo_url} alt={company.name} style={{ height:52, marginBottom:14, objectFit:'contain' }}/>
          ) : (
            <div style={{ width:52, height:52, borderRadius:12, background:`${brandColor}20`, display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 14px' }}>
              <span style={{ fontSize:18, fontWeight:800, color:brandColor }}>CP</span>
            </div>
          )}
          <h2 style={{ fontSize:22, fontWeight:700, color:'#1A1917', margin:'0 0 6px 0' }}>{company?.name || 'Client Portal'}</h2>
          <p style={{ fontSize:14, color:'#6B6860', margin:0 }}>Sign in to your client account</p>
        </div>

        {error && (
          <div style={{ background:'#FEE2E2', border:'1px solid #FECACA', borderRadius:8, padding:'10px 14px', marginBottom:16 }}>
            <p style={{ fontSize:13, color:'#991B1B', margin:0 }}>{error}</p>
          </div>
        )}

        <form onSubmit={handleLogin}>
          <div style={{ marginBottom:14 }}>
            <label style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Email Address</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com" required
              style={{ width:'100%', height:40, padding:'0 14px', border:'1px solid #E5E2DC', borderRadius:9, fontSize:14, color:'#1A1917', outline:'none', background:'#FFFFFF' }}/>
          </div>
          <div style={{ marginBottom:24 }}>
            <label style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required
              style={{ width:'100%', height:40, padding:'0 14px', border:'1px solid #E5E2DC', borderRadius:9, fontSize:14, color:'#1A1917', outline:'none', background:'#FFFFFF' }}/>
          </div>
          <button type="submit" disabled={submitting}
            style={{ width:'100%', height:46, background:brandColor, color:'#FFFFFF', border:'none', borderRadius:9, fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>
            {submitting ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <p style={{ textAlign:'center', fontSize:12, color:'#9E9B94', marginTop:20 }}>
          Powered by <strong style={{ color:'#1A1917' }}>Qleno</strong>
        </p>
      </div>
    </div>
  );
}
