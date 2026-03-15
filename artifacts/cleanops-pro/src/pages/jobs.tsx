import { useState, useEffect, useRef, useCallback } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders, useAuthStore } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { JobWizard } from "@/components/job-wizard";
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable, type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { useListClients, useListUsers, useCreateJob } from "@workspace/api-client-react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ChevronLeft, ChevronRight, Plus, Search, Clock, Camera, X, MapPin, User, DollarSign,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// ─── CONSTANTS ───
const SLOT_W = 80;
const COL_W = 220;
const ROW_H = 80;
const DAY_START = 7 * 60;
const DAY_END = 20 * 60;
const TOTAL_SLOTS = (DAY_END - DAY_START) / 30;

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  scheduled:   { bg: "#DBEAFE", border: "#3B82F6", text: "#1D4ED8" },
  in_progress: { bg: "#FEF3C7", border: "#F59E0B", text: "#92400E" },
  complete:    { bg: "#DCFCE7", border: "#22C55E", text: "#15803D" },
  cancelled:   { bg: "#F3F4F6", border: "#9CA3AF", text: "#6B7280" },
  flagged:     { bg: "#FEE2E2", border: "#EF4444", text: "#991B1B" },
};

const TIMES = Array.from({ length: TOTAL_SLOTS }, (_, i) => {
  const mins = DAY_START + i * 30;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
});

// ─── TYPES ───
type JobStatus = "scheduled" | "in_progress" | "complete" | "cancelled";
interface ClockEntry {
  id: number;
  clock_in_at: string | null;
  clock_out_at: string | null;
  distance_from_job_ft: number | null;
  is_flagged: boolean;
}
interface DispatchJob {
  id: number;
  client_id: number;
  client_name: string;
  address: string | null;
  assigned_user_id: number | null;
  service_type: string;
  status: JobStatus;
  scheduled_date: string;
  scheduled_time: string | null;
  frequency: string;
  amount: number;
  duration_minutes: number;
  notes: string | null;
  before_photo_count: number;
  after_photo_count: number;
  clock_entry: ClockEntry | null;
}
interface Employee { id: number; name: string; role: string; jobs: DispatchJob[]; }
interface DispatchData { employees: Employee[]; unassigned_jobs: DispatchJob[]; }

// ─── HELPERS ───
function timeToMins(t: string | null): number {
  if (!t) return DAY_START;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}
function minsToTimeStr(mins: number): string {
  const c = Math.max(DAY_START, Math.min(DAY_END - 30, mins));
  return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}:00`;
}
function fmtTime(t: string | null): string {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m || 0).padStart(2, "0")} ${ampm}`;
}
function fmtService(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
function chipLeft(job: DispatchJob): number {
  return ((timeToMins(job.scheduled_time) - DAY_START) / 30) * SLOT_W;
}
function chipWidth(job: DispatchJob): number {
  return Math.max(SLOT_W, (job.duration_minutes / 30) * SLOT_W);
}
function dateKey(d: Date): string {
  return d.toISOString().split("T")[0];
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d); r.setDate(r.getDate() + n); return r;
}
async function patchJob(id: number, patch: object, token: string) {
  const res = await fetch(`/api/jobs/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed");
}
async function fetchDispatch(date: string, token: string): Promise<DispatchData> {
  const res = await fetch(`/api/dispatch?date=${date}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Failed to load dispatch");
  return res.json();
}

// ─── MINI CALENDAR ───
function MiniCalendar({ value, onChange, jobDates }: {
  value: Date; onChange: (d: Date) => void; jobDates: Set<string>;
}) {
  const [month, setMonth] = useState(new Date(value.getFullYear(), value.getMonth(), 1));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const firstDow = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const label = month.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  return (
    <div style={{ padding: "16px 12px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          style={{ border: "none", background: "none", cursor: "pointer", color: "#9E9B94", display: "flex", padding: 2 }}>
          <ChevronLeft size={14} />
        </button>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#1A1917" }}>{label}</span>
        <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          style={{ border: "none", background: "none", cursor: "pointer", color: "#9E9B94", display: "flex", padding: 2 }}>
          <ChevronRight size={14} />
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 1 }}>
        {DOW.map(d => <div key={d} style={{ textAlign: "center", fontSize: 10, color: "#9E9B94", fontWeight: 600, paddingBottom: 4 }}>{d}</div>)}
        {Array.from({ length: firstDow }).map((_, i) => <div key={`_${i}`} />)}
        {Array.from({ length: days }, (_, i) => i + 1).map(day => {
          const d = new Date(month.getFullYear(), month.getMonth(), day);
          const k = dateKey(d);
          const sel = dateKey(d) === dateKey(value);
          const isT = dateKey(d) === dateKey(today);
          const hasJ = jobDates.has(k);
          return (
            <button key={day} onClick={() => onChange(d)} style={{
              border: "none", cursor: "pointer", borderRadius: 6, padding: "4px 0",
              display: "flex", flexDirection: "column", alignItems: "center",
              background: sel ? "var(--brand)" : isT ? "var(--brand-dim)" : "none",
            }}>
              <span style={{ fontSize: 12, fontWeight: sel || isT ? 700 : 400, color: sel ? "#fff" : isT ? "var(--brand)" : "#1A1917" }}>{day}</span>
              {hasJ && <div style={{ width: 4, height: 4, borderRadius: "50%", backgroundColor: sel ? "#fff" : "var(--brand)", marginTop: 1 }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── QUICK PANEL ───
function QuickPanel({ job, employees, onClose, onUpdate }: {
  job: DispatchJob; employees: Employee[]; onClose: () => void; onUpdate: () => void;
}) {
  const token = useAuthStore(s => s.token)!;
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const sc = STATUS_COLORS[job.status] || STATUS_COLORS.scheduled;
  const assignedEmp = employees.find(e => e.id === job.assigned_user_id);
  const endMins = timeToMins(job.scheduled_time) + job.duration_minutes;

  async function markComplete() {
    setBusy(true);
    try {
      await patchJob(job.id, { status: "complete" }, token);
      toast({ title: "Job marked complete" });
      onUpdate(); onClose();
    } catch { toast({ title: "Error", variant: "destructive" }); }
    finally { setBusy(false); }
  }

  async function duplicateJob() {
    setDuplicating(true);
    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const newDate = tomorrow.toISOString().split("T")[0];
      const r = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/jobs`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: job.client_id,
          service_type: job.service_type,
          scheduled_date: newDate,
          scheduled_time: job.scheduled_time,
          duration_minutes: job.duration_minutes,
          base_fee: job.amount,
          frequency: job.frequency,
          notes: job.notes,
          assigned_user_id: job.assigned_user_id || undefined,
          status: "scheduled",
        }),
      });
      if (!r.ok) throw new Error("Failed to duplicate");
      toast({ title: "Job duplicated for tomorrow" });
      onUpdate(); onClose();
    } catch {
      toast({ title: "Could not duplicate job", variant: "destructive" });
    } finally { setDuplicating(false); }
  }

  return (
    <div style={{
      position: "fixed", top: 0, right: 0, bottom: 0, width: 360, zIndex: 50,
      backgroundColor: "#FFFFFF", borderLeft: "1px solid #E5E2DC",
      boxShadow: "-4px 0 20px rgba(0,0,0,0.08)",
      display: "flex", flexDirection: "column", fontFamily: "'Plus Jakarta Sans', sans-serif",
    }}>
      <div style={{ padding: "20px 20px 16px", borderBottom: "1px solid #E5E2DC", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#1A1917" }}>{job.client_name}</h2>
            <span style={{
              display: "inline-block", marginTop: 6, fontSize: 11, fontWeight: 600,
              textTransform: "uppercase", letterSpacing: "0.05em", padding: "2px 8px",
              borderRadius: 4, backgroundColor: "var(--brand-dim)", color: "var(--brand)",
            }}>{fmtService(job.service_type)}</span>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", color: "#9E9B94", padding: 4, marginLeft: 8, display: "flex" }}>
            <X size={18} />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 20, backgroundColor: sc.bg, border: `1px solid ${sc.border}`, marginBottom: 16 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: sc.border }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: sc.text, textTransform: "capitalize" }}>{job.status.replace("_", " ")}</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
          <InfoRow icon={<Clock size={14} />} label={`${fmtTime(job.scheduled_time)} – ${fmtTime(minsToTimeStr(endMins))}`} />
          {job.address && <InfoRow icon={<MapPin size={14} />} label={job.address} />}
          {assignedEmp && <InfoRow icon={<User size={14} />} label={assignedEmp.name} />}
          <InfoRow icon={<DollarSign size={14} />} label={`$${job.amount.toFixed(2)}`} bold />
        </div>

        {job.notes && (
          <PanelSection label="Notes">
            <p style={{ margin: 0, fontSize: 13, color: "#6B7280", lineHeight: 1.5 }}>{job.notes}</p>
          </PanelSection>
        )}

        {job.clock_entry && (
          <PanelSection label="Clock Data">
            {job.clock_entry.clock_in_at && (
              <KV label="Clock in" value={new Date(job.clock_entry.clock_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} />
            )}
            {job.clock_entry.clock_out_at && (
              <KV label="Clock out" value={new Date(job.clock_entry.clock_out_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} />
            )}
            {job.clock_entry.distance_from_job_ft !== null && (
              <KV label="Distance at clock-in"
                value={`${Math.round(job.clock_entry.distance_from_job_ft)} ft${job.clock_entry.is_flagged ? " (flagged)" : ""}`}
                valueColor={job.clock_entry.is_flagged ? "#EF4444" : undefined}
              />
            )}
          </PanelSection>
        )}

        {(job.before_photo_count > 0 || job.after_photo_count > 0) && (
          <PanelSection label={`Photos — ${job.before_photo_count} before · ${job.after_photo_count} after`}>
            <div style={{ display: "flex", gap: 8 }}>
              {job.before_photo_count > 0 && (
                <PhotoBadge count={job.before_photo_count} label="before" color="#0284C7" bg="#F0F9FF" border="#BAE6FD" />
              )}
              {job.after_photo_count > 0 && (
                <PhotoBadge count={job.after_photo_count} label="after" color="#16A34A" bg="#F0FDF4" border="#BBF7D0" />
              )}
            </div>
          </PanelSection>
        )}
      </div>

      <div style={{ padding: "12px 20px", borderTop: "1px solid #E5E2DC", display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
        {job.status !== "complete" && (
          <button onClick={markComplete} disabled={busy} style={{
            flex: 1, minWidth: 100, padding: "8px 12px", border: "none", borderRadius: 8,
            backgroundColor: "#22C55E", color: "#fff", fontSize: 12, fontWeight: 600,
            cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif",
          }}>{busy ? "..." : "Mark Complete"}</button>
        )}
        <button onClick={duplicateJob} disabled={duplicating} style={{
          flex: 1, minWidth: 80, padding: "8px 12px", border: "1px solid #E5E2DC", borderRadius: 8,
          color: "#6B7280", fontSize: 12, fontWeight: 600, backgroundColor: "#FFFFFF",
          cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif",
        }}>{duplicating ? "Duplicating…" : "Duplicate"}</button>
      </div>
    </div>
  );
}
function InfoRow({ icon, label, bold }: { icon: React.ReactNode; label: string; bold?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ color: "#9E9B94", flexShrink: 0 }}>{icon}</span>
      <span style={{ fontSize: 13, color: "#1A1917", fontWeight: bold ? 700 : 400 }}>{label}</span>
    </div>
  );
}
function PanelSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#9E9B94", marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
}
function KV({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
      <span style={{ color: "#6B7280" }}>{label}</span>
      <span style={{ color: valueColor || "#1A1917", fontWeight: 500 }}>{value}</span>
    </div>
  );
}
function PhotoBadge({ count, label, color, bg, border }: { count: number; label: string; color: string; bg: string; border: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 6, backgroundColor: bg, border: `1px solid ${border}` }}>
      <Camera size={12} style={{ color }} />
      <span style={{ fontSize: 11, color, fontWeight: 600 }}>{count} {label}</span>
    </div>
  );
}

// ─── JOB CHIP ───
function JobChip({ job, onClick }: { job: DispatchJob; onClick: (j: DispatchJob) => void }) {
  const isComplete = job.status === "complete";
  const sc = STATUS_COLORS[job.status] || STATUS_COLORS.scheduled;
  const left = chipLeft(job);
  const width = chipWidth(job);

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `chip-${job.id}`,
    data: { job, originalLeft: left },
    disabled: isComplete,
  });

  return (
    <div
      ref={setNodeRef}
      onClick={e => { e.stopPropagation(); onClick(job); }}
      {...(isComplete ? {} : { ...listeners, ...attributes })}
      style={{
        position: "absolute", top: 12, left, width, height: ROW_H - 24,
        borderRadius: 8, backgroundColor: sc.bg, borderLeft: `3px solid ${sc.border}`,
        padding: "6px 8px", boxSizing: "border-box", overflow: "hidden",
        cursor: isComplete ? "default" : isDragging ? "grabbing" : "grab",
        opacity: isDragging ? 0.3 : 1,
        transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
        zIndex: isDragging ? 0 : 2, userSelect: "none",
        display: "flex", flexDirection: "column", justifyContent: "center", gap: 2,
        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
        {job.clock_entry?.clock_in_at && <Clock size={9} style={{ color: sc.border, flexShrink: 0 }} />}
        {job.after_photo_count > 0 && <Camera size={9} style={{ color: sc.border, flexShrink: 0 }} />}
        <span style={{ fontSize: 11, fontWeight: 700, color: "#1A1917", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {job.client_name}
        </span>
      </div>
      <span style={{ fontSize: 10, color: "#6B7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {fmtService(job.service_type)}
      </span>
      {width > 130 && (
        <span style={{ fontSize: 9, color: "#9E9B94" }}>
          {fmtTime(job.scheduled_time)} – {fmtTime(minsToTimeStr(timeToMins(job.scheduled_time) + job.duration_minutes))}
        </span>
      )}
    </div>
  );
}

function ChipOverlay({ job }: { job: DispatchJob }) {
  const sc = STATUS_COLORS[job.status] || STATUS_COLORS.scheduled;
  return (
    <div style={{
      width: Math.min(chipWidth(job), 200), height: ROW_H - 24, borderRadius: 8,
      backgroundColor: sc.bg, borderLeft: `3px solid ${sc.border}`,
      padding: "6px 8px", opacity: 0.9, boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
      display: "flex", flexDirection: "column", justifyContent: "center",
    }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: "#1A1917" }}>{job.client_name}</span>
      <span style={{ fontSize: 10, color: "#6B7280" }}>{fmtService(job.service_type)}</span>
    </div>
  );
}

// ─── UNASSIGNED CARD ───
function UnassignedCard({ job, onClick }: { job: DispatchJob; onClick: (j: DispatchJob) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `unassigned-${job.id}`,
    data: { job, type: "unassigned", originalLeft: 0 },
  });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes}
      onClick={() => onClick(job)}
      style={{
        backgroundColor: "#FEF3C7", borderLeft: "3px solid #F59E0B", borderRadius: 8,
        padding: "10px 12px", marginBottom: 8, cursor: "grab",
        opacity: isDragging ? 0.4 : 1,
        transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)", userSelect: "none",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", marginBottom: 2 }}>{job.client_name}</div>
      <div style={{ fontSize: 11, color: "var(--brand)", textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.04em", marginBottom: 2 }}>
        {fmtService(job.service_type)}
      </div>
      <div style={{ fontSize: 11, color: "#6B6860" }}>
        {Math.floor(job.duration_minutes / 60)}h{job.duration_minutes % 60 > 0 ? ` ${job.duration_minutes % 60}m` : ""}
      </div>
    </div>
  );
}

// ─── EMPLOYEE ROW ───
function EmployeeRow({ employee, onChipClick, nowLine }: {
  employee: Employee; onChipClick: (j: DispatchJob) => void; nowLine: number;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `row-${employee.id}` });
  const initials = employee.name.split(" ").map(p => p[0]).join("").toUpperCase().slice(0, 2);
  const totalMins = employee.jobs.reduce((s, j) => s + j.duration_minutes, 0);

  return (
    <div style={{ display: "flex", borderBottom: "1px solid #EEECE7", height: ROW_H }}>
      <div style={{
        position: "sticky", left: 0, zIndex: 5, width: COL_W, flexShrink: 0,
        backgroundColor: "#FFFFFF", borderRight: "1px solid #E5E2DC",
        display: "flex", alignItems: "center", padding: "0 14px", gap: 10,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
          backgroundColor: "var(--brand-dim)", color: "var(--brand)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12, fontWeight: 700,
        }}>{initials}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {employee.name}
          </div>
          <div style={{ fontSize: 9, color: "#6B7280", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.05em" }}>
            {employee.role}
          </div>
          <div style={{ fontSize: 10, color: "#6B6860", marginTop: 1 }}>
            {employee.jobs.length} job{employee.jobs.length !== 1 ? "s" : ""} · {Math.floor(totalMins / 60)}h{totalMins % 60 > 0 ? ` ${totalMins % 60}m` : ""}
          </div>
        </div>
      </div>

      <div ref={setNodeRef} style={{
        position: "relative", width: TOTAL_SLOTS * SLOT_W, flexShrink: 0, height: ROW_H,
        backgroundColor: isOver ? "rgba(91,155,213,0.05)" : "transparent",
        transition: "background-color 0.1s",
      }}>
        {TIMES.map((_, i) => (
          <div key={i} style={{
            position: "absolute", left: i * SLOT_W, top: 0, bottom: 0,
            borderRight: i % 2 === 1 ? "1px solid #E5E2DC" : "1px solid #EEECE7",
          }} />
        ))}
        {nowLine >= 0 && nowLine <= TOTAL_SLOTS * SLOT_W && (
          <div style={{ position: "absolute", left: nowLine, top: 0, bottom: 0, width: 2, backgroundColor: "#EF4444", zIndex: 3, pointerEvents: "none" }} />
        )}
        {employee.jobs.map(j => <JobChip key={j.id} job={j} onClick={onChipClick} />)}
        {employee.jobs.length === 0 && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            border: "1px dashed #E5E2DC", margin: "16px 8px", borderRadius: 6,
          }}>
            <span style={{ fontSize: 11, color: "#C9C7C2" }}>No jobs scheduled</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── WEEK VIEW ───
function WeekView({ weekStart, data, onDayClick }: {
  weekStart: Date; data: DispatchData; onDayClick: (d: Date) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return (
    <div style={{ flex: 1, overflow: "auto", backgroundColor: "#F7F6F3" }}>
      <div style={{ minWidth: (data.employees.length + 1) * 160, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
        <div style={{ display: "flex", position: "sticky", top: 0, zIndex: 10, backgroundColor: "#FFFFFF", borderBottom: "1px solid #E5E2DC" }}>
          <div style={{ width: 120, flexShrink: 0, padding: "12px 16px", fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase" }}>Day</div>
          {data.employees.map(e => (
            <div key={e.id} style={{ flex: 1, minWidth: 140, padding: "10px 12px", borderLeft: "1px solid #EEECE7" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917" }}>{e.name}</div>
              <div style={{ fontSize: 10, color: "#9E9B94", textTransform: "uppercase" }}>{e.role}</div>
            </div>
          ))}
        </div>
        {days.map(day => {
          const k = dateKey(day);
          const isT = dateKey(day) === dateKey(today);
          const dayLbl = day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
          return (
            <div key={k} style={{ display: "flex", borderBottom: "1px solid #EEECE7", minHeight: 80 }}>
              <div style={{
                width: 120, flexShrink: 0, padding: "10px 16px", borderRight: "1px solid #EEECE7",
                cursor: "pointer", backgroundColor: isT ? "var(--brand-dim)" : "#FFFFFF",
              }} onClick={() => onDayClick(day)}>
                <div style={{ fontSize: 12, fontWeight: isT ? 700 : 500, color: isT ? "var(--brand)" : "#1A1917" }}>{dayLbl}</div>
                {isT && <div style={{ fontSize: 10, color: "var(--brand)", fontWeight: 600 }}>Today</div>}
              </div>
              {data.employees.map(e => {
                const empJobs = e.jobs.filter(j => j.scheduled_date === k);
                return (
                  <div key={e.id} style={{ flex: 1, minWidth: 140, padding: "8px 10px", borderLeft: "1px solid #EEECE7", display: "flex", flexDirection: "column", gap: 4 }}>
                    {empJobs.map(j => {
                      const sc = STATUS_COLORS[j.status] || STATUS_COLORS.scheduled;
                      return (
                        <div key={j.id} style={{ padding: "4px 8px", borderRadius: 6, backgroundColor: sc.bg, borderLeft: `2px solid ${sc.border}` }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: "#1A1917" }}>{j.client_name}</div>
                          <div style={{ fontSize: 10, color: "#6B7280" }}>{fmtTime(j.scheduled_time)}</div>
                          <div style={{ fontSize: 10, color: "var(--brand)", textTransform: "uppercase", fontWeight: 600 }}>{fmtService(j.service_type)}</div>
                        </div>
                      );
                    })}
                    {empJobs.length === 0 && <div style={{ fontSize: 11, color: "#C9C7C2" }}>—</div>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── SKELETON ───
function SkeletonBoard() {
  return (
    <div style={{ minWidth: COL_W + TOTAL_SLOTS * SLOT_W }}>
      <style>{`@keyframes shimmer{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
      {[...Array(4)].map((_, i) => (
        <div key={i} style={{ display: "flex", borderBottom: "1px solid #EEECE7", height: ROW_H }}>
          <div style={{ width: COL_W, flexShrink: 0, borderRight: "1px solid #E5E2DC", padding: "16px 14px", display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ width: 32, height: 32, borderRadius: "50%", backgroundColor: "#E5E2DC", animation: "shimmer 1.5s ease-in-out infinite" }} />
            <div style={{ flex: 1 }}>
              <div style={{ height: 12, backgroundColor: "#E5E2DC", borderRadius: 4, marginBottom: 6, width: "70%", animation: "shimmer 1.5s ease-in-out infinite" }} />
              <div style={{ height: 10, backgroundColor: "#EEECE7", borderRadius: 4, width: "50%", animation: "shimmer 1.5s ease-in-out infinite" }} />
            </div>
          </div>
          <div style={{ flex: 1, position: "relative" }}>
            <div style={{ position: "absolute", left: (i + 1) * SLOT_W * 2, top: 12, width: SLOT_W * (2 + i), height: ROW_H - 24, backgroundColor: "#E5E2DC", borderRadius: 8, animation: "shimmer 1.5s ease-in-out infinite" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── CREATE JOB SCHEMA ───
const createSchema = z.object({
  client_id: z.coerce.number().min(1, "Required"),
  service_type: z.enum(["standard_clean", "deep_clean", "move_out", "recurring_maintenance", "post_construction"]),
  scheduled_date: z.string().min(1, "Required"),
  scheduled_time: z.string().optional(),
  frequency: z.enum(["weekly", "biweekly", "monthly", "on_demand"]),
  base_fee: z.coerce.number().min(0),
  allowed_hours: z.coerce.number().min(0.5).optional(),
  assigned_user_id: z.coerce.number().optional(),
});
type CreateForm = z.infer<typeof createSchema>;

// ─── MAIN PAGE ───
export default function JobsPage() {
  const token = useAuthStore(s => s.token)!;
  const { toast } = useToast();
  const [viewDate, setViewDate] = useState<Date>(() => { const d = new Date(); d.setHours(0,0,0,0); return d; });
  const [viewMode, setViewMode] = useState<"day" | "week">("day");
  const [data, setData] = useState<DispatchData>({ employees: [], unassigned_jobs: [] });
  const [loading, setLoading] = useState(true);
  const [selectedJob, setSelectedJob] = useState<DispatchJob | null>(null);
  const [activeJob, setActiveJob] = useState<DispatchJob | null>(null);
  const [nowLine, setNowLine] = useState(0);
  const [search, setSearch] = useState("");
  const [filterEmp, setFilterEmp] = useState("all");
  const [newJobOpen, setNewJobOpen] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const { data: clientsRes } = useListClients({}, { request: { headers: getAuthHeaders() } });
  const { data: usersRes } = useListUsers({}, { request: { headers: getAuthHeaders() } });
  const clients = (clientsRes as any)?.data ?? [];
  const users = (usersRes as any)?.data ?? [];

  const { register, handleSubmit, control, reset, formState: { errors, isSubmitting } } = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: { frequency: "on_demand", base_fee: 0 },
  });
  const { mutateAsync: createJob } = useCreateJob();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchDispatch(dateKey(viewDate), token);
      setData(d);
    } catch { toast({ title: "Could not load board", variant: "destructive" }); }
    finally { setLoading(false); }
  }, [viewDate, token]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    function tick() {
      const now = new Date();
      const minsFromStart = now.getHours() * 60 + now.getMinutes() - DAY_START;
      setNowLine((minsFromStart / 30) * SLOT_W);
    }
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);

  function onDragStart({ active }: DragStartEvent) {
    const job: DispatchJob = active.data.current?.job;
    if (job) setActiveJob(job);
  }

  function onDragEnd({ active, over, delta }: DragEndEvent) {
    setActiveJob(null);
    if (!over) return;
    const job: DispatchJob = active.data.current?.job;
    if (!job) return;
    const targetEmpId = parseInt(String(over.id).replace("row-", ""));
    if (isNaN(targetEmpId)) return;

    const origLeft: number = active.data.current?.originalLeft ?? chipLeft(job);
    const newLeft = Math.max(0, origLeft + delta.x);
    const slot = Math.max(0, Math.min(TOTAL_SLOTS - 1, Math.round(newLeft / SLOT_W)));
    const newMins = DAY_START + slot * 30;
    const newTime = minsToTimeStr(newMins);
    const sameEmp = targetEmpId === (job.assigned_user_id ?? -1);
    const sameTime = newTime.slice(0, 5) === (job.scheduled_time ?? "").slice(0, 5);
    if (sameEmp && sameTime) return;

    const patch: Record<string, unknown> = { scheduled_time: newTime };
    if (!sameEmp) patch.assigned_user_id = targetEmpId;

    // Optimistic update
    setData(prev => {
      const emps = prev.employees.map(e => ({ ...e, jobs: e.jobs.filter(j => j.id !== job.id) }));
      const updated: DispatchJob = { ...job, scheduled_time: newTime, assigned_user_id: targetEmpId };
      const idx = emps.findIndex(e => e.id === targetEmpId);
      if (idx !== -1) emps[idx] = { ...emps[idx], jobs: [...emps[idx].jobs, updated] };
      const unassigned = active.data.current?.type === "unassigned"
        ? prev.unassigned_jobs.filter(j => j.id !== job.id)
        : prev.unassigned_jobs;
      return { employees: emps, unassigned_jobs: unassigned };
    });

    const targetName = data.employees.find(e => e.id === targetEmpId)?.name ?? "employee";
    patchJob(job.id, patch, token)
      .then(() => toast({ title: !sameEmp ? `Reassigned to ${targetName}` : `Rescheduled to ${fmtTime(newTime)}` }))
      .catch(() => { toast({ title: "Update failed — reverting", variant: "destructive" }); load(); });
  }

  async function onCreateJob(values: CreateForm) {
    try {
      await createJob({ body: values as any, request: { headers: getAuthHeaders() } } as any);
      toast({ title: "Job created" });
      setNewJobOpen(false); reset(); load();
    } catch { toast({ title: "Failed to create job", variant: "destructive" }); }
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const isToday = dateKey(viewDate) === dateKey(today);
  const dateLabel = viewDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const weekStart = (() => { const d = new Date(viewDate); const dow = d.getDay(); d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1)); return d; })();

  const filteredEmps = data.employees
    .filter(e => filterEmp === "all" || String(e.id) === filterEmp)
    .map(e => ({
      ...e,
      jobs: e.jobs.filter(j =>
        !search || j.client_name.toLowerCase().includes(search.toLowerCase()) || j.service_type.includes(search.toLowerCase())
      ),
    }));

  const GRID_W = TOTAL_SLOTS * SLOT_W;

  return (
    <DashboardLayout fullBleed>
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: "'Plus Jakarta Sans', sans-serif", overflow: "hidden" }}>

          {/* ZONE 1 — TOP BAR */}
          <div style={{
            height: 56, flexShrink: 0, backgroundColor: "#FFFFFF",
            borderBottom: "1px solid #E5E2DC",
            display: "flex", alignItems: "center", padding: "0 20px", gap: 14, zIndex: 20,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={() => setViewDate(prev => addDays(prev, -1))}
                style={{ border: "1px solid #E5E2DC", background: "#FFFFFF", borderRadius: 6, padding: "5px 8px", cursor: "pointer", display: "flex", alignItems: "center" }}>
                <ChevronLeft size={14} />
              </button>
              <span style={{ fontSize: 15, fontWeight: 600, color: "#1A1917", minWidth: 200, textAlign: "center" }}>{dateLabel}</span>
              <button onClick={() => setViewDate(prev => addDays(prev, 1))}
                style={{ border: "1px solid #E5E2DC", background: "#FFFFFF", borderRadius: 6, padding: "5px 8px", cursor: "pointer", display: "flex", alignItems: "center" }}>
                <ChevronRight size={14} />
              </button>
              {!isToday && (
                <button onClick={() => { const t = new Date(); t.setHours(0,0,0,0); setViewDate(t); }}
                  style={{ fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 20, border: "1px solid var(--brand)", color: "var(--brand)", background: "none", cursor: "pointer" }}>
                  Today
                </button>
              )}
            </div>

            <div style={{ display: "flex", gap: 2, padding: 3, backgroundColor: "#F7F6F3", borderRadius: 8, marginLeft: 8 }}>
              {(["day", "week"] as const).map(v => (
                <button key={v} onClick={() => setViewMode(v)} style={{
                  padding: "4px 14px", borderRadius: 6, border: "none", cursor: "pointer",
                  fontSize: 13, fontWeight: 600,
                  backgroundColor: viewMode === v ? "var(--brand)" : "transparent",
                  color: viewMode === v ? "#FFFFFF" : "#6B6860",
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                }}>{v === "day" ? "Day View" : "Week View"}</button>
              ))}
            </div>

            <div style={{ flex: 1 }} />

            <select value={filterEmp} onChange={e => setFilterEmp(e.target.value)} style={{
              border: "1px solid #E5E2DC", borderRadius: 8, padding: "6px 10px", fontSize: 13,
              color: "#1A1917", background: "#FFFFFF", cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif", outline: "none",
            }}>
              <option value="all">All Employees</option>
              {data.employees.map(e => <option key={e.id} value={String(e.id)}>{e.name}</option>)}
            </select>

            <div style={{ position: "relative" }}>
              <Search size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#9E9B94", pointerEvents: "none" }} />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search jobs or clients..."
                style={{ paddingLeft: 28, paddingRight: 10, paddingTop: 7, paddingBottom: 7, border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, width: 210, fontFamily: "'Plus Jakarta Sans', sans-serif", color: "#1A1917", outline: "none" }}
              />
            </div>

            <button onClick={() => setNewJobOpen(true)} style={{
              display: "flex", alignItems: "center", gap: 6, padding: "7px 14px",
              backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8,
              fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif",
            }}>
              <Plus size={14} /> New Job
            </button>
          </div>

          {/* ZONES 2 + 3 */}
          <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

            {/* ZONE 2 — LEFT PANEL */}
            <div style={{ width: 260, flexShrink: 0, backgroundColor: "#FFFFFF", borderRight: "1px solid #E5E2DC", overflowY: "auto", display: "flex", flexDirection: "column" }}>
              <MiniCalendar value={viewDate} onChange={d => { setViewDate(d); setViewMode("day"); }} jobDates={new Set()} />
              <div style={{ height: 1, backgroundColor: "#EEECE7", margin: "0 12px" }} />

              <div style={{ padding: "14px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#9E9B94" }}>Unassigned</span>
                  {data.unassigned_jobs.length > 0 && (
                    <span style={{ fontSize: 10, fontWeight: 700, backgroundColor: "#F59E0B", color: "#FFF", borderRadius: 10, padding: "1px 6px" }}>
                      {data.unassigned_jobs.length}
                    </span>
                  )}
                </div>
                {data.unassigned_jobs.length === 0 ? (
                  <div style={{ fontSize: 12, color: "#9E9B94", textAlign: "center", padding: "12px 0" }}>All jobs assigned</div>
                ) : (
                  data.unassigned_jobs.map(j => <UnassignedCard key={j.id} job={j} onClick={setSelectedJob} />)
                )}
              </div>

              <div style={{ height: 1, backgroundColor: "#EEECE7", margin: "0 12px" }} />

              <div style={{ padding: "14px 12px" }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#9E9B94", marginBottom: 8 }}>Status</div>
                {[["Scheduled","#3B82F6"],["In Progress","#F59E0B"],["Complete","#22C55E"],["Flagged","#EF4444"]].map(([l,c]) => (
                  <div key={l} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: c, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: "#6B7280" }}>{l}</span>
                  </div>
                ))}
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#9E9B94", marginBottom: 8, marginTop: 12 }}>Frequency</div>
                {[["Weekly","#8B5CF6"],["Bi-weekly","#06B6D4"],["Monthly","#F97316"],["One-time","#6B7280"]].map(([l,c]) => (
                  <div key={l} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: c, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: "#6B7280" }}>{l}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ZONE 3 — DISPATCH BOARD */}
            {viewMode === "week" ? (
              <WeekView weekStart={weekStart} data={data} onDayClick={d => { setViewDate(d); setViewMode("day"); }} />
            ) : (
              <div ref={boardRef} style={{ flex: 1, minWidth: 0, overflow: "auto", position: "relative", backgroundColor: "#F7F6F3" }}>
                {loading ? <SkeletonBoard /> : filteredEmps.length === 0 ? (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 300 }}>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#1A1917", marginBottom: 8 }}>No employees yet</div>
                      <a href="/employees/new" style={{ fontSize: 13, color: "var(--brand)", textDecoration: "none" }}>Add employees →</a>
                    </div>
                  </div>
                ) : (
                  <div style={{ minWidth: COL_W + GRID_W }}>
                    {/* Sticky time header */}
                    <div style={{ position: "sticky", top: 0, zIndex: 10, display: "flex", backgroundColor: "#FFFFFF", borderBottom: "1px solid #E5E2DC" }}>
                      <div style={{ position: "sticky", left: 0, zIndex: 11, width: COL_W, flexShrink: 0, backgroundColor: "#FFFFFF", borderRight: "1px solid #E5E2DC", padding: "10px 14px", display: "flex", alignItems: "center" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#9E9B94" }}>Team</span>
                      </div>
                      <div style={{ position: "relative", display: "flex", width: GRID_W, flexShrink: 0 }}>
                        {TIMES.map((t, i) => (
                          <div key={i} style={{
                            width: SLOT_W, flexShrink: 0, padding: "8px 0 8px 4px",
                            fontSize: 10, color: "#9E9B94", fontWeight: 500,
                            borderRight: i % 2 === 1 ? "1px solid #E5E2DC" : "1px solid #EEECE7",
                          }}>
                            {i % 2 === 0 ? t : ""}
                          </div>
                        ))}
                        {nowLine >= 0 && nowLine <= GRID_W && (
                          <div style={{ position: "absolute", left: nowLine - 1, top: 0, bottom: 0, width: 2, backgroundColor: "#EF4444", zIndex: 5, pointerEvents: "none" }}>
                            <span style={{ position: "absolute", top: 2, left: 4, fontSize: 9, fontWeight: 700, color: "#EF4444", whiteSpace: "nowrap" }}>NOW</span>
                          </div>
                        )}
                      </div>
                    </div>
                    {/* Rows */}
                    {filteredEmps.map(e => <EmployeeRow key={e.id} employee={e} onChipClick={setSelectedJob} nowLine={nowLine} />)}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <DragOverlay>{activeJob ? <ChipOverlay job={activeJob} /> : null}</DragOverlay>
      </DndContext>

      {/* Quick panel overlay */}
      {selectedJob && (
        <>
          <div onClick={() => setSelectedJob(null)} style={{ position: "fixed", inset: 0, zIndex: 49 }} />
          <QuickPanel job={selectedJob} employees={data.employees} onClose={() => setSelectedJob(null)} onUpdate={load} />
        </>
      )}

      <JobWizard open={newJobOpen} onClose={() => setNewJobOpen(false)} onCreated={load} />
    </DashboardLayout>
  );
}
