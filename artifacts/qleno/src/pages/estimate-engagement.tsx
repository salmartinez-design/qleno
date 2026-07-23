import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { getAuthHeaders } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import {
  ArrowLeft, Mail, MessageSquare, Eye, MousePointerClick, Send, CheckCircle,
  XCircle, CornerUpLeft, Clock, ChevronDown, ChevronRight, Activity,
} from "lucide-react";

const FF = "'Plus Jakarta Sans', sans-serif";
const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const INK = "#1A1917";
const MUTE = "#6B6860";
const BORDER = "#E5E2DC";
const MINT = "var(--brand)";

async function apiFetch(path: string) {
  const r = await fetch(`${API}${path}`, { headers: getAuthHeaders() as Record<string, string> });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const money = (n: any) => `$${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const TOTAL_TOUCHES = 8;

const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  sent:     { bg: "#EFEFF2", fg: "#2F3646", label: "Sent" },
  viewed:   { bg: "#FDF3E4", fg: "#B45309", label: "Viewed" },
  accepted: { bg: "#E6F6F1", fg: "#047857", label: "Won" },
  declined: { bg: "#FCEBEA", fg: "#B3261E", label: "Lost" },
  expired:  { bg: "#F0EEE9", fg: "#6B6860", label: "Expired" },
  draft:    { bg: "#F0EEE9", fg: "#6B6860", label: "Draft" },
};

function StatusChip({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.draft;
  return <span style={{ padding: "3px 9px", borderRadius: 999, background: s.bg, color: s.fg, fontSize: 12, fontWeight: 700 }}>{s.label}</span>;
}

// Timeline event icon + color + label per event type.
const EVENT_META: Record<string, { icon: any; color: string; label: string }> = {
  sent:     { icon: Send, color: "#2F3646", label: "Touch sent" },
  opened:   { icon: Eye, color: "#B45309", label: "Email opened" },
  clicked:  { icon: MousePointerClick, color: "#9C4E2B", label: "Link clicked" },
  viewed:   { icon: Eye, color: "#0891B2", label: "Estimate viewed" },
  replied:  { icon: CornerUpLeft, color: "#0D9488", label: "Customer replied" },
  accepted: { icon: CheckCircle, color: "#047857", label: "Accepted" },
  declined: { icon: XCircle, color: "#B3261E", label: "Declined" },
  failed:   { icon: XCircle, color: "#9E9B94", label: "Send failed" },
};

function fmtTime(s: string | null) {
  if (!s) return "";
  const d = new Date(s);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function daysSince(s: string | null) {
  if (!s) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(s).getTime()) / 86400000));
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, padding: "16px 18px", flex: 1, minWidth: 130 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: INK, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: MUTE, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Timeline({ id }: { id: number }) {
  const { data, isLoading } = useQuery({ queryKey: ["estimate-engagement", id], queryFn: () => apiFetch(`/api/estimates/${id}/engagement`) });
  if (isLoading) return <div style={{ padding: 16, color: MUTE, fontSize: 13 }}>Loading timeline…</div>;
  if (!data) return null;
  const { counts, timeline, enrollment } = data;
  const events: any[] = timeline || [];

  const nextLine = (() => {
    if (!enrollment) return "Not enrolled in a drip";
    if (enrollment.stopped_at) return `Drip stopped (${enrollment.stopped_reason || "stopped"})`;
    if (enrollment.completed_at) return "Drip complete — all touches sent";
    if (enrollment.next_fire_at) return `Next: ${enrollment.next_channel === "sms" ? "SMS" : "email"} touch ${enrollment.current_step}/${enrollment.total_steps} · ${fmtTime(enrollment.next_fire_at)}`;
    return "Drip pending activation";
  })();

  return (
    <div style={{ padding: "4px 18px 18px 18px", background: "#FCFCFB", borderTop: `1px solid ${BORDER}` }}>
      <div style={{ display: "flex", gap: 18, padding: "12px 0", flexWrap: "wrap" }}>
        <MiniStat icon={Send} label="Touches" value={counts.touches_sent} />
        <MiniStat icon={Eye} label="Opens" value={counts.opened} />
        <MiniStat icon={MousePointerClick} label="Clicks" value={counts.clicked} />
        <MiniStat icon={Activity} label="Views" value={counts.viewed} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: INK, fontWeight: 600, padding: "6px 0 14px" }}>
        <Clock size={14} style={{ color: MINT }} /> {nextLine}
      </div>
      {events.length === 0 ? (
        <div style={{ fontSize: 13, color: MUTE, paddingBottom: 6 }}>No engagement events yet.</div>
      ) : (
        <div style={{ position: "relative", paddingLeft: 8 }}>
          {events.map((ev, i) => {
            const m = EVENT_META[ev.event_type] || { icon: Activity, color: MUTE, label: ev.event_type };
            const Icon = m.icon;
            const ch = ev.channel === "sms" ? MessageSquare : ev.channel === "email" ? Mail : null;
            return (
              <div key={i} style={{ display: "flex", gap: 10, paddingBottom: 14, position: "relative" }}>
                {i < events.length - 1 && <div style={{ position: "absolute", left: 11, top: 22, bottom: 0, width: 2, background: BORDER }} />}
                <div style={{ width: 24, height: 24, borderRadius: 999, background: "#fff", border: `2px solid ${m.color}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, zIndex: 1 }}>
                  <Icon size={12} style={{ color: m.color }} />
                </div>
                <div style={{ flex: 1, paddingTop: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: INK, display: "flex", alignItems: "center", gap: 6 }}>
                    {m.label}
                    {ch && <span style={{ color: MUTE }}>{(() => { const C = ch; return <C size={12} />; })()}</span>}
                  </div>
                  <div style={{ fontSize: 12, color: MUTE }}>{fmtTime(ev.occurred_at)}{ev.recipient ? ` · ${ev.recipient}` : ""}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MiniStat({ icon, label, value }: { icon: any; label: string; value: any }) {
  const Icon = icon;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <Icon size={15} style={{ color: MUTE }} />
      <span style={{ fontSize: 16, fontWeight: 800, color: INK }}>{Number(value || 0)}</span>
      <span style={{ fontSize: 12, color: MUTE }}>{label}</span>
    </div>
  );
}

export default function EstimateEngagementPage() {
  const [, navigate] = useLocation();
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data: summary } = useQuery({ queryKey: ["engagement-summary"], queryFn: () => apiFetch("/api/estimates/engagement/summary") });
  const { data: pipeline, isLoading } = useQuery({ queryKey: ["engagement-pipeline"], queryFn: () => apiFetch("/api/estimates/engagement/pipeline") });
  const { data: industry } = useQuery({ queryKey: ["engagement-by-industry"], queryFn: () => apiFetch("/api/estimates/engagement/by-industry") });
  const rows: any[] = pipeline?.data || [];
  const industryRows: any[] = industry?.data || [];
  const FACILITY_LABEL: Record<string, string> = {
    medical: "Medical", corporate_office: "Corporate office", industrial: "Industrial / warehouse",
    retail: "Retail", education: "Education", common_area: "Common area / HOA", religious: "Religious / nonprofit",
    other: "Other", unspecified: "Unspecified",
  };
  const fmt$ = (n: any) => `$${Math.round(Number(n || 0)).toLocaleString("en-US")}`;
  const bestIndustry = industryRows.filter(r => r.sent >= 1).slice().sort((a, b) => b.win_rate - a.win_rate)[0];

  return (
    <DashboardLayout>
      <div style={{ fontFamily: FF, maxWidth: 1100, margin: "0 auto", padding: "8px 4px 80px" }}>
        <button onClick={() => navigate("/estimates")} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "none", border: "none", color: MUTE, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF, padding: 0, marginBottom: 12 }}>
          <ArrowLeft size={15} /> Estimates
        </button>
        <h1 style={{ fontSize: 23, fontWeight: 800, color: INK, margin: "0 0 18px" }}>Estimate Engagement</h1>

        {/* Month summary */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
          <StatCard label="Sent" value={String(summary?.sent ?? 0)} sub="this month" />
          <StatCard label="Opened" value={`${summary?.opened_pct ?? 0}%`} sub={`${summary?.opened ?? 0} of ${summary?.sent ?? 0}`} />
          <StatCard label="Clicked" value={`${summary?.clicked_pct ?? 0}%`} sub={`${summary?.clicked ?? 0} of ${summary?.sent ?? 0}`} />
          <StatCard label="Won" value={String(summary?.won ?? 0)} sub={`${summary?.lost ?? 0} lost`} />
          <StatCard label="Avg touches / win" value={String(summary?.avg_touches_to_win ?? 0)} sub="to close" />
        </div>

        {/* Win rate by industry */}
        {industryRows.length > 0 && (
          <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, padding: "16px 18px", marginBottom: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
              <span style={{ fontSize: 13, fontWeight: 800, color: INK }}>Where we win — by industry</span>
              {bestIndustry && <span style={{ fontSize: 12, color: MUTE }}>Best close rate: <b style={{ color: "#0F6E56" }}>{FACILITY_LABEL[bestIndustry.facility_type] || bestIndustry.facility_type} ({bestIndustry.win_rate}%)</b></span>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
              {industryRows.map((r) => (
                <div key={r.facility_type} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 150, fontSize: 12.5, color: INK, flexShrink: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{FACILITY_LABEL[r.facility_type] || r.facility_type}</span>
                  <div style={{ flex: 1, background: "#F1EFE8", borderRadius: 6, height: 22 }}>
                    <div style={{ width: `${Math.max(2, r.win_rate)}%`, height: 22, borderRadius: 6, background: "var(--brand)" }} />
                  </div>
                  <span style={{ width: 150, textAlign: "right", fontSize: 12, color: MUTE, flexShrink: 0 }}><b style={{ color: INK }}>{r.win_rate}%</b> · {r.won}/{r.sent} · {fmt$(r.won_value)} won</span>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 12, borderTop: `1px solid #EEECE7`, paddingTop: 10 }}>Set a facility type on each estimate (under "Who it's for") to sharpen this breakdown.</div>
          </div>
        )}

        {/* Pipeline */}
        <h2 style={{ fontSize: 13, fontWeight: 800, color: INK, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 10px" }}>Pipeline</h2>
        <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.6fr 90px 70px 1fr 110px 90px", gap: 8, padding: "10px 14px", borderBottom: `1px solid ${BORDER}`, fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            <span>Recipient</span><span>Status</span><span>Day</span><span>Engagement</span><span>Amount</span><span>Last</span>
          </div>
          {isLoading ? (
            <div style={{ padding: 24, textAlign: "center", color: MUTE, fontSize: 13 }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: MUTE, fontSize: 13 }}>No sent estimates yet. Engagement appears here once you send one.</div>
          ) : rows.map((r) => {
            const isOpen = expanded === r.id;
            const day = daysSince(r.sent_at);
            const won = r.status === "accepted"; const lost = r.status === "declined";
            const active = !won && !lost && !r.stopped_at && !r.completed_at && r.current_step;
            return (
              <div key={r.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                <div
                  onClick={() => setExpanded(isOpen ? null : r.id)}
                  style={{ display: "grid", gridTemplateColumns: "1.6fr 90px 70px 1fr 110px 90px", gap: 8, padding: "12px 14px", alignItems: "center", cursor: "pointer", fontSize: 13, color: INK }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, minWidth: 0 }}>
                    {isOpen ? <ChevronDown size={14} style={{ color: MUTE, flexShrink: 0 }} /> : <ChevronRight size={14} style={{ color: MUTE, flexShrink: 0 }} />}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.recipient}</span>
                  </span>
                  <span><StatusChip status={r.status} /></span>
                  <span style={{ color: MUTE }}>{active && day != null ? `${Math.min(day, 16)}/16` : "—"}</span>
                  <span style={{ display: "flex", gap: 12, color: MUTE, fontSize: 12 }}>
                    <span title="opens"><Eye size={12} /> {Number(r.opened || 0)}</span>
                    <span title="clicks"><MousePointerClick size={12} /> {Number(r.clicked || 0)}</span>
                    <span title="touches sent"><Send size={12} /> {Number(r.touches_sent || 0)}</span>
                  </span>
                  <span style={{ fontWeight: 700 }}>{money(r.total)}</span>
                  <span style={{ color: MUTE, fontSize: 12 }}>{r.last_event_at ? fmtTime(r.last_event_at).split(",")[0] : "—"}</span>
                </div>
                {isOpen && <Timeline id={r.id} />}
              </div>
            );
          })}
        </div>
      </div>
    </DashboardLayout>
  );
}
