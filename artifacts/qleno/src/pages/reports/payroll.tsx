import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$c, fmtDate, fmtH, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData, fmtSvc } from "./_shared";
import { AlertTriangle } from "lucide-react";

function weekStart() {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() + 1);
  return d.toISOString().split("T")[0];
}
function weekEnd(start: string) {
  const d = new Date(start);
  d.setDate(d.getDate() + 6);
  return d.toISOString().split("T")[0];
}

interface PayrollData {
  from: string; to: string;
  employees: {
    id: number; name: string; pay_type: string; days_worked: number;
    job_hours: number; clock_hours: number; base_pay: number; tips: number;
    additional_pay: number; overtime: number; deductions: number; gross_pay: number;
    missing_clk_outs: number; jobs_count: number;
  }[];
  totals: { base_pay: number; tips: number; additional_pay: number; overtime: number; gross_pay: number };
  flags: { missing_clocks: any[]; unclocked_out: any[] };
}

export default function PayrollReportPage() {
  const [from, setFrom] = useState(weekStart());
  const [to, setTo] = useState(() => weekEnd(weekStart()));

  const { data, loading } = useReportData<PayrollData>(`/reports/payroll?from=${from}&to=${to}`);
  const emps = data?.employees ?? [];
  const totals = data?.totals;
  const flags = data?.flags;

  const cols = [
    { header: "Employee", render: (r: typeof emps[0]) => <span style={{ fontWeight: 500 }}>{r.name}</span> },
    { header: "Pay Type", render: (r: typeof emps[0]) => fmtSvc(r.pay_type), align: "center" as const },
    { header: "Days", key: "days_worked" as const, align: "right" as const },
    { header: "Jobs", key: "jobs_count" as const, align: "right" as const },
    { header: "Job Hrs", render: (r: typeof emps[0]) => fmtH(r.job_hours), align: "right" as const },
    { header: "Clock Hrs", render: (r: typeof emps[0]) => fmtH(r.clock_hours), align: "right" as const },
    { header: "Base Pay", render: (r: typeof emps[0]) => fmt$c(r.base_pay), align: "right" as const },
    { header: "Tips", render: (r: typeof emps[0]) => fmt$c(r.tips), align: "right" as const },
    { header: "Add Pay", render: (r: typeof emps[0]) => fmt$c(r.additional_pay), align: "right" as const },
    { header: "OT", render: (r: typeof emps[0]) => r.overtime > 0 ? <span style={{ color: clr.amber, fontWeight: 600 }}>{fmt$c(r.overtime)}</span> : "—", align: "right" as const },
    { header: "Gross Pay", render: (r: typeof emps[0]) => <span style={{ fontWeight: 700, color: clr.text }}>{fmt$c(r.gross_pay)}</span>, align: "right" as const },
    { header: "", render: (r: typeof emps[0]) => r.missing_clk_outs > 0 ? <span style={{ color: clr.red, fontSize: 11, fontWeight: 600 }}>{r.missing_clk_outs} missing out</span> : null },
  ];

  return (
    <DashboardLayout title="Payroll Summary">
      <div style={{ padding: "24px 28px", maxWidth: 1300 }}>
        <ReportHeader
          title="Payroll Summary"
          subtitle="Employee earnings breakdown for the selected pay period."
          printable
          filters={<DateRange from={from} to={to} onChange={(f,t) => { setFrom(f); setTo(t); }} label="Pay Period" />}
        />

        {/* Flags */}
        {((flags?.missing_clocks?.length ?? 0) > 0 || (flags?.unclocked_out?.length ?? 0) > 0) && (
          <div style={{ backgroundColor: "#FEF3C7", border: "1px solid #F59E0B", borderRadius: 8, padding: "12px 16px", marginBottom: 20, display: "flex", gap: 10 }}>
            <AlertTriangle size={16} color={clr.amber} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 13, color: "#92400E" }}>
              {(flags?.missing_clocks?.length ?? 0) > 0 && <p style={{ margin: "0 0 4px" }}><strong>{flags!.missing_clocks.length} job{flags!.missing_clocks.length > 1 ? "s" : ""}</strong> completed with no timeclock entry.</p>}
              {(flags?.unclocked_out?.length ?? 0) > 0 && <p style={{ margin: 0 }}><strong>{flags!.unclocked_out.length} employee{flags!.unclocked_out.length > 1 ? "s" : ""}</strong> clocked in with no clock-out.</p>}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Total Gross Pay" value={fmt$c(totals?.gross_pay ?? 0)} />
          <KpiCard label="Base Pay" value={fmt$c(totals?.base_pay ?? 0)} color={clr.secondary} />
          <KpiCard label="Tips" value={fmt$c(totals?.tips ?? 0)} color={clr.green} />
          <KpiCard label="Additional Pay" value={fmt$c(totals?.additional_pay ?? 0)} color={clr.secondary} />
          {(totals?.overtime ?? 0) > 0 && <KpiCard label="Overtime" value={fmt$c(totals?.overtime ?? 0)} color={clr.amber} />}
        </div>

        <DataTable cols={cols} rows={emps} loading={loading} emptyMsg="No employee pay data for this period." />
      </div>
    </DashboardLayout>
  );
}
