/**
 * Signed-Document Content Registry — server-side canonical text for
 * each legally binding acknowledgment in the 2026 onboarding system.
 *
 * Why server-side:
 *   - The signature must bind to the EXACT text the employee read. We
 *     can't trust the client to send us the content. The server pulls
 *     from this registry, renders it into the signing UI, AND uses
 *     the same content to compute the version hash that goes into
 *     lms_signed_documents. Round-trip: same canonical bytes → same
 *     hash → audit-replay-safe.
 *   - The frontend fetches the content via GET /api/lms/signatures/
 *     content?documentType=X&locale=Y. The fetched text is rendered
 *     verbatim. The signature payload is then sent back; the server
 *     re-hashes the same text from this registry to assert the row
 *     references the canonical version.
 *
 * Translation-review flag:
 *   - Per Phase 16 spec: the four flagged legal documents (drug_alcohol,
 *     non_solicitation, wage_deduction_notice, commission_consent) get
 *     AI-translated initially but must be reviewed by a professional
 *     human translator before going live. We set
 *     `pendingTranslationReview: true` on the Spanish content so the
 *     UI surfaces a banner: "This Spanish translation is under review.
 *     The English version is binding until the final translation is
 *     approved." This protects Phes legally.
 *
 * Adding a new document:
 *   - Append a new key to SIGNED_DOCUMENT_CONTENT keyed by document_type
 *     (must match @workspace/db/schema KNOWN_SIGNED_DOCUMENT_TYPES).
 *   - Provide both `en` and `es`. Mark `pendingTranslationReview` on the
 *     Spanish version when the legal binding requires human review.
 *   - The version hash is auto-computed from the content body, so a
 *     content edit creates a new version row automatically the next
 *     time someone signs.
 */

import type { KnownSignedDocumentType } from "@workspace/db/schema";

export interface SignedDocumentLocaleContent {
  /**
   * The canonical content for the document in this locale.
   * IMPORTANT: this string is hashed verbatim. Reformat with care.
   * No em dashes, no en dashes per Phase 1 spec.
   */
  contentHtml: string;
  /**
   * Human-readable title shown on the signing page and the signed PDF.
   */
  title: string;
  /**
   * When true, the UI must surface a "translation under review" banner
   * and a notice that the English version is binding until human
   * translation review completes. Set on Spanish entries for the four
   * flagged legal documents.
   */
  pendingTranslationReview?: boolean;
  /**
   * Free-form change notes for the version registry. Kept short.
   */
  notes?: string;
}

export type SignedDocumentRegistry = Partial<
  Record<
    KnownSignedDocumentType,
    {
      en: SignedDocumentLocaleContent;
      es: SignedDocumentLocaleContent;
    }
  >
>;

// ─────────────────────────────────────────────────────────────────────────────
// Document content — bilingual canonical text per document_type.
// ─────────────────────────────────────────────────────────────────────────────
//
// Format conventions:
//   * One section per `## H2` line in the rendered output.
//   * Use plain prose. No em dashes. No en dashes.
//   * Use complete sentences. Use periods or colons instead of dashes.
//   * Quoted text uses straight ASCII quotes.
//   * Lists use plain `- ` prefix; the renderer handles styling.
//
// Hashes are computed over the raw string. Two whitespace-different
// strings hash to different versions. Edit with care.

const DRUG_ALCOHOL_EN: SignedDocumentLocaleContent = {
  title: "Drug and Alcohol Policy Acknowledgment",
  contentHtml: [
    "PHES CLEANING SERVICES",
    "DRUG AND ALCOHOL POLICY ACKNOWLEDGMENT",
    "Effective Date: January 1, 2026",
    "",
    "By signing this acknowledgment, I confirm that I have read and understand the Phes Drug and Alcohol Policy contained in the 2026 Phes Employee Handbook and the Drug and Alcohol training module. I acknowledge and consent to the following terms:",
    "",
    "1. NO PRE-EMPLOYMENT TESTING.",
    "Phes does not require pre-employment drug testing. I was not asked to submit to a drug test as a condition of being hired.",
    "",
    "2. IMPAIRMENT AT WORK IS PROHIBITED.",
    "I will not work while impaired by alcohol, illegal drugs, cannabis, or any other substance (including over-the-counter or prescription medications) that affects my ability to perform my duties safely. This prohibition applies regardless of when or where I consumed the substance.",
    "",
    "3. CANNABIS AND OFF-DUTY ACTIVITY.",
    "I understand that Phes does not discipline lawful off-duty cannabis use, in accordance with the Illinois Cannabis Regulation and Tax Act. I also understand that impairment AT WORK is treated separately from off-duty use, and that observable signs of impairment at work may result in discipline regardless of whether the underlying use was legal.",
    "",
    "4. REASONABLE-SUSPICION TESTING.",
    "I consent to drug and alcohol testing when Phes has reasonable suspicion based on documented observable signs of impairment. I understand that the decision to test is made by the office, that Phes pays for the test, and that Phes pays my regular wages for the time spent testing.",
    "",
    "5. POST-ACCIDENT TESTING.",
    "I consent to drug and alcohol testing after any workplace accident that results in (a) physical injury to anyone or (b) property damage of five hundred dollars or more. I understand that post-accident testing is a routine safety measure and is not a presumption of fault.",
    "",
    "6. PRESCRIPTION MEDICATION.",
    "If I take a legally prescribed medication that may affect my ability to perform my duties safely, I will inform the office before starting the medication so that reasonable accommodation can be discussed. I understand that I am not required to disclose my diagnosis or the medication name.",
    "",
    "7. REFUSAL TO TEST.",
    "I understand that refusing to submit to a properly requested test (reasonable suspicion or post-accident) is grounds for immediate termination of my employment.",
    "",
    "8. DRIVING VIOLATIONS REPORTING.",
    "If I use my personal vehicle for any Phes work, I will report any DUI conviction, driver's license suspension or revocation, or major moving violation (reckless driving, leaving the scene of an accident, driving without insurance, driving with a suspended license) to the office within seventy-two hours of the event. I understand that failure to disclose may result in immediate termination.",
    "",
    "9. DISCIPLINE SCALE.",
    "I have read the discipline scale for first-positive results, second-positive results, refusals, possession of alcohol or illegal drugs on Phes property or in Phes vehicles, and driving Phes-related routes while impaired, as set out in the Drug and Alcohol training module.",
    "",
    "10. EMPLOYEE ASSISTANCE PROGRAM (EAP).",
    "I have been informed that Phes participates in an Employee Assistance Program. EAP use is confidential, voluntary, and does not trigger discipline.",
    "",
    "11. AT-WILL EMPLOYMENT.",
    "Nothing in this acknowledgment alters my at-will employment status with Phes. Phes may terminate my employment at any time, with or without cause or notice, for any lawful reason.",
    "",
    "12. ELECTRONIC SIGNATURE CONSENT.",
    "I consent to sign this acknowledgment electronically. I understand that my electronic signature has the same legal effect as a handwritten signature, in accordance with the federal Electronic Signatures in Global and National Commerce Act (E-SIGN) and the Illinois Uniform Electronic Transactions Act (UETA).",
    "",
    "By typing or drawing my signature below and clicking the I Agree button, I affirm that I have read, understood, and accept this Drug and Alcohol Policy Acknowledgment.",
  ].join("\n"),
  notes: "Phase 3 PR #4 — initial Phes drug & alcohol acknowledgment.",
};

const DRUG_ALCOHOL_ES: SignedDocumentLocaleContent = {
  title: "Reconocimiento de la Política de Drogas y Alcohol",
  pendingTranslationReview: true,
  contentHtml: [
    "PHES CLEANING SERVICES",
    "RECONOCIMIENTO DE LA POLÍTICA DE DROGAS Y ALCOHOL",
    "Fecha Efectiva: 1 de enero de 2026",
    "",
    "Al firmar este reconocimiento, confirmo que he leído y entiendo la Política de Drogas y Alcohol de Phes contenida en el Manual del Empleado de Phes 2026 y en el módulo de capacitación de Drogas y Alcohol. Reconozco y doy mi consentimiento a los siguientes términos:",
    "",
    "1. SIN PRUEBAS ANTES DEL EMPLEO.",
    "Phes no exige una prueba de drogas antes del empleo. No se me pidió someterme a una prueba de drogas como condición para ser contratado.",
    "",
    "2. LA INTOXICACIÓN EN EL TRABAJO ESTÁ PROHIBIDA.",
    "No trabajaré bajo los efectos del alcohol, drogas ilegales, cannabis o cualquier otra sustancia (incluyendo medicamentos de venta libre o recetados) que afecte mi capacidad de desempeñar mis funciones con seguridad. Esta prohibición aplica sin importar cuándo o dónde consumí la sustancia.",
    "",
    "3. CANNABIS Y ACTIVIDAD FUERA DEL TRABAJO.",
    "Entiendo que Phes no disciplina el uso legal de cannabis fuera del trabajo, conforme a la Ley de Regulación e Impuestos del Cannabis de Illinois. También entiendo que la intoxicación EN EL TRABAJO se trata por separado del uso fuera del trabajo, y que los signos observables de intoxicación en el trabajo pueden resultar en disciplina sin importar si el uso subyacente era legal.",
    "",
    "4. PRUEBAS POR SOSPECHA RAZONABLE.",
    "Doy mi consentimiento a las pruebas de drogas y alcohol cuando Phes tenga sospecha razonable basada en signos observables documentados de intoxicación. Entiendo que la decisión de hacer la prueba la toma la oficina, que Phes paga la prueba y que Phes me paga mi salario regular por el tiempo de la prueba.",
    "",
    "5. PRUEBAS DESPUÉS DE UN ACCIDENTE.",
    "Doy mi consentimiento a las pruebas de drogas y alcohol después de cualquier accidente laboral que resulte en (a) lesión física a alguien o (b) daño a propiedad de quinientos dólares o más. Entiendo que las pruebas post-accidente son una medida rutinaria de seguridad y no una presunción de culpa.",
    "",
    "6. MEDICAMENTOS RECETADOS.",
    "Si tomo un medicamento recetado legalmente que pueda afectar mi capacidad de desempeñar mis funciones con seguridad, informaré a la oficina antes de comenzar el medicamento para que podamos discutir una acomodación razonable. Entiendo que no estoy obligado a revelar mi diagnóstico ni el nombre del medicamento.",
    "",
    "7. NEGARSE A LA PRUEBA.",
    "Entiendo que negarse a someterse a una prueba solicitada apropiadamente (sospecha razonable o post-accidente) es motivo para la terminación inmediata de mi empleo.",
    "",
    "8. REPORTE DE INFRACCIONES DE CONDUCIR.",
    "Si uso mi vehículo personal para cualquier trabajo de Phes, reportaré a la oficina dentro de setenta y dos horas del evento cualquier condena por DUI, suspensión o revocación de mi licencia de conducir, o infracción mayor (conducción imprudente, abandonar el lugar de un accidente, conducir sin seguro, conducir con licencia suspendida). Entiendo que no divulgarlo puede resultar en terminación inmediata.",
    "",
    "9. ESCALA DE DISCIPLINA.",
    "He leído la escala de disciplina para primeras pruebas positivas, segundas pruebas positivas, negativas a la prueba, posesión de alcohol o drogas ilegales en propiedad de Phes o vehículos de Phes, y conducir rutas relacionadas con Phes bajo intoxicación, según lo establecido en el módulo de capacitación de Drogas y Alcohol.",
    "",
    "10. PROGRAMA DE ASISTENCIA AL EMPLEADO (EAP).",
    "He sido informado de que Phes participa en un Programa de Asistencia al Empleado. El uso del EAP es confidencial, voluntario y no activa disciplina.",
    "",
    "11. EMPLEO A VOLUNTAD.",
    "Nada en este reconocimiento altera mi estatus de empleo a voluntad con Phes. Phes puede terminar mi empleo en cualquier momento, con o sin causa o aviso, por cualquier razón legal.",
    "",
    "12. CONSENTIMIENTO DE FIRMA ELECTRÓNICA.",
    "Doy mi consentimiento para firmar este reconocimiento electrónicamente. Entiendo que mi firma electrónica tiene el mismo efecto legal que una firma manuscrita, conforme a la Ley federal de Firmas Electrónicas en el Comercio Global y Nacional (E-SIGN) y a la Ley Uniforme de Transacciones Electrónicas de Illinois (UETA).",
    "",
    "Al escribir o dibujar mi firma a continuación y hacer clic en el botón Acepto, afirmo que he leído, entendido y aceptado este Reconocimiento de la Política de Drogas y Alcohol.",
  ].join("\n"),
  notes:
    "PENDING PROFESSIONAL TRANSLATION REVIEW. Initial AI translation. " +
    "Human translator review required before final production sign-off.",
};

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export const SIGNED_DOCUMENT_CONTENT: SignedDocumentRegistry = {
  drug_alcohol: {
    en: DRUG_ALCOHOL_EN,
    es: DRUG_ALCOHOL_ES,
  },
  // PR #5+ will add: code_of_conduct, video_photo_release, non_solicitation,
  // supply_kit, social_media. Same shape, same conventions.
};

/**
 * Resolve the canonical content for a (documentType, locale). Returns
 * null when the document type has not been registered yet. The caller
 * (signature route) treats null as 404.
 */
export function getSignedDocumentContent(
  documentType: string,
  locale: "en" | "es",
): SignedDocumentLocaleContent | null {
  const entry = SIGNED_DOCUMENT_CONTENT[documentType as KnownSignedDocumentType];
  if (!entry) return null;
  return entry[locale] ?? null;
}

/**
 * Convenience: list every document type registered with canonical content.
 * Used by tests + admin debugging endpoints to assert coverage.
 */
export function listRegisteredDocumentTypes(): string[] {
  return Object.keys(SIGNED_DOCUMENT_CONTENT);
}

/**
 * Convenience: true if the Spanish version of a registered document is
 * still pending professional translation review. Drives the UI banner
 * and the PDF watermark.
 */
export function isSpanishPendingTranslationReview(
  documentType: string,
): boolean {
  const entry = SIGNED_DOCUMENT_CONTENT[documentType as KnownSignedDocumentType];
  return entry?.es.pendingTranslationReview === true;
}
