// [service-suspension 2026-07-11] Pure, dependency-free renderers for the three
// service-suspension lifecycle emails. No DB / Express imports so they can be
// unit-rendered and previewed in isolation. Mail-client-safe: table layout,
// inline styles, Plus Jakarta Sans + sans-serif fallback, Qleno/Phes brand
// (navy #0A0E1A, mint #00C9A0, page bg #F7F6F3). Each returns { subject, html }.
//
// The office fires (1) on suspend, and the daily cron fires (2) 30 days before
// the resume date and (3) at expiry. None of these send anything by themselves —
// the caller still gates on COMMS_ENABLED + the client's email_opt_out_at.

const FONT = "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const NAVY = "#0A0E1A";
const MINT = "#00C9A0";
const INK = "#1A1917";
const MUTE = "#6B6860";
const PAGE_BG = "#F7F6F3";
const BORDER = "#E5E2DC";

const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// "YYYY-MM-DD" (or a Date) → "Monday, July 21, 2026". Anchors date-only values
// to local noon so the day never shifts across a US-Central timezone boundary.
export function fmtLongDate(d: string | Date): string {
  const iso = typeof d === "string" ? d : d.toISOString().slice(0, 10);
  const s = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + "T12:00:00" : iso;
  const dt = new Date(s);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

interface Shell {
  companyName: string;
  companyPhone?: string | null;
  heading: string;
  bodyHtml: string; // inner paragraphs / callouts
}

// Shared branded chrome so all three emails read as one system.
function renderShell({ companyName, companyPhone, heading, bodyHtml }: Shell): string {
  const phoneLine = companyPhone
    ? `<p style="font-family:${FONT};font-size:13px;color:${MUTE};line-height:1.6;margin:0 0 4px;">Questions? Call us at <a href="tel:${esc(companyPhone)}" style="color:${INK};text-decoration:none;font-weight:700;">${esc(companyPhone)}</a>.</p>`
    : "";
  return `<div style="background:${PAGE_BG};padding:24px 0;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${PAGE_BG};">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:540px;background:#FFFFFF;border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">
        <tr><td style="background:${NAVY};padding:22px 28px;">
          <span style="font-family:${FONT};font-size:18px;font-weight:800;color:#FFFFFF;letter-spacing:-0.01em;">${esc(companyName)}</span>
        </td></tr>
        <tr><td style="padding:28px;">
          <h1 style="font-family:${FONT};font-size:20px;font-weight:800;color:${NAVY};margin:0 0 16px;line-height:1.3;">${esc(heading)}</h1>
          ${bodyHtml}
          ${phoneLine}
          <p style="font-family:${FONT};font-size:13px;color:${MUTE};line-height:1.6;margin:14px 0 0;">— The ${esc(companyName)} team</p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid ${BORDER};">
          <span style="font-family:${FONT};font-size:11px;color:#9E9B94;">${esc(companyName)}</span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</div>`;
}

function para(text: string): string {
  return `<p style="font-family:${FONT};font-size:15px;color:${INK};line-height:1.65;margin:0 0 16px;">${text}</p>`;
}

// A single-cell callout table (email-client-safe) highlighting the key date.
function dateCallout(label: string, value: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;">
    <tr><td style="background:#F1FBF8;border:1px solid ${MINT}55;border-radius:10px;padding:16px 18px;">
      <div style="font-family:${FONT};font-size:11px;font-weight:700;color:${MUTE};text-transform:uppercase;letter-spacing:0.07em;">${esc(label)}</div>
      <div style="font-family:${FONT};font-size:17px;font-weight:800;color:${NAVY};margin-top:3px;">${esc(value)}</div>
    </td></tr>
  </table>`;
}

interface StartArgs {
  clientName: string;
  companyName: string;
  companyPhone?: string | null;
  startDate: string; // YYYY-MM-DD
  expiryDate: string; // YYYY-MM-DD
  reason?: string | null;
}

// (1) Sent when the office suspends the service.
export function renderSuspensionStartEmail(a: StartArgs): { subject: string; html: string } {
  const first = a.clientName?.trim() || "there";
  const reasonClause = a.reason?.trim() ? ` at your request (${esc(a.reason.trim())})` : "";
  const bodyHtml =
    para(`Hi ${esc(first)}, this confirms that your cleaning service has been placed on hold${reasonClause}. During the hold, we won't schedule any visits, and you won't be billed for cleanings.`) +
    dateCallout("Suspension starts", fmtLongDate(a.startDate)) +
    dateCallout("Hold ends on", fmtLongDate(a.expiryDate)) +
    para(`You can resume any time before ${esc(fmtLongDate(a.expiryDate))} — just reply to this email or give us a call and we'll get you back on the schedule. We'll also check in with you about a month before the hold ends.`);
  return {
    subject: `Your cleaning service is on hold until ${fmtLongDate(a.expiryDate)}`,
    html: renderShell({ companyName: a.companyName, companyPhone: a.companyPhone, heading: "Your service is on hold", bodyHtml }),
  };
}

interface ReminderArgs {
  clientName: string;
  companyName: string;
  companyPhone?: string | null;
  expiryDate: string; // YYYY-MM-DD
}

// (2) Sent ~30 days before the hold ends — the "want to resume?" follow-up.
export function renderResumeReminderEmail(a: ReminderArgs): { subject: string; html: string } {
  const first = a.clientName?.trim() || "there";
  const bodyHtml =
    para(`Hi ${esc(first)}, your cleaning service has been on hold, and that hold is coming to an end soon. We'd love to welcome you back.`) +
    dateCallout("Your hold ends on", fmtLongDate(a.expiryDate)) +
    para(`Would you like to resume service? Just reply to this email or call us and we'll get your regular cleanings back on the calendar. If we don't hear from you by ${esc(fmtLongDate(a.expiryDate))}, we'll follow up once more before closing out the hold.`);
  return {
    subject: `Ready to resume your cleaning service?`,
    html: renderShell({ companyName: a.companyName, companyPhone: a.companyPhone, heading: "Your hold ends soon", bodyHtml }),
  };
}

interface ExpiredArgs {
  clientName: string;
  companyName: string;
  companyPhone?: string | null;
  expiryDate: string; // YYYY-MM-DD
}

// (3) Sent at expiry — final notice. We do NOT change any account state
// automatically; this simply lets the customer know the hold has ended and
// invites them back, while the office follows up.
export function renderSuspensionExpiredEmail(a: ExpiredArgs): { subject: string; html: string } {
  const first = a.clientName?.trim() || "there";
  const bodyHtml =
    para(`Hi ${esc(first)}, your cleaning service hold has now ended as of ${esc(fmtLongDate(a.expiryDate))}. We haven't scheduled any visits yet — we wanted to check with you first.`) +
    para(`If you'd like to pick your cleanings back up, just reply to this email or give us a call and we'll set up your next visit right away. We'd be glad to have you back.`);
  return {
    subject: `Your cleaning service hold has ended`,
    html: renderShell({ companyName: a.companyName, companyPhone: a.companyPhone, heading: "Your hold has ended", bodyHtml }),
  };
}
