import { useState, useEffect, useCallback, useRef } from "react";
import { getAuthHeaders, useAuthStore } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useIsMobile } from "@/hooks/use-mobile";
import { useToast } from "@/hooks/use-toast";
import { MessageSquare, Search, Send, ChevronLeft, Plus, X, Paperclip, Clock, Trash2, Image } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";
const INK = "#1A1917";
const MUTE = "#6B6860";
const BORDER = "#E5E2DC";
const BRAND = "#00C9A0";

interface Convo {
  contact_phone: string; last_at: string; last_body: string; last_dir: string;
  unread: number; client_id: number | null; lead_id: number | null; name: string | null;
}
interface Msg {
  id: number; direction: string; body: string; from_number: string | null;
  to_number: string | null; status: string; read_at: string | null; created_at: string;
  media_urls?: string[] | null; sent_by_name?: string | null;
}
interface ScheduledMsg {
  id: number; message: string; media_urls?: string[] | null;
  scheduled_for: string; status: string; contact_phone: string;
}
interface AttachPreview { file: File; objectUrl: string; r2Key?: string; uploading: boolean; }

function fmtPhone(p: string) {
  const d = String(p || "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
}
function fmtTime(s: string) {
  if (!s) return "";
  // Normalize to UTC: replace space separator and append Z if no timezone marker
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const withTZ = /Z$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + "Z";
  const d = new Date(withTZ);
  if (isNaN(d.getTime())) return s;
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function fmtScheduled(s: string) {
  const d = new Date(s);
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
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  useEffect(() => { threadEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [thread]);

  function openConvo(c: Convo) {
    setActive(c); loadThread(c); loadScheduled(c);
    setAttachments([]); setReply(""); setScheduleOpen(false);
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
                      {active.client_id ? (
                        <button
                          onClick={() => window.open(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/customers/${active.client_id}`, "_blank")}
                          style={{ fontSize: 15, fontWeight: 700, color: INK, background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                          {active.name || fmtPhone(active.contact_phone)}
                          <span style={{ fontSize: 11, color: "var(--brand, #5B9BD5)", marginLeft: 8, fontWeight: 600 }}>Open profile ↗</span>
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
                  <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 8, background: "#FAFAF9" }}>

                    {/* Scheduled messages (pending) shown at top with indicator */}
                    {scheduled.map(s => (
                      <div key={`sched-${s.id}`} style={{ display: "flex", justifyContent: "flex-end" }}>
                        <div style={{ maxWidth: "75%", padding: "9px 12px", borderRadius: 12, background: "#F1F0EC", border: `1px dashed ${BORDER}`,
                          borderBottomRightRadius: 3, position: "relative" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                            <Clock size={11} color={MUTE} />
                            <span style={{ fontSize: 10, color: MUTE, fontWeight: 600 }}>Scheduled · {fmtScheduled(s.scheduled_for)}</span>
                            <button onClick={() => cancelScheduled(s.id)} title="Cancel scheduled message"
                              style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", padding: 0, display: "flex" }}>
                              <Trash2 size={11} color={MUTE} />
                            </button>
                          </div>
                          <div style={{ fontSize: 13.5, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word", color: INK }}>
                            {s.message}
                          </div>
                        </div>
                      </div>
                    ))}

                    {/* Sent/received messages */}
                    {thread.map(m => {
                      const inbound = m.direction === "inbound";
                      const mediaKeys = Array.isArray(m.media_urls) ? m.media_urls : [];
                      return (
                        <div key={m.id} style={{ display: "flex", flexDirection: "column", alignItems: inbound ? "flex-start" : "flex-end" }}>
                          {!inbound && m.sent_by_name && (
                            <div style={{ fontSize: 10, color: MUTE, fontWeight: 600, marginBottom: 2, paddingRight: 4 }}>{m.sent_by_name}</div>
                          )}
                          <div style={{ maxWidth: "75%", padding: "9px 12px", borderRadius: 12, background: inbound ? "#F1F0EC" : BRAND, color: inbound ? INK : "#04241d",
                            borderBottomLeftRadius: inbound ? 3 : 12, borderBottomRightRadius: inbound ? 12 : 3 }}>
                            {m.body && (
                              <div style={{ fontSize: 13.5, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.body}</div>
                            )}
                            {mediaKeys.map((key, idx) => (
                              <AuthMedia key={idx} msgId={m.id} idx={idx} mediaKey={key} />
                            ))}
                            <div style={{ fontSize: 10, marginTop: 4, opacity: 0.7, textAlign: "right" }}>
                              {fmtTime(m.created_at)}{!inbound && m.status && m.status !== "sent" ? ` · ${m.status}` : ""}
                            </div>
                          </div>
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

                  {/* Composer */}
                  <div style={{ padding: 10, borderTop: `1px solid ${BORDER}`, display: "flex", gap: 8, alignItems: "flex-end", background: "#fff" }}>
                    {/* Hidden file input */}
                    <input ref={fileInputRef} type="file" multiple accept="image/*,video/*" style={{ display: "none" }} onChange={handleFileSelect} />
                    <button onClick={() => fileInputRef.current?.click()} title="Attach image or video"
                      style={{ padding: 10, background: "#F1F0EC", border: `1px solid ${BORDER}`, borderRadius: 10, cursor: "pointer", display: "flex", alignItems: "center", flexShrink: 0 }}>
                      <Paperclip size={15} color={MUTE} />
                    </button>
                    <textarea value={reply} onChange={e => setReply(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !scheduleOpen) { e.preventDefault(); send(); } }}
                      placeholder={scheduleOpen ? "Type message to schedule…" : "Type a reply…"} rows={1}
                      style={{ flex: 1, resize: "none", padding: "10px 12px", border: `1px solid ${scheduleOpen ? BRAND : BORDER}`, borderRadius: 10, fontSize: 14, fontFamily: FF, maxHeight: 120 }} />
                    <button onClick={openSchedulePicker} title="Schedule message"
                      style={{ padding: 10, background: scheduleOpen ? "#E8FAF6" : "#F1F0EC", border: `1px solid ${scheduleOpen ? BRAND : BORDER}`, borderRadius: 10, cursor: "pointer", display: "flex", alignItems: "center", flexShrink: 0 }}>
                      <Clock size={15} color={scheduleOpen ? BRAND : MUTE} />
                    </button>
                    {!scheduleOpen && (
                      <button onClick={send} disabled={!canSend || sending}
                        style={{ padding: "0 16px", background: BRAND, color: "#04241d", border: "none", borderRadius: 10, fontWeight: 800, cursor: canSend && !sending ? "pointer" : "default", opacity: canSend && !sending ? 1 : 0.5, display: "flex", alignItems: "center", gap: 6, height: 44, flexShrink: 0 }}>
                        <Send size={15} /> {sending ? "…" : "Send"}
                      </button>
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
              style={{ width: "100%", resize: "none", padding: "10px 12px", border: `1px solid ${BORDER}`, borderRadius: 10, fontSize: 14, fontFamily: FF, boxSizing: "border-box", marginBottom: 12 }} />

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
