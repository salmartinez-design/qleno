// [confirmation-email Pass2] Pure, dependency-free renderer for the customer
// booking-confirmation email. No DB / Express imports so it can be unit-rendered
// and previewed in isolation. Mail-client-safe: table layout, inline styles,
// Plus Jakarta Sans + sans-serif fallback. Replaces the shared wrapEmailHtml
// chrome for THIS email only (via sendNotification's renderEmail opt-in) — the
// other transactional emails are untouched.

// 24-hr "HH:MM" → 12-hr "9:00 AM". Leaves non-times untouched.
export function fmtTime12h(t: string | null): string {
  if (!t) return "Your scheduled window";
  const [h, m] = String(t).split(":").map(Number);
  if (Number.isNaN(h)) return t;
  const ampm = h < 12 ? "AM" : "PM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m || 0).padStart(2, "0")} ${ampm}`;
}

const escAttr = (s: string) => String(s).replace(/"/g, "&quot;");

// Pull the per-company policy copy ("What to expect / Cancellation & reschedule
// policy / Our satisfaction guarantee") VERBATIM out of the merged job_scheduled
// email body. The seeded body lists those sections between "What to expect" and
// the trailing "Questions?" line. Fallback returns the whole body so no copy is
// ever dropped if a tenant customized the template and the markers move.
export function extractPolicyCopy(mergedBody: string): string {
  const startKey = mergedBody.indexOf("What to expect");
  if (startKey < 0) return mergedBody; // never drop copy
  const start = mergedBody.lastIndexOf("<p", startKey);
  const qKey = mergedBody.indexOf("Questions?", start);
  const end = qKey >= 0 ? mergedBody.lastIndexOf("<p", qKey) : mergedBody.length;
  return mergedBody.slice(start >= 0 ? start : startKey, end > 0 ? end : mergedBody.length);
}

// ── Policy-copy brand styling ────────────────────────────────────────────────
// The authored body's section headings + copy come through as plain HTML. Give
// the email a branded feel: accent every <h3> heading (brand color + hairline),
// and wrap the "15% off" and "24-hour guarantee" sections in colored callout
// tables (single-cell <table> for email-client compatibility). All no-ops when a
// heading/section isn't present, so an unformatted body is passed through
// unchanged. Headings must be <h3> to be styled — plain-text lines are left as-is.
const BRAND_ACCENT = "#5B9BD5";
const HEAD_RULE = "#D6E3F2";

// Style every <h3>/<h2> that doesn't already carry an inline style (callout
// headings, styled below, are skipped by the negative lookahead).
function styleHeadings(html: string, font: string): string {
  return html
    .replace(/<h3(?![^>]*\bstyle=)([^>]*)>/gi,
      (_m, a) => `<h3${a} style="font-family:${font};font-size:15px;font-weight:700;color:${BRAND_ACCENT};border-bottom:2px solid ${HEAD_RULE};padding-bottom:5px;margin:22px 0 10px;">`)
    .replace(/<h2(?![^>]*\bstyle=)([^>]*)>/gi,
      (_m, a) => `<h2${a} style="font-family:${font};font-size:17px;font-weight:700;color:${BRAND_ACCENT};border-bottom:2px solid ${HEAD_RULE};padding-bottom:6px;margin:24px 0 12px;">`);
}

// Wrap the <h3> section whose heading text matches `re` (heading + following
// content up to the next <h3>, or end) in a colored callout table. No-op if not
// found. The section heading is recolored to the callout's own dark tone.
function wrapCallout(html: string, re: RegExp, bg: string, fg: string, headFg: string, font: string): string {
  const headings = [...html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)];
  for (const h of headings) {
    const text = h[1].replace(/<[^>]+>/g, "");
    if (!re.test(text)) continue;
    const start = h.index ?? 0;
    const afterHeading = start + h[0].length;
    const rel = html.slice(afterHeading).search(/<h3\b/i);
    const end = rel === -1 ? html.length : afterHeading + rel;
    let section = html.slice(start, end).replace(/<h3\b[^>]*>/i,
      `<h3 style="font-family:${font};font-size:15px;font-weight:700;color:${headFg};margin:0 0 6px;">`);
    const boxed = `<table role="presentation" cellpadding="16" cellspacing="0" style="width:100%;background:${bg};border-radius:8px;margin:16px 0;"><tr><td style="font-family:${font};font-size:14px;color:${fg};line-height:1.6;">${section}</td></tr></table>`;
    return html.slice(0, start) + boxed + html.slice(end);
  }
  return html;
}

export function stylePolicyCopy(html: string, font: string): string {
  if (!html) return html;
  let out = wrapCallout(html, /15%\s*off/i, "#E1F5EE", "#04342C", "#0F6E56", font);          // green — promo
  out = wrapCallout(out, /24[\s-]*h(?:ou)?r\s*guarantee/i, "#E6F1FB", "#042C53", "#185FA5", font); // blue — guarantee
  return styleHeadings(out, font);
}

export type ConfEmailOpts = {
  logoUrl: string; companyName: string; clientFirst: string;
  apptDate: string; apptTime: string; serviceType: string;
  serviceAddress: string; mapsHref: string | null;
  techFirst: string | null; techAvatar: string | null;
  link: string | null; phone: string; phoneTel: string; email: string;
  qlenoMark: string; policyCopyHtml: string;
  // [services-breakdown] Pre-rendered {{services_breakdown}} table HTML. This
  // renderer rebuilds the email from structured fields and otherwise drops the
  // authored body, so an inserted breakdown chip would silently vanish on the
  // ONE email it matters most for — pass it through and render it explicitly.
  servicesBreakdownHtml?: string | null;
};

export function renderConfirmationEmail(o: ConfEmailOpts): string {
  const FONT = "'Plus Jakarta Sans', Arial, Helvetica, sans-serif";
  const NAVY = "#0A0E1A", MINT = "#00C9A0", BG = "#F7F6F3", INK = "#1A1917", MUTE = "#6B6860", BORDER = "#E5E2DC", SUBLINE = "#9DA3B0";
  const initial = (o.techFirst || "?").trim().charAt(0).toUpperCase() || "?";

  // Round 36px cleaner avatar: photo inside a mint cell so a blocked image falls
  // back to the initial on mint (bgcolor + alt), never a broken image.
  const avatarCell = `
    <td width="36" height="36" bgcolor="${MINT}" align="center" valign="middle" style="width:36px;height:36px;border-radius:18px;color:#ffffff;font-family:${FONT};font-size:15px;font-weight:700;mso-line-height-rule:exactly;line-height:36px;overflow:hidden;">${
      o.techAvatar
        ? `<img src="${escAttr(o.techAvatar)}" width="36" height="36" alt="${escAttr(initial)}" style="width:36px;height:36px;border-radius:18px;display:block;object-fit:cover;border:0;" />`
        : initial
    }</td>`;

  const detailRow = (label: string, value: string) => `
    <tr>
      <td style="padding:11px 0;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:13px;color:${MUTE};">${label}</td>
      <td align="right" style="padding:11px 0;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:14px;font-weight:600;color:${INK};">${value}</td>
    </tr>`;

  const addressVal = o.mapsHref
    ? `<a href="${escAttr(o.mapsHref)}" style="color:${INK};text-decoration:none;font-weight:600;">${o.serviceAddress}</a>`
    : o.serviceAddress;

  const cleanerRow = o.techFirst ? `
    <tr>
      <td style="padding:11px 0;font-family:${FONT};font-size:13px;color:${MUTE};">Your cleaner</td>
      <td align="right" style="padding:11px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" align="right"><tr>
          <td style="font-family:${FONT};font-size:14px;font-weight:600;color:${INK};padding-right:10px;">${o.techFirst}</td>
          ${avatarCell}
        </tr></table>
      </td>
    </tr>` : "";

  // Itemized booking table, rendered under the appointment details when the
  // template body uses the {{services_breakdown}} chip.
  const breakdown = o.servicesBreakdownHtml ? `
    <div style="margin:22px 0 0;">
      <div style="font-family:${FONT};font-size:13px;font-weight:700;color:${INK};margin:0 0 6px;">Your booking</div>
      ${o.servicesBreakdownHtml}
    </div>` : "";

  const cta = o.link ? `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto 4px;"><tr>
      <td bgcolor="${MINT}" align="center" style="border-radius:8px;">
        <a href="${escAttr(o.link)}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:700;color:${NAVY};text-decoration:none;border-radius:8px;">View your appointment</a>
      </td>
    </tr></table>` : "";

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your cleaning is confirmed</title></head>
<body style="margin:0;padding:0;background:${BG};font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 14px;"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">
    <!-- Navy masthead -->
    <tr><td bgcolor="${NAVY}" style="background:${NAVY};padding:20px 28px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td valign="middle" style="padding-right:13px;"><img src="${escAttr(o.logoUrl)}" width="60" alt="${escAttr(o.companyName)}" style="height:60px;width:auto;border-radius:8px;background:#ffffff;display:block;border:0;" /></td>
        <td valign="middle">
          <div style="font-family:${FONT};font-size:18px;font-weight:700;color:#ffffff;line-height:1.2;">${o.companyName}</div>
          <div style="font-family:${FONT};font-size:12px;color:${SUBLINE};line-height:1.4;">Residential &amp; Commercial Cleaning</div>
        </td>
      </tr></table>
    </td></tr>
    <!-- Body -->
    <tr><td style="padding:28px;">
      <div style="display:inline-block;padding:4px 12px;border-radius:999px;font-family:${FONT};font-size:12px;font-weight:700;background:#EAF7F3;color:#0A7C63;margin-bottom:14px;">Confirmed</div>
      <h1 style="margin:0 0 6px;font-family:${FONT};font-size:22px;font-weight:700;color:${INK};">Your cleaning is confirmed</h1>
      <p style="margin:0 0 22px;font-family:${FONT};font-size:14px;color:${MUTE};">${o.clientFirst ? `Hi ${o.clientFirst}, here are your appointment details.` : "Here are your appointment details."}</p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BORDER};border-radius:10px;padding:2px 16px;">
        ${detailRow("Date", o.apptDate)}
        ${detailRow("Time", o.apptTime)}
        ${detailRow("Service", o.serviceType)}
        ${detailRow("Address", addressVal)}
        ${cleanerRow}
      </table>

      ${breakdown}

      ${cta}

      <div style="margin:24px 0 0;font-family:${FONT};font-size:14px;color:${INK};line-height:1.6;">${stylePolicyCopy(o.policyCopyHtml, FONT)}</div>

      <p style="margin:22px 0 0;text-align:center;font-family:${FONT};font-size:13px;color:${MUTE};line-height:1.6;">
        Questions? Call or text <a href="tel:${escAttr(o.phoneTel)}" style="color:${INK};font-weight:700;text-decoration:none;">${o.phone}</a> &middot; <a href="mailto:${escAttr(o.email)}" style="color:${INK};font-weight:700;text-decoration:none;">${o.email}</a>
      </p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;border-top:1px solid ${BORDER};"><tr>
        <td align="center" style="padding-top:16px;font-family:${FONT};font-size:11px;color:#9E9B94;">
          <img src="${escAttr(o.qlenoMark)}" width="14" height="14" alt="" style="width:14px;height:14px;vertical-align:middle;border:0;" />
          <span style="vertical-align:middle;">&nbsp;Powered by <strong style="color:#9E9B94;">Qleno</strong></span>
        </td>
      </tr></table>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}
