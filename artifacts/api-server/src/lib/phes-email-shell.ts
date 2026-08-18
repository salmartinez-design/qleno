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
  return `<tr>
    <td style="padding:11px 0;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:13px;color:${MUTE};white-space:nowrap;">${esc(label)}</td>
    <td align="right" style="padding:11px 0;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:14px;color:${INK};">${val}</td>
  </tr>`;
}

export interface PhesShellOpts {
  title: string;        // <title> — some clients show it as the preview line
  logoUrl: string;
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
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:${BG};font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 14px;"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">

    <!-- Header: white, centered logo, thin brand underline -->
    <tr><td align="center" style="padding:28px 32px 22px;border-bottom:3px solid ${BRAND};">
      <img src="${escAttr(o.logoUrl)}" alt="${escAttr(o.companyName)}" height="80" style="height:80px;width:auto;max-width:300px;display:block;border:0;" />
    </td></tr>

    <!-- Confirmation banner -->
    <tr><td style="background:${BANNER_BG};padding:16px 32px;text-align:center;">
      <span style="font-family:${FONT};font-size:16px;font-weight:700;color:${BLUE_INK};">${o.bannerHtml}</span>
    </td></tr>

    <!-- Body -->
    <tr><td style="padding:8px 32px 30px;">${o.bodyHtml}
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
