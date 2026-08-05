// [customer-portal 2026-08-05] Where both the invite link and the reset link
// land. The customer cannot tell which one they followed, and does not need to:
// POST /api/portal/auth/set-password redeems either kind and signs them in.
//
// Styling mirrors portal/login.tsx exactly — same card, same brand colour from
// the company record — because this is the second screen a customer ever sees
// and it should not look like a different product.
import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// Matches passwordProblem() on the server. Checked here too so the customer
// finds out as they type rather than after a round trip — the server remains
// the authority.
const MIN_LENGTH = 10;

export default function PortalSetPasswordPage() {
  const { slug } = useParams<{ slug: string }>();
  const [, navigate] = useLocation();

  const [company, setCompany] = useState<{ name: string; logo_url: string | null; brand_color: string } | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // The token rides in the query string of the emailed link.
  const token = new URLSearchParams(window.location.search).get("token") || "";

  useEffect(() => {
    fetch(`${API}/api/portal/company/${slug}`)
      .then(r => r.json())
      .then(d => { if (d.id) setCompany(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slug]);

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = password.length >= MIN_LENGTH && password === confirm && !!token;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const r = await fetch(`${API}/api/portal/auth/set-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.message || d.error || "Could not set your password"); setSubmitting(false); return; }
      // The server signs them in on success, so land them in the portal rather
      // than bouncing back to a login form they just proved they can pass.
      localStorage.setItem(`portal_token_${slug}`, d.token);
      navigate(`/portal/${slug}/dashboard`);
    } catch {
      setError("Network error — please try again");
      setSubmitting(false);
    }
  }

  const brandColor = company?.brand_color || "var(--brand)";
  const inputStyle: React.CSSProperties = {
    width: "100%", height: 40, padding: "0 14px", border: "1px solid #E5E2DC",
    borderRadius: 9, fontSize: 14, color: "#1A1917", outline: "none", background: "#FFFFFF",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase",
    letterSpacing: "0.06em", display: "block", marginBottom: 6,
  };

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "#F7F6F3", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "#9E9B94", fontSize: 14 }}>Loading…</p>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#F7F6F3", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <div style={{ background: "#FFFFFF", borderRadius: 14, padding: "40px 36px", width: "100%", maxWidth: 420, boxShadow: "0 4px 32px rgba(0,0,0,0.10)" }}>

        <div style={{ textAlign: "center", marginBottom: 28 }}>
          {company?.logo_url ? (
            <img src={company.logo_url} alt={company.name} style={{ height: 52, marginBottom: 14, objectFit: "contain" }} />
          ) : (
            <div style={{ width: 52, height: 52, borderRadius: 12, background: `${brandColor}20`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
              <span style={{ fontSize: 18, fontWeight: 800, color: brandColor }}>CP</span>
            </div>
          )}
          <h2 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: "0 0 6px 0" }}>{company?.name || "Your account"}</h2>
          <p style={{ fontSize: 14, color: "#6B6860", margin: 0 }}>Choose a password to finish setting up</p>
        </div>

        {/* A link with no token can never succeed — say so before they type a
            password, rather than after submitting it. */}
        {!token && (
          <div style={{ background: "#FCEBEA", border: "1px solid #F1D0CB", borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>
            <p style={{ fontSize: 13, color: "#B3261E", margin: 0 }}>
              This link is incomplete. Open the link from your email again, or ask for a new one from the sign-in page.
            </p>
          </div>
        )}

        {error && (
          <div style={{ background: "#FCEBEA", border: "1px solid #F1D0CB", borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>
            <p style={{ fontSize: 13, color: "#B3261E", margin: 0 }}>{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>New password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="At least 10 characters" required autoFocus
              style={{ ...inputStyle, borderColor: tooShort ? "#F1D0CB" : "#E5E2DC" }} />
            {tooShort && (
              <p style={{ fontSize: 12, color: "#B3261E", margin: "6px 0 0" }}>
                {MIN_LENGTH - password.length} more character{MIN_LENGTH - password.length === 1 ? "" : "s"} needed
              </p>
            )}
          </div>

          <div style={{ marginBottom: 24 }}>
            <label style={labelStyle}>Confirm password</label>
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
              placeholder="Type it again" required
              style={{ ...inputStyle, borderColor: mismatch ? "#F1D0CB" : "#E5E2DC" }} />
            {mismatch && <p style={{ fontSize: 12, color: "#B3261E", margin: "6px 0 0" }}>These don't match</p>}
          </div>

          <button type="submit" disabled={submitting || !canSubmit}
            style={{
              width: "100%", height: 46, background: canSubmit ? brandColor : "#C4C0BB", color: "#FFFFFF",
              border: "none", borderRadius: 9, fontSize: 14, fontWeight: 700,
              cursor: canSubmit && !submitting ? "pointer" : "default", fontFamily: "inherit",
            }}>
            {submitting ? "Saving…" : "Save and sign in"}
          </button>
        </form>

        <p style={{ textAlign: "center", fontSize: 12, color: "#9E9B94", marginTop: 20 }}>
          Powered by <strong style={{ color: "#1A1917" }}>Qleno</strong>
        </p>
      </div>
    </div>
  );
}
