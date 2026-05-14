/**
 * Comprehensive Handbook PDF generator (Phase 11, PR #13).
 *
 * Produces the final signed handbook bundle. Unlike per-document signed
 * PDFs (drug_alcohol, code_of_conduct, etc., each handled by
 * generateSignedDocumentPdf), this one combines:
 *
 *   1. Cover page: tenant logo placeholder, employee legal name,
 *      version date, version hash.
 *   2. Handbook contents summary: key policies + compliance items the
 *      employee read in the LMS, referenced by section. The full module
 *      content lives in artifacts/qleno/src/lib/training/curriculum.ts
 *      as React blocks; rendering all of it to PDF would balloon to
 *      hundreds of pages, so we summarize and reference.
 *   3. Included acknowledgments: list of every standalone signed
 *      document attached to this employee (drug_alcohol, code_of_conduct,
 *      video_photo_release, non_solicitation, social_media, supply_kit)
 *      with their respective signed_at timestamps.
 *   4. Final Acknowledgment page: the canonical text the employee
 *      agrees to (at-will, commission consent, wage deduction notice,
 *      annual re-ack) with the signature block.
 *   5. Audit footer: timestamp, IP, device info, version hash.
 *
 * Preview mode (used by /handbook/preview for owner / admin) renders
 * the same pages with a PREVIEW watermark and an empty signature block.
 *
 * Uses pdf-lib (same dependency as the other PDF generators in this
 * directory). Helvetica because pdf-lib can't embed Plus Jakarta Sans
 * without a font file shipped in the repo, and the brand-matched
 * certificate output already accepts this trade-off.
 */
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

// Color palette mirrors pdf-gen.ts. Kept inline to avoid coupling the
// modules; if either drifts, the audit notes capture the cert visuals.
const COLORS = {
  navy: rgb(0.04, 0.14, 0.26),
  teal: rgb(0.0, 0.59, 0.7),
  ink: rgb(0.06, 0.09, 0.15),
  inkMute: rgb(0.28, 0.34, 0.41),
  inkLight: rgb(0.58, 0.64, 0.72),
  line: rgb(0.89, 0.91, 0.94),
  surface: rgb(1, 1, 1),
  success: rgb(0.06, 0.46, 0.43),
  mint: rgb(0.0, 0.79, 0.63),
  watermark: rgb(0.9, 0.9, 0.94),
} as const;

const PAGE_WIDTH = 612; // US Letter portrait
const PAGE_HEIGHT = 792;
const MARGIN = 54;

export interface SignedAckSummary {
  /** Document type slug, e.g. "drug_alcohol". */
  documentType: string;
  /** Localized display title. */
  title: string;
  /** When signed. */
  signedAt: Date;
  /** SHA-256 of the locale-prefixed content the employee signed. */
  versionHash: string;
}

export interface ComprehensiveHandbookInput {
  /** Tenant brand name, e.g. "Phes". */
  tenantName: string;
  /** Employee legal name. */
  employeeName: string;
  /** Locale ("en" | "es"). */
  locale: string;
  /** Whether Spanish content was flagged as pending professional review. */
  pendingTranslationReview?: boolean;
  /**
   * The canonical content the employee agreed to (the same text that
   * was hashed). Whatever's in lms_signed_documents_content.HANDBOOK_*
   * for the current locale.
   */
  contentBody: string;
  /**
   * Employee signature on the FINAL acknowledgment. Data URL when drawn,
   * legal name string when typed. Null in preview mode.
   */
  employeeSignature: string | null;
  /** "drawn" | "typed". Null in preview mode. */
  employeeSignatureMethod: "drawn" | "typed" | null;
  /** Audit timestamp. Null in preview mode. */
  signedAt: Date | null;
  /** Audit fields. Null in preview mode. */
  ipAddress: string | null;
  deviceInfo: string | null;
  /** SHA-256 of the locale-prefixed handbook ack content. */
  versionHash: string;
  /**
   * List of standalone signed acknowledgments to enumerate on the
   * "Included Acknowledgments" page. Comes from
   * lms_signed_documents WHERE document_type IN (REQUIRED_PRE_FINAL_*).
   */
  includedAcks: SignedAckSummary[];
  /**
   * Curriculum module ids that the employee has passed. Drives the
   * "Handbook Contents Summary" page so we can list the actual modules
   * the employee completed.
   */
  completedModuleIds: string[];
  /**
   * Module titles in the current locale, keyed by module id. Used to
   * print human-readable names on the contents summary page.
   */
  moduleTitles: Record<string, string>;
  /** Optional preview banner. When true, watermark + empty sig block. */
  preview?: boolean;
}

export async function generateComprehensiveHandbookPdf(
  input: ComprehensiveHandbookInput,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // ── Page 1: Cover ──────────────────────────────────────────────────────
  const coverPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawCover(coverPage, fontRegular, fontBold, input);

  // ── Page 2: Handbook Contents Summary ──────────────────────────────────
  const summaryPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawHandbookSummary(summaryPage, fontRegular, fontBold, input);

  // ── Page 3+: Included Acknowledgments table ────────────────────────────
  const acksPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawIncludedAcks(acksPage, fontRegular, fontBold, input);

  // ── Final Acknowledgment + Signature ───────────────────────────────────
  // The final ack content can wrap to multiple pages. Renders the canonical
  // contentBody text, then the signature block on the last page.
  await drawFinalAcknowledgment(doc, fontRegular, fontBold, input);

  // ── Watermark + audit footer on every page ─────────────────────────────
  const pages = doc.getPages();
  pages.forEach((p, idx) => {
    drawAuditFooter(p, fontRegular, input, idx + 1, pages.length);
    if (input.preview) drawPreviewWatermark(p, fontBold);
  });

  return doc.save();
}

// ─────────────────────────────────────────────────────────────────────────────
// Page drawers
// ─────────────────────────────────────────────────────────────────────────────

function drawCover(
  page: PDFPage,
  fontRegular: PDFFont,
  fontBold: PDFFont,
  input: ComprehensiveHandbookInput,
): void {
  // Mint accent bar at top, matching the existing certificate visuals.
  page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - 6,
    width: PAGE_WIDTH,
    height: 6,
    color: COLORS.mint,
  });

  // Tenant brand name top-left.
  page.drawText(input.tenantName.toUpperCase(), {
    x: MARGIN,
    y: PAGE_HEIGHT - 50,
    size: 12,
    font: fontBold,
    color: COLORS.navy,
  });

  const isEn = input.locale === "en";
  const title = isEn
    ? "Employee Handbook"
    : "Manual del Empleado";
  const subtitle = isEn
    ? "Comprehensive Signed Acknowledgment"
    : "Reconocimiento Integral Firmado";

  // Big centered title.
  drawCenteredText(page, title, fontBold, 36, PAGE_HEIGHT - 220, COLORS.navy);
  drawCenteredText(page, subtitle, fontRegular, 16, PAGE_HEIGHT - 250, COLORS.inkMute);

  // Employee identity block.
  const labelEmployee = isEn ? "EMPLOYEE" : "EMPLEADO";
  const labelVersionDate = isEn ? "VERSION DATE" : "FECHA DE VERSIÓN";
  const labelVersionHash = isEn ? "VERSION HASH" : "HASH DE VERSIÓN";

  drawCenteredText(page, labelEmployee, fontBold, 9, PAGE_HEIGHT - 360, COLORS.inkLight);
  drawCenteredText(page, input.employeeName, fontBold, 22, PAGE_HEIGHT - 384, COLORS.ink);

  const dateStr = (input.signedAt ?? new Date()).toLocaleDateString(
    isEn ? "en-US" : "es-MX",
    { year: "numeric", month: "long", day: "numeric" },
  );
  drawCenteredText(page, labelVersionDate, fontBold, 9, PAGE_HEIGHT - 440, COLORS.inkLight);
  drawCenteredText(page, dateStr, fontRegular, 14, PAGE_HEIGHT - 460, COLORS.ink);

  drawCenteredText(page, labelVersionHash, fontBold, 9, PAGE_HEIGHT - 500, COLORS.inkLight);
  drawCenteredText(page, input.versionHash.slice(0, 16) + "…", fontRegular, 11, PAGE_HEIGHT - 518, COLORS.inkMute);

  // Compliance footer.
  const complianceText = isEn
    ? "This document represents the employee's complete acknowledgment of the Phes Employee Handbook, all required standalone policy acknowledgments, and the Final Handbook Acknowledgment, including at-will employment, commission consent, wage deduction notice, and annual re-acknowledgment commitment."
    : "Este documento representa el reconocimiento completo del empleado del Manual del Empleado de Phes, todos los reconocimientos de políticas independientes requeridos, y el Reconocimiento Final del Manual, incluyendo el empleo a voluntad, el consentimiento de comisión, la notificación de deducción salarial y el compromiso de reconocimiento anual.";

  drawWrappedText(
    page,
    complianceText,
    fontRegular,
    10,
    MARGIN,
    180,
    PAGE_WIDTH - MARGIN * 2,
    14,
    COLORS.inkMute,
  );

  if (input.pendingTranslationReview && input.locale === "es") {
    page.drawRectangle({
      x: MARGIN,
      y: 110,
      width: PAGE_WIDTH - MARGIN * 2,
      height: 36,
      color: rgb(1, 0.96, 0.86),
      borderColor: rgb(0.85, 0.6, 0.2),
      borderWidth: 1,
    });
    page.drawText(
      "TRADUCCIÓN BAJO REVISIÓN — la versión en inglés rige en caso de discrepancia.",
      {
        x: MARGIN + 12,
        y: 125,
        size: 10,
        font: fontBold,
        color: rgb(0.6, 0.4, 0.05),
      },
    );
  }
}

function drawHandbookSummary(
  page: PDFPage,
  fontRegular: PDFFont,
  fontBold: PDFFont,
  input: ComprehensiveHandbookInput,
): void {
  const isEn = input.locale === "en";
  const title = isEn
    ? "Handbook Contents Summary"
    : "Resumen del Contenido del Manual";
  drawSectionHeader(page, title, fontBold);

  const intro = isEn
    ? "The Phes Employee Handbook is delivered through the Learning Management System. The employee read each module in full and passed the comprehension quiz before signing this acknowledgment. The modules below are listed in the order they were completed, with the title shown in the locale the employee read."
    : "El Manual del Empleado de Phes se entrega a través del Sistema de Gestión de Aprendizaje. El empleado leyó cada módulo en su totalidad y aprobó el examen de comprensión antes de firmar este reconocimiento. Los módulos a continuación se enumeran en el orden en que se completaron, con el título mostrado en el idioma que el empleado leyó.";

  drawWrappedText(
    page,
    intro,
    fontRegular,
    10,
    MARGIN,
    PAGE_HEIGHT - 130,
    PAGE_WIDTH - MARGIN * 2,
    14,
    COLORS.inkMute,
  );

  // Module list.
  let y = PAGE_HEIGHT - 220;
  const completed = input.completedModuleIds.length
    ? input.completedModuleIds
    : Object.keys(input.moduleTitles);
  for (let i = 0; i < completed.length; i++) {
    const moduleId = completed[i];
    const titleText = input.moduleTitles[moduleId] ?? moduleId;
    if (y < 80) break; // overflow guard
    page.drawText(`${(i + 1).toString().padStart(2, "0")}.`, {
      x: MARGIN,
      y,
      size: 11,
      font: fontBold,
      color: COLORS.teal,
    });
    page.drawText(titleText, {
      x: MARGIN + 30,
      y,
      size: 11,
      font: fontRegular,
      color: COLORS.ink,
    });
    y -= 22;
  }

  // Footnote.
  const footnote = isEn
    ? "Full per-module quiz history, attempts, and scores are recorded in the LMS audit log and are available for IDHR review on request."
    : "El historial completo de exámenes por módulo, intentos y puntuaciones se registra en el registro de auditoría del LMS y está disponible para revisión del IDHR bajo solicitud.";

  drawWrappedText(
    page,
    footnote,
    fontRegular,
    9,
    MARGIN,
    90,
    PAGE_WIDTH - MARGIN * 2,
    12,
    COLORS.inkLight,
  );
}

function drawIncludedAcks(
  page: PDFPage,
  fontRegular: PDFFont,
  fontBold: PDFFont,
  input: ComprehensiveHandbookInput,
): void {
  const isEn = input.locale === "en";
  const title = isEn
    ? "Included Standalone Acknowledgments"
    : "Reconocimientos Independientes Incluidos";
  drawSectionHeader(page, title, fontBold);

  const intro = isEn
    ? "The following standalone policy acknowledgments were signed by the employee during onboarding and form part of this comprehensive handbook record. Each was hashed and stored individually at signing; the version hash and timestamp below match the original signed PDF on file."
    : "Los siguientes reconocimientos de políticas independientes fueron firmados por el empleado durante la incorporación y forman parte de este registro integral del manual. Cada uno fue hasheado y almacenado individualmente al firmarse; el hash de versión y la marca de tiempo a continuación coinciden con el PDF firmado original en archivo.";

  drawWrappedText(
    page,
    intro,
    fontRegular,
    10,
    MARGIN,
    PAGE_HEIGHT - 130,
    PAGE_WIDTH - MARGIN * 2,
    14,
    COLORS.inkMute,
  );

  const headerSigned = isEn ? "SIGNED" : "FIRMADO";
  const headerHash = isEn ? "HASH" : "HASH";

  // Table header.
  let y = PAGE_HEIGHT - 230;
  page.drawText("#", { x: MARGIN, y, size: 9, font: fontBold, color: COLORS.inkLight });
  page.drawText("DOCUMENT", { x: MARGIN + 24, y, size: 9, font: fontBold, color: COLORS.inkLight });
  page.drawText(headerSigned, { x: 340, y, size: 9, font: fontBold, color: COLORS.inkLight });
  page.drawText(headerHash, { x: 470, y, size: 9, font: fontBold, color: COLORS.inkLight });
  y -= 6;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    color: COLORS.line,
    thickness: 0.5,
  });
  y -= 18;

  // Rows.
  if (input.includedAcks.length === 0) {
    page.drawText(
      isEn
        ? "No standalone acknowledgments on file. This will block sign-off."
        : "No hay reconocimientos independientes en archivo. Esto bloqueará la firma.",
      { x: MARGIN, y, size: 10, font: fontRegular, color: COLORS.inkMute },
    );
  } else {
    for (let i = 0; i < input.includedAcks.length; i++) {
      const ack = input.includedAcks[i];
      if (y < 100) break;
      page.drawText(`${i + 1}`, {
        x: MARGIN,
        y,
        size: 10,
        font: fontBold,
        color: COLORS.teal,
      });
      page.drawText(ack.title, {
        x: MARGIN + 24,
        y,
        size: 10,
        font: fontRegular,
        color: COLORS.ink,
        maxWidth: 290,
      });
      const dateStr = ack.signedAt.toLocaleDateString(
        isEn ? "en-US" : "es-MX",
        { year: "numeric", month: "short", day: "numeric" },
      );
      page.drawText(dateStr, {
        x: 340,
        y,
        size: 9,
        font: fontRegular,
        color: COLORS.inkMute,
      });
      page.drawText(ack.versionHash.slice(0, 8), {
        x: 470,
        y,
        size: 9,
        font: fontRegular,
        color: COLORS.inkLight,
      });
      y -= 22;
    }
  }
}

async function drawFinalAcknowledgment(
  doc: PDFDocument,
  fontRegular: PDFFont,
  fontBold: PDFFont,
  input: ComprehensiveHandbookInput,
): Promise<void> {
  const isEn = input.locale === "en";
  const title = isEn
    ? "Final Handbook Acknowledgment"
    : "Reconocimiento Final del Manual";

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawSectionHeader(page, title, fontBold);

  // Render contentBody. The H2 lines (## ...) become bold section heads.
  // Plain prose between H2s is body text.
  const lines = input.contentBody.split("\n");
  let y = PAGE_HEIGHT - 130;
  const lineHeight = 14;
  const sectionHeadSize = 11;
  const bodySize = 10;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      y -= 6;
      continue;
    }
    if (y < 130) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      drawSectionHeader(page, title, fontBold);
      y = PAGE_HEIGHT - 130;
    }
    if (line.startsWith("## ")) {
      const head = line.slice(3);
      y -= 6;
      page.drawText(head, {
        x: MARGIN,
        y,
        size: sectionHeadSize,
        font: fontBold,
        color: COLORS.navy,
      });
      y -= 18;
    } else {
      y = drawWrappedText(
        page,
        line,
        fontRegular,
        bodySize,
        MARGIN,
        y,
        PAGE_WIDTH - MARGIN * 2,
        lineHeight,
        COLORS.ink,
      );
      y -= 4;
    }
  }

  // Reserve room for signature block at the bottom; create new page if too tight.
  if (y < 220) {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    drawSectionHeader(page, title, fontBold);
    y = PAGE_HEIGHT - 130;
  }
  await drawSignatureBlock(doc, page, fontRegular, fontBold, input, y);
}

async function drawSignatureBlock(
  doc: PDFDocument,
  page: PDFPage,
  fontRegular: PDFFont,
  fontBold: PDFFont,
  input: ComprehensiveHandbookInput,
  topY: number,
): Promise<void> {
  const isEn = input.locale === "en";
  const blockTop = Math.min(topY - 24, 240);

  page.drawLine({
    start: { x: MARGIN, y: blockTop + 10 },
    end: { x: PAGE_WIDTH - MARGIN, y: blockTop + 10 },
    color: COLORS.line,
    thickness: 0.5,
  });

  page.drawText(isEn ? "EMPLOYEE SIGNATURE" : "FIRMA DEL EMPLEADO", {
    x: MARGIN,
    y: blockTop - 6,
    size: 9,
    font: fontBold,
    color: COLORS.inkLight,
  });

  // Signature value
  const sigY = blockTop - 32;
  if (input.preview || !input.employeeSignature) {
    page.drawText(
      isEn ? "(preview — no signature applied)" : "(vista previa — sin firma aplicada)",
      { x: MARGIN, y: sigY, size: 11, font: fontRegular, color: COLORS.inkLight },
    );
  } else if (input.employeeSignatureMethod === "typed") {
    page.drawText(input.employeeSignature, {
      x: MARGIN,
      y: sigY,
      size: 18,
      font: fontBold,
      color: COLORS.ink,
    });
  } else {
    // Drawn signatures arrive as data URLs (data:image/png;base64,... or
    // data:image/jpeg;base64,...). Decode the base64 payload, embed via
    // pdf-lib, scale to fit the signature row, and draw above the
    // printed name. On decode failure (malformed URL, unknown MIME),
    // fall back to the legal-name text so the PDF always renders.
    const signaturePayload = input.employeeSignature;
    let embedded = false;
    try {
      const commaIndex = signaturePayload.indexOf(",");
      if (signaturePayload.startsWith("data:") && commaIndex > 0) {
        const meta = signaturePayload.slice(5, commaIndex);
        const base64 = signaturePayload.slice(commaIndex + 1);
        const bytes = Buffer.from(base64, "base64");
        const img = meta.includes("image/png")
          ? await doc.embedPng(bytes)
          : await doc.embedJpg(bytes);
        const maxW = PAGE_WIDTH - MARGIN * 2;
        const scale = Math.min(maxW / img.width, 56 / img.height, 1);
        page.drawImage(img, {
          x: MARGIN,
          y: sigY - 20,
          width: img.width * scale,
          height: img.height * scale,
        });
        embedded = true;
      }
    } catch {
      // fall through to text fallback below.
    }
    if (!embedded) {
      page.drawText(input.employeeName, {
        x: MARGIN,
        y: sigY,
        size: 18,
        font: fontBold,
        color: COLORS.ink,
      });
      page.drawText(
        isEn
          ? "(drawn signature could not render — raw bytes on file)"
          : "(la firma dibujada no se pudo renderizar — bytes originales en archivo)",
        {
          x: MARGIN,
          y: sigY - 16,
          size: 9,
          font: fontRegular,
          color: COLORS.inkLight,
        },
      );
    }
  }

  // Legal name + date row.
  const rowY = blockTop - 76;
  page.drawText(isEn ? "PRINTED NAME" : "NOMBRE EN LETRA DE MOLDE", {
    x: MARGIN,
    y: rowY,
    size: 9,
    font: fontBold,
    color: COLORS.inkLight,
  });
  page.drawText(input.employeeName, {
    x: MARGIN,
    y: rowY - 16,
    size: 12,
    font: fontRegular,
    color: COLORS.ink,
  });

  page.drawText(isEn ? "DATE SIGNED" : "FECHA DE FIRMA", {
    x: 320,
    y: rowY,
    size: 9,
    font: fontBold,
    color: COLORS.inkLight,
  });
  const dateStr = (input.signedAt ?? new Date()).toLocaleString(
    isEn ? "en-US" : "es-MX",
    { dateStyle: "long", timeStyle: "short" },
  );
  page.drawText(dateStr, {
    x: 320,
    y: rowY - 16,
    size: 11,
    font: fontRegular,
    color: COLORS.ink,
  });
}

function drawAuditFooter(
  page: PDFPage,
  fontRegular: PDFFont,
  input: ComprehensiveHandbookInput,
  pageNum: number,
  totalPages: number,
): void {
  const isEn = input.locale === "en";
  const footerY = 36;

  const ip = input.ipAddress ?? "(preview)";
  const device = input.deviceInfo ?? "(preview)";
  const hash = input.versionHash;
  const text = isEn
    ? `${input.tenantName} Handbook · Page ${pageNum} of ${totalPages} · IP ${ip} · ${device} · v${hash.slice(0, 8)}`
    : `Manual de ${input.tenantName} · Página ${pageNum} de ${totalPages} · IP ${ip} · ${device} · v${hash.slice(0, 8)}`;

  page.drawText(text, {
    x: MARGIN,
    y: footerY,
    size: 7,
    font: fontRegular,
    color: COLORS.inkLight,
  });
}

function drawPreviewWatermark(page: PDFPage, fontBold: PDFFont): void {
  // Diagonal-ish watermark; pdf-lib doesn't rotate text easily without a
  // text transformation matrix, so we use a horizontal centered label.
  page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT / 2 - 20,
    width: PAGE_WIDTH,
    height: 40,
    color: COLORS.watermark,
    opacity: 0.4,
  });
  drawCenteredText(page, "PREVIEW · NOT SIGNED", fontBold, 18, PAGE_HEIGHT / 2 - 8, COLORS.inkLight);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function drawSectionHeader(page: PDFPage, title: string, fontBold: PDFFont): void {
  page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - 6,
    width: PAGE_WIDTH,
    height: 6,
    color: COLORS.mint,
  });
  page.drawText(title, {
    x: MARGIN,
    y: PAGE_HEIGHT - 80,
    size: 22,
    font: fontBold,
    color: COLORS.navy,
  });
  page.drawLine({
    start: { x: MARGIN, y: PAGE_HEIGHT - 100 },
    end: { x: MARGIN + 60, y: PAGE_HEIGHT - 100 },
    color: COLORS.teal,
    thickness: 2,
  });
}

function drawCenteredText(
  page: PDFPage,
  text: string,
  font: PDFFont,
  size: number,
  y: number,
  color: ReturnType<typeof rgb>,
): void {
  const width = font.widthOfTextAtSize(text, size);
  const x = (PAGE_WIDTH - width) / 2;
  page.drawText(text, { x, y, size, font, color });
}

/**
 * Word-wraps a paragraph into multiple lines, draws each line, returns
 * the y-coordinate of the next available line.
 */
function drawWrappedText(
  page: PDFPage,
  text: string,
  font: PDFFont,
  size: number,
  x: number,
  startY: number,
  maxWidth: number,
  lineHeight: number,
  color: ReturnType<typeof rgb>,
): number {
  const words = text.split(/\s+/);
  let line = "";
  let y = startY;
  for (const word of words) {
    const next = line ? line + " " + word : word;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
      page.drawText(line, { x, y, size, font, color });
      y -= lineHeight;
      line = word;
    } else {
      line = next;
    }
  }
  if (line) {
    page.drawText(line, { x, y, size, font, color });
    y -= lineHeight;
  }
  return y;
}
