import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { fmt$, fmt$c, fmtDate, fmtPct, fmtSvc, clr, KpiCard, DateRange, ReportHeader, DataTable, useReportData, ReportError } from "./_shared";

function today() { return new Date().toISOString().split("T")[0]; }
function monthStart() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; }

interface CustRow {
  key: string; kind: "client" | "account"; id: number | null; name: string; client_type: string;
  jobs: number; revenue: number; labor: number; profit: number; margin_pct: number;
  rev_per_visit: number; first_visit: string | null; last_visit: string | null;
  frequency: string | null; zone: string | null;
}
interface CutRow { label: string; jobs: number; revenue: number; labor: number; profit: number; margin_pct: number; }
interface ProfitData {
  from: string; to: string;
  summary: { customers: number; jobs: number; total_revenue: number; total_labor: number; total_profit: number; margin_pct: number; rev_per_visit: number };
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
    { header: "Labor", render: (r: CustRow) => fmt$c(r.labor), align: "right" as const },
    { header: "Gross Profit", render: (r: CustRow) => <span style={{ fontWeight: 600, color: r.profit >= 0 ? clr.green : clr.red }}>{fmt$c(r.profit)}</span>, align: "right" as const },
    { header: "Margin", render: (r: CustRow) => <span style={{ fontWeight: 600, color: marginColor(r.margin_pct) }}>{fmtPct(r.margin_pct)}</span>, align: "right" as const },
    { header: "Per Visit", render: (r: CustRow) => fmt$c(r.rev_per_visit), align: "right" as const },
    { header: "Last Visit", render: (r: CustRow) => fmtDate(r.last_visit), align: "right" as const },
  ];

  const cutCols = [
    { header: CUTS.find(c => c.key === cut)!.label, render: (r: CutRow) => <span style={{ color: r.label === "No zone" ? clr.muted : clr.text }}>{fmtSvc(r.label)}</span> },
    { header: "Visits", render: (r: CutRow) => r.jobs.toLocaleString(), align: "right" as const },
    { header: "Revenue", render: (r: CutRow) => fmt$c(r.revenue), align: "right" as const },
    { header: "Labor", render: (r: CutRow) => fmt$c(r.labor), align: "right" as const },
    { header: "Gross Profit", render: (r: CutRow) => <span style={{ fontWeight: 600, color: r.profit >= 0 ? clr.green : clr.red }}>{fmt$c(r.profit)}</span>, align: "right" as const },
    { header: "Margin", render: (r: CutRow) => <span style={{ fontWeight: 600, color: marginColor(r.margin_pct) }}>{fmtPct(r.margin_pct)}</span>, align: "right" as const },
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
          <KpiCard label="Labor" value={fmt$(s?.total_labor ?? 0)} color={clr.secondary} />
          <KpiCard label="Gross Profit" value={fmt$(s?.total_profit ?? 0)} color={clr.green} />
          <KpiCard label="Gross Margin" value={fmtPct(s?.margin_pct ?? 0)} sub="revenue less labor only" color={marginColor(s?.margin_pct ?? 0)} />
          <KpiCard label="Revenue Per Visit" value={fmt$c(s?.rev_per_visit ?? 0)} />
        </div>

        {/* Gross, and said so on the screen. Qleno carries what a job billed and
            what it paid in labor; it has no supplies, vehicle or overhead cost
            per job, so a "net margin" here would be an invented number. */}
        <p style={{ margin: "-12px 0 22px", fontSize: 12, color: clr.secondary }}>
          Gross margin is revenue less labor. Supplies, vehicle and overhead costs are not tracked per job, so they are not in this figure.
        </p>

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
