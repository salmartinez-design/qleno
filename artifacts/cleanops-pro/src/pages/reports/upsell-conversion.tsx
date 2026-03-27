import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$c, fmtDate, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData } from "./_shared";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

const FF = "'Plus Jakarta Sans', sans-serif";

function today() { return new Date().toISOString().split("T")[0]; }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split("T")[0]; }
function pct(n: number, d: number) { return d === 0 ? "0%" : `${Math.round(n / d * 100)}%`; }
function cadenceLabel(c: string) { return ({ weekly: "Weekly", biweekly: "Every 2 Weeks", monthly: "Every 4 Weeks" } as any)[c] ?? c ?? "—"; }

interface UpsellRow { id: number; date: string; client_name: string; cadence: string | null; upsell_accepted: boolean; upsell_declined: boolean; upsell_deferred: boolean; locked_rate: string | null; deep_clean_total: string; }
interface UpsellData { kpi: { total_shown: number; total_accepted: number; total_declined: number; total_deferred: number }; trend: { week_label: string; shown: number; accepted: number }[]; rows: UpsellRow[]; lockHealth: { active_count: number; expiring_30: number; voided_month: number; voided_time_overrun: number; voided_service_gap: number; voided_manual: number; voided_expired: number }; }

export default function UpsellConversionPage() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const [statusFilter, setStatusFilter] = useState("all");
  const [cadenceFilter, setCadenceFilter] = useState("all");

  const queryStr = `from=${from}&to=${to}&status=${statusFilter}&cadence=${cadenceFilter}`;
  const { data, loading } = useReportData<UpsellData>(`/reports/upsell-conversion?${queryStr}`);

  const kpi = data?.kpi;
  const trend = (data?.trend ?? []).map(t => ({
    week: t.week_label,
    rate: t.shown > 0 ? Math.round(t.accepted / t.shown * 100) : 0,
  }));
  const lh = data?.lockHealth;

  const statusPill = (r: UpsellRow) => {
    if (r.upsell_accepted) return <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "#DCFCE7", color: "#166534" }}>Accepted</span>;
    if (r.upsell_declined && !r.upsell_accepted) return <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "#FEE2E2", color: "#991B1B" }}>Declined</span>;
    if (r.upsell_deferred) return <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "#FEF3C7", color: "#92400E" }}>Deferred</span>;
    return <span style={{ fontSize: 11, color: clr.muted }}>—</span>;
  };

  const cols = [
    { header: "Date", render: (r: UpsellRow) => fmtDate(r.date) },
    { header: "Client", render: (r: UpsellRow) => <span style={{ fontWeight: 500 }}>{r.client_name}</span> },
    { header: "Cadence Selected", render: (r: UpsellRow) => r.cadence ? cadenceLabel(r.cadence) : <span style={{ color: clr.muted }}>—</span> },
    { header: "Locked Rate", render: (r: UpsellRow) => r.locked_rate ? fmt$c(parseFloat(r.locked_rate)) : <span style={{ color: clr.muted }}>—</span>, align: "right" as const },
    { header: "Deep Clean Total", render: (r: UpsellRow) => fmt$c(parseFloat(r.deep_clean_total ?? 0)), align: "right" as const },
    { header: "Status", render: statusPill },
  ];

  const selStyle = (active: boolean): React.CSSProperties => ({
    padding: "6px 14px", borderRadius: 7, border: `1px solid ${active ? "var(--brand)" : "#E5E2DC"}`,
    background: active ? "var(--brand)" : "#FFFFFF", color: active ? "#FFFFFF" : "#6B6860",
    fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF,
  });

  const total = kpi?.total_shown ?? 0;

  return (
    <DashboardLayout title="Upsell Conversion">
      <div style={{ padding: "24px 28px", maxWidth: 1100, fontFamily: FF }}>
        <ReportHeader
          title="Upsell Conversion"
          subtitle="Deep Clean to recurring conversion performance"
          printable
          filters={<DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />}
        />

        {/* KPI Cards */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Deep Cleans with Upsell" value={String(total)} color={clr.secondary} />
          <KpiCard label="Accepted" value={String(kpi?.total_accepted ?? 0)} color="#166534" sub={pct(kpi?.total_accepted ?? 0, total)} />
          <KpiCard label="Declined" value={String(kpi?.total_declined ?? 0)} color={clr.red} sub={pct(kpi?.total_declined ?? 0, total)} />
          <KpiCard label="Deferred" value={String(kpi?.total_deferred ?? 0)} color={clr.amber} sub={pct(kpi?.total_deferred ?? 0, total)} />
        </div>

        {/* Trend chart */}
        {trend.length > 0 && (
          <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 24px", marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", marginBottom: 16 }}>Weekly Acceptance Rate</div>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={trend} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F0EDE8" />
                <XAxis dataKey="week" tick={{ fontSize: 11, fontFamily: FF, fill: "#9E9B94" }} />
                <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fontSize: 11, fontFamily: FF, fill: "#9E9B94" }} />
                <Tooltip formatter={(v: any) => [`${v}%`, "Acceptance Rate"]} contentStyle={{ fontFamily: FF, fontSize: 12 }} />
                <Line type="monotone" dataKey="rate" stroke="var(--brand)" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Filters */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#6B6860", fontFamily: FF }}>Status:</span>
          {(["all", "accepted", "declined", "deferred"] as const).map(s => (
            <button key={s} style={selStyle(statusFilter === s)} onClick={() => setStatusFilter(s)}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
          <span style={{ fontSize: 12, fontWeight: 600, color: "#6B6860", fontFamily: FF, marginLeft: 8 }}>Cadence:</span>
          {(["all", "weekly", "biweekly", "monthly"] as const).map(c => (
            <button key={c} style={selStyle(cadenceFilter === c)} onClick={() => setCadenceFilter(c)}>
              {c === "all" ? "All" : cadenceLabel(c)}
            </button>
          ))}
        </div>

        <DataTable cols={cols} rows={data?.rows ?? []} loading={loading} emptyMsg="No Deep Clean upsell records in this range." />

        {/* Rate lock health */}
        <div style={{ marginTop: 28, background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", marginBottom: 16 }}>Rate Lock Health</div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {[
              { label: "Active Rate Locks", value: lh?.active_count ?? 0, color: "#166534" },
              { label: "Expiring Within 30 Days", value: lh?.expiring_30 ?? 0, color: clr.amber },
              { label: "Voided This Month", value: lh?.voided_month ?? 0, color: clr.red },
            ].map(t => (
              <div key={t.label} style={{ flex: 1, minWidth: 160, border: "1px solid #E5E2DC", borderRadius: 8, padding: "14px 18px" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, fontFamily: FF }}>{t.label}</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: t.color, fontFamily: FF }}>{t.value}</div>
              </div>
            ))}
          </div>
          {(lh?.voided_month ?? 0) > 0 && (
            <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
              {[
                { label: "Time Overrun", value: lh?.voided_time_overrun ?? 0 },
                { label: "Service Gap", value: lh?.voided_service_gap ?? 0 },
                { label: "Manual", value: lh?.voided_manual ?? 0 },
                { label: "Expired", value: lh?.voided_expired ?? 0 },
              ].filter(x => x.value > 0).map(x => (
                <span key={x.label} style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 12, background: "#FEE2E2", color: "#991B1B", fontFamily: FF }}>
                  {x.label}: {x.value}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
