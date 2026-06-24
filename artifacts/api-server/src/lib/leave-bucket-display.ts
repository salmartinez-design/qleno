/**
 * Tenant-dynamic leave-bucket display (Phase 3, Sal 2026-06-24).
 *
 * ONE source of truth for how a leave bucket renders across every surface —
 * the dispatch board (row tint + label), the employees review chip (tint + a
 * darker on-tint text), the profile cards (dark accent), and the history chips
 * (accent + a short chip label). Each surface used to hardcode its own map;
 * now the API resolves a bucket's display from leave_types.display_config and
 * the frontend renders from data. A tenant with a different set of buckets (or
 * no display_config at all) renders correctly with NO code change — the
 * resolver derives sane, stable defaults from the slug.
 *
 * display_config JSON shape (all optional): { tint, accent, on_tint,
 * board_label, chip_label }. `label` is always the leave_type display_name.
 *
 * The PHES backfill (seeded by the cutover migration) reproduces the four
 * legacy hardcoded maps BYTE-IDENTICALLY — see PHES_BUCKET_DISPLAY below.
 */
export interface BucketDisplay {
  slug: string;
  label: string;        // canonical label = display_name
  tint: string;         // pale row/chip background (board + review)
  accent: string;       // bold accent (profile cards, dots, chip border/text)
  on_tint: string;      // text color ON the tint (review chip)
  board_label: string;  // dispatch-board chip text
  chip_label: string;   // history-chip / profile short label
}

/** PHES exact values, pulled verbatim from the four legacy maps. Used to seed
 *  leave_types.display_config and as the regression contract. */
export const PHES_BUCKET_DISPLAY: Record<string, Omit<BucketDisplay, "slug" | "label">> = {
  pto_phes:     { tint: "#E9FBF5", accent: "#1D9E75", on_tint: "#00876B", board_label: "PTO",       chip_label: "PTO" },
  plawa:        { tint: "#FEF3C7", accent: "#378ADD", on_tint: "#92400E", board_label: "PLAWA",     chip_label: "Sick" },
  unpaid_leave: { tint: "#EEF2F7", accent: "#BA7517", on_tint: "#334155", board_label: "Unpaid",    chip_label: "Unpaid" },
  unexcused:    { tint: "#FCE7E7", accent: "#E24B4A", on_tint: "#991B1B", board_label: "Unexcused", chip_label: "Unexcused" },
};

/** Board-only pseudo-bucket: an attendance "absent" mark is NOT a tenant leave
 *  type, so it has no leave_types row. The dispatch board renders it from this
 *  constant (legacy TIME_OFF_BG.absent / TIME_OFF_LABEL.absent). */
export const ABSENT_DISPLAY = { tint: "#FFEBEE", board_label: "Absent", accent: "#C62828" };

// Stable default palette for tenants that haven't configured display_config —
// keyed by a coarse classification of the slug so common buckets look sensible,
// with a hashed fallback so even unknown buckets get a distinct, consistent hue.
const DEFAULT_BY_KIND: Array<{ test: RegExp; d: Omit<BucketDisplay, "slug" | "label"> }> = [
  { test: /plawa|sick/, d: { tint: "#FEF3C7", accent: "#378ADD", on_tint: "#92400E", board_label: "", chip_label: "" } },
  { test: /pto|vacation/, d: { tint: "#E9FBF5", accent: "#1D9E75", on_tint: "#00876B", board_label: "", chip_label: "" } },
  { test: /unpaid/, d: { tint: "#EEF2F7", accent: "#BA7517", on_tint: "#334155", board_label: "", chip_label: "" } },
  { test: /unexcused|absence/, d: { tint: "#FCE7E7", accent: "#E24B4A", on_tint: "#991B1B", board_label: "", chip_label: "" } },
];
const FALLBACK_PALETTE = [
  { tint: "#EEF2F7", accent: "#334155", on_tint: "#334155" },
  { tint: "#F3ECFB", accent: "#6D28D9", on_tint: "#6D28D9" },
  { tint: "#E7F3FB", accent: "#0E7490", on_tint: "#0E7490" },
  { tint: "#FBEFE7", accent: "#B45309", on_tint: "#B45309" },
];
function hashIndex(s: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % mod;
}

/** Resolve a bucket's full display from its leave_types row. display_config
 *  wins field-by-field; missing fields fall back to a slug-derived default so
 *  partial configs and brand-new tenant buckets both render correctly. */
export function resolveBucketDisplay(row: {
  slug: string;
  display_name: string;
  display_config?: Record<string, string> | null;
}): BucketDisplay {
  const cfg = row.display_config || {};
  const s = (row.slug || "").toLowerCase();
  const kind = DEFAULT_BY_KIND.find((k) => k.test.test(s))?.d;
  const fb = kind ?? FALLBACK_PALETTE[hashIndex(s, FALLBACK_PALETTE.length)];
  const tint = cfg.tint || fb.tint;
  const accent = cfg.accent || fb.accent;
  return {
    slug: row.slug,
    label: row.display_name,
    tint,
    accent,
    on_tint: cfg.on_tint || (fb as any).on_tint || accent,
    board_label: cfg.board_label || row.display_name,
    chip_label: cfg.chip_label || row.display_name,
  };
}
