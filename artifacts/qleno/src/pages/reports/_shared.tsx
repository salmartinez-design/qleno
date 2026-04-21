import { useState, useEffect, useCallback } from "react";
import { ChevronLeft, Printer } from "lucide-react";
import { Link } from "wouter";

export const fmt$ = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);
export const fmt$c = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
export const fmtPct = (n: number) => `${(n || 0).toFixed(1)}%`;
export const fmtH = (n: number) => `${(n || 0).toFixed(1)}h`;
export const fmtDate = (d: string | Date | null) => d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
export const fmtSvc = (s: string) => (s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
export const clr = {
  base: "#F7F6F3", card: "#FFFFFF", border: "#E5E2DC",
  text: "#1A1917", secondary: "#6B7280", muted: "#9E9B94",
  brand: "#5B9BD5", green: "#10B981", amber: "#F59E0B", red: "#EF4444",
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
      <input type="date" value={from} onChange={e => onChange(e.target.value, to)}
        style={{ fontSize: 13, padding: "5px 10px", border: `1px solid ${clr.border}`, borderRadius: 6, color: clr.text, backgroundColor: clr.card, fontFamily: "inherit" }} />
      <span style={{ color: clr.muted, fontSize: 12 }}>to</span>
      <input type="date" value={to} onChange={e => onChange(from, e.target.value)}
        style={{ fontSize: 13, padding: "5px 10px", border: `1px solid ${clr.border}`, borderRadius: 6, color: clr.text, backgroundColor: clr.card, fontFamily: "inherit" }} />
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
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#F7F6F3")}
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

export function ScoreBadge({ score }: { score: number }) {
  const colors: Record<number, string> = { 4: "#10B981", 3: "#3B82F6", 2: "#F59E0B", 1: "#EF4444", 0: "#9E9B94" };
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
      <div style={{ flex: 1, height: 6, backgroundColor: "#E5E2DC", borderRadius: 3, overflow: "hidden" }}>
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

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e?.error || r.status)))
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(String(e)); setLoading(false); });
  }, [path]);

  useEffect(() => { load(); }, [load]);

  return { data, loading, error, reload: load };
}
