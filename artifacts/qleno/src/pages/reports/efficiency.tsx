import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmtDate, fmtH, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData, ReportError, EffBar, RangeClampNotice, type RangeClamp } from "./_shared";

function today() { return new Date().toISOString().split("T")[0]; }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().split("T")[0]; }

interface DayRow { date: string; jobs: number; jobs_measured: number; allowed_hours: number; clock_hours: number; efficiency_pct: number | null; }
interface EmpRow { id: number; name: string; jobs: number; jobs_measured: number; allowed_hours: number; clock_hours: number; efficiency_pct: number | null; }
interface EffData {
  range_clamped?: RangeClamp | null; from: string; to: string;
  overall_efficiency: number | null; total_jobs: number; total_jobs_measured: number;
  total_allowed_hours: number; total_clock_hours: number;
  measured_allowed_hours: number; measured_clock_hours: number;
  by_day: DayRow[]; by_employee: EmpRow[]; }

export default function EfficiencyPage() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const [view, setView] = useState<"day"|"employee">("day");

  const { data, loading, error, reload } = useReportData<EffData>(`/reports/efficiency?from=${from}&to=${to}`);

  // A job missing a budget or a clock record can't be scored at all. Show a dash
  // rather than a number that describes the gap in the data instead of the work.
  const effCell = (pct: number | null) =>
    pct == null ? <span style={{ color: clr.muted }}>—</span> : <EffBar pct={pct} />;
  const jobsCell = (r: { jobs: number; jobs_measured: number }) => <>
    {r.jobs}
    {r.jobs_measured < r.jobs &&
      <span style={{ fontSize: 10, color: clr.muted, marginLeft: 5 }}>{r.jobs_measured} scored</span>}
  </>;

  const dayCols = [
    { header: "Date", render: (r: DayRow) => fmtDate(r.date) },
    { header: "Jobs", render: jobsCell, align: "right" as const },
    { header: "Allowed Hrs", render: (r: DayRow) => fmtH(r.allowed_hours), align: "right" as const },
    { header: "Clock Hrs", render: (r: DayRow) => fmtH(r.clock_hours), align: "right" as const },
    { header: "Efficiency", render: (r: DayRow) => effCell(r.efficiency_pct), width: 160 },
  ];
  const empCols = [
    { header: "Employee", render: (r: EmpRow) => <span style={{ fontWeight: 500 }}>{r.name}</span> },
    { header: "Jobs", render: jobsCell, align: "right" as const },
    { header: "Their Allowed Hrs", render: (r: EmpRow) => fmtH(r.allowed_hours), align: "right" as const },
    { header: "Clock Hrs", render: (r: EmpRow) => fmtH(r.clock_hours), align: "right" as const },
    { header: "Efficiency", render: (r: EmpRow) => effCell(r.efficiency_pct), width: 160 },
  ];

  const eff = data?.overall_efficiency ?? null;
  const effColor = eff == null ? clr.secondary : eff >= 90 ? clr.green : eff >= 70 ? clr.brand : clr.amber;
  const unscored = (data?.total_jobs ?? 0) - (data?.total_jobs_measured ?? 0);

  return (
    <DashboardLayout title="Schedule Efficiency">
      <div style={{ padding: "24px 28px", maxWidth: 1000 }}>
        <ReportHeader
          title="Schedule Efficiency"
          subtitle="Hours a job was budgeted against the hours everyone on it actually clocked."
          printable
          filters={<DateRange from={from} to={to} onChange={(f,t) => { setFrom(f); setTo(t); }} />}
        />

        {error ? <ReportError error={error} onRetry={reload} /> : <>

        <RangeClampNotice clamp={data?.range_clamped} />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 16 }}>
          <KpiCard label="Overall Efficiency" value={eff == null ? "—" : `${eff.toFixed(0)}%`} color={effColor} sub="Over 100% means under budget" />
          <KpiCard label="Total Jobs" value={String(data?.total_jobs ?? 0)} color={clr.secondary}
                   sub={unscored > 0 ? `${unscored} can't be scored` : "all scored"} />
          <KpiCard label="Allowed Hours" value={fmtH(data?.total_allowed_hours ?? 0)}
                   sub={unscored > 0 ? `${fmtH(data?.measured_allowed_hours ?? 0)} in the percentage` : undefined} />
          <KpiCard label="Clock Hours" value={fmtH(data?.total_clock_hours ?? 0)} color={clr.secondary}
                   sub={unscored > 0 ? `${fmtH(data?.measured_clock_hours ?? 0)} in the percentage` : "every cleaner on the job"} />
        </div>

        <p style={{ fontSize: 12, color: clr.secondary, lineHeight: 1.55, margin: "0 0 20px", maxWidth: 780 }}>
          Efficiency is budgeted hours divided by hours worked, so above 100% means the crew came in under budget.
          Hours worked count everyone who clocked on the job, since the budget covers the whole crew.
          Only jobs that have both a budget and a clock record go into the percentage — a job missing either one
          would push it up or down without telling you anything about the work, so it's shown in the totals and
          left out of the score.
          {view === "employee" && " Per cleaner, the job's budget is split evenly across everyone who worked it, so this shows who used more than their share."}
        </p>

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
        </>}
      </div>
    </DashboardLayout>
  );
}
