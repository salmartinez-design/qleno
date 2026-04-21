import { useMemo } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$, fmtPct, clr, KpiCard, ReportHeader, DataTable, useReportData } from "./_shared";

interface WeekRow { week: string; revenue: number; payroll: number; pct: number; jobs: number; }
interface P2RData { weeks: WeekRow[]; current: WeekRow; status: "critical" | "high" | "healthy" | "low"; }

export default function PayrollToRevenuePage() {
  const { data, loading } = useReportData<P2RData>("/reports/payroll-to-revenue");
  const weeks = data?.weeks ?? [];
  const cur = data?.current;
  const status = data?.status ?? "healthy";

  const statusColors: Record<string, string> = { critical: clr.red, high: clr.amber, healthy: clr.green, low: "#3B82F6" };
  const statusLabels: Record<string, string> = { critical: "Critical — over 45%", high: "High — 40-45%", healthy: "Healthy — 30-40%", low: "Low — under 30%" };
  const sColor = statusColors[status];

  const maxRev = useMemo(() => Math.max(...weeks.map(w => w.revenue), 1), [weeks]);

  const cols = [
    { header: "Week of", render: (r: WeekRow) => new Date(r.week).toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
    { header: "Jobs", key: "jobs" as const, align: "right" as const },
    { header: "Revenue", render: (r: WeekRow) => fmt$(r.revenue), align: "right" as const },
    { header: "Payroll", render: (r: WeekRow) => fmt$(r.payroll), align: "right" as const },
    { header: "Payroll %", render: (r: WeekRow) => {
      const c = r.pct > 45 ? clr.red : r.pct > 40 ? clr.amber : r.pct >= 30 ? clr.green : "#3B82F6";
      return <span style={{ fontWeight: 700, color: c }}>{fmtPct(r.pct)}</span>;
    }, align: "right" as const },
    { header: "Visual", render: (r: WeekRow) => (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ flex: 1, height: 8, backgroundColor: "#E5E2DC", borderRadius: 4, width: 120, overflow: "hidden" }}>
          <div style={{ width: `${Math.min(r.pct, 100)}%`, height: "100%", backgroundColor: r.pct > 45 ? clr.red : r.pct > 40 ? clr.amber : clr.green, borderRadius: 4 }} />
        </div>
        <div style={{ width: 1, height: 12, backgroundColor: clr.amber, opacity: 0.6 }} title="40% benchmark" />
      </div>
    ), width: 160 },
  ];

  return (
    <DashboardLayout title="Payroll % to Revenue">
      <div style={{ padding: "24px 28px", maxWidth: 1000 }}>
        <ReportHeader title="Payroll % to Revenue" subtitle="Track labor cost efficiency over 12 rolling weeks. Target: 30-40%." />

        {/* Current week KPI */}
        <div style={{ backgroundColor: clr.card, border: `2px solid ${sColor}`, borderRadius: 12, padding: "20px 24px", marginBottom: 24, display: "flex", alignItems: "center", gap: 20 }}>
          <div>
            <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 600, color: clr.muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>This Week</p>
            <p style={{ margin: 0, fontSize: 40, fontWeight: 800, color: sColor }}>{fmtPct(cur?.pct ?? 0)}</p>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: clr.secondary }}>Revenue: {fmt$(cur?.revenue ?? 0)} — Payroll: {fmt$(cur?.payroll ?? 0)}</p>
          </div>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: sColor }}>{statusLabels[status]}</p>
            <p style={{ margin: "4px 0 0", fontSize: 11, color: clr.muted }}>Benchmark: 30–40% is healthy</p>
          </div>
        </div>

        {/* Trend sparkline */}
        {weeks.length > 0 && (
          <div style={{ backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 10, padding: "16px 20px", marginBottom: 24 }}>
            <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600, color: clr.text }}>12-Week Payroll % Trend</p>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 80 }}>
              {weeks.map((w, i) => {
                const h = Math.max(4, (w.pct / 60) * 72);
                const c = w.pct > 45 ? clr.red : w.pct > 40 ? clr.amber : w.pct >= 30 ? clr.green : "#3B82F6";
                return (
                  <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }} title={`Week of ${w.week}: ${fmtPct(w.pct)}`}>
                    <div style={{ width: "100%", height: h, backgroundColor: c, borderRadius: "3px 3px 0 0" }} />
                    <span style={{ fontSize: 9, color: clr.muted, marginTop: 3 }}>{new Date(w.week).toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}</span>
                  </div>
                );
              })}
            </div>
            {/* 40% benchmark line indicator */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
              <div style={{ width: 20, height: 2, backgroundColor: clr.amber }} />
              <span style={{ fontSize: 11, color: clr.secondary }}>40% upper target</span>
              <div style={{ width: 20, height: 2, backgroundColor: "#3B82F6", marginLeft: 12 }} />
              <span style={{ fontSize: 11, color: clr.secondary }}>30% lower target</span>
            </div>
          </div>
        )}

        <DataTable cols={cols} rows={weeks} loading={loading} emptyMsg="No payroll data available." />
      </div>
    </DashboardLayout>
  );
}
