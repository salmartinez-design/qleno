import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { ReportHeader, KpiCard, DataTable, useReportData, clr } from "./_shared";

type Period = "rolling_90d" | "month" | "quarter" | "year";
const PERIODS: { id: Period; label: string }[] = [
  { id: "rolling_90d", label: "Last 90 days" },
  { id: "month", label: "This month" },
  { id: "quarter", label: "This quarter" },
  { id: "year", label: "This year" },
];

interface ScorecardReport {
  scope: string; window: { from: string; to: string; label: string };
  score_pct: number | null; responses: number; composite_pct?: number | null;
  employees?: { employee_id: number; name: string; score_pct: number | null; responses: number; composite_pct?: number | null }[];
}
interface EffReport {
  scope: string; window: { from: string; to: string; label: string };
  overall: number | null;
  packages: { package: string; efficiency_pct: number | null; jobs: number; techs?: number }[];
}

const effColor = (p: number | null) => p == null ? clr.muted : p >= 100 ? clr.brand : p >= 80 ? clr.text : clr.red;

export default function QualityEfficiencyReport() {
  const [period, setPeriod] = useState<Period>("rolling_90d");
  const [empId, setEmpId] = useState<number | "company">("company");

  const empQ = empId === "company" ? "scope=company" : `scope=employee&employee_id=${empId}`;
  const sc = useReportData<ScorecardReport>(`/scorecards/report?${empQ}&period=${period}`);
  const eff = useReportData<EffReport>(`/efficiency/report?${empQ}&period=${period}`);
  // The company scorecard report doubles as the tech picker source.
  const techPickerList = useReportData<ScorecardReport>(`/scorecards/report?scope=company&period=${period}`);

  const loading = sc.loading || eff.loading;
  const win = sc.data?.window || eff.data?.window;

  const pillRow = (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      {PERIODS.map(p => (
        <button key={p.id} onClick={() => setPeriod(p.id)}
          style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: period === p.id ? 600 : 400, cursor: "pointer",
            border: `1px solid ${period === p.id ? clr.brand : clr.border}`, background: period === p.id ? `${clr.brand}14` : "#FFFFFF", color: period === p.id ? clr.brand : clr.secondary }}>
          {p.label}
        </button>
      ))}
      <span style={{ width: 1, height: 20, background: clr.border, margin: "0 4px" }} />
      <select value={String(empId)} onChange={e => setEmpId(e.target.value === "company" ? "company" : Number(e.target.value))}
        style={{ padding: "6px 10px", borderRadius: 8, fontSize: 12, border: `1px solid ${clr.border}`, background: "#FFFFFF", color: clr.text, fontFamily: "inherit" }}>
        <option value="company">Company-wide</option>
        {(techPickerList.data?.employees || []).map(t => <option key={t.employee_id} value={t.employee_id}>{t.name}</option>)}
      </select>
    </div>
  );

  return (
    <DashboardLayout title="Quality & Efficiency">
      <div style={{ padding: "24px 28px", maxWidth: 1000 }}>
        <ReportHeader
          title="Quality & Efficiency"
          subtitle={win ? `${win.label} · ${win.from} → ${win.to}` : "Performance Score + efficiency by service"}
          filters={pillRow}
        />
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
        <KpiCard label="Performance Score" value={sc.data?.composite_pct != null ? `${sc.data.composite_pct.toFixed(1)}%` : (sc.data?.score_pct != null ? `${sc.data.score_pct.toFixed(1)}%` : "—")}
          sub="Rolling · trailing 90 days" />
        <KpiCard label="Satisfaction" value={sc.data?.score_pct != null ? `${sc.data.score_pct.toFixed(1)}%` : "—"}
          sub={`${sc.data?.responses ?? 0} survey responses`} />
        <KpiCard label="Efficiency" value={eff.data?.overall != null ? `${eff.data.overall.toFixed(1)}%` : "—"}
          sub="Allowed ÷ actual hours" color={effColor(eff.data?.overall ?? null)} />
      </div>

      {/* Efficiency by package */}
      <h3 style={{ fontSize: 13, fontWeight: 700, color: clr.text, margin: "8px 0 10px" }}>Efficiency by service package</h3>
      <DataTable
        loading={loading}
        emptyMsg="No efficiency data for this period."
        cols={[
          { header: "Package", render: (r: any) => r.package },
          { header: "Efficiency", render: (r: any) => <span style={{ fontWeight: 600, color: effColor(r.efficiency_pct) }}>{r.efficiency_pct != null ? `${r.efficiency_pct.toFixed(1)}%` : "—"}</span> },
          { header: "Jobs", render: (r: any) => r.jobs },
          ...(empId === "company" ? [{ header: "Techs", render: (r: any) => r.techs ?? "—" }] : []),
        ]}
        rows={eff.data?.packages || []}
      />

      {/* Scorecard — per-tech only in company scope */}
      {empId === "company" && (
        <>
          <h3 style={{ fontSize: 13, fontWeight: 700, color: clr.text, margin: "24px 0 10px" }}>Performance Score by technician</h3>
          <DataTable
            loading={loading}
            emptyMsg="No survey responses for this period."
            cols={[
              { header: "Technician", render: (r: any) => r.name },
              { header: "90-Day", render: (r: any) => <span style={{ fontWeight: 700, color: clr.brand }}>{r.composite_pct != null ? `${r.composite_pct.toFixed(1)}%` : "—"}</span> },
              { header: "Satisfaction", render: (r: any) => <span style={{ fontWeight: 600, color: clr.text }}>{r.score_pct != null ? `${r.score_pct.toFixed(1)}%` : "—"}</span> },
              { header: "Responses", render: (r: any) => r.responses },
            ]}
            rows={sc.data?.employees || []}
          />
        </>
      )}
      </div>
    </DashboardLayout>
  );
}
