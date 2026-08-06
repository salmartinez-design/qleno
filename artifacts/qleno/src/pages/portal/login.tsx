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
  const [notice, setNotice] = useState('');
  const [forgot, setForgot] = useState(false);
  // [portal-google 2026-08-06] The button renders only when the tenant has a
  // Google client id configured. Until then this stays false and the page looks
  // exactly as it did — the feature is inert, not half-present.
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);
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
      const r = await fetch(`${API}/api/portal/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, company_slug: slug }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.message || d.error || 'Sign-in failed'); setSubmitting(false); return; }
      localStorage.setItem(`portal_token_${slug}`, d.token);
      localStorage.setItem(`portal_caps_${slug}`, JSON.stringify(d.capabilities ?? {}));
      navigate(`/portal/${slug}/dashboard`);
    } catch { setError('Network error'); setSubmitting(false); }
  }

  // Load the Google config, and only then inject Google's script. Nothing
  // third-party is loaded on a portal that hasn't enabled it.
  useEffect(() => {
    fetch(`${API}/api/portal/auth/google/config`)
      .then(r => r.json())
      .then(d => { if (d?.enabled && d.client_id) setGoogleClientId(d.client_id); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!googleClientId || forgot) return;
    const render = () => {
      const g = (window as any).google?.accounts?.id;
      const host = document.getElementById('qleno-google-btn');
      if (!g || !host) return;
      g.initialize({
        client_id: googleClientId,
        callback: (resp: any) => handleGoogle(resp?.credential),
      });
      g.renderButton(host, { theme: 'outline', size: 'large', width: 348, text: 'signin_with' });
    };
    if ((window as any).google?.accounts?.id) { render(); return; }
    const existing = document.getElementById('gsi-script');
    if (existing) { existing.addEventListener('load', render); return; }
    const sc = document.createElement('script');
    sc.src = 'https://accounts.google.com/gsi/client';
    sc.async = true; sc.defer = true; sc.id = 'gsi-script';
    sc.onload = render;
    document.head.appendChild(sc);
  }, [googleClientId, forgot]);

  async function handleGoogle(credential?: string) {
    if (!credential) return;
    setError(''); setSubmitting(true);
    try {
      const r = await fetch(`${API}/api/portal/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential, company_slug: slug }),
      });
      const d = await r.json();
      if (!r.ok) {
        // The server will not say whether the address is a customer of this
        // company; the copy must not imply otherwise.
        setError(d.message || 'Sign-in failed');
        setSubmitting(false);
        return;
      }
      localStorage.setItem(`portal_token_${slug}`, d.token);
      localStorage.setItem(`portal_caps_${slug}`, JSON.stringify(d.capabilities ?? {}));
      navigate(d.capabilities?.kind === 'commercial'
        ? `/portal/${slug}/account`
        : `/portal/${slug}/dashboard`);
    } catch { setError('Network error'); setSubmitting(false); }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setSubmitting(true);
    try {
      const r = await fetch(`${API}/api/portal/auth/forgot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, company_slug: slug }),
      });
      const d = await r.json();
      // Always a success shape — the server will not confirm whether the
      // address is on file, and neither does this copy.
      setNotice(d.message || 'If that email has a login, a reset link is on its way');
      setForgot(false);
    } catch { setError('Network error'); }
    finally { setSubmitting(false); }
  }

  const brandColor = company?.brand_color || 'var(--brand)';

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
          <p style={{ fontSize:14, color:'#6B6860', margin:0 }}>
            {forgot ? 'Enter your email and we will send a reset link' : 'Sign in to your account'}
          </p>
        </div>

        {notice && (
          <div style={{ background:'#E6F6F1', border:'1px solid #C7E7DE', borderRadius:8, padding:'10px 14px', marginBottom:16 }}>
            <p style={{ fontSize:13, color:'#0F7A63', margin:0 }}>{notice}</p>
          </div>
        )}

        {error && (
          <div style={{ background:'#FCEBEA', border:'1px solid #F1D0CB', borderRadius:8, padding:'10px 14px', marginBottom:16 }}>
            <p style={{ fontSize:13, color:'#B3261E', margin:0 }}>{error}</p>
          </div>
        )}

        {googleClientId && !forgot && (
          <>
            <div id="qleno-google-btn" style={{ display:'flex', justifyContent:'center', marginBottom:16 }} />
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:16 }}>
              <div style={{ flex:1, height:1, background:'#E5E2DC' }} />
              <span style={{ fontSize:12, color:'#9E9B94' }}>or</span>
              <div style={{ flex:1, height:1, background:'#E5E2DC' }} />
            </div>
          </>
        )}

        <form onSubmit={forgot ? handleForgot : handleLogin}>
          <div style={{ marginBottom:14 }}>
            <label style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Email Address</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com" required
              style={{ width:'100%', height:40, padding:'0 14px', border:'1px solid #E5E2DC', borderRadius:9, fontSize:14, color:'#1A1917', outline:'none', background:'#FFFFFF' }}/>
          </div>
          {!forgot && (
            <div style={{ marginBottom:24 }}>
              <label style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required
                style={{ width:'100%', height:40, padding:'0 14px', border:'1px solid #E5E2DC', borderRadius:9, fontSize:14, color:'#1A1917', outline:'none', background:'#FFFFFF' }}/>
            </div>
          )}
          <button type="submit" disabled={submitting}
            style={{ width:'100%', height:46, background:brandColor, color:'#FFFFFF', border:'none', borderRadius:9, fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>
            {submitting ? (forgot ? 'Sending…' : 'Signing in…') : (forgot ? 'Send reset link' : 'Sign In')}
          </button>

          <button type="button"
            onClick={() => { setForgot(f => !f); setError(''); setNotice(''); }}
            style={{ display:'block', margin:'14px auto 0', background:'none', border:'none', padding:0, fontSize:13, color:'#6B6860', cursor:'pointer', fontFamily:'inherit', textDecoration:'underline' }}>
            {forgot ? 'Back to sign in' : 'Forgot your password?'}
          </button>
        </form>

        <p style={{ textAlign:'center', fontSize:12, color:'#9E9B94', marginTop:20 }}>
          Powered by <strong style={{ color:'#1A1917' }}>Qleno</strong>
        </p>
      </div>
    </div>
  );
}
