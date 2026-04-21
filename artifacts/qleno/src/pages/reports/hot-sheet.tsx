import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$c, fmtSvc, fmtH, clr, KpiCard, ReportHeader, DataTable, useReportData, StatusBadge, ScoreBadge } from "./_shared";
import { MapPin, Star, AlertTriangle } from "lucide-react";

function today() { return new Date().toISOString().split("T")[0]; }

interface HotRow { id: number; time: string | null; service_type: string; status: string; client_name: string; address: string | null; city: string | null; employee_name: string; special_instructions: string | null; notes: string | null; last_score: number | null; is_first_time: boolean; base_fee: number; allowed_hours: number; }
interface HotData { date: string; data: HotRow[]; }

export default function HotSheetPage() {
  const [date, setDate] = useState(today());
  const { data, loading } = useReportData<HotData>(`/reports/hot-sheet?date=${date}`);
  const rows = data?.data ?? [];

  const statColor = (s: string) => s === "in_progress" ? clr.green : s === "scheduled" ? clr.brand : clr.muted;

  const cols = [
    { header: "Time", render: (r: HotRow) => r.time ? <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{r.time.slice(0,5)}</span> : <span style={{ color: clr.muted }}>—</span>, width: 60 },
    { header: "Client", render: (r: HotRow) => (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontWeight: 600 }}>{r.client_name}</span>
          {r.is_first_time && <span style={{ fontSize: 10, fontWeight: 700, backgroundColor: "#5B9BD518", color: clr.brand, borderRadius: 4, padding: "1px 5px" }}>FIRST</span>}
          {r.last_score !== null && r.last_score <= 2 && <span style={{ fontSize: 10, fontWeight: 700, backgroundColor: "#FEF2F2", color: clr.red, borderRadius: 4, padding: "1px 5px" }}>LOW SCORE</span>}
        </div>
        {r.address && <div style={{ fontSize: 11, color: clr.secondary, display: "flex", alignItems: "center", gap: 3, marginTop: 2 }}><MapPin size={10} />{r.address}{r.city ? `, ${r.city}` : ""}</div>}
      </div>
    )},
    { header: "Service", render: (r: HotRow) => fmtSvc(r.service_type) },
    { header: "Employee", key: "employee_name" as const, render: (r: HotRow) => <span style={{ fontWeight: 500 }}>{r.employee_name}</span> },
    { header: "Status", render: (r: HotRow) => <StatusBadge label={fmtSvc(r.status)} color={statColor(r.status)} /> },
    { header: "Fee", render: (r: HotRow) => fmt$c(r.base_fee), align: "right" as const },
    { header: "Hrs", render: (r: HotRow) => fmtH(r.allowed_hours), align: "right" as const },
    { header: "Last Score", render: (r: HotRow) => r.last_score !== null ? <ScoreBadge score={r.last_score} /> : <span style={{ color: clr.muted }}>New</span> },
    { header: "Notes", render: (r: HotRow) => (r.special_instructions || r.notes) ? (
      <span style={{ fontSize: 11, color: clr.secondary, display: "block", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {r.special_instructions || r.notes}
      </span>
    ) : null },
  ];

  const firstTimeCount = rows.filter(r => r.is_first_time).length;
  const totalFee = rows.reduce((s,r) => s + r.base_fee, 0);

  return (
    <DashboardLayout title="Hot Sheet">
      <div style={{ padding: "24px 28px", maxWidth: 1300 }}>
        <ReportHeader
          title="Hot Sheet"
          subtitle="All scheduled jobs for the selected date with client details and flags."
          printable
          filters={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, color: clr.secondary, fontWeight: 500 }}>Date:</span>
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                style={{ fontSize: 13, padding: "5px 10px", border: `1px solid ${clr.border}`, borderRadius: 6, color: clr.text, backgroundColor: clr.card, fontFamily: "inherit" }} />
            </div>
          }
        />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Total Jobs" value={String(rows.length)} />
          <KpiCard label="First Time Clients" value={String(firstTimeCount)} color={clr.brand} sub="Require extra attention" />
          <KpiCard label="Total Revenue" value={fmt$c(totalFee)} color={clr.green} />
          <KpiCard label="Unassigned" value={String(rows.filter(r => r.employee_name === "Unassigned").length)} color={rows.some(r => r.employee_name === "Unassigned") ? clr.red : clr.secondary} />
        </div>

        {firstTimeCount > 0 && (
          <div style={{ backgroundColor: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 8, padding: "10px 14px", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
            <Star size={14} color={clr.brand} />
            <span style={{ fontSize: 13, color: "#1D4ED8", fontWeight: 500 }}>{firstTimeCount} first-time client{firstTimeCount > 1 ? "s" : ""} today — ensure extra quality and proper introduction.</span>
          </div>
        )}

        <DataTable cols={cols} rows={rows} loading={loading} emptyMsg={`No jobs scheduled for ${date}.`} />
      </div>
    </DashboardLayout>
  );
}
