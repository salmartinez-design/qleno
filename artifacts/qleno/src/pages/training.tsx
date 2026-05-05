import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useAuthStore } from "@/lib/auth";
import {
  getCurriculum,
  type Curriculum,
  type Locale,
  type Module,
  type ContentBlock,
  type QuizQuestion,
  type IconKind,
  QUIZ_PASS_THRESHOLD,
} from "@/lib/training/curriculum";
import {
  ChevronRight, ChevronLeft, Check, X, ArrowLeft, Globe2,
  AlertTriangle, Info, CircleCheck, Lock, Award,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Tokens — restrained enterprise palette (Workday / Rippling / Gusto register)
// ─────────────────────────────────────────────────────────────────────────────
const NAVY      = "#0A2342";
const NAVY_HOV  = "#163059";
const TEAL      = "#0096B3";   // narrow accent only
const INK       = "#0F172A";
const INK_MUTE  = "#475569";
const INK_LIGHT = "#94A3B8";
const PAGE_BG   = "#F8FAFC";
const SURFACE   = "#FFFFFF";
const LINE      = "#E2E8F0";
const LINE_SOFT = "#F1F5F9";
const SUCCESS   = "#0F766E";
const WARN      = "#B45309";
const DANGER    = "#B91C1C";

const FONT = "'Plus Jakarta Sans', sans-serif";
const RADIUS = 10;

const WEBHOOK_URL = "https://hook.us2.make.com/qsg882bn4cnfm74v7xeai5de62w45wn1";

// ─────────────────────────────────────────────────────────────────────────────
// Token helpers — read JWT to identify the learner
// ─────────────────────────────────────────────────────────────────────────────
type Learner = {
  email: string;
  firstName: string;
  lastName: string;
  companyId: number | null;
  role: string | null;
};

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
// Persistence
// ─────────────────────────────────────────────────────────────────────────────
type Progress = {
  completedModules: string[];
  bestQuizScore: number;
  acknowledgedAt: string | null;
  lastModuleId: string | null;
  locale: Locale;
  quizAttempts: number;
  quizLockedUntil: string | null;
  acknowledgmentName: string | null;
};

const DEFAULT_PROGRESS: Progress = {
  completedModules: [],
  bestQuizScore: 0,
  acknowledgedAt: null,
  lastModuleId: null,
  locale: "en",
  quizAttempts: 0,
  quizLockedUntil: null,
  acknowledgmentName: null,
};

const MIN_READ_SECONDS = 30;
const QUIZ_LOCKOUT_HOURS = 24;

function progressKey(email: string | null) {
  return `qleno_lms_progress_${email || "anonymous"}`;
}

function loadProgress(email: string | null): Progress {
  try {
    const raw = localStorage.getItem(progressKey(email));
    if (!raw) return { ...DEFAULT_PROGRESS };
    return { ...DEFAULT_PROGRESS, ...JSON.parse(raw) };
  } catch { return { ...DEFAULT_PROGRESS }; }
}

function saveProgress(email: string | null, p: Progress) {
  try { localStorage.setItem(progressKey(email), JSON.stringify(p)); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// i18n
// ─────────────────────────────────────────────────────────────────────────────
const T = {
  trainingTitle:    { en: "Training",                            es: "Capacitación" },
  newHire:          { en: "New hire program",                    es: "Programa de nuevo empleado" },
  startTraining:    { en: "Start training",                      es: "Comenzar capacitación" },
  resumeTraining:   { en: "Resume",                              es: "Continuar" },
  modules:          { en: "Modules",                             es: "Módulos" },
  ofModules:        { en: "of modules complete",                 es: "de módulos completados" },
  remaining:        { en: "remaining",                           es: "restantes" },
  total:            { en: "total",                               es: "total" },
  module:           { en: "Module",                              es: "Módulo" },
  back:             { en: "Back",                                es: "Volver" },
  next:             { en: "Next",                                es: "Siguiente" },
  previous:         { en: "Previous",                            es: "Anterior" },
  markComplete:     { en: "Mark complete",                       es: "Marcar como completado" },
  goToQuiz:         { en: "Go to quiz",                          es: "Ir al examen" },
  knowledgeCheck:   { en: "Knowledge check",                     es: "Verificación de conocimiento" },
  question:         { en: "Question",                            es: "Pregunta" },
  of:               { en: "of",                                  es: "de" },
  submitAnswer:     { en: "Submit",                              es: "Enviar" },
  nextQuestion:     { en: "Next",                                es: "Siguiente" },
  seeResults:       { en: "See results",                         es: "Ver resultados" },
  quizResults:      { en: "Quiz results",                        es: "Resultados del examen" },
  passed:           { en: "Passed",                              es: "Aprobado" },
  retakeNeeded:     { en: "Below passing — retake required",     es: "Por debajo del mínimo — debes repetirlo" },
  retakeQuiz:       { en: "Retake quiz",                         es: "Tomar examen de nuevo" },
  reviewMissed:     { en: "Questions to review",                 es: "Preguntas a revisar" },
  proceedAck:       { en: "Continue",                            es: "Continuar" },
  acknowledgment:   { en: "Acknowledgment",                      es: "Reconocimiento" },
  ackPrompt: {
    en: "Type your full legal name and check the box to confirm you have read, understood, and agree to follow the policies covered in this training.",
    es: "Escribe tu nombre legal completo y marca la casilla para confirmar que has leído, entendido y aceptas seguir las políticas cubiertas en esta capacitación.",
  },
  fullName:         { en: "Full legal name",                     es: "Nombre legal completo" },
  ackCheckbox: {
    en: "I confirm I have read and understood all modules and agree to follow Phes policies as my employer.",
    es: "Confirmo que he leído y entendido todos los módulos y acepto seguir las políticas de Phes como mi empleador.",
  },
  submitAck:        { en: "Submit acknowledgment",               es: "Enviar reconocimiento" },
  submitting:       { en: "Submitting",                          es: "Enviando" },
  done:             { en: "Training complete",                   es: "Capacitación completada" },
  doneSub: {
    en: "Your acknowledgment was recorded. A confirmation has been sent to you and to Phes management.",
    es: "Tu reconocimiento fue registrado. Se envió una confirmación a ti y a la gerencia de Phes.",
  },
  returnHome:       { en: "Return to dashboard",                 es: "Volver al panel" },
  startOver:        { en: "Start over",                          es: "Empezar de nuevo" },
  quizLocked:       { en: "Complete the modules above to unlock the quiz.", es: "Completa los módulos para desbloquear el examen." },
  ackLocked:        { en: "Pass the quiz with 80% or higher to acknowledge.", es: "Aprueba el examen con 80% o más para reconocer." },
  notStarted:       { en: "Not started",                         es: "No iniciado" },
  inProgress:       { en: "In progress",                         es: "En progreso" },
  completed:        { en: "Completed",                           es: "Completado" },
  comingSoon:       { en: "Coming soon",                         es: "Próximamente" },
  upNext:           { en: "Up next",                             es: "Siguiente" },
  minutes:          { en: "min",                                 es: "min" },
  step:             { en: "Step",                                es: "Paso" },
  finalStep:        { en: "Final step",                          es: "Paso final" },
  acknowledged:     { en: "Acknowledged",                        es: "Reconocido" },
  locked:           { en: "Locked",                              es: "Bloqueado" },
  readMore:         { en: "Keep reading…",                       es: "Sigue leyendo…" },
  quizIntroTitle:   { en: "Before you start the quiz",           es: "Antes de comenzar el examen" },
  quizIntroBody: {
    en: "You need 80% or higher to pass. You may retake the quiz if you don't pass on your first attempt. Read each question carefully — every answer is covered in the training you just completed.",
    es: "Necesitas 80% o más para aprobar. Puedes volver a tomar el examen si no apruebas en tu primer intento. Lee cada pregunta con cuidado — cada respuesta está cubierta en la capacitación que acabas de completar.",
  },
  quizIntroBegin:   { en: "Begin quiz",                          es: "Comenzar examen" },
  attempt:          { en: "Attempt",                             es: "Intento" },
  reviewMaterials: {
    en: "Please review the training materials and contact your manager before retaking. The quiz is locked for 24 hours.",
    es: "Por favor revisa los materiales de capacitación y contacta a tu gerente antes de volver a intentarlo. El examen está bloqueado por 24 horas.",
  },
  retryAvailableAt: { en: "Retry available at",                  es: "Reintento disponible a las" },
  certificate:      { en: "Certificate of Completion",           es: "Certificado de Finalización" },
  yourScore:        { en: "Your score",                          es: "Tu puntuación" },
  minPassing:       { en: "Minimum passing score: 80%",          es: "Puntuación mínima de aprobación: 80%" },
  awardedTo:        { en: "Awarded to",                          es: "Otorgado a" },
  on:               { en: "on",                                  es: "el" },
};

function tr(key: keyof typeof T, locale: Locale) { return T[key][locale]; }

// ─────────────────────────────────────────────────────────────────────────────
// View state
// ─────────────────────────────────────────────────────────────────────────────
type View =
  | { kind: "home" }
  | { kind: "module"; moduleId: string }
  | { kind: "quiz-intro" }
  | { kind: "quiz" }
  | { kind: "ack" }
  | { kind: "done" };

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────
export default function TrainingPage() {
  const token = useAuthStore(s => s.token);
  const learner = readLearnerFromToken(token);
  const [, setLocation] = useLocation();

  const [progress, setProgress] = useState<Progress>(() => loadProgress(learner?.email ?? null));
  const [view, setView] = useState<View>({ kind: "home" });

  const locale = progress.locale;
  const setLocale = (l: Locale) => persist({ ...progress, locale: l });

  const curriculum: Curriculum = useMemo(
    () => getCurriculum(learner?.companyId ?? 1),
    [learner?.companyId]
  );

  const contentModules = curriculum.modules.filter(m => m.id !== "acknowledgment");
  const ackModule = curriculum.modules.find(m => m.id === "acknowledgment");

  const completedSet = new Set(progress.completedModules);
  const allContentDone = contentModules.every(m => completedSet.has(m.id));
  const quizPassed = progress.bestQuizScore >= QUIZ_PASS_THRESHOLD;
  const isFullyDone = !!progress.acknowledgedAt;

  useEffect(() => {
    if (isFullyDone && view.kind === "home") setView({ kind: "done" });
  }, [isFullyDone]); // eslint-disable-line react-hooks/exhaustive-deps

  function persist(p: Progress) {
    setProgress(p);
    saveProgress(learner?.email ?? null, p);
  }

  function markModuleComplete(moduleId: string) {
    if (completedSet.has(moduleId)) return;
    persist({
      ...progress,
      completedModules: [...progress.completedModules, moduleId],
      lastModuleId: moduleId,
    });
  }

  function recordQuizAttempt(score: number) {
    const passed = score >= QUIZ_PASS_THRESHOLD;
    const attempts = progress.quizAttempts + 1;
    let lockedUntil: string | null = null;
    if (!passed && attempts >= 2) {
      lockedUntil = new Date(Date.now() + QUIZ_LOCKOUT_HOURS * 60 * 60 * 1000).toISOString();
    }
    persist({
      ...progress,
      bestQuizScore: Math.max(progress.bestQuizScore, score),
      quizAttempts: attempts,
      quizLockedUntil: lockedUntil,
    });
  }

  function recordAcknowledgment(name: string) {
    persist({
      ...progress,
      acknowledgedAt: new Date().toISOString(),
      acknowledgmentName: name,
    });
  }

  function resetTraining() {
    persist({ ...DEFAULT_PROGRESS, locale });
    setView({ kind: "home" });
  }

  // Determine if quiz is currently locked due to 2+ failed attempts
  const quizLockedUntil = progress.quizLockedUntil ? new Date(progress.quizLockedUntil) : null;
  const isQuizLocked = !!(quizLockedUntil && quizLockedUntil > new Date());

  return (
    <div style={{
      minHeight: "100dvh",
      background: PAGE_BG,
      fontFamily: FONT,
      color: INK,
      WebkitFontSmoothing: "antialiased",
    }}>
      <ResponsiveStyles />
      <Header
        locale={locale}
        setLocale={setLocale}
        learner={learner}
        progressPct={Math.round((progress.completedModules.length / contentModules.length) * 100)}
        onHome={() => setView({ kind: "home" })}
      />

      <main style={{ maxWidth: 960, margin: "0 auto", padding: "40px 24px 96px" }}>
        {view.kind === "home" && (
          <Home
            curriculum={curriculum}
            contentModules={contentModules}
            completedSet={completedSet}
            progress={progress}
            allContentDone={allContentDone}
            quizPassed={quizPassed}
            isFullyDone={isFullyDone}
            isQuizLocked={isQuizLocked}
            quizLockedUntil={quizLockedUntil}
            locale={locale}
            onOpenModule={(id) => setView({ kind: "module", moduleId: id })}
            onStartQuiz={() => setView({ kind: "quiz-intro" })}
            onStartAck={() => setView({ kind: "ack" })}
            onStartOver={resetTraining}
          />
        )}

        {view.kind === "module" && (() => {
          const idx = contentModules.findIndex(m => m.id === view.moduleId);
          const mod = contentModules[idx];
          if (!mod) return <NotFoundModule onBack={() => setView({ kind: "home" })} locale={locale} />;
          const next = contentModules[idx + 1];
          return (
            <ModuleView
              module={mod}
              total={contentModules.length}
              locale={locale}
              completed={completedSet.has(mod.id)}
              onBack={() => setView({ kind: "home" })}
              onComplete={() => {
                markModuleComplete(mod.id);
                if (next) setView({ kind: "module", moduleId: next.id });
                else setView({ kind: "home" });
              }}
              onPrevious={() => {
                if (idx > 0) setView({ kind: "module", moduleId: contentModules[idx - 1].id });
                else setView({ kind: "home" });
              }}
              hasPrevious={idx > 0}
              hasNext={!!next}
            />
          );
        })()}

        {view.kind === "quiz-intro" && (
          <QuizIntroView
            locale={locale}
            attempts={progress.quizAttempts}
            questionCount={curriculum.quiz.length}
            onBack={() => setView({ kind: "home" })}
            onBegin={() => setView({ kind: "quiz" })}
          />
        )}

        {view.kind === "quiz" && (
          <QuizView
            quiz={curriculum.quiz}
            locale={locale}
            attemptNumber={progress.quizAttempts + 1}
            onBack={() => setView({ kind: "home" })}
            onComplete={(score) => {
              recordQuizAttempt(score);
            }}
            onProceed={() => setView({ kind: "ack" })}
            onReturnHome={() => setView({ kind: "home" })}
          />
        )}

        {view.kind === "ack" && ackModule && (
          <AckView
            module={ackModule}
            locale={locale}
            learner={learner}
            tenantName={curriculum.tenantName}
            onBack={() => setView({ kind: "home" })}
            onSubmitted={(name) => {
              recordAcknowledgment(name);
              setView({ kind: "done" });
            }}
          />
        )}

        {view.kind === "done" && (
          <DoneView
            locale={locale}
            tenantName={curriculum.tenantName}
            acknowledgedAt={progress.acknowledgedAt}
            scorePct={Math.round(progress.bestQuizScore * 100)}
            name={progress.acknowledgmentName || (learner ? `${learner.firstName} ${learner.lastName}`.trim() : "")}
            onReturn={() => setLocation("/dashboard")}
            onStartOver={resetTraining}
          />
        )}
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Responsive overrides for the otherwise inline-styled page
// ─────────────────────────────────────────────────────────────────────────────
function ResponsiveStyles() {
  return (
    <style>{`
      @media (max-width: 720px) {
        .qleno-lms-statrow { flex-direction: column !important; align-items: flex-start !important; gap: 8px !important; }
        .qleno-lms-statrow > * + * { margin-top: 0 !important; }
        .qleno-lms-step-grid { grid-template-columns: 1fr !important; }
        .qleno-lms-header-meta { display: none !important; }
        .qleno-lms-headline { font-size: 28px !important; }
        .qleno-lms-section { padding: 20px !important; }
        .qleno-lms-module-row { padding: 14px 16px !important; gap: 12px !important; }
        .qleno-lms-module-time { display: none !important; }
      }
    `}</style>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Header — restrained, white, with a navy progress strip
// ─────────────────────────────────────────────────────────────────────────────
function Header({
  locale, setLocale, learner, progressPct, onHome,
}: {
  locale: Locale;
  setLocale: (l: Locale) => void;
  learner: Learner | null;
  progressPct: number;
  onHome: () => void;
}) {
  const learnerLabel = learner
    ? `${learner.firstName || learner.email.split("@")[0]} ${learner.lastName || ""}`.trim()
    : "";

  return (
    <header style={{
      position: "sticky",
      top: 0,
      zIndex: 10,
      background: SURFACE,
      borderBottom: `1px solid ${LINE}`,
    }}>
      <div style={{
        maxWidth: 960, margin: "0 auto",
        padding: "0 24px",
        height: 60,
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
      }}>
        <button
          onClick={onHome}
          style={{
            display: "flex", alignItems: "center", gap: 12,
            background: "none", border: "none", cursor: "pointer",
            color: INK, padding: 0, fontFamily: FONT,
          }}
        >
          <PhesMark />
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: INK, letterSpacing: "-0.005em" }}>Phes</span>
            <span style={{ width: 1, height: 18, background: LINE }} />
            <span style={{ fontSize: 13, fontWeight: 500, color: INK_MUTE }}>{tr("trainingTitle", locale)}</span>
          </div>
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span className="qleno-lms-header-meta" style={{ fontSize: 12, color: INK_MUTE, fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>
            {progressPct}% {locale === "en" ? "complete" : "completado"}
          </span>
          <LocaleToggle locale={locale} setLocale={setLocale} />
          {learnerLabel && (
            <div className="qleno-lms-header-meta" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 1, height: 22, background: LINE }} />
              <span style={{ fontSize: 13, color: INK, fontWeight: 500 }}>{learnerLabel}</span>
            </div>
          )}
        </div>
      </div>

      <div style={{ height: 2, background: LINE_SOFT }}>
        <div style={{
          height: "100%",
          width: `${Math.min(100, Math.max(0, progressPct))}%`,
          background: NAVY,
          transition: "width 0.4s cubic-bezier(0.4,0,0.2,1)",
        }} />
      </div>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Module hero icons — inline SVG, no external assets
// ─────────────────────────────────────────────────────────────────────────────
function ModuleIcon({ kind, size = 88 }: { kind: IconKind; size?: number }) {
  const stroke = NAVY;
  const fill = "#EEF2F8";
  const accent = TEAL;
  const props = { width: size, height: size, viewBox: "0 0 64 64", fill: "none" } as const;

  switch (kind) {
    case "house":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <path d="M16 30 L32 18 L48 30 L48 46 Q48 48 46 48 L18 48 Q16 48 16 46 Z" stroke={stroke} strokeWidth="2.4" strokeLinejoin="round" fill="none" />
          <path d="M27 48 L27 38 L37 38 L37 48" stroke={stroke} strokeWidth="2.4" strokeLinejoin="round" />
          <circle cx="42" cy="20" r="3" fill={accent} />
        </svg>
      );
    case "clock":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <circle cx="32" cy="32" r="14" stroke={stroke} strokeWidth="2.4" />
          <path d="M32 23 L32 32 L39 36" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="32" cy="32" r="1.6" fill={stroke} />
          <circle cx="46" cy="18" r="3" fill={accent} />
        </svg>
      );
    case "uniform":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <path d="M22 18 L26 16 L32 22 L38 16 L42 18 L46 28 L40 28 L40 46 L24 46 L24 28 L18 28 Z" stroke={stroke} strokeWidth="2.4" strokeLinejoin="round" fill="none" />
          <circle cx="32" cy="30" r="2" fill={accent} />
          <circle cx="32" cy="38" r="2" fill={accent} />
        </svg>
      );
    case "money":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <circle cx="32" cy="32" r="14" stroke={stroke} strokeWidth="2.4" />
          <path d="M37 27 Q33 23 28 25 Q24 27 26 30 Q28 33 33 33 Q38 33 38 36 Q38 40 33 40 Q28 40 26 36" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" fill="none" />
          <line x1="32" y1="22" x2="32" y2="42" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="46" cy="18" r="3" fill={accent} />
        </svg>
      );
    case "flow":
      // Top-to-bottom, back-to-front diagram
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <rect x="14" y="14" width="36" height="36" rx="3" stroke={stroke} strokeWidth="2.4" />
          <line x1="14" y1="26" x2="50" y2="26" stroke={stroke} strokeWidth="1.4" opacity="0.4" />
          <line x1="14" y1="38" x2="50" y2="38" stroke={stroke} strokeWidth="1.4" opacity="0.4" />
          <path d="M22 18 L22 46 M22 46 L18 42 M22 46 L26 42" stroke={accent} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M30 46 L46 46 M46 46 L42 42 M46 46 L42 50" stroke={accent} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      );
    case "spray":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <path d="M28 24 L36 24 L40 30 L40 46 Q40 48 38 48 L26 48 Q24 48 24 46 L24 30 Z" stroke={stroke} strokeWidth="2.4" fill="none" strokeLinejoin="round" />
          <rect x="30" y="18" width="6" height="6" stroke={stroke} strokeWidth="2.4" fill="none" />
          <path d="M40 22 L48 18 M40 26 L50 24 M40 30 L50 30" stroke={accent} strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="48" cy="18" r="1.6" fill={accent} />
          <circle cx="50" cy="24" r="1.6" fill={accent} />
        </svg>
      );
    case "pin":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <path d="M32 14 Q42 14 42 24 Q42 32 32 48 Q22 32 22 24 Q22 14 32 14 Z" stroke={stroke} strokeWidth="2.4" fill="none" strokeLinejoin="round" />
          <circle cx="32" cy="24" r="4" fill={accent} />
        </svg>
      );
    case "sparkle":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <path d="M32 16 L34 28 L46 30 L34 32 L32 44 L30 32 L18 30 L30 28 Z" stroke={stroke} strokeWidth="2.2" strokeLinejoin="round" fill="none" />
          <circle cx="46" cy="20" r="2" fill={accent} />
          <circle cx="20" cy="44" r="2" fill={accent} />
        </svg>
      );
    case "shield":
      return (
        <svg {...props} aria-hidden>
          <rect x="2" y="2" width="60" height="60" rx="14" fill={fill} />
          <path d="M32 14 L46 20 L46 32 Q46 42 32 50 Q18 42 18 32 L18 20 Z" stroke={stroke} strokeWidth="2.4" fill="none" strokeLinejoin="round" />
          <path d="M26 32 L30 36 L40 26" stroke={accent} strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      );
  }
}

function PhesMark() {
  return (
    <div style={{
      width: 28, height: 28, borderRadius: 6,
      background: NAVY,
      color: SURFACE,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontWeight: 800, fontSize: 11, letterSpacing: "0.05em",
      fontFamily: FONT,
    }}>
      P
    </div>
  );
}

function LocaleToggle({ locale, setLocale }: { locale: Locale; setLocale: (l: Locale) => void }) {
  return (
    <div style={{
      display: "flex", alignItems: "center",
      border: `1px solid ${LINE}`,
      borderRadius: 8,
      padding: 2,
    }}>
      <Globe2 size={13} style={{ marginLeft: 8, color: INK_LIGHT }} />
      {(["en", "es"] as const).map(l => (
        <button
          key={l}
          onClick={() => setLocale(l)}
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
            background: locale === l ? NAVY : "transparent",
            color: locale === l ? SURFACE : INK_MUTE,
            fontFamily: FONT,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            transition: "background 0.12s, color 0.12s",
            marginLeft: 2,
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Home — restrained Workday-style overview
// ─────────────────────────────────────────────────────────────────────────────
function Home({
  curriculum, contentModules, completedSet, progress,
  allContentDone, quizPassed, isFullyDone, isQuizLocked, quizLockedUntil, locale,
  onOpenModule, onStartQuiz, onStartAck, onStartOver,
}: {
  curriculum: Curriculum;
  contentModules: Module[];
  completedSet: Set<string>;
  progress: Progress;
  allContentDone: boolean;
  quizPassed: boolean;
  isFullyDone: boolean;
  isQuizLocked: boolean;
  quizLockedUntil: Date | null;
  locale: Locale;
  onOpenModule: (id: string) => void;
  onStartQuiz: () => void;
  onStartAck: () => void;
  onStartOver: () => void;
}) {
  const completedCount = progress.completedModules.length;
  const totalContent = contentModules.length;
  const totalMin = contentModules.reduce((sum, m) => sum + m.estimatedMinutes, 0);
  const remainingMin = contentModules
    .filter(m => !completedSet.has(m.id))
    .reduce((sum, m) => sum + m.estimatedMinutes, 0);

  const firstIncomplete = contentModules.find(m => !completedSet.has(m.id));
  const heroCta = firstIncomplete
    ? (completedCount > 0 ? tr("resumeTraining", locale) : tr("startTraining", locale))
    : (allContentDone && !quizPassed ? tr("knowledgeCheck", locale) : tr("acknowledgment", locale));

  function handleHeroClick() {
    if (firstIncomplete) onOpenModule(firstIncomplete.id);
    else if (!quizPassed) onStartQuiz();
    else onStartAck();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      {/* Hero — minimal, no decoration */}
      <section>
        <p style={{
          margin: "0 0 12px",
          fontSize: 11, fontWeight: 600, color: INK_LIGHT,
          letterSpacing: "0.10em", textTransform: "uppercase",
        }}>
          {curriculum.tenantName} · {tr("newHire", locale)}
        </p>
        <h1 className="qleno-lms-headline" style={{
          fontSize: 36, lineHeight: 1.15, fontWeight: 700, margin: 0,
          color: INK, letterSpacing: "-0.022em",
          maxWidth: 640,
        }}>
          {locale === "en"
            ? "Get ready for your first day at Phes."
            : "Prepárate para tu primer día en Phes."}
        </h1>
        <p style={{
          margin: "12px 0 24px",
          color: INK_MUTE, fontSize: 15, lineHeight: 1.55,
          maxWidth: 640,
        }}>
          {locale === "en"
            ? "Eight short modules cover the company, attendance, dress code, pay, cleaning standards, products, and the apps you'll use — followed by a quick quiz and your acknowledgment."
            : "Ocho módulos cortos cubren la compañía, asistencia, código de vestimenta, pago, estándares de limpieza, productos y las aplicaciones que usarás — seguidos de un examen rápido y tu reconocimiento."}
        </p>

        {/* Stat row — clean, tabular */}
        <div className="qleno-lms-statrow" style={{
          display: "flex", alignItems: "center", gap: 24,
          padding: "14px 18px",
          background: SURFACE,
          border: `1px solid ${LINE}`,
          borderRadius: RADIUS,
          marginBottom: 16,
        }}>
          <Stat
            label={tr("modules", locale)}
            value={`${completedCount}/${totalContent}`}
            sub={`${Math.round((completedCount / totalContent) * 100)}%`}
          />
          <Divider />
          <Stat
            label={tr("knowledgeCheck", locale)}
            value={quizPassed ? `${Math.round(progress.bestQuizScore * 100)}%` : "—"}
            sub={quizPassed ? tr("passed", locale) : tr("notStarted", locale)}
          />
          <Divider />
          <Stat
            label={remainingMin > 0 ? tr("remaining", locale) : tr("total", locale)}
            value={`${remainingMin > 0 ? remainingMin : totalMin} ${tr("minutes", locale)}`}
            sub=""
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <PrimaryButton onClick={handleHeroClick}>
            {heroCta}
            <ChevronRight size={15} />
          </PrimaryButton>
          {isFullyDone && (
            <SecondaryButton onClick={onStartOver}>
              {tr("startOver", locale)}
            </SecondaryButton>
          )}
        </div>
      </section>

      {/* Modules list */}
      <section className="qleno-lms-section" style={{
        background: SURFACE,
        border: `1px solid ${LINE}`,
        borderRadius: RADIUS,
        padding: "8px 0",
      }}>
        <SectionHeader
          title={tr("modules", locale)}
          right={`${completedCount} ${tr("of", locale)} ${totalContent}`}
        />
        <div role="list">
          {contentModules.map((m, i) => {
            const done = completedSet.has(m.id);
            const isNext = !done && contentModules.slice(0, i).every(p => completedSet.has(p.id));
            const locked = !done && !isNext;
            return (
              <ModuleRow
                key={m.id}
                module={m}
                locale={locale}
                done={done}
                isNext={isNext}
                locked={locked}
                onOpen={() => { if (!locked) onOpenModule(m.id); }}
              />
            );
          })}
        </div>
      </section>

      {/* Knowledge Check + Acknowledgment */}
      <section className="qleno-lms-step-grid" style={{
        display: "grid", gap: 12,
        gridTemplateColumns: "1fr 1fr",
      }}>
        <FinalStepCard
          stepLabel={`${tr("step", locale)} 9`}
          title={tr("knowledgeCheck", locale)}
          description={
            isQuizLocked
              ? `${tr("retryAvailableAt", locale)} ${quizLockedUntil ? quizLockedUntil.toLocaleString(locale === "en" ? "en-US" : "es-ES", { dateStyle: "medium", timeStyle: "short" }) : ""}`
              : quizPassed
                ? `${locale === "en" ? "Best score" : "Mejor puntuación"}: ${Math.round(progress.bestQuizScore * 100)}%`
                : (locale === "en"
                    ? `Answer all questions to verify your understanding. ${Math.round(QUIZ_PASS_THRESHOLD * 100)}% required to pass.`
                    : `Responde todas las preguntas para verificar tu comprensión. ${Math.round(QUIZ_PASS_THRESHOLD * 100)}% requerido para aprobar.`)
          }
          enabled={allContentDone && !isQuizLocked}
          completed={quizPassed}
          lockedReason={isQuizLocked ? tr("reviewMaterials", locale) : tr("quizLocked", locale)}
          ctaLabel={quizPassed ? tr("retakeQuiz", locale) : tr("startTraining", locale)}
          onClick={onStartQuiz}
        />
        <FinalStepCard
          stepLabel={`${tr("finalStep", locale)}`}
          title={tr("acknowledgment", locale)}
          description={
            isFullyDone
              ? `${tr("acknowledged", locale)} ${formatDate(progress.acknowledgedAt!, locale)}`
              : (locale === "en"
                  ? "Sign your name and submit to record your training."
                  : "Firma con tu nombre y envía para registrar tu capacitación.")
          }
          enabled={quizPassed}
          completed={isFullyDone}
          lockedReason={tr("ackLocked", locale)}
          ctaLabel={isFullyDone ? tr("done", locale) : tr("startTraining", locale)}
          onClick={onStartAck}
        />
      </section>
    </div>
  );
}

function formatDate(iso: string, locale: Locale) {
  return new Date(iso).toLocaleDateString(locale === "en" ? "en-US" : "es-ES", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: INK_LIGHT, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: INK, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em" }}>
          {value}
        </span>
        {sub && <span style={{ fontSize: 12, color: INK_MUTE, fontWeight: 500 }}>{sub}</span>}
      </div>
    </div>
  );
}

function Divider() {
  return <div style={{ width: 1, height: 32, background: LINE, flexShrink: 0 }} />;
}

function SectionHeader({ title, right }: { title: string; right?: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "12px 24px",
      borderBottom: `1px solid ${LINE_SOFT}`,
    }}>
      <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: INK, letterSpacing: "0.02em", textTransform: "uppercase" }}>
        {title}
      </h2>
      {right && <span style={{ fontSize: 12, color: INK_LIGHT, fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>{right}</span>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Module row — single-line list item, Workday inbox feel
// ─────────────────────────────────────────────────────────────────────────────
function ModuleRow({
  module: m, locale, done, isNext, locked, onOpen,
}: {
  module: Module; locale: Locale; done: boolean; isNext: boolean; locked: boolean; onOpen: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isQlenoApp = m.id === "qleno-app";
  const interactive = !locked;

  return (
    <button
      onClick={() => { if (interactive) onOpen(); }}
      role="listitem"
      disabled={locked}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="qleno-lms-module-row"
      style={{
        textAlign: "left",
        width: "100%",
        background: interactive && hovered ? LINE_SOFT : "transparent",
        border: "none",
        borderBottom: `1px solid ${LINE_SOFT}`,
        padding: "16px 24px",
        cursor: interactive ? "pointer" : "not-allowed",
        display: "grid",
        gridTemplateColumns: "auto minmax(0,1fr) auto",
        gap: 16,
        alignItems: "center",
        fontFamily: FONT,
        transition: "background 0.12s",
        opacity: locked ? 0.55 : 1,
      }}
    >
      <div style={{
        width: 28, height: 28, borderRadius: "50%",
        background: done ? NAVY : (locked ? LINE_SOFT : SURFACE),
        border: done ? `1px solid ${NAVY}` : `1px solid ${LINE}`,
        color: done ? SURFACE : (locked ? INK_LIGHT : INK_MUTE),
        display: "flex", alignItems: "center", justifyContent: "center",
        fontWeight: 700, fontSize: 12,
        fontVariantNumeric: "tabular-nums",
      }}>
        {done ? <Check size={14} strokeWidth={3} /> : (locked ? <Lock size={12} /> : m.number)}
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: locked ? INK_MUTE : INK, letterSpacing: "-0.005em" }}>
            {m.title[locale]}
          </span>
          {isNext && !done && !locked && (
            <span style={{
              fontSize: 10, fontWeight: 700, color: NAVY,
              background: "#EEF2F8",
              padding: "2px 7px", borderRadius: 999,
              letterSpacing: "0.04em", textTransform: "uppercase",
            }}>
              {tr("upNext", locale)}
            </span>
          )}
          {locked && (
            <span style={{
              fontSize: 10, fontWeight: 700, color: INK_LIGHT,
              background: LINE_SOFT,
              padding: "2px 7px", borderRadius: 999,
              letterSpacing: "0.04em", textTransform: "uppercase",
              display: "inline-flex", alignItems: "center", gap: 3,
            }}>
              <Lock size={9} />
              {tr("locked", locale)}
            </span>
          )}
          {isQlenoApp && !locked && (
            <span style={{
              fontSize: 10, fontWeight: 700, color: WARN,
              background: "#FEF3C7",
              padding: "2px 7px", borderRadius: 999,
              letterSpacing: "0.04em", textTransform: "uppercase",
            }}>
              {tr("comingSoon", locale)}
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, color: INK_MUTE, lineHeight: 1.45 }}>
          {m.subtitle[locale]}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
        <span className="qleno-lms-module-time" style={{ fontSize: 12, color: INK_LIGHT, fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>
          {m.estimatedMinutes} {tr("minutes", locale)}
        </span>
        {!locked && <ChevronRight size={16} style={{ color: INK_LIGHT }} />}
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Final-step card (quiz / ack) — minimal
// ─────────────────────────────────────────────────────────────────────────────
function FinalStepCard({
  stepLabel, title, description, enabled, completed, lockedReason, ctaLabel, onClick,
}: {
  stepLabel: string;
  title: string;
  description: string;
  enabled: boolean;
  completed: boolean;
  lockedReason: string;
  ctaLabel: string;
  onClick: () => void;
}) {
  const disabled = !enabled && !completed;
  return (
    <div style={{
      background: SURFACE,
      border: `1px solid ${LINE}`,
      borderRadius: RADIUS,
      padding: 20,
      display: "flex", flexDirection: "column",
      gap: 10,
      opacity: disabled ? 0.85 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <p style={{
          margin: 0,
          fontSize: 10, fontWeight: 700, color: INK_LIGHT,
          letterSpacing: "0.10em", textTransform: "uppercase",
        }}>
          {stepLabel}
        </p>
        {completed && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: SUCCESS }}>
            <Check size={12} strokeWidth={3} />
            {/* short label */}
          </span>
        )}
      </div>
      <h3 style={{
        margin: 0, fontSize: 16, fontWeight: 700, color: INK,
        letterSpacing: "-0.01em",
      }}>
        {title}
      </h3>
      <p style={{ margin: 0, fontSize: 13, color: INK_MUTE, lineHeight: 1.5, flex: 1 }}>
        {description}
      </p>
      {disabled ? (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 10px",
          background: LINE_SOFT,
          color: INK_MUTE,
          borderRadius: 6, fontSize: 12,
        }}>
          <AlertTriangle size={13} />
          {lockedReason}
        </div>
      ) : (
        <div>
          <button
            onClick={onClick}
            style={{
              padding: "8px 14px",
              background: completed ? "transparent" : NAVY,
              color: completed ? NAVY : SURFACE,
              border: completed ? `1px solid ${LINE}` : "none",
              borderRadius: 8,
              fontFamily: FONT, fontSize: 13, fontWeight: 600,
              cursor: "pointer",
              display: "inline-flex", alignItems: "center", gap: 4,
            }}
          >
            {ctaLabel}
            <ChevronRight size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Buttons
// ─────────────────────────────────────────────────────────────────────────────
function PrimaryButton({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        padding: "10px 18px",
        background: disabled ? "#94A3B8" : (hov ? NAVY_HOV : NAVY),
        color: SURFACE, border: "none",
        borderRadius: 8,
        fontFamily: FONT, fontSize: 13, fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        display: "inline-flex", alignItems: "center", gap: 6,
        transition: "background 0.12s",
      }}
    >
      {children}
    </button>
  );
}

function SecondaryButton({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        padding: "10px 18px",
        background: hov ? LINE_SOFT : SURFACE,
        color: INK,
        border: `1px solid ${LINE}`,
        borderRadius: 8,
        fontFamily: FONT, fontSize: 13, fontWeight: 600,
        cursor: "pointer",
        transition: "background 0.12s",
      }}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Module view
// ─────────────────────────────────────────────────────────────────────────────
function ModuleView({
  module: m, total, locale, completed, onBack, onComplete, onPrevious, hasPrevious, hasNext,
}: {
  module: Module; total: number; locale: Locale; completed: boolean;
  onBack: () => void; onComplete: () => void; onPrevious: () => void;
  hasPrevious: boolean; hasNext: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Read timer: must spend MIN_READ_SECONDS on the page before "Mark complete"
  // unlocks. If the module is already completed, no timer needed (review mode).
  const [secondsRemaining, setSecondsRemaining] = useState(completed ? 0 : MIN_READ_SECONDS);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    setSecondsRemaining(completed ? 0 : MIN_READ_SECONDS);
  }, [m.id, completed]);

  useEffect(() => {
    if (secondsRemaining <= 0) return;
    const id = setInterval(() => {
      setSecondsRemaining(s => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [secondsRemaining > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const canComplete = secondsRemaining === 0;

  return (
    <div ref={ref} style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <BackLink label={tr("back", locale)} onClick={onBack} />
        <span style={{ fontSize: 11, fontWeight: 600, color: INK_LIGHT, letterSpacing: "0.06em", textTransform: "uppercase", fontVariantNumeric: "tabular-nums" }}>
          {tr("module", locale)} {m.number} / {total}
        </span>
      </div>

      <article className="qleno-lms-section" style={{
        background: SURFACE,
        borderRadius: RADIUS,
        border: `1px solid ${LINE}`,
        padding: "40px 48px",
      }}>
        <header style={{ marginBottom: 28, display: "flex", gap: 24, alignItems: "flex-start" }}>
          <div style={{ flexShrink: 0 }}>
            <ModuleIcon kind={m.iconKind} size={88} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <p style={{
              margin: "0 0 10px",
              fontSize: 11, fontWeight: 600, color: INK_LIGHT,
              letterSpacing: "0.10em", textTransform: "uppercase",
            }}>
              {tr("module", locale)} {m.number} · {m.estimatedMinutes} {tr("minutes", locale)}
            </p>
            <h1 style={{
              fontSize: 28, fontWeight: 700, color: INK,
              margin: 0, letterSpacing: "-0.02em", lineHeight: 1.18,
            }}>
              {m.title[locale]}
            </h1>
            <p style={{
              fontSize: 15, color: INK_MUTE,
              marginTop: 8, marginBottom: 0, lineHeight: 1.5,
            }}>
              {m.subtitle[locale]}
            </p>
          </div>
        </header>

        <div style={{ height: 1, background: LINE_SOFT, marginBottom: 28 }} />

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {m.blocks.map((b, i) => <Block key={i} block={b} locale={locale} />)}
        </div>
      </article>

      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 12, flexWrap: "wrap",
      }}>
        <SecondaryButton onClick={onPrevious}>
          <ChevronLeft size={13} style={{ marginRight: 6 }} />
          {hasPrevious ? tr("previous", locale) : tr("back", locale)}
        </SecondaryButton>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {!canComplete && (
            <span style={{ fontSize: 12, color: INK_MUTE, fontVariantNumeric: "tabular-nums" }}>
              {tr("readMore", locale)} {secondsRemaining}s
            </span>
          )}
          <PrimaryButton onClick={onComplete} disabled={!canComplete}>
            {completed && <Check size={13} strokeWidth={3} />}
            {hasNext
              ? (completed ? tr("next", locale) : tr("markComplete", locale))
              : (completed ? tr("back", locale) : tr("markComplete", locale))}
            <ChevronRight size={13} />
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "none", border: "none", cursor: "pointer",
        color: INK_MUTE, fontFamily: FONT, fontSize: 13, fontWeight: 500,
        padding: 0, display: "inline-flex", alignItems: "center", gap: 5,
      }}
    >
      <ArrowLeft size={14} />
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Content blocks
// ─────────────────────────────────────────────────────────────────────────────
function Block({ block: b, locale }: { block: ContentBlock; locale: Locale }) {
  if (b.type === "p") {
    return <p style={{ fontSize: 15, lineHeight: 1.7, color: INK, margin: 0 }}>{b.text[locale]}</p>;
  }
  if (b.type === "h") {
    return (
      <h2 style={{
        fontSize: 14, fontWeight: 700, color: INK,
        margin: "10px 0 -6px",
        letterSpacing: "0.02em", textTransform: "uppercase",
      }}>
        {b.text[locale]}
      </h2>
    );
  }
  if (b.type === "bullets") {
    return (
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
        {b.items.map((it, i) => (
          <li key={i} style={{ display: "flex", gap: 12, fontSize: 15, lineHeight: 1.6, color: INK }}>
            <span style={{
              flexShrink: 0, marginTop: 9,
              width: 4, height: 4, borderRadius: "50%", background: INK_LIGHT,
            }} />
            <span>{it[locale]}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (b.type === "callout") {
    const tones = {
      info:    { bg: "#F1F5F9", border: NAVY,    color: INK,       icon: <Info size={15} /> },
      warning: { bg: "#FEF7EB", border: WARN,    color: "#7C4A03", icon: <AlertTriangle size={15} /> },
      success: { bg: "#ECFDF5", border: SUCCESS, color: "#065F46", icon: <CircleCheck size={15} /> },
    } as const;
    const tone = tones[b.tone];
    return (
      <div style={{
        background: tone.bg,
        borderLeft: `3px solid ${tone.border}`,
        padding: "12px 16px",
        borderRadius: 6,
        display: "flex", alignItems: "flex-start", gap: 10,
        color: tone.color,
        fontSize: 14, lineHeight: 1.55,
      }}>
        <span style={{ flexShrink: 0, marginTop: 1, color: tone.border }}>{tone.icon}</span>
        <span>{b.text[locale]}</span>
      </div>
    );
  }
  if (b.type === "table") {
    const head = b.head[locale];
    return (
      <div style={{ overflowX: "auto", border: `1px solid ${LINE}`, borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: FONT }}>
          <thead>
            <tr>
              {head.map((h, i) => (
                <th key={i} style={{
                  textAlign: "left", padding: "10px 14px",
                  fontSize: 11, fontWeight: 700, color: INK_MUTE,
                  letterSpacing: "0.06em", textTransform: "uppercase",
                  borderBottom: `1px solid ${LINE}`,
                  background: LINE_SOFT,
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, i) => (
              <tr key={i} style={{ borderBottom: i < b.rows.length - 1 ? `1px solid ${LINE_SOFT}` : "none" }}>
                {r[locale].map((c, j) => (
                  <td key={j} style={{ padding: "10px 14px", fontSize: 14, color: INK }}>{c}</td>
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

function NotFoundModule({ onBack, locale }: { onBack: () => void; locale: Locale }) {
  return (
    <div>
      <BackLink label={tr("back", locale)} onClick={onBack} />
      <p style={{ marginTop: 24 }}>Module not found.</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Quiz intro — explains passing rules + retake policy
// ─────────────────────────────────────────────────────────────────────────────
function QuizIntroView({
  locale, attempts, questionCount, onBack, onBegin,
}: {
  locale: Locale;
  attempts: number;
  questionCount: number;
  onBack: () => void;
  onBegin: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <BackLink label={tr("back", locale)} onClick={onBack} />
        {attempts > 0 && (
          <span style={{ fontSize: 11, fontWeight: 600, color: INK_LIGHT, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            {tr("attempt", locale)} {attempts + 1}
          </span>
        )}
      </div>
      <article className="qleno-lms-section" style={{
        background: SURFACE,
        borderRadius: RADIUS,
        border: `1px solid ${LINE}`,
        padding: "40px 48px",
      }}>
        <p style={{
          margin: "0 0 10px",
          fontSize: 11, fontWeight: 600, color: INK_LIGHT,
          letterSpacing: "0.10em", textTransform: "uppercase",
        }}>
          {tr("quizIntroTitle", locale)}
        </p>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: INK, margin: 0, letterSpacing: "-0.02em", lineHeight: 1.18 }}>
          {tr("knowledgeCheck", locale)}
        </h1>
        <p style={{ fontSize: 15, color: INK, marginTop: 14, marginBottom: 0, lineHeight: 1.6 }}>
          {tr("quizIntroBody", locale)}
        </p>
        <div style={{ marginTop: 22, padding: "14px 16px", background: "#F1F5F9", borderRadius: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ color: INK_MUTE }}>{locale === "en" ? "Questions" : "Preguntas"}</span>
            <span style={{ color: INK, fontWeight: 600 }}>{questionCount}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ color: INK_MUTE }}>{locale === "en" ? "Minimum to pass" : "Mínimo para aprobar"}</span>
            <span style={{ color: INK, fontWeight: 600 }}>80%</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ color: INK_MUTE }}>{locale === "en" ? "Retakes" : "Reintentos"}</span>
            <span style={{ color: INK, fontWeight: 600 }}>{locale === "en" ? "Up to 2 attempts before manager review" : "Hasta 2 intentos antes de revisión gerencial"}</span>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 24, flexWrap: "wrap" }}>
          <PrimaryButton onClick={onBegin}>
            {tr("quizIntroBegin", locale)}
            <ChevronRight size={13} />
          </PrimaryButton>
          <SecondaryButton onClick={onBack}>{tr("back", locale)}</SecondaryButton>
        </div>
      </article>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Quiz view
// ─────────────────────────────────────────────────────────────────────────────
function QuizView({
  quiz, locale, attemptNumber, onBack, onComplete, onProceed, onReturnHome,
}: {
  quiz: QuizQuestion[]; locale: Locale;
  attemptNumber: number;
  onBack: () => void;
  onComplete: (score: number) => void;
  onProceed: () => void;
  onReturnHome: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<(number | null)[]>(() => quiz.map(() => null));
  const [submitted, setSubmitted] = useState<boolean[]>(() => quiz.map(() => false));
  const [done, setDone] = useState(false);

  const q = quiz[idx];
  const selected = answers[idx];
  const isSubmittedNow = submitted[idx];

  function selectOption(i: number) {
    if (isSubmittedNow) return;
    setAnswers(prev => { const next = [...prev]; next[idx] = i; return next; });
  }

  function submitAnswer() {
    if (selected === null) return;
    setSubmitted(prev => { const next = [...prev]; next[idx] = true; return next; });
  }

  function nextQuestion() {
    if (idx < quiz.length - 1) setIdx(idx + 1);
    else {
      const correct = answers.filter((a, i) => a === quiz[i].correctIndex).length;
      const score = correct / quiz.length;
      onComplete(score);
      setDone(true);
    }
  }

  if (done) {
    const correct = answers.filter((a, i) => a === quiz[i].correctIndex).length;
    const score = correct / quiz.length;
    const pct = Math.round(score * 100);
    const passed = score >= QUIZ_PASS_THRESHOLD;
    const missed = quiz
      .map((qq, i) => ({ q: qq, given: answers[i] }))
      .filter(x => x.given !== x.q.correctIndex);

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <BackLink label={tr("back", locale)} onClick={onBack} />
        <article className="qleno-lms-section" style={{
          background: SURFACE,
          borderRadius: RADIUS,
          border: `1px solid ${LINE}`,
          padding: "40px 48px",
        }}>
          <p style={{
            margin: "0 0 10px",
            fontSize: 11, fontWeight: 600, color: INK_LIGHT,
            letterSpacing: "0.10em", textTransform: "uppercase",
          }}>
            {tr("quizResults", locale)}
          </p>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 14 }}>
            <span style={{ fontSize: 56, fontWeight: 700, color: INK, letterSpacing: "-0.03em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
              {pct}%
            </span>
            <span style={{
              padding: "5px 12px", borderRadius: 999,
              background: passed ? "#ECFDF5" : "#FEF2F2",
              color: passed ? SUCCESS : DANGER,
              fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
            }}>
              {passed ? tr("passed", locale) : tr("retakeNeeded", locale)}
            </span>
          </div>
          <p style={{ fontSize: 14, color: INK_MUTE, margin: 0 }}>
            {correct} / {quiz.length} {locale === "en" ? "correct" : "correctas"}
          </p>

          {missed.length > 0 && (
            <div style={{ marginTop: 28 }}>
              <h3 style={{ fontSize: 13, fontWeight: 700, color: INK, margin: "0 0 12px", letterSpacing: "0.02em", textTransform: "uppercase" }}>
                {tr("reviewMissed", locale)}
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {missed.map((x, i) => (
                  <div key={i} style={{
                    border: `1px solid ${LINE}`, borderRadius: 8,
                    padding: 14,
                  }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: INK, marginBottom: 8 }}>
                      {x.q.prompt[locale]}
                    </div>
                    {x.given !== null && (
                      <div style={{ fontSize: 13, color: DANGER, display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <X size={13} /> {x.q.options[x.given][locale]}
                      </div>
                    )}
                    <div style={{ fontSize: 13, color: SUCCESS, display: "flex", alignItems: "center", gap: 6 }}>
                      <Check size={13} strokeWidth={3} /> {x.q.options[x.q.correctIndex][locale]}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!passed && attemptNumber >= 2 && (
            <div style={{
              marginTop: 24,
              padding: "14px 16px",
              background: "#FEF7EB",
              borderLeft: `3px solid ${WARN}`,
              borderRadius: 6,
              display: "flex", alignItems: "flex-start", gap: 10,
              color: "#7C4A03", fontSize: 14, lineHeight: 1.5,
            }}>
              <Lock size={16} style={{ marginTop: 1, flexShrink: 0 }} />
              <span>{tr("reviewMaterials", locale)}</span>
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 28, flexWrap: "wrap" }}>
            {passed && (
              <PrimaryButton onClick={onProceed}>
                {tr("proceedAck", locale)}
                <ChevronRight size={13} />
              </PrimaryButton>
            )}
            {!passed && attemptNumber < 2 && (
              <PrimaryButton onClick={() => {
                setIdx(0);
                setAnswers(quiz.map(() => null));
                setSubmitted(quiz.map(() => false));
                setDone(false);
              }}>
                {tr("retakeQuiz", locale)}
              </PrimaryButton>
            )}
            {!passed && attemptNumber >= 2 ? (
              <PrimaryButton onClick={onReturnHome}>
                {tr("returnHome", locale)}
              </PrimaryButton>
            ) : (
              <SecondaryButton onClick={onBack}>{tr("back", locale)}</SecondaryButton>
            )}
          </div>
        </article>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <BackLink label={tr("back", locale)} onClick={onBack} />
        <span style={{ fontSize: 11, fontWeight: 600, color: INK_LIGHT, letterSpacing: "0.06em", textTransform: "uppercase", fontVariantNumeric: "tabular-nums" }}>
          {tr("question", locale)} {idx + 1} / {quiz.length}
        </span>
      </div>

      <article className="qleno-lms-section" style={{
        background: SURFACE,
        borderRadius: RADIUS,
        border: `1px solid ${LINE}`,
        padding: "40px 48px",
      }}>
        <p style={{
          margin: "0 0 10px",
          fontSize: 11, fontWeight: 600, color: INK_LIGHT,
          letterSpacing: "0.10em", textTransform: "uppercase",
        }}>
          {tr("knowledgeCheck", locale)}
        </p>

        <div style={{ height: 3, background: LINE_SOFT, borderRadius: 999, overflow: "hidden", marginBottom: 28 }}>
          <div style={{
            height: "100%",
            width: `${((idx + (isSubmittedNow ? 1 : 0)) / quiz.length) * 100}%`,
            background: NAVY,
            transition: "width 0.4s",
          }} />
        </div>

        <h2 style={{
          fontSize: 22, fontWeight: 700, color: INK, margin: 0,
          letterSpacing: "-0.015em", lineHeight: 1.4,
        }}>
          {q.prompt[locale]}
        </h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 22 }}>
          {q.options.map((opt, i) => {
            const isSelected = selected === i;
            const isCorrect = i === q.correctIndex;
            const showCorrect = isSubmittedNow && isCorrect;
            const showWrong = isSubmittedNow && isSelected && !isCorrect;
            const borderColor = showCorrect ? SUCCESS
              : showWrong ? DANGER
              : isSelected ? NAVY
              : LINE;
            const bg = showCorrect ? "#ECFDF5"
              : showWrong ? "#FEF2F2"
              : isSelected ? "#F8FAFF"
              : SURFACE;
            return (
              <button
                key={i}
                onClick={() => selectOption(i)}
                disabled={isSubmittedNow}
                style={{
                  textAlign: "left",
                  width: "100%",
                  padding: "13px 16px",
                  background: bg,
                  border: `1.5px solid ${borderColor}`,
                  borderRadius: 8,
                  cursor: isSubmittedNow ? "default" : "pointer",
                  fontFamily: FONT, fontSize: 14, fontWeight: 500,
                  color: INK,
                  display: "flex", alignItems: "center", gap: 12,
                  transition: "background 0.12s, border-color 0.12s",
                }}
              >
                <span style={{
                  width: 18, height: 18, flexShrink: 0,
                  borderRadius: "50%",
                  border: `1.5px solid ${borderColor === LINE ? "#CBD5E1" : borderColor}`,
                  background: showCorrect ? SUCCESS : showWrong ? DANGER : isSelected ? NAVY : SURFACE,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: SURFACE,
                }}>
                  {showCorrect && <Check size={11} strokeWidth={3.5} />}
                  {showWrong && <X size={11} strokeWidth={3.5} />}
                  {!isSubmittedNow && isSelected && (
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: SURFACE }} />
                  )}
                </span>
                <span style={{ flex: 1 }}>{opt[locale]}</span>
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 24 }}>
          {!isSubmittedNow ? (
            <PrimaryButton onClick={submitAnswer} disabled={selected === null}>
              {tr("submitAnswer", locale)}
            </PrimaryButton>
          ) : (
            <PrimaryButton onClick={nextQuestion}>
              {idx < quiz.length - 1 ? tr("nextQuestion", locale) : tr("seeResults", locale)}
              <ChevronRight size={13} />
            </PrimaryButton>
          )}
        </div>
      </article>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Acknowledgment
// ─────────────────────────────────────────────────────────────────────────────
function AckView({
  module: m, locale, learner, tenantName, onBack, onSubmitted,
}: {
  module: Module; locale: Locale;
  learner: Learner | null;
  tenantName: string;
  onBack: () => void;
  onSubmitted: (name: string) => void;
}) {
  const initialName = learner ? `${learner.firstName} ${learner.lastName}`.trim() : "";
  const [name, setName] = useState(initialName);
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length >= 2 && checked && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const completedAt = new Date().toISOString();
    const dateStr = new Date().toLocaleDateString(locale === "en" ? "en-US" : "es-ES", {
      year: "numeric", month: "long", day: "numeric",
    });
    const employeeEmail = learner?.email || "";
    const payload = {
      subject: `Training Complete: ${name.trim()}`,
      body: `Employee ${name.trim()} completed Phes training on ${dateStr}.`,
      employee_name: name.trim(),
      employee_email: employeeEmail,
      tenant: tenantName,
      locale,
      completed_at: completedAt,
      cc: ["salmartinez@phes.io"],
      to: [employeeEmail, "salmartinez@phes.io"].filter(Boolean),
    };

    try {
      const res = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        mode: "cors",
      }).catch(async () => {
        return fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          mode: "no-cors",
        });
      });
      void res;
      onSubmitted(name.trim());
    } catch {
      setError(locale === "en"
        ? "Could not submit acknowledgment. Please check your connection and try again."
        : "No se pudo enviar el reconocimiento. Verifica tu conexión e inténtalo de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <BackLink label={tr("back", locale)} onClick={onBack} />
        <span style={{ fontSize: 11, fontWeight: 600, color: INK_LIGHT, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          {tr("finalStep", locale)}
        </span>
      </div>

      <article className="qleno-lms-section" style={{
        background: SURFACE,
        borderRadius: RADIUS,
        border: `1px solid ${LINE}`,
        padding: "40px 48px",
      }}>
        <p style={{
          margin: "0 0 10px",
          fontSize: 11, fontWeight: 600, color: INK_LIGHT,
          letterSpacing: "0.10em", textTransform: "uppercase",
        }}>
          {tr("acknowledgment", locale)}
        </p>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: INK, margin: 0, letterSpacing: "-0.02em", lineHeight: 1.18 }}>
          {m.title[locale]}
        </h1>
        <p style={{ fontSize: 15, color: INK_MUTE, marginTop: 8, marginBottom: 24, lineHeight: 1.5 }}>
          {m.subtitle[locale]}
        </p>

        <div style={{ height: 1, background: LINE_SOFT, marginBottom: 24 }} />

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {m.blocks.map((b, i) => <Block key={i} block={b} locale={locale} />)}
        </div>

        <div style={{ height: 1, background: LINE_SOFT, margin: "32px 0 24px" }} />

        <p style={{ fontSize: 14, color: INK, lineHeight: 1.6, margin: 0 }}>
          {tr("ackPrompt", locale)}
        </p>

        <label style={{ display: "block", marginTop: 18 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: INK_MUTE, letterSpacing: "0.06em", textTransform: "uppercase", display: "block", marginBottom: 6 }}>
            {tr("fullName", locale)}
          </span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            autoComplete="name"
            style={{
              width: "100%", padding: "10px 14px",
              border: `1.5px solid ${LINE}`,
              borderRadius: 8,
              fontSize: 15, fontFamily: FONT, color: INK,
              outline: "none",
              boxSizing: "border-box",
              transition: "border-color 0.12s",
              background: SURFACE,
            }}
            onFocus={e => (e.currentTarget.style.borderColor = NAVY)}
            onBlur={e => (e.currentTarget.style.borderColor = LINE)}
            placeholder={locale === "en" ? "Type your full legal name" : "Escribe tu nombre legal completo"}
          />
        </label>

        <label style={{
          display: "flex", alignItems: "flex-start", gap: 10,
          padding: 14, borderRadius: 8,
          background: checked ? "#F8FAFF" : SURFACE,
          border: `1.5px solid ${checked ? NAVY : LINE}`,
          cursor: "pointer", marginTop: 14,
          transition: "background 0.12s, border-color 0.12s",
        }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={e => setChecked(e.target.checked)}
            style={{
              marginTop: 3,
              width: 16, height: 16,
              accentColor: NAVY,
              cursor: "pointer",
            }}
          />
          <span style={{ fontSize: 14, color: INK, lineHeight: 1.5 }}>
            {tr("ackCheckbox", locale)}
          </span>
        </label>

        {error && (
          <div style={{
            marginTop: 12, padding: "10px 12px",
            background: "#FEF2F2", color: "#991B1B",
            borderRadius: 6, fontSize: 13,
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <AlertTriangle size={14} />
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 24, flexWrap: "wrap" }}>
          <PrimaryButton onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? tr("submitting", locale) : tr("submitAck", locale)}
            {!submitting && <ChevronRight size={13} />}
          </PrimaryButton>
          <SecondaryButton onClick={onBack}>{tr("back", locale)}</SecondaryButton>
        </div>
      </article>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Done
// ─────────────────────────────────────────────────────────────────────────────
function DoneView({
  locale, tenantName, acknowledgedAt, scorePct, name, onReturn, onStartOver,
}: {
  locale: Locale;
  tenantName: string;
  acknowledgedAt: string | null;
  scorePct: number;
  name: string;
  onReturn: () => void;
  onStartOver: () => void;
}) {
  const dt = acknowledgedAt ? new Date(acknowledgedAt) : new Date();
  const dateStr = dt.toLocaleDateString(locale === "en" ? "en-US" : "es-ES", {
    year: "numeric", month: "long", day: "numeric",
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <article className="qleno-lms-section" style={{
        background: SURFACE,
        borderRadius: RADIUS,
        border: `1px solid ${LINE}`,
        padding: "48px 48px",
        textAlign: "center",
        position: "relative",
        overflow: "hidden",
      }}>
        {/* Subtle navy banner across the top */}
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 6, background: NAVY }} />

        <div style={{
          width: 64, height: 64, borderRadius: "50%",
          background: "#ECFDF5",
          color: SUCCESS,
          display: "flex", alignItems: "center", justifyContent: "center",
          margin: "16px auto 18px",
        }}>
          <Award size={30} strokeWidth={2.4} />
        </div>

        <p style={{
          fontSize: 11, fontWeight: 700, color: INK_LIGHT,
          letterSpacing: "0.14em", textTransform: "uppercase",
          margin: "0 0 6px",
        }}>
          {tr("certificate", locale)}
        </p>
        <h1 style={{ fontSize: 30, fontWeight: 700, color: INK, margin: 0, letterSpacing: "-0.02em", lineHeight: 1.15 }}>
          {tr("done", locale)}
        </h1>

        <p style={{ fontSize: 12, color: INK_LIGHT, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginTop: 28, marginBottom: 4 }}>
          {tr("awardedTo", locale)}
        </p>
        <p style={{ fontSize: 24, fontWeight: 700, color: INK, margin: 0, letterSpacing: "-0.015em" }}>
          {name || (locale === "en" ? "Employee" : "Empleado")}
        </p>

        <p style={{ fontSize: 14, color: INK_MUTE, marginTop: 12 }}>
          {locale === "en"
            ? `Completed Phes new hire training ${tr("on", locale)} ${dateStr}.`
            : `Completó la capacitación de nuevo empleado de Phes ${tr("on", locale)} ${dateStr}.`}
        </p>

        {/* Score panel */}
        <div style={{
          display: "inline-flex",
          gap: 24,
          marginTop: 22,
          padding: "12px 20px",
          background: "#F1F5F9",
          borderRadius: 10,
          border: `1px solid ${LINE}`,
        }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: INK_LIGHT, letterSpacing: "0.10em", textTransform: "uppercase" }}>
              {tr("yourScore", locale)}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: NAVY, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
              {scorePct}%
            </div>
          </div>
          <div style={{ width: 1, background: LINE }} />
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: INK_LIGHT, letterSpacing: "0.10em", textTransform: "uppercase" }}>
              {locale === "en" ? "Required" : "Requerido"}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: INK_MUTE, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
              80%
            </div>
          </div>
        </div>

        <p style={{ fontSize: 11, color: INK_LIGHT, marginTop: 18, fontWeight: 500 }}>
          {tenantName} · {dateStr}
        </p>

        <p style={{ fontSize: 13, color: INK_MUTE, marginTop: 18, lineHeight: 1.55, maxWidth: 460, marginLeft: "auto", marginRight: "auto" }}>
          {tr("doneSub", locale)}
        </p>

        <div style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 26, flexWrap: "wrap" }}>
          <PrimaryButton onClick={onReturn}>{tr("returnHome", locale)}</PrimaryButton>
          <SecondaryButton onClick={onStartOver}>{tr("startOver", locale)}</SecondaryButton>
        </div>
      </article>
    </div>
  );
}
