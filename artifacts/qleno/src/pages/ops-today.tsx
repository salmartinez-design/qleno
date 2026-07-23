/**
 * Cutover 1D — Office command-center surface at /ops/today.
 *
 * The first owner-facing demo proof point of the cutover. Above-the-fold
 * answers "is today okay" in one glance; below-the-fold gives the full
 * workhorse list, exception queue, and clock-correction modal.
 *
 * Design philosophy flips here vs the tech surface. The tech surface is
 * invisible (one primary action, calm); the owner surface is confident
 * and distinctive. Mint accent is reserved for the "alive" signals
 * (on-shift count, in-progress pill); red is for the exception count
 * and late count; calm grays for everything else.
 *
 * Polls on focus every 30 s.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/lib/auth";
import { formatAddress } from "@/lib/format-address";
import { AlertTriangle, CheckCircle2, Circle, MapPin, X, ChevronRight } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─────────────────────────────────────────────────────────────────────────────
// Tokens (owner-side: confident, denser, distinctive)
// ─────────────────────────────────────────────────────────────────────────────
const FONT = "'Plus Jakarta Sans', sans-serif";
const MINT = "var(--brand)";
const NAVY = "#0A0E1A";
const PAGE_BG = "#F7F6F3";
const SURFACE = "#FFFFFF";
const INK = "#1A1917";
const INK_MUTE = "#525252";
const INK_LIGHT = "#8B8680";
const LINE = "#E5E2DC";
const RED_BG = "#FEEEEE";
const RED_INK = "#B91C1C";
const AMBER_BG = "#FEF7E6";
const AMBER_INK = "#B45309";
const MINT_BG = "#E6FAF4";
const MINT_INK = "#0F766E";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Summary = {
  date: string;
  on_shift_now: number;
  jobs_in_progress: number;
  jobs_complete_today: number;
  jobs_pending_later_today: number;
  gps_exceptions_awaiting_review: number;
  late_arrivals_today: number;
};

type ActiveJob = {
  id: number;
  tech_user_id: number | null;
  tech_name: string | null;
  client_display_name: string;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  service_type_name: string | null;
  scheduled_date: string;
  scheduled_time: string | null;
  allowed_hours: number | null;
  status: string;
  job_kind: string | null;
  clock_in_at: string | null;
  clock_in_event_id: number | null;
  clock_in_within_geofence: boolean | null;
  clock_in_gps_status: string | null;
  is_late: boolean;
  minutes_late: number | null;
  has_unreviewed_exception: boolean;
};

type Exception = {
  id: number;
  job_id: number;
  scheduled_date: string;
  event_type: "clock_in" | "clock_out";
  event_at: string;
  exception_reason: string | null;
  exception_photo_url: string | null;
  tech_user_id: number | null;
  tech_name: string | null;
  client_display_name: string;
};

type Filter = "all" | "in_progress" | "late" | "exceptions" | "complete" | "pending";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatScheduledTime(t: string | null): string {
  if (!t) return "—";
  const m = /^(\d{1,2}):(\d{2})/.exec(t.trim());
  if (!m) return t;
  const hh = parseInt(m[1], 10);
  const mm = m[2];
  const ampm = hh >= 12 ? "PM" : "AM";
  const display = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
  return `${display}:${mm} ${ampm}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function OpsTodayPage() {
  const token = useAuthStore((s) => s.token);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState<string>("");
  const [drawerJobId, setDrawerJobId] = useState<number | null>(null);
  const [correctionEvent, setCorrectionEvent] = useState<{
    job_id: number;
    event_id: number;
    event_at: string;
    label: string;
  } | null>(null);
  const date = todayIso();

  // Polling: refetch every 30 s while the page is in focus. tanstack
  // already handles refetchOnWindowFocus; combine with refetchInterval
  // for live workday tracking.
  const summary = useQuery<{ data: Summary }>({
    queryKey: ["ops-summary", date],
    queryFn: () => fetchJson(token, `/api/ops/today/summary?date=${date}`),
    enabled: !!token,
    refetchInterval: 30_000,
  });

  const activeJobs = useQuery<{ data: ActiveJob[] }>({
    queryKey: ["ops-active-jobs", date, filter, query],
    queryFn: () =>
      fetchJson(
        token,
        `/api/ops/today/active-jobs?date=${date}&filter=${filter}&q=${encodeURIComponent(query)}`,
      ),
    enabled: !!token,
    refetchInterval: 30_000,
  });

  const exceptions = useQuery<{ data: Exception[] }>({
    queryKey: ["ops-exceptions"],
    queryFn: () => fetchJson(token, `/api/ops/today/exceptions`),
    enabled: !!token,
    refetchInterval: 30_000,
  });

  return (
    <div
      style={{
        minHeight: "100vh",
        background: PAGE_BG,
        color: INK,
        fontFamily: FONT,
        paddingBottom: 64,
      }}
    >
      <div
        style={{
          maxWidth: 1280,
          margin: "0 auto",
          padding: "28px 28px 0",
        }}
      >
        <PageHeader date={date} />

        {/* Section 1 — summary strip */}
        <SummaryStrip
          loading={summary.isLoading}
          summary={summary.data?.data ?? null}
          activeFilter={filter}
          onSelect={setFilter}
        />

        {/* Section 3 — active jobs list (workhorse) */}
        <section style={{ marginTop: 28 }}>
          <SectionHeader
            label="Active jobs"
            right={
              <FilterRow
                value={filter}
                onChange={setFilter}
                query={query}
                onQueryChange={setQuery}
              />
            }
          />
          <ActiveJobList
            loading={activeJobs.isLoading}
            jobs={activeJobs.data?.data ?? []}
            onOpenDetail={setDrawerJobId}
            onCorrectClock={(j) => {
              if (j.clock_in_event_id && j.clock_in_at) {
                setCorrectionEvent({
                  job_id: j.id,
                  event_id: j.clock_in_event_id,
                  event_at: j.clock_in_at,
                  label: `Clock-in for ${j.client_display_name}`,
                });
              }
            }}
          />
        </section>

        {/* Section 4 — exception review queue */}
        <section style={{ marginTop: 28 }}>
          <SectionHeader
            label={`GPS exception review queue${exceptions.data?.data?.length ? ` · ${exceptions.data.data.length}` : ""}`}
          />
          <ExceptionQueue
            token={token}
            loading={exceptions.isLoading}
            rows={exceptions.data?.data ?? []}
            onOpenJob={setDrawerJobId}
            onCorrectClock={(e) =>
              setCorrectionEvent({
                job_id: e.job_id,
                event_id: e.id,
                event_at: e.event_at,
                label: `${e.event_type === "clock_in" ? "Clock-in" : "Clock-out"} exception for ${e.client_display_name}`,
              })
            }
            onReviewed={() => exceptions.refetch()}
          />
        </section>
      </div>

      {drawerJobId != null ? (
        <JobDetailDrawer
          token={token}
          jobId={drawerJobId}
          onClose={() => setDrawerJobId(null)}
          onCorrectClock={(eventId, eventAt, eventType) => {
            setCorrectionEvent({
              job_id: drawerJobId,
              event_id: eventId,
              event_at: eventAt,
              label: eventType === "clock_in" ? "Clock-in" : "Clock-out",
            });
          }}
        />
      ) : null}

      {correctionEvent ? (
        <CorrectionModal
          token={token}
          payload={correctionEvent}
          onClose={() => setCorrectionEvent(null)}
          onSubmitted={() => {
            setCorrectionEvent(null);
            activeJobs.refetch();
            exceptions.refetch();
          }}
        />
      ) : null}
    </div>
  );
}

async function fetchJson<T>(token: string | null, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`${path} → ${res.status}: ${t}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────────────────

function PageHeader({ date }: { date: string }) {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const label = dt.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: INK_LIGHT,
        }}
      >
        Today · live
      </div>
      <h1
        style={{
          margin: "4px 0 0",
          fontSize: 32,
          fontWeight: 700,
          letterSpacing: "-0.01em",
          color: INK,
        }}
      >
        Ops · {label}
      </h1>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary strip — Section 1
// ─────────────────────────────────────────────────────────────────────────────

function SummaryStrip({
  loading,
  summary,
  activeFilter,
  onSelect,
}: {
  loading: boolean;
  summary: Summary | null;
  activeFilter: Filter;
  onSelect: (f: Filter) => void;
}) {
  const tiles: Array<{
    label: string;
    value: number;
    tone: "mint" | "ink" | "amber" | "red";
    filter?: Filter;
  }> = [
    { label: "On shift now", value: summary?.on_shift_now ?? 0, tone: "mint", filter: "in_progress" },
    { label: "Jobs in progress", value: summary?.jobs_in_progress ?? 0, tone: "mint", filter: "in_progress" },
    { label: "Complete today", value: summary?.jobs_complete_today ?? 0, tone: "ink", filter: "complete" },
    { label: "Pending later", value: summary?.jobs_pending_later_today ?? 0, tone: "ink", filter: "pending" },
    {
      label: "GPS exceptions",
      value: summary?.gps_exceptions_awaiting_review ?? 0,
      tone: (summary?.gps_exceptions_awaiting_review ?? 0) > 0 ? "red" : "ink",
      filter: "exceptions",
    },
    {
      label: "Late arrivals",
      value: summary?.late_arrivals_today ?? 0,
      tone: (summary?.late_arrivals_today ?? 0) > 0 ? "red" : "ink",
      filter: "late",
    },
  ];
  return (
    <div
      style={{
        marginTop: 22,
        display: "grid",
        gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
        gap: 12,
      }}
    >
      {tiles.map((t) => (
        <SummaryTile
          key={t.label}
          label={t.label}
          value={loading ? 0 : t.value}
          tone={t.tone}
          active={t.filter === activeFilter}
          onClick={t.filter ? () => onSelect(t.filter!) : undefined}
        />
      ))}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone: "mint" | "ink" | "amber" | "red";
  active: boolean;
  onClick?: () => void;
}) {
  const valueColor =
    tone === "mint" ? MINT_INK : tone === "red" ? RED_INK : tone === "amber" ? AMBER_INK : INK;
  const accent =
    tone === "mint" ? MINT : tone === "red" ? RED_INK : tone === "amber" ? AMBER_INK : LINE;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: "left",
        background: SURFACE,
        border: `1px solid ${active ? accent : LINE}`,
        borderRadius: 12,
        padding: "14px 16px",
        cursor: onClick ? "pointer" : "default",
        boxShadow: active ? `0 0 0 3px ${accent}22` : "none",
        transition: "border-color 0.15s, box-shadow 0.15s",
        fontFamily: FONT,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: INK_LIGHT,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 30,
          fontWeight: 700,
          letterSpacing: "-0.01em",
          color: valueColor,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section header + filter row
// ─────────────────────────────────────────────────────────────────────────────

function SectionHeader({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
        marginBottom: 10,
      }}
    >
      <h2
        style={{
          margin: 0,
          fontSize: 18,
          fontWeight: 700,
          color: INK,
          letterSpacing: "-0.005em",
        }}
      >
        {label}
      </h2>
      {right}
    </div>
  );
}

function FilterRow({
  value,
  onChange,
  query,
  onQueryChange,
}: {
  value: Filter;
  onChange: (f: Filter) => void;
  query: string;
  onQueryChange: (q: string) => void;
}) {
  const pills: Array<{ key: Filter; label: string }> = [
    { key: "all", label: "All" },
    { key: "in_progress", label: "In progress" },
    { key: "late", label: "Late" },
    { key: "exceptions", label: "Exceptions" },
    { key: "complete", label: "Complete" },
    { key: "pending", label: "Pending" },
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {pills.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => onChange(p.key)}
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            border: `1px solid ${value === p.key ? INK : LINE}`,
            background: value === p.key ? INK : SURFACE,
            color: value === p.key ? "#FFFFFF" : INK,
            fontWeight: 600,
            fontSize: 12,
            cursor: "pointer",
            fontFamily: FONT,
          }}
        >
          {p.label}
        </button>
      ))}
      <input
        type="search"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search tech or client"
        style={{
          marginLeft: 8,
          padding: "6px 10px",
          border: `1px solid ${LINE}`,
          borderRadius: 8,
          fontSize: 13,
          fontFamily: FONT,
          background: SURFACE,
          color: INK,
          minWidth: 200,
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Active jobs list — Section 3
// ─────────────────────────────────────────────────────────────────────────────

function ActiveJobList({
  loading,
  jobs,
  onOpenDetail,
  onCorrectClock,
}: {
  loading: boolean;
  jobs: ActiveJob[];
  onOpenDetail: (jobId: number) => void;
  onCorrectClock: (job: ActiveJob) => void;
}) {
  if (loading && jobs.length === 0) {
    return <Empty>Loading…</Empty>;
  }
  if (jobs.length === 0) return <Empty>No jobs match this filter.</Empty>;
  return (
    <div
      style={{
        background: SURFACE,
        border: `1px solid ${LINE}`,
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      {jobs.map((j, idx) => (
        <ActiveJobRow
          key={j.id}
          job={j}
          isFirst={idx === 0}
          onOpenDetail={() => onOpenDetail(j.id)}
          onCorrectClock={() => onCorrectClock(j)}
        />
      ))}
    </div>
  );
}

function ActiveJobRow({
  job,
  isFirst,
  onOpenDetail,
  onCorrectClock,
}: {
  job: ActiveJob;
  isFirst: boolean;
  onOpenDetail: () => void;
  onCorrectClock: () => void;
}) {
  const addr = formatAddress(job.address_street, job.address_city, job.address_state, job.address_zip);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "200px 1fr 140px 140px 200px",
        gap: 12,
        alignItems: "center",
        padding: "14px 18px",
        borderTop: isFirst ? "none" : `1px solid ${LINE}`,
        background: job.is_late || job.has_unreviewed_exception ? "#FFFCF7" : SURFACE,
      }}
    >
      <div>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{job.tech_name ?? "Unassigned"}</div>
        <div style={{ fontSize: 12, color: INK_MUTE, marginTop: 2 }}>
          {formatScheduledTime(job.scheduled_time)}
          {job.allowed_hours ? ` · ${job.allowed_hours} hr` : ""}
        </div>
      </div>
      <div>
        <div style={{ fontWeight: 600, fontSize: 14, color: INK }}>{job.client_display_name}</div>
        {addr ? (
          <div
            style={{
              fontSize: 12,
              color: INK_MUTE,
              marginTop: 2,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <MapPin size={11} />
            {addr}
          </div>
        ) : null}
      </div>
      <div>
        <ClockInBadge
          clockInAt={job.clock_in_at}
          isLate={job.is_late}
          minutesLate={job.minutes_late}
          status={job.status}
        />
      </div>
      <div>
        <GeofenceIndicator
          within={job.clock_in_within_geofence}
          gpsStatus={job.clock_in_gps_status}
        />
        {job.has_unreviewed_exception ? (
          <div
            style={{
              marginTop: 4,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: RED_BG,
              color: RED_INK,
              padding: "2px 6px",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            <AlertTriangle size={10} />
            Exception
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onCorrectClock}
          disabled={!job.clock_in_event_id}
          style={ghostButton(!job.clock_in_event_id)}
        >
          Correct clock
        </button>
        <button type="button" onClick={onOpenDetail} style={primaryButton()}>
          View job
          <ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
}

function ClockInBadge({
  clockInAt,
  isLate,
  minutesLate,
  status,
}: {
  clockInAt: string | null;
  isLate: boolean;
  minutesLate: number | null;
  status: string;
}) {
  if (clockInAt) {
    return (
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>
          {formatTime(clockInAt)}
        </div>
        <div
          style={{
            display: "inline-block",
            marginTop: 4,
            padding: "2px 8px",
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 700,
            background: isLate ? RED_BG : MINT_BG,
            color: isLate ? RED_INK : MINT_INK,
          }}
        >
          {isLate ? `Late · ${minutesLate ?? "?"} min` : status === "complete" ? "Done" : "On time"}
        </div>
      </div>
    );
  }
  return (
    <div
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        background: isLate ? RED_BG : "#F4F4F1",
        color: isLate ? RED_INK : INK_MUTE,
      }}
    >
      {isLate ? "Late — not clocked in" : "Not clocked in"}
    </div>
  );
}

function GeofenceIndicator({
  within,
  gpsStatus,
}: {
  within: boolean | null;
  gpsStatus: string | null;
}) {
  if (gpsStatus === "failed_exception") {
    return (
      <Indicator color={RED_INK} bg={RED_BG} label="GPS failed">
        <X size={12} />
      </Indicator>
    );
  }
  if (within === true) {
    return (
      <Indicator color={MINT_INK} bg={MINT_BG} label="On site">
        <CheckCircle2 size={12} />
      </Indicator>
    );
  }
  if (within === false) {
    return (
      <Indicator color={AMBER_INK} bg={AMBER_BG} label="Off site">
        <Circle size={12} />
      </Indicator>
    );
  }
  return (
    <Indicator color={INK_LIGHT} bg="#F4F4F1" label="No site coords">
      <Circle size={12} />
    </Indicator>
  );
}

function Indicator({
  color,
  bg,
  label,
  children,
}: {
  color: string;
  bg: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        background: bg,
        color: color,
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {children}
      <span>{label}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Exception queue — Section 4
// ─────────────────────────────────────────────────────────────────────────────

function ExceptionQueue({
  token,
  loading,
  rows,
  onOpenJob,
  onCorrectClock,
  onReviewed,
}: {
  token: string | null;
  loading: boolean;
  rows: Exception[];
  onOpenJob: (id: number) => void;
  onCorrectClock: (e: Exception) => void;
  onReviewed: () => void;
}) {
  const review = useMutation({
    mutationFn: async (eventId: number) => {
      const res = await fetch(`${BASE}/api/office/clock-exceptions/${eventId}/review`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token ? `Bearer ${token}` : "",
        },
        body: "{}",
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Review failed → ${res.status}: ${t}`);
      }
      return res.json();
    },
    onSuccess: () => onReviewed(),
  });

  if (loading && rows.length === 0) return <Empty>Loading…</Empty>;
  if (rows.length === 0) {
    return (
      <Empty>
        <CheckCircle2 size={18} style={{ color: MINT_INK, marginBottom: 6 }} />
        <div>No exceptions awaiting review.</div>
      </Empty>
    );
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {rows.map((r) => (
        <article
          key={r.id}
          style={{
            background: SURFACE,
            border: `1px solid ${LINE}`,
            borderLeft: `4px solid ${RED_INK}`,
            borderRadius: 10,
            padding: "14px 16px",
            display: "grid",
            gridTemplateColumns: "auto 1fr auto",
            gap: 14,
            alignItems: "start",
          }}
        >
          {r.exception_photo_url ? (
            <img
              src={r.exception_photo_url}
              alt="entry photo"
              style={{
                width: 72,
                height: 72,
                objectFit: "cover",
                borderRadius: 8,
                border: `1px solid ${LINE}`,
              }}
            />
          ) : (
            <div
              style={{
                width: 72,
                height: 72,
                borderRadius: 8,
                background: "#F4F4F1",
                display: "grid",
                placeItems: "center",
                color: INK_LIGHT,
                fontSize: 10,
              }}
            >
              no photo
            </div>
          )}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{r.tech_name ?? "Unknown tech"}</div>
              <div style={{ color: INK_LIGHT, fontSize: 12 }}>·</div>
              <div style={{ fontSize: 13, color: INK_MUTE }}>{r.client_display_name}</div>
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: INK_LIGHT, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {r.event_type === "clock_in" ? "Clock-in" : "Clock-out"} · {formatTime(r.event_at)}
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 13,
                color: INK,
                lineHeight: 1.5,
                wordBreak: "break-word",
              }}
            >
              {r.exception_reason ?? "(no reason captured)"}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button type="button" onClick={() => review.mutate(r.id)} style={primaryButton()} disabled={review.isPending}>
              {review.isPending ? "…" : "Mark reviewed"}
            </button>
            <button type="button" onClick={() => onOpenJob(r.job_id)} style={ghostButton()}>
              Open job
            </button>
            <button type="button" onClick={() => onCorrectClock(r)} style={ghostButton()}>
              Correct clock
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Job detail drawer + clock timeline (shows corrections inline)
// ─────────────────────────────────────────────────────────────────────────────

type Detail = {
  job: any;
  worksheet: any;
  clock_timeline: any[];
  photos: any[];
  notes: any[];
};

function JobDetailDrawer({
  token,
  jobId,
  onClose,
  onCorrectClock,
}: {
  token: string | null;
  jobId: number;
  onClose: () => void;
  onCorrectClock: (eventId: number, eventAt: string, eventType: "clock_in" | "clock_out") => void;
}) {
  const detail = useQuery<{ data: Detail }>({
    queryKey: ["ops-job-detail", jobId],
    queryFn: () => fetchJson(token, `/api/ops/jobs/${jobId}/detail`),
    enabled: !!token,
  });
  const d = detail.data?.data;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,15,15,0.4)",
        zIndex: 1000,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 100vw)",
          height: "100vh",
          background: PAGE_BG,
          padding: "24px 28px",
          overflowY: "auto",
          boxShadow: "-4px 0 16px rgba(0,0,0,0.08)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Job detail</h2>
          <button type="button" onClick={onClose} style={ghostButton()}>
            Close
          </button>
        </div>
        {detail.isLoading || !d ? (
          <div style={{ marginTop: 24, color: INK_MUTE }}>Loading…</div>
        ) : (
          <>
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{d.job.client_display_name}</div>
              <div style={{ fontSize: 13, color: INK_MUTE, marginTop: 2 }}>
                {formatScheduledTime(d.job.scheduled_time)} · {d.job.allowed_hours ?? "?"} hr · {d.job.tech_name ?? "Unassigned"}
              </div>
              <div style={{ marginTop: 6, fontSize: 13, color: INK_MUTE }}>
                {formatAddress(d.job.address_street, d.job.address_city, d.job.address_state, d.job.address_zip)}
              </div>
            </div>

            <Section title="Clock timeline">
              <ClockTimeline
                events={d.clock_timeline}
                onCorrect={(eventId, eventAt, eventType) => onCorrectClock(eventId, eventAt, eventType)}
              />
            </Section>

            {d.worksheet ? (
              <Section title="Worksheet">
                <WorksheetView w={d.worksheet} />
              </Section>
            ) : null}

            {d.photos?.length ? (
              <Section title={`Photos · ${d.photos.length}`}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                  {d.photos.map((p: any) => (
                    <img
                      key={p.id}
                      src={p.url}
                      alt={p.photo_type}
                      style={{
                        width: "100%",
                        aspectRatio: "1",
                        objectFit: "cover",
                        borderRadius: 8,
                        border: `1px solid ${LINE}`,
                      }}
                    />
                  ))}
                </div>
              </Section>
            ) : null}

            {d.notes?.length ? (
              <Section title={`Technician notes · ${d.notes.length}`}>
                <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
                  {d.notes.map((n: any) => (
                    <li
                      key={n.id}
                      style={{
                        background: SURFACE,
                        border: `1px solid ${LINE}`,
                        borderRadius: 8,
                        padding: "10px 12px",
                        fontSize: 13,
                        color: INK,
                        lineHeight: 1.5,
                      }}
                    >
                      <div style={{ fontSize: 11, color: INK_LIGHT, marginBottom: 4 }}>
                        {formatTime(n.created_at)}
                      </div>
                      {n.body}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}
          </>
        )}
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 24 }}>
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

function WorksheetView({ w }: { w: any }) {
  const rows: Array<[string, string]> = [
    ["Service set", w.service_set_name ?? "—"],
    ["Bedrooms", w.bedrooms != null ? String(w.bedrooms) : "—"],
    ["Full baths", w.full_baths != null ? String(w.full_baths) : "—"],
    ["Half baths", w.half_baths != null ? String(w.half_baths) : "—"],
    ["Next job", w.next_job_date ?? "—"],
  ];
  const flags: Array<[string, boolean]> = [
    ["Deep clean", w.scope_deep_clean],
    ["First time in", w.scope_first_time_in],
    ["Priority", w.scope_priority],
    ["Special equipment", w.special_equipment_needed],
  ];
  return (
    <div
      style={{
        background: SURFACE,
        border: `1px solid ${LINE}`,
        borderRadius: 10,
        padding: "12px 14px",
        fontSize: 13,
        color: INK,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 }}>
        {rows.map(([k, v]) => (
          <div key={k}>
            <span style={{ color: INK_LIGHT }}>{k}: </span>
            <span style={{ fontWeight: 600 }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
        {flags
          .filter(([, v]) => v)
          .map(([k]) => (
            <span
              key={k}
              style={{
                padding: "3px 8px",
                background: AMBER_BG,
                color: AMBER_INK,
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {k}
            </span>
          ))}
      </div>
      {w.directions_text ? (
        <div style={{ marginTop: 10, fontSize: 13, color: INK, lineHeight: 1.55 }}>
          <div style={{ fontSize: 11, color: INK_LIGHT, marginBottom: 4 }}>Directions</div>
          {w.directions_text}
        </div>
      ) : null}
    </div>
  );
}

function ClockTimeline({
  events,
  onCorrect,
}: {
  events: any[];
  onCorrect: (eventId: number, eventAt: string, eventType: "clock_in" | "clock_out") => void;
}) {
  if (!events?.length) return <div style={{ color: INK_MUTE, fontSize: 13 }}>No clock events yet.</div>;

  return (
    <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
      {events.map((e) => {
        const isCorrection = !!e.is_correction;
        const isException = e.gps_status === "failed_exception";
        return (
          <li
            key={e.id}
            style={{
              background: SURFACE,
              border: `1px solid ${LINE}`,
              borderLeft: `4px solid ${
                isException ? RED_INK : isCorrection ? AMBER_INK : MINT_INK
              }`,
              borderRadius: 8,
              padding: "10px 12px",
              fontSize: 13,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 700 }}>
                  {e.event_type === "clock_in" ? "Clock-in" : "Clock-out"}
                  {isCorrection ? " · CORRECTION" : ""}
                </div>
                <div style={{ fontSize: 12, color: INK_MUTE, marginTop: 2 }}>{formatTime(e.event_at)}</div>
              </div>
              <button
                type="button"
                onClick={() => onCorrect(e.id, e.event_at, e.event_type)}
                style={ghostButton()}
              >
                Correct
              </button>
            </div>
            {isException ? (
              <div
                style={{
                  marginTop: 8,
                  background: RED_BG,
                  color: RED_INK,
                  borderRadius: 6,
                  padding: "8px 10px",
                  fontSize: 12,
                }}
              >
                <strong>Exception:</strong> {e.exception_reason ?? "(no reason)"}
                {e.exception_reviewed_at ? (
                  <span style={{ marginLeft: 6, fontWeight: 600 }}>· reviewed</span>
                ) : null}
              </div>
            ) : (
              <div style={{ marginTop: 6, fontSize: 12, color: INK_MUTE }}>
                {e.within_geofence === true
                  ? "On site"
                  : e.within_geofence === false
                  ? "Off site"
                  : "No geofence comparison"}
                {e.distance_from_site_meters != null
                  ? ` · ${Math.round(e.distance_from_site_meters)} m from site`
                  : ""}
              </div>
            )}
            {isCorrection && e.correction_old_value ? (
              <div
                style={{
                  marginTop: 8,
                  background: "#FFFBF0",
                  border: `1px dashed ${AMBER_INK}55`,
                  color: AMBER_INK,
                  fontSize: 11,
                  padding: "6px 10px",
                  borderRadius: 6,
                  lineHeight: 1.45,
                }}
              >
                Original event #{e.correction_of_event_id} preserved · prior time{" "}
                {e.correction_old_value.event_at
                  ? formatTime(typeof e.correction_old_value.event_at === "string" ? e.correction_old_value.event_at : new Date(e.correction_old_value.event_at).toISOString())
                  : "—"}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Correction modal — calls POST /api/office/jobs/:jobId/clock-correction
// ─────────────────────────────────────────────────────────────────────────────

function CorrectionModal({
  token,
  payload,
  onClose,
  onSubmitted,
}: {
  token: string | null;
  payload: { job_id: number; event_id: number; event_at: string; label: string };
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [newEventAt, setNewEventAt] = useState<string>(() => {
    const d = new Date(payload.event_at);
    // datetime-local input wants YYYY-MM-DDTHH:MM (no seconds/tz)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  });
  const [reason, setReason] = useState("");
  const queryClient = useQueryClient();
  const submit = useMutation({
    mutationFn: async () => {
      const correctedIso = new Date(newEventAt).toISOString();
      const res = await fetch(`${BASE}/api/office/jobs/${payload.job_id}/clock-correction`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token ? `Bearer ${token}` : "",
        },
        body: JSON.stringify({
          correction_of_event_id: payload.event_id,
          corrected_values: { event_at: correctedIso },
          reason: reason.trim(),
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Correction failed → ${res.status}: ${t}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ops-job-detail", payload.job_id] });
      onSubmitted();
    },
  });
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,15,15,0.4)",
        zIndex: 1100,
        display: "grid",
        placeItems: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: SURFACE,
          border: `1px solid ${LINE}`,
          borderRadius: 12,
          padding: "22px 24px",
          width: "min(480px, 92vw)",
          fontFamily: FONT,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Correct clock</h2>
        <div style={{ marginTop: 4, fontSize: 13, color: INK_MUTE }}>
          {payload.label} · original {formatTime(payload.event_at)}
        </div>
        <div
          style={{
            marginTop: 12,
            background: AMBER_BG,
            color: AMBER_INK,
            padding: "10px 12px",
            borderRadius: 8,
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          Corrections create a NEW audit event. The original event is preserved and remains visible
          in the clock timeline. Both will be shown after submission.
        </div>
        <label style={{ display: "block", marginTop: 14, fontSize: 12, fontWeight: 600, color: INK_MUTE }}>
          Corrected time
          <input
            type="datetime-local"
            value={newEventAt}
            onChange={(e) => setNewEventAt(e.target.value)}
            style={{
              display: "block",
              marginTop: 4,
              width: "100%",
              padding: "8px 10px",
              border: `1px solid ${LINE}`,
              borderRadius: 8,
              fontSize: 14,
              fontFamily: FONT,
            }}
          />
        </label>
        <label style={{ display: "block", marginTop: 12, fontSize: 12, fontWeight: 600, color: INK_MUTE }}>
          Reason (audit trail)
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. tech texted to say GPS denied and forgot to clock in until 9:42"
            rows={3}
            style={{
              display: "block",
              marginTop: 4,
              width: "100%",
              padding: "8px 10px",
              border: `1px solid ${LINE}`,
              borderRadius: 8,
              fontSize: 13,
              fontFamily: FONT,
              resize: "vertical",
            }}
          />
        </label>
        {submit.isError ? (
          <div
            style={{
              marginTop: 10,
              background: RED_BG,
              color: RED_INK,
              padding: "8px 10px",
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            {(submit.error as Error).message}
          </div>
        ) : null}
        <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} style={ghostButton()} disabled={submit.isPending}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => submit.mutate()}
            disabled={!reason.trim() || submit.isPending}
            style={primaryButton(!reason.trim() || submit.isPending)}
          >
            {submit.isPending ? "Submitting…" : "Submit correction"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Atoms
// ─────────────────────────────────────────────────────────────────────────────

function primaryButton(disabled?: boolean): React.CSSProperties {
  return {
    background: disabled ? "#A3A199" : INK,
    color: "#FFFFFF",
    padding: "6px 12px",
    borderRadius: 8,
    border: "none",
    fontWeight: 700,
    fontSize: 12,
    cursor: disabled ? "not-allowed" : "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontFamily: FONT,
  };
}

function ghostButton(disabled?: boolean): React.CSSProperties {
  return {
    background: "transparent",
    color: disabled ? INK_LIGHT : INK,
    padding: "6px 12px",
    borderRadius: 8,
    border: `1px solid ${LINE}`,
    fontWeight: 600,
    fontSize: 12,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: FONT,
  };
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: SURFACE,
        border: `1px solid ${LINE}`,
        borderRadius: 10,
        padding: "24px 18px",
        textAlign: "center",
        color: INK_MUTE,
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}
