// [service-suspension 2026-07-11] Renderers for the three service-suspension
// lifecycle emails. To keep client communications visually consistent, these
// produce ONLY the inner content (status pill + heading + intro + a bordered
// detail table + closing) in the exact house style of lib/confirmation-email.ts,
// and the caller wraps them in the shared wrapEmailHtml() chrome (logo masthead
// + standard "Phes | phone | email | phes.io" footer) that every other customer
// email uses — see buildSuspensionEmailHtml in lib/suspension.ts.
//
// Copy goals (owner 2026-07-11): show the client the SERVICE they have + the
// PRICE they pay, and frame the message around the recurring-client benefits
// they risk losing (locked-in rate, reserved spot, regular team) if the hold
// lapses and they come off recurring service.
//
// ASCII-only punctuation (plain hyphens, straight quotes) — no em-dashes: an
// em-dash renders as mojibake ("a€") in some clients and forces SMS out of
// GSM-7. Pure + dependency-free so they can be unit-rendered/previewed.

const FONT = "'Plus Jakarta Sans', Arial, Helvetica, sans-serif";
const INK = "#1A1917";
const MUTE = "#6B6860";
const BORDER = "#E5E2DC";
const BRANDINK = "#0A0E1A";

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
function detailTable(rows: Array<[string, string, boolean?]>): string {
  const body = rows.map(([label, value, accent]) => `
    <tr>
      <td style="padding:11px 0;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:13px;color:${MUTE};">${esc(label)}</td>
      <td align="right" style="padding:11px 0;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:14px;font-weight:${accent ? 800 : 600};color:${accent ? BRANDINK : INK};">${esc(value)}</td>
    </tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BORDER};border-radius:10px;padding:2px 16px;">${body}</table>`;
}

// Shared service fields shown on every message.
interface ServiceInfo {
  serviceSummary: string; // e.g. "Bi-weekly Standard Clean"
  servicePrice: string;   // e.g. "$180 per visit"
}

interface StartArgs extends ServiceInfo {
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
    h1("Your recurring service is on hold") +
    intro(`Hi ${esc(first)}, this confirms that your recurring cleaning service has been placed on hold${reasonClause}. During the hold we won't schedule any visits, and you won't be billed for cleanings.`) +
    detailTable([
      ["Your service", a.serviceSummary],
      ["Your recurring rate", a.servicePrice, true],
      ["Suspension starts", fmtLongDate(a.startDate)],
      ["Hold ends on", fmtLongDate(a.expiryDate)],
    ]) +
    closing(`As a recurring client you're locked in at ${esc(a.servicePrice)}, and you keep your regular spot on our schedule and your usual cleaning team. Resume any time before ${esc(fmtLongDate(a.expiryDate))} to keep those benefits - coming off recurring service means giving up your locked-in rate and rebooking at our standard rates. Just reply to this email or call us and we'll get you back on the schedule.`);
  return { subject: `Your recurring cleaning is on hold until ${fmtLongDate(a.expiryDate)}`, contentHtml };
}

interface ReminderArgs extends ServiceInfo {
  clientName: string;
  expiryDate: string; // YYYY-MM-DD
}

// (2) Sent ~30 days before the hold ends — the "keep your benefits" follow-up.
export function renderResumeReminderEmail(a: ReminderArgs): { subject: string; contentHtml: string } {
  const first = a.clientName?.trim() || "there";
  const contentHtml =
    pill("Ending soon") +
    h1("Keep your recurring cleaning benefits") +
    intro(`Hi ${esc(first)}, your cleaning hold is coming to an end soon. Resume now to keep everything you have as a recurring client.`) +
    detailTable([
      ["Your service", a.serviceSummary],
      ["Your recurring rate", a.servicePrice, true],
      ["Hold ends on", fmtLongDate(a.expiryDate)],
    ]) +
    closing(`Recurring clients keep a locked-in rate, a reserved place on our schedule, and their regular team. If your hold lapses on ${esc(fmtLongDate(a.expiryDate))}, you'll come off recurring service and rebook at our standard rates. Want to keep your ${esc(a.servicePrice)} rate? Reply to this email or call us and we'll get you back on the calendar.`);
  return { subject: `Keep your ${a.servicePrice} recurring rate before your hold ends`, contentHtml };
}

interface ExpiredArgs extends ServiceInfo {
  clientName: string;
  expiryDate: string; // YYYY-MM-DD
}

// (3) Sent at expiry — final notice. We do NOT change any account state
// automatically; this lets the customer know the hold has ended, reminds them
// what they stand to lose, and invites them back while the office follows up.
export function renderSuspensionExpiredEmail(a: ExpiredArgs): { subject: string; contentHtml: string } {
  const first = a.clientName?.trim() || "there";
  const contentHtml =
    pill("Hold ended") +
    h1("Your recurring hold has ended") +
    intro(`Hi ${esc(first)}, your cleaning hold ended on ${esc(fmtLongDate(a.expiryDate))}. We've kept your recurring spot and your rate open as long as we can, and we haven't rebooked yet - we wanted to check with you first.`) +
    detailTable([
      ["Your service", a.serviceSummary],
      ["Your recurring rate", a.servicePrice, true],
      ["Hold ended", fmtLongDate(a.expiryDate)],
    ]) +
    closing(`Reactivate now to keep your ${esc(a.servicePrice)} recurring rate and your regular team before your spot is released. If you come off recurring service, future cleanings would be booked at our standard rates. Just reply to this email or call us and we'll set up your next visit.`);
  return { subject: `Your recurring hold has ended - keep your ${a.servicePrice} rate`, contentHtml };
}
