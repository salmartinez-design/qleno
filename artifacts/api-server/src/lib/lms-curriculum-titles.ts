/**
 * Module display title resolver — server side.
 *
 * The full module catalog with rich content blocks lives in the
 * frontend curriculum (`artifacts/qleno/src/lib/training/curriculum.ts`).
 * The server does not need that data to score quizzes (it uses the
 * answer key + question id set from `@workspace/lms-curriculum`), but
 * it DOES need the localized human title when rendering completion
 * certificates server-side via pdf-lib.
 *
 * Rather than pull the whole curriculum bundle into the API server,
 * we keep a small static map here. Locale-aware. Falls back to a
 * humanized version of the module_id when the title is not registered.
 *
 * Keep in sync with the frontend curriculum's `title` field per
 * module. When a new module is added, add an entry here too.
 */

import { FINAL_MODULE_ID } from "@workspace/lms-curriculum";

interface BilingualTitle {
  en: string;
  es: string;
}

const MODULE_TITLES: Record<string, BilingualTitle> = {
  "phes-policies": {
    en: "Phes Policies & Procedures",
    es: "Políticas y Procedimientos de Phes",
  },
  compensation: {
    en: "Compensation",
    es: "Compensación",
  },
  "cleaning-best-practices": {
    en: "Cleaning Best Practices",
    es: "Mejores Prácticas de Limpieza",
  },
  maidcentral: {
    en: "MaidCentral",
    es: "MaidCentral",
  },
  "products-tools": {
    en: "Products & Tools",
    es: "Productos y Herramientas",
  },
  "il-sexual-harassment": {
    en: "Sexual Harassment Prevention (Illinois)",
    es: "Prevención del Acoso Sexual (Illinois)",
  },
  "drug-alcohol": {
    en: "Drug & Alcohol Policy",
    es: "Política de Drogas y Alcohol",
  },
  "code-of-conduct": {
    en: "Code of Conduct",
    es: "Código de Conducta",
  },
  "video-photo-release": {
    en: "Video & Photo Release",
    es: "Autorización de Video y Foto",
  },
  "non-solicitation": {
    en: "Non-Solicitation Agreement",
    es: "Acuerdo de No Solicitación",
  },
  "social-media": {
    en: "Social Media Policy",
    es: "Política de Redes Sociales",
  },
  acknowledgment: {
    en: "Onboarding Acknowledgment",
    es: "Confirmación de Incorporación",
  },
  [FINAL_MODULE_ID]: {
    en: "Final Mixed Test",
    es: "Examen Final Mixto",
  },
};

/**
 * Resolve a module's localized title for display on a certificate.
 * Falls back to a sentence-cased version of the module_id when the
 * id is not in the static map (defensive against curriculum drift).
 */
export function getCurriculumModuleTitle(
  moduleId: string,
  locale: "en" | "es",
): string {
  const entry = MODULE_TITLES[moduleId];
  if (entry) return entry[locale];
  // Fallback: "phes-policies" → "Phes Policies"
  return moduleId
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");
}
