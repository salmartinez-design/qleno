/**
 * Qleno LMS — Curriculum
 *
 * Multi-tenant: every tenant inherits the BASE curriculum (defined here)
 * and may layer additional modules via TENANT_OVERRIDES keyed by company_id.
 *
 * Phes (company_id = 1) is the originator of the base curriculum.
 *
 * Each module ships in EN and ES. Sections are rendered in order. Optional
 * `bullets`, `callout`, and `divider` blocks compose the page content.
 *
 * Structure (Phes-restructure 2026-05-09):
 *   1. Phes Policies & Procedures   — Welcome + Attendance + Dress Code merged
 *   2. Compensation                 — Tiered residential (35% standard, 32%
 *                                     deep + move at $80/hr to client),
 *                                     commercial $20/hr, Fix-It, probation
 *   3. Cleaning Best Practices      — Speed-Cleaning Method (13 rules,
 *                                     name-stripped from former branded ref)
 *   4. MaidCentral                  — Two-clock system + Qleno coming-next
 *   5. Products & Tools             — Existing 10 products + Zep Mold &
 *                                     Mildew, Magic Eraser, Pumice Stone,
 *                                     #0000 Steel Wool with safety + don'ts
 *   plus Acknowledgment final step.
 *
 * 15 quiz questions per module = 75 total. The final mixed exam samples
 * 50 from the pool (FINAL_TEST_SIZE in lib/lms-curriculum/src/index.ts).
 */

export type Locale = "en" | "es";

export type ContentBlock =
  | { type: "p"; text: { en: string; es: string } }
  | { type: "h"; text: { en: string; es: string } }
  | { type: "bullets"; items: { en: string; es: string }[] }
  | { type: "callout"; tone: "info" | "warning" | "success"; text: { en: string; es: string } }
  | { type: "table"; head: { en: string[]; es: string[] }; rows: { en: string[]; es: string[] }[] };

export type IconKind =
  | "house"        // phes-policies
  | "money"        // compensation
  | "flow"         // cleaning-best-practices
  | "pin"          // maidcentral
  | "spray"        // products-tools
  | "shield";      // acknowledgment

export interface Module {
  id: string;
  number: number;
  iconKind: IconKind;
  title: { en: string; es: string };
  subtitle: { en: string; es: string };
  estimatedMinutes: number;
  blocks: ContentBlock[];
}

export interface QuizQuestion {
  id: string;
  prompt: { en: string; es: string };
  options: { en: string; es: string }[];
  correctIndex: number;
  moduleId: string;
}

export interface Curriculum {
  tenantName: string;
  /**
   * Optional URL to a tenant brand mark rendered next to the tenant name in
   * the training header. Public path or absolute URL. Per-tenant via
   * TENANT_OVERRIDES below; once tenants upload via Company settings this
   * should switch to reading `companies.logo_url` instead.
   */
  tenantLogoUrl?: string;
  modules: Module[];
  quiz: QuizQuestion[];
}

// ─────────────────────────────────────────────────────────────────────────────
// BASE CURRICULUM (Phes) — inherited by every tenant
// ─────────────────────────────────────────────────────────────────────────────

const BASE_MODULES: Module[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // 1. PHES POLICIES & PROCEDURES (Welcome + Attendance + Dress Code merged)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "phes-policies",
    number: 1,
    iconKind: "house",
    title: { en: "Phes Policies & Procedures", es: "Políticas y Procedimientos de Phes" },
    subtitle: {
      en: "Consolidated 2026 Phes Employee Handbook. Read every section. You will sign that you understood it.",
      es: "Manual del Empleado de Phes 2026 consolidado. Lea cada sección. Usted firmará que la entendió.",
    },
    estimatedMinutes: 35,
    blocks: [
      // ═══════════════════════════════════════════════════════════════════════
      // SECTION 1 — INTRODUCTION & AT-WILL STATUS
      // ═══════════════════════════════════════════════════════════════════════
      {
        type: "h",
        text: { en: "SECTION 1. Introduction and At-Will Status", es: "SECCIÓN 1. Introducción y Empleo a Voluntad" },
      },
      { type: "h", text: { en: "Welcome to Phes", es: "Bienvenido a Phes" } },
      {
        type: "p",
        text: {
          en: "Phes Cleaning Service is a residential and light-commercial cleaning company serving the Chicago southwest and northwest suburbs. You are joining a W-2 team. You are not a contractor. You will have steady scheduled work, real benefits, and a clear path from training to full commission. This handbook outlines the policies, expectations, and benefits that govern employment in 2026.",
          es: "Phes Cleaning Service es una compañía de limpieza residencial y comercial ligera que sirve a los suburbios del suroeste y noroeste de Chicago. Se está uniendo a un equipo W-2. Usted no es contratista. Tendrá trabajo programado constante, beneficios reales y un camino claro del entrenamiento a la comisión completa. Este manual describe las políticas, expectativas y beneficios que rigen el empleo en 2026.",
        },
      },
      { type: "h", text: { en: "Employment At-Will (Critical Legal Disclaimer)", es: "Empleo a Voluntad (Aviso Legal Crítico)" } },
      {
        type: "p",
        text: {
          en: "Employment with Phes Cleaning Services is AT-WILL, meaning either the employee or the Company may terminate the employment relationship at any time, with or without cause or notice, for any lawful reason. Nothing in this handbook, nor any oral statement by a supervisor or manager, creates a contract of employment or guarantees continued employment. This handbook is NOT a contract and is provided for informational purposes only.",
          es: "El empleo con Phes Cleaning Services es A VOLUNTAD, lo que significa que el empleado o la Compañía pueden terminar la relación laboral en cualquier momento, con o sin causa, con o sin aviso, por cualquier razón legal. Nada en este manual, ni ninguna declaración oral por parte de un supervisor o gerente, crea un contrato de empleo ni garantiza el empleo continuo. Este manual NO es un contrato y se proporciona solo con fines informativos.",
        },
      },
      {
        type: "p",
        text: {
          en: "All employees must be legally authorized to work in the United States and must complete required employment eligibility verification. Phes uses ADP for federal and state tax forms (I-9, W-4, IL-W-4). You will receive separate ADP access to complete those forms. Bring valid ID documents to the office on your first day for in-person I-9 verification.",
          es: "Todos los empleados deben estar legalmente autorizados para trabajar en los Estados Unidos y deben completar la verificación de elegibilidad para el empleo. Phes usa ADP para los formularios fiscales federales y estatales (I-9, W-4, IL-W-4). Recibirá acceso por separado a ADP para completar esos formularios. Traiga documentos de identificación válidos a la oficina en su primer día para la verificación en persona del I-9.",
        },
      },

      // ═══════════════════════════════════════════════════════════════════════
      // SECTION 2 — COMPENSATION STRUCTURE
      // ═══════════════════════════════════════════════════════════════════════
      { type: "h", text: { en: "SECTION 2. Compensation Structure", es: "SECCIÓN 2. Estructura de Compensación" } },

      { type: "h", text: { en: "Training Pay", es: "Pago de Entrenamiento" } },
      {
        type: "p",
        text: {
          en: "New hires complete a mandatory three-week training period paid at $20.00 per hour. After training, eligible employees move to the commission structure described below.",
          es: "Los nuevos empleados completan un periodo obligatorio de entrenamiento de tres semanas pagado a $20.00 por hora. Después del entrenamiento, los empleados elegibles pasan a la estructura de comisión descrita a continuación.",
        },
      },

      { type: "h", text: { en: "Commission Rates", es: "Tasas de Comisión" } },
      {
        type: "bullets",
        items: [
          { en: "35% commission on STANDARD residential cleanings.", es: "35% de comisión en limpiezas residenciales ESTÁNDAR." },
          { en: "32% commission on DEEP CLEANS and MOVE-IN / MOVE-OUT cleanings (whether hourly or flat rate).", es: "32% de comisión en LIMPIEZAS PROFUNDAS y MUDANZAS (ya sea por hora o tarifa fija)." },
          { en: "$20.00 per hour for all COMMERCIAL cleaning jobs, up to the allotted hours for that job.", es: "$20.00 por hora para todos los trabajos de limpieza COMERCIAL, hasta las horas asignadas para ese trabajo." },
        ],
      },

      { type: "h", text: { en: "Quality Verification (When Commission Is Earned)", es: "Verificación de Calidad (Cuándo Se Gana la Comisión)" } },
      {
        type: "p",
        text: {
          en: "Commission is EARNED upon Quality Verification, which occurs at the earlier of: (a) 24 hours after job completion with no client complaint, or (b) the client's affirmative confirmation of satisfaction. Before Quality Verification, commission is contingent.",
          es: "La comisión se GANA al completarse la Verificación de Calidad, que ocurre en el momento más temprano entre: (a) 24 horas después de completarse el trabajo sin queja del cliente, o (b) la confirmación afirmativa de satisfacción del cliente. Antes de la Verificación de Calidad, la comisión es contingente.",
        },
      },

      { type: "h", text: { en: "Fix-It Rule (Re-Clean Obligation)", es: "Regla de Corrección (Obligación de Re-Limpieza)" } },
      {
        type: "bullets",
        items: [
          { en: "Every Phes cleaning is backed by a 24-hour guarantee. If a client calls within 24 hours unhappy with anything in their home, the original technician(s) return to correct it within that 24-hour window.", es: "Cada limpieza de Phes está respaldada por una garantía de 24 horas. Si un cliente llama dentro de las 24 horas inconforme con cualquier cosa, los técnicos originales regresan a corregirlo dentro de esa ventana de 24 horas." },
          { en: "If the original tech completes the re-clean: full commission is EARNED. The re-clean visit is part of the original commission, no additional pay.", es: "Si el técnico original completa la re-limpieza: se GANA la comisión completa. La visita de re-limpieza es parte de la comisión original, sin pago adicional." },
          { en: "If the original tech refuses the re-clean without a lawful or protected reason: that job converts to $18.00 per hour for on-site time. Quality Verification failed, so the commission was never fully earned. This is NOT a retroactive penalty.", es: "Si el técnico original se niega a la re-limpieza sin razón legal o protegida: ese trabajo se convierte a $18.00 por hora por el tiempo en sitio. La Verificación de Calidad falló, por lo que la comisión nunca se ganó completamente. Esto NO es una penalidad retroactiva." },
          { en: "If the original tech cannot return: Phes may dispatch a recovery technician at $20.00 per hour with a 3-hour minimum (paid 3 hours even if the job takes less time).", es: "Si el técnico original no puede regresar: Phes puede despachar un técnico de recuperación a $20.00 por hora con un mínimo de 3 horas (se pagan 3 horas aunque el trabajo tome menos tiempo)." },
          { en: "Refusing a valid re-clean is INSUBORDINATION and may result in discipline up to and including immediate termination.", es: "Negarse a una re-limpieza válida es INSUBORDINACIÓN y puede resultar en disciplina hasta e incluyendo la terminación inmediata." },
        ],
      },

      { type: "h", text: { en: "Three-Hour Minimum", es: "Mínimo de Tres Horas" } },
      {
        type: "p",
        text: {
          en: "A three-hour pay minimum is guaranteed for any dispatched job, provided the employee remains on-site and working for the duration of the service, unless sent home early by management.",
          es: "Se garantiza un mínimo de pago de tres horas para cualquier trabajo despachado, siempre y cuando el empleado permanezca en el sitio trabajando durante la duración del servicio, a menos que la gerencia lo envíe a casa más temprano.",
        },
      },

      { type: "h", text: { en: "Commercial Job Standards", es: "Estándares de Trabajo Comercial" } },
      {
        type: "bullets",
        items: [
          { en: "$20.00 per hour for the allotted hours of each commercial job, based on documented historical performance data.", es: "$20.00 por hora por las horas asignadas para cada trabajo comercial, basado en datos históricos documentados de desempeño." },
          { en: "Each commercial job has an EXPECTED duration based on past Phes team completion times.", es: "Cada trabajo comercial tiene una duración ESPERADA basada en los tiempos previos de los equipos de Phes." },
          { en: "Exceeding allotted hours requires advance approval from the office. Consistent overruns without justification may affect future assignments and pay.", es: "Exceder las horas asignadas requiere aprobación previa de la oficina. Sobrepasos constantes sin justificación pueden afectar las asignaciones y el pago futuros." },
          { en: "Quality is NON-NEGOTIABLE. Speed should never compromise quality.", es: "La calidad NO ES NEGOCIABLE. La rapidez nunca debe comprometer la calidad." },
        ],
      },

      { type: "h", text: { en: "Quality Probation", es: "Probatoria de Calidad" } },
      {
        type: "p",
        text: {
          en: "Two (2) valid quality complaints within a rolling thirty-day period result in QUALITY PROBATION for thirty (30) days. During probation, compensation is paid at a flat $20.00 per hour. Return to commission eligibility requires thirty (30) consecutive days with zero valid quality complaints.",
          es: "Dos (2) quejas válidas de calidad dentro de un periodo móvil de treinta días resultan en PROBATORIA DE CALIDAD por treinta (30) días. Durante la probatoria, la compensación se paga a $20.00 por hora fija. El regreso a la elegibilidad de comisión requiere treinta (30) días consecutivos con cero quejas válidas de calidad.",
        },
      },

      { type: "h", text: { en: "Minimum Wage Floor and Overtime", es: "Piso de Salario Mínimo y Horas Extra" } },
      {
        type: "bullets",
        items: [
          { en: "Under NO circumstances will weekly gross pay fall below the applicable minimum wage required by federal, Illinois state, or Chicago law (whichever is highest at the work location).", es: "Bajo NINGUNA circunstancia el pago bruto semanal caerá por debajo del salario mínimo requerido por la ley federal, estatal de Illinois o de Chicago (el más alto en el lugar de trabajo)." },
          { en: "Overtime, when applicable, is paid in accordance with federal, state, and local law based on the employee's regular rate of pay.", es: "Las horas extra, cuando aplican, se pagan conforme a la ley federal, estatal y local basadas en la tarifa regular del empleado." },
        ],
      },

      // ═══════════════════════════════════════════════════════════════════════
      // SECTION 3 — ATTENDANCE POLICY
      // ═══════════════════════════════════════════════════════════════════════
      { type: "h", text: { en: "SECTION 3. Attendance Policy", es: "SECCIÓN 3. Política de Asistencia" } },

      { type: "h", text: { en: "Benefit Year (Individualized)", es: "Año de Beneficios (Individualizado)" } },
      {
        type: "p",
        text: {
          en: "Attendance tracking, leave balances, and disciplinary thresholds reset annually on the employee's Work Anniversary (hire date). This twelve-month period is your Benefit Year. Different employees have different Benefit Year start dates because they were hired on different dates.",
          es: "El seguimiento de asistencia, los saldos de licencia y los umbrales disciplinarios se restablecen anualmente en el Aniversario Laboral (fecha de contratación) del empleado. Este periodo de doce meses es su Año de Beneficios. Distintos empleados tienen fechas de inicio de Año de Beneficios diferentes porque fueron contratados en fechas distintas.",
        },
      },

      { type: "h", text: { en: "Grace Period (20 Minutes)", es: "Periodo de Gracia (20 Minutos)" } },
      {
        type: "p",
        text: {
          en: "You have a 20-minute grace window after your scheduled clock-in time. Arrival within the window is permitted. Always call the office BEFORE the 20-minute mark if you will be late, even within the grace window. Beyond 20 minutes, the visit is recorded as TARDY. Communication closes the gap. Silence triggers the dispatch board's late chip.",
          es: "Tiene una ventana de gracia de 20 minutos después de su hora programada para registrar entrada. Se permite la llegada dentro de la ventana. Siempre llame a la oficina ANTES del minuto 20 si llegará tarde, incluso dentro de la ventana de gracia. Más allá de 20 minutos, la visita se registra como TARDANZA. La comunicación cierra la brecha. El silencio activa el indicador de retraso en el tablero de despacho.",
        },
      },

      { type: "h", text: { en: "Tardiness Scale (Per Benefit Year)", es: "Escala de Tardanzas (Por Año de Beneficios)" } },
      {
        type: "table",
        head: { en: ["Occurrence", "Action"], es: ["Ocurrencia", "Acción"] },
        rows: [
          { en: ["1st", "Recorded. Coaching conversation."], es: ["1ª", "Registrada. Conversación de orientación."] },
          { en: ["2nd", "Recorded. Coaching conversation."], es: ["2ª", "Registrada. Conversación de orientación."] },
          { en: ["3rd", "Written warning."], es: ["3ª", "Advertencia por escrito."] },
          { en: ["4th", "Final warning."], es: ["4ª", "Advertencia final."] },
          { en: ["5th", "Termination."], es: ["5ª", "Terminación."] },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Tardies or absences related to legally protected leave or approved reasonable accommodation do NOT count toward disciplinary thresholds. See Section 4 for the full list of protected categories.",
          es: "Las tardanzas o ausencias relacionadas con licencia legalmente protegida o acomodación razonable aprobada NO cuentan hacia los umbrales disciplinarios. Vea la Sección 4 para la lista completa de categorías protegidas.",
        },
      },

      { type: "h", text: { en: "Unexcused Absence. Definition", es: "Ausencia Injustificada. Definición" } },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "An absence is unexcused ONLY when (a) it is a no-call / no-show, OR (b) all three leave buckets are exhausted AND no advance approval for unpaid time AND not protected by law. As long as you have a leave bucket available and give the right notice, the absence is excused and does NOT count toward the discipline scale.",
          es: "Una ausencia es injustificada SOLO cuando (a) es un no llamó / no se presentó, O (b) las tres cubetas de licencia están agotadas Y no hay aprobación previa para tiempo no pagado Y no está protegida por la ley. Mientras tenga una cubeta de licencia disponible y dé el aviso correcto, la ausencia es justificada y NO cuenta hacia la escala de disciplina.",
        },
      },

      { type: "h", text: { en: "Unexcused Absence Scale (Per Benefit Year)", es: "Escala de Ausencia Injustificada (Por Año de Beneficios)" } },
      {
        type: "table",
        head: { en: ["Occurrence", "Action"], es: ["Ocurrencia", "Acción"] },
        rows: [
          { en: ["1st", "Recorded."], es: ["1ª", "Registrada."] },
          { en: ["2nd", "Recorded."], es: ["2ª", "Registrada."] },
          { en: ["3rd", "Written warning."], es: ["3ª", "Advertencia por escrito."] },
          { en: ["4th", "Final warning."], es: ["4ª", "Advertencia final."] },
          { en: ["5th", "Termination."], es: ["5ª", "Terminación."] },
        ],
      },

      { type: "h", text: { en: "Job Abandonment", es: "Abandono del Empleo" } },
      {
        type: "p",
        text: {
          en: "Failure to contact the office BEFORE the end of the 20-minute grace window on a scheduled shift, AND failure to make contact within 24 hours after the missed shift, constitutes JOB ABANDONMENT and results in immediate termination effective the date of the missed shift. The 24-hour post-shift contact window provides the employee an opportunity to explain genuine incapacity (medical emergency, accident, hospitalization). Documentation of genuine incapacity may result in reinstatement at office discretion.",
          es: "No contactar a la oficina ANTES del fin de la ventana de gracia de 20 minutos en un turno programado, Y no establecer contacto dentro de las 24 horas posteriores al turno perdido, constituye ABANDONO DEL EMPLEO y resulta en terminación inmediata efectiva en la fecha del turno perdido. La ventana de contacto de 24 horas después del turno brinda al empleado una oportunidad de explicar una incapacidad genuina (emergencia médica, accidente, hospitalización). La documentación de una incapacidad genuina puede resultar en reincorporación a discreción de la oficina.",
        },
      },

      // ═══════════════════════════════════════════════════════════════════════
      // SECTION 4 — LEAVE POLICIES (Three Buckets)
      // ═══════════════════════════════════════════════════════════════════════
      { type: "h", text: { en: "SECTION 4. Leave Policies", es: "SECCIÓN 4. Políticas de Licencia" } },

      { type: "h", text: { en: "The Three Leave Buckets and Order of Use", es: "Las Tres Cubetas de Licencia y el Orden de Uso" } },
      {
        type: "p",
        text: {
          en: "Phes uses three leave buckets to cover absences. They are used IN ORDER. As long as a bucket is available and you give the right notice, the absence is excused and does NOT count toward the discipline scale.",
          es: "Phes utiliza tres cubetas de licencia para cubrir ausencias. Se usan EN ORDEN. Mientras una cubeta esté disponible y dé el aviso correcto, la ausencia es justificada y NO cuenta hacia la escala de disciplina.",
        },
      },
      {
        type: "table",
        head: {
          en: ["#", "Bucket", "Hours", "Eligible", "Notice", "Can be denied?", "Paid out?"],
          es: ["#", "Cubeta", "Horas", "Elegible", "Aviso", "¿Puede negarse?", "¿Se paga al salir?"],
        },
        rows: [
          { en: ["1", "Any Reason Leave (PLAWA)", "40 / year", "After 90 days", "Grace call only", "No. Protected.", "No"],
            es: ["1", "Licencia por Cualquier Razón (PLAWA)", "40 / año", "Después de 90 días", "Solo llamada de gracia", "No. Protegida.", "No"] },
          { en: ["2", "PTO", "40 to 80 / year", "After 1 year", "7 days advance", "Yes. Business needs.", "Yes"],
            es: ["2", "PTO", "40 a 80 / año", "Después de 1 año", "7 días anticipados", "Sí. Necesidades del negocio.", "Sí"] },
          { en: ["3", "Unpaid Personal Leave", "40 / year (5 days)", "Day one", "7 days advance", "Yes. Business needs.", "No"],
            es: ["3", "Licencia Personal No Pagada", "40 / año (5 días)", "Primer día", "7 días anticipados", "Sí. Necesidades del negocio.", "No"] },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Order of use: PLAWA → PTO → Unpaid Personal Leave → discipline scale (only if all three are exhausted and the absence is not otherwise protected).",
          es: "Orden de uso: PLAWA → PTO → Licencia Personal No Pagada → escala de disciplina (solo si las tres están agotadas y la ausencia no está protegida de otra forma).",
        },
      },

      { type: "h", text: { en: "Any Reason Leave (PLAWA)", es: "Licencia por Cualquier Razón (PLAWA)" } },
      {
        type: "bullets",
        items: [
          { en: "40 paid hours per Benefit Year, front-loaded after 90 days of employment.", es: "40 horas pagadas por Año de Beneficios, otorgadas por adelantado después de 90 días de empleo." },
          { en: "Use it for ANY reason. Examples: your illness, family illness, mental health day, medical appointment, flat tire, or no reason given. The law does not require you to explain.", es: "Úsela por CUALQUIER razón. Ejemplos: su enfermedad, enfermedad familiar, día de salud mental, cita médica, llanta ponchada o sin razón dada. La ley no exige que explique." },
          { en: "Phes NEVER requires documentation, regardless of absence length. This is Phes's policy choice and is stricter than what the law requires.", es: "Phes NUNCA exige documentación, sin importar la duración de la ausencia. Esta es la política de Phes y es más estricta que lo que exige la ley." },
          { en: "Notice: the 20-minute grace call only. No advance approval required.", es: "Aviso: solo la llamada de gracia de 20 minutos. No se requiere aprobación previa." },
          { en: "Cannot be denied for business needs. PLAWA is protected leave.", es: "No se puede negar por necesidades del negocio. PLAWA es licencia protegida." },
          { en: "PLAWA is AUTOMATIC when you have hours and give the grace call. You do not need to specifically request 'sick time' or give a reason. PLAWA covers you by default.", es: "PLAWA es AUTOMÁTICA cuando tiene horas y da la llamada de gracia. No necesita solicitar específicamente 'tiempo por enfermedad' ni dar una razón. PLAWA lo cubre por defecto." },
          { en: "4 or more CONSECUTIVE PLAWA days requires advance approval if the absence is foreseeable.", es: "4 o más días consecutivos de PLAWA requieren aprobación previa si la ausencia es previsible." },
          { en: "If you run out of PLAWA: the office cascades to PTO (if eligible), then Unpaid Personal Leave (if approved in advance).", es: "Si se queda sin PLAWA: la oficina pasa a PTO (si es elegible), luego a Licencia Personal No Pagada (si se aprueba con anticipación)." },
          { en: "No retaliation for lawful PLAWA use. Phes cannot discipline, demote, fire, or penalize you for using PLAWA legally.", es: "Sin represalias por el uso legal de PLAWA. Phes no puede disciplinar, degradar, despedir ni penalizar por usar PLAWA legalmente." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Cook County Notice. Employees working in Cook County may be covered by the Cook County Paid Leave Ordinance in addition to or in place of the Illinois Paid Leave for All Workers Act. The benefits provided by Phes meet or exceed the requirements of both laws. If you have questions about your paid leave rights under the Cook County ordinance, you may contact the Cook County Commission on Human Rights at 312-603-1100.",
          es: "Aviso del Condado de Cook. Los empleados que trabajan en el Condado de Cook pueden estar cubiertos por la Ordenanza de Licencia Pagada del Condado de Cook además o en lugar de la Ley de Licencia Pagada para Todos los Trabajadores de Illinois. Los beneficios que provee Phes cumplen o exceden los requisitos de ambas leyes. Si tiene preguntas sobre sus derechos de licencia pagada bajo la ordenanza del Condado de Cook, puede contactar a la Comisión de Derechos Humanos del Condado de Cook al 312-603-1100.",
        },
      },

      { type: "h", text: { en: "Paid Time Off (PTO)", es: "Tiempo Libre Pagado (PTO)" } },
      {
        type: "bullets",
        items: [
          { en: "40 hours after 1 year. Tops up to 80 hours at 2-year anniversary.", es: "40 horas después de 1 año. Se rellena hasta 80 horas en el aniversario de 2 años." },
          { en: "Hard cap: 80 hours total. Unused PTO does NOT stack. We top up to the cap, we do not add on top.", es: "Tope estricto: 80 horas en total. El PTO no usado NO se acumula. Rellenamos hasta el tope, no agregamos encima." },
          { en: "7 days advance notice is required.", es: "Se requieren 7 días de aviso anticipado." },
          { en: "Subject to first-come-first-serve. Maximum 2 cleaners off per day. Business needs can override the cap.", es: "Sujeto a primero en llegar, primero en ser atendido. Máximo 2 cleaners libres por día. Las necesidades del negocio pueden anular el tope." },
          { en: "PTO IS paid out at separation per the Illinois Wage Payment and Collection Act.", es: "El PTO SÍ se paga al separarse conforme a la Ley de Pago y Cobranza de Salarios de Illinois." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Example: in your first PTO year you used only 20 of your 40 hours. At your 2-year anniversary, the office tops your bank up to 80 hours. The bank is NOT 20 carried over plus 80 = 100. The maximum balance is always 80.",
          es: "Ejemplo: en su primer año de PTO usó solo 20 de sus 40 horas. En su aniversario de 2 años, la oficina rellena su banco hasta 80 horas. El banco NO es 20 acumuladas más 80 = 100. El balance máximo siempre es 80.",
        },
      },

      { type: "h", text: { en: "Unpaid Personal Leave", es: "Licencia Personal No Pagada" } },
      {
        type: "bullets",
        items: [
          { en: "40 hours / 5 days of unpaid time off, available day one.", es: "40 horas / 5 días de tiempo libre no pagado, disponible desde el primer día." },
          { en: "7 days advance notice required.", es: "Se requieren 7 días de aviso anticipado." },
          { en: "Same approval rules as PTO: first-come-first-serve, max 2 off per day, business needs can override.", es: "Mismas reglas de aprobación que el PTO: primero en llegar, máximo 2 libres por día, las necesidades del negocio pueden anular." },
          { en: "Does NOT carry over to the next year. Not paid out at separation.", es: "NO se acumula al siguiente año. No se paga al separarse." },
          { en: "Used for PLANNED absences only (kid's school event, out-of-town wedding, etc.). Not for same-day call-offs.", es: "Se usa solo para ausencias PLANEADAS (evento escolar de un hijo, boda fuera de la ciudad, etc.). No para faltas el mismo día." },
        ],
      },

      { type: "h", text: { en: "Protected Absences (Never Counted as Unexcused)", es: "Ausencias Protegidas (Nunca Se Cuentan Como Injustificadas)" } },
      {
        type: "p",
        text: {
          en: "Certain absences are protected by law and are NEVER counted as unexcused, regardless of tenure or available leave hours. This applies even during your first 90 days. Protected categories include:",
          es: "Ciertas ausencias están protegidas por la ley y NUNCA se cuentan como injustificadas, sin importar el tiempo de empleo o las horas de licencia disponibles. Esto aplica incluso durante los primeros 90 días. Las categorías protegidas incluyen:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Jury duty (with proper notice and a copy of the summons).", es: "Servicio de jurado (con aviso apropiado y copia de la citación)." },
          { en: "Voting time on Election Day (up to 2 hours, advance notice required).", es: "Tiempo para votar el Día de Elecciones (hasta 2 horas, se requiere aviso anticipado)." },
          { en: "Workplace injury / workers' compensation absences.", es: "Ausencias por lesión laboral o compensación al trabajador." },
          { en: "Pregnancy-related medical needs or appointments.", es: "Necesidades o citas médicas relacionadas con el embarazo." },
          { en: "Lactation breaks.", es: "Pausas de lactancia." },
          { en: "Bereavement (immediate family: spouse, child, parent, sibling).", es: "Duelo (familia inmediata: cónyuge, hijo/a, padre/madre, hermano/a)." },
          { en: "Military leave and family military leave.", es: "Licencia militar y licencia militar familiar." },
          { en: "Court appearances as a crime victim, or for proceedings related to domestic violence, sexual violence, or other qualifying crimes (VESSA).", es: "Comparecencias judiciales como víctima de delito, o para procedimientos relacionados con violencia doméstica, violencia sexual u otros delitos calificantes (VESSA)." },
          { en: "Disability-related absences covered by reasonable accommodation.", es: "Ausencias relacionadas con discapacidad cubiertas por acomodación razonable." },
          { en: "Organ or bone marrow donation.", es: "Donación de órganos o médula ósea." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "When calling off, tell the office if the absence is related to any protected category so it can be handled properly. The office will NOT ask for medical details, only the category.",
          es: "Al avisar que no irá a trabajar, dígale a la oficina si la ausencia se relaciona con alguna categoría protegida para que se maneje apropiadamente. La oficina NO pedirá detalles médicos, solo la categoría.",
        },
      },

      { type: "h", text: { en: "Bereavement Leave", es: "Licencia por Duelo" } },
      {
        type: "p",
        text: {
          en: "Up to 3 paid scheduled workdays for an immediate family member's death (spouse, child, parent, sibling). Notify the office as soon as practicable. Extended family is handled case-by-case as unpaid time off; ask the office.",
          es: "Hasta 3 días laborales programados pagados por la muerte de un familiar inmediato (cónyuge, hijo/a, padre/madre, hermano/a). Notifique a la oficina lo antes posible. Los familiares extendidos se manejan caso por caso como tiempo libre no pagado; consulte con la oficina.",
        },
      },

      { type: "h", text: { en: "Jury Duty", es: "Servicio de Jurado" } },
      {
        type: "p",
        text: {
          en: "Jury service is unpaid by Phes. Your job is protected. You keep any juror compensation the court provides. Bring your summons or proof of service to the office before the date and notify your dispatcher.",
          es: "El servicio de jurado no es pagado por Phes. Su empleo está protegido. Usted se queda con la compensación del tribunal. Lleve su citación o comprobante a la oficina antes de la fecha y notifique al despachador.",
        },
      },

      { type: "h", text: { en: "Lactation Breaks", es: "Pausas de Lactancia" } },
      {
        type: "p",
        text: {
          en: "Reasonable lactation breaks are PAID at your regular rate and do NOT deduct from PLAWA or PTO. The office will work with you on timing and a private location at the office or between jobs. This is mandatory under Illinois law and Phes policy.",
          es: "Las pausas de lactancia razonables se PAGAN a su tarifa regular y NO se descuentan de PLAWA ni PTO. La oficina coordinará con usted el horario y un lugar privado en la oficina o entre trabajos. Esto es obligatorio bajo la ley de Illinois y la política de Phes.",
        },
      },

      { type: "h", text: { en: "Pregnancy Accommodation", es: "Acomodación por Embarazo" } },
      {
        type: "p",
        text: {
          en: "Illinois requires Phes to provide reasonable accommodations during pregnancy. Examples: lighter duties, more frequent breaks, adjusted lifting limits, modified schedule, or temporary reassignment. Ask the office. Phes will work out an accommodation that keeps you safely working as long as you choose to.",
          es: "Illinois requiere que Phes brinde acomodaciones razonables durante el embarazo. Ejemplos: tareas más ligeras, pausas más frecuentes, límites de levantamiento ajustados, horario modificado o reasignación temporal. Pídalo a la oficina. Phes acordará una acomodación que la mantenga trabajando con seguridad mientras usted lo elija.",
        },
      },

      { type: "h", text: { en: "VESSA Protections", es: "Protecciones VESSA" } },
      {
        type: "p",
        text: {
          en: "Employees affected by domestic or sexual violence may use employer-issued devices to document incidents. Phes will not retaliate and will provide access to such records upon request.",
          es: "Los empleados afectados por violencia doméstica o sexual pueden usar dispositivos provistos por el empleador para documentar incidentes. Phes no tomará represalias y proveerá acceso a tales registros cuando se soliciten.",
        },
      },

      { type: "h", text: { en: "Paid Holidays", es: "Feriados Pagados" } },
      {
        type: "p",
        text: {
          en: "Phes observes six (6) paid holidays per calendar year: New Year's Day, Memorial Day, Independence Day (July 4), Labor Day, Thanksgiving Day, Christmas Day.",
          es: "Phes observa seis (6) feriados pagados por año calendario: Año Nuevo, Memorial Day, Día de la Independencia (4 de julio), Día del Trabajo, Día de Acción de Gracias, Navidad.",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Eligibility: holiday pay starts AFTER 90 days of employment. Any holiday in the first 90 days is unpaid for that employee, even if it is an observed Phes holiday.", es: "Elegibilidad: el pago por feriado comienza DESPUÉS de 90 días de empleo. Cualquier feriado en los primeros 90 días no se paga, incluso si es un feriado observado por Phes." },
          { en: "Paid holidays are compensated at 8 hours at the employee's regular rate, unless otherwise required by law.", es: "Los feriados pagados se compensan a 8 horas a la tarifa regular del empleado, a menos que la ley exija otra cosa." },
        ],
      },

      { type: "h", text: { en: "Birthday Pay (Employee Choice)", es: "Pago de Cumpleaños (Elección del Empleado)" } },
      {
        type: "bullets",
        items: [
          { en: "8 hours of regular pay per Benefit Year.", es: "8 horas de pago regular por Año de Beneficios." },
          { en: "Eligibility: after 90 days of employment.", es: "Elegibilidad: después de 90 días de empleo." },
          { en: "EMPLOYEE'S CHOICE: (a) take the day off in your birth month with 8 hours of pay, OR (b) work and receive 8 hours of additional pay on top of regular earnings for that day.", es: "ELECCIÓN DEL EMPLEADO: (a) tome el día libre en su mes de cumpleaños con 8 horas de pago, O (b) trabaje y reciba 8 horas de pago adicional sobre las ganancias regulares de ese día." },
          { en: "Must be requested 7 days in advance through the two-step process.", es: "Debe solicitarse con 7 días de anticipación a través del proceso de dos pasos." },
          { en: "Subject to office approval: first-come-first-serve, max 2 off per day, business needs can override.", es: "Sujeto a aprobación de la oficina: primero en llegar, máximo 2 libres por día, las necesidades del negocio pueden anular." },
          { en: "Cannot be combined with PTO to extend vacations beyond standard approval limits.", es: "No se puede combinar con PTO para extender vacaciones más allá de los límites estándar de aprobación." },
          { en: "Does NOT carry over. Forfeited if not used in your birth month.", es: "NO se acumula. Se pierde si no se usa en su mes de cumpleaños." },
          { en: "NOT paid out at separation.", es: "NO se paga al separarse." },
          { en: "Employees on active written warning, final warning, or Quality Probation may have their birthday request denied at office discretion.", es: "Empleados con advertencia activa por escrito, advertencia final o Probatoria de Calidad pueden ver su solicitud de cumpleaños rechazada a discreción de la oficina." },
        ],
      },

      { type: "h", text: { en: "Two-Step Time-Off Request Process", es: "Proceso de Solicitud de Tiempo Libre de Dos Pasos" } },
      {
        type: "p",
        text: {
          en: "Every time-off request (PTO, sick day, birthday, schedule change) requires BOTH steps:",
          es: "Cada solicitud de tiempo libre (PTO, día por enfermedad, cumpleaños, cambio de horario) requiere AMBOS pasos:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "STEP 1. Submit through MaidCentral / Qleno. This is what dispatch sees and what triggers client notifications.", es: "PASO 1. Envíe por MaidCentral / Qleno. Esto es lo que ve el despacho y lo que activa las notificaciones al cliente." },
          { en: "STEP 2. Contact the office team directly (text or call) to confirm receipt. Either step alone is not enough.", es: "PASO 2. Contacte directamente al equipo de la oficina (mensaje o llamada) para confirmar la recepción. Un paso solo no es suficiente." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "If you only contact the office without submitting in the system, dispatch will not see it and the client will not be notified. If you only submit in the system without contacting the office, the office may not see it in time. Both are required, every time.",
          es: "Si solo contacta a la oficina sin enviar en el sistema, despacho no lo verá y el cliente no será notificado. Si solo envía en el sistema sin contactar a la oficina, la oficina puede no verlo a tiempo. Ambos son requeridos, cada vez.",
        },
      },

      // ═══════════════════════════════════════════════════════════════════════
      // SECTION 5 — PROFESSIONAL APPEARANCE & CONDUCT
      // ═══════════════════════════════════════════════════════════════════════
      { type: "h", text: { en: "SECTION 5. Professional Appearance and Conduct", es: "SECCIÓN 5. Apariencia Profesional y Conducta" } },

      { type: "h", text: { en: "Mandatory Dress Code", es: "Código de Vestimenta Obligatorio" } },
      {
        type: "bullets",
        items: [
          { en: "Phes-issued shirt or hoodie, clean, no visible stains. Untucked is acceptable.", es: "Camisa o sudadera de Phes, limpia, sin manchas visibles. Por fuera es aceptable." },
          { en: "Phes-issued pants in good condition. Navy, black, or dark denim if no Phes pants. No shorts. No leggings as outerwear.", es: "Pantalones Phes en buen estado. Azul marino, negro o mezclilla oscura si no hay pantalones Phes. Sin shorts. Sin leggings como ropa exterior." },
          { en: "Closed-toe athletic shoes (solid black or solid white). No sandals. No Crocs. No open backs.", es: "Calzado deportivo cerrado (negro sólido o blanco sólido). Sin sandalias. Sin Crocs. Sin parte trasera abierta." },
          { en: "Shoe covers mandatory inside all client homes from the threshold. Change between homes. Never reuse.", es: "Cubrezapatos obligatorios dentro de todos los hogares de clientes desde el umbral. Cambielos entre hogares. Nunca los reutilice." },
          { en: "Hair tied back if shoulder-length or longer.", es: "Cabello recogido si llega al hombro o más largo." },
          { en: "Jewelry minimal. No large rings or bracelets that scratch surfaces.", es: "Joyería mínima. Sin anillos ni pulseras grandes que rayen superficies." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Religious or medical accommodation: if you require an accommodation to any uniform requirement for religious or medical reasons, contact the office and we will work with you on an appropriate adjustment.",
          es: "Acomodación religiosa o médica: si requiere una acomodación a cualquier requisito del uniforme por razones religiosas o médicas, contacte a la oficina y trabajaremos con usted en un ajuste apropiado.",
        },
      },

      { type: "h", text: { en: "Personal Phone Use", es: "Uso de Teléfono Personal" } },
      {
        type: "bullets",
        items: [
          { en: "Personal cell phones kept in your bag or vehicle during a job.", es: "Los teléfonos personales se mantienen en su bolso o vehículo durante un trabajo." },
          { en: "Phone use during a job is permitted ONLY for the company app (clock-in, check-in, job worksheet) or genuine emergencies.", es: "El uso del teléfono durante un trabajo se permite SOLO para la app de la compañía (Clock In, Check In, hoja de trabajo) o emergencias genuinas." },
          { en: "Personal calls, texts, and social media wait until break or after the visit.", es: "Llamadas personales, mensajes y redes sociales esperan hasta el descanso o después de la visita." },
          { en: "To take any non-emergency call, exit the home entirely and notify your teammate.", es: "Para tomar cualquier llamada que no sea emergencia, salga completamente del hogar y notifique a su compañero de equipo." },
          { en: "Photos and videos of client homes are forbidden, except through the company app for documenting work or damage.", es: "Las fotos y videos de los hogares de los clientes están prohibidos, excepto a través de la app de la compañía para documentar trabajo o daños." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Nothing in this policy restricts your rights under federal labor law to discuss wages, hours, or working conditions with coworkers or others.",
          es: "Nada en esta política restringe sus derechos bajo la ley laboral federal a discutir salarios, horas o condiciones de trabajo con compañeros u otras personas.",
        },
      },

      // ═══════════════════════════════════════════════════════════════════════
      // SECTION 6 — OPERATIONAL PROTOCOLS
      // ═══════════════════════════════════════════════════════════════════════
      { type: "h", text: { en: "SECTION 6. Operational Protocols", es: "SECCIÓN 6. Protocolos Operativos" } },

      { type: "h", text: { en: "Off-Scope Client Requests", es: "Solicitudes de Clientes Fuera del Alcance" } },
      {
        type: "p",
        text: {
          en: "When a client asks for something not on the job ticket (and not on the 'Phes does NOT do' list), follow this flow:",
          es: "Cuando un cliente solicita algo que no está en el ticket de trabajo (y no en la lista de 'lo que Phes NO hace'), siga este flujo:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Politely tell the client: 'Thank you for asking. That is not part of today's service, but let me call the office and they can let you know if we can add it. They will also handle any additional charges.'", es: "Dígale cortésmente al cliente: 'Gracias por preguntar. Eso no es parte del servicio de hoy, pero déjeme llamar a la oficina y ellos le pueden decir si lo podemos agregar. Ellos también manejarán cualquier cargo adicional.'" },
          { en: "Step outside or to a private area. Call the office.", es: "Salga afuera o a un área privada. Llame a la oficina." },
          { en: "The office decides: approve (with pricing) or decline.", es: "La oficina decide: aprobar (con precio) o rechazar." },
          { en: "The office adds a note to the app.", es: "La oficina agrega una nota a la app." },
          { en: "Tech proceeds based on the office's decision.", es: "El técnico procede según la decisión de la oficina." },
          { en: "NEVER agree, quote pricing, or accept cash without office approval.", es: "NUNCA acepte, cotice precio, ni reciba efectivo sin aprobación de la oficina." },
        ],
      },

      { type: "h", text: { en: "What Phes Does NOT Do", es: "Lo Que Phes NO Hace" } },
      {
        type: "bullets",
        items: [
          { en: "Bodily fluids (blood, vomit, urine, feces). Decline politely. The office can refer a biohazard service.", es: "Fluidos corporales (sangre, vómito, orina, heces). Rechácelo cortésmente. La oficina puede referir un servicio de biohazard." },
          { en: "Inside the oven, refrigerator, or freezer (default scope). The office can add it; call.", es: "Dentro del horno, refrigerador o congelador (alcance estándar). La oficina lo puede agregar; llame." },
          { en: "Pet waste, including litter boxes.", es: "Desechos de mascotas, incluyendo cajas de arena." },
          { en: "Cash transactions on site. All payment goes through the office.", es: "Transacciones en efectivo en sitio. Todo pago pasa por la oficina." },
          { en: "Climbing higher than the company-issued step stool. Never stand on furniture.", es: "Subir más alto que el banquito de la compañía. Nunca se pare en muebles." },
          { en: "Wash dishes.", es: "Lavar platos." },
          { en: "Make beds.", es: "Tender camas." },
          { en: "Move heavy furniture. We clean around it. Anything over 25 lbs we do not lift or relocate.", es: "Mover muebles pesados. Limpiamos alrededor. Nada que pese más de 25 lb se levanta o se mueve." },
          { en: "Clean window tracks.", es: "Limpiar rieles de ventanas." },
          { en: "Carpet steam cleaning.", es: "Limpieza de alfombras a vapor." },
          { en: "Biohazards, animal waste, hoarding situations, or infestations.", es: "Riesgos biológicos, desechos animales, situaciones de acumulación o infestaciones." },
          { en: "Outdoor cleaning, fireplaces, running errands.", es: "Limpieza al aire libre, chimeneas, recados." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "The office may grant exceptions. If an exception note exists in the app, follow it. If a client requests something on the list and NO note exists, decline politely and tell the client you will let the office know.",
          es: "La oficina puede otorgar excepciones. Si existe una nota de excepción en la app, sígala. Si un cliente solicita algo en la lista y NO existe una nota, rechácelo cortésmente y dígale al cliente que avisará a la oficina.",
        },
      },

      { type: "h", text: { en: "Scope of Service. Standard Clean (Included Every Visit)", es: "Alcance del Servicio. Limpieza Estándar (Incluida en Cada Visita)" } },
      {
        type: "bullets",
        items: [
          { en: "Kitchen: cobwebs, countertops and backsplash sanitized, cabinet exteriors wiped, microwave inside and out, stovetop and control panel and drip pans, refrigerator exterior (top and sides if accessible), sinks and faucets, trash emptied (client provides bag), floors vacuum / sweep / mop.", es: "Cocina: telarañas, mostradores y backsplash desinfectados, exteriores de gabinetes, microondas dentro y fuera, estufa y panel y bandejas, exterior del refrigerador, fregaderos y grifos, basura (cliente provee bolsa), pisos." },
          { en: "Bathrooms: cobwebs, tub / shower / doors / toilet disinfected (inside and out), countertops and cabinet exteriors and sinks and faucets, mirrors and light fixtures, window sills and towel bars dusted, trash and liner, floors.", es: "Baños: telarañas, tina / ducha / puertas / inodoro desinfectados (dentro y fuera), mostradores y gabinetes exteriores y fregaderos y grifos, espejos y luces, alféizares y toalleros, basura y bolsa, pisos." },
          { en: "Bedrooms: cobwebs, dust furniture / lamps / window sills / picture frames, mirrors and glass, vacuum and mop floors.", es: "Dormitorios: telarañas, polvo en muebles / lámparas / alféizares / cuadros, espejos y vidrios, aspirar y trapear pisos." },
          { en: "Living / Family Room: cobwebs, dust furniture / lamps / window sills / picture frames, dust upholstery, mirrors and glass, trash and liner, floors.", es: "Sala / Familia: telarañas, polvo en muebles / lámparas / alféizares / cuadros, polvo en tapicería, espejos y vidrios, basura y bolsa, pisos." },
          { en: "Laundry Room: cobwebs, wipe washer and dryer exterior, utility sink and countertops, dust and wipe shelves, sweep and mop.", es: "Cuarto de Lavado: telarañas, exterior de lavadora y secadora, fregadero y mostradores, polvo en estantes, barrer y trapear." },
        ],
      },

      { type: "h", text: { en: "Deep Clean and Move-In / Move-Out. What's ADDED", es: "Limpieza Profunda y Mudanza. Lo Que Se AGREGA" } },
      {
        type: "p",
        text: {
          en: "A Deep Clean (or Move-In / Move-Out) includes EVERYTHING in the Standard Clean PLUS five extras. These five extras are what makes it a Deep Clean. It is not just 'cleaning harder.'",
          es: "Una Limpieza Profunda (o Mudanza) incluye TODO lo de la Limpieza Estándar MÁS cinco extras. Estos cinco extras son lo que la hace Profunda. No es solo 'limpiar más fuerte.'",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Baseboards in all rooms (where accessible).", es: "Zócalos en todas las habitaciones (donde sea accesible)." },
          { en: "Ceiling fans dusted and cleaned.", es: "Ventiladores de techo desempolvados y limpios." },
          { en: "Doorknobs, door frames, light switches, and handles wiped and sanitized.", es: "Pomos, marcos de puertas, interruptores y manijas limpios y desinfectados." },
          { en: "Storm doors and sliding patio doors. Inside AND outside glass.", es: "Puertas tormenta y puertas corredizas. Vidrio INTERIOR y EXTERIOR." },
          { en: "Air vent covers dusted and cleaned.", es: "Tapas de ventilación desempolvadas y limpias." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Move-In / Move-Out cleans ASSUME the space is empty. If you arrive and the home is still furnished or has belongings throughout, call the office BEFORE starting. The scope and pricing change when there is furniture in the way.",
          es: "Las limpiezas de Mudanza ASUMEN que el espacio está vacío. Si llega y la casa aún tiene muebles o pertenencias por todas partes, llame a la oficina ANTES de empezar. El alcance y el precio cambian cuando hay muebles en medio.",
        },
      },

      { type: "h", text: { en: "Add-Ons. NOT Included in Deep Clean (Priced Separately)", es: "Add-Ons. NO Incluidos en Limpieza Profunda (Cobro por Separado)" } },
      {
        type: "bullets",
        items: [
          { en: "Inside Refrigerator: $50.", es: "Dentro del Refrigerador: $50." },
          { en: "Inside Oven: $50.", es: "Dentro del Horno: $50." },
          { en: "Inside Kitchen Cabinets (client must empty them first): $50.", es: "Dentro de Gabinetes de Cocina (el cliente debe vaciarlos primero): $50." },
          { en: "Inside Windows: price varies. EXCLUDES tracks and exterior panes.", es: "Ventanas Interiores: el precio varía. EXCLUYE rieles y vidrios exteriores." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "If a client asks for an add-on mid-clean, call the office to confirm the price was charged, then accommodate. NEVER quote pricing yourself and NEVER accept cash on site. Those go through the office.",
          es: "Si un cliente pide un add-on a mitad de la limpieza, llame a la oficina para confirmar que el precio fue cobrado, luego acomódelo. NUNCA cotice precio usted mismo y NUNCA acepte efectivo en sitio. Eso va por la oficina.",
        },
      },

      { type: "h", text: { en: "On-Site Rules", es: "Reglas en Sitio" } },
      {
        type: "bullets",
        items: [
          { en: "Ladders / step stools: never climb higher than a 2-step. Anything above that, leave a note and skip. Do not improvise on chairs, counters, or furniture.", es: "Escaleras / banquitos: nunca suba más alto que 2 escalones. Cualquier cosa más alta, deje nota y omita. No improvise sobre sillas, mostradores ni muebles." },
          { en: "Trash: 5 bag maximum per visit. If there is more, document and tell the office. We do not haul extra.", es: "Basura: máximo 5 bolsas por visita. Si hay más, documente y avise a la oficina. No llevamos más." },
          { en: "Arrival window: clients are told to expect a 45-minute arrival window due to traffic. If you will be at the late end, the office calls or texts the client. YOU also call the office BEFORE the 20-minute mark when running behind.", es: "Ventana de llegada: a los clientes se les dice que esperen una ventana de llegada de 45 minutos por el tráfico. Si llegará al final tarde, la oficina llama o envía mensaje al cliente. USTED también llama a la oficina ANTES del minuto 20 cuando esté retrasado." },
          { en: "Lockbox / alarm code: some clients have a lockbox ($50 add-on) or alarm code. The office tells you in the app notes. Never share codes with anyone. Never write them down outside the app.", es: "Caja de seguridad / código de alarma: algunos clientes tienen caja ($50 add-on) o código de alarma. La oficina le dice en las notas de la app. Nunca comparta los códigos. Nunca los escriba fuera de la app." },
          { en: "Decluttering: if surfaces are too cluttered to clean and the client was not notified ahead, call the office. We can decline (with cancellation fee applying) or shift scope. Never silently work around chaos.", es: "Desorden: si las superficies están demasiado desordenadas para limpiar y el cliente no fue avisado, llame a la oficina. Podemos rechazar (con cargo de cancelación aplicado) o cambiar el alcance. Nunca trabaje silenciosamente alrededor del caos." },
        ],
      },

      { type: "h", text: { en: "Never Discuss Price With the Client", es: "Nunca Discuta el Precio Con el Cliente" } },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Pricing conversations are 100% the office's job. If a client tries to negotiate, asks for a discount, offers cash for an unscheduled service, or tries to renegotiate the service fee in front of you, politely say 'I will have the office reach out to discuss pricing' and call the office. Clients who try to negotiate outside pricing with techs risk losing service. Protect yourself: stay out of money conversations.",
          es: "Las conversaciones sobre precios son 100% trabajo de la oficina. Si un cliente intenta negociar, pide descuento, ofrece efectivo por un servicio no agendado o intenta renegociar la tarifa frente a usted, diga cortésmente 'la oficina los contactará para discutir el precio' y llame a la oficina. Los clientes que intentan negociar fuera del precio con los técnicos arriesgan perder el servicio. Protéjase: manténgase fuera de conversaciones de dinero.",
        },
      },

      { type: "h", text: { en: "Property Damage Protocol", es: "Protocolo de Daño a la Propiedad" } },
      {
        type: "bullets",
        items: [
          { en: "Stop work in that area immediately.", es: "Detenga el trabajo en esa área inmediatamente." },
          { en: "Take photos from multiple angles, including surrounding context.", es: "Tome fotos desde múltiples ángulos, incluyendo el contexto alrededor." },
          { en: "Do NOT attempt repair.", es: "NO intente repararlo." },
          { en: "Call the office within 5 minutes. Send photos via app or text.", es: "Llame a la oficina dentro de 5 minutos. Envíe las fotos por la app o mensaje." },
          { en: "The office handles all communication with the client.", es: "La oficina maneja toda la comunicación con el cliente." },
          { en: "Continue the job unless the office instructs otherwise.", es: "Continúe el trabajo a menos que la oficina indique lo contrario." },
          { en: "Do NOT discuss compensation, repair, or blame with the client.", es: "NO discuta compensación, reparación ni culpa con el cliente." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Phes general liability insurance covers accidental property damage. Tech follows the protocol. Office handles claims.",
          es: "El seguro de responsabilidad general de Phes cubre el daño accidental a la propiedad. El técnico sigue el protocolo. La oficina maneja las reclamaciones.",
        },
      },

      { type: "h", text: { en: "Client Complaint Mid-Job", es: "Queja del Cliente a Mitad del Trabajo" } },
      {
        type: "bullets",
        items: [
          { en: "Stop and listen fully without interrupting.", es: "Deténgase y escuche completamente sin interrumpir." },
          { en: "Acknowledge: 'I hear you. I want to make this right.'", es: "Reconozca: 'Lo escucho. Quiero que esto se haga bien.'" },
          { en: "For simple issues (missed area, streak, forgotten task): offer to fix immediately.", es: "Para asuntos simples (área omitida, racha, tarea olvidada): ofrezca repararlo inmediatamente." },
          { en: "For larger complaints (upset, threatening cancellation, demanding refund): step outside, call the office. The office takes over.", es: "Para quejas mayores (alterado, amenazando cancelación, exigiendo reembolso): salga afuera, llame a la oficina. La oficina toma el control." },
          { en: "NEVER argue, defend, promise refunds, or walk off without office approval.", es: "NUNCA discuta, defienda, prometa reembolsos ni se vaya sin aprobación de la oficina." },
          { en: "If the client becomes verbally abusive or unsafe: call the office first, then leave. Do NOT confront.", es: "Si el cliente se vuelve verbalmente abusivo o inseguro: llame a la oficina primero, luego salga. NO se enfrente." },
        ],
      },

      { type: "h", text: { en: "Keys, Codes, and Access", es: "Llaves, Códigos y Acceso" } },
      {
        type: "bullets",
        items: [
          { en: "All access information lives in the Phes app job ticket only.", es: "Toda la información de acceso vive solo en el ticket de trabajo de la app Phes." },
          { en: "Never share codes with anyone, including coworkers not assigned.", es: "Nunca comparta códigos con nadie, incluso con compañeros que no están asignados." },
          { en: "Never write codes down, screenshot, or save in personal notes.", es: "Nunca escriba códigos, tome capturas de pantalla ni los guarde en notas personales." },
          { en: "If a code does not work, call the office. Do not attempt forced entry.", es: "Si un código no funciona, llame a la oficina. No intente entrada forzada." },
          { en: "For physical keys: follow the job instructions in the app.", es: "Para llaves físicas: siga las instrucciones del trabajo en la app." },
          { en: "Lost key is serious. Call the office immediately regardless of time.", es: "Una llave perdida es seria. Llame a la oficina inmediatamente sin importar la hora." },
          { en: "Lock the door behind you when entering.", es: "Cierre la puerta detrás de usted al entrar." },
          { en: "Never open the door to anyone (deliveries, neighbors).", es: "Nunca abra la puerta a nadie (entregas, vecinos)." },
          { en: "Verify the door is locked when leaving.", es: "Verifique que la puerta esté cerrada al salir." },
        ],
      },

      { type: "h", text: { en: "Client Not Home", es: "Cliente No Está en Casa" } },
      {
        type: "bullets",
        items: [
          { en: "Wait 20 minutes at the location.", es: "Espere 20 minutos en el lugar." },
          { en: "If no access is set up: knock and wait 5 minutes, then call the office.", es: "Si no hay acceso configurado: toque la puerta y espere 5 minutos, luego llame a la oficina." },
          { en: "Tech proceeds inside if access exists. Take normal completion photos. Lock up.", es: "El técnico procede dentro si existe acceso. Tome fotos normales de finalización. Cierre con llave." },
          { en: "If access fails or is denied: call the office within 5 minutes. Office attempts client contact. Tech waits up to 20 minutes.", es: "Si el acceso falla o se niega: llame a la oficina dentro de 5 minutos. La oficina intenta contactar al cliente. El técnico espera hasta 20 minutos." },
          { en: "If the office cannot reach the client: office decides reschedule or next job.", es: "Si la oficina no logra contactar al cliente: la oficina decide reprogramar o ir al siguiente trabajo." },
          { en: "Tech is paid the 3-hour minimum for arrival.", es: "El técnico recibe el mínimo de 3 horas por la llegada." },
        ],
      },

      { type: "h", text: { en: "Coworker No-Show", es: "Compañero No Se Presenta" } },
      {
        type: "bullets",
        items: [
          { en: "Wait 10 minutes at the location.", es: "Espere 10 minutos en el lugar." },
          { en: "Call the office to confirm the partner's status.", es: "Llame a la oficina para confirmar el estado del compañero." },
          { en: "Call or text the partner directly.", es: "Llame o envíe mensaje al compañero directamente." },
          { en: "The office decides: (a) wait up to 30 minutes for the partner, (b) send a replacement, or (c) convert to solo cleaning.", es: "La oficina decide: (a) esperar hasta 30 minutos al compañero, (b) enviar un reemplazo, o (c) convertir a limpieza individual." },
          { en: "Solo cleaning rules: proceed ONLY with explicit office approval. Paid at the regular commission rate (35% or 32%). Do NOT lift heavy items alone (skip and document). Update the office on estimated completion.", es: "Reglas de limpieza individual: proceda SOLO con aprobación explícita de la oficina. Pago a la tarifa regular de comisión (35% o 32%). NO levante artículos pesados solo (omita y documente). Actualice a la oficina sobre la finalización estimada." },
          { en: "Refusing an approved solo assignment is insubordination.", es: "Negarse a una asignación individual aprobada es insubordinación." },
          { en: "The tech does NOT discuss the partner's status with the client. The office handles client communication.", es: "El técnico NO discute el estado del compañero con el cliente. La oficina maneja la comunicación con el cliente." },
        ],
      },

      { type: "h", text: { en: "Child Alone With Tech Protocol", es: "Protocolo de Niño Solo Con el Técnico" } },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "If a child under 18 is home alone or arrives home alone during a service, the tech immediately calls the office. Do NOT engage with the child beyond basic politeness. Do NOT discipline, feed, transport, or be alone in a room with a child. Keep doors open while in the home. The office decides whether to continue service or reschedule. Document the situation in the app. This policy protects Phes, employees, and the child.",
          es: "Si un menor de 18 años está en casa solo o llega a casa solo durante un servicio, el técnico llama inmediatamente a la oficina. NO interactúe con el niño más allá de cortesía básica. NO discipline, alimente, transporte ni esté solo en una habitación con un niño. Mantenga las puertas abiertas dentro del hogar. La oficina decide si continuar el servicio o reprogramar. Documente la situación en la app. Esta política protege a Phes, a los empleados y al niño.",
        },
      },

      { type: "h", text: { en: "End-of-Job Checklist", es: "Lista de Verificación al Finalizar el Trabajo" } },
      {
        type: "bullets",
        items: [
          { en: "Quality walk-through of every room using the in-app checklist.", es: "Recorrido de calidad de cada habitación usando la lista en la app." },
          { en: "Final touches: empty trash, replace bags, turn off lights, lock windows, place items back exactly where they were, supplies out of sight.", es: "Toques finales: vacíe la basura, reemplace las bolsas, apague las luces, cierre las ventanas, coloque los artículos exactamente donde estaban, suministros fuera de vista." },
          { en: "Required photos: BEFORE and AFTER photos of every room cleaned, uploaded to the app. Required rooms: kitchen counters, bathroom sink / toilet / tub, bedroom floors, living areas.", es: "Fotos requeridas: fotos ANTES y DESPUÉS de cada habitación limpiada, subidas a la app. Habitaciones requeridas: mostradores de cocina, lavabo / inodoro / tina del baño, pisos de dormitorio, áreas de sala." },
          { en: "Walk-through with the client if home. Ask 'Is there anything else you would like me to address?' Address simple requests. Call the office for larger.", es: "Recorrido con el cliente si está en casa. Pregunte '¿Hay algo más que le gustaría que atendiera?' Atienda solicitudes simples. Llame a la oficina para las más grandes." },
          { en: "Mark the job complete in the app. Confirm time clocked. Add notes (issues, items skipped with reason, supplies running low). Confirm next job in route.", es: "Marque el trabajo como completo en la app. Confirme la hora registrada. Agregue notas (problemas, artículos omitidos con razón, suministros bajos). Confirme el siguiente trabajo en la ruta." },
          { en: "Secure the home: lock all doors, set the alarm if instructed, return the key per protocol, confirm the app shows Job Complete.", es: "Asegure el hogar: cierre todas las puertas, active la alarma si se le indica, devuelva la llave según el protocolo, confirme que la app muestre Trabajo Completo." },
        ],
      },

      // ═══════════════════════════════════════════════════════════════════════
      // SECTION 7 — EQUIPMENT, UNIFORMS & MILEAGE
      // ═══════════════════════════════════════════════════════════════════════
      { type: "h", text: { en: "SECTION 7. Equipment, Uniforms, and Mileage", es: "SECCIÓN 7. Equipo, Uniformes y Millaje" } },

      { type: "h", text: { en: "Company-Provided Equipment", es: "Equipo Provisto por la Compañía" } },
      {
        type: "bullets",
        items: [
          { en: "Up to two (2) vacuum cleaners per employee per calendar year, subject to management approval.", es: "Hasta dos (2) aspiradoras por empleado por año calendario, sujeto a aprobación de la gerencia." },
          { en: "All company-purchased equipment remains Phes property.", es: "Todo el equipo comprado por la compañía sigue siendo propiedad de Phes." },
          { en: "Phes covers normal wear and tear replacements. Employees may be responsible for documented negligence or intentional damage only, consistent with applicable law.", es: "Phes cubre los reemplazos por desgaste normal. Los empleados pueden ser responsables solo por negligencia documentada o daño intencional, conforme a la ley aplicable." },
        ],
      },

      { type: "h", text: { en: "Uniform Issuance", es: "Entrega de Uniformes" } },
      {
        type: "bullets",
        items: [
          { en: "Each employee receives seven (7) company shirts, seven (7) company-approved pants, and one (1) company jacket.", es: "Cada empleado recibe siete (7) camisas de la compañía, siete (7) pantalones aprobados por la compañía y una (1) chamarra de la compañía." },
          { en: "Uniforms remain Phes property unless otherwise approved in writing.", es: "Los uniformes siguen siendo propiedad de Phes a menos que se apruebe lo contrario por escrito." },
        ],
      },

      { type: "h", text: { en: "Employee Out-of-Pocket", es: "De Bolsillo del Empleado" } },
      {
        type: "bullets",
        items: [
          { en: "Personal footwear meeting dress standards.", es: "Calzado personal que cumpla con los estándares de vestimenta." },
          { en: "Undergarments and accessories.", es: "Ropa interior y accesorios." },
          { en: "Optional uniform items beyond those provided.", es: "Artículos opcionales de uniforme más allá de los provistos." },
          { en: "Employees should NOT purchase supplies or equipment for company use unless management provides written pre-approval for reimbursement.", es: "Los empleados NO deben comprar suministros o equipo para uso de la compañía a menos que la gerencia otorgue pre-aprobación por escrito para reembolso." },
        ],
      },

      { type: "h", text: { en: "Mileage Reimbursement", es: "Reembolso de Millaje" } },
      {
        type: "bullets",
        items: [
          { en: "Reimbursed for travel BETWEEN one client location and a second client location on the same workday.", es: "Se reembolsa el viaje ENTRE una ubicación de cliente y una segunda ubicación de cliente en el mismo día laboral." },
          { en: "Home-to-first-job and last-job-to-home mileage is NOT reimbursable.", es: "El millaje de casa al primer trabajo y del último trabajo a casa NO es reembolsable." },
          { en: "Reimbursed at the IRS standard mileage rate in effect at the time of travel.", es: "Se reembolsa a la tarifa estándar de millaje del IRS vigente al momento del viaje." },
          { en: "Must be submitted through the Phes app within the same calendar month incurred. Include date, client names, total miles.", es: "Debe enviarse por la app de Phes dentro del mismo mes calendario en que se incurrió. Incluya fecha, nombres de clientes, total de millas." },
          { en: "Late or incomplete submissions may be denied. Mileage reimbursement is NOT considered wages.", es: "Las solicitudes tardías o incompletas pueden ser denegadas. El reembolso de millaje NO se considera salario." },
        ],
      },

      { type: "h", text: { en: "Supply Storage Choice", es: "Elección de Almacenamiento de Suministros" } },
      {
        type: "p",
        text: {
          en: "Phes supply kits and equipment may be stored at the Phes office for employees who prefer not to carry them in their personal vehicles. Employees may choose to take supplies home for personal convenience or to keep them at the Phes office. This is the EMPLOYEE'S CHOICE.",
          es: "Los kits de suministros y el equipo de Phes pueden almacenarse en la oficina de Phes para los empleados que prefieran no llevarlos en sus vehículos personales. Los empleados pueden elegir llevar los suministros a casa por conveniencia personal o mantenerlos en la oficina de Phes. Esta es la ELECCIÓN DEL EMPLEADO.",
        },
      },

      { type: "h", text: { en: "Final Pay and Property Return", es: "Pago Final y Devolución de Propiedad" } },
      {
        type: "p",
        text: {
          en: "All company property must be returned upon separation. A required separation meeting takes place in the office on the last day or within 3 business days. Property includes the supply kit ($500+ value), uniforms, keys, access cards, and company app access. The final paycheck (including unused PTO payout) is issued at the separation meeting or by the next regular payday, whichever is earlier, per the Illinois Wage Payment and Collection Act. If the employee cannot come to the office, the final paycheck is mailed.",
          es: "Toda la propiedad de la compañía debe ser devuelta al separarse. Se realiza una reunión obligatoria de separación en la oficina el último día o dentro de 3 días hábiles. La propiedad incluye el kit de suministros (valor de $500+), uniformes, llaves, tarjetas de acceso y acceso a la app de la compañía. El cheque final (incluyendo el pago de PTO no usado) se entrega en la reunión de separación o para el siguiente día de pago regular, lo que ocurra primero, conforme a la Ley de Pago y Cobranza de Salarios de Illinois. Si el empleado no puede ir a la oficina, el cheque final se envía por correo.",
        },
      },

      { type: "h", text: { en: "Wage Deduction Notice", es: "Aviso de Deducción Salarial" } },
      {
        type: "p",
        text: {
          en: "Wage deductions for unreturned or damaged property require a SEPARATE signed written authorization at the time of incident, per the Illinois Wage Deduction Act. Refusal to sign does NOT prevent Phes from pursuing recovery through small claims court or other legal channels.",
          es: "Las deducciones salariales por propiedad no devuelta o dañada requieren una autorización por escrito SEPARADA firmada al momento del incidente, conforme a la Ley de Deducción Salarial de Illinois. Negarse a firmar NO impide que Phes busque la recuperación a través de un tribunal de reclamos menores u otros canales legales.",
        },
      },
      {
        type: "p",
        text: {
          en: "Educational notice. Phes may request separate written wage deduction authorization for: (a) cost of replacing lost, stolen, or negligently damaged Phes property; (b) cost of repairing client property damaged due to documented negligence; (c) advance pay or loan repayment; (d) replacement uniforms beyond standard issue; (e) vacuum replacements beyond the 2-per-year allowance due to negligence; (f) supply kit items lost or damaged due to negligence; (g) bank fees or returned payment fees caused by employee error; and (h) other items with separate written authorization.",
          es: "Aviso educativo. Phes puede solicitar autorización separada por escrito para deducción salarial por: (a) costo de reemplazar propiedad de Phes perdida, robada o dañada por negligencia; (b) costo de reparar propiedad del cliente dañada por negligencia documentada; (c) pago anticipado o reembolso de préstamo; (d) uniformes de reemplazo más allá de la entrega estándar; (e) reemplazos de aspiradora más allá de la asignación de 2 por año por negligencia; (f) artículos del kit de suministros perdidos o dañados por negligencia; (g) cargos bancarios o cargos por pago devuelto causados por error del empleado; y (h) otros artículos con autorización separada por escrito.",
        },
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Phes will NOT deduct without specific signed authorization at the time of incident. The employee has the right to refuse. No deduction reduces wages below the minimum wage for any workweek.",
          es: "Phes NO deducirá sin autorización firmada específica al momento del incidente. El empleado tiene derecho a rehusarse. Ninguna deducción reduce los salarios por debajo del salario mínimo en ninguna semana laboral.",
        },
      },

      // ═══════════════════════════════════════════════════════════════════════
      // SECTION 8 — TIPPING
      // ═══════════════════════════════════════════════════════════════════════
      { type: "h", text: { en: "SECTION 8. Tipping", es: "SECCIÓN 8. Propinas" } },
      {
        type: "bullets",
        items: [
          { en: "Tips are 100% the employee's.", es: "Las propinas son 100% del empleado." },
          { en: "Cash tips: keep them.", es: "Propinas en efectivo: quédeselas." },
          { en: "Tips through the booking system are paid on the next paycheck.", es: "Las propinas a través del sistema de reservas se pagan en el siguiente cheque." },
          { en: "No kickback is owed to anyone.", es: "No se debe ningún porcentaje a nadie." },
          { en: "Tax responsibility: employees are responsible for reporting cash tips for tax purposes per IRS rules. Tips paid through the booking system are reported on your paycheck.", es: "Responsabilidad fiscal: los empleados son responsables de reportar las propinas en efectivo para fines fiscales conforme a las reglas del IRS. Las propinas pagadas a través del sistema de reservas se reportan en su cheque." },
        ],
      },

      // ═══════════════════════════════════════════════════════════════════════
      // SECTION 9 — PERFORMANCE REVIEWS
      // ═══════════════════════════════════════════════════════════════════════
      { type: "h", text: { en: "SECTION 9. Performance Reviews", es: "SECCIÓN 9. Evaluaciones de Desempeño" } },
      {
        type: "bullets",
        items: [
          { en: "30-day check-in (during training period).", es: "Reunión a 30 días (durante el periodo de entrenamiento)." },
          { en: "90-day formal review (end of probation, PLAWA eligibility begins).", es: "Evaluación formal a 90 días (fin de la probatoria, comienza la elegibilidad de PLAWA)." },
          { en: "Quarterly reviews thereafter. ALL reviews take place IN PERSON.", es: "Evaluaciones trimestrales en adelante. TODAS las evaluaciones se hacen EN PERSONA." },
          { en: "Reviews rotate format: in-person meeting and video review alternating each quarter.", es: "Las evaluaciones rotan formato: reunión en persona y revisión por video alternando cada trimestre." },
          { en: "Quality metrics tracked: completion times, quality complaints, attendance, client satisfaction scores.", es: "Métricas de calidad seguidas: tiempos de finalización, quejas de calidad, asistencia, puntajes de satisfacción del cliente." },
        ],
      },

      // ═══════════════════════════════════════════════════════════════════════
      // SECTION 10 — COMMUNICATION
      // ═══════════════════════════════════════════════════════════════════════
      { type: "h", text: { en: "SECTION 10. Communication", es: "SECCIÓN 10. Comunicación" } },
      {
        type: "bullets",
        items: [
          { en: "Phes communicates via text and voice (phone calls).", es: "Phes se comunica por mensaje de texto y voz (llamadas)." },
          { en: "During business hours, employees should respond as soon as possible. Phes prefers immediate response.", es: "Durante horas de oficina, los empleados deben responder lo antes posible. Phes prefiere respuesta inmediata." },
          { en: "By accepting employment, the employee consents to receive text messages from Phes regarding scheduling, job changes, and urgent matters (TCPA compliance).", es: "Al aceptar el empleo, el empleado consiente recibir mensajes de texto de Phes sobre programación, cambios de trabajo y asuntos urgentes (cumplimiento de TCPA)." },
          { en: "Employees must keep contact information current. Updates go through the office.", es: "Los empleados deben mantener actualizada la información de contacto. Las actualizaciones se hacen a través de la oficina." },
        ],
      },

      // ═══════════════════════════════════════════════════════════════════════
      // SECTION 11 — SCHEDULE CHANGES & BUSINESS SLOWDOWNS
      // ═══════════════════════════════════════════════════════════════════════
      { type: "h", text: { en: "SECTION 11. Schedule Changes and Business Slowdowns", es: "SECCIÓN 11. Cambios de Horario y Reducción de Negocio" } },
      {
        type: "bullets",
        items: [
          { en: "Phes may modify schedules based on business needs.", es: "Phes puede modificar horarios según las necesidades del negocio." },
          { en: "Hours may be REDUCED during slow periods (weather, off-season, route changes).", es: "Las horas pueden REDUCIRSE durante periodos lentos (clima, temporada baja, cambios de ruta)." },
          { en: "No guarantee of specific hours. W-2 status does NOT equal guaranteed weekly hours.", es: "No hay garantía de horas específicas. El estatus W-2 NO equivale a horas semanales garantizadas." },
          { en: "Notice is given when possible.", es: "Se da aviso cuando es posible." },
          { en: "Hour reductions are NOT layoffs. The employee remains on the team.", es: "Las reducciones de horas NO son despidos. El empleado permanece en el equipo." },
        ],
      },

      // ═══════════════════════════════════════════════════════════════════════
      // SECTION 12 — EQUAL EMPLOYMENT OPPORTUNITY
      // ═══════════════════════════════════════════════════════════════════════
      { type: "h", text: { en: "SECTION 12. Equal Employment Opportunity", es: "SECCIÓN 12. Igualdad de Oportunidades en el Empleo" } },
      {
        type: "p",
        text: {
          en: "Phes Cleaning Services provides equal employment opportunities to all employees and applicants in accordance with applicable federal, state, and local law. Phes prohibits discrimination, harassment, and retaliation, and provides reasonable accommodation upon request. Full sexual harassment training content is in the standalone Sexual Harassment Prevention module.",
          es: "Phes Cleaning Services brinda igualdad de oportunidades de empleo a todos los empleados y solicitantes conforme a la ley federal, estatal y local aplicable. Phes prohíbe la discriminación, el acoso y las represalias, y provee acomodación razonable cuando se solicita. El contenido completo de capacitación sobre acoso sexual está en el módulo independiente de Prevención del Acoso Sexual.",
        },
      },

      // ═══════════════════════════════════════════════════════════════════════
      // SECTION 13 — POLICY ADMINISTRATION
      // ═══════════════════════════════════════════════════════════════════════
      { type: "h", text: { en: "SECTION 13. Policy Administration", es: "SECCIÓN 13. Administración de Políticas" } },
      {
        type: "p",
        text: {
          en: "Phes Cleaning Services reserves the right to interpret, administer, and amend this handbook at its discretion in accordance with applicable law. Material policy changes trigger required immediate re-acknowledgment by all employees. Minor changes are communicated and re-acknowledged at the next annual December cycle.",
          es: "Phes Cleaning Services se reserva el derecho de interpretar, administrar y enmendar este manual a su discreción conforme a la ley aplicable. Los cambios de política materiales activan el re-reconocimiento inmediato requerido por todos los empleados. Los cambios menores se comunican y se re-reconocen en el siguiente ciclo anual de diciembre.",
        },
      },

      // ═══════════════════════════════════════════════════════════════════════
      // SECTION 14 — HANDBOOK ACKNOWLEDGMENT
      // ═══════════════════════════════════════════════════════════════════════
      { type: "h", text: { en: "SECTION 14. Handbook Acknowledgment", es: "SECCIÓN 14. Reconocimiento del Manual" } },
      {
        type: "p",
        text: {
          en: "By completing this module and signing the final acknowledgment (rendered separately in a later step), you acknowledge:",
          es: "Al completar este módulo y firmar el reconocimiento final (presentado por separado en un paso posterior), usted reconoce:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "You received and read the 2026 Phes Employee Handbook.", es: "Recibió y leyó el Manual del Empleado de Phes 2026." },
          { en: "You understand your employment is AT-WILL.", es: "Entiende que su empleo es A VOLUNTAD." },
          { en: "You provide EXPRESS WRITTEN CONSENT to the commission structure: 35% commission on standard cleanings, 32% on deep cleans and move-in / move-out cleanings, $20.00 per hour for commercial jobs within allotted hours. Quality Verification occurs 24 hours post-job. The job converts to $18.00 per hour if you refuse a valid re-clean request (Quality Verification fails). This commission structure is a fundamental term of employment.", es: "Provee CONSENTIMIENTO EXPRESO POR ESCRITO a la estructura de comisión: 35% en limpiezas estándar, 32% en limpiezas profundas y mudanzas, $20.00 por hora en trabajos comerciales dentro de las horas asignadas. La Verificación de Calidad ocurre 24 horas después del trabajo. El trabajo se convierte a $18.00 por hora si rechaza una solicitud válida de re-limpieza (la Verificación de Calidad falla). Esta estructura de comisión es un término fundamental del empleo." },
          { en: "You understand the wage deduction policy and your right to refuse specific authorizations.", es: "Entiende la política de deducción salarial y su derecho a rehusar autorizaciones específicas." },
          { en: "You understand material policy changes require immediate re-acknowledgment.", es: "Entiende que los cambios de política materiales requieren re-reconocimiento inmediato." },
          { en: "You commit to the annual re-acknowledgment cycle aligned with December sexual harassment training.", es: "Se compromete con el ciclo anual de re-reconocimiento alineado con la capacitación de acoso sexual en diciembre." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "The formal e-signature page (with IP address, device info, version hash, and tamper-evident storage per UETA / E-SIGN) lands as part of the final comprehensive handbook PDF flow in a later step. This module's quiz verifies your comprehension of the content above.",
          es: "La página de firma electrónica formal (con dirección IP, información del dispositivo, hash de versión y almacenamiento a prueba de manipulación conforme a UETA / E-SIGN) se entrega como parte del flujo del PDF final del manual en un paso posterior. El examen de este módulo verifica su comprensión del contenido anterior.",
        },
      },

    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. COMPENSATION
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "compensation",
    number: 2,
    iconKind: "money",
    title: { en: "Compensation", es: "Compensación" },
    subtitle: {
      en: "Training pay, tiered residential commission, commercial hourly, the Fix-It Rule, probation, and payroll.",
      es: "Pago de entrenamiento, comisión residencial por niveles, hora comercial, la Regla de Corrección, periodo de prueba y nómina.",
    },
    estimatedMinutes: 12,
    blocks: [
      { type: "h", text: { en: "Training Pay", es: "Pago de Entrenamiento" } },
      {
        type: "p",
        text: {
          en: "During your first cleanings as a new team member you are paid $20.00 per hour for time on the job. Training pay applies until the office activates you as a regular technician.",
          es: "Durante sus primeras limpiezas como nuevo miembro del equipo, se le paga $20.00 por hora de trabajo. El pago de entrenamiento aplica hasta que la oficina lo active como técnico regular.",
        },
      },

      { type: "h", text: { en: "Residential Commission — Tiered", es: "Comisión Residencial — Por Niveles" } },
      {
        type: "p",
        text: {
          en: "Once activated, you earn a percentage commission on residential jobs. The rate depends on the service type:",
          es: "Una vez activado, gana una comisión porcentual en trabajos residenciales. La tarifa depende del tipo de servicio:",
        },
      },
      {
        type: "table",
        head: {
          en: ["Service Type", "Tech Pay %", "Why"],
          es: ["Tipo de Servicio", "% de Pago al Técnico", "Por qué"],
        },
        rows: [
          { en: ["Standard Clean / Recurring", "35%", "Standard residential rate"], es: ["Limpieza Estándar / Recurrente", "35%", "Tarifa residencial estándar"] },
          { en: ["Deep Clean", "32%", "Phes bills client $80/hr — higher labor intensity"], es: ["Limpieza Profunda", "32%", "Phes factura $80/hr al cliente — más intensidad"] },
          { en: ["Move In / Move Out", "32%", "Phes bills client $80/hr — higher labor intensity"], es: ["Move In / Move Out", "32%", "Phes factura $80/hr al cliente — más intensidad"] },
          { en: ["Commercial (any)", "$20/hr × allowed hours", "Hourly base, see below"], es: ["Comercial (cualquiera)", "$20/hr × horas asignadas", "Base por hora, ver abajo"] },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Why the tier? Deep cleans and move in / move out are more physically demanding and higher-margin services for the client. We bill more per hour and pay you a slightly lower percentage so total dollars per hour stay strong on a fast deep clean — but you gain reliable volume.",
          es: "¿Por qué el nivel? Las limpiezas profundas y move in / move out son más demandantes y de mayor margen para el cliente. Facturamos más por hora y le pagamos un porcentaje ligeramente menor para que sus dólares por hora se mantengan fuertes en limpiezas profundas rápidas — pero gana volumen confiable.",
        },
      },

      { type: "h", text: { en: "Multi-Tech Split", es: "División en Equipos" } },
      {
        type: "p",
        text: {
          en: "When two or more techs are assigned to the same job, the commission pool is split among the team — equally if you all check in together, proportionally by actual on-site minutes if check-in times differ.",
          es: "Cuando dos o más técnicos están asignados al mismo trabajo, la comisión se divide entre el equipo — en partes iguales si todos hacen Check In juntos, proporcional a los minutos reales en sitio si los tiempos de Check In difieren.",
        },
      },
      {
        type: "table",
        head: {
          en: ["Team Size", "Each tech (Standard 35%)", "Example on $200 job"],
          es: ["Tamaño del Equipo", "Cada técnico (Estándar 35%)", "Ejemplo en trabajo de $200"],
        },
        rows: [
          { en: ["1 cleaner", "35%", "$70 total"], es: ["1 limpiador", "35%", "$70 total"] },
          { en: ["2 cleaners", "17.5% each", "$35 each"], es: ["2 limpiadores", "17.5% c/u", "$35 c/u"] },
          { en: ["3 cleaners", "~11.67% each", "~$23.33 each"], es: ["3 limpiadores", "~11.67% c/u", "~$23.33 c/u"] },
        ],
      },

      { type: "h", text: { en: "Hourly Time Blocks", es: "Bloques de Tiempo por Hora" } },
      {
        type: "p",
        text: {
          en: "Phes also sells hourly time blocks — typically 3 to 4 hours — to clients who want specific areas cleaned. You're assigned a set number of hours.",
          es: "Phes también vende bloques de tiempo por hora — típicamente 3 a 4 horas — a clientes que quieren limpiar áreas específicas. Se le asigna un número fijo de horas.",
        },
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Most important rule: if you can already tell partway through that you won't finish in the assigned time, CALL THE OFFICE EARLY — not at the last hour. An early call lets the office talk to the client and either authorize more time or adjust scope. A last-hour call forces the office to ask the client for more time at the end of the visit; clients are not pleased and the conversation gets very hard.",
          es: "Regla más importante: si ya ve a la mitad que no terminará en el tiempo asignado, LLAME A LA OFICINA TEMPRANO — no en la última hora. Una llamada temprana permite a la oficina hablar con el cliente y autorizar más tiempo o ajustar el alcance. Una llamada tardía obliga a la oficina a pedir más tiempo al final; los clientes no quedan contentos y la conversación se vuelve muy difícil.",
        },
      },

      { type: "h", text: { en: "Commercial — $20/hr × Allowed Hours", es: "Comercial — $20/hr × Horas Asignadas" } },
      {
        type: "p",
        text: {
          en: "Commercial jobs (offices, retail, medical buildings) pay a flat $20/hr × the allowed hours assigned to the visit, regardless of job total. The tiered residential rates do not apply.",
          es: "Trabajos comerciales (oficinas, comercio, edificios médicos) pagan $20/hr × las horas asignadas a la visita, sin importar el total del trabajo. Las tarifas residenciales por niveles no aplican.",
        },
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Commercial completion rule: if you finish a 3-hour commercial job in 1.5 hours, CALL THE OFFICE before uploading completion photos. The allowed hours are calibrated; closing early without checking can trigger a Prorate Employee Pay reduction.",
          es: "Regla de finalización comercial: si termina un trabajo comercial de 3 horas en 1.5 horas, LLAME A LA OFICINA antes de subir fotos. Las horas asignadas están calibradas; cerrar temprano sin avisar puede activar una reducción de Prorate Employee Pay.",
        },
      },

      { type: "h", text: { en: "The Fix-It Rule", es: "La Regla de Corrección" } },
      {
        type: "p",
        text: {
          en: "If a client calls within 24 hours unhappy with anything in their home, a team returns the same day to fix it. Phes covers the labor — the returning team is paid normally. We never refuse a guarantee call. Repeated Fix-It calls on your jobs may trigger Quality Probation.",
          es: "Si un cliente llama dentro de las 24 horas inconforme con cualquier cosa en su hogar, un equipo regresa el mismo día para corregirlo. Phes cubre la mano de obra — el equipo que regresa recibe pago normal. Nunca rechazamos una llamada de garantía. Llamadas Fix-It repetidas pueden activar Periodo de Prueba de Calidad.",
        },
      },

      { type: "h", text: { en: "Quality Probation", es: "Periodo de Prueba de Calidad" } },
      {
        type: "p",
        text: {
          en: "If you have 2 client complaints in any 30-day window, you enter Quality Probation: 30 days at $20/hr training rate (no commission) while you ride along with senior techs. Pass the probation by completing 30 days clean of complaints; you return to commission. Fail again and the next step is termination.",
          es: "Si tiene 2 quejas de clientes en cualquier ventana de 30 días, entra a Periodo de Prueba de Calidad: 30 días a $20/hr de entrenamiento (sin comisión) mientras acompaña a técnicos senior. Pase la prueba completando 30 días limpios; regresa a comisión. Falle de nuevo y el siguiente paso es terminación.",
        },
      },

      { type: "h", text: { en: "Mileage Reimbursement", es: "Reembolso de Millaje" } },
      {
        type: "p",
        text: {
          en: "Phes reimburses mileage between client homes (not your commute from home to first job, or last job to home). Submit mileage requests through the system; the office reviews and approves. The current rate is $0.70 per mile.",
          es: "Phes reembolsa el millaje entre hogares de clientes (no su trayecto desde casa al primer trabajo, ni del último trabajo a casa). Envíe solicitudes de millaje a través del sistema; la oficina revisa y aprueba. La tarifa actual es $0.70 por milla.",
        },
      },

      { type: "h", text: { en: "Payroll", es: "Nómina" } },
      {
        type: "bullets",
        items: [
          { en: "Pay cycle: biweekly, deposited every other Friday.", es: "Ciclo de pago: quincenal, depositado cada dos viernes." },
          { en: "Direct deposit only — no paper checks.", es: "Solo depósito directo — sin cheques de papel." },
          { en: "Tips paid out same cycle as the work that earned them.", es: "Las propinas se pagan en el mismo ciclo que el trabajo que las generó." },
          { en: "Mileage paid out the cycle after the request is approved.", es: "Millaje pagado el ciclo siguiente a la aprobación de la solicitud." },
        ],
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. CLEANING BEST PRACTICES & EFFICIENCY (Speed-Cleaning Method)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "cleaning-best-practices",
    number: 3,
    iconKind: "flow",
    title: { en: "Cleaning Best Practices & Efficiency", es: "Mejores Prácticas de Limpieza y Eficiencia" },
    subtitle: {
      en: "The Speed-Cleaning Method — 13 rules that turn a 2-hour job into a 90-minute job without cutting quality.",
      es: "El Método de Limpieza Rápida — 13 reglas que convierten un trabajo de 2 horas en uno de 90 minutos sin reducir la calidad.",
    },
    estimatedMinutes: 14,
    blocks: [
      { type: "h", text: { en: "Why Speed-Cleaning Works", es: "Por qué Funciona la Limpieza Rápida" } },
      {
        type: "p",
        text: {
          en: "Speed comes from technique, not from cutting corners. The Speed-Cleaning Method is a 13-rule framework adopted across Phes that lets every tech move through a home in a planned sequence — every motion has a purpose, every product has a place, and you never re-touch a surface.",
          es: "La velocidad viene de la técnica, no de tomar atajos. El Método de Limpieza Rápida es un marco de 13 reglas adoptado en Phes que permite a cada técnico moverse por un hogar en una secuencia planeada — cada movimiento tiene un propósito, cada producto un lugar, y nunca vuelve a tocar una superficie.",
        },
      },

      { type: "h", text: { en: "The 13 Rules", es: "Las 13 Reglas" } },
      {
        type: "bullets",
        items: [
          { en: "1. Work top to bottom — start with the highest surface in the room and finish at the floor. Gravity helps you.", es: "1. Trabaje de arriba hacia abajo — comience por la superficie más alta y termine en el piso. La gravedad le ayuda." },
          { en: "2. Work left to right — pick a direction at the door and move consistently around the room.", es: "2. Trabaje de izquierda a derecha — escoja una dirección en la puerta y muévase consistentemente." },
          { en: "3. Don't backtrack — if you finished a wall, you don't return to it.", es: "3. No regrese — si terminó una pared, no vuelva a ella." },
          { en: "4. Carry everything in once — load your caddy completely before entering a room: every cloth, every product, in one trip.", es: "4. Cargue todo de una vez — llene su portasuministros completamente antes de entrar: cada paño, cada producto, en un solo viaje." },
          { en: "5. Use both hands — wipe with one, spray with the other; one cloth wet, one dry.", es: "5. Use ambas manos — limpie con una, rocíe con la otra; un paño húmedo, uno seco." },
          { en: "6. Spray and let dwell — spray a surface, then move to another task in the same room while the chemical does its work. Wipe when you come back.", es: "6. Rocíe y deje reposar — rocíe una superficie, pase a otra tarea, regrese y limpie. El químico trabaja por usted." },
          { en: "7. Pre-treat the toughest spots first — soap scum, grease, hard-water stains get product first so they soak while you do the easy parts.", es: "7. Pretrate las manchas más difíciles primero — sarro, grasa y manchas duras reciben producto primero para que se ablanden mientras hace lo fácil." },
          { en: "8. Wipe in S-pattern on glass and mirrors — circles leave streaks; the S lifts dirt cleanly.", es: "8. Limpie en patrón de S en vidrio y espejos — los círculos dejan rayas; la S levanta la suciedad limpiamente." },
          { en: "9. Color-coded cloths — yellow for kitchens, blue for glass, green for bathrooms. Never cross-contaminate.", es: "9. Paños por color — amarillo para cocinas, azul para vidrio, verde para baños. Nunca contamine cruzado." },
          { en: "10. Vacuum before mopping — never mop dust; you'll smear it.", es: "10. Aspire antes de trapear — nunca trapee polvo; se esparcirá." },
          { en: "11. Mop yourself out of the room — start at the far corner and back out toward the door so you don't walk on a wet floor.", es: "11. Trapee saliendo de la habitación — empiece en la esquina más lejana y salga de espaldas hacia la puerta para no caminar sobre piso mojado." },
          { en: "12. Finish each room completely before moving on — don't half-clean and circle back.", es: "12. Termine cada habitación por completo antes de moverse — no limpie a medias y regrese." },
          { en: "13. Clean to a standard, not to a time — efficiency comes from technique, not from skipping steps. The clock is a tool, not a goal.", es: "13. Limpie a un estándar, no a un tiempo — la eficiencia viene de la técnica, no de saltarse pasos. El reloj es una herramienta, no una meta." },
        ],
      },

      { type: "h", text: { en: "Room Order", es: "Orden de Habitaciones" } },
      {
        type: "p",
        text: {
          en: "Start at the room farthest from the entrance and work your way back toward the door. The last room you finish should be the one closest to your exit. This way you never walk through a freshly cleaned area dragging dust from a not-yet-cleaned area.",
          es: "Comience en la habitación más lejana de la entrada y trabaje hacia la puerta. La última habitación que termine debe ser la más cercana a la salida. Así nunca camina por un área recién limpia arrastrando polvo de un área aún sucia.",
        },
      },

      { type: "h", text: { en: "The Caddy Discipline", es: "Disciplina del Portasuministros" } },
      {
        type: "p",
        text: {
          en: "Every trip back to your car or supply bag costs you 60–90 seconds. Across 5 rooms, that's 5–8 minutes of pure waste. Load your caddy ONCE per room — every product, every cloth, the right tools — and only re-enter that room. If you find yourself walking back to your bag mid-clean, stop and ask: what did I forget? Add it to your pre-load checklist.",
          es: "Cada regreso a su auto o bolsa cuesta 60–90 segundos. En 5 habitaciones, son 5–8 minutos de desperdicio puro. Cargue su portasuministros UNA VEZ por habitación — cada producto, cada paño, las herramientas correctas — y solo vuelva a entrar a esa habitación. Si se ve regresando a la bolsa, deténgase y pregunte: ¿qué olvidé?",
        },
      },

      { type: "h", text: { en: "Two-Hand Technique", es: "Técnica de Dos Manos" } },
      {
        type: "p",
        text: {
          en: "Both hands work simultaneously: wet cloth in one hand wiping; dry cloth or spray bottle in the other ready to follow up. On glass: dry hand follows wet hand within 2 seconds — no streaks. On counters: spray with dominant hand, wipe with supporting hand. This doubles your speed without increasing effort.",
          es: "Ambas manos trabajan al mismo tiempo: paño húmedo en una mano limpiando; paño seco o atomizador en la otra listo para seguir. En vidrio: la mano seca sigue a la mojada en 2 segundos — sin rayas. En mostradores: rocíe con la mano dominante, limpie con la otra. Esto duplica su velocidad sin aumentar el esfuerzo.",
        },
      },

      { type: "h", text: { en: "Team Arrival Protocol", es: "Protocolo de Llegada en Equipo" } },
      {
        type: "p",
        text: {
          en: "Always enter the home together as a team, even if you arrive separately. Wait at the door for your partner — never enter alone, even with the door code. The client expects to see the team; entering solo damages trust and creates security exposure on both sides.",
          es: "Siempre entre al hogar junto con su equipo, incluso si llegan por separado. Espere en la puerta a su compañero — nunca entre solo, ni con el código. El cliente espera ver al equipo; entrar solo daña la confianza y crea exposición de seguridad para ambos lados.",
        },
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. MAIDCENTRAL (with Qleno coming-next callout)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "maidcentral",
    number: 4,
    iconKind: "pin",
    title: { en: "MaidCentral", es: "MaidCentral" },
    subtitle: {
      en: "Day Clock vs Job Clock, GPS check-in, the 600-foot rule, efficiency, travel pay, and time-correction requests.",
      es: "Reloj de Día vs Reloj de Trabajo, Check In por GPS, la regla de 600 pies, eficiencia, pago de traslado y solicitudes de corrección.",
    },
    estimatedMinutes: 10,
    blocks: [
      { type: "h", text: { en: "The Two-Clock System", es: "El Sistema de Dos Relojes" } },
      {
        type: "p",
        text: {
          en: "MaidCentral has TWO clocks running every workday. The Day Clock starts when you Clock In at the start of your shift and stops when you Clock Out at the end. The Job Clock starts when you Check In to a specific client and stops when you Check Out of that client. The difference between them is travel time — paid as travel pay.",
          es: "MaidCentral tiene DOS relojes cada día. El Reloj de Día comienza cuando hace Clock In al inicio del turno y se detiene cuando hace Clock Out al final. El Reloj de Trabajo comienza cuando hace Check In en un cliente específico y se detiene en Check Out. La diferencia entre ambos es tiempo de traslado — pagado como travel pay.",
        },
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "First action of the day is always Clock In. Every Check In after that happens INSIDE your already-running Day Clock — you do not Clock In a second time. At the end of the day, Check Out of your last job, then Clock Out for the day.",
          es: "La primera acción del día siempre es Clock In. Cada Check In después ocurre DENTRO del Reloj de Día — no haga Clock In una segunda vez. Al final del día, haga Check Out del último trabajo, luego Clock Out del día.",
        },
      },

      { type: "h", text: { en: "Individual Per-Tech Check-In", es: "Check In Individual por Técnico" } },
      {
        type: "p",
        text: {
          en: "Every tech checks in INDIVIDUALLY — even when working as a team. If two techs arrive at 9:00 AM but one waits in the car until 9:20, MaidCentral records the actual check-in time for each. Commission split is calculated by actual minutes on site, not by who's listed first.",
          es: "Cada técnico hace Check In INDIVIDUAL — incluso trabajando en equipo. Si dos técnicos llegan a las 9:00 AM pero uno espera en el auto hasta las 9:20, MaidCentral registra el tiempo real de cada uno. La división de comisión se calcula por minutos reales en sitio.",
        },
      },

      { type: "h", text: { en: "The 600-Foot GPS Rule", es: "La Regla GPS de 600 Pies" } },
      {
        type: "p",
        text: {
          en: "MaidCentral verifies your physical location at Check In. You must be within 600 feet of the property to Check In successfully. If you try from your car parked two blocks away, the app will reject the check-in with a GPS warning. Walk to the door first, then check in.",
          es: "MaidCentral verifica su ubicación física al hacer Check In. Debe estar a 600 pies o menos de la propiedad. Si intenta desde el auto a dos cuadras, la app rechazará el Check In con advertencia de GPS. Camine hasta la puerta primero, luego haga Check In.",
        },
      },

      { type: "h", text: { en: "Efficiency Score", es: "Puntuación de Eficiencia" } },
      {
        type: "p",
        text: {
          en: "Your efficiency score is your total Job Clock hours divided by your total Day Clock hours. It measures how much of your day was spent actively cleaning vs travel + breaks + admin. Phes target: 70%+. Below 60% triggers a coaching conversation about route, technique, or tooling.",
          es: "Su puntuación de eficiencia es el total de horas del Reloj de Trabajo dividido por el total de horas del Reloj de Día. Mide cuánto de su día fue limpieza activa vs traslado + descansos + administración. Meta de Phes: 70%+. Menos de 60% activa una conversación de orientación sobre ruta, técnica o herramientas.",
        },
      },

      { type: "h", text: { en: "Travel Pay", es: "Pago de Traslado" } },
      {
        type: "p",
        text: {
          en: "Time when you're Clocked In for the day but NOT Checked Into a job — that's travel pay. Driving between client homes is paid. Driving from your home to the first job, or from the last job back home, is NOT paid (it's commute, not travel).",
          es: "El tiempo en que está con Clock In del día pero NO con Check In en un trabajo — eso es travel pay. Manejar entre hogares se paga. Manejar de su casa al primer trabajo, o del último trabajo de regreso a casa, NO se paga (es trayecto, no traslado).",
        },
      },

      { type: "h", text: { en: "Clock / Job Change Requests", es: "Solicitudes de Cambio de Reloj / Trabajo" } },
      {
        type: "p",
        text: {
          en: "If you forgot to Check Out, missed a Check In, or have any other clock-time error, submit a Clock/Job Change Request through MaidCentral. The office reviews and approves. Do NOT text managers, DM the office, or hope payroll figures it out — only the system creates an audit trail that lands on your paycheck correctly.",
          es: "Si olvidó hacer Check Out, no hizo Check In, o tiene cualquier error de tiempo, envíe una Clock/Job Change Request en MaidCentral. La oficina revisa y aprueba. NO mande mensaje a gerentes, ni DM a la oficina, ni espere que la nómina lo resuelva — solo el sistema crea un registro de auditoría.",
        },
      },

      { type: "h", text: { en: "When Worksheet and Client Note Conflict", es: "Cuando la Hoja de Trabajo y la Nota del Cliente se Contradicen" } },
      {
        type: "p",
        text: {
          en: "The Worksheet shows the standard scope. Client notes can override specific items (\"don't move the rug under the dining table,\" \"my cat is hiding in the laundry closet — don't open it\"). Client note wins on the specific item; the rest of the Worksheet still applies. Never ask the client to choose mid-clean — read both BEFORE you start.",
          es: "La Hoja de Trabajo muestra el alcance estándar. Las notas del cliente pueden anular elementos específicos (\"no mueva la alfombra bajo la mesa del comedor\", \"mi gato está en el closet de lavandería — no lo abra\"). La nota del cliente gana en lo específico; el resto de la Hoja sigue aplicando. Nunca pregunte al cliente durante la limpieza — lea ambas ANTES.",
        },
      },

      { type: "h", text: { en: "Coming Next: Qleno", es: "Próximamente: Qleno" } },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Phes is migrating from MaidCentral to Qleno over the next several months. Qleno is the company's own platform — same two-clock system, same GPS check-in, same Worksheet, but a faster mobile app with offline support, simpler day view, and integrated quotes / invoices. You'll be trained on Qleno before the cutover; until then, MaidCentral is the system of record.",
          es: "Phes está migrando de MaidCentral a Qleno en los próximos meses. Qleno es la plataforma propia de la compañía — mismo sistema de dos relojes, mismo Check In por GPS, misma Hoja de Trabajo, pero una app móvil más rápida con soporte offline, vista de día más simple, y cotizaciones / facturas integradas. Lo entrenaremos en Qleno antes del cambio; hasta entonces, MaidCentral es el sistema oficial.",
        },
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. PRODUCTS & TOOLS (existing 10 + 4 new items)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "products-tools",
    number: 5,
    iconKind: "spray",
    title: { en: "Products & Tools", es: "Productos y Herramientas" },
    subtitle: {
      en: "Every product Phes uses, what surfaces it belongs on, and the surfaces where it will damage the home.",
      es: "Cada producto que usa Phes, sobre qué superficies va, y las superficies donde dañará el hogar.",
    },
    estimatedMinutes: 14,
    blocks: [
      {
        type: "p",
        text: {
          en: "The right product on the wrong surface is more expensive than no product at all. A $30 spray that etches a $4,000 quartz countertop is a damage claim, a Fix-It call, and a hard conversation with the client. This module is about WHERE each product belongs and — equally important — where it does NOT.",
          es: "El producto correcto en la superficie equivocada es más caro que no usar producto. Un atomizador de $30 que daña un mostrador de cuarzo de $4,000 es un reclamo, una llamada Fix-It y una conversación difícil. Este módulo trata de DÓNDE va cada producto y — igualmente importante — dónde NO.",
        },
      },

      { type: "h", text: { en: "Mr. Clean with Febreze", es: "Mr. Clean con Febreze" } },
      {
        type: "bullets",
        items: [
          { en: "Use on: sealed counters, painted walls (spot), tile floors.", es: "Use en: mostradores sellados, paredes pintadas (puntual), pisos de baldosa." },
          { en: "Cloth: yellow microfiber.", es: "Paño: microfibra amarilla." },
          { en: "Don't use on: natural stone, unfinished wood.", es: "No use en: piedra natural, madera sin sellar." },
        ],
      },

      { type: "h", text: { en: "Bar Keepers Friend Liquid", es: "Bar Keepers Friend Líquido" } },
      {
        type: "bullets",
        items: [
          { en: "Use on: stainless steel sinks, porcelain tubs, ceramic toilets, glass cooktops.", es: "Use en: fregaderos de acero, tinas de porcelana, inodoros de cerámica, estufas de vidrio." },
          { en: "Method: small dab on a damp cloth, gentle circular motions, rinse fully.", es: "Método: pequeña cantidad en paño húmedo, movimientos circulares suaves, enjuague total." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "NEVER on natural stone — granite, marble, soapstone, travertine. Bar Keepers Friend contains oxalic acid and will etch the surface, leaving permanent dull spots. Use a damp microfiber with water for granite.",
          es: "NUNCA en piedra natural — granito, mármol, esteatita, travertino. Bar Keepers Friend contiene ácido oxálico y dañará la superficie, dejando manchas opacas permanentes. Use microfibra húmeda con agua para granito.",
        },
      },

      { type: "h", text: { en: "Simple Green (1:30 dilution)", es: "Simple Green (dilución 1:30)" } },
      {
        type: "bullets",
        items: [
          { en: "Use on: light surface cleaning — counters, appliances, baseboards.", es: "Use en: limpieza ligera — mostradores, electrodomésticos, rodapiés." },
          { en: "Dilution: 1 part Simple Green to 30 parts water in a spray bottle. Never use full strength inside a home.", es: "Dilución: 1 parte Simple Green por 30 de agua en atomizador. Nunca a fuerza total dentro de un hogar." },
          { en: "Don't use on: aluminum cookware, polished marble.", es: "No use en: utensilios de aluminio, mármol pulido." },
        ],
      },

      { type: "h", text: { en: "Ecolab Glass Cleaner", es: "Limpiador de Vidrio Ecolab" } },
      {
        type: "bullets",
        items: [
          { en: "Use on: mirrors, glass shower doors, windows (interior).", es: "Use en: espejos, puertas de ducha de vidrio, ventanas (interior)." },
          { en: "Method: spray on the BLUE microfiber cloth (never directly on the mirror), wipe in S-pattern.", es: "Método: rocíe sobre el paño AZUL de microfibra (nunca directamente en el espejo), limpie en patrón de S." },
          { en: "Why blue: dedicated glass cloth — no residue from kitchen or bathroom cleaners.", es: "Por qué azul: paño dedicado a vidrio — sin residuos de cocina o baño." },
        ],
      },

      { type: "h", text: { en: "OCedar Deep Clean Mop", es: "Trapeador OCedar Deep Clean" } },
      {
        type: "bullets",
        items: [
          { en: "Use on: hardwood, tile, laminate.", es: "Use en: madera, baldosa, laminado." },
          { en: "Method: wring thoroughly so the mop is DAMP, not soaked. Never spray cleaner directly on the floor.", es: "Método: escurra bien para que el trapeador esté HÚMEDO, no empapado. Nunca rocíe limpiador directamente en el piso." },
          { en: "Hardwood: water can warp wood — wring extra dry on hardwood floors.", es: "Madera: el agua puede deformarla — escurra extra-seco en madera." },
        ],
      },

      { type: "h", text: { en: "Toilet Bowl Cleaner (Lysol)", es: "Limpiador de Inodoros (Lysol)" } },
      {
        type: "bullets",
        items: [
          { en: "Apply under the rim, let dwell 5+ minutes while you clean the rest of the bathroom, then scrub with the toilet brush.", es: "Aplique bajo el borde, deje actuar 5+ minutos mientras limpia el resto del baño, luego restriegue con el cepillo." },
          { en: "Cloth color: GREEN — bathroom-only. Never use a green cloth in a kitchen.", es: "Color de paño: VERDE — solo baño. Nunca use paño verde en cocina." },
        ],
      },

      { type: "h", text: { en: "Lysol Disinfecting Wipes", es: "Toallitas Desinfectantes Lysol" } },
      {
        type: "bullets",
        items: [
          { en: "Use on: high-touch surfaces — door handles, light switches, faucets, toilet seats.", es: "Use en: superficies de alto contacto — manijas, interruptores, llaves, asientos de inodoro." },
          { en: "Don't use on: unfinished wood, electronics screens, leather.", es: "No use en: madera sin sellar, pantallas, cuero." },
        ],
      },

      { type: "h", text: { en: "Stainless Steel Polish (3M)", es: "Pulidor de Acero Inoxidable (3M)" } },
      {
        type: "bullets",
        items: [
          { en: "Use on: appliance fronts (refrigerator, dishwasher, range hood).", es: "Use en: frentes de electrodomésticos (refrigerador, lavavajillas, campana)." },
          { en: "Method: small amount on the cloth (not the appliance), wipe in the direction of the grain.", es: "Método: poca cantidad en el paño (no en el electrodoméstico), limpie en la dirección del grano." },
        ],
      },

      { type: "h", text: { en: "Microfiber Cloths — Color Code", es: "Paños de Microfibra — Código de Color" } },
      {
        type: "table",
        head: { en: ["Color", "Surface", "Why"], es: ["Color", "Superficie", "Por qué"] },
        rows: [
          { en: ["Yellow", "Kitchens, counters", "General hard-surface duty"], es: ["Amarillo", "Cocinas, mostradores", "Superficies generales"] },
          { en: ["Blue", "Glass, mirrors", "No residue from soap or grease"], es: ["Azul", "Vidrio, espejos", "Sin residuos de jabón o grasa"] },
          { en: ["Green", "Bathrooms (toilets, tubs)", "Bathroom-only — never cross to kitchen"], es: ["Verde", "Baños (inodoros, tinas)", "Solo baño — nunca pasa a cocina"] },
          { en: ["White", "Dusting, polish", "Dust-only — keeps polish clean"], es: ["Blanco", "Polvo, pulido", "Solo polvo — mantiene el pulidor limpio"] },
        ],
      },

      { type: "h", text: { en: "Vacuum (Sebo or Miele)", es: "Aspiradora (Sebo o Miele)" } },
      {
        type: "bullets",
        items: [
          { en: "Use BEFORE you mop — never mop dust; you'll smear it.", es: "Use ANTES de trapear — nunca trapee polvo; se esparcirá." },
          { en: "Empty the canister between homes — full canister loses suction.", es: "Vacíe el contenedor entre hogares — un contenedor lleno pierde succión." },
          { en: "Adjust the height for the surface (carpet vs hard floor) — wrong setting damages the brush bar or the floor.", es: "Ajuste la altura según la superficie (alfombra vs piso duro) — la configuración incorrecta daña el cepillo o el piso." },
        ],
      },

      // ── NEW PRODUCTS (added 2026-05-09) ─────────────────────────────────────
      { type: "h", text: { en: "Zep Mold & Mildew Stain Remover (NEW)", es: "Removedor de Manchas de Moho Zep (NUEVO)" } },
      {
        type: "bullets",
        items: [
          { en: "Use on: tile grout, shower caulk, fiberglass tubs, vinyl shower curtains — visible mold/mildew stains.", es: "Use en: lechada de baldosa, sellador de ducha, tinas de fibra de vidrio, cortinas de vinilo — manchas visibles de moho." },
          { en: "Method: spray, let dwell 5–10 minutes (do not scrub immediately), rinse with water.", es: "Método: rocíe, deje actuar 5–10 minutos (no restriegue inmediato), enjuague con agua." },
          { en: "Ventilation: open the bathroom window or run the exhaust fan — Zep contains bleach.", es: "Ventilación: abra la ventana o encienda el extractor — Zep contiene cloro." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Bleach-based — never mix with ammonia products (Windex, some bathroom cleaners). Will release toxic fumes. Wear gloves; do not let it contact colored fabrics or carpet — it will permanently bleach them. Never spray near the client's clothing or bath mats.",
          es: "Base cloro — nunca mezcle con productos de amoníaco (Windex, algunos limpiadores). Liberará gases tóxicos. Use guantes; no permita contacto con telas o alfombras de color — las decolorará permanentemente. Nunca rocíe cerca de ropa o tapetes del cliente.",
        },
      },

      { type: "h", text: { en: "Magic Eraser (Mr. Clean) (NEW)", es: "Borrador Mágico (Mr. Clean) (NUEVO)" } },
      {
        type: "bullets",
        items: [
          { en: "Use on: scuff marks on baseboards, crayon on walls, soap scum on glass shower doors, sneaker marks on white floors.", es: "Use en: marcas en rodapiés, crayola en paredes, sarro en puertas de ducha, marcas de zapato en pisos blancos." },
          { en: "Method: wet the eraser, squeeze excess water, light pressure in small circular motions. Test in an inconspicuous spot first.", es: "Método: humedezca el borrador, exprima exceso de agua, presión ligera en pequeños círculos. Pruebe primero en un lugar discreto." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Magic Eraser is a fine abrasive — it will DULL satin or matte paint, polished stone, glossy plastic, car finishes, and stainless steel with a brushed finish. Never use on: painted walls beyond the smallest scuff, polished countertops, or anything with a sheen the client values. If the client's wall has a flat (matte) paint and you erase too aggressively, you'll leave a visibly cleaner spot — which is itself a damage claim.",
          es: "El Borrador Mágico es abrasivo fino — DAÑARÁ pintura satinada o mate, piedra pulida, plástico brillante, acabados de auto y acero inoxidable cepillado. Nunca use en: paredes pintadas (más allá de la marca más pequeña), mostradores pulidos, o cualquier cosa con brillo que el cliente valore. Si la pared tiene pintura mate y borra agresivamente, dejará una mancha visiblemente más limpia — eso también es un reclamo por daño.",
        },
      },

      { type: "h", text: { en: "Pumice Stone (NEW)", es: "Piedra Pómez (NUEVO)" } },
      {
        type: "bullets",
        items: [
          { en: "Use on: hard-water rings inside porcelain toilet bowls — and only inside the bowl.", es: "Use en: anillos de agua dura dentro de inodoros de porcelana — y solo dentro del inodoro." },
          { en: "Method: wet the stone AND the surface (never use dry — dry pumice scratches), light pressure, small motions.", es: "Método: humedezca la piedra Y la superficie (nunca seca — la piedra seca raya), presión ligera, movimientos pequeños." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Pumice will scratch every other surface in the bathroom. NEVER use on: enameled tubs, fiberglass tubs, sinks, faucets, chrome, glass, or coated toilet bowls. Coated bowls (some newer designer toilets have a ceramic coating) will scratch — if in doubt, use Bar Keepers Friend instead. Pumice is for unsealed white porcelain only.",
          es: "La piedra pómez rayará cualquier otra superficie del baño. NUNCA use en: tinas esmaltadas, tinas de fibra de vidrio, fregaderos, llaves, cromo, vidrio, o inodoros con recubrimiento. Los inodoros con recubrimiento (algunos modernos tienen capa cerámica) se rayarán — en caso de duda, use Bar Keepers Friend. La piedra pómez es solo para porcelana blanca sin sellar.",
        },
      },

      { type: "h", text: { en: "#0000 Steel Wool (NEW)", es: "Lana de Acero #0000 (NUEVO)" } },
      {
        type: "bullets",
        items: [
          { en: "Use on: stuck-on residue on glass cooktops, hardened mineral deposits on glass shower doors, light rust on cast iron.", es: "Use en: residuos pegados en estufas de vidrio, depósitos minerales endurecidos en puertas de ducha, óxido ligero en hierro fundido." },
          { en: "Grade matters: ONLY use #0000 (extra fine). Coarser grades (000, 00, 0) will scratch.", es: "El grado importa: SOLO use #0000 (extra fino). Grados más gruesos (000, 00, 0) rayarán." },
          { en: "Method: dampen with the matching cleaner (Bar Keepers Friend on glass, water on rust), light pressure, follow the surface grain when one exists.", es: "Método: humedezca con el limpiador apropiado (Bar Keepers Friend en vidrio, agua en óxido), presión ligera, siga el grano de la superficie si existe." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "NEVER on chrome — even #0000 dulls a chrome finish on first pass. Never on stainless steel appliance fronts (use the 3M polish instead). Never on coated cookware, glass shower-door film coatings, or polished marble. Always rinse thoroughly afterward — steel wool fibers left on a surface rust within hours and will stain.",
          es: "NUNCA en cromo — incluso #0000 daña el acabado cromado al primer pase. Nunca en frentes de electrodomésticos de acero (use el pulidor 3M). Nunca en utensilios con recubrimiento, recubrimientos de puertas de ducha, o mármol pulido. Siempre enjuague completamente — fibras de lana de acero dejadas en una superficie se oxidan en horas y mancharán.",
        },
      },

      // ── Step Stool ─────────────────────────────────────────────────────────
      { type: "h", text: { en: "Step Stool — Inspection Protocol", es: "Banquito — Protocolo de Inspección" } },
      {
        type: "p",
        text: {
          en: "Before EVERY use of the company step stool, run the 3-point check: rubber feet present and not worn smooth, hinges fully locked open with no wobble, top platform clean and dry. A stool with worn feet on a tile floor is a fall waiting to happen. If any check fails, do not use it; mark it for replacement and tell the office.",
          es: "Antes de CADA uso del banquito de la compañía, realice la revisión de 3 puntos: patas de goma presentes y no lisas, bisagras totalmente abiertas sin movimiento, plataforma limpia y seca. Un banquito con patas gastadas en piso de baldosa es una caída esperando suceder. Si algo falla, no lo use; márquelo para reemplazo y avise a la oficina.",
        },
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Never stand on a chair, table, counter, or any furniture in the client's home. Never stand on the top step of any ladder or stool. If you can't reach the surface safely from the company step stool, leave a note for the office and skip the surface — never improvise.",
          es: "Nunca se pare sobre una silla, mesa, mostrador, o cualquier mueble en el hogar. Nunca se pare en el escalón superior de una escalera o banquito. Si no puede alcanzar una superficie con seguridad desde el banquito, deje una nota para la oficina y omita la superficie — nunca improvise.",
        },
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. ILLINOIS SEXUAL HARASSMENT PREVENTION (annual, IL 820 ILCS 96)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "il-sexual-harassment",
    number: 6,
    iconKind: "shield",
    title: {
      en: "Sexual Harassment Prevention (Illinois)",
      es: "Prevención del Acoso Sexual (Illinois)",
    },
    subtitle: {
      en: "Mandatory annual training under the Illinois Workplace Transparency Act. Definitions, examples, reporting, and your protected rights.",
      es: "Capacitación anual obligatoria bajo la Ley de Transparencia Laboral de Illinois. Definiciones, ejemplos, reportes y sus derechos protegidos.",
    },
    estimatedMinutes: 20,
    blocks: [
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Why this matters: Illinois law (820 ILCS 96, Workplace Transparency Act) requires EVERY employer to provide sexual harassment prevention training to ALL employees once per calendar year. Phes runs this module in the LMS to meet that requirement and to keep our team safe. Take it seriously — this isn't a check-the-box exercise.",
          es: "Por qué importa: la ley de Illinois (820 ILCS 96, Ley de Transparencia Laboral) requiere que TODO empleador brinde capacitación de prevención del acoso sexual a TODOS los empleados una vez por año calendario. Phes ejecuta este módulo en el LMS para cumplir con ese requisito y mantener seguro a nuestro equipo. Tómelo en serio — no es solo marcar una casilla.",
        },
      },

      // ── What is sexual harassment ─────────────────────────────────────────
      { type: "h", text: { en: "What Is Sexual Harassment?", es: "¿Qué Es el Acoso Sexual?" } },
      {
        type: "p",
        text: {
          en: "The Illinois Human Rights Act defines sexual harassment as: any unwelcome sexual advance, request for sexual favor, or other verbal or physical conduct of a sexual nature when (1) submission is made an explicit or implicit condition of employment, (2) submission or rejection is used as the basis for an employment decision, OR (3) the conduct has the purpose or effect of substantially interfering with a person's work or creating an intimidating, hostile, or offensive working environment.",
          es: "La Ley de Derechos Humanos de Illinois define el acoso sexual como: cualquier insinuación sexual no deseada, solicitud de favores sexuales, u otra conducta verbal o física de naturaleza sexual cuando (1) la sumisión se convierte en condición explícita o implícita del empleo, (2) la sumisión o el rechazo se usan como base para una decisión laboral, O (3) la conducta tiene el propósito o efecto de interferir sustancialmente con el trabajo de una persona o crear un ambiente de trabajo intimidante, hostil u ofensivo.",
        },
      },

      { type: "h", text: { en: "Two Forms Recognized by Law", es: "Dos Formas Reconocidas por la Ley" } },
      {
        type: "bullets",
        items: [
          { en: "QUID PRO QUO ('this for that'): a supervisor or anyone with authority over your schedule, pay, or job conditions makes a sexual advance or request a condition of any employment decision — hire, fire, promotion, route assignment, pay raise, schedule change.", es: "QUID PRO QUO ('esto por aquello'): un supervisor o cualquier persona con autoridad sobre su horario, pago o condiciones laborales hace una insinuación o solicitud sexual como condición para una decisión laboral — contratar, despedir, promover, asignar ruta, aumento, cambio de horario." },
          { en: "HOSTILE WORK ENVIRONMENT: unwelcome conduct of a sexual nature is severe or pervasive enough that a reasonable person would find the workplace intimidating, hostile, or offensive. Can be by ANYONE — supervisor, coworker, client, vendor — and Phes is still responsible for stopping it.", es: "AMBIENTE LABORAL HOSTIL: conducta sexual no deseada lo suficientemente severa o generalizada como para que una persona razonable consideraría el lugar de trabajo intimidante, hostil u ofensivo. Puede ser por CUALQUIERA — supervisor, compañero, cliente, vendedor — y Phes sigue siendo responsable de detenerlo." },
        ],
      },

      // ── Examples ──────────────────────────────────────────────────────────
      { type: "h", text: { en: "Examples of Unlawful Conduct", es: "Ejemplos de Conducta Ilegal" } },
      {
        type: "bullets",
        items: [
          { en: "Unwelcome touching, hugging, kissing, brushing up against someone, or blocking their path.", es: "Tocamiento, abrazo, beso, rozarse o bloquear el paso de alguien sin su consentimiento." },
          { en: "Sexual jokes, comments, slurs, or gestures — including 'just kidding' framing.", es: "Bromas, comentarios, insultos o gestos sexuales — incluyendo cuando se enmarca como 'solo broma'." },
          { en: "Comments about a coworker's body, clothing, or sexual orientation.", es: "Comentarios sobre el cuerpo, la ropa o la orientación sexual de un compañero." },
          { en: "Sharing or displaying sexual images, memes, videos, GIFs (including via text or WhatsApp work threads).", es: "Compartir o mostrar imágenes, memes, videos o GIFs sexuales (incluyendo por mensaje de texto o hilos de WhatsApp del trabajo)." },
          { en: "Repeated requests for dates after a clear 'no'.", es: "Solicitudes repetidas para salir después de un 'no' claro." },
          { en: "Spreading sexual rumors about a coworker or client.", es: "Difundir rumores sexuales sobre un compañero o cliente." },
          { en: "Quid-pro-quo offers ('better routes if you go out with me').", es: "Ofertas de quid pro quo ('mejores rutas si sales conmigo')." },
          { en: "Stalking — at work, online, or off-hours related to work.", es: "Acoso persistente — en el trabajo, en línea o fuera de horario laboral relacionado con el trabajo." },
        ],
      },

      { type: "h", text: { en: "Important — Not Limited to Opposite-Sex Conduct", es: "Importante — No Está Limitado a Conducta Entre Sexos Opuestos" } },
      {
        type: "p",
        text: {
          en: "Sexual harassment can happen between any combination of people: man-to-woman, woman-to-man, same-sex, between non-binary and binary people, etc. It is also unlawful to harass someone because of their gender identity, gender expression, or sexual orientation. Illinois law protects all of these categories.",
          es: "El acoso sexual puede ocurrir entre cualquier combinación de personas: hombre a mujer, mujer a hombre, del mismo sexo, entre personas no binarias y binarias, etc. También es ilegal acosar a alguien por su identidad de género, expresión de género u orientación sexual. La ley de Illinois protege todas estas categorías.",
        },
      },

      // ── Third parties (clients, vendors) ──────────────────────────────────
      { type: "h", text: { en: "Clients and Third Parties Count Too", es: "Los Clientes y Terceros También Cuentan" } },
      {
        type: "p",
        text: {
          en: "If a client, contractor, or vendor harasses you while you're working — at a home, on a route, in our shop — that is still sexual harassment, and Phes is required by law to investigate and act. You are NEVER expected to tolerate harassment because 'the client is important.' Leave the property if you feel unsafe, then call the office team immediately.",
          es: "Si un cliente, contratista o vendedor lo acosa mientras trabaja — en una casa, en una ruta, en nuestra oficina — eso sigue siendo acoso sexual, y Phes está obligado por ley a investigar y actuar. NUNCA se espera que tolere acoso porque 'el cliente es importante.' Salga de la propiedad si se siente inseguro, luego llame a el equipo de la oficina inmediatamente.",
        },
      },

      // ── How to report ─────────────────────────────────────────────────────
      { type: "h", text: { en: "How To Report — Multiple Channels", es: "Cómo Reportar — Múltiples Canales" } },
      {
        type: "bullets",
        items: [
          { en: "INTERNAL — Tell the office team at the office directly (text, call, or in person). They will document the report and start an investigation within a reasonable timeframe.", es: "INTERNO — Hable directamente con el equipo de la oficina en la oficina (mensaje, llamada o en persona). Documentarán el reporte e iniciarán una investigación en un plazo razonable." },
          { en: "INTERNAL ALTERNATIVE — If your concern involves the office team, report directly to the company owner. Use any channel: email, text, in person. No retaliation.", es: "ALTERNATIVA INTERNA — Si su preocupación involucra a el equipo de la oficina, reporte directamente a el propietario de la empresa. Use cualquier canal: correo, mensaje, en persona. Sin represalias." },
          { en: "EXTERNAL — Illinois Department of Human Rights (IDHR). 300 days from the incident to file a charge under Illinois law. Web: dhr.illinois.gov.", es: "EXTERNO — Departamento de Derechos Humanos de Illinois (IDHR). 300 días desde el incidente para presentar un cargo bajo la ley de Illinois. Web: dhr.illinois.gov." },
          { en: "EXTERNAL — U.S. Equal Employment Opportunity Commission (EEOC). 300 days from the incident in Illinois (Illinois is a deferral state). Web: eeoc.gov.", es: "EXTERNO — Comisión de Igualdad de Oportunidades en el Empleo de EE.UU. (EEOC). 300 días desde el incidente en Illinois (Illinois es un estado con derechos diferidos). Web: eeoc.gov." },
        ],
      },

      // ── Retaliation prohibition ───────────────────────────────────────────
      { type: "h", text: { en: "Retaliation Is Illegal", es: "Las Represalias Son Ilegales" } },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Federal and Illinois law strictly prohibit retaliation against anyone who reports sexual harassment in good faith, participates in an investigation, or refuses to engage in conduct they believe is unlawful. Retaliation includes firing, demotion, route changes, pay cuts, exclusion from team activities, hostile treatment, or threats. If you experience retaliation, that is itself an additional violation you can report.",
          es: "La ley federal y de Illinois prohíben estrictamente las represalias contra cualquier persona que reporte acoso sexual de buena fe, participe en una investigación o se niegue a participar en conducta que crea ilegal. Las represalias incluyen despido, descenso, cambios de ruta, recortes de pago, exclusión de actividades del equipo, trato hostil o amenazas. Si experimenta represalias, eso es en sí mismo otra violación que puede reportar.",
        },
      },
      {
        type: "p",
        text: {
          en: "GOOD FAITH means you believed your report was true at the time you made it. If after investigation the conduct is not substantiated, you are STILL protected — the act of reporting in good faith is protected, regardless of the outcome.",
          es: "BUENA FE significa que creyó que su reporte era verdadero al momento de hacerlo. Si después de la investigación la conducta no se comprueba, USTED SIGUE protegido — el acto de reportar de buena fe está protegido, sin importar el resultado.",
        },
      },

      // ── Bystander expectations ────────────────────────────────────────────
      { type: "h", text: { en: "If You See or Hear Something", es: "Si Ve o Escucha Algo" } },
      {
        type: "p",
        text: {
          en: "You don't have to be the target to report. If you see or hear another tech, the office, a client, or anyone behaving in a way that fits the descriptions above, you can — and should — report it to the office team or the company owner. Bystander reports are taken just as seriously as direct reports, and the same retaliation protections apply.",
          es: "No tiene que ser el objetivo para reportar. Si ve o escucha a otro técnico, a la oficina, a un cliente, o a cualquier persona comportándose de manera que coincida con las descripciones anteriores, puede — y debe — reportarlo a el equipo de la oficina o el propietario. Los reportes de testigos se toman con la misma seriedad que los reportes directos, y aplican las mismas protecciones contra represalias.",
        },
      },

      // ── Investigation process ─────────────────────────────────────────────
      { type: "h", text: { en: "What Happens After You Report", es: "Qué Sucede Después de Reportar" } },
      {
        type: "bullets",
        items: [
          { en: "The office documents your report and timeline immediately.", es: "La oficina documenta su reporte y cronología inmediatamente." },
          { en: "An investigation begins promptly — typically within 1–2 business days.", es: "Una investigación comienza rápidamente — típicamente dentro de 1–2 días laborales." },
          { en: "We talk to relevant parties separately. We do not put you in a room with the person you reported.", es: "Hablamos con las partes relevantes por separado. No lo ponemos en una sala con la persona que reportó." },
          { en: "Confidentiality is preserved as much as legally possible. We only share information with people who must know to investigate or fix the problem.", es: "Se mantiene confidencialidad tanto como sea legalmente posible. Solo compartimos información con personas que deben saber para investigar o resolver el problema." },
          { en: "If the conduct is substantiated, Phes takes corrective action — up to and including termination of the harasser. Schedules, routes, or other conditions may be adjusted to keep you safe during the investigation, never as a penalty to you.", es: "Si la conducta se comprueba, Phes toma medidas correctivas — hasta e incluyendo el despido del acosador. Los horarios, rutas u otras condiciones pueden ajustarse para mantenerlo seguro durante la investigación, nunca como penalidad contra usted." },
          { en: "You are notified of the outcome. You can escalate to IDHR or EEOC if you disagree with how Phes handled it.", es: "Se le notifica el resultado. Puede escalar a IDHR o EEOC si no está de acuerdo con cómo Phes lo manejó." },
        ],
      },

      // ── Annual training ───────────────────────────────────────────────────
      { type: "h", text: { en: "Annual Training Requirement", es: "Requisito de Capacitación Anual" } },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Illinois law requires every employee to complete sexual harassment prevention training every CALENDAR YEAR. Phes refreshes this module each January and the office will re-enroll you so you can complete it. You'll see a fresh quiz; reading the content again is required so the policy stays current in your head. We document completion as part of compliance recordkeeping.",
          es: "La ley de Illinois requiere que cada empleado complete capacitación de prevención del acoso sexual cada AÑO CALENDARIO. Phes actualiza este módulo cada enero y la oficina lo re-inscribirá para que pueda completarlo. Verá un examen nuevo; leer el contenido nuevamente es obligatorio para que la política se mantenga fresca en su memoria. Documentamos la completación como parte del registro de cumplimiento.",
        },
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. DRUG & ALCOHOL POLICY (Phase 3, PR #4)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Required by Illinois Cannabis Regulation & Tax Act (410 ILCS 705) and
  // the Illinois Right to Privacy in the Workplace Act (820 ILCS 55).
  // Quiz verifies comprehension; the legally binding signed acknowledgment
  // is captured via the separate lms_signed_documents flow at document_type
  // 'drug_alcohol' (PR #4 of 16).
  {
    id: "drug-alcohol",
    number: 7,
    iconKind: "shield",
    title: {
      en: "Drug & Alcohol Policy",
      es: "Política de Drogas y Alcohol",
    },
    subtitle: {
      en: "What we test for and when. Cannabis is legal off-duty in Illinois. Impairment at work never is.",
      es: "Qué probamos y cuándo. El cannabis es legal fuera del trabajo en Illinois. La intoxicación en el trabajo nunca lo es.",
    },
    estimatedMinutes: 12,
    blocks: [
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Why this module matters. Cleaning involves driving company routes, handling chemicals around clients' children and pets, climbing ladders, and entering homes you've been trusted to enter. Impairment in any of those situations puts people in danger. This policy explains what counts as impairment, when Phes may test you, what your rights are if you take prescription medication, and what happens if you refuse a test. You will sign a separate acknowledgment after the quiz that records your consent to this policy.",
          es: "Por qué importa este módulo. La limpieza implica conducir rutas de la compañía, manejar productos químicos cerca de niños y mascotas de los clientes, subir escaleras y entrar a hogares en los que se le ha confiado. La intoxicación en cualquiera de esas situaciones pone a personas en peligro. Esta política explica qué cuenta como intoxicación, cuándo Phes puede examinarlo, cuáles son sus derechos si toma medicamentos recetados y qué ocurre si se rehúsa a una prueba. Firmará un reconocimiento separado después del examen que registra su consentimiento a esta política.",
        },
      },

      { type: "h", text: { en: "No Pre-Employment Testing", es: "Sin Pruebas Antes del Empleo" } },
      {
        type: "p",
        text: {
          en: "Phes does NOT require pre-employment drug testing. You will not be asked to submit to a drug test as a condition of being hired. This is Phes policy. It is stricter than the law requires.",
          es: "Phes NO exige pruebas de drogas antes del empleo. No se le pedirá someterse a una prueba de drogas como condición para ser contratado. Esta es la política de Phes. Es más estricta de lo que la ley requiere.",
        },
      },

      { type: "h", text: { en: "What You Cannot Do at Work", es: "Lo Que No Puede Hacer en el Trabajo" } },
      {
        type: "bullets",
        items: [
          { en: "Work while impaired by alcohol.", es: "Trabajar bajo los efectos del alcohol." },
          { en: "Work while impaired by illegal drugs.", es: "Trabajar bajo los efectos de drogas ilegales." },
          { en: "Work while impaired by cannabis (regardless of whether you obtained it legally off-duty).", es: "Trabajar bajo los efectos del cannabis (sin importar si lo obtuvo legalmente fuera del trabajo)." },
          { en: "Work while impaired by ANY other substance that affects your ability to perform safely (over-the-counter sleep aids that make you drowsy, prescription medications with sedating side effects, etc.).", es: "Trabajar bajo los efectos de CUALQUIER otra sustancia que afecte su capacidad de desempeñarse con seguridad (medicamentos de venta libre para dormir que causan somnolencia, recetas con efectos sedantes, etc.)." },
          { en: "Possess open alcohol containers, illegal drugs, or any controlled substance not legally prescribed to YOU on Phes premises, in Phes vehicles, or on client property.", es: "Poseer envases abiertos de alcohol, drogas ilegales o cualquier sustancia controlada que no le haya sido recetada legalmente a USTED en las instalaciones de Phes, en vehículos de Phes o en la propiedad del cliente." },
        ],
      },

      { type: "h", text: { en: "Cannabis Specifically (Illinois Law)", es: "Cannabis Específicamente (Ley de Illinois)" } },
      {
        type: "p",
        text: {
          en: "Cannabis is legal for adults 21 and over in Illinois. Phes does NOT discipline you for using cannabis legally on your own time. You have the same right to lawful off-duty cannabis use that you have for alcohol or any other legal off-duty activity.",
          es: "El cannabis es legal para adultos mayores de 21 años en Illinois. Phes NO disciplina por usar cannabis legalmente en su tiempo libre. Tiene el mismo derecho al uso legal fuera del trabajo de cannabis que tiene para el alcohol o cualquier otra actividad legal fuera del trabajo.",
        },
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "But: impairment AT WORK is different from off-duty use. If you arrive at work or show up to a client home showing observable signs of impairment, the policy applies regardless of when or where you consumed. This is true for cannabis, alcohol, prescription sedatives, and any other substance.",
          es: "Pero: la intoxicación EN EL TRABAJO es distinta del uso fuera del trabajo. Si llega al trabajo o se presenta en un hogar de un cliente mostrando signos observables de intoxicación, la política aplica sin importar cuándo o dónde consumió. Esto es cierto para cannabis, alcohol, sedantes recetados y cualquier otra sustancia.",
        },
      },

      { type: "h", text: { en: "Observable Signs of Impairment", es: "Signos Observables de Intoxicación" } },
      {
        type: "p",
        text: {
          en: "Phes only acts on OBSERVABLE signs of impairment. We do not guess; we do not assume; we document what we see. Signs that may indicate impairment include:",
          es: "Phes solo actúa sobre signos OBSERVABLES de intoxicación. No suponemos; no asumimos; documentamos lo que vemos. Los signos que pueden indicar intoxicación incluyen:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Bloodshot or glassy eyes.", es: "Ojos rojos o vidriosos." },
          { en: "Slurred speech or unusually rapid or pressured speech.", es: "Habla arrastrada o anormalmente rápida o presionada." },
          { en: "Smell of alcohol or cannabis on breath or clothes.", es: "Olor a alcohol o cannabis en aliento o ropa." },
          { en: "Unsteady walking, swaying, stumbling.", es: "Caminar inestable, balancearse, tropezarse." },
          { en: "Slowed reaction time, inability to follow simple instructions, difficulty maintaining a conversation.", es: "Tiempo de reacción lento, incapacidad para seguir instrucciones simples, dificultad para mantener una conversación." },
          { en: "Dilated or constricted pupils unrelated to the lighting in the room.", es: "Pupilas dilatadas o contraídas no relacionadas con la iluminación del lugar." },
          { en: "Inability to perform routine work tasks the employee normally performs without difficulty.", es: "Incapacidad para realizar tareas laborales rutinarias que el empleado normalmente realiza sin dificultad." },
          { en: "Falling asleep or appearing to nod off on the job.", es: "Quedarse dormido o aparentar cabecear en el trabajo." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "What is NOT a sign of impairment, by itself: a positive cannabis drug test alone (THC remains detectable in urine days or weeks after use). Phes does not act on a drug test alone. We act on observable behavior in the moment, documented by a supervisor.",
          es: "Lo que NO es un signo de intoxicación, por sí mismo: una prueba de cannabis positiva sola (el THC sigue siendo detectable en orina días o semanas después del uso). Phes no actúa solo con base en una prueba de drogas. Actuamos sobre la conducta observable en el momento, documentada por un supervisor.",
        },
      },

      { type: "h", text: { en: "Reasonable Suspicion Testing", es: "Pruebas por Sospecha Razonable" } },
      {
        type: "bullets",
        items: [
          { en: "If a supervisor observes the signs above, they DOCUMENT what they saw, the date and time, and who else was present.", es: "Si un supervisor observa los signos anteriores, DOCUMENTA lo que vio, la fecha y hora, y quién más estaba presente." },
          { en: "The decision to send the employee for testing is made by the OFFICE (not by coworkers, not by clients).", es: "La decisión de enviar al empleado a una prueba la toma la OFICINA (no los compañeros de trabajo, no los clientes)." },
          { en: "The employee is removed from the job site immediately and sent for testing (urine, saliva, or breath, depending on the substance suspected).", es: "El empleado es retirado del lugar de trabajo inmediatamente y enviado a hacerse la prueba (orina, saliva o aliento, dependiendo de la sustancia sospechada)." },
          { en: "Phes pays for the test and pays the employee's regular wages for the time spent being tested.", es: "Phes paga la prueba y paga el salario regular del empleado por el tiempo dedicado a la prueba." },
          { en: "If the test is positive AND observable signs were documented at the time, the discipline scale below applies.", es: "Si la prueba es positiva Y se documentaron signos observables en el momento, aplica la escala de disciplina a continuación." },
          { en: "If the test is negative, no record of the incident appears in the employee's personnel file other than the time worked and paid.", es: "Si la prueba es negativa, no aparece registro del incidente en el archivo del empleado más allá del tiempo trabajado y pagado." },
        ],
      },

      { type: "h", text: { en: "Post-Accident Testing", es: "Pruebas Después de un Accidente" } },
      {
        type: "p",
        text: {
          en: "After any workplace accident that results in (a) physical injury to anyone (employee, client, third party) OR (b) property damage of $500 or more, the involved employee is required to submit to a drug and alcohol test. This is a routine workplace safety measure and is not a presumption of fault. Phes pays for the test and pays the employee's regular wages for the time spent.",
          es: "Después de cualquier accidente laboral que resulte en (a) lesión física a alguien (empleado, cliente, tercero) O (b) daño a propiedad de $500 o más, el empleado involucrado debe someterse a una prueba de drogas y alcohol. Esta es una medida rutinaria de seguridad laboral y no es una presunción de culpa. Phes paga la prueba y paga el salario regular del empleado por el tiempo dedicado.",
        },
      },

      { type: "h", text: { en: "Prescription Medication Accommodation", es: "Acomodación de Medicamentos Recetados" } },
      {
        type: "bullets",
        items: [
          { en: "Employees may take any LEGALLY PRESCRIBED medication. Phes does not ask you to disclose what the medication is or what condition you're treating.", es: "Los empleados pueden tomar cualquier medicamento RECETADO LEGALMENTE. Phes no le pide divulgar cuál es el medicamento ni qué condición está tratando." },
          { en: "If a prescription medication you take has side effects that may impair your ability to perform safely (drowsiness, slowed reaction, etc.), inform the office BEFORE starting the medication so we can discuss accommodation.", es: "Si un medicamento recetado que toma tiene efectos secundarios que pueden afectar su capacidad de desempeñarse con seguridad (somnolencia, reacción lenta, etc.), informe a la oficina ANTES de empezar el medicamento para que podamos discutir acomodación." },
          { en: "You are NOT required to disclose the diagnosis or the medication name. You only need to identify whether you can perform the essential functions of your role safely.", es: "NO está obligado a divulgar el diagnóstico ni el nombre del medicamento. Solo necesita identificar si puede realizar las funciones esenciales de su rol con seguridad." },
          { en: "Reasonable accommodation may include schedule changes, modified duties, or short-term reassignment.", es: "La acomodación razonable puede incluir cambios de horario, tareas modificadas o reasignación a corto plazo." },
        ],
      },

      { type: "h", text: { en: "Refusal to Test", es: "Negarse a la Prueba" } },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "REFUSAL TO TEST when properly requested by the office (reasonable suspicion or post-accident) is grounds for IMMEDIATE TERMINATION. There is no negotiation. The refusal itself is treated the same as a positive test result, regardless of whether you would have actually tested positive.",
          es: "NEGARSE A LA PRUEBA cuando la oficina la solicita apropiadamente (sospecha razonable o post-accidente) es motivo de TERMINACIÓN INMEDIATA. No hay negociación. La negativa en sí se trata igual que un resultado positivo, sin importar si efectivamente habría dado positivo.",
        },
      },

      { type: "h", text: { en: "Discipline Scale", es: "Escala de Disciplina" } },
      {
        type: "table",
        head: { en: ["Incident", "Action"], es: ["Incidente", "Acción"] },
        rows: [
          { en: ["1st positive test (observable signs documented)", "Final written warning. Last-chance agreement signed. EAP referral offered."],
            es: ["1ª prueba positiva (con signos documentados)", "Advertencia final por escrito. Acuerdo de última oportunidad firmado. Referencia a EAP ofrecida."] },
          { en: ["2nd positive test in any 12-month period", "Termination."],
            es: ["2ª prueba positiva en cualquier periodo de 12 meses", "Terminación."] },
          { en: ["Refusal to test", "Immediate termination."],
            es: ["Negarse a la prueba", "Terminación inmediata."] },
          { en: ["Possession of alcohol or illegal drugs on Phes property or in a Phes vehicle", "Immediate termination."],
            es: ["Posesión de alcohol o drogas ilegales en propiedad de Phes o en vehículo de Phes", "Terminación inmediata."] },
          { en: ["Driving a Phes-related route while impaired", "Immediate termination plus law-enforcement referral when applicable."],
            es: ["Conducir una ruta relacionada con Phes bajo intoxicación", "Terminación inmediata más referencia a las autoridades cuando corresponda."] },
        ],
      },

      { type: "h", text: { en: "Driving Violations Reporting (Personal Vehicles)", es: "Reporte de Infracciones de Conducir (Vehículos Personales)" } },
      {
        type: "p",
        text: {
          en: "If you use your PERSONAL vehicle for any Phes work (driving between client jobs, transporting Phes supplies, picking up a teammate), you MUST report the following to the office WITHIN 72 HOURS:",
          es: "Si usa su vehículo PERSONAL para cualquier trabajo de Phes (manejar entre trabajos de clientes, transportar suministros de Phes, recoger a un compañero), DEBE reportar lo siguiente a la oficina DENTRO DE 72 HORAS:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Any DUI conviction (Driving Under the Influence).", es: "Cualquier condena por DUI (Conducir Bajo los Efectos)." },
          { en: "Any driver's license suspension or revocation.", es: "Cualquier suspensión o revocación de la licencia de conducir." },
          { en: "Any major moving violation (reckless driving, leaving the scene of an accident, driving without insurance, driving with a suspended license).", es: "Cualquier infracción mayor de tránsito (conducción imprudente, abandonar el lugar de un accidente, conducir sin seguro, conducir con licencia suspendida)." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Failure to disclose any of the above within 72 hours of the conviction, suspension, or citation may result in immediate termination. This is a safety policy. Phes carries non-owned auto insurance that depends on your status as a lawfully-licensed driver.",
          es: "No divulgar cualquiera de lo anterior dentro de 72 horas de la condena, suspensión o citación puede resultar en terminación inmediata. Esta es una política de seguridad. Phes tiene seguro automotor no propio que depende de su estado como conductor legalmente licenciado.",
        },
      },

      { type: "h", text: { en: "Employee Assistance Program (EAP)", es: "Programa de Asistencia al Empleado (EAP)" } },
      {
        type: "p",
        text: {
          en: "Phes participates in an Employee Assistance Program that provides confidential support for substance use, mental health, and other personal concerns. The office will give you the contact information for the EAP when you join. Using the EAP is voluntary, confidential, and does NOT trigger any discipline. We encourage you to use it BEFORE a workplace incident, not after.",
          es: "Phes participa en un Programa de Asistencia al Empleado que provee apoyo confidencial para uso de sustancias, salud mental y otras preocupaciones personales. La oficina le dará la información de contacto del EAP cuando se incorpore. Usar el EAP es voluntario, confidencial y NO activa ninguna disciplina. Le animamos a usarlo ANTES de un incidente laboral, no después.",
        },
      },

      {
        type: "callout",
        tone: "info",
        text: {
          en: "After this quiz: you will sign a separate Drug & Alcohol Policy Acknowledgment that records your consent. The signed acknowledgment is a separate legal document tied to your employment, captured with your IP, device, and a hash of the exact policy text. You can re-download the signed PDF anytime from your training page.",
          es: "Después de este examen: firmará un Reconocimiento de la Política de Drogas y Alcohol por separado que registra su consentimiento. El reconocimiento firmado es un documento legal separado vinculado a su empleo, capturado con su IP, dispositivo y un hash del texto exacto de la política. Puede volver a descargar el PDF firmado en cualquier momento desde su página de capacitación.",
        },
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. CODE OF CONDUCT (Phase 4, PR #5)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Phes core-values + behavioral expectations module. Quiz verifies
  // comprehension; the legally binding signed acknowledgment lives in
  // lms_signed_documents at document_type 'code_of_conduct' (PR #5 of 16).
  //
  // The Code of Conduct overlaps several other modules by design:
  //   - Anti-harassment cross-references il-sexual-harassment (module 6)
  //   - Confidentiality cross-references the future video-photo release
  //   - Conflict of interest previews the non-solicitation agreement
  // Each module covers its area in depth; the Code of Conduct is the
  // top-level promise to follow ALL of them.
  {
    id: "code-of-conduct",
    number: 8,
    iconKind: "shield",
    title: {
      en: "Code of Conduct",
      es: "Código de Conducta",
    },
    subtitle: {
      en: "Honesty, respect, and trust in client homes. Every Phes employee signs this.",
      es: "Honestidad, respeto y confianza en los hogares de clientes. Todo empleado de Phes lo firma.",
    },
    estimatedMinutes: 10,
    blocks: [
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Why this module matters. Phes employees enter private homes. Clients trust you with their keys, alarm codes, valuables, children, and pets. That trust is the only thing that lets Phes operate. This module describes the conduct every Phes employee commits to, and the very small number of behaviors that result in immediate termination. You will sign a separate acknowledgment after the quiz that records your commitment to this code.",
          es: "Por qué importa este módulo. Los empleados de Phes entran a hogares privados. Los clientes les confían sus llaves, códigos de alarma, objetos de valor, hijos y mascotas. Esa confianza es lo único que permite que Phes opere. Este módulo describe la conducta a la que se compromete todo empleado de Phes y el muy pequeño número de comportamientos que resultan en terminación inmediata. Firmará un reconocimiento separado después del examen que registra su compromiso con este código.",
        },
      },

      { type: "h", text: { en: "Honesty and Integrity", es: "Honestidad e Integridad" } },
      {
        type: "p",
        text: {
          en: "Phes operates on honest reporting. The numbers we send to clients and the numbers we record in payroll have to match what actually happened. Concretely:",
          es: "Phes opera sobre el reporte honesto. Los números que enviamos a los clientes y los que registramos en nómina deben coincidir con lo que realmente ocurrió. En concreto:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Clock in only when you arrive at the job. Clock out only when you leave. Do not pre-clock or back-clock.", es: "Marque entrada solo cuando llegue al trabajo. Marque salida solo cuando se vaya. No marque antes ni atrás." },
          { en: "Mark a task complete only when you actually performed it. If you skipped a room or a checklist item, say so on the Worksheet so the office can communicate with the client.", es: "Marque una tarea como completada solo cuando realmente la haya realizado. Si se saltó una habitación o un elemento de la lista, indíquelo en la Hoja de Trabajo para que la oficina pueda comunicarse con el cliente." },
          { en: "Report damage you caused or witnessed before you leave the job site. Phes can resolve almost any honest mistake. We cannot resolve a hidden one.", es: "Reporte cualquier daño que haya causado o presenciado antes de salir del lugar. Phes puede resolver casi cualquier error honesto. No podemos resolver uno oculto." },
          { en: "Be truthful in conversations with the office, with clients, and with coworkers. Do not embellish reasons for absence, tardiness, or job conditions.", es: "Sea veraz en las conversaciones con la oficina, los clientes y los compañeros. No exagere las razones de ausencia, tardanza o condiciones del trabajo." },
        ],
      },

      { type: "h", text: { en: "Confidentiality of Client Homes", es: "Confidencialidad de los Hogares de Clientes" } },
      {
        type: "p",
        text: {
          en: "What you see and hear inside a client's home stays inside that home. This includes everything you might come across during a clean: prescription medications on a counter, family photographs, documents on a desk, personal items, conversations you overhear, and the layout of the home itself.",
          es: "Lo que ve y escucha dentro del hogar de un cliente se queda dentro de ese hogar. Esto incluye todo lo que pueda encontrar durante una limpieza: medicamentos recetados sobre una mesa, fotografías familiares, documentos en un escritorio, objetos personales, conversaciones que escuche por casualidad y la disposición del hogar.",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Do not photograph or video a client's home for any reason other than documenting a Phes-related issue (damage, completed work, before-and-after) authorized by the office. Such photos are uploaded directly to MaidCentral and not stored on your personal device.", es: "No fotografíe ni grabe el hogar de un cliente por ningún motivo que no sea documentar un asunto relacionado con Phes (daño, trabajo terminado, antes y después) autorizado por la oficina. Esas fotos se cargan directamente a MaidCentral y no se guardan en su dispositivo personal." },
          { en: "Do not share details about a client's home with anyone outside Phes. This includes friends, family, social media, and other clients.", es: "No comparta detalles sobre el hogar de un cliente con nadie fuera de Phes. Esto incluye amigos, familiares, redes sociales y otros clientes." },
          { en: "Do not access closed rooms, locked closets, or drawers unless the Worksheet specifically lists them. Closed doors are private space.", es: "No acceda a habitaciones cerradas, armarios o cajones cerrados a menos que la Hoja de Trabajo los indique específicamente. Las puertas cerradas son espacio privado." },
          { en: "Do not look through mail, documents, or personal items. If you see something that requires Phes attention (water damage, unsafe condition), photograph only what you need to document it and notify the office.", es: "No revise correspondencia, documentos u objetos personales. Si ve algo que requiere atención de Phes (daño por agua, condición insegura), fotografíe solo lo necesario para documentarlo y notifique a la oficina." },
        ],
      },

      { type: "h", text: { en: "Zero Tolerance for Theft", es: "Cero Tolerancia al Robo" } },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Taking ANY item from a client's home that you did not bring with you, no matter how small or how unimportant it appears, is THEFT. Phes has a zero-tolerance policy. Theft results in immediate termination, a report to local law enforcement, and forfeiture of any final paycheck balance not yet earned for hours actually worked. This includes cash left on counters, coins, food and drinks from the refrigerator, partial bottles of cleaning supplies, jewelry, electronics, prescription medications, and items in trash or recycling unless the client has expressly given them to Phes.",
          es: "Tomar CUALQUIER objeto del hogar de un cliente que no haya traído consigo, sin importar lo pequeño o sin valor que parezca, es ROBO. Phes tiene política de cero tolerancia. El robo resulta en terminación inmediata, un reporte a las autoridades locales y la pérdida de cualquier saldo final del pago no devengado por horas efectivamente trabajadas. Esto incluye efectivo dejado sobre mostradores, monedas, alimentos y bebidas del refrigerador, botellas parciales de productos de limpieza, joyería, electrónicos, medicamentos recetados y artículos en basura o reciclaje a menos que el cliente los haya entregado expresamente a Phes.",
        },
      },
      {
        type: "p",
        text: {
          en: "If a client offers you food, water, or a small item, accept only what is reasonable, thank them, and note it on the Worksheet so the office is informed. If you are uncertain whether something was offered, decline politely and contact the office.",
          es: "Si un cliente le ofrece comida, agua o un objeto pequeño, acepte solo lo razonable, agradezca y anótelo en la Hoja de Trabajo para que la oficina esté informada. Si no está seguro de si algo fue ofrecido, rechácelo cortésmente y contacte a la oficina.",
        },
      },

      { type: "h", text: { en: "Respect and Anti-Harassment", es: "Respeto y Anti-Acoso" } },
      {
        type: "p",
        text: {
          en: "Every Phes employee, every client, and every person you encounter during a Phes shift is entitled to be treated with respect. Phes prohibits harassment of any kind, whether based on a protected class or not. The detailed sexual-harassment policy is in module 6 (Illinois Sexual Harassment Prevention). The Code of Conduct extends the same prohibition to all forms of harassment including verbal abuse, physical aggression, intimidation, slurs, mocking another person, and unwelcome physical contact.",
          es: "Todo empleado de Phes, todo cliente y toda persona con quien se encuentre durante un turno de Phes tiene derecho a ser tratado con respeto. Phes prohíbe el acoso de cualquier tipo, basado o no en una clase protegida. La política detallada de acoso sexual está en el módulo 6 (Prevención de Acoso Sexual en Illinois). El Código de Conducta extiende la misma prohibición a todas las formas de acoso incluyendo abuso verbal, agresión física, intimidación, insultos, burlarse de otra persona y contacto físico no deseado.",
        },
      },

      { type: "h", text: { en: "Anti-Discrimination (Illinois Human Rights Act)", es: "Anti-Discriminación (Ley de Derechos Humanos de Illinois)" } },
      {
        type: "p",
        text: {
          en: "Phes does not discriminate against any employee or applicant based on a protected class. Illinois recognizes the following protected classes under the Illinois Human Rights Act:",
          es: "Phes no discrimina contra ningún empleado o solicitante basado en una clase protegida. Illinois reconoce las siguientes clases protegidas bajo la Ley de Derechos Humanos de Illinois:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Race, color, national origin, ancestry, religion, citizenship status.", es: "Raza, color, origen nacional, ascendencia, religión, estatus de ciudadanía." },
          { en: "Sex (including pregnancy, childbirth, and related conditions), sexual orientation, gender identity.", es: "Sexo (incluyendo embarazo, parto y condiciones relacionadas), orientación sexual, identidad de género." },
          { en: "Age (40 and over), marital status, parental status, military status, order of protection status.", es: "Edad (40 años o más), estado civil, estado parental, estatus militar, estatus de orden de protección." },
          { en: "Physical or mental disability, including pregnancy-related disability.", es: "Discapacidad física o mental, incluyendo discapacidad relacionada con el embarazo." },
          { en: "Arrest record, conviction record (in most circumstances), and other categories protected by state or federal law.", es: "Antecedentes de arresto, antecedentes de condena (en la mayoría de las circunstancias) y otras categorías protegidas por la ley estatal o federal." },
        ],
      },
      {
        type: "p",
        text: {
          en: "Discrimination includes treating someone less favorably because of a protected class, in hiring, scheduling, pay, discipline, training, or any other term or condition of employment. It also includes failing to provide reasonable accommodation when accommodation is required by law (disability, pregnancy, religious observance, lactation, domestic violence leave).",
          es: "La discriminación incluye tratar a alguien menos favorablemente debido a una clase protegida, en contratación, programación, pago, disciplina, capacitación o cualquier otro término o condición de empleo. También incluye no proveer acomodación razonable cuando la acomodación es requerida por ley (discapacidad, embarazo, observancia religiosa, lactancia, licencia por violencia doméstica).",
        },
      },

      { type: "h", text: { en: "Anti-Retaliation (Good-Faith Reporting Is Protected)", es: "Anti-Represalias (El Reporte de Buena Fe Está Protegido)" } },
      {
        type: "p",
        text: {
          en: "If you report a Code of Conduct violation, a safety concern, harassment, discrimination, or any other unlawful or unethical conduct IN GOOD FAITH, Phes will not retaliate against you. This protection applies whether or not the investigation ultimately substantiates the report. Good faith means you genuinely believed your report was true at the time you made it.",
          es: "Si reporta una violación del Código de Conducta, una preocupación de seguridad, acoso, discriminación o cualquier otra conducta ilegal o no ética DE BUENA FE, Phes no tomará represalias en su contra. Esta protección aplica sin importar si la investigación finalmente confirma el reporte. Buena fe significa que realmente creyó que su reporte era verdadero al momento de hacerlo.",
        },
      },
      {
        type: "p",
        text: {
          en: "Retaliation includes termination, demotion, reduced hours, schedule changes used as punishment, exclusion from training, hostile treatment, or any other adverse employment action taken because someone made a good-faith report.",
          es: "Las represalias incluyen terminación, degradación, reducción de horas, cambios de horario usados como castigo, exclusión de capacitación, trato hostil o cualquier otra acción laboral adversa tomada porque alguien hizo un reporte de buena fe.",
        },
      },

      { type: "h", text: { en: "Conflict of Interest", es: "Conflicto de Interés" } },
      {
        type: "p",
        text: {
          en: "Phes hires you to clean Phes clients on Phes schedules using Phes systems. You may not solicit Phes clients for personal cleaning work, side work, or any other paid service either during your employment or while a non-solicitation agreement is in effect. The full details of the non-solicitation obligation are in the signed Non-Solicitation Agreement (PR #7). The Code of Conduct asks you to keep your work for Phes clients on Phes time, billed through Phes.",
          es: "Phes lo contrata para limpiar a clientes de Phes en horarios de Phes usando sistemas de Phes. No puede solicitar a clientes de Phes para trabajo de limpieza personal, trabajo paralelo o cualquier otro servicio pagado, ya sea durante su empleo o mientras un acuerdo de no solicitación esté vigente. Los detalles completos de la obligación de no solicitación están en el Acuerdo de No Solicitación firmado (PR #7). El Código de Conducta le pide que mantenga su trabajo para clientes de Phes en tiempo de Phes, facturado a través de Phes.",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Do not give clients your personal phone number or invite them to contact you outside the Phes channel.", es: "No dé a los clientes su número personal ni los invite a contactarlo fuera del canal de Phes." },
          { en: "Do not accept cash from a client to clean for them outside of the Phes appointment.", es: "No acepte efectivo de un cliente para limpiar fuera de la cita de Phes." },
          { en: "If a client asks for cleaning services outside the Phes schedule, refer them to the office and let the office book it.", es: "Si un cliente pide servicios de limpieza fuera del horario de Phes, refiéralo a la oficina y deje que la oficina lo programe." },
        ],
      },

      { type: "h", text: { en: "Keys, Alarm Codes, and Property", es: "Llaves, Códigos de Alarma y Propiedad" } },
      {
        type: "bullets",
        items: [
          { en: "Treat client keys and lockbox codes as Phes property. You are not authorized to copy a key, share a code, or take a key home.", es: "Trate las llaves de clientes y códigos de cajas con llave como propiedad de Phes. No está autorizado para copiar una llave, compartir un código o llevarse una llave a casa." },
          { en: "Return keys and codes to the office at the end of every shift, or per the office's logged procedure for repeat-visit clients.", es: "Devuelva las llaves y códigos a la oficina al final de cada turno, o según el procedimiento registrado de la oficina para clientes de visita recurrente." },
          { en: "Report a lost or misplaced key to the office IMMEDIATELY. Lost keys are not grounds for discipline by themselves; covering up a lost key is.", es: "Reporte una llave perdida o extraviada a la oficina INMEDIATAMENTE. Una llave perdida por sí sola no es motivo de disciplina; ocultar una llave perdida sí lo es." },
          { en: "Do not lend the Phes vehicle, your assigned tools, or Phes supplies to anyone outside Phes.", es: "No preste el vehículo de Phes, sus herramientas asignadas ni los suministros de Phes a nadie fuera de Phes." },
        ],
      },

      { type: "h", text: { en: "How to Report a Concern", es: "Cómo Reportar una Inquietud" } },
      {
        type: "p",
        text: {
          en: "If you witness or experience a Code of Conduct violation, you have several reporting paths. You can pick whichever you are most comfortable with.",
          es: "Si presencia o experimenta una violación del Código de Conducta, tiene varias vías para reportar. Puede elegir la que le resulte más cómoda.",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "The office team. Call or text the office at any time during business hours. Outside business hours, leave a message and the office will return your call the next business day.", es: "El equipo de la oficina. Llame o envíe mensaje a la oficina en cualquier momento durante horas hábiles. Fuera de horas hábiles, deje un mensaje y la oficina le devolverá la llamada el siguiente día hábil." },
          { en: "The owner directly. For matters you would prefer not to take through the office, contact the owner.", es: "El dueño directamente. Para asuntos que prefiera no llevar a través de la oficina, contacte al dueño." },
          { en: "Illinois Department of Human Rights (IDHR) for harassment or discrimination claims. EEOC for federal claims. Both have intake forms online. Phes provides this information so you know the public option exists; you are not required to report internally first.", es: "Departamento de Derechos Humanos de Illinois (IDHR) para reclamos de acoso o discriminación. EEOC para reclamos federales. Ambos tienen formularios de admisión en línea. Phes provee esta información para que sepa que la opción pública existe; no está obligado a reportar internamente primero." },
        ],
      },

      { type: "h", text: { en: "Cooperation in Investigations", es: "Cooperación en Investigaciones" } },
      {
        type: "p",
        text: {
          en: "If Phes opens an internal investigation (workplace incident, missing item from a client home, allegation of harassment, etc.), every employee with relevant information is expected to cooperate truthfully. Cooperation includes giving an honest written or verbal statement, providing any photos or documentation requested, and not discussing the investigation with other involved parties while it is open. Refusing to cooperate or providing false information during an investigation is itself a Code of Conduct violation and may result in discipline up to termination.",
          es: "Si Phes abre una investigación interna (incidente laboral, artículo faltante en el hogar de un cliente, alegación de acoso, etc.), se espera que todo empleado con información relevante coopere veridicamente. La cooperación incluye dar una declaración escrita o verbal honesta, proveer cualquier foto o documentación solicitada y no discutir la investigación con otras partes involucradas mientras está abierta. Negarse a cooperar o proveer información falsa durante una investigación es en sí una violación del Código de Conducta y puede resultar en disciplina hasta la terminación.",
        },
      },

      {
        type: "callout",
        tone: "info",
        text: {
          en: "After this quiz: you will sign a separate Code of Conduct Acknowledgment that records your commitment. The signed acknowledgment is a separate legal document tied to your employment, captured with your IP, device, and a hash of the exact policy text. You can re-download the signed PDF anytime from your training page.",
          es: "Después de este examen: firmará un Reconocimiento del Código de Conducta por separado que registra su compromiso. El reconocimiento firmado es un documento legal separado vinculado a su empleo, capturado con su IP, dispositivo y un hash del texto exacto de la política. Puede volver a descargar el PDF firmado en cualquier momento desde su página de capacitación.",
        },
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. VIDEO / PHOTO RELEASE (Phase 5, PR #6)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // CO-SIGNED release. The signed acknowledgment lives in lms_signed_documents
  // at document_type 'video_photo_release', is registered in
  // CO_SIGNED_DOCUMENT_TYPES, and is co-signed by the Phes representative
  // (tenant owner by default, resolved via getTenantOwnerForSignature).
  //
  // Governed by the Illinois Right of Publicity Act (765 ILCS 1075), which
  // requires affirmative consent to use a person's identity for commercial
  // purposes. The release captures that consent in writing, bounded by:
  //   1. 5-year limit on NEW uses after employment ends (content already
  //      in active distribution may continue).
  //   2. AI training / deepfake / synthetic media is carved out (requires
  //      separate written consent).
  //   3. Withdrawal at any time. 30-day removal effort for Phes-controlled
  //      channels. Third-party shares cannot be recalled.
  //   4. Courtesy preview before publication where feasible.
  {
    id: "video-photo-release",
    number: 9,
    iconKind: "shield",
    title: {
      en: "Video & Photo Release",
      es: "Autorización de Video y Foto",
    },
    subtitle: {
      en: "Phes may take photos or video of you at work. This module explains your rights, your AI carve-out, and how to withdraw consent.",
      es: "Phes puede tomar fotos o videos de usted en el trabajo. Este módulo explica sus derechos, la exclusión de IA y cómo retirar el consentimiento.",
    },
    estimatedMinutes: 10,
    blocks: [
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Why this module matters. Phes uses photos and short videos of crews at work to recruit techs, train new hires, and grow the business through social media and the website. The Illinois Right of Publicity Act (765 ILCS 1075) requires Phes to get your AFFIRMATIVE WRITTEN CONSENT before using your identity for any commercial purpose. This release is how we capture that consent and the limits you set on it. Signing is VOLUNTARY. You may decline without any change to your job duties, schedule, or pay.",
          es: "Por qué importa este módulo. Phes usa fotos y videos cortos de equipos en el trabajo para reclutar técnicos, entrenar nuevas contrataciones y hacer crecer el negocio a través de redes sociales y la página web. La Ley del Derecho de Publicidad de Illinois (765 ILCS 1075) requiere que Phes obtenga su CONSENTIMIENTO AFIRMATIVO POR ESCRITO antes de usar su identidad para cualquier propósito comercial. Esta autorización es cómo capturamos ese consentimiento y los límites que usted ponga. Firmar es VOLUNTARIO. Puede rechazarlo sin cambios en sus funciones, horario o pago.",
        },
      },

      { type: "h", text: { en: "What This Release Does and Does Not Cover", es: "Lo Que Esta Autorización Cubre y No Cubre" } },
      {
        type: "p",
        text: {
          en: "By signing, you give Phes permission to capture photos and video of you in your work environment (homes you clean as part of your Phes shift, the Phes office, training sessions, and team events), and to use those photos and videos in Phes recruiting materials, training materials, the Phes website, and Phes social-media channels.",
          es: "Al firmar, usted da permiso a Phes para capturar fotos y videos suyos en su entorno de trabajo (hogares que limpia como parte de su turno de Phes, la oficina de Phes, sesiones de capacitación y eventos del equipo), y para usar esas fotos y videos en materiales de reclutamiento de Phes, materiales de capacitación, la página web de Phes y los canales de redes sociales de Phes.",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Phes is the COMMERCIAL USER. The release covers Phes-internal uses (training) and Phes-external uses (recruiting, marketing).", es: "Phes es el USUARIO COMERCIAL. La autorización cubre usos internos de Phes (capacitación) y externos de Phes (reclutamiento, mercadotecnia)." },
          { en: "The release does NOT permit any third party to use your likeness. If a magazine, news outlet, or another business asks Phes to share footage of you, Phes must ask for your separate consent before sharing.", es: "La autorización NO permite a ningún tercero usar su semejanza. Si una revista, medio de noticias u otro negocio pide a Phes compartir imágenes suyas, Phes debe pedirle su consentimiento separado antes de compartirlas." },
          { en: "The release does NOT permit AI training, deepfake generation, or any synthetic-media use. This is carved out below and requires a separate written consent.", es: "La autorización NO permite el entrenamiento de IA, generación de deepfakes ni ningún uso de medios sintéticos. Esto se excluye más abajo y requiere un consentimiento separado por escrito." },
        ],
      },

      { type: "h", text: { en: "5-Year Post-Separation Limit on New Uses", es: "Límite de 5 Años para Nuevos Usos Después de la Separación" } },
      {
        type: "p",
        text: {
          en: "If your employment with Phes ends (voluntary or involuntary), Phes may continue to use content featuring your likeness that was ALREADY IN ACTIVE DISTRIBUTION at the time you left (for example, a training video posted on the website before your last day, or a recruiting graphic already in rotation). Phes may NOT launch new uses of content featuring your likeness after the 5-year mark following your last day, except for content that was in active distribution at separation.",
          es: "Si su empleo con Phes termina (voluntaria o involuntariamente), Phes puede continuar usando contenido que muestre su semejanza que YA ESTABA EN DISTRIBUCIÓN ACTIVA cuando se fue (por ejemplo, un video de capacitación publicado en el sitio web antes de su último día, o un gráfico de reclutamiento ya en rotación). Phes NO podrá iniciar nuevos usos de contenido que muestre su semejanza después del límite de 5 años siguientes a su último día, excepto para contenido que estaba en distribución activa al momento de la separación.",
        },
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Practical effect: after you leave, your face does not appear in NEW Phes recruiting campaigns once 5 years have passed. Existing assets may continue to play.",
          es: "Efecto práctico: después de irse, su rostro no aparece en NUEVAS campañas de reclutamiento de Phes una vez transcurridos 5 años. Los recursos existentes pueden seguir reproduciéndose.",
        },
      },

      { type: "h", text: { en: "AI Training and Synthetic-Media Carve-Out", es: "Exclusión de Entrenamiento de IA y Medios Sintéticos" } },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Phes WILL NOT use your photos or video to train any AI model, to generate deepfakes, or to produce any synthetic media featuring your likeness, without your SEPARATE WRITTEN CONSENT. This release does not authorize any such use, no matter how the request is framed. If Phes ever asks for an AI-training-specific consent in the future, the request will be a different document with its own signature.",
          es: "Phes NO USARÁ sus fotos o video para entrenar ningún modelo de IA, generar deepfakes ni producir ningún medio sintético que muestre su semejanza, sin su CONSENTIMIENTO SEPARADO POR ESCRITO. Esta autorización no permite ningún uso así, sin importar cómo se plantee la petición. Si Phes alguna vez pide un consentimiento específico para entrenamiento de IA en el futuro, la solicitud será un documento distinto con su propia firma.",
        },
      },

      { type: "h", text: { en: "Courtesy Preview Before Publication", es: "Vista Previa de Cortesía Antes de la Publicación" } },
      {
        type: "p",
        text: {
          en: "When feasible, Phes will provide you a courtesy preview of content featuring your likeness BEFORE we publish it. Courtesy preview is not a veto. You may flag concerns, and we will consider them. Phes commits to making reasonable effort, but pre-approval is not a condition of publication under this release.",
          es: "Cuando sea factible, Phes le proveerá una vista previa de cortesía del contenido que muestre su semejanza ANTES de publicarlo. La vista previa de cortesía no es un veto. Puede señalar inquietudes y las consideraremos. Phes se compromete a hacer un esfuerzo razonable, pero la pre-aprobación no es una condición de la publicación bajo esta autorización.",
        },
      },

      { type: "h", text: { en: "How to Withdraw Consent", es: "Cómo Retirar el Consentimiento" } },
      {
        type: "p",
        text: {
          en: "You may withdraw your consent at any time, for any reason or no reason, by giving written notice to the office. Withdrawal works prospectively. Here is what Phes will and will not do:",
          es: "Puede retirar su consentimiento en cualquier momento, por cualquier razón o sin razón, dando aviso por escrito a la oficina. El retiro funciona hacia adelante. Esto es lo que Phes hará y no hará:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Phes WILL take reasonable steps to remove content featuring your likeness from active Phes-controlled distribution channels (website, Phes social-media pages, recruiting materials we control) within 30 days of receiving your written withdrawal.", es: "Phes TOMARÁ medidas razonables para retirar contenido que muestre su semejanza de los canales de distribución activos controlados por Phes (página web, páginas de redes sociales de Phes, materiales de reclutamiento que controlamos) dentro de los 30 días de recibir su retiro por escrito." },
          { en: "Phes CANNOT recall content already distributed by third parties (re-posts, downloads, screenshots, news articles that referenced our content). Once content has left Phes-controlled distribution, third-party copies are outside Phes's control.", es: "Phes NO PUEDE recuperar contenido ya distribuido por terceros (republicaciones, descargas, capturas de pantalla, artículos de noticias que hayan referido nuestro contenido). Una vez que el contenido salió de la distribución controlada por Phes, las copias de terceros están fuera del control de Phes." },
          { en: "Phes WILL NOT use the withdrawn content in NEW campaigns or NEW publications after the withdrawal date.", es: "Phes NO USARÁ el contenido retirado en NUEVAS campañas o NUEVAS publicaciones después de la fecha de retiro." },
          { en: "Withdrawing consent does not affect your job, your schedule, your pay, or your standing with Phes in any way.", es: "Retirar el consentimiento no afecta su trabajo, su horario, su pago ni su posición con Phes de ninguna manera." },
        ],
      },

      { type: "h", text: { en: "Phes Representative Co-Signature", es: "Co-Firma del Representante de Phes" } },
      {
        type: "p",
        text: {
          en: "Because this release is a two-way commitment (you grant rights; Phes commits to specific limits), the signed acknowledgment is CO-SIGNED by the Phes representative (by default the owner). The co-signature appears on the final PDF after you sign. You do not need to be present for the co-signature; it is added later by the office.",
          es: "Como esta autorización es un compromiso de dos partes (usted otorga derechos; Phes se compromete a límites específicos), el reconocimiento firmado es CO-FIRMADO por el representante de Phes (por defecto el dueño). La co-firma aparece en el PDF final después de que usted firme. No necesita estar presente para la co-firma; la oficina la añade después.",
        },
      },

      {
        type: "callout",
        tone: "info",
        text: {
          en: "After this quiz: you will sign a separate Video and Photo Release that records the rights you grant and the limits Phes commits to. The release is co-signed by the Phes representative. You can re-download the signed PDF anytime from your training page. If you decline to sign, your job is not affected; Phes simply will not photograph or record you for commercial use.",
          es: "Después de este examen: firmará una Autorización de Video y Foto por separado que registra los derechos que otorga y los límites a los que Phes se compromete. La autorización es co-firmada por el representante de Phes. Puede volver a descargar el PDF firmado en cualquier momento desde su página de capacitación. Si decide no firmar, su trabajo no se ve afectado; Phes simplemente no lo fotografiará ni grabará para uso comercial.",
        },
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// QUIZ — 15 scenario-based questions per module = 75 total
// The final mixed test samples 50 from this pool (FINAL_TEST_SIZE).
// ─────────────────────────────────────────────────────────────────────────────

const BASE_QUIZ: QuizQuestion[] = [
  // ═════════════════════════════════════════════════════════════════════════════
  // Module 1: PHES POLICIES & PROCEDURES (15 questions)
  // ═════════════════════════════════════════════════════════════════════════════
  {
    id: "q-pp-01-w2",
    moduleId: "phes-policies",
    prompt: { en: "What kind of employee are Phes technicians?", es: "¿Qué tipo de empleado son los técnicos de Phes?" },
    options: [
      { en: "Independent 1099 contractors", es: "Contratistas 1099 independientes" },
      { en: "W-2 employees with steady scheduled work and benefits", es: "Empleados W-2 con trabajo programado constante y beneficios" },
      { en: "Day laborers paid in cash", es: "Jornaleros pagados en efectivo" },
      { en: "Volunteers with stipend", es: "Voluntarios con estipendio" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-02-guarantee",
    moduleId: "phes-policies",
    prompt: { en: "An hour after you finish a clean, the client calls Phes unhappy with the bathroom. What happens?", es: "Una hora después de terminar una limpieza, el cliente llama a Phes inconforme con el baño. ¿Qué sucede?" },
    options: [
      { en: "Nothing — once the job is marked complete, it's closed", es: "Nada — una vez completado, queda cerrado" },
      { en: "The client gets a refund and we move on", es: "El cliente recibe un reembolso y seguimos" },
      { en: "A team returns the same day to fix it — the Fix-It Rule", es: "Un equipo regresa el mismo día — la Regla de Corrección" },
      { en: "The client can rebook for free next month", es: "El cliente puede reservar gratis el próximo mes" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pp-03-scope-oven",
    moduleId: "phes-policies",
    prompt: {
      en: "Mid-clean, the client asks if you can clean inside the oven. The Worksheet doesn't include it. What's the right move?",
      es: "Durante la limpieza, el cliente le pide limpiar por dentro del horno. La Hoja de Trabajo no lo incluye. ¿Qué hace?",
    },
    options: [
      { en: "Clean it — the customer is always right.", es: "Lo limpia — el cliente siempre tiene la razón." },
      { en: "Call the office to confirm pricing and add it to today's job. If you're tight on time before the next job, decline politely and offer to add it on the next visit instead.", es: "Llame a la oficina para confirmar el precio y agregarlo al trabajo de hoy. Si tiene poco tiempo antes del siguiente trabajo, decline cortésmente y ofrezca agregarlo en la próxima visita." },
      { en: "Clean it but charge them in cash directly.", es: "Lo limpia pero cobra en efectivo directamente." },
      { en: "Refuse and walk out — it's not on the Worksheet.", es: "Se niega y se va — no está en la Hoja de Trabajo." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-04-bodily-fluids",
    moduleId: "phes-policies",
    prompt: { en: "You arrive at a job and see fresh blood on the bathroom floor. What's the right move?", es: "Llega a un trabajo y ve sangre fresca en el piso del baño. ¿Cuál es la acción correcta?" },
    options: [
      { en: "Clean it — it's part of the bathroom", es: "Lo limpia — es parte del baño" },
      { en: "Decline politely; bodily fluids are not part of Phes scope. Call the office for a biohazard referral.", es: "Rechaza cortésmente; los fluidos corporales no son parte del alcance de Phes. Llame a la oficina para referencia de biohazard." },
      { en: "Wear extra gloves and clean it anyway", es: "Use guantes extras y límpielo de todos modos" },
      { en: "Charge the client extra and clean it", es: "Cobre extra al cliente y límpielo" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-05-tipping",
    moduleId: "phes-policies",
    prompt: { en: "A client hands you $20 in cash as a tip at the end of the job. What's the right thing to do?", es: "Un cliente le da $20 en efectivo como propina al final. ¿Qué es correcto?" },
    options: [
      { en: "Refuse — Phes doesn't allow tips", es: "Rechazarla — Phes no permite propinas" },
      { en: "Take it and split with your partner if you have one — tips are 100% yours, no kickback to office", es: "Tomarla y dividirla con su compañero si lo tiene — las propinas son 100% suyas, sin porcentaje a la oficina" },
      { en: "Take it but turn it in to the office to be redistributed", es: "Tomarla pero entregarla a la oficina para redistribución" },
      { en: "Take it and report it as job revenue", es: "Tomarla y reportarla como ingreso del trabajo" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-06-running-late",
    moduleId: "phes-policies",
    prompt: { en: "You're stuck in traffic and will arrive 30 minutes after your scheduled time. What do you do?", es: "Está en el tráfico y llegará 30 minutos después de la hora programada. ¿Qué hace?" },
    options: [
      { en: "Drive faster to make up time", es: "Maneja más rápido para recuperar tiempo" },
      { en: "Don't worry about it — 30 minutes is within the grace period", es: "No se preocupa — 30 minutos están dentro del periodo de gracia" },
      { en: "Call or text the office immediately so the client can be notified", es: "Llama o envía mensaje a la oficina inmediatamente para que el cliente sea notificado" },
      { en: "Just show up when you get there — they'll figure it out", es: "Solo llega cuando pueda — ya lo entenderán" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pp-07-grace-window",
    moduleId: "phes-policies",
    prompt: { en: "What is the grace window after your scheduled clock-in time before a visit is recorded as tardy?", es: "¿Cuál es el periodo de gracia después de la hora programada antes de registrarse como tardanza?" },
    options: [
      { en: "5 minutes", es: "5 minutos" },
      { en: "10 minutes", es: "10 minutos" },
      { en: "20 minutes", es: "20 minutos" },
      { en: "60 minutes", es: "60 minutos" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pp-08-tardy-progression",
    moduleId: "phes-policies",
    prompt: { en: "After how many tardy occurrences does the policy reach 'Final warning'?", es: "¿Después de cuántas tardanzas la política llega a 'Última advertencia'?" },
    options: [
      { en: "2nd", es: "2ª" },
      { en: "3rd", es: "3ª" },
      { en: "4th", es: "4ª" },
      { en: "5th", es: "5ª" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pp-09-sick-tomorrow",
    moduleId: "phes-policies",
    prompt: { en: "You're feeling sick tonight and won't work tomorrow. How do you report it?", es: "Se siente mal esta noche y no trabajará mañana. ¿Cómo lo reporta?" },
    options: [
      { en: "Text a co-worker so they can tell the office.", es: "Mensaje a un compañero para que avise a la oficina." },
      { en: "Submit a sick request through MaidCentral / Qleno AND make the grace-window call to the office team — that's all PLAWA needs. No advance approval, no doctor's note, no reason required.", es: "Envíe la solicitud por MaidCentral / Qleno Y haga la llamada de gracia a el equipo de la oficina — eso es todo lo que PLAWA necesita. Sin aprobación previa, sin nota médica, sin razón requerida." },
      { en: "Call the office in the morning when you should be at work.", es: "Llamar a la oficina en la mañana cuando debería estar trabajando." },
      { en: "Just don't show up — they'll figure it out.", es: "Simplemente no presentarse — ya lo entenderán." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-10-pto-request",
    moduleId: "phes-policies",
    prompt: { en: "You want PTO for next Friday. What do you do?", es: "Quiere PTO para el próximo viernes. ¿Qué hace?" },
    options: [
      { en: "Text your manager directly", es: "Mensaje directo al gerente" },
      { en: "Submit a PTO request through MaidCentral / Qleno — every time-off request goes through the system", es: "Solicitud de PTO en MaidCentral / Qleno — toda solicitud de tiempo libre va por el sistema" },
      { en: "Call the office Friday morning", es: "Llamar a la oficina el viernes en la mañana" },
      { en: "Tell a teammate to relay it", es: "Pedir a un compañero que lo transmita" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-11-unexcused-fourth",
    moduleId: "phes-policies",
    prompt: { en: "An absence becomes 'unexcused' only when (a) you no-call/no-show OR (b) all four leave buckets (PLAWA, PTO, Unpaid Personal Leave, Unpaid Absence Allowance) are exhausted. Once an absence IS unexcused, what happens at the 4th occurrence?", es: "Una ausencia se considera 'injustificada' solo cuando (a) no llama / no se presenta, O (b) las cuatro cubetas (PLAWA, PTO, Licencia Personal No Pagada, Tolerancia de Ausencia No Pagada) están agotadas. Una vez que una ausencia ES injustificada, ¿qué sucede en la 4ª ocurrencia?" },
    options: [
      { en: "Coaching conversation", es: "Conversación de orientación" },
      { en: "Written warning", es: "Advertencia por escrito" },
      { en: "Final warning", es: "Última advertencia" },
      { en: "Immediate termination", es: "Terminación inmediata" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pp-12-uniform-forgot",
    moduleId: "phes-policies",
    prompt: { en: "You wake up and realize your Phes shirt is in the wash. What do you do?", es: "Se despierta y su camisa Phes está en la lavadora. ¿Qué hace?" },
    options: [
      { en: "Wear a similar-looking personal shirt — clients won't notice", es: "Ponerse una camisa parecida — el cliente no notará" },
      { en: "Skip the shirt and wear just a t-shirt", es: "Saltarse la camisa y usar solo camiseta" },
      { en: "Contact the office before the job — never show up at a client's home out of uniform", es: "Contactar a la oficina antes del trabajo — nunca presentarse fuera de uniforme" },
      { en: "Borrow a uniform from a teammate at the job", es: "Pedir prestado el uniforme a un compañero" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pp-13-shoe-covers",
    moduleId: "phes-policies",
    prompt: { en: "You arrive and realize you forgot your shoe covers in your other bag. What do you do?", es: "Llega y se da cuenta que olvidó los cubrezapatos en su otra bolsa. ¿Qué hace?" },
    options: [
      { en: "Take off your shoes at the door and clean barefoot", es: "Quitarse los zapatos y limpiar descalzo" },
      { en: "Walk in carefully without covers — just don't track dirt", es: "Entrar con cuidado sin cubrezapatos" },
      { en: "Don't enter — get fresh covers from your vehicle, or call office for a teammate to bring some", es: "No entrar — buscar cubrezapatos en el vehículo, o llamar a la oficina" },
      { en: "Ask the client if they mind", es: "Preguntar al cliente si le importa" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pp-14-phone-use",
    moduleId: "phes-policies",
    prompt: { en: "Mid-clean, your sister texts you about dinner plans. When do you respond?", es: "Durante la limpieza, su hermana le envía mensaje sobre la cena. ¿Cuándo responde?" },
    options: [
      { en: "Right away — it'll only take a second", es: "Ahora mismo — solo toma un segundo" },
      { en: "Step into the bathroom for privacy and respond", es: "Entrar al baño por privacidad y responder" },
      { en: "After the visit or during your break — personal phones are not allowed during a job", es: "Después de la visita o en su descanso — los teléfonos personales no se permiten durante un trabajo" },
      { en: "Ask your partner to respond for you", es: "Pedirle a su compañero que responda por usted" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pp-15-photos",
    moduleId: "phes-policies",
    prompt: {
      en: "You finish a deep clean and want to post a before/after on your personal Instagram to show off your work. Is that OK?",
      es: "Termina una limpieza profunda y quiere publicar un antes/después en su Instagram personal para mostrar su trabajo. ¿Está bien?",
    },
    options: [
      { en: "Yes, post anything you want on your personal account.", es: "Sí, publique lo que quiera en su cuenta personal." },
      { en: "Yes, as long as the client's face isn't visible.", es: "Sí, mientras no se vea la cara del cliente." },
      { en: "No — client homes are private. The ONLY photos allowed are inside the company app for documenting work (before/after, damage, etc.). To share Phes work publicly, ask the office.", es: "No — los hogares de los clientes son privados. Las ÚNICAS fotos permitidas son dentro de la app de la compañía para documentar trabajo (antes/después, daños, etc.). Para compartir trabajo de Phes públicamente, pida a la oficina." },
      { en: "Yes, but blur the location and don't tag where you are.", es: "Sí, pero difumine la ubicación y no etiquete dónde está." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pp-16-dishes-beds",
    moduleId: "phes-policies",
    prompt: {
      en: "Mid-clean, the client asks if you can wash the dishes in the sink and make the kids' beds before you leave. There's no note in the app authorizing extra work. What do you do?",
      es: "Durante la limpieza, el cliente le pide lavar los platos y tender las camas de los niños antes de irse. No hay nota en la app que autorice trabajo extra. ¿Qué hace?",
    },
    options: [
      { en: "Do it as a courtesy — it'll only take 10 minutes.", es: "Hágalo por cortesía — solo toma 10 minutos." },
      { en: "Decline politely; dishes and beds are not standard Phes scope. Tell the client you'll let the office know.", es: "Rechace cortésmente; lavar platos y tender camas no es parte del alcance estándar. Dígale al cliente que informará a la oficina." },
      { en: "Charge the client cash for the extra work.", es: "Cobre al cliente en efectivo por el trabajo extra." },
      { en: "Make the beds (it's quick) but skip the dishes.", es: "Tienda las camas (es rápido) pero no lave los platos." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-17-office-exception",
    moduleId: "phes-policies",
    prompt: {
      en: "You open today's job in the app and see a note from the office: 'Mrs. Johnson is a loyal client — please make the master bed today as a one-time courtesy.' Are you allowed to make the bed?",
      es: "Abre el trabajo de hoy en la app y ve una nota de la oficina: 'La Sra. Johnson es cliente leal — por favor tienda la cama principal hoy como cortesía única.' ¿Puede tender la cama?",
    },
    options: [
      { en: "No — standard guidelines never bend.", es: "No — las guías estándar nunca cambian." },
      { en: "Yes — the office grants exceptions, and they communicate them via app notes or a direct message. Follow the note.", es: "Sí — la oficina otorga excepciones, y las comunica por notas en la app o mensaje directo. Siga la nota." },
      { en: "Only if Mrs. Johnson asks me personally.", es: "Solo si la Sra. Johnson me pide en persona." },
      { en: "Yes, but only if I call the office first to double-check.", es: "Sí, pero solo si llamo a la oficina primero para confirmar." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-18-bereavement",
    moduleId: "phes-policies",
    prompt: {
      en: "Your father passes away. What's the Phes bereavement policy?",
      es: "Su padre fallece. ¿Cuál es la política de duelo de Phes?",
    },
    options: [
      { en: "Up to 3 unpaid days off — use PLAWA to get paid.", es: "Hasta 3 días no pagados — use PLAWA para recibir pago." },
      { en: "Up to 3 paid days at your regular rate (immediate family: spouse, child, parent, sibling).", es: "Hasta 3 días pagados a su tarifa regular (familia inmediata: cónyuge, hijo/a, padre/madre, hermano/a)." },
      { en: "Up to 5 paid days plus travel time.", es: "Hasta 5 días pagados más tiempo de viaje." },
      { en: "Phes does not offer bereavement leave.", es: "Phes no ofrece licencia por duelo." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-19-jury-duty",
    moduleId: "phes-policies",
    prompt: {
      en: "You receive a jury summons for next Wednesday. How does Phes handle the time and pay?",
      es: "Recibe una citación de jurado para el próximo miércoles. ¿Cómo maneja Phes el tiempo y el pago?",
    },
    options: [
      { en: "Phes pays your regular wage for jury days.", es: "Phes paga su salario regular en días de jurado." },
      { en: "Jury leave is UNPAID by Phes, your job is protected, and you keep any juror compensation the court provides. Bring the summons to the office and notify dispatch.", es: "La licencia de jurado NO es pagada por Phes, su empleo está protegido, y se queda con la compensación del tribunal. Lleve la citación a la oficina y avise a despacho." },
      { en: "You must use PTO to cover it.", es: "Debe usar PTO para cubrirlo." },
      { en: "Ignore the summons — Phes will write a letter excusing you.", es: "Ignore la citación — Phes le escribirá una carta de excusa." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-20-lactation",
    moduleId: "phes-policies",
    prompt: {
      en: "Returning from maternity leave, you ask about pumping breaks during the workday. What's the policy?",
      es: "Al regresar de licencia maternal, pregunta sobre pausas para extraer leche durante el día. ¿Cuál es la política?",
    },
    options: [
      { en: "Use PLAWA hours.", es: "Use horas de PLAWA." },
      { en: "Reasonable lactation breaks are PAID at your regular rate and do NOT deduct from PLAWA or PTO. The office coordinates timing and a private location.", es: "Las pausas de lactancia razonables se PAGAN a su tarifa regular y NO se descuentan de PLAWA ni PTO. La oficina coordina el horario y un lugar privado." },
      { en: "Unpaid 15-minute breaks only.", es: "Solo pausas no pagadas de 15 minutos." },
      { en: "Lactation breaks are not allowed during scheduled jobs.", es: "Las pausas de lactancia no se permiten durante trabajos programados." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-21-pto-cap",
    moduleId: "phes-policies",
    prompt: {
      en: "In your first PTO year you used only 20 of your 40 hours. Tomorrow is your 2-year anniversary. How many PTO hours will be in your bank?",
      es: "En su primer año de PTO usó solo 20 de sus 40 horas. Mañana es su aniversario de 2 años. ¿Cuántas horas de PTO tendrá en su banco?",
    },
    options: [
      { en: "100 hours — 20 carried over plus the new 80.", es: "100 horas — las 20 acumuladas más las 80 nuevas." },
      { en: "80 hours — Phes tops up your bank to the 80-hour cap. PTO never exceeds 80 hours.", es: "80 horas — Phes rellena su banco hasta el tope de 80 horas. El PTO nunca excede 80 horas." },
      { en: "60 hours — your remaining 20 plus 40 more.", es: "60 horas — sus 20 restantes más 40 más." },
      { en: "40 hours — second-year accrual only.", es: "40 horas — solo la acumulación del segundo año." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-22-separation-payout",
    moduleId: "phes-policies",
    prompt: {
      en: "You give your 2-week notice. You have 20 unused PTO hours and 15 unused PLAWA (sick) hours. What gets paid out at separation?",
      es: "Da su aviso de 2 semanas. Tiene 20 horas de PTO sin usar y 15 horas de PLAWA (enfermedad) sin usar. ¿Qué se paga al separarse?",
    },
    options: [
      { en: "Both — all unused leave is cashed out.", es: "Ambas — toda la licencia sin usar se paga." },
      { en: "PTO only (20 hours). PLAWA has no cash value and is not paid out.", es: "Solo PTO (20 horas). PLAWA no tiene valor en efectivo y no se paga." },
      { en: "PLAWA only — PTO is forfeited at separation.", es: "Solo PLAWA — el PTO se pierde al separarse." },
      { en: "Neither — Phes does not pay out unused leave.", es: "Ninguna — Phes no paga licencia sin usar." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-23-holiday-90day",
    moduleId: "phes-policies",
    prompt: {
      en: "You were hired on November 1 and Thanksgiving falls 3 weeks later. Do you receive paid holiday pay for Thanksgiving?",
      es: "Fue contratado el 1 de noviembre y Acción de Gracias cae 3 semanas después. ¿Recibe pago por feriado en Acción de Gracias?",
    },
    options: [
      { en: "Yes — Phes observes Thanksgiving as a paid holiday.", es: "Sí — Phes observa Acción de Gracias como feriado pagado." },
      { en: "No — holiday pay eligibility begins AFTER 90 days of employment. Holidays in your first 90 days are unpaid.", es: "No — la elegibilidad para pago por feriado comienza DESPUÉS de 90 días de empleo. Los feriados en sus primeros 90 días no son pagados." },
      { en: "Yes — but only at half rate during the first 90 days.", es: "Sí — pero solo a media tarifa durante los primeros 90 días." },
      { en: "Only if the client cancels and you would have worked that day.", es: "Solo si el cliente cancela y habría trabajado ese día." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-24-sick-doc",
    moduleId: "phes-policies",
    prompt: {
      en: "You're out with the flu for 4 consecutive workdays and use PLAWA. Does Phes require a doctor's note?",
      es: "Está fuera con gripe por 4 días laborales consecutivos y usa PLAWA. ¿Phes requiere una nota médica?",
    },
    options: [
      { en: "Yes — Phes requires a note for any absence of 3 days or more.", es: "Sí — Phes requiere una nota para cualquier ausencia de 3 días o más." },
      { en: "No — Phes never requires a reason or a doctor's note to use PLAWA, regardless of how long the absence is. Phes policy is stricter than Illinois law on this point: we choose not to require documentation.", es: "No — Phes nunca exige una razón ni nota médica para usar PLAWA, sin importar la duración de la ausencia. La política de Phes es más estricta que la ley de Illinois en este punto: elegimos no exigir documentación." },
      { en: "Only if the client complained about your absence.", es: "Solo si el cliente se quejó de su ausencia." },
      { en: "Yes — flu absences specifically require a note.", es: "Sí — las ausencias por gripe específicamente requieren una nota." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-25-sick-no-balance",
    moduleId: "phes-policies",
    prompt: {
      en: "You've used all 40 hours of your PLAWA this Benefit Year. You wake up sick and call off (with the 20-minute grace call). How is this absence classified?",
      es: "Ha usado las 40 horas de su PLAWA en este Año de Beneficios. Despierta enfermo y llama para faltar (con la llamada de gracia de 20 minutos). ¿Cómo se clasifica esta ausencia?",
    },
    options: [
      { en: "Phes covers the absence with the next leave bucket in order — PTO, then Unpaid Personal Leave, then Unpaid Absence Allowance. It is NOT unexcused unless all four buckets are exhausted or you no-call/no-showed.", es: "Phes cubre la ausencia con la siguiente cubeta en orden — PTO, luego Licencia Personal No Pagada, luego Tolerancia de Ausencia No Pagada. NO es injustificada a menos que las cuatro cubetas estén agotadas o haya sido un no llamó / no se presentó." },
      { en: "Unexcused — once PLAWA is gone, every sick call counts toward discipline.", es: "Injustificada — una vez agotado el PLAWA, cada llamada por enfermedad cuenta hacia la disciplina." },
      { en: "PTO is automatically deducted, but if PTO is also gone you're unexcused.", es: "Se deduce PTO automáticamente, pero si el PTO también está agotado, queda como injustificada." },
      { en: "Phes terminates immediately for going over PLAWA.", es: "Phes termina inmediatamente por exceder el PLAWA." },
    ],
    correctIndex: 0,
  },
  {
    id: "q-pp-26-unpaid-personal",
    moduleId: "phes-policies",
    prompt: {
      en: "You've used all your PLAWA and PTO but need a planned day off for your kid's school event. What's the next bucket Phes will use?",
      es: "Ha usado todo su PLAWA y PTO pero necesita un día libre planeado para un evento escolar de su hijo. ¿Cuál es la siguiente cubeta que Phes usará?",
    },
    options: [
      { en: "None — you're out of leave, the day will be unexcused.", es: "Ninguna — está sin licencia, el día será injustificado." },
      { en: "Unpaid Personal Leave (bucket #3 of 4): up to 40 hours / 5 days per year, available from day one, requires 7 days advance notice, same first-come-first-serve and max-2-off approval rules as PTO.", es: "Licencia Personal No Pagada (cubeta #3 de 4): hasta 40 horas / 5 días por año, disponible desde el primer día, requiere 7 días de aviso anticipado, mismas reglas de aprobación que el PTO (primero en llegar, máximo 2 libres)." },
      { en: "Borrow PTO from a coworker.", es: "Pídale prestado PTO a un compañero." },
      { en: "Auto-promotion to overtime hours to cover the missed time.", es: "Promoción automática a horas extra para cubrir el tiempo perdido." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-27-bucket-order",
    moduleId: "phes-policies",
    prompt: {
      en: "Phes uses three leave buckets to cover absences. What is the order they are used in?",
      es: "Phes usa tres cubetas de licencia para cubrir ausencias. ¿En qué orden se usan?",
    },
    options: [
      { en: "PTO → PLAWA → Unpaid Personal Leave.", es: "PTO → PLAWA → Licencia Personal No Pagada." },
      { en: "PLAWA → PTO → Unpaid Personal Leave → discipline scale (only if all three are exhausted and absence is not otherwise protected).", es: "PLAWA → PTO → Licencia Personal No Pagada → escala de disciplina (solo si las tres están agotadas y la ausencia no está protegida de otra forma)." },
      { en: "Whichever bucket the office picks each time.", es: "La cubeta que la oficina escoja cada vez." },
      { en: "Unpaid Personal Leave first, paid buckets last.", es: "Licencia Personal No Pagada primero, las pagadas al final." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-28-unexcused-definition",
    moduleId: "phes-policies",
    prompt: {
      en: "Under Phes policy, when does an absence officially become 'unexcused' (and start counting toward the discipline scale)?",
      es: "Bajo la política de Phes, ¿cuándo se considera oficialmente 'injustificada' una ausencia (y empieza a contar hacia la escala de disciplina)?",
    },
    options: [
      { en: "Any time you call off sick more than twice in a month.", es: "Cada vez que llame por enfermedad más de dos veces al mes." },
      { en: "Only when (a) it's a no-call/no-show, OR (b) all three leave buckets are exhausted and you didn't get advance approval for unpaid time. Using any bucket with proper notice is excused.", es: "Solo cuando (a) es un no llamó / no se presentó, O (b) las tres cubetas de licencia están agotadas y no obtuvo aprobación previa para tiempo no pagado. Usar cualquier cubeta con aviso apropiado es justificado." },
      { en: "As soon as your PLAWA balance hits zero.", es: "Tan pronto como su saldo de PLAWA llega a cero." },
      { en: "Any absence that isn't backed by a doctor's note.", es: "Cualquier ausencia que no esté respaldada por una nota médica." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-29-plawa-denial",
    moduleId: "phes-policies",
    prompt: {
      en: "Can Phes deny a PLAWA request because two other techs are already off that day, or because the route is hard to cover?",
      es: "¿Puede Phes negar una solicitud de PLAWA porque ya hay dos técnicos libres ese día, o porque la ruta es difícil de cubrir?",
    },
    options: [
      { en: "Yes — PLAWA follows the same first-come-first-serve and max-2-off rules as PTO.", es: "Sí — el PLAWA sigue las mismas reglas que el PTO (primero en llegar, máximo 2 libres)." },
      { en: "No — PLAWA cannot be denied for business needs. Max-2-off and route coverage rules apply to PTO and Unpaid Personal Leave only.", es: "No — el PLAWA no se puede negar por necesidades del negocio. Las reglas de máximo 2 libres y cobertura de ruta aplican solo al PTO y a la Licencia Personal No Pagada." },
      { en: "Only if you are in your first 90 days.", es: "Solo si está en sus primeros 90 días." },
      { en: "Yes, but only for sick calls on weekends.", es: "Sí, pero solo para llamadas por enfermedad en fines de semana." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-30-plawa-no-discipline",
    moduleId: "phes-policies",
    prompt: {
      en: "You use 16 hours of PLAWA over the course of the year — every one with the proper 20-minute grace call. Can Phes count any of those absences toward the discipline scale?",
      es: "Usa 16 horas de PLAWA durante el año — cada una con la llamada de gracia de 20 minutos. ¿Puede Phes contar alguna de esas ausencias hacia la escala de disciplina?",
    },
    options: [
      { en: "No — using PLAWA with proper notice can NEVER count toward discipline. By law, it is protected leave; by Phes policy, we go even further: no reason needed, no note needed, no penalty.", es: "No — usar PLAWA con aviso apropiado NUNCA puede contar hacia la disciplina. Por ley, es licencia protegida; por política de Phes, vamos más lejos: sin razón requerida, sin nota, sin penalización." },
      { en: "Yes — 16 hours in a year is excessive and triggers a written warning.", es: "Sí — 16 horas en un año es excesivo y activa una advertencia por escrito." },
      { en: "Only if more than 2 absences land on a Monday or Friday.", es: "Solo si más de 2 ausencias caen en lunes o viernes." },
      { en: "Yes, after the 3rd PLAWA day.", es: "Sí, después del 3er día de PLAWA." },
    ],
    correctIndex: 0,
  },
  {
    id: "q-pp-31-plawa-default",
    moduleId: "phes-policies",
    prompt: {
      en: "You call off sick and have hours in BOTH PLAWA and PTO. Which bucket gets used?",
      es: "Llama por enfermedad y tiene horas en AMBOS PLAWA y PTO. ¿Cuál cubeta se usa?",
    },
    options: [
      { en: "PTO — it's the bigger bank.", es: "PTO — es el banco más grande." },
      { en: "PLAWA — it's used by default unless you elect in writing to use a different bucket. PTO is reserved for planned time off so you keep it for vacations / appointments.", es: "PLAWA — se usa por defecto a menos que usted elija por escrito usar otra cubeta. El PTO se reserva para tiempo libre planeado para que lo conserve para vacaciones / citas." },
      { en: "Whichever has more hours left.", es: "La que tenga más horas restantes." },
      { en: "Whichever the office chooses to charge.", es: "La que la oficina decida cobrar." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-32-notice-by-bucket",
    moduleId: "phes-policies",
    prompt: {
      en: "What notice does each bucket require?",
      es: "¿Qué aviso requiere cada cubeta?",
    },
    options: [
      { en: "Every bucket: 7 days advance notice, no exceptions.", es: "Toda cubeta: 7 días de aviso anticipado, sin excepciones." },
      { en: "PLAWA: the 20-minute grace call only, no advance approval. PTO and Unpaid Personal Leave: 7 days advance notice. Same two-step process (system + the office team) for all three.", es: "PLAWA y Tolerancia de Ausencia No Pagada: solo la llamada de gracia de 20 minutos. PTO y Licencia Personal No Pagada: 7 días de aviso anticipado. El mismo proceso de dos pasos (sistema + the office team) para las cuatro." },
      { en: "Doctor's note required for all four.", es: "Nota médica requerida para las cuatro." },
      { en: "Only the office decides — no fixed notice rules.", es: "Solo la oficina decide — sin reglas fijas de aviso." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-33-plawa-reason",
    moduleId: "phes-policies",
    prompt: {
      en: "When you submit a PLAWA request, do you need to tell Phes why you're using it?",
      es: "Cuando envía una solicitud de PLAWA, ¿necesita decirle a Phes por qué la está usando?",
    },
    options: [
      { en: "Yes — you must list a specific reason (flu, doctor visit, family illness, etc.).", es: "Sí — debe indicar una razón específica (gripe, cita médica, enfermedad familiar, etc.)." },
      { en: "No — under Phes policy you NEVER have to provide a reason or supporting documentation to use PLAWA. The grace-window call is all the office needs.", es: "No — bajo la política de Phes NUNCA tiene que proporcionar una razón ni documentación para usar PLAWA. La llamada de gracia es todo lo que la oficina necesita." },
      { en: "Only if it's more than one day.", es: "Solo si es más de un día." },
      { en: "Yes, and it has to be put in writing.", es: "Sí, y tiene que ponerlo por escrito." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-34-protected-still-excused",
    moduleId: "phes-policies",
    prompt: {
      en: "You've burned through PLAWA, PTO, and Unpaid Personal Leave. The very next absence is jury duty (you have a court summons). Is it unexcused?",
      es: "Ha agotado PLAWA, PTO, y Licencia Personal No Pagada. La siguiente ausencia es servicio de jurado (tiene una citación judicial). ¿Es injustificada?",
    },
    options: [
      { en: "Yes. All three buckets are gone so any new absence counts.", es: "Sí. Las tres cubetas se agotaron, así que cualquier ausencia nueva cuenta." },
      { en: "No. Jury duty is a PROTECTED absence under Illinois law. Protected absences are NEVER counted as unexcused, no matter how many leave hours you have left. Same for workers comp, bereavement, lactation, pregnancy, VESSA, military leave, and Election Day voting.", es: "No. El servicio de jurado es una ausencia PROTEGIDA bajo la ley de Illinois. Las ausencias protegidas NUNCA cuentan como injustificadas, sin importar cuántas horas de licencia le queden. Lo mismo aplica para compensación al trabajador, duelo, lactancia, embarazo, VESSA, licencia militar y tiempo para votar el Día de Elecciones." },
      { en: "Only if you bring a doctor's note.", es: "Solo si trae una nota médica." },
      { en: "It depends on whether two other cleaners are also off that day.", es: "Depende de si hay otros dos cleaners libres ese día." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-35-deep-clean-includes",
    moduleId: "phes-policies",
    prompt: {
      en: "You're on a Deep Clean. Which of these is INCLUDED in the Deep Clean scope (no add-on charge)?",
      es: "Está en una Limpieza Profunda. ¿Cuál de estos está INCLUIDO en el alcance (sin cobro de add-on)?",
    },
    options: [
      { en: "Cleaning inside the refrigerator.", es: "Limpiar dentro del refrigerador." },
      { en: "Baseboards, ceiling fans, doorknobs / light switches, storm + sliding patio doors (inside & outside glass), air vent covers — plus everything in the Standard Clean.", es: "Zócalos, ventiladores de techo, pomos / interruptores, puertas tormenta + corredizas (vidrio interior y exterior), tapas de ventilación — más todo lo de la Limpieza Estándar." },
      { en: "Cleaning inside the oven.", es: "Limpiar dentro del horno." },
      { en: "Cleaning inside kitchen cabinets.", es: "Limpiar dentro de los gabinetes de cocina." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-36-deep-clean-excludes",
    moduleId: "phes-policies",
    prompt: {
      en: "On a Deep Clean the client asks you to clean inside the oven and inside the refrigerator while you're there. The Worksheet doesn't list these as add-ons. What do you do?",
      es: "En una Limpieza Profunda el cliente le pide limpiar dentro del horno y dentro del refrigerador. La Hoja de Trabajo no los muestra como add-ons. ¿Qué hace?",
    },
    options: [
      { en: "Do them — Deep Clean covers everything.", es: "Hágalos — la Limpieza Profunda cubre todo." },
      { en: "Call the office to confirm the $50/each add-on charge and accommodate if there's time before your next job. If you're tight on time, decline politely and offer to add it next visit. Never quote the price yourself.", es: "Llame a la oficina para confirmar el cobro de add-on de $50 cada uno y acomódelo si hay tiempo antes del siguiente trabajo. Si está apretado de tiempo, decline cortésmente y ofrezca agregarlo la próxima visita. Nunca cotice el precio usted mismo." },
      { en: "Tell the client to call the office directly.", es: "Dígale al cliente que llame a la oficina directamente." },
      { en: "Do them and charge the client cash on site.", es: "Hágalos y cobre al cliente en efectivo en el sitio." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-37-deep-clean-windows",
    moduleId: "phes-policies",
    prompt: {
      en: "The 'Inside Windows' add-on covers what exactly?",
      es: "El add-on de 'Ventanas Interiores' cubre exactamente qué?",
    },
    options: [
      { en: "Interior glass only — EXCLUDES tracks and exterior panes. Price varies.", es: "Solo vidrio interior — EXCLUYE rieles y vidrios exteriores. El precio varía." },
      { en: "Interior, exterior, AND tracks — one flat $50 charge.", es: "Interior, exterior Y rieles — un cargo fijo de $50." },
      { en: "All windows in the home, no exclusions.", es: "Todas las ventanas, sin exclusiones." },
      { en: "Window tracks only.", es: "Solo los rieles." },
    ],
    correctIndex: 0,
  },
  {
    id: "q-pp-38-heavy-furniture-25lb",
    moduleId: "phes-policies",
    prompt: {
      en: "A client asks you to slide their dresser away from the wall so you can clean behind it. The dresser is heavy — well over 25 lbs. What do you do?",
      es: "Un cliente le pide mover una cómoda de la pared para limpiar detrás. La cómoda es pesada — más de 25 lb. ¿Qué hace?",
    },
    options: [
      { en: "Move it carefully — the customer is always right.", es: "Muévala con cuidado — el cliente siempre tiene la razón." },
      { en: "Decline politely. Phes does not lift or move anything over 25 lbs. Clean around it, document it as a note in the app, and tell the office.", es: "Decline cortésmente. Phes no levanta ni mueve nada de más de 25 lb. Limpie alrededor, documente con nota en la app, y avise a la oficina." },
      { en: "Ask the client to move it themselves while you wait.", es: "Pídale al cliente que la mueva mientras espera." },
      { en: "Move it if you can do it alone.", es: "Muévala si puede solo." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-39-trash-bag-limit",
    moduleId: "phes-policies",
    prompt: {
      en: "You arrive at a job and the household has 8 full trash bags. What's the rule?",
      es: "Llega a un trabajo y el hogar tiene 8 bolsas de basura llenas. ¿Cuál es la regla?",
    },
    options: [
      { en: "Take them all — the client is paying for service.", es: "Llévelas todas — el cliente está pagando." },
      { en: "Maximum 5 bags per visit. Take the first 5, document the rest with a note in the app, and call the office. We do not haul extra.", es: "Máximo 5 bolsas por visita. Tome las primeras 5, documente el resto con nota en la app, y llame a la oficina. No llevamos extra." },
      { en: "Refuse to take any — let the client deal with it.", es: "Rehúse llevarse alguna — que el cliente se encargue." },
      { en: "Take whatever fits in your car.", es: "Tome lo que quepa en su carro." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-40-no-price-discussion",
    moduleId: "phes-policies",
    prompt: {
      en: "A client tells you their last cleaning company charged $30 less and asks if you can match the price. What's the right response?",
      es: "Un cliente le dice que su compañía anterior cobraba $30 menos y pregunta si puede igualar el precio. ¿Cuál es la respuesta correcta?",
    },
    options: [
      { en: "Offer them $20 off and pocket the difference.", es: "Ofrézcale $20 de descuento y guárdese la diferencia." },
      { en: "Politely say 'I'll have the office reach out to discuss pricing,' then call the office team. Pricing is 100% the office's job — never negotiate, never accept cash discounts, never quote prices.", es: "Diga cortésmente 'la oficina los contactará para hablar del precio,' luego llame a el equipo de la oficina. El precio es 100% trabajo de la oficina — nunca negocie, nunca acepte descuentos en efectivo, nunca cotice." },
      { en: "Tell them Phes doesn't do discounts and finish the job in silence.", es: "Dígale que Phes no hace descuentos y termine el trabajo en silencio." },
      { en: "Quote a discount yourself to keep them happy.", es: "Cotice un descuento usted mismo para mantenerlos contentos." },
    ],
    correctIndex: 1,
  },

  // ═════════════════════════════════════════════════════════════════════════════
  // Module 2: COMPENSATION (15 questions)
  // ═════════════════════════════════════════════════════════════════════════════
  {
    id: "q-cm-01-training-pay",
    moduleId: "compensation",
    prompt: { en: "What's the training pay rate for new techs during their first cleanings?", es: "¿Cuál es la tarifa de pago de entrenamiento para nuevos técnicos en sus primeras limpiezas?" },
    options: [
      { en: "$15.00 per hour", es: "$15.00 por hora" },
      { en: "$20.00 per hour", es: "$20.00 por hora" },
      { en: "$25.00 per hour", es: "$25.00 por hora" },
      { en: "Commission from day one", es: "Comisión desde el primer día" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-02-standard-rate",
    moduleId: "compensation",
    prompt: { en: "What is the commission rate on a Standard Clean (residential, recurring or one-time)?", es: "¿Cuál es la comisión en una Limpieza Estándar (residencial, recurrente o única)?" },
    options: [
      { en: "30%", es: "30%" },
      { en: "32%", es: "32%" },
      { en: "35%", es: "35%" },
      { en: "40%", es: "40%" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-cm-03-deep-clean-rate",
    moduleId: "compensation",
    prompt: { en: "You're assigned a Deep Clean job. What is the commission rate?", es: "Le asignan una Limpieza Profunda. ¿Cuál es la tarifa de comisión?" },
    options: [
      { en: "35% — same as standard", es: "35% — igual que estándar" },
      { en: "32% — Phes bills the client $80/hr on Deep Cleans", es: "32% — Phes factura $80/hr al cliente en Limpiezas Profundas" },
      { en: "20% — same as commercial", es: "20% — igual que comercial" },
      { en: "40% — premium rate for hard work", es: "40% — tarifa premium" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-04-move-in-rate",
    moduleId: "compensation",
    prompt: { en: "You're assigned a Move In / Move Out clean. What is the commission rate?", es: "Le asignan una limpieza de Move In / Move Out. ¿Cuál es la tarifa?" },
    options: [
      { en: "35% — same as standard", es: "35% — igual que estándar" },
      { en: "32% — Phes bills the client $80/hr on Move In / Move Out", es: "32% — Phes factura $80/hr al cliente" },
      { en: "$20/hr — same as commercial", es: "$20/hr — igual que comercial" },
      { en: "Determined by the office case-by-case", es: "Decidido por la oficina caso por caso" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-05-comm-split-200",
    moduleId: "compensation",
    prompt: { en: "You and a partner complete a $200 Standard Clean together with the same check-in time. How much commission does each of you earn?", es: "Tú y un compañero completan una Limpieza Estándar de $200 juntos con el mismo tiempo de Check In. ¿Cuánta comisión gana cada uno?" },
    options: [
      { en: "$70 each (35% each)", es: "$70 c/u (35% c/u)" },
      { en: "$50 each", es: "$50 c/u" },
      { en: "$35 each (35% pool split two ways)", es: "$35 c/u (el 35% dividido en dos)" },
      { en: "Whichever the office decides", es: "Lo que decida la oficina" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-cm-06-deep-split-300",
    moduleId: "compensation",
    prompt: { en: "You and a partner complete a $300 Deep Clean together. The pool rate is 32%. Roughly how much does each of you earn?", es: "Tú y un compañero completan una Limpieza Profunda de $300 juntos. La tarifa es 32%. ¿Aproximadamente cuánto gana cada uno?" },
    options: [
      { en: "$96 each (32% each)", es: "$96 c/u (32% c/u)" },
      { en: "$48 each (32% pool split two ways)", es: "$48 c/u (el 32% dividido en dos)" },
      { en: "$52.50 each (35% pool / 2)", es: "$52.50 c/u (35% / 2)" },
      { en: "$60 each", es: "$60 c/u" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-07-clock-in-difference",
    moduleId: "compensation",
    prompt: { en: "You arrive at 9:00 AM and Check In immediately. Your partner Checks In at 9:30 AM. How is the commission split calculated?", es: "Llega a las 9:00 AM y hace Check In de inmediato. Su compañero hace Check In a las 9:30 AM. ¿Cómo se calcula la comisión?" },
    options: [
      { en: "Always 50/50 — same job, same pay", es: "Siempre 50/50 — mismo trabajo, mismo pago" },
      { en: "Proportionally by actual minutes on site — your Job Clock shows more time, so you receive a larger share", es: "Proporcional a los minutos reales en sitio — su Reloj de Trabajo muestra más tiempo, recibe mayor porción" },
      { en: "Whoever Checks Out first earns more", es: "Quien haga Check Out primero gana más" },
      { en: "The office decides at the end of the week", es: "La oficina decide al final de la semana" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-08-hourly-overrun",
    moduleId: "compensation",
    prompt: { en: "You're an hour into a 3-hour hourly job and you can already tell you won't finish in time. What do you do?", es: "Lleva una hora en un trabajo por hora de 3 horas y ya ve que no terminará a tiempo. ¿Qué hace?" },
    options: [
      { en: "Wait until the last hour, then call the office", es: "Esperar a la última hora, luego llamar" },
      { en: "Call the office right away — early, while there's still time to talk to the client gracefully", es: "Llamar a la oficina inmediatamente — temprano, mientras aún hay tiempo de hablar con el cliente con elegancia" },
      { en: "Skip the easier rooms to fit it in", es: "Saltar las habitaciones más fáciles" },
      { en: "Just leave the job incomplete — they'll figure it out", es: "Dejar el trabajo incompleto" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-09-commercial-rate",
    moduleId: "compensation",
    prompt: { en: "What is the pay structure for a commercial cleaning job?", es: "¿Cuál es la estructura de pago de un trabajo comercial?" },
    options: [
      { en: "32% commission of job total", es: "32% de comisión del total" },
      { en: "35% commission of job total", es: "35% de comisión del total" },
      { en: "$20/hr × allowed hours assigned", es: "$20/hr × horas asignadas" },
      { en: "Same as residential — depends on service type", es: "Igual que residencial — depende del tipo de servicio" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-cm-10-commercial-early",
    moduleId: "compensation",
    prompt: { en: "Your commercial job is assigned 3 allowed hours. You finish what you can see in 1.5 hours. What do you do BEFORE uploading completion photos?", es: "Su trabajo comercial tiene 3 horas asignadas. Termina lo visible en 1.5 horas. ¿Qué hace ANTES de subir las fotos?" },
    options: [
      { en: "Upload them — finishing early is good", es: "Subirlas — terminar temprano es bueno" },
      { en: "Call the office to confirm before closing — Prorate Employee Pay can cut your pay if the system thinks you closed early without cause", es: "Llamar a la oficina antes de cerrar — Prorate Employee Pay puede reducir su pago si el sistema piensa que cerró temprano sin causa" },
      { en: "Just Clock Out for the day", es: "Solo hacer Clock Out del día" },
      { en: "Sit in the parking lot until 3 hours have passed", es: "Quedarse en el estacionamiento hasta que pasen las 3 horas" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-11-fixit",
    moduleId: "compensation",
    prompt: { en: "A Fix-It call is dispatched to your team because of a client complaint on yesterday's job. How is the returning team paid?", es: "Una llamada Fix-It es enviada a su equipo por una queja del trabajo de ayer. ¿Cómo se le paga al equipo que regresa?" },
    options: [
      { en: "Not paid — Fix-It is on the tech who did the original job", es: "Sin pago — Fix-It es por cuenta del técnico original" },
      { en: "Paid normally — Phes covers the labor; we never refuse a guarantee call", es: "Pago normal — Phes cubre la mano de obra; nunca rechazamos una llamada de garantía" },
      { en: "Half pay — Fix-It is a partial credit", es: "Medio pago — Fix-It es un crédito parcial" },
      { en: "Cash bonus on top of regular pay", es: "Bono en efectivo sobre el pago regular" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-12-quality-probation",
    moduleId: "compensation",
    prompt: { en: "What triggers Quality Probation?", es: "¿Qué activa el Periodo de Prueba de Calidad?" },
    options: [
      { en: "1 client complaint in any 30 days", es: "1 queja en cualquier 30 días" },
      { en: "2 client complaints in any 30-day window", es: "2 quejas en cualquier ventana de 30 días" },
      { en: "5 complaints in a year", es: "5 quejas en un año" },
      { en: "Any negative review online", es: "Cualquier reseña negativa en línea" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-13-probation-pay",
    moduleId: "compensation",
    prompt: { en: "You're on Quality Probation. What's your pay structure during the 30 days?", es: "Está en Periodo de Prueba. ¿Cuál es su estructura de pago durante los 30 días?" },
    options: [
      { en: "Normal commission, just no tips", es: "Comisión normal, sin propinas" },
      { en: "$20/hr training rate, no commission, while you ride along with senior techs", es: "Tarifa de entrenamiento $20/hr, sin comisión, mientras acompaña a técnicos senior" },
      { en: "Half commission", es: "Media comisión" },
      { en: "No pay until you complete the probation", es: "Sin pago hasta completar la prueba" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-14-mileage",
    moduleId: "compensation",
    prompt: { en: "Which of these is NOT covered by mileage reimbursement?", es: "¿Cuál de estos NO está cubierto por el reembolso de millaje?" },
    options: [
      { en: "Driving from Client A's home to Client B's home", es: "Manejar de la casa del Cliente A a la del B" },
      { en: "Driving back to the office mid-day to swap supplies", es: "Manejar a la oficina a media-tarde para cambiar suministros" },
      { en: "Driving from your home to your first job of the day (commute)", es: "Manejar de su casa al primer trabajo del día (trayecto)" },
      { en: "Driving to a Fix-It call", es: "Manejar a una llamada Fix-It" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-cm-15-payroll-cycle",
    moduleId: "compensation",
    prompt: { en: "How often is payroll deposited?", es: "¿Con qué frecuencia se deposita la nómina?" },
    options: [
      { en: "Weekly, every Friday", es: "Semanal, cada viernes" },
      { en: "Biweekly, every other Friday", es: "Quincenal, cada dos viernes" },
      { en: "Monthly on the 1st", es: "Mensual el día 1" },
      { en: "Same-day cash at the end of each shift", es: "Efectivo el mismo día al final de cada turno" },
    ],
    correctIndex: 1,
  },

  // ═════════════════════════════════════════════════════════════════════════════
  // Module 3: CLEANING BEST PRACTICES (15 questions)
  // ═════════════════════════════════════════════════════════════════════════════
  {
    id: "q-cb-01-room-flow",
    moduleId: "cleaning-best-practices",
    prompt: { en: "You arrive at a client's home for a standard clean. Which room do you start in?", es: "Llega al hogar de un cliente para una limpieza estándar. ¿En qué habitación empieza?" },
    options: [
      { en: "The kitchen — it's the dirtiest", es: "La cocina — es la más sucia" },
      { en: "The room farthest from the entrance, working back toward the door", es: "La habitación más lejana de la entrada, trabajando hacia la puerta" },
      { en: "Whichever room the client is not currently in", es: "La habitación donde el cliente no esté en ese momento" },
      { en: "The bathroom — to give chemicals time to sit", es: "El baño — para que los químicos tengan tiempo de actuar" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cb-02-room-order",
    moduleId: "cleaning-best-practices",
    prompt: { en: "You're cleaning a bedroom. In what order do you work the surfaces?", es: "Está limpiando un dormitorio. ¿En qué orden trabaja las superficies?" },
    options: [
      { en: "Floors first so they dry while you do the rest", es: "Pisos primero para que se sequen mientras hace el resto" },
      { en: "Whatever the client prefers", es: "Lo que el cliente prefiera" },
      { en: "Top to bottom — vents, shelves, then baseboards and floor last", es: "De arriba hacia abajo — rejillas, estantes, luego rodapiés y piso al final" },
      { en: "Side to side — order doesn't matter", es: "De un lado al otro — el orden no importa" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-cb-03-direction",
    moduleId: "cleaning-best-practices",
    prompt: { en: "You're cleaning a bathroom. What does 'top to bottom, left to right' mean in practice?", es: "Está limpiando un baño. ¿Qué significa 'de arriba hacia abajo, de izquierda a derecha' en la práctica?" },
    options: [
      { en: "Clean wherever looks dirtiest first", es: "Limpiar donde se vea más sucio primero" },
      { en: "Start at the highest point and move in one consistent direction so you never re-contaminate a clean surface", es: "Empezar en el punto más alto y moverse en una dirección consistente para no contaminar de nuevo una superficie ya limpia" },
      { en: "Floors first, then mirrors, then walls", es: "Pisos primero, luego espejos, luego paredes" },
      { en: "Whichever direction your dominant hand prefers", es: "La dirección que prefiera su mano dominante" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cb-04-dwell",
    moduleId: "cleaning-best-practices",
    prompt: { en: "Why do we spray a surface and then move to another task in the same room before wiping?", es: "¿Por qué rociamos una superficie y pasamos a otra tarea en la misma habitación antes de limpiar?" },
    options: [
      { en: "To stretch the job to the assigned time", es: "Para estirar el trabajo al tiempo asignado" },
      { en: "To let the product dwell and do its work — when we come back, it wipes off faster and more effectively", es: "Para dejar que el producto repose y haga su trabajo — al regresar, se limpia más rápido y mejor" },
      { en: "Because the chemical needs sunlight to activate", es: "Porque el químico necesita luz solar para activarse" },
      { en: "To avoid breathing in the spray", es: "Para no respirar el rociador" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cb-05-load-caddy",
    moduleId: "cleaning-best-practices",
    prompt: { en: "You enter a bathroom and realize your glass cleaner is back in the hallway. What should you have done?", es: "Entra al baño y se da cuenta que su limpiador de vidrio quedó en el pasillo. ¿Qué debería haber hecho?" },
    options: [
      { en: "Make a quick trip back — no big deal", es: "Hacer un viaje rápido — no es gran cosa" },
      { en: "Loaded your caddy completely before entering — every cloth, every product, in one trip", es: "Cargar el portasuministros completamente antes de entrar — cada paño, cada producto, en un solo viaje" },
      { en: "Skip the mirror — use only what you have", es: "Saltarse el espejo — usar solo lo que tenga" },
      { en: "Ask the client to lend you cleaner", es: "Pedirle al cliente que le preste limpiador" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cb-06-spattern",
    moduleId: "cleaning-best-practices",
    prompt: { en: "What's the correct wiping pattern for mirrors and glass?", es: "¿Cuál es el patrón correcto para limpiar espejos y vidrio?" },
    options: [
      { en: "Tight circular motions — they cover the most surface", es: "Movimientos circulares apretados — cubren más superficie" },
      { en: "Up-and-down only", es: "Solo de arriba hacia abajo" },
      { en: "S-pattern — circular motions leave streaks; the S-pattern lifts dirt cleanly", es: "Patrón en S — los círculos dejan rayas; la S levanta la suciedad limpiamente" },
      { en: "Whatever pattern feels natural", es: "Cualquier patrón que se sienta natural" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-cb-07-backout-mop",
    moduleId: "cleaning-best-practices",
    prompt: { en: "You just finished mopping the kitchen floor. How do you leave the room?", es: "Acaba de terminar de trapear el piso de la cocina. ¿Cómo sale de la habitación?" },
    options: [
      { en: "Walk straight out the same way you came in", es: "Salir caminando recto por donde entró" },
      { en: "Back out — never walk on a freshly mopped floor or you'll leave footprints", es: "Salir de espaldas — nunca camine sobre piso recién trapeado o dejará huellas" },
      { en: "Wait inside until the floor dries", es: "Esperar dentro hasta que el piso se seque" },
      { en: "Open a window first, then walk out", es: "Abrir una ventana primero, luego salir" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cb-08-standard-not-time",
    moduleId: "cleaning-best-practices",
    prompt: { en: "What does 'clean to a standard, not to a time' mean?", es: "¿Qué significa 'limpiar a un estándar, no a un tiempo'?" },
    options: [
      { en: "Take as long as you want — time doesn't matter", es: "Tomar el tiempo que quiera — el tiempo no importa" },
      { en: "Don't rush. Finish the job correctly. Efficiency comes from technique, not from cutting corners.", es: "No se apresure. Termine correctamente. La eficiencia viene de la técnica, no de tomar atajos." },
      { en: "Clean only the visible dirty spots", es: "Limpiar solo las manchas visibles" },
      { en: "Skip surfaces that look already clean", es: "Saltarse superficies que ya se vean limpias" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cb-09-vacuum-before-mop",
    moduleId: "cleaning-best-practices",
    prompt: { en: "Why do we always vacuum before mopping?", es: "¿Por qué siempre aspiramos antes de trapear?" },
    options: [
      { en: "Because the vacuum is louder — get the loud thing out of the way", es: "Porque la aspiradora es más ruidosa — sacar el ruido primero" },
      { en: "Mopping a dusty floor smears the dust into a film instead of removing it", es: "Trapear un piso con polvo lo esparce en una capa en lugar de removerlo" },
      { en: "It saves vacuum batteries", es: "Ahorra batería de la aspiradora" },
      { en: "It doesn't matter which order — preference only", es: "El orden no importa — solo es preferencia" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cb-10-team-arrival",
    moduleId: "cleaning-best-practices",
    prompt: { en: "You arrive at a client's home five minutes before your partner. The client has given you the door code. What do you do?", es: "Llega al hogar del cliente cinco minutos antes que su compañero. El cliente le dio el código de la puerta. ¿Qué hace?" },
    options: [
      { en: "Go in and start working — get a head start", es: "Entra y empieza a trabajar — adelantar trabajo" },
      { en: "Wait outside for your partner — you enter together as a team", es: "Esperar afuera a su compañero — entran juntos como equipo" },
      { en: "Knock once, then enter alone if no one answers", es: "Tocar una vez, luego entrar solo" },
      { en: "Call the office to ask permission to enter alone", es: "Llamar a la oficina para pedir permiso de entrar solo" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cb-11-supplies-left",
    moduleId: "cleaning-best-practices",
    prompt: { en: "You arrive at your second job and realize you left your supply bag at the previous client's home. What do you do?", es: "Llega a su segundo trabajo y se da cuenta que dejó la bolsa de suministros en la casa anterior. ¿Qué hace?" },
    options: [
      { en: "Use the client's own products — they'll understand", es: "Usar los productos del cliente — entenderán" },
      { en: "Call the office immediately — do not proceed without supplies", es: "Llamar a la oficina inmediatamente — no proceder sin suministros" },
      { en: "Skip the job and drive home", es: "Saltarse el trabajo y manejar a casa" },
      { en: "Try to clean by hand without supplies", es: "Intentar limpiar a mano sin suministros" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cb-12-color-cloths",
    moduleId: "cleaning-best-practices",
    prompt: { en: "Which color cloth do you use for the kitchen counters?", es: "¿Qué color de paño usa para los mostradores de cocina?" },
    options: [
      { en: "Yellow", es: "Amarillo" },
      { en: "Blue", es: "Azul" },
      { en: "Green", es: "Verde" },
      { en: "White", es: "Blanco" },
    ],
    correctIndex: 0,
  },
  {
    id: "q-cb-13-two-hand",
    moduleId: "cleaning-best-practices",
    prompt: { en: "What does 'two-hand technique' mean while cleaning?", es: "¿Qué significa la 'técnica de dos manos' al limpiar?" },
    options: [
      { en: "Using two cloths in one hand to cover more area", es: "Usar dos paños en una mano para cubrir más" },
      { en: "Wet cloth in one hand, dry cloth or spray bottle in the other — both hands working at once", es: "Paño húmedo en una mano, paño seco o atomizador en la otra — ambas manos trabajando a la vez" },
      { en: "Trading off cleaning duties with your partner every 5 minutes", es: "Intercambiar tareas con su compañero cada 5 minutos" },
      { en: "Always carrying the supply bag with both hands", es: "Siempre cargar la bolsa con ambas manos" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cb-14-dont-backtrack",
    moduleId: "cleaning-best-practices",
    prompt: { en: "You finished cleaning the upper cabinets, then notice a smudge while cleaning lower cabinets. What's the right move?", es: "Terminó los gabinetes superiores, luego nota una mancha al limpiar los inferiores. ¿Cuál es la acción correcta?" },
    options: [
      { en: "Stop the lower cabinet, go back to the upper, fix it, then return", es: "Pare el inferior, regrese al superior, corrija, luego regrese" },
      { en: "Finish the lower cabinet first, then go back. Backtracking adds time and breaks the flow — you'll often miss spots elsewhere when you do it.", es: "Termine el inferior primero, luego regrese. Regresar añade tiempo y rompe el flujo — frecuentemente se pierde otras manchas al hacerlo." },
      { en: "Skip the smudge — you finished that cabinet already", es: "Saltarse la mancha — ya terminó ese gabinete" },
      { en: "Ask your partner to handle the upper", es: "Pedir a su compañero que limpie el superior" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cb-15-conflict-worksheet-note",
    moduleId: "cleaning-best-practices",
    prompt: { en: "The Worksheet says 'vacuum all rugs' but the client note says 'don't move the rug under the dining table.' What do you do?", es: "La Hoja de Trabajo dice 'aspirar todas las alfombras' pero la nota del cliente dice 'no mueva la alfombra bajo la mesa del comedor.' ¿Qué hace?" },
    options: [
      { en: "Vacuum every rug — the standard scope wins", es: "Aspirar cada alfombra — el alcance estándar gana" },
      { en: "Skip vacuuming completely — instructions conflict", es: "No aspirar nada — las instrucciones se contradicen" },
      { en: "Follow the client note — leave the dining-table rug alone, vacuum the rest", es: "Seguir la nota del cliente — deja la alfombra del comedor, aspira las demás" },
      { en: "Ask the client mid-clean which they prefer", es: "Preguntar al cliente durante la limpieza" },
    ],
    correctIndex: 2,
  },

  // ═════════════════════════════════════════════════════════════════════════════
  // Module 4: MAIDCENTRAL (15 questions)
  // ═════════════════════════════════════════════════════════════════════════════
  {
    id: "q-mc-01-clock-vs-check",
    moduleId: "maidcentral",
    prompt: { en: "You start your workday at 8:00 AM. What's the very first thing you do in MaidCentral?", es: "Comienza su día a las 8:00 AM. ¿Qué es lo primero que hace en MaidCentral?" },
    options: [
      { en: "Check In to your first job", es: "Check In en su primer trabajo" },
      { en: "Clock In for the workday", es: "Clock In para el día de trabajo" },
      { en: "Open the Job Worksheet for the day", es: "Abrir la Hoja de Trabajo del día" },
      { en: "Submit yesterday's mileage", es: "Enviar el millaje de ayer" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-02-arrive-first-job",
    moduleId: "maidcentral",
    prompt: { en: "You arrive at a client's home. You already Clocked In for the day. What do you do now?", es: "Llega al hogar del cliente. Ya hizo Clock In del día. ¿Qué hace ahora?" },
    options: [
      { en: "Clock In again", es: "Hacer Clock In otra vez" },
      { en: "Check In on the specific job — your Day Clock keeps running", es: "Hacer Check In en el trabajo específico — el Reloj de Día sigue corriendo" },
      { en: "Open the Worksheet — Check In can wait", es: "Abrir la Hoja de Trabajo — el Check In puede esperar" },
      { en: "Submit yesterday's mileage", es: "Enviar el millaje de ayer" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-03-individual-clocks",
    moduleId: "maidcentral",
    prompt: { en: "You both arrive at a job at 9:00 AM. You Check In immediately. Your partner stays in the car and doesn't Check In until 9:20 AM. How is pay calculated?", es: "Ambos llegan a las 9:00 AM. Usted hace Check In de inmediato. Su compañero se queda en el auto hasta las 9:20 AM. ¿Cómo se calcula el pago?" },
    options: [
      { en: "Split 50/50 — same job, same pay", es: "Se divide 50/50 — mismo trabajo, mismo pago" },
      { en: "MaidCentral averages your times together", es: "MaidCentral promedia los tiempos" },
      { en: "Your Job Clock shows more time on site, so you receive a higher commission share", es: "Su Reloj de Trabajo muestra más tiempo en sitio, recibe mayor parte de la comisión" },
      { en: "Whoever Checks Out first earns more", es: "Quien haga Check Out primero gana más" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-mc-04-gps-distance",
    moduleId: "maidcentral",
    prompt: { en: "You're about to Check In, but you're still in your car parked two blocks away. What should you do?", es: "Está por hacer Check In, pero aún está en su auto a dos cuadras. ¿Qué debe hacer?" },
    options: [
      { en: "Check In now — close enough", es: "Hacer Check In ahora — está suficientemente cerca" },
      { en: "Drive to the property and walk to the door — Check In only when physically on site", es: "Manejar a la propiedad y caminar a la puerta — hacer Check In solo en sitio" },
      { en: "Skip Check In — GPS won't notice", es: "Saltar Check In — el GPS no notará" },
      { en: "Check In from home tomorrow", es: "Check In desde casa mañana" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-05-600-feet",
    moduleId: "maidcentral",
    prompt: { en: "Approximately how close to the property must you be for MaidCentral to allow Check In?", es: "¿Aproximadamente qué tan cerca debe estar de la propiedad para que MaidCentral permita el Check In?" },
    options: [
      { en: "5 miles", es: "5 millas" },
      { en: "1 mile", es: "1 milla" },
      { en: "Within 600 feet", es: "Dentro de 600 pies" },
      { en: "Anywhere — there's no GPS check", es: "Cualquier lugar — no hay revisión de GPS" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-mc-06-efficiency",
    moduleId: "maidcentral",
    prompt: { en: "What is your efficiency score and how is it calculated?", es: "¿Qué es su puntuación de eficiencia y cómo se calcula?" },
    options: [
      { en: "Number of jobs completed per day", es: "Número de trabajos completados por día" },
      { en: "Total Job Clock hours divided by total Day Clock hours — how much of your day was spent actively cleaning", es: "Total horas Reloj de Trabajo dividido por total Reloj de Día — cuánto del día fue limpieza activa" },
      { en: "Your client satisfaction score average", es: "Su promedio de satisfacción del cliente" },
      { en: "Total tips earned divided by hours worked", es: "Total propinas dividido por horas trabajadas" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-07-efficiency-target",
    moduleId: "maidcentral",
    prompt: { en: "What is the Phes target efficiency score?", es: "¿Cuál es la meta de eficiencia de Phes?" },
    options: [
      { en: "50%+", es: "50%+" },
      { en: "60%+", es: "60%+" },
      { en: "70%+", es: "70%+" },
      { en: "100%", es: "100%" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-mc-08-forgot-checkout",
    moduleId: "maidcentral",
    prompt: { en: "You realize you forgot to Check Out of your last job two hours ago. What's the right way to fix it?", es: "Se da cuenta que olvidó hacer Check Out hace dos horas. ¿Cómo lo corrige?" },
    options: [
      { en: "Text your manager", es: "Mensaje al gerente" },
      { en: "DM the office on Slack", es: "DM a la oficina en Slack" },
      { en: "Submit a Clock/Job Change Request through MaidCentral — the office reviews and approves", es: "Enviar Clock/Job Change Request en MaidCentral — la oficina revisa y aprueba" },
      { en: "Don't worry — payroll will figure it out", es: "No preocuparse — la nómina lo resolverá" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-mc-09-travel-pay",
    moduleId: "maidcentral",
    prompt: { en: "What is travel pay?", es: "¿Qué es el pago de traslado?" },
    options: [
      { en: "A bonus paid for long drives between cities", es: "Un bono por manejos largos entre ciudades" },
      { en: "Time when you're Clocked In for the day but NOT Checked Into a job — covers drive time between client homes", es: "Tiempo en que está con Clock In del día pero NO con Check In en un trabajo — cubre traslado entre hogares" },
      { en: "Reimbursement for gas only", es: "Reembolso solo de gasolina" },
      { en: "Pay for going to and from your home each day", es: "Pago por ir y venir de su casa cada día" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-10-commute-not-paid",
    moduleId: "maidcentral",
    prompt: { en: "Is the drive from your home to your first job of the day paid as travel pay?", es: "¿El manejo de su casa al primer trabajo del día se paga como travel pay?" },
    options: [
      { en: "Yes — any drive once Clocked In is paid", es: "Sí — cualquier manejo después de Clock In se paga" },
      { en: "No — that's commute, not travel. Travel pay covers drives BETWEEN client homes only.", es: "No — es trayecto, no traslado. Travel pay cubre manejos ENTRE hogares de clientes." },
      { en: "Only if you live more than 30 miles away", es: "Solo si vive a más de 30 millas" },
      { en: "Yes if you Clock In before leaving home", es: "Sí si hace Clock In antes de salir de casa" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-11-end-of-day",
    moduleId: "maidcentral",
    prompt: { en: "You finish your last job of the day. What's the correct order of actions?", es: "Termina su último trabajo del día. ¿Cuál es el orden correcto?" },
    options: [
      { en: "Clock Out, then Check Out of the job", es: "Clock Out, luego Check Out del trabajo" },
      { en: "Check Out of the job, then Clock Out for the day", es: "Check Out del trabajo, luego Clock Out del día" },
      { en: "Just Clock Out — Check Out happens automatically", es: "Solo Clock Out — el Check Out se hace solo" },
      { en: "Order doesn't matter", es: "El orden no importa" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-12-conflict-note",
    moduleId: "maidcentral",
    prompt: { en: "The Worksheet and a client note give different instructions for the same item. Who wins?", es: "La Hoja de Trabajo y una nota del cliente dan instrucciones diferentes. ¿Cuál gana?" },
    options: [
      { en: "Worksheet always wins — it's the standard scope", es: "Hoja de Trabajo siempre gana — es el alcance estándar" },
      { en: "Client note wins on the specific item; the rest of the Worksheet still applies", es: "La nota del cliente gana en lo específico; el resto de la Hoja sigue aplicando" },
      { en: "Whichever you read first", es: "La que lea primero" },
      { en: "Ask the client mid-clean", es: "Preguntar al cliente durante la limpieza" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-13-commercial-finished-early",
    moduleId: "maidcentral",
    prompt: { en: "Your commercial job is assigned 3 hours. You finish in 1.5 hours. What do you do BEFORE uploading completion photos?", es: "Su trabajo comercial tiene 3 horas asignadas. Termina en 1.5 horas. ¿Qué hace ANTES de subir fotos?" },
    options: [
      { en: "Upload them — finishing early is good", es: "Subirlas — terminar temprano es bueno" },
      { en: "Call the office to confirm before closing — Prorate Employee Pay can cut your pay if it looks like you closed early without cause", es: "Llamar a la oficina antes de cerrar — Prorate Employee Pay puede reducir su pago" },
      { en: "Just Clock Out for the day", es: "Solo Clock Out del día" },
      { en: "Sit in the parking lot until 3 hours have passed", es: "Quedarse en el estacionamiento hasta que pasen las 3 horas" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-14-qleno-coming",
    moduleId: "maidcentral",
    prompt: { en: "What is Qleno's relationship to MaidCentral at Phes?", es: "¿Cuál es la relación de Qleno con MaidCentral en Phes?" },
    options: [
      { en: "Qleno is a separate company unrelated to Phes", es: "Qleno es una compañía aparte sin relación con Phes" },
      { en: "Qleno is the company's own platform that will replace MaidCentral over the next several months", es: "Qleno es la plataforma propia de la compañía que reemplazará a MaidCentral en los próximos meses" },
      { en: "Qleno is a backup app for emergencies only", es: "Qleno es una app de respaldo solo para emergencias" },
      { en: "Qleno is a customer-facing booking site only", es: "Qleno es solo un sitio de reservas para clientes" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-15-day-clock-running",
    moduleId: "maidcentral",
    prompt: { en: "Between Job A and Job B, you stop for gas and lunch. Are you on the Day Clock?", es: "Entre el Trabajo A y B, para por gasolina y almuerzo. ¿Está con Clock In del día?" },
    options: [
      { en: "Day Clock paused — only running while at jobs", es: "El Reloj de Día se pausa — solo corre durante trabajos" },
      { en: "Yes — Day Clock keeps running. Lunch is unpaid only if you Clock Out and back In; gas during travel is paid travel time.", es: "Sí — el Reloj de Día sigue corriendo. El almuerzo es sin pago solo si hace Clock Out y back In; la gasolina durante el traslado se paga." },
      { en: "Day Clock pauses automatically when you stop driving", es: "El Reloj de Día se pausa automáticamente cuando deja de manejar" },
      { en: "It depends on the length of the stop", es: "Depende de la duración de la parada" },
    ],
    correctIndex: 1,
  },

  // ═════════════════════════════════════════════════════════════════════════════
  // Module 5: PRODUCTS & TOOLS (15 questions)
  // ═════════════════════════════════════════════════════════════════════════════
  {
    id: "q-pt-01-granite",
    moduleId: "products-tools",
    prompt: { en: "You're about to wipe a granite kitchen countertop. Which product should you NEVER use on it?", es: "Está por limpiar un mostrador de granito. ¿Qué producto NUNCA debe usar?" },
    options: [
      { en: "Mr. Clean with Febreze on a yellow cloth", es: "Mr. Clean con Febreze en paño amarillo" },
      { en: "A damp microfiber cloth with water", es: "Paño de microfibra húmedo con agua" },
      { en: "Bar Keepers Friend Liquid", es: "Bar Keepers Friend Líquido" },
      { en: "Diluted Simple Green at 1:30", es: "Simple Green diluido a 1:30" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pt-02-mop",
    moduleId: "products-tools",
    prompt: { en: "You're about to mop a hardwood floor with the OCedar Deep Clean Mop. What do you do first?", es: "Está por trapear un piso de madera con el OCedar Deep Clean Mop. ¿Qué hace primero?" },
    options: [
      { en: "Soak the mop fully so it cleans deeper", es: "Empapar el trapeador para limpiar más profundo" },
      { en: "Wring the mop thoroughly so it's damp, not soaked", es: "Escurrir bien para que esté húmedo, no empapado" },
      { en: "Spray the cleaner directly on the floor", es: "Rociar el limpiador directamente al piso" },
      { en: "Use the mop dry — water can warp wood", es: "Usar el trapeador seco — el agua deforma la madera" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pt-03-glass",
    moduleId: "products-tools",
    prompt: { en: "You need to clean a bathroom mirror. Where do you spray the Ecolab glass cleaner?", es: "Necesita limpiar un espejo del baño. ¿Dónde rocía el limpiador de vidrio Ecolab?" },
    options: [
      { en: "Directly on the mirror, then wipe in circles", es: "Directamente al espejo, luego en círculos" },
      { en: "On a yellow cloth, then wipe", es: "En paño amarillo, luego limpiar" },
      { en: "On a blue microfiber cloth, then wipe in S-pattern", es: "En paño de microfibra azul, luego patrón en S" },
      { en: "On the floor first, so it doesn't drip", es: "Al piso primero, para que no gotee" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pt-04-simplegreen",
    moduleId: "products-tools",
    prompt: { en: "You're prepping Simple Green for light surface cleaning. What's the right dilution?", es: "Está preparando Simple Green para limpieza ligera. ¿Cuál es la dilución correcta?" },
    options: [
      { en: "Full strength — Simple Green is always full strength", es: "Fuerza total — Simple Green siempre va a fuerza total" },
      { en: "1:10", es: "1:10" },
      { en: "1:30", es: "1:30" },
      { en: "1:100", es: "1:100" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pt-05-zep-bleach",
    moduleId: "products-tools",
    prompt: { en: "You're using Zep Mold & Mildew Stain Remover in a bathroom. Which product MUST you NOT mix it with?", es: "Está usando Zep Mold & Mildew Stain Remover en un baño. ¿Con qué producto NUNCA debe mezclarlo?" },
    options: [
      { en: "Soap and water", es: "Jabón y agua" },
      { en: "Bar Keepers Friend", es: "Bar Keepers Friend" },
      { en: "Ammonia-based products like Windex (creates toxic fumes)", es: "Productos con amoníaco como Windex (genera gases tóxicos)" },
      { en: "Pumice stone", es: "Piedra pómez" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pt-06-zep-fabric",
    moduleId: "products-tools",
    prompt: { en: "You're spraying Zep Mold & Mildew on shower caulk. The client's blue bath mat is a few feet away. What's the risk?", es: "Está rociando Zep Mold & Mildew en el sellador de la ducha. El tapete azul del cliente está a pocos pies. ¿Cuál es el riesgo?" },
    options: [
      { en: "No risk — Zep is safe on fabrics", es: "Sin riesgo — Zep es seguro en telas" },
      { en: "Zep contains bleach — overspray on a colored bath mat will permanently bleach it. Move the mat first.", es: "Zep contiene cloro — la sobreaspersión en un tapete de color lo decolorará permanentemente. Mueva el tapete primero." },
      { en: "It will only stain dark fabrics", es: "Solo manchará telas oscuras" },
      { en: "It evaporates before reaching the mat", es: "Se evapora antes de llegar al tapete" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pt-07-magic-eraser-paint",
    moduleId: "products-tools",
    prompt: { en: "The client asks you to remove a small scuff from a matte-painted living room wall. What do you do?", es: "El cliente le pide remover una marca pequeña de una pared de sala con pintura mate. ¿Qué hace?" },
    options: [
      { en: "Use a Magic Eraser with firm pressure to remove it fully", es: "Usar Borrador Mágico con presión firme para removerla completamente" },
      { en: "Test the Magic Eraser in an inconspicuous spot first; on matte paint it can DULL the finish and leave a visibly cleaner spot — sometimes leave a small scuff alone, or note for the office", es: "Probar el Borrador Mágico en un lugar discreto primero; en pintura mate puede DAÑAR el acabado y dejar una mancha visiblemente más limpia — a veces dejar la marca, o anotar para la oficina" },
      { en: "Use #0000 steel wool", es: "Usar lana de acero #0000" },
      { en: "Wipe it with Bar Keepers Friend", es: "Limpiar con Bar Keepers Friend" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pt-08-magic-eraser-glass",
    moduleId: "products-tools",
    prompt: { en: "Where IS a Magic Eraser a great tool to use?", es: "¿Dónde SÍ es buena herramienta el Borrador Mágico?" },
    options: [
      { en: "Polished marble countertops", es: "Mostradores de mármol pulido" },
      { en: "Stainless steel appliance fronts", es: "Frentes de electrodomésticos de acero" },
      { en: "Soap scum on glass shower doors and scuff marks on baseboards", es: "Sarro en puertas de ducha de vidrio y marcas en rodapiés" },
      { en: "Chrome faucets", es: "Llaves cromadas" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pt-09-pumice-where",
    moduleId: "products-tools",
    prompt: { en: "Where is the ONLY surface where pumice stone is appropriate?", es: "¿Cuál es la ÚNICA superficie apropiada para la piedra pómez?" },
    options: [
      { en: "Inside an unsealed white porcelain toilet bowl, on hard-water rings", es: "Dentro de un inodoro de porcelana blanca sin sellar, en anillos de agua dura" },
      { en: "Fiberglass tubs to remove soap scum", es: "Tinas de fibra de vidrio para sarro" },
      { en: "Chrome faucets for stuck mineral deposits", es: "Llaves cromadas para depósitos minerales" },
      { en: "Glass cooktops", es: "Estufas de vidrio" },
    ],
    correctIndex: 0,
  },
  {
    id: "q-pt-10-pumice-wet",
    moduleId: "products-tools",
    prompt: { en: "Before using a pumice stone, what do you have to do?", es: "Antes de usar piedra pómez, ¿qué debe hacer?" },
    options: [
      { en: "Heat it under hot water to soften it", es: "Calentarla con agua caliente para ablandarla" },
      { en: "Use it dry — water reduces its effectiveness", es: "Usarla seca — el agua reduce su efectividad" },
      { en: "Wet both the stone AND the surface — dry pumice scratches", es: "Mojar la piedra Y la superficie — la piedra seca raya" },
      { en: "Coat it in soap first", es: "Cubrirla con jabón primero" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pt-11-steel-wool-grade",
    moduleId: "products-tools",
    prompt: { en: "Phes stocks several steel-wool grades. Which grade is approved for use in client homes?", es: "Phes tiene varios grados de lana de acero. ¿Cuál grado se permite en hogares de clientes?" },
    options: [
      { en: "#0 — coarse, removes anything", es: "#0 — gruesa, remueve cualquier cosa" },
      { en: "#00 — medium", es: "#00 — media" },
      { en: "#000 — fine", es: "#000 — fina" },
      { en: "#0000 — extra fine; coarser grades scratch", es: "#0000 — extra fina; grados más gruesos rayan" },
    ],
    correctIndex: 3,
  },
  {
    id: "q-pt-12-steel-wool-chrome",
    moduleId: "products-tools",
    prompt: { en: "There's a hard mineral deposit on a chrome faucet. Should you use #0000 steel wool to remove it?", es: "Hay un depósito mineral en una llave cromada. ¿Debe usar lana de acero #0000 para removerlo?" },
    options: [
      { en: "Yes — #0000 is safe on all metals", es: "Sí — #0000 es segura en todos los metales" },
      { en: "No — even #0000 dulls chrome on first pass; use Bar Keepers Friend with a soft cloth instead", es: "No — incluso #0000 daña el cromo al primer pase; use Bar Keepers Friend con paño suave" },
      { en: "Yes — but only with water, no cleaner", es: "Sí — pero solo con agua, sin limpiador" },
      { en: "Yes — chrome is the right surface for steel wool", es: "Sí — el cromo es la superficie correcta para lana de acero" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pt-13-cloth-cross",
    moduleId: "products-tools",
    prompt: { en: "You're in a bathroom and your green cloth gets dirty. You finish the bathroom and head to the kitchen. Can you keep using the same green cloth?", es: "Está en un baño y su paño verde se ensució. Termina el baño y va a la cocina. ¿Puede seguir usando el mismo paño verde?" },
    options: [
      { en: "Yes — green cloths are general-purpose", es: "Sí — los paños verdes son de uso general" },
      { en: "No — green is bathroom-only. Cross-contamination from a bathroom cloth into a kitchen is a major hygiene fail.", es: "No — el verde es solo para baños. La contaminación cruzada de un paño de baño a la cocina es una falla mayor de higiene." },
      { en: "Yes if you rinse it", es: "Sí si lo enjuaga" },
      { en: "Yes if you turn it over to a clean side", es: "Sí si lo voltea al lado limpio" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pt-14-step-stool",
    moduleId: "products-tools",
    prompt: { en: "Before using the company step stool, what's the 3-point check?", es: "Antes de usar el banquito de la compañía, ¿cuál es la revisión de 3 puntos?" },
    options: [
      { en: "Color, brand, age", es: "Color, marca, antigüedad" },
      { en: "Rubber feet present (not worn smooth), hinges fully locked open with no wobble, top platform clean and dry", es: "Patas de goma presentes (no lisas), bisagras totalmente abiertas sin movimiento, plataforma limpia y seca" },
      { en: "Weight rating, height, manufacture date", es: "Peso máximo, altura, fecha de fabricación" },
      { en: "It doesn't matter — just use it", es: "No importa — solo úselo" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pt-15-furniture-stand",
    moduleId: "products-tools",
    prompt: { en: "You can't reach a high shelf even from the company step stool. What do you do?", es: "No puede alcanzar un estante alto ni con el banquito de la compañía. ¿Qué hace?" },
    options: [
      { en: "Stand on a sturdy chair from the dining room", es: "Pararse en una silla firme del comedor" },
      { en: "Stand on the kitchen counter", es: "Pararse en el mostrador" },
      { en: "Leave a note for the office and skip the surface — never improvise; never stand on furniture", es: "Dejar una nota para la oficina y saltarse la superficie — nunca improvisar; nunca pararse en muebles" },
      { en: "Stand on the top step of the step stool", es: "Pararse en el escalón superior del banquito" },
    ],
    correctIndex: 2,
  },

  // ═════════════════════════════════════════════════════════════════════════════
  // Module 6: IL SEXUAL HARASSMENT PREVENTION (15 questions, IL 820 ILCS 96)
  // ═════════════════════════════════════════════════════════════════════════════
  {
    id: "q-il-01-definition",
    moduleId: "il-sexual-harassment",
    prompt: {
      en: "Under the Illinois Human Rights Act, which of the following IS sexual harassment?",
      es: "Bajo la Ley de Derechos Humanos de Illinois, ¿cuál de los siguientes ES acoso sexual?",
    },
    options: [
      { en: "Only a supervisor making physical contact.", es: "Solo un supervisor haciendo contacto físico." },
      { en: "Any unwelcome sexual advance, request for sexual favor, or sexual conduct that makes the workplace intimidating, hostile, or offensive — OR is tied to an employment decision.", es: "Cualquier insinuación sexual no deseada, solicitud de favor sexual, o conducta sexual que haga el lugar de trabajo intimidante, hostil u ofensivo — O que esté ligada a una decisión laboral." },
      { en: "Only conduct that happens during work hours.", es: "Solo conducta que ocurre durante horas laborales." },
      { en: "Only behavior the target verbally objects to at the time.", es: "Solo conducta que el objetivo objete verbalmente en el momento." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-il-02-quid-pro-quo",
    moduleId: "il-sexual-harassment",
    prompt: {
      en: "Which of these is an example of QUID PRO QUO sexual harassment?",
      es: "¿Cuál de estos es un ejemplo de acoso sexual QUID PRO QUO?",
    },
    options: [
      { en: "A coworker tells off-color jokes in the break room.", es: "Un compañero cuenta chistes subidos de tono en el descanso." },
      { en: "A supervisor tells you that you'll get better routes if you go on a date with them.", es: "Un supervisor le dice que recibirá mejores rutas si sale con él/ella." },
      { en: "A client compliments your hair.", es: "Un cliente le elogia el cabello." },
      { en: "A coworker repeatedly asks you out and you've said yes.", es: "Un compañero le pide salir varias veces y usted ha dicho que sí." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-il-03-hostile-environment",
    moduleId: "il-sexual-harassment",
    prompt: {
      en: "Which is an example of a HOSTILE WORK ENVIRONMENT?",
      es: "¿Cuál es un ejemplo de un AMBIENTE LABORAL HOSTIL?",
    },
    options: [
      { en: "One-time inappropriate comment that was immediately corrected and never repeated.", es: "Un comentario inapropiado único que se corrigió inmediatamente y nunca se repitió." },
      { en: "A coworker repeatedly shares sexual memes in the WhatsApp work thread despite people asking them to stop.", es: "Un compañero comparte memes sexuales repetidamente en el hilo de WhatsApp del trabajo a pesar de que la gente le pide que pare." },
      { en: "A supervisor disagrees with your cleaning method.", es: "Un supervisor no está de acuerdo con su método de limpieza." },
      { en: "A client doesn't tip well.", es: "Un cliente no da buena propina." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-il-04-not-limited-by-sex",
    moduleId: "il-sexual-harassment",
    prompt: {
      en: "Can sexual harassment occur between people of the same sex, or be based on gender identity / sexual orientation?",
      es: "¿Puede ocurrir acoso sexual entre personas del mismo sexo, o basarse en identidad de género / orientación sexual?",
    },
    options: [
      { en: "No — sexual harassment is only between opposite sexes.", es: "No — el acoso sexual es solo entre sexos opuestos." },
      { en: "Yes — Illinois law protects against sexual harassment regardless of the sex, gender identity, gender expression, or sexual orientation of either party.", es: "Sí — la ley de Illinois protege contra el acoso sexual sin importar el sexo, identidad de género, expresión de género u orientación sexual de ninguna de las partes." },
      { en: "Only if both parties identify as LGBTQ.", es: "Solo si ambas partes se identifican como LGBTQ." },
      { en: "Only in private workplaces.", es: "Solo en lugares de trabajo privados." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-il-05-third-party",
    moduleId: "il-sexual-harassment",
    prompt: {
      en: "A client makes unwelcome sexual comments to you while you're cleaning their home. Is Phes responsible for doing anything about it?",
      es: "Un cliente le hace comentarios sexuales no deseados mientras limpia su casa. ¿Phes es responsable de hacer algo al respecto?",
    },
    options: [
      { en: "No — clients are not Phes employees, so there's nothing Phes can do.", es: "No — los clientes no son empleados de Phes, así que no hay nada que Phes pueda hacer." },
      { en: "Yes — Phes is legally required to investigate and act on harassment by clients or third parties just as if it were a coworker. Leave the property if you feel unsafe and call the office team immediately.", es: "Sí — Phes está legalmente obligado a investigar y actuar sobre el acoso de clientes o terceros igual que si fuera un compañero. Salga de la propiedad si se siente inseguro y llame a el equipo de la oficina inmediatamente." },
      { en: "Only if the client is also a supervisor.", es: "Solo si el cliente también es supervisor." },
      { en: "Only if the comment is in writing.", es: "Solo si el comentario está por escrito." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-il-06-reporting-channels",
    moduleId: "il-sexual-harassment",
    prompt: {
      en: "Where can you report sexual harassment at Phes?",
      es: "¿Dónde puede reportar acoso sexual en Phes?",
    },
    options: [
      { en: "Only directly to Sal — and only in person.", es: "Solo directamente con Sal — y solo en persona." },
      { en: "Internally: the office team at the office; if it involves them, the company owner directly. Externally: Illinois Department of Human Rights (IDHR) or the U.S. EEOC.", es: "Internamente: el equipo de la oficina en la oficina; si los involucra a ellos, al propietario directamente. Externamente: Departamento de Derechos Humanos de Illinois (IDHR) o EEOC de EE.UU." },
      { en: "You must use the company app — verbal reports are not accepted.", es: "Debe usar la aplicación de la compañía — los reportes verbales no se aceptan." },
      { en: "Only an attorney can file a report.", es: "Solo un abogado puede presentar un reporte." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-il-07-retaliation",
    moduleId: "il-sexual-harassment",
    prompt: {
      en: "You report sexual harassment in good faith. Later, your supervisor cuts your hours and gives you only the worst routes. Is this legal?",
      es: "Reporta acoso sexual de buena fe. Después, su supervisor le recorta las horas y le da solo las peores rutas. ¿Es legal?",
    },
    options: [
      { en: "Yes — schedules and routes are at management discretion.", es: "Sí — los horarios y rutas son a discreción de la gerencia." },
      { en: "No — federal and Illinois law strictly prohibit retaliation against anyone who reports in good faith. Reduced hours, demotion, route changes, pay cuts, or hostile treatment in response to a report are themselves additional unlawful acts you can report.", es: "No — la ley federal y de Illinois prohíben estrictamente las represalias contra cualquier persona que reporte de buena fe. Horas reducidas, descenso, cambios de ruta, recortes de pago o trato hostil en respuesta a un reporte son en sí mismos actos ilegales adicionales que puede reportar." },
      { en: "Only if the supervisor admits it's retaliation.", es: "Solo si el supervisor admite que es represalia." },
      { en: "Only if you mentioned the supervisor by name in the report.", es: "Solo si mencionó al supervisor por nombre en el reporte." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-il-08-bystander-duty",
    moduleId: "il-sexual-harassment",
    prompt: {
      en: "You overhear a teammate making unwelcome sexual comments to another tech. You are not the target. Can you report it?",
      es: "Escucha por casualidad a un compañero haciendo comentarios sexuales no deseados a otro técnico. Usted no es el objetivo. ¿Puede reportarlo?",
    },
    options: [
      { en: "No — only the person targeted can make a report.", es: "No — solo la persona objetivo puede hacer un reporte." },
      { en: "Yes — bystanders can and should report what they see or hear. Bystander reports are taken just as seriously as direct reports, and the same retaliation protections apply.", es: "Sí — los testigos pueden y deben reportar lo que ven o escuchan. Los reportes de testigos se toman con la misma seriedad que los directos, y aplican las mismas protecciones contra represalias." },
      { en: "Only if you record the conversation.", es: "Solo si graba la conversación." },
      { en: "Only if the target asks you to.", es: "Solo si el objetivo se lo pide." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-il-09-idhr-deadline",
    moduleId: "il-sexual-harassment",
    prompt: {
      en: "How long do you have to file a charge with the Illinois Department of Human Rights (IDHR) after the harassment occurred?",
      es: "¿Cuánto tiempo tiene para presentar un cargo ante el Departamento de Derechos Humanos de Illinois (IDHR) después de que ocurrió el acoso?",
    },
    options: [
      { en: "30 days.", es: "30 días." },
      { en: "180 days.", es: "180 días." },
      { en: "300 days.", es: "300 días." },
      { en: "5 years.", es: "5 años." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-il-10-eeoc-deadline",
    moduleId: "il-sexual-harassment",
    prompt: {
      en: "How long do you have to file a charge with the U.S. EEOC after the harassment occurred (in Illinois)?",
      es: "¿Cuánto tiempo tiene para presentar un cargo ante la EEOC de EE.UU. después de que ocurrió el acoso (en Illinois)?",
    },
    options: [
      { en: "30 days.", es: "30 días." },
      { en: "180 days.", es: "180 días." },
      { en: "300 days (Illinois is a deferral state, so the federal deadline extends from 180 to 300 days).", es: "300 días (Illinois es un estado con derechos diferidos, así que el plazo federal se extiende de 180 a 300 días)." },
      { en: "No deadline.", es: "Sin plazo." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-il-11-annual-retraining",
    moduleId: "il-sexual-harassment",
    prompt: {
      en: "How often does Illinois law require employees to complete sexual harassment prevention training?",
      es: "¿Con qué frecuencia requiere la ley de Illinois que los empleados completen capacitación de prevención del acoso sexual?",
    },
    options: [
      { en: "Once at hire, never again.", es: "Una vez al contratar, nunca más." },
      { en: "Every calendar year — every employee, every January (Phes refreshes this module each January).", es: "Cada año calendario — cada empleado, cada enero (Phes actualiza este módulo cada enero)." },
      { en: "Every 5 years.", es: "Cada 5 años." },
      { en: "Only when there's a reported incident.", es: "Solo cuando hay un incidente reportado." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-il-12-severe-or-pervasive",
    moduleId: "il-sexual-harassment",
    prompt: {
      en: "Does conduct have to happen multiple times before it can be sexual harassment?",
      es: "¿La conducta tiene que ocurrir varias veces antes de poder ser acoso sexual?",
    },
    options: [
      { en: "Yes — a single incident is never harassment.", es: "Sí — un solo incidente nunca es acoso." },
      { en: "No — a single severe incident (e.g., a physical assault, a serious threat) is enough. Otherwise, conduct must be severe or pervasive to a reasonable person.", es: "No — un solo incidente severo (por ejemplo, una agresión física, una amenaza seria) es suficiente. De lo contrario, la conducta debe ser severa o generalizada para una persona razonable." },
      { en: "Only after three documented incidents.", es: "Solo después de tres incidentes documentados." },
      { en: "Only if it happens during paid hours.", es: "Solo si ocurre durante horas pagadas." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-il-13-consent-withdrawn",
    moduleId: "il-sexual-harassment",
    prompt: {
      en: "You and a coworker dated previously. You ended the relationship months ago. The coworker keeps making sexual advances at work. Is this harassment?",
      es: "Usted y un compañero salieron antes. Terminó la relación hace meses. El compañero sigue haciendo insinuaciones sexuales en el trabajo. ¿Es acoso?",
    },
    options: [
      { en: "No — once you've been intimate, you can't claim harassment from the same person.", es: "No — una vez que ha tenido intimidad, no puede reclamar acoso de la misma persona." },
      { en: "Yes — past or even current consensual conduct does not waive your right to refuse new advances. Continued unwelcome sexual conduct after consent is withdrawn is harassment.", es: "Sí — la conducta consensuada pasada o incluso actual no le quita el derecho de rechazar nuevas insinuaciones. La conducta sexual no deseada continua después de retirar el consentimiento es acoso." },
      { en: "Only if you signed a no-fraternization policy.", es: "Solo si firmó una política de no-confraternización." },
      { en: "Only if the coworker reports to you.", es: "Solo si el compañero le reporta a usted." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-il-14-investigation-rights",
    moduleId: "il-sexual-harassment",
    prompt: {
      en: "After you report harassment, what should you expect from Phes?",
      es: "Después de reportar acoso, ¿qué debe esperar de Phes?",
    },
    options: [
      { en: "Nothing — Phes is not obligated to act.", es: "Nada — Phes no está obligado a actuar." },
      { en: "Prompt documented investigation (typically within 1–2 business days), confidentiality preserved as much as legally possible, no requirement to face the accused, and notification of the outcome. Schedule adjustments to keep you safe — never as a penalty.", es: "Investigación documentada rápida (típicamente dentro de 1–2 días laborales), confidencialidad mantenida tanto como sea legalmente posible, sin requerimiento de enfrentar al acusado, y notificación del resultado. Ajustes de horario para mantenerlo seguro — nunca como penalidad." },
      { en: "A public meeting with the harasser.", es: "Una reunión pública con el acosador." },
      { en: "An immediate decision the same day with no investigation.", es: "Una decisión inmediata el mismo día sin investigación." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-il-15-good-faith-protection",
    moduleId: "il-sexual-harassment",
    prompt: {
      en: "You file a good-faith report. After investigation, the conduct turns out NOT to be substantiated. Are you still protected from retaliation?",
      es: "Presenta un reporte de buena fe. Después de la investigación, la conducta NO se comprueba. ¿Sigue protegido contra represalias?",
    },
    options: [
      { en: "No — only successful reports are protected.", es: "No — solo los reportes exitosos están protegidos." },
      { en: "Yes — GOOD FAITH means you believed your report was true at the time you made it. The act of reporting in good faith is protected regardless of the outcome.", es: "Sí — BUENA FE significa que creyó que su reporte era verdadero al momento de hacerlo. El acto de reportar de buena fe está protegido sin importar el resultado." },
      { en: "Only if you reported in writing.", es: "Solo si reportó por escrito." },
      { en: "Only if the accused agrees you reported in good faith.", es: "Solo si el acusado acepta que reportó de buena fe." },
    ],
    correctIndex: 1,
  },

  // ═════════════════════════════════════════════════════════════════════════════
  // Module 7: DRUG & ALCOHOL (10 questions, Phase 3 PR #4)
  // ═════════════════════════════════════════════════════════════════════════════
  {
    id: "q-da-01-no-pre-employment-test",
    moduleId: "drug-alcohol",
    prompt: {
      en: "Does Phes require pre-employment drug testing?",
      es: "¿Phes exige una prueba de drogas antes del empleo?",
    },
    options: [
      { en: "Yes. Every new hire is drug-tested before their first day.", es: "Sí. A cada nuevo empleado se le hace prueba de drogas antes de su primer día." },
      { en: "No. Phes does not require pre-employment drug testing. This is Phes policy and is stricter than what the law requires.", es: "No. Phes no exige prueba de drogas antes del empleo. Esta es la política de Phes y es más estricta de lo que exige la ley." },
      { en: "Only for techs over 25.", es: "Solo para técnicos mayores de 25 años." },
      { en: "Only if the role involves driving.", es: "Solo si el rol implica conducir." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-da-02-impairment-not-cannabis-use",
    moduleId: "drug-alcohol",
    prompt: {
      en: "You used cannabis legally at home on Saturday. You arrive at a Monday job with no observable signs of impairment. Are you in violation of policy?",
      es: "Usó cannabis legalmente en casa el sábado. Llega a un trabajo el lunes sin signos observables de intoxicación. ¿Está en violación de la política?",
    },
    options: [
      { en: "Yes. Any cannabis use is a policy violation.", es: "Sí. Cualquier uso de cannabis es una violación de la política." },
      { en: "No. Phes does not discipline legal off-duty cannabis use. The policy applies only to OBSERVABLE impairment at work, regardless of when or where you consumed.", es: "No. Phes no disciplina el uso legal de cannabis fuera del trabajo. La política aplica solo a la intoxicación OBSERVABLE en el trabajo, sin importar cuándo o dónde consumió." },
      { en: "Yes if you tested positive at random.", es: "Sí si dio positivo en una prueba al azar." },
      { en: "Only if the client smelled it.", es: "Solo si el cliente lo olió." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-da-03-impairment-signs",
    moduleId: "drug-alcohol",
    prompt: {
      en: "Which of the following is NOT, by itself, a sign of impairment Phes can act on?",
      es: "¿Cuál de los siguientes NO es, por sí solo, un signo de intoxicación sobre el que Phes puede actuar?",
    },
    options: [
      { en: "Slurred speech and unsteady walking.", es: "Habla arrastrada y caminar inestable." },
      { en: "Bloodshot eyes plus smell of cannabis on breath.", es: "Ojos rojos más olor a cannabis en aliento." },
      { en: "A positive drug test alone (THC stays detectable for days or weeks).", es: "Una prueba positiva sola (el THC se detecta por días o semanas)." },
      { en: "Falling asleep on the job.", es: "Quedarse dormido en el trabajo." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-da-04-reasonable-suspicion-process",
    moduleId: "drug-alcohol",
    prompt: {
      en: "A coworker tells you they think another tech is impaired. What does Phes policy say about how the decision to test is made?",
      es: "Un compañero le dice que cree que otro técnico está intoxicado. ¿Qué dice la política de Phes sobre cómo se toma la decisión de hacer la prueba?",
    },
    options: [
      { en: "Coworkers can request a test on each other.", es: "Los compañeros pueden solicitar una prueba entre sí." },
      { en: "A supervisor documents observable signs and the decision to test is made by the OFFICE, not by coworkers or clients.", es: "Un supervisor documenta signos observables y la decisión de hacer la prueba la toma la OFICINA, no compañeros ni clientes." },
      { en: "The client decides whether the tech should be tested.", es: "El cliente decide si se debe hacer la prueba al técnico." },
      { en: "Whoever is in charge at the moment decides without documentation.", es: "Quien esté a cargo en el momento decide sin documentación." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-da-05-post-accident-threshold",
    moduleId: "drug-alcohol",
    prompt: {
      en: "There's a small workplace accident — minor scratch on a client's wall, no one is hurt, repair would cost about $30. Are you required to take a drug and alcohol test?",
      es: "Hay un pequeño accidente en el trabajo: un rasguño menor en la pared del cliente, nadie está lastimado, la reparación costaría unos $30. ¿Debe hacerse una prueba de drogas y alcohol?",
    },
    options: [
      { en: "Yes — any property damage triggers a test.", es: "Sí — cualquier daño a la propiedad activa una prueba." },
      { en: "No — post-accident testing is triggered by (a) physical injury to anyone OR (b) property damage of $500 or more. A $30 scratch with no injury does not meet the threshold.", es: "No — la prueba post-accidente se activa por (a) lesión física a alguien O (b) daño a propiedad de $500 o más. Un rasguño de $30 sin lesiones no cumple el umbral." },
      { en: "Only if a supervisor saw the accident happen.", es: "Solo si un supervisor vio ocurrir el accidente." },
      { en: "Only if the client asks for it.", es: "Solo si el cliente lo pide." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-da-06-prescription-meds",
    moduleId: "drug-alcohol",
    prompt: {
      en: "Your doctor prescribes a new medication that may cause drowsiness as a side effect. What does Phes policy say you should do?",
      es: "Su doctor le receta un nuevo medicamento que puede causar somnolencia como efecto secundario. ¿Qué dice la política de Phes que debe hacer?",
    },
    options: [
      { en: "Tell the office your full diagnosis and the medication name before starting it.", es: "Decir a la oficina su diagnóstico completo y el nombre del medicamento antes de empezar." },
      { en: "Inform the office BEFORE starting the medication that a prescribed medication may impair your ability to perform safely. You do NOT have to disclose the diagnosis or medication name. The office discusses accommodation (schedule changes, modified duties, etc.).", es: "Informar a la oficina ANTES de empezar el medicamento que una medicina recetada puede afectar su capacidad de desempeñarse con seguridad. NO tiene que divulgar el diagnóstico ni el nombre del medicamento. La oficina discute acomodación (cambios de horario, tareas modificadas, etc.)." },
      { en: "Stop taking the medication while you work.", es: "Dejar de tomar el medicamento mientras trabaja." },
      { en: "Nothing — prescription meds are your private business.", es: "Nada — los medicamentos recetados son su asunto privado." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-da-07-refusal-to-test",
    moduleId: "drug-alcohol",
    prompt: {
      en: "The office sends you for a reasonable-suspicion drug test based on documented observable signs. You refuse. What is the consequence under Phes policy?",
      es: "La oficina lo envía a una prueba de drogas por sospecha razonable basada en signos observables documentados. Usted se rehúsa. ¿Cuál es la consecuencia bajo la política de Phes?",
    },
    options: [
      { en: "A written warning and you keep working.", es: "Una advertencia por escrito y sigue trabajando." },
      { en: "Immediate termination. Refusal is treated the same as a positive test, regardless of whether you would have actually tested positive.", es: "Terminación inmediata. La negativa se trata igual que un resultado positivo, sin importar si efectivamente habría dado positivo." },
      { en: "You may take the test the next day instead.", es: "Puede hacer la prueba al día siguiente." },
      { en: "Nothing — refusing a test is your right.", es: "Nada — rehusarse a una prueba es su derecho." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-da-08-discipline-scale",
    moduleId: "drug-alcohol",
    prompt: {
      en: "You test positive after an incident with documented observable signs. It is your FIRST positive. What happens under the Phes discipline scale?",
      es: "Da positivo después de un incidente con signos observables documentados. Es su PRIMERA positiva. ¿Qué ocurre bajo la escala de disciplina de Phes?",
    },
    options: [
      { en: "Immediate termination.", es: "Terminación inmediata." },
      { en: "Final written warning plus a last-chance agreement signed plus an EAP (Employee Assistance Program) referral offered.", es: "Advertencia final por escrito, firmar acuerdo de última oportunidad y referencia ofrecida al EAP (Programa de Asistencia al Empleado)." },
      { en: "Nothing because it's a first offense.", es: "Nada porque es la primera infracción." },
      { en: "Verbal warning only.", es: "Solo advertencia verbal." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-da-09-dui-reporting-window",
    moduleId: "drug-alcohol",
    prompt: {
      en: "You use your personal vehicle to drive between client jobs. On Saturday night you get a DUI conviction. By when must you report it to the office?",
      es: "Usa su vehículo personal para conducir entre trabajos de clientes. El sábado por la noche recibe una condena por DUI. ¿Para cuándo debe reportarlo a la oficina?",
    },
    options: [
      { en: "At your next quarterly review.", es: "En su próxima evaluación trimestral." },
      { en: "Within 72 hours of the conviction. Failure to disclose may result in immediate termination because Phes carries non-owned auto insurance that depends on your status as a lawfully-licensed driver.", es: "Dentro de 72 horas de la condena. No divulgarlo puede resultar en terminación inmediata porque Phes lleva seguro automotor no propio que depende de su estado como conductor legalmente licenciado." },
      { en: "Only if a client complains about your driving.", es: "Solo si un cliente se queja sobre su conducción." },
      { en: "Never — DUIs in personal vehicles are private.", es: "Nunca — los DUIs en vehículos personales son privados." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-da-10-license-suspension-disclosure",
    moduleId: "drug-alcohol",
    prompt: {
      en: "Your driver's license gets suspended because of unpaid tickets. You drive your personal vehicle between client jobs. Do you have to tell the office?",
      es: "Su licencia de conducir es suspendida por multas impagas. Usa su vehículo personal entre trabajos de clientes. ¿Debe avisar a la oficina?",
    },
    options: [
      { en: "No, because the suspension is for tickets, not a DUI.", es: "No, porque la suspensión es por multas, no por DUI." },
      { en: "Yes. ANY license suspension or revocation must be reported within 72 hours. So must any major moving violation (reckless driving, leaving the scene, driving without insurance, driving with a suspended license).", es: "Sí. CUALQUIER suspensión o revocación de la licencia debe reportarse dentro de 72 horas. También cualquier infracción mayor (conducción imprudente, abandonar el lugar, conducir sin seguro, conducir con licencia suspendida)." },
      { en: "Only if the office asks first.", es: "Solo si la oficina pregunta primero." },
      { en: "Only if a client sees the suspension notice.", es: "Solo si un cliente ve el aviso de suspensión." },
    ],
    correctIndex: 1,
  },

  // ═════════════════════════════════════════════════════════════════════════════
  // Module 8: CODE OF CONDUCT (10 questions, Phase 4 PR #5)
  // ═════════════════════════════════════════════════════════════════════════════
  {
    id: "q-coc-01-honesty",
    moduleId: "code-of-conduct",
    prompt: {
      en: "You finish your last job 15 minutes earlier than expected. You're tired and want to head home. What does the Code of Conduct say about clocking out?",
      es: "Termina su último trabajo 15 minutos antes de lo esperado. Está cansado y quiere irse a casa. ¿Qué dice el Código de Conducta sobre marcar la salida?",
    },
    options: [
      { en: "Clock out at the originally scheduled end time so your hours look consistent week over week.", es: "Marque salida a la hora de fin originalmente programada para que sus horas se vean consistentes semana a semana." },
      { en: "Clock out when you actually leave the job site. The clock has to match what happened. Pre-clocking, back-clocking, or padding hours is a Code of Conduct violation.", es: "Marque salida cuando realmente salga del lugar. El reloj tiene que coincidir con lo que ocurrió. Marcar antes, marcar después o inflar horas es una violación del Código de Conducta." },
      { en: "Clock out 15 minutes early to match the actual time, then add the difference to the next job.", es: "Marque salida 15 minutos antes para que coincida y luego agregue la diferencia al siguiente trabajo." },
      { en: "Ask a teammate to clock you out from their phone when you get home.", es: "Pídale a un compañero que marque su salida desde su teléfono cuando llegue a casa." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-coc-02-confidentiality",
    moduleId: "code-of-conduct",
    prompt: {
      en: "While cleaning a client's home you notice prescription medication and a custody-court document on the kitchen counter. After the job, can you mention what you saw to a coworker or post about it on social media?",
      es: "Mientras limpia el hogar de un cliente, ve un medicamento recetado y un documento de corte sobre custodia en la cocina. Después del trabajo, ¿puede comentarle a un compañero o publicarlo en redes sociales?",
    },
    options: [
      { en: "Yes, as long as you don't name the client.", es: "Sí, siempre que no nombre al cliente." },
      { en: "No. What you see and hear inside a client's home stays inside that home. Confidentiality extends to coworkers, friends, family, and any public-facing platform.", es: "No. Lo que ve y escucha dentro del hogar de un cliente se queda dentro de ese hogar. La confidencialidad se extiende a compañeros, amigos, familia y cualquier plataforma pública." },
      { en: "Only if you saw something concerning.", es: "Solo si vio algo preocupante." },
      { en: "Yes, if you're discussing it for safety reasons.", es: "Sí, si lo discute por razones de seguridad." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-coc-03-theft-zero-tolerance",
    moduleId: "code-of-conduct",
    prompt: {
      en: "You're cleaning a kitchen and find $2 in coins on the counter. The client has gone to work and isn't home. The Code of Conduct says you should:",
      es: "Está limpiando una cocina y encuentra $2 en monedas sobre el mostrador. El cliente se fue a trabajar y no está en casa. El Código de Conducta dice que debe:",
    },
    options: [
      { en: "Pocket it. Two dollars is small enough that no one will notice.", es: "Guárdelo. Dos dólares es lo suficientemente pequeño para que nadie se dé cuenta." },
      { en: "Leave the coins where they are or place them somewhere visible like next to the client's keys. Taking ANY item from a client's home, no matter how small, is theft. Phes has zero tolerance: immediate termination plus a report to local law enforcement.", es: "Deje las monedas donde están o póngalas en un lugar visible como junto a las llaves del cliente. Tomar CUALQUIER objeto del hogar de un cliente, sin importar el tamaño, es robo. Phes tiene cero tolerancia: terminación inmediata más un reporte a las autoridades locales." },
      { en: "Use them to buy a soda for yourself since the client left them out.", es: "Úselas para comprarse una soda ya que el cliente las dejó afuera." },
      { en: "Pocket them and split with your teammate.", es: "Guárdelas y compártalas con su compañero." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-coc-04-harassment-reporting",
    moduleId: "code-of-conduct",
    prompt: {
      en: "You witness a coworker making racially mocking jokes about another team member during a shift. The team member looks uncomfortable but does not say anything. What does the Code of Conduct expect you to do?",
      es: "Ve a un compañero haciendo bromas racistas sobre otro miembro del equipo durante un turno. El miembro del equipo se ve incómodo pero no dice nada. ¿Qué espera el Código de Conducta que haga?",
    },
    options: [
      { en: "Stay out of it. If the affected person didn't object, it isn't your business.", es: "Manténgase al margen. Si la persona afectada no objetó, no es asunto suyo." },
      { en: "Report what you saw to the office or directly to the owner. Phes prohibits all forms of harassment, and the Code of Conduct asks bystanders to surface what they observe so the office can act on it.", es: "Reporte lo que vio a la oficina o directamente al dueño. Phes prohíbe todas las formas de acoso, y el Código de Conducta pide a los testigos que comuniquen lo que observan para que la oficina pueda actuar." },
      { en: "Tell the coworker privately that you didn't think the jokes were funny.", es: "Dígale al compañero en privado que no le pareció gracioso." },
      { en: "Post about it online so other employees can see.", es: "Publíquelo en línea para que otros empleados lo vean." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-coc-05-protected-classes",
    moduleId: "code-of-conduct",
    prompt: {
      en: "Which of the following is a PROTECTED CLASS under the Illinois Human Rights Act referenced in the Code of Conduct?",
      es: "¿Cuál de las siguientes es una CLASE PROTEGIDA bajo la Ley de Derechos Humanos de Illinois mencionada en el Código de Conducta?",
    },
    options: [
      { en: "Whether the employee owns a car.", es: "Si el empleado tiene auto." },
      { en: "Sexual orientation, gender identity, pregnancy, and disability are all protected classes (alongside race, religion, national origin, age 40+, and several others).", es: "Orientación sexual, identidad de género, embarazo y discapacidad son todas clases protegidas (junto con raza, religión, origen nacional, edad 40+ y varias otras)." },
      { en: "Favorite sports team.", es: "Equipo deportivo favorito." },
      { en: "How many hours the employee wants to work.", es: "Cuántas horas quiere trabajar el empleado." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-coc-06-retaliation-good-faith",
    moduleId: "code-of-conduct",
    prompt: {
      en: "You file a good-faith report about a Code of Conduct violation. After investigation, the office concludes there was not enough evidence to substantiate the report. Are you still protected from retaliation?",
      es: "Presenta un reporte de buena fe sobre una violación del Código de Conducta. Después de la investigación, la oficina concluye que no hubo suficiente evidencia para comprobar el reporte. ¿Sigue protegido contra represalias?",
    },
    options: [
      { en: "No. Only successful reports are protected.", es: "No. Solo los reportes exitosos están protegidos." },
      { en: "Yes. Good-faith reporting is protected regardless of whether the investigation ultimately substantiates the report. Good faith means you genuinely believed your report was true at the time you made it.", es: "Sí. El reporte de buena fe está protegido sin importar si la investigación finalmente comprueba el reporte. Buena fe significa que realmente creyó que su reporte era verdadero al momento de hacerlo." },
      { en: "Only if you reported in writing.", es: "Solo si reportó por escrito." },
      { en: "Only if the accused agrees that you reported in good faith.", es: "Solo si el acusado acepta que reportó de buena fe." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-coc-07-conflict-of-interest",
    moduleId: "code-of-conduct",
    prompt: {
      en: "At the end of a clean, the client asks if you could come back next Saturday to clean for them privately, paid in cash. What does the Code of Conduct say?",
      es: "Al final de una limpieza, el cliente le pregunta si puede regresar el próximo sábado para limpiar para ellos en privado, pagado en efectivo. ¿Qué dice el Código de Conducta?",
    },
    options: [
      { en: "Accept it. The client likes your work and Saturday is your day off.", es: "Acéptelo. Al cliente le gusta su trabajo y el sábado es su día libre." },
      { en: "Decline. Refer the client to the office to book the additional clean through Phes. Soliciting or accepting Phes-client work outside the Phes channel is a conflict of interest and is also addressed in the Non-Solicitation Agreement.", es: "Rehúselo. Refiera al cliente a la oficina para reservar la limpieza adicional a través de Phes. Solicitar o aceptar trabajo de un cliente de Phes fuera del canal de Phes es un conflicto de interés y también está tratado en el Acuerdo de No Solicitación." },
      { en: "Accept it but only if you charge less than the Phes rate.", es: "Acéptelo pero solo si cobra menos que la tarifa de Phes." },
      { en: "Accept it and tell the office afterward.", es: "Acéptelo y avísele a la oficina después." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-coc-08-key-handling",
    moduleId: "code-of-conduct",
    prompt: {
      en: "You're sent to a recurring client's home and the office issues you a copy of their key. After the job, what does the Code of Conduct require you to do with the key?",
      es: "Le envían a la casa de un cliente recurrente y la oficina le entrega una copia de su llave. Después del trabajo, ¿qué requiere el Código de Conducta que haga con la llave?",
    },
    options: [
      { en: "Take it home so you have it ready for next week.", es: "Llevársela a casa para tenerla lista la próxima semana." },
      { en: "Return it to the office at the end of the shift, or follow the office's logged procedure for repeat-visit clients. Keys are Phes property; you may not copy them, share them, or take them home without authorization.", es: "Devolverla a la oficina al final del turno, o seguir el procedimiento registrado de la oficina para clientes de visita recurrente. Las llaves son propiedad de Phes; no puede copiarlas, compartirlas ni llevárselas a casa sin autorización." },
      { en: "Give a copy to your teammate so they can cover for you if needed.", es: "Darle una copia a su compañero por si necesita cubrirlo." },
      { en: "Hide it under the client's doormat.", es: "Esconderla debajo del tapete del cliente." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-coc-09-cooperation-investigation",
    moduleId: "code-of-conduct",
    prompt: {
      en: "Phes opens an internal investigation about a missing item from a client's home. You weren't on the job but a coworker mentioned something relevant to you. What does the Code of Conduct require?",
      es: "Phes abre una investigación interna sobre un artículo faltante en el hogar de un cliente. Usted no estuvo en el trabajo pero un compañero le mencionó algo relevante. ¿Qué requiere el Código de Conducta?",
    },
    options: [
      { en: "Stay quiet. It wasn't your shift.", es: "Quedarse callado. No fue su turno." },
      { en: "Cooperate truthfully. If you have relevant information, share it with the office. Refusing to cooperate or providing false information during an investigation is itself a Code of Conduct violation.", es: "Cooperar veridicamente. Si tiene información relevante, compártala con la oficina. Negarse a cooperar o proveer información falsa durante una investigación es en sí una violación del Código de Conducta." },
      { en: "Tell the coworker to lie to protect them.", es: "Decirle al compañero que mienta para protegerlo." },
      { en: "Discuss the investigation publicly to get the truth out.", es: "Discutir la investigación públicamente para que se sepa la verdad." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-coc-10-reporting-channels",
    moduleId: "code-of-conduct",
    prompt: {
      en: "You want to report a harassment concern, but you'd prefer not to take it through the office team. Which reporting paths are available under the Code of Conduct?",
      es: "Quiere reportar una preocupación de acoso, pero preferiría no llevarla a través del equipo de la oficina. ¿Qué vías de reporte están disponibles bajo el Código de Conducta?",
    },
    options: [
      { en: "Only the office team. There is no other option.", es: "Solo el equipo de la oficina. No hay otra opción." },
      { en: "You can contact the owner directly, file with the Illinois Department of Human Rights (IDHR) or the federal EEOC. You are not required to report internally first.", es: "Puede contactar al dueño directamente, presentar ante el Departamento de Derechos Humanos de Illinois (IDHR) o ante la EEOC federal. No está obligado a reportar internamente primero." },
      { en: "You must report to the accused person first.", es: "Debe reportar primero a la persona acusada." },
      { en: "You can post about it on social media so other employees can see.", es: "Puede publicarlo en redes sociales para que otros empleados lo vean." },
    ],
    correctIndex: 1,
  },

  // ═════════════════════════════════════════════════════════════════════════════
  // Module 9: VIDEO / PHOTO RELEASE (9 questions, Phase 5 PR #6)
  // ═════════════════════════════════════════════════════════════════════════════
  {
    id: "q-vpr-01-voluntary",
    moduleId: "video-photo-release",
    prompt: {
      en: "You don't want your photo on Phes social media. What happens if you decline to sign the Video & Photo Release?",
      es: "No quiere que su foto aparezca en las redes sociales de Phes. ¿Qué pasa si decide no firmar la Autorización de Video y Foto?",
    },
    options: [
      { en: "You can be terminated for refusing to sign.", es: "Pueden despedirlo por negarse a firmar." },
      { en: "Nothing happens to your job. Signing is voluntary. Phes simply will not photograph or record you for commercial use.", es: "No pasa nada con su trabajo. Firmar es voluntario. Phes simplemente no lo fotografiará ni grabará para uso comercial." },
      { en: "Your hours are reduced.", es: "Le reducen las horas." },
      { en: "You lose your annual raise.", es: "Pierde su aumento anual." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-vpr-02-5-year-limit",
    moduleId: "video-photo-release",
    prompt: {
      en: "You sign the release. Two years later you leave Phes. What can Phes do with the existing photos and video of you?",
      es: "Firma la autorización. Dos años después se va de Phes. ¿Qué puede hacer Phes con las fotos y videos existentes suyos?",
    },
    options: [
      { en: "Use them forever, no time limit.", es: "Usarlos para siempre, sin límite de tiempo." },
      { en: "Continue using content that was already in active distribution at the time you left, but Phes may not launch NEW uses of content featuring your likeness more than 5 years after your last day.", es: "Continuar usando contenido que ya estaba en distribución activa al momento de irse, pero Phes no podrá iniciar NUEVOS usos de contenido con su semejanza más de 5 años después de su último día." },
      { en: "Phes must remove all content immediately on your last day.", es: "Phes debe retirar todo el contenido inmediatamente en su último día." },
      { en: "Phes must pay you a residual for any continued use.", es: "Phes debe pagarle un residual por cualquier uso continuado." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-vpr-03-ai-carve-out",
    moduleId: "video-photo-release",
    prompt: {
      en: "Phes wants to use your photos to train an AI model that generates new recruiting graphics. Does this release authorize that?",
      es: "Phes quiere usar sus fotos para entrenar un modelo de IA que genera nuevos gráficos de reclutamiento. ¿Esta autorización permite eso?",
    },
    options: [
      { en: "Yes, recruiting is a covered use.", es: "Sí, el reclutamiento es un uso cubierto." },
      { en: "No. AI training, deepfake creation, and synthetic-media generation are carved out and require a SEPARATE written consent. This release does not authorize them under any circumstances.", es: "No. El entrenamiento de IA, la creación de deepfakes y la generación de medios sintéticos están excluidos y requieren un consentimiento separado por escrito. Esta autorización no los permite bajo ninguna circunstancia." },
      { en: "Yes, but only for internal use.", es: "Sí, pero solo para uso interno." },
      { en: "Yes, because it's still your image.", es: "Sí, porque sigue siendo su imagen." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-vpr-04-withdrawal-30-day",
    moduleId: "video-photo-release",
    prompt: {
      en: "You signed the release a year ago. Today you want to withdraw consent. What does the release commit Phes to do?",
      es: "Firmó la autorización hace un año. Hoy quiere retirar su consentimiento. ¿A qué se compromete Phes según la autorización?",
    },
    options: [
      { en: "Phes is not obligated to do anything; consent is permanent.", es: "Phes no está obligado a hacer nada; el consentimiento es permanente." },
      { en: "Phes will take reasonable steps to remove content featuring your likeness from active Phes-controlled distribution channels within 30 days of receiving your written withdrawal. Phes will not use the withdrawn content in NEW campaigns after the withdrawal date.", es: "Phes tomará medidas razonables para retirar contenido con su semejanza de los canales de distribución activos controlados por Phes dentro de los 30 días de recibir su retiro por escrito. Phes no usará el contenido retirado en NUEVAS campañas después de la fecha de retiro." },
      { en: "Phes must pay you to release the content.", es: "Phes debe pagarle para liberar el contenido." },
      { en: "Phes must remove all content within 24 hours, no exceptions.", es: "Phes debe retirar todo el contenido en 24 horas, sin excepciones." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-vpr-05-third-party-limits",
    moduleId: "video-photo-release",
    prompt: {
      en: "You withdrew consent. A former client had previously screenshot a Phes Instagram post that featured you and reposted it on their own account. Can Phes force the client to take down their repost?",
      es: "Retiró su consentimiento. Un cliente anterior había hecho captura de pantalla de una publicación de Instagram de Phes con su imagen y la republicó en su propia cuenta. ¿Puede Phes obligar al cliente a retirar su republicación?",
    },
    options: [
      { en: "Yes, Phes has full control over any copy of the content.", es: "Sí, Phes tiene control total sobre cualquier copia del contenido." },
      { en: "No. Phes cannot recall content already distributed by third parties (re-posts, downloads, screenshots, news references). Once content left Phes-controlled distribution, third-party copies are outside Phes's control. The release acknowledges this explicitly.", es: "No. Phes no puede recuperar contenido ya distribuido por terceros (republicaciones, descargas, capturas, referencias de noticias). Una vez que el contenido salió de la distribución controlada por Phes, las copias de terceros están fuera del control de Phes. La autorización reconoce esto explícitamente." },
      { en: "Only with a court order.", es: "Solo con una orden judicial." },
      { en: "Only if the client charges money for the repost.", es: "Solo si el cliente cobra dinero por la republicación." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-vpr-06-il-right-of-publicity",
    moduleId: "video-photo-release",
    prompt: {
      en: "Which Illinois law requires Phes to get your AFFIRMATIVE WRITTEN CONSENT before using your identity for commercial purposes?",
      es: "¿Qué ley de Illinois requiere que Phes obtenga su CONSENTIMIENTO AFIRMATIVO POR ESCRITO antes de usar su identidad para propósitos comerciales?",
    },
    options: [
      { en: "Illinois Cannabis Regulation and Tax Act.", es: "Ley de Regulación e Impuestos del Cannabis de Illinois." },
      { en: "Illinois Right of Publicity Act, 765 ILCS 1075. The Video & Photo Release is the document where Phes captures that affirmative consent in writing.", es: "Ley del Derecho de Publicidad de Illinois, 765 ILCS 1075. La Autorización de Video y Foto es el documento donde Phes captura ese consentimiento afirmativo por escrito." },
      { en: "Illinois Workplace Transparency Act.", es: "Ley de Transparencia Laboral de Illinois." },
      { en: "Illinois Paid Leave for All Workers Act.", es: "Ley de Licencia Pagada para Todos los Trabajadores de Illinois." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-vpr-07-co-signature",
    moduleId: "video-photo-release",
    prompt: {
      en: "Why is the Video & Photo Release CO-SIGNED by the Phes representative, unlike other Phes acknowledgments?",
      es: "¿Por qué la Autorización de Video y Foto es CO-FIRMADA por el representante de Phes, a diferencia de otros reconocimientos de Phes?",
    },
    options: [
      { en: "Because the office wants more signatures on file.", es: "Porque la oficina quiere más firmas archivadas." },
      { en: "Because the release is a TWO-WAY commitment: you grant rights, and Phes commits to specific limits (5-year post-separation cap, AI carve-out, 30-day withdrawal removal effort, courtesy preview). The co-signature binds Phes to those commitments.", es: "Porque la autorización es un compromiso DE DOS VÍAS: usted otorga derechos y Phes se compromete a límites específicos (límite de 5 años después de la separación, exclusión de IA, esfuerzo de retiro en 30 días, vista previa de cortesía). La co-firma vincula a Phes a esos compromisos." },
      { en: "Because Illinois law requires two signatures on every release.", es: "Porque la ley de Illinois exige dos firmas en cada autorización." },
      { en: "Because it makes the document harder to forge.", es: "Porque hace el documento más difícil de falsificar." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-vpr-08-courtesy-preview",
    moduleId: "video-photo-release",
    prompt: {
      en: "Does the release give you the right to APPROVE every photo or video before Phes uses it?",
      es: "¿La autorización le da el derecho a APROBAR cada foto o video antes de que Phes lo use?",
    },
    options: [
      { en: "Yes. Approval is required for every publication.", es: "Sí. La aprobación es requerida para cada publicación." },
      { en: "No. Phes commits to a COURTESY PREVIEW where feasible, meaning Phes will make reasonable effort to show you content before publication. Courtesy preview is not a veto; pre-approval is not a condition of publication. You may flag concerns, and we will consider them.", es: "No. Phes se compromete a una VISTA PREVIA DE CORTESÍA cuando sea factible, lo que significa que Phes hará un esfuerzo razonable para mostrarle el contenido antes de la publicación. La vista previa de cortesía no es un veto; la pre-aprobación no es condición de publicación. Puede señalar inquietudes y las consideraremos." },
      { en: "Yes, but only for video, not photo.", es: "Sí, pero solo para video, no foto." },
      { en: "No, you have no input at all.", es: "No, no tiene ninguna participación." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-vpr-09-active-distribution",
    moduleId: "video-photo-release",
    prompt: {
      en: "You're leaving Phes next month. A training video posted to the Phes website 6 months ago features you. After your last day, Phes plans to keep the training video live on the site. Is that allowed under the release?",
      es: "Se va de Phes el próximo mes. Un video de capacitación publicado en el sitio web de Phes hace 6 meses lo muestra. Después de su último día, Phes planea mantener el video de capacitación en el sitio. ¿Es permitido bajo la autorización?",
    },
    options: [
      { en: "No. Phes must take down all content featuring you on your last day.", es: "No. Phes debe retirar todo contenido suyo en su último día." },
      { en: "Yes. Content already in ACTIVE DISTRIBUTION at the time of separation may continue. The 5-year limit applies to NEW uses, not existing assets. If you want it taken down anyway, you can withdraw consent in writing and Phes will remove it from Phes-controlled channels within 30 days.", es: "Sí. El contenido que ya está en DISTRIBUCIÓN ACTIVA al momento de la separación puede continuar. El límite de 5 años aplica a NUEVOS usos, no a los recursos existentes. Si aun así quiere que se retire, puede retirar el consentimiento por escrito y Phes lo retirará de los canales controlados por Phes dentro de los 30 días." },
      { en: "Only if Phes pays you a continued-use fee.", es: "Solo si Phes le paga una tarifa por uso continuado." },
      { en: "Yes, but only for one year.", es: "Sí, pero solo por un año." },
    ],
    correctIndex: 1,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-TENANT RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tenant-specific overrides. Tenants inherit BASE_MODULES + BASE_QUIZ
 * and may append additional modules (and matching quiz questions) here.
 *
 * Phes (id 1) is the originator — no overrides yet.
 */
const TENANT_OVERRIDES: Record<
  number,
  {
    extraModules?: Module[];
    extraQuiz?: QuizQuestion[];
    tenantName?: string;
    tenantLogoUrl?: string;
  }
> = {
  1: { tenantName: "Phes", tenantLogoUrl: "/phes-logo.jpeg" },
};

export function getCurriculum(companyId: number | null | undefined): Curriculum {
  const cid = companyId ?? 1;
  const override = TENANT_OVERRIDES[cid] || {};
  return {
    tenantName: override.tenantName ?? "Phes",
    tenantLogoUrl: override.tenantLogoUrl,
    modules: [...BASE_MODULES, ...(override.extraModules ?? [])],
    quiz: [...BASE_QUIZ, ...(override.extraQuiz ?? [])],
  };
}

export const QUIZ_PASS_THRESHOLD = 0.8;
