import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$c, fmtDate, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData } from "./_shared";

function today() { return new Date().toISOString().split("T")[0]; }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().split("T")[0]; }

interface CancelRow { id: number; name: string; email: string; client_since: string; cancelled_date: string; tenure_days: number; bill_rate: number; last_score: number | null; notes: string | null; }
interface CancelData { from: string; to: string; data: CancelRow[]; summary: { total: number; avg_tenure_days: number; revenue_lost: number }; }

export default function CancellationsPage() {
  const [from, setFrom] = useState(daysAgo(90));
  const [to, setTo] = useState(today());

  const { data, loading } = useReportData<CancelData>(`/reports/cancellations?from=${from}&to=${to}`);
  const rows = data?.data ?? [];
  const s = data?.summary;

  const tenureLabel = (days: number) => {
    if (days < 30) return <span style={{ color: clr.red }}>Less than 1 month</span>;
    if (days < 90) return <span style={{ color: clr.amber }}>{Math.floor(days/30)} months</span>;
    const yrs = Math.floor(days/365);
    const mos = Math.floor((days % 365) / 30);
    return <span style={{ color: clr.secondary }}>{yrs > 0 ? `${yrs}yr ` : ""}{mos > 0 ? `${mos}mo` : ""}</span>;
  };

  const cols = [
    { header: "Client", render: (r: CancelRow) => <div><p style={{ margin: 0, fontWeight: 500 }}>{r.name}</p><p style={{ margin: 0, fontSize: 11, color: clr.muted }}>{r.email}</p></div> },
    { header: "Client Since", render: (r: CancelRow) => fmtDate(r.client_since) },
    { header: "Cancelled", render: (r: CancelRow) => fmtDate(r.cancelled_date) },
    { header: "Tenure", render: (r: CancelRow) => tenureLabel(r.tenure_days) },
    { header: "Bill Rate", render: (r: CancelRow) => fmt$c(r.bill_rate), align: "right" as const },
    { header: "Last Score", render: (r: CancelRow) => r.last_score !== null ? <span style={{ fontWeight: 600, color: r.last_score <= 2 ? clr.red : clr.secondary }}>{r.last_score}/4</span> : <span style={{ color: clr.muted }}>—</span>, align: "center" as const },
    { header: "Notes", render: (r: CancelRow) => r.notes ? <span style={{ color: clr.secondary, fontSize: 12 }}>{r.notes}</span> : <span style={{ color: clr.muted }}>—</span> },
  ];

  return (
    <DashboardLayout title="Cancellations">
      <div style={{ padding: "24px 28px", maxWidth: 1100 }}>
        <ReportHeader
          title="Cancelled Clients"
          subtitle="Clients with cancelled jobs in the selected date range."
          printable
          filters={<DateRange from={from} to={to} onChange={(f,t) => { setFrom(f); setTo(t); }} />}
        />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Total Cancellations" value={String(s?.total ?? 0)} color={clr.red} />
          <KpiCard label="Avg Client Tenure" value={`${Math.round((s?.avg_tenure_days ?? 0)/30)} mo`} color={clr.secondary} />
          <KpiCard label="Revenue at Risk" value={fmt$c(s?.revenue_lost ?? 0)} color={clr.amber} sub="Based on last bill rate" />
        </div>

        <DataTable cols={cols} rows={rows} loading={loading} emptyMsg="No cancellations in this date range." />
      </div>
    </DashboardLayout>
  );
}
