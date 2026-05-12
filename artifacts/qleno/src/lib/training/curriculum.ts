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
      en: "Mission, what we do (and don't), attendance, dress code, and conduct.",
      es: "Misión, qué hacemos (y qué no), asistencia, código de vestimenta y conducta.",
    },
    estimatedMinutes: 12,
    blocks: [
      // ── Welcome ────────────────────────────────────────────────────────────
      { type: "h", text: { en: "Welcome to Phes", es: "Bienvenido a Phes" } },
      {
        type: "p",
        text: {
          en: "Phes Cleaning Service is a residential and light-commercial cleaning company serving the Chicago southwest suburbs and northwest suburbs. You are joining a W-2 team — not a contractor pool — with steady scheduled work, real benefits, and a clear path from training to full commission.",
          es: "Phes Cleaning Service es una compañía de limpieza residencial y comercial ligera que sirve a los suburbios del suroeste y noroeste de Chicago. Está uniéndose a un equipo W-2 — no un grupo de contratistas — con trabajo programado constante, beneficios reales y un camino claro del entrenamiento a la comisión completa.",
        },
      },
      { type: "h", text: { en: "Our 24-Hour Satisfaction Guarantee", es: "Garantía de Satisfacción de 24 Horas" } },
      {
        type: "p",
        text: {
          en: "Every Phes cleaning is backed by a 24-hour guarantee — if a client calls within 24 hours unhappy with anything in their home, a team returns the same day to fix it. This is the Fix-It Rule. The returning team is paid normally. We never refuse a guarantee call.",
          es: "Cada limpieza de Phes está respaldada por una garantía de 24 horas — si un cliente llama dentro de las 24 horas inconforme con cualquier cosa en su hogar, un equipo regresa el mismo día para corregirlo. Esto es la Regla de Corrección. El equipo que regresa recibe pago normal. Nunca rechazamos una llamada de garantía.",
        },
      },
      { type: "h", text: { en: "What Phes Does NOT Do", es: "Lo que Phes NO Hace" } },
      {
        type: "bullets",
        items: [
          { en: "Bodily fluids — blood, vomit, urine, feces. Decline politely; the office can refer a biohazard service.", es: "Fluidos corporales — sangre, vómito, orina, heces. Rechace cortésmente; la oficina puede referir un servicio de biohazard." },
          { en: "Inside the oven, refrigerator, or freezer — NOT in default scope. If a client asks mid-job, call the office; we can often add it same-day with pricing.", es: "Dentro del horno, refrigerador o congelador — NO está en el alcance estándar. Si un cliente lo pide a mitad del trabajo, llame a la oficina; muchas veces lo agregamos el mismo día con precio." },
          { en: "Pet waste, including litter boxes (we clean around them, not into them).", es: "Desechos de mascotas, incluyendo cajas de arena (limpiamos alrededor, no dentro)." },
          { en: "Cash transactions on site — all payment goes through the office.", es: "Transacciones en efectivo en el sitio — todo pago pasa por la oficina." },
          { en: "Climbing higher than the company-issued step stool — we do not stand on furniture.", es: "Subir más alto que el banquito de la compañía — no nos paramos sobre muebles." },
          { en: "Wash dishes.", es: "Lavar platos." },
          { en: "Make beds.", es: "Tender camas." },
          { en: "Move heavy furniture (we clean around it, never lift or relocate).", es: "Mover muebles pesados (limpiamos alrededor, nunca levantamos ni movemos)." },
          { en: "Clean window tracks.", es: "Limpiar rieles de ventanas." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "These are STANDARD guidelines. The office may grant exceptions — for a slower week, a loyal client, or a company partner — and will communicate them via app notes or a direct message. If you see an exception note in the app, follow it. If a client asks you to do something on this list and there's NO note, decline politely and tell them you'll let the office know — never improvise outside scope.",
          es: "Estas son guías ESTÁNDAR. La oficina puede otorgar excepciones — para una semana más lenta, un cliente leal o un socio de la compañía — y las comunicará por notas en la aplicación o un mensaje directo. Si ve una nota de excepción en la aplicación, sígala. Si un cliente le pide hacer algo de esta lista y NO hay nota, rechace cortésmente y dígale que le informará a la oficina — nunca improvise fuera del alcance.",
        },
      },
      { type: "h", text: { en: "Tipping", es: "Propinas" } },
      {
        type: "p",
        text: {
          en: "Tips are appreciated and 100% yours. The office never holds a tip. Cash tips: keep them. Tips left through the booking system: paid out on your next paycheck. You do not owe a kickback to anyone — your pay matrix is your pay.",
          es: "Las propinas se agradecen y son 100% suyas. La oficina nunca retiene una propina. Propinas en efectivo: quédeselas. Propinas a través del sistema de reservas: se pagan en su próximo cheque. No le debe ningún porcentaje a nadie — su matriz de pago es su pago.",
        },
      },

      // ── Attendance ─────────────────────────────────────────────────────────
      { type: "h", text: { en: "Attendance — Grace Period", es: "Asistencia — Periodo de Gracia" } },
      {
        type: "p",
        text: {
          en: "You have a 20-minute grace window after your scheduled clock-in time. Beyond 20 minutes, the visit is recorded as tardy. Always call the office BEFORE the 20-minute mark if you'll be late — even within the grace window. Communication closes the gap; silence triggers the dispatch board's late chip.",
          es: "Tiene un periodo de gracia de 20 minutos después de la hora programada. Más allá de 20 minutos, la visita se registra como tardanza. Siempre llame a la oficina ANTES del minuto 20 si llegará tarde — incluso dentro del periodo de gracia. La comunicación cierra la brecha; el silencio activa el chip de tardanza en el tablero de despacho.",
        },
      },
      { type: "h", text: { en: "Tardiness Scale", es: "Escala de Tardanzas" } },
      {
        type: "table",
        head: { en: ["Occurrence", "Action"], es: ["Ocurrencia", "Acción"] },
        rows: [
          { en: ["1st", "Recorded — coaching conversation"], es: ["1ª", "Registrada — conversación de orientación"] },
          { en: ["2nd", "Recorded — coaching conversation"], es: ["2ª", "Registrada — conversación de orientación"] },
          { en: ["3rd", "Written warning"], es: ["3ª", "Advertencia por escrito"] },
          { en: ["4th", "Final warning"], es: ["4ª", "Última advertencia"] },
          { en: ["5th", "Termination"], es: ["5ª", "Terminación"] },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "No-call / no-show is treated more seriously than tardiness and may result in immediate final warning or termination.",
          es: "No llamar / no presentarse se trata con más seriedad que las tardanzas y puede resultar en una última advertencia inmediata o terminación.",
        },
      },

      // ── Four-Bucket Order of Use ──────────────────────────────────────────
      { type: "h", text: { en: "The Four Leave Buckets — Order of Use", es: "Las Cuatro Cubetas de Licencia — Orden de Uso" } },
      {
        type: "p",
        text: {
          en: "Phes uses four leave buckets to cover absences. They are used IN ORDER. As long as a bucket is available and you give the right notice, the absence is excused and does NOT count toward the discipline scale. An absence becomes unexcused only when (a) you no-call/no-show OR (b) all four buckets are exhausted and you didn't get advance approval for unpaid time.",
          es: "Phes usa cuatro cubetas de licencia para cubrir ausencias. Se usan EN ORDEN. Mientras una cubeta esté disponible y dé el aviso correcto, la ausencia es justificada y NO cuenta hacia la escala de disciplina. Una ausencia se vuelve injustificada solo cuando (a) no llama / no se presenta O (b) las cuatro cubetas están agotadas y no obtuvo aprobación previa para tiempo no pagado.",
        },
      },
      {
        type: "table",
        head: {
          en: ["#", "Bucket", "Hours", "Eligible", "Notice", "Can be denied?", "Paid out?"],
          es: ["#", "Cubeta", "Horas", "Elegible", "Aviso", "¿Puede negarse?", "¿Se paga?"],
        },
        rows: [
          { en: ["1", "PLAWA (paid sick)", "40 / year", "After 90 days", "Grace call only", "No — protected", "No"],
            es: ["1", "PLAWA (enfermedad pagada)", "40 / año", "Después de 90 días", "Solo llamada de gracia", "No — protegida", "No"] },
          { en: ["2", "PTO", "40 → 80 / year", "After 1 year", "7 days advance", "Yes — business needs", "Yes"],
            es: ["2", "PTO", "40 → 80 / año", "Después de 1 año", "7 días anticipados", "Sí — necesidades del negocio", "Sí"] },
          { en: ["3", "Unpaid Personal Leave", "40 / year (5 days)", "Day one", "7 days advance", "Yes — business needs", "No"],
            es: ["3", "Licencia Personal No Pagada", "40 / año (5 días)", "Primer día", "7 días anticipados", "Sí — necesidades del negocio", "No"] },
          { en: ["4", "Unpaid Absence Allowance", "40 / year", "After 90 days", "Grace call only", "No — last bucket before discipline", "No"],
            es: ["4", "Tolerancia de Ausencia No Pagada", "40 / año", "Después de 90 días", "Solo llamada de gracia", "No — última cubeta antes de disciplina", "No"] },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "PLAWA is used by DEFAULT — unless you elect in writing to draw from a different bucket. This protects your PTO for planned vacations and your other buckets for emergencies later in the year.",
          es: "PLAWA se usa POR DEFECTO — a menos que elija por escrito usar otra cubeta. Esto protege su PTO para vacaciones planeadas y sus otras cubetas para emergencias más adelante en el año.",
        },
      },

      { type: "h", text: { en: "Paid Sick Leave (PLAWA) — What You Need to Know", es: "Licencia por Enfermedad Pagada (PLAWA) — Lo Que Debe Saber" } },
      {
        type: "bullets",
        items: [
          { en: "40 paid hours per Benefit Year, front-loaded after 90 days of employment.", es: "40 horas pagadas por Año de Beneficios, otorgadas por adelantado después de 90 días de empleo." },
          { en: "Use it for ANY reason — your illness, a family member's illness, mental health day, medical appointment, etc. You never have to give a reason.", es: "Úselo por CUALQUIER razón — su enfermedad, enfermedad de un familiar, salud mental, cita médica, etc. Nunca tiene que dar una razón." },
          { en: "Phes NEVER requires a doctor's note or supporting documentation to use PLAWA — regardless of how long the absence is. Phes policy is stricter than Illinois law on this point: we choose not to require any documentation.", es: "Phes NUNCA exige nota médica ni documentación de respaldo para usar PLAWA — sin importar la duración de la ausencia. La política de Phes es más estricta que la ley de Illinois en este punto: elegimos no exigir documentación alguna." },
          { en: "Minimum block: 2 hours. Notice: the 20-minute grace call is all that's required — no advance approval needed. Use it the moment you know you need it.", es: "Bloque mínimo: 2 horas. Aviso: la llamada de gracia de 20 minutos es todo lo que se requiere — no se necesita aprobación previa. Úselo en el momento en que sepa que lo necesita." },
          { en: "Cannot be denied for business needs. The max-2-cleaners-off and route-coverage rules apply to PTO and Unpaid Personal Leave only — PLAWA is protected leave.", es: "No se puede negar por necesidades del negocio. Las reglas de máximo 2 cleaners libres y cobertura de ruta aplican solo al PTO y a la Licencia Personal No Pagada — el PLAWA es licencia protegida." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Sick time is NOT PTO. They are SEPARATE buckets. PLAWA is gone at the end of your Benefit Year and is NOT paid out when you leave Phes (PTO is). Using your sick hours does not reduce your PTO bank, and vice versa. Sick-time requests follow the same two-step process: submit through MaidCentral / Qleno AND contact Maribel or Francisco at the office.",
          es: "El tiempo por enfermedad NO es PTO. Son cubetas SEPARADAS. PLAWA se pierde al final de su Año de Beneficios y NO se paga cuando deja Phes (el PTO sí). Usar sus horas por enfermedad no reduce su banco de PTO, ni al revés. Las solicitudes de tiempo por enfermedad siguen el mismo proceso de dos pasos: envíe por MaidCentral / Qleno Y contacte a Maribel o Francisco en la oficina.",
        },
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Out of PLAWA hours? You do NOT go straight to discipline. The office cascades down the bucket order — PTO next, then Unpaid Personal Leave, then Unpaid Absence Allowance. As long as one bucket still has hours and you give the right notice, the absence stays excused.",
          es: "¿Sin horas de PLAWA? NO pasa directamente a la disciplina. La oficina baja por el orden de cubetas — PTO siguiente, luego Licencia Personal No Pagada, luego Tolerancia de Ausencia No Pagada. Mientras una cubeta tenga horas y dé el aviso correcto, la ausencia se mantiene justificada.",
        },
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Dispatched into City of Chicago? Chicago has its own ordinance with TWO separate leave buckets (Paid Leave + Paid Sick & Safe Leave). If you regularly work jobs inside city limits, talk to the office — your accruals may stack differently. Standard Phes PLAWA still applies in the suburbs (Cook County mirrors state law).",
          es: "¿Despachado dentro de la Ciudad de Chicago? Chicago tiene su propia ordenanza con DOS cubetas separadas (Licencia Pagada + Licencia Pagada por Enfermedad y Seguridad). Si trabaja regularmente dentro de los límites de la ciudad, hable con la oficina — sus acumulaciones pueden apilarse diferente. El PLAWA estándar de Phes sigue aplicando en los suburbios (Cook County refleja la ley estatal).",
        },
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "NO retaliation. By law, Phes cannot discipline, demote, fire, or penalize you for lawfully using PLAWA. If you ever feel pressure for taking a sick day, tell the office immediately.",
          es: "SIN represalias. Por ley, Phes no puede disciplinar, degradar, despedir o penalizarlo por usar PLAWA legalmente. Si alguna vez siente presión por tomar un día por enfermedad, dígale a la oficina de inmediato.",
        },
      },
      { type: "h", text: { en: "Paid Time Off (PTO)", es: "Tiempo Libre Pagado (PTO)" } },
      {
        type: "bullets",
        items: [
          { en: "After 1 year (first work anniversary): 40 hours PTO per year.", es: "Después de 1 año (primer aniversario): 40 horas de PTO por año." },
          { en: "After 2 years and beyond: bank is topped up to 80 hours each anniversary.", es: "Después de 2 años en adelante: el banco se rellena hasta 80 horas en cada aniversario." },
          { en: "Hard cap: PTO does NOT exceed 80 hours total at any time. Unused PTO does NOT stack — we top up to the cap, we do not add on top.", es: "Tope estricto: el PTO NUNCA excede 80 horas totales. El PTO no usado NO se acumula — rellenamos hasta el tope, no agregamos encima." },
          { en: "Request through the app in advance AND contact Maribel or Francisco at the office to confirm — same two-step process as sick time.", es: "Solicite por la app con anticipación Y contacte a Maribel o Francisco en la oficina para confirmar — el mismo proceso de dos pasos del tiempo por enfermedad." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Example: in your first PTO year you used only 20 of your 40 hours. At your 2-year anniversary, the office tops your bank up to 80 hours — NOT 20 carried over plus 80 = 100. The maximum balance is always 80.",
          es: "Ejemplo: en su primer año de PTO usó solo 20 de sus 40 horas. En su aniversario de 2 años, la oficina rellena su banco hasta 80 horas — NO 20 acumuladas + 80 = 100. El balance máximo siempre es 80.",
        },
      },
      { type: "h", text: { en: "PTO Approval Rules — Read This Before You Request", es: "Reglas de Aprobación de PTO — Lea Esto Antes de Solicitar" } },
      {
        type: "bullets",
        items: [
          { en: "FIRST COME, FIRST SERVE. Earlier requests for a given date win — submit early, especially for popular dates (holidays, school breaks, summer Fridays).", es: "PRIMERO EN LLEGAR, PRIMERO EN SER ATENDIDO. Las solicitudes más tempranas para una fecha ganan — envíe temprano, sobre todo para fechas populares (feriados, vacaciones escolares, viernes de verano)." },
          { en: "MAXIMUM 2 CLEANERS OFF on the same day. If two techs already have an approved day, additional requests for that date will be declined.", es: "MÁXIMO 2 CLEANERS LIBRES el mismo día. Si dos técnicos ya tienen el día aprobado, las solicitudes adicionales para esa fecha serán rechazadas." },
          { en: "BUSINESS NEEDS COME FIRST. Even within the 2-per-day cap, the office may decline a request if it leaves a route uncovered or a key client unstaffed. Approval is never guaranteed.", es: "LAS NECESIDADES DE LA EMPRESA VAN PRIMERO. Incluso dentro del tope de 2 por día, la oficina puede rechazar una solicitud si deja una ruta descubierta o un cliente clave sin personal. La aprobación nunca está garantizada." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Do NOT assume your request is approved until Maribel or Francisco confirms it. Buying a flight or booking travel before approval is your own risk — if the date is already filled by two earlier requests, or if business needs override, your request will be denied.",
          es: "NO asuma que su solicitud está aprobada hasta que Maribel o Francisco lo confirmen. Comprar un vuelo o reservar viajes antes de la aprobación es su propio riesgo — si la fecha ya está llena con dos solicitudes anteriores, o si las necesidades del negocio anulan, su solicitud será rechazada.",
        },
      },
      { type: "h", text: { en: "Unpaid Personal Days (Named Time Off)", es: "Días Personales No Pagados (Tiempo Libre Nombrado)" } },
      {
        type: "bullets",
        items: [
          { en: "Up to 5 unpaid personal days per year = 40 hours of unpaid time off.", es: "Hasta 5 días personales no pagados por año = 40 horas de tiempo libre no pagado." },
          { en: "Logged in MaidCentral as 'Named Time Off' days.", es: "Registrados en MaidCentral como días de 'Named Time Off' (Tiempo Libre Nombrado)." },
          { en: "Same two-step request as PTO and sick time — submit in the system AND contact Maribel or Francisco.", es: "Misma solicitud de dos pasos que el PTO y enfermedad — envíe por el sistema Y contacte a Maribel o Francisco." },
          { en: "Approval is at management discretion. The same first-come-first-serve, max-2-cleaners-off, business-needs-first rules apply.", es: "La aprobación es a discreción de la gerencia. Aplican las mismas reglas de primero-en-llegar, máximo-2-cleaners-libres, necesidades-del-negocio-primero." },
          { en: "Do not carry over to next year. Not paid out at separation.", es: "No se acumulan al año siguiente. No se pagan al separarse." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Unpaid Personal Leave is bucket #3 of 4. It's used after PLAWA and PTO are exhausted for PLANNED time off (kid's school event, out-of-town wedding, etc.). Notice and approval rules match PTO — 7 days advance, FCFS, max-2-off, business needs can override.",
          es: "La Licencia Personal No Pagada es la cubeta #3 de 4. Se usa después de agotar PLAWA y PTO para tiempo libre PLANEADO (evento escolar de un hijo, boda fuera de la ciudad, etc.). El aviso y las reglas de aprobación coinciden con el PTO — 7 días anticipados, primero en llegar, máximo 2 libres, las necesidades del negocio pueden anular.",
        },
      },

      // ── Unpaid Absence Allowance (bucket 4 of 4) ──────────────────────────
      { type: "h", text: { en: "Unpaid Absence Allowance (Bucket #4 of 4)", es: "Tolerancia de Ausencia No Pagada (Cubeta #4 de 4)" } },
      {
        type: "bullets",
        items: [
          { en: "Up to 40 unpaid hours per Benefit Year. Available after 90 days of employment.", es: "Hasta 40 horas no pagadas por Año de Beneficios. Disponible después de 90 días de empleo." },
          { en: "Notice: the 20-minute grace call only — same as PLAWA, no advance approval required.", es: "Aviso: solo la llamada de gracia de 20 minutos — igual que PLAWA, no requiere aprobación previa." },
          { en: "Used by Phes to cover UNPLANNED absences after PLAWA, PTO, and Unpaid Personal Leave are exhausted (e.g., another sick day, a same-day family emergency).", es: "Phes la usa para cubrir ausencias NO PLANEADAS después de agotar PLAWA, PTO y la Licencia Personal No Pagada (p. ej., otro día por enfermedad, una emergencia familiar del mismo día)." },
          { en: "Does not carry over. Not paid out at separation.", es: "No se acumula. No se paga al separarse." },
          { en: "This is the LAST bucket before the discipline scale kicks in. Once it's exhausted, additional unprotected absences are unexcused.", es: "Es la ÚLTIMA cubeta antes de que se active la escala de disciplina. Una vez agotada, las ausencias adicionales no protegidas son injustificadas." },
        ],
      },
      { type: "h", text: { en: "What Gets Paid Out When You Leave", es: "Qué Se Paga al Salir" } },
      {
        type: "bullets",
        items: [
          { en: "PTO (vacation): any unused PTO IS paid out at separation, per Illinois Wage Payment & Collection Act.", es: "PTO (vacaciones): el PTO no usado SÍ se paga al separarse, conforme a la Ley de Pago y Cobranza de Salarios de Illinois." },
          { en: "PLAWA (paid sick leave): NOT paid out at separation. PLAWA has no cash value.", es: "PLAWA (licencia por enfermedad pagada): NO se paga al separarse. PLAWA no tiene valor en efectivo." },
          { en: "Holidays: not banked — only paid for the holiday itself, see eligibility below.", es: "Feriados: no se acumulan — solo se pagan en el día del feriado, vea la elegibilidad abajo." },
        ],
      },
      { type: "h", text: { en: "Time-Off Requests — Two-Step Process", es: "Solicitudes de Tiempo Libre — Proceso de Dos Pasos" } },
      {
        type: "p",
        text: {
          en: "Every time-off request — PTO, sick day, schedule change — requires BOTH steps so the schedule gets updated AND the office knows directly.",
          es: "Toda solicitud de tiempo libre — PTO, día por enfermedad, cambio de horario — requiere AMBOS pasos para que el horario se actualice Y la oficina sepa directamente.",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "STEP 1 — Submit the request through MaidCentral (and Qleno once we cut over). This is what dispatch sees and what triggers client notifications.", es: "PASO 1 — Envíe la solicitud por MaidCentral (y Qleno una vez que cambiemos). Esto es lo que ve el despacho y lo que activa las notificaciones al cliente." },
          { en: "STEP 2 — Contact Maribel or Francisco at the office directly (text or call) to confirm they've seen it. The system request alone is not enough.", es: "PASO 2 — Contacte a Maribel o Francisco en la oficina directamente (mensaje o llamada) para confirmar que la vieron. La solicitud por el sistema sola no es suficiente." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "If you only text Maribel or Francisco without the system request, dispatch won't see it and the client won't get notified. If you only submit in the system without contacting them, the office might not see it in time. Both are required, every time.",
          es: "Si solo envía mensaje a Maribel o Francisco sin la solicitud por el sistema, despacho no lo verá y el cliente no será notificado. Si solo envía por el sistema sin contactarlos, la oficina puede no verlo a tiempo. Ambos son requeridos, cada vez.",
        },
      },
      { type: "h", text: { en: "Unexcused Absences — When the Discipline Scale Kicks In", es: "Ausencias Injustificadas — Cuándo Se Activa la Escala de Disciplina" } },
      {
        type: "p",
        text: {
          en: "An absence is unexcused ONLY when (a) it's a no-call/no-show, OR (b) all four leave buckets are exhausted AND you didn't get advance approval for unpaid time. Using any bucket with proper notice is excused — full stop. Once an absence IS unexcused, the discipline scale applies:",
          es: "Una ausencia es injustificada SOLO cuando (a) es un no llamó / no se presentó, O (b) las cuatro cubetas están agotadas Y no obtuvo aprobación previa para tiempo no pagado. Usar cualquier cubeta con aviso apropiado es justificado — sin excepciones. Una vez que una ausencia ES injustificada, aplica la escala de disciplina:",
        },
      },
      {
        type: "table",
        head: { en: ["Occurrence", "Action"], es: ["Ocurrencia", "Acción"] },
        rows: [
          { en: ["1st", "Recorded"], es: ["1ª", "Registrada"] },
          { en: ["2nd", "Recorded"], es: ["2ª", "Registrada"] },
          { en: ["3rd", "Written warning"], es: ["3ª", "Advertencia por escrito"] },
          { en: ["4th", "Final warning"], es: ["4ª", "Última advertencia"] },
          { en: ["5th", "Termination"], es: ["5ª", "Terminación"] },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Using PLAWA — with the grace call — can NEVER count toward this scale, ever. No matter how many sick days you take, the absences are protected as long as you make the call and you have hours.",
          es: "Usar PLAWA — con la llamada de gracia — NUNCA puede contar hacia esta escala. Sin importar cuántos días por enfermedad tome, las ausencias están protegidas mientras haga la llamada y tenga horas.",
        },
      },
      { type: "h", text: { en: "Paid Holidays", es: "Feriados Pagados" } },
      {
        type: "p",
        text: {
          en: "Phes observes 6 paid holidays plus your birthday: New Year's Day, Memorial Day, Independence Day, Labor Day, Thanksgiving, Christmas Day, and your birthday (taken any day that month).",
          es: "Phes observa 6 feriados pagados más su cumpleaños: Año Nuevo, Memorial Day, Día de la Independencia, Día del Trabajo, Acción de Gracias, Navidad, y su cumpleaños (cualquier día de ese mes).",
        },
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Eligibility: holiday pay starts AFTER 90 days of employment. Any holiday that falls in your first 90 days is unpaid for you, even if it's an observed Phes holiday.",
          es: "Elegibilidad: el pago por feriados comienza DESPUÉS de 90 días de empleo. Cualquier feriado que caiga en sus primeros 90 días es no pagado para usted, incluso si es un feriado observado por Phes.",
        },
      },
      // ── Other Leave Types ──────────────────────────────────────────────────
      { type: "h", text: { en: "Bereavement Leave", es: "Licencia por Duelo" } },
      {
        type: "p",
        text: {
          en: "If an immediate family member passes away — spouse, child, parent, or sibling — Phes provides up to 3 paid days at your regular rate. Notify the office as soon as practicable. Extended family (grandparent, in-law, aunt/uncle) is handled case-by-case as unpaid time off; ask the office.",
          es: "Si un familiar inmediato fallece — cónyuge, hijo/a, padre/madre o hermano/a — Phes ofrece hasta 3 días pagados a su tarifa regular. Notifique a la oficina lo antes posible. Familiares extendidos (abuelo/a, suegros, tíos) se manejan caso por caso como tiempo libre no pagado; pregunte a la oficina.",
        },
      },
      { type: "h", text: { en: "Jury Duty", es: "Servicio de Jurado" } },
      {
        type: "p",
        text: {
          en: "Jury service is unpaid by Phes. Your job is protected — you cannot be disciplined or terminated for attending — and you keep any juror compensation the court provides. Bring your summons or proof of service to the office before the date and notify your dispatcher.",
          es: "El servicio de jurado no es pagado por Phes. Su empleo está protegido — no puede ser disciplinado ni despedido por asistir — y se queda con la compensación del tribunal. Traiga la citación o comprobante a la oficina antes de la fecha y notifique al despachador.",
        },
      },
      { type: "h", text: { en: "Lactation Breaks", es: "Pausas de Lactancia" } },
      {
        type: "p",
        text: {
          en: "Reasonable lactation breaks are PAID at your regular rate and do NOT deduct from PLAWA or PTO. The office will work with you on timing and a private location at the office or between jobs. This is mandatory under Illinois law and the Phes handbook.",
          es: "Las pausas de lactancia razonables se PAGAN a su tarifa regular y NO se descuentan de PLAWA ni PTO. La oficina coordinará con usted el tiempo y un lugar privado en la oficina o entre trabajos. Es obligatorio bajo la ley de Illinois y el manual de Phes.",
        },
      },
      { type: "h", text: { en: "Pregnancy Accommodation", es: "Acomodación por Embarazo" } },
      {
        type: "p",
        text: {
          en: "Illinois requires Phes to provide reasonable accommodations during pregnancy — examples: lighter duties, more frequent breaks, adjusted lifting limits, modified schedule, or temporary reassignment. Ask the office; we'll work out an accommodation that keeps you safely working as long as you choose to.",
          es: "Illinois requiere que Phes brinde acomodaciones razonables durante el embarazo — ejemplos: tareas más ligeras, pausas más frecuentes, límites ajustados de carga, horario modificado o reasignación temporal. Pregunte a la oficina; coordinaremos una acomodación que la mantenga trabajando con seguridad mientras usted decida hacerlo.",
        },
      },

      // ── Dress Code & Conduct ───────────────────────────────────────────────
      { type: "h", text: { en: "Uniform — Mandatory", es: "Uniforme — Obligatorio" } },
      {
        type: "p",
        text: {
          en: "You must arrive at every job in full Phes attire — the company-issued shirt and pants. The uniform is what every client expects to see at their door, and it is how we keep the brand consistent across hundreds of homes a week.",
          es: "Debe llegar a cada trabajo con el uniforme Phes completo — la camisa y los pantalones provistos por la compañía. El uniforme es lo que cada cliente espera ver en su puerta y es como mantenemos la marca consistente en cientos de hogares por semana.",
        },
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "No personal clothing substitutions — even if your uniform is dirty or you forgot it. If you don't have your uniform, contact the office BEFORE the job. Do not show up at a client's home out of uniform.",
          es: "No se permiten sustituciones de ropa personal — incluso si el uniforme está sucio o lo olvidó. Si no tiene su uniforme, contacte a la oficina ANTES del trabajo. No se presente en el hogar de un cliente fuera de uniforme.",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Phes-issued shirt — clean, untucked is acceptable, no visible stains.", es: "Camisa Phes — limpia, sin manchas visibles, puede llevarse por fuera." },
          { en: "Phes-issued pants in good condition. No shorts, no leggings as outerwear.", es: "Pantalones Phes en buen estado. Sin shorts, sin leggings como ropa exterior." },
          { en: "Closed-toe athletic shoes. No sandals, no Crocs, no open backs.", es: "Calzado deportivo cerrado. Sin sandalias, sin Crocs, sin parte trasera abierta." },
          { en: "Hair tied back if shoulder-length or longer.", es: "Cabello recogido si llega a los hombros o más largo." },
          { en: "Jewelry minimal — no large rings or bracelets that can scratch surfaces.", es: "Joyería mínima — sin anillos ni pulseras grandes que puedan rayar superficies." },
        ],
      },
      { type: "h", text: { en: "Shoe Covers", es: "Cubrezapatos" } },
      {
        type: "p",
        text: {
          en: "Shoe covers are mandatory inside every client home from the moment you cross the threshold. Change covers between homes. Never reuse covers from a previous job.",
          es: "Los cubrezapatos son obligatorios dentro de cada hogar desde el momento en que cruza el umbral. Cambie los cubrezapatos entre hogares. Nunca reutilice cubrezapatos de un trabajo anterior.",
        },
      },
      { type: "h", text: { en: "Personal Phone Use", es: "Uso de Teléfono Personal" } },
      {
        type: "p",
        text: {
          en: "Personal cell phones are not allowed during a job. Keep your phone in your bag or vehicle. The only phone use during a job is the company app for clock-in / check-in / job worksheet — and only when stepping aside briefly. Personal calls, texts, and social media wait until break or after the visit.",
          es: "No se permiten teléfonos personales durante un trabajo. Mantenga su teléfono en su bolso o vehículo. El único uso permitido durante un trabajo es la aplicación de la compañía para Clock In / Check In / Hoja de Trabajo — y solo apartándose brevemente. Llamadas personales, mensajes y redes sociales esperan hasta el descanso o después de la visita.",
        },
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Photos or videos of client homes are strictly forbidden — except photos taken inside the company app for documenting completed work or damage.",
          es: "Fotos o videos de hogares de clientes están estrictamente prohibidos — excepto fotos tomadas dentro de la aplicación de la compañía para documentar trabajo completado o daños.",
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
  // 6. SEXUAL HARASSMENT PREVENTION TRAINING
  // Required annually by the Illinois Human Rights Act (775 ILCS 5/2-109).
  // First completion happens during onboarding; annual recompletion by
  // Dec 31 of each calendar year. Annual-reset machinery is a follow-up.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: "sexual-harassment-prevention",
    number: 6,
    iconKind: "shield",
    title: {
      en: "Sexual Harassment Prevention Training",
      es: "Capacitación de Prevención de Acoso Sexual",
    },
    subtitle: {
      en: "Annual Requirement: Due by December 31. Required by Illinois law (IHRA, 775 ILCS 5/2-109).",
      es: "Requisito Anual: Para Completarse Antes del 31 de Diciembre. Requerido por la ley de Illinois (IHRA, 775 ILCS 5/2-109).",
    },
    estimatedMinutes: 20,
    blocks: [
      // ── Introduction ───────────────────────────────────────────────────────
      { type: "h", text: { en: "Why You Are Taking This Training", es: "Por Qué Está Tomando Esta Capacitación" } },
      {
        type: "p",
        text: {
          en: "This training is required by the Illinois Human Rights Act for every employee in Illinois, every year. It applies to all Phes employees, regardless of role, gender, tenure, or whether you work in homes, offices, or the office itself. You must complete it once during onboarding and again every year by December 31.",
          es: "Esta capacitación es requerida por la Ley de Derechos Humanos de Illinois para cada empleado en Illinois, cada año. Aplica a todos los empleados de Phes, sin importar el puesto, género, antigüedad, o si trabaja en hogares, oficinas o la propia oficina. Debe completarla una vez durante la incorporación y nuevamente cada año antes del 31 de diciembre.",
        },
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Phes is committed to a workplace free from sexual harassment, discrimination, and retaliation. This training is here to make sure you know what harassment looks like, what your rights are, and how to report concerns safely.",
          es: "Phes se compromete a mantener un lugar de trabajo libre de acoso sexual, discriminación y represalias. Esta capacitación está aquí para asegurar que sepa cómo se ve el acoso, cuáles son sus derechos y cómo reportar inquietudes con seguridad.",
        },
      },

      // ── Section A: What is Sexual Harassment? ──────────────────────────────
      { type: "h", text: { en: "What is Sexual Harassment?", es: "Qué Es el Acoso Sexual" } },
      {
        type: "p",
        text: {
          en: "Under the Illinois Human Rights Act, sexual harassment is unwelcome sexual advances, requests for sexual favors, or any conduct of a sexual nature when ONE OR MORE of these is true:",
          es: "Bajo la Ley de Derechos Humanos de Illinois, el acoso sexual es cualquier insinuación sexual no deseada, petición de favores sexuales, o cualquier conducta de naturaleza sexual cuando UNA O MÁS de estas es cierta:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Submission to the conduct is made (openly or implicitly) a condition of getting hired, keeping a job, or getting work assignments.", es: "Aceptar la conducta se convierte (de forma abierta o implícita) en condición para ser contratado, mantener el empleo o recibir trabajos." },
          { en: "Submitting to or refusing the conduct is used as the basis for an employment decision (raises, hours, schedule, discipline, termination).", es: "Aceptar o rechazar la conducta se usa como base para una decisión de empleo (aumentos, horas, horario, disciplina, terminación)." },
          { en: "The conduct interferes with your work performance OR creates an intimidating, hostile, or offensive working environment.", es: "La conducta interfiere con su desempeño en el trabajo O crea un ambiente de trabajo intimidante, hostil u ofensivo." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "It does not matter whether the conduct was meant as a joke, was framed as a compliment, or whether the person doing it thought it was harmless. What matters is whether the conduct was unwelcome and whether it meets one of the conditions above. Harassment can happen between people of any gender, sexual orientation, or relationship.",
          es: "No importa si la conducta fue como broma, presentada como cumplido, o si la persona que la hizo pensó que era inofensiva. Lo que importa es si la conducta fue no deseada y si cumple con una de las condiciones anteriores. El acoso puede ocurrir entre personas de cualquier género, orientación sexual o relación.",
        },
      },

      // ── Section B: Examples of Unlawful Sexual Harassment ─────────────────
      { type: "h", text: { en: "Examples of Unlawful Sexual Harassment", es: "Ejemplos de Acoso Sexual Ilegal" } },
      {
        type: "p",
        text: {
          en: "Sexual harassment shows up in three main shapes. Here is what each looks like in real cleaning-services scenarios.",
          es: "El acoso sexual se presenta de tres formas principales. Aquí está cómo se ve cada una en escenarios reales de servicios de limpieza.",
        },
      },
      { type: "h", text: { en: "1. Verbal Harassment", es: "1. Acoso Verbal" } },
      {
        type: "bullets",
        items: [
          { en: "A coworker repeatedly comments on your body, clothing, or appearance after you have asked them to stop.", es: "Un compañero comenta repetidamente sobre su cuerpo, ropa o apariencia después de que le pidió que parara." },
          { en: "A supervisor tells off-color sexual jokes during morning huddle and laughs them off when someone looks uncomfortable.", es: "Un supervisor cuenta chistes sexuales de mal gusto durante la junta de la mañana y los ignora cuando alguien se ve incómodo." },
          { en: "A client makes sexual comments about you or repeatedly asks about your dating life during a clean.", es: "Un cliente hace comentarios sexuales sobre usted o pregunta repetidamente sobre su vida amorosa durante una limpieza." },
          { en: "A coworker spreads sexual rumors about another teammate to the rest of the crew.", es: "Un compañero esparce rumores sexuales sobre otro miembro del equipo al resto de la cuadrilla." },
        ],
      },
      { type: "h", text: { en: "2. Physical Harassment", es: "2. Acoso Físico" } },
      {
        type: "bullets",
        items: [
          { en: "Unwanted touching, hugging, kissing, or brushing against another person's body.", es: "Tocar, abrazar, besar o rozarse contra el cuerpo de otra persona sin consentimiento." },
          { en: "Blocking someone's path in a hallway or doorway in a way that feels threatening or intimate.", es: "Bloquear el paso de alguien en un pasillo o puerta de forma amenazante o íntima." },
          { en: "Showing sexual images on a phone, in the truck, or at the office without invitation.", es: "Mostrar imágenes sexuales en un teléfono, en la camioneta o en la oficina sin invitación." },
          { en: "A client touching your arm, back, or waist while you clean and not stopping when you move away.", es: "Un cliente toca su brazo, espalda o cintura mientras limpia y no para cuando se aparta." },
        ],
      },
      { type: "h", text: { en: "3. Quid Pro Quo (Trading Job Benefits for Sexual Favors)", es: "3. Quid Pro Quo (Cambiar Beneficios Laborales por Favores Sexuales)" } },
      {
        type: "bullets",
        items: [
          { en: "A supervisor offers you better routes or extra hours if you go on a date with them.", es: "Un supervisor le ofrece mejores rutas u horas extra si sale con ellos en una cita." },
          { en: "A supervisor threatens to write you up, reduce your hours, or fire you if you refuse a sexual advance.", es: "Un supervisor amenaza con escribirle un reporte, reducir sus horas o despedirlo si rechaza una insinuación sexual." },
          { en: "A client offers a large tip in exchange for you staying after the clean for a personal favor.", es: "Un cliente ofrece una propina grande a cambio de quedarse después de la limpieza para un favor personal." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Quid pro quo harassment is illegal even if it only happens once. You do not need to give in, and you do not need a pattern. Report it immediately.",
          es: "El acoso quid pro quo es ilegal incluso si solo ocurre una vez. No tiene que ceder, y no necesita un patrón. Repórtelo de inmediato.",
        },
      },
      { type: "h", text: { en: "Borderline Situations to Watch For", es: "Situaciones Limítrofes a Las Que Estar Atento" } },
      {
        type: "p",
        text: {
          en: "Some situations are not always obvious. The test is whether the conduct is unwelcome and whether it would make a reasonable person feel uncomfortable, intimidated, or unsafe.",
          es: "Algunas situaciones no siempre son obvias. La prueba es si la conducta es no deseada y si haría que una persona razonable se sintiera incómoda, intimidada o insegura.",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "A friendly compliment that escalates into repeated personal comments after you have politely deflected.", es: "Un cumplido amistoso que escala a comentarios personales repetidos después de que usted los desvió cortésmente." },
          { en: "A coworker who keeps asking you out after you have said no, even just once.", es: "Un compañero que sigue invitándolo a salir después de que dijo que no, aunque sea una sola vez." },
          { en: "A client who walks around the home in underwear or partially undressed while you clean.", es: "Un cliente que camina por la casa en ropa interior o parcialmente vestido mientras usted limpia." },
          { en: "A pattern of explicit text messages, memes, or social media tags from a coworker after work hours.", es: "Un patrón de mensajes de texto explícitos, memes o etiquetas en redes sociales por parte de un compañero fuera del horario laboral." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "If you are not sure whether something is harassment, you can still report it. The office can listen, document what happened, and decide whether to investigate. Reporting a concern that turns out not to meet the legal definition is never held against you.",
          es: "Si no está seguro de si algo es acoso, aún puede reportarlo. La oficina puede escuchar, documentar lo que pasó y decidir si investigar. Reportar una inquietud que resulte no cumplir con la definición legal nunca cuenta en su contra.",
        },
      },

      // ── Section C: Federal and State Law ──────────────────────────────────
      { type: "h", text: { en: "The Laws That Protect You", es: "Las Leyes Que Lo Protegen" } },
      {
        type: "p",
        text: {
          en: "Two main laws protect you against sexual harassment at work. Both apply to Phes.",
          es: "Dos leyes principales lo protegen contra el acoso sexual en el trabajo. Ambas aplican a Phes.",
        },
      },
      { type: "h", text: { en: "Title VII of the Civil Rights Act of 1964 (Federal)", es: "Título VII de la Ley de Derechos Civiles de 1964 (Federal)" } },
      {
        type: "p",
        text: {
          en: "Title VII prohibits employment discrimination based on sex, including sexual harassment. It covers all employers with 15 or more employees nationwide. Complaints under Title VII go to the U.S. Equal Employment Opportunity Commission (EEOC). Illinois is a deferral state, which means you have up to 300 days from the date of the harassment to file with the EEOC.",
          es: "El Título VII prohíbe la discriminación laboral por sexo, incluyendo el acoso sexual. Cubre a todos los empleadores con 15 o más empleados a nivel nacional. Las quejas bajo el Título VII van a la Comisión de Igualdad de Oportunidades en el Empleo (EEOC). Illinois es un estado de aplazamiento, lo que significa que tiene hasta 300 días desde la fecha del acoso para presentar la queja ante la EEOC.",
        },
      },
      { type: "h", text: { en: "Illinois Human Rights Act (State)", es: "Ley de Derechos Humanos de Illinois (Estatal)" } },
      {
        type: "p",
        text: {
          en: "The Illinois Human Rights Act (IHRA) prohibits sexual harassment in all Illinois workplaces, regardless of size. It also requires this annual training. Complaints under the IHRA go to the Illinois Department of Human Rights (IDHR). The IHRA covers harassment by supervisors, coworkers, clients, and non-employees.",
          es: "La Ley de Derechos Humanos de Illinois (IHRA) prohíbe el acoso sexual en todos los lugares de trabajo en Illinois, sin importar el tamaño. También requiere esta capacitación anual. Las quejas bajo la IHRA van al Departamento de Derechos Humanos de Illinois (IDHR). La IHRA cubre el acoso por parte de supervisores, compañeros, clientes y no empleados.",
        },
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Both laws apply to all employees regardless of gender identity, sexual orientation, immigration status, religion, race, or any other characteristic. You are protected.",
          es: "Ambas leyes aplican a todos los empleados sin importar identidad de género, orientación sexual, estatus migratorio, religión, raza o cualquier otra característica. Usted está protegido.",
        },
      },

      // ── Section D: Employer Responsibilities ──────────────────────────────
      { type: "h", text: { en: "What Phes Is Required to Do", es: "Lo Que Phes Está Obligada a Hacer" } },
      {
        type: "p",
        text: {
          en: "Phes has a zero-tolerance policy on sexual harassment. We are required by law (and by our own choice) to do the following:",
          es: "Phes tiene una política de cero tolerancia hacia el acoso sexual. Estamos obligados por ley (y por elección propia) a hacer lo siguiente:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Prevent harassment through clear policies, this annual training, and supervisor accountability.", es: "Prevenir el acoso mediante políticas claras, esta capacitación anual y la responsabilidad de los supervisores." },
          { en: "Investigate every report promptly. We do not wait, and we do not let reports sit.", es: "Investigar cada reporte de inmediato. No esperamos, y no dejamos reportes sin atender." },
          { en: "Keep investigations as confidential as possible. We share information only with people who need it to investigate or take action.", es: "Mantener las investigaciones lo más confidenciales posible. Compartimos información solo con quienes la necesitan para investigar o actuar." },
          { en: "Take corrective action when harassment is found. Consequences range from coaching to termination depending on severity.", es: "Tomar acción correctiva cuando se encuentre acoso. Las consecuencias van desde orientación hasta terminación según la gravedad." },
          { en: "Protect employees from retaliation for reporting or participating in an investigation. Retaliation is itself a violation and is treated seriously.", es: "Proteger a los empleados de represalias por reportar o participar en una investigación. Las represalias son una violación en sí mismas y se tratan con seriedad." },
          { en: "Train supervisors at every level to recognize, prevent, and respond to harassment.", es: "Capacitar a los supervisores en todos los niveles para reconocer, prevenir y responder al acoso." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Sexual harassment, including any retaliation for reporting it, is grounds for discipline up to and including immediate termination. This applies to every employee, regardless of title, tenure, or relationship to the company.",
          es: "El acoso sexual, incluyendo cualquier represalia por reportarlo, es motivo de disciplina hasta e incluyendo la terminación inmediata. Esto aplica a cada empleado, sin importar el puesto, la antigüedad o la relación con la compañía.",
        },
      },

      // ── Section E: How to Report and Get Help ─────────────────────────────
      { type: "h", text: { en: "How to Report Harassment", es: "Cómo Reportar el Acoso" } },
      {
        type: "p",
        text: {
          en: "If you experience or witness sexual harassment, report it. You have multiple ways to do that, and you can choose whichever feels safest for you.",
          es: "Si experimenta o presencia acoso sexual, repórtelo. Tiene varias formas de hacerlo, y puede elegir la que se sienta más segura para usted.",
        },
      },
      { type: "h", text: { en: "Internal Reporting Channels", es: "Canales de Reporte Internos" } },
      {
        type: "bullets",
        items: [
          { en: "Tell your direct supervisor in person, by phone, or in writing (text or email).", es: "Dígale a su supervisor directo en persona, por teléfono o por escrito (mensaje o correo electrónico)." },
          { en: "Contact the office. Ask for whoever is on duty (currently Maribel Castillo or Francisco Estevez) by phone, in person, or in writing.", es: "Contacte a la oficina. Pida hablar con quien esté de turno (actualmente Maribel Castillo o Francisco Estevez) por teléfono, en persona o por escrito." },
          { en: "Contact the owner directly. Salvador Martinez can be reached through the office or through the contact form on the company site.", es: "Contacte al propietario directamente. Salvador Martinez puede ser contactado a través de la oficina o el formulario de contacto del sitio de la compañía." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "You do not have to start at the bottom. If the person you would normally tell is the one harassing you, skip them and report higher up. Your report will be taken seriously.",
          es: "No tiene que empezar desde abajo. Si la persona a quien normalmente le diría es quien lo está acosando, sáltela y reporte más arriba. Su reporte será tomado en serio.",
        },
      },
      { type: "h", text: { en: "External Agencies (You Can Always File With Them)", es: "Agencias Externas (Siempre Puede Presentar Queja Con Ellas)" } },
      {
        type: "bullets",
        items: [
          { en: "Illinois Department of Human Rights (IDHR). Phone: 217-785-5100. Online: dhr.illinois.gov. You have 300 days from the date of the harassment to file.", es: "Departamento de Derechos Humanos de Illinois (IDHR). Teléfono: 217-785-5100. En línea: dhr.illinois.gov. Tiene 300 días desde la fecha del acoso para presentar la queja." },
          { en: "U.S. Equal Employment Opportunity Commission (EEOC). Phone: 1-800-669-4000. Online: eeoc.gov. You have 300 days because Illinois is a deferral state.", es: "Comisión de Igualdad de Oportunidades en el Empleo (EEOC). Teléfono: 1-800-669-4000. En línea: eeoc.gov. Tiene 300 días porque Illinois es un estado de aplazamiento." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Retaliation for reporting harassment, or for participating in an investigation, is strictly prohibited and illegal under both federal and state law. Examples of retaliation include schedule cuts, route changes meant to punish, discipline, or termination that follows a report. If you experience anything like this after reporting, tell the office or file with IDHR or EEOC.",
          es: "Las represalias por reportar acoso, o por participar en una investigación, están estrictamente prohibidas y son ilegales bajo la ley federal y estatal. Ejemplos de represalias incluyen recortes de horario, cambios de ruta para castigar, disciplina o terminación que siga al reporte. Si experimenta algo así después de reportar, dígale a la oficina o presente queja ante IDHR o EEOC.",
        },
      },

      // ── Closing ────────────────────────────────────────────────────────────
      { type: "h", text: { en: "Compliance Statement", es: "Declaración de Cumplimiento" } },
      {
        type: "p",
        text: {
          en: "This training is required by the Illinois Human Rights Act. Phes is committed to maintaining a workplace free from sexual harassment, discrimination, and retaliation. Completion records for this training are kept for at least three years and are available to the Illinois Department of Human Rights on request.",
          es: "Esta capacitación es requerida por la Ley de Derechos Humanos de Illinois. Phes se compromete a mantener un lugar de trabajo libre de acoso sexual, discriminación y represalias. Los registros de finalización de esta capacitación se mantienen por al menos tres años y están disponibles para el Departamento de Derechos Humanos de Illinois bajo solicitud.",
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
      { en: "Submit a sick request through MaidCentral / Qleno AND make the grace-window call to Maribel or Francisco — that's all PLAWA needs. No advance approval, no doctor's note, no reason required.", es: "Envíe la solicitud por MaidCentral / Qleno Y haga la llamada de gracia a Maribel o Francisco — eso es todo lo que PLAWA necesita. Sin aprobación previa, sin nota médica, sin razón requerida." },
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
      en: "Phes uses four leave buckets to cover absences. What is the order they are used in?",
      es: "Phes usa cuatro cubetas de licencia para cubrir ausencias. ¿En qué orden se usan?",
    },
    options: [
      { en: "PTO → PLAWA → Unpaid Personal Leave → Unpaid Absence Allowance.", es: "PTO → PLAWA → Licencia Personal No Pagada → Tolerancia de Ausencia No Pagada." },
      { en: "PLAWA → PTO → Unpaid Personal Leave → Unpaid Absence Allowance.", es: "PLAWA → PTO → Licencia Personal No Pagada → Tolerancia de Ausencia No Pagada." },
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
      { en: "Only when (a) it's a no-call/no-show, OR (b) all four leave buckets are exhausted and you didn't get advance approval for unpaid time. Using any bucket with proper notice is excused.", es: "Solo cuando (a) es un no llamó / no se presentó, O (b) las cuatro cubetas de licencia están agotadas y no obtuvo aprobación previa para tiempo no pagado. Usar cualquier cubeta con aviso apropiado es justificado." },
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
      { en: "PLAWA and Unpaid Absence Allowance: the 20-minute grace call only. PTO and Unpaid Personal Leave: 7 days advance notice. Same two-step process (system + Maribel/Francisco) for all four.", es: "PLAWA y Tolerancia de Ausencia No Pagada: solo la llamada de gracia de 20 minutos. PTO y Licencia Personal No Pagada: 7 días de aviso anticipado. El mismo proceso de dos pasos (sistema + Maribel/Francisco) para las cuatro." },
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
    id: "q-pp-34-unpaid-absence-allowance",
    moduleId: "phes-policies",
    prompt: {
      en: "You've burned through PLAWA, PTO, and Unpaid Personal Leave. You wake up sick and call off (with the 20-minute grace call). Is there still a bucket Phes uses before the absence becomes unexcused?",
      es: "Ha agotado PLAWA, PTO, y Licencia Personal No Pagada. Despierta enfermo y llama para faltar (con la llamada de gracia de 20 minutos). ¿Existe todavía una cubeta que Phes use antes de que la ausencia sea injustificada?",
    },
    options: [
      { en: "No — once the first three are out, the absence is unexcused.", es: "No — una vez agotadas las primeras tres, la ausencia es injustificada." },
      { en: "Yes — the Unpaid Absence Allowance (40 hours, after 90 days, grace-call only, no advance approval needed). It's the last bucket before discipline. After it's exhausted, further unprotected absences become unexcused.", es: "Sí — la Tolerancia de Ausencia No Pagada (40 horas, después de 90 días, solo llamada de gracia, sin aprobación previa). Es la última cubeta antes de la disciplina. Una vez agotada, las ausencias no protegidas adicionales se vuelven injustificadas." },
      { en: "Phes will let you borrow against next year's PTO.", es: "Phes le permite pedir prestado contra el PTO del próximo año." },
      { en: "Only if the absence is for an immediate family member.", es: "Solo si la ausencia es por un familiar inmediato." },
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
  // Module 6: SEXUAL HARASSMENT PREVENTION TRAINING (10 questions)
  // ═════════════════════════════════════════════════════════════════════════════
  {
    id: "q-sh-01-definition",
    moduleId: "sexual-harassment-prevention",
    prompt: {
      en: "Under the Illinois Human Rights Act, which of the following best describes sexual harassment?",
      es: "Bajo la Ley de Derechos Humanos de Illinois, ¿cuál de las siguientes describe mejor el acoso sexual?",
    },
    options: [
      { en: "Any flirting or compliment between coworkers, regardless of how it's received.", es: "Cualquier coqueteo o cumplido entre compañeros, sin importar cómo se reciba." },
      { en: "Unwelcome sexual advances, requests for sexual favors, or conduct of a sexual nature that affects employment decisions OR creates an intimidating, hostile, or offensive work environment.", es: "Insinuaciones sexuales no deseadas, peticiones de favores sexuales o conducta de naturaleza sexual que afecta decisiones de empleo O crea un ambiente de trabajo intimidante, hostil u ofensivo." },
      { en: "Only physical contact that the person doing it intended to be offensive.", es: "Solo contacto físico que la persona que lo hace pretendió que fuera ofensivo." },
      { en: "Conduct that has gone on for more than 30 days.", es: "Conducta que ha continuado por más de 30 días." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sh-02-client-harassment",
    moduleId: "sexual-harassment-prevention",
    prompt: {
      en: "You are cleaning a client's home. The client repeatedly makes sexual comments about your body and asks you out. You have politely said you are not interested. What's the right action?",
      es: "Está limpiando el hogar de un cliente. El cliente hace comentarios sexuales sobre su cuerpo repetidamente y lo invita a salir. Usted cortésmente dijo que no está interesado. ¿Cuál es la acción correcta?",
    },
    options: [
      { en: "Ignore it and just finish the job; clients are clients.", es: "Ignorarlo y terminar el trabajo; los clientes son clientes." },
      { en: "Report it to the office immediately. The law protects you from harassment by clients, not just coworkers, and Phes will handle the client relationship.", es: "Reportarlo a la oficina de inmediato. La ley lo protege del acoso por parte de clientes, no solo compañeros, y Phes manejará la relación con el cliente." },
      { en: "Quit the company because clients can do whatever they want in their own homes.", es: "Renunciar a la compañía porque los clientes pueden hacer lo que quieran en sus propios hogares." },
      { en: "Wait until it happens at three different visits before saying anything.", es: "Esperar a que pase en tres visitas diferentes antes de decir algo." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sh-03-quid-pro-quo",
    moduleId: "sexual-harassment-prevention",
    prompt: {
      en: "A supervisor tells you they'll give you better routes and extra hours if you agree to go out with them. You decline. Is this sexual harassment?",
      es: "Un supervisor le dice que le dará mejores rutas y horas extra si acepta salir con ellos. Usted rechaza. ¿Es esto acoso sexual?",
    },
    options: [
      { en: "No, because you declined and nothing actually happened.", es: "No, porque usted rechazó y nada realmente sucedió." },
      { en: "Yes. This is quid pro quo harassment. Job benefits or assignments cannot be conditioned on sexual favors, and a single incident is enough to be illegal.", es: "Sí. Esto es acoso quid pro quo. Los beneficios o asignaciones laborales no pueden condicionarse a favores sexuales, y un solo incidente es suficiente para ser ilegal." },
      { en: "Only if the supervisor follows through on the offer.", es: "Solo si el supervisor cumple con la oferta." },
      { en: "Only if it happens during work hours.", es: "Solo si pasa durante horas de trabajo." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sh-04-who-to-report",
    moduleId: "sexual-harassment-prevention",
    prompt: {
      en: "You experience harassment from a coworker. Who can you report it to at Phes?",
      es: "Sufre acoso por parte de un compañero. ¿A quién puede reportarlo en Phes?",
    },
    options: [
      { en: "Only your direct supervisor; they are the only authorized contact.", es: "Solo a su supervisor directo; es el único contacto autorizado." },
      { en: "Your direct supervisor, the office (Maribel or Francisco), or the owner. You can choose whichever feels safest, in person, by phone, or in writing.", es: "Su supervisor directo, la oficina (Maribel o Francisco), o el propietario. Puede elegir el que se sienta más seguro, en persona, por teléfono o por escrito." },
      { en: "Only the EEOC; internal reporting is not allowed.", es: "Solo a la EEOC; no se permite el reporte interno." },
      { en: "Only a coworker; managers cannot be involved.", es: "Solo a un compañero; los gerentes no pueden estar involucrados." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sh-05-retaliation",
    moduleId: "sexual-harassment-prevention",
    prompt: {
      en: "Can Phes legally retaliate against you (cut hours, change routes to punish you, write you up, or fire you) because you reported harassment in good faith?",
      es: "¿Puede Phes legalmente tomar represalias contra usted (recortar horas, cambiar rutas para castigarlo, escribirle un reporte o despedirlo) porque reportó acoso de buena fe?",
    },
    options: [
      { en: "Yes, if the company decides the complaint is bad for business.", es: "Sí, si la compañía decide que la queja es mala para el negocio." },
      { en: "No. Retaliation for reporting harassment, or for participating in an investigation, is strictly prohibited and illegal under both federal and Illinois law. Retaliation is itself a separate violation.", es: "No. Las represalias por reportar acoso, o por participar en una investigación, están estrictamente prohibidas y son ilegales bajo la ley federal y de Illinois. La represalia es una violación separada en sí misma." },
      { en: "Only after a 90-day cooling-off period.", es: "Solo después de un periodo de enfriamiento de 90 días." },
      { en: "Yes, but only if the investigation finds your complaint to be untrue.", es: "Sí, pero solo si la investigación encuentra que su queja no era cierta." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sh-06-external-agencies",
    moduleId: "sexual-harassment-prevention",
    prompt: {
      en: "How long do you have to file a sexual harassment complaint with the Illinois Department of Human Rights (IDHR) or the EEOC, counted from the date of the harassment?",
      es: "¿Cuánto tiempo tiene para presentar una queja por acoso sexual ante el Departamento de Derechos Humanos de Illinois (IDHR) o la EEOC, contando desde la fecha del acoso?",
    },
    options: [
      { en: "30 days.", es: "30 días." },
      { en: "90 days.", es: "90 días." },
      { en: "300 days. Illinois is a deferral state, so the same window applies to both IDHR and EEOC filings.", es: "300 días. Illinois es un estado de aplazamiento, así que la misma ventana aplica para presentar quejas con IDHR y EEOC." },
      { en: "Up to 5 years.", es: "Hasta 5 años." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-sh-07-zero-tolerance",
    moduleId: "sexual-harassment-prevention",
    prompt: {
      en: "What is Phes's policy on sexual harassment?",
      es: "¿Cuál es la política de Phes sobre acoso sexual?",
    },
    options: [
      { en: "Zero tolerance. Every report is investigated promptly. Substantiated harassment is grounds for discipline up to and including immediate termination, regardless of the person's role or tenure.", es: "Cero tolerancia. Cada reporte se investiga de inmediato. El acoso comprobado es motivo de disciplina hasta e incluyendo la terminación inmediata, sin importar el puesto o la antigüedad de la persona." },
      { en: "Tolerance up to 3 incidents per year before any action is taken.", es: "Tolerancia hasta 3 incidentes por año antes de tomar acción." },
      { en: "Investigation only when more than one employee reports the same person.", es: "Investigación solo cuando más de un empleado reporta a la misma persona." },
      { en: "No formal policy; case-by-case decisions by management.", es: "Sin política formal; decisiones caso por caso por la gerencia." },
    ],
    correctIndex: 0,
  },
  {
    id: "q-sh-08-protected-groups",
    moduleId: "sexual-harassment-prevention",
    prompt: {
      en: "Who is protected from sexual harassment under federal and Illinois law?",
      es: "¿Quién está protegido contra el acoso sexual bajo la ley federal y de Illinois?",
    },
    options: [
      { en: "Only women.", es: "Solo las mujeres." },
      { en: "Only employees who have been with the company more than 90 days.", es: "Solo empleados que llevan más de 90 días con la compañía." },
      { en: "All employees, regardless of gender identity, sexual orientation, immigration status, religion, race, or any other characteristic.", es: "Todos los empleados, sin importar identidad de género, orientación sexual, estatus migratorio, religión, raza o cualquier otra característica." },
      { en: "Only full-time employees in office roles.", es: "Solo empleados de tiempo completo en puestos de oficina." },
    ],
    correctIndex: 2,
  },
  {
    id: "q-sh-09-witness",
    moduleId: "sexual-harassment-prevention",
    prompt: {
      en: "You witness a coworker being harassed by another coworker. The person being harassed has not said anything to the office yet. What should you do?",
      es: "Es testigo de cómo un compañero acosa a otro compañero. La persona acosada no le ha dicho nada a la oficina todavía. ¿Qué debe hacer?",
    },
    options: [
      { en: "Stay out of it. It's not your business unless they ask for help.", es: "Mantenerse al margen. No es asunto suyo a menos que pidan ayuda." },
      { en: "You may (and are encouraged to) report what you witnessed to the office. You can also support the person harassed and let them know you'd back them up. Reports from witnesses are taken seriously and the same anti-retaliation protections apply.", es: "Puede (y se le anima a) reportar lo que presenció a la oficina. También puede apoyar a la persona acosada y dejarle saber que la respalda. Los reportes de testigos se toman en serio y las mismas protecciones contra represalias aplican." },
      { en: "Confront the harasser yourself and threaten them.", es: "Confrontar al acosador usted mismo y amenazarlo." },
      { en: "Wait until the person being harassed quits before saying anything.", es: "Esperar a que la persona acosada renuncie antes de decir algo." },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sh-10-borderline",
    moduleId: "sexual-harassment-prevention",
    prompt: {
      en: "A coworker has asked you out three times. You said no the first time. They keep asking, but they have not touched you and have not threatened you. Is this something you can report?",
      es: "Un compañero lo ha invitado a salir tres veces. Usted dijo que no la primera vez. Sigue invitándolo, pero no lo ha tocado ni amenazado. ¿Es algo que puede reportar?",
    },
    options: [
      { en: "No, because nothing physical happened.", es: "No, porque nada físico sucedió." },
      { en: "Only if the coworker is your supervisor.", es: "Solo si el compañero es su supervisor." },
      { en: "Yes. Repeated unwanted advances after a clear no are unwelcome conduct and can rise to harassment, especially when they create discomfort or interfere with your work. You can always report a concern; the office will document it and decide how to handle it.", es: "Sí. Las insinuaciones no deseadas repetidas después de un no claro son conducta no deseada y pueden constituir acoso, sobre todo cuando crean incomodidad o interfieren con su trabajo. Siempre puede reportar una inquietud; la oficina la documentará y decidirá cómo manejarla." },
      { en: "Only if you have written proof of every ask.", es: "Solo si tiene prueba escrita de cada invitación." },
    ],
    correctIndex: 2,
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
const TENANT_OVERRIDES: Record<number, { extraModules?: Module[]; extraQuiz?: QuizQuestion[]; tenantName?: string }> = {
  1: { tenantName: "Phes" },
};

export function getCurriculum(companyId: number | null | undefined): Curriculum {
  const cid = companyId ?? 1;
  const override = TENANT_OVERRIDES[cid] || {};
  return {
    tenantName: override.tenantName ?? "Phes",
    modules: [...BASE_MODULES, ...(override.extraModules ?? [])],
    quiz: [...BASE_QUIZ, ...(override.extraQuiz ?? [])],
  };
}

export const QUIZ_PASS_THRESHOLD = 0.8;
