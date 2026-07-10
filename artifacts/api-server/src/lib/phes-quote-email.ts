// ─────────────────────────────────────────────────────────────────────────────
// PHES bespoke Quote email — the "here's your quote" receipt a lead gets after
// an online quote. Deliberately mirrors the Booking Confirmation design
// (phes-booking-confirmation.ts): same header/logo, blue banner, detail box,
// brand h3 section rules, callouts, navy footer — so every Phes email reads as
// one family. Difference is content: it lists EVERY open quote the lead has as
// its own itemized option, each with its own "Book" button that drops them into
// the booking flow for that specific quote.
//
// Mail-client-safe: table layout, inline styles only, no external CSS.
// ─────────────────────────────────────────────────────────────────────────────

const FONT = "'Plus Jakarta Sans', Arial, Helvetica, sans-serif";
const BRAND = "#5B9BD5";
const NAVY = "#0A0E1A";
const BG = "#F7F6F3";
const INK = "#1A1917";
const MUTE = "#6B6860";
const BORDER = "#E5E2DC";
const RULE = "#D6E3F2";
const GREEN_FG = "#0F6E56";
const BLUE_BG = "#E6F1FB", BLUE_FG = "#185FA5", BLUE_INK = "#042C53";

const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => String(s ?? "").replace(/"/g, "&quot;");

export interface QuoteOption {
  title: string;        // service, e.g. "Deep Clean"
  freqLabel: string;    // "One-time" / "Every 2 weeks" (may be "")
  estTime?: string;     // "~3.5 hours" ("" / omitted hides the line)
  rows: { label: string; amount: string }[]; // itemized: base + each add-on (amount incl. "$"/"−$")
  total: string;        // "$698.00"
  bookUrl: string;      // deep-link into the booking flow for THIS quote (may be "")
}

export interface PhesQuoteOpts {
  logoUrl: string;
  companyName: string;
  companyPhone: string;
  companyPhoneTel: string;
  companyEmail: string;
  website: string;         // "phes.io"
  firstName: string;
  serviceAddress: string;
  options: QuoteOption[];
  checklistUrl: string;
}

// ── Building blocks (mirrors the booking confirmation) ───────────────────────
function h3(text: string): string {
  return `<h3 style="font-family:${FONT};font-size:16px;font-weight:700;color:${BRAND};border-bottom:2px solid ${RULE};padding-bottom:6px;margin:28px 0 12px;">${esc(text)}</h3>`;
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

// One quote rendered as a bordered card: heading (service · frequency), the
// itemized rows, a bold Total, and a full-width Book button when a link exists.
function optionCard(o: QuoteOption, single: boolean): string {
  const heading = single
    ? ""
    : `<div style="font-family:${FONT};font-size:15px;font-weight:800;color:${INK};margin:0 0 10px;">${esc(o.title)}${o.freqLabel ? ` <span style="color:${MUTE};font-weight:600;">&middot; ${esc(o.freqLabel)}</span>` : ""}</div>`;
  const estLine = o.estTime
    ? `<div style="font-family:${FONT};font-size:13px;color:${MUTE};margin:0 0 6px;">Estimated time &middot; ${esc(o.estTime)}</div>`
    : "";
  const rows = o.rows.map(r => `<tr>
      <td style="padding:6px 0;font-family:${FONT};font-size:14px;color:${INK};">${esc(r.label)}</td>
      <td align="right" style="padding:6px 0;font-family:${FONT};font-size:14px;color:${INK};">${esc(r.amount)}</td>
    </tr>`).join("");
  const totalRow = `<tr>
      <td style="padding:9px 0 0;border-top:1px solid ${BORDER};font-family:${FONT};font-size:14px;font-weight:700;color:${INK};">Total</td>
      <td align="right" style="padding:9px 0 0;border-top:1px solid ${BORDER};font-family:${FONT};font-size:14px;font-weight:700;color:${INK};">${esc(o.total)}</td>
    </tr>`;
  const bookBtn = o.bookUrl
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:16px 0 2px;">
        <a href="${escAttr(o.bookUrl)}" style="display:inline-block;padding:12px 26px;background:${BRAND};color:#ffffff;text-decoration:none;border-radius:8px;font-family:${FONT};font-size:15px;font-weight:700;">Book the ${esc(o.title)} &rarr;</a>
      </td></tr></table>`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BORDER};border-radius:10px;margin:0 0 14px;">
      <tr><td style="padding:16px 18px;">
        ${heading}
        ${estLine}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}${totalRow}</table>
        ${bookBtn}
      </td></tr>
    </table>`;
}

export function renderPhesQuote(o: PhesQuoteOpts): string {
  const single = o.options.length === 1;
  const optionsHtml = o.options.map(op => optionCard(op, single)).join("");

  const addressCard = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BORDER};border-radius:10px;margin:0 0 8px;">
      <tr><td style="padding:14px 18px;font-family:${FONT};">
        <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${MUTE};margin:0 0 4px;">Service address</div>
        <div style="font-size:16px;font-weight:700;color:${INK};">${esc(o.serviceAddress) || "On file"}</div>
      </td></tr>
    </table>`;

  const checklist = `<p style="margin:14px 0 0;font-family:${FONT};font-size:14px;color:${INK};line-height:1.6;"><strong>Curious what's included?</strong> See our full <a href="${escAttr(o.checklistUrl)}" style="color:${BRAND};text-decoration:none;font-weight:600;">Cleaning Checklist &rarr;</a></p>`;

  const phoneBtn = `<a href="tel:${escAttr(o.companyPhoneTel)}" style="display:inline-block;margin-top:10px;padding:9px 18px;background:${GREEN_FG};color:#ffffff;text-decoration:none;border-radius:7px;font-family:${FONT};font-size:14px;font-weight:700;">Call ${esc(o.companyPhone)}</a>`;

  const optionsIntro = single
    ? "Here's your quote. Book it right below when you're ready, or reply with any questions."
    : "Here are your options. Pick whichever fits and book it right below — or reply with any questions.";

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your quote from ${esc(o.companyName)}</title></head>
<body style="margin:0;padding:0;background:${BG};font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 14px;"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">

    <!-- Header: white, centered logo, brand underline -->
    <tr><td align="center" style="padding:28px 32px 22px;border-bottom:3px solid ${BRAND};">
      <img src="${escAttr(o.logoUrl)}" alt="${escAttr(o.companyName)}" height="80" style="height:80px;width:auto;max-width:300px;display:block;border:0;" />
    </td></tr>

    <!-- Banner -->
    <tr><td style="background:#EAF2FB;padding:16px 32px;text-align:center;">
      <span style="font-family:${FONT};font-size:16px;font-weight:700;color:${BLUE_INK};">Here's your quote from ${esc(o.companyName)}</span>
    </td></tr>

    <!-- Body -->
    <tr><td style="padding:22px 32px 30px;">
      <p style="margin:0 0 18px;font-family:${FONT};font-size:15px;color:${INK};line-height:1.6;">Hi ${esc(o.firstName) || "there"}, thanks for reaching out to ${esc(o.companyName)}. ${optionsIntro}</p>

      ${addressCard}

      ${h3("Your quote")}
      ${optionsHtml}
      ${checklist}

      ${h3("Cancellation & rescheduling")}
      <p style="margin:0 0 10px;font-family:${FONT};font-size:14px;color:${INK};line-height:1.6;">Once you book, we hold that time exclusively for you. Please give us at least <strong>48 business hours</strong> notice to cancel or reschedule — Sundays don't count.</p>
      <ul style="margin:0 0 8px;padding-left:20px;font-family:${FONT};font-size:14px;color:${INK};line-height:1.9;">
        <li>Monday appointments: notify us by <strong>Friday 6:00 PM CT</strong>.</li>
        <li>Tuesday appointments: notify us by <strong>Saturday 12:00 PM CT</strong>.</li>
        <li>Late cancels and no-shows are billed at 100%.</li>
        <li>20-minute lockout limit. If we can't reach you, the visit is forfeited and billed.</li>
      </ul>

      ${callout(BLUE_BG, BLUE_FG, BLUE_INK, "&#10003;", "Our 24-hour guarantee",
        `If we miss a spot, tell us within 24 hours and we'll come back and re-clean it at no charge. No questions asked.`)}

      <!-- Fine print -->
      <p style="margin:22px 0 0;font-family:${FONT};font-size:12px;color:#9E9B94;line-height:1.6;"><strong style="color:${MUTE};">Pricing:</strong> Flat-rate estimates assume the home matches what you described. If conditions differ significantly, we'll send an updated estimate. Extra time bills at $70/hour per cleaner.</p>
      <p style="margin:10px 0 0;font-family:${FONT};font-size:12px;color:#9E9B94;line-height:1.6;"><strong style="color:${MUTE};">Non-solicitation:</strong> By using our services, you agree not to solicit, hire, or contract any ${esc(o.companyName)} staff member privately. Breach terminates your service agreement.</p>
      <p style="margin:10px 0 0;font-family:${FONT};font-size:12px;color:#9E9B94;line-height:1.6;">Review our full <a href="https://${escAttr(o.website)}/terms" style="color:${BRAND};text-decoration:underline;">Terms and Conditions</a> and <a href="https://${escAttr(o.website)}/privacy" style="color:${BRAND};text-decoration:underline;">Privacy Policy</a>.</p>

      <p style="margin:20px 0 0;font-family:${FONT};font-size:14px;color:${INK};line-height:1.6;">Questions? Call or text <a href="tel:${escAttr(o.companyPhoneTel)}" style="color:${BRAND};text-decoration:none;font-weight:600;">${esc(o.companyPhone)}</a> or just reply to this email.<br/>${phoneBtn}</p>
    </td></tr>

    <!-- Footer: navy band -->
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
