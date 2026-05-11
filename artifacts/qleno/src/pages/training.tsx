/**
 * Qleno LMS — Training page (per-module rebuild).
 *
 * Flow per spec:
 *   1. Land → /api/lms/me lazy-creates the enrollment if absent.
 *   2. Read each module in MODULE_ORDER. Quiz modules require an 80% pass;
 *      content-only modules (qleno-app, acknowledgment) advance via
 *      acknowledge.
 *   3. Sequential gating — module N is locked until N-1 passes.
 *   4. While taking a quiz, answers + cursor autosave every 300 ms (debounced)
 *      to /api/lms/quiz/state. Cross-device resume: switching devices picks
 *      up where the tech left off.
 *   5. After every quiz/content module is complete, the final mixed test
 *      unlocks. Server samples random questions; frontend never sees correct
 *      answers (server-authoritative scoring).
 *   6. After final passes, the acknowledgment module shows a typed signature
 *      gate; submitting marks the enrollment completed.
 *   7. Deadline = 7 days from enrollment, displayed as "X days remaining"
 *      using `Math.floor` so overdue renders correctly.
 *   8. Grandfather migration: the first time this page loads after the
 *      per-module rollout, any prior single-quiz `progress.completedModules`
 *      stored in localStorage is POSTed once to /api/lms/grandfather and
 *      cleared.
 *
 * Visual style preserved from the prior single-quiz design:
 *   Plus Jakarta Sans, NAVY/TEAL accent palette, rounded surfaces,
 *   bilingual EN/ES toggle.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { useAuthStore } from "@/lib/auth";
import {
  getCurriculum,
  type Curriculum,
  type Locale,
  type Module,
  type ContentBlock,
  type IconKind,
} from "@/lib/training/curriculum";
import {
  MODULE_ORDER,
  QUIZ_MODULE_IDS,
  QUESTIONS_BY_MODULE,
  FINAL_MODULE_ID,
  MAX_MODULE_ATTEMPTS,
  MAX_FINAL_ATTEMPTS,
  maxAttemptsFor,
  isModuleUnlocked,
  isFinalUnlocked,
  type ModuleId,
} from "@workspace/lms-curriculum";
import { QlenoLogo } from "@/components/brand/QlenoLogo";
import {
  ChevronRight,
  ChevronLeft,
  Check,
  X,
  ArrowLeft,
  Globe2,
  AlertTriangle,
  Info,
  CircleCheck,
  Lock,
  Award,
  Loader2,
  CalendarClock,
  FastForward,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Tokens — preserved from prior design
// ─────────────────────────────────────────────────────────────────────────────
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

const PASS_THRESHOLD_PCT = 80;
const AUTOSAVE_DEBOUNCE_MS = 300;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Learner = {
  email: string;
  firstName: string;
  lastName: string;
  companyId: number | null;
  role: string | null;
};

type EnrollmentRow = {
  id: number;
  company_id: number;
  user_id: number;
  status: "active" | "completed" | "expired";
  enrolled_at: string;
  deadline_at: string;
  completed_at: string | null;
  last_activity_at: string;
  locale: string | null;
  acknowledgment_signature: string | null;
  acknowledgment_at: string | null;
};

type ModuleProgressRow = {
  id: number;
  enrollment_id: number;
  module_id: string;
  status: "not_started" | "in_progress" | "passed" | "failed";
  best_score: number;
  attempts: number;
};

type LmsState = {
  enrollment: EnrollmentRow;
  progress: ModuleProgressRow[];
  unlocked: Record<string, boolean>;
  days_remaining: number;
  limits?: Record<string, number>;
  is_owner?: boolean;
};

type QuizStateRow = {
  module_id: string;
  current_question_index: number;
  answers: (number | null)[];
  meta: { question_ids?: string[] } | null;
};

type SubmitResult = {
  score: number;
  passed: boolean;
  correctCount: number;
  totalCount: number;
  perQuestion?: boolean[];
  attempts_used?: number;
  max_attempts?: number;
  attempts_remaining?: number;
};

type View =
  | { kind: "home" }
  | { kind: "module"; moduleId: string }
  | { kind: "quiz"; moduleId: string }
  | { kind: "final-intro" }
  | { kind: "final-quiz" }
  | { kind: "ack" }
  | { kind: "done" };

// ─────────────────────────────────────────────────────────────────────────────
// API client
// ─────────────────────────────────────────────────────────────────────────────

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

const lmsApi = {
  me: (token: string | null) => api<LmsState>("GET", "/lms/me", token),
  enroll: (token: string | null, locale: Locale) =>
    api<EnrollmentRow>("POST", "/lms/enroll", token, { locale }),
  startModule: (token: string | null, moduleId: string) =>
    api<ModuleProgressRow>("POST", "/lms/module/start", token, { moduleId }),
  getQuizState: (token: string | null, moduleId: string) =>
    api<QuizStateRow | null>(
      "GET",
      `/lms/quiz/state?moduleId=${encodeURIComponent(moduleId)}`,
      token,
    ),
  saveQuizState: (
    token: string | null,
    moduleId: string,
    currentQuestionIndex: number,
    answers: (number | null)[],
    questionIds?: string[],
  ) =>
    api<QuizStateRow>("POST", "/lms/quiz/state", token, {
      moduleId,
      currentQuestionIndex,
      answers,
      questionIds,
    }),
  submitQuiz: (
    token: string | null,
    moduleId: string,
    answers: (number | null)[],
    questionIds?: string[],
  ) =>
    api<SubmitResult>("POST", "/lms/quiz/submit", token, {
      moduleId,
      answers,
      questionIds,
    }),
  acknowledge: (
    token: string | null,
    moduleId: string,
    signature?: string,
  ) =>
    api<{ ok: true }>("POST", "/lms/module/acknowledge", token, {
      moduleId,
      signature,
    }),
  grandfather: (
    token: string | null,
    payload: {
      completedModules: string[];
      acknowledged: boolean;
      acknowledgmentName: string | null;
    },
  ) =>
    api<{ ok: true; enrollment_id: number }>(
      "POST",
      "/lms/grandfather",
      token,
      payload,
    ),
  bypassModule: (token: string | null, moduleId: string) =>
    api<{ ok: true; enrollment_id: number }>(
      "POST",
      "/lms/admin/bypass-module",
      token,
      { moduleId },
    ),
};

// ─────────────────────────────────────────────────────────────────────────────
// Token helpers
// ─────────────────────────────────────────────────────────────────────────────

function readLearnerFromToken(token: string | null): Learner | null {
  if (!token) return null;
  try {
    const p = JSON.parse(atob(token.split(".")[1]));
    return {
      email: p.email ?? "",
      firstName: p.first_name ?? "",
      lastName: p.last_name ?? "",
      companyId: p.companyId ?? null,
      role: p.role ?? null,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// i18n strings (subset, expand as needed)
// ─────────────────────────────────────────────────────────────────────────────

const T = {
  title: { en: "Onboarding & Training", es: "Capacitación e Incorporación" },
  back: { en: "Back", es: "Atrás" },
  start: { en: "Start", es: "Comenzar" },
  resume: { en: "Resume", es: "Continuar" },
  review: { en: "Review", es: "Revisar" },
  locked: { en: "Locked", es: "Bloqueado" },
  passed: { en: "Passed", es: "Aprobado" },
  failed: { en: "Failed", es: "No aprobado" },
  next: { en: "Next", es: "Siguiente" },
  submit: { en: "Submit", es: "Enviar" },
  retry: { en: "Try again", es: "Intentar de nuevo" },
  acknowledge: { en: "I acknowledge", es: "Confirmo" },
  finalIntro: {
    en: "Final mixed test — random questions from every module. 80% to pass.",
    es:
      "Examen final mixto — preguntas aleatorias de cada módulo. 80% para aprobar.",
  },
  ackPrompt: {
    en: "Type your full name to acknowledge you've completed training.",
    es: "Escribe tu nombre completo para confirmar que terminaste la capacitación.",
  },
  yourName: { en: "Your full name", es: "Tu nombre completo" },
  daysRemaining: {
    en: "days remaining",
    es: "días restantes",
  },
  daysOverdue: {
    en: "days overdue",
    es: "días vencidos",
  },
  dueToday: { en: "due today", es: "vence hoy" },
  finalTest: { en: "Final mixed test", es: "Examen final mixto" },
  pass80: { en: "80% to pass", es: "80% para aprobar" },
  loading: { en: "Loading…", es: "Cargando…" },
  doneTitle: {
    en: "Training complete",
    es: "Capacitación completada",
  },
  doneSub: {
    en: "Thanks — your manager has been notified.",
    es: "Gracias — tu supervisor ha sido notificado.",
  },
  start_first: { en: "Start your training", es: "Comenzar capacitación" },
  attempt: { en: "Attempt", es: "Intento" },
  of: { en: "of", es: "de" },
  attemptsUsed: { en: "attempts used", es: "intentos usados" },
  attemptsRemaining: { en: "attempts remaining", es: "intentos restantes" },
  noAttemptsLeft: {
    en: "No attempts remaining. Ask your admin to extend or bypass.",
    es: "No quedan intentos. Pide al administrador que extienda o exente.",
  },
  bypassOwner: { en: "Skip (Owner)", es: "Saltar (Propietario)" },
  bypassed: { en: "Bypassed by owner", es: "Exento por el propietario" },
  resume_quiz: { en: "Resume quiz", es: "Continuar examen" },
  retry_quiz: { en: "Try again", es: "Intentar de nuevo" },
  start_quiz: { en: "Start quiz", es: "Comenzar examen" },
  review_quiz: { en: "Review", es: "Revisar" },
} as const;

function tr(key: keyof typeof T, locale: Locale): string {
  return T[key][locale];
}

// ─────────────────────────────────────────────────────────────────────────────
// Grandfather migration — read legacy localStorage progress and POST once
// ─────────────────────────────────────────────────────────────────────────────

const LEGACY_KEYS_PREFIX = "qleno.training.progress.";

function readLegacyProgress(email: string): {
  completedModules: string[];
  acknowledged: boolean;
  acknowledgmentName: string | null;
} | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEYS_PREFIX + email.toLowerCase());
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return {
      completedModules: Array.isArray(obj?.completedModules)
        ? obj.completedModules.filter((s: unknown) => typeof s === "string")
        : [],
      acknowledged: !!obj?.acknowledgedAt,
      acknowledgmentName:
        typeof obj?.acknowledgmentName === "string" ? obj.acknowledgmentName : null,
    };
  } catch {
    return null;
  }
}

function clearLegacyProgress(email: string) {
  try {
    localStorage.removeItem(LEGACY_KEYS_PREFIX + email.toLowerCase());
  } catch {
    /* noop */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function TrainingPage() {
  const token = useAuthStore((s) => s.token);
  const learner = useMemo(() => readLearnerFromToken(token), [token]);
  const [, setLocation] = useLocation();
  const [locale, setLocale] = useState<Locale>("en");
  const [state, setState] = useState<LmsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "home" });

  const curriculum = useMemo<Curriculum>(
    () => getCurriculum(learner?.companyId ?? null),
    [learner?.companyId],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await lmsApi.me(token);
      setState(next);
      // Sync locale from server if present
      if (next.enrollment.locale === "en" || next.enrollment.locale === "es") {
        setLocale(next.enrollment.locale);
      }
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, [token]);

  // First-load: grandfather migration → /me
  useEffect(() => {
    if (!learner) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const legacy = readLegacyProgress(learner.email);
        if (legacy) {
          await lmsApi.grandfather(token, legacy);
          clearLegacyProgress(learner.email);
        }
        if (cancelled) return;
        await refresh();
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [learner, token, refresh]);

  // Persist locale change to backend (best-effort)
  useEffect(() => {
    if (!state) return;
    if (state.enrollment.locale === locale) return;
    void lmsApi.enroll(token, locale).catch(() => {
      /* surface is non-critical */
    });
  }, [locale, state, token]);

  if (!learner) {
    return (
      <PageShell>
        <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ alignSelf: "flex-end" }}>
            <LocaleToggle locale={locale} setLocale={setLocale} />
          </div>
          <div style={{ color: INK_MUTE }}>
            {locale === "en"
              ? "Sign in to access training."
              : "Inicia sesión para acceder a la capacitación."}
          </div>
        </div>
      </PageShell>
    );
  }

  if (loading || !state) {
    return (
      <PageShell>
        <Header
          tenantName={curriculum.tenantName}
          locale={locale}
          setLocale={setLocale}
          daysRemaining={state?.days_remaining ?? null}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            padding: 80,
            color: INK_MUTE,
          }}
        >
          <Loader2
            className="qleno-spin"
            size={20}
            style={{ marginRight: 10 }}
          />
          {tr("loading", locale)}
        </div>
        {error && (
          <div
            style={{
              maxWidth: 720,
              margin: "0 auto",
              padding: 12,
              color: DANGER,
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}
        <ResponsiveStyles />
      </PageShell>
    );
  }

  const completedIds = state.progress
    .filter((p) => p.status === "passed")
    .map((p) => p.module_id);
  const finalUnlocked = isFinalUnlocked(completedIds);
  const finalPassed = completedIds.includes(FINAL_MODULE_ID);
  const ackUnlocked = isModuleUnlocked("acknowledgment", completedIds);
  const enrollmentDone = state.enrollment.status === "completed";

  // Auto-route to done if everything's wrapped up
  if (enrollmentDone && view.kind !== "done") {
    setView({ kind: "done" });
  }

  return (
    <PageShell>
      <Header
        tenantName={curriculum.tenantName}
        locale={locale}
        setLocale={setLocale}
        daysRemaining={state.days_remaining}
      />
      {view.kind === "home" && (
        <Home
          curriculum={curriculum}
          state={state}
          locale={locale}
          finalUnlocked={finalUnlocked}
          finalPassed={finalPassed}
          ackUnlocked={ackUnlocked}
          onOpenModule={(moduleId) => setView({ kind: "module", moduleId })}
          onOpenFinal={() => setView({ kind: "final-intro" })}
          onOpenAck={() => setView({ kind: "ack" })}
          onBypass={async (moduleId) => {
            await lmsApi.bypassModule(token, moduleId);
            await refresh();
          }}
        />
      )}
      {view.kind === "module" && (
        <ModuleView
          module={
            curriculum.modules.find((m) => m.id === view.moduleId) ??
            curriculum.modules[0]
          }
          locale={locale}
          isQuizModule={
            QUIZ_MODULE_IDS.includes(view.moduleId as never)
          }
          progress={state.progress.find((p) => p.module_id === view.moduleId) ?? null}
          isOwner={!!state.is_owner}
          onBack={() => setView({ kind: "home" })}
          onTakeQuiz={() => setView({ kind: "quiz", moduleId: view.moduleId })}
          onAcknowledge={async () => {
            await lmsApi.acknowledge(token, view.moduleId);
            await refresh();
            setView({ kind: "home" });
          }}
          onBypass={async () => {
            await lmsApi.bypassModule(token, view.moduleId);
            await refresh();
            setView({ kind: "home" });
          }}
          onStart={async () => {
            try {
              await lmsApi.startModule(token, view.moduleId);
            } catch {
              /* idempotent — ignore conflict */
            }
          }}
        />
      )}
      {view.kind === "quiz" && (
        <QuizView
          curriculum={curriculum}
          moduleId={view.moduleId}
          locale={locale}
          token={token}
          priorAttempts={
            state.progress.find((p) => p.module_id === view.moduleId)?.attempts ?? 0
          }
          onCancel={() => setView({ kind: "module", moduleId: view.moduleId })}
          onPassed={async () => {
            await refresh();
            setView({ kind: "home" });
          }}
        />
      )}
      {view.kind === "final-intro" && (
        <FinalIntroView
          locale={locale}
          onStart={() => setView({ kind: "final-quiz" })}
          onCancel={() => setView({ kind: "home" })}
        />
      )}
      {view.kind === "final-quiz" && (
        <QuizView
          curriculum={curriculum}
          moduleId={FINAL_MODULE_ID}
          locale={locale}
          token={token}
          priorAttempts={
            state.progress.find((p) => p.module_id === FINAL_MODULE_ID)?.attempts ?? 0
          }
          onCancel={() => setView({ kind: "home" })}
          onPassed={async () => {
            await refresh();
            setView({ kind: "home" });
          }}
        />
      )}
      {view.kind === "ack" && (
        <AckView
          locale={locale}
          tenantName={curriculum.tenantName}
          learner={learner}
          onCancel={() => setView({ kind: "home" })}
          onSubmit={async (signature) => {
            await lmsApi.acknowledge(token, "acknowledgment", signature);
            await refresh();
            setView({ kind: "done" });
          }}
        />
      )}
      {view.kind === "done" && (
        <DoneView
          locale={locale}
          tenantName={curriculum.tenantName}
          onReturnHome={() => setLocation("/")}
        />
      )}
      <ResponsiveStyles />
    </PageShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page shell + header + locale + countdown
// ─────────────────────────────────────────────────────────────────────────────

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: PAGE_BG,
        fontFamily: FONT,
        color: INK,
      }}
    >
      {children}
    </div>
  );
}

function Header({
  tenantName,
  locale,
  setLocale,
  daysRemaining,
}: {
  tenantName: string;
  locale: Locale;
  setLocale: (l: Locale) => void;
  daysRemaining: number | null;
}) {
  return (
    <header
      style={{
        background: SURFACE,
        borderBottom: `1px solid ${LINE}`,
        padding: "14px 18px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          minWidth: 0,
        }}
      >
        <QlenoLogo size="md" theme="light" layout="horizontal" />
        <div
          style={{
            height: 24,
            width: 1,
            background: LINE,
            margin: "0 2px",
          }}
          aria-hidden
        />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontWeight: 700,
              fontSize: 14,
              letterSpacing: "-0.01em",
              color: INK,
              lineHeight: 1.2,
            }}
          >
            {tenantName}
          </div>
          <div
            style={{
              fontSize: 11,
              color: INK_LIGHT,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            {tr("title", locale)}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {daysRemaining != null && <DeadlineBadge days={daysRemaining} locale={locale} />}
        <LocaleToggle locale={locale} setLocale={setLocale} />
      </div>
    </header>
  );
}

function DeadlineBadge({ days, locale }: { days: number; locale: Locale }) {
  let tone = SUCCESS;
  let bg = "#ECFDF5";
  let label = `${days} ${tr("daysRemaining", locale)}`;
  if (days < 0) {
    tone = DANGER;
    bg = "#FEF2F2";
    label = `${Math.abs(days)} ${tr("daysOverdue", locale)}`;
  } else if (days === 0) {
    tone = WARN;
    bg = "#FFFBEB";
    label = tr("dueToday", locale);
  } else if (days <= 2) {
    tone = WARN;
    bg = "#FFFBEB";
  }
  return (
    <div
      role="status"
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: bg,
        color: tone,
        padding: "5px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: "0.01em",
        border: `1px solid ${tone}33`,
        whiteSpace: "nowrap",
      }}
    >
      <CalendarClock size={12} />
      {label}
    </div>
  );
}

function LocaleToggle({
  locale,
  setLocale,
}: {
  locale: Locale;
  setLocale: (l: Locale) => void;
}) {
  const activeStyle = {
    background: NAVY,
    color: "#fff",
    fontWeight: 700,
  } as const;
  const inactiveStyle = {
    background: "transparent",
    color: INK_MUTE,
    fontWeight: 600,
  } as const;
  return (
    <div
      role="group"
      aria-label="Language toggle"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0,
        background: "#fff",
        border: `1px solid ${LINE}`,
        borderRadius: 999,
        padding: 2,
        fontFamily: FONT,
      }}
    >
      <Globe2 size={14} style={{ marginLeft: 8, marginRight: 4, color: INK_MUTE }} />
      <button
        type="button"
        onClick={() => setLocale("en")}
        style={{
          border: "none",
          padding: "5px 12px",
          borderRadius: 999,
          fontSize: 12,
          letterSpacing: "0.04em",
          cursor: "pointer",
          fontFamily: FONT,
          ...(locale === "en" ? activeStyle : inactiveStyle),
        }}
      >
        ENGLISH
      </button>
      <button
        type="button"
        onClick={() => setLocale("es")}
        style={{
          border: "none",
          padding: "5px 12px",
          borderRadius: 999,
          fontSize: 12,
          letterSpacing: "0.04em",
          cursor: "pointer",
          fontFamily: FONT,
          ...(locale === "es" ? activeStyle : inactiveStyle),
        }}
      >
        ESPAÑOL
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Home — module list + final test card + ack card
// ─────────────────────────────────────────────────────────────────────────────

function Home({
  curriculum,
  state,
  locale,
  finalUnlocked,
  finalPassed,
  ackUnlocked,
  onOpenModule,
  onOpenFinal,
  onOpenAck,
  onBypass,
}: {
  curriculum: Curriculum;
  state: LmsState;
  locale: Locale;
  finalUnlocked: boolean;
  finalPassed: boolean;
  ackUnlocked: boolean;
  onOpenModule: (id: string) => void;
  onOpenFinal: () => void;
  onOpenAck: () => void;
  onBypass: (moduleId: string) => Promise<void>;
}) {
  const isOwner = !!state.is_owner;
  const completed = state.progress
    .filter((p) => p.status === "passed")
    .map((p) => p.module_id);
  const totalModules = MODULE_ORDER.length;
  const passedCount = completed.filter((c) =>
    (MODULE_ORDER as readonly string[]).includes(c),
  ).length;
  const pct = Math.round((passedCount / totalModules) * 100);

  return (
    <div
      style={{
        maxWidth: 880,
        margin: "0 auto",
        padding: "26px 18px",
      }}
    >
      <div
        style={{
          marginBottom: 18,
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: "-0.015em",
              color: INK,
            }}
          >
            {curriculum.tenantName}{" "}
            {locale === "en" ? "Onboarding" : "Incorporación"}
          </div>
          <div style={{ fontSize: 13, color: INK_MUTE, marginTop: 4 }}>
            {locale === "en"
              ? "Complete each module in order. Quizzes need 80% to pass."
              : "Completa cada módulo en orden. Los exámenes requieren 80% para aprobar."}
          </div>
        </div>
        <div style={{ minWidth: 140 }}>
          <ProgressBar pct={pct} />
          <div
            style={{
              fontSize: 11,
              color: INK_LIGHT,
              marginTop: 4,
              textTransform: "uppercase",
              fontWeight: 700,
              letterSpacing: "0.08em",
            }}
          >
            {passedCount}/{totalModules}{" "}
            {locale === "en" ? "modules" : "módulos"}
          </div>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gap: 10,
        }}
      >
        {MODULE_ORDER.map((moduleId) => {
          const m = curriculum.modules.find((m) => m.id === moduleId);
          if (!m) return null;
          const progress = state.progress.find((p) => p.module_id === moduleId);
          const unlocked = state.unlocked[moduleId];
          const isAck = moduleId === "acknowledgment";
          const isContent = !QUIZ_MODULE_IDS.includes(moduleId as never) && !isAck;

          // The acknowledgment card has its own gating + handler
          const handler = isAck
            ? ackUnlocked
              ? onOpenAck
              : undefined
            : unlocked
            ? () => onOpenModule(moduleId)
            : undefined;

          return (
            <ModuleRow
              key={moduleId}
              module={m}
              locale={locale}
              status={progress?.status ?? "not_started"}
              bestScore={progress?.best_score ?? 0}
              attempts={progress?.attempts ?? 0}
              maxAttempts={MAX_MODULE_ATTEMPTS}
              unlocked={isAck ? ackUnlocked : !!unlocked}
              isQuizModule={!isContent && !isAck}
              isAck={isAck}
              isOwner={isOwner}
              onClick={handler}
              onBypass={
                !isAck && isOwner && progress?.status !== "passed"
                  ? () => onBypass(moduleId)
                  : undefined
              }
            />
          );
        })}
      </div>

      {/* Final mixed test card */}
      <div style={{ marginTop: 22 }}>
        <FinalStepCard
          locale={locale}
          unlocked={finalUnlocked}
          passed={finalPassed}
          attempts={
            state.progress.find((p) => p.module_id === FINAL_MODULE_ID)?.attempts ?? 0
          }
          maxAttempts={MAX_FINAL_ATTEMPTS}
          isOwner={isOwner}
          onClick={finalUnlocked && !finalPassed ? onOpenFinal : undefined}
          onBypass={
            isOwner && !finalPassed ? () => onBypass(FINAL_MODULE_ID) : undefined
          }
        />
      </div>
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div>
      <div
        style={{
          height: 8,
          width: "100%",
          background: LINE_SOFT,
          borderRadius: 999,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${clamped}%`,
            background: TEAL,
            transition: "width 240ms ease",
          }}
        />
      </div>
      <div
        style={{
          fontSize: 11,
          color: INK_MUTE,
          marginTop: 4,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {clamped}%
      </div>
    </div>
  );
}

function ModuleRow({
  module: m,
  locale,
  status,
  bestScore,
  attempts,
  maxAttempts,
  unlocked,
  isQuizModule,
  isAck,
  isOwner,
  onClick,
  onBypass,
}: {
  module: Module;
  locale: Locale;
  status: ModuleProgressRow["status"];
  bestScore: number;
  attempts: number;
  maxAttempts: number;
  unlocked: boolean;
  isQuizModule: boolean;
  isAck: boolean;
  isOwner: boolean;
  onClick?: () => void;
  onBypass?: () => void;
}) {
  const atCap = isQuizModule && status !== "passed" && attempts >= maxAttempts;
  const cta =
    status === "passed"
      ? tr("review_quiz", locale)
      : status === "failed"
      ? tr("retry_quiz", locale)
      : status === "in_progress"
      ? tr("resume_quiz", locale)
      : isQuizModule
      ? tr("start_quiz", locale)
      : tr("start", locale);

  const stripeColor =
    status === "passed" ? SUCCESS : isAck ? NAVY : unlocked ? TEAL : LINE;
  const effectiveOnClick = atCap && !isOwner ? undefined : onClick;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: 14,
        background: SURFACE,
        border: `1px solid ${atCap && !isOwner ? "#FECACA" : LINE}`,
        borderRadius: RADIUS,
        padding: "14px 16px",
        textAlign: "left",
        opacity: unlocked ? 1 : 0.5,
        fontFamily: FONT,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 4,
          background: stripeColor,
        }}
      />
      <div style={{ paddingLeft: 4 }}>
        <ModuleIcon kind={m.iconKind} size={44} />
      </div>
      <button
        type="button"
        onClick={effectiveOnClick}
        disabled={!unlocked || !effectiveOnClick}
        style={{
          minWidth: 0,
          background: "transparent",
          border: 0,
          padding: 0,
          margin: 0,
          textAlign: "left",
          cursor: unlocked && effectiveOnClick ? "pointer" : "default",
          fontFamily: FONT,
        }}
      >
        <div
          style={{
            fontWeight: 700,
            fontSize: 14,
            color: INK,
            letterSpacing: "-0.005em",
          }}
        >
          {m.title[locale]}
        </div>
        <div
          style={{
            fontSize: 12,
            color: INK_MUTE,
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {m.subtitle[locale]}
        </div>
        <div
          style={{
            fontSize: 11,
            color: INK_LIGHT,
            marginTop: 4,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          {m.estimatedMinutes} min
          {isQuizModule ? ` · ${tr("pass80", locale)}` : ""}
          {status === "passed" && bestScore > 0 ? ` · ${bestScore}%` : ""}
          {isQuizModule && status !== "passed" && !isOwner ? (
            <span
              style={{
                marginLeft: 6,
                color: atCap ? DANGER : INK_LIGHT,
              }}
            >
              · {attempts}/{maxAttempts} {tr("attempt", locale).toLowerCase()}
              {attempts === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        {atCap && !isOwner ? (
          <div
            style={{
              fontSize: 11,
              color: DANGER,
              marginTop: 4,
              fontWeight: 700,
            }}
          >
            {tr("noAttemptsLeft", locale)}
          </div>
        ) : null}
      </button>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: status === "passed" ? SUCCESS : unlocked ? NAVY : INK_LIGHT,
          fontSize: 12,
          fontWeight: 700,
          whiteSpace: "nowrap",
        }}
      >
        {status === "passed" ? (
          <>
            <CircleCheck size={14} />
            {tr("passed", locale)}
          </>
        ) : !unlocked ? (
          <>
            <Lock size={14} />
            {tr("locked", locale)}
          </>
        ) : atCap && !isOwner ? (
          <>
            <Lock size={14} />
            {tr("locked", locale)}
          </>
        ) : (
          <button
            type="button"
            onClick={effectiveOnClick}
            disabled={!effectiveOnClick}
            style={{
              background: "transparent",
              border: 0,
              color: NAVY,
              cursor: effectiveOnClick ? "pointer" : "default",
              fontWeight: 700,
              fontSize: 12,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontFamily: FONT,
              padding: 0,
            }}
          >
            {cta} <ChevronRight size={14} />
          </button>
        )}
        {onBypass ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onBypass();
            }}
            title={tr("bypassOwner", locale)}
            style={{
              marginLeft: 8,
              background: "#EEF2F8",
              color: NAVY,
              border: `1px solid ${LINE}`,
              padding: "5px 10px",
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 800,
              cursor: "pointer",
              fontFamily: FONT,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              whiteSpace: "nowrap",
            }}
          >
            <FastForward size={11} /> {tr("bypassOwner", locale)}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FinalStepCard({
  locale,
  unlocked,
  passed,
  attempts,
  maxAttempts,
  isOwner,
  onClick,
  onBypass,
}: {
  locale: Locale;
  unlocked: boolean;
  passed: boolean;
  attempts: number;
  maxAttempts: number;
  isOwner: boolean;
  onClick?: () => void;
  onBypass?: () => void;
}) {
  const atCap = !passed && attempts >= maxAttempts;
  const effectiveOnClick = atCap && !isOwner ? undefined : onClick;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: 14,
        background: passed ? "#ECFDF5" : NAVY,
        color: passed ? SUCCESS : "#fff",
        border: `1px solid ${passed ? SUCCESS : NAVY}`,
        borderRadius: RADIUS,
        padding: "16px 18px",
        textAlign: "left",
        opacity: unlocked ? 1 : 0.55,
        fontFamily: FONT,
      }}
    >
      <Award size={28} />
      <button
        type="button"
        onClick={effectiveOnClick}
        disabled={!unlocked || passed || !effectiveOnClick}
        style={{
          background: "transparent",
          color: "inherit",
          border: 0,
          padding: 0,
          margin: 0,
          textAlign: "left",
          cursor: unlocked && !passed && effectiveOnClick ? "pointer" : "default",
          fontFamily: FONT,
        }}
      >
        <div style={{ fontWeight: 800, fontSize: 14 }}>
          {tr("finalTest", locale)}
        </div>
        <div
          style={{
            fontSize: 12,
            opacity: 0.85,
            marginTop: 3,
          }}
        >
          {tr("finalIntro", locale)}
        </div>
        {!passed && !isOwner ? (
          <div
            style={{
              fontSize: 11,
              marginTop: 6,
              fontWeight: 700,
              opacity: 0.9,
              color: atCap ? "#FCA5A5" : "inherit",
            }}
          >
            {attempts}/{maxAttempts} {tr("attempt", locale).toLowerCase()}
            {attempts === 1 ? "" : "s"}
            {atCap ? ` · ${tr("noAttemptsLeft", locale)}` : ""}
          </div>
        ) : null}
      </button>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontWeight: 800,
          fontSize: 12,
          whiteSpace: "nowrap",
        }}
      >
        {passed ? (
          <>
            <CircleCheck size={14} style={{ verticalAlign: "middle" }} />{" "}
            {tr("passed", locale)}
          </>
        ) : !unlocked ? (
          <>
            <Lock size={14} style={{ verticalAlign: "middle" }} />{" "}
            {tr("locked", locale)}
          </>
        ) : atCap && !isOwner ? (
          <>
            <Lock size={14} style={{ verticalAlign: "middle" }} />{" "}
            {tr("locked", locale)}
          </>
        ) : (
          <button
            type="button"
            onClick={effectiveOnClick}
            disabled={!effectiveOnClick}
            style={{
              background: "transparent",
              color: "#fff",
              border: 0,
              cursor: effectiveOnClick ? "pointer" : "default",
              fontWeight: 800,
              fontSize: 12,
              padding: 0,
              fontFamily: FONT,
            }}
          >
            {tr("start", locale)}{" "}
            <ChevronRight size={14} style={{ verticalAlign: "middle" }} />
          </button>
        )}
        {onBypass ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onBypass();
            }}
            style={{
              background: "rgba(255,255,255,0.15)",
              color: "#fff",
              border: `1px solid rgba(255,255,255,0.3)`,
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
            <FastForward size={11} /> {tr("bypassOwner", locale)}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Module reading view
// ─────────────────────────────────────────────────────────────────────────────

function ModuleView({
  module: m,
  locale,
  isQuizModule,
  progress,
  isOwner,
  onBack,
  onTakeQuiz,
  onAcknowledge,
  onBypass,
  onStart,
}: {
  module: Module;
  locale: Locale;
  isQuizModule: boolean;
  progress: ModuleProgressRow | null;
  isOwner: boolean;
  onBack: () => void;
  onTakeQuiz: () => void;
  onAcknowledge: () => void;
  onBypass: () => void;
  onStart: () => void;
}) {
  const attempts = progress?.attempts ?? 0;
  const maxAttempts = MAX_MODULE_ATTEMPTS;
  const status = progress?.status ?? "not_started";
  const atCap = isQuizModule && status !== "passed" && attempts >= maxAttempts;
  const quizCta =
    status === "passed"
      ? tr("review_quiz", locale)
      : status === "failed"
      ? tr("retry_quiz", locale)
      : status === "in_progress"
      ? tr("resume_quiz", locale)
      : tr("start_quiz", locale);
  useEffect(() => {
    onStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id]);
  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "20px 18px" }}>
      <BackLink label={tr("back", locale)} onClick={onBack} />
      <article
        style={{
          background: SURFACE,
          border: `1px solid ${LINE}`,
          borderRadius: RADIUS,
          padding: 22,
          marginTop: 14,
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}
        >
          <ModuleIcon kind={m.iconKind} size={56} />
          <div>
            <div style={{ fontWeight: 800, fontSize: 18, color: INK }}>
              {m.title[locale]}
            </div>
            <div
              style={{
                fontSize: 12,
                color: INK_MUTE,
                marginTop: 2,
              }}
            >
              {m.subtitle[locale]} · {m.estimatedMinutes} min
            </div>
          </div>
        </div>
        {m.blocks.map((b, i) => (
          <Block key={i} block={b} locale={locale} />
        ))}
        {isQuizModule ? (
          <div
            style={{
              marginTop: 18,
              padding: "10px 12px",
              background: atCap && !isOwner ? "#FEF2F2" : LINE_SOFT,
              border: `1px solid ${atCap && !isOwner ? "#FECACA" : LINE}`,
              borderRadius: 8,
              fontSize: 12,
              color: atCap && !isOwner ? DANGER : INK_MUTE,
              fontWeight: 700,
              display: "flex",
              justifyContent: "space-between",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <span>
              {tr("attempt", locale)} {Math.min(attempts + 1, maxAttempts)}{" "}
              {tr("of", locale)} {maxAttempts}
              {progress?.best_score
                ? ` · ${locale === "en" ? "best" : "mejor"}: ${progress.best_score}%`
                : ""}
            </span>
            <span>
              {atCap && !isOwner
                ? tr("noAttemptsLeft", locale)
                : `${Math.max(0, maxAttempts - attempts)} ${tr("attemptsRemaining", locale)}`}
            </span>
          </div>
        ) : null}
        <div
          style={{
            marginTop: 22,
            display: "flex",
            gap: 10,
            justifyContent: "flex-end",
            flexWrap: "wrap",
          }}
        >
          {isOwner && status !== "passed" ? (
            <SecondaryButton onClick={onBypass}>
              <FastForward size={14} /> {tr("bypassOwner", locale)}
            </SecondaryButton>
          ) : null}
          {isQuizModule ? (
            <PrimaryButton
              onClick={onTakeQuiz}
              disabled={atCap && !isOwner}
            >
              {quizCta}
              <ChevronRight size={14} style={{ marginLeft: 4 }} />
            </PrimaryButton>
          ) : (
            <PrimaryButton onClick={onAcknowledge}>
              {tr("acknowledge", locale)}
              <Check size={14} style={{ marginLeft: 4 }} />
            </PrimaryButton>
          )}
        </div>
      </article>
    </div>
  );
}

function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: "transparent",
        border: 0,
        color: INK_MUTE,
        cursor: "pointer",
        fontFamily: FONT,
        fontSize: 13,
        fontWeight: 700,
        padding: 0,
      }}
    >
      <ArrowLeft size={14} />
      {label}
    </button>
  );
}

function Block({ block: b, locale }: { block: ContentBlock; locale: Locale }) {
  if (b.type === "p") {
    return (
      <p
        style={{
          fontSize: 14,
          color: INK,
          lineHeight: 1.65,
          margin: "10px 0",
        }}
      >
        {b.text[locale]}
      </p>
    );
  }
  if (b.type === "h") {
    return (
      <h3
        style={{
          fontSize: 14,
          color: INK,
          fontWeight: 800,
          margin: "18px 0 6px 0",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {b.text[locale]}
      </h3>
    );
  }
  if (b.type === "bullets") {
    return (
      <ul
        style={{
          margin: "10px 0",
          paddingLeft: 18,
          color: INK,
          fontSize: 14,
          lineHeight: 1.65,
        }}
      >
        {b.items.map((it, i) => (
          <li key={i} style={{ marginBottom: 4 }}>
            {it[locale]}
          </li>
        ))}
      </ul>
    );
  }
  if (b.type === "callout") {
    const tone =
      b.tone === "warning"
        ? { color: WARN, bg: "#FFFBEB", border: "#FDE68A", Icon: AlertTriangle }
        : b.tone === "success"
        ? { color: SUCCESS, bg: "#ECFDF5", border: "#A7F3D0", Icon: CircleCheck }
        : { color: TEAL, bg: "#ECFEFF", border: "#A5F3FC", Icon: Info };
    const Icon = tone.Icon;
    return (
      <div
        style={{
          display: "flex",
          gap: 10,
          background: tone.bg,
          border: `1px solid ${tone.border}`,
          borderLeft: `3px solid ${tone.color}`,
          padding: 12,
          borderRadius: 6,
          margin: "12px 0",
        }}
      >
        <Icon size={16} style={{ color: tone.color, flexShrink: 0, marginTop: 2 }} />
        <div style={{ fontSize: 13.5, color: INK, lineHeight: 1.55 }}>
          {b.text[locale]}
        </div>
      </div>
    );
  }
  if (b.type === "table") {
    return (
      <div
        style={{
          margin: "12px 0",
          overflowX: "auto",
          border: `1px solid ${LINE}`,
          borderRadius: 6,
        }}
      >
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 13,
            fontFamily: FONT,
          }}
        >
          <thead style={{ background: LINE_SOFT }}>
            <tr>
              {b.head[locale].map((h, i) => (
                <th
                  key={i}
                  style={{
                    padding: 8,
                    textAlign: "left",
                    fontWeight: 700,
                    color: INK,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, i) => (
              <tr key={i}>
                {r[locale].map((c, j) => (
                  <td
                    key={j}
                    style={{
                      padding: 8,
                      borderTop: `1px solid ${LINE}`,
                      color: INK,
                    }}
                  >
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quiz view (per-module AND final mixed test) with autosave
// ─────────────────────────────────────────────────────────────────────────────

function QuizView({
  curriculum,
  moduleId,
  locale,
  token,
  priorAttempts,
  onCancel,
  onPassed,
}: {
  curriculum: Curriculum;
  moduleId: string;
  locale: Locale;
  token: string | null;
  priorAttempts: number;
  onCancel: () => void;
  onPassed: () => Promise<void>;
}) {
  const isFinal = moduleId === FINAL_MODULE_ID;
  const maxAttempts = maxAttemptsFor(moduleId);
  const [questionIds, setQuestionIds] = useState<string[]>([]);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [cursor, setCursor] = useState(0);
  const [resumeReady, setResumeReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load (or initialize) the quiz state from server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await lmsApi.getQuizState(token, moduleId);
        if (cancelled) return;
        if (existing) {
          // Resume.
          setQuestionIds(
            existing.meta?.question_ids ??
              fixedQuestionIds(curriculum, moduleId),
          );
          setAnswers(existing.answers ?? []);
          setCursor(existing.current_question_index ?? 0);
          setResumeReady(true);
          return;
        }
        // Initialize.
        let qids: string[];
        if (isFinal) {
          // Final mixed test: client samples from the curriculum bank — the
          // first call to /quiz/state will persist this set so resume sees
          // the same questions.
          qids = sampleClient(
            curriculum.quiz.map((q) => q.id),
            15,
          );
        } else {
          qids = fixedQuestionIds(curriculum, moduleId);
        }
        setQuestionIds(qids);
        setAnswers(new Array(qids.length).fill(null));
        setCursor(0);
        setResumeReady(true);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleId]);

  // Debounced autosave on every (cursor, answers) change.
  useEffect(() => {
    if (!resumeReady) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      lmsApi
        .saveQuizState(token, moduleId, cursor, answers, questionIds)
        .catch(() => {
          /* surface in console only — autosave failure shouldn't UI-block */
        });
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [cursor, answers, questionIds, resumeReady, token, moduleId]);

  const questions = useMemo(() => {
    return questionIds.map((qid) =>
      curriculum.quiz.find((q) => q.id === qid),
    );
  }, [questionIds, curriculum.quiz]);

  if (!resumeReady) {
    return (
      <div style={{ padding: 60, textAlign: "center", color: INK_MUTE }}>
        <Loader2 className="qleno-spin" size={20} />
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ maxWidth: 480, margin: "40px auto", color: DANGER }}>
        {error}
      </div>
    );
  }
  if (result) {
    const attemptsRemaining =
      result.attempts_remaining ??
      Math.max(0, maxAttempts - (result.attempts_used ?? priorAttempts + 1));
    return (
      <ResultView
        locale={locale}
        result={result}
        attemptsRemaining={attemptsRemaining}
        maxAttempts={result.max_attempts ?? maxAttempts}
        passThreshold={PASS_THRESHOLD_PCT}
        onContinue={async () => {
          if (result.passed) {
            await onPassed();
          } else if (attemptsRemaining > 0) {
            // Reset for retry — also clear server state so cross-device
            // resume starts from a blank slate (server already deletes the
            // row after every submit; this is belt-and-suspenders).
            setAnswers(new Array(questionIds.length).fill(null));
            setCursor(0);
            setResult(null);
          } else {
            // No retries left — bounce back home.
            onCancel();
          }
        }}
      />
    );
  }

  const q = questions[cursor];
  const total = questionIds.length;
  if (!q) {
    return (
      <div style={{ padding: 60, textAlign: "center", color: INK_MUTE }}>
        {locale === "en" ? "Question not found." : "Pregunta no encontrada."}
      </div>
    );
  }

  const setAnswer = (idx: number) => {
    setAnswers((prev) => {
      const next = [...prev];
      next[cursor] = idx;
      return next;
    });
  };

  const allAnswered = answers.length === total && answers.every((a) => a != null);

  const currentAttempt = Math.min(priorAttempts + 1, maxAttempts);
  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "20px 18px" }}>
      <BackLink label={tr("back", locale)} onClick={onCancel} />
      <div style={{ marginTop: 14 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: INK_LIGHT,
              fontWeight: 800,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            {isFinal
              ? tr("finalTest", locale)
              : curriculum.modules.find((m) => m.id === moduleId)?.title[locale] ??
                moduleId}
            {" · "}
            {cursor + 1} / {total}
          </div>
          <div
            style={{
              fontSize: 11,
              color: INK_MUTE,
              fontWeight: 800,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              background: LINE_SOFT,
              padding: "3px 8px",
              borderRadius: 999,
            }}
          >
            {tr("attempt", locale)} {currentAttempt} {tr("of", locale)} {maxAttempts}
          </div>
        </div>
        <div
          style={{
            background: SURFACE,
            border: `1px solid ${LINE}`,
            borderRadius: RADIUS,
            padding: 22,
            marginTop: 8,
          }}
        >
          <div
            style={{
              fontSize: 16,
              color: INK,
              fontWeight: 700,
              lineHeight: 1.45,
            }}
          >
            {q.prompt[locale]}
          </div>
          <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
            {q.options.map((opt, i) => {
              const selected = answers[cursor] === i;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setAnswer(i)}
                  style={{
                    textAlign: "left",
                    background: selected ? "#EEF2F8" : SURFACE,
                    border: `1px solid ${selected ? NAVY : LINE}`,
                    borderRadius: 8,
                    padding: "12px 14px",
                    fontFamily: FONT,
                    color: INK,
                    cursor: "pointer",
                    fontSize: 14,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 999,
                      border: `2px solid ${selected ? NAVY : LINE}`,
                      background: selected ? NAVY : "transparent",
                      flexShrink: 0,
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    {selected && <Check size={10} color="#fff" />}
                  </span>
                  {opt[locale]}
                </button>
              );
            })}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 18,
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <SecondaryButton
              onClick={() => setCursor((c) => Math.max(0, c - 1))}
            >
              <ChevronLeft size={14} /> {tr("back", locale)}
            </SecondaryButton>
            {cursor < total - 1 ? (
              <PrimaryButton
                onClick={() => setCursor((c) => Math.min(total - 1, c + 1))}
                disabled={answers[cursor] == null}
              >
                {tr("next", locale)} <ChevronRight size={14} />
              </PrimaryButton>
            ) : (
              <PrimaryButton
                disabled={busy || !allAnswered}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await lmsApi.submitQuiz(
                      token,
                      moduleId,
                      answers,
                      questionIds,
                    );
                    setResult(r);
                  } catch (e) {
                    setError(String((e as Error).message));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? (
                  <Loader2 size={14} className="qleno-spin" />
                ) : (
                  tr("submit", locale)
                )}
              </PrimaryButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function fixedQuestionIds(curriculum: Curriculum, moduleId: string): string[] {
  const fromShared = QUESTIONS_BY_MODULE[
    moduleId as keyof typeof QUESTIONS_BY_MODULE
  ];
  if (fromShared) return [...fromShared];
  // Fallback: derive from curriculum.quiz by moduleId match.
  return curriculum.quiz.filter((q) => q.moduleId === moduleId).map((q) => q.id);
}

function sampleClient(pool: string[], n: number): string[] {
  const arr = [...pool];
  const out: string[] = [];
  const take = Math.min(n, arr.length);
  for (let i = 0; i < take; i++) {
    const j = Math.floor(Math.random() * arr.length);
    out.push(arr.splice(j, 1)[0]);
  }
  return out;
}

function ResultView({
  locale,
  result,
  attemptsRemaining,
  maxAttempts,
  passThreshold,
  onContinue,
}: {
  locale: Locale;
  result: SubmitResult;
  attemptsRemaining: number;
  maxAttempts: number;
  passThreshold: number;
  onContinue: () => void;
}) {
  const { passed, score } = result;
  const noMoreRetries = !passed && attemptsRemaining <= 0;
  return (
    <div style={{ maxWidth: 480, margin: "60px auto", padding: 18 }}>
      <div
        style={{
          background: SURFACE,
          border: `1px solid ${LINE}`,
          borderRadius: RADIUS,
          padding: 26,
          textAlign: "center",
        }}
      >
        {passed ? (
          <CircleCheck size={42} style={{ color: SUCCESS }} />
        ) : (
          <X size={42} style={{ color: DANGER }} />
        )}
        <div style={{ fontWeight: 800, fontSize: 22, marginTop: 8, color: INK }}>
          {passed ? tr("passed", locale) : tr("failed", locale)}
        </div>
        <div style={{ marginTop: 8, fontSize: 13, color: INK_MUTE }}>
          {score}% · {passThreshold}% {locale === "en" ? "to pass" : "para aprobar"}
        </div>
        {!passed ? (
          <div
            style={{
              marginTop: 10,
              fontSize: 12,
              fontWeight: 700,
              color: noMoreRetries ? DANGER : INK_MUTE,
            }}
          >
            {noMoreRetries
              ? tr("noAttemptsLeft", locale)
              : `${attemptsRemaining} ${tr("attemptsRemaining", locale)} (${
                  maxAttempts - attemptsRemaining
                }/${maxAttempts} ${tr("attemptsUsed", locale)})`}
          </div>
        ) : null}
        <div style={{ marginTop: 18 }}>
          <PrimaryButton onClick={onContinue}>
            {passed
              ? tr("next", locale)
              : noMoreRetries
              ? tr("back", locale)
              : tr("retry", locale)}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Final intro card (one-screen explainer before the timed-feel run)
// ─────────────────────────────────────────────────────────────────────────────

function FinalIntroView({
  locale,
  onStart,
  onCancel,
}: {
  locale: Locale;
  onStart: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ maxWidth: 560, margin: "40px auto", padding: 18 }}>
      <BackLink label={tr("back", locale)} onClick={onCancel} />
      <div
        style={{
          background: SURFACE,
          border: `1px solid ${LINE}`,
          borderRadius: RADIUS,
          padding: 26,
          marginTop: 14,
        }}
      >
        <Award size={36} style={{ color: NAVY }} />
        <div style={{ fontWeight: 800, fontSize: 20, marginTop: 8, color: INK }}>
          {tr("finalTest", locale)}
        </div>
        <div
          style={{
            fontSize: 13,
            color: INK_MUTE,
            marginTop: 6,
            lineHeight: 1.55,
          }}
        >
          {tr("finalIntro", locale)}
        </div>
        <div
          style={{
            marginTop: 18,
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <PrimaryButton onClick={onStart}>
            {tr("start", locale)} <ChevronRight size={14} />
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Acknowledgment view — typed signature
// ─────────────────────────────────────────────────────────────────────────────

function AckView({
  locale,
  tenantName,
  learner,
  onCancel,
  onSubmit,
}: {
  locale: Locale;
  tenantName: string;
  learner: Learner;
  onCancel: () => void;
  onSubmit: (signature: string) => Promise<void>;
}) {
  const suggested = `${learner.firstName} ${learner.lastName}`.trim();
  const [name, setName] = useState(suggested);
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ maxWidth: 560, margin: "40px auto", padding: 18 }}>
      <BackLink label={tr("back", locale)} onClick={onCancel} />
      <div
        style={{
          background: SURFACE,
          border: `1px solid ${LINE}`,
          borderRadius: RADIUS,
          padding: 26,
          marginTop: 14,
        }}
      >
        <div style={{ fontWeight: 800, fontSize: 20, color: INK }}>
          {tenantName} · {locale === "en" ? "Acknowledgment" : "Confirmación"}
        </div>
        <div
          style={{
            fontSize: 13,
            color: INK_MUTE,
            marginTop: 8,
            lineHeight: 1.55,
          }}
        >
          {tr("ackPrompt", locale)}
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={tr("yourName", locale)}
          aria-label={tr("yourName", locale)}
          style={{
            width: "100%",
            marginTop: 14,
            padding: "10px 12px",
            border: `1px solid ${LINE}`,
            borderRadius: 8,
            fontSize: 15,
            fontFamily: FONT,
            color: INK,
          }}
        />
        <div
          style={{
            marginTop: 18,
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <PrimaryButton
            disabled={busy || name.trim().length < 2}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(name.trim());
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? (
              <Loader2 size={14} className="qleno-spin" />
            ) : (
              tr("acknowledge", locale)
            )}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Done view
// ─────────────────────────────────────────────────────────────────────────────

function DoneView({
  locale,
  tenantName,
  onReturnHome,
}: {
  locale: Locale;
  tenantName: string;
  onReturnHome: () => void;
}) {
  return (
    <div style={{ maxWidth: 560, margin: "60px auto", padding: 18 }}>
      <div
        style={{
          background: SURFACE,
          border: `1px solid ${LINE}`,
          borderRadius: RADIUS,
          padding: 32,
          textAlign: "center",
        }}
      >
        <Award size={42} style={{ color: SUCCESS }} />
        <div style={{ fontWeight: 800, fontSize: 22, marginTop: 8, color: INK }}>
          {tr("doneTitle", locale)}
        </div>
        <div style={{ fontSize: 13, color: INK_MUTE, marginTop: 6 }}>
          {tenantName} — {tr("doneSub", locale)}
        </div>
        <div style={{ marginTop: 18 }}>
          <PrimaryButton onClick={onReturnHome}>
            {locale === "en" ? "Return home" : "Volver al inicio"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Buttons + module icon (compact reproductions of the prior visual primitives)
// ─────────────────────────────────────────────────────────────────────────────

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: disabled ? INK_LIGHT : NAVY,
        color: "#fff",
        border: 0,
        padding: "10px 16px",
        borderRadius: 8,
        fontWeight: 700,
        fontFamily: FONT,
        fontSize: 13,
        cursor: disabled ? "default" : "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        transition: "background 120ms",
      }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLButtonElement).style.background = NAVY_HOV;
      }}
      onMouseLeave={(e) => {
        if (!disabled) (e.currentTarget as HTMLButtonElement).style.background = NAVY;
      }}
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "transparent",
        color: INK_MUTE,
        border: `1px solid ${LINE}`,
        padding: "10px 14px",
        borderRadius: 8,
        fontWeight: 700,
        fontFamily: FONT,
        fontSize: 13,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      {children}
    </button>
  );
}

function ModuleIcon({ kind, size = 44 }: { kind: IconKind; size?: number }) {
  // Compact reproductions of the prior icon set. Visual fidelity is not
  // critical here — what matters is each module has a recognizable mark.
  const stroke = NAVY;
  const fill = "#EEF2F8";
  const accent = TEAL;
  const props = { width: size, height: size, viewBox: "0 0 64 64", fill: "none" } as const;

  switch (kind) {
    case "house":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <path
            d="M16 30 L32 18 L48 30 L48 46 Q48 48 46 48 L18 48 Q16 48 16 46 Z"
            stroke={stroke}
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
          <circle cx="42" cy="20" r="3" fill={accent} />
        </svg>
      );
    case "clock":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <circle cx="32" cy="32" r="14" stroke={stroke} strokeWidth="2.4" />
          <path d="M32 23 L32 32 L39 36" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="46" cy="18" r="3" fill={accent} />
        </svg>
      );
    case "uniform":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <path
            d="M22 18 L26 16 L32 22 L38 16 L42 18 L46 28 L40 28 L40 46 L24 46 L24 28 L18 28 Z"
            stroke={stroke}
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "money":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <circle cx="32" cy="32" r="14" stroke={stroke} strokeWidth="2.4" />
          <line x1="32" y1="22" x2="32" y2="42" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      );
    case "flow":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <rect x="14" y="14" width="36" height="36" rx="3" stroke={stroke} strokeWidth="2.4" />
          <path
            d="M22 18 L22 46 M30 46 L46 46"
            stroke={accent}
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </svg>
      );
    case "spray":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <rect x="30" y="18" width="6" height="6" stroke={stroke} strokeWidth="2.4" />
          <path
            d="M28 24 L36 24 L40 30 L40 46 Q40 48 38 48 L26 48 Q24 48 24 46 L24 30 Z"
            stroke={stroke}
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "pin":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <path
            d="M32 14 Q42 14 42 24 Q42 32 32 48 Q22 32 22 24 Q22 14 32 14 Z"
            stroke={stroke}
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
          <circle cx="32" cy="24" r="4" fill={accent} />
        </svg>
      );
    case "sparkle":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <path
            d="M32 16 L34 28 L46 30 L34 32 L32 44 L30 32 L18 30 L30 28 Z"
            stroke={stroke}
            strokeWidth="2.2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "shield":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <path
            d="M32 14 L46 20 L46 32 Q46 42 32 50 Q18 42 18 32 L18 20 Z"
            stroke={stroke}
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
          <path
            d="M26 32 L30 36 L40 26"
            stroke={accent}
            strokeWidth="2.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Responsive + spinner styles
// ─────────────────────────────────────────────────────────────────────────────

function ResponsiveStyles() {
  return (
    <style>{`
      @keyframes qleno-spin { to { transform: rotate(360deg); } }
      .qleno-spin { animation: qleno-spin 1s linear infinite; }
      @media (max-width: 640px) {
        button, input { font-size: 14px !important; }
      }
    `}</style>
  );
}
