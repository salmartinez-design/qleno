// [service-suspension 2026-07-11] Renderers for the three service-suspension
// lifecycle emails. To keep client communications visually consistent, these
// produce ONLY the inner content (status pill + heading + intro + a bordered
// detail table + closing) in the exact house style of lib/confirmation-email.ts,
// and the caller wraps them in the shared wrapEmailHtml() chrome (navy/logo
// masthead + standard "Phes | phone | email | phes.io" footer) that every other
// customer email uses — see buildSuspensionEmailHtml in lib/suspension.ts.
//
// Pure + dependency-free so they can be unit-rendered and previewed in
// isolation. Each returns { subject, contentHtml }.

// Match the confirmation email's font stack: brand font first, Arial fallback
// (email clients that can't load Plus Jakarta Sans render Arial, same as the
// shared wrapEmailHtml chrome).
const FONT = "'Plus Jakarta Sans', Arial, Helvetica, sans-serif";
const INK = "#1A1917";
const MUTE = "#6B6860";
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

// ── House-style inner-content pieces (mirror lib/confirmation-email.ts) ─────────
function pill(label: string): string {
  // Amber "on hold" pill — same shape as the confirmation email's green
  // "Confirmed" pill, recolored for a service hold.
  return `<div style="display:inline-block;padding:4px 12px;border-radius:999px;font-family:${FONT};font-size:12px;font-weight:700;background:#FEF3C7;color:#92400E;margin-bottom:14px;">${esc(label)}</div>`;
}
function h1(text: string): string {
  return `<h1 style="margin:0 0 6px;font-family:${FONT};font-size:22px;font-weight:700;color:${INK};">${esc(text)}</h1>`;
}
function intro(text: string): string {
  return `<p style="margin:0 0 22px;font-family:${FONT};font-size:14px;color:${MUTE};line-height:1.6;">${text}</p>`;
}
function closing(text: string): string {
  return `<p style="margin:22px 0 0;font-family:${FONT};font-size:14px;color:${INK};line-height:1.6;">${text}</p>`;
}
function detailTable(rows: Array<[string, string]>): string {
  const body = rows.map(([label, value]) => `
    <tr>
      <td style="padding:11px 0;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:13px;color:${MUTE};">${esc(label)}</td>
      <td align="right" style="padding:11px 0;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:14px;font-weight:600;color:${INK};">${esc(value)}</td>
    </tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BORDER};border-radius:10px;padding:2px 16px;">${body}</table>`;
}

interface StartArgs {
  clientName: string;
  startDate: string; // YYYY-MM-DD
  expiryDate: string; // YYYY-MM-DD
  reason?: string | null;
}

// (1) Sent when the office suspends the service.
export function renderSuspensionStartEmail(a: StartArgs): { subject: string; contentHtml: string } {
  const first = a.clientName?.trim() || "there";
  const reasonClause = a.reason?.trim() ? ` at your request (${esc(a.reason.trim())})` : "";
  const contentHtml =
    pill("On hold") +
    h1("Your service is on hold") +
    intro(`Hi ${esc(first)}, this confirms that your cleaning service has been placed on hold${reasonClause}. During the hold, we won't schedule any visits, and you won't be billed for cleanings.`) +
    detailTable([
      ["Suspension starts", fmtLongDate(a.startDate)],
      ["Hold ends on", fmtLongDate(a.expiryDate)],
    ]) +
    closing(`You can resume any time before ${esc(fmtLongDate(a.expiryDate))} — just reply to this email or give us a call and we'll get you back on the schedule. We'll also check in with you about a month before the hold ends.`);
  return { subject: `Your cleaning service is on hold until ${fmtLongDate(a.expiryDate)}`, contentHtml };
}

interface ReminderArgs {
  clientName: string;
  expiryDate: string; // YYYY-MM-DD
}

// (2) Sent ~30 days before the hold ends — the "want to resume?" follow-up.
export function renderResumeReminderEmail(a: ReminderArgs): { subject: string; contentHtml: string } {
  const first = a.clientName?.trim() || "there";
  const contentHtml =
    pill("Ending soon") +
    h1("Your hold ends soon") +
    intro(`Hi ${esc(first)}, your cleaning service has been on hold, and that hold is coming to an end soon. We'd love to welcome you back.`) +
    detailTable([["Your hold ends on", fmtLongDate(a.expiryDate)]]) +
    closing(`Would you like to resume service? Just reply to this email or call us and we'll get your regular cleanings back on the calendar. If we don't hear from you by ${esc(fmtLongDate(a.expiryDate))}, we'll follow up once more before closing out the hold.`);
  return { subject: `Ready to resume your cleaning service?`, contentHtml };
}

interface ExpiredArgs {
  clientName: string;
  expiryDate: string; // YYYY-MM-DD
}

// (3) Sent at expiry — final notice. We do NOT change any account state
// automatically; this simply lets the customer know the hold has ended and
// invites them back, while the office follows up.
export function renderSuspensionExpiredEmail(a: ExpiredArgs): { subject: string; contentHtml: string } {
  const first = a.clientName?.trim() || "there";
  const contentHtml =
    pill("Hold ended") +
    h1("Your hold has ended") +
    intro(`Hi ${esc(first)}, your cleaning service hold ended on ${esc(fmtLongDate(a.expiryDate))}. We haven't scheduled any visits yet — we wanted to check with you first.`) +
    detailTable([["Hold ended", fmtLongDate(a.expiryDate)]]) +
    closing(`If you'd like to pick your cleanings back up, just reply to this email or give us a call and we'll set up your next visit right away. We'd be glad to have you back.`);
  return { subject: `Your cleaning service hold has ended`, contentHtml };
}
