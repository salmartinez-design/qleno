import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { formatAddress } from "@/lib/format-address";
import { useBranch } from "@/contexts/branch-context";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

// ── Design tokens ────────────────────────────────────────────────────────────
const BG    = "#F7F6F3";
const CARD  = "#FFFFFF";
const TXT   = "#1A1917";
const TXT2  = "#6B6860";
const BORDER = "#E5E2DC";
const ACCENT = "#2D9B83";
const HOVER = "#F7F6F3";

// ── Column definitions ───────────────────────────────────────────────────────
interface ColDef {
  key: string; label: string; default: boolean; width?: number;
  align?: "left" | "right";
}
const ALL_COLUMNS: ColDef[] = [
  { key: "select",           label: "",              default: true,  width: 40 },
  { key: "client",           label: "Client",        default: true,  width: 220 },
  { key: "tech",             label: "Tech",          default: true,  width: 160 },
  { key: "date",             label: "Date",          default: true,  width: 100 },
  { key: "time",             label: "Time",          default: true,  width: 80 },
  { key: "service",          label: "Service",       default: true,  width: 130 },
  { key: "status",           label: "Status",        default: true,  width: 110 },
  { key: "amount",           label: "Amount",        default: true,  width: 90, align: "right" },
  { key: "branch",           label: "Branch",        default: true,  width: 110 },
  { key: "zone",             label: "Zone",          default: false, width: 140 },
  { key: "source",           label: "Source",        default: false, width: 120 },
  { key: "payment_status",   label: "Payment",       default: false, width: 90 },
  { key: "frequency",        label: "Frequency",     default: false, width: 100 },
  { key: "flagged",          label: "Flagged",       default: false, width: 70 },
  { key: "created_at",       label: "Created",       default: false, width: 100 },
];

const STATUS_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  scheduled:   { bg: "#EEF2FF", color: "#4338CA", label: "Scheduled" },
  in_progress: { bg: "#FEF3C7", color: "#92400E", label: "In Progress" },
  complete:    { bg: "#DCFCE7", color: "#15803D", label: "Complete" },
  cancelled:   { bg: "#F3F4F6", color: "#6B7280", label: "Cancelled" },
};

const PAYMENT_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  paid:    { bg: "#DCFCE7", color: "#15803D", label: "Paid" },
  unpaid:  { bg: "#FEF3C7", color: "#92400E", label: "Unpaid" },
  failed:  { bg: "#FEE2E2", color: "#991B1B", label: "Failed" },
  pending: { bg: "#EEF2FF", color: "#4338CA", label: "Pending" },
};

const SERVICE_LABELS: Record<string, string> = {
  standard_clean: "Standard", deep_clean: "Deep Clean", move_out: "Move Out",
  move_in: "Move In", recurring: "Recurring", post_construction: "Post Construction",
  office_cleaning: "Office", common_areas: "Common Areas", retail_store: "Retail",
  medical_office: "Medical", ppm_turnover: "PPM Turnover", post_event: "Post Event",
};

const FREQ_LABELS: Record<string, string> = {
  weekly: "Weekly", biweekly: "Biweekly", every_3_weeks: "Every 3 Wks",
  monthly: "Monthly", on_demand: "One Time",
};

// ── Period presets ────────────────────────────────────────────────────────────
function getDateRange(preset: string): { from: string; to: string } {
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  const startOfWeek = (d: Date) => { const r = new Date(d); r.setDate(r.getDate() - r.getDay()); return r; };
  const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

  switch (preset) {
    case "today": return { from: fmt(today), to: fmt(today) };
    case "yesterday": { const y = new Date(today); y.setDate(y.getDate() - 1); return { from: fmt(y), to: fmt(y) }; }
    case "this_week": return { from: fmt(startOfWeek(today)), to: fmt(today) };
    case "last_week": { const s = startOfWeek(today); s.setDate(s.getDate() - 7); const e = new Date(s); e.setDate(e.getDate() + 6); return { from: fmt(s), to: fmt(e) }; }
    case "this_month": return { from: fmt(startOfMonth(today)), to: fmt(today) };
    case "last_month": { const s = new Date(today.getFullYear(), today.getMonth() - 1, 1); const e = new Date(today.getFullYear(), today.getMonth(), 0); return { from: fmt(s), to: fmt(e) }; }
    case "last_30": { const s = new Date(today); s.setDate(s.getDate() - 30); return { from: fmt(s), to: fmt(today) }; }
    case "last_90": { const s = new Date(today); s.setDate(s.getDate() - 90); return { from: fmt(s), to: fmt(today) }; }
    case "ytd": return { from: `${today.getFullYear()}-01-01`, to: fmt(today) };
    default: return { from: "", to: "" };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtDate(d: string) {
  if (!d) return "\u2014";
  const [y, m, dd] = d.split("-");
  return `${m}/${dd}/${y}`;
}
function fmtTime(t: string | null) {
  if (!t) return "";
  const [h, min] = t.split(":");
  const hour = parseInt(h, 10);
  return `${hour % 12 || 12}:${min} ${hour >= 12 ? "PM" : "AM"}`;
}
function fmtMoney(val: number | string | null) {
  if (val == null) return "\u2014";
  const n = typeof val === "string" ? parseFloat(val) : val;
  return isNaN(n) ? "\u2014" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function fmtSource(s: string | null) {
  if (!s) return "\u2014";
  return s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// ═════════════════════════════════════════════════════════════════════════════
export default function JobsListPage() {
  const { activeBranchId } = useBranch();
  const { toast } = useToast();
  const qc = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── State ──────────────────────────────────────────────────────────────────
  const [period, setPeriod] = useState("this_month");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [sort, setSort] = useState({ col: "scheduled_date", dir: "desc" as "asc" | "desc" });
  const [visibleCols, setVisibleCols] = useState<string[]>(
    ALL_COLUMNS.filter(c => c.default).map(c => c.key)
  );
  const [views, setViews] = useState<any[]>([]);
  const [activeView, setActiveView] = useState<string>("all");
  const [viewMenuOpen, setViewMenuOpen] = useState<number | null>(null);

  // ── Build query params ─────────────────────────────────────────────────────
  const dateRange = period === "all" ? { from: "", to: "" } : period === "custom" ? { from: filters.date_from || "", to: filters.date_to || "" } : getDateRange(period);

  const queryParams: Record<string, string> = {
    ...filters,
    ...(dateRange.from && { date_from: dateRange.from }),
    ...(dateRange.to && { date_to: dateRange.to }),
    ...(activeBranchId ? { branch_id: String(activeBranchId) } : {}),
    ...(search && { search }),
    sort: sort.col,
    dir: sort.dir,
  };

  // ── KPI query ──────────────────────────────────────────────────────────────
  const kpiQuery = useQuery({
    queryKey: ["jobs-kpi", queryParams],
    queryFn: async () => {
      const params = new URLSearchParams(queryParams);
      const res = await fetch(`${API}/api/jobs/v2/kpi?${params}`, { headers: getAuthHeaders() });
      if (!res.ok) throw new Error("KPI fetch failed");
      return res.json();
    },
  });

  // ── Infinite scroll list query ─────────────────────────────────────────────
  const listQuery = useInfiniteQuery({
    queryKey: ["jobs-list", queryParams],
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ ...queryParams, limit: "50", ...(pageParam ? { cursor: String(pageParam) } : {}) });
      const res = await fetch(`${API}/api/jobs/v2/list?${params}`, { headers: getAuthHeaders() });
      if (!res.ok) throw new Error("List fetch failed");
      return res.json();
    },
    getNextPageParam: (last: any) => last.has_more ? last.next_cursor : undefined,
    initialPageParam: undefined as number | undefined,
  });

  const allJobs = listQuery.data?.pages.flatMap((p: any) => p.data) ?? [];
  const totalCount = listQuery.data?.pages[0]?.total ?? 0;

  // ── Infinite scroll observer ───────────────────────────────────────────────
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sentinelRef.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && listQuery.hasNextPage && !listQuery.isFetchingNextPage) {
        listQuery.fetchNextPage();
      }
    }, { threshold: 0.1 });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [listQuery.hasNextPage, listQuery.isFetchingNextPage]);

  // ── Saved views ────────────────────────────────────────────────────────────
  const viewsQuery = useQuery({
    queryKey: ["jobs-views"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/jobs/v2/views`, { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return res.json();
    },
  });

  useEffect(() => { if (viewsQuery.data) setViews(viewsQuery.data); }, [viewsQuery.data]);

  async function saveView() {
    const name = prompt("View name:");
    if (!name) return;
    await fetch(`${API}/api/jobs/v2/views`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name, filter_json: { ...filters, period, search }, column_config_json: visibleCols }),
    });
    qc.invalidateQueries({ queryKey: ["jobs-views"] });
    toast({ title: `View "${name}" saved` });
  }

  function loadView(view: any) {
    const f = typeof view.filter_json === "string" ? JSON.parse(view.filter_json) : view.filter_json;
    const cols = typeof view.column_config_json === "string" ? JSON.parse(view.column_config_json) : view.column_config_json;
    if (f.period) setPeriod(f.period);
    if (f.search) { setSearch(f.search); setSearchInput(f.search); }
    const { period: _, search: __, ...rest } = f;
    setFilters(rest);
    if (Array.isArray(cols) && cols.length > 0) setVisibleCols(cols);
    setActiveView(String(view.id));
    setViewMenuOpen(null);
  }

  async function deleteView(viewId: number) {
    await fetch(`${API}/api/jobs/v2/views/${viewId}`, { method: "DELETE", headers: getAuthHeaders() });
    qc.invalidateQueries({ queryKey: ["jobs-views"] });
    if (activeView === String(viewId)) setActiveView("all");
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  const toggleSelect = (id: number) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleAll = () => {
    if (selected.size === allJobs.length) setSelected(new Set());
    else setSelected(new Set(allJobs.map((j: any) => j.id)));
  };

  // ── Bulk actions ───────────────────────────────────────────────────────────
  async function bulkAction(action: string, payload?: any) {
    const ids = Array.from(selected);
    const res = await fetch(`${API}/api/jobs/v2/bulk`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ action, job_ids: ids, payload }),
    });
    if (res.ok) {
      const data = await res.json();
      toast({ title: `${action.replace(/_/g, " ")} — ${data.affected ?? data.to_invoice ?? 0} jobs` });
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["jobs-list"] });
      qc.invalidateQueries({ queryKey: ["jobs-kpi"] });
      return data;
    }
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  async function doExport(format: string) {
    const params = new URLSearchParams({ ...queryParams, format });
    const res = await fetch(`${API}/api/jobs/v2/export?${params}`, { headers: getAuthHeaders() });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qleno_jobs_phes_${new Date().toISOString().split("T")[0]}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Filter helpers ─────────────────────────────────────────────────────────
  const setFilter = (key: string, value: string) => setFilters(prev => value ? { ...prev, [key]: value } : (() => { const { [key]: _, ...rest } = prev; return rest; })());
  const clearFilters = () => { setFilters({}); setSearch(""); setSearchInput(""); setPeriod("this_month"); setActiveView("all"); };
  const activeFilterCount = Object.keys(filters).length + (search ? 1 : 0);

  const columns = ALL_COLUMNS.filter(c => visibleCols.includes(c.key));

  // ── Render ─────────────────────────────────────────────────────────────────
  const kpi = kpiQuery.data;

  return (
    <DashboardLayout title="Jobs">
      <div style={{ padding: "28px 32px", fontFamily: FF, minHeight: "100%", background: BG }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: TXT, margin: 0, letterSpacing: "-0.02em" }}>Jobs</h1>
          <div style={{ display: "flex", gap: 6 }}>
            {[
              { key: "today", label: "Today" }, { key: "this_week", label: "Week" },
              { key: "this_month", label: "Month" }, { key: "last_30", label: "30d" },
              { key: "last_90", label: "90d" }, { key: "ytd", label: "YTD" },
              { key: "all", label: "All" },
            ].map(p => (
              <button key={p.key} onClick={() => setPeriod(p.key)}
                style={{
                  padding: "6px 14px", fontSize: 12, fontWeight: 600, fontFamily: FF, border: "none",
                  borderRadius: 6, cursor: "pointer", transition: "all 0.15s",
                  background: period === p.key ? TXT : "transparent",
                  color: period === p.key ? "#FFFFFF" : TXT2,
                }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* KPI Strip */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 16, marginBottom: 24 }}>
          {[
            { label: "REVENUE", value: kpi ? `${fmtMoney(kpi.revenue_min)} \u2013 ${fmtMoney(kpi.revenue_max)}` : "\u2014", accent: true },
            { label: "COMPLETED", value: kpi?.completed?.toLocaleString() ?? "\u2014" },
            { label: "AVG JOB", value: kpi ? fmtMoney(kpi.avg_job) : "\u2014" },
            { label: "JOBS / DAY", value: kpi?.jobs_per_day ?? "\u2014" },
            { label: "UNASSIGNED", value: kpi?.unassigned?.toLocaleString() ?? "\u2014" },
          ].map((card, i) => (
            <div key={i} style={{
              background: CARD, borderRadius: 10, padding: "20px 24px",
              borderBottom: card.accent ? `3px solid ${ACCENT}` : `1px solid ${BORDER}`,
              border: card.accent ? undefined : `1px solid ${BORDER}`,
            }}>
              <div style={{ fontSize: 32, fontWeight: 600, color: TXT, fontFamily: FF, lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>
                {card.value}
              </div>
              <div style={{ fontSize: 13, fontWeight: 500, color: TXT2, textTransform: "uppercase", letterSpacing: "0.02em", marginTop: 6 }}>
                {card.label}
              </div>
            </div>
          ))}
        </div>

        {/* Toolbar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {/* Filters button */}
          <button onClick={() => setShowFilters(!showFilters)}
            style={{
              height: 36, padding: "0 14px", fontSize: 13, fontWeight: 600, fontFamily: FF,
              border: `1px solid ${BORDER}`, borderRadius: 8, cursor: "pointer",
              background: showFilters ? TXT : CARD, color: showFilters ? "#fff" : TXT,
              display: "flex", alignItems: "center", gap: 6,
            }}>
            Filters{activeFilterCount > 0 && <span style={{ background: ACCENT, color: "#fff", borderRadius: 10, padding: "1px 7px", fontSize: 11, fontWeight: 700 }}>{activeFilterCount}</span>}
          </button>

          {/* Columns button */}
          <div style={{ position: "relative" }}>
            <button onClick={() => setShowColumns(!showColumns)}
              style={{ height: 36, padding: "0 14px", fontSize: 13, fontWeight: 600, fontFamily: FF, border: `1px solid ${BORDER}`, borderRadius: 8, cursor: "pointer", background: CARD, color: TXT }}>
              Columns
            </button>
            {showColumns && (
              <div style={{ position: "absolute", top: 42, left: 0, zIndex: 50, background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 16, width: 240, boxShadow: "0 8px 30px rgba(0,0,0,0.08)" }}>
                {ALL_COLUMNS.filter(c => c.key !== "select").map(col => (
                  <label key={col.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 13, fontFamily: FF, color: TXT, cursor: "pointer" }}>
                    <input type="checkbox" checked={visibleCols.includes(col.key)}
                      onChange={() => setVisibleCols(prev => prev.includes(col.key) ? prev.filter(k => k !== col.key) : [...prev, col.key])} />
                    {col.label}
                  </label>
                ))}
                <button onClick={() => setVisibleCols(ALL_COLUMNS.filter(c => c.default).map(c => c.key))}
                  style={{ marginTop: 8, fontSize: 12, color: ACCENT, background: "none", border: "none", cursor: "pointer", fontFamily: FF, fontWeight: 600 }}>
                  Reset to default
                </button>
              </div>
            )}
          </div>

          {/* Views dropdown */}
          <div style={{ position: "relative" }}>
            <select value={activeView}
              onChange={e => {
                const v = e.target.value;
                if (v === "all") { clearFilters(); return; }
                const view = views.find((vw: any) => String(vw.id) === v);
                if (view) loadView(view);
              }}
              style={{ height: 36, padding: "0 12px", fontSize: 13, fontFamily: FF, border: `1px solid ${BORDER}`, borderRadius: 8, color: TXT, background: CARD, cursor: "pointer", minWidth: 140 }}>
              <option value="all">All Jobs</option>
              {views.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Search */}
          <div style={{ position: "relative", width: 240 }}>
            <input value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { setSearch(searchInput); } }}
              placeholder="Search..."
              style={{ width: "100%", height: 36, padding: "0 12px", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, fontFamily: FF, color: TXT, background: CARD, outline: "none", boxSizing: "border-box" }} />
          </div>

          {/* Export */}
          <button onClick={() => doExport("csv")}
            style={{ height: 36, padding: "0 14px", fontSize: 13, fontWeight: 600, fontFamily: FF, border: `1px solid ${BORDER}`, borderRadius: 8, cursor: "pointer", background: CARD, color: TXT }}>
            Export
          </button>

          {/* Count */}
          <span style={{ fontSize: 13, color: TXT2, fontFamily: FF, whiteSpace: "nowrap" }}>
            {totalCount.toLocaleString()} jobs
          </span>
        </div>

        {/* Filters drawer */}
        {showFilters && (
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 20, marginBottom: 16, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
            <FilterSelect label="Status" value={filters.status || ""} onChange={v => setFilter("status", v)}
              options={[["", "All"], ["scheduled", "Scheduled"], ["in_progress", "In Progress"], ["complete", "Complete"], ["cancelled", "Cancelled"]]} />
            <FilterSelect label="Tech" value={filters.assigned_user_id || ""} onChange={v => setFilter("assigned_user_id", v)}
              options={[["", "All"], ["unassigned", "Unassigned"]]} />
            <FilterSelect label="Service" value={filters.service_type || ""} onChange={v => setFilter("service_type", v)}
              options={[["", "All"], ...Object.entries(SERVICE_LABELS)]} />
            <FilterSelect label="Payment" value={filters.payment_status || ""} onChange={v => setFilter("payment_status", v)}
              options={[["", "All"], ["paid", "Paid"], ["unpaid", "Unpaid"], ["failed", "Failed"]]} />
            <FilterSelect label="Flagged" value={filters.flagged || ""} onChange={v => setFilter("flagged", v)}
              options={[["", "All"], ["true", "Flagged only"]]} />
            <FilterSelect label="Has Photos" value={filters.has_photos || ""} onChange={v => setFilter("has_photos", v)}
              options={[["", "All"], ["true", "With photos"]]} />
            <div>
              <div style={FILTER_LABEL}>Revenue Min</div>
              <input type="number" value={filters.revenue_min || ""} onChange={e => setFilter("revenue_min", e.target.value)}
                placeholder="$0" style={FILTER_INPUT} />
            </div>
            <div>
              <div style={FILTER_LABEL}>Revenue Max</div>
              <input type="number" value={filters.revenue_max || ""} onChange={e => setFilter("revenue_max", e.target.value)}
                placeholder="$999" style={FILTER_INPUT} />
            </div>
            <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={clearFilters} style={{ padding: "6px 16px", fontSize: 12, fontWeight: 600, fontFamily: FF, border: `1px solid ${BORDER}`, borderRadius: 6, cursor: "pointer", background: "transparent", color: TXT2 }}>Clear all</button>
              <button onClick={saveView} style={{ padding: "6px 16px", fontSize: 12, fontWeight: 600, fontFamily: FF, border: "none", borderRadius: 6, cursor: "pointer", background: ACCENT, color: "#fff" }}>Save as view</button>
              <button onClick={() => setShowFilters(false)} style={{ padding: "6px 16px", fontSize: 12, fontWeight: 600, fontFamily: FF, border: "none", borderRadius: 6, cursor: "pointer", background: TXT, color: "#fff" }}>Apply</button>
            </div>
          </div>
        )}

        {/* Table */}
        <div ref={scrollRef} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, fontFamily: FF }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                {columns.map(col => (
                  <th key={col.key}
                    onClick={() => col.key !== "select" && setSort(prev => ({ col: col.key, dir: prev.col === col.key && prev.dir === "desc" ? "asc" : "desc" }))}
                    style={{
                      padding: "12px 14px", textAlign: col.align || "left", fontSize: 11, fontWeight: 600,
                      color: TXT2, letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap",
                      cursor: col.key !== "select" ? "pointer" : "default", position: "sticky", top: 0,
                      background: CARD, zIndex: 2, borderBottom: `1px solid ${BORDER}`,
                      width: col.width,
                    }}>
                    {col.key === "select" ? (
                      <input type="checkbox" checked={selected.size > 0 && selected.size === allJobs.length}
                        onChange={toggleAll} style={{ cursor: "pointer" }} />
                    ) : (
                      <>{col.label}{sort.col === col.key && <span style={{ marginLeft: 4 }}>{sort.dir === "asc" ? "\u2191" : "\u2193"}</span>}</>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {listQuery.isLoading ? (
                Array.from({ length: 12 }).map((_, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${BORDER}` }}>
                    {columns.map((_, j) => (
                      <td key={j} style={{ padding: "14px" }}>
                        <div style={{ height: 14, background: "#F0EEE9", borderRadius: 4, width: j === 1 ? 140 : 70 }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : allJobs.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} style={{ padding: "64px 14px", textAlign: "center" }}>
                    <div style={{ fontSize: 16, fontWeight: 600, color: TXT, marginBottom: 8 }}>
                      {activeFilterCount > 0 || search ? "No jobs match these filters" : "No jobs yet"}
                    </div>
                    {(activeFilterCount > 0 || search) && (
                      <button onClick={clearFilters} style={{ padding: "8px 20px", fontSize: 13, fontWeight: 600, fontFamily: FF, border: `1px solid ${BORDER}`, borderRadius: 8, cursor: "pointer", background: CARD, color: TXT }}>
                        Clear filters
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                allJobs.map((job: any) => {
                  const ss = STATUS_STYLE[job.status] ?? STATUS_STYLE.scheduled;
                  const ps = PAYMENT_STYLE[job.payment_status] ?? PAYMENT_STYLE.unpaid;
                  const isSelected = selected.has(job.id);
                  return (
                    <tr key={job.id}
                      style={{ borderBottom: `1px solid ${BORDER}`, height: 56, background: isSelected ? "#F0FDFB" : CARD, transition: "background 0.1s" }}
                      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = HOVER; }}
                      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = CARD; }}>
                      {columns.map(col => (
                        <td key={col.key} style={{ padding: "0 14px", textAlign: col.align || "left", whiteSpace: "nowrap" }}>
                          {col.key === "select" && (
                            <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(job.id)} style={{ cursor: "pointer" }} />
                          )}
                          {col.key === "client" && (
                            <div>
                              <Link href={`/customers/${job.client_id}`}>
                                <span style={{ color: TXT, fontWeight: 600, cursor: "pointer" }}>{job.client_name || "\u2014"}</span>
                              </Link>
                              {job.client_address && (
                                <div style={{ fontSize: 11, color: TXT2, marginTop: 1 }}>
                                  {formatAddress(job.client_address, (job as any).client_city, (job as any).client_state, (job as any).client_zip)}
                                </div>
                              )}
                            </div>
                          )}
                          {col.key === "tech" && (
                            <span style={{ color: job.tech_name?.trim() ? TXT : TXT2, fontWeight: job.tech_name?.trim() ? 500 : 400 }}>
                              {job.tech_name?.trim() || "Unassigned"}
                            </span>
                          )}
                          {col.key === "date" && <span style={{ color: TXT }}>{fmtDate(job.scheduled_date)}</span>}
                          {col.key === "time" && <span style={{ color: TXT2 }}>{fmtTime(job.scheduled_time)}</span>}
                          {col.key === "service" && <span style={{ color: TXT }}>{SERVICE_LABELS[job.service_type] ?? job.service_type}</span>}
                          {col.key === "status" && (
                            <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: ss.bg, color: ss.color }}>
                              {ss.label}
                            </span>
                          )}
                          {col.key === "amount" && (
                            <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, color: TXT }}>{fmtMoney(job.base_fee)}</span>
                          )}
                          {col.key === "branch" && <span style={{ color: TXT2 }}>{job.branch_name || "\u2014"}</span>}
                          {col.key === "zone" && (
                            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              {job.zone_color && <span style={{ width: 8, height: 8, borderRadius: "50%", background: job.zone_color, flexShrink: 0 }} />}
                              <span style={{ color: TXT2 }}>{job.zone_name || "\u2014"}</span>
                            </span>
                          )}
                          {col.key === "source" && <span style={{ color: TXT2 }}>{fmtSource(job.referral_source)}</span>}
                          {col.key === "payment_status" && (
                            <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: ps.bg, color: ps.color }}>
                              {ps.label}
                            </span>
                          )}
                          {col.key === "frequency" && <span style={{ color: TXT2 }}>{FREQ_LABELS[job.frequency] ?? job.frequency}</span>}
                          {col.key === "flagged" && job.flagged && <span style={{ color: "#DC2626", fontWeight: 600 }}>Yes</span>}
                          {col.key === "created_at" && <span style={{ color: TXT2, fontSize: 12 }}>{fmtDate(job.created_at?.split("T")[0])}</span>}
                        </td>
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          {/* Infinite scroll sentinel */}
          <div ref={sentinelRef} style={{ height: 1 }} />
          {listQuery.isFetchingNextPage && (
            <div style={{ padding: "16px", textAlign: "center", fontSize: 13, color: TXT2, fontFamily: FF }}>Loading more...</div>
          )}
        </div>

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div style={{
            position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
            background: TXT, color: "#fff", borderRadius: 12, padding: "12px 20px",
            display: "flex", alignItems: "center", gap: 12, fontSize: 13, fontFamily: FF,
            boxShadow: "0 8px 30px rgba(0,0,0,0.2)", zIndex: 100,
          }}>
            <span style={{ fontWeight: 700 }}>{selected.size} selected</span>
            <BulkBtn label="Mark Complete" onClick={() => bulkAction("mark_complete")} />
            <BulkBtn label="Mark Paid" onClick={() => bulkAction("mark_paid")} />
            <BulkBtn label="Reassign" onClick={() => {
              const techId = prompt("Tech user ID:");
              if (techId) bulkAction("reassign", { assigned_user_id: techId });
            }} />
            <BulkBtn label="Reschedule" onClick={() => {
              const date = prompt("New date (YYYY-MM-DD):");
              if (date) bulkAction("reschedule", { date });
            }} />
            <BulkBtn label="Cancel" onClick={() => {
              const reason = prompt("Reason:");
              if (reason) bulkAction("cancel", { reason });
            }} />
            <BulkBtn label="Batch Invoice" onClick={async () => {
              const pf = await bulkAction("batch_invoice_preflight");
              if (pf) alert(`${pf.to_invoice} will be invoiced, ${pf.already_invoiced} skipped (already invoiced). Total: $${pf.total_amount.toFixed(2)}`);
            }} />
            <BulkBtn label="Export" onClick={() => doExport("csv")} />
            <button onClick={() => setSelected(new Set())}
              style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: 6, padding: "4px 10px", fontSize: 12, fontFamily: FF, cursor: "pointer", fontWeight: 600 }}>
              Clear
            </button>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

const FILTER_LABEL: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: TXT2, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 };
const FILTER_INPUT: React.CSSProperties = { width: "100%", height: 34, padding: "0 10px", border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 13, fontFamily: FF, color: TXT, background: BG, outline: "none", boxSizing: "border-box" };

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[][] }) {
  return (
    <div>
      <div style={FILTER_LABEL}>{label}</div>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ ...FILTER_INPUT, appearance: "none", cursor: "pointer" } as React.CSSProperties}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}

function BulkBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      style={{ background: "rgba(255,255,255,0.12)", border: "none", color: "#fff", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontFamily: FF, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap", transition: "background 0.15s" }}
      onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.25)"}
      onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.12)"}>
      {label}
    </button>
  );
}
