import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$c, fmtDate, fmtSvc, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData } from "./_shared";

function today() { return new Date().toISOString().split("T")[0]; }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split("T")[0]; }

interface FeeRow {
  id: number; action: string; amount: number; recorded_at: string; job_date: string | null;
  recorded_by: string | null; client_name: string | null; service_type: string | null; job_id: number;
}
interface FeesData {
  from: string; to: string; data: FeeRow[];
  summary: {
    total_fees: number; lockout_fees: number; cancel_fees: number;
    count: number; lockout_count: number; cancel_count: number;
  };
}

export default function FeesReportPage() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());

  const { data, loading } = useReportData<FeesData>(`/reports/fees?from=${from}&to=${to}`);
  const rows = data?.data ?? [];
  const s = data?.summary;

  const cols = [
    { header: "Job Date", render: (r: FeeRow) => r.job_date ? fmtDate(r.job_date) : "—" },
    { header: "Client", render: (r: FeeRow) => r.client_name ?? "—" },
    { header: "Service", render: (r: FeeRow) => r.service_type ? fmtSvc(r.service_type) : "—" },
    {
      header: "Type",
      render: (r: FeeRow) => (
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.04em", textTransform: "uppercase" as const, color: "#B45309", background: "#FDF3E4", border: "1px solid #F2DFB8", borderRadius: 999, padding: "2px 8px" }}>
          {r.action === "lockout" ? "Lockout" : "Cancellation"}
        </span>
      ),
    },
    { header: "Fee Collected", render: (r: FeeRow) => <span style={{ fontWeight: 700, color: clr.green }}>{fmt$c(r.amount)}</span>, align: "right" as const },
    { header: "Recorded By", render: (r: FeeRow) => r.recorded_by ?? "—" },
  ];

  return (
    <DashboardLayout title="Fees Collected">
      <div style={{ padding: "24px 28px", maxWidth: 1000 }}>
        <ReportHeader
          title="Fees Collected"
          subtitle="Cancellation and lockout fees billed in the selected date range. These are already counted inside total revenue — this report breaks out how much of it is fees."
          printable
          filters={<DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />}
        />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Total Fees Collected" value={fmt$c(s?.total_fees ?? 0)} color={clr.green} />
          <KpiCard label="Lockout Fees" value={fmt$c(s?.lockout_fees ?? 0)} sub={`${s?.lockout_count ?? 0} lockouts`} color={clr.amber} />
          <KpiCard label="Cancellation Fees" value={fmt$c(s?.cancel_fees ?? 0)} sub={`${s?.cancel_count ?? 0} cancellations`} color={clr.amber} />
          <KpiCard label="Total Charges" value={String(s?.count ?? 0)} color={clr.secondary} />
        </div>

        <DataTable cols={cols} rows={rows} loading={loading} emptyMsg="No cancellation or lockout fees in this date range." />
      </div>
    </DashboardLayout>
  );
}
