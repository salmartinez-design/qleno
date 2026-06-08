import { useState, useRef } from "react";
import { getAuthHeaders } from "@/lib/auth";
import { Mic, X, Navigation, Loader2, Volume2 } from "lucide-react";

// [voice-assistant 2026-06-08] Push-to-talk field assistant for techs. Browser
// speech-to-text captures the spoken question, POSTs it to /api/assistant/ask
// (Claude, scoped to the tech's own jobs), then shows + speaks the answer.
// Bilingual EN/ES (default English). Read + navigate only. Falls back to a text
// box when the browser has no SpeechRecognition (e.g. some iOS versions).

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

const SR: any = typeof window !== "undefined" ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : null;

type Lang = "en" | "es";
const T: Record<Lang, Record<string, string>> = {
  en: {
    title: "Assistant", listening: "Listening…", thinking: "Thinking…",
    tap: "Tap the mic and ask", navigate: "Navigate", placeholder: "Or type your question…",
    send: "Ask", unsupported: "Voice isn't available on this browser — type your question.",
    error: "Something went wrong — try again.", examples: "Try: “What's my schedule today?” · “Navigate to my next job” · “What are the notes for this job?”",
    micBlocked: "Microphone is blocked. Allow mic access for this site in your browser settings, then try again.",
    noSpeech: "Didn't catch that — tap the mic and speak right after, or type below.",
    noMic: "No microphone found on this device — type your question instead.",
    netErr: "Couldn't reach the speech service — check your connection or type your question.",
  },
  es: {
    title: "Asistente", listening: "Escuchando…", thinking: "Pensando…",
    tap: "Toca el micrófono y pregunta", navigate: "Navegar", placeholder: "O escribe tu pregunta…",
    send: "Preguntar", unsupported: "La voz no está disponible en este navegador — escribe tu pregunta.",
    error: "Algo salió mal — inténtalo de nuevo.", examples: "Prueba: “¿Cuál es mi horario hoy?” · “Llévame a mi próximo trabajo” · “¿Cuáles son las notas de este trabajo?”",
    micBlocked: "El micrófono está bloqueado. Permite el acceso al micrófono para este sitio y vuelve a intentar.",
    noSpeech: "No escuché nada — toca el micrófono y habla, o escribe abajo.",
    noMic: "No se encontró micrófono en este dispositivo — escribe tu pregunta.",
    netErr: "No se pudo conectar al servicio de voz — revisa tu conexión o escribe tu pregunta.",
  },
};

export function VoiceAssistant() {
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<Lang>("en");
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [navUrl, setNavUrl] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState("");
  const recRef = useRef<any>(null);
  const gotResultRef = useRef(false);
  const hadErrorRef = useRef(false);
  const t = T[lang];
  const supported = !!SR;

  function speak(text: string) {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang === "es" ? "es-MX" : "en-US";
      window.speechSynthesis.speak(u);
    } catch { /* TTS unavailable — text answer still shows */ }
  }

  async function ask(q: string) {
    if (!q.trim() || busy) return;
    setBusy(true); setAnswer(""); setNavUrl(null); setTranscript(q);
    try {
      const r = await fetch(`${API}/api/assistant/ask`, {
        method: "POST",
        headers: { ...(getAuthHeaders() as Record<string, string>), "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          language: lang,
          // Tech's LOCAL date + time so "today" and "my next job" are correct
          // regardless of server timezone.
          date: new Date().toLocaleDateString("en-CA"),
          now: new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "failed");
      setAnswer(d.answer || "");
      setNavUrl(d.navigate_url || null);
      if (d.answer) speak(d.answer);
      // Navigate on command: when the assistant resolved a destination (e.g.
      // "take me to my next job"), launch Google Maps directions automatically.
      // Prefer a new tab; fall back to same-tab nav if the browser blocks it
      // (keeps the Maps hand-off reliable on mobile). The Navigate button stays
      // as a manual fallback.
      if (d.navigate_url) {
        const w = window.open(d.navigate_url, "_blank");
        if (!w) window.location.href = d.navigate_url;
      }
    } catch {
      setAnswer(t.error);
    } finally {
      setBusy(false);
    }
  }

  async function startListening() {
    if (!supported || listening || busy) return;
    setStatus(""); setTranscript(""); setAnswer(""); setNavUrl(null);
    // Pre-flight the microphone permission so a denial gives a clear message
    // instead of a silent no-op (the #1 reason "the mic does nothing").
    try {
      if (navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(tr => tr.stop());
      }
    } catch {
      setStatus(t.micBlocked);
      return;
    }
    try {
      const rec = new SR();
      rec.lang = lang === "es" ? "es-MX" : "en-US";
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      gotResultRef.current = false;
      hadErrorRef.current = false;
      rec.onresult = (ev: any) => {
        const text = ev?.results?.[0]?.[0]?.transcript ?? "";
        if (text) { gotResultRef.current = true; ask(text); }
      };
      rec.onerror = (ev: any) => {
        setListening(false);
        hadErrorRef.current = true;
        const code = ev?.error;
        if (code === "not-allowed" || code === "service-not-allowed") setStatus(t.micBlocked);
        else if (code === "no-speech") setStatus(t.noSpeech);
        else if (code === "audio-capture") setStatus(t.noMic);
        else if (code === "network") setStatus(t.netErr);
        else if (code !== "aborted") setStatus(t.error);
      };
      rec.onend = () => {
        setListening(false);
        if (!gotResultRef.current && !hadErrorRef.current) setStatus(t.noSpeech);
      };
      recRef.current = rec;
      setListening(true);
      rec.start();
    } catch {
      setListening(false);
      setStatus(t.error);
    }
  }

  function stopListening() {
    try { recRef.current?.stop(); } catch { /* noop */ }
    setListening(false);
  }

  const close = () => {
    stopListening();
    try { window.speechSynthesis.cancel(); } catch { /* noop */ }
    setOpen(false);
  };

  return (
    <>
      {/* Floating mic button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open assistant"
          style={{
            position: "fixed", right: 18, bottom: 86, zIndex: 200,
            width: 56, height: 56, borderRadius: "50%", border: "none",
            background: "var(--brand)", color: "#fff", cursor: "pointer",
            boxShadow: "0 6px 20px rgba(0,0,0,0.22)", display: "flex",
            alignItems: "center", justifyContent: "center", fontFamily: FF,
          }}
        >
          <Mic size={24} />
        </button>
      )}

      {/* Panel (bottom sheet) */}
      {open && (
        <>
          <div onClick={close} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 210 }} />
          <div style={{
            position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 220,
            background: "#FFFFFF", borderRadius: "18px 18px 0 0",
            padding: "16px 18px calc(20px + env(safe-area-inset-bottom))",
            boxShadow: "0 -8px 28px rgba(0,0,0,0.18)", fontFamily: FF,
            maxHeight: "82vh", display: "flex", flexDirection: "column", gap: 14,
          }}>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 16, fontWeight: 800, color: "#1A1917" }}>{t.title}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ display: "flex", background: "#F4F3F0", borderRadius: 8, padding: 3 }}>
                  {(["en", "es"] as Lang[]).map(l => (
                    <button key={l} onClick={() => setLang(l)}
                      style={{ padding: "4px 12px", borderRadius: 6, border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FF,
                        background: lang === l ? "#fff" : "transparent", color: lang === l ? "#1A1917" : "#9E9B94",
                        boxShadow: lang === l ? "0 1px 3px rgba(0,0,0,0.08)" : "none" }}>
                      {l === "en" ? "EN" : "ES"}
                    </button>
                  ))}
                </div>
                <button onClick={close} aria-label="Close" style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4, display: "flex" }}><X size={20} /></button>
              </div>
            </div>

            {/* Mic */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "6px 0 2px" }}>
              <button
                onClick={listening ? stopListening : startListening}
                disabled={!supported || busy}
                aria-label={listening ? "Stop" : "Speak"}
                style={{
                  width: 76, height: 76, borderRadius: "50%", border: "none", cursor: (!supported || busy) ? "default" : "pointer",
                  background: listening ? "#DC2626" : "var(--brand)", color: "#fff",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: listening ? "0 0 0 8px rgba(220,38,38,0.18)" : "0 4px 16px rgba(0,0,0,0.18)",
                  opacity: (!supported || busy) ? 0.5 : 1, transition: "background 0.15s, box-shadow 0.15s",
                }}
              >
                {busy ? <Loader2 size={28} className="animate-spin" /> : <Mic size={30} />}
              </button>
              <span style={{ fontSize: 13, color: "#6B6860", fontWeight: 600 }}>
                {busy ? t.thinking : listening ? t.listening : t.tap}
              </span>
            </div>

            {/* Transcript */}
            {transcript && (
              <div style={{ fontSize: 13, color: "#6B6860", fontStyle: "italic", textAlign: "center" }}>“{transcript}”</div>
            )}

            {/* Answer */}
            {answer && (
              <div style={{ background: "#F0FDF9", border: "1px solid #99E6D3", borderRadius: 12, padding: "14px 16px", display: "flex", gap: 10, alignItems: "flex-start" }}>
                <Volume2 size={16} style={{ color: "#0A6E5A", flexShrink: 0, marginTop: 2, cursor: "pointer" }} onClick={() => speak(answer)} />
                <div style={{ fontSize: 14, color: "#04241d", lineHeight: 1.45, flex: 1 }}>{answer}</div>
              </div>
            )}

            {/* Navigate */}
            {navUrl && (
              <a href={navUrl} target="_blank" rel="noreferrer"
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "12px 0", background: "#1D4ED8", color: "#fff", borderRadius: 10, fontSize: 15, fontWeight: 700, textDecoration: "none" }}>
                <Navigation size={18} /> {t.navigate}
              </a>
            )}

            {/* Text fallback / typed input */}
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={typed}
                onChange={e => setTyped(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && typed.trim()) { ask(typed); setTyped(""); } }}
                placeholder={t.placeholder}
                style={{ flex: 1, height: 44, padding: "0 14px", border: "1px solid #E5E2DC", borderRadius: 10, fontSize: 14, color: "#1A1917", fontFamily: FF, outline: "none", boxSizing: "border-box" }}
              />
              <button onClick={() => { if (typed.trim()) { ask(typed); setTyped(""); } }} disabled={busy || !typed.trim()}
                style={{ padding: "0 18px", height: 44, background: "var(--brand)", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: (busy || !typed.trim()) ? "default" : "pointer", fontFamily: FF, opacity: (busy || !typed.trim()) ? 0.5 : 1 }}>
                {t.send}
              </button>
            </div>

            {status && (
              <div style={{ fontSize: 12, color: "#92400E", background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 8, padding: "8px 12px" }}>{status}</div>
            )}
            {!supported && (
              <div style={{ fontSize: 12, color: "#92400E", background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 8, padding: "8px 12px" }}>{t.unsupported}</div>
            )}
            {!answer && !transcript && (
              <div style={{ fontSize: 11, color: "#9E9B94", textAlign: "center", lineHeight: 1.5 }}>{t.examples}</div>
            )}
          </div>
        </>
      )}
    </>
  );
}
