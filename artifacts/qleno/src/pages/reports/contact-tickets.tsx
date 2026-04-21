import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmtDate, fmtSvc, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData, StatusBadge } from "./_shared";
import { AlertTriangle, Star, MessageSquare, FileText, Zap } from "lucide-react";

function today() { return new Date().toISOString().split("T")[0]; }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().split("T")[0]; }

interface TicketRow { id: number; type: string; notes: string | null; date: string; client_name: string | null; employee_name: string; created_by: string | null; }
interface CTData { from: string; to: string; data: TicketRow[]; counts: { complaints: number; breakages: number; compliments: number; incidents: number; notes: number }; }

const TYPE_COLORS: Record<string,string> = {
  breakage: "#EF4444", complaint_poor_cleaning: "#F97316", complaint_attitude: "#F97316",
  compliment: "#10B981", incident: "#8B5CF6", note: "#6B7280",
};
const TYPE_LABELS: Record<string,string> = {
  breakage: "Breakage", complaint_poor_cleaning: "Poor Cleaning", complaint_attitude: "Attitude",
  compliment: "Compliment", incident: "Incident", note: "Note",
};
const TICKET_TYPES = ["all","breakage","complaint_poor_cleaning","complaint_attitude","compliment","incident","note"] as const;

export default function ContactTicketsReportPage() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const [type, setType] = useState("all");

  const qs = type !== "all" ? `&type=${type}` : "";
  const { data, loading } = useReportData<CTData>(`/reports/contact-tickets?from=${from}&to=${to}${qs}`);
  const rows = data?.data ?? [];
  const counts = data?.counts;

  const cols = [
    { header: "Date", render: (r: TicketRow) => fmtDate(r.date) },
    { header: "Type", render: (r: TicketRow) => (
      <StatusBadge label={TYPE_LABELS[r.type] ?? fmtSvc(r.type)} color={TYPE_COLORS[r.type] ?? clr.secondary} />
    )},
    { header: "Client", render: (r: TicketRow) => r.client_name ?? <span style={{ color: clr.muted }}>—</span> },
    { header: "Employee", render: (r: TicketRow) => <span style={{ fontWeight: 500 }}>{r.employee_name}</span> },
    { header: "Notes", render: (r: TicketRow) => r.notes ? <span style={{ color: clr.secondary, fontSize: 12, display: "block", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.notes}</span> : <span style={{ color: clr.muted }}>—</span> },
    { header: "Logged By", render: (r: TicketRow) => r.created_by ?? <span style={{ color: clr.muted }}>—</span> },
  ];

  return (
    <DashboardLayout title="Contact Tickets">
      <div style={{ padding: "24px 28px", maxWidth: 1100 }}>
        <ReportHeader
          title="Contact Tickets"
          subtitle="Complaints, breakages, compliments, and incidents."
          printable
          filters={
            <>
              <DateRange from={from} to={to} onChange={(f,t) => { setFrom(f); setTo(t); }} />
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, color: clr.secondary, fontWeight: 500, marginRight: 4 }}>Type:</span>
                {TICKET_TYPES.map(t => (
                  <button key={t} onClick={() => setType(t)} style={{ padding: "4px 10px", fontSize: 11, fontWeight: 500, border: `1px solid ${clr.border}`, borderRadius: 5, cursor: "pointer", fontFamily: "inherit", backgroundColor: type === t ? clr.brand : clr.card, color: type === t ? "#fff" : clr.secondary }}>
                    {t === "all" ? "All" : TYPE_LABELS[t] ?? fmtSvc(t)}
                  </button>
                ))}
              </div>
            </>
          }
        />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 10, padding: "12px 16px" }}>
            <AlertTriangle size={14} color="#F97316" />
            <div><p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 600, color: clr.muted, textTransform: "uppercase" }}>Complaints</p><p style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#F97316" }}>{counts?.complaints ?? 0}</p></div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 10, padding: "12px 16px" }}>
            <Zap size={14} color={clr.red} />
            <div><p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 600, color: clr.muted, textTransform: "uppercase" }}>Breakages</p><p style={{ margin: 0, fontSize: 22, fontWeight: 700, color: clr.red }}>{counts?.breakages ?? 0}</p></div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 10, padding: "12px 16px" }}>
            <Star size={14} color={clr.green} />
            <div><p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 600, color: clr.muted, textTransform: "uppercase" }}>Compliments</p><p style={{ margin: 0, fontSize: 22, fontWeight: 700, color: clr.green }}>{counts?.compliments ?? 0}</p></div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 10, padding: "12px 16px" }}>
            <MessageSquare size={14} color="#8B5CF6" />
            <div><p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 600, color: clr.muted, textTransform: "uppercase" }}>Incidents</p><p style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#8B5CF6" }}>{counts?.incidents ?? 0}</p></div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 10, padding: "12px 16px" }}>
            <FileText size={14} color={clr.secondary} />
            <div><p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 600, color: clr.muted, textTransform: "uppercase" }}>Notes</p><p style={{ margin: 0, fontSize: 22, fontWeight: 700, color: clr.secondary }}>{counts?.notes ?? 0}</p></div>
          </div>
        </div>

        <DataTable cols={cols} rows={rows} loading={loading} emptyMsg="No contact tickets in this date range." />
      </div>
    </DashboardLayout>
  );
}
