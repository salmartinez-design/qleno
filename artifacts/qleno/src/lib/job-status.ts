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
 *   cancelled → completed_unpaid → completed → active → no_show
 *   → en_route → late_clockin → unassigned → scheduled
 *
 * en_route is scaffolded but inert: it requires `en_route_at` (set when
 * the field tech taps "On My Way"). The schema column doesn't exist yet
 * — the SMS / mobile-tech engine will add it later. Callers that don't
 * pass en_route_at will never see this status. It still has a
 * STATUS_VISUALS entry so the chip can render the animated car icon
 * the moment the column lands.
 *
 * completed_unpaid fires only for online-payment jobs (stripe/square).
 * Cash/check completion stays "completed" — there's no charge signal
 * to derive from, and reconciliation lives in a separate workflow.
 *
 * [phes-lifecycle 2026-04-29] Phes-specific simplification:
 *   - Single 20-minute threshold for late_clockin (was 5/30 split).
 *   - no_show is now a MANUAL flag (no_show_marked_by_tech IS NOT NULL),
 *     not time-derived. The field app's "No Show" button writes the
 *     timestamp after the tech has waited the configured period
 *     on-site. Until that button ships, no_show never fires in
 *     production.
 *   - Hard gate: nothing negative (late_clockin / en_route /
 *     unassigned-as-late) fires before scheduled_start_time. A future
 *     job is always SCHEDULED. Closes the William Rosenbloom bug
 *     where the chip painted late before the start time elapsed.
 *
 * The thresholds below are hardcoded for Phes. When multi-tenant
 * settings ship they become per-tenant: tenant_settings.late_threshold_
 * minutes / tenant_settings.no_show_wait_minutes.
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
 *
 * [hotfix 2026-04-29] Flipped to true. Operations went live; the
 * dispatch board's page-level "late clock-ins" counter (which gates
 * only on `isLiveDay`, not LIVE_OPS) was showing real late jobs while
 * the chips themselves stayed in the "scheduled" visual because
 * getJobVisualStatus suppressed late_clockin / no_show. The two
 * surfaces disagreed on production. Flipping LIVE_OPS=true brings
 * them into sync.
 */
export const LIVE_OPS = true;

export type JobVisualStatus =
  | "scheduled"
  | "active"
  | "completed"
  | "completed_unpaid"
  | "en_route"
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
  /** Set when the tech taps "On My Way" in the mobile app. Inert until
   *  the SMS engine + schema column land — callers that don't supply
   *  it never trigger en_route. */
  en_route_at?: string | null;
  /** Online-payment signals. completed_unpaid fires when status='complete'
   *  AND payment method is stripe/square AND charge_succeeded_at is null.
   *  Cash/check completion stays "completed" regardless. */
  client_payment_method?: string | null;
  charge_succeeded_at?: string | null;
  /** [phes-lifecycle 2026-04-29] Manual no-show flag. Set when the
   *  tech taps "No Show" in the field app after waiting the configured
   *  period on-site. Distinct from late_clockin: late = "where's the
   *  tech?" (tech accountability), no_show = "where's the customer?"
   *  (customer accountability). The button doesn't exist yet — until
   *  it ships this field stays null and no_show never fires. */
  no_show_marked_by_tech?: string | null;
}

// [phes-lifecycle 2026-04-29] Phes-specific thresholds. Multi-tenant
// later → tenant_settings.late_threshold_minutes / .no_show_wait_minutes.
const LATE_THRESHOLD_MINUTES = 20;
// Kept for documentation parity with the no-show button's wait period;
// the derived `no_show` state itself doesn't read this constant
// because it's now a manual flag. The field app reads this when it
// decides whether to enable the No Show button on the tech's screen.
export const NO_SHOW_WAIT_MINUTES = 20;

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

function isUnpaidOnlineJob(job: JobStatusInput): boolean {
  const m = job.client_payment_method;
  if (m !== "stripe" && m !== "square") return false;
  return !job.charge_succeeded_at;
}

export function getJobVisualStatus(job: JobStatusInput, now: Date = new Date()): JobVisualStatus {
  if (job.status === "cancelled") return "cancelled";
  if (job.status === "complete") {
    return isUnpaidOnlineJob(job) ? "completed_unpaid" : "completed";
  }

  const hasClockIn = !!job.clock_entry?.clock_in_at;
  const hasClockOut = !!job.clock_entry?.clock_out_at;

  // Active: clocked in but not yet completed. Survives past clock-out
  // until the office marks complete (status='in_progress' transition).
  if (hasClockIn && !hasClockOut && job.status !== "complete") return "active";
  if (job.status === "in_progress") return "active";

  // [phes-lifecycle 2026-04-29] no_show is a manual flag now — fires
  // ONLY when the field app's "No Show" button has been tapped. Wins
  // over en_route / late_clockin because once the tech has marked
  // no-show, the situation isn't "where's the tech" or "tech is
  // arriving" anymore.
  if (job.no_show_marked_by_tech) return "no_show";

  // [phes-lifecycle 2026-04-29] Hard gate: nothing negative fires
  // before scheduled_start_time. A future job is always SCHEDULED
  // (or unassigned, if no tech). Pre-start jobs can never read as
  // late or unassigned-as-risk. This is the William Rosenbloom fix.
  const isJobToday = isToday(job.scheduled_date, now);
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const startMins = timeToMins(job.scheduled_time);
  const hasStarted = isJobToday && startMins > 0 && nowMins >= startMins;

  // En route: tech tapped "On My Way" but hasn't clocked in yet. Can
  // fire before or after scheduled_start_time — a tech heading there
  // early is still en_route.
  if (job.en_route_at && !hasClockIn) return "en_route";

  // Late: 20+ min past scheduled start, no clock-in, no manual no-show
  // flag. LIVE_OPS gate is symbolic now (operations went live in #9)
  // but kept for an emergency off-switch.
  if (LIVE_OPS && hasStarted && !hasClockIn) {
    const minsLate = nowMins - startMins;
    if (minsLate >= LATE_THRESHOLD_MINUTES) return "late_clockin";
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
  /** Whether to render an animated car icon left of the client name
   *  (en_route only). The icon + motion-line markup is owned by each
   *  consumer; this flag is the trigger. */
  showCarIcon: boolean;
}

export const STATUS_VISUALS: Record<JobVisualStatus, StatusVisual> = {
  scheduled: {
    label: "Scheduled",
    description: "On the board. Tech hasn't started yet.",
    swatch: "#A78BFA",
    stripe: null,
    bodyOpacity: 1,
    showCheckmark: false,
    showNoShowBadge: false,
    strikethrough: false,
    desaturate: false,
    borderOverride: null,
    showCarIcon: false,
  },
  active: {
    label: "In progress",
    description: "Tech is on the job right now.",
    swatch: "#A78BFA",
    stripe: "#F59E0B",
    bodyOpacity: 1,
    showCheckmark: false,
    showNoShowBadge: false,
    strikethrough: false,
    desaturate: false,
    // [hotfix 2026-04-29] Spec calls for a 2px solid orange ring around
    // the active chip (#EF9F27). Without the borderOverride the chip's
    // border falls through to the zone color, so an in_progress chip
    // looked identical to a scheduled one — the only visual signal
    // was a 4px amber stripe on the left, which was easy to miss.
    // Progress bar + live timer remain conditional on clock_entry data
    // since they need elapsed time to render meaningfully.
    borderOverride: "#EF9F27",
    showCarIcon: false,
  },
  en_route: {
    label: "On the way",
    description: "Tech tapped \"On My Way\" and is heading to the job.",
    swatch: "#A78BFA",
    stripe: null,
    bodyOpacity: 1,
    showCheckmark: false,
    showNoShowBadge: false,
    strikethrough: false,
    desaturate: false,
    borderOverride: null,
    showCarIcon: true,
  },
  completed: {
    label: "Done",
    description: "Job finished and payment is in.",
    swatch: "#A78BFA",
    stripe: null,
    bodyOpacity: 0.6,
    showCheckmark: true,
    showNoShowBadge: false,
    strikethrough: false,
    desaturate: false,
    borderOverride: null,
    showCarIcon: false,
  },
  completed_unpaid: {
    label: "Done — unpaid",
    description: "Job is done but the payment hasn't gone through yet.",
    swatch: "#BA7517",
    stripe: null,
    bodyOpacity: 0.6,
    showCheckmark: true,
    showNoShowBadge: false,
    strikethrough: false,
    desaturate: false,
    borderOverride: "#BA7517",
    showCarIcon: false,
  },
  late_clockin: {
    label: "Late",
    description: "Tech is more than 20 minutes past start time and hasn't clocked in.",
    swatch: "#A78BFA",
    stripe: null,
    bodyOpacity: 1,
    showCheckmark: false,
    showNoShowBadge: false,
    strikethrough: false,
    desaturate: false,
    borderOverride: "#DC2626",
    showCarIcon: false,
  },
  no_show: {
    label: "No show",
    description: "Tech tapped \"No Show\" — customer wasn't there after 20+ min wait.",
    swatch: "#EF4444",
    stripe: null,
    bodyOpacity: 0.85,
    showCheckmark: false,
    showNoShowBadge: true,
    strikethrough: false,
    desaturate: false,
    borderOverride: "#991B1B",
    showCarIcon: false,
  },
  cancelled: {
    label: "Cancelled",
    description: "Won't run today. Cancelled by office or client.",
    swatch: "#9CA3AF",
    stripe: null,
    bodyOpacity: 0.5,
    showCheckmark: false,
    showNoShowBadge: false,
    strikethrough: true,
    desaturate: true,
    borderOverride: null,
    showCarIcon: false,
  },
  unassigned: {
    label: "Unassigned",
    description: "Nobody is assigned yet. Drag a tech onto the job.",
    swatch: "#FBBF24",
    stripe: null,
    bodyOpacity: 1,
    showCheckmark: false,
    showNoShowBadge: false,
    strikethrough: false,
    desaturate: false,
    borderOverride: "#F59E0B",
    showCarIcon: false,
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
    @keyframes qleno-en-route-drive {
      0%   { transform: translateX(0); }
      50%  { transform: translateX(1.5px); }
      100% { transform: translateX(0); }
    }
    .qleno-en-route-icon {
      animation: qleno-en-route-drive 0.8s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .qleno-active-stripe { animation: none; opacity: 1; }
      .qleno-en-route-icon { animation: none; }
    }
  `;
  document.head.appendChild(style);
  stylesInjected = true;
}
