import { useState, useEffect, useCallback } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useBranch } from "@/contexts/branch-context";
import { ChevronLeft, ChevronRight, Clock, Trash2, AlertTriangle, Check } from "lucide-react";

// [time-clock-portal 2026-06-05] Office Time Clock portal. The office reconciles
// Qleno's per-job clock times against MaidCentral so commission (proportional by
// actual minutes) and hourly pay match. Day grid grouped by employee; each job
// row has editable In/Out (key in MC's exact times). Reads GET /api/timeclock/
// day; writes via office/clock-in (create), PATCH /:id (edit), DELETE /:id.
// Owner/admin/office.

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

function api(path: string, opts?: RequestInit) {
  return fetch(`${API}${path}`, {
    ...opts,
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...(opts?.headers || {}) },
  });
}
function dateKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function isoToHHMM(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function hhmmToISO(dateStr: string, hhmm: string): string { return new Date(`${dateStr}T${hhmm}:00`).toISOString(); }
function fmtHrs(min: number) { const h = Math.floor(min / 60), m = min % 60; return h > 0 ? `${h}h ${m}m` : `${m}m`; }
function fmtClock(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtSvc(s: string) { return (s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()); }
function fmtSchedTime(t: string | null) {
  if (!t) return "";
  const [h, m] = t.split(":");
  const hr = ((parseInt(h) + 11) % 12) + 1; const ap = parseInt(h) < 12 ? "AM" : "PM";
  return `${hr}:${m} ${ap}`;
}

type Row = {
  job_id: number; client_name: string; service_type: string; scheduled_time: string | null;
  entry_id: number | null; clock_in_at: string | null; clock_out_at: string | null; flagged: boolean; minutes: number | null;
};
type Emp = {
  user_id: number; name: string; rows: Row[]; worked_minutes: number;
  day_start: string | null; day_end: string | null; open: boolean;
};

const inputStyle: React.CSSProperties = {
  width: 92, height: 30, padding: "0 8px", border: "1px solid #E5E2DC", borderRadius: 6,
  fontSize: 13, fontFamily: FF, color: "#1A1917", outline: "none",
};

function RowEditor({ emp, row, dateStr, onChanged, toastFn }: {
  emp: Emp; row: Row; dateStr: string; onChanged: () => void; toastFn: (t: { title: string }) => void;
}) {
  const [inVal, setInVal] = useState(isoToHHMM(row.clock_in_at));
  const [outVal, setOutVal] = useState(isoToHHMM(row.clock_out_at));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setInVal(isoToHHMM(row.clock_in_at)); setOutVal(isoToHHMM(row.clock_out_at)); }, [row.clock_in_at, row.clock_out_at, row.entry_id]);

  const dirty = inVal !== isoToHHMM(row.clock_in_at) || outVal !== isoToHHMM(row.clock_out_at);
  const liveMins = inVal && outVal
    ? Math.max(0, Math.round((new Date(`${dateStr}T${outVal}:00`).getTime() - new Date(`${dateStr}T${inVal}:00`).getTime()) / 60000))
    : null;

  async function save() {
    setBusy(true);
    try {
      let entryId = row.entry_id;
      if (!entryId) {
        if (!inVal) { toastFn({ title: "Set a clock-in time first" }); setBusy(false); return; }
        const r = await api(`/api/timeclock/office/clock-in`, { method: "POST", body: JSON.stringify({ job_id: row.job_id, user_id: emp.user_id, clock_in_at: hhmmToISO(dateStr, inVal) }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "Failed");
        entryId = d.id;
        if (outVal) {
          const r2 = await api(`/api/timeclock/${entryId}`, { method: "PATCH", body: JSON.stringify({ clock_out_at: hhmmToISO(dateStr, outVal) }) });
          if (!r2.ok) { const e = await r2.json().catch(() => ({})); throw new Error(e.error || "Failed"); }
        }
      } else {
        const body: any = {};
        if (inVal) body.clock_in_at = hhmmToISO(dateStr, inVal);
        body.clock_out_at = outVal ? hhmmToISO(dateStr, outVal) : null;
        const r = await api(`/api/timeclock/${entryId}`, { method: "PATCH", body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "Failed");
      }
      onChanged();
    } catch (e: any) { toastFn({ title: e.message || "Save failed" }); }
    finally { setBusy(false); }
  }
  async function del() {
    if (!row.entry_id) return;
    setBusy(true);
    try {
      const r = await api(`/api/timeclock/${row.entry_id}`, { method: "DELETE" });
      if (!r.ok) throw new Error();
      onChanged();
    } catch { toastFn({ title: "Delete failed" }); } finally { setBusy(false); }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderTop: "1px solid #F4F3F0" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.client_name}</div>
        <div style={{ fontSize: 11, color: "#9E9B94" }}>
          {fmtSvc(row.service_type)}{row.scheduled_time ? ` · sched ${fmtSchedTime(row.scheduled_time)}` : ""}
          {row.flagged && <span style={{ color: "#B45309", marginLeft: 6, fontWeight: 700 }}>· flagged</span>}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 10, color: "#9E9B94", fontWeight: 700 }}>IN</span>
        <input type="time" value={inVal} onChange={e => setInVal(e.target.value)} style={inputStyle} />
        <span style={{ fontSize: 10, color: "#9E9B94", fontWeight: 700, marginLeft: 4 }}>OUT</span>
        <input type="time" value={outVal} onChange={e => setOutVal(e.target.value)} style={inputStyle} />
      </div>
      <div style={{ width: 64, textAlign: "right", fontSize: 12, fontWeight: 700, color: liveMins != null ? "#1A1917" : "#C4C0BB" }}>
        {liveMins != null ? fmtHrs(liveMins) : (inVal && !outVal ? "open" : "—")}
      </div>
      <button onClick={save} disabled={busy || !dirty}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 700, padding: "6px 10px", borderRadius: 6, border: "none", cursor: busy || !dirty ? "default" : "pointer", fontFamily: FF, color: "#fff", background: dirty ? "#2D9B83" : "#D4D1CB", opacity: busy ? 0.6 : 1 }}>
        <Check size={12} /> Save
      </button>
      <button onClick={del} disabled={busy || !row.entry_id} title="Delete punch"
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 6, border: "1px solid #F3D2D2", background: row.entry_id ? "#FEF2F2" : "#F7F6F3", color: row.entry_id ? "#B91C1C" : "#D4D1CB", cursor: row.entry_id && !busy ? "pointer" : "default" }}>
        <Trash2 size={13} />
      </button>
    </div>
  );
}

export default function TimeClockPage() {
  const { toast } = useToast();
  const { activeBranchId } = useBranch();
  const [date, setDate] = useState(new Date());
  const [data, setData] = useState<{ date: string; employees: Emp[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const dk = dateKey(date);
  const isToday = dk === dateKey(new Date());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = `?date=${dk}` + (activeBranchId && activeBranchId !== "all" ? `&branch_id=${activeBranchId}` : "");
      const r = await api(`/api/timeclock/day${qs}`);
      setData(r.ok ? await r.json() : { date: dk, employees: [] });
    } catch { setData({ date: dk, employees: [] }); }
    setLoading(false);
  }, [dk, activeBranchId]);
  useEffect(() => { load(); }, [load]);

  const employees = data?.employees ?? [];
  const totalWorked = employees.reduce((s, e) => s + e.worked_minutes, 0);
  const totalPunches = employees.reduce((s, e) => s + e.rows.filter(r => r.entry_id).length, 0);
  const totalRows = employees.reduce((s, e) => s + e.rows.length, 0);

  return (
    <DashboardLayout>
      <div style={{ fontFamily: FF, maxWidth: 920, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 10 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: "#1A1917", margin: 0 }}>Time Clock</h1>
            <p style={{ fontSize: 13, color: "#6B6860", margin: "4px 0 0" }}>
              Edit each tech's in/out to match MaidCentral — feeds payroll hours and the actual-minutes commission split.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setDate(d => addDays(d, -1))} style={{ border: "1px solid #E5E2DC", background: "#fff", borderRadius: 8, padding: "7px 9px", cursor: "pointer", color: "#6B7280" }}><ChevronLeft size={16} /></button>
            <div style={{ textAlign: "center", minWidth: 150 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#1A1917" }}>{isToday ? "Today" : date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</div>
              <div style={{ fontSize: 11, color: "#9E9B94" }}>{date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</div>
            </div>
            <button onClick={() => setDate(d => addDays(d, 1))} style={{ border: "1px solid #E5E2DC", background: "#fff", borderRadius: 8, padding: "7px 9px", cursor: "pointer", color: "#6B7280" }}><ChevronRight size={16} /></button>
            {!isToday && <button onClick={() => setDate(new Date())} style={{ border: "1px solid #E5E2DC", background: "#fff", borderRadius: 8, padding: "7px 12px", cursor: "pointer", color: "#1A1917", fontSize: 12, fontWeight: 700, fontFamily: FF }}>Today</button>}
          </div>
        </div>

        {/* Day summary */}
        <div style={{ display: "flex", gap: 18, padding: "12px 16px", background: "#FFFFFF", border: "0.5px solid #E5E2DC", borderRadius: 12, marginBottom: 14 }}>
          <Stat label="People" value={String(employees.length)} />
          <Stat label="Jobs" value={String(totalRows)} />
          <Stat label="Punched" value={`${totalPunches}/${totalRows}`} accent={totalPunches < totalRows ? "#B45309" : "#16A34A"} />
          <Stat label="Worked hours" value={fmtHrs(totalWorked)} />
        </div>

        {loading && !data ? (
          <div style={{ textAlign: "center", padding: 40, color: "#9E9B94" }}>Loading…</div>
        ) : employees.length === 0 ? (
          <div style={{ textAlign: "center", padding: 48, background: "#fff", border: "0.5px solid #E5E2DC", borderRadius: 12 }}>
            <Clock size={30} color="#D0CEC9" style={{ marginBottom: 10 }} />
            <div style={{ fontSize: 14, fontWeight: 700, color: "#6B7280" }}>No jobs scheduled this day</div>
            <div style={{ fontSize: 12, color: "#9E9B94" }}>Pick another date to reconcile its clocks.</div>
          </div>
        ) : (
          employees.map(emp => {
            const punched = emp.rows.filter(r => r.entry_id).length;
            return (
              <div key={emp.user_id} style={{ background: "#fff", border: "0.5px solid #E5E2DC", borderRadius: 12, marginBottom: 12, overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 16px", background: "#FAFAF8", borderBottom: "1px solid #EEECE7" }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#1A1917" }}>{emp.name}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 12, color: "#6B6860" }}>
                    {emp.day_start && <span>{fmtClock(emp.day_start)} – {emp.open ? "on clock" : fmtClock(emp.day_end)}</span>}
                    <span style={{ color: punched < emp.rows.length ? "#B45309" : "#16A34A", fontWeight: 700 }}>{punched}/{emp.rows.length} punched</span>
                    <span style={{ fontWeight: 800, color: "#1A1917" }}>{fmtHrs(emp.worked_minutes)}</span>
                  </div>
                </div>
                {emp.rows.map(row => (
                  <RowEditor key={`${row.job_id}:${emp.user_id}:${row.entry_id ?? "new"}`} emp={emp} row={row} dateStr={dk} onChanged={load} toastFn={toast} />
                ))}
              </div>
            );
          })
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#9E9B94", margin: "10px 2px 24px" }}>
          <AlertTriangle size={12} /> Times are office corrections (no GPS). Every edit is logged. Pay reflects these clocks on the Payroll screen.
        </div>
      </div>
    </DashboardLayout>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: accent ?? "#1A1917", marginTop: 2 }}>{value}</div>
    </div>
  );
}
