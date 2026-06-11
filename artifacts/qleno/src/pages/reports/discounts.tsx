import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$c, fmtDate, fmtSvc, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData } from "./_shared";

function today() { return new Date().toISOString().split("T")[0]; }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split("T")[0]; }

interface DiscountRow {
  id: number; date: string; code: string | null; type: string; value: number; amount: number;
  reason: string | null; applied_by: string | null; client_name: string | null;
  service_type: string | null; job_date: string | null;
}
interface DiscountsData {
  from: string; to: string; data: DiscountRow[];
  summary: { total_discount: number; count: number; percent_count: number; flat_count: number };
}

export default function DiscountsReportPage() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());

  const { data, loading } = useReportData<DiscountsData>(`/reports/discounts?from=${from}&to=${to}`);
  const rows = data?.data ?? [];
  const s = data?.summary;

  // Top code/reason by total dollars given away
  const byCode: Record<string, number> = {};
  rows.forEach(r => {
    const k = r.code || r.reason || (r.type === "percent" ? "Custom %" : "Custom $");
    byCode[k] = (byCode[k] ?? 0) + r.amount;
  });
  const topCode = Object.entries(byCode).sort((a, b) => b[1] - a[1])[0];

  const cols = [
    { header: "Date", render: (r: DiscountRow) => fmtDate(r.date) },
    { header: "Client", render: (r: DiscountRow) => r.client_name ?? "—" },
    { header: "Service", render: (r: DiscountRow) => r.service_type ? fmtSvc(r.service_type) : "—" },
    { header: "Code / Reason", render: (r: DiscountRow) => <span style={{ fontWeight: 500 }}>{r.code || r.reason || "Custom"}</span> },
    { header: "Discount", render: (r: DiscountRow) => r.type === "percent" ? `${r.value}%` : fmt$c(r.value), align: "right" as const },
    { header: "Amount Off", render: (r: DiscountRow) => <span style={{ fontWeight: 700, color: clr.green }}>−{fmt$c(r.amount)}</span>, align: "right" as const },
    { header: "Applied By", render: (r: DiscountRow) => r.applied_by ?? "—" },
  ];

  return (
    <DashboardLayout title="Discounts Report">
      <div style={{ padding: "24px 28px", maxWidth: 1000 }}>
        <ReportHeader
          title="Discounts Report"
          subtitle="Every discount applied to a job in the selected date range."
          printable
          filters={<DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />}
        />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Total Discounted" value={fmt$c(s?.total_discount ?? 0)} color={clr.green} />
          <KpiCard label="Discounts Given" value={String(s?.count ?? 0)} color={clr.secondary} />
          <KpiCard label="% / $ split" value={`${s?.percent_count ?? 0} / ${s?.flat_count ?? 0}`} />
          {topCode && <KpiCard label="Top Code" value={topCode[0]} sub={fmt$c(topCode[1])} color={clr.amber} />}
        </div>

        <DataTable cols={cols} rows={rows} loading={loading} emptyMsg="No discounts applied in this date range." />
      </div>
    </DashboardLayout>
  );
}
