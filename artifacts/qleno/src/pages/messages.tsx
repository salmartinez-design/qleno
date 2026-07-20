import { useState, useEffect, useCallback, useRef } from "react";
import { getAuthHeaders, useAuthStore } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useIsMobile } from "@/hooks/use-mobile";
import { useToast } from "@/hooks/use-toast";
import { MessageSquare, Search, Send, ChevronLeft, Plus, X, Paperclip, Clock, Trash2, Image, Sparkles, Mic, Undo2, ChevronDown, Wand2, Zap } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";
const INK = "#1A1917";
const MUTE = "#6B6860";
const BORDER = "#E5E2DC";
const BRAND = "#00C9A0";

// [msg-linkify 2026-07-19] Message bodies — especially drip touches carrying the
// lead's booking/resume link — were rendered as plain text, so the office
// couldn't click through to a lead's quote to close them from the conversation.
// Turn bare URLs into clickable links. color:inherit + underline keeps them
// legible on the inbound (light), drip (lavender), and outbound (mint) bubbles.
const URL_RE = /(https?:\/\/[^\s]+)/g;
function linkify(text: string) {
  return text.split(URL_RE).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ color: "inherit", textDecoration: "underline", wordBreak: "break-all" }}
      >
        {part}
      </a>
    ) : (
      part
    )
  );
}

interface Convo {
  contact_phone: string; last_at: string; last_body: string; last_dir: string;
  unread: number; client_id: number | null; lead_id: number | null; name: string | null;
  // [scheduled-visibility 2026-07-11] Pending scheduled reply on this thread, so
  // the inbox flags it as already-handled (and by whom) to prevent double-texting.
  scheduled_count?: number; next_scheduled_for?: string | null; scheduled_by?: string | null;
  // [drip-reply-tag 2026-07-12] Latest message is an inbound reply that followed a
  // drip touch — inbox flags "replied to drip" so a bare STOP has context.
  last_inbound_drip?: boolean;
}
interface Msg {
  id: number | string; direction: string; body: string; from_number: string | null;
  to_number: string | null; status: string; read_at: string | null; created_at: string;
  media_urls?: string[] | null; sent_by_name?: string | null;
  // [drip-reply-tag 2026-07-12] Set on inbound replies that arrived within 5 days
  // after a drip touch to the same lead, so the office sees WHY they texted.
  drip_related?: boolean; drip_campaign?: string | null; drip_step?: number | null;
  // [drip-in-thread 2026-07-12] source==="drip" is an automated drip SMS touch
  // folded into the thread (from message_log) so the office sees what the
  // customer is replying to. Labeled so it doesn't read as a person's text.
  source?: string;
}
interface ScheduledMsg {
  id: number; message: string; media_urls?: string[] | null;
  scheduled_for: string; status: string; contact_phone: string;
  scheduled_by?: string | null;
}
interface AttachPreview { file: File; objectUrl: string; r2Key?: string; uploading: boolean; }

function fmtPhone(p: string) {
  const d = String(p || "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
}
// [drip-reply-tag 2026-07-12] Humanize a drip campaign label for the reply badge.
// Friendly names ("Web Quote Drip") pass through; slugs (lead_drip_web) prettify.
function prettyCampaign(name: string): string {
  const n = String(name || "").trim();
  if (!n) return "";
  const map: Record<string, string> = { lead_drip_web: "Web Quote Drip", lead_drip_phone: "Phone-In Drip", quote_followup: "Quote Follow-up" };
  if (map[n]) return map[n];
  return /[_-]/.test(n) && !/\s/.test(n)
    ? n.replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    : n;
}
// [tz-normalize 2026-07-11] Single source of truth for reading a server
// timestamp. Server timestamps are UTC but may arrive WITHOUT a timezone marker
// (a bare "2026-07-11 19:14:00"), which `new Date(...)` would misread as the
// viewer's local time and shift by the whole UTC offset (e.g. show 2:14 PM as
// 7:14 PM in Chicago). We append "Z" when there's no marker so the value is
// parsed as UTC; toLocale* then renders it in the viewer's own zone (Central
// for the Phes office). Every time display in Messages goes through this so
// they can never drift apart.
function parseServerDate(s: string): Date {
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const withTZ = /Z$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + "Z";
  return new Date(withTZ);
}
function fmtTime(s: string) {
  if (!s) return "";
  const d = parseServerDate(s);
  if (isNaN(d.getTime())) return s;
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function fmtScheduled(s: string) {
  if (!s) return "";
  const d = parseServerDate(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Authenticated media component — fetches via Bearer token, creates blob URL.
// Supports both image and video based on the media key extension.
function AuthMedia({ msgId, idx, mediaKey }: { msgId: number; idx: number; mediaKey: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const blobRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    const src = `${API}/api/sms/media/${msgId}/${idx}`;
    fetch(src, { headers: getAuthHeaders() })
      .then(r => { if (!r.ok) throw new Error("fetch failed"); return r.blob(); })
      .then(b => {
        if (!alive) return;
        const url = URL.createObjectURL(b);
        blobRef.current = url;
        setBlobUrl(url);
      })
      .catch(() => { if (alive) setErr(true); });
    return () => {
      alive = false;
      if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    };
  }, [msgId, idx]);

  const isVideo = /\.(mp4|mov|webm|avi|mkv|3gpp|3gp|m4v)$/i.test(mediaKey);

  if (err) return <div style={{ fontSize: 11, color: MUTE, marginTop: 4 }}>[Media unavailable]</div>;
  if (!blobUrl) return (
    <div style={{ width: 160, height: 90, background: "#E5E2DC", borderRadius: 8, marginTop: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Image size={20} color={MUTE} />
    </div>
  );
  if (isVideo) return (
    <video controls src={blobUrl} style={{ maxWidth: 260, maxHeight: 180, borderRadius: 8, marginTop: 4, display: "block" }} />
  );
  return (
    <img src={blobUrl} alt="media" style={{ maxWidth: 260, maxHeight: 180, borderRadius: 8, marginTop: 4, display: "block", cursor: "pointer" }}
      onClick={() => window.open(blobUrl, "_blank")} />
  );
}

// [help-me-write-context 2026-07-11] Build a compact transcript of the recent
// thread so "Help me write" can reply in context (most recent last). Media-only
// messages are skipped; capped to the last 15 turns to keep the request cheap.
function buildTranscript(msgs: Msg[]): string {
  return msgs
    .filter(m => (m.body || "").trim())
    .slice(-15)
    .map(m => `${m.direction === "inbound" ? "Customer" : "Us"}: ${m.body.trim()}`)
    .join("\n");
}

// [composer-ai-tools 2026-07-02] Reusable AI toolbar for any SMS composer —
// used by BOTH the in-thread reply box and the New Message modal (so the
// Polish / Dictate tools don't go missing when you start a fresh message).
// Polish rewrites the draft's tone via /api/message-tone (one-tap Undo);
// Dictate does Web Speech voice-to-text. Self-contained state per instance.
// `conversation` (in-thread only) grounds "Help me write" in the real thread.
function ComposerAiTools({ value, onChange, conversation }: { value: string; onChange: (v: string) => void; conversation?: string }) {
  const { toast } = useToast();
  const [toneOpen, setToneOpen] = useState(false);
  const [toning, setToning] = useState(false);
  const [prePolish, setPrePolish] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  // [help-me-write 2026-07-11] Gmail-style "Help me write" — generate a draft
  // from a short instruction (distinct from Polish, which rewrites an existing
  // draft). Reuses the same prePolish slot so one Undo reverts either action.
  const [writeOpen, setWriteOpen] = useState(false);
  const [writing, setWriting] = useState(false);
  const [writePrompt, setWritePrompt] = useState("");
  const recognitionRef = useRef<any>(null);
  const speechSupported = typeof window !== "undefined" &&
    (("SpeechRecognition" in window) || ("webkitSpeechRecognition" in window));

  async function helpMeWrite() {
    const p = writePrompt.trim();
    if (!p || writing) return;
    setWriting(true);
    try {
      const r = await fetch(`${API}/api/help-me-write`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        // Pass any existing draft as light context so a half-written message
        // gets finished rather than tossed.
        // Pass the recent thread so the model can reply in context, plus any
        // half-written draft.
        body: JSON.stringify({ prompt: p, context: value.trim() || undefined, conversation: conversation || undefined }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data?.result) {
        setPrePolish(value);
        onChange(data.result);
        setWriteOpen(false);
        setWritePrompt("");
      } else {
        toast({ title: data?.error || "Couldn't generate a message", variant: "destructive" as any });
      }
    } catch {
      toast({ title: "Couldn't reach the AI writer", variant: "destructive" as any });
    } finally { setWriting(false); }
  }

  async function polishTone(tone: string) {
    const text = value.trim();
    if (!text || toning) return;
    setToneOpen(false);
    setToning(true);
    try {
      const r = await fetch(`${API}/api/message-tone`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ text, tone }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data?.result) { setPrePolish(value); onChange(data.result); }
      else toast({ title: data?.error || "Couldn't polish message", variant: "destructive" as any });
    } catch {
      toast({ title: "Couldn't reach the AI tone service", variant: "destructive" as any });
    } finally { setToning(false); }
  }
  function undoPolish() { if (prePolish === null) return; onChange(prePolish); setPrePolish(null); }

  function startDictation() {
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { toast({ title: "Voice input isn't supported on this browser" }); return; }
    try {
      const rec = new SR();
      rec.lang = "en-US"; rec.interimResults = true; rec.continuous = true;
      let base = value;
      rec.onresult = (e: any) => {
        let finalStr = "", interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalStr += t; else interim += t;
        }
        if (finalStr) base = (base ? base.replace(/\s+$/, "") + " " : "") + finalStr.trim();
        onChange((base + (interim ? " " + interim.trim() : "")).replace(/\s+$/, m => (m.length ? " " : "")));
      };
      rec.onerror = () => setListening(false);
      rec.onend = () => setListening(false);
      recognitionRef.current = rec;
      setListening(true);
      rec.start();
    } catch { setListening(false); toast({ title: "Couldn't start voice input" }); }
  }
  function stopDictation() { try { recognitionRef.current?.stop(); } catch { /* noop */ } setListening(false); }

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ position: "relative" }}>
        <button type="button" onClick={() => setWriteOpen(o => !o)} disabled={writing} title="Draft a message with AI from a short instruction"
          style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 10px", background: "#F1F0EC", border: `1px solid ${BORDER}`, borderRadius: 20, fontSize: 12, fontWeight: 700, fontFamily: FF, color: INK, cursor: writing ? "default" : "pointer", opacity: writing ? 0.5 : 1 }}>
          <Wand2 size={13} color={BRAND} /> {writing ? "Writing…" : "Help me write"}
        </button>
        {writeOpen && (
          <>
            <div onClick={() => setWriteOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
            <div style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, zIndex: 41, background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, boxShadow: "0 8px 24px rgba(10,14,26,0.16)", padding: 12, width: 300, maxWidth: "80vw" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                <Wand2 size={14} color={BRAND} />
                <span style={{ fontSize: 13, fontWeight: 800, fontFamily: FF, color: INK }}>Help me write</span>
              </div>
              <textarea
                autoFocus
                value={writePrompt}
                onChange={e => setWritePrompt(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); helpMeWrite(); } }}
                placeholder="e.g. Let the client know we're running 15 minutes late"
                rows={3}
                maxLength={1000}
                style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: "8px 10px", border: `1px solid ${BORDER}`, borderRadius: 10, fontSize: 13, fontFamily: FF, color: INK, outline: "none" }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                <button type="button" onClick={helpMeWrite} disabled={!writePrompt.trim() || writing}
                  style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 16px", background: BRAND, color: "#04241d", border: "none", borderRadius: 20, fontSize: 12, fontWeight: 800, fontFamily: FF, cursor: writePrompt.trim() && !writing ? "pointer" : "default", opacity: writePrompt.trim() && !writing ? 1 : 0.5 }}>
                  <Sparkles size={13} /> {writing ? "Writing…" : "Create"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      <div style={{ position: "relative" }}>
        <button type="button" onClick={() => setToneOpen(o => !o)} disabled={!value.trim() || toning} title="Rewrite the tone with AI"
          style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 10px", background: "#F1F0EC", border: `1px solid ${BORDER}`, borderRadius: 20, fontSize: 12, fontWeight: 700, fontFamily: FF, color: INK, cursor: value.trim() && !toning ? "pointer" : "default", opacity: value.trim() && !toning ? 1 : 0.5 }}>
          <Sparkles size={13} color={BRAND} /> {toning ? "Polishing…" : "Polish"} <ChevronDown size={12} color={MUTE} />
        </button>
        {toneOpen && (
          <>
            <div onClick={() => setToneOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
            <div style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, zIndex: 41, background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, boxShadow: "0 8px 24px rgba(10,14,26,0.16)", padding: 6, minWidth: 172 }}>
              {([["professional", "Professional"], ["friendly", "Friendly & warm"], ["concise", "Shorter"], ["apologetic", "Apologetic"]] as const).map(([v, label]) => (
                <button type="button" key={v} onClick={() => polishTone(v)}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 11px", background: "transparent", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: FF, color: INK, cursor: "pointer" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#F5F4F0")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {prePolish !== null && (
        <button type="button" onClick={undoPolish} title="Revert to your original wording"
          style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 10px", background: "transparent", border: `1px solid ${BORDER}`, borderRadius: 20, fontSize: 12, fontWeight: 700, fontFamily: FF, color: MUTE, cursor: "pointer" }}>
          <Undo2 size={12} /> Undo
        </button>
      )}
      {speechSupported && (
        <button type="button" onClick={() => (listening ? stopDictation() : startDictation())}
          title={listening ? "Stop dictation" : "Dictate your message"}
          style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 10px", background: listening ? "#FEECEC" : "#F1F0EC", border: `1px solid ${listening ? "#F5B5B5" : BORDER}`, borderRadius: 20, fontSize: 12, fontWeight: 700, fontFamily: FF, color: listening ? "#C0392B" : INK, cursor: "pointer" }}>
          <Mic size={13} color={listening ? "#C0392B" : BRAND} /> {listening ? "Listening…" : "Dictate"}
        </button>
      )}
    </div>
  );
}

export default function MessagesPage() {
  const isMobile = useIsMobile();
  const { toast } = useToast();
  const [convos, setConvos] = useState<Convo[]>([]);
  const [q, setQ] = useState("");
  const [active, setActive] = useState<Convo | null>(null);
  const [thread, setThread] = useState<Msg[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledMsg[]>([]);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<AttachPreview[]>([]);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const threadScrollRef = useRef<HTMLDivElement>(null);
  // [thread-scroll 2026-07-13] Remembers which conversation + last message we
  // last auto-scrolled for, so the 15s poll refetch doesn't yank the reader back
  // to the newest text while they're scrolled up reading history.
  const scrollStateRef = useRef<{ contact: string | null; lastId: string | null }>({ contact: null, lastId: null });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  // [send-schedule-menu 2026-07-02] The clock button is gone; scheduling now
  // lives in a caret dropdown attached to Send (Apple-style "Send / Schedule").
  const [sendMenuOpen, setSendMenuOpen] = useState(false);

  // [composer-autogrow 2026-07-02] Grow the reply box with its content (up to
  // ~6 lines) so a multi-line draft stays fully visible. Before this the box
  // was locked to rows={1}, so after a couple of lines the top scrolled out of
  // view and you couldn't see what you'd just typed. Reset to "auto" first so
  // it also shrinks back down on delete / after send clears the field.
  useEffect(() => {
    const el = replyRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [reply]);

  // Compose ("New message") state
  const [composeOpen, setComposeOpen] = useState(false);
  const [cQuery, setCQuery] = useState("");
  const [cResults, setCResults] = useState<{ type: string; id: number; name: string | null; phone: string }[]>([]);
  const [cPick, setCPick] = useState<{ type: string; id: number; name: string | null; phone: string } | null>(null);
  const [cBody, setCBody] = useState("");
  const [cSending, setCSending] = useState(false);

  const loadConvos = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/sms/conversations${q ? `?q=${encodeURIComponent(q)}` : ""}`, { headers: getAuthHeaders() });
      if (r.ok) setConvos(await r.json());
    } catch { /* silent */ }
  }, [q]);

  const loadThread = useCallback(async (c: Convo) => {
    try {
      const r = await fetch(`${API}/api/sms/thread?phone=${encodeURIComponent(c.contact_phone)}`, { headers: getAuthHeaders() });
      if (r.ok) { const d = await r.json(); setThread(d.messages || []); }
    } catch { /* silent */ }
  }, []);

  const markRead = useCallback(async (c: Convo) => {
    try {
      await fetch(`${API}/api/sms/mark-read`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ phone: c.contact_phone }),
      });
      setConvos(cs => cs.map(x => x.contact_phone === c.contact_phone ? { ...x, unread: 0 } : x));
      // Nudge the sidebar's unread-messages badge to refetch now instead of
      // waiting up to 30s for its next poll, so the counter drops as you read.
      window.dispatchEvent(new Event("qleno:sms-read"));
    } catch { /* silent */ }
  }, []);

  const loadScheduled = useCallback(async (c: Convo) => {
    try {
      const r = await fetch(`${API}/api/sms/scheduled?phone=${encodeURIComponent(c.contact_phone)}`, { headers: getAuthHeaders() });
      if (r.ok) setScheduled(await r.json());
    } catch { /* silent */ }
  }, []);

  useEffect(() => { loadConvos(); }, [loadConvos]);

  // Auto-open a thread when navigating from the client profile (?phone=&clientId=)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const phone = params.get("phone");
    const clientIdParam = params.get("clientId");
    if (!phone) return;
    const p10 = phone.replace(/\D/g, "").slice(-10);
    if (!p10) return;
    const synth: Convo = {
      contact_phone: p10, last_at: "", last_body: "", last_dir: "outbound",
      unread: 0, client_id: clientIdParam ? parseInt(clientIdParam, 10) : null, lead_id: null, name: null,
    };
    setActive(synth);
    loadThread(synth);
    loadScheduled(synth);
    window.history.replaceState({}, "", window.location.pathname);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const authToken = useAuthStore(s => s.token);
  useEffect(() => {
    setActive(null); setThread([]); setScheduled([]); setReply(""); setAttachments([]);
    loadConvos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);
  useEffect(() => {
    const t = setInterval(() => {
      loadConvos();
      if (active) { loadThread(active); loadScheduled(active); }
    }, 15000);
    return () => clearInterval(t);
  }, [loadConvos, loadThread, loadScheduled, active]);
  // [thread-scroll 2026-07-13] The old version scrolled to the newest message on
  // EVERY `thread` change — and the 15s poll re-sets `thread` each tick, so the
  // office got dragged back to the bottom mid-read (Maribel + Francisco reported
  // it). Now: jump to newest only when a conversation is OPENED, or when a
  // genuinely new message arrives AND the reader is already near the bottom.
  // A poll that returns the same messages scrolls nothing.
  useEffect(() => {
    const contact = active?.contact_phone ?? null;
    const lastId = thread.length ? String(thread[thread.length - 1].id) : null;
    const prev = scrollStateRef.current;
    if (contact !== prev.contact) {
      // Opened a different conversation → land on the newest message.
      requestAnimationFrame(() => threadEndRef.current?.scrollIntoView({ behavior: "auto" }));
    } else if (lastId && lastId !== prev.lastId) {
      // New message in the same conversation → follow it down only if the reader
      // hasn't scrolled up (within ~140px of the bottom).
      const el = threadScrollRef.current;
      const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 140;
      if (nearBottom) threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    scrollStateRef.current = { contact, lastId };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread]);

  function openConvo(c: Convo) {
    setActive(c); loadThread(c); loadScheduled(c);
    setAttachments([]); setReply(""); setScheduleOpen(false);
    // [auto-mark-read 2026-07-19] Opening a thread to read it marks it read —
    // the manual "Mark as read" button was the only thing that cleared unread,
    // so clicking through threads left them all unread and the sidebar/list
    // counters never moved. Only fire when there's actually unread to clear.
    if (c.unread > 0) markRead(c);
  }

  // ── File attachment ────────────────────────────────────────────────────────
  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    e.target.value = "";
    const toAdd: AttachPreview[] = files.slice(0, 4 - attachments.length).map(f => ({
      file: f, objectUrl: URL.createObjectURL(f), uploading: true,
    }));
    setAttachments(prev => [...prev, ...toAdd]);

    for (const item of toAdd) {
      try {
        const fd = new FormData();
        fd.append("file", item.file);
        const r = await fetch(`${API}/api/sms/upload-media`, {
          method: "POST", headers: getAuthHeaders(), body: fd,
        });
        if (!r.ok) throw new Error("upload failed");
        const { key } = await r.json();
        setAttachments(prev => prev.map(a => a.objectUrl === item.objectUrl ? { ...a, r2Key: key, uploading: false } : a));
      } catch {
        toast({ title: "Upload failed", description: item.file.name, variant: "destructive" as any });
        setAttachments(prev => prev.filter(a => a.objectUrl !== item.objectUrl));
        URL.revokeObjectURL(item.objectUrl);
      }
    }
  }

  function removeAttachment(objectUrl: string) {
    setAttachments(prev => {
      const a = prev.find(x => x.objectUrl === objectUrl);
      if (a) URL.revokeObjectURL(a.objectUrl);
      return prev.filter(x => x.objectUrl !== objectUrl);
    });
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  async function send() {
    if ((!reply.trim() && attachments.length === 0) || !active || sending) return;
    if (attachments.some(a => a.uploading)) { toast({ title: "Please wait for uploads to finish" }); return; }
    setSending(true);
    try {
      const mediaKeys = attachments.filter(a => a.r2Key).map(a => a.r2Key!);
      const r = await fetch(`${API}/api/sms/send`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_phone: active.contact_phone, client_id: active.client_id, lead_id: active.lead_id,
          message: reply.trim(), media_urls: mediaKeys,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.sent) { toast({ title: "Sent" }); }
      else if (r.ok && !d.sent) { toast({ title: "Not sent", description: `Comms paused (${d.reason || "gated"}) — recorded only`, variant: "destructive" as any }); }
      else { toast({ title: "Failed to send", variant: "destructive" as any }); }
      setReply(""); setAttachments([]);
      await loadThread(active); await loadConvos();
    } catch { toast({ title: "Failed to send", variant: "destructive" as any }); }
    finally { setSending(false); }
  }

  // ── Schedule send ──────────────────────────────────────────────────────────
  async function scheduleSend() {
    if (!active || scheduling) return;
    if (!reply.trim() && attachments.length === 0) return;
    if (!scheduleDate || !scheduleTime) { toast({ title: "Pick a date and time" }); return; }
    const scheduledFor = new Date(`${scheduleDate}T${scheduleTime}`);
    const minAllowed = new Date(Date.now() + 5 * 60_000);
    if (isNaN(scheduledFor.getTime()) || scheduledFor < minAllowed) {
      toast({ title: "Schedule at least 5 minutes from now", variant: "destructive" as any }); return;
    }
    if (attachments.some(a => a.uploading)) { toast({ title: "Please wait for uploads to finish" }); return; }
    setScheduling(true);
    try {
      const mediaKeys = attachments.filter(a => a.r2Key).map(a => a.r2Key!);
      const r = await fetch(`${API}/api/sms/schedule`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_phone: active.contact_phone, client_id: active.client_id, lead_id: active.lead_id,
          message: reply.trim(), media_urls: mediaKeys,
          scheduled_for: scheduledFor.toISOString(),
        }),
      });
      if (r.ok) {
        toast({ title: "Message scheduled", description: `Will send ${fmtScheduled(scheduledFor.toISOString())}` });
        setReply(""); setAttachments([]); setScheduleOpen(false); setScheduleDate(""); setScheduleTime("");
        await loadScheduled(active);
      } else {
        const d = await r.json().catch(() => ({}));
        toast({ title: "Failed to schedule", description: d.error || "", variant: "destructive" as any });
      }
    } catch { toast({ title: "Failed to schedule", variant: "destructive" as any }); }
    finally { setScheduling(false); }
  }

  async function cancelScheduled(id: number) {
    try {
      const r = await fetch(`${API}/api/sms/scheduled/${id}`, { method: "DELETE", headers: getAuthHeaders() });
      if (r.ok) { toast({ title: "Scheduled message cancelled" }); if (active) await loadScheduled(active); }
    } catch { /* silent */ }
  }

  // ── Compose ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!composeOpen || cPick || cQuery.trim().length < 2) { setCResults([]); return; }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`${API}/api/sms/contact-search?q=${encodeURIComponent(cQuery.trim())}`, { headers: getAuthHeaders() });
        if (r.ok && alive) setCResults(await r.json());
      } catch { /* silent */ }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [cQuery, cPick, composeOpen]);

  function openCompose() { setComposeOpen(true); setCQuery(""); setCResults([]); setCPick(null); setCBody(""); }
  const rawDigits = cQuery.replace(/\D/g, "");
  const canUseRaw = !cPick && rawDigits.length >= 10;
  const composeRecipientPhone = cPick ? cPick.phone : (canUseRaw ? cQuery.trim() : null);

  async function sendCompose() {
    if (!composeRecipientPhone || !cBody.trim() || cSending) return;
    setCSending(true);
    try {
      const payload: any = { contact_phone: composeRecipientPhone, message: cBody.trim() };
      if (cPick?.type === "client") payload.client_id = cPick.id;
      if (cPick?.type === "lead") payload.lead_id = cPick.id;
      const r = await fetch(`${API}/api/sms/send`, {
        method: "POST", headers: { ...getAuthHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.sent) toast({ title: "Sent" });
      else if (r.ok && !d.sent) toast({ title: "Not sent", description: `Comms paused (${d.reason || "gated"}) — recorded only`, variant: "destructive" as any });
      else { toast({ title: "Failed to send", variant: "destructive" as any }); setCSending(false); return; }
      const p10 = composeRecipientPhone.replace(/\D/g, "").slice(-10);
      const convo: Convo = {
        contact_phone: p10, last_at: new Date().toISOString(), last_body: cBody.trim(), last_dir: "outbound",
        unread: 0, client_id: cPick?.type === "client" ? cPick.id : null, lead_id: cPick?.type === "lead" ? cPick.id : null,
        name: cPick?.name ?? null,
      };
      setComposeOpen(false);
      setActive(convo); loadThread(convo); loadScheduled(convo); loadConvos();
    } catch { toast({ title: "Failed to send", variant: "destructive" as any }); }
    finally { setCSending(false); }
  }

  const showList = !isMobile || !active;
  const showThread = !isMobile || !!active;

  const canSend = (reply.trim() || attachments.length > 0) && !attachments.some(a => a.uploading);

  // Min datetime for schedule picker: now + 5 minutes (enforced in scheduleSend too)
  const nowPlusMins = new Date(Date.now() + 5 * 60_000);
  const minDate = `${nowPlusMins.getFullYear()}-${String(nowPlusMins.getMonth()+1).padStart(2,"0")}-${String(nowPlusMins.getDate()).padStart(2,"0")}`;
  const minTime = `${String(nowPlusMins.getHours()).padStart(2,"0")}:${String(nowPlusMins.getMinutes()).padStart(2,"0")}`;

  function openSchedulePicker() {
    if (!scheduleOpen) {
      const d = new Date(Date.now() + 60 * 60_000); // default: 1 hour from now
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const hh = String(d.getHours()).padStart(2, "0");
      const min = String(d.getMinutes()).padStart(2, "0");
      if (!scheduleDate) setScheduleDate(`${yyyy}-${mm}-${dd}`);
      if (!scheduleTime) setScheduleTime(`${hh}:${min}`);
    }
    setScheduleOpen(o => !o);
  }

  return (
    <DashboardLayout>
      <div style={{ fontFamily: FF, height: "calc(100vh - 120px)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 0 14px" }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: INK, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <MessageSquare size={20} /> Messages
          </h1>
          <button onClick={openCompose}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 14px", background: BRAND, color: "#04241d", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer", fontFamily: FF }}>
            <Plus size={16} /> New message
          </button>
        </div>
        <div style={{ display: "flex", flex: 1, gap: 14, minHeight: 0 }}>

          {/* Conversation list */}
          {showList && (
            <div style={{ width: isMobile ? "100%" : 360, flexShrink: 0, display: "flex", flexDirection: "column", border: `1px solid ${BORDER}`, borderRadius: 12, background: "#fff", overflow: "hidden" }}>
              <div style={{ padding: 10, borderBottom: `1px solid ${BORDER}`, position: "relative" }}>
                <Search size={15} color={MUTE} style={{ position: "absolute", left: 20, top: 19 }} />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name or number"
                  style={{ width: "100%", padding: "9px 12px 9px 34px", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, fontFamily: FF, boxSizing: "border-box" }} />
              </div>
              <div style={{ overflowY: "auto", flex: 1 }}>
                {convos.length === 0 && <p style={{ textAlign: "center", color: MUTE, fontSize: 13, padding: 30 }}>No conversations yet.</p>}
                {convos.map(c => (
                  <button key={c.contact_phone} onClick={() => openConvo(c)}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "12px 14px", border: "none", borderBottom: `1px solid ${BORDER}`, cursor: "pointer",
                      background: active?.contact_phone === c.contact_phone ? "#F1F0EC" : "#fff", fontFamily: FF }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                      <span style={{ fontSize: 14, fontWeight: c.unread > 0 ? 800 : 600, color: INK, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {c.name || fmtPhone(c.contact_phone)}
                      </span>
                      <span style={{ fontSize: 11, color: MUTE, flexShrink: 0 }}>{fmtTime(c.last_at)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 3, alignItems: "center" }}>
                      <span style={{ fontSize: 12, color: c.unread > 0 ? INK : MUTE, fontWeight: c.unread > 0 ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {c.last_dir === "outbound" ? "You: " : ""}{c.last_body || "[media]"}
                      </span>
                      {c.unread > 0 && <span style={{ background: BRAND, color: "#04241d", fontSize: 11, fontWeight: 800, borderRadius: 999, padding: "1px 7px", flexShrink: 0 }}>{c.unread}</span>}
                    </div>
                    {/* [scheduled-visibility 2026-07-11] Pending scheduled reply — tells the
                        team this thread is already handled (and by whom) so they don't re-text. */}
                    {(c.scheduled_count ?? 0) > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 5 }}>
                        <Clock size={11} color="#B45309" />
                        <span style={{ fontSize: 11, fontWeight: 700, color: "#B45309", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          Reply scheduled{c.scheduled_by ? ` by ${c.scheduled_by}` : ""}{c.next_scheduled_for ? ` · ${fmtScheduled(c.next_scheduled_for)}` : ""}
                        </span>
                      </div>
                    )}
                    {/* [drip-reply-tag 2026-07-12] Their latest message replied to a
                        drip touch — so a bare "Stop" has context without opening the lead. */}
                    {c.last_inbound_drip && (
                      <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 5 }}>
                        <Zap size={11} color="#7C3AED" />
                        <span style={{ fontSize: 11, fontWeight: 700, color: "#7C3AED" }}>Replied to drip</span>
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Thread + composer */}
          {showThread && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", border: `1px solid ${BORDER}`, borderRadius: 12, background: "#fff", overflow: "hidden", minWidth: 0 }}>
              {!active ? (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: MUTE, fontSize: 14 }}>
                  Select a conversation
                </div>
              ) : (
                <>
                  {/* Thread header */}
                  <div style={{ padding: "12px 14px", borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", gap: 10 }}>
                    {isMobile && <button onClick={() => setActive(null)} style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0 }}><ChevronLeft size={20} color={INK} /></button>}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {(active.client_id || active.lead_id) ? (
                        <button
                          // [msg-name-link 2026-07-14] Name → profile. Clients go
                          // to /customers/:id; LEADS now open the lead in the
                          // pipeline (/leads?lead=:id) instead of being dead text
                          // (Sal: "from her name I should go to her profile").
                          onClick={() => window.open(
                            active.client_id
                              ? `${import.meta.env.BASE_URL.replace(/\/$/, "")}/customers/${active.client_id}`
                              : `${import.meta.env.BASE_URL.replace(/\/$/, "")}/leads?lead=${active.lead_id}`,
                            "_blank")}
                          title={active.client_id ? "Open client profile" : "Open lead"}
                          style={{ fontSize: 15, fontWeight: 700, color: INK, background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                          {active.name || fmtPhone(active.contact_phone)}
                        </button>
                      ) : (
                        <div style={{ fontSize: 15, fontWeight: 700, color: INK }}>{active.name || fmtPhone(active.contact_phone)}</div>
                      )}
                      <div style={{ fontSize: 12, color: MUTE }}>{fmtPhone(active.contact_phone)}{active.client_id ? " · Client" : active.lead_id ? " · Lead" : ""}</div>
                    </div>
                    {active.unread > 0 && (
                      <button onClick={() => markRead(active)}
                        style={{ padding: "6px 12px", background: "#F1F0EC", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12, fontWeight: 700, color: INK, cursor: "pointer", fontFamily: FF, flexShrink: 0 }}>
                        Mark as read
                      </button>
                    )}
                  </div>

                  {/* Thread messages */}
                  <div ref={threadScrollRef} style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 8, background: "#FAFAF9" }}>

                    {/* Scheduled messages (pending) shown at top with indicator */}
                    {scheduled.map(s => (
                      <div key={`sched-${s.id}`} style={{ display: "flex", justifyContent: "flex-end" }}>
                        <div style={{ maxWidth: "75%", padding: "9px 12px", borderRadius: 12, background: "#F1F0EC", border: `1px dashed ${BORDER}`,
                          borderBottomRightRadius: 3, position: "relative" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                            <Clock size={11} color={MUTE} />
                            <span style={{ fontSize: 10, color: MUTE, fontWeight: 600 }}>Scheduled{s.scheduled_by ? ` by ${s.scheduled_by}` : ""} · {fmtScheduled(s.scheduled_for)}</span>
                            <button onClick={() => cancelScheduled(s.id)} title="Cancel scheduled message"
                              style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", padding: 0, display: "flex" }}>
                              <Trash2 size={11} color={MUTE} />
                            </button>
                          </div>
                          <div style={{ fontSize: 13.5, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word", color: INK }}>
                            {linkify(s.message)}
                          </div>
                        </div>
                      </div>
                    ))}

                    {/* Sent/received messages */}
                    {thread.map(m => {
                      const inbound = m.direction === "inbound";
                      const isDrip = !inbound && m.source === "drip";
                      const mediaKeys = Array.isArray(m.media_urls) ? m.media_urls : [];
                      return (
                        <div key={`${m.source || "s"}-${m.id}`} style={{ display: "flex", flexDirection: "column", alignItems: inbound ? "flex-start" : "flex-end" }}>
                          {/* [drip-in-thread 2026-07-12] Automated drip touch, labeled so
                              it doesn't read as an office reply. */}
                          {isDrip ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2, paddingRight: 4 }}>
                              <Zap size={10} color="#7C3AED" />
                              <span style={{ fontSize: 10, color: "#7C3AED", fontWeight: 700 }}>
                                Drip{m.drip_campaign ? ` · ${prettyCampaign(m.drip_campaign)}` : ""}{m.drip_step ? ` · touch ${m.drip_step}` : ""}
                              </span>
                            </div>
                          ) : (!inbound && m.sent_by_name && (
                            <div style={{ fontSize: 10, color: MUTE, fontWeight: 600, marginBottom: 2, paddingRight: 4 }}>{m.sent_by_name}</div>
                          ))}
                          <div style={{ maxWidth: "75%", padding: "9px 12px", borderRadius: 12,
                            background: inbound ? "#F1F0EC" : isDrip ? "#F3F0FD" : BRAND,
                            color: inbound ? INK : isDrip ? "#2E1065" : "#04241d",
                            border: isDrip ? "1px solid #E4DBFB" : "none",
                            borderBottomLeftRadius: inbound ? 3 : 12, borderBottomRightRadius: inbound ? 12 : 3 }}>
                            {m.body && (
                              <div style={{ fontSize: 13.5, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{linkify(m.body)}</div>
                            )}
                            {mediaKeys.map((key, idx) => (
                              <AuthMedia key={idx} msgId={m.id as number} idx={idx} mediaKey={key} />
                            ))}
                            <div style={{ fontSize: 10, marginTop: 4, opacity: 0.7, textAlign: "right" }}>
                              {fmtTime(m.created_at)}{!inbound && m.status && m.status !== "sent" ? ` · ${m.status}` : ""}
                            </div>
                          </div>
                          {/* [drip-reply-tag 2026-07-12] This inbound reply followed a
                              drip touch — flag it so the office knows a "Stop" was aimed
                              at the automated campaign, not a live conversation. */}
                          {inbound && m.drip_related && (
                            <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, paddingLeft: 2 }}>
                              <Zap size={10} color="#7C3AED" />
                              <span style={{ fontSize: 10.5, fontWeight: 700, color: "#7C3AED" }}>
                                Reply to drip{m.drip_campaign ? `: ${prettyCampaign(m.drip_campaign)}` : ""}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <div ref={threadEndRef} />
                  </div>

                  {/* Attachment previews */}
                  {attachments.length > 0 && (
                    <div style={{ padding: "6px 10px 0", borderTop: `1px solid ${BORDER}`, display: "flex", gap: 8, flexWrap: "wrap", background: "#fff" }}>
                      {attachments.map(a => (
                        <div key={a.objectUrl} style={{ position: "relative", width: 60, height: 60, borderRadius: 8, overflow: "hidden", border: `1px solid ${BORDER}` }}>
                          {a.file.type.startsWith("video/") ? (
                            <video src={a.objectUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          ) : (
                            <img src={a.objectUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          )}
                          {a.uploading && (
                            <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <div style={{ width: 16, height: 16, border: "2px solid #fff", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                            </div>
                          )}
                          <button onClick={() => removeAttachment(a.objectUrl)}
                            style={{ position: "absolute", top: 2, right: 2, background: "rgba(10,14,26,0.7)", border: "none", borderRadius: "50%", width: 18, height: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
                            <X size={10} color="#fff" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Schedule picker */}
                  {scheduleOpen && (
                    <div style={{ padding: "8px 10px", borderTop: `1px solid ${BORDER}`, background: "#F7F6F3", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <Clock size={13} color={MUTE} />
                      <span style={{ fontSize: 12, color: MUTE, fontWeight: 600 }}>Send at:</span>
                      <input type="date" value={scheduleDate} min={minDate} onChange={e => setScheduleDate(e.target.value)}
                        style={{ padding: "5px 8px", border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 13, fontFamily: FF }} />
                      <input type="time" value={scheduleTime} min={scheduleDate === minDate ? minTime : undefined} onChange={e => setScheduleTime(e.target.value)}
                        style={{ padding: "5px 8px", border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 13, fontFamily: FF }} />
                      <button onClick={scheduleSend} disabled={!canSend || !scheduleDate || !scheduleTime || scheduling}
                        style={{ padding: "5px 12px", background: BRAND, color: "#04241d", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: "pointer",
                          opacity: !canSend || !scheduleDate || !scheduleTime || scheduling ? 0.5 : 1, fontFamily: FF }}>
                        {scheduling ? "Scheduling…" : "Schedule"}
                      </button>
                      <button onClick={() => setScheduleOpen(false)}
                        style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
                        <X size={14} color={MUTE} />
                      </button>
                    </div>
                  )}

                  {/* [message-tone + voice 2026-07-02] AI toolbar (Polish +
                      Dictate) above the input row. [attach-move 2026-07-02] The
                      attach button now lives here on the RIGHT, so the input row
                      is just textarea + Send — the text box gets the full width
                      and wraps far less. Shared AI tools component so the New
                      Message modal gets the same tools. */}
                  <div style={{ padding: "8px 10px 2px", background: "#fff", borderTop: `1px solid ${BORDER}`, display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <ComposerAiTools value={reply} onChange={setReply} conversation={buildTranscript(thread)} />
                    </div>
                    {/* Hidden file input */}
                    <input ref={fileInputRef} type="file" multiple accept="image/*,video/*" style={{ display: "none" }} onChange={handleFileSelect} />
                    <button onClick={() => fileInputRef.current?.click()} title="Attach image or video"
                      style={{ padding: 8, background: "#F1F0EC", border: `1px solid ${BORDER}`, borderRadius: 10, cursor: "pointer", display: "flex", alignItems: "center", flexShrink: 0 }}>
                      <Paperclip size={15} color={MUTE} />
                    </button>
                  </div>

                  {/* Composer */}
                  <div style={{ padding: 10, borderTop: "none", display: "flex", gap: 8, alignItems: "flex-end", background: "#fff" }}>
                    <textarea ref={replyRef} value={reply} onChange={e => setReply(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !scheduleOpen) { e.preventDefault(); send(); } }}
                      placeholder={scheduleOpen ? "Type message to schedule…" : "Type a reply…"} rows={1}
                      style={{ flex: 1, resize: "none", padding: "10px 12px", border: `1px solid ${scheduleOpen ? BRAND : BORDER}`, borderRadius: 10, fontSize: 14, lineHeight: 1.35, fontFamily: FF, maxHeight: 140, overflowY: "auto" }} />
                    {/* [send-schedule-menu 2026-07-02] Apple-style split Send:
                        the main button sends now; the attached caret opens a
                        small menu with "Schedule send…" (the standalone clock
                        button is gone). Hidden while the schedule picker is
                        open — that row has its own Schedule / cancel controls. */}
                    {!scheduleOpen && (
                      <div style={{ position: "relative", flexShrink: 0 }}>
                        <div style={{ display: "flex", alignItems: "stretch", height: 44 }}>
                          <button onClick={send} disabled={!canSend || sending}
                            style={{ padding: "0 14px", background: BRAND, color: "#04241d", border: "none", borderRadius: "10px 0 0 10px", fontWeight: 800, cursor: canSend && !sending ? "pointer" : "default", opacity: canSend && !sending ? 1 : 0.5, display: "flex", alignItems: "center", gap: 6, fontFamily: FF }}>
                            <Send size={15} /> {sending ? "…" : "Send"}
                          </button>
                          <button onClick={() => setSendMenuOpen(o => !o)} disabled={sending} title="Send options"
                            style={{ padding: "0 8px", background: BRAND, color: "#04241d", border: "none", borderLeft: "1px solid rgba(4,36,29,0.18)", borderRadius: "0 10px 10px 0", cursor: sending ? "default" : "pointer", opacity: sending ? 0.5 : 1, display: "flex", alignItems: "center" }}>
                            <ChevronDown size={16} />
                          </button>
                        </div>
                        {sendMenuOpen && (
                          <>
                            <div onClick={() => setSendMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                            <div style={{ position: "absolute", bottom: "calc(100% + 6px)", right: 0, zIndex: 41, background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, boxShadow: "0 8px 24px rgba(10,14,26,0.16)", padding: 6, minWidth: 190 }}>
                              {/* "Send now" removed — the main Send button already
                                  does that; the caret menu only holds Schedule. */}
                              <button onClick={() => { setSendMenuOpen(false); openSchedulePicker(); }}
                                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "9px 11px", background: "transparent", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: FF, color: INK, cursor: "pointer" }}
                                onMouseEnter={e => (e.currentTarget.style.background = "#F5F4F0")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                                <Clock size={14} color={MUTE} /> Schedule send…
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Compose / New message modal */}
      {composeOpen && (
        <div onClick={() => setComposeOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(10,14,26,0.45)", display: "flex", alignItems: isMobile ? "flex-end" : "center", justifyContent: "center", padding: isMobile ? 0 : 18, zIndex: 60 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: "#fff", borderRadius: isMobile ? "16px 16px 0 0" : 16, padding: "20px 20px 18px", width: "100%", maxWidth: 460, fontFamily: FF }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <p style={{ fontSize: 17, fontWeight: 800, color: INK, margin: 0 }}>New message</p>
              <button onClick={() => setComposeOpen(false)} style={{ border: "none", background: "transparent", cursor: "pointer", padding: 4 }}><X size={18} color={MUTE} /></button>
            </div>

            {cPick ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 12px", border: `1px solid ${BORDER}`, borderRadius: 10, marginBottom: 12, background: "#F7F6F3" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: INK }}>{cPick.name || fmtPhone(cPick.phone)}</div>
                  <div style={{ fontSize: 12, color: MUTE }}>{fmtPhone(cPick.phone)} · {cPick.type === "client" ? "Client" : "Lead"}</div>
                </div>
                <button onClick={() => { setCPick(null); setCQuery(""); }} style={{ border: "none", background: "transparent", cursor: "pointer" }}><X size={16} color={MUTE} /></button>
              </div>
            ) : (
              <div style={{ position: "relative", marginBottom: 12 }}>
                <input value={cQuery} onChange={e => setCQuery(e.target.value)} autoFocus
                  placeholder="To: search client/lead or type a phone number"
                  style={{ width: "100%", padding: "10px 12px", border: `1px solid ${BORDER}`, borderRadius: 10, fontSize: 14, fontFamily: FF, boxSizing: "border-box" }} />
                {(cResults.length > 0 || canUseRaw) && (
                  <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, marginTop: 6, maxHeight: 200, overflowY: "auto" }}>
                    {cResults.map(r => (
                      <button key={`${r.type}-${r.id}`} onClick={() => { setCPick(r); setCResults([]); }}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", border: "none", borderBottom: `1px solid ${BORDER}`, background: "#fff", cursor: "pointer", fontFamily: FF }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: INK }}>{r.name || fmtPhone(r.phone)}</span>
                        <span style={{ fontSize: 12, color: MUTE }}> · {fmtPhone(r.phone)} · {r.type === "client" ? "Client" : "Lead"}</span>
                      </button>
                    ))}
                    {canUseRaw && (
                      <button onClick={() => setCPick({ type: "raw", id: 0, name: null, phone: cQuery.trim() })}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", border: "none", background: "#fff", cursor: "pointer", fontFamily: FF }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: BRAND }}>Text {fmtPhone(cQuery.trim())}</span>
                        <span style={{ fontSize: 12, color: MUTE }}> · new number</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            <textarea value={cBody} onChange={e => setCBody(e.target.value)} placeholder="Type your message…" rows={4}
              style={{ width: "100%", resize: "none", padding: "10px 12px", border: `1px solid ${BORDER}`, borderRadius: 10, fontSize: 14, fontFamily: FF, boxSizing: "border-box", marginBottom: 8 }} />

            {/* [composer-ai-tools 2026-07-02] Same Polish / Dictate tools as the
                in-thread composer, so they don't vanish on a new message. */}
            <div style={{ marginBottom: 12 }}>
              <ComposerAiTools value={cBody} onChange={setCBody} />
            </div>

            <button onClick={sendCompose} disabled={!composeRecipientPhone || !cBody.trim() || cSending}
              style={{ width: "100%", height: 46, background: BRAND, color: "#04241d", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 800,
                cursor: composeRecipientPhone && cBody.trim() && !cSending ? "pointer" : "default", opacity: composeRecipientPhone && cBody.trim() && !cSending ? 1 : 0.5,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontFamily: FF }}>
              <Send size={16} /> {cSending ? "Sending…" : "Send message"}
            </button>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </DashboardLayout>
  );
}
