// ─────────────────────────────────────────────────────────────────────────────
// Service-agreement emails, in the Phes house style.
//
// [agreement-brand 2026-08-19] The two agreement emails were the only customer
// mail still on the generic notification wrapper: a logo on a white bar, a
// paragraph, and one grey line of footer. Next to a booking confirmation they
// read like they came from a different company, which is a bad look on the one
// message that asks somebody to sign a contract.
//
// This wraps them in the same shell the booking confirmation and the lead
// acknowledgement use. It deliberately wraps the TEMPLATE body rather than
// replacing it, so the office can still rewrite the words in Settings and the
// email stays on brand no matter what they type. The default wording lives in
// the seeded templates in phes-data-migration.ts and is more formal than an
// order email on purpose: this is a contract.
// ─────────────────────────────────────────────────────────────────────────────

import { phesEmailShell } from "./phes-email-shell.js";

export interface AgreementShellOpts {
  logoUrl: string;
  companyName: string;
  companyPhone: string;
  companyEmail: string;
  /** Subject-line-ish title; some clients show it as the preview line. */
  title: string;
  /** The one-line coloured banner under the logo. */
  banner: string;
}

/** tel: hrefs choke on the display formatting, so strip to digits. */
function telOf(phone: string): string {
  return String(phone || "").replace(/[^0-9+]/g, "");
}

export function agreementEmailShell(o: AgreementShellOpts, bodyHtml: string): string {
  return phesEmailShell({
    title: o.title,
    logoUrl: o.logoUrl,
    companyName: o.companyName || "Phes",
    bannerHtml: o.banner,
    bodyHtml,
    companyPhone: o.companyPhone,
    companyPhoneTel: telOf(o.companyPhone),
    companyEmail: o.companyEmail,
    website: "phes.io",
  });
}
