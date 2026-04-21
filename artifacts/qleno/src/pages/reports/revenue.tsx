import { useState, useMemo, useEffect } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$, fmtDate, fmtH, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData, fmtSvc } from "./_shared";

function today() { return new Date().toISOString().split("T")[0]; }
function monthStart() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; }
function useIsMobile() {
  const [m, setM] = useState(typeof window !== "undefined" && window.innerWidth < 640);
  useEffect(() => { const h = () => setM(window.innerWidth < 640); window.addEventListener("resize", h); return () => window.removeEventListener("resize", h); }, []);
  return m;
}

interface RevData {
  from: string; to: string; group_by: string;
  summary: { total_revenue: number; avg_job_value: number; job_count: number; projected_month_end: number };
  trend: { period: string; job_count: number; revenue: number; avg_per_job: number; allowed_hours: number }[];
}

export default function RevenueReportPage() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo]   = useState(today());
  const [groupBy, setGroupBy] = useState("day");
  const isMobile = useIsMobile();

  const qs = `?from=${from}&to=${to}&group_by=${groupBy}`;
  const { data, loading } = useReportData<RevData>(`/reports/revenue${qs}`);

  const s = data?.summary;
  const trend = data?.trend ?? [];

  const maxRev = useMemo(() => Math.max(...trend.map(r => r.revenue), 1), [trend]);

  const cols = [
    { header: "Period", key: "period" as const, render: (r: typeof trend[0]) => fmtDate(r.period) },
    { header: "Jobs",   key: "job_count" as const, align: "right" as const },
    { header: "Revenue", render: (r: typeof trend[0]) => fmt$(r.revenue), align: "right" as const },
    { header: "Avg/Job", render: (r: typeof trend[0]) => fmt$(r.avg_per_job), align: "right" as const },
    { header: "Allowed Hrs", render: (r: typeof trend[0]) => fmtH(r.allowed_hours), align: "right" as const },
  ];

  return (
    <DashboardLayout title="Revenue Summary">
      <div style={{ padding: isMobile ? "16px" : "24px 28px", maxWidth: 1100, overflowX: "hidden" }}>
        <ReportHeader
          title="Revenue Summary"
          subtitle="Track revenue trends and projected income."
          printable
          filters={
            <>
              <DateRange from={from} to={to} onChange={(f,t) => { setFrom(f); setTo(t); }} />
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, color: clr.secondary, fontWeight: 500 }}>Group by:</span>
                <div style={{ display: "flex", gap: 6 }}>
                  {["day","week","month"].map(g => (
                    <button key={g} type="button" onClick={() => setGroupBy(g)} style={{ padding: "8px 14px", fontSize: 13, fontWeight: 600, border: `1px solid ${clr.border}`, borderRadius: 8, cursor: "pointer", fontFamily: "inherit", backgroundColor: groupBy === g ? clr.brand : clr.card, color: groupBy === g ? "#fff" : clr.secondary, touchAction: "manipulation", WebkitTapHighlightColor: "transparent" }}>
                      {g.charAt(0).toUpperCase() + g.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </>
          }
        />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Total Revenue" value={fmt$(s?.total_revenue ?? 0)} />
          <KpiCard label="Avg Job Value" value={fmt$(s?.avg_job_value ?? 0)} color={clr.green} />
          <KpiCard label="Jobs Completed" value={String(s?.job_count ?? 0)} color={clr.secondary} />
          <KpiCard label="Month Projected" value={fmt$(s?.projected_month_end ?? 0)} color={clr.amber} sub="All scheduled + completed this month" />
        </div>

        {/* Bar chart */}
        {trend.length > 0 && (
          <div style={{ backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 10, padding: 20, marginBottom: 24 }}>
            <p style={{ margin: "0 0 16px", fontSize: 13, fontWeight: 600, color: clr.text }}>Revenue by {groupBy.charAt(0).toUpperCase()+groupBy.slice(1)}</p>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 120, overflowX: "auto" }}>
              {trend.map((r, i) => {
                const h = Math.max(4, (r.revenue / maxRev) * 108);
                return (
                  <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "0 0 auto", minWidth: 32, cursor: "default" }} title={`${fmtDate(r.period)}: ${fmt$(r.revenue)}`}>
                    <div style={{ width: 28, height: h, backgroundColor: clr.brand, borderRadius: "3px 3px 0 0", transition: "height 0.3s" }} />
                    <span style={{ fontSize: 9, color: clr.muted, marginTop: 3, transform: "rotate(-40deg)", transformOrigin: "top left", whiteSpace: "nowrap" }}>{r.period.slice(5)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <DataTable cols={cols} rows={trend} loading={loading} emptyMsg="No completed jobs in this date range." />
      </div>
    </DashboardLayout>
  );
}
