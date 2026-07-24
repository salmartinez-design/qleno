// [cleaning-checklist 2026-07-24] Field reference for the crew — the exact scope
// of what's INCLUDED per service, sourced verbatim from the Phes public site
// (phes.io "What's Included"). Purpose: keep the team inside the booked scope so
// they don't over-deliver (Sal: "it seems they sometimes do more than they
// should"). English + Spanish so the whole crew can read it on-site.
//
// Editing: this is the single source of truth for the checklist. To change a
// task, edit its { en, es } pair here — the page renders whatever's below. Keep
// English and Spanish in sync. If Phes adds a service or an add-on, add it here.

export type ChecklistLang = "en" | "es";
export type Bilingual = { en: string; es: string };

export interface ChecklistSection {
  title: Bilingual;
  items: Bilingual[];
}

export interface ChecklistService {
  key: string;
  title: Bilingual;
  subtitle: Bilingual;
  // Optional emphasis line rendered under the subtitle.
  note?: Bilingual;
  sections: ChecklistSection[];
}

// UI strings for the page chrome, also bilingual.
export const CHECKLIST_UI = {
  title: { en: "Cleaning Checklist", es: "Lista de Limpieza" },
  subtitle: {
    en: "Pick the type of clean — this is what's included.",
    es: "Elija el tipo de limpieza — esto es lo que incluye.",
  },
  back: { en: "Back", es: "Atrás" },
  langLabel: { en: "Language", es: "Idioma" },
  pickClean: { en: "Type of clean", es: "Tipo de limpieza" },
};

// The boundary rule — the whole reason this screen exists. Rendered up top.
export const GOLDEN_RULE: { title: Bilingual; body: Bilingual } = {
  title: { en: "Do the booked scope — nothing more", es: "Haga el servicio reservado — nada más" },
  body: {
    en: "Do everything listed for the clean that was booked, and only that. Extras (see Add-Ons) are paid and only done when they're on the job order.",
    es: "Haga todo lo que aparece para la limpieza reservada, y solo eso. Los extras (vea Adicionales) son pagados y solo se hacen cuando están en la orden de trabajo.",
  },
};

// Shared detail work — Deep Clean and Move-In/Out have the SAME extra scope on
// phes.io ("Everything in the Standard Clean, plus the following detail work").
const DETAIL_WORK: ChecklistSection = {
  title: { en: "Extra detail work", es: "Trabajo detallado adicional" },
  items: [
    { en: "Clean baseboards in all rooms (if accessible)", es: "Limpiar los zócalos en todas las habitaciones (si son accesibles)" },
    { en: "Dust & clean ceiling fans", es: "Sacudir y limpiar los ventiladores de techo" },
    { en: "Wipe & sanitize doorknobs, door frames, light switches & handles", es: "Limpiar y desinfectar perillas, marcos de puertas, interruptores de luz y manijas" },
    { en: "Clean storm doors & sliding patio doors (inside & outside glass)", es: "Limpiar contrapuertas y puertas corredizas del patio (vidrio por dentro y por fuera)" },
    { en: "Dust & clean air vent covers", es: "Sacudir y limpiar las rejillas de ventilación" },
  ],
};

const PLUS_STANDARD_NOTE: Bilingual = {
  en: "Do everything in the Standard Clean first, then add the detail work below.",
  es: "Primero haga todo lo de la Limpieza Estándar, luego agregue el trabajo detallado de abajo.",
};

// Recurring upkeep — the maintenance tasks recurring clients get on top of the
// Standard Clean each visit (Sal, 2026-07-24).
const RECURRING_UPKEEP: ChecklistSection = {
  title: { en: "Recurring upkeep", es: "Mantenimiento recurrente" },
  items: [
    { en: "Dust baseboards", es: "Sacudir los zócalos" },
    { en: "Wipe down doors when dirty", es: "Limpiar las puertas cuando estén sucias" },
    { en: "Clean light switch covers in the kitchen", es: "Limpiar las tapas de los interruptores de luz en la cocina" },
    { en: "Keep trash containers clean & wiped down", es: "Mantener los botes de basura limpios y pasarles un trapo" },
    { en: "Wipe down kitchen cabinets", es: "Limpiar los gabinetes de la cocina" },
    { en: "Clean top of fridge when clear of clutter", es: "Limpiar la parte de arriba del refrigerador cuando esté despejada" },
  ],
};

// The three selectable clean types.
export const CHECKLIST_SERVICES: ChecklistService[] = [
  {
    key: "standard",
    title: { en: "Standard Clean", es: "Limpieza Estándar" },
    subtitle: {
      en: "Included every visit — covers every room with the tasks below.",
      es: "Incluido en cada visita — cubre cada habitación con las tareas de abajo.",
    },
    sections: [
      {
        title: { en: "Kitchen", es: "Cocina" },
        items: [
          { en: "Remove cobwebs", es: "Quitar telarañas" },
          { en: "Wipe & sanitize countertops, cabinets (exterior), and backsplash", es: "Limpiar y desinfectar encimeras, gabinetes (exterior) y el salpicadero (backsplash)" },
          { en: "Clean microwave (inside & out), stovetop, control panel, and drip pans", es: "Limpiar el microondas (por dentro y por fuera), la estufa, el panel de control y las charolas" },
          { en: "Wipe down refrigerator (top & sides if accessible)", es: "Limpiar el refrigerador (parte de arriba y los lados si son accesibles)" },
          { en: "Clean sinks & faucets", es: "Limpiar fregaderos y llaves" },
          { en: "Empty trash & clean trash bin (client must provide bag)", es: "Vaciar la basura y limpiar el bote (el cliente debe proveer la bolsa)" },
          { en: "Clean floors (vacuum, sweep, mop)", es: "Limpiar los pisos (aspirar, barrer, trapear)" },
        ],
      },
      {
        title: { en: "Bathrooms", es: "Baños" },
        items: [
          { en: "Remove cobwebs", es: "Quitar telarañas" },
          { en: "Clean & disinfect tub, shower, shower doors, and toilet (inside & out)", es: "Limpiar y desinfectar la tina, la regadera, las puertas de la regadera y el inodoro (por dentro y por fuera)" },
          { en: "Wipe & sanitize countertops, cabinets (exterior), sinks & faucets", es: "Limpiar y desinfectar encimeras, gabinetes (exterior), lavabos y llaves" },
          { en: "Clean mirrors and light fixtures", es: "Limpiar espejos y lámparas" },
          { en: "Dust window sills & towel bars", es: "Sacudir los marcos de ventanas y los toalleros" },
          { en: "Empty trash & replace liner", es: "Vaciar la basura y cambiar la bolsa" },
          { en: "Clean floors (vacuum, sweep, mop)", es: "Limpiar los pisos (aspirar, barrer, trapear)" },
        ],
      },
      {
        title: { en: "Bedrooms", es: "Recámaras" },
        items: [
          { en: "Remove cobwebs", es: "Quitar telarañas" },
          { en: "Dust furniture, lamps, window sills & picture frames", es: "Sacudir muebles, lámparas, marcos de ventanas y portarretratos" },
          { en: "Clean mirrors & glass surfaces", es: "Limpiar espejos y superficies de vidrio" },
          { en: "Vacuum & mop floors", es: "Aspirar y trapear los pisos" },
        ],
      },
      {
        title: { en: "Living Areas / Family Room", es: "Sala / Cuarto de Estar" },
        items: [
          { en: "Remove cobwebs", es: "Quitar telarañas" },
          { en: "Dust furniture, lamps, window sills & picture frames", es: "Sacudir muebles, lámparas, marcos de ventanas y portarretratos" },
          { en: "Vacuum/dust upholstered furniture", es: "Aspirar/sacudir los muebles tapizados" },
          { en: "Clean mirrors & glass surfaces", es: "Limpiar espejos y superficies de vidrio" },
          { en: "Empty trash & replace liner", es: "Vaciar la basura y cambiar la bolsa" },
          { en: "Clean floors (vacuum, sweep, mop)", es: "Limpiar los pisos (aspirar, barrer, trapear)" },
        ],
      },
      {
        title: { en: "Laundry Room", es: "Cuarto de Lavado" },
        items: [
          { en: "Remove cobwebs", es: "Quitar telarañas" },
          { en: "Wipe washer & dryer (exterior)", es: "Limpiar la lavadora y la secadora (exterior)" },
          { en: "Clean utility sink & countertops", es: "Limpiar el lavadero y las encimeras" },
          { en: "Dust & wipe shelves", es: "Sacudir y limpiar los estantes" },
          { en: "Sweep & mop floor", es: "Barrer y trapear el piso" },
        ],
      },
    ],
  },
  {
    key: "recurring",
    title: { en: "Recurring", es: "Recurrente" },
    subtitle: {
      en: "For recurring clients — everything in the Standard Clean, plus the upkeep below.",
      es: "Para clientes recurrentes — todo lo de la Limpieza Estándar, más el mantenimiento de abajo.",
    },
    note: PLUS_STANDARD_NOTE,
    sections: [RECURRING_UPKEEP],
  },
  {
    key: "deep",
    title: { en: "Deep Clean", es: "Limpieza Profunda" },
    subtitle: {
      en: "Everything in the Standard Clean, plus the detail work below.",
      es: "Todo lo de la Limpieza Estándar, más el trabajo detallado de abajo.",
    },
    note: PLUS_STANDARD_NOTE,
    sections: [DETAIL_WORK],
  },
  {
    key: "move_in_out",
    title: { en: "Move In / Move Out", es: "Mudanza (Entrada / Salida)" },
    subtitle: {
      en: "Everything in the Standard Clean, plus the detail work below.",
      es: "Todo lo de la Limpieza Estándar, más el trabajo detallado de abajo.",
    },
    note: PLUS_STANDARD_NOTE,
    sections: [DETAIL_WORK],
  },
];

// Priced extras — only performed when they're on the job order.
export interface AddonItem { label: Bilingual; price: Bilingual; }
export const ADDONS: { title: Bilingual; subtitle: Bilingual; note: Bilingual; items: AddonItem[] } = {
  title: { en: "Add-Ons", es: "Servicios Adicionales" },
  subtitle: {
    en: "Extra charge — do these ONLY if they're on the job order.",
    es: "Cargo adicional — hágalos SOLO si están en la orden de trabajo.",
  },
  note: {
    en: "Not on the order? Don't do it — check with the office first.",
    es: "¿No está en la orden? No lo haga — consulte con la oficina primero.",
  },
  items: [
    { label: { en: "Inside refrigerator", es: "Interior del refrigerador" }, price: { en: "$50", es: "$50" } },
    { label: { en: "Inside oven", es: "Interior del horno" }, price: { en: "$50", es: "$50" } },
    { label: { en: "Inside kitchen cabinets (must be empty)", es: "Interior de gabinetes de cocina (deben estar vacíos)" }, price: { en: "$50", es: "$50" } },
    { label: { en: "Inside windows (excludes tracks & exterior panes)", es: "Ventanas por dentro (no incluye rieles ni vidrios exteriores)" }, price: { en: "Price varies", es: "Precio variable" } },
  ],
};

// Hard boundaries — never done, on any job. Keeps the crew safe and pricing fair.
export const NOT_OFFERED: { title: Bilingual; subtitle: Bilingual; items: Bilingual[] } = {
  title: { en: "We Don't Do These", es: "Esto No Lo Hacemos" },
  subtitle: {
    en: "Outside our scope — never do these, on any job.",
    es: "Fuera de nuestro alcance — nunca haga esto, en ningún trabajo.",
  },
  items: [
    { en: "Carpet steam cleaning", es: "Limpieza de alfombras con vapor" },
    { en: "Dishes, laundry, bed-making", es: "Lavar platos, lavar ropa, tender camas" },
    { en: "Lifting/moving heavy furniture (over 25 lbs.)", es: "Levantar/mover muebles pesados (más de 25 libras)" },
    { en: "Cleaning biohazards, animal waste, hoarding, or infestations", es: "Limpiar materiales peligrosos, desechos de animales, acumulación (hoarding) o plagas" },
    { en: "Outdoor cleaning, fireplaces, errands", es: "Limpieza exterior, chimeneas, mandados" },
  ],
};
