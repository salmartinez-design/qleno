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
}

// [agreement-pdf 2026-08-19] The buffer renderer is the real generator. The
// file-writing wrapper at the bottom stays for the existing /api/pdfs link,
// but that disk is ephemeral on Railway (it is gone on the next deploy), so
// anything that has to survive - the emailed copy, the customer re-opening
// their agreement months later - renders from the database into this buffer.
export async function renderAgreementPdf(data: AgreementPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // bufferPages keeps every page addressable so the footer loop below can
    // switchToPage() them. Without it PDFKit flushes each page on addPage and
    // switchToPage(0) throws the moment an agreement runs past one page.
    const doc = new PDFDocument({ margin: 60, size: "LETTER", bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const brand = "#5B9BD5";
    const dark = "#1A1917";
    const gray = "#6B7280";
    const light = "#E5E2DC";
    const pageWidth = doc.page.width - 120;

    doc.rect(0, 0, doc.page.width, 72).fill(brand);
    doc.fillColor("#FFFFFF").fontSize(20).font("Helvetica-Bold")
      .text(data.companyName, 60, 20, { width: doc.page.width - 120 });
    doc.fontSize(10).font("Helvetica")
      .text(data.formName, 60, 46, { width: doc.page.width - 120 });
    doc.fillColor(gray).fontSize(9).font("Helvetica")
      .text(`Signed: ${data.signedAt}`, doc.page.width - 200, 46, { width: 140, align: "right" });

    let y = 95;

    const sectionHeader = (title: string) => {
      doc.rect(60, y, pageWidth, 22).fill("#F7F6F3");
      doc.fillColor(brand).fontSize(10).font("Helvetica-Bold")
        .text(title.toUpperCase(), 68, y + 6, { width: pageWidth - 16 });
      y += 30;
    };

    const paragraph = (text: string) => {
      if (!text) return;
      doc.fillColor(dark).fontSize(9.5).font("Helvetica")
        .text(text, 60, y, { width: pageWidth, lineGap: 2 });
      y += doc.heightOfString(text, { width: pageWidth, lineGap: 2 }) + 12;
    };

    const addPageIfNeeded = (spaceNeeded = 80) => {
      if (y + spaceNeeded > doc.page.height - 80) {
        doc.addPage();
        y = 60;
      }
    };

    const clientResponses = Object.entries(data.responses);
    if (clientResponses.length > 0) {
      sectionHeader("Client Information");
      clientResponses.forEach(([key, value]) => {
        if (!value) return;
        const label = key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        doc.fillColor(gray).fontSize(8).font("Helvetica-Bold").text(label.toUpperCase(), 60, y);
        doc.fillColor(dark).fontSize(10).font("Helvetica").text(String(value), 220, y - 1);
        y += 20;
      });
      y += 10;
    }

    if (data.termsBody) {
      const sections = data.termsBody.split(/\n\n+/);
      sections.forEach((section) => {
        const lines = section.trim().split("\n");
        const possibleHeader = lines[0];
        const isHeader = possibleHeader === possibleHeader.toUpperCase() && possibleHeader.length < 80 && lines.length > 1;

        addPageIfNeeded(60);

        if (isHeader) {
          sectionHeader(possibleHeader);
          const rest = lines.slice(1).join("\n").trim();
          if (rest) paragraph(rest);
        } else {
          paragraph(section.trim());
        }
      });
    }

    addPageIfNeeded(120);
    doc.moveTo(60, y).lineTo(doc.page.width - 60, y).strokeColor(light).stroke();
    y += 20;

    sectionHeader("Electronic Signature Record");

    doc.fillColor(dark).fontSize(14).font("Helvetica-Bold")
      .text(data.signatureName, 60, y, { width: pageWidth });
    y += 22;
    doc.fillColor(gray).fontSize(8).font("Helvetica")
      .text("TYPED NAME (ELECTRONIC SIGNATURE)", 60, y);
    y += 18;

    const sigFields: [string, string][] = [
      ["Signed By", data.signatureName],
      ["Date & Time", data.signedAt],
      ["IP Address", data.ipAddress],
      ["Document Hash (SHA-256)", data.contentHash],
    ];
    sigFields.forEach(([label, value]) => {
      doc.fillColor(gray).fontSize(8).font("Helvetica-Bold").text(label.toUpperCase(), 60, y);
      doc.fillColor(dark).fontSize(9).font("Helvetica").text(value, 220, y - 1, { width: pageWidth - 160 });
      y += 18;
    });

    y += 8;
    doc.fontSize(8).fillColor(gray).font("Helvetica")
      .text(
        "This document constitutes a legally binding electronic signature in accordance with the Electronic Signatures in Global and National Commerce Act (E-SIGN) and the Uniform Electronic Transactions Act (UETA).",
        60, y, { width: pageWidth, lineGap: 2 }
      );

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fillColor(gray).fontSize(7).font("Helvetica")
        .text(
          `${data.companyName} - ${data.formName} - Page ${i - range.start + 1} of ${range.count}`,
          60, doc.page.height - 30, { width: pageWidth, align: "center" }
        );
    }

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
