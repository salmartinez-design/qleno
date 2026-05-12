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
// code_of_conduct (Phase 4, PR #5)
//
// NOT in the four flagged legal documents for human translator review
// (those are drug_alcohol, non_solicitation, wage_deduction_notice,
// commission_consent). The Spanish translation here is straightforward
// behavioral policy and goes live without the pending-review banner.
// ─────────────────────────────────────────────────────────────────────────────

const CODE_OF_CONDUCT_EN: SignedDocumentLocaleContent = {
  title: "Code of Conduct Acknowledgment",
  contentHtml: [
    "PHES CLEANING SERVICES",
    "CODE OF CONDUCT ACKNOWLEDGMENT",
    "Effective Date: January 1, 2026",
    "",
    "By signing this acknowledgment, I confirm that I have read and understand the Phes Code of Conduct contained in the 2026 Phes Employee Handbook and the Code of Conduct training module. I commit to the following terms as a condition of my employment with Phes Cleaning Services:",
    "",
    "1. HONESTY AND INTEGRITY.",
    "I will be truthful in my time records, my Worksheet entries, and my communications with the office, coworkers, and clients. I will clock in only when I arrive at a job and clock out only when I leave. I will report damage I cause or witness before I leave the job site. I will not pre-clock, back-clock, or pad hours.",
    "",
    "2. CONFIDENTIALITY OF CLIENT HOMES.",
    "What I see and hear inside a client's home stays inside that home. I will not photograph or video a client's property except to document a Phes-authorized issue uploaded directly to MaidCentral. I will not share details about a client's home, possessions, or family with anyone outside Phes, including on social media. I will not access closed rooms, locked closets, or drawers not listed on the Worksheet, and I will not look through mail, documents, or personal items.",
    "",
    "3. ZERO TOLERANCE FOR THEFT.",
    "I will not take any item from a client's home that I did not bring with me. I understand that Phes has a zero-tolerance theft policy and that taking any item, regardless of value, results in immediate termination, forfeiture of any final paycheck balance not yet earned for hours actually worked, and a report to local law enforcement. I will only accept food, water, or small items that a client has expressly offered, and I will note such offers on the Worksheet.",
    "",
    "4. RESPECT AND ANTI-HARASSMENT.",
    "I will treat every Phes employee, every client, and every person I encounter on a Phes shift with respect. I will not engage in harassment of any kind, including verbal abuse, physical aggression, intimidation, slurs, mocking, or unwelcome physical contact. I understand the detailed sexual-harassment policy is set out in the Illinois Sexual Harassment Prevention module and applies in full.",
    "",
    "5. ANTI-DISCRIMINATION.",
    "I will not discriminate against any Phes employee, applicant, or person I serve based on a protected class under the Illinois Human Rights Act, including race, color, national origin, ancestry, religion, citizenship status, sex (including pregnancy, childbirth, and related conditions), sexual orientation, gender identity, age (40 and over), marital status, parental status, military status, order-of-protection status, physical or mental disability, arrest record, conviction record (in most circumstances), or any other category protected by state or federal law.",
    "",
    "6. ANTI-RETALIATION AND GOOD-FAITH REPORTING.",
    "I understand that Phes prohibits retaliation against any employee who reports a Code of Conduct violation, a safety concern, harassment, discrimination, or any other unlawful or unethical conduct in good faith. Good faith means I genuinely believed my report was true at the time I made it. Protection applies regardless of whether the investigation ultimately substantiates the report.",
    "",
    "7. CONFLICT OF INTEREST.",
    "I will not solicit Phes clients for personal cleaning work, side work, or any other paid service either during my employment or while a non-solicitation agreement is in effect. If a client asks for additional cleaning, I will refer them to the office. I will not give clients my personal phone number or accept cash from a client for work outside the Phes channel.",
    "",
    "8. KEYS, ALARM CODES, AND PROPERTY.",
    "I will treat client keys and lockbox codes as Phes property. I will not copy a key, share a code, or take a key home without authorization. I will return keys and codes at the end of every shift, or follow the office's logged procedure for repeat-visit clients. I will report a lost or misplaced key to the office immediately. I will not lend the Phes vehicle, my assigned tools, or Phes supplies to anyone outside Phes.",
    "",
    "9. REPORTING CHANNELS.",
    "I understand that I may report a concern to the office team, to the owner directly, to the Illinois Department of Human Rights (IDHR), or to the federal EEOC. I am not required to report internally before going to a public agency.",
    "",
    "10. COOPERATION IN INVESTIGATIONS.",
    "If Phes opens an internal investigation, I will cooperate truthfully when asked, provide any relevant photos or documentation, and refrain from discussing the open investigation with other involved parties. I understand that refusing to cooperate or providing false information during an investigation is itself a Code of Conduct violation.",
    "",
    "11. AT-WILL EMPLOYMENT.",
    "Nothing in this acknowledgment alters my at-will employment status with Phes. Phes may terminate my employment at any time, with or without cause or notice, for any lawful reason.",
    "",
    "12. ELECTRONIC SIGNATURE CONSENT.",
    "I consent to sign this acknowledgment electronically. I understand that my electronic signature has the same legal effect as a handwritten signature, in accordance with the federal Electronic Signatures in Global and National Commerce Act (E-SIGN) and the Illinois Uniform Electronic Transactions Act (UETA).",
    "",
    "By typing or drawing my signature below and clicking the I Agree button, I affirm that I have read, understood, and accept this Code of Conduct Acknowledgment.",
  ].join("\n"),
  notes: "Phase 4 PR #5 — initial Phes Code of Conduct acknowledgment.",
};

const CODE_OF_CONDUCT_ES: SignedDocumentLocaleContent = {
  title: "Reconocimiento del Código de Conducta",
  contentHtml: [
    "PHES CLEANING SERVICES",
    "RECONOCIMIENTO DEL CÓDIGO DE CONDUCTA",
    "Fecha Efectiva: 1 de enero de 2026",
    "",
    "Al firmar este reconocimiento, confirmo que he leído y entiendo el Código de Conducta de Phes contenido en el Manual del Empleado de Phes 2026 y en el módulo de capacitación del Código de Conducta. Me comprometo a los siguientes términos como condición de mi empleo con Phes Cleaning Services:",
    "",
    "1. HONESTIDAD E INTEGRIDAD.",
    "Seré veraz en mis registros de tiempo, en las anotaciones de mi Hoja de Trabajo y en mis comunicaciones con la oficina, compañeros y clientes. Marcaré entrada solo cuando llegue al trabajo y salida solo cuando salga. Reportaré cualquier daño que cause o presencie antes de salir del lugar. No marcaré antes, no marcaré después ni inflaré horas.",
    "",
    "2. CONFIDENCIALIDAD DE LOS HOGARES DE CLIENTES.",
    "Lo que vea y escuche dentro del hogar de un cliente se queda dentro de ese hogar. No fotografiaré ni grabaré la propiedad de un cliente excepto para documentar un asunto autorizado por Phes cargado directamente a MaidCentral. No compartiré detalles sobre el hogar, posesiones o familia de un cliente con nadie fuera de Phes, incluyendo redes sociales. No accederé a habitaciones cerradas, armarios cerrados o cajones no listados en la Hoja de Trabajo, y no revisaré correspondencia, documentos u objetos personales.",
    "",
    "3. CERO TOLERANCIA AL ROBO.",
    "No tomaré ningún objeto del hogar de un cliente que no haya traído conmigo. Entiendo que Phes tiene una política de cero tolerancia al robo y que tomar cualquier objeto, sin importar su valor, resulta en terminación inmediata, la pérdida de cualquier saldo final del pago no devengado por horas efectivamente trabajadas, y un reporte a las autoridades locales. Solo aceptaré comida, agua u objetos pequeños que el cliente haya ofrecido expresamente, y anotaré esos ofrecimientos en la Hoja de Trabajo.",
    "",
    "4. RESPETO Y ANTI-ACOSO.",
    "Trataré con respeto a todo empleado de Phes, todo cliente y toda persona con quien me encuentre en un turno de Phes. No participaré en acoso de ninguna forma, incluyendo abuso verbal, agresión física, intimidación, insultos, burlas o contacto físico no deseado. Entiendo que la política detallada de acoso sexual está en el módulo de Prevención del Acoso Sexual de Illinois y aplica en su totalidad.",
    "",
    "5. ANTI-DISCRIMINACIÓN.",
    "No discriminaré contra ningún empleado, solicitante o persona a quien sirva basado en una clase protegida bajo la Ley de Derechos Humanos de Illinois, incluyendo raza, color, origen nacional, ascendencia, religión, estatus de ciudadanía, sexo (incluyendo embarazo, parto y condiciones relacionadas), orientación sexual, identidad de género, edad (40 años o más), estado civil, estado parental, estatus militar, estatus de orden de protección, discapacidad física o mental, antecedentes de arresto, antecedentes de condena (en la mayoría de las circunstancias) o cualquier otra categoría protegida por la ley estatal o federal.",
    "",
    "6. ANTI-REPRESALIAS Y REPORTE DE BUENA FE.",
    "Entiendo que Phes prohíbe las represalias contra cualquier empleado que reporte una violación del Código de Conducta, una preocupación de seguridad, acoso, discriminación o cualquier otra conducta ilegal o no ética de buena fe. Buena fe significa que realmente creí que mi reporte era verdadero al momento de hacerlo. La protección aplica sin importar si la investigación finalmente confirma el reporte.",
    "",
    "7. CONFLICTO DE INTERÉS.",
    "No solicitaré a clientes de Phes para trabajo de limpieza personal, trabajo paralelo o cualquier otro servicio pagado, ya sea durante mi empleo o mientras un acuerdo de no solicitación esté vigente. Si un cliente pide limpieza adicional, lo referiré a la oficina. No daré a los clientes mi número personal ni aceptaré efectivo de un cliente por trabajo fuera del canal de Phes.",
    "",
    "8. LLAVES, CÓDIGOS DE ALARMA Y PROPIEDAD.",
    "Trataré las llaves de clientes y códigos de cajas con llave como propiedad de Phes. No copiaré una llave, no compartiré un código ni me llevaré una llave a casa sin autorización. Devolveré las llaves y códigos al final de cada turno, o seguiré el procedimiento registrado de la oficina para clientes de visita recurrente. Reportaré inmediatamente a la oficina cualquier llave perdida o extraviada. No prestaré el vehículo de Phes, mis herramientas asignadas ni los suministros de Phes a nadie fuera de Phes.",
    "",
    "9. VÍAS DE REPORTE.",
    "Entiendo que puedo reportar una preocupación al equipo de la oficina, al dueño directamente, al Departamento de Derechos Humanos de Illinois (IDHR) o a la EEOC federal. No estoy obligado a reportar internamente antes de ir a una agencia pública.",
    "",
    "10. COOPERACIÓN EN INVESTIGACIONES.",
    "Si Phes abre una investigación interna, cooperaré veridicamente cuando se me pida, proveeré cualquier foto o documentación relevante y me abstendré de discutir la investigación abierta con otras partes involucradas. Entiendo que negarme a cooperar o proveer información falsa durante una investigación es en sí una violación del Código de Conducta.",
    "",
    "11. EMPLEO A VOLUNTAD.",
    "Nada en este reconocimiento altera mi estatus de empleo a voluntad con Phes. Phes puede terminar mi empleo en cualquier momento, con o sin causa o aviso, por cualquier razón legal.",
    "",
    "12. CONSENTIMIENTO DE FIRMA ELECTRÓNICA.",
    "Doy mi consentimiento para firmar este reconocimiento electrónicamente. Entiendo que mi firma electrónica tiene el mismo efecto legal que una firma manuscrita, conforme a la Ley federal de Firmas Electrónicas en el Comercio Global y Nacional (E-SIGN) y a la Ley Uniforme de Transacciones Electrónicas de Illinois (UETA).",
    "",
    "Al escribir o dibujar mi firma a continuación y hacer clic en el botón Acepto, afirmo que he leído, entendido y aceptado este Reconocimiento del Código de Conducta.",
  ].join("\n"),
  notes: "Phase 4 PR #5 — Phes Code of Conduct acknowledgment, Spanish version.",
};

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export const SIGNED_DOCUMENT_CONTENT: SignedDocumentRegistry = {
  drug_alcohol: {
    en: DRUG_ALCOHOL_EN,
    es: DRUG_ALCOHOL_ES,
  },
  code_of_conduct: {
    en: CODE_OF_CONDUCT_EN,
    es: CODE_OF_CONDUCT_ES,
  },
  // PR #6+ will add: video_photo_release, non_solicitation, supply_kit,
  // social_media. Same shape, same conventions.
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
