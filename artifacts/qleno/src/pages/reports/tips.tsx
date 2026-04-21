import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$c, fmtDate, fmtSvc, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData } from "./_shared";

function today() { return new Date().toISOString().split("T")[0]; }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().split("T")[0]; }

interface TipRow { id: number; date: string; amount: number; employee_name: string; client_name: string | null; service_type: string | null; job_date: string | null; notes: string | null; }
interface TipsData { from: string; to: string; data: TipRow[]; summary: { total_tips: number; avg_per_tip: number; count: number }; }

export default function TipsReportPage() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());

  const { data, loading } = useReportData<TipsData>(`/reports/tips?from=${from}&to=${to}`);
  const rows = data?.data ?? [];
  const s = data?.summary;

  // Group by employee
  const byEmp: Record<string, number> = {};
  rows.forEach(r => { byEmp[r.employee_name] = (byEmp[r.employee_name] ?? 0) + r.amount; });
  const topEmp = Object.entries(byEmp).sort((a,b) => b[1]-a[1])[0];

  const cols = [
    { header: "Date", render: (r: TipRow) => fmtDate(r.date) },
    { header: "Employee", key: "employee_name" as const, render: (r: TipRow) => <span style={{ fontWeight: 500 }}>{r.employee_name}</span> },
    { header: "Client", render: (r: TipRow) => r.client_name ?? "—" },
    { header: "Service", render: (r: TipRow) => r.service_type ? fmtSvc(r.service_type) : "—" },
    { header: "Amount", render: (r: TipRow) => <span style={{ fontWeight: 700, color: clr.green }}>{fmt$c(r.amount)}</span>, align: "right" as const },
    { header: "Notes", render: (r: TipRow) => r.notes ? <span style={{ color: clr.secondary, fontSize: 12 }}>{r.notes}</span> : "—" },
  ];

  return (
    <DashboardLayout title="Tips Report">
      <div style={{ padding: "24px 28px", maxWidth: 1000 }}>
        <ReportHeader
          title="Tips Report"
          subtitle="All tips received by employee in the selected date range."
          printable
          filters={<DateRange from={from} to={to} onChange={(f,t) => { setFrom(f); setTo(t); }} />}
        />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Total Tips" value={fmt$c(s?.total_tips ?? 0)} color={clr.green} />
          <KpiCard label="Avg per Tip" value={fmt$c(s?.avg_per_tip ?? 0)} />
          <KpiCard label="Tip Entries" value={String(s?.count ?? 0)} color={clr.secondary} />
          {topEmp && <KpiCard label="Top Earner" value={topEmp[0]} sub={fmt$c(topEmp[1])} color={clr.amber} />}
        </div>

        <DataTable cols={cols} rows={rows} loading={loading} emptyMsg="No tips recorded in this date range." />
      </div>
    </DashboardLayout>
  );
}
