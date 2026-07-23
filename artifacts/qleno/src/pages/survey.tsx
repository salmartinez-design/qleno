import { useState, useEffect } from "react";
import { useRoute } from "wouter";
import { CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { QlenoLogo } from "@/components/brand/QlenoLogo";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

// MaidCentral 0–4 satisfaction scale — the single question that feeds the
// employee Performance Score. Highest first (reads top-down on a phone).
const OPTIONS: { score: number; label: string; sub: string; color: string }[] = [
  { score: 4, label: "Thrilled — Great Work", sub: "Everything was excellent", color: "#0F7A63" },
  { score: 3, label: "Happy — Good Work", sub: "A good cleaning", color: "#65A30D" },
  { score: 2, label: "A Few Concerns", sub: "Some things to improve", color: "#B45309" },
  { score: 1, label: "Major Concerns", sub: "Several problems", color: "#B3261E" },
  { score: 0, label: "Considering Another Company", sub: "Strongly dissatisfied", color: "#B3261E" },
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
  const [commentSent, setCommentSent] = useState(false);
  const [savingComment, setSavingComment] = useState(false);

  // [seamless] A score passed in the URL (?score=N) — set when the customer taps
  // a rating right inside the email — is recorded automatically on arrival so a
  // single tap from their inbox is all it takes.
  const urlScore = (() => {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search).get("score");
    if (raw == null) return null;
    const n = Math.round(Number(raw));
    return Number.isFinite(n) && n >= 0 && n <= 4 ? n : null;
  })();

  async function submit(s: number) {
    if (s == null || submitting || submitted) return;
    setScore(s);
    setSubmitting(true);
    setSubmitError("");
    try {
      const r = await fetch(`${API}/api/satisfaction/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, survey_score: s }),
      });
      const d = await r.json();
      if (d.error) setSubmitError(d.error === "Already responded" ? "This survey has already been submitted. Thank you." : d.error);
      else setSubmitted(true);
    } catch {
      setSubmitError("Couldn't record your rating. Please tap again.");
    }
    setSubmitting(false);
  }

  async function sendComment() {
    if (!comment.trim() || savingComment) return;
    setSavingComment(true);
    try {
      await fetch(`${API}/api/satisfaction/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, comment }),
      });
      setCommentSent(true);
    } catch {
      /* non-fatal — their rating is already recorded */
      setCommentSent(true);
    }
    setSavingComment(false);
  }

  useEffect(() => {
    if (!token) return;
    fetch(`${API}/api/satisfaction/survey/${token}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) setErrorMsg(d.error === "Survey not found" ? "This link is no longer active." : d.error);
        else if (d.suppressed) setErrorMsg("This link is no longer active.");
        else {
          setMeta(d);
          if (d.responded_at) {
            // [revisit-score] Already answered — hydrate the score they gave so
            // the thank-you screen reflects their real rating. Missing this made
            // `happy` default to false on a fresh load, showing the "we missed
            // the mark" apology to happy raters who simply reopened the link.
            if (typeof d.survey_score === "number") setScore(d.survey_score);
            setSubmitted(true);
          }
          else if (urlScore != null) { submit(urlScore); } // one-tap from the email
        }
      })
      .catch(() => setErrorMsg("Failed to load survey"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

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

  // [seamless] Thank-you doubles as the (optional) comment step. The rating is
  // already saved; a note is a bonus, never required.
  if (submitted) {
    const chosen = OPTIONS.find(o => o.score === score);
    // [review-funnel] Only happy raters (3–4) are routed to a public Google
    // review; everyone else gets a private "make it right" note instead.
    // [review-once] ...and only if this client has never tapped the Google
    // button before — one lifetime ask, tracked via /review-click.
    const happy = score != null && score >= 3;
    const reviewLink: string | null = meta?.google_review_done ? null : (meta?.google_review_link || null);
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "flex-start", justifyContent: "center", background: "#F8F7F4", fontFamily: FF, padding: "24px 16px" }}>
        <div style={{ background: "#FFFFFF", borderRadius: 16, padding: "40px 28px", maxWidth: 440, width: "100%", textAlign: "center", boxShadow: "0 8px 32px rgba(0,0,0,0.08)", marginTop: 24 }}>
          <CheckCircle size={48} style={{ color: brand, marginBottom: 14 }} />
          <h2 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: "0 0 8px" }}>
            {happy ? "So glad we hit the mark!" : "Thank you for your feedback."}
          </h2>
          {chosen && (
            <p style={{ fontSize: 14, color: "#6B6860", margin: "0 0 16px" }}>
              You rated us <span style={{ color: chosen.color, fontWeight: 700 }}>{chosen.label}</span>.
            </p>
          )}

          {happy && reviewLink && (
            <div style={{ marginBottom: 22 }}>
              <p style={{ fontSize: 14, color: "#1A1917", margin: "0 0 14px", lineHeight: "1.6" }}>
                Would you mind sharing that with a quick Google review? It means the world to our team.
              </p>
              <a href={reviewLink} target="_blank" rel="noopener noreferrer"
                onClick={() => { try { fetch(`${API}/api/satisfaction/review-click`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }); } catch { /* best-effort */ } }}
                style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                padding: "13px 0", backgroundColor: brand, color: "#FFFFFF", textDecoration: "none",
                borderRadius: 10, fontSize: 14, fontWeight: 700, fontFamily: FF,
              }}>Leave a Google review</a>
            </div>
          )}

          {!happy && (
            <p style={{ fontSize: 14, color: "#6B6860", margin: "0 0 22px", lineHeight: "1.6" }}>
              We're sorry we missed the mark — we'd like to make it right.
            </p>
          )}

          {!commentSent ? (
            <div style={{ textAlign: "left" }}>
              <label style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", display: "block", marginBottom: 8 }}>
                {happy ? "Want to add a quick note?" : "Tell us what we can do better"} <span style={{ color: "#9E9B94", fontWeight: 400 }}>(optional)</span>
              </label>
              <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3}
                placeholder={happy ? "Tell us anything that stood out." : "We read every note and will follow up."}
                style={{ width: "100%", padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, resize: "vertical" as const, fontFamily: FF, outline: "none", boxSizing: "border-box" as const, marginBottom: 12 }} />
              <button onClick={sendComment} disabled={!comment.trim() || savingComment}
                style={{
                  width: "100%", padding: "12px 0", backgroundColor: comment.trim() ? brand : "#E5E2DC",
                  color: "#FFFFFF", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700,
                  cursor: comment.trim() ? "pointer" : "not-allowed", fontFamily: FF,
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                }}>
                {savingComment ? <><Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> Sending…</> : "Send note"}
              </button>
            </div>
          ) : (
            <p style={{ fontSize: 13, color: "#0F7A63", fontWeight: 600, margin: 0 }}>Thanks — your note was sent.</p>
          )}
        </div>
        <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#F8F7F4", fontFamily: FF, padding: "24px 16px", display: "flex", alignItems: "flex-start", justifyContent: "center" }}>
      <div style={{ background: "#FFFFFF", borderRadius: 16, padding: "36px 24px", maxWidth: 480, width: "100%", boxShadow: "0 8px 32px rgba(0,0,0,0.08)", marginTop: 24 }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
            <QlenoLogo size="sm" theme="light" layout="horizontal" />
          </div>
          <div style={{ width: 44, height: 44, borderRadius: 11, backgroundColor: brand, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 10px", fontSize: 18, fontWeight: 800, color: "#FFFFFF" }}>
            {companyName[0]}
          </div>
          <h1 style={{ fontSize: 17, fontWeight: 700, color: "#1A1917", margin: "0 0 2px" }}>{companyName}</h1>
          <p style={{ fontSize: 10, color: "#9E9B94", margin: "0 0 10px", letterSpacing: "0.02em" }}>Powered by Qleno</p>
          <p style={{ fontSize: 15, color: "#1A1917", fontWeight: 600, margin: "0 0 2px" }}>How was your cleaning?</p>
          <p style={{ fontSize: 12, color: "#9E9B94", margin: 0 }}>Tap your answer — that's it.</p>
        </div>

        {/* [seamless] One tap submits — no separate button. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {OPTIONS.map(o => {
            const busy = submitting && score === o.score;
            return (
              <button key={o.score} onClick={() => submit(o.score)} disabled={submitting} style={{
                display: "flex", alignItems: "center", gap: 14, textAlign: "left" as const,
                padding: "15px 16px", borderRadius: 12, cursor: submitting ? "default" : "pointer", width: "100%",
                border: `2px solid ${busy ? o.color : "#E5E2DC"}`,
                backgroundColor: busy ? `${o.color}12` : "#FFFFFF",
                transition: "all 0.12s", fontFamily: FF, opacity: submitting && !busy ? 0.5 : 1,
              }}>
                <div style={{
                  width: 34, height: 34, borderRadius: "50%", flexShrink: 0,
                  backgroundColor: busy ? o.color : "#F0EEE9", color: busy ? "#FFFFFF" : "#6B6860",
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800,
                }}>{busy ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : o.score}</div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>{o.label}</div>
                  <div style={{ fontSize: 12, color: "#9E9B94" }}>{o.sub}</div>
                </div>
              </button>
            );
          })}
        </div>

        {submitError && (
          <div style={{ marginTop: 16, padding: "10px 12px", background: "#FCEBEA", border: "1px solid #FCA5A5", borderRadius: 8, fontSize: 13, color: "#B3261E" }}>
            {submitError}
          </div>
        )}
      </div>
      <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
    </div>
  );
}
