/**
 * /lms/admin — Owner+Admin only roster view.
 *
 * Per spec:
 *   - Roster table: tech name, % progress, days remaining badge,
 *     current module, last activity.
 *   - Mobile (< 768px): collapses to cards.
 *   - "Extend deadline" action per row.
 *   - Other roles → 403 (server enforces; UI shows a friendly message).
 *
 * Visual style matches training.tsx (Plus Jakarta Sans, NAVY/TEAL palette).
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { useAuthStore } from "@/lib/auth";
import { QlenoLogo } from "@/components/brand/QlenoLogo";
import {
  MODULE_ORDER,
  FINAL_MODULE_ID,
  maxAttemptsFor,
} from "@workspace/lms-curriculum";
import { getCurriculum, type QuizQuestion } from "@/lib/training/curriculum";
import {
  CalendarClock,
  Loader2,
  CircleCheck,
  AlertTriangle,
  X,
  ChevronRight,
  ChevronDown,
  FastForward,
  RotateCcw,
  History,
} from "lucide-react";

const NAVY = "#0A2342";
const NAVY_HOV = "#163059";
const TEAL = "#0096B3";
const INK = "#0F172A";
const INK_MUTE = "#475569";
const INK_LIGHT = "#94A3B8";
const PAGE_BG = "#F8FAFC";
const SURFACE = "#FFFFFF";
const LINE = "#E2E8F0";
const LINE_SOFT = "#F1F5F9";
const SUCCESS = "#0F766E";
const WARN = "#B45309";
const DANGER = "#B91C1C";
const FONT = "'Plus Jakarta Sans', sans-serif";
const RADIUS = 10;
const MOBILE_BREAKPOINT = 768;

type AuthPayload = {
  role?: string;
  first_name?: string;
  companyId?: number | null;
};

type ModuleStat = {
  status: string;
  best_score: number;
  attempts: number;
  max_attempts: number;
};

type RosterRow = {
  enrollment_id: number;
  user_id: number;
  tech_name: string;
  role: string | null;
  status: "active" | "completed" | "expired";
  progress_pct: number;
  passed_count: number;
  total_modules: number;
  current_module: string | null;
  days_remaining: number;
  deadline_at: string;
  completed_at: string | null;
  last_activity_at: string;
  enrolled_at: string;
  modules?: Record<string, ModuleStat>;
};

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "") + "/api";

async function api<T>(
  method: "GET" | "POST",
  path: string,
  token: string | null,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json.data as T;
}

function readRoleFromToken(token: string | null): AuthPayload | null {
  if (!token) return null;
  try {
    return JSON.parse(atob(token.split(".")[1]));
  } catch {
    return null;
  }
}

function useViewportIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT,
  );
  useEffect(() => {
    const onResize = () =>
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile;
}

export default function LmsAdminPage() {
  const token = useAuthStore((s) => s.token);
  const auth = useMemo(() => readRoleFromToken(token), [token]);
  const isAuthorized = auth?.role === "owner" || auth?.role === "admin" || auth?.role === "super_admin";
  const isMobile = useViewportIsMobile();
  const [rows, setRows] = useState<RosterRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [extendOpen, setExtendOpen] = useState<RosterRow | null>(null);
  const [resetOpen, setResetOpen] = useState<RosterRow | null>(null);
  const [historyOpen, setHistoryOpen] = useState<RosterRow | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  function toggleExpand(enrollmentId: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(enrollmentId)) next.delete(enrollmentId);
      else next.add(enrollmentId);
      return next;
    });
  }

  async function refresh() {
    try {
      const data = await api<RosterRow[]>("GET", "/lms/admin/learners", token);
      setRows(data);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  async function bypassFor(userId: number, moduleId: string) {
    try {
      await api("POST", "/lms/admin/bypass-module", token, { userId, moduleId });
      await refresh();
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  useEffect(() => {
    if (!isAuthorized) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthorized, token]);

  if (!isAuthorized) {
    return (
      <Shell>
        <div
          style={{
            maxWidth: 480,
            margin: "60px auto",
            background: SURFACE,
            border: `1px solid ${LINE}`,
            borderRadius: RADIUS,
            padding: 28,
            textAlign: "center",
          }}
        >
          <X size={36} style={{ color: DANGER }} />
          <div
            style={{
              fontWeight: 800,
              fontSize: 18,
              color: INK,
              marginTop: 8,
            }}
          >
            Access denied
          </div>
          <div style={{ fontSize: 13, color: INK_MUTE, marginTop: 4 }}>
            Only Owners and Admins can view the LMS roster.
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          padding: "26px 18px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 8,
            marginBottom: 14,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div
              style={{
                fontWeight: 800,
                fontSize: 22,
                letterSpacing: "-0.015em",
                color: INK,
              }}
            >
              LMS Roster
            </div>
            <div style={{ fontSize: 13, color: INK_MUTE, marginTop: 4 }}>
              Track who's on track, who's overdue, and extend deadlines as
              needed.
            </div>
          </div>
          <button
            type="button"
            onClick={refresh}
            style={{
              background: "transparent",
              color: NAVY,
              border: `1px solid ${LINE}`,
              padding: "8px 12px",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: FONT,
            }}
          >
            Refresh
          </button>
        </div>

        {error && (
          <div
            style={{
              background: "#FEF2F2",
              border: `1px solid #FECACA`,
              color: DANGER,
              padding: 12,
              borderRadius: 8,
              fontSize: 13,
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        )}

        {rows == null ? (
          <div
            style={{
              padding: 60,
              textAlign: "center",
              color: INK_MUTE,
              fontFamily: FONT,
            }}
          >
            <Loader2 size={20} className="qleno-admin-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div
            style={{
              padding: 30,
              background: SURFACE,
              border: `1px solid ${LINE}`,
              borderRadius: RADIUS,
              textAlign: "center",
              color: INK_MUTE,
              fontSize: 14,
            }}
          >
            No learners enrolled yet. Once a tech opens /training, they'll show
            up here automatically.
          </div>
        ) : isMobile ? (
          <RosterCards
            rows={rows}
            expanded={expanded}
            onToggleExpand={toggleExpand}
            onExtend={setExtendOpen}
            onReset={setResetOpen}
            onHistory={setHistoryOpen}
            onBypass={bypassFor}
          />
        ) : (
          <RosterTable
            rows={rows}
            expanded={expanded}
            onToggleExpand={toggleExpand}
            onExtend={setExtendOpen}
            onReset={setResetOpen}
            onHistory={setHistoryOpen}
            onBypass={bypassFor}
          />
        )}
      </div>

      {extendOpen && (
        <ExtendDeadlineDialog
          row={extendOpen}
          token={token}
          onClose={() => setExtendOpen(null)}
          onSaved={async () => {
            setExtendOpen(null);
            await refresh();
          }}
        />
      )}

      {resetOpen && (
        <ResetEnrollmentDialog
          row={resetOpen}
          token={token}
          onClose={() => setResetOpen(null)}
          onSaved={async () => {
            setResetOpen(null);
            await refresh();
          }}
        />
      )}

      {historyOpen && (
        <AttemptHistoryDialog
          row={historyOpen}
          token={token}
          onClose={() => setHistoryOpen(null)}
        />
      )}

      <style>{`
        @keyframes qleno-admin-spin { to { transform: rotate(360deg); } }
        .qleno-admin-spin { animation: qleno-admin-spin 1s linear infinite; }
      `}</style>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: PAGE_BG,
        fontFamily: FONT,
        color: INK,
      }}
    >
      <header
        style={{
          background: SURFACE,
          borderBottom: `1px solid ${LINE}`,
          padding: "14px 18px",
        }}
      >
        <div
          style={{
            maxWidth: 1100,
            margin: "0 auto",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <QlenoLogo size="md" theme="light" layout="horizontal" />
          <div
            style={{
              height: 22,
              width: 1,
              background: LINE,
            }}
            aria-hidden
          />
          <div
            style={{
              fontWeight: 700,
              fontSize: 13,
              color: INK_MUTE,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            LMS Admin
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}

function RosterTable({
  rows,
  expanded,
  onToggleExpand,
  onExtend,
  onReset,
  onHistory,
  onBypass,
}: {
  rows: RosterRow[];
  expanded: Set<number>;
  onToggleExpand: (id: number) => void;
  onExtend: (r: RosterRow) => void;
  onReset: (r: RosterRow) => void;
  onHistory: (r: RosterRow) => void;
  onBypass: (userId: number, moduleId: string) => Promise<void>;
}) {
  return (
    <div
      style={{
        background: SURFACE,
        border: `1px solid ${LINE}`,
        borderRadius: RADIUS,
        overflow: "hidden",
      }}
    >
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontFamily: FONT,
            fontSize: 13,
          }}
        >
          <thead style={{ background: LINE_SOFT }}>
            <tr>
              <Th></Th>
              <Th>Tech</Th>
              <Th>Status</Th>
              <Th>Progress</Th>
              <Th>Days remaining</Th>
              <Th>Current module</Th>
              <Th>Last activity</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.enrollment_id}>
              <tr>
                <Td>
                  <button
                    type="button"
                    onClick={() => onToggleExpand(r.enrollment_id)}
                    aria-label={expanded.has(r.enrollment_id) ? "Collapse" : "Expand"}
                    style={{
                      background: "transparent",
                      border: `1px solid ${LINE}`,
                      borderRadius: 6,
                      padding: 4,
                      cursor: "pointer",
                      color: INK_MUTE,
                      display: "inline-flex",
                    }}
                  >
                    {expanded.has(r.enrollment_id) ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                  </button>
                </Td>
                <Td>
                  <div style={{ fontWeight: 700, color: INK }}>
                    {r.tech_name}
                  </div>
                  <div
                    style={{
                      color: INK_LIGHT,
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      fontWeight: 700,
                      marginTop: 2,
                    }}
                  >
                    {r.role ?? "—"}
                  </div>
                </Td>
                <Td>
                  <StatusPill status={r.status} />
                </Td>
                <Td>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <ProgressDot pct={r.progress_pct} />
                    <span
                      style={{
                        fontVariantNumeric: "tabular-nums",
                        color: INK,
                        fontWeight: 700,
                      }}
                    >
                      {r.progress_pct}%
                    </span>
                    <span style={{ color: INK_LIGHT, fontSize: 12 }}>
                      ({r.passed_count}/{r.total_modules})
                    </span>
                  </div>
                </Td>
                <Td>
                  <DaysBadge days={r.days_remaining} />
                </Td>
                <Td>
                  <span style={{ color: INK_MUTE, fontSize: 13 }}>
                    {humanModule(r.current_module)}
                  </span>
                </Td>
                <Td>
                  <span style={{ color: INK_MUTE, fontSize: 12 }}>
                    {humanDateTime(r.last_activity_at)}
                  </span>
                </Td>
                <Td>
                  <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => onHistory(r)}
                      title="View attempt history"
                      style={{
                        background: "transparent",
                        color: NAVY,
                        border: `1px solid ${LINE}`,
                        padding: "5px 10px",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: "pointer",
                        fontFamily: FONT,
                        whiteSpace: "nowrap",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <History size={11} /> History
                    </button>
                    <button
                      type="button"
                      onClick={() => onExtend(r)}
                      style={{
                        background: "transparent",
                        color: NAVY,
                        border: `1px solid ${LINE}`,
                        padding: "5px 10px",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: "pointer",
                        fontFamily: FONT,
                        whiteSpace: "nowrap",
                      }}
                    >
                      Extend
                    </button>
                    <button
                      type="button"
                      onClick={() => onReset(r)}
                      title="Reset enrollment"
                      style={{
                        background: "transparent",
                        color: DANGER,
                        border: `1px solid ${LINE}`,
                        padding: "5px 10px",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: "pointer",
                        fontFamily: FONT,
                        whiteSpace: "nowrap",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <RotateCcw size={11} /> Reset
                    </button>
                  </div>
                </Td>
              </tr>
              {expanded.has(r.enrollment_id) ? (
                <tr>
                  <td
                    colSpan={8}
                    style={{
                      background: LINE_SOFT,
                      padding: "12px 18px",
                      borderBottom: `1px solid ${LINE_SOFT}`,
                    }}
                  >
                    <ModuleAttemptsGrid row={r} onBypass={onBypass} />
                  </td>
                </tr>
              ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ModuleAttemptsGrid({
  row,
  onBypass,
}: {
  row: RosterRow;
  onBypass: (userId: number, moduleId: string) => Promise<void>;
}) {
  const allIds: string[] = [...MODULE_ORDER, FINAL_MODULE_ID];
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          color: INK_MUTE,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: 8,
        }}
      >
        Module attempts · Bypass any module
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 8,
        }}
      >
        {allIds.map((moduleId) => {
          const stat = row.modules?.[moduleId];
          const max = stat?.max_attempts ?? maxAttemptsFor(moduleId);
          const attempts = stat?.attempts ?? 0;
          const status = stat?.status ?? "not_started";
          const atCap = status !== "passed" && attempts >= max;
          const passed = status === "passed";
          return (
            <div
              key={moduleId}
              style={{
                background: SURFACE,
                border: `1px solid ${passed ? "#A7F3D0" : atCap ? "#FECACA" : LINE}`,
                borderRadius: 8,
                padding: "8px 10px",
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 800,
                    color: INK,
                    fontSize: 12,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {humanModule(moduleId)}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: passed ? SUCCESS : atCap ? DANGER : INK_MUTE,
                    fontWeight: 700,
                    marginTop: 2,
                  }}
                >
                  {passed
                    ? `Passed · ${stat?.best_score ?? 100}%`
                    : `${attempts}/${max} attempts${atCap ? " · at cap" : ""}`}
                </div>
              </div>
              {!passed ? (
                <button
                  type="button"
                  onClick={() => onBypass(row.user_id, moduleId)}
                  title="Bypass — mark as passed"
                  style={{
                    background: NAVY,
                    color: "#fff",
                    border: 0,
                    padding: "5px 8px",
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 800,
                    cursor: "pointer",
                    fontFamily: FONT,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    flexShrink: 0,
                  }}
                >
                  <FastForward size={11} /> Bypass
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RosterCards({
  rows,
  expanded,
  onToggleExpand,
  onExtend,
  onReset,
  onHistory,
  onBypass,
}: {
  rows: RosterRow[];
  expanded: Set<number>;
  onToggleExpand: (id: number) => void;
  onExtend: (r: RosterRow) => void;
  onReset: (r: RosterRow) => void;
  onHistory: (r: RosterRow) => void;
  onBypass: (userId: number, moduleId: string) => Promise<void>;
}) {
  return (
    <div style={{ display: "grid", gap: 10 }} data-testid="roster-cards">
      {rows.map((r) => (
        <article
          key={r.enrollment_id}
          style={{
            background: SURFACE,
            border: `1px solid ${LINE}`,
            borderRadius: RADIUS,
            padding: "14px 14px 12px 14px",
            display: "grid",
            gap: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ fontWeight: 800, fontSize: 15, color: INK }}>
                {r.tech_name}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: INK_LIGHT,
                  textTransform: "uppercase",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  marginTop: 2,
                }}
              >
                {r.role ?? "—"}
              </div>
            </div>
            <StatusPill status={r.status} />
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
            }}
          >
            <ProgressDot pct={r.progress_pct} />
            <span
              style={{
                color: INK,
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {r.progress_pct}%
            </span>
            <span style={{ color: INK_LIGHT }}>
              ({r.passed_count}/{r.total_modules})
            </span>
            <span style={{ marginLeft: "auto" }}>
              <DaysBadge days={r.days_remaining} />
            </span>
          </div>
          <div style={{ fontSize: 12, color: INK_MUTE }}>
            {humanModule(r.current_module)} · {humanDateTime(r.last_activity_at)}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <button
              type="button"
              onClick={() => onToggleExpand(r.enrollment_id)}
              style={{
                background: "transparent",
                color: INK_MUTE,
                border: `1px solid ${LINE}`,
                padding: "6px 12px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: FONT,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              {expanded.has(r.enrollment_id) ? (
                <>
                  Hide modules <ChevronDown size={12} />
                </>
              ) : (
                <>
                  Show modules <ChevronRight size={12} />
                </>
              )}
            </button>
            <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => onHistory(r)}
                style={{
                  background: "transparent",
                  color: NAVY,
                  border: `1px solid ${LINE}`,
                  padding: "6px 10px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: FONT,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <History size={11} /> History
              </button>
              <button
                type="button"
                onClick={() => onReset(r)}
                style={{
                  background: "transparent",
                  color: DANGER,
                  border: `1px solid ${LINE}`,
                  padding: "6px 10px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: FONT,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <RotateCcw size={11} /> Reset
              </button>
              <button
                type="button"
                onClick={() => onExtend(r)}
                style={{
                  background: "transparent",
                  color: NAVY,
                  border: `1px solid ${LINE}`,
                  padding: "6px 12px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: FONT,
                }}
              >
                Extend deadline <ChevronRight size={12} />
              </button>
            </div>
          </div>
          {expanded.has(r.enrollment_id) ? (
            <div style={{ marginTop: 6 }}>
              <ModuleAttemptsGrid row={r} onBypass={onBypass} />
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "10px 12px",
        fontWeight: 800,
        fontSize: 11,
        color: INK_MUTE,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        borderBottom: `1px solid ${LINE}`,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        padding: "10px 12px",
        borderBottom: `1px solid ${LINE_SOFT}`,
        verticalAlign: "top",
      }}
    >
      {children}
    </td>
  );
}

function StatusPill({ status }: { status: RosterRow["status"] }) {
  const m: Record<
    RosterRow["status"],
    { color: string; bg: string; border: string; label: string }
  > = {
    active: {
      color: TEAL,
      bg: "#ECFEFF",
      border: "#A5F3FC",
      label: "Active",
    },
    completed: {
      color: SUCCESS,
      bg: "#ECFDF5",
      border: "#A7F3D0",
      label: "Completed",
    },
    expired: {
      color: DANGER,
      bg: "#FEF2F2",
      border: "#FECACA",
      label: "Expired",
    },
  };
  const { color, bg, border, label } = m[status];
  return (
    <span
      style={{
        display: "inline-block",
        background: bg,
        color,
        border: `1px solid ${border}`,
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.02em",
      }}
    >
      {label}
    </span>
  );
}

function DaysBadge({ days }: { days: number }) {
  let tone = SUCCESS;
  let bg = "#ECFDF5";
  let label = `${days} days`;
  let Icon: typeof CircleCheck = CircleCheck;
  if (days < 0) {
    tone = DANGER;
    bg = "#FEF2F2";
    label = `${Math.abs(days)} days overdue`;
    Icon = AlertTriangle;
  } else if (days === 0) {
    tone = WARN;
    bg = "#FFFBEB";
    label = "Due today";
    Icon = AlertTriangle;
  } else if (days <= 2) {
    tone = WARN;
    bg = "#FFFBEB";
    Icon = CalendarClock;
  } else {
    Icon = CalendarClock;
  }
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: bg,
        color: tone,
        border: `1px solid ${tone}33`,
        padding: "3px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      <Icon size={11} /> {label}
    </span>
  );
}

function ProgressDot({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div
      style={{
        width: 90,
        height: 6,
        background: LINE_SOFT,
        borderRadius: 999,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${clamped}%`,
          background: clamped >= 100 ? SUCCESS : TEAL,
        }}
      />
    </div>
  );
}

function humanModule(id: string | null): string {
  if (!id) return "—";
  if (id === "__final") return "Final mixed test";
  return id
    .split("-")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

function humanDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Extend deadline dialog
// ─────────────────────────────────────────────────────────────────────────────

function ExtendDeadlineDialog({
  row,
  token,
  onClose,
  onSaved,
}: {
  row: RosterRow;
  token: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [days, setDays] = useState<number>(7);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = days >= 1 && days <= 90;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Extend deadline"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
        padding: 16,
      }}
    >
      <div
        style={{
          background: SURFACE,
          borderRadius: RADIUS,
          maxWidth: 420,
          width: "100%",
          padding: 22,
          fontFamily: FONT,
          color: INK,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 800, color: INK }}>
          Extend deadline — {row.tech_name}
        </div>
        <div style={{ fontSize: 12, color: INK_MUTE, marginTop: 4 }}>
          New deadline = today + N days. Current: {humanDateTime(row.deadline_at)}
        </div>
        <label
          style={{
            display: "block",
            marginTop: 14,
            fontSize: 12,
            fontWeight: 700,
            color: INK_MUTE,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Days from now (1–90)
        </label>
        <input
          type="number"
          min={1}
          max={90}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          style={{
            width: "100%",
            marginTop: 6,
            padding: "10px 12px",
            border: `1px solid ${LINE}`,
            borderRadius: 8,
            fontSize: 15,
            fontFamily: FONT,
          }}
        />
        {err && (
          <div style={{ color: DANGER, fontSize: 12, marginTop: 8 }}>{err}</div>
        )}
        <div
          style={{
            marginTop: 18,
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              color: INK_MUTE,
              border: `1px solid ${LINE}`,
              padding: "8px 14px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 700,
              fontFamily: FONT,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await api("POST", "/lms/admin/extend", token, {
                  enrollmentId: row.enrollment_id,
                  days: Math.floor(days),
                });
                await onSaved();
              } catch (e) {
                setErr(String((e as Error).message));
              } finally {
                setBusy(false);
              }
            }}
            style={{
              background: !valid || busy ? INK_LIGHT : NAVY,
              color: "#fff",
              border: 0,
              padding: "8px 14px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 700,
              fontFamily: FONT,
              cursor: !valid || busy ? "default" : "pointer",
            }}
            onMouseEnter={(e) => {
              if (valid && !busy)
                (e.currentTarget as HTMLButtonElement).style.background = NAVY_HOV;
            }}
            onMouseLeave={(e) => {
              if (valid && !busy)
                (e.currentTarget as HTMLButtonElement).style.background = NAVY;
            }}
          >
            {busy ? <Loader2 size={13} className="qleno-admin-spin" /> : "Extend"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reset enrollment dialog
// ─────────────────────────────────────────────────────────────────────────────

function ResetEnrollmentDialog({
  row,
  token,
  onClose,
  onSaved,
}: {
  row: RosterRow;
  token: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"progress" | "full">("progress");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const expectedConfirm = "RESET";
  const valid = confirm.trim().toUpperCase() === expectedConfirm;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Reset enrollment"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
        padding: 16,
      }}
    >
      <div
        style={{
          background: SURFACE,
          borderRadius: RADIUS,
          maxWidth: 460,
          width: "100%",
          padding: 22,
          fontFamily: FONT,
          color: INK,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 16,
            fontWeight: 800,
            color: INK,
          }}
        >
          <AlertTriangle size={18} style={{ color: DANGER }} /> Reset enrollment —{" "}
          {row.tech_name}
        </div>
        <div style={{ fontSize: 12, color: INK_MUTE, marginTop: 4, lineHeight: 1.55 }}>
          This wipes the learner's LMS data. They start over from module 1
          with a fresh 7-day deadline. Their next visit to /training will look
          like a brand-new enrollment.
        </div>

        <div
          style={{
            marginTop: 14,
            display: "grid",
            gap: 8,
          }}
        >
          <label
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              padding: 10,
              border: `1px solid ${mode === "progress" ? NAVY : LINE}`,
              borderRadius: 8,
              cursor: "pointer",
              background: mode === "progress" ? "#EEF2F8" : "transparent",
            }}
          >
            <input
              type="radio"
              name="reset-mode"
              checked={mode === "progress"}
              onChange={() => setMode("progress")}
              style={{ marginTop: 2 }}
            />
            <div>
              <div style={{ fontWeight: 800, fontSize: 13, color: INK }}>
                Reset progress (recommended)
              </div>
              <div style={{ fontSize: 12, color: INK_MUTE, marginTop: 2 }}>
                Deletes all module progress, quiz attempts, and autosave. Keeps
                the enrollment row, resets deadline to today + 7 days.
              </div>
            </div>
          </label>
          <label
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              padding: 10,
              border: `1px solid ${mode === "full" ? DANGER : LINE}`,
              borderRadius: 8,
              cursor: "pointer",
              background: mode === "full" ? "#FEF2F2" : "transparent",
            }}
          >
            <input
              type="radio"
              name="reset-mode"
              checked={mode === "full"}
              onChange={() => setMode("full")}
              style={{ marginTop: 2 }}
            />
            <div>
              <div style={{ fontWeight: 800, fontSize: 13, color: INK }}>
                Delete enrollment fully
              </div>
              <div style={{ fontSize: 12, color: INK_MUTE, marginTop: 2 }}>
                Removes the enrollment record entirely. A fresh one is
                lazy-created on the learner's next /training visit. Use only
                if the row is corrupted.
              </div>
            </div>
          </label>
        </div>

        <label
          style={{
            display: "block",
            marginTop: 14,
            fontSize: 12,
            fontWeight: 700,
            color: INK_MUTE,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Type RESET to confirm
        </label>
        <input
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="RESET"
          style={{
            width: "100%",
            marginTop: 6,
            padding: "10px 12px",
            border: `1px solid ${LINE}`,
            borderRadius: 8,
            fontSize: 14,
            fontFamily: FONT,
          }}
        />
        {err && (
          <div style={{ color: DANGER, fontSize: 12, marginTop: 8 }}>{err}</div>
        )}
        <div
          style={{
            marginTop: 18,
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              color: INK_MUTE,
              border: `1px solid ${LINE}`,
              padding: "8px 14px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 700,
              fontFamily: FONT,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await api("POST", "/lms/admin/reset", token, {
                  userId: row.user_id,
                  mode,
                });
                await onSaved();
              } catch (e) {
                setErr(String((e as Error).message));
              } finally {
                setBusy(false);
              }
            }}
            style={{
              background: !valid || busy ? INK_LIGHT : DANGER,
              color: "#fff",
              border: 0,
              padding: "8px 14px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 700,
              fontFamily: FONT,
              cursor: !valid || busy ? "default" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {busy ? (
              <Loader2 size={13} className="qleno-admin-spin" />
            ) : (
              <>
                <RotateCcw size={12} /> Reset
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Attempt history dialog
// ─────────────────────────────────────────────────────────────────────────────
//
// Surfaces every per-module + final quiz attempt for one learner. Used by the
// owner to spot comprehension gaps ("Carlos failed compensation 3× — which
// question keeps tripping him?") and resolve disputes.
//
// Backend returns answers + question_ids + correct_indexes (server-
// authoritative). Prompt text + option labels are looked up locally from the
// frontend curriculum bundle keyed by company_id.

type Locale = "en" | "es";

type AttemptRow = {
  attempt_id: number;
  module_id: string;
  score: number;
  passed: boolean;
  attempted_at: string;
  answers: (number | null)[];
  question_ids: string[];
  correct_indexes: number[];
  per_question_correct: boolean[];
};

function humanModuleLabel(id: string): string {
  if (id === "__final") return "Final mixed test";
  return id
    .split("-")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

function AttemptHistoryDialog({
  row,
  token,
  onClose,
}: {
  row: RosterRow;
  token: string | null;
  onClose: () => void;
}) {
  const auth = useMemo(() => readRoleFromToken(token), [token]);
  const companyId = auth?.companyId ?? null;
  const curriculum = useMemo(
    () => getCurriculum(companyId),
    [companyId],
  );
  const questionLookup = useMemo<Map<string, QuizQuestion>>(() => {
    const map = new Map<string, QuizQuestion>();
    for (const q of curriculum.quiz) map.set(q.id, q);
    return map;
  }, [curriculum]);

  const [attempts, setAttempts] = useState<AttemptRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedAttempt, setExpandedAttempt] = useState<number | null>(null);
  const [locale, setLocale] = useState<Locale>("en");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<{ learner: unknown; attempts: AttemptRow[] }>(
          "GET",
          `/lms/admin/learners/${row.user_id}/attempts`,
          token,
        );
        if (!cancelled) setAttempts(data.attempts);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.user_id, token]);

  // Group attempts by module_id, preserving newest-first order from server.
  const byModule = useMemo(() => {
    const map = new Map<string, AttemptRow[]>();
    for (const a of attempts ?? []) {
      const arr = map.get(a.module_id) ?? [];
      arr.push(a);
      map.set(a.module_id, arr);
    }
    return map;
  }, [attempts]);

  const moduleIds: string[] = [...MODULE_ORDER, FINAL_MODULE_ID];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Attempt history"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
        padding: 16,
      }}
    >
      <div
        style={{
          background: SURFACE,
          borderRadius: RADIUS,
          maxWidth: 820,
          width: "100%",
          maxHeight: "90vh",
          overflow: "auto",
          padding: 22,
          fontFamily: FONT,
          color: INK,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            marginBottom: 4,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 16,
              fontWeight: 800,
              color: INK,
            }}
          >
            <History size={16} /> Attempt history — {row.tech_name}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div
              role="group"
              aria-label="Language toggle"
              style={{
                display: "inline-flex",
                background: LINE_SOFT,
                borderRadius: 999,
                padding: 2,
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              <button
                type="button"
                onClick={() => setLocale("en")}
                style={{
                  border: 0,
                  borderRadius: 999,
                  padding: "3px 10px",
                  background: locale === "en" ? NAVY : "transparent",
                  color: locale === "en" ? "#fff" : INK_MUTE,
                  cursor: "pointer",
                  fontFamily: FONT,
                }}
              >
                EN
              </button>
              <button
                type="button"
                onClick={() => setLocale("es")}
                style={{
                  border: 0,
                  borderRadius: 999,
                  padding: "3px 10px",
                  background: locale === "es" ? NAVY : "transparent",
                  color: locale === "es" ? "#fff" : INK_MUTE,
                  cursor: "pointer",
                  fontFamily: FONT,
                }}
              >
                ES
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                background: "transparent",
                border: `1px solid ${LINE}`,
                borderRadius: 6,
                padding: 4,
                cursor: "pointer",
                color: INK_MUTE,
                display: "inline-flex",
              }}
            >
              <X size={14} />
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: INK_MUTE, marginBottom: 14 }}>
          Every per-module quiz and final-mixed-test submission, newest first.
          Click an attempt to see each question and the answer they picked.
        </div>

        {error && (
          <div
            style={{
              background: "#FEF2F2",
              border: `1px solid #FECACA`,
              color: DANGER,
              padding: 10,
              borderRadius: 8,
              fontSize: 12,
              marginBottom: 10,
            }}
          >
            {error}
          </div>
        )}

        {attempts == null && !error ? (
          <div style={{ padding: 40, textAlign: "center", color: INK_MUTE }}>
            <Loader2 size={18} className="qleno-admin-spin" />
          </div>
        ) : attempts && attempts.length === 0 ? (
          <div
            style={{
              padding: 24,
              background: LINE_SOFT,
              borderRadius: 8,
              textAlign: "center",
              fontSize: 13,
              color: INK_MUTE,
            }}
          >
            No quiz attempts yet — this learner hasn't submitted any quiz.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {moduleIds.map((moduleId) => {
              const moduleAttempts = byModule.get(moduleId) ?? [];
              if (moduleAttempts.length === 0) return null;
              return (
                <div
                  key={moduleId}
                  style={{
                    background: SURFACE,
                    border: `1px solid ${LINE}`,
                    borderRadius: 8,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      padding: "10px 12px",
                      background: LINE_SOFT,
                      fontWeight: 800,
                      fontSize: 12,
                      color: INK,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      display: "flex",
                      justifyContent: "space-between",
                    }}
                  >
                    <span>{humanModuleLabel(moduleId)}</span>
                    <span style={{ color: INK_MUTE, fontWeight: 700 }}>
                      {moduleAttempts.length}{" "}
                      {moduleAttempts.length === 1 ? "attempt" : "attempts"}
                    </span>
                  </div>
                  {moduleAttempts.map((a, idx) => {
                    const open = expandedAttempt === a.attempt_id;
                    const ordinal = moduleAttempts.length - idx;
                    return (
                      <div
                        key={a.attempt_id}
                        style={{
                          borderTop: `1px solid ${LINE_SOFT}`,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedAttempt(open ? null : a.attempt_id)
                          }
                          style={{
                            width: "100%",
                            background: "transparent",
                            border: 0,
                            padding: "10px 12px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            cursor: "pointer",
                            fontFamily: FONT,
                            fontSize: 13,
                            color: INK,
                            textAlign: "left",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            {open ? (
                              <ChevronDown size={14} />
                            ) : (
                              <ChevronRight size={14} />
                            )}
                            <span style={{ fontWeight: 700 }}>
                              Attempt {ordinal}
                            </span>
                            <span style={{ color: INK_MUTE, fontSize: 12 }}>
                              {humanDateTime(a.attempted_at)}
                            </span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <span
                              style={{
                                fontVariantNumeric: "tabular-nums",
                                fontWeight: 800,
                                color: a.passed ? SUCCESS : DANGER,
                              }}
                            >
                              {a.score}%
                            </span>
                            <span
                              style={{
                                background: a.passed ? "#ECFDF5" : "#FEF2F2",
                                color: a.passed ? SUCCESS : DANGER,
                                border: `1px solid ${a.passed ? "#A7F3D0" : "#FECACA"}`,
                                padding: "2px 8px",
                                borderRadius: 999,
                                fontSize: 11,
                                fontWeight: 800,
                              }}
                            >
                              {a.passed ? "Passed" : "Failed"}
                            </span>
                          </div>
                        </button>
                        {open ? (
                          <div
                            style={{
                              padding: "0 12px 12px",
                              display: "grid",
                              gap: 8,
                            }}
                          >
                            {a.question_ids.length === 0 ? (
                              <div style={{ color: INK_MUTE, fontSize: 12 }}>
                                Question text not available (curriculum may have
                                changed since this attempt).
                              </div>
                            ) : (
                              a.question_ids.map((qid, i) => {
                                const q = questionLookup.get(qid);
                                const picked = a.answers[i];
                                const correctIdx = a.correct_indexes[i];
                                const ok = a.per_question_correct[i];
                                return (
                                  <div
                                    key={qid + "-" + i}
                                    style={{
                                      background: ok ? "#F0FDF4" : "#FEF2F2",
                                      border: `1px solid ${ok ? "#BBF7D0" : "#FECACA"}`,
                                      borderLeft: `3px solid ${ok ? SUCCESS : DANGER}`,
                                      borderRadius: 6,
                                      padding: "8px 10px",
                                      fontSize: 12,
                                    }}
                                  >
                                    <div
                                      style={{
                                        fontWeight: 800,
                                        color: INK,
                                        marginBottom: 4,
                                      }}
                                    >
                                      {i + 1}.{" "}
                                      {q?.prompt[locale] ?? `(Question ${qid} not found)`}
                                    </div>
                                    {q ? (
                                      <div style={{ display: "grid", gap: 3 }}>
                                        {q.options.map((opt, optIdx) => {
                                          const isPicked = picked === optIdx;
                                          const isCorrect = correctIdx === optIdx;
                                          const tone = isCorrect
                                            ? SUCCESS
                                            : isPicked
                                            ? DANGER
                                            : INK_MUTE;
                                          return (
                                            <div
                                              key={optIdx}
                                              style={{
                                                display: "flex",
                                                gap: 6,
                                                alignItems: "flex-start",
                                                color: tone,
                                                fontWeight:
                                                  isPicked || isCorrect ? 700 : 500,
                                              }}
                                            >
                                              <span
                                                style={{
                                                  display: "inline-flex",
                                                  width: 14,
                                                  flexShrink: 0,
                                                  marginTop: 2,
                                                }}
                                              >
                                                {isCorrect ? (
                                                  <CircleCheck size={12} />
                                                ) : isPicked ? (
                                                  <X size={12} />
                                                ) : null}
                                              </span>
                                              <span>{opt[locale]}</span>
                                              {isPicked && !isCorrect ? (
                                                <span
                                                  style={{
                                                    marginLeft: 4,
                                                    fontSize: 10,
                                                    color: DANGER,
                                                    fontWeight: 800,
                                                    textTransform: "uppercase",
                                                  }}
                                                >
                                                  picked
                                                </span>
                                              ) : null}
                                              {isCorrect ? (
                                                <span
                                                  style={{
                                                    marginLeft: 4,
                                                    fontSize: 10,
                                                    color: SUCCESS,
                                                    fontWeight: 800,
                                                    textTransform: "uppercase",
                                                  }}
                                                >
                                                  correct
                                                </span>
                                              ) : null}
                                            </div>
                                          );
                                        })}
                                        {picked == null ? (
                                          <div
                                            style={{
                                              color: WARN,
                                              fontSize: 11,
                                              fontWeight: 700,
                                              marginTop: 2,
                                            }}
                                          >
                                            Left unanswered
                                          </div>
                                        ) : null}
                                      </div>
                                    ) : null}
                                  </div>
                                );
                              })
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
