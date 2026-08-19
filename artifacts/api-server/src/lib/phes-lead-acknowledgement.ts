// ─────────────────────────────────────────────────────────────────────────────
// PHES post-construction request acknowledgement.
//
// [post-construction-ack 2026-08-18] Submitting the post-construction form used
// to email info@phes.io and nothing else — the customer got a spinner, a
// thank-you screen, and then silence. They had no record of what they sent, no
// confirmation it arrived, and no idea when to expect a number, which is how a
// lead that is ready to buy ends up calling a competitor instead.
//
// This is an acknowledgement, not a quote: post-construction is priced off the
// photos and the walkthrough, so the email deliberately promises a timeframe and
// never a price. It reads back exactly what they submitted so a wrong completion
// date or square footage gets corrected by reply instead of on site.
// ─────────────────────────────────────────────────────────────────────────────

import {
  FONT, INK, MUTE, BLUE_BG, BLUE_FG, BLUE_INK,
  esc, escAttr, h3, callout, detailRow, phesEmailShell,
} from "./phes-email-shell.js";

export interface PhesLeadAckOpts {
  logoUrl: string;
  companyName: string;
  companyPhone: string;
  companyPhoneTel: string;
  companyEmail: string;
  website: string;
  firstName: string;
  address: string;            // canonical formatAddress() output ("" hides the row)
  constructionType: string;   // display label, e.g. "Renovation / Remodel"
  completionDate: string;     // display, e.g. "September 4, 2026"
  sqft: string;               // "" hides the row
  photoCount: number;
  notes: string;              // "" hides the block
}

export function renderPhesPostConstructionAck(o: PhesLeadAckOpts): string {
  const mapsHref = o.address ? `https://maps.google.com/?q=${encodeURIComponent(o.address)}` : null;

  const body = `
      <p style="margin:22px 0 18px;font-family:${FONT};font-size:15px;color:${INK};line-height:1.6;">Hi ${esc(o.firstName) || "there"}, thanks for sending over your post-construction cleaning request. We've received it and it's with our estimating team now.</p>

      ${callout(BLUE_BG, BLUE_FG, BLUE_INK, "&#10003;", "You'll hear from us within 1 business day",
        `We'll review your photos and details and get back to you with a quote and available dates. If we need to see the space in person first, we'll say so and set up a walkthrough. Either way you'll hear from us. Questions before then? Call <a href="tel:${escAttr(o.companyPhoneTel)}" style="color:${BLUE_FG};font-weight:600;">${esc(o.companyPhone)}</a> or just reply to this email.`)}

      ${h3("What you sent us")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E2DC;border-radius:10px;padding:2px 18px;margin:0 0 8px;">
        ${o.address ? detailRow("Address", o.address, mapsHref) : ""}
        ${detailRow("Project type", o.constructionType)}
        ${detailRow("Work completes", o.completionDate)}
        ${o.sqft ? detailRow("Square footage", `${o.sqft} sq ft`) : ""}
        ${detailRow("Photos", o.photoCount === 1 ? "1 photo" : `${o.photoCount} photos`)}
      </table>
      ${o.notes ? `<p style="margin:14px 0 0;font-family:${FONT};font-size:13px;color:${MUTE};line-height:1.6;"><strong style="color:${INK};">Your notes:</strong> ${esc(o.notes)}</p>` : ""}
      <p style="margin:14px 0 0;font-family:${FONT};font-size:13px;color:${MUTE};line-height:1.6;">Anything above look wrong? Reply to this email and we'll correct it before we quote.</p>

      ${h3("Why we don't quote these online")}
      <p style="margin:0 0 10px;font-family:${FONT};font-size:14px;color:${INK};line-height:1.6;">Post-construction cleaning varies far more than a regular clean. Drywall dust, adhesive residue, paint overspray, and window and fixture detail all depend on the trades that were in the space. We price it from your photos and the finished condition so the number we give you is the number you pay, rather than a low estimate that grows on the day.</p>`;

  return phesEmailShell({
    title: "We got your post-construction request",
    logoUrl: o.logoUrl,
    companyName: o.companyName,
    bannerHtml: `We've got your request. Quote within 1 business day`,
    companyPhone: o.companyPhone,
    companyPhoneTel: o.companyPhoneTel,
    companyEmail: o.companyEmail,
    website: o.website,
    bodyHtml: body,
  });
}
