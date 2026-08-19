// [square-webhook 2026-07-22] Square → Qleno payment notifications. READ-ONLY:
// this endpoint never charges a card, never creates a Square order, and never
// pushes anything to QuickBooks. It records that a payment happened and credits
// the matching open invoice; anything ambiguous goes to Needs Review untouched.
//
// Subscribe in the Square Developer dashboard to: payment.created, payment.updated.
// Notification URL: https://<host>/api/square/webhook
// Then set SQUARE_WEBHOOK_SIGNATURE_KEY (dashboard → the subscription's key).
//
// PER BRANCH: every Square merchant needs its OWN subscription to this same
// URL and its own signing secret, suffixed to match companies.square_account_key
// — e.g. SQUARE_WEBHOOK_SIGNATURE_KEY_SCHAUMBURG. A merchant with no key set
// here still takes payments; they simply never reconcile.
//
// MOUNTED WITH express.raw() BEFORE express.json() — Square's signature is an
// HMAC over the EXACT bytes of the body, so a re-serialized JSON object will not
// verify. Same constraint as the Stripe webhook above it in app.ts.
import { Router, Request, Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import crypto from "crypto";
import { reconcileSquarePayment, squareAmountToCents } from "../lib/square-payment-reconcile.js";
import { listSquareAccountKeys, webhookSignatureKey, companyForAccountKey } from "../lib/square-credentials.js";

const router = Router();

// Square signs `notificationUrl + rawBody` with HMAC-SHA256, base64. The URL is
// part of the signed payload, so it must match the subscription's configured URL
// byte for byte — hence SQUARE_WEBHOOK_URL rather than reconstructing it from
// request headers (a proxy rewriting Host would silently break verification).
function verifySquareSignature(rawBody: Buffer, signature: string, url: string, key: string): boolean {
  const hmac = crypto.createHmac("sha256", key);
  hmac.update(url + rawBody.toString("utf8"));
  const expected = hmac.digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // Length check first: timingSafeEqual throws on a length mismatch.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post("/", async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;

  if (!Buffer.isBuffer(rawBody)) {
    console.error("[square-webhook] body is not raw — check the express.raw() mount order in app.ts");
    return res.status(500).json({ error: "Webhook misconfigured" });
  }

  const sig = req.headers["x-square-hmacsha256-signature"] as string | undefined;
  const url = process.env.SQUARE_WEBHOOK_URL;
  if (!url) {
    console.warn("[square-webhook] SQUARE_WEBHOOK_URL not set — cannot verify signature");
    return res.status(503).json({ error: "Square webhook not configured" });
  }

  // [square-per-branch 2026-08-19] Two separately owned branches means two Square
  // merchants, two subscriptions to this same URL, and two signing secrets — so
  // there is no single key to check against any more.
  //
  // The merchant that signed the event is ALSO how we know which company's books
  // to credit. Nothing in the payload can be trusted for that: the body is
  // attacker-controlled until a signature verifies, and this endpoint marks
  // invoices paid. So the account key that verifies IS the tenant identification,
  // and it costs one HMAC per configured merchant to find it.
  //
  // Unlike the Stripe route there is no unsigned dev fallback. With no key
  // configured this accepts nothing.
  const accountKeys = await listSquareAccountKeys();
  let signedBy: string | null = null;
  let verified = false;
  let anyKeyConfigured = false;
  for (const key of accountKeys) {
    const secret = webhookSignatureKey(key);
    if (!secret) continue;
    anyKeyConfigured = true;
    if (sig && verifySquareSignature(rawBody, sig, url, secret)) {
      signedBy = key;
      verified = true;
      break;
    }
  }
  if (!anyKeyConfigured) {
    console.warn("[square-webhook] no SQUARE_WEBHOOK_SIGNATURE_KEY* configured — rejecting event");
    return res.status(503).json({ error: "Square webhook not configured" });
  }
  if (!verified) {
    console.error("[square-webhook] signature verification failed against all configured merchants");
    return res.status(401).json({ error: "Invalid signature" });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  const type: string = event?.type ?? "";
  const payment = event?.data?.object?.payment;

  // Acknowledge anything that isn't a payment event. Returning 2xx stops Square
  // retrying something we will never act on.
  if (!type.startsWith("payment.") || !payment?.id) {
    return res.json({ received: true, ignored: true });
  }

  try {
    // Tenant resolution follows the merchant whose key just verified the
    // signature. For the unsuffixed/default set that is still SQUARE_COMPANY_ID
    // (many companies can share it, so it is genuinely ambiguous); for an
    // explicit key it is the single company carrying that key. A payment we
    // cannot attribute is dropped unreconciled rather than credited to whichever
    // company sorts first — crediting the wrong branch's invoice is worse than
    // leaving a payment for a human to place.
    const companyId = await companyForAccountKey(signedBy);
    if (companyId == null) {
      console.error(`[square-webhook] cannot attribute payment ${payment.id} (account key ${signedBy ?? "default"}) to a company`);
      return res.status(202).json({ received: true, unattributed: true });
    }
    const amountCents = squareAmountToCents(payment.amount_money);
    const customerId: string | null = payment.customer_id ?? null;
    const card = payment.card_details?.card ?? {};

    // Record the event FIRST, before any reconcile work. If the process dies
    // mid-reconcile the payment is still on the books as needs_review rather
    // than lost — and the unique index makes Square's retry an update, not a
    // duplicate. Re-delivery of an ALREADY-APPLIED payment is short-circuited
    // below so a retry can never double-credit.
    const existing = (await db.execute(sql`
      SELECT id, resolution FROM square_payment_events
       WHERE company_id = ${companyId} AND square_payment_id = ${payment.id}
       LIMIT 1`) as any).rows[0];

    if (existing?.resolution === "applied") {
      return res.json({ received: true, duplicate: true, event_id: existing.id });
    }

    await db.execute(sql`
      INSERT INTO square_payment_events (
        company_id, square_payment_id, square_customer_id, square_order_id,
        square_location_id, event_type, square_status, amount, currency,
        card_brand, card_last4, square_created_at, resolution, raw
      ) VALUES (
        ${companyId}, ${payment.id}, ${customerId}, ${payment.order_id ?? null},
        ${payment.location_id ?? null}, ${type}, ${payment.status ?? null},
        ${(amountCents / 100).toFixed(2)}, ${payment.amount_money?.currency ?? "USD"},
        ${card.card_brand ?? null}, ${card.last_4 ?? null},
        ${payment.created_at ? new Date(payment.created_at) : null}, 'needs_review',
        ${JSON.stringify(event)}::jsonb
      )
      ON CONFLICT (company_id, square_payment_id) DO UPDATE SET
        square_status = EXCLUDED.square_status,
        event_type = EXCLUDED.event_type,
        raw = EXCLUDED.raw`);

    const result = await reconcileSquarePayment({
      companyId,
      squarePaymentId: payment.id,
      squareCustomerId: customerId,
      amountCents,
      squareStatus: payment.status ?? null,
    });

    await db.execute(sql`
      UPDATE square_payment_events SET
        resolution = ${result.resolution},
        review_reason = ${result.review_reason},
        resolved_client_id = ${result.client_id},
        resolved_account_id = ${result.account_id},
        matched_invoice_id = ${result.matched_invoice_id},
        applied_payment_id = ${result.applied_payment_id},
        candidate_invoice_ids = ${JSON.stringify(result.candidate_invoice_ids)}::jsonb,
        processed_at = now()
      WHERE company_id = ${companyId} AND square_payment_id = ${payment.id}`);

    console.log(`[square-webhook] ${type} ${payment.id} $${(amountCents / 100).toFixed(2)} → ${result.resolution}${result.review_reason ? ` (${result.review_reason})` : ""}`);

    return res.json({ received: true, resolution: result.resolution, review_reason: result.review_reason });
  } catch (err: any) {
    // A 500 makes Square retry, which is what we want for a transient DB blip —
    // the unique index keeps the retry safe.
    console.error("[square-webhook] processing error:", err?.message ?? err);
    return res.status(500).json({ error: "Processing failed" });
  }
});

export default router;
