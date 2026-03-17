import { useState, useEffect } from "react";
import { useRoute } from "wouter";
import { CheckCircle, AlertCircle, Loader2 } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

export default function SurveyPage() {
  const [, params] = useRoute("/survey/:token");
  const token = params?.token || "";

  const [meta, setMeta] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const [rating, setRating] = useState<number | null>(null);
  const [nps, setNps] = useState<number | null>(null);
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (!token) return;
    fetch(`${API}/api/satisfaction/survey/${token}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) setErrorMsg(d.error === "Survey not found" ? "This link is no longer active." : d.error);
        else if (d.suppressed) setErrorMsg("This link is no longer active.");
        else { setMeta(d); if (d.responded_at) setSubmitted(true); }
      })
      .catch(() => setErrorMsg("Failed to load survey"))
      .finally(() => setLoading(false));
  }, [token]);

  async function submit() {
    if (rating === null || nps === null) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const r = await fetch(`${API}/api/satisfaction/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, nps_score: nps, rating, comment }),
      });
      const d = await r.json();
      if (d.error) setSubmitError(d.error === "Already responded" ? "This survey has already been submitted. Thank you." : d.error);
      else setSubmitted(true);
    } catch {
      setSubmitError("Failed to submit. Please try again.");
    }
    setSubmitting(false);
  }

  const brand = meta?.brand_color || "#5B9BD5";
  const companyName = meta?.company_name || "Your cleaning company";

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F8F7F4", fontFamily: FF }}>
        <Loader2 size={28} style={{ color: brand, animation: "spin 1s linear infinite" }} />
        <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
      </div>
    );
  }

  if (errorMsg) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F8F7F4", fontFamily: FF, padding: 24 }}>
        <div style={{ textAlign: "center", maxWidth: 380 }}>
          <AlertCircle size={40} style={{ color: "#9E9B94", marginBottom: 16 }} />
          <p style={{ fontSize: 16, color: "#1A1917", fontWeight: 600, margin: "0 0 6px" }}>{errorMsg}</p>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F8F7F4", fontFamily: FF, padding: 24 }}>
        <div style={{ background: "#FFFFFF", borderRadius: 16, padding: "48px 40px", maxWidth: 440, width: "100%", textAlign: "center", boxShadow: "0 8px 32px rgba(0,0,0,0.08)" }}>
          <CheckCircle size={48} style={{ color: "#22C55E", marginBottom: 16 }} />
          <h2 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: "0 0 10px" }}>Thank you for your feedback.</h2>
          <p style={{ fontSize: 14, color: "#6B7280", margin: 0, lineHeight: "1.6" }}>
            We appreciate you trusting us with your home.
          </p>
        </div>
      </div>
    );
  }

  const RATING_LABELS: Record<number, string> = { 1: "Poor", 2: "Fair", 3: "Good", 4: "Great", 5: "Excellent" };
  const canSubmit = rating !== null && nps !== null;

  return (
    <div style={{ minHeight: "100vh", background: "#F8F7F4", fontFamily: FF, padding: "24px 16px", display: "flex", alignItems: "flex-start", justifyContent: "center" }}>
      <div style={{ background: "#FFFFFF", borderRadius: 16, padding: "36px 28px", maxWidth: 500, width: "100%", boxShadow: "0 8px 32px rgba(0,0,0,0.08)", marginTop: 24 }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ width: 48, height: 48, borderRadius: 12, backgroundColor: brand, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px", fontSize: 20, fontWeight: 800, color: "#FFFFFF" }}>
            {companyName[0]}
          </div>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: "#1A1917", margin: "0 0 4px" }}>{companyName}</h1>
          <p style={{ fontSize: 14, color: "#6B7280", margin: 0 }}>How was your cleaning today?</p>
        </div>

        {/* Q1 — 1–5 circle rating */}
        <div style={{ marginBottom: 28 }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", marginBottom: 14 }}>Rate your cleaning today</p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            {[1, 2, 3, 4, 5].map(s => (
              <button key={s} onClick={() => setRating(s)} style={{
                width: 52, height: 52, borderRadius: "50%",
                border: `2px solid ${rating === s ? brand : "#E5E2DC"}`,
                backgroundColor: rating === s ? brand : "#FFFFFF",
                color: rating === s ? "#FFFFFF" : "#6B7280",
                fontSize: 16, fontWeight: 700, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "all 0.12s", fontFamily: FF,
              }}>
                {s}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, paddingLeft: 4, paddingRight: 4 }}>
            <span style={{ fontSize: 10, color: "#9E9B94" }}>Poor</span>
            <span style={{ fontSize: 10, color: "#9E9B94" }}>Good</span>
            <span style={{ fontSize: 10, color: "#9E9B94" }}>Excellent</span>
          </div>
          {rating && (
            <p style={{ textAlign: "center", fontSize: 12, color: brand, fontWeight: 600, marginTop: 6 }}>{RATING_LABELS[rating]}</p>
          )}
        </div>

        {/* Q2 — NPS 0–10 */}
        <div style={{ marginBottom: 28 }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", marginBottom: 4 }}>How likely are you to recommend us to a friend or neighbor?</p>
          <p style={{ fontSize: 11, color: "#9E9B94", margin: "0 0 14px" }}>0 = Not at all likely · 10 = Extremely likely</p>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" as const }}>
            {Array.from({ length: 11 }, (_, i) => (
              <button key={i} onClick={() => setNps(i)} style={{
                width: 40, height: 40, borderRadius: 8,
                border: `2px solid ${nps === i ? brand : "#E5E2DC"}`,
                backgroundColor: nps === i ? brand : "#FFFFFF",
                color: nps === i ? "#FFFFFF" : "#1A1917",
                fontSize: 13, fontWeight: 600, cursor: "pointer",
                transition: "all 0.12s", fontFamily: FF,
              }}>
                {i}
              </button>
            ))}
          </div>
        </div>

        {/* Q3 — Optional comment */}
        <div style={{ marginBottom: 28 }}>
          <label style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", display: "block", marginBottom: 8 }}>
            Anything else you'd like to share? <span style={{ color: "#9E9B94", fontWeight: 400 }}>(optional)</span>
          </label>
          <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3}
            placeholder="Your feedback helps us improve."
            style={{ width: "100%", padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, resize: "vertical" as const, fontFamily: FF, outline: "none", boxSizing: "border-box" as const }} />
        </div>

        {submitError && (
          <div style={{ marginBottom: 16, padding: "10px 12px", background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 8, fontSize: 13, color: "#991B1B" }}>
            {submitError}
          </div>
        )}

        <button onClick={submit} disabled={!canSubmit || submitting}
          style={{
            width: "100%", padding: "13px 0",
            backgroundColor: canSubmit ? brand : "#E5E2DC",
            color: "#FFFFFF", border: "none", borderRadius: 10,
            fontSize: 14, fontWeight: 700,
            cursor: canSubmit ? "pointer" : "not-allowed",
            fontFamily: FF, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            transition: "background-color 0.15s",
          }}>
          {submitting ? <><Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> Submitting…</> : "Submit Feedback"}
        </button>
      </div>
      <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
    </div>
  );
}
