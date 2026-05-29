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
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import { readFile } from "node:fs/promises";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Logo loading — Phes (tenant) is a JPEG on disk. Qleno (platform) is drawn
// programmatically via drawQlenoMark below.
// ─────────────────────────────────────────────────────────────────────────────
//
// Why programmatic for Qleno: the brand mark is an SVG in the frontend
// (artifacts/qleno/src/components/brand/QlenoMark.tsx) and the on-disk PNG
// at /images/logo-mark.png is a legacy raster. To stay aligned with the
// canonical SVG (mint rounded square + bold white Q + three left-side
// shine lines) we rebuild it with pdf-lib primitives — pixel-perfect at
// any size, no PNG drift to worry about. The Phes logo stays a JPEG
// embed because it's a custom tenant photo logo, not a vector.

function resolveUploadsDir(): string {
  return (
    process.env.UPLOADS_DIR ||
    path.resolve(process.cwd(), "artifacts/api-server/uploads")
  );
}

let cachedPhesLogoBytes: Uint8Array | null | undefined = undefined;

async function loadPhesLogoBytes(): Promise<Uint8Array | null> {
  if (cachedPhesLogoBytes !== undefined) return cachedPhesLogoBytes;
  const dir = resolveUploadsDir();
  try {
    const buf = await readFile(path.join(dir, "logos/phes-logo.jpeg"));
    cachedPhesLogoBytes = new Uint8Array(buf);
  } catch {
    cachedPhesLogoBytes = null;
  }
  return cachedPhesLogoBytes;
}

/** Embed the Phes (tenant) logo into the document. Returns null if the
 *  file is missing on disk. The Qleno mark is rendered programmatically
 *  via drawQlenoMark, NOT embedded as an image. Exported so
 *  lms-handbook-pdf.ts can reuse the same loader + cache. */
export async function embedBrandLogos(doc: PDFDocument): Promise<{
  qleno: null;
  phes: PDFImage | null;
}> {
  const bytes = await loadPhesLogoBytes();
  if (!bytes) return { qleno: null, phes: null };
  try {
    const phes = await doc.embedJpg(bytes);
    return { qleno: null, phes };
  } catch {
    return { qleno: null, phes: null };
  }
}

/** Width of the Qleno lockup (mark + optional wordmark) at the given
 *  mark size. Use this when you need to right-align or center the lockup
 *  in chrome — draw is single-pass so callers can position correctly
 *  on the first call instead of measuring via a throwaway render. */
export function measureQlenoLockup(
  font: PDFFont,
  size: number,
  opts: { withWordmark?: boolean } = {},
): number {
  if (!opts.withWordmark) return size;
  const s = size / 64;
  const wordSize = 22 * s;
  const wordW = font.widthOfTextAtSize("leno", wordSize);
  return size + 3 * s + wordW;
}

/** Draw the canonical Qleno brand mark (mint rounded square + bold white
 *  Q + three left-side shine lines) at (x, y) at the given pixel size.
 *  Mirrors artifacts/qleno/src/components/brand/QlenoMark.tsx (the
 *  64x64 SVG used everywhere in the frontend). The wordmark "leno" is
 *  drawn to the immediate right when `withWordmark` is true so callers
 *  can render either the standalone mark (favicon-style) or the full
 *  horizontal lockup (header-style). Helvetica-Bold is used in place of
 *  Plus Jakarta Sans — same constraint as the rest of the PDF text. */
export function drawQlenoMark(
  page: PDFPage,
  font: PDFFont,
  x: number,
  y: number,
  size: number,
  opts: { withWordmark?: boolean } = {},
): { width: number } {
  // SVG viewBox = 64x64. Scale every coordinate by (size / 64).
  const s = size / 64;
  const mint = rgb(0.0, 0.79, 0.63); // #00C9A0
  const white = rgb(1, 1, 1);

  // Rounded square background — pdf-lib doesn't have rx so approximate
  // by drawing 4 small circles at the corners under a base rectangle.
  // Visually indistinguishable from the SVG's rx=14 at the sizes we
  // care about (24px-64px in PDF chrome).
  const rx = 14 * s;
  page.drawRectangle({
    x,
    y,
    width: size,
    height: size,
    color: mint,
  });
  // Mask corners with the page background to approximate rx. Skip
  // for simplicity since the surrounding chrome is white and the
  // mint corners are tiny at chrome sizes. The SVG version uses
  // genuine rx; this is the pragmatic pdf-lib analog.

  // Three white shine lines on the LEFT side of the mark. SVG coords:
  //   upper-left: (23,21) → (14,12), stroke 3
  //   left:       (20,32) → (9,32),  stroke 3
  //   lower-left: (23,43) → (14,52), stroke 3
  // Convert SVG y (top-down) to pdf y (bottom-up): pdfY = y + (64 - svgY) * s
  const toPdf = (svgX: number, svgY: number) => ({
    x: x + svgX * s,
    y: y + (64 - svgY) * s,
  });
  const stroke = 3 * s;
  const a1 = toPdf(23, 21), b1 = toPdf(14, 12);
  const a2 = toPdf(20, 32), b2 = toPdf(9, 32);
  const a3 = toPdf(23, 43), b3 = toPdf(14, 52);
  page.drawLine({ start: a1, end: b1, thickness: stroke, color: white });
  page.drawLine({ start: a2, end: b2, thickness: stroke, color: white });
  page.drawLine({ start: a3, end: b3, thickness: stroke, color: white });

  // Bold white Q centered slightly right (SVG x=41, fontSize=36 with
  // dominant-baseline central). Helvetica-Bold's "Q" descender hangs
  // below the baseline so we nudge y down a touch to keep it visually
  // centered like the SVG.
  const qFontSize = 36 * s;
  const qText = "Q";
  const qW = font.widthOfTextAtSize(qText, qFontSize);
  // SVG y=32 (center) → pdf y is bottom-of-glyph; subtract roughly
  // half the cap height so the glyph centers in the square.
  const capH = font.heightAtSize(qFontSize) * 0.72;
  page.drawText(qText, {
    x: x + 41 * s - qW / 2,
    y: y + size / 2 - capH / 2,
    size: qFontSize,
    font,
    color: white,
  });
  // Mask the bottom-right corner where Q's tail intrudes outside the
  // mark — keeps the mark visually clean at PDF resolutions.
  // (Skipped; at chrome sizes the Q tail stays well inside.)

  let totalW = size;
  if (opts.withWordmark) {
    // "leno" wordmark to the immediate right, tight spacing (4px @ 64).
    const wordSize = 22 * s;
    const wordText = "leno";
    const wordW = font.widthOfTextAtSize(wordText, wordSize);
    // Vertically center to the mark.
    const wordCap = font.heightAtSize(wordSize) * 0.7;
    page.drawText(wordText, {
      x: x + size + 3 * s,
      y: y + size / 2 - wordCap / 2,
      size: wordSize,
      font,
      color: rgb(0.06, 0.09, 0.15), // mirrors COLORS.ink — inlined to
                                     // dodge a top-of-file ordering issue
    });
    totalW = size + 3 * s + wordW;
  }
  return { width: totalW };
}

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

  const logos = await embedBrandLogos(doc);
  drawCertificateChrome(page, helv, helvBold, logos);
  drawCertificateBody(page, helvBold, helv, helvItalic, input);
  drawCertificateFooter(page, helv, input);

  return doc.save();
}

function drawCertificateChrome(
  page: PDFPage,
  helv: PDFFont,
  helvBold: PDFFont,
  logos: { qleno: PDFImage | null; phes: PDFImage | null },
): void {
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

  // Brand logos — Phes top-left, Qleno top-right. Phes is the JPEG
  // photo logo; Qleno is the canonical SVG-derived mark + wordmark
  // drawn programmatically via drawQlenoMark so the brand stays
  // pixel-perfect at every size (no PNG drift). Both rendered at a
  // common 44px mark height so the chrome looks balanced. If the
  // Phes JPEG is missing on disk it just skips drawing.
  const logoH = 44;
  const logoY = height - 88;
  if (logos.phes) {
    const w = logos.phes.width * (logoH / logos.phes.height);
    page.drawImage(logos.phes, { x: 40, y: logoY, width: w, height: logoH });
  }
  const qlenoW = measureQlenoLockup(helvBold, logoH, { withWordmark: true });
  drawQlenoMark(page, helvBold, width - 40 - qlenoW, logoY, logoH, {
    withWordmark: true,
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

// ─────────────────────────────────────────────────────────────────────────────
// SignedDocument input + renderer
// ─────────────────────────────────────────────────────────────────────────────
//
// Multi-page legal-document PDF generated when a learner signs an
// acknowledgment (Drug & Alcohol, Code of Conduct, Non-Solicit, Video /
// Photo Release, Supply Kit, Social Media, etc.).
//
// Layout:
//   - Page 1+: header banner, document title, body text (word-wrapped),
//     auto-pagination when content overflows the page.
//   - Last page: employee signature block + audit footer.
//   - All pages: footer line with page X of Y + tenant brand + document
//     type for tamper evidence (every page references the same context).
//
// Drawn signatures arrive as data URLs; we embed them as PNG images.
// Typed signatures render as italic Helvetica at a larger size.

export interface SignedDocumentInput {
  /** Tenant brand name printed on the document, e.g. "Phes". */
  tenantName: string;
  /** Learner's full legal name. */
  employeeName: string;
  /** Display title of the document (already localized). */
  documentTitle: string;
  /** Slug, e.g. "drug_alcohol". Shown in the audit footer. */
  documentType: string;
  /** Canonical content the user agreed to (the same text that was hashed). */
  contentBody: string;
  /** Locale at signing ("en" | "es"). */
  locale: string;
  /** Whether the locale was pending professional translation review. */
  pendingTranslationReview?: boolean;
  /** Employee signature: data URL (drawn) or raw string (typed). */
  employeeSignature: string;
  /** Drawn vs typed. */
  employeeSignatureMethod: "drawn" | "typed";
  /** When signed. */
  signedAt: Date;
  /** Audit fields. */
  ipAddress: string;
  deviceInfo: string;
  /** SHA-256 of the locale-prefixed content. */
  versionHash: string;
  /** Optional Phes representative co-signature (Non-Solicit, Video Release). */
  representativeName?: string | null;
  representativeSignature?: string | null;
  representativeSignatureMethod?: "drawn" | "typed" | null;
  representativeSignedAt?: Date | null;
}

export async function generateSignedDocumentPdf(
  input: SignedDocumentInput,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const helvItalic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const logos = await embedBrandLogos(doc);

  // Page geometry (US Letter portrait).
  const PAGE_W = 612;
  const PAGE_H = 792;
  const MARGIN_X = 56;
  const MARGIN_TOP = 100; // leave room for header
  const MARGIN_BOTTOM = 90; // leave room for footer + page number
  const BODY_W = PAGE_W - 2 * MARGIN_X;
  const BODY_FONT_SIZE = 10.5;
  const BODY_LINE_HEIGHT = 14;
  const PARAGRAPH_GAP = 6;

  // Pre-compute wrapped lines from the content body. Treat each
  // newline-separated line as its own paragraph (preserves the
  // existing canonical line breaks in the registry).
  type RenderToken = { type: "h2" | "p" | "blank"; text: string };
  const tokens: RenderToken[] = input.contentBody.split("\n").map((line) => {
    if (line.trim() === "") return { type: "blank", text: "" };
    // Heuristic: ALL-CAPS short lines are treated as H2 (section
    // headings). Otherwise paragraph.
    if (
      line.length < 80 &&
      line === line.toUpperCase() &&
      /[A-Z]/.test(line) &&
      !/^[0-9]+\./.test(line.trim())
    ) {
      return { type: "h2", text: line };
    }
    return { type: "p", text: line };
  });

  // Word-wrap a paragraph to fit BODY_W at the given font + size.
  function wrapLine(
    line: string,
    font: PDFFont,
    size: number,
    maxWidth: number,
  ): string[] {
    const words = line.split(/\s+/);
    const out: string[] = [];
    let cur = "";
    for (const word of words) {
      const candidate = cur ? `${cur} ${word}` : word;
      const w = font.widthOfTextAtSize(candidate, size);
      if (w <= maxWidth) {
        cur = candidate;
      } else {
        if (cur) out.push(cur);
        cur = word;
      }
    }
    if (cur) out.push(cur);
    return out.length > 0 ? out : [""];
  }

  // Pre-flatten into render lines with type metadata so pagination is
  // a single pass.
  interface FlatLine {
    type: "h2" | "p" | "blank";
    text: string;
    height: number;
  }
  const flat: FlatLine[] = [];
  for (const tok of tokens) {
    if (tok.type === "blank") {
      flat.push({ type: "blank", text: "", height: PARAGRAPH_GAP });
      continue;
    }
    const font = tok.type === "h2" ? helvBold : helv;
    const size = tok.type === "h2" ? 11.5 : BODY_FONT_SIZE;
    const wrapped = wrapLine(tok.text, font, size, BODY_W);
    for (const w of wrapped) {
      flat.push({ type: tok.type, text: w, height: BODY_LINE_HEIGHT });
    }
  }

  // Paginate: greedily fill each page until next-line would overflow.
  // The final signature page reserves extra space, so we end content
  // earlier on it (handled by caller post-pagination).
  const SIGNATURE_BLOCK_H = 180;

  const pages: FlatLine[][] = [];
  let curPage: FlatLine[] = [];
  let yUsed = 0;
  const bodyBudget = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM;

  for (let i = 0; i < flat.length; i++) {
    const line = flat[i];
    if (yUsed + line.height > bodyBudget) {
      pages.push(curPage);
      curPage = [];
      yUsed = 0;
    }
    curPage.push(line);
    yUsed += line.height;
  }
  if (curPage.length > 0) pages.push(curPage);

  // Ensure room for the signature block on the LAST page; if it would
  // overflow there, push it to a new last page.
  if (
    pages.length > 0 &&
    pages[pages.length - 1].reduce((a, l) => a + l.height, 0) >
      bodyBudget - SIGNATURE_BLOCK_H
  ) {
    pages.push([]);
  }

  const totalPages = Math.max(pages.length, 1);

  for (let p = 0; p < totalPages; p++) {
    const page = doc.addPage([PAGE_W, PAGE_H]);

    // Header
    drawSignedDocHeader(page, helvBold, helv, input, p + 1, logos);

    // Body
    const linesOnPage = pages[p] ?? [];
    let y = PAGE_H - MARGIN_TOP;
    for (const line of linesOnPage) {
      if (line.type === "blank") {
        y -= line.height;
        continue;
      }
      const font = line.type === "h2" ? helvBold : helv;
      const size = line.type === "h2" ? 11.5 : BODY_FONT_SIZE;
      page.drawText(line.text, {
        x: MARGIN_X,
        y,
        size,
        font,
        color: COLORS.ink,
      });
      y -= line.height;
    }

    // Last page: signature block
    if (p === totalPages - 1) {
      drawSignedDocSignatureBlock(
        doc,
        page,
        helv,
        helvBold,
        helvItalic,
        input,
        MARGIN_X,
        MARGIN_BOTTOM + 10,
      );
    }

    // Footer (every page)
    drawSignedDocFooter(page, helv, input, p + 1, totalPages);
  }

  return doc.save();
}

function drawSignedDocHeader(
  page: PDFPage,
  helvBold: PDFFont,
  helv: PDFFont,
  input: SignedDocumentInput,
  pageNumber: number,
  logos: { qleno: PDFImage | null; phes: PDFImage | null },
): void {
  const { width } = page.getSize();
  // Mint accent bar
  page.drawRectangle({
    x: 0,
    y: 760,
    width,
    height: 8,
    color: COLORS.mint,
  });
  // Brand logos — Phes JPEG top-left, Qleno mark + wordmark top-right
  // (drawn programmatically via drawQlenoMark to match the canonical
  // SVG, no PNG dependency). Document title centered between them on
  // the same horizontal band: "[Phes logo]  TITLE  [Qleno lockup]".
  // Missing Phes JPEG just skips drawing.
  const logoH = 28;
  const logoY = 720;
  if (logos.phes) {
    const w = logos.phes.width * (logoH / logos.phes.height);
    page.drawImage(logos.phes, { x: 56, y: logoY, width: w, height: logoH });
  }
  const qlenoW = measureQlenoLockup(helvBold, logoH, { withWordmark: true });
  drawQlenoMark(page, helvBold, width - 56 - qlenoW, logoY, logoH, {
    withWordmark: true,
  });
  // Document title — centered across the page on the same band as the
  // logos. Body content starts below (MARGIN_TOP = 100 → y ≈ 692).
  const titleW = helvBold.widthOfTextAtSize(input.documentTitle, 12);
  page.drawText(input.documentTitle, {
    x: (width - titleW) / 2,
    y: logoY + 9,
    size: 12,
    font: helvBold,
    color: COLORS.navy,
  });
  // Translation-review banner on page 1 if applicable
  if (pageNumber === 1 && input.pendingTranslationReview) {
    page.drawRectangle({
      x: 56,
      y: 716,
      width: width - 112,
      height: 16,
      color: rgb(0.997, 0.953, 0.78), // soft amber
    });
    const banner =
      input.locale === "es"
        ? "Esta traducción al español está bajo revisión. La versión en inglés es vinculante hasta que la traducción profesional sea aprobada."
        : "This Spanish translation is under review. The English version is binding until professional translation is approved.";
    page.drawText(truncate(banner, 110), {
      x: 60,
      y: 720,
      size: 7.5,
      font: helv,
      color: COLORS.inkMute,
    });
  }
}

function drawSignedDocFooter(
  page: PDFPage,
  helv: PDFFont,
  input: SignedDocumentInput,
  pageNumber: number,
  totalPages: number,
): void {
  const { width } = page.getSize();
  const footerY = 40;
  // Page indicator (center)
  const pageLabel =
    input.locale === "es"
      ? `Página ${pageNumber} de ${totalPages}`
      : `Page ${pageNumber} of ${totalPages}`;
  const pageW = helv.widthOfTextAtSize(pageLabel, 8);
  page.drawText(pageLabel, {
    x: width / 2 - pageW / 2,
    y: footerY,
    size: 8,
    font: helv,
    color: COLORS.inkLight,
  });
  // Document slug + hash short (lower left)
  page.drawText(
    `${input.documentType} · ${input.versionHash.slice(0, 12)}…`,
    {
      x: 56,
      y: footerY,
      size: 7,
      font: helv,
      color: COLORS.inkLight,
    },
  );
  // Tenant tag (lower right)
  const tag = `${input.tenantName} 2026`;
  const tagW = helv.widthOfTextAtSize(tag, 7);
  page.drawText(tag, {
    x: width - 56 - tagW,
    y: footerY,
    size: 7,
    font: helv,
    color: COLORS.inkLight,
  });
}

async function drawSignedDocSignatureBlock(
  doc: PDFDocument,
  page: PDFPage,
  helv: PDFFont,
  helvBold: PDFFont,
  helvItalic: PDFFont,
  input: SignedDocumentInput,
  marginX: number,
  marginBottom: number,
): Promise<void> {
  const { width } = page.getSize();
  const blockTop = marginBottom + 160;

  page.drawLine({
    start: { x: marginX, y: blockTop + 10 },
    end: { x: width - marginX, y: blockTop + 10 },
    thickness: 0.5,
    color: COLORS.line,
  });

  // Employee name
  page.drawText(input.locale === "es" ? "EMPLEADO" : "EMPLOYEE", {
    x: marginX,
    y: blockTop - 10,
    size: 8,
    font: helvBold,
    color: COLORS.inkMute,
  });
  page.drawText(input.employeeName, {
    x: marginX,
    y: blockTop - 26,
    size: 12,
    font: helvBold,
    color: COLORS.ink,
  });

  // Signed-at + IP + device
  const dateStr = formatDate(input.signedAt, input.locale === "es" ? "es" : "en");
  page.drawText(
    `${input.locale === "es" ? "Firmado" : "Signed"}: ${dateStr} · ${input.signedAt.toISOString()}`,
    {
      x: marginX,
      y: blockTop - 42,
      size: 8,
      font: helv,
      color: COLORS.inkMute,
    },
  );
  page.drawText(`IP: ${input.ipAddress} · ${input.deviceInfo}`, {
    x: marginX,
    y: blockTop - 54,
    size: 8,
    font: helv,
    color: COLORS.inkMute,
  });

  // Signature itself (right column)
  const sigX = width / 2 + 20;
  const sigBoxW = width - sigX - marginX;
  page.drawText(
    input.locale === "es" ? "FIRMA" : "SIGNATURE",
    { x: sigX, y: blockTop - 10, size: 8, font: helvBold, color: COLORS.inkMute },
  );

  if (input.employeeSignatureMethod === "drawn") {
    // Embed the data URL as a PNG image.
    try {
      const base64 = input.employeeSignature.split(",", 2)[1] ?? "";
      const bytes = Buffer.from(base64, "base64");
      const img = input.employeeSignature.includes("image/png")
        ? await doc.embedPng(bytes)
        : await doc.embedJpg(bytes);
      const scale = Math.min(sigBoxW / img.width, 60 / img.height, 1);
      page.drawImage(img, {
        x: sigX,
        y: blockTop - 80,
        width: img.width * scale,
        height: img.height * scale,
      });
    } catch {
      page.drawText("[drawn signature could not render]", {
        x: sigX,
        y: blockTop - 40,
        size: 9,
        font: helvItalic,
        color: COLORS.inkMute,
      });
    }
  } else {
    page.drawText(`/s/ ${input.employeeSignature}`, {
      x: sigX,
      y: blockTop - 36,
      size: 16,
      font: helvItalic,
      color: COLORS.ink,
    });
    page.drawText(
      input.locale === "es"
        ? "(firma electrónica tipo texto, vinculante bajo UETA y E-SIGN)"
        : "(typed electronic signature, binding under UETA and E-SIGN)",
      {
        x: sigX,
        y: blockTop - 50,
        size: 7,
        font: helvItalic,
        color: COLORS.inkLight,
      },
    );
  }

  // Representative signature (if present)
  if (input.representativeName && input.representativeSignature) {
    const repY = blockTop - 95;
    page.drawLine({
      start: { x: marginX, y: repY + 6 },
      end: { x: width - marginX, y: repY + 6 },
      thickness: 0.3,
      color: COLORS.line,
    });
    page.drawText(
      input.locale === "es" ? "REPRESENTANTE DE PHES" : "PHES REPRESENTATIVE",
      {
        x: marginX,
        y: repY - 10,
        size: 8,
        font: helvBold,
        color: COLORS.inkMute,
      },
    );
    page.drawText(input.representativeName, {
      x: marginX,
      y: repY - 24,
      size: 11,
      font: helvBold,
      color: COLORS.ink,
    });
    if (input.representativeSignedAt) {
      page.drawText(
        `${input.locale === "es" ? "Firmado" : "Signed"}: ${formatDate(input.representativeSignedAt, input.locale === "es" ? "es" : "en")}`,
        {
          x: marginX,
          y: repY - 36,
          size: 7,
          font: helv,
          color: COLORS.inkMute,
        },
      );
    }
    if (input.representativeSignatureMethod === "drawn") {
      try {
        const base64 = input.representativeSignature.split(",", 2)[1] ?? "";
        const bytes = Buffer.from(base64, "base64");
        const img = input.representativeSignature.includes("image/png")
          ? await doc.embedPng(bytes)
          : await doc.embedJpg(bytes);
        const scale = Math.min(sigBoxW / img.width, 50 / img.height, 1);
        page.drawImage(img, {
          x: sigX,
          y: repY - 60,
          width: img.width * scale,
          height: img.height * scale,
        });
      } catch {
        page.drawText("[representative drawn signature]", {
          x: sigX,
          y: repY - 30,
          size: 9,
          font: helvItalic,
          color: COLORS.inkMute,
        });
      }
    } else {
      page.drawText(`/s/ ${input.representativeSignature}`, {
        x: sigX,
        y: repY - 30,
        size: 14,
        font: helvItalic,
        color: COLORS.ink,
      });
    }
  }
}
