import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

interface AgreementPdfData {
  submissionId: number;
  formName: string;
  companyName: string;
  termsBody: string;
  responses: Record<string, string>;
  signatureName: string;
  signedAt: string;
  ipAddress: string;
  contentHash: string;
  /** Absolute URL to the tenant's logo. Optional: the PDF still renders without it. */
  logoUrl?: string | null;
  /** companies.brand_color. Optional: falls back to the Qleno accent. */
  brandColor?: string | null;
  /** Printed in the footer so the customer never has to hunt for a number. */
  companyPhone?: string | null;
  companyEmail?: string | null;
}

// [agreement-pdf-logo 2026-08-19] Sal asked for the logo on the copy the
// customer keeps. Fetched rather than bundled because it is the tenant's own
// mark from companies.logo_url, and fail-soft on purpose: a slow or broken
// image must never be the reason a signed agreement fails to generate, so a
// miss just falls back to the company name set in type.
async function fetchLogo(url?: string | null): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const type = String(r.headers.get("content-type") || "").toLowerCase();
    // PDFKit only decodes JPEG and PNG. Anything else (svg, webp) would throw
    // mid-render, which is exactly the failure this guard exists to avoid.
    if (!/jpeg|jpg|png/.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 0 && buf.length < 4_000_000 ? buf : null;
  } catch {
    return null;
  }
}

// A tenant colour we are about to hand to PDFKit. An unparseable value throws
// mid-render and loses the whole document, so anything that is not a plain hex
// falls back to the house accent rather than taking the agreement down.
function safeHex(v: string | null | undefined, fallback: string): string {
  const s = String(v || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : fallback;
}

const INK = "#1A1917";
const MUTE = "#6B6860";
const BORDER = "#E5E2DC";
const PAPER = "#F7F6F3";
const NAVY = "#0A0E1A";
const MINT = "#00C9A0";

const M = 60; // page margin
const TOP = 108; // first baseline under the letterhead
const BOTTOM = 74; // reserved for the footer band

/**
 * One parsed line of the agreement body.
 *
 * The body is authored as plain text in form_templates.terms_body, and the
 * shape it is authored in carries real structure: numbered sections, colon
 * field lines, bare sub-headings. Reading that structure back out is what
 * separates a contract from a wall of text - the previous renderer dropped
 * every numbered heading into an identical grey bar and set every other line
 * at one size, which is exactly why the result read as a template.
 */
type Block =
  | { kind: "title"; text: string }
  | { kind: "section"; num: string; text: string }
  | { kind: "subhead"; text: string }
  | { kind: "field"; label: string; value: string }
  | { kind: "body"; text: string };

export function parseAgreementBody(raw: string): Block[] {
  const lines = String(raw || "").split("\n");
  const out: Block[] = [];
  let sawTitle = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // The document title: the first line, set in caps by every template we ship.
    if (!sawTitle && line === line.toUpperCase() && /[A-Z]/.test(line) && line.length < 80 && !/^\d/.test(line)) {
      out.push({ kind: "title", text: line });
      sawTitle = true;
      continue;
    }

    // "7. ACCESS AND LOCKOUTS" - a numbered section heading.
    const sec = line.match(/^(\d{1,2})\.\s+(.{2,70})$/);
    if (sec && sec[2] === sec[2].toUpperCase() && /[A-Z]/.test(sec[2])) {
      out.push({ kind: "section", num: sec[1], text: sec[2].trim() });
      continue;
    }

    // "Rate per visit: $240.00" - a field row. Bounded on both sides so a
    // sentence with a mid-clause colon is not mistaken for one: the label has
    // to be short and title-cased, and what follows has to be short enough to
    // sit on one line in the value column.
    const fld = line.match(/^([A-Z][A-Za-z0-9 ()&/'.\-]{1,34}):\s*(.*)$/);
    if (fld && fld[2].length <= 90 && !/[.!?]\s/.test(fld[2])) {
      out.push({ kind: "field", label: fld[1].trim(), value: fld[2].trim() });
      continue;
    }

    // "Scope of Work" - a bare sub-heading inside a section. Short, no
    // sentence punctuation, and followed by something rather than trailing.
    if (line.length <= 44 && !/[.,;:!?]$/.test(line) && /^[A-Z]/.test(line) && line.split(" ").length <= 6) {
      out.push({ kind: "subhead", text: line });
      continue;
    }

    out.push({ kind: "body", text: line });
  }

  return out;
}

// [agreement-pdf 2026-08-19] The buffer renderer is the real generator. The
// file-writing wrapper at the bottom stays for the existing /api/pdfs link,
// but that disk is ephemeral on Railway (it is gone on the next deploy), so
// anything that has to survive - the emailed copy, the customer re-opening
// their agreement months later - renders from the database into this buffer.
//
// [agreement-pdf-design 2026-08-20] Rebuilt the body. Sal's read of the old
// one was "generic, like an etsy template", and he was right about why: every
// heading was the same grey bar, every field line ran as prose, the signature
// was four stacked label/value pairs, and the brand colour was hardcoded to
// #5B9BD5 - the blue Phes retired in July - so the PDF and the signing page
// the customer had just been looking at were two different colours. This now
// reads the structure back out of the text (see parseAgreementBody) and sets
// each kind of line differently, and every colour comes from the company row.
export async function renderAgreementPdf(data: AgreementPdfData): Promise<Buffer> {
  const logo = await fetchLogo(data.logoUrl);
  const brand = safeHex(data.brandColor, MINT);

  return new Promise((resolve, reject) => {
    // bufferPages keeps every page addressable so the footer loop below can
    // switchToPage() them. Without it PDFKit flushes each page on addPage and
    // switchToPage(0) throws the moment an agreement runs past one page.
    const doc = new PDFDocument({ margin: M, size: "LETTER", bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width - M * 2;
    const PAGE_H = doc.page.height;
    let y = TOP;

    // PDFKit auto-paginates text but NOT vector ops: a rect or a rule drawn
    // past the bottom is simply lost off-canvas. So every block measures
    // itself first and calls ensure() before it draws anything.
    const runningHead = () => {
      doc.fillColor(MUTE).fontSize(7.5).font("Helvetica")
        .text(data.companyName.toUpperCase(), M, 40, { width: W / 2, characterSpacing: 0.6 });
      doc.fillColor(MUTE).fontSize(7.5).font("Helvetica")
        .text(data.formName, M + W / 2, 40, { width: W / 2, align: "right" });
      doc.rect(M, 54, W, 1).fill(BORDER);
      y = 78;
    };

    const ensure = (h: number) => {
      if (y + h <= PAGE_H - BOTTOM) return;
      doc.addPage();
      runningHead();
    };

    // ---- Letterhead ------------------------------------------------------
    let textLeft = M;
    if (logo) {
      try {
        doc.image(logo, M, 24, { fit: [112, 46] });
        textLeft = M + 128;
      } catch {
        // Corrupt or unsupported bytes. Fall through to the name in type.
      }
    }
    doc.fillColor(INK).fontSize(logo ? 13 : 19).font("Helvetica-Bold")
      .text(data.companyName, textLeft, logo ? 30 : 28, { width: 300 });
    doc.fillColor(MUTE).fontSize(8).font("Helvetica")
      .text("SERVICE AGREEMENT", textLeft, logo ? 48 : 52, { width: 300, characterSpacing: 1.1 });

    doc.fillColor(MUTE).fontSize(7.5).font("Helvetica")
      .text("EXECUTED", doc.page.width - M - 200, 30, { width: 200, align: "right", characterSpacing: 1 });
    doc.fillColor(INK).fontSize(9.5).font("Helvetica-Bold")
      .text(data.signedAt || "Pending", doc.page.width - M - 200, 43, { width: 200, align: "right" });

    doc.rect(M, 80, W, 3).fill(brand);

    // ---- Body blocks -----------------------------------------------------
    const title = (text: string) => {
      const h = doc.heightOfString(text, { width: W, characterSpacing: 0.8 });
      ensure(h + 34);
      doc.fillColor(INK).fontSize(15).font("Helvetica-Bold")
        .text(text, M, y, { width: W, characterSpacing: 0.8 });
      y += h + 10;
      doc.rect(M, y, 46, 2).fill(brand);
      y += 24;
    };

    // The number gets the brand colour and its own column, so a reader can
    // find "Section 10" by scanning the left edge instead of reading for it.
    const section = (num: string, text: string) => {
      const label = text.replace(/\s+/g, " ");
      const h = doc.heightOfString(label, { width: W - 34, characterSpacing: 0.7 });
      ensure(h + 30);
      y += 8;
      doc.fillColor(brand).fontSize(11).font("Helvetica-Bold").text(num, M, y, { width: 26 });
      doc.fillColor(INK).fontSize(10.5).font("Helvetica-Bold")
        .text(label, M + 26, y, { width: W - 26, characterSpacing: 0.7 });
      y += h + 7;
      doc.rect(M, y, W, 0.8).fill(BORDER);
      y += 12;
    };

    const subhead = (text: string) => {
      ensure(24);
      y += 4;
      doc.fillColor(INK).fontSize(9.5).font("Helvetica-Bold").text(text, M, y, { width: W });
      y += 15;
    };

    // Label in its own left column, value aligned against it, hairline under
    // each row. This is the block that used to run as prose, which is how a
    // rate and an address ended up looking like the middle of a sentence.
    const LABEL_W = 132;
    const field = (label: string, value: string) => {
      const shown = value || "Not provided";
      const vw = W - LABEL_W - 12;
      const h = Math.max(12, doc.heightOfString(shown, { width: vw }));
      ensure(h + 12);
      doc.fillColor(MUTE).fontSize(7.5).font("Helvetica-Bold")
        .text(label.toUpperCase(), M, y + 1, { width: LABEL_W, characterSpacing: 0.5 });
      doc.fillColor(value ? INK : MUTE).fontSize(9.5).font("Helvetica")
        .text(shown, M + LABEL_W + 12, y, { width: vw });
      y += h + 6;
      doc.rect(M, y, W, 0.5).fill(BORDER);
      y += 6;
    };

    const body = (text: string) => {
      const h = doc.heightOfString(text, { width: W, lineGap: 2.6 });
      ensure(h + 12);
      doc.fillColor(INK).fontSize(9.5).font("Helvetica").text(text, M, y, { width: W, lineGap: 2.6 });
      y += h + 10;
    };

    const clientResponses = Object.entries(data.responses || {}).filter(([, v]) => v);
    if (clientResponses.length > 0) {
      section("", "CLIENT RESPONSES");
      for (const [k, v] of clientResponses) {
        field(k.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()), String(v));
      }
      y += 8;
    }

    for (const b of parseAgreementBody(data.termsBody)) {
      if (b.kind === "title") title(b.text);
      else if (b.kind === "section") section(b.num, b.text);
      else if (b.kind === "subhead") subhead(b.text);
      else if (b.kind === "field") field(b.label, b.value);
      else body(b.text);
    }

    // ---- Signature panel -------------------------------------------------
    // Kept whole: a signature block split across a page break is the one thing
    // on this document that has to be readable at a glance months later.
    const PANEL_H = 172;
    ensure(PANEL_H + 20);
    y += 14;

    const px = M;
    const pw = W;
    doc.roundedRect(px, y, pw, PANEL_H, 6).fillAndStroke(PAPER, BORDER);
    doc.rect(px, y, 3, PANEL_H).fill(brand);

    let sy = y + 20;
    doc.fillColor(MUTE).fontSize(7.5).font("Helvetica-Bold")
      .text("ELECTRONIC SIGNATURE", px + 24, sy, { width: pw - 48, characterSpacing: 1.1 });
    sy += 18;

    // Set in an italic serif so it reads as a signature rather than as one
    // more field. It is a typed name either way; the form should say so.
    doc.fillColor(INK).fontSize(21).font("Times-Italic")
      .text(data.signatureName || "", px + 24, sy, { width: pw - 48 });
    sy += 30;
    doc.rect(px + 24, sy, pw - 48, 0.8).fill(BORDER);
    sy += 8;
    doc.fillColor(MUTE).fontSize(7).font("Helvetica")
      .text("SIGNED ELECTRONICALLY BY THE CLIENT", px + 24, sy, { width: pw - 48, characterSpacing: 0.5 });
    sy += 20;

    const colW = (pw - 48) / 2;
    const audit: [string, string][] = [
      ["Date and time", data.signedAt || ""],
      ["IP address", data.ipAddress || ""],
      ["Agreement", `#${data.submissionId}`],
      ["Document hash (SHA-256)", (data.contentHash || "").slice(0, 32)],
    ];
    audit.forEach(([label, value], i) => {
      const cx = px + 24 + (i % 2) * colW;
      const cy = sy + Math.floor(i / 2) * 30;
      doc.fillColor(MUTE).fontSize(6.5).font("Helvetica-Bold")
        .text(label.toUpperCase(), cx, cy, { width: colW - 14, characterSpacing: 0.5 });
      doc.fillColor(INK).fontSize(8.5).font("Helvetica")
        .text(value, cx, cy + 10, { width: colW - 14, lineBreak: false });
    });

    y += PANEL_H + 14;

    const esign =
      "This document constitutes a legally binding electronic signature under the Electronic Signatures in Global and National Commerce Act (E-SIGN) and the Uniform Electronic Transactions Act (UETA).";
    const eh = doc.heightOfString(esign, { width: W, lineGap: 1.5 });
    ensure(eh + 6);
    doc.fillColor(MUTE).fontSize(7.5).font("Helvetica")
      .text(esign, M, y, { width: W, lineGap: 1.5 });

    // ---- Footer on every page -------------------------------------------
    const contact = [data.companyPhone, data.companyEmail].filter(Boolean).join("   |   ");
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Without this the footer sits inside the bottom margin, and PDFKit
      // answers a text() there by starting a fresh page instead of drawing:
      // the rules appeared and the words did not. Vector ops ignore margins,
      // which is exactly why the bug looked like a font problem.
      doc.page.margins.bottom = 0;
      const fy = PAGE_H - 52;
      doc.rect(M, fy, W, 0.8).fill(BORDER);
      doc.fillColor(NAVY).fontSize(8).font("Helvetica-Bold")
        .text(data.companyName, M, fy + 12, { width: W * 0.6, lineBreak: false });
      if (contact) {
        doc.fillColor(MUTE).fontSize(7.5).font("Helvetica")
          .text(contact, M, fy + 24, { width: W * 0.6, lineBreak: false });
      }
      doc.fillColor(MUTE).fontSize(7.5).font("Helvetica")
        .text(`Page ${i - range.start + 1} of ${range.count}`, M + W * 0.6, fy + 12, {
          width: W * 0.4, align: "right",
        });
    }

    doc.flushPages();
    doc.end();
  });
}

// Legacy path: writes the rendered PDF to the ephemeral disk and hands back the
// /api/pdfs URL the sign page has always linked. Callers that need a link the
// customer can still open after a deploy should use GET /api/sign/:token/agreement.pdf.
export async function generateAgreementPdf(data: AgreementPdfData): Promise<string> {
  const buffer = await renderAgreementPdf(data);
  const pdfsDir = process.env.PDFS_DIR || path.resolve(process.cwd(), "pdfs");
  if (!fs.existsSync(pdfsDir)) {
    fs.mkdirSync(pdfsDir, { recursive: true });
  }
  const filename = `agreement-${data.submissionId}-${Date.now()}.pdf`;
  fs.writeFileSync(path.join(pdfsDir, filename), buffer);
  return `/api/pdfs/${filename}`;
}
