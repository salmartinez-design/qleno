import { useEffect, useMemo, useState } from "react";
import { DollarSign, Clock, TrendingUp } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// Real-time earnings view. Office opens it on an employee's profile (pass
// userId); a tech opens it for themselves (omit userId — the server scopes a
// technician to their own data). Shows commission earned so far for the period,
// hours, tips/extra, and a day-by-day job list. Qleno-native design — not a
// copy of any other tool's layout.

type JobRow = {
  job_id: number; date: string; client: string; scope: string | null;
  commission: number; hrs_worked: number; hrs_scheduled: number;
  effective_rate: number | null; commission_basis?: string | null;
};
type EmpEarnings = {
  user_id: number; name: string; jobs: JobRow[];
  additional_pay: Record<string, number>;
  totals: { job_count: number; job_total: number; commission: number; hrs_scheduled: number; hrs_worked: number };
};

function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function thisWeek() {
  const t = new Date();
  const start = new Date(t); start.setDate(t.getDate() - t.getDay());
  const end = new Date(start); end.setDate(start.getDate() + 6);
  return { start: ymd(start), end: ymd(end) };
}
function lastWeek() {
  const t = new Date();
  const start = new Date(t); start.setDate(t.getDate() - t.getDay() - 7);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  return { start: ymd(start), end: ymd(end) };
}
function thisMonth() {
  const t = new Date();
  return { start: ymd(new Date(t.getFullYear(), t.getMonth(), 1)), end: ymd(t) };
}
const money = (n: number) => `$${(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtScope = (s: string | null) => (s ? s.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : "—");
const fmtDay = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

export function EarningsPanel({ userId, title = "Earnings" }: { userId?: number; title?: string }) {
  const [period, setPeriod] = useState(thisWeek());
  const [preset, setPreset] = useState<"this" | "last" | "month" | "custom">("this");
  const [data, setData] = useState<EmpEarnings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const uq = userId ? `&user_id=${userId}` : "";
    fetch(`${API}/api/payroll/detail?pay_period_start=${period.start}&pay_period_end=${period.end}${uq}`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setData((d?.data && d.data[0]) || null); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId, period.start, period.end]);

  const tips = useMemo(() => Object.values(data?.additional_pay || {}).reduce((s, v) => s + v, 0), [data]);
  const commission = data?.totals?.commission ?? 0;
  const earned = commission + tips;
  const hours = data?.totals?.hrs_worked ?? 0;

  const byDay = useMemo(() => {
    const m: Record<string, JobRow[]> = {};
    for (const j of data?.jobs || []) (m[j.date] ||= []).push(j);
    return Object.entries(m).sort((a, b) => b[0].localeCompare(a[0]));
  }, [data]);

  function applyPreset(p: "this" | "last" | "month") {
    setPreset(p);
    setPeriod(p === "this" ? thisWeek() : p === "last" ? lastWeek() : thisMonth());
  }
  const presetBtn = (active: boolean): React.CSSProperties => ({
    padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
    border: `1px solid ${active ? "var(--brand, #00C9A0)" : "#E5E2DC"}`,
    background: active ? "rgba(0,201,160,0.08)" : "#fff",
    color: active ? "var(--brand, #00C9A0)" : "#1A1917",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Period controls */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1917" }}>{title}</span>
        <div style={{ flex: 1 }} />
        <button style={presetBtn(preset === "this")} onClick={() => applyPreset("this")}>This week</button>
        <button style={presetBtn(preset === "last")} onClick={() => applyPreset("last")}>Last week</button>
        <button style={presetBtn(preset === "month")} onClick={() => applyPreset("month")}>This month</button>
        <input type="date" value={period.start} onChange={e => { setPreset("custom"); setPeriod(p => ({ ...p, start: e.target.value })); }}
          style={{ padding: "5px 8px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 12, fontFamily: "inherit" }} />
        <span style={{ color: "#9E9B94", fontSize: 12 }}>to</span>
        <input type="date" value={period.end} onChange={e => { setPreset("custom"); setPeriod(p => ({ ...p, end: e.target.value })); }}
          style={{ padding: "5px 8px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 12, fontFamily: "inherit" }} />
      </div>

      {/* Summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <SummaryCard icon={<TrendingUp size={14} />} label="Commission earned" value={money(commission)} accent />
        <SummaryCard icon={<Clock size={14} />} label="Hours worked" value={`${hours.toFixed(1)} hrs`} />
        <SummaryCard icon={<DollarSign size={14} />} label="Tips & extra" value={money(tips)} />
        <SummaryCard icon={<DollarSign size={14} />} label="Total earned" value={money(earned)} strong />
      </div>

      {/* Additional pay broken out by type — tips, sick pay paid out, bonuses,
          holiday, employee-of-the-month, reimbursements, etc. */}
      {Object.keys(data?.additional_pay || {}).length > 0 && (
        <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 12, padding: "12px 14px" }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 8px" }}>Tips, bonuses & extra pay</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {Object.entries(data!.additional_pay).sort((a, b) => b[1] - a[1]).map(([type, amt]) => (
              <div key={type} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 13, color: "#1A1917" }}>{fmtScope(type)}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: amt < 0 ? "#DC2626" : "#1A1917" }}>{money(amt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Day-by-day */}
      <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 12, overflow: "hidden" }}>
        {loading ? (
          <p style={{ padding: 20, textAlign: "center", color: "#9E9B94", fontSize: 13, margin: 0 }}>Loading…</p>
        ) : byDay.length === 0 ? (
          <p style={{ padding: 20, textAlign: "center", color: "#9E9B94", fontSize: 13, margin: 0 }}>No completed jobs in this period yet.</p>
        ) : byDay.map(([day, jobs]) => {
          const dayTotal = jobs.reduce((s, j) => s + j.commission, 0);
          const dayHrs = jobs.reduce((s, j) => s + j.hrs_worked, 0);
          return (
            <div key={day} style={{ borderBottom: "1px solid #F3F4F6" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: "#FAFAF8" }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#1A1917" }}>{fmtDay(day)}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--brand, #00C9A0)" }}>{money(dayTotal)} <span style={{ color: "#9E9B94", fontWeight: 500 }}>· {dayHrs.toFixed(1)}h</span></span>
              </div>
              {jobs.map(j => (
                <div key={j.job_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 14px", borderTop: "1px solid #F7F6F3" }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 12, fontWeight: 600, color: "#1A1917", margin: 0 }}>{j.client || "—"}</p>
                    <p style={{ fontSize: 11, color: "#9E9B94", margin: "1px 0 0" }}>
                      {fmtScope(j.scope)} · {j.hrs_worked > 0 ? `${j.hrs_worked.toFixed(1)}h` : `${j.hrs_scheduled.toFixed(1)}h est`}
                      {j.commission_basis === "commercial_hourly" ? " · hourly" : ""}
                    </p>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", flexShrink: 0 }}>{money(j.commission)}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SummaryCard({ icon, label, value, accent, strong }: { icon: React.ReactNode; label: string; value: string; accent?: boolean; strong?: boolean }) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${accent ? "#99E6D5" : "#E5E2DC"}`, borderRadius: 12, padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: accent ? "var(--brand, #00C9A0)" : "#6B7280", marginBottom: 6 }}>
        {icon}
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
      </div>
      <p style={{ fontSize: strong ? 22 : 20, fontWeight: 700, color: "#1A1917", margin: 0, lineHeight: 1 }}>{value}</p>
    </div>
  );
}
