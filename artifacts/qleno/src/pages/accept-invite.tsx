import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { Check, Eye, EyeOff } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

function Req({ met, label }: { met: boolean; label: string }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
      <div style={{ width:16, height:16, borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center',
        background: met ? '#DCFCE7' : '#F3F4F6', border: `1px solid ${met?'#BBF7D0':'#D1D5DB'}` }}>
        {met && <Check size={10} color="#166534" strokeWidth={3}/>}
      </div>
      <span style={{ fontSize:12, color: met ? '#166534' : '#6B7280' }}>{label}</span>
    </div>
  );
}

export default function AcceptInvitePage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const token = new URLSearchParams(search).get('token') || '';

  const [invite, setInvite] = useState<{ email: string; first_name: string; last_name: string } | null>(null);
  const [invalid, setInvalid] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const has8 = password.length >= 8;
  const hasUpper = /[A-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);

  useEffect(() => {
    if (!token) { setInvalid('No invite token provided.'); setLoading(false); return; }
    fetch(`${API}/api/users/invite/${token}`)
      .then(r => r.json())
      .then(d => {
        if (d.valid) setInvite(d);
        else setInvalid(d.error || 'Invalid or expired invite link.');
      })
      .catch(() => setInvalid('Could not validate invite.'))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!has8 || !hasUpper || !hasNumber) { setError('Password does not meet requirements.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setSubmitting(true);
    try {
      const r = await fetch(`${API}/api/users/invite/${token}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Failed to create account.'); setSubmitting(false); return; }
      localStorage.setItem('token', d.token);
      setDone(true);
      setTimeout(() => navigate('/my-jobs'), 1500);
    } catch { setError('Network error. Please try again.'); setSubmitting(false); }
  }

  if (loading) {
    return (
      <div style={{ minHeight:'100vh', background:'#F7F6F3', display:'flex', alignItems:'center', justifyContent:'center' }}>
        <p style={{ fontSize:14, color:'#9E9B94' }}>Validating invite…</p>
      </div>
    );
  }

  if (invalid) {
    return (
      <div style={{ minHeight:'100vh', background:'#F7F6F3', display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
        <div style={{ background:'#FFFFFF', borderRadius:12, padding:'40px 36px', width:'100%', maxWidth:440, boxShadow:'0 4px 24px rgba(0,0,0,0.08)', textAlign:'center' }}>
          <div style={{ width:48,height:48,borderRadius:24,background:'#FEE2E2',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 16px' }}>
            <span style={{ fontSize:14, fontWeight:700, color:'#DC2626' }}>X</span>
          </div>
          <h2 style={{ fontSize:20, fontWeight:700, color:'#1A1917', margin:'0 0 8px 0' }}>Invalid Invite</h2>
          <p style={{ fontSize:14, color:'#6B7280', margin:'0 0 20px 0' }}>{invalid}</p>
          <button onClick={() => navigate('/login')}
            style={{ padding:'10px 20px', background:'var(--brand, #5B9BD5)', color:'#FFFFFF', border:'none', borderRadius:8, fontSize:13, fontWeight:600, cursor:'pointer' }}>
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight:'100vh', background:'#F7F6F3', display:'flex', alignItems:'center', justifyContent:'center', padding:20, fontFamily:"'Plus Jakarta Sans', sans-serif" }}>
      <div style={{ background:'#FFFFFF', borderRadius:12, padding:'40px 36px', width:'100%', maxWidth:440, boxShadow:'0 4px 24px rgba(0,0,0,0.08)' }}>

        <div style={{ textAlign:'center', marginBottom:28 }}>
          <div style={{ width:52, height:52, borderRadius:12, background:'var(--brand-dim, #EBF4FF)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 16px' }}>
            <span style={{ fontSize:20, fontWeight:700, color:'var(--brand, #5B9BD5)' }}>C</span>
          </div>
          <h2 style={{ fontSize:22, fontWeight:700, color:'#1A1917', margin:'0 0 6px 0' }}>
            Welcome, {invite?.first_name}!
          </h2>
          <p style={{ fontSize:14, color:'#6B6860', margin:0 }}>Set up your Qleno account to get started</p>
        </div>

        {done && (
          <div style={{ background:'#DCFCE7', border:'1px solid #BBF7D0', borderRadius:8, padding:'12px 16px', marginBottom:16, display:'flex', alignItems:'center', gap:8 }}>
            <Check size={16} color="#166534"/>
            <p style={{ fontSize:13, color:'#166534', margin:0, fontWeight:600 }}>Account created! Redirecting…</p>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom:14 }}>
            <label style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Email</label>
            <input value={invite?.email || ''} readOnly
              style={{ width:'100%', height:38, padding:'0 12px', border:'1px solid #E5E2DC', borderRadius:8, fontSize:13, color:'#9E9B94', background:'#F7F6F3', outline:'none' }}/>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:14 }}>
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>First Name</label>
              <input value={invite?.first_name || ''} readOnly
                style={{ width:'100%', height:38, padding:'0 12px', border:'1px solid #E5E2DC', borderRadius:8, fontSize:13, color:'#9E9B94', background:'#F7F6F3', outline:'none' }}/>
            </div>
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Last Name</label>
              <input value={invite?.last_name || ''} readOnly
                style={{ width:'100%', height:38, padding:'0 12px', border:'1px solid #E5E2DC', borderRadius:8, fontSize:13, color:'#9E9B94', background:'#F7F6F3', outline:'none' }}/>
            </div>
          </div>

          <div style={{ marginBottom:8 }}>
            <label style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Create Password</label>
            <div style={{ position:'relative' }}>
              <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                placeholder="Min. 8 characters"
                style={{ width:'100%', height:38, padding:'0 40px 0 12px', border:'1px solid #E5E2DC', borderRadius:8, fontSize:13, color:'#1A1917', background:'#FFFFFF', outline:'none' }}/>
              <button type="button" onClick={() => setShowPw(p => !p)}
                style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', color:'#9E9B94', padding:0 }}>
                {showPw ? <EyeOff size={16}/> : <Eye size={16}/>}
              </button>
            </div>
          </div>

          <div style={{ background:'#F7F6F3', borderRadius:8, padding:'10px 14px', marginBottom:14, display:'flex', flexDirection:'column', gap:6 }}>
            <Req met={has8} label="At least 8 characters"/>
            <Req met={hasUpper} label="One uppercase letter"/>
            <Req met={hasNumber} label="One number"/>
          </div>

          <div style={{ marginBottom:20 }}>
            <label style={{ fontSize:11, fontWeight:600, color:'#9E9B94', textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Confirm Password</label>
            <input type={showPw ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)}
              placeholder="Re-enter password"
              style={{ width:'100%', height:38, padding:'0 12px', border:`1px solid ${confirm && confirm!==password?'#EF4444':'#E5E2DC'}`, borderRadius:8, fontSize:13, color:'#1A1917', background:'#FFFFFF', outline:'none' }}/>
          </div>

          {error && (
            <div style={{ background:'#FEE2E2', border:'1px solid #FECACA', borderRadius:8, padding:'10px 14px', marginBottom:16 }}>
              <p style={{ fontSize:13, color:'#991B1B', margin:0 }}>{error}</p>
            </div>
          )}

          <button type="submit" disabled={submitting || done}
            style={{ width:'100%', height:44, background:'var(--brand, #5B9BD5)', color:'#FFFFFF', border:'none', borderRadius:8, fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>
            {submitting ? 'Creating Account…' : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  );
}
