// [invoice-pdf] Renders an invoice as a branded PDF so the office can view /
// download exactly what the client was billed. Built with pdfkit (Railway has
// no Chromium, so HTML->PDF is avoided), mirroring estimate-pdf.ts. Returns a
// Buffer. Style matches the estimate PDF for a consistent customer-facing look.
import PDFDocument from "pdfkit";

const NAVY = "#0A0E1A";
const MINT = "#00C9A0";
const INK = "#1A1917";
const MUTE = "#6B6860";
const BORDER = "#E5E2DC";

export interface InvoicePdfItem {
  description: string | null;
  quantity: string | number;
  unit_price: string | number;
  total: string | number;
}

export interface InvoicePdfData {
  companyName: string;
  logo?: Buffer | null;
  invoiceNumber: string | null;
  status: string;
  billToName: string | null;
  billToAddress: string | null;
  billToEmail: string | null;
  billToPhone: string | null;
  serviceDate: string | null;
  issuedDate: string | null;
  dueDate: string | null;
  items: InvoicePdfItem[];
  subtotal: string | number;
  tips: string | number;
  total: string | number;
  paid: boolean;
}

const money = (n: any) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d: string | null) => {
  if (!d) return null;
  const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
  if (!y || !m || !day) return null;
  return new Date(y, m - 1, day).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
};

export function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "LETTER" });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = 50;
    const right = doc.page.width - 50;
    const width = right - left;

    // Header band — logo chip left, INVOICE / number / status right.
    doc.rect(0, 0, doc.page.width, 84).fill(NAVY);
    let drewLogo = false;
    if (data.logo) {
      try {
        doc.roundedRect(left, 22, 156, 40, 6).fill("#FFFFFF");
        doc.image(data.logo, left + 10, 27, { fit: [136, 30] });
        drewLogo = true;
      } catch { drewLogo = false; }
    }
    if (!drewLogo) {
      doc.fillColor("#FFFFFF").fontSize(20).font("Helvetica-Bold").text(data.companyName || "Invoice", left, 32);
    }
    doc.fillColor("#FFFFFF").fontSize(20).font("Helvetica-Bold").text("INVOICE", right - 200, 24, { width: 200, align: "right" });
    const statusLabel = data.paid ? "PAID" : (data.status || "").toUpperCase();
    doc.fillColor(MINT).fontSize(10).font("Helvetica-Bold")
      .text(`${data.invoiceNumber ? `#${data.invoiceNumber}` : ""}${statusLabel ? `   ${statusLabel}` : ""}`, right - 200, 52, { width: 200, align: "right" });

    let y = 104;

    // Bill-to + dates row
    doc.fillColor(MUTE).fontSize(9).font("Helvetica-Bold").text("BILL TO", left, y);
    const datesX = right - 220;
    doc.fillColor(MUTE).fontSize(9).font("Helvetica-Bold").text("DETAILS", datesX, y, { width: 220, align: "right" });
    y += 14;
    const billStartY = y;
    if (data.billToName) { doc.fillColor(INK).fontSize(11).font("Helvetica-Bold").text(data.billToName, left, y, { width: width - 230 }); y = doc.y + 1; }
    if (data.billToAddress) { doc.fillColor("#374151").fontSize(10).font("Helvetica").text(data.billToAddress, left, y, { width: width - 230 }); y = doc.y + 1; }
    if (data.billToEmail) { doc.fillColor(MUTE).fontSize(9.5).font("Helvetica").text(data.billToEmail, left, y, { width: width - 230 }); y = doc.y + 1; }
    if (data.billToPhone) { doc.fillColor(MUTE).fontSize(9.5).font("Helvetica").text(data.billToPhone, left, y, { width: width - 230 }); y = doc.y + 1; }
    // Dates column (right-aligned)
    let dy = billStartY;
    const dateRow = (label: string, val: string | null) => {
      if (!val) return;
      doc.fillColor(MUTE).fontSize(9.5).font("Helvetica").text(`${label}  `, datesX, dy, { width: 130, align: "right" });
      doc.fillColor(INK).fontSize(9.5).font("Helvetica-Bold").text(val, datesX + 130, dy, { width: 90, align: "right" });
      dy += 15;
    };
    dateRow("Issued", fmtDate(data.issuedDate));
    dateRow("Service date", fmtDate(data.serviceDate));
    dateRow("Due", fmtDate(data.dueDate) || "Upon receipt");
    y = Math.max(y, dy) + 12;

    doc.moveTo(left, y).lineTo(right, y).strokeColor(BORDER).stroke();
    y += 16;

    // Line items table
    doc.fillColor(MUTE).fontSize(9).font("Helvetica-Bold").text("DESCRIPTION", left, y);
    doc.text("AMOUNT", right - 90, y, { width: 90, align: "right" });
    y += 16;
    doc.moveTo(left, y).lineTo(right, y).strokeColor("#F0EEE9").stroke();
    y += 10;
    const items = Array.isArray(data.items) ? data.items : [];
    for (const it of items) {
      const qty = Number(it.quantity);
      const sub = qty && qty !== 1 ? `${qty} × ${money(it.unit_price)}` : null;
      const startY = y;
      doc.fillColor(INK).fontSize(10.5).font("Helvetica-Bold").text(it.description || "Service", left, y, { width: width - 100 });
      y = doc.y;
      if (sub) { doc.fillColor(MUTE).fontSize(9).font("Helvetica").text(sub, left, y, { width: width - 100 }); y = doc.y; }
      doc.fillColor(INK).fontSize(10.5).font("Helvetica-Bold").text(money(it.total), right - 90, startY, { width: 90, align: "right" });
      y += 8;
      doc.moveTo(left, y).lineTo(right, y).strokeColor("#F0EEE9").stroke();
      y += 8;
    }

    // Totals
    y += 6;
    const labelX = right - 220, valX = right - 110;
    doc.fillColor(MUTE).fontSize(10).font("Helvetica").text("Subtotal", labelX, y, { width: 110 });
    doc.fillColor(INK).text(money(data.subtotal || data.total), valX, y, { width: 110, align: "right" });
    y += 16;
    if (Number(data.tips) > 0) {
      doc.fillColor(MUTE).fontSize(10).font("Helvetica").text("Tip", labelX, y, { width: 110 });
      doc.fillColor(INK).text(money(data.tips), valX, y, { width: 110, align: "right" });
      y += 16;
    }
    doc.moveTo(labelX, y).lineTo(right, y).strokeColor(INK).lineWidth(1.2).stroke();
    y += 8;
    doc.fillColor(INK).fontSize(13).font("Helvetica-Bold").text("Total", labelX, y, { width: 110 });
    doc.fillColor(NAVY).fontSize(16).font("Helvetica-Bold").text(money(data.total), valX - 60, y - 2, { width: 170, align: "right" });
    y += 34;

    // Paid stamp / pay note
    if (data.paid) {
      doc.fillColor("#047857").fontSize(11).font("Helvetica-Bold").text("Paid in full — thank you!", left, y);
    } else {
      doc.fillColor(MUTE).fontSize(9.5).font("Helvetica").text(`Please remit ${money(data.total)} by ${fmtDate(data.dueDate) || "the due date"}. Thank you for your business.`, left, y, { width });
    }

    doc.end();
  });
}
