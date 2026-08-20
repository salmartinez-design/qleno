// [signup-agreement 2026-08-20] Send the service agreement automatically when
// somebody signs up for RECURRING service on the website.
//
// The rule, from Sal: "only when they sign up for recurring service." A one-time
// clean is a single transaction and does not need a signed contract in front of
// it; a recurring customer is entering an ongoing arrangement with a cancellation
// notice, a rate and a cadence, and that is what the agreement covers. So this
// helper is a GATE first and a send second — the gate is the point.
//
// Two things it deliberately does not do:
//
//  1. It never throws into the booking. A customer who just paid and saw a
//     confirmation screen must not get a 500 because an agreement email failed.
//     Every failure is logged and swallowed. The office can still send from the
//     client profile, and the agreement reminders chase from there.
//  2. It never sends a second agreement to a client who already has one open or
//     signed. A returning customer re-booking online should not receive a fresh
//     contract to sign every time.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { RECURRING_CADENCES } from "./online-recurring.js";
import { sendAgreementToClient } from "./send-agreement.js";

export interface SignupAgreementInput {
  companyId: number;
  clientId: number;
  /** Which property this contract covers. Null falls back to the primary. */
  clientHomeId?: number | null;
  /** The booking's cadence, already through normalizeBookingFrequency. */
  frequency: string | null | undefined;
  /**
   * True when a one-time booking accepted the convert-to-recurring upsell. That
   * customer IS signing up for recurring service — the cadence just lives on the
   * upsell fields rather than on `frequency`.
   */
  upsellAccepted?: boolean;
}

/**
 * Returns true when this signup is recurring and therefore gets an agreement.
 * Exported so the gate can be tested without a database.
 */
export function signupNeedsAgreement(frequency: string | null | undefined, upsellAccepted?: boolean): boolean {
  if (upsellAccepted) return true;
  return RECURRING_CADENCES.includes(String(frequency ?? ""));
}

/**
 * Send the agreement if — and only if — this was a recurring signup.
 * Safe to call from any booking path. Never throws.
 */
export async function maybeSendSignupAgreement(o: SignupAgreementInput): Promise<void> {
  try {
    if (!signupNeedsAgreement(o.frequency, o.upsellAccepted)) {
      console.log(`[signup-agreement] Skipped — one-time booking (frequency=${o.frequency ?? "none"}) client_id=${o.clientId}`);
      return;
    }

    // Already has a contract in flight or on file. Sending another would put two
    // live signing links in the same inbox, and the second one signed would
    // supersede a contract the customer may already have agreed to.
    const existing = (await db.execute(sql`
      SELECT id, status FROM form_submissions
       WHERE company_id = ${o.companyId}
         AND client_id = ${o.clientId}
         AND (status = 'signed' OR (status = 'pending' AND (expires_at IS NULL OR expires_at > now())))
       LIMIT 1
    `)).rows[0] as any;
    if (existing) {
      console.log(`[signup-agreement] Skipped — client_id=${o.clientId} already has agreement #${existing.id} (${existing.status})`);
      return;
    }

    const result = await sendAgreementToClient({
      companyId: o.companyId,
      clientId: o.clientId,
      clientHomeId: o.clientHomeId ?? null,
      // No staff member pressed a button. Leaving this null is what marks the
      // send as automatic in the audit event.
      sentByUserId: null,
      // Automated, therefore gated. The booking confirmation this rides
      // alongside is gated the same way, so a tenant with comms off sends
      // neither rather than one without the other.
      transactional: false,
    });

    if (result.emailed) {
      console.log(`[signup-agreement] Sent — client_id=${o.clientId} submission=${result.submissionId} to=${result.sentTo}`);
    } else {
      // Not necessarily a failure: a tenant with comms gated off lands here too.
      // The agreement row and its signing link exist either way, so the profile
      // shows it as pending and the office can send it by hand.
      console.error(`[signup-agreement] Email did not go out — client_id=${o.clientId}: ${result.message}`);
    }
  } catch (err) {
    console.error("[signup-agreement] Failed (non-fatal):", err);
  }
}
