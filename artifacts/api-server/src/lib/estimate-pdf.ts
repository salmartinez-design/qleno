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
  // [itemized-line-scope 2026-08-14] Per-line scope paragraph. Already rendered
  // on the hosted view; the PDF was dropping it silently.
  description?: string | null;
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
    // [estimate-pdf-pagination 2026-08-14] bufferPages so the footer can be
    // stamped on EVERY page after the body is laid out. Without it the footer
    // only landed on whatever page was current when it was drawn.
    const doc = new PDFDocument({ margin: 50, size: "LETTER", bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = 50;
    const right = doc.page.width - 50;
    const width = right - left;
    const pageW = doc.page.width;
    const isFlat = data.billingMode === "flat";

    // [estimate-pdf-pagination 2026-08-14] This renderer drives a manual `y`
    // cursor and positions everything with explicit coordinates. PDFKit
    // auto-paginates TEXT when it overflows, but vector ops (roundedRect, the
    // total panel, rules) do NOT — they just draw off-canvas. So a long
    // estimate produced a page that was blank except for whatever text
    // happened to trigger the break, with the panel silently lost off the
    // previous page. Fix: reserve space before each block and break
    // deliberately, keeping `y` and the real page in sync.
    let y = 112;                                 // manual layout cursor
    const TOP = 50;                              // where content resumes on a new page
    const BOTTOM = doc.page.height - 62;         // keep clear of the footer rule
    const newPage = () => { doc.addPage(); y = TOP; };
    // Reserve `h` points; break first if this block would cross the boundary.
    const ensure = (h: number) => { if (y + h > BOTTOM) newPage(); };
    // Measure wrapped text so `ensure` can reserve the real height.
    const heightOf = (text: string, size: number, w: number, lineGap = 0) => {
      doc.fontSize(size).font("Helvetica");
      return doc.heightOfString(text, { width: w, lineGap });
    };

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
        const scope = (it.description || "").trim();
        // Reserve the whole row (name + sub + scope + rule) so a line never
        // splits across a page break with its amount stranded behind.
        ensure(
          heightOf(it.name || "Service", 11, width - 90)
          + (sub ? heightOf(sub, 9, width - 90) : 0)
          + (scope ? heightOf(scope, 9.5, width - 90, 2) + 4 : 0)
          + 18
        );
        const startY = y;
        doc.fillColor(INK).fontSize(11).font("Helvetica-Bold").text(it.name || "Service", left, y, { width: width - 90 });
        y = doc.y;
        if (sub) { doc.fillColor(MUTE).fontSize(9).font("Helvetica").text(sub, left, y, { width: width - 90 }); y = doc.y; }
        // [itemized-line-scope 2026-08-14] Per-line scope under the line, matching
        // the hosted view. Indented-free, full column width minus the amount.
        if (scope) {
          y += 4;
          doc.fillColor("#4B5563").fontSize(9.5).font("Helvetica").text(scope, left, y, { width: width - 90, lineGap: 2 });
          y = doc.y;
        }
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
    // The panel is a vector fill — it will NOT auto-paginate, so reserve first.
    // This is what used to vanish off the bottom of page 1.
    ensure(panelH + 22);
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
    // Long terms (multi-location estimates run to a full page) are flowed
    // paragraph-by-paragraph so each break lands between paragraphs instead of
    // letting PDFKit overflow past the footer.
    if (data.terms) {
      ensure(13 + 24);
      doc.fillColor("#9CA3AF").fontSize(9).font("Helvetica-Bold").text("TERMS", left, y, { characterSpacing: 0.5 });
      y += 13;
      for (const para of String(data.terms).split(/\n{2,}/)) {
        const block = para.trim();
        if (!block) continue;
        const h = heightOf(block, 9.5, width, 2);
        // A paragraph taller than a full page can't be reserved whole — start it
        // on a fresh page and let PDFKit flow the remainder.
        if (h > BOTTOM - TOP) { if (y > TOP) newPage(); }
        else ensure(h);
        doc.fillColor("#4B5563").fontSize(9.5).font("Helvetica").text(block, left, y, { width, lineGap: 2 });
        y = doc.y + 8;
      }
    }

    // ── Footer — company contact (phone + email; never the physical address) ──
    // [estimate-pdf-pagination 2026-08-14] Stamped on EVERY page, after layout.
    const contact = [data.companyName, data.companyPhone, data.companyEmail].filter(Boolean).join("    ·    ");
    const footY = doc.page.height - 46;
    const range = doc.bufferedPageRange();
    for (let p = range.start; p < range.start + range.count; p++) {
      doc.switchToPage(p);
      doc.page.margins.bottom = 0; // draw in the bottom margin without forcing a new page
      doc.moveTo(left, footY).lineTo(right, footY).strokeColor("#EEECE7").lineWidth(1).stroke();
      doc.fillColor("#9CA3AF").fontSize(9).font("Helvetica").text(contact, left, footY + 9, { width, align: "center", lineBreak: false });
    }
    doc.flushPages();

    doc.end();
  });
}
