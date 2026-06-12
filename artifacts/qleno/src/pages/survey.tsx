import { useState, useEffect } from "react";
import { useRoute } from "wouter";
import { CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { QlenoLogo } from "@/components/brand/QlenoLogo";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

// MaidCentral 0–4 satisfaction scale — the single question that feeds the
// employee scorecard. Highest first (reads top-down on a phone).
const OPTIONS: { score: number; label: string; sub: string; color: string }[] = [
  { score: 4, label: "Thrilled — Great Work", sub: "Everything was excellent", color: "#16A34A" },
  { score: 3, label: "Happy — Good Work", sub: "A good cleaning", color: "#65A30D" },
  { score: 2, label: "A Few Concerns", sub: "Some things to improve", color: "#D97706" },
  { score: 1, label: "Major Concerns", sub: "Several problems", color: "#DC2626" },
  { score: 0, label: "Considering Another Company", sub: "Strongly dissatisfied", color: "#991B1B" },
];

export default function SurveyPage() {
  const [, params] = useRoute("/survey/:token");
  const token = params?.token || "";

  const [meta, setMeta] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const [score, setScore] = useState<number | null>(null);
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
    if (score === null) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const r = await fetch(`${API}/api/satisfaction/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, survey_score: score, comment }),
      });
      const d = await r.json();
      if (d.error) setSubmitError(d.error === "Already responded" ? "This survey has already been submitted. Thank you." : d.error);
      else setSubmitted(true);
    } catch {
      setSubmitError("Failed to submit. Please try again.");
    }
    setSubmitting(false);
  }

  const brand = meta?.brand_color || "#00C9A0";
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
          <CheckCircle size={48} style={{ color: brand, marginBottom: 16 }} />
          <h2 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: "0 0 10px" }}>Thank you for your feedback.</h2>
          <p style={{ fontSize: 14, color: "#6B7280", margin: 0, lineHeight: "1.6" }}>
            We appreciate you trusting us with your home.
          </p>
        </div>
      </div>
    );
  }

  const canSubmit = score !== null;

  return (
    <div style={{ minHeight: "100vh", background: "#F8F7F4", fontFamily: FF, padding: "24px 16px", display: "flex", alignItems: "flex-start", justifyContent: "center" }}>
      <div style={{ background: "#FFFFFF", borderRadius: 16, padding: "36px 24px", maxWidth: 480, width: "100%", boxShadow: "0 8px 32px rgba(0,0,0,0.08)", marginTop: 24 }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
            <QlenoLogo size="sm" theme="light" layout="horizontal" />
          </div>
          <div style={{ width: 44, height: 44, borderRadius: 11, backgroundColor: brand, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 10px", fontSize: 18, fontWeight: 800, color: "#FFFFFF" }}>
            {companyName[0]}
          </div>
          <h1 style={{ fontSize: 17, fontWeight: 700, color: "#1A1917", margin: "0 0 2px" }}>{companyName}</h1>
          <p style={{ fontSize: 10, color: "#9E9B94", margin: "0 0 10px", letterSpacing: "0.02em" }}>Powered by Qleno</p>
          <p style={{ fontSize: 15, color: "#1A1917", fontWeight: 600, margin: 0 }}>How was your cleaning?</p>
        </div>

        {/* 0–4 satisfaction choices */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
          {OPTIONS.map(o => {
            const sel = score === o.score;
            return (
              <button key={o.score} onClick={() => setScore(o.score)} style={{
                display: "flex", alignItems: "center", gap: 14, textAlign: "left" as const,
                padding: "14px 16px", borderRadius: 12, cursor: "pointer", width: "100%",
                border: `2px solid ${sel ? o.color : "#E5E2DC"}`,
                backgroundColor: sel ? `${o.color}12` : "#FFFFFF",
                transition: "all 0.12s", fontFamily: FF,
              }}>
                <div style={{
                  width: 34, height: 34, borderRadius: "50%", flexShrink: 0,
                  backgroundColor: sel ? o.color : "#F3F4F6",
                  color: sel ? "#FFFFFF" : "#6B7280",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 16, fontWeight: 800,
                }}>{o.score}</div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: sel ? o.color : "#1A1917" }}>{o.label}</div>
                  <div style={{ fontSize: 12, color: "#9E9B94" }}>{o.sub}</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Optional comment */}
        <div style={{ marginBottom: 22 }}>
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
