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
          en: "Phes Cleaning Services is a residential and light-commercial cleaning company serving the Chicago southwest and northwest suburbs. You are joining a W-2 team. You are not a contractor. You will have steady scheduled work, real benefits, and a clear path from training to full commission. This handbook outlines the policies, expectations, and benefits that govern employment in 2026.",
          es: "Phes Cleaning Services es una compañía de limpieza residencial y comercial ligera que sirve a los suburbios del suroeste y noroeste de Chicago. Se está uniendo a un equipo W-2. Usted no es contratista. Tendrá trabajo programado constante, beneficios reales y un camino claro del entrenamiento a la comisión completa. Este manual describe las políticas, expectativas y beneficios que rigen el empleo en 2026.",
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
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Training-period redo coverage: during the first three weeks of training ONLY, Phes pays you at $20.00 per hour for any Fix-It re-clean dispatched on a job you originally worked. After training ends, the standard Fix-It Rule applies — re-cleans by the original tech are part of the original commission and earn no additional pay. This three-week paid-redo window is the only time Phes pays you separately to fix your own work.",
          es: "Cobertura de re-limpiezas durante el entrenamiento: SOLO durante las primeras tres semanas de entrenamiento, Phes le paga $20.00 por hora por cualquier re-limpieza Fix-It despachada en un trabajo que usted hizo originalmente. Después del entrenamiento, aplica la Regla Fix-It estándar — las re-limpiezas del técnico original son parte de la comisión original y no ganan pago adicional. Esta ventana de tres semanas es el único momento en que Phes le paga por separado para corregir su propio trabajo.",
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
      // LEGAL-REVIEW-PENDING (2026-05-21): commission contingency framework. Establishes that
      // contingent commission is NOT earned wages under 820 ILCS 115 until Quality Verification.
      {
        type: "p",
        text: {
          en: "Commission is not deemed earned wages under the Illinois Wage Payment and Collection Act (820 ILCS 115/) until Quality Verification has occurred as defined above. Until Quality Verification occurs, commission is a contingent future payment and not earned wages. The $18.00 per hour rate that applies when Quality Verification fails due to refusal of a valid Fix-It re-clean is not a deduction from earned wages. It is the default rate of pay that applies when the contingent commission is never earned. Employees provide express written consent to this commission contingency structure as a fundamental term of employment by signing the final handbook acknowledgment.",
          es: "La comisión no se considera salario ganado bajo la Ley de Pago y Cobranza de Salarios de Illinois (820 ILCS 115/) hasta que ocurra la Verificación de Calidad según se define arriba. Hasta que ocurra la Verificación de Calidad, la comisión es un pago futuro contingente y no salario ganado. La tarifa de $18.00 por hora que aplica cuando la Verificación de Calidad falla por rechazo de una re-limpieza Fix-It válida no es una deducción de salario ganado. Es la tarifa de pago por defecto que aplica cuando la comisión contingente nunca se gana. Los empleados proveen consentimiento expreso por escrito a esta estructura de comisión contingente como término fundamental del empleo al firmar el reconocimiento final del manual.",
        },
      },

      { type: "h", text: { en: "Fix-It Rule (Re-Clean Obligation)", es: "Regla de Corrección (Obligación de Re-Limpieza)" } },
      {
        type: "bullets",
        items: [
          { en: "Every Phes cleaning is backed by a 24-hour notification guarantee. The client must notify Phes within 24 hours of the cleaning if they are unhappy with anything in their home. The office sends the client a Shortfall Report form to document the specific areas or tasks at issue and asks for photographs to verify the shortfall. The office then dispatches the re-clean visit as soon as reasonably possible based on the client's availability, normally within 7 days of the client's notification (longer only when the client cannot accommodate sooner). The 24-hour window applies to the client's notification, not to Phes's return visit. The obligation to return and fix the documented shortfall does NOT expire simply because more than 24 hours have passed since the original cleaning. When a client invokes the Fix-It guarantee, Quality Verification is suspended pending the outcome of the re-clean: commission remains contingent until the re-clean either completes (Quality Verification satisfied, commission earned) or is refused (Quality Verification fails, $18.00 per hour default applies). Re-clean visits are scope-limited: techs only address the specific areas or tasks the client identified, not the whole home.", es: "Cada limpieza de Phes está respaldada por una garantía de notificación de 24 horas. El cliente debe notificar a Phes dentro de las 24 horas de la limpieza si está inconforme con cualquier cosa en su hogar. La oficina envía al cliente un formulario de Reporte de Deficiencia para documentar las áreas o tareas específicas en cuestión y solicita fotografías para verificar la deficiencia. La oficina luego despacha la visita de re-limpieza tan pronto como sea razonablemente posible según la disponibilidad del cliente, normalmente dentro de 7 días de la notificación del cliente (más tiempo solo cuando el cliente no puede acomodar antes). La ventana de 24 horas aplica a la notificación del cliente, no a la visita de regreso de Phes. La obligación de regresar y corregir la deficiencia documentada NO expira simplemente porque hayan pasado más de 24 horas desde la limpieza original. Cuando un cliente invoca la garantía Fix-It, la Verificación de Calidad se suspende pendiente del resultado de la re-limpieza: la comisión permanece contingente hasta que la re-limpieza se complete (Verificación de Calidad satisfecha, comisión ganada) o sea rechazada (Verificación de Calidad falla, aplica la tarifa por defecto de $18.00 por hora). Las visitas de re-limpieza son de alcance limitado: los técnicos solo atienden las áreas o tareas específicas que el cliente identificó, no toda la casa." },
          { en: "If the original tech completes the re-clean: Quality Verification is satisfied. Full commission is EARNED on the original job. The re-clean visit is part of the original commission and there is no additional pay for the re-clean visit itself.", es: "Si el técnico original completa la re-limpieza: la Verificación de Calidad se cumple. Se GANA la comisión completa del trabajo original. La visita de re-limpieza es parte de la comisión original y no hay pago adicional por la visita de re-limpieza en sí." },
          { en: "If the original tech refuses the re-clean visit Phes dispatches without a lawful or protected reason: Quality Verification fails. Commission is not earned on the original job. Compensation for that job defaults to the on-site hourly rate of $18.00 per hour for time actually worked. This is the default rate kicking in when the contingent commission is never earned, not a retroactive penalty. (If you are unavailable on the dispatched date for a reason you raise in advance, the office will work to reschedule; that is not refusal. Refusal means declining to perform a dispatched visit where you have no lawful or protected reason and no scheduling conflict you raised in good faith.)", es: "Si el técnico original se niega a la visita de re-limpieza que Phes despacha sin razón legal o protegida: la Verificación de Calidad falla. No se gana comisión en el trabajo original. La compensación de ese trabajo se rige por la tarifa por hora en sitio de $18.00 por el tiempo realmente trabajado. Esta es la tarifa por defecto que aplica cuando la comisión contingente nunca se gana, no una penalidad retroactiva. (Si usted no está disponible en la fecha despachada por una razón que plantea con anticipación, la oficina trabajará para reprogramar; eso no es rechazo. Rechazo significa declinar realizar una visita despachada cuando no tiene razón legal o protegida ni conflicto de programación que haya planteado de buena fe.)" },
          { en: "If the original tech cannot return: Phes may dispatch a recovery technician at $20.00 per hour with a 3-hour minimum (paid 3 hours even if the shortfall fix takes less time). The recovery tech only addresses the documented shortfall, not the whole job.", es: "Si el técnico original no puede regresar: Phes puede despachar un técnico de recuperación a $20.00 por hora con un mínimo de 3 horas (se pagan 3 horas aunque corregir la deficiencia tome menos tiempo). El técnico de recuperación solo atiende la deficiencia documentada, no todo el trabajo." },
          { en: "Refusing a re-clean visit Phes dispatches without a lawful or protected reason is INSUBORDINATION and may result in discipline up to and including immediate termination.", es: "Negarse a una visita de re-limpieza que Phes despacha sin razón legal o protegida es INSUBORDINACIÓN y puede resultar en disciplina hasta e incluyendo la terminación inmediata." },
        ],
      },

      { type: "h", text: { en: "Three-Hour Minimum", es: "Mínimo de Tres Horas" } },
      {
        type: "p",
        text: {
          en: "For original dispatched jobs (the first visit to a client's home for a scheduled service), a three-hour pay minimum is guaranteed provided the employee remains on-site and working for the duration of the service, unless sent home early by management. The three-hour minimum also applies to recovery-tech dispatches at $20.00 per hour (paid 3 hours even if the shortfall fix takes less time). The three-hour minimum does NOT apply to Fix-It re-clean visits by the original tech, which are part of the original commission and earn no additional pay. See the Fix-It Rule above for re-clean pay specifics. Regardless of how the three-hour minimum applies to a given visit, total wages paid to any employee in any workweek will always meet or exceed the applicable federal, Illinois state, and Chicago minimum wage for all hours worked in that workweek.",
          es: "Para trabajos despachados originales (la primera visita al hogar del cliente para un servicio programado), se garantiza un mínimo de pago de tres horas siempre y cuando el empleado permanezca en el sitio trabajando durante la duración del servicio, a menos que la gerencia lo envíe a casa más temprano. El mínimo de tres horas también aplica a despachos de técnico de recuperación a $20.00 por hora (se pagan 3 horas aunque la corrección del faltante tome menos tiempo). El mínimo de tres horas NO aplica a visitas Fix-It de re-limpieza realizadas por el técnico original, que son parte de la comisión original y no ganan pago adicional. Vea la Regla de Corrección arriba para los detalles de pago de re-limpieza. Sin importar cómo aplique el mínimo de tres horas a una visita dada, el salario total pagado a cualquier empleado en cualquier semana laboral siempre cumplirá o excederá el salario mínimo federal, estatal de Illinois, y de Chicago aplicable para todas las horas trabajadas en esa semana.",
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
      // LEGAL-REVIEW-PENDING (2026-05-21): defines what counts as a valid quality complaint.
      // Carves out office-caused issues and properly documented out-of-scope items.
      {
        type: "p",
        text: {
          en: "A quality complaint is deemed valid when the office documents it in writing with specific identified quality issues, photographic or written client evidence where applicable, and a record of when the complaint was received. The office determines validity in good faith based on documented evidence. Complaints arising from circumstances outside the employee's control (such as office scheduling errors, client requests outside the standard scope, or items the employee documented as exceeding the climbing rule or lifting limit) are not counted as valid quality complaints against the employee. The office's good-faith determination is binding for purposes of Quality Probation, subject to the employee's right to raise concerns in writing.",
          es: "Una queja de calidad se considera válida cuando la oficina la documenta por escrito con problemas de calidad específicos identificados, evidencia fotográfica o escrita del cliente cuando aplique, y un registro de cuándo se recibió la queja. La oficina determina la validez de buena fe basada en la evidencia documentada. Las quejas que surgen de circunstancias fuera del control del empleado (como errores de programación de la oficina, solicitudes del cliente fuera del alcance estándar, o artículos que el empleado documentó como excediendo la regla de escalada o el límite de levantamiento) no se cuentan como quejas válidas de calidad contra el empleado. La determinación de buena fe de la oficina es vinculante para efectos de Probatoria de Calidad, sujeto al derecho del empleado de plantear preocupaciones por escrito.",
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

      { type: "h", text: { en: "Payroll & Direct Deposit Policy", es: "Política de Nómina y Depósito Directo" } },
      {
        type: "p",
        text: {
          en: "Pay cycle: weekly. The payroll workweek runs Sunday through Saturday. Each completed workweek is deposited or issued the following Friday. Payment is made via direct deposit. If you prefer to receive your wages via a physical paper check, please notify the office team to set up this option.",
          es: "Ciclo de pago: semanal. La semana laboral de nómina va de domingo a sábado. Cada semana laboral completa se deposita o se emite el viernes siguiente. El pago se realiza mediante depósito directo. Si usted prefiere recibir su salario mediante un cheque físico en papel, notifique al equipo de la oficina para configurar esta opción.",
        },
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
          // LEGAL-REVIEW-PENDING (2026-05-20): defines when an absence becomes "unexcused" for disciplinary purposes.
          en: "An absence is unexcused when (a) it is a no-call / no-show, OR (b) PLAWA is exhausted AND the day was not pre-approved as PTO or Unpaid Personal Leave (both require 7 days advance notice) AND the absence is not protected by law. As long as PLAWA covers the call-off (with the grace-window call) OR PTO/Unpaid Personal Leave was pre-approved with 7+ days notice, the absence is excused and does NOT count toward the discipline scale.",
          es: "Una ausencia es injustificada cuando (a) es un no llamó / no se presentó, O (b) el PLAWA está agotado Y el día no fue pre-aprobado como PTO o Licencia Personal No Pagada (ambos requieren 7 días de aviso anticipado) Y la ausencia no está protegida por la ley. Mientras el PLAWA cubra la llamada (con la llamada de la ventana de gracia) O el PTO/Licencia Personal No Pagada haya sido pre-aprobado con 7+ días de aviso, la ausencia es justificada y NO cuenta hacia la escala de disciplina.",
        },
      },

      { type: "h", text: { en: "Unexcused Absence Scale (Post-PLAWA, Per Benefit Year)", es: "Escala de Ausencia Injustificada (Después de PLAWA, Por Año de Beneficios)" } },
      {
        type: "callout",
        tone: "info",
        text: {
          // LEGAL-REVIEW-PENDING (2026-07-11): tightened post-PLAWA 3-strike scale.
          en: "As long as PLAWA hours are available and you give the grace call, a call-off is protected and records ZERO occurrences. Occurrences on this scale only begin once your PLAWA bank reaches 0.00 (or the absence is a no-call / no-show). Using your paid leave is never held against you.",
          es: "Mientras tenga horas de PLAWA disponibles y dé la llamada de gracia, una ausencia está protegida y registra CERO ocurrencias. Las ocurrencias en esta escala solo comienzan una vez que su banco de PLAWA llega a 0.00 (o la ausencia es un no llamó / no se presentó). Usar su licencia pagada nunca se usa en su contra.",
        },
      },
      {
        type: "table",
        head: { en: ["Occurrence", "Action"], es: ["Ocurrencia", "Acción"] },
        rows: [
          { en: ["1st", "Written warning / coaching."], es: ["1ª", "Advertencia por escrito / orientación."] },
          { en: ["2nd", "Final written warning."], es: ["2ª", "Advertencia final por escrito."] },
          { en: ["3rd", "Termination review."], es: ["3ª", "Revisión de terminación."] },
        ],
      },

      { type: "h", text: { en: "No-Call / No-Show (Counts as 2 Occurrences)", es: "No Llamó / No se Presentó (Cuenta como 2 Ocurrencias)" } },
      {
        type: "callout",
        tone: "warning",
        text: {
          // LEGAL-REVIEW-PENDING (2026-07-11): NCNS = 2 occurrences, balance-independent.
          en: "If you do not contact the office through the designated channel within the 20-minute grace window, the missed shift is a no-call / no-show. A no-call / no-show counts as TWO occurrences on the scale above, whether or not you have PLAWA hours left, because the issue is the broken notice rule, not the time off. One no-call / no-show puts you at a final written warning; a second triggers a termination review. Calling in protects you. Going silent does not.",
          es: "Si no contacta a la oficina por el canal designado dentro de la ventana de gracia de 20 minutos, el turno perdido es un no llamó / no se presentó. Un no llamó / no se presentó cuenta como DOS ocurrencias en la escala anterior, tenga o no horas de PLAWA disponibles, porque el problema es la regla de aviso incumplida, no el tiempo libre. Un no llamó / no se presentó lo coloca en una advertencia final por escrito; un segundo activa una revisión de terminación. Llamar lo protege. Guardar silencio no.",
        },
      },

      { type: "h", text: { en: "Job Abandonment", es: "Abandono del Empleo" } },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Failure to contact the office BEFORE the end of the 20-minute grace window on a scheduled shift, AND failure to make contact within 24 hours after the missed shift, may result in immediate termination for job abandonment, effective the date of the missed shift. The 24-hour post-shift contact window provides the employee an opportunity to explain genuine incapacity (medical emergency, accident, hospitalization, or other circumstance preventing communication). Documentation of genuine incapacity may result in reinstatement at office discretion.",
          es: "No contactar a la oficina ANTES del fin de la ventana de gracia de 20 minutos en un turno programado, Y no establecer contacto dentro de las 24 horas posteriores al turno perdido, puede resultar en terminación inmediata por abandono del empleo, efectiva en la fecha del turno perdido. La ventana de contacto de 24 horas después del turno brinda al empleado una oportunidad de explicar una incapacidad genuina (emergencia médica, accidente, hospitalización, u otra circunstancia que impida la comunicación). La documentación de una incapacidad genuina puede resultar en reincorporación a discreción de la oficina.",
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
          en: "Phes uses three leave buckets to cover absences. Notice matters. PLAWA is the only bucket that covers same-day call-offs (the 20-minute grace call is all the notice needed). PTO and Unpaid Personal Leave both require 7 days advance notice and can only cover planned absences. As long as the right bucket has hours available AND you give the right notice for that bucket, the absence is excused and does NOT count toward the discipline scale.",
          es: "Phes utiliza tres cubetas de licencia para cubrir ausencias. El aviso importa. El PLAWA es la única cubeta que cubre llamadas el mismo día (la llamada de gracia de 20 minutos es todo el aviso necesario). El PTO y la Licencia Personal No Pagada requieren 7 días de aviso anticipado y solo cubren ausencias planeadas. Mientras la cubeta correcta tenga horas disponibles Y dé el aviso correcto para esa cubeta, la ausencia es justificada y NO cuenta hacia la escala de disciplina.",
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
          { en: ["2", "PTO", "40 (yr 1) / 80 (yr 2+)", "After 1 year", "7 days advance", "Yes. Business needs.", "Yes"],
            es: ["2", "PTO", "40 (año 1) / 80 (año 2+)", "Después de 1 año", "7 días anticipados", "Sí. Necesidades del negocio.", "Sí"] },
          { en: ["3", "Unpaid Personal Leave", "40 / year (5 days)", "Day one", "7 days advance", "Yes. Business needs.", "No"],
            es: ["3", "Licencia Personal No Pagada", "40 / año (5 días)", "Primer día", "7 días anticipados", "Sí. Necesidades del negocio.", "No"] },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          // LEGAL-REVIEW-PENDING (2026-05-20): clarifies the cascade only applies to planned absences, not same-day call-offs.
          en: "Same-day call-off: PLAWA is the only bucket that applies. PTO and Unpaid Personal Leave both require 7 days advance notice and cannot retroactively cover an unannounced absence. Once PLAWA is exhausted, a same-day call-off counts toward the discipline scale unless the absence is protected by law. Planned absence (with 7+ days advance notice): PLAWA → PTO → Unpaid Personal Leave → discipline scale (only if all three are exhausted and the absence is not otherwise protected).",
          es: "Llamada el mismo día: el PLAWA es la única cubeta que aplica. El PTO y la Licencia Personal No Pagada requieren 7 días de aviso anticipado y no pueden cubrir retroactivamente una ausencia no anunciada. Una vez agotado el PLAWA, una llamada el mismo día cuenta hacia la escala de disciplina a menos que la ausencia esté protegida por la ley. Ausencia planeada (con 7+ días de aviso anticipado): PLAWA → PTO → Licencia Personal No Pagada → escala de disciplina (solo si las tres están agotadas y la ausencia no está protegida de otra forma).",
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
          { en: "PLAWA is used in a minimum of 2-hour increments. A same-day call-off or late start that draws PLAWA takes at least 2 hours from your bank, unless your entire scheduled shift that day was shorter than 2 hours (then only the shift length is used).", es: "El PLAWA se usa en incrementos mínimos de 2 horas. Una ausencia el mismo día o una llegada tarde que use PLAWA toma al menos 2 horas de su banco, a menos que todo su turno programado ese día fuera menor a 2 horas (entonces solo se usa la duración del turno)." },
          { en: "Cannot be denied for business needs. PLAWA is protected leave.", es: "No se puede negar por necesidades del negocio. PLAWA es licencia protegida." },
          { en: "PLAWA is AUTOMATIC when you have hours and give the grace call. You do not need to specifically request 'sick time' or give a reason. PLAWA covers you by default.", es: "PLAWA es AUTOMÁTICA cuando tiene horas y da la llamada de gracia. No necesita solicitar específicamente 'tiempo por enfermedad' ni dar una razón. PLAWA lo cubre por defecto." },
          { en: "4 or more CONSECUTIVE PLAWA days requires advance approval if the absence is foreseeable. 'Foreseeable' means planned in advance: a scheduled medical procedure, a planned mental health retreat, or a known appointment series. Unforeseeable absences (sudden illness like the flu, family emergency, accident) do NOT require advance approval. Just give the grace call each day. If you are sick for a week with the flu and call each day, that is fine.", es: "4 o más días consecutivos de PLAWA requieren aprobación previa si la ausencia es previsible. 'Previsible' significa planeado con anticipación: un procedimiento médico programado, un retiro de salud mental planeado, o una serie de citas conocida. Las ausencias imprevisibles (enfermedad súbita como la gripe, emergencia familiar, accidente) NO requieren aprobación previa. Solo dé la llamada de gracia cada día. Si está enfermo una semana con la gripe y llama cada día, está bien." },
          // LEGAL-REVIEW-PENDING (2026-05-20): clarifies cascade only applies to planned absences.
          { en: "If you run out of PLAWA: for planned absences with 7+ days advance notice, the office can apply PTO (if you have hours and are 1+ year in) or Unpaid Personal Leave. For same-day call-offs, no other bucket applies — the absence is unexcused unless protected by law.", es: "Si se queda sin PLAWA: para ausencias planeadas con 7+ días de aviso anticipado, la oficina puede aplicar PTO (si tiene horas y tiene 1+ año) o Licencia Personal No Pagada. Para llamadas el mismo día, ninguna otra cubeta aplica — la ausencia es injustificada a menos que esté protegida por la ley." },
          { en: "No retaliation for lawful PLAWA use. Phes cannot discipline, demote, fire, or penalize you for using PLAWA legally.", es: "Sin represalias por el uso legal de PLAWA. Phes no puede disciplinar, degradar, despedir ni penalizar por usar PLAWA legalmente." },
          { en: "Because Phes frontloads the full 40 PLAWA hours at the start of each Benefit Year, unused PLAWA hours from the prior Benefit Year do not carry over. Unused PLAWA hours are not paid out at separation, consistent with the Illinois Paid Leave for All Workers Act frontloading exception.", es: "Debido a que Phes otorga por adelantado las 40 horas completas de PLAWA al inicio de cada Año de Beneficios, las horas de PLAWA no utilizadas del Año de Beneficios anterior no se acumulan. Las horas de PLAWA no utilizadas no se pagan al separarse, conforme a la excepción de otorgamiento por adelantado de la Ley de Licencia Pagada para Todos los Trabajadores de Illinois." },
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
        type: "p",
        text: {
          en: "PTO is a separate employer-provided benefit and is distinct from your Illinois Paid Leave for All Workers Act (PLAWA) bank. PLAWA hours are governed by the rules described in the Any Reason Leave (PLAWA) subsection above and operate independently from PTO. The 80-hour PTO cap and top-up structure described here applies only to PTO and does not affect your PLAWA entitlement.",
          es: "El PTO es un beneficio separado provisto por el empleador y es distinto de su banco de la Ley de Licencia Pagada para Todos los Trabajadores de Illinois (PLAWA). Las horas de PLAWA se rigen por las reglas descritas en la subsección Licencia por Cualquier Razón (PLAWA) arriba y operan independientemente del PTO. El tope de 80 horas de PTO y la estructura de relleno descritos aquí aplican solo al PTO y no afectan su derecho a PLAWA.",
        },
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
          { en: "Bereavement (see the Bereavement Leave subsection below for the full rule, eligible relationships, and documentation).", es: "Duelo (vea la subsección Licencia por Duelo más abajo para la regla completa, relaciones elegibles y documentación)." },
          { en: "Military leave and family military leave.", es: "Licencia militar y licencia militar familiar." },
          { en: "Court appearances as a crime victim, or for proceedings related to domestic violence, sexual violence, or other qualifying crimes (VESSA).", es: "Comparecencias judiciales como víctima de delito, o para procedimientos relacionados con violencia doméstica, violencia sexual u otros delitos calificantes (VESSA)." },
          { en: "Disability-related absences covered by reasonable accommodation.", es: "Ausencias relacionadas con discapacidad cubiertas por acomodación razonable." },
          { en: "Organ or bone marrow donation.", es: "Donación de órganos o médula ósea." },
          // LEGAL-REVIEW-PENDING (2026-05-20): catch-out clause referenced by q-pp-25 / q-pp-27 / q-pp-28 / q-pp-31 option B language.
          { en: "Any other federal, state, or local leave law that applies to your situation. This handbook lists the categories Phes most commonly encounters; it is not an exhaustive list of every legal protection that may apply.", es: "Cualquier otra ley federal, estatal o local de licencia que aplique a su situación. Este manual enumera las categorías que Phes más comúnmente encuentra; no es una lista exhaustiva de toda protección legal que pueda aplicar." },
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
          en: "Phes provides up to three (3) unpaid scheduled workdays per qualifying death for the loss of an immediate family member, defined as: spouse or domestic partner; child or stepchild; parent or stepparent; sibling; or mother- or father-in-law. Employees may use their available Illinois Paid Leave for All Workers Act (PLAWA) hours during these days to receive pay; PLAWA is requested through the standard time-off process. Notify the office as soon as practicable. Phes will request reasonable documentation (an obituary, funeral program, or similar) only when needed for payroll records; you are not required to provide medical or cause-of-death information. Bereavement absences are a protected category and never count toward the discipline scale, regardless of tenure or available leave balance.",
          es: "Phes provee hasta tres (3) días laborales programados no pagados por cada fallecimiento calificado por la pérdida de un familiar inmediato, definido como: cónyuge o pareja doméstica; hijo/a o hijastro/a; padre/madre o padrastro/madrastra; hermano/a; o suegro/a. Los empleados pueden usar sus horas disponibles bajo la Ley de Licencia Pagada para Todos los Trabajadores de Illinois (PLAWA) durante esos días para recibir pago; PLAWA se solicita a través del proceso estándar de tiempo libre. Notifique a la oficina lo antes posible. Phes solicitará documentación razonable (un obituario, programa fúnebre o similar) solo cuando sea necesario para registros de nómina; no se le requiere proveer información médica ni causa de muerte. Las ausencias por duelo son una categoría protegida y nunca cuentan hacia la escala de disciplina, sin importar el tiempo de empleo o el saldo de licencia disponible.",
        },
      },
      {
        type: "p",
        text: {
          en: "Bereavement leave for individuals outside this list — extended family, close friends, or chosen family — is handled case-by-case as unpaid time off subject to office approval.",
          es: "La licencia por duelo para individuos fuera de esta lista — familia extendida, amigos cercanos o familia elegida — se maneja caso por caso como tiempo libre no pagado sujeto a aprobación de la oficina.",
        },
      },
      // FBLA paragraph removed 2026-05-20 — FBLA only applies to employers with 50+ employees;
      // Phes has <50 so the entitlement doesn't apply. Don't promise what we can't deliver.

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
          en: "The Illinois Victims' Economic Security and Safety Act (VESSA) provides eligible Phes employees with protections related to domestic violence, sexual violence, gender violence, and other crimes of violence affecting the employee or a family or household member.",
          es: "La Ley de Seguridad Económica y Seguridad para Víctimas de Illinois (VESSA) provee a los empleados elegibles de Phes protecciones relacionadas con violencia doméstica, violencia sexual, violencia de género y otros delitos de violencia que afecten al empleado o a un familiar o miembro del hogar.",
        },
      },
      {
        type: "p",
        text: {
          en: "Eligible employees may take up to twelve (12) workweeks of unpaid leave in any twelve-month period for any of the following: medical or psychological care, counseling, victim services, legal assistance (including obtaining an order of protection), safety planning, relocation, court appearances, or other activity reasonably necessary to address the violence. VESSA leave may run concurrently with other applicable federal, state, or Phes leave when the law permits.",
          es: "Los empleados elegibles pueden tomar hasta doce (12) semanas laborales de licencia no pagada en cualquier periodo de doce meses por cualquiera de los siguientes: atención médica o psicológica, consejería, servicios para víctimas, asistencia legal (incluyendo obtener una orden de protección), planificación de seguridad, reubicación, comparecencias judiciales u otra actividad razonablemente necesaria para abordar la violencia. La licencia VESSA puede correr concurrentemente con otra licencia federal, estatal o de Phes aplicable cuando la ley lo permita.",
        },
      },
      {
        type: "p",
        text: {
          en: "Provide Phes at least 48 hours advance notice of intent to take VESSA leave when practicable. Phes will request only the minimum documentation required by law (a sworn statement from the employee is sufficient under VESSA in most cases) and will keep all information confidential to the extent permitted by law. Employees affected by domestic or sexual violence may also use employer-issued devices to document incidents; Phes will provide access to such records upon request.",
          es: "Provea a Phes al menos 48 horas de aviso anticipado de la intención de tomar licencia VESSA cuando sea posible. Phes solicitará solo la documentación mínima requerida por la ley (una declaración jurada del empleado es suficiente bajo VESSA en la mayoría de los casos) y mantendrá toda la información confidencial en la medida permitida por la ley. Los empleados afectados por violencia doméstica o sexual también pueden usar dispositivos provistos por el empleador para documentar incidentes; Phes proveerá acceso a tales registros cuando se soliciten.",
        },
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Phes will not retaliate, discipline, demote, terminate, or otherwise penalize any employee for exercising VESSA rights or for requesting reasonable accommodations related to being a victim of violence.",
          es: "Phes no tomará represalias, disciplinará, degradará, terminará ni penalizará de otra forma a ningún empleado por ejercer derechos VESSA ni por solicitar acomodaciones razonables relacionadas con ser víctima de violencia.",
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
          { en: "Eligibility: the 8-hour holiday top-up pay begins AFTER 90 days of employment. Employees in their first 90 days who actually work a holiday are paid regular wages for the time worked, but receive no additional holiday top-up. Employees in their first 90 days who do not work the holiday simply have an unscheduled, unpaid day.", es: "Elegibilidad: el pago adicional de 8 horas por feriado comienza DESPUÉS de 90 días de empleo. Los empleados en sus primeros 90 días que efectivamente trabajan un feriado reciben el salario regular por el tiempo trabajado, pero no reciben el pago adicional por feriado. Los empleados en sus primeros 90 días que no trabajan el feriado simplemente tienen un día no programado y no pagado." },
          { en: "Eligible employees (past their 90th day) who do not work the holiday are paid the holiday top-up at 8 hours at their regular rate. Eligible employees who do work the holiday are paid for the time worked plus the 8-hour top-up, unless otherwise required by law.", es: "Los empleados elegibles (pasados sus 90 días) que no trabajan el feriado reciben el pago adicional por feriado a 8 horas a su tarifa regular. Los empleados elegibles que sí trabajan el feriado reciben el pago por el tiempo trabajado más el pago adicional de 8 horas, a menos que la ley exija otra cosa." },
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
          { en: "Cannot be combined with PTO, holidays, weekends, or other approved time off to create a stretch of more than three (3) consecutive scheduled workdays off without separate prior written approval from the office. To request a longer stretch using the birthday day plus PTO, submit both requests at the same time with at least fourteen (14) days advance notice. The office may deny either request — birthday, PTO, or both — if granting them (alone or together) would exceed the maximum-2-cleaners-off-per-day cap, exceed the 3-consecutive-workday limit, or otherwise create staffing risk. Requests submitted separately that reveal a combined longer stretch may be denied for that reason.", es: "No se puede combinar con PTO, feriados, fines de semana ni otro tiempo libre aprobado para crear una racha de más de tres (3) días laborales programados consecutivos libres sin aprobación previa por escrito separada de la oficina. Para solicitar una racha más larga usando el día de cumpleaños más PTO, envíe ambas solicitudes al mismo tiempo con al menos catorce (14) días de anticipación. La oficina puede negar cualquiera de las solicitudes — cumpleaños, PTO o ambas — si otorgarlas (solas o juntas) excedería el tope máximo de 2 cleaners libres por día, excedería el límite de 3 días laborales consecutivos, o crearía un riesgo de personal. Las solicitudes enviadas por separado que revelen una racha combinada más larga pueden ser negadas por esa razón." },
          { en: "Does NOT carry over. Forfeited if not used in your birth month.", es: "NO se acumula. Se pierde si no se usa en su mes de cumpleaños." },
          { en: "Employees on active written warning, final warning, or Quality Probation may have their birthday request denied at office discretion.", es: "Empleados con advertencia activa por escrito, advertencia final o Probatoria de Calidad pueden ver su solicitud de cumpleaños rechazada a discreción de la oficina." },
        ],
      },
      // LEGAL-REVIEW-PENDING (2026-05-21): Birthday Pay classified as discretionary benefit, not earned wages
      // under 820 ILCS 115. Replaces the bare "NOT paid out at separation" bullet with the full discretionary-
      // benefit framing so the no-payout rule is legally defensible.
      {
        type: "p",
        text: {
          en: "Birthday Pay is a discretionary benefit, not earned wages under the Illinois Wage Payment and Collection Act. It does not vest, accrue, or constitute compensation for services performed. The benefit is conditioned exclusively on use during the employee's birth month within the applicable Benefit Year, with proper advance request and office approval. Birthday Pay is forfeited if not used in the birth month and is not paid out at separation under any circumstance.",
          es: "El Pago de Cumpleaños es un beneficio discrecional, no salario ganado bajo la Ley de Pago y Cobranza de Salarios de Illinois. No se consolida, acumula, ni constituye compensación por servicios prestados. El beneficio está condicionado exclusivamente al uso durante el mes de cumpleaños del empleado dentro del Año de Beneficios aplicable, con solicitud previa apropiada y aprobación de la oficina. El Pago de Cumpleaños se pierde si no se usa en el mes de cumpleaños y no se paga al separarse bajo ninguna circunstancia.",
        },
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
      {
        type: "p",
        text: {
          en: "The two-step process applies only to PLANNED time-off requests (PTO, scheduled PLAWA use, birthday, schedule change requests). Same-day PLAWA call-offs for unforeseeable absences (sudden illness, family emergency, accident) require only the 20-minute grace-window call to the office. No advance system submission is required for unforeseeable PLAWA absences.",
          es: "El proceso de dos pasos aplica solo a solicitudes de tiempo libre PLANEADAS (PTO, uso programado de PLAWA, cumpleaños, solicitudes de cambio de horario). Las llamadas el mismo día de PLAWA por ausencias imprevisibles (enfermedad súbita, emergencia familiar, accidente) requieren solo la llamada de la ventana de gracia de 20 minutos a la oficina. No se requiere envío anticipado en el sistema para ausencias imprevisibles de PLAWA.",
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
          { en: "Jewelry should be minimal and safe for cleaning work. Specifically: no rings with raised stones, no dangling bracelets, no long necklaces, no large earrings. Small studs, plain wedding bands, and small chain necklaces tucked under your shirt are acceptable. The standard: nothing that can scratch surfaces or catch on equipment, fabric, or fixtures.", es: "La joyería debe ser mínima y segura para el trabajo de limpieza. Específicamente: sin anillos con piedras elevadas, sin pulseras colgantes, sin collares largos, sin aretes grandes. Aretes pequeños tipo poste, anillos de matrimonio sencillos y cadenas pequeñas guardadas dentro de la camisa son aceptables. El estándar: nada que pueda rayar superficies o engancharse con equipo, tela o accesorios." },
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
          { en: "Personal cell phones may be carried on you during a job.", es: "Los teléfonos personales pueden llevarse consigo durante un trabajo." },
          { en: "Music through headphones is allowed during cleaning. Keep the volume respectful and avoid explicit content in client homes.", es: "Se permite escuchar música con audífonos durante la limpieza. Mantenga el volumen respetuoso y evite contenido explícito en hogares de clientes." },
          { en: "Stay reachable for the office. Office calls and texts may come through during a job and you should respond promptly.", es: "Manténgase disponible para la oficina. Las llamadas y mensajes de la oficina pueden llegar durante un trabajo y debe responder con prontitud." },
          { en: "Personal phone calls and video calls are NOT allowed during a job, except for genuine emergencies.", es: "Las llamadas personales y videollamadas NO están permitidas durante un trabajo, salvo emergencias genuinas." },
          { en: "Employees may call 911 or emergency services at any time during a job without prior authorization. Notify the office as soon as practicable after the emergency is addressed.", es: "Los empleados pueden llamar al 911 o a servicios de emergencia en cualquier momento durante un trabajo sin autorización previa. Notifique a la oficina lo antes posible después de atender la emergencia." },
          { en: "Personal texts and social media wait until break or after the visit.", es: "Mensajes personales y redes sociales esperan hasta el descanso o después de la visita." },
          { en: "To take a non-emergency call, exit the home entirely and notify your teammate.", es: "Para tomar una llamada que no sea emergencia, salga completamente del hogar y notifique a su compañero de equipo." },
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
          { en: "Bodily fluids and biohazards (blood, vomit, urine, feces, hoarding situations, infestations). Decline politely. The office can refer a biohazard service.", es: "Fluidos corporales y riesgos biológicos (sangre, vómito, orina, heces, situaciones de acumulación, infestaciones). Rechácelo cortésmente. La oficina puede referir un servicio de biohazard." },
          { en: "Inside the oven, refrigerator, or freezer (default scope). The office can add it; call.", es: "Dentro del horno, refrigerador o congelador (alcance estándar). La oficina lo puede agregar; llame." },
          { en: "Pet waste, including litter boxes and animal waste.", es: "Desechos de mascotas, incluyendo cajas de arena y desechos animales." },
          { en: "Cash transactions on site. All payment goes through the office.", es: "Transacciones en efectivo en sitio. Todo pago pasa por la oficina." },
          { en: "Climbing higher than a 2-step step stool (see Climbing Limits — Safety Rule under On-Site Rules below for the full rule).", es: "Subir más alto que un banquito de 2 escalones (vea Límites de Escalada — Regla de Seguridad bajo Reglas en Sitio más abajo para la regla completa)." },
          { en: "Wash dishes.", es: "Lavar platos." },
          { en: "Make beds.", es: "Tender camas." },
          { en: "Move heavy furniture. We clean around it. Anything over 25 lbs we do not lift or relocate.", es: "Mover muebles pesados. Limpiamos alrededor. Nada que pese más de 25 lb se levanta o se mueve." },
          { en: "Clean window tracks.", es: "Limpiar rieles de ventanas." },
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
          en: "Important: Move-In / Move-Out cleans assume an empty home. If you arrive and the space is furnished or has belongings still in place, STOP. Call the office before starting. Scope and pricing change when there is furniture in the way. Do not begin a Move-In / Move-Out clean in a non-empty space without office approval.",
          es: "Importante: las limpiezas de Mudanza asumen una casa vacía. Si llega y el espacio está amueblado o tiene pertenencias todavía en su lugar, DETÉNGASE. Llame a la oficina antes de empezar. El alcance y el precio cambian cuando hay muebles en medio. No empiece una limpieza de Mudanza en un espacio no vacío sin aprobación de la oficina.",
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
          { en: "Climbing limits: see the Climbing Limits — Safety Rule subsection immediately below.", es: "Límites de escalada: vea la subsección Límites de Escalada — Regla de Seguridad inmediatamente abajo." },
          { en: "Trash: 5 bag maximum per visit. If there is more, document and tell the office. We do not haul extra.", es: "Basura: máximo 5 bolsas por visita. Si hay más, documente y avise a la oficina. No llevamos más." },
          { en: "Arrival window: clients are told to expect a 45-minute arrival window due to traffic. If you will be at the late end, the office calls or texts the client. YOU also call the office BEFORE the 20-minute mark when running behind.", es: "Ventana de llegada: a los clientes se les dice que esperen una ventana de llegada de 45 minutos por el tráfico. Si llegará al final tarde, la oficina llama o envía mensaje al cliente. USTED también llama a la oficina ANTES del minuto 20 cuando esté retrasado." },
          { en: "Lockbox / alarm code: some clients have a lockbox or alarm code. The office tells you in the app notes. Never share codes with anyone. Never write them down outside the app.", es: "Caja de seguridad / código de alarma: algunos clientes tienen caja o código de alarma. La oficina le dice en las notas de la app. Nunca comparta los códigos. Nunca los escriba fuera de la app." },
          { en: "Decluttering: if surfaces are too cluttered to clean and the client was not notified ahead, call the office. We can decline (with cancellation fee applying) or shift scope. Never silently work around chaos.", es: "Desorden: si las superficies están demasiado desordenadas para limpiar y el cliente no fue avisado, llame a la oficina. Podemos rechazar (con cargo de cancelación aplicado) o cambiar el alcance. Nunca trabaje silenciosamente alrededor del caos." },
        ],
      },

      { type: "h", text: { en: "Climbing Limits — Safety Rule", es: "Límites de Escalada — Regla de Seguridad" } },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "The maximum permitted climbing height for any Phes employee at any time on any job is the top step of a standard 2-step company-issued step stool. Climbing higher than this is prohibited under all circumstances, with no exceptions for client request, time pressure, or partial-task completion.",
          es: "La altura máxima permitida de escalada para cualquier empleado de Phes en cualquier momento y en cualquier trabajo es el escalón superior de un banquito estándar de 2 escalones provisto por la compañía. Subir más alto está prohibido bajo todas las circunstancias, sin excepciones por solicitud del cliente, presión de tiempo o tarea parcialmente completada.",
        },
      },
      {
        type: "p",
        text: {
          en: "Prohibited climbing surfaces (this list is examples and is not exhaustive): chairs of any kind, dining or kitchen counters, ladders taller than 2 steps, dressers and other furniture, kitchen or bathroom appliances, toilets, bathtubs, sinks, vanities, edges of bed frames, exercise equipment, storage tubs, or any surface not designed and rated as a climbing aid.",
          es: "Superficies prohibidas para escalar (esta lista son ejemplos y no es exhaustiva): sillas de cualquier tipo, mostradores de cocina o comedor, escaleras más altas que 2 escalones, cómodas y otros muebles, electrodomésticos de cocina o baño, inodoros, tinas, lavabos, tocadores, bordes de marcos de cama, equipo de ejercicio, contenedores de almacenamiento, o cualquier superficie no diseñada y clasificada como ayuda para escalar.",
        },
      },
      {
        type: "p",
        text: {
          en: "If a cleaning task requires reaching above this height, you must: (1) skip the task, (2) document it in the app notes verbatim as 'out of reach — exceeds 2-step climbing rule', and (3) complete the rest of the job. If the client asks why the area was skipped, say only 'that's outside our scope today' — do not promise or imply that the office will send someone else to do it. The office will follow up with the client directly if appropriate.",
          es: "Si una tarea de limpieza requiere alcanzar por encima de esta altura, debe: (1) omitir la tarea, (2) documentarla en las notas de la app textualmente como 'fuera de alcance — excede la regla de escalada de 2 escalones', y (3) completar el resto del trabajo. Si el cliente pregunta por qué el área se omitió, diga solo 'eso está fuera de nuestro alcance hoy' — no prometa ni dé a entender que la oficina enviará a alguien más a hacerlo. La oficina dará seguimiento directamente con el cliente si es apropiado.",
        },
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Violating this rule is grounds for discipline regardless of whether an injury results, up to and including immediate termination if the violation is willful or repeated. This rule exists to protect employees from fall injuries — falls are the most common preventable workplace injury in cleaning services — and to protect Phes from workers' compensation claims arising from preventable falls.",
          es: "Violar esta regla es motivo de disciplina sin importar si resulta una lesión, hasta e incluyendo terminación inmediata si la violación es intencional o repetida. Esta regla existe para proteger a los empleados de lesiones por caídas — las caídas son la lesión laboral prevenible más común en servicios de limpieza — y para proteger a Phes de reclamos de compensación al trabajador por caídas prevenibles.",
        },
      },
      // LEGAL-REVIEW-PENDING (2026-05-21): explicit non-retaliation language for safety reports
      // and workers comp claims. Decouples safety-rule discipline from any protected activity.
      {
        type: "p",
        text: {
          en: "Discipline for safety rule violations is based solely on the rule violation itself and is unrelated to whether the employee files or has filed a workers' compensation claim, an OSHA complaint, or any other protected report. Phes does not retaliate against employees for filing workers' compensation claims, reporting workplace safety concerns, or exercising any other right protected by federal, state, or local law.",
          es: "La disciplina por violaciones a las reglas de seguridad se basa únicamente en la violación de la regla misma y no se relaciona con si el empleado presenta o ha presentado un reclamo de compensación al trabajador, una queja ante OSHA, o cualquier otro reporte protegido. Phes no toma represalias contra los empleados por presentar reclamos de compensación al trabajador, reportar preocupaciones de seguridad en el lugar de trabajo, o ejercer cualquier otro derecho protegido por la ley federal, estatal o local.",
        },
      },

      { type: "h", text: { en: "Never Discuss Price With the Client", es: "Nunca Discuta el Precio Con el Cliente" } },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Pricing conversations are 100% the office's job. If a client tries to negotiate, asks for a discount, offers cash for an unscheduled service, or tries to renegotiate the service fee in front of you, politely say 'I will have the office reach out to discuss pricing' and call the office. If a client attempts to negotiate pricing with you, the office will follow up with them directly. Do not let it pull you into the conversation. Protect yourself: stay out of money conversations.",
          es: "Las conversaciones sobre precios son 100% trabajo de la oficina. Si un cliente intenta negociar, pide descuento, ofrece efectivo por un servicio no agendado o intenta renegociar la tarifa frente a usted, diga cortésmente 'la oficina los contactará para discutir el precio' y llame a la oficina. Si un cliente intenta negociar el precio con usted, la oficina dará seguimiento directamente. No deje que la conversación lo arrastre. Protéjase: manténgase fuera de conversaciones de dinero.",
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
        type: "p",
        text: {
          en: "Total on-site wait is 20 minutes from your scheduled arrival time, unless the office extends it for an unusual reason. The flow:",
          es: "La espera total en sitio es de 20 minutos desde su hora programada de llegada, a menos que la oficina la extienda por una razón excepcional. El flujo:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Step 1. Arrive. Knock once and wait 5 minutes for a response.", es: "Paso 1. Llegue. Toque una vez y espere 5 minutos por respuesta." },
          { en: "Step 2. If you have access (key, code, lockbox) and the app job ticket authorizes entry without the client present: enter, complete the job normally, take all required photos, and lock up.", es: "Paso 2. Si tiene acceso (llave, código, caja de seguridad) y el ticket de trabajo en la app autoriza entrar sin el cliente presente: entre, complete el trabajo normalmente, tome todas las fotos requeridas y cierre con llave." },
          { en: "Step 3. If you do NOT have access — or the client's instructions require their presence — call the office within 5 minutes of arrival. The office attempts to contact the client.", es: "Paso 3. Si NO tiene acceso — o las instrucciones del cliente requieren su presencia — llame a la oficina dentro de 5 minutos de la llegada. La oficina intenta contactar al cliente." },
          { en: "Step 4. Continue waiting at the location until the total on-site time reaches 20 minutes from your scheduled arrival. The office may instruct you in writing (text or app note) to extend the wait beyond 20 minutes for an unusual reason — for example, the client is on the way and 5 minutes out, or there is a known delay the office is resolving.", es: "Paso 4. Continúe esperando en el lugar hasta que el tiempo total en sitio alcance los 20 minutos desde su hora programada de llegada. La oficina puede instruirle por escrito (mensaje o nota en la app) extender la espera más allá de 20 minutos por una razón excepcional — por ejemplo, el cliente está en camino y a 5 minutos, o hay un retraso conocido que la oficina está resolviendo." },
          { en: "Step 5. Before leaving — even after the 20 minutes — call the office and verbally confirm you are leaving and where you are going next. Never leave on your own initiative without office confirmation.", es: "Paso 5. Antes de irse — incluso después de los 20 minutos — llame a la oficina y confirme verbalmente que se va y a dónde se dirige después. Nunca se vaya por iniciativa propia sin confirmación de la oficina." },
          { en: "Step 6. The office decides: reschedule the visit, send you to the next job in your route, or send you home. You are paid the 3-hour minimum for the arrival regardless of which the office chooses.", es: "Paso 6. La oficina decide: reprogramar la visita, enviarlo al siguiente trabajo de su ruta o enviarlo a casa. Recibe el mínimo de 3 horas por la llegada sin importar lo que la oficina decida." },
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

      { type: "h", text: { en: "Lifting Limits", es: "Límites de Levantamiento" } },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Phes employees never lift items over 25 lbs alone. This includes furniture, large appliances, packed boxes, or anything else requiring two-person handling. Clean around heavy items. Do not attempt to move them. If a job requires moving something over 25 lbs, call the office. This rule protects you from injury and protects Phes from workers' compensation claims.",
          es: "Los empleados de Phes nunca levantan artículos de más de 25 libras solos. Esto incluye muebles, electrodomésticos grandes, cajas empacadas o cualquier cosa que requiera dos personas. Limpie alrededor de los artículos pesados. No intente moverlos. Si un trabajo requiere mover algo de más de 25 libras, llame a la oficina. Esta regla lo protege de lesiones y protege a Phes de reclamos de compensación al trabajador.",
        },
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
          { en: "Reimbursed at $0.725 per mile (Phes's current rate, at or above the IRS standard mileage rate in effect at the time of travel).", es: "Se reembolsa a $0.725 por milla (la tarifa actual de Phes, al nivel o por encima de la tarifa estándar de millaje del IRS vigente al momento del viaje)." },
          { en: "Must be submitted through the Phes app within the same calendar month incurred. Include date, client names, total miles.", es: "Debe enviarse por la app de Phes dentro del mismo mes calendario en que se incurrió. Incluya fecha, nombres de clientes, total de millas." },
          { en: "Late or incomplete submissions may be denied. Mileage reimbursement is NOT considered wages.", es: "Las solicitudes tardías o incompletas pueden ser denegadas. El reembolso de millaje NO se considera salario." },
        ],
      },

      { type: "h", text: { en: "Parking", es: "Estacionamiento" } },
      {
        type: "bullets",
        items: [
          { en: "Phes covers all parking costs incurred while driving to or between client jobs. You are responsible for actually using the tools below — un-validated tickets, late payments, and impound fees from your failure to use them are NOT covered.", es: "Phes cubre todos los costos de estacionamiento incurridos al conducir hacia o entre trabajos de clientes. Usted es responsable de USAR las herramientas a continuación — multas no validadas, pagos tardíos y tarifas de remolque por no usarlas NO están cubiertos." },
          { en: "Chicago metered street parking: use the ParkChicago app. Phes provides you access — the office links your tech profile to a Phes-funded ParkChicago account.", es: "Estacionamiento medido en la calle de Chicago: use la app ParkChicago. Phes le da acceso — la oficina vincula su perfil de técnico a una cuenta ParkChicago financiada por Phes." },
          { en: "Garages, surface lots, and non-metered paid parking: use SpotHero to reserve and pay through the Phes-linked account.", es: "Estacionamientos, lotes de superficie y estacionamiento pagado sin medidor: use SpotHero para reservar y pagar a través de la cuenta vinculada a Phes." },
          { en: "ParkChicago and SpotHero are for Phes work travel only. Personal use of either tool through your Phes-linked account is treated as misuse of company resources and is grounds for discipline.", es: "ParkChicago y SpotHero son solo para viajes de trabajo de Phes. El uso personal de cualquiera de estas herramientas a través de su cuenta vinculada a Phes se trata como mal uso de recursos de la compañía y es motivo de disciplina." },
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

      { type: "h", text: { en: "Supply Pickup and Maintenance Responsibility", es: "Responsabilidad de Recoger y Mantener los Suministros" } },
      {
        type: "p",
        text: {
          en: "It is your responsibility as a Phes technician to maintain your supply kit and ensure you have the supplies you need to perform your assigned work. Phes provides supplies at the office. You are responsible for picking them up.",
          es: "Es su responsabilidad como técnico de Phes mantener su kit de suministros y asegurarse de tener los suministros que necesita para realizar el trabajo asignado. Phes provee los suministros en la oficina. Usted es responsable de recogerlos.",
        },
      },
      {
        type: "p",
        text: {
          en: "Supply pickup is flexible. You may come to the office at any time during office hours, including before your scheduled workday, after your scheduled workday, or on your scheduled days off. Phes does not require daily check-ins at the office. We provide flexibility, and we expect you to plan your supply pickups responsibly.",
          es: "Recoger suministros es flexible. Puede venir a la oficina en cualquier momento durante el horario de oficina, incluyendo antes de su jornada laboral, después de su jornada laboral, o en sus días libres programados. Phes no requiere visitas diarias a la oficina. Le damos flexibilidad y esperamos que planifique sus recogidas de suministros con responsabilidad.",
        },
      },
      {
        type: "p",
        text: {
          en: "Supply pickup is a preparatory activity. It is not part of your scheduled workday. Travel time to and from the office for supply pickup is not compensated, and mileage to the office for supply pickup is not reimbursed.",
          es: "Recoger suministros es una actividad preparatoria. No es parte de su jornada laboral programada. El tiempo de viaje hacia y desde la oficina para recoger suministros no se compensa, y el millaje hacia la oficina para recoger suministros no se reembolsa.",
        },
      },
      {
        type: "p",
        text: {
          en: "If you run out of supplies because you failed to pick them up in advance, you are responsible for solving the gap on your own time and at your own expense. Phes will not ship supplies to your home, will not deliver supplies to job sites for supply gaps caused by poor planning, and will not pay you for time spent running to retail stores in those circumstances.",
          es: "Si se queda sin suministros porque no los recogió con anticipación, usted es responsable de resolver la falta en su propio tiempo y a su propio costo. Phes no enviará suministros a su casa, no entregará suministros en los sitios de trabajo por faltas causadas por mala planificación, y no le pagará por el tiempo dedicado a ir a tiendas minoristas en esas circunstancias.",
        },
      },
      {
        type: "p",
        text: {
          en: "Repeatedly running out of supplies or failing to maintain your supply kit may result in discipline up to and including termination. See the Supply Kit Responsibility module (Module 13) for full details on supply planning, office pickup hours, and supply management best practices.",
          es: "Quedarse sin suministros repetidamente o no mantener su kit de suministros puede resultar en disciplina hasta e incluyendo la terminación. Vea el módulo de Responsabilidad del Kit de Suministros (Módulo 13) para todos los detalles sobre planificación de suministros, horarios de recogida en oficina y mejores prácticas de gestión de suministros.",
        },
      },

      { type: "h", text: { en: "Final Pay and Property Return", es: "Pago Final y Devolución de Propiedad" } },
      {
        type: "p",
        text: {
          en: "All company property must be returned upon separation. A required separation meeting takes place in the office on the last day or within 3 business days. Property includes the supply kit ($500+ value), uniforms, keys, access cards, and company app access. The final paycheck (including unused PTO payout) is issued at the separation meeting or by the next regular payday, whichever is earlier, per the Illinois Wage Payment and Collection Act. If the employee requested physical paper checks, the final paycheck is prepared as a physical check. If the employee cannot come to the office, the final paycheck is mailed.",
          es: "Toda la propiedad de la compañía debe ser devuelta al separarse. Se realiza una reunión obligatoria de separación en la oficina el último día o dentro de 3 días hábiles. La propiedad incluye el kit de suministros (valor de $500+), uniformes, llaves, tarjetas de acceso y acceso a la app de la compañía. El cheque final (incluyendo el pago de PTO no usado) se entrega en la reunión de separación o para el siguiente día de pago regular, lo que ocurra primero, conforme a la Ley de Pago y Cobranza de Salarios de Illinois. Si el empleado solicitó cheques físicos en papel, el cheque final se prepara como un cheque físico. Si el empleado no puede ir a la oficina, el cheque final se envía por correo.",
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
          { en: "Tips received through the booking system are reported as wages on your W-2.", es: "Las propinas recibidas a través del sistema de reservas se reportan como salarios en su W-2." },
          { en: "Tips received through the booking system are subject to standard payroll tax withholding (federal income tax, FICA, Medicare, and applicable state taxes).", es: "Las propinas recibidas a través del sistema de reservas están sujetas a retención estándar de impuestos sobre nómina (impuesto federal sobre la renta, FICA, Medicare e impuestos estatales aplicables)." },
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
          { en: "Quarterly reviews thereafter. Reviews rotate format: an in-person meeting one quarter, a video review the next, alternating each quarter.", es: "Evaluaciones trimestrales en adelante. Las evaluaciones rotan de formato: una reunión en persona un trimestre, una revisión por video al siguiente, alternando cada trimestre." },
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
          { en: "Hour reductions do not constitute a termination of employment and do not affect at-will status.", es: "Las reducciones de horas no constituyen una terminación del empleo y no afectan el estatus de empleo a voluntad." },
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
      {
        type: "p",
        text: {
          en: "Phes determines in good faith whether a change is material. A change is 'material' if it affects: compensation rates or structure (including commission percentages, hourly rates, and quality-verification rules); leave entitlements (PLAWA, PTO, Unpaid Personal Leave, holidays, birthday pay, bereavement, FBLA, or VESSA); disciplinary thresholds (tardiness or unexcused-absence scales, quality probation triggers, job-abandonment definition); mandatory training requirements; the at-will employment relationship; the wage deduction policy; or any other term a reasonable employee would consider a fundamental condition of employment. The good-faith determination by Phes is binding for purposes of the re-acknowledgment requirement. Employees who believe a change was misclassified may raise the concern with the office in writing; the classification stands unless reversed in writing by the owner.",
          es: "Phes determina de buena fe si un cambio es material. Un cambio es 'material' si afecta: tarifas o estructura de compensación (incluyendo porcentajes de comisión, tarifas por hora y reglas de verificación de calidad); derechos de licencia (PLAWA, PTO, Licencia Personal No Pagada, feriados, pago de cumpleaños, duelo, FBLA o VESSA); umbrales disciplinarios (escalas de tardanza o ausencia injustificada, disparadores de probatoria de calidad, definición de abandono del empleo); requisitos de capacitación obligatoria; la relación de empleo a voluntad; la política de deducción salarial; o cualquier otro término que un empleado razonable consideraría una condición fundamental del empleo. La determinación de buena fe por parte de Phes es vinculante para efectos del requisito de re-reconocimiento. Los empleados que crean que un cambio fue clasificado erróneamente pueden plantear la preocupación a la oficina por escrito; la clasificación permanece a menos que sea revertida por escrito por el propietario.",
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
          { en: "You provide EXPRESS WRITTEN CONSENT to the commission structure: 35% commission on standard cleanings, 32% on deep cleans and move-in / move-out cleanings, $20.00 per hour for commercial jobs within allotted hours. Commission is contingent on Quality Verification, which occurs at the earlier of (a) 24 hours post-job with no client complaint, or (b) the client's affirmative confirmation of satisfaction. If you refuse a valid Fix-It re-clean request without a lawful or protected reason, Quality Verification fails, commission is not earned on that job, and compensation defaults to the on-site hourly rate of $18.00 per hour for time actually worked. This commission structure is a fundamental term of employment.", es: "Provee CONSENTIMIENTO EXPRESO POR ESCRITO a la estructura de comisión: 35% en limpiezas estándar, 32% en limpiezas profundas y mudanzas, $20.00 por hora en trabajos comerciales dentro de las horas asignadas. La comisión es contingente a la Verificación de Calidad, que ocurre en el momento más temprano entre (a) 24 horas después del trabajo sin queja del cliente, o (b) la confirmación afirmativa de satisfacción del cliente. Si rechaza una solicitud válida de re-limpieza Fix-It sin razón legal o protegida, la Verificación de Calidad falla, no se gana comisión en ese trabajo, y la compensación se rige por la tarifa por hora en sitio de $18.00 por el tiempo realmente trabajado. Esta estructura de comisión es un término fundamental del empleo." },
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

      { type: "h", text: { en: "Allowed Hours: How They Work and How to Maximize Your Pay", es: "Horas Asignadas: Cómo Funcionan y Cómo Maximizar Su Pago" } },
      {
        type: "p",
        text: {
          en: "Every Phes job has an allowed hours number — the time Phes budgets for that visit, based on the home, the service type, and historical performance data. Allowed hours are the budget. Your commission is paid on the job total, NOT on the time you take. That means: if you finish faster than the allowed hours without compromising quality, your effective hourly rate goes UP.",
          es: "Cada trabajo de Phes tiene un número de horas asignadas — el tiempo que Phes presupuesta para esa visita, según el hogar, el tipo de servicio y datos históricos de desempeño. Las horas asignadas son el presupuesto. Su comisión se paga sobre el total del trabajo, NO sobre el tiempo que tarda. Eso significa: si termina más rápido que las horas asignadas sin comprometer la calidad, su tarifa efectiva por hora SUBE.",
        },
      },
      {
        type: "p",
        text: {
          en: "Example: a 4-hour Move-Out clean billed at $80/hour = $320 job total. Your 32% commission = $102.40. That's a fixed amount tied to the JOB, not to how long it takes you.",
          es: "Ejemplo: una limpieza de Mudanza de 4 horas facturada a $80/hora = $320 total del trabajo. Su 32% de comisión = $102.40. Esa es una cantidad fija ligada al TRABAJO, no a cuánto tarda.",
        },
      },
      {
        type: "table",
        head: {
          en: ["If you finish in…", "Your pay", "Your effective $/hr"],
          es: ["Si termina en…", "Su pago", "Su tarifa efectiva $/hr"],
        },
        rows: [
          { en: ["4.0 hours (the full allowed time)", "$102.40", "$25.60/hr"], es: ["4.0 horas (todo el tiempo asignado)", "$102.40", "$25.60/hr"] },
          { en: ["3.5 hours", "$102.40", "$29.26/hr"], es: ["3.5 horas", "$102.40", "$29.26/hr"] },
          { en: ["3.2 hours", "$102.40", "$32.00/hr"], es: ["3.2 horas", "$102.40", "$32.00/hr"] },
          { en: ["2.5 hours", "$102.40", "$40.96/hr"], es: ["2.5 horas", "$102.40", "$40.96/hr"] },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Speed does NOT replace quality. The 24-hour Quality Verification window means your commission is contingent until the client either confirms satisfaction OR 24 hours pass with no complaint. If you rush and the client calls back unhappy: you return for the Fix-It re-clean when Phes schedules the return and full commission stays earned. The re-clean visit is part of the original commission and there is no additional pay for the re-clean visit itself. If you refuse the re-clean visit Phes dispatches you to perform without a lawful or protected reason: commission is NOT earned. The job defaults to $18.00 per hour for on-site time. That's significantly LESS than $25.60/hr, never mind the $40.96/hr you would have made on a fast clean done right. Bottom line: a fast clean done well equals more dollars per hour. A fast clean done badly plus you do the dispatched re-clean still equals full commission earned. A fast clean done badly plus you refuse the dispatched re-clean equals the $18.00 per hour default rate. Doing the fix protects your commission. The math only works when quality holds, and the Fix-It Rule is the safety net when it does not.",
          es: "La rapidez NO reemplaza la calidad. La ventana de Verificación de Calidad de 24 horas significa que su comisión es contingente hasta que el cliente confirme satisfacción O pasen 24 horas sin queja. Si se apura y el cliente llama inconforme: regresa a la re-limpieza Fix-It cuando Phes programe el regreso y la comisión completa se mantiene ganada. La visita de re-limpieza es parte de la comisión original y no hay pago adicional por la visita de re-limpieza en sí. Si rechaza la visita de re-limpieza que Phes le despacha sin razón legal o protegida: la comisión NO se gana. El trabajo se rige por la tarifa por hora en sitio de $18.00. Eso es significativamente MENOS que $25.60/hr, mucho menos los $40.96/hr que habría ganado con una limpieza rápida bien hecha. Conclusión: una limpieza rápida bien hecha equivale a más dólares por hora. Una limpieza rápida mal hecha más usted hace la re-limpieza despachada todavía equivale a la comisión completa ganada. Una limpieza rápida mal hecha más usted rechaza la re-limpieza despachada equivale a la tarifa por defecto de $18.00 por hora. Hacer la corrección protege su comisión. La matemática solo funciona cuando la calidad se mantiene, y la Regla de Corrección es la red de seguridad cuando no se mantiene.",
        },
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
          en: "If a client notifies Phes within 24 hours of the original cleaning that they are unhappy with anything in their home, the Fix-It guarantee is invoked. The office sends the client a Shortfall Report form to document the specific areas or tasks at issue and asks for photographs to verify. The office then dispatches the re-clean visit as soon as reasonably possible based on the client's availability, normally within 7 days of the client's notification (longer only when the client cannot accommodate sooner). The 24-hour window applies to the client's notification, not to Phes's return visit. The obligation to return does NOT expire simply because more than 24 hours have passed since the original job. When the guarantee is invoked, Quality Verification is suspended until the dispatched re-clean either completes (commission earned) or is refused (commission not earned, $18.00 per hour default applies). If the original team returns to their own job, the re-clean is part of the original commission and there is no additional pay for the re-clean visit itself. If a recovery technician is dispatched because the original team cannot return, that recovery tech is paid $20.00 per hour with a 3-hour minimum (paid 3 hours even if the shortfall fix takes less time). The recovery tech only addresses the documented shortfall, not the whole job.",
          es: "Si un cliente notifica a Phes dentro de las 24 horas de la limpieza original que está inconforme con cualquier cosa en su hogar, se invoca la garantía Fix-It. La oficina envía al cliente un formulario de Reporte de Deficiencia para documentar las áreas o tareas específicas en cuestión y solicita fotografías para verificar. La oficina luego despacha la visita de re-limpieza tan pronto como sea razonablemente posible según la disponibilidad del cliente, normalmente dentro de 7 días de la notificación del cliente (más tiempo solo cuando el cliente no puede acomodar antes). La ventana de 24 horas aplica a la notificación del cliente, no a la visita de regreso de Phes. La obligación de regresar NO expira simplemente porque hayan pasado más de 24 horas desde el trabajo original. Cuando se invoca la garantía, la Verificación de Calidad se suspende hasta que la re-limpieza despachada se complete (comisión ganada) o sea rechazada (comisión no ganada, aplica la tarifa por defecto de $18.00 por hora). Si el equipo original regresa a su propio trabajo, la re-limpieza es parte de la comisión original y no hay pago adicional por la visita de re-limpieza en sí. Si se despacha a un técnico de recuperación porque el equipo original no puede regresar, ese técnico de recuperación recibe $20.00 por hora con un mínimo de 3 horas (paga 3 horas aunque la corrección del problema tome menos tiempo). El técnico de recuperación solo atiende el problema documentado, no el trabajo completo.",
        },
      },
      {
        type: "p",
        text: {
          en: "Phes honors valid Fix-It guarantee calls without exception. The office determines validity in good faith based on the client's complaint, the Shortfall Report form submitted by the client, photographs verifying the shortfall, documented job photos from the original visit, and the Quality Verification framework defined in the Phes Policies and Procedures handbook. Refusing the re-clean visit Phes dispatches you to perform without a lawful or protected reason is insubordination and may result in discipline up to and including immediate termination. In that case, Quality Verification fails, commission is not earned on the original job, and compensation defaults to the on-site hourly rate of $18.00 per hour for time actually worked. If you are unavailable on the dispatched date for a reason you raise in advance, the office will work to reschedule; that is not refusal.",
          es: "Phes honra las llamadas de garantía Fix-It válidas sin excepción. La oficina determina la validez de buena fe en base a la queja del cliente, el formulario de Reporte de Deficiencia enviado por el cliente, las fotografías que verifican la deficiencia, las fotos documentadas del trabajo de la visita original, y el marco de Verificación de Calidad definido en el manual de Políticas y Procedimientos de Phes. Rechazar la visita de re-limpieza que Phes le despacha sin una razón legal o protegida es insubordinación y puede resultar en disciplina hasta e incluyendo terminación inmediata. En ese caso, la Verificación de Calidad falla, la comisión no se gana en el trabajo original, y la compensación se rige por la tarifa por hora en sitio de $18.00 por hora por el tiempo efectivamente trabajado. Si usted no está disponible en la fecha despachada por una razón que plantea con anticipación, la oficina trabajará para reprogramar; eso no es rechazo.",
        },
      },
      {
        type: "p",
        text: {
          en: "Repeated Fix-It calls on your jobs may trigger Quality Probation.",
          es: "Llamadas Fix-It repetidas en sus trabajos pueden activar Periodo de Prueba de Calidad.",
        },
      },

      { type: "h", text: { en: "Quality Probation", es: "Periodo de Prueba de Calidad" } },
      {
        type: "p",
        text: {
          en: "If you have two valid quality complaints within a rolling 30-day window, you enter Quality Probation: 30 days at $20.00 per hour (no commission) while you ride along with senior techs. Pass the probation by completing 30 consecutive days clean of valid quality complaints to return to commission. Fail probation again and the next step is termination.",
          es: "Si tiene dos quejas válidas de calidad dentro de una ventana de 30 días móviles, entra a Periodo de Prueba de Calidad: 30 días a $20.00 por hora (sin comisión) mientras acompaña a técnicos senior. Pase la prueba completando 30 días consecutivos sin quejas válidas de calidad para regresar a comisión. Falle la prueba de nuevo y el siguiente paso es terminación.",
        },
      },
      {
        type: "p",
        text: {
          en: "A valid quality complaint is defined in the Phes Policies and Procedures handbook (Section 2, Quality Probation subsection). In summary, a complaint is valid when the office documents it with specific identified quality issues, photographic or written client evidence where applicable, and a record of when the complaint was received. Complaints arising from circumstances outside the employee's control (office scheduling errors, client requests outside standard scope, items documented as exceeding the climbing rule or lifting limit) are not counted against the employee.",
          es: "Una queja válida de calidad está definida en el manual de Políticas y Procedimientos de Phes (Sección 2, subsección Periodo de Prueba de Calidad). En resumen, una queja es válida cuando la oficina la documenta con problemas específicos de calidad identificados, evidencia fotográfica o escrita del cliente cuando aplica, y un registro de cuándo se recibió la queja. Las quejas que surgen de circunstancias fuera del control del empleado (errores de programación de la oficina, solicitudes del cliente fuera del alcance estándar, artículos documentados como exceder la regla de escalar o el límite de levantamiento) no se cuentan en contra del empleado.",
        },
      },

      { type: "h", text: { en: "Mileage Reimbursement", es: "Reembolso de Millaje" } },
      {
        type: "p",
        text: {
          en: "Phes reimburses mileage between client homes (not your commute from home to first job, or last job to home). Submit mileage requests through the system; the office reviews and approves. The current rate is $0.725 per mile, set at or above the IRS standard mileage rate in effect at the time of travel.",
          es: "Phes reembolsa el millaje entre hogares de clientes (no su trayecto desde casa al primer trabajo, ni del último trabajo a casa). Envíe solicitudes de millaje a través del sistema; la oficina revisa y aprueba. La tarifa actual es $0.725 por milla, establecida igual o por encima de la tarifa estándar de millaje del IRS vigente al momento del viaje.",
        },
      },

      { type: "h", text: { en: "Payroll", es: "Nómina" } },
      {
        type: "bullets",
        items: [
          { en: "Pay cycle: weekly. The payroll workweek runs Sunday through Saturday. Each completed workweek is deposited the following Friday (so work done this Sunday through Saturday hits your account next Friday).", es: "Ciclo de pago: semanal. La semana de nómina va de domingo a sábado. Cada semana completa se deposita el viernes siguiente (el trabajo hecho de domingo a sábado se deposita el siguiente viernes)." },
          { en: "Direct deposit only. No paper checks.", es: "Solo depósito directo. Sin cheques de papel." },
          { en: "Tips paid through the booking system are deposited the same week as the work that earned them.", es: "Las propinas pagadas a través del sistema de reservas se depositan en la misma semana del trabajo que las generó." },
          { en: "Tips received through the booking system are reported on your W-2 and subject to standard payroll tax withholding (federal income tax, FICA, Medicare, and applicable state taxes). Cash tips are 100% yours to keep and are your responsibility to report to the IRS per Section 6053 tip reporting rules.", es: "Las propinas recibidas a través del sistema de reservas se reportan en su W-2 y están sujetas a la retención estándar de impuestos sobre la nómina (impuesto federal sobre la renta, FICA, Medicare y los impuestos estatales aplicables). Las propinas en efectivo son 100% suyas para quedárselas y es su responsabilidad reportarlas al IRS de acuerdo con las reglas de reporte de propinas de la Sección 6053." },
          { en: "Mileage is paid the week after the request is approved.", es: "El millaje se paga la semana siguiente a la aprobación de la solicitud." },
          { en: "Pay stubs are accessible through the ADP portal. W-2 forms are issued electronically through ADP by January 31 each year.", es: "Los recibos de pago están disponibles a través del portal de ADP. Los formularios W-2 se emiten electrónicamente a través de ADP antes del 31 de enero de cada año." },
        ],
      },

      { type: "h", text: { en: "Overtime", es: "Tiempo Extra" } },
      {
        type: "p",
        text: {
          en: "Phes pays overtime per federal and Illinois law when an employee works more than 40 hours in a single workweek. Phes defines the workweek as Sunday through Saturday. For commission-earning employees, overtime is calculated on the regular rate of pay, which under the Fair Labor Standards Act includes a weighted average of commission earnings and base rates across the workweek. The office handles the overtime calculation automatically through ADP. If you have questions about how a specific paycheck was calculated, contact the office.",
          es: "Phes paga tiempo extra de acuerdo con la ley federal y de Illinois cuando un empleado trabaja más de 40 horas en una sola semana laboral. Phes define la semana laboral de domingo a sábado. Para los empleados que ganan comisión, el tiempo extra se calcula sobre la tarifa regular de pago, la cual bajo la Ley de Normas Justas de Trabajo (Fair Labor Standards Act) incluye un promedio ponderado de las comisiones ganadas y las tarifas base a lo largo de la semana laboral. La oficina maneja el cálculo del tiempo extra automáticamente a través de ADP. Si tiene preguntas sobre cómo se calculó un cheque de pago específico, contacte a la oficina.",
        },
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
          { en: "9. Color-coded cloths — yellow for kitchens, white for bathrooms, green for glass and mirrors, blue for neutral or general dusting. Never cross-contaminate.", es: "9. Paños por color — amarillo para cocinas, blanco para baños, verde para vidrio y espejos, azul para neutral o polvo general. Nunca contamine cruzado." },
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
      en: "Your scheduled workday, assigned jobs, the one-clock-per-job workflow, GPS check-in, the 600-foot rule, mileage between jobs, and time-correction requests.",
      es: "Su jornada laboral programada, trabajos asignados, el flujo de un reloj por trabajo, Check In por GPS, la regla de 600 pies, millaje entre trabajos y solicitudes de corrección.",
    },
    estimatedMinutes: 10,
    blocks: [
      // ── Section 1: Your Workday at Phes ─────────────────────────────────
      { type: "h", text: { en: "Your Workday at Phes", es: "Su Jornada Laboral en Phes" } },
      {
        type: "p",
        text: {
          en: "Phes is a residential and commercial cleaning company. As a Phes technician, you work assigned jobs throughout your scheduled workday. Your scheduled workday consists of dispatched client jobs, which are assigned to you in advance and may be added throughout the day based on client demand.",
          es: "Phes es una empresa de limpieza residencial y comercial. Como técnico de Phes, usted realiza trabajos asignados durante toda su jornada laboral programada. Su jornada laboral programada se compone de trabajos de clientes despachados, los cuales se le asignan con anticipación y pueden agregarse durante el día según la demanda de los clientes.",
        },
      },
      {
        type: "p",
        text: {
          en: "Your scheduled workday runs from 9:00 AM to 6:00 PM on your scheduled workdays. During your workday, you complete assigned jobs that may include pre-scheduled jobs and same-day assignments added by the office.",
          es: "Su jornada laboral programada se desarrolla de 9:00 AM a 6:00 PM en sus días laborales programados. Durante su jornada, completa trabajos asignados que pueden incluir trabajos pre-programados y asignaciones del mismo día agregadas por la oficina.",
        },
      },
      {
        type: "p",
        text: {
          en: "You are paid commission on each completed job at the rates described in the Compensation module. Your commission is calculated based on each job's total value, not based on how long the job takes you. This means you can earn an effective hourly rate that increases with your efficiency. The current median effective hourly rate across the Phes team is approximately $25 per hour, well above the Illinois minimum wage of $15 per hour. The Phes compensation structure produces effective hourly rates that meet or exceed all applicable federal, Illinois state, and Chicago minimum wage requirements.",
          es: "Se le paga comisión sobre cada trabajo completado a las tarifas descritas en el módulo de Compensación. Su comisión se calcula con base en el valor total de cada trabajo, no con base en el tiempo que le toma. Esto significa que puede ganar una tarifa efectiva por hora que aumenta con su eficiencia. La tarifa efectiva mediana actual del equipo de Phes es aproximadamente $25 por hora, muy por encima del salario mínimo de Illinois de $15 por hora. La estructura de compensación de Phes produce tarifas efectivas por hora que cumplen o superan todos los requisitos de salario mínimo federal, estatal de Illinois y de la ciudad de Chicago aplicables.",
        },
      },

      // ── Section 2: How the Clock Works at Phes ─────────────────────────
      { type: "h", text: { en: "How the Clock Works at Phes", es: "Cómo Funciona el Reloj en Phes" } },
      {
        type: "p",
        text: {
          en: "Phes uses MaidCentral to record your time at each assigned job. At each job, you Clock In and Check In together at the same time when you arrive at the client's property. When the job is complete, you Clock Out and Check Out together at the same time.",
          es: "Phes usa MaidCentral para registrar su tiempo en cada trabajo asignado. En cada trabajo, hace Clock In y Check In juntos al mismo tiempo cuando llega a la propiedad del cliente. Cuando el trabajo está completo, hace Clock Out y Check Out juntos al mismo tiempo.",
        },
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "The required workflow at every job: Arrive at the assigned client property. Clock In and Check In together at the moment of arrival. Complete the job per the Worksheet and any client notes. Clock Out and Check Out together at the moment the job is complete. Travel to your next assigned job. Clock In and Check In together when you arrive. Repeat through your scheduled workday.",
          es: "El flujo requerido en cada trabajo: Llegue a la propiedad del cliente asignado. Haga Clock In y Check In juntos al momento de llegar. Complete el trabajo según la Hoja de Trabajo y las notas del cliente. Haga Clock Out y Check Out juntos al momento que el trabajo esté completo. Maneje al siguiente trabajo asignado. Haga Clock In y Check In juntos al llegar. Repita durante toda su jornada laboral programada.",
        },
      },
      {
        type: "p",
        text: {
          en: "You are paid for the time you are on the job, recorded through Clock In to Clock Out at each assigned job.",
          es: "Se le paga por el tiempo que está en el trabajo, registrado mediante Clock In a Clock Out en cada trabajo asignado.",
        },
      },

      // ── Section 3: The 600-Foot GPS Rule ───────────────────────────────
      { type: "h", text: { en: "The 600-Foot GPS Rule", es: "La Regla GPS de 600 Pies" } },
      {
        type: "p",
        text: {
          en: "MaidCentral verifies your physical location at Check In. You must be within 600 feet of the property to Check In successfully. If you try to Check In from your car parked two blocks away, the app will reject the check-in. Walk to the door first, then Check In.",
          es: "MaidCentral verifica su ubicación física al hacer Check In. Debe estar a 600 pies o menos de la propiedad para hacer Check In exitosamente. Si intenta hacer Check In desde su auto estacionado a dos cuadras, la aplicación rechazará el Check In. Camine hasta la puerta primero, luego haga Check In.",
        },
      },
      {
        type: "p",
        text: {
          en: "If GPS Check In fails repeatedly even though you are at the property, take a timestamped photo of the front door or address number, call the office immediately, and the office will manually approve your check-in. Do not skip the check-in. Do not estimate the time later. The office handles manual GPS overrides through the Clock/Job Change Request process.",
          es: "Si el Check In por GPS falla repetidamente aunque esté en la propiedad, tome una foto con marca de tiempo de la puerta principal o el número de dirección, llame a la oficina inmediatamente, y la oficina aprobará manualmente su check-in. No omita el check-in. No estime el tiempo después. La oficina maneja anulaciones manuales de GPS a través del proceso de Clock/Job Change Request.",
        },
      },

      // ── Section 4: Individual Per-Tech Check-In ────────────────────────
      { type: "h", text: { en: "Individual Per-Tech Check-In", es: "Check In Individual por Técnico" } },
      {
        type: "p",
        text: {
          en: "Every tech checks in individually, even when working as a team on a multi-tech job. If two techs arrive at 9:00 AM but one waits in the car until 9:20, MaidCentral records the actual check-in time for each tech. Commission split on multi-tech jobs is calculated by actual minutes on site for each individual.",
          es: "Cada técnico hace Check In individualmente, incluso cuando trabaja en equipo en un trabajo de varios técnicos. Si dos técnicos llegan a las 9:00 AM pero uno espera en el auto hasta las 9:20, MaidCentral registra el tiempo real de check-in para cada técnico. La división de comisión en trabajos de varios técnicos se calcula por los minutos reales en sitio de cada individuo.",
        },
      },

      // ── Section 5: Your Scheduled Workday and Job Assignments ──────────
      { type: "h", text: { en: "Your Scheduled Workday and Job Assignments", es: "Su Jornada Laboral Programada y Asignaciones de Trabajo" } },
      {
        type: "p",
        text: {
          en: "Your scheduled workday at Phes runs from 9:00 AM to 6:00 PM on your scheduled workdays. During this scheduled workday, you receive job assignments from the office. The office schedules your jobs in advance and may add additional jobs during your workday based on same-day client requests, route optimization, or other operational needs.",
          es: "Su jornada laboral programada en Phes se desarrolla de 9:00 AM a 6:00 PM en sus días laborales programados. Durante esta jornada laboral programada, recibe asignaciones de trabajo de la oficina. La oficina programa sus trabajos con anticipación y puede agregar trabajos adicionales durante su jornada según solicitudes de clientes del mismo día, optimización de rutas u otras necesidades operativas.",
        },
      },
      {
        type: "p",
        text: {
          en: "Your job assignments are communicated to you through MaidCentral and through direct contact from the office (text or call). Same-day job assignments are a regular and expected part of your scheduled workday, not a separate request for your time. Phes commission rates and the structure of the workday are designed to compensate you for completing assigned work efficiently.",
          es: "Sus asignaciones de trabajo se le comunican a través de MaidCentral y mediante contacto directo de la oficina (mensaje de texto o llamada). Las asignaciones de trabajo del mismo día son una parte regular y esperada de su jornada laboral programada, no una solicitud separada de su tiempo. Las tarifas de comisión de Phes y la estructura de la jornada están diseñadas para compensarle por completar el trabajo asignado de manera eficiente.",
        },
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Refusing an assigned job during your scheduled workday without a lawful or protected reason is treated as an unexcused absence on your attendance record. This is consistent with how unexcused absences are handled for missed scheduled shifts in any workplace. Five unexcused absences in a Benefit Year may result in termination, as described in the Phes Policies and Procedures handbook.",
          es: "Rechazar un trabajo asignado durante su jornada laboral programada sin una razón legal o protegida se trata como una ausencia injustificada en su registro de asistencia. Esto es consistente con cómo se manejan las ausencias injustificadas por turnos programados perdidos en cualquier lugar de trabajo. Cinco ausencias injustificadas en un Año de Beneficios pueden resultar en terminación, según se describe en el manual de Políticas y Procedimientos de Phes.",
        },
      },
      {
        type: "p",
        text: {
          en: "Lawful and protected reasons for declining a job assignment include but are not limited to: medical emergency, protected leave under Illinois law (PLAWA, FBLA, VESSA, jury duty, voting time, etc.), workplace safety concern at the assigned property, religious accommodation, disability accommodation, or other reason protected by federal, state, or local law. When you decline a job assignment for a lawful or protected reason, inform the office immediately so the office can reassign the work. Documentation may be requested only as required by the underlying protected category.",
          es: "Las razones legales y protegidas para declinar una asignación de trabajo incluyen pero no se limitan a: emergencia médica, licencia protegida bajo la ley de Illinois (PLAWA, FBLA, VESSA, deber de jurado, tiempo para votar, etc.), preocupación de seguridad laboral en la propiedad asignada, acomodación religiosa, acomodación por discapacidad, u otra razón protegida por la ley federal, estatal o local. Cuando declina una asignación de trabajo por una razón legal o protegida, informe a la oficina inmediatamente para que la oficina pueda reasignar el trabajo. Solo se puede solicitar documentación según lo requiera la categoría protegida correspondiente.",
        },
      },

      // ── Section 6: Activity Between Job Assignments ────────────────────
      { type: "h", text: { en: "Activity Between Job Assignments", es: "Actividad Entre Asignaciones de Trabajo" } },
      {
        type: "p",
        text: {
          en: "When you complete one job assignment and travel to your next assigned job, you are traveling between jobs. During this travel time, you should:",
          es: "Cuando completa una asignación de trabajo y maneja a su siguiente trabajo asignado, está viajando entre trabajos. Durante este tiempo de viaje, debe:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Travel directly to your next assigned job in a reasonable manner.", es: "Manejar directamente a su siguiente trabajo asignado de manera razonable." },
          { en: "Remain reachable by phone or text for office communications about your remaining assignments, schedule changes, or operational matters.", es: "Permanecer disponible por teléfono o mensaje de texto para comunicaciones de la oficina sobre sus asignaciones restantes, cambios de horario o asuntos operativos." },
          { en: "Use the time for personal needs (lunch, fuel, restroom, brief errands) as long as you arrive at your next assigned job on time.", es: "Usar el tiempo para necesidades personales (almuerzo, gasolina, baño, mandados breves) siempre que llegue a su siguiente trabajo asignado a tiempo." },
        ],
      },
      {
        type: "p",
        text: {
          en: "Phes does not require you to perform work tasks during travel between jobs. The expectation is only that you remain reachable by the office regarding your assigned work and arrive at your next assignment on time.",
          es: "Phes no le exige realizar tareas de trabajo durante el viaje entre trabajos. La expectativa es solo que permanezca disponible para la oficina respecto a su trabajo asignado y llegue a su siguiente asignación a tiempo.",
        },
      },

      // ── Section 7: Mileage Reimbursement Between Jobs ──────────────────
      { type: "h", text: { en: "Mileage Reimbursement Between Jobs", es: "Reembolso de Millaje Entre Trabajos" } },
      {
        type: "p",
        text: {
          en: "Phes reimburses mileage at $0.725 per mile (at or above the IRS standard mileage rate in effect at the time of travel) for driving between client homes on the same workday. The drive from your home to your first job of the day, and the drive from your last job back to your home, are not reimbursable, as those are considered ordinary commuting time. Mileage reimbursement is separate from wages and is paid through the standard mileage submission process. See the Compensation module for full mileage reimbursement details.",
          es: "Phes reembolsa el millaje a $0.725 por milla (al nivel o por encima de la tarifa estándar de millaje del IRS vigente al momento del viaje) por manejar entre hogares de clientes en el mismo día laboral. El manejo de su casa a su primer trabajo del día, y el manejo de su último trabajo de regreso a su casa, no son reembolsables, ya que se consideran tiempo de trayecto ordinario. El reembolso de millaje es separado del salario y se paga mediante el proceso estándar de presentación de millaje. Vea el módulo de Compensación para detalles completos del reembolso de millaje.",
        },
      },

      // ── Section 8: Clock/Job Change Requests ────────────────────────────
      { type: "h", text: { en: "Clock/Job Change Requests", es: "Solicitudes de Cambio de Reloj/Trabajo" } },
      {
        type: "p",
        text: {
          en: "If you forgot to Check Out, missed a Check In, or have any clock-time error, submit a Clock/Job Change Request through MaidCentral. The office reviews and approves the change. Do not text managers, do not DM the office, do not hope payroll figures it out. Only the system creates the audit trail that lands on your paycheck correctly.",
          es: "Si olvidó hacer Check Out, no hizo Check In, o tiene cualquier error de tiempo, envíe una Clock/Job Change Request en MaidCentral. La oficina revisa y aprueba el cambio. No envíe mensaje a los gerentes, no envíe DM a la oficina, no espere que la nómina lo resuelva. Solo el sistema crea el registro de auditoría que llega correctamente a su pago.",
        },
      },

      // ── Section 9: When Worksheet and Client Note Conflict ─────────────
      { type: "h", text: { en: "When Worksheet and Client Note Conflict", es: "Cuando la Hoja de Trabajo y la Nota del Cliente se Contradicen" } },
      {
        type: "p",
        text: {
          en: "The Worksheet shows the standard scope for the service type. Client notes may modify specific items (example: \"do not move the rug under the dining table\" or \"the cat is hiding in the laundry closet, do not open it\"). When a client note conflicts with the Worksheet on a specific item, follow the client note for that item. The rest of the Worksheet still applies normally. Never ask the client to choose between Worksheet items mid-clean. Read both the Worksheet and any client notes before you start.",
          es: "La Hoja de Trabajo muestra el alcance estándar para el tipo de servicio. Las notas del cliente pueden modificar elementos específicos (ejemplo: \"no mueva la alfombra debajo de la mesa del comedor\" o \"el gato está escondido en el armario de lavandería, no lo abra\"). Cuando una nota del cliente entra en conflicto con la Hoja de Trabajo en un elemento específico, siga la nota del cliente para ese elemento. El resto de la Hoja de Trabajo sigue aplicando normalmente. Nunca pida al cliente que elija entre elementos de la Hoja de Trabajo durante la limpieza. Lea tanto la Hoja de Trabajo como cualquier nota del cliente antes de comenzar.",
        },
      },

      // ── Section 10: If MaidCentral Goes Down ───────────────────────────
      { type: "h", text: { en: "If MaidCentral Goes Down", es: "Si MaidCentral Deja de Funcionar" } },
      {
        type: "p",
        text: {
          en: "If MaidCentral is unavailable (app down, server outage, your phone offline), document your arrival and departure times manually with a timestamped photo of your phone clock at the client's address. Call the office immediately to log a manual time entry. The office submits a Clock/Job Change Request retroactively when the system is restored.",
          es: "Si MaidCentral no está disponible (aplicación caída, falla del servidor, su teléfono sin conexión), documente manualmente sus tiempos de llegada y salida con una foto con marca de tiempo del reloj de su teléfono en la dirección del cliente. Llame a la oficina inmediatamente para registrar una entrada de tiempo manual. La oficina envía una Clock/Job Change Request retroactivamente cuando el sistema se restaura.",
        },
      },
      {
        type: "p",
        text: {
          en: "Keep your phone charged and your data plan active. Your phone is the primary tool for Check In, Check Out, photos, and client notes. If your phone dies mid-day, call the office immediately from a coworker's phone, a client's phone (with permission), or your car. The office logs a manual time entry until your phone is back online.",
          es: "Mantenga su teléfono cargado y su plan de datos activo. Su teléfono es la herramienta principal para Check In, Check Out, fotos y notas del cliente. Si su teléfono se descarga durante el día, llame a la oficina inmediatamente desde el teléfono de un compañero, el teléfono de un cliente (con permiso) o su auto. La oficina registra una entrada de tiempo manual hasta que su teléfono vuelva a estar en línea.",
        },
      },

      // ── Section 11: Coming Next: Qleno ─────────────────────────────────
      { type: "h", text: { en: "Coming Next: Qleno", es: "Próximamente: Qleno" } },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Phes is migrating from MaidCentral to Qleno over the next several months. Qleno is the company's own platform with the same one-clock-per-job model, same GPS check-in, same Worksheet review process, and a faster mobile app with offline support, simpler day view, and integrated quotes and invoices. You will be trained on Qleno before the cutover. Until then, MaidCentral is the system of record and the workflow described in this module applies.",
          es: "Phes está migrando de MaidCentral a Qleno en los próximos meses. Qleno es la plataforma propia de la compañía con el mismo modelo de un reloj por trabajo, el mismo Check In por GPS, el mismo proceso de revisión de Hoja de Trabajo, y una aplicación móvil más rápida con soporte sin conexión, vista de día más simple y cotizaciones y facturas integradas. Se le entrenará en Qleno antes del cambio. Hasta entonces, MaidCentral es el sistema oficial y el flujo descrito en este módulo aplica.",
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
          { en: "Use on: stainless steel sinks, porcelain tubs, ceramic toilets, glass cooktops, chrome (faucets, fixtures).", es: "Use en: fregaderos de acero, tinas de porcelana, inodoros de cerámica, estufas de vidrio, cromo (llaves, accesorios)." },
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
          { en: "Method: spray on the GREEN microfiber cloth (never directly on the mirror), wipe in S-pattern.", es: "Método: rocíe sobre el paño VERDE de microfibra (nunca directamente en el espejo), limpie en patrón de S." },
          { en: "Why green: dedicated glass cloth — no residue from kitchen or bathroom cleaners.", es: "Por qué verde: paño dedicado a vidrio — sin residuos de cocina o baño." },
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
          { en: "Cloth color: WHITE — bathroom-only. Never use a white bathroom cloth in a kitchen.", es: "Color de paño: BLANCO — solo baño. Nunca use un paño blanco de baño en cocina." },
        ],
      },

      // Lysol Disinfecting Wipes section removed 2026-05-20 per Sal — not in current kit.

      { type: "h", text: { en: "Weiman's Stainless Steel Cleaner & Polish", es: "Limpiador y Pulidor de Acero Inoxidable Weiman's" } },
      {
        type: "bullets",
        items: [
          { en: "Use on: appliance fronts (refrigerator, dishwasher, range hood, microwave exterior).", es: "Use en: frentes de electrodomésticos (refrigerador, lavavajillas, campana, exterior del microondas)." },
          { en: "Method: small amount on the cloth (NEVER on the appliance directly), wipe in the direction of the grain. Buff with a clean dry side of the cloth.", es: "Método: poca cantidad en el paño (NUNCA directamente en el electrodoméstico), limpie en la dirección del grano. Pula con el lado seco y limpio del paño." },
          { en: "Cloth: use a clean blue (neutral) or yellow (kitchen) cloth with zero prior residue. A residue from glass spray or bathroom cleaner will streak the stainless.", es: "Paño: use un paño azul (neutral) o amarillo (cocina) limpio sin residuos previos. Un residuo de spray de vidrio o limpiador de baño dejará marcas en el acero." },
          { en: "No jewelry: remove rings, bracelets, watches before polishing — they scratch.", es: "Sin joyería: quítese anillos, pulseras y relojes antes de pulir — rayan la superficie." },
        ],
      },

      { type: "h", text: { en: "Microfiber Cloths — Color Code", es: "Paños de Microfibra — Código de Color" } },
      {
        type: "p",
        text: {
          en: "Why these specific colors: we previously used heavily-dyed colored cloths (red, dark green) and the dye bled into white grout during bathroom cleans. The current code uses light or neutral colors that don't bleed. Never substitute a darker-dye cloth, especially around grout.",
          es: "Por qué estos colores específicos: anteriormente usábamos paños de colores intensos (rojo, verde oscuro) y la tintura sangraba en la lechada blanca durante limpiezas de baños. El código actual usa colores claros o neutros que no sangran. Nunca sustituya por un paño con tintura más oscura, especialmente cerca de lechada.",
        },
      },
      {
        type: "table",
        head: { en: ["Color", "Surface", "Why"], es: ["Color", "Superficie", "Por qué"] },
        rows: [
          { en: ["Yellow", "Kitchen (counters, appliances)", "Dedicated kitchen — keeps cross-contamination from bathrooms out"], es: ["Amarillo", "Cocina (mostradores, electrodomésticos)", "Dedicado a cocina — evita contaminación cruzada desde baños"] },
          { en: ["White", "Bathrooms (toilets, tubs, sinks)", "Bathroom-only — never cross to kitchen. Light color shows soiling so it gets retired quickly"], es: ["Blanco", "Baños (inodoros, tinas, lavabos)", "Solo baño — nunca pasa a cocina. El color claro muestra suciedad rápidamente para retirarlo a tiempo"] },
          { en: ["Green", "Glass, mirrors, special materials", "No residue from soap or grease; dedicated streak-free duty"], es: ["Verde", "Vidrio, espejos, materiales especiales", "Sin residuos de jabón o grasa; dedicado para acabado sin marcas"] },
          { en: ["Blue", "Neutral / general dusting", "Neutral cloth for general dusting and surfaces not covered by the dedicated colors above"], es: ["Azul", "Neutral / polvo general", "Paño neutral para polvo general y superficies no cubiertas por los colores dedicados arriba"] },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Cleaning fridges and stone counters: no jewelry on (rings, bracelets, watches) — they scratch the surface and trap food/grime. Also confirm the microfiber rag has no residue from a prior surface before it touches the fridge or stone. A trace of bathroom cleaner or glass spray on a rag will leave a streak or, on stone, etch over time.",
          es: "Limpieza de refrigeradores y mostradores de piedra: sin joyería (anillos, pulseras, relojes) — rayan la superficie y atrapan comida/suciedad. También confirme que el paño de microfibra no tenga residuos de una superficie anterior antes de tocar el refrigerador o la piedra. Un rastro de limpiador de baño o atomizador de vidrio en un paño dejará una marca o, en piedra, dañará con el tiempo.",
        },
      },

      { type: "h", text: { en: "Vacuum — Atrix Ergo PMP Backpack Vacuum (2 Gallon, HEPA)", es: "Aspiradora — Atrix Ergo PMP de Mochila (2 Galones, HEPA)" } },
      {
        type: "bullets",
        items: [
          { en: "Corded backpack vacuum, 1400W, 4-stage HEPA filtration (8 qt HEPA bag, cloth shakeout bag, premotor filter, exhaust filter). 50 ft cord; harness adjusts left or right-handed.", es: "Aspiradora de mochila con cable, 1400W, filtración HEPA de 4 etapas (bolsa HEPA de 8 qt, bolsa de sacudida, filtro premotor, filtro de escape). Cable de 50 pies; arnés ajustable a izquierda o derecha." },
          { en: "Use BEFORE you mop — never mop dust; you'll smear it.", es: "Use ANTES de trapear — nunca trapee polvo; se esparcirá." },
          { en: "Empty the HEPA bag between homes if visibly full — a full bag loses suction and stresses the motor.", es: "Vacíe la bolsa HEPA entre hogares si está visiblemente llena — una bolsa llena pierde succión y fuerza al motor." },
          { en: "Choose the right tool from the kit (floor brush, oval dust brush, crevice tool, extension wand) for the surface — wrong tool damages floor finish or upholstery.", es: "Elija la herramienta correcta del kit (cepillo de piso, cepillo ovalado, herramienta de hendiduras, varilla de extensión) según la superficie — la herramienta equivocada daña el acabado del piso o la tapicería." },
          { en: "Check the cord for damage before each use. Use the strain-relief plug on extensions; do not yank the cord from across the room.", es: "Inspeccione el cable por daños antes de cada uso. Use el enchufe con alivio de tensión en extensiones; no jale el cable desde lejos." },
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
          en: "NEVER on chrome — even #0000 dulls a chrome finish on first pass. Never on stainless steel appliance fronts (use Weiman's Stainless Steel Cleaner & Polish instead). Never on coated cookware, glass shower-door film coatings, or polished marble. Always rinse thoroughly afterward — steel wool fibers left on a surface rust within hours and will stain.",
          es: "NUNCA en cromo — incluso #0000 daña el acabado cromado al primer pase. Nunca en frentes de electrodomésticos de acero (use el Limpiador y Pulidor de Acero Inoxidable Weiman's). Nunca en utensilios con recubrimiento, recubrimientos de puertas de ducha, o mármol pulido. Siempre enjuague completamente — fibras de lana de acero dejadas en una superficie se oxidan en horas y mancharán.",
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
        tone: "info",
        text: {
          en: "THE THREE POINTS to memorize: FEET (rubber, not worn) · HINGES (locked open, no wobble) · PLATFORM (clean and dry). Weight rating, height, and manufacture date are NOT the Phes pre-use check — those are factory specs printed on the label that do not change between uses.",
          es: "LOS TRES PUNTOS para memorizar: PATAS (de goma, no lisas) · BISAGRAS (abiertas, sin movimiento) · PLATAFORMA (limpia y seca). El peso máximo, altura y fecha de fabricación NO son la revisión previa de Phes — esos son datos de fábrica en la etiqueta que no cambian entre usos.",
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

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. NON-SOLICITATION AGREEMENT (Phase 6, PR #7)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // CO-SIGNED agreement. The signed instrument lives in lms_signed_documents
  // at document_type 'non_solicitation' and is co-signed by the Phes
  // representative (tenant owner by default).
  //
  // Governed by the Illinois Freedom to Work Act (820 ILCS 90). Under IL law,
  // a non-solicit covenant is enforceable only when it is:
  //   1. Supported by adequate CONSIDERATION (continued employment of 2+
  //      years, or other consideration explicitly stated).
  //   2. REASONABLE in scope, duration, and geography.
  //   3. NECESSARY to protect a LEGITIMATE BUSINESS INTEREST (Phes client
  //      relationships, not the general labor market).
  // Phes intentionally narrows the agreement: 12 months, CLIENTS only
  // (not coworkers), and inbound-contact carve-out. This is intentionally
  // conservative because IL courts blue-pencil aggressively.
  //
  // Spanish version is one of the FOUR FLAGGED docs requiring professional
  // translator review. The Spanish UI will show a banner warning that the
  // English version is binding until human translation is approved.
  {
    id: "non-solicitation",
    number: 10,
    iconKind: "shield",
    title: {
      en: "Non-Solicitation Agreement",
      es: "Acuerdo de No Solicitación",
    },
    subtitle: {
      en: "What you may not do with Phes clients during your employment and for 12 months after you leave. You may freely solicit coworkers and the general public.",
      es: "Lo que no puede hacer con los clientes de Phes durante su empleo y por 12 meses después de irse. Puede solicitar libremente a compañeros y al público general.",
    },
    estimatedMinutes: 12,
    blocks: [
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Why this module matters. Phes spends years building relationships with its clients. The client list is the most valuable asset of the business. The Non-Solicitation Agreement protects those relationships from being taken away after an employee leaves. It does NOT restrict your ability to look for other work, to recruit coworkers to a new opportunity, or to advertise services to the general public. It is narrowly aimed at Phes CLIENTS only.",
          es: "Por qué importa este módulo. Phes pasa años construyendo relaciones con sus clientes. La lista de clientes es el activo más valioso del negocio. El Acuerdo de No Solicitación protege esas relaciones de ser arrebatadas después de que un empleado se va. NO restringe su habilidad de buscar otro trabajo, de reclutar compañeros para una nueva oportunidad, ni de anunciar servicios al público general. Apunta de forma estrecha solo a los CLIENTES de Phes.",
        },
      },

      { type: "h", text: { en: "What the Agreement Restricts (Clients Only)", es: "Lo Que el Acuerdo Restringe (Solo Clientes)" } },
      {
        type: "p",
        text: {
          en: "The agreement says that during your employment and for 12 months after your last day with Phes, you will NOT directly or indirectly solicit Phes clients for cleaning services (whether for yourself, for a future employer, or for any other business). Phes CLIENTS means any household or business that has used Phes services in the 24 months before you left.",
          es: "El acuerdo dice que durante su empleo y por 12 meses después de su último día con Phes, NO solicitará directa o indirectamente a clientes de Phes para servicios de limpieza (ya sea para usted, para un empleador futuro o para cualquier otro negocio). CLIENTES de Phes significa cualquier hogar o negocio que haya usado servicios de Phes en los 24 meses anteriores a su salida.",
        },
      },

      { type: "h", text: { en: "What the Agreement Does NOT Restrict", es: "Lo Que el Acuerdo NO Restringe" } },
      {
        type: "bullets",
        items: [
          { en: "Working for another cleaning company in the Chicagoland area. The agreement is not a non-compete; you may take another job in cleaning at any time.", es: "Trabajar para otra empresa de limpieza en el área de Chicago. El acuerdo no es un acuerdo de no competencia; puede tomar otro trabajo en limpieza en cualquier momento." },
          { en: "Recruiting Phes coworkers to join you at a new employer. Phes does not restrict coworker solicitation. The Illinois Freedom to Work Act discourages coworker non-solicits for hourly workers, and Phes does not include one.", es: "Reclutar a compañeros de Phes para que se unan a usted en un nuevo empleador. Phes no restringe la solicitación de compañeros. La Ley de Libertad para Trabajar de Illinois desalienta los acuerdos de no solicitación de compañeros para trabajadores por hora, y Phes no incluye uno." },
          { en: "General advertising. Posting on Craigslist, putting flyers on a neighborhood bulletin board, running a Facebook page that targets the public at large. None of that is solicitation under this agreement, even if a Phes client happens to see it.", es: "Publicidad general. Publicar en Craigslist, poner volantes en un tablero de anuncios del vecindario, manejar una página de Facebook dirigida al público en general. Nada de eso es solicitación bajo este acuerdo, aunque un cliente de Phes la vea por casualidad." },
          { en: "Accepting INBOUND contact from a former Phes client who finds you on their own. If a client contacts you first, without you having approached them, you may discuss work with them. You may not have done anything to invite or trigger the contact.", es: "Aceptar contacto INICIADO POR EL CLIENTE de un antiguo cliente de Phes que lo encuentre por su cuenta. Si un cliente lo contacta primero, sin que usted lo haya buscado, puede discutir el trabajo con él. No debe haber hecho nada para invitar o provocar el contacto." },
        ],
      },

      { type: "h", text: { en: "What Counts as Solicitation", es: "Lo Que Cuenta Como Solicitación" } },
      {
        type: "p",
        text: {
          en: "Solicitation means YOU reaching out to a Phes client. Specifically:",
          es: "Solicitación significa que USTED se acerque a un cliente de Phes. Específicamente:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Calling, texting, emailing, DMing, or mailing a Phes client to offer them cleaning services.", es: "Llamar, enviar mensaje de texto, correo electrónico, mensaje directo o correo postal a un cliente de Phes para ofrecerle servicios de limpieza." },
          { en: "Knocking on the door of a Phes client to offer them cleaning services.", es: "Tocar la puerta de un cliente de Phes para ofrecerle servicios de limpieza." },
          { en: "Asking a current Phes coworker to pass along a flyer or business card to a Phes client.", es: "Pedirle a un compañero actual de Phes que pase un volante o tarjeta de presentación a un cliente de Phes." },
          { en: "Posting a service offer to a private channel (a neighborhood Facebook group, a WhatsApp group, a Slack workspace) that you joined because you knew Phes clients use it.", es: "Publicar una oferta de servicio en un canal privado (un grupo de Facebook del vecindario, un grupo de WhatsApp, un espacio de Slack) al que se unió porque sabía que clientes de Phes lo usan." },
        ],
      },

      { type: "h", text: { en: "Duration: 12 Months", es: "Duración: 12 Meses" } },
      {
        type: "p",
        text: {
          en: "The restriction runs for TWELVE months from your last day at Phes. After 12 months you may solicit anyone, including former Phes clients, without restriction under this agreement.",
          es: "La restricción dura DOCE meses a partir de su último día en Phes. Después de 12 meses puede solicitar a cualquiera, incluidos antiguos clientes de Phes, sin restricción bajo este acuerdo.",
        },
      },

      { type: "h", text: { en: "Illinois Freedom to Work Act (820 ILCS 90)", es: "Ley de Libertad para Trabajar de Illinois (820 ILCS 90)" } },
      {
        type: "p",
        text: {
          en: "Illinois law is friendlier to workers than many other states. Under the Illinois Freedom to Work Act (820 ILCS 90), a non-solicitation covenant is enforceable only when it is REASONABLE in scope, supported by adequate CONSIDERATION (something of value given in exchange for the promise), and NECESSARY to protect a LEGITIMATE business interest. Phes intentionally narrows the agreement to 12 months, to clients only, with the inbound-contact carve-out, so it stays well within what Illinois courts have found reasonable for an hourly cleaning workforce.",
          es: "La ley de Illinois es más amigable con los trabajadores que muchos otros estados. Bajo la Ley de Libertad para Trabajar de Illinois (820 ILCS 90), un acuerdo de no solicitación es exigible solo cuando es RAZONABLE en alcance, está apoyado por una CONSIDERACIÓN adecuada (algo de valor dado a cambio de la promesa) y es NECESARIO para proteger un interés comercial LEGÍTIMO. Phes restringe el acuerdo intencionalmente a 12 meses, solo a clientes, con la exclusión de contacto iniciado por el cliente, para que se mantenga claramente dentro de lo que los tribunales de Illinois han encontrado razonable para una fuerza laboral de limpieza por hora.",
        },
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Consideration for this agreement: Phes provides paid training, regular scheduled shifts, paid time off, holiday pay, and the other benefits described in the Compensation module. Continued employment past 2 years is also recognized as consideration under Illinois law.",
          es: "Consideración por este acuerdo: Phes provee capacitación pagada, turnos programados regulares, tiempo libre pagado, pago por feriados y los demás beneficios descritos en el módulo de Compensación. El empleo continuo por más de 2 años también se reconoce como consideración bajo la ley de Illinois.",
        },
      },

      { type: "h", text: { en: "Phes Representative Co-Signature", es: "Co-Firma del Representante de Phes" } },
      {
        type: "p",
        text: {
          en: "Like the Video & Photo Release, the Non-Solicitation Agreement is a two-way commitment: you agree to the restriction; Phes commits to the consideration described above. The signed instrument is CO-SIGNED by the Phes representative (by default the owner). The co-signature appears on the final PDF after you sign. You do not need to be present.",
          es: "Como la Autorización de Video y Foto, el Acuerdo de No Solicitación es un compromiso de dos vías: usted acepta la restricción; Phes se compromete con la consideración descrita arriba. El instrumento firmado es CO-FIRMADO por el representante de Phes (por defecto el dueño). La co-firma aparece en el PDF final después de que usted firme. No necesita estar presente.",
        },
      },

      { type: "h", text: { en: "If You Violate the Agreement", es: "Si Viola el Acuerdo" } },
      {
        type: "p",
        text: {
          en: "If Phes believes you are soliciting Phes clients in violation of the agreement, Phes may seek INJUNCTIVE RELIEF (a court order requiring you to stop) and recover documented damages plus reasonable attorney fees, as permitted by Illinois law. Phes does NOT impose liquidated damages or penalty clauses, because IL courts disfavor them in employee non-solicits.",
          es: "Si Phes cree que está solicitando clientes de Phes en violación del acuerdo, Phes puede buscar ALIVIO POR ORDEN JUDICIAL (una orden de la corte que le exija detenerse) y recuperar daños documentados más honorarios razonables de abogado, según lo permita la ley de Illinois. Phes NO impone daños liquidados ni cláusulas de penalización, porque los tribunales de IL no las favorecen en acuerdos de no solicitación con empleados.",
        },
      },

      { type: "h", text: { en: "No Direct Payments From Clients", es: "Sin Pagos Directos de Clientes" } },
      {
        type: "p",
        text: {
          en: "While you are employed at Phes, you will not accept payment, supply reimbursements, or any other monetary or in-kind compensation directly from a Phes client for cleaning work that should be billed through Phes. Customary cash tips offered by a client are not direct payments; record the tip on the Worksheet as described in the Phes Employee Handbook.",
          es: "Mientras esté empleado en Phes, no aceptará pago, reembolsos de suministros ni ninguna otra compensación monetaria o en especie directamente de un cliente de Phes por trabajo de limpieza que deba facturarse a través de Phes. Las propinas en efectivo de costumbre que un cliente ofrezca no son pagos directos; registre la propina en la Hoja de Trabajo como se describe en el Manual del Empleado de Phes.",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "If a client tries to pay you directly for the scheduled Phes job, decline and explain that all work is billed through the office.", es: "Si un cliente intenta pagarle directamente por el trabajo programado de Phes, rechácelo y explíquele que todo el trabajo se factura a través de la oficina." },
          { en: "If a client asks for additional services outside the scheduled job, refer them to the office. The office books and bills the extra work through Phes.", es: "Si un cliente pide servicios adicionales fuera del trabajo programado, refiéralo a la oficina. La oficina reserva y factura el trabajo adicional a través de Phes." },
          { en: "Accepting a direct payment is a separate violation: it breaks both the conflict-of-interest rule in the Code of Conduct and the Non-Solicitation Agreement.", es: "Aceptar un pago directo es una violación separada: rompe tanto la regla de conflicto de interés del Código de Conducta como el Acuerdo de No Solicitación." },
        ],
      },

      { type: "h", text: { en: "Confidential Trade Secrets (Indefinite)", es: "Secretos Comerciales Confidenciales (Indefinido)" } },
      {
        type: "p",
        text: {
          en: "Some Phes information you learn on the job is a TRADE SECRET. The agreement asks you not to disclose, use, or transmit that information to anyone outside Phes, both during your employment and indefinitely after you leave. This obligation is governed by the Illinois Trade Secrets Act (765 ILCS 1065) and is scoped narrowly to information that meets that statute's definition of a trade secret. Examples:",
          es: "Parte de la información de Phes que aprende en el trabajo es un SECRETO COMERCIAL. El acuerdo le pide no divulgar, usar ni transmitir esa información a nadie fuera de Phes, tanto durante su empleo como indefinidamente después de irse. Esta obligación se rige por la Ley de Secretos Comerciales de Illinois (765 ILCS 1065) y tiene un alcance estrecho a la información que cumple la definición de secreto comercial bajo esa ley. Ejemplos:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "The Phes client list and any associated client contact information.", es: "La lista de clientes de Phes y cualquier información de contacto del cliente asociada." },
          { en: "Phes pricing structures, pricing rules, and quote formulas.", es: "Las estructuras de precios, reglas de precios y fórmulas de cotización de Phes." },
          { en: "Internal cleaning procedures, checklists, and quality-control practices documented as proprietary.", es: "Procedimientos internos de limpieza, listas de verificación y prácticas de control de calidad documentadas como propietarias." },
          { en: "Vendor and supplier relationships and the pricing terms negotiated with vendors.", es: "Las relaciones con proveedores y los términos de precios negociados con ellos." },
          { en: "Route information and internal operational schedules.", es: "Información de rutas y horarios operativos internos." },
          { en: "The Qleno platform's non-public features, internal business strategy, and financial projections disclosed to you because of your job.", es: "Las funciones no públicas de la plataforma Qleno, la estrategia comercial interna y las proyecciones financieras que se le hayan divulgado por su trabajo." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Importantly: this confidentiality obligation does NOT restrict your general knowledge, skill, or experience acquired during your employment, and it does NOT restrict your federally protected Section 7 right under the National Labor Relations Act to discuss your own pay, hours, schedule, or working conditions. It is narrowly aimed at Phes trade secrets, not at general experience or protected concerted activity.",
          es: "Importante: esta obligación de confidencialidad NO restringe su conocimiento general, habilidad o experiencia adquiridos durante su empleo, y NO restringe su derecho federalmente protegido bajo la Sección 7 de la Ley Nacional de Relaciones Laborales a discutir su propio pago, horas, horario o condiciones laborales. Apunta de forma estrecha a los secretos comerciales de Phes, no a la experiencia general ni a la actividad concertada protegida.",
        },
      },

      { type: "h", text: { en: "Express Reasonableness Acknowledgment", es: "Reconocimiento Expreso de Razonabilidad" } },
      {
        type: "p",
        text: {
          en: "By signing the agreement, you expressly acknowledge that the twelve-month duration, the clients-only scope, the inbound-contact carve-out, and the absence of any geographic territory restriction together make the agreement reasonable and necessary to protect Phes's legitimate business interests in client relationships and confidential information, and that the consideration Phes provides (paid training, scheduled shifts, paid time off, holiday pay, and the benefits described in the Compensation module) is adequate.",
          es: "Al firmar el acuerdo, usted reconoce expresamente que la duración de doce meses, el alcance limitado a clientes, la exclusión de contacto iniciado por el cliente y la ausencia de cualquier restricción de territorio geográfico hacen, en conjunto, que el acuerdo sea razonable y necesario para proteger los intereses comerciales legítimos de Phes en las relaciones con los clientes y en la información confidencial, y que la consideración que Phes provee (capacitación pagada, turnos programados, tiempo libre pagado, pago por feriados y los beneficios descritos en el módulo de Compensación) es adecuada.",
        },
      },

      {
        type: "callout",
        tone: "info",
        text: {
          en: "After this quiz: you will sign a separate Non-Solicitation Agreement that records the commitment. The agreement is co-signed by the Phes representative. You can re-download the signed PDF anytime from your training page. If you have questions about whether a specific situation would count as solicitation, ask the office before you act, not after.",
          es: "Después de este examen: firmará un Acuerdo de No Solicitación por separado que registra el compromiso. El acuerdo es co-firmado por el representante de Phes. Puede volver a descargar el PDF firmado en cualquier momento desde su página de capacitación. Si tiene preguntas sobre si una situación específica contaría como solicitación, pregunte a la oficina antes de actuar, no después.",
        },
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. SOCIAL MEDIA POLICY (Phase 7, PR #8)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // One-sided employee acknowledgment (NOT co-signed). Designed to be
  // enforceable under federal labor law: NLRA Section 7 (29 U.S.C. 157)
  // protects the right of employees to discuss wages, working conditions,
  // and organizing concerns with coworkers and in public. A social-media
  // policy that chills protected concerted activity is unlawful even at a
  // non-union shop. The Phes policy carves Section 7 activity OUT
  // explicitly so the rest of the policy stays enforceable.
  //
  // Also preserves the IL Right to Privacy in the Workplace Act
  // (820 ILCS 55) protection for off-duty private social media.
  //
  // Restrictions target three things:
  //   1. Client confidentiality (no client home photos, no identifying
  //      details, no overheard conversation transcripts).
  //   2. In-uniform misrepresentation (no posting in Phes uniform doing
  //      illegal / impaired / inappropriate things that imply Phes
  //      endorsement).
  //   3. Phes-client solicitation via social media (cross-refs the
  //      Non-Solicitation Agreement; same scope, same carve-outs).
  {
    id: "social-media",
    number: 11,
    iconKind: "shield",
    title: {
      en: "Social Media Policy",
      es: "Política de Redes Sociales",
    },
    subtitle: {
      en: "What you can and cannot post about Phes, our clients, and yourself in Phes uniform. Your right to discuss pay and working conditions is fully preserved.",
      es: "Lo que puede y no puede publicar sobre Phes, nuestros clientes y usted mismo en uniforme de Phes. Su derecho a discutir el pago y las condiciones laborales se preserva por completo.",
    },
    estimatedMinutes: 10,
    blocks: [
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Why this module matters. Social media is part of how every Phes employee lives now. The policy is intentionally narrow. It does NOT police your personal accounts and does NOT restrict your right to talk about pay, working conditions, or organizing concerns. It DOES restrict three things: (1) sharing client information that you got because of your Phes job, (2) representing yourself in Phes uniform doing something illegal or impaired, and (3) using social media to solicit Phes clients (which is also covered by the Non-Solicitation Agreement). Read the carve-outs carefully so you know what is protected.",
          es: "Por qué importa este módulo. Las redes sociales son parte de cómo vive todo empleado de Phes hoy. La política es intencionalmente estrecha. NO vigila sus cuentas personales y NO restringe su derecho a hablar sobre el pago, las condiciones laborales o las preocupaciones de organización. SÍ restringe tres cosas: (1) compartir información del cliente que obtuvo por su trabajo en Phes, (2) presentarse en uniforme de Phes haciendo algo ilegal o intoxicado, y (3) usar redes sociales para solicitar a clientes de Phes (lo que también está cubierto por el Acuerdo de No Solicitación). Lea las exclusiones con cuidado para que sepa lo que está protegido.",
        },
      },

      { type: "h", text: { en: "What You May NOT Post About Clients", es: "Lo Que NO Puede Publicar Sobre Clientes" } },
      {
        type: "bullets",
        items: [
          { en: "Photos or video of any client home, taken during a Phes shift or based on what you saw on a Phes shift. This applies even if the client is not in the photo and even if you think the location cannot be identified.", es: "Fotos o video del hogar de cualquier cliente, tomados durante un turno de Phes o basados en lo que vio en un turno de Phes. Aplica aunque el cliente no esté en la foto y aunque crea que la ubicación no se puede identificar." },
          { en: "Client names, addresses, neighborhoods, building names, gate codes, alarm codes, or any other identifying detail.", es: "Nombres, direcciones, vecindarios, nombres de edificios, códigos de portón, códigos de alarma o cualquier otro detalle identificador del cliente." },
          { en: "Transcripts or paraphrased versions of conversations you overheard inside a client home.", es: "Transcripciones o versiones parafraseadas de conversaciones que escuchó dentro del hogar de un cliente." },
          { en: "Photos of medical equipment, prescription bottles, custody documents, or anything visibly private that you saw on the job.", es: "Fotos de equipo médico, frascos de medicamentos recetados, documentos de custodia o cualquier cosa visiblemente privada que vio en el trabajo." },
          { en: "Disparaging comments about a specific client, even with the name removed, where the client could reasonably figure out you meant them.", es: "Comentarios despectivos sobre un cliente específico, incluso con el nombre removido, donde el cliente razonablemente pudiera darse cuenta de que se refería a él." },
        ],
      },

      { type: "h", text: { en: "Personal Accounts vs Official Phes Channels", es: "Cuentas Personales vs Canales Oficiales de Phes" } },
      {
        type: "p",
        text: {
          en: "This Social Media Policy governs what YOU post on your PERSONAL accounts (your Instagram, your TikTok, your Facebook). It does NOT govern what Phes posts on its OFFICIAL channels (the Phes-operated Instagram, the Phes website, recruiting graphics, training materials). Phes's own posts of client homes or employee likeness are governed by the Video and Photo Release that each photographed employee signs, not by this policy. If you see Phes posting a recruiting graphic that includes a client kitchen, that is permitted under the signed release — it is not a violation of this Social Media Policy, which applies only to employee personal accounts.",
          es: "Esta Política de Redes Sociales rige lo que USTED publica en sus cuentas PERSONALES (su Instagram, su TikTok, su Facebook). NO rige lo que Phes publica en sus canales OFICIALES (el Instagram operado por Phes, el sitio web de Phes, gráficos de reclutamiento, materiales de capacitación). Las publicaciones de Phes con hogares de clientes o la semejanza de empleados se rigen por la Autorización de Video y Foto que firma cada empleado fotografiado, no por esta política. Si ve a Phes publicando un gráfico de reclutamiento que incluya la cocina de un cliente, eso está permitido bajo la autorización firmada — no es una violación de esta Política de Redes Sociales, la cual aplica solo a las cuentas personales de los empleados.",
        },
      },

      { type: "h", text: { en: "What You May NOT Do in Phes Uniform", es: "Lo Que NO Puede Hacer en Uniforme de Phes" } },
      {
        type: "p",
        text: {
          en: "When you appear in a Phes uniform (shirt, branded apron, etc.) in a public-facing photo or video, you are visibly representing Phes. The policy restricts what you do in that visible representation:",
          es: "Cuando aparece en uniforme de Phes (camisa, delantal con marca, etc.) en una foto o video público, está representando visiblemente a Phes. La política restringe lo que hace en esa representación visible:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Posing with alcohol, cannabis, or illegal drugs while in Phes uniform.", es: "Posar con alcohol, cannabis o drogas ilegales mientras está en uniforme de Phes." },
          { en: "Posing with firearms or other weapons while in Phes uniform.", es: "Posar con armas de fuego u otras armas mientras está en uniforme de Phes." },
          { en: "Posing while impaired (the photo shows observable signs of impairment) while in Phes uniform.", es: "Posar mientras está intoxicado (la foto muestra signos observables de intoxicación) mientras está en uniforme de Phes." },
          { en: "Endorsing a product, service, candidate, or organization in a way that implies Phes is endorsing it.", es: "Apoyar un producto, servicio, candidato u organización de manera que implique que Phes lo está apoyando." },
          { en: "Posting content that disparages Phes coworkers, supervisors, or clients while in Phes uniform.", es: "Publicar contenido que desprestigie a compañeros de Phes, supervisores o clientes mientras está en uniforme de Phes." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Out of uniform on your own time, what you do is your business. The restriction is about the visible association with Phes, not about your private life.",
          es: "Fuera del uniforme en su propio tiempo, lo que hace es asunto suyo. La restricción es sobre la asociación visible con Phes, no sobre su vida privada.",
        },
      },

      { type: "h", text: { en: "Client Solicitation Through Social Media", es: "Solicitación de Clientes a Través de Redes Sociales" } },
      {
        type: "p",
        text: {
          en: "Using social media to solicit Phes clients for cleaning services is restricted by the Non-Solicitation Agreement (separate module) and is therefore also restricted by this policy. The same carve-outs apply:",
          es: "Usar redes sociales para solicitar a clientes de Phes para servicios de limpieza está restringido por el Acuerdo de No Solicitación (módulo separado) y por lo tanto también está restringido por esta política. Aplican las mismas exclusiones:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "General advertising to the public at large is OK, even if a Phes client happens to see it.", es: "La publicidad general al público en general está bien, aunque un cliente de Phes la vea por casualidad." },
          { en: "Inbound contact from a Phes client who found you on their own is OK to engage with.", es: "El contacto iniciado por el cliente de un cliente de Phes que lo encontró por su cuenta está bien para interactuar." },
          { en: "DMing or commenting on a specific Phes client's account to offer cleaning is NOT OK.", es: "Enviar un DM o comentar en la cuenta de un cliente específico de Phes para ofrecer limpieza NO está bien." },
        ],
      },

      { type: "h", text: { en: "Federal NLRA Section 7 Protection (Critical)", es: "Protección Federal de la Sección 7 de la NLRA (Crítico)" } },
      {
        type: "callout",
        tone: "success",
        text: {
          en: "Nothing in this policy restricts your federally protected right under Section 7 of the National Labor Relations Act (29 U.S.C. 157) to discuss your pay, hours, schedule, working conditions, safety concerns, or organizing activity with coworkers or in public. You may post about how much Phes pays you. You may post about a workplace concern. You may engage in concerted activity with coworkers about terms and conditions of employment. The policy ABOVE does not apply to any of this and Phes will not discipline an employee for protected concerted activity.",
          es: "Nada en esta política restringe su derecho federalmente protegido bajo la Sección 7 de la Ley Nacional de Relaciones Laborales (29 U.S.C. 157) para discutir su pago, horas, horario, condiciones laborales, preocupaciones de seguridad o actividad de organización con compañeros o en público. Puede publicar sobre cuánto le paga Phes. Puede publicar sobre una preocupación laboral. Puede participar en actividad concertada con compañeros sobre términos y condiciones de empleo. La política ANTERIOR no aplica a nada de esto y Phes no disciplinará a un empleado por actividad concertada protegida.",
        },
      },

      { type: "h", text: { en: "Illinois Off-Duty Privacy (820 ILCS 55)", es: "Privacidad Fuera de Servicio en Illinois (820 ILCS 55)" } },
      {
        type: "p",
        text: {
          en: "The Illinois Right to Privacy in the Workplace Act (820 ILCS 55) prohibits Phes from demanding access to your personal social-media accounts and from disciplining you for lawful off-duty use of social media unless that use directly damages a legitimate business interest. Phes will not ask for your social-media passwords, will not require you to friend the office, and will not monitor your personal accounts.",
          es: "La Ley del Derecho a la Privacidad en el Lugar de Trabajo de Illinois (820 ILCS 55) prohíbe a Phes exigir acceso a sus cuentas personales de redes sociales y disciplinarlo por uso legal fuera del trabajo de redes sociales, a menos que ese uso dañe directamente un interés comercial legítimo. Phes no le pedirá las contraseñas de sus redes sociales, no le exigirá agregar a la oficina como amigo y no monitoreará sus cuentas personales.",
        },
      },

      { type: "h", text: { en: "Impersonation of Phes", es: "Suplantación de Phes" } },
      {
        type: "p",
        text: {
          en: "You may not create a social-media account that appears to speak FOR Phes, use Phes branding without authorization, or pretend to be an official Phes representative online. If you want to highlight that you work at Phes on your personal account (a tasteful bio mention, a tagged photo), that is fine. What is not fine is creating a page that looks like a Phes-operated channel without office approval.",
          es: "No puede crear una cuenta de redes sociales que parezca hablar EN NOMBRE DE Phes, usar la marca de Phes sin autorización ni hacerse pasar por un representante oficial de Phes en línea. Si quiere mencionar que trabaja en Phes en su cuenta personal (una mención discreta en la bio, una foto etiquetada), está bien. Lo que no está bien es crear una página que parezca un canal operado por Phes sin la aprobación de la oficina.",
        },
      },

      { type: "h", text: { en: "Reporting Harassment Seen Online", es: "Reportar Acoso Visto en Línea" } },
      {
        type: "p",
        text: {
          en: "If you see harassment or threats from a coworker on a public-facing social-media post (whether or not you are the target), you may report it through the same Code of Conduct reporting channels: the office team, the owner, the Illinois Department of Human Rights, or the EEOC. Good-faith reporting is protected under the same anti-retaliation rules described in the Code of Conduct module.",
          es: "Si ve acoso o amenazas de un compañero en una publicación pública de redes sociales (sea o no usted el blanco), puede reportarlo a través de las mismas vías del Código de Conducta: el equipo de la oficina, el dueño, el Departamento de Derechos Humanos de Illinois o la EEOC. El reporte de buena fe está protegido bajo las mismas reglas de anti-represalias descritas en el módulo del Código de Conducta.",
        },
      },

      {
        type: "callout",
        tone: "info",
        text: {
          en: "After this quiz: you will sign a separate Social Media Policy Acknowledgment that records your commitment. It is a one-sided acknowledgment (not co-signed). You can re-download the signed PDF anytime from your training page. If you have questions about whether a specific post would violate the policy, ask the office before posting, not after.",
          es: "Después de este examen: firmará un Reconocimiento de la Política de Redes Sociales por separado que registra su compromiso. Es un reconocimiento unilateral (no co-firmado). Puede volver a descargar el PDF firmado en cualquier momento desde su página de capacitación. Si tiene preguntas sobre si una publicación específica violaría la política, pregunte a la oficina antes de publicar, no después.",
        },
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 12. PHES 401(k) RETIREMENT PLAN (Phase 8, PR #9)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Benefits-EDUCATION module. NOT a signed legal document and does NOT gate
  // the final exam. Plan facts sourced from the ADP Plan Highlights PDF
  // (PHES LLC, Plan ID 073781). The completion certificate issues
  // automatically when the quiz passes.
  //
  // Educational disclaimer (also in the module body): this content is
  // general education, not financial, tax, or legal advice. ADP is the
  // record keeper and is not affiliated with Phes as an employer. The Plan
  // document governs in the event of any inconsistencies.
  {
    id: "phes-401k",
    number: 12,
    iconKind: "money",
    title: {
      en: "Phes 401(k) Retirement Plan",
      es: "Plan de Jubilación 401(k) de Phes",
    },
    subtitle: {
      en: "How your 401(k) works, how to enroll, contribution options, and the Phes Safe Harbor match.",
      es: "Cómo funciona su 401(k), cómo inscribirse, opciones de contribución y la contribución de Safe Harbor de Phes.",
    },
    estimatedMinutes: 10,
    blocks: [
      {
        type: "callout",
        tone: "info",
        text: {
          en: "This module is educational only. It is not financial, tax, or legal advice. ADP Retirement Services is the plan record keeper and is not affiliated with Phes as your employer. Plan features and benefits are subject to the Plan document, which governs in the event of any inconsistency with this module. Consult your own advisors for individual planning decisions.",
          es: "Este módulo es solo educativo. No es asesoría financiera, fiscal ni legal. ADP Retirement Services es el administrador de registros del plan y no está afiliado a Phes como su empleador. Las características y los beneficios del plan están sujetos al documento del Plan, el cual prevalece en caso de cualquier inconsistencia con este módulo. Consulte a sus propios asesores para decisiones de planeación individual.",
        },
      },

      { type: "h", text: { en: "Plan Basics", es: "Información Básica del Plan" } },
      {
        type: "p",
        text: {
          en: "Phes sponsors a 401(k) retirement plan for its W-2 employees. The plan is administered by ADP Retirement Services. Plan name: PHES LLC - 401(K). Plan ID: 073781. Plan sponsor: PHES LLC. Record-keeper address: 71 Hanover Road, Florham Park, NJ 07932.",
          es: "Phes patrocina un plan de jubilación 401(k) para sus empleados W-2. El plan es administrado por ADP Retirement Services. Nombre del plan: PHES LLC - 401(K). ID del plan: 073781. Patrocinador del plan: PHES LLC. Dirección del administrador de registros: 71 Hanover Road, Florham Park, NJ 07932.",
        },
      },

      { type: "h", text: { en: "Who Is Eligible", es: "Quién es Elegible" } },
      {
        type: "p",
        text: {
          en: "You become eligible to participate when you meet BOTH of these requirements by the next plan entry date:",
          es: "Es elegible para participar cuando cumple AMBOS de estos requisitos para la próxima fecha de entrada al plan:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Age 18 or older.", es: "18 años o más." },
          { en: "3 months of service with Phes.", es: "3 meses de servicio con Phes." },
        ],
      },

      { type: "h", text: { en: "Auto-Enrollment at 3 Percent", es: "Inscripción Automática al 3 Por Ciento" } },
      {
        type: "p",
        text: {
          en: "When you become eligible, you are AUTOMATICALLY enrolled in the Plan. Your default contribution is 3 percent of pay, deducted before tax, invested in the Plan's default fund. You can change the contribution percentage, change the fund, or opt out at any time.",
          es: "Cuando se vuelve elegible, queda AUTOMÁTICAMENTE inscrito en el Plan. Su contribución predeterminada es 3 por ciento del pago, deducida antes de impuestos, invertida en el fondo predeterminado del Plan. Puede cambiar el porcentaje de contribución, cambiar el fondo o cancelar la inscripción en cualquier momento.",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Opt out or change your election: My.ADP.com, the ADP Mobile Solutions App, or the Voice-Response System.", es: "Cancelar la inscripción o cambiar su elección: My.ADP.com, la aplicación ADP Mobile Solutions, o el sistema de respuesta por voz." },
          { en: "Re-enroll later anytime: if you opt out and later change your mind, you can enroll again whenever you want.", es: "Volver a inscribirse después en cualquier momento: si cancela la inscripción y luego cambia de opinión, puede volver a inscribirse cuando quiera." },
        ],
      },

      { type: "h", text: { en: "How to Enroll (or Change Your Election)", es: "Cómo Inscribirse (o Cambiar Su Elección)" } },
      {
        type: "bullets",
        items: [
          { en: "Text \"Enroll Now\" to 72408.", es: "Envíe un texto con \"Enroll Now\" al 72408." },
          { en: "Visit My.ADP.com.", es: "Visite My.ADP.com." },
          { en: "Use the ADP Mobile Solutions App.", es: "Use la aplicación ADP Mobile Solutions." },
          { en: "Call 1-800-695-7526 (the Voice-Response System is available 24/7; live representatives are available Monday through Friday, 8:00 AM to 9:00 PM Eastern).", es: "Llame al 1-800-695-7526 (el sistema de respuesta por voz está disponible 24/7; los representantes en vivo están disponibles de lunes a viernes, de 8:00 AM a 9:00 PM hora del Este)." },
        ],
      },

      { type: "h", text: { en: "Contribution Options", es: "Opciones de Contribución" } },
      {
        type: "bullets",
        items: [
          { en: "Before-tax (Traditional) contributions: 1 percent to 90 percent of pay.", es: "Contribuciones antes de impuestos (Tradicional): 1 por ciento a 90 por ciento del pago." },
          { en: "After-tax (Roth) contributions: 1 percent to 90 percent of pay.", es: "Contribuciones después de impuestos (Roth): 1 por ciento a 90 por ciento del pago." },
          { en: "Annual dollar limit to the Plan: $24,500.", es: "Límite anual en dólares al Plan: $24,500." },
          { en: "Highly Compensated Employees may have lower limits.", es: "Los Empleados Altamente Compensados pueden tener límites más bajos." },
        ],
      },

      { type: "h", text: { en: "Catch-Up Contributions (Age 50 and Older)", es: "Contribuciones de Recuperación (50 Años o Más)" } },
      {
        type: "bullets",
        items: [
          { en: "Standard catch-up: if you will be age 50 or older by December 31, you may contribute an additional $8,000 per year above the standard limit.", es: "Recuperación estándar: si tendrá 50 años o más al 31 de diciembre, puede contribuir $8,000 adicionales al año por encima del límite estándar." },
          { en: "Super catch-up: if you will be age 60 to 63 by December 31, you may contribute an additional $11,250 per year.", es: "Súper recuperación: si tendrá entre 60 y 63 años al 31 de diciembre, puede contribuir $11,250 adicionales al año." },
          { en: "Required Roth on catch-up: if you earned more than $150,000 in Social Security wages (Box 3 of W-2) from Phes in the prior year, ALL of your catch-up contributions must be designated as Roth.", es: "Roth requerido en recuperación: si ganó más de $150,000 en salarios del Seguro Social (Casilla 3 del W-2) de Phes el año anterior, TODAS sus contribuciones de recuperación deben ser designadas como Roth." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Limits are subject to annual IRS adjustment. The figures shown above match the Phes plan document as currently published by ADP. The IRS announces new limits each fall for the following tax year; ADP updates the plan document accordingly. If you are planning contributions near the cap for a specific year, log into My.ADP.com or call 1-800-695-7526 to confirm the current-year numbers before you elect.",
          es: "Los límites están sujetos a ajuste anual del IRS. Las cifras mostradas arriba coinciden con el documento del plan de Phes según lo publica actualmente ADP. El IRS anuncia nuevos límites cada otoño para el año fiscal siguiente; ADP actualiza el documento del plan en consecuencia. Si planea contribuciones cerca del límite máximo de un año específico, inicie sesión en My.ADP.com o llame al 1-800-695-7526 para confirmar los números del año en curso antes de hacer su elección.",
        },
      },

      { type: "h", text: { en: "Phes Safe Harbor Match (The Free Money)", es: "Contribución Safe Harbor de Phes (El Dinero Gratis)" } },
      {
        type: "callout",
        tone: "success",
        text: {
          en: "Phes matches your contributions under a Safe Harbor formula: 100 percent of the first 3 percent of your salary deferral, plus 50 percent of the next 2 percent of your deferral. If you contribute 5 percent of your pay, Phes adds 4 percent of your pay on top of that. This match is in addition to your own contribution. You do not have to do anything special to receive it beyond contributing to the Plan.",
          es: "Phes iguala sus contribuciones bajo una fórmula de Safe Harbor: 100 por ciento del primer 3 por ciento de su aplazamiento salarial, más 50 por ciento del siguiente 2 por ciento de su aplazamiento. Si contribuye 5 por ciento de su pago, Phes agrega 4 por ciento de su pago además de eso. Esta contribución es adicional a la suya. No tiene que hacer nada especial para recibirla, solo contribuir al Plan.",
        },
      },

      { type: "h", text: { en: "Profit-Sharing Contributions (Discretionary)", es: "Contribuciones de Reparto de Utilidades (Discrecionales)" } },
      {
        type: "p",
        text: {
          en: "Phes may make a profit-sharing contribution to the Plan each year. This is discretionary, meaning Phes decides each year whether to contribute and how much. Specific eligibility requirements apply. See the Summary Plan Description (SPD) for details.",
          es: "Phes puede hacer una contribución de reparto de utilidades al Plan cada año. Esto es discrecional, lo que significa que Phes decide cada año si contribuir y cuánto. Aplican requisitos de elegibilidad específicos. Consulte el Resumen Descriptivo del Plan (SPD) para más detalles.",
        },
      },

      { type: "h", text: { en: "Vesting (When the Money Is Yours)", es: "Adquisición de Derechos (Cuándo el Dinero es Suyo)" } },
      {
        type: "bullets",
        items: [
          { en: "Your own contributions: 100 percent vested immediately. The money is yours from day one.", es: "Sus propias contribuciones: 100 por ciento adquiridas inmediatamente. El dinero es suyo desde el primer día." },
          { en: "Safe Harbor match: 100 percent vested immediately. The match is yours as soon as it lands in your account.", es: "Contribución Safe Harbor: 100 por ciento adquirida inmediatamente. La contribución es suya tan pronto como llega a su cuenta." },
        ],
      },
      {
        type: "p",
        text: {
          en: "Profit-sharing contributions (if any) vest on a graded schedule based on years of service:",
          es: "Las contribuciones de reparto de utilidades (si las hay) se adquieren en una escala progresiva basada en años de servicio:",
        },
      },
      {
        type: "table",
        head: { en: ["Years of Service", "Vested Percentage"], es: ["Años de Servicio", "Porcentaje Adquirido"] },
        rows: [
          { en: ["0 to 1 year", "0 percent"], es: ["0 a 1 año", "0 por ciento"] },
          { en: ["2 years", "20 percent"], es: ["2 años", "20 por ciento"] },
          { en: ["3 years", "40 percent"], es: ["3 años", "40 por ciento"] },
          { en: ["4 years", "60 percent"], es: ["4 años", "60 por ciento"] },
          { en: ["5 years", "80 percent"], es: ["5 años", "80 por ciento"] },
          { en: ["6 or more years", "100 percent"], es: ["6 o más años", "100 por ciento"] },
        ],
      },

      { type: "h", text: { en: "Rollovers From a Previous Employer", es: "Transferencias de un Empleador Anterior" } },
      {
        type: "p",
        text: {
          en: "If you have savings in a previous employer's qualified retirement plan or a Rollover IRA, you can roll those balances into the Phes 401(k). This is available even if you have not yet met the age and service requirements to make new contributions. Consolidation makes tracking easier. To start, log into your account or use the ADP Mobile Solutions App and click the \"Consolidate Accounts\" tile. The rollover resource page is at achieve.adp.com.",
          es: "Si tiene ahorros en un plan de jubilación calificado de un empleador anterior o en una IRA de Rollover, puede transferir esos saldos al 401(k) de Phes. Está disponible aunque aún no haya cumplido los requisitos de edad y servicio para hacer nuevas contribuciones. Consolidar facilita el seguimiento. Para empezar, ingrese a su cuenta o use la aplicación ADP Mobile Solutions y haga clic en el panel \"Consolidate Accounts\". La página de recursos sobre transferencias está en achieve.adp.com.",
        },
      },

      { type: "h", text: { en: "Loans", es: "Préstamos" } },
      {
        type: "bullets",
        items: [
          { en: "Outstanding loans allowed: 1 at any time.", es: "Préstamos pendientes permitidos: 1 a la vez." },
          { en: "Minimum loan amount: $500.", es: "Monto mínimo del préstamo: $500." },
          { en: "Maximum repayment period: 5 years (longer if used to purchase your primary residence).", es: "Período máximo de pago: 5 años (más largo si se usa para comprar su residencia principal)." },
          { en: "Interest rate: Prime plus 2 percent.", es: "Tasa de interés: Prime más 2 por ciento." },
          { en: "A loan fee may apply. See Account > Plan Information > Participant Fee Disclosure > Individual Expenses on the ADP website.", es: "Puede aplicarse una tarifa de préstamo. Consulte Account > Plan Information > Participant Fee Disclosure > Individual Expenses en el sitio de ADP." },
        ],
      },

      { type: "h", text: { en: "Withdrawals While Still Employed", es: "Retiros Mientras Sigue Empleado" } },
      {
        type: "bullets",
        items: [
          { en: "Rollover withdrawal (move balances out to another qualified plan or IRA).", es: "Retiro de transferencia (mover saldos a otro plan calificado o IRA)." },
          { en: "Age 59 and a half withdrawal (penalty-free).", es: "Retiro a los 59 años y medio (sin penalización)." },
          { en: "Hardship withdrawal (specific qualifying events; see Plan documents).", es: "Retiro por dificultad (eventos calificantes específicos; consulte los documentos del Plan)." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "If you withdraw before age 59 and a half (other than a rollover), you generally pay a 10 percent early-withdrawal penalty IN ADDITION to federal and state income tax on the amount withdrawn. The Special Tax Notice on the retirement-plan website explains the consequences in detail.",
          es: "Si retira antes de los 59 años y medio (que no sea una transferencia), generalmente paga una penalización por retiro temprano del 10 por ciento ADEMÁS del impuesto federal y estatal sobre el monto retirado. El Aviso Fiscal Especial en el sitio web del plan de jubilación explica las consecuencias en detalle.",
        },
      },

      { type: "h", text: { en: "Naming a Beneficiary", es: "Nombrar a un Beneficiario" } },
      {
        type: "p",
        text: {
          en: "Your account passes to the beneficiary or beneficiaries you designate if you die before withdrawing the balance. You provide the beneficiary's name, date of birth, and Social Security Number when you make the designation. If you are married and want to name someone other than your spouse, you must print and submit the Spousal Consent Form available online.",
          es: "Su cuenta pasa al beneficiario o beneficiarios que designe si fallece antes de retirar el saldo. Usted provee el nombre del beneficiario, su fecha de nacimiento y su número de Seguro Social al hacer la designación. Si está casado y quiere nombrar a alguien distinto de su cónyuge, debe imprimir y enviar el Formulario de Consentimiento Conyugal disponible en línea.",
        },
      },

      { type: "h", text: { en: "Tools and Resources", es: "Herramientas y Recursos" } },
      {
        type: "bullets",
        items: [
          { en: "Save Smart automatically increases your contribution percentage by 1, 2, or 3 percentage points on a date you choose each year (before-tax contributions only).", es: "Save Smart aumenta automáticamente su porcentaje de contribución en 1, 2 o 3 puntos porcentuales en una fecha que usted elige cada año (solo contribuciones antes de impuestos)." },
          { en: "Automatic Account Rebalancing keeps your current investment mix consistent with your strategy (quarterly, semi-annually, or annually).", es: "El Reequilibrio Automático de la Cuenta mantiene su mezcla de inversión actual consistente con su estrategia (trimestralmente, semestralmente o anualmente)." },
          { en: "Quarterly Account Statement is in the My Account section after you log in.", es: "El Estado de Cuenta Trimestral está en la sección My Account después de iniciar sesión." },
          { en: "Participant Advisory Services from Edelman Financial Engines: some components are free; the Professional Management program has an annual fee based on account balance. Enroll at My.ADP.com or call (844) 861-0028. Edelman Financial Engines is not affiliated with ADP.", es: "Servicios de Asesoría para Participantes de Edelman Financial Engines: algunos componentes son gratuitos; el programa Professional Management tiene una tarifa anual basada en el saldo de la cuenta. Inscríbase en My.ADP.com o llame al (844) 861-0028. Edelman Financial Engines no está afiliado a ADP." },
          { en: "ADP Achieve Engagement Hub: planning tools and resources at achieve.adp.com.", es: "ADP Achieve Engagement Hub: herramientas y recursos de planeación en achieve.adp.com." },
        ],
      },

      {
        type: "callout",
        tone: "info",
        text: {
          en: "This module ends here. Passing the quiz issues a completion certificate that you can download anytime from your training page. There is no separate signed legal document for the 401(k) module. The Plan document and the Summary Plan Description (SPD), available through My.ADP.com, govern the actual operation of the plan and prevail over any conflict with this educational summary.",
          es: "Este módulo termina aquí. Aprobar el examen emite un certificado de finalización que puede descargar en cualquier momento desde su página de capacitación. No hay un documento legal firmado separado para el módulo del 401(k). El documento del Plan y el Resumen Descriptivo del Plan (SPD), disponibles a través de My.ADP.com, rigen la operación real del plan y prevalecen sobre cualquier conflicto con este resumen educativo.",
        },
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 13. SUPPLY KIT RESPONSIBILITY (Phase 9, PR #10)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // One-sided employee acknowledgment (NOT co-signed). Establishes
  // responsibility for Phes-provided cleaning supplies, uniform, keys,
  // alarm codes, and any assigned hardware. Distinguishes reasonable
  // wear-and-tear (Phes absorbs) from negligent damage or loss
  // (employee may be billed). Critically: does NOT pre-authorize
  // automatic payroll deductions — Illinois Wage Payment and Collection
  // Act (820 ILCS 115) requires contemporaneous written authorization
  // for any specific deduction, so the agreement reserves Phes's right
  // to seek reimbursement and explains the IL deduction-authorization
  // requirement.
  {
    id: "supply-kit",
    number: 13,
    iconKind: "spray",
    title: {
      en: "Supply Kit Responsibility",
      es: "Responsabilidad del Kit de Suministros",
    },
    subtitle: {
      en: "What Phes gives you to do the job, how to care for it, and what happens if something is lost or damaged through negligence.",
      es: "Lo que Phes le entrega para hacer el trabajo, cómo cuidarlo, y qué pasa si algo se pierde o daña por negligencia.",
    },
    estimatedMinutes: 8,
    blocks: [
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Why this module matters. Phes provides the tools you need to do the job. The supply kit is Phes property loaned to you while you are employed. The agreement is short and practical: take reasonable care of the kit, report damage or loss promptly, return everything at separation. Normal wear is on Phes, not on you. Negligent damage or unreported loss may result in you being billed for replacement.",
          es: "Por qué importa este módulo. Phes provee las herramientas que necesita para hacer el trabajo. El kit de suministros es propiedad de Phes prestada a usted mientras esté empleado. El acuerdo es corto y práctico: cuide razonablemente el kit, reporte daños o pérdidas a tiempo, devuelva todo al separarse. El desgaste normal está a cargo de Phes, no de usted. Los daños por negligencia o la pérdida no reportada pueden resultar en que se le facture el reemplazo.",
        },
      },

      { type: "h", text: { en: "Supply Pickup is Your Responsibility", es: "Recoger Suministros es Su Responsabilidad" } },
      {
        type: "p",
        text: {
          en: "Phes provides cleaning supplies at the office for technicians to pick up and use on assigned jobs. It is your responsibility as a Phes technician to maintain your supply kit and ensure you have the supplies you need to perform your assigned work.",
          es: "Phes provee suministros de limpieza en la oficina para que los técnicos los recojan y usen en los trabajos asignados. Es su responsabilidad como técnico de Phes mantener su kit de suministros y asegurarse de tener los suministros que necesita para realizar el trabajo asignado.",
        },
      },
      {
        type: "p",
        text: {
          en: "Supplies are available for pickup at the office during office hours. You may come to the office whenever it is convenient for you, including before your scheduled workday, after your scheduled workday, or on your scheduled days off. Phes does not require you to come to the office daily or at any specific time for supply pickup. We give you the flexibility to manage your supply pickup as it works with your schedule and travel patterns.",
          es: "Los suministros están disponibles para recoger en la oficina durante el horario de oficina. Puede venir a la oficina cuando sea conveniente para usted, incluyendo antes de su jornada laboral, después de su jornada laboral, o en sus días libres programados. Phes no requiere que venga a la oficina diariamente ni en un horario específico para recoger suministros. Le damos la flexibilidad para manejar la recogida de suministros como funcione con su horario y patrones de viaje.",
        },
      },
      {
        type: "p",
        text: {
          en: "With this flexibility comes responsibility. You must:",
          es: "Con esa flexibilidad viene la responsabilidad. Usted debe:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Check your supply kit at the end of each workday and assess what you will need for upcoming jobs.", es: "Revisar su kit de suministros al final de cada jornada y evaluar lo que necesitará para los próximos trabajos." },
          { en: "Plan supply pickup trips when you are already in the area of the office, especially if you live a significant distance from the office.", es: "Planear viajes de recogida cuando ya está en el área de la oficina, especialmente si vive a una distancia considerable de la oficina." },
          { en: "Come to the office in advance of running out of supplies, not after.", es: "Venir a la oficina antes de quedarse sin suministros, no después." },
          { en: "Maintain your supplies in clean, organized, working condition.", es: "Mantener sus suministros limpios, organizados y en condición de uso." },
          { en: "Treat company-provided supplies as Phes property.", es: "Tratar los suministros provistos por la compañía como propiedad de Phes." },
        ],
      },

      { type: "h", text: { en: "What Happens if You Run Out of Supplies", es: "Qué Pasa si Se Queda Sin Suministros" } },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Phes will not pay for emergency supply shipping, will not deliver supplies to your home, and will not pay you for time spent running to retail stores because you ran out of supplies you should have picked up at the office. If you fail to pick up supplies in advance and run out before a job, you are responsible for solving the supply gap on your own time and at your own expense. This may mean coming to the office to pick up supplies even on a day you did not plan to, or purchasing supplies from a retail store at your own cost.",
          es: "Phes no pagará por envío urgente de suministros, no entregará suministros en su casa, y no le pagará por el tiempo dedicado a ir a tiendas minoristas porque se quedó sin suministros que debió haber recogido en la oficina. Si no recoge los suministros con anticipación y se queda sin ellos antes de un trabajo, usted es responsable de resolver la falta en su propio tiempo y a su propio costo. Esto puede significar venir a la oficina a recoger suministros incluso en un día en el que no planeaba hacerlo, o comprar suministros en una tienda minorista a su propio costo.",
        },
      },
      {
        type: "p",
        text: {
          en: "Repeatedly running out of supplies or failing to maintain your supply kit may result in coaching, written warning, or discipline up to and including termination. The supplies Phes provides are a fundamental tool for your work. Your reliability with supply management directly affects your ability to perform your job, the client's experience, and Phes's operations.",
          es: "Quedarse sin suministros repetidamente o no mantener su kit de suministros puede resultar en coaching, advertencia por escrito o disciplina hasta e incluyendo la terminación. Los suministros que Phes provee son una herramienta fundamental para su trabajo. Su confiabilidad en la gestión de suministros afecta directamente su capacidad de hacer su trabajo, la experiencia del cliente y las operaciones de Phes.",
        },
      },

      { type: "h", text: { en: "Supply Pickup is Not Part of Your Scheduled Workday", es: "Recoger Suministros No Es Parte de Su Jornada Laboral" } },
      {
        type: "p",
        text: {
          en: "Supply pickup is a preparatory activity. It is not part of your scheduled workday. Travel to and from the office for supply pickup is not compensated, and mileage to the office for supply pickup is not reimbursed because it is considered personal travel similar to your home-to-first-job commute.",
          es: "Recoger suministros es una actividad preparatoria. No es parte de su jornada laboral programada. El viaje hacia y desde la oficina para recoger suministros no se compensa, y el millaje hacia la oficina para recoger suministros no se reembolsa porque se considera viaje personal similar a su recorrido de casa al primer trabajo.",
        },
      },
      {
        type: "p",
        text: {
          en: "If the office specifically requires you to come to the office during your scheduled workday for a work-related reason other than supply pickup (such as training, meetings, or a specific assigned task), that time will be compensated separately and any mileage for required office trips during the workday will be reimbursed at the standard rate.",
          es: "Si la oficina específicamente requiere que venga a la oficina durante su jornada laboral por una razón laboral distinta a recoger suministros (como capacitación, reuniones o una tarea específica asignada), ese tiempo será compensado por separado y cualquier millaje por viajes obligatorios a la oficina durante la jornada será reembolsado a la tarifa estándar.",
        },
      },

      { type: "h", text: { en: "Planning Tips", es: "Consejos de Planificación" } },
      {
        type: "p",
        text: {
          en: "The office is open during business hours. Plan supply pickup trips around your existing travel patterns:",
          es: "La oficina está abierta en horario de oficina. Planee los viajes de recogida en torno a sus patrones de viaje existentes:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "If you have a job near the office, stop in before or after that job.", es: "Si tiene un trabajo cerca de la oficina, pase antes o después de ese trabajo." },
          { en: "If you live a significant distance from the office, plan a pickup trip every 1 to 2 weeks rather than running back and forth.", es: "Si vive a una distancia considerable de la oficina, planee un viaje de recogida cada 1 o 2 semanas en lugar de ir y venir." },
          { en: "Check your supplies weekly so you can plan a pickup before you run low.", es: "Revise sus suministros semanalmente para que pueda planear una recogida antes de que se le acaben." },
          { en: "If you know you have a heavy job coming up (deep clean, move-in or move-out), plan your supply pickup in advance.", es: "Si sabe que tiene un trabajo grande próximamente (limpieza profunda, mudanza de entrada o salida), planee la recogida de suministros con anticipación." },
          { en: "Coordinate with other techs in your area when possible.", es: "Coordine con otros técnicos en su área cuando sea posible." },
        ],
      },

      { type: "h", text: { en: "Office Hours and Access", es: "Horario de Oficina y Acceso" } },
      {
        type: "p",
        text: {
          en: "The office is open for supply pickup during regular business hours [OFFICE_HOURS_TO_CONFIRM]. If you need to come to the office outside of those hours, contact the office in advance to coordinate access.",
          es: "La oficina está abierta para recoger suministros durante el horario regular [OFFICE_HOURS_TO_CONFIRM]. Si necesita venir a la oficina fuera de ese horario, contacte a la oficina con anticipación para coordinar el acceso.",
        },
      },

      { type: "h", text: { en: "What Is in the Supply Kit", es: "Qué Está en el Kit de Suministros" } },
      {
        type: "p",
        text: {
          en: "The exact contents of your kit are listed on the Kit Inventory Sheet you receive on your first day. A typical Phes kit includes:",
          es: "El contenido exacto de su kit está listado en la Hoja de Inventario del Kit que recibe el primer día. Un kit típico de Phes incluye:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Cleaning caddy, color-coded microfiber cloths, mop and bucket, vacuum (or vacuum allocation if assigned to a team vehicle), step stool.", es: "Caddy de limpieza, paños de microfibra codificados por color, trapeador y cubeta, aspiradora (o asignación de aspiradora si está asignado a un vehículo de equipo), banquito." },
          { en: "Cleaning chemicals issued in their Phes-branded refillable bottles. Refills come from the office stock room.", es: "Productos químicos de limpieza entregados en sus botellas recargables con marca de Phes. Las recargas vienen del cuarto de suministros de la oficina." },
          { en: "Phes-branded uniform (shirt, apron, name badge) and shoe covers.", es: "Uniforme con marca de Phes (camisa, delantal, gafete) y cubre-zapatos." },
          { en: "Phes phone or tablet (if assigned for MaidCentral / Qleno access), keys, key cards, or alarm-code cards for recurring-visit clients.", es: "Teléfono o tableta de Phes (si se le asigna para acceso a MaidCentral / Qleno), llaves, tarjetas de acceso o tarjetas de códigos de alarma para clientes recurrentes." },
        ],
      },

      { type: "h", text: { en: "What Is Phes Property and What Is Yours", es: "Qué es Propiedad de Phes y Qué es Suyo" } },
      {
        type: "p",
        text: {
          en: "Everything in the kit is PHES PROPERTY. It is loaned to you for the duration of your employment. You do not own any of it. What you DO own:",
          es: "Todo en el kit es PROPIEDAD DE PHES. Se le presta durante el tiempo de su empleo. Usted no es dueño de nada de eso. Lo que SÍ le pertenece:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Tips from clients are yours (recorded on the Worksheet per the handbook).", es: "Las propinas de clientes son suyas (registradas en la Hoja de Trabajo según el manual)." },
          { en: "Personal items you bring (your phone, your water bottle, your own car).", es: "Artículos personales que traiga (su teléfono, su botella de agua, su propio auto)." },
          { en: "Your general knowledge, skill, and experience.", es: "Su conocimiento general, habilidad y experiencia." },
        ],
      },

      { type: "h", text: { en: "Reasonable Wear vs Negligent Damage", es: "Desgaste Razonable vs Daño por Negligencia" } },
      {
        type: "p",
        text: {
          en: "Phes absorbs REASONABLE WEAR AND TEAR that comes from using equipment as intended. Examples:",
          es: "Phes absorbe el DESGASTE Y USO RAZONABLE que viene de usar el equipo como se pretende. Ejemplos:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Microfiber cloths fraying after months of use.", es: "Paños de microfibra que se deshilachan después de meses de uso." },
          { en: "A vacuum belt wearing out from normal cleaning.", es: "Una banda de aspiradora que se desgasta por limpieza normal." },
          { en: "Uniform fading from regular washing.", es: "Uniforme que se desvanece por el lavado regular." },
          { en: "A mop head needing replacement after extended use.", es: "Una cabeza de trapeador que necesita reemplazo después de uso prolongado." },
        ],
      },
      {
        type: "p",
        text: {
          en: "NEGLIGENT DAMAGE or LOSS is different. Examples:",
          es: "El DAÑO POR NEGLIGENCIA o la PÉRDIDA es distinto. Ejemplos:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Leaving the vacuum in the rain in a client driveway, ruining it.", es: "Dejar la aspiradora en la lluvia en la entrada de un cliente, arruinándola." },
          { en: "Loaning the Phes phone to a friend and it not coming back.", es: "Prestar el teléfono de Phes a un amigo y que no regrese." },
          { en: "Losing a client's house key because it was off your keyring while you ran personal errands.", es: "Perder la llave de la casa de un cliente porque no estaba en su llavero mientras hacía mandados personales." },
          { en: "Using a Phes vehicle off the clock for personal trips and getting into an accident.", es: "Usar un vehículo de Phes fuera del horario para viajes personales y tener un accidente." },
        ],
      },

      { type: "h", text: { en: "Report Damage or Loss Promptly", es: "Reporte Daños o Pérdidas con Prontitud" } },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "If something in your kit is damaged, lost, or stops working, report it to the office BEFORE your next shift. The single biggest difference between a covered incident and a billed incident is whether you reported it. Phes can almost always resolve an honestly reported issue. Phes cannot resolve a hidden one.",
          es: "Si algo en su kit se daña, se pierde o deja de funcionar, repórtelo a la oficina ANTES de su siguiente turno. La mayor diferencia entre un incidente cubierto y un incidente facturado es si lo reportó. Phes casi siempre puede resolver un asunto reportado honestamente. Phes no puede resolver uno oculto.",
        },
      },

      { type: "h", text: { en: "Lost Client Key or Alarm Code", es: "Llave del Cliente o Código de Alarma Perdido" } },
      {
        type: "p",
        text: {
          en: "If you lose a client's key, key card, or alarm-code card, call the office IMMEDIATELY (not at the end of your shift, not the next day). The office will arrange a rekey or code change with the client. Phes pays for the rekey. The lost-key itself is not grounds for discipline; covering it up or delaying the report is.",
          es: "Si pierde la llave de un cliente, una tarjeta de acceso o una tarjeta de código de alarma, llame a la oficina INMEDIATAMENTE (no al final del turno, no al día siguiente). La oficina coordinará un cambio de cerradura o de código con el cliente. Phes paga el cambio de cerradura. La llave perdida en sí no es motivo de disciplina; ocultarlo o retrasar el reporte sí lo es.",
        },
      },

      { type: "h", text: { en: "No Personal Use, No Modifications", es: "Sin Uso Personal, Sin Modificaciones" } },
      {
        type: "bullets",
        items: [
          { en: "Do not use Phes supplies or equipment for personal cleaning at your own home or at a friend's home.", es: "No use suministros ni equipo de Phes para limpieza personal en su propia casa o en la casa de un amigo." },
          { en: "Do not lend the Phes phone, tablet, vehicle, or keys to anyone, including coworkers off the clock.", es: "No preste el teléfono, tableta, vehículo o llaves de Phes a nadie, incluyendo compañeros fuera de turno." },
          { en: "Do not modify or alter the equipment. If something is not working, get the office to issue a replacement.", es: "No modifique ni altere el equipo. Si algo no funciona, pida a la oficina que entregue un reemplazo." },
          { en: "Do not buy substitute chemicals on your own initiative. Phes uses specific products for safety and consistency. Refills come from the office.", es: "No compre productos químicos sustitutos por su cuenta. Phes usa productos específicos por seguridad y consistencia. Las recargas vienen de la oficina." },
        ],
      },

      { type: "h", text: { en: "Uniform Care", es: "Cuidado del Uniforme" } },
      {
        type: "p",
        text: {
          en: "Wash the uniform shirt and apron after each shift. Replace a torn uniform by asking the office (replacement is free for normal wear). Do not alter the uniform with paint, embroidery, or unofficial patches. If you have a religious or medical accommodation request related to the uniform, ask the office for the accommodation conversation.",
          es: "Lave la camisa y el delantal del uniforme después de cada turno. Reemplace un uniforme roto pidiéndoselo a la oficina (el reemplazo es gratis por desgaste normal). No altere el uniforme con pintura, bordado ni parches no oficiales. Si tiene una solicitud de acomodación religiosa o médica relacionada con el uniforme, pida a la oficina la conversación de acomodación.",
        },
      },

      { type: "h", text: { en: "Replacement and the Illinois Wage Payment and Collection Act", es: "Reemplazo y la Ley de Pago de Salarios y Recolección de Illinois" } },
      {
        type: "p",
        text: {
          en: "If something is damaged through negligence or unreported loss and Phes needs to bill you for replacement, here is how it works. Phes determines a replacement cost based on the documented item value. Phes notifies you in writing. If you agree to repayment, Phes and you SIGN A SEPARATE WRITTEN AUTHORIZATION (at that time, for that specific deduction) before any amount is taken from your paycheck. This is required by the Illinois Wage Payment and Collection Act, 820 ILCS 115, which prohibits employers from taking ANY deduction from wages without contemporaneous written authorization. Signing this Supply Kit Agreement does NOT pre-authorize automatic future deductions.",
          es: "Si algo se daña por negligencia o se pierde sin reportar y Phes necesita facturarle un reemplazo, así funciona. Phes determina un costo de reemplazo basado en el valor documentado del artículo. Phes le notifica por escrito. Si acepta el pago, Phes y usted FIRMAN UNA AUTORIZACIÓN ESCRITA SEPARADA (en ese momento, para esa deducción específica) antes de que se tome cualquier monto de su pago. Esto es requerido por la Ley de Pago de Salarios y Recolección de Illinois, 820 ILCS 115, que prohíbe a los empleadores tomar CUALQUIER deducción del salario sin autorización escrita contemporánea. Firmar este Acuerdo del Kit de Suministros NO pre-autoriza deducciones futuras automáticas.",
        },
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "If you do not agree to repayment, Phes may seek reimbursement through other lawful channels but will not unilaterally deduct from your paycheck. This protects you under Illinois law.",
          es: "Si no acepta el pago, Phes puede buscar el reembolso a través de otras vías legales, pero no deducirá unilateralmente de su pago. Esto le protege bajo la ley de Illinois.",
        },
      },

      { type: "h", text: { en: "Return at Separation", es: "Devolución al Separarse" } },
      {
        type: "p",
        text: {
          en: "On or before your last day with Phes (voluntary or involuntary), you will return ALL Phes property to the office: caddy, vacuum, supplies in their Phes-branded bottles, Phes phone or tablet, all client keys and access cards, the uniform shirt and apron, and any other Phes-issued item. Phes will inspect the returned items and apply the reasonable-wear vs negligent-damage standard described above. Failure to return Phes property may result in Phes seeking reimbursement at replacement cost, subject to the same Illinois Wage Payment and Collection Act limits on payroll deductions.",
          es: "En o antes de su último día con Phes (voluntario o involuntario), devolverá TODA la propiedad de Phes a la oficina: el caddy, la aspiradora, los suministros en sus botellas con marca de Phes, el teléfono o tableta de Phes, todas las llaves y tarjetas de acceso de clientes, la camisa y el delantal del uniforme, y cualquier otro artículo emitido por Phes. Phes inspeccionará los artículos devueltos y aplicará el estándar de desgaste razonable vs daño por negligencia descrito arriba. No devolver la propiedad de Phes puede resultar en que Phes busque el reembolso al costo de reemplazo, sujeto a los mismos límites de la Ley de Pago de Salarios y Recolección de Illinois sobre deducciones de nómina.",
        },
      },

      {
        type: "callout",
        tone: "info",
        text: {
          en: "After this quiz: you will sign a separate Supply Kit Responsibility Acknowledgment that records your commitment. It is a one-sided acknowledgment (not co-signed). You can re-download the signed PDF anytime from your training page. The signature confirms that you understand the kit is Phes property, that you will report damage and loss, and that you understand any specific payroll deduction would require a separate written authorization at the time of the deduction.",
          es: "Después de este examen: firmará un Reconocimiento de Responsabilidad del Kit de Suministros por separado que registra su compromiso. Es un reconocimiento unilateral (no co-firmado). Puede volver a descargar el PDF firmado en cualquier momento desde su página de capacitación. La firma confirma que entiende que el kit es propiedad de Phes, que reportará daños y pérdidas, y que entiende que cualquier deducción de nómina específica requeriría una autorización escrita separada al momento de la deducción.",
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
      { en: "Independent 1099 contractors paid by the job, no taxes withheld.", es: "Contratistas 1099 independientes pagados por trabajo, sin retenciones." },
      { en: "W-2 employees with steady scheduled work and benefits package.", es: "Empleados W-2 con trabajo programado constante y paquete de beneficios." },
      { en: "Day laborers paid in cash at the end of each individual shift.", es: "Jornaleros pagados en efectivo al final de cada turno individual." },
      { en: "Unpaid volunteers earning only a small weekly stipend from Phes.", es: "Voluntarios no pagados que ganan solo un pequeño estipendio semanal de Phes." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-02-guarantee",
    moduleId: "phes-policies",
    prompt: { en: "An hour after you finish a clean, the client calls Phes unhappy with the bathroom. What happens?", es: "Una hora después de terminar una limpieza, el cliente llama a Phes inconforme con el baño. ¿Qué sucede?" },
    options: [
      { en: "Nothing — once the job is marked complete the visit is closed out for good.", es: "Nada — una vez que el trabajo se marca como completo, queda cerrado para siempre." },
      { en: "The client immediately gets a full refund and we move on to the next job.", es: "El cliente recibe inmediatamente un reembolso completo y seguimos al próximo trabajo." },
      { en: "Phes invokes the Fix-It guarantee — office sends a Shortfall Report and schedules return.", es: "Phes invoca la garantía Fix-It — la oficina envía un Reporte de Deficiencia y programa el regreso." },
      { en: "The client can rebook a free clean at any point during the following month.", es: "El cliente puede reservar una limpieza gratis en cualquier momento del mes siguiente." },
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
      { en: "Clean it as a courtesy — the customer is always right in residential service.", es: "Límpielo por cortesía — el cliente siempre tiene la razón en servicio residencial." },
      { en: "Call the office to confirm pricing; decline politely if you are tight on time.", es: "Llame a la oficina para confirmar precio; decline cortésmente si tiene poco tiempo." },
      { en: "Clean it on the spot but charge them in cash directly off the books to save time.", es: "Límpielo en el momento pero cobre en efectivo directamente fuera de los libros." },
      { en: "Refuse and walk out — it is not on today's Worksheet so it does not count at all.", es: "Niéguese y váyase — no está en la Hoja de Trabajo de hoy así que no cuenta para nada." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-04-bodily-fluids",
    moduleId: "phes-policies",
    prompt: { en: "You arrive at a job and see fresh blood on the bathroom floor. What's the right move?", es: "Llega a un trabajo y ve sangre fresca en el piso del baño. ¿Cuál es la acción correcta?" },
    options: [
      { en: "Clean it carefully — blood in the bathroom is just part of normal scope.", es: "Límpielo con cuidado — la sangre en el baño es parte del alcance normal." },
      { en: "Decline politely; bodily fluids are not Phes scope. Call the office for biohazard referral.", es: "Decline cortésmente; los fluidos no están en alcance. Llame a la oficina para biohazard." },
      { en: "Wear extra gloves and a mask and clean it anyway since you are already there.", es: "Use guantes extras y mascarilla y límpielo de todos modos ya que está ahí." },
      { en: "Charge the client extra in cash for biohazard work and then clean it up.", es: "Cobre al cliente extra en efectivo por trabajo de biohazard y luego límpielo." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-05-tipping",
    moduleId: "phes-policies",
    prompt: { en: "A client hands you $20 in cash as a tip at the end of the job. What's the right thing to do?", es: "Un cliente le da $20 en efectivo como propina al final. ¿Qué es correcto?" },
    options: [
      { en: "Refuse — Phes does not allow techs to accept tips from any client.", es: "Rechácela — Phes no permite que los técnicos acepten propinas de ningún cliente." },
      { en: "Take it and keep all of it — tips are 100% yours, no kickback owed.", es: "Tómela y quédese con todo — las propinas son 100% suyas, sin porcentaje." },
      { en: "Take it but turn it in to the office to be redistributed across the team.", es: "Tómela pero entréguela a la oficina para redistribuirla entre el equipo." },
      { en: "Take it and report it to the office as additional revenue from the job.", es: "Tómela y repórtela a la oficina como ingreso adicional del trabajo." },
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
    prompt: { en: "You wake up sick and won't work today. How do you report it?", es: "Despierta enfermo y no trabajará hoy. ¿Cómo lo reporta?" },
    options: [
      { en: "Text a co-worker so they can pass the message along to the office team.", es: "Envíe mensaje a un compañero para que pase el aviso al equipo de la oficina." },
      { en: "Make the 20-minute grace-window call to the office — no doctor's note required.", es: "Haga la llamada de gracia de 20 minutos a la oficina — no se requiere nota médica." },
      { en: "Call the office in the morning at the time you should already be on the job.", es: "Llame a la oficina en la mañana a la hora que ya debería estar en el trabajo." },
      { en: "Just do not show up — the office and dispatch will eventually figure it out.", es: "Simplemente no se presente — la oficina y despacho lo descifrarán eventualmente." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-10-pto-request",
    moduleId: "phes-policies",
    prompt: { en: "You want PTO for next Friday (nine days from now). What do you do?", es: "Quiere PTO para el próximo viernes (a nueve días de hoy). ¿Qué hace?" },
    options: [
      { en: "Text your direct manager privately to let them know you need the day off.", es: "Envíe mensaje directo al gerente privadamente para avisar que necesita el día." },
      { en: "Submit PTO through MaidCentral/Qleno AND confirm with the office 7 days out.", es: "Envíe PTO por MaidCentral/Qleno Y confirme con la oficina con 7 días de anticipación." },
      { en: "Call the office Friday morning when you are supposed to be at the first job.", es: "Llame a la oficina el viernes en la mañana cuando deba estar en el primer trabajo." },
      { en: "Tell a teammate to relay the request to the office team for you that week.", es: "Pídale a un compañero que pase la solicitud al equipo de la oficina por usted." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-11-unexcused-fourth",
    moduleId: "phes-policies",
    prompt: { en: "Your PLAWA bank is exhausted, so absences now count on the discipline scale. What does the SECOND unexcused occurrence in your benefit year trigger?", es: "Su banco de PLAWA está agotado, así que las ausencias ahora cuentan en la escala de disciplina. ¿Qué activa la SEGUNDA ocurrencia injustificada en su año de beneficios?" },
    options: [
      { en: "A recorded note with no further action.", es: "Una nota registrada sin acción adicional." },
      { en: "A first written warning and coaching.", es: "Una primera advertencia por escrito y orientación." },
      { en: "A final written warning is issued.", es: "Se emite una advertencia final por escrito." },
      { en: "An automatic termination that same day.", es: "Una terminación automática ese mismo día." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pp-12-pto-plawa-distinct",
    moduleId: "phes-policies",
    prompt: { en: "Which of the following is TRUE about PTO and PLAWA?", es: "¿Cuál de los siguientes es VERDADERO sobre el PTO y PLAWA?" },
    options: [
      { en: "PTO and PLAWA share a single 40-hour bank you can draw from for any reason.", es: "El PTO y PLAWA comparten un solo banco de 40 horas del que dispone por cualquier razón." },
      { en: "PLAWA fully replaces PTO once you reach your 2-year service anniversary at Phes.", es: "PLAWA reemplaza al PTO por completo al llegar a su aniversario de 2 años en Phes." },
      { en: "Two SEPARATE benefits — PLAWA covers same-day call-offs; PTO needs 7-day notice.", es: "Dos beneficios SEPARADOS — PLAWA cubre llamadas el mismo día; PTO requiere 7 días aviso." },
      { en: "You must exhaust all your PTO hours before you are allowed to touch any PLAWA.", es: "Debe agotar todas las horas de PTO antes de poder tocar PLAWA." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pp-13-emergency-911",
    moduleId: "phes-policies",
    prompt: { en: "You're mid-clean when a household member suffers a serious medical emergency. You need to call 911 immediately. What does Phes policy say?", es: "Está a mitad de la limpieza cuando un miembro del hogar sufre una emergencia médica seria. Necesita llamar al 911 inmediatamente. ¿Qué dice la política de Phes?" },
    options: [
      { en: "Step outside and try to call the office first; only dial 911 if the office agrees.", es: "Salga e intente llamar primero a la oficina; marque 911 solo si la oficina acepta." },
      { en: "Wait until the very end of the visit, then dial 911 from outside the home.", es: "Espere hasta el final de la visita, luego marque 911 desde afuera del hogar." },
      { en: "Call 911 at any time without prior authorization; notify office once it is handled.", es: "Llame al 911 en cualquier momento sin autorización previa; avise a oficina luego." },
      { en: "Have the client dial 911 themselves — you cannot use your phone during a paid shift.", es: "Pídale al cliente que marque 911 él mismo — no puede usar su teléfono durante un turno." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pp-14-phone-use",
    moduleId: "phes-policies",
    prompt: {
      en: "Mid-clean, your phone rings. It's a non-emergency call you'd like to take (your spouse, a friend, your kid's school confirming pickup). What does Phes policy require?",
      es: "A mitad de la limpieza, su teléfono suena. Es una llamada no urgente que le gustaría tomar (su cónyuge, un amigo, la escuela de su hijo confirmando recogida). ¿Qué requiere la política de Phes?",
    },
    options: [
      { en: "Answer it in place quickly, then return to cleaning.", es: "Contéstela en el lugar rápidamente, luego regrese a limpiar." },
      { en: "Step outside the home entirely, notify your teammate before stepping away, take the call briefly, then return.", es: "Salga completamente del hogar, avise a su compañero de equipo antes de salir, tome la llamada brevemente y luego regrese." },
      { en: "Move to a different room (laundry, bathroom) so the client doesn't see, then answer.", es: "Muévase a otra habitación (lavandería, baño) para que el cliente no vea, luego conteste." },
      { en: "Ignore the call. Personal calls are never allowed during a job.", es: "Ignore la llamada. Las llamadas personales nunca están permitidas durante un trabajo." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-15-photos",
    moduleId: "phes-policies",
    prompt: {
      en: "You finish a deep clean and want to post a before/after on your personal Instagram to show off your work. Is that OK?",
      es: "Termina una limpieza profunda y quiere publicar un antes/después en su Instagram personal para mostrar su trabajo. ¿Está bien?",
    },
    options: [
      { en: "Yes — post whatever you want from the job on your own personal account.", es: "Sí — publique lo que quiera del trabajo en su propia cuenta personal." },
      { en: "Yes, as long as the client's face is not clearly visible in the photo frame.", es: "Sí, mientras no se vea claramente la cara del cliente en la foto." },
      { en: "No — only photos in the company app for work documentation are allowed.", es: "No — solo se permiten fotos en la app de la compañía para documentar trabajo." },
      { en: "Yes, but blur the location pin and avoid tagging the neighborhood publicly.", es: "Sí, pero difumine la ubicación y no etiquete el vecindario públicamente." },
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
      { en: "Do both as a courtesy since dishes and beds only take an extra ten minutes.", es: "Hágalo por cortesía ya que platos y camas solo toman diez minutos extras." },
      { en: "Decline politely — dishes and beds are not Phes scope; tell the office.", es: "Decline cortésmente — platos y camas no son alcance de Phes; avise a la oficina." },
      { en: "Charge the client directly in cash on the spot for the extra unscheduled work.", es: "Cobre al cliente directamente en efectivo en el sitio por el trabajo extra." },
      { en: "Make the kids' beds (they are quick) but politely skip the dishes in the sink.", es: "Tienda las camas (son rápidas) pero rechace cortésmente lavar los platos." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-17-office-exception",
    moduleId: "phes-policies",
    prompt: {
      en: "Mid-clean, the client asks you to also wipe down the inside of their kitchen cabinets (not on today's job ticket and not on the 'Phes does NOT do' list). What's the right move?",
      es: "A mitad de la limpieza, el cliente le pide que también limpie el interior de los gabinetes de la cocina (no está en el ticket de hoy y no está en la lista de 'lo que Phes NO hace'). ¿Cuál es el paso correcto?",
    },
    options: [
      { en: "Politely agree to wipe the cabinets, do it quickly, and tell the office after.", es: "Acepte limpiar los gabinetes, hágalo rápido y avise a la oficina después." },
      { en: "Politely decline outright — Phes cannot add scope mid-clean under any circumstance.", es: "Decline rotundamente — Phes no puede agregar alcance a mitad de la limpieza." },
      { en: "Tell the client you'll call the office to ask; the office handles scope + any extra charge.", es: "Dígale al cliente que llamará a la oficina; ellos manejan alcance y cargo extra." },
      { en: "Quote a price on the spot yourself and add the work if the client verbally agrees.", es: "Cotice un precio usted mismo en el sitio y agréguelo si el cliente acepta verbalmente." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pp-18-bereavement",
    moduleId: "phes-policies",
    prompt: {
      en: "Your father passes away. What's the Phes bereavement policy?",
      es: "Su padre fallece. ¿Cuál es la política de duelo de Phes?",
    },
    options: [
      { en: "Up to 3 UNPAID scheduled workdays for immediate family; PLAWA can cover the pay.", es: "Hasta 3 días programados NO PAGADOS para familia inmediata; PLAWA puede cubrir el pago." },
      { en: "Up to 3 fully PAID scheduled workdays at your regular hourly rate of pay.", es: "Hasta 3 días programados completamente PAGADOS a su tarifa regular por hora." },
      { en: "Up to 5 paid bereavement days plus paid travel time for out-of-state services.", es: "Hasta 5 días pagados por duelo más tiempo de viaje para servicios fuera del estado." },
      { en: "Phes does not offer bereavement leave at all — use PTO or unpaid time off instead.", es: "Phes no ofrece licencia por duelo — use PTO o tiempo no pagado en su lugar." },
    ],
    correctIndex: 0,
  },
  {
    id: "q-pp-19-jury-duty",
    moduleId: "phes-policies",
    prompt: {
      en: "You receive a jury summons for next Wednesday. How does Phes handle the time and pay?",
      es: "Recibe una citación de jurado para el próximo miércoles. ¿Cómo maneja Phes el tiempo y el pago?",
    },
    options: [
      { en: "Phes pays your regular wage on jury days as long as you bring the summons in.", es: "Phes paga su salario regular en días de jurado si trae la citación a la oficina." },
      { en: "Jury leave is UNPAID by Phes; your job is protected and you keep the court pay.", es: "El servicio de jurado NO se paga por Phes; su empleo está protegido y conserva el pago de la corte." },
      { en: "You must use accumulated PTO to cover all of your scheduled jury duty days.", es: "Debe usar PTO acumulado para cubrir todos sus días de servicio de jurado." },
      { en: "Ignore the summons entirely — Phes will write a letter excusing you to the court.", es: "Ignore la citación — Phes escribirá una carta excusándolo ante la corte." },
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
      { en: "Use available PLAWA hours to cover the time spent pumping during your workday.", es: "Use horas disponibles de PLAWA para cubrir el tiempo de extracción durante el día." },
      { en: "PAID at your regular rate and they do NOT deduct from your PLAWA or PTO bank.", es: "PAGADAS a su tarifa regular y NO se descuentan de su banco de PLAWA ni PTO." },
      { en: "Unpaid 15-minute breaks only; anything longer comes out of your PTO bank.", es: "Solo pausas no pagadas de 15 minutos; cualquier extra sale de su banco de PTO." },
      { en: "Lactation breaks are not allowed during scheduled cleaning jobs at any client.", es: "Las pausas de lactancia no se permiten durante trabajos programados en ningún cliente." },
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
      { en: "100 hours — the 20 carried over from year one plus the new 80 you just earned.", es: "100 horas — las 20 acumuladas del año uno más las 80 nuevas que ganó." },
      { en: "80 hours — Phes tops your bank up to the 80-hour cap; PTO never exceeds that.", es: "80 horas — Phes rellena su banco hasta el tope de 80; PTO nunca excede eso." },
      { en: "60 hours — your remaining 20 plus a fresh 40 for the second year on top.", es: "60 horas — sus 20 restantes más 40 frescas por el segundo año." },
      { en: "40 hours — only the second-year accrual; year-one carryover is forfeited.", es: "40 horas — solo la acumulación del año dos; el carryover del año uno se pierde." },
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
      en: "You were hired on November 1 and Thanksgiving falls 3 weeks later. How does holiday pay work for you on Thanksgiving?",
      es: "Fue contratado el 1 de noviembre y Acción de Gracias cae 3 semanas después. ¿Cómo funciona el pago por feriado para usted en Acción de Gracias?",
    },
    options: [
      { en: "Full 8-hour holiday top-up applies because Phes observes Thanksgiving for everyone.", es: "Aplica el pago adicional completo de 8 horas porque Phes observa Acción de Gracias." },
      { en: "No 8-hour top-up — eligibility starts AFTER 90 days; regular pay for time worked.", es: "Sin pago adicional de 8 horas — comienza DESPUÉS de 90 días; pago regular por trabajo." },
      { en: "Half the 8-hour holiday top-up during the first 90 days, full top-up after that.", es: "La mitad del pago adicional durante los primeros 90 días, completo después de eso." },
      { en: "Only if the client cancels the visit and you would have been scheduled that day.", es: "Solo si el cliente cancela la visita y usted habría estado programado ese día." },
    ],
    correctIndex: 1,
  },
  // q-pp-24 slot repurposed (2026-05-20): the old q-pp-24-plawa-foreseeable
  // was an orphan id removed in the 2026-05-19 cleanup. Re-using the slot
  // for an add-on pricing question to bring the pool back to 40 questions.
  {
    id: "q-pp-24-add-on-pricing",
    moduleId: "phes-policies",
    prompt: {
      en: "Which of the following is an ADD-ON service (paid separately by the client, NOT included in a Standard Clean OR a Deep Clean)?",
      es: "¿Cuál de los siguientes es un servicio ADD-ON (cobrado por separado al cliente, NO incluido en una Limpieza Estándar NI en una Limpieza Profunda)?",
    },
    options: [
      { en: "Wiping down ceiling fans.", es: "Limpiar los ventiladores de techo." },
      { en: "Cleaning the inside of the refrigerator.", es: "Limpiar el interior del refrigerador." },
      { en: "Vacuuming the carpet.", es: "Aspirar la alfombra." },
      { en: "Mopping the laundry room floor.", es: "Trapear el piso del cuarto de lavado." },
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
      { en: "Phes auto-covers with the next bucket — PTO, then UPL; not unexcused if any remain.", es: "Phes cubre con la siguiente cubeta — PTO, luego UPL; no injustificada si quedan." },
      // LEGAL-REVIEW-PENDING (2026-05-20): predicate for "unexcused after PLAWA exhausted" disciplinary action.
      // Carve-out list intentionally omits FMLA + FBLA because Phes has <50 employees (both have 50-employee
      // employer threshold). "Any other federal, state, or local leave law that applies" catches anything we
      // haven't enumerated. Have an IL employment attorney bless this language before it becomes the basis
      // for any actual termination.
      { en: "Unexcused — PTO and Unpaid Personal Leave both need 7-day notice; protected leave excuses.", es: "Injustificada — PTO y UPL requieren 7 días de aviso; la licencia protegida excusa." },
      { en: "PTO is automatically deducted instead, but if PTO is also exhausted you are unexcused.", es: "Se deduce PTO automáticamente, pero si PTO también está agotado, queda injustificada." },
      { en: "Phes terminates you immediately for going over your PLAWA balance in any case.", es: "Phes lo termina inmediatamente por exceder su saldo de PLAWA en cualquier caso." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-26-unpaid-personal",
    moduleId: "phes-policies",
    prompt: {
      en: "You've used all your PLAWA and PTO but need a planned day off for your kid's school event. What's the next bucket Phes will use?",
      es: "Ha usado todo su PLAWA y PTO pero necesita un día libre planeado para un evento escolar de su hijo. ¿Cuál es la siguiente cubeta que Phes usará?",
    },
    options: [
      { en: "None — you are out of leave entirely so the day becomes an unexcused absence.", es: "Ninguna — está sin licencia por completo así que el día queda injustificado." },
      { en: "Unpaid Personal Leave (bucket #3) — up to 40 hrs/yr, day-one, needs 7-day notice.", es: "Licencia Personal No Pagada (cubeta #3) — hasta 40 hr/año, día uno, 7 días aviso." },
      { en: "Borrow PTO directly from a coworker who has unused hours left in their bank.", es: "Pídale prestado PTO directamente a un compañero que tenga horas sin usar." },
      { en: "Auto-promotion to next week's overtime hours to cover the time you missed.", es: "Promoción automática a horas extra de la próxima semana para cubrir el tiempo." },
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
      { en: "PTO first → then PLAWA → then Unpaid Personal Leave for every absence type.", es: "PTO primero → luego PLAWA → luego UPL para todo tipo de ausencia." },
      // LEGAL-REVIEW-PENDING (2026-05-20): teaches the cascade order distinguishing planned vs same-day.
      { en: "Planned: PLAWA → PTO → Unpaid Personal Leave. Same-day call-off: only PLAWA covers.", es: "Planeada: PLAWA → PTO → UPL. Llamada el mismo día: solo PLAWA cubre." },
      { en: "Whichever bucket the office picks each time based on team coverage needs.", es: "La cubeta que la oficina escoja según las necesidades de cobertura del equipo." },
      { en: "Unpaid Personal Leave first to preserve PTO; paid buckets are drawn down last.", es: "Licencia Personal No Pagada primero para preservar PTO; las pagadas al final." },
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
      { en: "Any time you call off sick more than twice within a single calendar month.", es: "Cuando llame por enfermedad más de dos veces dentro de un mes calendario." },
      // LEGAL-REVIEW-PENDING (2026-05-20): defines when an absence becomes "unexcused" for disciplinary purposes.
      { en: "No-call/no-show, OR PLAWA exhausted with no pre-approved PTO/UPL and not protected.", es: "No llamó/no se presentó, O PLAWA agotado sin PTO/UPL pre-aprobado y no protegida." },
      { en: "As soon as your accumulated PLAWA hourly balance hits zero in the benefit year.", es: "Tan pronto como su saldo de PLAWA acumulado llegue a cero en el año de beneficios." },
      { en: "Any absence that is not formally backed up by a signed doctor's note submitted in.", es: "Cualquier ausencia que no esté respaldada formalmente por una nota médica firmada." },
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
      { en: "Yes — PLAWA follows the same first-come and max-2-off rules as PTO does.", es: "Sí — PLAWA sigue las mismas reglas que el PTO (primero en llegar, máx 2 libres)." },
      { en: "No — PLAWA cannot be denied for business needs; max-2-off applies to PTO/UPL only.", es: "No — PLAWA no se puede negar por el negocio; máx-2-libres aplica solo a PTO/UPL." },
      { en: "Only if you are still inside your initial 90-day probationary employment period.", es: "Solo si está dentro de su periodo probatorio inicial de 90 días de empleo." },
      { en: "Yes, but only for same-day sick calls landing on Saturdays or Sundays each week.", es: "Sí, pero solo para llamadas por enfermedad que caigan en sábados o domingos." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-30-move-in-empty",
    moduleId: "phes-policies",
    prompt: {
      en: "You arrive at a scheduled Move-Out clean. The home is supposed to be empty but has furniture and boxes still in place. What do you do?",
      es: "Llega a una limpieza de Mudanza programada. Se supone que el hogar está vacío pero todavía tiene muebles y cajas en su lugar. ¿Qué hace?",
    },
    options: [
      { en: "Start cleaning around the furniture and stacked boxes as best you possibly can.", es: "Comience a limpiar alrededor de los muebles y cajas lo mejor que pueda." },
      { en: "STOP — call the office BEFORE starting; Move-Out cleans assume an empty home.", es: "DETÉNGASE — llame a la oficina ANTES de empezar; Mudanza asume casa vacía." },
      { en: "Move the furniture and the boxes yourself so you can clean the spots underneath.", es: "Mueva los muebles y las cajas usted mismo para limpiar los lugares debajo." },
      { en: "Reschedule the visit and leave the home without contacting the office about it.", es: "Reprograme la visita y váyase sin contactar a la oficina al respecto." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-31-plawa-default",
    moduleId: "phes-policies",
    prompt: {
      en: "You call off sick and have hours in BOTH PLAWA and PTO. Which bucket gets used?",
      es: "Llama por enfermedad y tiene horas en AMBOS PLAWA y PTO. ¿Cuál cubeta se usa?",
    },
    options: [
      { en: "PTO — it is the bigger bank and the office prefers to drain it down first.", es: "PTO — es el banco más grande y la oficina prefiere drenarlo primero." },
      { en: "PLAWA — used by default for any same-day call-off; PTO/UPL need 7-day notice.", es: "PLAWA — usado por defecto para llamadas el mismo día; PTO/UPL requieren 7 días." },
      { en: "Whichever bank currently has the larger number of unused hours remaining in it.", es: "Cualquier banco que tenga el mayor número de horas sin usar restantes en él." },
      { en: "Whichever bucket the office decides to charge against on that particular day.", es: "Cualquier cubeta que la oficina decida cobrar en ese día en particular." },
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
      { en: "Every leave bucket requires 7 days advance notice with no exceptions to the rule.", es: "Cada cubeta requiere 7 días de aviso anticipado sin excepciones a la regla." },
      { en: "PLAWA: just the 20-minute grace call. PTO and Unpaid Personal Leave: 7-day notice.", es: "PLAWA: solo la llamada de gracia de 20 minutos. PTO y UPL: 7 días de aviso." },
      { en: "A signed doctor's note is required for every single absence under every bucket.", es: "Una nota médica firmada se requiere para cada ausencia bajo cada cubeta." },
      { en: "Only the office decides per case — there are no fixed advance-notice rules at all.", es: "Solo la oficina decide caso por caso — no hay reglas fijas de aviso anticipado." },
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
      { en: "Yes — you must give a specific reason (flu, doctor visit, family illness, etc.).", es: "Sí — debe dar razón específica (gripe, cita médica, enfermedad familiar, etc.)." },
      { en: "No — you NEVER have to give a reason or documentation; the grace call is enough.", es: "No — NUNCA tiene que dar razón ni documentación; la llamada de gracia es suficiente." },
      { en: "Only if the PLAWA absence runs longer than one full scheduled workday in a row.", es: "Solo si la ausencia de PLAWA dura más de un día programado completo seguido." },
      { en: "Yes, and the reason has to be put in writing and emailed to the office team.", es: "Sí, y la razón tiene que ponerse por escrito y enviarse por correo a la oficina." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-34-protected-still-excused",
    moduleId: "phes-policies",
    prompt: {
      en: "Your PLAWA is exhausted and you have no other approved leave on the books. The very next absence is jury duty (you have a court summons). Is it unexcused?",
      es: "Su PLAWA está agotado y no tiene otra licencia aprobada en el sistema. La siguiente ausencia es servicio de jurado (tiene una citación judicial). ¿Es injustificada?",
    },
    options: [
      { en: "Yes — all three buckets are gone, so any further absence counts against you.", es: "Sí — las tres cubetas se agotaron, así que cualquier ausencia nueva cuenta." },
      { en: "No — jury duty is PROTECTED under Illinois law and is never counted as unexcused.", es: "No — el jurado es PROTEGIDO bajo la ley de Illinois y nunca cuenta como injustificada." },
      { en: "Only if you bring a signed doctor's note from the courthouse on Monday morning.", es: "Solo si trae una nota médica firmada desde el juzgado el lunes en la mañana." },
      { en: "It depends on whether two or more other cleaners are also off that same day.", es: "Depende de si dos o más otros cleaners también están libres ese mismo día." },
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
      { en: "Cleaning inside the refrigerator along with the rest of the kitchen surfaces.", es: "Limpiar dentro del refrigerador junto con el resto de las superficies de la cocina." },
      { en: "Baseboards, ceiling fans, doorknobs, patio doors, vent covers + Standard scope.", es: "Zócalos, ventiladores, pomos, puertas patio, tapas de ventilación + Estándar." },
      { en: "Cleaning inside the oven including the racks, glass door, and broiler tray underneath.", es: "Limpiar dentro del horno incluyendo rejillas, puerta de vidrio y bandeja del asador." },
      { en: "Cleaning inside the kitchen cabinets and pulling everything out to wipe the shelves.", es: "Limpiar dentro de los gabinetes y sacar todo para limpiar los estantes." },
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
      { en: "Do them both — Deep Clean covers everything inside the home anyway by definition.", es: "Hágalos ambos — Limpieza Profunda cubre todo dentro del hogar por definición." },
      { en: "Call the office to confirm $50/each add-on; add only if you have time, never quote.", es: "Llame a la oficina para confirmar add-on de $50 cada uno; agregue solo si tiene tiempo." },
      { en: "Tell the client to call the Phes office directly to request the add-ons themselves.", es: "Dígale al cliente que llame directamente a la oficina de Phes para pedir los add-ons." },
      { en: "Do them on the spot and just charge the client cash for the extra work directly.", es: "Hágalos en el sitio y solo cobre al cliente en efectivo por el trabajo extra." },
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
      { en: "Move the dresser carefully — the customer is always right in residential work.", es: "Mueva la cómoda con cuidado — el cliente siempre tiene la razón en residencial." },
      { en: "Decline politely — Phes does not lift over 25 lbs; clean around, document in app.", es: "Decline cortésmente — Phes no levanta más de 25 lb; limpie alrededor, documente en app." },
      { en: "Ask the client to move the dresser themselves while you politely wait nearby.", es: "Pídale al cliente que mueva la cómoda él mismo mientras usted espera cerca." },
      { en: "Move the dresser yourself if you think you can do it alone without an injury.", es: "Mueva la cómoda usted mismo si cree que puede solo sin sufrir una lesión." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-39-trash-bag-limit",
    moduleId: "phes-policies",
    prompt: {
      en: "A client's home has accumulated extra trash and you fill 7 bags during today's clean. What does Phes policy say?",
      es: "El hogar de un cliente ha acumulado basura extra y usted llena 7 bolsas durante la limpieza de hoy. ¿Qué dice la política de Phes?",
    },
    options: [
      { en: "Take all 7 bags out — leaving any trash behind is unprofessional for Phes work.", es: "Saque las 7 bolsas — dejar basura atrás es poco profesional para Phes." },
      { en: "Take 5 bags (the per-visit max); document the extra in the app and tell office.", es: "Saque 5 bolsas (el máximo por visita); documente lo extra en la app y avise." },
      { en: "Charge the client on the spot in cash for the extra bag-hauling beyond five bags.", es: "Cobre al cliente en efectivo en el sitio por las bolsas extras más allá de cinco." },
      { en: "Leave all 7 bags behind — clients are responsible for their own trash removal.", es: "Deje las 7 bolsas — los clientes son responsables de su propia eliminación de basura." },
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
      { en: "Offer the client a $20 discount off the price and quietly pocket the difference.", es: "Ofrezca al cliente $20 de descuento y guárdese la diferencia silenciosamente." },
      { en: "Politely say 'the office will reach out to discuss pricing,' then call them yourself.", es: "Diga cortésmente 'la oficina los contactará para hablar del precio,' luego llame usted." },
      { en: "Tell them Phes does not do any discounts and finish today's clean in silence.", es: "Dígale que Phes no hace descuentos y termine la limpieza de hoy en silencio." },
      { en: "Quote a discount on the spot yourself to keep the client happy and locked in.", es: "Cotice un descuento usted mismo en el sitio para mantener al cliente contento." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-41-parking",
    moduleId: "phes-policies",
    prompt: {
      en: "Phes covers parking while driving to or between client jobs. Which statement is TRUE about how this works?",
      es: "Phes cubre el estacionamiento al conducir hacia o entre trabajos de clientes. ¿Cuál afirmación es VERDADERA sobre cómo funciona?",
    },
    options: [
      { en: "Phes reimburses you only after you submit a paper meter receipt within seven days.", es: "Phes le reembolsa solo después de que envíe un recibo de medidor en papel dentro de siete días." },
      { en: "Use Phes-funded ParkChicago for meters and SpotHero for lots; personal use is prohibited.", es: "Use ParkChicago financiado por Phes para medidores y SpotHero para lotes; uso personal prohibido." },
      { en: "Parking is fully on the tech — find free street parking or pay completely out of pocket.", es: "El estacionamiento es 100% del técnico — busque parqueo gratis o pague de su propio bolsillo." },
      { en: "Phes pays it, and you may also use the ParkChicago app for personal weekend errands.", es: "Phes lo paga, y también puede usar la app ParkChicago para diligencias personales los fines de semana." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pp-42-supply-maintenance",
    moduleId: "phes-policies",
    prompt: {
      en: "What happens if you repeatedly run out of supplies because you failed to pick them up in advance from the office?",
      es: "¿Qué pasa si se queda sin suministros repetidamente porque no los recogió a tiempo en la oficina?",
    },
    options: [
      { en: "Nothing, as long as I eventually pick up supplies, there is no consequence.", es: "Nada, mientras eventualmente recoja los suministros, no hay consecuencia." },
      { en: "Repeated supply gaps may result in coaching, written warning, or discipline up to and including termination.", es: "Las faltas repetidas pueden resultar en coaching, advertencia por escrito o disciplina hasta e incluyendo la terminación." },
      { en: "The office will start delivering supplies to me to prevent the issue.", es: "La oficina comenzará a entregarme suministros para prevenir el problema." },
      { en: "I receive an automatic pay deduction for each missed supply pickup.", es: "Recibo una deducción automática de pago por cada recogida no realizada." },
    ],
    correctIndex: 1,
  },
  // PLAWA compliance additions (2026-07-11): NCNS weight + minimum increment.
  {
    id: "q-pp-43-ncns",
    moduleId: "phes-policies",
    prompt: {
      en: "A cleaner never contacts the office and misses the shift entirely. How is that scored on the attendance scale?",
      es: "Un cleaner nunca contacta a la oficina y pierde el turno por completo. ¿Cómo se califica en la escala de asistencia?",
    },
    options: [
      { en: "One occurrence, like any other call-off.", es: "Una ocurrencia, como cualquier otra ausencia." },
      { en: "No occurrence while PLAWA hours remain.", es: "Ninguna ocurrencia mientras queden horas de PLAWA." },
      { en: "Two occurrences for the broken notice rule.", es: "Dos ocurrencias por la regla de aviso incumplida." },
      { en: "Two occurrences only after a prior warning.", es: "Dos ocurrencias solo después de una advertencia previa." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pp-44-plawa-increment",
    moduleId: "phes-policies",
    prompt: {
      en: "An employee draws PLAWA for a one-hour late start on a full shift. How much comes out of their bank?",
      es: "Un empleado usa PLAWA por una llegada tarde de una hora en un turno completo. ¿Cuánto sale de su banco?",
    },
    options: [
      { en: "Two hours, the PLAWA minimum increment.", es: "Dos horas, el incremento mínimo de PLAWA." },
      { en: "One hour, matching the time missed.", es: "Una hora, igual al tiempo perdido." },
      { en: "Four hours, rounded to a half shift.", es: "Cuatro horas, redondeado a medio turno." },
      { en: "No hours, since lateness never draws leave.", es: "Ninguna hora, la tardanza nunca usa licencia." },
    ],
    correctIndex: 0,
  },

  // q-pp-42-w2-tip-reporting, q-pp-43-abandonment-window,
  // q-pp-44-move-in-empty-home removed in audit batch 2 (2026-05-19): all
  // were orphans — not referenced in QUESTIONS_BY_MODULE or either answer
  // key. Deleted to prevent accidental re-introduction.

  // ═════════════════════════════════════════════════════════════════════════════
  // Module 2: COMPENSATION (16 questions after 2026-05-21 alignment with handbook legal hardening: dropped q-cm-04/06/10, added q-cm-17/18/19)
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
      { en: "35% — same as a Standard residential cleaning visit at the regular client rate.", es: "35% — igual que una limpieza Estándar residencial a tarifa regular." },
      { en: "32% — Phes bills the client at $80/hr on Deep Cleans for the higher difficulty.", es: "32% — Phes factura $80/hr al cliente en Limpiezas Profundas por la dificultad." },
      { en: "20% — same flat commercial rate that applies to office buildings and store fronts.", es: "20% — la misma tarifa comercial plana que aplica a oficinas y locales comerciales." },
      { en: "40% — a premium commission rate paid out for any harder physical labor on a clean.", es: "40% — una tarifa premium de comisión pagada por cualquier trabajo físico más duro." },
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
    id: "q-cm-07-clock-in-difference",
    moduleId: "compensation",
    prompt: { en: "You arrive at 9:00 AM and Check In immediately. Your partner Checks In at 9:30 AM. How is the commission split calculated?", es: "Llega a las 9:00 AM y hace Check In de inmediato. Su compañero hace Check In a las 9:30 AM. ¿Cómo se calcula la comisión?" },
    options: [
      { en: "Always 50/50 split — same scheduled visit, same commission pool, same exact pay for each.", es: "Siempre 50/50 — misma visita, mismo grupo de comisión, mismo pago exacto para cada uno." },
      { en: "Proportionally by actual minutes on site — more time on the Job Clock means larger share.", es: "Proporcional a minutos reales en sitio — más tiempo en el Reloj de Trabajo significa mayor porción." },
      { en: "Whoever Checks Out from the job first ends up earning a larger commission share that day.", es: "Quien haga Check Out del trabajo primero termina ganando una porción de comisión mayor ese día." },
      { en: "The office team manually decides the commission split at the end of each payroll week.", es: "El equipo de la oficina decide manualmente la división de comisión al fin de cada semana." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-08-hourly-overrun",
    moduleId: "compensation",
    prompt: { en: "You're an hour into a 3-hour hourly job and you can already tell you won't finish in time. What do you do?", es: "Lleva una hora en un trabajo por hora de 3 horas y ya ve que no terminará a tiempo. ¿Qué hace?" },
    options: [
      { en: "Wait until you are in the last assigned hour, then call the office to ask for more time.", es: "Espere hasta la última hora asignada, luego llame a la oficina para pedir más tiempo." },
      { en: "Call the office right away — early, while there is still time to talk to the client.", es: "Llame a la oficina inmediatamente — temprano, mientras aún hay tiempo de hablar al cliente." },
      { en: "Skip the easier and faster rooms entirely to fit the harder ones into the allotted time.", es: "Sáltese las habitaciones más fáciles y rápidas para meter las difíciles en el tiempo asignado." },
      { en: "Just leave the job incomplete when time runs out — the office will figure it out later.", es: "Solo deje el trabajo incompleto cuando se acabe el tiempo — la oficina lo resolverá después." },
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
    id: "q-cm-11-fixit",
    moduleId: "compensation",
    prompt: { en: "A Fix-It call is dispatched to your team because of a client complaint on yesterday's job that your team performed. How is the returning original team paid for the re-clean visit on their own job?", es: "Una llamada Fix-It es enviada a su equipo por una queja del trabajo de ayer que su equipo realizó. ¿Cómo se le paga al equipo original que regresa para la visita de re-limpieza en su propio trabajo?" },
    options: [
      { en: "No additional pay. The re-clean visit is part of the original commission already earned on that job, and Quality Verification is satisfied when the re-clean is completed.", es: "Sin pago adicional. La visita de re-limpieza es parte de la comisión original ya ganada en ese trabajo, y la Verificación de Calidad se satisface cuando se completa la re-limpieza." },
      { en: "Paid normally at the standard residential commission rate again.", es: "Pago normal con la tarifa estándar de comisión residencial otra vez." },
      { en: "A 3-hour minimum at $20.00 per hour (that rate applies to a recovery tech dispatched because the original team cannot return, not to the original team's own re-clean).", es: "Un mínimo de 3 horas a $20.00 por hora (esa tarifa aplica a un técnico de recuperación enviado porque el equipo original no puede regresar, no a la re-limpieza del propio equipo original)." },
      { en: "Cash bonus on top of regular pay.", es: "Bono en efectivo sobre el pago regular." },
    ],
    correctIndex: 0,
  },
  {
    id: "q-cm-12-quality-probation",
    moduleId: "compensation",
    prompt: { en: "What triggers Quality Probation?", es: "¿Qué activa el Periodo de Prueba de Calidad?" },
    options: [
      { en: "One single client complaint of any kind received by the office within a 30-day window.", es: "Una sola queja del cliente de cualquier tipo recibida por la oficina dentro de 30 días." },
      { en: "Two valid quality complaints within a rolling 30-day window (valid per the handbook).", es: "Dos quejas válidas de calidad dentro de una ventana móvil de 30 días (válidas por el manual)." },
      { en: "Five separately documented client complaints in a single rolling calendar year overall.", es: "Cinco quejas separadas documentadas en un solo año calendario móvil en total." },
      { en: "Any negative public review the client posts online about a recent Phes cleaning visit.", es: "Cualquier reseña pública negativa que el cliente publique en línea sobre una visita." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-13-probation-pay",
    moduleId: "compensation",
    prompt: { en: "You're on Quality Probation. What's your pay structure during the 30 days?", es: "Está en Periodo de Prueba. ¿Cuál es su estructura de pago durante los 30 días?" },
    options: [
      { en: "Normal residential commission rate stays in effect — you just don't earn client tips.", es: "La tarifa normal de comisión residencial sigue vigente — solo no gana propinas de clientes." },
      { en: "$20/hr training rate, no commission, while riding along with senior team members.", es: "Tarifa de entrenamiento $20/hr, sin comisión, acompañando a miembros senior del equipo." },
      { en: "Half commission rate for all jobs during the 30-day quality probation window period.", es: "Media tarifa de comisión para todos los trabajos durante los 30 días de periodo de prueba." },
      { en: "No pay at all from Phes until you complete the full 30-day quality probation window.", es: "Sin pago alguno de Phes hasta que complete los 30 días completos del periodo de prueba." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-14-mileage",
    moduleId: "compensation",
    prompt: {
      en: "Which of the following drives IS reimbursed by Phes under the current mileage policy?",
      es: "¿Cuál de los siguientes manejos SÍ es reembolsado por Phes bajo la política actual de millaje?",
    },
    options: [
      { en: "Driving from Client A's home directly to Client B's home on the same workday.", es: "Manejar de la casa del Cliente A directamente a la casa del Cliente B el mismo día laboral." },
      { en: "Driving from your personal home to your first scheduled job of the day in the morning.", es: "Manejar de su casa personal a su primer trabajo programado del día en la mañana." },
      { en: "Driving from your last scheduled job of the day back to your own personal home address.", es: "Manejar de su último trabajo programado del día de regreso a su propia casa personal." },
      { en: "Driving to the Phes office to pick up supplies before your first scheduled client job.", es: "Manejar a la oficina de Phes a recoger suministros antes de su primer trabajo programado." },
    ],
    correctIndex: 0,
  },
  {
    id: "q-cm-15-payroll-cycle",
    moduleId: "compensation",
    prompt: { en: "How often is payroll deposited, and which workweek does a given Friday paycheck cover?", es: "¿Con qué frecuencia se deposita la nómina, y qué semana laboral cubre un cheque de un viernes determinado?" },
    options: [
      { en: "Weekly, every Friday, for the prior Sunday-through-Saturday workweek (one week behind).", es: "Semanal, cada viernes, por la semana de domingo a sábado anterior (con un semana de retraso)." },
      { en: "Biweekly, every other Friday, covering the previous two-week pay period worked at Phes.", es: "Quincenal, cada dos viernes, cubriendo el periodo de pago de dos semanas anteriores." },
      { en: "Monthly on the 1st of each calendar month for all the previous month's work completed.", es: "Mensual el día 1 de cada mes calendario por todo el trabajo del mes anterior completado." },
      { en: "Same-day in cash at the end of each shift, with W-2 reconciliation each quarter from ADP.", es: "Efectivo el mismo día al final de cada turno, con reconciliación W-2 trimestral por ADP." },
    ],
    correctIndex: 0,
  },
  {
    id: "q-cm-16-allowed-hours-math",
    moduleId: "compensation",
    prompt: {
      en: "You're solo on a 4-hour Move-Out clean billed at $80/hour ($320 total). You finish in 3.2 hours with no quality issues. How much do you earn?",
      es: "Trabaja solo en una limpieza de Mudanza de 4 horas facturada a $80/hora ($320 total). Termina en 3.2 horas sin problemas de calidad. ¿Cuánto gana?",
    },
    options: [
      { en: "$64.00 — 32% commission applied to 3.2 actual on-site hours times $80/hr rate.", es: "$64.00 — 32% de comisión aplicado a 3.2 horas reales en sitio por $80/hr." },
      { en: "$102.40 — 32% of the $320 total; commission is on the job total, not on the hours.", es: "$102.40 — 32% del total de $320; la comisión es sobre el total, no sobre las horas." },
      { en: "$80.00 — the default fallback hourly of $20/hr applied to the 4 allotted hours total.", es: "$80.00 — la tarifa de fallback de $20/hr aplicada a las 4 horas asignadas en total." },
      { en: "$57.60 — a reduced 18% commission rate paid out for fast under-budget cleans like this.", es: "$57.60 — una tarifa reducida de 18% pagada por limpiezas rápidas bajo presupuesto." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-17-recovery-tech-three-hour",
    moduleId: "compensation",
    prompt: {
      en: "A recovery technician is dispatched to fix a different team's job because the original team cannot return. The fix takes 45 minutes. How is the recovery tech paid?",
      es: "Un técnico de recuperación es enviado a corregir el trabajo de un equipo diferente porque el equipo original no puede regresar. La corrección toma 45 minutos. ¿Cómo se le paga al técnico de recuperación?",
    },
    options: [
      { en: "$15.00 — paid for the 45 actual on-site minutes at the $20/hour recovery-tech rate.", es: "$15.00 — pagado por los 45 minutos reales en sitio a la tarifa de $20/hora." },
      { en: "$60.00 — $20.00 per hour with a 3-hour minimum, regardless of how quick the fix was.", es: "$60.00 — $20.00 por hora con un mínimo de 3 horas, sin importar cuán rápida fue la corrección." },
      { en: "The standard 35% residential commission applied to the original job's full billed total.", es: "La comisión residencial estándar del 35% aplicada al total facturado del trabajo original." },
      { en: "Nothing — re-cleans are unpaid as part of Phes quality standards under the Fix-It rule.", es: "Nada — las re-limpiezas no se pagan como parte de los estándares de calidad bajo Fix-It." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-18-valid-quality-complaint",
    moduleId: "compensation",
    prompt: {
      en: "Which scenario counts as a valid quality complaint that could contribute toward Quality Probation?",
      es: "¿Cuál escenario cuenta como una queja válida de calidad que podría contribuir al Periodo de Prueba de Calidad?",
    },
    options: [
      { en: "Any client complaint received within 30 days, regardless of cause.", es: "Cualquier queja del cliente recibida dentro de 30 días, sin importar la causa." },
      { en: "A client complaint documented by the office with specific quality issues identified and photographic or written evidence, within a rolling 30-day window.", es: "Una queja del cliente documentada por la oficina con problemas específicos de calidad identificados y evidencia fotográfica o escrita, dentro de una ventana de 30 días móviles." },
      { en: "A client complaint about an item documented as exceeding the 25-pound lifting limit (correctly refused by the tech).", es: "Una queja del cliente sobre un artículo documentado como exceder el límite de levantamiento de 25 libras (correctamente rechazado por el técnico)." },
      { en: "A client complaint about office scheduling errors where the tech was not at fault.", es: "Una queja del cliente sobre errores de programación de la oficina donde el técnico no tuvo la culpa." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-19-refused-reclean-eighteen",
    moduleId: "compensation",
    prompt: {
      en: "A client calls within 24 hours unhappy with your job. You refuse to return for the re-clean without a lawful reason. What happens to your pay for the original job?",
      es: "Un cliente llama dentro de 24 horas inconforme con su trabajo. Usted rechaza regresar para la re-limpieza sin una razón legal. ¿Qué pasa con su pago por el trabajo original?",
    },
    options: [
      { en: "You keep your full commission because the job was technically completed.", es: "Mantiene su comisión completa porque el trabajo técnicamente se completó." },
      { en: "Quality Verification fails — commission is not earned, $18/hr default applies.", es: "La Verificación de Calidad falla — la comisión no se gana, aplica $18/hr por defecto." },
      { en: "Your commission is reduced by 50% as a flat quality penalty on the job.", es: "Su comisión se reduce 50% como una penalidad fija de calidad sobre el trabajo." },
      { en: "You receive no pay at all for the original job that the client complained about.", es: "No recibe pago alguno por el trabajo original sobre el que el cliente se quejó." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-20-training-redo-paid",
    moduleId: "compensation",
    prompt: {
      en: "You are in your first three weeks of training. Phes dispatches you to re-clean a job you originally worked because the client called back unhappy. How are you paid for the re-clean visit?",
      es: "Está en sus primeras tres semanas de entrenamiento. Phes lo despacha a re-limpiar un trabajo que hizo originalmente porque el cliente llamó inconforme. ¿Cómo se le paga la visita de re-limpieza?",
    },
    options: [
      { en: "The re-clean is unpaid because you are responsible for fixing your own work.", es: "La re-limpieza no se paga porque usted es responsable de corregir su propio trabajo." },
      { en: "Paid at $20.00/hr — the 3-week training window is the ONLY paid-redo period.", es: "Pagado a $20.00/hr — la ventana de 3 semanas de entrenamiento es el ÚNICO periodo de re-limpieza pagada." },
      { en: "Paid at the $18.00/hr Quality-Verification-fails default rate for time worked.", es: "Pagado a la tarifa por defecto de $18.00/hr de Verificación de Calidad fallida por el tiempo trabajado." },
      { en: "You are charged a flat $50 deduction from next paycheck for the callback visit.", es: "Se le cobra una deducción fija de $50 de su próximo pago por la visita de regreso." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cm-21-fix-it-mileage",
    moduleId: "compensation",
    prompt: {
      en: "You finish a job at Client A's home and then drive directly to Client B's home for a scheduled Fix-It call. Is the mileage reimbursable?",
      es: "Termina un trabajo en la casa del Cliente A y luego maneja directamente a la casa del Cliente B para una llamada Fix-It programada. ¿Es reembolsable el millaje?",
    },
    options: [
      { en: "Yes. The drive from Client A's home to Client B's home is between two client locations on the same workday, so it qualifies for mileage reimbursement at $0.725 per mile.", es: "Sí. El manejo de la casa del Cliente A a la del Cliente B es entre dos ubicaciones de clientes el mismo día laboral, así que califica para reembolso de millaje a $0.725 por milla." },
      { en: "No. Fix-It re-clean visits are never reimbursable for mileage no matter where the original job was located or when the visit got scheduled by the office.", es: "No. Las visitas Fix-It de re-limpieza nunca son reembolsables por millaje sin importar dónde estuviera el trabajo original o cuándo la oficina programó la visita." },
      { en: "Yes, but only at half of the standard mileage rate because Fix-It calls fall under a separate Quality Verification compensation category at Phes.", es: "Sí, pero solo a la mitad de la tarifa estándar de millaje porque las llamadas Fix-It caen en una categoría separada de Verificación de Calidad en Phes." },
      { en: "No. Phes mileage reimbursement only covers original scheduled visits, not Fix-It re-clean visits, which are part of the original commission already earned on that job.", es: "No. El reembolso de millaje de Phes solo cubre las visitas programadas originales, no las visitas Fix-It de re-limpieza, que son parte de la comisión original ya ganada." },
    ],
    correctIndex: 0,
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
      { en: "Clean wherever the bathroom looks dirtiest first, then circle back for everything else.", es: "Limpie donde el baño se vea más sucio primero, luego regrese por todo lo demás." },
      { en: "Start at the highest point and move in one consistent direction; never re-contaminate.", es: "Empiece en el punto más alto y muévase en una dirección consistente; nunca re-contamine." },
      { en: "Floors come first to clear the room, then the mirrors and glass, then the walls last.", es: "Pisos primero para despejar la habitación, luego espejos y vidrio, luego paredes al final." },
      { en: "Move in whichever direction your dominant hand prefers — speed matters more than order.", es: "Muévase en la dirección que prefiera su mano dominante — la velocidad importa más que el orden." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cb-04-dwell",
    moduleId: "cleaning-best-practices",
    prompt: { en: "Why do we spray a surface and then move to another task in the same room before wiping?", es: "¿Por qué rociamos una superficie y pasamos a otra tarea en la misma habitación antes de limpiar?" },
    options: [
      { en: "To stretch the job out so it fills the entire assigned time window allotted for it.", es: "Para estirar el trabajo y llenar la ventana de tiempo asignada por completo." },
      { en: "To let the cleaning product dwell and do its work — it wipes off faster on return.", es: "Para que el producto repose y haga su trabajo — al regresar se limpia más rápido." },
      { en: "Because the cleaning chemical actually needs UV sunlight to activate and break down dirt.", es: "Porque el químico necesita luz solar UV para activarse y descomponer la suciedad." },
      { en: "To avoid breathing in the spray fumes that come off of the product right after application.", es: "Para evitar respirar los vapores del rociador inmediatamente después de aplicarlo." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cb-05-load-caddy",
    moduleId: "cleaning-best-practices",
    prompt: { en: "You enter a bathroom and realize your glass cleaner is back in the hallway. What should you have done?", es: "Entra al baño y se da cuenta que su limpiador de vidrio quedó en el pasillo. ¿Qué debería haber hecho?" },
    options: [
      { en: "Make a quick trip back to the hallway for the glass cleaner — it is not a big deal at all.", es: "Hacer un viaje rápido al pasillo por el limpiador de vidrio — no es gran cosa." },
      { en: "Loaded your supply caddy completely before entering — every cloth, every product, one trip.", es: "Cargar el caddy completamente antes de entrar — cada paño, cada producto, un solo viaje." },
      { en: "Skip cleaning the mirror entirely on this visit — use only what you already brought in.", es: "Sáltese limpiar el espejo en esta visita — use solo lo que ya trajo consigo al baño." },
      { en: "Ask the client to lend you a bottle of household glass cleaner from their own supplies.", es: "Pídale al cliente que le preste una botella de limpiador de vidrio de sus propios suministros." },
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
      { en: "Walk straight out the same way you came in — it is the most direct route to the door.", es: "Salga caminando derecho por donde entró — es la ruta más directa a la puerta." },
      { en: "Back out from the room — never walk on a freshly mopped floor or you leave footprints.", es: "Salga de espaldas — nunca camine sobre piso recién trapeado o dejará huellas." },
      { en: "Wait inside the kitchen until the floor fully dries before stepping over it to exit.", es: "Espere dentro de la cocina hasta que el piso seque totalmente antes de salir." },
      { en: "Open a kitchen window first to speed up drying, then walk out across the wet floor.", es: "Abra una ventana primero para acelerar el secado, luego salga por el piso mojado." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cb-08-standard-not-time",
    moduleId: "cleaning-best-practices",
    prompt: { en: "What does 'clean to a standard, not to a time' mean?", es: "¿Qué significa 'limpiar a un estándar, no a un tiempo'?" },
    options: [
      { en: "Take as long as you want on the job — the actual time spent does not really matter at all.", es: "Tómese el tiempo que quiera — el tiempo gastado no importa realmente en absoluto." },
      { en: "Don't rush — finish the job correctly; efficiency comes from technique, not corners cut.", es: "No se apresure — termine correctamente; la eficiencia viene de la técnica, no de atajos." },
      { en: "Clean only the visibly dirty spots in the home; skip everything that already looks fine.", es: "Limpie solo las manchas visiblemente sucias; sáltese todo lo que ya se vea bien." },
      { en: "Skip any surface that already looks clean and only attend to the items that need attention.", es: "Sáltese cualquier superficie que ya se vea limpia y atienda solo los puntos que la necesitan." },
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
      { en: "Stop work on the lower cabinet, go back to the upper, fix the smudge, then return to lower.", es: "Pare en el inferior, regrese al superior, corrija la mancha, luego vuelva al inferior." },
      { en: "Finish the lower cabinet first, then go back; backtracking adds time and breaks flow.", es: "Termine el inferior primero, luego regrese; regresar añade tiempo y rompe el flujo." },
      { en: "Skip the smudge entirely — you already finished that cabinet, so it can stay as it is now.", es: "Sáltese la mancha — ya terminó ese gabinete, así que puede quedarse como está ahora." },
      { en: "Ask your partner to handle the upper cabinet smudge while you finish on the lower ones.", es: "Pídale a su compañero que atienda la mancha del superior mientras termina los inferiores." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-cb-15-conflict-worksheet-note",
    moduleId: "cleaning-best-practices",
    prompt: { en: "The Worksheet says 'vacuum all rugs' but the client note says 'don't move the rug under the dining table.' What do you do?", es: "La Hoja de Trabajo dice 'aspirar todas las alfombras' pero la nota del cliente dice 'no mueva la alfombra bajo la mesa del comedor.' ¿Qué hace?" },
    options: [
      { en: "Vacuum every rug in the home — the standard contracted scope always wins on conflicts.", es: "Aspire cada alfombra del hogar — el alcance contratado estándar siempre gana en conflictos." },
      { en: "Skip vacuuming entirely on the visit — the two sets of instructions are in direct conflict.", es: "Sáltese aspirar por completo en la visita — los dos juegos de instrucciones se contradicen." },
      { en: "Follow the client note — leave the dining-table rug alone, vacuum all the other rugs.", es: "Siga la nota del cliente — deje la alfombra del comedor, aspire todas las demás alfombras." },
      { en: "Ask the client mid-clean which set of instructions they would prefer you actually follow.", es: "Pregunte al cliente durante la limpieza qué instrucción prefieren que usted siga realmente." },
    ],
    correctIndex: 2,
  },

  // ═════════════════════════════════════════════════════════════════════════════
  // Module 4: MAIDCENTRAL (15 questions)
  // ═════════════════════════════════════════════════════════════════════════════
  {
    id: "q-mc-01-clock-vs-check",
    moduleId: "maidcentral",
    prompt: { en: "What is your scheduled workday at Phes?", es: "¿Cuál es su jornada laboral programada en Phes?" },
    options: [
      { en: "Only the hours of pre-scheduled jobs; I am free between them.", es: "Solo las horas de los trabajos pre-programados; entre ellos estoy libre." },
      { en: "9:00 AM to 6:00 PM on my scheduled workdays, completing assigned jobs including same-day additions.", es: "9:00 AM a 6:00 PM en mis días laborales programados, completando trabajos asignados incluyendo agregados del mismo día." },
      { en: "Whatever hours I choose each day based on my personal availability.", es: "Las horas que yo elija cada día según mi disponibilidad personal." },
      { en: "On call 9 AM to 6 PM, whether or not the office actually assigns work.", es: "De guardia de 9 AM a 6 PM, asigne o no la oficina trabajo." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-02-arrive-first-job",
    moduleId: "maidcentral",
    prompt: { en: "The office assigns you an extra 3 PM job during your scheduled workday. You refuse without a lawful or protected reason. What happens?", es: "La oficina le asigna un trabajo extra a las 3 PM durante su jornada programada. Usted lo rechaza sin razón legal o protegida. ¿Qué pasa?" },
    options: [
      { en: "Nothing happens; the office simply finds another available tech.", es: "Nada pasa; la oficina simplemente encuentra a otro técnico disponible." },
      { en: "Unexcused absence on my record; five in a Benefit Year may lead to termination.", es: "Ausencia injustificada en mi registro; cinco en un Año de Beneficios pueden llevar a terminación." },
      { en: "Verbal warning only; nothing appears on my permanent record.", es: "Solo una advertencia verbal; nada aparece en mi registro permanente." },
      { en: "I must accept every assigned job no matter the reason for refusing.", es: "Debo aceptar cada trabajo asignado sin importar la razón de rechazo." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-03-individual-clocks",
    moduleId: "maidcentral",
    prompt: { en: "You both arrive at a job at 9:00 AM. You Check In immediately. Your partner stays in the car and doesn't Check In until 9:20 AM. How is pay calculated?", es: "Ambos llegan a las 9:00 AM. Usted hace Check In de inmediato. Su compañero se queda en el auto hasta las 9:20 AM. ¿Cómo se calcula el pago?" },
    options: [
      { en: "Split 50/50 — same job, same scheduled visit, same total pay for both techs.", es: "Se divide 50/50 — mismo trabajo, misma visita programada, mismo pago." },
      { en: "MaidCentral automatically averages your individual Job Clock times together.", es: "MaidCentral promedia automáticamente sus tiempos individuales del Reloj de Trabajo." },
      { en: "Your Job Clock shows more on-site minutes, so you receive a larger commission share.", es: "Su Reloj de Trabajo muestra más minutos en sitio, recibe mayor parte de la comisión." },
      { en: "Whoever Checks Out from the job first ends up earning a higher commission split.", es: "Quien haga Check Out del trabajo primero termina ganando una comisión mayor." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-mc-04-gps-distance",
    moduleId: "maidcentral",
    prompt: { en: "You're about to Check In, but you're still in your car parked two blocks away. What should you do?", es: "Está por hacer Check In, pero aún está en su auto a dos cuadras. ¿Qué debe hacer?" },
    options: [
      { en: "Check In right now from the parked car — two blocks is close enough for GPS.", es: "Haga Check In ya desde el auto estacionado — dos cuadras es suficiente para el GPS." },
      { en: "Drive to the property and walk to the door — Check In only when physically on site.", es: "Maneje a la propiedad y camine a la puerta — Check In solo cuando esté en sitio." },
      { en: "Skip Check In entirely on this visit — GPS doesn't actually verify your location.", es: "Sáltese el Check In en esta visita — el GPS no verifica realmente su ubicación." },
      { en: "Wait until tomorrow morning and Check In retroactively from home for today's visit.", es: "Espere hasta mañana y haga Check In retroactivo desde casa por la visita de hoy." },
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
    prompt: { en: "Which of these is a lawful or protected reason to decline an assigned job?", es: "¿Cuál de las siguientes es una razón legal o protegida para declinar un trabajo asignado?" },
    options: [
      { en: "Only injuries that prevent me from driving safely to the job.", es: "Solo lesiones que me impidan conducir con seguridad al trabajo." },
      { en: "Any reason protected by federal, state, or local law (medical, PLAWA, safety, etc.).", es: "Cualquier razón protegida por la ley federal, estatal o local (médica, PLAWA, seguridad, etc.)." },
      { en: "Any reason I document in MaidCentral before I decline.", es: "Cualquier razón que documente en MaidCentral antes de declinar." },
      { en: "Only the specific categories listed in the Phes handbook.", es: "Solo las categorías específicas listadas en el manual de Phes." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-07-efficiency-target",
    moduleId: "maidcentral",
    prompt: { en: "You finish a job at 12:30 PM. Your next assigned job is at 2:00 PM. What can you do during the travel time?", es: "Termina un trabajo a las 12:30 PM. Su siguiente trabajo asignado es a las 2:00 PM. ¿Qué puede hacer durante el tiempo de viaje?" },
    options: [
      { en: "Drive directly to the next job with no stops for any reason.", es: "Manejar directamente al siguiente trabajo sin paradas por ninguna razón." },
      { en: "Completely off duty; no obligation to answer office calls at all.", es: "Completamente fuera de servicio; sin obligación de contestar a la oficina." },
      { en: "Brief personal stops OK if I arrive on time and stay reachable about assignments.", es: "Paradas personales breves OK si llego a tiempo y permanezco disponible sobre asignaciones." },
      { en: "Clock back in to record the travel time as paid working hours.", es: "Hacer Clock In otra vez para registrar el tiempo de viaje como horas pagadas." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-mc-08-forgot-checkout",
    moduleId: "maidcentral",
    prompt: { en: "You realize you forgot to Check Out of your last job two hours ago. What's the right way to fix it?", es: "Se da cuenta que olvidó hacer Check Out hace dos horas. ¿Cómo lo corrige?" },
    options: [
      { en: "Text your direct manager privately with the missed time and the job that you finished.", es: "Envíe mensaje privado a su gerente con el tiempo perdido y el trabajo terminado." },
      { en: "DM the Phes office team on Slack with the missed Check Out time and the job details.", es: "Envíe DM al equipo de Phes en Slack con el tiempo perdido y los detalles." },
      { en: "Submit a Clock/Job Change Request in MaidCentral — the office reviews and approves it.", es: "Envíe un Clock/Job Change Request en MaidCentral — la oficina revisa y aprueba." },
      { en: "Don't worry about it — payroll will figure it out automatically from the GPS data.", es: "No se preocupe — la nómina lo resolverá automáticamente desde los datos del GPS." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-mc-09-travel-pay",
    moduleId: "maidcentral",
    prompt: { en: "Which of the following drives is reimbursed by Phes under the mileage policy?", es: "¿Cuál de los siguientes manejos es reembolsado por Phes bajo la política de millaje?" },
    options: [
      { en: "Driving from your home to your first job of the day.", es: "Manejar de su casa a su primer trabajo del día." },
      { en: "Driving from Client A's home directly to Client B's home on the same workday at the IRS standard mileage rate.", es: "Manejar de la casa del Cliente A directamente a la casa del Cliente B en el mismo día laboral a la tarifa estándar de millaje del IRS." },
      { en: "Driving from your last job of the day back to your home.", es: "Manejar de su último trabajo del día de regreso a su casa." },
      { en: "Driving to the Phes office to pick up supplies before your first job.", es: "Manejar a la oficina de Phes para recoger suministros antes de su primer trabajo." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-10-commute-not-paid",
    moduleId: "maidcentral",
    prompt: { en: "You arrive at your assigned client's property. What is the correct MaidCentral action at the moment of arrival?", es: "Llega a la propiedad de su cliente asignado. ¿Cuál es la acción correcta en MaidCentral al momento de llegar?" },
    options: [
      { en: "Clock In first, then wait 5 minutes before Check In to make sure GPS picks up the location.", es: "Hacer Clock In primero, luego esperar 5 minutos antes de Check In para que el GPS detecte la ubicación." },
      { en: "Clock In and Check In together at the moment of arrival. Repeat at every assigned job throughout the workday.", es: "Hacer Clock In y Check In juntos al momento de llegar. Repita en cada trabajo asignado durante toda la jornada laboral." },
      { en: "Only Check In; the Clock part happens automatically when you Check In to a job.", es: "Solo Check In; la parte del Clock pasa automáticamente cuando hace Check In en un trabajo." },
      { en: "Wait until the client greets you, then Clock In and Check In separately a few minutes apart.", es: "Esperar a que el cliente le salude, luego hacer Clock In y Check In por separado con unos minutos de diferencia." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-11-end-of-day",
    moduleId: "maidcentral",
    prompt: { en: "You are at the client's front door but MaidCentral rejects your Check In with a GPS warning. What do you do?", es: "Está en la puerta del cliente pero MaidCentral rechaza el Check In con advertencia de GPS. ¿Qué hace?" },
    options: [
      { en: "Skip the Check In and enter the arrival time later from memory.", es: "Sáltese el Check In e ingrese la hora después de memoria." },
      { en: "Take a timestamped door photo and call the office for manual approval.", es: "Tome una foto de la puerta con hora y llame a la oficina para aprobación manual." },
      { en: "Drive around the block and retry until the GPS check accepts it.", es: "Maneje alrededor de la cuadra y reintente hasta que el GPS lo acepte." },
      { en: "Tell the client there is a system problem and reschedule the visit.", es: "Dígale al cliente que hay un problema del sistema y reprograme la visita." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-12-conflict-note",
    moduleId: "maidcentral",
    prompt: { en: "The Worksheet and a client note give different instructions for the same item. Who wins?", es: "La Hoja de Trabajo y una nota del cliente dan instrucciones diferentes. ¿Cuál gana?" },
    options: [
      { en: "Worksheet always wins on every conflict — it is the standard contracted scope.", es: "La Hoja siempre gana en cada conflicto — es el alcance estándar contratado." },
      { en: "Client note wins on the specific item; the rest of the Worksheet still applies.", es: "La nota del cliente gana en lo específico; el resto de la Hoja sigue aplicando." },
      { en: "Whichever document you happen to read first when you walk into the home today.", es: "Cualquier documento que lea primero cuando entre al hogar el día de hoy." },
      { en: "Ask the client during the clean to clarify which instruction they actually want followed.", es: "Pregunte al cliente durante la limpieza qué instrucción quieren que se siga." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-13-commercial-finished-early",
    moduleId: "maidcentral",
    prompt: { en: "Your commercial job is assigned 3 hours. You finish in 1.5 hours. What do you do BEFORE uploading completion photos?", es: "Su trabajo comercial tiene 3 horas asignadas. Termina en 1.5 horas. ¿Qué hace ANTES de subir fotos?" },
    options: [
      { en: "Upload the completion photos right away — finishing the job early is generally good.", es: "Suba las fotos de completado de inmediato — terminar temprano generalmente es bueno." },
      { en: "Call the office to confirm before closing — Prorate Employee Pay may cut your hours.", es: "Llame a la oficina a confirmar antes de cerrar — Prorate Employee Pay puede reducir." },
      { en: "Just Clock Out for the entire day immediately since you have finished all your work.", es: "Solo haga Clock Out del día completo ya que terminó todo su trabajo asignado." },
      { en: "Sit in the parking lot for an extra 1.5 hours until the 3-hour window has passed.", es: "Quédese en el estacionamiento 1.5 horas extras hasta que pase la ventana de 3 horas." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-14-qleno-coming",
    moduleId: "maidcentral",
    prompt: { en: "What is Qleno's relationship to MaidCentral at Phes?", es: "¿Cuál es la relación de Qleno con MaidCentral en Phes?" },
    options: [
      { en: "Qleno is an entirely separate company that has no operational relationship to Phes.", es: "Qleno es una compañía totalmente aparte sin relación operativa con Phes." },
      { en: "Qleno is the company's own platform that will replace MaidCentral in coming months.", es: "Qleno es la plataforma propia de la compañía que reemplazará MaidCentral en meses." },
      { en: "Qleno is a backup app that only gets used in emergencies when MaidCentral is offline.", es: "Qleno es una app de respaldo que solo se usa en emergencias cuando MaidCentral está caído." },
      { en: "Qleno is purely a customer-facing booking website with no internal tech-side function.", es: "Qleno es puramente un sitio de reservas para clientes sin función interna para técnicos." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-15-day-clock-running",
    moduleId: "maidcentral",
    prompt: { en: "You finish your assigned job. What is the correct MaidCentral action the moment the job is complete?", es: "Termina su trabajo asignado. ¿Cuál es la acción correcta en MaidCentral al momento que el trabajo esté completo?" },
    options: [
      { en: "Stay clocked in until you arrive at the next assigned job.", es: "Permanezca con Clock In hasta llegar al siguiente trabajo asignado." },
      { en: "Clock Out and Check Out together at the moment of completion.", es: "Haga Clock Out y Check Out juntos al momento de finalizar." },
      { en: "Only Clock Out; Check Out happens automatically at the next job.", es: "Solo Clock Out; el Check Out se hace automáticamente en el siguiente trabajo." },
      { en: "Wait for the client to sign completion, then Clock Out from your car.", es: "Espere a que el cliente firme la finalización, luego haga Clock Out desde el auto." },
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
      { en: "On a green microfiber cloth, then wipe in S-pattern", es: "En paño de microfibra verde, luego patrón en S" },
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
      { en: "Soap and water diluted in a clean spray bottle for general light cleaning use.", es: "Jabón y agua diluidos en una botella limpia para limpieza ligera general." },
      { en: "Bar Keepers Friend powder applied with a damp non-abrasive sponge to the area.", es: "Polvo Bar Keepers Friend aplicado con una esponja no abrasiva húmeda al área." },
      { en: "Ammonia-based products like Windex — mixing the two creates toxic chloramine vapors.", es: "Productos con amoníaco como Windex — mezclar ambos crea vapores tóxicos de cloramina." },
      { en: "Pumice stone used dry directly on the dampened bathroom surface being treated.", es: "Piedra pómez usada seca directamente sobre la superficie del baño humedecida." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pt-06-zep-fabric",
    moduleId: "products-tools",
    prompt: { en: "You're spraying Zep Mold & Mildew on shower caulk. The client's blue bath mat is a few feet away. What's the risk?", es: "Está rociando Zep Mold & Mildew en el sellador de la ducha. El tapete azul del cliente está a pocos pies. ¿Cuál es el riesgo?" },
    options: [
      { en: "No risk at all — Zep Mold & Mildew is safe to overspray on colored bath fabrics.", es: "Sin riesgo — Zep Mold & Mildew es seguro para rociar sobre telas de baño de color." },
      { en: "Zep contains bleach — overspray permanently bleaches the colored mat; move it first.", es: "Zep contiene cloro — la sobreaspersión decolora permanentemente el tapete de color." },
      { en: "Zep will only visibly stain dark fabrics; light colors like blue are not affected.", es: "Zep solo manchará visiblemente telas oscuras; los colores claros como azul no se afectan." },
      { en: "Zep evaporates completely before any droplets can drift over to reach the bath mat.", es: "Zep se evapora completamente antes de que las gotas lleguen al tapete del baño." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pt-07-magic-eraser-paint",
    moduleId: "products-tools",
    prompt: { en: "The client asks you to remove a small scuff from a matte-painted living room wall. What do you do?", es: "El cliente le pide remover una marca pequeña de una pared de sala con pintura mate. ¿Qué hace?" },
    options: [
      { en: "Use a Magic Eraser with firm pressure to fully remove the scuff from the wall surface.", es: "Use el Borrador Mágico con presión firme para remover por completo la marca de la pared." },
      { en: "Test the Magic Eraser hidden first; matte paint can DULL — sometimes leave the scuff alone.", es: "Pruebe el Borrador Mágico oculto; en pintura mate puede DAÑAR — a veces deje la marca." },
      { en: "Use #0000 extra-fine steel wool with a light circular motion to lift the wall scuff off.", es: "Use lana de acero #0000 extra fina con movimiento circular ligero para levantar la marca." },
      { en: "Wipe the scuff away with Bar Keepers Friend powder and a damp non-abrasive sponge today.", es: "Limpie la marca con polvo Bar Keepers Friend y esponja no abrasiva húmeda hoy." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pt-08-magic-eraser-glass",
    moduleId: "products-tools",
    prompt: { en: "Where IS a Magic Eraser a great tool to use?", es: "¿Dónde SÍ es buena herramienta el Borrador Mágico?" },
    options: [
      { en: "Polished marble kitchen countertops with mild soap scum and dried fingerprints on top.", es: "Mostradores de mármol pulido con sarro suave y huellas digitales secas encima." },
      { en: "Brushed stainless-steel appliance fronts marked by fingerprints and minor water spots.", es: "Frentes de acero inoxidable cepillado con huellas digitales y manchas menores de agua." },
      { en: "Soap scum on glass shower doors and scuff marks on white painted baseboards.", es: "Sarro en puertas de ducha de vidrio y marcas en rodapiés pintados de blanco." },
      { en: "Chrome bathroom faucets with stuck mineral deposits and hard-water spotting overall.", es: "Llaves cromadas con depósitos minerales pegados y manchas de agua dura por todas partes." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pt-09-pumice-where",
    moduleId: "products-tools",
    prompt: { en: "Where is the ONLY surface where pumice stone is appropriate?", es: "¿Cuál es la ÚNICA superficie apropiada para la piedra pómez?" },
    options: [
      { en: "Inside an unsealed white porcelain toilet bowl, on stubborn hard-water rings.", es: "Dentro de un inodoro de porcelana blanca sin sellar, en anillos de agua dura." },
      { en: "On fiberglass tub surfaces to scrub away built-up soap scum on the walls and floor.", es: "En superficies de tina de fibra de vidrio para tallar el sarro acumulado en paredes y piso." },
      { en: "On chrome bathroom faucets where stuck mineral deposits won't come off with cleaner.", es: "En llaves cromadas donde los depósitos minerales pegados no salen con limpiador." },
      { en: "On smooth glass cooktops with cooked-on food residue that other tools cannot remove.", es: "En estufas de vidrio liso con residuos de comida cocidos que otros productos no pueden." },
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
      { en: "Yes — #0000 grade steel wool is fully safe to use on all bathroom metal fixtures.", es: "Sí — la lana de acero grado #0000 es segura en todos los herrajes metálicos del baño." },
      { en: "No — even #0000 dulls chrome on first pass; use Bar Keepers Friend with soft cloth.", es: "No — incluso #0000 daña el cromo al primer pase; use Bar Keepers Friend con paño suave." },
      { en: "Yes — but only when used with plain water and absolutely no separate cleaning product.", es: "Sí — pero solo cuando se usa con agua pura y sin ningún producto limpiador separado." },
      { en: "Yes — chrome is actually the recommended surface for steel-wool scrubbing on this kit.", es: "Sí — el cromo es la superficie recomendada para tallar con lana de acero en este kit." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pt-13-cloth-cross",
    moduleId: "products-tools",
    prompt: { en: "You're in a bathroom and your white cloth gets dirty. You finish the bathroom and head to the kitchen. Can you keep using the same white cloth?", es: "Está en un baño y su paño blanco se ensució. Termina el baño y va a la cocina. ¿Puede seguir usando el mismo paño blanco?" },
    options: [
      { en: "Yes — Phes-issued white cloths are general-purpose and approved across every room.", es: "Sí — los paños blancos de Phes son de uso general aprobados en cada habitación." },
      { en: "No — white is bathroom-only; cross-contamination into a kitchen is a major hygiene fail.", es: "No — el blanco es solo de baño; la contaminación cruzada a la cocina es falla de higiene." },
      { en: "Yes, but only if you fully rinse the cloth out in hot water at the bathroom sink first.", es: "Sí, pero solo si enjuaga el paño completamente en agua caliente en el lavabo primero." },
      { en: "Yes, but only if you turn the dirty cloth over and use the still-clean opposite side.", es: "Sí, pero solo si voltea el paño sucio y usa el lado opuesto que aún está limpio." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pt-14-step-stool",
    moduleId: "products-tools",
    prompt: { en: "Before using the company step stool, what's the 3-point check?", es: "Antes de usar el banquito de la compañía, ¿cuál es la revisión de 3 puntos?" },
    options: [
      { en: "Color of the rubber feet, manufacturer brand, and approximate age of the step stool.", es: "Color de las patas de goma, marca del fabricante y edad aproximada del banquito." },
      { en: "Rubber feet present (not worn), hinges fully locked open, platform clean and dry.", es: "Patas de goma presentes (no lisas), bisagras totalmente abiertas, plataforma limpia y seca." },
      { en: "Maximum weight rating, total height from floor, and date of original manufacture label.", es: "Peso máximo, altura total del piso y fecha de fabricación original en la etiqueta." },
      { en: "It honestly does not matter much — just unfold the step stool quickly and use it as is.", es: "Honestamente no importa mucho — solo desdoble el banquito rápidamente y úselo así." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-pt-15-furniture-stand",
    moduleId: "products-tools",
    prompt: { en: "You can't reach a high shelf even from the company step stool. What do you do?", es: "No puede alcanzar un estante alto ni con el banquito de la compañía. ¿Qué hace?" },
    options: [
      { en: "Stand on a sturdy dining-room chair just for a quick moment to reach the high shelf.", es: "Párese en una silla firme del comedor un momento rápido para alcanzar el estante alto." },
      { en: "Climb onto the kitchen counter and stand on it briefly to reach the high shelf today.", es: "Súbase al mostrador de cocina y párese brevemente para alcanzar el estante alto hoy." },
      { en: "Leave a note for the office and skip the surface — never stand on client furniture.", es: "Deje nota para la oficina y sáltese la superficie — nunca se pare en muebles del cliente." },
      { en: "Stand carefully on the very top step of the step stool to reach a couple more inches up.", es: "Párese con cuidado en el escalón superior del banquito para alcanzar unas pulgadas más." },
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
      { en: "Only a direct supervisor making physical contact with a subordinate employee.", es: "Solo un supervisor directo haciendo contacto físico con un empleado subordinado." },
      { en: "Any unwelcome sexual conduct that creates a hostile workplace OR ties to a decision.", es: "Cualquier conducta sexual no deseada que cree ambiente hostil O se ligue a una decisión." },
      { en: "Only conduct that actually happens during scheduled paid working hours at a job.", es: "Solo conducta que ocurre durante horas laborales pagadas y programadas en el trabajo." },
      { en: "Only behavior that the target verbally and clearly objects to at the time it happens.", es: "Solo conducta que el objetivo objete verbal y claramente en el momento que ocurre." },
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
      { en: "A coworker tells off-color jokes one time loudly in the break room at lunch.", es: "Un compañero cuenta chistes subidos de tono una vez en el descanso del almuerzo." },
      { en: "A supervisor tells you that you'll get better routes if you go out on a date.", es: "Un supervisor le dice que tendrá mejores rutas si sale en una cita con él/ella." },
      { en: "A client at one of your scheduled jobs sincerely compliments your hair today.", es: "Un cliente en uno de sus trabajos programados elogia sinceramente su cabello hoy." },
      { en: "A coworker repeatedly asks you out for coffee after work and you said yes each time.", es: "Un compañero le pide salir a tomar café varias veces y usted aceptó cada vez." },
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
      { en: "No — Illinois law protects only between people of opposite sexes from each other.", es: "No — la ley de Illinois protege solo entre personas de sexos opuestos entre sí." },
      { en: "Yes — Illinois law protects regardless of sex, gender identity, expression, or orientation.", es: "Sí — la ley de Illinois protege sin importar sexo, identidad de género, expresión u orientación." },
      { en: "Only if both parties happen to identify as LGBTQ at the time of the incident.", es: "Solo si ambas partes se identifican como LGBTQ al momento del incidente." },
      { en: "Only in private-sector workplaces — public employers operate under different rules.", es: "Solo en lugares de trabajo privados — los empleadores públicos siguen reglas distintas." },
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
      { en: "No — clients are not employees, so there is nothing Phes can do about it.", es: "No — los clientes no son empleados, así que no hay nada que Phes pueda hacer." },
      { en: "Yes — Phes must investigate third-party harassment same as coworker; leave if unsafe.", es: "Sí — Phes debe investigar acoso de terceros igual que de compañero; salga si no es seguro." },
      { en: "Only if that client also happens to be a Phes supervisor or office team member.", es: "Solo si ese cliente también es un supervisor o miembro del equipo de Phes." },
      { en: "Only if the inappropriate comment from the client was put down in writing somewhere.", es: "Solo si el comentario inapropiado del cliente está por escrito en algún lugar." },
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
      { en: "Only directly to Sal the owner in person — no other channel is accepted at all.", es: "Solo directamente al dueño Sal en persona — ningún otro canal se acepta en absoluto." },
      { en: "Internally: office team or owner directly. Externally: Illinois IDHR or the federal EEOC.", es: "Internamente: equipo de oficina o dueño directamente. Externamente: IDHR de Illinois o EEOC federal." },
      { en: "You must use the company app for all reports — verbal reports are not accepted.", es: "Debe usar la app de la compañía para todos los reportes — los reportes verbales no se aceptan." },
      { en: "Only a licensed attorney is allowed to file a sexual harassment report on your behalf.", es: "Solo un abogado licenciado puede presentar un reporte de acoso sexual en su nombre." },
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
      { en: "Yes — schedules and route assignments are fully at the management's discretion.", es: "Sí — los horarios y asignaciones de rutas son totalmente a discreción de la gerencia." },
      { en: "No — federal and Illinois law strictly prohibit retaliation for good-faith reports.", es: "No — la ley federal y de Illinois prohíben estrictamente las represalias por reportes de buena fe." },
      { en: "Only if the supervisor openly admits that the schedule cut was a retaliation move.", es: "Solo si el supervisor admite abiertamente que el recorte fue una represalia." },
      { en: "Only if you mentioned the supervisor by name within the original harassment report.", es: "Solo si mencionó al supervisor por nombre dentro del reporte original de acoso." },
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
      { en: "No — only the person directly targeted by the conduct is allowed to make a report.", es: "No — solo la persona directamente objetivo de la conducta puede hacer un reporte." },
      { en: "Yes — bystanders can and should report; same protections as direct reports apply.", es: "Sí — los testigos pueden y deben reportar; aplican las mismas protecciones que directos." },
      { en: "Only if you secretly recorded the conversation with audio or video evidence first.", es: "Solo si grabó secretamente la conversación con evidencia de audio o video primero." },
      { en: "Only if the actual target of the conduct explicitly asks you to file the report.", es: "Solo si el objetivo real de la conducta le pide explícitamente que presente el reporte." },
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
      { en: "30 days from the date the harassment incident occurred at your workplace.", es: "30 días desde la fecha en que ocurrió el incidente de acoso en su lugar de trabajo." },
      { en: "180 days from the date the harassment incident occurred at your workplace.", es: "180 días desde la fecha en que ocurrió el incidente de acoso en su lugar de trabajo." },
      { en: "300 days — Illinois is a deferral state so the federal deadline extends to 300.", es: "300 días — Illinois es estado de derechos diferidos, el plazo federal se extiende a 300." },
      { en: "There is no deadline — you can file an EEOC charge at any point in the future.", es: "No hay plazo — puede presentar un cargo en la EEOC en cualquier momento futuro." },
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
      { en: "Once at the time of hire, then never again for the duration of employment.", es: "Una vez al momento de contratar, luego nunca más durante el empleo." },
      { en: "Every calendar year — every employee, every January (Phes refreshes annually).", es: "Cada año calendario — cada empleado, cada enero (Phes actualiza anualmente)." },
      { en: "Every five years on a rolling cycle from the original hire date of the employee.", es: "Cada cinco años en un ciclo rotativo desde la fecha original de contratación del empleado." },
      { en: "Only when there is a formally reported incident that requires retraining of the team.", es: "Solo cuando hay un incidente reportado formalmente que requiere recapacitación del equipo." },
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
      { en: "Yes — a single isolated incident is never legally considered sexual harassment.", es: "Sí — un solo incidente aislado nunca se considera legalmente acoso sexual." },
      { en: "No — one severe incident is enough; otherwise must be severe or pervasive overall.", es: "No — un incidente severo es suficiente; si no, debe ser severo o generalizado." },
      { en: "Only after at least three separately documented incidents involving the same person.", es: "Solo después de al menos tres incidentes documentados con la misma persona." },
      { en: "Only if the conduct happens during your scheduled paid working hours on a job.", es: "Solo si la conducta ocurre durante sus horas laborales pagadas y programadas." },
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
      { en: "No — once you have been intimate before, you cannot later claim harassment from them.", es: "No — una vez tenida intimidad antes, no puede luego reclamar acoso de esa persona." },
      { en: "Yes — past or current consensual conduct never waives your right to refuse new advances.", es: "Sí — la conducta consensuada pasada o actual no le quita el derecho de rechazar nuevas insinuaciones." },
      { en: "Only if you previously signed a formal no-fraternization policy with the company.", es: "Solo si firmó previamente una política formal de no-confraternización con la compañía." },
      { en: "Only if the coworker happens to be in a direct reporting relationship to you on the team.", es: "Solo si el compañero está en una relación de reporte directo con usted en el equipo." },
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
      { en: "Nothing — Phes is not legally obligated to act on the report or open any investigation.", es: "Nada — Phes no está legalmente obligado a actuar sobre el reporte ni investigar." },
      { en: "Prompt documented investigation, confidentiality, no forced confrontation, outcome update.", es: "Investigación documentada rápida, confidencialidad, sin confrontación forzada, actualización." },
      { en: "A mandatory public meeting between you and the accused harasser to resolve the issue.", es: "Una reunión pública obligatoria entre usted y el acusado para resolver el asunto." },
      { en: "An immediate same-day decision with no investigation and no documented findings at all.", es: "Una decisión inmediata el mismo día sin investigación ni hallazgos documentados." },
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
      { en: "No — only reports that the investigation ultimately substantiates are protected.", es: "No — solo los reportes que la investigación finalmente comprueba están protegidos." },
      { en: "Yes — good faith means you believed the report was true; protection is outcome-independent.", es: "Sí — buena fe significa que lo creyó verdadero; la protección es independiente del resultado." },
      { en: "Only if you originally submitted the report in writing rather than verbally to office.", es: "Solo si presentó originalmente el reporte por escrito en lugar de verbalmente a oficina." },
      { en: "Only if the accused person eventually agrees in writing that you reported in good faith.", es: "Solo si la persona acusada eventualmente acepta por escrito que usted reportó de buena fe." },
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
      { en: "Yes. Every new hire is drug-tested before their first scheduled shift.", es: "Sí. Cada nuevo empleado pasa prueba de drogas antes de su primer turno." },
      { en: "No. Phes does not require pre-employment drug testing for any role at hire.", es: "No. Phes no exige prueba de drogas antes del empleo para ningún rol." },
      { en: "Only for techs over 25 because of insurance-rate considerations.", es: "Solo para técnicos mayores de 25 años por razones de seguros." },
      { en: "Only for techs whose role requires regular driving between client jobs.", es: "Solo para técnicos cuyo rol requiere conducir entre trabajos de clientes." },
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
      { en: "Yes. Any cannabis use is a violation, even off-duty and lawful at home.", es: "Sí. Cualquier uso de cannabis es una violación, incluso fuera del trabajo." },
      { en: "No. The policy applies only to observable impairment at work, not lawful use.", es: "No. La política aplica solo a intoxicación observable en el trabajo, no al uso legal." },
      { en: "Yes if you happened to test positive on a random screen the next week.", es: "Sí, si dio positivo en una prueba al azar la semana siguiente." },
      { en: "Yes only if the client smelled cannabis on you during the home visit.", es: "Sí, solo si el cliente olió cannabis en usted durante la visita al hogar." },
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
      { en: "Slurred speech combined with unsteady walking observed at the job site.", es: "Habla arrastrada combinada con caminar inestable en el lugar de trabajo." },
      { en: "Bloodshot eyes plus the smell of cannabis on your breath at the site.", es: "Ojos rojos más olor a cannabis en su aliento en el sitio del trabajo." },
      { en: "A positive drug test alone, with no observable signs at the job site.", es: "Una prueba positiva sola, sin signos observables en el lugar de trabajo." },
      { en: "Falling asleep on the job during normal scheduled work hours.", es: "Quedarse dormido en el trabajo durante las horas regulares programadas." },
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
      { en: "Coworkers can directly request that another tech be drug-tested.", es: "Los compañeros pueden directamente pedir que se haga prueba a otro técnico." },
      { en: "A supervisor documents observable signs and the OFFICE decides on testing.", es: "Un supervisor documenta signos observables y la OFICINA decide la prueba." },
      { en: "The client of the home decides whether the tech should be tested.", es: "El cliente del hogar decide si se debe hacer la prueba al técnico." },
      { en: "Whoever is in charge at the moment decides without written documentation.", es: "Quien esté a cargo decide sin documentación escrita del incidente." },
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
      { en: "Yes. Any property damage at a client site automatically triggers a test.", es: "Sí. Cualquier daño a la propiedad en un sitio activa una prueba automáticamente." },
      { en: "No. Testing triggers on physical injury OR property damage of $500 or more.", es: "No. Se activa por lesión física O daño a propiedad de $500 o más." },
      { en: "Yes, but only if a supervisor personally saw the accident happen on site.", es: "Sí, pero solo si un supervisor vio personalmente ocurrir el accidente en sitio." },
      { en: "Yes, but only if the client formally asks for testing after the incident.", es: "Sí, pero solo si el cliente solicita formalmente la prueba después del incidente." },
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
      { en: "Tell the office your full diagnosis and the medication name before starting.", es: "Decir a la oficina su diagnóstico completo y el nombre del medicamento." },
      { en: "Inform the office BEFORE starting it that a prescribed med may impair safety.", es: "Informar a la oficina ANTES de empezar que un medicamento recetado puede afectar." },
      { en: "Stop taking the medication on workdays so it does not affect your shifts.", es: "Dejar de tomar el medicamento los días de trabajo para no afectar sus turnos." },
      { en: "Nothing — prescription medication is your private business under HIPAA law.", es: "Nada — los medicamentos recetados son su asunto privado bajo la ley HIPAA." },
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
      { en: "A written warning is issued and you continue working your normal schedule.", es: "Se emite una advertencia escrita y sigue trabajando su horario normal." },
      { en: "Immediate termination — refusal is treated the same as a positive test.", es: "Terminación inmediata — la negativa se trata igual que un positivo." },
      { en: "You may delay and take the test the following day at the same lab instead.", es: "Puede retrasar y hacer la prueba al día siguiente en el mismo laboratorio." },
      { en: "Nothing — refusing a workplace drug test is your protected legal right.", es: "Nada — rehusarse a una prueba laboral es su derecho legal protegido." },
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
      { en: "Immediate termination with no further process, warning, or assistance offered.", es: "Terminación inmediata sin más proceso, advertencia o asistencia ofrecida." },
      { en: "Final written warning, last-chance agreement signed, and EAP referral offered.", es: "Advertencia final escrita, acuerdo de última oportunidad firmado, oferta EAP." },
      { en: "Nothing because it is a first offense and the discipline scale is progressive.", es: "Nada, porque es la primera infracción y la escala de disciplina es progresiva." },
      { en: "A verbal warning only, with no formal documentation or follow-up plan.", es: "Una advertencia verbal solamente, sin documentación formal ni plan de seguimiento." },
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
      { en: "At your next quarterly performance review meeting with the office.", es: "En su próxima evaluación trimestral de desempeño con la oficina." },
      { en: "Within 72 hours — Phes carries non-owned auto insurance tied to your license.", es: "Dentro de 72 horas — Phes tiene seguro no propio ligado a su licencia." },
      { en: "Only if a client formally complains about your driving while on the job.", es: "Solo si un cliente se queja formalmente sobre su conducción en el trabajo." },
      { en: "Never — DUIs in your personal vehicle are private off-duty legal matters.", es: "Nunca — los DUIs en vehículo personal son asuntos legales privados fuera del trabajo." },
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
      { en: "No — only DUI-related suspensions need to be reported to the office.", es: "No — solo las suspensiones por DUI deben reportarse a la oficina." },
      { en: "Yes — any suspension or revocation must be reported within 72 hours.", es: "Sí — cualquier suspensión o revocación debe reportarse dentro de 72 horas." },
      { en: "Only if the office asks to see your motor vehicle record first.", es: "Solo si la oficina pide ver su récord de vehículos motorizados primero." },
      { en: "Only if a client happens to see the suspension notice in your vehicle.", es: "Solo si un cliente ve por casualidad el aviso de suspensión en su vehículo." },
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
      { en: "Clock out at the originally scheduled end time so the week's hours look consistent.", es: "Marcar salida a la hora programada para que la semana se vea consistente." },
      { en: "Clock out when you actually leave the job site — the clock must match reality.", es: "Marcar salida cuando realmente salga — el reloj debe coincidir con la realidad." },
      { en: "Clock out 15 minutes early now and add the difference to your next scheduled shift.", es: "Marcar salida 15 min antes ahora y agregar la diferencia al siguiente turno." },
      { en: "Ask a teammate to clock you out from their phone after you get back home.", es: "Pedirle a un compañero que marque su salida desde su teléfono al llegar a casa." },
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
      { en: "Yes, as long as you do not name the client by their first or last name.", es: "Sí, siempre que no nombre al cliente por su nombre o apellido completo." },
      { en: "No. What you see in a client home stays there — even private talk with coworkers.", es: "No. Lo que ve en un hogar se queda allí — incluso con compañeros en privado." },
      { en: "Only if what you saw is something genuinely concerning for the client's safety.", es: "Solo si lo que vio es algo realmente preocupante para la seguridad del cliente." },
      { en: "Yes, if you are discussing it for a legitimate workplace safety reason only.", es: "Sí, si lo discute por una razón legítima de seguridad laboral solamente." },
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
      { en: "Pocket the coins — two dollars is small enough that no one will ever notice.", es: "Guarde las monedas — dos dólares es lo suficientemente pequeño que nadie se dé cuenta." },
      { en: "Leave the coins where they are — any taken item is theft with zero tolerance.", es: "Deje las monedas donde están — tomar cualquier objeto es robo con cero tolerancia." },
      { en: "Use them to buy yourself a quick soda since the client left them out anyway.", es: "Úselas para comprarse una soda rápida ya que el cliente las dejó afuera de todas formas." },
      { en: "Pocket them and split the find evenly with your teammate on the same shift.", es: "Guárdelas y compártalas equitativamente con su compañero del mismo turno." },
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
      { en: "Stay out of it — if the affected coworker did not object, it is not your business.", es: "Manténgase al margen — si el compañero afectado no objetó, no es asunto suyo." },
      { en: "Report it to the office or the owner — Phes asks bystanders to surface harassment.", es: "Reportarlo a la oficina o al dueño — Phes pide a los testigos comunicar el acoso." },
      { en: "Tell the joking coworker privately that the jokes were not funny or appropriate.", es: "Decirle al compañero bromista en privado que las bromas no fueron graciosas ni apropiadas." },
      { en: "Post about the incident online so other Phes employees can see what happened.", es: "Publicar sobre el incidente en línea para que otros empleados de Phes vean lo ocurrido." },
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
      { en: "Whether an employee owns a personal vehicle for commuting to scheduled jobs.", es: "Si un empleado tiene un vehículo personal para ir a los trabajos programados." },
      { en: "Sexual orientation, gender identity, pregnancy, and disability are protected.", es: "Orientación sexual, identidad de género, embarazo y discapacidad están protegidos." },
      { en: "An employee's favorite sports team and weekend recreational hobbies overall.", es: "El equipo deportivo favorito y los pasatiempos de fin de semana del empleado." },
      { en: "How many scheduled hours an employee says they want to work each week.", es: "Cuántas horas programadas un empleado dice que quiere trabajar cada semana." },
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
      { en: "No — only reports that the investigation eventually substantiates are protected.", es: "No — solo los reportes que la investigación eventualmente comprueba están protegidos." },
      { en: "Yes — good-faith reports are protected regardless of the investigation outcome.", es: "Sí — el reporte de buena fe está protegido sin importar el resultado de la investigación." },
      { en: "Only if you submitted your report in writing rather than verbally to a supervisor.", es: "Solo si presentó su reporte por escrito en lugar de verbalmente a un supervisor." },
      { en: "Only if the accused person eventually agrees that you reported in good faith.", es: "Solo si la persona acusada eventualmente acepta que usted reportó de buena fe." },
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
      { en: "Accept it — the client likes your work and Saturday happens to be your day off.", es: "Acéptelo — al cliente le gusta su trabajo y el sábado es su día libre." },
      { en: "Decline — refer the client back to the office to book through Phes channels.", es: "Rehúselo — refiera al cliente a la oficina para reservar a través de Phes." },
      { en: "Accept it, but only if you charge less than the standard Phes hourly rate.", es: "Acéptelo, pero solo si cobra menos que la tarifa estándar por hora de Phes." },
      { en: "Accept it and tell the office about the side cleaning job afterward.", es: "Acéptelo y avísele a la oficina sobre el trabajo paralelo de limpieza después." },
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
      { en: "Take it home with you so you have it ready for the next scheduled visit.", es: "Llevársela a casa para tenerla lista la próxima visita programada." },
      { en: "Return it to the office at end of shift — keys are Phes property at all times.", es: "Devolverla a la oficina al final del turno — son propiedad de Phes en todo momento." },
      { en: "Give a copy to your teammate so they can cover you if you ever cannot come.", es: "Darle una copia a su compañero por si necesita cubrirlo si usted no puede venir." },
      { en: "Hide the key under the client's doormat for next week's recurring visit.", es: "Esconder la llave debajo del tapete del cliente para la visita recurrente siguiente." },
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
      { en: "Stay quiet — it was not your shift and not your business to involve yourself.", es: "Quedarse callado — no fue su turno ni su asunto involucrarse en el caso." },
      { en: "Cooperate truthfully — share relevant info with the office investigators.", es: "Cooperar veridicamente — comparta la información relevante con los investigadores." },
      { en: "Tell the coworker to lie to the office to protect them from any discipline.", es: "Decirle al compañero que mienta a la oficina para protegerlo de la disciplina." },
      { en: "Discuss the open investigation publicly so the truth comes out faster overall.", es: "Discutir la investigación abierta públicamente para que la verdad salga más rápido." },
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
      { en: "Only the office team — there are no other reporting paths available at Phes.", es: "Solo el equipo de la oficina — no hay otras vías de reporte disponibles en Phes." },
      { en: "The owner directly, the Illinois IDHR, or the federal EEOC are all options.", es: "El dueño directamente, el IDHR de Illinois o la EEOC federal son opciones." },
      { en: "You must first report the concern to the accused person before going elsewhere.", es: "Debe primero reportar la preocupación a la persona acusada antes de ir a otro lugar." },
      { en: "You may post about the concern on social media so other employees can see it.", es: "Puede publicar sobre la preocupación en redes sociales para que otros empleados la vean." },
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
      { en: "You can be terminated for refusing to sign the Video & Photo Release.", es: "Pueden despedirlo por negarse a firmar la Autorización de Video y Foto." },
      { en: "Nothing happens — signing is voluntary and Phes will not photograph you.", es: "Nada pasa — firmar es voluntario y Phes no lo fotografiará." },
      { en: "Your scheduled weekly hours are reduced as a consequence of declining.", es: "Se reducen sus horas semanales programadas como consecuencia de la negativa." },
      { en: "You lose eligibility for your next annual cost-of-living wage raise.", es: "Pierde elegibilidad para su próximo aumento anual por costo de vida." },
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
      { en: "Use them forever with no post-separation time limit on continued usage.", es: "Usarlos para siempre sin límite de tiempo después de la separación." },
      { en: "Continue active distribution but no NEW uses past 5 years from your last day.", es: "Continuar la distribución activa pero sin NUEVOS usos pasados 5 años." },
      { en: "Phes must remove all content featuring you immediately on your last day.", es: "Phes debe retirar todo el contenido suyo inmediatamente en su último día." },
      { en: "Phes must pay you a residual fee for any continued use after separation.", es: "Phes debe pagarle una tarifa residual por uso continuado tras la separación." },
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
      { en: "Yes — recruiting graphics are a covered commercial use under this release.", es: "Sí — los gráficos de reclutamiento son un uso comercial cubierto por esta autorización." },
      { en: "No — AI training and synthetic media require a SEPARATE written consent.", es: "No — el entrenamiento de IA y los medios sintéticos requieren consentimiento separado." },
      { en: "Yes, but only for purely internal use within the Phes office team.", es: "Sí, pero solo para uso puramente interno dentro del equipo de la oficina de Phes." },
      { en: "Yes, because it is still your image regardless of the medium it is used in.", es: "Sí, porque sigue siendo su imagen sin importar el medio en el que se use." },
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
      { en: "Phes is not obligated to do anything — consent under the release is permanent.", es: "Phes no está obligado a hacer nada — el consentimiento es permanente." },
      { en: "Phes will remove content from Phes-controlled channels within 30 days written.", es: "Phes retirará el contenido de los canales controlados por Phes en 30 días." },
      { en: "Phes must pay you a buy-out fee to release the content into the public domain.", es: "Phes debe pagarle una tarifa para liberar el contenido al dominio público." },
      { en: "Phes must remove all content within 24 hours of your written withdrawal request.", es: "Phes debe retirar todo el contenido en 24 horas de su solicitud escrita." },
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
      { en: "Yes — Phes has full control over any copy of content it originally produced.", es: "Sí — Phes tiene control total sobre cualquier copia del contenido producido." },
      { en: "No — Phes cannot recall content already distributed by third-party accounts.", es: "No — Phes no puede recuperar contenido ya distribuido por cuentas de terceros." },
      { en: "Only if Phes obtains a specific court order targeting that third-party account.", es: "Solo si Phes obtiene una orden judicial específica contra esa cuenta de tercero." },
      { en: "Only if the third party is charging money or running paid ads with the repost.", es: "Solo si el tercero cobra dinero o publica anuncios pagados con la republicación." },
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
      { en: "Illinois Cannabis Regulation and Tax Act (410 ILCS 705), enacted in 2019.", es: "Ley de Regulación e Impuestos del Cannabis de Illinois (410 ILCS 705), de 2019." },
      { en: "Illinois Right of Publicity Act, 765 ILCS 1075, governing commercial use.", es: "Ley del Derecho de Publicidad de Illinois, 765 ILCS 1075, sobre uso comercial." },
      { en: "Illinois Workplace Transparency Act (820 ILCS 96), restricting NDAs broadly.", es: "Ley de Transparencia Laboral de Illinois (820 ILCS 96), que restringe los NDAs." },
      { en: "Illinois Paid Leave for All Workers Act (820 ILCS 192), in effect since 2024.", es: "Ley de Licencia Pagada para Todos los Trabajadores de Illinois (820 ILCS 192)." },
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
      { en: "Because the office wants more employee signatures on file for personnel audit.", es: "Porque la oficina quiere más firmas archivadas en el expediente para auditoría." },
      { en: "Because the release is a TWO-WAY commitment with specific limits Phes must honor.", es: "Porque la autorización es un compromiso DE DOS VÍAS con límites específicos para Phes." },
      { en: "Because Illinois state law requires two signatures on every commercial release.", es: "Porque la ley estatal de Illinois exige dos firmas en cada autorización comercial." },
      { en: "Because two signatures make the release document harder to forge than just one.", es: "Porque dos firmas hacen el documento de autorización más difícil de falsificar." },
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
      { en: "Yes — pre-publication approval is required for every photo and video Phes uses.", es: "Sí — la aprobación previa es requerida para cada foto y video que Phes usa." },
      { en: "No — courtesy preview where feasible, not a veto or hard approval requirement.", es: "No — vista previa de cortesía cuando sea factible, no es un veto ni aprobación requerida." },
      { en: "Yes, but only for video content, not still photographs from a recorded shoot.", es: "Sí, pero solo para contenido en video, no fotografías fijas de una sesión grabada." },
      { en: "No — you have no input or notice of any kind before content is published.", es: "No — no tiene ninguna participación ni aviso antes de que el contenido se publique." },
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
      { en: "No — Phes must take down all content featuring you on or before your last day.", es: "No — Phes debe retirar todo el contenido suyo en o antes de su último día." },
      { en: "Yes — content already in ACTIVE DISTRIBUTION at separation may continue running.", es: "Sí — el contenido ya en DISTRIBUCIÓN ACTIVA al momento de la separación puede continuar." },
      { en: "Only if Phes pays you a continued-use fee for each month after your last day.", es: "Solo si Phes le paga una tarifa por uso continuado por cada mes después de su último día." },
      { en: "Yes, but only for one full year past your formal separation date from Phes.", es: "Sí, pero solo por un año completo pasada su fecha formal de separación de Phes." },
    ],
    correctIndex: 1,
  },

  // ═════════════════════════════════════════════════════════════════════════════
  // Module 10: NON-SOLICITATION AGREEMENT (10 questions, Phase 6 PR #7)
  // ═════════════════════════════════════════════════════════════════════════════
  {
    id: "q-ns-01-clients-not-coworkers",
    moduleId: "non-solicitation",
    prompt: {
      en: "Does the Non-Solicitation Agreement restrict you from recruiting Phes coworkers to a new job?",
      es: "¿El Acuerdo de No Solicitación le impide reclutar a compañeros de Phes para un nuevo trabajo?",
    },
    options: [
      { en: "Yes — the agreement broadly covers both Phes clients and Phes coworkers equally.", es: "Sí — el acuerdo cubre ampliamente tanto a clientes como a compañeros de Phes." },
      { en: "No — the agreement restricts soliciting CLIENTS only; coworker recruiting is free.", es: "No — el acuerdo restringe solicitar solo CLIENTES; reclutar compañeros es libre." },
      { en: "Only if the coworker happens to be a primary tech on a recurring client account.", es: "Solo si el compañero es técnico principal en una cuenta de cliente recurrente." },
      { en: "Only if you give the Phes office at least 30 days of advance notice before recruiting.", es: "Solo si da a la oficina de Phes al menos 30 días de aviso antes de reclutar." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-ns-02-12-month-duration",
    moduleId: "non-solicitation",
    prompt: {
      en: "You leave Phes today. How long does the Non-Solicitation Agreement restrict you from soliciting Phes clients?",
      es: "Se va de Phes hoy. ¿Por cuánto tiempo le restringe el Acuerdo de No Solicitación solicitar a clientes de Phes?",
    },
    options: [
      { en: "Forever — the restriction never expires for any former Phes client under the deal.", es: "Para siempre — la restricción nunca vence para ningún antiguo cliente de Phes." },
      { en: "12 months from your last day at Phes — after that, no restriction on past clients.", es: "12 meses desde su último día en Phes — después, sin restricción a clientes pasados." },
      { en: "5 years from your last day, after which any former Phes client is fair game again.", es: "5 años desde su último día, tras los cuales cualquier antiguo cliente es libre." },
      { en: "10 years from your last day at Phes before the restriction lifts on past clients.", es: "10 años desde su último día en Phes antes de que la restricción se levante." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-ns-03-what-counts-as-solicit",
    moduleId: "non-solicitation",
    prompt: {
      en: "Which of the following IS solicitation under the agreement?",
      es: "¿Cuál de los siguientes ES solicitación bajo el acuerdo?",
    },
    options: [
      { en: "Running a Facebook page that advertises cleaning to the public at large.", es: "Manejar una página de Facebook que anuncia limpieza al público en general." },
      { en: "Sending a DM to a Phes client offering to clean their home next Saturday.", es: "Enviar un mensaje directo a un cliente de Phes ofreciendo limpiar su casa el próximo sábado." },
      { en: "Putting a flyer on a neighborhood bulletin board.", es: "Poner un volante en un tablero de anuncios del vecindario." },
      { en: "Posting on Craigslist for cleaning work in Oak Lawn.", es: "Publicar en Craigslist trabajo de limpieza en Oak Lawn." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-ns-04-general-advertising-ok",
    moduleId: "non-solicitation",
    prompt: {
      en: "After leaving Phes you start a small cleaning side business. You post on Craigslist offering services to anyone in Oak Lawn. A Phes client happens to see the post and contacts you. Is this a violation?",
      es: "Después de dejar Phes inicia un pequeño negocio paralelo de limpieza. Publica en Craigslist ofreciendo servicios a cualquiera en Oak Lawn. Un cliente de Phes ve la publicación por casualidad y lo contacta. ¿Es una violación?",
    },
    options: [
      { en: "Yes — any cleaning work with a former Phes client within 12 months is forbidden.", es: "Sí — cualquier trabajo de limpieza con antiguo cliente de Phes en 12 meses está prohibido." },
      { en: "No — general advertising is not solicitation; inbound-contact carve-out applies here.", es: "No — la publicidad general no es solicitación; aplica la exclusión de contacto entrante." },
      { en: "Only if you happen to charge less than the standard Phes hourly rate for the work.", es: "Solo si por casualidad cobra menos que la tarifa estándar por hora de Phes." },
      { en: "Only if you previously took unauthorized photos of any Phes job sites for portfolio.", es: "Solo si previamente tomó fotos no autorizadas de lugares de trabajo de Phes." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-ns-05-il-freedom-to-work",
    moduleId: "non-solicitation",
    prompt: {
      en: "Which Illinois law governs the enforceability of the Non-Solicitation Agreement and requires that any restriction be reasonable, supported by consideration, and tied to a legitimate business interest?",
      es: "¿Qué ley de Illinois rige la exigibilidad del Acuerdo de No Solicitación y requiere que cualquier restricción sea razonable, apoyada por consideración y vinculada a un interés comercial legítimo?",
    },
    options: [
      { en: "Illinois Cannabis Regulation and Tax Act.", es: "Ley de Regulación e Impuestos del Cannabis de Illinois." },
      { en: "Illinois Freedom to Work Act, 820 ILCS 90.", es: "Ley de Libertad para Trabajar de Illinois, 820 ILCS 90." },
      { en: "Illinois Right of Publicity Act.", es: "Ley del Derecho de Publicidad de Illinois." },
      { en: "Illinois Paid Leave for All Workers Act.", es: "Ley de Licencia Pagada para Todos los Trabajadores de Illinois." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-ns-06-during-employment-too",
    moduleId: "non-solicitation",
    prompt: {
      en: "You're currently employed at Phes. A Phes client asks if you would clean their home this Saturday on the side, paid in cash. The agreement says:",
      es: "Actualmente está empleado en Phes. Un cliente de Phes le pregunta si podría limpiar su casa este sábado por su cuenta, pagado en efectivo. El acuerdo dice:",
    },
    options: [
      { en: "You may accept the side job because the agreement is only effective post-employment.", es: "Puede aceptar el trabajo paralelo porque el acuerdo es solo después del empleo." },
      { en: "Restriction applies DURING employment AND 12 months after — decline and refer to office.", es: "Aplica DURANTE el empleo Y 12 meses después — rechace y refiera a la oficina." },
      { en: "You may accept if you happen to charge less than the standard Phes rate per hour.", es: "Puede aceptar si por casualidad cobra menos que la tarifa estándar de Phes por hora." },
      { en: "You may accept if the client repeatedly insists they want you specifically to come.", es: "Puede aceptar si el cliente insiste repetidamente que quiere que usted específicamente venga." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-ns-07-consideration",
    moduleId: "non-solicitation",
    prompt: {
      en: "Under Illinois law, a non-solicitation agreement must be supported by CONSIDERATION — something of value given in exchange for the promise. What does Phes offer as consideration for this agreement?",
      es: "Bajo la ley de Illinois, un acuerdo de no solicitación debe estar apoyado por CONSIDERACIÓN — algo de valor dado a cambio de la promesa. ¿Qué ofrece Phes como consideración por este acuerdo?",
    },
    options: [
      { en: "Phes pays a one-time $5,000 signing bonus at hire that locks in the agreement.", es: "Phes paga un bono único de $5,000 al contratar que cierra el acuerdo." },
      { en: "Paid training, regular shifts, PTO, holiday pay, and continued employment past 2 yrs.", es: "Capacitación pagada, turnos regulares, PTO, feriados, y empleo continuo más de 2 años." },
      { en: "Phes promises lifetime guaranteed employment in exchange for signing the agreement.", es: "Phes promete empleo de por vida garantizado a cambio de firmar el acuerdo." },
      { en: "Phes pays you a one-time fee just for signing the document and nothing further at all.", es: "Phes le paga una tarifa única solo por firmar el documento y nada más en absoluto." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-ns-08-remedy-injunctive",
    moduleId: "non-solicitation",
    prompt: {
      en: "If Phes believes you have violated the agreement, what remedies does Phes pursue under this agreement?",
      es: "Si Phes cree que ha violado el acuerdo, ¿qué remedios busca Phes bajo este acuerdo?",
    },
    options: [
      { en: "A flat $50,000 liquidated-damages penalty per violation as written in the contract.", es: "Una penalización fija de $50,000 por cada violación tal como está escrito en el contrato." },
      { en: "Injunctive relief (court order to stop), documented damages, and reasonable attorney fees.", es: "Alivio por orden judicial (orden de detener), daños documentados, y honorarios razonables." },
      { en: "Phes immediately reports the violation to the local police as a criminal matter.", es: "Phes reporta la violación inmediatamente a la policía local como un asunto criminal." },
      { en: "Phes garnishes a portion of your wages directly from your next employer's payroll.", es: "Phes embarga una porción de sus salarios directamente del próximo empleador." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-ns-09-co-signature",
    moduleId: "non-solicitation",
    prompt: {
      en: "Why is the Non-Solicitation Agreement CO-SIGNED by the Phes representative?",
      es: "¿Por qué el Acuerdo de No Solicitación es CO-FIRMADO por el representante de Phes?",
    },
    options: [
      { en: "Because the office wants more total employee signatures archived in the personnel file.", es: "Porque la oficina quiere más firmas archivadas totales en el expediente personal." },
      { en: "Because the agreement is a TWO-WAY commitment with specific consideration from Phes.", es: "Porque el acuerdo es un compromiso DE DOS VÍAS con consideración específica de Phes." },
      { en: "Because Illinois state law actually requires two signatures on every non-solicit document.", es: "Porque la ley estatal de Illinois exige dos firmas en cada documento de no solicitación." },
      { en: "Because two signatures make the agreement document harder to forge or repudiate later.", es: "Porque dos firmas hacen el documento más difícil de falsificar o repudiar después." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-ns-10-inbound-clients-exception",
    moduleId: "non-solicitation",
    prompt: {
      en: "You left Phes three months ago. A former Phes client found your personal Instagram (which has nothing to do with cleaning) and messaged you asking if you do cleaning work. You had not contacted or invited them. Under the agreement, may you take the work?",
      es: "Se fue de Phes hace tres meses. Un antiguo cliente de Phes encontró su Instagram personal (que no tiene nada que ver con limpieza) y le envió un mensaje preguntando si hace trabajo de limpieza. Usted no lo contactó ni invitó. Bajo el acuerdo, ¿puede tomar el trabajo?",
    },
    options: [
      { en: "No — any work with a former Phes client within the 12-month window is fully forbidden.", es: "No — cualquier trabajo con antiguo cliente en la ventana de 12 meses está prohibido." },
      { en: "Yes — the inbound-contact carve-out applies because the client contacted you first.", es: "Sí — aplica la exclusión de contacto entrante porque el cliente lo contactó a usted primero." },
      { en: "Only if you happen to charge a lower rate than the standard Phes rate per hour today.", es: "Solo si por casualidad cobra una tarifa más baja que la estándar de Phes por hora." },
      { en: "Only after first consulting with an employment attorney about the agreement's scope.", es: "Solo después de consultar con un abogado laboral sobre el alcance del acuerdo." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-ns-11-direct-payment-prohibition",
    moduleId: "non-solicitation",
    prompt: {
      en: "At the end of a scheduled Phes job, a happy client offers to pay you $50 in cash directly so the office \"doesn't take a cut.\" What does the Non-Solicitation Agreement require you to do?",
      es: "Al final de un trabajo programado de Phes, un cliente satisfecho le ofrece pagarle $50 en efectivo directamente para que la oficina \"no se quede con un porcentaje.\" ¿Qué requiere el Acuerdo de No Solicitación que haga?",
    },
    options: [
      { en: "Accept the $50 cash because the office didn't actually book this specific extra part.", es: "Acepte los $50 porque la oficina no reservó realmente esta parte extra específica." },
      { en: "Decline the direct payment — all scheduled work must be booked and billed by Phes.", es: "Rechace el pago directo — todo trabajo programado debe reservarse y facturarse por Phes." },
      { en: "Accept the $50 cash only if you agree to split the amount with the office afterward.", es: "Acepte los $50 solo si acepta compartir el monto con la oficina después." },
      { en: "Accept the $50 cash only on Fridays as a one-time end-of-week courtesy from a client.", es: "Acepte los $50 solo los viernes como cortesía de fin de semana de un cliente." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-ns-12-trade-secret-confidentiality",
    moduleId: "non-solicitation",
    prompt: {
      en: "Two years after leaving Phes, you publish a blog post that lists Phes's specific pricing rules and quote formulas that you learned on the job. Is this a violation of the agreement?",
      es: "Dos años después de irse de Phes, publica un artículo de blog que enumera las reglas de precios y fórmulas de cotización específicas de Phes que aprendió en el trabajo. ¿Esto es una violación del acuerdo?",
    },
    options: [
      { en: "No — you no longer work at Phes so any disclosure is fine after the 12-month window.", es: "No — ya no trabaja en Phes así que cualquier divulgación está bien tras los 12 meses." },
      { en: "Yes — Phes pricing rules are trade secrets under IL 765 ILCS 1065; confidentiality is indefinite.", es: "Sí — las reglas de precios son secretos comerciales bajo IL 765 ILCS 1065; indefinida." },
      { en: "Only if the blog post actually names a specific Phes client by full name and address.", es: "Solo si el artículo nombra a un cliente de Phes con nombre completo y dirección." },
      { en: "Only if Phes paid for the hosting of your personal blog site at the time of publishing.", es: "Solo si Phes pagó el alojamiento de su blog personal al momento de publicar." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-ns-13-trade-secret-vs-section-7",
    moduleId: "non-solicitation",
    prompt: {
      en: "After leaving Phes, you tweet about how much Phes pays cleaning techs and tag two former coworkers asking what they thought of the pay. The post does not mention any client list, pricing rules, or internal procedures. Is this a violation of the indefinite confidentiality obligation?",
      es: "Después de irse de Phes, tuitea sobre cuánto paga Phes a los técnicos de limpieza y etiqueta a dos antiguos compañeros preguntando qué pensaban del pago. La publicación no menciona ninguna lista de clientes, reglas de precios ni procedimientos internos. ¿Es una violación de la obligación de confidencialidad indefinida?",
    },
    options: [
      { en: "Yes — anything about Phes operations is confidential forever after you leave the company.", es: "Sí — cualquier cosa sobre las operaciones de Phes es confidencial para siempre." },
      { en: "No — confidentiality is scoped to trade secrets; NLRA Section 7 protects pay discussion.", es: "No — la confidencialidad cubre secretos comerciales; NLRA Sección 7 protege discusión de pago." },
      { en: "Yes — because you tagged former coworkers in the tweet, the post is now considered closed.", es: "Sí — porque etiquetó a antiguos compañeros, la publicación se considera cerrada." },
      { en: "Only if a currently-employed Phes employee likes or shares the tweet on social media first.", es: "Solo si un empleado actual de Phes da like o comparte el tuit en redes sociales primero." },
    ],
    correctIndex: 1,
  },

  // ═════════════════════════════════════════════════════════════════════════════
  // Module 11: SOCIAL MEDIA POLICY (10 questions, Phase 7 PR #8)
  // ═════════════════════════════════════════════════════════════════════════════
  {
    id: "q-sm-01-client-confidentiality",
    moduleId: "social-media",
    prompt: {
      en: "After a cleaning shift, you take a quick photo of yourself in front of a client's bookshelf and post it to your private Instagram with the caption 'Long day, beautiful house!' The client's full name and address are not in the post. Is this a violation of the social-media policy?",
      es: "Después de un turno de limpieza, toma una foto rápida de usted frente al librero del cliente y la publica en su Instagram privado con la leyenda 'Día largo, casa hermosa!' El nombre completo y la dirección del cliente no están en la publicación. ¿Es una violación de la política?",
    },
    options: [
      { en: "No — the client's full name is not visible anywhere in the post or caption.", es: "No — el nombre completo del cliente no es visible en la publicación ni el pie." },
      { en: "Yes — photos of or inside a client home are prohibited, named or not.", es: "Sí — las fotos de o dentro del hogar del cliente están prohibidas, con o sin nombre." },
      { en: "No — the account is private so the post is not a true public violation here.", es: "No — la cuenta es privada así que la publicación no es una violación pública aquí." },
      { en: "Yes, but only if the client sees the post and formally complains to the office.", es: "Sí, pero solo si el cliente ve la publicación y se queja formalmente a la oficina." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sm-02-nlra-section-7",
    moduleId: "social-media",
    prompt: {
      en: "You post on Twitter that 'Phes pays $X/hour for residential cleaning' and tag two coworkers asking what they think. Does the social-media policy prohibit this post?",
      es: "Publica en Twitter que 'Phes paga $X/hora por limpieza residencial' y etiqueta a dos compañeros preguntando qué piensan. ¿La política de redes sociales prohíbe esta publicación?",
    },
    options: [
      { en: "Yes — discussing pay publicly violates Phes confidentiality terms in the handbook.", es: "Sí — discutir el pago públicamente viola los términos de confidencialidad de Phes." },
      { en: "No — pay discussion is protected under Section 7 of the federal NLRA.", es: "No — la discusión del pago está protegida por la Sección 7 de la NLRA federal." },
      { en: "Yes — pay discussion is only allowed if you also tag the official office account.", es: "Sí — la discusión del pago solo se permite si también etiqueta la cuenta oficial." },
      { en: "Yes — pay discussion is allowed only when posted from a fully anonymous account.", es: "Sí — la discusión del pago se permite solo cuando se publica desde una cuenta anónima." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sm-03-off-duty-private",
    moduleId: "social-media",
    prompt: {
      en: "Phes asks you for your personal Instagram password so the office can verify what you post. Under Illinois law, does Phes have the right to demand this?",
      es: "Phes le pide la contraseña de su Instagram personal para que la oficina pueda verificar lo que publica. Bajo la ley de Illinois, ¿tiene Phes el derecho de exigir esto?",
    },
    options: [
      { en: "Yes — the Phes social-media policy grants Phes that direct monitoring authority.", es: "Sí — la política de redes sociales de Phes le da a Phes esa autoridad de monitoreo directo." },
      { en: "No — Illinois 820 ILCS 55 prohibits employers from demanding personal account access.", es: "No — la ley 820 ILCS 55 de Illinois prohíbe a los empleadores exigir acceso a cuentas personales." },
      { en: "Yes, but only after two full weeks of written notice from the Phes office team.", es: "Sí, pero solo después de dos semanas completas de aviso escrito por la oficina." },
      { en: "Yes, but only if a personal post specifically involves alcohol use while in uniform.", es: "Sí, pero solo si una publicación involucra específicamente uso de alcohol en uniforme." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sm-04-uniform-misuse",
    moduleId: "social-media",
    prompt: {
      en: "You post a TikTok of yourself wearing your Phes branded apron, drinking a beer, with the caption 'Friday after work'. Is this a violation?",
      es: "Publica un TikTok de usted mismo vistiendo su delantal con marca de Phes, bebiendo una cerveza, con la leyenda 'Viernes después del trabajo'. ¿Es una violación?",
    },
    options: [
      { en: "No — you are off-duty and free to post whatever you want on personal social media.", es: "No — está fuera de servicio y libre de publicar lo que quiera en sus redes personales." },
      { en: "Yes — visible Phes uniform combined with alcohol implies a Phes endorsement.", es: "Sí — el uniforme visible de Phes combinado con alcohol implica un respaldo de Phes." },
      { en: "No, as long as your face is not clearly identifiable in the TikTok video frame.", es: "No, mientras su rostro no sea claramente identificable en el cuadro del video TikTok." },
      { en: "No, because beer is legal and the post does not name a specific Phes client.", es: "No, porque la cerveza es legal y la publicación no nombra a un cliente específico de Phes." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sm-05-client-solicitation",
    moduleId: "social-media",
    prompt: {
      en: "You leave Phes. Two months later you DM a Phes client on Instagram offering to clean their home next Saturday. Which two policies does this violate?",
      es: "Se va de Phes. Dos meses después le envía un DM a un cliente de Phes en Instagram ofreciendo limpiar su casa el próximo sábado. ¿Qué dos políticas viola esto?",
    },
    options: [
      { en: "The Drug & Alcohol Policy and the Code of Conduct conflict-of-interest section.", es: "La Política de Drogas y Alcohol y la sección de conflicto de interés del Código de Conducta." },
      { en: "The Non-Solicitation Agreement and the Social Media Policy DM restriction.", es: "El Acuerdo de No Solicitación y la restricción de DM de la Política de Redes Sociales." },
      { en: "The Video & Photo Release and the Compensation policy on bonus eligibility rules.", es: "La Autorización de Video y Foto y la política de Compensación sobre reglas de bonos." },
      { en: "None — you are no longer employed at Phes so no policy continues to apply.", es: "Ninguna — ya no está empleado en Phes así que ninguna política continúa aplicando." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sm-06-disparagement",
    moduleId: "social-media",
    prompt: {
      en: "You post on Facebook 'one of our worst customers today, lady in Oak Lawn was rude as hell.' You did not name the client. Does this violate the policy?",
      es: "Publica en Facebook 'una de nuestras peores clientes hoy, una señora en Oak Lawn fue muy grosera.' No nombró a la cliente. ¿Esto viola la política?",
    },
    options: [
      { en: "No — the client's full name is not visible anywhere in the Facebook post itself.", es: "No — el nombre completo de la cliente no es visible en la publicación de Facebook." },
      { en: "Yes — identifiable client disparagement is prohibited even without using a name.", es: "Sí — el menosprecio de un cliente identificable está prohibido incluso sin usar un nombre." },
      { en: "No, because complaining about clients is a private personal feeling, not policy.", es: "No, porque quejarse de los clientes es un sentimiento personal privado, no política." },
      { en: "Yes, but only if the client herself eventually sees the post directly online.", es: "Sí, pero solo si la cliente eventualmente ve la publicación directamente en línea." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sm-07-impersonation",
    moduleId: "social-media",
    prompt: {
      en: "You create a new Facebook page called 'Phes Cleaning Oak Lawn' to share cleaning tips. You think it would be helpful for the community. The office did not approve it. Is this allowed?",
      es: "Crea una nueva página de Facebook llamada 'Phes Cleaning Oak Lawn' para compartir consejos de limpieza. Cree que sería útil para la comunidad. La oficina no lo aprobó. ¿Está permitido?",
    },
    options: [
      { en: "Yes — cleaning tips are harmless community content under the social-media policy.", es: "Sí — los consejos de limpieza son contenido comunitario inofensivo bajo la política." },
      { en: "No — you may not create a Phes-branded page without prior office authorization.", es: "No — no puede crear una página con marca de Phes sin autorización previa de la oficina." },
      { en: "Yes, as long as you carefully avoid posting about Phes pay, hours, or schedules.", es: "Sí, mientras evite cuidadosamente publicar sobre pago, horas u horarios de Phes." },
      { en: "Yes, but only if you charge a paid membership fee for tip-content access.", es: "Sí, pero solo si cobra una tarifa de membresía pagada por acceso al contenido de tips." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sm-08-protected-concerted",
    moduleId: "social-media",
    prompt: {
      en: "You and three coworkers post a coordinated Twitter thread about a workplace safety concern at Phes — chemical handling without proper ventilation — and ask the public to support better conditions. The office is unhappy with the post. Is this protected?",
      es: "Usted y tres compañeros publican un hilo coordinado en Twitter sobre una preocupación de seguridad laboral en Phes — manejo de químicos sin ventilación adecuada — y piden al público apoyar mejores condiciones. La oficina está molesta por la publicación. ¿Está protegido?",
    },
    options: [
      { en: "No — the public post embarrasses Phes and damages the company's reputation.", es: "No — la publicación pública avergüenza a Phes y daña la reputación de la empresa." },
      { en: "Yes — Section 7 protects concerted activity about workplace safety conditions.", es: "Sí — la Sección 7 protege la actividad concertada sobre condiciones de seguridad laboral." },
      { en: "Yes, but only if a recognized union is actively involved in the Twitter thread.", es: "Sí, pero solo si un sindicato reconocido está activamente involucrado en el hilo." },
      { en: "Yes, but only if the participants remain fully anonymous to the public reader.", es: "Sí, pero solo si los participantes permanecen totalmente anónimos ante el lector público." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sm-09-harassment-reporting",
    moduleId: "social-media",
    prompt: {
      en: "You see a public Facebook comment by a Phes coworker calling another coworker a racial slur. What does the policy ask you to do?",
      es: "Ve un comentario público de Facebook de un compañero de Phes llamando a otro compañero con un insulto racial. ¿Qué le pide la política que haga?",
    },
    options: [
      { en: "Stay out of it — social media interactions are private personal speech overall.", es: "Manténgase al margen — las interacciones en redes son habla personal privada." },
      { en: "Report it through Code of Conduct channels — the same protections apply online.", es: "Reportarlo a través de las vías del Código de Conducta — las mismas protecciones aplican." },
      { en: "Reply publicly on Facebook defending the targeted coworker out loud yourself.", es: "Responder públicamente en Facebook defendiendo al compañero objetivo en voz alta." },
      { en: "Screenshot the offending comment and post it to your own personal account.", es: "Tomar captura del comentario ofensivo y publicarlo en su cuenta personal." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sm-10-client-photos",
    moduleId: "social-media",
    prompt: {
      en: "Phes posts a recruiting graphic to its official Instagram showing a sparkling kitchen. Is THAT graphic a violation of this policy?",
      es: "Phes publica un gráfico de reclutamiento en su Instagram oficial mostrando una cocina reluciente. ¿Ese gráfico es una violación de esta política?",
    },
    options: [
      { en: "Yes — the graphic depicts a client home interior posted to social media.", es: "Sí — el gráfico muestra el interior de un hogar de cliente en redes sociales." },
      { en: "No — official Phes channels are governed by the Video & Photo Release instead.", es: "No — los canales oficiales de Phes se rigen por la Autorización de Video y Foto." },
      { en: "Yes, but only if a client themselves is shown in the photo of the kitchen.", es: "Sí, pero solo si el cliente mismo aparece mostrado en la foto de la cocina." },
      { en: "Yes — interior kitchen photography is restricted as inherently private space.", es: "Sí — la fotografía interior de cocinas está restringida como espacio inherentemente privado." },
    ],
    correctIndex: 1,
  },

  // ═════════════════════════════════════════════════════════════════════════════
  // Module 12: PHES 401(k) RETIREMENT PLAN (10 questions, Phase 8 PR #9)
  // ═════════════════════════════════════════════════════════════════════════════
  {
    id: "q-401-01-eligibility",
    moduleId: "phes-401k",
    prompt: {
      en: "When does an employee become eligible to participate in the Phes 401(k) Plan?",
      es: "¿Cuándo se vuelve elegible un empleado para participar en el Plan 401(k) de Phes?",
    },
    options: [
      { en: "On their very first scheduled day of paid employment with the company.", es: "En su primer día programado y pagado de empleo con la compañía." },
      { en: "After turning age 18 AND completing 3 months of service, by next entry date.", es: "Al cumplir 18 años Y completar 3 meses de servicio, en la próxima entrada." },
      { en: "After completing one full year of continuous active employment with Phes.", es: "Después de completar un año completo continuo de empleo activo con Phes." },
      { en: "After they successfully pass the mandatory three-week training period.", es: "Después de pasar exitosamente el periodo obligatorio de tres semanas de capacitación." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-401-02-auto-enroll-pct",
    moduleId: "phes-401k",
    prompt: {
      en: "What is the auto-enrollment contribution percentage when you first become eligible?",
      es: "¿Cuál es el porcentaje de contribución por inscripción automática cuando se vuelve elegible por primera vez?",
    },
    options: [
      { en: "1 percent of pay, deducted pre-tax into the Plan default investment fund.", es: "1 por ciento del pago, deducido antes de impuestos al fondo predeterminado." },
      { en: "3 percent of pay, deducted pre-tax into the Plan default fund; change anytime.", es: "3 por ciento del pago, deducido antes de impuestos al fondo predeterminado." },
      { en: "5 percent of pay, deducted pre-tax into the Plan default investment fund.", es: "5 por ciento del pago, deducido antes de impuestos al fondo predeterminado." },
      { en: "10 percent of pay, deducted pre-tax into the Plan default investment fund.", es: "10 por ciento del pago, deducido antes de impuestos al fondo predeterminado." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-401-03-safe-harbor-formula",
    moduleId: "phes-401k",
    prompt: {
      en: "What is the Phes Safe Harbor matching formula?",
      es: "¿Cuál es la fórmula de la contribución Safe Harbor de Phes?",
    },
    options: [
      { en: "100 percent of your first 3 percent of pay, plus 50 percent of the next 2 percent.", es: "100 por ciento de su primer 3 por ciento de pago, más 50 por ciento del siguiente 2." },
      { en: "50 percent of your first 6 percent of pay, with no additional tier above that level.", es: "50 por ciento de su primer 6 por ciento de pago, sin nivel adicional encima." },
      { en: "100 percent of your first 6 percent of pay, with no additional tier above that level.", es: "100 por ciento de su primer 6 por ciento de pago, sin nivel adicional encima." },
      { en: "Phes does not match any employee contributions to the 401(k) plan at all.", es: "Phes no iguala ninguna contribución del empleado al plan 401(k) en absoluto." },
    ],
    correctIndex: 0,
  },
  {
    id: "q-401-04-match-at-5-pct",
    moduleId: "phes-401k",
    prompt: {
      en: "If you contribute 5 percent of your pay to the 401(k), how much does Phes add on top of that?",
      es: "Si contribuye 5 por ciento de su pago al 401(k), ¿cuánto agrega Phes adicionalmente?",
    },
    options: [
      { en: "2 percent of pay — half of your 5 percent matched at a flat partial rate.", es: "2 por ciento del pago — la mitad de su 5 por ciento igualado a tarifa parcial." },
      { en: "3 percent of pay — only the first 3 percent tier of the safe-harbor formula.", es: "3 por ciento del pago — solo el primer 3 por ciento del nivel de safe-harbor." },
      { en: "4 percent of pay — 3 percent match on first 3 plus 1 percent on next 2.", es: "4 por ciento del pago — 3 por ciento sobre el primer 3 más 1 por ciento sobre el siguiente 2." },
      { en: "5 percent of pay — Phes fully matches your contribution dollar for dollar.", es: "5 por ciento del pago — Phes iguala su contribución dólar por dólar." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-401-05-vesting-immediate",
    moduleId: "phes-401k",
    prompt: {
      en: "Are your own contributions and the Safe Harbor match 100 percent yours from day one?",
      es: "¿Sus propias contribuciones y la contribución Safe Harbor son 100 por ciento suyas desde el primer día?",
    },
    options: [
      { en: "Yes — employee contributions and the Safe Harbor match are 100% vested immediately.", es: "Sí — sus contribuciones y la igualación Safe Harbor están 100% adquiridas de inmediato." },
      { en: "No — they vest gradually over a 6-year graded vesting schedule from hire.", es: "No — se adquieren gradualmente sobre un calendario de adquisición de 6 años." },
      { en: "Only after you complete 5 years of continuous active service with Phes Cleaning.", es: "Solo después de completar 5 años de servicio activo continuo con Phes Cleaning." },
      { en: "Only when you actually retire and take a qualified distribution from the plan.", es: "Solo cuando se jubile y tome una distribución calificada del plan." },
    ],
    correctIndex: 0,
  },
  {
    id: "q-401-06-enrollment-paths",
    moduleId: "phes-401k",
    prompt: {
      en: "How do you enroll or change your 401(k) election?",
      es: "¿Cómo se inscribe o cambia su elección del 401(k)?",
    },
    options: [
      { en: "Wait for the Phes office to formally enroll you on your next eligibility date.", es: "Espere a que la oficina de Phes lo inscriba en su próxima fecha de elegibilidad." },
      { en: "Text 'Enroll Now' to 72408, visit My.ADP.com, use the app, or call 1-800-695-7526.", es: "Envíe 'Enroll Now' al 72408, visite My.ADP.com, use la app o llame 1-800-695-7526." },
      { en: "Fill out a paper election form and mail it to the ADP retirement services center.", es: "Llene un formulario en papel y envíelo por correo al centro de servicios de ADP." },
      { en: "Wait until your 1-year anniversary at Phes to make any 401(k) election changes.", es: "Espere hasta su aniversario de 1 año en Phes para hacer cambios al 401(k)." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-401-07-catch-up-50-plus",
    moduleId: "phes-401k",
    prompt: {
      en: "You will be 52 by the end of the year. Can you contribute more than the standard $24,500 annual limit?",
      es: "Cumplirá 52 antes de fin de año. ¿Puede contribuir más del límite anual estándar de $24,500?",
    },
    options: [
      { en: "No — the standard $24,500 annual limit applies equally to every participant.", es: "No — el límite estándar anual de $24,500 aplica igualmente a cada participante." },
      { en: "Yes — standard catch-up (age 50+ by Dec 31) allows an extra $8,000 per year on top.", es: "Sí — recuperación estándar (50+ al 31 de diciembre) permite $8,000 extra al año." },
      { en: "Yes — there is no upper contribution limit at all for participants who are older.", es: "Sí — no hay límite superior de contribución para participantes mayores." },
      { en: "Only if your spouse formally co-signs the election form acknowledging the increase.", es: "Solo si su cónyuge co-firma formalmente la elección reconociendo el aumento." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-401-08-early-withdrawal-penalty",
    moduleId: "phes-401k",
    prompt: {
      en: "You withdraw money from your 401(k) at age 45 (not a rollover). What is the tax consequence?",
      es: "Retira dinero de su 401(k) a los 45 años (sin ser una transferencia). ¿Cuál es la consecuencia fiscal?",
    },
    options: [
      { en: "No penalty at all — withdrawals from a 401(k) account are always penalty-free.", es: "Sin penalización — los retiros del 401(k) siempre son libres de penalización." },
      { en: "10% early-withdrawal penalty IN ADDITION to federal and state income tax on amount.", es: "Penalización del 10% por retiro temprano ADEMÁS del impuesto federal y estatal." },
      { en: "You forfeit your entire account balance back to the plan as a hard penalty.", es: "Pierde el saldo completo de su cuenta de vuelta al plan como penalización fuerte." },
      { en: "You cannot withdraw any funds at all before turning age 59 and a half years old.", es: "No puede retirar fondos en absoluto antes de cumplir los 59 años y medio." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-401-09-beneficiary-importance",
    moduleId: "phes-401k",
    prompt: {
      en: "Why is it important to name a beneficiary on your 401(k) account?",
      es: "¿Por qué es importante nombrar a un beneficiario en su cuenta 401(k)?",
    },
    options: [
      { en: "It is required by federal law to be designated and updated every single year.", es: "Es requerido por ley federal designar y actualizarlo cada año sin falta." },
      { en: "Your account passes to the beneficiary you designate if you die holding the balance.", es: "Su cuenta pasa al beneficiario que designe si fallece manteniendo el saldo." },
      { en: "It automatically increases your contribution rate by 1 percent each plan year.", es: "Aumenta automáticamente su tasa de contribución 1 por ciento cada año del plan." },
      { en: "It changes your default investment strategy to a more aggressive growth allocation.", es: "Cambia su estrategia de inversión predeterminada a una asignación más agresiva." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-401-10-opt-out-paths",
    moduleId: "phes-401k",
    prompt: {
      en: "Auto-enrollment kicked in but you do not want to contribute right now. Can you opt out, and how?",
      es: "Se activó la inscripción automática pero no quiere contribuir ahora. ¿Puede cancelar la inscripción, y cómo?",
    },
    options: [
      { en: "No — once you are auto-enrolled in the plan you cannot opt back out at all.", es: "No — una vez auto-inscrito en el plan no puede cancelar la inscripción." },
      { en: "Yes — opt out anytime via My.ADP.com, the mobile app, or the Voice-Response System.", es: "Sí — cancele en cualquier momento por My.ADP.com, la app móvil o el sistema de voz." },
      { en: "Only during the first calendar month immediately following your auto-enrollment date.", es: "Solo durante el primer mes calendario después de su fecha de inscripción automática." },
      { en: "Only if you are under age 21 at the time you request opt-out from the plan.", es: "Solo si tiene menos de 21 años cuando solicita cancelar la inscripción del plan." },
    ],
    correctIndex: 1,
  },

  // ═════════════════════════════════════════════════════════════════════════════
  // Module 13: SUPPLY KIT RESPONSIBILITY (10 questions, Phase 9 PR #10)
  // ═════════════════════════════════════════════════════════════════════════════
  {
    id: "q-sk-01-property-of-phes",
    moduleId: "supply-kit",
    prompt: {
      en: "Who owns the items in your Phes supply kit (caddy, vacuum, chemicals in Phes-branded bottles, uniform, keys, Phes phone)?",
      es: "¿Quién es dueño de los artículos de su kit de suministros de Phes (caddy, aspiradora, productos en botellas con marca de Phes, uniforme, llaves, teléfono de Phes)?",
    },
    options: [
      { en: "You own them outright once you start using them regularly on your Phes shifts.", es: "Usted los posee directamente una vez que empiece a usarlos regularmente en sus turnos de Phes." },
      { en: "Phes owns all of it — the kit is loaned for the duration of your employment.", es: "Phes es dueña de todo — el kit se le presta durante el tiempo de su empleo." },
      { en: "You and Phes own them jointly under a written shared-property arrangement.", es: "Usted y Phes son propietarios conjuntos bajo un arreglo escrito de propiedad compartida." },
      { en: "Whoever is assigned the recurring route owns the kit while on that route.", es: "Quien tenga asignada la ruta recurrente posee el kit mientras esté en esa ruta." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sk-02-supply-pickup-responsibility",
    moduleId: "supply-kit",
    prompt: {
      en: "Whose responsibility is it to maintain your Phes supply kit and ensure you have the supplies you need for assigned jobs?",
      es: "¿De quién es la responsabilidad de mantener su kit de suministros de Phes y asegurar que tenga los suministros que necesita para los trabajos asignados?",
    },
    options: [
      { en: "The office team is responsible for delivering supplies to me before each job.", es: "El equipo de oficina es responsable de entregarme los suministros antes de cada trabajo." },
      { en: "It is my responsibility as a Phes technician to maintain my supply kit and pick up supplies from the office as needed.", es: "Es mi responsabilidad como técnico de Phes mantener mi kit y recoger suministros en la oficina cuando sea necesario." },
      { en: "Phes is responsible for shipping supplies to my home when I need them.", es: "Phes es responsable de enviar suministros a mi casa cuando los necesito." },
      { en: "Whichever tech is on duty first that day is responsible for collecting supplies for everyone.", es: "El técnico que esté de turno primero ese día es responsable de recoger los suministros para todos." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sk-03-report-damage-promptly",
    moduleId: "supply-kit",
    prompt: {
      en: "You knock over the vacuum and crack the housing during a shift. What does the agreement ask you to do?",
      es: "Tira la aspiradora y rompe la carcasa durante un turno. ¿Qué le pide el acuerdo que haga?",
    },
    options: [
      { en: "Try to hide the damage and hope no one at the office notices the crack later.", es: "Tratar de ocultar el daño y esperar que nadie en la oficina note la grieta después." },
      { en: "Report the damage to the office BEFORE your next scheduled shift starts.", es: "Reportar el daño a la oficina ANTES de que empiece su siguiente turno programado." },
      { en: "Take a quick photo of the broken vacuum housing and post it on your Instagram.", es: "Tomar una foto rápida de la carcasa rota de la aspiradora y publicarla en su Instagram." },
      { en: "Buy a replacement vacuum out of pocket and quietly swap it into the kit bag.", es: "Comprar una aspiradora de reemplazo de su bolsillo y cambiarla discretamente en el kit." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sk-04-lost-key-procedure",
    moduleId: "supply-kit",
    prompt: {
      en: "You realize during a shift that you have misplaced a client's house key. What does the agreement require?",
      es: "Se da cuenta durante un turno de que perdió la llave de la casa de un cliente. ¿Qué requiere el acuerdo?",
    },
    options: [
      { en: "Wait until your shift ends, then casually mention it to the office team after.", es: "Esperar a que termine el turno y luego mencionarlo casualmente a la oficina." },
      { en: "Call the office IMMEDIATELY — Phes coordinates the rekey or code change and pays.", es: "Llamar a la oficina INMEDIATAMENTE — Phes coordina el rekey o cambio de código y lo paga." },
      { en: "Have your spouse swing by the client's home and return the lost key on their way.", es: "Que su cónyuge pase por el hogar del cliente y devuelva la llave perdida de camino." },
      { en: "Make a duplicate key from a spare and continue using that copy on the next visit.", es: "Hacer una llave duplicada de una de repuesto y seguir usando esa copia la próxima visita." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sk-05-supply-pickup-out-of-supplies",
    moduleId: "supply-kit",
    prompt: {
      en: "You realize the night before a job that you are out of a key supply and cannot pick it up from the office in time. What does Phes do?",
      es: "Se da cuenta la noche antes de un trabajo que está sin un suministro clave y no puede recogerlo en la oficina a tiempo. ¿Qué hace Phes?",
    },
    options: [
      { en: "Phes ships me the supplies overnight at the company's expense.", es: "Phes me envía los suministros de un día para otro a cuenta de la compañía." },
      { en: "Phes will not pay for emergency shipping or retail-store time. I am responsible for solving the gap on my own time and at my own expense.", es: "Phes no paga envío urgente ni tiempo en tiendas. Yo soy responsable de resolver la falta en mi tiempo y a mi costo." },
      { en: "Phes pays me for the time and mileage to drive to a retail store to buy the supplies.", es: "Phes me paga el tiempo y millaje para ir a una tienda minorista a comprar los suministros." },
      { en: "Phes excuses me from the job and the client is rescheduled at no fault to me.", es: "Phes me excusa del trabajo y el cliente se reagenda sin culpa para mí." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sk-06-no-automatic-deduction",
    moduleId: "supply-kit",
    prompt: {
      en: "By signing the Supply Kit Agreement, are you pre-authorizing Phes to deduct money from your paycheck automatically for future damage or loss?",
      es: "Al firmar el Acuerdo del Kit de Suministros, ¿está pre-autorizando a Phes a deducir dinero de su pago automáticamente por daños o pérdidas futuros?",
    },
    options: [
      { en: "Yes — your initial signature gives Phes blanket authority for future deductions.", es: "Sí — su firma inicial le da a Phes autoridad general para futuras deducciones." },
      { en: "No — IL 820 ILCS 115 requires a SEPARATE written authorization at each deduction.", es: "No — IL 820 ILCS 115 requiere una autorización escrita SEPARADA en cada deducción." },
      { en: "Yes, but only when the documented damage amount exceeds the $500 threshold.", es: "Sí, pero solo cuando el monto documentado del daño excede el umbral de $500." },
      { en: "Yes, but only during your first 90 days of probationary employment at Phes.", es: "Sí, pero solo durante sus primeros 90 días de empleo probatorio en Phes." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sk-07-supply-pickup-office-hours",
    moduleId: "supply-kit",
    prompt: {
      en: "When can you come to the Phes office to pick up supplies?",
      es: "¿Cuándo puede venir a la oficina de Phes a recoger suministros?",
    },
    options: [
      { en: "Only during my scheduled workday between assigned jobs.", es: "Solo durante mi jornada laboral, entre trabajos asignados." },
      { en: "Any time during office hours, including before my workday, after my workday, or on my days off.", es: "En cualquier momento del horario de oficina, incluyendo antes y después de mi jornada o en mis días libres." },
      { en: "Only on my scheduled days off, never during the workweek.", es: "Solo en mis días libres programados, nunca durante la semana laboral." },
      { en: "I must come to the office every morning before my first job.", es: "Debo venir a la oficina cada mañana antes de mi primer trabajo." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sk-08-supply-pickup-not-compensated",
    moduleId: "supply-kit",
    prompt: {
      en: "When you travel to the office to pick up supplies, are you compensated for the time and mileage?",
      es: "Cuando viaja a la oficina a recoger suministros, ¿se le compensa el tiempo y el millaje?",
    },
    options: [
      { en: "Yes, time and mileage are both fully compensated when picking up supplies.", es: "Sí, tanto el tiempo como el millaje se compensan totalmente al recoger suministros." },
      { en: "No. Supply pickup is preparatory. Travel time is not compensated and mileage is not reimbursed.", es: "No. Recoger suministros es preparatorio. El tiempo de viaje no se compensa y el millaje no se reembolsa." },
      { en: "Only the mileage is reimbursed at the standard rate, but not the time.", es: "Solo el millaje se reembolsa a la tarifa estándar, pero no el tiempo." },
      { en: "Only the time is compensated as part of my scheduled workday, but not the mileage.", es: "Solo el tiempo se compensa como parte de mi jornada laboral, pero no el millaje." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sk-09-supply-pickup-planning",
    moduleId: "supply-kit",
    prompt: {
      en: "You finish a job that is 2 miles from the Phes office. Your supply kit is running low. What is the best practice?",
      es: "Termina un trabajo a 2 millas de la oficina de Phes. Su kit de suministros está bajo. ¿Cuál es la mejor práctica?",
    },
    options: [
      { en: "Continue to my next destination and come back to the office tomorrow during my scheduled workday.", es: "Continuar a mi próximo destino y volver a la oficina mañana durante mi jornada laboral." },
      { en: "Stop at the office to restock supplies, since I am already in the area. Plan pickups around existing travel patterns.", es: "Pasar a la oficina a reabastecer, ya que estoy en el área. Planifico recogidas según mis patrones de viaje." },
      { en: "Wait until I run out of supplies and then come to the office for an emergency pickup.", es: "Esperar a que se me acaben los suministros y luego ir a la oficina por una recogida de emergencia." },
      { en: "Ask the office to deliver supplies to my next location since I am close by.", es: "Pedir a la oficina que entregue suministros en mi próxima ubicación ya que estoy cerca." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sk-10-replacement-process",
    moduleId: "supply-kit",
    prompt: {
      en: "Phes determines that a damaged item must be replaced and you may be billed. What happens next under the Illinois Wage Payment and Collection Act?",
      es: "Phes determina que un artículo dañado debe ser reemplazado y se le puede facturar. ¿Qué pasa después bajo la Ley de Pago de Salarios y Recolección de Illinois?",
    },
    options: [
      { en: "Phes simply deducts the full documented cost from your next regular paycheck.", es: "Phes simplemente deduce el costo documentado completo de su próximo pago regular." },
      { en: "Phes notifies you in writing — a separate signed authorization is required.", es: "Phes le notifica por escrito — se requiere una autorización firmada por separado." },
      { en: "Phes withholds your client tips going forward until the documented cost is paid.", es: "Phes retiene sus propinas de cliente hasta que el costo documentado se pague." },
      { en: "The Phes office immediately files a small-claims court case against you locally.", es: "La oficina de Phes presenta inmediatamente una demanda en corte de reclamos menores." },
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
