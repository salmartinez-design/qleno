import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { REFERRAL_PROMO } from "./referrals.js";
import { upsertWidgetLead } from "./widget-lead.js";

// [referral-one-program 2026-08-20] One referral program, one code path.
//
// Give $25, get $25 used to be implemented once and half-implemented a second
// time. POST /api/public/referral (the booking confirmation page) wrote the lead
// AND the referrals row AND fired the office alert AND sent the friend their
// $25-off email and the referrer their thank-you. POST /api/portal/referrals
// wrote a lead and nothing else. So the same customer, referring the same
// friend, got a materially different deal depending on which screen they were
// standing on: a portal referral never reached the Referrals report, never
// earned the referrer their $25, and never told the friend they had $25 waiting.
//
// Everything both surfaces do now lives here. A route's only job is to say who
// is referring whom; what a referral IS belongs to the program, not the screen.

export type ReferralSurface = "widget" | "portal";
export type ReferralType = "residential" | "commercial";

export interface SubmitReferralInput {
  companyId: number;
  /** Which screen it came from. Stored on referrals.source so the report can tell. */
  surface: ReferralSurface;
  referralType?: ReferralType;
  referrer: {
    /** Known for certain on the portal (it is the signed-in customer). Null from
     *  the widget, where we can only guess by email/phone. */
    clientId?: number | null;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  referred: {
    name: string;
    phone?: string | null;
    email?: string | null;
    zip?: string | null;
    /** Anything the referrer wanted to tell us about them. */
    note?: string | null;
  };
}

export type SubmitReferralResult =
  | { ok: true; leadId: number | null; referralId: number | null; promo: string; message: string }
  | { ok: false; message: string };

const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const last10 = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);

/**
 * Record a referral and do everything the program promises: create the lead,
 * link a referrals row to it, alert the office, and send the two customer
 * messages. Comms are fire-and-forget by design so a Twilio or Resend hiccup
 * can never cost us the referral itself.
 *
 * Validation lives here too, so a customer gets the same wording whichever
 * screen they used.
 */
export async function submitReferral(input: SubmitReferralInput): Promise<SubmitReferralResult> {
  const companyId = Number(input.companyId);
  if (!companyId) return { ok: false, message: "Company not found" };

  const referredName = clip(input.referred.name, 120);
  const referredPhone = clip(input.referred.phone, 40) || null;
  const referredEmail = clip(input.referred.email, 160).toLowerCase() || null;
  const referredZip = clip(input.referred.zip, 20) || null;
  const note = clip(input.referred.note, 1000) || null;
  const referralType: ReferralType = input.referralType === "commercial" ? "commercial" : "residential";

  if (referredName.length < 2) return { ok: false, message: "Tell us who you are referring." };
  if (!referredPhone && !referredEmail) {
    return { ok: false, message: "Add a phone number or an email so we can reach them." };
  }

  // Resolve the referrer. The portal hands us a client id off the session, which
  // beats any guess; fill in whatever name or contact detail it did not pass by
  // reading the client record. The widget has no session, so fall back to
  // matching email or last-ten-digits phone against clients — nullable on
  // purpose, since a lead who refers before their client record exists still
  // counts as a referral.
  let referrerClientId: number | null = Number(input.referrer.clientId) || null;
  let referrerFirst = clip(input.referrer.firstName, 80);
  let referrerLast = clip(input.referrer.lastName, 80);
  let referrerEmail = clip(input.referrer.email, 160).toLowerCase();
  let referrerPhone = clip(input.referrer.phone, 40);

  if (referrerClientId) {
    const r: any = (await db.execute(sql`
      SELECT first_name, last_name, email, phone
        FROM clients
       WHERE id = ${referrerClientId} AND company_id = ${companyId}
       LIMIT 1`)).rows[0];
    if (r) {
      referrerFirst = referrerFirst || clip(r.first_name, 80);
      referrerLast = referrerLast || clip(r.last_name, 80);
      referrerEmail = referrerEmail || clip(r.email, 160).toLowerCase();
      referrerPhone = referrerPhone || clip(r.phone, 40);
    }
  } else if (referrerEmail || last10(referrerPhone)) {
    const p10 = last10(referrerPhone);
    const m = await db.execute(sql`
      SELECT id FROM clients
       WHERE company_id = ${companyId}
         AND (${referrerEmail ? sql`LOWER(email) = ${referrerEmail}` : sql`FALSE`}
              OR ${p10 ? sql`RIGHT(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 10) = ${p10}` : sql`FALSE`})
       ORDER BY id DESC LIMIT 1`);
    referrerClientId = Number((m.rows[0] as any)?.id) || null;
  }
  const referrerName = [referrerFirst, referrerLast].filter(Boolean).join(" ");
  const referrerLabel = referrerName || referrerEmail || "a customer";

  const sp = referredName.indexOf(" ");
  const referredFirst = sp > 0 ? referredName.slice(0, sp) : referredName;
  const referredLast = sp > 0 ? referredName.slice(sp + 1) : null;

  // (a) The lead. Same helper the widget uses, so a friend who was already on
  // the board is updated rather than duplicated.
  const leadId = await upsertWidgetLead(companyId, {
    first_name: referredFirst,
    last_name: referredLast,
    phone: referredPhone,
    email: referredEmail,
    zip: referredZip,
    scope: referralType === "commercial" ? "Commercial Cleaning" : null,
    source: "referral",
    status: "needs_contacted",
    details: {
      referred_by: referrerLabel,
      referral_type: referralType,
      referral_promo: REFERRAL_PROMO,
      referral_surface: input.surface,
      ...(note ? { referral_note: note } : {}),
    },
  });

  // (b) The referrals row, linked to that lead. The link is the whole reason the
  // Referrals report can derive booked / completed / credited later, and the
  // reason the referrer can ever be paid their $25.
  const ins = await db.execute(sql`
    INSERT INTO referrals
      (company_id, referrer_client_id, referrer_name, referrer_email, referrer_phone,
       referred_name, referred_phone, referred_email, referral_type,
       source, status, promo, lead_id, notes, created_at, updated_at)
    VALUES
      (${companyId}, ${referrerClientId}, ${referrerName || null}, ${referrerEmail || null}, ${referrerPhone || null},
       ${referredName}, ${referredPhone}, ${referredEmail}, ${referralType},
       ${input.surface}, 'pending', ${REFERRAL_PROMO}, ${leadId}, ${note}, NOW(), NOW())
    RETURNING id`);
  const referralId = Number((ins.rows[0] as any)?.id) || null;

  // (c) The office alert, on the same channel as every other new lead.
  try {
    const { fireOfficeNotification } = await import("../routes/leads.js");
    void fireOfficeNotification(
      companyId, leadId ?? 0, referredFirst, referredLast,
      `Referral from ${referrerLabel} ($25/$25 promo)`,
      referredPhone,
      referralType === "commercial" ? "Commercial Cleaning" : null,
    ).catch((e: any) => console.error("[referral] office alert failed:", e?.message ?? e));
  } catch (e: any) {
    console.error("[referral] office alert failed:", e?.message ?? e);
  }

  // (d) The two customer messages.
  void sendReferralComms(companyId, {
    referrerFirst, referrerEmail, referrerPhone,
    friendFirst: referredFirst, friendEmail: referredEmail ?? "",
  }).catch((e: any) => console.error("[referral] comms dispatch failed:", e?.message ?? e));

  return {
    ok: true, leadId, referralId, promo: REFERRAL_PROMO,
    message: "Thank you. We will reach out to them, and your $25 lands once their first clean is done.",
  };
}

// [referral-program 2026-07-17] Customer-facing referral messages fired on a
// referral submit. The referred FRIEND gets EMAIL ONLY (they never opted in — a
// cold SMS would be a TCPA gray area; the office alert still lets staff call).
// The REFERRER gets an SMS + email thank-you. Gate-respecting (COMMS_ENABLED +
// per-tenant/branch) and opt-out-checked; best-effort, never blocks the submit.
export async function sendReferralComms(companyId: number, p: {
  referrerFirst: string; referrerEmail: string; referrerPhone: string;
  friendFirst: string; friendEmail: string;
}): Promise<void> {
  try {
    const { resolveSender, sendSmsVia } = await import("./comms-sender.js");
    const { isEmailOptedOut, isSmsOptedOut } = await import("./opt-out.js");
    const { appBaseUrl } = await import("./app-url.js");
    const co: any = (await db.execute(sql`SELECT name, phone, email_from_address FROM companies WHERE id = ${companyId} LIMIT 1`)).rows[0] || {};
    const companyName = co.name || "Phes Cleaning";
    const companyPhone = co.phone || "";
    const bookLink = `${appBaseUrl()}/book`;
    const sender: any = await resolveSender(companyId, null);
    const emailGate = process.env.COMMS_ENABLED === "true" && sender.company_comms_enabled && sender.enabled && sender.branch_comms_enabled;
    const resendKey = process.env.RESEND_API_KEY;
    const fromAddr = co.email_from_address ? `${companyName} <${co.email_from_address}>` : "Phes Cleaning <noreply@phes.io>";
    const esc = (v: string) => String(v ?? "").replace(/[<>&]/g, (ch) => (ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&amp;"));
    const wrap = (inner: string) => `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#F7F6F3;"><div style="background:#fff;border:1px solid #E5E2DC;border-radius:8px;padding:32px;">${inner}<p style="font-size:13px;color:#9E9B94;margin:20px 0 0;">${esc(companyName)}${companyPhone ? `, ${esc(companyPhone)}` : ""}</p></div></div>`;
    const sendMail = async (to: string, subject: string, inner: string) => {
      if (!emailGate || !resendKey || !to) return;
      if (await isEmailOptedOut(companyId, to)) return;
      const { Resend } = await import("resend");
      await new Resend(resendKey).emails.send({ from: fromAddr, to: [to], subject, html: wrap(inner) }).catch(() => {});
    };
    const para = (t: string) => `<p style="font-size:15px;color:#1A1917;line-height:1.7;margin:0 0 14px;">${t}</p>`;

    // 1. Referred friend — EMAIL ONLY.
    await sendMail(
      p.friendEmail,
      `${p.referrerFirst || "A friend"} thinks you will love ${companyName}. Here is $25 off your first clean.`,
      para(`Hi ${esc(p.friendFirst || "there")},`) +
      para(`${esc(p.referrerFirst || "A friend")} recommended <strong>${esc(companyName)}</strong> for a cleaning, and gifted you <strong>$25 off</strong> your first visit.`) +
      para(`Get an instant quote and book your first clean:`) +
      `<p><a href="${bookLink}" style="display:inline-block;background:#00C9A0;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:6px;">Book my clean</a></p>`,
    );

    // 2. Referrer — SMS thank-you.
    if (p.referrerPhone && !sender.reason && !(await isSmsOptedOut(companyId, p.referrerPhone))) {
      const smsBody = `Hi ${p.referrerFirst || "there"}! Thanks for referring ${p.friendFirst || "your friend"} to ${companyName}. Once their first cleaning is done, you'll get $25 off your next visit. Reply STOP to opt out.`;
      await sendSmsVia(sender, p.referrerPhone, smsBody).catch(() => {});
    }

    // 3. Referrer — EMAIL thank-you.
    await sendMail(
      p.referrerEmail,
      `Thanks for referring ${p.friendFirst || "a friend"} to ${companyName}`,
      para(`Hi ${esc(p.referrerFirst || "there")},`) +
      para(`Thanks for referring <strong>${esc(p.friendFirst || "your friend")}</strong> to ${esc(companyName)}! Once their first cleaning is complete, you'll get <strong>$25 off</strong> your next visit.`) +
      para(`We appreciate you spreading the word.`),
    );
  } catch (e: any) {
    console.error("[referral] customer comms error (non-fatal):", e?.message ?? e);
  }
}
