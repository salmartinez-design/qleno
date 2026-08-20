import { useState, useMemo, Fragment } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";
import {
  Search, Copy, Check, FileText, Shield, Send, Ban, ChevronDown, ChevronRight,
  Mail, MessageSquare, Eye, Clock, X, AlertCircle,
} from "lucide-react";

// [agreement-office-list 2026-08-20] The Submissions tab was five read-only
// columns: form, client, submitted, status, signed by. Everything the office
// actually needed to run a contract was missing - whether the customer had
// even opened it, when we last chased them, the signed copy, the certificate,
// a way to send it again to a different address, and a way to stop a wrong
// agreement before somebody signs it. Nothing about a pending agreement could
// be acted on from this screen, so it got done by hand or not at all.

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, { headers: { ...getAuthHeaders(), "Content-Type": "application/json" }, ...opts });
  const text = await r.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
  if (!r.ok) throw new Error(json.error || "Request failed");
  return json;
}

type Bucket = "all" | "waiting" | "opened" | "signed" | "declined" | "cancelled" | "expired";

// One place decides what a row IS. The server stores four statuses; the office
// thinks in six, because "sent and never opened" and "opened and sitting
// there" are two different problems with two different answers.
function bucketOf(s: any): Exclude<Bucket, "all"> {
  if (s.status === "signed") return "signed";
  if (s.status === "declined") return "declined";
  if (s.status === "cancelled") return "cancelled";
  if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) return "expired";
  return s.viewed_at ? "opened" : "waiting";
}

const BUCKET_LABEL: Record<Exclude<Bucket, "all">, string> = {
  waiting: "Not opened", opened: "Opened", signed: "Signed",
  declined: "Declined", cancelled: "Cancelled", expired: "Expired",
};

const BUCKET_COLOR: Record<Exclude<Bucket, "all">, { bg: string; fg: string }> = {
  waiting: { bg: "#FDF3E4", fg: "#B45309" },
  opened: { bg: "#EEF2FF", fg: "#4338CA" },
  signed: { bg: "#D1FAE5", fg: "#065F46" },
  declined: { bg: "#FCEBEA", fg: "#B3261E" },
  cancelled: { bg: "#F0EEE9", fg: "#6B6860" },
  expired: { bg: "#F0EEE9", fg: "#6B6860" },
};

const EVENT_LABEL: Record<string, string> = {
  sent: "Sent for signature",
  viewed: "Opened by the customer",
  reminder_sent: "Reminder sent",
  resent: "Sent again",
  signed: "Signed",
  sealed: "Sealed, document locked",
  declined: "Declined by the customer",
  cancelled: "Cancelled by our office",
};

function fmt(d: any) {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "";
  return dt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function ago(d: any) {
  if (!d) return "";
  const ms = Date.now() - new Date(d).getTime();
  if (isNaN(ms)) return "";
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days}d ago`;
  const hrs = Math.floor(ms / 3600000);
  if (hrs >= 1) return `${hrs}h ago`;
  return "just now";
}

const th: React.CSSProperties = { padding: "10px 14px", fontSize: 11, fontWeight: 600, color: "#9E9B94", textAlign: "left", textTransform: "uppercase", letterSpacing: 0.5, borderBottom: "1px solid #E5E2DC", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "12px 14px", fontSize: 13, color: "#1A1917", borderBottom: "1px solid #F5F4F2", verticalAlign: "top" };
const inputStyle: React.CSSProperties = { width: "100%", padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13.5, fontFamily: "'Plus Jakarta Sans', sans-serif", boxSizing: "border-box", outline: "none" };
const labelStyle: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, color: "#1A1917", display: "block", marginBottom: 5 };

function iconBtn(color = "#6B6860"): React.CSSProperties {
  return { background: "none", border: "1px solid #E5E2DC", borderRadius: 6, padding: "5px 8px", cursor: "pointer", color, display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, fontFamily: "'Plus Jakarta Sans', sans-serif" };
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: any }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(10,14,26,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, width: "100%", maxWidth: 460, boxShadow: "0 10px 40px rgba(0,0,0,0.2)", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #F5F4F2", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#1A1917" }}>{title}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}><X size={17} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Timeline({ id }: { id: number }) {
  const { data: events = [], isLoading } = useQuery({
    queryKey: ["agreement-events", id],
    queryFn: () => apiFetch(`/api/form-templates/submissions/${id}/events`),
  });
  if (isLoading) return <div style={{ fontSize: 12.5, color: "#9E9B94" }}>Loading history...</div>;
  if (!(events as any[]).length) return <div style={{ fontSize: 12.5, color: "#9E9B94" }}>No history recorded for this agreement.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {(events as any[]).map((e: any) => (
        <div key={e.id} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#C9C5BC", marginTop: 6, flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "#1A1917" }}>{EVENT_LABEL[e.event_type] || e.event_type}</div>
            <div style={{ fontSize: 11.5, color: "#9E9B94" }}>
              {fmt(e.created_at)}
              {e.actor_email ? ` · ${e.actor_email}` : ""}
              {e.meta?.channel ? ` · ${e.meta.channel}` : ""}
              {e.meta?.reason ? ` · ${e.meta.reason}` : ""}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ResendModal({ row, onClose }: { row: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState(row.sent_to || row.client_email || "");
  const [phone, setPhone] = useState(row.sent_to_phone || row.client_phone || "");
  const [alsoText, setAlsoText] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => apiFetch(`/api/form-templates/submissions/${row.id}/resend`, {
      method: "POST", body: JSON.stringify({ email, phone, also_text: alsoText }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["form-submissions"] }); qc.invalidateQueries({ queryKey: ["agreement-events", row.id] }); onClose(); },
    onError: (e: any) => setErr(e.message),
  });
  return (
    <Modal title="Send this agreement again" onClose={onClose}>
      <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 12.5, color: "#6B6860", lineHeight: 1.6 }}>
          Same agreement, same link. Change the email or phone below if the customer wants it somewhere else. The 30 day clock and the reminders start over.
        </div>
        <div>
          <label style={labelStyle}>Send to email</label>
          <input value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} placeholder="name@example.com" />
        </div>
        <div>
          <label style={labelStyle}>Phone for the text</label>
          <input value={phone} onChange={e => setPhone(e.target.value)} style={inputStyle} placeholder="Optional" />
        </div>
        <label style={{ display: "flex", gap: 9, alignItems: "center", cursor: "pointer", fontSize: 13, color: "#1A1917" }}>
          <input type="checkbox" checked={alsoText} onChange={e => setAlsoText(e.target.checked)} />
          Text the link as well as emailing it
        </label>
        {err && <div style={{ fontSize: 12.5, color: "#B3261E" }}>{err}</div>}
      </div>
      <div style={{ padding: "14px 20px", borderTop: "1px solid #F5F4F2", display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button onClick={onClose} style={{ ...iconBtn(), padding: "9px 16px", fontSize: 13 }}>Cancel</button>
        <button onClick={() => { setErr(null); m.mutate(); }} disabled={m.isPending || !email.trim()} style={{ background: "var(--brand)", color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", cursor: m.isPending ? "not-allowed" : "pointer", fontWeight: 700, fontSize: 13, opacity: m.isPending || !email.trim() ? 0.6 : 1, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
          {m.isPending ? "Sending..." : "Send it"}
        </button>
      </div>
    </Modal>
  );
}

function CancelModal({ row, onClose }: { row: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<"revision" | "cancelled">("revision");
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => apiFetch(`/api/form-templates/submissions/${row.id}/cancel`, {
      method: "POST", body: JSON.stringify({ kind, reason, notify_customer: notify }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["form-submissions"] }); qc.invalidateQueries({ queryKey: ["agreement-events", row.id] }); onClose(); },
    onError: (e: any) => setErr(e.message),
  });
  const opt = (v: "revision" | "cancelled", title: string, sub: string) => (
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer", border: `1px solid ${kind === v ? "var(--brand)" : "#E5E2DC"}`, borderRadius: 9, padding: "12px 14px" }}>
      <input type="radio" checked={kind === v} onChange={() => setKind(v)} style={{ marginTop: 3 }} />
      <span>
        <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, color: "#1A1917" }}>{title}</span>
        <span style={{ display: "block", fontSize: 12, color: "#6B6860", lineHeight: 1.55, marginTop: 2 }}>{sub}</span>
      </span>
    </label>
  );
  return (
    <Modal title="Stop this agreement" onClose={onClose}>
      <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 12.5, color: "#6B6860", lineHeight: 1.6 }}>
          The link stops working right away, so nobody can sign this copy. Reminders stop too.
        </div>
        {opt("revision", "It needs changes", "Use this when the agreement is right in spirit but something in it is wrong. Build a corrected one and send that.")}
        {opt("cancelled", "Cancel it altogether", "Use this when there is no agreement to send. Nothing replaces it.")}
        <div>
          <label style={labelStyle}>Reason (kept on the record)</label>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} maxLength={2000} style={{ ...inputStyle, resize: "vertical" }} placeholder="For example: wrong rate, we quoted $180 not $220" />
        </div>
        <label style={{ display: "flex", gap: 9, alignItems: "center", cursor: "pointer", fontSize: 13, color: "#1A1917" }}>
          <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} />
          Email the customer so they know not to sign it
        </label>
        {err && <div style={{ fontSize: 12.5, color: "#B3261E" }}>{err}</div>}
      </div>
      <div style={{ padding: "14px 20px", borderTop: "1px solid #F5F4F2", display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button onClick={onClose} style={{ ...iconBtn(), padding: "9px 16px", fontSize: 13 }}>Never mind</button>
        <button onClick={() => { setErr(null); m.mutate(); }} disabled={m.isPending} style={{ background: "#B3261E", color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", cursor: m.isPending ? "not-allowed" : "pointer", fontWeight: 700, fontSize: 13, opacity: m.isPending ? 0.6 : 1, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
          {m.isPending ? "Working..." : "Stop it"}
        </button>
      </div>
    </Modal>
  );
}

export default function AgreementSubmissions() {
  const [bucket, setBucket] = useState<Bucket>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [resendRow, setResendRow] = useState<any | null>(null);
  const [cancelRow, setCancelRow] = useState<any | null>(null);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["form-submissions"],
    queryFn: () => apiFetch("/api/form-templates/submissions"),
  });

  const withBucket = useMemo(
    () => (rows as any[]).map(r => ({ ...r, _bucket: bucketOf(r) })),
    [rows]
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: withBucket.length };
    for (const r of withBucket) c[r._bucket] = (c[r._bucket] || 0) + 1;
    return c;
  }, [withBucket]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return withBucket.filter(r => {
      if (bucket !== "all" && r._bucket !== bucket) return false;
      if (!needle) return true;
      return [r.client_name, r.sent_to, r.sent_to_phone, r.form_name, r.signature_name]
        .filter(Boolean).some((v: string) => String(v).toLowerCase().includes(needle));
    });
  }, [withBucket, bucket, q]);

  const copyLink = (r: any) => {
    const url = `${window.location.origin}${API}/sign/${r.sign_token}`;
    navigator.clipboard?.writeText(url);
    setCopied(r.id);
    setTimeout(() => setCopied(c => (c === r.id ? null : c)), 1800);
  };

  const PILLS: Bucket[] = ["all", "waiting", "opened", "signed", "declined", "cancelled", "expired"];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {PILLS.map(b => {
            const n = b === "all" ? counts.all || 0 : counts[b] || 0;
            const active = bucket === b;
            return (
              <button key={b} onClick={() => setBucket(b)} style={{ padding: "6px 12px", borderRadius: 20, border: `1px solid ${active ? "#1A1917" : "#E5E2DC"}`, background: active ? "#1A1917" : "#fff", color: active ? "#fff" : "#6B6860", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                {b === "all" ? "All" : BUCKET_LABEL[b as Exclude<Bucket, "all">]} <span style={{ opacity: 0.7 }}>{n}</span>
              </button>
            );
          })}
        </div>
        <div style={{ position: "relative", marginLeft: "auto", minWidth: 220 }}>
          <Search size={14} color="#9E9B94" style={{ position: "absolute", left: 10, top: 9 }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, email, phone" style={{ ...inputStyle, padding: "7px 10px 7px 30px", fontSize: 12.5 }} />
        </div>
      </div>

      <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
          <thead>
            <tr style={{ background: "#F7F6F3" }}>
              <th style={{ ...th, width: 30 }}></th>
              <th style={th}>Agreement</th>
              <th style={th}>Client</th>
              <th style={th}>Sent</th>
              <th style={th}>Opens</th>
              <th style={th}>Status</th>
              <th style={th}>Last activity</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={8} style={{ ...td, textAlign: "center", color: "#9E9B94", padding: 40 }}>Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={8} style={{ ...td, textAlign: "center", color: "#9E9B94", padding: 40 }}>
                <FileText size={34} color="#E5E2DC" style={{ margin: "0 auto 10px", display: "block" }} />
                Nothing here yet.
              </td></tr>
            ) : filtered.map((r: any) => {
              const b = r._bucket as Exclude<Bucket, "all">;
              const c = BUCKET_COLOR[b];
              const openRow = open === r.id;
              const last = r.signature_at || r.declined_at || r.cancelled_at || r.last_resent_at || r.last_reminder_at || r.last_viewed_at || r.viewed_at || r.sent_at;
              const live = r.status === "pending" && b !== "expired";
              return (
                <Fragment key={r.id}>
                  <tr>
                    <td style={{ ...td, paddingRight: 0 }}>
                      <button onClick={() => setOpen(openRow ? null : r.id)} title="History" style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 2 }}>
                        {openRow ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      </button>
                    </td>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{r.form_name || `Form #${r.form_id}`}</div>
                      {r.resend_count > 0 && (
                        <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2 }}>Sent again {r.resend_count} {r.resend_count === 1 ? "time" : "times"}</div>
                      )}
                    </td>
                    <td style={td}>
                      <div>{r.client_name || r.sent_to || ""}</div>
                      <div style={{ fontSize: 11.5, color: "#9E9B94", display: "flex", flexDirection: "column", gap: 1, marginTop: 2 }}>
                        {r.sent_to && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Mail size={10} /> {r.sent_to}</span>}
                        {r.sent_to_phone && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><MessageSquare size={10} /> {r.sent_to_phone}</span>}
                      </div>
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      <div>{fmt(r.sent_at) || ""}</div>
                      {live && r.next_reminder_at && (
                        <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2, display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <Clock size={10} /> Next nudge {fmt(r.next_reminder_at)}
                        </div>
                      )}
                    </td>
                    <td style={td}>
                      {r.view_count > 0
                        ? <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#1A1917" }}><Eye size={13} color="#6B6860" /> {r.view_count}</span>
                        : <span style={{ color: "#C9C5BC" }}>0</span>}
                    </td>
                    <td style={td}>
                      <span style={{ background: c.bg, color: c.fg, padding: "3px 9px", borderRadius: 10, fontSize: 10.5, fontWeight: 700, whiteSpace: "nowrap" }}>{BUCKET_LABEL[b].toUpperCase()}</span>
                      {b === "declined" && r.decline_reason && (
                        <div style={{ fontSize: 11.5, color: "#6B6860", marginTop: 5, maxWidth: 220, lineHeight: 1.5 }}>
                          <AlertCircle size={10} style={{ verticalAlign: -1 }} /> {r.decline_reason}
                        </div>
                      )}
                      {b === "cancelled" && (
                        <div style={{ fontSize: 11.5, color: "#6B6860", marginTop: 5, maxWidth: 220, lineHeight: 1.5 }}>
                          {r.cancel_kind === "revision" ? "Being rewritten" : "Called off"}{r.cancel_reason ? `: ${r.cancel_reason}` : ""}
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      <div>{fmt(last) || ""}</div>
                      <div style={{ fontSize: 11, color: "#9E9B94" }}>{ago(last)}</div>
                    </td>
                    <td style={td}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {r.sign_token && r.status !== "signed" && (
                          <button onClick={() => copyLink(r)} title="Copy the signing link" style={iconBtn()}>
                            {copied === r.id ? <><Check size={12} color="#10B981" /> Copied</> : <><Copy size={12} /> Link</>}
                          </button>
                        )}
                        {r.status === "signed" && r.sign_token && (
                          <>
                            <a href={`${API}/api/sign/${r.sign_token}/agreement.pdf`} target="_blank" rel="noreferrer" title="Signed copy" style={{ ...iconBtn(), textDecoration: "none" }}><FileText size={12} /> PDF</a>
                            <a href={`${API}/api/sign/${r.sign_token}/certificate.pdf`} target="_blank" rel="noreferrer" title="Certificate of completion" style={{ ...iconBtn(), textDecoration: "none" }}><Shield size={12} /> Certificate</a>
                          </>
                        )}
                        {r.status !== "signed" && r.status !== "cancelled" && (
                          <button onClick={() => setResendRow(r)} title="Send it again" style={iconBtn()}><Send size={12} /> Resend</button>
                        )}
                        {r.status !== "signed" && r.status !== "cancelled" && (
                          <button onClick={() => setCancelRow(r)} title="Stop this agreement" style={iconBtn("#B3261E")}><Ban size={12} /> Stop</button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {openRow && (
                    <tr>
                      <td colSpan={8} style={{ padding: "14px 20px 18px 52px", background: "#FBFAF8", borderBottom: "1px solid #F5F4F2" }}>
                        <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: "#9E9B94", marginBottom: 10 }}>History</div>
                        <Timeline id={r.id} />
                        {r.signature_name && (
                          <div style={{ marginTop: 12, fontSize: 12.5, color: "#6B6860" }}>
                            Signed by <strong style={{ color: "#1A1917" }}>{r.signature_name}</strong>
                            {r.ip_address ? ` from ${r.ip_address}` : ""}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {resendRow && <ResendModal row={resendRow} onClose={() => setResendRow(null)} />}
      {cancelRow && <CancelModal row={cancelRow} onClose={() => setCancelRow(null)} />}
    </div>
  );
}
