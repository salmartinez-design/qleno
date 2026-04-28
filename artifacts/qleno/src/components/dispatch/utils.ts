/**
 * AI.15a dispatch utilities. Shared helpers, constants, and types used by
 * the dispatch tile (JobChip) and the hover popover (JobHoverCard).
 *
 * Lifted verbatim from artifacts/qleno/src/pages/jobs.tsx. The only
 * structural change is collapsing the four mutable let bindings
 * (DAY_START, DAY_END, TOTAL_SLOTS, TIMES) into a single mutable
 * dayBounds object plus a setDayBounds setter. ES module exports of bare
 * let do not propagate reassignments across module boundaries reliably,
 * but property mutation on an exported object does. Same observable
 * behavior, single source of truth.
 */

// ─── TYPES ────────────────────────────────────────────────────────────────────
export interface ClockEntry {
  id: number;
  clock_in_at: string | null;
  clock_out_at: string | null;
  distance_from_job_ft: number | null;
  is_flagged: boolean;
}

export interface JobTechCommission {
  user_id: number;
  name: string;
  is_primary: boolean;
  est_hours: number;
  calc_pay: number;
  final_pay: number;
  pay_override: number | null;
}

export interface DispatchJob {
  id: number;
  client_id: number;
  client_name: string;
  client_phone?: string | null;
  client_zip?: string | null;
  client_notes?: string | null;
  client_payment_method?: string | null;
  address: string | null;
  assigned_user_id: number | null;
  assigned_user_name?: string;
  service_type: string;
  status: string;
  scheduled_date: string;
  scheduled_time: string | null;
  frequency: string;
  amount: number;
  duration_minutes: number;
  notes: string | null;
  office_notes?: string | null;
  before_photo_count: number;
  after_photo_count: number;
  clock_entry: ClockEntry | null;
  zone_id?: number | null;
  zone_color?: string | null;
  zone_name?: string | null;
  branch_id?: number | null;
  branch_name?: string | null;
  last_service_date?: string | null;
  account_id?: number | null;
  account_name?: string | null;
  billing_method?: string | null;
  hourly_rate?: number | null;
  estimated_hours?: number | null;
  actual_hours?: number | null;
  billed_hours?: number | null;
  billed_amount?: number | null;
  charge_failed_at?: string | null;
  charge_succeeded_at?: string | null;
  property_access_notes?: string | null;
  booking_location?: string | null;
  technicians?: JobTechCommission[];
  est_hours_per_tech?: number | null;
  est_pay_per_tech?: number | null;
  company_res_pct?: number | null;
  /* [AF] completion lock state */
  locked_at?: string | null;
  actual_end_time?: string | null;
  completed_by_user_id?: number | null;
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
export const FF = "'Plus Jakarta Sans', sans-serif";

// [AB] Shrunk SLOT_W 80 to 64 so the default 9-hour business window
// (9 AM to 6 PM = 18 slots times 64 = 1152 px) fits inside a 1440 px
// viewport alongside the 180 px sticky tech column (total 1332 px,
// roughly 100 px margin for page padding and scrollbars). Previous
// 80 px per slot pushed the timeline to 1620 px and forced horizontal
// scroll on first paint. ROW_H 64 to 72 gives the chip 52 px of
// vertical space (ROW_H minus 20 top and bottom gutter) to match MC's
// roomier card feel.
export const SLOT_W = 64;
export const COL_W = 180;
export const ROW_H = 72;

// [Q2] Status pill — colored chip next to client name in JobHoverCard.
export const STATUS_PILL: Record<string, { bg: string; fg: string; label: string }> = {
  scheduled:   { bg: "#DBEAFE", fg: "#1D4ED8", label: "Scheduled" },
  in_progress: { bg: "#FEF3C7", fg: "#92400E", label: "In Progress" },
  complete:    { bg: "#DCFCE7", fg: "#15803D", label: "Complete" },
  cancelled:   { bg: "#F3F4F6", fg: "#6B7280", label: "Cancelled" },
};

// ─── MUTABLE BOUNDS ───────────────────────────────────────────────────────────
// Overwritten by company dispatch_start_hour / dispatch_end_hour settings
// and by JobsPage's auto fit effect when the actual job times exceed the
// configured window. Defaults: 8 AM to 6 PM, 30 minute slots.
//
// AI.15a: mutate only via setDayBounds. Direct property writes will not
// survive code review.
export const dayBounds: {
  start: number;
  end: number;
  totalSlots: number;
  times: string[];
} = {
  start: 8 * 60,
  end: 18 * 60,
  totalSlots: 0,
  times: [],
};

/**
 * Update the dispatch day window. Recomputes derived state (totalSlots,
 * times) in the same call. Replaces the previous refreshTimeline plus
 * direct DAY_START / DAY_END reassignment idiom.
 */
export function setDayBounds(start: number, end: number): void {
  dayBounds.start = start;
  dayBounds.end = end;
  dayBounds.totalSlots = (end - start) / 30;
  dayBounds.times = Array.from({ length: dayBounds.totalSlots }, (_, i) => {
    const mins = start + i * 30;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  });
}

// Seed derived state at module load so the first read of dayBounds.times
// matches the original module load behavior (previously refreshTimeline()
// was called once at the bottom of the let-bindings block).
setDayBounds(dayBounds.start, dayBounds.end);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// [Y] timeToMins + fmtTime were broken for AM / PM format strings coming
// from MC (e.g. "1:30 PM"). The old t.split(":").map(Number) produced
// [1, NaN] for "1:30 PM" because "30 PM" can't parse as a number, so
// minutes got dropped AND the PM plus 12h offset was never applied.
// Result: "1:30 PM" became 60 min (1 AM). Robust parser handles BOTH
// formats:
//   12 hour AM / PM (MC imported rows): "H:MM AM" / "H:MM PM"
//   24 hour HH:MM or HH:MM:SS (Quote Builder + engine written via minsToStr below)
export const timeToMins = (t: string | null): number => {
  if (!t) return dayBounds.start;
  const trimmed = t.trim();
  const ampm = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10) || 0;
    const m = parseInt(ampm[2], 10) || 0;
    const isPM = ampm[3].toUpperCase() === "PM";
    if (h === 12) h = isPM ? 12 : 0;      // 12 AM becomes 0, 12 PM stays 12
    else if (isPM) h += 12;               // 1 through 11 PM becomes 13 through 23
    return h * 60 + m;
  }
  const parts = trimmed.split(":").map(p => parseInt(p, 10));
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  return h * 60 + m;
};

export const minsToStr = (mins: number): string => {
  const c = Math.max(dayBounds.start, Math.min(dayBounds.end - 30, mins));
  return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}:00`;
};

export function fmtTime(t: string | null): string {
  if (!t) return "—";
  const trimmed = t.trim();
  const ampm = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampm) {
    // Already AM / PM format. Reformat cleanly (normalizes spacing and case).
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

export function fmtSvc(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// [X] scopeLabel. Card facing scope label. Prefers frequency when the
// job is recurring (Weekly, Biweekly, Every 4 Weeks). Falls back to
// service_type when one off. Matches MC's Job Schedule card convention.
export function scopeLabel(job: { service_type?: string | null; frequency?: string | null }): string {
  const FREQ: Record<string, string> = {
    weekly: "Weekly",
    biweekly: "Biweekly",
    every_3_weeks: "Every 3 Weeks",
    monthly: "Every 4 Weeks",
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

// [AB] Perceptual luminance of a hex color, 0 to 1. Used to pick between
// white and dark text on full opacity zone color chip backgrounds.
// Rec. 601 weights (0.299 R + 0.587 G + 0.114 B). Slightly cheaper than
// the WCAG relative luminance formula and close enough for a binary
// light or dark decision. Gold (#FFD700) gives roughly 0.79, so dark
// text. All other PHES zone colors (magenta, purple, red, green) are
// below 0.4, so white text.
export function zoneLuminance(hex: string | null | undefined): number {
  if (!hex) return 0;
  const h = hex.replace("#", "");
  if (h.length !== 6) return 0;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some(v => Number.isNaN(v))) return 0;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// [Q2] Human readable payment_method labels. `manual` returns null so
// the section can hide.
export function fmtPayment(pm: string | null | undefined): string | null {
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

// [Q2] "Last service" relative time helper.
export function fmtRelativeDate(isoDate: string): string {
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
export function parseActualTimes(notes: string | null | undefined): { start: string; end: string } | null {
  if (!notes) return null;
  const m = notes.match(/act:\s*(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
  return m ? { start: m[1], end: m[2] } : null;
}

// [Q2] Strip `[mc_import_phase* ...]` tags when rendering notes to the user.
export function stripImportTags(notes: string | null | undefined): string {
  if (!notes) return "";
  return notes.replace(/\[mc_import_phase[^\]]*\]/g, "").trim();
}
