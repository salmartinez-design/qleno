// [square 2026-07-22] Office-facing Square surfaces. Two queues, both READ-ONLY
// against Square — nothing here charges a card, creates a Square object, or
// touches QuickBooks.
//
//   /api/square/customers     — the customer map + its review queue. This is
//                               where the 72 needs-review and 61 email-mismatch
//                               rows from the initial sync get cleaned up.
//   /api/square/payments      — the payment reconciliation ledger + its review
//                               queue: payments that arrived but couldn't be
//                               matched to exactly one open invoice.
//
// Both queues exist because the alternative is guessing. A wrongly linked
// customer or a payment credited to the wrong one of five identical $420 visits
// is worse than an unresolved row, because it looks settled.
import { Router } from "express";
import { db } from "@workspace/db";
import { inIntList } from "../lib/sql-lists.js";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { reconcileSquarePayment, decimalToCents } from "../lib/square-payment-reconcile.js";
import { syncSquareCustomerMap, fetchSquareCustomers, fetchSquareCards } from "../lib/square-customer-map.js";
import { getSquarePublicConfig } from "../lib/square-config.js";
import { resolveSquareCredentials } from "../lib/square-credentials.js";
import { saveSquareCardOnFile } from "../lib/square-card-onfile.js";
import { alertCardSaved } from "../lib/card-saved-alert.js";
import crypto from "crypto";

const router = Router();

const officeOnly = [requireAuth, requireRole("owner", "admin", "office")] as const;
const adminOnly = [requireAuth, requireRole("owner", "admin")] as const;

// ── Square Web Payments SDK config ───────────────────────────────────────────
//
// GET /api/square/config
//
// The office "Enter card now" form initializes the Web Payments SDK with these
// PUBLIC ids (application + location). No secret leaves the server. `configured`
// is false until the application id, location id and access token are all
// resolvable for THIS company, so the UI can show a clean "not set up yet" state
// instead of a broken card form.
//
// [square-per-branch 2026-08-18] Scoped to the caller's company. An office user
// entering a card must tokenize against their own branch's Square merchant —
// handing them the other branch's application id would save the customer's card
// to the wrong business.
router.get("/config", ...officeOnly, async (req: any, res) => {
  res.json(await getSquarePublicConfig(req.auth!.companyId!));
});

// ── Office: save a card on file to Square ────────────────────────────────────
//
// POST /api/square/clients/:id/save-card   body: { source_id }
//
// The "Enter card now" path (client profile + quote Review step). The browser
// tokenizes the card with the Web Payments SDK and posts the one-time nonce here;
// we turn it into a durable Square card-on-file and write the chargeable handle
// onto the client. Office-role gated to match the charge button. Nothing is
// charged — card-on-file only.
//
// [req-auth 2026-08-08] Every handler in this file used to read `req.user` —
// a property NOTHING in the codebase ever assigns. `requireAuth` sets
// `req.auth` (AuthPayload: userId / companyId, camelCase — see lib/auth.ts).
// So `req.user.company_id` threw "Cannot read properties of undefined (reading
// 'company_id')" and EVERY Square office endpoint here was dead on arrival —
// save-card, customer sync, the payment review queue, all of it. GET /config
// was the sole survivor because it's the only handler that doesn't touch the
// request user. The handlers were typed `(req: any, res)`, which switched off
// the one check that would have caught it — hence the untyped `req` now.
router.post("/clients/:id/save-card", ...officeOnly, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const clientId = Number(req.params.id);
    const sourceId = req.body?.source_id;
    if (!Number.isFinite(clientId)) return res.status(400).json({ error: "Invalid client id" });
    if (!sourceId) return res.status(400).json({ error: "source_id (card token) required" });

    const result = await saveSquareCardOnFile({
      companyId,
      clientId,
      sourceId,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!result.ok) {
      const status = result.code === "not_configured" ? 503 : result.code === "declined" ? 402 : 400;
      return res.status(status).json({ error: result.message, code: result.code });
    }
    logAudit(req, "SAVE_CARD", "client", clientId, {}, { processor: "square", last4: result.last4 } as any);
    // [card-saved-email 2026-08-08] Same alert the payment-link rails fire. The
    // audit row above is a forensic record nobody reads day to day — this is the
    // one that actually reaches the office.
    await alertCardSaved({
      companyId, clientId, brand: result.brand, last4: result.last4,
      processor: "square", source: "office",
    });
    res.json({ success: true, brand: result.brand, last4: result.last4 });
  } catch (err: any) {
    console.error("[square/save-card]", err?.message ?? err);
    res.status(500).json({ error: err?.message || "Failed to save card" });
  }
});

// ── Re-sync Square customers → Qleno ─────────────────────────────────────────
//
// POST /api/square/sync-customers?dry_run=1
//
// The original customer-map sync was a ONE-TIME run, so any card saved directly
// in the Square dashboard AFTER it — like Chris Glorioso's — never got linked:
// Qleno had no square_customer_id for the client, so "No payment method saved"
// and no charge button, even though the card was sitting in Square.
//
// This re-runs syncSquareCustomerMap on demand: pulls every Square customer +
// card, (re)matches to Qleno clients/accounts, and backfills
// clients.square_customer_id on confident links (into NULLs only — a manually
// reviewed or already-linked row is never re-decided or clobbered). dry_run=1
// returns the plan without writing a thing, so the office can see who WOULD link
// before applying. This is the durable answer to "cards saved in Square don't
// show up in Qleno."
router.post("/sync-customers", ...adminOnly, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const dryRun = req.query.dry_run === "1" || req.query.dry_run === "true" || req.body?.dry_run === true;
    const { summary } = await syncSquareCustomerMap({ companyId, dryRun });
    logAudit(req, dryRun ? "DRY_RUN" : "SYNC", "square_customer_map", 0, {}, summary as any);
    res.json({ ok: true, dryRun, summary });
  } catch (err: any) {
    console.error("[square/sync-customers]", err?.message ?? err);
    // Surface the real reason (e.g. missing SQUARE_ACCESS_TOKEN) so the office
    // isn't left guessing why nothing linked.
    res.status(500).json({ error: err?.message || "Square customer sync failed" });
  }
});

// ── Per-client card refresh ─────────────────────────────────────────────────
//
// POST /api/square/clients/:id/refresh-card
// POST /api/square/clients/:id/link-card   { square_customer_id, card_id }
//
// [card-refresh 2026-08-12] Maribel: "We should also get a button there to
// refresh the cards and if it finds a client by the same name, we should have
// the option to authorize the card right there."
//
// /sync-customers already re-matches the WHOLE book, but it is admin-only, runs
// over every customer, and lands its uncertain matches in a review queue the
// office has to go find. The case Maribel is describing is one client, in front
// of her, whose card is sitting in Square — she wants it resolved on that
// screen.
//
// refresh-card does the two useful things in one call:
//   - Client already linked → re-read that Square customer's cards and update
//     the stored brand / last4 / expiry. This is the "the card changed in
//     Square" case, and the answer is authoritative because the link is known.
//   - Not linked (or linked with no card) → return CANDIDATES: Square customers
//     matching by email or by name that actually have a card on file. It does
//     NOT link them. A name match is a suggestion, not proof — two Marias with
//     different cards is a real way to charge the wrong person — so attaching
//     stays a deliberate human click through link-card, which takes the exact
//     square_customer_id + card_id the office was shown.
router.post("/clients/:id/refresh-card", ...officeOnly, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const clientId = parseInt(req.params.id, 10);
    // [square-per-branch 2026-08-19] Read the token for THIS tenant, never the
    // ambient one. Square customers and cards are merchant-scoped, so matching a
    // company-4 (Schaumburg) client against Oak Lawn's Square book returns either
    // nothing or — far worse — a same-named stranger's card, which then gets
    // written onto the client as chargeable. resolveSquareCredentials returns
    // NOT_CONFIGURED rather than falling back to the default merchant.
    const { accessToken: token } = await resolveSquareCredentials(companyId);
    if (!token) return res.status(400).json({ error: "Square is not configured for this branch." });

    const cr = (await db.execute(sql`
      SELECT id, first_name, last_name, company_name, email, square_customer_id
        FROM clients WHERE id = ${clientId} AND company_id = ${companyId} LIMIT 1`) as any).rows;
    if (!cr.length) return res.status(404).json({ error: "Client not found" });
    const client = cr[0] as any;

    const [customers, cards] = await Promise.all([fetchSquareCustomers(token), fetchSquareCards(token)]);
    // include_disabled=true is on the fetch, so filter the dead ones out here —
    // a disabled card is not something the office can charge.
    const live = cards.filter(c => c.enabled !== false && c.customer_id);
    const byCustomer = new Map<string, typeof live>();
    for (const c of live) {
      const list = byCustomer.get(c.customer_id!) ?? [];
      list.push(c);
      byCustomer.set(c.customer_id!, list);
    }
    const custById = new Map(customers.map(c => [c.id, c]));
    const fmtExp = (c: { exp_month?: number; exp_year?: number }) =>
      c.exp_month != null && c.exp_year != null ? `${c.exp_month}/${String(c.exp_year).slice(-2)}` : null;

    // Already linked — refresh from the known customer.
    if (client.square_customer_id) {
      const list = byCustomer.get(String(client.square_customer_id)) ?? [];
      if (list.length) {
        const card = list[0];
        const brand = card.card_brand ?? null;
        const last4 = card.last_4 ?? null;
        const exp = fmtExp(card);
        await db.execute(sql`
          UPDATE clients
             SET square_card_brand = ${brand}, square_card_last4 = ${last4}, square_card_exp = ${exp},
                 card_brand = ${brand}, card_last_four = ${last4}, card_expiry = ${exp},
                 default_card_brand = ${brand}, default_card_last_4 = ${last4},
                 payment_source = 'square'
           WHERE id = ${clientId} AND company_id = ${companyId}`);
        logAudit(req, "REFRESH", "square_card", clientId, {}, { square_customer_id: client.square_customer_id, last4 } as any);
        return res.json({
          ok: true, state: "refreshed",
          card: { brand, last4, exp, square_customer_id: client.square_customer_id, card_id: card.id },
          candidates: [],
        });
      }
      // Linked but Square has no live card — say so plainly rather than
      // leaving a stale last4 on screen implying it can be charged.
      return res.json({ ok: true, state: "linked_no_card", card: null, candidates: [] });
    }

    // Not linked — offer what Square has under this name or email.
    const norm = (s?: string | null) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const targetName = norm(`${client.first_name ?? ""}${client.last_name ?? ""}`);
    const targetCompany = norm(client.company_name);
    const targetEmail = String(client.email ?? "").trim().toLowerCase();

    const candidates = customers
      .map(sc => {
        const scName = norm(`${sc.given_name ?? ""}${sc.family_name ?? ""}`);
        const scCompany = norm(sc.company_name);
        const scEmail = String(sc.email_address ?? "").trim().toLowerCase();
        let match_on: "email" | "name" | "company" | null = null;
        if (targetEmail && scEmail && scEmail === targetEmail) match_on = "email";
        else if (targetName && scName && scName === targetName) match_on = "name";
        else if (targetCompany && scCompany && scCompany === targetCompany) match_on = "company";
        return { sc, match_on };
      })
      .filter(x => x.match_on && (byCustomer.get(x.sc.id)?.length ?? 0) > 0)
      .flatMap(({ sc, match_on }) => (byCustomer.get(sc.id) ?? []).map(card => ({
        square_customer_id: sc.id,
        card_id: card.id,
        match_on,
        name: [sc.given_name, sc.family_name].filter(Boolean).join(" ") || sc.company_name || "(no name)",
        company_name: sc.company_name ?? null,
        email: sc.email_address ?? null,
        brand: card.card_brand ?? null,
        last4: card.last_4 ?? null,
        exp: fmtExp(card),
      })))
      // Email first: it is the only one of the three that is near-proof.
      .sort((a, b) => (a.match_on === "email" ? -1 : 0) - (b.match_on === "email" ? -1 : 0));

    return res.json({ ok: true, state: candidates.length ? "candidates" : "no_match", card: null, candidates });
  } catch (err: any) {
    console.error("[square/refresh-card]", err?.message ?? err);
    return res.status(500).json({ error: err?.message || "Could not refresh cards from Square" });
  }
});

router.post("/clients/:id/link-card", ...officeOnly, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const clientId = parseInt(req.params.id, 10);
    const { square_customer_id, card_id } = req.body ?? {};
    if (!square_customer_id || !card_id) return res.status(400).json({ error: "square_customer_id and card_id are required" });
    // [square-per-branch 2026-08-19] Read the token for THIS tenant, never the
    // ambient one. Square customers and cards are merchant-scoped, so matching a
    // company-4 (Schaumburg) client against Oak Lawn's Square book returns either
    // nothing or — far worse — a same-named stranger's card, which then gets
    // written onto the client as chargeable. resolveSquareCredentials returns
    // NOT_CONFIGURED rather than falling back to the default merchant.
    const { accessToken: token } = await resolveSquareCredentials(companyId);
    if (!token) return res.status(400).json({ error: "Square is not configured for this branch." });

    const cr = (await db.execute(sql`
      SELECT id FROM clients WHERE id = ${clientId} AND company_id = ${companyId} LIMIT 1`) as any).rows;
    if (!cr.length) return res.status(404).json({ error: "Client not found" });

    // Re-verify against Square rather than trusting the ids the browser sent
    // back — the office may have had the panel open for a while, and a card
    // can be removed in Square in between.
    const cards = await fetchSquareCards(token);
    const card = cards.find(c => c.id === card_id && c.customer_id === square_customer_id && c.enabled !== false);
    if (!card) return res.status(409).json({ error: "That card is no longer available in Square. Refresh and try again." });

    const brand = card.card_brand ?? null;
    const last4 = card.last_4 ?? null;
    const exp = card.exp_month != null && card.exp_year != null ? `${card.exp_month}/${String(card.exp_year).slice(-2)}` : null;

    // square_customer_id is the chargeable handle; the *_last4/brand mirror the
    // Stripe display fields so the profile renders identically. Clearing the
    // Stripe handle routes this client to Square (same contract as
    // saveSquareCardOnFile).
    await db.execute(sql`
      UPDATE clients
         SET square_customer_id = ${square_customer_id},
             square_card_brand = ${brand}, square_card_last4 = ${last4}, square_card_exp = ${exp},
             card_brand = ${brand}, card_last_four = ${last4}, card_expiry = ${exp},
             default_card_brand = ${brand}, default_card_last_4 = ${last4},
             payment_source = 'square', card_saved_at = NOW(),
             stripe_payment_method_id = NULL
       WHERE id = ${clientId} AND company_id = ${companyId}`);

    // Keep the customer map in step so the review queue doesn't keep offering a
    // row the office has just decided here.
    await db.execute(sql`
      UPDATE square_customer_map
         SET client_id = ${clientId}, status = 'linked'
       WHERE company_id = ${companyId} AND square_customer_id = ${square_customer_id}`);

    logAudit(req, "LINK", "square_card", clientId, {}, { square_customer_id, card_id, last4 } as any);
    return res.json({ ok: true, card: { brand, last4, exp, square_customer_id, card_id } });
  } catch (err: any) {
    console.error("[square/link-card]", err?.message ?? err);
    return res.status(500).json({ error: err?.message || "Could not attach that card" });
  }
});

// ── Customer map ────────────────────────────────────────────────────────────

/** GET /api/square/customers?status=needs_review|linked|unmatched|ignored&email_mismatch=1&q= */
router.get("/customers", ...officeOnly, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const mismatchOnly = req.query.email_mismatch === "1" || req.query.email_mismatch === "true";
    const q = typeof req.query.q === "string" && req.query.q.trim() ? `%${req.query.q.trim()}%` : null;

    const rows = (await db.execute(sql`
      SELECT m.*, (c.first_name || ' ' || c.last_name) AS client_name, c.email AS client_email,
             a.account_name AS account_name, p.property_name AS property_name
        FROM square_customer_map m
        LEFT JOIN clients c ON c.id = m.client_id
        LEFT JOIN accounts a ON a.id = m.account_id
        LEFT JOIN account_properties p ON p.id = m.account_property_id
       WHERE m.company_id = ${companyId}
         AND (${status}::text IS NULL OR m.status = ${status}::text)
         AND (${mismatchOnly} = false OR m.email_mismatch = true)
         AND (${q}::text IS NULL
              OR m.square_customer_name ILIKE ${q}::text
              OR m.square_email ILIKE ${q}::text
              OR m.square_company_name ILIKE ${q}::text)
       ORDER BY m.status, m.square_customer_name NULLS LAST
       LIMIT 500`) as any).rows;

    // Counts for the tab badges — computed over the whole map, not the filtered
    // page, so the queue size stays honest while the office filters around.
    const counts = (await db.execute(sql`
      SELECT status, count(*)::int AS n,
             count(*) FILTER (WHERE email_mismatch)::int AS mismatched
        FROM square_customer_map WHERE company_id = ${companyId}
       GROUP BY status`) as any).rows;

    res.json({ rows, counts });
  } catch (err: any) {
    console.error("[square/customers]", err?.message ?? err);
    res.status(500).json({ error: "Failed to load Square customer map" });
  }
});

/**
 * PATCH /api/square/customers/:id — the office resolving one review row.
 * Body: { client_id?, account_id?, account_property_id?, status?, is_account_primary? }
 * Setting status='linked' is what makes the row usable by the reconciler, so it
 * is deliberately a human action.
 */
router.patch("/customers/:id", ...officeOnly, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const before = (await db.execute(sql`
      SELECT * FROM square_customer_map WHERE id = ${id} AND company_id = ${companyId}`) as any).rows[0];
    if (!before) return res.status(404).json({ error: "Map row not found" });

    const b = req.body ?? {};
    const status: string | null = typeof b.status === "string" ? b.status : null;
    if (status && !["linked", "needs_review", "unmatched", "ignored"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const clientId = b.client_id === undefined ? before.client_id : (b.client_id === null ? null : Number(b.client_id));
    const accountId = b.account_id === undefined ? before.account_id : (b.account_id === null ? null : Number(b.account_id));
    const propertyId = b.account_property_id === undefined ? before.account_property_id
      : (b.account_property_id === null ? null : Number(b.account_property_id));

    // A linked row must actually point somewhere, or the reconciler will resolve
    // an identity to nothing and every payment for it lands back in review.
    if ((status ?? before.status) === "linked" && !clientId && !accountId) {
      return res.status(400).json({ error: "A linked customer must point to a client or an account" });
    }
    if (clientId && accountId) {
      return res.status(400).json({ error: "Pick a client OR an account, not both — the billing entity must be unambiguous" });
    }

    await db.execute(sql`
      UPDATE square_customer_map SET
        client_id = ${clientId}, account_id = ${accountId}, account_property_id = ${propertyId},
        is_account_primary = ${b.is_account_primary === undefined ? before.is_account_primary : !!b.is_account_primary},
        status = ${status ?? before.status},
        match_method = CASE WHEN ${status}::text = 'linked' THEN 'manual' ELSE match_method END,
        review_reason = CASE WHEN ${status}::text = 'linked' THEN NULL ELSE review_reason END,
        reviewed_at = now(), reviewed_by_user_id = ${req.auth!.userId},
        linked_at = CASE WHEN ${status}::text = 'linked' THEN now() ELSE linked_at END,
        linked_by_user_id = CASE WHEN ${status}::text = 'linked' THEN ${req.auth!.userId} ELSE linked_by_user_id END
      WHERE id = ${id} AND company_id = ${companyId}`);

    logAudit(req, "UPDATE", "square_customer_map", id,
      { client_id: before.client_id, account_id: before.account_id, status: before.status },
      { client_id: clientId, account_id: accountId, status: status ?? before.status });

    res.json({ ok: true });
  } catch (err: any) {
    console.error("[square/customers PATCH]", err?.message ?? err);
    res.status(500).json({ error: "Failed to update Square customer map" });
  }
});

// ── Payment reconciliation queue ────────────────────────────────────────────

/** GET /api/square/payments?resolution=needs_review|applied|skipped|ignored */
router.get("/payments", ...officeOnly, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const resolution = typeof req.query.resolution === "string" ? req.query.resolution : null;

    const rows = (await db.execute(sql`
      SELECT e.id, e.square_payment_id, e.square_customer_id, e.amount, e.currency,
             e.card_brand, e.card_last4, e.square_status, e.square_created_at,
             e.resolution, e.review_reason, e.candidate_invoice_ids,
             e.matched_invoice_id, e.created_at, e.processed_at,
             m.square_customer_name, m.square_email,
             (c.first_name || ' ' || c.last_name) AS client_name, a.account_name AS account_name,
             i.invoice_number AS matched_invoice_number
        FROM square_payment_events e
        LEFT JOIN square_customer_map m
               ON m.company_id = e.company_id AND m.square_customer_id = e.square_customer_id
        LEFT JOIN clients c ON c.id = e.resolved_client_id
        LEFT JOIN accounts a ON a.id = e.resolved_account_id
        LEFT JOIN invoices i ON i.id = e.matched_invoice_id
       WHERE e.company_id = ${companyId}
         AND (${resolution}::text IS NULL OR e.resolution = ${resolution}::text)
       ORDER BY e.square_created_at DESC NULLS LAST, e.id DESC
       LIMIT 300`) as any).rows;

    const counts = (await db.execute(sql`
      SELECT resolution, count(*)::int AS n, sum(amount)::numeric AS total
        FROM square_payment_events WHERE company_id = ${companyId}
       GROUP BY resolution`) as any).rows;

    // For each needs_review row, hydrate the candidate invoices so the office
    // can pick without a second round-trip per row.
    const candidateIds = Array.from(new Set(
      rows.flatMap((r: any) => Array.isArray(r.candidate_invoice_ids) ? r.candidate_invoice_ids : [])
    )) as number[];
    let candidates: any[] = [];
    // [ANY(array) trap 2026-08-14] `= ANY(${jsArray}::int[])` throws through
    // Drizzle at every length — see lib/sql-lists.ts.
    const candList = inIntList(candidateIds);
    if (candList) {
      candidates = (await db.execute(sql`
        SELECT id, invoice_number, total, status::text AS status, due_date::text AS due_date
          FROM invoices WHERE company_id = ${companyId} AND id IN (${candList})`) as any).rows;
    }

    res.json({ rows, counts, candidates });
  } catch (err: any) {
    console.error("[square/payments]", err?.message ?? err);
    res.status(500).json({ error: "Failed to load Square payments" });
  }
});

/**
 * POST /api/square/payments/:id/retry — re-run the reconciler for one event.
 * The normal use: a payment landed as needs_review because the customer wasn't
 * mapped yet or the invoice hadn't been issued. Fix that, hit retry.
 */
router.post("/payments/:id/retry", ...officeOnly, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = Number(req.params.id);
    const ev = (await db.execute(sql`
      SELECT * FROM square_payment_events WHERE id = ${id} AND company_id = ${companyId}`) as any).rows[0];
    if (!ev) return res.status(404).json({ error: "Payment event not found" });
    if (ev.resolution === "applied") return res.status(409).json({ error: "Already applied" });

    const result = await reconcileSquarePayment({
      companyId,
      squarePaymentId: ev.square_payment_id,
      squareCustomerId: ev.square_customer_id,
      amountCents: decimalToCents(ev.amount),
      squareStatus: ev.square_status,
    });

    await db.execute(sql`
      UPDATE square_payment_events SET
        resolution = ${result.resolution}, review_reason = ${result.review_reason},
        resolved_client_id = ${result.client_id}, resolved_account_id = ${result.account_id},
        matched_invoice_id = ${result.matched_invoice_id},
        applied_payment_id = ${result.applied_payment_id},
        candidate_invoice_ids = ${JSON.stringify(result.candidate_invoice_ids)}::jsonb,
        processed_at = now(), reviewed_at = now(), reviewed_by_user_id = ${req.auth!.userId}
      WHERE id = ${id} AND company_id = ${companyId}`);

    logAudit(req, "UPDATE", "square_payment_event", id, { resolution: ev.resolution }, { resolution: result.resolution });
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("[square/payments retry]", err?.message ?? err);
    res.status(500).json({ error: "Retry failed" });
  }
});

/**
 * POST /api/square/payments/:id/apply — the office resolving an ambiguous match
 * by hand: { invoice_id }. This is the deliberate human answer to "which of the
 * five identical $420 visits was this?" — the reconciler will never guess it.
 */
router.post("/payments/:id/apply", ...officeOnly, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = Number(req.params.id);
    const invoiceId = Number(req.body?.invoice_id);
    if (!Number.isFinite(invoiceId)) return res.status(400).json({ error: "invoice_id is required" });

    const ev = (await db.execute(sql`
      SELECT * FROM square_payment_events WHERE id = ${id} AND company_id = ${companyId}`) as any).rows[0];
    if (!ev) return res.status(404).json({ error: "Payment event not found" });
    if (ev.resolution === "applied") return res.status(409).json({ error: "Already applied" });

    let paymentId: number | null = null;
    try {
      await db.transaction(async (tx) => {
        const inv = (await tx.execute(sql`
          SELECT id, client_id, account_id, status::text AS status FROM invoices
           WHERE id = ${invoiceId} AND company_id = ${companyId}
             AND status IN ('draft','sent','overdue')
           FOR UPDATE`) as any).rows[0];
        if (!inv) throw new Error("NOT_OPEN");

        const ins = (await tx.execute(sql`
          INSERT INTO payments (company_id, client_id, invoice_id, amount, method, status, square_payment_id, processed_by)
          VALUES (${companyId}, ${inv.client_id}, ${invoiceId}, ${ev.amount}, 'square', 'completed',
                  ${ev.square_payment_id}, ${req.auth!.userId})
          RETURNING id`) as any).rows[0];
        paymentId = ins?.id ?? null;

        await tx.execute(sql`UPDATE invoices SET status = 'paid', paid_at = now() WHERE id = ${invoiceId} AND company_id = ${companyId}`);
      });
    } catch (e: any) {
      if (e?.message === "NOT_OPEN") {
        return res.status(409).json({ error: "That invoice is not open — it may already be paid or voided." });
      }
      throw e;
    }

    await db.execute(sql`
      UPDATE square_payment_events SET
        resolution = 'applied', review_reason = NULL, matched_invoice_id = ${invoiceId},
        applied_payment_id = ${paymentId}, processed_at = now(),
        reviewed_at = now(), reviewed_by_user_id = ${req.auth!.userId}
      WHERE id = ${id} AND company_id = ${companyId}`);

    logAudit(req, "UPDATE", "square_payment_event", id,
      { resolution: ev.resolution }, { resolution: "applied", invoice_id: invoiceId, manual: true });

    res.json({ ok: true, invoice_id: invoiceId, payment_id: paymentId });
  } catch (err: any) {
    console.error("[square/payments apply]", err?.message ?? err);
    res.status(500).json({ error: "Failed to apply payment" });
  }
});

/** POST /api/square/payments/:id/ignore — not Qleno AR (a tip, a retail sale, a test). */
router.post("/payments/:id/ignore", ...officeOnly, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = Number(req.params.id);
    const ev = (await db.execute(sql`
      SELECT resolution FROM square_payment_events WHERE id = ${id} AND company_id = ${companyId}`) as any).rows[0];
    if (!ev) return res.status(404).json({ error: "Payment event not found" });
    // Ignoring an applied payment would leave a paid invoice with no visible
    // reason it was paid. Reverse the payment first if that's really the intent.
    if (ev.resolution === "applied") {
      return res.status(409).json({ error: "This payment is already applied to an invoice — reverse it there instead." });
    }
    await db.execute(sql`
      UPDATE square_payment_events SET resolution = 'ignored',
        review_reason = ${typeof req.body?.reason === "string" ? req.body.reason : null},
        reviewed_at = now(), reviewed_by_user_id = ${req.auth!.userId}
      WHERE id = ${id} AND company_id = ${companyId}`);
    logAudit(req, "UPDATE", "square_payment_event", id, { resolution: ev.resolution }, { resolution: "ignored" });
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[square/payments ignore]", err?.message ?? err);
    res.status(500).json({ error: "Failed to ignore payment" });
  }
});

export default router;
