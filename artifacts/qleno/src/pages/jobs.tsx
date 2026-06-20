import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { useSearch, useLocation } from "wouter";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { EmployeeAvatar } from "@/components/employee-avatar";
import { getAuthHeaders, useAuthStore } from "@/lib/auth";
import { useBranch } from "@/contexts/branch-context";
import { useToast } from "@/hooks/use-toast";
import { mapsDirectionsUrl } from "@/lib/format-address";
import { JobWizard } from "@/components/job-wizard";
import EditJobModal from "@/components/edit-job-modal";
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, useSensor, useSensors,
  useDraggable, useDroppable, type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import {
  ChevronLeft, ChevronRight, ChevronDown, Plus, Clock, Camera, X, MapPin, User,
  DollarSign, CheckCircle, AlertCircle, LayoutGrid, List, Calendar,
  Building2, AlertTriangle, Repeat, Phone, MessageSquare, Send, Check, Info, Trash2, MoreVertical,
  Languages,
} from "lucide-react";
import { getJobVisualStatus, STATUS_VISUALS, ensureJobStatusStyles, LIVE_OPS, mutedFill } from "@/lib/job-status";
import { computePriceDelta } from "@/lib/price-delta";
import { InlinePriceEdit } from "@/components/inline-price-edit";
import LegendPopover from "@/components/legend-popover";
import MobileDateSheet from "@/components/mobile-date-sheet";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const FF = "'Plus Jakarta Sans', sans-serif";

// [AI.7.5.hotfix3] LIVE_OPS gate is now sourced from lib/job-status.ts
// so the same flag controls both the visual status helper (which
// suppresses late_clockin/no_show paint) and the Needs Attention
// strip's late-clock-in alerts. Single switch — flip to true after
// go-live. Build the engine, don't turn it on.
// [AB] Shrunk SLOT_W 80 → 64 so the default 9-hour business window
// (9 AM – 6 PM = 18 slots × 64 = 1152 px) fits inside a 1440 px viewport
// alongside the 180 px sticky tech column (total 1332 px, ~100 px margin
// for page padding/scrollbars). Previous 80 px/slot pushed the timeline
// to 1620 px and forced horizontal scroll on first paint. ROW_H 64 → 72
// gives the chip 52 px of vertical space (ROW_H - 20 top/bottom gutter)
// to match MC's roomier card feel.
const SLOT_W = 64;
const COL_W = 180;
const ROW_H = 72;
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

// [penny-exact 2026-06-04] Dispatch dollar figures are reconciled against
// MaidCentral/ADP payroll to the cent, so money MUST render with full cents
// and thousands separators ($1,339.20 — never $1339 or $1.3k). Use this for
// every revenue / pay / billed amount on the board. `formatRev` (the $1.3k
// compact form) is for the mobile week-summary chart only, not reconciliation.
const fmtUSD = (n: number | null | undefined) =>
  Number(n ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

const STATUS: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  scheduled:   { bg: "#DBEAFE", border: "#93C5FD", text: "#1D4ED8", dot: "#3B82F6" },
  in_progress: { bg: "#FEF3C7", border: "#FCD34D", text: "#92400E", dot: "#F59E0B" },
  complete:    { bg: "#DCFCE7", border: "#86EFAC", text: "#15803D", dot: "#22C55E" },
  cancelled:   { bg: "#F3F4F6", border: "#D1D5DB", text: "#6B7280", dot: "#9CA3AF" },
  flagged:     { bg: "#FEE2E2", border: "#FCA5A5", text: "#991B1B", dot: "#EF4444" },
};

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface ClockEntry { id: number; clock_in_at: string | null; clock_out_at: string | null; distance_from_job_ft: number | null; is_flagged: boolean; clock_in_distance_ft?: number | null; clock_out_distance_ft?: number | null; clock_in_outside_geofence?: boolean; clock_out_outside_geofence?: boolean; gps_missing?: boolean; }
interface JobTechCommission { user_id: number; name: string; is_primary: boolean; est_hours: number; calc_pay: number; final_pay: number; pay_override: number | null; /* [pay-matrix 2026-04-29] surface the per-tech matrix cell so JobPanel can render "Hourly $20/hr × 6h" or "Commission 35%" without re-deriving */ pay_type?: "commission" | "hourly"; pay_rate?: number; }
interface JobAddOn { name: string; quantity: number; unit_price: number; subtotal: number; }
interface DispatchJob { id: number; client_id: number; client_name: string; /* [scheduling-engine 2026-04-29] display_name = "Company - Contact" for commercial clients with company_name set; falls back to client_name otherwise. Use this on every chip/header/hover surface so the composition rule lives server-side. */ display_name?: string; client_company_name?: string | null; client_phone?: string | null; client_zip?: string | null; client_notes?: string | null; client_payment_method?: string | null; /* [tile redesign] residential or commercial badge; commercial when account_id is set OR client_type === 'commercial' */ client_type?: "residential" | "commercial" | null; address: string | null; /* [inline-edit] raw fields for address editor mode detection */ job_address_street?: string | null; job_address_city?: string | null; job_address_state?: string | null; job_address_zip?: string | null; client_address?: string | null; client_city?: string | null; client_state?: string | null; client_address_zip?: string | null; assigned_user_id: number | null; assigned_user_name?: string; job_lat?: number | null; job_lng?: number | null; service_type: string; status: string; scheduled_date: string; scheduled_time: string | null; frequency: string; amount: number; duration_minutes: number; notes: string | null; office_notes?: string | null; office_notes_updated_at?: string | null; office_notes_updated_by_name?: string | null; before_photo_count: number; after_photo_count: number; clock_entry: ClockEntry | null; zone_id?: number | null; zone_color?: string | null; zone_name?: string | null; branch_id?: number | null; branch_name?: string | null; last_service_date?: string | null; account_id?: number | null; account_name?: string | null; billing_method?: string | null; hourly_rate?: number | null; estimated_hours?: number | null; actual_hours?: number | null; billed_hours?: number | null; billed_amount?: number | null; /* [commercial-revenue 2026-06-04] allowed_hours drives the "$50/hr × 8h" card display; manual_rate_override distinguishes a flat pinned price from rate×hours billing */ allowed_hours?: number | null; manual_rate_override?: boolean | null; charge_failed_at?: string | null; charge_succeeded_at?: string | null; property_access_notes?: string | null; booking_location?: string | null; technicians?: JobTechCommission[]; est_hours_per_tech?: number | null; est_pay_per_tech?: number | null; company_res_pct?: number | null; /* [AI.7.4] Commission routing — 'commercial_hourly' or 'residential_pool' */ commission_basis?: "commercial_hourly" | "residential_pool" | null; commercial_hourly_rate?: number | null; /* [AF] completion lock state */ locked_at?: string | null; /* [lockout-visibility 2026-06-17] 'cancel'|'lockout' when this completed job is a charged cancellation/lockout (fee billed, not a visit); drives the charged_cancel visual + fee badge */ cancel_action?: string | null; actual_end_time?: string | null; completed_by_user_id?: number | null; /* [job-card-redesign] Add-ons drive the +N pill on the chip and the full list in the popover. is_new_client = first-ever residential job (no prior completed). en_route_at scaffolds the "On My Way" status; column doesn't exist yet, so the field is always undefined until the SMS engine lands. */ add_ons?: JobAddOn[]; is_new_client?: boolean; en_route_at?: string | null; /* [phes-lifecycle 2026-04-29] Manual no-show flag set by the field app's "No Show" button. Drives the NO_SHOW visual state via getJobVisualStatus. Until the field-app button ships, both fields stay null. */ no_show_marked_by_tech?: string | null; no_show_marked_by_user_id?: number | null; /* [BUG-3F2 / 2026-06-02] Multi-tech fan-out fields. team_role identifies whether this card renders for the primary or a team member, so the FE can style team-member cards differently. revenue_share is the per-tech weighted share of the job amount; the badge sums revenue_share (when present) instead of amount so per-row totals don't double-count shared jobs across the company. */ team_role?: "primary" | "team"; revenue_share?: number; }
interface Employee { id: number; name: string; role: string; is_trainee?: boolean; jobs: DispatchJob[]; zone?: { zone_id: number; zone_color: string; zone_name: string } | null; time_off?: 'pto' | 'sick' | 'absent' | null; commission_rate?: number | null; avatar_url?: string | null; }
interface DispatchData { employees: Employee[]; unassigned_jobs: DispatchJob[]; }

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const dateKey = (d: Date) => d.toISOString().split("T")[0];
const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
// [Y] timeToMins + fmtTime were broken for AM/PM-format strings coming
// from MC (e.g. "1:30 PM"). The old `t.split(":").map(Number)` produced
// `[1, NaN]` for "1:30 PM" because "30 PM" can't parse as a number, so
// minutes got dropped AND the PM +12h offset was never applied. Result:
// "1:30 PM" → 60 min (= 1 AM). Robust parser handles BOTH formats:
//   • "H:MM AM" / "H:MM PM"       (12-hour, MC-imported rows)
//   • "HH:MM" / "HH:MM:SS"        (24-hour, Quote Builder + engine-written
//                                  via minsToStr below)
const timeToMins = (t: string | null): number => {
  if (!t) return DAY_START;
  const trimmed = t.trim();
  const ampm = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10) || 0;
    const m = parseInt(ampm[2], 10) || 0;
    const isPM = ampm[3].toUpperCase() === "PM";
    if (h === 12) h = isPM ? 12 : 0;      // 12 AM → 0, 12 PM → 12
    else if (isPM) h += 12;               // 1–11 PM → 13–23
    return h * 60 + m;
  }
  const parts = trimmed.split(":").map(p => parseInt(p, 10));
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  return h * 60 + m;
};
const minsToStr = (mins: number) => { const c = Math.max(DAY_START, Math.min(DAY_END - 30, mins)); return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}:00`; };
function fmtTime(t: string | null): string {
  if (!t) return "—";
  const trimmed = t.trim();
  const ampm = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampm) {
    // Already AM/PM format — reformat cleanly (normalizes spacing/case).
    const h = parseInt(ampm[1], 10) || 0;
    const m = parseInt(ampm[2], 10) || 0;
    return `${h}:${String(m).padStart(2, "0")} ${ampm[3].toUpperCase()}`;
  }
  const parts = trimmed.split(":").map(p => parseInt(p, 10));
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const suffix = h < 12 ? "AM" : "PM";
  return `${displayH}:${String(m).padStart(2, "0")} ${suffix}`;
}
function fmtSvc(s: string) { return s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()); }

// [freq-consistency 2026-06-08] Canonical recurring-frequency label — ONE source
// of truth so the Gantt chip, hover card, repeat-badge, and panel header never
// disagree. monthly AND every_4_weeks both read "Monthly" (Sal's call). Returns
// "" for non-recurring so callers can gate on it.
const RECURRENCE_LABELS: Record<string, string> = {
  weekly: "Weekly", biweekly: "Biweekly", every_2_weeks: "Biweekly",
  every_3_weeks: "Every 3 Weeks", monthly: "Monthly", every_4_weeks: "Monthly",
  daily: "Daily", weekdays: "Weekdays", custom_days: "Custom Days",
};
function recurrenceLabel(f?: string | null): string {
  if (!f || f === "on_demand") return "";
  return RECURRENCE_LABELS[f] ?? fmtSvc(f);
}

// [hotfix 2026-04-29 / closes #4] Walk up the DOM to find the nearest
// ancestor that establishes a clipping context. Used by JobHoverCard's
// flip logic so we measure against the actual scroll-container bounds
// instead of the viewport — fixes popovers getting cut off when the
// timeline's `overflow: auto` is shorter than the viewport. Returns the
// element itself or null when nothing scrolls (we fall back to the
// viewport).
function getScrollParent(el: HTMLElement | null): HTMLElement | null {
  let current: HTMLElement | null = el;
  while (current) {
    const style = getComputedStyle(current);
    const combined = `${style.overflow}${style.overflowX}${style.overflowY}`;
    if (/(auto|scroll)/.test(combined)) return current;
    current = current.parentElement;
  }
  return null;
}

// [X] scopeLabel — card-facing "scope" label. Prefers frequency when the
// job is recurring (Weekly / Biweekly / Every 4 Weeks), falls back to
// service_type when one-off. Matches MC's Job Schedule card convention.
function scopeLabel(job: { service_type?: string | null; frequency?: string | null }): string {
  const FREQ: Record<string, string> = {
    weekly: "Weekly",
    biweekly: "Biweekly",
    every_3_weeks: "Every 3 Weeks",
    monthly: "Monthly",
    every_4_weeks: "Monthly",
  };
  if (job.frequency && FREQ[job.frequency]) return FREQ[job.frequency];
  const SVC: Record<string, string> = {
    standard_clean: "Standard Clean",
    deep_clean: "Deep Clean",
    move_in: "Move In",
    move_out: "Move Out",
    move_in_out: "Move In/Out",
    post_construction: "Post-Construction",
    office_cleaning: "Office",
    common_areas: "Common Areas",
    retail_store: "Retail",
    medical_office: "Medical Office",
    recurring: "Recurring",
  };
  return SVC[job.service_type ?? ""] ?? fmtSvc(job.service_type ?? "");
}

// [X] Convert hex color to rgba string with alpha, for zone-color-at-N%
// styling. Falls back to a neutral taupe when hex is null/invalid.
function hexToRgba(hex: string | null | undefined, alpha: number): string {
  const FALLBACK = `rgba(229, 226, 220, ${alpha})`; // #E5E2DC at alpha
  if (!hex) return FALLBACK;
  const h = hex.replace("#", "");
  if (h.length !== 6) return FALLBACK;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some(v => Number.isNaN(v))) return FALLBACK;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// [AB] Perceptual luminance of a hex color, 0..1. Used to pick between
// white and dark text on full-opacity zone-color chip backgrounds.
// Rec. 601 weights (0.299 R + 0.587 G + 0.114 B) — slightly cheaper than
// the WCAG relative-luminance formula and close enough for a binary
// light/dark decision. Gold (#FFD700) → ~0.79 → dark text; all other
// PHES zone colors (magenta/purple/red/green) → < 0.4 → white text.
function zoneLuminance(hex: string | null | undefined): number {
  if (!hex) return 0;
  const h = hex.replace("#", "");
  if (h.length !== 6) return 0;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some(v => Number.isNaN(v))) return 0;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// [Z] Strict 12-hour "H:MM AM/PM" parser. Returns null on invalid input.
// Used for parsing company.business_hours — unlike timeToMins (which
// falls back to DAY_START), this returns null so we can tell valid
// times apart from parse failures.
function strictParseAmpm(t: string): number | null {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const isPM = m[3].toUpperCase() === "PM";
  if (h === 12) h = isPM ? 12 : 0;
  else if (isPM) h += 12;
  return h * 60 + mm;
}

// [Z] Per-weekday business hours. 0=Sunday ... 6=Saturday (matches
// JS Date.getDay()). "closed" means the business is closed that day.
type DayHours = { startMin: number; endMin: number } | "closed";
type BusinessHoursMap = Map<number, DayHours>;

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

// [Z] Parse free-form company.business_hours text into a per-weekday map.
// Accepted shapes (en-dash, em-dash, and hyphen all work):
//   "Monday – Friday: 9:00 AM – 6:00 PM"
//   "Saturday: 9:00 AM – 12:00 PM"
//   "Sunday: Closed"
//   "Mon-Fri: 9:00 AM - 6:00 PM"  (hyphen variant)
// Missing or unparseable days simply don't get set in the map — the
// caller decides the fallback (9-6 here).
function parseBusinessHours(text: string | null | undefined): BusinessHoursMap {
  const out: BusinessHoursMap = new Map();
  if (!text) return out;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const daysPart = line.slice(0, colonIdx).trim();
    const hoursPart = line.slice(colonIdx + 1).trim();

    // Resolve days — either a range "Mon-Fri" or a single day "Saturday"
    const rangeMatch = daysPart.match(/^(\w+)\s*[-–—]\s*(\w+)$/);
    const daysForLine: number[] = [];
    if (rangeMatch) {
      const from = DAY_NAMES[rangeMatch[1].toLowerCase()];
      const to = DAY_NAMES[rangeMatch[2].toLowerCase()];
      if (from == null || to == null) continue;
      let idx = from;
      for (let safety = 0; safety < 8; safety++) {
        daysForLine.push(idx);
        if (idx === to) break;
        idx = (idx + 1) % 7;
      }
    } else {
      const d = DAY_NAMES[daysPart.toLowerCase()];
      if (d == null) continue;
      daysForLine.push(d);
    }

    // Parse hours — "Closed" or "H:MM AM – H:MM PM"
    if (/^closed$/i.test(hoursPart)) {
      for (const d of daysForLine) out.set(d, "closed");
      continue;
    }
    const hMatch = hoursPart.match(/^(\d{1,2}:\d{2}\s*[AP]M)\s*[-–—]\s*(\d{1,2}:\d{2}\s*[AP]M)$/i);
    if (!hMatch) continue;
    const startMin = strictParseAmpm(hMatch[1]);
    const endMin = strictParseAmpm(hMatch[2]);
    if (startMin == null || endMin == null) continue;
    for (const d of daysForLine) out.set(d, { startMin, endMin });
  }
  return out;
}

function isDarkHex(hex?: string | null): boolean {
  if (!hex) return false;
  const h = hex.replace("#", "");
  if (h.length !== 6) return false;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  // perceptual brightness — dark if below ~58% of max
  return (r * 299 + g * 587 + b * 114) / 1000 < 150;
}
function useIsMobile() { const [m, setM] = useState(window.innerWidth < 1024); useEffect(() => { const h = () => setM(window.innerWidth < 1024); window.addEventListener("resize", h); return () => window.removeEventListener("resize", h); }, []); return m; }
function fmtHour(h: number) { if (h === 12) return "12 PM"; if (h === 0) return "12 AM"; return h < 12 ? `${h} AM` : `${h - 12} PM`; }
// [card-polish 2026-06-05] Minutes-since-midnight -> "9:00 AM" / "2:30 PM".
// Used to render a job's full shift range (start–end) on the mobile card.
function fmtMins(mins: number) { const h = Math.floor(mins / 60), m = ((mins % 60) + 60) % 60; const ampm = h % 24 < 12 ? "AM" : "PM"; const hr = h % 12 === 0 ? 12 : h % 12; return `${hr}:${String(m).padStart(2, "0")} ${ampm}`; }
// [office-clock 2026-06-05] Format an ISO timestamp as wall-clock time and a
// clock-in -> clock-out span, for the desktop Time Clock panel.
// [clock-tz 2026-06-17] Clock times are stored WALL-CLOCK (what the tech/office
// saw on the clock). Slice the HH:MM straight out of the string — never run it
// through new Date()/toLocaleTimeString(), which re-applies the browser's UTC
// offset and shifts the displayed time (the dispatch drawer was showing field
// punches hours off, disagreeing with the Time Clock screen). Mirrors the
// time-clock page's wall-clock formatter.
function fmtClock(iso: string | null | undefined) {
  if (!iso) return "—";
  const m = String(iso).match(/[T ](\d{2}):(\d{2})/);
  if (!m) return "—";
  const h = parseInt(m[1], 10), min = m[2];
  const ap = h < 12 ? "AM" : "PM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${min} ${ap}`;
}
function clockDuration(a: string, b: string) { const ms = new Date(b).getTime() - new Date(a).getTime(); if (isNaN(ms) || ms < 0) return "—"; const mins = Math.round(ms / 60000); const h = Math.floor(mins / 60), m = mins % 60; return h > 0 ? `${h}h ${m}m` : `${m}m`; }
function slotBg(count: number) { if (count === 0) return "#DCFCE7"; if (count <= 2) return "#FEF3C7"; return "#FEE2E2"; }
function slotTxt(count: number) { if (count === 0) return "#15803D"; if (count <= 2) return "#92400E"; return "#991B1B"; }
// Honest labels: the count is total jobs booked that hour across the whole
// team — NOT a hard capacity. "Full" wrongly implied the slot was blocked, so
// we show the real count and let colour carry the busy signal.
function slotLbl(count: number) { if (count === 0) return "Open"; return `${count} job${count === 1 ? "" : "s"}`; }

async function patchJob(id: number, patch: object, token: string) {
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");
  const r = await fetch(`${API}/api/jobs/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(patch) });
  if (!r.ok) throw new Error("Failed");
}

// [clock-edit-from-card 2026-06-10] Office can correct a tech's clock in/out
// times straight from the dispatch job card — calls PATCH /api/timeclock/:id
// (owner/admin/office), which re-derives actual hours + audits the change.
// Inputs are datetime-local (wall-clock); converted to ISO on save.
function ClockEditor({ entry, canEdit, onUpdate }: { entry: ClockEntry; canEdit: boolean; onUpdate: () => void }) {
  const token = useAuthStore(s => s.token)!;
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [inVal, setInVal] = useState("");
  const [outVal, setOutVal] = useState("");
  const [saving, setSaving] = useState(false);
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");
  // [clock-tz 2026-06-17] Clock times are WALL-CLOCK. Slice the date+HH:MM
  // straight out of the stored string (no new Date(), which would re-apply the
  // browser offset and pre-fill the wrong time); save sends a naive datetime
  // (no Z) so the server stores exactly what was typed.
  const toLocal = (iso: string | null) => {
    if (!iso) return "";
    const m = String(iso).match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    return m ? `${m[1]}T${m[2]}` : "";
  };
  function open() { setInVal(toLocal(entry.clock_in_at)); setOutVal(toLocal(entry.clock_out_at)); setEditing(true); }
  async function save() {
    if (!inVal) { toast({ title: "Clock-in time is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body: any = { clock_in_at: `${inVal}:00`, clock_out_at: outVal ? `${outVal}:00` : null };
      const r = await fetch(`${API}/api/timeclock/${entry.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.message || e.error || "Failed"); }
      toast({ title: "Clock updated" });
      setEditing(false);
      onUpdate();
    } catch (e: any) { toast({ title: "Couldn't update clock", description: e.message, variant: "destructive" }); }
    finally { setSaving(false); }
  }
  if (!canEdit) return null;
  const inp: React.CSSProperties = { padding: "6px 8px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 12, fontFamily: "inherit", width: "100%", boxSizing: "border-box" };
  if (!editing) {
    return (
      <button onClick={open} style={{ marginTop: 8, background: "none", border: "none", padding: 0, color: "var(--brand, #00C9A0)", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
        Edit clock times
      </button>
    );
  }
  return (
    <div style={{ marginTop: 10, padding: 10, background: "#F7F6F3", borderRadius: 8, display: "flex", flexDirection: "column", gap: 8 }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: "#6B7280" }}>Clock in
        <input type="datetime-local" value={inVal} onChange={e => setInVal(e.target.value)} style={inp} />
      </label>
      <label style={{ fontSize: 11, fontWeight: 700, color: "#6B7280" }}>Clock out <span style={{ fontWeight: 400 }}>(blank = still on the clock)</span>
        <input type="datetime-local" value={outVal} onChange={e => setOutVal(e.target.value)} style={inp} />
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => setEditing(false)} disabled={saving} style={{ flex: 1, padding: "7px", border: "1px solid #E5E2DC", background: "#fff", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        <button onClick={save} disabled={saving} style={{ flex: 1.3, padding: "7px", border: "none", background: "var(--brand, #00C9A0)", color: "#fff", borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{saving ? "Saving…" : "Save clock"}</button>
      </div>
    </div>
  );
}

// [translate-note] One-tap English → Spanish for job notes. Office writes
// notes in English; many Phes techs read more comfortably in Spanish. Calls
// the existing POST /api/translate (Claude-backed, office-gated). The English
// original is never changed — the Spanish shows below it and toggles off.
// No-op for empty text. Resets when the source text changes (e.g. office
// notes edited) so a stale translation never lingers.
function TranslateNote({ text }: { text: string }) {
  const token = useAuthStore(s => s.token)!;
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [translated, setTranslated] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { setTranslated(null); setOpen(false); setErr(""); }, [text]);
  if (!text || !text.trim()) return null;
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");
  async function run() {
    setErr("");
    if (translated) { setOpen(o => !o); return; }
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/translate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text, target: "es" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || d.message || `HTTP ${r.status}`);
      setTranslated(d.translated); setOpen(true);
    } catch (e: any) {
      setErr(e?.message || "Translation failed");
    } finally { setBusy(false); }
  }
  const label = busy ? "Translating…" : translated ? (open ? "Hide Spanish" : "Show Spanish") : "Translate to Spanish";
  return (
    <div style={{ marginTop: 6 }}>
      <button type="button" onClick={run} disabled={busy}
        style={{ display: "inline-flex", alignItems: "center", gap: 5, border: "none", background: "none", padding: 0, cursor: busy ? "wait" : "pointer", color: "#2D9B83", fontSize: 12, fontWeight: 600, fontFamily: FF }}>
        <Languages size={13} /> {label}
      </button>
      {err && <div style={{ marginTop: 4, fontSize: 11, color: "#B91C1C" }}>{err}</div>}
      {open && translated && (
        <div style={{ marginTop: 6, padding: "8px 10px", background: "#F0F9FF", border: "1px solid #BAE6FD", borderRadius: 8 }}>
          <p style={{ margin: 0, fontSize: 13, color: "#0C4A6E", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{translated}</p>
          <p style={{ margin: "4px 0 0", fontSize: 10, color: "#7DA9C0" }}>Translated automatically · español</p>
        </div>
      )}
    </div>
  );
}

async function fetchDispatch(date: string, token: string, branchId?: number | "all"): Promise<DispatchData> {
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");
  const params = new URLSearchParams({ date });
  if (branchId && branchId !== "all") params.set("branch_id", String(branchId));
  const r = await fetch(`${API}/api/dispatch?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  // [AI.7.5.hotfix2] Surface the real server error in DevTools so a 500
  // doesn't hide behind a generic "Failed to load dispatch" toast. The
  // actual message helps diagnose env/migration issues without Railway
  // log access.
  if (!r.ok) {
    const bodyText = await r.text().catch(() => "");
    let parsed: any = null;
    try { parsed = JSON.parse(bodyText); } catch { /* not JSON */ }
    console.error("[fetchDispatch] failed", { status: r.status, body: parsed ?? bodyText, url: `${API}/api/dispatch?${params}` });
    const msg = parsed?.message || parsed?.error || bodyText.slice(0, 240) || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return r.json();
}

// ─── INLINE EDIT: TECHNICIAN DROPDOWN ─────────────────────────────────────────
// Replaces the static "Technician: <name>" row in the drawer with a Select
// that swaps the primary tech in place via PATCH /api/jobs/:id/reassign-tech.
// Branch isolated: dropdown lists only active techs whose branch_id matches
// the job's. Optimistic intent: caller's onUpdate refreshes dispatch state
// after success so the chip moves to the new tech's row.
function InlineTechEdit({ job, onUpdate }: { job: DispatchJob; onUpdate: () => void }) {
  const token = useAuthStore(s => s.token)!;
  const { toast } = useToast();
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");

  const [techs, setTechs] = useState<Array<{ id: number; first_name: string; last_name: string; name: string }>>([]);
  const [loadingTechs, setLoadingTechs] = useState(false);
  const [saving, setSaving] = useState(false);

  // Fetch candidate techs from /api/users/techs-with-status (the same
  // endpoint the existing Add Team Member picker uses, so role and active
  // filtering match production behavior — covers technician AND team_lead
  // roles, not just "technician"). Branch isolation is applied via the
  // branch_id query param when the job has a branch set; legacy users with
  // null branch are still surfaced (treated as assignable anywhere).
  useEffect(() => {
    setLoadingTechs(true);
    const params = new URLSearchParams();
    if (job.branch_id != null) params.set("branch_id", String(job.branch_id));
    const qs = params.toString() ? `?${params}` : "";
    fetch(`${API}/api/users/techs-with-status${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : { data: [] })
      .then((d: any) => {
        const list = Array.isArray(d?.data) ? d.data : [];
        setTechs(list);
      })
      .catch(() => setTechs([]))
      .finally(() => setLoadingTechs(false));
  }, [API, token, job.branch_id]);

  // Resolve the current tech's display name. Prefer assigned_user_name
  // from the dispatch payload (always populated when a tech is assigned),
  // then fall back to the techs list once it loads. Final fallback is a
  // neutral placeholder so the dropdown never renders just a checkmark.
  const currentTechFromList = job.assigned_user_id != null
    ? techs.find(t => t.id === job.assigned_user_id)
    : null;
  const currentName = job.assigned_user_name
    || (currentTechFromList ? currentTechFromList.name : null)
    || (job.assigned_user_id != null ? `Technician #${job.assigned_user_id}` : "Unassigned");

  async function onChange(newId: number) {
    if (newId === job.assigned_user_id) return;
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/jobs/${job.id}/reassign-tech`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ new_tech_id: newId }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `Failed (HTTP ${r.status})`);
      }
      toast({ title: "Technician reassigned" });
      onUpdate();
    } catch (e: any) {
      toast({ title: "Could not reassign", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ color: "#9E9B94", flexShrink: 0, marginTop: 1 }}><User size={14} /></span>
      <select
        value={job.assigned_user_id ?? ""}
        onChange={e => onChange(parseInt(e.target.value, 10))}
        disabled={saving || loadingTechs}
        style={{
          fontSize: 13, color: "#1A1917", fontFamily: FF, fontWeight: 500,
          background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 6,
          padding: "4px 8px", cursor: saving ? "wait" : "pointer", flex: 1, minWidth: 0,
        }}
      >
        {/* Placeholder for unassigned jobs so the user sees a neutral state. */}
        {job.assigned_user_id == null && (
          <option value="" disabled>{loadingTechs ? "Loading…" : "Select technician…"}</option>
        )}
        {/* Current tech first so the Select displays the right name. */}
        {job.assigned_user_id != null && (
          <option value={job.assigned_user_id}>{currentName}</option>
        )}
        {/* Other branch techs. Filter out the current one so the list reads as candidates. */}
        {techs
          .filter(t => t.id !== job.assigned_user_id)
          .map(t => (
            <option key={t.id} value={t.id}>{t.name || `${t.first_name} ${t.last_name}`}</option>
          ))}
      </select>
      {saving && <span style={{ fontSize: 11, color: "#9E9B94" }}>Saving…</span>}
    </div>
  );
}

// ─── INLINE EDIT: ADDRESS WITH GOOGLE PLACES AUTOCOMPLETE ─────────────────────
// Replaces the static "<map pin> <address>" row in the drawer with a pencil
// affordance that expands a single Google Places Autocomplete input. Mirrors
// the booking widget's pattern (pages/book.tsx). User flow:
//   1. Click Edit. Form expands with one input + a confirmation row that
//      stays empty until Google's autocomplete returns a verified place.
//   2. User types, picks a suggestion. Place components are parsed into
//      street / city / state / zip / lat / lng and shown read-only in the
//      confirmation row. Save button enables.
//   3. Save → PATCH /api/jobs/:id/address with the parsed components. The
//      server re-runs geocode for defense in depth, picks job-level vs
//      client-level mode based on whether jobs.address_street already
//      diverges from clients.address, re-resolves the zone, and rejects
//      with 422 if the resolved zip is not in any service zone in this
//      tenant's database (per Sal's rule: the only valid failure case).
//   4. onUpdate refreshes dispatch state so the tile zone color flips.
// Subtitle tells the user which mode their save will use.
function InlineAddressEdit({ job, onUpdate }: { job: DispatchJob; onUpdate: () => void }) {
  const token = useAuthStore(s => s.token)!;
  const { toast } = useToast();
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");

  // [permanent vs one-time] The user explicitly chooses via the
  // "Save permanently for this client" checkbox. Default is one-time
  // (job-level override) so a wrong click does not cascade unintended
  // changes to the client record. The server still cascades to client
  // mode automatically when the client has no address on file at all,
  // so a freshly-imported client with NULL address gets the canonical
  // record filled in regardless of the checkbox.
  const clientHasAddress = !!String(job.client_address ?? "").trim();

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapsReady, setMapsReady] = useState(false);
  const [pickedAddress, setPickedAddress] = useState<{
    address: string; city: string; state: string; zip: string;
    lat: number; lng: number; formatted: string;
  } | null>(null);
  const [permanent, setPermanent] = useState(false);
  // [address-cascade 2026-06-04] When "apply to all future" is checked and the
  // client has upcoming jobs with their own saved address, we ask how far to
  // cascade instead of guessing. Null = no prompt showing.
  const [cascadePrompt, setCascadePrompt] = useState<{ total: number; same: number; diff: number } | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);

  // Load the Maps JS once on first edit. Key fetched from the server at
  // runtime so the frontend is resilient to a build that did not pick up
  // GOOGLE_MAPS_API_KEY. Build-time VITE_GOOGLE_MAPS_API_KEY is the
  // fallback for tenants where the server route is unreachable.
  useEffect(() => {
    if (!editing) return;
    const w = window as any;
    if (w.google?.maps?.places) { setMapsReady(true); return; }
    const scriptId = "gmap-places-script";
    if (document.getElementById(scriptId)) {
      const existing = document.getElementById(scriptId) as HTMLScriptElement;
      existing.addEventListener("load", () => setMapsReady(true));
      return;
    }

    let cancelled = false;
    (async () => {
      // Try the runtime config endpoint first.
      let key = "";
      try {
        const r = await fetch(`${API}/api/config/google-maps-key`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.ok) {
          const body = await r.json().catch(() => ({}));
          key = String(body?.key ?? "");
        }
      } catch { /* fall through to build-time fallback */ }
      // Fallback: build-time injected key.
      if (!key) {
        key = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY ?? "";
      }
      if (cancelled) return;
      if (!key) {
        setError("Google Maps API key not configured. Set GOOGLE_MAPS_API_KEY on the server.");
        return;
      }
      // Re-check whether another instance already injected the script while
      // we were awaiting the fetch.
      if (document.getElementById(scriptId)) {
        const existing = document.getElementById(scriptId) as HTMLScriptElement;
        existing.addEventListener("load", () => setMapsReady(true));
        if ((window as any).google?.maps?.places) setMapsReady(true);
        return;
      }
      const s = document.createElement("script");
      s.id = scriptId;
      s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places`;
      s.async = true; s.defer = true;
      s.onload = () => setMapsReady(true);
      document.head.appendChild(s);
    })();

    return () => { cancelled = true; };
  }, [editing, API, token]);

  // Wire Google Places Autocomplete once Maps is loaded AND the input exists.
  useEffect(() => {
    if (!editing || !mapsReady || !inputRef.current) return;
    const g = (window as any).google;
    if (!g?.maps?.places?.Autocomplete) return;
    const ac = new g.maps.places.Autocomplete(inputRef.current, {
      componentRestrictions: { country: "us" },
      fields: ["address_components", "formatted_address", "geometry"],
      types: ["address"],
    });
    const listener = ac.addListener("place_changed", () => {
      const place = ac.getPlace();
      if (!place?.address_components) return;
      const longGet = (type: string) =>
        place.address_components.find((c: any) => c.types.includes(type))?.long_name ?? "";
      const shortGet = (type: string) =>
        place.address_components.find((c: any) => c.types.includes(type))?.short_name ?? "";
      const street = `${longGet("street_number")} ${longGet("route")}`.trim();
      const city = longGet("locality") || longGet("sublocality") || longGet("postal_town");
      const state = shortGet("administrative_area_level_1");
      const zip = longGet("postal_code");
      const lat = place.geometry?.location?.lat?.() ?? 0;
      const lng = place.geometry?.location?.lng?.() ?? 0;
      setPickedAddress({
        address: street,
        city, state, zip,
        lat, lng,
        formatted: place.formatted_address ?? `${street}, ${city}, ${state} ${zip}`,
      });
      setError(null);
    });
    return () => { g.maps.event.removeListener(listener); };
  }, [editing, mapsReady]);

  function open() {
    setPickedAddress(null);
    setError(null);
    setPermanent(false);
    setCascadePrompt(null);
    setEditing(true);
  }
  function cancel() {
    setPickedAddress(null);
    setError(null);
    setPermanent(false);
    setCascadePrompt(null);
    setEditing(false);
  }

  // Click "Save". For a one-time (job) change, just write it. For a permanent
  // (client) change, first check how many upcoming jobs carry their own saved
  // address — if any, ask how far to cascade before writing.
  async function save() {
    if (!pickedAddress) {
      setError("Pick an address from the suggestions.");
      return;
    }
    if (!permanent) { await doSave("job", "none"); return; }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`${API}/api/jobs/${job.id}/address`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ address: pickedAddress.address, city: pickedAddress.city, state: pickedAddress.state, zip: pickedAddress.zip, mode: "client", preview: true }),
      });
      const body = await r.json().catch(() => ({} as any));
      const total = Number(body?.future_override_total ?? 0);
      if (total > 0) {
        setSaving(false);
        setCascadePrompt({ total, same: Number(body?.future_same ?? 0), diff: Number(body?.future_different ?? 0) });
        return;
      }
      // No upcoming jobs with their own address — nothing to ask.
      await doSave("client", "none");
    } catch (e: any) {
      setError(e.message || "Network error.");
      setSaving(false);
    }
  }

  async function doSave(mode: "client" | "job", cascade: "none" | "matching" | "all") {
    if (!pickedAddress) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`${API}/api/jobs/${job.id}/address`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          address: pickedAddress.address,
          city:    pickedAddress.city,
          state:   pickedAddress.state,
          zip:     pickedAddress.zip,
          mode,
          cascade_future: cascade,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setError(body.error || `Save failed (HTTP ${r.status})`);
        setSaving(false);
        return;
      }
      const body = await r.json().catch(() => ({} as any));
      const effectiveMode = body?.data?.mode ?? mode;
      const cascaded = Number(body?.data?.cascaded_jobs ?? 0);
      toast({
        title: "Address updated",
        description: effectiveMode === "client"
          ? (cascaded > 0
              ? `Applied to this client and ${cascaded} upcoming job${cascaded === 1 ? "" : "s"}.`
              : "Applied to this client and all future jobs.")
          : "Applied as a one-time override for this job only.",
      });
      setEditing(false);
      setPickedAddress(null);
      setPermanent(false);
      setCascadePrompt(null);
      onUpdate();
    } catch (e: any) {
      setError(e.message || "Network error.");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <span style={{ color: "#9E9B94", flexShrink: 0, marginTop: 1 }}><MapPin size={14} /></span>
        <span style={{ fontSize: 13, color: "#1A1917", lineHeight: 1.5, flex: 1 }}>
          {job.address || "(No address)"}
        </span>
        <button
          onClick={open}
          style={{
            fontSize: 11, fontWeight: 600, color: "#2D9B83",
            background: "transparent", border: "1px solid #A7F3D0",
            borderRadius: 6, padding: "2px 8px", cursor: "pointer",
            fontFamily: FF, flexShrink: 0,
          }}
          title="Edit address"
        >
          Edit
        </button>
      </div>
    );
  }

  const inputStyle: React.CSSProperties = {
    fontSize: 13, color: "#1A1917", fontFamily: FF,
    border: "1px solid #E5E2DC", borderRadius: 6,
    padding: "8px 10px", width: "100%", boxSizing: "border-box",
    background: saving ? "#F8F7F4" : "#FFFFFF",
  };

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
      <span style={{ color: "#9E9B94", flexShrink: 0, marginTop: 8 }}><MapPin size={14} /></span>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
        <input
          ref={inputRef}
          type="text"
          placeholder={mapsReady ? "Start typing the address…" : "Loading Google Maps…"}
          autoFocus
          disabled={saving || !mapsReady}
          style={inputStyle}
          // Note: Google Places Autocomplete writes the formatted address back
          // into this input as the user picks. We do not need to bind a value.
        />
        {pickedAddress && (
          <div style={{
            fontSize: 12, color: "#1A1917", lineHeight: 1.4,
            background: "#F0FDF4", border: "1px solid #BBF7D0",
            borderRadius: 6, padding: "8px 10px",
          }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Verified address:</div>
            <div>{pickedAddress.address || "(no street)"}</div>
            <div style={{ color: "#4B5563" }}>
              {pickedAddress.city}{pickedAddress.state ? `, ${pickedAddress.state}` : ""}{pickedAddress.zip ? ` ${pickedAddress.zip}` : ""}
            </div>
          </div>
        )}
        {/* [permanent toggle] After Google verifies the address the user
            decides whether the change cascades to the client record (and
            all future jobs) or stays as a one-time override on this job
            only. Default is one-time. The toggle hides when the client
            has no address on file at all because the server cascades
            unconditionally in that case (no canonical record to override). */}
        {pickedAddress && clientHasAddress && (
          <label style={{
            display: "flex", alignItems: "flex-start", gap: 8,
            fontSize: 12, color: "#1A1917", lineHeight: 1.4,
            cursor: saving ? "default" : "pointer",
            background: "#F8F7F4", border: "1px solid #E5E2DC",
            borderRadius: 6, padding: "8px 10px",
          }}>
            <input
              type="checkbox"
              checked={permanent}
              onChange={e => setPermanent(e.target.checked)}
              disabled={saving}
              style={{ marginTop: 2, flexShrink: 0, accentColor: "#2D9B83" }}
            />
            <span>
              <span style={{ fontWeight: 600 }}>Save permanently for this client.</span>
              <span style={{ color: "#6B6860" }}> Apply this address to all future jobs for this client.</span>
            </span>
          </label>
        )}
        <div style={{ fontSize: 11, color: "#6B6860", lineHeight: 1.4 }}>
          {!clientHasAddress
            ? "This client has no address on file. The new address will become their default."
            : permanent
              ? "This will update the client and apply to all future jobs."
              : "This is a one-time override for this job only."}
        </div>
        {error && (
          <div style={{ fontSize: 12, color: "#991B1B", background: "#FEE2E2", border: "1px solid #FCA5A5", borderRadius: 6, padding: "6px 8px" }}>
            {error}
          </div>
        )}
        {cascadePrompt ? (
          /* [address-cascade] Ask how far the permanent change reaches into
             jobs already on the calendar. Jobs without their own saved
             address inherit the client change automatically and aren't
             counted here. */
          <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917" }}>
              {cascadePrompt.total} upcoming job{cascadePrompt.total === 1 ? "" : "s"} {cascadePrompt.total === 1 ? "has" : "have"} their own saved address.
            </div>
            <div style={{ fontSize: 11, color: "#4B5563", lineHeight: 1.4 }}>
              {cascadePrompt.diff > 0
                ? `${cascadePrompt.diff} ${cascadePrompt.diff === 1 ? "is" : "are"} at a different address than the current one. Update them to the new address too?`
                : "Update those to the new address as well?"}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              <button onClick={() => doSave("client", "all")} disabled={saving}
                style={{ fontSize: 12, fontWeight: 700, color: "#FFFFFF", background: saving ? "#9CA3AF" : "#2D9B83", border: "none", borderRadius: 6, padding: "7px 12px", cursor: saving ? "not-allowed" : "pointer", fontFamily: FF, textAlign: "left" }}>
                {saving ? "Saving…" : `Update all ${cascadePrompt.total} upcoming job${cascadePrompt.total === 1 ? "" : "s"}`}
              </button>
              {cascadePrompt.diff > 0 && cascadePrompt.same > 0 && (
                <button onClick={() => doSave("client", "matching")} disabled={saving}
                  style={{ fontSize: 12, fontWeight: 600, color: "#2D9B83", background: "#FFFFFF", border: "1px solid #A7F3D0", borderRadius: 6, padding: "7px 12px", cursor: saving ? "not-allowed" : "pointer", fontFamily: FF, textAlign: "left" }}>
                  Update only the {cascadePrompt.same} at the old address (leave the {cascadePrompt.diff} different)
                </button>
              )}
              <button onClick={() => doSave("client", "none")} disabled={saving}
                style={{ fontSize: 12, fontWeight: 600, color: "#6B6860", background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 6, padding: "7px 12px", cursor: saving ? "not-allowed" : "pointer", fontFamily: FF, textAlign: "left" }}>
                Just the client record — leave upcoming jobs as they are
              </button>
              <button onClick={() => setCascadePrompt(null)} disabled={saving}
                style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", background: "transparent", border: "none", cursor: "pointer", fontFamily: FF, alignSelf: "flex-start", padding: "2px 0" }}>
                ← Back
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={save}
              disabled={saving || !pickedAddress}
              style={{
                fontSize: 12, fontWeight: 700, color: "#FFFFFF",
                background: (saving || !pickedAddress) ? "#9CA3AF" : "#2D9B83",
                border: "none", borderRadius: 6, padding: "6px 14px",
                cursor: (saving || !pickedAddress) ? "not-allowed" : "pointer", fontFamily: FF,
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={cancel}
              disabled={saving}
              style={{
                fontSize: 12, fontWeight: 600, color: "#6B6860",
                background: "transparent", border: "1px solid #E5E2DC",
                borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontFamily: FF,
              }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// [time-edit 2026-04-29] Inline time editor on the JobPanel. Mirrors
// InlineAddressEdit's pencil-affordance pattern. Start + duration are
// the canonical pair (the schema stores scheduled_time + allowed_hours;
// "end time" is derived); we surface end-time as a calculated readout
// while the operator is editing for clarity. For recurring jobs we
// also expose a day-of-week picker so the operator can move "Mondays"
// to "Tuesdays" for the whole series in one shot.
//
// On save, if the job is recurring we open a focused 4-option cascade
// modal (this visit / this+future / all / skip this visit). One-offs
// skip the prompt and submit with cascade_scope='this_job'. The PATCH
// route's existing per-field unlock + audit-log logic does the rest;
// time is in the "free with audit trail" tier so no warn dialog fires.
function InlineTimeEdit({ job, onUpdate }: { job: DispatchJob; onUpdate: () => void }) {
  const token = useAuthStore(s => s.token)!;
  const { toast } = useToast();
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");

  const isRecurring = !!job.frequency && job.frequency !== "on_demand";
  // jobs.scheduled_time arrives as "HH:MM:SS" or "H:MM AM/PM" — fmtTime /
  // timeToMins handle both. For the <input type="time"> we need 24-hour
  // "HH:MM" specifically.
  const startH24 = (() => {
    const mins = timeToMins(job.scheduled_time);
    return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  })();
  const initialDurationH = job.duration_minutes > 0 ? job.duration_minutes / 60 : 2;

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cascadePrompt, setCascadePrompt] = useState<null | "open">(null);
  // [cascade-confirm 2026-06-05] Series-wide scopes (this_and_future / all) can
  // remove + recreate future occurrences; require an explicit confirm step.
  const [pendingScope, setPendingScope] = useState<null | "this_and_future" | "all">(null);
  const [error, setError] = useState<string | null>(null);
  const [start, setStart] = useState(startH24);
  const [durationH, setDurationH] = useState<number>(initialDurationH);
  // Recurring day-of-week. Single-day frequencies use day_of_week
  // (string); multi-day frequencies (daily/weekdays/custom_days) use
  // days_of_week (int array). For now the editor only exposes a single
  // weekday change for single-day cadences (weekly/biweekly/etc.) —
  // multi-day series with multiple weekdays keep their pattern; the
  // user's spec is "change Mondays to Tuesdays", that's single-day.
  const dayMap: Record<string, number> = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
  const initialDow = (() => {
    if (!job.scheduled_date) return 1;
    return new Date(job.scheduled_date + "T12:00:00").getDay();
  })();
  const [dow, setDow] = useState<number>(initialDow);
  const isSingleDayRecurring = isRecurring && (
    job.frequency === "weekly" ||
    job.frequency === "biweekly" ||
    job.frequency === "every_3_weeks" ||
    job.frequency === "monthly"
  );

  const endTimeDisplay = (() => {
    const [hh, mm] = start.split(":").map(n => parseInt(n, 10));
    if (Number.isNaN(hh) || Number.isNaN(mm)) return "—";
    const totalMins = hh * 60 + mm + Math.round(durationH * 60);
    const eh = Math.floor(totalMins / 60) % 24;
    const em = totalMins % 60;
    const displayH = eh === 0 ? 12 : eh > 12 ? eh - 12 : eh;
    return `${displayH}:${String(em).padStart(2, "0")} ${eh < 12 ? "AM" : "PM"}`;
  })();

  function reset() {
    setStart(startH24);
    setDurationH(initialDurationH);
    setDow(initialDow);
    setError(null);
  }

  // Submit through the same PATCH endpoint EditJobModal uses so the
  // per-field unlock + audit log + cascade logic is identical.
  async function submit(scope: "this_job" | "this_and_future" | "all" | "remove_this") {
    setSaving(true);
    setError(null);
    try {
      // Compute the new scheduled_date when the day-of-week changes on
      // a single-day recurring job. We move the SAME calendar week's
      // occurrence to the new weekday — Mondays-to-Tuesdays moves
      // 4/27 → 4/28, not next Monday → next Tuesday.
      let newDate = job.scheduled_date;
      if (isSingleDayRecurring && dow !== initialDow && job.scheduled_date) {
        const cur = new Date(job.scheduled_date + "T12:00:00");
        cur.setDate(cur.getDate() + (dow - initialDow));
        newDate = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
      }

      const payload: Record<string, unknown> = {
        scheduled_date: newDate,
        scheduled_time: `${start}:00`,
        allowed_hours: String(durationH.toFixed(2)),
        cascade_scope: scope,
      };
      // Only pass the schedule's day_of_week field when actually
      // cascading to the schedule template (this_and_future / all).
      // 'this_job' / 'remove_this' don't touch the schedule.
      if (isSingleDayRecurring && (scope === "this_and_future" || scope === "all")) {
        const dayName = Object.entries(dayMap).find(([, n]) => n === dow)?.[0];
        if (dayName) payload.day_of_week = dayName;
      }

      const r = await fetch(`${API}/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(d.message || d.error || `HTTP ${r.status}`);
        return;
      }
      toast({ title: "Time updated", description: scope === "this_job" || scope === "remove_this" ? "This visit only." : scope === "all" ? "Whole series." : "This visit and future." });
      setEditing(false);
      setCascadePrompt(null);
      onUpdate();
    } catch (err: any) {
      setError(err?.message ?? "Network error");
    } finally {
      setSaving(false);
    }
  }

  function onSaveClick() {
    if (isRecurring) {
      setCascadePrompt("open");
    } else {
      submit("this_job");
    }
  }

  if (!editing) {
    const endMins = timeToMins(job.scheduled_time) + (job.duration_minutes || 0);
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Clock size={14} color="#9E9B94" style={{ flexShrink: 0 }} />
        <span style={{ fontSize: 13, color: "#4B4A47", flex: 1 }}>
          {fmtTime(job.scheduled_time)} – {fmtTime(minsToStr(endMins))}
        </span>
        <button onClick={() => { reset(); setEditing(true); }}
          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 6, backgroundColor: "#F8F7F4", border: "1px solid #E5E2DC", cursor: "pointer", color: "#6B6860" }}
          title="Edit time">
          <span style={{ fontSize: 12 }}>✎</span>
        </button>
      </div>
    );
  }

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", backgroundColor: "#F8F7F4", border: "1px solid #E5E2DC", borderRadius: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Clock size={14} color="#9E9B94" />
          <span style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.05em" }}>Edit time</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "#6B6860", fontWeight: 600 }}>
            Start
            <input type="time" value={start} onChange={e => setStart(e.target.value)}
              style={{ padding: "6px 8px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 13, fontFamily: FF, color: "#1A1917" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "#6B6860", fontWeight: 600 }}>
            Duration (hours)
            <input type="number" min={0.5} step={0.25} value={durationH} onChange={e => setDurationH(Math.max(0.25, parseFloat(e.target.value) || 0))}
              style={{ padding: "6px 8px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 13, fontFamily: FF, color: "#1A1917" }} />
          </label>
        </div>
        <div style={{ fontSize: 11, color: "#6B6860" }}>
          Ends at <strong style={{ color: "#1A1917" }}>{endTimeDisplay}</strong>
        </div>
        {isSingleDayRecurring && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Day of week</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((label, i) => (
                <button key={i} type="button" onClick={() => setDow(i)}
                  style={{
                    padding: "5px 10px", borderRadius: 6,
                    border: `1px solid ${dow === i ? "var(--brand, #00C9A0)" : "#E5E2DC"}`,
                    background: dow === i ? "rgba(0,201,160,0.12)" : "#FFFFFF",
                    color: dow === i ? "var(--brand, #00C9A0)" : "#1A1917",
                    fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: FF,
                  }}>{label}</button>
              ))}
            </div>
            {dow !== initialDow && (
              <div style={{ fontSize: 11, color: "#92400E", marginTop: 4 }}>
                Day-of-week changes apply to the schedule template — choose "This and future" or "All visits" to cascade.
              </div>
            )}
          </div>
        )}
        {error && (
          <div style={{ fontSize: 12, color: "#991B1B" }}>{error}</div>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <button onClick={() => setEditing(false)} disabled={saving}
            style={{ flex: 1, padding: "7px", borderRadius: 6, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#6B7280", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
            Cancel
          </button>
          <button onClick={onSaveClick} disabled={saving}
            style={{ flex: 2, padding: "7px", borderRadius: 6, border: "none", background: "var(--brand, #00C9A0)", color: "#FFFFFF", fontSize: 12, fontWeight: 700, cursor: saving ? "wait" : "pointer", fontFamily: FF }}>
            {saving ? "Saving…" : isRecurring ? "Save…" : "Save"}
          </button>
        </div>
      </div>

      {/* 4-option cascade prompt — recurring jobs only. Mirrors
          EditJobModal's prompt; isolated here so the inline editor
          doesn't pull the whole modal in. */}
      {cascadePrompt === "open" && (
        <>
          <div onClick={() => setCascadePrompt(null)}
            style={{ position: "fixed", inset: 0, backgroundColor: "rgba(15,16,18,0.55)", zIndex: 220 }} />
          <div style={{
            position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            zIndex: 221, width: 460, maxWidth: "92vw",
            backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12,
            boxShadow: "0 16px 48px rgba(0,0,0,0.18)", padding: "20px 22px", fontFamily: FF,
          }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#1A1917", marginBottom: 6 }}>Apply this change to:</div>
            <div style={{ fontSize: 12, color: "#6B6860", marginBottom: 14 }}>This is a recurring job. Pick how broadly the time change should apply.</div>
            {pendingScope && (
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 8, marginBottom: 12 }}>
                <AlertTriangle size={16} color="#B91C1C" style={{ flexShrink: 0, marginTop: 1 }} />
                <span style={{ fontSize: 12, color: "#991B1B", lineHeight: 1.4 }}>
                  This applies to <strong>{pendingScope === "all" ? "every visit (past + future)" : "every future visit"}</strong> of this recurring job. If you changed the day, occurrences that no longer match are <strong>removed</strong> and recreated. Continue?
                </span>
              </div>
            )}
            {pendingScope ? (
              <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                <button type="button" onClick={() => setPendingScope(null)} disabled={saving}
                  style={{ flex: 1, padding: "10px", borderRadius: 8, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#6B7280", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>Back</button>
                <button type="button" onClick={() => submit(pendingScope)} disabled={saving}
                  style={{ flex: 2, padding: "10px", borderRadius: 8, border: "none", background: "#DC2626", color: "#FFFFFF", fontSize: 13, fontWeight: 700, cursor: saving ? "wait" : "pointer", fontFamily: FF }}>
                  {saving ? "Applying…" : "Yes, apply to the series"}
                </button>
              </div>
            ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
              {([
                { v: "this_job",        label: "Just this visit",                  sub: "Default. Updates this occurrence; other visits unchanged." },
                { v: "this_and_future", label: "This and all future visits",       sub: "Updates the schedule template + every future scheduled occurrence." },
                { v: "all",             label: "All visits in the series",         sub: "Backfills past + future. Paid past jobs are skipped." },
                { v: "remove_this",     label: "Skip this visit only",             sub: "Mark this visit as one-off; schedule template stays intact." },
              ] as const).map(opt => (
                <button key={opt.v} type="button"
                  onClick={() => { if (opt.v === "this_and_future" || opt.v === "all") setPendingScope(opt.v); else submit(opt.v); }}
                  disabled={saving}
                  style={{
                    textAlign: "left", padding: "12px 14px", borderRadius: 10,
                    border: "1.5px solid #E5E2DC", background: "#F7F6F3",
                    cursor: saving ? "wait" : "pointer", fontFamily: FF,
                  }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917" }}>{opt.label}</div>
                  <div style={{ fontSize: 11, color: "#6B6860", marginTop: 2 }}>{opt.sub}</div>
                </button>
              ))}
            </div>
            )}
            <button onClick={() => { setPendingScope(null); setCascadePrompt(null); }} disabled={saving}
              style={{ width: "100%", padding: "8px", borderRadius: 8, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#6B7280", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
              Cancel
            </button>
          </div>
        </>
      )}
    </>
  );
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

  // Show charge button when: completed + can charge + not already charged + Stripe client.
  // Prefer the LIVE dispatch amount (base_fee + adjustments + add-ons) over the
  // billed_amount cache — that cache isn't refreshed on price/fee edits, so it
  // goes stale and makes the panel disagree with the chip/tech-row total.
  const chargeAmount = Number(job.amount ?? job.billed_amount ?? 0);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("customer_request");
  const [cancelNote, setCancelNote] = useState("");
  // MC-style cancel action picker. Two-step modal:
  //   step 1 → pick action (move/bump/skip/cancel/lockout/cancel_service)
  //   step 2 → review computed charge + optional override + notes → confirm
  const [cancelAction, setCancelAction] = useState<null | "move" | "bump" | "skip" | "cancel" | "lockout" | "cancel_service">(null);
  const [chargeOverride, setChargeOverride] = useState<string>("");
  // Reschedule date/time for move/bump actions. Move = customer-initiated
  // reschedule; Bump = office-initiated. Both leave the job as scheduled
  // and update its scheduled_date/time. Defaults to the job's current
  // date as the convenient starting point; operator picks new values.
  const [cancelNewDate, setCancelNewDate] = useState<string>("");
  const [cancelNewTime, setCancelNewTime] = useState<string>("");

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
  // [duplicate-job 2026-06-08] HCP-style "copy this job to a new date, same
  // service" (Maribel). Works the same on mobile + desktop via this shared panel.
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [duplicateDate, setDuplicateDate] = useState("");
  const [duplicateTime, setDuplicateTime] = useState("");
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  const [smsOpen, setSmsOpen] = useState(false);
  const [smsMessage, setSmsMessage] = useState("");
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsTwilioOk, setSmsTwilioOk] = useState<boolean | null>(null);
  // [AG] Edit modal state — triggered by the Edit button in the drawer footer.
  const [editOpen, setEditOpen] = useState(false);

  // Commission override state
  const [commTechs, setCommTechs] = useState<JobTechCommission[]>(job.technicians ?? []);
  const [overrideOpen, setOverrideOpen] = useState<Record<number, boolean>>({});
  const [overrideVal, setOverrideVal] = useState<Record<number, string>>({});
  const [overrideBusy, setOverrideBusy] = useState(false);
  const canManageCommission = (userRole === "owner" || userRole === "admin" || userRole === "office");
  const canEditOfficeNotes  = (userRole === "owner" || userRole === "admin" || userRole === "office");

  // [office-clock 2026-06-05] Desktop office clock in/out. The field-app tech
  // clock isn't shipped, so the office clocks the team in/out from the board to
  // start collecting real clocked minutes — which feed payroll hours and the
  // proportional-by-minutes commission split (Sal: "starting today we clock the
  // team in and out"). Per-tech clock state for THIS job loads from the legacy
  // timeclock table; writes go through the role-gated office endpoints.
  const canClock = (userRole === "owner" || userRole === "admin" || userRole === "office");
  const [clockMap, setClockMap] = useState<Record<number, { id: number; clock_in_at: string; clock_out_at: string | null }>>({});
  const [clockBusy, setClockBusy] = useState<number | null>(null);
  const loadClocks = useCallback(async () => {
    try {
      const r = await fetch(`${_API3}/api/timeclock?job_id=${job.id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return;
      const d = await r.json();
      // Rows come newest-first; keep the most recent entry per tech as their
      // current state (open if clock_out_at is null, else completed).
      const m: Record<number, { id: number; clock_in_at: string; clock_out_at: string | null }> = {};
      for (const e of (d.data ?? [])) {
        if (!m[e.user_id]) m[e.user_id] = { id: e.id, clock_in_at: e.clock_in_at, clock_out_at: e.clock_out_at };
      }
      setClockMap(m);
    } catch {}
  }, [job.id, token, _API3]);
  useEffect(() => { if (canClock) loadClocks(); }, [canClock, loadClocks]);

  async function handleOfficeClock(user_id: number, dir: "in" | "out") {
    setClockBusy(user_id);
    try {
      const r = await fetch(`${_API3}/api/timeclock/office/clock-${dir}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.id, user_id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Clock action failed");
      await loadClocks();
      onUpdate();
    } catch (err: any) {
      toast({ title: err.message || "Clock action failed" });
    } finally {
      setClockBusy(null);
    }
  }

  // Header overflow (•••) menu — home for rare/destructive actions so they
  // stay out of the everyday content flow.
  const [menuOpen, setMenuOpen] = useState(false);
  // [delete-confirm 2026-06-03] Two-step inline confirm so a stray click on
  // "Delete job" can't wipe a job. First click arms; second click (the red
  // "Confirm delete") actually deletes. Sal: "needs a confirmation after
  // pressing delete in case by accident."
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Delete a job. A completed job (or one with clock-in / add-on / billing
  // history) can't be removed by a plain delete — child rows block it and the
  // server returns an error. The server's force path cleans those up first;
  // owner/admin can escalate after a second, clearer confirm.
  async function handleDeleteJob() {
    try {
      let r = await fetch(`${_API3}/api/jobs/${job.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      let d = await r.json().catch(() => ({}));
      if (!r.ok && canCharge) {
        if (window.confirm("This job has clock-in, completion, or billing history. Remove the job and clear that history too?")) {
          r = await fetch(`${_API3}/api/jobs/${job.id}?force=true`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
          d = await r.json().catch(() => ({}));
        }
      }
      if (!r.ok) { toast({ title: "Couldn't delete", description: d.message || d.error || `HTTP ${r.status}` }); return; }
      toast({ title: "Job deleted" });
      onClose();
      onUpdate();
    } catch (e: any) {
      toast({ title: "Couldn't delete", description: e?.message ?? "Network error" });
    }
  }

  // Office Notes state
  const [officeNotes, setOfficeNotes] = useState(job.office_notes || "");
  const [officeNotesSaving, setOfficeNotesSaving] = useState(false);
  const [officeNotesSaved, setOfficeNotesSaved] = useState(false);
  // [cleaner-notes-fix 2026-06-16] (#15) job.notes is the note the CLEANER sees
  // in the field app ("Today's Job Notes"). It used to render read-only here,
  // editable only behind the modal's unobvious "Instructions" label. Make it
  // inline-editable from the panel (office/owner/admin), mirroring office-notes
  // auto-save. Saves via PUT { notes } — already accepted by the route.
  const [cleanerNotes, setCleanerNotes] = useState(job.notes || "");
  const [cleanerNotesSaving, setCleanerNotesSaving] = useState(false);
  const [cleanerNotesSaved, setCleanerNotesSaved] = useState(false);

  // Rate mods state — per-job time and fee adjustments. Owner/admin/office
  // can manage. The backend recomputes billed_amount = base_fee + SUM(mods)
  // after every write; we reload the drawer through onUpdate() to pull the
  // fresh number.
  type RateMod = {
    id: number; mod_type: "time" | "flat"; minutes: number | null;
    amount: string; reason: string; created_by: number | null;
    created_at: string; created_by_name?: string | null;
  };
  const canManageMods = (userRole === "owner" || userRole === "admin" || userRole === "office");
  const [rateMods, setRateMods] = useState<RateMod[]>([]);
  const [rateModsLoaded, setRateModsLoaded] = useState(false);
  const [modAddOpen, setModAddOpen] = useState(false);
  const [modType, setModType] = useState<"time" | "flat">("time");
  const [modMinutes, setModMinutes] = useState("");
  const [modAmount, setModAmount] = useState("");
  const [modReason, setModReason] = useState("");
  const [modBusy, setModBusy] = useState(false);
  const [modError, setModError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${_API3}/api/jobs/${job.id}/rate-mods`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const d = await r.json();
        if (alive) {
          setRateMods((d.mods || []) as RateMod[]);
          setRateModsLoaded(true);
        }
      } catch {}
    })();
    return () => { alive = false; };
  }, [job.id, token]);

  async function addRateMod() {
    setModError("");
    if (!modReason.trim()) { setModError("Reason is required"); return; }
    const amt = Number(modAmount);
    if (Number.isNaN(amt) || modAmount.trim() === "") { setModError("Amount must be numeric"); return; }
    if (modType === "time") {
      const mins = Number(modMinutes);
      if (Number.isNaN(mins) || modMinutes.trim() === "") { setModError("Minutes required for time adjustments"); return; }
    }
    setModBusy(true);
    try {
      const body: any = { mod_type: modType, amount: amt, reason: modReason.trim() };
      if (modType === "time") body.minutes = Number(modMinutes);
      const r = await fetch(`${_API3}/api/jobs/${job.id}/rate-mods`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error || "Failed");
      setRateMods(prev => [...prev, d.mod as RateMod]);
      setModType("time"); setModMinutes(""); setModAmount(""); setModReason("");
      setModAddOpen(false);
      toast({ title: "Adjustment added" });
      onUpdate();
    } catch (err: any) {
      setModError(err.message || "Failed to add adjustment");
    } finally {
      setModBusy(false);
    }
  }

  async function deleteRateMod(modId: number) {
    try {
      const r = await fetch(`${_API3}/api/jobs/${job.id}/rate-mods/${modId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error("Delete failed");
      setRateMods(prev => prev.filter(m => m.id !== modId));
      toast({ title: "Adjustment removed" });
      onUpdate();
    } catch (err: any) {
      toast({ title: "Failed to remove", description: err.message || "", variant: "destructive" as any });
    }
  }

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

  // [cleaner-notes-fix 2026-06-16] (#15) Debounced auto-save for the
  // cleaner-visible job note (job.notes). Same pattern as office notes.
  useEffect(() => {
    const delay = setTimeout(async () => {
      if (cleanerNotes === (job.notes || "")) return; // no change
      setCleanerNotesSaving(true);
      setCleanerNotesSaved(false);
      try {
        await fetch(`${_API3}/api/jobs/${job.id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ notes: cleanerNotes || null }),
        });
        setCleanerNotesSaved(true);
        setTimeout(() => setCleanerNotesSaved(false), 3000);
      } catch {}
      finally { setCleanerNotesSaving(false); }
    }, 2000);
    return () => clearTimeout(delay);
  }, [cleanerNotes, job.id, job.notes, token]);

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

  // [AF] Mark-complete inline confirmation — one-click → confirm → fire. The
  // 2-stage interaction replaces the previous one-click button so accidental
  // completion isn't a 1-pixel miss.
  const [confirmComplete, setConfirmComplete] = useState(false);
  const isLocked = !!job.locked_at || job.status === "complete" || job.status === "cancelled";
  const completedAtLabel = (() => {
    const t = job.actual_end_time || job.locked_at;
    if (!t) return null;
    try {
      const d = new Date(t);
      return d.toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch { return null; }
  })();

  // [AF] Add team member state — now grouped by clock-in status ("Available"
  // vs "Currently on a job") using /api/users/techs-with-status. The endpoint
  // excludes already-assigned techs server-side via ?exclude=<ids>.
  const [addTechOpen, setAddTechOpen] = useState(false);
  type TechRow = { id: number; name: string; role: string; avatar_url?: string | null; is_clocked_in: boolean; currently_at: string | null };
  const [addTechList, setAddTechList] = useState<TechRow[]>([]);
  const [addTechLoading, setAddTechLoading] = useState(false);
  const [addTechBusy, setAddTechBusy] = useState(false);

  useEffect(() => {
    if (!addTechOpen) return;
    setAddTechLoading(true);
    const existingIds = new Set<number>();
    for (const t of (job.technicians ?? [])) existingIds.add(t.user_id);
    if (job.assigned_user_id) existingIds.add(job.assigned_user_id);
    // [pool 2026-06-12] Branch-isolate the candidate pool: an Oak Lawn job
    // should only offer Oak Lawn (or branch-less) techs. The endpoint already
    // supports ?branch_id and treats NULL home_branch as dispatchable anywhere;
    // the modal just never passed it.
    const params = new URLSearchParams();
    if (existingIds.size) params.set("exclude", Array.from(existingIds).join(","));
    if (job.branch_id != null) params.set("branch_id", String(job.branch_id));
    const qs = params.toString() ? `?${params}` : "";
    fetch(`${_API3}/api/users/techs-with-status${qs}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setAddTechList(Array.isArray(d?.data) ? d.data : []))
      .catch(() => setAddTechList([]))
      .finally(() => setAddTechLoading(false));
  }, [addTechOpen, job.id]);

  async function addTechToJob(techId: number) {
    setAddTechBusy(true);
    try {
      // [AI.1] Pass is_primary explicitly when the job has no current
      // assignment so the server promotes this tech AND mirrors to
      // jobs.assigned_user_id. Without this, drawer "Add Team Member" on an
      // unassigned job leaves the dispatch chip in the Unassigned row.
      const isUnassigned = job.assigned_user_id == null;
      const r = await fetch(`${_API3}/api/jobs/${job.id}/technicians`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: techId, is_primary: isUnassigned ? true : undefined }),
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

  // [team-edit 2026-06-03] Remove a tech from the job. The server promotes the
  // next remaining tech to primary + mirrors jobs.assigned_user_id (or NULLs it
  // when none remain) and returns the recalculated team via { data }. We update
  // commTechs from the response so the panel reflects the removal immediately —
  // no reopen needed (Sal: "you cannot remove a tech" / list "not sticky").
  const [removeTechBusy, setRemoveTechBusy] = useState<number | null>(null);
  async function removeTechFromJob(techId: number) {
    setRemoveTechBusy(techId);
    try {
      const r = await fetch(`${_API3}/api/jobs/${job.id}/technicians/${techId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || d.error || `HTTP ${r.status}`);
      if (d.data) setCommTechs(d.data);
      toast({ title: "Team member removed" });
      onUpdate();
    } catch (e: any) {
      toast({ title: "Couldn't remove", description: e?.message ?? "Network error", variant: "destructive" });
    } finally { setRemoveTechBusy(null); }
  }

  // [AF] Supply-logging state removed — drawer section pulled per cleanup.
  // /api/supplies/log endpoint and supplies table remain in place so the
  // feature can return later without schema churn.

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
          // [AF] 409 = already complete/cancelled (server-side guard). Surface
          // cleanly, close the confirm, and let onUpdate pull fresh state.
          if (r.status === 409) {
            toast({ title: "Already locked", description: (err as any).message || "This job is already complete or cancelled." });
            setConfirmComplete(false);
            onUpdate();
            onClose();
            return;
          }
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
    if (!cancelAction) return; // shouldn't happen — confirm button only enabled when action picked
    // Move + Bump require a new date. Confirm button is gated, but a
    // belt-and-suspenders check here too. Time is optional (the route
    // keeps the existing time when missing) so we only block on date.
    if ((cancelAction === "move" || cancelAction === "bump") && !cancelNewDate) {
      toast({ title: "Pick a new date for the reschedule", variant: "destructive" });
      return;
    }
    setBusy(true);
    const API2 = import.meta.env.BASE_URL.replace(/\/$/, "");
    try {
      // [cancel-ghost-job-diagnostics 2026-06-01] Snapshot of the dispatch
      // BEFORE the cancel fires. Set of job IDs visible on the same date.
      // After onUpdate() refetches the dispatch, we diff against this to
      // catch any job that "appears out of nowhere" — Sal's bug report.
      // Logs to console (always) and toasts a warning (only when a ghost
      // is detected) so it doesn't spam the UI on normal cancellations.
      const beforeIds = (() => {
        try {
          const acc: Array<{id: number; client_id: number | null; client_name: string | null; tech_id: number | null}> = [];
          // Walk the dispatch dataset attached to the panel via window so we
          // don't have to thread props through every component. The dispatch
          // grid exposes the current snapshot for debugging.
          const snapshot = (window as any).__qlenoDispatchSnapshot;
          if (snapshot?.employees) {
            for (const e of snapshot.employees) {
              for (const j of e.jobs || []) acc.push({ id: j.id, client_id: j.client_id, client_name: j.client_name, tech_id: e.id });
            }
          }
          if (snapshot?.unassigned_jobs) {
            for (const j of snapshot.unassigned_jobs) acc.push({ id: j.id, client_id: j.client_id, client_name: j.client_name, tech_id: null });
          }
          return acc;
        } catch {
          return [];
        }
      })();

      // POST /api/cancellations/action handles the full transaction:
      //   - resolves the customer charge from company + per-client policy
      //   - flips job status (complete for charged, cancelled for free)
      //   - marks recurring schedule cancelled when action='cancel_service'
      //   - writes the cancellation_log row
      const overrideNum = chargeOverride.trim() !== "" ? Number(chargeOverride) : undefined;
      const res = await fetch(`${API2}/api/cancellations/action`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: job.id,
          action: cancelAction,
          notes: cancelNote || undefined,
          charge_amount_override: Number.isFinite(overrideNum) ? overrideNum : undefined,
          // Move + Bump reschedule the job rather than cancelling it.
          // The backend updates jobs.scheduled_date/time and keeps
          // status='scheduled', writing the cancellation_log row for
          // audit. Other actions ignore these fields.
          new_date: (cancelAction === "move" || cancelAction === "bump") ? cancelNewDate : undefined,
          new_time: (cancelAction === "move" || cancelAction === "bump") && cancelNewTime ? cancelNewTime : undefined,
          // [reclassify-lockout 2026-06-17] Job was already completed. The
          // backend normally 409s on complete/cancelled jobs; this opt-in
          // flag lets a charging action (cancel/lockout) supersede the prior
          // completion. Only sent from the panel when the job is complete.
          reclassify: isLocked && job.status === "complete" ? true : undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Cancellation failed");
      }
      const body = await res.json();
      const charge = Number(body.charge_amount || 0);
      const moveDateLabel = cancelNewDate
        ? new Date(cancelNewDate + "T12:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : "";
      const labelByAction: Record<string, string> = {
        move: `Customer rescheduled to ${moveDateLabel}`,
        bump: `Rescheduled to ${moveDateLabel}`,
        skip: "Job skipped", cancel: "Job cancelled with full fee",
        lockout: "Lockout recorded with full fee",
        cancel_service: `Service cancelled (${body.future_cancelled_count} future jobs ended)`,
      };
      toast({
        title: labelByAction[cancelAction] ?? "Cancellation recorded",
        description: charge > 0 ? `Customer charged $${charge.toFixed(2)}` : undefined,
      });
      setCancelOpen(false);
      setCancelAction(null);
      setChargeOverride("");
      setCancelNote("");
      setCancelNewDate("");
      setCancelNewTime("");
      await onUpdate();

      // [cancel-ghost-job-diagnostics] AFTER snapshot. Wait one tick so the
      // dispatch refetch from onUpdate() has applied to state, then diff.
      // Any job ID present after but NOT before is a "ghost" — surfaces in
      // both the console (with full row) and a destructive toast so Sal
      // sees it without opening DevTools.
      setTimeout(() => {
        try {
          const snapshot = (window as any).__qlenoDispatchSnapshot;
          if (!snapshot) return;
          const afterMap = new Map<number, any>();
          for (const e of (snapshot.employees || [])) {
            for (const j of (e.jobs || [])) afterMap.set(j.id, { ...j, tech_name: e.name });
          }
          for (const j of (snapshot.unassigned_jobs || [])) afterMap.set(j.id, { ...j, tech_name: "Unassigned" });
          const beforeIdSet = new Set(beforeIds.map(b => b.id));
          const ghosts: any[] = [];
          for (const [id, j] of afterMap.entries()) {
            if (!beforeIdSet.has(id)) ghosts.push(j);
          }
          console.log("[cancel-ghost-diag]", {
            action: cancelAction,
            cancelled_job: { id: job.id, client_id: job.client_id, client_name: job.client_name },
            before_count: beforeIds.length,
            after_count: afterMap.size,
            ghosts,
          });
          if (ghosts.length > 0) {
            const g = ghosts[0];
            toast({
              title: `Ghost job detected: ${g.client_name ?? "Unknown"} (job #${g.id})`,
              description: `${ghosts.length} job(s) appeared that weren't there before. Open DevTools console for full trace and send Sal a screenshot.`,
              variant: "destructive",
            });
          }
        } catch (diagErr) {
          console.warn("[cancel-ghost-diag] failed:", diagErr);
        }
      }, 800);

      onClose();
    } catch (e) {
      toast({ title: (e as Error).message || "Error", variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function undoCancellation() {
    setBusy(true);
    const API2 = import.meta.env.BASE_URL.replace(/\/$/, "");
    try {
      const res = await fetch(`${API2}/api/cancellations/undo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Undo failed");
      }
      const body = await res.json();
      toast({
        title: "Cancellation undone",
        description: body.restored_status === "scheduled"
          ? "Job restored to scheduled — fee and tech cancellation pay removed."
          : "Fee removed — job marked a free skip (no charge).",
      });
      await onUpdate();
      onClose();
    } catch (e) {
      toast({ title: (e as Error).message || "Error", variant: "destructive" });
    } finally { setBusy(false); }
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
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: "#1A1917" }}>
              {(job.client_id || job.account_id) ? (
                <a
                  href={job.client_id ? `/customers/${job.client_id}` : `/accounts/${job.account_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open profile in a new tab"
                  style={{ color: "#1A1917", textDecoration: "none", cursor: "pointer" }}
                  onMouseEnter={e => (e.currentTarget.style.textDecoration = "underline")}
                  onMouseLeave={e => (e.currentTarget.style.textDecoration = "none")}
                >
                  {job.display_name ?? job.client_name}
                </a>
              ) : (job.display_name ?? job.client_name)}
            </h2>
            <span style={{ display: "inline-block", marginTop: 5, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", padding: "2px 8px", borderRadius: 4, backgroundColor: "var(--brand-dim)", color: "var(--brand)" }}>{fmtSvc(job.service_type)}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            {canEditOfficeNotes && (
              <div style={{ position: "relative" }}>
                <button
                  onClick={() => { setMenuOpen(o => !o); setConfirmDelete(false); }}
                  aria-label="More actions"
                  style={{ border: "none", background: menuOpen ? "#F3F1EC" : "none", cursor: "pointer", color: "#9E9B94", padding: 4, borderRadius: 6 }}
                ><MoreVertical size={18} /></button>
                {menuOpen && (
                  <>
                    {/* Click-away layer */}
                    <div onClick={() => { setMenuOpen(false); setConfirmDelete(false); }} style={{ position: "fixed", inset: 0, zIndex: 50 }} />
                    <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 51, minWidth: 200, background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, boxShadow: "0 8px 24px rgba(10,14,26,0.12)", padding: 4, overflow: "hidden" }}>
                      {!confirmDelete ? (
                        <button
                          onClick={() => setConfirmDelete(true)}
                          style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", color: "#DC2626", fontSize: 13, fontWeight: 600, fontFamily: FF, padding: "9px 10px", borderRadius: 6 }}
                          onMouseEnter={e => (e.currentTarget.style.background = "#FEF2F2")}
                          onMouseLeave={e => (e.currentTarget.style.background = "none")}
                        >
                          <Trash2 size={14} /> Delete job
                        </button>
                      ) : (
                        <div style={{ padding: "6px 8px 8px" }}>
                          <p style={{ margin: "2px 2px 8px", fontSize: 12, color: "#6B6860", fontFamily: FF, lineHeight: 1.4 }}>
                            Delete this job? It's removed from the schedule and recorded in the audit log.
                          </p>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              onClick={() => { setConfirmDelete(false); setMenuOpen(false); handleDeleteJob(); }}
                              style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, border: "none", background: "#DC2626", cursor: "pointer", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: FF, padding: "8px 10px", borderRadius: 6 }}
                            >
                              <Trash2 size={13} /> Confirm delete
                            </button>
                            <button
                              onClick={() => setConfirmDelete(false)}
                              style={{ border: "1px solid #E5E2DC", background: "#fff", cursor: "pointer", color: "#6B6860", fontSize: 12, fontWeight: 600, fontFamily: FF, padding: "8px 12px", borderRadius: 6 }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
            <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}><X size={18} /></button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          {/* [panel-revamp step 1] Unified tag row — status + recurring +
              residential/commercial. Wraps cleanly on the mobile bottom-sheet. */}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 10 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 20, backgroundColor: sc.bg, border: `1px solid ${sc.border}` }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: sc.dot }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: sc.text, textTransform: "capitalize" }}>{job.status.replace("_", " ")}</span>
            </span>
            {(job as any).recurring_schedule_id != null && (() => {
              const freqLabel = recurrenceLabel(job.frequency) || "Recurring";
              return (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 20, background: "#EEF4FF" }}>
                  <Repeat size={12} color="#3B6CC9" />
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#3B6CC9" }}>{freqLabel} recurring</span>
                </span>
              );
            })()}
            <span style={{ padding: "4px 10px", borderRadius: 20, background: "#F2F0EC", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "#6B6860" }}>
              {(job.client_type === "commercial" || job.account_id != null) ? "Commercial" : "Residential"}
            </span>
          </div>

          {/* Next visit + jump to schedule (recurring only) */}
          {(job as any).recurring_schedule_id != null && (() => {
            const iv: Record<string, number> = { weekly: 7, biweekly: 14, every_3_weeks: 21, monthly: 28, every_4_weeks: 28 };
            const days = iv[job.frequency];
            let nextStr = "";
            if (days && job.scheduled_date) {
              const d = new Date(`${job.scheduled_date}T00:00:00`);
              d.setDate(d.getDate() + days);
              nextStr = `Next visit ~${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}`;
            }
            const href = job.client_id ? `/customers/${job.client_id}` : job.account_id ? `/accounts/${job.account_id}` : null;
            if (!nextStr && !href) return null;
            return (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 12, color: "#6B6860" }}>
                {nextStr && <span>{nextStr}</span>}
                {href && <a href={href} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 700, color: "#3B6CC9" }}>View schedule</a>}
              </div>
            );
          })()}

          {job.account_id && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", background: "var(--brand-dim, #EBF4FF)", borderRadius: 8, marginBottom: 12, width: "fit-content" }}>
              <Building2 size={13} color="var(--brand, #00C9A0)" />
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--brand, #00C9A0)" }}>{job.account_name || "Commercial Account"}</span>
            </div>
          )}

          {/* [panel-revamp step 2] At-a-glance summary tiles — Billed /
              Commission / Hours. Three small tiles fit the mobile sheet. */}
          {(() => {
            const billed = Number(job.amount ?? job.billed_amount ?? 0);
            const techs = job.technicians ?? [];
            const hasComm = techs.length > 0;
            const commTotal = techs.reduce((s, t) => s + (t.final_pay ?? 0), 0);
            const allowed = (job as any).allowed_hours != null ? Number((job as any).allowed_hours) : (job.estimated_hours ?? null);
            // [allowed-split 2026-06-18] Allowed hours is a budget for the whole
            // job; with N techs the wall-clock each tech needs is allowed ÷ N
            // (two techs on a 6h job = 3h each). Surface the per-tech split so
            // the office sees the labor drop when they add a tech.
            const techCount = Math.max(1, techs.length || (job.assigned_user_id != null ? 1 : 1));
            const perTechAllowed = allowed != null ? allowed / techCount : null;
            const Tile = ({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) => (
              <div style={{ flex: 1, minWidth: 0, background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 10, padding: "10px 11px" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: color ?? "#1A1917", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
                {sub && <div style={{ fontSize: 10, color: "#9E9B94", marginTop: 1 }}>{sub}</div>}
              </div>
            );
            return (
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <Tile label="Billed" value={fmtUSD(billed)} />
                <Tile label="Commission" value={hasComm ? fmtUSD(commTotal) : "—"} color="#2D9B83" />
                {/* [rebook-preserve 2026-06-20] Lead with the time ON THE CLOCK
                    (allowed ÷ techs) like MaidCentral, not the summed person-
                    hours — otherwise a 2-tech job reads "5.0h" and looks like
                    the crew wasn't counted. Total labor moves to the sub-line. */}
                <Tile label="Hours"
                  value={allowed != null ? `${(techCount > 1 && perTechAllowed != null ? perTechAllowed : allowed).toFixed(1)}h` : "—"}
                  sub={techCount > 1 && perTechAllowed != null ? `on clock · ${allowed.toFixed(1)}h total · ${techCount} techs` : "allowed"} />
              </div>
            );
          })()}

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
            {/* [time-edit 2026-04-29] Inline time editor with pencil
                affordance. Uses the existing PATCH endpoint + cascade
                prompt for recurring jobs. */}
            <InlineTimeEdit job={job} onUpdate={onUpdate} />
            {/* [inline-edit] Address with pencil affordance, geocode preflight, auto-pick mode. */}
            <InlineAddressEdit job={job} onUpdate={onUpdate} />
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
            {/* [inline-edit] Tech dropdown swaps the primary tech in place.
                [job-panel 2026-06-10] Sal report: Team section at the bottom
                was redundant with this dropdown ("discrete redundancy").
                Consolidated here — primary tech swap above, helper chips
                immediately below, "+ helper" button inline. The standalone
                Team section is gone; helpers + add are visible without
                scrolling. */}
            <InlineTechEdit job={job} onUpdate={onUpdate} />
            {(() => {
              const helpers = commTechs.filter(t => !t.is_primary);
              if (helpers.length === 0 && !canManageCommission) return null;
              return (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 6 }}>
                  {helpers.map(t => (
                    <span key={t.user_id} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 4px 3px 9px", fontSize: 11, fontWeight: 600, color: "#1A1917", background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 999 }}>
                      {t.name}
                      {canManageCommission && !isLocked && (
                        <button
                          onClick={() => removeTechFromJob(t.user_id)}
                          disabled={removeTechBusy === t.user_id}
                          title="Remove helper"
                          aria-label={`Remove ${t.name}`}
                          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, color: "#B91C1C", border: "none", background: "transparent", borderRadius: 999, cursor: removeTechBusy === t.user_id ? "wait" : "pointer", opacity: removeTechBusy === t.user_id ? 0.6 : 1 }}
                        >
                          <X size={11} />
                        </button>
                      )}
                    </span>
                  ))}
                  {canManageCommission && (
                    <button onClick={() => job.status !== "cancelled" && setAddTechOpen(true)}
                      disabled={job.status === "cancelled"}
                      style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", fontSize: 11, fontWeight: 700, color: job.status === "cancelled" ? "#9E9B94" : "#2D9B83", border: `1px dashed ${job.status === "cancelled" ? "#D1D5DB" : "#2D9B83"}`, borderRadius: 999, background: "transparent", cursor: job.status === "cancelled" ? "not-allowed" : "pointer", fontFamily: FF, opacity: job.status === "cancelled" ? 0.6 : 1 }}>
                      <Plus size={11} /> Add tech
                    </button>
                  )}
                </div>
              );
            })()}
            <InlinePriceEdit
              jobId={job.id}
              price={job.amount ?? job.billed_amount ?? 0}
              billingMethod={job.billing_method}
              hourlyRate={job.hourly_rate}
              estimatedHours={job.estimated_hours}
              allowedHours={(job as any).allowed_hours ?? null}
              rateDriven={
                (job.account_id != null || job.client_type === "commercial")
                && !job.manual_rate_override
                && job.hourly_rate != null && job.hourly_rate > 0
                && (job as any).allowed_hours != null && (job as any).allowed_hours > 0
              }
              canEdit={canEditOfficeNotes}
              onUpdated={onUpdate}
            />
          </div>

          {/* [panel-revamp step 3] Itemized service & pricing — base + add-ons
              + discount (negative add-on) + total. Only shown when there are
              add-ons/discounts; otherwise the price editor above already
              carries the single price. */}
          {(() => {
            const addOns = job.add_ons ?? [];
            if (addOns.length === 0) return null;
            const total = Number(job.amount ?? job.billed_amount ?? 0);
            const addOnSum = addOns.reduce((s, a) => s + Number(a.subtotal ?? 0), 0);
            const base = total - addOnSum;
            const positives = addOns.filter(a => Number(a.subtotal ?? 0) >= 0);
            const discounts = addOns.filter(a => Number(a.subtotal ?? 0) < 0);
            const line = (label: string, value: string, color?: string) => (
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, padding: "3px 0" }}>
                <span style={{ color: "#6B6860", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
                <span style={{ fontWeight: 600, color: color ?? "#1A1917", flexShrink: 0 }}>{value}</span>
              </div>
            );
            return (
              <PS label="Service & pricing">
                {line(fmtSvc(job.service_type), `$${base.toFixed(2)}`)}
                {positives.map((a, i) => <div key={`p${i}`}>{line(`Add-on · ${a.name}`, `$${Number(a.subtotal).toFixed(2)}`)}</div>)}
                {discounts.map((a, i) => <div key={`d${i}`}>{line(a.name, `−$${Math.abs(Number(a.subtotal)).toFixed(2)}`, "#2D9B83")}</div>)}
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 15, borderTop: "1px solid #E5E2DC", marginTop: 6, paddingTop: 8 }}>
                  <span style={{ fontWeight: 700, color: "#1A1917" }}>Total</span>
                  <span style={{ fontWeight: 800, color: "#1A1917" }}>${total.toFixed(2)}</span>
                </div>
              </PS>
            );
          })()}

          {/* [lockout-visibility 2026-06-17] This completed job is actually a
              charged cancellation/lockout — make that unmistakable in the
              drawer (it was the surface Sal opened and saw "no indication"). */}
          {(job.cancel_action === "cancel" || job.cancel_action === "lockout") && (
            <div style={{ background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 14 }}>
              <AlertTriangle size={14} style={{ color: "#B45309", flexShrink: 0, marginTop: 1 }} />
              <div>
                <p style={{ fontSize: 10, fontWeight: 700, color: "#92400E", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 3px" }}>
                  {job.cancel_action === "lockout" ? "Lockout — fee charged" : "Cancellation — fee charged"}
                </p>
                <p style={{ margin: 0, fontSize: 12, color: "#92400E", lineHeight: 1.5 }}>
                  Billed as a {job.cancel_action === "lockout" ? "lockout" : "cancellation"} fee{job.billed_amount != null ? ` of $${Number(job.billed_amount).toFixed(2)}` : ""}, not a service visit. The assigned tech is paid the cancellation fee only (no commission on this job).
                </p>
                <button
                  onClick={() => {
                    if (window.confirm("Undo this cancellation? This removes the fee and the tech's cancellation pay, and restores the job.")) undoCancellation();
                  }}
                  disabled={busy}
                  style={{ marginTop: 9, height: 28, padding: "0 12px", border: "1px solid #B45309", background: "#fff", color: "#92400E", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: busy ? "default" : "pointer" }}
                >
                  Undo cancellation
                </button>
              </div>
            </div>
          )}

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

          {/* Cleaner Notes — the note the technician sees in the field app.
              Inline-editable for office/owner/admin (#15); read-only otherwise. */}
          {canEditOfficeNotes ? (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: "#9E9B94" }}>Cleaner Notes (tech sees this)</span>
                </div>
                {cleanerNotesSaving && <span style={{ fontSize: 10, color: "#9E9B94" }}>Saving...</span>}
                {!cleanerNotesSaving && cleanerNotesSaved && <span style={{ fontSize: 10, color: "#16A34A", fontWeight: 600 }}>✓ Saved</span>}
              </div>
              <textarea
                value={cleanerNotes}
                onChange={e => { setCleanerNotes(e.target.value); setCleanerNotesSaved(false); }}
                placeholder="Instructions the cleaner sees on this job…"
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
              {cleanerNotes && <TranslateNote text={cleanerNotes} />}
            </div>
          ) : (
            job.notes && (
              <PS label="Cleaner Notes (tech sees this)">
                <p style={{ margin: 0, fontSize: 13, color: "#6B7280", lineHeight: 1.6 }}>{job.notes}</p>
                <TranslateNote text={job.notes} />
              </PS>
            )
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
              {job.office_notes_updated_at ? (
                <p style={{ fontSize: 10, color: "#9E9B94", marginTop: 4, fontFamily: FF }}>
                  Last edited{job.office_notes_updated_by_name ? ` by ${job.office_notes_updated_by_name}` : ""} · {new Date(job.office_notes_updated_at).toLocaleDateString([], { month: "short", day: "numeric" })}
                </p>
              ) : (
                <p style={{ fontSize: 10, color: "#C0BDB8", marginTop: 4, fontFamily: FF }}>Auto-saves 2 s after you stop typing</p>
              )}
              <TranslateNote text={officeNotes} />
            </div>
          )}

          {/* [panel-revamp 2026-06-03 · hours-merge] One section so allowed
              hours sit right next to the time-clock (actual) hours — Sal:
              "you still put allowed hours separate from time clock hours, they
              are not near each other." Order: Allowed → Actual → Variance →
              the clock in/out times + distances. Allowed = the real
              allowed_hours from the payload (not the stale estimated_hours
              stamp, per CLAUDE.md). Actual prefers actual_hours/billed_hours,
              falls back to clock in/out duration. */}
          {(() => {
            const ce = job.clock_entry;
            const allowed = (job as any).allowed_hours != null ? Number((job as any).allowed_hours) : null;
            let actual: number | null = job.actual_hours != null ? Number(job.actual_hours)
              : (job.billed_hours != null ? Number(job.billed_hours) : null);
            if (actual == null && ce?.clock_in_at && ce?.clock_out_at) {
              actual = (new Date(ce.clock_out_at).getTime() - new Date(ce.clock_in_at).getTime()) / 3600000;
            }
            if (allowed == null && actual == null && !ce) return null;
            const variance = (allowed != null && actual != null) ? actual - allowed : null;
            const inDist = ce ? (ce.clock_in_distance_ft ?? ce.distance_from_job_ft) : null;
            // Per-tech split: allowed ÷ #techs (two techs on a 6h job = 3h each).
            const hrTechCount = Math.max(1, (job.technicians?.length ?? 0) || (job.assigned_user_id != null ? 1 : 1));
            return (
              <PS label="Hours & Time Clock">
                {allowed != null && <KV label="Allowed" value={hrTechCount > 1 ? `${allowed.toFixed(1)}h · ${(allowed / hrTechCount).toFixed(1)}h/tech` : `${allowed.toFixed(1)}h`} />}
                {actual != null && <KV label="Actual" value={`${actual.toFixed(1)}h`} />}
                {variance != null && (
                  <KV label="Variance"
                    value={`${variance > 0 ? "+" : ""}${variance.toFixed(1)}h`}
                    color={variance > 0.25 ? "#D97706" : variance < -0.25 ? "#16A34A" : undefined} />
                )}
                {ce?.clock_in_at && <KV label="Clock in" value={fmtClock(ce.clock_in_at)} />}
                {ce?.clock_out_at && <KV label="Clock out" value={fmtClock(ce.clock_out_at)} />}
                {ce && inDist != null && (
                  <KV label="Distance at clock-in" value={`${Math.round(inDist)} ft${ce.clock_in_outside_geofence ? " (outside)" : ""}`} color={ce.clock_in_outside_geofence ? "#D97706" : undefined} />
                )}
                {ce?.clock_out_distance_ft != null && (
                  <KV label="Distance at clock-out" value={`${Math.round(ce.clock_out_distance_ft)} ft${ce.clock_out_outside_geofence ? " (outside)" : ""}`} color={ce.clock_out_outside_geofence ? "#D97706" : undefined} />
                )}
                {ce?.gps_missing && (
                  <KV label="GPS" value="Unavailable — location not captured" color="#DC2626" />
                )}
                {ce && <ClockEditor entry={ce} canEdit={canEditOfficeNotes} onUpdate={onUpdate} />}
              </PS>
            );
          })()}

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
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#1A1917", display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                      {t.is_primary && <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 800, color: "#2D9B83", background: "rgba(45,155,131,0.1)", padding: "2px 6px", borderRadius: 10, letterSpacing: "0.04em" }}>PRIMARY</span>}
                    </span>
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
                      {!isLocked && (
                        <button
                          onClick={() => removeTechFromJob(t.user_id)}
                          disabled={removeTechBusy === t.user_id}
                          title="Remove from job"
                          aria-label={`Remove ${t.name}`}
                          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, color: "#B91C1C", border: "1px solid #F3D2D2", background: "#FEF2F2", borderRadius: 5, cursor: removeTechBusy === t.user_id ? "wait" : "pointer", flexShrink: 0, opacity: removeTechBusy === t.user_id ? 0.6 : 1 }}
                        >
                          <X size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: "#9E9B94" }}>
                    Est. {t.est_hours.toFixed(1)} hrs · Calc: ${t.calc_pay.toFixed(2)}
                    {t.pay_type && t.pay_rate != null && (
                      <span style={{ marginLeft: 6, color: "#C4C0BB" }}>
                        ({t.pay_type === "hourly"
                          ? `$${t.pay_rate.toFixed(2)}/hr`
                          : `${(t.pay_rate * 100).toFixed(0)}%`})
                      </span>
                    )}
                  </div>
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
                    {/* [pay-matrix 2026-04-29] Display est_pay_per_tech
                        as-is. The server now computes it per-tech via
                        the 4-cell matrix; the no-techs-yet branch
                        renders nothing meaningful since a missing
                        primary tech means we don't yet know the rate
                        cell to apply. */}
                    {job.est_pay_per_tech != null ? `$${job.est_pay_per_tech.toFixed(2)} est.` : "—"}
                  </span>
                </div>
              )}
              {/* [pay-matrix 2026-04-29] Per-tech matrix: each tech's
                  pay_type / pay_rate already shows on their own row
                  above (`Calc: $X (… rate)`), so this summary line
                  describes the JOB routing — residential vs commercial
                  based on client_type — and lets each tech's row
                  carry the rate. When techs are mixed-type on the
                  same job, the summary just says "mixed". */}
              <div style={{ marginTop: 4, fontSize: 11, color: "#9E9B94" }}>
                {(() => {
                  const techs = job.technicians ?? [];
                  if (techs.length === 0) return null;
                  const types = new Set(techs.map(t => t.pay_type).filter(Boolean));
                  const isCommercial = job.client_type === "commercial" || job.account_id != null;
                  const label = isCommercial ? "Commercial" : "Residential";
                  if (types.size === 0) return `${label} job`;
                  if (types.size > 1) return `${label} job · mixed pay types per tech`;
                  const t = [...types][0];
                  return `${label} job · ${t === "hourly" ? "hourly pay per tech" : "commission % per tech"}`;
                })()}
              </div>
              {/* [add-tech-on-complete 2026-06-18] Team is editable on completed
                  jobs — the office reconciles who actually worked, for payroll
                  (Sal: "job is complete but I can't add another tech"). Only a
                  cancelled job blocks it. */}
              <button onClick={() => job.status !== "cancelled" && setAddTechOpen(true)}
                disabled={job.status === "cancelled"}
                style={{ marginTop: 8, width: "100%", height: 32, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, fontWeight: 600, color: job.status === "cancelled" ? "#9E9B94" : "#2D9B83", border: `1px dashed ${job.status === "cancelled" ? "#D1D5DB" : "#2D9B83"}`, borderRadius: 8, background: "transparent", cursor: job.status === "cancelled" ? "not-allowed" : "pointer", fontFamily: FF, opacity: job.status === "cancelled" ? 0.6 : 1 }}>
                <Plus size={12} /> Add tech
              </button>
            </PS>
          )}

          {/* [office-clock 2026-06-05] Time Clock — office clocks each assigned
              tech in/out on this job. Real punches feed payroll hours and the
              actual-minutes commission split. Owner/admin/office only. */}
          {canClock && (() => {
            const techList: { user_id: number; name: string }[] = commTechs.length > 0
              ? commTechs.map(t => ({ user_id: t.user_id, name: t.name }))
              : (job.assigned_user_id ? [{ user_id: job.assigned_user_id, name: assignedEmp?.name || job.assigned_user_name || "Tech" }] : []);
            if (techList.length === 0) return null;
            return (
              <PS label="Time Clock">
                {techList.map(t => {
                  const entry = clockMap[t.user_id];
                  const clockedIn = !!entry && !entry.clock_out_at;
                  const done = !!entry && !!entry.clock_out_at;
                  const busy = clockBusy === t.user_id;
                  return (
                    <div key={t.user_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</div>
                        <div style={{ fontSize: 11, color: clockedIn ? "#B5710C" : done ? "#16A34A" : "#9E9B94", fontWeight: clockedIn || done ? 600 : 400 }}>
                          {clockedIn
                            ? `On the clock since ${fmtClock(entry!.clock_in_at)}`
                            : done
                              ? `${fmtClock(entry!.clock_in_at)}–${fmtClock(entry!.clock_out_at!)} · ${clockDuration(entry!.clock_in_at, entry!.clock_out_at!)}`
                              : "Not clocked in"}
                        </div>
                      </div>
                      <button
                        onClick={() => handleOfficeClock(t.user_id, clockedIn ? "out" : "in")}
                        disabled={busy || done}
                        title={done ? "Shift complete" : clockedIn ? "Clock out" : "Clock in"}
                        style={{
                          flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700,
                          padding: "6px 12px", borderRadius: 7, fontFamily: FF, border: "none", color: "#FFFFFF",
                          cursor: busy || done ? "default" : "pointer", opacity: busy ? 0.6 : 1,
                          background: done ? "#C4C0BB" : clockedIn ? "#D85A30" : "#2D9B83",
                        }}>
                        <Clock size={12} />
                        {done ? "Done" : clockedIn ? "Clock Out" : "Clock In"}
                      </button>
                    </div>
                  );
                })}
                <div style={{ fontSize: 10.5, color: "#9E9B94", marginTop: 2 }}>
                  Office clock — feeds payroll hours and the actual-minutes commission split.
                </div>
              </PS>
            );
          })()}

          {/* Add Tech Modal */}
          {addTechOpen && (
            <>
              <div onClick={() => setAddTechOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 300 }} />
              <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 301, width: 340, backgroundColor: "#FFFFFF", borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,0.2)", fontFamily: FF, overflow: "hidden" }}>
                <div style={{ padding: "16px 20px", borderBottom: "1px solid #E5E2DC", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "#1A1917" }}>Add tech</span>
                  <button onClick={() => setAddTechOpen(false)} style={{ border: "none", background: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}><X size={16} /></button>
                </div>
                <div style={{ padding: "12px 20px", maxHeight: 360, overflowY: "auto" }}>
                  {addTechLoading ? (
                    <div style={{ padding: 20, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>Loading technicians...</div>
                  ) : addTechList.length === 0 ? (
                    <div style={{ padding: 20, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>No available technicians</div>
                  ) : (() => {
                    // [smart-suggest 2026-06-12] Scan each candidate's schedule
                    // (from the dispatch `employees` data already in hand) and
                    // surface 1–2 quick picks above the full list: prefer techs
                    // free at THIS job's time, same zone, lighter load; otherwise
                    // the one who frees up soonest. The whole team still lists
                    // below for manual selection.
                    const durOf = (j: DispatchJob) => (j.duration_minutes && j.duration_minutes > 0 ? j.duration_minutes : (j.allowed_hours ? j.allowed_hours * 60 : 120));
                    const jobStart = timeToMins(job.scheduled_time);
                    const jobEnd = jobStart + durOf(job);
                    // Phes office close. Hardcoded like LATE_THRESHOLD_MINUTES —
                    // multi-tenant later → tenant_settings.close_time.
                    const CLOSE_MINS = 18 * 60;
                    const jobZone = job.zone_id ?? null;
                    const fmtAmpm = (mins: number) => { const h = Math.floor(mins / 60), m = ((mins % 60) + 60) % 60; const ap = h < 12 ? "AM" : "PM"; const h12 = ((h + 11) % 12) + 1; return `${h12}:${String(m).padStart(2, "0")} ${ap}`; };
                    const empById = new Map(employees.map(e => [e.id, e] as const));
                    const timeOffOf = (id: number) => empById.get(id)?.time_off ?? null;
                    // [distance-order 2026-06-12] Real distance from where a tech is
                    // working to this job, not just same-zone. miles via haversine.
                    const jLat = job.job_lat ?? null, jLng = job.job_lng ?? null;
                    const milesBetween = (la1: number, lo1: number, la2: number, lo2: number) => {
                      const R = 3958.8, toR = Math.PI / 180;
                      const dLa = (la2 - la1) * toR, dLo = (lo2 - lo1) * toR;
                      const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * toR) * Math.cos(la2 * toR) * Math.sin(dLo / 2) ** 2;
                      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                    };
                    const scored = addTechList.map(t => {
                      const emp = empById.get(t.id);
                      const empJobs = (emp?.jobs ?? []).filter(j => j.id !== job.id && j.scheduled_time);
                      const overlapping = empJobs.filter(j => { const s = timeToMins(j.scheduled_time!); return s < jobEnd && (s + durOf(j)) > jobStart; });
                      const available = overlapping.length === 0;
                      const sameZone = jobZone != null && !!emp?.zone && emp.zone.zone_id === jobZone;
                      const freeAt = available ? jobStart : Math.max(...overlapping.map(j => timeToMins(j.scheduled_time!) + durOf(j)));
                      // Closest the tech's day's work gets to this job (their anchor).
                      let dist: number | null = null;
                      if (jLat != null && jLng != null) {
                        for (const j of (emp?.jobs ?? [])) {
                          if (j.id === job.id || j.job_lat == null || j.job_lng == null) continue;
                          const d = milesBetween(jLat, jLng, j.job_lat, j.job_lng);
                          if (dist == null || d < dist) dist = d;
                        }
                      }
                      // Sort key for distance: real miles when known; else a zone-based
                      // proxy so same-zone (no coords) still beats far/unknown.
                      const distScore = dist != null ? dist : (sameZone ? 8 : 25);
                      // [safeguards 2026-06-12] Sal's call: WARN, never block — both
                      // flags keep the tech rankable in Suggested; office decides.
                      // 1) End-of-shift: with this job added, the tech's day would run
                      //    past close (later of this job's end and their current last
                      //    job's end).
                      const lastEnd = empJobs.reduce((mx, j) => Math.max(mx, timeToMins(j.scheduled_time!) + durOf(j)), 0);
                      const pastClose = available && Math.max(jobEnd, lastEnd) > CLOSE_MINS;
                      // 2) Tight turnaround: free on paper, but the schedule-adjacent
                      //    job (latest ending before this one / earliest starting after)
                      //    is too far away for the gap. Drive estimate from straight-line
                      //    miles: ×1.3 road factor at ~30 mph (2.6 min/mi) + 10 min
                      //    wrap-up/parking. Only the adjacent legs matter — that's where
                      //    the tech actually drives from/to.
                      let tight: { gap: number; drive: number } | null = null;
                      if (available && jLat != null && jLng != null) {
                        let prev: DispatchJob | null = null, next: DispatchJob | null = null;
                        for (const j of empJobs) {
                          const s = timeToMins(j.scheduled_time!), e = s + durOf(j);
                          if (e <= jobStart && (!prev || e > timeToMins(prev.scheduled_time!) + durOf(prev))) prev = j;
                          if (s >= jobEnd && (!next || s < timeToMins(next.scheduled_time!))) next = j;
                        }
                        const legs: Array<{ adj: DispatchJob; gap: number }> = [];
                        if (prev) legs.push({ adj: prev, gap: jobStart - (timeToMins(prev.scheduled_time!) + durOf(prev)) });
                        if (next) legs.push({ adj: next, gap: timeToMins(next.scheduled_time!) - jobEnd });
                        for (const { adj, gap } of legs) {
                          if (adj.job_lat == null || adj.job_lng == null) continue;
                          const drive = Math.ceil(milesBetween(jLat, jLng, adj.job_lat, adj.job_lng) * 2.6) + 10;
                          if (gap < drive && (tight == null || drive - gap > tight.drive - tight.gap)) tight = { gap, drive };
                        }
                      }
                      return { t, available, sameZone, jobCount: empJobs.length, freeAt, zoneName: emp?.zone?.zone_name ?? null, timeOff: emp?.time_off ?? null, dist, distScore, pastClose, tight };
                    });
                    // SAFEGUARD: never SUGGEST a tech on PTO / sick / absent today.
                    // Best → ok: free at the job's time → CLOSEST to the job →
                    // lighter load; if none free, whoever frees up soonest.
                    const suggested = scored.filter(s => !s.timeOff).sort((a, b) => {
                      if (a.available !== b.available) return a.available ? -1 : 1;
                      if (a.available) {
                        // Soft demotion only: a clean pick outranks one carrying a
                        // warning, but a warned tech still surfaces when they're
                        // the best on offer (Sal: warn, never block).
                        const aw = (a.tight ? 1 : 0) + (a.pastClose ? 1 : 0);
                        const bw = (b.tight ? 1 : 0) + (b.pastClose ? 1 : 0);
                        if (aw !== bw) return aw - bw;
                        if (Math.abs(a.distScore - b.distScore) > 0.3) return a.distScore - b.distScore;
                        return a.jobCount - b.jobCount;
                      }
                      return a.freeAt - b.freeAt;
                    }).slice(0, 2);
                    const warnsFor = (s: typeof scored[number]) => {
                      const w: string[] = [];
                      if (s.tight) w.push(`tight turnaround (${s.tight.gap} min gap, ~${s.tight.drive} min drive)`);
                      if (s.pastClose) w.push("runs past 6 PM");
                      return w;
                    };
                    const reasonFor = (s: typeof scored[number]) => {
                      if (!s.available) return `Frees up ${fmtAmpm(s.freeAt)}`;
                      const base = s.dist != null ? `${s.dist < 0.1 ? "<0.1" : s.dist.toFixed(1)} mi away${s.sameZone ? " · same zone" : ""}`
                        : s.sameZone ? `Same zone${s.zoneName ? ` · ${s.zoneName}` : ""} · open`
                        : s.jobCount > 0 ? `Open · ${s.jobCount} job${s.jobCount > 1 ? "s" : ""} today` : "Open · no jobs today";
                      const warns = warnsFor(s);
                      return warns.length ? `${base} · ${warns.join(" · ")}` : base;
                    };

                    // Time off (PTO/sick/absent) is split out so it can never sit
                    // under "Available"; still listed (amber) for a deliberate
                    // override if the office really needs to assign them.
                    const scoredById = new Map(scored.map(s => [s.t.id, s] as const));
                    const isAvail = (id: number) => scoredById.get(id)?.available ?? true; // not on the board → treat as free
                    const freeAtOf = (id: number) => scoredById.get(id)?.freeAt ?? null;
                    // Group by SCHEDULE CONFLICT at this job's time window — NOT by
                    // clock-in status. A tech with a job overlapping the slot is "on
                    // a job" even if they never clocked in (office-managed techs who
                    // don't use the field app), so they don't show as Available.
                    // [distance-order 2026-06-12] Available techs sort by real
                    // distance to the job (closest first), name as the tiebreak.
                    const distScoreOf = (id: number) => scoredById.get(id)?.distScore ?? 99;
                    const byDistThenName = (a: TechRow, b: TechRow) => {
                      const da = distScoreOf(a.id), db_ = distScoreOf(b.id);
                      return Math.abs(da - db_) > 0.3 ? da - db_ : a.name.localeCompare(b.name);
                    };
                    const offList = addTechList.filter(t => !!timeOffOf(t.id)).sort((a, b) => a.name.localeCompare(b.name));
                    const free = addTechList.filter(t => !timeOffOf(t.id) && isAvail(t.id)).sort(byDistThenName);
                    const working = addTechList.filter(t => !timeOffOf(t.id) && !isAvail(t.id)).sort((a, b) => a.name.localeCompare(b.name));
                    const availLabel = (id: number) => {
                      const s = scoredById.get(id);
                      const d = s?.dist ?? null;
                      const parts = d != null ? [`${d < 0.1 ? "<0.1" : d.toFixed(1)} mi away`] : [];
                      if (s) parts.push(...warnsFor(s));
                      return parts.length ? parts.join(" · ") : undefined;
                    };
                    const hasWarn = (id: number) => { const s = scoredById.get(id); return !!s && warnsFor(s).length > 0; };
                    const busyLabel = (id: number) => { const f = freeAtOf(id); return f != null ? `On a job · frees up ${fmtAmpm(f)}` : "On a job"; };
                    const offLabel = (id: number) => { const o = timeOffOf(id); return o === "pto" ? "On PTO today" : o === "sick" ? "Out sick today" : o === "absent" ? "Absent today" : ""; };
                    const groupHeader = (text: string) => (
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em", padding: "8px 2px 6px", marginTop: 4 }}>
                        {text}
                      </div>
                    );
                    const row = (t: TechRow, subtitle?: string, keyId?: string, tone: "good" | "warn" = "good") => (
                      <button key={keyId ?? String(t.id)} onClick={() => addTechToJob(t.id)} disabled={addTechBusy}
                        style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 8px", border: "none", background: "transparent", cursor: addTechBusy ? "wait" : "pointer", borderRadius: 8, fontFamily: FF, textAlign: "left" }}
                        onMouseEnter={e => e.currentTarget.style.background = "#F7F6F3"}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <EmployeeAvatar name={t.name} avatarUrl={t.avatar_url} size={32} fontSize={11}
                          badge={t.is_clocked_in ? (
                            <span style={{ position: "absolute", bottom: -1, right: -1, width: 10, height: 10, borderRadius: "50%", backgroundColor: "#22C55E", border: "2px solid #FFFFFF" }} title="Clocked in" />
                          ) : undefined} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</div>
                          {subtitle ? (
                            <div style={{ fontSize: 11, color: tone === "warn" ? "#B45309" : "#00936F", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{subtitle}</div>
                          ) : (<>
                            <div style={{ fontSize: 11, color: "#9E9B94", textTransform: "capitalize" }}>{(t.role || "").replace("_", " ")}</div>
                            {t.currently_at && (
                              <div style={{ fontSize: 11, color: "#6B6860", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                Currently at: {t.currently_at}
                              </div>
                            )}
                          </>)}
                        </div>
                      </button>
                    );
                    // [retro-add 2026-06-12] PAST job: adding a tech is
                    // record-keeping ("who actually worked it"), not dispatch.
                    // Suggested picks, frees-up times, time-off, and the
                    // end-of-shift / turnaround warnings are meaningless after
                    // the fact (Sal hit "frees up 4:00 PM" on a June 9 job
                    // three days later) — show the flat roster instead. The
                    // commission split picks the late addition up from
                    // job_technicians, which is exactly the missing-split-
                    // partner fix path.
                    const nowChi = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
                    const todayYmd = `${nowChi.getFullYear()}-${String(nowChi.getMonth() + 1).padStart(2, "0")}-${String(nowChi.getDate()).padStart(2, "0")}`;
                    const isPastJob = !!job.scheduled_date && job.scheduled_date < todayYmd;
                    if (isPastJob) {
                      return (
                        <>
                          <div style={{ fontSize: 11, color: "#B45309", background: "#FEF3E2", border: "1px solid #F3D9B0", borderRadius: 7, padding: "8px 10px", marginBottom: 4, fontFamily: FF }}>
                            Past job — availability checks skipped. Add whoever actually worked it; the pay split updates from the team list.
                          </div>
                          {[...addTechList].sort((a, b) => a.name.localeCompare(b.name)).map(t => row(t))}
                        </>
                      );
                    }
                    return (
                      <>
                        {suggested.length > 0 && groupHeader("Suggested")}
                        {suggested.map(s => row(s.t, reasonFor(s), `sug-${s.t.id}`, warnsFor(s).length ? "warn" : "good"))}
                        {free.length > 0 && groupHeader("Available")}
                        {free.map(t => row(t, availLabel(t.id), undefined, hasWarn(t.id) ? "warn" : "good"))}
                        {working.length > 0 && groupHeader("On a job")}
                        {working.map(t => row(t, busyLabel(t.id), `busy-${t.id}`, "warn"))}
                        {offList.length > 0 && groupHeader("Time off")}
                        {offList.map(t => row(t, offLabel(t.id), `off-${t.id}`, "warn"))}
                      </>
                    );
                  })()}
                </div>
              </div>
            </>
          )}

          {/* [job-panel 2026-06-10] Standalone "Team" section removed.
              Sal report: it duplicated the primary tech already shown in
              the Service & pricing block at the top of the panel. The
              "+ helper" button + helper chips now live alongside the
              primary tech dropdown in that block. The commTechs state +
              addTechOpen modal are still wired through (see InlineTechEdit
              area above and the existing Add Team Member modal below). */}

          {/* Time & Fee Adjustments — per-job mods stacked on top of base_fee */}
          {canManageMods && (
            <PS label="Time & Fee Adjustments">
              {rateMods.length === 0 ? (
                <div style={{ fontSize: 12, color: "#9E9B94", marginBottom: 8 }}>
                  {rateModsLoaded ? "No adjustments" : "Loading…"}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
                  {rateMods.map(m => {
                    const amt = parseFloat(m.amount);
                    const sign = amt >= 0 ? "+" : "−";
                    const abs = Math.abs(amt).toFixed(2);
                    const detail = m.mod_type === "time"
                      ? `${(m.minutes ?? 0) >= 0 ? "+" : ""}${m.minutes} min`
                      : "Flat fee";
                    return (
                      <div key={m.id} style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 6, background: "#FFFFFF" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917" }}>
                            {detail} · {sign}${abs}
                          </div>
                          <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2, wordBreak: "break-word" }}>
                            {m.reason}
                          </div>
                        </div>
                        {!isLocked && (
                          <button onClick={() => deleteRateMod(m.id)}
                            style={{ marginLeft: 8, padding: 4, border: "none", background: "transparent", cursor: "pointer", color: "#9E9B94" }}
                            title="Remove adjustment">
                            <X size={14} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {!modAddOpen ? (
                <button onClick={() => !isLocked && setModAddOpen(true)}
                  disabled={isLocked}
                  style={{ width: "100%", height: 32, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, fontWeight: 600, color: isLocked ? "#9E9B94" : "#2D9B83", border: `1px dashed ${isLocked ? "#D1D5DB" : "#2D9B83"}`, borderRadius: 8, background: "transparent", cursor: isLocked ? "not-allowed" : "pointer", fontFamily: FF, opacity: isLocked ? 0.6 : 1 }}>
                  <Plus size={12} /> Add Adjustment
                </button>
              ) : (
                <div style={{ padding: 10, border: "1px solid #E5E2DC", borderRadius: 8, background: "#FAFAF7" }}>
                  <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                    <button onClick={() => setModType("time")}
                      style={{ flex: 1, padding: "6px 8px", border: `1px solid ${modType === "time" ? "#2D9B83" : "#E5E2DC"}`, borderRadius: 6, background: modType === "time" ? "#2D9B83" : "#FFFFFF", color: modType === "time" ? "#FFFFFF" : "#1A1917", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                      Time
                    </button>
                    <button onClick={() => setModType("flat")}
                      style={{ flex: 1, padding: "6px 8px", border: `1px solid ${modType === "flat" ? "#2D9B83" : "#E5E2DC"}`, borderRadius: 6, background: modType === "flat" ? "#2D9B83" : "#FFFFFF", color: modType === "flat" ? "#FFFFFF" : "#1A1917", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                      Flat Fee
                    </button>
                  </div>
                  {modType === "time" && (
                    <input type="number" placeholder="Minutes (e.g. 30 or -15)"
                      value={modMinutes} onChange={e => setModMinutes(e.target.value)}
                      style={{ width: "100%", padding: "6px 8px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: FF, marginBottom: 6, boxSizing: "border-box" }} />
                  )}
                  <input type="number" step="0.01" placeholder="Amount (e.g. 30 or -50)"
                    value={modAmount} onChange={e => setModAmount(e.target.value)}
                    style={{ width: "100%", padding: "6px 8px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: FF, marginBottom: 6, boxSizing: "border-box" }} />
                  <input type="text" placeholder="Reason"
                    value={modReason} onChange={e => setModReason(e.target.value)}
                    style={{ width: "100%", padding: "6px 8px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: FF, marginBottom: 8, boxSizing: "border-box" }} />
                  {modError && <div style={{ color: "#DC2626", fontSize: 11, marginBottom: 6 }}>{modError}</div>}
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={addRateMod} disabled={modBusy}
                      style={{ flex: 1, padding: "6px 8px", border: "none", borderRadius: 6, background: "#16A34A", color: "#FFFFFF", fontSize: 12, fontWeight: 600, cursor: modBusy ? "wait" : "pointer", fontFamily: FF }}>
                      {modBusy ? "Saving…" : "Save"}
                    </button>
                    <button onClick={() => { setModAddOpen(false); setModError(""); }} disabled={modBusy}
                      style={{ padding: "6px 10px", border: "1px solid #E5E2DC", borderRadius: 6, background: "#FFFFFF", color: "#6B7280", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </PS>
          )}

          {/* [AF] Supplies Used section removed per drawer cleanup. */}
        </div>

        {/* [AF] Action footer. When isLocked (status=complete/cancelled or
            locked_at set), Mark Complete is replaced with a muted "Completed
            at ..." label and Reschedule / Cancel are disabled. */}
        <div style={{ padding: "12px 20px 20px", borderTop: "1px solid #EEECE7", display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
          {isLocked ? (
            <div style={{ flex: 1, minWidth: 100, padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 8, backgroundColor: "#F8F7F4", color: "#6B6860", fontSize: 12, fontWeight: 600, fontFamily: FF, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <CheckCircle size={13} color="#16A34A" />
              {job.status === "cancelled"
                ? "Cancelled"
                : completedAtLabel ? `Completed at ${completedAtLabel}` : "Completed"}
            </div>
          ) : confirmComplete ? (
            <>
              <button onClick={() => setStatus("complete")} disabled={busy}
                style={{ flex: 1, minWidth: 120, padding: "10px 12px", border: "none", borderRadius: 8, backgroundColor: "#16A34A", color: "#fff", fontSize: 13, fontWeight: 700, cursor: busy ? "wait" : "pointer", fontFamily: FF }}>
                {busy ? "..." : "Yes, complete"}
              </button>
              <button onClick={() => setConfirmComplete(false)} disabled={busy}
                style={{ padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 8, backgroundColor: "#FFFFFF", color: "#6B7280", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                Cancel
              </button>
            </>
          ) : (
            <button onClick={() => setConfirmComplete(true)} disabled={busy}
              style={{ flex: 1, minWidth: 100, padding: "10px 12px", border: "none", borderRadius: 8, backgroundColor: "#22C55E", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
              Mark Complete
            </button>
          )}
          {!isLocked && job.status !== "in_progress" && !confirmComplete && (
            <button onClick={() => setStatus("in_progress")} disabled={busy}
              style={{ flex: 1, minWidth: 100, padding: "10px 12px", border: "1px solid #FCD34D", borderRadius: 8, backgroundColor: "#FEF3C7", color: "#92400E", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
              Start Job
            </button>
          )}
          {/* Charge Client — owner/admin only, completed Stripe jobs not yet charged */}
          {canCharge && job.status === "complete" && !job.charge_succeeded_at && (
            <button onClick={openChargeModal}
              style={{ padding: "10px 12px", border: "1px solid #6EE7B7", borderRadius: 8, backgroundColor: "#ECFDF5", color: "#065F46", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF, display: "flex", alignItems: "center", gap: 5 }}>
              <DollarSign size={13} /> Charge Client
            </button>
          )}
          {/* [edit-decouple 2026-04-29] Edit button is ALWAYS enabled,
              even on completed/cancelled/locked jobs. Per-field lock
              logic inside EditJobModal + the PATCH route protects the
              fields that actually need it (paid billed_amount stays
              hard-locked; actual_start/end + invoiced billed_amount
              warn-then-unlock; service_type/frequency stay locked on
              completed jobs). The blanket "you can't edit a completed
              job" gate was wrong — operators legitimately need to fix
              tech assignments and clock-in timestamps after the fact
              for payroll. Audit log captures every unlocked edit. */}
          <button
            onClick={() => setEditOpen(true)}
            style={{ padding: "10px 12px", border: "1px solid #A7F3D0", borderRadius: 8, backgroundColor: "#ECFDF5", color: "#065F46", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
            Edit
          </button>
          <button
            onClick={() => {
              const base = job.scheduled_date ? new Date(`${job.scheduled_date}T12:00:00`) : new Date();
              base.setDate(base.getDate() + 7);
              setDuplicateDate(base.toISOString().slice(0, 10));
              setDuplicateTime(job.scheduled_time || "");
              setDuplicateOpen(true);
            }}
            style={{ padding: "10px 12px", border: "1px solid #DDD6FE", borderRadius: 8, backgroundColor: "#F5F3FF", color: "#6D28D9", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
            Duplicate
          </button>
          <button
            disabled={isLocked}
            onClick={() => {
              if (isLocked) return;
              setRescheduleOpen(true); setRescheduleSuccess(""); setRescheduleReason(""); setRescheduleReasonOther("");
              setRescheduleDate(job.scheduled_date || ""); setRescheduleHour(null);
              setAvailSlots([]); setTechList([]); setSelectedTechId(job.assigned_user_id); setRescheduleCount(null);
            }}
            style={{ padding: "10px 12px", border: `1px solid ${isLocked ? "#E5E2DC" : "#BFDBFE"}`, borderRadius: 8, backgroundColor: isLocked ? "#F8F7F4" : "#EFF6FF", color: isLocked ? "#9E9B94" : "#1D4ED8", fontSize: 13, fontWeight: 600, cursor: isLocked ? "not-allowed" : "pointer", fontFamily: FF, opacity: isLocked ? 0.6 : 1 }}>
            Reschedule
          </button>
          {!isLocked && (
            <button onClick={() => setCancelOpen(true)} disabled={busy}
              style={{ padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 8, backgroundColor: "#F8F7F4", color: "#6B7280", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
              Cancel Job
            </button>
          )}
          {/* [reclassify-lockout 2026-06-17] A job that was marked Complete
              normally can still turn out to have been a lockout / cancellation
              (tech showed up, couldn't get in — office only learns later).
              isLocked hides the full action picker, so completed jobs get a
              dedicated "Mark as Lockout / Cancellation" entry that opens the
              same modal in reclassify mode (charging actions only). The
              backend reclassify path supersedes the prior completion: writes
              the cancellation_log + cancellation_pay and the commission
              engines (#549) then exclude the job from normal commission, so
              the tech is paid the cancellation fee ONLY, never both. Hidden
              once the job is already cancelled (free/voided — nothing to
              reclassify) and for techs (office/owner/admin only). */}
          {isLocked && job.status === "complete" && canManageCommission && (
            <button onClick={() => setCancelOpen(true)} disabled={busy}
              style={{ padding: "10px 12px", border: "1px solid #CBD5E1", borderRadius: 8, backgroundColor: "#F1F5F9", color: "#475569", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
              Mark as Lockout / Cancellation
            </button>
          )}
        </div>
      </div>

      {/* Duplicate Job Modal */}
      {duplicateOpen && (
        <>
          <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.5)", zIndex: 299 }} onClick={() => !duplicateBusy && setDuplicateOpen(false)} />
          <div style={mobile
            ? { position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 300, backgroundColor: "#FFFFFF", borderRadius: "16px 16px 0 0", padding: "20px 20px 28px", fontFamily: FF }
            : { position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 300, backgroundColor: "#FFFFFF", borderRadius: 16, width: "100%", maxWidth: 420, padding: 24, boxShadow: "0 24px 64px rgba(0,0,0,0.25)", fontFamily: FF }
          }>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: "#1A1917" }}>Duplicate Job</span>
              <button onClick={() => !duplicateBusy && setDuplicateOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", padding: 6, display: "flex" }} type="button"><X size={18} /></button>
            </div>
            <p style={{ margin: "0 0 16px", fontSize: 12, color: "#6B7280" }}>
              Creates a new job with the same service, price, tech, and add-ons — just pick the new date.
            </p>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>New date</label>
            <input type="date" value={duplicateDate} onChange={e => setDuplicateDate(e.target.value)}
              style={{ width: "100%", height: 42, padding: "0 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 14, color: "#1A1917", fontFamily: FF, marginBottom: 14, boxSizing: "border-box" }} />
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>Time (optional)</label>
            <input type="time" value={duplicateTime ? duplicateTime.slice(0, 5) : ""} onChange={e => setDuplicateTime(e.target.value ? `${e.target.value}:00` : "")}
              style={{ width: "100%", height: 42, padding: "0 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 14, color: "#1A1917", fontFamily: FF, marginBottom: 18, boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setDuplicateOpen(false)} disabled={duplicateBusy}
                style={{ padding: "10px 16px", border: "1px solid #E5E2DC", borderRadius: 8, backgroundColor: "#FFFFFF", color: "#6B7280", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button type="button" disabled={!duplicateDate || duplicateBusy}
                onClick={async () => {
                  if (!duplicateDate) return;
                  setDuplicateBusy(true);
                  try {
                    const r = await fetch(`${_API2}/api/jobs/${job.id}/duplicate`, {
                      method: "POST",
                      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                      body: JSON.stringify({ scheduled_date: duplicateDate, scheduled_time: duplicateTime || job.scheduled_time || null }),
                    });
                    if (!r.ok) throw new Error(await r.text());
                    const fmtNew = new Date(duplicateDate + "T12:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
                    toast({ title: "Job duplicated", description: `Copied to ${fmtNew}` });
                    setDuplicateOpen(false);
                    onUpdate();
                    onClose();
                  } catch {
                    toast({ title: "Error", description: "Could not duplicate job", variant: "destructive" });
                  } finally { setDuplicateBusy(false); }
                }}
                style={{ padding: "10px 18px", border: "none", borderRadius: 8, backgroundColor: "var(--brand)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: (!duplicateDate || duplicateBusy) ? "not-allowed" : "pointer", fontFamily: FF, opacity: (!duplicateDate || duplicateBusy) ? 0.6 : 1 }}>
                {duplicateBusy ? "Duplicating…" : "Duplicate"}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Charge Confirmation Modal */}
      {chargeOpen && (
        <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.5)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ backgroundColor: "#FFFFFF", borderRadius: 12, padding: 28, width: "100%", maxWidth: 400, fontFamily: FF }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 17, fontWeight: 800, color: "#1A1917" }}>Confirm Payment</h3>
            <p style={{ margin: "0 0 20px", fontSize: 13, color: "#6B7280" }}>Charge the card on file for this completed job.</p>
            <div style={{ background: "#F7F6F3", borderRadius: 8, padding: "14px 16px", marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: "#6B7280" }}>Client</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#1A1917" }}>{job.display_name ?? job.client_name}</span>
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
                        <span style={{ fontWeight: 700 }}>{job.display_name ?? job.client_name}</span>
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
                            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 12px", marginBottom: 10 }}>
                              {([["#16A34A", "Open"], ["#92400E", "1–2 jobs"], ["#991B1B", "3+ jobs (busy)"]] as [string, string][]).map(([c, l]) => (
                                <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "#6B6860" }}>
                                  <span style={{ width: 9, height: 9, borderRadius: 3, backgroundColor: slotBg(l === "Open" ? 0 : l.startsWith("1") ? 1 : 3), border: `1px solid ${c}33` }} />
                                  {l}
                                </span>
                              ))}
                              <span style={{ fontSize: 11, color: "#9E9B94", width: "100%" }}>Counts are jobs already booked that hour across your team — you can still pick a busy slot.</span>
                            </div>
                          )}
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
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>Team Assignment</span>
                        <span style={{ fontSize: 11, color: "#9E9B94", display: "block", marginBottom: 10 }}>
                          "<span style={{ color: "#991B1B", fontWeight: 600 }}>Conflict</span>" means the tech already has a job overlapping {fmtHour(rescheduleHour)}. You can still assign them.
                        </span>
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
                        {selectedTechId !== null && techList.find(t => t.id === selectedTechId)?.has_conflict && (
                          <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, backgroundColor: "#FEF3C7", border: "1px solid #FCD34D", display: "flex", alignItems: "flex-start", gap: 6 }}>
                            <AlertTriangle size={13} color="#92400E" style={{ flexShrink: 0, marginTop: 1 }} />
                            <span style={{ fontSize: 12, color: "#92400E", lineHeight: 1.4 }}>
                              {techList.find(t => t.id === selectedTechId)?.name?.split(" ")[0]} already has a job at this time. Confirming will double-book them.
                            </span>
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
                  <p style={{ margin: "4px 0 0", fontSize: 14, color: "#1A1917", fontWeight: 600 }}>{job.display_name ?? job.client_name} <span style={{ fontWeight: 400, color: "#6B7280" }}>({job.client_phone})</span></p>
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

      {/* Cancel / cancellation-action modal — MC-style action picker.
          Step 1: 7 action cards. Step 2: review (varies by action — date
          picker for move/bump, charge breakdown for cancel/lockout,
          warning for cancel_service, plain confirm for skip).
          Visual approach: white cards with a 5px left stripe + 1px
          border in the accent color, calm pastel hover fill, consistent
          typography. Replaces the saturated palette Sal flagged on
          2026-06-01. */}
      {cancelOpen && (() => {
        const ACTIONS: Array<{
          key: "modify" | "move" | "bump" | "skip" | "cancel" | "lockout" | "cancel_service";
          label: string; sub: string; accent: string; tint: string; charges: boolean; ends_service?: boolean; ui_only?: boolean; reschedules?: boolean;
        }> = [
          { key: "modify",         label: "Modify",         sub: "Change time, tech, or scope",  accent: "#2563EB", tint: "#EFF6FF", charges: false, ui_only: true },
          { key: "move",           label: "Move",           sub: "Customer picks a new date",    accent: "#7C3AED", tint: "#F5F3FF", charges: false, reschedules: true },
          { key: "bump",           label: "Bump",           sub: "We pick a new date",           accent: "#DB2777", tint: "#FDF2F8", charges: false, reschedules: true },
          { key: "skip",           label: "Skip",           sub: "Customer skips this visit",    accent: "#D97706", tint: "#FFFBEB", charges: false },
          { key: "cancel",         label: "Cancel",         sub: "Customer cancels (full fee)",  accent: "#DC2626", tint: "#FEF2F2", charges: true },
          { key: "lockout",        label: "Lockout",        sub: "Couldn't get in (full fee)",   accent: "#475569", tint: "#F1F5F9", charges: true },
          { key: "cancel_service", label: "Cancel Service", sub: "End all future visits",        accent: "#991B1B", tint: "#FEF2F2", charges: false, ends_service: true },
        ];
        // [reclassify-lockout] When the job is already complete the operator
        // is reclassifying a finished job as a lockout / cancellation — only
        // the two charging actions make sense (move/bump/skip/cancel_service/
        // modify all assume a still-live job). Filter the picker down to them.
        const isReclassify = isLocked && job.status === "complete";
        const visibleActions = isReclassify ? ACTIONS.filter(a => a.charges) : ACTIONS;
        // Prefer the LIVE dispatch amount (base_fee + adjustments + add-ons);
        // billed_amount is a cache that goes stale after price/fee edits. Fall
        // through with `||` so a literal 0 doesn't pin the fee preview to $0.
        const jobAmount = Number((job as any).amount) || Number(job.billed_amount) || Number((job as any).base_fee) || 0;
        const previewCharge = (a: typeof ACTIONS[number]) => a.charges ? jobAmount : 0;
        const selected = ACTIONS.find(a => a.key === cancelAction);
        const resetModal = () => { setCancelOpen(false); setCancelAction(null); setChargeOverride(""); setCancelNote(""); setCancelNewDate(""); setCancelNewTime(""); };
        const overrideCharge = chargeOverride.trim() !== "" ? Number(chargeOverride) : previewCharge(selected ?? ACTIONS[0]);
        const needsDate = selected?.reschedules === true;
        const confirmDisabled = busy || (needsDate && !cancelNewDate);
        return (
          <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(10,14,26,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300, fontFamily: FF, padding: 16 }}>
            <div style={{ backgroundColor: "#FFFFFF", borderRadius: 16, padding: "22px 24px 20px", width: 560, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 24px 70px rgba(10,14,26,0.28)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#0A0E1A", letterSpacing: "-0.01em" }}>
                  {selected ? selected.label : "What do you want to do?"}
                </h3>
                <button onClick={resetModal}
                  aria-label="Close"
                  style={{ background: "transparent", border: 0, fontSize: 22, color: "#9E9B94", cursor: "pointer", lineHeight: 1, padding: "0 0 0 12px" }}>×</button>
              </div>
              <p style={{ margin: "0 0 18px", fontSize: 13, color: "#6B6860" }}>
                {job.display_name ?? job.client_name} · {new Date(job.scheduled_date + "T12:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </p>
              {isReclassify && (
                <div style={{ margin: "0 0 16px", padding: "10px 12px", borderRadius: 8, background: "#F1F5F9", border: "1px solid #CBD5E1", fontSize: 12, color: "#475569", lineHeight: 1.4 }}>
                  This job is already marked complete. Recording a cancellation or lockout
                  will supersede that — the tech is paid the cancellation fee only (their
                  normal commission for this job is removed).
                </div>
              )}

              {/* STEP 1 — action picker. White cards with a slim left
                  stripe in the accent color. Hover swaps the background
                  to the tint so the card "lights up". Cancel Service
                  spans the full row at the bottom because it's the
                  final-and-most-destructive option. */}
              {!selected && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {visibleActions.map((a, idx) => {
                    const isFullRow = a.ends_service;
                    return (
                      <button key={a.key} onClick={() => {
                        if (a.ui_only) {
                          resetModal();
                          setEditOpen(true);
                          return;
                        }
                        setCancelAction(a.key as "move" | "bump" | "skip" | "cancel" | "lockout" | "cancel_service");
                        setChargeOverride("");
                        // Seed the reschedule date to the job's current
                        // date so the date picker isn't empty when shown.
                        if (a.reschedules) {
                          setCancelNewDate(job.scheduled_date || "");
                          setCancelNewTime(job.scheduled_time ? job.scheduled_time.slice(0, 5) : "");
                        }
                      }}
                        style={{
                          gridColumn: isFullRow ? "1 / -1" : "auto",
                          background: "#FFFFFF",
                          border: `1px solid ${a.accent}33`,
                          borderLeft: `5px solid ${a.accent}`,
                          borderRadius: 10,
                          padding: "13px 14px 13px 14px",
                          textAlign: "left",
                          cursor: "pointer",
                          fontFamily: FF,
                          transition: "background 0.12s, border-color 0.12s, transform 0.08s",
                          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = a.tint; e.currentTarget.style.borderColor = `${a.accent}66`; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "#FFFFFF"; e.currentTarget.style.borderColor = `${a.accent}33`; }}
                        onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.99)")}
                        onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
                      >
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: a.accent, marginBottom: 2 }}>{a.label}</div>
                          <div style={{ fontSize: 12, color: "#6B6860", lineHeight: 1.35 }}>{a.sub}</div>
                        </div>
                        {a.charges && (
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", whiteSpace: "nowrap" }}>
                            ${jobAmount.toFixed(0)}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* STEP 2 — action-specific review. The summary chip at the
                  top tells the operator what's about to happen. Each
                  branch (reschedule / cancel / lockout / skip / service-
                  end) gets its own controls below. */}
              {selected && (
                <>
                  <div style={{
                    padding: "12px 14px", borderRadius: 10, marginBottom: 14,
                    background: selected.tint,
                    border: `1px solid ${selected.accent}33`,
                    borderLeft: `4px solid ${selected.accent}`,
                  }}>
                    {/* Reschedule actions */}
                    {selected.reschedules && (
                      <>
                        <div style={{ fontSize: 12, fontWeight: 700, color: selected.accent, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                          Reschedule · No charge
                        </div>
                        <div style={{ fontSize: 13, color: "#1A1917" }}>
                          Pick the new date{cancelNewTime ? " and time" : ""}. The job stays scheduled and just moves.
                        </div>
                      </>
                    )}
                    {/* Charging actions */}
                    {selected.charges && (
                      <>
                        <div style={{ fontSize: 12, fontWeight: 700, color: selected.accent, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                          Customer will be charged
                        </div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: "#0A0E1A", lineHeight: 1.1 }}>
                          ${overrideCharge.toFixed(2)}
                        </div>
                      </>
                    )}
                    {/* Skip */}
                    {!selected.reschedules && !selected.charges && !selected.ends_service && (
                      <>
                        <div style={{ fontSize: 12, fontWeight: 700, color: selected.accent, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                          No charge
                        </div>
                        <div style={{ fontSize: 13, color: "#1A1917" }}>
                          This visit is skipped. The recurring schedule continues normally.
                        </div>
                      </>
                    )}
                    {/* Cancel Service */}
                    {selected.ends_service && (
                      <>
                        <div style={{ fontSize: 12, fontWeight: 700, color: selected.accent, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                          End service · No charge
                        </div>
                        <div style={{ fontSize: 13, color: "#1A1917", fontWeight: 600 }}>
                          All future scheduled visits will be cancelled and the recurring schedule deactivated.
                        </div>
                      </>
                    )}
                  </div>

                  {/* Date + time pickers for move/bump */}
                  {selected.reschedules && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: 10, marginBottom: 14 }}>
                      <div>
                        <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>
                          New date
                        </label>
                        <input
                          type="date"
                          value={cancelNewDate}
                          min={new Date().toISOString().slice(0, 10)}
                          onChange={e => setCancelNewDate(e.target.value)}
                          style={{ width: "100%", height: 38, padding: "0 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, outline: "none", background: "#FFFFFF", fontFamily: FF, boxSizing: "border-box" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>
                          Time (optional)
                        </label>
                        <input
                          type="time"
                          value={cancelNewTime}
                          onChange={e => setCancelNewTime(e.target.value)}
                          style={{ width: "100%", height: 38, padding: "0 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, outline: "none", background: "#FFFFFF", fontFamily: FF, boxSizing: "border-box" }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Charge override for cancel/lockout */}
                  {selected.charges && (
                    <div style={{ marginBottom: 14 }}>
                      <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>
                        Override charge (optional)
                      </label>
                      <input type="number" min="0" step="0.01" value={chargeOverride}
                        placeholder={previewCharge(selected).toFixed(2)}
                        onChange={e => setChargeOverride(e.target.value)}
                        style={{ width: "100%", height: 38, padding: "0 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, outline: "none", background: "#FFFFFF", fontFamily: FF, boxSizing: "border-box" }} />
                    </div>
                  )}

                  {/* Notes — shared across all branches */}
                  <div style={{ marginBottom: 18 }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>Notes (optional)</label>
                    <textarea value={cancelNote} onChange={e => setCancelNote(e.target.value)} rows={2}
                      placeholder="Why? Anything the next person needs to know?"
                      style={{ width: "100%", padding: "8px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, resize: "vertical", fontFamily: FF, outline: "none", boxSizing: "border-box" }} />
                  </div>

                  <div style={{ display: "flex", gap: 10, justifyContent: "space-between" }}>
                    <button onClick={() => { setCancelAction(null); setCancelNewDate(""); setCancelNewTime(""); setChargeOverride(""); }} disabled={busy}
                      style={{ padding: "9px 18px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontWeight: 600, color: "#6B6860", background: "#FFFFFF", cursor: "pointer", fontFamily: FF }}>← Back</button>
                    <button onClick={cancelJob} disabled={confirmDisabled}
                      style={{
                        padding: "9px 24px",
                        background: confirmDisabled ? "#E5E2DC" : selected.accent,
                        color: confirmDisabled ? "#9E9B94" : "#FFFFFF",
                        border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700,
                        cursor: confirmDisabled ? "not-allowed" : "pointer", fontFamily: FF,
                      }}>
                      {busy ? "Saving..." : `Confirm ${selected.label}`}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* [AG] Edit Job modal */}
      {editOpen && (
        <EditJobModal
          job={{
            id: job.id,
            client_id: job.client_id,
            client_name: job.client_name,
            recurring_schedule_id: (job as any).recurring_schedule_id ?? null,
            service_type: job.service_type,
            frequency: job.frequency,
            scheduled_date: job.scheduled_date,
            scheduled_time: job.scheduled_time,
            duration_minutes: job.duration_minutes,
            amount: job.amount,
            base_fee: (job as any).base_fee ?? job.amount,
            notes: job.notes,
            status: job.status,
            locked_at: job.locked_at,
            assigned_user_id: job.assigned_user_id,
            hourly_rate: job.hourly_rate ?? null,
            // [AI.1] Pass account_id through so the modal's broadened
            // isCommercial detection (client_type='commercial' OR account_id)
            // can fire on jobs whose client_type drifted during MC import.
            account_id: job.account_id ?? null,
          }}
          employees={employees.map(e => ({ id: e.id, name: e.name, role: e.role, is_trainee: e.is_trainee }))}
          mobile={mobile}
          onClose={() => setEditOpen(false)}
          onSaved={(info) => {
            setEditOpen(false);
            const skipped = info.future_jobs_skipped_in_progress;
            const updated = info.future_jobs_updated;
            const desc = updated > 0
              ? `${updated} future job${updated === 1 ? "" : "s"} updated${skipped > 0 ? `. ${skipped} job${skipped === 1 ? " is" : "s are"} in progress and was not modified.` : "."}`
              : "Changes saved.";
            toast({ title: "Job updated", description: desc });
            onUpdate();
          }}
        />
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
  // [AI.7.2] Zone chip — every job MUST have a mapped zone. A job without
  // one is a data error (zip not mapped to a service_zone, or client
  // missing a zip entirely) — surface it as a red warning so dispatchers
  // fix the upstream record instead of routing techs blind.
  const hasZone = !!job.zone_name && !!job.zone_color;
  // [AI.7.5] Visual status — determines stripe (active), opacity
  // (completed), strikethrough/desaturate (cancelled), checkmark/no-show
  // overlays. Mobile card uses the same canonical helper as the desktop
  // Gantt chip and compact rows.
  const visual = STATUS_VISUALS[getJobVisualStatus(job)];
  return (
    <div onClick={onClick} style={{
      backgroundColor: "#FFFFFF", borderRadius: 12,
      padding: "13px 15px", marginBottom: 10, cursor: "pointer", position: "relative",
      // [schedule-views 2026-06-05] FULL-CARD border in the job's ZONE color —
      // same source the desktop Gantt chip fills with — so the whole card
      // outlines in the color that's on the board (a purple-zone job reads
      // purple on both). 2px for prominence. No-zone falls back to GRAY
      // (#9CA3AF, desktop's ZONE_FALLBACK), NOT status-blue. Special-state
      // overrides (late red, unpaid amber, no-show dark-red) still win; the
      // animated active stripe rides inside the border.
      border: `2px solid ${visual.borderOverride ?? job.zone_color ?? "#9CA3AF"}`,
      fontFamily: FF, opacity: visual.bodyOpacity,
      filter: visual.desaturate ? "grayscale(1)" : "none", overflow: "hidden",
    }}>
      {visual.stripe && (
        <div className="qleno-active-stripe" style={{
          position: "absolute", top: 0, bottom: 0, left: 0, width: 4,
          backgroundColor: visual.stripe,
        }} />
      )}
      {visual.showCheckmark && (
        <div style={{ position: "absolute", top: 8, right: 8, width: 18, height: 18, borderRadius: "50%", backgroundColor: "#16A34A", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2 }}>
          <Check size={11} color="#FFFFFF" strokeWidth={3} />
        </div>
      )}
      {visual.showNoShowBadge && (
        <div style={{ position: "absolute", top: 8, right: 8, fontSize: 9, fontWeight: 800, color: "#FFFFFF", backgroundColor: "#991B1B", padding: "3px 7px", borderRadius: 4, letterSpacing: "0.05em", zIndex: 2 }}>
          NO SHOW
        </div>
      )}
      {visual.showFeeBadge && (
        <div style={{ position: "absolute", top: 8, right: 8, fontSize: 9, fontWeight: 800, color: "#FFFFFF", backgroundColor: "#B45309", padding: "3px 7px", borderRadius: 4, letterSpacing: "0.05em", zIndex: 2 }}>
          {job.cancel_action === "lockout" ? "LOCKOUT" : "CANCEL FEE"}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2, flexWrap: "wrap" }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#1A1917", textDecoration: visual.strikethrough ? "line-through" : "none" }}>{job.display_name ?? job.client_name}</div>
            {isCommercial && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: "var(--brand-dim, #EBF4FF)", color: "var(--brand, #00C9A0)" }}>
                <Building2 size={9}/> Comm.
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, color: "var(--brand)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>{fmtSvc(job.service_type)}</div>
            {hasZone ? (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 12,
                backgroundColor: `${job.zone_color}1A`, color: "#1A1917",
                border: `1px solid ${job.zone_color}40`,
              }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: job.zone_color || "#9CA3AF", flexShrink: 0 }} />
                {job.zone_name}
              </span>
            ) : (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 12,
                backgroundColor: "#FEE2E2", color: "#991B1B", border: "1px solid #FCA5A5",
              }}>
                <AlertTriangle size={10} />
                {job.client_zip ? `Unmapped zip ${job.client_zip}` : "Zone missing"}
              </span>
            )}
          </div>
        </div>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 20, backgroundColor: sc.bg, border: `1px solid ${sc.border}`, fontSize: 11, fontWeight: 700, color: sc.text, textTransform: "capitalize", flexShrink: 0, marginLeft: 10 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: sc.dot }} />
          {job.status.replace("_", " ")}
        </span>
      </div>
      {/* [card-polish 2026-06-05] Prominent full SHIFT range (start–end), e.g.
          "9:00 AM – 2:00 PM", on its own line above the meta row. Replaces the
          smaller "9:00 AM · 4h" inline chip — the shift window is what
          dispatchers scan for. Duration trails small for reference. */}
      {job.scheduled_time && (() => {
        const startM = timeToMins(job.scheduled_time);
        const endM = startM + (job.duration_minutes || 0);
        const dm = job.duration_minutes || 0;
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }}>
            <Clock size={15} style={{ color: "#1A1917" }} />
            <span style={{ fontSize: 15, fontWeight: 800, color: "#1A1917", letterSpacing: "-0.01em" }}>
              {fmtMins(startM)} – {fmtMins(endM)}
            </span>
            <span style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94" }}>
              {Math.floor(dm / 60)}h{dm % 60 > 0 ? ` ${dm % 60}m` : ""}
            </span>
          </div>
        );
      })()}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        {job.frequency && job.frequency !== "on_demand" && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, color: "var(--brand)", background: "var(--brand-dim, #f0fdf9)", padding: "2px 7px", borderRadius: 4 }}>
            <Repeat size={9} />{recurrenceLabel(job.frequency)}
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
              Clocked in {fmtClock(job.clock_entry.clock_in_at)}
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
          {(() => {
            // [commercial-revenue 2026-06-04] Show the billing rate on the card
            // for any commercial rate-driven job — "$50/hr × 8h · $420" — not
            // just jobs whose billing_method literally equals "hourly". Before
            // this, a commercial job with a $50/hr rate showed only the flat
            // total and the office could never see the rate it was billing.
            const ah = (job as any).allowed_hours as number | null | undefined;
            const rateDriven = isCommercial && !job.manual_rate_override
              && job.hourly_rate != null && job.hourly_rate > 0
              && ah != null && ah > 0;
            const total = (job.amount ?? job.billed_amount ?? 0).toFixed(2);
            if (rateDriven) {
              return <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1917" }}>${job.hourly_rate!.toFixed(0)}/hr × {ah}h · ${total}</span>;
            }
            if (isCommercial && job.billing_method === "hourly" && job.hourly_rate) {
              return <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1917" }}>${job.hourly_rate.toFixed(0)}/hr{job.estimated_hours ? ` · est. ${job.estimated_hours}h` : ""}</span>;
            }
            return <span style={{ fontSize: 14, fontWeight: 800, color: "#1A1917" }}>${total}</span>;
          })()}
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

// [schedule-views 2026-06-05] MOBILE TIME-GRID (HCP-style). Renders the focal
// day's jobs on an hour grid: vertical position = start time, height =
// duration, concurrent jobs packed into PARALLEL COLUMNS. Column packing is
// per-overlap-cluster (a "connected component" of mutually overlapping jobs),
// so a lone job stays full-width while a 9 AM pile-up splits into N columns —
// same idea as the desktop Gantt's packLanes, rotated to a vertical grid.
// Blocks fill with the job's zone color (matches desktop); text flips to dark
// on light zones via luminance. Jobs with no scheduled time list below.
function MobileTimeGrid({ jobs, onJobClick }: { jobs: DispatchJob[]; onJobClick: (j: DispatchJob) => void }) {
  const PX_PER_MIN = 1.15;
  const GUTTER = 46;
  const dur = (j: DispatchJob) => Math.max(j.duration_minutes || 0, 30);
  const timed = jobs.filter(j => timeToMins(j.scheduled_time) > 0);
  const untimed = jobs.filter(j => timeToMins(j.scheduled_time) <= 0);

  let body: React.ReactNode = null;
  if (timed.length > 0) {
    const minStart = Math.min(...timed.map(j => timeToMins(j.scheduled_time)));
    const maxEnd = Math.max(...timed.map(j => timeToMins(j.scheduled_time) + dur(j)));
    const startHour = Math.max(0, Math.min(8, Math.floor(minStart / 60)));
    const endHour = Math.min(24, Math.max(18, Math.ceil(maxEnd / 60)));
    const dayStart = startHour * 60;
    const gridH = (endHour - startHour) * 60 * PX_PER_MIN;

    // Per-cluster greedy column packing.
    type Placed = { job: DispatchJob; col: number; cols: number; start: number; end: number };
    const sorted = [...timed].sort((a, b) => timeToMins(a.scheduled_time) - timeToMins(b.scheduled_time) || a.id - b.id);
    const placed: Placed[] = [];
    let cluster: Placed[] = [];
    let clusterEnd = -1;
    let colEnds: number[] = [];
    const flush = () => {
      const cols = colEnds.length;
      for (const p of cluster) p.cols = cols;
      placed.push(...cluster);
      cluster = []; colEnds = []; clusterEnd = -1;
    };
    for (const j of sorted) {
      const s = timeToMins(j.scheduled_time), e = s + dur(j);
      if (clusterEnd !== -1 && s >= clusterEnd) flush();
      let col = colEnds.findIndex(end => end <= s);
      if (col === -1) { col = colEnds.length; colEnds.push(e); } else colEnds[col] = e;
      cluster.push({ job: j, col, cols: 0, start: s, end: e });
      clusterEnd = Math.max(clusterEnd, e);
    }
    flush();

    const hours: number[] = [];
    for (let h = startHour; h <= endHour; h++) hours.push(h);

    body = (
      <div style={{ position: "relative", marginLeft: GUTTER, height: gridH, borderTop: "1px solid #F0EEE9" }}>
        {hours.map(h => {
          const top = (h * 60 - dayStart) * PX_PER_MIN;
          return (
            <div key={h} style={{ position: "absolute", left: -GUTTER, right: 0, top, borderTop: "1px solid #F2F0EB" }}>
              <span style={{ position: "absolute", left: 0, top: -7, width: GUTTER - 8, textAlign: "right", fontSize: 10, color: "#9E9B94", fontWeight: 600 }}>{fmtHour(h)}</span>
            </div>
          );
        })}
        {placed.map(p => {
          const j = p.job;
          const visual = STATUS_VISUALS[getJobVisualStatus(j)];
          const color = j.zone_color || "#9CA3AF";
          const onDark = (zoneLuminance(color) / 255) < 0.62;
          const top = (p.start - dayStart) * PX_PER_MIN;
          const height = Math.max((p.end - p.start) * PX_PER_MIN, 36);
          const widthPct = 100 / p.cols;
          const leftPct = p.col * widthPct;
          return (
            <div key={j.id} onClick={() => onJobClick(j)} style={{
              position: "absolute", top, left: `calc(${leftPct}% + 2px)`, width: `calc(${widthPct}% - 4px)`,
              height: height - 3, backgroundColor: color, borderRadius: 8, padding: "5px 7px",
              cursor: "pointer", overflow: "hidden", fontFamily: FF, boxSizing: "border-box",
              color: onDark ? "#FFFFFF" : "#1A1917", opacity: visual.bodyOpacity,
              filter: visual.desaturate ? "grayscale(1)" : "none",
              boxShadow: visual.stripe ? `inset 0 0 0 2px rgba(255,255,255,0.55), 0 0 0 2px ${visual.stripe}` : "none",
            }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, lineHeight: 1.15, textDecoration: visual.strikethrough ? "line-through" : "none", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                {j.display_name ?? j.client_name}
              </div>
              {height >= 46 && (
                <div style={{ fontSize: 9.5, opacity: 0.92, marginTop: 2, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                  {fmtTime(j.scheduled_time)}{j.assigned_user_name ? ` · ${j.assigned_user_name}` : ""}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div>
      {body}
      {untimed.length > 0 && (
        <div style={{ marginTop: body ? 14 : 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 2px 6px" }}>No time set</div>
          {untimed.map(j => <MobileJobCard key={j.id} job={j} onClick={() => onJobClick(j)} />)}
        </div>
      )}
    </div>
  );
}

// [schedule-views 2026-06-05] Decorative, stable avatar color derived from a
// tech's name. Job colors in this app are ZONE-based (not per-tech), so this is
// purely to visually distinguish people in the By-Employee grouping. Hashing the
// name keeps each tech on one color across renders. Tenant-generic.
const TECH_AVATAR_COLORS = ["#0FA3A3", "#8B3FBF", "#2D6BE0", "#D2691E", "#2D9B83", "#C2410C", "#6D28D9", "#0E7490", "#B45309", "#9D174D"];
function techAvatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TECH_AVATAR_COLORS[h % TECH_AVATAR_COLORS.length];
}
function techInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()) || "?";
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
// [Q2] Status pill — colored chip next to client name
const STATUS_PILL: Record<string, { bg: string; fg: string; label: string }> = {
  scheduled:   { bg: "#DBEAFE", fg: "#1D4ED8", label: "Scheduled" },
  in_progress: { bg: "#FEF3C7", fg: "#92400E", label: "In Progress" },
  complete:    { bg: "#DCFCE7", fg: "#15803D", label: "Complete" },
  cancelled:   { bg: "#F3F4F6", fg: "#6B7280", label: "Cancelled" },
};

// [Q2] Human-readable payment_method labels. `manual` returns null → hide section.
function fmtPayment(pm: string | null | undefined): string | null {
  if (!pm || pm === "manual") return null;
  const MAP: Record<string, string> = {
    card_on_file: "Credit Card",
    check:        "Check",
    zelle:        "Zelle",
    net_30:       "Invoice (Net 30)",
    cash:         "Cash",
  };
  return MAP[pm] ?? pm;
}

// [Q2] "Last service" relative-time helper
function fmtRelativeDate(isoDate: string): string {
  const then = new Date(isoDate + "T12:00:00"); // noon to avoid DST edges
  const now = new Date();
  const days = Math.floor((now.getTime() - then.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

// [Q2] Parse `act: 11:21 AM-1:25 PM` from jobs.notes (L4 import artifact).
// Returns {start, end} times as strings, or null if no match.
function parseActualTimes(notes: string | null | undefined): { start: string; end: string } | null {
  if (!notes) return null;
  const m = notes.match(/act:\s*(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
  return m ? { start: m[1], end: m[2] } : null;
}

// [Q2] Strip `[mc_import_phase* ...]` tags when rendering notes to the user.
function stripImportTags(notes: string | null | undefined): string {
  if (!notes) return "";
  return notes.replace(/\[mc_import_phase[^\]]*\]/g, "").trim();
}

function JobHoverCard({ job, assignedName }: { job: DispatchJob; assignedName?: string }) {
  const endTime = minsToStr(timeToMins(job.scheduled_time) + job.duration_minutes);
  const allowedH = job.duration_minutes / 60;
  const isRecurring = job.frequency && job.frequency !== "on_demand";
  const statusPill = STATUS_PILL[job.status] ?? STATUS_PILL.scheduled;
  const actualTimes = parseActualTimes(job.notes);
  const paymentLabel = fmtPayment(job.client_payment_method);
  const entryInstructions = stripImportTags(job.client_notes) || null;
  const liveClock = job.clock_entry;
  const lastServiceRelative = job.last_service_date ? fmtRelativeDate(job.last_service_date) : null;
  const officeNotesCleaned = stripImportTags(job.office_notes);

  // [AD] Location line: zone color dot + zone name + zip. Branch name
  // (previously shown as a prefix like "Oak Lawn · Chicago Central · 60643")
  // is dropped — redundant with the page-level branch filter in the
  // header, and visually competed with the zone name. If the resolved zip
  // doesn't match any service_zone (zone_name null) we still render the
  // zip with a muted gray dot, so unmapped one-offs like Shannon's
  // Whitfield Rd still surface the zip for context.
  const hasZoneBadge = !!(job.zone_name || job.client_zip);

  const sectionBorder = "1px solid #F0EEE9";
  // [AI.7.8] Typography refresh — section headers bumped to 12px caps with
  // tighter tracking; matched to a single labelStyle so every section reads
  // consistently. Sal's note: previous 10/11px caps competed with body
  // copy and the popover felt like a form, not a hero card.
  const labelStyle: React.CSSProperties = {
    fontSize: 12, fontWeight: 700, color: "#6B6860",
    textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 6,
  };
  const valueStyle: React.CSSProperties = {
    fontSize: 17, fontWeight: 600, color: "#1A1917", lineHeight: 1.25,
  };
  // [bugfix 2026-04-28] Dynamic popover positioning. Previous code anchored
  // top: calc(100% + 8px), left: 0 unconditionally, which clipped chips near
  // the bottom or right edges of the viewport. Now we measure after first
  // paint and flip vertically (above the chip) and horizontally (right
  // edge to chip's right) when an edge would otherwise cut the card off.
  // Single re-render. No flash because useLayoutEffect runs synchronously
  // before the browser paints the initial position.
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ vertical: "below" | "above"; horizontal: "left" | "right" }>({
    vertical: "below", horizontal: "left",
  });

  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // [hotfix 2026-04-29 / closes #4] Compare against the nearest
    // ancestor that establishes a clipping context (overflow auto/scroll/
    // hidden), not against the viewport. The dispatch timeline is
    // wrapped in `<div ref={timelineRef} style={{ overflow: 'auto' }}>`
    // (jobs.tsx ~3543) — when its bottom edge sits above the viewport
    // (smaller browser windows, footer/drawer present, the page's
    // height: calc(100vh - 56px) math), chips near the bottom of the
    // visible timeline could pass the old window-based flip check yet
    // still get clipped by the timeline's overflow. Walking up the DOM
    // gives us the actual clipping rectangle.
    const scrollParent = getScrollParent(el.parentElement);
    const bounds = scrollParent ? scrollParent.getBoundingClientRect() : null;
    const topBound    = bounds ? bounds.top    : 0;
    const bottomBound = bounds ? bounds.bottom : window.innerHeight;
    const leftBound   = bounds ? bounds.left   : 0;
    const rightBound  = bounds ? bounds.right  : window.innerWidth;
    const margin = 12;

    let nextVertical = anchor.vertical;
    let nextHorizontal = anchor.horizontal;

    // Vertical: measure the CHIP (the popover's positioned parent), not the
    // popover, so room-above / room-below are real. The previous math derived
    // both from the popover's own rect and inflated "space below" by a full
    // card height, so the card rarely flipped and clipped on mid/low rows.
    // Flip up when the card doesn't fit below and there's more room above.
    const chipRect = el.parentElement ? el.parentElement.getBoundingClientRect() : rect;
    const spaceBelow = bottomBound - chipRect.bottom;
    const spaceAbove = chipRect.top - topBound;
    if (rect.height + margin > spaceBelow && spaceAbove > spaceBelow) {
      nextVertical = "above";
    }

    // Horizontal: flip right-anchor when the popover's right edge would
    // clip past the scroll container's right edge.
    if (rect.right > rightBound - margin) {
      const spaceLeft = rect.right - leftBound;
      if (spaceLeft > rect.width + margin) nextHorizontal = "right";
    }

    if (nextVertical !== anchor.vertical || nextHorizontal !== anchor.horizontal) {
      setAnchor({ vertical: nextVertical, horizontal: nextHorizontal });
    }
  }, []);

  const positionStyle: React.CSSProperties = {
    ...(anchor.vertical === "below"
      ? { top: "calc(100% + 8px)" }
      : { bottom: "calc(100% + 8px)" }),
    ...(anchor.horizontal === "left"
      ? { left: 0 }
      : { right: 0 }),
  };

  // [bugfix 2026-04-28] Zone chip color matches the tile bg exactly.
  // Previous 15% alpha tint read as a different shade than the saturated
  // tile and broke the visual link between tile and popover. Now the
  // chip uses the raw zone_color at full opacity, with text color
  // flipping to dark on light zones (gold etc.) the same way the tile
  // does via zoneLuminance. Gray fallback when unmapped, dark text.
  const zoneChipBg = job.zone_color || "#F3F4F6";
  const zoneChipIsLight = !job.zone_color || zoneLuminance(job.zone_color) > 0.65;
  const zoneChipFg = zoneChipIsLight ? "#1A1917" : "#FFFFFF";
  const zoneChipMutedFg = zoneChipIsLight ? "#4B5563" : "rgba(255,255,255,0.85)";
  const zoneChipDot = zoneChipIsLight ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.85)";

  return (
    // Native click bubbles up to parent JobChip → opens JobPanel drawer.
    // Phone anchor and in-card buttons use their own stopPropagation as needed.
    //
    // [R] Positioning rebuilt after Q2's taller layout got clipped by the
    // dispatch row container's overflow. Anchor is now TOP (renders below
    // the chip) so the critical header (client name + status) is always
    // visible even when hovering chips near the top of the viewport. Very
    // tall content scrolls inside the card rather than overflowing.
    <div ref={popoverRef} style={{
      position: "absolute", ...positionStyle, zIndex: 9999,
      width: 320,
      maxHeight: "calc(100vh - 120px)", overflowY: "auto",
      backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC",
      borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,0.14)",
      fontFamily: FF, padding: 0,
    }}>
      {/* ─── HEADER ─── */}
      <div style={{ padding: "20px 20px 16px", borderBottom: sectionBorder }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", flex: 1, minWidth: 0, lineHeight: 1.2, wordBreak: "break-word" }}>
            {job.display_name ?? job.client_name}
          </div>
          <span style={{
            flexShrink: 0, fontSize: 13, fontWeight: 700, padding: "4px 10px",
            borderRadius: 14, backgroundColor: statusPill.bg, color: statusPill.fg,
            textTransform: "uppercase" as const, letterSpacing: "0.04em",
            lineHeight: 1.1, marginTop: 4,
          }}>
            {statusPill.label}
          </span>
        </div>
        {job.address && (
          mapsDirectionsUrl(job.address) ? (
            <a href={mapsDirectionsUrl(job.address)!} target="_blank" rel="noreferrer"
              title="Tap to navigate in Google Maps"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 15, fontWeight: 500, color: "#1D4ED8", lineHeight: 1.35, marginBottom: 8, textDecoration: "none" }}>
              <MapPin size={14} style={{ flexShrink: 0 }} />
              <span style={{ textDecoration: "underline" }}>{job.address}</span>
            </a>
          ) : (
            <div style={{ fontSize: 15, fontWeight: 500, color: "#1A1917", lineHeight: 1.35, marginBottom: 8 }}>
              {job.address}
            </div>
          )
        )}
        {job.client_phone && (
          <a
            href={`tel:${job.client_phone}`}
            onClick={e => e.stopPropagation()}
            style={{ fontSize: 13, color: "#2D9B83", textDecoration: "none", fontWeight: 600, display: "inline-block" }}
          >
            {job.client_phone}
          </a>
        )}
        {hasZoneBadge && (
          <div style={{ marginTop: 10 }}>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              fontSize: 13, fontWeight: 600, color: zoneChipFg,
              padding: "4px 10px", borderRadius: 12,
              backgroundColor: zoneChipBg,
            }}>
              <div style={{
                width: 8, height: 8, borderRadius: "50%",
                backgroundColor: zoneChipDot,
                flexShrink: 0,
              }} />
              {job.zone_name && <span>{job.zone_name}</span>}
              {job.client_zip && <span style={{ color: zoneChipMutedFg, fontWeight: 500 }}>{job.client_zip}</span>}
            </span>
          </div>
        )}
      </div>

      {/* ─── SERVICE + FREQUENCY + LAST SERVICE ─── */}
      <div style={{ padding: "16px 20px", borderBottom: sectionBorder }}>
        <div style={{ fontSize: 15, fontWeight: 500, color: "#1A1917", lineHeight: 1.3 }}>
          {fmtSvc(job.service_type)}
          <span style={{ color: "#C4C0BB", fontWeight: 500, margin: "0 8px" }}>·</span>
          {isRecurring ? recurrenceLabel(job.frequency) : "One Time"}
        </div>
        {lastServiceRelative && (
          <div style={{ fontSize: 12, color: "#6B6860", marginTop: 6 }}>
            Last service: {job.last_service_date} ({lastServiceRelative})
          </div>
        )}
      </div>

      {/* ─── ENTRY INSTRUCTIONS (conditional) ─── */}
      {entryInstructions && (
        <div style={{ padding: "16px 20px", borderBottom: sectionBorder, backgroundColor: "#FFFBEB" }}>
          <div style={{ ...labelStyle, color: "#92400E" }}>Entry</div>
          <div style={{ fontSize: 13, color: "#1A1917", lineHeight: 1.45 }}>
            {entryInstructions.length > 180 ? entryInstructions.slice(0, 180) + "…" : entryInstructions}
          </div>
        </div>
      )}

      {/* ─── TIME BLOCK ─── */}
      <div style={{ padding: "16px 20px", borderBottom: sectionBorder }}>
        <div style={labelStyle}>Time</div>
        <div style={valueStyle}>
          {fmtTime(job.scheduled_time)} – {fmtTime(endTime)}
        </div>
        {actualTimes && (
          <div style={{ fontSize: 13, color: "#6B6860", marginTop: 4 }}>
            Actual: {actualTimes.start} – {actualTimes.end}
            {job.actual_hours != null && (
              <span style={{ marginLeft: 6, color: "#9E9B94" }}>({job.actual_hours.toFixed(2)}h)</span>
            )}
          </div>
        )}
        <div style={{ fontSize: 12, color: "#9E9B94", marginTop: 4 }}>
          Allowed: {allowedH.toFixed(2)}h
        </div>
      </div>

      {/* ─── ADD-ONS (only when present) ─── */}
      {job.add_ons && job.add_ons.length > 0 && (
        <div style={{ padding: "16px 20px", borderBottom: sectionBorder }}>
          <div style={labelStyle}>Add-ons ({job.add_ons.length})</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {job.add_ons.map((a, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, fontSize: 13, color: "#1A1917" }}>
                <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.quantity > 1 ? `${a.quantity}× ` : ""}{a.name}
                </span>
                <span style={{ fontWeight: 600, color: "#6B6860", flexShrink: 0 }}>
                  ${a.subtotal.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── TOTAL + PAYMENT ─── */}
      <div style={{ padding: "16px 20px", borderBottom: sectionBorder, display: "grid", gridTemplateColumns: paymentLabel ? "1fr 1fr" : "1fr", gap: "0 20px" }}>
        <div>
          <div style={labelStyle}>Total</div>
          <div style={valueStyle}>${(job.amount || 0).toFixed(2)}</div>
        </div>
        {paymentLabel && (
          <div>
            <div style={labelStyle}>Payment</div>
            <div style={valueStyle}>{paymentLabel}</div>
          </div>
        )}
      </div>

      {/* ─── TECHNICIAN (name only, no pay $) ─── */}
      <div style={{ padding: "16px 20px", borderBottom: liveClock ? sectionBorder : undefined }}>
        <div style={labelStyle}>
          {(job.technicians?.length ?? 0) > 1 ? `Team (${job.technicians!.length})` : "Technician"}
        </div>
        {job.technicians && job.technicians.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {job.technicians.map((t, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 17 }}>
                <div style={{
                  width: 26, height: 26, borderRadius: "50%",
                  backgroundColor: t.is_primary ? "#DCFCE7" : "#F3F4F6",
                  color: t.is_primary ? "#15803D" : "#6B7280",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 11, fontWeight: 700, flexShrink: 0,
                }}>
                  {t.name.split(" ").map(p => p[0]).join("").slice(0, 2)}
                </div>
                <span style={{ fontWeight: 600, color: "#1A1917", fontSize: 17 }}>{t.name}</span>
                {t.is_primary && (job.technicians!.length > 1) && (
                  <span style={{ fontSize: 10, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700 }}>Primary</span>
                )}
              </div>
            ))}
          </div>
        ) : assignedName ? (
          <div style={valueStyle}>{assignedName}</div>
        ) : (
          <div style={{ ...valueStyle, color: "#D97706" }}>Unassigned</div>
        )}
      </div>

      {/* ─── JOB CLOCKS (conditional — only when live clock entry exists) ─── */}
      {liveClock && (
        <div style={{ padding: "16px 20px", borderBottom: sectionBorder }}>
          <div style={labelStyle}>Job Clocks</div>
          <div style={{ fontSize: 13, color: "#1A1917", fontWeight: 500, lineHeight: 1.5 }}>
            {liveClock.clock_in_at && (() => {
              const d = liveClock.clock_in_distance_ft ?? liveClock.distance_from_job_ft;
              return (
                <div>
                  <span style={{ color: "#9E9B94" }}>In:</span>{" "}
                  {fmtClock(liveClock.clock_in_at)}
                  {d != null && (
                    <span style={{ color: liveClock.clock_in_outside_geofence ? "#D97706" : "#9E9B94", marginLeft: 6 }}>
                      ({Math.round(d)} ft{liveClock.clock_in_outside_geofence ? " · outside" : ""})
                    </span>
                  )}
                </div>
              );
            })()}
            {liveClock.clock_out_at && (
              <div>
                <span style={{ color: "#9E9B94" }}>Out:</span>{" "}
                {fmtClock(liveClock.clock_out_at)}
                {liveClock.clock_out_distance_ft != null && (
                  <span style={{ color: liveClock.clock_out_outside_geofence ? "#D97706" : "#9E9B94", marginLeft: 6 }}>
                    ({Math.round(liveClock.clock_out_distance_ft)} ft{liveClock.clock_out_outside_geofence ? " · outside" : ""})
                  </span>
                )}
              </div>
            )}
            {liveClock.gps_missing && (
              <div style={{ display: "flex", alignItems: "center", gap: 4, color: "#DC2626", fontWeight: 700, marginTop: 4 }}>
                <AlertTriangle size={12} /> GPS unavailable — location not captured
              </div>
            )}
            {liveClock.is_flagged && !liveClock.gps_missing && (
              <div style={{ color: "#D97706", fontWeight: 600, marginTop: 4 }}>Flagged</div>
            )}
          </div>
        </div>
      )}

      {/* ─── OFFICE NOTES (optional, only when non-empty after tag strip) ─── */}
      {officeNotesCleaned && (
        <div style={{ padding: "12px 20px 14px", borderTop: sectionBorder }}>
          <div style={{ fontSize: 12, color: "#6B6860", fontStyle: "italic", lineHeight: 1.45 }}>
            {officeNotesCleaned.length > 120 ? officeNotesCleaned.slice(0, 120) + "…" : officeNotesCleaned}
          </div>
        </div>
      )}

      {/* ─── FOOTER ─── */}
      <div style={{ padding: "12px 20px 16px", borderTop: sectionBorder, fontSize: 12, fontWeight: 500, color: "#9E9B94", textAlign: "center" }}>
        Click for full details &rarr;
      </div>
    </div>
  );
}

// [job-card-redesign] Re-exported for the dev-only visual test page at
// /jobs/visual-test. Production code should NOT import this — chips on
// the dispatch board route through the page's own <EmployeeRow> /
// <UnassignedGanttRow> hierarchy. The export is here to keep the test
// page in its own file without duplicating chip logic.
export { JobChip as _JobChipForTesting };
export type { DispatchJob as _DispatchJobForTesting };

// ─── DESKTOP: JOB CHIP ─────────────────────────────────────────────────────────
//
// [job-card-redesign] Two-row layout:
//   Row 1 (identity + money): [status icon] [LATE pill] [NEW pill]
//                             [client name] [RES/COM] · · · [live timer]
//                             [price] [delta]
//   Row 2 (context):           [recurring ✓] [service · cadence · duration]
//                              · · · [+N add-ons]
//
// Width breakpoints (SLOT_W = 64 px / 30 min):
//   wide   ≥ 192 px (3 slots = 1.5 h+) — full two-row layout
//   medium 120–191 px                  — drop add-ons pill, drop NEW pill,
//                                        drop duration on row 2
//   narrow < 120 px (< 1 h)            — single-line: name + price only,
//                                        all pills hidden
//
// Status routes through getJobVisualStatus(); STATUS_VISUALS owns stripe,
// border, opacity, checkmark, no-show, car-icon flag. Chip-specific
// elaborations (live timer pill, progress bar, NEW pill) are derived
// from job fields directly — they don't fit the "every-surface" contract
// and would noise up the canonical visual.
// [job-card-redesign / followup] JobChip is now layout-aware. The
// inner two-row body is in <JobChipBody>; this component owns the
// outer wrapper (positioning, draggable, stripe, progress bar, corner
// badges, hover popover) and varies it by `layout`.
//
// Three layouts share one body — that's the whole point of the
// extraction. List view, drag overlay, and the timeline chip can no
// longer drift on which pills/badges they show.
type ChipLayout = "timeline" | "list" | "drag";

function JobChip({
  job, onClick, assignedName, isUnassigned, forceStatus, layout = "timeline", top = 10,
}: {
  job: DispatchJob;
  onClick: (j: DispatchJob) => void;
  assignedName?: string;
  isUnassigned?: boolean;
  /** Timeline vertical offset within the lane. Default 10 (single
   *  sub-lane, unchanged). The parent row's overlap packer raises this
   *  for jobs stacked into deeper sub-lanes so time-overlapping chips
   *  don't paint on top of (and hide) each other. */
  top?: number;
  /** Test-only override for visual status. Used by /jobs/visual-test
   *  to render every lifecycle state side-by-side, bypassing
   *  LIVE_OPS / clock-derivation gates. Production callers should
   *  never set this. */
  forceStatus?: import("@/lib/job-status").JobVisualStatus;
  /** Render variant — "timeline" (Gantt block, draggable, hover
   *  popover, progress bar, live timer), "list" (full-width white
   *  card, no drag, no popover, no live animations — just the
   *  body + state ring), or "drag" (chip-shaped, no DnD, no live
   *  animations — used by DragOverlay so the dragged element
   *  matches the chip the user is grabbing). */
  layout?: ChipLayout;
}) {
  const isComplete = job.status === "complete";
  const isCommercial = !!job.account_id || job.client_type === "commercial";

  const status = forceStatus ?? getJobVisualStatus(job);
  const visual = STATUS_VISUALS[status];

  const ZONE_FALLBACK = "#9CA3AF";
  const bgColor = job.zone_color || ZONE_FALLBACK;
  const isLightZone = zoneLuminance(job.zone_color) > 0.65;
  // [2026-06-04] Completed bars drain their color (fillMuted) but keep the
  // border + text-token choice from the original zone color, so the chip
  // stays legible. bgColor stays the source for token/border decisions.
  const chipBg = visual.fillMuted ? mutedFill(bgColor) : bgColor;
  const borderColor = visual.borderOverride ?? bgColor;

  // Color tokens depend on background. Timeline + drag sit on the
  // saturated zone color (white-on-color unless the zone is light).
  // List sits on white, so always dark-on-white.
  const onZoneText = {
    primary:   isLightZone ? "#1A1917" : "#FFFFFF",
    secondary: isLightZone ? "#4B5563" : "rgba(255,255,255,0.90)",
    icon:      isLightZone ? "#6B7280" : "rgba(255,255,255,0.90)",
    pillBg:    isLightZone ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.20)",
  };
  const onWhiteText = {
    primary:   "#1A1917",
    secondary: "#6B6860",
    icon:      "#9E9B94",
    pillBg:    "rgba(0,0,0,0.06)",
  };
  const tokens = layout === "list" ? onWhiteText : onZoneText;

  // Timeline-only computed values
  const timelineLeft = ((timeToMins(job.scheduled_time) - DAY_START) / 30) * SLOT_W;
  const timelineWidth = Math.max(SLOT_W, (job.duration_minutes / 30) * SLOT_W);

  // Width tier drives narrow / wide layout choices in the body.
  // Timeline: derived from duration. List: always full-width-card,
  // treat as wide. Drag: same as timeline.
  const effectiveWidth = layout === "list" ? 320 : timelineWidth;
  const isNarrow = effectiveWidth < 120;
  const isWide   = effectiveWidth >= 192;
  const showDuration = effectiveWidth >= 320;

  // DnD only on the timeline. In list mode the row click handler
  // opens the JobPanel; in drag mode the parent <DragOverlay> owns
  // the drag, this is just the visual.
  const dnd = useDraggable({
    id: `chip-${job.id}-${layout}`,
    data: { job, originalLeft: timelineLeft, type: isUnassigned ? "unassigned" : undefined },
    // [unlock-completed 2026-06-10] Completed jobs are now draggable too — the
    // office needs to fix a wrong tech/time after the fact. The PUT mirror
    // keeps job_technicians in sync on reassignment.
    disabled: layout !== "timeline",
  });

  // [BUG-6 follow-up / 2026-06-02] Dispatch.amount is now LIVE (post #229:
  // base_fee + SUM(rate_mods) + SUM(add_ons)). job.billed_amount is a cache
  // that PATCH /jobs/:id doesn't refresh on base_fee edits, so passing it
  // to computePriceDelta made the chip render the stale value with a
  // misleading "↓ $100" delta (Jaira 4322: amount=420 correct, billed=320
  // stale → chip showed "$320 ↓ $100"). Passing billedAmount=null routes
  // through the display-amount fallback so the chip shows the live amount
  // and no delta. Delta was a workaround for the old amount/billed split
  // and isn't meaningful now that amount is authoritative.
  const { display: priceDisplay, deltaAmount } = computePriceDelta({
    amount: job.amount,
    billedAmount: null,
    hourlyRate: job.hourly_rate,
    billingMethod: job.billing_method,
  });

  // Live timer + progress bar — timeline only. List and drag are
  // either too dense or too transient for a live-updating element.
  const clockInAt = job.clock_entry?.clock_in_at;
  const elapsedMin = layout === "timeline" && status === "active" && clockInAt
    ? Math.max(0, Math.round((Date.now() - new Date(clockInAt).getTime()) / 60000))
    : 0;
  const allowedMin = job.duration_minutes > 0 ? job.duration_minutes : 60;
  const progressFraction = layout === "timeline" && status === "active" && clockInAt
    ? Math.min(1, elapsedMin / allowedMin)
    : 0;
  const timerLabel = elapsedMin >= 60
    ? `${Math.floor(elapsedMin / 60)}h ${elapsedMin % 60}m`
    : `${elapsedMin}m`;

  const lateMin = (() => {
    if (status !== "late_clockin") return 0;
    const startMins = timeToMins(job.scheduled_time);
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    return Math.max(0, nowMins - startMins);
  })();

  const addOnCount = job.add_ons?.length ?? 0;
  const isNew = job.is_new_client === true;

  // Hover popover — timeline only. List rows have a different
  // affordance (clicking the row opens the JobPanel directly), and
  // drag overlay is transient.
  const [hovered, setHovered] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function onEnter() {
    if (layout !== "timeline") return;
    hoverTimer.current = setTimeout(() => setHovered(true), 400);
  }
  function onLeave() { if (hoverTimer.current) clearTimeout(hoverTimer.current); setHovered(false); }

  const baseShadow = layout === "list"
    ? "0 1px 2px rgba(0,0,0,0.04)"
    : "0 1px 4px rgba(0,0,0,0.12)";
  // New-client outline — white on chip, faint dark on white card.
  const newShadow = isNew
    ? layout === "list"
      ? "inset 0 0 0 1.5px rgba(0,0,0,0.10)"
      : "inset 0 0 0 1.5px rgba(255,255,255,0.55)"
    : null;
  const composedShadow = newShadow ? `${newShadow}, ${baseShadow}` : baseShadow;

  const body = (
    <JobChipBody
      job={job}
      status={status}
      visual={visual}
      tokens={tokens}
      bgColor={bgColor}
      isCommercial={isCommercial}
      isNew={isNew}
      isNarrow={isNarrow}
      isWide={isWide}
      showDuration={showDuration}
      addOnCount={addOnCount}
      priceDisplay={priceDisplay}
      deltaAmount={deltaAmount}
      lateMin={lateMin}
      elapsedMin={elapsedMin}
      timerLabel={timerLabel}
      allowedMin={allowedMin}
      showLiveTimer={layout === "timeline"}
      showPhotoGlance={layout === "timeline"}
    />
  );

  // ───── Layout: list ─────
  // Full-width white card, no DnD, no popover, no progress bar.
  // Status ring/border still applies; metadata footer (time + tech +
  // freq) is appended below the chip body so list-view rows still
  // surface the at-a-glance fields they always showed.
  if (layout === "list") {
    return (
      <div onClick={() => onClick(job)}
        style={{
          backgroundColor: "#FFFFFF",
          border: `1.5px solid ${visual.borderOverride ?? "#E5E2DC"}`,
          borderLeft: visual.stripe
            ? "1.5px solid #E5E2DC"
            : `4px solid ${visual.borderOverride ?? chipBg}`,
          borderRadius: 10, padding: "12px 14px", cursor: "pointer",
          position: "relative", overflow: "hidden",
          opacity: visual.bodyOpacity,
          filter: visual.desaturate ? "grayscale(1)" : "none",
          boxShadow: composedShadow,
          display: "flex", flexDirection: "column", gap: 6,
        }}>
        {visual.stripe && (
          <div className="qleno-active-stripe" style={{
            position: "absolute", top: 0, bottom: 0, left: 0, width: 4,
            backgroundColor: visual.stripe,
          }} />
        )}
        {visual.showCheckmark && (
          <div style={{ position: "absolute", top: 8, right: 8, width: 18, height: 18, borderRadius: "50%", backgroundColor: "#16A34A", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 3px rgba(0,0,0,0.2)", zIndex: 3 }}>
            <Check size={11} color="#FFFFFF" strokeWidth={3} />
          </div>
        )}
        {visual.showNoShowBadge && (
          <div style={{ position: "absolute", top: 8, right: 8, fontSize: 9, fontWeight: 800, color: "#FFFFFF", backgroundColor: "#991B1B", padding: "3px 7px", borderRadius: 4, letterSpacing: "0.05em", zIndex: 3 }}>
            NO SHOW
          </div>
        )}
        {visual.showFeeBadge && (
          <div style={{ position: "absolute", top: 8, right: 8, fontSize: 9, fontWeight: 800, color: "#FFFFFF", backgroundColor: "#B45309", padding: "3px 7px", borderRadius: 4, letterSpacing: "0.05em", zIndex: 3 }}>
            {job.cancel_action === "lockout" ? "LOCKOUT" : "CANCEL FEE"}
          </div>
        )}
        <div style={{ paddingLeft: visual.stripe ? 8 : 0 }}>
          {body}
        </div>
        {/* Metadata footer — list-only context */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", paddingLeft: visual.stripe ? 8 : 0, fontSize: 12, color: "#6B7280" }}>
          {job.scheduled_time && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Clock size={11} style={{ color: "#9E9B94" }} />
              {fmtTime(job.scheduled_time)}
            </span>
          )}
          {assignedName && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <User size={11} style={{ color: "#9E9B94" }} />
              {assignedName}
            </span>
          )}
          {job.zone_name && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: job.zone_color || "#9CA3AF" }} />
              {job.zone_name}
            </span>
          )}
        </div>
      </div>
    );
  }

  // ───── Layout: drag ─────
  // Chip-shaped, no DnD wiring, no live elements. Used inside
  // <DragOverlay /> while a chip is being dragged so the dragged
  // element matches what the user picked up.
  if (layout === "drag") {
    return (
      <div style={{
        width: timelineWidth, height: ROW_H - 20,
        borderRadius: 8, backgroundColor: chipBg,
        border: `2px solid ${borderColor}`,
        boxSizing: "border-box", overflow: "visible",
        opacity: 0.92,
        filter: visual.desaturate ? "grayscale(1)" : "none",
        display: "flex", flexDirection: "row",
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
      }}>
        {visual.stripe && (
          <div style={{
            width: 4, alignSelf: "stretch", backgroundColor: visual.stripe,
            borderTopLeftRadius: 6, borderBottomLeftRadius: 6, flexShrink: 0,
          }} />
        )}
        {body}
        {visual.showCheckmark && (
          <div style={{ position: "absolute", top: -4, right: -4, width: 16, height: 16, borderRadius: "50%", backgroundColor: "#16A34A", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 3px rgba(0,0,0,0.2)", zIndex: 3 }}>
            <Check size={10} color="#FFFFFF" strokeWidth={3} />
          </div>
        )}
        {visual.showFeeBadge && (
          <div style={{ position: "absolute", top: -6, right: -2, fontSize: 8, fontWeight: 800, color: "#FFFFFF", backgroundColor: "#B45309", padding: "2px 5px", borderRadius: 3, letterSpacing: "0.05em", zIndex: 3, boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }}>
            {job.cancel_action === "lockout" ? "LOCKOUT" : "CANCEL FEE"}
          </div>
        )}
      </div>
    );
  }

  // ───── Layout: timeline (default) ─────
  return (
    <div ref={dnd.setNodeRef}
      onClick={e => { e.stopPropagation(); setHovered(false); onClick(job); }}
      onMouseEnter={onEnter} onMouseLeave={onLeave}
      {...dnd.listeners} {...dnd.attributes}
      style={{
        position: "absolute", top, left: timelineLeft, width: timelineWidth, height: ROW_H - 20,
        borderRadius: 8, backgroundColor: chipBg,
        border: `2px solid ${borderColor}`,
        boxSizing: "border-box", overflow: "visible",
        cursor: dnd.isDragging ? "grabbing" : "grab",
        opacity: dnd.isDragging ? 0.3 : visual.bodyOpacity,
        filter: visual.desaturate ? "grayscale(1)" : "none",
        transform: dnd.transform ? `translate(${dnd.transform.x}px, ${dnd.transform.y}px)` : undefined,
        zIndex: hovered ? 50 : dnd.isDragging ? 0 : 2,
        userSelect: "none", display: "flex", flexDirection: "row",
        boxShadow: composedShadow,
      }}>
      {visual.stripe && (
        <div className="qleno-active-stripe" style={{
          width: 4, alignSelf: "stretch", backgroundColor: visual.stripe,
          borderTopLeftRadius: 6, borderBottomLeftRadius: 6, flexShrink: 0,
        }} />
      )}
      {status === "active" && progressFraction > 0 && (
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, height: 3,
          backgroundColor: "rgba(0,0,0,0.18)", borderTopLeftRadius: 6, borderTopRightRadius: 6,
          overflow: "hidden", zIndex: 2, pointerEvents: "none",
        }}>
          <div style={{
            width: `${progressFraction * 100}%`, height: "100%",
            backgroundColor: "rgba(255,255,255,0.92)",
          }} />
        </div>
      )}
      {body}
      {visual.showCheckmark && (
        <div style={{ position: "absolute", top: -4, right: -4, width: 16, height: 16, borderRadius: "50%", backgroundColor: "#16A34A", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 3px rgba(0,0,0,0.2)", zIndex: 3 }}>
          <Check size={10} color="#FFFFFF" strokeWidth={3} />
        </div>
      )}
      {visual.showNoShowBadge && (
        <div style={{ position: "absolute", top: -6, right: -2, fontSize: 8, fontWeight: 800, color: "#FFFFFF", backgroundColor: "#991B1B", padding: "2px 5px", borderRadius: 3, letterSpacing: "0.05em", zIndex: 3, boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }}>
          NO SHOW
        </div>
      )}
      {visual.showFeeBadge && (
        <div style={{ position: "absolute", top: -6, right: -2, fontSize: 8, fontWeight: 800, color: "#FFFFFF", backgroundColor: "#B45309", padding: "2px 5px", borderRadius: 3, letterSpacing: "0.05em", zIndex: 3, boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }}>
          {job.cancel_action === "lockout" ? "LOCKOUT" : "CANCEL FEE"}
        </div>
      )}
      {hovered && !dnd.isDragging && <JobHoverCard job={job} assignedName={assignedName} />}
    </div>
  );
}

// [job-card-redesign / followup] Two-row body shared by every
// JobChip layout. Pure presentational — receives all computed
// values from the parent. No DnD, no positioning, no animation
// state. Adding a new pill / badge here lights up every surface
// at once.
function JobChipBody({
  job, status, visual, tokens, bgColor,
  isCommercial, isNew, isNarrow, isWide, showDuration,
  addOnCount, priceDisplay, deltaAmount,
  lateMin, elapsedMin, timerLabel, allowedMin,
  showLiveTimer, showPhotoGlance,
}: {
  job: DispatchJob;
  status: import("@/lib/job-status").JobVisualStatus;
  visual: import("@/lib/job-status").StatusVisual;
  tokens: { primary: string; secondary: string; icon: string; pillBg: string };
  bgColor: string;
  isCommercial: boolean;
  isNew: boolean;
  isNarrow: boolean;
  isWide: boolean;
  showDuration: boolean;
  addOnCount: number;
  priceDisplay: string;
  deltaAmount: number | null;
  lateMin: number;
  elapsedMin: number;
  timerLabel: string;
  allowedMin: number;
  showLiveTimer: boolean;
  showPhotoGlance: boolean;
}) {
  const isRecurring = !!job.frequency && job.frequency !== "on_demand";
  return (
    <div style={{ flex: 1, minWidth: 0, padding: "6px 10px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 2 }}>
      {isNarrow ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          {visual.showCarIcon && <CarIconInline tint={tokens.primary} />}
          <span style={{ fontSize: 11, fontWeight: 700, color: tokens.primary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0, textDecoration: visual.strikethrough ? "line-through" : "none" }}>
            {job.display_name ?? job.client_name}
          </span>
          <span style={{ fontSize: 11, fontWeight: 800, color: tokens.primary, whiteSpace: "nowrap", flexShrink: 0 }}>
            {priceDisplay}
          </span>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
            {visual.showCarIcon && <CarIconInline tint={tokens.primary} />}
            {!visual.showCarIcon && job.clock_entry?.clock_in_at && status !== "active" && (
              <Clock size={9} style={{ color: tokens.icon, flexShrink: 0 }} />
            )}
            {status === "late_clockin" && lateMin > 0 && (
              // [phes-lifecycle 2026-04-29] "LATE 24m" — caps via literal,
              // not textTransform, so the trailing minute "m" stays
              // lowercase per the spec.
              <span style={{
                flexShrink: 0, fontSize: 8, fontWeight: 800,
                padding: "1px 5px", borderRadius: 4,
                backgroundColor: "#DC2626", color: "#FFFFFF",
                letterSpacing: "0.05em", lineHeight: 1.2,
              }}>
                LATE {lateMin}m
              </span>
            )}
            {status === "completed_unpaid" && (
              <span style={{
                flexShrink: 0, fontSize: 8, fontWeight: 800,
                padding: "1px 5px", borderRadius: 4,
                backgroundColor: "#BA7517", color: "#FFFFFF",
                textTransform: "uppercase", letterSpacing: "0.05em", lineHeight: 1.2,
              }}>
                Unpaid
              </span>
            )}
            {isNew && isWide && (
              <span style={{
                flexShrink: 0, fontSize: 9, fontWeight: 700,
                padding: "1px 5px", borderRadius: 4,
                backgroundColor: tokens.primary === "#1A1917" ? bgColor : "#FFFFFF",
                color: tokens.primary === "#1A1917" ? "#FFFFFF" : bgColor,
                textTransform: "uppercase", letterSpacing: "0.05em", lineHeight: 1.2,
              }}>
                New
              </span>
            )}
            {showPhotoGlance && job.after_photo_count > 0 && status !== "active" && (
              <Camera size={9} style={{ color: tokens.icon, flexShrink: 0 }} />
            )}
            <span style={{ fontSize: 11, fontWeight: 700, color: tokens.primary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0, textDecoration: visual.strikethrough ? "line-through" : "none" }}>
              {job.display_name ?? job.client_name}
            </span>
            <span style={{
              flexShrink: 0,
              fontSize: 8, fontWeight: 800,
              padding: "1px 5px", borderRadius: 4,
              backgroundColor: tokens.pillBg,
              color: tokens.primary,
              textTransform: "uppercase", letterSpacing: "0.05em",
              lineHeight: 1.2,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}>
              {isCommercial ? "COM" : "RES"}
            </span>
            {showLiveTimer && status === "active" && isWide && elapsedMin > 0 && (
              <span style={{
                flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 3,
                fontSize: 9, fontWeight: 700,
                padding: "1px 5px", borderRadius: 4,
                backgroundColor: tokens.pillBg, color: tokens.primary,
                lineHeight: 1.2,
              }}>
                <span style={{ width: 4, height: 4, borderRadius: "50%", backgroundColor: tokens.primary, display: "inline-block" }} />
                {timerLabel}
              </span>
            )}
            <span style={{ fontSize: 11, fontWeight: 800, color: tokens.primary, whiteSpace: "nowrap", flexShrink: 0 }}>
              {priceDisplay}
            </span>
            {deltaAmount != null && (
              <span style={{
                flexShrink: 0, fontSize: 8, fontWeight: 700,
                padding: "1px 4px", borderRadius: 3,
                backgroundColor: deltaAmount > 0 ? "rgba(34,197,94,0.85)" : "rgba(239,68,68,0.85)",
                color: "#FFFFFF", lineHeight: 1.2, whiteSpace: "nowrap",
              }}>
                {deltaAmount > 0 ? "↑" : "↓"} {fmtUSD(Math.abs(deltaAmount))}
              </span>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
            {isRecurring && <Check size={9} style={{ color: tokens.icon, flexShrink: 0 }} strokeWidth={3} />}
            <span style={{ fontSize: 10, fontWeight: 500, color: tokens.secondary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>
              {scopeLabel(job)}
            </span>
            {showDuration && allowedMin > 0 && (
              <span style={{ fontSize: 10, fontWeight: 600, color: tokens.secondary, whiteSpace: "nowrap", flexShrink: 0 }}>
                {Math.round((allowedMin / 60) * 10) / 10}h
              </span>
            )}
            {/* [addons-on-bar 2026-06-05] Show the add-ons on the chip itself
                (Sal: "add-on emblems or text need to show on the job bar so we
                have full scope"). Wide chips render the names (truncated, full
                list in the tooltip); medium chips show "+N add-ons"; narrow
                chips drop it (the panel still lists them). */}
            {addOnCount > 0 && !isNarrow && (() => {
              const names = (job.add_ons ?? []).map(a => a.name).filter(Boolean).join(", ");
              return (
                <span title={names || `${addOnCount} add-on${addOnCount > 1 ? "s" : ""}`} style={{
                  flexShrink: 0, fontSize: 9, fontWeight: 700,
                  padding: "1px 5px", borderRadius: 4,
                  backgroundColor: tokens.pillBg, color: tokens.primary,
                  lineHeight: 1.2, whiteSpace: "nowrap",
                  overflow: "hidden", textOverflow: "ellipsis",
                  maxWidth: isWide ? 150 : 78,
                }}>
                  {isWide && names ? `+ ${names}` : `+${addOnCount} add-on${addOnCount > 1 ? "s" : ""}`}
                </span>
              );
            })()}
          </div>
        </>
      )}
      {/* [address-on-bar 2026-06-04] Address (incl. any unit/suite/apt embedded
          in the street) on every chip — narrow + wide — so dispatch reads the
          location off the bar. Truncates with ellipsis; full address in the
          panel/hover. */}
      {job.address && (
        <div style={{ display: "flex", alignItems: "center", gap: 3, minWidth: 0 }}>
          <MapPin size={9} style={{ color: tokens.icon, flexShrink: 0 }} />
          <span style={{ fontSize: 9, fontWeight: 500, color: tokens.secondary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>
            {job.address}
          </span>
        </div>
      )}
    </div>
  );
}

// [job-card-redesign] Side-profile car SVG with motion lines for the
// en_route status. Lucide ships a "Car" icon but it's a front view and
// has no motion lines, so we draw our own. The wrapper class
// `qleno-en-route-icon` ties into the keyframes injected via
// ensureJobStatusStyles() — translateX 0 → 1.5px → 0 over 0.8s. The
// element respects prefers-reduced-motion via the same CSS file.
function CarIconInline({ tint }: { tint: string }) {
  return (
    <span
      className="qleno-en-route-icon"
      aria-label="On the way"
      style={{
        display: "inline-flex", alignItems: "center", flexShrink: 0,
        width: 18, height: 11,
      }}
    >
      <svg width="18" height="11" viewBox="0 0 18 11" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Motion lines (trailing) */}
        <line x1="0.5" y1="3.5" x2="3"   y2="3.5" stroke={tint} strokeWidth="1" strokeLinecap="round" opacity="0.85" />
        <line x1="0.5" y1="6"   x2="2.5" y2="6"   stroke={tint} strokeWidth="1" strokeLinecap="round" opacity="0.55" />
        <line x1="0.5" y1="8.5" x2="2"   y2="8.5" stroke={tint} strokeWidth="1" strokeLinecap="round" opacity="0.30" />
        {/* Car body — side profile */}
        <path
          d="M5 7.5 V5 L6.5 3 H11.5 L13 5 V7.5 Z"
          stroke={tint} strokeWidth="1" strokeLinejoin="round" fill="none"
        />
        {/* Hood + trunk extension */}
        <line x1="13" y1="7.5" x2="16.5" y2="7.5" stroke={tint} strokeWidth="1" strokeLinecap="round" />
        {/* Wheels */}
        <circle cx="7"    cy="9" r="1.3" stroke={tint} strokeWidth="1" fill="none" />
        <circle cx="12.5" cy="9" r="1.3" stroke={tint} strokeWidth="1" fill="none" />
      </svg>
    </span>
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

// [overlap-stacking 2026-06-02] Pack a lane's jobs into stacked sub-lanes
// so time-overlapping chips never paint on top of each other.
//
// Root cause this fixes: every JobChip was absolutely positioned at a
// fixed `top: 10`, with left/width derived purely from scheduled_time +
// duration. When one tech had two jobs whose time ranges overlapped, the
// two chips landed at the same top and overlapping left — the later one
// in array order completely covered the earlier one. That single render
// bug produced TWO long-standing field reports:
//   * "cancel a job and a DIFFERENT client's job appears" (#223) — the
//     hidden chip underneath surfaced once the top one was filtered out.
//   * "skipped Ava Martinez but it se quedó ahí" — the overlapping chip
//     stayed in the same spot, so the skip looked like a no-op.
// The cancel→ghost diagnostic (#223) never caught it because the "ghost"
// was always in the dispatch payload (so the before/after id-diff found
// nothing new) — it was only ever hidden in the paint.
//
// Greedy interval packing: sort by start, drop each job into the first
// sub-lane whose last chip has already ended, else open a new sub-lane.
// A non-overlapping row resolves to one sub-lane → original 72px height,
// chips at top:10 (zero visual change). Overlapping rows grow tall enough
// to show every chip. Effective end uses a 30-min floor because the chip
// has a SLOT_W minimum width — two back-to-back min-width chips still
// overlap visually even when their logical durations don't.
const CHIP_H = ROW_H - 20;       // 52 — single-chip height, unchanged
const SUBLANE_GAP = 8;
function packLanes(jobs: DispatchJob[]): { topById: Map<number, number>; rowHeight: number } {
  const topById = new Map<number, number>();
  if (jobs.length === 0) return { topById, rowHeight: ROW_H };
  const sorted = [...jobs].sort((a, b) => {
    const sa = timeToMins(a.scheduled_time), sb = timeToMins(b.scheduled_time);
    return sa !== sb ? sa - sb : a.id - b.id;
  });
  const laneEnds: number[] = []; // end-minute of the last chip in each sub-lane
  for (const j of sorted) {
    const start = timeToMins(j.scheduled_time);
    const end = start + Math.max(j.duration_minutes || 0, 30);
    let lane = laneEnds.findIndex(e => e <= start);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(end); }
    else laneEnds[lane] = end;
    topById.set(j.id, 10 + lane * (CHIP_H + SUBLANE_GAP));
  }
  const laneCount = laneEnds.length;
  const rowHeight = 20 + laneCount * CHIP_H + (laneCount - 1) * SUBLANE_GAP;
  return { topById, rowHeight };
}

function EmployeeRow({ employee, onChipClick, nowLine }: { employee: Employee; onChipClick: (j: DispatchJob) => void; nowLine: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: `row-${employee.id}` });
  const [, navigate] = useLocation();
  const initials = employee.name.split(" ").map((p: string) => p[0]).join("").toUpperCase().slice(0, 2);
  const totalMins = employee.jobs.reduce((s: number, j: DispatchJob) => s + j.duration_minutes, 0);
  // [BUG-3F2 / 2026-06-02] Badge revenue sums per-tech revenue_share
  // when present so shared jobs (multi-tech) don't inflate both rows
  // to the full job amount. Falls back to j.amount for solo jobs and
  // for payloads from older server builds where revenue_share isn't set.
  const revenue = employee.jobs.reduce(
    (s: number, j: DispatchJob) => s + (j.revenue_share ?? j.amount ?? 0),
    0,
  );
  // [2026-06-02] Badge pay was using employee.commission_rate (the
  // commission_rate_override column), which is null for techs that
  // haven't been individually overridden — so the badge displayed "$0"
  // for techs with real jobs (Juan Salazar: 1j · 2h · $150 · $0).
  // Fix: sum est_pay_per_tech across the day's jobs — the server has
  // already done the routing (residential pool vs commercial hourly,
  // per-tech split) so the row badge agrees with the JobPanel's
  // commission breakdown by construction. Falls back to the
  // commission_rate × revenue formula when the API hasn't been
  // re-deployed yet (so old payloads still show something).
  const payFromJobs = employee.jobs.reduce(
    (s: number, j: DispatchJob) => s + (j.est_pay_per_tech ?? 0),
    0
  );
  const payFromRate = employee.commission_rate != null ? revenue * (employee.commission_rate / 100) : null;
  const pay = payFromJobs > 0 ? payFromJobs : payFromRate;
  const isClockedIn = employee.jobs.some(j => j.clock_entry?.clock_in_at && !j.clock_entry?.clock_out_at);
  const timeOffBg = employee.time_off ? TIME_OFF_BG[employee.time_off] : null;
  // [overlap-stacking] Stack time-overlapping chips into sub-lanes so none
  // hides another; row grows to fit. One sub-lane → unchanged 72px row.
  const { topById, rowHeight } = packLanes(employee.jobs);
  return (
    <div style={{ display: "flex", borderBottom: "1px solid #EEECE7", height: rowHeight }}>
      <div style={{ position: "sticky", left: 0, zIndex: 5, width: COL_W, flexShrink: 0, backgroundColor: timeOffBg || "#FFFFFF", borderRight: "1px solid #E5E2DC", display: "flex", alignItems: "center", padding: "0 12px", gap: 9 }}>
        <div style={{ position: "relative", flexShrink: 0 }}>
          {/* [2026-06-02] Show users.avatar_url when present; fall back
              to initials in the existing brand-dim circle. The fallback
              path is hit when a tech hasn't uploaded a photo yet OR if
              the image fails to load (onError swaps in initials). */}
          {employee.avatar_url ? (
            <img
              src={employee.avatar_url}
              alt={employee.name}
              style={{ width: 32, height: 32, borderRadius: "50%", objectFit: "cover", display: "block", backgroundColor: "var(--brand-dim)" }}
              onError={(e) => {
                const parent = (e.currentTarget as HTMLImageElement).parentElement;
                if (parent) {
                  parent.innerHTML = `<div style="width:32px;height:32px;border-radius:50%;background:var(--brand-dim);color:var(--brand);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800">${initials}</div>`;
                }
              }}
            />
          ) : (
            <div style={{ width: 32, height: 32, borderRadius: "50%", backgroundColor: "var(--brand-dim)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800 }}>{initials}</div>
          )}
          {isClockedIn && <div style={{ position: "absolute", bottom: 0, right: 0, width: 9, height: 9, borderRadius: "50%", backgroundColor: "#22C55E", border: "2px solid #FFFFFF" }} title="Clocked in" />}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: 4 }}>
            <span
              onClick={(e) => { e.stopPropagation(); navigate(`/employees/${employee.id}`); }}
              title={`Open ${employee.name}'s profile`}
              style={{ overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer" }}
              onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
              onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
            >{employee.name}</span>
            {employee.is_trainee && (
              <span title="In training — first 3 weeks from hire date" style={{ flexShrink: 0, fontSize: 8, fontWeight: 800, letterSpacing: "0.05em", color: "#92400E", background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 4, padding: "1px 5px", textTransform: "uppercase" }}>Trainee</span>
            )}
            {employee.zone && <div style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: employee.zone.zone_color, flexShrink: 0 }} title={employee.zone.zone_name} />}
          </div>
          <div style={{ fontSize: 9, color: "#9E9B94", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.05em" }}>{employee.is_trainee ? "Trainee" : employee.role}</div>
          {/* [2026-06-04] Two lines so the two dollar figures don't read as
              one number. Line 1 = the work (jobs · hours · revenue billed).
              Line 2 = what the TECH earns that day (commission/pay), mint +
              labeled so it's never confused with the billed revenue. */}
          <div style={{ fontSize: 10, color: "#6B6860", marginTop: 1, whiteSpace: "nowrap" }}>
            {employee.jobs.length}j · {(totalMins / 60).toFixed(1)}h · {fmtUSD(revenue)}
          </div>
          <div style={{ fontSize: 10, color: "#2D9B83", fontWeight: 700, marginTop: 1, display: "flex", alignItems: "baseline", gap: 4 }}>
            {fmtUSD(pay)}
            <span style={{ fontSize: 8, fontWeight: 800, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em" }}>pay</span>
          </div>
        </div>
      </div>
      <div ref={setNodeRef} style={{ position: "relative", width: TOTAL_SLOTS * SLOT_W, flexShrink: 0, height: rowHeight, backgroundColor: isOver ? "rgba(91,155,213,0.05)" : "transparent", transition: "background-color 0.1s" }}>
        {/* [grid-clarity 2026-06-20] Read time at a glance: solid darker line at
            each hour, faint dotted line at the half-hour, and a subtle tint on
            alternating hour bands so the eye groups each hour. */}
        {TIMES.map((_, i) => <div key={i} style={{ position: "absolute", left: i * SLOT_W, top: 0, bottom: 0, width: SLOT_W, pointerEvents: "none", backgroundColor: Math.floor(i / 2) % 2 === 1 ? "rgba(120,110,90,0.045)" : "transparent", borderRight: i % 2 === 1 ? "1px solid #CBC7BF" : "1px dotted #E9E7E2" }} />)}
        {/* Time-off band sits behind job chips (zIndex 0) */}
        {timeOffBg && (
          <div style={{ position: "absolute", left: getBandLeft(), width: getBandWidth(), top: 0, bottom: 0, backgroundColor: timeOffBg, zIndex: 0, pointerEvents: "none" }} />
        )}
        {nowLine >= 0 && nowLine <= TOTAL_SLOTS * SLOT_W && <div style={{ position: "absolute", left: nowLine, top: 0, bottom: 0, width: 2, backgroundColor: "#EF4444", zIndex: 3, pointerEvents: "none" }} />}
        {employee.jobs.map(j => <JobChip key={j.id} job={j} onClick={onChipClick} assignedName={employee.name} top={topById.get(j.id) ?? 10} />)}
        {employee.jobs.length === 0 && (
          // [2026-06-02] Was centered horizontally on a full-width row,
          // which made the label visually land around the 11:30–12:30
          // time column and read like "no techs working from 11:30–12:30"
          // when it actually meant "this whole row is empty all day."
          // Anchored to the left and rephrased so the row-scope is clear.
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", paddingLeft: 16 }}>
            <span style={{ fontSize: 11, color: "#D0CEC9", letterSpacing: "0.02em", fontStyle: "italic" }}>
              {employee.name.split(" ")[0]} has no jobs scheduled today
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DESKTOP: UNASSIGNED GANTT ROW ───────────────────────────────────────────
function UnassignedGanttRow({ jobs, onChipClick, nowLine }: { jobs: DispatchJob[]; onChipClick: (j: DispatchJob) => void; nowLine: number }) {
  if (jobs.length === 0) return null;
  // [overlap-stacking] Same packer the assigned rows use — the unassigned
  // lane is the most overlap-prone (fresh imports land here clustered).
  const { topById, rowHeight } = packLanes(jobs);
  return (
    <div style={{ display: "flex", borderBottom: "2px solid #FCD34D", height: rowHeight }}>
      <div style={{ position: "sticky", left: 0, zIndex: 5, width: COL_W, flexShrink: 0, backgroundColor: "#FFFBEB", borderRight: "1px solid #FCD34D", display: "flex", alignItems: "center", padding: "0 12px", gap: 9 }}>
        <div style={{ width: 32, height: 32, borderRadius: "50%", backgroundColor: "#FEF3C7", color: "#92400E", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, flexShrink: 0 }}>?</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#92400E" }}>Unassigned</div>
          <div style={{ fontSize: 10, color: "#D97706", marginTop: 1 }}>{jobs.length} job{jobs.length !== 1 ? "s" : ""} · needs assignment</div>
        </div>
      </div>
      <div style={{ position: "relative", width: TOTAL_SLOTS * SLOT_W, flexShrink: 0, height: rowHeight, backgroundColor: "#FFFBEB88" }}>
        {TIMES.map((_, i) => <div key={i} style={{ position: "absolute", left: i * SLOT_W, top: 0, bottom: 0, width: SLOT_W, pointerEvents: "none", backgroundColor: Math.floor(i / 2) % 2 === 1 ? "rgba(180,120,20,0.05)" : "transparent", borderRight: i % 2 === 1 ? "1px solid #F2CE73" : "1px dotted #FCEBB8" }} />)}
        {nowLine >= 0 && nowLine <= TOTAL_SLOTS * SLOT_W && <div style={{ position: "absolute", left: nowLine, top: 0, bottom: 0, width: 2, backgroundColor: "#EF4444", zIndex: 3, pointerEvents: "none" }} />}
        {jobs.map(j => <JobChip key={j.id} job={j} onClick={onChipClick} isUnassigned top={topById.get(j.id) ?? 10} />)}
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

// [job-card-redesign / followup] UnassignedChip removed — was dead
// code (defined but never referenced). The unassigned strip on the
// Gantt timeline renders <JobChip ... isUnassigned /> via
// UnassignedGanttRow above. Removing the legacy stub so future
// contributors don't accidentally edit the wrong component.

// ─── ATTENDANCE OVERLAY DRAWER (Cutover 3B) ─────────────────────────────────
//
// Right-side drawer the dispatch board's Attendance button opens. Lists
// pending proposals (late / short / no_show / missing_clockout) for the
// selected date. Per-row Confirm + Dismiss flows POST to the backend
// which writes through to employee_attendance_log + the unexcused
// hours ladder.
type AttendanceProposalRow = {
  id: number;
  user_id: number;
  job_id: number;
  scheduled_date: string;
  scheduled_time_minutes: number | null;
  estimated_hours: string | null;
  kind: "late" | "short" | "no_show" | "missing_clockout";
  status: "pending" | "confirmed" | "dismissed";
  minutes_late: number | null;
  minutes_short: number | null;
  leave_request_id: number | null;
  user_first_name: string | null;
  user_last_name: string | null;
  client_first_name: string | null;
  client_last_name: string | null;
  client_address: string | null;
  leave_start_date: string | null;
  leave_end_date: string | null;
  leave_type_display_name: string | null;
  proposed_attendance_type_default: "absent";
  proposed_unexcused_hours_default: number | null;
  display_label: string;
};

const ATTENDANCE_KIND_VISUALS: Record<
  AttendanceProposalRow["kind"],
  { swatch: string; border: string; label: string }
> = {
  late: { swatch: STATUS_VISUALS.late_clockin.borderOverride ?? "#DC2626", border: "#DC2626", label: "Late" },
  short: { swatch: "#F59E0B", border: "#F59E0B", label: "Short" },
  no_show: { swatch: STATUS_VISUALS.no_show.swatch, border: STATUS_VISUALS.no_show.borderOverride ?? "#991B1B", label: "No-show" },
  missing_clockout: { swatch: "#BA7517", border: "#BA7517", label: "Missing clock-out" },
};

function AttendanceOverlayDrawer({
  token,
  selectedDate,
  onClose,
}: {
  token: string;
  selectedDate: string;
  onClose: () => void;
}) {
  const _API_AOD = import.meta.env.BASE_URL.replace(/\/$/, "");
  const { toast } = useToast();
  const [proposals, setProposals] = useState<AttendanceProposalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [activePanel, setActivePanel] = useState<{ id: number; kind: "confirm" | "dismiss" } | null>(null);
  const [filterKind, setFilterKind] = useState<AttendanceProposalRow["kind"] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(
        `${_API_AOD}/api/attendance-overlay/proposals?status=pending&from_date=${selectedDate}&to_date=${selectedDate}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!r.ok) {
        toast({ title: "Could not load proposals", variant: "destructive" });
        setProposals([]);
        return;
      }
      const json = await r.json();
      setProposals((json?.data ?? []) as AttendanceProposalRow[]);
    } catch {
      toast({ title: "Could not load proposals", variant: "destructive" });
      setProposals([]);
    } finally {
      setLoading(false);
    }
  }, [_API_AOD, selectedDate, token, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runScan() {
    setScanning(true);
    try {
      const r = await fetch(`${_API_AOD}/api/attendance-overlay/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ from_date: selectedDate, to_date: selectedDate }),
      });
      if (!r.ok) {
        toast({ title: "Scan failed", variant: "destructive" });
        return;
      }
      const j = await r.json();
      toast({
        title: `Scan complete — ${j?.data?.new_proposals ?? 0} new proposal(s)`,
      });
      await load();
    } catch {
      toast({ title: "Scan failed", variant: "destructive" });
    } finally {
      setScanning(false);
    }
  }

  const visible = filterKind ? proposals.filter((p) => p.kind === filterKind) : proposals;
  const counts: Record<AttendanceProposalRow["kind"], number> = {
    late: 0,
    short: 0,
    no_show: 0,
    missing_clockout: 0,
  };
  for (const p of proposals) counts[p.kind] += 1;

  return (
    <>
      {/* Click-off overlay */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(10, 14, 26, 0.25)",
          zIndex: 49,
        }}
      />
      <aside
        role="dialog"
        aria-label="Attendance overlay drawer"
        style={{
          position: "fixed",
          right: 0,
          top: 0,
          bottom: 0,
          width: "min(560px, 100vw)",
          backgroundColor: "#FFFFFF",
          borderLeft: "1px solid #E5E2DC",
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          fontFamily: FF,
          color: "#1A1917",
        }}
      >
        {/* Header */}
        <header
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid #E5E2DC",
            backgroundColor: "#F7F6F3",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Attendance — {selectedDate}</div>
            <button
              onClick={onClose}
              style={{
                background: "transparent",
                border: "none",
                color: "#6B6860",
                fontSize: 18,
                cursor: "pointer",
                padding: "4px 8px",
                fontFamily: FF,
              }}
              aria-label="Close attendance drawer"
            >
              ×
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={runScan}
              disabled={scanning}
              style={{
                padding: "6px 12px",
                border: "1.5px solid #00C9A0",
                backgroundColor: scanning ? "#E5E2DC" : "#00C9A0",
                color: scanning ? "#6B6860" : "#0A0E1A",
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 700,
                cursor: scanning ? "not-allowed" : "pointer",
                fontFamily: FF,
              }}
            >
              {scanning ? "Scanning..." : "Run scan"}
            </button>
            <button
              onClick={load}
              style={{
                padding: "6px 12px",
                border: "1.5px solid #E5E2DC",
                backgroundColor: "#FAFAF9",
                color: "#1A1917",
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: FF,
              }}
            >
              Refresh
            </button>
          </div>
        </header>

        {/* Summary strip */}
        <div
          style={{
            padding: "10px 20px",
            borderBottom: "1px solid #E5E2DC",
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            fontSize: 12,
          }}
        >
          {(["late", "short", "no_show", "missing_clockout"] as const).map((k) => {
            const v = ATTENDANCE_KIND_VISUALS[k];
            const active = filterKind === k;
            return (
              <button
                key={k}
                onClick={() => setFilterKind(active ? null : k)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 10px",
                  borderRadius: 12,
                  border: `1px solid ${active ? v.border : "#E5E2DC"}`,
                  backgroundColor: active ? "#F7F6F3" : "#FFFFFF",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#1A1917",
                  fontFamily: FF,
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: v.swatch }} />
                {counts[k]} {v.label}
              </button>
            );
          })}
        </div>

        {/* List */}
        <div style={{ flex: 1, overflow: "auto", padding: "12px 20px" }}>
          {loading ? (
            <div style={{ padding: 30, color: "#6B6860", fontSize: 13 }}>Loading...</div>
          ) : visible.length === 0 ? (
            <div style={{ padding: 30, color: "#6B6860", fontSize: 13 }}>
              No pending proposals for this date. Try Run scan above.
            </div>
          ) : (
            visible.map((p) => (
              <AttendanceProposalCard
                key={p.id}
                proposal={p}
                isPanelOpen={activePanel?.id === p.id ? activePanel.kind : null}
                onOpenPanel={(kind) => setActivePanel({ id: p.id, kind })}
                onClosePanel={() => setActivePanel(null)}
                onConfirmed={() => {
                  setActivePanel(null);
                  setProposals((prev) => prev.filter((x) => x.id !== p.id));
                  toast({ title: "Confirmed — attendance log updated" });
                }}
                onDismissed={() => {
                  setActivePanel(null);
                  setProposals((prev) => prev.filter((x) => x.id !== p.id));
                  toast({ title: "Dismissed" });
                }}
                token={token}
              />
            ))
          )}
        </div>
      </aside>
    </>
  );
}

function AttendanceProposalCard({
  proposal,
  isPanelOpen,
  onOpenPanel,
  onClosePanel,
  onConfirmed,
  onDismissed,
  token,
}: {
  proposal: AttendanceProposalRow;
  isPanelOpen: "confirm" | "dismiss" | null;
  onOpenPanel: (kind: "confirm" | "dismiss") => void;
  onClosePanel: () => void;
  onConfirmed: () => void;
  onDismissed: () => void;
  token: string;
}) {
  const _API_AC = import.meta.env.BASE_URL.replace(/\/$/, "");
  const { toast } = useToast();
  const v = ATTENDANCE_KIND_VISUALS[proposal.kind];
  const techName = [proposal.user_first_name, proposal.user_last_name].filter(Boolean).join(" ") || `User #${proposal.user_id}`;
  const clientName = [proposal.client_first_name, proposal.client_last_name].filter(Boolean).join(" ") || `Job #${proposal.job_id}`;
  const requiresOverride = proposal.kind === "missing_clockout";

  const [overrideType, setOverrideType] = useState<"absent" | "tardy" | "ncns">(
    proposal.proposed_attendance_type_default,
  );
  const [overrideHours, setOverrideHours] = useState<string>(
    proposal.proposed_unexcused_hours_default != null
      ? String(proposal.proposed_unexcused_hours_default.toFixed(2))
      : "",
  );
  const [note, setNote] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function postConfirm() {
    if (requiresOverride && overrideHours.trim() === "") {
      toast({ title: "Missing clock-out requires hours override", variant: "destructive" });
      return;
    }
    const hoursNum = overrideHours.trim() === "" ? undefined : Number(overrideHours);
    setBusy(true);
    try {
      const r = await fetch(`${_API_AC}/api/attendance-overlay/proposals/${proposal.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          override_attendance_type: overrideType,
          override_hours: hoursNum,
          decision_note: note || undefined,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast({ title: j?.message ?? "Confirm failed", variant: "destructive" });
        return;
      }
      onConfirmed();
    } catch {
      toast({ title: "Confirm failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }
  async function postDismiss() {
    setBusy(true);
    try {
      const r = await fetch(`${_API_AC}/api/attendance-overlay/proposals/${proposal.id}/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ decision_note: note || undefined }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast({ title: j?.message ?? "Dismiss failed", variant: "destructive" });
        return;
      }
      onDismissed();
    } catch {
      toast({ title: "Dismiss failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: "relative",
        marginBottom: 12,
        padding: "12px 14px",
        backgroundColor: "#FFFFFF",
        border: `1px solid #E5E2DC`,
        borderLeft: `4px solid ${v.border}`,
        borderRadius: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", marginBottom: 2 }}>
            {techName}
          </div>
          <div style={{ fontSize: 12, color: "#6B6860" }}>
            {clientName}
            {proposal.client_address ? ` · ${proposal.client_address}` : ""}
          </div>
          <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 8px",
                backgroundColor: "#F7F6F3",
                border: `1px solid ${v.border}`,
                borderRadius: 10,
                fontSize: 11,
                fontWeight: 600,
                color: v.border,
              }}
            >
              {v.label}
            </span>
            <span style={{ fontSize: 12, color: "#1A1917" }}>{proposal.display_label}</span>
          </div>
          {proposal.leave_request_id != null && (
            <div style={{ marginTop: 6, fontSize: 11, color: "#6B6860" }}>
              Approved leave: {proposal.leave_type_display_name ?? "leave"}{" "}
              {proposal.leave_start_date}→{proposal.leave_end_date}
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
          <button
            onClick={() => (isPanelOpen === "confirm" ? onClosePanel() : onOpenPanel("confirm"))}
            style={{
              padding: "5px 10px",
              border: "1.5px solid #00C9A0",
              backgroundColor: isPanelOpen === "confirm" ? "#00C9A0" : "#FFFFFF",
              color: isPanelOpen === "confirm" ? "#0A0E1A" : "#1A1917",
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: FF,
            }}
          >
            Confirm
          </button>
          <button
            onClick={() => (isPanelOpen === "dismiss" ? onClosePanel() : onOpenPanel("dismiss"))}
            style={{
              padding: "5px 10px",
              border: "1.5px solid #E5E2DC",
              backgroundColor: "#FFFFFF",
              color: "#6B6860",
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: FF,
            }}
          >
            Dismiss
          </button>
        </div>
      </div>

      {isPanelOpen === "confirm" && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed #E5E2DC" }}>
          {requiresOverride && (
            <div style={{ marginBottom: 8, fontSize: 11, color: "#BA7517" }}>
              Resolve via 1C clock correction or set hours manually below.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: "#6B6860" }}>
              Type
              <select
                value={overrideType}
                onChange={(e) => setOverrideType(e.target.value as "absent" | "tardy" | "ncns")}
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 2,
                  padding: "6px 8px",
                  border: "1px solid #E5E2DC",
                  borderRadius: 6,
                  fontSize: 12,
                  fontFamily: FF,
                }}
              >
                <option value="absent">Absent</option>
                <option value="tardy">Tardy</option>
                <option value="ncns">NCNS</option>
              </select>
            </label>
            <label style={{ fontSize: 11, color: "#6B6860" }}>
              Hours{requiresOverride ? " (required)" : ""}
              <input
                type="number"
                step="0.25"
                min="0"
                value={overrideHours}
                onChange={(e) => setOverrideHours(e.target.value)}
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 2,
                  padding: "6px 8px",
                  border: "1px solid #E5E2DC",
                  borderRadius: 6,
                  fontSize: 12,
                  fontFamily: FF,
                }}
              />
            </label>
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Decision note (optional)"
            rows={2}
            style={{
              width: "100%",
              padding: "6px 8px",
              border: "1px solid #E5E2DC",
              borderRadius: 6,
              fontSize: 12,
              fontFamily: FF,
              resize: "vertical",
              marginBottom: 8,
            }}
          />
          <button
            onClick={postConfirm}
            disabled={busy}
            style={{
              padding: "6px 12px",
              border: "none",
              backgroundColor: busy ? "#E5E2DC" : "#00C9A0",
              color: busy ? "#6B6860" : "#0A0E1A",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 700,
              cursor: busy ? "not-allowed" : "pointer",
              fontFamily: FF,
            }}
          >
            {busy ? "Working..." : "Confirm & write"}
          </button>
        </div>
      )}

      {isPanelOpen === "dismiss" && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed #E5E2DC" }}>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Dismiss note (optional)"
            rows={2}
            style={{
              width: "100%",
              padding: "6px 8px",
              border: "1px solid #E5E2DC",
              borderRadius: 6,
              fontSize: 12,
              fontFamily: FF,
              resize: "vertical",
              marginBottom: 8,
            }}
          />
          <button
            onClick={postDismiss}
            disabled={busy}
            style={{
              padding: "6px 12px",
              border: "1.5px solid #E5E2DC",
              backgroundColor: busy ? "#E5E2DC" : "#FAFAF9",
              color: "#1A1917",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: busy ? "not-allowed" : "pointer",
              fontFamily: FF,
            }}
          >
            {busy ? "Working..." : "Confirm dismiss"}
          </button>
        </div>
      )}
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
  // [AI.7.5] Inject pulse keyframes once on mount; idempotent.
  useEffect(() => { ensureJobStatusStyles(); }, []);
  const [legendOpen, setLegendOpen] = useState(false);
  const legendBtnRef = useRef<HTMLButtonElement | null>(null);
  const [legendAnchor, setLegendAnchor] = useState<DOMRect | null>(null);
  // Mobile date picker — opened by tapping the date header.
  const [dateSheetOpen, setDateSheetOpen] = useState(false);
  // Read ?date=YYYY-MM-DD on mount so quote-builder's convert-to-job navigation
  // (which targets the scheduled day) actually lands on that day instead of today.
  const [selectedDate, setSelectedDate] = useState(() => {
    const param = new URLSearchParams(window.location.search).get("date");
    const m = param && /^\d{4}-\d{2}-\d{2}$/.test(param) ? param.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
    if (m) { const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])); d.setHours(0, 0, 0, 0); return d; }
    const d = new Date(); d.setHours(0, 0, 0, 0); return d;
  });
  // Keep ?date= in sync as the user navigates days — refresh + back-button preserve the view.
  useEffect(() => {
    const next = dateKey(selectedDate);
    const cur = new URLSearchParams(window.location.search).get("date");
    if (cur !== next) {
      const url = new URL(window.location.href);
      url.searchParams.set("date", next);
      window.history.replaceState(null, "", url.toString());
    }
  }, [selectedDate]);
  // Open the New Job wizard when arrived via the global "New → Job" menu
  // (?new=1). Keyed on wouter's reactive search string (not mount) so it fires
  // from EVERY screen — including when the user is already on the dispatch page
  // and the URL just gains ?new=1, which wouldn't remount this component.
  const routeSearch = useSearch();
  const [, navigate] = useLocation();
  useEffect(() => {
    // Read the live URL (routeSearch is only the reactive trigger) so we keep
    // any ?date= the date-sync effect just wrote.
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("new") === "1") {
      setShowWizard(true);
      // Strip ?new=1 via wouter's navigate (keeps wouter's reactive search in
      // sync, so clicking New → Job again re-fires) while preserving ?date=.
      sp.delete("new");
      const rest = sp.toString();
      navigate(`${window.location.pathname}${rest ? `?${rest}` : ""}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSearch]);
  const [data, setData] = useState<DispatchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedJob, setSelectedJob] = useState<DispatchJob | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [draggingJob, setDraggingJob] = useState<DispatchJob | null>(null);
  // [panel-resync 2026-06-18] Keep the open drawer in sync with refreshed board
  // data. After a reassign/edit, load() refetches `data` but selectedJob still
  // held the pre-save snapshot (old tech), so the drawer showed no change even
  // though it saved + the chip moved. Re-point selectedJob at the fresh row.
  useEffect(() => {
    if (!selectedJob || !data) return;
    const all: DispatchJob[] = [
      ...((data.employees ?? []).flatMap((e: any) => e.jobs ?? []) as DispatchJob[]),
      ...(((data as any).unassigned_jobs ?? []) as DispatchJob[]),
    ];
    const fresh = all.find(j => j.id === selectedJob.id);
    if (fresh) setSelectedJob(fresh);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [desktopView, setDesktopView] = useState<"timeline" | "list">("timeline");
  // Cutover 3B — Attendance overlay drawer state. Drawer surfaces
  // dispatch-tier proposals (late / short / no_show / missing_clockout)
  // for the selected date so the office can confirm or dismiss without
  // leaving the board. Office tier only — backend 403s tech, but we
  // also hide the button below for defensive UX.
  const [attendanceDrawerOpen, setAttendanceDrawerOpen] = useState(false);
  // Local userRole probe — same atob pattern used elsewhere in this
  // file (see JobPanel ~line 1009). Used to hide the Attendance
  // button for tech-tier users.
  const jobsPageUserRole: string = (() => {
    try {
      return JSON.parse(atob(token.split(".")[1])).role || "office";
    } catch {
      return "office";
    }
  })();
  const showAttendanceButton = jobsPageUserRole !== "technician";
  const [jobDates, setJobDates] = useState<Set<string>>(new Set());
  const refreshRef = useRef(0);
  const [zones, setZones] = useState<{ id: number; name: string; color: string; location?: string }[]>([]);
  const [selectedZoneFilter, setSelectedZoneFilter] = useState<number | null>(null);
  // [branch-filter 2026-06-17] Scope the zone dropdown + board to a branch
  // (Oak Lawn vs Schaumburg) via each zone's `location` tag from /api/zones.
  const [selectedBranchFilter, setSelectedBranchFilter] = useState<"all" | "oak_lawn" | "schaumburg">("all");
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const branchDropdownRef = useRef<HTMLDivElement>(null);
  // [dispatch tech sort 2026-06-10] Toggle "By time" (current — techs with
  // the earliest first job rise) vs "Static" (alphabetical A→Z, MaidCentral
  // parity). Persisted per office so the choice survives reloads.
  const [techSortMode, setTechSortMode] = useState<"by_time" | "static">(
    () => (typeof window !== "undefined" && window.localStorage.getItem("dispatchTechSort") === "static") ? "static" : "by_time"
  );
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("dispatchTechSort", techSortMode);
  }, [techSortMode]);
  const [zoneDropdownOpen, setZoneDropdownOpen] = useState(false);
  const zoneDropdownRef = useRef<HTMLDivElement>(null);
  // [combined-board 2026-06-17] The Oak Lawn/Schaumburg location tabs filtered
  // by jobs.booking_location, which most jobs don't carry — so any tab but
  // "All" hid every job ("jobs only under all"). Schaumburg is a separate
  // company anyway, so location is the company switcher's job now. Tabs removed.
  const [calendarOpen, setCalendarOpen] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);

  const [, forceUpdate] = useState(0);

  // [Z] Business-hours-anchored window (replaces X's padding-based auto-fit).
  // The day's default window comes from company.business_hours for the
  // selected date's weekday (PHES: Mon-Fri 9-6, Sat 9-12, Sun closed).
  // Sun (closed) and null-business_hours tenants fall back to 9-6.
  // The window EXTENDS ONLY if a job starts before open or ends after
  // close — extension is whole-hour floor/ceil, no padding. The window
  // NEVER SHRINKS below the default even if all jobs fit inside 10-3.
  const [businessHours, setBusinessHours] = useState<BusinessHoursMap>(new Map());

  // [AI.7] Mobile week-view state. Week summary fetches per-day aggregates
  // (count + revenue + unassigned) for the focal day's Sun..Sat week. Day
  // data cache lazy-loads any expanded non-focal day's full job list.
  type WeekSummaryDay = { date: string; job_count: number; revenue: number; unassigned_count: number };
  type WeekSummary = { from: string; to: string; days: WeekSummaryDay[]; total_jobs: number; total_revenue: number; total_unassigned: number };
  const [weekSummary, setWeekSummary] = useState<WeekSummary | null>(null);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [dayDataCache, setDayDataCache] = useState<Map<string, DispatchData>>(new Map());
  const [dayDataLoading, setDayDataLoading] = useState<Set<string>>(new Set());
  // [schedule-views 2026-06-05] Mobile focal-day view mode: Time list / By
  // Employee groups / Time-grid. Three selectable views so the office can try
  // each and keep whichever earns its place. Generic — applies to every tenant.
  const [mobileViewMode, setMobileViewMode] = useState<"time" | "team" | "grid">("time");

  const load = useCallback(async () => {
    const id = ++refreshRef.current;
    setLoading(true);
    try {
      const d = await fetchDispatch(dateKey(selectedDate), token, activeBranchId);
      if (id !== refreshRef.current) return;
      setData(d);
      // [cancel-ghost-job-diagnostics 2026-06-01] Expose the freshest
      // dispatch payload to window so the JobPanel cancelJob() handler can
      // snapshot it before+after a cancellation and surface any ghost job
      // that appears. No-op outside the cancel flow.
      try { (window as any).__qlenoDispatchSnapshot = d; } catch {}
      // Collect all dates with jobs for the calendar dots
      const allJobs = [...(d.unassigned_jobs || []), ...(d.employees || []).flatMap((e: Employee) => e.jobs)];
      setJobDates(prev => {
        const next = new Set(prev);
        allJobs.forEach((j: DispatchJob) => next.add(j.scheduled_date));
        return next;
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // [AI.7.5.hotfix2] Surface the real error so the user can paste it
      // back when the toast says nothing useful.
      console.error("[jobs.load] failed:", err);
      toast({ title: "Could not load schedule", description: detail, variant: "destructive" });
    }
    finally { setLoading(false); }
  }, [selectedDate, token, activeBranchId]);

  useEffect(() => { load(); }, [load]);

  // [AI.7] Fetch week summary for the Sun..Sat window containing selectedDate.
  // Mobile-only — week view doesn't render on desktop. Refetches when the
  // focal day crosses a week boundary, branch changes, or the underlying
  // jobs change (refreshRef).
  useEffect(() => {
    if (!isMobile) return;
    const dow = selectedDate.getDay();
    const weekStart = new Date(selectedDate);
    weekStart.setDate(selectedDate.getDate() - dow);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const fromStr = fmt(weekStart);
    const toStr = fmt(weekEnd);
    const branchParam = activeBranchId !== "all" ? `&branch_id=${activeBranchId}` : "";

    const API = import.meta.env.BASE_URL.replace(/\/$/, "");
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API}/api/dispatch/week-summary?from=${fromStr}&to=${toStr}${branchParam}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const d = await r.json();
        if (!cancelled) setWeekSummary(d);
      } catch {
        // Silent — bar chart just won't render. Doesn't block today's view.
      }
    })();
    return () => { cancelled = true; };
  }, [isMobile, selectedDate, token, activeBranchId]);

  // [AI.7] Lazy fetch a specific day's full job data when the operator
  // expands a non-focal day. Cached in dayDataCache by date key. Keeps
  // the week summary cheap and the focal day's render path fast.
  const loadDayData = useCallback(async (dateK: string) => {
    if (dayDataCache.has(dateK)) return;
    if (dayDataLoading.has(dateK)) return;
    setDayDataLoading(prev => { const n = new Set(prev); n.add(dateK); return n; });
    try {
      const fetched = await fetchDispatch(dateK, token, activeBranchId);
      setDayDataCache(prev => { const n = new Map(prev); n.set(dateK, fetched); return n; });
    } catch {
      // ignore — collapsed-day expansion shows an inline "Could not load" state
    } finally {
      setDayDataLoading(prev => { const n = new Set(prev); n.delete(dateK); return n; });
    }
  }, [dayDataCache, dayDataLoading, token, activeBranchId]);

  // [Z] Load company business_hours once on mount. Used below to drive the
  // per-day Gantt window with extend-on-outlier behavior.
  useEffect(() => {
    const _API = import.meta.env.BASE_URL.replace(/\/$/, "");
    fetch(`${_API}/api/companies/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(c => {
        if (c?.business_hours) setBusinessHours(parseBusinessHours(c.business_hours));
      })
      .catch(() => {});
  }, [token]);

  // [Z] Compute the Gantt window for the selected date:
  //   1. Default = company business_hours for that weekday
  //      (fallback to 9am–6pm when closed/null/unparseable)
  //   2. Extend start to floor(earliest job start) if any job starts
  //      before default open. Whole-hour, no padding.
  //   3. Extend end to ceil(latest job end) if any job ends after
  //      default close. Whole-hour, no padding.
  //   4. NEVER shrinks below the default.
  // Jobs with null scheduled_time are excluded from the min/max reduction
  // (they still render; the old "return DAY_START for null" fallback in
  // timeToMins places them at the Gantt's left edge — future work may add
  // a "Not scheduled" row).
  useEffect(() => {
    const DEFAULT_START = 9 * 60;
    const DEFAULT_END = 18 * 60;

    const dow = selectedDate.getDay();
    const biz = businessHours.get(dow);
    let windowStart = DEFAULT_START;
    let windowEnd = DEFAULT_END;
    if (biz && biz !== "closed") {
      windowStart = biz.startMin;
      windowEnd = biz.endMin;
    }
    // For "closed" days (e.g. Sunday) or when business_hours is missing,
    // fall back to 9-6 full day so overtime work still renders.

    if (data) {
      const allJobs: DispatchJob[] = [
        ...(data.unassigned_jobs ?? []),
        ...((data.employees ?? []).flatMap(e => e.jobs ?? [])),
      ];
      for (const j of allJobs) {
        if (!j.scheduled_time) continue; // exclude null times from min/max
        const t = timeToMins(j.scheduled_time);
        const end = t + (j.duration_minutes || 0);
        if (t < windowStart) windowStart = Math.floor(t / 60) * 60;
        if (end > windowEnd) windowEnd = Math.ceil(end / 60) * 60;
      }
    }

    if (DAY_START !== windowStart || DAY_END !== windowEnd) {
      DAY_START = windowStart;
      DAY_END = windowEnd;
      refreshTimeline();
      forceUpdate(n => n + 1);
    }
  }, [data, businessHours, selectedDate]);

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

  // Close branch dropdown on outside click
  useEffect(() => {
    if (!branchDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setBranchDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [branchDropdownOpen]);

  // Now-line calculation
  const nowLine = (() => {
    const now = new Date();
    if (dateKey(now) !== dateKey(selectedDate)) return -1;
    const mins = now.getHours() * 60 + now.getMinutes();
    return ((mins - DAY_START) / 30) * SLOT_W;
  })();

  // DnD
  // [drag-drop touch fix 2026-06-11] A single PointerSensor with a distance
  // constraint never starts a drag on touch — the browser claims the gesture as
  // a scroll first, so the dispatch board's drag-to-assign did nothing on a
  // phone/tablet ("can't drag and drop"). Split into MouseSensor (desktop, 6px)
  // + TouchSensor (press-and-hold ~180ms then drag; a quick swipe still scrolls).
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );
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
    // [reassign-fix 2026-06-15] A tech change on drag must go through
    // /reassign-tech (swaps the primary AND syncs job_technicians), NOT the
    // PUT path — PUT only writes assigned_user_id, leaving the old tech's
    // job_technicians row behind so the board showed both. PUT here only
    // carries the time.
    const techChanged = Number.isFinite(empId) && empId !== job.assigned_user_id;
    if (techChanged) {
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
    try {
      if (techChanged) {
        const API = import.meta.env.BASE_URL.replace(/\/$/, "");
        const r = await fetch(`${API}/api/jobs/${job.id}/reassign-tech`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ new_tech_id: empId }),
        });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || "Reassign failed"); }
      }
      await patchJob(job.id, patch, token);
    }
    catch (e) { toast({ title: "Failed to update job", description: (e as Error).message, variant: "destructive" }); load(); }
  }
  function chipLeft(job: DispatchJob) { return ((timeToMins(job.scheduled_time) - DAY_START) / 30) * SLOT_W; }

  // [zone-branch-grouping 2026-06-20] Zone dropdown options scoped to the
  // selected branch. With a branch chosen, only that branch's zones show. With
  // "All Branches", zones are grouped under Oak Lawn / Schaumburg headers (and
  // an "Other" group for any zone not yet mapped to a branch) so the two
  // locations aren't mashed into one flat list.
  const zoneGroups = (() => {
    const visible = zones.filter(z => selectedBranchFilter === "all" || z.location === selectedBranchFilter);
    if (selectedBranchFilter !== "all") return [{ label: null as string | null, zones: visible }];
    const oak = visible.filter(z => z.location === "oak_lawn");
    const sch = visible.filter(z => z.location === "schaumburg");
    const other = visible.filter(z => z.location !== "oak_lawn" && z.location !== "schaumburg");
    const groups: { label: string | null; zones: typeof zones }[] = [];
    if (oak.length) groups.push({ label: "Oak Lawn", zones: oak });
    if (sch.length) groups.push({ label: "Schaumburg", zones: sch });
    if (other.length) groups.push({ label: groups.length ? "Other" : null, zones: other });
    return groups;
  })();

  // Zone + location filtered dispatch data
  // Zone ids belonging to the selected branch (null = no branch filter).
  const branchZoneIds = selectedBranchFilter === "all"
    ? null
    : new Set(zones.filter(z => z.location === selectedBranchFilter).map(z => z.id));
  const passesBranch = (zoneId: number | null | undefined) =>
    !branchZoneIds || (zoneId != null && branchZoneIds.has(zoneId));
  const filteredData = data ? {
    employees: data.employees.map(e => ({
      ...e,
      jobs: e.jobs.filter(j => {
        if (selectedZoneFilter !== null && j.zone_id !== selectedZoneFilter) return false;
        if (!passesBranch(j.zone_id)) return false;
        return true;
      }),
    })),
    unassigned_jobs: data.unassigned_jobs.filter(j => {
      if (selectedZoneFilter !== null && j.zone_id !== selectedZoneFilter) return false;
      if (!passesBranch(j.zone_id)) return false;
      return true;
    }),
  } : null;

  // [BUG-3F2 follow-up / 2026-06-02] Dedupe by job.id BEFORE rolling up day
  // counts. The multi-tech fan-out (PR #232) pushes each job onto every
  // assigned tech's row so team members can see their work, which means
  // employees[].jobs[] now contains duplicates by design. The KPI strip
  // counters (JOBS TODAY / REVENUE TODAY) and any "day total" math must
  // see unique jobs only, otherwise a shared job inflates the day total
  // by the number of techs on it (Sal's 06-01 regression: 14 jobs / $4369
  // rendered as 15 / $5338 because 5656 and 5657 each had 2 techs).
  // Per-row badge math is OK to keep duplicates because each row only
  // reduces over its own jobs[]; it's the cross-employee flatten that
  // needs the dedupe.
  const allJobs = filteredData ? (() => {
    const flat = [
      ...filteredData.unassigned_jobs,
      ...filteredData.employees.flatMap(e => e.jobs.map(j => ({ ...j, assigned_user_name: e.name }))),
    ];
    const seen = new Set<number>();
    const out: DispatchJob[] = [];
    for (const j of flat) {
      if (seen.has(j.id)) continue;
      seen.add(j.id);
      out.push(j);
    }
    return out.sort((a, b) => timeToMins(a.scheduled_time) - timeToMins(b.scheduled_time));
  })() : [];

  const stats = {
    // [count-rule 2026-06-08] Every job on the board counts EXCEPT office
    // events / meetings (job_kind). $0 jobs are real jobs and still count.
    total: allJobs.filter(j => (j as any).job_kind !== "office_event" && (j as any).job_kind !== "meeting").length,
    complete: allJobs.filter(j => j.status === "complete").length,
    inProgress: allJobs.filter(j => j.status === "in_progress").length,
    revenue: allJobs.reduce((s, j) => s + (j.amount || 0), 0),
    unassigned: data?.unassigned_jobs.length || 0,
  };

  const dayLabel = selectedDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const isToday = dateKey(selectedDate) === dateKey(new Date());

  // ── MOBILE VIEW (AI.7 — risk-first dashboard) ───────────────────────────────
  if (isMobile) {
    // Compute "needs attention" surface from currently-loaded day data.
    // Only renders for the focal day — other days surface their own risk
    // counts when expanded.
    const NOW_MS = Date.now();
    const NOW_MINS = (() => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); })();
    // [phes-lifecycle 2026-04-29] Late = 20+ min past start, no clock-in,
    // no manual no-show flag. Mirrors getJobVisualStatus's late_clockin
    // derivation so the Needs Attention counter and the chip ring agree.
    // The William Rosenbloom bug (counter said late before scheduled
    // start) is closed by the strict `NOW_MINS >= start + 20` check.
    const LATE_THRESHOLD_MIN_UI = 20;
    const lateClockIns = LIVE_OPS && isToday && data ? data.employees.flatMap(e =>
      e.jobs.filter(j => {
        if (j.status === "cancelled" || j.status === "complete") return false;
        if (j.clock_entry?.clock_in_at) return false;
        if (j.no_show_marked_by_tech) return false;
        const startMins = timeToMins(j.scheduled_time);
        if (startMins <= 0) return false;
        return NOW_MINS >= startMins + LATE_THRESHOLD_MIN_UI;
      }).map(j => ({ job: j, tech_name: e.name }))
    ) : [];
    const unassignedToday = data?.unassigned_jobs ?? [];
    const missingAddress = isToday && data ? data.employees.flatMap(e =>
      e.jobs.filter(j =>
        j.status !== "cancelled" && j.status !== "complete" &&
        (!j.address || j.address.trim().length === 0)
      )
    ) : [];
    // [AI.7.2] Missing-zone surfacing. Every job MUST be in a service zone
    // — a job without one means a zip didn't map (zone seed gap) or the
    // client has no zip at all (intake gap). Either way, block the
    // dispatcher's view of "all green" until it's fixed.
    const missingZone = isToday && data ? [
      ...data.employees.flatMap(e => e.jobs),
      ...(data.unassigned_jobs ?? []),
    ].filter(j =>
      j.status !== "cancelled" && j.status !== "complete" &&
      (!j.zone_name || !j.zone_color)
    ) : [];
    const attentionCount = lateClockIns.length
      + (unassignedToday.length > 0 ? 1 : 0)
      + (missingAddress.length > 0 ? 1 : 0)
      + (missingZone.length > 0 ? 1 : 0);

    // Sort week days for "Upcoming" section: focal day's date first (rendered
    // separately), then other days ordered by date with future first.
    const focalKey = dateKey(selectedDate);
    const weekDays = weekSummary?.days ?? [];
    const todayKey = dateKey(new Date());
    const upcomingDays = weekDays
      .filter(d => d.date !== focalKey)
      .sort((a, b) => {
        // Future days ascending, past days descending after futures
        const aFuture = a.date >= todayKey;
        const bFuture = b.date >= todayKey;
        if (aFuture !== bFuture) return aFuture ? -1 : 1;
        return aFuture ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
      });

    const maxRevenue = Math.max(1, ...weekDays.map(d => d.revenue));
    const dayShortName = (dateStr: string) => {
      const d = new Date(dateStr + "T00:00:00");
      return d.toLocaleDateString("en-US", { weekday: "short" });
    };
    const dayDateNum = (dateStr: string) => {
      const d = new Date(dateStr + "T00:00:00");
      return d.getDate();
    };
    const formatRev = (n: number) => n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`;

    return (
      <DashboardLayout>
        {/* Negative margins cancel DashboardLayout's main padding so sections go edge-to-edge */}
        <div style={{ margin: "-16px -14px 0", fontFamily: FF }}>
          {/* Header — date + new job */}
          <div style={{ backgroundColor: "#FFFFFF", borderBottom: "1px solid #EEECE7", padding: "12px 16px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#1A1917" }}>Jobs</div>
              <button
                onClick={() => setShowWizard(true)}
                title=""
                style={{ display: "flex", alignItems: "center", gap: 6, backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: 1 }}>
                <Plus size={14} /> New Job
                <kbd style={{ fontSize: 10, border: '1px solid rgba(255,255,255,0.45)', borderRadius: 3, padding: '1px 5px', color: 'rgba(255,255,255,0.8)', fontFamily: 'inherit' }}>⇧J</kbd>
              </button>
            </div>
            {/* Date navigation */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <button onClick={() => setSelectedDate(d => addDays(d, -1))} style={{ border: "none", background: "#F7F6F3", borderRadius: 8, padding: "6px 10px", cursor: "pointer", color: "#6B7280" }}><ChevronLeft size={16} /></button>
              {/* Tap the date label to open the month picker — saves
                  chevron-stepping a day at a time. */}
              <button
                onClick={() => setDateSheetOpen(true)}
                aria-label="Pick a date"
                style={{ textAlign: "center", border: "none", background: "transparent", padding: "4px 8px", borderRadius: 8, cursor: "pointer", fontFamily: FF }}
              >
                <div style={{ fontSize: 15, fontWeight: 800, color: "#1A1917" }}>
                  {isToday ? "Today" : selectedDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                </div>
                {isToday && <div style={{ fontSize: 11, color: "#9E9B94" }}>{selectedDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>}
              </button>
              <button onClick={() => setSelectedDate(d => addDays(d, 1))} style={{ border: "none", background: "#F7F6F3", borderRadius: 8, padding: "6px 10px", cursor: "pointer", color: "#6B7280" }}><ChevronRight size={16} /></button>
            </div>
          </div>

          {/* [AI.7] WEEK SUMMARY CARD — sticky on scroll. Total revenue + jobs +
              7-day bar chart with day labels and dollar subtotals. Tap any
              bar to jump the focal day. */}
          {weekSummary && (
            <div style={{
              position: "sticky", top: 0, zIndex: 10,
              backgroundColor: "#FFFFFF", borderBottom: "1px solid #EEECE7",
              padding: "12px 16px 14px",
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>
                This week · {(() => {
                  const f = new Date(weekSummary.from + "T00:00:00");
                  const t = new Date(weekSummary.to + "T00:00:00");
                  const fStr = f.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                  const tStr = t.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                  return `${fStr} – ${tStr}`;
                })()}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#1A1917" }}>
                  ${weekSummary.total_revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </div>
                <div style={{ fontSize: 12, color: "#6B6860", fontWeight: 600 }}>
                  · {weekSummary.total_jobs} jobs
                  {weekSummary.total_unassigned > 0 && (
                    <span style={{ color: "#DC2626", marginLeft: 6 }}>· {weekSummary.total_unassigned} unassigned</span>
                  )}
                </div>
              </div>
              {/* 7-bar chart */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6, alignItems: "end", height: 56 }}>
                {weekSummary.days.map(d => {
                  const isFocal = d.date === focalKey;
                  const isTodayBar = d.date === todayKey;
                  const ratio = d.revenue > 0 ? Math.max(0.08, d.revenue / maxRevenue) : 0;
                  const barColor = isFocal ? "var(--brand)" : isTodayBar ? "rgba(91,155,213,0.4)" : "#E5E2DC";
                  return (
                    <button key={d.date}
                      onClick={() => setSelectedDate(new Date(d.date + "T00:00:00"))}
                      style={{
                        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end",
                        background: "none", border: "none", padding: 0, cursor: "pointer", height: "100%",
                      }}>
                      <div style={{ width: "100%", height: `${ratio * 100}%`, backgroundColor: barColor, borderRadius: "3px 3px 0 0", transition: "background 0.15s" }} />
                    </button>
                  );
                })}
              </div>
              {/* Day labels + revenue subtotals under bars */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6, marginTop: 6 }}>
                {weekSummary.days.map(d => {
                  const isFocal = d.date === focalKey;
                  return (
                    <button key={d.date}
                      onClick={() => setSelectedDate(new Date(d.date + "T00:00:00"))}
                      style={{
                        display: "flex", flexDirection: "column", alignItems: "center",
                        background: "none", border: "none", padding: 0, cursor: "pointer",
                      }}>
                      <span style={{ fontSize: 9, fontWeight: 700, color: isFocal ? "var(--brand)" : "#9E9B94", textTransform: "uppercase" }}>
                        {dayShortName(d.date).slice(0, 1)}
                      </span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: isFocal ? "var(--brand)" : d.revenue > 0 ? "#6B6860" : "#C4C0BB", marginTop: 1 }}>
                        {d.revenue > 0 ? formatRev(d.revenue) : "—"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* [AI.7] NEEDS ATTENTION — only renders when items exist for today.
              Tappable rows deep-link to the job/dispatch action. */}
          {isToday && attentionCount > 0 && (
            <div style={{ backgroundColor: "#FEF3C7", borderBottom: "1px solid #FCD34D", padding: "10px 16px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#92400E", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
                Needs Attention ({attentionCount})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {lateClockIns.map(({ job, tech_name }) => {
                  // [AI.7.3] Zone color dot on late rows so an operator
                  // triaging the alert knows which area before tapping in.
                  const hasZoneL = !!job.zone_name && !!job.zone_color;
                  return (
                    <button key={`late-${job.id}`} onClick={() => setSelectedJob(job)}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, border: "none", background: "rgba(255,255,255,0.6)", cursor: "pointer", textAlign: "left", fontFamily: FF, width: "100%" }}>
                      <Clock size={14} color="#DC2626" />
                      {hasZoneL && (
                        <span style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: job.zone_color!, flexShrink: 0 }} title={job.zone_name!} />
                      )}
                      <span style={{ fontSize: 12, color: "#1A1917", fontWeight: 600, flex: 1 }}>
                        {tech_name} · {job.display_name ?? job.client_name} — late {Math.max(0, NOW_MINS - timeToMins(job.scheduled_time))}m
                      </span>
                      <ChevronRight size={12} color="#6B6860" />
                    </button>
                  );
                })}
                {unassignedToday.length > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, background: "rgba(255,255,255,0.6)" }}>
                    <AlertTriangle size={14} color="#D97706" />
                    <span style={{ fontSize: 12, color: "#1A1917", fontWeight: 600 }}>
                      {unassignedToday.length} job{unassignedToday.length !== 1 ? "s" : ""} unassigned today
                    </span>
                  </div>
                )}
                {missingAddress.length > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, background: "rgba(255,255,255,0.6)" }}>
                    <AlertTriangle size={14} color="#DC2626" />
                    <span style={{ fontSize: 12, color: "#1A1917", fontWeight: 600 }}>
                      {missingAddress.length} job{missingAddress.length !== 1 ? "s" : ""} missing address
                    </span>
                  </div>
                )}
                {missingZone.length > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, background: "rgba(255,255,255,0.6)" }}>
                    <AlertTriangle size={14} color="#DC2626" />
                    <span style={{ fontSize: 12, color: "#1A1917", fontWeight: 600 }}>
                      {missingZone.length} job{missingZone.length !== 1 ? "s" : ""} missing zone — fix client zip
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Zone filter — mobile */}
          <div style={{ backgroundColor: "#FFFFFF", borderBottom: "1px solid #EEECE7", padding: "6px 14px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
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
                    {zoneGroups.map((g, gi) => (
                      <div key={gi}>
                        {g.label && <div style={{ padding: "6px 12px 3px", fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9E9B94", backgroundColor: "#FAFAF9", borderTop: gi > 0 ? "1px solid #F0EEE9" : "none" }}>{g.label}</div>}
                        {g.zones.map(z => (
                          <button key={z.id} onClick={() => { setSelectedZoneFilter(z.id); setZoneDropdownOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "8px 12px", border: "none", backgroundColor: selectedZoneFilter === z.id ? `${z.color}18` : "transparent", color: selectedZoneFilter === z.id ? z.color : "#1A1917", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                            <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: z.color, flexShrink: 0 }} />
                            {z.name}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* [AI.7.5] Mobile Legend button — opens bottom-sheet popover. */}
            <button
              onClick={() => setLegendOpen(o => !o)}
              style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 6, border: "1.5px solid #E5E2DC", backgroundColor: "#FAFAF9", color: "#6B7280", cursor: "pointer", fontFamily: FF, marginLeft: "auto" }}
              title="Show status legend"
            >
              <Info size={11} />
              Legend
            </button>
          </div>

          {/* [schedule-views 2026-06-05] Focal-day VIEW SWITCHER — Time list /
              By Employee / Time-grid. Affects only the focal-day section below;
              the week summary, risk strip, and Upcoming list are shared chrome. */}
          <div style={{ backgroundColor: "#FFFFFF", borderBottom: "1px solid #EEECE7", padding: "8px 14px" }}>
            <div style={{ display: "flex", background: "#F1EFEA", borderRadius: 9, padding: 3, gap: 3 }}>
              {([["time", "Time"], ["team", "Team"], ["grid", "Grid"]] as const).map(([val, label]) => (
                <button key={val} onClick={() => setMobileViewMode(val)} style={{
                  flex: 1, textAlign: "center", border: "none", cursor: "pointer", fontFamily: FF,
                  fontSize: 12, fontWeight: 700, padding: "7px 0", borderRadius: 7,
                  backgroundColor: mobileViewMode === val ? "#FFFFFF" : "transparent",
                  color: mobileViewMode === val ? "#1A1917" : "#6B7280",
                  boxShadow: mobileViewMode === val ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                  transition: "background 0.15s",
                }}>{label}</button>
              ))}
            </div>
          </div>

          {/* [AI.7] FOCAL DAY (TODAY) — full job cards. Heading carries the
              day's job count + revenue so the operator orients without
              cross-checking the bar chart above. */}
          <div style={{ padding: "12px 14px 4px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, padding: "0 2px" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: "#1A1917", letterSpacing: "0.07em", textTransform: "uppercase" }}>
                  {isToday ? "Today" : selectedDate.toLocaleDateString("en-US", { weekday: "long" })}
                </span>
                <span style={{ fontSize: 11, color: "#9E9B94", fontWeight: 600 }}>
                  {selectedDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
              </div>
              <div style={{ fontSize: 11, color: "#6B6860", fontWeight: 700 }}>
                {allJobs.length} {allJobs.length !== 1 ? "jobs" : "job"}
                {(() => {
                  const focalDay = weekDays.find(d => d.date === focalKey);
                  return focalDay && focalDay.revenue > 0 ? <span> · {formatRev(focalDay.revenue)}</span> : null;
                })()}
              </div>
            </div>
            {loading && !data ? (
              <div style={{ textAlign: "center", padding: 32, color: "#9E9B94", fontSize: 13 }}>Loading...</div>
            ) : allJobs.length === 0 ? (
              <div style={{ textAlign: "center", padding: 32 }}>
                <Calendar size={32} style={{ color: "#D0CEC9", marginBottom: 10 }} />
                <div style={{ fontSize: 14, fontWeight: 700, color: "#6B7280", marginBottom: 4 }}>No jobs {isToday ? "today" : "this day"}{selectedZoneFilter !== null ? " in this zone" : ""}</div>
                <div style={{ fontSize: 12, color: "#9E9B94" }}>Tap "+ New Job" to schedule one</div>
              </div>
            ) : mobileViewMode === "grid" ? (
              <MobileTimeGrid jobs={allJobs} onJobClick={setSelectedJob} />
            ) : mobileViewMode === "team" ? (
              /* [schedule-views] BY EMPLOYEE — group the focal day's jobs under
                 each assigned tech (Unassigned floats to the top so nothing
                 hides). Header shows the tech, their job count, and total job
                 hours. Cards keep their zone color so they still match desktop. */
              (() => {
                const groups = new Map<string, DispatchJob[]>();
                for (const j of allJobs) {
                  const key = j.assigned_user_name || "Unassigned";
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key)!.push(j);
                }
                const ordered = [...groups.entries()].sort((a, b) => {
                  if (a[0] === "Unassigned") return -1;
                  if (b[0] === "Unassigned") return 1;
                  return a[0].localeCompare(b[0]);
                });
                return ordered.map(([name, jobs]) => {
                  const mins = jobs.reduce((s, j) => s + (j.duration_minutes || 0), 0);
                  const hrs = mins % 60 === 0 ? String(mins / 60) : (mins / 60).toFixed(1);
                  const isUn = name === "Unassigned";
                  return (
                    <div key={name} style={{ marginBottom: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 9, margin: "12px 2px 8px" }}>
                        <div style={{ width: 26, height: 26, borderRadius: "50%", flexShrink: 0, color: "#fff", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: isUn ? "#9CA3AF" : techAvatarColor(name) }}>
                          {isUn ? "?" : techInitials(name)}
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: isUn ? "#B45309" : "#1A1917", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                        <div style={{ fontSize: 11, color: "#9E9B94", fontWeight: 600, flexShrink: 0 }}>{jobs.length} {jobs.length !== 1 ? "jobs" : "job"} · {hrs}h</div>
                      </div>
                      {jobs.map(j => <MobileJobCard key={j.id} job={j} onClick={() => setSelectedJob(j)} />)}
                    </div>
                  );
                });
              })()
            ) : (
              <>
                {allJobs.map(j => <MobileJobCard key={j.id} job={j} onClick={() => setSelectedJob(j)} />)}
              </>
            )}
          </div>

          {/* [AI.7] UPCOMING — collapsed by default, sub-totals visible.
              Tapping a row lazily fetches that day's full data via
              loadDayData() and renders compact 36px rows. Day-level
              unassigned-count badges surface risk before expansion. */}
          {upcomingDays.length > 0 && (
            <div style={{ padding: "0 14px 16px" }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#1A1917", letterSpacing: "0.07em", textTransform: "uppercase", padding: "16px 2px 8px" }}>
                Upcoming
              </div>
              <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, overflow: "hidden" }}>
                {upcomingDays.map((d, idx) => {
                  const isOpen = expandedDays.has(d.date);
                  const dayData = dayDataCache.get(d.date);
                  const isLoadingDay = dayDataLoading.has(d.date);
                  const dayJobs = dayData ? [
                    ...dayData.employees.flatMap(e => e.jobs.map(j => ({ job: j, tech: e.name }))),
                    ...dayData.unassigned_jobs.map(j => ({ job: j, tech: undefined as string | undefined }))
                  ].sort((a, b) => (a.job.scheduled_time || "").localeCompare(b.job.scheduled_time || "")) : [];
                  return (
                    <div key={d.date} style={{ borderTop: idx === 0 ? "none" : "1px solid #F0EEE9" }}>
                      <button
                        onClick={() => {
                          setExpandedDays(prev => {
                            const n = new Set(prev);
                            if (n.has(d.date)) n.delete(d.date);
                            else { n.add(d.date); loadDayData(d.date); }
                            return n;
                          });
                        }}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          width: "100%", padding: "12px 14px", border: "none", background: "transparent",
                          cursor: "pointer", fontFamily: FF, textAlign: "left", minHeight: 44,
                        }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <ChevronRight size={14} color="#9E9B94" style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} />
                          <span style={{ fontSize: 12, fontWeight: 800, color: "#1A1917", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            {dayShortName(d.date)}
                          </span>
                          <span style={{ fontSize: 11, color: "#9E9B94", fontWeight: 600 }}>
                            {new Date(d.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                          </span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#6B6860", fontWeight: 700 }}>
                          {d.unassigned_count > 0 && (
                            <span style={{ fontSize: 10, fontWeight: 800, color: "#991B1B", background: "#FEE2E2", padding: "2px 6px", borderRadius: 4 }}>
                              {d.unassigned_count} unass
                            </span>
                          )}
                          <span>{d.job_count} {d.job_count !== 1 ? "jobs" : "job"}</span>
                          {d.revenue > 0 && <span style={{ color: "#1A1917" }}>· {formatRev(d.revenue)}</span>}
                        </div>
                      </button>
                      {isOpen && (
                        <div style={{ borderTop: "1px solid #F0EEE9", backgroundColor: "#FAFAF9" }}>
                          {isLoadingDay && !dayData ? (
                            <div style={{ padding: 14, textAlign: "center", fontSize: 12, color: "#9E9B94" }}>Loading...</div>
                          ) : !dayData ? (
                            <div style={{ padding: 14, textAlign: "center", fontSize: 12, color: "#9E9B94" }}>Could not load</div>
                          ) : dayJobs.length === 0 ? (
                            <div style={{ padding: 14, textAlign: "center", fontSize: 12, color: "#9E9B94" }}>No jobs scheduled</div>
                          ) : (
                            dayJobs.map(({ job: j, tech }, jIdx) => {
                              const sc = STATUS[j.status] || STATUS.scheduled;
                              // [AI.7.2] Zone indicator on every compact row.
                              // Missing zone renders as a red AlertTriangle
                              // marker — never a silent gray dot. Operators
                              // need to see the data gap, not paper over it.
                              const hasZoneRow = !!j.zone_name && !!j.zone_color;
                              // [AI.7.5] Status routing: amber stripe replaces
                              // status bar for active; checkmark/no-show for
                              // completed/no-show; row opacity for cancelled.
                              const visualRow = STATUS_VISUALS[getJobVisualStatus(j)];
                              const stripeColor = visualRow.stripe ?? (visualRow.borderOverride ?? sc.dot);
                              return (
                                <button key={j.id} onClick={() => setSelectedJob(j)}
                                  title={hasZoneRow ? j.zone_name! : (j.client_zip ? `Unmapped zip ${j.client_zip}` : "Zone missing")}
                                  style={{
                                    display: "flex", alignItems: "center", gap: 8, width: "100%",
                                    padding: "9px 14px", border: "none", background: "transparent",
                                    cursor: "pointer", fontFamily: FF, textAlign: "left", minHeight: 44,
                                    borderTop: jIdx === 0 ? "none" : "1px solid #F0EEE9",
                                    opacity: visualRow.bodyOpacity,
                                    filter: visualRow.desaturate ? "grayscale(1)" : "none",
                                  }}>
                                  <div className={visualRow.stripe ? "qleno-active-stripe" : undefined}
                                    style={{ width: 3, height: 22, borderRadius: 2, backgroundColor: stripeColor, flexShrink: 0 }} />
                                  {hasZoneRow ? (
                                    <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: j.zone_color!, flexShrink: 0 }} />
                                  ) : (
                                    <AlertTriangle size={10} color="#DC2626" style={{ flexShrink: 0 }} />
                                  )}
                                  <span style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", width: 56, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                                    {j.scheduled_time ? fmtTime(j.scheduled_time) : "—"}
                                  </span>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: visualRow.strikethrough ? "line-through" : "none" }}>
                                      {j.client_name}
                                    </div>
                                    {tech ? (
                                      <div style={{ fontSize: 10, color: "#9E9B94", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                        {tech}
                                      </div>
                                    ) : (
                                      <div style={{ fontSize: 10, color: "#DC2626", fontWeight: 700 }}>Unassigned</div>
                                    )}
                                  </div>
                                  {visualRow.showCheckmark && (
                                    <Check size={12} color="#16A34A" strokeWidth={3} style={{ flexShrink: 0 }} />
                                  )}
                                  {visualRow.showNoShowBadge && (
                                    <span style={{ fontSize: 8, fontWeight: 800, color: "#FFFFFF", backgroundColor: "#991B1B", padding: "2px 5px", borderRadius: 3, letterSpacing: "0.05em", flexShrink: 0 }}>
                                      NO SHOW
                                    </span>
                                  )}
                                  <span style={{ fontSize: 12, fontWeight: 800, color: "#1A1917", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                                    ${(j.billed_amount ?? j.amount ?? 0).toFixed(0)}
                                  </span>
                                </button>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {selectedJob && (
          <JobPanel job={selectedJob} employees={data?.employees || []} onClose={() => setSelectedJob(null)} onUpdate={load} mobile />
        )}
        <JobWizard open={showWizard} onClose={() => setShowWizard(false)} onCreated={() => { setShowWizard(false); load(); }} />
        <LegendPopover open={legendOpen} onClose={() => setLegendOpen(false)} mobile={isMobile} anchorRect={legendAnchor} />
        <MobileDateSheet open={dateSheetOpen} selectedDate={selectedDate} onSelect={setSelectedDate} onClose={() => setDateSheetOpen(false)} />
      </DashboardLayout>
    );
  }

  // ── DESKTOP VIEW ─────────────────────────────────────────────────────────────
  // [AC] fullBleed skips DashboardLayout's <main> padding + `maxWidth: 1400;
  // margin: 0 auto` wrapper. On wide monitors that wrapper was gutter-ing
  // the Gantt with ~200+ px of dead space on each side, making the board
  // feel floating and wasting horizontal space the timeline actually needs.
  // Collapsed sidebar remains 56 px; expanded 220 px is still an absolute
  // overlay so this page does not shift on hover. The dispatch top bar
  // already carries `padding: 8px 16px` so a 16 px gutter from the sidebar
  // edge is preserved.
  return (
    <DashboardLayout fullBleed>
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div style={{ display: "flex", height: "calc(100vh - 56px)", overflow: "hidden", fontFamily: FF, flexDirection: "column" }}>
          {/* [legend-fix 2026-06-17] Desktop mount — the popover was only
              rendered in the mobile return, so the desktop Legend button
              toggled state with nothing to show. */}
          <LegendPopover open={legendOpen} onClose={() => setLegendOpen(false)} mobile={false} anchorRect={legendAnchor} />

          {/* TOP BAR — date nav + mini-cal popover + stats + zones + view toggle.
              New Job button removed — the global "New" in the header covers it. */}
          <div style={{ padding: "8px 16px", borderBottom: "1px solid #E5E2DC", backgroundColor: "#FFFFFF", display: "flex", alignItems: "center", gap: 10, flexShrink: 0, flexWrap: "nowrap" }}>
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
              {data && [
                { label: `${stats.total} jobs`, color: "#1A1917", bg: "#F7F6F3" },
                { label: `${stats.complete} done`, color: "#16A34A", bg: "#DCFCE7" },
                ...(stats.inProgress > 0 ? [{ label: `${stats.inProgress} active`, color: "#D97706", bg: "#FEF3C7" }] : []),
                { label: `$${stats.revenue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} rev`, color: "var(--brand)", bg: "var(--brand-dim)" },
                ...(stats.unassigned > 0 ? [{ label: `${stats.unassigned} unassigned`, color: "#DC2626", bg: "#FEE2E2" }] : []),
              ].map(s => (
                <span key={s.label} style={{ fontSize: 11, fontWeight: 700, color: s.color, backgroundColor: s.bg, padding: "3px 8px", borderRadius: 20, whiteSpace: "nowrap" }}>{s.label}</span>
              ))}

              {/* Branch filter — dropdown (Oak Lawn vs Schaumburg zones) */}
              {zones.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <div style={{ width: 1, height: 18, backgroundColor: "#E5E2DC" }} />
                  <div ref={branchDropdownRef} style={{ position: "relative" }}>
                    <button onClick={() => setBranchDropdownOpen(v => !v)} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, padding: "4px 9px", borderRadius: 6, border: "1.5px solid #E5E2DC", backgroundColor: selectedBranchFilter !== "all" ? "var(--brand-dim)" : "#FAFAF9", color: selectedBranchFilter !== "all" ? "var(--brand)" : "#6B7280", cursor: "pointer", fontFamily: FF }}>
                      {selectedBranchFilter === "oak_lawn" ? "Oak Lawn" : selectedBranchFilter === "schaumburg" ? "Schaumburg" : "All Branches"}
                      <ChevronDown size={11} />
                    </button>
                    {branchDropdownOpen && (
                      <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 200, backgroundColor: "#fff", border: "1px solid #E5E2DC", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.10)", minWidth: 150, overflow: "hidden" }}>
                        {([["all", "All Branches"], ["oak_lawn", "Oak Lawn"], ["schaumburg", "Schaumburg"]] as const).map(([val, label]) => (
                          <button key={val} onClick={() => { setSelectedBranchFilter(val); setSelectedZoneFilter(null); setBranchDropdownOpen(false); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", backgroundColor: selectedBranchFilter === val ? "var(--brand-dim)" : "transparent", color: selectedBranchFilter === val ? "var(--brand)" : "#1A1917", fontSize: 12, fontWeight: selectedBranchFilter === val ? 700 : 600, cursor: "pointer", fontFamily: FF }}>{label}</button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

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
                        {zoneGroups.map((g, gi) => (
                          <div key={gi}>
                            {g.label && <div style={{ padding: "6px 12px 3px", fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9E9B94", backgroundColor: "#FAFAF9", borderTop: gi > 0 ? "1px solid #F0EEE9" : "none" }}>{g.label}</div>}
                            {g.zones.map(z => (
                              <button key={z.id} onClick={() => { setSelectedZoneFilter(z.id); setZoneDropdownOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "8px 12px", border: "none", backgroundColor: selectedZoneFilter === z.id ? `${z.color}18` : "transparent", color: selectedZoneFilter === z.id ? z.color : "#1A1917", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                                <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: z.color, flexShrink: 0 }} />
                                {z.name}
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* [AI.7.5] Legend button — opens popover decoding the 7
                  canonical status visuals so techs/office can read the
                  board without memorizing the color/border code. */}
              <button
                ref={legendBtnRef}
                onClick={() => {
                  setLegendAnchor(legendBtnRef.current?.getBoundingClientRect() ?? null);
                  setLegendOpen(o => !o);
                }}
                style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 7, border: "1.5px solid #E5E2DC", backgroundColor: legendOpen ? "var(--brand-dim)" : "#FAFAF9", color: legendOpen ? "var(--brand)" : "#6B7280", cursor: "pointer", fontFamily: FF, flexShrink: 0 }}
                title="Show status legend"
              >
                <Info size={12} />
                Legend
              </button>

              {/* View toggle */}
              <div style={{ display: "flex", border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden" }}>
                <button title="Timeline view — techs as rows, time across the top" onClick={() => setDesktopView("timeline")} style={{ padding: "5px 10px", border: "none", cursor: "pointer", backgroundColor: desktopView === "timeline" ? "var(--brand)" : "#FAFAF9", color: desktopView === "timeline" ? "#fff" : "#6B7280", display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600 }}><Calendar size={14} /> Timeline</button>
                <button title="List view — one card per job, stacked" onClick={() => setDesktopView("list")} style={{ padding: "5px 10px", border: "none", cursor: "pointer", backgroundColor: desktopView === "list" ? "var(--brand)" : "#FAFAF9", color: desktopView === "list" ? "#fff" : "#6B7280", display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600 }}><List size={14} /> List</button>
              </div>

              {/* Tech-row sort toggle. "By time" floats whoever starts first
                  to the top of the timeline; "Static" is alphabetical A→Z so
                  the order matches MaidCentral and the same tech is always
                  in the same place. Persisted in localStorage so the choice
                  sticks per browser. */}
              {desktopView === "timeline" && (
                <div style={{ display: "flex", border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden" }}>
                  <button title="Sort tech rows by their earliest scheduled job" onClick={() => setTechSortMode("by_time")} style={{ padding: "5px 10px", border: "none", cursor: "pointer", backgroundColor: techSortMode === "by_time" ? "var(--brand)" : "#FAFAF9", color: techSortMode === "by_time" ? "#fff" : "#6B7280", display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, fontFamily: FF }}>By time</button>
                  <button title="Sort tech rows alphabetically (MaidCentral parity — same tech, same place every day)" onClick={() => setTechSortMode("static")} style={{ padding: "5px 10px", border: "none", cursor: "pointer", backgroundColor: techSortMode === "static" ? "var(--brand)" : "#FAFAF9", color: techSortMode === "static" ? "#fff" : "#6B7280", display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, fontFamily: FF }}>Static</button>
                </div>
              )}

              {/* Cutover 3B — Attendance overlay drawer trigger. Sibling
                  of the Timeline/List toggle group, not inside it. Hidden
                  for tech-role; backend also 403s. */}
              {showAttendanceButton && (
                <button
                  title="Review attendance discrepancies for this date — late, short, no-show, missing clock-out"
                  onClick={() => setAttendanceDrawerOpen(true)}
                  style={{
                    padding: "5px 10px",
                    border: "1.5px solid #E5E2DC",
                    borderRadius: 7,
                    cursor: "pointer",
                    backgroundColor: "#FAFAF9",
                    color: "#1A1917",
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: FF,
                    flexShrink: 0,
                  }}
                >
                  Attendance
                </button>
              )}
            </div>
          </div>

          {/* KPI STRIP */}
          {data && (() => {
            const techsWorking = filteredData?.employees?.filter(e => e.jobs?.length > 0).length ?? 0;
            const totalTechs = filteredData?.employees?.length ?? 0;
            const scheduledHrs = allJobs.reduce((s, j) => s + (j.duration_minutes || 120) / 60, 0);
            // [labor-hours 2026-06-08] Total scheduled labor for the day (MC's
            // "59.2h"). jobs.allowed_hours is team-aggregated, so a plain sum
            // across the day's jobs = total labor hours across all techs.
            const laborHrs = allJobs.reduce((s, j: any) => s + (j.allowed_hours != null ? Number(j.allowed_hours) : 0), 0);
            const availableHrs = totalTechs * ((DAY_END - DAY_START) / 60);
            const utilization = availableHrs > 0 ? Math.round((scheduledHrs / availableHrs) * 100) : 0;
            const now = new Date();
            const nowMins = now.getHours() * 60 + now.getMinutes();
            const isLiveDay = dateKey(selectedDate) === dateKey(now);
            // [phes-lifecycle 2026-04-29] Same 20-min threshold as the
            // chip ring + Needs Attention strip. "At risk" is the
            // warning window — between scheduled start and the LATE
            // threshold. Both counters skip manual no-shows.
            const LATE_MIN_HEADER = 20;
            const lateClockIns = isLiveDay ? allJobs.filter(j => {
              if (j.status === "cancelled" || j.status === "complete") return false;
              if (j.clock_entry?.clock_in_at) return false;
              if (j.no_show_marked_by_tech) return false;
              const startMins = timeToMins(j.scheduled_time);
              if (startMins <= 0) return false;
              return nowMins >= startMins + LATE_MIN_HEADER;
            }).length : 0;
            const atRisk = isLiveDay ? allJobs.filter(j => {
              if (j.status === "cancelled" || j.status === "complete") return false;
              if (j.clock_entry?.clock_in_at) return false;
              if (j.no_show_marked_by_tech) return false;
              const startMins = timeToMins(j.scheduled_time);
              if (startMins <= 0) return false;
              // Between scheduled start and the LATE threshold — the
              // warning window before the chip flips to red.
              return nowMins >= startMins && nowMins < startMins + LATE_MIN_HEADER;
            }).length : 0;

            return (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 0, borderBottom: "1px solid #E5E2DC", backgroundColor: "#FFFFFF" }}>
                  {[
                    { label: "JOBS TODAY", value: stats.total },
                    { label: "REVENUE TODAY", value: `$${stats.revenue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
                    { label: "LABOR HRS", value: `${laborHrs.toFixed(1)}h` },
                    { label: "UNASSIGNED", value: stats.unassigned },
                    { label: "TECHS WORKING", value: techsWorking },
                    { label: "AVG UTILIZATION", value: `${utilization}%` },
                  ].map((card, i) => (
                    <div key={i} style={{ padding: "14px 20px", borderRight: i < 5 ? "1px solid #E5E2DC" : "none" }}>
                      <div style={{ fontSize: 26, fontWeight: 600, color: "#1A1917", fontFamily: FF, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{card.value}</div>
                      <div style={{ fontSize: 11, fontWeight: 500, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.02em", marginTop: 4 }}>{card.label}</div>
                    </div>
                  ))}
                </div>
                {(lateClockIns > 0 || atRisk > 0) && (
                  <div style={{ padding: "6px 20px", borderBottom: "1px solid #E5E2DC", backgroundColor: "#FFFFFF", fontSize: 12, color: "#6B6860", fontFamily: FF }}>
                    {lateClockIns > 0 && <span>{lateClockIns} late clock-in{lateClockIns > 1 ? "s" : ""}</span>}
                    {lateClockIns > 0 && atRisk > 0 && <span style={{ margin: "0 8px" }}>&middot;</span>}
                    {atRisk > 0 && <span>{atRisk} job{atRisk > 1 ? "s" : ""} at risk (past start, &lt;20 min)</span>}
                  </div>
                )}
              </>
            );
          })()}

          {/* GANTT / LIST — fills remaining height */}
          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            {/* Timeline or list */}
            {loading && !data ? (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#9E9B94", fontSize: 13 }}>Loading schedule...</div>
            ) : desktopView === "timeline" ? (
              <div ref={timelineRef} style={{ flex: 1, overflow: "auto" }}>
                {/* Time header */}
                <div style={{ display: "flex", position: "sticky", top: 0, zIndex: 10, backgroundColor: "#FAFAF9", borderBottom: "1px solid #E5E2DC" }}>
                  <div style={{ width: COL_W, flexShrink: 0, position: "sticky", left: 0, zIndex: 11, backgroundColor: "#FAFAF9", borderRight: "1px solid #E5E2DC", padding: "8px 12px" }}>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9E9B94" }}>Technician</span>
                  </div>
                  {TIMES.map((t, i) => (
                    <div key={i} style={{ width: SLOT_W, flexShrink: 0, padding: "8px 0 4px 6px", backgroundColor: Math.floor(i / 2) % 2 === 1 ? "rgba(120,110,90,0.045)" : "transparent", borderRight: i % 2 === 1 ? "1px solid #CBC7BF" : "1px dotted #E9E7E2" }}>
                      {i % 2 === 0 && <span style={{ fontSize: 10, fontWeight: 700, color: "#6B6860", whiteSpace: "nowrap" }}>{t}</span>}
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
                    {/* Row order: controlled by the techSortMode toggle.
                        - "by_time": techs with jobs first, ordered by their
                          earliest job time; then idle; stubs at the bottom.
                        - "static": pure alphabetical A→Z (with stubs still
                          pinned at the bottom); MaidCentral parity, so the
                          office can pattern-match a familiar order across
                          tools. */}
                    {[...filteredData.employees].sort((a, b) => {
                      const isStub = (e: Employee) => /\b(generic|test)\b/i.test(e.name);
                      // Stubs always last in both modes.
                      const sa = isStub(a) ? 1 : 0, sb = isStub(b) ? 1 : 0;
                      if (sa !== sb) return sa - sb;
                      if (techSortMode === "static") {
                        return a.name.localeCompare(b.name);
                      }
                      // by_time: working > idle, then earliest first within working.
                      const rank = (e: Employee) => e.jobs.length === 0 ? 1 : 0;
                      const ra = rank(a), rb = rank(b);
                      if (ra !== rb) return ra - rb;
                      if (ra === 0) {
                        const earliest = (e: Employee) => {
                          const t = e.jobs.map(j => timeToMins(j.scheduled_time)).filter(n => Number.isFinite(n));
                          return t.length ? Math.min(...t) : Infinity;
                        };
                        return earliest(a) - earliest(b);
                      }
                      return a.name.localeCompare(b.name);
                    }).map(e => <EmployeeRow key={e.id} employee={e} onChipClick={setSelectedJob} nowLine={nowLine} />)}
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
                    {/* [job-card-redesign / followup] List view delegates
                        to <JobChip layout="list"> so the timeline chip
                        and the list-view card can never drift on which
                        pills/badges they show. JobChipBody is the one
                        place to add a new pill. The optional commission
                        line below is list-only context — it doesn't
                        belong on the chip body. */}
                    {allJobs.map(j => {
                      // [2026-06-02] Footer was only rendering when
                      // est_hours_per_tech OR estimated_hours was populated,
                      // which residential cards always have but commercial
                      // PPM jobs often don't (allowed_hours is the source
                      // of truth for commercial — see CLAUDE.md commission
                      // routing notes). Result: residential rows showed
                      // "Est X.X hrs · $X commission", commercial rows
                      // showed nothing, and cards rendered at inconsistent
                      // heights. Fallback chain now reaches duration_minutes
                      // so every card has an hours value; commercial pay
                      // computes as commercial_hourly_rate × hours when
                      // est_pay_per_tech is null.
                      const estH = j.est_hours_per_tech
                        ?? j.estimated_hours
                        ?? (j.duration_minutes ? j.duration_minutes / 60 : null);
                      const isCommercial = !!j.account_id || j.client_type === "commercial";
                      const commercialPay = (isCommercial && j.commercial_hourly_rate != null && estH != null)
                        ? j.commercial_hourly_rate * estH
                        : null;
                      const payValue = j.est_pay_per_tech ?? commercialPay;
                      const payLabel = isCommercial ? "tech pay" : "commission";
                      const showLine = estH != null && estH > 0;
                      return (
                        <div key={j.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <JobChip
                            job={j}
                            onClick={() => setSelectedJob(j)}
                            assignedName={j.assigned_user_name}
                            layout="list"
                          />
                          {showLine && (
                            <div style={{ display: "flex", gap: 10, alignItems: "center", paddingLeft: 14, fontSize: 11, color: "#9E9B94" }}>
                              <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                                <Clock size={10} style={{ color: "#C4C0BB" }} />
                                Est. {(estH ?? 0).toFixed(1)} hrs
                              </span>
                              {payValue != null && payValue > 0 && (
                                <span style={{ fontWeight: 700, color: "#16A34A" }}>
                                  · ${payValue.toFixed(2)} {payLabel}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <DragOverlay>
          {/* [job-card-redesign / followup] Drag overlay reuses JobChip
              in "drag" layout so the dragged element looks identical to
              the chip the user just picked up — same colors, same
              two-row body, same pills. The previous inline JSX used the
              legacy STATUS palette and rendered a 2-line plain card
              instead, which made the visual jump mid-drag. */}
          {draggingJob && (
            <JobChip job={draggingJob} onClick={() => {}} layout="drag" />
          )}
        </DragOverlay>
      </DndContext>

      {selectedJob && !isMobile && (
        <JobPanel job={selectedJob} employees={data?.employees || []} onClose={() => setSelectedJob(null)} onUpdate={load} mobile={false} />
      )}
      <JobWizard open={showWizard} onClose={() => setShowWizard(false)} onCreated={() => { setShowWizard(false); load(); }} />

      {/* Cutover 3B — Attendance overlay drawer. Mounted at the same
          level as JobPanel so it can sit on top of dispatch without
          fighting layout. selectedDate is the dispatch date; the
          drawer fetches proposals for [selectedDate, selectedDate]. */}
      {attendanceDrawerOpen && (
        <AttendanceOverlayDrawer
          token={token}
          selectedDate={dateKey(selectedDate)}
          onClose={() => setAttendanceDrawerOpen(false)}
        />
      )}
    </DashboardLayout>
  );
}
