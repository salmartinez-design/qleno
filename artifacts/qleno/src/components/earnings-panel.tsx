import { useEffect, useMemo, useState } from "react";
import { DollarSign, Clock, TrendingUp } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { CalendarPopover } from "@/components/calendar-popover";

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
  totals: { job_count: number; job_total: number; commission: number; hrs_scheduled: number; hrs_worked: number; mileage?: number; effective_rate?: number | null };
};

const MILEAGE_KEYS = ["mileage", "mileage_reimbursement"];
type WindowSum = { commission: number; tips: number; mileage: number; hours: number };
const EMPTY_SUM: WindowSum = { commission: 0, tips: 0, mileage: 0, hours: 0 };
async function fetchWindowSum(start: string, end: string, uq: string): Promise<WindowSum> {
  try {
    const r = await fetch(`${API}/api/payroll/detail?pay_period_start=${start}&pay_period_end=${end}${uq}`, { headers: getAuthHeaders() });
    if (!r.ok) return EMPTY_SUM;
    const d = await r.json();
    const e = d?.data?.[0];
    if (!e) return EMPTY_SUM;
    const tips = Object.entries(e.additional_pay || {}).filter(([k]) => !MILEAGE_KEYS.includes(k)).reduce((s, [, v]) => s + Number(v || 0), 0);
    return { commission: e.totals?.commission || 0, tips, mileage: e.totals?.mileage || 0, hours: e.totals?.hrs_worked || 0 };
  } catch { return EMPTY_SUM; }
}

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
function ytd() {
  const t = new Date();
  return { start: ymd(new Date(t.getFullYear(), 0, 1)), end: ymd(t) };
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

  // Fixed-window rollup (this week / this month / year-to-date) for the rewards
  // tracker + running-average hourly rate. Independent of the selected period.
  const [roll, setRoll] = useState<{ week: WindowSum; month: WindowSum; ytd: WindowSum } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const uq = userId ? `&user_id=${userId}` : "";
    const w = thisWeek(), m = thisMonth(), y = ytd();
    Promise.all([fetchWindowSum(w.start, w.end, uq), fetchWindowSum(m.start, m.end, uq), fetchWindowSum(y.start, y.end, uq)])
      .then(([week, month, yr]) => { if (!cancelled) setRoll({ week, month, ytd: yr }); })
      .catch(() => { if (!cancelled) setRoll(null); });
    return () => { cancelled = true; };
  }, [userId]);

  // Tips exclude mileage keys (mileage is shown on its own card).
  const tips = useMemo(() => Object.entries(data?.additional_pay || {}).filter(([k]) => !MILEAGE_KEYS.includes(k)).reduce((s, [, v]) => s + Number(v || 0), 0), [data]);
  const commission = data?.totals?.commission ?? 0;
  const hours = data?.totals?.hrs_worked ?? 0;
  const mileage = data?.totals?.mileage ?? 0;
  const rewards = commission + tips + mileage;
  const periodRate = data?.totals?.effective_rate ?? (hours > 0 ? commission / hours : null);
  const runningRate = roll && roll.ytd.hours > 0 ? roll.ytd.commission / roll.ytd.hours : null;
  const rTh: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left", padding: "0 0 6px" };
  const rTd: React.CSSProperties = { fontSize: 13, color: "#1A1917", padding: "6px 0", borderTop: "1px solid #F4F3F0" };

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
        <CalendarPopover value={period.start} ariaLabel="Period start" onChange={ymd => { setPreset("custom"); setPeriod(p => ({ ...p, start: ymd })); }} />
        <span style={{ color: "#9E9B94", fontSize: 12 }}>to</span>
        <CalendarPopover value={period.end} ariaLabel="Period end" onChange={ymd => { setPreset("custom"); setPeriod(p => ({ ...p, end: ymd })); }} />
      </div>

      {/* Summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <SummaryCard icon={<TrendingUp size={14} />} label="Commission earned" value={money(commission)} accent />
        <SummaryCard icon={<TrendingUp size={14} />} label="Effective rate"
          value={periodRate != null ? `$${periodRate.toFixed(2)}/hr` : "—"}
          sub={runningRate != null ? `avg $${runningRate.toFixed(2)}/hr` : undefined} accent />
        <SummaryCard icon={<Clock size={14} />} label="Hours worked" value={`${hours.toFixed(1)} hrs`} />
        <SummaryCard icon={<DollarSign size={14} />} label="Tips & extra" value={money(tips)} />
        <SummaryCard icon={<DollarSign size={14} />} label="Mileage" value={money(mileage)} />
        <SummaryCard icon={<DollarSign size={14} />} label="Total rewards" value={money(rewards)} strong />
      </div>

      {/* Total rewards tracker — this week / this month / year-to-date */}
      {roll && (
        <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 12, padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            <p style={{ fontSize: 12, fontWeight: 800, color: "#1A1917", margin: 0 }}>Your total rewards</p>
            {runningRate != null && (
              <span style={{ fontSize: 12, color: "#0A6E5A", fontWeight: 700 }}>Running average: ${runningRate.toFixed(2)}/hr</span>
            )}
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={rTh}></th>
              <th style={{ ...rTh, textAlign: "right" }}>This week</th>
              <th style={{ ...rTh, textAlign: "right" }}>This month</th>
              <th style={{ ...rTh, textAlign: "right" }}>Year to date</th>
            </tr></thead>
            <tbody>
              {([
                { k: "Commission", f: (w: WindowSum) => w.commission },
                { k: "Tips", f: (w: WindowSum) => w.tips },
                { k: "Mileage", f: (w: WindowSum) => w.mileage },
              ]).map(row => (
                <tr key={row.k}>
                  <td style={rTd}>{row.k}</td>
                  <td style={{ ...rTd, textAlign: "right" }}>{money(row.f(roll.week))}</td>
                  <td style={{ ...rTd, textAlign: "right" }}>{money(row.f(roll.month))}</td>
                  <td style={{ ...rTd, textAlign: "right" }}>{money(row.f(roll.ytd))}</td>
                </tr>
              ))}
              <tr>
                <td style={{ ...rTd, fontWeight: 800, borderTop: "2px solid #E5E2DC" }}>Total rewards</td>
                {[roll.week, roll.month, roll.ytd].map((w, i) => (
                  <td key={i} style={{ ...rTd, textAlign: "right", fontWeight: 800, color: "var(--brand, #00C9A0)", borderTop: "2px solid #E5E2DC" }}>{money(w.commission + w.tips + w.mileage)}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

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

function SummaryCard({ icon, label, value, accent, strong, sub }: { icon: React.ReactNode; label: string; value: string; accent?: boolean; strong?: boolean; sub?: string }) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${accent ? "#99E6D5" : "#E5E2DC"}`, borderRadius: 12, padding: "14px 10px", textAlign: "center" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 5, color: accent ? "var(--brand, #00C9A0)" : "#6B7280", marginBottom: 8 }}>
        {icon}
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
      </div>
      <p style={{ fontSize: strong ? 22 : 20, fontWeight: 800, color: "#1A1917", margin: 0, lineHeight: 1 }}>{value}</p>
      {sub && <p style={{ fontSize: 11, fontWeight: 600, color: "#0A6E5A", margin: "5px 0 0", lineHeight: 1 }}>{sub}</p>}
    </div>
  );
}
