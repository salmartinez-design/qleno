import { useState, useEffect, useCallback } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { ChevronLeft, ChevronRight, Clock, Trash2, AlertTriangle, Check, CalendarDays, MessageSquare } from "lucide-react";
import { PunchMapModal } from "@/components/punch-map-modal";
import { CalendarPopover } from "@/components/calendar-popover";
import { Link } from "wouter";
import { companyTz } from "@/lib/company-tz";

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
// [open-clock-finder 2026-08-13] Show the server's SENTENCE, never its error
// CODE. Every save path here read `d.error` — the machine-readable code — so a
// blocked save surfaced the bare string "OPEN_PUNCH_ELSEWHERE" in a toast
// (Maribel: "this shows up everywhere"). The route has always sent a plain-
// English `message` alongside it, naming the job that's still on the clock;
// the screen was just discarding it. Prefer `message`, fall back to the code
// only when there isn't one so nothing is ever silently swallowed.
function errText(d: any, fallback = "Save failed"): string {
  return d?.message || d?.error || fallback;
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
// automation agent to fill. The colon is OPTIONAL: bare digits autocomplete
// (916 → 9:16, 1305 → 13:05, 9 → 9:00, 930pm → 9:30 PM) so the office can punch
// times fast without reaching for ":". onBlur reformats to "9:16 AM" via
// hh24ToDisplay. Also accepts "9:16 AM", "9:16am", "13:05", "09:16". Returns
// 24h "HH:MM" or null when unparseable.
function parseTimeInput(raw: string): string | null {
  let s = (raw || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  // Peel a trailing am/pm (with or without dots) off first: "930pm", "9p", "12a.m."
  let mer = "";
  const mm = s.match(/(a|p)\.?m?\.?$/);
  if (mm) { mer = mm[1]; s = s.slice(0, mm.index); }
  let h: number, min: number;
  if (s.includes(":")) {
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    h = parseInt(m[1], 10); min = parseInt(m[2], 10);
  } else {
    // Bare digits: 1–2 → hour only (min 00), 3 → H:MM, 4 → HH:MM.
    if (!/^\d{1,4}$/.test(s)) return null;
    if (s.length <= 2) { h = parseInt(s, 10); min = 0; }
    else if (s.length === 3) { h = parseInt(s.slice(0, 1), 10); min = parseInt(s.slice(1), 10); }
    else { h = parseInt(s.slice(0, 2), 10); min = parseInt(s.slice(2), 10); }
  }
  if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59) return null;
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
// Decimal-hours form of a minute count, shown ALONGSIDE the standard h/m form
// (Francisco's request: see "4h 30m" and "4.5h" together). Trailing zeros are
// trimmed so a whole hour reads "4h", not "4.00h".
function fmtHrsDec(min: number) { return `${(min / 60).toFixed(2).replace(/\.?0+$/, "")}h`; }
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
// Scheduled window: the meta line showed only the START ("sched 6:00 AM"). The
// office needs the scheduled STOP too. There's no stored end time, so derive it
// = scheduled start + duration, where duration = allowed_hours (the budget)
// falling back to estimated_hours. Returns "6:00 AM – 11:00 AM" (or just the
// start when no duration is known, so nothing regresses).
function fmtSchedWindow(t: string | null, durationHrs: number | null | undefined): string {
  const start = fmtSchedTime(t);
  if (!start || durationHrs == null || durationHrs <= 0) return start;
  const [h, m] = t!.split(":").map(x => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return start;
  const endMin = h * 60 + m + Math.round(durationHrs * 60);
  const eh = Math.floor((endMin % 1440) / 60), em = endMin % 60;
  const hr12 = ((eh + 11) % 12) + 1; const ap = eh < 12 ? "AM" : "PM";
  return `${start} – ${hr12}:${String(em).padStart(2, "0")} ${ap}`;
}

type Row = {
  job_id: number; client_name: string; service_type: string; scheduled_time: string | null;
  address?: string | null; client_id?: number | null; account_id?: number | null;
  entry_id: number | null; clock_in_at: string | null; clock_out_at: string | null; flagged: boolean; minutes: number | null;
  allowed_hours?: number | null; estimated_hours?: number | null;
  fee?: number | null;
  // [billed-reconcile 2026-07-27] Canonical all-in invoiced total (service +
  // add-ons + mods − discounts) — what the Jobs page / invoice shows. Distinct
  // from `fee` (the residential fee-split commission base, which omits the
  // parking add-on). Prefer this for the "billed $X" chip.
  billed?: number | null;
  effective_pay_type?: "fee_split" | "allowed_hours" | "hourly";
  pay_type: string | null; hourly_rate: string | null; commission_pct: string | null;
  pay_deduction_pct: string | null; pay_deduction_flat: string | null;
  pay?: number | null; pay_kind?: "commission" | "cancellation"; cancel_action?: string | null;
  source?: string | null;
  // [orphan-open-punch 2026-08-13] Set when this row exists only because a clock
  // is still running on it — the job itself was cancelled or moved off this day.
  // Explains why a row shows on a day with no such job on the schedule.
  orphan_reason?: string | null;
  // [second-hidden-clock 2026-08-13] A second punch on the same job+tech. Shown
  // so it can be closed or deleted; contributes nothing to hours or pay.
  duplicate?: boolean; duplicate_reason?: string | null;
  // [pay-note 2026-08-12] The office's explanation of this pay line.
  pay_note?: string | null; pay_note_at?: string | null; pay_note_by_name?: string | null;
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

// [trainee-rate-dropped 2026-08-13] Every pay type whose rate box holds a
// DOLLARS-PER-HOUR figure (fee_split's box holds a percent instead). Both the
// rate pre-fill and the save read this one list — they were maintained
// separately, 'trainee' was added to the pre-fill and missed on the save, and
// every trainee since has been stored with no rate and paid $0.
const RATE_PAY_TYPES = ["allowed_hours", "hourly", "trainee"];

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
  // What the row ACTUALLY pays as: the explicit dropdown choice when set, else
  // the job's smart default resolved server-side (correct for every client —
  // commercial-by-account, by-client-type, or by-service-type all land right).
  // Drives which verification chip shows so live edits reflect immediately.
  const effectivePayType = payType !== "" ? payType : (row.effective_pay_type ?? "fee_split");
  async function savePay() {
    setBusy(true);
    try {
      const body: any = { pay_type: payType || null, hourly_rate: null, commission_pct: null,
        pay_deduction_flat: ded ? parseFloat(ded) : null, pay_deduction_pct: null };
      if (payType === "fee_split") body.commission_pct = rate ? parseFloat(rate) / 100 : null;
      // [trainee-rate-dropped 2026-08-13] Maribel: "when we mark them as trainee
      // it doesn't populate the pay total."
      //
      // 'trainee' was missing from this list, so picking Trainee saved
      // pay_type='trainee' with hourly_rate = NULL — the null the body is
      // initialized with. The dropdown pre-fills the rate box with 20 and the
      // save reports "Pay saved", so the office sees a rate that was never
      // stored. Downstream, a trainee resolves to an hourly cleaner (asPayType)
      // and an hourly cleaner with no rate can't be paid: the engine emits NO
      // row for them, which is why every line read "—" and the day totalled
      // $0.00 rather than being merely wrong.
      //
      // RATE_PAY_TYPES is shared with the pre-fill above so the two lists can
      // never drift apart again — that drift is the whole bug.
      else if (RATE_PAY_TYPES.includes(payType)) body.hourly_rate = rate ? parseFloat(rate) : null;
      const r = await api(`/api/timeclock/office/job/${row.job_id}/tech/${emp.user_id}/pay`, { method: "PUT", body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Failed");
      onChanged();
      toastFn({ title: "Pay saved" });
    } catch (e: any) { toastFn({ title: e.message || "Pay save failed" }); }
    finally { setBusy(false); }
  }

  // Charged cancellation/lockout: the tech is paid the cancellation fee, not
  // commission, so the pay-type editor doesn't apply. Show a clear static
  // label instead of the (misleading) Fee Split / Allowed Hours dropdown.
  if (row.pay_kind === "cancellation") {
    const isLockout = row.cancel_action === "lockout";
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 14px 9px 14px", flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, color: "#9E9B94", fontWeight: 700, minWidth: 28 }}>PAY</span>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.04em", textTransform: "uppercase", color: "#B45309", background: "#FDF3E4", border: "1px solid #F2DFB8", borderRadius: 999, padding: "3px 10px" }}>
          {isLockout ? "Lockout fee" : "Cancellation fee"}
        </span>
        <span style={{ fontSize: 11, color: "#9E9B94" }}>
          Paid as a flat {isLockout ? "lockout" : "cancellation"} fee — no commission on this job.
        </span>
      </div>
    );
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
          // Trainee is paid $/hr too, so it pre-fills the same way.
          if (RATE_PAY_TYPES.includes(v) && !rate.trim()) setRate("20");
        }}
        style={{ height: 28, border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: FF, color: "#1A1917", background: "#fff", padding: "0 6px" }}>
        <option value="">Default</option>
        <option value="fee_split">Fee Split</option>
        <option value="allowed_hours">Allowed Hours</option>
        <option value="hourly">Hourly</option>
        {/* [trainee-paytype 2026-07-27] Trainee = one-click "exclude from the
            commission pool, pay $/hr." Behaves exactly as Hourly under the hood
            (server resolves 'trainee' → 'hourly'); the distinct label makes the
            intent obvious on the roster and matches the auto TRAINEE tag. */}
        <option value="trainee">Trainee</option>
      </select>
      {payType !== "" && (
        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <input value={rate} onChange={e => setRate(e.target.value)} placeholder={payType === "fee_split" ? "35" : "20"}
            inputMode="decimal" style={{ width: 56, height: 28, border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: FF, color: "#1A1917", padding: "0 7px", textAlign: "right" }} />
          <span style={{ fontSize: 11, color: "#9E9B94" }}>{unit}</span>
        </div>
      )}
      {payType === "trainee" && (
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "#0A7C66", background: "#E6F7F1", borderRadius: 999, padding: "3px 9px" }}
          title="Trainee: excluded from the commission pool for this job. The other cleaners split the full pool; the trainee is paid this hourly rate on top.">
          Excluded from pool · paid hourly
        </span>
      )}
      {/* [trainee-rate-dropped 2026-08-13] An hourly-basis line with NO stored
          rate pays nothing at all — the engine emits no row for it, so it reads
          as a quiet "—" rather than an obvious zero. Every trainee saved before
          this fix is in exactly that state. Say so on the line, because the
          alternative is an unpaid cleaner nobody notices. Reads the STORED
          rate, not the edit box, so typing a rate doesn't hide the warning
          until it's actually saved. */}
      {RATE_PAY_TYPES.includes(row.pay_type ?? "") && row.hourly_rate == null && (
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "#B3261E", background: "#FCEBEA", borderRadius: 999, padding: "3px 9px" }}
          title="No hourly rate is stored for this line, so it pays $0. Enter the rate and press Save pay.">
          No rate saved · pays $0
        </span>
      )}
      {/* BILLED — shown on EVERY row, whatever the pay type (Sal: need the total
          billed to verify pay, including on commercial/allowed-hours jobs —
          allowed hours alone can't be checked against). "billed $X" = what the
          client was charged for this job.
          [billed-reconcile 2026-07-27] Prefer `row.billed` (the canonical all-in
          invoiced total that INCLUDES the parking fee + every add-on, matching
          the Jobs page). `row.fee` is the fee-split commission base and silently
          drops add-ons — National Able #4357 read $380 here vs $420 on Jobs.
          Fall back to `fee` only for older payloads that predate `billed`. */}
      {(row.billed ?? row.fee) != null && (row.billed ?? row.fee)! > 0 ? (
        <span style={{ fontSize: 11, fontWeight: 700, color: "#1A1917", background: "#F1EEE8", border: "1px solid #E5E2DC", borderRadius: 999, padding: "3px 9px" }}
          title="Total billed to the client for this job (includes add-ons like the parking fee). For fee split: pay = billed × %. For allowed hours: this is the revenue; pay = allowed hours × rate.">
          billed ${(row.billed ?? row.fee)!.toFixed(2)}
        </span>
      ) : (
        <span style={{ fontSize: 11, fontWeight: 700, color: "#B45309", background: "#FDF3E4", borderRadius: 999, padding: "3px 9px" }}
          title="No amount is billed on this job yet — set a price on the job so pay and revenue can be reconciled.">
          no billed amount
        </span>
      )}
      {/* ALLOWED HOURS — shown on EVERY row that carries a budget (all jobs have
          an allowed-hours assignment). For an allowed-hours pay type with NO
          budget, warn that pay falls back to actual clocked hours. */}
      {row.allowed_hours != null && row.allowed_hours > 0 ? (
        <span style={{ fontSize: 11, fontWeight: 700, color: "#0A7C66", background: "#E6F7F1", borderRadius: 999, padding: "3px 9px" }}
          title="The job's allowed-hours budget. For allowed-hours pay: pay = allowed hours × rate. For fee split: drives the efficiency score (allowed ÷ actual).">
          {row.allowed_hours.toFixed(2)} allowed hrs
        </span>
      ) : effectivePayType === "allowed_hours" ? (
        <span style={{ fontSize: 11, fontWeight: 700, color: "#B45309", background: "#FDF3E4", borderRadius: 999, padding: "3px 9px" }}
          title="No allowed-hours budget set on this job — pay falls back to actual clocked hours × rate until a budget is entered.">
          no budget — paying actual
        </span>
      ) : null}
      <span style={{ fontSize: 11, color: "#9E9B94", marginLeft: 4 }}>Breakage −$</span>
      <input value={ded} onChange={e => setDed(e.target.value)} placeholder="0" inputMode="decimal"
        style={{ width: 50, height: 28, border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: FF, color: "#1A1917", padding: "0 7px", textAlign: "right" }} />
      <button onClick={savePay} disabled={busy}
        style={{ fontSize: 11, fontWeight: 700, padding: "5px 9px", borderRadius: 6, border: "1px solid #E5E2DC", cursor: busy ? "default" : "pointer", fontFamily: FF, color: "#0F7A63", background: "#fff", opacity: busy ? 0.6 : 1 }}>
        Save pay
      </button>
      <PayNote row={row} userId={emp.user_id} onChanged={onChanged} toastFn={toastFn} />
      {row.entry_id != null && <ClockHistory entryId={row.entry_id} />}
    </div>
  );
}

// [pay-note 2026-08-12] Why this line was paid the way it was, in the office's
// own words — "paid for trainees", "$30/hr on this one", "extra hour because
// Alma forgot to clock out".
//
// Deliberately NOT a box under every job. Sal: "when there is one it does not
// need to be static." A row with no note shows only a faint "+ note"; a row
// WITH one shows the note as a chip you hover to read in full, with who wrote
// it and when. So a screen full of rows stays as quiet as it is today, and the
// rows carrying an explanation are the ones that stand out.
function PayNote({ row, userId, onChanged, toastFn }: {
  row: Row; userId: number; onChanged: () => void; toastFn: (t: { title: string }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(row.pay_note ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setVal(row.pay_note ?? ""); }, [row.pay_note]);

  async function save() {
    setBusy(true);
    try {
      const r = await api(`/api/timeclock/office/job/${row.job_id}/tech/${userId}/pay-note`, {
        method: "PUT", body: JSON.stringify({ pay_note: val }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Failed");
      setEditing(false);
      onChanged();
      toastFn({ title: val.trim() ? "Note saved" : "Note cleared" });
    } catch (e: any) { toastFn({ title: e.message || "Could not save the note" }); }
    finally { setBusy(false); }
  }

  if (editing) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        <input
          value={val} onChange={e => setVal(e.target.value)} autoFocus
          onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") { setVal(row.pay_note ?? ""); setEditing(false); } }}
          placeholder="Why this pay? e.g. paid for trainees"
          style={{ width: 230, height: 28, border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: FF, color: "#1A1917", padding: "0 8px" }} />
        <button onClick={save} disabled={busy}
          style={{ fontSize: 11, fontWeight: 700, padding: "5px 9px", borderRadius: 6, border: "none", cursor: busy ? "default" : "pointer", fontFamily: FF, color: "#fff", background: "var(--brand)", opacity: busy ? 0.6 : 1 }}>
          {busy ? "…" : "Save"}
        </button>
        <button onClick={() => { setVal(row.pay_note ?? ""); setEditing(false); }}
          style={{ fontSize: 11, fontWeight: 600, padding: "5px 7px", borderRadius: 6, border: "1px solid #E5E2DC", cursor: "pointer", fontFamily: FF, color: "#6B6860", background: "#fff" }}>
          Cancel
        </button>
      </span>
    );
  }

  if (!row.pay_note) {
    return (
      <button onClick={() => setEditing(true)} title="Add a note explaining this pay line"
        style={{ fontSize: 11, fontWeight: 600, padding: "5px 8px", borderRadius: 6, border: "1px dashed #E5E2DC", cursor: "pointer", fontFamily: FF, color: "#9E9B94", background: "transparent" }}>
        + note
      </button>
    );
  }

  const when = row.pay_note_at
    ? new Date(row.pay_note_at).toLocaleString("en-US", { timeZone: companyTz(), month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  const hover = [row.pay_note, [row.pay_note_by_name, when].filter(Boolean).join(" · ")].filter(Boolean).join("\n");
  return (
    <button onClick={() => setEditing(true)} title={hover}
      style={{ maxWidth: 260, display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, padding: "4px 9px", borderRadius: 999, border: "1px solid #F2DFB8", cursor: "pointer", fontFamily: FF, color: "#8A5A00", background: "#FDF9F0" }}>
      <MessageSquare size={11} style={{ flexShrink: 0 }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.pay_note}</span>
    </button>
  );
}

// [clock-history-timeclock 2026-08-12] Maribel asked for the change history
// "on the job card AND on Time Clock, so we know what changes are being made."
// The job card got it first (#1405); this is the second surface, reading the
// same endpoint. Loaded on click — most rows are never asked about.
function ClockHistory({ entryId }: { entryId: number }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (data) return;
    setLoading(true);
    try {
      const r = await api(`/api/timeclock/${entryId}/history`);
      const d = await r.json().catch(() => null);
      setData(r.ok && d ? d : { events: [], error: d?.error || "Could not load history" });
    } catch { setData({ events: [], error: "Could not load history" }); }
    finally { setLoading(false); }
  }

  const t12 = (v: any) => v ? new Date(v).toLocaleTimeString("en-US", { timeZone: companyTz(), hour: "numeric", minute: "2-digit" }) : "—";
  const line = (ev: any) => {
    if (ev.kind === "created") return ev.detail;
    if (ev.kind === "office_in") return `Clocked in from the office at ${t12(ev.new_value?.clock_in_at)}`;
    if (ev.kind === "office_out") return `Clocked out from the office at ${t12(ev.new_value?.clock_out_at)}`;
    if (ev.kind === "deleted") return "Entry deleted";
    const parts: string[] = [];
    if (String(ev.old_value?.clock_in_at ?? "") !== String(ev.new_value?.clock_in_at ?? "")) parts.push(`in ${t12(ev.old_value?.clock_in_at)} → ${t12(ev.new_value?.clock_in_at)}`);
    if (String(ev.old_value?.clock_out_at ?? "") !== String(ev.new_value?.clock_out_at ?? "")) parts.push(`out ${t12(ev.old_value?.clock_out_at)} → ${t12(ev.new_value?.clock_out_at)}`);
    return parts.length ? `Times changed — ${parts.join(", ")}` : "Times edited";
  };

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button onClick={toggle} title="Who entered or changed these times"
        style={{ fontSize: 11, fontWeight: 600, padding: "5px 8px", borderRadius: 6, border: "1px solid #E5E2DC", cursor: "pointer", fontFamily: FF, color: "#6B6860", background: "#fff" }}>
        {open ? "Hide history" : "History"}
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 40, minWidth: 280, maxWidth: 360, background: "#fff", border: "1px solid #E5E2DC", borderRadius: 8, boxShadow: "0 10px 30px rgba(10,14,26,0.14)", padding: "10px 12px" }}>
          {loading && !data ? (
            <div style={{ fontSize: 11, color: "#9E9B94" }}>Loading…</div>
          ) : data?.error ? (
            <div style={{ fontSize: 11, color: "#B3261E" }}>{data.error}</div>
          ) : (data?.events ?? []).length === 0 ? (
            <div style={{ fontSize: 11, color: "#9E9B94" }}>No recorded changes.</div>
          ) : (
            (data.events as any[]).map((ev, i) => (
              <div key={i} style={{ fontSize: 11.5, color: "#1A1917", padding: "4px 0", borderTop: i === 0 ? "none" : "1px solid #F0EEE9" }}>
                {line(ev)}
                <div style={{ fontSize: 10.5, color: "#9E9B94", marginTop: 1 }}>
                  {ev.at ? new Date(ev.at).toLocaleString("en-US", { timeZone: companyTz(), month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}
                  {ev.actor_name ? ` · ${ev.actor_name}` : ""}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </span>
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
        if (!r.ok) throw new Error(errText(d));
        entryId = d.id;
        if (parsedOut) {
          const r2 = await api(`/api/timeclock/${entryId}`, { method: "PATCH", body: JSON.stringify({ clock_out_at: hhmmToISO(dateStr, parsedOut) }) });
          if (!r2.ok) { const e = await r2.json().catch(() => ({})); throw new Error(errText(e)); }
        }
      } else {
        const body: any = {};
        if (parsedIn) body.clock_in_at = hhmmToISO(dateStr, parsedIn);
        body.clock_out_at = parsedOut ? hhmmToISO(dateStr, parsedOut) : null;
        const r = await api(`/api/timeclock/${entryId}`, { method: "PATCH", body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(errText(d));
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
      if (!r.ok) throw new Error(errText(await r.json().catch(() => ({})), "Delete failed"));
      onChanged();
    } catch (e: any) { toastFn({ title: e?.message || "Delete failed" }); } finally { setBusy(false); }
  }

  return (
    // A duplicate punch is tinted and inset so it reads as hanging off the row
    // above rather than as another job — the office should see one job with two
    // clocks, not two jobs.
    <div style={{ borderTop: "1px solid #F4F3F0", background: row.duplicate ? "#FDF6F5" : undefined, borderLeft: row.duplicate ? "3px solid #E9C3BF" : undefined }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px 4px 14px" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Client/account name links to the profile (residential → customer,
            commercial → account), like MaidCentral. Falls back to plain text
            when neither id is present. */}
        <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.account_id ? (
            <Link href={`/accounts/${row.account_id}`} onClick={e => e.stopPropagation()} style={{ color: "#1A1917", textDecoration: "none" }}><span style={{ borderBottom: "1px solid #D4D1CB" }}>{row.client_name}</span></Link>
          ) : row.client_id ? (
            <Link href={`/customers/${row.client_id}`} onClick={e => e.stopPropagation()} style={{ color: "#1A1917", textDecoration: "none" }}><span style={{ borderBottom: "1px solid #D4D1CB" }}>{row.client_name}</span></Link>
          ) : row.client_name}
        </div>
        {row.address && (
          <div style={{ fontSize: 11, color: "#9E9B94", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.address}</div>
        )}
        <div style={{ fontSize: 11, color: "#9E9B94" }}>
          {fmtSvc(row.service_type)}{row.scheduled_time ? ` · sched ${fmtSchedWindow(row.scheduled_time, row.allowed_hours ?? row.estimated_hours)}` : ""}
          {!row.entry_id && <span style={{ color: "#9E9B94", marginLeft: 6, fontWeight: 700 }}>· not clocked in</span>}
          {row.orphan_reason && <span title="This job isn't on today's schedule — the row is here only so the open clock can be closed." style={{ color: "#B45309", marginLeft: 6, fontWeight: 700 }}>· {row.orphan_reason}</span>}
          {row.duplicate && <span title="This job+tech has more than one time entry. The row above carries the day's hours and pay; this one counts for nothing until you reconcile it. Close it or delete it." style={{ color: "#B3261E", marginLeft: 6, fontWeight: 700 }}>· {row.duplicate_reason || "extra punch"}</span>}
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
          {/* Clock-out location, mirroring the clock-in pill — the office needs
              to see WHERE the tech punched out (on-site vs at home). Only when
              the clock-out punch carried coordinates. */}
          {row.entry_id && row.clock_out_at && row.gps_out_lat != null && row.gps_out_lng != null && (() => {
            const lat = row.gps_out_lat!, lng = row.gps_out_lng!;
            const label = `out ${row.gps_out_ft != null ? `${row.gps_out_ft} ft` : "GPS"}${row.gps_out_outside ? " (outside zone)" : ""}`;
            const color = row.gps_out_outside ? "#B45309" : "#0A7C66";
            const tip = `Clock-out location: ${lat.toFixed(5)}, ${lng.toFixed(5)}${row.gps_out_ft != null ? ` · ${row.gps_out_ft} ft from job` : " · job not geocoded, distance unavailable"}. Tap to see it on the map.`;
            return (
              <button type="button" title={tip} onClick={e => { e.stopPropagation(); setGpsOpen(true); }}
                style={{ marginLeft: 6, fontWeight: 700, color, textDecoration: "underline", background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit" }}>
                · {label} ▸
              </button>
            );
          })()}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 10, color: "#9E9B94", fontWeight: 700 }}>IN</span>
        <input type="text" inputMode="text" placeholder="—:—" aria-label="Clock in"
          value={inVal} onChange={e => setInVal(e.target.value)}
          onBlur={() => { const p = parseTimeInput(inVal); if (p) setInVal(hh24ToDisplay(p)); }}
          style={{ ...inputStyle, borderColor: inInvalid ? "#B3261E" : inEmpty ? "#ECEAE5" : "#E5E2DC", background: inEmpty ? "#F7F6F3" : "#fff" }} />
        <span style={{ fontSize: 10, color: "#9E9B94", fontWeight: 700, marginLeft: 4 }}>OUT</span>
        <input type="text" inputMode="text" placeholder="—:—" aria-label="Clock out"
          value={outVal} onChange={e => setOutVal(e.target.value)}
          onBlur={() => { const p = parseTimeInput(outVal); if (p) setOutVal(hh24ToDisplay(p)); }}
          style={{ ...inputStyle, borderColor: outInvalid ? "#B3261E" : outEmpty ? "#ECEAE5" : "#E5E2DC", background: outEmpty ? "#F7F6F3" : "#fff" }} />
      </div>
      <div style={{ width: 66, textAlign: "right", color: liveMins != null ? "#1A1917" : "#C4C0BB" }}>
        <div style={{ fontSize: 12, fontWeight: 700 }}>{liveMins != null ? fmtHrs(liveMins) : (parsedIn && !parsedOut ? "open" : "—")}</div>
        {liveMins != null && <div style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94" }}>{fmtHrsDec(liveMins)}</div>}
      </div>
      <div style={{ width: 70, textAlign: "right", fontSize: 13, fontWeight: 800, color: row.pay_kind === "cancellation" ? "#B45309" : (row.pay != null && row.pay > 0 ? "#0A7C66" : "#C4C0BB") }}
        title={row.pay_kind === "cancellation"
          ? `${row.cancel_action === "lockout" ? "Lockout" : "Cancellation"} fee paid to this tech (not commission)`
          : "Commission for this timesheet (same engine as Payroll)"}>
        {row.pay != null ? `$${row.pay.toFixed(2)}` : "—"}
      </div>
      <button onClick={save} disabled={busy || !dirty}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 700, padding: "6px 10px", borderRadius: 6, border: "none", cursor: busy || !dirty ? "default" : "pointer", fontFamily: FF, color: "#fff", background: dirty ? "#0F7A63" : "#D4D1CB", opacity: busy ? 0.6 : 1 }}>
        <Check size={12} /> Save
      </button>
      <button onClick={del} disabled={busy || !row.entry_id} title="Delete punch"
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 6, border: "1px solid #F3D2D2", background: row.entry_id ? "#FCEBEA" : "#F7F6F3", color: row.entry_id ? "#B3261E" : "#D4D1CB", cursor: row.entry_id && !busy ? "pointer" : "default" }}>
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

// [clock-tz-backfill 2026-06-17] Owner tool: preview + apply the one-time
// UTC→Central shift for field punches recorded before the wall-clock fix.
// Preview is read-only; Apply only runs after the owner reviews the before→after.
type TzRow = { id: number; tech: string; in_before: string; in_after: string; out_before: string | null; out_after: string | null; mixed: boolean };
function ClockTzFixModal({ onClose, onApplied, toastFn }: { onClose: () => void; onApplied: () => void; toastFn: (t: { title: string }) => void }) {
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 60); return ymd(d); });
  const [to, setTo] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 1); return ymd(d); });
  const [preview, setPreview] = useState<{ convertible: TzRow[]; mixed: TzRow[]; counts: { total: number; convertible: number; mixed: number } } | null>(null);
  const [busy, setBusy] = useState(false);

  async function runPreview() {
    setBusy(true); setPreview(null);
    try {
      const r = await api(`/api/timeclock/tz-audit?from=${from}&to=${to}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Preview failed");
      setPreview(d);
    } catch (e: any) { toastFn({ title: e.message || "Preview failed" }); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview || preview.counts.convertible === 0) return;
    setBusy(true);
    try {
      const r = await api(`/api/timeclock/tz-backfill`, { method: "POST", body: JSON.stringify({ from, to }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Apply failed");
      toastFn({ title: `Fixed ${d.converted} clock entr${d.converted === 1 ? "y" : "ies"}` });
      onApplied(); onClose();
    } catch (e: any) { toastFn({ title: e.message || "Apply failed" }); }
    finally { setBusy(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(10,14,26,0.5)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: FF }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, padding: 20, width: 640, maxWidth: "100%", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 24px 70px rgba(10,14,26,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: "#0A0E1A" }}>Fix past clock times</h3>
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: 0, fontSize: 22, color: "#9E9B94", cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "#6B6860", lineHeight: 1.5 }}>
          Field punches recorded before the timezone fix were saved 5 hours ahead. Pick a date range, <b>Preview</b> the change, then <b>Apply</b>. Office-typed times are left alone. Entries with a field clock-in but an office clock-out are flagged for manual review.
        </p>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 14, flexWrap: "wrap" }}>
          <div><div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>From</div><CalendarPopover value={from} onChange={v => v && setFrom(v)} ariaLabel="From date" /></div>
          <div><div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>To</div><CalendarPopover value={to} onChange={v => v && setTo(v)} ariaLabel="To date" /></div>
          <button onClick={runPreview} disabled={busy} style={{ border: "1px solid #0F7A63", background: "#fff", color: "#0F7A63", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: busy ? "wait" : "pointer", fontFamily: FF }}>{busy ? "…" : "Preview"}</button>
        </div>

        {preview && (
          <>
            <div style={{ fontSize: 13, color: "#1A1917", marginBottom: 10 }}>
              <b>{preview.counts.convertible}</b> entr{preview.counts.convertible === 1 ? "y" : "ies"} will be corrected{preview.counts.mixed > 0 ? <> · <span style={{ color: "#B45309" }}>{preview.counts.mixed} need manual review</span></> : null}.
            </div>
            {preview.convertible.length > 0 && (
              <div style={{ border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ background: "#F7F6F3", textAlign: "left", color: "#9E9B94" }}>
                    <th style={{ padding: "6px 8px", fontWeight: 700 }}>Tech</th><th style={{ padding: "6px 8px", fontWeight: 700 }}>In</th><th style={{ padding: "6px 8px", fontWeight: 700 }}>Out</th>
                  </tr></thead>
                  <tbody>
                    {preview.convertible.slice(0, 40).map(r => (
                      <tr key={r.id} style={{ borderTop: "1px solid #F4F3F0" }}>
                        <td style={{ padding: "6px 8px" }}>{r.tech}</td>
                        <td style={{ padding: "6px 8px" }}><span style={{ color: "#B3261E" }}>{r.in_before}</span> → <span style={{ color: "#0A7C66", fontWeight: 700 }}>{r.in_after}</span></td>
                        <td style={{ padding: "6px 8px" }}>{r.out_before ? <><span style={{ color: "#B3261E" }}>{r.out_before}</span> → <span style={{ color: "#0A7C66", fontWeight: 700 }}>{r.out_after}</span></> : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.convertible.length > 40 && <div style={{ padding: "6px 8px", fontSize: 11, color: "#9E9B94" }}>…and {preview.convertible.length - 40} more</div>}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button onClick={onClose} disabled={busy} style={{ border: "1px solid #E5E2DC", background: "#fff", color: "#6B6860", borderRadius: 8, padding: "8px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button onClick={apply} disabled={busy || preview.counts.convertible === 0}
                style={{ border: "none", background: preview.counts.convertible === 0 ? "#D4D1CB" : "#0F7A63", color: "#fff", borderRadius: 8, padding: "8px 18px", fontWeight: 700, fontSize: 13, cursor: busy || preview.counts.convertible === 0 ? "default" : "pointer", fontFamily: FF }}>
                {busy ? "Applying…" : `Apply to ${preview.counts.convertible}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// [open-clock-finder 2026-08-13] "There has to be a way for us to know where
// she is clocked in without having to check day by day." — Maribel.
//
// This is that way. The Time Clock screen shows ONE day, so a punch left
// running on a job from last Thursday is invisible here no matter how long you
// stare at today; the only way to find it was to step the date backward until
// it turned up. This strip reads every still-running punch company-wide
// (GET /api/timeclock/open, any date, oldest first) and puts each one a single
// click from being closed: the tech, the house, when the clock started, how
// long it's been running, and a button that jumps the day view to that date so
// the OUT time can be typed on the spot.
//
// It renders only when something is actually open — an empty strip on a clean
// day is noise, and the same rule the Needs Attention strip follows.
//
// Two kinds of open punch, and conflating them would make this strip useless:
// a tech mid-clean at 11 AM is SUPPOSED to be on the clock (that's the roster,
// and painting it amber every single day trains the office to ignore the
// strip), while a punch still running from a job two days ago is the forgotten
// one blocking her next clock-in. Stale rows lead and carry the warning; the
// working-now rows sit below in plain type.
type OpenClock = {
  id: number; user_id: number; user_name: string; job_id: number; job_name: string;
  clock_in_at: string; day: string; open_minutes: number; source: string | null;
};
// "6d 3h" / "5h 20m" / "45m" — how long this clock has been running. Days
// matter more than minutes once a punch is stale, so the units step down.
function fmtOpenFor(min: number) {
  if (min < 60) return `${Math.max(0, min)}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function fmtDayLabel(day: string) {
  const d = new Date(`${day}T00:00:00`);
  if (isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
function OpenClocksBanner({ tick, currentDay, onJump }: { tick: number; currentDay: string; onJump: (day: string) => void }) {
  const [rows, setRows] = useState<OpenClock[] | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api(`/api/timeclock/open`);
        const d = r.ok ? await r.json() : null;
        if (alive) setRows(d?.data ?? []);
      } catch { if (alive) setRows([]); }
    })();
    return () => { alive = false; };
  }, [tick]);

  if (!rows || rows.length === 0) return null;
  // Stale = a punch from a day that isn't today, or one running past 12 hours.
  // Phes runs no overnight shifts, so either way nobody is still cleaning —
  // that clock was forgotten, and it's the one holding the tech's next
  // clock-in hostage.
  const today = dateKey(new Date());
  const isStale = (r: OpenClock) => r.day !== today || r.open_minutes >= 12 * 60;
  const stale = rows.filter(isStale);
  const working = rows.filter(r => !isStale(r));
  const alarm = stale.length > 0;

  const row = (r: OpenClock, bad: boolean) => {
    const here = r.day === currentDay;
    return (
      <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "6px 0", borderTop: `1px solid ${alarm ? "#F3E6D2" : "#F4F3F0"}` }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: "#1A1917" }}>{r.user_name}</span>
        <span style={{ fontSize: 12.5, color: "#6B6860" }}>at <b style={{ color: "#1A1917" }}>{r.job_name}</b></span>
        <span style={{ fontSize: 12, color: "#6B6860" }}>
          in {isoToDisplay(r.clock_in_at) || "—"}{r.day !== today ? ` · ${fmtDayLabel(r.day)}` : ""}
        </span>
        <span style={{ fontSize: 12, fontWeight: 800, color: bad ? "#B3261E" : "#0A7C66" }}>
          {bad ? "open" : "on the clock"} {fmtOpenFor(r.open_minutes)}
        </span>
        <span style={{ flex: 1 }} />
        {here ? (
          <span style={{ fontSize: 11.5, fontWeight: 700, color: "#9E9B94" }}>on this day — set the OUT time below</span>
        ) : (
          <button onClick={() => onJump(r.day)} title={`Open ${fmtDayLabel(r.day)} to close this punch`}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, padding: "5px 10px", borderRadius: 6, border: `1px solid ${bad ? "#E0C9A4" : "#E5E2DC"}`, background: "#fff", color: bad ? "#B45309" : "#6B6860", cursor: "pointer", fontFamily: FF }}>
            <CalendarDays size={12} /> Go to {fmtDayLabel(r.day)}
          </button>
        )}
      </div>
    );
  };

  return (
    <div style={{ background: alarm ? "#FDF3E7" : "#FFFFFF", border: `1px solid ${alarm ? "#F0DDC2" : "#E5E2DC"}`, borderRadius: 12, padding: "11px 14px", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4, flexWrap: "wrap" }}>
        {alarm ? <AlertTriangle size={14} color="#B45309" /> : <Clock size={14} color="#6B6860" />}
        <span style={{ fontSize: 13, fontWeight: 800, color: alarm ? "#B45309" : "#1A1917" }}>
          {alarm
            ? `Left on the clock — ${stale.length} ${stale.length === 1 ? "punch needs" : "punches need"} a clock-out`
            : `On the clock now — ${working.length}`}
        </span>
        <span style={{ fontSize: 11.5, color: alarm ? "#8A6A44" : "#9E9B94" }}>
          {alarm
            ? "Nobody can clock in anywhere else until these are closed."
            : "Everyone currently punched in, across every date."}
        </span>
      </div>
      {stale.map(r => row(r, true))}
      {working.length > 0 && stale.length > 0 && (
        <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em", padding: "9px 0 1px" }}>
          Working now
        </div>
      )}
      {working.map(r => row(r, false))}
    </div>
  );
}

export default function TimeClockPage() {
  const { toast } = useToast();
  // [clock-block-actionable 2026-08-13] Open on a specific day via
  // /time-clock?date=YYYY-MM-DD. The blocked-clock-in banner on the dispatch
  // board links straight here, so the office lands on the day holding the punch
  // instead of stepping the date arrows back nine weeks to reach June 8.
  const [date, setDate] = useState(() => {
    const m = typeof window !== "undefined" && window.location.search.match(/[?&]date=(\d{4}-\d{2}-\d{2})/);
    return m ? new Date(`${m[1]}T00:00:00`) : new Date();
  });
  const [data, setData] = useState<{ date: string; employees: Emp[]; revenue?: number; allowed_hours_total?: number; additional_pay_total?: number; diagnostics?: { jobCount?: number; techRows?: number; clockRows?: number; error?: string } } | null>(null);
  const [loading, setLoading] = useState(true);
  const [tzFixOpen, setTzFixOpen] = useState(false);
  const dk = dateKey(date);
  const isToday = dk === dateKey(new Date());
  // Owner-only TZ backfill tool (decode role from the JWT, same pattern as
  // elsewhere). Non-owners never see the trigger; the endpoint is owner-gated too.
  const isOwner = (() => {
    try { return JSON.parse(atob((getAuthHeaders().Authorization || "").replace("Bearer ", "").split(".")[1])).role === "owner"; }
    catch { return false; }
  })();

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
  // Closing a punch has to clear it from the open-clocks strip too, so every
  // save/delete refreshes both the day and the strip.
  const [openTick, setOpenTick] = useState(0);
  const reload = useCallback(() => { setOpenTick(t => t + 1); return load(); }, [load]);

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
    <DashboardLayout hideTitle>
      <div style={{ fontFamily: FF }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 10 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: "#1A1917", margin: 0 }}>Time Clock</h1>
            <p style={{ fontSize: 13, color: "#6B6860", margin: "4px 0 0" }}>
              Reconcile each tech's in/out — feeds payroll hours and the actual-minutes commission split.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setDate(d => addDays(d, -1))} aria-label="Previous day" style={{ border: "1px solid #E5E2DC", background: "#fff", borderRadius: 8, padding: "7px 9px", cursor: "pointer", color: "#6B6860" }}><ChevronLeft size={16} /></button>
            {/* Calendar jump — chevron CalendarPopover (no native up/down stepper) */}
            <CalendarPopover value={dk} onChange={(v) => { if (v) setDate(new Date(`${v}T00:00:00`)); }} ariaLabel="Jump to date" />
            <button onClick={() => setDate(d => addDays(d, 1))} aria-label="Next day" style={{ border: "1px solid #E5E2DC", background: "#fff", borderRadius: 8, padding: "7px 9px", cursor: "pointer", color: "#6B6860" }}><ChevronRight size={16} /></button>
            {/* Always render the Today button so its slot is reserved — when
                isToday it's hidden but still occupies width, so the date box +
                chevrons don't slide sideways switching today ↔ any other day. */}
            <button onClick={() => setDate(new Date())} aria-hidden={isToday} tabIndex={isToday ? -1 : 0}
              style={{ border: "1px solid #E5E2DC", background: "#fff", borderRadius: 8, padding: "7px 12px", cursor: isToday ? "default" : "pointer", color: "#1A1917", fontSize: 12, fontWeight: 700, fontFamily: FF, visibility: isToday ? "hidden" : "visible" }}>Today</button>
            {isOwner && (
              <button onClick={() => setTzFixOpen(true)} title="One-time fix for field punches recorded before the timezone fix"
                style={{ border: "1px solid #E5E2DC", background: "#fff", borderRadius: 8, padding: "7px 12px", cursor: "pointer", color: "#6B6860", fontSize: 12, fontWeight: 700, fontFamily: FF }}>Fix past clock times</button>
            )}
          </div>
        </div>
        {tzFixOpen && <ClockTzFixModal onClose={() => setTzFixOpen(false)} onApplied={reload} toastFn={toast} />}

        {/* Open punches across ALL dates — the answer to "where is she clocked
            in?" without stepping day by day. Sits above the day summary because
            a running clock blocks that tech's next clock-in everywhere. */}
        <OpenClocksBanner tick={openTick} currentDay={dk}
          onJump={day => setDate(new Date(`${day}T00:00:00`))} />

        {/* Day summary — CSS grid with fixed-size columns so every stat sits in
            an identical cell regardless of its value. A flex row with per-stat
            minWidth still let a stat grow past the floor to fit a wider value
            ($4793.60 vs $2044.00, 50h 24m vs 0m), shoving every following stat
            and shifting columns day to day. Grid tracks are content-independent,
            so placement is static across days at a given width. */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(104px, 1fr))", gap: "14px 20px", padding: "12px 16px", background: "#FFFFFF", border: "0.5px solid #E5E2DC", borderRadius: 12, marginBottom: 14 }}>
          <Stat label="People" value={String(employees.length)} />
          <Stat label="Jobs" value={String(jobCount)} />
          <Stat label="Punched" value={`${totalPunches}/${totalRows}`} accent={totalPunches < totalRows ? "#B45309" : "#0F7A63"} />
          <Stat label="Worked hours" value={fmtHrs(totalWorked)} sub={fmtHrsDec(totalWorked)} />
          <Stat label="Revenue" value={`$${revenue.toFixed(2)}`} />
          <Stat label="Commission" value={`$${totalPay.toFixed(2)}`} accent="#0A7C66" />
          <Stat label="Payroll %" value={payrollPct != null ? `${payrollPct.toFixed(1)}%` : "—"}
            accent={payrollPct == null ? undefined : payrollPct <= 40 ? "#0F7A63" : payrollPct <= 50 ? "#B45309" : "#B3261E"} />
          <Stat label="Efficiency" value={efficiency != null ? `${efficiency.toFixed(0)}%` : "—"}
            accent={efficiency == null ? undefined : efficiency >= 100 ? "#0F7A63" : efficiency >= 85 ? "#B45309" : "#B3261E"} />
        </div>

        {loading && !data ? (
          <div style={{ textAlign: "center", padding: 40, color: "#9E9B94" }}>Loading…</div>
        ) : employees.length === 0 ? (
          <div style={{ textAlign: "center", padding: 48, background: "#fff", border: "0.5px solid #E5E2DC", borderRadius: 12 }}>
            <Clock size={30} color="#D0CEC9" style={{ marginBottom: 10 }} />
            <div style={{ fontSize: 14, fontWeight: 700, color: "#6B6860" }}>No jobs scheduled this day</div>
            <div style={{ fontSize: 12, color: "#9E9B94" }}>Pick another date to reconcile its clocks.</div>
            {data?.diagnostics && (
              <div style={{ marginTop: 12, fontSize: 11, fontFamily: "monospace", color: data.diagnostics.error ? "#B3261E" : "#9E9B94" }}>
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
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 16px", background: "#F7F6F3", borderBottom: "1px solid #EEECE7" }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#1A1917" }}>
                    <Link href={`/employees/${emp.user_id}`} style={{ color: "#1A1917", textDecoration: "none" }}>
                      <span style={{ borderBottom: "1px solid #D4D1CB" }}>{emp.name}</span>
                    </Link>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 12, color: "#6B6860" }}>
                    {emp.day_start && <span>{fmtClock(emp.day_start)} – {emp.open ? "on clock" : fmtClock(emp.day_end)}</span>}
                    <span style={{ color: punched < emp.rows.length ? "#B45309" : "#0F7A63", fontWeight: 700 }}>{punched}/{emp.rows.length} punched</span>
                    <span style={{ fontWeight: 800, color: "#1A1917" }}>{fmtHrs(emp.worked_minutes)} <span style={{ fontWeight: 600, color: "#9E9B94" }}>· {fmtHrsDec(emp.worked_minutes)}</span></span>
                    {emp.pay_total != null && <span style={{ fontWeight: 800, color: "#0A7C66" }}>${emp.pay_total.toFixed(2)}</span>}
                  </div>
                </div>
                {emp.rows.map(row => (
                  <RowEditor key={`${row.job_id}:${emp.user_id}:${row.entry_id ?? "new"}`} emp={emp} row={row} dateStr={dk} onChanged={reload} toastFn={toast} />
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

function Stat({ label, value, accent, sub }: { label: string; value: string; accent?: string; sub?: string }) {
  // The parent grid owns the column width (fixed, content-independent), so each
  // metric always lands in the same place day to day. minWidth:0 lets the cell
  // be governed by the grid track rather than the stat's own content width.
  // `sub` is an optional secondary line (e.g. the decimal-hours form under the
  // standard h/m worked total).
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: accent ?? "#1A1917", marginTop: 2, whiteSpace: "nowrap" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", whiteSpace: "nowrap" }}>{sub}</div>}
    </div>
  );
}
