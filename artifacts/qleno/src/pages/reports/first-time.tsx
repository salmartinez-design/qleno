import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$c, fmtDate, fmtSvc, fmtH, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData } from "./_shared";
import { Star } from "lucide-react";

function today() { return new Date().toISOString().split("T")[0]; }
function daysAhead(n: number) { const d = new Date(); d.setDate(d.getDate()+n); return d.toISOString().split("T")[0]; }

interface FTRow { id: number; date: string; time: string | null; service_type: string; client_name: string; address: string; employee_name: string; allowed_hours: number; bill_rate: number; }
interface FTData { from: string; to: string; data: FTRow[]; }

export default function FirstTimePage() {
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(daysAhead(30));

  const { data, loading } = useReportData<FTData>(`/reports/first-time?from=${from}&to=${to}`);
  const rows = data?.data ?? [];

  const cols = [
    { header: "Date", render: (r: FTRow) => fmtDate(r.date) },
    { header: "Time", render: (r: FTRow) => r.time ? r.time.slice(0,5) : "—" },
    { header: "Client", render: (r: FTRow) => <span style={{ fontWeight: 600 }}>{r.client_name}</span> },
    { header: "Address", render: (r: FTRow) => <span style={{ fontSize: 12, color: clr.secondary }}>{r.address || "—"}</span> },
    { header: "Service", render: (r: FTRow) => fmtSvc(r.service_type) },
    { header: "Employee", render: (r: FTRow) => <span style={{ fontWeight: 500 }}>{r.employee_name}</span> },
    { header: "Hours", render: (r: FTRow) => fmtH(r.allowed_hours), align: "right" as const },
    { header: "Bill Rate", render: (r: FTRow) => fmt$c(r.bill_rate), align: "right" as const },
  ];

  const totalRev = rows.reduce((s,r) => s + r.bill_rate, 0);

  return (
    <DashboardLayout title="First Time In">
      <div style={{ padding: "24px 28px", maxWidth: 1100 }}>
        <ReportHeader
          title="First Time In"
          subtitle="Upcoming and recent first-time client visits. These clients need extra care and a great introduction."
          printable
          filters={<DateRange from={from} to={to} onChange={(f,t) => { setFrom(f); setTo(t); }} label="Date Range" />}
        />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="First Time Clients" value={String(rows.length)} color={clr.brand} />
          <KpiCard label="Total Revenue" value={fmt$c(totalRev)} color={clr.green} />
          <KpiCard label="Avg Bill Rate" value={rows.length > 0 ? fmt$c(totalRev/rows.length) : "—"} color={clr.secondary} />
        </div>

        {rows.length > 0 && (
          <div style={{ backgroundColor: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 8, padding: "10px 14px", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
            <Star size={14} color={clr.brand} />
            <span style={{ fontSize: 13, color: "#1D4ED8" }}>
              First-time visits are key to retention. Ensure quality and make a great first impression.
            </span>
          </div>
        )}

        <DataTable cols={cols} rows={rows} loading={loading} emptyMsg="No first-time client visits in this date range." />
      </div>
    </DashboardLayout>
  );
}
