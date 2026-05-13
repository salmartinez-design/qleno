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
  shouldShowLearnerGating,
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
  Download,
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
  /**
   * PR #4 policy: standalone signed acknowledgments that the learner
   * still owes before the final mixed test unlocks. Drives the locked
   * state + "sign these first" hint on the FinalStepCard.
   */
  missing_required_signed_docs?: string[];
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
  certificate_id?: number | null;
};

type View =
  | { kind: "home" }
  | { kind: "module"; moduleId: string }
  | { kind: "quiz"; moduleId: string }
  | { kind: "sign-document"; documentType: string }
  | { kind: "onboarding-intake" }
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
    api<{ ok: true; enrollment_id: number; certificate_id: number | null }>(
      "POST",
      "/lms/admin/bypass-module",
      token,
      { moduleId },
    ),
  listMyCertificates: (token: string | null) =>
    api<CertificateRow[]>("GET", "/lms/certificates/me", token),
  getSignedDocumentContent: (
    token: string | null,
    documentType: string,
    locale: Locale,
  ) =>
    api<SignedDocumentContent>(
      "GET",
      `/lms/signatures/content?documentType=${encodeURIComponent(
        documentType,
      )}&locale=${locale}`,
      token,
    ),
  signDocument: (
    token: string | null,
    args: {
      documentType: string;
      locale: Locale;
      signatureMethod: "drawn" | "typed";
      signature: string;
    },
  ) =>
    api<{
      id: number;
      document_type: string;
      locale: Locale;
      version_hash: string;
      signed_at: string;
      requires_co_sign: boolean;
    }>("POST", "/lms/signatures/sign", token, {
      ...args,
      affirmation: true,
    }),
  listMySignedDocuments: (token: string | null) =>
    api<SignedDocumentRow[]>("GET", "/lms/signatures/me", token),
};

type SignedDocumentContent = {
  documentType: string;
  locale: Locale;
  title: string;
  contentHtml: string;
  pendingTranslationReview: boolean;
};

type SignedDocumentRow = {
  id: number;
  document_type: string;
  locale: string;
  signed_at: string;
  status: "active" | "superseded" | "revoked";
  version_hash: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Certificate download — opens the PDF in a new tab. The auth header is
// passed via fetch + blob conversion so the cert id can stay in a same-
// origin URL even when the API runs under /api/.
// ─────────────────────────────────────────────────────────────────────────────

type CertificateRow = {
  id: number;
  module_id: string;
  score: number | null;
  passed: boolean;
  issued_at: string;
  locale: string;
  revoked_at: string | null;
};

async function downloadCertificatePdf(
  token: string | null,
  certificateId: number,
): Promise<void> {
  const url = `${API_BASE}/lms/certificates/${certificateId}/pdf`;
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GET /lms/certificates/${certificateId}/pdf → ${res.status}: ${text}`,
    );
  }
  const blob = await res.blob();
  const dispositionHeader = res.headers.get("content-disposition") ?? "";
  const filenameMatch = /filename="([^"]+)"/.exec(dispositionHeader);
  const filename = filenameMatch?.[1] ?? `phes-certificate-${certificateId}.pdf`;
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

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
  downloadCert: { en: "Certificate", es: "Certificado" },
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
  const [certificates, setCertificates] = useState<CertificateRow[]>([]);
  const [signedDocs, setSignedDocs] = useState<SignedDocumentRow[]>([]);

  const curriculum = useMemo<Curriculum>(
    () => getCurriculum(learner?.companyId ?? null),
    [learner?.companyId],
  );

  /** module_id → most recent ACTIVE certificate id (revoked rows skipped). */
  const certByModule = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    // certificates are listed newest-first by the server, so the first
    // non-revoked one per module wins.
    for (const c of certificates) {
      if (c.revoked_at) continue;
      if (!(c.module_id in map)) map[c.module_id] = c.id;
    }
    return map;
  }, [certificates]);

  /** document_type → most recent ACTIVE signed_document id. */
  const signedDocByType = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const d of signedDocs) {
      if (d.status !== "active") continue;
      if (!(d.document_type in map)) map[d.document_type] = d.id;
    }
    return map;
  }, [signedDocs]);

  const refresh = useCallback(async () => {
    try {
      const [next, certs, docs] = await Promise.all([
        lmsApi.me(token),
        lmsApi.listMyCertificates(token).catch(() => [] as CertificateRow[]),
        lmsApi
          .listMySignedDocuments(token)
          .catch(() => [] as SignedDocumentRow[]),
      ]);
      setState(next);
      setCertificates(certs);
      setSignedDocs(docs);
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
          tenantLogoUrl={curriculum.tenantLogoUrl}
          locale={locale}
          setLocale={setLocale}
          daysRemaining={state?.days_remaining ?? null}
          isOwner={!!state?.is_owner}
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
        tenantLogoUrl={curriculum.tenantLogoUrl}
        locale={locale}
        setLocale={setLocale}
        daysRemaining={state.days_remaining}
        isOwner={!!state.is_owner}
      />
      {view.kind === "home" && (
        <Home
          curriculum={curriculum}
          state={state}
          locale={locale}
          finalUnlocked={finalUnlocked}
          finalPassed={finalPassed}
          ackUnlocked={ackUnlocked}
          certByModule={certByModule}
          signedDocByType={signedDocByType}
          onOpenModule={(moduleId) => setView({ kind: "module", moduleId })}
          onOpenFinal={() => setView({ kind: "final-intro" })}
          onOpenAck={() => setView({ kind: "ack" })}
          onOpenSign={(documentType) =>
            setView({ kind: "sign-document", documentType })
          }
          onOpenOnboardingIntake={() => setView({ kind: "onboarding-intake" })}
          onBypass={async (moduleId) => {
            await lmsApi.bypassModule(token, moduleId);
            await refresh();
          }}
          onDownloadCert={(certId) => downloadCertificatePdf(token, certId)}
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
          isOwner={!!state.is_owner}
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
          isOwner={!!state.is_owner}
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
      {view.kind === "sign-document" && (
        <SignDocumentView
          documentType={view.documentType}
          locale={locale}
          setLocale={setLocale}
          learner={learner}
          token={token}
          onCancel={() => setView({ kind: "home" })}
          onSigned={async () => {
            await refresh();
            setView({ kind: "home" });
          }}
        />
      )}
      {view.kind === "onboarding-intake" && (
        <OnboardingIntakeView
          locale={locale}
          token={token}
          onCancel={() => setView({ kind: "home" })}
          onSaved={() => setView({ kind: "home" })}
        />
      )}
      <ResponsiveStyles />
    </PageShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page shell + header + locale + countdown
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Viewport-based mobile flag. Used to swap dense 3-column module layouts for
 * a vertically-stacked single-column variant under 640px (Phes mobile audit
 * 2026-05-12). Same pattern as lms-admin.tsx's useViewportIsMobile.
 */
const LMS_MOBILE_BREAKPOINT = 640;
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      window.innerWidth < LMS_MOBILE_BREAKPOINT,
  );
  useEffect(() => {
    const onResize = () =>
      setIsMobile(window.innerWidth < LMS_MOBILE_BREAKPOINT);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile;
}

// shouldShowLearnerGating(isOwner) is imported from @workspace/lms-curriculum
// so the predicate has a single home and stays unit-tested. See the imports
// block at the top of this file.

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
  tenantLogoUrl,
  locale,
  setLocale,
  daysRemaining,
  isOwner = false,
}: {
  tenantName: string;
  tenantLogoUrl?: string;
  locale: Locale;
  setLocale: (l: Locale) => void;
  daysRemaining: number | null;
  isOwner?: boolean;
}) {
  const isMobile = useIsMobile();
  return (
    <header
      style={{
        background: SURFACE,
        borderBottom: `1px solid ${LINE}`,
        padding: isMobile ? "14px 16px" : "18px 22px",
        display: "flex",
        flexDirection: isMobile ? "column" : "row",
        justifyContent: "space-between",
        alignItems: isMobile ? "stretch" : "center",
        gap: isMobile ? 10 : 14,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: isMobile ? 10 : 14,
          minWidth: 0,
        }}
      >
        <QlenoLogo size={isMobile ? "md" : "lg"} theme="light" layout="horizontal" />
        <div
          style={{
            height: isMobile ? 26 : 36,
            width: 1,
            background: LINE,
            margin: "0 2px",
            flexShrink: 0,
          }}
          aria-hidden
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontWeight: 800,
              fontSize: isMobile ? 16 : 20,
              letterSpacing: "-0.02em",
              color: INK,
              lineHeight: 1.1,
            }}
          >
            <span>{tenantName}</span>
            {tenantLogoUrl ? (
              <img
                src={tenantLogoUrl}
                alt={tenantName}
                style={{
                  height: isMobile ? 36 : 48,
                  width: "auto",
                  objectFit: "contain",
                  flexShrink: 0,
                }}
              />
            ) : null}
          </div>
          <div
            style={{
              fontSize: 11,
              color: INK_LIGHT,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {tr("title", locale)}
          </div>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: isMobile ? 8 : 12,
          justifyContent: isMobile ? "flex-end" : "flex-start",
        }}
      >
        {daysRemaining != null && shouldShowLearnerGating(isOwner) && (
          <DeadlineBadge days={daysRemaining} locale={locale} />
        )}
        <LocaleToggle locale={locale} setLocale={setLocale} compact={isMobile} />
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
  compact = false,
}: {
  locale: Locale;
  setLocale: (l: Locale) => void;
  /** Compact mode renders 'EN' / 'ES' instead of 'ENGLISH' / 'ESPAÑOL'. Used on mobile. */
  compact?: boolean;
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
  const labelEn = compact ? "EN" : "ENGLISH";
  const labelEs = compact ? "ES" : "ESPAÑOL";
  const pad = compact ? "5px 10px" : "5px 12px";
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
        flexShrink: 0,
      }}
    >
      <Globe2
        size={14}
        style={{
          marginLeft: compact ? 6 : 8,
          marginRight: compact ? 2 : 4,
          color: INK_MUTE,
        }}
      />
      <button
        type="button"
        onClick={() => setLocale("en")}
        aria-label="English"
        style={{
          border: "none",
          padding: pad,
          borderRadius: 999,
          fontSize: 12,
          letterSpacing: "0.04em",
          cursor: "pointer",
          fontFamily: FONT,
          ...(locale === "en" ? activeStyle : inactiveStyle),
        }}
      >
        {labelEn}
      </button>
      <button
        type="button"
        onClick={() => setLocale("es")}
        aria-label="Español"
        style={{
          border: "none",
          padding: pad,
          borderRadius: 999,
          fontSize: 12,
          letterSpacing: "0.04em",
          cursor: "pointer",
          fontFamily: FONT,
          ...(locale === "es" ? activeStyle : inactiveStyle),
        }}
      >
        {labelEs}
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
  certByModule,
  signedDocByType,
  onOpenModule,
  onOpenFinal,
  onOpenAck,
  onOpenSign,
  onOpenOnboardingIntake,
  onBypass,
  onDownloadCert,
}: {
  curriculum: Curriculum;
  state: LmsState;
  locale: Locale;
  finalUnlocked: boolean;
  finalPassed: boolean;
  ackUnlocked: boolean;
  certByModule: Record<string, number>;
  signedDocByType: Record<string, number>;
  onOpenModule: (id: string) => void;
  onOpenFinal: () => void;
  onOpenAck: () => void;
  onOpenSign: (documentType: string) => void;
  onOpenOnboardingIntake: () => void;
  onBypass: (moduleId: string) => Promise<void>;
  onDownloadCert: (certId: number) => Promise<void>;
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

      <OnboardingIntakeTile
        locale={locale}
        onOpen={onOpenOnboardingIntake}
      />

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

          // The acknowledgment card has its own gating + handler.
          // Owners and admins can open any module to preview the content,
          // regardless of the sequential gate — they're not learners.
          const handler = isAck
            ? (ackUnlocked || isOwner)
              ? onOpenAck
              : undefined
            : (unlocked || isOwner)
            ? () => onOpenModule(moduleId)
            : undefined;

          const certId = certByModule[moduleId];
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
              certId={certId}
              onDownloadCert={onDownloadCert}
            />
          );
        })}
      </div>

      {/* Required signed acknowledgments. One tile per quiz module that
          has a registered signed-document type the learner still owes.
          Phase 3 PR #4 ships the first: drug-alcohol. PRs #5+ extend. */}
      {(() => {
        const passedModuleIds = new Set(completed);
        const tiles: Array<{
          moduleId: string;
          documentType: string;
          title: { en: string; es: string };
        }> = [
          {
            moduleId: "drug-alcohol",
            documentType: "drug_alcohol",
            title: {
              en: "Drug & Alcohol Policy",
              es: "Política de Drogas y Alcohol",
            },
          },
        ];
        const pending = tiles.filter(
          (t) =>
            passedModuleIds.has(t.moduleId) &&
            !(t.documentType in signedDocByType),
        );
        if (pending.length === 0) return null;
        return (
          <div style={{ marginTop: 22 }}>
            <div
              style={{
                fontSize: 11,
                color: INK_MUTE,
                fontWeight: 800,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: 8,
              }}
            >
              {locale === "es"
                ? "Reconocimientos firmados requeridos"
                : "Required Signed Acknowledgments"}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {pending.map((t) => (
                <button
                  key={t.documentType}
                  type="button"
                  onClick={() => onOpenSign(t.documentType)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr auto",
                    alignItems: "center",
                    gap: 14,
                    background: "#FFFBEB",
                    border: `1px solid #FDE68A`,
                    borderLeft: `4px solid ${WARN}`,
                    borderRadius: RADIUS,
                    padding: "14px 16px",
                    textAlign: "left",
                    cursor: "pointer",
                    fontFamily: FONT,
                  }}
                >
                  <AlertTriangle size={20} style={{ color: WARN }} />
                  <div>
                    <div
                      style={{
                        fontWeight: 800,
                        fontSize: 14,
                        color: INK,
                      }}
                    >
                      {t.title[locale]}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: INK_MUTE,
                        marginTop: 2,
                      }}
                    >
                      {locale === "es"
                        ? "Firme el reconocimiento legal para registrar su consentimiento."
                        : "Sign the legal acknowledgment to record your consent."}
                    </div>
                  </div>
                  <div
                    style={{
                      fontWeight: 800,
                      fontSize: 12,
                      color: WARN,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {locale === "es" ? "Firmar →" : "Sign →"}
                  </div>
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Final mixed test card. PR #4: also gated on standalone signed
          acknowledgments being in place. When modules are passed but
          required signed docs are missing, the card stays locked with
          a "sign these first" hint. */}
      {(() => {
        const missingSignedDocs = state.missing_required_signed_docs ?? [];
        const fullyUnlocked =
          finalUnlocked && (isOwner || missingSignedDocs.length === 0);
        return (
          <div style={{ marginTop: 22 }}>
            <FinalStepCard
              locale={locale}
              unlocked={fullyUnlocked}
              passed={finalPassed}
              attempts={
                state.progress.find((p) => p.module_id === FINAL_MODULE_ID)?.attempts ?? 0
              }
              maxAttempts={MAX_FINAL_ATTEMPTS}
              isOwner={isOwner}
              onClick={fullyUnlocked && !finalPassed ? onOpenFinal : undefined}
              onBypass={
                isOwner && !finalPassed ? () => onBypass(FINAL_MODULE_ID) : undefined
              }
            />
            {/* When modules are done but signed docs are pending,
                tell the learner exactly what to sign. Owners bypass
                this hint because the gate doesn't apply to them. */}
            {!isOwner &&
            finalUnlocked &&
            missingSignedDocs.length > 0 &&
            !finalPassed ? (
              <div
                style={{
                  marginTop: 8,
                  padding: "10px 14px",
                  background: "#FFFBEB",
                  border: `1px solid #FDE68A`,
                  borderLeft: `3px solid ${WARN}`,
                  borderRadius: 8,
                  fontSize: 12.5,
                  color: INK,
                  lineHeight: 1.55,
                }}
              >
                <strong>
                  {locale === "es"
                    ? "El examen final se desbloquea cuando firme:"
                    : "Final exam unlocks once you sign:"}
                </strong>
                <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
                  {missingSignedDocs.map((dt) => (
                    <li key={dt}>{humanSignedDocType(dt, locale)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        );
      })()}
    </div>
  );
}

/** Friendly localized name for a signed-document type slug. */
function humanSignedDocType(documentType: string, locale: Locale): string {
  const titles: Record<string, { en: string; es: string }> = {
    drug_alcohol: {
      en: "Drug & Alcohol Policy",
      es: "Política de Drogas y Alcohol",
    },
    code_of_conduct: { en: "Code of Conduct", es: "Código de Conducta" },
    video_photo_release: {
      en: "Video / Photo Release",
      es: "Autorización de Video / Foto",
    },
    non_solicitation: {
      en: "Non-Solicitation Agreement",
      es: "Acuerdo de No Solicitación",
    },
    social_media: {
      en: "Social Media Policy",
      es: "Política de Redes Sociales",
    },
    supply_kit: {
      en: "Supply Kit Responsibility",
      es: "Responsabilidad del Kit de Suministros",
    },
  };
  return titles[documentType]?.[locale] ?? documentType;
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
  certId,
  onDownloadCert,
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
  certId?: number;
  onDownloadCert?: (certId: number) => Promise<void>;
}) {
  const isMobile = useIsMobile();
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

  // ── Header row (icon + title + subtitle + meta) — same content for both
  // mobile and desktop, just different parent layout. ──
  const titleBlock = (
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
        flex: 1,
      }}
    >
      <div
        style={{
          fontWeight: 700,
          fontSize: 14,
          color: INK,
          letterSpacing: "-0.005em",
          lineHeight: 1.25,
        }}
      >
        {m.title[locale]}
      </div>
      <div
        style={{
          fontSize: 12,
          color: INK_MUTE,
          marginTop: 2,
          lineHeight: 1.4,
          // [mobile-audit 2026-05-12] Allow subtitle to wrap on mobile.
          // Desktop keeps the single-line ellipsis behavior.
          ...(isMobile
            ? {}
            : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
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
          // Keep the metadata on one wrapping line — no per-word linebreaks.
          whiteSpace: "normal",
          wordSpacing: "normal",
        }}
      >
        {m.estimatedMinutes} min
        {isQuizModule ? ` · ${tr("pass80", locale)}` : ""}
        {status === "passed" && bestScore > 0 ? ` · ${bestScore}%` : ""}
        {isQuizModule && status !== "passed" && shouldShowLearnerGating(isOwner) ? (
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
      {atCap && shouldShowLearnerGating(isOwner) ? (
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
  );

  // ── Action area (status badge / CTA + optional Skip-Owner button) ──
  const ctaButton =
    status === "passed" ? (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          color: SUCCESS,
          fontSize: 12,
          fontWeight: 700,
          whiteSpace: "nowrap",
        }}
      >
        <CircleCheck size={14} />
        {tr("passed", locale)}
        {certId && onDownloadCert ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDownloadCert(certId).catch((err) =>
                console.error("[training] download cert failed:", err),
              );
            }}
            title={tr("downloadCert", locale)}
            style={{
              background: "transparent",
              color: SUCCESS,
              border: `1px solid ${SUCCESS}33`,
              padding: "3px 8px",
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: FONT,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              marginLeft: 4,
            }}
          >
            <Download size={11} /> {tr("downloadCert", locale)}
          </button>
        ) : null}
      </span>
    ) : !unlocked && !isOwner ? (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          color: INK_LIGHT,
          fontSize: 12,
          fontWeight: 700,
          whiteSpace: "nowrap",
        }}
      >
        <Lock size={14} />
        {tr("locked", locale)}
      </span>
    ) : atCap && !isOwner ? (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          color: INK_LIGHT,
          fontSize: 12,
          fontWeight: 700,
          whiteSpace: "nowrap",
        }}
      >
        <Lock size={14} />
        {tr("locked", locale)}
      </span>
    ) : (
      <button
        type="button"
        onClick={effectiveOnClick}
        disabled={!effectiveOnClick}
        style={{
          background: isMobile ? NAVY : "transparent",
          border: isMobile ? `1px solid ${NAVY}` : 0,
          color: isMobile ? "#fff" : NAVY,
          cursor: effectiveOnClick ? "pointer" : "default",
          fontWeight: 700,
          fontSize: 13,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
          fontFamily: FONT,
          padding: isMobile ? "10px 14px" : 0,
          borderRadius: isMobile ? 8 : 0,
          width: isMobile ? "100%" : "auto",
          whiteSpace: "nowrap",
        }}
      >
        {cta} <ChevronRight size={14} />
      </button>
    );
  const bypassButton = onBypass ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onBypass();
      }}
      title={tr("bypassOwner", locale)}
      style={{
        marginLeft: isMobile ? 0 : 8,
        background: "#EEF2F8",
        color: NAVY,
        border: `1px solid ${LINE}`,
        padding: isMobile ? "8px 10px" : "5px 10px",
        borderRadius: isMobile ? 8 : 6,
        fontSize: isMobile ? 12 : 11,
        fontWeight: 800,
        cursor: "pointer",
        fontFamily: FONT,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        whiteSpace: "nowrap",
        flex: isMobile ? "0 0 auto" : "initial",
      }}
    >
      <FastForward size={11} /> {tr("bypassOwner", locale)}
    </button>
  ) : null;

  return (
    <div
      style={{
        display: isMobile ? "flex" : "grid",
        flexDirection: isMobile ? "column" : undefined,
        gridTemplateColumns: isMobile ? undefined : "auto 1fr auto",
        alignItems: isMobile ? "stretch" : "center",
        gap: isMobile ? 12 : 14,
        background: SURFACE,
        border: `1px solid ${atCap && !isOwner ? "#FECACA" : LINE}`,
        borderRadius: RADIUS,
        padding: isMobile ? "14px 14px 14px 18px" : "14px 16px",
        textAlign: "left",
        opacity: (unlocked || isOwner) ? 1 : 0.5,
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
      {isMobile ? (
        <>
          {/* Mobile: stacked layout — icon + title row, then full-width actions */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 12,
              minWidth: 0,
            }}
          >
            <ModuleIcon kind={m.iconKind} size={40} />
            {titleBlock}
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              width: "100%",
            }}
          >
            {ctaButton}
            {bypassButton}
          </div>
        </>
      ) : (
        <>
          {/* Desktop: 3-column grid — icon | content | actions */}
          <div style={{ paddingLeft: 4 }}>
            <ModuleIcon kind={m.iconKind} size={44} />
          </div>
          {titleBlock}
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
            {ctaButton}
            {bypassButton}
          </div>
        </>
      )}
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
  const isMobile = useIsMobile();
  const atCap = !passed && attempts >= maxAttempts;
  const effectiveOnClick = atCap && !isOwner ? undefined : onClick;
  return (
    <div
      style={{
        display: isMobile ? "flex" : "grid",
        flexDirection: isMobile ? "column" : undefined,
        gridTemplateColumns: isMobile ? undefined : "auto 1fr auto",
        alignItems: isMobile ? "stretch" : "center",
        gap: isMobile ? 12 : 14,
        background: passed ? "#ECFDF5" : NAVY,
        color: passed ? SUCCESS : "#fff",
        border: `1px solid ${passed ? SUCCESS : NAVY}`,
        borderRadius: RADIUS,
        padding: isMobile ? "16px 16px" : "16px 18px",
        textAlign: "left",
        opacity: unlocked ? 1 : 0.55,
        fontFamily: FONT,
      }}
    >
      {isMobile ? (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <Award size={28} style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 14 }}>
              {tr("finalTest", locale)}
            </div>
            <div style={{ fontSize: 12, opacity: 0.85, marginTop: 3, lineHeight: 1.4 }}>
              {tr("finalIntro", locale)}
            </div>
            {!passed && shouldShowLearnerGating(isOwner) ? (
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
          </div>
        </div>
      ) : null}
      {!isMobile && (
        <>
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
            {!passed && shouldShowLearnerGating(isOwner) ? (
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
        </>
      )}
      <div
        style={{
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "stretch" : "center",
          gap: 8,
          fontWeight: 800,
          fontSize: 12,
          whiteSpace: isMobile ? "normal" : "nowrap",
          marginTop: isMobile ? 4 : 0,
        }}
      >
        {passed ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: isMobile ? "10px 14px" : 0,
              justifyContent: isMobile ? "center" : "flex-start",
            }}
          >
            <CircleCheck size={14} style={{ verticalAlign: "middle" }} />{" "}
            {tr("passed", locale)}
          </span>
        ) : !unlocked && !isOwner ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: isMobile ? "10px 14px" : 0,
              justifyContent: isMobile ? "center" : "flex-start",
            }}
          >
            <Lock size={14} style={{ verticalAlign: "middle" }} />{" "}
            {tr("locked", locale)}
          </span>
        ) : atCap && !isOwner ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: isMobile ? "10px 14px" : 0,
              justifyContent: isMobile ? "center" : "flex-start",
            }}
          >
            <Lock size={14} style={{ verticalAlign: "middle" }} />{" "}
            {tr("locked", locale)}
          </span>
        ) : (
          <button
            type="button"
            onClick={effectiveOnClick}
            disabled={!effectiveOnClick}
            style={{
              background: isMobile ? "rgba(255,255,255,0.15)" : "transparent",
              color: "#fff",
              border: isMobile ? `1px solid rgba(255,255,255,0.3)` : 0,
              cursor: effectiveOnClick ? "pointer" : "default",
              fontWeight: 800,
              fontSize: isMobile ? 13 : 12,
              padding: isMobile ? "10px 14px" : 0,
              borderRadius: isMobile ? 8 : 0,
              fontFamily: FONT,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              width: isMobile ? "100%" : "auto",
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
              padding: isMobile ? "8px 12px" : "5px 10px",
              borderRadius: isMobile ? 8 : 6,
              fontSize: isMobile ? 12 : 11,
              fontWeight: 800,
              cursor: "pointer",
              fontFamily: FONT,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              width: isMobile ? "100%" : "auto",
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
        {isQuizModule && shouldShowLearnerGating(isOwner) ? (
          <div
            style={{
              marginTop: 18,
              padding: "10px 12px",
              background: atCap ? "#FEF2F2" : LINE_SOFT,
              border: `1px solid ${atCap ? "#FECACA" : LINE}`,
              borderRadius: 8,
              fontSize: 12,
              color: atCap ? DANGER : INK_MUTE,
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
              {atCap
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
  isOwner,
  onCancel,
  onPassed,
}: {
  curriculum: Curriculum;
  moduleId: string;
  locale: Locale;
  token: string | null;
  priorAttempts: number;
  isOwner: boolean;
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
        isOwner={isOwner}
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
          {shouldShowLearnerGating(isOwner) ? (
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
          ) : null}
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
  isOwner,
  onContinue,
}: {
  locale: Locale;
  result: SubmitResult;
  attemptsRemaining: number;
  maxAttempts: number;
  passThreshold: number;
  isOwner: boolean;
  onContinue: () => void;
}) {
  const { passed, score } = result;
  // Owners are never "out of attempts" — the server bypasses the cap
  // and the UI matches that. Treat as if attempts remain.
  const noMoreRetries =
    !passed && shouldShowLearnerGating(isOwner) && attemptsRemaining <= 0;
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
        {!passed && shouldShowLearnerGating(isOwner) ? (
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
// SignDocumentView — generic signed-acknowledgment flow (Phase 3+ PR #4)
// ─────────────────────────────────────────────────────────────────────────────
//
// Used for Drug & Alcohol (PR #4), Code of Conduct (PR #5), Video / Photo
// Release (PR #6), Non-Solicit (PR #7), Social Media (PR #8), Supply Kit
// (PR #10). The component is document-type-agnostic. It fetches the
// canonical content from the server, renders an affirmation gate + typed
// signature input, and POSTs to /api/lms/signatures/sign.

function SignDocumentView({
  documentType,
  locale,
  setLocale,
  learner,
  token,
  onCancel,
  onSigned,
}: {
  documentType: string;
  locale: Locale;
  setLocale: (l: Locale) => void;
  learner: Learner | null;
  token: string | null;
  onCancel: () => void;
  onSigned: () => Promise<void>;
}) {
  const [content, setContent] = useState<SignedDocumentContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const suggested = learner
    ? `${learner.firstName} ${learner.lastName}`.trim()
    : "";
  const [name, setName] = useState(suggested);
  const [affirmed, setAffirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    (async () => {
      try {
        const data = await lmsApi.getSignedDocumentContent(
          token,
          documentType,
          locale,
        );
        if (!cancelled) setContent(data);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentType, locale, token]);

  const canSubmit =
    !busy && affirmed && name.trim().length >= 2 && content !== null;

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "20px 18px" }}>
      <BackLink label={tr("back", locale)} onClick={onCancel} />
      <div
        style={{
          marginTop: 14,
          background: SURFACE,
          border: `1px solid ${LINE}`,
          borderRadius: RADIUS,
          padding: 24,
        }}
      >
        {error ? (
          <div style={{ color: DANGER, fontSize: 13 }}>{error}</div>
        ) : !content ? (
          <div
            style={{ padding: 40, textAlign: "center", color: INK_MUTE }}
          >
            <Loader2 className="qleno-spin" size={20} />
          </div>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                marginBottom: 10,
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 20, color: INK }}>
                {content.title}
              </div>
              <LocaleToggle locale={locale} setLocale={setLocale} />
            </div>

            {content.pendingTranslationReview ? (
              <div
                style={{
                  background: "#FFFBEB",
                  border: `1px solid #FDE68A`,
                  borderLeft: `3px solid ${WARN}`,
                  padding: 12,
                  borderRadius: 6,
                  marginBottom: 14,
                  display: "flex",
                  gap: 10,
                }}
              >
                <AlertTriangle
                  size={16}
                  style={{ color: WARN, flexShrink: 0, marginTop: 2 }}
                />
                <div style={{ fontSize: 12.5, color: INK, lineHeight: 1.55 }}>
                  {locale === "es"
                    ? "Esta traducción al español está bajo revisión profesional. La versión en inglés es vinculante hasta que la traducción final sea aprobada por la gerencia."
                    : "This Spanish translation is under professional review. The English version is binding until the final translation is approved by management."}
                </div>
              </div>
            ) : null}

            <div
              style={{
                background: PAGE_BG,
                border: `1px solid ${LINE_SOFT}`,
                borderRadius: 8,
                padding: "18px 20px",
                maxHeight: 380,
                overflowY: "auto",
                fontSize: 13,
                color: INK,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                fontFamily: FONT,
              }}
            >
              {content.contentHtml}
            </div>

            <label
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                marginTop: 18,
                fontSize: 13,
                color: INK,
                lineHeight: 1.55,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={affirmed}
                onChange={(e) => setAffirmed(e.target.checked)}
                style={{ marginTop: 4, flexShrink: 0 }}
              />
              <span>
                {locale === "es"
                  ? `He leído y entendido la ${content.title}. Acepto sus términos y entiendo que mi firma electrónica tiene el mismo efecto legal que una firma manuscrita (UETA / E-SIGN).`
                  : `I have read and understand the ${content.title}. I accept its terms and understand that my electronic signature has the same legal effect as a handwritten signature (UETA / E-SIGN).`}
              </span>
            </label>

            <div
              style={{
                marginTop: 14,
                fontSize: 12,
                fontWeight: 700,
                color: INK_MUTE,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              {locale === "es"
                ? "Escriba su nombre legal completo"
                : "Type your full legal name"}
            </div>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                locale === "es" ? "Su nombre completo" : "Your full name"
              }
              style={{
                width: "100%",
                marginTop: 6,
                padding: "10px 12px",
                border: `1px solid ${LINE}`,
                borderRadius: 8,
                fontSize: 16,
                fontFamily: FONT,
                color: INK,
                fontStyle: "italic",
              }}
            />

            <div
              style={{
                marginTop: 16,
                display: "flex",
                gap: 10,
                justifyContent: "flex-end",
                flexWrap: "wrap",
              }}
            >
              <SecondaryButton onClick={onCancel}>
                {tr("back", locale)}
              </SecondaryButton>
              <PrimaryButton
                disabled={!canSubmit}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await lmsApi.signDocument(token, {
                      documentType,
                      locale,
                      signatureMethod: "typed",
                      signature: name.trim(),
                    });
                    await onSigned();
                  } catch (e) {
                    setError(String((e as Error).message));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? (
                  <Loader2 size={14} className="qleno-spin" />
                ) : locale === "es" ? (
                  "Firmar y enviar"
                ) : (
                  "Sign and submit"
                )}
              </PrimaryButton>
            </div>
          </>
        )}
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

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding Intake (Phase 10, PR #11)
// ─────────────────────────────────────────────────────────────────────────────
//
// Operational form Phes needs that ADP does NOT already cover. Excludes
// SSN / W-4 / IL-W-4 / I-9 / direct deposit (those live with ADP).
// Captures: preferred name + pronouns, personal email + cell, emergency
// contact, languages spoken, uniform sizing, and (when the employee
// drives a personal vehicle for Phes work) vehicle insurance + DL info.

interface IntakeRow {
  id: number;
  preferred_name: string | null;
  pronouns: string | null;
  personal_email: string | null;
  personal_cell_phone: string | null;
  emergency_contact_name: string | null;
  emergency_contact_relationship: string | null;
  emergency_contact_phone: string | null;
  languages_spoken: string | null;
  shirt_size: string | null;
  apron_size: string | null;
  drives_personal_vehicle: boolean;
  vehicle_insurance_company: string | null;
  vehicle_insurance_policy_number: string | null;
  vehicle_insurance_expires_at: string | null;
  vehicle_license_plate: string | null;
  drivers_license_state: string | null;
  drivers_license_expires_at: string | null;
  notes: string | null;
  submitted_at: string | null;
  updated_at: string;
}

function OnboardingIntakeTile({
  locale,
  onOpen,
}: {
  locale: Locale;
  onOpen: () => void;
}) {
  const token = useAuthStore((s) => s.token);
  const [intake, setIntake] = useState<IntakeRow | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const row = await api<IntakeRow | null>(
          "GET",
          "/lms/onboarding-intake/me",
          token,
        );
        if (!cancelled) setIntake(row ?? null);
      } catch {
        if (!cancelled) setIntake(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Status determines the tile tone.
  let status: "not-started" | "draft" | "submitted";
  if (intake == null) status = "not-started";
  else if (intake.submitted_at != null) status = "submitted";
  else status = "draft";

  const toneColor =
    status === "submitted" ? SUCCESS : status === "draft" ? WARN : NAVY;
  const titleEn =
    status === "submitted"
      ? "Onboarding intake: submitted"
      : status === "draft"
      ? "Onboarding intake: continue"
      : "Onboarding intake: get started";
  const titleEs =
    status === "submitted"
      ? "Información de incorporación: enviada"
      : status === "draft"
      ? "Información de incorporación: continuar"
      : "Información de incorporación: empezar";
  const subEn =
    status === "submitted"
      ? `Last updated ${intake?.updated_at ? new Date(intake.updated_at).toLocaleDateString() : ""}`
      : "Emergency contact, sizing, languages, and vehicle details for techs who drive. Excludes SSN, W-4, and direct deposit (handled by ADP).";
  const subEs =
    status === "submitted"
      ? `Última actualización: ${intake?.updated_at ? new Date(intake.updated_at).toLocaleDateString() : ""}`
      : "Contacto de emergencia, tallas, idiomas y datos del vehículo para técnicos que conducen. No incluye SSN, W-4 ni depósito directo (los maneja ADP).";

  return (
    <div
      style={{
        marginBottom: 14,
        background: SURFACE,
        border: `1px solid ${LINE}`,
        borderLeft: `3px solid ${toneColor}`,
        borderRadius: 10,
        padding: "14px 16px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        fontFamily: FONT,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 800, color: INK, fontSize: 14 }}>
          {locale === "en" ? titleEn : titleEs}
        </div>
        <div
          style={{
            marginTop: 4,
            color: INK_MUTE,
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          {locale === "en" ? subEn : subEs}
        </div>
      </div>
      <button
        type="button"
        onClick={onOpen}
        style={{
          background: NAVY,
          color: "#fff",
          border: 0,
          padding: "8px 14px",
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 800,
          cursor: "pointer",
          fontFamily: FONT,
          flexShrink: 0,
        }}
      >
        {status === "submitted"
          ? locale === "es"
            ? "Editar"
            : "Edit"
          : locale === "es"
          ? "Abrir"
          : "Open"}
      </button>
    </div>
  );
}

interface IntakeFormState {
  preferred_name: string;
  pronouns: string;
  personal_email: string;
  personal_cell_phone: string;
  emergency_contact_name: string;
  emergency_contact_relationship: string;
  emergency_contact_phone: string;
  languages_spoken: string;
  shirt_size: string;
  apron_size: string;
  drives_personal_vehicle: boolean;
  vehicle_insurance_company: string;
  vehicle_insurance_policy_number: string;
  vehicle_insurance_expires_at: string;
  vehicle_license_plate: string;
  drivers_license_state: string;
  drivers_license_expires_at: string;
  notes: string;
}

const EMPTY_INTAKE: IntakeFormState = {
  preferred_name: "",
  pronouns: "",
  personal_email: "",
  personal_cell_phone: "",
  emergency_contact_name: "",
  emergency_contact_relationship: "",
  emergency_contact_phone: "",
  languages_spoken: "",
  shirt_size: "",
  apron_size: "",
  drives_personal_vehicle: false,
  vehicle_insurance_company: "",
  vehicle_insurance_policy_number: "",
  vehicle_insurance_expires_at: "",
  vehicle_license_plate: "",
  drivers_license_state: "",
  drivers_license_expires_at: "",
  notes: "",
};

function OnboardingIntakeView({
  locale,
  token,
  onCancel,
  onSaved,
}: {
  locale: Locale;
  token: string | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<IntakeFormState>(EMPTY_INTAKE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const row = await api<IntakeRow | null>(
          "GET",
          "/lms/onboarding-intake/me",
          token,
        );
        if (cancelled) return;
        if (row) {
          setForm({
            preferred_name: row.preferred_name ?? "",
            pronouns: row.pronouns ?? "",
            personal_email: row.personal_email ?? "",
            personal_cell_phone: row.personal_cell_phone ?? "",
            emergency_contact_name: row.emergency_contact_name ?? "",
            emergency_contact_relationship: row.emergency_contact_relationship ?? "",
            emergency_contact_phone: row.emergency_contact_phone ?? "",
            languages_spoken: row.languages_spoken ?? "",
            shirt_size: row.shirt_size ?? "",
            apron_size: row.apron_size ?? "",
            drives_personal_vehicle: row.drives_personal_vehicle,
            vehicle_insurance_company: row.vehicle_insurance_company ?? "",
            vehicle_insurance_policy_number: row.vehicle_insurance_policy_number ?? "",
            vehicle_insurance_expires_at: row.vehicle_insurance_expires_at ?? "",
            vehicle_license_plate: row.vehicle_license_plate ?? "",
            drivers_license_state: row.drivers_license_state ?? "",
            drivers_license_expires_at: row.drivers_license_expires_at ?? "",
            notes: row.notes ?? "",
          });
        }
      } catch (e) {
        if (!cancelled) setErr(String((e as Error).message));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit() {
    setSaving(true);
    setErr(null);
    try {
      await api("POST", "/lms/onboarding-intake/save", token, form);
      onSaved();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setSaving(false);
    }
  }

  function set<K extends keyof IntakeFormState>(
    key: K,
    value: IntakeFormState[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const required = (label: string) => (
    <span>
      {label}
      <span style={{ color: DANGER, marginLeft: 3 }}>*</span>
    </span>
  );

  if (loading) {
    return (
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "26px 18px" }}>
        <div style={{ color: INK_MUTE }}>
          {locale === "es" ? "Cargando..." : "Loading..."}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "26px 18px",
        fontFamily: FONT,
        color: INK,
      }}
    >
      <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 6px" }}>
        {locale === "es"
          ? "Información de Incorporación"
          : "Onboarding Intake"}
      </h1>
      <p style={{ color: INK_MUTE, fontSize: 13, lineHeight: 1.55, margin: "0 0 18px" }}>
        {locale === "es"
          ? "La oficina necesita estos detalles operativos para despacharlo. Phes NO recoge aquí su SSN, formulario W-4, documentos I-9 ni depósito directo — esos los maneja ADP. Los campos marcados con * son obligatorios."
          : "The office needs these operational details to dispatch you. Phes does NOT collect your SSN, W-4, I-9 documents, or direct deposit here — those are handled by ADP. Fields marked with * are required."}
      </p>

      <FormSection
        title={locale === "es" ? "Sobre usted" : "About you"}
      >
        <Field
          label={locale === "es" ? "Nombre preferido (opcional)" : "Preferred name (optional)"}
          value={form.preferred_name}
          onChange={(v) => set("preferred_name", v)}
        />
        <Field
          label={locale === "es" ? "Pronombres (opcional)" : "Pronouns (optional)"}
          value={form.pronouns}
          onChange={(v) => set("pronouns", v)}
        />
        <Field
          label={locale === "es" ? "Correo personal" : "Personal email"}
          type="email"
          value={form.personal_email}
          onChange={(v) => set("personal_email", v)}
        />
        <Field
          label={locale === "es" ? "Celular personal" : "Personal cell phone"}
          type="tel"
          value={form.personal_cell_phone}
          onChange={(v) => set("personal_cell_phone", v)}
        />
      </FormSection>

      <FormSection
        title={locale === "es" ? "Contacto de emergencia" : "Emergency contact"}
      >
        <Field
          label={required(locale === "es" ? "Nombre" : "Name")}
          value={form.emergency_contact_name}
          onChange={(v) => set("emergency_contact_name", v)}
        />
        <Field
          label={required(locale === "es" ? "Relación" : "Relationship")}
          value={form.emergency_contact_relationship}
          onChange={(v) => set("emergency_contact_relationship", v)}
        />
        <Field
          label={required(locale === "es" ? "Teléfono" : "Phone")}
          type="tel"
          value={form.emergency_contact_phone}
          onChange={(v) => set("emergency_contact_phone", v)}
        />
      </FormSection>

      <FormSection
        title={locale === "es" ? "Detalles del trabajo" : "Job details"}
      >
        <Field
          label={
            locale === "es"
              ? "Idiomas que habla (separados por comas)"
              : "Languages spoken (comma-separated)"
          }
          value={form.languages_spoken}
          onChange={(v) => set("languages_spoken", v)}
          placeholder={locale === "es" ? "ej. inglés, español" : "e.g. english, spanish"}
        />
        <Field
          label={locale === "es" ? "Talla de camisa" : "Shirt size"}
          value={form.shirt_size}
          onChange={(v) => set("shirt_size", v)}
          placeholder="XS / S / M / L / XL / XXL / XXXL"
        />
        <Field
          label={locale === "es" ? "Talla de delantal" : "Apron size"}
          value={form.apron_size}
          onChange={(v) => set("apron_size", v)}
          placeholder="XS / S / M / L / XL / XXL / XXXL"
        />
      </FormSection>

      <FormSection
        title={
          locale === "es"
            ? "Vehículo personal para trabajo de Phes"
            : "Personal vehicle for Phes work"
        }
      >
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={form.drives_personal_vehicle}
            onChange={(e) => set("drives_personal_vehicle", e.target.checked)}
          />
          <span>
            {locale === "es"
              ? "Usaré mi vehículo personal para trabajo de Phes"
              : "I will use my personal vehicle for Phes work"}
          </span>
        </label>
        {form.drives_personal_vehicle ? (
          <>
            <Field
              label={locale === "es" ? "Compañía de seguro" : "Insurance company"}
              value={form.vehicle_insurance_company}
              onChange={(v) => set("vehicle_insurance_company", v)}
            />
            <Field
              label={locale === "es" ? "Número de póliza" : "Policy number"}
              value={form.vehicle_insurance_policy_number}
              onChange={(v) => set("vehicle_insurance_policy_number", v)}
            />
            <Field
              label={
                locale === "es"
                  ? "Fecha de expiración del seguro (AAAA-MM-DD)"
                  : "Insurance expiration date (YYYY-MM-DD)"
              }
              type="date"
              value={form.vehicle_insurance_expires_at}
              onChange={(v) => set("vehicle_insurance_expires_at", v)}
            />
            <Field
              label={locale === "es" ? "Placa" : "License plate"}
              value={form.vehicle_license_plate}
              onChange={(v) => set("vehicle_license_plate", v)}
            />
            <Field
              label={
                locale === "es"
                  ? "Estado de la licencia de conducir (ej. IL)"
                  : "Driver's license state (e.g. IL)"
              }
              value={form.drivers_license_state}
              onChange={(v) => set("drivers_license_state", v)}
              placeholder="IL"
            />
            <Field
              label={
                locale === "es"
                  ? "Expiración de la licencia (AAAA-MM-DD)"
                  : "Driver's license expiration (YYYY-MM-DD)"
              }
              type="date"
              value={form.drivers_license_expires_at}
              onChange={(v) => set("drivers_license_expires_at", v)}
            />
          </>
        ) : null}
      </FormSection>

      <FormSection
        title={locale === "es" ? "Notas adicionales (opcional)" : "Additional notes (optional)"}
      >
        <textarea
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          rows={4}
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 8,
            border: `1px solid ${LINE}`,
            fontSize: 14,
            fontFamily: FONT,
            background: SURFACE,
            color: INK,
            resize: "vertical",
          }}
          placeholder={
            locale === "es"
              ? "Alergias, restricciones dietéticas, accesibilidad..."
              : "Allergies, dietary restrictions, accessibility..."
          }
        />
      </FormSection>

      {err ? (
        <div
          style={{
            margin: "12px 0",
            padding: 12,
            background: "#FEF2F2",
            border: `1px solid #FECACA`,
            color: DANGER,
            borderRadius: 8,
            fontSize: 13,
          }}
        >
          {err}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          style={{
            background: saving ? INK_LIGHT : NAVY,
            color: "#fff",
            border: 0,
            padding: "10px 18px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 800,
            cursor: saving ? "not-allowed" : "pointer",
            fontFamily: FONT,
          }}
        >
          {saving
            ? locale === "es"
              ? "Guardando..."
              : "Saving..."
            : locale === "es"
            ? "Guardar"
            : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          style={{
            background: SURFACE,
            color: INK,
            border: `1px solid ${LINE}`,
            padding: "10px 18px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            fontFamily: FONT,
          }}
        >
          {locale === "es" ? "Cancelar" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

function FormSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        marginTop: 14,
        padding: "12px 14px",
        background: LINE_SOFT,
        borderRadius: 10,
        border: `1px solid ${LINE}`,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          color: INK_MUTE,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "email" | "tel" | "date";
  placeholder?: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: INK }}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          padding: "8px 10px",
          borderRadius: 6,
          border: `1px solid ${LINE}`,
          fontSize: 13,
          fontFamily: FONT,
          background: SURFACE,
          color: INK,
        }}
      />
    </label>
  );
}
