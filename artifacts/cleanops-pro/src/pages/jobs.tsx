import { useState, useEffect, useRef, useCallback } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders, useAuthStore } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { JobWizard } from "@/components/job-wizard";
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable, type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import {
  ChevronLeft, ChevronRight, Plus, Clock, Camera, X, MapPin, User,
  DollarSign, CheckCircle, AlertCircle, LayoutGrid, List, Calendar,
} from "lucide-react";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const FF = "'Plus Jakarta Sans', sans-serif";
const SLOT_W = 80;
const COL_W = 220;
const ROW_H = 84;
const DAY_START = 7 * 60;
const DAY_END = 20 * 60;
const TOTAL_SLOTS = (DAY_END - DAY_START) / 30;

const STATUS: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  scheduled:   { bg: "#DBEAFE", border: "#93C5FD", text: "#1D4ED8", dot: "#3B82F6" },
  in_progress: { bg: "#FEF3C7", border: "#FCD34D", text: "#92400E", dot: "#F59E0B" },
  complete:    { bg: "#DCFCE7", border: "#86EFAC", text: "#15803D", dot: "#22C55E" },
  cancelled:   { bg: "#F3F4F6", border: "#D1D5DB", text: "#6B7280", dot: "#9CA3AF" },
  flagged:     { bg: "#FEE2E2", border: "#FCA5A5", text: "#991B1B", dot: "#EF4444" },
};

const TIMES = Array.from({ length: TOTAL_SLOTS }, (_, i) => {
  const mins = DAY_START + i * 30;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
});

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface ClockEntry { id: number; clock_in_at: string | null; clock_out_at: string | null; distance_from_job_ft: number | null; is_flagged: boolean; }
interface DispatchJob { id: number; client_id: number; client_name: string; address: string | null; assigned_user_id: number | null; assigned_user_name?: string; service_type: string; status: string; scheduled_date: string; scheduled_time: string | null; frequency: string; amount: number; duration_minutes: number; notes: string | null; before_photo_count: number; after_photo_count: number; clock_entry: ClockEntry | null; zone_id?: number | null; zone_color?: string | null; zone_name?: string | null; }
interface Employee { id: number; name: string; role: string; jobs: DispatchJob[]; zone?: { zone_id: number; zone_color: string; zone_name: string } | null; }
interface DispatchData { employees: Employee[]; unassigned_jobs: DispatchJob[]; }

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const dateKey = (d: Date) => d.toISOString().split("T")[0];
const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const timeToMins = (t: string | null) => { if (!t) return DAY_START; const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); };
const minsToStr = (mins: number) => { const c = Math.max(DAY_START, Math.min(DAY_END - 30, mins)); return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}:00`; };
function fmtTime(t: string | null): string {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  return `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${String(m || 0).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
function fmtSvc(s: string) { return s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()); }
function useIsMobile() { const [m, setM] = useState(window.innerWidth < 1024); useEffect(() => { const h = () => setM(window.innerWidth < 1024); window.addEventListener("resize", h); return () => window.removeEventListener("resize", h); }, []); return m; }

async function patchJob(id: number, patch: object, token: string) {
  const API = (window as any).__API_BASE__ || "";
  const r = await fetch(`${API}/api/jobs/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(patch) });
  if (!r.ok) throw new Error("Failed");
}

async function fetchDispatch(date: string, token: string): Promise<DispatchData> {
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");
  const r = await fetch(`${API}/api/dispatch?date=${date}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error("Failed to load dispatch");
  return r.json();
}

// ─── JOB DETAIL PANEL ────────────────────────────────────────────────────────
function JobPanel({ job, employees, onClose, onUpdate, mobile }: {
  job: DispatchJob; employees: Employee[]; onClose: () => void; onUpdate: () => void; mobile: boolean;
}) {
  const token = useAuthStore(s => s.token)!;
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const sc = STATUS[job.status] || STATUS.scheduled;
  const assignedEmp = employees.find(e => e.id === job.assigned_user_id);
  const endMins = timeToMins(job.scheduled_time) + job.duration_minutes;

  async function setStatus(s: string) {
    setBusy(true);
    try { await patchJob(job.id, { status: s }, token); toast({ title: `Job marked ${s.replace("_", " ")}` }); onUpdate(); onClose(); }
    catch { toast({ title: "Error", variant: "destructive" }); }
    finally { setBusy(false); }
  }

  const panelStyle: React.CSSProperties = mobile ? {
    position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 200,
    backgroundColor: "#FFFFFF", borderRadius: "20px 20px 0 0",
    boxShadow: "0 -8px 40px rgba(0,0,0,0.15)",
    maxHeight: "85vh", display: "flex", flexDirection: "column", fontFamily: FF,
  } : {
    position: "fixed", top: 0, right: 0, bottom: 0, width: 380, zIndex: 50,
    backgroundColor: "#FFFFFF", borderLeft: "1px solid #E5E2DC",
    boxShadow: "-4px 0 24px rgba(0,0,0,0.08)",
    display: "flex", flexDirection: "column", fontFamily: FF,
  };

  return (
    <>
      {mobile && <div onClick={onClose} style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)", zIndex: 199 }} />}
      <div style={panelStyle}>
        {mobile && <div style={{ width: 40, height: 4, backgroundColor: "#E5E2DC", borderRadius: 2, margin: "12px auto 0" }} />}
        <div style={{ padding: "16px 20px 14px", borderBottom: "1px solid #EEECE7", flexShrink: 0, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: "#1A1917" }}>{job.client_name}</h2>
            <span style={{ display: "inline-block", marginTop: 5, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", padding: "2px 8px", borderRadius: 4, backgroundColor: "var(--brand-dim)", color: "var(--brand)" }}>{fmtSvc(job.service_type)}</span>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 20, backgroundColor: sc.bg, border: `1px solid ${sc.border}`, marginBottom: 16 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: sc.dot }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: sc.text, textTransform: "capitalize" }}>{job.status.replace("_", " ")}</span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
            <IR icon={<Clock size={14} />} label={`${fmtTime(job.scheduled_time)} – ${fmtTime(minsToStr(endMins))}`} />
            {job.address && <IR icon={<MapPin size={14} />} label={job.address} />}
            {(assignedEmp || job.assigned_user_name) && <IR icon={<User size={14} />} label={assignedEmp?.name || job.assigned_user_name || ""} />}
            <IR icon={<DollarSign size={14} />} label={`$${(job.amount || 0).toFixed(2)}`} bold />
          </div>

          {job.notes && (
            <PS label="Notes"><p style={{ margin: 0, fontSize: 13, color: "#6B7280", lineHeight: 1.6 }}>{job.notes}</p></PS>
          )}

          {job.clock_entry && (
            <PS label="Clock Data">
              {job.clock_entry.clock_in_at && <KV label="Clock in" value={new Date(job.clock_entry.clock_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} />}
              {job.clock_entry.clock_out_at && <KV label="Clock out" value={new Date(job.clock_entry.clock_out_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} />}
              {job.clock_entry.distance_from_job_ft !== null && (
                <KV label="Distance at clock-in" value={`${Math.round(job.clock_entry.distance_from_job_ft)} ft${job.clock_entry.is_flagged ? " (flagged)" : ""}`} color={job.clock_entry.is_flagged ? "#EF4444" : undefined} />
              )}
            </PS>
          )}

          {(job.before_photo_count > 0 || job.after_photo_count > 0) && (
            <PS label="Photos">
              <div style={{ display: "flex", gap: 8 }}>
                {job.before_photo_count > 0 && <PBadge count={job.before_photo_count} label="before" color="#0284C7" bg="#F0F9FF" border="#BAE6FD" />}
                {job.after_photo_count > 0 && <PBadge count={job.after_photo_count} label="after" color="#16A34A" bg="#F0FDF4" border="#BBF7D0" />}
              </div>
            </PS>
          )}
        </div>

        <div style={{ padding: "12px 20px 20px", borderTop: "1px solid #EEECE7", display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
          {job.status !== "complete" && (
            <button onClick={() => setStatus("complete")} disabled={busy}
              style={{ flex: 1, minWidth: 100, padding: "10px 12px", border: "none", borderRadius: 8, backgroundColor: "#22C55E", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
              {busy ? "..." : "Mark Complete"}
            </button>
          )}
          {job.status !== "in_progress" && job.status !== "complete" && (
            <button onClick={() => setStatus("in_progress")} disabled={busy}
              style={{ flex: 1, minWidth: 100, padding: "10px 12px", border: "1px solid #FCD34D", borderRadius: 8, backgroundColor: "#FEF3C7", color: "#92400E", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
              Start Job
            </button>
          )}
          {job.status !== "flagged" && job.status !== "complete" && (
            <button onClick={() => setStatus("flagged")} disabled={busy}
              style={{ padding: "10px 12px", border: "1px solid #FCA5A5", borderRadius: 8, backgroundColor: "#FEE2E2", color: "#991B1B", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
              Flag
            </button>
          )}
        </div>
      </div>
    </>
  );
}
function IR({ icon, label, bold }: { icon: React.ReactNode; label: string; bold?: boolean }) {
  return <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}><span style={{ color: "#9E9B94", flexShrink: 0, marginTop: 1 }}>{icon}</span><span style={{ fontSize: 13, color: "#1A1917", fontWeight: bold ? 700 : 400, lineHeight: 1.5 }}>{label}</span></div>;
}
function PS({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ marginBottom: 16 }}><div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#9E9B94", marginBottom: 8 }}>{label}</div>{children}</div>;
}
function KV({ label, value, color }: { label: string; value: string; color?: string }) {
  return <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}><span style={{ color: "#6B7280" }}>{label}</span><span style={{ color: color || "#1A1917", fontWeight: 600 }}>{value}</span></div>;
}
function PBadge({ count, label, color, bg, border }: { count: number; label: string; color: string; bg: string; border: string }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 6, backgroundColor: bg, border: `1px solid ${border}` }}><Camera size={12} style={{ color }} /><span style={{ fontSize: 11, color, fontWeight: 600 }}>{count} {label}</span></div>;
}

// ─── MOBILE JOB CARD ──────────────────────────────────────────────────────────
function MobileJobCard({ job, onClick }: { job: DispatchJob; onClick: () => void }) {
  const sc = STATUS[job.status] || STATUS.scheduled;
  return (
    <div onClick={onClick} style={{
      backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12,
      padding: "14px 16px", marginBottom: 10, cursor: "pointer",
      borderLeft: `4px solid ${sc.dot}`, fontFamily: FF,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#1A1917", marginBottom: 2 }}>{job.client_name}</div>
          <div style={{ fontSize: 12, color: "var(--brand)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>{fmtSvc(job.service_type)}</div>
        </div>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 20, backgroundColor: sc.bg, border: `1px solid ${sc.border}`, fontSize: 11, fontWeight: 700, color: sc.text, textTransform: "capitalize", flexShrink: 0, marginLeft: 10 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: sc.dot }} />
          {job.status.replace("_", " ")}
        </span>
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {job.scheduled_time && (
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#6B7280" }}>
            <Clock size={12} style={{ color: "#9E9B94" }} />
            {fmtTime(job.scheduled_time)}
            <span style={{ color: "#C4C0BB" }}>·</span>
            {Math.floor(job.duration_minutes / 60)}h{job.duration_minutes % 60 > 0 ? ` ${job.duration_minutes % 60}m` : ""}
          </div>
        )}
        {job.address && (
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#6B7280", flex: 1, minWidth: 0 }}>
            <MapPin size={12} style={{ color: "#9E9B94", flexShrink: 0 }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{job.address}</span>
          </div>
        )}
      </div>
      {(job.assigned_user_name || job.clock_entry?.clock_in_at) && (
        <div style={{ display: "flex", gap: 12, marginTop: 8, alignItems: "center" }}>
          {job.assigned_user_name && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#6B7280" }}>
              <User size={12} style={{ color: "#9E9B94" }} />
              {job.assigned_user_name}
            </div>
          )}
          {job.clock_entry?.clock_in_at && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#16A34A", fontWeight: 600 }}>
              <Clock size={11} />
              Clocked in {new Date(job.clock_entry.clock_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </div>
          )}
        </div>
      )}
      {(job.before_photo_count > 0 || job.after_photo_count > 0) && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          {job.before_photo_count > 0 && <span style={{ fontSize: 11, color: "#0284C7", fontWeight: 600 }}><Camera size={10} style={{ display: "inline", marginRight: 3 }} />{job.before_photo_count} before</span>}
          {job.after_photo_count > 0 && <span style={{ fontSize: 11, color: "#16A34A", fontWeight: 600 }}><Camera size={10} style={{ display: "inline", marginRight: 3 }} />{job.after_photo_count} after</span>}
        </div>
      )}
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #F0EEE9", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: "#1A1917" }}>${(job.amount || 0).toFixed(2)}</span>
        <span style={{ fontSize: 11, color: "#9E9B94" }}>Tap to view &rarr;</span>
      </div>
    </div>
  );
}

// ─── MINI CALENDAR ─────────────────────────────────────────────────────────────
function MiniCalendar({ value, onChange, jobDates }: { value: Date; onChange: (d: Date) => void; jobDates: Set<string> }) {
  const [month, setMonth] = useState(new Date(value.getFullYear(), value.getMonth(), 1));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const firstDow = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  return (
    <div style={{ padding: "14px 12px 10px", fontFamily: FF }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} style={{ border: "none", background: "none", cursor: "pointer", color: "#9E9B94", display: "flex", padding: 4 }}><ChevronLeft size={13} /></button>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#1A1917" }}>{month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
        <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} style={{ border: "none", background: "none", cursor: "pointer", color: "#9E9B94", display: "flex", padding: 4 }}><ChevronRight size={13} /></button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>
        {["Su","Mo","Tu","We","Th","Fr","Sa"].map(d => <div key={d} style={{ textAlign: "center", fontSize: 10, color: "#9E9B94", fontWeight: 700, paddingBottom: 4 }}>{d}</div>)}
        {Array.from({ length: firstDow }).map((_, i) => <div key={`_${i}`} />)}
        {Array.from({ length: days }, (_, i) => i + 1).map(day => {
          const d = new Date(month.getFullYear(), month.getMonth(), day);
          const k = dateKey(d);
          const sel = k === dateKey(value), isT = k === dateKey(today), hasJ = jobDates.has(k);
          return (
            <button key={day} onClick={() => onChange(d)} style={{ border: "none", cursor: "pointer", borderRadius: 6, padding: "4px 0", display: "flex", flexDirection: "column", alignItems: "center", background: sel ? "var(--brand)" : isT ? "var(--brand-dim)" : "none" }}>
              <span style={{ fontSize: 12, fontWeight: sel || isT ? 700 : 400, color: sel ? "#fff" : isT ? "var(--brand)" : "#1A1917" }}>{day}</span>
              {hasJ && <div style={{ width: 4, height: 4, borderRadius: "50%", backgroundColor: sel ? "#fff" : "var(--brand)", marginTop: 1 }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── DESKTOP: JOB CHIP ─────────────────────────────────────────────────────────
function JobChip({ job, onClick }: { job: DispatchJob; onClick: (j: DispatchJob) => void }) {
  const sc = STATUS[job.status] || STATUS.scheduled;
  const left = ((timeToMins(job.scheduled_time) - DAY_START) / 30) * SLOT_W;
  const width = Math.max(SLOT_W, (job.duration_minutes / 30) * SLOT_W);
  const isComplete = job.status === "complete";
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `chip-${job.id}`, data: { job, originalLeft: left }, disabled: isComplete });
  const borderColor = job.zone_color || sc.dot;
  return (
    <div ref={setNodeRef} onClick={e => { e.stopPropagation(); onClick(job); }} {...(isComplete ? {} : { ...listeners, ...attributes })}
      title={job.zone_name ? job.zone_name : undefined}
      style={{ position: "absolute", top: 10, left, width, height: ROW_H - 20, borderRadius: 8, backgroundColor: sc.bg, borderLeft: `3px solid ${borderColor}`, padding: "6px 8px", boxSizing: "border-box", overflow: "hidden", cursor: isComplete ? "default" : isDragging ? "grabbing" : "grab", opacity: isDragging ? 0.3 : 1, transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined, zIndex: isDragging ? 0 : 2, userSelect: "none", display: "flex", flexDirection: "column", justifyContent: "center", gap: 2, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
        {job.clock_entry?.clock_in_at && <Clock size={9} style={{ color: sc.dot, flexShrink: 0 }} />}
        {job.after_photo_count > 0 && <Camera size={9} style={{ color: sc.dot, flexShrink: 0 }} />}
        <span style={{ fontSize: 11, fontWeight: 700, color: "#1A1917", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{job.client_name}</span>
      </div>
      <span style={{ fontSize: 10, color: "#6B7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fmtSvc(job.service_type)}</span>
      {width > 130 && <span style={{ fontSize: 9, color: "#9E9B94" }}>{fmtTime(job.scheduled_time)} – {fmtTime(minsToStr(timeToMins(job.scheduled_time) + job.duration_minutes))}</span>}
    </div>
  );
}

// ─── DESKTOP: EMPLOYEE ROW ────────────────────────────────────────────────────
function EmployeeRow({ employee, onChipClick, nowLine }: { employee: Employee; onChipClick: (j: DispatchJob) => void; nowLine: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: `row-${employee.id}` });
  const initials = employee.name.split(" ").map((p: string) => p[0]).join("").toUpperCase().slice(0, 2);
  const totalMins = employee.jobs.reduce((s: number, j: DispatchJob) => s + j.duration_minutes, 0);
  const revenue = employee.jobs.reduce((s: number, j: DispatchJob) => s + (j.amount || 0), 0);
  return (
    <div style={{ display: "flex", borderBottom: "1px solid #EEECE7", height: ROW_H }}>
      <div style={{ position: "sticky", left: 0, zIndex: 5, width: COL_W, flexShrink: 0, backgroundColor: "#FFFFFF", borderRight: "1px solid #E5E2DC", display: "flex", alignItems: "center", padding: "0 14px", gap: 10 }}>
        <div style={{ width: 34, height: 34, borderRadius: "50%", flexShrink: 0, backgroundColor: "var(--brand-dim)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800 }}>{initials}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: 5 }}>
            {employee.name}
            {employee.zone && <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: employee.zone.zone_color, flexShrink: 0 }} title={employee.zone.zone_name} />}
          </div>
          <div style={{ fontSize: 9, color: "#9E9B94", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.05em" }}>{employee.role}</div>
          <div style={{ fontSize: 10, color: "#6B6860", marginTop: 1 }}>
            {employee.jobs.length} job{employee.jobs.length !== 1 ? "s" : ""} · {Math.floor(totalMins / 60)}h{totalMins % 60 > 0 ? ` ${totalMins % 60}m` : ""} · ${revenue.toFixed(0)}
          </div>
        </div>
      </div>
      <div ref={setNodeRef} style={{ position: "relative", width: TOTAL_SLOTS * SLOT_W, flexShrink: 0, height: ROW_H, backgroundColor: isOver ? "rgba(91,155,213,0.05)" : "transparent", transition: "background-color 0.1s" }}>
        {TIMES.map((_, i) => <div key={i} style={{ position: "absolute", left: i * SLOT_W, top: 0, bottom: 0, borderRight: i % 2 === 1 ? "1px solid #E5E2DC" : "1px solid #EEECE7" }} />)}
        {nowLine >= 0 && nowLine <= TOTAL_SLOTS * SLOT_W && <div style={{ position: "absolute", left: nowLine, top: 0, bottom: 0, width: 2, backgroundColor: "#EF4444", zIndex: 3, pointerEvents: "none" }} />}
        {employee.jobs.map(j => <JobChip key={j.id} job={j} onClick={onChipClick} />)}
        {employee.jobs.length === 0 && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 11, color: "#D0CEC9", letterSpacing: "0.02em" }}>No jobs scheduled</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DESKTOP: UNASSIGNED PANEL ────────────────────────────────────────────────
function UnassignedChip({ job, onClick }: { job: DispatchJob; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `unassigned-${job.id}`, data: { job, type: "unassigned", originalLeft: 0 } });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} onClick={onClick}
      style={{ backgroundColor: "#FEF9EE", borderLeft: "3px solid #F59E0B", borderRadius: 8, padding: "10px 12px", marginBottom: 6, cursor: "grab", opacity: isDragging ? 0.4 : 1, transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined, boxShadow: "0 1px 3px rgba(0,0,0,0.05)", userSelect: "none" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", marginBottom: 2 }}>{job.client_name}</div>
      <div style={{ fontSize: 10, color: "var(--brand)", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.04em" }}>{fmtSvc(job.service_type)}</div>
      <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2 }}>{Math.floor(job.duration_minutes / 60)}h{job.duration_minutes % 60 > 0 ? ` ${job.duration_minutes % 60}m` : ""}</div>
    </div>
  );
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function JobsPage() {
  const isMobile = useIsMobile();
  const token = useAuthStore(s => s.token)!;
  const { toast } = useToast();
  const [selectedDate, setSelectedDate] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const [data, setData] = useState<DispatchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedJob, setSelectedJob] = useState<DispatchJob | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [draggingJob, setDraggingJob] = useState<DispatchJob | null>(null);
  const [desktopView, setDesktopView] = useState<"timeline" | "list">("timeline");
  const [jobDates, setJobDates] = useState<Set<string>>(new Set());
  const refreshRef = useRef(0);
  const [zones, setZones] = useState<{ id: number; name: string; color: string }[]>([]);
  const [selectedZoneFilter, setSelectedZoneFilter] = useState<number | null>(null);

  const load = useCallback(async () => {
    const id = ++refreshRef.current;
    setLoading(true);
    try {
      const d = await fetchDispatch(dateKey(selectedDate), token);
      if (id !== refreshRef.current) return;
      setData(d);
      // Collect all dates with jobs for the calendar dots
      const allJobs = [...(d.unassigned_jobs || []), ...(d.employees || []).flatMap((e: Employee) => e.jobs)];
      setJobDates(prev => {
        const next = new Set(prev);
        allJobs.forEach((j: DispatchJob) => next.add(j.scheduled_date));
        return next;
      });
    } catch { toast({ title: "Could not load schedule", variant: "destructive" }); }
    finally { setLoading(false); }
  }, [selectedDate, token]);

  useEffect(() => { load(); }, [load]);

  // Load zones for filter
  useEffect(() => {
    const API = (window as any).__API_BASE__ || "";
    fetch(`${API}/api/zones`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : [])
      .then(d => setZones(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [token]);

  // Now-line calculation
  const nowLine = (() => {
    const now = new Date();
    if (dateKey(now) !== dateKey(selectedDate)) return -1;
    const mins = now.getHours() * 60 + now.getMinutes();
    return ((mins - DAY_START) / 30) * SLOT_W;
  })();

  // DnD
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  function onDragStart(e: DragStartEvent) { setDraggingJob(e.active.data.current?.job ?? null); }
  async function onDragEnd(e: DragEndEvent) {
    setDraggingJob(null);
    const { active, over, delta } = e;
    if (!over || !data) return;
    const job: DispatchJob = active.data.current?.job;
    if (!job) return;
    const empId = parseInt(String(over.id).replace("row-", ""), 10);
    const originalLeft: number = active.data.current?.originalLeft ?? chipLeft(job);
    const newLeft = originalLeft + delta.x;
    const newMins = DAY_START + Math.round(newLeft / SLOT_W) * 30;
    const patch: any = { scheduled_time: minsToStr(newMins) };
    if (empId !== job.assigned_user_id) {
      patch.assigned_user_id = empId;
      // Cross-zone warning: if job zone differs from employee's primary zone
      const targetEmployee = data.employees.find(emp => emp.id === empId);
      if (targetEmployee?.zone && job.zone_id && targetEmployee.zone.zone_id !== job.zone_id) {
        toast({ title: `Cross-zone assignment`, description: `${targetEmployee.name} is in ${targetEmployee.zone.zone_name} but this job is in ${job.zone_name || "a different zone"}.` });
      }
    }
    try { await patchJob(job.id, patch, token); await load(); }
    catch { toast({ title: "Failed to update job", variant: "destructive" }); }
  }
  function chipLeft(job: DispatchJob) { return ((timeToMins(job.scheduled_time) - DAY_START) / 30) * SLOT_W; }

  // Zone-filtered dispatch data
  const filteredData = data ? {
    employees: data.employees.map(e => ({
      ...e,
      jobs: selectedZoneFilter !== null ? e.jobs.filter(j => j.zone_id === selectedZoneFilter) : e.jobs,
    })),
    unassigned_jobs: selectedZoneFilter !== null
      ? data.unassigned_jobs.filter(j => j.zone_id === selectedZoneFilter)
      : data.unassigned_jobs,
  } : null;

  const allJobs = filteredData ? [
    ...filteredData.unassigned_jobs,
    ...filteredData.employees.flatMap(e => e.jobs.map(j => ({ ...j, assigned_user_name: e.name }))),
  ].sort((a, b) => timeToMins(a.scheduled_time) - timeToMins(b.scheduled_time)) : [];

  const stats = {
    total: allJobs.length,
    complete: allJobs.filter(j => j.status === "complete").length,
    inProgress: allJobs.filter(j => j.status === "in_progress").length,
    revenue: allJobs.reduce((s, j) => s + (j.amount || 0), 0),
    unassigned: data?.unassigned_jobs.length || 0,
  };

  const dayLabel = selectedDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const isToday = dateKey(selectedDate) === dateKey(new Date());

  // ── MOBILE VIEW ──────────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <>
        <div style={{ display: "flex", flexDirection: "column", height: "100dvh", backgroundColor: "#F7F6F3", fontFamily: FF }}>
          {/* Header */}
          <div style={{ backgroundColor: "#FFFFFF", borderBottom: "1px solid #EEECE7", padding: "12px 16px 10px", flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#1A1917" }}>Dispatch</div>
              <button onClick={() => setShowWizard(true)}
                style={{ display: "flex", alignItems: "center", gap: 6, backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                <Plus size={14} /> New Job
              </button>
            </div>
            {/* Date navigation */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <button onClick={() => setSelectedDate(d => addDays(d, -1))} style={{ border: "none", background: "#F7F6F3", borderRadius: 8, padding: "6px 10px", cursor: "pointer", color: "#6B7280" }}><ChevronLeft size={16} /></button>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#1A1917" }}>
                  {isToday ? "Today" : selectedDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                </div>
                {isToday && <div style={{ fontSize: 11, color: "#9E9B94" }}>{selectedDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>}
              </div>
              <button onClick={() => setSelectedDate(d => addDays(d, 1))} style={{ border: "none", background: "#F7F6F3", borderRadius: 8, padding: "6px 10px", cursor: "pointer", color: "#6B7280" }}><ChevronRight size={16} /></button>
            </div>
          </div>

          {/* Summary strip */}
          {!loading && data && (
            <div style={{ display: "flex", gap: 0, backgroundColor: "#FFFFFF", borderBottom: "1px solid #EEECE7", flexShrink: 0, overflowX: "auto" }}>
              {[
                { label: "Total", value: stats.total, color: "#1A1917" },
                { label: "Done", value: stats.complete, color: "#16A34A" },
                { label: "Active", value: stats.inProgress, color: "#D97706" },
                { label: "Revenue", value: `$${stats.revenue.toFixed(0)}`, color: "var(--brand)" },
                ...(stats.unassigned > 0 ? [{ label: "Unassigned", value: stats.unassigned, color: "#DC2626" }] : []),
              ].map((s, i, arr) => (
                <div key={s.label} style={{ flex: "0 0 auto", padding: "8px 16px", textAlign: "center", borderRight: i < arr.length - 1 ? "1px solid #EEECE7" : "none" }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.04em" }}>{s.label}</div>
                </div>
              ))}
            </div>
          )}

          {/* Week strip */}
          <div style={{ backgroundColor: "#FFFFFF", borderBottom: "1px solid #EEECE7", padding: "8px 12px", flexShrink: 0, display: "flex", gap: 4, overflowX: "auto" }}>
            {Array.from({ length: 14 }, (_, i) => {
              const d = addDays(new Date(new Date().setHours(0, 0, 0, 0)), i - 3);
              const k = dateKey(d);
              const sel = k === dateKey(selectedDate);
              const isT = k === dateKey(new Date());
              return (
                <button key={k} onClick={() => setSelectedDate(d)} style={{ flex: "0 0 auto", display: "flex", flexDirection: "column", alignItems: "center", padding: "6px 10px", borderRadius: 10, border: "none", backgroundColor: sel ? "var(--brand)" : isT ? "var(--brand-dim)" : "transparent", cursor: "pointer" }}>
                  <span style={{ fontSize: 10, fontWeight: 600, color: sel ? "#fff" : isT ? "var(--brand)" : "#9E9B94", textTransform: "uppercase" }}>{d.toLocaleDateString("en-US", { weekday: "short" })}</span>
                  <span style={{ fontSize: 15, fontWeight: 800, color: sel ? "#fff" : isT ? "var(--brand)" : "#1A1917", marginTop: 2 }}>{d.getDate()}</span>
                  {jobDates.has(k) && <div style={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: sel ? "#ffffff80" : "var(--brand)", marginTop: 3 }} />}
                </button>
              );
            })}
          </div>

          {/* Zone filter dots — mobile */}
          {zones.length > 0 && (
            <div style={{ backgroundColor: "#FFFFFF", borderBottom: "1px solid #EEECE7", padding: "8px 14px", flexShrink: 0, display: "flex", gap: 6, overflowX: "auto", alignItems: "center" }}>
              <button onClick={() => setSelectedZoneFilter(null)}
                style={{ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 20, border: selectedZoneFilter === null ? "1.5px solid var(--brand)" : "1.5px solid #E5E2DC", backgroundColor: selectedZoneFilter === null ? "var(--brand-dim)" : "transparent", color: selectedZoneFilter === null ? "var(--brand)" : "#6B7280", cursor: "pointer", flexShrink: 0 }}>
                All
              </button>
              {zones.map(z => (
                <button key={z.id} onClick={() => setSelectedZoneFilter(selectedZoneFilter === z.id ? null : z.id)}
                  style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 20, border: `1.5px solid ${selectedZoneFilter === z.id ? z.color : "#E5E2DC"}`, backgroundColor: selectedZoneFilter === z.id ? `${z.color}22` : "transparent", color: selectedZoneFilter === z.id ? z.color : "#6B7280", cursor: "pointer", flexShrink: 0 }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: z.color, flexShrink: 0 }} />
                  {z.name}
                </button>
              ))}
            </div>
          )}

          {/* Job list */}
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
            {loading ? (
              <div style={{ textAlign: "center", padding: 48, color: "#9E9B94", fontSize: 13 }}>Loading...</div>
            ) : allJobs.length === 0 ? (
              <div style={{ textAlign: "center", padding: 48 }}>
                <Calendar size={36} style={{ color: "#D0CEC9", marginBottom: 12 }} />
                <div style={{ fontSize: 16, fontWeight: 700, color: "#6B7280", marginBottom: 6 }}>No jobs {isToday ? "today" : "this day"}{selectedZoneFilter !== null ? " in this zone" : ""}</div>
                <div style={{ fontSize: 13, color: "#9E9B94" }}>Tap "+ New Job" to schedule one</div>
              </div>
            ) : (
              <>
                {allJobs.map(j => <MobileJobCard key={j.id} job={j} onClick={() => setSelectedJob(j)} />)}
                {filteredData?.unassigned_jobs && filteredData.unassigned_jobs.length > 0 && (
                  <div style={{ marginTop: 8, padding: "10px 14px", backgroundColor: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 10, fontSize: 13, color: "#92400E", fontWeight: 600 }}>
                    {filteredData.unassigned_jobs.length} job{filteredData.unassigned_jobs.length !== 1 ? "s" : ""} still unassigned
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {selectedJob && (
          <JobPanel job={selectedJob} employees={data?.employees || []} onClose={() => setSelectedJob(null)} onUpdate={load} mobile />
        )}
        <JobWizard open={showWizard} onClose={() => setShowWizard(false)} onCreated={() => { setShowWizard(false); load(); }} />
      </>
    );
  }

  // ── DESKTOP VIEW ─────────────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div style={{ display: "flex", height: "calc(100vh - 56px)", overflow: "hidden", fontFamily: FF }}>

          {/* LEFT SIDEBAR */}
          <div style={{ width: 256, flexShrink: 0, borderRight: "1px solid #E5E2DC", backgroundColor: "#FAFAF9", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid #EEECE7" }}>
              <button onClick={() => setShowWizard(true)}
                style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, padding: "9px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                <Plus size={14} /> New Job
              </button>
            </div>

            <div style={{ borderBottom: "1px solid #EEECE7" }}>
              <MiniCalendar value={selectedDate} onChange={d => { setSelectedDate(d); }} jobDates={jobDates} />
            </div>

            {/* Team summary */}
            <div style={{ flex: 1, overflowY: "auto" }}>
              {filteredData && (
                <>
                  <div style={{ padding: "12px 14px 6px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9E9B94" }}>Team Today</div>
                  {filteredData.employees.map(e => {
                    const mins = e.jobs.reduce((s, j) => s + j.duration_minutes, 0);
                    const rev = e.jobs.reduce((s, j) => s + (j.amount || 0), 0);
                    const initials = e.name.split(" ").map((p: string) => p[0]).join("").toUpperCase().slice(0, 2);
                    return (
                      <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderBottom: "1px solid #F5F3F0" }}>
                        <div style={{ width: 30, height: 30, borderRadius: "50%", backgroundColor: "var(--brand-dim)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, flexShrink: 0 }}>{initials}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: 5 }}>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{e.name}</span>
                            {e.zone && <div style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: e.zone.zone_color, flexShrink: 0 }} title={e.zone.zone_name} />}
                          </div>
                          <div style={{ fontSize: 10, color: "#9E9B94" }}>{e.jobs.length} job{e.jobs.length !== 1 ? "s" : ""} · {Math.floor(mins / 60)}h · ${rev.toFixed(0)}</div>
                        </div>
                        {e.jobs.some(j => j.status === "in_progress") && (
                          <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#F59E0B", flexShrink: 0 }} title="In progress" />
                        )}
                        {e.jobs.every(j => j.status === "complete") && e.jobs.length > 0 && (
                          <CheckCircle size={14} style={{ color: "#22C55E", flexShrink: 0 }} />
                        )}
                      </div>
                    );
                  })}

                  {/* Unassigned */}
                  {filteredData.unassigned_jobs.length > 0 && (
                    <>
                      <div style={{ padding: "12px 14px 6px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#DC2626" }}>
                        Unassigned · {filteredData.unassigned_jobs.length}
                      </div>
                      <div style={{ padding: "0 14px 10px" }}>
                        {filteredData.unassigned_jobs.map(j => <UnassignedChip key={j.id} job={j} onClick={() => setSelectedJob(j)} />)}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          {/* MAIN CONTENT */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {/* Day header */}
            <div style={{ padding: "10px 20px", borderBottom: "1px solid #E5E2DC", backgroundColor: "#FFFFFF", display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button onClick={() => setSelectedDate(d => addDays(d, -1))} style={{ border: "1px solid #E5E2DC", background: "#FAFAF9", borderRadius: 6, padding: "5px 8px", cursor: "pointer", display: "flex", color: "#6B7280" }}><ChevronLeft size={14} /></button>
                <div style={{ textAlign: "center", minWidth: 170 }}>
                  <span style={{ fontSize: 14, fontWeight: 800, color: "#1A1917" }}>{isToday ? "Today — " : ""}{dayLabel}</span>
                </div>
                <button onClick={() => setSelectedDate(d => addDays(d, 1))} style={{ border: "1px solid #E5E2DC", background: "#FAFAF9", borderRadius: 6, padding: "5px 8px", cursor: "pointer", display: "flex", color: "#6B7280" }}><ChevronRight size={14} /></button>
                {!isToday && <button onClick={() => { const t = new Date(); t.setHours(0,0,0,0); setSelectedDate(t); }} style={{ border: "1px solid var(--brand)", background: "var(--brand-dim)", borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontSize: 11, fontWeight: 700, color: "var(--brand)" }}>Today</button>}
              </div>

              <div style={{ display: "flex", gap: 12, marginLeft: "auto", alignItems: "center" }}>
                {/* Stats pills */}
                {!loading && data && [
                  { label: `${stats.total} jobs`, color: "#1A1917", bg: "#F7F6F3" },
                  { label: `${stats.complete} done`, color: "#16A34A", bg: "#DCFCE7" },
                  ...(stats.inProgress > 0 ? [{ label: `${stats.inProgress} active`, color: "#D97706", bg: "#FEF3C7" }] : []),
                  { label: `$${stats.revenue.toFixed(0)} rev`, color: "var(--brand)", bg: "var(--brand-dim)" },
                ].map(s => (
                  <span key={s.label} style={{ fontSize: 11, fontWeight: 700, color: s.color, backgroundColor: s.bg, padding: "3px 8px", borderRadius: 20 }}>{s.label}</span>
                ))}

                {/* Zone filter */}
                {zones.length > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button onClick={() => setSelectedZoneFilter(null)}
                      style={{ fontSize: 11, fontWeight: 700, padding: "4px 9px", borderRadius: 20, border: selectedZoneFilter === null ? "1.5px solid var(--brand)" : "1.5px solid #E5E2DC", backgroundColor: selectedZoneFilter === null ? "var(--brand-dim)" : "#FAFAF9", color: selectedZoneFilter === null ? "var(--brand)" : "#6B7280", cursor: "pointer" }}>
                      All Zones
                    </button>
                    {zones.map(z => (
                      <button key={z.id} onClick={() => setSelectedZoneFilter(selectedZoneFilter === z.id ? null : z.id)}
                        style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, padding: "4px 9px", borderRadius: 20, border: `1.5px solid ${selectedZoneFilter === z.id ? z.color : "#E5E2DC"}`, backgroundColor: selectedZoneFilter === z.id ? `${z.color}22` : "#FAFAF9", color: selectedZoneFilter === z.id ? z.color : "#6B7280", cursor: "pointer" }}>
                        <div style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: z.color }} />
                        {z.name}
                      </button>
                    ))}
                  </div>
                )}

                {/* View toggle */}
                <div style={{ display: "flex", border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden" }}>
                  <button onClick={() => setDesktopView("timeline")} style={{ padding: "5px 10px", border: "none", cursor: "pointer", backgroundColor: desktopView === "timeline" ? "var(--brand)" : "#FAFAF9", color: desktopView === "timeline" ? "#fff" : "#6B7280", display: "flex" }}><LayoutGrid size={14} /></button>
                  <button onClick={() => setDesktopView("list")} style={{ padding: "5px 10px", border: "none", cursor: "pointer", backgroundColor: desktopView === "list" ? "var(--brand)" : "#FAFAF9", color: desktopView === "list" ? "#fff" : "#6B7280", display: "flex" }}><List size={14} /></button>
                </div>
              </div>
            </div>

            {/* Timeline or list */}
            {loading ? (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#9E9B94", fontSize: 13 }}>Loading schedule...</div>
            ) : desktopView === "timeline" ? (
              <div style={{ flex: 1, overflow: "auto" }}>
                {/* Time header */}
                <div style={{ display: "flex", position: "sticky", top: 0, zIndex: 10, backgroundColor: "#FAFAF9", borderBottom: "1px solid #E5E2DC" }}>
                  <div style={{ width: COL_W, flexShrink: 0, position: "sticky", left: 0, zIndex: 11, backgroundColor: "#FAFAF9", borderRight: "1px solid #E5E2DC", padding: "8px 14px" }}>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9E9B94" }}>Technician</span>
                  </div>
                  {TIMES.map((t, i) => (
                    <div key={i} style={{ width: SLOT_W, flexShrink: 0, padding: "8px 0 4px 6px", borderRight: i % 2 === 1 ? "1px solid #E5E2DC" : "1px solid #EEECE7" }}>
                      {i % 2 === 0 && <span style={{ fontSize: 9, fontWeight: 600, color: "#9E9B94", whiteSpace: "nowrap" }}>{t}</span>}
                    </div>
                  ))}
                </div>
                {filteredData && filteredData.employees.every(e => e.jobs.length === 0) && filteredData.unassigned_jobs.length === 0 ? (
                  <div style={{ padding: 60, textAlign: "center" }}>
                    <Calendar size={40} style={{ color: "#D0CEC9", marginBottom: 14 }} />
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#6B7280", marginBottom: 6 }}>No jobs scheduled {isToday ? "today" : "this day"}{selectedZoneFilter !== null ? ` in this zone` : ""}</div>
                    <div style={{ fontSize: 13, color: "#9E9B94" }}>{selectedZoneFilter !== null ? "Try clearing the zone filter or pick a different day" : "Click \"+ New Job\" to get started"}</div>
                  </div>
                ) : (
                  filteredData && filteredData.employees.map(e => <EmployeeRow key={e.id} employee={e} onChipClick={setSelectedJob} nowLine={nowLine} />)
                )}
              </div>
            ) : (
              /* List view */
              <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
                {allJobs.length === 0 ? (
                  <div style={{ textAlign: "center", padding: 60, color: "#9E9B94", fontSize: 13 }}>No jobs scheduled.</div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
                    {allJobs.map(j => (
                      <div key={j.id} onClick={() => setSelectedJob(j)}
                        style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "14px 16px", cursor: "pointer", borderLeft: `4px solid ${j.zone_color || (STATUS[j.status] || STATUS.scheduled).dot}` }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 800, color: "#1A1917" }}>{j.client_name}</div>
                            <div style={{ fontSize: 11, color: "var(--brand)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", marginTop: 2 }}>{fmtSvc(j.service_type)}</div>
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 700, color: (STATUS[j.status] || STATUS.scheduled).text, backgroundColor: (STATUS[j.status] || STATUS.scheduled).bg, padding: "3px 8px", borderRadius: 20, textTransform: "capitalize" }}>{j.status.replace("_", " ")}</span>
                        </div>
                        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                          {j.scheduled_time && <div style={{ fontSize: 12, color: "#6B7280", display: "flex", alignItems: "center", gap: 4 }}><Clock size={11} style={{ color: "#9E9B94" }} />{fmtTime(j.scheduled_time)}</div>}
                          {j.assigned_user_name && <div style={{ fontSize: 12, color: "#6B7280", display: "flex", alignItems: "center", gap: 4 }}><User size={11} style={{ color: "#9E9B94" }} />{j.assigned_user_name}</div>}
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", marginLeft: "auto" }}>${(j.amount || 0).toFixed(0)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <DragOverlay>
          {draggingJob && (
            <div style={{ width: Math.max(SLOT_W, (draggingJob.duration_minutes / 30) * SLOT_W), height: ROW_H - 20, borderRadius: 8, backgroundColor: (STATUS[draggingJob.status] || STATUS.scheduled).bg, borderLeft: `3px solid ${(STATUS[draggingJob.status] || STATUS.scheduled).dot}`, padding: "6px 8px", opacity: 0.9, boxShadow: "0 8px 24px rgba(0,0,0,0.15)", display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#1A1917" }}>{draggingJob.client_name}</span>
              <span style={{ fontSize: 10, color: "#6B7280" }}>{fmtSvc(draggingJob.service_type)}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {selectedJob && !isMobile && (
        <JobPanel job={selectedJob} employees={data?.employees || []} onClose={() => setSelectedJob(null)} onUpdate={load} mobile={false} />
      )}
      <JobWizard open={showWizard} onClose={() => setShowWizard(false)} onCreated={() => { setShowWizard(false); load(); }} />
    </DashboardLayout>
  );
}
