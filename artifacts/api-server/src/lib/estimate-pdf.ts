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
  logo?: Buffer | null;
  companyPhone?: string | null;
  companyEmail?: string | null;
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
    const pageW = doc.page.width;
    const isFlat = data.billingMode === "flat";

    // Frequency shared by every named line (shown once instead of per row).
    const named = data.items.filter((it) => (it.name || "").trim());
    const freqSet = [...new Set(named.map((it) => (it.frequency || "").trim()).filter(Boolean))];
    const commonFreq = freqSet.length === 1 ? freqSet[0] : null;

    // ── Header (white) — logo cropped large on the left, doc meta on the right ──
    let drewLogo = false;
    if (data.logo) {
      try {
        const img: any = doc.openImage(data.logo);
        // The uploaded art has heavy white margins; zoom + clip so the mark
        // fills the box instead of shrinking to a speck. Fractions = the content
        // region within the source (generous so nothing is clipped).
        const fx = 0.06, fy = 0.24, fw = 0.88, fh = 0.55;
        const boxH = 52, boxY = 20;
        const cw = boxH * ((fw * img.width) / (fh * img.height));
        const fullW = cw / fw;
        const fullH = boxH / fh;
        doc.save();
        doc.rect(left, boxY, cw, boxH).clip();
        doc.image(data.logo, left - fx * fullW, boxY - fy * fullH, { width: fullW });
        doc.restore();
        drewLogo = true;
      } catch { drewLogo = false; }
    }
    if (!drewLogo) {
      doc.fillColor(INK).fontSize(20).font("Helvetica-Bold").text(data.companyName, left, 34, { width: width - 190 });
    }
    doc.fillColor(MUTE).fontSize(9).font("Helvetica").text("ESTIMATE", right - 190, 24, { width: 190, align: "right", characterSpacing: 1 });
    doc.fillColor(INK).fontSize(18).font("Helvetica-Bold").text(data.estimateNumber || "", right - 190, 36, { width: 190, align: "right" });
    const st = String(data.status || "").toUpperCase();
    if (st) {
      doc.fontSize(8).font("Helvetica-Bold");
      const stW = doc.widthOfString(st) + 16;
      doc.roundedRect(right - stW, 61, stW, 15, 7.5).fill("#FAEEDA");
      doc.fillColor("#854F0B").fontSize(8).font("Helvetica-Bold").text(st, right - stW, 65, { width: stW, align: "center" });
    }
    doc.rect(0, 88, pageW, 3).fill(MINT);

    let y = 112;
    const metaTop = y;

    // ── Prepared for (client) + dates ──
    doc.fillColor("#9CA3AF").fontSize(9).font("Helvetica-Bold").text("PREPARED FOR", left, y, { characterSpacing: 0.5 });
    y += 15;
    doc.fillColor(INK).fontSize(12.5).font("Helvetica-Bold").text(data.contactName || data.propertyName || "Client", left, y);
    y += 16;
    doc.fillColor(MUTE).fontSize(10).font("Helvetica");
    if (data.propertyName && data.contactName) { doc.text(data.propertyName, left, y, { width: width - 180 }); y = doc.y; }
    if (data.serviceAddress) { doc.text(data.serviceAddress, left, y, { width: width - 180 }); y = doc.y; }
    const issued = fmtDate(new Date().toISOString());
    const validUntil = fmtDate(data.validUntil);
    doc.fillColor(MUTE).fontSize(10).font("Helvetica").text(`Issued    ${issued}`, right - 200, metaTop + 1, { width: 200, align: "right" });
    if (validUntil) doc.text(`Valid until    ${validUntil}`, right - 200, metaTop + 16, { width: 200, align: "right" });
    y = Math.max(y, metaTop + 38) + 12;

    // ── Title + intro ──
    if (data.title) {
      doc.fillColor(INK).fontSize(16).font("Helvetica-Bold").text(data.title, left, y, { width });
      y = doc.y + 6;
    }
    if (data.introNote) {
      doc.fillColor("#4B5563").fontSize(10).font("Helvetica").text(data.introNote, left, y, { width, lineGap: 2.5 });
      y = doc.y + 18;
    }

    if (isFlat) {
      if (data.scopeNote) {
        doc.fillColor("#4B5563").fontSize(10).font("Helvetica").text(data.scopeNote, left, y, { width, lineGap: 2.5 });
        y = doc.y + 16;
      }
      if (named.length) {
        // Section header: label left, single frequency right (no per-row repeat).
        doc.fillColor("#9CA3AF").fontSize(9).font("Helvetica-Bold").text("SCOPE OF SERVICE", left, y, { characterSpacing: 0.5 });
        if (commonFreq) {
          doc.fillColor(MUTE).fontSize(10).font("Helvetica").text(`Frequency   ·   ${commonFreq}`, left, y - 0.5, { width, align: "right" });
        }
        y += 19;
        // Clean checklist — vector mint check (Helvetica has no check glyph) + name, no dividers.
        for (const it of named) {
          doc.save();
          doc.strokeColor(MINT).lineWidth(1.7).lineCap("round").lineJoin("round");
          doc.moveTo(left + 1, y + 5).lineTo(left + 4.5, y + 8.5).lineTo(left + 11, y + 0.5).stroke();
          doc.restore();
          const label = commonFreq ? (it.name || "Service") : (it.frequency ? `${it.name}   ·   ${it.frequency}` : (it.name || "Service"));
          doc.fillColor(INK).fontSize(11).font("Helvetica").text(label, left + 21, y, { width: width - 21 });
          y = doc.y + 10;
        }
        y += 4;
      }
    } else {
      for (const it of data.items) {
        const sub = [
          it.frequency,
          it.pricing_type === "hourly" ? `${Number(it.quantity).toFixed(1)} hrs × ${money(it.unit_rate)}/hr`
            : Number(it.quantity) !== 1 ? `${Number(it.quantity)} × ${money(it.unit_rate)}` : null,
        ].filter(Boolean).join("   ·   ");
        const startY = y;
        doc.fillColor(INK).fontSize(11).font("Helvetica-Bold").text(it.name || "Service", left, y, { width: width - 90 });
        y = doc.y;
        if (sub) { doc.fillColor(MUTE).fontSize(9).font("Helvetica").text(sub, left, y, { width: width - 90 }); y = doc.y; }
        doc.fillColor(INK).fontSize(11).font("Helvetica-Bold").text(money(it.amount), right - 90, startY, { width: 90, align: "right" });
        y += 9;
        doc.moveTo(left, y).lineTo(right, y).strokeColor("#F0EEE9").lineWidth(1).stroke();
        y += 9;
      }
      // Subtotal / discount above the panel for itemized.
      if (Number(data.discount) > 0) {
        doc.fillColor(MUTE).fontSize(10).font("Helvetica").text("Subtotal", right - 220, y, { width: 110 });
        doc.fillColor(INK).text(money(data.subtotal), right - 110, y, { width: 110, align: "right" });
        y += 15;
        doc.fillColor("#047857").fontSize(10).font("Helvetica").text("Discount", right - 220, y, { width: 110 });
        doc.text(`-${money(data.discount)}`, right - 110, y, { width: 110, align: "right" });
        y += 16;
      }
    }

    // ── Total panel ──
    y += 4;
    const panelH = 56;
    doc.roundedRect(left, y, width, panelH, 10).fill(NAVY);
    doc.fillColor("#9CA3AF").fontSize(11).font("Helvetica").text("Total", left + 20, y + 15);
    const caption = isFlat
      ? (data.flatPriceUnit === "total" ? "One-time" : data.flatPriceUnit === "month" ? "Billed monthly" : data.flatPriceUnit ? `Billed per ${data.flatPriceUnit}` : "")
      : (commonFreq || "");
    if (caption) doc.fillColor("#6B7280").fontSize(9.5).font("Helvetica").text(caption, left + 20, y + 32);
    const amt = money(data.total);
    const suf = isFlat ? unitSuffix(data.flatPriceUnit) : "";
    doc.font("Helvetica-Bold").fontSize(23);
    const amtW = doc.widthOfString(amt);
    doc.font("Helvetica").fontSize(12);
    const sufW = suf ? doc.widthOfString(suf) : 0;
    const startX = right - 20 - amtW - sufW;
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(23).text(amt, startX, y + 16, { lineBreak: false });
    if (suf) doc.fillColor("#9CA3AF").font("Helvetica").fontSize(12).text(suf, startX + amtW, y + 26, { lineBreak: false });
    y += panelH + 22;

    // ── Terms ──
    if (data.terms) {
      doc.fillColor("#9CA3AF").fontSize(9).font("Helvetica-Bold").text("TERMS", left, y, { characterSpacing: 0.5 });
      y += 13;
      doc.fillColor("#4B5563").fontSize(9.5).font("Helvetica").text(data.terms, left, y, { width, lineGap: 2 });
    }

    // ── Footer — company contact (phone + email; never the physical address) ──
    const footY = doc.page.height - 46;
    const contact = [data.companyName, data.companyPhone, data.companyEmail].filter(Boolean).join("    ·    ");
    doc.page.margins.bottom = 0; // draw in the bottom margin without forcing a new page
    doc.moveTo(left, footY).lineTo(right, footY).strokeColor("#EEECE7").lineWidth(1).stroke();
    doc.fillColor("#9CA3AF").fontSize(9).font("Helvetica").text(contact, left, footY + 9, { width, align: "center", lineBreak: false });

    doc.end();
  });
}
