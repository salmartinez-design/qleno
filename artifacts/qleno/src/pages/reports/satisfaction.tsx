// Scorecard Results — MaidCentral-style post-job survey report.
// [scorecard-report 2026-07-07] Rewritten from the legacy NPS overview per
// owner direction: the scorecard satisfaction survey (0–4) is THE post-job
// feedback system, so this report mirrors MaidCentral's Scorecard Results —
// Returned / Sent / Response Rate / Average Score KPIs over a date range,
// one row per survey with response badge, trend vs the customer's previous
// score, comments, CSV export, and a Resend action (force-bypasses the
// 30-day throttle since it's an explicit office action).
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { TrendingUp, TrendingDown, Download, Send } from "lucide-react";
import {
  KpiCard, DateRange, ReportHeader, DataTable, useReportData, clr, fmtDate, fmtSvc,
} from "./_shared";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Row {
  id: number; job_id: number | null; customer_id: number;
  sent_at: string; responded_at: string | null; survey_score: number | null;
  comment: string | null; follow_up_required: boolean;
  customer_name: string; client_email: string | null; client_phone: string | null;
  job_date: string | null; service_type: string | null; techs: string | null;
  trend: "up" | "down" | "flat" | null;
}
interface Results {
  from: string; to: string;
  kpis: { sent: number; returned: number; response_rate: number; avg_score_pct: number | null };
  data: Row[];
}

// Same 0–4 scale + wording the survey page shows the customer.
const SCORE_BADGES: Record<number, { label: string; bg: string; fg: string }> = {
  4: { label: "4 - We're Thrilled - Great Work",      bg: "#16A34A", fg: "#FFFFFF" },
  3: { label: "3 - We're Happy - Good Work",          bg: "#4F46E5", fg: "#FFFFFF" },
  2: { label: "2 - We've Got a Few Concerns",         bg: "#D97706", fg: "#FFFFFF" },
  1: { label: "1 - Major Concerns",                   bg: "#DC2626", fg: "#FFFFFF" },
  0: { label: "0 - Considering Another Company",      bg: "#991B1B", fg: "#FFFFFF" },
};

function ResponseBadge({ score }: { score: number | null }) {
  if (score == null) return <span style={{ fontSize: 12, color: clr.muted }}>—</span>;
  const b = SCORE_BADGES[score] ?? SCORE_BADGES[0];
  return (
    <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 5, fontSize: 11, fontWeight: 700, background: b.bg, color: b.fg, whiteSpace: "nowrap" }}>
      {b.label}
    </span>
  );
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function SatisfactionReportPage() {
  const today = new Date();
  const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const [from, setFrom] = useState(ymd(monthAgo));
  const [to, setTo] = useState(ymd(today));
  const [responsesOnly, setResponsesOnly] = useState(false);
  const [resending, setResending] = useState<number | null>(null);
  const [resent, setResent] = useState<Set<number>>(new Set());

  const { data, loading, reload } = useReportData<Results>(`/satisfaction/scorecard-results?from=${from}&to=${to}`);
  const kpis = data?.kpis;
  const rows = useMemo(() => {
    const all = data?.data ?? [];
    return responsesOnly ? all.filter(r => r.responded_at) : all;
  }, [data, responsesOnly]);

  async function resend(row: Row) {
    if (!row.job_id || resending) return;
    setResending(row.id);
    try {
      const r = await fetch(`${API}/api/satisfaction/send`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" } as Record<string, string>,
        body: JSON.stringify({ job_id: row.job_id, customer_id: row.customer_id, force: true }),
      });
      if (r.ok) setResent(prev => new Set(prev).add(row.id));
    } catch { /* row stays resendable */ }
    setResending(null);
  }

  function exportCsv() {
    const header = ["Customer", "Job Date", "Sent To", "Techs", "Sent", "Response Date", "Score", "Comment"];
    const lines = rows.map(r => [
      r.customer_name, r.job_date ?? "", r.client_email || r.client_phone || "", r.techs ?? "",
      r.sent_at?.slice(0, 10) ?? "", r.responded_at?.slice(0, 10) ?? "",
      r.survey_score ?? "", r.comment ?? "",
    ].map(csvEscape).join(","));
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `scorecard-results-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const cols = [
    { header: "Customer", render: (r: Row) => (
      <Link href={`/customers/${r.customer_id}`}><span style={{ color: "var(--brand)", cursor: "pointer", fontWeight: 500 }}>{r.customer_name || "—"}</span></Link>
    ) },
    { header: "Service", render: (r: Row) => <span style={{ color: clr.secondary }}>{r.service_type ? fmtSvc(r.service_type) : "—"}</span> },
    { header: "Job Date", render: (r: Row) => fmtDate(r.job_date) },
    { header: "Sent To", render: (r: Row) => <span style={{ color: clr.secondary, fontSize: 12 }}>{r.client_email || r.client_phone || "—"}</span> },
    { header: "Techs", render: (r: Row) => <span style={{ color: clr.secondary }}>{r.techs || "—"}</span> },
    { header: "Response Date", render: (r: Row) => fmtDate(r.responded_at) },
    { header: "Last Sent", render: (r: Row) => fmtDate(r.sent_at) },
    { header: "Response", render: (r: Row) => <ResponseBadge score={r.survey_score} /> },
    { header: "Trend", align: "center" as const, render: (r: Row) =>
      r.trend === "up" ? <TrendingUp size={15} color={clr.green} />
      : r.trend === "down" ? <TrendingDown size={15} color={clr.red} />
      : <span style={{ color: clr.muted }}>{r.trend === "flat" ? "→" : ""}</span> },
    { header: "Comments", render: (r: Row) => (
      <span style={{ display: "block", maxWidth: 340, fontSize: 12, color: clr.secondary, whiteSpace: "normal" }}>{r.comment || ""}</span>
    ) },
    { header: "", align: "right" as const, render: (r: Row) => r.responded_at ? null : (
      <button onClick={() => resend(r)} disabled={resending === r.id || resent.has(r.id) || !r.job_id}
        title={resent.has(r.id) ? "Survey resent" : "Resend the survey to this customer"}
        style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", fontSize: 11, fontWeight: 600,
          color: resent.has(r.id) ? clr.green : clr.secondary, background: "none",
          border: `1px solid ${resent.has(r.id) ? clr.green : clr.border}`, borderRadius: 6,
          cursor: resent.has(r.id) ? "default" : "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
        <Send size={11} /> {resending === r.id ? "Sending…" : resent.has(r.id) ? "Resent" : "Resend"}
      </button>
    ) },
  ];

  return (
    <DashboardLayout>
      <div style={{ padding: 24, maxWidth: 1400, margin: "0 auto" }}>
        <ReportHeader
          title="Scorecard Results"
          subtitle="Post-job satisfaction surveys — responses feed each tech's scorecard."
          filters={
            <>
              <DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: clr.secondary, cursor: "pointer" }}>
                <input type="checkbox" checked={responsesOnly} onChange={e => setResponsesOnly(e.target.checked)} />
                Only show responses
              </label>
              <button onClick={reload}
                style={{ padding: "6px 14px", fontSize: 12, fontWeight: 600, color: "#FFFFFF", background: "var(--brand)", border: "none", borderRadius: 7, cursor: "pointer", fontFamily: "inherit" }}>
                Update
              </button>
              <button onClick={exportCsv} disabled={!rows.length}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", fontSize: 12, fontWeight: 600, color: clr.secondary, background: clr.card, border: `1px solid ${clr.border}`, borderRadius: 7, cursor: "pointer", fontFamily: "inherit", marginLeft: "auto" }}>
                <Download size={13} /> CSV
              </button>
            </>
          }
        />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
          <KpiCard label="Returned" value={kpis ? String(kpis.returned) : "—"} color={clr.text} />
          <KpiCard label="Sent" value={kpis ? String(kpis.sent) : "—"} color={clr.text} />
          <KpiCard label="Response Rate" value={kpis ? `${kpis.response_rate}%` : "—"} color={clr.brand} />
          <KpiCard label="Average Score" value={kpis?.avg_score_pct != null ? `${kpis.avg_score_pct}%` : "—"}
            color={kpis?.avg_score_pct != null && kpis.avg_score_pct < 75 ? clr.red : clr.green}
            sub="Average of 0–4 responses" />
        </div>

        <DataTable cols={cols} rows={rows} loading={loading}
          emptyMsg={responsesOnly ? "No responses in this period." : "No surveys sent in this period."} />
      </div>
    </DashboardLayout>
  );
}
