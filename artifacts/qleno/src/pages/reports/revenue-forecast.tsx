import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { AlertTriangle } from "lucide-react";
import { fmt$, fmt$c, clr, ReportHeader, KpiCard, DataTable, ReportError, useReportData } from "./_shared";

// [revenue-forecast 2026-08-18] Reads GET /api/reports/revenue-forecast.
//
// Every dollar on this page is a visit already written on the calendar — the
// recurring engine generates a rolling year ahead, so the book of scheduled
// work really does run twelve months out and nothing here is predicted. That
// distinction is the whole point of the page: it says "this is what is booked",
// never "this is what you will make". Where the calendar runs out, the month is
// dimmed and labelled rather than quietly counted as if it were complete.

interface MonthRow {
  month: string;
  state: "in_progress" | "scheduled" | "partial";
  jobs: number;
  remaining_jobs: number;
  unpriced_jobs: number;
  booked: number;
  remaining: number;
  recurring: number;
  one_time: number;
}
interface Forecast {
  today: string;
  current_month: string;
  generated_through: string | null;
  months_requested: number;
  next_30_days: { jobs: number; revenue: number };
  scheduled_ahead: { revenue: number; jobs: number; through: string | null };
  unpriced_jobs: number;
  months_data: MonthRow[];
}

const monthLabel = (m: string) => {
  const [y, mo] = m.split("-");
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
};
const monthShort = (m: string) => {
  const [y, mo] = m.split("-");
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString("en-US", { month: "short" });
};

const STATE_LABEL: Record<MonthRow["state"], string> = {
  in_progress: "In progress",
  scheduled: "Booked",
  partial: "Not fully scheduled",
};

function StateChip({ state }: { state: MonthRow["state"] }) {
  const cfg = {
    in_progress: { bg: "#EAF3FB", fg: "#1F5C8B" },
    scheduled:   { bg: "#E7F7F2", fg: "#0A8F76" },
    partial:     { bg: "#F1EFEA", fg: "#6B6860" },
  }[state];
  return (
    <span style={{ display: "inline-block", padding: "2px 9px", borderRadius: 20, fontSize: 11, fontWeight: 600, backgroundColor: cfg.bg, color: cfg.fg, whiteSpace: "nowrap" }}>
      {STATE_LABEL[state]}
    </span>
  );
}

// Bars are drawn against the tallest COMPLETE month, so a half-written tail
// month can't quietly rescale the chart and make the booked months look small.
function MonthChart({ rows }: { rows: MonthRow[] }) {
  const complete = rows.filter(r => r.state !== "partial");
  const max = Math.max(1, ...(complete.length ? complete : rows).map(r => r.booked));
  return (
    <div style={{ backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 10, padding: "18px 20px 12px", marginBottom: 22, overflowX: "auto" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, minWidth: rows.length * 54, height: 170 }}>
        {rows.map(r => {
          const pct = Math.min(100, (r.booked / max) * 100);
          const dim = r.state === "partial";
          return (
            <div key={r.month} style={{ flex: 1, minWidth: 44, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: dim ? clr.muted : clr.secondary, whiteSpace: "nowrap" }}>
                {fmt$(r.booked)}
              </span>
              <div style={{ width: "100%", height: 110, display: "flex", alignItems: "flex-end" }}>
                <div
                  title={`${monthLabel(r.month)} — ${fmt$c(r.booked)} across ${r.jobs} visit${r.jobs === 1 ? "" : "s"}`}
                  style={{
                    width: "100%",
                    height: `${Math.max(2, pct)}%`,
                    borderRadius: "5px 5px 0 0",
                    backgroundColor: dim ? "#E5E2DC" : clr.brand,
                    opacity: r.state === "in_progress" ? 0.65 : 1,
                    border: dim ? `1px dashed ${clr.muted}` : "none",
                    transition: "height .35s ease",
                  }}
                />
              </div>
              <span style={{ fontSize: 11, fontWeight: 600, color: dim ? clr.muted : clr.text }}>{monthShort(r.month)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function RevenueForecastPage() {
  const [months, setMonths] = useState(12);
  const { data, loading, error, reload } = useReportData<Forecast>(`/revenue-forecast?months=${months}`);

  const rows = data?.months_data ?? [];
  const partial = rows.filter(r => r.state === "partial");
  const ahead = data?.scheduled_ahead;

  const recurringAhead = rows.filter(r => r.state !== "partial").reduce((s, r) => s + r.recurring, 0);
  const bookedAhead = rows.filter(r => r.state !== "partial").reduce((s, r) => s + r.booked, 0);
  const recurringPct = bookedAhead > 0 ? (recurringAhead / bookedAhead) * 100 : null;

  return (
    <DashboardLayout>
      <ReportHeader
        title="Revenue Forecast"
        subtitle="Work already on the calendar, month by month. Nothing here is estimated — every figure is scheduled visits at their current price."
        printable
        filters={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: clr.secondary, fontWeight: 500 }}>Look ahead:</span>
            {[6, 12, 18].map(m => (
              <button
                key={m}
                onClick={() => setMonths(m)}
                style={{
                  padding: "5px 13px", fontSize: 13, fontWeight: 600, borderRadius: 7, cursor: "pointer",
                  fontFamily: "inherit",
                  color: months === m ? "#FFFFFF" : clr.secondary,
                  backgroundColor: months === m ? clr.brand : clr.card,
                  border: `1px solid ${months === m ? "transparent" : clr.border}`,
                }}
              >
                {m} months
              </button>
            ))}
          </div>
        }
      />

      <ReportError error={error} onRetry={reload} />

      {!error && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 22 }}>
            <KpiCard
              label="Next 30 days"
              value={data ? fmt$(data.next_30_days.revenue) : "—"}
              sub={data ? `${data.next_30_days.jobs.toLocaleString()} visits booked` : undefined}
            />
            <KpiCard
              label="Still ahead"
              value={ahead ? fmt$(ahead.revenue) : "—"}
              sub={ahead?.through ? `${ahead.jobs.toLocaleString()} visits, through ${monthLabel(ahead.through)}` : undefined}
            />
            <KpiCard
              label="From recurring work"
              value={recurringPct != null ? `${recurringPct.toFixed(0)}%` : "—"}
              sub="of the booked months above"
              color={clr.green}
            />
            <KpiCard
              label="Calendar written through"
              value={data?.generated_through ? new Date(data.generated_through + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
              sub="last recurring visit generated"
              color={clr.secondary}
            />
          </div>

          {/* Two honesty notices. Neither invents a number to fill the gap — the
              spec is explicit that an unreliable figure is shown as unavailable
              rather than estimated, so these say what is missing instead. */}
          {partial.length > 0 && (
            <div style={{ padding: "13px 16px", marginBottom: 18, backgroundColor: "#FBFAF7", border: `1px solid ${clr.border}`, borderRadius: 8, display: "flex", gap: 10, alignItems: "flex-start" }}>
              <AlertTriangle size={15} color={clr.muted} style={{ flexShrink: 0, marginTop: 1 }} />
              <p style={{ margin: 0, fontSize: 12, color: clr.text, lineHeight: 1.55 }}>
                <strong>
                  {partial.length === 1
                    ? `${monthLabel(partial[0].month)} is`
                    : `${monthLabel(partial[0].month)} onward is`}{" "}
                  past the point the calendar has been written to.
                </strong>{" "}
                Recurring visits are generated about a year out, so these months are genuine but incomplete and their figures will rise as the calendar fills.
                They are shown dimmed and are left out of the totals above rather than being padded with a guess.
              </p>
            </div>
          )}

          {data && data.unpriced_jobs > 0 && (
            <div style={{ padding: "13px 16px", marginBottom: 18, backgroundColor: "#FFFDF5", border: `1px solid ${clr.amber}55`, borderRadius: 8, display: "flex", gap: 10, alignItems: "flex-start" }}>
              <AlertTriangle size={15} color={clr.amber} style={{ flexShrink: 0, marginTop: 1 }} />
              <p style={{ margin: 0, fontSize: 12, color: clr.text, lineHeight: 1.55 }}>
                <strong>{data.unpriced_jobs.toLocaleString()} scheduled visit{data.unpriced_jobs === 1 ? " carries" : "s carry"} no price.</strong>{" "}
                Each one counts as $0 here, so the months below are an undercount by whatever those visits are worth. Price them on the job and the totals correct themselves.
              </p>
            </div>
          )}

          {rows.length > 0 && <MonthChart rows={rows} />}

          <DataTable<MonthRow>
            loading={loading}
            rows={rows}
            emptyMsg="Nothing scheduled in this window."
            cols={[
              { header: "Month", render: r => (
                <span style={{ fontWeight: 600, color: r.state === "partial" ? clr.muted : clr.text }}>{monthLabel(r.month)}</span>
              ) },
              { header: "Status", render: r => <StateChip state={r.state} /> },
              { header: "Visits", align: "right", render: r => (
                <span style={{ color: r.state === "partial" ? clr.muted : clr.text }}>{r.jobs.toLocaleString()}</span>
              ) },
              { header: "Booked", align: "right", render: r => (
                <span style={{ fontWeight: 600, color: r.state === "partial" ? clr.muted : clr.text }}>{fmt$c(r.booked)}</span>
              ) },
              // The current month is part history, so its "still ahead" figure is
              // the only one that differs from the month total — and it is the one
              // the office actually plans against.
              { header: "Still ahead", align: "right", render: r => (
                <span style={{ color: r.remaining === r.booked ? clr.muted : clr.text }}>
                  {fmt$c(r.remaining)}
                  {r.remaining !== r.booked && (
                    <span style={{ color: clr.secondary, fontWeight: 400 }}> · {r.remaining_jobs} visits</span>
                  )}
                </span>
              ) },
              { header: "Recurring", align: "right", render: r => (
                <span style={{ color: clr.secondary }}>{fmt$c(r.recurring)}</span>
              ) },
              { header: "One-time", align: "right", render: r => (
                <span style={{ color: clr.secondary }}>{r.one_time > 0 ? fmt$c(r.one_time) : "—"}</span>
              ) },
              { header: "Unpriced", align: "right", render: r => (
                r.unpriced_jobs > 0
                  ? <span style={{ color: clr.amber, fontWeight: 600 }}>{r.unpriced_jobs}</span>
                  : <span style={{ color: clr.muted }}>—</span>
              ) },
            ]}
          />

          <p style={{ margin: "14px 2px 0", fontSize: 11.5, color: clr.secondary, lineHeight: 1.6, maxWidth: 780 }}>
            Cancelled visits are excluded. Commercial work priced by the hour is valued at its hourly rate times its budgeted
            hours; everything else at its billed amount, or its base price where no invoice has been raised yet. This is booked
            work at today's prices — it is not a prediction, and it does not account for cancellations, rescheduling, or new
            business still to come.
          </p>
        </>
      )}
    </DashboardLayout>
  );
}
