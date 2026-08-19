import type { CSSProperties, ReactNode } from "react";

// [ares-cohesion 2026-08-18] The Ares module's shared visual layer, extracted
// so the page and every tab render from ONE definition instead of each file
// re-declaring its own near-miss palette. That drift is what made Ares look
// like a different product from the rest of Qleno.
//
// Every value is a design token from index.css. No literal hexes — a hardcoded
// #00C9A0 is what made this module ignore companies.brand_color while every
// other page respected it.

export const C = {
  base:     "var(--bg-base)",
  card:     "var(--bg-card)",
  ink:      "var(--ink)",
  grey:     "var(--ink-muted)",
  faint:    "var(--ink-faint)",
  line:     "var(--border)",
  lineSoft: "var(--border-sub)",
  tint:     "var(--bg-base)",
  tint2:    "var(--bg-hover)",
  // Brand — follows applyTenantColor() at runtime.
  mint:     "var(--brand)",
  mintDeep: "var(--ok)",
  mintBg:   "var(--ok-bg)",
  // Status. index.css: "Don't add a sixth 'sort of green' — use these."
  amber:    "var(--warn)",
  amberBg:  "var(--warn-bg)",
  red:      "var(--danger)",
  redBg:    "var(--danger-bg)",
  info:     "var(--info)",
  infoBg:   "var(--info-bg)",
};

// Plus Jakarta Sans is set globally in index.css; this exists only because the
// module threads fontFamily through inline styles. Never name another font.
export const FF = "'Plus Jakarta Sans', sans-serif";

// A soft tint of any token colour, for callout backgrounds and borders.
export const soft = (token: string, pct: number) =>
  `color-mix(in srgb, ${token} ${pct}%, transparent)`;

export const money = (n: number | null | undefined) =>
  n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

export const money2 = (n: number | null | undefined) =>
  n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// [date-tz-fix] Anchor bare YYYY-MM-DD to local noon so a date-only value never
// renders a day early in US Central.
export const dateFmt = (d: string | Date | null | undefined) =>
  !d ? "—" : new Date(typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d + "T12:00:00" : d)
    .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export const titleCase = (s: string | null | undefined) =>
  (s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

export function card(): CSSProperties {
  return {
    background: C.card, border: `1px solid ${C.line}`, borderRadius: 14,
    boxShadow: "0 1px 2px rgba(20,18,14,.04), 0 10px 30px rgba(20,18,14,.05)",
  };
}

export function eyebrow(): CSSProperties {
  return {
    fontSize: 11, fontWeight: 800, letterSpacing: ".07em",
    textTransform: "uppercase", color: C.faint,
  };
}

// ── Status vocabulary ────────────────────────────────────────────────────────
// One definition for how every commission status reads and looks. A status that
// means "money is coming back" must never render the same as one that means
// "money is going out" — that is the whole point of keeping this in one place.
export const STATUS_META: Record<string, { label: string; fg: string; bg: string }> = {
  earned:               { label: "Earned",               fg: C.grey,     bg: C.tint2 },
  pending_review:       { label: "Pending review",       fg: C.amber,    bg: C.amberBg },
  approved:             { label: "Approved",             fg: C.mintDeep, bg: C.mintBg },
  paid:                 { label: "Paid",                 fg: C.mintDeep, bg: C.mintBg },
  rejected:             { label: "Rejected",             fg: C.red,      bg: C.redBg },
  not_eligible:         { label: "Not eligible",         fg: C.grey,     bg: C.tint2 },
  on_hold:              { label: "On hold — paused",     fg: C.info,     bg: C.infoBg },
  chargeback_pending:   { label: "Chargeback pending",   fg: C.amber,    bg: C.amberBg },
  chargeback_confirmed: { label: "Chargeback confirmed", fg: C.red,      bg: C.redBg },
  charged_back:         { label: "Disputed by VA",       fg: C.info,     bg: C.infoBg },
  recouped:             { label: "Recouped",             fg: C.grey,     bg: C.tint2 },
};

export function StatusChip({ status, suffix }: { status: string; suffix?: string | null }) {
  const m = STATUS_META[status] ?? { label: titleCase(status), fg: C.grey, bg: C.tint2 };
  return (
    <span style={{
      background: m.bg, color: m.fg, borderRadius: 999, padding: "3px 11px",
      fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", display: "inline-block",
    }}>
      {m.label}{suffix ? ` — ${suffix}` : ""}
    </span>
  );
}

// A number that carries no colour of its own. index.css: "A KPI value always
// renders --ink; if it needs to signal good/bad, that goes on the delta chip."
export function Stat({ value, label, sub, tone }: {
  value: ReactNode; label: string; sub?: ReactNode; tone?: "muted";
}) {
  return (
    <div style={{ flex: 1, minWidth: 150, padding: "0 18px", borderLeft: `1px solid ${C.lineSoft}` }}>
      <div style={{
        fontSize: 30, fontWeight: 800, letterSpacing: "-.03em", lineHeight: 1.05,
        color: tone === "muted" ? C.faint : C.ink,
      }}>{value}</div>
      <div style={{ ...eyebrow(), marginTop: 7 }}>{label}</div>
      {sub != null && <div style={{ fontSize: 12, color: C.grey, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

export function Callout({ tone, children }: { tone: "warn" | "danger" | "ok" | "info"; children: ReactNode }) {
  const map = {
    warn:   { fg: C.amber,    bg: C.amberBg, token: "var(--warn)" },
    danger: { fg: C.red,      bg: C.redBg,   token: "var(--danger)" },
    ok:     { fg: C.mintDeep, bg: C.mintBg,  token: "var(--ok)" },
    info:   { fg: C.info,     bg: C.infoBg,  token: "var(--info)" },
  }[tone];
  return (
    <div style={{
      background: map.bg, border: `1px solid ${soft(map.token, 28)}`, borderRadius: 14,
      padding: "14px 18px", color: map.fg, fontSize: 13.5, fontWeight: 600, marginBottom: 16,
    }}>{children}</div>
  );
}

// A failed money fetch must never render as $0 — a broken report that looks
// like a collected book is the failure mode _shared.tsx's ReportError exists to
// prevent, and it applies here too.
export function LoadError({ what, error }: { what: string; error: string }) {
  return <Callout tone="danger">Couldn't load {what}: {error}. Try refreshing — if it persists, tell me.</Callout>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div style={{ ...card(), padding: "40px 28px", textAlign: "center", color: C.grey, fontSize: 13.5 }}>
      {children}
    </div>
  );
}

export function btn(kind: "primary" | "ghost" | "danger" = "ghost"): CSSProperties {
  const base: CSSProperties = {
    appearance: "none", font: "inherit", fontWeight: 700, fontSize: 13,
    borderRadius: "var(--radius-control)", padding: "7px 14px", cursor: "pointer",
    whiteSpace: "nowrap",
  };
  if (kind === "primary") return { ...base, background: C.mint, color: "var(--night)", border: `1px solid ${C.mint}` };
  if (kind === "danger") return { ...base, background: C.redBg, color: C.red, border: `1px solid ${soft("var(--danger)", 30)}` };
  return { ...base, background: C.card, color: C.ink, border: `1px solid ${C.line}` };
}

export function th(): CSSProperties {
  return {
    ...eyebrow(), textAlign: "left", padding: "10px 14px",
    borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap",
  };
}

export function td(): CSSProperties {
  return { padding: "12px 14px", borderBottom: `1px solid ${C.lineSoft}`, fontSize: 13.5, verticalAlign: "middle" };
}
