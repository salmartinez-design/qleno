// [card-saved-email 2026-08-08] One alert for "a card is now on file", fired from
// every path that can save one:
//
//   office  — POST /api/square/clients/:id/save-card   (quote Review, client profile)
//   link    — POST /api/payment-links/public/:token/save-card         (Stripe rail)
//   link    — POST /api/payment-links/public/:token/save-card-square  (Square rail)
//
// Sal, 2026-08-08: notify on EVERY save, office-entered included. The earlier
// build covered only the customer-completed links on the reasoning that whoever
// used the office form already knows — but that leaves the owner blind to cards
// Maribel or Francisco take over the phone, which is most of them.
//
// Email as well as the bell, because that's the habit: the office is used to
// Square emailing them. Square only emails on PAYMENTS, and saving a card moves
// no money, so Square sends nothing here — Qleno has to.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { notifyOfficeUsers } from "./notify.js";

export type CardSavedSource = "office" | "link";

export interface CardSavedAlertArgs {
  companyId: number;
  clientId: number;
  brand?: string | null;
  last4?: string | null;
  processor: "stripe" | "square";
  source: CardSavedSource;
}

/**
 * Fire-and-forget. NEVER throws and never rejects: the card is already saved by
 * the time this runs, and a failed alert must not turn a successful save into a
 * 500 for the person who just entered a customer's card.
 */
export async function alertCardSaved(a: CardSavedAlertArgs): Promise<void> {
  try {
    const r = await db.execute(sql`
      SELECT first_name, last_name FROM clients WHERE id = ${a.clientId} LIMIT 1`);
    const c: any = r.rows[0] ?? {};
    const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "A client";
    const card = [a.brand, a.last4 ? `••••${a.last4}` : null].filter(Boolean).join(" ");

    const how = a.source === "link"
      ? "The customer added it themselves from a payment link."
      : "Entered in the office.";

    await notifyOfficeUsers(a.companyId, {
      type: "card_saved",
      title: `${name} — card saved on file`,
      body: `${card ? card + ". " : ""}${how} Nothing was charged; the card is stored for future invoices.`,
      link: `/customers/${a.clientId}`,
      meta: {
        client_id: a.clientId,
        processor: a.processor,
        source: a.source,
        last4: a.last4 ?? null,
      },
      // Bypasses the per-user email prefs on purpose — see NotifyArgs.forceEmail.
      // A card landing on file is money-adjacent; the office asked to be emailed.
      forceEmail: true,
    });
  } catch (e) {
    console.error("[card-saved-alert]", e);
  }
}
