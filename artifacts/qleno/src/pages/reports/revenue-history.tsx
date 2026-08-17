import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$, fmt$c, fmtDate, clr, KpiCard, ReportHeader, DataTable, StatusBadge, ReportError, useReportData } from "./_shared";

// [revenue-history 2026-07-04] MaidCentral revenue history, preserved for
// reporting before Phes lost MC access after 7/11/2026 (MC's "Revenue
// Production Planning" report, captured 2026-07-04, full range).
//
// [mc-revenue-history 2026-08-17] The figures used to be a hardcoded array in
// this file. They now live in the `mc_revenue_history` table and arrive from
// /api/reports/revenue-history, so this page and the Revenue Summary report
// read the same numbers, and a figure can be corrected without a deploy.
type RevType = "actual" | "partial" | "projected";
interface MonthRow {
  month: string; month_key: string;
  phes: number; schaumburg: number; total: number;
  type: RevType; source: string;
}
interface HistoryData {
  data: MonthRow[];
  summary: {
    actual_total: number; projected_total: number; full_total: number;
    actual_months: number; first_month: string | null; last_actual_month: string | null;
  };
  captured_at: string | null;
  cutover_date: string | null;
}

const typeColor: Record<RevType, string> = { actual: clr.green, partial: clr.amber, projected: clr.muted };
const typeLabel: Record<RevType, string> = { actual: "Actual", partial: "Partial", projected: "Projected" };

export default function RevenueHistoryPage() {
  const { data, loading, error, reload } = useReportData<HistoryData>("/reports/revenue-history");
  const rows = data?.data ?? [];
  const s = data?.summary;

  const cols = [
    { header: "Month", render: (r: MonthRow) => <span style={{ fontWeight: 600 }}>{r.month}</span> },
    { header: "Phes (Oak Lawn)", render: (r: MonthRow) => fmt$c(r.phes), align: "right" as const },
    { header: "Schaumburg", render: (r: MonthRow) => r.schaumburg ? fmt$c(r.schaumburg) : "—", align: "right" as const },
    { header: "Total", render: (r: MonthRow) => <span style={{ fontWeight: 700 }}>{fmt$c(r.total)}</span>, align: "right" as const },
    { header: "Type", render: (r: MonthRow) => <StatusBadge label={typeLabel[r.type] ?? r.type} color={typeColor[r.type] ?? clr.muted} /> },
  ];

  return (
    <DashboardLayout title="Revenue History (MaidCentral)">
      <div style={{ padding: "24px 28px", maxWidth: 1000 }}>
        <ReportHeader
          title="Revenue History (MaidCentral)"
          subtitle={`Revenue from MaidCentral for the period before Qleno${data?.cutover_date ? `, which takes over from ${fmtDate(data.cutover_date)}` : ""}. Captured ${data?.captured_at ? fmtDate(data.captured_at) : "7/4/2026"}, before MC access ended 7/11. These are month totals with no job-level detail behind them, so they feed revenue history only — not payroll, margin, or per-customer reporting.`}
          printable
        />

        {error ? <ReportError error={error} onRetry={reload} /> : <>

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
          <KpiCard label="Actual Revenue" value={fmt$(s?.actual_total ?? 0)}
            sub={s?.first_month && s?.last_actual_month ? `Delivered · ${s.first_month} – ${s.last_actual_month}` : "Delivered"}
            color={clr.green} />
          <KpiCard label="Projected / Current" value={fmt$(s?.projected_total ?? 0)}
            sub="MaidCentral forecast · never collected" color={clr.muted} />
          <KpiCard label="Full-Range Total" value={fmt$(s?.full_total ?? 0)}
            sub="Matches MaidCentral's report total" color={clr.brand} />
          <KpiCard label="Months of History" value={String(s?.actual_months ?? 0)}
            sub="Actual months on record" color={clr.secondary} />
        </div>

        <p style={{ fontSize: 12, color: clr.secondary, margin: "0 0 12px", lineHeight: 1.5 }}>
          <strong style={{ color: clr.text }}>Reporting note:</strong> the <span style={{ color: clr.green, fontWeight: 600 }}>Actual</span> rows
          are the company's revenue for those months and are what the Revenue Summary report adds in when you ask for a period
          that reaches back before {data?.cutover_date ? fmtDate(data.cutover_date) : "the cutover"}.
          {" "}<span style={{ color: clr.amber, fontWeight: 600 }}>Partial</span> = the month was still running when the figures
          were captured; <span style={{ color: clr.muted, fontWeight: 600 }}>Projected</span> = MaidCentral's recurring-schedule
          forecast. Neither is counted anywhere — they are kept only so this page still reconciles to MaidCentral's own report
          total. Day-level detail is in <code>MC_Revenue_Daily_2024-2026.csv</code> (revenue backup).
        </p>

        <DataTable cols={cols} rows={rows} loading={loading} emptyMsg="No historical revenue on record." />
        </>}
      </div>
    </DashboardLayout>
  );
}
