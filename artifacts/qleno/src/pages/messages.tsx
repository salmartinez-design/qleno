import { useState, useEffect, useCallback, useRef } from "react";
import { getAuthHeaders, useAuthStore } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useIsMobile } from "@/hooks/use-mobile";
import { useToast } from "@/hooks/use-toast";
import { MessageSquare, Search, Send, ChevronLeft } from "lucide-react";

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
}

function fmtPhone(p: string) {
  const d = String(p || "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
}
function fmtTime(s: string) {
  if (!s) return "";
  const d = new Date(s);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function MessagesPage() {
  const isMobile = useIsMobile();
  const { toast } = useToast();
  const [convos, setConvos] = useState<Convo[]>([]);
  const [q, setQ] = useState("");
  const [active, setActive] = useState<Convo | null>(null);
  const [thread, setThread] = useState<Msg[]>([]);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);

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
      // Opening clears the unread badge locally.
      setConvos(cs => cs.map(x => x.contact_phone === c.contact_phone ? { ...x, unread: 0 } : x));
    } catch { /* silent */ }
  }, []);

  useEffect(() => { loadConvos(); }, [loadConvos]);
  // Re-scope on company switch: the auth token changes on every switch-company,
  // so clear the open thread + reload the conversation list for the new tenant
  // immediately (no manual refresh, no stale co1 data lingering under co4).
  const authToken = useAuthStore(s => s.token);
  useEffect(() => {
    setActive(null); setThread([]); setReply("");
    loadConvos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);
  // Light polling so new inbound shows up without a manual refresh.
  useEffect(() => {
    const t = setInterval(() => { loadConvos(); if (active) loadThread(active); }, 15000);
    return () => clearInterval(t);
  }, [loadConvos, loadThread, active]);
  useEffect(() => { threadEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [thread]);

  function openConvo(c: Convo) { setActive(c); loadThread(c); }

  async function send() {
    if (!reply.trim() || !active || sending) return;
    setSending(true);
    try {
      const r = await fetch(`${API}/api/sms/send`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ contact_phone: active.contact_phone, client_id: active.client_id, lead_id: active.lead_id, message: reply.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.sent) { toast({ title: "Sent" }); }
      else if (r.ok && !d.sent) { toast({ title: "Not sent", description: `Comms paused (${d.reason || "gated"}) — recorded only`, variant: "destructive" as any }); }
      else { toast({ title: "Failed to send", variant: "destructive" as any }); }
      setReply("");
      await loadThread(active); await loadConvos();
    } catch { toast({ title: "Failed to send", variant: "destructive" as any }); }
    finally { setSending(false); }
  }

  const showList = !isMobile || !active;
  const showThread = !isMobile || !!active;

  return (
    <DashboardLayout>
      <div style={{ fontFamily: FF, height: "calc(100vh - 120px)", display: "flex", flexDirection: "column" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: INK, margin: "0 0 14px", display: "flex", alignItems: "center", gap: 8 }}>
          <MessageSquare size={20} /> Messages
        </h1>
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
                        {c.last_dir === "outbound" ? "You: " : ""}{c.last_body}
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
                  <div style={{ padding: "12px 14px", borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", gap: 10 }}>
                    {isMobile && <button onClick={() => setActive(null)} style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0 }}><ChevronLeft size={20} color={INK} /></button>}
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: INK }}>{active.name || fmtPhone(active.contact_phone)}</div>
                      <div style={{ fontSize: 12, color: MUTE }}>{fmtPhone(active.contact_phone)}{active.client_id ? " · Client" : active.lead_id ? " · Lead" : ""}</div>
                    </div>
                  </div>
                  <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 8, background: "#FAFAF9" }}>
                    {thread.map(m => {
                      const inbound = m.direction === "inbound";
                      return (
                        <div key={m.id} style={{ display: "flex", justifyContent: inbound ? "flex-start" : "flex-end" }}>
                          <div style={{ maxWidth: "75%", padding: "9px 12px", borderRadius: 12, background: inbound ? "#F1F0EC" : BRAND, color: inbound ? INK : "#04241d",
                            borderBottomLeftRadius: inbound ? 3 : 12, borderBottomRightRadius: inbound ? 12 : 3 }}>
                            <div style={{ fontSize: 13.5, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.body}</div>
                            <div style={{ fontSize: 10, marginTop: 4, opacity: 0.7, textAlign: "right" }}>
                              {fmtTime(m.created_at)}{!inbound && m.status && m.status !== "sent" ? ` · ${m.status}` : ""}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    <div ref={threadEndRef} />
                  </div>
                  <div style={{ padding: 10, borderTop: `1px solid ${BORDER}`, display: "flex", gap: 8 }}>
                    <textarea value={reply} onChange={e => setReply(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                      placeholder="Type a reply…" rows={1}
                      style={{ flex: 1, resize: "none", padding: "10px 12px", border: `1px solid ${BORDER}`, borderRadius: 10, fontSize: 14, fontFamily: FF, maxHeight: 120 }} />
                    <button onClick={send} disabled={!reply.trim() || sending}
                      style={{ padding: "0 16px", background: BRAND, color: "#04241d", border: "none", borderRadius: 10, fontWeight: 800, cursor: reply.trim() && !sending ? "pointer" : "default", opacity: reply.trim() && !sending ? 1 : 0.5, display: "flex", alignItems: "center", gap: 6 }}>
                      <Send size={15} /> {sending ? "…" : "Send"}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
