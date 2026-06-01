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
import { useLocation } from "wouter";
import { useAuthStore } from "@/lib/auth";
import { QlenoLogo } from "@/components/brand/QlenoLogo";
import {
  MODULE_ORDER,
  QUIZ_MODULE_IDS,
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
  userId?: number;
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
  days_remaining: number | null;
  deadline_started_at: string | null;
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
  const [, setLocation] = useLocation();
  const auth = useMemo(() => readRoleFromToken(token), [token]);
  const isAuthorized =
    auth?.role === "owner" ||
    auth?.role === "admin" ||
    auth?.role === "super_admin" ||
    auth?.role === "office";
  const isMobile = useViewportIsMobile();
  const [rows, setRows] = useState<RosterRow[] | null>(null);
  // Item 8 (P1 sprint): owner-only bypass by default. Frontend reads
  // the per-tenant `admin_bypass_allowed` flag from /api/lms-settings
  // and passes it to ModuleAttemptsGrid so the Bypass button is
  // hidden for admins when the toggle is off. Backend enforces too.
  const [adminBypassAllowed, setAdminBypassAllowed] = useState<boolean>(false);
  // Sprint 2026-05-15: owner-only add/edit by default. Same gating
  // pattern as bypass — admins only see the buttons when the matching
  // setting is on. Office never sees them.
  const [adminAddAllowed, setAdminAddAllowed] = useState<boolean>(false);
  const [adminEditAllowed, setAdminEditAllowed] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [extendOpen, setExtendOpen] = useState<RosterRow | null>(null);
  const [resetOpen, setResetOpen] = useState<RosterRow | null>(null);
  // Item 3 (P0 sprint): owner-only LMS archive (soft-delete from
  // roster + audit dashboard, preserves cert / sig history).
  const [archiveOpen, setArchiveOpen] = useState<RosterRow | null>(null);
  // Item 4 (P0 sprint): reset-deadline (clears deadline_started_at).
  const [resetDeadlineOpen, setResetDeadlineOpen] =
    useState<RosterRow | null>(null);
  const [historyOpen, setHistoryOpen] = useState<RosterRow | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [bulkPwOpen, setBulkPwOpen] = useState(false);
  const [cyclesOpen, setCyclesOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [addEmpOpen, setAddEmpOpen] = useState(false);
  const [editEmpOpen, setEditEmpOpen] = useState<RosterRow | null>(null);

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
      // Settings fetch is fire-and-forget for the roster path. If the
      // GET fails (admin without read perm, network blip), we leave
      // adminBypassAllowed=false (the safe default).
      try {
        const settings = await api<{
          admin_bypass_allowed: boolean;
          admin_add_employee_allowed: boolean;
          admin_edit_employee_allowed: boolean;
        }>(
          "GET",
          "/lms-settings",
          token,
        );
        setAdminBypassAllowed(!!settings.admin_bypass_allowed);
        setAdminAddAllowed(!!settings.admin_add_employee_allowed);
        setAdminEditAllowed(!!settings.admin_edit_employee_allowed);
      } catch {
        setAdminBypassAllowed(false);
        setAdminAddAllowed(false);
        setAdminEditAllowed(false);
      }
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

  // 2026-05-20: per-module reset. Mirrors bypassFor's shape so the
  // grid's prop wiring is symmetric. Wipes module_progress, all
  // quiz_attempts, and the autosave for the ONE module. Other modules
  // + the enrollment + certs are untouched.
  async function resetModuleFor(userId: number, moduleId: string) {
    try {
      await api("POST", "/lms/admin/reset-module", token, { userId, moduleId });
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
            {/* Sprint 2026-05-15: owner always; admin when
                admin_add_employee_allowed is on. Office never sees. */}
            {auth?.role === "owner" ||
            (auth?.role === "admin" && adminAddAllowed) ? (
              <button
                type="button"
                onClick={() => setAddEmpOpen(true)}
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
                Add Employee
              </button>
            ) : null}
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
            {/* Item 9 (P1 sprint): owner-only Settings page entry. */}
            {auth?.role === "owner" ? (
              <button
                type="button"
                onClick={() => setLocation("/lms/admin/settings")}
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
                Settings
              </button>
            ) : null}
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
            onResetModule={resetModuleFor}
            onArchive={setArchiveOpen}
            onResetDeadline={setResetDeadlineOpen}
            onEdit={setEditEmpOpen}
            callerRole={auth?.role ?? null}
            callerUserId={auth?.userId ?? null}
            adminBypassAllowed={adminBypassAllowed}
            adminEditAllowed={adminEditAllowed}
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
            onResetModule={resetModuleFor}
            onArchive={setArchiveOpen}
            onResetDeadline={setResetDeadlineOpen}
            onEdit={setEditEmpOpen}
            callerRole={auth?.role ?? null}
            callerUserId={auth?.userId ?? null}
            adminBypassAllowed={adminBypassAllowed}
            adminEditAllowed={adminEditAllowed}
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

      {archiveOpen && (
        <ArchiveEmployeeDialog
          row={archiveOpen}
          token={token}
          callerRole={auth?.role ?? null}
          onClose={() => setArchiveOpen(null)}
          onSaved={async () => {
            setArchiveOpen(null);
            await refresh();
          }}
        />
      )}

      {resetDeadlineOpen && (
        <ResetDeadlineDialog
          row={resetDeadlineOpen}
          token={token}
          onClose={() => setResetDeadlineOpen(null)}
          onSaved={async () => {
            setResetDeadlineOpen(null);
            await refresh();
          }}
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

      {addEmpOpen && (
        <AddEmployeeDialog
          token={token}
          onClose={() => setAddEmpOpen(false)}
          onSaved={async () => {
            setAddEmpOpen(false);
            await refresh();
          }}
        />
      )}

      {editEmpOpen && (
        <EditEmployeeDialog
          row={editEmpOpen}
          token={token}
          onClose={() => setEditEmpOpen(null)}
          onSaved={async () => {
            setEditEmpOpen(null);
            await refresh();
          }}
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
  const [, setLocation] = useLocation();
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
          {/* Sal report 2026-05-20: from /lms/admin there was no path
              back to the main Qleno app. Wrapping the logo in a
              clickable mirrors the same fix shipped on /training in
              PR #135 — "logo = home" UX convention. */}
          <button
            type="button"
            onClick={() => setLocation("/")}
            aria-label="Back to Qleno"
            style={{
              background: "transparent",
              border: 0,
              padding: 0,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            <QlenoLogo size="md" theme="light" layout="horizontal" />
          </button>
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
  onResetModule,
  onArchive,
  onResetDeadline,
  onEdit,
  callerRole,
  callerUserId,
  adminBypassAllowed,
  adminEditAllowed,
}: {
  rows: RosterRow[];
  expanded: Set<number>;
  onToggleExpand: (id: number) => void;
  onExtend: (r: RosterRow) => void;
  onReset: (r: RosterRow) => void;
  onHistory: (r: RosterRow) => void;
  onBypass: (userId: number, moduleId: string) => Promise<void>;
  onResetModule: (userId: number, moduleId: string) => Promise<void>;
  onArchive: (r: RosterRow) => void;
  onResetDeadline: (r: RosterRow) => void;
  onEdit: (r: RosterRow) => void;
  callerRole: string | null;
  /**
   * Caller's own user_id (from JWT). Used to hide destructive buttons
   * on the caller's own row (Reset / Reset deadline / Archive / Edit).
   * Backend already enforces "Cannot archive yourself" + "Cannot
   * archive an owner" but the UI should not advertise actions that
   * can't complete.
   */
  callerUserId: number | null;
  adminBypassAllowed: boolean;
  adminEditAllowed: boolean;
}) {
  const canEdit =
    callerRole === "owner" || (callerRole === "admin" && adminEditAllowed);
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
                  {/* PR 2: link to Journey page. The roster row name is
                      the primary entry point into the consolidated
                      single-pane-of-glass view. */}
                  <button
                    type="button"
                    onClick={() =>
                      setLocation(`/lms/admin/employee/${r.user_id}`)
                    }
                    style={{
                      background: "transparent",
                      border: 0,
                      padding: 0,
                      color: NAVY,
                      fontWeight: 700,
                      textAlign: "left",
                      cursor: "pointer",
                      fontFamily: FONT,
                      textDecoration: "underline",
                      textDecorationColor: LINE,
                      textDecorationThickness: 1,
                      textUnderlineOffset: 3,
                    }}
                  >
                    {r.tech_name}
                  </button>
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
                    {/* Audit 2026-05-19: hide Reset on caller's own
                        row. Backend allows it (resetting your own
                        progress is technically valid) but the UX is
                        a foot-gun for an owner mid-test-walkthrough. */}
                    {callerUserId !== r.user_id ? (
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
                    ) : null}
                    {/* Item 4 (P0 sprint): clears deadline_started_at
                        so the countdown re-starts on next attempt.
                        Hidden on caller's own row per the audit above. */}
                    {callerUserId !== r.user_id ? (
                      <button
                        type="button"
                        onClick={() => onResetDeadline(r)}
                        title="Reset deadline (clears countdown until next quiz attempt)"
                        style={{
                          background: "transparent",
                          color: INK_MUTE,
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
                        <CalendarClock size={11} /> Reset deadline
                      </button>
                    ) : null}
                    {/* Sprint 2026-05-15: owner-default Edit Employee.
                        Admin sees it when admin_edit_employee_allowed
                        is on. Office never sees it.
                        2026-05-22 (Sal): admins cannot edit themselves
                        or another admin — they are counterparts in the
                        chain. Owner can edit anyone. */}
                    {canEdit
                      && !(
                        callerRole === "admin"
                        && (r.user_id === callerUserId || r.role === "admin")
                      ) ? (
                      <button
                        type="button"
                        onClick={() => onEdit(r)}
                        title="Edit employee name, email, role, or hire date"
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
                        Edit
                      </button>
                    ) : null}
                    {/* Item 3 (P0 sprint): owner-only soft-delete from
                        LMS surfaces. Preserves cert / signature
                        history for legal. */}
                    {callerRole === "owner" ? (
                      <button
                        type="button"
                        onClick={() => onArchive(r)}
                        title="Archive employee from LMS roster (preserves history)"
                        style={{
                          background: "transparent",
                          color: DANGER,
                          border: `1px solid ${DANGER}`,
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
                        <X size={11} /> Archive
                      </button>
                    ) : null}
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
                    <ModuleAttemptsGrid row={r} onBypass={onBypass} onResetModule={onResetModule} callerRole={callerRole} adminBypassAllowed={adminBypassAllowed} />
                    <LearnerCertificatesPanel row={r} />
                    <LearnerSignedDocumentsPanel row={r} />
                    <LearnerOnboardingIntakePanel row={r} />
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
  onResetModule,
  callerRole,
  adminBypassAllowed,
}: {
  row: RosterRow;
  onBypass: (userId: number, moduleId: string) => Promise<void>;
  onResetModule: (userId: number, moduleId: string) => Promise<void>;
  callerRole: string | null;
  adminBypassAllowed: boolean;
}) {
  // Item 8 (P1 sprint): bypass visibility gate.
  //   - Owner always sees Bypass.
  //   - Admin only sees when admin_bypass_allowed setting is true.
  //   - Office NEVER sees Bypass (was a backend-only path before).
  const canSeeBypass =
    callerRole === "owner" ||
    (callerRole === "admin" && adminBypassAllowed);
  // Type-to-confirm dialog state. The clicked moduleId is the
  // expected confirm string — caller types the module name to
  // enable the destructive button.
  const [pendingBypass, setPendingBypass] = useState<string | null>(null);
  // 2026-05-20: per-module reset. Wipes module_progress + quiz_attempts
  // + autosave for the named module only. Owner+admin only (same gate
  // as bypass — both are destructive admin actions). Visible whenever
  // the module has been touched (status != not_started OR attempts > 0).
  const [pendingResetModule, setPendingResetModule] = useState<string | null>(null);
  const canSeeReset = callerRole === "owner" || callerRole === "admin";
  // Item 2 (P0 sprint): canonical denominator. We list the 13 quiz
  // modules + the Final Mixed Test as a separate trailing card. The
  // older content-only "acknowledgment" entry from MODULE_ORDER is
  // not surfaced here — it doesn't exist in the current curriculum
  // and the count needs to match the dashboard / training surfaces
  // (which use QUIZ_MODULE_IDS).
  const allIds: string[] = [...QUIZ_MODULE_IDS, FINAL_MODULE_ID];
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
        {QUIZ_MODULE_IDS.length} modules + Final test · Bypass any module
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
              {!passed && canSeeBypass ? (
                <button
                  type="button"
                  onClick={() => setPendingBypass(moduleId)}
                  title="Bypass — mark as passed"
                  style={{
                    // Item 8 (P1 sprint): red ghost. Misclick risk on
                    // a long roster is real; this is destructive
                    // (mutates the "Passed" record on a learner).
                    background: "transparent",
                    color: DANGER,
                    border: `1px solid ${DANGER}`,
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
              {/* 2026-05-20: per-module Reset. Shown when the module
                  has been touched (so there's something to wipe) and
                  the caller is owner/admin. Wipes module_progress +
                  quiz_attempts + autosave for THIS module only. */}
              {canSeeReset && (status !== "not_started" || attempts > 0) ? (
                <button
                  type="button"
                  onClick={() => setPendingResetModule(moduleId)}
                  title="Reset this module (wipes progress, attempts, autosave)"
                  style={{
                    background: "transparent",
                    color: INK_MUTE,
                    border: `1px solid ${LINE}`,
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
                  <RotateCcw size={11} /> Reset
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {pendingBypass !== null ? (
        <BypassConfirmDialog
          moduleId={pendingBypass}
          onClose={() => setPendingBypass(null)}
          onConfirm={async () => {
            await onBypass(row.user_id, pendingBypass);
            setPendingBypass(null);
          }}
        />
      ) : null}
      {pendingResetModule !== null ? (
        <ModuleResetConfirmDialog
          moduleId={pendingResetModule}
          onClose={() => setPendingResetModule(null)}
          onConfirm={async () => {
            await onResetModule(row.user_id, pendingResetModule);
            setPendingResetModule(null);
          }}
        />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ModuleResetConfirmDialog (2026-05-20)
//
// Type-RESET-to-confirm gate before wiping a single module's progress,
// attempts, and autosave for the targeted learner. Mirrors the Bypass
// dialog pattern. Owner+admin only.
// ─────────────────────────────────────────────────────────────────────────────

function ModuleResetConfirmDialog({
  moduleId,
  onClose,
  onConfirm,
}: {
  moduleId: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const expected = "RESET";
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = confirm.trim().toUpperCase() === expected;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Reset module"
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
          padding: 24,
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
          <AlertTriangle size={16} style={{ color: DANGER }} /> Reset {humanModule(moduleId)}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: INK_MUTE,
            marginTop: 6,
            lineHeight: 1.55,
          }}
        >
          Wipes the learner's progress on JUST this module: module status,
          best score, attempt count, quiz autosave, and the immutable
          attempt history rows. Other modules + the enrollment + the
          deadline + any earned certificates are NOT touched.
        </div>
        <label
          style={{
            display: "block",
            fontSize: 11,
            fontWeight: 800,
            color: INK_MUTE,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            marginTop: 16,
            marginBottom: 6,
          }}
        >
          Type RESET to confirm
        </label>
        <input
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="RESET"
          autoFocus
          style={{
            width: "100%",
            padding: "8px 10px",
            border: `1px solid ${LINE}`,
            borderRadius: 6,
            fontSize: 13,
            fontFamily: FONT,
            color: INK,
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        {err ? (
          <div
            style={{
              marginTop: 10,
              fontSize: 12,
              color: DANGER,
              fontWeight: 700,
            }}
          >
            {err}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 18,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              background: "transparent",
              border: `1px solid ${LINE}`,
              color: INK,
              padding: "8px 14px",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 700,
              cursor: busy ? "default" : "pointer",
              fontFamily: FONT,
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
                await onConfirm();
              } catch (e) {
                setErr(String((e as Error).message));
                setBusy(false);
              }
            }}
            style={{
              background: valid && !busy ? DANGER : INK_MUTE,
              border: 0,
              color: "#fff",
              padding: "8px 14px",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 800,
              cursor: valid && !busy ? "pointer" : "default",
              fontFamily: FONT,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              opacity: valid && !busy ? 1 : 0.7,
            }}
          >
            <RotateCcw size={12} /> {busy ? "Resetting…" : "Reset module"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BypassConfirmDialog (Item 8, P1 sprint 2026-05-14)
//
// Type-to-confirm gate before mutating a learner's module_progress
// record to status='passed'. Owner / admin (when allowed) types the
// uppercase module name to enable the destructive button. Mirrors
// the Reset Enrollment dialog pattern.
// ─────────────────────────────────────────────────────────────────────────────

function BypassConfirmDialog({
  moduleId,
  onClose,
  onConfirm,
}: {
  moduleId: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const expected = humanModule(moduleId).toUpperCase();
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = confirm.trim().toUpperCase() === expected;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Bypass module"
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
          padding: 24,
          fontFamily: FONT,
          color: INK,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 800, color: INK }}>
          Bypass {humanModule(moduleId)}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: INK_MUTE,
            marginTop: 6,
            lineHeight: 1.55,
          }}
        >
          Marks this module as PASSED for the learner without them
          taking the quiz. Issues a completion certificate. The action
          is logged with your name + role for legal. Only use when you
          have a clear reason (technical error, accommodation,
          documented prior credit).
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
          Type the module name to confirm: <strong>{expected}</strong>
        </label>
        <input
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={expected}
          disabled={busy}
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
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await onConfirm();
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
            }}
          >
            {busy ? "Bypassing…" : "Bypass module"}
          </button>
        </div>
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
  onResetModule,
  onArchive,
  onResetDeadline,
  onEdit,
  callerRole,
  callerUserId,
  adminBypassAllowed,
  adminEditAllowed,
}: {
  rows: RosterRow[];
  expanded: Set<number>;
  onToggleExpand: (id: number) => void;
  onExtend: (r: RosterRow) => void;
  onReset: (r: RosterRow) => void;
  onHistory: (r: RosterRow) => void;
  onBypass: (userId: number, moduleId: string) => Promise<void>;
  onResetModule: (userId: number, moduleId: string) => Promise<void>;
  onArchive: (r: RosterRow) => void;
  onResetDeadline: (r: RosterRow) => void;
  onEdit: (r: RosterRow) => void;
  callerRole: string | null;
  /**
   * Caller's own user_id (from JWT). Used to hide destructive buttons
   * on the caller's own row (Reset / Reset deadline / Archive / Edit).
   * Backend already enforces "Cannot archive yourself" + "Cannot
   * archive an owner" but the UI should not advertise actions that
   * can't complete.
   */
  callerUserId: number | null;
  adminBypassAllowed: boolean;
  adminEditAllowed: boolean;
}) {
  const canEdit =
    callerRole === "owner" || (callerRole === "admin" && adminEditAllowed);
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
              {canEdit
                && !(
                  callerRole === "admin"
                  && (r.user_id === callerUserId || r.role === "admin")
                ) ? (
                <button
                  type="button"
                  onClick={() => onEdit(r)}
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
                  }}
                >
                  Edit
                </button>
              ) : null}
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
              <ModuleAttemptsGrid row={r} onBypass={onBypass} onResetModule={onResetModule} callerRole={callerRole} adminBypassAllowed={adminBypassAllowed} />
              <LearnerCertificatesPanel row={r} />
              <LearnerSignedDocumentsPanel row={r} />
              <LearnerOnboardingIntakePanel row={r} />
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

function DaysBadge({ days }: { days: number | null }) {
  let tone = SUCCESS;
  let bg = "#ECFDF5";
  let Icon: typeof CircleCheck = CircleCheck;
  // Item 4 (P0 sprint): null = countdown hasn't started.
  if (days === null) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: "#F1F5F9",
          color: INK_MUTE,
          border: `1px solid ${LINE}`,
          padding: "3px 8px",
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 700,
          whiteSpace: "nowrap",
        }}
      >
        <CalendarClock size={11} /> Not yet started
      </span>
    );
  }
  // Item 13b (P0 sprint): "1 days" → "1 day" pluralization.
  const isSingular = Math.abs(days) === 1;
  let label = `${days} ${isSingular ? "day" : "days"}`;
  if (days < 0) {
    tone = DANGER;
    bg = "#FEF2F2";
    label = `${Math.abs(days)} ${isSingular ? "day" : "days"} overdue`;
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

// Item 13c (P1 sprint 2026-05-14): canonical display titles per
// module id. Pre-fix, the helper just split-on-dash + capitalized,
// which produced "Il Sexual Harassment" for `il-sexual-harassment`
// instead of the proper "Illinois Sexual Harassment Prevention".
// Audit any future module name changes against this map.
const MODULE_DISPLAY_TITLES: Record<string, string> = {
  "phes-policies": "Phes Policies & Procedures",
  "compensation": "Compensation",
  "cleaning-best-practices": "Cleaning Best Practices",
  "maidcentral": "MaidCentral",
  "products-tools": "Products & Tools",
  "il-sexual-harassment": "Illinois Sexual Harassment Prevention",
  "drug-alcohol": "Drug & Alcohol",
  "code-of-conduct": "Code of Conduct",
  "video-photo-release": "Video & Photo Release",
  "non-solicitation": "Non-Solicitation",
  "social-media": "Social Media",
  "phes-401k": "Phes 401(k)",
  "supply-kit": "Supply Kit Responsibility",
  "__final": "Final Mixed Test",
  "__handbook": "Comprehensive Handbook",
  "acknowledgment": "Acknowledgment",
};

function humanModule(id: string | null): string {
  if (!id) return "—";
  if (MODULE_DISPLAY_TITLES[id]) return MODULE_DISPLAY_TITLES[id];
  // Fallback: split-on-dash + Title Case for unknown ids.
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
  // Item 13c (P1 sprint): delegate to the canonical humanModule
  // helper so attempt-history headers don't show "Il Sexual
  // Harassment" while the rest of the dashboard shows the proper
  // "Illinois Sexual Harassment Prevention".
  if (MODULE_DISPLAY_TITLES[id]) return MODULE_DISPLAY_TITLES[id];
  if (id === "__final") return "Final Mixed Test";
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

  // Item 2 (P0 sprint): use the canonical 13-quiz-module list, not
  // MODULE_ORDER, so the attempt-history view's denominator matches
  // the dashboard + admin grid.
  const moduleIds: string[] = [...QUIZ_MODULE_IDS, FINAL_MODULE_ID];

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

// Generate a random per-dialog password. "Phes" prefix + 6 random
// alphanumerics (mixed case + digits). Regenerated on every dialog
// open so the suggested default is never a real user password.
// Item 1 (P0 sprint): the previous "Chicago23" hardcoded default
// happened to be the owner's actual current password, which is the
// kind of foot-gun we should never ship.
function generateBulkResetPassword(): string {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return `Phes${suffix}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ResetDeadlineDialog (Item 4, P0 sprint)
//
// Clears the enrollment's deadline_started_at so the countdown is
// suppressed in the UI ("Not yet started") until the next quiz attempt
// re-stamps it. Type-to-confirm gate matches the Reset Enrollment
// dialog pattern.
// ─────────────────────────────────────────────────────────────────────────────

function ResetDeadlineDialog({
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const expectedConfirm = "RESET";
  const valid = confirm.trim().toUpperCase() === expectedConfirm;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Reset deadline"
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
          padding: 24,
          fontFamily: FONT,
          color: INK,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 800, color: INK }}>
          Reset deadline — {row.tech_name}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: INK_MUTE,
            marginTop: 6,
            lineHeight: 1.55,
          }}
        >
          Clears the deadline countdown. The countdown re-starts on this
          employee's next quiz attempt with a fresh 7-day window. Use
          this when an employee never logged in within their first
          window and the office wants to give them a clean shot. To
          extend an active deadline, use Extend instead.
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
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await api("POST", "/lms/admin/reset-deadline", token, {
                  enrollmentId: row.enrollment_id,
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
          >
            {busy ? "Resetting…" : "Reset deadline"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ArchiveEmployeeDialog (Item 3, P0 sprint)
//
// Owner-only soft-delete from LMS surfaces. Hides the user from the
// roster + audit dashboard while preserving certificates, signed
// documents, and quiz attempt history for legal. Type-to-confirm
// requires the employee's exact name (not a generic word) — this is
// destructive enough to warrant a real intentional act.
// ─────────────────────────────────────────────────────────────────────────────

function ArchiveEmployeeDialog({
  row,
  token,
  callerRole,
  onClose,
  onSaved,
}: {
  row: RosterRow;
  token: string | null;
  callerRole: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const expected = row.tech_name.trim();
  const valid = confirm.trim() === expected && expected.length > 0;
  const isOwner = callerRole === "owner";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Archive employee"
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
          maxWidth: 480,
          width: "100%",
          padding: 24,
          fontFamily: FONT,
          color: INK,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 800, color: INK }}>
          Archive employee — {row.tech_name}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: INK_MUTE,
            marginTop: 6,
            lineHeight: 1.55,
          }}
        >
          Hides this employee from the LMS roster + audit dashboard.
          Their certificates, signatures, and quiz attempt history
          stay in the database for legal. They will not be able to
          log in to /training. Reversible — clear the column manually
          to restore.
        </div>
        {!isOwner ? (
          <div
            style={{
              marginTop: 14,
              padding: 10,
              background: "#FEF2F2",
              border: `1px solid ${DANGER}`,
              color: DANGER,
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            Owner role required.
          </div>
        ) : null}
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
          Type the employee's name to confirm: <strong>{expected}</strong>
        </label>
        <input
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={expected}
          disabled={busy || !isOwner}
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
            disabled={!valid || busy || !isOwner}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await api("POST", `/users/${row.user_id}/lms-archive`, token);
                await onSaved();
              } catch (e) {
                setErr(String((e as Error).message));
              } finally {
                setBusy(false);
              }
            }}
            style={{
              background: !valid || busy || !isOwner ? INK_LIGHT : DANGER,
              color: "#fff",
              border: 0,
              padding: "8px 14px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 700,
              fontFamily: FONT,
              cursor: !valid || busy || !isOwner ? "default" : "pointer",
            }}
          >
            {busy ? "Archiving…" : "Archive employee"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AddEmployeeDialog (sprint 2026-05-15)
//
// Owner-default, admin-when-allowed. Posts to POST /api/users/lms-add which
// (a) creates a tenant-scoped users row, (b) auto-enrolls the user in the
// LMS, (c) returns a one-time-visible temp password the office team can
// share with the new hire. EN/ES copy throughout.
// ─────────────────────────────────────────────────────────────────────────────
function AddEmployeeDialog({
  token,
  onClose,
  onSaved,
}: {
  token: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Default hire date = today (local time). The user can pick any past or
  // future date; we don't constrain.
  const today = useMemo(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }, []);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"technician" | "admin">("technician");
  const [hireDate, setHireDate] = useState(today);
  const [homeBranchId, setHomeBranchId] = useState<number | "">("");
  const [branchOptions, setBranchOptions] = useState<Array<{ id: number; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // [Model A — Step 6] Load branches for this tenant so the operator picks a
  // home branch for the new hire. Default to the tenant's default branch once
  // the list comes back, so the most common path (Oak Lawn at Phes) is zero-
  // click. Home branch is preference-only; cross-branch assignment is still
  // allowed.
  useEffect(() => {
    if (!token) return;
    fetch(`${API_BASE}/branches`, { headers: { authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : [])
      .then((rows: any[]) => {
        const active = (Array.isArray(rows) ? rows : []).filter(b => b.is_active);
        setBranchOptions(active);
        if (homeBranchId === "") {
          const def = active.find(b => b.is_default) ?? active[0];
          if (def) setHomeBranchId(def.id);
        }
      })
      .catch(() => {});
  // homeBranchId intentionally excluded — we only pre-fill once on load.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  const [result, setResult] = useState<{
    user: { id: number; email: string; first_name: string; last_name: string };
    temp_password: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [lang, setLang] = useState<"en" | "es">("en");

  const T = lang === "es"
    ? {
        title: "Agregar empleado",
        subtitle:
          "Crea una cuenta nueva, inscrita automáticamente en el LMS de Phes.",
        firstName: "Nombre",
        lastName: "Apellido",
        email: "Correo electrónico",
        role: "Rol",
        roleTech: "Técnico",
        roleAdmin: "Administrador de grupo",
        hireDate: "Fecha de contratación",
        homeBranch: "Sucursal principal",
        homeBranchHint: "Sucursal por defecto. Puede asignarse a otra cuando sea necesario.",
        cancel: "Cancelar",
        submit: "Crear empleado",
        submitting: "Creando…",
        successTitle: "Empleado creado",
        successHint:
          "La contraseña temporal del nuevo integrante es la mostrada abajo. La oficina entrega las credenciales en persona y debe rotarla después del primer inicio de sesión.",
        tempPassword: "Contraseña temporal",
        copy: "Copiar",
        copied: "¡Copiado!",
        close: "Cerrar",
        shareHelp:
          "El equipo de oficina puede entregar estos datos al nuevo integrante en persona o por mensaje seguro.",
      }
    : {
        title: "Add Employee",
        subtitle:
          "Create a new tenant-scoped account, auto-enrolled in the Phes LMS.",
        firstName: "First name",
        lastName: "Last name",
        email: "Email",
        role: "Role",
        roleTech: "Technician",
        roleAdmin: "Group Administrator",
        hireDate: "Hire date",
        homeBranch: "Home branch",
        homeBranchHint: "Default branch. Can still be assigned to jobs at other branches when needed.",
        cancel: "Cancel",
        submit: "Create employee",
        submitting: "Creating…",
        successTitle: "Employee created",
        successHint:
          "The new hire's temporary password is shown below. The office team delivers credentials in person and should rotate the password after first sign-in.",
        tempPassword: "Temporary password",
        copy: "Copy",
        copied: "Copied",
        close: "Close",
        shareHelp:
          "The office team can hand this off to the new hire in person or via a secure message.",
      };

  const valid =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    /^\d{4}-\d{2}-\d{2}$/.test(hireDate) &&
    typeof homeBranchId === "number";

  async function onSubmit() {
    if (!valid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`${API_BASE}/users/lms-add`, {
        method: "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim().toLowerCase(),
          role,
          hire_date: hireDate,
          home_branch_id: homeBranchId,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        try {
          const parsed = JSON.parse(text);
          throw new Error(parsed.message || parsed.error || `HTTP ${res.status}`);
        } catch {
          throw new Error(text || `HTTP ${res.status}`);
        }
      }
      const json = await res.json();
      setResult(json.data);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function copyPw() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.temp_password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API gated by user permission on some browsers;
      // the password is still visible on screen, so this is non-fatal.
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
          maxHeight: "90vh",
          overflow: "auto",
          fontFamily: FONT,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 8,
          }}
        >
          <div style={{ fontWeight: 800, fontSize: 18, color: INK }}>
            {T.title}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <LangChip lang={lang} setLang={setLang} />
            <button
              type="button"
              onClick={onClose}
              aria-label={T.close}
              style={{
                background: "transparent",
                border: 0,
                cursor: "pointer",
                color: INK_MUTE,
              }}
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <div style={{ fontSize: 13, color: INK_MUTE, marginTop: 4 }}>
          {T.subtitle}
        </div>

        {result ? (
          <div style={{ marginTop: 16 }}>
            <div
              style={{
                padding: "10px 12px",
                background: "#ECFDF5",
                border: `1px solid ${SUCCESS}`,
                borderRadius: 8,
                color: SUCCESS,
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              {T.successTitle}: {result.user.first_name} {result.user.last_name} ({result.user.email})
            </div>
            <div
              style={{
                marginTop: 14,
                fontSize: 12,
                fontWeight: 700,
                color: INK_MUTE,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              {T.tempPassword}
            </div>
            <div
              style={{
                marginTop: 6,
                padding: "10px 12px",
                border: `1px solid ${LINE}`,
                background: "#F8FAFC",
                borderRadius: 8,
                display: "flex",
                gap: 10,
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <code
                style={{
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 15,
                  color: INK,
                  fontWeight: 700,
                  userSelect: "all",
                }}
              >
                {result.temp_password}
              </code>
              <button
                type="button"
                onClick={copyPw}
                style={{
                  background: NAVY,
                  color: "#fff",
                  border: 0,
                  padding: "6px 12px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: FONT,
                }}
              >
                {copied ? T.copied : T.copy}
              </button>
            </div>
            <div
              style={{
                marginTop: 10,
                fontSize: 12,
                color: INK_MUTE,
                lineHeight: 1.55,
              }}
            >
              {T.successHint}
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 11,
                color: INK_LIGHT,
                lineHeight: 1.55,
              }}
            >
              {T.shareHelp}
            </div>
            <div
              style={{
                marginTop: 16,
                display: "flex",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                onClick={onSaved}
                style={{
                  background: TEAL,
                  color: "#fff",
                  border: 0,
                  padding: "8px 14px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: FONT,
                }}
              >
                {T.close}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              <Field label={T.firstName}>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  disabled={busy}
                  style={inputStyle}
                />
              </Field>
              <Field label={T.lastName}>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  disabled={busy}
                  style={inputStyle}
                />
              </Field>
            </div>
            <Field label={T.email}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                style={inputStyle}
              />
            </Field>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              <Field label={T.role}>
                <select
                  value={role}
                  onChange={(e) =>
                    setRole(e.target.value as "technician" | "admin")
                  }
                  disabled={busy}
                  style={inputStyle}
                >
                  <option value="technician">{T.roleTech}</option>
                  <option value="admin">{T.roleAdmin}</option>
                </select>
              </Field>
              <Field label={T.hireDate}>
                <input
                  type="date"
                  value={hireDate}
                  onChange={(e) => setHireDate(e.target.value)}
                  disabled={busy}
                  style={inputStyle}
                />
              </Field>
            </div>

            {/* [Model A — Step 6] Home branch is required on Add Employee. */}
            <div style={{ marginTop: 12 }}>
              <Field label={T.homeBranch}>
                <select
                  value={homeBranchId}
                  onChange={(e) => setHomeBranchId(e.target.value === "" ? "" : Number(e.target.value))}
                  disabled={busy || branchOptions.length === 0}
                  style={inputStyle}
                  required
                >
                  {branchOptions.length === 0 && <option value="">…</option>}
                  {branchOptions.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
                <div style={{ fontSize: 11, color: INK_LIGHT, marginTop: 4, lineHeight: 1.4 }}>
                  {T.homeBranchHint}
                </div>
              </Field>
            </div>

            {err && (
              <div
                style={{
                  background: "#FEF2F2",
                  border: `1px solid #FECACA`,
                  color: DANGER,
                  padding: "8px 10px",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {err}
              </div>
            )}

            <div
              style={{
                marginTop: 6,
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
              }}
            >
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
                {T.cancel}
              </button>
              <button
                type="button"
                onClick={onSubmit}
                disabled={!valid || busy}
                style={{
                  background: !valid || busy ? "#CBD5E1" : TEAL,
                  color: "#fff",
                  border: 0,
                  padding: "8px 14px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: !valid || busy ? "not-allowed" : "pointer",
                  fontFamily: FONT,
                }}
              >
                {busy ? T.submitting : T.submit}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EditEmployeeDialog (sprint 2026-05-15)
//
// PATCH /api/users/:id/lms-edit. Editable: name, email, role, hire date.
// Read-only: user id, created date, last activity (passed through from the
// roster row). Save disabled until at least one field actually changes.
// EN/ES copy throughout.
// ─────────────────────────────────────────────────────────────────────────────
function EditEmployeeDialog({
  row,
  token,
  onClose,
  onSaved,
}: {
  row: RosterRow;
  token: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Seed the form from the roster row. We don't have email / hire_date
  // on RosterRow — fetch them lazily from GET /api/users/:id (which is
  // tenant-scoped on the backend, so admins of one tenant can't read
  // another tenant's user).
  const [loading, setLoading] = useState(true);
  const [initial, setInitial] = useState<{
    first_name: string;
    last_name: string;
    email: string;
    role: string;
    hire_date: string;
    id: number;
    created_at: string | null;
  } | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("technician");
  const [hireDate, setHireDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [lang, setLang] = useState<"en" | "es">("en");

  const T = lang === "es"
    ? {
        title: "Editar empleado",
        subtitle:
          "Actualiza el nombre, correo, rol o fecha de contratación. Los cambios se registran en el log de auditoría.",
        firstName: "Nombre",
        lastName: "Apellido",
        email: "Correo electrónico",
        role: "Rol",
        roleTech: "Técnico",
        roleLead: "Líder de equipo",
        roleAdmin: "Administrador de grupo",
        roleOffice: "Oficina",
        hireDate: "Fecha de contratación",
        userId: "ID de usuario",
        createdAt: "Cuenta creada",
        lastActivity: "Última actividad en el LMS",
        cancel: "Cancelar",
        submit: "Guardar cambios",
        submitting: "Guardando…",
        saved: "Cambios guardados.",
        notice:
          "Cambios al correo notificarán al nuevo correo. Cambios al rol se registran como evento de seguridad.",
        loading: "Cargando…",
      }
    : {
        title: "Edit Employee",
        subtitle:
          "Update name, email, role, or hire date. All changes write to the audit log.",
        firstName: "First name",
        lastName: "Last name",
        email: "Email",
        role: "Role",
        roleTech: "Technician",
        roleLead: "Team lead",
        roleAdmin: "Group Administrator",
        roleOffice: "Office",
        hireDate: "Hire date",
        userId: "User ID",
        createdAt: "Account created",
        lastActivity: "Last LMS activity",
        cancel: "Cancel",
        submit: "Save changes",
        submitting: "Saving…",
        saved: "Changes saved.",
        notice:
          "Email changes send a heads-up to the new address. Role changes are logged as a security event.",
        loading: "Loading…",
      };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/users/${row.user_id}`, {
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (cancelled) return;
        const seed = {
          first_name: data.first_name ?? "",
          last_name: data.last_name ?? "",
          email: data.email ?? "",
          role: data.role ?? "technician",
          hire_date: data.hire_date ?? "",
          id: data.id,
          created_at: data.created_at ?? null,
        };
        setInitial(seed);
        setFirstName(seed.first_name);
        setLastName(seed.last_name);
        setEmail(seed.email);
        setRole(seed.role);
        setHireDate(seed.hire_date || "");
      } catch (e) {
        if (!cancelled) setErr(String((e as Error).message));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.user_id, token]);

  const dirty =
    initial != null &&
    (firstName.trim() !== initial.first_name ||
      lastName.trim() !== initial.last_name ||
      email.trim().toLowerCase() !== initial.email.toLowerCase() ||
      role !== initial.role ||
      (hireDate || "") !== (initial.hire_date || ""));

  const valid =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    (hireDate === "" || /^\d{4}-\d{2}-\d{2}$/.test(hireDate));

  async function onSubmit() {
    if (!dirty || !valid || busy || !initial) return;
    setBusy(true);
    setErr(null);
    try {
      const patch: Record<string, unknown> = {};
      if (firstName.trim() !== initial.first_name) {
        patch.first_name = firstName.trim();
      }
      if (lastName.trim() !== initial.last_name) {
        patch.last_name = lastName.trim();
      }
      if (email.trim().toLowerCase() !== initial.email.toLowerCase()) {
        patch.email = email.trim().toLowerCase();
      }
      if (role !== initial.role) patch.role = role;
      if ((hireDate || "") !== (initial.hire_date || "")) {
        patch.hire_date = hireDate || null;
      }

      const res = await fetch(`${API_BASE}/users/${row.user_id}/lms-edit`, {
        method: "PATCH",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        try {
          const parsed = JSON.parse(text);
          throw new Error(parsed.message || parsed.error || `HTTP ${res.status}`);
        } catch {
          throw new Error(text || `HTTP ${res.status}`);
        }
      }
      setSavedAt(Date.now());
      setTimeout(() => onSaved(), 700);
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
          maxHeight: "90vh",
          overflow: "auto",
          fontFamily: FONT,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 8,
          }}
        >
          <div style={{ fontWeight: 800, fontSize: 18, color: INK }}>
            {T.title}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <LangChip lang={lang} setLang={setLang} />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                background: "transparent",
                border: 0,
                cursor: "pointer",
                color: INK_MUTE,
              }}
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <div style={{ fontSize: 13, color: INK_MUTE, marginTop: 4 }}>
          {T.subtitle}
        </div>

        {loading ? (
          <div
            style={{
              padding: 30,
              textAlign: "center",
              color: INK_MUTE,
            }}
          >
            <Loader2 size={20} className="qleno-admin-spin" />
            <div style={{ marginTop: 8, fontSize: 12 }}>{T.loading}</div>
          </div>
        ) : initial ? (
          <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              <Field label={T.firstName}>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  disabled={busy}
                  style={inputStyle}
                />
              </Field>
              <Field label={T.lastName}>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  disabled={busy}
                  style={inputStyle}
                />
              </Field>
            </div>
            <Field label={T.email}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                style={inputStyle}
              />
            </Field>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              <Field label={T.role}>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  disabled={busy}
                  style={inputStyle}
                >
                  <option value="technician">{T.roleTech}</option>
                  <option value="team_lead">{T.roleLead}</option>
                  <option value="admin">{T.roleAdmin}</option>
                  <option value="office">{T.roleOffice}</option>
                </select>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11.5,
                    color: "#5b5851",
                    lineHeight: 1.4,
                  }}
                >
                  {lang === "es"
                    ? "Administrador y Oficina pueden ver el panel /lms/admin. Técnico y Líder de equipo solo ven su propio entrenamiento."
                    : "Admin and Office can see the /lms/admin dashboard. Technician and Team Lead see only their own training."}
                </div>
              </Field>
              <Field label={T.hireDate}>
                <input
                  type="date"
                  value={hireDate}
                  onChange={(e) => setHireDate(e.target.value)}
                  disabled={busy}
                  style={inputStyle}
                />
              </Field>
            </div>

            <div
              style={{
                marginTop: 4,
                padding: "10px 12px",
                background: "#F8FAFC",
                border: `1px solid ${LINE}`,
                borderRadius: 8,
                fontSize: 12,
                color: INK_MUTE,
                display: "grid",
                gap: 4,
              }}
            >
              <div>
                <span style={{ fontWeight: 700, color: INK_MUTE }}>
                  {T.userId}:
                </span>{" "}
                {initial.id}
              </div>
              {initial.created_at ? (
                <div>
                  <span style={{ fontWeight: 700, color: INK_MUTE }}>
                    {T.createdAt}:
                  </span>{" "}
                  {humanDateTime(initial.created_at)}
                </div>
              ) : null}
              <div>
                <span style={{ fontWeight: 700, color: INK_MUTE }}>
                  {T.lastActivity}:
                </span>{" "}
                {humanDateTime(row.last_activity_at)}
              </div>
            </div>

            <div
              style={{
                fontSize: 11,
                color: INK_LIGHT,
                lineHeight: 1.55,
              }}
            >
              {T.notice}
            </div>

            {err && (
              <div
                style={{
                  background: "#FEF2F2",
                  border: `1px solid #FECACA`,
                  color: DANGER,
                  padding: "8px 10px",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {err}
              </div>
            )}
            {savedAt && !err && (
              <div
                style={{
                  background: "#ECFDF5",
                  border: `1px solid ${SUCCESS}`,
                  color: SUCCESS,
                  padding: "8px 10px",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {T.saved}
              </div>
            )}

            <div
              style={{
                marginTop: 6,
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
              }}
            >
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
                {T.cancel}
              </button>
              <button
                type="button"
                onClick={onSubmit}
                disabled={!dirty || !valid || busy}
                style={{
                  background: !dirty || !valid || busy ? "#CBD5E1" : NAVY,
                  color: "#fff",
                  border: 0,
                  padding: "8px 14px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: !dirty || !valid || busy ? "not-allowed" : "pointer",
                  fontFamily: FONT,
                }}
              >
                {busy ? T.submitting : T.submit}
              </button>
            </div>
          </div>
        ) : (
          <div
            style={{
              marginTop: 14,
              background: "#FEF2F2",
              border: `1px solid #FECACA`,
              color: DANGER,
              padding: 12,
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            {err || "Failed to load employee."}
          </div>
        )}
      </div>
    </div>
  );
}

// Shared field wrapper for AddEmployee / EditEmployee dialogs.
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block" }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: INK_MUTE,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 10px",
  border: `1px solid ${LINE}`,
  borderRadius: 6,
  fontSize: 14,
  fontFamily: FONT,
  color: INK,
  background: "#fff",
  boxSizing: "border-box",
};

// Compact EN/ES toggle reused by Add/Edit dialogs.
function LangChip({
  lang,
  setLang,
}: {
  lang: "en" | "es";
  setLang: (l: "en" | "es") => void;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        border: `1px solid ${LINE}`,
        borderRadius: 999,
        overflow: "hidden",
        fontFamily: FONT,
      }}
    >
      {(["en", "es"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => setLang(v)}
          aria-pressed={lang === v}
          style={{
            background: lang === v ? NAVY : "transparent",
            color: lang === v ? "#fff" : INK_MUTE,
            border: 0,
            padding: "3px 10px",
            fontSize: 11,
            fontWeight: 700,
            cursor: "pointer",
            fontFamily: FONT,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

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
  // Item 1b: owners excluded from default selection. Helper text
  // already said this; selection state was contradicting it. Now the
  // checkbox state matches the helper.
  const nonOwnerIds = useMemo(
    () =>
      new Set(rows.filter((r) => r.role !== "owner").map((r) => r.user_id)),
    [rows],
  );
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(nonOwnerIds),
  );
  // Item 1a: random per-dialog default. Regenerated on every mount.
  const [newPassword, setNewPassword] = useState<string>(() =>
    generateBulkResetPassword(),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [doneCount, setDoneCount] = useState<number | null>(null);
  // Item 1c: type-to-confirm guard. The owner must type the count of
  // selected users (matches the Reset Enrollment dialog pattern).
  const [confirm, setConfirm] = useState<string>("");

  const expectedConfirm = String(selected.size);
  const confirmOk = confirm.trim() === expectedConfirm && selected.size > 0;
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
                A random suggested password is regenerated each time you open this dialog. Replace it with something you'll remember to share with the affected users. Change for any single user later via the per-user reset.
              </div>
              <button
                type="button"
                onClick={() => setNewPassword(generateBulkResetPassword())}
                disabled={busy}
                style={{
                  marginTop: 6,
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
                Generate new
              </button>
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

            {/* Item 1c: type-to-confirm gate. Owner must type the count
                of selected users (matches the Reset Enrollment dialog's
                "Type RESET" pattern). */}
            <div style={{ marginTop: 14 }}>
              <label
                style={{
                  display: "block",
                  fontSize: 12,
                  fontWeight: 700,
                  color: INK_MUTE,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                Type {expectedConfirm} to confirm
              </label>
              <input
                type="text"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={busy}
                placeholder={expectedConfirm}
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
              <div style={{ fontSize: 11, color: INK_LIGHT, marginTop: 4 }}>
                This number matches the count of selected users above.
              </div>
            </div>

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
                disabled={
                  busy ||
                  selected.size === 0 ||
                  newPassword.length < 6 ||
                  !confirmOk
                }
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
                  opacity:
                    busy ||
                    selected.size === 0 ||
                    newPassword.length < 6 ||
                    !confirmOk
                      ? 0.6
                      : 1,
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
  const [drillUserId, setDrillUserId] = useState<number | null>(null);

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
                        onClick={() => setDrillUserId(r.user_id)}
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {drillUserId !== null && (
        <AuditLearnerDrawer
          token={token}
          userId={drillUserId}
          onClose={() => setDrillUserId(null)}
        />
      )}
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
  // Item 13a (P1 sprint 2026-05-14): the audit dashboard MODULES /
  // FINAL columns truncated to "FINAI" on narrow desktops because
  // there was no min-width and the text-transform widened the
  // letters. Force whole-word display + a sane minimum width.
  whiteSpace: "nowrap",
  minWidth: 80,
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
  onClick,
}: {
  row: AuditRosterRow;
  totalModules: number;
  totalDocs: number;
  onClick: () => void;
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
    <tr
      onClick={onClick}
      style={{ cursor: "pointer" }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLTableRowElement).style.background = LINE_SOFT;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLTableRowElement).style.background = "transparent";
      }}
    >
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

// ─────────────────────────────────────────────────────────────────────────────
// AuditLearnerDrawer — drill-down to a single employee's full audit chain.
//
// Fetches GET /api/lms/admin-audit/learner/:userId on mount and renders
// enrollment, module progress, signed documents (active + superseded),
// completion certificates, and pending re-acks. The compliance summary
// from the same endpoint is shown at the top so the operator can read
// the overall posture without scrolling.
// ─────────────────────────────────────────────────────────────────────────────

type AuditLearnerDetail = {
  user: {
    id: number;
    full_name: string;
    email: string;
    role: string;
    hire_date: string | null;
    termination_date: string | null;
  };
  enrollment: {
    id: number;
    status: string;
    enrolled_at: string;
    deadline_at: string | null;
    completed_at: string | null;
    last_activity_at: string | null;
  } | null;
  module_progress: Array<{
    module_id: string;
    status: string;
    best_score: number;
    attempts: number;
    passed_at: string | null;
  }>;
  signed_documents: Array<{
    id: number;
    document_type: string;
    locale: string;
    signed_at: string;
    status: "active" | "superseded" | "revoked";
    version_hash: string;
    employee_signature_method: "drawn" | "typed";
  }>;
  certificates: Array<{
    id: number;
    module_id: string;
    score: number | null;
    passed: boolean;
    locale: string;
    issued_at: string;
    revoked_at: string | null;
  }>;
  pending_re_acks: Array<{
    id: number;
    document_type: string;
    trigger_reason: string;
    triggered_at: string;
    acknowledged_at: string | null;
    defer_until: string | null;
  }>;
  compliance: AuditCompliance;
};

function AuditLearnerDrawer({
  token,
  userId,
  onClose,
}: {
  token: string | null;
  userId: number;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<AuditLearnerDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setErr(null);
    (async () => {
      try {
        const data = await api<AuditLearnerDetail>(
          "GET",
          `/lms/admin-audit/learner/${userId}`,
          token,
        );
        if (!cancelled) setDetail(data);
      } catch (e) {
        if (!cancelled) setErr(String((e as Error).message));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, userId]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Learner audit detail"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.7)",
        display: "grid",
        placeItems: "center",
        zIndex: 110,
        padding: 16,
      }}
    >
      <div
        style={{
          background: SURFACE,
          borderRadius: RADIUS,
          maxWidth: 760,
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
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 17, fontWeight: 800 }}>
            {detail?.user.full_name ?? "Loading…"}
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
            }}
          >
            {err}
          </div>
        )}

        {detail === null && !err ? (
          <div style={{ padding: 40, textAlign: "center", color: INK_MUTE }}>
            <Loader2 size={18} className="qleno-admin-spin" />
          </div>
        ) : detail ? (
          <>
            <div style={{ fontSize: 12, color: INK_MUTE, marginBottom: 14 }}>
              {detail.user.email} · {detail.user.role}
              {detail.user.hire_date ? ` · hired ${detail.user.hire_date}` : ""}
              {detail.user.termination_date
                ? ` · terminated ${detail.user.termination_date}`
                : ""}
            </div>

            <ComplianceSummary compliance={detail.compliance} />

            <DrawerSection title="Enrollment">
              {detail.enrollment ? (
                <div style={{ fontSize: 12.5 }}>
                  <DrawerLine
                    label="Status"
                    value={detail.enrollment.status}
                  />
                  <DrawerLine
                    label="Enrolled"
                    value={humanDateTime(detail.enrollment.enrolled_at)}
                  />
                  <DrawerLine
                    label="Deadline"
                    value={
                      detail.enrollment.deadline_at
                        ? humanDateTime(detail.enrollment.deadline_at)
                        : "—"
                    }
                  />
                  <DrawerLine
                    label="Completed"
                    value={
                      detail.enrollment.completed_at
                        ? humanDateTime(detail.enrollment.completed_at)
                        : "—"
                    }
                  />
                  <DrawerLine
                    label="Last activity"
                    value={
                      detail.enrollment.last_activity_at
                        ? humanDateTime(detail.enrollment.last_activity_at)
                        : "—"
                    }
                  />
                </div>
              ) : (
                <DrawerEmpty>No enrollment row.</DrawerEmpty>
              )}
            </DrawerSection>

            <DrawerSection
              title={`Module progress (${detail.module_progress.length})`}
            >
              {detail.module_progress.length === 0 ? (
                <DrawerEmpty>No module progress yet.</DrawerEmpty>
              ) : (
                <table style={DrawerTable}>
                  <thead>
                    <tr style={{ background: LINE_SOFT }}>
                      <th style={DrawerTh}>Module</th>
                      <th style={DrawerTh}>Status</th>
                      <th style={DrawerTh}>Best</th>
                      <th style={DrawerTh}>Attempts</th>
                      <th style={DrawerTh}>Passed at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.module_progress.map((p) => (
                      <tr key={p.module_id}>
                        <td style={DrawerTd}>{p.module_id}</td>
                        <td style={DrawerTd}>{p.status}</td>
                        <td style={DrawerTd}>{p.best_score}</td>
                        <td style={DrawerTd}>{p.attempts}</td>
                        <td style={DrawerTd}>
                          {p.passed_at ? humanDateTime(p.passed_at) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </DrawerSection>

            <DrawerSection
              title={`Signed documents (${detail.signed_documents.length})`}
            >
              {detail.signed_documents.length === 0 ? (
                <DrawerEmpty>No signed documents.</DrawerEmpty>
              ) : (
                <table style={DrawerTable}>
                  <thead>
                    <tr style={{ background: LINE_SOFT }}>
                      <th style={DrawerTh}>Type</th>
                      <th style={DrawerTh}>Signed</th>
                      <th style={DrawerTh}>Locale</th>
                      <th style={DrawerTh}>Method</th>
                      <th style={DrawerTh}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.signed_documents.map((d) => (
                      <tr key={d.id}>
                        <td style={DrawerTd}>{d.document_type}</td>
                        <td style={DrawerTd}>{humanDateTime(d.signed_at)}</td>
                        <td style={DrawerTd}>{d.locale}</td>
                        <td style={DrawerTd}>{d.employee_signature_method}</td>
                        <td style={DrawerTd}>
                          <DrawerStatusPill status={d.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </DrawerSection>

            <DrawerSection
              title={`Certificates (${detail.certificates.length})`}
            >
              {detail.certificates.length === 0 ? (
                <DrawerEmpty>No certificates issued.</DrawerEmpty>
              ) : (
                <table style={DrawerTable}>
                  <thead>
                    <tr style={{ background: LINE_SOFT }}>
                      <th style={DrawerTh}>Module</th>
                      <th style={DrawerTh}>Score</th>
                      <th style={DrawerTh}>Issued</th>
                      <th style={DrawerTh}>Locale</th>
                      <th style={DrawerTh}>Revoked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.certificates.map((c) => (
                      <tr key={c.id}>
                        <td style={DrawerTd}>{c.module_id}</td>
                        <td style={DrawerTd}>{c.score ?? "—"}</td>
                        <td style={DrawerTd}>{humanDateTime(c.issued_at)}</td>
                        <td style={DrawerTd}>{c.locale}</td>
                        <td style={DrawerTd}>
                          {c.revoked_at
                            ? humanDateTime(c.revoked_at)
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </DrawerSection>

            <DrawerSection
              title={`Pending re-acknowledgments (${detail.pending_re_acks.length})`}
            >
              {detail.pending_re_acks.length === 0 ? (
                <DrawerEmpty>No pending re-acks (clean).</DrawerEmpty>
              ) : (
                <table style={DrawerTable}>
                  <thead>
                    <tr style={{ background: LINE_SOFT }}>
                      <th style={DrawerTh}>Type</th>
                      <th style={DrawerTh}>Reason</th>
                      <th style={DrawerTh}>Triggered</th>
                      <th style={DrawerTh}>Acknowledged</th>
                      <th style={DrawerTh}>Defer until</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.pending_re_acks.map((p) => (
                      <tr key={p.id}>
                        <td style={DrawerTd}>{p.document_type}</td>
                        <td style={DrawerTd}>{p.trigger_reason}</td>
                        <td style={DrawerTd}>
                          {humanDateTime(p.triggered_at)}
                        </td>
                        <td style={DrawerTd}>
                          {p.acknowledged_at
                            ? humanDateTime(p.acknowledged_at)
                            : "—"}
                        </td>
                        <td style={DrawerTd}>
                          {p.defer_until ? humanDateTime(p.defer_until) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </DrawerSection>
          </>
        ) : null}
      </div>
    </div>
  );
}

const DrawerTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 11.5,
  fontFamily: FONT,
};
const DrawerTh: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 10px",
  fontSize: 10,
  fontWeight: 800,
  color: INK_MUTE,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  borderBottom: `1px solid ${LINE}`,
};
const DrawerTd: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 11.5,
  color: INK,
  borderBottom: `1px solid ${LINE_SOFT}`,
  verticalAlign: "top",
};

function DrawerSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: INK_MUTE,
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      <div
        style={{
          border: `1px solid ${LINE}`,
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function DrawerLine({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px 1fr",
        padding: "6px 10px",
        borderBottom: `1px solid ${LINE_SOFT}`,
        fontSize: 12,
      }}
    >
      <span style={{ color: INK_LIGHT }}>{label}</span>
      <span style={{ color: INK }}>{value}</span>
    </div>
  );
}

function DrawerEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        fontSize: 12,
        color: INK_LIGHT,
        fontStyle: "italic",
      }}
    >
      {children}
    </div>
  );
}

function DrawerStatusPill({
  status,
}: {
  status: "active" | "superseded" | "revoked";
}) {
  const color =
    status === "active" ? SUCCESS : status === "revoked" ? DANGER : INK_MUTE;
  return (
    <span
      style={{
        background: color + "20",
        color,
        padding: "2px 6px",
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {status}
    </span>
  );
}

function ComplianceSummary({ compliance }: { compliance: AuditCompliance }) {
  const overallColor =
    compliance.overall === "complete"
      ? SUCCESS
      : compliance.overall === "needs_resign"
      ? WARN
      : compliance.overall === "overdue"
      ? DANGER
      : TEAL;
  const overallLabel =
    compliance.overall === "complete"
      ? "Complete"
      : compliance.overall === "needs_resign"
      ? "Needs re-sign"
      : compliance.overall === "overdue"
      ? "Overdue"
      : "In progress";
  return (
    <div
      style={{
        background: overallColor + "10",
        border: `1px solid ${overallColor}40`,
        borderLeft: `4px solid ${overallColor}`,
        borderRadius: 8,
        padding: "10px 14px",
        display: "flex",
        flexWrap: "wrap",
        gap: 14,
        alignItems: "center",
      }}
    >
      <span
        style={{
          background: overallColor,
          color: "#fff",
          padding: "3px 10px",
          borderRadius: 999,
          fontSize: 10.5,
          fontWeight: 800,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
      >
        {overallLabel}
      </span>
      <ComplianceFlag label="Modules" ok={compliance.modules_complete} />
      <ComplianceFlag label="Docs" ok={compliance.docs_complete} />
      <ComplianceFlag label="Final" ok={compliance.final_passed} />
      <ComplianceFlag label="Handbook" ok={compliance.handbook_signed} />
      <span style={{ fontSize: 11.5, color: INK_MUTE }}>
        Pending:{" "}
        <strong style={{ color: compliance.pending_count > 0 ? WARN : INK }}>
          {compliance.pending_count}
        </strong>
      </span>
    </div>
  );
}

function ComplianceFlag({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        gap: 4,
        alignItems: "center",
        fontSize: 11.5,
        color: ok ? SUCCESS : INK_LIGHT,
      }}
    >
      {ok ? <CircleCheck size={14} /> : <X size={14} />}
      <strong style={{ color: INK }}>{label}</strong>
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

// ─────────────────────────────────────────────────────────────────────────────
// LearnerOnboardingIntakePanel — Phase 10 PR #11
// ─────────────────────────────────────────────────────────────────────────────
//
// Read-only display of a learner's onboarding intake (operational
// fields only — Phes does not store SSN, W-4, I-9, or direct deposit
// here; those live with ADP). Renders the submitted / draft / not-
// started state, then expands into a compact field grid.

type IntakeRow = {
  id: number;
  preferred_name: string | null;
  pronouns: string | null;
  personal_email: string | null;
  personal_cell_phone: string | null;
  home_address_street: string | null;
  home_address_unit: string | null;
  home_address_city: string | null;
  home_address_state: string | null;
  home_address_zip: string | null;
  emergency_contact_name: string | null;
  emergency_contact_relationship: string | null;
  emergency_contact_phone: string | null;
  languages_spoken: string | null;
  shirt_size: string | null;
  apron_size: string | null;
  drives_personal_vehicle: boolean;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_year: number | null;
  vehicle_color: string | null;
  vehicle_license_plate: string | null;
  vehicle_insurance_company: string | null;
  vehicle_insurance_policy_number: string | null;
  vehicle_insurance_expires_at: string | null;
  drivers_license_number: string | null;
  drivers_license_state: string | null;
  drivers_license_expires_at: string | null;
  vehicle_protocol_acknowledged: boolean;
  vehicle_protocol_acknowledged_at: string | null;
  notes: string | null;
  submitted_at: string | null;
  updated_at: string;
};

/**
 * Returns "expired" / "expiring" / "ok" for a YYYY-MM-DD expiration
 * date string. Used by the admin panel to surface insurance + DL
 * expiration warnings.
 */
function expirationStatus(
  dateStr: string | null,
  warningDays: number = 30,
): "expired" | "expiring" | "ok" | "missing" {
  if (!dateStr) return "missing";
  const parsed = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "missing";
  const now = new Date();
  const msPerDay = 1000 * 60 * 60 * 24;
  const days = Math.floor((parsed.getTime() - now.getTime()) / msPerDay);
  if (days < 0) return "expired";
  if (days <= warningDays) return "expiring";
  return "ok";
}

function LearnerOnboardingIntakePanel({ row }: { row: RosterRow }) {
  const token = useAuthStore((s) => s.token);
  const [intake, setIntake] = useState<IntakeRow | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<IntakeRow | null>(
          "GET",
          `/lms/onboarding-intake/admin/learner/${row.user_id}`,
          token,
        );
        if (!cancelled) setIntake(data ?? null);
      } catch (e) {
        if (!cancelled) setErr(String((e as Error).message));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.user_id, token]);

  async function handleExport() {
    try {
      const url = `${API_BASE}/lms/onboarding-intake/admin/export`;
      const res = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `phes-onboarding-intake-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      console.error("[lms-admin] intake CSV export failed:", e);
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
        Failed to load onboarding intake: {err}
      </div>
    );
  }
  if (intake === undefined) {
    return (
      <div
        style={{
          marginTop: 12,
          fontSize: 12,
          color: INK_MUTE,
          fontStyle: "italic",
        }}
      >
        Loading onboarding intake...
      </div>
    );
  }

  const status: "not-started" | "draft" | "submitted" =
    intake == null
      ? "not-started"
      : intake.submitted_at != null
      ? "submitted"
      : "draft";

  const tone =
    status === "submitted" ? SUCCESS : status === "draft" ? "#BA7517" : INK_LIGHT;
  const statusLabel =
    status === "submitted"
      ? "Submitted"
      : status === "draft"
      ? "Draft"
      : "Not started";

  return (
    <div style={{ marginTop: 14 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            color: INK_MUTE,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <FileSignature size={12} /> Onboarding Intake
        </div>
        <button
          type="button"
          onClick={handleExport}
          title="Export tenant onboarding intake CSV"
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
          <Download size={11} /> Export CSV
        </button>
      </div>

      <div
        style={{
          background: SURFACE,
          border: `1px solid ${LINE}`,
          borderLeft: `3px solid ${tone}`,
          borderRadius: 8,
          padding: "10px 12px",
          fontSize: 12,
        }}
      >
        <div style={{ fontWeight: 800, color: INK, marginBottom: 6 }}>
          Status: {statusLabel}
          {intake?.submitted_at ? (
            <span style={{ color: INK_MUTE, fontWeight: 600, marginLeft: 6 }}>
              · Submitted {humanDateTime(intake.submitted_at)}
            </span>
          ) : null}
        </div>

        {intake ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 8,
            }}
          >
            <IntakeField label="Preferred name" value={intake.preferred_name} />
            <IntakeField label="Pronouns" value={intake.pronouns} />
            <IntakeField label="Personal email" value={intake.personal_email} />
            <IntakeField label="Personal cell" value={intake.personal_cell_phone} />
            <div style={{ gridColumn: "1 / -1" }}>
              <IntakeAddressField intake={intake} />
            </div>
            <IntakeField label="Emergency name" value={intake.emergency_contact_name} />
            <IntakeField
              label="Emergency relationship"
              value={intake.emergency_contact_relationship}
            />
            <IntakeField label="Emergency phone" value={intake.emergency_contact_phone} />
            <IntakeField label="Languages" value={intake.languages_spoken} />
            <IntakeField label="Shirt size" value={intake.shirt_size} />
            <IntakeField label="Apron size" value={intake.apron_size} />
            <IntakeField
              label="Drives personal vehicle"
              value={intake.drives_personal_vehicle ? "Yes" : "No"}
            />
            {intake.drives_personal_vehicle ? (
              <>
                <IntakeField label="Vehicle make" value={intake.vehicle_make} />
                <IntakeField label="Vehicle model" value={intake.vehicle_model} />
                <IntakeField
                  label="Vehicle year"
                  value={
                    intake.vehicle_year != null ? String(intake.vehicle_year) : null
                  }
                />
                <IntakeField label="Vehicle color" value={intake.vehicle_color} />
                <IntakeField
                  label="License plate"
                  value={intake.vehicle_license_plate}
                />
                <IntakeField
                  label="Insurance company"
                  value={intake.vehicle_insurance_company}
                />
                <IntakeField
                  label="Insurance policy #"
                  value={intake.vehicle_insurance_policy_number}
                />
                <IntakeExpiryField
                  label="Insurance expires"
                  value={intake.vehicle_insurance_expires_at}
                />
                <IntakeField
                  label="Driver's license #"
                  value={intake.drivers_license_number}
                />
                <IntakeField
                  label="DL state"
                  value={intake.drivers_license_state}
                />
                <IntakeExpiryField
                  label="DL expires"
                  value={intake.drivers_license_expires_at}
                />
                <IntakeField
                  label="Vehicle protocol acknowledged"
                  value={
                    intake.vehicle_protocol_acknowledged
                      ? intake.vehicle_protocol_acknowledged_at
                        ? `Yes (${humanDateTime(intake.vehicle_protocol_acknowledged_at)})`
                        : "Yes"
                      : "No"
                  }
                />
              </>
            ) : null}
            {intake.notes ? (
              <div style={{ gridColumn: "1 / -1" }}>
                <IntakeField label="Notes" value={intake.notes} />
              </div>
            ) : null}
          </div>
        ) : (
          <div style={{ color: INK_MUTE, fontSize: 12 }}>
            Learner has not started the intake yet.
          </div>
        )}
      </div>
    </div>
  );
}

function IntakeField({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: INK_MUTE,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 12, color: INK, marginTop: 2 }}>
        {value && value.toString().trim().length > 0 ? value : "(none)"}
      </div>
    </div>
  );
}

/**
 * Renders the learner's home address as a one-line summary with a
 * Google Maps deep-link. Falls back to the labelled "(none)"
 * placeholder when the address fields are empty.
 */
function IntakeAddressField({ intake }: { intake: IntakeRow }) {
  const parts = [
    intake.home_address_street,
    intake.home_address_unit ? `Unit ${intake.home_address_unit}` : null,
    intake.home_address_city,
    intake.home_address_state,
    intake.home_address_zip,
  ].filter((s) => s && s.toString().trim().length > 0);
  const full = parts.join(", ");
  const mapsUrl = full
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(full)}`
    : null;
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: INK_MUTE,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        Home address
      </div>
      <div style={{ fontSize: 12, color: INK, marginTop: 2 }}>
        {full ? (
          mapsUrl ? (
            <a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: NAVY, textDecoration: "underline" }}
            >
              {full}
            </a>
          ) : (
            full
          )
        ) : (
          "(none)"
        )}
      </div>
    </div>
  );
}

/**
 * Renders an expiration date with an inline warning pill when the
 * date is within 30 days of expiring or already past. Used for
 * insurance + DL expiration in the admin panel.
 */
function IntakeExpiryField({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  const status = expirationStatus(value ?? null);
  const pillBg =
    status === "expired"
      ? "#FEE2E2"
      : status === "expiring"
      ? "#FEF3C7"
      : null;
  const pillColor =
    status === "expired" ? DANGER : status === "expiring" ? "#92400E" : INK;
  const pillText =
    status === "expired"
      ? "Expired"
      : status === "expiring"
      ? "Expiring within 30 days"
      : null;
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: INK_MUTE,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 12,
          color: INK,
          marginTop: 2,
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        {value && value.toString().trim().length > 0 ? value : "(none)"}
        {pillText ? (
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              padding: "2px 6px",
              borderRadius: 4,
              background: pillBg ?? "transparent",
              color: pillColor,
            }}
          >
            {pillText}
          </span>
        ) : null}
      </div>
    </div>
  );
}
