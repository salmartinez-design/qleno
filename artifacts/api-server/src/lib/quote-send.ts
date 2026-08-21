import { randomBytes } from "crypto";
import { db } from "@workspace/db";
import { quotesTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";

// [mcp-writes 2026-08-19] The one implementation of "send this quote".
//
// Before this file the whole sequence lived inline in POST /api/quotes/:id/send.
// That was fine while the office UI was the only caller. It stopped being fine
// when the machine surface (/api/v1, and the MCP tool behind it) needed the same
// action: two copies of a five-step side-effecting sequence drift, and the half
// that drifts is always the one nobody is looking at. So the route and the v1
// endpoint both call this, and neither owns it.
//
// The steps are ordered, and the order is load-bearing:
//   1. status -> sent, stamp sent_at
//   2. mint sign_token if absent, so /estimate/<token> resolves instead of 404
//   3. snapshot the frequency comparison BEFORE the email goes, so the public
//      page shows stable prices when the customer opens the link
//   4. enroll in the quote_followup cadence
//   5. fire the Day-0 email NOW and AWAIT it, so a failure (unverified domain,
//      comms gate, opt-out) is reported to the caller instead of silently never
//      arriving
//
// Comms failures never fail the send: the quote is genuinely marked sent and the
// office needs to see that plus the email outcome, not a 500 that hides both.
// The COMMS_ENABLED gate is respected downstream in fireQuoteEmailNow — this
// function does not and must not bypass it.

export type QuoteSendResult = {
  quote: any;
  /** Whatever fireQuoteEmailNow reported. null when the cadence threw. */
  email: any;
  /** True when this call is what flipped the quote to sent. */
  first_send: boolean;
};

export async function sendQuoteNow(
  companyId: number,
  quoteId: number,
  userId: number | null,
): Promise<QuoteSendResult | null> {
  const [prior] = await db
    .select({ status: quotesTable.status })
    .from(quotesTable)
    .where(and(eq(quotesTable.id, quoteId), eq(quotesTable.company_id, companyId)))
    .limit(1);
  if (!prior) return null;

  const [q] = await db
    .update(quotesTable)
    .set({ status: "sent", sent_at: new Date() })
    .where(and(eq(quotesTable.id, quoteId), eq(quotesTable.company_id, companyId)))
    .returning();
  if (!q) return null;

  if (!(q as any).sign_token) {
    const tok = randomBytes(24).toString("hex");
    await db.execute(sql`UPDATE quotes SET sign_token = ${tok} WHERE id = ${quoteId}`);
    (q as any).sign_token = tok;
  }
  console.log(`[QUOTE SENT] id=${quoteId} lead_email=${(q as any).lead_email}`);

  try {
    const { snapshotQuoteFrequencyOptions } = await import("./quote-pricing.js");
    await snapshotQuoteFrequencyOptions(companyId, quoteId);
  } catch { /* non-fatal — page falls back to single total */ }

  let email: any = null;
  try {
    const { enrollForQuoteSent, fireQuoteEmailNow } = await import("../services/followUpService.js");
    await enrollForQuoteSent(
      companyId,
      quoteId,
      (q as any).client_id ?? null,
      (q as any).lead_name?.split(" ")[0] || "",
      (q as any).lead_email ?? null,
      (q as any).lead_phone ?? null,
    );
    email = await fireQuoteEmailNow(companyId, quoteId);
  } catch (e) {
    console.error("[quote send-now] error:", e);
  }

  // Quote→lead: advance the lead to Quoted + link the enrollment (non-blocking).
  import("./lead-sync.js").then(async ({ upsertLeadForQuote, advanceLeadStage, linkEnrollmentToLead }) => {
    const leadId = await upsertLeadForQuote(companyId, q);
    if (leadId) {
      await advanceLeadStage(companyId, leadId, "quoted", {
        quoteAmount: (q as any).total_price ?? (q as any).base_price ?? null,
        userId,
      });
      await linkEnrollmentToLead(companyId, quoteId, leadId);
    }
  }).catch(() => {});

  return { quote: q, email, first_send: prior.status !== "sent" };
}
