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
  Download,
  Award,
  FileSignature,
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
  const isAuthorized =
    auth?.role === "owner" ||
    auth?.role === "admin" ||
    auth?.role === "super_admin" ||
    auth?.role === "office";
  const isMobile = useViewportIsMobile();
  const [rows, setRows] = useState<RosterRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [extendOpen, setExtendOpen] = useState<RosterRow | null>(null);
  const [resetOpen, setResetOpen] = useState<RosterRow | null>(null);
  const [historyOpen, setHistoryOpen] = useState<RosterRow | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [bulkPwOpen, setBulkPwOpen] = useState(false);
  const [cyclesOpen, setCyclesOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);

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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => setAuditOpen(true)}
              style={{
                background: SUCCESS,
                color: "#fff",
                border: `1px solid ${SUCCESS}`,
                padding: "8px 12px",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: FONT,
              }}
            >
              Audit dashboard
            </button>
            <button
              type="button"
              onClick={() => setCyclesOpen(true)}
              style={{
                background: TEAL,
                color: "#fff",
                border: `1px solid ${TEAL}`,
                padding: "8px 12px",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: FONT,
              }}
            >
              Annual cycles
            </button>
            <button
              type="button"
              onClick={() => setBulkPwOpen(true)}
              style={{
                background: NAVY,
                color: "#fff",
                border: `1px solid ${NAVY}`,
                padding: "8px 12px",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: FONT,
              }}
            >
              Bulk reset password
            </button>
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

      {bulkPwOpen && rows && (
        <BulkPasswordDialog
          rows={rows}
          token={token}
          onClose={() => setBulkPwOpen(false)}
          onSaved={() => setBulkPwOpen(false)}
        />
      )}

      {cyclesOpen && (
        <AnnualCyclesDialog
          token={token}
          onClose={() => setCyclesOpen(false)}
        />
      )}

      {auditOpen && (
        <AuditDashboardDialog
          token={token}
          onClose={() => setAuditOpen(false)}
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
                    <LearnerCertificatesPanel row={r} />
                    <LearnerSignedDocumentsPanel row={r} />
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
              <LearnerCertificatesPanel row={r} />
              <LearnerSignedDocumentsPanel row={r} />
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

// ─────────────────────────────────────────────────────────────────────────────
// Bulk password reset dialog — owner-only tool to push a new password to a
// subset of users in one call. Calls POST /api/users/bulk-reset-password.
// ─────────────────────────────────────────────────────────────────────────────

function BulkPasswordDialog({
  rows,
  token,
  onClose,
  onSaved,
}: {
  rows: RosterRow[];
  token: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(rows.map((r) => r.user_id)),
  );
  const [newPassword, setNewPassword] = useState("Chicago23");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [doneCount, setDoneCount] = useState<number | null>(null);

  const allChecked = selected.size === rows.length;
  function toggleAll() {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.user_id)));
  }
  function toggleOne(userId: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function onSubmit() {
    setErr(null);
    if (selected.size === 0) {
      setErr("Select at least one user.");
      return;
    }
    if (newPassword.length < 6) {
      setErr("Password must be at least 6 characters.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/users/bulk-reset-password`, {
        method: "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userIds: Array.from(selected),
          newPassword,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setDoneCount(json?.data?.updated_count ?? selected.size);
      setTimeout(() => onSaved(), 1500);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
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
          border: `1px solid ${LINE}`,
          borderRadius: RADIUS,
          padding: 22,
          maxWidth: 520,
          width: "100%",
          maxHeight: "85vh",
          overflow: "auto",
          fontFamily: FONT,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <div style={{ fontWeight: 800, fontSize: 18, color: INK }}>
            Bulk reset password
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: "transparent", border: 0, cursor: "pointer", color: INK_MUTE }}
          >
            <X size={18} />
          </button>
        </div>
        <div style={{ fontSize: 13, color: INK_MUTE, marginTop: 4 }}>
          Sets the password for every selected user to the new password. Owners aren't affected unless explicitly selected.
        </div>

        {doneCount != null ? (
          <div
            style={{
              marginTop: 18,
              padding: "10px 12px",
              background: "#ECFDF5",
              border: `1px solid ${SUCCESS}`,
              borderRadius: 8,
              color: SUCCESS,
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            Reset {doneCount} {doneCount === 1 ? "user" : "users"}.
          </div>
        ) : (
          <>
            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: INK_MUTE, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                New password
              </label>
              <input
                type="text"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={busy}
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 6,
                  padding: "8px 10px",
                  border: `1px solid ${LINE}`,
                  borderRadius: 6,
                  fontSize: 14,
                  fontFamily: FONT,
                }}
              />
              <div style={{ fontSize: 11, color: INK_LIGHT, marginTop: 4 }}>
                Default: <code>Chicago23</code>. Change for any single user later via the per-user reset.
              </div>
            </div>

            <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: INK_MUTE, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Users ({selected.size} / {rows.length})
              </label>
              <button
                type="button"
                onClick={toggleAll}
                disabled={busy}
                style={{
                  background: "transparent",
                  border: `1px solid ${LINE}`,
                  borderRadius: 6,
                  padding: "4px 10px",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: FONT,
                  color: NAVY,
                }}
              >
                {allChecked ? "Clear all" : "Select all"}
              </button>
            </div>
            <div
              style={{
                marginTop: 8,
                maxHeight: 260,
                overflow: "auto",
                border: `1px solid ${LINE}`,
                borderRadius: 8,
              }}
            >
              {rows.map((r) => {
                const checked = selected.has(r.user_id);
                return (
                  <label
                    key={r.user_id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 12px",
                      borderBottom: `1px solid ${LINE_SOFT}`,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy}
                      onChange={() => toggleOne(r.user_id)}
                    />
                    <span style={{ fontSize: 13, color: INK, fontWeight: 600 }}>
                      {r.tech_name}
                    </span>
                    <span style={{ fontSize: 11, color: INK_LIGHT, marginLeft: "auto" }}>
                      {r.role ?? "—"}
                    </span>
                  </label>
                );
              })}
            </div>

            {err && (
              <div
                style={{
                  marginTop: 14,
                  padding: "8px 10px",
                  background: "#FEF2F2",
                  border: `1px solid #FECACA`,
                  color: DANGER,
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {err}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                style={{
                  background: "transparent",
                  color: INK_MUTE,
                  border: `1px solid ${LINE}`,
                  padding: "8px 14px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: FONT,
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onSubmit}
                disabled={busy || selected.size === 0 || newPassword.length < 6}
                style={{
                  background: NAVY,
                  color: "#fff",
                  border: `1px solid ${NAVY}`,
                  padding: "8px 14px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: busy ? "default" : "pointer",
                  fontFamily: FONT,
                  opacity: busy || selected.size === 0 || newPassword.length < 6 ? 0.6 : 1,
                }}
              >
                {busy ? "Resetting…" : `Reset ${selected.size} ${selected.size === 1 ? "user" : "users"}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LearnerCertificatesPanel — Phase 12: shows the per-learner cert audit
// trail in the admin expand row. Fetches on first render via the
// admin-side endpoint and renders the full chain (including historical
// re-takes) with a download button per cert.
// ─────────────────────────────────────────────────────────────────────────────

type CertificateRow = {
  id: number;
  module_id: string;
  score: number | null;
  passed: boolean;
  locale: string;
  issued_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Annual cycles dialog (Phase 14 UI)
//
// Surfaces the existing /api/lms/annual-ack admin routes:
//   - GET    /admin/cycles              list cycles for the tenant
//   - POST   /admin/cycles              open a new cycle + sweep
//   - PATCH  /admin/cycles/:id/close    close an open cycle
//
// Cycles default to the current calendar year + Dec 31 deadline (the
// server computes both when omitted). The dialog deliberately doesn't
// surface per-learner force-resign here — that's reachable via the
// dedicated user row actions in a follow-up.
// ─────────────────────────────────────────────────────────────────────────────

type AnnualCycleRow = {
  id: number;
  cycle_year: number;
  deadline_at: string;
  required_documents: string[];
  opened_at: string;
  closed_at: string | null;
  notes: string | null;
};

function AnnualCyclesDialog({
  token,
  onClose,
}: {
  token: string | null;
  onClose: () => void;
}) {
  const [cycles, setCycles] = useState<AnnualCycleRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openForm, setOpenForm] = useState<{ year: number; notes: string }>(
    () => ({ year: new Date().getFullYear(), notes: "" }),
  );

  const refresh = async () => {
    try {
      const data = await api<AnnualCycleRow[]>(
        "GET",
        "/lms/annual-ack/admin/cycles",
        token,
      );
      setCycles(data);
      setErr(null);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const openCycle = async () => {
    setBusy("open");
    setErr(null);
    try {
      const body: Record<string, unknown> = { cycle_year: openForm.year };
      if (openForm.notes.trim().length > 0) {
        body.notes = openForm.notes.trim();
      }
      await api("POST", "/lms/annual-ack/admin/cycles", token, body);
      await refresh();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  };

  const closeCycle = async (cycleId: number) => {
    if (!confirm("Close this cycle? Outstanding pending re-acks stay open until employees sign.")) return;
    setBusy(`close-${cycleId}`);
    setErr(null);
    try {
      await api(
        "PATCH",
        `/lms/annual-ack/admin/cycles/${cycleId}/close`,
        token,
      );
      await refresh();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Annual re-acknowledgment cycles"
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
          maxWidth: 640,
          width: "100%",
          maxHeight: "92vh",
          overflowY: "auto",
          padding: 24,
          fontFamily: FONT,
          color: INK,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: INK }}>
              Annual re-acknowledgment cycles
            </div>
            <div style={{ fontSize: 12.5, color: INK_MUTE, marginTop: 4 }}>
              Open a cycle to push every active employee with an existing
              handbook signature into a forced re-sign flow. They'll see a
              tile on /training on their next login.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: `1px solid ${LINE}`,
              borderRadius: 8,
              padding: "6px 8px",
              cursor: "pointer",
              color: INK_MUTE,
              fontFamily: FONT,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {err && (
          <div
            style={{
              background: "#FEF2F2",
              border: `1px solid #FECACA`,
              color: DANGER,
              padding: 10,
              borderRadius: 8,
              fontSize: 12,
              marginTop: 12,
            }}
          >
            {err}
          </div>
        )}

        {/* Open new cycle form */}
        <div
          style={{
            marginTop: 18,
            border: `1px solid ${LINE}`,
            borderRadius: 8,
            padding: 14,
            background: LINE_SOFT,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 800, color: INK }}>
            Open a new cycle
          </div>
          <div style={{ fontSize: 12, color: INK_MUTE, marginTop: 4 }}>
            Default deadline is Dec 31 of the cycle year. Documents default
            to handbook only.
          </div>
          <div
            style={{
              marginTop: 10,
              display: "flex",
              gap: 10,
              alignItems: "flex-end",
              flexWrap: "wrap",
            }}
          >
            <label style={{ fontSize: 12, fontWeight: 700, color: INK_MUTE }}>
              Cycle year
              <input
                type="number"
                min={2025}
                max={2100}
                value={openForm.year}
                onChange={(e) =>
                  setOpenForm((f) => ({ ...f, year: Number(e.target.value) }))
                }
                style={{
                  display: "block",
                  width: 110,
                  marginTop: 4,
                  padding: "8px 10px",
                  border: `1px solid ${LINE}`,
                  borderRadius: 8,
                  fontFamily: FONT,
                  fontSize: 14,
                }}
              />
            </label>
            <label
              style={{
                flex: 1,
                minWidth: 180,
                fontSize: 12,
                fontWeight: 700,
                color: INK_MUTE,
              }}
            >
              Notes (optional)
              <input
                type="text"
                value={openForm.notes}
                onChange={(e) =>
                  setOpenForm((f) => ({ ...f, notes: e.target.value }))
                }
                placeholder="e.g. Q4 2026 handbook refresh"
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 4,
                  padding: "8px 10px",
                  border: `1px solid ${LINE}`,
                  borderRadius: 8,
                  fontFamily: FONT,
                  fontSize: 14,
                }}
              />
            </label>
            <button
              type="button"
              disabled={busy !== null}
              onClick={openCycle}
              style={{
                background: busy === "open" ? INK_LIGHT : TEAL,
                color: "#fff",
                border: 0,
                padding: "8px 14px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 700,
                fontFamily: FONT,
                cursor: busy ? "default" : "pointer",
              }}
            >
              {busy === "open" ? "Opening…" : "Open cycle"}
            </button>
          </div>
        </div>

        {/* Cycle list */}
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: INK }}>
            Cycles
          </div>
          {cycles === null ? (
            <div
              style={{
                marginTop: 10,
                padding: 18,
                textAlign: "center",
                color: INK_MUTE,
              }}
            >
              <Loader2 size={16} className="qleno-admin-spin" />
            </div>
          ) : cycles.length === 0 ? (
            <div
              style={{
                marginTop: 10,
                padding: 14,
                background: PAGE_BG,
                border: `1px dashed ${LINE}`,
                borderRadius: 8,
                fontSize: 13,
                color: INK_MUTE,
              }}
            >
              No cycles yet. Open one above to fan out forced re-acknowledgments.
            </div>
          ) : (
            <div
              style={{
                marginTop: 10,
                display: "grid",
                gap: 8,
              }}
            >
              {cycles.map((c) => {
                const closed = c.closed_at !== null;
                const closeBusy = busy === `close-${c.id}`;
                return (
                  <div
                    key={c.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      alignItems: "center",
                      gap: 12,
                      padding: 12,
                      border: `1px solid ${LINE}`,
                      borderLeft: `4px solid ${closed ? INK_LIGHT : SUCCESS}`,
                      borderRadius: 8,
                      background: SURFACE,
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 800,
                          color: INK,
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        {c.cycle_year}
                        <span
                          style={{
                            fontSize: 10.5,
                            fontWeight: 800,
                            color: closed ? INK_MUTE : SUCCESS,
                            background: closed ? "#F1F5F9" : "#ECFDF5",
                            padding: "2px 8px",
                            borderRadius: 999,
                            letterSpacing: "0.04em",
                            textTransform: "uppercase",
                          }}
                        >
                          {closed ? "Closed" : "Open"}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: INK_MUTE,
                          marginTop: 4,
                          lineHeight: 1.5,
                        }}
                      >
                        Deadline {humanDateTime(c.deadline_at)} · Opened{" "}
                        {humanDateTime(c.opened_at)}
                        {closed ? (
                          <> · Closed {humanDateTime(c.closed_at!)}</>
                        ) : null}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: INK_LIGHT,
                          marginTop: 2,
                        }}
                      >
                        Documents:{" "}
                        {(c.required_documents ?? []).join(", ") || "—"}
                      </div>
                      {c.notes ? (
                        <div
                          style={{
                            fontSize: 11.5,
                            color: INK_MUTE,
                            marginTop: 4,
                            fontStyle: "italic",
                          }}
                        >
                          {c.notes}
                        </div>
                      ) : null}
                    </div>
                    <div>
                      {!closed ? (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => closeCycle(c.id)}
                          style={{
                            background:
                              closeBusy || busy !== null
                                ? INK_LIGHT
                                : "transparent",
                            color:
                              closeBusy || busy !== null ? "#fff" : DANGER,
                            border: `1px solid ${
                              closeBusy || busy !== null ? INK_LIGHT : DANGER
                            }`,
                            padding: "6px 12px",
                            borderRadius: 8,
                            fontSize: 12,
                            fontWeight: 700,
                            fontFamily: FONT,
                            cursor: busy ? "default" : "pointer",
                          }}
                        >
                          {closeBusy ? "Closing…" : "Close cycle"}
                        </button>
                      ) : (
                        <span style={{ fontSize: 11, color: INK_LIGHT }}>
                          —
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit dashboard dialog (Phase 15 UI)
//
// Surfaces the existing /api/lms/admin-audit endpoints:
//   - GET  /summary           tenant rollup totals + per-learner audit rows
//   - GET  /summary.csv       RFC-4180 CSV export (download)
//   - GET  /learner/:userId   single-learner deep view (lazy on expand)
//
// One-screen compliance posture for the tenant. Renders the five
// dimensions per learner (modules, signed docs, final exam, handbook,
// pending re-acks) plus the rollup totals at the top. CSV download
// goes through fetch+blob+auth (same pattern as the certificate /
// handbook downloads).
// ─────────────────────────────────────────────────────────────────────────────

type AuditCompliance = {
  modules_complete: boolean;
  docs_complete: boolean;
  final_passed: boolean;
  handbook_signed: boolean;
  pending_count: number;
  overall: "complete" | "needs_resign" | "overdue" | "in_progress";
};

type AuditRosterRow = {
  user_id: number;
  full_name: string;
  email: string;
  role: string;
  hire_date: string | null;
  termination_date: string | null;
  enrollment: {
    id: number;
    status: string;
    enrolled_at: string;
    deadline_at: string | null;
    completed_at: string | null;
    last_activity_at: string | null;
  } | null;
  passed_module_ids: string[];
  signed_document_types: string[];
  handbook_signed_at: string | null;
  final_passed_at: string | null;
  pending_re_acks: Array<{
    id: number;
    document_type: string;
    trigger_reason: string;
    triggered_at: string;
    defer_until: string | null;
  }>;
  compliance: AuditCompliance;
};

type AuditSummary = {
  totals: {
    learners: number;
    complete: number;
    in_progress: number;
    overdue: number;
    needs_resign: number;
    pending_re_acks: number;
  };
  rows: AuditRosterRow[];
  quiz_module_ids: string[];
  required_signed_docs: string[];
};

async function downloadAuditCsv(token: string | null): Promise<void> {
  const url = `${API_BASE}/lms/admin-audit/summary.csv`;
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GET /lms/admin-audit/summary.csv → ${res.status}: ${text}`,
    );
  }
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename =
    match?.[1] ?? `phes-lms-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}

function AuditDashboardDialog({
  token,
  onClose,
}: {
  token: string | null;
  onClose: () => void;
}) {
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | AuditCompliance["overall"]>(
    "all",
  );

  const refresh = async () => {
    try {
      const data = await api<AuditSummary>(
        "GET",
        "/lms/admin-audit/summary",
        token,
      );
      setSummary(data);
      setErr(null);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const rows = useMemo(() => {
    if (!summary) return [] as AuditRosterRow[];
    if (filter === "all") return summary.rows;
    return summary.rows.filter((r) => r.compliance.overall === filter);
  }, [summary, filter]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="LMS audit dashboard"
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
          maxWidth: 1100,
          width: "100%",
          maxHeight: "92vh",
          overflowY: "auto",
          padding: 24,
          fontFamily: FONT,
          color: INK,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: INK }}>
              LMS audit dashboard
            </div>
            <div style={{ fontSize: 12.5, color: INK_MUTE, marginTop: 4 }}>
              Compliance roster across every employee. Filter, drill in, and
              export for HR / legal records.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={busy === "csv"}
              onClick={async () => {
                setBusy("csv");
                setErr(null);
                try {
                  await downloadAuditCsv(token);
                } catch (e) {
                  setErr(String((e as Error).message));
                } finally {
                  setBusy(null);
                }
              }}
              style={{
                background: busy === "csv" ? INK_LIGHT : NAVY,
                color: "#fff",
                border: 0,
                padding: "8px 12px",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 700,
                cursor: busy === "csv" ? "default" : "pointer",
                fontFamily: FONT,
              }}
            >
              {busy === "csv" ? "Preparing…" : "Download CSV"}
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: "transparent",
                border: `1px solid ${LINE}`,
                borderRadius: 8,
                padding: "6px 8px",
                cursor: "pointer",
                color: INK_MUTE,
                fontFamily: FONT,
              }}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {err && (
          <div
            style={{
              background: "#FEF2F2",
              border: `1px solid #FECACA`,
              color: DANGER,
              padding: 10,
              borderRadius: 8,
              fontSize: 12,
              marginTop: 12,
            }}
          >
            {err}
          </div>
        )}

        {summary === null ? (
          <div
            style={{
              padding: 40,
              textAlign: "center",
              color: INK_MUTE,
            }}
          >
            <Loader2 size={20} className="qleno-admin-spin" />
          </div>
        ) : (
          <>
            {/* Tenant rollup tiles */}
            <div
              style={{
                marginTop: 16,
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                gap: 8,
              }}
            >
              <RollupTile
                label="Learners"
                value={summary.totals.learners}
                color={INK}
                active={filter === "all"}
                onClick={() => setFilter("all")}
              />
              <RollupTile
                label="Complete"
                value={summary.totals.complete}
                color={SUCCESS}
                active={filter === "complete"}
                onClick={() => setFilter("complete")}
              />
              <RollupTile
                label="In progress"
                value={summary.totals.in_progress}
                color={TEAL}
                active={filter === "in_progress"}
                onClick={() => setFilter("in_progress")}
              />
              <RollupTile
                label="Overdue"
                value={summary.totals.overdue}
                color={DANGER}
                active={filter === "overdue"}
                onClick={() => setFilter("overdue")}
              />
              <RollupTile
                label="Needs re-sign"
                value={summary.totals.needs_resign}
                color={WARN}
                active={filter === "needs_resign"}
                onClick={() => setFilter("needs_resign")}
              />
              <RollupTile
                label="Pending re-acks"
                value={summary.totals.pending_re_acks}
                color={INK_MUTE}
                active={false}
                onClick={() => {}}
              />
            </div>

            {/* Roster table */}
            <div
              style={{
                marginTop: 16,
                border: `1px solid ${LINE}`,
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12.5,
                  fontFamily: FONT,
                }}
              >
                <thead>
                  <tr style={{ background: LINE_SOFT }}>
                    <th style={ThStyle}>Employee</th>
                    <th style={ThStyle}>Status</th>
                    <th style={ThStyle}>Modules</th>
                    <th style={ThStyle}>Docs</th>
                    <th style={ThStyle}>Final</th>
                    <th style={ThStyle}>Handbook</th>
                    <th style={ThStyle}>Pending</th>
                    <th style={ThStyle}>Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8}
                        style={{
                          textAlign: "center",
                          padding: 24,
                          color: INK_MUTE,
                          fontSize: 12.5,
                        }}
                      >
                        No learners match this filter.
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => (
                      <AuditRow
                        key={r.user_id}
                        row={r}
                        totalModules={summary.quiz_module_ids.length}
                        totalDocs={summary.required_signed_docs.length}
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const ThStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 11,
  fontWeight: 800,
  color: INK_MUTE,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  borderBottom: `1px solid ${LINE}`,
};

const TdStyle: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: 12.5,
  color: INK,
  borderBottom: `1px solid ${LINE_SOFT}`,
  verticalAlign: "top",
};

function RollupTile({
  label,
  value,
  color,
  active,
  onClick,
}: {
  label: string;
  value: number;
  color: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? color : SURFACE,
        color: active ? "#fff" : INK,
        border: `1px solid ${active ? color : LINE}`,
        borderRadius: 8,
        padding: "10px 12px",
        textAlign: "left",
        cursor: "pointer",
        fontFamily: FONT,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 800,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: active ? "rgba(255,255,255,0.85)" : INK_MUTE,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 800,
          color: active ? "#fff" : color,
          fontVariantNumeric: "tabular-nums",
          marginTop: 2,
        }}
      >
        {value}
      </div>
    </button>
  );
}

function AuditRow({
  row,
  totalModules,
  totalDocs,
}: {
  row: AuditRosterRow;
  totalModules: number;
  totalDocs: number;
}) {
  const c = row.compliance;
  const overallColor =
    c.overall === "complete"
      ? SUCCESS
      : c.overall === "needs_resign"
      ? WARN
      : c.overall === "overdue"
      ? DANGER
      : TEAL;
  const overallLabel =
    c.overall === "complete"
      ? "Complete"
      : c.overall === "needs_resign"
      ? "Needs re-sign"
      : c.overall === "overdue"
      ? "Overdue"
      : "In progress";

  return (
    <tr>
      <td style={TdStyle}>
        <div style={{ fontWeight: 700, color: INK }}>{row.full_name}</div>
        <div style={{ fontSize: 11, color: INK_LIGHT, marginTop: 2 }}>
          {row.email} · {row.role}
        </div>
      </td>
      <td style={TdStyle}>
        <span
          style={{
            background: overallColor + "20",
            color: overallColor,
            padding: "3px 8px",
            borderRadius: 999,
            fontSize: 10.5,
            fontWeight: 800,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
        >
          {overallLabel}
        </span>
      </td>
      <td style={TdStyle}>
        <CountCell
          done={row.passed_module_ids.length}
          total={totalModules}
          full={c.modules_complete}
        />
      </td>
      <td style={TdStyle}>
        <CountCell
          done={row.signed_document_types.length}
          total={totalDocs}
          full={c.docs_complete}
        />
      </td>
      <td style={TdStyle}>
        <CheckCell ok={c.final_passed} />
      </td>
      <td style={TdStyle}>
        <CheckCell ok={c.handbook_signed} />
      </td>
      <td style={TdStyle}>
        {c.pending_count > 0 ? (
          <span
            style={{
              color: WARN,
              fontWeight: 800,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {c.pending_count}
          </span>
        ) : (
          <span style={{ color: INK_LIGHT }}>0</span>
        )}
      </td>
      <td style={TdStyle}>
        <span style={{ fontSize: 11.5, color: INK_MUTE }}>
          {row.enrollment?.last_activity_at
            ? humanDateTime(row.enrollment.last_activity_at)
            : "—"}
        </span>
      </td>
    </tr>
  );
}

function CountCell({
  done,
  total,
  full,
}: {
  done: number;
  total: number;
  full: boolean;
}) {
  return (
    <span
      style={{
        color: full ? SUCCESS : INK,
        fontWeight: full ? 800 : 600,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {done}/{total}
    </span>
  );
}

function CheckCell({ ok }: { ok: boolean }) {
  if (ok) {
    return <CircleCheck size={16} style={{ color: SUCCESS }} />;
  }
  return (
    <span
      style={{
        fontSize: 14,
        color: INK_LIGHT,
        fontWeight: 700,
      }}
    >
      —
    </span>
  );
}

function LearnerCertificatesPanel({ row }: { row: RosterRow }) {
  const token = useAuthStore((s) => s.token);
  const [certs, setCerts] = useState<CertificateRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<CertificateRow[]>(
          "GET",
          `/lms/certificates/admin/learner/${row.user_id}`,
          token,
        );
        if (!cancelled) setCerts(data);
      } catch (e) {
        if (!cancelled) setErr(String((e as Error).message));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.user_id, token]);

  async function handleDownload(certId: number) {
    try {
      const url = `${API_BASE}/lms/certificates/${certId}/pdf`;
      const res = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(disposition);
      const filename = m?.[1] ?? `phes-cert-${certId}.pdf`;
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      console.error("[lms-admin] download cert failed:", e);
    }
  }

  if (err) {
    return (
      <div
        style={{
          marginTop: 12,
          padding: 10,
          background: "#FEF2F2",
          border: `1px solid #FECACA`,
          color: DANGER,
          borderRadius: 8,
          fontSize: 12,
        }}
      >
        Failed to load certificates: {err}
      </div>
    );
  }

  if (certs == null) {
    return (
      <div
        style={{
          marginTop: 12,
          fontSize: 12,
          color: INK_MUTE,
          fontStyle: "italic",
        }}
      >
        Loading certificates...
      </div>
    );
  }

  if (certs.length === 0) {
    return (
      <div
        style={{
          marginTop: 12,
          padding: 10,
          background: LINE_SOFT,
          borderRadius: 8,
          fontSize: 12,
          color: INK_MUTE,
        }}
      >
        No certificates issued yet. Certificates are auto-generated when a
        learner passes a quiz, acknowledges a content module, or has a
        module bypassed by an admin.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 14 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          color: INK_MUTE,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: 8,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Award size={12} /> Completion Certificates ({certs.length})
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 8,
        }}
      >
        {certs.map((c) => {
          const isRevoked = !!c.revoked_at;
          return (
            <div
              key={c.id}
              style={{
                background: SURFACE,
                border: `1px solid ${isRevoked ? "#FECACA" : LINE}`,
                borderLeft: `3px solid ${
                  isRevoked ? DANGER : c.passed ? SUCCESS : INK_LIGHT
                }`,
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 800, color: INK, fontSize: 12 }}>
                  {humanModule(c.module_id)}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: INK_MUTE,
                    marginTop: 2,
                    fontWeight: 600,
                  }}
                >
                  {c.score != null ? `${c.score}% · ` : ""}
                  {c.locale.toUpperCase()} · {humanDateTime(c.issued_at)}
                </div>
                {isRevoked ? (
                  <div
                    style={{
                      fontSize: 10,
                      color: DANGER,
                      fontWeight: 700,
                      marginTop: 2,
                    }}
                  >
                    REVOKED: {c.revoked_reason ?? "no reason given"}
                  </div>
                ) : null}
              </div>
              {!isRevoked ? (
                <button
                  type="button"
                  onClick={() => handleDownload(c.id)}
                  title="Download certificate PDF"
                  style={{
                    background: NAVY,
                    color: "#fff",
                    border: 0,
                    padding: "5px 10px",
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
                  <Download size={11} /> PDF
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LearnerSignedDocumentsPanel — Phase 3+ PR #4+: signed legal docs
// (Drug & Alcohol first; PR #5+ extend). Renders alongside the
// LearnerCertificatesPanel in the admin expand row.
// ─────────────────────────────────────────────────────────────────────────────

type SignedDocumentRow = {
  id: number;
  document_type: string;
  locale: string;
  signed_at: string;
  status: "active" | "superseded" | "revoked";
  version_hash: string;
  representative_user_id: number | null;
  representative_signed_at: string | null;
};

/**
 * Document types that require a Phes representative co-signature.
 * Mirrors CO_SIGNED_DOCUMENT_TYPES in @workspace/db/schema. Kept as a
 * Set here so the admin panel can decide when to render the Co-sign
 * action without round-tripping the server. PR #7 (non-solicit) will
 * use this same set.
 */
const CO_SIGNED_DOCUMENT_TYPES = new Set<string>([
  "video_photo_release",
  "non_solicitation",
]);

function humanDocumentType(documentType: string): string {
  const titles: Record<string, string> = {
    drug_alcohol: "Drug & Alcohol Policy",
    code_of_conduct: "Code of Conduct",
    video_photo_release: "Video / Photo Release",
    non_solicitation: "Non-Solicitation Agreement",
    supply_kit: "Supply Kit Responsibility",
    social_media: "Social Media Policy",
    handbook: "Employee Handbook",
  };
  return (
    titles[documentType] ??
    documentType
      .split(/[-_]/)
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
      .join(" ")
  );
}

function LearnerSignedDocumentsPanel({ row }: { row: RosterRow }) {
  const token = useAuthStore((s) => s.token);
  const [docs, setDocs] = useState<SignedDocumentRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [coSignOpen, setCoSignOpen] = useState<number | null>(null);
  const [coSignName, setCoSignName] = useState("");
  const [coSignAffirm, setCoSignAffirm] = useState(false);
  const [coSignSaving, setCoSignSaving] = useState(false);
  const [coSignErr, setCoSignErr] = useState<string | null>(null);

  async function loadDocs() {
    try {
      const data = await api<SignedDocumentRow[]>(
        "GET",
        `/lms/signatures/admin/learner/${row.user_id}`,
        token,
      );
      setDocs(data);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<SignedDocumentRow[]>(
          "GET",
          `/lms/signatures/admin/learner/${row.user_id}`,
          token,
        );
        if (!cancelled) setDocs(data);
      } catch (e) {
        if (!cancelled) setErr(String((e as Error).message));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.user_id, token]);

  function openCoSign(docId: number) {
    setCoSignOpen(docId);
    setCoSignName("");
    setCoSignAffirm(false);
    setCoSignErr(null);
  }

  async function submitCoSign(docId: number) {
    setCoSignSaving(true);
    setCoSignErr(null);
    try {
      await api("POST", `/lms/signatures/admin/co-sign`, token, {
        signedDocumentId: docId,
        affirmation: coSignAffirm,
        signature: coSignName.trim(),
        signatureMethod: "typed",
      });
      setCoSignOpen(null);
      setCoSignName("");
      setCoSignAffirm(false);
      await loadDocs();
    } catch (e) {
      setCoSignErr(String((e as Error).message));
    } finally {
      setCoSignSaving(false);
    }
  }

  async function handleDownload(docId: number) {
    try {
      const url = `${API_BASE}/lms/signatures/${docId}/pdf`;
      const res = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(disposition);
      const filename = m?.[1] ?? `phes-signed-${docId}.pdf`;
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      console.error("[lms-admin] download signed doc failed:", e);
    }
  }

  if (err) {
    return (
      <div
        style={{
          marginTop: 12,
          padding: 10,
          background: "#FEF2F2",
          border: `1px solid #FECACA`,
          color: DANGER,
          borderRadius: 8,
          fontSize: 12,
        }}
      >
        Failed to load signed documents: {err}
      </div>
    );
  }

  if (docs == null) {
    return (
      <div
        style={{
          marginTop: 12,
          fontSize: 12,
          color: INK_MUTE,
          fontStyle: "italic",
        }}
      >
        Loading signed documents...
      </div>
    );
  }

  if (docs.length === 0) {
    return (
      <div
        style={{
          marginTop: 12,
          padding: 10,
          background: LINE_SOFT,
          borderRadius: 8,
          fontSize: 12,
          color: INK_MUTE,
        }}
      >
        No legal acknowledgments signed yet. Phes-controlled signed
        documents appear here as each is signed.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 14 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          color: INK_MUTE,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: 8,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <FileSignature size={12} /> Signed Acknowledgments ({docs.length})
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 8,
        }}
      >
        {docs.map((d) => {
          const isActive = d.status === "active";
          const isRevoked = d.status === "revoked";
          const tone = isRevoked
            ? DANGER
            : isActive
            ? SUCCESS
            : INK_LIGHT;
          const needsCoSign =
            isActive &&
            CO_SIGNED_DOCUMENT_TYPES.has(d.document_type) &&
            d.representative_signed_at == null;
          const expanded = coSignOpen === d.id;
          return (
            <div
              key={d.id}
              style={{
                background: SURFACE,
                border: `1px solid ${isRevoked ? "#FECACA" : LINE}`,
                borderLeft: `3px solid ${tone}`,
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 800, color: INK, fontSize: 12 }}>
                    {humanDocumentType(d.document_type)}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: INK_MUTE,
                      marginTop: 2,
                      fontWeight: 600,
                    }}
                  >
                    {d.locale.toUpperCase()} · {humanDateTime(d.signed_at)} ·{" "}
                    {d.status === "active"
                      ? "Active"
                      : d.status === "superseded"
                      ? "Superseded"
                      : "Revoked"}
                  </div>
                  {d.representative_signed_at ? (
                    <div
                      style={{
                        fontSize: 10,
                        color: SUCCESS,
                        fontWeight: 700,
                        marginTop: 2,
                      }}
                    >
                      Co-signed by Phes representative
                    </div>
                  ) : null}
                  {needsCoSign ? (
                    <div
                      style={{
                        fontSize: 10,
                        color: "#BA7517",
                        fontWeight: 700,
                        marginTop: 2,
                      }}
                    >
                      Awaiting Phes representative co-signature
                    </div>
                  ) : null}
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  {needsCoSign && !expanded ? (
                    <button
                      type="button"
                      onClick={() => openCoSign(d.id)}
                      title="Co-sign as Phes representative"
                      style={{
                        background: "#BA7517",
                        color: "#fff",
                        border: 0,
                        padding: "5px 10px",
                        borderRadius: 6,
                        fontSize: 11,
                        fontWeight: 800,
                        cursor: "pointer",
                        fontFamily: FONT,
                      }}
                    >
                      Co-sign
                    </button>
                  ) : null}
                  {!isRevoked ? (
                    <button
                      type="button"
                      onClick={() => handleDownload(d.id)}
                      title="Download signed PDF"
                      style={{
                        background: NAVY,
                        color: "#fff",
                        border: 0,
                        padding: "5px 10px",
                        borderRadius: 6,
                        fontSize: 11,
                        fontWeight: 800,
                        cursor: "pointer",
                        fontFamily: FONT,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <Download size={11} /> PDF
                    </button>
                  ) : null}
                </div>
              </div>
              {expanded ? (
                <div
                  style={{
                    marginTop: 10,
                    padding: 10,
                    background: LINE_SOFT,
                    borderRadius: 6,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: INK,
                    }}
                  >
                    Co-sign as Phes representative
                  </div>
                  <input
                    type="text"
                    placeholder="Type your full legal name"
                    value={coSignName}
                    onChange={(e) => setCoSignName(e.target.value)}
                    disabled={coSignSaving}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: `1px solid ${LINE}`,
                      fontSize: 12,
                      fontFamily: FONT,
                      background: SURFACE,
                      color: INK,
                    }}
                  />
                  <label
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "flex-start",
                      fontSize: 11,
                      color: INK,
                      lineHeight: 1.4,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={coSignAffirm}
                      onChange={(e) => setCoSignAffirm(e.target.checked)}
                      disabled={coSignSaving}
                      style={{ marginTop: 2 }}
                    />
                    <span>
                      I affirm that I am the Phes representative authorized
                      to co-sign this acknowledgment on behalf of the
                      company, and that my electronic signature has the same
                      legal effect as a handwritten signature.
                    </span>
                  </label>
                  {coSignErr ? (
                    <div
                      style={{
                        fontSize: 11,
                        color: DANGER,
                        fontWeight: 600,
                      }}
                    >
                      {coSignErr}
                    </div>
                  ) : null}
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      onClick={() => submitCoSign(d.id)}
                      disabled={
                        coSignSaving ||
                        !coSignAffirm ||
                        coSignName.trim().length < 2
                      }
                      style={{
                        background:
                          coSignSaving ||
                          !coSignAffirm ||
                          coSignName.trim().length < 2
                            ? INK_LIGHT
                            : SUCCESS,
                        color: "#fff",
                        border: 0,
                        padding: "6px 12px",
                        borderRadius: 6,
                        fontSize: 11,
                        fontWeight: 800,
                        cursor:
                          coSignSaving ||
                          !coSignAffirm ||
                          coSignName.trim().length < 2
                            ? "not-allowed"
                            : "pointer",
                        fontFamily: FONT,
                      }}
                    >
                      {coSignSaving ? "Co-signing..." : "Co-sign"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setCoSignOpen(null)}
                      disabled={coSignSaving}
                      style={{
                        background: SURFACE,
                        color: INK,
                        border: `1px solid ${LINE}`,
                        padding: "6px 12px",
                        borderRadius: 6,
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: "pointer",
                        fontFamily: FONT,
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
