import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$, fmt$c, fmtDate, clr, KpiCard, ReportHeader, DataTable, useReportData, StatusBadge } from "./_shared";

interface ARRow { id: number; status: string; total: number; client_name: string; client_email: string; invoice_date: string; due_date: string; days_overdue: number; }
interface ARData { summary: { current: number; late: number; very_late: number; critical: number; total_outstanding: number }; data: ARRow[]; }

const FILTERS = ["all","overdue","0-30","31-60","90+"] as const;
type Filter = typeof FILTERS[number];

export default function ReceivablesPage() {
  const [filter, setFilter] = useState<Filter>("all");

  const { data, loading } = useReportData<ARData>(`/reports/receivables?filter=${filter}`);
  const rows = data?.data ?? [];
  const s = data?.summary;

  function agingColor(days: number) { return days <= 0 ? clr.green : days <= 30 ? clr.amber : days <= 60 ? "#F97316" : clr.red; }

  const cols = [
    { header: "Client", render: (r: ARRow) => <div><p style={{ margin: 0, fontWeight: 500 }}>{r.client_name}</p><p style={{ margin: 0, fontSize: 11, color: clr.muted }}>{r.client_email}</p></div> },
    { header: "Invoice #", render: (r: ARRow) => <span style={{ color: clr.secondary }}>INV-{String(r.id).padStart(4,"0")}</span> },
    { header: "Invoice Date", render: (r: ARRow) => fmtDate(r.invoice_date) },
    { header: "Due Date", render: (r: ARRow) => fmtDate(r.due_date) },
    { header: "Amount", render: (r: ARRow) => <span style={{ fontWeight: 700 }}>{fmt$c(r.total)}</span>, align: "right" as const },
    { header: "Status", render: (r: ARRow) => {
      if (r.days_overdue <= 0) return <StatusBadge label="Current" color={clr.green} />;
      if (r.days_overdue <= 30) return <StatusBadge label={`${r.days_overdue}d overdue`} color={clr.amber} />;
      if (r.days_overdue <= 60) return <StatusBadge label={`${r.days_overdue}d overdue`} color="#F97316" />;
      return <StatusBadge label={`${r.days_overdue}d overdue`} color={clr.red} />;
    }},
    { header: "Days Overdue", render: (r: ARRow) => r.days_overdue > 0 ? <span style={{ fontWeight: 600, color: agingColor(r.days_overdue) }}>{r.days_overdue}</span> : <span style={{ color: clr.muted }}>—</span>, align: "right" as const },
  ];

  return (
    <DashboardLayout title="Accounts Receivable">
      <div style={{ padding: "24px 28px", maxWidth: 1100 }}>
        <ReportHeader
          title="Accounts Receivable"
          subtitle="Outstanding invoices grouped by aging bucket."
          printable
          filters={
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: clr.secondary, fontWeight: 500, marginRight: 4 }}>Filter:</span>
              {FILTERS.map(f => (
                <button key={f} onClick={() => setFilter(f)} style={{ padding: "5px 12px", fontSize: 12, fontWeight: 500, border: `1px solid ${clr.border}`, borderRadius: 5, cursor: "pointer", fontFamily: "inherit", backgroundColor: filter === f ? clr.brand : clr.card, color: filter === f ? "#fff" : clr.secondary }}>
                  {f === "all" ? "All" : f === "overdue" ? "Overdue" : f}
                </button>
              ))}
            </div>
          }
        />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Total Outstanding" value={fmt$(s?.total_outstanding ?? 0)} />
          <KpiCard label="Current (0-30d)" value={fmt$(s?.current ?? 0)} color={clr.green} />
          <KpiCard label="Late (31-60d)" value={fmt$(s?.late ?? 0)} color={clr.amber} />
          <KpiCard label="Very Late (61-90d)" value={fmt$(s?.very_late ?? 0)} color="#F97316" />
          <KpiCard label="Critical (90d+)" value={fmt$(s?.critical ?? 0)} color={clr.red} />
        </div>

        <DataTable cols={cols} rows={rows} loading={loading} emptyMsg="No outstanding invoices." />
      </div>
    </DashboardLayout>
  );
}
