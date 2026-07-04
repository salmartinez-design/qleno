import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$, fmt$c, clr, KpiCard, ReportHeader, DataTable, StatusBadge } from "./_shared";

// [revenue-history 2026-07-04] MaidCentral revenue history, preserved for
// reporting before Phes lost MC access after 7/11/2026. This is STATIC,
// immutable data (MC's "Revenue Production Planning" report, captured
// 2026-07-04, full range) — bundled here so it survives with no dependency on
// MaidCentral or the live Qleno invoice tables. Deliberately kept SEPARATE from
// Qleno's live revenue KPIs so it never inflates Qleno-native numbers. Source
// files: Desktop/MC-Revenue-Backup (daily + monthly CSV). Totals here reconcile
// exactly to MaidCentral's own totals.
type RevType = "Actual" | "Partial" | "Projected";
interface MonthRow { month: string; phes: number; schaumburg: number; total: number; type: RevType; }

const MC_MONTHLY: MonthRow[] = [
  { month: "04/2024", phes: 13591.37, schaumburg: 0, total: 13591.37, type: "Actual" },
  { month: "05/2024", phes: 57076.77, schaumburg: 0, total: 57076.77, type: "Actual" },
  { month: "06/2024", phes: 53491.49, schaumburg: 0, total: 53491.49, type: "Actual" },
  { month: "07/2024", phes: 59283.27, schaumburg: 0, total: 59283.27, type: "Actual" },
  { month: "08/2024", phes: 71906.50, schaumburg: 0, total: 71906.50, type: "Actual" },
  { month: "09/2024", phes: 57534.74, schaumburg: 0, total: 57534.74, type: "Actual" },
  { month: "10/2024", phes: 58414.64, schaumburg: 0, total: 58414.64, type: "Actual" },
  { month: "11/2024", phes: 51840.23, schaumburg: 0, total: 51840.23, type: "Actual" },
  { month: "12/2024", phes: 56968.73, schaumburg: 0, total: 56968.73, type: "Actual" },
  { month: "01/2025", phes: 51542.83, schaumburg: 0, total: 51542.83, type: "Actual" },
  { month: "02/2025", phes: 46237.64, schaumburg: 0, total: 46237.64, type: "Actual" },
  { month: "03/2025", phes: 64370.84, schaumburg: 0, total: 64370.84, type: "Actual" },
  { month: "04/2025", phes: 69311.97, schaumburg: 0, total: 69311.97, type: "Actual" },
  { month: "05/2025", phes: 68576.08, schaumburg: 0, total: 68576.08, type: "Actual" },
  { month: "06/2025", phes: 69809.25, schaumburg: 0, total: 69809.25, type: "Actual" },
  { month: "07/2025", phes: 66814.07, schaumburg: 0, total: 66814.07, type: "Actual" },
  { month: "08/2025", phes: 62256.95, schaumburg: 0, total: 62256.95, type: "Actual" },
  { month: "09/2025", phes: 58568.53, schaumburg: 0, total: 58568.53, type: "Actual" },
  { month: "10/2025", phes: 66244.60, schaumburg: 0, total: 66244.60, type: "Actual" },
  { month: "11/2025", phes: 51780.41, schaumburg: 0, total: 51780.41, type: "Actual" },
  { month: "12/2025", phes: 53283.19, schaumburg: 0, total: 53283.19, type: "Actual" },
  { month: "01/2026", phes: 52218.71, schaumburg: 0, total: 52218.71, type: "Actual" },
  { month: "02/2026", phes: 45643.27, schaumburg: 0, total: 45643.27, type: "Actual" },
  { month: "03/2026", phes: 58108.14, schaumburg: 1109.10, total: 59217.24, type: "Actual" },
  { month: "04/2026", phes: 62645.63, schaumburg: 904.00, total: 63549.63, type: "Actual" },
  { month: "05/2026", phes: 74236.42, schaumburg: 0, total: 74236.42, type: "Actual" },
  { month: "06/2026", phes: 86215.10, schaumburg: 0, total: 86215.10, type: "Actual" },
  { month: "07/2026", phes: 56400.06, schaumburg: 0, total: 56400.06, type: "Partial" },
  { month: "08/2026", phes: 49804.52, schaumburg: 0, total: 49804.52, type: "Projected" },
  { month: "09/2026", phes: 51492.19, schaumburg: 0, total: 51492.19, type: "Projected" },
  { month: "10/2026", phes: 48571.04, schaumburg: 0, total: 48571.04, type: "Projected" },
  { month: "11/2026", phes: 48745.67, schaumburg: 0, total: 48745.67, type: "Projected" },
  { month: "12/2026", phes: 49784.04, schaumburg: 0, total: 49784.04, type: "Projected" },
];

const sum = (rows: MonthRow[], k: "phes" | "schaumburg" | "total") => rows.reduce((s, r) => s + r[k], 0);
const actualRows = MC_MONTHLY.filter(r => r.type === "Actual");
const ACTUAL_TOTAL = sum(actualRows, "total");            // delivered Apr 2024 – Jun 2026
const FULL_TOTAL = sum(MC_MONTHLY, "total");              // incl. current-month + projected
const PROJECTED_TOTAL = FULL_TOTAL - ACTUAL_TOTAL;

const typeColor: Record<RevType, string> = { Actual: clr.green, Partial: clr.amber, Projected: clr.muted };

export default function RevenueHistoryPage() {
  const cols = [
    { header: "Month", render: (r: MonthRow) => <span style={{ fontWeight: 600 }}>{r.month}</span> },
    { header: "Phes (Oak Lawn)", render: (r: MonthRow) => fmt$c(r.phes), align: "right" as const },
    { header: "Schaumburg", render: (r: MonthRow) => r.schaumburg ? fmt$c(r.schaumburg) : "—", align: "right" as const },
    { header: "Total", render: (r: MonthRow) => <span style={{ fontWeight: 700 }}>{fmt$c(r.total)}</span>, align: "right" as const },
    { header: "Type", render: (r: MonthRow) => <StatusBadge label={r.type} color={typeColor[r.type]} /> },
  ];

  return (
    <DashboardLayout title="Revenue History (MaidCentral)">
      <div style={{ padding: "24px 28px", maxWidth: 1000 }}>
        <ReportHeader
          title="Revenue History (MaidCentral)"
          subtitle="Pre-Qleno revenue from MaidCentral, preserved for reporting (captured 7/4/2026, before MC access ended 7/11). Kept separate from Qleno's live revenue — these numbers do NOT flow into the Qleno KPIs. Data begins Apr 2024 (MC adoption)."
          printable
        />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
          <KpiCard label="Actual Revenue" value={fmt$(ACTUAL_TOTAL)} sub="Delivered · Apr 2024 – Jun 2026" color={clr.green} />
          <KpiCard label="Projected / Current" value={fmt$(PROJECTED_TOTAL)} sub="Jul – Dec 2026 · scheduled, not collected" color={clr.muted} />
          <KpiCard label="Full-Range Total" value={fmt$(FULL_TOTAL)} sub="Matches MaidCentral's report total" color={clr.brand} />
          <KpiCard label="Months of History" value={String(actualRows.length)} sub="Actual months on record" color={clr.secondary} />
        </div>

        <p style={{ fontSize: 12, color: clr.secondary, margin: "0 0 12px", lineHeight: 1.5 }}>
          <strong style={{ color: clr.text }}>Reporting note:</strong> use the <span style={{ color: clr.green, fontWeight: 600 }}>Actual</span> rows
          (through Jun 2026) for historical revenue. <span style={{ color: clr.amber, fontWeight: 600 }}>Partial</span> = current month at capture;
          {" "}<span style={{ color: clr.muted, fontWeight: 600 }}>Projected</span> = recurring-schedule forecast, not collected. Day-level detail is in
          {" "}<code>MC_Revenue_Daily_2024-2026.csv</code> (revenue backup).
        </p>

        <DataTable cols={cols} rows={MC_MONTHLY} emptyMsg="No historical revenue on record." />
      </div>
    </DashboardLayout>
  );
}
