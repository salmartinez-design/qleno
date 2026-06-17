import { useState, useEffect, useCallback } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { ChevronLeft, ChevronRight, Clock, Trash2, AlertTriangle, Check, CalendarDays } from "lucide-react";
import { PunchMapModal } from "@/components/punch-map-modal";

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
// Clock times are WALL-CLOCK, treated as plain strings end-to-end — never run
// through Date()/toISOString()/getHours(), which silently shift by the browser
// or server UTC offset (the +5h bug). isoToHHMM slices "HH:MM" straight out of
// whatever timestamp string the API returns ("...T09:16:00", "...Z", or
// "... 09:16:00"); hhmmToISO sends back a naive local datetime (no Z) so the
// server stores exactly what was typed. What you type == what's stored == what
// shows, in any timezone.
function isoToHHMM(iso: string | null): string {
  if (!iso) return "";
  const m = String(iso).match(/[T ](\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : "";
}
function hhmmToISO(dateStr: string, hhmm: string): string { return `${dateStr}T${hhmm}:00`; }
// Typed-time parsing so the field is a plain text box ("9:16 AM") instead of
// the native time-wheel — reliable to type for humans and trivial for an
// automation agent to fill. Accepts "9:16 AM", "9:16am", "13:05", "09:16".
// Returns 24h "HH:MM" or null when unparseable.
function parseTimeInput(raw: string): string | null {
  const s = (raw || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (min > 59) return null;
  const mer = m[3] ? m[3][0] : "";
  if (mer) {
    if (h < 1 || h > 12) return null;
    if (mer === "p" && h !== 12) h += 12;
    if (mer === "a" && h === 12) h = 0;
  } else if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
function hh24ToDisplay(hhmm: string): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return "";
  const ap = h < 12 ? "AM" : "PM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
}
function isoToDisplay(iso: string | null): string { return hh24ToDisplay(isoToHHMM(iso)); }
function fmtHrs(min: number) { const h = Math.floor(min / 60), m = min % 60; return h > 0 ? `${h}h ${m}m` : `${m}m`; }
function fmtClock(iso: string | null) {
  const hhmm = isoToHHMM(iso);
  return hhmm ? hh24ToDisplay(hhmm) : "—";
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
  pay_type: string | null; hourly_rate: string | null; commission_pct: string | null;
  pay_deduction_pct: string | null; pay_deduction_flat: string | null;
  pay?: number | null; source?: string | null;
  gps_in_ft?: number | null; gps_out_ft?: number | null;
  gps_in_outside?: boolean | null; gps_out_outside?: boolean | null; has_gps?: boolean;
  gps_in_lat?: number | null; gps_in_lng?: number | null;
  gps_out_lat?: number | null; gps_out_lng?: number | null;
  job_lat?: number | null; job_lng?: number | null;
};
type Emp = {
  user_id: number; name: string; rows: Row[]; worked_minutes: number;
  day_start: string | null; day_end: string | null; open: boolean; pay_total?: number;
};

const inputStyle: React.CSSProperties = {
  width: 92, height: 30, padding: "0 8px", border: "1px solid #E5E2DC", borderRadius: 6,
  fontSize: 13, fontFamily: FF, color: "#1A1917", outline: "none",
};

// Per-tech pay-type override. "" = inherit the job's smart default
// (commercial → Allowed Hours; residential → Fee Split). Set Hourly / a
// non-default rate / a breakage deduction here to match MaidCentral exactly.
function PayEditor({ emp, row, onChanged, toastFn }: {
  emp: Emp; row: Row; onChanged: () => void; toastFn: (t: { title: string }) => void;
}) {
  const initialPct = row.commission_pct != null ? String(Math.round(parseFloat(row.commission_pct) * 10000) / 100) : "";
  const initialRate = row.hourly_rate != null ? String(parseFloat(row.hourly_rate)) : "";
  const [payType, setPayType] = useState<string>(row.pay_type ?? "");
  const [rate, setRate] = useState<string>(row.pay_type === "fee_split" ? initialPct : initialRate);
  const [ded, setDed] = useState<string>(row.pay_deduction_flat != null ? String(parseFloat(row.pay_deduction_flat)) : "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPayType(row.pay_type ?? "");
    setRate(row.pay_type === "fee_split" ? initialPct : initialRate);
    setDed(row.pay_deduction_flat != null ? String(parseFloat(row.pay_deduction_flat)) : "");
  }, [row.pay_type, row.hourly_rate, row.commission_pct, row.pay_deduction_flat]);

  const unit = payType === "fee_split" ? "%" : payType === "" ? "" : "$/hr";
  async function savePay() {
    setBusy(true);
    try {
      const body: any = { pay_type: payType || null, hourly_rate: null, commission_pct: null,
        pay_deduction_flat: ded ? parseFloat(ded) : null, pay_deduction_pct: null };
      if (payType === "fee_split") body.commission_pct = rate ? parseFloat(rate) / 100 : null;
      else if (payType === "allowed_hours" || payType === "hourly") body.hourly_rate = rate ? parseFloat(rate) : null;
      const r = await api(`/api/timeclock/office/job/${row.job_id}/tech/${emp.user_id}/pay`, { method: "PUT", body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Failed");
      onChanged();
      toastFn({ title: "Pay saved" });
    } catch (e: any) { toastFn({ title: e.message || "Pay save failed" }); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 14px 9px 14px", flexWrap: "wrap" }}>
      <span style={{ fontSize: 10, color: "#9E9B94", fontWeight: 700, minWidth: 28 }}>PAY</span>
      <select value={payType} onChange={e => {
          const v = e.target.value;
          setPayType(v);
          // Commercial pay is $20/hr — pre-fill the rate so the office doesn't
          // type it every time (still editable). Only when switching to a
          // $/hr type with no rate yet; fee_split keeps its % handling.
          if ((v === "allowed_hours" || v === "hourly") && !rate.trim()) setRate("20");
        }}
        style={{ height: 28, border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: FF, color: "#1A1917", background: "#fff", padding: "0 6px" }}>
        <option value="">Default</option>
        <option value="fee_split">Fee Split</option>
        <option value="allowed_hours">Allowed Hours</option>
        <option value="hourly">Hourly</option>
      </select>
      {payType !== "" && (
        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <input value={rate} onChange={e => setRate(e.target.value)} placeholder={payType === "fee_split" ? "35" : "20"}
            inputMode="decimal" style={{ width: 56, height: 28, border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: FF, color: "#1A1917", padding: "0 7px", textAlign: "right" }} />
          <span style={{ fontSize: 11, color: "#9E9B94" }}>{unit}</span>
        </div>
      )}
      <span style={{ fontSize: 11, color: "#9E9B94", marginLeft: 4 }}>Breakage −$</span>
      <input value={ded} onChange={e => setDed(e.target.value)} placeholder="0" inputMode="decimal"
        style={{ width: 50, height: 28, border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: FF, color: "#1A1917", padding: "0 7px", textAlign: "right" }} />
      <button onClick={savePay} disabled={busy}
        style={{ fontSize: 11, fontWeight: 700, padding: "5px 9px", borderRadius: 6, border: "1px solid #E5E2DC", cursor: busy ? "default" : "pointer", fontFamily: FF, color: "#2D9B83", background: "#fff", opacity: busy ? 0.6 : 1 }}>
        Save pay
      </button>
    </div>
  );
}

function RowEditor({ emp, row, dateStr, onChanged, toastFn }: {
  emp: Emp; row: Row; dateStr: string; onChanged: () => void; toastFn: (t: { title: string }) => void;
}) {
  const [inVal, setInVal] = useState(isoToDisplay(row.clock_in_at));
  const [outVal, setOutVal] = useState(isoToDisplay(row.clock_out_at));
  const [busy, setBusy] = useState(false);
  const [gpsOpen, setGpsOpen] = useState(false);
  useEffect(() => { setInVal(isoToDisplay(row.clock_in_at)); setOutVal(isoToDisplay(row.clock_out_at)); }, [row.clock_in_at, row.clock_out_at, row.entry_id]);

  const parsedIn = parseTimeInput(inVal);   // 24h "HH:MM" or null
  const parsedOut = parseTimeInput(outVal);
  const inInvalid = inVal.trim() !== "" && parsedIn === null;
  const outInvalid = outVal.trim() !== "" && parsedOut === null;
  // No saved punch AND nothing typed yet → the field is genuinely empty.
  // Render it so it can never be mistaken for a real (or future-dated) time:
  // dashed placeholder + dimmed styling. The realistic "9:16 AM"/"12:33 PM"
  // placeholders previously read as filled-in data on un-punched rows.
  const inEmpty = !row.entry_id && !inVal.trim();
  const outEmpty = !row.entry_id && !outVal.trim();
  const storedIn = isoToHHMM(row.clock_in_at);
  const storedOut = isoToHHMM(row.clock_out_at);
  const dirty = !inInvalid && !outInvalid && ((parsedIn ?? "") !== storedIn || (parsedOut ?? "") !== storedOut);
  const liveMins = parsedIn && parsedOut
    ? Math.max(0, Math.round((new Date(`${dateStr}T${parsedOut}:00`).getTime() - new Date(`${dateStr}T${parsedIn}:00`).getTime()) / 60000))
    : null;

  async function save() {
    if (inInvalid || outInvalid) { toastFn({ title: "Enter a time like 9:16 AM" }); return; }
    setBusy(true);
    try {
      let entryId = row.entry_id;
      if (!entryId) {
        if (!parsedIn) { toastFn({ title: "Set a clock-in time first" }); setBusy(false); return; }
        const r = await api(`/api/timeclock/office/clock-in`, { method: "POST", body: JSON.stringify({ job_id: row.job_id, user_id: emp.user_id, clock_in_at: hhmmToISO(dateStr, parsedIn) }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "Failed");
        entryId = d.id;
        if (parsedOut) {
          const r2 = await api(`/api/timeclock/${entryId}`, { method: "PATCH", body: JSON.stringify({ clock_out_at: hhmmToISO(dateStr, parsedOut) }) });
          if (!r2.ok) { const e = await r2.json().catch(() => ({})); throw new Error(e.error || "Failed"); }
        }
      } else {
        const body: any = {};
        if (parsedIn) body.clock_in_at = hhmmToISO(dateStr, parsedIn);
        body.clock_out_at = parsedOut ? hhmmToISO(dateStr, parsedOut) : null;
        const r = await api(`/api/timeclock/${entryId}`, { method: "PATCH", body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "Failed");
      }
      onChanged();
      toastFn({ title: "Times saved" });
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
    <div style={{ borderTop: "1px solid #F4F3F0" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px 4px 14px" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.client_name}</div>
        <div style={{ fontSize: 11, color: "#9E9B94" }}>
          {fmtSvc(row.service_type)}{row.scheduled_time ? ` · sched ${fmtSchedTime(row.scheduled_time)}` : ""}
          {!row.entry_id && <span style={{ color: "#9E9B94", marginLeft: 6, fontWeight: 700 }}>· not clocked in</span>}
          {row.entry_id && row.source !== "punched" && <span style={{ color: "#B45309", marginLeft: 6, fontWeight: 700 }}>· estimated — verify</span>}
          {row.flagged && <span style={{ color: "#B45309", marginLeft: 6, fontWeight: 700 }}>· flagged</span>}
          {row.entry_id && (row.has_gps
            ? (() => {
                const lat = row.gps_in_lat, lng = row.gps_in_lng;
                const coords = lat != null && lng != null;
                const label = `GPS ${row.gps_in_ft != null ? `${row.gps_in_ft} ft` : "on"}${row.gps_in_outside ? " (outside zone)" : ""}`;
                const color = row.gps_in_outside ? "#B45309" : "#0A7C66";
                const tip = coords
                  ? `Clock-in location: ${lat!.toFixed(5)}, ${lng!.toFixed(5)}${row.gps_in_ft != null ? ` · ${row.gps_in_ft} ft from job` : " · job not geocoded, distance unavailable"}. Tap to see it on the map.`
                  : "Distance from the job site at clock-in (from the tech's phone GPS).";
                return coords ? (
                  <button type="button" title={tip} onClick={e => { e.stopPropagation(); setGpsOpen(true); }}
                     style={{ marginLeft: 6, fontWeight: 700, color, textDecoration: "underline", background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit" }}>
                    · {label} ▸
                  </button>
                ) : (
                  <span title={tip} style={{ marginLeft: 6, fontWeight: 700, color }}>· {label}</span>
                );
              })()
            : <span title="This punch carried no location — phone location was off/denied, or it was entered here as an office correction." style={{ marginLeft: 6, fontWeight: 700, color: "#9E9B94" }}>· no GPS</span>
          )}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 10, color: "#9E9B94", fontWeight: 700 }}>IN</span>
        <input type="text" inputMode="text" placeholder="—:—" aria-label="Clock in"
          value={inVal} onChange={e => setInVal(e.target.value)}
          onBlur={() => { const p = parseTimeInput(inVal); if (p) setInVal(hh24ToDisplay(p)); }}
          style={{ ...inputStyle, borderColor: inInvalid ? "#EF4444" : inEmpty ? "#ECEAE5" : "#E5E2DC", background: inEmpty ? "#FAFAF8" : "#fff" }} />
        <span style={{ fontSize: 10, color: "#9E9B94", fontWeight: 700, marginLeft: 4 }}>OUT</span>
        <input type="text" inputMode="text" placeholder="—:—" aria-label="Clock out"
          value={outVal} onChange={e => setOutVal(e.target.value)}
          onBlur={() => { const p = parseTimeInput(outVal); if (p) setOutVal(hh24ToDisplay(p)); }}
          style={{ ...inputStyle, borderColor: outInvalid ? "#EF4444" : outEmpty ? "#ECEAE5" : "#E5E2DC", background: outEmpty ? "#FAFAF8" : "#fff" }} />
      </div>
      <div style={{ width: 56, textAlign: "right", fontSize: 12, fontWeight: 700, color: liveMins != null ? "#1A1917" : "#C4C0BB" }}>
        {liveMins != null ? fmtHrs(liveMins) : (parsedIn && !parsedOut ? "open" : "—")}
      </div>
      <div style={{ width: 70, textAlign: "right", fontSize: 13, fontWeight: 800, color: row.pay != null && row.pay > 0 ? "#0A7C66" : "#C4C0BB" }}
        title="Commission for this timesheet (same engine as Payroll)">
        {row.pay != null ? `$${row.pay.toFixed(2)}` : "—"}
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
    <PayEditor emp={emp} row={row} onChanged={onChanged} toastFn={toastFn} />
    {gpsOpen && (
      <PunchMapModal
        onClose={() => setGpsOpen(false)}
        data={{
          techName: emp.name,
          clientName: row.client_name,
          inAt: fmtClock(row.clock_in_at),
          outAt: row.clock_out_at ? fmtClock(row.clock_out_at) : null,
          inLat: row.gps_in_lat ?? null, inLng: row.gps_in_lng ?? null, inFt: row.gps_in_ft ?? null, inOutside: row.gps_in_outside ?? null,
          outLat: row.gps_out_lat ?? null, outLng: row.gps_out_lng ?? null, outFt: row.gps_out_ft ?? null, outOutside: row.gps_out_outside ?? null,
          jobLat: row.job_lat ?? null, jobLng: row.job_lng ?? null,
        }}
      />
    )}
    </div>
  );
}

export default function TimeClockPage() {
  const { toast } = useToast();
  const [date, setDate] = useState(new Date());
  const [data, setData] = useState<{ date: string; employees: Emp[]; revenue?: number; allowed_hours_total?: number; additional_pay_total?: number; diagnostics?: { jobCount?: number; techRows?: number; clockRows?: number; error?: string } } | null>(null);
  const [loading, setLoading] = useState(true);
  const dk = dateKey(date);
  const isToday = dk === dateKey(new Date());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Reconciliation is company-wide — no branch filter (a job's branch_id
      // is often null/mismatched on MC imports, which would hide it).
      const r = await api(`/api/timeclock/day?date=${dk}`);
      setData(r.ok ? await r.json() : { date: dk, employees: [] });
    } catch { setData({ date: dk, employees: [] }); }
    setLoading(false);
  }, [dk]);
  useEffect(() => { load(); }, [load]);

  const employees = data?.employees ?? [];
  const totalWorked = employees.reduce((s, e) => s + e.worked_minutes, 0);
  const totalPunches = employees.reduce((s, e) => s + e.rows.filter(r => r.source === "punched").length, 0);
  const totalRows = employees.reduce((s, e) => s + e.rows.length, 0);
  // JOBS counts DISTINCT jobs — NOT tech-rows. A 2-tech job produces 2 rows
  // but is still 1 job, so totalRows over-counts multi-tech jobs (14 jobs
  // rendered as 16). Use the server's per-unique-job count (the same `jobs`
  // array it sums revenue over, so JOBS and REVENUE stay reconciled with the
  // dispatch day). Fall back to distinct job_ids from the rows if absent.
  const jobCount = data?.diagnostics?.jobCount
    ?? new Set(employees.flatMap(e => e.rows.map(r => r.job_id))).size;
  const totalPay = employees.reduce((s, e) => s + (e.pay_total ?? 0), 0);
  // Business metrics for the summary bar. Revenue + allowed hours come from the
  // API (summed per unique job). Payroll % = full payroll (commission + today's
  // additional pay) ÷ revenue — the labor-cost ratio a service business lives
  // on. Efficiency = allowed ÷ actual hours (>100% = under budget = good).
  const revenue = data?.revenue ?? 0;
  const payrollTotal = totalPay + (data?.additional_pay_total ?? 0);
  const payrollPct = revenue > 0 ? (payrollTotal / revenue) * 100 : null;
  const actualHours = totalWorked / 60;
  const allowedTotal = data?.allowed_hours_total ?? 0;
  const efficiency = actualHours > 0 ? (allowedTotal / actualHours) * 100 : null;

  return (
    <DashboardLayout>
      <div style={{ fontFamily: FF, maxWidth: 920, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 10 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: "#1A1917", margin: 0 }}>Time Clock</h1>
            <p style={{ fontSize: 13, color: "#6B6860", margin: "4px 0 0" }}>
              Reconcile each tech's in/out — feeds payroll hours and the actual-minutes commission split.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setDate(d => addDays(d, -1))} aria-label="Previous day" style={{ border: "1px solid #E5E2DC", background: "#fff", borderRadius: 8, padding: "7px 9px", cursor: "pointer", color: "#6B7280" }}><ChevronLeft size={16} /></button>
            {/* Calendar jump — native date picker layered over the date label */}
            <label style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 8, minWidth: 168, justifyContent: "center", border: "1px solid #E5E2DC", background: "#fff", borderRadius: 8, padding: "5px 12px", cursor: "pointer" }}>
              <CalendarDays size={15} color="#6B7280" />
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: "#1A1917", lineHeight: 1.15 }}>{isToday ? "Today" : date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</div>
                <div style={{ fontSize: 11, color: "#9E9B94" }}>{date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</div>
              </div>
              <input type="date" value={dk}
                // [calendar-jump 2026-06-12] Chrome only auto-opens the date
                // picker from the control's indicator icon — invisible here at
                // opacity 0, so clicking the box focused silently and the
                // calendar never appeared (Sal: "the full calendar needs to
                // come up to move quicker"). showPicker() opens the full
                // month calendar on any click; older browsers fall through to
                // native focus behavior.
                onClick={e => { try { (e.currentTarget as any).showPicker?.(); } catch { /* pre-showPicker browser — native behavior */ } }}
                onChange={e => { if (e.target.value) setDate(new Date(`${e.target.value}T00:00:00`)); }}
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }} />
            </label>
            <button onClick={() => setDate(d => addDays(d, 1))} aria-label="Next day" style={{ border: "1px solid #E5E2DC", background: "#fff", borderRadius: 8, padding: "7px 9px", cursor: "pointer", color: "#6B7280" }}><ChevronRight size={16} /></button>
            {/* Always render the Today button so its slot is reserved — when
                isToday it's hidden but still occupies width, so the date box +
                chevrons don't slide sideways switching today ↔ any other day. */}
            <button onClick={() => setDate(new Date())} aria-hidden={isToday} tabIndex={isToday ? -1 : 0}
              style={{ border: "1px solid #E5E2DC", background: "#fff", borderRadius: 8, padding: "7px 12px", cursor: isToday ? "default" : "pointer", color: "#1A1917", fontSize: 12, fontWeight: 700, fontFamily: FF, visibility: isToday ? "hidden" : "visible" }}>Today</button>
          </div>
        </div>

        {/* Day summary — CSS grid with fixed-size columns so every stat sits in
            an identical cell regardless of its value. A flex row with per-stat
            minWidth still let a stat grow past the floor to fit a wider value
            ($4793.60 vs $2044.00, 50h 24m vs 0m), shoving every following stat
            and shifting columns day to day. Grid tracks are content-independent,
            so placement is static across days at a given width. */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(104px, 1fr))", gap: "14px 20px", padding: "12px 16px", background: "#FFFFFF", border: "0.5px solid #E5E2DC", borderRadius: 12, marginBottom: 14 }}>
          <Stat label="People" value={String(employees.length)} />
          <Stat label="Jobs" value={String(jobCount)} />
          <Stat label="Punched" value={`${totalPunches}/${totalRows}`} accent={totalPunches < totalRows ? "#B45309" : "#16A34A"} />
          <Stat label="Worked hours" value={fmtHrs(totalWorked)} />
          <Stat label="Revenue" value={`$${revenue.toFixed(2)}`} />
          <Stat label="Commission" value={`$${totalPay.toFixed(2)}`} accent="#0A7C66" />
          <Stat label="Payroll %" value={payrollPct != null ? `${payrollPct.toFixed(1)}%` : "—"}
            accent={payrollPct == null ? undefined : payrollPct <= 40 ? "#16A34A" : payrollPct <= 50 ? "#B45309" : "#B91C1C"} />
          <Stat label="Efficiency" value={efficiency != null ? `${efficiency.toFixed(0)}%` : "—"}
            accent={efficiency == null ? undefined : efficiency >= 100 ? "#16A34A" : efficiency >= 85 ? "#B45309" : "#B91C1C"} />
        </div>

        {loading && !data ? (
          <div style={{ textAlign: "center", padding: 40, color: "#9E9B94" }}>Loading…</div>
        ) : employees.length === 0 ? (
          <div style={{ textAlign: "center", padding: 48, background: "#fff", border: "0.5px solid #E5E2DC", borderRadius: 12 }}>
            <Clock size={30} color="#D0CEC9" style={{ marginBottom: 10 }} />
            <div style={{ fontSize: 14, fontWeight: 700, color: "#6B7280" }}>No jobs scheduled this day</div>
            <div style={{ fontSize: 12, color: "#9E9B94" }}>Pick another date to reconcile its clocks.</div>
            {data?.diagnostics && (
              <div style={{ marginTop: 12, fontSize: 11, fontFamily: "monospace", color: data.diagnostics.error ? "#B91C1C" : "#9E9B94" }}>
                {data.diagnostics.error
                  ? `server error: ${data.diagnostics.error}`
                  : `diagnostics — jobs found: ${data.diagnostics.jobCount ?? "?"} · tech rows: ${data.diagnostics.techRows ?? "?"} · clock rows: ${data.diagnostics.clockRows ?? "?"}`}
              </div>
            )}
          </div>
        ) : (
          employees.map(emp => {
            const punched = emp.rows.filter(r => r.source === "punched").length;
            return (
              <div key={emp.user_id} style={{ background: "#fff", border: "0.5px solid #E5E2DC", borderRadius: 12, marginBottom: 12, overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 16px", background: "#FAFAF8", borderBottom: "1px solid #EEECE7" }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#1A1917" }}>{emp.name}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 12, color: "#6B6860" }}>
                    {emp.day_start && <span>{fmtClock(emp.day_start)} – {emp.open ? "on clock" : fmtClock(emp.day_end)}</span>}
                    <span style={{ color: punched < emp.rows.length ? "#B45309" : "#16A34A", fontWeight: 700 }}>{punched}/{emp.rows.length} punched</span>
                    <span style={{ fontWeight: 800, color: "#1A1917" }}>{fmtHrs(emp.worked_minutes)}</span>
                    {emp.pay_total != null && <span style={{ fontWeight: 800, color: "#0A7C66" }}>${emp.pay_total.toFixed(2)}</span>}
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
          <AlertTriangle size={12} /> "GPS" is the distance from the job at the tech's field clock-in. Editing a time here saves an office correction (no GPS) and is logged. Pay reflects these clocks on the Payroll screen.
        </div>
      </div>
    </DashboardLayout>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  // The parent grid owns the column width (fixed, content-independent), so each
  // metric always lands in the same place day to day. minWidth:0 lets the cell
  // be governed by the grid track rather than the stat's own content width.
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: accent ?? "#1A1917", marginTop: 2, whiteSpace: "nowrap" }}>{value}</div>
    </div>
  );
}
