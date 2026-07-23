// [notif-colors 2026-07-23] ONE source of truth for how a notification looks.
//
// Sal: "There should be office tickets, attendance tickets, personalized
// tickets, New online or booking tickets ... we need all of them to have their
// own personalized colors compatible with the color harmony of the app."
//
// The bell was a wall of identical grey/blue rows — every type shared two icons
// and one tint, so nothing could be triaged at a glance. Types are grouped into
// FAMILIES (what kind of thing happened) and each family owns a colour.
//
// Every colour here comes from the design tokens in index.css, so the bell
// reads as part of Qleno rather than a new palette bolted on:
//   mint  var(--brand) — the brand accent; customer conversations
//   green --ok         — money arriving; the readable green (mint is 1.8:1)
//   amber --warn       — the late/at-risk stripe on job cards; people problems
//   slate --info       — scheduling and office work
//   clay  --clay       — mint's complement; things aimed personally at you
//
// [ui-consistency 2026-07-23] Office was Tailwind blue and personal was Tailwind
// violet. Both read as a different product next to mint on a warm #F7F6F3 page,
// so they moved to the slate and clay tokens. Same five-way distinguishability,
// one palette. Do NOT reintroduce a blue or a violet here.
//
// Adding a new notification type? Add it to TYPE_FAMILY. An unmapped type falls
// back to `office`, which is a sane neutral rather than an invisible row.

export type NotifFamily = "messages" | "booking" | "attendance" | "office" | "personal";

export interface FamilyStyle {
  /** Icon + accent colour. Passes contrast on the tint below. */
  color: string;
  /** Chip background behind the icon. */
  tint: string;
  /** Chip border — keeps the chip visible on a white card. */
  border: string;
  /** Row background while the notification is unread. */
  unreadBg: string;
  /** Human label, used for the filter chips and grouping. */
  label: string;
}

export const FAMILY_STYLE: Record<NotifFamily, FamilyStyle> = {
  // Messages rides the tenant's own brand token rather than a hardcoded mint —
  // main moved the bell to var(--brand) while this was in flight, and customer
  // conversations are the one family that should follow a tenant's branding.
  messages:   { color: "var(--brand)", tint: "var(--brand-dim)", border: "#C7E7DE", unreadBg: "#F4FBF8", label: "Messages" },
  booking:    { color: "#0F7A63", tint: "#E6F6F1", border: "#C7E7DE", unreadBg: "#F4FBF8", label: "Bookings" },
  attendance: { color: "#B45309", tint: "#FDF3E4", border: "#F2DFB8", unreadBg: "#FFFCF2", label: "Attendance" },
  office:     { color: "#2F3646", tint: "#EFEFF2", border: "#DEDEE4", unreadBg: "#F8F8FA", label: "Office" },
  personal:   { color: "#9C4E2B", tint: "#FBF0E9", border: "#EFDCCE", unreadBg: "#FDF8F4", label: "For you" },
};

// Which family each notification type belongs to.
//
// The split is by WHO ACTS on it, not by which table it came from — that's what
// makes the colour useful when triaging a full bell:
//   messages   → a customer said something; someone must reply
//   booking    → work or money arrived; confirm and schedule it
//   attendance → a person problem (late, off-site, leave); the office chases it
//   office     → dispatch/admin housekeeping; assign, review, clean up
//   personal   → aimed at YOU by name; nobody else will pick it up
export const TYPE_FAMILY: Record<string, NotifFamily> = {
  // Customer conversations
  new_message: "messages",
  scheduled_sms_review: "messages",

  // Work / money arriving
  new_booking: "booking",

  // People problems
  late_clockin: "attendance",
  geofence_violation: "attendance",
  leave_request: "attendance",
  leave_reset_applied: "attendance",
  leave_reset_upcoming: "attendance",

  // Dispatch + admin housekeeping
  job_unassigned: "office",
  job_changed: "office",
  suspension_expired: "office",

  // Addressed to this user personally
  note_mention: "personal",
  job_assigned: "personal",
  leave_decision: "personal",
  one_on_one_scheduled: "personal",
  annual_reack_opened: "personal",
};

export function familyOf(type: string): NotifFamily {
  return TYPE_FAMILY[type] ?? "office";
}

export function styleOf(type: string): FamilyStyle {
  return FAMILY_STYLE[familyOf(type)];
}

// Display order for filters — most-actioned first, matching how the office
// works the bell rather than alphabetically.
export const FAMILY_ORDER: NotifFamily[] = ["messages", "booking", "personal", "attendance", "office"];
