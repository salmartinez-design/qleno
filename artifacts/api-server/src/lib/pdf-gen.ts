/**
 * PDF generation — pdf-lib wrapper.
 *
 * Scaffolded in PR #1. Used by:
 *   - PR #3 (per-module completion certificates)
 *   - PR #13 (final comprehensive signed handbook PDF)
 *
 * pdf-lib was chosen over Puppeteer because it:
 *   - Pure Node, no Chromium dependency (Railway-friendly)
 *   - Deterministic output (same input → same bytes, important for
 *     tamper-evident storage hashing)
 *   - Embeddable in Express handlers without spawning a browser
 *
 * Trade-off: layout control is programmatic (we draw rectangles, lines,
 * and text), not HTML. The certificate template is hand-coded but
 * intentionally simple. The final handbook PDF (PR #13) will need a
 * more elaborate layout pass.
 *
 * IMPORTANT: this module only renders. Storage / persistence is
 * caller's responsibility. Returns a Buffer, the caller chooses
 * whether to serve directly, write to S3, or stash in lms_signed_documents
 * .pdf_storage_url.
 */
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

// ─────────────────────────────────────────────────────────────────────────────
// Color palette — Plus Jakarta Sans isn't embeddable by pdf-lib without a
// font file, so we use Helvetica (bundled). Colors mirror the Qleno brand.
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = {
  navy: rgb(0.04, 0.14, 0.26),   // #0A2342
  teal: rgb(0.0, 0.59, 0.7),     // #0096B3
  ink: rgb(0.06, 0.09, 0.15),    // #0F172A
  inkMute: rgb(0.28, 0.34, 0.41),// #475569
  inkLight: rgb(0.58, 0.64, 0.72),// #94A3B8
  line: rgb(0.89, 0.91, 0.94),   // #E2E8F0
  surface: rgb(1, 1, 1),
  success: rgb(0.06, 0.46, 0.43),// #0F766E
  mint: rgb(0.0, 0.79, 0.63),    // #00C9A0 (Qleno accent)
};

// ─────────────────────────────────────────────────────────────────────────────
// CompletionCertificate input
// ─────────────────────────────────────────────────────────────────────────────

export interface CertificateInput {
  /** Tenant brand name printed on the certificate, e.g. "Phes". */
  tenantName: string;
  /** Learner's full name. */
  employeeName: string;
  /** Display title of the module (already localized). */
  moduleTitle: string;
  /** Module id for the small footer reference, e.g. "phes-policies". */
  moduleId: string;
  /** Quiz score 0..100, null for content-only modules. */
  score: number | null;
  /** Issue timestamp. */
  issuedAt: Date;
  /** SHA-256 of the curriculum that produced this cert. */
  curriculumVersionHash: string | null;
  /** Locale at issuance ('en' | 'es'). */
  locale: string;
  /** IP at issuance. */
  ipAddress: string;
  /** User agent at issuance. */
  deviceInfo: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// generateCertificatePdf
// ─────────────────────────────────────────────────────────────────────────────
//
// Single-page landscape certificate. Hand-laid because pdf-lib doesn't
// do HTML. Future PRs that want to tweak layout edit here.

export async function generateCertificatePdf(
  input: CertificateInput,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([792, 612]); // US Letter landscape (8.5x11 @ 72dpi)
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const helvItalic = await doc.embedFont(StandardFonts.HelveticaOblique);

  drawCertificateChrome(page, helv);
  drawCertificateBody(page, helvBold, helv, helvItalic, input);
  drawCertificateFooter(page, helv, input);

  return doc.save();
}

function drawCertificateChrome(page: PDFPage, helv: PDFFont): void {
  const { width, height } = page.getSize();
  // Thin border
  page.drawRectangle({
    x: 24,
    y: 24,
    width: width - 48,
    height: height - 48,
    borderColor: COLORS.navy,
    borderWidth: 1,
  });
  // Mint accent bar at top
  page.drawRectangle({
    x: 24,
    y: height - 32,
    width: width - 48,
    height: 8,
    color: COLORS.mint,
  });
  // Watermark "QLENO" faint at center
  page.drawText("QLENO", {
    x: width / 2 - 90,
    y: height / 2 - 12,
    size: 64,
    font: helv,
    color: rgb(0.95, 0.95, 0.95),
    opacity: 0.4,
  });
}

function drawCertificateBody(
  page: PDFPage,
  helvBold: PDFFont,
  helv: PDFFont,
  helvItalic: PDFFont,
  input: CertificateInput,
): void {
  const { width } = page.getSize();
  const centerX = width / 2;

  // Header label
  drawCentered(
    page,
    "CERTIFICATE OF COMPLETION",
    centerX,
    520,
    18,
    helvBold,
    COLORS.navy,
    { letterSpacing: 4 },
  );

  // Tenant name
  drawCentered(
    page,
    input.tenantName.toUpperCase(),
    centerX,
    488,
    11,
    helv,
    COLORS.inkMute,
    { letterSpacing: 3 },
  );

  // "This certifies that"
  drawCentered(
    page,
    input.locale === "es"
      ? "Esto certifica que"
      : "This certifies that",
    centerX,
    430,
    13,
    helvItalic,
    COLORS.inkMute,
  );

  // Employee name (large)
  drawCentered(
    page,
    input.employeeName,
    centerX,
    380,
    34,
    helvBold,
    COLORS.ink,
  );

  // "has successfully completed"
  drawCentered(
    page,
    input.locale === "es"
      ? "ha completado con éxito"
      : "has successfully completed",
    centerX,
    330,
    13,
    helvItalic,
    COLORS.inkMute,
  );

  // Module title
  drawCentered(page, input.moduleTitle, centerX, 290, 22, helvBold, COLORS.navy);

  // Score line (if applicable)
  if (input.score !== null) {
    const scoreLine =
      input.locale === "es"
        ? `Puntaje: ${input.score}%`
        : `Score: ${input.score}%`;
    drawCentered(page, scoreLine, centerX, 250, 14, helv, COLORS.success);
  }

  // Issued date
  const dateLine =
    input.locale === "es"
      ? `Emitido el ${formatDate(input.issuedAt, "es")}`
      : `Issued ${formatDate(input.issuedAt, "en")}`;
  drawCentered(page, dateLine, centerX, 210, 12, helv, COLORS.inkMute);
}

function drawCertificateFooter(
  page: PDFPage,
  helv: PDFFont,
  input: CertificateInput,
): void {
  const lines: string[] = [
    `Module: ${input.moduleId}`,
    input.curriculumVersionHash
      ? `Version: ${input.curriculumVersionHash.slice(0, 16)}…`
      : "",
    `Issued at: ${input.issuedAt.toISOString()}`,
    `IP: ${input.ipAddress}`,
    truncate(`Device: ${input.deviceInfo}`, 120),
  ].filter(Boolean);

  let y = 80;
  for (const line of lines) {
    page.drawText(line, {
      x: 48,
      y,
      size: 7,
      font: helv,
      color: COLORS.inkLight,
    });
    y -= 10;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared drawing primitives
// ─────────────────────────────────────────────────────────────────────────────

interface DrawCenteredOpts {
  letterSpacing?: number;
}

function drawCentered(
  page: PDFPage,
  text: string,
  centerX: number,
  y: number,
  size: number,
  font: PDFFont,
  color = COLORS.ink,
  opts: DrawCenteredOpts = {},
): void {
  // pdf-lib doesn't ship a letter-spacing API; we draw character by
  // character when the caller requests spacing. For most lines we just
  // measure + draw once.
  if (opts.letterSpacing && opts.letterSpacing > 0) {
    const spacing = opts.letterSpacing;
    const widths = text.split("").map((ch) => font.widthOfTextAtSize(ch, size));
    const total =
      widths.reduce((s, w) => s + w, 0) + spacing * (text.length - 1);
    let x = centerX - total / 2;
    text.split("").forEach((ch, i) => {
      page.drawText(ch, { x, y, size, font, color });
      x += widths[i] + spacing;
    });
    return;
  }
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: centerX - width / 2, y, size, font, color });
}

function formatDate(d: Date, locale: "en" | "es"): string {
  // pdf-lib runs in Node so we can use Intl freely.
  return new Intl.DateTimeFormat(locale === "es" ? "es-MX" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(d);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
