import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$, clr, ReportHeader, useReportData, DeltaBadge } from "./_shared";

function thisMonday() {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() + 1);
  d.setHours(0,0,0,0);
  return d.toISOString().split("T")[0];
}

interface WeekMetrics { revenue: number; jobs: number; avg_bill: number; quality_score: number; new_clients: number; staff_count: number; }
interface WRData {
  this_week: string; prev_week: string;
  this: WeekMetrics; prev: WeekMetrics;
  deltas: { revenue: number; jobs: number; quality: number; avg_bill: number };
  trend: { week: string; revenue: number; quality: number }[];
}

function MetricRow({ label, thisVal, prevVal, delta, format }: { label: string; thisVal: number; prevVal: number; delta: number; format?: (n: number) => string }) {
  const f = format || ((n: number) => String(n));
  return (
    <div style={{ display: "flex", alignItems: "center", padding: "12px 0", borderBottom: `1px solid ${clr.border}` }}>
      <div style={{ width: "30%", fontSize: 13, fontWeight: 500, color: clr.text }}>{label}</div>
      <div style={{ width: "25%", fontSize: 18, fontWeight: 700, color: clr.text }}>{f(thisVal)}</div>
      <div style={{ width: "25%", fontSize: 14, color: clr.secondary }}>{f(prevVal)}</div>
      <div style={{ width: "20%" }}><DeltaBadge pct={delta} /></div>
    </div>
  );
}

export default function WeekReviewPage() {
  const [weekStart, setWeekStart] = useState(thisMonday());
  const { data, loading } = useReportData<WRData>(`/reports/week-review?week_start=${weekStart}`);

  const maxRev = Math.max(...(data?.trend?.map(t => t.revenue) ?? [1]), 1);

  return (
    <DashboardLayout title="Week in Review">
      <div style={{ padding: "24px 28px", maxWidth: 900 }}>
        <ReportHeader
          title="Week in Review"
          subtitle="This week vs last week across all key business metrics."
          printable
          filters={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, color: clr.secondary, fontWeight: 500 }}>Week of:</span>
              <input type="date" value={weekStart} onChange={e => setWeekStart(e.target.value)}
                style={{ fontSize: 13, padding: "5px 10px", border: `1px solid ${clr.border}`, borderRadius: 6, color: clr.text, backgroundColor: clr.card, fontFamily: "inherit" }} />
            </div>
          }
        />

        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: clr.muted }}>Loading...</div>
        ) : data ? (
          <>
            {/* Comparison table */}
            <div style={{ backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 10, padding: "16px 20px", marginBottom: 24 }}>
              <div style={{ display: "flex", alignItems: "center", padding: "0 0 10px", borderBottom: `1px solid ${clr.border}`, marginBottom: 4 }}>
                <div style={{ width: "30%" }} />
                <div style={{ width: "25%", fontSize: 11, fontWeight: 700, color: clr.brand, textTransform: "uppercase", letterSpacing: "0.07em" }}>This Week</div>
                <div style={{ width: "25%", fontSize: 11, fontWeight: 600, color: clr.muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>Last Week</div>
                <div style={{ width: "20%", fontSize: 11, fontWeight: 600, color: clr.muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>Change</div>
              </div>
              <MetricRow label="Revenue" thisVal={data.this.revenue} prevVal={data.prev.revenue} delta={data.deltas.revenue} format={fmt$} />
              <MetricRow label="Jobs Completed" thisVal={data.this.jobs} prevVal={data.prev.jobs} delta={data.deltas.jobs} />
              <MetricRow label="Avg Bill Rate" thisVal={data.this.avg_bill} prevVal={data.prev.avg_bill} delta={data.deltas.avg_bill} format={fmt$} />
              <MetricRow label="Quality Score" thisVal={data.this.quality_score} prevVal={data.prev.quality_score} delta={data.deltas.quality} format={n => n.toFixed(2)+"/4"} />
              <div style={{ display: "flex", alignItems: "center", padding: "12px 0" }}>
                <div style={{ width: "30%", fontSize: 13, fontWeight: 500, color: clr.text }}>New Clients</div>
                <div style={{ width: "25%", fontSize: 18, fontWeight: 700, color: clr.green }}>{data.this.new_clients}</div>
                <div style={{ width: "25%", fontSize: 14, color: clr.secondary }}>{data.prev.new_clients}</div>
                <div style={{ width: "20%" }} />
              </div>
            </div>

            {/* 8-week revenue trend */}
            <div style={{ backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 10, padding: "16px 20px" }}>
              <p style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 600, color: clr.text }}>8-Week Revenue Trend</p>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 100 }}>
                {data.trend.map((t, i) => {
                  const h = Math.max(4, (t.revenue / maxRev) * 88);
                  const isThis = i === data.trend.length - 1;
                  return (
                    <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }} title={`${t.week}: ${fmt$(t.revenue)}`}>
                      <div style={{ width: "100%", height: h, backgroundColor: isThis ? clr.brand : "#CBD5E1", borderRadius: "3px 3px 0 0" }} />
                      <span style={{ fontSize: 9, color: clr.muted, marginTop: 3 }}>{new Date(t.week).toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </DashboardLayout>
  );
}
