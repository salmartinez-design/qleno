import { Router, type Request } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { requireAuth } from "../lib/auth.js";
import { fireGhlWebhook, type GhlEstimatePayload } from "../lib/ghl.js";

// [commercial-estimate-tool 2026-06-09] Commercial / common-area estimates.
// Raw SQL (db.execute) on purpose: the estimate tables are brand-new and the
// api-server reads the db package's compiled .d.ts, which lags the source by a
// build — raw SQL sidesteps that while the runtime (tsx) reads the live schema.
// Every query is company-scoped via req.auth!.companyId. Line items are stored
// in estimate_line_items; PATCH/create replace the full set (mirrors the
// job_add_ons pattern). Totals are always recomputed server-side.

const router = Router();

const PRICING_TYPES = new Set(["flat", "hourly", "one_time"]);

// [ghl-estimate-bridge 2026-06-10] Absolute customer link for webhook payloads.
// Behind Railway's proxy the public scheme arrives in x-forwarded-proto.
function publicEstimateLink(req: Request, token: string | null): string | null {
  if (!token) return null;
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() || req.protocol || "https";
  const host = req.get("host");
  return host ? `${proto}://${host}/estimate/${token}` : null;
}

// Fire-and-forget GHL notification. Loads the tenant's webhook URL for the
// event class, posts the payload, and stamps ghl_synced_at on a successful
// 'sent' notification. Never blocks or fails the calling request.
function notifyGhl(req: Request, estimateId: number, event: GhlEstimatePayload["event"], acceptedName?: string | null): void {
  (async () => {
    const rows = await db.execute(sql`
      SELECT e.id, e.estimate_number, e.title, e.contact_name, e.contact_email, e.contact_phone,
             e.property_name, e.service_address, e.total, e.valid_until, e.public_token,
             c.ghl_estimate_sent_webhook, c.ghl_estimate_outcome_webhook
      FROM estimates e JOIN companies c ON c.id = e.company_id
      WHERE e.id = ${estimateId} LIMIT 1
    `);
    const est = (rows as any).rows[0];
    if (!est) return;
    const url = event === "estimate_sent" ? est.ghl_estimate_sent_webhook : est.ghl_estimate_outcome_webhook;
    if (!url) return;
    const ok = await fireGhlWebhook(url, {
      event,
      estimate_id: est.id,
      estimate_number: est.estimate_number,
      title: est.title,
      contact_name: est.contact_name,
      contact_email: est.contact_email,
      contact_phone: est.contact_phone,
      property_name: est.property_name,
      service_address: est.service_address,
      total: est.total != null ? String(est.total) : null,
      valid_until: est.valid_until ? String(est.valid_until).slice(0, 10) : null,
      estimate_link: publicEstimateLink(req, est.public_token),
      accepted_name: acceptedName ?? null,
    });
    if (ok && event === "estimate_sent") {
      await db.execute(sql`UPDATE estimates SET ghl_synced_at = now() WHERE id = ${estimateId}`);
    }
  })().catch(err => console.warn("[ghl] notify failed:", err?.message ?? err));
}

type NormalizedItem = {
  sort_order: number;
  name: string | null;
  description: string | null;
  pricing_type: string;
  frequency: string | null;
  quantity: number;
  unit_rate: number;
  amount: number;
};

function normalizeItems(raw: unknown): NormalizedItem[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((it: any, i: number) => {
    const pricing_type = PRICING_TYPES.has(it?.pricing_type) ? it.pricing_type : "flat";
    const quantity = Math.max(0, Number(it?.quantity ?? 1) || 0);
    const unit_rate = Math.max(0, Number(it?.unit_rate ?? 0) || 0);
    const amount = Math.round(quantity * unit_rate * 100) / 100;
    const name = (it?.name ?? "").toString().trim().slice(0, 300);
    const description = (it?.description ?? "").toString().trim();
    const frequency = (it?.frequency ?? "").toString().trim().slice(0, 80);
    return {
      sort_order: i,
      name: name || null,
      description: description || null,
      pricing_type,
      frequency: frequency || null,
      quantity,
      unit_rate,
      amount,
    };
  });
}

function computeTotals(items: NormalizedItem[], discountRaw: unknown) {
  const subtotal = Math.round(items.reduce((s, it) => s + it.amount, 0) * 100) / 100;
  const discount = Math.max(0, Number(discountRaw ?? 0) || 0);
  const total = Math.round(Math.max(0, subtotal - discount) * 100) / 100;
  return { subtotal, discount, total };
}

function str(v: unknown, max = 2000): string | null {
  if (v === undefined || v === null) return null;
  const s = v.toString().trim();
  return s ? s.slice(0, max) : null;
}

function intOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = parseInt(v.toString(), 10);
  return Number.isFinite(n) ? n : null;
}

async function insertLineItems(estimateId: number, companyId: number, items: NormalizedItem[]) {
  for (const it of items) {
    await db.execute(sql`
      INSERT INTO estimate_line_items
        (estimate_id, company_id, sort_order, name, description, pricing_type, frequency, quantity, unit_rate, amount)
      VALUES
        (${estimateId}, ${companyId}, ${it.sort_order}, ${it.name}, ${it.description},
         ${it.pricing_type}, ${it.frequency}, ${it.quantity}, ${it.unit_rate}, ${it.amount})
    `);
  }
}

// ─── Stats ───────────────────────────────────────────────────────────────────
router.get("/stats", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const rows = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'draft')::int AS draft,
        COUNT(*) FILTER (WHERE status IN ('sent','viewed'))::int AS outstanding,
        COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
        COALESCE(SUM(total) FILTER (WHERE status = 'accepted'
          AND accepted_at >= date_trunc('month', now())), 0)::numeric AS accepted_value_month
      FROM estimates WHERE company_id = ${companyId}
    `);
    return res.json((rows as any).rows[0] ?? {});
  } catch (err) {
    console.error("Estimate stats error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── Templates ───────────────────────────────────────────────────────────────
router.get("/templates", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const rows = await db.execute(sql`
      SELECT t.*,
        (SELECT COUNT(*)::int FROM estimate_template_items i WHERE i.template_id = t.id) AS item_count
      FROM estimate_templates t
      WHERE t.company_id = ${companyId}
      ORDER BY t.created_at DESC
    `);
    return res.json({ data: (rows as any).rows });
  } catch (err) {
    console.error("List estimate templates error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/templates/:id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id, 10);
    const t = await db.execute(sql`SELECT * FROM estimate_templates WHERE id = ${id} AND company_id = ${companyId} LIMIT 1`);
    const tpl = (t as any).rows[0];
    if (!tpl) return res.status(404).json({ error: "Not Found" });
    const items = await db.execute(sql`
      SELECT * FROM estimate_template_items WHERE template_id = ${id} AND company_id = ${companyId} ORDER BY sort_order
    `);
    return res.json({ ...tpl, items: (items as any).rows });
  } catch (err) {
    console.error("Get estimate template error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/templates", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const name = str(req.body?.name, 200);
    if (!name) return res.status(400).json({ error: "Bad Request", message: "Template name is required" });
    const items = normalizeItems(req.body?.items);
    const inserted = await db.execute(sql`
      INSERT INTO estimate_templates (company_id, name, title, intro_note, terms, created_by)
      VALUES (${companyId}, ${name}, ${str(req.body?.title, 300)}, ${str(req.body?.intro_note)}, ${str(req.body?.terms)}, ${req.auth!.userId})
      RETURNING id
    `);
    const templateId = (inserted as any).rows[0].id;
    for (const it of items) {
      await db.execute(sql`
        INSERT INTO estimate_template_items
          (template_id, company_id, sort_order, name, description, pricing_type, frequency, quantity, unit_rate, amount)
        VALUES
          (${templateId}, ${companyId}, ${it.sort_order}, ${it.name}, ${it.description},
           ${it.pricing_type}, ${it.frequency}, ${it.quantity}, ${it.unit_rate}, ${it.amount})
      `);
    }
    return res.status(201).json({ id: templateId });
  } catch (err) {
    console.error("Create estimate template error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/templates/:id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id, 10);
    await db.execute(sql`DELETE FROM estimate_template_items WHERE template_id = ${id} AND company_id = ${companyId}`);
    await db.execute(sql`DELETE FROM estimate_templates WHERE id = ${id} AND company_id = ${companyId}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Delete estimate template error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── Public hosted estimate (no auth — tokenized) ───────────────────────────
// [estimate-hosted-page 2026-06-10] The link the office texts/emails to the
// property manager. GET marks first view (sent → viewed); accept/decline are
// idempotent one-way transitions, blocked after expiry. Registered BEFORE
// /:id so "public" never parses as an estimate id.
router.get("/public/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(404).json({ error: "Not Found" });
    const rows = await db.execute(sql`
      SELECT e.*, c.name AS company_name, c.logo_url AS company_logo, c.brand_color AS company_brand_color
      FROM estimates e JOIN companies c ON c.id = e.company_id
      WHERE e.public_token = ${token} AND e.status <> 'draft'
      LIMIT 1
    `);
    const est = (rows as any).rows[0];
    if (!est) {
      // Fallback: a QUOTE's sign_token. Quotes have no dedicated hosted page,
      // so the quote email links here (app.qleno.com/estimate/<sign_token>).
      // Map the quote into the public estimate shape so this same page renders
      // it (read-only — quote accept/decline stays in the office flow).
      const qrows = await db.execute(sql`
        SELECT q.id, q.lead_name, q.address, q.service_type, q.total_price, q.base_price,
               q.addons, q.status, q.created_at, q.sent_at,
               c.name AS company_name, c.logo_url AS company_logo, c.brand_color AS company_brand_color
        FROM quotes q JOIN companies c ON c.id = q.company_id
        WHERE q.sign_token = ${token} LIMIT 1
      `);
      const qt = (qrows as any).rows[0];
      if (!qt) return res.status(404).json({ error: "Not Found" });

      const items: any[] = [];
      if (qt.base_price != null) {
        items.push({
          name: qt.service_type || "Cleaning service", description: null,
          pricing_type: "flat", frequency: null, quantity: 1,
          unit_rate: String(qt.base_price), amount: String(qt.base_price),
        });
      }
      const addons = Array.isArray(qt.addons) ? qt.addons : [];
      for (const a of addons) {
        const amt = (a?.amount ?? a?.price);
        items.push({
          name: a?.name || "Add-on", description: null,
          pricing_type: "flat", frequency: null, quantity: 1,
          unit_rate: amt != null ? String(amt) : null, amount: amt != null ? String(amt) : null,
        });
      }
      const pubStatus = qt.status === "booked" || qt.status === "accepted" ? "accepted" : "sent";
      return res.json({
        estimate_number: `Q-${qt.id}`,
        title: "Your cleaning quote",
        status: pubStatus,
        contact_name: qt.lead_name || null,
        property_name: null,
        service_address: qt.address || null,
        subtotal: qt.total_price != null ? String(qt.total_price) : (qt.base_price != null ? String(qt.base_price) : null),
        total: qt.total_price != null ? String(qt.total_price) : (qt.base_price != null ? String(qt.base_price) : null),
        valid_until: null,
        sent_at: qt.sent_at || null,
        viewed_at: null,
        accepted_at: null,
        created_at: qt.created_at || null,
        company_name: qt.company_name,
        company_logo: qt.company_logo,
        company_brand_color: qt.company_brand_color,
        items,
        is_quote: true,
      });
    }

    const expired = est.valid_until && new Date(est.valid_until) < new Date() && est.status !== "accepted";
    if (expired && est.status !== "expired") {
      await db.execute(sql`UPDATE estimates SET status = 'expired', updated_at = now() WHERE id = ${est.id}`);
      est.status = "expired";
    }
    if (est.status === "sent") {
      await db.execute(sql`UPDATE estimates SET status = 'viewed', viewed_at = COALESCE(viewed_at, now()), updated_at = now() WHERE id = ${est.id}`);
      est.status = "viewed";
      est.viewed_at = est.viewed_at || new Date().toISOString();
    }

    const items = await db.execute(sql`
      SELECT name, description, pricing_type, frequency, quantity, unit_rate, amount
      FROM estimate_line_items WHERE estimate_id = ${est.id} ORDER BY sort_order
    `);
    // Public payload — strip internal fields.
    const {
      internal_notes: _i, created_by: _c, ghl_synced_at: _g,
      account_id: _a, account_property_id: _p, client_id: _cl, branch_id: _b,
      ...pub
    } = est;
    return res.json({ ...pub, items: (items as any).rows });
  } catch (err) {
    console.error("Public estimate error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/public/:token/accept", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    const name = String(req.body?.name || "").trim().slice(0, 200);
    if (!name) return res.status(400).json({ error: "Bad Request", message: "Please enter your name to accept" });
    const rows = await db.execute(sql`
      SELECT id, status, valid_until FROM estimates WHERE public_token = ${token} AND status <> 'draft' LIMIT 1
    `);
    const est = (rows as any).rows[0];
    if (!est) {
      // Fallback: accepting a QUOTE (residential) via its sign_token.
      const qrows = await db.execute(sql`SELECT id, company_id, status FROM quotes WHERE sign_token = ${token} LIMIT 1`);
      const qt = (qrows as any).rows[0];
      if (!qt) return res.status(404).json({ error: "Not Found" });
      if (qt.status === "accepted" || qt.status === "booked") return res.json({ ok: true, status: "accepted" });
      await db.execute(sql`UPDATE quotes SET status = 'accepted', accepted_at = now() WHERE id = ${qt.id}`);
      // Customer accepted → stop the quote-followup cadence (same as office accept).
      try {
        const { stopEnrollmentsForQuote } = await import("../services/followUpService.js");
        await stopEnrollmentsForQuote(Number(qt.id), "accepted");
      } catch (e) { console.warn("[quote accept] stop cadence failed:", e); }
      return res.json({ ok: true, status: "accepted" });
    }
    if (est.status === "accepted") return res.json({ ok: true, status: "accepted" });
    if (est.status === "declined") return res.status(409).json({ error: "Conflict", message: "This estimate was declined" });
    if (est.valid_until && new Date(est.valid_until) < new Date()) {
      return res.status(409).json({ error: "Conflict", message: "This estimate has expired — please contact us for an updated quote" });
    }
    await db.execute(sql`
      UPDATE estimates SET status = 'accepted', accepted_at = now(), accepted_name = ${name}, updated_at = now()
      WHERE id = ${est.id}
    `);
    notifyGhl(req, Number(est.id), "estimate_accepted", name);
    return res.json({ ok: true, status: "accepted" });
  } catch (err) {
    console.error("Accept estimate error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/public/:token/decline", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    const rows = await db.execute(sql`
      SELECT id, status FROM estimates WHERE public_token = ${token} AND status <> 'draft' LIMIT 1
    `);
    const est = (rows as any).rows[0];
    if (!est) return res.status(404).json({ error: "Not Found" });
    if (est.status === "accepted") return res.status(409).json({ error: "Conflict", message: "Already accepted" });
    if (est.status !== "declined") {
      await db.execute(sql`UPDATE estimates SET status = 'declined', declined_at = now(), updated_at = now() WHERE id = ${est.id}`);
      notifyGhl(req, Number(est.id), "estimate_declined");
    }
    return res.json({ ok: true, status: "declined" });
  } catch (err) {
    console.error("Decline estimate error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── List estimates ──────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const status = str(req.query?.status, 40);
    const search = str(req.query?.search, 120);
    const rows = await db.execute(sql`
      SELECT e.id, e.estimate_number, e.status, e.title, e.total, e.subtotal,
             e.contact_name, e.property_name, e.service_address,
             e.sent_at, e.viewed_at, e.accepted_at, e.valid_until, e.created_at,
             a.account_name,
             COALESCE(NULLIF(e.property_name, ''), p.property_name) AS resolved_property,
             COALESCE(a.account_name, e.contact_name, p.property_name, 'Untitled') AS recipient
      FROM estimates e
      LEFT JOIN accounts a ON a.id = e.account_id
      LEFT JOIN account_properties p ON p.id = e.account_property_id
      WHERE e.company_id = ${companyId}
        ${status ? sql`AND e.status = ${status}` : sql``}
        ${search ? sql`AND (a.account_name ILIKE ${"%" + search + "%"} OR e.contact_name ILIKE ${"%" + search + "%"} OR e.property_name ILIKE ${"%" + search + "%"} OR e.estimate_number ILIKE ${"%" + search + "%"})` : sql``}
      ORDER BY e.created_at DESC
      LIMIT 300
    `);
    return res.json({ data: (rows as any).rows });
  } catch (err) {
    console.error("List estimates error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── Get one estimate (with line items) ──────────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id, 10);
    const e = await db.execute(sql`
      SELECT e.*, a.account_name, p.property_name AS account_property_name
      FROM estimates e
      LEFT JOIN accounts a ON a.id = e.account_id
      LEFT JOIN account_properties p ON p.id = e.account_property_id
      WHERE e.id = ${id} AND e.company_id = ${companyId} LIMIT 1
    `);
    const est = (e as any).rows[0];
    if (!est) return res.status(404).json({ error: "Not Found" });
    const items = await db.execute(sql`
      SELECT * FROM estimate_line_items WHERE estimate_id = ${id} AND company_id = ${companyId} ORDER BY sort_order
    `);
    return res.json({ ...est, items: (items as any).rows });
  } catch (err) {
    console.error("Get estimate error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── Create estimate ─────────────────────────────────────────────────────────
router.post("/", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const b = req.body ?? {};

    // Optionally seed line items from a saved template.
    let items = normalizeItems(b.items);
    const fromTemplate = intOrNull(b.from_template_id);
    if (fromTemplate && items.length === 0) {
      const ti = await db.execute(sql`
        SELECT name, description, pricing_type, frequency, quantity, unit_rate
        FROM estimate_template_items WHERE template_id = ${fromTemplate} AND company_id = ${companyId} ORDER BY sort_order
      `);
      items = normalizeItems((ti as any).rows);
    }
    const { subtotal, discount, total } = computeTotals(items, b.discount_amount);

    const inserted = await db.execute(sql`
      INSERT INTO estimates
        (company_id, branch_id, account_id, account_property_id, client_id,
         contact_name, contact_email, contact_phone, property_name, service_address,
         title, intro_note, terms, internal_notes, status,
         subtotal, discount_amount, total, valid_until, created_by, updated_at)
      VALUES
        (${companyId}, ${intOrNull(b.branch_id)}, ${intOrNull(b.account_id)}, ${intOrNull(b.account_property_id)}, ${intOrNull(b.client_id)},
         ${str(b.contact_name, 200)}, ${str(b.contact_email, 200)}, ${str(b.contact_phone, 40)}, ${str(b.property_name, 300)}, ${str(b.service_address, 400)},
         ${str(b.title, 300)}, ${str(b.intro_note)}, ${str(b.terms)}, ${str(b.internal_notes)}, 'draft',
         ${subtotal}, ${discount}, ${total}, ${b.valid_until ? new Date(b.valid_until) : null}, ${req.auth!.userId}, now())
      RETURNING id
    `);
    const id = (inserted as any).rows[0].id;
    await db.execute(sql`UPDATE estimates SET estimate_number = ${"EST-" + String(1000 + id)} WHERE id = ${id}`);
    await insertLineItems(id, companyId, items);
    return res.status(201).json({ id });
  } catch (err) {
    console.error("Create estimate error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── Update estimate (replaces line items) ───────────────────────────────────
router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id, 10);
    const exists = await db.execute(sql`SELECT id FROM estimates WHERE id = ${id} AND company_id = ${companyId} LIMIT 1`);
    if (!(exists as any).rows[0]) return res.status(404).json({ error: "Not Found" });

    const b = req.body ?? {};
    const items = normalizeItems(b.items);
    const { subtotal, discount, total } = computeTotals(items, b.discount_amount);

    await db.execute(sql`
      UPDATE estimates SET
        account_id = ${intOrNull(b.account_id)},
        account_property_id = ${intOrNull(b.account_property_id)},
        client_id = ${intOrNull(b.client_id)},
        contact_name = ${str(b.contact_name, 200)},
        contact_email = ${str(b.contact_email, 200)},
        contact_phone = ${str(b.contact_phone, 40)},
        property_name = ${str(b.property_name, 300)},
        service_address = ${str(b.service_address, 400)},
        title = ${str(b.title, 300)},
        intro_note = ${str(b.intro_note)},
        terms = ${str(b.terms)},
        internal_notes = ${str(b.internal_notes)},
        subtotal = ${subtotal},
        discount_amount = ${discount},
        total = ${total},
        valid_until = ${b.valid_until ? new Date(b.valid_until) : null},
        updated_at = now()
      WHERE id = ${id} AND company_id = ${companyId}
    `);
    await db.execute(sql`DELETE FROM estimate_line_items WHERE estimate_id = ${id} AND company_id = ${companyId}`);
    await insertLineItems(id, companyId, items);
    return res.json({ id });
  } catch (err) {
    console.error("Update estimate error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── Save an estimate's line items as a reusable template ─────────────────────
router.post("/:id/save-as-template", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id, 10);
    const name = str(req.body?.name, 200);
    if (!name) return res.status(400).json({ error: "Bad Request", message: "Template name is required" });
    const e = await db.execute(sql`SELECT title, intro_note, terms FROM estimates WHERE id = ${id} AND company_id = ${companyId} LIMIT 1`);
    const est = (e as any).rows[0];
    if (!est) return res.status(404).json({ error: "Not Found" });
    const inserted = await db.execute(sql`
      INSERT INTO estimate_templates (company_id, name, title, intro_note, terms, created_by)
      VALUES (${companyId}, ${name}, ${est.title}, ${est.intro_note}, ${est.terms}, ${req.auth!.userId})
      RETURNING id
    `);
    const templateId = (inserted as any).rows[0].id;
    await db.execute(sql`
      INSERT INTO estimate_template_items
        (template_id, company_id, sort_order, name, description, pricing_type, frequency, quantity, unit_rate, amount)
      SELECT ${templateId}, ${companyId}, sort_order, name, description, pricing_type, frequency, quantity, unit_rate, amount
      FROM estimate_line_items WHERE estimate_id = ${id} AND company_id = ${companyId}
    `);
    return res.status(201).json({ id: templateId });
  } catch (err) {
    console.error("Save estimate as template error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── Send: mark sent, mint the public token, notify GHL to start the drip ────
router.post("/:id/send", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id, 10);
    const e = await db.execute(sql`SELECT public_token, valid_until FROM estimates WHERE id = ${id} AND company_id = ${companyId} LIMIT 1`);
    const est = (e as any).rows[0];
    if (!est) return res.status(404).json({ error: "Not Found" });
    const token = est.public_token || randomUUID();
    // Default a 30-day validity window if none was set.
    const validUntil = est.valid_until || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.execute(sql`
      UPDATE estimates
      SET status = 'sent', sent_at = COALESCE(sent_at, now()), public_token = ${token}, valid_until = ${validUntil}, updated_at = now()
      WHERE id = ${id} AND company_id = ${companyId}
    `);
    notifyGhl(req, id, "estimate_sent");
    return res.json({ id, public_token: token });
  } catch (err) {
    console.error("Send estimate error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id, 10);
    await db.execute(sql`DELETE FROM estimate_line_items WHERE estimate_id = ${id} AND company_id = ${companyId}`);
    await db.execute(sql`DELETE FROM estimates WHERE id = ${id} AND company_id = ${companyId}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Delete estimate error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
