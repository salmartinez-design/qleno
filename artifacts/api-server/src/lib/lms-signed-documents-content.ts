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
// video_photo_release (Phase 5, PR #6)
//
// CO-SIGNED release governed by the Illinois Right of Publicity Act
// (765 ILCS 1075). Improved version that replaces the broad legacy
// release with explicit limits:
//   1. 5-year post-separation cap on NEW uses (existing content in
//      active distribution may continue).
//   2. AI training / deepfake / synthetic-media carve-out (requires
//      separate written consent).
//   3. Withdrawal at any time. 30-day removal effort for Phes-controlled
//      channels. Third-party shares cannot be recalled.
//   4. Courtesy preview before publication where feasible (not a veto).
//
// NOT in the four flagged docs for human translator review. Spanish
// goes live without the pending-review banner.
// ─────────────────────────────────────────────────────────────────────────────

const VIDEO_PHOTO_RELEASE_EN: SignedDocumentLocaleContent = {
  title: "Video and Photo Release",
  contentHtml: [
    "PHES CLEANING SERVICES",
    "VIDEO AND PHOTO RELEASE",
    "Effective Date: January 1, 2026",
    "",
    "By signing this release, I authorize Phes Cleaning Services to record, store, and use photographs and video of me captured in the course of my employment, subject to the limits described below. This release is given voluntarily and is consistent with the Illinois Right of Publicity Act, 765 ILCS 1075, which requires my affirmative written consent before Phes may use my identity for any commercial purpose.",
    "",
    "1. VOLUNTARY CONSENT.",
    "I understand that signing this release is voluntary. I may decline without any change to my job duties, schedule, pay, or standing with Phes. If I decline, Phes will not photograph or record me for commercial use.",
    "",
    "2. SCOPE OF AUTHORIZED USE.",
    "I authorize Phes to use photographs and video of me captured in my work environment (homes I clean as part of my Phes shift, the Phes office, training sessions, and team events) in the following Phes-controlled materials and channels: Phes recruiting and marketing materials, Phes training and onboarding materials, the Phes website, and Phes-operated social media channels. Phes is the sole commercial user authorized by this release.",
    "",
    "3. THIRD-PARTY USE NOT AUTHORIZED.",
    "This release does not authorize any third party (other businesses, news outlets, advertising partners) to use my likeness. If a third party requests footage of me from Phes for the third party's own use, Phes must seek my separate written consent before sharing.",
    "",
    "4. AI TRAINING AND SYNTHETIC-MEDIA CARVE-OUT.",
    "Phes will not use my photographs or video for the training of any artificial-intelligence model, for deepfake creation, or for any other synthetic-media generation featuring my likeness, without my SEPARATE WRITTEN CONSENT. This release does not authorize any such use under any circumstances. Any future request for AI-training consent will be a different document with its own signature.",
    "",
    "5. POST-SEPARATION LIMIT ON NEW USES.",
    "If my employment with Phes ends (voluntary or involuntary), Phes may continue to use content featuring my likeness after my employment ends, with a 5-year limit on new uses of content featuring my likeness post-separation, except for content already in active distribution. Practical effect: existing content (training videos, recruiting graphics, social-media posts already in rotation) may continue to play, but Phes may not launch new uses of content featuring my likeness more than 5 years after my last day, with the exception of content that was in active distribution at separation.",
    "",
    "6. COURTESY PREVIEW BEFORE PUBLICATION.",
    "Phes will make reasonable effort to provide a courtesy preview of content featuring my likeness before publication when feasible. Courtesy preview is not a veto and pre-approval is not a condition of publication under this release. I may flag concerns and Phes will consider them.",
    "",
    "7. WITHDRAWAL OF CONSENT.",
    "I may withdraw my consent at any time, for any reason or no reason, by giving written notice to the office. Upon withdrawal, Phes will make reasonable efforts to remove content from active Phes-controlled distribution within 30 days. Content distributed through third parties (shared or re-posted by others, downloads, screenshots, news references) cannot be recalled. Phes will not use the withdrawn content in new campaigns or new publications after the withdrawal date. Withdrawing consent does not affect my job, schedule, pay, or standing with Phes.",
    "",
    "8. PHES REPRESENTATIVE CO-SIGNATURE.",
    "Because this release is a two-way commitment, the Phes representative co-signs it. The co-signature binds Phes to the limits set out in sections 4 through 7 above. The co-signature is added after my signature; I do not need to be present.",
    "",
    "9. NO COMPENSATION FOR USE.",
    "I understand that Phes does not pay residuals, royalties, or any additional compensation for use of content featuring my likeness under this release. The release is granted as part of my employment relationship and is not tied to any wage or bonus.",
    "",
    "10. AT-WILL EMPLOYMENT.",
    "Nothing in this release alters my at-will employment status with Phes. Phes may terminate my employment at any time, with or without cause or notice, for any lawful reason.",
    "",
    "11. ELECTRONIC SIGNATURE CONSENT.",
    "I consent to sign this release electronically. I understand that my electronic signature has the same legal effect as a handwritten signature, in accordance with the federal Electronic Signatures in Global and National Commerce Act (E-SIGN) and the Illinois Uniform Electronic Transactions Act (UETA).",
    "",
    "By typing or drawing my signature below and clicking the I Agree button, I affirm that I have read, understood, and accept this Video and Photo Release.",
  ].join("\n"),
  notes: "Phase 5 PR #6 — improved Phes video/photo release with AI carve-out + 5-year post-separation limit + 30-day withdrawal removal effort. Cites 765 ILCS 1075.",
};

const VIDEO_PHOTO_RELEASE_ES: SignedDocumentLocaleContent = {
  title: "Autorización de Video y Foto",
  contentHtml: [
    "PHES CLEANING SERVICES",
    "AUTORIZACIÓN DE VIDEO Y FOTO",
    "Fecha Efectiva: 1 de enero de 2026",
    "",
    "Al firmar esta autorización, autorizo a Phes Cleaning Services a grabar, almacenar y usar fotografías y videos míos capturados en el curso de mi empleo, sujeto a los límites descritos a continuación. Esta autorización se da voluntariamente y es consistente con la Ley del Derecho de Publicidad de Illinois, 765 ILCS 1075, que requiere mi consentimiento afirmativo por escrito antes de que Phes pueda usar mi identidad para cualquier propósito comercial.",
    "",
    "1. CONSENTIMIENTO VOLUNTARIO.",
    "Entiendo que firmar esta autorización es voluntario. Puedo rechazarlo sin ningún cambio en mis funciones, horario, pago o posición con Phes. Si rechazo, Phes no me fotografiará ni grabará para uso comercial.",
    "",
    "2. ALCANCE DEL USO AUTORIZADO.",
    "Autorizo a Phes a usar fotografías y videos míos capturados en mi entorno de trabajo (hogares que limpio como parte de mi turno de Phes, la oficina de Phes, sesiones de capacitación y eventos del equipo) en los siguientes materiales y canales controlados por Phes: materiales de reclutamiento y mercadotecnia de Phes, materiales de capacitación y orientación de Phes, la página web de Phes y los canales de redes sociales operados por Phes. Phes es el único usuario comercial autorizado por esta autorización.",
    "",
    "3. USO POR TERCEROS NO AUTORIZADO.",
    "Esta autorización no permite a ningún tercero (otros negocios, medios de noticias, socios publicitarios) usar mi semejanza. Si un tercero solicita imágenes mías a Phes para uso propio del tercero, Phes debe pedir mi consentimiento separado por escrito antes de compartirlas.",
    "",
    "4. EXCLUSIÓN DE ENTRENAMIENTO DE IA Y MEDIOS SINTÉTICOS.",
    "Phes no usará mis fotografías o videos para el entrenamiento de ningún modelo de inteligencia artificial, para la creación de deepfakes, ni para ninguna otra generación de medios sintéticos con mi semejanza, sin mi CONSENTIMIENTO SEPARADO POR ESCRITO. Esta autorización no permite ningún uso así bajo ninguna circunstancia. Cualquier solicitud futura de consentimiento para entrenamiento de IA será un documento distinto con su propia firma.",
    "",
    "5. LÍMITE DESPUÉS DE LA SEPARACIÓN PARA NUEVOS USOS.",
    "Si mi empleo con Phes termina (voluntaria o involuntariamente), Phes podrá continuar usando contenido que muestre mi semejanza después del término de mi empleo, con un límite de 5 años para nuevos usos de contenido que muestre mi semejanza después de la separación, excepto para contenido que ya estaba en distribución activa. Efecto práctico: el contenido existente (videos de capacitación, gráficos de reclutamiento, publicaciones en redes sociales ya en rotación) puede continuar reproduciéndose, pero Phes no podrá iniciar nuevos usos de contenido con mi semejanza más de 5 años después de mi último día, con la excepción del contenido que estaba en distribución activa al momento de la separación.",
    "",
    "6. VISTA PREVIA DE CORTESÍA ANTES DE LA PUBLICACIÓN.",
    "Phes hará un esfuerzo razonable por proveer una vista previa de cortesía del contenido con mi semejanza antes de la publicación cuando sea factible. La vista previa de cortesía no es un veto y la pre-aprobación no es condición de la publicación bajo esta autorización. Puedo señalar inquietudes y Phes las considerará.",
    "",
    "7. RETIRO DEL CONSENTIMIENTO.",
    "Puedo retirar mi consentimiento en cualquier momento, por cualquier razón o sin razón, dando aviso por escrito a la oficina. Al retirarlo, Phes hará esfuerzos razonables por retirar el contenido de la distribución activa controlada por Phes dentro de los 30 días. El contenido distribuido a través de terceros (compartido o republicado por otros, descargas, capturas de pantalla, referencias de noticias) no puede ser recuperado. Phes no usará el contenido retirado en nuevas campañas o nuevas publicaciones después de la fecha de retiro. Retirar el consentimiento no afecta mi trabajo, horario, pago o posición con Phes.",
    "",
    "8. CO-FIRMA DEL REPRESENTANTE DE PHES.",
    "Como esta autorización es un compromiso de dos vías, el representante de Phes la co-firma. La co-firma vincula a Phes a los límites establecidos en las secciones 4 a 7 anteriores. La co-firma se agrega después de mi firma; no necesito estar presente.",
    "",
    "9. SIN COMPENSACIÓN POR EL USO.",
    "Entiendo que Phes no paga residuales, regalías o ninguna compensación adicional por el uso de contenido con mi semejanza bajo esta autorización. La autorización se otorga como parte de mi relación laboral y no está vinculada a ningún salario o bono.",
    "",
    "10. EMPLEO A VOLUNTAD.",
    "Nada en esta autorización altera mi estatus de empleo a voluntad con Phes. Phes puede terminar mi empleo en cualquier momento, con o sin causa o aviso, por cualquier razón legal.",
    "",
    "11. CONSENTIMIENTO DE FIRMA ELECTRÓNICA.",
    "Doy mi consentimiento para firmar esta autorización electrónicamente. Entiendo que mi firma electrónica tiene el mismo efecto legal que una firma manuscrita, conforme a la Ley federal de Firmas Electrónicas en el Comercio Global y Nacional (E-SIGN) y a la Ley Uniforme de Transacciones Electrónicas de Illinois (UETA).",
    "",
    "Al escribir o dibujar mi firma a continuación y hacer clic en el botón Acepto, afirmo que he leído, entendido y aceptado esta Autorización de Video y Foto.",
  ].join("\n"),
  notes: "Phase 5 PR #6 — Phes video/photo release, Spanish version. Not in the four flagged docs.",
};

// ─────────────────────────────────────────────────────────────────────────────
// non_solicitation (Phase 6, PR #7)
//
// CO-SIGNED agreement bound by the Illinois Freedom to Work Act (820 ILCS 90).
// Phes intentionally narrows the agreement to stay well within IL reasonableness:
//   - 12-month post-separation duration
//   - CLIENTS ONLY (coworkers explicitly carved out)
//   - inbound-contact carve-out (former clients may contact YOU)
//   - general advertising carve-out
//   - no liquidated-damages or penalty clauses (IL courts disfavor)
//   - injunctive relief + documented damages + reasonable attorney fees only
//
// Spanish version is one of the FOUR FLAGGED docs requiring professional
// translator review. UI shows a banner: English version is binding until
// human translation review is approved.
// ─────────────────────────────────────────────────────────────────────────────

const NON_SOLICITATION_EN: SignedDocumentLocaleContent = {
  title: "Non-Solicitation Agreement",
  contentHtml: [
    "PHES CLEANING SERVICES",
    "NON-SOLICITATION AGREEMENT",
    "Effective Date: January 1, 2026",
    "",
    "This Non-Solicitation Agreement is entered into between Phes Cleaning Services and me as a condition of my employment. The Agreement is governed by the Illinois Freedom to Work Act, 820 ILCS 90, and is intentionally narrowed to remain reasonable in scope, duration, and protected interest.",
    "",
    "1. RESTRICTION (CLIENTS ONLY).",
    "During my employment with Phes and for TWELVE MONTHS after my last day of employment, I will not directly or indirectly solicit any Phes client for cleaning services, whether for my own account, for a future employer, or for any other business.",
    "",
    "2. DEFINITION OF PHES CLIENT.",
    "Phes Client means any household, person, or business that has received cleaning services from Phes Cleaning Services in the twenty-four months prior to my last day with Phes.",
    "",
    "3. COWORKERS ARE NOT RESTRICTED.",
    "This Agreement does not restrict me in any way from recruiting Phes coworkers to join me at a new employer or in any new venture. Phes does not impose a coworker non-solicitation covenant on hourly employees, consistent with the spirit of the Illinois Freedom to Work Act.",
    "",
    "4. WHAT COUNTS AS SOLICITATION.",
    "Solicitation under this Agreement means me reaching out to a Phes Client to offer cleaning services. Specifically: calling, texting, emailing, direct-messaging, mailing, or visiting a Phes Client to offer cleaning services; asking a current Phes coworker to pass a flyer or business card to a Phes Client; or posting a service offer in a private channel that I joined because I knew Phes Clients use it.",
    "",
    "5. GENERAL ADVERTISING AND INBOUND CONTACT ARE NOT SOLICITATION.",
    "Nothing in this Agreement restricts me from: (a) running general advertising (Craigslist, neighborhood bulletin boards, public-facing Facebook pages, the open web) that targets the public at large, even if a Phes Client happens to see it; or (b) accepting INBOUND CONTACT from a Phes Client who finds me on their own initiative without me having approached them, invited contact, or taken any step to trigger the contact. If a Phes Client contacts me first under those conditions, I may discuss and accept the work.",
    "",
    "6. NO NON-COMPETE.",
    "This Agreement does not prevent me from accepting employment with another cleaning company in the Chicagoland area or anywhere else. I am free to continue working in cleaning at any time, with any employer.",
    "",
    "7. CONSIDERATION.",
    "Phes provides the following consideration in exchange for my acceptance of this Agreement: paid training, regular scheduled shifts, paid time off accruing under the Illinois Paid Leave for All Workers Act, holiday pay, and the other benefits described in the Compensation module of the Phes Employee Handbook. Continued employment past two years also constitutes adequate consideration under Illinois law.",
    "",
    "8. REASONABLE SCOPE.",
    "I acknowledge that the twelve-month duration, the clients-only scope, the inbound-contact carve-out, and the absence of any geographic territory restriction collectively make this Agreement reasonable and necessary to protect Phes's legitimate business interest in client relationships, consistent with the Illinois Freedom to Work Act.",
    "",
    "9. REMEDIES.",
    "If Phes believes I have violated this Agreement, Phes may seek injunctive relief (a court order requiring me to stop the prohibited conduct) and may recover documented damages and reasonable attorney fees, as permitted by Illinois law. Phes does not impose liquidated damages or penalty clauses under this Agreement.",
    "",
    "10. SEVERABILITY AND BLUE-PENCIL.",
    "If any court finds any portion of this Agreement to be unenforceable as written, the parties intend that the court apply the Illinois blue-pencil doctrine to narrow the restriction to the maximum extent enforceable rather than strike it entirely.",
    "",
    "11. PHES REPRESENTATIVE CO-SIGNATURE.",
    "This Agreement is a two-way commitment. I agree to the twelve-month client non-solicit; Phes commits to the consideration described in section 7. The signed instrument is co-signed by the Phes representative. The co-signature appears on the final PDF after my signature.",
    "",
    "12. AT-WILL EMPLOYMENT.",
    "Nothing in this Agreement alters my at-will employment status with Phes. Phes may terminate my employment at any time, with or without cause or notice, for any lawful reason. My obligations under this Agreement survive termination of employment.",
    "",
    "13. ELECTRONIC SIGNATURE CONSENT.",
    "I consent to sign this Agreement electronically. I understand that my electronic signature has the same legal effect as a handwritten signature, in accordance with the federal Electronic Signatures in Global and National Commerce Act (E-SIGN) and the Illinois Uniform Electronic Transactions Act (UETA).",
    "",
    "By typing or drawing my signature below and clicking the I Agree button, I affirm that I have read, understood, and accept this Non-Solicitation Agreement.",
  ].join("\n"),
  notes: "Phase 6 PR #7 — Phes non-solicitation agreement. 12 months, clients only, IL Freedom to Work Act compliant.",
};

const NON_SOLICITATION_ES: SignedDocumentLocaleContent = {
  title: "Acuerdo de No Solicitación",
  pendingTranslationReview: true,
  contentHtml: [
    "PHES CLEANING SERVICES",
    "ACUERDO DE NO SOLICITACIÓN",
    "Fecha Efectiva: 1 de enero de 2026",
    "",
    "Este Acuerdo de No Solicitación se celebra entre Phes Cleaning Services y yo como condición de mi empleo. El Acuerdo se rige por la Ley de Libertad para Trabajar de Illinois, 820 ILCS 90, y se restringe intencionalmente para permanecer razonable en alcance, duración e interés protegido.",
    "",
    "1. RESTRICCIÓN (SOLO CLIENTES).",
    "Durante mi empleo con Phes y por DOCE MESES después de mi último día de empleo, no solicitaré directa o indirectamente a ningún cliente de Phes para servicios de limpieza, ya sea para mi propia cuenta, para un futuro empleador o para cualquier otro negocio.",
    "",
    "2. DEFINICIÓN DE CLIENTE DE PHES.",
    "Cliente de Phes significa cualquier hogar, persona o negocio que haya recibido servicios de limpieza de Phes Cleaning Services en los veinticuatro meses anteriores a mi último día con Phes.",
    "",
    "3. LOS COMPAÑEROS NO ESTÁN RESTRINGIDOS.",
    "Este Acuerdo no me restringe de ninguna manera para reclutar a compañeros de Phes para que se me unan en un nuevo empleador o en cualquier nueva empresa. Phes no impone un acuerdo de no solicitación de compañeros sobre empleados por hora, consistente con el espíritu de la Ley de Libertad para Trabajar de Illinois.",
    "",
    "4. LO QUE CUENTA COMO SOLICITACIÓN.",
    "Solicitación bajo este Acuerdo significa que yo me acerque a un Cliente de Phes para ofrecer servicios de limpieza. Específicamente: llamar, enviar mensajes de texto, correo electrónico, mensaje directo, correo postal o visitar a un Cliente de Phes para ofrecer servicios de limpieza; pedirle a un compañero actual de Phes que pase un volante o tarjeta de presentación a un Cliente de Phes; o publicar una oferta de servicio en un canal privado al que me uní porque sabía que Clientes de Phes lo usan.",
    "",
    "5. LA PUBLICIDAD GENERAL Y EL CONTACTO INICIADO POR EL CLIENTE NO SON SOLICITACIÓN.",
    "Nada en este Acuerdo me restringe de: (a) manejar publicidad general (Craigslist, tableros de anuncios del vecindario, páginas de Facebook públicas, la web abierta) dirigida al público en general, aunque un Cliente de Phes la vea por casualidad; o (b) aceptar CONTACTO INICIADO POR EL CLIENTE de un Cliente de Phes que me encuentre por iniciativa propia sin que yo lo haya buscado, invitado el contacto o realizado paso alguno para provocar el contacto. Si un Cliente de Phes me contacta primero bajo esas condiciones, puedo discutir y aceptar el trabajo.",
    "",
    "6. SIN ACUERDO DE NO COMPETENCIA.",
    "Este Acuerdo no me impide aceptar empleo en otra empresa de limpieza en el área de Chicago ni en ningún otro lugar. Soy libre de continuar trabajando en limpieza en cualquier momento, con cualquier empleador.",
    "",
    "7. CONSIDERACIÓN.",
    "Phes provee la siguiente consideración a cambio de mi aceptación de este Acuerdo: capacitación pagada, turnos programados regulares, tiempo libre pagado que se acumula bajo la Ley de Licencia Pagada para Todos los Trabajadores de Illinois, pago por feriados y los demás beneficios descritos en el módulo de Compensación del Manual del Empleado de Phes. El empleo continuo por más de dos años también constituye consideración adecuada bajo la ley de Illinois.",
    "",
    "8. ALCANCE RAZONABLE.",
    "Reconozco que la duración de doce meses, el alcance limitado a clientes, la exclusión de contacto iniciado por el cliente y la ausencia de cualquier restricción de territorio geográfico hacen, en conjunto, que este Acuerdo sea razonable y necesario para proteger el interés comercial legítimo de Phes en las relaciones con los clientes, consistente con la Ley de Libertad para Trabajar de Illinois.",
    "",
    "9. REMEDIOS.",
    "Si Phes cree que he violado este Acuerdo, Phes puede buscar alivio por orden judicial (una orden de la corte que me exija detener la conducta prohibida) y puede recuperar daños documentados y honorarios razonables de abogado, según lo permita la ley de Illinois. Phes no impone daños liquidados ni cláusulas de penalización bajo este Acuerdo.",
    "",
    "10. SEPARABILIDAD Y LÁPIZ AZUL.",
    "Si cualquier corte encuentra que alguna parte de este Acuerdo no es exigible tal como está escrita, las partes pretenden que la corte aplique la doctrina del lápiz azul de Illinois para reducir la restricción al alcance máximo exigible en lugar de eliminarla por completo.",
    "",
    "11. CO-FIRMA DEL REPRESENTANTE DE PHES.",
    "Este Acuerdo es un compromiso de dos vías. Yo acepto la no solicitación de clientes de doce meses; Phes se compromete con la consideración descrita en la sección 7. El instrumento firmado es co-firmado por el representante de Phes. La co-firma aparece en el PDF final después de mi firma.",
    "",
    "12. EMPLEO A VOLUNTAD.",
    "Nada en este Acuerdo altera mi estatus de empleo a voluntad con Phes. Phes puede terminar mi empleo en cualquier momento, con o sin causa o aviso, por cualquier razón legal. Mis obligaciones bajo este Acuerdo sobreviven a la terminación del empleo.",
    "",
    "13. CONSENTIMIENTO DE FIRMA ELECTRÓNICA.",
    "Doy mi consentimiento para firmar este Acuerdo electrónicamente. Entiendo que mi firma electrónica tiene el mismo efecto legal que una firma manuscrita, conforme a la Ley federal de Firmas Electrónicas en el Comercio Global y Nacional (E-SIGN) y a la Ley Uniforme de Transacciones Electrónicas de Illinois (UETA).",
    "",
    "Al escribir o dibujar mi firma a continuación y hacer clic en el botón Acepto, afirmo que he leído, entendido y aceptado este Acuerdo de No Solicitación.",
  ].join("\n"),
  notes:
    "PENDING PROFESSIONAL TRANSLATION REVIEW. Initial AI translation. " +
    "Human translator review required before final production sign-off.",
};

// ─────────────────────────────────────────────────────────────────────────────
// social_media (Phase 7, PR #8)
//
// One-sided employee acknowledgment (NOT co-signed). Designed to be
// enforceable under federal labor law: NLRA Section 7 (29 U.S.C. 157)
// protects the right of employees to discuss wages, working conditions,
// and organizing concerns with coworkers and in public. The Phes policy
// carves Section 7 activity OUT explicitly so the rest of the policy
// stays enforceable. Also preserves the IL Right to Privacy in the
// Workplace Act (820 ILCS 55) protection for off-duty private social
// media activity.
//
// NOT in the four flagged docs for human translator review.
// ─────────────────────────────────────────────────────────────────────────────

const SOCIAL_MEDIA_EN: SignedDocumentLocaleContent = {
  title: "Social Media Policy Acknowledgment",
  contentHtml: [
    "PHES CLEANING SERVICES",
    "SOCIAL MEDIA POLICY ACKNOWLEDGMENT",
    "Effective Date: January 1, 2026",
    "",
    "By signing this acknowledgment, I confirm that I have read and understand the Phes Social Media Policy contained in the 2026 Phes Employee Handbook and the Social Media training module. I commit to the following terms as a condition of my employment with Phes Cleaning Services:",
    "",
    "1. CLIENT CONFIDENTIALITY.",
    "I will not post photographs or video of any Phes client home, taken during or based on a Phes shift, on any social-media platform, regardless of whether the client is in the image or whether the location appears identifiable. I will not post client names, addresses, neighborhoods, gate codes, alarm codes, or any other identifying detail. I will not post transcripts or paraphrased versions of conversations I overheard inside a client home. I will not post disparaging comments about a specific client where the client could reasonably figure out I meant them.",
    "",
    "2. PHES UNIFORM RESTRICTIONS.",
    "When I appear in a Phes uniform (shirt, branded apron, or other Phes-branded item) in a public-facing photo or video, I am visibly representing Phes. I will not post such content showing me posing with alcohol, cannabis, or illegal drugs; posing with firearms or other weapons; posing while observably impaired; endorsing a product, service, candidate, or organization in a way that implies Phes is endorsing it; or disparaging Phes coworkers, supervisors, or clients. Out of uniform on my own time, this restriction does not apply.",
    "",
    "3. CLIENT SOLICITATION VIA SOCIAL MEDIA.",
    "I will not use social media to solicit Phes clients for cleaning services. The same carve-outs as the Non-Solicitation Agreement apply: general advertising to the public at large is permitted, even if a Phes client happens to see it; inbound contact from a Phes client who finds me without me having approached them is permitted; direct messages or targeted comments to a specific Phes client are not permitted.",
    "",
    "4. NLRA SECTION 7 PROTECTION (CRITICAL CARVE-OUT).",
    "Nothing in this policy restricts my federally protected right under Section 7 of the National Labor Relations Act (29 U.S.C. 157) to discuss my pay, hours, schedule, working conditions, safety concerns, or organizing activity with coworkers or in public. I understand that Phes will not discipline an employee for protected concerted activity. The restrictions in sections 1 through 3 above do NOT apply to Section 7 activity.",
    "",
    "5. ILLINOIS OFF-DUTY PRIVACY (820 ILCS 55).",
    "I understand that under the Illinois Right to Privacy in the Workplace Act (820 ILCS 55), Phes will not demand access to my personal social-media accounts, will not require me to friend the office, and will not monitor my personal accounts. Phes will only act on social-media content that has been brought to its attention by another person.",
    "",
    "6. IMPERSONATION OF PHES.",
    "I will not create a social-media account that appears to speak for Phes, use Phes branding without authorization, or pretend to be an official Phes representative online. A tasteful mention that I work at Phes on my personal account is fine.",
    "",
    "7. REPORTING HARASSMENT SEEN ONLINE.",
    "If I see harassment or threats from a coworker on a public-facing social-media post, I may report it through the Code of Conduct reporting channels (office team, owner, Illinois Department of Human Rights, or EEOC). Good-faith reporting about online harassment is protected by the same anti-retaliation rules as in-person reporting.",
    "",
    "8. WHEN IN DOUBT, ASK FIRST.",
    "If I am unsure whether a specific post would violate this policy, I will ask the office BEFORE posting, not after.",
    "",
    "9. AT-WILL EMPLOYMENT.",
    "Nothing in this acknowledgment alters my at-will employment status with Phes. Phes may terminate my employment at any time, with or without cause or notice, for any lawful reason.",
    "",
    "10. ELECTRONIC SIGNATURE CONSENT.",
    "I consent to sign this acknowledgment electronically. I understand that my electronic signature has the same legal effect as a handwritten signature, in accordance with the federal Electronic Signatures in Global and National Commerce Act (E-SIGN) and the Illinois Uniform Electronic Transactions Act (UETA).",
    "",
    "By typing or drawing my signature below and clicking the I Agree button, I affirm that I have read, understood, and accept this Social Media Policy Acknowledgment.",
  ].join("\n"),
  notes: "Phase 7 PR #8 — Phes social media policy with NLRA Section 7 + IL 820 ILCS 55 carve-outs.",
};

const SOCIAL_MEDIA_ES: SignedDocumentLocaleContent = {
  title: "Reconocimiento de la Política de Redes Sociales",
  contentHtml: [
    "PHES CLEANING SERVICES",
    "RECONOCIMIENTO DE LA POLÍTICA DE REDES SOCIALES",
    "Fecha Efectiva: 1 de enero de 2026",
    "",
    "Al firmar este reconocimiento, confirmo que he leído y entiendo la Política de Redes Sociales de Phes contenida en el Manual del Empleado de Phes 2026 y en el módulo de capacitación de Redes Sociales. Me comprometo a los siguientes términos como condición de mi empleo con Phes Cleaning Services:",
    "",
    "1. CONFIDENCIALIDAD DEL CLIENTE.",
    "No publicaré fotografías ni videos de ningún hogar de cliente de Phes, tomados durante o basados en un turno de Phes, en ninguna plataforma de redes sociales, sin importar si el cliente está en la imagen o si la ubicación parece identificable. No publicaré nombres, direcciones, vecindarios, códigos de portón, códigos de alarma ni cualquier otro detalle identificador del cliente. No publicaré transcripciones ni versiones parafraseadas de conversaciones que escuché dentro del hogar de un cliente. No publicaré comentarios despectivos sobre un cliente específico donde el cliente razonablemente pudiera darse cuenta de que me refería a él.",
    "",
    "2. RESTRICCIONES DEL UNIFORME DE PHES.",
    "Cuando aparezca en uniforme de Phes (camisa, delantal con marca u otro artículo con marca de Phes) en una foto o video público, estoy representando visiblemente a Phes. No publicaré contenido así mostrándome posando con alcohol, cannabis o drogas ilegales; posando con armas de fuego u otras armas; posando mientras estoy observablemente intoxicado; apoyando un producto, servicio, candidato u organización de manera que implique que Phes lo apoya; o desprestigiando a compañeros de Phes, supervisores o clientes. Fuera de uniforme en mi propio tiempo, esta restricción no aplica.",
    "",
    "3. SOLICITACIÓN DE CLIENTES A TRAVÉS DE REDES SOCIALES.",
    "No usaré redes sociales para solicitar a clientes de Phes para servicios de limpieza. Aplican las mismas exclusiones que el Acuerdo de No Solicitación: la publicidad general al público en general está permitida, aunque un cliente de Phes la vea por casualidad; el contacto iniciado por un cliente de Phes que me encuentre sin que yo lo haya buscado está permitido; los mensajes directos o comentarios dirigidos a un cliente específico de Phes no están permitidos.",
    "",
    "4. PROTECCIÓN DE LA SECCIÓN 7 DE LA NLRA (EXCLUSIÓN CRÍTICA).",
    "Nada en esta política restringe mi derecho federalmente protegido bajo la Sección 7 de la Ley Nacional de Relaciones Laborales (29 U.S.C. 157) para discutir mi pago, horas, horario, condiciones laborales, preocupaciones de seguridad o actividad de organización con compañeros o en público. Entiendo que Phes no disciplinará a un empleado por actividad concertada protegida. Las restricciones en las secciones 1 a 3 anteriores NO aplican a la actividad de la Sección 7.",
    "",
    "5. PRIVACIDAD FUERA DE SERVICIO EN ILLINOIS (820 ILCS 55).",
    "Entiendo que bajo la Ley del Derecho a la Privacidad en el Lugar de Trabajo de Illinois (820 ILCS 55), Phes no exigirá acceso a mis cuentas personales de redes sociales, no me exigirá agregar a la oficina como amigo y no monitoreará mis cuentas personales. Phes solo actuará sobre contenido de redes sociales que haya sido llevado a su atención por otra persona.",
    "",
    "6. SUPLANTACIÓN DE PHES.",
    "No crearé una cuenta de redes sociales que parezca hablar en nombre de Phes, usar la marca de Phes sin autorización ni hacerme pasar por un representante oficial de Phes en línea. Una mención discreta de que trabajo en Phes en mi cuenta personal está bien.",
    "",
    "7. REPORTAR ACOSO VISTO EN LÍNEA.",
    "Si veo acoso o amenazas de un compañero en una publicación pública de redes sociales, puedo reportarlo a través de las vías de reporte del Código de Conducta (equipo de la oficina, dueño, Departamento de Derechos Humanos de Illinois o EEOC). El reporte de buena fe sobre acoso en línea está protegido por las mismas reglas de anti-represalias que el reporte presencial.",
    "",
    "8. EN CASO DE DUDA, PREGUNTE PRIMERO.",
    "Si no estoy seguro de si una publicación específica violaría esta política, preguntaré a la oficina ANTES de publicar, no después.",
    "",
    "9. EMPLEO A VOLUNTAD.",
    "Nada en este reconocimiento altera mi estatus de empleo a voluntad con Phes. Phes puede terminar mi empleo en cualquier momento, con o sin causa o aviso, por cualquier razón legal.",
    "",
    "10. CONSENTIMIENTO DE FIRMA ELECTRÓNICA.",
    "Doy mi consentimiento para firmar este reconocimiento electrónicamente. Entiendo que mi firma electrónica tiene el mismo efecto legal que una firma manuscrita, conforme a la Ley federal de Firmas Electrónicas en el Comercio Global y Nacional (E-SIGN) y a la Ley Uniforme de Transacciones Electrónicas de Illinois (UETA).",
    "",
    "Al escribir o dibujar mi firma a continuación y hacer clic en el botón Acepto, afirmo que he leído, entendido y aceptado este Reconocimiento de la Política de Redes Sociales.",
  ].join("\n"),
  notes: "Phase 7 PR #8 — Phes social media policy, Spanish version. Not in the four flagged docs.",
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
  video_photo_release: {
    en: VIDEO_PHOTO_RELEASE_EN,
    es: VIDEO_PHOTO_RELEASE_ES,
  },
  non_solicitation: {
    en: NON_SOLICITATION_EN,
    es: NON_SOLICITATION_ES,
  },
  social_media: {
    en: SOCIAL_MEDIA_EN,
    es: SOCIAL_MEDIA_ES,
  },
  // PR #10 will add: supply_kit. Same shape, same conventions.
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
