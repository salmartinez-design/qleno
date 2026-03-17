import { useState, useEffect } from "react";
import { useRoute } from "wouter";
import { Star, CheckCircle, AlertCircle, Loader2 } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

export default function SurveyPage() {
  const [, params] = useRoute("/survey/:token");
  const token = params?.token || "";

  const [meta, setMeta] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [nps, setNps] = useState<number | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (!token) return;
    fetch(`${API}/api/satisfaction/survey/${token}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) setError(d.error);
        else { setMeta(d); if (d.responded_at) setSubmitted(true); }
      })
      .catch(() => setError("Failed to load survey"))
      .finally(() => setLoading(false));
  }, [token]);

  async function submit() {
    if (nps === null || rating === null) return;
    setSubmitting(true);
    try {
      const r = await fetch(`${API}/api/satisfaction/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, nps_score: nps, rating, comment }),
      });
      const d = await r.json();
      if (d.error) setError(d.error);
      else setSubmitted(true);
    } catch { setError("Failed to submit. Please try again."); }
    setSubmitting(false);
  }

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#F8F7F4", fontFamily: FF }}>
        <Loader2 size={28} style={{ color: "#5B9BD5", animation: "spin 1s linear infinite" }} />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#F8F7F4", fontFamily: FF }}>
        <div style={{ textAlign: "center", padding: 40 }}>
          <AlertCircle size={40} style={{ color: "#EF4444", marginBottom: 16 }} />
          <p style={{ fontSize: 16, color: "#1A1917", fontWeight: 600, margin: 0 }}>{error}</p>
        </div>
      </div>
    );
  }

  const brand = meta?.brand_color || "#5B9BD5";
  const companyName = meta?.company_name || "Your cleaning company";
  const clientName = meta?.client_name || "there";

  if (submitted) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#F8F7F4", fontFamily: FF }}>
        <div style={{ background: "#FFFFFF", borderRadius: 16, padding: "48px 40px", maxWidth: 480, width: "100%", textAlign: "center", boxShadow: "0 8px 32px rgba(0,0,0,0.08)" }}>
          <CheckCircle size={48} style={{ color: "#22C55E", marginBottom: 16 }} />
          <h2 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: "0 0 8px" }}>Thank you, {clientName.split(" ")[0]}!</h2>
          <p style={{ fontSize: 14, color: "#6B7280", margin: 0 }}>Your feedback helps {companyName} keep improving. We appreciate your time!</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#F8F7F4", fontFamily: FF, padding: 16 }}>
      <div style={{ background: "#FFFFFF", borderRadius: 16, padding: "40px 32px", maxWidth: 520, width: "100%", boxShadow: "0 8px 32px rgba(0,0,0,0.08)" }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ width: 48, height: 48, borderRadius: 12, backgroundColor: brand, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px", fontSize: 20, fontWeight: 800, color: "#FFFFFF" }}>
            {companyName[0]}
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "#1A1917", margin: "0 0 4px" }}>{companyName}</h1>
          <p style={{ fontSize: 14, color: "#6B7280", margin: 0 }}>We'd love to hear about your recent cleaning experience, {clientName.split(" ")[0]}!</p>
        </div>

        {/* NPS */}
        <div style={{ marginBottom: 28 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", marginBottom: 12 }}>
            How likely are you to recommend us to a friend or neighbor?
            <span style={{ display: "block", fontSize: 11, fontWeight: 400, color: "#9E9B94", marginTop: 2 }}>0 = Not at all likely · 10 = Extremely likely</span>
          </p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {Array.from({ length: 11 }, (_, i) => (
              <button key={i} onClick={() => setNps(i)}
                style={{ width: 42, height: 42, borderRadius: 8, border: `2px solid ${nps === i ? brand : "#E5E2DC"}`, backgroundColor: nps === i ? brand : "#FFFFFF", color: nps === i ? "#FFFFFF" : "#1A1917", fontSize: 14, fontWeight: 600, cursor: "pointer", transition: "all 0.12s", fontFamily: FF }}>
                {i}
              </button>
            ))}
          </div>
        </div>

        {/* Star Rating */}
        <div style={{ marginBottom: 28 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", marginBottom: 12 }}>How would you rate the quality of your cleaning?</p>
          <div style={{ display: "flex", gap: 8 }}>
            {[1, 2, 3, 4, 5].map(s => (
              <button key={s} onClick={() => setRating(s)}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}>
                <Star size={32} style={{ color: s <= (rating ?? 0) ? "#F59E0B" : "#E5E2DC", fill: s <= (rating ?? 0) ? "#F59E0B" : "#E5E2DC", transition: "all 0.1s" }} />
              </button>
            ))}
          </div>
        </div>

        {/* Comment */}
        <div style={{ marginBottom: 28 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", display: "block", marginBottom: 8 }}>
            Any additional comments? <span style={{ color: "#9E9B94", fontWeight: 400 }}>(optional)</span>
          </label>
          <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} placeholder="Tell us what went well or what we can improve..."
            style={{ width: "100%", padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, resize: "vertical", fontFamily: FF, outline: "none", boxSizing: "border-box" }} />
        </div>

        <button onClick={submit} disabled={nps === null || rating === null || submitting}
          style={{ width: "100%", padding: "12px 0", backgroundColor: nps !== null && rating !== null ? brand : "#E5E2DC", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: nps !== null && rating !== null ? "pointer" : "not-allowed", fontFamily: FF, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "all 0.15s" }}>
          {submitting ? <><Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> Submitting...</> : "Submit Feedback"}
        </button>
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
