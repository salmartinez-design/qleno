import { useState, useRef, useEffect, useCallback } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders, getTokenRole } from "@/lib/auth";
import { formatAddress } from "@/lib/format-address";
import {
  ArrowLeft, Home, CreditCard, FileText, Bell, Star, UserX, StickyNote, Globe,
  Plus, Trash2, Edit2, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Check, X, Eye, EyeOff,
  Phone, Mail, MapPin, MessageSquare, Send, AlertTriangle, TrendingUp,
  ClipboardList, DollarSign, BookOpen, Paperclip, ShieldCheck, Loader2,
  MessageCircle, RefreshCw, Activity, Upload, Image, Calendar, Clock, Wrench,
} from "lucide-react";
import { QuotesTab, PaymentsTab, QuickBooksTab, AttachmentsTab, CommLog2 } from "./customer-profile-tabs2";
import { JobWizard } from "@/components/job-wizard";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...opts.headers },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function fmtDate(d?: string | null) {
  if (!d) return "Never";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtCurrency(v?: number | string | null) {
  const n = typeof v === "string" ? parseFloat(v) : (v || 0);
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function freqLabel(f?: string | null) {
  const m: Record<string,string> = { weekly:"Weekly", biweekly:"Bi-weekly", monthly:"Monthly", on_demand:"On Demand" };
  return f ? (m[f] || f) : "Not set";
}

function tierLabel(t: string) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function tierToPoints(t: string) {
  if (t === "silver") return 500;
  if (t === "gold") return 1000;
  if (t === "vip") return 2000;
  return 500; // standard -> silver
}

function nextTierName(t: string) {
  if (t === "standard") return "Silver";
  if (t === "silver") return "Gold";
  if (t === "gold") return "VIP";
  return null;
}

const TABS = [
  { id: "overview", label: "Overview", icon: Home },
  { id: "homes", label: "Homes", icon: MapPin },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "card-on-file", label: "Card on File", icon: ShieldCheck },
  { id: "quotes", label: "Quotes", icon: ClipboardList },
  { id: "payments", label: "Payments", icon: DollarSign },
  { id: "agreements", label: "Agreements", icon: FileText },
  { id: "attachments", label: "Attachments", icon: Paperclip },
  { id: "quickbooks", label: "QuickBooks", icon: BookOpen },
  { id: "contacts", label: "Contacts & Notifications", icon: Bell },
  { id: "scorecards", label: "Scorecards", icon: Star },
  { id: "tech", label: "Tech Preferences", icon: UserX },
  { id: "notes", label: "Notes", icon: StickyNote },
  { id: "portal", label: "Portal Account", icon: Globe },
  { id: "comm-log", label: "Comm Log", icon: MessageCircle },
  { id: "recurring", label: "Recurring", icon: RefreshCw },
  { id: "revenue-trend", label: "Revenue Trend", icon: Activity },
] as const;

type TabId = typeof TABS[number]["id"];

// ─── Mini Calendar ────────────────────────────────────────────────────────────
function MiniCalendar({ jobs, onPickEmpty, onPickJob }: { jobs: any[]; onPickEmpty?: (isoDate: string) => void; onPickJob?: (job: any) => void }) {
  const [dt, setDt] = useState(new Date());
  const year = dt.getFullYear(); const month = dt.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthName = dt.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  // Map day → first job for that day in the visible month. Used for
  // status dot color AND for the click-to-edit handler.
  const jobsByDay: Record<number, any> = {};
  for (const j of jobs) {
    if (!j.scheduled_date) continue;
    const d = new Date(j.scheduled_date + "T12:00:00");
    if (d.getFullYear() === year && d.getMonth() === month) {
      if (!jobsByDay[d.getDate()]) jobsByDay[d.getDate()] = j;
    }
  }

  const dotColor: Record<string,string> = { complete:"#16A34A", scheduled:"#5B9BD5", assigned:"#5B9BD5", cancelled:"#9E9B94", skipped:"#9E9B94" };

  // [scheduling-engine 2026-04-29] Build today's ISO date once so we
  // can decide whether to allow scheduling on the clicked day.
  // Past empty days: clickable as a "schedule retroactive job" path
  // is plausible but not wired yet — surfaces a no-op for now.
  const todayIso = (() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  })();

  return (
    <div style={{ marginTop: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
        <button onClick={() => setDt(new Date(year, month - 1))} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: "2px" }}><ChevronLeft size={14} /></button>
        <span style={{ fontSize: "11px", fontWeight: 600, color: "#6B7280" }}>{monthName}</span>
        <button onClick={() => setDt(new Date(year, month + 1))} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: "2px" }}><ChevronRight size={14} /></button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "2px" }}>
        {["S","M","T","W","T","F","S"].map((d, i) => (
          <div key={i} style={{ textAlign: "center", fontSize: "9px", fontWeight: 600, color: "#C4C0BB", paddingBottom: "4px" }}>{d}</div>
        ))}
        {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} />)}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          const job = jobsByDay[day];
          const status = job?.status;
          const color = status ? dotColor[status] : undefined;
          const isoDate = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const isFuture = isoDate >= todayIso;
          const clickable = !!job || (isFuture && !!onPickEmpty);
          const handleClick = () => {
            if (job && onPickJob) { onPickJob(job); return; }
            if (!job && isFuture && onPickEmpty) { onPickEmpty(isoDate); return; }
          };
          return (
            <button key={day}
              type="button"
              onClick={clickable ? handleClick : undefined}
              disabled={!clickable}
              title={
                job ? `${status ?? "Job"} on ${isoDate}`
                : isFuture ? `Schedule on ${isoDate}`
                : `${isoDate} — past, no job`
              }
              style={{
                textAlign: "center", padding: "3px 0", position: "relative",
                border: "none", background: "transparent",
                cursor: clickable ? "pointer" : "default",
                borderRadius: 4,
                ...(clickable ? { outline: "none" } : {}),
              }}
              onMouseOver={e => { if (clickable) (e.currentTarget as HTMLButtonElement).style.background = "rgba(91,155,213,0.12)"; }}
              onMouseOut={e => { if (clickable) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <span style={{ fontSize: "11px", color: status ? "#1A1917" : isFuture ? "#6B7280" : "#C4C0BB", fontWeight: status ? 700 : 400 }}>{day}</span>
              {color && <div style={{ width: "4px", height: "4px", borderRadius: "50%", background: color, margin: "0 auto" }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Left Sidebar ─────────────────────────────────────────────────────────────
function ClientSidebar({ client, stats, jobs, onPortalInvite }: { client: any; stats: any; jobs: any[]; onPortalInvite: () => void }) {
  const loyalty_tier = client.loyalty_tier || "standard";
  const nextTier = nextTierName(loyalty_tier);
  const threshold = tierToPoints(loyalty_tier);
  const pts = client.loyalty_points || 0;
  const pct = Math.min(100, (pts / threshold) * 100);
  const rateLastDate = client.rate_increase_last_date ? new Date(client.rate_increase_last_date) : null;
  const monthsSinceIncrease = rateLastDate ? Math.floor((Date.now() - rateLastDate.getTime()) / (30 * 86400000)) : 999;
  const rateDue = monthsSinceIncrease >= 12;

  const portalStatus = client.portal_access ? "registered" : client.portal_invite_sent_at ? "invited" : "none";

  return (
    <div style={{ width: "272px", flexShrink: 0 }}>
      <div style={{ position: "sticky", top: "24px", display: "flex", flexDirection: "column", gap: "12px" }}>

        {/* Client Header Card */}
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "12px", padding: "20px" }}>
          <div style={{ width: "52px", height: "52px", borderRadius: "50%", background: "var(--brand-dim)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "12px" }}>
            <span style={{ fontSize: "20px", fontWeight: 700, color: "var(--brand)" }}>
              {client.first_name?.[0]}{client.last_name?.[0]}
            </span>
          </div>
          <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700, color: "#1A1917", lineHeight: 1.2 }}>
            {client.first_name} {client.last_name}
          </h2>
          {client.company_name && <p style={{ margin: "4px 0 0", fontSize: "12px", color: "#6B7280" }}>{client.company_name}</p>}
          <p style={{ margin: "4px 0 0", fontSize: "11px", color: "#9E9B94" }}>CL-{String(client.id).padStart(4, "0")}</p>

          <div style={{ display: "flex", gap: "6px", marginTop: "10px", flexWrap: "wrap" }}>
            {client.frequency && (
              <span style={{ background: "var(--brand-dim)", color: "var(--brand)", padding: "3px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                {freqLabel(client.frequency)}
              </span>
            )}
            {client.service_type && (
              <span style={{ background: "#F3F4F6", color: "#6B7280", padding: "3px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                {client.service_type === "recurring" ? "Recurring" : "One-Time"}
              </span>
            )}
            {client.zone_name && client.zone_color && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: `${client.zone_color}18`, border: `1px solid ${client.zone_color}55`, color: client.zone_color, padding: "3px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", backgroundColor: client.zone_color, display: "inline-block", boxShadow: `0 0 0 2px ${client.zone_color}40` }} />
                {client.zone_name}
              </span>
            )}
          </div>

          {/* Portal pill */}
          <div style={{ marginTop: "12px" }}>
            {portalStatus === "registered" && (
              <span style={{ background: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0", padding: "4px 10px", borderRadius: "20px", fontSize: "11px", fontWeight: 600 }}>Portal Active</span>
            )}
            {portalStatus === "invited" && (
              <span style={{ background: "#FEF3C7", color: "#92400E", border: "1px solid #FDE68A", padding: "4px 10px", borderRadius: "20px", fontSize: "11px", fontWeight: 600 }}>Invite Sent {fmtDate(client.portal_invite_sent_at)}</span>
            )}
            {portalStatus === "none" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <span style={{ background: "#F3F4F6", color: "#6B7280", border: "1px solid #E5E7EB", padding: "4px 10px", borderRadius: "20px", fontSize: "11px", fontWeight: 600, display: "inline-block" }}>No Portal Access</span>
                <button onClick={onPortalInvite} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", background: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: "6px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
                  <Send size={11} /> Send Portal Invite
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Loyalty */}
        <div style={{ backgroundColor: "var(--brand-dim)", border: "1px solid rgba(91,155,213,0.2)", borderRadius: "12px", padding: "16px" }}>
          <div style={{ fontSize: "10px", fontWeight: 700, color: "var(--brand)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>CleanRewards</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
            <span style={{ fontSize: "26px", fontWeight: 700, color: "var(--brand)", lineHeight: 1 }}>{pts.toLocaleString()}</span>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--brand)", opacity: 0.7 }}>pts</span>
          </div>
          <span style={{ background: "var(--brand)", color: "#FFFFFF", padding: "2px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginTop: "4px", display: "inline-block" }}>
            {tierLabel(loyalty_tier)}
          </span>
          {nextTier && (
            <>
              <div style={{ height: "6px", backgroundColor: "rgba(91,155,213,0.2)", borderRadius: "3px", margin: "10px 0 4px", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, backgroundColor: "var(--brand)", borderRadius: "3px", transition: "width 0.4s" }} />
              </div>
              <div style={{ fontSize: "11px", color: "var(--brand)", opacity: 0.8 }}>{Math.max(0, threshold - pts)} pts until {nextTier}</div>
            </>
          )}
        </div>

        {/* Stats */}
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "12px", padding: "16px" }}>
          <div style={{ fontSize: "10px", fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "12px" }}>Stats</div>
          {[
            ["Client Since", client.client_since ? fmtDate(client.client_since) : fmtDate(client.created_at)],
            ["Last Cleaning", fmtDate(stats?.last_cleaning)],
            ["Next Cleaning", fmtDate(stats?.next_cleaning)],
            ["All-Time Revenue", fmtCurrency(stats?.revenue_all_time)],
            ["Last 12mo Revenue", fmtCurrency(stats?.revenue_last_12mo)],
            ["Avg Bill", fmtCurrency(stats?.avg_bill)],
            ["Scorecard Avg", stats?.scorecard_avg != null ? `${parseFloat(stats.scorecard_avg).toFixed(1)}/4.0` : "No data"],
            ["Total Jobs", stats?.total_jobs || 0],
          ].map(([label, value]) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #F0EEE9" }}>
              <span style={{ fontSize: "12px", color: "#6B7280" }}>{label}</span>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--brand)" }}>{value}</span>
            </div>
          ))}
        </div>

        {/* Rate increase warning */}
        {rateDue && client.base_fee && (
          <div style={{ backgroundColor: "#FEF3C7", border: "1px solid #FDE68A", borderLeft: "3px solid #F59E0B", borderRadius: "8px", padding: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }}>
              <AlertTriangle size={13} style={{ color: "#F59E0B" }} />
              <span style={{ fontSize: "11px", fontWeight: 700, color: "#92400E" }}>Rate Increase Due</span>
            </div>
            <p style={{ margin: 0, fontSize: "11px", color: "#78350F" }}>
              Last increase: {rateLastDate ? fmtDate(rateLastDate.toISOString()) : "Never"}<br />
              Current rate: {fmtCurrency(client.base_fee)}<br />
              Suggested +5%: {fmtCurrency(parseFloat(client.base_fee) * 1.05)}
            </p>
            <button style={{ marginTop: "8px", padding: "5px 10px", background: "#F59E0B", color: "#FFFFFF", border: "none", borderRadius: "5px", fontSize: "11px", fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}>
              <TrendingUp size={10} /> Send Rate Increase
            </button>
          </div>
        )}

        {/* Mini calendar */}
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "12px", padding: "16px" }}>
          <div style={{ fontSize: "10px", fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "2px" }}>Job Calendar</div>
          <MiniCalendar jobs={jobs} />
          <div style={{ display: "flex", gap: "10px", marginTop: "10px", flexWrap: "wrap" }}>
            {[["#16A34A","Complete"],["#5B9BD5","Scheduled"],["#9E9B94","Cancelled"]].map(([c,l]) => (
              <div key={l} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: c }} />
                <span style={{ fontSize: "10px", color: "#9E9B94" }}>{l}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function Toast({ message, type = "success", onDone }: { message: string; type?: "success" | "error"; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 3500); return () => clearTimeout(t); }, [onDone]);
  return (
    <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 9999, background: type === "error" ? "#1A1917" : "#0A0E1A", color: "#fff", padding: "13px 20px", borderRadius: 10, fontSize: 13, fontWeight: 600, fontFamily: FF, boxShadow: "0 8px 30px rgba(0,0,0,0.35)", display: "flex", alignItems: "center", gap: 10, minWidth: 240 }}>
      {type === "success" ? <Check size={14} style={{ color: "#00C9A0", flexShrink: 0 }} /> : <X size={14} style={{ color: "#EF4444", flexShrink: 0 }} />}
      {message}
    </div>
  );
}

// ─── Send Message Drawer ──────────────────────────────────────────────────────
function SendMessageDrawer({ client, onClose, onToast }: { client: any; onClose: () => void; onToast: (m: string, t?: "success" | "error") => void }) {
  const [tab, setTab] = useState<"sms" | "email">("sms");
  const [smsMsg, setSmsMsg] = useState("");
  const [emailSubj, setEmailSubj] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sendSms = async () => {
    if (!smsMsg.trim() || !client.phone) return;
    setSending(true);
    try {
      await apiFetch(`/api/clients/${client.id}/communications/sms`, { method: "POST", body: JSON.stringify({ to: client.phone, message: smsMsg }) });
      onToast("SMS sent successfully");
      onClose();
    } catch { onToast("Failed to send SMS", "error"); }
    finally { setSending(false); }
  };

  const sendEmail = async () => {
    if (!emailBody.trim() || !client.email) return;
    setSending(true);
    try {
      await apiFetch(`/api/clients/${client.id}/communications/email`, { method: "POST", body: JSON.stringify({ to: client.email, subject: emailSubj || "(no subject)", body: emailBody }) });
      onToast("Email sent successfully");
      onClose();
    } catch { onToast("Failed to send email", "error"); }
    finally { setSending(false); }
  };

  const inp: React.CSSProperties = { width: "100%", padding: "9px 11px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, color: "#1A1917", fontFamily: FF, outline: "none", boxSizing: "border-box" };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(10,14,26,0.45)" }} />
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 420, zIndex: 1001, background: "#FFFFFF", boxShadow: "-8px 0 40px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", fontFamily: FF }}>
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #E5E2DC", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#0A0E1A" }}>Send Message</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4, display: "flex" }}><X size={18} /></button>
        </div>
        {/* Tab bar */}
        <div style={{ display: "flex", borderBottom: "1px solid #E5E2DC", padding: "0 24px" }}>
          {(["sms", "email"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ padding: "10px 16px", border: "none", cursor: "pointer", fontFamily: FF, fontSize: 13, fontWeight: tab === t ? 700 : 500, color: tab === t ? "var(--brand)" : "#6B6860", background: "transparent", borderBottom: tab === t ? "2px solid var(--brand)" : "2px solid transparent" }}>
              {t === "sms" ? "SMS" : "Email"}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
          {tab === "sms" ? (
            <>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>To</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{client.first_name} {client.last_name} {client.phone ? `· ${client.phone}` : "· No phone on file"}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Message</div>
                <textarea value={smsMsg} onChange={e => setSmsMsg(e.target.value)} rows={6} placeholder="Type your message..." style={{ ...inp, resize: "vertical" as const }} />
                <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 4, textAlign: "right" }}>{smsMsg.length} / 160</div>
              </div>
              {!client.phone && <div style={{ fontSize: 12, color: "#DC2626", background: "#FEE2E2", borderRadius: 7, padding: "8px 12px" }}>No phone number on file for this client.</div>}
              <button onClick={sendSms} disabled={!smsMsg.trim() || !client.phone || sending} style={{ padding: "10px", background: "var(--brand)", border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: (!smsMsg.trim() || !client.phone || sending) ? 0.5 : 1, fontFamily: FF }}>
                {sending ? "Sending..." : "Send SMS"}
              </button>
            </>
          ) : (
            <>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>To</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{client.first_name} {client.last_name} {client.email ? `· ${client.email}` : "· No email on file"}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Subject</div>
                <input value={emailSubj} onChange={e => setEmailSubj(e.target.value)} placeholder="(optional)" style={inp} />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Message</div>
                <textarea value={emailBody} onChange={e => setEmailBody(e.target.value)} rows={8} placeholder="Type your message..." style={{ ...inp, resize: "vertical" as const }} />
              </div>
              {!client.email && <div style={{ fontSize: 12, color: "#DC2626", background: "#FEE2E2", borderRadius: 7, padding: "8px 12px" }}>No email address on file for this client.</div>}
              <button onClick={sendEmail} disabled={!emailBody.trim() || !client.email || sending} style={{ padding: "10px", background: "var(--brand)", border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: (!emailBody.trim() || !client.email || sending) ? 0.5 : 1, fontFamily: FF }}>
                {sending ? "Sending..." : "Send Email"}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Edit Profile Drawer ──────────────────────────────────────────────────────
function EditProfileDrawer({ client, onClose, onSave, onToast }: { client: any; onClose: () => void; onSave: (data: any) => Promise<void>; onToast: (m: string, t?: "success" | "error") => void }) {
  const [form, setForm] = useState({
    first_name: client.first_name || "", last_name: client.last_name || "",
    // [scheduling-engine 2026-04-29] company_name was on the schema
    // (clients.company_name) but the drawer didn't surface it. For
    // commercial clients (Jaira-style) the operator needs a place to
    // put "Riverside Office Tower" or similar — without it the
    // profile read-only view falls back to first/last name only and
    // there's no way to enter or correct the business name from the UI.
    company_name: client.company_name || "",
    client_type: (client.client_type === "commercial" ? "commercial" : "residential") as "residential" | "commercial",
    phone: client.phone || "", email: client.email || "",
    address: client.address || "", city: client.city || "", state: client.state || "", zip: client.zip || "",
    home_access_notes: client.home_access_notes || "", alarm_code: client.alarm_code || "",
    pets: client.pets || "", referral_source: client.referral_source || "", notes: client.notes || "",
    client_since: client.client_since ? String(client.client_since).slice(0, 10) : "",
  });
  const [saving, setSaving] = useState(false);

  // [scheduling-engine 2026-04-29] Tenant-managed acquisition sources.
  // Replaces the hardcoded SOURCE_LABELS dropdown — fetches from the
  // server, supports an inline "+ Add new source" UI that writes to
  // the acquisition_sources table. Dropdown stays editable in the
  // form; existing referral_source values that don't match an active
  // source still display via SOURCE_LABELS fallback.
  const [sources, setSources] = useState<Array<{ id: number; slug: string; name: string }>>([]);
  const [addingSource, setAddingSource] = useState(false);
  const [newSourceName, setNewSourceName] = useState("");
  const [savingSource, setSavingSource] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch("/api/acquisition-sources");
        if (cancelled) return;
        const list = Array.isArray(r) ? r : (r?.data ?? []);
        setSources(list as any);
      } catch { /* fall back to SOURCE_LABELS — UI still renders */ }
    })();
    return () => { cancelled = true; };
  }, []);
  async function addSource() {
    const trimmed = newSourceName.trim();
    if (!trimmed) return;
    setSavingSource(true);
    setSourceError(null);
    try {
      const row = await apiFetch("/api/acquisition-sources", {
        method: "POST",
        body: JSON.stringify({ name: trimmed }),
      });
      const created = (row as any)?.data ?? row;
      setSources(s => [...s, created].sort((a: any, b: any) =>
        (a.display_order ?? 100) - (b.display_order ?? 100) || a.id - b.id));
      setForm(f => ({ ...f, referral_source: created.slug }));
      setAddingSource(false);
      setNewSourceName("");
    } catch (err: any) {
      setSourceError(err?.message ?? "Could not add source");
    } finally {
      setSavingSource(false);
    }
  }

  // [scheduling-engine 2026-04-29] Google Places autocomplete on the
  // EditProfileDrawer's Street Address. Same pattern as HomesTab —
  // load the Maps Places script once, attach Autocomplete to the
  // input ref, parse address_components on select to patch street /
  // city / state / zip in one go. The four discrete fields stay
  // editable (e.g. apartment/suite numbers, manual zip override).
  // Server-side resolveZoneForZip on PUT /api/clients/:id then
  // assigns the zone — no preview wired here.
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const [mapsReady, setMapsReady] = useState(false);
  useEffect(() => {
    // [places-key-fallback 2026-04-29] Try the runtime config endpoint
    // first (server reads process.env.GOOGLE_MAPS_API_KEY from
    // Railway's runtime env), fall back to the build-time
    // VITE_GOOGLE_MAPS_API_KEY only if the server isn't reachable.
    // Without this fallback the Places loader silently bails when
    // the frontend build was made without the env var present —
    // which is what was happening on production after PR #16
    // deployed (build-time injection was empty, runtime env had
    // the key, but only InlineAddressEdit on the dispatch page was
    // wired to the runtime endpoint).
    if ((window as any).google?.maps?.places) { setMapsReady(true); return; }
    const scriptId = "gmap-places-script";
    if (document.getElementById(scriptId)) {
      const existing = document.getElementById(scriptId) as HTMLScriptElement;
      existing.addEventListener("load", () => setMapsReady(true));
      return;
    }
    let cancelled = false;
    (async () => {
      let key = "";
      try {
        const r = await fetch(`${API}/api/config/google-maps-key`, {
          headers: { ...getAuthHeaders() },
        });
        if (r.ok) {
          const body = await r.json().catch(() => ({}));
          key = String(body?.key ?? "");
        }
      } catch { /* fall through to build-time */ }
      if (!key) {
        key = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY ?? "";
      }
      if (cancelled) return;
      if (!key) return;
      // Re-check after the await — another instance may have injected
      // the script while we were fetching the key.
      if (document.getElementById(scriptId)) {
        const existing = document.getElementById(scriptId) as HTMLScriptElement;
        existing.addEventListener("load", () => setMapsReady(true));
        if ((window as any).google?.maps?.places) setMapsReady(true);
        return;
      }
      const s = document.createElement("script");
      s.id = scriptId;
      s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places`;
      s.async = true; s.defer = true;
      s.onload = () => setMapsReady(true);
      document.head.appendChild(s);
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!mapsReady || !addressInputRef.current) return;
    const g = (window as any).google;
    if (!g?.maps?.places?.Autocomplete) return;
    const ac = new g.maps.places.Autocomplete(addressInputRef.current, {
      componentRestrictions: { country: "us" },
      fields: ["address_components", "formatted_address", "geometry"],
      types: ["address"],
    });
    const listener = ac.addListener("place_changed", () => {
      const place = ac.getPlace();
      if (!place?.address_components) return;
      const get = (type: string) =>
        place.address_components.find((c: any) => c.types.includes(type))?.long_name ?? "";
      const getShort = (type: string) =>
        place.address_components.find((c: any) => c.types.includes(type))?.short_name ?? "";
      const street = `${get("street_number")} ${get("route")}`.trim();
      const city = get("locality") || get("sublocality") || get("postal_town");
      const state = getShort("administrative_area_level_1");
      const zip = get("postal_code");
      setForm(f => ({ ...f, address: street, city, state, zip }));
    });
    return () => { listener?.remove?.(); };
  }, [mapsReady]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const upd = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [field]: e.target.value }));

  const save = async () => {
    setSaving(true);
    try {
      await onSave(form);
      onToast("Profile updated");
      onClose();
    } catch { onToast("Failed to save profile", "error"); }
    finally { setSaving(false); }
  };

  const inp: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, color: "#1A1917", fontFamily: FF, outline: "none", boxSizing: "border-box" };
  const lbl = (t: string) => <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 4 }}>{t}</div>;

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(10,14,26,0.45)" }} />
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 480, zIndex: 1001, background: "#FFFFFF", boxShadow: "-8px 0 40px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", fontFamily: FF }}>
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #E5E2DC", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#0A0E1A" }}>Edit Client Profile</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4, display: "flex" }}><X size={18} /></button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* [scheduling-engine 2026-04-29] Client type toggle +
              company name. Surfaces the existing clients.company_name
              column that the drawer never let operators edit.
              Commercial-tagged clients get the field shown above
              First/Last so the business name reads as the primary
              label; residential clients can still set a company name
              if desired (rare) but it doesn't dominate the form. */}
          <div>
            {lbl("Type")}
            <div style={{ display: "flex", gap: 8 }}>
              {(["residential", "commercial"] as const).map(t => (
                <button key={t} type="button"
                  onClick={() => setForm(f => ({ ...f, client_type: t }))}
                  style={{
                    flex: 1, padding: "9px 12px", borderRadius: 8, cursor: "pointer", textAlign: "center",
                    border: `1.5px solid ${form.client_type === t ? "var(--brand, #00C9A0)" : "#E5E2DC"}`,
                    background: form.client_type === t ? "rgba(0,201,160,0.10)" : "#FFFFFF",
                    color: form.client_type === t ? "var(--brand, #00C9A0)" : "#1A1917",
                    fontSize: 13, fontWeight: 700, fontFamily: "'Plus Jakarta Sans', sans-serif",
                  }}>
                  {t === "residential" ? "Residential" : "Commercial"}
                </button>
              ))}
            </div>
          </div>
          <div>
            {lbl(form.client_type === "commercial" ? "Company Name" : "Company Name (optional)")}
            <input value={form.company_name} onChange={upd("company_name")}
              placeholder={form.client_type === "commercial" ? "e.g. Riverside Office Tower" : ""}
              style={inp} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>{lbl(form.client_type === "commercial" ? "Contact First Name" : "First Name")}<input value={form.first_name} onChange={upd("first_name")} style={inp} /></div>
            <div>{lbl(form.client_type === "commercial" ? "Contact Last Name"  : "Last Name")}<input value={form.last_name}  onChange={upd("last_name")}  style={inp} /></div>
          </div>
          <div>{lbl("Phone")}<input value={form.phone} onChange={upd("phone")} type="tel" style={inp} /></div>
          <div>{lbl("Email")}<input value={form.email} onChange={upd("email")} type="email" style={inp} /></div>
          <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginBottom: 12 }}>Service Address</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                {lbl("Street Address")}
                {/* [scheduling-engine 2026-04-29] Address input wired
                    to the addressInputRef ref so Google Places can
                    attach its Autocomplete. The four city/state/zip
                    fields below stay editable for unit/apt overrides. */}
                <input
                  ref={addressInputRef}
                  value={form.address}
                  onChange={upd("address")}
                  placeholder={mapsReady ? "Start typing — Google suggests addresses" : "Street address"}
                  autoComplete="off"
                  style={inp}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 70px 100px", gap: 10 }}>
                <div>{lbl("City")}<input value={form.city} onChange={upd("city")} style={inp} /></div>
                <div>{lbl("State")}<input value={form.state} onChange={upd("state")} style={inp} /></div>
                <div>{lbl("Zip")}<input value={form.zip} onChange={upd("zip")} style={inp} /></div>
              </div>
            </div>
          </div>
          <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginBottom: 12 }}>Access & Security</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>{lbl("Entry Instructions")}<textarea value={form.home_access_notes} onChange={upd("home_access_notes")} rows={2} style={{ ...inp, resize: "vertical" as const }} /></div>
              <div>{lbl("Alarm / Lockbox Code")}<input value={form.alarm_code} onChange={upd("alarm_code")} style={inp} /></div>
              <div>{lbl("Pets / Equipment Notes")}<input value={form.pets} onChange={upd("pets")} style={inp} /></div>
            </div>
          </div>
          <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginBottom: 12 }}>Account</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                {lbl("Acquisition Source")}
                {/* [scheduling-engine 2026-04-29] Sources fetched from
                    /api/acquisition-sources. If the existing
                    referral_source value isn't in the active list
                    (e.g. legacy slug from SOURCE_LABELS), show it as
                    a one-off option so the form doesn't lose it on
                    first save. "+ Add new source" inline writes a
                    new row to the table and selects it. */}
                <select value={form.referral_source} onChange={upd("referral_source")} style={{ ...inp, background: "#FFFFFF" }}>
                  <option value="">Not set</option>
                  {sources.map(s => <option key={s.id} value={s.slug}>{s.name}</option>)}
                  {form.referral_source && !sources.some(s => s.slug === form.referral_source) && (
                    <option value={form.referral_source}>
                      {SOURCE_LABELS[form.referral_source] || form.referral_source.replace(/_/g, " ")} (legacy)
                    </option>
                  )}
                </select>
                {!addingSource ? (
                  <button type="button" onClick={() => { setAddingSource(true); setSourceError(null); }}
                    style={{ marginTop: 6, fontSize: 12, fontWeight: 600, color: "var(--brand)", background: "transparent", border: "none", padding: 0, cursor: "pointer", fontFamily: FF }}>
                    + Add new source
                  </button>
                ) : (
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        autoFocus
                        value={newSourceName}
                        onChange={e => setNewSourceName(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") addSource(); if (e.key === "Escape") { setAddingSource(false); setNewSourceName(""); } }}
                        placeholder="e.g. BNI Networking"
                        style={{ ...inp, flex: 1 }}
                      />
                      <button type="button" onClick={addSource} disabled={savingSource || !newSourceName.trim()}
                        style={{ padding: "0 14px", borderRadius: 7, border: "none", background: "var(--brand)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: savingSource ? "wait" : "pointer", fontFamily: FF, opacity: !newSourceName.trim() ? 0.5 : 1 }}>
                        {savingSource ? "…" : "Add"}
                      </button>
                      <button type="button" onClick={() => { setAddingSource(false); setNewSourceName(""); setSourceError(null); }}
                        style={{ padding: "0 12px", borderRadius: 7, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#6B6860", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                        Cancel
                      </button>
                    </div>
                    {sourceError && <div style={{ fontSize: 11, color: "#991B1B" }}>{sourceError}</div>}
                  </div>
                )}
              </div>
              <div>{lbl("Client Since")}<input value={form.client_since} onChange={upd("client_since")} type="date" style={inp} /></div>
              <div>{lbl("Internal Notes")}<textarea value={form.notes} onChange={upd("notes")} rows={3} style={{ ...inp, resize: "vertical" as const }} /></div>
            </div>
          </div>
        </div>
        <div style={{ padding: "16px 24px", borderTop: "1px solid #E5E2DC", display: "flex", gap: 10, flexShrink: 0 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px", border: "1px solid #E5E2DC", borderRadius: 8, background: "#FFFFFF", color: "#6B6860", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ flex: 2, padding: "10px", border: "none", borderRadius: 8, background: "var(--brand)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: saving ? 0.6 : 1, fontFamily: FF }}>{saving ? "Saving..." : "Save Changes"}</button>
        </div>
      </div>
    </>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────
function OverviewTab({ client, onUpdate, refetch }: { client: any; onUpdate: (data: any) => Promise<void>; refetch: () => void }) {
  const { data: companyMe } = useQuery<any>({ queryKey: ["company-me"], queryFn: () => apiFetch("/api/companies/me") });
  const companySlug = companyMe?.slug ?? "phes-cleaning";
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ first_name: client.first_name, last_name: client.last_name, email: client.email || "", phone: client.phone || "", company_name: client.company_name || "", notes: client.notes || "", base_fee: client.base_fee || "", allowed_hours: client.allowed_hours || "", frequency: client.frequency || "", service_type: client.service_type || "" });

  // ── Rate Lock ─────────────────────────────────────────────────────────────
  const qc = useQueryClient();
  const { data: rateLock } = useQuery<any>({
    queryKey: ["rate-lock", client.id],
    queryFn: () => apiFetch(`/api/clients/${client.id}/rate-lock`),
    staleTime: 30_000,
  });
  const [voidModal, setVoidModal] = useState(false);
  const [voidReason, setVoidReason] = useState("manual");
  const [voidNotes, setVoidNotes] = useState("");
  const [voiding, setVoiding] = useState(false);
  const handleVoidLock = async () => {
    if (!rateLock) return;
    setVoiding(true);
    try {
      await apiFetch(`/api/clients/${client.id}/rate-lock/${rateLock.id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: voidReason, notes: voidNotes }),
      });
      qc.invalidateQueries({ queryKey: ["rate-lock", client.id] });
      setVoidModal(false);
      setVoidReason("manual");
      setVoidNotes("");
    } catch { /* silent */ }
    finally { setVoiding(false); }
  };
  const cadenceLabel = (c: string) => ({ weekly: "Weekly", biweekly: "Every 2 Weeks", monthly: "Every 4 Weeks" }[c] ?? c);
  const lockDaysLeft = rateLock?.active && rateLock?.lock_expires_at
    ? Math.max(0, Math.ceil((new Date(rateLock.lock_expires_at).getTime() - Date.now()) / 86400000))
    : null;

  // Manual rate lock creation
  const [addLockModal, setAddLockModal] = useState(false);
  const [addLockForm, setAddLockForm] = useState({ locked_rate: "", cadence: "biweekly", start_date: new Date().toISOString().split("T")[0], duration_months: "24", notes: "" });
  const [addingLock, setAddingLock] = useState(false);
  const handleAddLock = async () => {
    if (!addLockForm.locked_rate) return;
    setAddingLock(true);
    try {
      await apiFetch(`/api/clients/${client.id}/rate-lock`, {
        method: "POST",
        body: JSON.stringify(addLockForm),
      });
      qc.invalidateQueries({ queryKey: ["rate-lock", client.id] });
      setAddLockModal(false);
      setAddLockForm({ locked_rate: "", cadence: "biweekly", start_date: new Date().toISOString().split("T")[0], duration_months: "24", notes: "" });
    } catch { /* silent */ }
    finally { setAddingLock(false); }
  };

  const save = async () => {
    await onUpdate(form);
    setEditing(false);
    refetch();
  };

  const Field = ({ label, value, field, type = "text" }: { label: string; value: string; field: string; type?: string }) => (
    <div>
      <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "4px" }}>{label}</label>
      {editing ? (
        <input value={(form as any)[field]} onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))} type={type}
          style={{ width: "100%", padding: "8px 10px", border: "1px solid #D1D5DB", borderRadius: "6px", fontSize: "13px", color: "#1A1917", outline: "none", boxSizing: "border-box" }} />
      ) : (
        <p style={{ margin: 0, fontSize: "13px", color: value ? "#1A1917" : "#9E9B94" }}>{value || "Not set"}</p>
      )}
    </div>
  );

  const SelectField = ({ label, value, field, opts }: { label: string; value: string; field: string; opts: [string,string][] }) => (
    <div>
      <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "4px" }}>{label}</label>
      {editing ? (
        <select value={(form as any)[field]} onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
          style={{ width: "100%", padding: "8px 10px", border: "1px solid #D1D5DB", borderRadius: "6px", fontSize: "13px", color: "#1A1917", outline: "none", background: "#FFFFFF" }}>
          <option value="">Not set</option>
          {opts.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      ) : (
        <p style={{ margin: 0, fontSize: "13px", color: value ? "#1A1917" : "#9E9B94" }}>{value || "Not set"}</p>
      )}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        {editing ? (
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={() => setEditing(false)} style={{ padding: "7px 14px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
            <button onClick={save} style={{ padding: "7px 14px", background: "var(--brand)", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Save Changes</button>
          </div>
        ) : (
          <button onClick={() => setEditing(true)} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "7px 14px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#1A1917", fontSize: "13px", cursor: "pointer" }}>
            <Edit2 size={13} /> Edit
          </button>
        )}
      </div>

      {/* Intelligence Badges (NPS / Churn) */}
      {((client.latest_nps_score !== null && client.latest_nps_score !== undefined) || (client.churn_risk_score !== null && client.churn_risk_score !== undefined)) && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const }}>
          {client.latest_nps_score !== null && client.latest_nps_score !== undefined && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>NPS Score</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: client.latest_nps_score >= 9 ? "#166534" : client.latest_nps_score >= 7 ? "#92400E" : "#991B1B" }}>{client.latest_nps_score}</span>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: client.latest_nps_score >= 9 ? "#DCFCE7" : client.latest_nps_score >= 7 ? "#FEF3C7" : "#FEE2E2", color: client.latest_nps_score >= 9 ? "#166534" : client.latest_nps_score >= 7 ? "#92400E" : "#991B1B" }}>
                {client.latest_nps_score >= 9 ? "Promoter" : client.latest_nps_score >= 7 ? "Passive" : "Detractor"}
              </span>
            </div>
          )}
          {client.churn_risk_score !== null && client.churn_risk_score !== undefined && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>Churn Risk</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: client.churn_risk_score >= 70 ? "#991B1B" : client.churn_risk_score >= 40 ? "#92400E" : "#166534" }}>{client.churn_risk_score}%</span>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: client.churn_risk_score >= 70 ? "#FEE2E2" : client.churn_risk_score >= 40 ? "#FEF3C7" : "#DCFCE7", color: client.churn_risk_score >= 70 ? "#991B1B" : client.churn_risk_score >= 40 ? "#92400E" : "#166534" }}>
                {client.churn_risk_score >= 70 ? "High" : client.churn_risk_score >= 40 ? "Medium" : "Low"}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── Rate Lock Card ── */}
      {rateLock && (
        <div style={{ border: `1px solid ${rateLock.active ? "#BFDBFE" : "#E5E2DC"}`, borderRadius: 10, padding: "14px 16px", background: rateLock.active ? "#EFF6FF" : "#FAFAF9" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.07em", color: rateLock.active ? "#1D4ED8" : "#9E9B94" }}>Rate Lock</span>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: rateLock.active ? "#DBEAFE" : "#F3F4F6", color: rateLock.active ? "#1D4ED8" : "#6B7280" }}>
                {rateLock.active ? "Active" : "Voided"}
              </span>
            </div>
            {rateLock.active && (
              <button onClick={() => setVoidModal(true)} style={{ fontSize: 11, fontWeight: 600, color: "#DC2626", background: "none", border: "1px solid #FCA5A5", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                Void Lock
              </button>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 2 }}>Locked Rate</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#1A1917" }}>${parseFloat(rateLock.locked_rate).toFixed(2)}<span style={{ fontSize: 11, fontWeight: 500, color: "#6B6860" }}>/visit</span></div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 2 }}>Cadence</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{cadenceLabel(rateLock.cadence)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 2 }}>
                {rateLock.active ? "Expires" : "Voided"}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>
                {rateLock.active
                  ? `${new Date(rateLock.lock_expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} (${lockDaysLeft}d left)`
                  : rateLock.voided_at ? new Date(rateLock.voided_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"
                }
              </div>
            </div>
          </div>
          {!rateLock.active && rateLock.void_reason && (
            <div style={{ marginTop: 10, fontSize: 11, color: "#6B7280" }}>
              <strong>Void reason:</strong> {rateLock.void_reason === "manual" ? "Voided manually" : rateLock.void_reason === "time_overrun" ? "Recurring time overruns" : rateLock.void_reason === "service_gap" ? "60+ day service gap" : rateLock.void_reason === "expired" ? "24-month term expired" : rateLock.void_reason}
              {rateLock.void_notes && <span> — {rateLock.void_notes}</span>}
            </div>
          )}
        </div>
      )}

      {/* ── No lock: Add Rate Lock button ── */}
      {!rateLock && (
        <div>
          <button onClick={() => setAddLockModal(true)} style={{ fontSize: 12, fontWeight: 600, color: "var(--brand)", background: "none", border: "1px solid var(--brand)", borderRadius: 7, padding: "6px 14px", cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
            + Add Rate Lock
          </button>
        </div>
      )}

      {/* ── Void Lock Modal ── */}
      {voidModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
          <div style={{ background: "#FFFFFF", borderRadius: 12, padding: 28, width: 420, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#1A1917", marginBottom: 6 }}>Void Rate Lock</div>
            <div style={{ fontSize: 13, color: "#6B6860", marginBottom: 20 }}>
              This will immediately end the locked rate of <strong>${parseFloat(rateLock?.locked_rate ?? 0).toFixed(2)}/visit</strong> for {client.first_name} {client.last_name}. This action cannot be undone.
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>Reason</label>
              <select value={voidReason} onChange={e => setVoidReason(e.target.value)} style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, color: "#1A1917", outline: "none", background: "#FFFFFF", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                <option value="manual">Manual void</option>
                <option value="time_overrun">Recurring time overruns</option>
                <option value="service_gap">Service gap (60+ days)</option>
                <option value="pricing_error">Pricing error / correction</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>Notes (optional)</label>
              <textarea value={voidNotes} onChange={e => setVoidNotes(e.target.value)} rows={3} placeholder="Add context..." style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, color: "#1A1917", resize: "none" as const, outline: "none", fontFamily: "'Plus Jakarta Sans', sans-serif", boxSizing: "border-box" as const }} />
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => { setVoidModal(false); setVoidReason("manual"); setVoidNotes(""); }} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: 7, background: "#FFFFFF", color: "#6B6860", fontSize: 13, cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Cancel</button>
              <button onClick={handleVoidLock} disabled={voiding} style={{ padding: "8px 16px", background: "#DC2626", border: "none", borderRadius: 7, color: "#FFFFFF", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif", opacity: voiding ? 0.6 : 1 }}>{voiding ? "Voiding..." : "Void Rate Lock"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Rate Lock Modal ── */}
      {addLockModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
          <div style={{ background: "#FFFFFF", borderRadius: 12, padding: 28, width: 440, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#1A1917", marginBottom: 6 }}>Add Rate Lock</div>
            <div style={{ fontSize: 13, color: "#6B6860", marginBottom: 20 }}>Manually add a rate lock for {client.first_name} {client.last_name}.</div>
            <div style={{ display: "flex", flexDirection: "column" as const, gap: 14, marginBottom: 20 }}>
              {[
                { label: "Locked Rate ($/visit)", field: "locked_rate", type: "number" },
                { label: "Start Date", field: "start_date", type: "date" },
                { label: "Duration (months)", field: "duration_months", type: "number" },
              ].map(({ label, field, type }) => (
                <div key={field}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>{label}</label>
                  <input type={type} value={(addLockForm as any)[field]} onChange={e => setAddLockForm(f => ({ ...f, [field]: e.target.value }))}
                    style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, color: "#1A1917", outline: "none", boxSizing: "border-box" as const, fontFamily: "'Plus Jakarta Sans', sans-serif" }} />
                </div>
              ))}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>Cadence</label>
                <select value={addLockForm.cadence} onChange={e => setAddLockForm(f => ({ ...f, cadence: e.target.value }))}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, color: "#1A1917", outline: "none", background: "#FFFFFF", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Every 2 Weeks</option>
                  <option value="monthly">Every 4 Weeks</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>Notes (optional)</label>
                <textarea value={addLockForm.notes} onChange={e => setAddLockForm(f => ({ ...f, notes: e.target.value }))} rows={2}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, color: "#1A1917", resize: "none" as const, outline: "none", fontFamily: "'Plus Jakarta Sans', sans-serif", boxSizing: "border-box" as const }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setAddLockModal(false)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: 7, background: "#FFFFFF", color: "#6B6860", fontSize: 13, cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Cancel</button>
              <button onClick={handleAddLock} disabled={addingLock || !addLockForm.locked_rate} style={{ padding: "8px 16px", background: "var(--brand)", border: "none", borderRadius: 7, color: "#FFFFFF", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif", opacity: (addingLock || !addLockForm.locked_rate) ? 0.6 : 1 }}>
                {addingLock ? "Saving..." : "Add Rate Lock"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Homes Tab ────────────────────────────────────────────────────────────────
function HomesTab({ clientId, homes, refetch, zoneColor, zoneName }: { clientId: number; homes: any[]; refetch: () => void; zoneColor?: string; zoneName?: string }) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [showAlarm, setShowAlarm] = useState<number | null>(null);
  const blank = { name: "", address: "", city: "", state: "", zip: "", bedrooms: "", bathrooms: "", sq_footage: "", access_notes: "", alarm_code: "", has_pets: false, pet_notes: "", parking_notes: "", is_primary: false, base_fee: "", allowed_hours: "", frequency: "", service_type: "" };
  const [form, setForm] = useState(blank);
  // [scheduling-engine 2026-04-29] Google Places autocomplete state.
  // Loads the Maps Places script once for the page; the actual
  // Autocomplete is wired inside an effect when the form opens and
  // the ref is in the DOM. On select, parses address_components into
  // street / city / state / zip and patches the form. Server-side
  // POST then runs resolveZoneForZip via routes/clients.ts to
  // assign the zone — no zone preview wired here.
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const [mapsReady, setMapsReady] = useState(false);
  useEffect(() => {
    // [places-key-fallback 2026-04-29] Try the runtime config endpoint
    // first (server reads process.env.GOOGLE_MAPS_API_KEY from
    // Railway's runtime env), fall back to the build-time
    // VITE_GOOGLE_MAPS_API_KEY only if the server isn't reachable.
    // Without this fallback the Places loader silently bails when
    // the frontend build was made without the env var present —
    // which is what was happening on production after PR #16
    // deployed (build-time injection was empty, runtime env had
    // the key, but only InlineAddressEdit on the dispatch page was
    // wired to the runtime endpoint).
    if ((window as any).google?.maps?.places) { setMapsReady(true); return; }
    const scriptId = "gmap-places-script";
    if (document.getElementById(scriptId)) {
      const existing = document.getElementById(scriptId) as HTMLScriptElement;
      existing.addEventListener("load", () => setMapsReady(true));
      return;
    }
    let cancelled = false;
    (async () => {
      let key = "";
      try {
        const r = await fetch(`${API}/api/config/google-maps-key`, {
          headers: { ...getAuthHeaders() },
        });
        if (r.ok) {
          const body = await r.json().catch(() => ({}));
          key = String(body?.key ?? "");
        }
      } catch { /* fall through to build-time */ }
      if (!key) {
        key = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY ?? "";
      }
      if (cancelled) return;
      if (!key) return;
      // Re-check after the await — another instance may have injected
      // the script while we were fetching the key.
      if (document.getElementById(scriptId)) {
        const existing = document.getElementById(scriptId) as HTMLScriptElement;
        existing.addEventListener("load", () => setMapsReady(true));
        if ((window as any).google?.maps?.places) setMapsReady(true);
        return;
      }
      const s = document.createElement("script");
      s.id = scriptId;
      s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places`;
      s.async = true; s.defer = true;
      s.onload = () => setMapsReady(true);
      document.head.appendChild(s);
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!showForm || !mapsReady || !addressInputRef.current) return;
    const g = (window as any).google;
    if (!g?.maps?.places?.Autocomplete) return;
    const ac = new g.maps.places.Autocomplete(addressInputRef.current, {
      componentRestrictions: { country: "us" },
      fields: ["address_components", "formatted_address", "geometry"],
      types: ["address"],
    });
    const listener = ac.addListener("place_changed", () => {
      const place = ac.getPlace();
      if (!place?.address_components) return;
      const get = (type: string) =>
        place.address_components.find((c: any) => c.types.includes(type))?.long_name ?? "";
      const getShort = (type: string) =>
        place.address_components.find((c: any) => c.types.includes(type))?.short_name ?? "";
      const street = `${get("street_number")} ${get("route")}`.trim();
      const city = get("locality") || get("sublocality") || get("postal_town");
      const state = getShort("administrative_area_level_1");
      const zip = get("postal_code");
      setForm(f => ({ ...f, address: street, city, state, zip }));
    });
    return () => { listener?.remove?.(); };
  }, [showForm, mapsReady]);

  const createMut = useMutation({
    mutationFn: (data: any) => apiFetch(`/api/clients/${clientId}/homes`, { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => { refetch(); setShowForm(false); setForm(blank); },
  });

  const deleteMut = useMutation({
    mutationFn: (homeId: number) => apiFetch(`/api/clients/${clientId}/homes/${homeId}`, { method: "DELETE" }),
    onSuccess: () => refetch(),
  });

  const F = (field: string, label: string, type = "text", placeholder = "", extraProps?: Record<string, any>) => (
    <div>
      <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#6B7280", marginBottom: "4px" }}>{label}</label>
      <input value={(form as any)[field]} onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))} type={type} placeholder={placeholder}
        {...(extraProps || {})}
        style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", color: "#1A1917", outline: "none", boxSizing: "border-box" }} />
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {homes.map(home => (
        <div key={home.id} style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "#1A1917" }}>{home.name || "Home"}</h3>
                {home.is_primary && <span style={{ background: "var(--brand-dim)", color: "var(--brand)", padding: "2px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: 700, textTransform: "uppercase" }}>Default</span>}
              </div>
              <p style={{ margin: "4px 0 0", fontSize: "15px", fontWeight: 700, color: "#0A0E1A" }}>{home.address}</p>
              <p style={{ margin: "2px 0 0", fontSize: "13px", fontWeight: 500, color: "#374151" }}>{[home.city, home.state, home.zip].filter(Boolean).join(", ")}</p>
              {zoneColor && zoneName && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                  <span style={{ width: 11, height: 11, borderRadius: "50%", backgroundColor: zoneColor, display: "inline-block", flexShrink: 0, boxShadow: `0 0 0 2px ${zoneColor}35` }} />
                  <span style={{ fontSize: "12px", fontWeight: 700, color: zoneColor }}>{zoneName}</span>
                </div>
              )}
            </div>
            <button onClick={() => deleteMut.mutate(home.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: "4px" }}>
              <Trash2 size={14} />
            </button>
          </div>

          {/* Property details */}
          <div style={{ display: "flex", gap: "16px", marginBottom: "12px" }}>
            {home.sq_footage && <span style={{ fontSize: "12px", color: "#9E9B94" }}>{home.sq_footage.toLocaleString()} sq ft</span>}
            {home.bedrooms && <span style={{ fontSize: "12px", color: "#9E9B94" }}>{home.bedrooms} bed</span>}
            {home.bathrooms && <span style={{ fontSize: "12px", color: "#9E9B94" }}>{home.bathrooms} bath</span>}
          </div>

          {/* Access notes */}
          <div style={{ background: "#FAFAF8", border: "1px solid #F0EEE9", borderRadius: "8px", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
            {home.alarm_code && (
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "12px", color: "#6B7280", minWidth: "90px" }}>Alarm Code:</span>
                <span style={{ fontSize: "12px", fontWeight: 600, color: "#1A1917", fontFamily: "monospace", letterSpacing: "0.1em" }}>
                  {showAlarm === home.id ? home.alarm_code : "•".repeat(home.alarm_code.length)}
                </span>
                <button onClick={() => setShowAlarm(showAlarm === home.id ? null : home.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94" }}>
                  {showAlarm === home.id ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
            )}
            {home.access_notes && <p style={{ margin: 0, fontSize: "12px", color: "#6B7280" }}><span style={{ fontWeight: 600, color: "#1A1917" }}>Access: </span>{home.access_notes}</p>}
            {home.parking_notes && <p style={{ margin: 0, fontSize: "12px", color: "#6B7280" }}><span style={{ fontWeight: 600, color: "#1A1917" }}>Parking: </span>{home.parking_notes}</p>}
            {home.has_pets && <p style={{ margin: 0, fontSize: "12px", color: "#6B7280" }}><span style={{ fontWeight: 600, color: "#1A1917" }}>Pets: </span>{home.pet_notes || "Yes"}</p>}
          </div>

          {/* Service settings */}
          <div style={{ display: "flex", gap: "20px", marginTop: "12px", flexWrap: "wrap" }}>
            {home.base_fee && <span style={{ fontSize: "12px", color: "#6B7280" }}>Rate: <strong style={{ color: "#1A1917" }}>{fmtCurrency(home.base_fee)}</strong></span>}
            {home.allowed_hours && <span style={{ fontSize: "12px", color: "#6B7280" }}>Hours: <strong style={{ color: "#1A1917" }}>{home.allowed_hours} hrs</strong></span>}
            {home.frequency && <span style={{ fontSize: "12px", color: "#6B7280" }}>Freq: <strong style={{ color: "#1A1917" }}>{freqLabel(home.frequency)}</strong></span>}
          </div>
        </div>
      ))}

      {/* Add home form */}
      {showForm ? (
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "20px" }}>
          <h3 style={{ margin: "0 0 16px", fontSize: "14px", fontWeight: 700, color: "#1A1917" }}>Add Service Address</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {F("name", "Home Name (optional)", "text", "e.g. Main Home, Vacation Home")}
            {/* [scheduling-engine 2026-04-29] Address input wired to
                Google Places autocomplete via the addressInputRef ref.
                On select, useEffect above patches form.address / city /
                state / zip from the parsed address_components. The
                operator can still type freeform; Places only fires
                when they pick a suggestion. */}
            {F("address", "Address *", "text",
              mapsReady ? "Start typing — Google suggests addresses" : "Address",
              { ref: addressInputRef, autoComplete: "off" })}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 100px", gap: "10px" }}>
              {F("city", "City")} {F("state", "State")} {F("zip", "Zip")}
            </div>
            {(form.city || form.state || form.zip) && (
              <div style={{ fontSize: 11, color: "#6B6860", marginTop: -8 }}>
                Auto-filled from Google. Zone will be assigned on save based on zip.
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px" }}>
              {F("sq_footage", "Sq Ft", "number")} {F("bedrooms", "Beds", "number")} {F("bathrooms", "Baths", "number")}
            </div>
            {F("alarm_code", "Alarm Code")}
            {F("access_notes", "Access Notes")}
            {F("parking_notes", "Parking Notes")}
            <div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                <input type="checkbox" checked={form.has_pets} onChange={e => setForm(f => ({ ...f, has_pets: e.target.checked }))} /> Client has pets
              </label>
            </div>
            {form.has_pets && F("pet_notes", "Pet Notes")}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              {F("base_fee", "Rate ($)", "number")} {F("allowed_hours", "Allowed Hours", "number")}
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
              <input type="checkbox" checked={form.is_primary} onChange={e => setForm(f => ({ ...f, is_primary: e.target.checked }))} /> Set as primary address
            </label>
          </div>
          <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
            <button onClick={() => setShowForm(false)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
            <button onClick={() => createMut.mutate(form)} disabled={createMut.isPending} style={{ padding: "8px 16px", background: "var(--brand)", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
              {createMut.isPending ? "Saving..." : "Add Home"}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowForm(true)} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "12px 16px", border: "1px dashed #D1D5DB", borderRadius: "10px", background: "transparent", color: "#6B7280", fontSize: "13px", cursor: "pointer", width: "100%", justifyContent: "center" }}>
          <Plus size={14} /> Add Another Home
        </button>
      )}
    </div>
  );
}

// ─── Billing Tab ──────────────────────────────────────────────────────────────
function BillingTab({ invoices }: { invoices: any[] }) {
  const statusStyle: Record<string, React.CSSProperties> = {
    paid: { background: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0" },
    overdue: { background: "#FEE2E2", color: "#991B1B", border: "1px solid #FECACA" },
    sent: { background: "#FEF3C7", color: "#92400E", border: "1px solid #FDE68A" },
    draft: { background: "#F3F4F6", color: "#6B7280", border: "1px solid #E5E7EB" },
  };
  const TH: React.CSSProperties = { padding: "10px 16px", textAlign: "left", fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #EEECE7" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 480 }}>
          <thead><tr style={{ backgroundColor: "#FAFAF8" }}>
            {["Date","Invoice #","Amount","Balance","Status",""].map(h => <th key={h} style={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {invoices.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px" }}>No invoices yet</td></tr>
            ) : invoices.map(inv => (
              <tr key={inv.id} style={{ borderBottom: "1px solid #F0EEE9" }}>
                <td style={{ padding: "12px 16px", fontSize: "13px", color: "#6B7280" }}>{fmtDate(inv.created_at)}</td>
                <td style={{ padding: "12px 16px", fontSize: "13px", fontWeight: 600, color: "#1A1917" }}>INV-{String(inv.id).padStart(5, "0")}</td>
                <td style={{ padding: "12px 16px", fontSize: "13px", fontWeight: 600, color: "#1A1917" }}>{fmtCurrency(inv.total)}</td>
                <td style={{ padding: "12px 16px", fontSize: "13px", color: inv.paid_at ? "#9E9B94" : "#1A1917" }}>{inv.paid_at ? "$0.00" : fmtCurrency(inv.total)}</td>
                <td style={{ padding: "12px 16px" }}>
                  <span style={{ ...statusStyle[inv.status] || statusStyle.draft, padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {inv.status}
                  </span>
                </td>
                <td style={{ padding: "12px 16px" }}>
                  <button style={{ fontSize: "12px", color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>View</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

// ─── Agreements Tab ────────────────────────────────────────────────────────────
function AgreementsTab({ clientId, agreements, refetch }: { clientId: number; agreements: any[]; refetch: () => void }) {
  const [showModal, setShowModal] = useState(false);
  const [selectedTemplates, setSelectedTemplates] = useState<number[]>([]);
  const [sending, setSending] = useState(false);
  const [sendDone, setSendDone] = useState(false);
  const [resendingId, setResendingId] = useState<number | null>(null);

  const { data: docRequests = [], refetch: refetchDocs } = useQuery<any[]>({
    queryKey: ["client-doc-requests", clientId],
    queryFn: () => apiFetch(`/api/document-requests?client_id=${clientId}`),
  });

  const { data: templates = [], isLoading: tplLoading } = useQuery<any[]>({
    queryKey: ["client-doc-templates"],
    queryFn: () => apiFetch("/api/document-templates?category=client_residential"),
    enabled: showModal,
  });

  const toggleTemplate = (id: number) => setSelectedTemplates(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);

  const handleSend = async () => {
    if (!selectedTemplates.length) return;
    setSending(true);
    try {
      await apiFetch("/api/document-requests/send", { method: "POST", body: JSON.stringify({ template_ids: selectedTemplates, client_id: clientId }) });
      setSendDone(true);
      setTimeout(() => { setShowModal(false); setSendDone(false); setSelectedTemplates([]); refetchDocs(); refetch(); }, 1500);
    } catch { /* ignore */ }
    setSending(false);
  };

  const handleResend = async (requestId: number) => {
    setResendingId(requestId);
    try {
      await apiFetch(`/api/document-requests/${requestId}/resend`, { method: "POST" });
      refetchDocs();
    } catch { /* ignore */ }
    setResendingId(null);
  };

  const TH: React.CSSProperties = { padding: "10px 16px", textAlign: "left", fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #EEECE7" };

  const allDocs = [
    ...docRequests.map((d: any) => ({ ...d, _src: "new" })),
    ...agreements.filter(a => !docRequests.find((d: any) => d.id === a.id)).map((a: any) => ({ ...a, _src: "legacy" })),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={() => setShowModal(true)} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", background: "var(--brand)", border: "none", borderRadius: "8px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
          <Send size={13} /> Send Agreement
        </button>
      </div>

      {showModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: 28, width: 440, boxShadow: "0 20px 60px rgba(0,0,0,0.2)", maxHeight: "80vh", overflowY: "auto" }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: "#1A1917" }}>Send Agreement</h3>
            <p style={{ fontSize: 13, color: "#6B7280", margin: "0 0 16px" }}>Select one or more document templates to send.</p>
            {sendDone ? (
              <div style={{ textAlign: "center", padding: "20px 0" }}>
                <Check size={24} color="var(--brand)" style={{ display: "block", margin: "0 auto 8px" }}/>
                <p style={{ fontSize: 14, fontWeight: 600, color: "#1A1917" }}>Agreement sent!</p>
              </div>
            ) : (
              <>
                {tplLoading ? (
                  <p style={{ fontSize: 13, color: "#9E9B94" }}>Loading templates…</p>
                ) : templates.length === 0 ? (
                  <p style={{ fontSize: 13, color: "#9E9B94" }}>No client agreement templates found. Add them in Company Settings → Documents.</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
                    {templates.map((t: any) => (
                      <label key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "10px 12px", border: `1px solid ${selectedTemplates.includes(t.id) ? "var(--brand)" : "#E5E2DC"}`, borderRadius: 8, background: selectedTemplates.includes(t.id) ? "#F0FBF8" : "#fff" }}>
                        <input type="checkbox" checked={selectedTemplates.includes(t.id)} onChange={() => toggleTemplate(t.id)} style={{ accentColor: "var(--brand)", width: 15, height: 15 }}/>
                        <div>
                          <p style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", margin: 0 }}>{t.name}</p>
                          {t.requires_signature && <p style={{ fontSize: 11, color: "#9E9B94", margin: 0 }}>Requires signature</p>}
                        </div>
                      </label>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button onClick={() => { setShowModal(false); setSelectedTemplates([]); }} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: 7, background: "#fff", color: "#6B7280", fontSize: 13, cursor: "pointer" }}>Cancel</button>
                  <button onClick={handleSend} disabled={sending || !selectedTemplates.length} style={{ padding: "8px 16px", background: "var(--brand)", border: "none", borderRadius: 7, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: selectedTemplates.length ? 1 : 0.5 }}>
                    {sending ? "Sending…" : "Send"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ backgroundColor: "#FAFAF8" }}>
            {["Agreement","Sent","Status","Signed",""].map(h => <th key={h} style={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {allDocs.length === 0 ? (
              <tr><td colSpan={5} style={{ padding: "14px 16px", textAlign: "left", color: "#9E9B94", fontSize: "13px" }}>No agreements sent yet</td></tr>
            ) : allDocs.map((a: any) => {
              const isSigned = a._src === "new" ? a.status === "signed" : !!a.accepted_at;
              const isPending = a._src === "new" ? a.status === "pending" : !a.accepted_at;
              return (
                <tr key={`${a._src}-${a.id}`} style={{ borderBottom: "1px solid #F0EEE9" }}>
                  <td style={{ padding: "12px 16px", fontSize: "13px", fontWeight: 600, color: "#1A1917" }}>{a.template_name || "Service Agreement"}</td>
                  <td style={{ padding: "12px 16px", fontSize: "12px", color: "#6B7280" }}>{fmtDate(a.sent_at)}</td>
                  <td style={{ padding: "12px 16px" }}>
                    {isSigned
                      ? <span style={{ background: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0", padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 700 }}>Signed</span>
                      : a.status === "expired"
                      ? <span style={{ background: "#F3F4F6", color: "#6B7280", border: "1px solid #E5E7EB", padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 700 }}>Expired</span>
                      : <span style={{ background: "#FEF3C7", color: "#92400E", border: "1px solid #FDE68A", padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 700 }}>Pending</span>
                    }
                  </td>
                  <td style={{ padding: "12px 16px", fontSize: "12px", color: "#6B7280" }}>
                    {a._src === "new" && a.signed_at ? fmtDate(a.signed_at) : a.accepted_at ? fmtDate(a.accepted_at) : "—"}
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    {a._src === "new" && isPending && (
                      <button onClick={() => handleResend(a.id)} disabled={resendingId === a.id}
                        style={{ fontSize: 12, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontWeight: 600, padding: 0 }}>
                        {resendingId === a.id ? "…" : "Resend"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Contacts & Notifications Tab ─────────────────────────────────────────────
const TRIGGERS = ["3_days_before","1_day_before","day_of","on_the_way","job_started","job_complete","scorecard_request","invoice_sent"];
const TRIGGER_LABELS: Record<string,string> = { "3_days_before":"3 Days Before","1_day_before":"1 Day Before","day_of":"Day Of","on_the_way":"On the Way","job_started":"Job Started","job_complete":"Job Complete","scorecard_request":"Scorecard Request","invoice_sent":"Invoice Sent" };

function ContactsTab({ clientId, notifications, refetch }: { clientId: number; notifications: any[]; refetch: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ contact_value: "", contact_type: "email", triggers: [] as string[] });
  const [editing, setEditing] = useState<number | null>(null);

  const createMut = useMutation({
    mutationFn: (data: any) => apiFetch(`/api/clients/${clientId}/notifications`, { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => { refetch(); setShowForm(false); setForm({ contact_value: "", contact_type: "email", triggers: [] }); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/clients/${clientId}/notifications/${id}`, { method: "DELETE" }),
    onSuccess: () => refetch(),
  });

  const toggleTrigger = (t: string) =>
    setForm(f => ({ ...f, triggers: f.triggers.includes(t) ? f.triggers.filter(x => x !== t) : [...f.triggers, t] }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={() => setShowForm(true)} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", background: "var(--brand)", border: "none", borderRadius: "8px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
          <Plus size={13} /> Create Notification
        </button>
      </div>

      {showForm && (
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "20px" }}>
          <h3 style={{ margin: "0 0 14px", fontSize: "14px", fontWeight: 700, color: "#1A1917" }}>Add Notification Contact</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: "10px" }}>
              <div>
                <label style={{ fontSize: "11px", fontWeight: 600, color: "#6B7280", display: "block", marginBottom: "4px" }}>Contact Info</label>
                <input value={form.contact_value} onChange={e => setForm(f => ({ ...f, contact_value: e.target.value }))} placeholder="email@example.com or +1 555-0100"
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", outline: "none", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: "11px", fontWeight: 600, color: "#6B7280", display: "block", marginBottom: "4px" }}>Type</label>
                <select value={form.contact_type} onChange={e => setForm(f => ({ ...f, contact_type: e.target.value }))} style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", outline: "none", background: "#FFFFFF" }}>
                  <option value="email">Email</option>
                  <option value="sms">SMS</option>
                </select>
              </div>
            </div>
            <div>
              <label style={{ fontSize: "11px", fontWeight: 600, color: "#6B7280", display: "block", marginBottom: "8px" }}>Notification Triggers</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {TRIGGERS.map(t => (
                  <button key={t} onClick={() => toggleTrigger(t)} style={{ padding: "5px 10px", border: `1px solid ${form.triggers.includes(t) ? "var(--brand)" : "#E5E2DC"}`, borderRadius: "20px", background: form.triggers.includes(t) ? "var(--brand-dim)" : "#FFFFFF", color: form.triggers.includes(t) ? "var(--brand)" : "#6B7280", fontSize: "12px", fontWeight: form.triggers.includes(t) ? 600 : 400, cursor: "pointer" }}>
                    {TRIGGER_LABELS[t]}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={() => setShowForm(false)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
              <button onClick={() => createMut.mutate(form)} disabled={createMut.isPending} style={{ padding: "8px 16px", background: "var(--brand)", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Save</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", overflow: "hidden" }}>
        {notifications.length === 0 ? (
          <div style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px" }}>No notification contacts configured</div>
        ) : notifications.map(n => (
          <div key={n.id} style={{ padding: "16px 20px", borderBottom: "1px solid #F0EEE9", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                {n.contact_type === "email" ? <Mail size={13} style={{ color: "#9E9B94" }} /> : <Phone size={13} style={{ color: "#9E9B94" }} />}
                <span style={{ fontSize: "13px", fontWeight: 600, color: "#1A1917" }}>{n.contact_value}</span>
                <span style={{ fontSize: "10px", fontWeight: 600, color: "#9E9B94", background: "#F3F4F6", padding: "2px 6px", borderRadius: "3px", textTransform: "uppercase" }}>{n.contact_type}</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                {(n.triggers || []).map((t: string) => (
                  <span key={t} style={{ background: "var(--brand-dim)", color: "var(--brand)", padding: "2px 8px", borderRadius: "12px", fontSize: "11px", fontWeight: 500 }}>{TRIGGER_LABELS[t] || t}</span>
                ))}
              </div>
            </div>
            <button onClick={() => deleteMut.mutate(n.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: "4px" }}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Scorecards Tab ────────────────────────────────────────────────────────────
function ScorecardsTab({ scorecards }: { scorecards: any[] }) {
  const scoreInfo: Record<number, { label: string; style: React.CSSProperties }> = {
    4: { label: "Excellent", style: { background: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0" } },
    3: { label: "Good - Keep it up", style: { background: "#DBEAFE", color: "#1E40AF", border: "1px solid #BFDBFE" } },
    2: { label: "A Few Concerns", style: { background: "#FEF3C7", color: "#92400E", border: "1px solid #FDE68A" } },
    1: { label: "Needs Improvement", style: { background: "#FFEDD5", color: "#9A3412", border: "1px solid #FED7AA" } },
    0: { label: "Unacceptable", style: { background: "#FEE2E2", color: "#991B1B", border: "1px solid #FECACA" } },
  };
  const TH: React.CSSProperties = { padding: "10px 16px", textAlign: "left", fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #EEECE7" };
  return (
    <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr style={{ backgroundColor: "#FAFAF8" }}>
          {["Job Date","Score","Technician","Comments","Actions"].map(h => <th key={h} style={TH}>{h}</th>)}
        </tr></thead>
        <tbody>
          {scorecards.length === 0 ? (
            <tr><td colSpan={5} style={{ padding: "14px 16px", textAlign: "left", color: "#9E9B94", fontSize: "13px" }}>No scorecards yet</td></tr>
          ) : scorecards.map(sc => {
            const info = scoreInfo[sc.score] || scoreInfo[0];
            return (
              <tr key={sc.id} style={{ borderBottom: "1px solid #F0EEE9" }}>
                <td style={{ padding: "12px 16px", fontSize: "12px", color: "#6B7280" }}>{fmtDate(sc.scheduled_date || sc.created_at)}</td>
                <td style={{ padding: "12px 16px" }}>
                  <span style={{ ...info.style, padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 700, whiteSpace: "nowrap" }}>{sc.score}/4 — {info.label}</span>
                </td>
                <td style={{ padding: "12px 16px", fontSize: "13px", color: "#1A1917" }}>{sc.first_name} {sc.last_name}</td>
                <td style={{ padding: "12px 16px", fontSize: "12px", color: "#6B7280", maxWidth: "250px" }}>{sc.comments || "-"}</td>
                <td style={{ padding: "12px 16px" }}>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button style={{ fontSize: "11px", color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>Add to Testimonials</button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Tech Preferences Tab ──────────────────────────────────────────────────────
function TechPrefsTab({ clientId, prefs, refetch }: { clientId: number; prefs: any[]; refetch: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ user_id: "", preference: "preferred", notes: "" });

  const { data: employees } = useQuery<any[]>({
    queryKey: ["employees"],
    queryFn: () => apiFetch("/api/users"),
    staleTime: 60000,
  });

  const createMut = useMutation({
    mutationFn: (data: any) => apiFetch(`/api/clients/${clientId}/tech-preferences`, { method: "POST", body: JSON.stringify({ ...data, user_id: parseInt(data.user_id) }) }),
    onSuccess: () => { refetch(); setShowForm(false); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/clients/${clientId}/tech-preferences/${id}`, { method: "DELETE" }),
    onSuccess: () => refetch(),
  });

  const prefStyle: Record<string, React.CSSProperties> = {
    preferred: { background: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0" },
    do_not_schedule: { background: "#FEE2E2", color: "#991B1B", border: "1px solid #FECACA" },
    neutral: { background: "#F3F4F6", color: "#6B7280", border: "1px solid #E5E7EB" },
  };
  const prefLabels: Record<string, string> = { preferred: "Preferred", do_not_schedule: "Do Not Schedule", neutral: "Neutral" };

  const TH: React.CSSProperties = { padding: "10px 16px", textAlign: "left", fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #EEECE7" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ backgroundColor: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: "8px", padding: "12px", display: "flex", alignItems: "flex-start", gap: "8px" }}>
        <AlertTriangle size={14} style={{ color: "#F59E0B", flexShrink: 0, marginTop: "1px" }} />
        <p style={{ margin: 0, fontSize: "12px", color: "#78350F" }}>
          Do Not Schedule preferences are enforced on the dispatch board. A warning will appear before assigning a flagged technician to this client.
        </p>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={() => setShowForm(true)} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", background: "var(--brand)", border: "none", borderRadius: "8px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
          <Plus size={13} /> Create Preference
        </button>
      </div>

      {showForm && (
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "20px" }}>
          <h3 style={{ margin: "0 0 14px", fontSize: "14px", fontWeight: 700, color: "#1A1917" }}>Add Technician Preference</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div>
              <label style={{ fontSize: "11px", fontWeight: 600, color: "#6B7280", display: "block", marginBottom: "4px" }}>Technician</label>
              <select value={form.user_id} onChange={e => setForm(f => ({ ...f, user_id: e.target.value }))} style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", outline: "none", background: "#FFFFFF" }}>
                <option value="">Select technician...</option>
                {(employees || []).filter((e: any) => e.role === "technician").map((e: any) => (
                  <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: "11px", fontWeight: 600, color: "#6B7280", display: "block", marginBottom: "4px" }}>Preference</label>
              <select value={form.preference} onChange={e => setForm(f => ({ ...f, preference: e.target.value }))} style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", outline: "none", background: "#FFFFFF" }}>
                <option value="preferred">Preferred</option>
                <option value="do_not_schedule">Do Not Schedule</option>
                <option value="neutral">Neutral</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: "11px", fontWeight: 600, color: "#6B7280", display: "block", marginBottom: "4px" }}>Notes (optional)</label>
              <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Reason or details"
                style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", outline: "none", boxSizing: "border-box" }} />
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={() => setShowForm(false)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
              <button onClick={() => createMut.mutate(form)} disabled={createMut.isPending || !form.user_id} style={{ padding: "8px 16px", background: "var(--brand)", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Save</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ backgroundColor: "#FAFAF8" }}>
            {["Technician","Preference","Notes","Actions"].map(h => <th key={h} style={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {prefs.length === 0 ? (
              <tr><td colSpan={4} style={{ padding: "14px 16px", textAlign: "left", color: "#9E9B94", fontSize: "13px" }}>No preferences set</td></tr>
            ) : prefs.map(p => (
              <tr key={p.id} style={{ borderBottom: "1px solid #F0EEE9" }}>
                <td style={{ padding: "12px 16px", fontSize: "13px", fontWeight: 600, color: "#1A1917" }}>{p.first_name} {p.last_name}</td>
                <td style={{ padding: "12px 16px" }}>
                  <span style={{ ...(prefStyle[p.preference] || prefStyle.neutral), padding: "3px 10px", borderRadius: "4px", fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {prefLabels[p.preference] || p.preference}
                  </span>
                </td>
                <td style={{ padding: "12px 16px", fontSize: "12px", color: "#6B7280" }}>{p.notes || "-"}</td>
                <td style={{ padding: "12px 16px" }}>
                  <button onClick={() => deleteMut.mutate(p.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94" }}>
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Notes Tab ─────────────────────────────────────────────────────────────────
function NotesTab({ clientId, client }: { clientId: number; client: any }) {
  const [filter, setFilter] = useState<string>("all");
  const [compose, setCompose] = useState<"sms" | "email" | "note" | null>(null);
  const [smsBody, setSmsBody] = useState(""); const [emailSubject, setEmailSubject] = useState(""); const [emailBody, setEmailBody] = useState(""); const [noteBody, setNoteBody] = useState("");
  const qc = useQueryClient();

  const { data: comms = [], isLoading } = useQuery<any[]>({
    queryKey: ["client-comms", clientId, filter],
    queryFn: () => apiFetch(`/api/clients/${clientId}/communications${filter !== "all" ? `?type=${filter}` : ""}`),
    staleTime: 10000,
  });

  const smsMut = useMutation({ mutationFn: () => apiFetch(`/api/clients/${clientId}/communications/sms`, { method: "POST", body: JSON.stringify({ to: client.phone, message: smsBody }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["client-comms", clientId] }); setCompose(null); setSmsBody(""); } });
  const emailMut = useMutation({ mutationFn: () => apiFetch(`/api/clients/${clientId}/communications/email`, { method: "POST", body: JSON.stringify({ to: client.email, subject: emailSubject, body: emailBody }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["client-comms", clientId] }); setCompose(null); setEmailBody(""); setEmailSubject(""); } });
  const noteMut = useMutation({ mutationFn: () => apiFetch(`/api/clients/${clientId}/communications/note`, { method: "POST", body: JSON.stringify({ body: noteBody }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["client-comms", clientId] }); setCompose(null); setNoteBody(""); } });

  const typeIcon: Record<string, { icon: any; color: string }> = {
    sms: { icon: MessageSquare, color: "#5B9BD5" },
    email: { icon: Mail, color: "#5B9BD5" },
    note: { icon: StickyNote, color: "#92400E" },
    system: { icon: Check, color: "#9E9B94" },
    call_log: { icon: Phone, color: "#16A34A" },
    portal_activity: { icon: Globe, color: "#7C3AED" },
  };

  const directionLabel: Record<string, string> = { inbound: "Inbound", outbound: "Outbound", internal: "Internal" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {/* Compose bar */}
      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "16px" }}>
        <div style={{ display: "flex", gap: "8px", marginBottom: compose ? "14px" : 0 }}>
          <button onClick={() => setCompose(compose === "sms" ? null : "sms")} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", border: `1px solid ${compose === "sms" ? "var(--brand)" : "#E5E2DC"}`, borderRadius: "8px", background: compose === "sms" ? "var(--brand-dim)" : "#FFFFFF", color: compose === "sms" ? "var(--brand)" : "#1A1917", fontSize: "13px", cursor: "pointer" }}>
            <MessageSquare size={13} /> Send SMS
          </button>
          <button onClick={() => setCompose(compose === "email" ? null : "email")} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", border: `1px solid ${compose === "email" ? "var(--brand)" : "#E5E2DC"}`, borderRadius: "8px", background: compose === "email" ? "var(--brand-dim)" : "#FFFFFF", color: compose === "email" ? "var(--brand)" : "#1A1917", fontSize: "13px", cursor: "pointer" }}>
            <Mail size={13} /> Send Email
          </button>
          <button onClick={() => setCompose(compose === "note" ? null : "note")} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", border: `1px solid ${compose === "note" ? "var(--brand)" : "#E5E2DC"}`, borderRadius: "8px", background: compose === "note" ? "var(--brand-dim)" : "#FFFFFF", color: compose === "note" ? "var(--brand)" : "#1A1917", fontSize: "13px", cursor: "pointer" }}>
            <StickyNote size={13} /> Add Note
          </button>
        </div>

        {compose === "sms" && (
          <div style={{ borderTop: "1px solid #F0EEE9", paddingTop: "14px", display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{ fontSize: "12px", color: "#6B7280" }}>To: <strong style={{ color: "#1A1917" }}>{client.phone || "No phone on file"}</strong></div>
            <textarea value={smsBody} onChange={e => setSmsBody(e.target.value)} placeholder="Type your message..." rows={3}
              style={{ width: "100%", padding: "10px", border: "1px solid #E5E2DC", borderRadius: "8px", fontSize: "13px", outline: "none", resize: "vertical", boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={() => setCompose(null)} style={{ padding: "7px 14px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
              <button onClick={() => smsMut.mutate()} disabled={!smsBody || smsMut.isPending} style={{ padding: "7px 14px", background: "var(--brand)", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Send SMS</button>
            </div>
          </div>
        )}
        {compose === "email" && (
          <div style={{ borderTop: "1px solid #F0EEE9", paddingTop: "14px", display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{ fontSize: "12px", color: "#6B7280" }}>To: <strong style={{ color: "#1A1917" }}>{client.email || "No email on file"}</strong></div>
            <input value={emailSubject} onChange={e => setEmailSubject(e.target.value)} placeholder="Subject"
              style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", outline: "none", boxSizing: "border-box" }} />
            <textarea value={emailBody} onChange={e => setEmailBody(e.target.value)} placeholder="Message..." rows={4}
              style={{ width: "100%", padding: "10px", border: "1px solid #E5E2DC", borderRadius: "8px", fontSize: "13px", outline: "none", resize: "vertical", boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={() => setCompose(null)} style={{ padding: "7px 14px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
              <button onClick={() => emailMut.mutate()} disabled={!emailBody || emailMut.isPending} style={{ padding: "7px 14px", background: "var(--brand)", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Send Email</button>
            </div>
          </div>
        )}
        {compose === "note" && (
          <div style={{ borderTop: "1px solid #F0EEE9", paddingTop: "14px", display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{ fontSize: "12px", color: "#6B7280" }}>Internal note — visible to staff only</div>
            <textarea value={noteBody} onChange={e => setNoteBody(e.target.value)} placeholder="Type your note..." rows={3}
              style={{ width: "100%", padding: "10px", border: "1px solid #E5E2DC", borderRadius: "8px", fontSize: "13px", outline: "none", resize: "vertical", boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={() => setCompose(null)} style={{ padding: "7px 14px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
              <button onClick={() => noteMut.mutate()} disabled={!noteBody || noteMut.isPending} style={{ padding: "7px 14px", background: "#1A1917", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Save Note</button>
            </div>
          </div>
        )}
      </div>

      {/* Filter */}
      <div style={{ display: "flex", gap: "4px", background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: "8px", padding: "3px", width: "fit-content" }}>
        {["all","sms","email","note","system"].map(f => {
          const active = filter === f;
          return (
            <button key={f} onClick={() => setFilter(f)} style={{ padding: "5px 12px", border: `1px solid ${active ? "var(--brand)" : "transparent"}`, borderRadius: "6px", backgroundColor: active ? "var(--brand-dim)" : "transparent", color: active ? "var(--brand)" : "#6B7280", fontSize: "12px", fontWeight: active ? 600 : 400, cursor: "pointer" }}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          );
        })}
      </div>

      {/* Timeline */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {isLoading ? (
          <div style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px" }}>Loading communications...</div>
        ) : comms.length === 0 ? (
          <div style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px", backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px" }}>No communications logged yet</div>
        ) : comms.map((c: any) => {
          const ti = typeIcon[c.type] || typeIcon.system;
          const Icon = ti.icon;
          return (
            <div key={c.id} style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "8px", padding: "14px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: c.type === "note" ? "#FEF3C7" : "var(--brand-dim)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Icon size={13} style={{ color: ti.color }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "12px", fontWeight: 700, color: "#1A1917", textTransform: "capitalize" }}>{c.type}</span>
                    {c.direction && <span style={{ fontSize: "11px", color: "#9E9B94" }}>— {directionLabel[c.direction] || c.direction}</span>}
                    <span style={{ fontSize: "11px", color: "#9E9B94", marginLeft: "auto" }}>{new Date(c.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                    {(c.sent_by_first || c.from_name) && <span style={{ fontSize: "11px", color: "#9E9B94" }}>by {c.sent_by_first ? `${c.sent_by_first} ${c.sent_by_last || ""}`.trim() : c.from_name}</span>}
                  </div>
                  {c.to_contact && <div style={{ fontSize: "11px", color: "#9E9B94", marginTop: "2px" }}>To: {c.to_contact}</div>}
                </div>
              </div>
              {c.subject && <p style={{ margin: "0 0 4px", fontSize: "12px", fontWeight: 700, color: "#1A1917" }}>{c.subject}</p>}
              <p style={{ margin: 0, fontSize: "13px", color: c.type === "note" ? "#1A1917" : "#6B7280", lineHeight: 1.5 }}>{c.body}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Card on File Tab ─────────────────────────────────────────────────────────
function CardOnFileTab({ client, refetch }: { client: any; refetch: () => void }) {
  const [sending, setSending] = useState<"email" | "sms" | null>(null);
  const [sent, setSent] = useState<"email" | "sms" | null>(null);
  const [togglingAutoCharge, setTogglingAutoCharge] = useState(false);

  // [AH] Inline edit for commercial_hourly_rate on the Billing Settings card.
  const [editingRate, setEditingRate] = useState(false);
  const [rateValue, setRateValue] = useState<string>(
    client.commercial_hourly_rate != null ? String(client.commercial_hourly_rate) : ""
  );
  const [savingRate, setSavingRate] = useState(false);

  const FF = "'Plus Jakarta Sans', sans-serif";
  const hasCard = !!client.card_last_four;
  const brandIcon = client.card_brand ? client.card_brand.charAt(0).toUpperCase() + client.card_brand.slice(1) : "Card";

  async function saveCommercialRate() {
    setSavingRate(true);
    try {
      const trimmed = rateValue.trim();
      const value = trimmed === "" ? null : parseFloat(trimmed);
      if (value !== null && (isNaN(value) || value < 0)) {
        setSavingRate(false);
        return;
      }
      await fetch(`${API}/api/clients/${client.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ commercial_hourly_rate: value }),
      });
      refetch();
      setEditingRate(false);
    } finally {
      setSavingRate(false);
    }
  }

  async function sendCardLink(channel: "email" | "sms") {
    setSending(channel);
    try {
      const res = await fetch(`${API}/api/payment-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          client_id: client.id,
          purpose: "save_card",
          send_email: channel === "email",
          send_sms: channel === "sms",
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Failed to send link");
      } else {
        setSent(channel);
        setTimeout(() => setSent(null), 3000);
      }
    } catch {
      alert("Network error — please try again");
    } finally {
      setSending(null);
    }
  }

  async function toggleAutoCharge() {
    setTogglingAutoCharge(true);
    try {
      await fetch(`${API}/api/clients/${client.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ auto_charge: !client.auto_charge }),
      });
      refetch();
    } finally {
      setTogglingAutoCharge(false);
    }
  }

  async function removeCard() {
    if (!confirm("Remove card on file? This cannot be undone.")) return;
    await fetch(`${API}/api/clients/${client.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ card_last_four: null, card_brand: null, card_expiry: null, card_saved_at: null }),
    });
    refetch();
  }

  return (
    <div style={{ padding: "0 0 24px" }}>
      {/* Card status */}
      <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 24px", marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "#1A1917", marginBottom: 16, fontFamily: FF }}>Payment Method</div>

        {hasCard ? (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, marginBottom: 16 }}>
              <div style={{ width: 36, height: 36, background: "#059669", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <CreditCard size={18} color="#fff" />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: "#1A1917", fontFamily: FF }}>
                  {brandIcon} •••• {client.card_last_four}
                  {client.card_expiry && <span style={{ marginLeft: 8, fontWeight: 400, color: "#6B7280", fontSize: 12 }}>expires {client.card_expiry}</span>}
                </div>
                {client.card_saved_at && (
                  <div style={{ fontSize: 12, color: "#6B7280", fontFamily: FF, marginTop: 2 }}>
                    Saved {new Date(client.card_saved_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </div>
                )}
              </div>
              <button onClick={removeCard} style={{ fontSize: 12, color: "#DC2626", background: "none", border: "none", cursor: "pointer", fontFamily: FF, textDecoration: "underline" }}>
                Remove
              </button>
            </div>

            {/* Auto-charge toggle */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", background: "#F7F6F3", borderRadius: 8, marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: "#1A1917", fontFamily: FF }}>Auto-charge on invoice creation</div>
                <div style={{ fontSize: 12, color: "#6B7280", fontFamily: FF, marginTop: 2 }}>Automatically charges this card when an invoice is created</div>
              </div>
              <button
                onClick={toggleAutoCharge}
                disabled={togglingAutoCharge}
                style={{
                  width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer",
                  background: client.auto_charge ? "var(--brand)" : "#D1D5DB",
                  position: "relative", transition: "background 0.2s", flexShrink: 0,
                }}
              >
                <span style={{
                  position: "absolute", top: 2, left: client.auto_charge ? 22 : 2,
                  width: 20, height: 20, borderRadius: "50%", background: "#fff",
                  transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                }} />
              </button>
            </div>

            {/* Send new link */}
            <div style={{ fontSize: 12, color: "#6B7280", fontFamily: FF, marginBottom: 8 }}>Send a new card link to update the saved method:</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => sendCardLink("email")}
                disabled={!!sending}
                style={{ flex: 1, padding: "10px 0", background: "#fff", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: FF, color: sending === "email" ? "#9E9B94" : "#1A1917" }}
              >
                {sent === "email" ? "Sent!" : sending === "email" ? "Sending..." : "Send New Link via Email"}
              </button>
              <button
                onClick={() => sendCardLink("sms")}
                disabled={!!sending}
                style={{ flex: 1, padding: "10px 0", background: "#fff", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: FF, color: sending === "sms" ? "#9E9B94" : "#1A1917" }}
              >
                {sent === "sms" ? "Sent!" : sending === "sms" ? "Sending..." : "Send New Link via SMS"}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, marginBottom: 16 }}>
              <div style={{ width: 36, height: 36, background: "#E5E2DC", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <CreditCard size={18} color="#9E9B94" />
              </div>
              <div style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>No payment method saved</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => sendCardLink("email")}
                disabled={!!sending}
                style={{ flex: 1, padding: "11px 0", background: "var(--brand)", border: "none", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF, color: "#fff" }}
              >
                {sent === "email" ? "Sent!" : sending === "email" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : "Send Card Link via Email"}
              </button>
              <button
                onClick={() => sendCardLink("sms")}
                disabled={!!sending}
                title={!client.phone ? "No phone on file" : ""}
                style={{ flex: 1, padding: "11px 0", background: "#fff", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: client.phone ? "pointer" : "not-allowed", fontFamily: FF, color: client.phone ? "#1A1917" : "#9E9B94" }}
              >
                {sent === "sms" ? "Sent!" : sending === "sms" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : "Send Card Link via SMS"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Commercial billing info */}
      {client.client_type === "commercial" && (
        <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 24px" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "#1A1917", marginBottom: 16, fontFamily: FF }}>Billing Settings</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: 13 }}>
            <div>
              <div style={{ color: "#6B7280", marginBottom: 3, fontFamily: FF }}>Payment Terms</div>
              <div style={{ fontWeight: 600, color: "#1A1917", fontFamily: FF }}>
                {client.payment_terms === "net_30" ? "NET 30" : client.payment_terms === "net_15" ? "NET 15" : "Due on Receipt"}
              </div>
            </div>
            <div>
              <div style={{ color: "#6B7280", marginBottom: 3, fontFamily: FF }}>PO Required</div>
              <div style={{ fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{client.po_number_required ? "Yes" : "No"}</div>
            </div>
            {/* [AH] Commercial hourly rate — inline editable. */}
            <div>
              <div style={{ color: "#6B7280", marginBottom: 3, fontFamily: FF, display: "flex", alignItems: "center", gap: 6 }}>
                Hourly Rate
                {!editingRate && (
                  <button onClick={() => { setRateValue(client.commercial_hourly_rate != null ? String(client.commercial_hourly_rate) : ""); setEditingRate(true); }}
                    style={{ background: "none", border: "none", color: "#1D4ED8", fontSize: 11, cursor: "pointer", padding: 0, fontFamily: FF, fontWeight: 600 }}>
                    {client.commercial_hourly_rate != null ? "Edit" : "Set"}
                  </button>
                )}
              </div>
              {editingRate ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 13, color: "#6B7280" }}>$</span>
                  <input type="number" min={0} step={0.01} value={rateValue}
                    onChange={e => setRateValue(e.target.value)}
                    autoFocus
                    style={{ width: 90, padding: "4px 8px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 13, fontFamily: FF }} />
                  <span style={{ fontSize: 12, color: "#9E9B94" }}>/hr</span>
                  <button onClick={saveCommercialRate} disabled={savingRate}
                    style={{ background: "var(--brand, #00C9A0)", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 700, padding: "4px 10px", cursor: savingRate ? "wait" : "pointer", fontFamily: FF }}>
                    {savingRate ? "…" : "Save"}
                  </button>
                  <button onClick={() => setEditingRate(false)} disabled={savingRate}
                    style={{ background: "none", border: "none", color: "#6B7280", fontSize: 12, cursor: "pointer", fontFamily: FF }}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div style={{ fontWeight: 600, color: client.commercial_hourly_rate != null ? "#1A1917" : "#9E9B94", fontFamily: FF }}>
                  {client.commercial_hourly_rate != null
                    ? `$${Number(client.commercial_hourly_rate).toFixed(2)}/hr`
                    : "Not set"}
                </div>
              )}
            </div>
            {client.billing_contact_name && (
              <div>
                <div style={{ color: "#6B7280", marginBottom: 3, fontFamily: FF }}>Billing Contact</div>
                <div style={{ fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{client.billing_contact_name}</div>
              </div>
            )}
            {client.billing_contact_email && (
              <div>
                <div style={{ color: "#6B7280", marginBottom: 3, fontFamily: FF }}>Billing Email</div>
                <div style={{ fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{client.billing_contact_email}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Portal Account Tab ────────────────────────────────────────────────────────
function PortalTab({ clientId, client, onPortalInvite, refetch }: { clientId: number; client: any; onPortalInvite: () => void; refetch: () => void }) {
  const { data: companyMe } = useQuery<any>({ queryKey: ["company-me"], queryFn: () => apiFetch("/api/companies/me") });
  const companySlug = companyMe?.slug ?? "phes-cleaning";
  const portalStatus = client.portal_access ? "registered" : client.portal_invite_sent_at ? "invited" : "none";

  const deactivateMut = useMutation({
    mutationFn: () => apiFetch(`/api/clients/${clientId}`, { method: "PUT", body: JSON.stringify({ portal_access: false, portal_invite_sent_at: null }) }),
    onSuccess: () => refetch(),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "24px" }}>
        {portalStatus === "registered" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
              <div style={{ width: "40px", height: "40px", borderRadius: "50%", background: "#DCFCE7", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Globe size={18} style={{ color: "#16A34A" }} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#1A1917" }}>Active Portal Account</h3>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#6B7280" }}>Client can log in and manage their account</p>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}>
              <div style={{ display: "flex", gap: "12px" }}>
                <span style={{ fontSize: "12px", color: "#9E9B94", minWidth: "100px" }}>Email:</span>
                <span style={{ fontSize: "12px", fontWeight: 600, color: "#1A1917" }}>{client.email}</span>
              </div>
              {client.portal_last_login && (
                <div style={{ display: "flex", gap: "12px" }}>
                  <span style={{ fontSize: "12px", color: "#9E9B94", minWidth: "100px" }}>Last Login:</span>
                  <span style={{ fontSize: "12px", fontWeight: 600, color: "#1A1917" }}>{fmtDate(client.portal_last_login)}</span>
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button style={{ padding: "8px 14px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#1A1917", fontSize: "13px", cursor: "pointer" }}>Send Password Reset</button>
              <button onClick={() => deactivateMut.mutate()} style={{ padding: "8px 14px", border: "1px solid #FEE2E2", borderRadius: "7px", background: "#FFFFFF", color: "#991B1B", fontSize: "13px", cursor: "pointer" }}>Deactivate Portal Access</button>
            </div>
          </div>
        )}

        {portalStatus === "invited" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
              <div style={{ width: "40px", height: "40px", borderRadius: "50%", background: "#FEF3C7", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Send size={18} style={{ color: "#F59E0B" }} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#1A1917" }}>Invitation Pending</h3>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#6B7280" }}>Invitation sent {fmtDate(client.portal_invite_sent_at)} — client has not registered yet</p>
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={onPortalInvite} style={{ padding: "8px 14px", background: "var(--brand)", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Resend Invitation</button>
              <button style={{ padding: "8px 14px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel Invitation</button>
            </div>
          </div>
        )}

        {portalStatus === "none" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
              <div style={{ width: "40px", height: "40px", borderRadius: "50%", background: "#F3F4F6", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Globe size={18} style={{ color: "#9E9B94" }} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#1A1917" }}>No Portal Access</h3>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#6B7280" }}>Client does not have a portal account</p>
              </div>
            </div>
            <p style={{ margin: "0 0 12px", fontSize: "13px", color: "#6B7280" }}>
              Sending a portal invitation will email the client with a link to create their account. They will be able to view job history, upcoming appointments, and manage their profile.
            </p>
            <button onClick={onPortalInvite} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "10px 18px", background: "var(--brand)", border: "none", borderRadius: "8px", color: "#FFFFFF", fontSize: "14px", fontWeight: 600, cursor: "pointer" }}>
              <Send size={14} /> Send Portal Invitation
            </button>
          </div>
        )}
      </div>

      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "20px" }}>
        <h3 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: 700, color: "#1A1917" }}>Portal Preview</h3>
        <p style={{ margin: "0 0 12px", fontSize: "13px", color: "#6B7280" }}>Open the client portal view to see exactly what this client sees when they log in.</p>
        <a
          href={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/portal/${companySlug}/dashboard`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "8px 14px", border: "1px solid #E5E2DC", borderRadius: "8px", background: "#FFFFFF", color: "#1A1917", fontSize: "13px", cursor: "pointer", textDecoration: "none" }}
        >
          <Globe size={13} /> View Portal
        </a>
      </div>
    </div>
  );
}

// ─── Comm Log Tab ─────────────────────────────────────────────────────────────
function CommLogTab({ clientId }: { clientId: number }) {
  const [form, setForm] = useState({ direction: "inbound", channel: "phone", summary: "" });
  const [submitting, setSubmitting] = useState(false);

  const { data: logs = [], isLoading, refetch } = useQuery<any[]>({
    queryKey: ["comm-log", clientId],
    queryFn: () => apiFetch(`/api/comms?customer_id=${clientId}`),
  });

  async function submit() {
    if (!form.summary.trim()) return;
    setSubmitting(true);
    try {
      await apiFetch("/api/comms", { method: "POST", body: JSON.stringify({ ...form, customer_id: clientId }) });
      setForm(p => ({ ...p, summary: "" }));
      refetch();
    } catch {} finally { setSubmitting(false); }
  }

  const DIR_COLORS: Record<string, React.CSSProperties> = {
    inbound:  { background: "#DCFCE7", color: "#166534" },
    outbound: { background: "#DBEAFE", color: "#1D4ED8" },
  };
  const CH_LABELS: Record<string, string> = { phone: "Phone", email: "Email", sms: "SMS", in_person: "In Person", other: "Other" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Log new */}
      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: 20 }}>
        <h4 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 700, color: "#1A1917" }}>Log Communication</h4>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Direction</label>
            <select value={form.direction} onChange={e => setForm(p => ({ ...p, direction: e.target.value }))}
              style={{ width: "100%", height: 34, padding: "0 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, background: "#FFFFFF" }}>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Channel</label>
            <select value={form.channel} onChange={e => setForm(p => ({ ...p, channel: e.target.value }))}
              style={{ width: "100%", height: 34, padding: "0 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, background: "#FFFFFF" }}>
              {Object.entries({ phone: "Phone", email: "Email", sms: "SMS", in_person: "In Person", other: "Other" }).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
        </div>
        <textarea value={form.summary} onChange={e => setForm(p => ({ ...p, summary: e.target.value }))} rows={2}
          placeholder="Brief summary of the communication..."
          style={{ width: "100%", padding: "8px 12px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, resize: "vertical", fontFamily: "'Plus Jakarta Sans', sans-serif", outline: "none", marginBottom: 10, boxSizing: "border-box" as const }} />
        <button onClick={submit} disabled={submitting || !form.summary.trim()}
          style={{ padding: "7px 16px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          {submitting ? "Logging..." : "Log Entry"}
        </button>
      </div>

      {/* Log list */}
      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
        {isLoading ? (
          <div style={{ padding: 30, textAlign: "center", color: "#9E9B94", fontSize: 13 }}><Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /></div>
        ) : logs.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>No communication logs yet</div>
        ) : logs.map((log: any) => (
          <div key={log.id} style={{ padding: "14px 20px", borderBottom: "1px solid #F0EEE9", display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div style={{ flexShrink: 0, marginTop: 2 }}>
              <span style={{ ...DIR_COLORS[log.direction], padding: "2px 7px", borderRadius: 4, fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const }}>
                {log.direction}
              </span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 3 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", textTransform: "capitalize" as const }}>{CH_LABELS[log.channel] || log.channel}</span>
                <span style={{ fontSize: 11, color: "#9E9B94" }}>·</span>
                <span style={{ fontSize: 11, color: "#9E9B94" }}>{new Date(log.logged_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                {log.logged_by_name && <><span style={{ fontSize: 11, color: "#9E9B94" }}>·</span><span style={{ fontSize: 11, color: "#9E9B94" }}>by {log.logged_by_name}</span></>}
              </div>
              <p style={{ margin: 0, fontSize: 13, color: "#1A1917", lineHeight: 1.5 }}>{log.summary}</p>
            </div>
          </div>
        ))}
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── Recurring Tab ─────────────────────────────────────────────────────────────
function RecurringTab({ clientId }: { clientId: number }) {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ frequency: "biweekly", day_of_week: "monday", start_date: new Date().toISOString().split("T")[0], base_fee: "", notes: "" });
  const [saving, setSaving] = useState(false);

  const { data: schedules = [], isLoading, refetch } = useQuery<any[]>({
    queryKey: ["recurring", clientId],
    queryFn: () => apiFetch(`/api/recurring?customer_id=${clientId}`),
  });

  async function save() {
    setSaving(true);
    try {
      await apiFetch("/api/recurring", { method: "POST", body: JSON.stringify({ ...form, customer_id: clientId }) });
      setShowAdd(false);
      refetch();
    } catch {} finally { setSaving(false); }
  }

  async function pause(id: number) {
    await apiFetch(`/api/recurring/${id}`, { method: "DELETE" });
    refetch();
  }

  const FREQ_LABELS: Record<string, string> = { weekly: "Weekly", biweekly: "Bi-weekly", monthly: "Monthly", custom: "Custom" };
  const DAY_LABELS: Record<string, string> = { monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={() => setShowAdd(true)}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          <Plus size={13} /> Add Schedule
        </button>
      </div>

      {isLoading ? (
        <div style={{ padding: 30, textAlign: "center", color: "#9E9B94" }}><Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /></div>
      ) : schedules.length === 0 ? (
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: 30, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>
          No recurring schedules. Add one to auto-generate jobs for this client.
        </div>
      ) : (
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
          {schedules.map((s: any) => (
            <div key={s.id} style={{ padding: "16px 20px", borderBottom: "1px solid #F0EEE9", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1917" }}>{FREQ_LABELS[s.frequency]}</span>
                  {s.day_of_week && <span style={{ fontSize: 12, color: "#6B7280" }}>· {DAY_LABELS[s.day_of_week]}</span>}
                  {s.base_fee && <span style={{ fontSize: 12, fontWeight: 600, color: "#166534" }}>· ${parseFloat(s.base_fee).toFixed(0)}</span>}
                </div>
                <div style={{ fontSize: 11, color: "#9E9B94" }}>
                  Starts {new Date(s.start_date + "T12:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  {s.last_generated_date && <> · Last gen: {new Date(s.last_generated_date + "T12:00").toLocaleDateString()}</>}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ padding: "2px 8px", backgroundColor: "#DCFCE7", color: "#166534", borderRadius: 4, fontSize: 11, fontWeight: 600 }}>Active</span>
                <button onClick={() => pause(s.id)} style={{ background: "none", border: "1px solid #E5E2DC", cursor: "pointer", borderRadius: 6, padding: "4px 10px", fontSize: 11, color: "#6B7280" }}>Pause</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ backgroundColor: "#FFFFFF", borderRadius: 12, padding: 28, width: 440, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <h3 style={{ margin: "0 0 18px", fontSize: 15, fontWeight: 700, color: "#1A1917" }}>Add Recurring Schedule</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Frequency</label>
                <select value={form.frequency} onChange={e => setForm(p => ({ ...p, frequency: e.target.value }))}
                  style={{ width: "100%", height: 34, padding: "0 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, background: "#FFFFFF" }}>
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Bi-weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Day of Week</label>
                <select value={form.day_of_week} onChange={e => setForm(p => ({ ...p, day_of_week: e.target.value }))}
                  style={{ width: "100%", height: 34, padding: "0 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, background: "#FFFFFF" }}>
                  {["monday","tuesday","wednesday","thursday","friday","saturday","sunday"].map(d => (
                    <option key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Start Date</label>
                <input type="date" value={form.start_date} onChange={e => setForm(p => ({ ...p, start_date: e.target.value }))}
                  style={{ width: "100%", height: 34, padding: "0 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, boxSizing: "border-box" as const }} />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Base Fee ($)</label>
                <input type="number" value={form.base_fee} onChange={e => setForm(p => ({ ...p, base_fee: e.target.value }))}
                  style={{ width: "100%", height: 34, padding: "0 12px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, outline: "none", boxSizing: "border-box" as const }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
              <button onClick={() => setShowAdd(false)} style={{ padding: "7px 14px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, background: "#FFFFFF", cursor: "pointer" }}>Cancel</button>
              <button onClick={save} disabled={saving}
                style={{ padding: "7px 16px", background: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                {saving ? "Saving..." : "Save Schedule"}
              </button>
            </div>
          </div>
        </div>
      )}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── Revenue Trend Tab ─────────────────────────────────────────────────────────
function RevenueTrendTab({ clientId, jobs }: { clientId: number; jobs: any[] }) {

  // Build monthly revenue from jobs
  const monthly: Record<string, number> = {};
  jobs.filter((j: any) => j.status === "complete").forEach((j: any) => {
    if (!j.scheduled_date) return;
    const d = new Date(j.scheduled_date + "T12:00");
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthly[key] = (monthly[key] || 0) + (parseFloat(j.base_fee) || 0);
  });

  const last12 = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(); d.setMonth(d.getMonth() - (11 - i));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    return { month: d.toLocaleDateString("en-US", { month: "short" }), revenue: monthly[key] || 0 };
  });

  const total = last12.reduce((s, r) => s + r.revenue, 0);
  const avg = total / 12;
  const ltv = total * 1.5; // simple estimate

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* KPI strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "16px 20px" }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#1A1917" }}>${total.toFixed(0)}</div>
          <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2 }}>12-Month Revenue</div>
        </div>
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "16px 20px" }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#1A1917" }}>${avg.toFixed(0)}</div>
          <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2 }}>Avg / Month</div>
        </div>
        <div style={{ backgroundColor: "var(--brand-dim)", border: "1px solid rgba(91,155,213,0.2)", borderRadius: 10, padding: "16px 20px" }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--brand)" }}>${ltv.toFixed(0)}</div>
          <div style={{ fontSize: 11, color: "var(--brand)", marginTop: 2 }}>Est. LTV</div>
        </div>
      </div>

      {/* Chart */}
      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 24px" }}>
        <h4 style={{ margin: "0 0 16px", fontSize: 13, fontWeight: 700, color: "#1A1917" }}>Monthly Revenue (Last 12 Months)</h4>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={last12} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F0EEE9" />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#9E9B94", fontFamily: "'Plus Jakarta Sans', sans-serif" }} />
            <YAxis tick={{ fontSize: 11, fill: "#9E9B94", fontFamily: "'Plus Jakarta Sans', sans-serif" }} />
            <Tooltip formatter={(v: number) => [`$${v.toFixed(2)}`, "Revenue"]} contentStyle={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 12, borderRadius: 6 }} />
            <Bar dataKey="revenue" fill="var(--brand)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}


// ─── Profitability Tab ───────────────────────────────────────────────────────
function ProfitabilityTab({ clientId }: { clientId: number }) {
  const [period, setPeriod] = useState<"monthly" | "quarterly" | "annually">("monthly");

  const { data, isLoading } = useQuery<any>({
    queryKey: ["client-profitability", clientId, period],
    queryFn: () => apiFetch(`/api/clients/${clientId}/profitability?period=${period}`),
    staleTime: 30000,
  });

  if (isLoading || !data) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>
        <Loader2 size={16} style={{ animation: "spin 1s linear infinite", marginRight: 8 }} />
        Loading profitability data...
      </div>
    );
  }

  const {
    revenue, labor_cost: laborCost, supply_cost: supplyCostAmt, overhead, net_profit: netProfit,
    total_jobs: totalJobs, avg_bill: avgBill, ytd_revenue: ytdRevenue,
    labor_pct: laborPct, supply_pct: supplyPct, overhead_pct_of_rev: overheadPctOfRev,
    net_pct: netPct, month_multiplier: mm,
    health_score: healthScore, top_services: topServices, trend_data: trendData,
  } = data;

  const fmtDollar = (v: number) => `$${Math.max(0, v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const fmtDec = (v: number) => `$${(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const periodLabel = period === "monthly" ? "Month" : period === "quarterly" ? "Quarter" : "Year";
  const healthColor = healthScore >= 75 ? "#48BB78" : healthScore >= 50 ? "#F6AD55" : "#E53E3E";
  const showBanner = healthScore < 60 || netPct < 15;

  const SERVICE_LABELS: Record<string, string> = {
    standard_clean: "Standard Clean", deep_clean: "Deep Clean", move_out: "Move Out",
    move_in: "Move In", recurring: "Recurring", post_construction: "Post Construction",
    office_cleaning: "Office Cleaning", common_areas: "Common Areas",
    retail_store: "Retail Store", medical_office: "Medical Office",
    ppm_turnover: "PPM Turnover", post_event: "Post Event",
  };

  const barColor = (key: string) => {
    if (key === "labor") return laborPct > 40 ? "#E53E3E" : laborPct > 35 ? "#F6AD55" : "#48BB78";
    if (key === "net") return netProfit >= 0 ? "#48BB78" : "#E53E3E";
    return "#5B9BD5";
  };

  const r = 42; const circ = 2 * Math.PI * r;
  const dashOffset = circ * (1 - Math.max(0, Math.min(100, healthScore)) / 100);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Rate Increase Banner */}
      {showBanner && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 16px", background: "#FFFBEB", border: "1px solid #F6AD55", borderRadius: 8 }}>
          <AlertTriangle size={15} style={{ color: "#D97706", flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 13, color: "#92400E" }}>
            <strong>This client may be a candidate for a rate increase.</strong>{" "}
            Net profit is {netPct.toFixed(1)}%{healthScore < 60 ? ` and account health is ${healthScore}/100` : ""} — below the healthy threshold of 20%.
          </div>
        </div>
      )}

      {/* KPI Strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        {[
          { label: `${periodLabel} Revenue`, value: fmtDollar(revenue) },
          { label: "YTD Revenue",            value: fmtDollar(ytdRevenue) },
          { label: "Total Jobs",             value: String(totalJobs) },
          { label: "Avg Bill",               value: fmtDec(avgBill) },
        ].map(({ label, value }) => (
          <div key={label} style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "14px 18px" }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#1A1917" }}>{value}</div>
            <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 3 }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Time Filter */}
      <div style={{ display: "flex", gap: 6 }}>
        {(["monthly", "quarterly", "annually"] as const).map(p => (
          <button key={p} onClick={() => setPeriod(p)} style={{
            padding: "6px 16px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer",
            border: "none", background: period === p ? "var(--brand)" : "#F0EEE9",
            color: period === p ? "#fff" : "#6B6860",
          }}>
            {p.charAt(0).toUpperCase() + p.slice(1)}
          </button>
        ))}
      </div>

      {/* Revenue Trend Chart */}
      <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "18px 20px" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 14 }}>Revenue Trend</div>
        {trendData.length === 0 ? (
          <div style={{ textAlign: "center", color: "#9E9B94", fontSize: 13, padding: "28px 0" }}>No completed jobs in this period</div>
        ) : (
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={trendData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#9E9B94" }} />
              <YAxis tick={{ fontSize: 10, fill: "#9E9B94" }} tickFormatter={(v: number) => `$${v}`} width={52} />
              <Tooltip formatter={(v: number) => [`$${v.toFixed(2)}`, "Revenue"]} contentStyle={{ fontSize: 12, borderRadius: 6 }} />
              <Line type="monotone" dataKey="revenue" stroke="#5B9BD5" strokeWidth={2.5} dot={{ r: 3, fill: "#5B9BD5" }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Breakdown + Health Gauge */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 12, alignItems: "start" }}>
        {/* Profitability Breakdown */}
        <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "18px 20px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 16 }}>Profitability Breakdown</div>
          {[
            { key: "revenue",  label: "Revenue",               amount: revenue,       pct: 100,             opacity: 1    },
            { key: "labor",    label: "Labor Cost",            amount: laborCost,     pct: laborPct,        opacity: 1    },
            { key: "supply",   label: "Materials / Supplies",  amount: supplyCostAmt, pct: supplyPct,       opacity: 0.55 },
            { key: "overhead", label: "Overhead Allocation",   amount: overhead,      pct: overheadPctOfRev,opacity: 0.55 },
            { key: "net",      label: "Net Profit",            amount: netProfit,     pct: netPct,          opacity: 1    },
          ].map(row => (
            <div key={row.key} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 11 }}>
              <div style={{ width: 170, fontSize: 12, color: "#374151", flexShrink: 0 }}>{row.label}</div>
              <div style={{ width: 90, fontSize: 12, color: "#1A1917", fontWeight: 600, textAlign: "right" as const, flexShrink: 0 }}>
                {fmtDollar(row.amount * mm)}<span style={{ fontSize: 10, fontWeight: 400, color: "#9E9B94" }}>/mo</span>
              </div>
              <div style={{ width: 38, fontSize: 11, color: "#6B7280", textAlign: "right" as const, flexShrink: 0 }}>
                {row.pct.toFixed(0)}%
              </div>
              <div style={{ flex: 1, background: "#F0EEE9", borderRadius: 3, height: 8, overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 3,
                  width: `${Math.max(0, Math.min(100, Math.abs(row.pct)))}%`,
                  background: barColor(row.key), opacity: row.opacity,
                }} />
              </div>
            </div>
          ))}
        </div>

        {/* Account Health Gauge */}
        <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "18px 16px", textAlign: "center" as const }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 12 }}>Account Health</div>
          <svg width="110" height="110" style={{ display: "block", margin: "0 auto" }}>
            <circle cx="55" cy="55" r={r} fill="none" stroke="#F0EEE9" strokeWidth="11" />
            <circle
              cx="55" cy="55" r={r} fill="none"
              stroke={healthColor} strokeWidth="11"
              strokeDasharray={`${circ}`}
              strokeDashoffset={`${dashOffset}`}
              strokeLinecap="round"
              transform="rotate(-90 55 55)"
              style={{ transition: "stroke-dashoffset 0.6s ease" }}
            />
            <text x="55" y="51" textAnchor="middle" fontSize="22" fontWeight="800" fill="#1A1917" fontFamily="'Plus Jakarta Sans', sans-serif">{healthScore}</text>
            <text x="55" y="68" textAnchor="middle" fontSize="11" fill="#9E9B94" fontFamily="'Plus Jakarta Sans', sans-serif">/100</text>
          </svg>
          <div style={{ marginTop: 8, fontSize: 11, color: "#6B7280" }}>Score</div>
          <div style={{ marginTop: 6, fontSize: 10, fontWeight: 700, color: healthColor, background: `${healthColor}20`, borderRadius: 20, padding: "3px 10px", display: "inline-block" }}>
            {healthScore >= 75 ? "Healthy" : healthScore >= 50 ? "Watch" : "At Risk"}
          </div>
        </div>
      </div>

      {/* Top Services */}
      {topServices.length > 0 && (
        <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "18px 20px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 14 }}>Top Services by Revenue</div>
          {topServices.map((svc: any, i: number) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div style={{ width: 190, fontSize: 12, color: "#374151", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                {SERVICE_LABELS[svc.service_type] || svc.service_type}
              </div>
              <div style={{ flex: 1, background: "#F0EEE9", borderRadius: 3, height: 8 }}>
                <div style={{
                  height: "100%", borderRadius: 3, width: `${svc.pct}%`,
                  background: "#5B9BD5", opacity: Math.max(0.35, 1 - i * 0.18),
                }} />
              </div>
              <div style={{ width: 36, fontSize: 12, fontWeight: 600, color: "#1A1917", textAlign: "right" as const, flexShrink: 0 }}>{svc.pct}%</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Job History helpers ───────────────────────────────────────────────────────
function parseJobNotes(notes: string | null): { duration: string | null; addOn: string | null; tech2: string | null; address: string | null; freq: string | null } {
  if (!notes) return { duration: null, addOn: null, tech2: null, address: null, freq: null };
  const durMatch = notes.match(/^(\d+\.?\d*)h/);
  const addOnMatch = notes.match(/add-on:\s*([^·]+)/);
  const tech2Match = notes.match(/tech 2:\s*([^·]+)/);
  const addrMatch = notes.match(/address:\s*([^·]+)/);
  const freqMatch = notes.match(/freq:\s*([^·]+)/);
  return {
    duration: durMatch ? durMatch[1] : null,
    addOn: addOnMatch ? addOnMatch[1].trim() : null,
    tech2: tech2Match ? tech2Match[1].trim() : null,
    address: addrMatch ? addrMatch[1].trim() : null,
    freq: freqMatch ? freqMatch[1].trim() : null,
  };
}

function makeInitials(name: string | null | undefined): string {
  if (!name) return "?";
  return name.split(" ").filter(Boolean).map(n => n[0]).join("").slice(0, 2).toUpperCase();
}

function TechAvatar({ name, size = 24 }: { name: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", background: "var(--brand-dim)",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0,
    }}>
      <span style={{ fontSize: size * 0.42, fontWeight: 800, color: "var(--brand)", lineHeight: 1 }}>
        {makeInitials(name)}
      </span>
    </div>
  );
}

const FREQ_LABELS: Record<string, string> = {
  weekly: "Weekly", biweekly: "Bi-Weekly", monthly: "Monthly",
  on_demand: "On Demand", every_3_weeks: "Every 3 Weeks",
  custom: "Custom", semi_monthly: "Semi-Monthly",
  // [AI.1] Commercial multi-day frequencies. Surfaced in dropdowns when
  // the client is commercial; hidden for residential clients.
  daily: "Daily", weekdays: "Weekdays (M–F)", custom_days: "Custom days",
};

// [AI.1] Frequency options grouped by audience. Standard always shown;
// Commercial multi-day shown only when client_type='commercial' or the
// schedule belongs to a commercial account (account_id != null).
const FREQ_OPTIONS_STANDARD: Array<{ value: string; label: string }> = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Bi-Weekly" },
  { value: "every_3_weeks", label: "Every 3 Weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "on_demand", label: "On Demand" },
];
const FREQ_OPTIONS_COMMERCIAL_MULTI: Array<{ value: string; label: string }> = [
  { value: "daily", label: "Daily (every day)" },
  { value: "weekdays", label: "Weekdays (M–F)" },
  { value: "custom_days", label: "Custom days" },
];

const SOURCE_LABELS: Record<string, string> = {
  google_lsa: "Google Local Services", google_ads: "Google Ads",
  referral: "Referral", yelp: "Yelp", facebook: "Facebook",
  door_to_door: "Door to Door", repeat: "Repeat Customer", other: "Other",
  client_referral: "Recurring Client", google: "Google", nextdoor: "Nextdoor",
  door_hanger: "Door Hanger", yard_sign: "Yard Sign", website: "Website",
};

const DAY_LABELS: Record<string, string> = {
  monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
  thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday",
};

const FF = "'Plus Jakarta Sans', sans-serif";
const TH_STYLE: React.CSSProperties = { padding: "9px 14px", textAlign: "left", fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #EEECE7" };
const TD_STYLE: React.CSSProperties = { padding: "11px 14px", fontSize: "13px", color: "#1A1917", borderBottom: "1px solid #F0EEE9" };

function DL({ label, value }: { label: string; value?: string | number | null }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, color: "#1A1917", fontWeight: 500, fontFamily: FF }}>{value}</div>
    </div>
  );
}

// ─── Section Jump Nav ─────────────────────────────────────────────────────────
const NAV_PILLS = [
  { id: "sec-service",     label: "Service Details" },
  { id: "sec-billing",     label: "Billing & Payments" },
  { id: "sec-quotes",      label: "Quotes" },
  { id: "sec-agreements",  label: "Agreements" },
  { id: "sec-scorecards",  label: "Scorecards" },
  { id: "sec-contacts",    label: "Contacts & Notifications" },
  { id: "sec-portal",      label: "Client Portal" },
  { id: "sec-tech",        label: "Technician Preferences" },
  { id: "sec-tickets",     label: "Contact Tickets" },
  { id: "sec-inspections", label: "Inspections" },
  { id: "sec-attachments", label: "Attachments" },
  { id: "sec-homeimages",  label: "Home Images" },
] as const;

function VerticalSectionNav({ active, onNavigate, counts }: {
  active: string;
  onNavigate: (id: string) => void;
  counts: Record<string, number | undefined>;
}) {
  return (
    <div style={{ fontFamily: FF }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.08em", padding: "10px 14px 6px" }}>Sections</div>
      {NAV_PILLS.map(({ id, label }) => {
        const isActive = active === id;
        const count = counts[id];
        return (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "8px 14px", border: "none", cursor: "pointer", fontFamily: FF, textAlign: "left" as const,
              background: isActive ? "var(--brand-dim, #E8F5F1)" : "transparent",
              borderLeft: isActive ? "3px solid var(--brand)" : "3px solid transparent",
              transition: "background 120ms, border-color 120ms",
            }}
          >
            <span style={{ fontSize: 12, fontWeight: isActive ? 700 : 500, color: isActive ? "var(--brand)" : "#6B6860" }}>{label}</span>
            {count !== undefined && count > 0 && (
              <span style={{ fontSize: 10, fontWeight: 700, color: isActive ? "var(--brand)" : "#9E9B94", background: isActive ? "var(--brand-dim, #E8F5F1)" : "#EEECE8", borderRadius: 10, padding: "1px 7px" }}>{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Collapsible Section ───────────────────────────────────────────────────────
function CollapsibleSection({ title, sectionId, count, children, defaultOpen = false }: {
  title: string; sectionId?: string; count?: number; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      id={sectionId}
      style={{ borderRadius: 10, border: "1px solid #E5E2DC", overflow: "hidden", marginBottom: 8, borderLeft: open ? "3px solid var(--brand)" : "1px solid #E5E2DC", transition: "border-left 200ms ease" }}
    >
      <button
        onClick={() => setOpen(v => !v)}
        style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 18px", background: "#F7F6F3", border: "none", borderBottom: open ? "1px solid #E5E2DC" : "none", cursor: "pointer", fontFamily: FF }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>{title}</span>
          {count !== undefined && (
            <span style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", background: "#EEECE8", borderRadius: 10, padding: "1px 7px", lineHeight: "16px" }}>{count}</span>
          )}
        </div>
        <ChevronDown size={14} style={{ color: "#9E9B94", transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 200ms ease", flexShrink: 0 }} />
      </button>
      <div style={{ overflow: "hidden", maxHeight: open ? "10000px" : "0px", transition: "max-height 200ms ease", background: "#FFFFFF" }}>
        <div style={{ padding: "20px" }}>{children}</div>
      </div>
    </div>
  );
}

// ─── Profile Hero ──────────────────────────────────────────────────────────────
function ProfileHero({ client, stats, jhStats, recurringSchedule, onSchedule, onMessage, onInvoice, onEdit }: {
  client: any; stats: any; jhStats: any; recurringSchedule: any;
  onSchedule: () => void; onMessage: () => void; onInvoice: () => void; onEdit: () => void;
}) {
  const isRecurring = jhStats?.is_recurring ?? (client.service_type === "recurring" || (client.frequency && client.frequency !== "on_demand"));
  const freqBadge = recurringSchedule?.frequency ? (FREQ_LABELS[recurringSchedule.frequency] || recurringSchedule.frequency) : (client.frequency ? (FREQ_LABELS[client.frequency] || freqLabel(client.frequency)) : null);
  const ltv = jhStats ? jhStats.total_revenue : (stats?.revenue_all_time || 0);
  const lastCleaning = jhStats?.last_cleaning ?? stats?.last_cleaning;
  const nextCleaning = jhStats?.next_cleaning ?? stats?.next_cleaning;
  const initials = `${client.first_name?.[0] || ""}${client.last_name?.[0] || ""}`;

  return (
    <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: "24px 28px", marginBottom: 20, fontFamily: FF }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
        <div style={{ width: 56, height: 56, borderRadius: "50%", background: "var(--brand-dim)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <span style={{ fontSize: 22, fontWeight: 800, color: "var(--brand)" }}>{initials}</span>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: "#0A0E1A", fontFamily: FF }}>
              {client.first_name} {client.last_name}
            </h1>
            <span style={{ fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 4, textTransform: "uppercase" as const, letterSpacing: "0.07em", background: isRecurring ? "#DCFCE7" : "#F3F4F6", color: isRecurring ? "#166534" : "#6B7280" }}>
              {isRecurring ? "Recurring" : "One-Time"}
            </span>
            {freqBadge && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 4, background: "var(--brand-dim)", color: "var(--brand)", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>
                {freqBadge}
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "#9E9B94" }}>CL-{String(client.id).padStart(4, "0")}</span>
            {client.zone_name && (
              <><span style={{ color: "#D0CEC9" }}>·</span>
              <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 4, background: client.zone_color ? `${client.zone_color}22` : "#EDE9FE", color: client.zone_color || "#7C3AED" }}>
                {client.zone_name}
              </span></>
            )}
            {client.company_name && (
              <><span style={{ color: "#D0CEC9" }}>·</span><span style={{ fontSize: 11, color: "#6B7280" }}>{client.company_name}</span></>
            )}
          </div>
        </div>
        <div style={{ background: "#0A0E1A", borderRadius: 10, padding: "12px 20px", textAlign: "center" as const, flexShrink: 0 }}>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#00C9A0", fontFamily: FF }}>${ltv.toLocaleString("en-US", { maximumFractionDigits: 0 })}</div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#9CA3AF", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginTop: 2 }}>Lifetime Value</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 18, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 20 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>Last Cleaning</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", marginTop: 2 }}>{lastCleaning ? fmtDate(lastCleaning) : "Never"}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>Next Cleaning</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: nextCleaning ? "var(--brand)" : "#9E9B94", marginTop: 2 }}>{nextCleaning ? fmtDate(nextCleaning) : "Not scheduled"}</div>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {([
            { label: "Schedule Job", action: onSchedule, primary: true },
            { label: "Send Message", action: onMessage },
            { label: "Create Invoice", action: onInvoice },
            { label: "Edit Profile", action: onEdit },
          ] as { label: string; action: () => void; primary?: boolean }[]).map(({ label, action, primary }) => (
            <button key={label} onClick={action} style={{ padding: "8px 14px", border: primary ? "none" : "1px solid #E5E2DC", borderRadius: 8, background: primary ? "var(--brand)" : "#FFFFFF", color: primary ? "#fff" : "#1A1917", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Client Details Panel (left 25%) ─────────────────────────────────────────
function ClientDetailsPanel({ client, jhStats, recurringSchedule, noCard }: { client: any; jhStats: any; recurringSchedule: any; noCard?: boolean }) {
  const [showAlarm, setShowAlarm] = useState(false);
  const preferredTech = (client.tech_preferences || []).find((p: any) => p.preference === "preferred");

  const outerStyle: React.CSSProperties = noCard
    ? { fontFamily: FF, display: "flex", flexDirection: "column", gap: 14, padding: "16px" }
    : { background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px", fontFamily: FF, display: "flex", flexDirection: "column", gap: 14 };

  return (
    <div style={outerStyle}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>Client Details</div>
      {client.phone && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 2 }}>Phone</div>
          <a href={`tel:${client.phone}`} style={{ color: "var(--brand)", textDecoration: "none", fontWeight: 600, fontSize: 13 }}>{client.phone}</a>
        </div>
      )}
      {client.email && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 2 }}>Email</div>
          <a href={`mailto:${client.email}`} style={{ color: "var(--brand)", textDecoration: "none", fontWeight: 600, fontSize: 13, wordBreak: "break-all" as const }}>{client.email}</a>
        </div>
      )}
      {client.address && <DL label="Service Address" value={formatAddress(client.address, client.city, client.state, client.zip)} />}
      {client.service_type && <DL label="Home / Service Type" value={client.service_type} />}
      {client.home_access_notes && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 2 }}>Entry Instructions</div>
          <div style={{ fontSize: 13, color: "#374151", whiteSpace: "pre-wrap" as const }}>{client.home_access_notes}</div>
        </div>
      )}
      {client.alarm_code && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 2 }}>Alarm Code</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", letterSpacing: showAlarm ? "normal" : "0.15em" }}>{showAlarm ? client.alarm_code : "••••••"}</span>
            <button onClick={() => setShowAlarm(v => !v)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 0, display: "flex" }}>
              {showAlarm ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
        </div>
      )}
      {recurringSchedule?.day_of_week && <DL label="Preferred Day" value={DAY_LABELS[recurringSchedule.day_of_week] || recurringSchedule.day_of_week} />}
      {client.pets && <DL label="Pets / Equipment Notes" value={client.pets} />}
      {preferredTech && <DL label="Preferred Technician" value={`${preferredTech.first_name} ${preferredTech.last_name}`} />}
      {!preferredTech && recurringSchedule?.tech_first && <DL label="Assigned Technician" value={`${recurringSchedule.tech_first} ${recurringSchedule.tech_last}`} />}
      {client.referral_source && <DL label="Acquisition Source" value={SOURCE_LABELS[client.referral_source] || String(client.referral_source).replace(/_/g, " ")} />}
      {client.client_since && <DL label="Customer Since" value={fmtDate(client.client_since)} />}
      {(client.loyalty_points !== null && client.loyalty_points !== undefined && client.loyalty_points > 0) && <DL label="Loyalty Points" value={client.loyalty_points} />}
      {(jhStats?.ecard_pct !== null && jhStats?.ecard_pct !== undefined) && <DL label="eCard Rate" value={`${jhStats.ecard_pct}%`} />}
      {client.zone_name && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 2 }}>Service Zone</div>
          <span style={{ fontSize: 13, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: client.zone_color ? `${client.zone_color}22` : "#EDE9FE", color: client.zone_color || "#7C3AED" }}>{client.zone_name}</span>
        </div>
      )}
      {client.notes && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 2 }}>Internal Notes</div>
          <div style={{ fontSize: 12, color: "#374151", whiteSpace: "pre-wrap" as const }}>{client.notes}</div>
        </div>
      )}
    </div>
  );
}

// ─── Job Detail Slide-Over ─────────────────────────────────────────────────────
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function JobDetailSlideOver({ row, profile, onClose }: { row: any; profile?: any; onClose: () => void }) {
  const { duration, addOn, tech2, address } = parseJobNotes(row.notes);
  const d = new Date(row.job_date + "T12:00");
  const dateStr = `${DAY_NAMES[d.getDay()]}, ${d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;

  // Derive status from notes
  const notesLower = (row.notes || "").toLowerCase();
  const status = notesLower.includes("skip") ? "Skipped" : notesLower.includes("bump") ? "Bumped" : notesLower.includes("cancel") ? "Cancelled" : "Completed";
  const statusColors: Record<string, { bg: string; color: string }> = {
    Completed: { bg: "#DCFCE7", color: "#16A34A" },
    Skipped:   { bg: "#FEF3C7", color: "#D97706" },
    Bumped:    { bg: "#DBEAFE", color: "#2563EB" },
    Cancelled: { bg: "#FEE2E2", color: "#DC2626" },
  };
  const sc = statusColors[status];

  // Linked scorecard (match by job_date prefix)
  const scorecard = (profile?.scorecards || []).find((s: any) => {
    const sd = s.job_date || s.created_at || "";
    return sd.startsWith(row.job_date);
  });

  const Field = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ fontSize: 13, color: "#1A1917", fontWeight: 600 }}>{value}</div>
    </div>
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Inject slide-in keyframe once
  useEffect(() => {
    const id = "jd-slide-kf";
    if (!document.getElementById(id)) {
      const s = document.createElement("style");
      s.id = id;
      s.textContent = `@keyframes jdSlideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }`;
      document.head.appendChild(s);
    }
  }, []);

  return (
    <>
      {/* Overlay */}
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(10,14,26,0.38)", zIndex: 200, cursor: "default" }} />
      {/* Panel */}
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "min(420px, 100vw)", background: "#FFFFFF", zIndex: 201, display: "flex", flexDirection: "column", boxShadow: "-6px 0 32px rgba(0,0,0,0.13)", animation: "jdSlideIn 200ms ease", fontFamily: FF }}>
        {/* Header */}
        <div style={{ padding: "18px 20px 16px", background: "#F7F6F3", borderBottom: "1px solid #E5E2DC", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#0A0E1A", lineHeight: 1.3 }}>{dateStr}</div>
              <div style={{ marginTop: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 20, background: sc.bg, color: sc.color }}>{status}</span>
              </div>
            </div>
            <button onClick={onClose} style={{ background: "none", border: "1px solid #E5E2DC", borderRadius: 6, cursor: "pointer", padding: "5px 7px", display: "flex", color: "#6B6860" }}>
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Technician(s) */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>Technician{tech2 ? "s" : ""}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {row.technician && (
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <TechAvatar name={row.technician} size={32} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{row.technician}</span>
                </div>
              )}
              {tech2 && (
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <TechAvatar name={tech2} size={32} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{tech2}</span>
                </div>
              )}
            </div>
          </div>

          {/* Amount */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 3 }}>Amount Charged</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#0A0E1A" }}>${parseFloat(row.revenue).toFixed(2)}</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {row.service_type && <Field label="Scope" value={row.service_type} />}
            {duration && <Field label="Duration" value={`${duration} hours`} />}
            {addOn && <Field label="Add-On" value={addOn} />}
            {address && <Field label="Service Address" value={address} />}
          </div>

          {/* Linked scorecard */}
          {scorecard && (
            <div style={{ background: "#F7F6F3", borderRadius: 8, padding: "12px 14px", borderLeft: "3px solid var(--brand)" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 6 }}>Scorecard</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: scorecard.score >= 4 ? "#16A34A" : scorecard.score >= 3 ? "#D97706" : "#DC2626" }}>{scorecard.score} / 5</div>
              {scorecard.comments && <div style={{ fontSize: 12, color: "#374151", marginTop: 4 }}>{scorecard.comments}</div>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Job History Panel (center column) ────────────────────────────────────────
function JobHistoryPanel({ clientId: _clientId, jhData, isLoading, profile }: { clientId: number; jhData: any; isLoading: boolean; profile?: any }) {
  const PAGE_SIZE = 10;
  const [page, setPage] = useState(1);
  const [selectedRow, setSelectedRow] = useState<any>(null);
  const [tooltip, setTooltip] = useState<{ row: any; x: number; y: number } | null>(null);
  const tooltipTimer = useRef<any>(null);

  const rows: any[] = jhData?.rows || [];
  const stats = jhData?.stats;
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleMouseEnter = (row: any, e: React.MouseEvent<HTMLTableRowElement>) => {
    const el = e.currentTarget;
    tooltipTimer.current = setTimeout(() => {
      const rect = el.getBoundingClientRect();
      setTooltip({ row, x: rect.left + rect.width / 2, y: rect.top });
    }, 400);
  };
  const handleMouseLeave = () => {
    clearTimeout(tooltipTimer.current);
    setTooltip(null);
  };

  // Column fills its parent cell — no own border/bg
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", fontFamily: FF }}>
        {/* Pinned header */}
        <div style={{ padding: "13px 16px", borderBottom: "1px solid #E5E2DC", flexShrink: 0, background: "#FFFFFF" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>Job History</div>
            {stats && (
              <div style={{ fontSize: 11, color: "#9E9B94" }}>
                <span style={{ fontWeight: 700, color: "#1A1917" }}>{stats.total_visits}</span> visits
                {" · "}
                <span style={{ fontWeight: 700, color: "#1A1917" }}>${stats.total_revenue.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span> total
              </div>
            )}
          </div>
        </div>

        {/* Scrollable body */}
        {isLoading ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#9E9B94", fontSize: 13 }}>Loading...</div>
        ) : rows.length === 0 ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#9E9B94", fontSize: 13 }}>No job history records found</div>
        ) : (
          <div style={{ flex: 1, overflowY: "auto" as const, overflowX: "hidden" as const }}>
            <table style={{ width: "100%", borderCollapse: "collapse" as const, tableLayout: "fixed" as const }}>
              <colgroup>
                <col style={{ width: "72px" }} />
                <col style={{ width: "auto" }} />
                <col style={{ width: "68px" }} />
                <col style={{ width: "64px" }} />
              </colgroup>
              <thead style={{ position: "sticky" as const, top: 0, zIndex: 1, background: "#FAFAF8" }}>
                <tr>
                  {["Date", "Technician(s)", "Dur.", "Amount"].map(h => (
                    <th key={h} style={TH_STYLE}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row: any) => {
                  const { duration, addOn, tech2 } = parseJobNotes(row.notes);
                  const techDisplay = tech2 ? `${row.technician} + ${tech2}` : (row.technician || "—");
                  return (
                    <tr
                      key={row.id}
                      onClick={() => setSelectedRow(row)}
                      onMouseEnter={(e) => handleMouseEnter(row, e)}
                      onMouseLeave={handleMouseLeave}
                      style={{ cursor: "pointer", borderBottom: "1px solid #F0EEE9" }}
                      onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.background = "#F7F6F3"; }}
                      onMouseOut={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                    >
                      <td style={{ ...TD_STYLE, borderBottom: "none", padding: "9px 10px 9px 14px", fontSize: 11, color: "#6B6860", fontWeight: 600, whiteSpace: "nowrap" as const }}>
                        {new Date(row.job_date + "T12:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" })}
                      </td>
                      <td style={{ ...TD_STYLE, borderBottom: "none", padding: "9px 8px", maxWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
                          <TechAvatar name={row.technician} size={20} />
                          <span style={{ fontSize: 11, fontWeight: 600, color: "#1A1917", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }} title={techDisplay}>{techDisplay}</span>
                        </div>
                        {addOn && <div style={{ fontSize: 10, color: "#9E9B94", marginTop: 1, paddingLeft: 26 }}>{addOn}</div>}
                      </td>
                      <td style={{ ...TD_STYLE, borderBottom: "none", padding: "9px 6px", fontSize: 11, color: "#9E9B94", whiteSpace: "nowrap" as const }}>{duration ? `${duration}h` : "—"}</td>
                      <td style={{ ...TD_STYLE, borderBottom: "none", padding: "9px 14px 9px 6px", fontSize: 12, fontWeight: 700, color: "#1A1917", textAlign: "right" as const, whiteSpace: "nowrap" as const }}>${parseFloat(row.revenue).toFixed(0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pinned pagination */}
        <div style={{ borderTop: "1px solid #E5E2DC", padding: "8px 14px", flexShrink: 0, background: "#FAFAF8", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
            style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 9px", border: "1px solid #E5E2DC", borderRadius: 5, background: page === 1 ? "#F3F4F6" : "#FFFFFF", color: page === 1 ? "#9E9B94" : "#1A1917", fontSize: 11, cursor: page === 1 ? "default" : "pointer", fontFamily: FF }}>
            <ChevronLeft size={12} /> Prev
          </button>
          <span style={{ fontSize: 11, color: "#6B7280" }}>
            {rows.length > 0 ? `Page ${page} of ${totalPages}` : "0 records"}
          </span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages || rows.length === 0}
            style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 9px", border: "1px solid #E5E2DC", borderRadius: 5, background: (page === totalPages || rows.length === 0) ? "#F3F4F6" : "#FFFFFF", color: (page === totalPages || rows.length === 0) ? "#9E9B94" : "#1A1917", fontSize: 11, cursor: (page === totalPages || rows.length === 0) ? "default" : "pointer", fontFamily: FF }}>
            Next <ChevronRight size={12} />
          </button>
        </div>
      </div>

      {/* Slide-over */}
      {selectedRow && (
        <JobDetailSlideOver row={selectedRow} profile={profile} onClose={() => setSelectedRow(null)} />
      )}

      {/* Hover tooltip */}
      {tooltip && (() => {
        const { duration, tech2 } = parseJobNotes(tooltip.row.notes);
        const techDisplay = tech2 ? `${tooltip.row.technician} + ${tech2}` : (tooltip.row.technician || "—");
        return (
          <div style={{
            position: "fixed", zIndex: 300,
            top: tooltip.y - 42, left: tooltip.x,
            transform: "translateX(-50%)",
            background: "#1A1917", color: "#FFFFFF",
            fontSize: 11, fontWeight: 500, fontFamily: FF,
            padding: "6px 11px", borderRadius: 6,
            whiteSpace: "nowrap" as const,
            pointerEvents: "none" as const,
            boxShadow: "0 2px 8px rgba(0,0,0,0.22)",
          }}>
            {techDisplay} · {duration ? `${duration}h` : "—"} · ${parseFloat(tooltip.row.revenue).toFixed(0)} · {tooltip.row.service_type || "—"}
            <div style={{ position: "absolute", bottom: -5, left: "50%", transform: "translateX(-50%)", width: 0, height: 0, borderLeft: "5px solid transparent", borderRight: "5px solid transparent", borderTop: "5px solid #1A1917" }} />
          </div>
        );
      })()}
    </>
  );
}

// ─── Client Intelligence Panel (right 25%) ────────────────────────────────────
function ClientIntelligencePanel({ jhStats, profile, noCard }: { jhStats: any; profile: any; noCard?: boolean }) {
  const outerStyle: React.CSSProperties = noCard
    ? { fontFamily: FF, display: "flex", flexDirection: "column", gap: 16, padding: "16px" }
    : { background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px", fontFamily: FF, display: "flex", flexDirection: "column", gap: 16 };

  if (!jhStats) {
    return (
      <div style={outerStyle}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>Intelligence</div>
        <div style={{ fontSize: 13, color: "#9E9B94" }}>No history data</div>
      </div>
    );
  }

  const { total_revenue, total_visits, unique_techs, revenue_last_12mo, avg_bill, revenue_trend_pct, pending_jobs, ecard_pct } = jhStats;
  const techColor = unique_techs >= 6 ? "#DC2626" : unique_techs >= 3 ? "#D97706" : "#16A34A";
  const techBg = unique_techs >= 6 ? "#FEE2E2" : unique_techs >= 3 ? "#FEF3C7" : "#DCFCE7";
  const trendUp = revenue_trend_pct !== null && revenue_trend_pct >= 0;

  const SR = ({ label, value, color }: { label: string; value: string | number; color?: string }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontSize: 12, color: "#6B6860" }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: color || "#1A1917" }}>{value}</span>
    </div>
  );

  return (
    <div style={outerStyle}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>Intelligence</div>
      <div style={{ background: techBg, borderRadius: 8, padding: "14px 16px" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: techColor, textTransform: "uppercase" as const, letterSpacing: "0.07em", marginBottom: 4 }}>Tech Consistency</div>
        <div style={{ fontSize: 20, fontWeight: 900, color: techColor }}>{unique_techs} tech{unique_techs !== 1 ? "s" : ""}</div>
        <div style={{ fontSize: 11, color: techColor, marginTop: 2 }}>
          across {total_visits} visit{total_visits !== 1 ? "s" : ""}
          {total_visits > 0 && unique_techs > 0 && ` · ${((unique_techs / total_visits) * 100).toFixed(0)}% rotation`}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SR label="Lifetime Revenue" value={`$${total_revenue.toLocaleString("en-US", { maximumFractionDigits: 0 })}`} />
        <SR label="Last 12 Months" value={`$${revenue_last_12mo.toLocaleString("en-US", { maximumFractionDigits: 0 })}`} />
        <SR label="Avg Bill (12mo)" value={`$${avg_bill.toFixed(2)}`} />
        <SR label="Total Visits" value={total_visits} />
        {(pending_jobs !== null && pending_jobs !== undefined) && (
          <SR label="Pending Jobs" value={pending_jobs} color={pending_jobs > 0 ? "var(--brand)" : "#1A1917"} />
        )}
        {(revenue_trend_pct !== null && revenue_trend_pct !== undefined) && (
          <SR label="Revenue Trend" value={`${trendUp ? "+" : ""}${revenue_trend_pct.toFixed(0)}% vs prior 6mo`} color={trendUp ? "#16A34A" : "#DC2626"} />
        )}
        <SR label="Skips" value={jhStats.skips ?? 0} color={(jhStats.skips ?? 0) > 0 ? "#DC2626" : "#1A1917"} />
        <SR label="Bumps" value={jhStats.bumps ?? 0} color={(jhStats.bumps ?? 0) > 0 ? "#D97706" : "#1A1917"} />
        {(ecard_pct !== null && ecard_pct !== undefined) && (
          <SR label="eCard Rate" value={`${ecard_pct}%`} color={ecard_pct >= 50 ? "#16A34A" : "#6B7280"} />
        )}
      </div>
      {profile?.stats?.scorecard_avg && (
        <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 6 }}>Avg Scorecard</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: profile.stats.scorecard_avg >= 4 ? "#16A34A" : profile.stats.scorecard_avg >= 3 ? "#D97706" : "#DC2626" }}>
            {profile.stats.scorecard_avg.toFixed(1)} / 5
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Service Details Section ───────────────────────────────────────────────────
function ServiceDetailsSection({ client, onUpdate, refetch, recurringSchedule, onToast }: {
  client: any; onUpdate: (d: any) => Promise<void>; refetch: () => void; recurringSchedule: any; onToast: (m: string, t?: "success" | "error") => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    base_fee: client.base_fee || "",
    frequency: client.frequency || "",
    service_type: client.service_type || "",
    allowed_hours: client.allowed_hours || "",
    home_access_notes: client.home_access_notes || "",
    alarm_code: client.alarm_code || "",
    pets: client.pets || "",
    notes: client.notes || "",
    rec_frequency: recurringSchedule?.frequency || "",
    rec_day: recurringSchedule?.day_of_week || "",
    rec_duration: recurringSchedule?.duration_minutes || "",
    rec_base_fee: recurringSchedule?.base_fee || "",
    rec_service_type: recurringSchedule?.service_type || "",
    rec_notes: recurringSchedule?.notes || "",
    // [AI.6] Parking fee per-occurrence config.
    rec_parking_fee_enabled: !!recurringSchedule?.parking_fee_enabled,
    rec_parking_fee_amount: recurringSchedule?.parking_fee_amount ?? "",
    // Initialize day picker from saved value, or fall back to the schedule's
    // days_of_week so multi-day schedules pre-check all firing days.
    rec_parking_fee_days: (Array.isArray(recurringSchedule?.parking_fee_days) && recurringSchedule.parking_fee_days.length > 0
      ? recurringSchedule.parking_fee_days
      : (recurringSchedule?.days_of_week ?? [])) as number[],
  });

  const save = async () => {
    setSaving(true);
    try {
      await onUpdate({
        base_fee: form.base_fee, frequency: form.frequency, service_type: form.service_type,
        allowed_hours: form.allowed_hours, home_access_notes: form.home_access_notes,
        alarm_code: form.alarm_code, pets: form.pets, notes: form.notes,
      });
      if (recurringSchedule) {
        // [AI.6] Resolve parking_fee_days: only persist a non-null array when
        // (a) the toggle is on AND (b) the frequency is multi-day. Single-day
        // schedules (weekly/biweekly/etc.) leave it null — there's only one
        // weekday firing per occurrence, no choice to make.
        const isMultiDayFreq =
          form.rec_frequency === "daily" ||
          form.rec_frequency === "weekdays" ||
          form.rec_frequency === "custom_days";
        const parkingDaysToSend = form.rec_parking_fee_enabled && isMultiDayFreq
          ? form.rec_parking_fee_days
          : null;
        await apiFetch(`/api/clients/${client.id}/recurring-schedule`, {
          method: "PATCH",
          body: JSON.stringify({
            frequency: form.rec_frequency || undefined, day_of_week: form.rec_day || undefined,
            duration_minutes: form.rec_duration, base_fee: form.rec_base_fee,
            service_type: form.rec_service_type, notes: form.rec_notes,
            parking_fee_enabled: form.rec_parking_fee_enabled,
            parking_fee_amount: form.rec_parking_fee_enabled
              ? (form.rec_parking_fee_amount === "" ? null : form.rec_parking_fee_amount)
              : null,
            parking_fee_days: parkingDaysToSend,
          }),
        });
        qc.invalidateQueries({ queryKey: ["client-recurring", client.id] });
      }
      refetch();
      setEditing(false);
      onToast("Service details saved");
    } catch { onToast("Failed to save changes", "error"); }
    finally { setSaving(false); }
  };

  const upd = (f: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(v => ({ ...v, [f]: e.target.value }));

  const inp: React.CSSProperties = { width: "100%", padding: "7px 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, color: "#1A1917", fontFamily: FF, outline: "none", boxSizing: "border-box", background: "#FFFFFF" };
  const lbl = (t: string) => <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 4 }}>{t}</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* NPS / Churn badges from OverviewTab */}
      {((client.latest_nps_score !== null && client.latest_nps_score !== undefined) || (client.churn_risk_score !== null && client.churn_risk_score !== undefined)) && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const }}>
          {client.latest_nps_score !== null && client.latest_nps_score !== undefined && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", border: "1px solid #E5E2DC", borderRadius: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase" as const }}>NPS</span>
              <span style={{ fontSize: 15, fontWeight: 800, color: client.latest_nps_score >= 9 ? "#16A34A" : client.latest_nps_score >= 7 ? "#D97706" : "#DC2626" }}>{client.latest_nps_score}</span>
            </div>
          )}
          {client.churn_risk_score !== null && client.churn_risk_score !== undefined && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", border: "1px solid #E5E2DC", borderRadius: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase" as const }}>Churn Risk</span>
              <span style={{ fontSize: 15, fontWeight: 800, color: client.churn_risk_score >= 70 ? "#DC2626" : client.churn_risk_score >= 40 ? "#D97706" : "#16A34A" }}>{client.churn_risk_score}%</span>
            </div>
          )}
        </div>
      )}

      {/* Header row with edit toggle */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        {editing ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setEditing(false)} style={{ padding: "7px 14px", border: "1px solid #E5E2DC", borderRadius: 7, background: "#FFFFFF", color: "#6B6860", fontSize: 13, cursor: "pointer", fontFamily: FF }}>Cancel</button>
            <button onClick={save} disabled={saving} style={{ padding: "7px 14px", background: "var(--brand)", border: "none", borderRadius: 7, color: "#FFFFFF", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF, opacity: saving ? 0.6 : 1 }}>{saving ? "Saving..." : "Save"}</button>
          </div>
        ) : (
          <button onClick={() => setEditing(true)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", border: "1px solid #E5E2DC", borderRadius: 7, background: "#FFFFFF", color: "#1A1917", fontSize: 13, cursor: "pointer", fontFamily: FF }}>
            <Edit2 size={13} /> Edit Service Details
          </button>
        )}
      </div>

      {/* Client-level service fields */}
      {editing ? (
        <div style={{ border: "1px solid #E5E2DC", borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.07em" }}>Client Service Settings</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>{lbl("Base Rate ($)")}<input value={form.base_fee} onChange={upd("base_fee")} type="number" min="0" step="0.01" style={inp} /></div>
            <div>{lbl("Allowed Hours")}<input value={form.allowed_hours} onChange={upd("allowed_hours")} type="number" min="0" step="0.5" style={inp} /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              {lbl("Frequency")}
              <select value={form.frequency} onChange={upd("frequency")} style={{ ...inp }}>
                <option value="">Not set</option>
                {Object.entries(FREQ_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>{lbl("Scope / Service Type")}<input value={form.service_type} onChange={upd("service_type")} style={inp} /></div>
          </div>
          <div>{lbl("Entry Instructions")}<textarea value={form.home_access_notes} onChange={upd("home_access_notes")} rows={2} style={{ ...inp, resize: "vertical" as const }} /></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>{lbl("Alarm / Lockbox Code")}<input value={form.alarm_code} onChange={upd("alarm_code")} style={inp} /></div>
            <div>{lbl("Pets / Equipment Notes")}<input value={form.pets} onChange={upd("pets")} style={inp} /></div>
          </div>
          <div>{lbl("Internal Notes")}<textarea value={form.notes} onChange={upd("notes")} rows={2} style={{ ...inp, resize: "vertical" as const }} /></div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
          {client.base_fee && <DL label="Base Rate" value={fmtCurrency(client.base_fee)} />}
          {client.frequency && <DL label="Frequency" value={FREQ_LABELS[client.frequency] || client.frequency} />}
          {client.service_type && <DL label="Scope" value={client.service_type} />}
          {client.allowed_hours && <DL label="Allowed Hours" value={`${client.allowed_hours} hrs`} />}
          {client.home_access_notes && <DL label="Entry Instructions" value={client.home_access_notes} />}
          {client.alarm_code && <DL label="Alarm Code" value="••••••" />}
          {client.pets && <DL label="Pets / Equipment" value={client.pets} />}
          {client.notes && <DL label="Notes" value={client.notes} />}
        </div>
      )}

      {/* Recurring Schedule */}
      {recurringSchedule && (
        <div style={{ border: "1px solid #E5E2DC", borderRadius: 10, padding: 16 }}>
          {editing ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginBottom: 4 }}>Recurring Schedule</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  {lbl("Frequency")}
                  {/* [AI.1] Grouped via <optgroup>. Commercial multi-day options
                      (daily/weekdays/custom_days) only shown when client is
                      commercial OR linked to an account. Defensive against
                      MC-import client_type drift — same broadening as the
                      job edit modal. */}
                  <select value={form.rec_frequency} onChange={upd("rec_frequency")} style={{ ...inp }}>
                    <option value="">Not set</option>
                    <optgroup label="Standard">
                      {FREQ_OPTIONS_STANDARD.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </optgroup>
                    {(client.client_type === "commercial" || client.account_id != null) && (
                      <optgroup label="Commercial multi-day">
                        {FREQ_OPTIONS_COMMERCIAL_MULTI.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </optgroup>
                    )}
                  </select>
                </div>
                <div>
                  {lbl("Day of Week")}
                  <select value={form.rec_day} onChange={upd("rec_day")} style={{ ...inp }}>
                    <option value="">Not set</option>
                    {Object.entries(DAY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>{lbl("Duration (min)")}<input value={form.rec_duration} onChange={upd("rec_duration")} type="number" min="0" style={inp} /></div>
                <div>{lbl("Schedule Rate ($)")}<input value={form.rec_base_fee} onChange={upd("rec_base_fee")} type="number" min="0" step="0.01" style={inp} /></div>
              </div>
              <div>{lbl("Scope")}<input value={form.rec_service_type} onChange={upd("rec_service_type")} style={inp} /></div>

              {/* [AI.6] Parking Fee subsection. Toggle + amount + (multi-day only) day picker.
                  Day picker uses 0=Sun..6=Sat to match recurring_schedules.days_of_week. */}
              <div style={{ marginTop: 4, padding: 14, border: "1px solid #E5E2DC", borderRadius: 10, backgroundColor: "#FBFAF7" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontFamily: FF }}>
                  <input
                    type="checkbox"
                    checked={form.rec_parking_fee_enabled}
                    onChange={e => setForm(f => ({ ...f, rec_parking_fee_enabled: e.target.checked }))}
                    style={{ width: 18, height: 18, cursor: "pointer" }}
                  />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>
                    Charge parking fee for this schedule
                  </span>
                </label>

                {form.rec_parking_fee_enabled && (
                  <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
                    <div>
                      {lbl("Amount")}
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 13, color: "#6B6860", fontFamily: FF }}>$</span>
                        <input
                          type="number" min={0} step="0.01"
                          inputMode="decimal"
                          placeholder="20.00"
                          value={form.rec_parking_fee_amount}
                          onChange={e => setForm(f => ({ ...f, rec_parking_fee_amount: e.target.value }))}
                          style={{ ...inp, width: 140 }}
                        />
                        <span style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>
                          (blank = use tenant default)
                        </span>
                      </div>
                    </div>

                    {/* Day picker only for multi-day frequencies. Single-day
                        schedules (weekly/biweekly/etc.) fire on exactly one
                        weekday per occurrence — no choice to make. */}
                    {(form.rec_frequency === "daily" || form.rec_frequency === "weekdays" || form.rec_frequency === "custom_days") && (
                      <div>
                        {lbl("Apply to days")}
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                          {[
                            { v: 0, label: "Sun" }, { v: 1, label: "Mon" }, { v: 2, label: "Tue" },
                            { v: 3, label: "Wed" }, { v: 4, label: "Thu" }, { v: 5, label: "Fri" },
                            { v: 6, label: "Sat" },
                          ].map(d => {
                            const checked = form.rec_parking_fee_days.includes(d.v);
                            return (
                              <label key={d.v}
                                style={{
                                  display: "inline-flex", alignItems: "center", gap: 5,
                                  padding: "6px 10px", borderRadius: 6,
                                  border: `1.5px solid ${checked ? "#2D9B83" : "#E5E2DC"}`,
                                  backgroundColor: checked ? "rgba(45,155,131,0.07)" : "#FFFFFF",
                                  fontSize: 12, fontFamily: FF, cursor: "pointer",
                                  color: checked ? "#2D9B83" : "#1A1917",
                                  fontWeight: checked ? 700 : 500,
                                  minHeight: 32,
                                }}>
                                <input type="checkbox" checked={checked}
                                  onChange={() => setForm(f => ({
                                    ...f,
                                    rec_parking_fee_days: f.rec_parking_fee_days.includes(d.v)
                                      ? f.rec_parking_fee_days.filter((n: number) => n !== d.v)
                                      : [...f.rec_parking_fee_days, d.v].sort(),
                                  }))} />
                                {d.label}
                              </label>
                            );
                          })}
                        </div>
                        <p style={{ margin: "6px 0 0", fontSize: 11, color: "#6B6860", fontFamily: FF }}>
                          Defaults to all days the schedule fires on. Uncheck a day to mark it as free parking.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
              {(recurringSchedule.frequency || recurringSchedule.day_of_week) && (
                <DL label="Schedule" value={[
                  FREQ_LABELS[recurringSchedule.frequency] || recurringSchedule.frequency,
                  recurringSchedule.day_of_week ? `${DAY_LABELS[recurringSchedule.day_of_week] || recurringSchedule.day_of_week}s` : null,
                ].filter(Boolean).join(" — ")} />
              )}
              <DL label="Start Date" value={fmtDate(recurringSchedule.start_date)} />
              {recurringSchedule.base_fee && <DL label="Rate" value={fmtCurrency(recurringSchedule.base_fee)} />}
              {recurringSchedule.duration_minutes && (
                <DL label="Duration" value={`${Math.round(recurringSchedule.duration_minutes / 60 * 10) / 10} hrs`} />
              )}
              {(recurringSchedule.tech_first || recurringSchedule.tech_last) && (
                <DL label="Technician" value={[recurringSchedule.tech_first, recurringSchedule.tech_last].filter(Boolean).join(" ")} />
              )}
              {/* [AI.6] Read-only parking fee summary. */}
              {recurringSchedule.parking_fee_enabled && (
                <DL label="Parking Fee" value={(() => {
                  const amt = recurringSchedule.parking_fee_amount != null
                    ? fmtCurrency(recurringSchedule.parking_fee_amount)
                    : "tenant default";
                  const days = Array.isArray(recurringSchedule.parking_fee_days) && recurringSchedule.parking_fee_days.length > 0
                    ? recurringSchedule.parking_fee_days
                        .map((n: number) => ({ 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" }[n] ?? n))
                        .join("/")
                    : "all days";
                  return `${amt} · ${days}`;
                })()} />
              )}
            </div>
          )}
        </div>
      )}

      {/* Rate History */}
      <div style={{ border: "1px solid #E5E2DC", borderRadius: 10, padding: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginBottom: 8 }}>Rate History</div>
        <div style={{ fontSize: 13, color: "#9E9B94" }}>
          {client.rate_increase_last_date
            ? `Last increase: ${fmtDate(client.rate_increase_last_date)}${client.rate_increase_last_pct ? ` · ${client.rate_increase_last_pct}%` : ""}`
            : "No rate changes recorded"}
        </div>
      </div>
    </div>
  );
}

// ─── Billing Section ──────────────────────────────────────────────────────────
function BillingSection({ client, invoices, refetch }: { client: any; invoices: any[]; refetch: () => void }) {
  const outstanding = invoices.filter(i => !i.paid_at && i.status !== "draft").reduce((s: number, i: any) => s + parseFloat(i.total || "0"), 0);
  const totalPaid = invoices.filter(i => i.paid_at).reduce((s: number, i: any) => s + parseFloat(i.total || "0"), 0);
  const cardOnFile = client.card_last_four ? `•••• ${client.card_last_four}` : (client.default_card_last_4 ? `•••• ${client.default_card_last_4}` : null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Compact summary row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ background: "#F7F6F3", borderRadius: 8, padding: "10px 14px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 3 }}>Payment Method</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: cardOnFile ? "#1A1917" : "#9E9B94" }}>{cardOnFile || "None on file"}</div>
        </div>
        <div style={{ background: "#F7F6F3", borderRadius: 8, padding: "10px 14px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 3 }}>Total Paid (All Time)</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917" }}>{fmtCurrency(totalPaid)}</div>
        </div>
      </div>
      {outstanding > 0 && (
        <div style={{ padding: "10px 14px", background: "#FEF3C7", borderRadius: 8, fontSize: 12, color: "#92400E", fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
          <CreditCard size={14} />
          Outstanding balance: ${outstanding.toFixed(2)}
        </div>
      )}
      <CardOnFileTab client={client} refetch={refetch} />
      <BillingTab invoices={invoices} />
      <PaymentsTab clientId={client.id} client={client} />
      <QuickBooksTab clientId={client.id} client={client} refetch={refetch} />
    </div>
  );
}

// ─── Contact Tickets Section ──────────────────────────────────────────────────
function ContactTicketsSection({ clientId }: { clientId: number }) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ticket_type: "skip", notes: "" });

  const { data: tickets = [], isLoading, refetch } = useQuery<any[]>({
    queryKey: ["client-tickets", clientId],
    queryFn: () => apiFetch(`/api/clients/${clientId}/contact-tickets`),
    staleTime: 30000,
  });

  const createMut = useMutation({
    mutationFn: (d: any) => apiFetch(`/api/clients/${clientId}/contact-tickets`, { method: "POST", body: JSON.stringify(d) }),
    onSuccess: () => { refetch(); setShowForm(false); setForm({ ticket_type: "skip", notes: "" }); qc.invalidateQueries({ queryKey: ["client-tickets", clientId] }); },
  });

  const TICKET_LABELS: Record<string, string> = {
    skip: "Skip", complaint: "Complaint", compliment: "Compliment",
    schedule_change: "Schedule Change", cancellation: "Cancellation", breakage: "Breakage",
  };

  const TICKET_COLORS: Record<string, { background: string; color: string }> = {
    skip: { background: "#FEF3C7", color: "#92400E" },
    complaint: { background: "#FEE2E2", color: "#991B1B" },
    compliment: { background: "#DCFCE7", color: "#166534" },
    schedule_change: { background: "#EDE9FE", color: "#5B21B6" },
    cancellation: { background: "#FEE2E2", color: "#991B1B" },
    breakage: { background: "#FEF3C7", color: "#92400E" },
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={() => setShowForm(v => !v)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", background: "var(--brand)", border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
          <Plus size={13} /> Create New Ticket
        </button>
      </div>
      {showForm && (
        <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", marginBottom: 14 }}>New Contact Ticket</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 4 }}>Ticket Type</label>
              <select value={form.ticket_type} onChange={e => setForm(f => ({ ...f, ticket_type: e.target.value }))} style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 13, outline: "none", background: "#FFFFFF", fontFamily: FF }}>
                {Object.entries(TICKET_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 4 }}>Notes</label>
              <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 13, outline: "none", resize: "vertical" as const, boxSizing: "border-box" as const, fontFamily: FF }} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setShowForm(false)} style={{ padding: "8px 14px", border: "1px solid #E5E2DC", borderRadius: 7, background: "#FFFFFF", color: "#6B7280", fontSize: 13, cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button onClick={() => createMut.mutate(form)} disabled={createMut.isPending} style={{ padding: "8px 14px", background: "var(--brand)", border: "none", borderRadius: 7, color: "#FFFFFF", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                {createMut.isPending ? "Saving..." : "Save Ticket"}
              </button>
            </div>
          </div>
        </div>
      )}
      {isLoading ? (
        <div style={{ textAlign: "center" as const, color: "#9E9B94", fontSize: 13, padding: "24px 0" }}>Loading tickets...</div>
      ) : (
        <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" as const }}>
            <thead>
              <tr style={{ background: "#FAFAF8" }}>
                {["Created", "Type", "Job ID", "Notes", "Created By"].map(h => <th key={h} style={TH_STYLE}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {tickets.length === 0 ? (
                <tr><td colSpan={5} style={{ padding: "14px 16px", textAlign: "left" as const, color: "#9E9B94", fontSize: 13 }}>No tickets yet</td></tr>
              ) : tickets.map((t: any) => {
                const tc = TICKET_COLORS[t.ticket_type] || { background: "#F3F4F6", color: "#6B7280" };
                return (
                  <tr key={t.id}>
                    <td style={TD_STYLE}>{fmtDate(t.created_at)}</td>
                    <td style={TD_STYLE}>
                      <span style={{ ...tc, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.04em" }}>
                        {TICKET_LABELS[t.ticket_type] || t.ticket_type}
                      </span>
                    </td>
                    <td style={{ ...TD_STYLE, color: "#6B7280" }}>{t.job_id ? `#${t.job_id}` : "—"}</td>
                    <td style={{ ...TD_STYLE, fontSize: 12, color: "#374151", maxWidth: 240 }}>{t.notes || "—"}</td>
                    <td style={{ ...TD_STYLE, fontSize: 12, color: "#6B7280" }}>{t.created_by_first ? `${t.created_by_first} ${t.created_by_last}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Inspections Section ──────────────────────────────────────────────────────
function InspectionsSection() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", background: "var(--brand)", border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
          <Plus size={13} /> Create New Inspection
        </button>
      </div>
      <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" as const }}>
          <thead>
            <tr style={{ background: "#FAFAF8" }}>
              {["Date", "Inspector", "Score", "Result", "Notes"].map(h => <th key={h} style={TH_STYLE}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            <tr><td colSpan={5} style={{ padding: "14px 16px", textAlign: "left" as const, color: "#9E9B94", fontSize: 13 }}>No inspections on record</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Attachments Section ──────────────────────────────────────────────────────
function AttachmentsSection({ clientId }: { clientId: number }) {
  return <AttachmentsTab clientId={clientId} />;
}

// ─── Home Images Section ──────────────────────────────────────────────────────
function HomeImagesSection({ clientId }: { clientId: number }) {
  const { data: photos = [], isLoading } = useQuery<any[]>({
    queryKey: ["client-job-photos", clientId],
    queryFn: () => apiFetch(`/api/clients/${clientId}/job-photos`),
    staleTime: 60000,
  });

  const byJob = photos.reduce((acc: Record<number, any[]>, p: any) => {
    if (!acc[p.job_id]) acc[p.job_id] = [];
    acc[p.job_id].push(p);
    return acc;
  }, {});

  const jobGroups = Object.entries(byJob).map(([jobId, rows]: [string, any[]]) => ({
    jobId: parseInt(jobId),
    jobDate: rows[0]?.job_date,
    serviceType: rows[0]?.service_type,
    techName: rows[0]?.tech_first ? `${rows[0].tech_first} ${rows[0].tech_last || ""}`.trim() : null,
    photos: rows,
  })).sort((a, b) => (b.jobDate || "").localeCompare(a.jobDate || ""));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", background: "var(--brand)", border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF, opacity: 0.5 }} title="Photo uploads are taken by technicians during jobs">
          <Upload size={13} /> Upload Photo
        </button>
      </div>
      {isLoading ? (
        <div style={{ textAlign: "center" as const, color: "#9E9B94", fontSize: 13, padding: 24 }}>Loading...</div>
      ) : jobGroups.length === 0 ? (
        <div style={{ fontSize: 13, color: "#9E9B94", padding: "6px 0" }}>No job photos on record. Photos are added by technicians from the mobile app during service visits.</div>
      ) : (
        jobGroups.map(group => (
          <div key={group.jobId} style={{ border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ background: "#F7F6F3", padding: "10px 16px", display: "flex", alignItems: "center", gap: 14, borderBottom: "1px solid #E5E2DC" }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917" }}>{fmtDate(group.jobDate)}{group.serviceType ? ` · ${group.serviceType}` : ""}</div>
                {group.techName && <div style={{ fontSize: 11, color: "#6B6860", marginTop: 2 }}>{group.techName}</div>}
              </div>
              <a href={`/jobs/${group.jobId}`} style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, color: "var(--brand)", textDecoration: "none" }}>Job #{group.jobId}</a>
            </div>
            <div style={{ padding: 12, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10 }}>
              {group.photos.map((p: any) => (
                <div key={p.photo_id} style={{ border: "1px solid #E5E2DC", borderRadius: 7, overflow: "hidden", position: "relative" }}>
                  <img src={p.url} alt={`Job ${group.jobId} photo`} style={{ width: "100%", height: 110, objectFit: "cover" as const, display: "block" }} />
                  {p.photo_type && (
                    <div style={{ position: "absolute", top: 6, left: 6, fontSize: 9, fontWeight: 700, textTransform: "uppercase" as const, background: p.photo_type === "before" ? "#FEF3C7" : "#DCFCE7", color: p.photo_type === "before" ? "#92400E" : "#166534", padding: "2px 6px", borderRadius: 4 }}>{p.photo_type}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ─── Loyalty Program Card ──────────────────────────────────────────────────────
function LoyaltyProgramCard({ clientId, loyaltyRecord, loyaltyTiers, loyaltyStats, effectiveTierName, loyaltyTierBadge, refetch, showToast }: {
  clientId: number;
  loyaltyRecord: any;
  loyaltyTiers: any[];
  loyaltyStats: any;
  effectiveTierName: string;
  loyaltyTierBadge: (name: string) => { bg: string; color: string };
  refetch: () => void;
  showToast: (msg: string, type?: "success" | "error") => void;
}) {
  const [showAddPoints, setShowAddPoints] = useState(false);
  const [showSetTier, setShowSetTier] = useState(false);
  const [pointsInput, setPointsInput] = useState("");
  const [reasonInput, setReasonInput] = useState("");
  const [tierInput, setTierInput] = useState("");
  const [notes, setNotes] = useState(loyaltyRecord?.notes || "");
  const [saving, setSaving] = useState(false);

  const CS2: React.CSSProperties = { background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: "18px 20px", marginBottom: 14 };
  const FF = "'Plus Jakarta Sans', sans-serif";
  const pointsBalance = loyaltyRecord?.points_balance || 0;
  const totalEarned = loyaltyRecord?.total_points_earned || 0;
  const visits = Number(loyaltyStats?.total_visits || 0);
  const rev = Number(loyaltyStats?.lifetime_revenue || 0);

  const nextTier = (() => {
    if (!loyaltyTiers.length) return null;
    for (const t of loyaltyTiers) {
      if (visits < (t.min_visits || 0) || rev < (t.min_lifetime_revenue || 0)) return t;
    }
    return null;
  })();
  const progressPct = nextTier ? Math.min(100, Math.round((visits / (nextTier.min_visits || 1)) * 100)) : 100;

  async function handleAddPoints() {
    if (!pointsInput || isNaN(parseInt(pointsInput))) return;
    setSaving(true);
    try {
      await apiFetch(`/api/clients/${clientId}/loyalty/points`, { method: "POST", body: JSON.stringify({ points: parseInt(pointsInput), reason: reasonInput }) });
      showToast(`${pointsInput} points added`);
      setShowAddPoints(false);
      setPointsInput(""); setReasonInput("");
      refetch();
    } catch { showToast("Failed to add points", "error"); }
    finally { setSaving(false); }
  }

  async function handleSetTier() {
    setSaving(true);
    try {
      await apiFetch(`/api/clients/${clientId}/loyalty`, { method: "PATCH", body: JSON.stringify({ tier_override: tierInput || null }) });
      showToast("Tier updated");
      setShowSetTier(false);
      refetch();
    } catch { showToast("Failed to update tier", "error"); }
    finally { setSaving(false); }
  }

  async function handleSaveNotes() {
    try {
      await apiFetch(`/api/clients/${clientId}/loyalty`, { method: "PATCH", body: JSON.stringify({ tier_override: loyaltyRecord?.tier_override || null, notes }) });
    } catch { /* silent */ }
  }

  return (
    <div style={CS2}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 14 }}>Loyalty Program</div>

      {/* Tier row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: "#6B6860" }}>Current Tier</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {effectiveTierName ? (
            <span style={{ fontSize: 12, fontWeight: 700, borderRadius: 4, padding: "3px 8px", background: loyaltyTierBadge(effectiveTierName).bg, color: loyaltyTierBadge(effectiveTierName).color }}>
              {effectiveTierName}
            </span>
          ) : (
            <span style={{ fontSize: 12, fontWeight: 700, borderRadius: 4, padding: "3px 8px", background: "#E5E2DC", color: "#6B6860" }}>No Tier</span>
          )}
          {loyaltyRecord?.tier_override && <span style={{ fontSize: 10, color: "#9E9B94" }}>Set Manually</span>}
        </div>
      </div>

      {/* Points row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, padding: "8px 0", borderTop: "1px solid #F0EEE9", borderBottom: "1px solid #F0EEE9" }}>
        <span style={{ fontSize: 12, color: "#6B6860" }}>Points Balance: <strong style={{ color: "#1A1917" }}>{pointsBalance} pts</strong></span>
        <span style={{ fontSize: 12, color: "#6B6860" }}>Total Earned: <strong style={{ color: "#1A1917" }}>{totalEarned} pts</strong></span>
      </div>

      {/* Progress bar */}
      {loyaltyTiers.length > 0 ? (
        nextTier ? (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: "#6B6860", marginBottom: 4 }}>
              {visits} of {nextTier.min_visits} visits to {nextTier.tier_name}
            </div>
            <div style={{ height: 6, background: "#F0EEE9", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${progressPct}%`, background: "var(--brand)", borderRadius: 3, transition: "width 0.4s" }} />
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 11, color: "#16A34A", fontWeight: 600, marginBottom: 12 }}>Top Tier</div>
        )
      ) : (
        <div style={{ fontSize: 11, color: "#9E9B94", marginBottom: 12 }}>
          No loyalty tiers configured yet. Set up tiers in Company Settings.
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => setShowAddPoints(true)} style={{ fontSize: 12, fontWeight: 600, color: "var(--brand)", background: "none", border: "1px solid var(--brand)", borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontFamily: FF }}>
          + Add Points
        </button>
        <button onClick={() => { setTierInput(loyaltyRecord?.tier_override || ""); setShowSetTier(true); }} style={{ fontSize: 12, fontWeight: 600, color: "#6B6860", background: "none", border: "1px solid #E5E2DC", borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontFamily: FF }}>
          Set Tier Manually
        </button>
      </div>

      {/* Notes */}
      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        onBlur={handleSaveNotes}
        placeholder="Loyalty notes..."
        style={{ width: "100%", resize: "vertical" as const, minHeight: 60, border: "1px solid #E5E2DC", borderRadius: 6, padding: "8px 10px", fontSize: 12, fontFamily: FF, color: "#1A1917", background: "#FAFAF8", boxSizing: "border-box" as const }}
      />

      {/* Add Points Modal */}
      {showAddPoints && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#FFFFFF", borderRadius: 12, padding: 24, width: 360, fontFamily: FF }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Add Points</div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Points</label>
              <input type="number" value={pointsInput} onChange={e => setPointsInput(e.target.value)} style={{ width: "100%", border: "1px solid #E5E2DC", borderRadius: 6, padding: "8px 10px", fontSize: 13, fontFamily: FF, boxSizing: "border-box" as const }} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Reason</label>
              <input type="text" value={reasonInput} onChange={e => setReasonInput(e.target.value)} style={{ width: "100%", border: "1px solid #E5E2DC", borderRadius: 6, padding: "8px 10px", fontSize: 13, fontFamily: FF, boxSizing: "border-box" as const }} />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setShowAddPoints(false)} style={{ padding: "8px 14px", fontSize: 13, border: "1px solid #E5E2DC", borderRadius: 6, background: "#FFFFFF", cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button onClick={handleAddPoints} disabled={saving} style={{ padding: "8px 14px", fontSize: 13, background: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: FF, fontWeight: 600 }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Set Tier Modal */}
      {showSetTier && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#FFFFFF", borderRadius: 12, padding: 24, width: 360, fontFamily: FF }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Set Tier Manually</div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Tier</label>
              <select value={tierInput} onChange={e => setTierInput(e.target.value)} style={{ width: "100%", border: "1px solid #E5E2DC", borderRadius: 6, padding: "8px 10px", fontSize: 13, fontFamily: FF, background: "#FFFFFF", boxSizing: "border-box" as const }}>
                <option value="">— Remove Override —</option>
                {loyaltyTiers.map((t: any) => <option key={t.id} value={t.tier_name}>{t.tier_name}</option>)}
                {!loyaltyTiers.length && ["Bronze", "Silver", "Gold"].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setShowSetTier(false)} style={{ padding: "8px 14px", fontSize: 13, border: "1px solid #E5E2DC", borderRadius: 6, background: "#FFFFFF", cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button onClick={handleSetTier} disabled={saving} style={{ padding: "8px 14px", fontSize: 13, background: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: FF, fontWeight: 600 }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Referrals Card ────────────────────────────────────────────────────────────
function ReferralsCard({ clientId, referrals, refetch, showToast }: {
  clientId: number;
  referrals: any[];
  refetch: () => void;
  showToast: (msg: string, type?: "success" | "error") => void;
}) {
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ referred_name: "", referred_phone: "", referred_email: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const FF = "'Plus Jakarta Sans', sans-serif";
  const CS2: React.CSSProperties = { background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: "18px 20px", marginBottom: 14 };

  const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
    pending:     { bg: "#FEF3C7", color: "#D97706" },
    booked:      { bg: "#DBEAFE", color: "#2563EB" },
    completed:   { bg: "#DCFCE7", color: "#16A34A" },
    reward_paid: { bg: "#EDE9FE", color: "#7C3AED" },
    declined:    { bg: "#FEE2E2", color: "#DC2626" },
  };

  async function handleCreate() {
    if (!form.referred_name.trim()) return;
    setSaving(true);
    try {
      await apiFetch(`/api/clients/${clientId}/referrals`, { method: "POST", body: JSON.stringify(form) });
      showToast("Referral logged");
      setShowModal(false);
      setForm({ referred_name: "", referred_phone: "", referred_email: "", notes: "" });
      refetch();
    } catch { showToast("Failed to save referral", "error"); }
    finally { setSaving(false); }
  }

  async function handleStatusChange(id: number, status: string) {
    try {
      await apiFetch(`/api/referrals/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      refetch();
    } catch { showToast("Failed to update status", "error"); }
  }

  async function handleRewardPaid(id: number) {
    try {
      await apiFetch(`/api/referrals/${id}`, { method: "PATCH", body: JSON.stringify({ status: "reward_paid", reward_issued: true }) });
      refetch();
    } catch { showToast("Failed to mark reward paid", "error"); }
  }

  return (
    <div style={CS2}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>Referrals</span>
          {referrals.length > 0 && <span style={{ fontSize: 11, fontWeight: 700, background: "#E5E2DC", color: "#6B6860", borderRadius: 10, padding: "1px 7px" }}>{referrals.length}</span>}
        </div>
        <button onClick={() => setShowModal(true)} style={{ fontSize: 12, fontWeight: 600, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: FF }}>
          + Log Referral
        </button>
      </div>

      {referrals.length === 0 ? (
        <div style={{ fontSize: 12, color: "#9E9B94", textAlign: "center" as const, padding: "16px 0" }}>
          No referrals on record.<br />
          <span style={{ fontSize: 11 }}>Referrals submitted through the client portal appear here automatically.</span>
        </div>
      ) : (
        <div style={{ overflowX: "auto" as const }}>
          <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #E5E2DC" }}>
                {["Name", "Phone", "Date", "Source", "Status", "Actions"].map(h => (
                  <th key={h} style={{ padding: "4px 8px 8px", textAlign: "left" as const, fontWeight: 600, color: "#6B6860", fontSize: 11 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {referrals.map((r: any) => {
                const sc = STATUS_COLORS[r.status] || { bg: "#E5E2DC", color: "#6B6860" };
                const srcBadge = r.source === "portal" ? { bg: "var(--brand)", color: "#FFFFFF" } : { bg: "#E5E2DC", color: "#6B6860" };
                return (
                  <tr key={r.id} style={{ borderBottom: "1px solid #F0EEE9" }}>
                    <td style={{ padding: "6px 8px", fontWeight: 600, color: "#1A1917" }}>{r.referred_name}</td>
                    <td style={{ padding: "6px 8px", color: "#6B6860" }}>{r.referred_phone || "—"}</td>
                    <td style={{ padding: "6px 8px", color: "#6B6860" }}>{r.created_at ? new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}</td>
                    <td style={{ padding: "6px 8px" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "2px 6px", background: srcBadge.bg, color: srcBadge.color, textTransform: "capitalize" as const }}>
                        {r.source || "manual"}
                      </span>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "2px 6px", background: sc.bg, color: sc.color, textTransform: "capitalize" as const }}>
                        {(r.status || "pending").replace("_", " ")}
                      </span>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <select
                          value={r.status || "pending"}
                          onChange={e => handleStatusChange(r.id, e.target.value)}
                          style={{ fontSize: 11, border: "1px solid #E5E2DC", borderRadius: 4, padding: "2px 4px", background: "#FFFFFF", fontFamily: FF, cursor: "pointer" }}
                        >
                          {["pending", "booked", "completed", "reward_paid", "declined"].map(s => (
                            <option key={s} value={s}>{s.replace("_", " ")}</option>
                          ))}
                        </select>
                        {r.status === "completed" && !r.reward_issued && (
                          <button
                            onClick={() => handleRewardPaid(r.id)}
                            style={{ fontSize: 10, fontWeight: 600, color: "#7C3AED", background: "#EDE9FE", border: "none", borderRadius: 4, padding: "2px 6px", cursor: "pointer", fontFamily: FF, whiteSpace: "nowrap" as const }}
                          >Mark Reward Paid</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Log Referral Modal */}
      {showModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#FFFFFF", borderRadius: 12, padding: 24, width: 420, fontFamily: FF }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Log Referral</div>
            {[
              { label: "Referred Name *", key: "referred_name", type: "text" },
              { label: "Phone", key: "referred_phone", type: "tel" },
              { label: "Email", key: "referred_email", type: "email" },
              { label: "Notes", key: "notes", type: "text" },
            ].map(f => (
              <div key={f.key} style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>{f.label}</label>
                <input
                  type={f.type}
                  value={(form as any)[f.key]}
                  onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                  style={{ width: "100%", border: "1px solid #E5E2DC", borderRadius: 6, padding: "8px 10px", fontSize: 13, fontFamily: FF, boxSizing: "border-box" as const }}
                />
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setShowModal(false)} style={{ padding: "8px 14px", fontSize: 13, border: "1px solid #E5E2DC", borderRadius: 6, background: "#FFFFFF", cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button onClick={handleCreate} disabled={saving || !form.referred_name.trim()} style={{ padding: "8px 14px", fontSize: 13, background: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: FF, fontWeight: 600 }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Job Calendar ──────────────────────────────────────────────────────────────
const STATUS_CHIP: Record<string, { bg: string; border: string; text: string; label: string; tooltip: string }> = {
  scheduled:  { bg: "#DBEAFE", border: "#3B82F6", text: "#1D4ED8", label: "Book",  tooltip: "Booked — Service appointment scheduled" },
  complete:   { bg: "#DCFCE7", border: "#22C55E", text: "#15803D", label: "Done",  tooltip: "Done — Service completed" },
  completed:  { bg: "#DCFCE7", border: "#22C55E", text: "#15803D", label: "Done",  tooltip: "Done — Service completed" },
  invoiced:   { bg: "#DCFCE7", border: "#22C55E", text: "#15803D", label: "Done",  tooltip: "Done — Service completed" },
  cancelled:  { bg: "#FEE2E2", border: "#EF4444", text: "#DC2626", label: "Void",  tooltip: "Void — Appointment cancelled" },
  bumped:     { bg: "#FED7AA", border: "#F97316", text: "#C2410C", label: "Moved", tooltip: "Moved — Job rescheduled to another date" },
  skipped:    { bg: "#F3F4F6", border: "#9CA3AF", text: "#6B7280", label: "Skip",  tooltip: "Skip — Client skipped this visit" },
  lockout:    { bg: "#F3E8E8", border: "#7B2D2D", text: "#7B2D2D", label: "Lock",  tooltip: "Lock Out — Technician could not access the property" },
};
const RESCHEDULE_REASONS = [
  "Client Request", "Tech Unavailable", "Weather", "Holiday / Observed Holiday",
  "Emergency", "Client Traveling", "Schedule Optimization", "Other",
];
const DAYS = ["Su","Mo","Tu","We","Th","Fr","Sa"];
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function toLocalDateStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function addMonths(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(1);
  r.setMonth(r.getMonth() + n);
  return r;
}
function startOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d: Date)   { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }

function JobCalendar({ clientId, clientName, onScheduleOnDate }: { clientId: number; clientName: string; onScheduleOnDate?: (isoDate: string) => void }) {
  const qc = useQueryClient();
  const calIsMobile = useIsMobile();
  // anchor = first day of the first visible month
  const todayRef = useRef(startOfMonth(new Date()));
  const [anchor, setAnchor] = useState<Date>(todayRef.current);
  const [dragJobId, setDragJobId] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [modal, setModal] = useState<{ job: any; targetDate?: string } | null>(null);
  const [form, setForm] = useState({ new_date: "", reason: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);

  const months: Date[] = [anchor, addMonths(anchor, 1), addMonths(anchor, 2)];
  const from = toLocalDateStr(startOfMonth(months[0]));
  const to   = toLocalDateStr(endOfMonth(months[2]));

  const { data: calJobs = [], isLoading, refetch } = useQuery<any[]>({
    queryKey: ["client-calendar-jobs", clientId, from, to],
    queryFn: () => apiFetch(`/api/clients/${clientId}/calendar-jobs?from=${from}&to=${to}`),
    enabled: clientId > 0,
    staleTime: 20000,
  });

  // Build a map: dateStr → job[]
  const jobMap = useRef<Record<string, any[]>>({});
  jobMap.current = {};
  for (const j of calJobs) {
    const ds = String(j.scheduled_date).split("T")[0];
    if (!jobMap.current[ds]) jobMap.current[ds] = [];
    jobMap.current[ds].push(j);
  }

  const isReadOnly = (j: any) => ["complete","completed","invoiced","lockout"].includes(String(j.status));

  function openReschedule(job: any, targetDate?: string) {
    if (isReadOnly(job)) { setModal({ job }); return; }
    setForm({ new_date: targetDate || String(job.scheduled_date).split("T")[0], reason: "", notes: "" });
    setSaveErr(null);
    setModal({ job, targetDate });
  }

  async function handleReschedule() {
    if (!modal?.job || !form.new_date || !form.reason) return;
    setSaving(true); setSaveErr(null);
    try {
      await apiFetch(`/api/clients/${clientId}/jobs/${modal.job.id}/reschedule`, {
        method: "PATCH",
        body: JSON.stringify({ new_date: form.new_date, reason: form.reason, notes: form.notes }),
      });
      qc.invalidateQueries({ queryKey: ["client-calendar-jobs", clientId] });
      qc.invalidateQueries({ queryKey: ["client-job-history", clientId] });
      refetch();
      setModal(null);
    } catch (e: any) {
      setSaveErr(e.message || "Failed to reschedule");
    } finally { setSaving(false); }
  }

  async function handleStatusChange(newStatus: "void" | "skip" | "booked") {
    if (!modal?.job) return;
    setStatusSaving(true);
    try {
      await apiFetch(`/api/clients/${clientId}/jobs/${modal.job.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      qc.invalidateQueries({ queryKey: ["client-calendar-jobs", clientId] });
      qc.invalidateQueries({ queryKey: ["client-job-history", clientId] });
      refetch();
      setModal(null);
    } catch (e: any) {
      setSaveErr(e.message || "Failed to update status");
    } finally { setStatusSaving(false); }
  }

  // ── Drag handlers ────────────────────────────────────────────────────────────
  function onDragStart(e: React.DragEvent, job: any) {
    if (isReadOnly(job)) { e.preventDefault(); return; }
    setDragJobId(job.id);
    e.dataTransfer.effectAllowed = "move";
  }
  function onDragOver(e: React.DragEvent, dateStr: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(dateStr);
  }
  function onDrop(e: React.DragEvent, dateStr: string) {
    e.preventDefault();
    setDragOver(null);
    if (dragJobId == null) return;
    const job = calJobs.find(j => j.id === dragJobId);
    setDragJobId(null);
    if (!job) return;
    const current = String(job.scheduled_date).split("T")[0];
    if (current === dateStr) return;
    openReschedule(job, dateStr);
  }

  // ── Month grid renderer ───────────────────────────────────────────────────────
  function renderMonth(month: Date) {
    const y = month.getFullYear(), m = month.getMonth();
    const firstDow = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const todayStr = toLocalDateStr(new Date());
    const cells: React.ReactNode[] = [];

    // Leading blanks
    for (let i = 0; i < firstDow; i++) {
      cells.push(<div key={`blank-${i}`} style={{ minHeight: 56 }} />);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${y}-${String(m + 1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      const jobs = jobMap.current[ds] || [];
      const isToday = ds === todayStr;
      const isHover = dragOver === ds;
      const isPast  = ds < todayStr;

      // [scheduling-engine 2026-04-29] Empty future day → open the
      // scheduling modal pre-filled with that date. Day cells with
      // existing jobs route through the chip's openReschedule
      // handler (unchanged). Past empty days stay no-op so an
      // accidental click on a historical day doesn't open a wizard
      // for a date that can't be booked.
      const isEmptyFuture = jobs.length === 0 && !isPast;
      const handleEmptyClick = () => {
        if (isEmptyFuture && onScheduleOnDate) onScheduleOnDate(ds);
      };
      cells.push(
        <div
          key={ds}
          onDragOver={e => onDragOver(e, ds)}
          onDragLeave={() => setDragOver(null)}
          onDrop={e => onDrop(e, ds)}
          onClick={isEmptyFuture ? handleEmptyClick : undefined}
          title={isEmptyFuture ? `Schedule a job on ${ds}` : undefined}
          style={{
            minHeight: 56, padding: "2px 3px", borderRadius: 5,
            border: isHover ? "2px dashed #3B82F6" : isToday ? "1.5px solid #3B82F6" : "1.5px solid transparent",
            background: isHover ? "#EFF6FF" : "transparent",
            transition: "border 0.1s, background 0.1s",
            cursor: isEmptyFuture ? "pointer" : "default",
          }}
          onMouseOver={e => { if (isEmptyFuture && !isHover) (e.currentTarget as HTMLDivElement).style.background = "#F8FAFC"; }}
          onMouseOut={e => { if (isEmptyFuture && !isHover) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
        >
          <div style={{
            fontSize: 11, fontWeight: isToday ? 700 : 400, color: isToday ? "#1D4ED8" : isPast ? "#9E9B94" : "#1A1917",
            textAlign: "right", marginBottom: 1, lineHeight: "16px",
          }}>{d}</div>
          {jobs.map(j => {
            const chip = STATUS_CHIP[String(j.status)] || STATUS_CHIP.scheduled;
            const ro = isReadOnly(j);
            return (
              <div
                key={j.id}
                draggable={!ro}
                onDragStart={e => onDragStart(e, j)}
                onClick={() => openReschedule(j)}
                title={`${chip.tooltip}${j.scheduled_time ? " | " + String(j.scheduled_time).slice(0,5).replace(/^(\d+):(\d+)$/, (_, h, m) => `${parseInt(h) % 12 || 12}:${m} ${parseInt(h) < 12 ? "AM" : "PM"}`) : ""}${j.technician_name ? " · " + j.technician_name : ""}`}
                style={{
                  background: chip.bg, border: `1px solid ${chip.border}`, color: chip.text,
                  borderRadius: 3, fontSize: 10, fontWeight: 600, padding: "1px 4px",
                  marginBottom: 2, cursor: ro ? "default" : "grab", whiteSpace: "nowrap",
                  overflow: "hidden", textOverflow: "ellipsis", lineHeight: "16px",
                  userSelect: "none",
                }}
              >
                {chip.label}
              </div>
            );
          })}
        </div>
      );
    }

    return (
      <div key={`${y}-${m}`} style={{ flex: calIsMobile ? "none" : 1, width: calIsMobile ? "100%" : undefined, minWidth: calIsMobile ? 0 : 200 }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: "#1A1917", marginBottom: 6, textAlign: "center" }}>
          {MONTH_NAMES[m]} {y}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 1, marginBottom: 3 }}>
          {DAYS.map(d => (
            <div key={d} style={{ textAlign: "center", fontSize: 10, fontWeight: 700, color: "#9E9B94", padding: "2px 0", letterSpacing: "0.04em" }}>{d}</div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>
          {cells}
        </div>
      </div>
    );
  }

  const statusLegend = Object.entries(STATUS_CHIP).filter(([k]) =>
    ["scheduled","complete","cancelled","bumped","skipped","lockout"].includes(k)
  );

  return (
    <div style={{ fontFamily: FF, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 16px", borderBottom: "1px solid #E5E2DC", gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.08em", flexShrink: 0 }}>
          Job Calendar
          {isLoading && <span style={{ marginLeft: 6, color: "#9E9B94", fontWeight: 400 }}>Loading…</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" as const, justifyContent: "flex-end" }}>
          {/* Legend — hide on mobile to save space */}
          {!calIsMobile && (
            <div style={{ display: "flex", gap: 4, alignItems: "center", marginRight: 8 }}>
              {statusLegend.map(([k, c]) => (
                <span key={k} title={c.tooltip} style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.text, borderRadius: 3, fontSize: 9, fontWeight: 700, padding: "1px 5px", whiteSpace: "nowrap" as const, cursor: "help" }}>{c.label}</span>
              ))}
            </div>
          )}
          {/* Nav */}
          <button
            onClick={() => setAnchor(a => addMonths(a, -1))}
            style={{ width: 26, height: 26, border: "1px solid #E5E2DC", borderRadius: 5, background: "#FAFAF8", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
          ><ChevronLeft size={13} /></button>
          <button
            onClick={() => setAnchor(todayRef.current)}
            style={{ padding: "4px 8px", fontSize: 11, border: "1px solid #E5E2DC", borderRadius: 5, background: "#FAFAF8", cursor: "pointer", fontFamily: FF }}
          >Today</button>
          <button
            onClick={() => setAnchor(a => addMonths(a, 1))}
            style={{ width: 26, height: 26, border: "1px solid #E5E2DC", borderRadius: 5, background: "#FAFAF8", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
          ><ChevronRight size={13} /></button>
        </div>
      </div>

      {/* Three-month grid — stacks vertically on mobile */}
      <div style={{ padding: "12px 16px", display: "flex", flexDirection: calIsMobile ? "column" : "row", gap: 16 }}>
        {months.map(m => renderMonth(m))}
      </div>

      {/* Reschedule / Detail Modal */}
      {modal && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) setModal(null); }}
        >
          <div style={{ background: "#FFFFFF", borderRadius: 12, padding: 24, width: 420, maxWidth: "90vw", fontFamily: FF, boxShadow: "0 16px 48px rgba(0,0,0,0.18)" }}>
            {(() => {
              const j = modal.job;
              const chip = STATUS_CHIP[String(j.status)] || STATUS_CHIP.scheduled;
              const ro = isReadOnly(j);
              const origDate = String(j.scheduled_date).split("T")[0];
              return (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "#1A1917" }}>
                        {ro ? "Job Details" : "Reschedule Job"}
                      </div>
                      <div style={{ fontSize: 12, color: "#9E9B94", marginTop: 2 }}>{clientName}</div>
                    </div>
                    <span style={{ background: chip.bg, border: `1px solid ${chip.border}`, color: chip.text, borderRadius: 5, fontSize: 11, fontWeight: 700, padding: "3px 8px" }}>{chip.label}</span>
                  </div>

                  {/* Job info rows */}
                  <div style={{ background: "#FAFAF8", borderRadius: 8, padding: "10px 12px", marginBottom: 16, fontSize: 13 }}>
                    {[
                      ["Current date", origDate],
                      ["Service", j.service_type || "—"],
                      j.technician_name && ["Technician", j.technician_name],
                      j.scheduled_time && ["Time", String(j.scheduled_time).slice(0,5)],
                      (j.base_fee || j.billed_amount) && ["Fee", `$${Number(j.billed_amount || j.base_fee || 0).toFixed(2)}`],
                    ].filter(Boolean).map((row: any) => (
                      <div key={row[0]} style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, color: "#1A1917" }}>
                        <span style={{ color: "#9E9B94" }}>{row[0]}</span>
                        <span style={{ fontWeight: 600 }}>{row[1]}</span>
                      </div>
                    ))}
                  </div>

                  {!ro && (
                    <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                      <button
                        onClick={() => handleStatusChange("void")}
                        disabled={statusSaving}
                        style={{ flex: 1, padding: "6px 0", fontSize: 12, fontWeight: 700, background: "#FEE2E2", color: "#DC2626", border: "1px solid #EF4444", borderRadius: 6, cursor: "pointer", fontFamily: FF }}
                      >Mark Void</button>
                      <button
                        onClick={() => handleStatusChange("skip")}
                        disabled={statusSaving}
                        style={{ flex: 1, padding: "6px 0", fontSize: 12, fontWeight: 700, background: "#F3F4F6", color: "#6B7280", border: "1px solid #D1D5DB", borderRadius: 6, cursor: "pointer", fontFamily: FF }}
                      >Mark Skip</button>
                    </div>
                  )}

                  {ro && ["cancelled"].includes(String(j.status)) && (
                    <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                      <button
                        onClick={() => handleStatusChange("booked")}
                        disabled={statusSaving}
                        style={{ flex: 1, padding: "6px 0", fontSize: 12, fontWeight: 700, background: "#DBEAFE", color: "#1D4ED8", border: "1px solid #3B82F6", borderRadius: 6, cursor: "pointer", fontFamily: FF }}
                      >Restore to Booked</button>
                    </div>
                  )}

                  {ro && !["cancelled"].includes(String(j.status)) ? (
                    <div style={{ textAlign: "center", fontSize: 12, color: "#9E9B94", marginBottom: 16 }}>
                      This job is {chip.label.toLowerCase()} and cannot be rescheduled.
                    </div>
                  ) : ro ? null : (
                    <>
                      <div style={{ marginBottom: 12 }}>
                        <label style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>New Date *</label>
                        <input
                          type="date"
                          value={form.new_date}
                          onChange={e => setForm(f => ({ ...f, new_date: e.target.value }))}
                          style={{ width: "100%", border: "1px solid #E5E2DC", borderRadius: 6, padding: "8px 10px", fontSize: 13, fontFamily: FF, boxSizing: "border-box" as const }}
                        />
                      </div>
                      <div style={{ marginBottom: 12 }}>
                        <label style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Reason *</label>
                        <select
                          value={form.reason}
                          onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                          style={{ width: "100%", border: "1px solid #E5E2DC", borderRadius: 6, padding: "8px 10px", fontSize: 13, fontFamily: FF, boxSizing: "border-box" as const }}
                        >
                          <option value="">Select reason…</option>
                          {RESCHEDULE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </div>
                      <div style={{ marginBottom: 16 }}>
                        <label style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Notes</label>
                        <textarea
                          value={form.notes}
                          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                          rows={2}
                          placeholder="Optional notes…"
                          style={{ width: "100%", border: "1px solid #E5E2DC", borderRadius: 6, padding: "8px 10px", fontSize: 13, fontFamily: FF, boxSizing: "border-box" as const, resize: "vertical" as const }}
                        />
                      </div>
                      {saveErr && <div style={{ fontSize: 12, color: "#DC2626", marginBottom: 10 }}>{saveErr}</div>}
                    </>
                  )}

                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button
                      onClick={() => setModal(null)}
                      style={{ padding: "8px 16px", fontSize: 13, border: "1px solid #E5E2DC", borderRadius: 6, background: "#FFFFFF", cursor: "pointer", fontFamily: FF }}
                    >Close</button>
                    {!ro && (
                      <button
                        onClick={handleReschedule}
                        disabled={saving || !form.new_date || !form.reason}
                        style={{
                          padding: "8px 16px", fontSize: 13, fontWeight: 600,
                          background: saving || !form.new_date || !form.reason ? "#E5E2DC" : "var(--brand)",
                          color: saving || !form.new_date || !form.reason ? "#9E9B94" : "#FFFFFF",
                          border: "none", borderRadius: 6, cursor: saving || !form.new_date || !form.reason ? "not-allowed" : "pointer", fontFamily: FF,
                        }}
                      >{saving ? "Saving…" : "Reschedule"}</button>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Profile Page ─────────────────────────────────────────────────────────
const PROFILE_TABS = [
  { id: "client",        label: "Client"        },
  { id: "property",      label: "Property"      },
  { id: "jobs",          label: "Jobs"          },
  { id: "admin",         label: "Admin"         },
  { id: "profitability", label: "Profitability" },
] as const;
type ProfileTab = typeof PROFILE_TABS[number]["id"];

export default function CustomerProfilePage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/customers/:id");
  const clientId = parseInt(params?.id || "0");
  const qc = useQueryClient();
  const [showJobWizard, setShowJobWizard] = useState(false);
  // [scheduling-engine 2026-04-29] Preset date when the wizard is
  // opened from a calendar empty-cell click. Cleared when the wizard
  // closes so a subsequent click of the "Schedule Job" button doesn't
  // reuse a stale date.
  const [wizardPresetDate, setWizardPresetDate] = useState<string | null>(null);

  const { data: profile, isLoading, refetch: refetchProfile } = useQuery<any>({
    queryKey: ["client-profile", clientId],
    queryFn: () => apiFetch(`/api/clients/${clientId}/full-profile`),
    enabled: clientId > 0,
    staleTime: 15000,
  });

  const { data: jhData, isLoading: jhLoading } = useQuery<any>({
    queryKey: ["client-job-history", clientId],
    queryFn: () => apiFetch(`/api/clients/${clientId}/job-history`),
    enabled: clientId > 0,
    staleTime: 30000,
  });

  const { data: recurringSchedule } = useQuery<any>({
    queryKey: ["client-recurring", clientId],
    queryFn: () => apiFetch(`/api/clients/${clientId}/recurring-schedule`),
    enabled: clientId > 0,
    staleTime: 60000,
  });

  const updateMut = useMutation({
    mutationFn: (data: any) => apiFetch(`/api/clients/${clientId}`, { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["client-profile", clientId] }); refetchProfile(); },
  });

  const { data: loyaltyData, refetch: refetchLoyalty } = useQuery<any>({
    queryKey: ["client-loyalty", clientId],
    queryFn: () => apiFetch(`/api/clients/${clientId}/loyalty`),
    enabled: clientId > 0,
    staleTime: 30000,
  });

  const { data: referrals = [], refetch: refetchReferrals } = useQuery<any[]>({
    queryKey: ["client-referrals", clientId],
    queryFn: () => apiFetch(`/api/clients/${clientId}/referrals`),
    enabled: clientId > 0,
    staleTime: 30000,
  });

  const isMobile = useIsMobile();
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [showMessageDrawer, setShowMessageDrawer] = useState(false);
  const [showEditProfileDrawer, setShowEditProfileDrawer] = useState(false);
  const [showAlarmCode, setShowAlarmCode] = useState(false);
  const [activeTab, setActiveTab] = useState<ProfileTab>("client");
  const showToast = useCallback((message: string, type: "success" | "error" = "success") => setToast({ message, type }), []);

  const goBack = () => navigate("/customers");

  if (isLoading || !profile) {
    return (
      <DashboardLayout fullBleed>
        <div style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px", fontFamily: FF }}>
          Loading client profile...
        </div>
      </DashboardLayout>
    );
  }

  const jhStats = jhData?.stats || null;
  const ltv = jhStats?.total_revenue ?? profile.stats?.revenue_all_time ?? 0;
  const lastCleaning = jhStats?.last_cleaning ?? profile.stats?.last_cleaning;
  const nextCleaning = jhStats?.next_cleaning ?? profile.stats?.next_cleaning;
  const initials = `${profile.first_name?.[0] || ""}${profile.last_name?.[0] || ""}`.toUpperCase();
  const isRecurring = jhStats?.is_recurring ?? (profile.service_type === "recurring" || (profile.frequency && profile.frequency !== "on_demand"));
  const freqBadge = recurringSchedule?.frequency
    ? (FREQ_LABELS[recurringSchedule.frequency] || recurringSchedule.frequency)
    : (profile.frequency ? (FREQ_LABELS[profile.frequency] || freqLabel(profile.frequency)) : null);
  const invoices = profile.invoices || [];

  // ─── Loyalty computed values ───────────────────────────────────────────────
  const loyaltyRecord = loyaltyData?.loyalty || null;
  const loyaltyTiers = loyaltyData?.tiers || [];
  const loyaltyStats = loyaltyData?.stats || { total_visits: 0, lifetime_revenue: 0 };
  const effectiveTierName: string = (() => {
    if (loyaltyRecord?.tier_override) return loyaltyRecord.tier_override;
    if (loyaltyTiers.length > 0) {
      const visits = Number(loyaltyStats.total_visits || 0);
      const rev = Number(loyaltyStats.lifetime_revenue || 0);
      let best: any = null;
      for (const t of loyaltyTiers) {
        if (visits >= (t.min_visits || 0) && rev >= (t.min_lifetime_revenue || 0)) best = t;
      }
      if (best) return best.tier_name;
    }
    return "";
  })();

  function loyaltyTierBadge(name: string) {
    const lower = name.toLowerCase();
    if (lower.includes("gold")) return { bg: "#FEF9C3", color: "#CA8A04" };
    if (lower.includes("silver")) return { bg: "#F1F5F9", color: "#64748B" };
    if (lower.includes("bronze")) return { bg: "#FEF3C7", color: "#D97706" };
    return { bg: "#E5E2DC", color: "#6B6860" };
  }

  // ─── Shared card style ────────────────────────────────────────────────────
  const CS: React.CSSProperties = {
    background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12,
    padding: "18px 20px", marginBottom: 14,
  };
  const CTitle: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, color: "#9E9B94",
    textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 12,
  };
  const DL2 = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "5px 0", borderBottom: "1px solid #F0EEE9" }}>
      <span style={{ fontSize: 12, color: "#9E9B94", flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", textAlign: "right" as const }}>{value || "—"}</span>
    </div>
  );

  // ─── Stat row helper ─────────────────────────────────────────────────────
  const SR2 = ({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: "1px solid #F0EEE9" }}>
      <span style={{ fontSize: 12, color: "#6B6860" }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: color || "#1A1917" }}>{value ?? "—"}</span>
    </div>
  );

  // ─── Hero Strip (identical across mobile+desktop) ─────────────────────────
  const HeroStrip = (
    <div style={{ background: "#FFFFFF", borderBottom: "1px solid #E5E2DC", padding: "14px 24px 0", flexShrink: 0, fontFamily: FF }}>
      {/* Row 1: breadcrumb */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <button onClick={goBack} style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer", color: "#9E9B94", fontSize: 13, padding: 0, fontFamily: FF }}>
          <ArrowLeft size={14} /><span>Clients</span>
        </button>
        <span style={{ color: "#D0CEC9" }}>/</span>
        <span style={{ fontSize: 13, color: "#1A1917", fontWeight: 500 }}>{profile.first_name} {profile.last_name}</span>
      </div>

      {/* Row 2: identity + LTV + actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--brand-dim)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <span style={{ fontSize: 17, fontWeight: 800, color: "var(--brand)" }}>{initials}</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <span style={{ fontSize: 19, fontWeight: 700, color: "#0A0E1A" }}>{profile.first_name} {profile.last_name}</span>
            {profile.zone_color && (
              <span title={profile.zone_name || "Zone"} style={{ width: 14, height: 14, borderRadius: "50%", backgroundColor: profile.zone_color, display: "inline-block", flexShrink: 0, cursor: "default", boxShadow: `0 0 0 3px ${profile.zone_color}30, 0 0 0 1px ${profile.zone_color}80` }} />
            )}
            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, textTransform: "uppercase" as const, letterSpacing: "0.06em", background: profile.is_active !== false ? "#DCFCE7" : "#F3F4F6", color: profile.is_active !== false ? "#166534" : "#6B7280" }}>
              {profile.is_active !== false ? "Active" : "Inactive"}
            </span>
            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, textTransform: "uppercase" as const, letterSpacing: "0.06em", background: isRecurring ? "var(--brand-dim)" : "#F3F4F6", color: isRecurring ? "var(--brand)" : "#6B7280" }}>
              {isRecurring ? "Recurring" : "One-Time"}
            </span>
            {freqBadge && (
              <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 4, background: "#EDE9FE", color: "#7C3AED", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>{freqBadge}</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 3, fontSize: 12, color: "#9E9B94", flexWrap: "wrap" }}>
            <span>CL-{String(profile.id).padStart(4, "0")}</span>
            {lastCleaning && <span>Last: <strong style={{ color: "#1A1917" }}>{fmtDate(lastCleaning)}</strong></span>}
            <span>Next: <strong style={{ color: nextCleaning ? "var(--brand)" : "#9E9B94" }}>{nextCleaning ? fmtDate(nextCleaning) : "Not scheduled"}</strong></span>
          </div>
        </div>
        <div style={{ background: "#0A0E1A", borderRadius: 10, padding: "7px 14px", textAlign: "center" as const, flexShrink: 0 }}>
          <div style={{ fontSize: 19, fontWeight: 900, color: "#00C9A0", lineHeight: 1 }}>${ltv.toLocaleString("en-US", { maximumFractionDigits: 0 })}</div>
          <div style={{ fontSize: 9, fontWeight: 700, color: "#9CA3AF", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginTop: 2 }}>Lifetime Value</div>
          {/* [scheduling-engine 2026-04-29] Subtitle pins "since
              when" — first-job date if available, else client
              created_at. Removes the ambiguity of an unlabeled
              dollar number that could be misread as YTD or this
              month. */}
          {(() => {
            const since = jhStats?.first_cleaning ?? profile.created_at ?? null;
            if (!since) return null;
            return (
              <div style={{ fontSize: 8, fontWeight: 600, color: "#6B7280", marginTop: 1 }}>
                Since {fmtDate(since)}
              </div>
            );
          })()}
          {jhStats?.ytd_revenue != null && (
            <div style={{ marginTop: 5, paddingTop: 5, borderTop: "1px solid rgba(255,255,255,0.12)" }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#86EFAC", lineHeight: 1 }}>${(jhStats.ytd_revenue as number).toLocaleString("en-US", { maximumFractionDigits: 0 })}</div>
              <div style={{ fontSize: 8, fontWeight: 700, color: "#9CA3AF", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginTop: 1 }}>{new Date().getFullYear()} YTD</div>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", flexShrink: 0 }}>
          <button onClick={() => setShowJobWizard(true)} style={{ padding: "7px 13px", background: "var(--brand)", border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>Schedule Job</button>
          <button onClick={() => navigate(`/quotes/new?client_id=${clientId}`)} style={{ padding: "7px 13px", background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 8, color: "#1A1917", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: FF }}>Quote</button>
          <button onClick={() => setShowMessageDrawer(true)} style={{ padding: "7px 13px", background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 8, color: "#1A1917", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: FF }}>Message</button>
          <button onClick={() => setShowEditProfileDrawer(true)} style={{ padding: "7px 13px", background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 8, color: "#1A1917", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: FF }}>Edit</button>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 0, marginLeft: -24, marginRight: -24, paddingLeft: 24 }}>
        {PROFILE_TABS.filter(tab => {
          if (tab.id !== "profitability") return true;
          const role = getTokenRole();
          return role === "owner" || role === "office";
        }).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "8px 18px", border: "none", cursor: "pointer", fontFamily: FF,
              fontSize: 13, fontWeight: activeTab === tab.id ? 700 : 500,
              color: activeTab === tab.id ? "var(--brand)" : "#6B6860",
              background: "transparent",
              borderBottom: activeTab === tab.id ? "2px solid var(--brand)" : "2px solid transparent",
              marginBottom: -1, transition: "color 120ms, border-color 120ms",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );

  // ─── Left Stats Panel ─────────────────────────────────────────────────────
  const nextWithin7 = nextCleaning && (() => {
    const diff = (new Date(nextCleaning).getTime() - Date.now()) / 86400000;
    return diff >= 0 && diff <= 7;
  })();

  const LeftPanel = (
    <div style={{
      width: 260, flexShrink: 0,
      position: "sticky" as const, top: 0, height: "calc(100vh - 64px)",
      overflowY: "auto" as const,
      padding: "16px 0 20px 16px",
    }}>
      <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: "16px" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 12 }}>Client Stats</div>
        <SR2 label="Client Since" value={profile.client_since ? fmtDate(profile.client_since) : null} />
        <SR2 label="Last Cleaning" value={lastCleaning ? fmtDate(lastCleaning) : null} />
        <SR2 label="Next Cleaning"
          value={nextCleaning ? fmtDate(nextCleaning) : "Not scheduled"}
          color={nextWithin7 ? "var(--brand)" : nextCleaning ? "#1A1917" : "#9E9B94"}
        />
        {jhStats && (<>
          <SR2 label="Lifetime Revenue" value={`$${(jhStats.total_revenue ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`} />
          <SR2 label="Last 12 Months" value={`$${(jhStats.revenue_last_12mo ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`} />
          <SR2 label="Avg Bill (12mo)" value={jhStats.avg_bill != null ? `$${Number(jhStats.avg_bill).toFixed(2)}` : null} />
          <SR2 label="Total Visits" value={jhStats.total_visits ?? 0} />
          <SR2 label="Pending Jobs" value={jhStats.pending_jobs ?? 0} color={(jhStats.pending_jobs ?? 0) > 0 ? "var(--brand)" : undefined} />
          <SR2 label="Skips" value={jhStats.skips ?? 0} color={(jhStats.skips ?? 0) > 0 ? "#DC2626" : undefined} />
          <SR2 label="Bumps" value={jhStats.bumps ?? 0} color={(jhStats.bumps ?? 0) > 0 ? "#D97706" : undefined} />
          {jhStats.ecard_pct != null && <SR2 label="eCard Rate" value={`${jhStats.ecard_pct}%`} color={jhStats.ecard_pct >= 50 ? "#16A34A" : undefined} />}
          {jhStats.unique_techs != null && (
            <SR2
              label="Tech Consistency"
              value={`${jhStats.unique_techs} tech${jhStats.unique_techs !== 1 ? "s" : ""} / ${jhStats.total_visits ?? 0} visits`}
              color={jhStats.unique_techs >= 6 ? "#DC2626" : jhStats.unique_techs >= 3 ? "#D97706" : "#16A34A"}
            />
          )}
        </>)}
        {profile?.stats?.scorecard_avg && (
          <SR2
            label="Avg Scorecard"
            value={`${profile.stats.scorecard_avg.toFixed(1)} / 5`}
            color={profile.stats.scorecard_avg >= 4 ? "#16A34A" : profile.stats.scorecard_avg >= 3 ? "#D97706" : "#DC2626"}
          />
        )}
        {/* Loyalty Tier */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #F0EEE9" }}>
          <span style={{ fontSize: 12, color: "#6B6860" }}>Loyalty Tier</span>
          {effectiveTierName ? (
            <span style={{ fontSize: 11, fontWeight: 700, borderRadius: 4, padding: "2px 7px", background: loyaltyTierBadge(effectiveTierName).bg, color: loyaltyTierBadge(effectiveTierName).color }}>
              {effectiveTierName}
              {loyaltyRecord?.tier_override && <span style={{ fontWeight: 400, marginLeft: 4 }}>(manual)</span>}
            </span>
          ) : (
            <span style={{ fontSize: 12, color: "#9E9B94" }}>No Tier</span>
          )}
        </div>
      </div>
    </div>
  );

  // ─── Reusable section header ──────────────────────────────────────────────
  const SectionHead = ({ title, action }: { title: string; action?: React.ReactNode }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
      <div style={CTitle}>{title}</div>
      {action}
    </div>
  );

  // ─── Tab content ──────────────────────────────────────────────────────────
  const TabContent = (
    <div style={{ flex: 1, overflowY: "auto" as const, padding: "16px 20px 80px 16px" }}>

      {/* ══════════════════════════════════════════════
          TAB 1: CLIENT — who this person is, how to reach them, how they pay
          2-column grid
         ══════════════════════════════════════════════ */}
      {activeTab === "client" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>

          {/* Left column */}
          <div>
            {/* Contact & Basic Info */}
            <div style={CS}>
              <SectionHead title="Contact & Basic Info" />
              <DL2 label="First Name" value={profile.first_name} />
              <DL2 label="Last Name" value={profile.last_name} />
              {profile.phone && <DL2 label="Phone" value={<a href={`tel:${profile.phone}`} style={{ color: "var(--brand)", textDecoration: "none" }}>{profile.phone}</a>} />}
              {profile.email && <DL2 label="Email" value={<a href={`mailto:${profile.email}`} style={{ color: "var(--brand)", textDecoration: "none", wordBreak: "break-all" as const }}>{profile.email}</a>} />}
              {profile.client_since && <DL2 label="Client Since" value={fmtDate(profile.client_since)} />}
              {profile.referral_source && <DL2 label="Acquisition Source" value={SOURCE_LABELS[profile.referral_source] || String(profile.referral_source).replace(/_/g, " ")} />}
              {profile.company_name && <DL2 label="Company" value={profile.company_name} />}
              {(profile.loyalty_points > 0) && <DL2 label="Loyalty Points" value={profile.loyalty_points} />}
            </div>

            {/* Billing & Payments */}
            <div style={CS}>
              <SectionHead title="Billing & Payments" />
              <CardOnFileTab client={profile} refetch={refetchProfile} />
              {(() => {
                const lastPaid = invoices.filter((i: any) => i.paid_at).sort((a: any, b: any) => new Date(b.paid_at).getTime() - new Date(a.paid_at).getTime())[0];
                const totalPaid = invoices.filter((i: any) => i.paid_at).reduce((s: number, i: any) => s + parseFloat(i.total || "0"), 0);
                return (
                  <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 0 }}>
                    <DL2 label="Total Paid (All Time)" value={fmtCurrency(totalPaid)} />
                    {lastPaid && <DL2 label="Last Payment" value={`${fmtDate(lastPaid.paid_at)} · ${fmtCurrency(lastPaid.total)}`} />}
                  </div>
                );
              })()}
            </div>

            {/* Loyalty Program */}
            <LoyaltyProgramCard
              clientId={clientId}
              loyaltyRecord={loyaltyRecord}
              loyaltyTiers={loyaltyTiers}
              loyaltyStats={loyaltyStats}
              effectiveTierName={effectiveTierName}
              loyaltyTierBadge={loyaltyTierBadge}
              refetch={refetchLoyalty}
              showToast={showToast}
            />
          </div>

          {/* Right column */}
          <div>
            {/* Invoices */}
            <div style={CS}>
              <SectionHead title="Invoices" />
              <BillingTab invoices={invoices} />
            </div>

            {/* QuickBooks */}
            <div style={CS}>
              <SectionHead title="QuickBooks" />
              <QuickBooksTab clientId={clientId} client={profile} refetch={refetchProfile} />
            </div>

            {/* Communication Log */}
            <CommLog2 clientId={clientId} />
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════
          TAB 2: PROPERTY — where we go and how we get in
          2-column grid
         ══════════════════════════════════════════════ */}
      {activeTab === "property" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>

          {/* Left column */}
          <div>
            {/* Service Addresses */}
            <div style={CS}>
              <SectionHead title="Service Addresses" />
              <HomesTab clientId={clientId} homes={profile.homes || []} refetch={refetchProfile} zoneColor={profile.zone_color} zoneName={profile.zone_name} />
            </div>

            {/* Access & Entry — critical for techs */}
            <div style={{ ...CS, border: (profile.home_access_notes || profile.alarm_code || profile.pets) ? "1px solid #E5E2DC" : "1px dashed #E5E2DC" }}>
              <SectionHead title="Access & Entry" />
              {profile.home_access_notes ? (
                <div style={{ background: "#FAFAF8", border: "1px solid #F0EEE9", borderRadius: 8, padding: "10px 12px", marginBottom: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginBottom: 4 }}>Entry Instructions</div>
                  <div style={{ fontSize: 13, color: "#374151", whiteSpace: "pre-wrap" as const, lineHeight: 1.5 }}>{profile.home_access_notes}</div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "#9E9B94", marginBottom: 8 }}>No entry instructions on file</div>
              )}
              {profile.alarm_code ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#FEF9C3", border: "1px solid #FDE047", borderRadius: 8, padding: "10px 12px", marginBottom: 8 }}>
                  <ShieldCheck size={15} style={{ color: "#A16207", flexShrink: 0 }} />
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#A16207", textTransform: "uppercase" as const, letterSpacing: "0.07em", minWidth: 80 }}>Alarm / Code</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", letterSpacing: showAlarmCode ? "normal" : "0.22em", fontFamily: "monospace", flex: 1 }}>
                    {showAlarmCode ? profile.alarm_code : "•".repeat(profile.alarm_code.length || 6)}
                  </span>
                  <button onClick={() => setShowAlarmCode(v => !v)} style={{ background: "none", border: "none", cursor: "pointer", color: "#A16207", padding: 0, display: "flex", alignItems: "center" }}>
                    {showAlarmCode ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "#9E9B94", marginBottom: 8 }}>No alarm / lockbox code on file</div>
              )}
              {profile.pets ? (
                <div style={{ background: "#FAFAF8", border: "1px solid #F0EEE9", borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginBottom: 4 }}>Pets / Equipment Notes</div>
                  <div style={{ fontSize: 13, color: "#374151" }}>{profile.pets}</div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "#9E9B94" }}>No pets / equipment notes on file</div>
              )}
              <button
                onClick={() => setShowEditProfileDrawer(true)}
                style={{ marginTop: 12, fontSize: 12, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", padding: 0, fontWeight: 600, fontFamily: FF }}
              >
                Edit Access Details
              </button>
            </div>

            {/* Client Notes */}
            <div style={CS}>
              <SectionHead title="Client Notes" />
              <textarea
                defaultValue={profile.notes || ""}
                onBlur={async (e) => {
                  if (e.target.value !== (profile.notes || "")) {
                    try { await updateMut.mutateAsync({ notes: e.target.value }); showToast("Notes saved"); }
                    catch { showToast("Failed to save notes", "error"); }
                  }
                }}
                placeholder="Internal notes about this client (auto-saves on blur)..."
                rows={5}
                style={{ width: "100%", padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, color: "#374151", resize: "vertical" as const, outline: "none", fontFamily: FF, boxSizing: "border-box" as const, lineHeight: 1.5, background: "#FAFAF8" }}
              />
            </div>
          </div>

          {/* Right column */}
          <div>
            {/* Recurring Schedule */}
            <div style={CS}>
              <SectionHead title="Recurring Schedule" />
              <ServiceDetailsSection client={profile} onUpdate={updateMut.mutateAsync} refetch={refetchProfile} recurringSchedule={recurringSchedule} onToast={showToast} />
            </div>

            {/* Rate History */}
            <div style={CS}>
              <SectionHead title="Rate History" />
              <div style={{ fontSize: 12, color: "#9E9B94", textAlign: "center" as const, padding: "24px 0" }}>No rate changes recorded</div>
            </div>

            {/* Rate Locks */}
            <div style={CS}>
              <SectionHead title="Rate Locks" />
              <OverviewTab client={profile} onUpdate={updateMut.mutateAsync} refetch={refetchProfile} />
            </div>

            {/* Home Images */}
            <div style={CS}>
              <SectionHead title="Home Images" />
              <HomeImagesSection clientId={clientId} />
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════
          TAB 3: JOBS — all historical and logged activity
          Full width, single column
         ══════════════════════════════════════════════ */}
      {activeTab === "jobs" && (
        <div>
          {/* Job Calendar */}
          <div style={CS}>
            <JobCalendar
                clientId={clientId}
                clientName={`${profile.first_name} ${profile.last_name}`}
                onScheduleOnDate={(iso) => { setWizardPresetDate(iso); setShowJobWizard(true); }}
              />
          </div>

          {/* Job History */}
          <div style={CS}>
            <JobHistoryPanel clientId={clientId} jhData={jhData} isLoading={jhLoading} profile={profile} />
          </div>

          {/* Scorecards */}
          <div style={CS}>
            <SectionHead title="Scorecards" action={<span style={{ fontSize: 11, color: "#9E9B94" }}>{(profile.scorecards || []).length} total</span>} />
            <ScorecardsTab scorecards={profile.scorecards || []} />
          </div>

          {/* Inspections */}
          <div style={CS}>
            <SectionHead title="Inspections" />
            <InspectionsSection />
          </div>

        </div>
      )}

      {/* ══════════════════════════════════════════════
          TAB 4: ADMIN — operational, not daily dispatch
          2-column grid top + full-width collapsibles below
         ══════════════════════════════════════════════ */}
      {activeTab === "admin" && (
        <div>
          {/* Top 2-column grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16, alignItems: "start" }}>
            {/* Left column */}
            <div>
              {/* Client Portal */}
              <div style={CS}>
                <SectionHead title="Client Portal" />
                <PortalTab clientId={clientId} client={profile} onPortalInvite={() => apiFetch(`/api/clients/${clientId}/portal-invite`, { method: "POST" })} refetch={refetchProfile} />
              </div>

              {/* Contacts & Notifications */}
              <div style={CS}>
                <SectionHead title="Contacts & Notifications" action={<span style={{ fontSize: 11, color: "#9E9B94" }}>{(profile.notification_settings || []).length} configured</span>} />
                <ContactsTab clientId={clientId} notifications={profile.notification_settings || []} refetch={refetchProfile} />
              </div>

              {/* Referrals */}
              <ReferralsCard
                clientId={clientId}
                referrals={referrals}
                refetch={refetchReferrals}
                showToast={showToast}
              />
            </div>

            {/* Right column */}
            <div>
              {/* Tech Preferences */}
              <div style={CS}>
                <SectionHead title="Technician Preferences" />
                {(profile.tech_preferences || []).some((p: any) => p.preference === "do_not_schedule") && (
                  <div style={{ background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#92400E", marginBottom: 10 }}>
                    Do Not Schedule preferences are enforced on the dispatch board. A warning will appear before assigning a flagged technician to this client.
                  </div>
                )}
                <TechPrefsTab clientId={clientId} prefs={profile.tech_preferences || []} refetch={refetchProfile} />
              </div>

              {/* Contact Tickets */}
              <div style={CS}>
                <SectionHead title="Contact Tickets" />
                <ContactTicketsSection clientId={clientId} />
              </div>

              {/* Agreements */}
              <div style={CS}>
                <SectionHead title="Agreements" action={
                  <button
                    onClick={() => apiFetch(`/api/clients/${clientId}/agreements/send`, { method: "POST", body: JSON.stringify({}) }).then(() => { refetchProfile(); showToast("Agreement sent"); }).catch(() => showToast("Failed to send", "error"))}
                    style={{ fontSize: 12, fontWeight: 600, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                  >Send Agreement</button>
                } />
                <AgreementsTab clientId={clientId} agreements={profile.agreements || []} refetch={refetchProfile} />
              </div>
            </div>
          </div>

          {/* Full-width collapsibles */}
          <CollapsibleSection title="Quotes">
            <QuotesTab clientId={clientId} client={profile} />
          </CollapsibleSection>

          <CollapsibleSection title="Attachments">
            <AttachmentsSection clientId={clientId} />
          </CollapsibleSection>
        </div>
      )}

      {/* ══════════════════════════════════════════════
          TAB 5: PROFITABILITY — owner/office only
         ══════════════════════════════════════════════ */}
      {activeTab === "profitability" && (
        <div style={{ padding: "24px 0" }}>
          <ProfitabilityTab clientId={clientId} />
        </div>
      )}
    </div>
  );

  // ─── Mobile Layout ─────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <DashboardLayout fullBleed>
        {toast && <Toast message={toast.message} type={toast.type} onDone={() => setToast(null)} />}
        {showMessageDrawer && <SendMessageDrawer client={profile} onClose={() => setShowMessageDrawer(false)} onToast={showToast} />}
        {showEditProfileDrawer && <EditProfileDrawer client={profile} onClose={() => setShowEditProfileDrawer(false)} onSave={updateMut.mutateAsync} onToast={showToast} />}
        <JobWizard
          open={showJobWizard}
          onClose={() => { setShowJobWizard(false); setWizardPresetDate(null); }}
          onCreated={() => { setShowJobWizard(false); setWizardPresetDate(null); refetchProfile(); qc.invalidateQueries({ queryKey: ["client-job-history", clientId] }); showToast("Job scheduled"); }}
          preselectedClient={profile ? { id: clientId, first_name: profile.first_name, last_name: profile.last_name, address: profile.address, phone: profile.phone, email: profile.email, client_type: profile.client_type, payment_method: profile.payment_method, net_terms: profile.net_terms, qb_status: profile.qb_status } : null}
          presetDate={wizardPresetDate}
        />
        <div style={{ display: "flex", flexDirection: "column", fontFamily: FF, background: "#F7F6F3", minHeight: "100dvh" }}>
          {/* Mobile hero (compact) */}
          <div style={{ background: "#FFFFFF", borderBottom: "1px solid #E5E2DC", padding: "12px 16px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
              <button onClick={goBack} style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer", color: "#9E9B94", fontSize: 13, padding: 0, fontFamily: FF }}>
                <ArrowLeft size={14} /><span>Clients</span>
              </button>
              <span style={{ color: "#D0CEC9" }}>/</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{profile.first_name} {profile.last_name}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <div style={{ width: 38, height: 38, borderRadius: "50%", background: "var(--brand-dim)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: "var(--brand)" }}>{initials}</span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: "#0A0E1A" }}>{profile.first_name} {profile.last_name}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 2 }}>
                  <span style={{ fontSize: 11, color: "#9E9B94" }}>CL-{String(profile.id).padStart(4, "0")}</span>
                  {profile.zone_color && profile.zone_name && (
                    <>
                      <span style={{ color: "#D0CEC9", fontSize: 11 }}>·</span>
                      <span style={{ width: 11, height: 11, borderRadius: "50%", backgroundColor: profile.zone_color, display: "inline-block", flexShrink: 0, boxShadow: `0 0 0 2px ${profile.zone_color}35` }} />
                      <span style={{ fontSize: 11, fontWeight: 600, color: profile.zone_color }}>{profile.zone_name}</span>
                    </>
                  )}
                </div>
              </div>
              <div style={{ background: "#0A0E1A", borderRadius: 8, padding: "6px 10px", textAlign: "center" as const, minWidth: 72 }}>
                <div style={{ fontSize: 14, fontWeight: 900, color: "#00C9A0", lineHeight: 1.2 }}>${ltv.toLocaleString("en-US", { maximumFractionDigits: 0 })}</div>
                <div style={{ fontSize: 8, fontWeight: 700, color: "#9CA3AF", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>LTV</div>
                {(jhStats?.ytd_revenue ?? 0) > 0 && (
                  <>
                    <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", marginTop: 4, paddingTop: 4 }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: "#60EFCE", lineHeight: 1.2 }}>${(jhStats?.ytd_revenue ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}</div>
                      <div style={{ fontSize: 7, fontWeight: 700, color: "#6B7280", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>2026</div>
                    </div>
                  </>
                )}
              </div>
            </div>
            {/* Mobile compact summary row */}
            <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#6B6860", marginBottom: 10 }}>
              {nextCleaning && <span>Next: <strong style={{ color: "var(--brand)" }}>{fmtDate(nextCleaning)}</strong></span>}
              <span>Visits: <strong style={{ color: "#1A1917" }}>{jhStats?.total_visits ?? 0}</strong></span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginBottom: 12 }}>
              <button onClick={() => setShowJobWizard(true)} style={{ padding: "9px", background: "var(--brand)", border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FF, minHeight: 40 }}>Schedule Job</button>
              <button onClick={() => navigate(`/quotes/new?client_id=${clientId}`)} style={{ padding: "9px", background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 8, color: "#1A1917", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF, minHeight: 40 }}>Quote</button>
              <button onClick={() => setShowMessageDrawer(true)} style={{ padding: "9px", background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 8, color: "#1A1917", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF, minHeight: 40 }}>Message</button>
              <button onClick={() => setShowEditProfileDrawer(true)} style={{ padding: "9px", background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 8, color: "#1A1917", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF, minHeight: 40 }}>Edit</button>
            </div>
            {/* Mobile tab bar */}
            <div style={{ display: "flex", overflowX: "auto" as const, gap: 0, marginLeft: -16, marginRight: -16, paddingLeft: 16 }}>
              {PROFILE_TABS.filter(tab => {
                if (tab.id !== "profitability") return true;
                const role = getTokenRole();
                return role === "owner" || role === "office";
              }).map(tab => (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{ padding: "8px 16px", border: "none", cursor: "pointer", fontFamily: FF, fontSize: 13, fontWeight: activeTab === tab.id ? 700 : 500, color: activeTab === tab.id ? "var(--brand)" : "#6B6860", background: "transparent", borderBottom: activeTab === tab.id ? "2px solid var(--brand)" : "2px solid transparent", marginBottom: -1, whiteSpace: "nowrap" as const, transition: "color 120ms" }}>
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          {/* Mobile tab content */}
          <div style={{ padding: "16px", paddingBottom: 80 }}>
            {activeTab === "client" && (<>
              <div style={CS}>
                <div style={CTitle}>Contact & Basic Info</div>
                {profile.phone && <DL2 label="Phone" value={<a href={`tel:${profile.phone}`} style={{ color: "var(--brand)", textDecoration: "none" }}>{profile.phone}</a>} />}
                {profile.email && <DL2 label="Email" value={<a href={`mailto:${profile.email}`} style={{ color: "var(--brand)", textDecoration: "none" }}>{profile.email}</a>} />}
                {profile.client_since && <DL2 label="Client Since" value={fmtDate(profile.client_since)} />}
                {profile.referral_source && <DL2 label="Source" value={SOURCE_LABELS[profile.referral_source] || String(profile.referral_source).replace(/_/g, " ")} />}
              </div>
              <div style={CS}>
                <div style={CTitle}>Billing & Payments</div>
                <CardOnFileTab client={profile} refetch={refetchProfile} />
              </div>
              <CollapsibleSection title="Invoices" count={invoices.length || undefined}>
                <BillingTab invoices={invoices} />
              </CollapsibleSection>
            </>)}
            {activeTab === "property" && (<>
              <div style={CS}>
                <div style={CTitle}>Service Addresses</div>
                <HomesTab clientId={clientId} homes={profile.homes || []} refetch={refetchProfile} zoneColor={profile.zone_color} zoneName={profile.zone_name} />
              </div>
              {(profile.home_access_notes || profile.alarm_code) && (
                <div style={CS}>
                  <div style={CTitle}>Access & Entry</div>
                  {profile.home_access_notes && <div style={{ fontSize: 13, color: "#374151", whiteSpace: "pre-wrap" as const, marginBottom: 8 }}>{profile.home_access_notes}</div>}
                  {profile.alarm_code && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#FEF9C3", border: "1px solid #FDE047", borderRadius: 8, padding: "8px 12px", marginTop: 4 }}>
                      <ShieldCheck size={13} style={{ color: "#A16207" }} />
                      <span style={{ fontSize: 12, color: "#A16207", fontWeight: 600 }}>Alarm:</span>
                      <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: showAlarmCode ? "normal" : "0.18em", fontFamily: "monospace", flex: 1 }}>
                        {showAlarmCode ? profile.alarm_code : "•".repeat(profile.alarm_code.length || 6)}
                      </span>
                      <button onClick={() => setShowAlarmCode(v => !v)} style={{ background: "none", border: "none", cursor: "pointer", color: "#A16207", padding: 0 }}>
                        {showAlarmCode ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div style={CS}>
                <div style={CTitle}>Recurring Schedule</div>
                <ServiceDetailsSection client={profile} onUpdate={updateMut.mutateAsync} refetch={refetchProfile} recurringSchedule={recurringSchedule} onToast={showToast} />
              </div>
              <div style={CS}>
                <div style={CTitle}>Client Notes</div>
                <textarea defaultValue={profile.notes || ""} onBlur={async (e) => { if (e.target.value !== (profile.notes || "")) { try { await updateMut.mutateAsync({ notes: e.target.value }); showToast("Notes saved"); } catch { showToast("Failed to save notes", "error"); } } }} placeholder="Internal notes..." rows={4} style={{ width: "100%", padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, color: "#374151", resize: "vertical" as const, outline: "none", fontFamily: FF, boxSizing: "border-box" as const, background: "#FAFAF8" }} />
              </div>
            </>)}
            {activeTab === "jobs" && (<>
              <div style={CS}>
                <JobCalendar
                clientId={clientId}
                clientName={`${profile.first_name} ${profile.last_name}`}
                onScheduleOnDate={(iso) => { setWizardPresetDate(iso); setShowJobWizard(true); }}
              />
              </div>
              <div style={CS}>
                <JobHistoryPanel clientId={clientId} jhData={jhData} isLoading={jhLoading} profile={profile} />
              </div>
            </>)}
            {activeTab === "admin" && (<>
              <CollapsibleSection title="Quotes"><QuotesTab clientId={clientId} client={profile} /></CollapsibleSection>
              <CollapsibleSection title="Agreements" count={(profile.agreements || []).length || undefined}><AgreementsTab clientId={clientId} agreements={profile.agreements || []} refetch={refetchProfile} /></CollapsibleSection>
              <CollapsibleSection title="Scorecards" count={(profile.scorecards || []).length || undefined}><ScorecardsTab scorecards={profile.scorecards || []} /></CollapsibleSection>
              <CollapsibleSection title="Contacts" count={(profile.notification_settings || []).length || undefined}><ContactsTab clientId={clientId} notifications={profile.notification_settings || []} refetch={refetchProfile} /></CollapsibleSection>
              <CollapsibleSection title="Portal"><PortalTab clientId={clientId} client={profile} onPortalInvite={() => apiFetch(`/api/clients/${clientId}/portal-invite`, { method: "POST" })} refetch={refetchProfile} /></CollapsibleSection>
              <CollapsibleSection title="Tech Preferences"><TechPrefsTab clientId={clientId} prefs={profile.tech_preferences || []} refetch={refetchProfile} /></CollapsibleSection>
            </>)}
            {activeTab === "profitability" && (
              <ProfitabilityTab clientId={clientId} />
            )}
          </div>
        </div>
      </DashboardLayout>
    );
  }

  // ─── Desktop Layout (3-panel) ─────────────────────────────────────────────
  return (
    <DashboardLayout fullBleed>
      {toast && <Toast message={toast.message} type={toast.type} onDone={() => setToast(null)} />}
      {showMessageDrawer && <SendMessageDrawer client={profile} onClose={() => setShowMessageDrawer(false)} onToast={showToast} />}
      {showEditProfileDrawer && <EditProfileDrawer client={profile} onClose={() => setShowEditProfileDrawer(false)} onSave={updateMut.mutateAsync} onToast={showToast} />}
      <JobWizard
        open={showJobWizard}
        onClose={() => { setShowJobWizard(false); setWizardPresetDate(null); }}
        onCreated={() => { setShowJobWizard(false); setWizardPresetDate(null); refetchProfile(); qc.invalidateQueries({ queryKey: ["client-job-history", clientId] }); showToast("Job scheduled"); }}
        preselectedClient={profile ? { id: clientId, first_name: profile.first_name, last_name: profile.last_name, address: profile.address, phone: profile.phone, email: profile.email, client_type: profile.client_type, payment_method: profile.payment_method, net_terms: profile.net_terms, qb_status: profile.qb_status } : null}
        presetDate={wizardPresetDate}
      />

      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", fontFamily: FF, background: "#F7F6F3" }}>
        {HeroStrip}
        <div style={{ flex: 1, overflow: "hidden", display: "flex" }}>
          {LeftPanel}
          {TabContent}
        </div>
      </div>
    </DashboardLayout>
  );
}
