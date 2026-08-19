// ─────────────────────────────────────────────────────────────────────────────
// PHES bespoke Booking Confirmation email — a fully hand-crafted, mail-client-
// safe HTML template (table layout, inline styles only). Copy is BAKED IN (not
// tenant-editable) and mirrors the wording saved in PHES's tenant template:
// greeting, cancellation policy w/ Mon/Tues deadlines, "before we arrive",
// 24-hour guarantee, 15%-off offer, and the fine print (pricing / non-solicit /
// T&C). Only booking-specific values are interpolated.
//
// Wired for PHES only via booking-confirmation.ts (company name matches /phes/i);
// every other tenant keeps the standard renderConfirmationEmail. Productizing a
// tenant-editable slot layout is a separate, later PR — this is PHES-first.
// ─────────────────────────────────────────────────────────────────────────────

import {
  FONT, BRAND, INK, MUTE, BORDER,
  GREEN_BG, GREEN_FG, GREEN_INK, BLUE_BG, BLUE_FG, BLUE_INK,
  esc, escAttr, h3, callout, detailRow, detailRowNote, phesEmailShell,
} from "./phes-email-shell.js";

export interface PhesConfOpts {
  logoUrl: string;
  companyName: string;
  companyPhone: string;    // display, e.g. "(773) 706-6000"
  companyPhoneTel: string; // tel: href, e.g. "+17737066000"
  companyEmail: string;
  website: string;         // e.g. "phes.io"
  firstName: string;
  date: string;            // "Friday, June 27, 2026"
  arrivalWindow: string;   // "9:00 AM – 9:45 AM"
  address: string;
  service: string;
  estimatedTime?: string;          // "~3.5 hours" ("" / omitted hides the row)
  servicesBreakdownHtml: string;   // pre-rendered itemized table (may be "")
  scheduledDateISO: string;        // "2026-06-27" — for calendar links
  scheduledTimeRaw: string | null; // "9:00 AM" / "09:00" — event start
  paymentTotal: string;            // "$673.00" ("" hides the payment row)
  hasCardOnFile: boolean;          // true → "charged to your card"; false → "due at service"
  checklistUrl: string;            // TODO: make tenant-configurable (Company Settings)
  showOverageNote?: boolean;       // Deep Clean / Move In-Out: prominent $70/hr overage callout
  // [recurring-upsell-gate 2026-08-18] False when the customer ALREADY booked a
  // recurring cadence. The 15%-off block used to render unconditionally, so a
  // customer who had just signed up for weekly service was told in the very
  // email confirming it to "book a recurring service" for a discount. Offer it
  // only to one-time customers, who are the ones it was written for.
  showRecurringOffer?: boolean;
  // [commercial-confirmation 2026-08-18] Commercial single visits bill $180 for
  // up to 3 hours then $60/additional hour, not the residential $70/hr overage —
  // so the flat-rate fine print would misquote the customer's own contract.
  commercial?: boolean;
  // [arrival-window 2026-08-18] Width of the customer arrival window in minutes
  // (companies.arrival_window_minutes, 45). The add-to-calendar event spans this,
  // so the block on the customer's calendar matches the window we quoted them.
  windowMinutes?: number;
  icsUrl?: string;                 // hosted .ics for the Apple button (email clients block data: URIs)
  // [client-facing-notes 2026-08-19] The office's client-facing note for THIS
  // visit, taken on the booking call. Already gated by the caller on the job's
  // client_notes_on_confirmation switch, so a value here means "show it".
  // Empty / omitted renders nothing at all.
  clientNote?: string | null;
}

// ── Add-to-calendar links ────────────────────────────────────────────────────
const cpad = (n: number) => String(n).padStart(2, "0");
function parseHM(raw: string | null | undefined): { h: number; m: number } {
  const mm = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i.exec(String(raw ?? "").trim());
  if (!mm) return { h: 9, m: 0 };
  let h = parseInt(mm[1], 10); const min = parseInt(mm[2], 10); const ap = mm[3]?.toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return { h, m: min };
}
// Google URL template + Outlook deeplink + an inline .ics (data URI) for Apple.
// Event = start (scheduled date + time) to start + the arrival window. Floating
// local time (no TZ), interpreted in the customer's own calendar, which is the
// local service tz.
function calendarLinks(o: PhesConfOpts): { google: string; apple: string; outlook: string } | null {
  const [y, mo, d] = String(o.scheduledDateISO ?? "").slice(0, 10).split("-").map(Number);
  if (!y || !mo || !d) return null;
  const { h, m } = parseHM(o.scheduledTimeRaw);
  const start = new Date(Date.UTC(y, mo - 1, d, h, m, 0));
  const winMins = Number(o.windowMinutes) > 0 ? Number(o.windowMinutes) : 45;
  const end = new Date(start.getTime() + winMins * 60 * 1000);
  const floatUTC = (dt: Date) => `${dt.getUTCFullYear()}${cpad(dt.getUTCMonth() + 1)}${cpad(dt.getUTCDate())}T${cpad(dt.getUTCHours())}${cpad(dt.getUTCMinutes())}00`;
  const isoUTC = (dt: Date) => `${dt.getUTCFullYear()}-${cpad(dt.getUTCMonth() + 1)}-${cpad(dt.getUTCDate())}T${cpad(dt.getUTCHours())}:${cpad(dt.getUTCMinutes())}:00`;
  const s = floatUTC(start), e = floatUTC(end);
  const title = `${o.companyName} cleaning`;
  const details = `Your ${o.service} with ${o.companyName}. Arrival window ${o.arrivalWindow}.`;
  const loc = o.address || "";
  const enc = encodeURIComponent;
  const google = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(title)}&dates=${s}/${e}&details=${enc(details)}&location=${enc(loc)}`;
  const outlook = `https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&subject=${enc(title)}&startdt=${enc(isoUTC(start))}&enddt=${enc(isoUTC(end))}&body=${enc(details)}&location=${enc(loc)}`;
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Phes//Booking//EN", "BEGIN:VEVENT",
    `DTSTART:${s}`, `DTEND:${e}`, `SUMMARY:${title}`,
    `LOCATION:${loc.replace(/([,;])/g, "\\$1")}`, `DESCRIPTION:${details.replace(/([,;])/g, "\\$1")}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  // Apple: prefer a hosted .ics URL (email clients block data: URIs, so the
  // inline fallback below is effectively dead in Gmail/Apple Mail).
  const apple = o.icsUrl || `data:text/calendar;charset=utf-8,${enc(ics)}`;
  return { google, apple, outlook };
}
function calButton(label: string, href: string): string {
  return `<a class="calbtn" href="${escAttr(href)}" style="display:inline-block;padding:9px 16px;border:1px solid ${BORDER};border-radius:7px;font-family:${FONT};font-size:13px;font-weight:600;color:${INK};text-decoration:none;background:#ffffff;">${esc(label)}</a>`;
}

export function renderPhesBookingConfirmation(o: PhesConfOpts): string {
  const mapsHref = o.address ? `https://maps.google.com/?q=${encodeURIComponent(o.address)}` : null;
  const cal = calendarLinks(o);

  const calBlock = cal ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:14px 0 0;">
      <div style="font-family:${FONT};font-size:11px;font-weight:700;color:${MUTE};margin:0 0 9px;text-transform:uppercase;letter-spacing:.06em;">Add to calendar</div>
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td class="calcell" style="padding:0 8px 0 0;">${calButton("Google", cal.google)}</td>
        <td class="calcell" style="padding:0 8px 0 0;">${calButton("Apple", cal.apple)}</td>
        <td class="calcell" style="padding:0;">${calButton("Outlook", cal.outlook)}</td>
      </tr></table>
    </td></tr></table>` : "";

  // A full-width colspan row here used to run past the label/value grid and
  // break the card's right edge. Keep it in the grid with the qualifier tucked
  // under the amount.
  const paymentRow = o.paymentTotal
    ? detailRowNote("Payment", o.paymentTotal, o.hasCardOnFile
        ? "Charged to your card on the day of service"
        : "Due at service. We accept card.")
    : "";

  const detailsCard = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BORDER};border-radius:10px;padding:4px 18px;margin:0 0 6px;">
      ${detailRow("Date", o.date)}
      ${detailRow("Arrival window", o.arrivalWindow)}
      ${detailRow("Service", o.service)}
      ${o.estimatedTime ? detailRow("Estimated time", o.estimatedTime) : ""}
      ${paymentRow}
      ${detailRow("Address", o.address || "On file", mapsHref)}
    </table>`;

  const breakdown = o.servicesBreakdownHtml
    ? `${h3("Price breakdown")}${o.servicesBreakdownHtml}`
    : "";

  // The office's note for this visit. Plain text typed into a textarea, so it is
  // escaped and its newlines become <br> rather than collapsing into one run-on
  // line. A quiet bordered panel: it must read as information about the booking,
  // not as marketing, so it deliberately does not use the colored callout style
  // the offers and guarantees use.
  const noteText = String(o.clientNote ?? "").trim();
  const clientNote = noteText
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 0;border:1px solid ${BORDER};border-left:3px solid ${BRAND};border-radius:8px;">
        <tr><td style="padding:14px 16px;font-family:${FONT};">
          <div style="font-size:11px;font-weight:700;color:${MUTE};text-transform:uppercase;letter-spacing:.06em;margin:0 0 6px;">A note about your visit</div>
          <div style="font-size:14px;color:${INK};line-height:1.6;">${esc(noteText).replace(/\r?\n/g, "<br />")}</div>
        </td></tr>
      </table>`
    : "";

  const checklist = `<p style="margin:14px 0 0;font-family:${FONT};font-size:14px;color:${INK};line-height:1.6;"><strong>Curious what's included?</strong> See our full <a href="${escAttr(o.checklistUrl)}" style="color:${BRAND};text-decoration:none;font-weight:600;">Cleaning Checklist &rarr;</a></p>`;

  return phesEmailShell({
    title: "Your cleaning is confirmed",
    logoUrl: o.logoUrl,
    companyName: o.companyName,
    bannerHtml: `Your cleaning is confirmed for ${esc(o.date)}`,
    companyPhone: o.companyPhone,
    companyPhoneTel: o.companyPhoneTel,
    companyEmail: o.companyEmail,
    website: o.website,
    bodyHtml: `
      <p style="margin:22px 0 16px;font-family:${FONT};font-size:15px;color:${INK};line-height:1.6;">Hi ${esc(o.firstName) || "there"}, thanks for booking with ${esc(o.companyName)}. Here are your details:</p>

      ${detailsCard}
      ${calBlock}
      ${clientNote}

      <p style="margin:16px 0 0;font-family:${FONT};font-size:13px;color:${MUTE};line-height:1.6;">We'll email and text you reminders 3 days and 1 day before your appointment, plus a text the moment your cleaner is on the way.</p>

      ${breakdown}
      ${checklist}

      ${h3("Cancellation & rescheduling")}
      <p style="margin:0 0 10px;font-family:${FONT};font-size:14px;color:${INK};line-height:1.6;">We hold this time exclusively for you. Please give us at least <strong>48 business hours</strong> notice to cancel or reschedule. Sundays don't count.</p>
      <ul style="margin:0 0 8px;padding-left:20px;font-family:${FONT};font-size:14px;color:${INK};line-height:1.9;">
        <li>Monday appointments: notify us by <strong>Friday 6:00 PM CT</strong>.</li>
        <li>Tuesday appointments: notify us by <strong>Saturday 12:00 PM CT</strong>.</li>
        <li>Late cancels and no-shows are billed at 100%.</li>
        <li><strong>Only ONE reschedule allowed per appointment, total.</strong> Any additional reschedule request is treated as a late cancel and billed at 100% of the service fee, <strong>regardless of how much notice you give</strong>.</li>
        <li>20-minute lockout limit. If we can't reach you, the visit is forfeited and billed.</li>
      </ul>

      ${h3("Before we arrive")}
      <ul style="margin:0 0 8px;padding-left:20px;font-family:${FONT};font-size:14px;color:${INK};line-height:1.9;">
        <li>Confirm your entry method (be home, key/code, or lockbox).</li>
        <li>Clear surfaces; make sure running water, power, and lighting are on.</li>
      </ul>

      ${o.showOverageNote ? callout("#FEF7ED", "#D97706", "#92400E", "!", "If your home needs extra time",
        `Deep cleans and move in/out cleans are flat-rate estimates based on the condition you described. If the home needs more time than we expected, <strong>we'll contact you first</strong> before doing any extra work. Additional time is billed at <strong>$70/hour per cleaner</strong>.`) : ""}

      ${callout(BLUE_BG, BLUE_FG, BLUE_INK, "&#10003;", "Our 24-hour guarantee",
        `If we miss a spot, tell us within 24 hours and we'll come back and re-clean it at no charge. No questions asked.`)}

      ${(o.showRecurringOffer === false || o.commercial) ? "" : callout(GREEN_BG, GREEN_FG, GREEN_INK, "%", "Get 15% OFF your second appointment",
        `Book a recurring service (weekly, biweekly, or monthly) by the end of your appointment day and we'll take 15% off your second visit. You'll also get preferred scheduling and the same technician each visit. Call ${esc(o.companyPhone)} or reply to set it up.`)}

      <!-- Fine print -->
      ${o.commercial
        ? `<p style="margin:22px 0 0;font-family:${FONT};font-size:12px;color:#9E9B94;line-height:1.6;"><strong style="color:${MUTE};">Pricing:</strong> This visit is $180 for up to 3 hours of cleaning. Any time beyond that is billed at $60 per additional hour, and we'll confirm with you before going over.</p>`
        : o.showOverageNote ? "" : `<p style="margin:22px 0 0;font-family:${FONT};font-size:12px;color:#9E9B94;line-height:1.6;"><strong style="color:${MUTE};">Pricing:</strong> Flat-rate estimates assume the home matches what you described. If conditions differ significantly, we'll send an updated estimate. Extra time bills at $70/hour per cleaner.</p>`}
      <p style="margin:10px 0 0;font-family:${FONT};font-size:12px;color:#9E9B94;line-height:1.6;"><strong style="color:${MUTE};">Non-solicitation:</strong> By using our services, you agree not to solicit, hire, or contract any Phes staff member privately. Breach terminates your service agreement.</p>
      <p style="margin:10px 0 0;font-family:${FONT};font-size:12px;color:#9E9B94;line-height:1.6;">Review our full <a href="https://${escAttr(o.website)}/terms" style="color:${BRAND};text-decoration:underline;">Terms and Conditions</a> and <a href="https://${escAttr(o.website)}/privacy" style="color:${BRAND};text-decoration:underline;">Privacy Policy</a>.</p>`,
  });
}
