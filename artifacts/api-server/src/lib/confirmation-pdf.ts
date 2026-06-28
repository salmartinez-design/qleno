// [booking-confirmation copy] Renders a faithful PDF copy of the customer
// booking-confirmation email so the office can view exactly what a client was
// sent (and re-attach / re-send it). This is a *reconstruction* of the email's
// content — same details, same policy copy, Qleno brand — not a pixel snapshot
// of the HTML (Railway has no Chromium, so HTML->PDF via a headless browser is
// intentionally avoided here, mirroring lib/pdf-gen.ts). Built with pdfkit,
// returns a Buffer the route streams back inline.
//
// The content mirrors lib/confirmation-email.ts renderConfirmationEmail():
// Confirmed badge, the Date/Time/Service/Address/Cleaner detail rows, the
// per-tenant policy copy (pulled verbatim from the job_scheduled template),
// and the tenant contact line.

import PDFDocument from "pdfkit";
import { fmtTime12h, extractPolicyCopy } from "./confirmation-email.js";

// Brand palette — matches the confirmation email + CLAUDE.md design system.
const NAVY = "#0A0E1A";
const MINT = "#00C9A0";
const INK = "#1A1917";
const MUTE = "#6B6860";
const BORDER = "#E5E2DC";

export interface ConfirmationPdfData {
  jobId: number;
  companyName: string;
  clientFirst: string;
  apptDate: string;
  apptTime: string;
  serviceType: string;
  serviceAddress: string;
  techName: string | null;
  policyText: string;
  phone: string;
  email: string;
  recipientEmail: string | null;
  sentAt: Date | null;
}

function fmtApptDate(dateStr: any): string {
  try {
    const iso = dateStr instanceof Date ? dateStr.toISOString().slice(0, 10) : String(dateStr).slice(0, 10);
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return String(dateStr);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  } catch { return String(dateStr); }
}

function labelService(raw: string | null): string {
  if (!raw) return "Cleaning service";
  return raw.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Minimal merge + HTML->text so the PDF carries the SAME policy copy the email
// did. Block tags become paragraph breaks; the rest is stripped + a few common
// entities decoded.
function applyMerge(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => vars[key.trim()] ?? "");
}

function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&middot;/g, "·")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Gathers everything the PDF needs from a job id (same join the confirmation
// email send uses). Returns null if the job doesn't exist / isn't this company.
// `companyId` scopes the lookup so one tenant can't render another's job.
export async function gatherConfirmationData(jobId: number, companyId: number): Promise<ConfirmationPdfData | null> {
  // Lazy-import so the pure PDF renderer (buildConfirmationPdf) can be imported
  // and unit-tested without a DATABASE_URL.
  const { db } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");
  const rows = await db.execute(sql`
    SELECT j.id, j.company_id, j.scheduled_date, j.scheduled_time, j.service_type,
           j.address_street, j.address_city, j.address_state, j.address_zip,
           c.first_name, c.email AS client_email,
           u.first_name AS tech_first,
           co.name AS company_name, co.phone AS company_phone, co.email AS company_email
    FROM jobs j
    LEFT JOIN clients c ON c.id = j.client_id
    LEFT JOIN users u ON u.id = j.assigned_user_id
    JOIN companies co ON co.id = j.company_id
    WHERE j.id = ${jobId} AND j.company_id = ${companyId} LIMIT 1
  `);
  const j: any = rows.rows[0];
  if (!j) return null;

  const stateZip = [j.address_state, j.address_zip].filter(Boolean).join(" ");
  const serviceAddress = [j.address_street, j.address_city, stateZip].filter(Boolean).join(", ") || "On file";

  // Pull the tenant's job_scheduled email body, merge it, and extract the same
  // policy copy block the email shows. Best-effort: a missing template just
  // yields empty policy text rather than failing the whole PDF.
  let policyText = "";
  try {
    const tplRows = await db.execute(sql`
      SELECT COALESCE(body_html, body) AS body
      FROM notification_templates
      WHERE company_id = ${companyId} AND trigger = 'job_scheduled' AND channel = 'email'::notification_channel AND is_active = true
      LIMIT 1
    `);
    const body = (tplRows.rows[0] as any)?.body as string | undefined;
    if (body) {
      const merged = applyMerge(body, {
        first_name: (j.first_name || "").trim(),
        company_name: j.company_name || "Phes",
        company_phone: j.company_phone || "",
        company_email: j.company_email || "",
        appointment_date: j.scheduled_date ? fmtApptDate(j.scheduled_date) : "",
        appointment_time: j.scheduled_time ? fmtTime12h(j.scheduled_time) : "",
        service_type: labelService(j.service_type),
        service_address: serviceAddress,
        appointment_link: "",
      });
      policyText = htmlToText(extractPolicyCopy(merged));
    }
  } catch { /* non-fatal */ }

  const FALLBACK_PHONE = "(847) 538-3729", FALLBACK_EMAIL = "schaumburg@phes.io";
  return {
    jobId: j.id,
    companyName: j.company_name || "Phes",
    clientFirst: (j.first_name || "").trim(),
    apptDate: j.scheduled_date ? fmtApptDate(j.scheduled_date) : "Your scheduled date",
    apptTime: fmtTime12h(j.scheduled_time),
    serviceType: labelService(j.service_type),
    serviceAddress,
    techName: j.tech_first || null,
    policyText,
    phone: j.company_phone || FALLBACK_PHONE,
    email: j.company_email || FALLBACK_EMAIL,
    recipientEmail: j.client_email || null,
    sentAt: null,
  };
}

export function buildConfirmationPdf(data: ConfirmationPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "LETTER" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const left = 50;
    const right = pageW - 50;
    const contentW = right - left;

    // ── Navy masthead ───────────────────────────────────────────────────────
    doc.rect(0, 0, pageW, 96).fill(NAVY);
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(22)
      .text(data.companyName, left, 28, { width: contentW });
    doc.font("Helvetica").fontSize(11).fillColor("#9DA3B0")
      .text("Booking Confirmation", left, 58, { width: contentW });

    // ── Confirmed badge ─────────────────────────────────────────────────────
    let y = 124;
    const badgeText = "CONFIRMED";
    doc.font("Helvetica-Bold").fontSize(9);
    const badgeW = doc.widthOfString(badgeText) + 20;
    doc.roundedRect(left, y, badgeW, 20, 10).fill("#EAF7F3");
    doc.fillColor("#0A7C63").text(badgeText, left + 10, y + 6);
    y += 36;

    // ── Title + greeting ────────────────────────────────────────────────────
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(20)
      .text("Your cleaning is confirmed", left, y, { width: contentW });
    y += 30;
    doc.fillColor(MUTE).font("Helvetica").fontSize(11)
      .text(
        data.clientFirst ? `Hi ${data.clientFirst}, here are your appointment details.` : "Here are your appointment details.",
        left, y, { width: contentW }
      );
    y += 28;

    // ── Detail rows ─────────────────────────────────────────────────────────
    const rowH = 26;
    const detailRow = (label: string, value: string) => {
      doc.font("Helvetica").fontSize(11).fillColor(MUTE).text(label, left, y + 7);
      doc.font("Helvetica-Bold").fontSize(11).fillColor(INK)
        .text(value, left + 130, y + 7, { width: contentW - 130, align: "right" });
      doc.moveTo(left, y + rowH).lineTo(right, y + rowH).strokeColor(BORDER).lineWidth(1).stroke();
      y += rowH + 6;
    };
    doc.rect(left, y, contentW, 0); // anchor
    detailRow("Date", data.apptDate);
    detailRow("Time", data.apptTime);
    detailRow("Service", data.serviceType);
    detailRow("Address", data.serviceAddress);
    if (data.techName) detailRow("Your cleaner", data.techName);
    y += 12;

    // ── Policy copy ─────────────────────────────────────────────────────────
    if (data.policyText) {
      doc.font("Helvetica").fontSize(10.5).fillColor(INK)
        .text(data.policyText, left, y, { width: contentW, align: "left", lineGap: 3 });
      y = doc.y + 16;
    }

    // ── Contact line ────────────────────────────────────────────────────────
    doc.moveTo(left, y).lineTo(right, y).strokeColor(BORDER).lineWidth(1).stroke();
    y += 14;
    doc.font("Helvetica").fontSize(11).fillColor(MUTE)
      .text(`Questions? Call or text ${data.phone}  ·  ${data.email}`, left, y, { width: contentW, align: "center" });
    y = doc.y + 18;

    // ── Footer: provenance + Qleno mark ─────────────────────────────────────
    doc.moveTo(left, y).lineTo(right, y).strokeColor(BORDER).lineWidth(1).stroke();
    y += 12;
    const sentLine = data.recipientEmail
      ? data.sentAt
        ? `Copy of the confirmation email sent to ${data.recipientEmail} on ${data.sentAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.`
        : `Confirmation email on file for ${data.recipientEmail}.`
      : "Confirmation copy.";
    doc.font("Helvetica").fontSize(8.5).fillColor("#9E9B94")
      .text(sentLine, left, y, { width: contentW, align: "center" });
    doc.text(
      `Job #${data.jobId}  ·  Powered by Qleno  ·  Generated ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`,
      left, doc.y + 4, { width: contentW, align: "center" }
    );

    doc.end();
  });
}
