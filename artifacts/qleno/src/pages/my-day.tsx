/**
 * Cutover 1B — /my-day, the tech's now-focused day timeline.
 *
 * Design intent (from spec):
 *   The screen answers "what do I do next" before the tech reads anything.
 *   One hero (the current OR next job) with the single primary action.
 *   Earlier jobs collapse to checkmark chips. Later jobs are quiet one-line
 *   rows. Office events render in their time position, distinct from
 *   cleaning jobs. The tool is invisible — calm, glanceable, thumb-first.
 *
 * Read-only in 1B. The hero's primary action is a placeholder that
 *   routes to the (not-yet-built) 1C flow; it does NOT send anything yet.
 *   Same for any clock buttons inside the read-only job detail.
 *
 * Privacy invariant:
 *   The tech sees ONLY their own day. The /api/tech/today endpoint
 *   accepts no userId override; even owner JWTs return the owner's own
 *   day. No place on this surface (hero, detail, anywhere) ever
 *   surfaces negative feedback or complaints about the tech.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/lib/auth";
import { formatAddress } from "@/lib/format-address";
import { ChevronLeft, ChevronRight, Check, AlertTriangle, MapPin } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─────────────────────────────────────────────────────────────────────────────
// Tokens — Plus Jakarta Sans, brand palette. Mint (#00C9A0) reserved for the
// single primary action; everything else uses ink + line for calm hierarchy.
// ─────────────────────────────────────────────────────────────────────────────
const FONT = "'Plus Jakarta Sans', sans-serif";
const MINT = "#00C9A0";
const NAVY = "#0A0E1A";
const PAGE_BG = "#F7F6F3";
const SURFACE = "#FFFFFF";
const INK = "#1A1917";
const INK_MUTE = "#525252";
const INK_LIGHT = "#8B8680";
const LINE = "#E5E2DC";
const WARN_BG = "#FEF7E6";
const WARN_INK = "#B45309";
const INFO_BG = "#F1FAF7";
const INFO_INK = "#0F766E";
const SUCCESS = "#0F766E";

type Flags = {
  scope_first_time_in: boolean;
  special_equipment_needed: boolean;
  out_of_rotation: boolean;
  scope_deep_clean: boolean;
  scope_priority: boolean;
};

type TodayItem = {
  id: number;
  grouping: "done" | "current" | "next" | "later";
  display_name: string;
  service_type_slug: string | null;
  service_type_name: string | null;
  job_kind: "cleaning" | "office_event" | "meeting" | string;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  zone_name: string | null;
  scheduled_date: string;
  scheduled_time: string | null;
  allowed_hours: number | null;
  status: string;
  frequency: string | null;
  flags: Flags;
  clock_in_at: string | null;
  clock_out_at: string | null;
};

type TodayPayload = {
  date: string;
  summary: { total: number; done: number; remaining: number };
  items: TodayItem[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function formatTime(t: string | null | undefined): string {
  if (!t) return "";
  // scheduled_time on jobs is text — sometimes "09:00", sometimes
  // "9:00 AM", sometimes "HH:MM:SS". Normalize the simplest case here;
  // surface raw on anything weirder.
  const m = /^([0-9]{1,2}):([0-9]{2})/.exec(t);
  if (!m) return t;
  const hh = parseInt(m[1], 10);
  const mm = m[2];
  const ampm = hh >= 12 ? "PM" : "AM";
  const display = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
  return `${display}:${mm} ${ampm}`;
}

function joinTimeAndHours(t: string | null, hours: number | null): string {
  const time = formatTime(t);
  const hoursStr = hours != null && hours > 0 ? `${hours} hr` : "";
  return [time, hoursStr].filter(Boolean).join(" · ");
}

function mapsHref(item: TodayItem): string | null {
  const addr = formatAddress(
    item.address_street,
    item.address_city,
    item.address_state,
    item.address_zip,
  );
  if (!addr) return null;
  return `https://maps.google.com/?q=${encodeURIComponent(addr)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

function readFirstNameFromToken(token: string | null): string {
  if (!token) return "";
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return (payload?.first_name ?? "").toString().trim();
  } catch {
    return "";
  }
}

export default function MyDayPage() {
  const token = useAuthStore((s) => s.token);
  const firstName = useMemo(() => readFirstNameFromToken(token), [token]);
  const [date, setDate] = useState<string>(todayIso());

  const { data, isLoading, error } = useQuery<{ data: TodayPayload }>({
    queryKey: ["my-day", date],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/tech/today?date=${date}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`GET /api/tech/today → ${res.status}: ${txt}`);
      }
      return res.json();
    },
    enabled: !!token,
  });

  const payload = data?.data;
  const items = payload?.items ?? [];
  // Hero = current if any, else next. The server already grouped, so we
  // just pick.
  const heroItem = useMemo<TodayItem | null>(() => {
    const current = items.find((i) => i.grouping === "current");
    if (current) return current;
    const next = items.find((i) => i.grouping === "next");
    return next ?? null;
  }, [items]);
  const laterItems = items.filter((i) => i.grouping === "later");
  const doneItems = items.filter((i) => i.grouping === "done");

  const dayLabel = (() => {
    if (!payload) return "";
    const [y, m, d] = payload.date.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
  })();

  return (
    <div
      style={{
        minHeight: "100vh",
        background: PAGE_BG,
        color: INK,
        fontFamily: FONT,
        paddingBottom: 48,
      }}
    >
      <div
        style={{
          maxWidth: 560,
          margin: "0 auto",
          padding: "16px 16px 0",
        }}
      >
        <Header
          firstName={firstName}
          dayLabel={dayLabel}
          summary={payload?.summary ?? null}
          onPrev={() => setDate((d) => shiftIso(d, -1))}
          onNext={() => setDate((d) => shiftIso(d, 1))}
          isToday={date === todayIso()}
        />

        {isLoading ? (
          <Skeleton />
        ) : error ? (
          <ErrorBox message={String((error as Error).message)} />
        ) : items.length === 0 ? (
          <EmptyBox />
        ) : (
          <>
            {heroItem ? <Hero item={heroItem} /> : null}

            {laterItems.length > 0 ? (
              <Section title="Later today">
                {laterItems.map((it) => (
                  <LaterRow key={it.id} item={it} />
                ))}
              </Section>
            ) : null}

            {doneItems.length > 0 ? (
              <Section title="Done">
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {doneItems.map((it) => (
                    <DoneChip key={it.id} item={it} />
                  ))}
                </div>
              </Section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────────────────

function Header({
  firstName,
  dayLabel,
  summary,
  onPrev,
  onNext,
  isToday,
}: {
  firstName: string;
  dayLabel: string;
  summary: { total: number; done: number; remaining: number } | null;
  onPrev: () => void;
  onNext: () => void;
  isToday: boolean;
}) {
  const subtitle =
    summary == null
      ? dayLabel
      : isToday
      ? summary.total === 0
        ? `${dayLabel} · no jobs`
        : `${summary.done} done, ${summary.remaining} to go`
      : summary.total === 0
      ? `${dayLabel} · no jobs`
      : `${dayLabel} · ${summary.total} job${summary.total === 1 ? "" : "s"}`;

  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: "-0.01em",
          color: INK,
        }}
      >
        {firstName ? `Hi ${firstName}` : "Hi"}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 14,
          color: INK_MUTE,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={onPrev}
          aria-label="Previous day"
          style={stepperButtonStyle()}
        >
          <ChevronLeft size={16} />
        </button>
        <span>{subtitle}</span>
        <button
          type="button"
          onClick={onNext}
          aria-label="Next day"
          style={stepperButtonStyle()}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

function stepperButtonStyle(): React.CSSProperties {
  return {
    background: "transparent",
    border: `1px solid ${LINE}`,
    borderRadius: 999,
    width: 28,
    height: 28,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    color: INK_MUTE,
    padding: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hero — the whole point of the screen
// ─────────────────────────────────────────────────────────────────────────────

function Hero({ item }: { item: TodayItem }) {
  const isOffice = item.job_kind === "office_event" || item.job_kind === "meeting";
  const isCurrent = item.grouping === "current";
  const addr = formatAddress(
    item.address_street,
    item.address_city,
    item.address_state,
    item.address_zip,
  );
  const mapsLink = mapsHref(item);
  const cta = isCurrent
    ? "Open job"
    : isOffice
    ? "Open"
    : `I'm on my way · ~15 min`;

  // 1B placeholder: routes to a /my-jobs#job-N anchor for now so the
  // existing surface handles real interactions until 1C lands. We do NOT
  // fire any GPS, ETA, or "on my way" send here — the spec is explicit.
  const ctaHref = `${BASE}/my-jobs#job-${item.id}`;

  return (
    <article
      style={{
        background: SURFACE,
        border: `2px solid ${MINT}`,
        borderRadius: 14,
        padding: "18px 18px 16px",
        marginBottom: 22,
        boxShadow: "0 1px 2px rgba(15, 17, 23, 0.04)",
      }}
    >
      {/* "Now" badge keeps the tech anchored — same idea as the hero
          border but readable at a glance without needing to parse the
          card chrome. */}
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: SUCCESS,
          marginBottom: 8,
        }}
      >
        {isCurrent ? "In progress" : isOffice ? "Up next" : "Next"}
      </div>

      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: INK,
          letterSpacing: "-0.01em",
          lineHeight: 1.2,
        }}
      >
        {item.display_name}
      </div>

      <div
        style={{
          marginTop: 6,
          fontSize: 13,
          color: INK_MUTE,
        }}
      >
        {joinTimeAndHours(item.scheduled_time, item.allowed_hours)}
        {item.service_type_name ? ` · ${item.service_type_name}` : null}
      </div>

      <HeroFlag flags={item.flags} />

      {addr ? (
        <a
          href={mapsLink ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            marginTop: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            background: PAGE_BG,
            border: `1px solid ${LINE}`,
            borderRadius: 10,
            color: INK,
            fontSize: 14,
            textDecoration: "none",
          }}
        >
          <MapPin size={16} color={INK_MUTE} />
          <span style={{ flex: 1 }}>{addr}</span>
        </a>
      ) : null}

      {/* Single primary action — mint, full-width, thumb-reachable. */}
      <a
        href={ctaHref}
        style={{
          marginTop: 14,
          display: "block",
          width: "100%",
          padding: "14px 16px",
          background: MINT,
          color: NAVY,
          fontWeight: 700,
          fontSize: 16,
          textAlign: "center",
          textDecoration: "none",
          borderRadius: 12,
          letterSpacing: "-0.005em",
          boxSizing: "border-box",
        }}
      >
        {cta}
      </a>
    </article>
  );
}

function HeroFlag({ flags }: { flags: Flags }) {
  // Show the most important flag, alert before informational. Out-of-
  // rotation / scope_priority / scope_deep_clean don't warrant a hero
  // pill — they live in the detail view (1C+). Per spec, only first
  // time in (informational) or special equipment needed (alert) earn
  // hero billing.
  if (flags.special_equipment_needed) {
    return (
      <Pill tone="warn" icon={<AlertTriangle size={12} />}>
        Special equipment needed
      </Pill>
    );
  }
  if (flags.scope_first_time_in) {
    return <Pill tone="info">First time in</Pill>;
  }
  return null;
}

function Pill({
  tone,
  icon,
  children,
}: {
  tone: "warn" | "info";
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const bg = tone === "warn" ? WARN_BG : INFO_BG;
  const ink = tone === "warn" ? WARN_INK : INFO_INK;
  return (
    <div
      style={{
        marginTop: 10,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: bg,
        color: ink,
        fontSize: 12,
        fontWeight: 600,
        padding: "4px 8px",
        borderRadius: 999,
      }}
    >
      {icon}
      <span>{children}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sections — Later / Done / Empty / Error
// ─────────────────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: INK_LIGHT,
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {children}
    </section>
  );
}

function LaterRow({ item }: { item: TodayItem }) {
  const isOffice = item.job_kind === "office_event" || item.job_kind === "meeting";
  // 1B: tap routes to the existing /my-jobs anchor — read-only detail
  // is the spec, no new detail page yet.
  const href = `${BASE}/my-jobs#job-${item.id}`;
  return (
    <a
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        marginBottom: 6,
        background: SURFACE,
        border: `1px solid ${LINE}`,
        borderRadius: 10,
        color: INK,
        textDecoration: "none",
        fontSize: 14,
      }}
    >
      <span
        style={{
          fontSize: 12,
          color: INK_MUTE,
          minWidth: 70,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatTime(item.scheduled_time) || "—"}
      </span>
      <span style={{ flex: 1, fontWeight: 600 }}>{item.display_name}</span>
      {isOffice ? (
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: INK_LIGHT,
            background: PAGE_BG,
            padding: "2px 6px",
            borderRadius: 999,
            border: `1px solid ${LINE}`,
          }}
        >
          Office
        </span>
      ) : null}
    </a>
  );
}

function DoneChip({ item }: { item: TodayItem }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        background: SURFACE,
        border: `1px solid ${LINE}`,
        borderRadius: 999,
        fontSize: 12,
        color: INK_MUTE,
      }}
    >
      <Check size={12} color={SUCCESS} />
      <span>{item.display_name}</span>
    </div>
  );
}

function Skeleton() {
  return (
    <div
      style={{
        background: SURFACE,
        border: `1px solid ${LINE}`,
        borderRadius: 14,
        padding: 18,
        color: INK_LIGHT,
        textAlign: "center",
        fontSize: 13,
      }}
    >
      Loading your day…
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div
      style={{
        background: WARN_BG,
        border: `1px solid #FDE68A`,
        borderRadius: 10,
        padding: 14,
        color: WARN_INK,
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>
        Could not load your day
      </div>
      {message}
    </div>
  );
}

function EmptyBox() {
  return (
    <div
      style={{
        background: SURFACE,
        border: `1px solid ${LINE}`,
        borderRadius: 14,
        padding: "28px 18px",
        textAlign: "center",
        color: INK_MUTE,
        fontSize: 14,
        lineHeight: 1.55,
      }}
    >
      <div style={{ fontWeight: 700, color: INK, marginBottom: 4 }}>
        Nothing scheduled
      </div>
      No jobs on this day. Tap the arrows above to see another day.
    </div>
  );
}
