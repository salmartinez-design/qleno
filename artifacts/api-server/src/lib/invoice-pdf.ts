// [invoice-pdf] Renders an invoice as a branded PDF so the office can view /
// download exactly what the client was billed. Built with pdfkit (Railway has
// no Chromium, so HTML->PDF is avoided). Returns a Buffer.
//
// [invoice-pdf-parity 2026-07-07] The PDF now mirrors the web invoice
// (invoice-detail.tsx) one-for-one — same masthead (logo + business identity
// left, INVOICE / No. / status right), mint rule, Qty/Rate/Amount columns,
// service blurb, and the per-tenant footer block (footer message, payment
// instructions, payment terms, guarantee, terms, company line). A client
// invoice must look the same on screen, in the PDF, and in print — one look.
// Typical invoices are laid out to fit ONE page; the supplementary footer
// paragraphs are dropped (never split) if a long invoice leaves no room.
import PDFDocument from "pdfkit";

const MINT = "#00C9A0";
const INK = "#1A1917";
const BODY = "#4B4A47";
const MUTE = "#6B7280";
const FAINT = "#9E9B94";
const BORDER = "#EEECE7";

// Mirror of SERVICE_INFO in invoice-detail.tsx — the friendly sub-description
// under the first line item. Keep the two maps in sync.
const SERVICE_INFO: Record<string, string> = {
  "deep clean": "Detailed top-to-bottom service: baseboards, inside cabinets, appliance exteriors, and full kitchen and bath detail.",
  "deep clean or move in/out": "Detailed top-to-bottom move-ready service: baseboards, inside cabinets and appliances, full detail.",
  "standard clean": "Full maintenance cleaning of all living areas, kitchen, and bathrooms.",
  "recurring standard clean": "Recurring maintenance cleaning of all living areas, kitchen, and bathrooms.",
  "move in": "Complete pre-occupancy detail clean of an empty home.",
  "move out": "Move-out detail clean to turnover-ready condition.",
  "move in/out": "Complete move in / move out detail clean.",
  "common areas": "Lobbies, hallways, elevators, and shared building spaces.",
  "carpet cleaning": "Hot-water extraction carpet cleaning.",
  "ppm turnover": "Full unit turnover clean between residents.",
  "ppm common areas": "Scheduled common-area maintenance service.",
  "office cleaning": "Commercial workspace cleaning service.",
};
const svcBlurb = (desc: string | null) =>
  SERVICE_INFO[(desc || "").toLowerCase().replace(/_/g, " ").trim()] || "";

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
  // [invoice-pdf-parity] Per-tenant branding — same company columns the web
  // invoice reads, with the same fallbacks applied by the caller.
  tagline?: string | null;
  businessAddress?: string | null;
  contactLine?: string | null;
  footerMessage?: string | null;
  paymentInstructions?: string | null;
  guaranteeText?: string | null;
  termsText?: string | null;
}

const money = (n: any) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d: string | null, style: "short" | "long" = "short") => {
  if (!d) return null;
  const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
  if (!y || !m || !day) return null;
  return new Date(y, m - 1, day).toLocaleDateString("en-US", { month: style === "long" ? "long" : "short", day: "numeric", year: "numeric" });
};
const cap = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "LETTER" });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = 40;
    const right = doc.page.width - 40;
    const width = right - left;
    const maxY = doc.page.height - 40;

    // ── Masthead: logo + business identity left, INVOICE / No. / status right ──
    let y = 40;
    let identX = left;
    if (data.logo) {
      try {
        doc.image(data.logo, left, y, { fit: [110, 52] });
        identX = left + 124;
      } catch { identX = left; }
    }
    doc.fillColor(INK).fontSize(15).font("Helvetica-Bold").text(data.companyName, identX, y, { width: width - 320 });
    let iy = doc.y + 2;
    for (const line of [data.tagline, data.businessAddress, data.contactLine]) {
      if (!line) continue;
      doc.fillColor(FAINT).fontSize(9.5).font("Helvetica").text(line, identX, iy, { width: width - 320 });
      iy = doc.y + 2;
    }
    doc.fillColor(INK).fontSize(20).font("Helvetica-Bold").text("INVOICE", right - 220, y + 2, { width: 220, align: "right", characterSpacing: 2 });
    // "No." muted + number bold, right-aligned — positioned manually because
    // pdfkit's continued+align:right double-draws the trailing segment.
    const numStr = data.invoiceNumber || "—";
    doc.font("Helvetica-Bold").fontSize(11);
    const numW = doc.widthOfString(numStr);
    doc.fillColor(INK).text(numStr, right - numW, y + 30, { lineBreak: false });
    doc.font("Helvetica").fillColor(MUTE);
    doc.text("No. ", right - numW - doc.widthOfString("No. "), y + 30, { lineBreak: false });
    const statusLabel = data.paid ? "PAID" : (data.status || "").toUpperCase();
    if (statusLabel) {
      const sw = doc.widthOfString(statusLabel) + 16;
      const statusColor = data.paid ? "#166534" : statusLabel === "OVERDUE" ? "#991B1B" : "#92400E";
      const statusBg = data.paid ? "#DCFCE7" : statusLabel === "OVERDUE" ? "#FEE2E2" : "#FEF3C7";
      doc.roundedRect(right - sw, y + 48, sw, 18, 9).fill(statusBg);
      doc.fillColor(statusColor).fontSize(9).font("Helvetica-Bold").text(statusLabel, right - sw, y + 53, { width: sw, align: "center" });
    }
    y = Math.max(iy, y + 72) + 8;

    // Mint rule — same 3px brand line as the web card.
    doc.rect(left, y, width, 3).fill(MINT);
    y += 18;

    // ── Bill to (left) + Issued / Service / Due (right) ──
    doc.fillColor(FAINT).fontSize(9).font("Helvetica-Bold").text("BILL TO", left, y, { characterSpacing: 0.8 });
    let by = doc.y + 4;
    if (data.billToName) { doc.fillColor(INK).fontSize(12).font("Helvetica-Bold").text(data.billToName, left, by, { width: width - 250 }); by = doc.y + 2; }
    for (const line of [data.billToAddress, data.billToPhone, data.billToEmail]) {
      if (!line) continue;
      doc.fillColor(BODY).fontSize(10).font("Helvetica").text(line, left, by, { width: width - 250 });
      by = doc.y + 2;
    }
    let dy = y + 1;
    const dateRow = (label: string, val: string | null) => {
      doc.fillColor(FAINT).fontSize(10).font("Helvetica").text(`${label} `, right - 220, dy, { width: 140, align: "right" });
      doc.fillColor(BODY).fontSize(10).font("Helvetica").text(val || "—", right - 80, dy, { width: 80, align: "right" });
      dy += 15;
    };
    dateRow("Issued", fmtDate(data.issuedDate));
    dateRow("Service", fmtDate(data.serviceDate));
    dateRow("Due", fmtDate(data.dueDate) || "On receipt");
    y = Math.max(by, dy) + 14;

    // ── Line items: Description | Qty | Rate | Amount (same columns as web) ──
    const qtyX = right - 210, rateX = right - 140, amtX = right - 80;
    const tableHeader = () => {
      doc.fillColor(FAINT).fontSize(8.5).font("Helvetica-Bold");
      doc.text("DESCRIPTION", left, y, { characterSpacing: 0.6 });
      doc.text("QTY", qtyX, y, { width: 40, align: "right", characterSpacing: 0.6 });
      doc.text("RATE", rateX, y, { width: 55, align: "right", characterSpacing: 0.6 });
      doc.text("AMOUNT", amtX, y, { width: 80, align: "right", characterSpacing: 0.6 });
      y += 14;
      doc.moveTo(left, y).lineTo(right, y).strokeColor(BORDER).lineWidth(1).stroke();
      y += 10;
    };
    tableHeader();
    const items = Array.isArray(data.items) ? data.items : [];
    items.forEach((it, i) => {
      // Long invoices (merged account invoices) paginate cleanly with a fresh
      // table header — never cut a row across the page edge.
      if (y > maxY - 60) {
        doc.addPage();
        y = 40;
        tableHeader();
      }
      const rowY = y;
      doc.fillColor(INK).fontSize(10.5).font("Helvetica-Bold").text(cap(it.description || "Service"), left, y, { width: width - 260 });
      y = doc.y;
      const blurb = i === 0 ? svcBlurb(it.description) : "";
      if (blurb) {
        doc.fillColor(FAINT).fontSize(9).font("Helvetica").text(blurb, left, y + 1, { width: width - 260 });
        y = doc.y;
      }
      doc.fillColor(MUTE).fontSize(10.5).font("Helvetica").text(String(Number(it.quantity ?? 1)), qtyX, rowY, { width: 40, align: "right" });
      doc.text(money(it.unit_price), rateX, rowY, { width: 55, align: "right" });
      doc.fillColor(INK).font("Helvetica-Bold").text(money(it.total), amtX, rowY, { width: 80, align: "right" });
      y += 7;
      doc.moveTo(left, y).lineTo(right, y).strokeColor("#F0EDE8").lineWidth(1).stroke();
      y += 9;
    });

    // ── Totals (right-aligned, matching the web tfoot) ──
    if (Number(data.tips) > 0) {
      doc.fillColor(MUTE).fontSize(10.5).font("Helvetica").text("Tips", rateX - 60, y, { width: 115, align: "right" });
      doc.fillColor(INK).font("Helvetica-Bold").text(money(data.tips), amtX, y, { width: 80, align: "right" });
      y += 18;
    }
    doc.moveTo(left, y).lineTo(right, y).strokeColor(INK).lineWidth(1.5).stroke();
    y += 10;
    doc.fillColor(INK).fontSize(12).font("Helvetica-Bold").text("Total due", rateX - 90, y + 3, { width: 145, align: "right" });
    doc.fillColor(INK).fontSize(17).font("Helvetica-Bold").text(money(data.total), amtX - 40, y, { width: 120, align: "right" });
    y += 34;

    // ── Footer block — identical content + order to the web invoice. Each
    // paragraph is skipped (never split onto page 2) if space runs out.
    const para = (text: string | null | undefined, size: number, color: string, bold = false, gap = 6) => {
      if (!text) return;
      doc.fontSize(size).font(bold ? "Helvetica-Bold" : "Helvetica");
      const h = doc.heightOfString(text, { width, lineGap: 1.5 });
      if (y + h > maxY) return;
      doc.fillColor(color).text(text, left, y, { width, lineGap: 1.5 });
      y += h + gap;
    };
    doc.moveTo(left, y).lineTo(right, y).strokeColor(BORDER).lineWidth(1).stroke();
    y += 12;
    para(data.footerMessage, 10.5, INK, true);
    para(data.paymentInstructions, 9.5, MUTE);
    para(`Payment terms: ${data.dueDate ? `due by ${fmtDate(data.dueDate, "long")}` : "due on receipt"}.`, 9.5, MUTE);
    if (data.guaranteeText) y += 4;
    para(data.guaranteeText, 8.5, FAINT);
    para(data.termsText, 8.5, FAINT);
    para([data.companyName, data.businessAddress].filter(Boolean).join(", "), 8.5, FAINT);

    doc.end();
  });
}
