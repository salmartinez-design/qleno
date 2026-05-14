/**
 * /lms/admin/employee/:userId — Employee Journey consolidated page.
 *
 * Single-pane-of-glass replacement for the multi-dialog flow on
 * /lms/admin. Pulls everything for one employee via the existing
 * /api/lms/admin-audit/learner/:userId endpoint and renders:
 *   - Header: name, email, role, enrollment status, deadline state,
 *     overall completion (X/13 + final + handbook)
 *   - Modules timeline
 *   - Signed documents
 *   - Certificates
 *   - Pending re-acknowledgments
 *   - Admin actions: Extend, Reset Module, Reset Deadline, Archive
 *
 * Owner + admin only (admin gets the same actions; archive is owner-
 * only). Mobile responsive (single-column under 768px). Bilingual
 * via a top-right locale toggle. No new schema.
 *
 * Linked from the existing roster row: clicking an employee name on
 * /lms/admin navigates here.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useAuthStore } from "@/lib/auth";
import {
  ChevronLeft,
  Loader2,
  X,
  CircleCheck,
  AlertTriangle,
  CalendarClock,
  Award,
  FileSignature,
  RotateCcw,
  Download,
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

const API_BASE =
  (import.meta.env.BASE_URL || "/").replace(/\/$/, "") + "/api";

type Locale = "en" | "es";

interface AuthPayload {
  role?: string;
}
function readRoleFromToken(token: string | null): AuthPayload | null {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    return JSON.parse(atob(parts[1])) as AuthPayload;
  } catch {
    return null;
  }
}

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

// Canonical module display titles (kept in sync with lms-admin.tsx).
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
function humanModule(id: string | null | undefined): string {
  if (!id) return "—";
  if (MODULE_DISPLAY_TITLES[id]) return MODULE_DISPLAY_TITLES[id];
  return id
    .split("-")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

function humanDocumentType(t: string): string {
  const map: Record<string, string> = {
    drug_alcohol: "Drug & Alcohol Policy",
    code_of_conduct: "Code of Conduct",
    video_photo_release: "Video & Photo Release",
    non_solicitation: "Non-Solicitation",
    social_media: "Social Media",
    supply_kit: "Supply Kit Responsibility",
    handbook: "Comprehensive Handbook",
  };
  return map[t] ?? t;
}

function humanDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

type AuditCompliance = {
  modules_complete: boolean;
  docs_complete: boolean;
  final_passed: boolean;
  handbook_signed: boolean;
  pending_count: number;
  overall: "complete" | "needs_resign" | "overdue" | "in_progress";
};

type LearnerDetail = {
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

const T = {
  back: { en: "Back to roster", es: "Volver al listado" },
  loading: { en: "Loading…", es: "Cargando…" },
  notFound: { en: "Employee not found", es: "Empleado no encontrado" },
  ownerOnly: {
    en: "Owner and admin access required.",
    es: "Se requiere acceso de propietario o administrador.",
  },
  status: { en: "Status", es: "Estado" },
  enrolled: { en: "Enrolled", es: "Inscrito" },
  deadline: { en: "Deadline", es: "Fecha límite" },
  lastActivity: { en: "Last activity", es: "Última actividad" },
  modulesTitle: { en: "Modules", es: "Módulos" },
  signedDocsTitle: { en: "Signed documents", es: "Documentos firmados" },
  certsTitle: { en: "Certificates", es: "Certificados" },
  pendingTitle: {
    en: "Pending re-acknowledgments",
    es: "Reconocimientos pendientes",
  },
  actionsTitle: { en: "Admin actions", es: "Acciones administrativas" },
  extendBtn: { en: "Extend deadline", es: "Extender fecha límite" },
  resetModuleBtn: { en: "Reset module", es: "Reiniciar módulo" },
  resetDeadlineBtn: { en: "Reset deadline", es: "Reiniciar fecha límite" },
  archiveBtn: { en: "Archive employee", es: "Archivar empleado" },
  notStarted: { en: "Not yet started", es: "Sin empezar" },
  overdue: { en: "Overdue", es: "Atrasado" },
  daysRemaining: { en: "days remaining", es: "días restantes" },
  dayRemaining: { en: "day remaining", es: "día restante" },
  noModules: {
    en: "No module progress yet.",
    es: "Sin progreso en módulos.",
  },
  noSignedDocs: {
    en: "No signed documents yet.",
    es: "Sin documentos firmados.",
  },
  noCerts: {
    en: "No certificates issued yet.",
    es: "Sin certificados emitidos.",
  },
  noPending: {
    en: "No pending re-acknowledgments. Clean.",
    es: "Sin reconocimientos pendientes. Limpio.",
  },
  passed: { en: "Passed", es: "Aprobado" },
  failed: { en: "Failed", es: "Reprobado" },
  inProgress: { en: "In progress", es: "En progreso" },
  attempts: { en: "attempts", es: "intentos" },
  download: { en: "Download", es: "Descargar" },
  saved: { en: "Saved.", es: "Guardado." },
  cancel: { en: "Cancel", es: "Cancelar" },
  confirm: { en: "Confirm", es: "Confirmar" },
};
function t(k: keyof typeof T, locale: Locale): string {
  return T[k][locale];
}

export default function LmsEmployeeJourneyPage() {
  const token = useAuthStore((s) => s.token);
  const auth = useMemo(() => readRoleFromToken(token), [token]);
  const isAuthorized = auth?.role === "owner" || auth?.role === "admin";
  const isOwner = auth?.role === "owner";
  const [, params] = useRoute<{ userId: string }>(
    "/lms/admin/employee/:userId",
  );
  const userId = Number(params?.userId);
  const [, setLocation] = useLocation();
  const [detail, setDetail] = useState<LearnerDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>("en");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | null
    | { kind: "extend" }
    | { kind: "reset-module" }
    | { kind: "reset-deadline" }
    | { kind: "archive" }
  >(null);

  const refresh = async () => {
    if (!isAuthorized || !Number.isFinite(userId)) return;
    try {
      const data = await api<LearnerDetail>(
        "GET",
        `/lms/admin-audit/learner/${userId}`,
        token,
      );
      setDetail(data);
      setErr(null);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthorized, userId, token]);

  if (!isAuthorized) {
    return (
      <Shell>
        <BackBar locale={locale} setLocale={setLocale} onBack={() => setLocation("/lms/admin")} />
        <Card>
          <X size={32} style={{ color: DANGER }} />
          <div style={{ fontSize: 16, fontWeight: 800, marginTop: 8 }}>
            {t("ownerOnly", locale)}
          </div>
        </Card>
      </Shell>
    );
  }

  if (!Number.isFinite(userId)) {
    return (
      <Shell>
        <BackBar locale={locale} setLocale={setLocale} onBack={() => setLocation("/lms/admin")} />
        <Card>
          <div style={{ fontSize: 14, color: INK_MUTE }}>Invalid user id.</div>
        </Card>
      </Shell>
    );
  }

  if (err) {
    return (
      <Shell>
        <BackBar locale={locale} setLocale={setLocale} onBack={() => setLocation("/lms/admin")} />
        <Card>
          <div style={{ color: DANGER, fontSize: 13 }}>{err}</div>
        </Card>
      </Shell>
    );
  }

  if (!detail) {
    return (
      <Shell>
        <BackBar locale={locale} setLocale={setLocale} onBack={() => setLocation("/lms/admin")} />
        <Card>
          <Loader2 size={20} className="qleno-journey-spin" />
          <div style={{ marginTop: 8, fontSize: 13, color: INK_MUTE }}>
            {t("loading", locale)}
          </div>
        </Card>
        <style>{`
          @keyframes qleno-journey-spin { to { transform: rotate(360deg); } }
          .qleno-journey-spin { animation: qleno-journey-spin 1s linear infinite; }
        `}</style>
      </Shell>
    );
  }

  const enrollment = detail.enrollment;
  const deadlineState = computeDeadlineState(enrollment, locale);

  return (
    <Shell>
      <BackBar locale={locale} setLocale={setLocale} onBack={() => setLocation("/lms/admin")} />

      <div style={{ maxWidth: 920, margin: "0 auto", padding: "0 16px 40px" }}>
        {/* Header */}
        <Card>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ fontSize: 22, fontWeight: 800, color: INK }}>
                {detail.user.full_name}
              </div>
              <div style={{ fontSize: 12.5, color: INK_MUTE, marginTop: 4 }}>
                {detail.user.email} · {detail.user.role}
                {detail.user.hire_date ? ` · hired ${detail.user.hire_date}` : ""}
              </div>
            </div>
            <ComplianceTotals
              compliance={detail.compliance}
              locale={locale}
            />
          </div>

          <div
            style={{
              marginTop: 14,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 10,
              borderTop: `1px solid ${LINE_SOFT}`,
              paddingTop: 12,
            }}
          >
            <Stat
              label={t("status", locale)}
              value={enrollment?.status ?? "—"}
            />
            <Stat
              label={t("enrolled", locale)}
              value={humanDateTime(enrollment?.enrolled_at)}
            />
            <Stat
              label={t("deadline", locale)}
              value={deadlineState}
            />
            <Stat
              label={t("lastActivity", locale)}
              value={humanDateTime(enrollment?.last_activity_at)}
            />
          </div>
        </Card>

        {/* Admin actions */}
        <SectionHeader title={t("actionsTitle", locale)} />
        <Card>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <ActionBtn
              label={t("extendBtn", locale)}
              onClick={() => setDialog({ kind: "extend" })}
            />
            <ActionBtn
              label={t("resetModuleBtn", locale)}
              onClick={() => setDialog({ kind: "reset-module" })}
            />
            <ActionBtn
              label={t("resetDeadlineBtn", locale)}
              onClick={() => setDialog({ kind: "reset-deadline" })}
            />
            {isOwner ? (
              <ActionBtn
                label={t("archiveBtn", locale)}
                onClick={() => setDialog({ kind: "archive" })}
                danger
              />
            ) : null}
          </div>
        </Card>

        {/* Modules timeline */}
        <SectionHeader title={t("modulesTitle", locale)} />
        <Card>
          {detail.module_progress.length === 0 ? (
            <Empty>{t("noModules", locale)}</Empty>
          ) : (
            <ModulesTimeline rows={detail.module_progress} locale={locale} />
          )}
        </Card>

        {/* Signed documents */}
        <SectionHeader title={t("signedDocsTitle", locale)} />
        <Card>
          {detail.signed_documents.length === 0 ? (
            <Empty>{t("noSignedDocs", locale)}</Empty>
          ) : (
            <SignedDocsTable
              rows={detail.signed_documents}
              token={token}
              locale={locale}
            />
          )}
        </Card>

        {/* Certificates */}
        <SectionHeader title={t("certsTitle", locale)} />
        <Card>
          {detail.certificates.length === 0 ? (
            <Empty>{t("noCerts", locale)}</Empty>
          ) : (
            <CertificatesTable
              rows={detail.certificates}
              token={token}
              locale={locale}
            />
          )}
        </Card>

        {/* Pending re-acks */}
        <SectionHeader title={t("pendingTitle", locale)} />
        <Card>
          {detail.pending_re_acks.filter((p) => !p.acknowledged_at).length === 0 ? (
            <Empty>{t("noPending", locale)}</Empty>
          ) : (
            <PendingTable
              rows={detail.pending_re_acks.filter((p) => !p.acknowledged_at)}
              locale={locale}
            />
          )}
        </Card>

        {toast ? (
          <div
            style={{
              marginTop: 14,
              padding: "10px 14px",
              background: "#ECFDF5",
              border: `1px solid ${SUCCESS}`,
              color: SUCCESS,
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            {toast}
          </div>
        ) : null}
      </div>

      {/* Action dialogs */}
      {dialog?.kind === "extend" && enrollment ? (
        <ExtendDialog
          enrollmentId={enrollment.id}
          token={token}
          locale={locale}
          onClose={() => setDialog(null)}
          onDone={async () => {
            setDialog(null);
            setToast(t("saved", locale));
            await refresh();
            setTimeout(() => setToast(null), 3000);
          }}
        />
      ) : null}
      {dialog?.kind === "reset-deadline" && enrollment ? (
        <ResetDeadlineConfirm
          enrollmentId={enrollment.id}
          token={token}
          locale={locale}
          onClose={() => setDialog(null)}
          onDone={async () => {
            setDialog(null);
            setToast(t("saved", locale));
            await refresh();
            setTimeout(() => setToast(null), 3000);
          }}
        />
      ) : null}
      {dialog?.kind === "reset-module" ? (
        <ResetModuleDialog
          rows={detail.module_progress}
          token={token}
          locale={locale}
          onClose={() => setDialog(null)}
          onDone={async () => {
            setDialog(null);
            setToast(t("saved", locale));
            await refresh();
            setTimeout(() => setToast(null), 3000);
          }}
        />
      ) : null}
      {dialog?.kind === "archive" ? (
        <ArchiveDialog
          userId={detail.user.id}
          name={detail.user.full_name}
          token={token}
          locale={locale}
          onClose={() => setDialog(null)}
          onDone={async () => {
            setDialog(null);
            setLocation("/lms/admin");
          }}
        />
      ) : null}

      <style>{`
        @keyframes qleno-journey-spin { to { transform: rotate(360deg); } }
        .qleno-journey-spin { animation: qleno-journey-spin 1s linear infinite; }
      `}</style>
    </Shell>
  );
}

// ──────────────── helpers ────────────────

function computeDeadlineState(
  enrollment: LearnerDetail["enrollment"],
  locale: Locale,
): string {
  if (!enrollment) return "—";
  if (!enrollment.deadline_at) return T.notStarted[locale];
  const dl = new Date(enrollment.deadline_at).getTime();
  const now = Date.now();
  const days = Math.round((dl - now) / (1000 * 60 * 60 * 24));
  if (days < 0) {
    return `${Math.abs(days)} ${
      Math.abs(days) === 1
        ? locale === "es"
          ? "día atrasado"
          : "day overdue"
        : locale === "es"
        ? "días atrasados"
        : "days overdue"
    }`;
  }
  if (days === 0) {
    return locale === "es" ? "Vence hoy" : "Due today";
  }
  return `${days} ${days === 1 ? T.dayRemaining[locale] : T.daysRemaining[locale]}`;
}

// ──────────────── presentational ────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: PAGE_BG,
        fontFamily: FONT,
        color: INK,
        paddingBottom: 40,
      }}
    >
      {children}
    </div>
  );
}

function BackBar({
  locale,
  setLocale,
  onBack,
}: {
  locale: Locale;
  setLocale: (l: Locale) => void;
  onBack: () => void;
}) {
  return (
    <div
      style={{
        maxWidth: 920,
        margin: "0 auto",
        padding: "14px 16px 0",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
      }}
    >
      <button
        type="button"
        onClick={onBack}
        style={{
          background: "transparent",
          border: 0,
          color: NAVY,
          fontSize: 13,
          fontWeight: 700,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontFamily: FONT,
          padding: 0,
        }}
      >
        <ChevronLeft size={14} /> {t("back", locale)}
      </button>
      <div style={{ display: "flex", gap: 6 }}>
        <LocaleBtn active={locale === "en"} onClick={() => setLocale("en")}>
          EN
        </LocaleBtn>
        <LocaleBtn active={locale === "es"} onClick={() => setLocale("es")}>
          ES
        </LocaleBtn>
      </div>
    </div>
  );
}

function LocaleBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? NAVY : "transparent",
        color: active ? "#fff" : INK,
        border: `1px solid ${active ? NAVY : LINE}`,
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        cursor: "pointer",
        fontFamily: FONT,
      }}
    >
      {children}
    </button>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        maxWidth: 920,
        margin: "12px auto 0",
        padding: "16px 18px",
        background: SURFACE,
        border: `1px solid ${LINE}`,
        borderRadius: RADIUS,
      }}
    >
      {children}
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div
      style={{
        maxWidth: 920,
        margin: "18px auto 0",
        padding: "0 18px",
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: INK_MUTE,
      }}
    >
      {title}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 800,
          color: INK_LIGHT,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 13, color: INK, fontWeight: 600, marginTop: 4 }}>
        {value}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12.5,
        color: INK_LIGHT,
        fontStyle: "italic",
        padding: "10px 0",
      }}
    >
      {children}
    </div>
  );
}

function ActionBtn({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: danger ? "transparent" : NAVY,
        color: danger ? DANGER : "#fff",
        border: danger ? `1px solid ${DANGER}` : `1px solid ${NAVY}`,
        padding: "8px 14px",
        borderRadius: 8,
        fontSize: 12.5,
        fontWeight: 700,
        cursor: "pointer",
        fontFamily: FONT,
      }}
      onMouseEnter={(e) => {
        if (!danger) (e.currentTarget as HTMLButtonElement).style.background = NAVY_HOV;
      }}
      onMouseLeave={(e) => {
        if (!danger) (e.currentTarget as HTMLButtonElement).style.background = NAVY;
      }}
    >
      {label}
    </button>
  );
}

function ComplianceTotals({
  compliance,
  locale,
}: {
  compliance: AuditCompliance;
  locale: Locale;
}) {
  const color =
    compliance.overall === "complete"
      ? SUCCESS
      : compliance.overall === "needs_resign"
      ? WARN
      : compliance.overall === "overdue"
      ? DANGER
      : TEAL;
  const label =
    compliance.overall === "complete"
      ? locale === "es"
        ? "Completo"
        : "Complete"
      : compliance.overall === "needs_resign"
      ? locale === "es"
        ? "Re-firma pendiente"
        : "Needs re-sign"
      : compliance.overall === "overdue"
      ? locale === "es"
        ? "Atrasado"
        : "Overdue"
      : locale === "es"
      ? "En progreso"
      : "In progress";
  return (
    <span
      style={{
        background: color + "20",
        color,
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        alignSelf: "flex-start",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

// ──────────────── sections ────────────────

function ModulesTimeline({
  rows,
  locale,
}: {
  rows: LearnerDetail["module_progress"];
  locale: Locale;
}) {
  // Sort: passed first by passed_at desc, then in_progress, then failed, then not_started.
  const sorted = [...rows].sort((a, b) => {
    const order: Record<string, number> = {
      passed: 0,
      in_progress: 1,
      failed: 2,
      not_started: 3,
    };
    return (order[a.status] ?? 4) - (order[b.status] ?? 4);
  });
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {sorted.map((r) => {
        const tone =
          r.status === "passed"
            ? SUCCESS
            : r.status === "failed"
            ? DANGER
            : r.status === "in_progress"
            ? WARN
            : INK_LIGHT;
        const label =
          r.status === "passed"
            ? T.passed[locale]
            : r.status === "failed"
            ? T.failed[locale]
            : r.status === "in_progress"
            ? T.inProgress[locale]
            : T.notStarted[locale];
        return (
          <div
            key={r.module_id}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 12,
              padding: "10px 12px",
              borderLeft: `3px solid ${tone}`,
              background: LINE_SOFT,
              borderRadius: 6,
            }}
          >
            <div>
              <div style={{ fontWeight: 700, color: INK, fontSize: 13 }}>
                {humanModule(r.module_id)}
              </div>
              <div style={{ fontSize: 11.5, color: INK_MUTE, marginTop: 2 }}>
                {r.status === "passed" && r.passed_at
                  ? humanDateTime(r.passed_at)
                  : `${r.attempts} ${T.attempts[locale]}`}
                {r.best_score > 0 ? ` · ${r.best_score}%` : ""}
              </div>
            </div>
            <span
              style={{
                background: tone + "20",
                color: tone,
                padding: "3px 8px",
                borderRadius: 999,
                fontSize: 10.5,
                fontWeight: 800,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                whiteSpace: "nowrap",
                alignSelf: "flex-start",
              }}
            >
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SignedDocsTable({
  rows,
  token,
  locale,
}: {
  rows: LearnerDetail["signed_documents"];
  token: string | null;
  locale: Locale;
}) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {rows.map((r) => (
        <div
          key={r.id}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto",
            gap: 12,
            padding: "10px 12px",
            background: LINE_SOFT,
            borderRadius: 6,
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, color: INK, fontSize: 13 }}>
              {humanDocumentType(r.document_type)}
            </div>
            <div style={{ fontSize: 11.5, color: INK_MUTE, marginTop: 2 }}>
              {humanDateTime(r.signed_at)} · {r.locale.toUpperCase()} ·{" "}
              {r.employee_signature_method} · {r.status}
            </div>
          </div>
          <button
            type="button"
            onClick={() => downloadSignedPdf(token, r.id)}
            style={{
              background: "transparent",
              color: NAVY,
              border: `1px solid ${LINE}`,
              borderRadius: 6,
              padding: "5px 10px",
              fontSize: 11.5,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: FONT,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <Download size={11} /> {t("download", locale)}
          </button>
        </div>
      ))}
    </div>
  );
}

function CertificatesTable({
  rows,
  token,
  locale,
}: {
  rows: LearnerDetail["certificates"];
  token: string | null;
  locale: Locale;
}) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {rows.map((r) => (
        <div
          key={r.id}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto",
            gap: 12,
            padding: "10px 12px",
            background: LINE_SOFT,
            borderRadius: 6,
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, color: INK, fontSize: 13 }}>
              {humanModule(r.module_id)}
            </div>
            <div style={{ fontSize: 11.5, color: INK_MUTE, marginTop: 2 }}>
              {humanDateTime(r.issued_at)} · {r.locale.toUpperCase()}
              {r.score !== null ? ` · ${r.score}%` : ""}
              {r.revoked_at ? ` · revoked ${humanDateTime(r.revoked_at)}` : ""}
            </div>
          </div>
          {!r.revoked_at ? (
            <button
              type="button"
              onClick={() => downloadCertificatePdf(token, r.id)}
              style={{
                background: "transparent",
                color: NAVY,
                border: `1px solid ${LINE}`,
                borderRadius: 6,
                padding: "5px 10px",
                fontSize: 11.5,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: FONT,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <Download size={11} /> {t("download", locale)}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function PendingTable({
  rows,
  locale,
}: {
  rows: LearnerDetail["pending_re_acks"];
  locale: Locale;
}) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {rows.map((r) => (
        <div
          key={r.id}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto",
            gap: 12,
            padding: "10px 12px",
            background: "#FFFBEB",
            borderLeft: `3px solid ${WARN}`,
            borderRadius: 6,
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, color: INK, fontSize: 13 }}>
              {humanDocumentType(r.document_type)}
            </div>
            <div style={{ fontSize: 11.5, color: INK_MUTE, marginTop: 2 }}>
              {r.trigger_reason} · {humanDateTime(r.triggered_at)}
              {r.defer_until ? ` · deferred until ${humanDateTime(r.defer_until)}` : ""}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ──────────────── action dialogs ────────────────

function DialogShell({
  title,
  description,
  children,
  onClose,
  primaryLabel,
  primaryDisabled,
  primaryOnClick,
  busy,
  danger,
  locale,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
  onClose: () => void;
  primaryLabel: string;
  primaryDisabled: boolean;
  primaryOnClick: () => void;
  busy: boolean;
  danger?: boolean;
  locale: Locale;
}) {
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
        background: "rgba(15,23,42,0.55)",
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
        <div style={{ fontSize: 16, fontWeight: 800 }}>{title}</div>
        <div
          style={{
            fontSize: 12.5,
            color: INK_MUTE,
            marginTop: 6,
            lineHeight: 1.55,
          }}
        >
          {description}
        </div>
        {children}
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
            {t("cancel", locale)}
          </button>
          <button
            type="button"
            disabled={primaryDisabled || busy}
            onClick={primaryOnClick}
            style={{
              background:
                primaryDisabled || busy
                  ? INK_LIGHT
                  : danger
                  ? DANGER
                  : NAVY,
              color: "#fff",
              border: 0,
              padding: "8px 14px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 700,
              fontFamily: FONT,
              cursor: primaryDisabled || busy ? "default" : "pointer",
            }}
          >
            {busy ? "…" : primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExtendDialog({
  enrollmentId,
  token,
  locale,
  onClose,
  onDone,
}: {
  enrollmentId: number;
  token: string | null;
  locale: Locale;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = days >= 1 && days <= 90;
  return (
    <DialogShell
      title={t("extendBtn", locale)}
      description={
        locale === "es"
          ? "Extiende la fecha límite a hoy + N días (1 a 90)."
          : "Extends the deadline to today + N days (1 to 90)."
      }
      onClose={onClose}
      busy={busy}
      primaryLabel={t("confirm", locale)}
      primaryDisabled={!valid}
      primaryOnClick={async () => {
        setBusy(true);
        setErr(null);
        try {
          await api("POST", "/lms/admin/extend", token, {
            enrollmentId,
            days,
          });
          await onDone();
        } catch (e) {
          setErr(String((e as Error).message));
        } finally {
          setBusy(false);
        }
      }}
      locale={locale}
    >
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
        Days (1–90)
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
      {err ? (
        <div style={{ color: DANGER, fontSize: 12, marginTop: 8 }}>{err}</div>
      ) : null}
    </DialogShell>
  );
}

function ResetDeadlineConfirm({
  enrollmentId,
  token,
  locale,
  onClose,
  onDone,
}: {
  enrollmentId: number;
  token: string | null;
  locale: Locale;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <DialogShell
      title={t("resetDeadlineBtn", locale)}
      description={
        locale === "es"
          ? "Limpia la fecha límite. El conteo se reinicia en el próximo intento de cuestionario."
          : "Clears the deadline. Countdown restarts on the next quiz attempt."
      }
      onClose={onClose}
      busy={busy}
      primaryLabel={t("confirm", locale)}
      primaryDisabled={confirm.trim().toUpperCase() !== "RESET"}
      primaryOnClick={async () => {
        setBusy(true);
        setErr(null);
        try {
          await api("POST", "/lms/admin/reset-deadline", token, {
            enrollmentId,
          });
          await onDone();
        } catch (e) {
          setErr(String((e as Error).message));
        } finally {
          setBusy(false);
        }
      }}
      locale={locale}
    >
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
      {err ? (
        <div style={{ color: DANGER, fontSize: 12, marginTop: 8 }}>{err}</div>
      ) : null}
    </DialogShell>
  );
}

function ResetModuleDialog({
  rows,
  token,
  locale,
  onClose,
  onDone,
}: {
  rows: LearnerDetail["module_progress"];
  token: string | null;
  locale: Locale;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [moduleId, setModuleId] = useState<string>("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid =
    moduleId.length > 0 && confirm.trim().toUpperCase() === "RESET";
  return (
    <DialogShell
      title={t("resetModuleBtn", locale)}
      description={
        locale === "es"
          ? "Reinicia el conteo de intentos para un módulo. El empleado puede volver a tomar el cuestionario."
          : "Clears the attempt count for a module so the employee can retake the quiz."
      }
      onClose={onClose}
      busy={busy}
      primaryLabel={t("confirm", locale)}
      primaryDisabled={!valid}
      primaryOnClick={async () => {
        setBusy(true);
        setErr(null);
        try {
          await api("POST", "/lms/admin/reset", token, { moduleId });
          await onDone();
        } catch (e) {
          setErr(String((e as Error).message));
        } finally {
          setBusy(false);
        }
      }}
      locale={locale}
      danger
    >
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
        Module
      </label>
      <select
        value={moduleId}
        onChange={(e) => setModuleId(e.target.value)}
        style={{
          width: "100%",
          marginTop: 6,
          padding: "10px 12px",
          border: `1px solid ${LINE}`,
          borderRadius: 8,
          fontSize: 14,
          fontFamily: FONT,
          background: SURFACE,
        }}
      >
        <option value="">—</option>
        {rows.map((r) => (
          <option key={r.module_id} value={r.module_id}>
            {humanModule(r.module_id)}
          </option>
        ))}
      </select>
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
      {err ? (
        <div style={{ color: DANGER, fontSize: 12, marginTop: 8 }}>{err}</div>
      ) : null}
    </DialogShell>
  );
}

function ArchiveDialog({
  userId,
  name,
  token,
  locale,
  onClose,
  onDone,
}: {
  userId: number;
  name: string;
  token: string | null;
  locale: Locale;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = confirm.trim() === name.trim();
  return (
    <DialogShell
      title={t("archiveBtn", locale)}
      description={
        locale === "es"
          ? "Oculta al empleado del listado y del panel de auditoría. Los certificados y firmas se conservan para registros legales."
          : "Hides this employee from the roster and audit dashboard. Certificates and signatures stay in the database for legal."
      }
      onClose={onClose}
      busy={busy}
      primaryLabel={t("archiveBtn", locale)}
      primaryDisabled={!valid}
      primaryOnClick={async () => {
        setBusy(true);
        setErr(null);
        try {
          await api("POST", `/users/${userId}/lms-archive`, token);
          await onDone();
        } catch (e) {
          setErr(String((e as Error).message));
        } finally {
          setBusy(false);
        }
      }}
      locale={locale}
      danger
    >
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
        {locale === "es"
          ? "Escriba el nombre completo para confirmar"
          : "Type the full name to confirm"}
        : <strong>{name}</strong>
      </label>
      <input
        type="text"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder={name}
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
      {err ? (
        <div style={{ color: DANGER, fontSize: 12, marginTop: 8 }}>{err}</div>
      ) : null}
    </DialogShell>
  );
}

// ──────────────── PDF downloads (auth-wrapped) ────────────────

async function downloadSignedPdf(token: string | null, signedDocumentId: number) {
  const res = await fetch(
    `${API_BASE}/lms/signatures/${signedDocumentId}/pdf`,
    {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    },
  );
  if (!res.ok) {
    alert(`Download failed: ${res.status}`);
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `signed-${signedDocumentId}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function downloadCertificatePdf(token: string | null, certId: number) {
  const res = await fetch(`${API_BASE}/lms/certificates/${certId}/pdf`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    alert(`Download failed: ${res.status}`);
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `certificate-${certId}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
