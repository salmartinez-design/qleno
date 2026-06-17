import { useState, useEffect, FormEvent } from "react";
import { useAuthStore } from "@/lib/auth";
import { KeyRound, X, Lock } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

/**
 * Shared Change Password modal. Used by the desktop dashboard header AND the
 * mobile My Jobs account menu so techs on a phone can change their password
 * without a separate page. Single source of truth — don't duplicate.
 */
export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const token = useAuthStore(state => state.token);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) { setCurrent(''); setNext(''); setConfirm(''); setError(''); setSuccess(false); }
  }, [open]);

  if (!open) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (next.length < 6) { setError('New password must be at least 6 characters.'); return; }
    if (next !== confirm) { setError('Passwords do not match.'); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || 'Failed to update password.'); return; }
      setSuccess(true);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '9px 12px', border: '1px solid #E5E2DC', borderRadius: 8,
    fontSize: 14, fontFamily: FF, outline: 'none', boxSizing: 'border-box', color: '#1A1917',
    backgroundColor: '#FAFAF9',
  };
  const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#6B7280', fontFamily: FF, marginBottom: 4, display: 'block' };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)' }}
      onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 16, width: 380, maxWidth: 'calc(100vw - 32px)', padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--brand-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <KeyRound size={18} style={{ color: 'var(--brand)' }} />
            </div>
            <div>
              <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#1A1917', fontFamily: FF }}>Change Password</p>
              <p style={{ margin: 0, fontSize: 12, color: '#9E9B94', fontFamily: FF }}>Update your login credentials</p>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9E9B94', padding: 4 }}><X size={18} /></button>
        </div>

        {success ? (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#D1FAE5', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
              <Lock size={22} style={{ color: '#059669' }} />
            </div>
            <p style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: '#1A1917', fontFamily: FF }}>Password Updated</p>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: '#6B7280', fontFamily: FF }}>Your new password is active.</p>
            <button onClick={onClose} style={{ padding: '10px 24px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: FF }}>Done</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={labelStyle}>Current Password</label>
              <input type="password" value={current} onChange={e => setCurrent(e.target.value)} style={inputStyle} required autoComplete="current-password" />
            </div>
            <div>
              <label style={labelStyle}>New Password</label>
              <input type="password" value={next} onChange={e => setNext(e.target.value)} style={inputStyle} required autoComplete="new-password" />
            </div>
            <div>
              <label style={labelStyle}>Confirm New Password</label>
              <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} style={inputStyle} required autoComplete="new-password" />
            </div>
            {error && <p style={{ margin: 0, fontSize: 13, color: '#DC2626', fontFamily: FF }}>{error}</p>}
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button type="button" onClick={onClose} style={{ flex: 1, padding: '10px', border: '1px solid #E5E2DC', borderRadius: 8, background: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#6B7280', fontFamily: FF }}>Cancel</button>
              <button type="submit" disabled={loading} style={{ flex: 1, padding: '10px', border: 'none', borderRadius: 8, background: 'var(--brand)', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#fff', fontFamily: FF, opacity: loading ? 0.7 : 1 }}>
                {loading ? 'Saving...' : 'Save Password'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
