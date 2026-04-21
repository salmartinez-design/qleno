import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$, fmtH, fmtPct, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData, ScoreBadge, EffBar } from "./_shared";

function today() { return new Date().toISOString().split("T")[0]; }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().split("T")[0]; }

interface EmpStatRow {
  id: number; name: string; avatar_url: string | null;
  days_worked: number; jobs_completed: number; job_hours: number; clock_hours: number;
  efficiency_pct: number; revenue_generated: number; scorecard_avg: number; tips_earned: number; attendance_score: number;
}
interface EmpStatsData { from: string; to: string; data: EmpStatRow[]; }

export default function EmployeeStatsPage() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());

  const { data, loading } = useReportData<EmpStatsData>(`/reports/employee-stats?from=${from}&to=${to}`);
  const rows = data?.data ?? [];

  const avgRev = rows.length > 0 ? rows.reduce((s,r) => s + r.revenue_generated, 0) / rows.length : 0;

  const cols = [
    { header: "Employee", render: (r: EmpStatRow) => (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {r.avatar_url
          ? <img src={r.avatar_url} alt={r.name} style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover" }} />
          : <div style={{ width: 28, height: 28, borderRadius: "50%", backgroundColor: "var(--brand-soft)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700 }}>{r.name.split(" ").map(n => n[0]).join("").toUpperCase()}</div>
        }
        <span style={{ fontWeight: 500 }}>{r.name}</span>
      </div>
    )},
    { header: "Days", key: "days_worked" as const, align: "right" as const },
    { header: "Jobs", key: "jobs_completed" as const, align: "right" as const },
    { header: "Job Hrs", render: (r: EmpStatRow) => fmtH(r.job_hours), align: "right" as const },
    { header: "Clock Hrs", render: (r: EmpStatRow) => fmtH(r.clock_hours), align: "right" as const },
    { header: "Efficiency", render: (r: EmpStatRow) => <EffBar pct={r.efficiency_pct} />, width: 140 },
    { header: "Revenue", render: (r: EmpStatRow) => <span style={{ fontWeight: r.revenue_generated >= avgRev ? 700 : 400 }}>{fmt$(r.revenue_generated)}</span>, align: "right" as const },
    { header: "Scorecard", render: (r: EmpStatRow) => r.scorecard_avg > 0 ? <ScoreBadge score={Math.round(r.scorecard_avg)} /> : <span style={{ color: clr.muted }}>—</span> },
    { header: "Tips", render: (r: EmpStatRow) => r.tips_earned > 0 ? fmt$(r.tips_earned) : "—", align: "right" as const },
    { header: "Attendance", render: (r: EmpStatRow) => (
      <span style={{ fontWeight: 600, color: r.attendance_score >= 80 ? clr.green : r.attendance_score >= 60 ? clr.amber : clr.red }}>{r.attendance_score}%</span>
    ), align: "right" as const },
  ];

  return (
    <DashboardLayout title="Employee Stats">
      <div style={{ padding: "24px 28px", maxWidth: 1300 }}>
        <ReportHeader
          title="Employee Stats"
          subtitle="Individual attendance, efficiency, and revenue performance."
          printable
          filters={<DateRange from={from} to={to} onChange={(f,t) => { setFrom(f); setTo(t); }} />}
        />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Employees" value={String(rows.length)} color={clr.secondary} />
          <KpiCard label="Total Revenue" value={fmt$(rows.reduce((s,r) => s+r.revenue_generated, 0))} />
          <KpiCard label="Avg Revenue / Employee" value={fmt$(avgRev)} color={clr.green} />
          <KpiCard label="Avg Scorecard" value={rows.length > 0 ? (rows.reduce((s,r) => s+r.scorecard_avg, 0)/rows.length).toFixed(2)+"/4" : "—"} color={clr.amber} />
        </div>

        <DataTable cols={cols} rows={rows} loading={loading} />
      </div>
    </DashboardLayout>
  );
}
