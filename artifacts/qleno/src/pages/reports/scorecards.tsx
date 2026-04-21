import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmtDate, fmtSvc, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData, ScoreBadge } from "./_shared";

function today() { return new Date().toISOString().split("T")[0]; }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().split("T")[0]; }

interface SCRow { id: number; score: number; comments: string | null; excluded: boolean; date: string; client_name: string; employee_name: string; service_type: string; job_date: string; }
interface SCData { from: string; to: string; data: SCRow[]; summary: { total: number; avg_score: number; distribution: { score: number; count: number }[] }; }

export default function ScorecardsReportPage() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const [minScore, setMinScore] = useState<number | null>(null);

  const { data, loading } = useReportData<SCData>(`/reports/scorecards?from=${from}&to=${to}`);
  const allRows = data?.data ?? [];
  const rows = minScore !== null ? allRows.filter(r => r.score <= minScore) : allRows;
  const s = data?.summary;

  const scoreColors: Record<number,string> = { 4: clr.green, 3: "#3B82F6", 2: clr.amber, 1: clr.red, 0: clr.muted };

  const cols = [
    { header: "Date", render: (r: SCRow) => fmtDate(r.date) },
    { header: "Client", key: "client_name" as const, render: (r: SCRow) => <span style={{ fontWeight: 500 }}>{r.client_name}</span> },
    { header: "Employee", key: "employee_name" as const },
    { header: "Service", render: (r: SCRow) => fmtSvc(r.service_type) },
    { header: "Score", render: (r: SCRow) => <ScoreBadge score={r.score} /> },
    { header: "Comments", render: (r: SCRow) => r.comments ? <span style={{ color: clr.secondary, fontSize: 12, maxWidth: 220, display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>{r.comments}</span> : <span style={{ color: clr.muted }}>—</span> },
    { header: "Status", render: (r: SCRow) => r.excluded ? <span style={{ fontSize: 11, color: clr.muted, fontStyle: "italic" }}>Excluded</span> : null },
  ];

  return (
    <DashboardLayout title="Scorecard Results">
      <div style={{ padding: "24px 28px", maxWidth: 1100 }}>
        <ReportHeader
          title="Scorecard Results"
          subtitle="Client ratings and feedback by employee."
          printable
          filters={
            <>
              <DateRange from={from} to={to} onChange={(f,t) => { setFrom(f); setTo(t); }} />
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13, color: clr.secondary, fontWeight: 500 }}>Max score:</span>
                {[null, 3, 2, 1].map(v => (
                  <button key={String(v)} onClick={() => setMinScore(v)} style={{ padding: "5px 10px", fontSize: 12, fontWeight: 500, border: `1px solid ${clr.border}`, borderRadius: 5, cursor: "pointer", fontFamily: "inherit", backgroundColor: minScore === v ? clr.brand : clr.card, color: minScore === v ? "#fff" : clr.secondary }}>
                    {v === null ? "All" : `${v}/4 and below`}
                  </button>
                ))}
              </div>
            </>
          }
        />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Total Scorecards" value={String(s?.total ?? 0)} />
          <KpiCard label="Avg Score" value={`${(s?.avg_score ?? 0).toFixed(2)}/4`} color={(s?.avg_score ?? 0) >= 3.5 ? clr.green : (s?.avg_score ?? 0) >= 2.5 ? clr.amber : clr.red} />
          {s?.distribution.map(d => (
            <div key={d.score} style={{ backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 8, padding: "12px 16px", minWidth: 80 }}>
              <p style={{ margin: "0 0 4px", fontSize: 11, fontWeight: 600, color: clr.muted, textTransform: "uppercase" }}>{d.score}/4</p>
              <p style={{ margin: 0, fontSize: 20, fontWeight: 700, color: scoreColors[d.score] ?? clr.muted }}>{d.count}</p>
            </div>
          ))}
        </div>

        <DataTable cols={cols} rows={rows} loading={loading} emptyMsg="No scorecards in this date range." />
      </div>
    </DashboardLayout>
  );
}
