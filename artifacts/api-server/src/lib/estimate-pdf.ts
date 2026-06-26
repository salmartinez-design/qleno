// [estimate-pdf] Renders an estimate as a branded PDF so the office can preview
// exactly what the client receives (and download / re-send it). Built with
// pdfkit — Railway has no Chromium, so HTML->PDF is intentionally avoided,
// mirroring lib/pdf-gen.ts and lib/confirmation-pdf.ts. Returns a Buffer.
import PDFDocument from "pdfkit";

const NAVY = "#0A0E1A";
const MINT = "#00C9A0";
const INK = "#1A1917";
const MUTE = "#6B6860";
const BORDER = "#E5E2DC";

export interface EstimatePdfItem {
  name: string | null;
  pricing_type: string;
  frequency: string | null;
  quantity: string | number;
  unit_rate: string | number;
  amount: string | number;
}

export interface EstimatePdfData {
  companyName: string;
  estimateNumber: string | null;
  status: string;
  title: string | null;
  introNote: string | null;
  contactName: string | null;
  propertyName: string | null;
  serviceAddress: string | null;
  billingMode: string;
  flatPriceUnit: string | null;
  scopeNote: string | null;
  items: EstimatePdfItem[];
  subtotal: string | number;
  discount: string | number;
  total: string | number;
  terms: string | null;
  validUntil: string | null;
}

const money = (n: any) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const unitSuffix = (u: string | null) => (u && u !== "total" ? ` / ${u}` : "");
const fmtDate = (d: string | null) => {
  if (!d) return null;
  const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
  if (!y || !m || !day) return null;
  return new Date(y, m - 1, day).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
};

export function renderEstimatePdf(data: EstimatePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "LETTER" });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = 50;
    const right = doc.page.width - 50;
    const width = right - left;
    const isFlat = data.billingMode === "flat";

    // Header band
    doc.rect(0, 0, doc.page.width, 84).fill(NAVY);
    doc.fillColor("#FFFFFF").fontSize(20).font("Helvetica-Bold").text(data.companyName, left, 26, { width: width - 160 });
    doc.fontSize(10).font("Helvetica").fillColor("#9CA3AF").text("ESTIMATE", left, 54);
    doc.fillColor("#FFFFFF").fontSize(13).font("Helvetica-Bold")
      .text(data.estimateNumber || "", right - 160, 30, { width: 160, align: "right" });
    doc.fontSize(9).font("Helvetica").fillColor("#9CA3AF")
      .text(String(data.status || "").toUpperCase(), right - 160, 50, { width: 160, align: "right" });

    let y = 108;

    // Prepared for
    doc.fillColor(MUTE).fontSize(9).font("Helvetica-Bold").text("PREPARED FOR", left, y);
    y += 14;
    doc.fillColor(INK).fontSize(12).font("Helvetica-Bold").text(data.contactName || data.propertyName || "Client", left, y);
    y += 16;
    doc.fillColor(MUTE).fontSize(10).font("Helvetica");
    if (data.propertyName && data.contactName) { doc.text(data.propertyName, left, y); y += 13; }
    if (data.serviceAddress) { doc.text(data.serviceAddress, left, y, { width }); y += 13; }
    const issued = fmtDate(new Date().toISOString());
    const validUntil = fmtDate(data.validUntil);
    doc.text(`Issued ${issued}${validUntil ? `    Valid until ${validUntil}` : ""}`, left, y);
    y += 24;

    // Title + intro
    if (data.title) {
      doc.fillColor(INK).fontSize(15).font("Helvetica-Bold").text(data.title, left, y, { width });
      y = doc.y + 6;
    }
    if (data.introNote) {
      doc.fillColor("#374151").fontSize(10).font("Helvetica").text(data.introNote, left, y, { width, lineGap: 2 });
      y = doc.y + 14;
    }

    doc.moveTo(left, y).lineTo(right, y).strokeColor(BORDER).stroke();
    y += 16;

    if (isFlat) {
      // Scope paragraph (optional)
      if (data.scopeNote) {
        doc.fillColor("#374151").fontSize(10).font("Helvetica").text(data.scopeNote, left, y, { width, lineGap: 2 });
        y = doc.y + 14;
      }
      // What's included checklist (optional)
      const named = data.items.filter((it) => (it.name || "").trim());
      if (named.length) {
        doc.fillColor(MUTE).fontSize(9).font("Helvetica-Bold").text("WHAT'S INCLUDED", left, y);
        y += 16;
        for (const it of named) {
          doc.fillColor(MINT).fontSize(11).font("Helvetica-Bold").text("✓", left, y, { continued: false, width: 14 });
          const label = it.frequency ? `${it.name}  ·  ${it.frequency}` : `${it.name}`;
          doc.fillColor(INK).fontSize(10.5).font("Helvetica").text(label || "Service", left + 18, y, { width: width - 18 });
          y = doc.y + 6;
        }
        y += 6;
      }
    } else {
      // Itemized table
      for (const it of data.items) {
        const sub = [
          it.frequency,
          it.pricing_type === "hourly" ? `${Number(it.quantity).toFixed(1)} hrs × ${money(it.unit_rate)}/hr`
            : Number(it.quantity) !== 1 ? `${Number(it.quantity)} × ${money(it.unit_rate)}` : null,
        ].filter(Boolean).join("  ·  ");
        const startY = y;
        doc.fillColor(INK).fontSize(10.5).font("Helvetica-Bold").text(it.name || "Service", left, y, { width: width - 90 });
        y = doc.y;
        if (sub) { doc.fillColor(MUTE).fontSize(9).font("Helvetica").text(sub, left, y, { width: width - 90 }); y = doc.y; }
        doc.fillColor(INK).fontSize(10.5).font("Helvetica-Bold").text(money(it.amount), right - 90, startY, { width: 90, align: "right" });
        y += 8;
        doc.moveTo(left, y).lineTo(right, y).strokeColor("#F0EEE9").stroke();
        y += 8;
      }
    }

    // Totals
    y += 6;
    const labelX = right - 220, valX = right - 110;
    if (!isFlat) {
      doc.fillColor(MUTE).fontSize(10).font("Helvetica").text("Subtotal", labelX, y, { width: 110 });
      doc.fillColor(INK).text(money(data.subtotal), valX, y, { width: 110, align: "right" });
      y += 16;
    }
    if (Number(data.discount) > 0) {
      doc.fillColor("#047857").fontSize(10).font("Helvetica").text("Discount", labelX, y, { width: 110 });
      doc.text(`-${money(data.discount)}`, valX, y, { width: 110, align: "right" });
      y += 16;
    }
    doc.moveTo(labelX, y).lineTo(right, y).strokeColor(INK).lineWidth(1.2).stroke();
    y += 8;
    doc.fillColor(INK).fontSize(13).font("Helvetica-Bold").text("Total", labelX, y, { width: 110 });
    doc.fillColor(NAVY).fontSize(16).font("Helvetica-Bold")
      .text(`${money(data.total)}${isFlat ? unitSuffix(data.flatPriceUnit) : ""}`, valX - 60, y - 2, { width: 170, align: "right" });
    y += 30;

    // Terms
    if (data.terms) {
      doc.moveTo(left, y).lineTo(right, y).strokeColor(BORDER).lineWidth(1).stroke();
      y += 14;
      doc.fillColor(MUTE).fontSize(9).font("Helvetica-Bold").text("TERMS", left, y);
      y += 14;
      doc.fillColor("#374151").fontSize(9.5).font("Helvetica").text(data.terms, left, y, { width, lineGap: 2 });
    }

    doc.end();
  });
}
