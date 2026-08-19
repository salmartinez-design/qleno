// ─────────────────────────────────────────────────────────────────────────────
// PHES customer-email shell — the chrome every customer-facing PHES email
// shares: white card on warm grey, centered logo over a brand-blue rule, a
// coloured banner line, the body, and the navy contact footer.
//
// [email-standardize 2026-08-18] Extracted from phes-booking-confirmation.ts so
// the booking confirmation is no longer the only email that looks like Phes.
// Sal's rule is that every customer touch reads as one company, and before this
// the commercial and post-construction paths sent either nothing at all or a
// bare unbranded note. The booking confirmation's own markup is unchanged — it
// now renders through this shell instead of inlining it.
// ─────────────────────────────────────────────────────────────────────────────

export const FONT = "'Plus Jakarta Sans', Arial, Helvetica, sans-serif";
export const BRAND = "#5B9BD5";     // PHES brand blue
export const NAVY = "#0A0E1A";
export const BG = "#F7F6F3";
export const INK = "#1A1917";
export const MUTE = "#6B6860";
export const BORDER = "#E5E2DC";
export const RULE = "#D6E3F2";      // hairline under headings
export const GREEN_BG = "#E1F5EE", GREEN_FG = "#0F6E56", GREEN_INK = "#04342C";
export const BLUE_BG = "#E6F1FB", BLUE_FG = "#185FA5", BLUE_INK = "#042C53";
export const BANNER_BG = "#EAF2FB";

export const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const escAttr = (s: string) => String(s ?? "").replace(/"/g, "&quot;");

/** Section heading — brand-blue text over a hairline rule. */
export function h3(text: string): string {
  return `<h3 style="font-family:${FONT};font-size:16px;font-weight:700;color:${BRAND};border-bottom:2px solid ${RULE};padding-bottom:6px;margin:28px 0 12px;">${esc(text)}</h3>`;
}

/** Tinted panel with a round badge — used for guarantees, warnings, offers. */
export function callout(bg: string, fg: string, ink: string, badge: string, title: string, bodyHtml: string): string {
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

/** Detail table row. Pass mapsHref to make the value a link. */
export function detailRow(label: string, value: string, mapsHref?: string | null): string {
  const val = mapsHref
    ? `<a href="${escAttr(mapsHref)}" style="color:${INK};text-decoration:none;font-weight:600;">${esc(value)}</a>`
    : `<span style="font-weight:600;">${esc(value)}</span>`;
  return `<tr class="drow">
    <td class="dlabel" style="padding:11px 0;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:13px;color:${MUTE};white-space:nowrap;">${esc(label)}</td>
    <td class="dval" align="right" style="padding:11px 0;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:14px;color:${INK};">${val}</td>
  </tr>`;
}

/**
 * Detail row whose value carries a short qualifier under it. Keeps the label/
 * value grid intact instead of running a full-width sentence across the card,
 * which is what broke the right edge on the payment line.
 */
export function detailRowNote(label: string, value: string, note: string): string {
  return `<tr class="drow">
    <td class="dlabel" style="padding:11px 0;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:13px;color:${MUTE};white-space:nowrap;vertical-align:top;">${esc(label)}</td>
    <td class="dval" align="right" style="padding:11px 0;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:14px;color:${INK};">
      <span style="font-weight:600;">${esc(value)}</span>
      <span style="display:block;font-size:12px;color:${MUTE};line-height:1.5;margin-top:3px;">${esc(note)}</span>
    </td>
  </tr>`;
}

export interface PhesShellOpts {
  title: string;        // <title> — some clients show it as the preview line
  logoUrl: string;
  /**
   * Rendered logo box, in px. Set BOTH: Outlook desktop ignores width:auto and
   * falls back to the image's intrinsic size, which is how a 900px-wide mark
   * ends up bursting a 600px email. Defaults match the Phes mark (900x645).
   */
  logoWidth?: number;
  logoHeight?: number;
  companyName: string;
  bannerHtml: string;   // the one-line coloured banner under the logo
  bodyHtml: string;     // everything between banner and footer
  companyPhone: string;
  companyPhoneTel: string;
  companyEmail: string;
  website: string;
}

export function phesEmailShell(o: PhesShellOpts): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no">
<title>${esc(o.title)}</title>
<style>
  /* Phone. Apple Mail, iOS Mail and the Gmail apps honour this; Outlook
     desktop ignores it and keeps the 600px layout, which is what we want
     there. The inline styles below stay the desktop truth either way. */
  @media only screen and (max-width:600px) {
    .shell     { padding:12px 8px !important; }
    .card      { border-radius:10px !important; }
    .hdr       { padding:22px 20px 18px !important; }
    .banner    { padding:14px 20px !important; }
    .banner span { font-size:15px !important; }
    .body      { padding:6px 20px 24px !important; }
    .foot      { padding:20px 20px !important; }
    /* Label above value instead of a squeezed two-column row. */
    .drow .dlabel, .drow .dval {
      display:block !important; width:100% !important;
      text-align:left !important; border-bottom:0 !important;
    }
    .drow .dlabel { padding:12px 0 0 !important; }
    .drow .dval   { padding:2px 0 12px !important;
                    border-bottom:1px solid ${BORDER} !important; }
    .calbtn    { display:block !important; margin:0 0 8px !important; text-align:center !important; }
    .calcell   { display:block !important; width:100% !important; padding:0 !important; }
    .footlink  { display:block !important; padding:3px 0 !important; }
    .footsep   { display:none !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${BG};font-family:${FONT};">
<table role="presentation" class="shell" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 14px;"><tr><td align="center">
  <table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">

    <!-- Header: white, centered logo, thin brand underline -->
    <tr><td class="hdr" align="center" style="padding:26px 32px 22px;border-bottom:3px solid ${BRAND};">
      <img src="${escAttr(o.logoUrl)}" alt="${escAttr(o.companyName)}" width="${o.logoWidth ?? 126}" height="${o.logoHeight ?? 90}" style="width:${o.logoWidth ?? 126}px;height:${o.logoHeight ?? 90}px;max-width:100%;display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />
    </td></tr>

    <!-- Confirmation banner -->
    <tr><td class="banner" style="background:${BANNER_BG};padding:16px 32px;text-align:center;">
      <span style="font-family:${FONT};font-size:16px;font-weight:700;color:${BLUE_INK};">${o.bannerHtml}</span>
    </td></tr>

    <!-- Body -->
    <tr><td class="body" style="padding:8px 32px 30px;">${o.bodyHtml}
    </td></tr>

    <!-- Footer: navy band, white text -->
    <tr><td class="foot" style="background:${NAVY};padding:22px 32px;text-align:center;">
      <div style="font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;margin:0 0 6px;">${esc(o.companyName)}</div>
      <div style="font-family:${FONT};font-size:13px;color:#9DA3B0;line-height:1.7;">
        <a class="footlink" href="tel:${escAttr(o.companyPhoneTel)}" style="color:#9DA3B0;text-decoration:none;">${esc(o.companyPhone)}</a>
        <span class="footsep">&nbsp;&middot;&nbsp;</span>
        <a class="footlink" href="mailto:${escAttr(o.companyEmail)}" style="color:#9DA3B0;text-decoration:none;">${esc(o.companyEmail)}</a>
        <span class="footsep">&nbsp;&middot;&nbsp;</span>
        <a class="footlink" href="https://${escAttr(o.website)}" style="color:#9DA3B0;text-decoration:none;">${esc(o.website)}</a>
      </div>
    </td></tr>

  </table>
</td></tr></table>
</body></html>`;
}
