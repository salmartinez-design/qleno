import { useState, useEffect, useCallback } from "react";
import { ChevronLeft, Printer } from "lucide-react";
import { Link } from "wouter";
import { useBranch } from "@/contexts/branch-context";
import { CalendarPopover } from "@/components/calendar-popover";

export const fmt$ = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);
export const fmt$c = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
export const fmtPct = (n: number) => `${(n || 0).toFixed(1)}%`;
export const fmtH = (n: number) => `${(n || 0).toFixed(1)}h`;
// [date-tz-fix] Anchor bare "YYYY-MM-DD" values to local noon so a date-only
// value never renders one day early in US Central. Full timestamps are untouched.
export const fmtDate = (d: string | Date | null) => d ? new Date(typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d + "T12:00:00" : d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
export const fmtSvc = (s: string) => (s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
// [ares-cohesion 2026-08-18] Pointed at the index.css tokens so every report
// page and the Ares module render the SAME colors. `green` and `amber` were
// Tailwind defaults (#10B981 / #F59E0B), not Qleno's --ok #0F7A63 / --warn
// #B45309 — so a warning chip on a report and a warning chip anywhere else in
// the app were two different oranges. index.css is explicit about this:
// "Don't add a sixth 'sort of green' — use these."
export const clr = {
  base: "var(--bg-base)", card: "var(--bg-card)", border: "var(--border)",
  text: "var(--ink)", secondary: "var(--ink-muted)", muted: "var(--ink-faint)",
  brand: "var(--brand)", green: "var(--ok)", amber: "var(--warn)", red: "var(--danger)",
};

interface KpiCardProps { label: string; value: string; sub?: string; color?: string; }
export function KpiCard({ label, value, sub, color = clr.brand }: KpiCardProps) {
  return (
    <div style={{ backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 10, padding: "16px 20px", minWidth: 150 }}>
      <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 600, color: clr.muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</p>
      <p style={{ margin: 0, fontSize: 24, fontWeight: 700, color }}>{value}</p>
      {sub && <p style={{ margin: "4px 0 0", fontSize: 11, color: clr.secondary }}>{sub}</p>}
    </div>
  );
}

interface DateRangeProps { from: string; to: string; onChange: (from: string, to: string) => void; label?: string; }
export function DateRange({ from, to, onChange, label = "Date Range" }: DateRangeProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontSize: 13, color: clr.secondary, fontWeight: 500 }}>{label}:</span>
      <CalendarPopover value={from} ariaLabel={`${label} from`} onChange={ymd => onChange(ymd, to)} />
      <span style={{ color: clr.muted, fontSize: 12 }}>to</span>
      <CalendarPopover value={to} ariaLabel={`${label} to`} onChange={ymd => onChange(from, ymd)} />
    </div>
  );
}

interface ReportHeaderProps { title: string; subtitle?: string; filters?: React.ReactNode; printable?: boolean; }
export function ReportHeader({ title, subtitle, filters, printable }: ReportHeaderProps) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 10 }}>
        <div>
          <Link href="/reports">
            <button style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: clr.secondary, fontSize: 12, marginBottom: 6, padding: 0, fontFamily: "inherit" }}>
              <ChevronLeft size={13} /> Reports
            </button>
          </Link>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: clr.text }}>{title}</h1>
          {subtitle && <p style={{ margin: "4px 0 0", fontSize: 13, color: clr.secondary }}>{subtitle}</p>}
        </div>
        {printable && (
          <button onClick={() => window.print()} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", fontSize: 13, fontWeight: 500, color: clr.secondary, backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 7, cursor: "pointer", fontFamily: "inherit" }}>
            <Printer size={14} /> Print
          </button>
        )}
      </div>
      {filters && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 8, padding: "10px 14px" }}>
          {filters}
        </div>
      )}
    </div>
  );
}

interface Col<T> { header: string; key?: keyof T; render?: (row: T) => React.ReactNode; align?: "left" | "right" | "center"; width?: number | string; }
interface DataTableProps<T> { cols: Col<T>[]; rows: T[]; emptyMsg?: string; loading?: boolean; }
export function DataTable<T extends object>({ cols, rows, emptyMsg = "No data for this period.", loading }: DataTableProps<T>) {
  return (
    <div style={{ overflowX: "auto", backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 10 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${clr.border}` }}>
            {cols.map(c => (
              <th key={c.header} style={{ padding: "10px 14px", fontWeight: 600, color: clr.secondary, textAlign: c.align || "left", whiteSpace: "nowrap", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", width: c.width }}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={cols.length} style={{ padding: 32, textAlign: "center", color: clr.muted }}>Loading...</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={cols.length} style={{ padding: 32, textAlign: "center", color: clr.muted }}>{emptyMsg}</td></tr>
          ) : rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: i < rows.length - 1 ? `1px solid ${clr.border}` : "none" }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = "var(--bg-hover)")}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = "transparent")}
            >
              {cols.map(c => (
                <td key={c.header} style={{ padding: "9px 14px", color: clr.text, textAlign: c.align || "left", whiteSpace: "nowrap" }}>
                  {c.render ? c.render(row) : c.key ? String((row as any)[c.key] ?? "—") : ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// [report-error-state 2026-08-17] A failed fetch used to be invisible. Pages
// destructured only { data, loading }, so a 500 left data null, every
// `s?.total ?? 0` rendered $0, and DataTable fell through to its empty message —
// a broken A/R report looked exactly like a fully collected book. Wrap the
// figures of a report in this and a failure says so instead of showing zeros:
// nothing is estimated, nothing is implied, and the operator can retry.
export function ReportError({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div style={{ backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderLeft: `3px solid ${clr.red}`, borderRadius: 10, padding: "28px 24px", textAlign: "center" }}>
      <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 600, color: clr.red }}>This report could not be loaded</p>
      <p style={{ margin: "0 0 14px", fontSize: 12, color: clr.secondary }}>
        No figures are shown because none could be calculated. {error}
      </p>
      {onRetry && (
        <button onClick={onRetry} style={{ padding: "6px 14px", fontSize: 12, fontWeight: 500, color: clr.text, backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}>
          Try again
        </button>
      )}
    </div>
  );
}

// [reporting-floor 2026-08-17] The server refuses to total money or hours from
// before the tenant's cutover date, because what sits in Qleno's tables from
// before then is a partial, partly double-counted import — not a record of
// trading. When the operator asks for an earlier window the API silently starts
// at the cutover and returns `range_clamped`; without this notice the total
// would look like a full answer to the question they asked. Say what was
// actually covered, and point at where the earlier figures live.
export interface RangeClamp {
  requested_from: string;
  effective_from: string;
  floor: string;
  entire_range_before: boolean;
}

export function RangeClampNotice({ clamp }: { clamp?: RangeClamp | null }) {
  if (!clamp) return null;
  const before = clamp.entire_range_before;
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "11px 14px", marginBottom: 18, backgroundColor: "var(--warn-bg)", border: "1px solid color-mix(in srgb, var(--warn) 33%, transparent)", borderRadius: 8 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: clr.amber, flexShrink: 0, marginTop: 6 }} />
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: clr.secondary }}>
        {before ? (
          <>
            <strong style={{ color: clr.text }}>Nothing to show for this period.</strong>{" "}
            Qleno's records begin {fmtDate(clamp.floor)} — the whole range you asked for
            is before that.
          </>
        ) : (
          <>
            <strong style={{ color: clr.text }}>Showing {fmtDate(clamp.effective_from)} onward.</strong>{" "}
            You asked from {fmtDate(clamp.requested_from)}, but Qleno's records begin{" "}
            {fmtDate(clamp.floor)}.
          </>
        )}{" "}
        Work before then was run and billed in MaidCentral, and only part of it was
        entered here, so any total that crossed that date would be wrong. Earlier
        figures live in{" "}
        <Link href="/reports/revenue-history">
          <span style={{ color: clr.brand, fontWeight: 600, cursor: "pointer" }}>Revenue History (MaidCentral)</span>
        </Link>.
      </p>
    </div>
  );
}

// [mc-revenue-history 2026-08-17] When the operator asks for a period that
// reaches back before the cutover, the revenue report no longer shows a hole —
// MaidCentral's month totals for that stretch are folded into the total and
// into the trend series, as one company's revenue for one period.
//
// This started life as a three-column band showing MaidCentral and Qleno side
// by side. Sal, same day: "I don't want to keep them separate. There's really
// no need... It's the same company." He is right — presenting two figures and
// leaving the addition to the reader is not reporting. So what remains here is
// a single line of provenance under the header, and the numbers themselves are
// merged upstream in the /reports/revenue response.
//
// RangeClampNotice still belongs on the reports that genuinely cannot go back —
// payroll, margins, per-customer figures — because MaidCentral gave us month
// totals only, with no job detail underneath.
export interface HistoricalMonth { month: string; revenue: number; source: string; }
export interface HistoricalRevenue {
  months: HistoricalMonth[]; total: number; source: string; through: string;
}

const SOURCE_LABEL: Record<string, string> = { maidcentral: "MaidCentral" };

function monthLabel(key: string) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export function HistoricalRevenueNote({
  historical, countsFrom,
}: {
  historical?: HistoricalRevenue | null;
  countsFrom?: string | null;
}) {
  if (!historical?.months.length) return null;
  const src = SOURCE_LABEL[historical.source] ?? historical.source;
  const first = monthLabel(historical.months[0].month);
  const last = monthLabel(historical.months[historical.months.length - 1].month);
  const span = first === last ? first : `${first} – ${last}`;

  return (
    <div style={{ backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderLeft: `3px solid ${clr.brand}`, borderRadius: 10, padding: "13px 16px", marginBottom: 16 }}>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: clr.secondary }}>
        <strong style={{ color: clr.text }}>{span} comes from {src}</strong>
        {" — "}{fmt$(historical.total)} across {historical.months.length}{" "}
        month{historical.months.length === 1 ? "" : "s"}, included in the totals below.
        Phes ran on {src} until {countsFrom ? fmtDate(countsFrom) : "the cutover"}, and those are
        month totals with no job detail behind them, so job counts, averages and hours cover{" "}
        {countsFrom ? fmtDate(countsFrom) : "the cutover"} onward.{" "}
        <Link href="/reports/revenue-history">
          <span style={{ color: clr.brand, fontWeight: 600, cursor: "pointer" }}>Month-by-month history</span>
        </Link>.
      </p>
    </div>
  );
}

export function ScoreBadge({ score }: { score: number }) {
  const colors: Record<number, string> = { 4: "var(--ok)", 3: "var(--info)", 2: "var(--warn)", 1: "var(--danger)", 0: "var(--ink-faint)" };
  const labels: Record<number, string> = { 4: "Excellent", 3: "Good", 2: "Fair", 1: "Poor", 0: "N/A" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, color: colors[score] ?? clr.muted }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: colors[score] ?? clr.muted, display: "inline-block" }} />
      {score}/4 {labels[score] ?? ""}
    </span>
  );
}

export function StatusBadge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ display: "inline-block", fontSize: 11, fontWeight: 600, color, backgroundColor: `${color}18`, borderRadius: 4, padding: "2px 7px", border: `1px solid ${color}33` }}>
      {label}
    </span>
  );
}

export function EffBar({ pct, max = 150 }: { pct: number; max?: number }) {
  const clamped = Math.min(pct, max);
  const color = pct >= 90 ? clr.green : pct >= 70 ? clr.brand : clr.amber;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 6, backgroundColor: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${(clamped / max) * 100}%`, height: "100%", backgroundColor: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, color, minWidth: 40 }}>{pct.toFixed(0)}%</span>
    </div>
  );
}

export function DeltaBadge({ pct }: { pct: number }) {
  const up = pct >= 0;
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color: up ? clr.green : clr.red }}>
      {up ? "+" : ""}{pct.toFixed(1)}%
    </span>
  );
}

const API_BASE = (import.meta as any).env?.BASE_URL?.replace(/\/$/, "") || "";
function getToken() { return typeof window !== "undefined" ? localStorage.getItem("qleno_token") : null; }

export function useReportData<T>(path: string): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { activeBranchId } = useBranch();

  // Append the navbar branch toggle as a query param on every reports fetch.
  // Server treats "all" / missing identically, so we only send a value when a
  // specific branch is selected. Reload fires whenever the toggle changes.
  const branchQs = activeBranchId !== "all"
    ? `${path.includes("?") ? "&" : "?"}branch_id=${activeBranchId}`
    : "";
  const fullPath = `${path}${branchQs}`;

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/api${fullPath}`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e?.error || r.status)))
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(String(e)); setLoading(false); });
  }, [fullPath]);

  useEffect(() => { load(); }, [load]);

  return { data, loading, error, reload: load };
}
