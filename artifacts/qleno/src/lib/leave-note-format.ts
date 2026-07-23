/**
 * Parse a leave usage-row note into display chips (Phase 4, Sal 2026-06-24).
 *
 * Presentation-only — the stored rows are never changed. Handles BOTH formats:
 *   - MC import:   "[MC import #12] accrual/pto — 608: Default Policy"
 *                  "[MC import #13] usage/pto — Requested 8 PTO hrs…"
 *                  classes seen: usage | accrual | adjustment | payout |
 *                                cancelled | unspecified
 *   - App-approved: "leave_request #5 approved (full_day) usage/pto"
 *
 * Returns the bucket slug (for a colored bucket chip), a kind label + tone
 * (for a status chip), and the clean human remainder (prefixes stripped).
 */
export type NoteKindTone = "neutral" | "good" | "warn" | "bad";
export interface ParsedLeaveNote {
  bucketSlug: string | null;
  kind: string;          // "" when the class is unknown/absent
  kindTone: NoteKindTone;
  clean: string;
}

const KIND_MAP: Record<string, { label: string; tone: NoteKindTone }> = {
  usage: { label: "Used", tone: "neutral" },
  accrual: { label: "Accrued", tone: "good" },
  adjustment: { label: "Adjustment", tone: "warn" },
  payout: { label: "Payout", tone: "neutral" },
  cashout: { label: "Cash-out", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "bad" },
  cancellation: { label: "Cancelled", tone: "bad" },
  unspecified: { label: "Recorded", tone: "neutral" },
};

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function parseLeaveNote(notes: string | null | undefined): ParsedLeaveNote {
  const raw = String(notes ?? "").trim();
  let bucketSlug: string | null = null;
  let kindKey = "";
  let clean = raw;

  // MC import: "[MC import #N] <class>/<bucket> — <human>"  (em-dash or hyphen)
  const mc = /^\[MC import #\d+\]\s*([a-z_]+)\/([a-z_]+)\s*(?:[—–-]\s*)?(.*)$/i.exec(raw);
  if (mc) {
    kindKey = mc[1].toLowerCase();
    bucketSlug = mc[2].toLowerCase();
    clean = (mc[3] || "").trim();
  } else {
    // App-approved: "leave_request #N approved (unit) usage/<bucket>"
    const app = /leave_request #\d+ approved(?:\s*\(([a-z_]+)\))?\s*usage\/([a-z_]+)/i.exec(raw);
    if (app) {
      kindKey = "usage";
      bucketSlug = app[2].toLowerCase();
      const unit = app[1];
      clean = unit && unit !== "full_day" ? `Approved (${unit.replace(/_/g, " ")})` : "Approved";
    }
  }

  // Tidy any leftover "class/bucket" token or empty-note placeholder.
  clean = clean
    .replace(/\b(usage|accrual|adjustment|payout|cancelled|cancellation|unspecified)\/[a-z_]+\b/gi, "")
    .replace(/\(no note\)/i, "")
    .trim();

  const mapped = KIND_MAP[kindKey];
  return {
    bucketSlug,
    kind: mapped ? mapped.label : kindKey ? cap(kindKey) : "",
    kindTone: mapped ? mapped.tone : "neutral",
    clean,
  };
}

/** Display label for a bucket slug (chip text). */
export function leaveBucketLabel(slug: string | null): string {
  const s = (slug || "").toLowerCase();
  if (s.includes("plawa") || s.includes("sick")) return "Sick";
  if (s.includes("pto")) return "PTO";
  if (s.includes("unpaid")) return "Unpaid";
  if (s.includes("unexcused")) return "Unexcused";
  return slug ? cap(s) : "";
}

/** Chip background tints for the kind tone. */
export const KIND_TONE_STYLE: Record<NoteKindTone, { bg: string; fg: string }> = {
  neutral: { bg: "#F0EEE9", fg: "#6B6860" },
  good: { bg: "#E9FBF5", fg: "#00876B" },
  warn: { bg: "#FDF3E4", fg: "#B45309" },
  bad: { bg: "#FCE7E7", fg: "#B3261E" },
};
