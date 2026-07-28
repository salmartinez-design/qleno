// Scorecard Report — the one company-wide scorecard.
// [scorecard-consolidation 2026-07-28] Consolidates the two thin legacy reports
// (Performance Score Results + Quality & Efficiency) into a single definitive
// view that crosses technician × branch × channel × time: the full 60/25/15
// composite breakdown, satisfaction & response trend, per-tech table, by-branch
// + by-channel tables, score distribution, efficiency, and a verbatim comment
// feed with Reply / Resend / Dismiss actions. Owner/admin/office only — the
// backing endpoint is role-gated and the nav card renders only for office roles.
// Payload: GET /api/scorecards/company-report (one call).
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useBranch } from "@/contexts/branch-context";
import { getAuthHeaders } from "@/lib/auth";
import { Download } from "lucide-react";
import { ReportHeader, DateRange, useReportData, clr, fmtSvc } from "./_shared";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface TechRow {
  user_id: number; name: string;
  composite_pct: number | null; satisfaction_pct: number | null;
  attendance_pct: number | null; complaint_free_pct: number | null;
  responses: number; response_rate_pct: number | null; efficiency_pct: number | null;
}
interface JobTypeRow { type: string; sent: number; returned: number; response_rate_pct: number; avg_score: number | null }
// [all-surveys] Per-survey rows from /api/satisfaction/scorecard-results — the
// full sent-survey list carried over from the retired "Scorecard Results" page.
interface SurveyRow {
  id: number; job_id: number | null; customer_id: number;
  sent_at: string; responded_at: string | null; survey_score: number | null;
  comment: string | null; follow_up_required: boolean;
  customer_name: string; client_email: string | null; client_phone: string | null;
  job_date: string | null; service_type: string | null; techs: string | null;
  trend: "up" | "down" | "flat" | null;
}
interface SurveyResults {
  from: string; to: string;
  kpis: { sent: number; returned: number; response_rate: number; avg_score_pct: number | null };
  data: SurveyRow[];
}
interface Comment {
  id: number; job_id: number | null; customer: string; customer_id: number | null;
  tech: string; score: number | null; max: number; comment: string;
  follow_up_required: boolean; office_reply: string | null; dismissed_at: string | null;
}
interface Report {
  window: { from: string; to: string; label: string };
  composite_window_days: number;
  weights: { satisfaction: number; attendance: number; complaint_free: number };
  kpis: {
    composite_pct: number | null; satisfaction_pct: number | null; avg_score: number | null;
    surveys_sent: number; surveys_returned: number; response_rate_pct: number;
    follow_ups_flagged: number; dismissed_count: number; efficiency_pct: number | null;
  };
  composite: { composite_pct: number | null; satisfaction_pct: number | null; attendance_pct: number | null; complaint_free_pct: number | null; weights: { satisfaction: number; attendance: number; complaint_free: number } };
  technicians: TechRow[];
  company_totals: { composite_pct: number | null; satisfaction_pct: number | null; attendance_pct: number | null; complaint_free_pct: number | null; responses: number; response_rate_pct: number };
  by_branch: { branch: string; satisfaction_pct: number | null; response_rate_pct: number | null; surveys: number }[];
  by_channel: { channel: string; sent: number; returned: number; response_rate_pct: number }[];
  by_work_type: JobTypeRow[];
  by_job_type: JobTypeRow[];
  distribution: { score: number; count: number }[];
  trend: { week_start: string; satisfaction_pct: number | null; response_rate_pct: number | null }[];
  efficiency: { overall_pct: number | null; packages: { package: string; efficiency_pct: number | null; jobs: number; techs: number }[] };
  comments: Comment[];
}

const pct = (n: number | null | undefined, d = 0) => (n == null ? "—" : `${n.toFixed(d)}%`);
const effColor = (p: number | null) => (p == null ? clr.muted : p >= 100 ? clr.brand : p >= 80 ? clr.text : clr.red);
// Composite / satisfaction badge tiers (mockup: good ≥85, mid ≥70, bad below).
function badgeStyle(v: number | null): React.CSSProperties {
  if (v == null) return { background: "var(--hover, #F0EEE9)", color: clr.muted };
  if (v >= 85) return { background: "#E6F6F1", color: "#15803D" };
  if (v >= 70) return { background: "#FDF3E4", color: "#B45309" };
  return { background: "#FCEBEA", color: "#B3261E" };
}
function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase() ?? "").join("") || "—";
}
function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CARD: React.CSSProperties = { background: clr.card, border: `1px solid ${clr.border}`, borderRadius: 10 };
const SECLABEL: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: clr.muted, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 10px" };
const PANEL_T: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: clr.secondary, textTransform: "uppercase", letterSpacing: "0.06em" };

function KpiTile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div style={{ ...CARD, padding: "16px 18px", minHeight: 100, display: "flex", flexDirection: "column", justifyContent: "space-between", borderBottom: accent ? `3px solid ${clr.brand}` : `1px solid ${clr.border}` }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 11 }}>
          <span style={{ width: 3, height: 12, borderRadius: 2, background: clr.brand, flex: "none" }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: clr.secondary, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
        </div>
        <span style={{ fontSize: 28, fontWeight: 600, color: clr.text, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{value}</span>
      </div>
      {sub && <div style={{ fontSize: 12, color: clr.muted, marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

function SubRow({ name, weight, value }: { name: string; weight: number; value: number | null }) {
  return (
    <div style={{ margin: "14px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: clr.text }}>{name} <span style={{ fontSize: 11, color: clr.muted, fontWeight: 400 }}>· {weight}% weight</span></span>
        <span style={{ fontSize: 15, fontWeight: 600, color: clr.text, fontVariantNumeric: "tabular-nums" }}>{pct(value)}</span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: "#F0EEE9", overflow: "hidden" }}>
        <div style={{ height: "100%", borderRadius: 4, background: clr.brand, width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} />
      </div>
    </div>
  );
}

function TrendChart({ series }: { series: Report["trend"] }) {
  const W = 700, H = 190, x0 = 30, x1 = 690, yTop = 24, yBot = 158;
  const pts = series.length;
  const xAt = (i: number) => (pts <= 1 ? x1 : x0 + (i * (x1 - x0)) / (pts - 1));
  const yAt = (v: number) => yBot - (Math.max(0, Math.min(100, v)) / 100) * (yBot - yTop);
  const line = (key: "satisfaction_pct" | "response_rate_pct") =>
    series.map((s, i) => (s[key] == null ? null : `${xAt(i)},${yAt(s[key]!)}`)).filter(Boolean).join(" ");
  const satPts = line("satisfaction_pct");
  const respPts = line("response_rate_pct");
  const lastSat = [...series].reverse().find(s => s.satisfaction_pct != null);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 190, display: "block" }} aria-label="Satisfaction and response trend">
      {[24, 70, 116, 158].map(y => <line key={y} x1={x0} y1={y} x2={x1} y2={y} stroke="#F0EEE9" strokeDasharray="3 3" />)}
      {[[27, "100"], [73, "75"], [119, "50"], [161, "25"]].map(([y, t]) => (
        <text key={t as string} x={24} y={y as number} textAnchor="end" fontSize={10} fill={clr.muted}>{t}</text>
      ))}
      {respPts && <polyline points={respPts} fill="none" stroke={clr.muted} strokeWidth={1.5} strokeDasharray="4 3" strokeLinejoin="round" />}
      {satPts && <polyline points={satPts} fill="none" stroke={clr.brand} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
      {satPts && lastSat && <circle cx={xAt(series.lastIndexOf(lastSat))} cy={yAt(lastSat.satisfaction_pct!)} r={4} fill={clr.brand} />}
      {series.map((s, i) => (
        <text key={s.week_start + i} x={xAt(i)} y={180} textAnchor="middle" fontSize={10} fill={clr.muted}>
          {i === series.length - 1 ? "Now" : `Wk ${i + 1}`}
        </text>
      ))}
    </svg>
  );
}

export default function ScorecardReportPage() {
  const { branches, activeBranchId, setActiveBranchId } = useBranch();
  const today = new Date();
  const monthAgo = new Date(today.getTime() - 27 * 24 * 60 * 60 * 1000);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const [from, setFrom] = useState(ymd(monthAgo));
  const [to, setTo] = useState(ymd(today));
  const [busy, setBusy] = useState<string | null>(null);
  const [showAllSurveys, setShowAllSurveys] = useState(false);
  const [responsesOnly, setResponsesOnly] = useState(false);
  const [resending, setResending] = useState<number | null>(null);
  const [resent, setResent] = useState<Set<number>>(new Set());

  // useReportData auto-appends branch_id from the navbar/branch switcher.
  const { data, loading, reload } = useReportData<Report>(`/scorecards/company-report?from=${from}&to=${to}`);
  // Full per-survey list (sent + returned + pending) — reuses the endpoint that
  // backed the retired "Scorecard Results" page, so that operational view lives on.
  const surveys = useReportData<SurveyResults>(`/satisfaction/scorecard-results?from=${from}&to=${to}`);
  const surveyRows = useMemo(() => {
    const all = surveys.data?.data ?? [];
    return responsesOnly ? all.filter(r => r.responded_at) : all;
  }, [surveys.data, responsesOnly]);
  const k = data?.kpis;
  const w = data?.composite.weights ?? { satisfaction: 60, attendance: 25, complaint_free: 15 };
  const distMax = useMemo(() => Math.max(1, ...(data?.distribution ?? []).map(d => d.count)), [data]);
  const totalResponses = useMemo(() => (data?.distribution ?? []).reduce((a, d) => a + d.count, 0), [data]);

  async function post(url: string, body: unknown): Promise<boolean> {
    setBusy(url);
    try {
      const r = await fetch(`${API}${url}`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" } as Record<string, string>,
        body: JSON.stringify(body),
      });
      return r.ok;
    } catch { return false; } finally { setBusy(null); }
  }
  async function onReply(c: Comment) {
    const reply = window.prompt("Office reply to this customer feedback:", c.office_reply ?? "");
    if (reply == null) return;
    if (await post(`/api/scorecards/entries/${c.id}/reply`, { reply })) reload();
  }
  async function onDismiss(c: Comment) {
    const reason = window.prompt("Reason for dismissing this rating (required):", "");
    if (reason == null || !reason.trim()) return;
    if (await post(`/api/scorecards/entries/${c.id}/dismiss`, { reason: reason.trim() })) reload();
  }
  async function onResend(c: Comment) {
    if (!c.job_id || !c.customer_id) return;
    if (await post(`/api/satisfaction/send`, { job_id: c.job_id, customer_id: c.customer_id, force: true })) reload();
  }
  // Resend from the full survey list (mirrors the retired page's Resend action).
  async function resendSurvey(row: SurveyRow) {
    if (!row.job_id || resending) return;
    setResending(row.id);
    if (await post(`/api/satisfaction/send`, { job_id: row.job_id, customer_id: row.customer_id, force: true })) {
      setResent(prev => new Set(prev).add(row.id));
    }
    setResending(null);
  }

  function exportCsv() {
    const rows = data?.technicians ?? [];
    const header = ["Technician", "Composite %", "Satisfaction %", "Attendance %", "Complaint-free %", "Efficiency %", "Responses", "Response rate %"];
    const lines = rows.map(r => [
      r.name, r.composite_pct ?? "", r.satisfaction_pct ?? "", r.attendance_pct ?? "",
      r.complaint_free_pct ?? "", r.efficiency_pct ?? "", r.responses, r.response_rate_pct ?? "",
    ].map(csvEscape).join(","));
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `scorecard-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const branchTabs = (
    <div style={{ display: "inline-flex", gap: 2, padding: 2, background: "#EFEDE8", borderRadius: 8 }}>
      {[{ id: "all" as const, name: "All branches" }, ...branches.map(b => ({ id: b.id, name: b.name }))].map(b => {
        const on = activeBranchId === b.id;
        return (
          <button key={String(b.id)} onClick={() => setActiveBranchId(b.id)}
            style={{ fontSize: 12, fontWeight: 600, padding: "6px 13px", borderRadius: 6, border: "none", cursor: "pointer",
              background: on ? clr.text : "transparent", color: on ? "#fff" : clr.secondary, fontFamily: "inherit" }}>
            {b.name}
          </button>
        );
      })}
    </div>
  );

  const th: React.CSSProperties = { padding: "11px 14px", fontSize: 11, fontWeight: 600, color: clr.secondary, letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap", textAlign: "left", borderBottom: `1px solid ${clr.border}` };
  const thR: React.CSSProperties = { ...th, textAlign: "right" };
  const tdR: React.CSSProperties = { padding: "0 14px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600, color: clr.text, whiteSpace: "nowrap" };

  return (
    <DashboardLayout title="Scorecard">
      <div style={{ padding: "24px 28px", maxWidth: 1200 }}>
        <ReportHeader
          title="Scorecard"
          subtitle={data ? `Customer satisfaction & performance · ${data.window.from} → ${data.window.to} · Trailing composite = ${data.composite_window_days} days` : "Customer satisfaction & performance"}
          filters={
            <>
              <DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
              {branches.length > 0 && branchTabs}
              <button onClick={exportCsv} disabled={!data?.technicians.length}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", fontSize: 12, fontWeight: 600, color: clr.secondary, background: clr.card, border: `1px solid ${clr.border}`, borderRadius: 7, cursor: "pointer", fontFamily: "inherit", marginLeft: "auto" }}>
                <Download size={13} /> Export CSV
              </button>
            </>
          }
        />

        {/* KPI row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 12 }}>
          <KpiTile accent label="Performance score" value={pct(k?.composite_pct)} sub={`company composite · ${data?.composite_window_days ?? 90}d`} />
          <KpiTile label="Customer satisfaction" value={pct(k?.satisfaction_pct)} sub={k?.avg_score != null ? `avg ${k.avg_score.toFixed(2)} / 4.0` : "no responses yet"} />
          <KpiTile label="Response rate" value={k ? `${k.response_rate_pct}%` : "—"} sub={k ? `${k.surveys_returned} returned of ${k.surveys_sent} sent` : undefined} />
          <KpiTile label="Follow-ups flagged" value={k ? String(k.follow_ups_flagged) : "—"} sub={k ? `${k.dismissed_count} dismissed this period` : undefined} />
        </div>

        {/* Composite breakdown + trend */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.6fr", gap: 12, margin: "12px 0" }}>
          <div style={{ ...CARD, padding: 20 }}>
            <div style={{ ...PANEL_T, marginBottom: 14 }}>Composite breakdown</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
              <span style={{ fontSize: 40, fontWeight: 600, color: clr.text, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{pct(data?.composite.composite_pct)}</span>
              <span style={{ fontSize: 14, color: clr.secondary }}>Performance score</span>
            </div>
            <p style={{ fontSize: 12, color: clr.muted, margin: "0 0 14px" }}>Weighted rolling composite · trailing {data?.composite_window_days ?? 90} days</p>
            <SubRow name="Customer satisfaction" weight={w.satisfaction} value={data?.composite.satisfaction_pct ?? null} />
            <SubRow name="Attendance" weight={w.attendance} value={data?.composite.attendance_pct ?? null} />
            <SubRow name="Complaint-free" weight={w.complaint_free} value={data?.composite.complaint_free_pct ?? null} />
          </div>

          <div style={{ ...CARD, padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
              <span style={PANEL_T}>Satisfaction &amp; response trend</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: clr.brand }}>Weekly</span>
            </div>
            <div style={{ display: "flex", gap: 16, marginBottom: 6, fontSize: 11, color: clr.secondary, alignItems: "center" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, height: 2, borderRadius: 1, background: clr.brand, display: "inline-block" }} />Satisfaction %</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, height: 2, borderRadius: 1, background: clr.muted, display: "inline-block" }} />Response rate %</span>
            </div>
            {data && data.trend.length > 0
              ? <TrendChart series={data.trend} />
              : <div style={{ height: 190, display: "grid", placeItems: "center", color: clr.muted, fontSize: 12 }}>{loading ? "Loading…" : "No survey activity in this period."}</div>}
          </div>
        </div>

        {/* By technician */}
        <p style={{ ...SECLABEL, marginBottom: 8 }}>By technician · full composite breakdown</p>
        <div style={{ ...CARD, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={th}>Technician</th>
                <th style={thR}>Composite</th><th style={thR}>Satisfaction</th><th style={thR}>Attendance</th>
                <th style={thR}>Complaint-free</th><th style={thR}>Efficiency</th><th style={thR}>Responses</th><th style={thR}>Resp. rate</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr><td colSpan={8} style={{ padding: 32, textAlign: "center", color: clr.muted }}>Loading…</td></tr>
              ) : (data?.technicians.length ?? 0) === 0 ? (
                <tr><td colSpan={8} style={{ padding: 32, textAlign: "center", color: clr.muted }}>No technician scores for this period.</td></tr>
              ) : data!.technicians.map(t => (
                <tr key={t.user_id} style={{ height: 52, borderBottom: `1px solid ${clr.border}` }}>
                  <td style={{ padding: "0 14px", whiteSpace: "nowrap" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <span style={{ width: 30, height: 30, borderRadius: 15, background: "rgba(0,201,160,.12)", color: "#0F7A63", fontSize: 11, fontWeight: 700, display: "grid", placeItems: "center", flex: "none" }}>{initials(t.name)}</span>
                      <span style={{ fontWeight: 600, color: clr.text }}>{t.name}</span>
                    </span>
                  </td>
                  <td style={tdR}><span style={{ display: "inline-block", padding: "2px 9px", borderRadius: 20, fontSize: 11, fontWeight: 600, fontVariantNumeric: "tabular-nums", ...badgeStyle(t.composite_pct) }}>{pct(t.composite_pct)}</span></td>
                  <td style={tdR}>{pct(t.satisfaction_pct)}</td>
                  <td style={tdR}>{pct(t.attendance_pct)}</td>
                  <td style={tdR}>{pct(t.complaint_free_pct)}</td>
                  <td style={{ ...tdR, color: effColor(t.efficiency_pct) }}>{pct(t.efficiency_pct)}</td>
                  <td style={tdR}>{t.responses}</td>
                  <td style={tdR}>{t.response_rate_pct == null ? "—" : `${t.response_rate_pct}%`}</td>
                </tr>
              ))}
            </tbody>
            {data && data.technicians.length > 0 && (
              <tfoot>
                <tr>
                  <td style={{ padding: "12px 14px", borderTop: `2px solid ${clr.border}`, fontWeight: 600, color: clr.secondary, textTransform: "uppercase", fontSize: 11, letterSpacing: "0.04em" }}>Company</td>
                  {[data.company_totals.composite_pct, data.company_totals.satisfaction_pct, data.company_totals.attendance_pct, data.company_totals.complaint_free_pct, data.efficiency.overall_pct].map((v, i) => (
                    <td key={i} style={{ padding: "12px 14px", borderTop: `2px solid ${clr.border}`, textAlign: "right", fontWeight: 700, color: clr.text, fontVariantNumeric: "tabular-nums" }}>{pct(v)}</td>
                  ))}
                  <td style={{ padding: "12px 14px", borderTop: `2px solid ${clr.border}`, textAlign: "right", fontWeight: 700, color: clr.text, fontVariantNumeric: "tabular-nums" }}>{data.company_totals.responses}</td>
                  <td style={{ padding: "12px 14px", borderTop: `2px solid ${clr.border}`, textAlign: "right", fontWeight: 700, color: clr.text, fontVariantNumeric: "tabular-nums" }}>{data.company_totals.response_rate_pct}%</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* By branch + By channel */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, margin: "12px 0" }}>
          <div style={{ ...CARD, padding: 20 }}>
            <div style={{ ...PANEL_T, marginBottom: 14 }}>By branch</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr><th style={th}>Branch</th><th style={thR}>Satisfaction</th><th style={thR}>Resp. rate</th><th style={thR}>Surveys</th></tr></thead>
              <tbody>
                {(data?.by_branch ?? []).map(b => (
                  <tr key={b.branch} style={{ height: 46, borderBottom: `1px solid ${clr.border}` }}>
                    <td style={{ padding: "0 14px", fontWeight: 600, color: clr.text }}>{b.branch}</td>
                    <td style={tdR}><span style={{ display: "inline-block", padding: "2px 9px", borderRadius: 20, fontSize: 11, fontWeight: 600, ...badgeStyle(b.satisfaction_pct) }}>{pct(b.satisfaction_pct)}</span></td>
                    <td style={tdR}>{pct(b.response_rate_pct)}</td>
                    <td style={tdR}>{b.surveys}</td>
                  </tr>
                ))}
                {(data?.by_branch.length ?? 0) === 0 && <tr><td colSpan={4} style={{ padding: 20, textAlign: "center", color: clr.muted }}>No branch data.</td></tr>}
              </tbody>
            </table>
          </div>
          <div style={{ ...CARD, padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
              <span style={PANEL_T}>By channel</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: clr.muted }}>inferred</span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr><th style={th}>Channel</th><th style={thR}>Sent</th><th style={thR}>Returned</th><th style={thR}>Resp. rate</th></tr></thead>
              <tbody>
                {(data?.by_channel ?? []).map(c => (
                  <tr key={c.channel} style={{ height: 46, borderBottom: `1px solid ${clr.border}` }}>
                    <td style={{ padding: "0 14px", fontWeight: 600, color: clr.text }}>{c.channel}</td>
                    <td style={tdR}>{c.sent}</td>
                    <td style={tdR}>{c.returned}</td>
                    <td style={tdR}>{c.response_rate_pct}%</td>
                  </tr>
                ))}
                {(data?.by_channel.length ?? 0) === 0 && <tr><td colSpan={4} style={{ padding: 20, textAlign: "center", color: clr.muted }}>No channel data.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {/* By job type & cadence */}
        <div style={{ ...CARD, padding: 20, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
            <span style={PANEL_T}>By job type &amp; cadence</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: clr.muted }}>One-time vs recurring · service · cadence</span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr><th style={th}>Type</th><th style={thR}>Surveys sent</th><th style={thR}>Returned</th><th style={thR}>Resp. rate</th><th style={thR}>Avg score</th></tr></thead>
            <tbody>
              {(data?.by_work_type ?? []).map(r => (
                <tr key={`w-${r.type}`} style={{ height: 46, borderBottom: `1px solid ${clr.border}`, background: "#FAFAF8" }}>
                  <td style={{ padding: "0 14px", fontWeight: 700, color: clr.text }}>{r.type}</td>
                  <td style={tdR}>{r.sent}</td><td style={tdR}>{r.returned}</td>
                  <td style={tdR}>{r.response_rate_pct}%</td>
                  <td style={tdR}>{r.avg_score == null ? "—" : `${r.avg_score.toFixed(2)} / 4`}</td>
                </tr>
              ))}
              {(data?.by_job_type ?? []).map(r => (
                <tr key={`t-${r.type}`} style={{ height: 44, borderBottom: `1px solid ${clr.border}` }}>
                  <td style={{ padding: "0 14px 0 26px", color: clr.text }}>{r.type}</td>
                  <td style={tdR}>{r.sent}</td><td style={tdR}>{r.returned}</td>
                  <td style={tdR}>{r.response_rate_pct}%</td>
                  <td style={tdR}>{r.avg_score == null ? "—" : `${r.avg_score.toFixed(2)} / 4`}</td>
                </tr>
              ))}
              {(data?.by_job_type.length ?? 0) === 0 && (data?.by_work_type.length ?? 0) === 0 && (
                <tr><td colSpan={5} style={{ padding: 20, textAlign: "center", color: clr.muted }}>No surveys in this period.</td></tr>
              )}
            </tbody>
          </table>
          <p style={{ fontSize: 11, color: clr.muted, margin: "12px 0 0" }}>Recurring = has a recurring schedule, a real cadence, or a recurring service; one-time otherwise. Cadence rows use the job frequency.</p>
        </div>

        {/* Efficiency by service */}
        <p style={{ ...SECLABEL, marginBottom: 8 }}>Efficiency by service · Allowed ÷ Actual job hours {data?.efficiency.overall_pct != null && <span style={{ textTransform: "none", letterSpacing: 0, color: effColor(data.efficiency.overall_pct), fontWeight: 700 }}>· company {pct(data.efficiency.overall_pct)}</span>}</p>
        <div style={{ ...CARD, overflow: "auto", marginBottom: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr><th style={th}>Package</th><th style={thR}>Efficiency</th><th style={thR}>Jobs</th><th style={thR}>Techs</th></tr></thead>
            <tbody>
              {(data?.efficiency.packages ?? []).map(p => (
                <tr key={p.package} style={{ height: 46, borderBottom: `1px solid ${clr.border}` }}>
                  <td style={{ padding: "0 14px", color: clr.text }}>{fmtSvc(p.package)}</td>
                  <td style={{ ...tdR, color: effColor(p.efficiency_pct) }}>{pct(p.efficiency_pct)}</td>
                  <td style={tdR}>{p.jobs}</td>
                  <td style={tdR}>{p.techs}</td>
                </tr>
              ))}
              {(data?.efficiency.packages.length ?? 0) === 0 && <tr><td colSpan={4} style={{ padding: 20, textAlign: "center", color: clr.muted }}>No efficiency data for this period.</td></tr>}
            </tbody>
          </table>
        </div>

        {/* Distribution + verbatim */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, margin: "12px 0" }}>
          <div style={{ ...CARD, padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
              <span style={PANEL_T}>Score distribution</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: clr.muted }}>{totalResponses} responses</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, alignItems: "end", height: 150, marginTop: 6 }}>
              {(data?.distribution ?? [0, 1, 2, 3, 4].map(s => ({ score: s, count: 0 }))).map(d => {
                const color = d.score <= 1 ? "#B3261E" : d.score === 2 ? "#B45309" : clr.brand;
                return (
                  <div key={d.score} style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%", gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: clr.text, fontVariantNumeric: "tabular-nums" }}>{d.count}</span>
                    <div style={{ width: "100%", maxWidth: 52, borderRadius: "6px 6px 0 0", background: color, height: `${Math.max(2, (d.count / distMax) * 100)}%` }} />
                    <span style={{ fontSize: 11, color: clr.secondary, fontWeight: 600 }}>{d.score}</span>
                  </div>
                );
              })}
            </div>
            <p style={{ fontSize: 11, color: clr.muted, margin: "14px 0 0", textAlign: "center" }}>Score (0 = very unhappy · 4 = delighted)</p>
          </div>

          <div style={{ ...CARD, padding: 20 }}>
            <div style={{ ...PANEL_T, marginBottom: 14 }}>Recent comments</div>
            {(data?.comments.length ?? 0) === 0 && <div style={{ padding: "8px 0", color: clr.muted, fontSize: 12.5 }}>No comments in this period.</div>}
            {(data?.comments ?? []).map((c, i) => {
              const scoreBadge = c.score == null ? null : { display: "inline-block", padding: "2px 9px", borderRadius: 20, fontSize: 11, fontWeight: 600, ...badgeStyle((c.score / (c.max || 4)) * 100) } as React.CSSProperties;
              return (
                <div key={c.id} style={{ borderTop: i === 0 ? "none" : "1px solid #EEECE7", padding: "13px 0" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
                    {c.customer_id
                      ? <Link href={`/customers/${c.customer_id}`}><span style={{ fontWeight: 600, color: clr.text, fontSize: 12.5, cursor: "pointer" }}>{c.customer}</span></Link>
                      : <span style={{ fontWeight: 600, color: clr.text, fontSize: 12.5 }}>{c.customer}</span>}
                    {scoreBadge && <span style={scoreBadge}>{c.score}/{c.max || 4}</span>}
                    <span style={{ fontSize: 11, color: clr.muted }}>{c.job_id ? `Job #${c.job_id}` : ""}{c.tech && c.tech !== "—" ? ` · ${c.tech}` : ""}</span>
                    {c.follow_up_required && <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", padding: "2px 7px", borderRadius: 4, background: "#FDF3E4", color: "#B45309" }}>Follow-up</span>}
                    {c.dismissed_at && <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", padding: "2px 7px", borderRadius: 4, background: "#F0EEE9", color: clr.muted }}>Dismissed</span>}
                  </div>
                  <div style={{ fontSize: 12.5, color: "#4A4845" }}>{c.comment}</div>
                  {c.office_reply && <div style={{ marginTop: 6, fontSize: 12, color: clr.secondary, borderLeft: `2px solid ${clr.border}`, paddingLeft: 10 }}>Office: {c.office_reply}</div>}
                  <div style={{ display: "flex", gap: 14, marginTop: 7, fontSize: 11, fontWeight: 600 }}>
                    <button onClick={() => onReply(c)} disabled={!!busy} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: clr.brand, fontFamily: "inherit", fontWeight: 600, fontSize: 11 }}>Reply</button>
                    <button onClick={() => onResend(c)} disabled={!!busy || !c.job_id || !c.customer_id} style={{ background: "none", border: "none", padding: 0, cursor: c.job_id && c.customer_id ? "pointer" : "default", color: c.job_id && c.customer_id ? clr.brand : clr.muted, fontFamily: "inherit", fontWeight: 600, fontSize: 11 }}>Resend</button>
                    <button onClick={() => onDismiss(c)} disabled={!!busy || !!c.dismissed_at} style={{ background: "none", border: "none", padding: 0, cursor: c.dismissed_at ? "default" : "pointer", color: c.dismissed_at ? clr.muted : clr.red, fontFamily: "inherit", fontWeight: 600, fontSize: 11 }}>Dismiss</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* All surveys — the full sent-survey list (returned + pending), from the
            retired "Scorecard Results" page. Collapsible; filter + Resend survive. */}
        <div style={{ ...CARD, overflow: "hidden", marginBottom: 12 }}>
          <button onClick={() => setShowAllSurveys(v => !v)}
            style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "14px 18px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={PANEL_T}>All surveys</span>
              <span style={{ fontSize: 11, color: clr.muted }}>{surveys.data ? `${surveys.data.kpis.returned} returned of ${surveys.data.kpis.sent} sent` : ""}</span>
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: clr.brand }}>{showAllSurveys ? "Hide ▲" : "Show all sent + pending ▼"}</span>
          </button>
          {showAllSurveys && (
            <div style={{ borderTop: `1px solid ${clr.border}`, padding: "12px 18px 18px" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: clr.secondary, cursor: "pointer", marginBottom: 12 }}>
                <input type="checkbox" checked={responsesOnly} onChange={e => setResponsesOnly(e.target.checked)} /> Only show responses
              </label>
              <div style={{ overflow: "auto", border: `1px solid ${clr.border}`, borderRadius: 8 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead><tr>
                    <th style={th}>Customer</th><th style={th}>Service</th><th style={th}>Job date</th>
                    <th style={th}>Techs</th><th style={th}>Sent</th><th style={th}>Responded</th>
                    <th style={thR}>Score</th><th style={th}>Comment</th><th style={thR}></th>
                  </tr></thead>
                  <tbody>
                    {surveys.loading && !surveys.data ? (
                      <tr><td colSpan={9} style={{ padding: 24, textAlign: "center", color: clr.muted }}>Loading…</td></tr>
                    ) : surveyRows.length === 0 ? (
                      <tr><td colSpan={9} style={{ padding: 24, textAlign: "center", color: clr.muted }}>{responsesOnly ? "No responses in this period." : "No surveys sent in this period."}</td></tr>
                    ) : surveyRows.map(r => (
                      <tr key={r.id} style={{ borderBottom: `1px solid ${clr.border}` }}>
                        <td style={{ padding: "9px 14px" }}>
                          <Link href={`/customers/${r.customer_id}`}><span style={{ color: clr.brand, cursor: "pointer", fontWeight: 500 }}>{r.customer_name || "—"}</span></Link>
                        </td>
                        <td style={{ padding: "9px 14px", color: clr.secondary }}>{r.service_type ? fmtSvc(r.service_type) : "—"}</td>
                        <td style={{ padding: "9px 14px", color: clr.secondary, whiteSpace: "nowrap" }}>{r.job_date ? r.job_date.slice(0, 10) : "—"}</td>
                        <td style={{ padding: "9px 14px", color: clr.secondary }}>{r.techs || "—"}</td>
                        <td style={{ padding: "9px 14px", color: clr.secondary, whiteSpace: "nowrap" }}>{r.sent_at?.slice(0, 10) ?? "—"}</td>
                        <td style={{ padding: "9px 14px", whiteSpace: "nowrap" }}>{r.responded_at ? <span style={{ color: clr.text }}>{r.responded_at.slice(0, 10)}</span> : <span style={{ fontSize: 11, fontWeight: 600, color: "#B45309", background: "#FDF3E4", padding: "2px 7px", borderRadius: 4 }}>Pending</span>}</td>
                        <td style={tdR}>{r.survey_score == null ? "—" : `${r.survey_score}/4`}</td>
                        <td style={{ padding: "9px 14px", color: clr.secondary, maxWidth: 280, whiteSpace: "normal" }}>{r.comment || ""}</td>
                        <td style={{ padding: "9px 14px", textAlign: "right" }}>
                          {r.responded_at ? null : (
                            <button onClick={() => resendSurvey(r)} disabled={resending === r.id || resent.has(r.id) || !r.job_id}
                              style={{ fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 6, border: `1px solid ${resent.has(r.id) ? clr.green : clr.border}`, background: "none", cursor: resent.has(r.id) ? "default" : "pointer", color: resent.has(r.id) ? clr.green : clr.secondary, fontFamily: "inherit", whiteSpace: "nowrap" }}>
                              {resending === r.id ? "Sending…" : resent.has(r.id) ? "Resent" : "Resend"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
