// [square-charge 2026-07-24] Ad-hoc Square card-on-file charge.
//
// Powers the office "Charge card on file" button for Square clients — the mirror
// of the Stripe off-session charge. Charges the customer's default enabled card
// in Square for an arbitrary amount. Guarded exactly like the invoice charge
// path (charge-invoice.ts): needs a resolvable access token and, for real money,
// a production environment. Uses the v44 SDK surface (SquareClient / cards.list /
// payments.create) — the same one the invoice charge was fixed to.
//
// [square-per-branch 2026-08-18] Credentials are per-COMPANY now, not per
// process. Oak Lawn and Schaumburg are separate Square merchants.
import { resolveSquareCredentials } from "./square-credentials.js";

export type SquareChargeResult =
  | { ok: true; paymentId: string; status: string }
  | { ok: false; code: "not_configured" | "no_card" | "declined" | "error"; message: string };

export async function chargeSquareCard(opts: {
  /** The company that OWNS this client. Square cards are merchant-scoped, so
      charging a squareCustomerId through the wrong merchant either fails or
      resolves to a different customer entirely. */
  companyId: number;
  squareCustomerId: string;
  amountCents: number;
  idempotencyKey: string;
}): Promise<SquareChargeResult> {
  const creds = await resolveSquareCredentials(opts.companyId);
  const token = creds.accessToken;
  if (!creds.configured || !token) {
    return { ok: false, code: "not_configured", message: "Square is not configured for this company" };
  }
  const squareMod: any = await import("square" as any).catch(() => null);
  if (!squareMod?.SquareClient) {
    return { ok: false, code: "not_configured", message: "Square SDK not available" };
  }
  const { SquareClient, SquareEnvironment } = squareMod;
  const environment = (creds.environment === "production") ? SquareEnvironment.Production : SquareEnvironment.Sandbox;
  const square = new SquareClient({ token, environment });
  try {
    // Read the customer's default enabled card. (v44: cards.list returns a pager
    // — the first page's .data holds the few cards a customer has.)
    // NOTE: sortOrder MUST be passed. The v44 SDK's cards.list serializes an
    // omitted sortOrder to `sort_order=` (empty) in the query string instead of
    // dropping it, and Square rejects that with
    // `INVALID_ENUM_VALUE: `` is not a valid enum value for sort_order`. Passing
    // an explicit "DESC" sends a valid `sort_order=DESC`. (Todd Tue $253 charge.)
    const cardsPage = await square.cards.list({ customerId: opts.squareCustomerId, sortOrder: "DESC" });
    const cardList: any[] = cardsPage?.data ?? [];
    const cardId = cardList.find((c: any) => c.enabled)?.id ?? cardList[0]?.id;
    if (!cardId) {
      return { ok: false, code: "no_card", message: "No usable Square card on file for this customer" };
    }
    const resp = await square.payments.create({
      sourceId: cardId,
      idempotencyKey: opts.idempotencyKey,
      customerId: opts.squareCustomerId,
      amountMoney: { amount: BigInt(Math.round(opts.amountCents)), currency: "USD" },
    });
    const payment = resp?.payment;
    if (payment && (payment.status === "COMPLETED" || payment.status === "APPROVED")) {
      return { ok: true, paymentId: payment.id, status: payment.status };
    }
    return { ok: false, code: "declined", message: `Square charge not completed (status: ${payment?.status ?? "unknown"})` };
  } catch (err: any) {
    return { ok: false, code: "error", message: err?.message || "Square charge failed" };
  }
}
