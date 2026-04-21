import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmtDate, fmtH, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData, EffBar } from "./_shared";

function today() { return new Date().toISOString().split("T")[0]; }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().split("T")[0]; }

interface DayRow { date: string; jobs: number; allowed_hours: number; clock_hours: number; efficiency_pct: number; }
interface EmpRow { id: number; name: string; jobs: number; allowed_hours: number; clock_hours: number; efficiency_pct: number; }
interface EffData { from: string; to: string; overall_efficiency: number; total_jobs: number; total_allowed_hours: number; total_clock_hours: number; by_day: DayRow[]; by_employee: EmpRow[]; }

export default function EfficiencyPage() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const [view, setView] = useState<"day"|"employee">("day");

  const { data, loading } = useReportData<EffData>(`/reports/efficiency?from=${from}&to=${to}`);

  const dayCols = [
    { header: "Date", render: (r: DayRow) => fmtDate(r.date) },
    { header: "Jobs", key: "jobs" as const, align: "right" as const },
    { header: "Allowed Hrs", render: (r: DayRow) => fmtH(r.allowed_hours), align: "right" as const },
    { header: "Clock Hrs", render: (r: DayRow) => fmtH(r.clock_hours), align: "right" as const },
    { header: "Efficiency", render: (r: DayRow) => <EffBar pct={r.efficiency_pct} />, width: 160 },
  ];
  const empCols = [
    { header: "Employee", render: (r: EmpRow) => <span style={{ fontWeight: 500 }}>{r.name}</span> },
    { header: "Jobs", key: "jobs" as const, align: "right" as const },
    { header: "Allowed Hrs", render: (r: EmpRow) => fmtH(r.allowed_hours), align: "right" as const },
    { header: "Clock Hrs", render: (r: EmpRow) => fmtH(r.clock_hours), align: "right" as const },
    { header: "Efficiency", render: (r: EmpRow) => <EffBar pct={r.efficiency_pct} />, width: 160 },
  ];

  const eff = data?.overall_efficiency ?? 0;
  const effColor = eff >= 90 ? clr.green : eff >= 70 ? clr.brand : clr.amber;

  return (
    <DashboardLayout title="Schedule Efficiency">
      <div style={{ padding: "24px 28px", maxWidth: 1000 }}>
        <ReportHeader
          title="Schedule Efficiency"
          subtitle="Allowed hours vs actual clock hours — how efficiently time is utilized."
          printable
          filters={<DateRange from={from} to={to} onChange={(f,t) => { setFrom(f); setTo(t); }} />}
        />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Overall Efficiency" value={`${eff.toFixed(0)}%`} color={effColor} sub="Allowed / Clock hours" />
          <KpiCard label="Total Jobs" value={String(data?.total_jobs ?? 0)} color={clr.secondary} />
          <KpiCard label="Allowed Hours" value={fmtH(data?.total_allowed_hours ?? 0)} />
          <KpiCard label="Clock Hours" value={fmtH(data?.total_clock_hours ?? 0)} color={clr.secondary} />
        </div>

        {/* View toggle */}
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          {(["day","employee"] as const).map(v => (
            <button key={v} onClick={() => setView(v)} style={{ padding: "6px 16px", fontSize: 12, fontWeight: 500, border: `1px solid ${clr.border}`, borderRadius: 5, cursor: "pointer", fontFamily: "inherit", backgroundColor: view === v ? clr.brand : clr.card, color: view === v ? "#fff" : clr.secondary }}>
              By {v === "day" ? "Day" : "Employee"}
            </button>
          ))}
        </div>

        {view === "day"
          ? <DataTable cols={dayCols} rows={data?.by_day ?? []} loading={loading} />
          : <DataTable cols={empCols} rows={data?.by_employee ?? []} loading={loading} />
        }
      </div>
    </DashboardLayout>
  );
}
