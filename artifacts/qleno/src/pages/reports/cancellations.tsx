import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$c, fmtDate, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData } from "./_shared";

function today() { return new Date().toISOString().split("T")[0]; }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().split("T")[0]; }

interface CancelRow { id: number; name: string; email: string; client_since: string; cancelled_date: string; tenure_days: number; bill_rate: number; last_score: number | null; notes: string | null; }
interface ByActionRow { action: string; count: number; total_charged: number; }
interface CancelData {
  from: string; to: string; data: CancelRow[];
  summary: {
    total: number; avg_tenure_days: number; revenue_lost: number;
    // Cancellation-fee revenue (the money we DID collect) — distinct
    // from revenue_lost (the money we'd have made if the visits ran).
    cancellation_revenue?: number;
    lockout_total?: number; lockout_count?: number;
    cancel_total?: number; cancel_count?: number;
  };
  by_action?: ByActionRow[];
}

// Human label + accent color per cancel_action. Mirrors the dispatch
// modal so the office sees consistent vocabulary between cancelling
// and reporting.
const ACTION_META: Record<string, { label: string; color: string }> = {
  move:           { label: "Move",           color: "#7E22CE" },
  bump:           { label: "Bump",           color: "#BE185D" },
  skip:           { label: "Skip",           color: "#B3261E" },
  cancel:         { label: "Cancel",         color: "#7F1D1D" },
  lockout:        { label: "Lockout",        color: "#1E293B" },
  cancel_service: { label: "Cancel Service", color: "#B3261E" },
  legacy:         { label: "Legacy (no action)", color: "#9E9B94" },
};

export default function CancellationsPage() {
  const [from, setFrom] = useState(daysAgo(90));
  const [to, setTo] = useState(today());

  const { data, loading } = useReportData<CancelData>(`/reports/cancellations?from=${from}&to=${to}`);
  const rows = data?.data ?? [];
  const s = data?.summary;

  const tenureLabel = (days: number) => {
    if (days < 30) return <span style={{ color: clr.red }}>Less than 1 month</span>;
    if (days < 90) return <span style={{ color: clr.amber }}>{Math.floor(days/30)} months</span>;
    const yrs = Math.floor(days/365);
    const mos = Math.floor((days % 365) / 30);
    return <span style={{ color: clr.secondary }}>{yrs > 0 ? `${yrs}yr ` : ""}{mos > 0 ? `${mos}mo` : ""}</span>;
  };

  const cols = [
    { header: "Client", render: (r: CancelRow) => <div><p style={{ margin: 0, fontWeight: 500 }}>{r.name}</p><p style={{ margin: 0, fontSize: 11, color: clr.muted }}>{r.email}</p></div> },
    { header: "Client Since", render: (r: CancelRow) => fmtDate(r.client_since) },
    { header: "Cancelled", render: (r: CancelRow) => fmtDate(r.cancelled_date) },
    { header: "Tenure", render: (r: CancelRow) => tenureLabel(r.tenure_days) },
    { header: "Bill Rate", render: (r: CancelRow) => fmt$c(r.bill_rate), align: "right" as const },
    { header: "Last Score", render: (r: CancelRow) => r.last_score !== null ? <span style={{ fontWeight: 600, color: r.last_score <= 2 ? clr.red : clr.secondary }}>{r.last_score}/4</span> : <span style={{ color: clr.muted }}>—</span>, align: "center" as const },
    { header: "Notes", render: (r: CancelRow) => r.notes ? <span style={{ color: clr.secondary, fontSize: 12 }}>{r.notes}</span> : <span style={{ color: clr.muted }}>—</span> },
  ];

  return (
    <DashboardLayout title="Cancellations">
      <div style={{ padding: "24px 28px", maxWidth: 1100 }}>
        <ReportHeader
          title="Cancelled Clients"
          subtitle="Clients with cancelled jobs in the selected date range."
          printable
          filters={<DateRange from={from} to={to} onChange={(f,t) => { setFrom(f); setTo(t); }} />}
        />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 16 }}>
          <KpiCard label="Total Cancellations" value={String(s?.total ?? 0)} color={clr.red} />
          <KpiCard label="Avg Client Tenure" value={`${Math.round((s?.avg_tenure_days ?? 0)/30)} mo`} color={clr.secondary} />
          <KpiCard label="Revenue at Risk" value={fmt$c(s?.revenue_lost ?? 0)} color={clr.amber} sub="Based on last bill rate" />
        </div>

        {/* Cancellation revenue strip — the fees we DID collect. Separate
            from "Revenue at Risk" above which is what we didn't earn from
            the missed visits. Both numbers are useful for forecasting. */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard
            label="Cancellation Revenue"
            value={fmt$c(s?.cancellation_revenue ?? 0)}
            color={clr.green}
            sub="Fees collected from cancel + lockout"
          />
          <KpiCard
            label="Lockout Fees"
            value={fmt$c(s?.lockout_total ?? 0)}
            color={clr.green}
            sub={`${s?.lockout_count ?? 0} lockout${(s?.lockout_count ?? 0) === 1 ? "" : "s"}`}
          />
          <KpiCard
            label="Cancel Fees"
            value={fmt$c(s?.cancel_total ?? 0)}
            color={clr.green}
            sub={`${s?.cancel_count ?? 0} chargeable cancel${(s?.cancel_count ?? 0) === 1 ? "" : "s"}`}
          />
        </div>

        {/* Per-action breakdown table — show count + total $ for every
            action that appeared in the window. Helps spot patterns
            (e.g. "we're bumping a lot, why?"). */}
        {data?.by_action && data.by_action.length > 0 && (
          <div style={{ background: "#FFFFFF", border: `1px solid ${clr.border}`, borderRadius: 10, padding: "14px 18px", marginBottom: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: clr.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
              By Action
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr", rowGap: 8, columnGap: 16, alignItems: "center" }}>
              <div style={{ fontSize: 11, color: clr.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>Action</div>
              <div style={{ fontSize: 11, color: clr.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", textAlign: "right" }}>Count</div>
              <div style={{ fontSize: 11, color: clr.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", textAlign: "right" }}>Total Charged</div>
              {data.by_action.map(r => {
                const meta = ACTION_META[r.action] ?? { label: r.action, color: clr.muted };
                return (
                  <>
                    <div key={`${r.action}-l`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 4, background: meta.color, display: "inline-block" }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: clr.text }}>{meta.label}</span>
                    </div>
                    <div key={`${r.action}-c`} style={{ fontSize: 13, textAlign: "right", color: clr.text }}>{r.count}</div>
                    <div key={`${r.action}-t`} style={{ fontSize: 13, textAlign: "right", color: r.total_charged > 0 ? clr.green : clr.muted, fontWeight: r.total_charged > 0 ? 700 : 400 }}>{fmt$c(r.total_charged)}</div>
                  </>
                );
              })}
            </div>
          </div>
        )}

        <DataTable cols={cols} rows={rows} loading={loading} emptyMsg="No cancellations in this date range." />
      </div>
    </DashboardLayout>
  );
}
