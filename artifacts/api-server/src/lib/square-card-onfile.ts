// [square-default 2026-07-24] Save a Square card ON FILE for a client.
//
// The mirror of the Stripe SetupIntent save path in routes/payment-links.ts.
// The browser tokenizes the card with the Web Payments SDK and hands us a
// one-time nonce (`cnon:…` in `sourceId`). Here we (1) ensure the client has a
// Square customer, (2) turn the nonce into a durable card-on-file via the Cards
// API, and (3) write the chargeable handle + display fields onto the client so
// the exact same "Charge card on file" button (lib/square-charge.ts) can bill it
// later. Nothing is charged here — this is card-on-file only.
//
// Reuses the v44 SDK access pattern from lib/square-charge.ts (SquareClient /
// SquareEnvironment, camelCase params). `square_customer_id` is the load-bearing
// field: square-charge.ts and the profile UI both key "chargeable" off it.
import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

export type SaveSquareCardResult =
  | {
      ok: true;
      squareCustomerId: string;
      cardId: string;
      brand: string | null;
      last4: string | null;
      expMonth: number | null;
      expYear: number | null;
    }
  | { ok: false; code: "not_configured" | "no_source" | "declined" | "error"; message: string };

export async function saveSquareCardOnFile(opts: {
  companyId: number;
  clientId: number;
  sourceId: string; // the `cnon:` nonce from Square Web Payments SDK tokenize()
  idempotencyKey: string;
}): Promise<SaveSquareCardResult> {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) {
    return { ok: false, code: "not_configured", message: "Square is not configured in this environment" };
  }
  if (!opts.sourceId || !String(opts.sourceId).trim()) {
    return { ok: false, code: "no_source", message: "No card token provided" };
  }
  const squareMod: any = await import("square" as any).catch(() => null);
  if (!squareMod?.SquareClient) {
    return { ok: false, code: "not_configured", message: "Square SDK not available" };
  }
  const { SquareClient, SquareEnvironment } = squareMod;
  const environment = process.env.SQUARE_ENV === "production" ? SquareEnvironment.Production : SquareEnvironment.Sandbox;
  const square = new SquareClient({ token, environment });

  try {
    // Load the client (company-scoped) — need name/email to create the customer
    // and to know whether a Square customer already exists.
    const [client] = await db
      .select()
      .from(clientsTable)
      .where(and(eq(clientsTable.id, opts.clientId), eq(clientsTable.company_id, opts.companyId)));
    if (!client) {
      return { ok: false, code: "error", message: "Client not found" };
    }

    // 1) Ensure a Square customer. Reuse the stored id when present so we don't
    //    create a duplicate customer every time a card is re-saved.
    let squareCustomerId: string | null = (client as any).square_customer_id || null;
    if (!squareCustomerId) {
      const custResp = await square.customers.create({
        idempotencyKey: `cust-${opts.companyId}-${opts.clientId}-${opts.idempotencyKey}`.slice(0, 45),
        givenName: client.first_name || undefined,
        familyName: client.last_name || undefined,
        emailAddress: (client as any).billing_contact_email || client.email || undefined,
        referenceId: `qleno:${opts.companyId}:${opts.clientId}`.slice(0, 100),
      });
      squareCustomerId = custResp?.customer?.id ?? null;
      if (!squareCustomerId) {
        return { ok: false, code: "error", message: "Could not create Square customer" };
      }
    }

    // 2) Turn the one-time nonce into a durable card-on-file.
    const cardResp = await square.cards.create({
      idempotencyKey: opts.idempotencyKey,
      sourceId: opts.sourceId,
      card: {
        customerId: squareCustomerId,
        cardholderName: `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() || undefined,
      },
    });
    const card = cardResp?.card;
    if (!card?.id) {
      return { ok: false, code: "declined", message: "Square could not save this card" };
    }

    // [card-replace 2026-08-08] Retire every OTHER card on this Square customer.
    //
    // Saving a second card used to leave the first one enabled, and the charge
    // path picks `cards.list(sortOrder DESC).find(c => c.enabled)` — so which
    // card actually got charged depended on Square's ordering, not on which one
    // the office had just entered. A customer who called to update an expired or
    // cancelled card could still be billed on the dead one. Nothing in the UI
    // would show it, because the *_last4 columns below always mirror the NEWEST
    // card. Disabling the others makes the newest card the only chargeable one,
    // so the display and the charge can no longer disagree.
    //
    // Best-effort: the card IS saved by this point. A disable failure is logged
    // and the save still succeeds — a customer with two live cards is recoverable,
    // a lost card entry is not.
    try {
      const existing = await square.cards.list({ customerId: squareCustomerId, sortOrder: "DESC" });
      for (const old of (existing?.data ?? []) as any[]) {
        if (!old?.id || old.id === card.id || old.enabled === false) continue;
        await square.cards.disable({ cardId: old.id });
        console.log(`[square-card-onfile] retired old card ${old.id} for customer ${squareCustomerId}`);
      }
    } catch (e: any) {
      console.error("[square-card-onfile] could not retire old cards:", e?.message ?? e);
    }

    const brand: string | null = card.cardBrand ?? card.card_brand ?? null;
    const last4: string | null = card.last4 ?? null;
    const expMonth: number | null = card.expMonth != null ? Number(card.expMonth) : (card.exp_month != null ? Number(card.exp_month) : null);
    const expYear: number | null = card.expYear != null ? Number(card.expYear) : (card.exp_year != null ? Number(card.exp_year) : null);
    const expStr = expMonth != null && expYear != null ? `${expMonth}/${String(expYear).slice(-2)}` : null;

    // 3) Write the chargeable handle + display fields. `square_customer_id` is
    //    what makes this client chargeable; the *_last4/brand mirror the Stripe
    //    display fields so the profile card renders identically. Clear the Stripe
    //    handle so derivePaymentSource routes this client to Square, not a stale
    //    Stripe method.
    await db
      .update(clientsTable)
      .set({
        square_customer_id: squareCustomerId,
        square_card_brand: brand,
        square_card_last4: last4,
        square_card_exp: expStr,
        payment_source: "square",
        card_last_four: last4,
        card_brand: brand,
        card_expiry: expStr,
        card_saved_at: new Date(),
        default_card_last_4: last4,
        default_card_brand: brand,
        stripe_payment_method_id: null,
      } as any)
      .where(and(eq(clientsTable.id, opts.clientId), eq(clientsTable.company_id, opts.companyId)));

    return { ok: true, squareCustomerId, cardId: card.id, brand, last4, expMonth, expYear };
  } catch (err: any) {
    // Square SDK surfaces validation/decline detail on `.errors` or `.message`.
    const detail =
      err?.errors?.[0]?.detail ||
      err?.body?.errors?.[0]?.detail ||
      err?.message ||
      "Square card save failed";
    return { ok: false, code: "error", message: String(detail).slice(0, 300) };
  }
}
