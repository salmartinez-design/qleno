import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$, fmt$c, fmtDate, fmtPct, fmtSvc, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData, ReportError } from "./_shared";

function today() { return new Date().toISOString().split("T")[0]; }
function monthStart() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; }

interface CustRow {
  key: string; kind: "client" | "account"; id: number | null; name: string; client_type: string;
  jobs: number; revenue: number;
  // null = the pay engine could not cost this customer's visits. Not zero.
  labor: number | null; profit: number | null; margin_pct: number | null;
  jobs_costed: number; revenue_costed: number;
  rev_per_visit: number; first_visit: string | null; last_visit: string | null;
  frequency: string | null; zone: string | null;
}
interface CutRow {
  label: string; jobs: number; revenue: number;
  labor: number | null; profit: number | null; margin_pct: number | null; jobs_costed: number;
}
interface ProfitData {
  from: string; to: string;
  summary: {
    customers: number; jobs: number; total_revenue: number;
    total_labor: number | null; total_profit: number | null; margin_pct: number | null;
    rev_per_visit: number; jobs_costed: number; revenue_costed: number; coverage_pct: number;
  };
  data: CustRow[];
  page: number; page_size: number; total_rows: number; total_pages: number;
  by_service: CutRow[]; by_zone: CutRow[]; by_frequency: CutRow[];
}

const SORTS = [
  { key: "revenue", label: "Revenue" },
  { key: "profit", label: "Gross profit" },
  { key: "margin", label: "Margin" },
  { key: "rev_per_visit", label: "Revenue per visit" },
  { key: "jobs", label: "Visits" },
  { key: "last_visit", label: "Last visit" },
  { key: "name", label: "Name" },
];

const CUTS = [
  { key: "by_service" as const, label: "Service type" },
  { key: "by_zone" as const, label: "Zone" },
  { key: "by_frequency" as const, label: "Frequency" },
];

const marginColor = (p: number) => (p >= 50 ? clr.green : p >= 30 ? clr.amber : clr.red);

// An uncosted row reads as a dash, never as a zero or a 100% margin.
const unknown = <span style={{ color: clr.muted }}>—</span>;
const money = (v: number | null) => (v == null ? unknown : fmt$c(v));

export default function ClientProfitabilityPage() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [type, setType] = useState("all");
  const [sort, setSort] = useState("revenue");
  const [dir, setDir] = useState("desc");
  const [page, setPage] = useState(1);
  const [cut, setCut] = useState<typeof CUTS[number]["key"]>("by_service");

  const { data, loading, error, reload } = useReportData<ProfitData>(
    `/reports/client-profitability?from=${from}&to=${to}&type=${type}&sort=${sort}&dir=${dir}&page=${page}&page_size=50`
  );
  const rows = data?.data ?? [];
  const s = data?.summary;
  const costed = s?.jobs_costed ?? 0;
  const cutRows = data?.[cut] ?? [];

  // Any filter change puts you back on page 1 — otherwise a narrower range
  // leaves you on a page that no longer exists and the table reads empty.
  const reset = (fn: () => void) => { fn(); setPage(1); };

  const selectStyle = { padding: "6px 10px", borderRadius: 8, fontSize: 12, border: `1px solid ${clr.border}`, background: "#FFFFFF", color: clr.text, fontFamily: "inherit" as const };

  const cols = [
    { header: "Customer", render: (r: CustRow) => (
      <span>
        {r.name}
        {r.kind === "account" && <span style={{ marginLeft: 7, fontSize: 10, fontWeight: 600, color: clr.secondary, textTransform: "uppercase", letterSpacing: "0.05em" }}>Account</span>}
      </span>
    ) },
    { header: "Zone", render: (r: CustRow) => <span style={{ color: r.zone === "No zone" ? clr.muted : clr.text }}>{r.zone ?? "—"}</span> },
    { header: "Frequency", render: (r: CustRow) => fmtSvc(r.frequency ?? "") || "—" },
    { header: "Visits", render: (r: CustRow) => r.jobs.toLocaleString(), align: "right" as const },
    { header: "Revenue", render: (r: CustRow) => fmt$c(r.revenue), align: "right" as const },
    { header: "Labor", render: (r: CustRow) => money(r.labor), align: "right" as const },
    { header: "Gross Profit", render: (r: CustRow) => r.profit == null ? unknown
      : <span style={{ fontWeight: 600, color: r.profit >= 0 ? clr.green : clr.red }}>{fmt$c(r.profit)}</span>, align: "right" as const },
    { header: "Margin", render: (r: CustRow) => r.margin_pct == null ? unknown
      : <span style={{ fontWeight: 600, color: marginColor(r.margin_pct) }}>
          {fmtPct(r.margin_pct)}
          {/* A margin drawn from only part of a customer's visits says so. */}
          {r.jobs_costed < r.jobs && (
            <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 500, color: clr.muted }}>
              {r.jobs_costed}/{r.jobs}
            </span>
          )}
        </span>, align: "right" as const },
    { header: "Per Visit", render: (r: CustRow) => fmt$c(r.rev_per_visit), align: "right" as const },
    { header: "Last Visit", render: (r: CustRow) => fmtDate(r.last_visit), align: "right" as const },
  ];

  const cutCols = [
    { header: CUTS.find(c => c.key === cut)!.label, render: (r: CutRow) => <span style={{ color: r.label === "No zone" ? clr.muted : clr.text }}>{fmtSvc(r.label)}</span> },
    { header: "Visits", render: (r: CutRow) => r.jobs.toLocaleString(), align: "right" as const },
    { header: "Revenue", render: (r: CutRow) => fmt$c(r.revenue), align: "right" as const },
    { header: "Labor", render: (r: CutRow) => money(r.labor), align: "right" as const },
    { header: "Gross Profit", render: (r: CutRow) => r.profit == null ? unknown
      : <span style={{ fontWeight: 600, color: r.profit >= 0 ? clr.green : clr.red }}>{fmt$c(r.profit)}</span>, align: "right" as const },
    { header: "Margin", render: (r: CutRow) => r.margin_pct == null ? unknown
      : <span style={{ fontWeight: 600, color: marginColor(r.margin_pct) }}>
          {fmtPct(r.margin_pct)}
          {r.jobs_costed < r.jobs && (
            <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 500, color: clr.muted }}>
              {r.jobs_costed}/{r.jobs}
            </span>
          )}
        </span>, align: "right" as const },
  ];

  const filters = (
    <>
      <DateRange from={from} to={to} onChange={(f, t) => reset(() => { setFrom(f); setTo(t); })} />
      <span style={{ width: 1, height: 20, background: clr.border, margin: "0 4px" }} />
      <select value={type} onChange={e => reset(() => setType(e.target.value))} style={selectStyle} aria-label="Customer type">
        <option value="all">All customers</option>
        <option value="residential">Residential</option>
        <option value="commercial">Commercial</option>
      </select>
      <select value={sort} onChange={e => reset(() => setSort(e.target.value))} style={selectStyle} aria-label="Sort by">
        {SORTS.map(o => <option key={o.key} value={o.key}>Sort by {o.label.toLowerCase()}</option>)}
      </select>
      <select value={dir} onChange={e => reset(() => setDir(e.target.value))} style={selectStyle} aria-label="Sort direction">
        <option value="desc">Highest first</option>
        <option value="asc">Lowest first</option>
      </select>
    </>
  );

  const pager = data && data.total_pages > 1 && (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, color: clr.secondary }}>
        Showing {((data.page - 1) * data.page_size + 1).toLocaleString()}–{Math.min(data.page * data.page_size, data.total_rows).toLocaleString()} of {data.total_rows.toLocaleString()} customers
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={data.page <= 1}
          style={{ padding: "6px 12px", fontSize: 12, fontWeight: 500, color: data.page <= 1 ? clr.muted : clr.text, backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 6, cursor: data.page <= 1 ? "default" : "pointer", fontFamily: "inherit" }}>
          Previous
        </button>
        <span style={{ fontSize: 12, color: clr.secondary }}>Page {data.page} of {data.total_pages}</span>
        <button onClick={() => setPage(p => Math.min(data.total_pages, p + 1))} disabled={data.page >= data.total_pages}
          style={{ padding: "6px 12px", fontSize: 12, fontWeight: 500, color: data.page >= data.total_pages ? clr.muted : clr.text, backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 6, cursor: data.page >= data.total_pages ? "default" : "pointer", fontFamily: "inherit" }}>
          Next
        </button>
      </div>
    </div>
  );

  return (
    <DashboardLayout title="Client Profitability">
      <div style={{ padding: "24px 28px", maxWidth: 1400 }}>
        <ReportHeader
          title="Client Profitability"
          subtitle="Revenue, labor and gross profit per customer — residential clients and commercial accounts together."
          printable
          filters={filters}
        />

        {error ? <ReportError error={error} onRetry={reload} /> : <>

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Customers" value={(s?.customers ?? 0).toLocaleString()} sub={`${(s?.jobs ?? 0).toLocaleString()} completed visits`} />
          <KpiCard label="Revenue" value={fmt$(s?.total_revenue ?? 0)} />
          <KpiCard label="Labor" value={s?.total_labor == null ? "Not available" : fmt$(s.total_labor)}
            sub={costed ? `on ${costed.toLocaleString()} costed visits` : undefined} color={clr.secondary} />
          <KpiCard label="Gross Profit" value={s?.total_profit == null ? "Not available" : fmt$(s.total_profit)} color={clr.green} />
          <KpiCard label="Gross Margin" value={s?.margin_pct == null ? "Not available" : fmtPct(s.margin_pct)}
            sub="revenue less labor only" color={s?.margin_pct == null ? clr.secondary : marginColor(s.margin_pct)} />
          <KpiCard label="Revenue Per Visit" value={fmt$c(s?.rev_per_visit ?? 0)} />
        </div>

        {/* Gross, and said so on the screen. Qleno carries what a job billed and
            what it paid in labor; it has no supplies, vehicle or overhead cost
            per job, so a "net margin" here would be an invented number. */}
        <p style={{ margin: "-12px 0 14px", fontSize: 12, color: clr.secondary }}>
          Gross margin is revenue less labor. Supplies, vehicle and overhead costs are not tracked per job, so they are not in this figure.
        </p>

        {/* [labor-coverage 2026-08-17] Jobs imported from MaidCentral carry
            revenue but no clock data, so the pay engine cannot cost them.
            Counting those as zero labor turns a ~37% margin into a ~90% one.
            When any visit in range is uncosted, the margin above is stated as
            what it actually is — a figure drawn from part of the range. */}
        {s && s.coverage_pct < 99.5 && (
          <div style={{
            display: "flex", gap: 10, alignItems: "flex-start",
            padding: "12px 14px", marginBottom: 22,
            backgroundColor: "#FFFDF5", border: `1px solid ${clr.amber}55`, borderRadius: 8,
          }}>
            <AlertTriangle size={15} color={clr.amber} style={{ flexShrink: 0, marginTop: 1 }} />
            <p style={{ margin: 0, fontSize: 12, color: clr.text, lineHeight: 1.55 }}>
              Labor is known for <strong>{s.jobs_costed.toLocaleString()} of {s.jobs.toLocaleString()} visits</strong> in this range
              ({fmtPct(s.coverage_pct)}), covering {fmt$(s.revenue_costed)} of {fmt$(s.total_revenue)} in revenue.
              Profit and margin describe only those visits. Work imported from MaidCentral carries its revenue but no
              clock records, so it cannot be costed — those customers show a dash rather than a margin.
            </p>
          </div>
        )}

        <DataTable cols={cols} rows={rows} loading={loading} emptyMsg="No completed visits in this date range." />
        {pager}

        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "30px 0 12px", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: clr.text }}>Where the margin comes from</h2>
          <div style={{ display: "flex", gap: 6 }}>
            {CUTS.map(c => (
              <button key={c.key} onClick={() => setCut(c.key)}
                style={{
                  padding: "5px 12px", fontSize: 12, fontWeight: 500, borderRadius: 7, cursor: "pointer", fontFamily: "inherit",
                  color: cut === c.key ? "#FFFFFF" : clr.secondary,
                  backgroundColor: cut === c.key ? clr.brand : clr.card,
                  border: `1px solid ${cut === c.key ? clr.brand : clr.border}`,
                }}>
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <DataTable cols={cutCols} rows={cutRows} loading={loading} emptyMsg="No completed visits in this date range." />
        </>}
      </div>
    </DashboardLayout>
  );
}
