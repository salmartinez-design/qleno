import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { formatAddress } from "@/lib/format-address";
import { useBranch } from "@/contexts/branch-context";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { CalendarPopover } from "@/components/calendar-popover";
import { X } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

// ── Design tokens ────────────────────────────────────────────────────────────
const BG    = "#F7F6F3";
const CARD  = "#FFFFFF";
const TXT   = "#1A1917";
const TXT2  = "#6B6860";
const BORDER = "#E5E2DC";
const ACCENT = "#0F7A63";
const HOVER = "#F7F6F3";
// [jobs-report-redesign 2026-07-28] Brand tokens shared with dashboard.tsx /
// reports/_shared.tsx so the redesigned KPI sections, chart, leaderboard and
// status-mix read as native Qleno: mint is reserved for the tick / current
// chart line / bars, slate for the "Scheduled" badge, the ok/danger pairs for
// delta pills, #F0EEE9 for the horizontal-only grid.
const MINT     = "#00C9A0";
const FAINT    = "#9E9B94";
const GRIDLINE = "#F0EEE9";
const OK       = "#0F7A63";
const OK_BG    = "#E6F6F1";
const DANGER   = "#B3261E";
const DANGER_BG = "#FCEBEA";
const SLATE    = "#2F3646";
const SLATE_BG = "#EFEFF2";
const CLAY     = "#C2673F";
const SECLABEL: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: FAINT, textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 12px" };

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

// [jobs-report-redesign 2026-07-28] Scheduled uses the canonical slate badge
// (#2F3646 on #EFEFF2), NOT the old cool-blue #4338CA/#EEF2FF — matching the
// dispatch/board "Scheduled" chip so the report reads native. In-progress stays
// amber, complete green, cancelled muted.
const STATUS_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  scheduled:   { bg: SLATE_BG, color: SLATE,     label: "Scheduled" },
  in_progress: { bg: "#FDF3E4", color: "#B45309", label: "In Progress" },
  complete:    { bg: "#E6F6F1", color: "#15803D", label: "Complete" },
  cancelled:   { bg: "#F0EEE9", color: "#6B6860", label: "Cancelled" },
};

const PAYMENT_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  paid:    { bg: "#E6F6F1", color: "#15803D", label: "Paid" },
  unpaid:  { bg: "#FDF3E4", color: "#B45309", label: "Unpaid" },
  failed:  { bg: "#FCEBEA", color: "#B3261E", label: "Failed" },
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
// [booked-today-drilldown 2026-07-22] Long form for the banner ("Jul 22, 2026")
// — the banner is a sentence, not a table cell, so the terse m/d/y reads wrong.
// Parsed as parts, NOT new Date(str), which would shift the day in US timezones.
function fmtBookedOn(d: string) {
  if (!d) return "\u2014";
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtTime(t: string | null) {
  if (!t) return "";
  const [h, min] = t.split(":");
  const hour = parseInt(h, 10);
  return `${hour % 12 || 12}:${min} ${hour >= 12 ? "PM" : "AM"}`;
}
function fmtMoney(val: number | string | null | undefined) {
  if (val == null) return "\u2014";
  const n = typeof val === "string" ? parseFloat(val) : val;
  return isNaN(n) ? "\u2014" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function fmtSource(s: string | null) {
  if (!s) return "\u2014";
  return s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
// [hotfix 2026-07-29] Null-safe KPI number / percent formatters \u2014 return the
// em-dash placeholder when the field is missing (null/undefined/non-numeric)
// so no KPI tile can throw `.toLocaleString()` on an absent field.
function fmtNum(val: number | null | undefined) {
  const n = typeof val === "string" ? parseFloat(val) : val;
  return (n == null || isNaN(n as number)) ? "\u2014" : (n as number).toLocaleString();
}
function fmtPct(val: number | null | undefined) {
  const n = typeof val === "string" ? parseFloat(val) : val;
  return (n == null || isNaN(n as number)) ? "\u2014" : `${Math.round((n as number) * 100)}%`;
}
// [service-label 2026-07-28] Canonical fallback formatter \u2014 same rule as
// reports/_shared.tsx fmtSvc \u2014 for any service_type slug (incl. commercial
// ones like `commercial_cleaning`) not covered by the static SERVICE_LABELS
// residential map or the tenant's commercial_service_types names. Turns a raw
// enum into human-readable Title Case so the column/filter never show a slug.
function fmtSvc(s: string | null) {
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
  // [booked-today-drilldown 2026-07-22] ?booked_on=YYYY-MM-DD opens this page as
  // the drill-down behind the Dashboard's "New Jobs Booked" tile — the jobs
  // BOOKED that day, whatever date they're scheduled for.
  //
  // The period seed is load-bearing: `period` filters scheduled_date, and the
  // default "this_month" would hide exactly the jobs this view exists to show
  // (a job booked today for Aug 1 is next month). So arriving with booked_on
  // starts at "all" — the day scoping comes from booked_on alone.
  const bookedOnParam = (() => {
    const v = new URLSearchParams(window.location.search).get("booked_on") || "";
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "";
  })();
  const [period, setPeriod] = useState(bookedOnParam ? "all" : "this_month");
  const [filters, setFilters] = useState<Record<string, string>>(
    bookedOnParam ? { booked_on: bookedOnParam } : {}
  );
  const [showFilters, setShowFilters] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Booked-on view sorts by when it was booked (most recent booking first) —
  // that's the question being asked; scheduled_date is arbitrary order here.
  const [sort, setSort] = useState({ col: bookedOnParam ? "created_at" : "scheduled_date", dir: "desc" as "asc" | "desc" });
  const [visibleCols, setVisibleCols] = useState<string[]>(
    ALL_COLUMNS.filter(c => c.default).map(c => c.key)
  );
  const [views, setViews] = useState<any[]>([]);
  const [activeView, setActiveView] = useState<string>("all");
  const [viewMenuOpen, setViewMenuOpen] = useState<number | null>(null);

  // ── Build query params ─────────────────────────────────────────────────────
  // [jobs-report 2026-07-28] Two mutually exclusive scoping modes:
  //   • period tabs → filter by SCHEDULED date (date_from/date_to)
  //   • Booked On   → filter by the day a job was BOOKED/created (booked_on)
  // They must never both apply — a scheduled-date range AND'd on top of "booked
  // that day" almost never overlaps, so the list would silently show ~0. When a
  // booked_on filter is active it is authoritative: the scheduled-date range is
  // suppressed and no period tab is highlighted (see the tab render below).
  const bookedMode = !!filters.booked_on;
  const dateRange = bookedMode
    ? { from: "", to: "" }
    : period === "all" ? { from: "", to: "" } : period === "custom" ? { from: filters.date_from || "", to: filters.date_to || "" } : getDateRange(period);

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

  // [hotfix 2026-07-29] Only ever store an array — a non-array payload (error
  // body / reshaped response) would otherwise reach views.map() and throw.
  useEffect(() => { if (Array.isArray(viewsQuery.data)) setViews(viewsQuery.data); }, [viewsQuery.data]);

  // ── Filter option sources (real data, not placeholders) ─────────────────────
  // [tech-filter-real 2026-07-28] Populate the Tech dropdown from the SAME
  // canonical active-technician list the dispatch board / Add-Team-Member picker
  // use (/api/users/techs-with-status), company-scoped via auth + branch, so the
  // report offers real techs instead of just All/Unassigned.
  const techsQuery = useQuery({
    queryKey: ["jobs-filter-techs", activeBranchId],
    queryFn: async () => {
      const params = new URLSearchParams(activeBranchId ? { branch_id: String(activeBranchId) } : {});
      const res = await fetch(`${API}/api/users/techs-with-status?${params}`, { headers: getAuthHeaders() as Record<string, string> });
      if (!res.ok) return [];
      return res.json();
    },
  });
  // [hotfix 2026-07-29] /api/users/techs-with-status returns `{ data: [...] }`
  // (an OBJECT), NOT a bare array — so `techsQuery.data ?? []` fell through to
  // the truthy object and spreading/.map-ing it threw "map is not a function /
  // not iterable", tripping the page's ErrorBoundary. Unwrap the nested array
  // and guard with Array.isArray so ANY payload shape (object, error body,
  // undefined) degrades to an empty dropdown instead of crashing.
  const techList: any[] = Array.isArray((techsQuery.data as any)?.data)
    ? (techsQuery.data as any).data
    : Array.isArray(techsQuery.data) ? (techsQuery.data as any[]) : [];
  const techOptions: [string, string][] = [
    ["", "All"],
    ["unassigned", "Unassigned"],
    ...techList
      .map(t => [String(t.id), `${t.first_name ?? ""} ${t.last_name ?? ""}`.trim() || `Tech #${t.id}`] as [string, string]),
  ];

  // [service-filter-real 2026-07-28] Populate the Service dropdown from the real
  // distinct service_type values on this tenant's jobs (labelled from the
  // tenant-managed commercial_service_types table server-side), so we never
  // offer an option that matches nothing and always include commercial types.
  const serviceTypesQuery = useQuery({
    queryKey: ["jobs-filter-service-types"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/jobs/v2/service-types`, { headers: getAuthHeaders() as Record<string, string> });
      if (!res.ok) return [];
      return res.json();
    },
  });
  // Canonical service label: tenant commercial name (from the endpoint) →
  // residential static map → Title-Case fallback. Used for BOTH the column and
  // the filter dropdown so they always agree.
  // [hotfix 2026-07-29] Array.isArray guard (not just `?? []`) so a non-array
  // payload — an error object, or a future `{ data: [...] }` reshape like
  // techs-with-status — renders an empty dropdown instead of throwing on .map.
  const serviceTypeList: any[] = Array.isArray(serviceTypesQuery.data)
    ? (serviceTypesQuery.data as any[])
    : Array.isArray((serviceTypesQuery.data as any)?.data) ? (serviceTypesQuery.data as any).data : [];
  const svcLabelMap: Record<string, string> = {};
  for (const o of serviceTypeList) {
    if (o?.value && o?.label) svcLabelMap[o.value] = o.label;
  }
  const serviceLabelOf = (v: string | null) =>
    (v && (svcLabelMap[v] || SERVICE_LABELS[v])) || fmtSvc(v);
  const serviceOptions: [string, string][] = [
    ["", "All"],
    ...serviceTypeList
      .map(o => [o.value as string, serviceLabelOf(o.value)] as [string, string]),
  ];

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

  // [jobs-report 2026-07-28] When filtering by booked_on the list mixes two
  // dates — the day booked vs the day scheduled. Auto-surface the Created
  // ("Booked") column and relabel the scheduled-date header so the two aren't
  // confused with each other.
  useEffect(() => {
    if (filters.booked_on) setVisibleCols(prev => prev.includes("created_at") ? prev : [...prev, "created_at"]);
  }, [filters.booked_on]);
  // [jobs-report 2026-07-28] Keep the URL's ?booked_on= param in lockstep with
  // the active filter. Without this, clicking a period tab cleared the filter
  // state but left a stale ?booked_on=YYYY-MM-DD in the address bar — a
  // contradictory URL that reintroduced the filter on refresh or share. Setting
  // a booked_on writes the param; clearing it (period tab, banner, Clear all)
  // deletes it, so the URL always names exactly one active mode.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (filters.booked_on) url.searchParams.set("booked_on", filters.booked_on);
    else url.searchParams.delete("booked_on");
    window.history.replaceState({}, "", url.toString());
  }, [filters.booked_on]);
  const colLabel = (col: ColDef) => {
    if (filters.booked_on) {
      if (col.key === "date") return "Scheduled";
      if (col.key === "created_at") return "Booked";
    }
    return col.label;
  };

  // ── Loaded-rows totals for the <tfoot> summary ──────────────────────────────
  // Reflects the rows currently loaded (infinite scroll); cancelled jobs are
  // excluded from the count, the total, and the average, matching the KPI card.
  //
  // [avg-job-parity 2026-07-28] avg = revenue ÷ revenue-bearing jobs (amount > 0),
  // the SAME definition the /v2/kpi avg_job now uses — so the footer's "avg $X"
  // and the AVG JOB card are always identical. In Booked-On mode these are the
  // non-cancelled Scheduled visits shown (none completed) → avg still ~$289,
  // never $0. Guarded against zero jobs.
  const firstLabelKey = columns.find(c => c.key !== "select")?.key;
  const tableTotals = allJobs.reduce(
    (acc: { count: number; revenue: number; revenueBearing: number }, j: any) => {
      if (j.status === "cancelled") return acc;
      const amt = Number(j.amount) || 0;
      acc.count += 1;
      acc.revenue += amt;
      if (amt > 0) acc.revenueBearing += 1;
      return acc;
    },
    { count: 0, revenue: 0, revenueBearing: 0 }
  );
  const tableAvg = tableTotals.revenueBearing > 0 ? tableTotals.revenue / tableTotals.revenueBearing : 0;

  // ── Render ─────────────────────────────────────────────────────────────────
  const kpi = kpiQuery.data;

  // [jobs-report-redesign 2026-07-28] Derive the redesign's visuals from the
  // (extended) /v2/kpi payload. All numbers come from the server so they
  // reconcile with the table footer; nothing is summed from the paginated rows.
  const eachDay = (from: string, to: string): string[] => {
    const out: string[] = [];
    const [fy, fm, fd] = from.split("-").map(Number);
    const [ty, tm, td] = to.split("-").map(Number);
    const cur = new Date(fy, fm - 1, fd), end = new Date(ty, tm - 1, td);
    let guard = 0;
    while (cur <= end && guard++ < 400) {
      out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`);
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  };
  const dayLabel = (d: string, n: number): string => {
    const [y, m, dd] = d.split("-").map(Number);
    const dt = new Date(y, m - 1, dd);
    return n <= 8 ? dt.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase() : `${m}/${dd}`;
  };
  // Continuous daily axis in a bounded period window (0 on gap days), with the
  // prior-period series aligned by day-offset for the dashed comparison line;
  // unbounded (All / Booked-On) just plots the sparse series the server returned.
  const chartData: any[] = (() => {
    // [hotfix 2026-07-29] Array.isArray guards on every KPI-derived list so a
    // malformed / non-array payload renders an empty state instead of throwing.
    const s: any[] = Array.isArray(kpi?.series) ? kpi.series : [];
    if (!s.length) return [];
    const revByDate = new Map<string, number>(s.map((r: any) => [r.date, r.revenue]));
    if (dateRange.from && dateRange.to) {
      const days = eachDay(dateRange.from, dateRange.to);
      const priorByOffset = new Map<number, number>();
      if (kpi?.prior?.from && kpi?.prior?.to) {
        const pDays = eachDay(kpi.prior.from, kpi.prior.to);
        const pRev = new Map<string, number>((Array.isArray(kpi.prior.series) ? kpi.prior.series : []).map((r: any) => [r.date, r.revenue]));
        pDays.forEach((d, i) => priorByOffset.set(i, pRev.get(d) ?? 0));
      }
      return days.map((d, i) => ({
        label: dayLabel(d, days.length),
        revenue: revByDate.get(d) ?? 0,
        ...(kpi?.prior ? { prior: priorByOffset.get(i) ?? 0 } : {}),
      }));
    }
    return s.map((r: any) => ({ label: dayLabel(r.date, s.length), revenue: r.revenue }));
  })();
  const hasPrior = !!kpi?.prior;
  const revDeltaPct = hasPrior && kpi.prior.revenue_total > 0
    ? (kpi.revenue_total - kpi.prior.revenue_total) / kpi.prior.revenue_total : null;
  const completedDelta = hasPrior ? (kpi.completed - kpi.prior.completed) : null;
  const rawMix = (kpi?.status_mix && typeof kpi.status_mix === "object") ? kpi.status_mix : {};
  const mix = {
    scheduled: Number(rawMix.scheduled) || 0,
    complete: Number(rawMix.complete) || 0,
    cancelled: Number(rawMix.cancelled) || 0,
    unassigned: Number(rawMix.unassigned) || 0,
  };
  const mixTotal = mix.scheduled + mix.complete + mix.cancelled + mix.unassigned;
  const leaderboard: any[] = Array.isArray(kpi?.leaderboard) ? kpi.leaderboard : [];
  const lbMax = leaderboard.reduce((m: number, t: any) => Math.max(m, Number(t?.revenue) || 0), 0) || 1;
  const bookedSources: any[] = Array.isArray(kpi?.booked?.sources) ? kpi.booked.sources : [];
  const topSource = bookedSources.find((x: any) => x.source && x.source !== "unknown");

  return (
    <DashboardLayout title="Jobs">
      <div style={{ padding: "0", fontFamily: FF, minHeight: "100%", background: BG }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: TXT, margin: 0, letterSpacing: "-0.02em" }}>Jobs</h1>
          {/* [jobs-report 2026-07-28] These tabs scope by SCHEDULED date. The
              muted caption names that explicitly so it reads distinctly from the
              Booked On (booked/created date) filter in the drawer. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: TXT2, textTransform: "uppercase", letterSpacing: "0.04em" }}>Scheduled</span>
            <div style={{ display: "flex", gap: 6 }}>
            {[
              { key: "today", label: "Today" }, { key: "yesterday", label: "Yesterday" },
              { key: "this_week", label: "Week" },
              { key: "this_month", label: "Month" }, { key: "last_30", label: "30d" },
              { key: "last_90", label: "90d" }, { key: "ytd", label: "YTD" },
              { key: "all", label: "All" },
            ].map(p => {
              // [jobs-report 2026-07-28] Period tabs and Booked On are mutually
              // exclusive. Selecting a tab clears any active booked_on filter (the
              // URL param is dropped by the sync effect above). While booked_on is
              // active NO tab is highlighted — the booked-on banner names the mode
              // instead — so the two never appear simultaneously selected.
              const tabActive = !bookedMode && period === p.key;
              return (
              <button key={p.key} onClick={() => { setPeriod(p.key); if (filters.booked_on) setFilter("booked_on", ""); }}
                style={{
                  padding: "6px 14px", fontSize: 12, fontWeight: 600, fontFamily: FF, border: "none",
                  borderRadius: 6, cursor: "pointer", transition: "all 0.15s",
                  background: tabActive ? TXT : "transparent",
                  color: tabActive ? "#FFFFFF" : TXT2,
                }}>
                {p.label}
              </button>
              );
            })}
            </div>
          </div>
        </div>

        {/* [booked-today-drilldown 2026-07-22] Say what this filtered view IS.
            In booked mode NO period tab is highlighted (booked_on and the
            scheduled-date tabs are mutually exclusive), so this banner is what
            names the active mode and explains why the list spans many scheduled
            months. Its Clear button drops booked_on and returns to the month
            view. */}
        {filters.booked_on && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
            background: "#EAFBF6", border: "1px solid #A7F3D0", borderRadius: 10,
            padding: "9px 14px", marginBottom: 14 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#04241d", fontFamily: FF }}>
              Jobs booked on {fmtBookedOn(filters.booked_on)}
            </span>
            <span style={{ fontSize: 12, color: "#3E6B5E", fontFamily: FF }}>
              by the day they were booked, not the day they're scheduled — so future visits are included
            </span>
            <button onClick={() => { setFilter("booked_on", ""); setPeriod("this_month"); }}
              style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, background: "none",
                border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, color: "#00A88A", fontFamily: FF }}>
              Clear <X size={12} />
            </button>
          </div>
        )}

        {/* ══ SCHEDULED & COMPLETED — the operations / revenue lens ══
            [jobs-report-redesign 2026-07-28] Every number here reconciles with
            the table footer: Revenue = kpi.revenue_total (non-cancelled), Avg =
            the #1313 revenue-bearing-avg the footer uses, Completed/Cancelled/
            Unassigned from the same window aggregate. Auto-fit wraps to 2-3 per
            row on phones instead of forcing 6 columns off-screen. */}
        <p style={SECLABEL}>Scheduled &amp; Completed</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
          {/* [hotfix 2026-07-29] Per-FIELD null-safety (fmtNum / fmtPct), not just
              the object-level `kpi ?` guard \u2014 a payload missing any one field
              (deploy skew, partial response) would otherwise throw on
              `.toLocaleString()` and trip the ErrorBoundary. */}
          <Tile accent label="Revenue" value={fmtMoney(kpi?.revenue_total)}
            delta={revDeltaPct == null ? undefined : { dir: revDeltaPct >= 0 ? "up" : "down", text: `${revDeltaPct >= 0 ? "+" : ""}${Math.round(revDeltaPct * 100)}%` }}
            sub={hasPrior ? "non-cancelled \u00b7 vs prior" : "non-cancelled"} />
          <Tile label="Completed" value={fmtNum(kpi?.completed)}
            delta={completedDelta == null ? undefined : { dir: completedDelta > 0 ? "up" : completedDelta < 0 ? "down" : "flat", text: `${completedDelta >= 0 ? "+" : ""}${completedDelta}` }}
            sub={kpi?.total_jobs != null ? `of ${Number(kpi.total_jobs).toLocaleString()} in view` : undefined} />
          <Tile label="Avg job" value={fmtMoney(kpi?.avg_job)} sub="revenue-bearing" />
          <Tile label="Completion" value={fmtPct(kpi?.completion_rate)} sub="complete \u00f7 all" />
          <Tile label="Cancel rate" value={fmtPct(kpi?.cancellation_rate)} sub={kpi ? `${Number(kpi.cancelled_count) || 0} cancelled` : undefined} />
          <Tile label="Unassigned" value={fmtNum(kpi?.needs_staffing)} sub="needs staffing" />
        </div>

        {/* Revenue-by-day trend + Status mix / Cancellations */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
          <div style={{ flex: "2 1 340px", minWidth: 0, background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 20, boxSizing: "border-box" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: TXT2, textTransform: "uppercase", letterSpacing: "0.06em" }}>Revenue by day</span>
              <span style={{ fontSize: 22, fontWeight: 600, color: TXT, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(kpi?.revenue_total)}</span>
            </div>
            <div style={{ display: "flex", gap: 16, marginBottom: 8, fontSize: 11, color: TXT2, alignItems: "center" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, height: 2, background: MINT, borderRadius: 1 }} />This period</span>
              {hasPrior && <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, height: 0, borderTop: `2px dashed ${FAINT}` }} />Prior period</span>}
            </div>
            {chartData.length === 0 ? (
              <div style={{ height: 196, display: "grid", placeItems: "center", fontSize: 13, color: FAINT }}>No revenue in this window.</div>
            ) : (
              <ResponsiveContainer width="100%" height={196}>
                <LineChart data={chartData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRIDLINE} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: FAINT, fontFamily: FF }} axisLine={false} tickLine={false}
                    interval={chartData.length > 20 ? Math.floor(chartData.length / 8) : 0} minTickGap={8} />
                  <YAxis tick={{ fontSize: 10, fill: FAINT, fontFamily: FF }} axisLine={false} tickLine={false} width={44}
                    tickFormatter={(v: number) => v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`} />
                  <Tooltip contentStyle={{ fontFamily: FF, fontSize: 12, borderRadius: 8, border: `1px solid ${BORDER}` }}
                    formatter={(val: number, name: string) => [fmtMoney(val), name === "revenue" ? "This period" : "Prior period"]}
                    labelStyle={{ fontWeight: 600, color: TXT }} />
                  <Line type="monotone" dataKey="revenue" stroke={MINT} strokeWidth={2} dot={false} activeDot={{ r: 4, fill: MINT, strokeWidth: 0 }} />
                  {hasPrior && <Line type="monotone" dataKey="prior" stroke={FAINT} strokeWidth={1.5} strokeDasharray="4 3" dot={false} activeDot={{ r: 3, fill: FAINT, strokeWidth: 0 }} />}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          <div style={{ flex: "1 1 260px", minWidth: 0, background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 20, boxSizing: "border-box" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: TXT2, textTransform: "uppercase", letterSpacing: "0.06em" }}>Status mix</span>
              <span style={{ fontSize: 13, color: TXT2, fontVariantNumeric: "tabular-nums" }}>{mixTotal.toLocaleString()} jobs</span>
            </div>
            <div style={{ height: 8, borderRadius: 6, overflow: "hidden", display: "flex", margin: "2px 0 14px", background: HOVER }}>
              {mixTotal > 0 && ([
                { w: mix.scheduled, c: SLATE }, { w: mix.complete, c: MINT }, { w: mix.cancelled, c: "#C9C4BC" }, { w: mix.unassigned, c: CLAY },
              ].map((seg, i) => seg.w > 0 ? <span key={i} style={{ width: `${(seg.w / mixTotal) * 100}%`, background: seg.c }} /> : null))}
            </div>
            {[
              { nm: "Scheduled", c: SLATE, ct: mix.scheduled },
              { nm: "Complete", c: MINT, ct: mix.complete },
              { nm: "Cancelled", c: "#C9C4BC", ct: mix.cancelled },
              { nm: "Unassigned", c: CLAY, ct: mix.unassigned },
            ].map(r => (
              <div key={r.nm} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, padding: "5px 0" }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: r.c, flex: "none" }} />
                <span style={{ flex: 1, color: TXT2 }}>{r.nm}</span>
                <span style={{ fontWeight: 600, color: TXT, fontVariantNumeric: "tabular-nums" }}>{r.ct.toLocaleString()}</span>
              </div>
            ))}
            <div style={{ background: DANGER_BG, border: "1px solid #EFD3CF", borderRadius: 10, padding: "13px 15px", marginTop: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: DANGER, textTransform: "uppercase", letterSpacing: "0.06em" }}>Cancellations \u2014 revenue lost</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 9 }}>
                <span style={{ fontSize: 22, fontWeight: 600, color: "#8A1E17", fontVariantNumeric: "tabular-nums" }}>{(kpi?.cancelled_count ?? 0).toLocaleString()} {(kpi?.cancelled_count === 1) ? "job" : "jobs"}</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: "#8A1E17", fontVariantNumeric: "tabular-nums" }}>{"\u2212"}{fmtMoney(kpi?.cancelled_revenue ?? 0)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Tech leaderboard */}
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 20, marginBottom: 20 }}>
          <div style={{ marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: TXT2, textTransform: "uppercase", letterSpacing: "0.06em" }}>Tech leaderboard \u00b7 completed this window</span>
          </div>
          {leaderboard.length === 0 ? (
            <div style={{ padding: "16px 0", fontSize: 13, color: FAINT }}>No completed jobs by tech in this window.</div>
          ) : leaderboard.map((t: any, i: number) => (
            <div key={t.user_id ?? i} style={{ display: "grid", gridTemplateColumns: "20px minmax(120px, 168px) 1fr 84px 62px", gap: 12, alignItems: "center", padding: "9px 0", borderTop: i === 0 ? "none" : "1px solid #EEECE7", fontSize: 13 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: FAINT, textAlign: "center" }}>{i + 1}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                <span style={{ width: 32, height: 32, borderRadius: 16, background: "rgba(0,201,160,0.12)", color: OK, fontSize: 12, fontWeight: 700, display: "grid", placeItems: "center", flex: "none" }}>{initials(t.name)}</span>
                <span style={{ fontWeight: 600, color: TXT, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{shortName(t.name)}</span>
              </span>
              <span style={{ height: 6, borderRadius: 3, background: HOVER, overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${Math.max(4, (t.revenue / lbMax) * 100)}%`, background: MINT, borderRadius: 3 }} />
              </span>
              <span style={{ textAlign: "right", fontWeight: 600, color: TXT, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(t.revenue)}</span>
              <span style={{ textAlign: "right", color: TXT2, fontVariantNumeric: "tabular-nums" }}>{t.jobs} {t.jobs === 1 ? "job" : "jobs"}</span>
            </div>
          ))}
        </div>

        {/* \u2550\u2550 BOOKED \u2014 the sales / pipeline lens \u2550\u2550
            [jobs-report-redesign 2026-07-28] The Booked-On data given its own
            labeled home (jobs CREATED in the window), so booked-vs-scheduled
            never blur. In Booked-On mode this is the single day; otherwise it's
            the period tab's window reinterpreted against created_at. */}
        <p style={SECLABEL}>Booked</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 24 }}>
          <Tile label="Jobs booked" value={kpi?.booked ? kpi.booked.count.toLocaleString() : "\u2014"} sub={bookedMode ? "on this day" : "created in window"} />
          <Tile label="Booked value" value={kpi?.booked ? fmtMoney(kpi.booked.value) : "\u2014"} sub="new bookings" />
          <Tile label="Top source" value={topSource ? fmtSource(topSource.source) : "\u2014"} sub={topSource ? `${topSource.count} booked` : "no source data"} />
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
              options={techOptions} />
            <FilterSelect label="Service" value={filters.service_type || ""} onChange={v => setFilter("service_type", v)}
              options={serviceOptions} />
            <FilterSelect label="Payment" value={filters.payment_status || ""} onChange={v => setFilter("payment_status", v)}
              options={[["", "All"], ["paid", "Paid"], ["unpaid", "Unpaid"], ["failed", "Failed"]]} />
            <FilterSelect label="Flagged" value={filters.flagged || ""} onChange={v => setFilter("flagged", v)}
              options={[["", "All"], ["true", "Flagged only"]]} />
            <FilterSelect label="Has Photos" value={filters.has_photos || ""} onChange={v => setFilter("has_photos", v)}
              options={[["", "All"], ["true", "With photos"]]} />
            {/* [jobs-report 2026-07-28] Surface booked_on as a real date picker —
                previously it was reachable only via the ?booked_on= URL param.
                Uses the app's shared CalendarPopover (same styled month grid as
                dispatch, the other Reports pages, and the quote builder) instead
                of the OS-native <input type="date"> popover, which didn't match
                the Qleno design system. Value stays a YYYY-MM-DD string, so the
                backend contract is unchanged. Setting a day enters booked mode
                (bookedMode above suppresses the scheduled-date range and clears
                the tab highlight, so the two never AND to zero); clearing drops
                back to the default month view. */}
            <FilterDateField label="Booked On" value={filters.booked_on || ""}
              onChange={v => {
                if (v) setFilter("booked_on", v);
                else { setFilter("booked_on", ""); setPeriod("this_month"); }
              }} />
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
                      <>{colLabel(col)}{sort.col === col.key && <span style={{ marginLeft: 4 }}>{sort.dir === "asc" ? "\u2191" : "\u2193"}</span>}</>
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
                          {col.key === "service" && <span style={{ color: TXT }}>{serviceLabelOf(job.service_type)}</span>}
                          {col.key === "status" && (
                            <span style={{ display: "inline-block", padding: "3px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", background: ss.bg, color: ss.color }}>
                              {ss.label}
                            </span>
                          )}
                          {col.key === "amount" && (
                            <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600,
                              color: job.status === "cancelled" ? TXT2 : TXT,
                              textDecoration: job.status === "cancelled" ? "line-through" : undefined }}>
                              {fmtMoney(job.amount)}
                            </span>
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
                          {col.key === "flagged" && job.flagged && <span style={{ color: "#B3261E", fontWeight: 600 }}>Yes</span>}
                          {col.key === "created_at" && <span style={{ color: TXT2, fontSize: 12 }}>{fmtDate(job.created_at?.split("T")[0])}</span>}
                        </td>
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
            {allJobs.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: `2px solid ${BORDER}`, background: BG }}>
                  {columns.map(col => {
                    let content: React.ReactNode = null;
                    if (col.key === firstLabelKey) {
                      content = `${tableTotals.count.toLocaleString()} ${tableTotals.count === 1 ? "job" : "jobs"}${listQuery.hasNextPage ? " loaded" : ""} · avg ${fmtMoney(tableAvg)}`;
                    } else if (col.key === "amount") {
                      content = fmtMoney(tableTotals.revenue);
                    }
                    return (
                      <td key={col.key} style={{ padding: "12px 14px", textAlign: col.align || "left",
                        fontSize: 12, fontWeight: 700, color: TXT, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                        {content}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            )}
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

// Filter-drawer date field built on the shared CalendarPopover (the app-wide
// styled month grid) rather than a native <input type="date">, so date
// selection on the Jobs report matches dispatch, the other Reports pages, and
// the quote builder. Emits a YYYY-MM-DD string (or "" when cleared) — same
// value contract the removed native input had. The block trigger fills the
// grid cell like the sibling FILTER_INPUT fields; a Clear affordance appears
// once a day is chosen, since CalendarPopover can only pick, never unset.
function FilterDateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div style={{ ...FILTER_LABEL, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>{label}</span>
        {value && (
          <button type="button" onClick={() => onChange("")}
            style={{ display: "inline-flex", alignItems: "center", gap: 2, background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 10, fontWeight: 700, color: ACCENT, fontFamily: FF, textTransform: "none", letterSpacing: 0 }}>
            Clear <X size={10} />
          </button>
        )}
      </div>
      <CalendarPopover value={value} ariaLabel={label} onChange={onChange} block />
    </div>
  );
}

// [jobs-report-redesign 2026-07-28] MoneyCard-style KPI tile matching
// dashboard.tsx: the 3×12px mint tick left of an 11px/600/uppercase label, an
// ink-not-colored 28px tabular number, and — per the brand rule — any delta on
// a SEPARATE pill (up = ok/green, down = danger/red, flat = muted), never
// coloring the number itself. `accent` adds the green bottom rule for the hero
// Revenue tile.
function Tile({ label, value, delta, sub, accent }: {
  label: string; value: React.ReactNode;
  delta?: { dir: "up" | "down" | "flat"; text: string };
  sub?: string; accent?: boolean;
}) {
  const pill = delta
    ? delta.dir === "up" ? { color: OK, background: OK_BG }
    : delta.dir === "down" ? { color: DANGER, background: DANGER_BG }
    : { color: TXT2, background: HOVER }
    : null;
  return (
    <div style={{
      background: CARD, borderRadius: 10, padding: "16px 18px", minHeight: 104,
      display: "flex", flexDirection: "column", justifyContent: "space-between",
      border: `1px solid ${BORDER}`, ...(accent ? { borderBottom: `3px solid ${OK}` } : {}),
    }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}>
          <span style={{ width: 3, height: 12, borderRadius: 2, background: MINT, flex: "none" }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: TXT2, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 28, fontWeight: 600, color: TXT, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{value}</span>
          {delta && pill && <span style={{ fontSize: 12, fontWeight: 600, borderRadius: 4, padding: "1px 6px", ...pill }}>{delta.text}</span>}
        </div>
      </div>
      {sub && <div style={{ fontSize: 12, color: FAINT, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

// Avatar initials + "First L." short name for the tech leaderboard.
function initials(name: string) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}
function shortName(name: string) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Tech";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
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
