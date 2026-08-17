import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$c, fmtDate, fmtPct, fmtSvc, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData, ReportError } from "./_shared";

function today() { return new Date().toISOString().split("T")[0]; }
function monthStart() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; }

interface CostRow { id: number; date: string; service_type: string; client_name: string; employee_name: string; revenue: number; labor_cost: number; gross_profit: number; margin_pct: number; allowed_hours: number; actual_hours: number; }
interface CostData {
  from: string; to: string; data: CostRow[];
  row_count?: number; rows_shown?: number; truncated?: boolean;
  summary: { avg_margin: number; best_service: string | null; worst_service: string | null; total_revenue: number; total_labor: number; total_profit: number };
}

export default function JobCostingPage() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());

  const { data, loading, error, reload } = useReportData<CostData>(`/reports/job-costing?from=${from}&to=${to}`);
  const rows = data?.data ?? [];
  const s = data?.summary;

  const cols = [
    { header: "Date", render: (r: CostRow) => fmtDate(r.date) },
    { header: "Client", key: "client_name" as const },
    { header: "Service", render: (r: CostRow) => fmtSvc(r.service_type) },
    { header: "Employee", key: "employee_name" as const },
    { header: "Revenue", render: (r: CostRow) => fmt$c(r.revenue), align: "right" as const },
    { header: "Labor Cost", render: (r: CostRow) => fmt$c(r.labor_cost), align: "right" as const },
    { header: "Gross Profit", render: (r: CostRow) => <span style={{ fontWeight: 600, color: r.gross_profit >= 0 ? clr.green : clr.red }}>{fmt$c(r.gross_profit)}</span>, align: "right" as const },
    { header: "Margin", render: (r: CostRow) => {
      const c = r.margin_pct >= 50 ? clr.green : r.margin_pct >= 30 ? clr.amber : clr.red;
      return <span style={{ fontWeight: 600, color: c }}>{fmtPct(r.margin_pct)}</span>;
    }, align: "right" as const },
  ];

  return (
    <DashboardLayout title="Job Costing">
      <div style={{ padding: "24px 28px", maxWidth: 1200 }}>
        <ReportHeader
          title="Job Costing"
          subtitle="Revenue vs labor cost and gross profit margin per job."
          printable
          filters={<DateRange from={from} to={to} onChange={(f,t) => { setFrom(f); setTo(t); }} />}
        />

        {error ? <ReportError error={error} onRetry={reload} /> : <>

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Total Revenue" value={fmt$c(s?.total_revenue ?? 0)} />
          <KpiCard label="Total Labor" value={fmt$c(s?.total_labor ?? 0)} color={clr.secondary} />
          <KpiCard label="Gross Profit" value={fmt$c(s?.total_profit ?? 0)} color={clr.green} />
          <KpiCard label="Gross Margin" value={fmtPct(s?.avg_margin ?? 0)} sub="profit ÷ revenue, whole range" color={(s?.avg_margin ?? 0) >= 40 ? clr.green : clr.amber} />
          {s?.best_service && <KpiCard label="Best Service" value={fmtSvc(s.best_service)} color={clr.green} />}
          {s?.worst_service && <KpiCard label="Lowest Margin" value={fmtSvc(s.worst_service)} color={clr.amber} />}
        </div>

        {/* [job-costing-truncation 2026-08-17] The detail list is capped; the totals
            above are not. Say so on screen rather than let a long range look complete. */}
        {data?.truncated && (
          <p style={{ margin: "0 0 10px", fontSize: 12, color: clr.secondary }}>
            Listing the {(data.rows_shown ?? rows.length).toLocaleString()} most recent of {(data.row_count ?? 0).toLocaleString()} completed jobs.
            The totals above cover all {(data.row_count ?? 0).toLocaleString()} — narrow the date range to see every job.
          </p>
        )}

        <DataTable cols={cols} rows={rows} loading={loading} emptyMsg="No completed jobs in this date range." />
        </>}
      </div>
    </DashboardLayout>
  );
}
