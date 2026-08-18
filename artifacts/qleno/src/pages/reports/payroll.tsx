import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$c, fmtDate, fmtH, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData, ReportError, fmtSvc, RangeClampNotice, type RangeClamp } from "./_shared";
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
  range_clamped?: RangeClamp | null;
  from: string; to: string;
  employees: {
    id: number; name: string; pay_basis: string; days_worked: number;
    job_hours: number; clock_hours: number; base_pay: number; tips: number;
    additional_pay: number; mileage: number; overtime: number | null;
    deductions: number; gross_pay: number; total_payout: number;
    effective_per_job_hour: number | null;
    missing_clk_outs: number; jobs_count: number;
  }[];
  overtime_available?: boolean;
  totals: { base_pay: number; tips: number; additional_pay: number; mileage: number; overtime: number | null; gross_pay: number; total_payout: number };
  flags: { missing_clocks: any[]; unclocked_out: any[] };
}

export default function PayrollReportPage() {
  const [from, setFrom] = useState(weekStart());
  const [to, setTo] = useState(() => weekEnd(weekStart()));

  const { data, loading, error, reload } = useReportData<PayrollData>(`/reports/payroll?from=${from}&to=${to}`);
  const emps = data?.employees ?? [];
  const totals = data?.totals;
  const flags = data?.flags;

  // How each person earned. Never "Hourly" — Phes pays commission, and the old
  // "Pay Type" column here was reading a stale `users.pay_type` label.
  const BASIS_LABEL: Record<string, string> = {
    residential_commission: "Commission",
    commercial_hourly: "Commercial hourly",
    mixed: "Commission + commercial",
    none: "—",
  };

  const cols = [
    { header: "Employee", render: (r: typeof emps[0]) => <span style={{ fontWeight: 500 }}>{r.name}</span> },
    { header: "Pay Basis", render: (r: typeof emps[0]) => BASIS_LABEL[r.pay_basis] ?? fmtSvc(r.pay_basis), align: "center" as const },
    { header: "Days", key: "days_worked" as const, align: "right" as const },
    { header: "Jobs", key: "jobs_count" as const, align: "right" as const },
    { header: "Job Hrs", render: (r: typeof emps[0]) => fmtH(r.job_hours), align: "right" as const },
    { header: "Clock Hrs", render: (r: typeof emps[0]) => fmtH(r.clock_hours), align: "right" as const },
    { header: "Base Pay", render: (r: typeof emps[0]) => fmt$c(r.base_pay), align: "right" as const },
    { header: "Tips", render: (r: typeof emps[0]) => fmt$c(r.tips), align: "right" as const },
    { header: "Add Pay", render: (r: typeof emps[0]) => fmt$c(r.additional_pay), align: "right" as const },
    // Reimbursement, not wages — shown beside pay, never inside it.
    { header: "Mileage", render: (r: typeof emps[0]) => r.mileage > 0 ? fmt$c(r.mileage) : "—", align: "right" as const },
    { header: "OT est.", render: (r: typeof emps[0]) => r.overtime == null ? <span style={{ color: clr.muted }}>n/a</span> : r.overtime > 0 ? <span style={{ color: clr.amber, fontWeight: 600 }}>{fmt$c(r.overtime)}</span> : "—", align: "right" as const },
    { header: "Gross Pay", render: (r: typeof emps[0]) => <span style={{ fontWeight: 700, color: clr.text }}>{fmt$c(r.gross_pay)}</span>, align: "right" as const },
    { header: "Total Payout", render: (r: typeof emps[0]) => <span style={{ fontWeight: 700, color: clr.text }}>{fmt$c(r.total_payout)}</span>, align: "right" as const },
    { header: "Per Job Hr", render: (r: typeof emps[0]) => r.effective_per_job_hour == null ? "—" : fmt$c(r.effective_per_job_hour), align: "right" as const },
    { header: "", render: (r: typeof emps[0]) => r.missing_clk_outs > 0 ? <span style={{ color: clr.red, fontSize: 11, fontWeight: 600 }}>{r.missing_clk_outs} missing out</span> : null },
  ];

  return (
    <DashboardLayout title="Payroll Summary">
      <div style={{ padding: "24px 28px", maxWidth: 1300 }}>
        <ReportHeader
          title="Payroll Summary"
          subtitle="Employee earnings breakdown for the selected pay period. Figures to enter into your payroll processor — Qleno does not process payroll."
          printable
          filters={<DateRange from={from} to={to} onChange={(f,t) => { setFrom(f); setTo(t); }} label="Pay Period" />}
        />

        {error ? <ReportError error={error} onRetry={reload} /> : <>

        <RangeClampNotice clamp={data?.range_clamped} />

        {/* Flags */}
        {((flags?.missing_clocks?.length ?? 0) > 0 || (flags?.unclocked_out?.length ?? 0) > 0) && (
          <div style={{ backgroundColor: "#FDF3E4", border: "1px solid #F59E0B", borderRadius: 8, padding: "12px 16px", marginBottom: 20, display: "flex", gap: 10 }}>
            <AlertTriangle size={16} color={clr.amber} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 13, color: "#B45309" }}>
              {(flags?.missing_clocks?.length ?? 0) > 0 && <p style={{ margin: "0 0 4px" }}><strong>{flags!.missing_clocks.length} job{flags!.missing_clocks.length > 1 ? "s" : ""}</strong> completed with no timeclock entry.</p>}
              {(flags?.unclocked_out?.length ?? 0) > 0 && <p style={{ margin: 0 }}><strong>{flags!.unclocked_out.length} employee{flags!.unclocked_out.length > 1 ? "s" : ""}</strong> clocked in with no clock-out.</p>}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Total Payout" value={fmt$c(totals?.total_payout ?? 0)} />
          <KpiCard label="Gross Pay" value={fmt$c(totals?.gross_pay ?? 0)} color={clr.secondary} />
          <KpiCard label="Base Pay" value={fmt$c(totals?.base_pay ?? 0)} color={clr.secondary} />
          <KpiCard label="Tips" value={fmt$c(totals?.tips ?? 0)} color={clr.green} />
          <KpiCard label="Additional Pay" value={fmt$c(totals?.additional_pay ?? 0)} color={clr.secondary} />
          {(totals?.mileage ?? 0) > 0 && <KpiCard label="Mileage Reimbursement" value={fmt$c(totals?.mileage ?? 0)} color={clr.secondary} />}
          {(totals?.overtime ?? 0) > 0 && <KpiCard label="Overtime est." value={fmt$c(totals?.overtime ?? 0)} color={clr.amber} />}
        </div>

        <p style={{ fontSize: 12, color: clr.muted, margin: "-12px 0 22px", maxWidth: 760, lineHeight: 1.5 }}>
          Base pay is commission, from the same engine that produces the paychecks.
          Mileage is a reimbursement and is reported beside pay, never inside it —
          Total Payout is gross pay plus mileage. "Per Job Hr" is effective earnings
          per recorded job hour, not an hourly wage. Overtime is an estimate for
          review; Qleno does not process payroll.
        </p>

        <DataTable cols={cols} rows={emps} loading={loading} emptyMsg="No employee pay data for this period." />
        </>}
      </div>
    </DashboardLayout>
  );
}
