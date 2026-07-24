// [square-charge 2026-07-24] Ad-hoc Square card-on-file charge.
//
// Powers the office "Charge card on file" button for Square clients — the mirror
// of the Stripe off-session charge. Charges the customer's default enabled card
// in Square for an arbitrary amount. Env-guarded exactly like the invoice charge
// path (charge-invoice.ts): needs SQUARE_ACCESS_TOKEN and, for real money,
// SQUARE_ENV=production. Uses the v44 SDK surface (SquareClient / cards.list /
// payments.create) — the same one the invoice charge was fixed to.
export type SquareChargeResult =
  | { ok: true; paymentId: string; status: string }
  | { ok: false; code: "not_configured" | "no_card" | "declined" | "error"; message: string };

export async function chargeSquareCard(opts: {
  squareCustomerId: string;
  amountCents: number;
  idempotencyKey: string;
}): Promise<SquareChargeResult> {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) {
    return { ok: false, code: "not_configured", message: "Square is not configured in this environment" };
  }
  const squareMod: any = await import("square" as any).catch(() => null);
  if (!squareMod?.SquareClient) {
    return { ok: false, code: "not_configured", message: "Square SDK not available" };
  }
  const { SquareClient, SquareEnvironment } = squareMod;
  const environment = (process.env.SQUARE_ENV === "production") ? SquareEnvironment.Production : SquareEnvironment.Sandbox;
  const square = new SquareClient({ token, environment });
  try {
    // Read the customer's default enabled card. (v44: cards.list returns a pager
    // — the first page's .data holds the few cards a customer has.)
    const cardsPage = await square.cards.list({ customerId: opts.squareCustomerId });
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
