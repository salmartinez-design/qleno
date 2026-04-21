import { useState, useEffect, useRef, useCallback } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders, useAuthStore } from "@/lib/auth";
import { useBranch } from "@/contexts/branch-context";
import { useToast } from "@/hooks/use-toast";
import { JobWizard } from "@/components/job-wizard";
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable, type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import {
  ChevronLeft, ChevronRight, ChevronDown, Plus, Clock, Camera, X, MapPin, User,
  DollarSign, CheckCircle, AlertCircle, LayoutGrid, List, Calendar, Package,
  Building2, AlertTriangle, Repeat, Phone, MessageSquare, Send,
} from "lucide-react";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const FF = "'Plus Jakarta Sans', sans-serif";
const SLOT_W = 80;
const COL_W = 180;
const ROW_H = 64;
// Mutable — overwritten by company dispatch_start_hour / dispatch_end_hour settings
let DAY_START = 8 * 60;   // default: 8 AM
let DAY_END   = 18 * 60;  // default: 6 PM
let TOTAL_SLOTS = (DAY_END - DAY_START) / 30;
let TIMES: string[] = [];

function refreshTimeline() {
  TOTAL_SLOTS = (DAY_END - DAY_START) / 30;
  TIMES = Array.from({ length: TOTAL_SLOTS }, (_, i) => {
    const mins = DAY_START + i * 30;
    const h = Math.floor(mins / 60), m = mins % 60;
    return `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  });
}
refreshTimeline();

const STATUS: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  scheduled:   { bg: "#DBEAFE", border: "#93C5FD", text: "#1D4ED8", dot: "#3B82F6" },
  in_progress: { bg: "#FEF3C7", border: "#FCD34D", text: "#92400E", dot: "#F59E0B" },
  complete:    { bg: "#DCFCE7", border: "#86EFAC", text: "#15803D", dot: "#22C55E" },
  cancelled:   { bg: "#F3F4F6", border: "#D1D5DB", text: "#6B7280", dot: "#9CA3AF" },
  flagged:     { bg: "#FEE2E2", border: "#FCA5A5", text: "#991B1B", dot: "#EF4444" },
};

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface ClockEntry { id: number; clock_in_at: string | null; clock_out_at: string | null; distance_from_job_ft: number | null; is_flagged: boolean; }
interface JobTechCommission { user_id: number; name: string; is_primary: boolean; est_hours: number; calc_pay: number; final_pay: number; pay_override: number | null; }
interface DispatchJob { id: number; client_id: number; client_name: string; client_phone?: string | null; address: string | null; assigned_user_id: number | null; assigned_user_name?: string; service_type: string; status: string; scheduled_date: string; scheduled_time: string | null; frequency: string; amount: number; duration_minutes: number; notes: string | null; office_notes?: string | null; before_photo_count: number; after_photo_count: number; clock_entry: ClockEntry | null; zone_id?: number | null; zone_color?: string | null; zone_name?: string | null; account_id?: number | null; account_name?: string | null; billing_method?: string | null; hourly_rate?: number | null; estimated_hours?: number | null; billed_hours?: number | null; billed_amount?: number | null; charge_failed_at?: string | null; charge_succeeded_at?: string | null; property_access_notes?: string | null; booking_location?: string | null; technicians?: JobTechCommission[]; est_hours_per_tech?: number | null; est_pay_per_tech?: number | null; company_res_pct?: number | null; }
interface Employee { id: number; name: string; role: string; jobs: DispatchJob[]; zone?: { zone_id: number; zone_color: string; zone_name: string } | null; time_off?: 'pto' | 'sick' | 'absent' | null; commission_rate?: number | null; }
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
function fmtHour(h: number) { if (h === 12) return "12 PM"; if (h === 0) return "12 AM"; return h < 12 ? `${h} AM` : `${h - 12} PM`; }
function slotBg(count: number) { if (count === 0) return "#DCFCE7"; if (count <= 2) return "#FEF3C7"; return "#FEE2E2"; }
function slotTxt(count: number) { if (count === 0) return "#15803D"; if (count <= 2) return "#92400E"; return "#991B1B"; }
function slotLbl(count: number) { if (count === 0) return "Open"; if (count <= 2) return `${count} job${count === 1 ? "" : "s"}`; return `Full (${count})`; }

async function patchJob(id: number, patch: object, token: string) {
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");
  const r = await fetch(`${API}/api/jobs/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(patch) });
  if (!r.ok) throw new Error("Failed");
}

async function fetchDispatch(date: string, token: string, branchId?: number | "all"): Promise<DispatchData> {
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");
  const params = new URLSearchParams({ date });
  if (branchId && branchId !== "all") params.set("branch_id", String(branchId));
  const r = await fetch(`${API}/api/dispatch?${params}`, { headers: { Authorization: `Bearer ${token}` } });
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

  // Role check for charge button
  let userRole = "office";
  try { userRole = JSON.parse(atob(token.split(".")[1])).role || "office"; } catch {}
  const canCharge = (userRole === "owner" || userRole === "admin");

  // Charge modal state
  const [chargeOpen, setChargeOpen] = useState(false);
  const [chargeClientData, setChargeClientData] = useState<{ card_last_four: string | null; card_brand: string | null; payment_source: string | null } | null>(null);
  const [chargeBusy, setChargeBusy] = useState(false);
  const [chargeError, setChargeError] = useState("");

  const _API3 = import.meta.env.BASE_URL.replace(/\/$/, "");

  async function openChargeModal() {
    setChargeError("");
    setChargeOpen(true);
    if (!chargeClientData) {
      try {
        const r = await fetch(`${_API3}/api/clients/${job.client_id}`, { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json();
        setChargeClientData({ card_last_four: d.card_last_four || d.default_card_last_4 || null, card_brand: d.card_brand || d.default_card_brand || null, payment_source: d.payment_source || null });
      } catch { setChargeClientData({ card_last_four: null, card_brand: null, payment_source: null }); }
    }
  }

  async function confirmCharge() {
    setChargeBusy(true);
    setChargeError("");
    try {
      const r = await fetch(`${_API3}/api/jobs/${job.id}/charge`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Charge failed");
      const brand = d.card_brand ? (d.card_brand.charAt(0).toUpperCase() + d.card_brand.slice(1)) : "Card";
      toast({ title: `Payment of $${Number(d.amount).toFixed(2)} collected`, description: `${brand} ending in ${d.card_last_four || "****"}` });
      setChargeOpen(false);
      onUpdate();
    } catch (err: any) {
      setChargeError(err.message || "Charge failed");
    } finally {
      setChargeBusy(false);
    }
  }

  // Show charge button when: completed + can charge + not already charged + Stripe client
  const chargeAmount = Number(job.billed_amount ?? job.amount ?? 0);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("customer_request");
  const [cancelNote, setCancelNote] = useState("");

  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleReason, setRescheduleReason] = useState("");
  const [rescheduleReasonOther, setRescheduleReasonOther] = useState("");
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [rescheduleHour, setRescheduleHour] = useState<number | null>(null);
  const [availSlots, setAvailSlots] = useState<{ hour: number; count: number }[]>([]);
  const [availLoading, setAvailLoading] = useState(false);
  const [techList, setTechList] = useState<{ id: number; name: string; role: string; jobs_today: number; has_conflict: boolean }[]>([]);
  const [techLoading, setTechLoading] = useState(false);
  const [selectedTechId, setSelectedTechId] = useState<number | null>(job.assigned_user_id);
  const [rescheduleBusy, setRescheduleBusy] = useState(false);
  const [rescheduleSuccess, setRescheduleSuccess] = useState("");
  const [rescheduleCount, setRescheduleCount] = useState<number | null>(null);
  const [smsOpen, setSmsOpen] = useState(false);
  const [smsMessage, setSmsMessage] = useState("");
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsTwilioOk, setSmsTwilioOk] = useState<boolean | null>(null);

  // Commission override state
  const [commTechs, setCommTechs] = useState<JobTechCommission[]>(job.technicians ?? []);
  const [overrideOpen, setOverrideOpen] = useState<Record<number, boolean>>({});
  const [overrideVal, setOverrideVal] = useState<Record<number, string>>({});
  const [overrideBusy, setOverrideBusy] = useState(false);
  const canManageCommission = (userRole === "owner" || userRole === "admin" || userRole === "office");
  const canEditOfficeNotes  = (userRole === "owner" || userRole === "admin" || userRole === "office");

  // Office Notes state
  const [officeNotes, setOfficeNotes] = useState(job.office_notes || "");
  const [officeNotesSaving, setOfficeNotesSaving] = useState(false);
  const [officeNotesSaved, setOfficeNotesSaved] = useState(false);

  // Debounced auto-save for office notes
  useEffect(() => {
    const delay = setTimeout(async () => {
      if (officeNotes === (job.office_notes || "")) return; // no change
      setOfficeNotesSaving(true);
      setOfficeNotesSaved(false);
      try {
        await fetch(`${_API3}/api/jobs/${job.id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ office_notes: officeNotes || null }),
        });
        setOfficeNotesSaved(true);
        setTimeout(() => setOfficeNotesSaved(false), 3000);
      } catch {}
      finally { setOfficeNotesSaving(false); }
    }, 2000);
    return () => clearTimeout(delay);
  }, [officeNotes, job.id, job.office_notes, token]);

  async function saveOverride(techId: number) {
    setOverrideBusy(true);
    const API2 = import.meta.env.BASE_URL.replace(/\/$/, "");
    try {
      const val = overrideVal[techId];
      const pay_override = val === "" ? null : parseFloat(val);
      const r = await fetch(`${API2}/api/jobs/${job.id}/technicians/${techId}/override`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ pay_override }),
      });
      const d = await r.json();
      if (d.data) setCommTechs(d.data);
      setOverrideOpen(o => ({ ...o, [techId]: false }));
      toast({ title: "Commission override saved" });
    } catch {
      toast({ title: "Error saving override", variant: "destructive" });
    } finally {
      setOverrideBusy(false);
    }
  }

  useEffect(() => {
    setCommTechs(job.technicians ?? []);
  }, [job.id]);
  const _API2 = import.meta.env.BASE_URL.replace(/\/$/, "");

  useEffect(() => {
    if (!smsOpen || smsTwilioOk !== null) return;
    fetch(`${_API2}/api/communications/sms/status`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setSmsTwilioOk(d.configured === true)).catch(() => setSmsTwilioOk(false));
  }, [smsOpen]);

  useEffect(() => {
    if (!rescheduleOpen) return;
    fetch(`${_API2}/api/cancellations/reschedule-count?client_id=${job.client_id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setRescheduleCount(d.count ?? 0)).catch(() => setRescheduleCount(0));
  }, [rescheduleOpen]);

  useEffect(() => {
    if (!rescheduleOpen || !rescheduleDate) { setAvailSlots([]); return; }
    setAvailLoading(true);
    fetch(`${_API2}/api/jobs/availability?date=${rescheduleDate}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setAvailSlots(d.slots || [])).catch(() => {}).finally(() => setAvailLoading(false));
  }, [rescheduleOpen, rescheduleDate]);

  useEffect(() => {
    if (!rescheduleOpen || !rescheduleDate || rescheduleHour === null) { setTechList([]); return; }
    setTechLoading(true);
    const timeStr = `${String(rescheduleHour).padStart(2, "0")}:00`;
    fetch(`${_API2}/api/users/available?date=${rescheduleDate}&time=${timeStr}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setTechList(d.employees || [])).catch(() => {}).finally(() => setTechLoading(false));
  }, [rescheduleOpen, rescheduleDate, rescheduleHour]);

  // Add team member state
  const [addTechOpen, setAddTechOpen] = useState(false);
  const [addTechList, setAddTechList] = useState<{ id: number; name: string; role: string }[]>([]);
  const [addTechLoading, setAddTechLoading] = useState(false);
  const [addTechBusy, setAddTechBusy] = useState(false);

  useEffect(() => {
    if (!addTechOpen) return;
    setAddTechLoading(true);
    const existingIds = new Set((job.technicians ?? []).map(t => t.user_id));
    if (job.assigned_user_id) existingIds.add(job.assigned_user_id);
    fetch(`${_API3}/api/users?role=technician,team_lead&active=true`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        const all = Array.isArray(d) ? d : (d.data ?? []);
        setAddTechList(all.filter((u: any) => !existingIds.has(u.id)).map((u: any) => ({ id: u.id, name: `${u.first_name} ${u.last_name}`, role: u.role })));
      })
      .catch(() => setAddTechList([]))
      .finally(() => setAddTechLoading(false));
  }, [addTechOpen, job.id]);

  async function addTechToJob(techId: number) {
    setAddTechBusy(true);
    try {
      const r = await fetch(`${_API3}/api/jobs/${job.id}/technicians`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: techId }),
      });
      const d = await r.json();
      if (d.data) setCommTechs(d.data);
      toast({ title: "Team member added" });
      setAddTechOpen(false);
      onUpdate();
    } catch {
      toast({ title: "Error adding tech", variant: "destructive" });
    } finally { setAddTechBusy(false); }
  }

  // Supply logging state
  const [supplyName, setSupplyName] = useState("");
  const [supplyQty, setSupplyQty] = useState("1");
  const [supplyUnit, setSupplyUnit] = useState("units");
  const [supplies, setSupplies] = useState<{ name: string; qty: string; unit: string }[]>([]);
  const [supplyOpen, setSupplyOpen] = useState(false);

  function addSupply() {
    if (!supplyName.trim()) return;
    setSupplies(p => [...p, { name: supplyName, qty: supplyQty, unit: supplyUnit }]);
    setSupplyName("");
    setSupplyQty("1");
  }

  async function logSupplies() {
    if (supplies.length === 0) return;
    const API2 = import.meta.env.BASE_URL.replace(/\/$/, "");
    try {
      await fetch(`${API2}/api/supplies/log`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.id, items: supplies }),
      }).catch(() => {});
      toast({ title: `${supplies.length} supply item${supplies.length > 1 ? "s" : ""} logged` });
      setSupplies([]);
      setSupplyOpen(false);
    } catch {}
  }

  async function setStatus(s: string) {
    setBusy(true);
    try {
      if (s === "complete") {
        const API2 = import.meta.env.BASE_URL.replace(/\/$/, "");
        const r = await fetch(`${API2}/api/jobs/${job.id}/complete`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error((err as any).message || "Failed to complete job");
        }
        const result = await r.json();
        if (result.invoice_error) {
          toast({ title: "Job marked complete", description: "Invoice could not be generated. Create it manually in Invoices." });
        } else if (result.invoice_created && result.invoice) {
          toast({ title: "Job marked complete", description: `Invoice #${result.invoice.id} created` });
        } else if (result.invoice) {
          toast({ title: "Job marked complete", description: "Existing invoice found" });
        } else {
          toast({ title: "Job marked complete" });
        }
      } else {
        await patchJob(job.id, { status: s }, token);
        toast({ title: `Job marked ${s.replace("_", " ")}` });
      }
      onUpdate();
      onClose();
    } catch (e: any) {
      toast({ title: "Error", description: e.message || "Something went wrong", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function cancelJob() {
    setBusy(true);
    const API2 = import.meta.env.BASE_URL.replace(/\/$/, "");
    try {
      await patchJob(job.id, { status: "cancelled" }, token);
      await fetch(`${API2}/api/cancellations`, {
        method: "POST", // Note: cancellations is read-only GET; the cancel log gets created by a trigger in production
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.id, customer_id: job.client_id, cancel_reason: cancelReason, notes: cancelNote || null }),
      }).catch(() => {});
      toast({ title: "Job cancelled" });
      setCancelOpen(false);
      onUpdate();
      onClose();
    } catch { toast({ title: "Error", variant: "destructive" }); }
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

            {job.account_id && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", background: "var(--brand-dim, #EBF4FF)", borderRadius: 8, marginBottom: 12, width: "fit-content" }}>
              <Building2 size={13} color="var(--brand, #00C9A0)" />
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--brand, #00C9A0)" }}>{job.account_name || "Commercial Account"}</span>
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
            <IR icon={<Clock size={14} />} label={`${fmtTime(job.scheduled_time)} – ${fmtTime(minsToStr(endMins))}`} />
            {job.address && <IR icon={<MapPin size={14} />} label={job.address} />}
            {job.client_phone && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Phone size={14} color="#9E9B94" style={{ flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: "#4B4A47", flex: 1 }}>{job.client_phone}</span>
                <a href={`tel:${job.client_phone}`} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 6, backgroundColor: "#EBF4FF", border: "1px solid #BFDBFE", textDecoration: "none" }} title="Call client">
                  <Phone size={13} color="#1D4ED8" />
                </a>
                <button onClick={() => { setSmsOpen(true); setSmsMessage(""); }} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 6, backgroundColor: "#ECFDF5", border: "1px solid #6EE7B7", cursor: "pointer" }} title="Send SMS">
                  <MessageSquare size={13} color="#059669" />
                </button>
              </div>
            )}
            {(assignedEmp || job.assigned_user_name) && <IR icon={<User size={14} />} label={assignedEmp?.name || job.assigned_user_name || ""} />}
            {job.billing_method === "hourly" && job.hourly_rate
              ? <IR icon={<DollarSign size={14} />} label={`$${job.hourly_rate.toFixed(2)}/hr · Hourly${job.billed_hours ? ` · ${job.billed_hours}h billed` : job.estimated_hours ? ` · est. ${job.estimated_hours}h` : ""}`} bold />
              : <IR icon={<DollarSign size={14} />} label={`$${(job.billed_amount ?? job.amount ?? 0).toFixed(2)}`} bold />
            }
          </div>

          {job.property_access_notes && (
            <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 14 }}>
              <AlertTriangle size={14} style={{ color: "#D97706", flexShrink: 0, marginTop: 1 }} />
              <div>
                <p style={{ fontSize: 10, fontWeight: 700, color: "#92400E", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 3px" }}>Building Access</p>
                <p style={{ margin: 0, fontSize: 12, color: "#92400E", lineHeight: 1.5 }}>{job.property_access_notes}</p>
              </div>
            </div>
          )}

          {job.billing_method === "hourly" && job.billed_hours != null && job.estimated_hours != null && job.billed_hours > job.estimated_hours + 0.5 && (
            <div style={{ background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 14 }}>
              <AlertTriangle size={14} style={{ color: "#92400E", flexShrink: 0, marginTop: 1 }} />
              <p style={{ margin: 0, fontSize: 12, color: "#92400E", lineHeight: 1.5 }}>
                Hours over budget: {(job.billed_hours - job.estimated_hours).toFixed(1)}h over estimate
                {job.hourly_rate ? ` · ~$${((job.billed_hours - job.estimated_hours) * job.hourly_rate).toFixed(2)} additional` : ""}
              </p>
            </div>
          )}

          {job.charge_failed_at && !job.charge_succeeded_at && (
            <div style={{ background: "#FEE2E2", border: "1px solid #FECACA", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <AlertTriangle size={14} style={{ color: "#EF4444", flexShrink: 0 }} />
              <p style={{ margin: 0, fontSize: 12, color: "#991B1B" }}>
                Charge failed{job.billed_amount ? ` — $${Number(job.billed_amount).toFixed(2)}` : ""} · Check card on file
              </p>
            </div>
          )}

          {job.notes && (
            <PS label="Notes"><p style={{ margin: 0, fontSize: 13, color: "#6B7280", lineHeight: 1.6 }}>{job.notes}</p></PS>
          )}

          {/* Office Notes — editable, office/owner/admin only */}
          {canEditOfficeNotes && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <Phone size={11} style={{ color: "var(--brand)" }} />
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: "#9E9B94" }}>Office Notes</span>
                </div>
                {officeNotesSaving && <span style={{ fontSize: 10, color: "#9E9B94" }}>Saving...</span>}
                {!officeNotesSaving && officeNotesSaved && <span style={{ fontSize: 10, color: "#16A34A", fontWeight: 600 }}>✓ Saved</span>}
              </div>
              <textarea
                value={officeNotes}
                onChange={e => { setOfficeNotes(e.target.value); setOfficeNotesSaved(false); }}
                placeholder="Internal office notes — not visible to clients or technicians..."
                rows={4}
                style={{
                  width: "100%", boxSizing: "border-box" as const, resize: "vertical" as const,
                  border: "1px solid #E5E2DC", borderRadius: 8, padding: "8px 10px",
                  fontSize: 12, fontFamily: FF, color: "#1A1917", lineHeight: 1.6,
                  outline: "none", background: "#FAFAF8",
                }}
                onFocus={e => (e.target.style.borderColor = "var(--brand)")}
                onBlur={e => (e.target.style.borderColor = "#E5E2DC")}
              />
              <p style={{ fontSize: 10, color: "#C0BDB8", marginTop: 4, fontFamily: FF }}>Auto-saves 2 s after you stop typing</p>
            </div>
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

          {/* Commission Section — visible to owner/admin/office */}
          {canManageCommission && (job.estimated_hours ?? 0) > 0 && (
            <PS label="Commission">
              {commTechs.length > 0 ? commTechs.map(t => (
                <div key={t.user_id} style={{ marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#1A1917" }}>{t.name}{t.is_primary ? " (primary)" : ""}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 12, color: t.pay_override != null ? "#D97706" : "#16A34A", fontWeight: 700 }}>
                        ${t.final_pay.toFixed(2)}{t.pay_override != null ? " (override)" : ""}
                      </span>
                      {userRole === "owner" || userRole === "admin" ? (
                        <button
                          onClick={() => { setOverrideOpen(o => ({ ...o, [t.user_id]: !o[t.user_id] })); setOverrideVal(v => ({ ...v, [t.user_id]: t.pay_override != null ? String(t.pay_override) : "" })); }}
                          style={{ fontSize: 10, color: "#6B7280", border: "1px solid #E5E2DC", background: "none", borderRadius: 4, padding: "2px 6px", cursor: "pointer", fontFamily: FF }}
                        >
                          {overrideOpen[t.user_id] ? "Cancel" : "Override"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: "#9E9B94" }}>Est. {t.est_hours.toFixed(1)} hrs · Calc: ${t.calc_pay.toFixed(2)}</div>
                  {overrideOpen[t.user_id] && (
                    <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center" }}>
                      <span style={{ fontSize: 11, color: "#6B7280" }}>$</span>
                      <input
                        type="number" step="0.01" min="0"
                        value={overrideVal[t.user_id] ?? ""}
                        onChange={e => setOverrideVal(v => ({ ...v, [t.user_id]: e.target.value }))}
                        placeholder={String(t.calc_pay.toFixed(2))}
                        style={{ width: 80, height: 28, padding: "0 8px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: FF, outline: "none" }}
                      />
                      <button
                        onClick={() => saveOverride(t.user_id)}
                        disabled={overrideBusy}
                        style={{ fontSize: 11, fontWeight: 600, color: "#fff", background: "var(--brand)", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: FF }}
                      >
                        Save
                      </button>
                      {t.pay_override != null && (
                        <button
                          onClick={() => { setOverrideVal(v => ({ ...v, [t.user_id]: "" })); saveOverride(t.user_id); }}
                          disabled={overrideBusy}
                          style={{ fontSize: 11, color: "#EF4444", border: "none", background: "none", cursor: "pointer", fontFamily: FF }}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )) : (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "#6B7280" }}>
                    {assignedEmp?.name || job.assigned_user_name || "Unassigned"} · Est. {(job.est_hours_per_tech ?? job.estimated_hours ?? 0).toFixed(1)} hrs
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#16A34A" }}>
                    ${(job.est_pay_per_tech ?? ((job.billed_amount ?? job.amount ?? 0) * (job.company_res_pct ?? 0.35))).toFixed(2)} est.
                  </span>
                </div>
              )}
              <div style={{ marginTop: 4, fontSize: 11, color: "#9E9B94" }}>
                Pool rate: {((job.company_res_pct ?? 0.35) * 100).toFixed(0)}% of job total
              </div>
              <button onClick={() => setAddTechOpen(true)}
                style={{ marginTop: 8, width: "100%", height: 32, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#2D9B83", border: "1px dashed #2D9B83", borderRadius: 8, background: "transparent", cursor: "pointer", fontFamily: FF }}>
                <Plus size={12} /> Add Team Member
              </button>
            </PS>
          )}

          {/* Add Tech Modal */}
          {addTechOpen && (
            <>
              <div onClick={() => setAddTechOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 300 }} />
              <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 301, width: 340, backgroundColor: "#FFFFFF", borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,0.2)", fontFamily: FF, overflow: "hidden" }}>
                <div style={{ padding: "16px 20px", borderBottom: "1px solid #E5E2DC", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "#1A1917" }}>Add Team Member</span>
                  <button onClick={() => setAddTechOpen(false)} style={{ border: "none", background: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}><X size={16} /></button>
                </div>
                <div style={{ padding: "12px 20px", maxHeight: 300, overflowY: "auto" }}>
                  {addTechLoading ? (
                    <div style={{ padding: 20, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>Loading technicians...</div>
                  ) : addTechList.length === 0 ? (
                    <div style={{ padding: 20, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>No available technicians</div>
                  ) : (
                    addTechList.map(t => (
                      <button key={t.id} onClick={() => addTechToJob(t.id)} disabled={addTechBusy}
                        style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 8px", border: "none", background: "transparent", cursor: addTechBusy ? "wait" : "pointer", borderRadius: 8, fontFamily: FF, textAlign: "left" }}
                        onMouseEnter={e => e.currentTarget.style.background = "#F7F6F3"}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <div style={{ width: 32, height: 32, borderRadius: "50%", backgroundColor: "#F0FDFB", color: "#2D9B83", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                          {t.name.split(" ").map(p => p[0]).join("").slice(0, 2)}
                        </div>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{t.name}</div>
                          <div style={{ fontSize: 11, color: "#9E9B94", textTransform: "capitalize" }}>{t.role.replace("_", " ")}</div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </>
          )}

          {/* Add Team Member — fallback for jobs without commission display */}
          {(!canManageCommission || (job.estimated_hours ?? 0) === 0) && (
            <PS label="Team">
              <div style={{ fontSize: 12, color: "#1A1917", marginBottom: 8 }}>
                {assignedEmp?.name || job.assigned_user_name || "Unassigned"}
                {commTechs.length > 1 && ` + ${commTechs.length - 1} more`}
              </div>
              <button onClick={() => setAddTechOpen(true)}
                style={{ width: "100%", height: 32, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#2D9B83", border: "1px dashed #2D9B83", borderRadius: 8, background: "transparent", cursor: "pointer", fontFamily: FF }}>
                <Plus size={12} /> Add Team Member
              </button>
            </PS>
          )}

          {/* Supply Log */}
          <PS label="Supplies Used">
            {supplyOpen ? (
              <div style={{ border: "1px solid #E5E2DC", borderRadius: 8, padding: 12, backgroundColor: "#F8F7F4" }}>
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  <input value={supplyName} onChange={e => setSupplyName(e.target.value)} placeholder="Item name"
                    style={{ flex: 2, height: 32, padding: "0 10px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: FF, outline: "none" }} />
                  <input value={supplyQty} onChange={e => setSupplyQty(e.target.value)} type="number" min="0.1" step="0.1" style={{ flex: 0, width: 52, height: 32, padding: "0 8px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, outline: "none" }} />
                  <select value={supplyUnit} onChange={e => setSupplyUnit(e.target.value)}
                    style={{ flex: 0, width: 64, height: 32, border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 11, background: "#FFFFFF" }}>
                    <option value="units">units</option>
                    <option value="oz">oz</option>
                    <option value="bottles">bottles</option>
                    <option value="rolls">rolls</option>
                    <option value="bags">bags</option>
                  </select>
                  <button onClick={addSupply} style={{ width: 32, height: 32, backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 6, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Plus size={12} />
                  </button>
                </div>
                {supplies.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    {supplies.map((s, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#1A1917", marginBottom: 3 }}>
                        <span>{s.name}</span><span style={{ color: "#6B7280" }}>{s.qty} {s.unit}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => { setSupplyOpen(false); setSupplies([]); }} style={{ fontSize: 11, color: "#9E9B94", border: "none", background: "none", cursor: "pointer", fontFamily: FF }}>Cancel</button>
                  {supplies.length > 0 && (
                    <button onClick={logSupplies} style={{ fontSize: 11, fontWeight: 600, color: "var(--brand)", border: "none", background: "none", cursor: "pointer", fontFamily: FF }}>
                      Save {supplies.length} item{supplies.length > 1 ? "s" : ""}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <button onClick={() => setSupplyOpen(true)}
                style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#6B7280", border: "1px dashed #D1D5DB", borderRadius: 6, background: "none", cursor: "pointer", padding: "6px 10px", fontFamily: FF }}>
                <Package size={12} /> Log supplies used
              </button>
            )}
          </PS>
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
          {/* Charge Client — owner/admin only, completed Stripe jobs not yet charged */}
          {canCharge && job.status === "complete" && !job.charge_succeeded_at && (
            <button onClick={openChargeModal}
              style={{ padding: "10px 12px", border: "1px solid #6EE7B7", borderRadius: 8, backgroundColor: "#ECFDF5", color: "#065F46", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF, display: "flex", alignItems: "center", gap: 5 }}>
              <DollarSign size={13} /> Charge Client
            </button>
          )}
          <button onClick={() => {
            setRescheduleOpen(true); setRescheduleSuccess(""); setRescheduleReason(""); setRescheduleReasonOther("");
            setRescheduleDate(job.scheduled_date || ""); setRescheduleHour(null);
            setAvailSlots([]); setTechList([]); setSelectedTechId(job.assigned_user_id); setRescheduleCount(null);
          }}
            style={{ padding: "10px 12px", border: "1px solid #BFDBFE", borderRadius: 8, backgroundColor: "#EFF6FF", color: "#1D4ED8", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
            Reschedule
          </button>
          {job.status !== "cancelled" && job.status !== "complete" && (
            <button onClick={() => setCancelOpen(true)} disabled={busy}
              style={{ padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 8, backgroundColor: "#F8F7F4", color: "#6B7280", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
              Cancel Job
            </button>
          )}
        </div>
      </div>

      {/* Charge Confirmation Modal */}
      {chargeOpen && (
        <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.5)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ backgroundColor: "#FFFFFF", borderRadius: 12, padding: 28, width: "100%", maxWidth: 400, fontFamily: FF }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 17, fontWeight: 800, color: "#1A1917" }}>Confirm Payment</h3>
            <p style={{ margin: "0 0 20px", fontSize: 13, color: "#6B7280" }}>Charge the card on file for this completed job.</p>
            <div style={{ background: "#F7F6F3", borderRadius: 8, padding: "14px 16px", marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: "#6B7280" }}>Client</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#1A1917" }}>{job.client_name}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: "#6B7280" }}>Card</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#1A1917" }}>
                  {chargeClientData
                    ? (chargeClientData.card_brand ? `${chargeClientData.card_brand.charAt(0).toUpperCase()}${chargeClientData.card_brand.slice(1)} ending in ${chargeClientData.card_last_four || "????"}` : "Card on file")
                    : "Loading..."}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 12, color: "#6B7280" }}>Amount</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: "#1A1917" }}>${chargeAmount.toFixed(2)}</span>
              </div>
            </div>
            {chargeError && (
              <div style={{ marginBottom: 16, padding: "10px 14px", background: "#FEE2E2", border: "1px solid #FECACA", borderRadius: 8, fontSize: 12, color: "#DC2626", lineHeight: 1.5 }}>
                {chargeError}
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setChargeOpen(false)} disabled={chargeBusy}
                style={{ flex: 1, padding: "10px", border: "1px solid #E5E2DC", borderRadius: 8, backgroundColor: "#F8F7F4", color: "#6B7280", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                Cancel
              </button>
              <button onClick={confirmCharge} disabled={chargeBusy}
                style={{ flex: 1, padding: "10px", border: "none", borderRadius: 8, backgroundColor: "var(--brand)", color: "#FFFFFF", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF, opacity: chargeBusy ? 0.7 : 1 }}>
                {chargeBusy ? "Charging..." : `Charge $${chargeAmount.toFixed(2)}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reschedule modal */}
      {rescheduleOpen && (() => {
        const canConfirm = !!rescheduleReason && !!rescheduleDate && rescheduleHour !== null && !!selectedTechId && !rescheduleBusy;
        const currentTechName = job.assigned_user_name || (employees.find(e => e.id === job.assigned_user_id)?.name) || "";
        const fmtJobDate = job.scheduled_date ? new Date(job.scheduled_date + "T12:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "Unscheduled";
        const REASONS = [
          { value: "client_request", label: "Client Request" },
          { value: "no_show_client", label: "No Show — Client" },
          { value: "no_show_tech", label: "No Show — Tech" },
          { value: "weather", label: "Weather" },
          { value: "tech_unavailable", label: "Tech Unavailable" },
          { value: "emergency", label: "Emergency" },
          { value: "other", label: "Other" },
        ];
        const handleConfirm = async () => {
          if (!canConfirm || rescheduleHour === null) return;
          setRescheduleBusy(true);
          const rescheduleTime = `${String(rescheduleHour).padStart(2, "0")}:00:00`;
          try {
            const newStatus = job.status === "cancelled" ? "scheduled" : job.status;
            const patch: Record<string, unknown> = { scheduled_date: rescheduleDate, scheduled_time: rescheduleTime, status: newStatus };
            if (selectedTechId !== null) patch.assigned_user_id = selectedTechId;
            await patchJob(job.id, patch, token);
            const reasonLabel = rescheduleReason === "other" ? (rescheduleReasonOther || "Other") : (REASONS.find(r => r.value === rescheduleReason)?.label || rescheduleReason);
            const notesText = `Rescheduled to ${rescheduleDate} at ${fmtHour(rescheduleHour)} — ${reasonLabel}`;
            await fetch(`${_API2}/api/cancellations`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ job_id: job.id, customer_id: job.client_id, cancel_reason: rescheduleReason, notes: notesText }),
            }).catch(() => {});
            const newCount = (rescheduleCount ?? 0) + 1;
            const isRecurring = job.frequency && job.frequency !== "on_demand";
            if (isRecurring && newCount >= 3) {
              fetch(`${_API2}/api/churn/flag/${job.client_id}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ reschedule_count: newCount }),
              }).catch(() => {});
            }
            const techName = techList.find(t => t.id === selectedTechId)?.name || (selectedTechId === job.assigned_user_id ? currentTechName : "");
            const fmtNew = new Date(rescheduleDate + "T12:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
            setRescheduleSuccess(`Job rescheduled to ${fmtNew} at ${fmtHour(rescheduleHour)}${techName ? ` with ${techName}` : ""}`);
            onUpdate();
          } catch {
            toast({ title: "Error", description: "Could not reschedule", variant: "destructive" });
            setRescheduleOpen(false);
          } finally { setRescheduleBusy(false); }
        };
        return (
          <>
            <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.5)", zIndex: 299 }} onClick={() => !rescheduleBusy && setRescheduleOpen(false)} />
            <div style={mobile
              ? { position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 300, backgroundColor: "#F7F6F3", borderRadius: "16px 16px 0 0", maxHeight: "92vh", display: "flex", flexDirection: "column", fontFamily: FF }
              : { position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 300, backgroundColor: "#F7F6F3", borderRadius: 16, width: "100%", maxWidth: 620, maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.25)", fontFamily: FF }
            }>
              {/* Sticky header */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px 16px", backgroundColor: "#FFFFFF", borderRadius: mobile ? "16px 16px 0 0" : "16px 16px 0 0", borderBottom: "1px solid #E5E2DC", flexShrink: 0 }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: "#1A1917" }}>Reschedule Job</span>
                <button onClick={() => !rescheduleBusy && setRescheduleOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", padding: 6, display: "flex", alignItems: "center" }} type="button">
                  <X size={18} color="#6B6860" />
                </button>
              </div>

              {/* Scrollable body */}
              <div style={{ overflowY: "auto", flex: 1, padding: "0 0 8px" }}>
                {rescheduleSuccess ? (
                  <div style={{ padding: "32px 20px", textAlign: "center" }}>
                    <CheckCircle size={40} color="#16A34A" style={{ marginBottom: 12 }} />
                    <p style={{ fontSize: 15, fontWeight: 600, color: "#15803D", marginBottom: 20 }}>{rescheduleSuccess}</p>
                    <button onClick={() => { setRescheduleOpen(false); setRescheduleSuccess(""); onClose(); }}
                      style={{ width: "100%", padding: "12px", border: "none", borderRadius: 10, background: "#16A34A", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
                      Done
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Section 1 — Job Summary */}
                    <div style={{ margin: "16px 20px 0", backgroundColor: "#FFFFFF", borderRadius: 12, border: "1px solid #E5E2DC", padding: "14px 16px" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 8 }}>Job Summary</span>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 0", fontSize: 13, color: "#1A1917", fontWeight: 500, lineHeight: 1.6 }}>
                        <span style={{ fontWeight: 700 }}>{job.client_name}</span>
                        <span style={{ color: "#9E9B94", margin: "0 6px" }}>—</span>
                        <span>{fmtSvc(job.service_type)}</span>
                        <span style={{ color: "#9E9B94", margin: "0 6px" }}>—</span>
                        <span style={{ color: "#6B6860" }}>{fmtJobDate}{job.scheduled_time ? ` at ${fmtTime(job.scheduled_time)}` : ""}</span>
                        {currentTechName && <><span style={{ color: "#9E9B94", margin: "0 6px" }}>—</span><span style={{ color: "#6B6860" }}>{currentTechName}</span></>}
                        {job.amount > 0 && <><span style={{ color: "#9E9B94", margin: "0 6px" }}>—</span><span style={{ color: "#6B6860" }}>${Number(job.amount).toFixed(2)}</span></>}
                      </div>
                      {rescheduleCount !== null && rescheduleCount > 0 && (() => {
                        const rc = rescheduleCount;
                        const bg = rc >= 4 ? "#FEE2E2" : rc >= 2 ? "#FEF3C7" : "#DCFCE7";
                        const txt = rc >= 4 ? "#991B1B" : rc >= 2 ? "#92400E" : "#15803D";
                        const border = rc >= 4 ? "#FCA5A5" : rc >= 2 ? "#FCD34D" : "#86EFAC";
                        return (
                          <div style={{ marginTop: 10, padding: "6px 10px", borderRadius: 8, backgroundColor: bg, border: `1px solid ${border}`, display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <AlertTriangle size={12} color={txt} />
                            <span style={{ fontSize: 12, fontWeight: 600, color: txt }}>
                              {job.client_name.split(" ")[0]} has rescheduled {rc} time{rc !== 1 ? "s" : ""} in the last 90 days
                            </span>
                          </div>
                        );
                      })()}
                    </div>

                    {/* Section 2 — Reason */}
                    <div style={{ margin: "14px 20px 0", backgroundColor: "#FFFFFF", borderRadius: 12, border: "1px solid #E5E2DC", padding: "14px 16px" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 10 }}>Reason for Reschedule <span style={{ color: "#EF4444" }}>*</span></span>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {REASONS.map(r => (
                          <button key={r.value} type="button" onClick={() => setRescheduleReason(r.value)}
                            style={{ padding: "10px 14px", borderRadius: 8, border: `1.5px solid ${rescheduleReason === r.value ? "var(--brand, #00C9A0)" : "#E5E2DC"}`, backgroundColor: rescheduleReason === r.value ? "rgba(0,201,160,0.08)" : "#F7F6F3", fontSize: 13, fontWeight: rescheduleReason === r.value ? 600 : 400, color: rescheduleReason === r.value ? "var(--brand, #00C9A0)" : "#1A1917", cursor: "pointer", textAlign: "left", fontFamily: FF, touchAction: "manipulation", minHeight: 44 }}>
                            {r.label}
                          </button>
                        ))}
                        {rescheduleReason === "other" && (
                          <input value={rescheduleReasonOther} onChange={e => setRescheduleReasonOther(e.target.value)}
                            placeholder="Describe the reason..."
                            style={{ padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, outline: "none", color: "#1A1917" }} />
                        )}
                      </div>
                    </div>

                    {/* Section 3 — New Date + Availability */}
                    <div style={{ margin: "14px 20px 0", backgroundColor: "#FFFFFF", borderRadius: 12, border: "1px solid #E5E2DC", padding: "14px 16px" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 10 }}>New Date & Time <span style={{ color: "#EF4444" }}>*</span></span>
                      <input type="date" value={rescheduleDate} onChange={e => { setRescheduleDate(e.target.value); setRescheduleHour(null); }}
                        style={{ width: "100%", height: 44, padding: "0 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: FF, backgroundColor: "#F7F6F3" }} />
                      {rescheduleDate && (
                        <div style={{ marginTop: 14 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "#6B6860", display: "block", marginBottom: 8 }}>
                            {availLoading ? "Loading availability..." : "Tap a time slot to select"}
                          </span>
                          {!availLoading && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                              {availSlots.map(slot => {
                                const isSelected = rescheduleHour === slot.hour;
                                return (
                                  <button key={slot.hour} type="button" onClick={() => setRescheduleHour(slot.hour)}
                                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", minHeight: 44, borderRadius: 8, border: `1.5px solid ${isSelected ? "var(--brand, #00C9A0)" : "#E5E2DC"}`, backgroundColor: isSelected ? "var(--brand, #00C9A0)" : slotBg(slot.count), cursor: "pointer", fontFamily: FF, touchAction: "manipulation" }}>
                                    <span style={{ fontSize: 13, fontWeight: 600, color: isSelected ? "#FFFFFF" : "#1A1917" }}>{fmtHour(slot.hour)}</span>
                                    <span style={{ fontSize: 12, fontWeight: 600, color: isSelected ? "#FFFFFF" : slotTxt(slot.count), padding: "2px 10px", borderRadius: 20, backgroundColor: isSelected ? "rgba(255,255,255,0.25)" : "transparent" }}>{slotLbl(slot.count)}</span>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Section 4 — Team Assignment */}
                    {rescheduleHour !== null && (
                      <div style={{ margin: "14px 20px 0", backgroundColor: "#FFFFFF", borderRadius: 12, border: "1px solid #E5E2DC", padding: "14px 16px" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 10 }}>Team Assignment</span>
                        {techLoading ? (
                          <p style={{ fontSize: 13, color: "#6B6860", margin: 0 }}>Loading team availability...</p>
                        ) : techList.length === 0 ? (
                          <p style={{ fontSize: 13, color: "#6B6860", margin: 0 }}>No team members found.</p>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {[...techList].sort((a, b) => (b.id === job.assigned_user_id ? 1 : 0) - (a.id === job.assigned_user_id ? 1 : 0)).map(tech => {
                              const isSelected = selectedTechId === tech.id;
                              const isCurrent = tech.id === job.assigned_user_id;
                              return (
                                <button key={tech.id} type="button" onClick={() => setSelectedTechId(tech.id)}
                                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", minHeight: 52, borderRadius: 10, border: `1.5px solid ${isSelected ? "var(--brand, #00C9A0)" : "#E5E2DC"}`, backgroundColor: isSelected ? "rgba(0,201,160,0.07)" : "#F7F6F3", cursor: "pointer", textAlign: "left", fontFamily: FF, touchAction: "manipulation", width: "100%" }}>
                                  <div>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                      <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{tech.name}</span>
                                      {isCurrent && <span style={{ fontSize: 10, fontWeight: 700, color: "#6B6860", backgroundColor: "#E5E2DC", padding: "2px 7px", borderRadius: 20 }}>Currently assigned</span>}
                                    </div>
                                    <span style={{ fontSize: 11, color: "#9E9B94" }}>{tech.jobs_today} job{tech.jobs_today !== 1 ? "s" : ""} today</span>
                                  </div>
                                  {tech.has_conflict && (
                                    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 6, backgroundColor: "#FEE2E2", border: "1px solid #FCA5A5" }}>
                                      <AlertTriangle size={12} color="#991B1B" />
                                      <span style={{ fontSize: 11, fontWeight: 600, color: "#991B1B" }}>Conflict</span>
                                    </div>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                    <div style={{ height: 16 }} />
                  </>
                )}
              </div>

              {/* Sticky confirm button */}
              {!rescheduleSuccess && (
                <div style={{ padding: "12px 20px", borderTop: "1px solid #E5E2DC", backgroundColor: "#FFFFFF", flexShrink: 0 }}>
                  <button type="button" disabled={!canConfirm} onClick={handleConfirm}
                    style={{ width: "100%", padding: "14px", border: "none", borderRadius: 10, background: canConfirm ? "var(--brand, #00C9A0)" : "#E5E2DC", color: canConfirm ? "#FFFFFF" : "#9E9B94", fontSize: 14, fontWeight: 700, cursor: canConfirm ? "pointer" : "not-allowed", fontFamily: FF, touchAction: "manipulation", transition: "background 0.15s" }}>
                    {rescheduleBusy ? "Saving..." : "Confirm Reschedule"}
                  </button>
                </div>
              )}
            </div>
          </>
        );
      })()}

      {/* SMS Compose Sheet */}
      {smsOpen && (() => {
        const CHIPS = ["On my way", "Running 15 minutes late", "Outside your home", "Job complete — thank you"];
        const handleSend = async () => {
          if (!smsMessage.trim() || smsBusy) return;
          setSmsBusy(true);
          try {
            const r = await fetch(`${_API2}/api/communications/sms`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ customer_id: job.client_id, job_id: job.id, message: smsMessage.trim() }),
            });
            const d = await r.json();
            if (!r.ok) {
              if (d.error === "sms_unconfigured") {
                toast({ title: "SMS not configured", description: d.message, variant: "destructive" });
              } else {
                toast({ title: "Send failed", description: d.message || "Could not send message", variant: "destructive" });
              }
            } else {
              toast({ title: "Message sent" });
              setSmsOpen(false);
            }
          } catch {
            toast({ title: "Network error", description: "Could not send message", variant: "destructive" });
          } finally {
            setSmsBusy(false);
          }
        };
        return (
          <>
            <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.45)", zIndex: 399 }} onClick={() => !smsBusy && setSmsOpen(false)} />
            <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 400, backgroundColor: "#FFFFFF", borderRadius: "20px 20px 0 0", boxShadow: "0 -8px 40px rgba(0,0,0,0.18)", fontFamily: FF, maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
              <div style={{ width: 40, height: 4, backgroundColor: "#E5E2DC", borderRadius: 2, margin: "12px auto 0", flexShrink: 0 }} />
              <div style={{ padding: "16px 20px 14px", borderBottom: "1px solid #EEECE7", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: "#1A1917" }}>Send SMS</span>
                <button onClick={() => setSmsOpen(false)} style={{ border: "none", background: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}><X size={18} /></button>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
                {smsTwilioOk === false && (
                  <div style={{ marginBottom: 14, padding: "10px 14px", backgroundColor: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 8 }}>
                    <p style={{ margin: 0, fontSize: 12, color: "#92400E", lineHeight: 1.5 }}>
                      SMS not configured — add Twilio keys in Company Settings to enable messaging.
                    </p>
                  </div>
                )}
                <div style={{ marginBottom: 14, padding: "10px 14px", backgroundColor: "#F9F8F7", borderRadius: 8, border: "1px solid #E5E2DC" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>To</span>
                  <p style={{ margin: "4px 0 0", fontSize: 14, color: "#1A1917", fontWeight: 600 }}>{job.client_name} <span style={{ fontWeight: 400, color: "#6B7280" }}>({job.client_phone})</span></p>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 8 }}>Quick Messages</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {CHIPS.map(chip => (
                      <button key={chip} onClick={() => setSmsMessage(chip)}
                        style={{ padding: "6px 12px", borderRadius: 20, border: "1px solid #E5E2DC", backgroundColor: smsMessage === chip ? "#ECFDF5" : "#F9F8F7", color: smsMessage === chip ? "#059669" : "#4B4A47", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                        {chip}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 8 }}>Message</span>
                  <textarea value={smsMessage} onChange={e => setSmsMessage(e.target.value)}
                    placeholder="Type a message..."
                    rows={4}
                    style={{ width: "100%", padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 10, fontSize: 14, fontFamily: FF, resize: "vertical", outline: "none", boxSizing: "border-box", color: "#1A1917", lineHeight: 1.5 }} />
                  <p style={{ margin: "4px 0 0", fontSize: 11, color: "#9E9B94", textAlign: "right" }}>{smsMessage.length}/160</p>
                </div>
              </div>
              <div style={{ padding: "12px 20px 28px", borderTop: "1px solid #EEECE7", flexShrink: 0 }}>
                <button onClick={handleSend} disabled={smsBusy || !smsMessage.trim()}
                  style={{ width: "100%", padding: "14px 0", borderRadius: 12, border: "none", backgroundColor: smsMessage.trim() && !smsBusy ? "#059669" : "#E5E2DC", color: smsMessage.trim() && !smsBusy ? "#FFFFFF" : "#9E9B94", fontSize: 15, fontWeight: 700, cursor: smsMessage.trim() && !smsBusy ? "pointer" : "not-allowed", fontFamily: FF, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "background 0.15s" }}>
                  <Send size={16} />
                  {smsBusy ? "Sending..." : "Send Message"}
                </button>
              </div>
            </div>
          </>
        );
      })()}

      {/* Cancel modal */}
      {cancelOpen && (
        <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300, fontFamily: FF }}>
          <div style={{ backgroundColor: "#FFFFFF", borderRadius: 12, padding: 28, width: 420, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700, color: "#1A1917" }}>Cancel Job</h3>
            <p style={{ margin: "0 0 14px", fontSize: 13, color: "#6B7280" }}>
              Job for <strong>{job.client_name}</strong> on {new Date(job.scheduled_date + "T12:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </p>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>Reason</label>
              <select value={cancelReason} onChange={e => setCancelReason(e.target.value)}
                style={{ width: "100%", height: 36, padding: "0 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, outline: "none", background: "#FFFFFF" }}>
                <option value="customer_request">Customer Request</option>
                <option value="no_show">No Show</option>
                <option value="weather">Weather</option>
                <option value="emergency">Emergency</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>Notes (optional)</label>
              <textarea value={cancelNote} onChange={e => setCancelNote(e.target.value)} rows={2}
                style={{ width: "100%", padding: "8px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, resize: "vertical", fontFamily: FF, outline: "none", boxSizing: "border-box" }} />
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setCancelOpen(false)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, background: "#FFFFFF", cursor: "pointer", fontFamily: FF }}>Keep Job</button>
              <button onClick={cancelJob} disabled={busy}
                style={{ padding: "8px 20px", background: "#EF4444", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
                {busy ? "Cancelling..." : "Confirm Cancel"}
              </button>
            </div>
          </div>
        </div>
      )}
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
  const isCommercial = !!job.account_id;
  return (
    <div onClick={onClick} style={{
      backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12,
      padding: "14px 16px", marginBottom: 10, cursor: "pointer",
      borderLeft: `4px solid ${sc.dot}`, fontFamily: FF,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#1A1917" }}>{job.client_name}</div>
            {isCommercial && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: "var(--brand-dim, #EBF4FF)", color: "var(--brand, #00C9A0)" }}>
                <Building2 size={9}/> Comm.
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "var(--brand)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>{fmtSvc(job.service_type)}</div>
        </div>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 20, backgroundColor: sc.bg, border: `1px solid ${sc.border}`, fontSize: 11, fontWeight: 700, color: sc.text, textTransform: "capitalize", flexShrink: 0, marginLeft: 10 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: sc.dot }} />
          {job.status.replace("_", " ")}
        </span>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        {job.scheduled_time && (
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#6B7280" }}>
            <Clock size={12} style={{ color: "#9E9B94" }} />
            {fmtTime(job.scheduled_time)}
            <span style={{ color: "#C4C0BB" }}>·</span>
            {Math.floor(job.duration_minutes / 60)}h{job.duration_minutes % 60 > 0 ? ` ${job.duration_minutes % 60}m` : ""}
          </div>
        )}
        {job.frequency && job.frequency !== "on_demand" && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, color: "var(--brand)", background: "var(--brand-dim, #f0fdf9)", padding: "2px 7px", borderRadius: 4 }}>
            <Repeat size={9} />{job.frequency.replace(/_/g, " ")}
          </span>
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
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isCommercial && job.billing_method === "hourly" && job.hourly_rate
            ? <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1917" }}>${job.hourly_rate.toFixed(0)}/hr{job.estimated_hours ? ` · est. ${job.estimated_hours}h` : ""}</span>
            : <span style={{ fontSize: 14, fontWeight: 800, color: "#1A1917" }}>${(job.billed_amount ?? job.amount ?? 0).toFixed(2)}</span>
          }
          {job.est_pay_per_tech != null && job.est_pay_per_tech > 0 && (
            <span style={{ fontSize: 11, fontWeight: 700, color: "#16A34A" }}>· ${job.est_pay_per_tech.toFixed(2)} comm.</span>
          )}
          {job.charge_failed_at && !job.charge_succeeded_at && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "#FEE2E2", color: "#991B1B" }}>
              <AlertTriangle size={9}/> Charge failed
            </span>
          )}
          {isCommercial && job.property_access_notes && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "#FFFBEB", color: "#92400E" }}>
              <AlertTriangle size={9}/> Access req.
            </span>
          )}
        </div>
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

// ─── DESKTOP: JOB HOVER CARD ────────────────────────────────────────────────
function JobHoverCard({ job, assignedName }: { job: DispatchJob; assignedName?: string }) {
  const endTime = minsToStr(timeToMins(job.scheduled_time) + job.duration_minutes);
  const hrs = (job.duration_minutes / 60).toFixed(1);
  const isRecurring = job.frequency && job.frequency !== "on_demand";
  const clockedIn = job.clock_entry?.clock_in_at;
  const clockStatus = clockedIn
    ? (job.clock_entry?.clock_out_at ? "Clocked out" : "Clocked in")
    : (job.status === "complete" ? "Complete" : "Not clocked in");
  const clockColor = clockedIn
    ? (job.clock_entry?.clock_out_at ? "#6B7280" : "#16A34A")
    : (job.status === "complete" ? "#6B7280" : "#D97706");

  return (
    <div onClick={e => e.stopPropagation()} style={{
      position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 100,
      width: 320, backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC",
      borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,0.14)",
      fontFamily: FF, padding: 0, overflow: "hidden",
    }}>
      <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid #F0EEE9" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", marginBottom: 2 }}>{job.client_name}</div>
        {job.address && <div style={{ fontSize: 12, color: "#6B6860", marginBottom: 6 }}>{job.address}</div>}
        {job.client_phone && (
          <a href={`tel:${job.client_phone}`} style={{ fontSize: 12, color: "#2D9B83", textDecoration: "none", fontWeight: 600 }}>
            {job.client_phone}
          </a>
        )}
      </div>

      <div style={{ padding: "10px 16px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px" }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.04em" }}>Service</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917", marginTop: 2 }}>{fmtSvc(job.service_type)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.04em" }}>Frequency</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917", marginTop: 2 }}>{isRecurring ? fmtSvc(job.frequency) : "One Time"}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.04em" }}>Time</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917", marginTop: 2 }}>{fmtTime(job.scheduled_time)} \u2013 {fmtTime(endTime)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.04em" }}>Duration</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917", marginTop: 2 }}>{hrs}h</div>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.04em" }}>Amount</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", marginTop: 2 }}>${(job.amount || 0).toFixed(0)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.04em" }}>Clock Status</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: clockColor, marginTop: 2 }}>{clockStatus}</div>
        </div>
      </div>

      {/* Team section */}
      <div style={{ padding: "8px 16px 10px", borderTop: "1px solid #F0EEE9" }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>Team</div>
        {job.technicians && job.technicians.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {job.technicians.map((t, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 22, height: 22, borderRadius: "50%", backgroundColor: t.is_primary ? "#DCFCE7" : "#F3F4F6", color: t.is_primary ? "#15803D" : "#6B7280", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700 }}>
                    {t.name.split(" ").map(p => p[0]).join("").slice(0, 2)}
                  </div>
                  <span style={{ fontWeight: 600, color: "#1A1917" }}>{t.name}</span>
                  {t.is_primary && <span style={{ fontSize: 9, color: "#9E9B94" }}>Primary</span>}
                </div>
                <span style={{ fontWeight: 600, color: "#6B6860" }}>${(t.final_pay || t.calc_pay || 0).toFixed(0)}</span>
              </div>
            ))}
          </div>
        ) : assignedName ? (
          <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917" }}>{assignedName}</div>
        ) : (
          <div style={{ fontSize: 12, color: "#D97706", fontWeight: 600 }}>Unassigned</div>
        )}
      </div>

      {/* Zone + notes */}
      {(job.zone_name || job.office_notes) && (
        <div style={{ padding: "8px 16px 12px", borderTop: "1px solid #F0EEE9" }}>
          {job.zone_name && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: job.office_notes ? 6 : 0 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: job.zone_color || "#9E9B94" }} />
              <span style={{ fontSize: 11, color: "#6B6860", fontWeight: 600 }}>{job.zone_name}</span>
            </div>
          )}
          {job.office_notes && (
            <div style={{ fontSize: 11, color: "#6B6860", fontStyle: "italic", lineHeight: 1.4 }}>
              {job.office_notes.length > 120 ? job.office_notes.slice(0, 120) + "..." : job.office_notes}
            </div>
          )}
        </div>
      )}

      <div style={{ padding: "8px 16px 12px", borderTop: "1px solid #F0EEE9", fontSize: 11, color: "#9E9B94", textAlign: "center" }}>
        Click to open full details
      </div>
    </div>
  );
}

// ─── DESKTOP: JOB CHIP ─────────────────────────────────────────────────────────
function JobChip({ job, onClick, assignedName, isUnassigned }: { job: DispatchJob; onClick: (j: DispatchJob) => void; assignedName?: string; isUnassigned?: boolean }) {
  const sc = STATUS[job.status] || STATUS.scheduled;
  const left = ((timeToMins(job.scheduled_time) - DAY_START) / 30) * SLOT_W;
  const width = Math.max(SLOT_W, (job.duration_minutes / 30) * SLOT_W);
  const isComplete = job.status === "complete";
  const isRecurring = job.frequency && job.frequency !== "on_demand";
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `chip-${job.id}`, data: { job, originalLeft: left, type: isUnassigned ? "unassigned" : undefined }, disabled: isComplete });
  const borderColor = job.zone_color || sc.dot;

  const [hovered, setHovered] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onEnter() { hoverTimer.current = setTimeout(() => setHovered(true), 400); }
  function onLeave() { if (hoverTimer.current) clearTimeout(hoverTimer.current); setHovered(false); }

  return (
    <div ref={setNodeRef}
      onClick={e => { e.stopPropagation(); setHovered(false); onClick(job); }}
      onMouseEnter={onEnter} onMouseLeave={onLeave}
      {...(isComplete ? {} : { ...listeners, ...attributes })}
      style={{ position: "absolute", top: 10, left, width, height: ROW_H - 20, borderRadius: 8, backgroundColor: sc.bg, borderLeft: `3px solid ${borderColor}`, padding: "6px 8px", boxSizing: "border-box", overflow: "visible", cursor: isComplete ? "default" : isDragging ? "grabbing" : "grab", opacity: isDragging ? 0.3 : 1, transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined, zIndex: hovered ? 50 : isDragging ? 0 : 2, userSelect: "none", display: "flex", flexDirection: "column", justifyContent: "center", gap: 2, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
        {job.clock_entry?.clock_in_at && <Clock size={9} style={{ color: sc.dot, flexShrink: 0 }} />}
        {job.after_photo_count > 0 && <Camera size={9} style={{ color: sc.dot, flexShrink: 0 }} />}
        {isRecurring && <Repeat size={9} style={{ color: sc.dot, flexShrink: 0 }} />}
        <span style={{ fontSize: 11, fontWeight: 700, color: "#1A1917", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{job.client_name}</span>
      </div>
      <span style={{ fontSize: 10, color: "#6B7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fmtSvc(job.service_type)}</span>
      {width > 130 && (assignedName
        ? <span style={{ fontSize: 9, color: "#9E9B94", display: "flex", alignItems: "center", gap: 3 }}><User size={8} />{assignedName}</span>
        : <span style={{ fontSize: 9, color: "#9E9B94" }}>{fmtTime(job.scheduled_time)} – {fmtTime(minsToStr(timeToMins(job.scheduled_time) + job.duration_minutes))}</span>
      )}
      {hovered && !isDragging && <JobHoverCard job={job} assignedName={assignedName} />}
    </div>
  );
}

// ─── DESKTOP: EMPLOYEE ROW ────────────────────────────────────────────────────
const TIME_OFF_BG: Record<string, string> = {
  pto:    "#FFF9C4",
  sick:   "#FFF176",
  absent: "#FFEBEE",
};

// Time-off band covers the full dispatch timeline (since the board IS business hours)
function getBandLeft()  { return 0; }
function getBandWidth() { return TOTAL_SLOTS * SLOT_W; }

function EmployeeRow({ employee, onChipClick, nowLine }: { employee: Employee; onChipClick: (j: DispatchJob) => void; nowLine: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: `row-${employee.id}` });
  const initials = employee.name.split(" ").map((p: string) => p[0]).join("").toUpperCase().slice(0, 2);
  const totalMins = employee.jobs.reduce((s: number, j: DispatchJob) => s + j.duration_minutes, 0);
  const revenue = employee.jobs.reduce((s: number, j: DispatchJob) => s + (j.amount || 0), 0);
  const commission = employee.commission_rate != null ? revenue * (employee.commission_rate / 100) : null;
  const isClockedIn = employee.jobs.some(j => j.clock_entry?.clock_in_at && !j.clock_entry?.clock_out_at);
  const timeOffBg = employee.time_off ? TIME_OFF_BG[employee.time_off] : null;
  return (
    <div style={{ display: "flex", borderBottom: "1px solid #EEECE7", height: ROW_H }}>
      <div style={{ position: "sticky", left: 0, zIndex: 5, width: COL_W, flexShrink: 0, backgroundColor: timeOffBg || "#FFFFFF", borderRight: "1px solid #E5E2DC", display: "flex", alignItems: "center", padding: "0 12px", gap: 9 }}>
        <div style={{ position: "relative", flexShrink: 0 }}>
          <div style={{ width: 32, height: 32, borderRadius: "50%", backgroundColor: "var(--brand-dim)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800 }}>{initials}</div>
          {isClockedIn && <div style={{ position: "absolute", bottom: 0, right: 0, width: 9, height: 9, borderRadius: "50%", backgroundColor: "#22C55E", border: "2px solid #FFFFFF" }} title="Clocked in" />}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{employee.name}</span>
            {employee.zone && <div style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: employee.zone.zone_color, flexShrink: 0 }} title={employee.zone.zone_name} />}
          </div>
          <div style={{ fontSize: 9, color: "#9E9B94", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.05em" }}>{employee.role}</div>
          <div style={{ fontSize: 10, color: "#6B6860", marginTop: 1 }}>
            {employee.jobs.length}j · {Math.floor(totalMins / 60)}h · ${revenue.toFixed(0)} · ${commission != null ? commission.toFixed(0) : "0"}
          </div>
        </div>
      </div>
      <div ref={setNodeRef} style={{ position: "relative", width: TOTAL_SLOTS * SLOT_W, flexShrink: 0, height: ROW_H, backgroundColor: isOver ? "rgba(91,155,213,0.05)" : "transparent", transition: "background-color 0.1s" }}>
        {TIMES.map((_, i) => <div key={i} style={{ position: "absolute", left: i * SLOT_W, top: 0, bottom: 0, borderRight: i % 2 === 1 ? "1px solid #E5E2DC" : "1px solid #EEECE7" }} />)}
        {/* Time-off band sits behind job chips (zIndex 0) */}
        {timeOffBg && (
          <div style={{ position: "absolute", left: getBandLeft(), width: getBandWidth(), top: 0, bottom: 0, backgroundColor: timeOffBg, zIndex: 0, pointerEvents: "none" }} />
        )}
        {nowLine >= 0 && nowLine <= TOTAL_SLOTS * SLOT_W && <div style={{ position: "absolute", left: nowLine, top: 0, bottom: 0, width: 2, backgroundColor: "#EF4444", zIndex: 3, pointerEvents: "none" }} />}
        {employee.jobs.map(j => <JobChip key={j.id} job={j} onClick={onChipClick} assignedName={employee.name} />)}
        {employee.jobs.length === 0 && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 11, color: "#D0CEC9", letterSpacing: "0.02em" }}>No jobs scheduled</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DESKTOP: UNASSIGNED GANTT ROW ───────────────────────────────────────────
function UnassignedGanttRow({ jobs, onChipClick, nowLine }: { jobs: DispatchJob[]; onChipClick: (j: DispatchJob) => void; nowLine: number }) {
  if (jobs.length === 0) return null;
  return (
    <div style={{ display: "flex", borderBottom: "2px solid #FCD34D", height: ROW_H }}>
      <div style={{ position: "sticky", left: 0, zIndex: 5, width: COL_W, flexShrink: 0, backgroundColor: "#FFFBEB", borderRight: "1px solid #FCD34D", display: "flex", alignItems: "center", padding: "0 12px", gap: 9 }}>
        <div style={{ width: 32, height: 32, borderRadius: "50%", backgroundColor: "#FEF3C7", color: "#92400E", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, flexShrink: 0 }}>?</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#92400E" }}>Unassigned</div>
          <div style={{ fontSize: 10, color: "#D97706", marginTop: 1 }}>{jobs.length} job{jobs.length !== 1 ? "s" : ""} · needs assignment</div>
        </div>
      </div>
      <div style={{ position: "relative", width: TOTAL_SLOTS * SLOT_W, flexShrink: 0, height: ROW_H, backgroundColor: "#FFFBEB88" }}>
        {TIMES.map((_, i) => <div key={i} style={{ position: "absolute", left: i * SLOT_W, top: 0, bottom: 0, borderRight: i % 2 === 1 ? "1px solid #FDE68A" : "1px solid #FEF3C7" }} />)}
        {nowLine >= 0 && nowLine <= TOTAL_SLOTS * SLOT_W && <div style={{ position: "absolute", left: nowLine, top: 0, bottom: 0, width: 2, backgroundColor: "#EF4444", zIndex: 3, pointerEvents: "none" }} />}
        {jobs.map(j => <JobChip key={j.id} job={j} onClick={onChipClick} isUnassigned />)}
      </div>
    </div>
  );
}

// ─── DESKTOP: UNASSIGNED PANEL ────────────────────────────────────────────────
function LocationPill({ loc }: { loc?: string | null }) {
  if (!loc) return null;
  const isSchaumburg = loc === "schaumburg";
  return (
    <span style={{
      display: "inline-block", padding: "1px 5px", borderRadius: 6, fontSize: 9, fontWeight: 700,
      fontFamily: FF, letterSpacing: "0.03em", lineHeight: 1.5,
      backgroundColor: isSchaumburg ? "#2D6A4F" : "#5B9BD5", color: "#FFFFFF",
    }}>
      {isSchaumburg ? "SCH" : "OL"}
    </span>
  );
}

function UnassignedChip({ job, onClick }: { job: DispatchJob; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `unassigned-${job.id}`, data: { job, type: "unassigned", originalLeft: 0 } });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} onClick={onClick}
      style={{ backgroundColor: "#FEF9EE", borderLeft: "3px solid #F59E0B", borderRadius: 8, padding: "10px 12px", marginBottom: 6, cursor: "grab", opacity: isDragging ? 0.4 : 1, transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined, boxShadow: "0 1px 3px rgba(0,0,0,0.05)", userSelect: "none" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917" }}>{job.client_name}</div>
        <LocationPill loc={job.booking_location} />
      </div>
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
  const { activeBranchId } = useBranch();
  const isAllLocations = activeBranchId === "all";
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
  const [zoneDropdownOpen, setZoneDropdownOpen] = useState(false);
  const zoneDropdownRef = useRef<HTMLDivElement>(null);
  const [selectedLocationFilter, setSelectedLocationFilter] = useState<"all" | "oak_lawn" | "schaumburg">("all");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);

  const [, forceUpdate] = useState(0);

  // Load company dispatch hour settings once on mount
  useEffect(() => {
    const _API = import.meta.env.BASE_URL.replace(/\/$/, "");
    fetch(`${_API}/api/companies/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(c => {
        if (!c) return;
        const sh = c.dispatch_start_hour ?? 8;
        const eh = c.dispatch_end_hour ?? 18;
        if (sh !== DAY_START / 60 || eh !== DAY_END / 60) {
          DAY_START = sh * 60;
          DAY_END   = eh * 60;
          refreshTimeline();
          forceUpdate(n => n + 1); // trigger re-render with new timeline
        }
      })
      .catch(() => {});
  }, [token]);

  const load = useCallback(async () => {
    const id = ++refreshRef.current;
    setLoading(true);
    try {
      const d = await fetchDispatch(dateKey(selectedDate), token, activeBranchId);
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
  }, [selectedDate, token, activeBranchId]);

  useEffect(() => { load(); }, [load]);

  // Load zones for filter
  useEffect(() => {
    const API = import.meta.env.BASE_URL.replace(/\/$/, "");
    fetch(`${API}/api/zones`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : [])
      .then(d => setZones(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [token]);

  // Scroll to start of dispatch window on mount and date change
  useEffect(() => {
    if (!timelineRef.current) return;
    timelineRef.current.scrollLeft = 0;
  }, [selectedDate, loading]);

  // Close zone dropdown on outside click
  useEffect(() => {
    if (!zoneDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (zoneDropdownRef.current && !zoneDropdownRef.current.contains(e.target as Node)) {
        setZoneDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [zoneDropdownOpen]);

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
    // Optimistic update — move chip immediately without blocking the UI on a full reload
    const updatedJob: DispatchJob = { ...job, scheduled_time: minsToStr(newMins), assigned_user_id: empId };
    setData(prev => {
      if (!prev) return prev;
      const isFromUnassigned = active.data.current?.type === "unassigned";
      const newEmployees = prev.employees.map(emp => {
        const withoutJob = emp.jobs.filter(j => j.id !== job.id);
        if (emp.id === empId) return { ...emp, jobs: [...withoutJob, updatedJob] };
        return { ...emp, jobs: withoutJob };
      });
      const newUnassigned = isFromUnassigned
        ? prev.unassigned_jobs.filter(j => j.id !== job.id)
        : prev.unassigned_jobs;
      return { ...prev, employees: newEmployees, unassigned_jobs: newUnassigned };
    });
    try { await patchJob(job.id, patch, token); }
    catch { toast({ title: "Failed to update job", variant: "destructive" }); load(); }
  }
  function chipLeft(job: DispatchJob) { return ((timeToMins(job.scheduled_time) - DAY_START) / 30) * SLOT_W; }

  // Zone + location filtered dispatch data
  const filteredData = data ? {
    employees: data.employees.map(e => ({
      ...e,
      jobs: e.jobs.filter(j => {
        if (selectedZoneFilter !== null && j.zone_id !== selectedZoneFilter) return false;
        if (selectedLocationFilter !== "all" && j.booking_location !== selectedLocationFilter) return false;
        return true;
      }),
    })),
    unassigned_jobs: data.unassigned_jobs.filter(j => {
      if (selectedZoneFilter !== null && j.zone_id !== selectedZoneFilter) return false;
      if (selectedLocationFilter !== "all" && j.booking_location !== selectedLocationFilter) return false;
      return true;
    }),
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
      <DashboardLayout>
        {/* Negative margins cancel DashboardLayout's main padding so sections go edge-to-edge */}
        <div style={{ margin: "-16px -14px 0", fontFamily: FF }}>
          {/* Header */}
          <div style={{ backgroundColor: "#FFFFFF", borderBottom: "1px solid #EEECE7", padding: "12px 16px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#1A1917" }}>Dispatch</div>
              <button
                onClick={() => isAllLocations ? toast({ title: "Select a location first", description: "Choose Oak Lawn or Schaumburg to create a job.", variant: "destructive" }) : setShowWizard(true)}
                title={isAllLocations ? "Select a location to create jobs" : undefined}
                style={{ display: "flex", alignItems: "center", gap: 6, backgroundColor: isAllLocations ? "#9E9B94" : "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: isAllLocations ? "not-allowed" : "pointer", opacity: isAllLocations ? 0.7 : 1 }}>
                <Plus size={14} /> New Job
                {!isAllLocations && <kbd style={{ fontSize: 10, border: '1px solid rgba(255,255,255,0.45)', borderRadius: 3, padding: '1px 5px', color: 'rgba(255,255,255,0.8)', fontFamily: 'inherit' }}>⇧J</kbd>}
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
            <div style={{ display: "flex", gap: 0, backgroundColor: "#FFFFFF", borderBottom: "1px solid #EEECE7", overflowX: "auto" }}>
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
          <div style={{ backgroundColor: "#FFFFFF", borderBottom: "1px solid #EEECE7", padding: "8px 12px", display: "flex", gap: 4, overflowX: "auto" }}>
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

          {/* Location + Zone filter — mobile */}
          <div style={{ backgroundColor: "#FFFFFF", borderBottom: "1px solid #EEECE7", padding: "6px 14px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {/* Location segmented control */}
            <div style={{ display: "flex", border: "1.5px solid #E5E2DC", borderRadius: 7, overflow: "hidden", flexShrink: 0 }}>
              {([["all", "All"], ["oak_lawn", "OL"], ["schaumburg", "SCH"]] as const).map(([val, label]) => (
                <button key={val} onClick={() => setSelectedLocationFilter(val)} style={{
                  padding: "4px 9px", border: "none", cursor: "pointer", fontFamily: FF, fontSize: 11, fontWeight: 700,
                  backgroundColor: selectedLocationFilter === val ? (val === "schaumburg" ? "#2D6A4F" : val === "oak_lawn" ? "#5B9BD5" : "var(--brand)") : "#FAFAF9",
                  color: selectedLocationFilter === val ? "#FFFFFF" : "#6B7280",
                }}>{label}</button>
              ))}
            </div>

            {/* Zone dropdown */}
            {zones.length > 0 && (
              <div ref={zoneDropdownRef} style={{ position: "relative" }}>
                <button onClick={() => setZoneDropdownOpen(v => !v)} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 6, border: "1.5px solid #E5E2DC", backgroundColor: "#FAFAF9", color: "#6B7280", cursor: "pointer", fontFamily: FF }}>
                  {selectedZoneFilter !== null ? (
                    <>
                      <div style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: zones.find(z => z.id === selectedZoneFilter)?.color, flexShrink: 0 }} />
                      {zones.find(z => z.id === selectedZoneFilter)?.name}
                    </>
                  ) : "All Zones"}
                  <ChevronDown size={11} />
                </button>
                {zoneDropdownOpen && (
                  <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200, backgroundColor: "#fff", border: "1px solid #E5E2DC", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.10)", minWidth: 160, overflow: "hidden" }}>
                    <button onClick={() => { setSelectedZoneFilter(null); setZoneDropdownOpen(false); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", backgroundColor: selectedZoneFilter === null ? "var(--brand-dim)" : "transparent", color: selectedZoneFilter === null ? "var(--brand)" : "#1A1917", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>All Zones</button>
                    {zones.map(z => (
                      <button key={z.id} onClick={() => { setSelectedZoneFilter(z.id); setZoneDropdownOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "8px 12px", border: "none", backgroundColor: selectedZoneFilter === z.id ? `${z.color}18` : "transparent", color: selectedZoneFilter === z.id ? z.color : "#1A1917", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: z.color, flexShrink: 0 }} />
                        {z.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Job list */}
          <div style={{ padding: "12px 14px" }}>
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
      </DashboardLayout>
    );
  }

  // ── DESKTOP VIEW ─────────────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div style={{ display: "flex", height: "calc(100vh - 56px)", overflow: "hidden", fontFamily: FF, flexDirection: "column" }}>

          {/* TOP BAR — New Job + date nav + mini-cal popover + stats + zones + view toggle */}
          <div style={{ padding: "8px 16px", borderBottom: "1px solid #E5E2DC", backgroundColor: "#FFFFFF", display: "flex", alignItems: "center", gap: 10, flexShrink: 0, flexWrap: "nowrap" }}>
            {/* New Job button */}
            <button
              onClick={() => isAllLocations ? toast({ title: "Select a location first", description: "Choose Oak Lawn or Schaumburg to create a job.", variant: "destructive" }) : setShowWizard(true)}
              title={isAllLocations ? "Select a location to create jobs" : undefined}
              style={{ display: "flex", alignItems: "center", gap: 6, backgroundColor: isAllLocations ? "#9E9B94" : "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, padding: "7px 13px", fontSize: 13, fontWeight: 700, cursor: isAllLocations ? "not-allowed" : "pointer", flexShrink: 0, opacity: isAllLocations ? 0.7 : 1 }}>
              <Plus size={14} /> New Job
              {!isAllLocations && <kbd style={{ fontSize: 10, border: '1px solid rgba(255,255,255,0.45)', borderRadius: 3, padding: '1px 5px', color: 'rgba(255,255,255,0.8)', fontFamily: 'inherit' }}>⇧J</kbd>}
            </button>

            <div style={{ width: 1, height: 22, backgroundColor: "#E5E2DC", flexShrink: 0 }} />

            {/* Date nav */}
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <button onClick={() => setSelectedDate(d => addDays(d, -1))} style={{ border: "1px solid #E5E2DC", background: "#FAFAF9", borderRadius: 6, padding: "5px 8px", cursor: "pointer", display: "flex", color: "#6B7280" }}><ChevronLeft size={14} /></button>

              {/* Calendar popover trigger */}
              <div style={{ position: "relative" }}>
                <button onClick={() => setCalendarOpen(o => !o)}
                  style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid #E5E2DC", background: calendarOpen ? "var(--brand-dim)" : "#FAFAF9", borderRadius: 6, padding: "5px 12px", cursor: "pointer", minWidth: 170, justifyContent: "center" }}>
                  <Calendar size={13} style={{ color: "var(--brand)", flexShrink: 0 }} />
                  <span style={{ fontSize: 13, fontWeight: 800, color: "#1A1917" }}>{isToday ? "Today — " : ""}{dayLabel}</span>
                </button>
                {calendarOpen && (
                  <>
                    <div onClick={() => setCalendarOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 49 }} />
                    <div style={{ position: "absolute", top: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)", zIndex: 50, backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.12)", minWidth: 260 }}>
                      <MiniCalendar value={selectedDate} onChange={d => { setSelectedDate(d); setCalendarOpen(false); }} jobDates={jobDates} />
                    </div>
                  </>
                )}
              </div>

              <button onClick={() => setSelectedDate(d => addDays(d, 1))} style={{ border: "1px solid #E5E2DC", background: "#FAFAF9", borderRadius: 6, padding: "5px 8px", cursor: "pointer", display: "flex", color: "#6B7280" }}><ChevronRight size={14} /></button>
              {!isToday && <button onClick={() => { const t = new Date(); t.setHours(0,0,0,0); setSelectedDate(t); }} style={{ border: "1px solid var(--brand)", background: "var(--brand-dim)", borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontSize: 11, fontWeight: 700, color: "var(--brand)" }}>Today</button>}
            </div>

            <div style={{ display: "flex", gap: 8, marginLeft: "auto", alignItems: "center", flexWrap: "nowrap" }}>
              {/* Stats pills */}
              {!loading && data && [
                { label: `${stats.total} jobs`, color: "#1A1917", bg: "#F7F6F3" },
                { label: `${stats.complete} done`, color: "#16A34A", bg: "#DCFCE7" },
                ...(stats.inProgress > 0 ? [{ label: `${stats.inProgress} active`, color: "#D97706", bg: "#FEF3C7" }] : []),
                { label: `$${stats.revenue.toFixed(0)} rev`, color: "var(--brand)", bg: "var(--brand-dim)" },
                ...(stats.unassigned > 0 ? [{ label: `${stats.unassigned} unassigned`, color: "#DC2626", bg: "#FEE2E2" }] : []),
              ].map(s => (
                <span key={s.label} style={{ fontSize: 11, fontWeight: 700, color: s.color, backgroundColor: s.bg, padding: "3px 8px", borderRadius: 20, whiteSpace: "nowrap" }}>{s.label}</span>
              ))}

              {/* Location filter — segmented */}
              <div style={{ display: "flex", alignItems: "center", gap: 2, border: "1.5px solid #E5E2DC", borderRadius: 7, overflow: "hidden", flexShrink: 0 }}>
                {([["all", "All"] , ["oak_lawn", "Oak Lawn"], ["schaumburg", "Schaumburg"]] as const).map(([val, label]) => (
                  <button key={val} onClick={() => setSelectedLocationFilter(val)} style={{
                    padding: "4px 9px", border: "none", cursor: "pointer", fontFamily: FF, fontSize: 11, fontWeight: 700,
                    backgroundColor: selectedLocationFilter === val ? (val === "schaumburg" ? "#2D6A4F" : val === "oak_lawn" ? "#5B9BD5" : "var(--brand)") : "#FAFAF9",
                    color: selectedLocationFilter === val ? "#FFFFFF" : "#6B7280", transition: "all 0.15s",
                  }}>{label}</button>
                ))}
              </div>

              {/* Zone filter — dropdown */}
              {zones.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <div style={{ width: 1, height: 18, backgroundColor: "#E5E2DC" }} />
                  <div ref={zoneDropdownRef} style={{ position: "relative" }}>
                    <button onClick={() => setZoneDropdownOpen(v => !v)} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, padding: "4px 9px", borderRadius: 6, border: "1.5px solid #E5E2DC", backgroundColor: "#FAFAF9", color: "#6B7280", cursor: "pointer", fontFamily: FF }}>
                      {selectedZoneFilter !== null ? (
                        <>
                          <div style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: zones.find(z => z.id === selectedZoneFilter)?.color, flexShrink: 0 }} />
                          {zones.find(z => z.id === selectedZoneFilter)?.name}
                        </>
                      ) : "All Zones"}
                      <ChevronDown size={11} />
                    </button>
                    {zoneDropdownOpen && (
                      <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 200, backgroundColor: "#fff", border: "1px solid #E5E2DC", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.10)", minWidth: 160, overflow: "hidden" }}>
                        <button onClick={() => { setSelectedZoneFilter(null); setZoneDropdownOpen(false); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", backgroundColor: selectedZoneFilter === null ? "var(--brand-dim)" : "transparent", color: selectedZoneFilter === null ? "var(--brand)" : "#1A1917", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>All Zones</button>
                        {zones.map(z => (
                          <button key={z.id} onClick={() => { setSelectedZoneFilter(z.id); setZoneDropdownOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "8px 12px", border: "none", backgroundColor: selectedZoneFilter === z.id ? `${z.color}18` : "transparent", color: selectedZoneFilter === z.id ? z.color : "#1A1917", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                            <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: z.color, flexShrink: 0 }} />
                            {z.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* View toggle */}
              <div style={{ display: "flex", border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden" }}>
                <button onClick={() => setDesktopView("timeline")} style={{ padding: "5px 10px", border: "none", cursor: "pointer", backgroundColor: desktopView === "timeline" ? "var(--brand)" : "#FAFAF9", color: desktopView === "timeline" ? "#fff" : "#6B7280", display: "flex" }}><LayoutGrid size={14} /></button>
                <button onClick={() => setDesktopView("list")} style={{ padding: "5px 10px", border: "none", cursor: "pointer", backgroundColor: desktopView === "list" ? "var(--brand)" : "#FAFAF9", color: desktopView === "list" ? "#fff" : "#6B7280", display: "flex" }}><List size={14} /></button>
              </div>
            </div>
          </div>

          {/* KPI STRIP */}
          {!loading && data && (() => {
            const techsWorking = filteredData?.employees?.filter(e => e.jobs?.length > 0).length ?? 0;
            const totalTechs = filteredData?.employees?.length ?? 0;
            const scheduledHrs = allJobs.reduce((s, j) => s + (j.duration_minutes || 120) / 60, 0);
            const availableHrs = totalTechs * ((DAY_END - DAY_START) / 60);
            const utilization = availableHrs > 0 ? Math.round((scheduledHrs / availableHrs) * 100) : 0;
            const now = new Date();
            const nowMins = now.getHours() * 60 + now.getMinutes();
            const isLiveDay = dateKey(selectedDate) === dateKey(now);
            const lateClockIns = isLiveDay ? allJobs.filter(j => {
              if (j.status === "cancelled" || j.status === "complete") return false;
              const startMins = timeToMins(j.scheduled_time);
              if (nowMins <= startMins) return false;
              return !j.clock_entry?.clock_in_at;
            }).length : 0;
            const atRisk = isLiveDay ? allJobs.filter(j => {
              if (j.status === "cancelled" || j.status === "complete") return false;
              const startMins = timeToMins(j.scheduled_time);
              if (nowMins < startMins - 15 || nowMins > startMins + 15) return false;
              return !j.clock_entry?.clock_in_at;
            }).length : 0;

            return (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 0, borderBottom: "1px solid #E5E2DC", backgroundColor: "#FFFFFF" }}>
                  {[
                    { label: "JOBS TODAY", value: stats.total },
                    { label: "REVENUE TODAY", value: `$${stats.revenue.toFixed(0)}` },
                    { label: "UNASSIGNED", value: stats.unassigned },
                    { label: "TECHS WORKING", value: techsWorking },
                    { label: "AVG UTILIZATION", value: `${utilization}%` },
                  ].map((card, i) => (
                    <div key={i} style={{ padding: "14px 20px", borderRight: i < 4 ? "1px solid #E5E2DC" : "none" }}>
                      <div style={{ fontSize: 26, fontWeight: 600, color: "#1A1917", fontFamily: FF, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{card.value}</div>
                      <div style={{ fontSize: 11, fontWeight: 500, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.02em", marginTop: 4 }}>{card.label}</div>
                    </div>
                  ))}
                </div>
                {(lateClockIns > 0 || atRisk > 0) && (
                  <div style={{ padding: "6px 20px", borderBottom: "1px solid #E5E2DC", backgroundColor: "#FFFFFF", fontSize: 12, color: "#6B6860", fontFamily: FF }}>
                    {lateClockIns > 0 && <span>{lateClockIns} late clock-in{lateClockIns > 1 ? "s" : ""}</span>}
                    {lateClockIns > 0 && atRisk > 0 && <span style={{ margin: "0 8px" }}>&middot;</span>}
                    {atRisk > 0 && <span>{atRisk} job{atRisk > 1 ? "s" : ""} at risk (no clock-in within 15 min of start)</span>}
                  </div>
                )}
              </>
            );
          })()}

          {/* GANTT / LIST — fills remaining height */}
          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            {/* Timeline or list */}
            {loading ? (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#9E9B94", fontSize: 13 }}>Loading schedule...</div>
            ) : desktopView === "timeline" ? (
              <div ref={timelineRef} style={{ flex: 1, overflow: "auto" }}>
                {/* Time header */}
                <div style={{ display: "flex", position: "sticky", top: 0, zIndex: 10, backgroundColor: "#FAFAF9", borderBottom: "1px solid #E5E2DC" }}>
                  <div style={{ width: COL_W, flexShrink: 0, position: "sticky", left: 0, zIndex: 11, backgroundColor: "#FAFAF9", borderRight: "1px solid #E5E2DC", padding: "8px 12px" }}>
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
                  filteredData && <>
                    {filteredData.unassigned_jobs.length > 0 && (
                      <UnassignedGanttRow jobs={filteredData.unassigned_jobs} onChipClick={setSelectedJob} nowLine={nowLine} />
                    )}
                    {filteredData.employees.map(e => <EmployeeRow key={e.id} employee={e} onChipClick={setSelectedJob} nowLine={nowLine} />)}
                  </>
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
                          {j.frequency && j.frequency !== "on_demand" && <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 700, color: "var(--brand)", background: "var(--brand-dim, #f0fdf9)", padding: "2px 6px", borderRadius: 4 }}><Repeat size={9} />{j.frequency.replace(/_/g, " ")}</span>}
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", marginLeft: "auto" }}>${(j.amount || 0).toFixed(0)}</div>
                        </div>
                        {(j.est_hours_per_tech ?? j.estimated_hours) != null && (j.est_hours_per_tech ?? j.estimated_hours ?? 0) > 0 && (
                          <div style={{ display: "flex", gap: 10, marginTop: 6, alignItems: "center" }}>
                            <span style={{ fontSize: 11, color: "#9E9B94", display: "flex", alignItems: "center", gap: 3 }}>
                              <Clock size={10} style={{ color: "#C4C0BB" }} />
                              Est. {(j.est_hours_per_tech ?? j.estimated_hours ?? 0).toFixed(1)} hrs
                            </span>
                            {j.est_pay_per_tech != null && j.est_pay_per_tech > 0 && (
                              <span style={{ fontSize: 11, fontWeight: 700, color: "#16A34A" }}>
                                · ${j.est_pay_per_tech.toFixed(2)} commission
                              </span>
                            )}
                          </div>
                        )}
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
