// [help-guides 2026-06-21] Per-guide PDF generator for the Help & Guides center.
// Renders a single how-to guide (title + summary + numbered steps, each a
// screenshot + caption) as a downloadable PDF, in the requested locale. Reuses
// the codebase's pdf-lib approach (see pdf-gen.ts): pure Node, no Chromium, so
// it streams straight out of an Express handler on Railway.
//
// The caller (routes/guides.ts) localizes captions and loads each step's
// screenshot bytes from disk; this module is pure layout + embedding. Missing
// images degrade to a labelled placeholder box rather than failing the download,
// so the PDF works even before the real screenshots are committed.
//
// Plus Jakarta Sans can't be embedded by pdf-lib without shipping a font file,
// so we use Helvetica (bundled) — same trade-off the certificates/handbook PDFs
// make. Colors mirror the Qleno brand.
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";

const INK = rgb(0.102, 0.098, 0.09);   // #1A1917
const MUTE = rgb(0.341, 0.329, 0.306); // #57544E
const LINE = rgb(0.898, 0.886, 0.863); // #E5E2DC
const NAVY = rgb(0.039, 0.055, 0.102); // #0A0E1A
const WHITE = rgb(1, 1, 1);

export interface GuidePdfStep {
  order: number;
  /** Caption already resolved to the requested locale. */
  caption: string;
  /** Screenshot bytes, or null when the asset is missing. */
  image: Buffer | null;
  /** Image format, used to pick the right embed call. */
  imageFormat: "png" | "jpg" | null;
}

export interface GuidePdfInput {
  /** Title already resolved to the requested locale. */
  title: string;
  /** Summary already resolved to the requested locale (may be empty). */
  summary: string;
  locale: "en" | "es";
  steps: GuidePdfStep[];
}

// Greedy word-wrap to a max width at a given font/size.
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export async function generateGuidePdf(input: GuidePdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const PW = 612, PH = 792;            // US Letter portrait @ 72dpi
  const margin = 54;
  const contentW = PW - margin * 2;
  const stepIndent = 30;               // room for the numbered bullet
  const lineH = 16;

  let page = doc.addPage([PW, PH]);
  let y = PH - margin;

  const newPage = () => {
    page = doc.addPage([PW, PH]);
    y = PH - margin;
  };
  const ensure = (space: number) => {
    if (y - space < margin) newPage();
  };

  // ── Title ──
  for (const ln of wrapText(input.title, helvBold, 22, contentW)) {
    ensure(28);
    page.drawText(ln, { x: margin, y: y - 22, size: 22, font: helvBold, color: INK });
    y -= 28;
  }
  y -= 4;

  // ── Summary ──
  if (input.summary) {
    for (const ln of wrapText(input.summary, helv, 12, contentW)) {
      ensure(lineH);
      page.drawText(ln, { x: margin, y: y - 12, size: 12, font: helv, color: MUTE });
      y -= lineH;
    }
  }
  y -= 8;
  page.drawLine({ start: { x: margin, y }, end: { x: PW - margin, y }, thickness: 1, color: LINE });
  y -= 22;

  // ── Steps ──
  const capW = contentW - stepIndent;
  for (const step of input.steps) {
    const capLines = wrapText(step.caption, helv, 12, capW);
    const capBlockH = Math.max(22, capLines.length * lineH);

    // Keep the bullet + caption together on a page.
    ensure(capBlockH + 8);

    // Numbered bullet.
    const bulletR = 11;
    const bulletCx = margin + bulletR;
    const bulletCy = y - bulletR;
    page.drawCircle({ x: bulletCx, y: bulletCy, size: bulletR, color: NAVY });
    const num = String(step.order);
    const numW = helvBold.widthOfTextAtSize(num, 11);
    page.drawText(num, {
      x: bulletCx - numW / 2,
      y: bulletCy - 4,
      size: 11,
      font: helvBold,
      color: WHITE,
    });

    // Caption.
    let capY = y;
    for (const ln of capLines) {
      page.drawText(ln, { x: margin + stepIndent, y: capY - 12, size: 12, font: helv, color: INK });
      capY -= lineH;
    }
    y -= capBlockH + 10;

    // Screenshot (or placeholder). Phone caps are portrait, so cap the drawn
    // width so they read like a phone on the page rather than ballooning.
    const maxW = Math.min(280, contentW - stepIndent);
    const imgX = margin + stepIndent;
    let drew = false;
    if (step.image && step.imageFormat) {
      try {
        const img = step.imageFormat === "png"
          ? await doc.embedPng(step.image)
          : await doc.embedJpg(step.image);
        const scale = Math.min(maxW / img.width, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        ensure(h + 16);
        page.drawImage(img, { x: imgX, y: y - h, width: w, height: h });
        y -= h + 18;
        drew = true;
      } catch {
        // fall through to placeholder
      }
    }
    if (!drew) {
      const phH = 150;
      ensure(phH + 16);
      page.drawRectangle({
        x: imgX, y: y - phH, width: maxW, height: phH,
        borderColor: LINE, borderWidth: 1, color: rgb(0.969, 0.965, 0.953), // #F7F6F3
      });
      const ph = input.locale === "es" ? "Captura pendiente" : "Screenshot coming soon";
      const phW = helv.widthOfTextAtSize(ph, 11);
      page.drawText(ph, {
        x: imgX + (maxW - phW) / 2,
        y: y - phH / 2 - 4,
        size: 11,
        font: helv,
        color: rgb(0.62, 0.61, 0.58),
      });
      y -= phH + 18;
    }
  }

  return doc.save();
}
