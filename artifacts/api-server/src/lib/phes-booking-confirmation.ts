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

const FONT = "'Plus Jakarta Sans', Arial, Helvetica, sans-serif";
const BRAND = "#5B9BD5";     // PHES brand blue
const NAVY = "#0A0E1A";
const BG = "#F7F6F3";
const INK = "#1A1917";
const MUTE = "#6B6860";
const BORDER = "#E5E2DC";
const RULE = "#D6E3F2";      // hairline under headings
const GREEN_BG = "#E1F5EE", GREEN_FG = "#0F6E56", GREEN_INK = "#04342C";
const BLUE_BG = "#E6F1FB", BLUE_FG = "#185FA5", BLUE_INK = "#042C53";

const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => String(s ?? "").replace(/"/g, "&quot;");

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
// Event = start (scheduled date + time) to +2h. Floating local time (no TZ) —
// interpreted in the customer's own calendar, which is the local service tz.
function calendarLinks(o: PhesConfOpts): { google: string; apple: string; outlook: string } | null {
  const [y, mo, d] = String(o.scheduledDateISO ?? "").slice(0, 10).split("-").map(Number);
  if (!y || !mo || !d) return null;
  const { h, m } = parseHM(o.scheduledTimeRaw);
  const start = new Date(Date.UTC(y, mo - 1, d, h, m, 0));
  const end = new Date(start.getTime() + 2 * 3600 * 1000);
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
  const apple = `data:text/calendar;charset=utf-8,${enc(ics)}`;
  return { google, apple, outlook };
}
function calButton(label: string, href: string): string {
  return `<a href="${escAttr(href)}" style="display:inline-block;padding:8px 14px;border:1px solid ${BORDER};border-radius:7px;font-family:${FONT};font-size:13px;font-weight:600;color:${INK};text-decoration:none;background:#ffffff;">${esc(label)}</a>`;
}

// ── Building blocks ───────────────────────────────────────────────────────────
function h3(text: string): string {
  return `<h3 style="font-family:${FONT};font-size:16px;font-weight:700;color:${BRAND};border-bottom:2px solid ${RULE};padding-bottom:6px;margin:28px 0 12px;">${esc(text)}</h3>`;
}
function detailRow(label: string, value: string, mapsHref?: string | null): string {
  const val = mapsHref
    ? `<a href="${escAttr(mapsHref)}" style="color:${INK};text-decoration:none;font-weight:600;">${esc(value)}</a>`
    : `<span style="font-weight:600;">${esc(value)}</span>`;
  return `<tr>
    <td style="padding:11px 0;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:13px;color:${MUTE};white-space:nowrap;">${esc(label)}</td>
    <td align="right" style="padding:11px 0;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:14px;color:${INK};">${val}</td>
  </tr>`;
}
function callout(bg: string, fg: string, ink: string, badge: string, title: string, bodyHtml: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};border-radius:10px;margin:16px 0;">
    <tr><td style="padding:18px 20px;font-family:${FONT};">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td width="30" valign="top" style="width:30px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td width="26" height="26" align="center" valign="middle" bgcolor="${fg}" style="width:26px;height:26px;border-radius:13px;color:#ffffff;font-size:14px;font-weight:700;font-family:${FONT};mso-line-height-rule:exactly;line-height:26px;">${badge}</td>
          </tr></table>
        </td>
        <td valign="top" style="padding-left:12px;">
          <div style="font-size:15px;font-weight:700;color:${fg};margin:2px 0 6px;">${esc(title)}</div>
          <div style="font-size:14px;color:${ink};line-height:1.6;">${bodyHtml}</div>
        </td>
      </tr></table>
    </td></tr>
  </table>`;
}

export function renderPhesBookingConfirmation(o: PhesConfOpts): string {
  const mapsHref = o.address ? `https://maps.google.com/?q=${encodeURIComponent(o.address)}` : null;
  const cal = calendarLinks(o);

  const calBlock = cal ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:16px 0 0;">
      <div style="font-family:${FONT};font-size:12px;color:${MUTE};margin:0 0 8px;text-transform:uppercase;letter-spacing:.05em;">Add to calendar</div>
      <table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr>
        <td style="padding:0 4px;">${calButton("Google", cal.google)}</td>
        <td style="padding:0 4px;">${calButton("Apple", cal.apple)}</td>
        <td style="padding:0 4px;">${calButton("Outlook", cal.outlook)}</td>
      </tr></table>
    </td></tr></table>` : "";

  const paymentRow = o.paymentTotal ? `<tr>
      <td colspan="2" style="padding:11px 0;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:13px;color:${INK};line-height:1.5;">
        <strong style="color:${MUTE};">Payment:</strong> ${o.hasCardOnFile
          ? `<strong>${esc(o.paymentTotal)}</strong> will be charged to your card on the day of service.`
          : `<strong>${esc(o.paymentTotal)}</strong> due at service. We accept card.`}
      </td>
    </tr>` : "";

  const detailsCard = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BORDER};border-radius:10px;padding:2px 18px;margin:0 0 8px;">
      ${detailRow("Date", o.date)}
      ${detailRow("Arrival window", o.arrivalWindow)}
      ${detailRow("Service", o.service)}
      ${o.estimatedTime ? detailRow("Estimated time", o.estimatedTime) : ""}
      ${paymentRow}
      ${detailRow("Address", o.address || "On file", mapsHref)}
    </table>`;

  const breakdown = o.servicesBreakdownHtml
    ? `${h3("Service details")}${o.servicesBreakdownHtml}`
    : "";

  const checklist = `<p style="margin:14px 0 0;font-family:${FONT};font-size:14px;color:${INK};line-height:1.6;"><strong>Curious what's included?</strong> See our full <a href="${escAttr(o.checklistUrl)}" style="color:${BRAND};text-decoration:none;font-weight:600;">Cleaning Checklist &rarr;</a></p>`;

  const phoneBtn = `<a href="tel:${escAttr(o.companyPhoneTel)}" style="display:inline-block;margin-top:10px;padding:9px 18px;background:${GREEN_FG};color:#ffffff;text-decoration:none;border-radius:7px;font-family:${FONT};font-size:14px;font-weight:700;">Call ${esc(o.companyPhone)}</a>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your cleaning is confirmed</title></head>
<body style="margin:0;padding:0;background:${BG};font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 14px;"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">

    <!-- Header: white, centered logo, thin brand underline -->
    <tr><td align="center" style="padding:28px 32px 22px;border-bottom:3px solid ${BRAND};">
      <img src="${escAttr(o.logoUrl)}" alt="${escAttr(o.companyName)}" height="80" style="height:80px;width:auto;max-width:300px;display:block;border:0;" />
    </td></tr>

    <!-- Confirmation banner -->
    <tr><td style="background:#EAF2FB;padding:16px 32px;text-align:center;">
      <span style="font-family:${FONT};font-size:16px;font-weight:700;color:${BLUE_INK};">Your cleaning is confirmed for ${esc(o.date)}</span>
    </td></tr>

    <!-- Body -->
    <tr><td style="padding:8px 32px 30px;">
      ${calBlock}

      <p style="margin:16px 0 0;text-align:center;font-family:${FONT};font-size:13px;font-style:italic;color:${MUTE};line-height:1.5;">You'll get email and text reminders 3 days and 1 day before your appointment, plus a text the moment your cleaner is on the way.</p>

      <p style="margin:22px 0 18px;font-family:${FONT};font-size:15px;color:${INK};line-height:1.6;">Hi ${esc(o.firstName) || "there"}, thanks for booking with ${esc(o.companyName)}. Here are your details:</p>

      ${detailsCard}
      ${breakdown}
      ${checklist}

      ${h3("Cancellation & rescheduling")}
      <p style="margin:0 0 10px;font-family:${FONT};font-size:14px;color:${INK};line-height:1.6;">We hold this time exclusively for you. Please give us at least <strong>48 business hours</strong> notice to cancel or reschedule — Sundays don't count.</p>
      <ul style="margin:0 0 8px;padding-left:20px;font-family:${FONT};font-size:14px;color:${INK};line-height:1.9;">
        <li>Monday appointments: notify us by <strong>Friday 6:00 PM CT</strong>.</li>
        <li>Tuesday appointments: notify us by <strong>Saturday 12:00 PM CT</strong>.</li>
        <li>Late cancels and no-shows are billed at 100%.</li>
        <li><strong>Only ONE reschedule allowed per appointment, total.</strong> Any additional reschedule request is treated as a late cancel and billed at 100% of the service fee — <strong>regardless of how much notice you give</strong>.</li>
        <li>20-minute lockout limit. If we can't reach you, the visit is forfeited and billed.</li>
      </ul>

      ${h3("Before we arrive")}
      <ul style="margin:0 0 8px;padding-left:20px;font-family:${FONT};font-size:14px;color:${INK};line-height:1.9;">
        <li>Confirm your entry method (be home, key/code, or lockbox).</li>
        <li>Clear surfaces; make sure running water, power, and lighting are on.</li>
      </ul>

      ${callout(BLUE_BG, BLUE_FG, BLUE_INK, "&#10003;", "Our 24-hour guarantee",
        `If we miss a spot, tell us within 24 hours and we'll come back and re-clean it at no charge. No questions asked.`)}

      ${callout(GREEN_BG, GREEN_FG, GREEN_INK, "%", "Get 15% OFF your second appointment",
        `Book a recurring service (weekly, biweekly, or monthly) by the end of your appointment day and we'll take 15% off your second visit. You'll also get preferred scheduling and the same technician each visit. Call ${esc(o.companyPhone)} or reply to set it up.<br/>${phoneBtn}`)}

      <!-- Fine print -->
      <p style="margin:22px 0 0;font-family:${FONT};font-size:12px;color:#9E9B94;line-height:1.6;"><strong style="color:${MUTE};">Pricing:</strong> Flat-rate estimates assume the home matches what you described. If conditions differ significantly, we'll send an updated estimate. Extra time bills at $70/hour per cleaner.</p>
      <p style="margin:10px 0 0;font-family:${FONT};font-size:12px;color:#9E9B94;line-height:1.6;"><strong style="color:${MUTE};">Non-solicitation:</strong> By using our services, you agree not to solicit, hire, or contract any Phes staff member privately. Breach terminates your service agreement.</p>
      <p style="margin:10px 0 0;font-family:${FONT};font-size:12px;color:#9E9B94;line-height:1.6;">Review our full <a href="https://${escAttr(o.website)}/terms" style="color:${BRAND};text-decoration:underline;">Terms and Conditions</a> and <a href="https://${escAttr(o.website)}/privacy" style="color:${BRAND};text-decoration:underline;">Privacy Policy</a>.</p>
    </td></tr>

    <!-- Footer: navy band, white text -->
    <tr><td style="background:${NAVY};padding:22px 32px;text-align:center;">
      <div style="font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;margin:0 0 6px;">${esc(o.companyName)}</div>
      <div style="font-family:${FONT};font-size:13px;color:#9DA3B0;line-height:1.7;">
        <a href="tel:${escAttr(o.companyPhoneTel)}" style="color:#9DA3B0;text-decoration:none;">${esc(o.companyPhone)}</a>
        &nbsp;&middot;&nbsp;
        <a href="mailto:${escAttr(o.companyEmail)}" style="color:#9DA3B0;text-decoration:none;">${esc(o.companyEmail)}</a>
        &nbsp;&middot;&nbsp;
        <a href="https://${escAttr(o.website)}" style="color:#9DA3B0;text-decoration:none;">${esc(o.website)}</a>
      </div>
    </td></tr>

  </table>
</td></tr></table>
</body></html>`;
}
