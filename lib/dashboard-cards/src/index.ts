/**
 * Canonical dashboard card registry — one definition per tile, shared by the
 * desktop dashboard and the mobile card dashboard.
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 *
 * Desktop and mobile grew as two separate dashboards with two separate card
 * lists, and by 2026-08-02 they had drifted in four distinct ways. Sal:
 * "these tiles and the display options need to match what we see on desktop".
 *
 *   1. SAME NAME, DIFFERENT WINDOW. Desktop's "Avg bill" says last 30 days;
 *      mobile's "Avg Bill" says last 12 months. One name, two numbers — the
 *      same disease @workspace/payroll-metrics was built to kill.
 *   2. SAME NAME, DIFFERENT UNIT. Desktop's "New Jobs Booked" is a COUNT of
 *      jobs; mobile's "Booked Today" is a DOLLAR figure. Similar labels, not
 *      remotely the same tile.
 *   3. STALE HARDCODED COPY. Mobile's Payroll % card read "payroll / revenue,
 *      Apr 2026" as a literal string while the server was already sending a
 *      live `payroll_window`. In August it was confidently four months wrong.
 *   4. CROSSED KEYS. Mobile's `daily_revenue` key rendered as "Completed
 *      Today" while `revenue_booked_today` rendered as "Daily Revenue" —
 *      anyone reading that code gets it backwards.
 *
 * A card's identity (key), its human label, its sub-caption and where tapping
 * it goes now live HERE, once. Surfaces still own their own layout: desktop
 * keeps its curated sections, mobile keeps its user-customizable library. What
 * they no longer own is what a tile is CALLED or what it MEANS.
 *
 * Adding a card = one entry here. Renaming one = one edit here.
 */

export type CardSection =
  | "today"          // what's happening on the board right now
  | "money"          // revenue, collections, payroll cost
  | "sales"          // leads, quotes, close rates
  | "book"           // book of business — clients, avg bill, pipeline
  | "health";        // longer-horizon business health

/** How a raw metric renders. Keeps $1,234 vs 12 vs 34% consistent everywhere. */
export type CardFormat = "money" | "money2" | "int" | "pct" | "signed_pct" | "custom";

export interface CardDef {
  /** Stable identity. Persisted in user prefs — renaming needs a LEGACY_ALIAS. */
  key: string;
  /** The one human name for this tile, on every surface. */
  label: string;
  /** Sub-caption. Undefined = no caption. Must describe the WINDOW when the
   *  metric has one, because that's where the drift hid. */
  sub?: string;
  section: CardSection;
  format: CardFormat;
  /** Where tapping/clicking the tile goes. Undefined = not navigable. */
  href?: string;
  /** True when the sub-caption is supplied at render time from live data
   *  (e.g. the payroll window) rather than being a fixed string. */
  dynamicSub?: boolean;
}

export const CARDS: CardDef[] = [
  // ── Today ───────────────────────────────────────────────────────────────
  { key: "revenue_booked_today", label: "Daily Revenue", sub: "today's scheduled jobs", section: "today", format: "money", href: "/reports/revenue" },
  { key: "jobs_today",           label: "Jobs Today",            section: "today", format: "int", href: "/dispatch" },
  { key: "jobs_scheduled_today", label: "Scheduled Today",       section: "today", format: "int", href: "/dispatch" },
  { key: "todays_status",        label: "Today's Status",        section: "today", format: "custom", href: "/dispatch" },
  { key: "unassigned_jobs",      label: "Unassigned",            section: "today", format: "int", href: "/dispatch" },
  { key: "late_clockins",        label: "Late Clock-ins", sub: "no clock-in past start +20m", section: "today", format: "int", href: "/dispatch" },
  { key: "techs_today",          label: "Techs Today",    sub: "working today", section: "today", format: "int", href: "/dispatch" },

  // ── Money ───────────────────────────────────────────────────────────────
  // [name-collision 2026-08-02] Desktop called this "New Jobs Booked" and
  // showed a COUNT; mobile called it "Booked Today" and showed DOLLARS. They
  // are two different tiles and now say so.
  { key: "jobs_newly_booked_today",    label: "New Jobs Booked", sub: "jobs booked today",    section: "money", format: "int",   href: "/reports/jobs" },
  { key: "revenue_newly_booked_today", label: "Revenue Booked Today", sub: "value of jobs booked today", section: "money", format: "money", href: "/reports/revenue" },
  { key: "daily_revenue",   label: "Completed Today", sub: "jobs marked complete", section: "money", format: "money", href: "/reports/revenue" },
  { key: "cash_collected",  label: "Cash collected",  sub: "payments received",    section: "money", format: "money", href: "/invoices" },
  { key: "monthly_revenue", label: "Monthly Revenue", sub: "month to date",        section: "money", format: "money", href: "/reports/revenue" },
  // Sub is the live window from the server — never a hardcoded month again.
  { key: "payroll_pct", label: "Payroll %", section: "money", format: "pct", href: "/reports/payroll-to-revenue", dynamicSub: true },

  // ── Sales ───────────────────────────────────────────────────────────────
  { key: "leads",              label: "Leads",            sub: "this month", section: "sales", format: "int", href: "/leads" },
  { key: "quotes",             label: "Quotes",           sub: "this month", section: "sales", format: "int", href: "/quotes" },
  { key: "closed_quotes",      label: "Closed Quotes",    sub: "won this month", section: "sales", format: "int", href: "/quotes" },
  { key: "close_rate",         label: "Close Rate",       sub: "closed / total, this month", section: "sales", format: "pct", href: "/quotes" },
  { key: "quotes_today",       label: "Quotes Given",     sub: "today", section: "sales", format: "int", href: "/quotes" },
  { key: "closed_quotes_today", label: "Closed Today",    sub: "won, of today's quotes", section: "sales", format: "int", href: "/quotes" },
  { key: "close_rate_today",   label: "Close Rate Today", sub: "closed / total, today", section: "sales", format: "pct", href: "/quotes" },
  { key: "booked_online_month", label: "Booked Online",   sub: "this month", section: "sales", format: "int", href: "/reports/jobs" },

  // ── Book of business ────────────────────────────────────────────────────
  // [window-collision 2026-08-02] "Avg bill" meant last-30-days on desktop and
  // last-12-months on mobile. Two windows is two cards; each states its own.
  // Two windows means two cards, each stating its own. Collapsing them under
  // one name is what caused the confusion; picking one silently would have
  // changed a number on somebody's screen without telling them.
  // NOTE: unverified whether desktop's figure really is a 30-day window or
  // just a mislabelled 12-month one — worth a data check before merging these.
  { key: "avg_bill_30d",  label: "Avg Bill · 30d", sub: "per job, last 30 days",   section: "book", format: "money2", href: "/reports/revenue" },
  { key: "avg_bill_12mo", label: "Avg Bill",       sub: "per job, last 12 months", section: "book", format: "money2", href: "/reports/revenue" },
  { key: "active_clients", label: "Active Clients", section: "book", format: "int", href: "/customers" },
  { key: "next_7_days",    label: "Next 7 Days", section: "book", format: "custom", href: "/dispatch" },

  // ── Health ──────────────────────────────────────────────────────────────
  { key: "rate_trend", label: "Rate Trend", sub: "avg bill, 12mo vs prior 12mo", section: "health", format: "signed_pct", href: "/reports/revenue" },
  { key: "retention",  label: "Retention",  sub: "recurring clients active", section: "health", format: "pct", href: "/reports/satisfaction" },
];

export const CARD_KEYS: string[] = CARDS.map(c => c.key);

const BY_KEY = new Map(CARDS.map(c => [c.key, c]));

/**
 * Keys that existed in saved user preferences before this registry landed.
 *
 * Card keys are persisted per user in `user_column_preferences`
 * (page='mobile_dashboard'), so a rename would silently orphan a saved layout
 * — the card would vanish from someone's dashboard with no explanation. Every
 * rename gets an alias here instead, applied on read.
 */
export const LEGACY_CARD_ALIASES: Record<string, string> = {
  // Mobile's `avg_bill` was already fed by the 12-month figure server-side; the
  // key just didn't say so, which is how it ended up colliding with desktop's
  // 30-day "Avg bill".
  avg_bill: "avg_bill_12mo",
};

/** Resolve a possibly-legacy key to its current one. */
export function canonicalCardKey(key: string): string {
  return LEGACY_CARD_ALIASES[key] ?? key;
}

/** Look up a card by key, tolerating legacy keys from saved preferences. */
export function cardDef(key: string): CardDef | undefined {
  return BY_KEY.get(canonicalCardKey(key));
}

export function cardsInSection(section: CardSection): CardDef[] {
  return CARDS.filter(c => c.section === section);
}

/**
 * Normalise a saved key list: map legacy keys forward, drop anything no longer
 * in the registry, and de-duplicate (an alias can collide with its own target
 * if a user's prefs happen to contain both).
 */
export function normalizeCardKeys(keys: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of keys) {
    const k = canonicalCardKey(raw);
    if (!BY_KEY.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

// ── Default card sets ───────────────────────────────────────────────────────
// What a user sees before they customise anything. Owners lead with money and
// sales; office leads with the board.

export const OWNER_DEFAULT_CARDS = [
  "revenue_booked_today", "jobs_newly_booked_today", "revenue_newly_booked_today",
  "jobs_today", "quotes_today", "closed_quotes_today", "close_rate_today",
  "leads", "quotes", "closed_quotes", "close_rate",
];

export const OFFICE_DEFAULT_CARDS = [
  "jobs_scheduled_today", "late_clockins", "todays_status",
  "unassigned_jobs", "techs_today", "next_7_days",
];

export function defaultCardsForRole(role: string): string[] {
  return role === "owner" ? [...OWNER_DEFAULT_CARDS] : [...OFFICE_DEFAULT_CARDS];
}

// ── Formatting ──────────────────────────────────────────────────────────────
// So a dollar renders as a dollar on both surfaces.

export function formatCardValue(value: number | null | undefined, format: CardFormat): string {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  switch (format) {
    case "money":  return `$${Math.round(n).toLocaleString("en-US")}`;
    case "money2": return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case "pct":    return `${n}%`;
    case "signed_pct": return `${n > 0 ? "+" : ""}${n}%`;
    case "int":    return String(n);
    default:       return String(n);
  }
}
