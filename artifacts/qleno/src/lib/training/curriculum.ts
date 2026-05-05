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
 */

export type Locale = "en" | "es";

export type ContentBlock =
  | { type: "p"; text: { en: string; es: string } }
  | { type: "h"; text: { en: string; es: string } }
  | { type: "bullets"; items: { en: string; es: string }[] }
  | { type: "callout"; tone: "info" | "warning" | "success"; text: { en: string; es: string } }
  | { type: "table"; head: { en: string[]; es: string[] }; rows: { en: string[]; es: string[] }[] };

export type IconKind =
  | "house"        // welcome
  | "clock"        // attendance
  | "uniform"      // dress-code
  | "money"        // compensation
  | "flow"         // cleaning-standards
  | "spray"        // products-tools
  | "pin"          // maidcentral
  | "sparkle"      // qleno-app
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
  // 1. Welcome
  {
    id: "welcome",
    number: 1,
    iconKind: "house",
    title: { en: "Welcome to Phes", es: "Bienvenido a Phes" },
    subtitle: {
      en: "Mission, values, and what it means to be part of the team.",
      es: "Misión, valores y lo que significa ser parte del equipo.",
    },
    estimatedMinutes: 6,
    blocks: [
      {
        type: "p",
        text: {
          en: "Phes is a Chicago-based residential cleaning company built on a single principle: every home we clean should feel cared for. We earn long-term clients by being the team that gets the small things right — every visit, every time.",
          es: "Phes es una compañía de limpieza residencial con sede en Chicago construida sobre un único principio: cada hogar que limpiamos debe sentirse cuidado. Ganamos clientes a largo plazo siendo el equipo que hace bien las pequeñas cosas — en cada visita, cada vez.",
        },
      },
      { type: "h", text: { en: "Our Mission", es: "Nuestra Misión" } },
      {
        type: "p",
        text: {
          en: "Deliver exceptional, dependable cleaning that gives our clients time back for what matters most — while building stable, well-paid careers for the people who do the work.",
          es: "Entregar un servicio de limpieza excepcional y confiable que devuelva tiempo a nuestros clientes para lo que más importa — mientras construimos carreras estables y bien remuneradas para quienes lo realizan.",
        },
      },
      { type: "h", text: { en: "How We Train", es: "Cómo Capacitamos" } },
      {
        type: "p",
        text: {
          en: "At Phes, you are trained on technique — not just told what to clean. You will learn exactly how to hold a microfiber cloth, how many sprays to use on a surface, which direction to wipe, and why. This precision is what separates a professional cleaner from anyone with a mop. As Debbie Sardone — America's #1 cleaning industry trainer — puts it: speed is the natural byproduct of quality technique. We train the technique. The speed follows.",
          es: "En Phes, lo capacitamos en técnica — no solo le decimos qué limpiar. Aprenderá exactamente cómo sostener un paño de microfibra, cuántos rocíos usar en una superficie, en qué dirección limpiar y por qué. Esta precisión es lo que separa a un limpiador profesional de cualquiera con un trapeador. Como dice Debbie Sardone — la capacitadora #1 de la industria de limpieza en EE.UU. —: la velocidad es el subproducto natural de la técnica de calidad. Nosotros enseñamos la técnica. La velocidad sigue.",
        },
      },

      { type: "h", text: { en: "Our Core Values", es: "Nuestros Valores" } },
      {
        type: "bullets",
        items: [
          { en: "Reliability — we show up, on time, prepared.", es: "Confiabilidad — llegamos, a tiempo, preparados." },
          { en: "Pride in craft — we treat every home like our own.", es: "Orgullo en el oficio — tratamos cada casa como la nuestra." },
          { en: "Respect — for clients, for teammates, for property.", es: "Respeto — por clientes, compañeros y la propiedad." },
          { en: "Honesty — we admit mistakes and fix them fast.", es: "Honestidad — admitimos errores y los corregimos rápido." },
          { en: "Growth — we learn, we improve, we mentor.", es: "Crecimiento — aprendemos, mejoramos, enseñamos." },
        ],
      },
      { type: "h", text: { en: "Employment Status", es: "Estado de Empleo" } },
      {
        type: "p",
        text: {
          en: "Employment with Phes is at-will. This means you may end your employment at any time, for any reason, and Phes may end the employment relationship at any time, with or without cause or advance notice. No supervisor, manager, or representative of Phes — other than the owner in writing — has authority to alter the at-will nature of your employment.",
          es: "El empleo con Phes es a voluntad (\"at-will\"). Esto significa que usted puede terminar su empleo en cualquier momento, por cualquier razón, y Phes puede terminar la relación laboral en cualquier momento, con o sin causa, y con o sin previo aviso. Ningún supervisor, gerente o representante de Phes — salvo el dueño por escrito — tiene autoridad para alterar la naturaleza a voluntad de su empleo.",
        },
      },
      { type: "h", text: { en: "What Sets Phes Apart", es: "Lo Que Distingue a Phes" } },
      {
        type: "bullets",
        items: [
          { en: "Every cleaner is a W-2 employee — not a contractor — with payroll, taxes, and benefits handled by the company.", es: "Cada limpiador es empleado W-2 — no contratista — con nómina, impuestos y beneficios gestionados por la compañía." },
          { en: "Every employee is background-checked before stepping inside a client home.", es: "Cada empleado pasa una verificación de antecedentes antes de entrar a un hogar de cliente." },
          { en: "Phes has earned 500+ verified client reviews across our service area.", es: "Phes ha ganado más de 500 reseñas verificadas de clientes en nuestra área de servicio." },
          { en: "Same-team consistency is a core promise to clients — when you are assigned to a client, expect to be the recurring face.", es: "La consistencia del mismo equipo es una promesa central a los clientes — cuando se le asigna a un cliente, espere ser el rostro recurrente." },
          { en: "24-hour satisfaction guarantee — if a client is unhappy, the team returns same-day to fix it (this connects to the Fix-It Rule in the Compensation module).", es: "Garantía de satisfacción de 24 horas — si un cliente no está satisfecho, el equipo regresa el mismo día para corregirlo (esto se conecta con la Regla de Corrección en el módulo de Compensación)." },
        ],
      },
      { type: "h", text: { en: "How a Job Reaches You", es: "Cómo Llega un Trabajo a Ti" } },
      {
        type: "p",
        text: {
          en: "Most clients book online through the Phes website. Once they confirm a date, the office assigns the job to a crew based on zone and history, and you receive a notification through MaidCentral with date, time, address, scope of work, and any client-specific notes.",
          es: "La mayoría de los clientes reservan en línea a través del sitio web de Phes. Una vez confirmada la fecha, la oficina asigna el trabajo a un equipo según zona e historial, y usted recibe una notificación en MaidCentral con fecha, hora, dirección, alcance del trabajo y cualquier nota específica del cliente.",
        },
      },
      { type: "h", text: { en: "What Phes Does NOT Do", es: "Lo Que Phes NO Hace" } },
      {
        type: "p",
        text: {
          en: "Knowing our scope protects you and the client. We do not handle:",
          es: "Conocer nuestro alcance lo protege a usted y al cliente. No manejamos:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Bodily fluids or biohazard cleanup of any kind.", es: "Fluidos corporales o limpieza de riesgo biológico de ningún tipo." },
          { en: "Organizing personal belongings — we clean around items, we do not relocate or sort them.", es: "Organización de pertenencias personales — limpiamos alrededor de los artículos, no los reubicamos ni clasificamos." },
          { en: "Cash. We never accept cash from clients.", es: "Efectivo. Nunca aceptamos efectivo de los clientes." },
          { en: "Inside appliances (oven, fridge, dishwasher) unless that exact appliance was added as a paid add-on for the visit.", es: "Interior de electrodomésticos (horno, refrigerador, lavavajillas) a menos que ese electrodoméstico exacto haya sido agregado como add-on pagado para la visita." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "If a client asks for any of the above on-site, politely decline and explain it is outside scope. Direct them to office to add it for a future visit.",
          es: "Si un cliente solicita lo anterior en sitio, decline cortésmente y explique que está fuera de alcance. Diríjalo a la oficina para agregarlo en una futura visita.",
        },
      },
      { type: "h", text: { en: "Professional Standards in the Home", es: "Estándares Profesionales en el Hogar" } },
      {
        type: "bullets",
        items: [
          { en: "Introduce yourself by name to the client if they are home when you arrive.", es: "Preséntese con su nombre al cliente si está en casa cuando llegue." },
          { en: "Knock before entering any closed room — even bedrooms during a clean — in case someone is inside.", es: "Toque antes de entrar a cualquier habitación cerrada — incluso dormitorios durante la limpieza — por si hay alguien dentro." },
          { en: "No personal cell phone use during the visit (covered in the Dress Code module).", es: "No use teléfono celular personal durante la visita (cubierto en el módulo de Código de Vestimenta)." },
          { en: "Tipping is allowed and appreciated, but we never request, hint at, or expect a tip. We never accept cash for the service itself — the client pays Phes directly.", es: "Las propinas están permitidas y se agradecen, pero nunca las solicitamos, insinuamos ni esperamos. Nunca aceptamos efectivo por el servicio en sí — el cliente paga directamente a Phes." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "What you do every day directly shapes whether a client renews or cancels. Quality is not a department — it is every cleaner, every visit.",
          es: "Lo que haces cada día determina directamente si un cliente renueva o cancela. La calidad no es un departamento — es cada limpiador, en cada visita.",
        },
      },
    ],
  },

  // 2. Attendance
  {
    id: "attendance",
    number: 2,
    iconKind: "clock",
    title: { en: "Attendance Policy", es: "Política de Asistencia" },
    subtitle: {
      en: "Grace period, tardiness scale, sick leave, PTO, time-off requests, and unexcused absences.",
      es: "Periodo de gracia, escala de tardanzas, licencia por enfermedad, PTO, solicitudes de tiempo libre y ausencias injustificadas.",
    },
    estimatedMinutes: 10,
    blocks: [
      { type: "h", text: { en: "Grace Period", es: "Periodo de Gracia" } },
      {
        type: "p",
        text: {
          en: "You have a 7-minute grace window after your scheduled clock-in time. Beyond 7 minutes, the visit is recorded as tardy.",
          es: "Cuenta con un periodo de gracia de 7 minutos después de su hora programada para registrarse. Después de 7 minutos, la visita se registra como tardanza.",
        },
      },
      { type: "h", text: { en: "Tardiness Scale", es: "Escala de Tardanzas" } },
      {
        type: "table",
        head: {
          en: ["Occurrence", "Action"],
          es: ["Ocurrencia", "Acción"],
        },
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
      { type: "h", text: { en: "Paid Sick Leave (PLAWA)", es: "Licencia por Enfermedad Pagada (PLAWA)" } },
      {
        type: "p",
        text: {
          en: "Under the Illinois Paid Leave for All Workers Act (PLAWA), you accrue up to 40 hours of paid leave per benefit year that may be used for any reason. Eligibility begins 90 days from your hire date.",
          es: "Bajo la Ley de Licencia Pagada para Todos los Trabajadores (PLAWA) de Illinois, usted acumula hasta 40 horas de licencia pagada por año de beneficios que puede usar por cualquier razón. La elegibilidad comienza 90 días después de su fecha de contratación.",
        },
      },
      { type: "h", text: { en: "Paid Time Off (PTO)", es: "Tiempo Libre Pagado (PTO)" } },
      {
        type: "bullets",
        items: [
          { en: "After 1 year of service: 40 hours of PTO per year.", es: "Después de 1 año de servicio: 40 horas de PTO por año." },
          { en: "After 2 years of service: 80 hours of PTO per year.", es: "Después de 2 años de servicio: 80 horas de PTO por año." },
          { en: "PTO is requested in advance and approved by office.", es: "El PTO se solicita con anticipación y debe ser aprobado por la oficina." },
        ],
      },

      { type: "h", text: { en: "How to Request Time Off — Through the System", es: "Cómo Solicitar Tiempo Libre — A Través del Sistema" } },
      {
        type: "p",
        text: {
          en: "Every time-off request — PTO, sick day, schedule change — must be submitted through MaidCentral (and Qleno once we cut over). Do not text or call a manager directly to request time off. This is not optional.",
          es: "Toda solicitud de tiempo libre — PTO, día por enfermedad, cambio de horario — debe enviarse a través de MaidCentral (y Qleno una vez que hagamos el cambio). No envíe mensajes ni llame a un gerente directamente para solicitar tiempo libre. Esto no es opcional.",
        },
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "Why it matters: when requests go through the system, the schedule updates in real time, the office can re-route the day, and clients are notified properly. A text to a manager doesn't do any of that — and a missed handoff means a client gets no cleaner.",
          es: "Por qué importa: cuando las solicitudes pasan por el sistema, el horario se actualiza en tiempo real, la oficina puede redirigir el día y los clientes son notificados correctamente. Un mensaje a un gerente no hace nada de eso — y un traspaso perdido significa que un cliente se queda sin limpiador.",
        },
      },

      { type: "h", text: { en: "Unexcused Absences", es: "Ausencias Injustificadas" } },
      {
        type: "p",
        text: {
          en: "An unexcused absence is missing a scheduled shift without an approved request through the system. The progression mirrors the tardiness scale:",
          es: "Una ausencia injustificada es faltar a un turno programado sin una solicitud aprobada a través del sistema. La progresión refleja la escala de tardanzas:",
        },
      },
      {
        type: "table",
        head: {
          en: ["Occurrence", "Action"],
          es: ["Ocurrencia", "Acción"],
        },
        rows: [
          { en: ["1st", "Recorded"],         es: ["1ª", "Registrada"] },
          { en: ["2nd", "Recorded"],         es: ["2ª", "Registrada"] },
          { en: ["3rd", "Written warning"],  es: ["3ª", "Advertencia por escrito"] },
          { en: ["4th", "Final warning"],    es: ["4ª", "Última advertencia"] },
          { en: ["5th", "Termination"],      es: ["5ª", "Terminación"] },
        ],
      },

      { type: "h", text: { en: "Paid Holidays", es: "Feriados Pagados" } },
      {
        type: "p",
        text: {
          en: "Phes observes 6 paid holidays plus your birthday: New Year's Day, Memorial Day, Independence Day, Labor Day, Thanksgiving, Christmas Day, and your birthday (taken any day that month).",
          es: "Phes observa 6 feriados pagados más su cumpleaños: Año Nuevo, Memorial Day, Día de la Independencia, Día del Trabajo, Acción de Gracias, Navidad, y su cumpleaños (tomado cualquier día de ese mes).",
        },
      },
    ],
  },

  // 3. Dress Code
  {
    id: "dress-code",
    number: 3,
    iconKind: "uniform",
    title: { en: "Dress Code & Conduct", es: "Código de Vestimenta y Conducta" },
    subtitle: {
      en: "Uniform standards, shoe covers, and phone policy.",
      es: "Estándares de uniforme, cubrezapatos y política de teléfono.",
    },
    estimatedMinutes: 5,
    blocks: [
      { type: "h", text: { en: "Uniform — Mandatory", es: "Uniforme — Obligatorio" } },
      {
        type: "p",
        text: {
          en: "You must arrive at every job in full Phes attire — the company-issued shirt and pants. The uniform is what every client expects to see at their door, and it is how we keep the brand consistent across hundreds of homes a week.",
          es: "Debe llegar a cada trabajo con el uniforme Phes completo — la camisa y los pantalones provistos por la compañía. El uniforme es lo que cada cliente espera ver en su puerta, y es como mantenemos la marca consistente en cientos de hogares por semana.",
        },
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "No personal clothing substitutions — even if your uniform is dirty or you forgot it at home. If you don't have your uniform, contact the office BEFORE the job. Do not show up at a client's home out of uniform.",
          es: "No se permiten sustituciones de ropa personal — incluso si el uniforme está sucio o lo olvidó en casa. Si no tiene su uniforme, contacte a la oficina ANTES del trabajo. No se presente en el hogar de un cliente fuera de uniforme.",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Phes-issued shirt — clean, untucked is acceptable, no visible stains.", es: "Camisa Phes — limpia, sin manchas visibles, puede llevarse por fuera." },
          { en: "Phes-issued pants in good condition. No shorts, no leggings as outerwear, no personal pants.", es: "Pantalones Phes en buen estado. Sin shorts, sin leggings como ropa exterior, sin pantalones personales." },
          { en: "Closed-toe athletic shoes. No sandals, no Crocs, no open backs.", es: "Calzado deportivo cerrado. Sin sandalias, sin Crocs, sin parte trasera abierta." },
          { en: "Hair tied back if shoulder length or longer.", es: "Cabello recogido si llega a los hombros o más largo." },
          { en: "Jewelry minimal — no large rings or bracelets that can scratch surfaces.", es: "Joyería mínima — sin anillos o pulseras grandes que puedan rayar superficies." },
        ],
      },
      { type: "h", text: { en: "Shoe Covers", es: "Cubrezapatos" } },
      {
        type: "p",
        text: {
          en: "Shoe covers are mandatory inside every client home from the moment you cross the threshold. You change covers between homes. Never reuse covers from a previous job.",
          es: "Los cubrezapatos son obligatorios dentro de cada hogar de cliente desde el momento en que cruza el umbral. Cambie los cubrezapatos entre hogares. Nunca reutilice cubrezapatos de un trabajo anterior.",
        },
      },
      { type: "h", text: { en: "Personal Phone Use", es: "Uso de Teléfono Personal" } },
      {
        type: "p",
        text: {
          en: "Personal cell phones are not allowed during a job. Keep your phone in your bag or vehicle. The only phone use during a job is the company app for clock-in / check-in / job worksheet — and only when stepping aside briefly. Personal calls, texts, and social media wait until break or after the visit.",
          es: "No se permiten teléfonos celulares personales durante un trabajo. Mantenga su teléfono en su bolso o vehículo. El único uso de teléfono permitido durante un trabajo es la aplicación de la compañía para registro / chequeo / hoja de trabajo — y solo apartándose brevemente. Llamadas personales, mensajes y redes sociales esperan hasta el descanso o después de la visita.",
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

  // 4. Compensation
  {
    id: "compensation",
    number: 4,
    iconKind: "money",
    title: { en: "Compensation & Quality", es: "Compensación y Calidad" },
    subtitle: {
      en: "Training pay, residential commission, hourly + commercial jobs, the Fix-It Rule, probation, and payroll.",
      es: "Pago de entrenamiento, comisión residencial, trabajos por hora y comerciales, la Regla de Corrección, periodo de prueba y nómina.",
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
      { type: "h", text: { en: "Residential Commission — 35%", es: "Comisión Residencial — 35%" } },
      {
        type: "p",
        text: {
          en: "Once activated, you earn 35% commission on the residential jobs you complete. When two or more technicians are assigned to the same job, the 35% pool is split among the team — equally if you arrive together, proportional to actual minutes on site if your clock-in times differ.",
          es: "Una vez activado, gana 35% de comisión en los trabajos residenciales que complete. Cuando dos o más técnicos están asignados al mismo trabajo, el 35% se divide entre el equipo — en partes iguales si llegan juntos, proporcional a los minutos reales en sitio si los tiempos de Check In difieren.",
        },
      },
      {
        type: "table",
        head: {
          en: ["Team size", "Each tech earns", "Example on a $200 job"],
          es: ["Tamaño del equipo", "Cada técnico gana", "Ejemplo en un trabajo de $200"],
        },
        rows: [
          { en: ["1 cleaner",  "35%",     "$70 total"],         es: ["1 limpiador",  "35%",     "$70 total"] },
          { en: ["2 cleaners", "17.5% each",  "$35 each"],      es: ["2 limpiadores", "17.5% c/u", "$35 c/u"] },
          { en: ["3 cleaners", "~11.67% each", "~$23.33 each"], es: ["3 limpiadores", "~11.67% c/u", "~$23.33 c/u"] },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "More teammates means a smaller individual cut on each job — but the team finishes faster and can fit more jobs into the day. Most days, that adds up to more total earnings.",
          es: "Más compañeros significa un corte individual más pequeño por trabajo — pero el equipo termina más rápido y caben más trabajos en el día. La mayoría de los días, eso suma más ganancias totales.",
        },
      },

      { type: "h", text: { en: "Hourly Jobs — Time Management", es: "Trabajos por Hora — Gestión del Tiempo" } },
      {
        type: "p",
        text: {
          en: "Phes also sells hourly time blocks — typically 3 to 4 hours — to clients who want specific areas of their home cleaned. You are assigned a set number of hours to complete the work. The most important rule:",
          es: "Phes también vende bloques de tiempo por hora — típicamente 3 a 4 horas — a clientes que quieren limpiar áreas específicas de su hogar. Se le asigna un número fijo de horas para completar el trabajo. La regla más importante:",
        },
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "If you sense early in the job that the time you were given will not be enough, call the office IMMEDIATELY — within the first half of the job, never in the last hour.",
          es: "Si percibe temprano en el trabajo que el tiempo asignado no será suficiente, llame a la oficina INMEDIATAMENTE — dentro de la primera mitad del trabajo, nunca en la última hora.",
        },
      },
      {
        type: "p",
        text: {
          en: "Why this matters: an early call gives the office time to talk to the client gracefully and either authorize more time or adjust scope. A last-hour call forces office to ask the client for more time at the end of the visit — clients are not pleased and the conversation gets very hard. Never leave a job incomplete without communicating with the office first.",
          es: "Por qué importa: una llamada temprana le da a la oficina tiempo para hablar con el cliente con elegancia y autorizar más tiempo o ajustar el alcance. Una llamada en la última hora obliga a la oficina a pedirle al cliente más tiempo al final de la visita — los clientes no están contentos y la conversación se vuelve muy difícil. Nunca deje un trabajo incompleto sin comunicarse primero con la oficina.",
        },
      },

      { type: "h", text: { en: "Commercial Jobs — Hourly Pay", es: "Trabajos Comerciales — Pago por Hora" } },
      {
        type: "p",
        text: {
          en: "Commercial cleaning is paid differently from residential. There is no commission. You are paid $20 per hour, flat, for the time you spend on the job.",
          es: "La limpieza comercial se paga diferente a la residencial. No hay comisión. Se le paga $20 por hora, fijo, por el tiempo que dedica al trabajo.",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Each commercial job in MaidCentral has an allotted time (for example, 3 hours) — that time is calibrated from Phes's history at that exact site. It is not arbitrary.", es: "Cada trabajo comercial en MaidCentral tiene un tiempo asignado (por ejemplo, 3 horas) — ese tiempo está calibrado con el historial de Phes en ese sitio exacto. No es arbitrario." },
          { en: "Work the full allotted time and complete the job to that standard.", es: "Trabaje el tiempo asignado completo y complete el trabajo a ese estándar." },
          { en: "If you only work 1 hour of a 3-hour job, you only get paid for 1 hour.", es: "Si solo trabaja 1 hora de un trabajo de 3 horas, solo se le paga 1 hora." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "Do NOT upload completion photos and mark the job complete early just because you finished the visible work. Uploading early on a 3-hour job after only 1.5 hours triggers a red flag in the system. If something seems off about the assigned time, call the office before closing the job.",
          es: "NO suba fotos de finalización ni marque el trabajo completado temprano solo porque terminó el trabajo visible. Subir temprano en un trabajo de 3 horas después de solo 1.5 horas activa una alerta roja en el sistema. Si algo parece extraño sobre el tiempo asignado, llame a la oficina antes de cerrar el trabajo.",
        },
      },

      { type: "h", text: { en: "Your Payroll Summary", es: "Su Resumen de Nómina" } },
      {
        type: "p",
        text: {
          en: "You can review your payroll summary directly inside MaidCentral — your hours, commissions, and any deductions. Once Qleno is fully built, your payroll summary will live there too. Check it regularly so you catch any discrepancy early; the office will work with you to correct it before the next pay run.",
          es: "Puede revisar su resumen de nómina directamente dentro de MaidCentral — sus horas, comisiones y cualquier descuento. Una vez que Qleno esté completamente construido, su resumen de nómina estará allí también. Revíselo regularmente para detectar cualquier discrepancia temprano; la oficina trabajará con usted para corregirla antes del siguiente pago.",
        },
      },

      { type: "h", text: { en: "The Fix-It Rule", es: "La Regla de Corrección" } },
      {
        type: "p",
        text: {
          en: "If a client reports an issue with your work, you (or a teammate) return the same day to make it right whenever possible. If a same-day return is not possible and the company has to send another team or issue a credit, $50.00 is deducted from your next check.",
          es: "Si un cliente reporta un problema con su trabajo, usted (o un compañero) regresa el mismo día para corregirlo cuando sea posible. Si no es posible regresar el mismo día y la compañía debe enviar a otro equipo o emitir un crédito, se descontarán $50.00 de su siguiente cheque.",
        },
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "The goal of the Fix-It Rule is not punishment — it is closing the loop with the client fast so they stay with us. Owning a miss and fixing it is a sign of a strong technician.",
          es: "El objetivo de la Regla de Corrección no es castigo — es cerrar el ciclo con el cliente rápidamente para que se quede con nosotros. Reconocer un error y corregirlo es señal de un técnico fuerte.",
        },
      },
      { type: "h", text: { en: "Quality Probation", es: "Periodo de Prueba de Calidad" } },
      {
        type: "p",
        text: {
          en: "Every new technician is on Quality Probation for the first 60 days. During probation, two valid quality complaints in a 30-day window will trigger a formal review. Continued issues during probation may result in termination.",
          es: "Cada nuevo técnico está en Periodo de Prueba de Calidad durante los primeros 60 días. Durante el periodo de prueba, dos quejas de calidad válidas en una ventana de 30 días desencadenan una revisión formal. Problemas continuos durante el periodo de prueba pueden resultar en terminación.",
        },
      },
      { type: "h", text: { en: "Mileage Reimbursement", es: "Reembolso de Millaje" } },
      {
        type: "p",
        text: {
          en: "Phes reimburses job-to-job mileage at the current IRS standard rate ($0.70 per mile in 2025). Submit mileage through the company app within 30 days of the trip — older claims will not be honored. Mileage from home to your first job and from your last job home is not reimbursed.",
          es: "Phes reembolsa el millaje entre trabajos a la tarifa estándar actual del IRS ($0.70 por milla en 2025). Envíe el millaje a través de la aplicación de la compañía dentro de los 30 días posteriores al viaje — reclamos más antiguos no se aceptarán. El millaje desde su casa al primer trabajo y desde su último trabajo a casa no se reembolsa.",
        },
      },
    ],
  },

  // 5. Cleaning Standards
  {
    id: "cleaning-standards",
    number: 5,
    iconKind: "flow",
    title: { en: "Cleaning Standards", es: "Estándares de Limpieza" },
    subtitle: {
      en: "Room flow, top-to-bottom, the spray-cloth-first rule, and microfiber protocol.",
      es: "Flujo de habitaciones, de arriba hacia abajo, la regla de rociar el paño primero y protocolo de microfibra.",
    },
    estimatedMinutes: 10,
    blocks: [
      {
        type: "p",
        text: {
          en: "Phes trains the way Debbie Sardone — \"The Maid Coach\" — trains professional house cleaners across the country. The principle: speed is a natural byproduct of correct technique. You are NOT trying to rush. You are following a tight, repeatable system that happens to be fast. Technique is taught explicitly — not just outcomes. You will be shown exactly how to hold the cloth, how many sprays to use, and which direction to wipe. There is a right way, and Phes trains you on it.",
          es: "Phes capacita siguiendo el método de Debbie Sardone — \"The Maid Coach\" — quien capacita limpiadores profesionales en todo el país. El principio: la velocidad es un subproducto natural de la técnica correcta. NO se trata de apresurarse. Se trata de seguir un sistema repetible y ajustado que resulta ser rápido. La técnica se enseña explícitamente — no solo los resultados. Se le mostrará exactamente cómo sostener el paño, cuántos rocíos usar y en qué dirección limpiar. Hay una forma correcta, y Phes lo capacita en ella.",
        },
      },

      { type: "h", text: { en: "The 13 Speed-Cleaning Rules", es: "Las 13 Reglas del Speed-Cleaning" } },
      {
        type: "bullets",
        items: [
          { en: "1. Work top to bottom, left to right — never backtrack to a surface you've already cleaned.", es: "1. Trabaje de arriba hacia abajo, de izquierda a derecha — nunca regrese a una superficie ya limpiada." },
          { en: "2. Load yourself up before entering a room. Carry every cloth, every product, the apron, and the caddy IN with you on the first trip.", es: "2. Cárguese completamente antes de entrar a la habitación. Lleve cada paño, cada producto, el delantal y el portasuministros CON usted en el primer viaje." },
          { en: "3. Use both hands. One sprays while the other wipes. One moves an item while the other cleans behind it.", es: "3. Use ambas manos. Una rocía mientras la otra limpia. Una mueve un artículo mientras la otra limpia detrás." },
          { en: "4. Use the right tool for each surface. Switching tools mid-room wastes time — pre-stage the caddy.", es: "4. Use la herramienta correcta para cada superficie. Cambiar herramientas a mitad de habitación pierde tiempo — pre-organice el portasuministros." },
          { en: "5. Never put down what you can carry. The apron and the caddy stay on you the whole visit.", es: "5. Nunca suelte lo que pueda cargar. El delantal y el portasuministros se quedan con usted durante toda la visita." },
          { en: "6. Let products dwell. Spray, then move to another task in the same room while the chemical does its work.", es: "6. Deje que los productos reposen. Rocíe, luego pase a otra tarea en la misma habitación mientras el químico hace su trabajo." },
          { en: "7. Clean to a standard, not to a time — efficient technique is what gets you there fast, never cutting corners.", es: "7. Limpie a un estándar, no a un tiempo — la técnica eficiente es lo que lo hace rápido, nunca tomar atajos." },
          { en: "8. One continuous pass per room — enter, clean completely, exit. Don't re-enter a finished room.", es: "8. Una pasada continua por habitación — entre, limpie completamente, salga. No vuelva a entrar a una habitación terminada." },
          { en: "9. Feather your edges — overlap slightly when cleaning adjacent surfaces so you don't leave visible lines.", es: "9. Mezcle los bordes — superponga ligeramente al limpiar superficies adyacentes para no dejar líneas visibles." },
          { en: "10. Use the S-pattern wipe — never circular motions on glass or flat surfaces. Circles leave streaks; the S-pattern doesn't.", es: "10. Use el patrón en S — nunca movimientos circulares en vidrio o superficies planas. Los círculos dejan rayas; el patrón en S no." },
          { en: "11. Clean the unexpected — baseboards, top of door frames, light switches, doorknobs. Check these every visit.", es: "11. Limpie lo inesperado — rodapiés, parte superior de marcos de puerta, interruptores, perillas. Revise estos en cada visita." },
          { en: "12. Leave no footprints. Always back out of a room after cleaning the floor — never walk across a freshly mopped surface.", es: "12. No deje huellas. Siempre salga de espaldas después de limpiar el piso — nunca camine sobre una superficie recién trapeada." },
          { en: "13. Restock and reset — leave the home exactly as the client keeps it: toilet paper folded, toiletries aligned, pillows fluffed.", es: "13. Reabastezca y restablezca — deje el hogar exactamente como lo mantiene el cliente: papel higiénico doblado, artículos de tocador alineados, almohadas esponjadas." },
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "These 13 rules come from Debbie Sardone — \"The Maid Coach\" — who has trained more residential cleaning companies than anyone in North America. They are not Phes inventions; they are the industry standard, and we follow them.",
          es: "Estas 13 reglas provienen de Debbie Sardone — \"The Maid Coach\" — quien ha capacitado a más compañías de limpieza residencial que cualquier otra persona en Norteamérica. No son invenciones de Phes; son el estándar de la industria, y los seguimos.",
        },
      },

      { type: "h", text: { en: "Room Flow: Back to Front", es: "Flujo de Habitaciones: De Atrás hacia Adelante" } },
      {
        type: "p",
        text: {
          en: "Across the home, always start at the back — the room farthest from the entrance — and work your way toward the door you came in through. This means you never walk dirty floors back across rooms you have already cleaned.",
          es: "En todo el hogar, siempre comience en la parte trasera — la habitación más lejana de la entrada — y trabaje hacia la puerta por la que entró. Esto evita que pise pisos sucios sobre habitaciones ya limpiadas.",
        },
      },
      { type: "h", text: { en: "Within Each Room: Top to Bottom", es: "Dentro de Cada Habitación: De Arriba hacia Abajo" } },
      {
        type: "p",
        text: {
          en: "Inside the room, work top to bottom. Dust and dirt fall down. If you vacuum first and then dust shelves, the dust lands on a freshly cleaned floor. Ceilings, vents, and tops of cabinets first; baseboards and floors last.",
          es: "Dentro de la habitación, trabaje de arriba hacia abajo. El polvo y la suciedad caen. Si aspira primero y luego sacude estantes, el polvo cae en un piso recién limpiado. Techos, rejillas y partes superiores de gabinetes primero; rodapiés y pisos al final.",
        },
      },
      { type: "h", text: { en: "Spray-Cloth-First Rule", es: "Regla: Rociar el Paño Primero" } },
      {
        type: "p",
        text: {
          en: "Never spray cleaning product directly onto a surface in a client's home. Always spray onto your microfiber cloth first, then wipe. This prevents overspray onto electronics, photographs, finished wood, and fabric — all of which can be permanently damaged by chemicals.",
          es: "Nunca rocíe producto de limpieza directamente sobre una superficie en el hogar de un cliente. Siempre rocíe primero sobre el paño de microfibra y luego limpie. Esto previene sobre-rocío en electrónicos, fotografías, madera acabada y telas — todo lo cual puede dañarse permanentemente por químicos.",
        },
      },
      { type: "h", text: { en: "Microfiber Protocol", es: "Protocolo de Microfibra" } },
      {
        type: "p",
        text: {
          en: "We use color-coded microfiber cloths to prevent cross-contamination between zones of the home:",
          es: "Usamos paños de microfibra codificados por color para evitar la contaminación cruzada entre zonas del hogar:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "BLUE — glass and mirrors only.", es: "AZUL — solo vidrio y espejos." },
          { en: "YELLOW — kitchen surfaces (counters, appliances, cabinets).", es: "AMARILLO — superficies de cocina (mostradores, electrodomésticos, gabinetes)." },
          { en: "GREEN — general dusting (living areas, bedrooms, furniture).", es: "VERDE — sacudido general (áreas comunes, habitaciones, muebles)." },
          { en: "RED — bathroom surfaces. Never use a red cloth anywhere else.", es: "ROJO — superficies de baño. Nunca use un paño rojo en otro lugar." },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "A red cloth used on a kitchen counter is a critical hygiene violation. When in doubt, grab a fresh cloth — bring more than you think you need to every job.",
          es: "Un paño rojo usado en un mostrador de cocina es una violación crítica de higiene. En caso de duda, tome un paño nuevo — lleve más de los que cree necesarios a cada trabajo.",
        },
      },
      { type: "h", text: { en: "Supply Placement", es: "Colocación de Suministros" } },
      {
        type: "p",
        text: {
          en: "Never place cleaning supplies, sprays, or buckets on furniture or directly on the floor in a client's home. Use the supply caddy. Chemical bottles can sweat and leave rings on wood, marble, and granite. Caddies on tile or in tubs only.",
          es: "Nunca coloque suministros de limpieza, rociadores o cubetas sobre muebles o directamente sobre el piso en el hogar de un cliente. Use el portasuministros. Las botellas de químicos pueden sudar y dejar marcas en madera, mármol y granito. Coloque el portasuministros solo sobre azulejo o dentro de tinas.",
        },
      },

      { type: "h", text: { en: "Your Supply Bag — Your Responsibility", es: "Su Bolsa de Suministros — Su Responsabilidad" } },
      {
        type: "p",
        text: {
          en: "You are responsible for bringing your own complete set of assigned supplies to every job. Supplies, mops, dusters, and the caddy itself are Phes property — they must be accounted for, kept clean, and returned in working condition.",
          es: "Usted es responsable de llevar su propio juego completo de suministros asignados a cada trabajo. Los suministros, trapeadores, plumeros y el portasuministros son propiedad de Phes — deben rendirse cuentas de ellos, mantenerse limpios y devolverse en condiciones funcionales.",
        },
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "If you arrive at a job and realize you left your supply bag at the previous client's home (or anywhere else), call the office immediately. Do not proceed without supplies — improvising with the client's products is not allowed.",
          es: "Si llega a un trabajo y se da cuenta que dejó su bolsa de suministros en el hogar del cliente anterior (o en cualquier otro lugar), llame a la oficina inmediatamente. No proceda sin suministros — improvisar con los productos del cliente no está permitido.",
        },
      },
      {
        type: "p",
        text: {
          en: "If equipment is lost or damaged, report it to the office on the same day so it can be replaced before your next assignment. Repeated loss or damage is documented under the equipment policy in the Employee Handbook.",
          es: "Si se pierde o daña el equipo, repórtelo a la oficina el mismo día para que pueda reemplazarse antes de su próxima asignación. La pérdida o daño repetido se documenta bajo la política de equipo en el Manual del Empleado.",
        },
      },

      { type: "h", text: { en: "Team Arrival Protocol", es: "Protocolo de Llegada en Equipo" } },
      {
        type: "p",
        text: {
          en: "When you are assigned to a job as a team, you wait for every team member to arrive before entering the client's home. No one goes inside alone, even if you have the keys or door code.",
          es: "Cuando está asignado a un trabajo en equipo, espera a que cada miembro del equipo llegue antes de entrar al hogar del cliente. Nadie entra solo, incluso si tiene las llaves o el código de la puerta.",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Each teammate brings their own complete set of supplies — never share one supply bag between two people.", es: "Cada compañero lleva su propio juego completo de suministros — nunca se comparte una sola bolsa de suministros entre dos personas." },
          { en: "Arriving as a unit is part of the professional impression we make on the client.", es: "Llegar como una unidad es parte de la impresión profesional que damos al cliente." },
          { en: "It is also a safety standard — there is always a witness present.", es: "También es un estándar de seguridad — siempre hay un testigo presente." },
        ],
      },
    ],
  },

  // 6. Products & Tools
  {
    id: "products-tools",
    number: 6,
    iconKind: "spray",
    title: { en: "Products & Tools", es: "Productos y Herramientas" },
    subtitle: {
      en: "What we use, where to use it, and the safety rules that go with each one.",
      es: "Qué usamos, dónde usarlo y las reglas de seguridad que acompañan a cada producto.",
    },
    estimatedMinutes: 9,
    blocks: [
      {
        type: "p",
        text: {
          en: "The right product on the right surface is the difference between a flawless clean and a permanent damage claim. Read this module before your first job — when in doubt, default to the gentler product.",
          es: "El producto correcto en la superficie correcta es la diferencia entre una limpieza impecable y un reclamo por daños permanentes. Lea este módulo antes de su primer trabajo — en caso de duda, opte por el producto más suave.",
        },
      },

      { type: "h", text: { en: "All-Purpose & Surface", es: "Multiusos y Superficies" } },
      {
        type: "bullets",
        items: [
          {
            en: "Mr. Clean with Febreze — general surface cleaner and deodorizer for counters, appliance exteriors, and bathrooms. Spray on cloth, not surface.",
            es: "Mr. Clean con Febreze — limpiador y desodorizador general para mostradores, exteriores de electrodomésticos y baños. Rocíe sobre el paño, no sobre la superficie.",
          },
          {
            en: "Simple Green concentrate — all-purpose degreaser. Dilute correctly: full strength for grout / heavy grease, 1:10 for general surfaces, 1:30 for light cleaning and glass prep.",
            es: "Simple Green concentrado — desengrasante multiusos. Diluya correctamente: fuerza total para lechada / grasa pesada, 1:10 para superficies generales, 1:30 para limpieza ligera y preparación de vidrio.",
          },
          {
            en: "Dawn Dish Soap — for dishes when requested by the client; also a safe degreaser for range hoods and stovetops.",
            es: "Jabón Dawn — para platos cuando el cliente lo solicite; también un desengrasante seguro para campanas extractoras y estufas.",
          },
        ],
      },

      { type: "h", text: { en: "Bathrooms, Sinks, and Tubs", es: "Baños, Lavabos y Tinas" } },
      {
        type: "bullets",
        items: [
          {
            en: "Bar Keepers Friend Liquid — for stainless sinks, porcelain tubs, and stovetops. Apply to a wet surface, scrub, then rinse fully so no residue dries on the surface.",
            es: "Bar Keepers Friend Líquido — para lavabos de acero inoxidable, tinas de porcelana y estufas. Aplique sobre superficie mojada, frote y enjuague por completo para que no quede residuo seco.",
          },
          {
            en: "Scouring sticks — for grout, tile, and stovetops. Wet the surface first. Rub gently in a circular motion. Rinse thoroughly to remove any abrasive residue.",
            es: "Barras abrasivas — para lechada, azulejo y estufas. Moje la superficie primero. Frote suavemente con movimiento circular. Enjuague bien para eliminar cualquier residuo abrasivo.",
          },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "NEVER use Bar Keepers Friend on natural stone (marble, granite), polished metals, or lacquered surfaces — it will permanently etch the finish.",
          es: "NUNCA use Bar Keepers Friend en piedra natural (mármol, granito), metales pulidos o superficies lacadas — corroe el acabado permanentemente.",
        },
      },

      { type: "h", text: { en: "Glass and Mirrors", es: "Vidrio y Espejos" } },
      {
        type: "bullets",
        items: [
          {
            en: "Ecolab Window Cleaner — glass and mirrors only. Spray onto your blue microfiber cloth first, never directly on the surface. Wipe in a smooth S-pattern for a streak-free finish.",
            es: "Ecolab Window Cleaner — solo vidrio y espejos. Rocíe primero sobre su paño de microfibra azul, nunca directamente sobre la superficie. Limpie con un patrón en S suave para un acabado sin rayas.",
          },
          {
            en: "Unger Window Cleaning Pole — for high windows and out-of-reach glass. Attach the microfiber head for general dusting or the squeegee head for streak-free finish.",
            es: "Pértiga de Limpieza de Ventanas Unger — para ventanas altas y vidrio de difícil alcance. Acople el cabezal de microfibra para sacudido general o el cabezal de escobilla de goma para acabado sin rayas.",
          },
        ],
      },

      { type: "h", text: { en: "Floors", es: "Pisos" } },
      {
        type: "p",
        text: {
          en: "OCedar Deep Clean Mop — used for mopping all floor types. Wring the mop thoroughly before each pass; do not oversaturate hardwood, laminate, or LVP, which can warp or lift seams over time.",
          es: "Trapeador OCedar Deep Clean — usado para trapear todo tipo de piso. Escurra el trapeador a fondo antes de cada pasada; no sobre-sature pisos de madera, laminado o LVP, lo que puede deformar o levantar uniones con el tiempo.",
        },
      },

      { type: "h", text: { en: "Dusting", es: "Sacudido" } },
      {
        type: "p",
        text: {
          en: "Swiffer Dusters — for blinds, baseboards, ceiling fans, and shelves. Replace the pad as soon as it is visibly dirty — a saturated duster just redistributes dust.",
          es: "Plumeros Swiffer — para persianas, rodapiés, ventiladores de techo y estantes. Reemplace la almohadilla en cuanto esté visiblemente sucia — un plumero saturado solo redistribuye el polvo.",
        },
      },

      { type: "h", text: { en: "Step Stools — Safety", es: "Banquillos — Seguridad" } },
      {
        type: "p",
        text: {
          en: "Inspect a step stool before every single use — even if you used it ten minutes ago. Check that:",
          es: "Inspeccione un banquillo antes de cada uso — incluso si lo usó hace diez minutos. Verifique que:",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "All four feet sit flat on a hard, level surface — no carpet edges, no rugs, no transition strips.", es: "Las cuatro patas se apoyen completamente en una superficie dura y nivelada — sin bordes de alfombra, sin tapetes, sin tiras de transición." },
          { en: "There is zero wobble when you press down on the platform.", es: "No haya ningún tambaleo cuando presione la plataforma." },
          { en: "Your weight is on the second step or below — never stand on the very top step.", es: "Su peso esté en el segundo escalón o por debajo — nunca se pare en el escalón superior." },
          { en: "If anything looks bent, cracked, or unstable, mark it and tell office. Do not use it.", es: "Si algo se ve doblado, agrietado o inestable, márquelo e informe a la oficina. No lo use." },
        ],
      },

      {
        type: "callout",
        tone: "info",
        text: {
          en: "Quick rule: spray the cloth, not the surface — for every product on this page. The only exceptions are floor cleaner (applied to the mop) and tub/sink cleaners that explicitly require contact with the wet surface.",
          es: "Regla rápida: rocíe el paño, no la superficie — para cada producto de esta página. Las únicas excepciones son el limpiador de pisos (aplicado al trapeador) y los limpiadores de tina/lavabo que requieren explícitamente contacto con la superficie mojada.",
        },
      },
    ],
  },

  // 7. MaidCentral App
  {
    id: "maidcentral",
    number: 7,
    iconKind: "pin",
    title: { en: "MaidCentral App", es: "Aplicación MaidCentral" },
    subtitle: {
      en: "The two-clock system, individual GPS check-in, efficiency, and time corrections.",
      es: "El sistema de dos relojes, check-in GPS individual, eficiencia y correcciones de tiempo.",
    },
    estimatedMinutes: 14,
    blocks: [
      {
        type: "p",
        text: {
          en: "Your pay accuracy depends on understanding MaidCentral's clock system. Read this module twice if you have to — every minute you don't track is a minute you don't get paid for, and every minute mis-tracked creates payroll errors that take days to unwind.",
          es: "La precisión de su pago depende de entender el sistema de reloj de MaidCentral. Lea este módulo dos veces si es necesario — cada minuto que no rastrea es un minuto que no se le paga, y cada minuto mal rastreado crea errores de nómina que tardan días en corregirse.",
        },
      },

      { type: "h", text: { en: "The Two-Clock System", es: "El Sistema de Dos Relojes" } },
      {
        type: "p",
        text: {
          en: "MaidCentral has TWO separate clocks. Both must be used correctly — they measure different things and feed different parts of your paycheck.",
          es: "MaidCentral tiene DOS relojes separados. Ambos deben usarse correctamente — miden cosas diferentes y alimentan partes diferentes de su pago.",
        },
      },
      {
        type: "table",
        head: {
          en: ["Clock", "When", "What it pays"],
          es: ["Reloj", "Cuándo", "Qué paga"],
        },
        rows: [
          { en: ["Clock In / Clock Out (Day Clock)", "At the start and end of your workday", "Total hours, overtime, and travel pay"], es: ["Clock In / Clock Out (Reloj de Día)", "Al inicio y final de su día de trabajo", "Horas totales, horas extras y pago de traslado"] },
          { en: ["Check In / Check Out (Job Clock)", "When you arrive and leave each client home", "Commission and job-level pay"], es: ["Check In / Check Out (Reloj de Trabajo)", "Cuando llega y sale de cada hogar", "Comisión y pago por trabajo"] },
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: {
          en: "If you Clock In but never Check In to jobs, all job-level pay data is lost. If you Check In to jobs without a Day Clock running, payroll will error. Both must run together, all day.",
          es: "Si hace Clock In pero nunca hace Check In a los trabajos, todos los datos de pago por trabajo se pierden. Si hace Check In sin un reloj de día corriendo, la nómina dará error. Ambos deben funcionar juntos, todo el día.",
        },
      },

      { type: "h", text: { en: "Travel Pay — What It Covers", es: "Pago de Traslado — Qué Cubre" } },
      {
        type: "p",
        text: {
          en: "Travel pay = the time you are Clocked In for the day but NOT Checked Into a job. This covers your drive time between client homes. It is one of the reasons the Day Clock matters: every minute you forget to start it is a minute of travel pay you lose.",
          es: "Pago de traslado = el tiempo en que está con Clock In del día pero NO con Check In en un trabajo. Esto cubre su tiempo de manejo entre hogares. Es una de las razones por las que el reloj de día importa: cada minuto que olvida iniciarlo es un minuto de pago de traslado que pierde.",
        },
      },

      { type: "h", text: { en: "Individual Clocks — Where Pay Comes From", es: "Relojes Individuales — De Donde Sale el Pago" } },
      {
        type: "p",
        text: {
          en: "MaidCentral tracks each person individually. It does NOT average team time.",
          es: "MaidCentral rastrea a cada persona individualmente. NO promedia el tiempo del equipo.",
        },
      },
      {
        type: "p",
        text: {
          en: "Real example: You and your partner are assigned the same job. You arrive at 9:00 AM and Check In. Your partner arrives at 9:17 AM and Checks In. MaidCentral records two separate job clocks — yours starts at 9:00, your partner's at 9:17. The pay formula uses each person's percentage of time on the job. Your partner worked a smaller percentage, so they receive less commission. You earn more because you were on-site and Checked In the whole time.",
          es: "Ejemplo real: Usted y su compañero están asignados al mismo trabajo. Usted llega a las 9:00 AM y hace Check In. Su compañero llega a las 9:17 AM y hace Check In. MaidCentral registra dos relojes de trabajo separados — el suyo empieza a las 9:00, el de su compañero a las 9:17. La fórmula de pago usa el porcentaje de tiempo de cada persona en el trabajo. Su compañero trabajó un porcentaje menor, así que recibe menos comisión. Usted gana más porque estuvo en sitio y con Check In todo el tiempo.",
        },
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "This is not a penalty — it's accuracy. Check In when you arrive on site, Check Out when you leave. Your clock is your paycheck.",
          es: "Esto no es un castigo — es precisión. Haga Check In cuando llegue al sitio, Check Out cuando se vaya. Su reloj es su sueldo.",
        },
      },

      { type: "h", text: { en: "GPS — The 600-Foot Rule", es: "GPS — La Regla de los 600 Pies" } },
      {
        type: "p",
        text: {
          en: "MaidCentral records your GPS location at every Check In and Check Out. If your location is more than 600 feet from the client's address, a red flag appears in the manager dashboard. The check-in still goes through — but every flag gets reviewed.",
          es: "MaidCentral registra su ubicación GPS en cada Check In y Check Out. Si su ubicación está a más de 600 pies de la dirección del cliente, aparece una alerta roja en el panel del gerente. El check-in se procesa — pero cada alerta se revisa.",
        },
      },
      {
        type: "bullets",
        items: [
          { en: "Location services must be enabled on your phone at all times during work.", es: "Los servicios de ubicación deben estar activados en su teléfono durante todo el trabajo." },
          { en: "Check In at the front door — not from your car, not from down the street.", es: "Haga Check In en la puerta principal — no desde su auto, no desde calle abajo." },
          { en: "A GPS error (red ban icon) means your location couldn't be captured — that gets flagged too.", es: "Un error de GPS (ícono rojo de prohibición) significa que su ubicación no pudo capturarse — eso también se marca." },
        ],
      },

      { type: "h", text: { en: "Your Efficiency Score", es: "Su Puntuación de Eficiencia" } },
      {
        type: "p",
        text: {
          en: "Efficiency % = Total Job Clock Hours ÷ Total Day Clock Hours. The remainder is drive and travel time.",
          es: "Eficiencia % = Total de Horas de Reloj de Trabajo ÷ Total de Horas de Reloj de Día. El resto es tiempo de manejo y traslado.",
        },
      },
      {
        type: "p",
        text: {
          en: "Example: Clocked In for 8 hours, Checked Into jobs for 6.5 hours → 81% efficiency. The remaining 1.5 hours is drive/travel. Target: 80% or higher.",
          es: "Ejemplo: Clock In de 8 horas, Check In en trabajos de 6.5 horas → 81% de eficiencia. Las 1.5 horas restantes son traslado. Meta: 80% o más.",
        },
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "The most important metric managers track is Revenue Per Clock Hour — how much revenue Phes earns for every hour you are clocked in. Checking in promptly and finishing within allowed time directly improves this number for everyone.",
          es: "La métrica más importante que los gerentes rastrean es Ingreso Por Hora de Reloj — cuánto ingreso gana Phes por cada hora que usted está con Clock In. Hacer Check In con prontitud y terminar dentro del tiempo asignado mejora este número directamente para todos.",
        },
      },

      { type: "h", text: { en: "Commercial Jobs — Allowed Hours", es: "Trabajos Comerciales — Horas Asignadas" } },
      {
        type: "p",
        text: {
          en: "Commercial jobs have an allowed-hours budget (e.g., 3 hours). Pay is based on those allowed hours, not necessarily the actual time. But: if you only work 1 of the 3 allowed hours, the Prorate Employee Pay setting reduces your pay to actual time worked. Finish the job in the allotted time. If something is off, call the office BEFORE uploading completion photos — never close out early without communicating first.",
          es: "Los trabajos comerciales tienen un presupuesto de horas asignadas (por ejemplo, 3 horas). El pago se basa en esas horas asignadas, no necesariamente en el tiempo real. Pero: si solo trabaja 1 de las 3 horas asignadas, la configuración de Prorate Employee Pay reduce su pago al tiempo real trabajado. Termine el trabajo en el tiempo asignado. Si algo está mal, llame a la oficina ANTES de subir las fotos de finalización — nunca cierre temprano sin comunicarse primero.",
        },
      },

      { type: "h", text: { en: "Time Correction Requests", es: "Solicitudes de Corrección de Tiempo" } },
      {
        type: "p",
        text: {
          en: "If you forget to Check In, Check Out, Clock In, or Clock Out, submit a Clock/Job Change Request through the app. The office reviews and approves corrections. Do not text or DM a manager — use the formal request system inside MaidCentral. The audit trail matters.",
          es: "Si olvida hacer Check In, Check Out, Clock In o Clock Out, envíe una solicitud de Clock/Job Change Request a través de la aplicación. La oficina revisa y aprueba las correcciones. No envíe mensaje ni DM a un gerente — use el sistema formal de solicitudes dentro de MaidCentral. El registro de auditoría importa.",
        },
      },

      { type: "h", text: { en: "The Job Worksheet — 3 Tiers", es: "La Hoja de Trabajo — 3 Niveles" } },
      {
        type: "p",
        text: {
          en: "Inside MaidCentral, every job has a Worksheet. Read it before you start. The instructions are organized in three tiers, from most specific to most general:",
          es: "Dentro de MaidCentral, cada trabajo tiene una Hoja de Trabajo. Léala antes de comenzar. Las instrucciones están organizadas en tres niveles, del más específico al más general:",
        },
      },
      {
        type: "bullets",
        items: [
          {
            en: "Tier 1 — Client-Specific Notes. Things only this client wants. \"Don't move the rug under the table.\" Highest priority.",
            es: "Nivel 1 — Notas Específicas del Cliente. Cosas que solo este cliente quiere. \"No mueva la alfombra debajo de la mesa.\" Máxima prioridad.",
          },
          {
            en: "Tier 2 — General Service Standards. The standard scope for the type of cleaning (Standard, Deep, Move-In/Out). Applies when client notes don't say otherwise.",
            es: "Nivel 2 — Estándares Generales del Servicio. El alcance estándar para el tipo de limpieza (Estándar, Profunda, Entrada/Salida). Aplica cuando las notas del cliente no dicen lo contrario.",
          },
          {
            en: "Tier 3 — Company Policy. Phes-wide rules: shoe covers, color-coded cloths, top-to-bottom flow. Always apply.",
            es: "Nivel 3 — Política de la Compañía. Reglas de toda Phes: cubrezapatos, paños codificados por color, flujo de arriba hacia abajo. Siempre aplican.",
          },
        ],
      },
      {
        type: "p",
        text: {
          en: "When two tiers conflict, the higher tier wins. A specific client note overrides the standard scope. The standard scope overrides nothing — company policy is non-negotiable.",
          es: "Cuando dos niveles entran en conflicto, gana el nivel superior. Una nota específica del cliente reemplaza el alcance estándar. El alcance estándar no reemplaza la política de la compañía — esta no es negociable.",
        },
      },
      { type: "h", text: { en: "Marking the Job Complete", es: "Marcar el Trabajo Completado" } },
      {
        type: "p",
        text: {
          en: "When you finish: Check Out, attach \"after\" photos of every room cleaned, note any issues you found (broken items, areas you couldn't access), and tap Complete. Do not mark Complete until you have walked through every room one final time.",
          es: "Cuando termine: haga Check Out, adjunte fotos de \"después\" de cada habitación limpiada, anote cualquier problema encontrado (artículos rotos, áreas inaccesibles) y toque Completar. No marque Completar hasta haber recorrido cada habitación una última vez.",
        },
      },
    ],
  },

  // 8. Qleno App — Coming Soon
  {
    id: "qleno-app",
    number: 8,
    iconKind: "sparkle",
    title: { en: "Qleno App", es: "Aplicación Qleno" },
    subtitle: {
      en: "Phes is migrating to Qleno — full training coming soon.",
      es: "Phes está migrando a Qleno — entrenamiento completo próximamente.",
    },
    estimatedMinutes: 2,
    blocks: [
      {
        type: "p",
        text: {
          en: "Phes is in the process of migrating from MaidCentral to Qleno — our own purpose-built operations platform. Once Qleno is live for field operations, this module will be expanded with screen-by-screen instructions for clock-in, check-in, the job worksheet, mileage submission, and team chat.",
          es: "Phes está en el proceso de migrar de MaidCentral a Qleno — nuestra propia plataforma de operaciones diseñada a medida. Una vez que Qleno esté activo para operaciones de campo, este módulo se expandirá con instrucciones pantalla por pantalla para registrarse, hacer check-in, la hoja de trabajo, envío de millaje y chat del equipo.",
        },
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "For now, continue to use MaidCentral as your operational app. Office will give you advance notice and a hands-on training session before any cutover to Qleno.",
          es: "Por ahora, continúe usando MaidCentral como su aplicación operacional. La oficina le dará aviso anticipado y una sesión de entrenamiento práctica antes de cualquier cambio a Qleno.",
        },
      },
      {
        type: "p",
        text: {
          en: "Screen capture instructions and walkthroughs will be added to this module when Qleno is ready for field use.",
          es: "Se agregarán capturas de pantalla y guías paso a paso a este módulo cuando Qleno esté listo para uso en campo.",
        },
      },
    ],
  },

  // 9. Acknowledgment (rendered specially as final step)
  {
    id: "acknowledgment",
    number: 9,
    iconKind: "shield",
    title: { en: "Acknowledgment", es: "Reconocimiento" },
    subtitle: {
      en: "Review, take the quiz, and acknowledge your training.",
      es: "Revise, tome el examen y reconozca su entrenamiento.",
    },
    estimatedMinutes: 6,
    blocks: [
      { type: "h", text: { en: "Summary of What You Have Learned", es: "Resumen de lo Aprendido" } },
      {
        type: "bullets",
        items: [
          { en: "Phes is built on reliability, pride in craft, respect, honesty, and growth — and your employment is at-will.", es: "Phes se basa en confiabilidad, orgullo en el oficio, respeto, honestidad y crecimiento — y su empleo es a voluntad." },
          { en: "You have a 7-minute grace period; the tardiness scale runs 1–2 recorded, 3rd written, 4th final, 5th termination.", es: "Tiene 7 minutos de gracia; la escala es 1ª–2ª registrada, 3ª escrita, 4ª última, 5ª terminación." },
          { en: "You accrue up to 40 hours of paid sick leave (PLAWA), and earn 40 hours of PTO at year 1 / 80 hours at year 2.", es: "Acumula hasta 40 horas de licencia por enfermedad (PLAWA), y gana 40 horas de PTO al año 1 / 80 horas al año 2." },
          { en: "Phes observes 6 paid holidays plus your birthday.", es: "Phes observa 6 feriados pagados más su cumpleaños." },
          { en: "Wear the Phes uniform with shoe covers in every home; personal phones stay out of sight during the visit.", es: "Use el uniforme Phes con cubrezapatos en cada hogar; los teléfonos personales se mantienen fuera de la vista durante la visita." },
          { en: "Training pay is $20/hr; activated technicians earn 35% commission. The Fix-It Rule means a same-day return — or a $50 deduction if the company has to send another team.", es: "El pago de entrenamiento es $20/h; los técnicos activos ganan 35% de comisión. La Regla de Corrección significa regresar el mismo día — o un descuento de $50 si la compañía debe enviar a otro equipo." },
          { en: "Your first 60 days are Quality Probation. Mileage is reimbursed at the IRS rate, job-to-job only, within 30 days.", es: "Sus primeros 60 días son Periodo de Prueba de Calidad. El millaje se reembolsa a la tarifa del IRS, solo entre trabajos, dentro de 30 días." },
          { en: "Clean back-to-front, top-to-bottom, spray your cloth (never the surface), and follow the color-coded microfiber rules.", es: "Limpie de atrás hacia adelante, de arriba hacia abajo, rocíe el paño (nunca la superficie) y siga las reglas de microfibra codificada por color." },
          { en: "Use the right product for the job — Bar Keepers Friend stays off natural stone, Ecolab on glass only, and Simple Green follows its dilution chart.", es: "Use el producto correcto para cada tarea — Bar Keepers Friend no va sobre piedra natural, Ecolab solo en vidrio y Simple Green sigue su tabla de dilución." },
          { en: "Inspect every step stool before each use; never stand on the top step.", es: "Inspeccione cada banquillo antes de cada uso; nunca se pare en el escalón superior." },
          { en: "Phes does not handle bodily fluids, organize belongings, accept cash, or clean inside appliances unless added as a paid scope. Tipping is allowed but never requested.", es: "Phes no maneja fluidos corporales, no organiza pertenencias, no acepta efectivo y no limpia dentro de electrodomésticos a menos que se agregue como alcance pagado. Las propinas están permitidas pero nunca se solicitan." },
          { en: "Clock In once per workday; Check In once per job. Read the Worksheet — client notes beat scope, scope beats nothing, company policy always applies.", es: "Clock In una vez por día; Check In una vez por trabajo. Lea la Hoja de Trabajo — notas del cliente vencen al alcance, el alcance no vence nada, la política de la compañía siempre aplica." },
        ],
      },
      { type: "h", text: { en: "Quality Control", es: "Control de Calidad" } },
      {
        type: "p",
        text: {
          en: "Phes conducts random post-clean quality inspections — sometimes by a teammate, sometimes by office. The standard is plain: every surface you touched must be visibly clean and streak-free.",
          es: "Phes realiza inspecciones de calidad aleatorias después de la limpieza — a veces por un compañero, a veces por la oficina. El estándar es claro: cada superficie que tocó debe estar visiblemente limpia y sin rayas.",
        },
      },
      {
        type: "callout",
        tone: "info",
        text: {
          en: "During your first 60 days (Quality Probation) inspections happen more often. This is by design — it is how new technicians build the habits that become muscle memory.",
          es: "Durante sus primeros 60 días (Periodo de Prueba de Calidad) las inspecciones suceden con más frecuencia. Es por diseño — así es como los nuevos técnicos construyen los hábitos que se convierten en memoria muscular.",
        },
      },

      {
        type: "p",
        text: {
          en: "By submitting the acknowledgment below, you confirm that you have read, understood, and agree to follow each of the policies covered in this training. A copy of your acknowledgment is sent to Phes management.",
          es: "Al enviar el reconocimiento a continuación, confirma que ha leído, entendido y acepta seguir cada una de las políticas cubiertas en este entrenamiento. Se envía una copia de su reconocimiento a la gerencia de Phes.",
        },
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// QUIZ — scenario-based situations a technician faces on the job
// ─────────────────────────────────────────────────────────────────────────────

const BASE_QUIZ: QuizQuestion[] = [
  {
    id: "q-room-flow",
    moduleId: "cleaning-standards",
    prompt: {
      en: "You arrive at a client's home for a standard clean. Which room do you start in?",
      es: "Llegas al hogar de un cliente para una limpieza estándar. ¿En qué habitación empiezas?",
    },
    options: [
      { en: "The kitchen — it's the dirtiest", es: "La cocina — es la más sucia" },
      { en: "The room farthest from the entrance, working back toward the door", es: "La habitación más lejana de la entrada, trabajando hacia la puerta" },
      { en: "Whichever room the client is not currently in", es: "La habitación donde el cliente no esté en ese momento" },
      { en: "The bathroom — to give chemicals time to sit", es: "El baño — para que los químicos tengan tiempo de actuar" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-room-order",
    moduleId: "cleaning-standards",
    prompt: {
      en: "You're cleaning a bedroom. In what order do you work the surfaces?",
      es: "Estás limpiando un dormitorio. ¿En qué orden trabajas las superficies?",
    },
    options: [
      { en: "Floors first so they dry while you do the rest", es: "Pisos primero para que se sequen mientras haces el resto" },
      { en: "Whatever the client prefers", es: "Lo que el cliente prefiera" },
      { en: "Top to bottom — vents, shelves, then baseboards and floor last", es: "De arriba hacia abajo — rejillas, estantes, luego rodapiés y piso al final" },
      { en: "Side to side — order doesn't matter", es: "De un lado al otro — el orden no importa" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-products-granite",
    moduleId: "products-tools",
    prompt: {
      en: "You're about to wipe a granite kitchen countertop. Which product should you NEVER use on it?",
      es: "Vas a limpiar un mostrador de granito en la cocina. ¿Qué producto NUNCA debes usar?",
    },
    options: [
      { en: "Mr. Clean with Febreze on a yellow cloth", es: "Mr. Clean con Febreze en un paño amarillo" },
      { en: "A damp microfiber cloth with water", es: "Un paño de microfibra húmedo con agua" },
      { en: "Bar Keepers Friend Liquid", es: "Bar Keepers Friend Líquido" },
      { en: "Diluted Simple Green at 1:30", es: "Simple Green diluido a 1:30" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-products-mop",
    moduleId: "products-tools",
    prompt: {
      en: "You're about to mop a hardwood floor with the OCedar Deep Clean Mop. What do you do first?",
      es: "Vas a trapear un piso de madera con el trapeador OCedar Deep Clean. ¿Qué haces primero?",
    },
    options: [
      { en: "Soak the mop fully so it cleans deeper", es: "Empapas el trapeador para que limpie más profundo" },
      { en: "Wring the mop thoroughly so it's damp, not soaked", es: "Escurres bien el trapeador para que esté húmedo, no empapado" },
      { en: "Spray the cleaner directly on the floor", es: "Rocías el limpiador directamente sobre el piso" },
      { en: "Use the mop dry — water can warp wood", es: "Usas el trapeador seco — el agua puede deformar la madera" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-products-glass",
    moduleId: "products-tools",
    prompt: {
      en: "You need to clean a bathroom mirror. Where do you spray the Ecolab glass cleaner?",
      es: "Necesitas limpiar un espejo del baño. ¿Dónde rocías el limpiador de vidrio Ecolab?",
    },
    options: [
      { en: "Directly on the mirror, then wipe in circles", es: "Directamente sobre el espejo, luego limpias en círculos" },
      { en: "On a yellow cloth, then wipe", es: "Sobre un paño amarillo, luego limpias" },
      { en: "On a blue microfiber cloth, then wipe in an S-pattern", es: "Sobre un paño de microfibra azul, luego limpias en patrón de S" },
      { en: "On the floor first, so it doesn't drip", es: "En el piso primero, para que no gotee" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-products-simplegreen",
    moduleId: "products-tools",
    prompt: {
      en: "You're prepping Simple Green for light surface cleaning. What's the right dilution?",
      es: "Estás preparando Simple Green para limpieza ligera. ¿Cuál es la dilución correcta?",
    },
    options: [
      { en: "Full strength — Simple Green is always full strength", es: "Fuerza total — Simple Green siempre va a fuerza total" },
      { en: "1:10", es: "1:10" },
      { en: "1:30", es: "1:30" },
      { en: "1:100", es: "1:100" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-shoe-covers",
    moduleId: "dress-code",
    prompt: {
      en: "You arrive at a client's home and realize you forgot your shoe covers in your other bag. What do you do?",
      es: "Llegas al hogar de un cliente y te das cuenta que olvidaste los cubrezapatos en tu otra bolsa. ¿Qué haces?",
    },
    options: [
      { en: "Take off your shoes at the door and clean barefoot", es: "Te quitas los zapatos en la puerta y limpias descalzo" },
      { en: "Walk in carefully without covers — just don't track dirt", es: "Entras con cuidado sin cubrezapatos — solo no traigas suciedad" },
      { en: "Don't enter — get fresh covers from your vehicle, or call office for a teammate to bring some", es: "No entras — toma cubrezapatos nuevos de tu vehículo, o llama a la oficina" },
      { en: "Ask the client if they mind", es: "Le preguntas al cliente si le importa" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-running-late",
    moduleId: "attendance",
    prompt: {
      en: "You're stuck in traffic and will arrive 15 minutes after your scheduled time. What do you do?",
      es: "Estás en el tráfico y llegarás 15 minutos después de tu hora programada. ¿Qué haces?",
    },
    options: [
      { en: "Drive faster to make up time", es: "Manejas más rápido para recuperar el tiempo" },
      { en: "Don't worry about it — 15 minutes is within the grace period", es: "No te preocupes — 15 minutos están dentro del periodo de gracia" },
      { en: "Call or text the office immediately so the client can be notified", es: "Llamas o envías mensaje a la oficina inmediatamente para que el cliente sea notificado" },
      { en: "Just show up when you get there — they'll figure it out", es: "Solo llegas cuando puedas — lo entenderán" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-fixit",
    moduleId: "compensation",
    prompt: {
      en: "An hour after you finish a clean, the client calls Phes unhappy with the bathroom. What happens?",
      es: "Una hora después de terminar una limpieza, el cliente llama a Phes inconforme con el baño. ¿Qué sucede?",
    },
    options: [
      { en: "Nothing — once the job is marked complete, it's closed", es: "Nada — una vez marcado el trabajo como completado, queda cerrado" },
      { en: "The client gets a refund and we move on", es: "El cliente recibe un reembolso y seguimos adelante" },
      { en: "A team returns the same day to fix it — the Fix-It Rule", es: "Un equipo regresa el mismo día para corregirlo — la Regla de Corrección" },
      { en: "The client can rebook for free next month", es: "El cliente puede reservar de nuevo gratis el próximo mes" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-clock-vs-check",
    moduleId: "maidcentral",
    prompt: {
      en: "You start your workday at 8:00 AM. What's the very first thing you do in MaidCentral?",
      es: "Comienzas tu día de trabajo a las 8:00 AM. ¿Qué es lo primero que haces en MaidCentral?",
    },
    options: [
      { en: "Check In to your first job", es: "Check In en tu primer trabajo" },
      { en: "Clock In for the workday", es: "Clock In para el día de trabajo" },
      { en: "Open the Job Worksheet for the day", es: "Abres la Hoja de Trabajo del día" },
      { en: "Submit yesterday's mileage", es: "Envías el millaje de ayer" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-tier-conflict",
    moduleId: "maidcentral",
    prompt: {
      en: "The Worksheet says \"vacuum all rugs\" but the client note says \"don't move the rug under the dining table.\" What do you do?",
      es: "La Hoja de Trabajo dice \"aspirar todas las alfombras\" pero la nota del cliente dice \"no mueva la alfombra debajo de la mesa del comedor.\" ¿Qué haces?",
    },
    options: [
      { en: "Vacuum every rug — the standard scope wins", es: "Aspiras cada alfombra — el alcance estándar gana" },
      { en: "Skip vacuuming completely — instructions conflict", es: "No aspiras nada — las instrucciones se contradicen" },
      { en: "Follow the client note — leave the dining-table rug alone, vacuum the rest", es: "Sigues la nota del cliente — dejas la alfombra del comedor, aspiras las demás" },
      { en: "Ask the client which they prefer mid-clean", es: "Le preguntas al cliente cuál prefiere durante la limpieza" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-scope-oven",
    moduleId: "welcome",
    prompt: {
      en: "Mid-clean, the client asks if you can clean inside the oven. The Worksheet does not include oven cleaning. What do you do?",
      es: "Durante la limpieza, el cliente te pide que limpies por dentro del horno. La Hoja de Trabajo no incluye limpieza del horno. ¿Qué haces?",
    },
    options: [
      { en: "Clean it — the customer is always right", es: "Lo limpias — el cliente siempre tiene la razón" },
      { en: "Politely explain it's not in today's scope and direct them to office to add it for next time", es: "Explicas cortésmente que no está en el alcance de hoy y los diriges a la oficina para agregarlo la próxima vez" },
      { en: "Clean it but charge them in cash directly", es: "Lo limpias pero les cobras en efectivo directamente" },
      { en: "Refuse and walk out", es: "Te niegas y te vas" },
    ],
    correctIndex: 1,
  },

  // ── Compensation, communication, and policy scenarios ──────────────────────
  {
    id: "q-hourly-overrun",
    moduleId: "compensation",
    prompt: {
      en: "You're an hour into a 3-hour hourly job and you can already tell you won't finish in time. What do you do?",
      es: "Llevas una hora en un trabajo por hora de 3 horas y ya ves que no terminarás a tiempo. ¿Qué haces?",
    },
    options: [
      { en: "Wait until the last hour, then call the office", es: "Esperar a la última hora, luego llamar a la oficina" },
      { en: "Call the office right away — early, while there's still time to talk to the client gracefully", es: "Llamar a la oficina inmediatamente — temprano, mientras aún hay tiempo de hablar con el cliente con elegancia" },
      { en: "Skip the easier rooms to fit it in", es: "Saltar las habitaciones más fáciles para que quepa" },
      { en: "Just leave the job incomplete — they'll figure it out", es: "Dejar el trabajo incompleto — ya lo entenderán" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-comm-split",
    moduleId: "compensation",
    prompt: {
      en: "You and a partner complete a $200 residential job together. How much commission does each of you earn?",
      es: "Tú y un compañero completan juntos un trabajo residencial de $200. ¿Cuánta comisión gana cada uno?",
    },
    options: [
      { en: "$70 each (35% each)", es: "$70 c/u (35% c/u)" },
      { en: "$50 each", es: "$50 c/u" },
      { en: "$35 each (35% pool split two ways)", es: "$35 c/u (el 35% dividido en dos)" },
      { en: "Whichever the office decides", es: "Lo que decida la oficina" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-commercial-early",
    moduleId: "compensation",
    prompt: {
      en: "Your commercial job is assigned 3 hours. You finish the visible work in 1.5 hours and start uploading the completion photos. What's the problem?",
      es: "Tu trabajo comercial tiene 3 horas asignadas. Terminas el trabajo visible en 1.5 horas y empiezas a subir las fotos de finalización. ¿Cuál es el problema?",
    },
    options: [
      { en: "No problem — finishing early is good", es: "No hay problema — terminar temprano es bueno" },
      { en: "It triggers a red flag — the allotted time is calibrated; call the office before closing the job early", es: "Activa una alerta roja — el tiempo asignado está calibrado; llama a la oficina antes de cerrar temprano" },
      { en: "You should clock out and leave", es: "Debes hacer clock out e irte" },
      { en: "You earn extra commission for finishing early", es: "Ganas comisión adicional por terminar temprano" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-gps-checkin",
    moduleId: "maidcentral",
    prompt: {
      en: "You just parked half a block from the client's home. When should you Check In on MaidCentral?",
      es: "Acabas de estacionarte a media cuadra del hogar del cliente. ¿Cuándo debes hacer Check In en MaidCentral?",
    },
    options: [
      { en: "Right now from your car so you don't forget", es: "Ahora mismo desde tu auto para no olvidar" },
      { en: "After you walk to the property — at the door, not from your car", es: "Después de caminar hasta la propiedad — en la puerta, no desde tu auto" },
      { en: "Whenever — GPS is just for show", es: "Cuando sea — el GPS es solo decorativo" },
      { en: "From home, before leaving for the job", es: "Desde casa, antes de salir al trabajo" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-uniform-forgot",
    moduleId: "dress-code",
    prompt: {
      en: "You wake up and realize your Phes shirt is in the wash. What do you do?",
      es: "Te despiertas y te das cuenta de que tu camisa Phes está en la lavadora. ¿Qué haces?",
    },
    options: [
      { en: "Wear a similar-looking personal shirt — clients won't notice", es: "Usar una camisa personal parecida — el cliente no se dará cuenta" },
      { en: "Skip the shirt and go in just a t-shirt", es: "Saltarte la camisa e ir solo en camiseta" },
      { en: "Contact the office before the job — never show up at a client's home out of uniform", es: "Contactar a la oficina antes del trabajo — nunca presentarse en el hogar de un cliente fuera de uniforme" },
      { en: "Borrow a uniform from a teammate at the job", es: "Pedir prestado el uniforme a un compañero en el trabajo" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-supplies-left",
    moduleId: "cleaning-standards",
    prompt: {
      en: "You arrive at your second job of the day and realize you left your supply bag at the previous client's home. What do you do?",
      es: "Llegas a tu segundo trabajo del día y te das cuenta de que dejaste tu bolsa de suministros en el hogar del cliente anterior. ¿Qué haces?",
    },
    options: [
      { en: "Use the client's own products — they'll understand", es: "Usar los productos del cliente — entenderán" },
      { en: "Call the office immediately — do not proceed without supplies", es: "Llamar a la oficina inmediatamente — no proceder sin suministros" },
      { en: "Skip the job and drive home", es: "Saltarte el trabajo y manejar a casa" },
      { en: "Try to clean by hand without supplies", es: "Intentar limpiar a mano sin suministros" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-team-arrival",
    moduleId: "cleaning-standards",
    prompt: {
      en: "You arrive at a client's home five minutes before your assigned partner. The client has given you the door code. What do you do?",
      es: "Llegas al hogar del cliente cinco minutos antes que tu compañero asignado. El cliente te dio el código de la puerta. ¿Qué haces?",
    },
    options: [
      { en: "Go in and start working — get a head start", es: "Entrar y empezar a trabajar — adelantar trabajo" },
      { en: "Wait outside for your partner — you enter together as a team", es: "Esperar afuera a tu compañero — entran juntos como equipo" },
      { en: "Knock once, then enter alone if no one answers", es: "Tocar una vez, luego entrar solo si nadie responde" },
      { en: "Call the office to ask permission to enter alone", es: "Llamar a la oficina para pedir permiso de entrar solo" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sick-tomorrow",
    moduleId: "attendance",
    prompt: {
      en: "You're feeling sick tonight and won't be able to work tomorrow. What is the right way to report it?",
      es: "Te sientes mal esta noche y no podrás trabajar mañana. ¿Cuál es la forma correcta de reportarlo?",
    },
    options: [
      { en: "Text your manager", es: "Enviar mensaje a tu gerente" },
      { en: "Call the office in the morning when you should be at work", es: "Llamar a la oficina en la mañana cuando deberías estar en el trabajo" },
      { en: "Submit a sick request through MaidCentral / Qleno — through the system", es: "Enviar una solicitud por enfermedad a través de MaidCentral / Qleno — a través del sistema" },
      { en: "Just don't show up — they'll figure it out", es: "Simplemente no presentarse — ya lo entenderán" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-pto-request",
    moduleId: "attendance",
    prompt: {
      en: "You want to request PTO for next Friday. What do you do?",
      es: "Quieres solicitar PTO para el próximo viernes. ¿Qué haces?",
    },
    options: [
      { en: "Text your manager directly", es: "Enviar mensaje a tu gerente directamente" },
      { en: "Submit a PTO request through MaidCentral / Qleno — every time-off request goes through the system", es: "Enviar una solicitud de PTO a través de MaidCentral / Qleno — toda solicitud de tiempo libre pasa por el sistema" },
      { en: "Call the office on Friday morning", es: "Llamar a la oficina el viernes por la mañana" },
      { en: "Tell a teammate to relay it for you", es: "Pedir a un compañero que lo transmita por ti" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-unexcused-fourth",
    moduleId: "attendance",
    prompt: {
      en: "You've already had three unexcused absences this year. What happens if you have a fourth?",
      es: "Ya has tenido tres ausencias injustificadas este año. ¿Qué sucede si tienes una cuarta?",
    },
    options: [
      { en: "Coaching conversation", es: "Conversación de orientación" },
      { en: "Written warning", es: "Advertencia por escrito" },
      { en: "Final warning", es: "Última advertencia" },
      { en: "Immediate termination", es: "Terminación inmediata" },
    ],
    correctIndex: 2,
  },

  // ── Speed-cleaning / Sardone framework scenarios ───────────────────────────
  {
    id: "q-sardone-direction",
    moduleId: "cleaning-standards",
    prompt: {
      en: "You're cleaning a bathroom. What does \"top to bottom, left to right\" mean in practice?",
      es: "Estás limpiando un baño. ¿Qué significa \"de arriba hacia abajo, de izquierda a derecha\" en la práctica?",
    },
    options: [
      { en: "Clean wherever looks dirtiest first", es: "Limpiar donde se vea más sucio primero" },
      { en: "Start at the highest point and move in one consistent direction so you never re-contaminate a surface you already cleaned", es: "Empezar en el punto más alto y moverse en una dirección consistente para no volver a contaminar superficies ya limpiadas" },
      { en: "Floors first, then mirrors, then walls", es: "Pisos primero, luego espejos, luego paredes" },
      { en: "Whichever direction your dominant hand prefers", es: "La dirección que prefiera tu mano dominante" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sardone-dwell",
    moduleId: "cleaning-standards",
    prompt: {
      en: "Why do we spray a surface and then move to another task in the same room before wiping?",
      es: "¿Por qué rociamos una superficie y luego pasamos a otra tarea en la misma habitación antes de limpiar?",
    },
    options: [
      { en: "To stretch the job to the assigned time", es: "Para estirar el trabajo al tiempo asignado" },
      { en: "To let the product dwell and do its work — when we come back, it wipes clean faster and more effectively", es: "Para dejar que el producto repose y haga su trabajo — al regresar, se limpia más rápido y con mayor efectividad" },
      { en: "Because the chemical needs sunlight to activate", es: "Porque el químico necesita luz solar para activarse" },
      { en: "To avoid breathing in the spray", es: "Para no respirar el rociador" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sardone-load",
    moduleId: "cleaning-standards",
    prompt: {
      en: "You enter a bathroom and realize your glass cleaner is back in the hallway. What should you have done?",
      es: "Entras al baño y te das cuenta de que tu limpiador de vidrio quedó en el pasillo. ¿Qué deberías haber hecho?",
    },
    options: [
      { en: "Make a quick trip back — no big deal", es: "Hacer un viaje rápido — no es gran cosa" },
      { en: "Loaded your caddy completely before entering the room — every cloth, every product, in one trip", es: "Cargar tu portasuministros completamente antes de entrar — cada paño, cada producto, en un solo viaje" },
      { en: "Skip the mirror — use only what you have", es: "Saltarte el espejo — usar solo lo que tengas" },
      { en: "Ask the client to lend you cleaner", es: "Pedirle al cliente que te preste limpiador" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sardone-spattern",
    moduleId: "cleaning-standards",
    prompt: {
      en: "What's the correct wiping pattern for mirrors and glass?",
      es: "¿Cuál es el patrón correcto para limpiar espejos y vidrio?",
    },
    options: [
      { en: "Tight circular motions — they cover the most surface", es: "Movimientos circulares apretados — cubren más superficie" },
      { en: "Up-and-down only", es: "Solo de arriba hacia abajo" },
      { en: "S-pattern — circular motions leave streaks; the S-pattern lifts dirt cleanly", es: "Patrón en S — los movimientos circulares dejan rayas; el patrón en S levanta la suciedad limpiamente" },
      { en: "Whatever pattern feels natural", es: "Cualquier patrón que se sienta natural" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-sardone-backout",
    moduleId: "cleaning-standards",
    prompt: {
      en: "You just finished mopping the kitchen floor. How do you leave the room?",
      es: "Acabas de terminar de trapear el piso de la cocina. ¿Cómo sales de la habitación?",
    },
    options: [
      { en: "Walk straight out the same way you came in", es: "Salir caminando recto por donde entraste" },
      { en: "Back out — never walk on a freshly mopped floor or you'll leave footprints", es: "Salir de espaldas — nunca camines sobre un piso recién trapeado o dejarás huellas" },
      { en: "Wait inside the room for the floor to dry", es: "Esperar dentro de la habitación a que el piso se seque" },
      { en: "Open a window first, then walk out", es: "Abrir una ventana primero, luego salir" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-sardone-standard",
    moduleId: "cleaning-standards",
    prompt: {
      en: "What does \"clean to a standard, not to a time\" mean?",
      es: "¿Qué significa \"limpiar a un estándar, no a un tiempo\"?",
    },
    options: [
      { en: "Take as long as you want — time doesn't matter", es: "Tomar el tiempo que quieras — el tiempo no importa" },
      { en: "Don't rush. Finish the job correctly. Efficiency comes from the technique, not from cutting corners.", es: "No te apresures. Termina el trabajo correctamente. La eficiencia viene de la técnica, no de tomar atajos." },
      { en: "Clean only the visible dirty spots", es: "Limpiar solo las manchas visibles" },
      { en: "Skip surfaces that look already clean", es: "Saltarte superficies que ya se vean limpias" },
    ],
    correctIndex: 1,
  },

  // ── MaidCentral two-clock system, individual clocks, GPS, efficiency, time corrections
  {
    id: "q-mc-arrive",
    moduleId: "maidcentral",
    prompt: {
      en: "You arrive at a client's home. You already Clocked In for the day at home base. What is the very first thing you do in MaidCentral now?",
      es: "Llegas al hogar del cliente. Ya hiciste Clock In para el día en la base. ¿Qué es lo primero que haces en MaidCentral ahora?",
    },
    options: [
      { en: "Clock In again", es: "Hacer Clock In otra vez" },
      { en: "Check In on the specific job — your Day Clock keeps running", es: "Hacer Check In en el trabajo específico — tu Reloj de Día sigue corriendo" },
      { en: "Open the Worksheet — Check In can wait until you finish", es: "Abrir la Hoja de Trabajo — el Check In puede esperar a que termines" },
      { en: "Submit yesterday's mileage", es: "Enviar el millaje de ayer" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-individual-clocks",
    moduleId: "maidcentral",
    prompt: {
      en: "You both arrive at a job at 9:00 AM. You Check In immediately. Your partner stays in their car and doesn't Check In until 9:20 AM. How does pay end up?",
      es: "Ambos llegan al trabajo a las 9:00 AM. Tú haces Check In inmediatamente. Tu compañero se queda en su auto y no hace Check In hasta las 9:20 AM. ¿Cómo termina el pago?",
    },
    options: [
      { en: "It's split 50/50 — same job, same pay", es: "Se divide 50/50 — mismo trabajo, mismo pago" },
      { en: "MaidCentral averages your times together", es: "MaidCentral promedia los tiempos juntos" },
      { en: "Your Job Clock shows more time on site, so you receive a higher commission share for that job", es: "Tu Reloj de Trabajo muestra más tiempo en sitio, así que recibes una mayor parte de la comisión por ese trabajo" },
      { en: "Whoever Checks Out first earns more", es: "Quien haga Check Out primero gana más" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-mc-gps-distance",
    moduleId: "maidcentral",
    prompt: {
      en: "You're about to Check In, but you're still in your car parked two blocks away. What should you do?",
      es: "Estás a punto de hacer Check In, pero aún estás en tu auto estacionado a dos cuadras. ¿Qué debes hacer?",
    },
    options: [
      { en: "Check In now — close enough", es: "Hacer Check In ahora — está suficientemente cerca" },
      { en: "Drive to the property and walk to the door — Check In only when you're physically on site", es: "Manejar hasta la propiedad y caminar hasta la puerta — hacer Check In solo cuando estás físicamente en sitio" },
      { en: "Skip Check In — GPS won't notice", es: "Saltarte el Check In — el GPS no notará" },
      { en: "Check In from home tomorrow", es: "Hacer Check In desde casa mañana" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-efficiency",
    moduleId: "maidcentral",
    prompt: {
      en: "What is your efficiency score and how is it calculated?",
      es: "¿Qué es tu puntuación de eficiencia y cómo se calcula?",
    },
    options: [
      { en: "Number of jobs completed per day", es: "Número de trabajos completados por día" },
      { en: "Total Job Clock hours divided by total Day Clock hours — how much of your day was spent actively cleaning", es: "Total de horas de Reloj de Trabajo dividido por el total de horas de Reloj de Día — cuánto de tu día fue limpieza activa" },
      { en: "Your client satisfaction score average", es: "Tu promedio de satisfacción del cliente" },
      { en: "Total tips earned divided by hours worked", es: "Total de propinas ganadas dividido por horas trabajadas" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-forgot-checkout",
    moduleId: "maidcentral",
    prompt: {
      en: "You realize you forgot to Check Out of your last job two hours ago. What's the right way to fix it?",
      es: "Te das cuenta de que olvidaste hacer Check Out de tu último trabajo hace dos horas. ¿Cuál es la forma correcta de corregirlo?",
    },
    options: [
      { en: "Text your manager", es: "Enviar mensaje a tu gerente" },
      { en: "DM the office on Slack", es: "Enviar DM a la oficina en Slack" },
      { en: "Submit a Clock/Job Change Request through the MaidCentral app — the office reviews and approves", es: "Enviar una solicitud de Clock/Job Change Request a través de MaidCentral — la oficina revisa y aprueba" },
      { en: "Don't worry about it — payroll will figure it out", es: "No te preocupes — la nómina lo resolverá" },
    ],
    correctIndex: 2,
  },
  {
    id: "q-mc-travel-pay",
    moduleId: "maidcentral",
    prompt: {
      en: "What is travel pay?",
      es: "¿Qué es el pago de traslado?",
    },
    options: [
      { en: "A bonus paid for long drives between cities", es: "Un bono que se paga por manejos largos entre ciudades" },
      { en: "Time when you're Clocked In for the day but NOT Checked Into a job — covers drive time between client homes", es: "Tiempo en que estás con Clock In del día pero NO con Check In en un trabajo — cubre el tiempo de manejo entre hogares" },
      { en: "Reimbursement for gas only", es: "Reembolso solo de gasolina" },
      { en: "Pay for going to and from your home each day", es: "Pago por ir desde y hacia tu casa cada día" },
    ],
    correctIndex: 1,
  },
  {
    id: "q-mc-commercial-1of3",
    moduleId: "maidcentral",
    prompt: {
      en: "A commercial job is assigned 3 allowed hours. You finish what you can see in 1.5 hours. What should you do BEFORE uploading completion photos?",
      es: "Un trabajo comercial tiene 3 horas asignadas. Terminas lo visible en 1.5 horas. ¿Qué debes hacer ANTES de subir las fotos de finalización?",
    },
    options: [
      { en: "Upload them — finishing early is good", es: "Subirlas — terminar temprano es bueno" },
      { en: "Call the office to confirm the time before closing the job — Prorate Employee Pay can cut your pay if the system thinks you closed early without cause", es: "Llamar a la oficina para confirmar el tiempo antes de cerrar el trabajo — Prorate Employee Pay puede recortar tu pago si el sistema piensa que cerraste temprano sin causa" },
      { en: "Just Clock Out for the day", es: "Solo hacer Clock Out del día" },
      { en: "Sit in the parking lot until 3 hours have passed", es: "Quedarte en el estacionamiento hasta que pasen las 3 horas" },
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
