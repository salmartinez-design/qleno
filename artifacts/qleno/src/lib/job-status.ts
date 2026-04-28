/**
 * [AI.7.5] Canonical job visual status — single source of truth.
 *
 * The DB enum (job_status) is intentionally minimal — scheduled,
 * in_progress, complete, cancelled — because operational states like
 * "late clock-in" and "no show" are derived from time + clock-entry
 * absence, not stored. Surface code SHOULD NOT pattern-match on
 * job.status directly; route through getJobVisualStatus() so the
 * mapping stays consistent across the dispatch grid, mobile cards,
 * compact rows, my-jobs (tech view), and the Legend popover.
 *
 * Routing precedence (top wins on conflict):
 *   cancelled → no_show → late_clockin → completed → active → unassigned → scheduled
 */

/**
 * [AI.7.5.hotfix3] LIVE_OPS gate. The detection logic for time-based
 * states (late_clockin, no_show) is fully built — see below — but
 * pre-launch we have no real clock-in data, only seed/import data
 * with stale scheduled_times. Returning late_clockin / no_show in
 * that environment paints "NO SHOW" badges on every old job.
 *
 * Single source of truth so future surfaces can import this and
 * gate consistently. Flip to true after operations go live.
 *
 * Build the engine, don't turn it on.
 */
export const LIVE_OPS = false;

export type JobVisualStatus =
  | "scheduled"
  | "active"
  | "completed"
  | "late_clockin"
  | "no_show"
  | "cancelled"
  | "unassigned";

export interface JobStatusInput {
  status: string | null | undefined;
  scheduled_date?: string | null;
  scheduled_time?: string | null;
  assigned_user_id?: number | null;
  clock_entry?: { clock_in_at?: string | null; clock_out_at?: string | null } | null;
}

const LATE_GRACE_MIN = 5;
const NO_SHOW_THRESHOLD_MIN = 30;

function timeToMins(t: string | null | undefined): number {
  if (!t) return 0;
  const m = String(t).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function isToday(dateStr: string | null | undefined, now: Date): boolean {
  if (!dateStr) return false;
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return dateStr.startsWith(`${y}-${m}-${d}`);
}

export function getJobVisualStatus(job: JobStatusInput, now: Date = new Date()): JobVisualStatus {
  if (job.status === "cancelled") return "cancelled";
  if (job.status === "complete") return "completed";

  const hasClockIn = !!job.clock_entry?.clock_in_at;
  const hasClockOut = !!job.clock_entry?.clock_out_at;

  // Active: clocked in but not yet completed. Survives past clock-out
  // until the office marks complete (status='in_progress' transition).
  if (hasClockIn && !hasClockOut && job.status !== "complete") return "active";
  if (job.status === "in_progress") return "active";

  // [AI.7.5.hotfix3] Late / no-show derive from time + clock-entry
  // absence. Suppressed entirely when LIVE_OPS=false — engine still
  // computes the math (LATE_GRACE_MIN / NO_SHOW_THRESHOLD_MIN
  // constants live above; flipping LIVE_OPS=true is the only switch
  // needed) but the function returns scheduled/unassigned instead so
  // the board doesn't paint "NO SHOW" badges on import data with
  // stale scheduled_times that pre-date go-live.
  if (LIVE_OPS && isToday(job.scheduled_date, now) && !hasClockIn) {
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const startMins = timeToMins(job.scheduled_time);
    if (startMins > 0) {
      const minsLate = nowMins - startMins;
      if (minsLate >= NO_SHOW_THRESHOLD_MIN) return "no_show";
      if (minsLate >= LATE_GRACE_MIN) return "late_clockin";
    }
  }

  if (job.assigned_user_id == null) return "unassigned";
  return "scheduled";
}

/**
 * Visual treatment for each status. Consumers compose these onto card
 * surfaces; the underlying tech color (zone color) is supplied
 * separately and combined per-card.
 */
export interface StatusVisual {
  /** Display label (sentence-case) for chips/legend. */
  label: string;
  /** One-line description for the legend popover. */
  description: string;
  /** Solid swatch color shown in the legend tile preview. */
  swatch: string;
  /** Stripe color when active (amber); null for non-active states. */
  stripe: string | null;
  /** Body opacity multiplier (1.0 default; 0.6 for completed; 0.5 cancelled). */
  bodyOpacity: number;
  /** Whether to render a green checkmark badge top-right (completed). */
  showCheckmark: boolean;
  /** Whether to render a "NO SHOW" text badge. */
  showNoShowBadge: boolean;
  /** Whether to apply strikethrough to the title text (cancelled). */
  strikethrough: boolean;
  /** Whether to desaturate the body via grayscale filter (cancelled). */
  desaturate: boolean;
  /** Border color override (red for late/no_show, default for others). */
  borderOverride: string | null;
}

export const STATUS_VISUALS: Record<JobVisualStatus, StatusVisual> = {
  scheduled: {
    label: "Scheduled",
    description: "Job on the board, no tech clocked in yet.",
    swatch: "#A78BFA",
    stripe: null,
    bodyOpacity: 1,
    showCheckmark: false,
    showNoShowBadge: false,
    strikethrough: false,
    desaturate: false,
    borderOverride: null,
  },
  active: {
    label: "Active",
    description: "Tech is clocked in. Stripe pulses while live.",
    swatch: "#A78BFA",
    stripe: "#F59E0B",
    bodyOpacity: 1,
    showCheckmark: false,
    showNoShowBadge: false,
    strikethrough: false,
    desaturate: false,
    borderOverride: null,
  },
  completed: {
    label: "Completed",
    description: "Job finished. Tech clocked out and office marked complete.",
    swatch: "#A78BFA",
    stripe: null,
    bodyOpacity: 0.6,
    showCheckmark: true,
    showNoShowBadge: false,
    strikethrough: false,
    desaturate: false,
    borderOverride: null,
  },
  late_clockin: {
    label: "Late clock-in",
    description: "Past start time + 5 min, tech still has not clocked in.",
    swatch: "#A78BFA",
    stripe: null,
    bodyOpacity: 1,
    showCheckmark: false,
    showNoShowBadge: false,
    strikethrough: false,
    desaturate: false,
    borderOverride: "#DC2626",
  },
  no_show: {
    label: "No show",
    description: "Past start time + 30 min, no clock-in. Action required.",
    swatch: "#EF4444",
    stripe: null,
    bodyOpacity: 0.85,
    showCheckmark: false,
    showNoShowBadge: true,
    strikethrough: false,
    desaturate: false,
    borderOverride: "#991B1B",
  },
  cancelled: {
    label: "Cancelled",
    description: "Manually cancelled. Strikethrough + desaturated.",
    swatch: "#9CA3AF",
    stripe: null,
    bodyOpacity: 0.5,
    showCheckmark: false,
    showNoShowBadge: false,
    strikethrough: true,
    desaturate: true,
    borderOverride: null,
  },
  unassigned: {
    label: "Unassigned",
    description: "No primary tech yet. Surfaces in Unassigned row.",
    swatch: "#FBBF24",
    stripe: null,
    bodyOpacity: 1,
    showCheckmark: false,
    showNoShowBadge: false,
    strikethrough: false,
    desaturate: false,
    borderOverride: "#F59E0B",
  },
};

/** Stripe pulse keyframes injected once; consumers reference the
 *  `qleno-active-stripe` class. Reduced-motion drops the animation
 *  to a steady 1.0 opacity. Idempotent — only injects once per
 *  document. */
let stylesInjected = false;
export function ensureJobStatusStyles(): void {
  if (stylesInjected) return;
  if (typeof document === "undefined") return;
  const id = "qleno-job-status-styles";
  if (document.getElementById(id)) { stylesInjected = true; return; }
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    @keyframes qleno-active-stripe-pulse {
      0%   { opacity: 1; }
      50%  { opacity: 0.6; }
      100% { opacity: 1; }
    }
    .qleno-active-stripe {
      animation: qleno-active-stripe-pulse 2s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .qleno-active-stripe { animation: none; opacity: 1; }
    }
  `;
  document.head.appendChild(style);
  stylesInjected = true;
}
