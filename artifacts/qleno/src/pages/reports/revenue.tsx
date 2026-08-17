import { useState, useMemo, useEffect, useRef } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$, fmtDate, fmtH, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData, ReportError, fmtSvc, RangeClampNotice, HistoricalRevenueNote, type RangeClamp, type HistoricalRevenue } from "./_shared";

function today() { return new Date().toISOString().split("T")[0]; }
function monthStart() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; }
function useIsMobile() {
  const [m, setM] = useState(typeof window !== "undefined" && window.innerWidth < 640);
  useEffect(() => { const h = () => setM(window.innerWidth < 640); window.addEventListener("resize", h); return () => window.removeEventListener("resize", h); }, []);
  return m;
}

interface RevData {
  range_clamped?: RangeClamp | null;
  // [mc-revenue-history 2026-08-17] The MaidCentral months behind the total,
  // for anyone who wants to see which months came from where. Present only when
  // the requested window reaches back before the cutover. total_revenue already
  // includes them — this is the detail, not a separate figure to add on.
  historical?: HistoricalRevenue | null;
  counts_from?: string;
  from: string; to: string; group_by: string;
  summary: {
    total_revenue: number; qleno_revenue?: number; historical_revenue?: number;
    avg_job_value: number; job_count: number; projected_month_end: number;
    // [cancellation-reporting 2026-06-01] Breakdown that splits real
    // visit revenue from cancellation-fee revenue. Both flow into the
    // top-line total, but operators want to see them separately.
    cancellation_fee_revenue?: number;
    visit_revenue?: number;
    lockout_fee_revenue?: number;
    cancel_fee_revenue?: number;
    move_count?: number;
    bump_count?: number;
    skip_count?: number;
    cancel_count?: number;
    lockout_count?: number;
    cancel_service_count?: number;
  };
  // One merged series. The MaidCentral rows carry null job counts, averages and
  // hours because those figures don't exist for that period.
  trend: {
    period: string; revenue: number; source?: string;
    job_count: number | null; avg_per_job: number | null; allowed_hours: number | null;
  }[];
}

export default function RevenueReportPage() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo]   = useState(today());
  const [groupBy, setGroupBy] = useState("day");
  const isMobile = useIsMobile();

  const qs = `?from=${from}&to=${to}&group_by=${groupBy}`;
  const { data, loading, error, reload } = useReportData<RevData>(`/reports/revenue${qs}`);

  const s = data?.summary;
  const trend = data?.trend ?? [];

  // [mc-revenue-history 2026-08-17] The pre-cutover figures only exist by month.
  // If the window reaches back that far while the page is grouped by day or
  // week, the chart would put a whole month's bar beside a single day's. Switch
  // to monthly once, when the history first appears, so everything on screen is
  // the same size of thing. A later manual choice is left alone.
  const autoGrouped = useRef(false);
  useEffect(() => {
    if (data?.historical && !autoGrouped.current && groupBy !== "month") {
      autoGrouped.current = true;
      setGroupBy("month");
    }
  }, [data?.historical, groupBy]);

  const maxRev = useMemo(() => Math.max(...trend.map(r => r.revenue), 1), [trend]);

  // [mc-revenue-history 2026-08-17] A dash, not a zero. Those months genuinely
  // have no job count or average behind them — writing 0 would read as a month
  // in which nobody worked.
  const dash = <span style={{ color: clr.muted }}>—</span>;

  const cols = [
    { header: "Period", render: (r: typeof trend[0]) => (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
        {fmtDate(r.period)}
        {r.source && r.source !== "qleno" && (
          <span style={{ fontSize: 10, fontWeight: 600, color: clr.secondary, backgroundColor: clr.base, border: `1px solid ${clr.border}`, borderRadius: 5, padding: "2px 6px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Month total
          </span>
        )}
      </span>
    ) },
    { header: "Jobs", render: (r: typeof trend[0]) => r.job_count ?? dash, align: "right" as const },
    { header: "Revenue", render: (r: typeof trend[0]) => fmt$(r.revenue), align: "right" as const },
    { header: "Avg/Job", render: (r: typeof trend[0]) => r.avg_per_job == null ? dash : fmt$(r.avg_per_job), align: "right" as const },
    { header: "Allowed Hrs", render: (r: typeof trend[0]) => r.allowed_hours == null ? dash : fmtH(r.allowed_hours), align: "right" as const },
  ];

  return (
    <DashboardLayout title="Revenue Summary">
      <div style={{ padding: isMobile ? "16px" : "24px 28px", maxWidth: 1100, overflowX: "hidden" }}>
        <ReportHeader
          title="Revenue Summary"
          subtitle="Track revenue trends and projected income."
          printable
          filters={
            <>
              <DateRange from={from} to={to} onChange={(f,t) => { setFrom(f); setTo(t); }} />
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, color: clr.secondary, fontWeight: 500 }}>Group by:</span>
                <div style={{ display: "flex", gap: 6 }}>
                  {["day","week","month"].map(g => (
                    <button key={g} type="button" onClick={() => setGroupBy(g)} style={{ padding: "8px 14px", fontSize: 13, fontWeight: 600, border: `1px solid ${clr.border}`, borderRadius: 8, cursor: "pointer", fontFamily: "inherit", backgroundColor: groupBy === g ? clr.brand : clr.card, color: groupBy === g ? "#fff" : clr.secondary, touchAction: "manipulation", WebkitTapHighlightColor: "transparent" }}>
                      {g.charAt(0).toUpperCase() + g.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </>
          }
        />

        {error ? <ReportError error={error} onRetry={reload} /> : <>

        {/* [mc-revenue-history 2026-08-17] The total above already includes the
            pre-cutover months; this is one line saying where they came from,
            not a second set of figures to reconcile. Falls back to the plain
            notice when there is no history on record for the period asked for. */}
        {data?.historical
          ? <HistoricalRevenueNote historical={data.historical} countsFrom={data.counts_from} />
          : <RangeClampNotice clamp={data?.range_clamped} />}

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 14 }}>
          <KpiCard label="Total Revenue" value={fmt$(s?.total_revenue ?? 0)}
            sub={data?.historical ? `Full period · ${fmtDate(data.from)} – ${fmtDate(data.to)}` : "Visits + cancellation fees"} />
          <KpiCard label="Avg Job Value" value={fmt$(s?.avg_job_value ?? 0)} color={clr.green}
            sub={data?.historical ? `Per job · ${fmtDate(data.counts_from!)} onward` : undefined} />
          <KpiCard label="Jobs Completed" value={String(s?.job_count ?? 0)} color={clr.secondary}
            sub={data?.historical ? `${fmtDate(data.counts_from!)} onward` : undefined} />
          <KpiCard label="Month Projected" value={fmt$(s?.projected_month_end ?? 0)} color={clr.amber} sub="All scheduled + completed this month" />
        </div>

        {/* [cancellation-reporting 2026-06-01] Cancellation revenue breakdown.
            Visit revenue = total minus cancellation fees, so the operator
            can answer "how much did we earn from actual cleanings this
            window?" without doing mental math. The two fee cards split
            lockouts from cancels for fine-grained tracking. */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 14 }}>
          <KpiCard
            label="Visit Revenue"
            value={fmt$(s?.visit_revenue ?? s?.total_revenue ?? 0)}
            color={clr.green}
            sub="Cleanings actually delivered"
          />
          <KpiCard
            label="Cancellation Fees"
            value={fmt$(s?.cancellation_fee_revenue ?? 0)}
            color={clr.red}
            sub={`Cancel: ${fmt$(s?.cancel_fee_revenue ?? 0)} · Lockout: ${fmt$(s?.lockout_fee_revenue ?? 0)}`}
          />
          <KpiCard
            label="Reschedules"
            value={String((s?.move_count ?? 0) + (s?.bump_count ?? 0))}
            color={clr.secondary}
            sub={`Move: ${s?.move_count ?? 0} · Bump: ${s?.bump_count ?? 0}`}
          />
          <KpiCard
            label="Service Cancellations"
            value={String(s?.cancel_service_count ?? 0)}
            color={clr.red}
            sub={`${s?.skip_count ?? 0} skip${(s?.skip_count ?? 0) === 1 ? "" : "s"} in window`}
          />
        </div>

        <div style={{ height: 10 }} />

        {/* Bar chart */}
        {trend.length > 0 && (
          <div style={{ backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 10, padding: 20, marginBottom: 24 }}>
            <p style={{ margin: "0 0 16px", fontSize: 13, fontWeight: 600, color: clr.text }}>Revenue by {groupBy.charAt(0).toUpperCase()+groupBy.slice(1)}</p>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 120, overflowX: "auto" }}>
              {trend.map((r, i) => {
                const h = Math.max(4, (r.revenue / maxRev) * 108);
                // [mc-revenue-history 2026-08-17] Pre-cutover months are the
                // same series and the same scale — drawn in a lighter tone so
                // it's visible at a glance which part predates Qleno.
                const pre = r.source && r.source !== "qleno";
                return (
                  <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "0 0 auto", minWidth: 32, cursor: "default" }} title={`${fmtDate(r.period)}: ${fmt$(r.revenue)}${pre ? " (MaidCentral)" : ""}`}>
                    <div style={{ width: 28, height: h, backgroundColor: pre ? "#B9E7DC" : clr.brand, borderRadius: "3px 3px 0 0", transition: "height 0.3s" }} />
                    <span style={{ fontSize: 9, color: clr.muted, marginTop: 3, transform: "rotate(-40deg)", transformOrigin: "top left", whiteSpace: "nowrap" }}>{r.period.slice(5)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <DataTable cols={cols} rows={trend} loading={loading} emptyMsg="No completed jobs in this date range." />
        </>}
      </div>
    </DashboardLayout>
  );
}
