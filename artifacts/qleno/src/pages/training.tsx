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
import * as React from "react";
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
import { CalendarPopover } from "@/components/calendar-popover";
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
  FileSignature,
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
  // ISO timestamp set by /quiz/submit when the attempt passed, or by
  // /module/acknowledge for content-only modules. Optional because
  // the field is null until a pass is recorded. Used by the
  // ModuleView completion banner to render "Passed on <date>".
  passed_at?: string | null;
};

type LmsState = {
  enrollment: EnrollmentRow;
  progress: ModuleProgressRow[];
  unlocked: Record<string, boolean>;
  days_remaining: number | null;
  limits?: Record<string, number>;
  is_owner?: boolean;
  /**
   * PR #4 policy: standalone signed acknowledgments that the learner
   * still owes before the final mixed test unlocks. Drives the locked
   * state + "sign these first" hint on the FinalStepCard.
   */
  missing_required_signed_docs?: string[];
  /**
   * Bug-fix sprint #2 (server): when the cached enrollment.status was
   * 'completed' but the current truth gate (all modules + all 6 acks
   * + handbook + final) fails, GET /me lazily heals the row to
   * 'active' and surfaces this flag. The frontend uses it to render
   * a non-alarming "we updated requirements" banner.
   */
  status_was_recomputed?: boolean;
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
  | { kind: "sign-handbook" }
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
    // Item 7 (P1 sprint 2026-05-14): client-generated UUID. Sent on
    // every submit; server dedupes a duplicate POST within 60s by
    // returning the cached response of the first call. Pre-fix, a
    // double-click or slow network created ghost attempts (Sal's
    // audit found 11 0% submissions all timestamped 10:24 AM for
    // one tech). Required field; if unset the server falls back to
    // the racing behavior, so always pass a fresh value per attempt.
    idempotencyKey?: string,
  ) =>
    api<SubmitResult>("POST", "/lms/quiz/submit", token, {
      moduleId,
      answers,
      questionIds,
      idempotency_key: idempotencyKey,
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
  getHandbookEligibility: (token: string | null) =>
    api<HandbookEligibility>("GET", "/lms/handbook/eligibility", token),
  signHandbook: (
    token: string | null,
    args: {
      locale: Locale;
      signatureMethod: "typed" | "drawn";
      signature: string;
    },
  ) =>
    api<{
      signed_document_id: number;
      version_hash: string;
      signed_at: string;
    }>("POST", "/lms/handbook/sign", token, {
      ...args,
      affirmation: true,
    }),
  getPendingReAcks: (token: string | null) =>
    api<PendingReAckSummary>("GET", "/lms/annual-ack/me/pending", token),
};

type PendingReAckRow = {
  id: number;
  document_type: string;
  new_version_hash: string;
  trigger_reason: string;
  triggered_at: string;
  defer_until: string | null;
};

type PendingReAckSummary = {
  active: PendingReAckRow[];
  deferred: PendingReAckRow[];
  total: number;
};

type HandbookEligibility = {
  eligible: boolean;
  missing_modules: string[];
  missing_signed_docs: string[];
  passed_modules: string[];
  final_exam_passed: boolean;
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

// Fetch + open a signed acknowledgment PDF in a new tab. Used by the
// post-sign confirmation screen so the owner / employee can see the
// PDF that was generated immediately after signing. Mirrors the
// download-cert helper but opens in a tab (preview-style) instead of
// auto-downloading, because the typical first action after signing
// is "let me see what got generated" rather than "save to disk".
async function viewSignedDocumentPdf(
  token: string | null,
  signedDocumentId: number,
): Promise<void> {
  const url = `${API_BASE}/lms/signatures/${signedDocumentId}/pdf`;
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GET /lms/signatures/${signedDocumentId}/pdf → ${res.status}: ${text}`,
    );
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  window.open(objectUrl, "_blank", "noopener,noreferrer");
  // Release the object URL once the new tab has had time to load.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
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
    en: "Final mixed test. Random questions from every module. 80% to pass.",
    es: "Examen final mixto. Preguntas aleatorias de cada módulo. 80% para aprobar.",
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
    en: "Thanks. Your manager has been notified.",
    es: "Gracias. Tu supervisor ha sido notificado.",
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
  // Passed-module terminal-state UI (2026-05-21 Katie-class fix).
  // Passed modules are TERMINAL — no quiz re-entry, no review, no
  // unlock. The detail screen shows the completion banner + cert
  // download + a deep-link CTA to the next module.
  moduleCompleted: { en: "Module completed", es: "Módulo completado" },
  passedOn: { en: "Passed on", es: "Aprobado el" },
  bestScoreLabel: { en: "Best score", es: "Mejor puntaje" },
  continueToNextModule: {
    en: "Continue to next module",
    es: "Continuar al siguiente módulo",
  },
  allModulesDone: {
    en: "You've completed every module",
    es: "Has completado todos los módulos",
  },
  returnToTraining: { en: "Return to training", es: "Volver a capacitación" },
  viewCertificate: { en: "View certificate", es: "Ver certificado" },
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
  const [handbookEligibility, setHandbookEligibility] =
    useState<HandbookEligibility | null>(null);
  const [pendingReAcks, setPendingReAcks] =
    useState<PendingReAckSummary | null>(null);

  // Bug-fix sprint #1 — recompute banner.
  //
  // GET /api/lms/me sets `status_was_recomputed: true` when it has just
  // lazily-healed a stale enrollment.status='completed' row back to
  // 'active'. The banner is the friendly user-facing acknowledgment
  // of that change. Dismissed once per user via localStorage so
  // returning users don't see it every login.
  const recomputeBannerKey = useMemo(() => {
    const id = learner?.email ?? "anon";
    return `qleno.lms.recompute-banner.dismissed.${id.toLowerCase()}`;
  }, [learner?.email]);
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(recomputeBannerKey) === "1";
    } catch {
      return false;
    }
  });
  const dismissRecomputeBanner = () => {
    try {
      localStorage.setItem(recomputeBannerKey, "1");
    } catch {
      /* noop */
    }
    setBannerDismissed(true);
  };

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
      const [next, certs, docs, eligibility, pending] = await Promise.all([
        lmsApi.me(token),
        lmsApi.listMyCertificates(token).catch(() => [] as CertificateRow[]),
        lmsApi
          .listMySignedDocuments(token)
          .catch(() => [] as SignedDocumentRow[]),
        lmsApi
          .getHandbookEligibility(token)
          .catch(() => null as HandbookEligibility | null),
        lmsApi
          .getPendingReAcks(token)
          .catch(() => null as PendingReAckSummary | null),
      ]);
      setState(next);
      setCertificates(certs);
      setSignedDocs(docs);
      setHandbookEligibility(eligibility);
      setPendingReAcks(pending);
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

  // 2026-05-19 audit (third occurrence of the Maribel-class pattern):
  // mirror the backend's defensive predicate. A module with best_score
  // >= 80 and status != 'passed' (cold-start race window or admin
  // retake during a backfill) was being treated as NOT passed here,
  // while the backend treats it as passed. That divergence caused
  // PR #126's "Module is locked" 403. Same rule in both surfaces.
  const completedIds = state.progress
    .filter((p) => p.status === "passed" || (p.best_score ?? 0) >= 80)
    .map((p) => p.module_id);
  const finalUnlocked = isFinalUnlocked(completedIds);
  const finalPassed = completedIds.includes(FINAL_MODULE_ID);
  const ackUnlocked = isModuleUnlocked("acknowledgment", completedIds);

  // Bug-fix sprint #1: the previous auto-route to DoneView trusted
  // enrollment.status === "completed" alone, which falsely fired
  // whenever the cached status flag was stale (Jose-style: passed
  // final under old curriculum, owes 8 new modules + 6 new acks).
  // The auto-route is gone. DoneView still exists but is reachable
  // only when every gate is satisfied. Home view always renders
  // when fullyDone is false so the pending-ack tiles + handbook
  // card stay accessible.
  const allModulesPassed = (QUIZ_MODULE_IDS as readonly string[]).every((m) =>
    completedIds.includes(m),
  );
  const allDocsSigned =
    (state.missing_required_signed_docs ?? []).length === 0;
  const handbookSigned = !!signedDocByType["handbook"];
  const noPendingReAcks = (pendingReAcks?.active.length ?? 0) === 0;
  const fullyDone =
    allModulesPassed &&
    finalPassed &&
    allDocsSigned &&
    handbookSigned &&
    noPendingReAcks;

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
      {view.kind === "home" && fullyDone && (
        <DoneView
          locale={locale}
          tenantName={curriculum.tenantName}
          onReturnHome={() => setLocation("/")}
        />
      )}
      {view.kind === "home" && !fullyDone && (
        <Home
          curriculum={curriculum}
          state={state}
          locale={locale}
          finalUnlocked={finalUnlocked}
          finalPassed={finalPassed}
          ackUnlocked={ackUnlocked}
          certByModule={certByModule}
          signedDocByType={signedDocByType}
          handbookEligibility={handbookEligibility}
          pendingReAcks={pendingReAcks}
          token={token}
          onOpenModule={(moduleId) => setView({ kind: "module", moduleId })}
          onOpenFinal={() => setView({ kind: "final-intro" })}
          onOpenAck={() => setView({ kind: "ack" })}
          onOpenSign={(documentType) =>
            setView({ kind: "sign-document", documentType })
          }
          onOpenSignHandbook={() => setView({ kind: "sign-handbook" })}
          onOpenOnboardingIntake={() => setView({ kind: "onboarding-intake" })}
          onBypass={async (moduleId) => {
            await lmsApi.bypassModule(token, moduleId);
            await refresh();
          }}
          onDownloadCert={(certId) => downloadCertificatePdf(token, certId)}
          showRecomputeBanner={
            !!state.status_was_recomputed && !bannerDismissed
          }
          onDismissRecomputeBanner={dismissRecomputeBanner}
        />
      )}
      {view.kind === "module" && (() => {
        // Deep-link target for "Continue to next module" CTA shown on
        // passed modules. Walks the curriculum in its canonical order
        // and picks the first downstream module the learner hasn't
        // passed yet. If every quiz module is passed, returns null so
        // the CTA falls back to "Return to training" (which still
        // routes home where the final test + ack tiles live).
        const currentModuleId = view.moduleId;
        const orderedIds = curriculum.modules.map((m) => m.id);
        const startIdx = orderedIds.indexOf(currentModuleId);
        const nextModuleId =
          orderedIds
            .slice(startIdx + 1)
            .find((id) => !completedIds.includes(id)) ??
          orderedIds.find(
            (id) => id !== currentModuleId && !completedIds.includes(id),
          ) ??
          null;
        return (
          <ModuleView
            module={
              curriculum.modules.find((m) => m.id === currentModuleId) ??
              curriculum.modules[0]
            }
            locale={locale}
            isQuizModule={
              QUIZ_MODULE_IDS.includes(currentModuleId as never)
            }
            progress={
              state.progress.find((p) => p.module_id === currentModuleId) ?? null
            }
            isOwner={!!state.is_owner}
            certId={certByModule[currentModuleId]}
            nextModuleId={nextModuleId}
            onBack={() => setView({ kind: "home" })}
            onTakeQuiz={() =>
              setView({ kind: "quiz", moduleId: currentModuleId })
            }
            onAcknowledge={async () => {
              await lmsApi.acknowledge(token, currentModuleId);
              await refresh();
              setView({ kind: "home" });
            }}
            onBypass={async () => {
              await lmsApi.bypassModule(token, currentModuleId);
              await refresh();
              setView({ kind: "home" });
            }}
            onStart={async () => {
              try {
                await lmsApi.startModule(token, currentModuleId);
              } catch {
                /* idempotent — ignore conflict */
              }
            }}
            onDownloadCert={(certId) => downloadCertificatePdf(token, certId)}
            onOpenModule={(id) => setView({ kind: "module", moduleId: id })}
            onReturnHome={() => setView({ kind: "home" })}
          />
        );
      })()}
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
          onCancel={async () => {
            // 2026-05-17: refresh /me before navigating away so the
            // module list reflects the latest attempts count + status.
            // Previously the badge could show "X/4 attempts" stale after
            // a failed-cap-hit submit because state.progress was the
            // /me snapshot from page load.
            await refresh();
            setView({ kind: "module", moduleId: view.moduleId });
          }}
          onPassed={async () => {
            await refresh();
            setView({ kind: "home" });
          }}
          onBypass={
            state.is_owner
              ? async () => {
                  await lmsApi.bypassModule(token, view.moduleId);
                  await refresh();
                  setView({ kind: "home" });
                }
              : undefined
          }
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
          onCancel={async () => {
            // 2026-05-17: refresh /me before navigating away (same
            // reason as the per-module QuizView onCancel above).
            await refresh();
            setView({ kind: "home" });
          }}
          onPassed={async () => {
            await refresh();
            setView({ kind: "home" });
          }}
          onBypass={
            state.is_owner
              ? async () => {
                  await lmsApi.bypassModule(token, FINAL_MODULE_ID);
                  await refresh();
                  setView({ kind: "home" });
                }
              : undefined
          }
        />
      )}
      {view.kind === "ack" && (
        <AckView
          locale={locale}
          tenantName={curriculum.tenantName}
          learner={learner}
          onCancel={() => setView({ kind: "home" })}
          onSubmit={async (signature) => {
            // Bug-fix sprint #1: don't blindly route to DoneView after
            // the legacy acknowledgment view. The refresh + Home re-
            // render path now decides whether to show DoneView based
            // on fullyDone. Fall back to Home; the gate downstream
            // picks the right surface.
            await lmsApi.acknowledge(token, "acknowledgment", signature);
            await refresh();
            setView({ kind: "home" });
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
      {view.kind === "sign-handbook" && (
        <HandbookSignView
          locale={locale}
          setLocale={setLocale}
          learner={learner}
          token={token}
          eligibility={handbookEligibility}
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
  const [, setLocation] = useLocation();
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
        {/* Sal report 2026-05-19: from /training there was no way back
            to the main Qleno app. Wrapping the logo in a clickable
            ghosts the standard "logo = home" convention. */}
        <button
          type="button"
          onClick={() => setLocation("/")}
          aria-label={locale === "es" ? "Volver a Qleno" : "Back to Qleno"}
          style={{
            background: "transparent",
            border: 0,
            padding: 0,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          <QlenoLogo size={isMobile ? "md" : "lg"} theme="light" layout="horizontal" />
        </button>
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
        {/* Sal report 2026-05-19: from /training, owners had no nav
            link to /lms/admin. Adding here so the LMS dashboard is one
            tap away while testing. Owner-only — admin/office staff
            still navigate via URL bar (out of scope for this fix). */}
        {isOwner && (
          <button
            type="button"
            onClick={() => setLocation("/lms/admin")}
            style={{
              background: "transparent",
              border: `1px solid ${LINE}`,
              borderRadius: 999,
              padding: isMobile ? "6px 10px" : "6px 14px",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
              color: INK,
              fontFamily: "inherit",
              letterSpacing: "0.02em",
            }}
          >
            {locale === "es" ? "Admin" : "Admin"}
          </button>
        )}
        <LocaleToggle locale={locale} setLocale={setLocale} compact={isMobile} />
      </div>
    </header>
  );
}

function DeadlineBadge({ days, locale }: { days: number; locale: Locale }) {
  let tone = SUCCESS;
  let bg = "#ECFDF5";
  // Item 13b (P0 sprint): "1 days" → "1 day" pluralization across
  // every countdown chip. The translation key is "days remaining"
  // plural by default; override when abs(days) === 1.
  const isSingular = Math.abs(days) === 1;
  const dayWord = isSingular
    ? locale === "es"
      ? "día restante"
      : "day remaining"
    : tr("daysRemaining", locale);
  const overdueWord = isSingular
    ? locale === "es"
      ? "día de retraso"
      : "day overdue"
    : tr("daysOverdue", locale);
  let label = `${days} ${dayWord}`;
  if (days < 0) {
    tone = DANGER;
    bg = "#FEF2F2";
    label = `${Math.abs(days)} ${overdueWord}`;
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
  handbookEligibility,
  pendingReAcks,
  token,
  onOpenModule,
  onOpenFinal,
  onOpenAck,
  onOpenSign,
  onOpenSignHandbook,
  onOpenOnboardingIntake,
  onBypass,
  onDownloadCert,
  showRecomputeBanner,
  onDismissRecomputeBanner,
}: {
  curriculum: Curriculum;
  state: LmsState;
  locale: Locale;
  finalUnlocked: boolean;
  finalPassed: boolean;
  ackUnlocked: boolean;
  certByModule: Record<string, number>;
  signedDocByType: Record<string, number>;
  handbookEligibility: HandbookEligibility | null;
  pendingReAcks: PendingReAckSummary | null;
  token: string | null;
  onOpenModule: (id: string) => void;
  onOpenFinal: () => void;
  onOpenAck: () => void;
  onOpenSign: (documentType: string) => void;
  onOpenSignHandbook: () => void;
  onOpenOnboardingIntake: () => void;
  onBypass: (moduleId: string) => Promise<void>;
  onDownloadCert: (certId: number) => Promise<void>;
  showRecomputeBanner: boolean;
  onDismissRecomputeBanner: () => void;
}) {
  const isOwner = !!state.is_owner;
  const completed = state.progress
    .filter((p) => p.status === "passed")
    .map((p) => p.module_id);
  // Item 2 (P0 sprint): canonical denominator is QUIZ_MODULE_IDS (13
  // graded modules), NOT MODULE_ORDER (which includes the
  // acknowledgment content-only entry — used to make the denominator
  // 14 and disagree with admin/handbook surfaces). The Final Mixed
  // Test and the Final Handbook are tracked in their own buckets,
  // not folded into the modules count.
  const totalModules = QUIZ_MODULE_IDS.length;
  const passedCount = completed.filter((c) =>
    (QUIZ_MODULE_IDS as readonly string[]).includes(c),
  ).length;
  const pct = Math.round((passedCount / totalModules) * 100);
  // Item 2 — separate buckets for the Final Test + Final Handbook so
  // the progress card surfaces all three states together.
  const finalTestPassed = completed.includes(FINAL_MODULE_ID);
  const handbookSignedFlag = !!signedDocByType["handbook"];

  const activePendingCount = pendingReAcks?.active.length ?? 0;

  return (
    <div
      style={{
        maxWidth: 880,
        margin: "0 auto",
        padding: "26px 18px",
      }}
    >
      {showRecomputeBanner ? (
        <RecomputeBanner
          locale={locale}
          onDismiss={onDismissRecomputeBanner}
        />
      ) : null}

      {activePendingCount > 0 ? (
        <PendingReAckTile
          locale={locale}
          pending={pendingReAcks!}
          onResign={onOpenSignHandbook}
        />
      ) : null}

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
        <div style={{ minWidth: 200 }}>
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
            {locale === "en" ? "modules complete" : "módulos completos"}
          </div>
          {/* Item 2 (P0 sprint): Final Test + Handbook are separate
              buckets, never collapsed into the modules count. Three
              rows so HR / legal can defend a single number for each. */}
          <div
            style={{
              fontSize: 11,
              color: INK_LIGHT,
              marginTop: 4,
              fontWeight: 600,
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            <span style={{ color: finalTestPassed ? SUCCESS : INK_LIGHT }}>
              {finalTestPassed ? "✓" : "○"}
            </span>
            {locale === "en"
              ? finalTestPassed
                ? "Final test: passed"
                : "Final test: not passed"
              : finalTestPassed
              ? "Examen final: aprobado"
              : "Examen final: no aprobado"}
          </div>
          <div
            style={{
              fontSize: 11,
              color: INK_LIGHT,
              marginTop: 2,
              fontWeight: 600,
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            <span style={{ color: handbookSignedFlag ? SUCCESS : INK_LIGHT }}>
              {handbookSignedFlag ? "✓" : "○"}
            </span>
            {locale === "en"
              ? handbookSignedFlag
                ? "Handbook: signed"
                : "Handbook: not signed"
              : handbookSignedFlag
              ? "Manual: firmado"
              : "Manual: no firmado"}
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
          All six standalone signed docs from PRs #4-#10 must be listed
          here; previously only drug_alcohol was — which made the
          remaining five unreachable once drug_alcohol was signed. */}
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
          {
            moduleId: "code-of-conduct",
            documentType: "code_of_conduct",
            title: {
              en: "Code of Conduct",
              es: "Código de Conducta",
            },
          },
          {
            moduleId: "video-photo-release",
            documentType: "video_photo_release",
            title: {
              en: "Video & Photo Release",
              es: "Autorización de Video y Foto",
            },
          },
          {
            moduleId: "non-solicitation",
            documentType: "non_solicitation",
            title: {
              en: "Non-Solicitation Agreement",
              es: "Acuerdo de No Solicitación",
            },
          },
          {
            moduleId: "social-media",
            documentType: "social_media",
            title: {
              en: "Social Media Policy",
              es: "Política de Redes Sociales",
            },
          },
          {
            moduleId: "supply-kit",
            documentType: "supply_kit",
            title: {
              en: "Supply Kit Responsibility",
              es: "Responsabilidad del Kit de Suministros",
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

      {/* Signed acknowledgments the learner has already completed.
          Lets the owner / employee re-open the PDF that was generated
          at signing. Without this section, once you signed an ack the
          tile vanished and there was no surface to verify the PDF was
          generated correctly — which is exactly the gap the owner hit
          while spot-checking the workflow as a test signer. */}
      {(() => {
        const signedTiles: Array<{
          documentType: string;
          title: { en: string; es: string };
          signedDocumentId: number;
        }> = [];
        const TITLES: Record<string, { en: string; es: string }> = {
          drug_alcohol: {
            en: "Drug & Alcohol Policy",
            es: "Política de Drogas y Alcohol",
          },
          code_of_conduct: {
            en: "Code of Conduct",
            es: "Código de Conducta",
          },
          video_photo_release: {
            en: "Video & Photo Release",
            es: "Autorización de Video y Foto",
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
        for (const documentType of Object.keys(TITLES)) {
          const id = signedDocByType[documentType];
          if (typeof id === "number") {
            signedTiles.push({
              documentType,
              title: TITLES[documentType],
              signedDocumentId: id,
            });
          }
        }
        if (signedTiles.length === 0) return null;
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
                ? "Documentos firmados"
                : "Your signed documents"}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {signedTiles.map((t) => (
                <SignedDocTile
                  key={t.documentType}
                  locale={locale}
                  title={t.title[locale]}
                  signedDocumentId={t.signedDocumentId}
                  token={token}
                />
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

      {/* Comprehensive Handbook signing card (Phase 11 + Handbook UI PR).
          Shows after the final exam. Locked until eligibility is fully
          satisfied (all modules + all six standalone acks + final exam).
          Once signed, displays a Download link instead of the Sign CTA.
          Owners see a Preview hint pointing to /lms/handbook/preview
          which exists on the API but is intentionally not wired here
          to avoid drawing employees into an admin-only surface. */}
      {(() => {
        const handbookSignedId = signedDocByType["handbook"];
        const eligible = !!handbookEligibility?.eligible;
        return (
          <div style={{ marginTop: 22 }}>
            <HandbookCard
              locale={locale}
              eligible={eligible}
              eligibility={handbookEligibility}
              signedDocumentId={handbookSignedId ?? null}
              isOwner={isOwner}
              onSign={onOpenSignHandbook}
              onDownload={async () => {
                if (!handbookSignedId) return;
                await downloadHandbookPdf(token);
              }}
              onPreview={async () => {
                await previewHandbookPdf(token, locale);
              }}
            />
          </div>
        );
      })()}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Handbook PDF download (fetch + blob → object URL) — same pattern as
// downloadCertificatePdf. Calls GET /api/lms/handbook/me/pdf which
// returns the caller's most recent active handbook PDF.
// ─────────────────────────────────────────────────────────────────────────────

async function downloadHandbookPdf(token: string | null): Promise<void> {
  const url = `${API_BASE}/lms/handbook/me/pdf`;
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET /lms/handbook/me/pdf → ${res.status}: ${text}`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = `phes-handbook.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
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
      : status === "in_progress" && attempts > 0
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
      disabled={(!unlocked && !isOwner) || !effectiveOnClick}
      style={{
        minWidth: 0,
        background: "transparent",
        border: 0,
        padding: 0,
        margin: 0,
        textAlign: "left",
        cursor: (unlocked || isOwner) && effectiveOnClick ? "pointer" : "default",
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
            disabled={(!unlocked && !isOwner) || passed || !effectiveOnClick}
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
  certId,
  nextModuleId,
  onBack,
  onTakeQuiz,
  onAcknowledge,
  onBypass,
  onStart,
  onDownloadCert,
  onOpenModule,
  onReturnHome,
}: {
  module: Module;
  locale: Locale;
  isQuizModule: boolean;
  progress: ModuleProgressRow | null;
  isOwner: boolean;
  certId?: number;
  nextModuleId: string | null;
  onBack: () => void;
  onTakeQuiz: () => void;
  onAcknowledge: () => void;
  onBypass: () => void;
  onStart: () => void;
  onDownloadCert: (certId: number) => Promise<void>;
  onOpenModule: (moduleId: string) => void;
  onReturnHome: () => void;
}) {
  const attempts = progress?.attempts ?? 0;
  const maxAttempts = MAX_MODULE_ATTEMPTS;
  const status = progress?.status ?? "not_started";
  // Katie-class invariant (2026-05-21): a passed module is TERMINAL.
  // - SSoT predicate matches the backend (`status === 'passed'` OR
  //   `best_score >= 80`) so a Maribel-pattern row with status lag
  //   still renders the completion banner instead of the quiz CTA.
  // - The quiz UI is fully disallowed on passed modules — no Review,
  //   no Resume, no Retry. The completion banner replaces the bottom
  //   CTA group.
  const bestScore = progress?.best_score ?? 0;
  const isPassed = status === "passed" || bestScore >= 80;
  const atCap = isQuizModule && !isPassed && attempts >= maxAttempts;
  const quizCta =
    status === "failed"
      ? tr("retry_quiz", locale)
      : status === "in_progress" && attempts > 0
      ? tr("resume_quiz", locale)
      : tr("start_quiz", locale);
  useEffect(() => {
    // Katie-class fix: do NOT auto-fire /module/start when the module
    // is already passed. Even with the backend guard in place, skipping
    // the call here keeps the network quiet and makes the frontend
    // contract obvious: passed = terminal, no reopen.
    if (isPassed) return;
    onStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, isPassed]);
  const passedAtLabel = (() => {
    const raw = progress?.passed_at;
    if (!raw) return null;
    try {
      const d = new Date(raw);
      return d.toLocaleDateString(locale === "es" ? "es-US" : "en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return null;
    }
  })();
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
        {/* Attempt counter strip — hidden on passed modules (no more
            attempts to track once you've passed). */}
        {isQuizModule && !isPassed && shouldShowLearnerGating(isOwner) ? (
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
        {isPassed ? (
          // ─ Passed = terminal completion banner ─
          // Replaces the quiz CTA group entirely. Shows:
          //   - "Module completed" + checkmark
          //   - Best score + passed-on date
          //   - "View certificate" (when a cert exists)
          //   - "Continue to next module" (deep-link to first unpassed
          //     downstream module), or "Return to training" if every
          //     module is done.
          // Owner Skip-button stays hidden (status === passed).
          <div
            style={{
              marginTop: 22,
              background: "#ECFDF5",
              border: `1px solid #A7F3D0`,
              borderLeft: `3px solid ${SUCCESS}`,
              borderRadius: 8,
              padding: "14px 16px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: SUCCESS,
                fontWeight: 800,
                fontSize: 14,
              }}
            >
              <CircleCheck size={18} />
              {tr("moduleCompleted", locale)}
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 12,
                color: INK_MUTE,
                fontWeight: 700,
              }}
            >
              {bestScore > 0
                ? `${tr("bestScoreLabel", locale)}: ${bestScore}%`
                : null}
              {bestScore > 0 && passedAtLabel ? " · " : null}
              {passedAtLabel
                ? `${tr("passedOn", locale)} ${passedAtLabel}`
                : null}
            </div>
            <div
              style={{
                marginTop: 14,
                display: "flex",
                gap: 10,
                justifyContent: "flex-end",
                flexWrap: "wrap",
              }}
            >
              {certId ? (
                <SecondaryButton
                  onClick={() =>
                    onDownloadCert(certId).catch((err) =>
                      console.error("[training] download cert failed:", err),
                    )
                  }
                >
                  <Download size={14} /> {tr("viewCertificate", locale)}
                </SecondaryButton>
              ) : null}
              {nextModuleId ? (
                <PrimaryButton onClick={() => onOpenModule(nextModuleId)}>
                  {tr("continueToNextModule", locale)}
                  <ChevronRight size={14} style={{ marginLeft: 4 }} />
                </PrimaryButton>
              ) : (
                <PrimaryButton onClick={onReturnHome}>
                  {tr("returnToTraining", locale)}
                  <ChevronRight size={14} style={{ marginLeft: 4 }} />
                </PrimaryButton>
              )}
            </div>
          </div>
        ) : (
          <div
            style={{
              marginTop: 22,
              display: "flex",
              gap: 10,
              justifyContent: "flex-end",
              flexWrap: "wrap",
            }}
          >
            {isOwner ? (
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
        )}
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
  if (b.type === "image") {
    return (
      <figure style={{ margin: "16px 0" }}>
        <img
          src={b.src}
          alt={b.alt[locale]}
          loading="lazy"
          style={{
            display: "block",
            maxWidth: "100%",
            height: "auto",
            borderRadius: 8,
            border: `1px solid ${LINE}`,
          }}
        />
        {b.caption ? (
          <figcaption
            style={{
              fontSize: 12.5,
              color: INK_MUTE,
              lineHeight: 1.5,
              margin: "6px 2px 0",
            }}
          >
            {b.caption[locale]}
          </figcaption>
        ) : null}
      </figure>
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
  onBypass,
}: {
  curriculum: Curriculum;
  moduleId: string;
  locale: Locale;
  token: string | null;
  priorAttempts: number;
  isOwner: boolean;
  // 2026-05-17: onCancel may be async so parent can refresh /me before
  // routing away (closes stale-attempts-badge bug).
  onCancel: () => void | Promise<void>;
  onPassed: () => Promise<void>;
  // Owner-only escape hatch. Calls /admin/bypass-module then navigates
  // home so the signature step / next module is reachable. Without
  // this, an owner QAing the workflow has to actually answer every
  // question correctly to reach the signature tile — which is not
  // the point of an owner walkthrough.
  onBypass?: () => Promise<void>;
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
  // Item 7 (P1 sprint): per-attempt UUID for server-side deduplication
  // of double-click / slow-network ghost submits. Generated when the
  // QuizView mounts; reset whenever moduleId changes (a new attempt =
  // a new key). Stable across re-renders so a bouncing button doesn't
  // generate multiple keys.
  const idempotencyKeyRef = useRef<string>("");
  if (!idempotencyKeyRef.current) {
    idempotencyKeyRef.current =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `att-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load (or initialize) the quiz state from server.
  useEffect(() => {
    let cancelled = false;
    // Defensive filter (Sal report 2026-05-19): the curriculum's
    // QUESTIONS_BY_MODULE list (and SERVER_ANSWER_KEY) currently
    // reference question ids whose text is missing from the bundled
    // curriculum.quiz bank. Without this filter, the quiz advances to
    // an unresolvable id and renders "Question not found." Drop any
    // id we can't resolve, preserve parallel answers, then proceed.
    const validIdSet = new Set(curriculum.quiz.map((q) => q.id));
    const filterIds = (
      ids: string[],
      ans: (number | null)[] = [],
    ): { ids: string[]; answers: (number | null)[] } => {
      const outIds: string[] = [];
      const outAns: (number | null)[] = [];
      ids.forEach((qid, i) => {
        if (validIdSet.has(qid)) {
          outIds.push(qid);
          outAns.push(ans[i] ?? null);
        } else {
          console.warn(
            `[quiz] dropping unresolvable question id "${qid}" (module=${moduleId})`,
          );
        }
      });
      return { ids: outIds, answers: outAns };
    };

    (async () => {
      try {
        const existing = await lmsApi.getQuizState(token, moduleId);
        if (cancelled) return;
        if (existing) {
          // Resume.
          const filtered = filterIds(
            existing.meta?.question_ids ??
              fixedQuestionIds(curriculum, moduleId),
            existing.answers ?? [],
          );
          setQuestionIds(filtered.ids);
          setAnswers(filtered.answers);
          // Clamp cursor to the new (possibly shorter) list.
          const savedCursor = existing.current_question_index ?? 0;
          setCursor(
            Math.min(savedCursor, Math.max(0, filtered.ids.length - 1)),
          );
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
        const filtered = filterIds(qids);
        setQuestionIds(filtered.ids);
        setAnswers(new Array(filtered.ids.length).fill(null));
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
    // 2026-05-19 (Pattern 2 — corporate compliance standard): build the
    // "questions you missed" breakdown for the fail screen. Shows the
    // prompt + the learner's selection but NOT the correct answer.
    // 2026-05-22: per Sal, both pass AND fail show the full per-question
    // review — every prompt, what the learner selected, what was correct,
    // and a green/red indicator. Final Mixed Test still omits perQuestion
    // (question-bank leakage prevention), so the breakdown is empty for
    // the final.
    const perQuestionReview: Array<{
      index: number;
      prompt: string;
      selected: string | null;
      correct: string | null;
      isCorrect: boolean;
    }> = [];
    if (result.perQuestion) {
      result.perQuestion.forEach((ok, i) => {
        const q = questions[i];
        if (!q) return;
        const selectedIdx = answers[i];
        perQuestionReview.push({
          index: i + 1,
          prompt: q.prompt[locale],
          selected:
            selectedIdx != null && q.options[selectedIdx]
              ? q.options[selectedIdx][locale]
              : null,
          correct: q.options[q.correctIndex]
            ? q.options[q.correctIndex][locale]
            : null,
          isCorrect: ok,
        });
      });
    }
    return (
      <ResultView
        locale={locale}
        result={result}
        attemptsRemaining={attemptsRemaining}
        maxAttempts={result.max_attempts ?? maxAttempts}
        passThreshold={PASS_THRESHOLD_PCT}
        isOwner={isOwner}
        perQuestionReview={perQuestionReview}
        onBypass={onBypass}
        onBackHome={onCancel}
        onRetake={() => {
          // Reset client-side state for a fresh attempt. The server
          // no longer blocks retake-after-pass; stayPassed + best_score
          // GREATEST() preserve the pass record on lower-scoring retakes.
          setAnswers(new Array(questionIds.length).fill(null));
          setCursor(0);
          setResult(null);
        }}
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
      <QuizBrandHeader
        tenantName={curriculum.tenantName}
        tenantLogoUrl={curriculum.tenantLogoUrl}
      />
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
            {/* Owner skip — bypasses the rest of the quiz and marks the
                module passed via /admin/bypass-module. Routes the owner
                home so the next step (signature tile / next module)
                surfaces immediately. Owner-walkthrough QA mode: lets
                the owner emulate the signature flow without having to
                actually answer every question correctly. */}
            {isOwner && onBypass ? (
              <SecondaryButton
                onClick={async () => {
                  if (busy) return;
                  setBusy(true);
                  try {
                    await onBypass();
                  } catch (e) {
                    setError(String((e as Error).message));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <FastForward size={14} /> {tr("bypassOwner", locale)}
              </SecondaryButton>
            ) : null}
            {cursor < total - 1 ? (
              <PrimaryButton
                onClick={() => setCursor((c) => Math.min(total - 1, c + 1))}
                disabled={!isOwner && answers[cursor] == null}
              >
                {tr("next", locale)} <ChevronRight size={14} />
              </PrimaryButton>
            ) : (
              <PrimaryButton
                disabled={busy || (!isOwner && !allAnswered)}
                onClick={async () => {
                  // Item 7 (P1 sprint): debounce — `busy` flips
                  // synchronously here, so a second click within the
                  // same render frame is ignored by the disabled
                  // guard above. The idempotency_key acts as a
                  // backstop when the click + network race lands
                  // multiple POSTs at the server in the same tick.
                  if (busy) return;
                  setBusy(true);
                  try {
                    const r = await lmsApi.submitQuiz(
                      token,
                      moduleId,
                      answers,
                      questionIds,
                      idempotencyKeyRef.current,
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

/**
 * QuizBrandHeader — 2026-05-20.
 *
 * Branded header shown at the top of every QuizView (per-module and
 * final exam). Phes tenant logo is prominent on the top-left; the
 * Qleno wordmark sits on the top-right as a smaller secondary mark.
 * Adds brand reinforcement to the quiz-taking surface, which was
 * previously chromeless (just BackLink → question content).
 *
 * Phes logo: 64px desktop, 48px mobile.
 * Qleno mark: small (md) horizontal.
 * Thin bottom border in LINE color.
 */
function QuizBrandHeader({
  tenantName,
  tenantLogoUrl,
}: {
  tenantName: string;
  tenantLogoUrl?: string;
}) {
  const isMobile = useIsMobile();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        paddingBottom: 12,
        marginBottom: 16,
        borderBottom: `1px solid ${LINE}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        {tenantLogoUrl ? (
          <img
            src={tenantLogoUrl}
            alt={tenantName}
            style={{
              height: isMobile ? 48 : 64,
              width: "auto",
              objectFit: "contain",
              flexShrink: 0,
            }}
          />
        ) : (
          <span
            style={{
              fontWeight: 800,
              fontSize: isMobile ? 20 : 28,
              letterSpacing: "-0.02em",
              color: INK,
            }}
          >
            {tenantName}
          </span>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>
        <QlenoLogo size={isMobile ? "sm" : "md"} theme="light" layout="horizontal" />
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
  perQuestionReview,
  onBypass,
  onContinue,
  onRetake,
  onBackHome,
}: {
  locale: Locale;
  result: SubmitResult;
  attemptsRemaining: number;
  maxAttempts: number;
  passThreshold: number;
  isOwner: boolean;
  /**
   * Owner-only escape hatch shown on the FAILED result. Calls
   * /admin/bypass-module then navigates home so the signature tile is
   * reachable without grinding through the quiz with correct answers.
   */
  onBypass?: () => Promise<void>;
  /**
   * 2026-05-22 (Sal): the full per-question review — every question
   * with prompt, learner's selection, the correct option, and a
   * green/red indicator. Shown on BOTH pass and fail so employees can
   * learn from what they got right and wrong. Final Mixed Test omits
   * perQuestion on purpose so this is empty for the final.
   */
  perQuestionReview?: Array<{
    index: number;
    prompt: string;
    selected: string | null;
    correct: string | null;
    isCorrect: boolean;
  }>;
  onContinue: () => void;
  onRetake: () => void;
  onBackHome: () => void | Promise<void>;
}) {
  const { passed, score } = result;
  // Owners are never "out of attempts" — the server bypasses the cap
  // and the UI matches that. Treat as if attempts remain.
  const noMoreRetries =
    !passed && shouldShowLearnerGating(isOwner) && attemptsRemaining <= 0;
  return (
    <div
      style={{
        maxWidth: perQuestionReview && perQuestionReview.length > 0 ? 640 : 480,
        margin: "60px auto",
        padding: 18,
      }}
    >
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
        {/* 2026-05-22 (Sal): full per-question review — green for correct,
            red for wrong, learner's selection shown, correct answer
            revealed for wrong ones so the learner knows what they should
            have picked. Shown on BOTH pass and fail. Final test still
            hides this because perQuestion is omitted there on purpose. */}
        {perQuestionReview && perQuestionReview.length > 0 ? (
          <div
            style={{
              marginTop: 18,
              textAlign: "left",
              borderTop: `1px solid ${LINE}`,
              paddingTop: 16,
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 800,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: INK,
                marginBottom: 10,
              }}
            >
              {(() => {
                const correctCount = perQuestionReview.filter((r) => r.isCorrect).length;
                const total = perQuestionReview.length;
                return locale === "es"
                  ? `Revisión por pregunta (${correctCount} de ${total} correctas)`
                  : `Question-by-question review (${correctCount} of ${total} correct)`;
              })()}
            </div>
            <ul
              style={{
                margin: 0,
                padding: 0,
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              {perQuestionReview.map((r) => (
                <li
                  key={r.index}
                  style={{
                    fontSize: 12.5,
                    color: INK,
                    lineHeight: 1.45,
                    paddingLeft: 22,
                    position: "relative",
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 1,
                      color: r.isCorrect ? SUCCESS : DANGER,
                      fontWeight: 800,
                    }}
                    aria-hidden="true"
                  >
                    {r.isCorrect ? "✓" : "✗"}
                  </span>
                  <div style={{ fontWeight: 700, marginBottom: 3 }}>
                    {locale === "es" ? "Pregunta" : "Question"} {r.index}.{" "}
                    {r.prompt}
                  </div>
                  {r.selected != null ? (
                    <div
                      style={{
                        color: r.isCorrect ? SUCCESS : DANGER,
                        fontSize: 12,
                      }}
                    >
                      {locale === "es" ? "Su respuesta: " : "Your answer: "}
                      {r.selected}
                    </div>
                  ) : (
                    <div style={{ color: INK_MUTE, fontSize: 12, fontStyle: "italic" }}>
                      {locale === "es" ? "Sin respuesta seleccionada" : "No answer selected"}
                    </div>
                  )}
                  {!r.isCorrect && r.correct != null ? (
                    <div
                      style={{
                        color: SUCCESS,
                        fontSize: 12,
                        marginTop: 2,
                      }}
                    >
                      {locale === "es" ? "Respuesta correcta: " : "Correct answer: "}
                      {r.correct}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div
          style={{
            marginTop: 18,
            display: "flex",
            gap: 10,
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          {/* 2026-05-22 (Sal): retake is always offered, on pass and on
              fail. On pass the primary CTA stays "Next" (continue to the
              next module); on fail the primary stays "Try again" when
              retries remain. The "Back to home" secondary is also kept
              everywhere except after a no-retries-left fail. */}
          {!passed && !noMoreRetries ? (
            <SecondaryButton onClick={() => { void onBackHome(); }}>
              {tr("back", locale)}
            </SecondaryButton>
          ) : null}
          {passed && attemptsRemaining > 0 ? (
            <SecondaryButton onClick={onRetake}>
              {tr("retry", locale)}
            </SecondaryButton>
          ) : null}
          {/* Owner-only bypass shown when the attempt did not pass.
              Marks the module passed via /admin/bypass-module then
              routes home so the next employee-flow step (signature
              tile / next module) is reachable. Lets the owner emulate
              the full LMS workflow end-to-end without having to score
              80% on every quiz themselves. */}
          {!passed && isOwner && onBypass ? (
            <SecondaryButton
              onClick={() => {
                void onBypass();
              }}
            >
              <FastForward size={14} /> {tr("bypassOwner", locale)}
            </SecondaryButton>
          ) : null}
          <PrimaryButton onClick={passed ? onContinue : onContinue}>
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
// SignedDocTile — already-signed acknowledgment row with View PDF button.
// ─────────────────────────────────────────────────────────────────────────────
//
// Rendered in the home view "Your signed documents" section. Gives the
// owner (and any learner) a way to re-open the PDF for an ack they've
// already signed. Pre-fix there was no such surface: signing made the
// pending tile disappear and no replacement appeared, so the owner
// couldn't verify the generated PDF without poking at the database.

function SignedDocTile({
  locale,
  title,
  signedDocumentId,
  token,
}: {
  locale: Locale;
  title: string;
  signedDocumentId: number;
  token: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isNarrow = useIsMobile();
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: isNarrow ? "auto 1fr" : "auto 1fr auto",
        alignItems: "center",
        gap: 12,
        background: SURFACE,
        border: `1px solid ${LINE}`,
        borderLeft: `4px solid ${SUCCESS}`,
        borderRadius: RADIUS,
        padding: "12px 14px",
        fontFamily: FONT,
      }}
    >
      <CircleCheck size={18} style={{ color: SUCCESS }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 14, color: INK }}>
          {title}
        </div>
        <div style={{ fontSize: 11.5, color: INK_MUTE, marginTop: 2 }}>
          {locale === "es" ? "Firmado" : "Signed"} · #{signedDocumentId}
        </div>
        {error ? (
          <div
            style={{
              marginTop: 6,
              color: DANGER,
              fontSize: 11.5,
              wordBreak: "break-word",
            }}
          >
            {error}
          </div>
        ) : null}
      </div>
      <SecondaryButton
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await viewSignedDocumentPdf(token, signedDocumentId);
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
          <Download size={14} />
        )}
        {locale === "es" ? "Ver PDF" : "View PDF"}
      </SecondaryButton>
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
  // Post-sign confirmation state. Captured from the POST /sign response
  // so the success screen can render the timestamp + open the generated
  // PDF without an extra round-trip. Mirrors HandbookSignView's signedAt
  // pattern. Owners testing the flow couldn't previously see the PDF
  // they just produced — the tile would disappear and there was no
  // surface to view what got generated. This closes that gap for the
  // six standalone signed acknowledgments.
  const [signedAt, setSignedAt] = useState<string | null>(null);
  const [signedDocumentId, setSignedDocumentId] = useState<number | null>(null);
  // PDF-view error kept separate from the load/sign error so a failed
  // view-PDF click doesn't blow away the confirmation card.
  const [pdfError, setPdfError] = useState<string | null>(null);

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

  // Post-sign confirmation screen. Shows the signed timestamp + a
  // "View signed PDF" button that streams /lms/signatures/:id/pdf and
  // opens it in a new tab. The auto-close is intentionally long so the
  // owner can read the confirmation and tap the View button. Tapping
  // "Return to training" forces an immediate refresh + home navigation.
  if (signedAt && signedDocumentId !== null && content) {
    return (
      <SignedDocConfirmation
        locale={locale}
        documentTitle={content.title}
        signedAt={signedAt}
        signerName={name.trim()}
        token={token}
        signedDocumentId={signedDocumentId}
        pdfError={pdfError}
        onViewPdf={async () => {
          setPdfError(null);
          try {
            await viewSignedDocumentPdf(token, signedDocumentId);
          } catch (e) {
            setPdfError(String((e as Error).message));
          }
        }}
        onClose={onSigned}
      />
    );
  }

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
        {!content && !error ? (
          <div
            style={{ padding: 40, textAlign: "center", color: INK_MUTE }}
          >
            <Loader2 className="qleno-spin" size={20} />
          </div>
        ) : !content && error ? (
          // Content failed to load: render a recoverable error card.
          // Previously this branch fell through to the loader and the
          // user saw a spinner forever — they had no way to know GET
          // /content failed unless they opened devtools.
          <div>
            <div
              style={{
                background: "#FEF2F2",
                border: `1px solid #FECACA`,
                borderLeft: `3px solid ${DANGER}`,
                color: DANGER,
                padding: 12,
                borderRadius: 6,
                fontSize: 13,
                lineHeight: 1.55,
                wordBreak: "break-word",
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {locale === "es"
                  ? "No se pudo cargar el documento"
                  : "Could not load the document"}
              </div>
              {error}
            </div>
            <div
              style={{
                marginTop: 14,
                display: "flex",
                gap: 10,
                justifyContent: "flex-end",
              }}
            >
              <SecondaryButton onClick={onCancel}>
                {tr("back", locale)}
              </SecondaryButton>
            </div>
          </div>
        ) : content ? (
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

            {/* Inline submit error — kept ABOVE the action row so the
                form stays mounted and the user can retry. Pre-fix this
                error replaced the entire form so a transient 400/500
                looked like a hard crash. */}
            {error ? (
              <div
                style={{
                  marginTop: 14,
                  background: "#FEF2F2",
                  border: `1px solid #FECACA`,
                  borderLeft: `3px solid ${DANGER}`,
                  color: DANGER,
                  padding: 12,
                  borderRadius: 6,
                  fontSize: 13,
                  lineHeight: 1.55,
                  wordBreak: "break-word",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  {locale === "es"
                    ? "No se pudo registrar la firma"
                    : "Could not record the signature"}
                </div>
                {error}
              </div>
            ) : null}

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
                  setError(null);
                  try {
                    const result = await lmsApi.signDocument(token, {
                      documentType,
                      locale,
                      signatureMethod: "typed",
                      signature: name.trim(),
                    });
                    // Stamp the confirmation card with the server's
                    // canonical signed_at + id. Don't call onSigned
                    // yet — that navigates away and unmounts; the
                    // owner needs to see the PDF first.
                    setSignedDocumentId(result.id);
                    setSignedAt(result.signed_at);
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
        ) : null}
      </div>
    </div>
  );
}

// SignedDocConfirmation — post-sign success screen for the 6 standalone
// acknowledgments. Mirrors HandbookSignedConfirmation but routes the PDF
// fetch through /lms/signatures/:id/pdf and uses an open-in-new-tab
// "View" verb instead of "Download" because the owner's first need is
// confirming the PDF exists + looks correct. The 8-second auto-close
// matches the handbook flow so the screen doesn't trap the learner.
// ─────────────────────────────────────────────────────────────────────────────

function SignedDocConfirmation({
  locale,
  documentTitle,
  signedAt,
  signerName,
  token,
  signedDocumentId,
  pdfError,
  onViewPdf,
  onClose,
}: {
  locale: Locale;
  documentTitle: string;
  signedAt: string;
  signerName: string;
  token: string | null;
  signedDocumentId: number;
  pdfError: string | null;
  onViewPdf: () => Promise<void>;
  onClose: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  // Long enough that the owner can read the screen and tap "View PDF"
  // without it auto-dismissing mid-action.
  useEffect(() => {
    const t = setTimeout(() => {
      void onClose();
    }, 12_000);
    return () => clearTimeout(t);
  }, [onClose]);

  const dt = new Date(signedAt);
  const formatted = `${dt.toLocaleDateString(
    locale === "es" ? "es-MX" : "en-US",
  )} ${dt.toLocaleTimeString(
    locale === "es" ? "es-MX" : "en-US",
    { hour: "2-digit", minute: "2-digit" },
  )}`;

  return (
    <div
      style={{
        maxWidth: 560,
        margin: "40px auto",
        padding: "26px 24px",
        background: SURFACE,
        border: `1px solid ${LINE}`,
        borderRadius: RADIUS,
        textAlign: "center",
        fontFamily: FONT,
      }}
    >
      <CircleCheck size={48} style={{ color: SUCCESS, margin: "0 auto" }} />
      <div
        style={{
          fontSize: 20,
          fontWeight: 800,
          color: INK,
          marginTop: 12,
        }}
      >
        {locale === "es" ? "Firma registrada" : "Signature recorded"}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: INK,
          marginTop: 4,
        }}
      >
        {documentTitle}
      </div>
      <div
        style={{
          fontSize: 13,
          color: INK_MUTE,
          marginTop: 8,
          lineHeight: 1.5,
        }}
      >
        {locale === "es" ? "Firmado por" : "Signed by"}
        <span style={{ fontWeight: 700, color: INK }}> {signerName}</span>
        <br />
        {formatted} ·{" "}
        {locale === "es" ? "firma escrita" : "typed signature"}
      </div>

      {pdfError ? (
        <div
          style={{
            marginTop: 14,
            background: "#FEF2F2",
            border: `1px solid #FECACA`,
            borderLeft: `3px solid ${DANGER}`,
            color: DANGER,
            padding: 10,
            borderRadius: 6,
            fontSize: 12,
            lineHeight: 1.55,
            textAlign: "left",
            wordBreak: "break-word",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            {locale === "es"
              ? "No se pudo abrir el PDF"
              : "Could not open the PDF"}
          </div>
          {pdfError}
        </div>
      ) : null}

      <div
        style={{
          marginTop: 20,
          display: "flex",
          gap: 10,
          justifyContent: "center",
          flexWrap: "wrap",
        }}
      >
        <PrimaryButton
          onClick={async () => {
            setBusy(true);
            try {
              await onViewPdf();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <Loader2 size={14} className="qleno-spin" />
          ) : (
            <Download size={14} />
          )}
          {locale === "es" ? "Ver PDF firmado" : "View signed PDF"}
        </PrimaryButton>
        <SecondaryButton
          onClick={() => {
            void onClose();
          }}
        >
          {locale === "es" ? "Volver al entrenamiento" : "Return to training"}
        </SecondaryButton>
      </div>
      <div
        style={{
          marginTop: 16,
          fontSize: 11,
          color: INK_LIGHT,
        }}
      >
        {locale === "es"
          ? `Documento firmado #${signedDocumentId} · esta pantalla se cerrará automáticamente.`
          : `Signed document #${signedDocumentId} · this screen will close automatically.`}
      </div>
      {/* token is referenced so eslint doesn't flag the prop as unused;
          the actual fetch happens inside onViewPdf which closes over
          the same token in the parent component. */}
      <span style={{ display: "none" }} aria-hidden>
        {token ? "" : ""}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HandbookCard — final tile after the final exam. Shows compliance state
// (eligible / locked / signed) and the CTA to sign or download.
// ─────────────────────────────────────────────────────────────────────────────

function HandbookCard({
  locale,
  eligible,
  eligibility,
  signedDocumentId,
  isOwner,
  onSign,
  onDownload,
  onPreview,
}: {
  locale: Locale;
  eligible: boolean;
  eligibility: HandbookEligibility | null;
  signedDocumentId: number | null;
  isOwner: boolean;
  onSign: () => void;
  onDownload: () => Promise<void>;
  onPreview: () => Promise<void>;
}) {
  const signed = signedDocumentId !== null;
  const stripeColor = signed ? SUCCESS : eligible ? WARN : INK_LIGHT;
  const isNarrow = useIsMobile();

  return (
    <div
      style={{
        background: SURFACE,
        border: `1px solid ${LINE}`,
        borderLeft: `4px solid ${stripeColor}`,
        borderRadius: RADIUS,
        padding: "16px 18px",
        display: "grid",
        gridTemplateColumns: isNarrow ? "1fr" : "auto 1fr auto",
        alignItems: isNarrow ? "stretch" : "center",
        gap: isNarrow ? 10 : 14,
        fontFamily: FONT,
      }}
    >
      <FileSignature
        size={isNarrow ? 18 : 22}
        style={{ color: stripeColor, justifySelf: isNarrow ? "start" : "auto" }}
      />
      <div>
        <div
          style={{
            fontWeight: 800,
            fontSize: 15,
            color: INK,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          {locale === "es"
            ? "Manual Integral del Empleado"
            : "Comprehensive Employee Handbook"}
          {signed ? (
            <span
              style={{
                fontSize: 11,
                fontWeight: 800,
                color: SUCCESS,
                background: "#ECFDF5",
                padding: "2px 8px",
                borderRadius: 999,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              {locale === "es" ? "Firmado" : "Signed"}
            </span>
          ) : null}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: INK_MUTE,
            marginTop: 4,
            lineHeight: 1.55,
          }}
        >
          {signed
            ? locale === "es"
              ? "Manual firmado. Descargue su copia para sus registros."
              : "Handbook signed. Download your copy for your records."
            : eligible
            ? locale === "es"
              ? "Último paso. Firme el manual integral para completar la incorporación."
              : "Final step. Sign the comprehensive handbook to complete onboarding."
            : locale === "es"
            ? `Termine los ${QUIZ_MODULE_IDS.length} módulos + el Examen Final Mixto + los reconocimientos firmados para desbloquear el manual.`
            : `All ${QUIZ_MODULE_IDS.length} modules + Final Mixed Test + signed acknowledgments must be complete before signing the handbook.`}
        </div>
        {!signed && !eligible && eligibility ? (
          <HandbookGateHint eligibility={eligibility} locale={locale} />
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: isNarrow ? "row" : "column",
          gap: 8,
          justifyContent: isNarrow ? "flex-end" : "flex-start",
          flexWrap: "wrap",
        }}
      >
        {isOwner && !signed ? (
          <SecondaryButton
            onClick={() => {
              onPreview().catch((e) => {
                alert(String((e as Error).message));
              });
            }}
          >
            <Download size={14} />
            {locale === "es" ? "Vista previa" : "Preview"}
          </SecondaryButton>
        ) : null}
        {signed ? (
          <SecondaryButton
            onClick={() => {
              onDownload().catch((e) => {
                alert(String((e as Error).message));
              });
            }}
          >
            <Download size={14} />
            {locale === "es" ? "Descargar" : "Download"}
          </SecondaryButton>
        ) : (
          <PrimaryButton disabled={!eligible && !isOwner} onClick={onSign}>
            {locale === "es" ? "Firmar manual" : "Sign handbook"}
            <ChevronRight size={14} />
          </PrimaryButton>
        )}
      </div>
    </div>
  );
}

// Owner-only preview: fetches GET /api/lms/handbook/preview?locale=X
// with the auth header, converts the PDF blob to an object URL, and
// opens it in a new tab. Same pattern as downloadCertificatePdf and
// downloadHandbookPdf so the auth-protected endpoint stays reachable.
async function previewHandbookPdf(
  token: string | null,
  locale: Locale,
): Promise<void> {
  const url = `${API_BASE}/lms/handbook/preview?locale=${locale}`;
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET /lms/handbook/preview → ${res.status}: ${text}`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  window.open(objectUrl, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

function HandbookGateHint({
  eligibility,
  locale,
}: {
  eligibility: HandbookEligibility;
  locale: Locale;
}) {
  const bits: string[] = [];
  if (eligibility.missing_modules.length > 0) {
    bits.push(
      locale === "es"
        ? `${eligibility.missing_modules.length} módulo(s) por aprobar`
        : `${eligibility.missing_modules.length} module(s) to pass`,
    );
  }
  if (eligibility.missing_signed_docs.length > 0) {
    bits.push(
      locale === "es"
        ? `${eligibility.missing_signed_docs.length} reconocimiento(s) por firmar`
        : `${eligibility.missing_signed_docs.length} acknowledgment(s) to sign`,
    );
  }
  if (!eligibility.final_exam_passed) {
    bits.push(
      locale === "es"
        ? "Examen final mixto pendiente"
        : "Final mixed exam pending",
    );
  }
  if (bits.length === 0) return null;
  return (
    <div
      style={{
        marginTop: 6,
        fontSize: 11.5,
        color: INK_LIGHT,
        lineHeight: 1.5,
      }}
    >
      {bits.join(" · ")}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HandbookSignView — comprehensive handbook signing flow.
//
// Per legal requirement: the employee MUST scroll to the bottom of the
// handbook content before the affirmation checkbox is enabled. This is
// the click-to-sign equivalent of "read and understood" — they cannot
// opt-in without having visibly traversed the content.
//
// On successful sign the server returns the new signed_document_id; we
// fire-and-forget a fetch of the PDF so the browser caches it, then
// return to home. The Download button on HandbookCard pulls it on demand.
// ─────────────────────────────────────────────────────────────────────────────

// Item 5 (onboarding-readiness sprint 2026-05-15): the handbook
// content source includes `## Section heading` lines as the only
// markdown construct. Rendering the whole string in a `pre-wrap`
// div leaked the literal `##` characters. This component splits on
// blank lines into paragraphs and renders any `## Foo` line as an
// <h2>. Content is server-controlled (no user-supplied markup), so
// inline string handling is safe.
function HandbookBody({ source }: { source: string }) {
  const blocks = source.split(/\n{2,}/);
  return (
    <>
      {blocks.map((raw, i) => {
        const trimmed = raw.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith("## ")) {
          return (
            <h2
              key={i}
              style={{
                fontFamily: FONT,
                fontWeight: 800,
                fontSize: 15,
                color: INK,
                margin: "16px 0 6px",
                letterSpacing: "-0.01em",
              }}
            >
              {trimmed.replace(/^##\s+/, "")}
            </h2>
          );
        }
        return (
          <p
            key={i}
            style={{
              fontFamily: FONT,
              margin: "0 0 10px",
              color: INK,
              fontSize: 13.5,
              lineHeight: 1.65,
              whiteSpace: "pre-wrap",
            }}
          >
            {trimmed}
          </p>
        );
      })}
    </>
  );
}

function HandbookSignView({
  locale,
  setLocale,
  learner,
  token,
  eligibility,
  onCancel,
  onSigned,
}: {
  locale: Locale;
  setLocale: (l: Locale) => void;
  learner: Learner | null;
  token: string | null;
  eligibility: HandbookEligibility | null;
  onCancel: () => void;
  onSigned: () => Promise<void>;
}) {
  const [content, setContent] = useState<SignedDocumentContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Item 5 (P0 sprint): the typed-signature field on the Final Handbook
  // is the legal point of the page. Pre-filling it with learner's first
  // name (or any name) defeats the affirmative-action requirement of
  // UETA / E-SIGN. Start empty; the employee must type their full
  // legal name to enable the Sign button.
  const [name, setName] = useState("");
  const [affirmed, setAffirmed] = useState(false);
  const [scrolledToEnd, setScrolledToEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<"typed" | "drawn">("typed");
  const [drawnDataUrl, setDrawnDataUrl] = useState<string>("");
  const [signedAt, setSignedAt] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Reset the scroll-to-end gate whenever locale (and thus content) changes.
  useEffect(() => {
    setScrolledToEnd(false);
    setAffirmed(false);
  }, [locale]);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    (async () => {
      try {
        const data = await lmsApi.getSignedDocumentContent(
          token,
          "handbook",
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
  }, [locale, token]);

  // If the content is shorter than the viewport, there is nothing to
  // scroll — treat it as "read to end" on mount.
  useEffect(() => {
    if (!content) return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + 2) {
      setScrolledToEnd(true);
    }
  }, [content]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining < 8) {
      setScrolledToEnd(true);
    }
  }, []);

  const canAffirm = scrolledToEnd;
  const signaturePayloadReady =
    method === "typed"
      ? name.trim().length >= 2
      : drawnDataUrl.length > 0;
  const canSubmit =
    !busy &&
    affirmed &&
    canAffirm &&
    name.trim().length >= 2 &&
    signaturePayloadReady &&
    content !== null &&
    !!eligibility?.eligible;

  // Post-sign confirmation screen. Renders for ~5 s with a Download
  // button before refreshing into home; the learner can also tap
  // "Return to training" to skip the auto-close.
  if (signedAt) {
    return (
      <HandbookSignedConfirmation
        locale={locale}
        signedAt={signedAt}
        signerName={name.trim()}
        signatureMethod={method}
        token={token}
        onClose={async () => {
          await onSigned();
        }}
      />
    );
  }

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "20px 18px" }}>
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
          <div style={{ padding: 40, textAlign: "center", color: INK_MUTE }}>
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
                marginBottom: 8,
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 22, color: INK }}>
                {content.title}
              </div>
              <LocaleToggle locale={locale} setLocale={setLocale} />
            </div>

            <div style={{ fontSize: 12.5, color: INK_MUTE, marginBottom: 14 }}>
              {locale === "es"
                ? "Desplácese hasta el final del manual para activar la firma. Su firma electrónica tiene el mismo efecto legal que una manuscrita (UETA / E-SIGN)."
                : "Scroll to the bottom of the handbook to enable signing. Your electronic signature has the same legal effect as a handwritten one (UETA / E-SIGN)."}
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
                    ? "Esta traducción al español está bajo revisión profesional. La versión en inglés es vinculante hasta que la traducción final sea aprobada."
                    : "This Spanish translation is under professional review. The English version is binding until the final translation is approved."}
                </div>
              </div>
            ) : null}

            <div
              ref={scrollRef}
              onScroll={onScroll}
              style={{
                background: PAGE_BG,
                border: `1px solid ${LINE_SOFT}`,
                borderRadius: 8,
                padding: "18px 20px",
                height: 420,
                overflowY: "auto",
                fontSize: 13.5,
                color: INK,
                lineHeight: 1.65,
                fontFamily: FONT,
              }}
            >
              <HandbookBody source={content.contentHtml} />
            </div>

            <div
              style={{
                marginTop: 8,
                fontSize: 11.5,
                fontWeight: 700,
                color: scrolledToEnd ? SUCCESS : INK_LIGHT,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {scrolledToEnd ? (
                <>
                  <CircleCheck size={14} />
                  {locale === "es"
                    ? "Manual leído completo"
                    : "Handbook read in full"}
                </>
              ) : (
                <>
                  {locale === "es"
                    ? "Desplácese hasta el final para continuar"
                    : "Scroll to the bottom to continue"}
                </>
              )}
            </div>

            <label
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                marginTop: 18,
                fontSize: 13,
                color: canAffirm ? INK : INK_LIGHT,
                lineHeight: 1.55,
                cursor: canAffirm ? "pointer" : "not-allowed",
              }}
            >
              <input
                type="checkbox"
                checked={affirmed}
                disabled={!canAffirm}
                onChange={(e) => setAffirmed(e.target.checked)}
                style={{ marginTop: 4, flexShrink: 0 }}
              />
              <span>
                {locale === "es"
                  ? `He leído y comprendido el ${content.title} en su totalidad. Acepto sus términos y entiendo que mi firma electrónica tiene el mismo efecto legal que una firma manuscrita (UETA / E-SIGN).`
                  : `I have read and understand the ${content.title} in its entirety. I accept its terms and understand that my electronic signature has the same legal effect as a handwritten signature (UETA / E-SIGN).`}
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
              {locale === "es" ? "Método de firma" : "Signature method"}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
              <MethodToggleButton
                active={method === "typed"}
                onClick={() => setMethod("typed")}
                label={locale === "es" ? "Escrita" : "Typed"}
              />
              <MethodToggleButton
                active={method === "drawn"}
                onClick={() => setMethod("drawn")}
                label={locale === "es" ? "Dibujada" : "Drawn"}
              />
            </div>

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

            {method === "drawn" ? (
              <div style={{ marginTop: 12 }}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: INK_MUTE,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    marginBottom: 6,
                  }}
                >
                  {locale === "es"
                    ? "Dibuje su firma debajo"
                    : "Draw your signature below"}
                </div>
                <SignaturePad
                  value={drawnDataUrl}
                  onChange={setDrawnDataUrl}
                  locale={locale}
                />
              </div>
            ) : null}

            <div
              style={{
                marginTop: 10,
                fontSize: 11,
                color: INK_LIGHT,
                lineHeight: 1.45,
              }}
            >
              {locale === "es"
                ? "La fecha, la hora, la dirección IP y el dispositivo se registran automáticamente al firmar (registro de auditoría UETA)."
                : "Date, time, IP address, and device are recorded automatically at signing (UETA audit log)."}
            </div>

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
                  setError(null);
                  try {
                    const payload =
                      method === "drawn" ? drawnDataUrl : name.trim();
                    const result = await lmsApi.signHandbook(token, {
                      locale,
                      signatureMethod: method,
                      signature: payload,
                    });
                    setSignedAt(result.signed_at);
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
                  "Firmar manual"
                ) : (
                  "Sign handbook"
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
// PendingReAckTile — surfaces outstanding annual / force-resign re-acks.
//
// Shown at the top of the home view when GET /api/lms/annual-ack/me/pending
// returns a non-empty `active` array. Currently the only annual document
// is "handbook", so the CTA routes through the handbook signing flow. If
// future documents are added to ANNUAL_DOCUMENT_TYPES, this tile gains a
// per-document CTA — for now the single CTA is enough.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// RecomputeBanner — surfaces the server-side completion recompute.
//
// Rendered at the top of /training home when GET /api/lms/me's response
// carried status_was_recomputed = true. Tells the employee why their
// "completed" splash disappeared in a non-alarming way and offers a
// dismiss. Dismiss state lives in localStorage keyed by user so it
// sticks across sessions without nagging.
// ─────────────────────────────────────────────────────────────────────────────

function RecomputeBanner({
  locale,
  onDismiss,
}: {
  locale: Locale;
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        background: "#FFFBEB",
        border: `1px solid #FDE68A`,
        borderLeft: `4px solid ${WARN}`,
        borderRadius: RADIUS,
        padding: "14px 18px",
        marginBottom: 18,
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: 14,
        fontFamily: FONT,
      }}
    >
      <Info size={22} style={{ color: WARN }} />
      <div>
        <div style={{ fontWeight: 800, fontSize: 14.5, color: INK }}>
          {locale === "es"
            ? "Requisitos de capacitación actualizados"
            : "Training requirements updated"}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: INK_MUTE,
            marginTop: 4,
            lineHeight: 1.55,
          }}
        >
          {locale === "es"
            ? "Actualizamos recientemente los requisitos de capacitación. Tiene algunos elementos más por completar. Tómese su tiempo, no hay penalización, solo termine los pendientes a su propio ritmo."
            : "We recently updated the training requirements. You have a few more items to complete. Take your time, there is no penalty, just check off the pending tiles below at your own pace."}
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        style={{
          background: "transparent",
          color: INK_MUTE,
          border: `1px solid ${LINE}`,
          padding: "6px 12px",
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 700,
          fontFamily: FONT,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {locale === "es" ? "Entendido" : "Got it"}
      </button>
    </div>
  );
}

function PendingReAckTile({
  locale,
  pending,
  onResign,
}: {
  locale: Locale;
  pending: PendingReAckSummary;
  onResign: () => void;
}) {
  const count = pending.active.length;
  const docTypes = Array.from(
    new Set(pending.active.map((p) => p.document_type)),
  );
  const reasons = Array.from(
    new Set(pending.active.map((p) => p.trigger_reason)),
  );
  const anyAnnual = reasons.includes("annual_cycle");
  return (
    <div
      style={{
        background: "#FFFBEB",
        border: `1px solid #FDE68A`,
        borderLeft: `4px solid ${WARN}`,
        borderRadius: RADIUS,
        padding: "14px 18px",
        marginBottom: 18,
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: 14,
        fontFamily: FONT,
      }}
    >
      <AlertTriangle size={22} style={{ color: WARN }} />
      <div>
        <div style={{ fontWeight: 800, fontSize: 14.5, color: INK }}>
          {locale === "es"
            ? count === 1
              ? "Tiene un reconocimiento pendiente"
              : `Tiene ${count} reconocimientos pendientes`
            : count === 1
            ? "You have a re-acknowledgment pending"
            : `You have ${count} re-acknowledgments pending`}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: INK_MUTE,
            marginTop: 4,
            lineHeight: 1.55,
          }}
        >
          {anyAnnual
            ? locale === "es"
              ? "Política anual: vuelva a firmar para confirmar que comprende los términos actualizados."
              : "Annual policy: re-sign to confirm you understand the current terms."
            : locale === "es"
            ? "Cambio de política: vuelva a firmar el documento actualizado para mantenerse en cumplimiento."
            : "Policy update: re-sign the updated document to stay in compliance."}
        </div>
        <div
          style={{
            fontSize: 11,
            color: INK_LIGHT,
            marginTop: 4,
          }}
        >
          {docTypes.map((t) => humanSignedDocType(t, locale)).join(" · ")}
        </div>
      </div>
      <button
        type="button"
        onClick={onResign}
        style={{
          background: WARN,
          color: "#fff",
          border: 0,
          padding: "8px 14px",
          borderRadius: 8,
          fontSize: 12.5,
          fontWeight: 800,
          fontFamily: FONT,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {locale === "es" ? "Volver a firmar →" : "Re-sign →"}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MethodToggleButton — pill-style segmented toggle for signature method.
// ─────────────────────────────────────────────────────────────────────────────

function MethodToggleButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "8px 14px",
        borderRadius: 999,
        fontSize: 13,
        fontFamily: FONT,
        fontWeight: 700,
        cursor: "pointer",
        background: active ? NAVY : SURFACE,
        color: active ? "#fff" : INK,
        border: `1px solid ${active ? NAVY : LINE}`,
      }}
    >
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SignaturePad — minimal HTML canvas signature capture. Exports a PNG
// data URL via toDataURL() on every stroke end. Touch + mouse supported.
// The "drawn signature on file" placeholder in the PDF renderer is the
// v1 fallback; the raw data URL is still stored on the signed_document
// row so the audit chain has the bytes.
// ─────────────────────────────────────────────────────────────────────────────

function SignaturePad({
  value,
  onChange,
  locale,
}: {
  value: string;
  onChange: (dataUrl: string) => void;
  locale: Locale;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);

  const getCtx = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return null;
    return c.getContext("2d");
  }, []);

  // Set up canvas DPI on mount.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = INK;
    }
  }, []);

  const pointFromEvent = (
    e: React.MouseEvent | React.TouchEvent,
  ): { x: number; y: number } | null => {
    const c = canvasRef.current;
    if (!c) return null;
    const rect = c.getBoundingClientRect();
    if ("touches" in e) {
      const t = e.touches[0] ?? e.changedTouches[0];
      if (!t) return null;
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const start = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    drawing.current = true;
    lastPoint.current = pointFromEvent(e);
  };
  const move = (e: React.MouseEvent | React.TouchEvent) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = getCtx();
    const p = pointFromEvent(e);
    if (!ctx || !p || !lastPoint.current) return;
    ctx.beginPath();
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastPoint.current = p;
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    lastPoint.current = null;
    const c = canvasRef.current;
    if (c) onChange(c.toDataURL("image/png"));
  };
  const clear = () => {
    const c = canvasRef.current;
    const ctx = getCtx();
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    onChange("");
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        onMouseDown={start}
        onMouseMove={move}
        onMouseUp={end}
        onMouseLeave={end}
        onTouchStart={start}
        onTouchMove={move}
        onTouchEnd={end}
        style={{
          width: "100%",
          height: 140,
          background: PAGE_BG,
          border: `1px dashed ${LINE}`,
          borderRadius: 8,
          touchAction: "none",
          cursor: "crosshair",
          display: "block",
        }}
      />
      <div
        style={{
          marginTop: 6,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 11.5,
          color: INK_LIGHT,
        }}
      >
        <span>
          {value
            ? locale === "es"
              ? "Firma capturada"
              : "Signature captured"
            : locale === "es"
            ? "Use el dedo o el ratón para firmar"
            : "Use your finger or mouse to sign"}
        </span>
        <button
          type="button"
          onClick={clear}
          style={{
            background: "transparent",
            border: "none",
            color: INK_MUTE,
            cursor: "pointer",
            fontFamily: FONT,
            fontSize: 12,
            textDecoration: "underline",
          }}
        >
          {locale === "es" ? "Borrar" : "Clear"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HandbookSignedConfirmation — post-sign success screen with auto-close.
// Surfaces signed-at timestamp + signer name + method + Download button.
// ─────────────────────────────────────────────────────────────────────────────

function HandbookSignedConfirmation({
  locale,
  signedAt,
  signerName,
  signatureMethod,
  token,
  onClose,
}: {
  locale: Locale;
  signedAt: string;
  signerName: string;
  signatureMethod: "typed" | "drawn";
  token: string | null;
  onClose: () => Promise<void>;
}) {
  useEffect(() => {
    const t = setTimeout(() => {
      void onClose();
    }, 8000);
    return () => clearTimeout(t);
  }, [onClose]);

  const dt = new Date(signedAt);
  const formatted = `${dt.toLocaleDateString(
    locale === "es" ? "es-MX" : "en-US",
  )} ${dt.toLocaleTimeString(
    locale === "es" ? "es-MX" : "en-US",
    { hour: "2-digit", minute: "2-digit" },
  )}`;

  return (
    <div
      style={{
        maxWidth: 520,
        margin: "40px auto",
        padding: "26px 24px",
        background: SURFACE,
        border: `1px solid ${LINE}`,
        borderRadius: RADIUS,
        textAlign: "center",
        fontFamily: FONT,
      }}
    >
      <CircleCheck
        size={48}
        style={{ color: SUCCESS, margin: "0 auto" }}
      />
      <div
        style={{
          fontSize: 20,
          fontWeight: 800,
          color: INK,
          marginTop: 12,
        }}
      >
        {locale === "es" ? "Manual firmado" : "Handbook signed"}
      </div>
      <div
        style={{
          fontSize: 13,
          color: INK_MUTE,
          marginTop: 6,
          lineHeight: 1.5,
        }}
      >
        {locale === "es" ? "Firmado por" : "Signed by"}
        <span style={{ fontWeight: 700, color: INK }}> {signerName}</span>
        <br />
        {formatted} ·{" "}
        {signatureMethod === "drawn"
          ? locale === "es"
            ? "firma dibujada"
            : "drawn signature"
          : locale === "es"
          ? "firma escrita"
          : "typed signature"}
      </div>
      <div
        style={{
          marginTop: 20,
          display: "flex",
          gap: 10,
          justifyContent: "center",
          flexWrap: "wrap",
        }}
      >
        <PrimaryButton
          onClick={() => {
            downloadHandbookPdf(token).catch((e) => {
              alert(String((e as Error).message));
            });
          }}
        >
          <Download size={14} />
          {locale === "es" ? "Descargar PDF" : "Download PDF"}
        </PrimaryButton>
        <SecondaryButton
          onClick={() => {
            void onClose();
          }}
        >
          {locale === "es" ? "Volver al entrenamiento" : "Return to training"}
        </SecondaryButton>
      </div>
      <div
        style={{
          marginTop: 16,
          fontSize: 11,
          color: INK_LIGHT,
        }}
      >
        {locale === "es"
          ? "Esta pantalla se cerrará automáticamente."
          : "This screen will close automatically."}
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
  home_address_street: string;
  home_address_unit: string;
  home_address_city: string;
  home_address_state: string;
  home_address_zip: string;
  emergency_contact_name: string;
  emergency_contact_relationship: string;
  emergency_contact_phone: string;
  languages_spoken: string;
  shirt_size: string;
  apron_size: string;
  drives_personal_vehicle: boolean;
  vehicle_make: string;
  vehicle_model: string;
  vehicle_year: string;
  vehicle_color: string;
  vehicle_license_plate: string;
  vehicle_insurance_company: string;
  vehicle_insurance_policy_number: string;
  vehicle_insurance_expires_at: string;
  drivers_license_number: string;
  drivers_license_state: string;
  drivers_license_expires_at: string;
  vehicle_protocol_acknowledged: boolean;
  notes: string;
}

const EMPTY_INTAKE: IntakeFormState = {
  preferred_name: "",
  pronouns: "",
  personal_email: "",
  personal_cell_phone: "",
  home_address_street: "",
  home_address_unit: "",
  home_address_city: "",
  home_address_state: "IL",
  home_address_zip: "",
  emergency_contact_name: "",
  emergency_contact_relationship: "",
  emergency_contact_phone: "",
  languages_spoken: "",
  shirt_size: "",
  apron_size: "",
  drives_personal_vehicle: false,
  vehicle_make: "",
  vehicle_model: "",
  vehicle_year: "",
  vehicle_color: "",
  vehicle_license_plate: "",
  vehicle_insurance_company: "",
  vehicle_insurance_policy_number: "",
  vehicle_insurance_expires_at: "",
  drivers_license_number: "",
  drivers_license_state: "IL",
  drivers_license_expires_at: "",
  vehicle_protocol_acknowledged: false,
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
            home_address_street: row.home_address_street ?? "",
            home_address_unit: row.home_address_unit ?? "",
            home_address_city: row.home_address_city ?? "",
            home_address_state: row.home_address_state ?? "IL",
            home_address_zip: row.home_address_zip ?? "",
            emergency_contact_name: row.emergency_contact_name ?? "",
            emergency_contact_relationship: row.emergency_contact_relationship ?? "",
            emergency_contact_phone: row.emergency_contact_phone ?? "",
            languages_spoken: row.languages_spoken ?? "",
            shirt_size: row.shirt_size ?? "",
            apron_size: row.apron_size ?? "",
            drives_personal_vehicle: row.drives_personal_vehicle,
            vehicle_make: row.vehicle_make ?? "",
            vehicle_model: row.vehicle_model ?? "",
            vehicle_year:
              row.vehicle_year != null ? String(row.vehicle_year) : "",
            vehicle_color: row.vehicle_color ?? "",
            vehicle_license_plate: row.vehicle_license_plate ?? "",
            vehicle_insurance_company: row.vehicle_insurance_company ?? "",
            vehicle_insurance_policy_number: row.vehicle_insurance_policy_number ?? "",
            vehicle_insurance_expires_at: row.vehicle_insurance_expires_at ?? "",
            drivers_license_number: row.drivers_license_number ?? "",
            drivers_license_state: row.drivers_license_state ?? "IL",
            drivers_license_expires_at: row.drivers_license_expires_at ?? "",
            vehicle_protocol_acknowledged: row.vehicle_protocol_acknowledged,
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

  function validate(): string | null {
    const ZIP_RE = /^\d{5}(-\d{4})?$/;
    const STATE_RE = /^[A-Z]{2}$/;
    const need = (s: string) => s.trim().length > 0;
    if (!need(form.home_address_street))
      return locale === "es"
        ? "La calle es requerida."
        : "Street address is required.";
    if (!need(form.home_address_city))
      return locale === "es" ? "La ciudad es requerida." : "City is required.";
    if (!need(form.home_address_state) || !STATE_RE.test(form.home_address_state))
      return locale === "es"
        ? "El estado debe ser un código de 2 letras (ej. IL)."
        : "State must be a 2-letter US code (e.g. IL).";
    if (!need(form.home_address_zip) || !ZIP_RE.test(form.home_address_zip))
      return locale === "es"
        ? "El código postal debe tener 5 dígitos (o 5+4)."
        : "ZIP code must be 5 digits (or 5+4 format).";
    if (!need(form.emergency_contact_name))
      return locale === "es"
        ? "El nombre del contacto de emergencia es requerido."
        : "Emergency contact name is required.";
    if (!need(form.emergency_contact_relationship))
      return locale === "es"
        ? "La relación del contacto de emergencia es requerida."
        : "Emergency contact relationship is required.";
    if (!need(form.emergency_contact_phone))
      return locale === "es"
        ? "El teléfono del contacto de emergencia es requerido."
        : "Emergency contact phone is required.";
    if (form.drives_personal_vehicle) {
      const now = new Date();
      const yearN = Number.parseInt(form.vehicle_year, 10);
      if (!need(form.vehicle_make))
        return locale === "es"
          ? "La marca del vehículo es requerida."
          : "Vehicle make is required.";
      if (!need(form.vehicle_model))
        return locale === "es"
          ? "El modelo del vehículo es requerido."
          : "Vehicle model is required.";
      if (
        !Number.isInteger(yearN) ||
        yearN < 1980 ||
        yearN > now.getFullYear() + 2
      )
        return locale === "es"
          ? "El año del vehículo debe ser 1980 o posterior."
          : "Vehicle year must be 1980 or later.";
      if (!need(form.vehicle_color))
        return locale === "es"
          ? "El color del vehículo es requerido."
          : "Vehicle color is required.";
      const plate = form.vehicle_license_plate.replace(/[\s-]/g, "");
      if (!/^[A-Z0-9]{2,8}$/.test(plate))
        return locale === "es"
          ? "La placa debe ser alfanumérica, 2 a 8 caracteres."
          : "License plate must be alphanumeric, 2 to 8 characters.";
      if (!need(form.vehicle_insurance_company))
        return locale === "es"
          ? "La compañía de seguro es requerida."
          : "Auto insurance company is required.";
      const policy = form.vehicle_insurance_policy_number.replace(/[\s-]/g, "");
      if (!/^[A-Za-z0-9]{5,30}$/.test(policy))
        return locale === "es"
          ? "El número de póliza debe ser alfanumérico, 5 a 30 caracteres."
          : "Insurance policy number must be alphanumeric, 5 to 30 characters.";
      const insExp = new Date(`${form.vehicle_insurance_expires_at}T12:00:00Z`);
      if (
        !form.vehicle_insurance_expires_at ||
        Number.isNaN(insExp.getTime()) ||
        insExp <= now
      )
        return locale === "es"
          ? "La expiración del seguro debe ser una fecha futura."
          : "Insurance expiration date must be in the future.";
      const dln = form.drivers_license_number.replace(/[\s-]/g, "");
      if (!/^[A-Za-z0-9]{5,30}$/.test(dln))
        return locale === "es"
          ? "El número de licencia de conducir debe ser alfanumérico, 5 a 30 caracteres."
          : "Driver's license number must be alphanumeric, 5 to 30 characters.";
      if (!STATE_RE.test(form.drivers_license_state))
        return locale === "es"
          ? "El estado de la licencia debe ser un código de 2 letras."
          : "Driver's license state must be a 2-letter US code.";
      const dlExp = new Date(`${form.drivers_license_expires_at}T12:00:00Z`);
      if (
        !form.drivers_license_expires_at ||
        Number.isNaN(dlExp.getTime()) ||
        dlExp <= now
      )
        return locale === "es"
          ? "La expiración de la licencia debe ser una fecha futura."
          : "Driver's license expiration date must be in the future.";
      if (!form.vehicle_protocol_acknowledged)
        return locale === "es"
          ? "Debe reconocer el protocolo de uso de vehículo para continuar."
          : "You must acknowledge the vehicle use protocol to continue.";
    }
    return null;
  }

  async function submit() {
    const v = validate();
    if (v) {
      setErr(v);
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      // Coerce vehicle_year string to integer for the JSON payload.
      const payload = {
        ...form,
        vehicle_year: form.vehicle_year
          ? Number.parseInt(form.vehicle_year, 10)
          : null,
      };
      await api("POST", "/lms/onboarding-intake/save", token, payload);
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
        title={locale === "es" ? "Dirección de domicilio" : "Home address"}
      >
        <div
          style={{
            fontSize: 12,
            color: INK_MUTE,
            lineHeight: 1.55,
            marginBottom: 4,
          }}
        >
          {locale === "es"
            ? "Su dirección de domicilio es requerida para cumplimiento fiscal y respuesta a emergencias. Phes no utiliza su dirección de domicilio para reembolso de millas (que solo cubre el manejo entre ubicaciones de clientes en el mismo día de trabajo)."
            : "Your home address is required for tax compliance and emergency response purposes. Phes does not use your home address for mileage reimbursement (which only covers driving between client locations on the same workday)."}
        </div>
        <Field
          label={required(locale === "es" ? "Calle" : "Street address")}
          value={form.home_address_street}
          onChange={(v) => set("home_address_street", v)}
          placeholder={locale === "es" ? "Calle y número" : "Street address"}
        />
        <Field
          label={
            locale === "es"
              ? "Apartamento / unidad (opcional)"
              : "Apartment / unit / suite (optional)"
          }
          value={form.home_address_unit}
          onChange={(v) => set("home_address_unit", v)}
        />
        <Field
          label={required(locale === "es" ? "Ciudad" : "City")}
          value={form.home_address_city}
          onChange={(v) => set("home_address_city", v)}
        />
        <Field
          label={required(locale === "es" ? "Estado" : "State")}
          value={form.home_address_state}
          onChange={(v) => set("home_address_state", v.toUpperCase())}
          placeholder="IL"
        />
        <Field
          label={required(locale === "es" ? "Código postal" : "ZIP code")}
          value={form.home_address_zip}
          onChange={(v) => set("home_address_zip", v)}
          placeholder="60805"
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
              label={required(locale === "es" ? "Marca del vehículo" : "Vehicle make")}
              value={form.vehicle_make}
              onChange={(v) => set("vehicle_make", v)}
              placeholder={locale === "es" ? "Toyota" : "Toyota"}
            />
            <Field
              label={required(locale === "es" ? "Modelo del vehículo" : "Vehicle model")}
              value={form.vehicle_model}
              onChange={(v) => set("vehicle_model", v)}
              placeholder={locale === "es" ? "Camry" : "Camry"}
            />
            <Field
              label={required(locale === "es" ? "Año del vehículo" : "Vehicle year")}
              value={form.vehicle_year}
              onChange={(v) => set("vehicle_year", v)}
              placeholder="2020"
            />
            <Field
              label={required(locale === "es" ? "Color del vehículo" : "Vehicle color")}
              value={form.vehicle_color}
              onChange={(v) => set("vehicle_color", v)}
              placeholder={locale === "es" ? "Plateado" : "Silver"}
            />
            <Field
              label={required(locale === "es" ? "Número de placa" : "License plate number")}
              value={form.vehicle_license_plate}
              onChange={(v) => set("vehicle_license_plate", v.toUpperCase())}
            />
            <Field
              label={required(locale === "es" ? "Compañía de seguro" : "Auto insurance company")}
              value={form.vehicle_insurance_company}
              onChange={(v) => set("vehicle_insurance_company", v)}
              placeholder={locale === "es" ? "State Farm" : "State Farm"}
            />
            <Field
              label={required(locale === "es" ? "Número de póliza" : "Insurance policy number")}
              value={form.vehicle_insurance_policy_number}
              onChange={(v) => set("vehicle_insurance_policy_number", v)}
            />
            <Field
              label={required(
                locale === "es"
                  ? "Expiración del seguro (AAAA-MM-DD)"
                  : "Insurance policy expiration date (YYYY-MM-DD)",
              )}
              type="date"
              value={form.vehicle_insurance_expires_at}
              onChange={(v) => set("vehicle_insurance_expires_at", v)}
            />
            <Field
              label={required(
                locale === "es"
                  ? "Número de licencia de conducir"
                  : "Driver's license number",
              )}
              value={form.drivers_license_number}
              onChange={(v) => set("drivers_license_number", v)}
            />
            <Field
              label={required(
                locale === "es"
                  ? "Estado de la licencia (ej. IL)"
                  : "Driver's license state (e.g. IL)",
              )}
              value={form.drivers_license_state}
              onChange={(v) => set("drivers_license_state", v.toUpperCase())}
              placeholder="IL"
            />
            <Field
              label={required(
                locale === "es"
                  ? "Expiración de la licencia (AAAA-MM-DD)"
                  : "Driver's license expiration date (YYYY-MM-DD)",
              )}
              type="date"
              value={form.drivers_license_expires_at}
              onChange={(v) => set("drivers_license_expires_at", v)}
            />
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                fontSize: 12,
                cursor: "pointer",
                marginTop: 6,
                padding: 10,
                background: SURFACE,
                border: `1px solid ${LINE}`,
                borderRadius: 6,
                lineHeight: 1.55,
              }}
            >
              <input
                type="checkbox"
                checked={form.vehicle_protocol_acknowledged}
                onChange={(e) =>
                  set("vehicle_protocol_acknowledged", e.target.checked)
                }
                style={{ marginTop: 2 }}
              />
              <span>
                {locale === "es" ? (
                  <>
                    Reconozco y acepto el protocolo de uso de vehículo de Phes
                    según se describe en el manual de Políticas y Procedimientos
                    de Phes.
                    <span style={{ color: DANGER, marginLeft: 3 }}>*</span>
                    <br />
                    Entiendo que:
                    <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
                      <li>
                        El millaje se reembolsa solo entre ubicaciones de
                        clientes en el mismo día de trabajo, no para ir o
                        regresar entre la casa y el trabajo
                      </li>
                      <li>
                        No transportaré clientes, propiedad de clientes ni
                        mascotas en mi vehículo personal sin aprobación de la
                        oficina
                      </li>
                      <li>
                        Mantendré seguro automotor válido que cumpla con los
                        requisitos mínimos de Illinois durante todo mi empleo
                      </li>
                      <li>
                        Mi seguro automotor personal es primario en caso de un
                        accidente, con cualquier cobertura de Phes como
                        secundaria
                      </li>
                      <li>
                        Notificaré inmediatamente a la oficina si mi seguro se
                        cancela, mi licencia de conducir es suspendida, o mi
                        vehículo sufre cualquier accidente durante horas
                        laborales
                      </li>
                    </ul>
                  </>
                ) : (
                  <>
                    I acknowledge and agree to the Phes vehicle use protocol as
                    described in the Phes Policies and Procedures handbook.
                    <span style={{ color: DANGER, marginLeft: 3 }}>*</span>
                    <br />
                    I understand that:
                    <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
                      <li>
                        Mileage is reimbursed only between client locations on
                        the same workday, not for home-to-job or job-to-home
                        commuting
                      </li>
                      <li>
                        I will not transport clients, client property, or pets
                        in my personal vehicle without office approval
                      </li>
                      <li>
                        I will maintain valid auto insurance meeting Illinois
                        minimum requirements throughout my employment
                      </li>
                      <li>
                        My personal auto insurance is primary in the event of
                        an accident, with any Phes coverage as secondary
                      </li>
                      <li>
                        I will notify the office immediately if my insurance
                        lapses, my driver's license is suspended, or my vehicle
                        is involved in any accident during work hours
                      </li>
                    </ul>
                  </>
                )}
              </span>
            </label>
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
      {type === "date" ? (
        <CalendarPopover value={value} onChange={onChange} block />
      ) : (
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
      )}
    </label>
  );
}
