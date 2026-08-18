import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$, fmt$c, fmtH, fmtDate, fmtPct, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData, ReportError, RangeClampNotice, EffBar, type RangeClamp } from "./_shared";

function today() { return new Date().toISOString().split("T")[0]; }
function monthStart() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; }

interface AccountRow {
  id: number; name: string; is_active: boolean;
  account_type: string | null; invoice_frequency: string | null;
  payment_terms_days: number | null; payment_method: string | null;
  visits: number; properties: number; revenue: number; rev_per_visit: number | null;
  // Three separate unknowns, each null rather than zero: no budget on the job,
  // no clock records, no pay lines.
  budget_hours: number | null; actual_hours: number | null;
  efficiency_pct: number | null; rev_per_budget_hour: number | null;
  // The two halves the percentage is actually built from — visits carrying both
  // a budget and a clock record.
  measured_budget_hours: number | null; measured_actual_hours: number | null; jobs_measured: number;
  labor: number | null; profit: number | null; margin_pct: number | null;
  jobs_budgeted: number; jobs_clocked: number; jobs_costed: number; revenue_costed: number;
  first_visit: string | null; last_visit: string | null;
}
interface DormantRow {
  id: number; name: string; last_visit: string | null; invoice_frequency: string | null;
}
interface CommercialData {
  range_clamped?: RangeClamp | null;
  from: string; to: string;
  summary: {
    accounts: number; dormant_accounts: number; visits: number;
    total_revenue: number; rev_per_visit: number | null;
    budget_hours: number | null; actual_hours: number | null; efficiency_pct: number | null;
    measured_budget_hours: number | null; measured_actual_hours: number | null; jobs_measured: number;
    total_labor: number | null; total_profit: number | null; margin_pct: number | null;
    jobs_budgeted: number; jobs_clocked: number; jobs_costed: number; coverage_pct: number;
    top_account: string | null; top_account_share_pct: number | null;
  };
  data: AccountRow[];
  dormant: DormantRow[];
}

// [commercial-price-drift 2026-08-18] GET /api/recurring/pricing-audit — the
// schedules whose stored per-visit price no longer agrees with their own hours
// times their hourly rate. Flat-fee schedules carry no hourly rate and never
// appear here, which is most of them.
interface PricingDrift {
  schedule_id: number; name: string; frequency: string | null;
  future_visits: number; hours: number; rate: number;
  stored_fee: number; expected_fee: number; difference: number;
  future_difference: number; message: string;
}
interface PricingAudit { checked: number; drifting_count: number; schedules: PricingDrift[] }

const SORTS = [
  { key: "revenue", label: "Revenue" },
  { key: "profit", label: "Gross profit" },
  { key: "margin", label: "Margin" },
  { key: "efficiency", label: "Efficiency" },
  { key: "rev_per_budget_hour", label: "Revenue per budgeted hour" },
  { key: "hours", label: "Hours worked" },
  { key: "visits", label: "Visits" },
  { key: "rev_per_visit", label: "Revenue per visit" },
  { key: "last_visit", label: "Last visit" },
  { key: "name", label: "Name" },
];

const marginColor = (p: number) => (p >= 50 ? clr.green : p >= 30 ? clr.amber : clr.red);
// Over 100% means the crew finished inside the budgeted hours.
const effColor = (p: number) => (p >= 100 ? clr.green : p >= 85 ? clr.amber : clr.red);

const unknown = <span style={{ color: clr.muted }}>—</span>;
const money = (v: number | null) => (v == null ? unknown : fmt$c(v));
const hours = (v: number | null) => (v == null ? unknown : fmtH(v));

export default function CommercialAccountsPage() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [sort, setSort] = useState("revenue");
  const [dir, setDir] = useState("desc");

  const { data, loading, error, reload } = useReportData<CommercialData>(
    `/reports/commercial-accounts?from=${from}&to=${to}&sort=${sort}&dir=${dir}`
  );
  // Not date-ranged: a schedule generating a wrong price is wrong today and
  // wrong next month, so the window the report is looking at is irrelevant to it.
  const { data: audit } = useReportData<PricingAudit>("/recurring/pricing-audit");
  const rows = data?.data ?? [];
  const dormant = data?.dormant ?? [];
  const s = data?.summary;

  const selectStyle = { padding: "6px 10px", borderRadius: 8, fontSize: 12, border: `1px solid ${clr.border}`, background: "#FFFFFF", color: clr.text, fontFamily: "inherit" as const };

  const cols = [
    { header: "Account", render: (r: AccountRow) => (
      <span>
        {r.name}
        {!r.is_active && <span style={{ marginLeft: 7, fontSize: 10, fontWeight: 600, color: clr.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Inactive</span>}
      </span>
    ) },
    { header: "Sites", render: (r: AccountRow) => r.properties > 0 ? r.properties.toLocaleString() : unknown, align: "right" as const },
    { header: "Visits", render: (r: AccountRow) => r.visits.toLocaleString(), align: "right" as const },
    { header: "Revenue", render: (r: AccountRow) => fmt$c(r.revenue), align: "right" as const },
    { header: "Budgeted", render: (r: AccountRow) => (
      <span>
        {hours(r.budget_hours)}
        {/* A budget covering only some of the visits says so, rather than
            reading as the account's whole workload. */}
        {r.budget_hours != null && r.jobs_budgeted < r.visits && (
          <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 500, color: clr.muted }}>{r.jobs_budgeted}/{r.visits}</span>
        )}
      </span>
    ), align: "right" as const },
    { header: "Worked", render: (r: AccountRow) => (
      <span>
        {hours(r.actual_hours)}
        {r.actual_hours != null && r.jobs_clocked < r.visits && (
          <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 500, color: clr.muted }}>{r.jobs_clocked}/{r.visits}</span>
        )}
      </span>
    ), align: "right" as const },
    // Only visits with both a budget and a clock can be scored, so the count of
    // those is shown whenever it is short of the account's visits — the number
    // then reads as what it is rather than as the whole account.
    { header: "Efficiency", render: (r: AccountRow) => r.efficiency_pct == null ? unknown : (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
        <span style={{ fontWeight: 600, color: effColor(r.efficiency_pct) }}>{fmtPct(r.efficiency_pct)}</span>
        {r.jobs_measured < r.visits && (
          <span style={{ fontSize: 10, fontWeight: 500, color: clr.muted }}>{r.jobs_measured} scored</span>
        )}
        <EffBar pct={r.efficiency_pct} />
      </div>
    ), align: "right" as const },
    { header: "Per Budgeted Hr", render: (r: AccountRow) => money(r.rev_per_budget_hour), align: "right" as const },
    { header: "Labor", render: (r: AccountRow) => money(r.labor), align: "right" as const },
    { header: "Gross Profit", render: (r: AccountRow) => r.profit == null ? unknown
      : <span style={{ fontWeight: 600, color: r.profit >= 0 ? clr.green : clr.red }}>{fmt$c(r.profit)}</span>, align: "right" as const },
    { header: "Margin", render: (r: AccountRow) => r.margin_pct == null ? unknown
      : <span style={{ fontWeight: 600, color: marginColor(r.margin_pct) }}>
          {fmtPct(r.margin_pct)}
          {r.jobs_costed < r.visits && (
            <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 500, color: clr.muted }}>{r.jobs_costed}/{r.visits}</span>
          )}
        </span>, align: "right" as const },
    { header: "Last Visit", render: (r: AccountRow) => fmtDate(r.last_visit), align: "right" as const },
  ];

  const dormantCols = [
    { header: "Account", render: (r: DormantRow) => r.name },
    { header: "Billing", render: (r: DormantRow) => r.invoice_frequency ? r.invoice_frequency.replace(/_/g, " ") : unknown },
    { header: "Last Visit In Range", render: (r: DormantRow) => fmtDate(r.last_visit), align: "right" as const },
  ];

  const filters = (
    <>
      <DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
      <span style={{ width: 1, height: 20, background: clr.border, margin: "0 4px" }} />
      <select value={sort} onChange={e => setSort(e.target.value)} style={selectStyle} aria-label="Sort by">
        {SORTS.map(o => <option key={o.key} value={o.key}>Sort by {o.label.toLowerCase()}</option>)}
      </select>
      <select value={dir} onChange={e => setDir(e.target.value)} style={selectStyle} aria-label="Sort direction">
        <option value="desc">Highest first</option>
        <option value="asc">Lowest first</option>
      </select>
    </>
  );

  return (
    <DashboardLayout title="Commercial Accounts">
      <div style={{ padding: "24px 28px", maxWidth: 1400 }}>
        <ReportHeader
          title="Commercial Accounts"
          subtitle="Every commercial account side by side — revenue, budgeted hours against hours worked, and gross profit."
          printable
          filters={filters}
        />

        {error ? <ReportError error={error} onRetry={reload} /> : <>

        <RangeClampNotice clamp={data?.range_clamped} />

        {/* [commercial-price-drift 2026-08-18] National Able cut from eight
            hours a day to four and the price on the schedule stayed at the
            eight-hour figure, so Qleno reported $53,100 of revenue that was
            never coming — for four months, silently. This says so out loud.
            It reports; it never repairs. Whether the price or the hours is the
            wrong number depends on what the customer agreed to, and only the
            office knows that. */}
        {audit && audit.drifting_count > 0 && (
          <div style={{
            padding: "14px 16px", marginBottom: 22,
            backgroundColor: "#FFFDF5", border: `1px solid ${clr.amber}55`, borderRadius: 8,
          }}>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
              <AlertTriangle size={15} color={clr.amber} style={{ flexShrink: 0, marginTop: 1 }} />
              <p style={{ margin: 0, fontSize: 12, color: clr.text, lineHeight: 1.55 }}>
                <strong>{audit.drifting_count} {audit.drifting_count === 1 ? "schedule prices" : "schedules price"} a visit
                differently than {audit.drifting_count === 1 ? "its" : "their"} own hours and hourly rate.</strong>{" "}
                Nothing has been changed. Either the price is stale or the hours are — open the schedule and set whichever
                one is wrong. Accounts billed a flat price per visit have no hourly rate and are not checked.
              </p>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 25 }}>
              {audit.schedules.map(d => (
                <div key={d.schedule_id} style={{ fontSize: 12, color: clr.text, lineHeight: 1.5 }}>
                  <strong>{d.name}</strong> — {d.message}
                  {d.future_visits > 0 && (
                    <span style={{ color: clr.secondary }}>
                      {" "}{d.future_visits.toLocaleString()} visit{d.future_visits === 1 ? "" : "s"} still booked,
                      a difference of {fmt$c(Math.abs(d.future_difference))} {d.future_difference < 0 ? "less" : "more"} than
                      currently shows on the calendar.
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Accounts Worked" value={(s?.accounts ?? 0).toLocaleString()} sub={`${(s?.visits ?? 0).toLocaleString()} completed visits`} />
          <KpiCard label="Revenue" value={fmt$(s?.total_revenue ?? 0)}
            sub={s?.top_account && s.top_account_share_pct != null ? `${fmtPct(s.top_account_share_pct)} from ${s.top_account}` : undefined} />
          <KpiCard label="Budgeted Hours" value={s?.budget_hours == null ? "Not available" : fmtH(s.budget_hours)} color={clr.secondary} />
          <KpiCard label="Hours Worked" value={s?.actual_hours == null ? "Not available" : fmtH(s.actual_hours)}
            sub="all cleaners on the job" color={clr.secondary} />
          <KpiCard label="Efficiency" value={s?.efficiency_pct == null ? "Not available" : fmtPct(s.efficiency_pct)}
            sub={s && s.jobs_measured < s.visits ? `over ${s.jobs_measured.toLocaleString()} of ${s.visits.toLocaleString()} visits` : "budgeted ÷ worked"}
            color={s?.efficiency_pct == null ? clr.secondary : effColor(s.efficiency_pct)} />
          <KpiCard label="Gross Profit" value={s?.total_profit == null ? "Not available" : fmt$(s.total_profit)} color={clr.green} />
          <KpiCard label="Gross Margin" value={s?.margin_pct == null ? "Not available" : fmtPct(s.margin_pct)}
            sub="revenue less labor only" color={s?.margin_pct == null ? clr.secondary : marginColor(s.margin_pct)} />
        </div>

        {/* Say what the numbers are and are not, on the screen rather than in a
            doc nobody opens. Efficiency over 100% is the good direction. */}
        <p style={{ margin: "-12px 0 14px", fontSize: 12, color: clr.secondary, lineHeight: 1.55 }}>
          Efficiency compares the hours a visit was budgeted against the hours actually clocked by everyone who worked it —
          above 100% means the crew came in under budget. Only visits that have both a budget and a clock record go into
          it; a visit missing either one would move the number without telling you anything about the work, so it stays in
          the hour totals and out of the score. Gross margin is revenue less labor; supplies, vehicle and
          overhead costs are not tracked per job, so they are not in this figure.
        </p>

        {/* Same honesty gate as Client Profitability: an uncosted visit is not a
            free one, so the margin above names the share of work it covers. */}
        {s && s.visits > 0 && s.coverage_pct < 99.5 && (
          <div style={{
            display: "flex", gap: 10, alignItems: "flex-start",
            padding: "12px 14px", marginBottom: 22,
            backgroundColor: "#FFFDF5", border: `1px solid ${clr.amber}55`, borderRadius: 8,
          }}>
            <AlertTriangle size={15} color={clr.amber} style={{ flexShrink: 0, marginTop: 1 }} />
            <p style={{ margin: 0, fontSize: 12, color: clr.text, lineHeight: 1.55 }}>
              Labor is known for <strong>{s.jobs_costed.toLocaleString()} of {s.visits.toLocaleString()} visits</strong> ({fmtPct(s.coverage_pct)}).
              Profit and margin describe only those visits. Budgeted hours cover {s.jobs_budgeted.toLocaleString()} visits and
              clock records cover {s.jobs_clocked.toLocaleString()}; efficiency is scored on the {s.jobs_measured.toLocaleString()} that
              have both. An account with neither shows a dash rather than a number built on a blank.
            </p>
          </div>
        )}

        <DataTable cols={cols} rows={rows} loading={loading} emptyMsg="No completed commercial visits in this date range." />

        {/* The most useful row on the page is the one that is not here: an
            active account that booked nothing in the window. */}
        {dormant.length > 0 && (
          <div style={{ marginTop: 30 }}>
            <h2 style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 700, color: clr.text }}>No visits in this range</h2>
            <p style={{ margin: "0 0 12px", fontSize: 12, color: clr.secondary }}>
              {dormant.length} active {dormant.length === 1 ? "account" : "accounts"} with no completed work between {fmtDate(data?.from ?? null)} and {fmtDate(data?.to ?? null)}.
            </p>
            <DataTable cols={dormantCols} rows={dormant} emptyMsg="" />
          </div>
        )}

        </>}
      </div>
    </DashboardLayout>
  );
}
