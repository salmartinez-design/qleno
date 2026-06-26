import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { requireAuth } from "../lib/auth.js";
import { enrollForEstimateSent, stopEnrollmentsForEstimate, fireEstimateDay0 } from "../services/followUpService.js";
import { recordEngagementEvent } from "../lib/engagement.js";
import { renderEstimatePdf } from "../lib/estimate-pdf.js";
import { appBaseUrl } from "../lib/app-url.js";

// Fetch a company logo for embedding in the PDF. pdfkit only supports PNG/JPEG,
// so anything else (or a fetch failure) falls back to the company name text.
async function fetchLogoBuffer(logoUrl: string | null | undefined): Promise<Buffer | null> {
  if (!logoUrl) return null;
  try {
    const abs = /^https?:\/\//i.test(logoUrl) ? logoUrl : `${appBaseUrl()}${logoUrl}`;
    const r = await fetch(abs);
    if (!r.ok) return null;
    if (!/image\/(png|jpe?g)/i.test(r.headers.get("content-type") || "")) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

// [commercial-estimate-tool 2026-06-09] Commercial / common-area estimates.
// Raw SQL (db.execute) on purpose: the estimate tables are brand-new and the
// api-server reads the db package's compiled .d.ts, which lags the source by a
// build — raw SQL sidesteps that while the runtime (tsx) reads the live schema.
// Every query is company-scoped via req.auth!.companyId. Line items are stored
// in estimate_line_items; PATCH/create replace the full set (mirrors the
// job_add_ons pattern). Totals are always recomputed server-side.
//
// [native-estimate-workflow 2026-06-25] The GoHighLevel outbound bridge was
// removed — the estimate workflow is 100% native to Qleno (no external
// integrations). Send/accept/decline still mint the token + transition status;
// they just no longer fire a webhook. The companies.ghl_estimate_*_webhook and
// estimates.ghl_synced_at columns are left in place (harmless) but DEPRECATED —
// nothing writes or reads them now. Multi-touch follow-up will be driven by the
// native cadence engine (follow_up_* tables) in a later phase.

const router = Router();

const PRICING_TYPES = new Set(["flat", "hourly", "one_time"]);

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

// [estimate-flat-mode] In 'flat' mode the subtotal is the single flat price the
// office typed — line items are scope only and carry no price. Otherwise the
// subtotal is the sum of line-item amounts (itemized, the default).
function computeTotals(items: NormalizedItem[], discountRaw: unknown, billingMode = "itemized", flatPriceRaw?: unknown) {
  const subtotal = billingMode === "flat"
    ? Math.round((Math.max(0, Number(flatPriceRaw ?? 0) || 0)) * 100) / 100
    : Math.round(items.reduce((s, it) => s + it.amount, 0) * 100) / 100;
  const discount = Math.max(0, Number(discountRaw ?? 0) || 0);
  const total = Math.round(Math.max(0, subtotal - discount) * 100) / 100;
  return { subtotal, discount, total };
}

// Normalize the billing mode to one of the two known values.
function billingModeOf(v: unknown): "itemized" | "flat" {
  return String(v ?? "").trim() === "flat" ? "flat" : "itemized";
}

// What the flat price is charged per — drives the "$150 / visit" label.
const PRICE_UNITS = new Set(["visit", "week", "month", "quarter", "year", "service", "total"]);
function priceUnitOf(v: unknown): string {
  const s = String(v ?? "").trim();
  return PRICE_UNITS.has(s) ? s : "visit";
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// [multi-recipient-estimates] Parse a CC list (comma/semicolon/whitespace
// separated, or an array) → a normalized, de-duped, lower-cased comma-joined
// string of valid emails, excluding `exclude` (the primary). Returns null when
// empty. Invalid tokens are dropped silently. Capped at 20 to bound the list.
export function normalizeEmails(v: unknown, exclude?: string | null): string | null {
  const raw = Array.isArray(v) ? v : String(v ?? "").split(/[,;\s]+/);
  const ex = (exclude ?? "").trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const e = String(t ?? "").trim().toLowerCase();
    if (!e || e === ex || seen.has(e) || !EMAIL_RE.test(e)) continue;
    seen.add(e);
    out.push(e);
    if (out.length >= 20) break;
  }
  return out.length ? out.join(",") : null;
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
        COUNT(*) FILTER (WHERE status <> 'draft')::int AS sent,
        -- Recurring pipeline (flat, priced per month) still open
        COALESCE(SUM(flat_price) FILTER (WHERE billing_mode = 'flat' AND flat_price_unit = 'month'
          AND status IN ('sent','viewed')), 0)::numeric AS mrr_pipeline,
        -- Recurring won, annualized
        COALESCE(SUM(flat_price * 12) FILTER (WHERE billing_mode = 'flat' AND flat_price_unit = 'month'
          AND status = 'accepted'), 0)::numeric AS arr_won,
        -- Open non-recurring (one-time / add-ons / itemized)
        COALESCE(SUM(total) FILTER (WHERE status IN ('sent','viewed')
          AND NOT (billing_mode = 'flat' AND flat_price_unit = 'month')), 0)::numeric AS specialty_pipeline,
        COALESCE(SUM(total) FILTER (WHERE status = 'accepted'
          AND accepted_at >= date_trunc('month', now())), 0)::numeric AS accepted_value_month
      FROM estimates WHERE company_id = ${companyId}
    `);
    const r: any = (rows as any).rows[0] ?? {};
    const sent = Number(r.sent) || 0, accepted = Number(r.accepted) || 0;
    r.close_rate = sent > 0 ? Math.round((accepted / sent) * 100) : 0;
    return res.json(r);
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
    const billingMode = billingModeOf(req.body?.billing_mode);
    const flatPrice = billingMode === "flat" ? Math.max(0, Number(req.body?.flat_price ?? 0) || 0) : 0;
    const inserted = await db.execute(sql`
      INSERT INTO estimate_templates (company_id, name, category, title, intro_note, terms, billing_mode, flat_price, created_by)
      VALUES (${companyId}, ${name}, ${str(req.body?.category, 40)}, ${str(req.body?.title, 300)}, ${str(req.body?.intro_note)}, ${str(req.body?.terms)}, ${billingMode}, ${flatPrice}, ${req.auth!.userId})
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

// Update a template/package in place (replaces its items). Used by the
// Settings → Packages authoring screen.
router.patch("/templates/:id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id, 10);
    const exists = await db.execute(sql`SELECT id FROM estimate_templates WHERE id = ${id} AND company_id = ${companyId} LIMIT 1`);
    if (!(exists as any).rows[0]) return res.status(404).json({ error: "Not Found" });
    const name = str(req.body?.name, 200);
    if (!name) return res.status(400).json({ error: "Bad Request", message: "Template name is required" });
    const items = normalizeItems(req.body?.items);
    const billingMode = billingModeOf(req.body?.billing_mode);
    const flatPrice = billingMode === "flat" ? Math.max(0, Number(req.body?.flat_price ?? 0) || 0) : 0;
    await db.execute(sql`
      UPDATE estimate_templates SET
        name = ${name}, category = ${str(req.body?.category, 40)}, title = ${str(req.body?.title, 300)},
        intro_note = ${str(req.body?.intro_note)}, terms = ${str(req.body?.terms)},
        billing_mode = ${billingMode}, flat_price = ${flatPrice}
      WHERE id = ${id} AND company_id = ${companyId}
    `);
    await db.execute(sql`DELETE FROM estimate_template_items WHERE template_id = ${id} AND company_id = ${companyId}`);
    for (const it of items) {
      await db.execute(sql`
        INSERT INTO estimate_template_items
          (template_id, company_id, sort_order, name, description, pricing_type, frequency, quantity, unit_rate, amount)
        VALUES
          (${id}, ${companyId}, ${it.sort_order}, ${it.name}, ${it.description},
           ${it.pricing_type}, ${it.frequency}, ${it.quantity}, ${it.unit_rate}, ${it.amount})
      `);
    }
    return res.json({ id });
  } catch (err) {
    console.error("Update estimate template error:", err);
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

// ─── Native estimate follow-up drip editor (replaces the GoHighLevel bridge) ──
// Read + edit the company's estimate_followup sequence and its steps in-app; the
// existing engine (followUpService.processEnrollment) sends straight from these.
// Registered before /:id so the literal path wins over the :id param.
router.get("/follow-up", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const seqRows = await db.execute(sql`
      SELECT id, name, is_active FROM follow_up_sequences
      WHERE company_id = ${companyId} AND sequence_type = 'estimate_followup'
      ORDER BY id LIMIT 1
    `);
    const seq = (seqRows as any).rows[0] ?? null;
    if (!seq) return res.json({ sequence: null, steps: [] });
    const steps = await db.execute(sql`
      SELECT step_number, channel, delay_hours, subject, message_template
      FROM follow_up_steps WHERE sequence_id = ${seq.id} ORDER BY step_number
    `);
    return res.json({ sequence: seq, steps: (steps as any).rows });
  } catch (err) {
    console.error("Get estimate follow-up error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/follow-up", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const b = req.body ?? {};
    const isActive = b.is_active === true;
    // Normalize incoming steps; order in the array = send order.
    const steps = (Array.isArray(b.steps) ? b.steps : []).map((s: any, i: number) => ({
      step_number: i + 1,
      channel: String(s?.channel) === "sms" ? "sms" : "email",
      delay_hours: Math.max(0, Math.round(Number(s?.delay_hours ?? 0)) || 0),
      subject: str(s?.subject, 300),
      message_template: str(s?.message_template, 4000),
    })).filter((s: any) => s.message_template);

    // Find or create the company's estimate sequence.
    const existing = await db.execute(sql`
      SELECT id FROM follow_up_sequences WHERE company_id = ${companyId} AND sequence_type = 'estimate_followup' ORDER BY id LIMIT 1
    `);
    let seqId = (existing as any).rows[0]?.id as number | undefined;
    if (!seqId) {
      const ins = await db.execute(sql`
        INSERT INTO follow_up_sequences (company_id, sequence_type, name, is_active)
        VALUES (${companyId}, 'estimate_followup', 'Estimate Follow-Up', ${isActive}) RETURNING id
      `);
      seqId = (ins as any).rows[0].id;
    } else {
      await db.execute(sql`UPDATE follow_up_sequences SET is_active = ${isActive} WHERE id = ${seqId} AND company_id = ${companyId}`);
    }
    // Replace steps wholesale.
    await db.execute(sql`DELETE FROM follow_up_steps WHERE sequence_id = ${seqId}`);
    for (const s of steps) {
      await db.execute(sql`
        INSERT INTO follow_up_steps (sequence_id, step_number, delay_hours, channel, subject, message_template)
        VALUES (${seqId}, ${s.step_number}, ${s.delay_hours}, ${s.channel}, ${s.subject}, ${s.message_template})
      `);
    }
    return res.json({ ok: true, sequence_id: seqId, steps: steps.length, is_active: isActive });
  } catch (err) {
    console.error("Save estimate follow-up error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── Engagement dashboard (Phase 5) ─────────────────────────────────────────
// Read models over engagement_events + follow_up_enrollments + estimates. All
// company-scoped. Registered before /:id (distinct 2-segment paths, no clash).

// Per-estimate aggregate sub-select (opens / clicks / views / touches sent).
const EV_AGG = sql`
  SELECT
    COUNT(*) FILTER (WHERE event_type = 'opened')                 AS opened,
    COUNT(*) FILTER (WHERE event_type = 'clicked')                AS clicked,
    COUNT(*) FILTER (WHERE event_type IN ('viewed'))              AS viewed,
    COUNT(*) FILTER (WHERE event_type = 'sent')                   AS touches_sent,
    MAX(occurred_at)                                              AS last_event_at
  FROM engagement_events ee WHERE ee.estimate_id = e.id`;

// GET /api/estimates/engagement/pipeline — all sent estimates + engagement.
router.get("/engagement/pipeline", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const rows = await db.execute(sql`
      SELECT e.id, e.estimate_number, e.status, e.total, e.sent_at, e.accepted_at, e.declined_at,
             COALESCE(NULLIF(e.property_name, ''), NULLIF(e.contact_name, ''), 'Untitled') AS recipient,
             ev.opened, ev.clicked, ev.viewed, ev.touches_sent, ev.last_event_at,
             enr.current_step, enr.next_fire_at, enr.stopped_at, enr.completed_at
      FROM estimates e
      LEFT JOIN LATERAL (${EV_AGG}) ev ON true
      LEFT JOIN LATERAL (
        SELECT current_step, next_fire_at, stopped_at, completed_at
        FROM follow_up_enrollments fe WHERE fe.estimate_id = e.id ORDER BY fe.id DESC LIMIT 1
      ) enr ON true
      WHERE e.company_id = ${companyId} AND e.status <> 'draft'
      ORDER BY e.sent_at DESC NULLS LAST, e.id DESC
      LIMIT 300
    `);
    return res.json({ data: (rows as any).rows });
  } catch (err) {
    console.error("Engagement pipeline error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /api/estimates/engagement/summary?month=YYYY-MM — month rollup.
router.get("/engagement/summary", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const monthStr = str(req.query?.month, 7); // "YYYY-MM"
    const now = new Date();
    const base = monthStr && /^\d{4}-\d{2}$/.test(monthStr)
      ? new Date(`${monthStr}-01T00:00:00Z`)
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1)).toISOString();
    const end = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1)).toISOString();

    const agg = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE e.sent_at >= ${start} AND e.sent_at < ${end})                                  AS sent,
        COUNT(*) FILTER (WHERE e.sent_at >= ${start} AND e.sent_at < ${end} AND ev.opened > 0)                AS opened,
        COUNT(*) FILTER (WHERE e.sent_at >= ${start} AND e.sent_at < ${end} AND ev.clicked > 0)               AS clicked,
        COUNT(*) FILTER (WHERE e.accepted_at >= ${start} AND e.accepted_at < ${end})                          AS won,
        COUNT(*) FILTER (WHERE e.declined_at >= ${start} AND e.declined_at < ${end})                          AS lost
      FROM estimates e
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE event_type IN ('opened','viewed')) AS opened,
               COUNT(*) FILTER (WHERE event_type = 'clicked') AS clicked
        FROM engagement_events ee WHERE ee.estimate_id = e.id
      ) ev ON true
      WHERE e.company_id = ${companyId}
    `);
    const won = await db.execute(sql`
      SELECT COALESCE(AVG(t.cnt), 0)::numeric(6,1) AS avg_touches_to_win FROM (
        SELECT (SELECT COUNT(*) FROM engagement_events ee WHERE ee.estimate_id = e.id AND ee.event_type = 'sent') AS cnt
        FROM estimates e
        WHERE e.company_id = ${companyId} AND e.accepted_at >= ${start} AND e.accepted_at < ${end}
      ) t
    `);
    const row: any = (agg as any).rows[0] ?? {};
    const sent = Number(row.sent || 0);
    return res.json({
      month: `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}`,
      sent,
      opened: Number(row.opened || 0),
      clicked: Number(row.clicked || 0),
      won: Number(row.won || 0),
      lost: Number(row.lost || 0),
      opened_pct: sent ? Math.round((Number(row.opened || 0) / sent) * 100) : 0,
      clicked_pct: sent ? Math.round((Number(row.clicked || 0) / sent) * 100) : 0,
      avg_touches_to_win: Number((won as any).rows[0]?.avg_touches_to_win || 0),
    });
  } catch (err) {
    console.error("Engagement summary error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /api/estimates/:id/engagement — per-estimate detail + touchpoint timeline.
router.get("/:id/engagement", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(404).json({ error: "Not Found" });
    const e = await db.execute(sql`
      SELECT id, estimate_number, status, total, contact_name, property_name, service_address,
             sent_at, viewed_at, accepted_at, declined_at
      FROM estimates WHERE id = ${id} AND company_id = ${companyId} LIMIT 1
    `);
    const est = (e as any).rows[0];
    if (!est) return res.status(404).json({ error: "Not Found" });

    const counts = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'opened')  AS opened,
        COUNT(*) FILTER (WHERE event_type = 'clicked') AS clicked,
        COUNT(*) FILTER (WHERE event_type = 'viewed')  AS viewed,
        COUNT(*) FILTER (WHERE event_type = 'sent')    AS touches_sent
      FROM engagement_events WHERE estimate_id = ${id} AND company_id = ${companyId}
    `);
    const timeline = await db.execute(sql`
      SELECT event_type, channel, recipient, meta, occurred_at
      FROM engagement_events WHERE estimate_id = ${id} AND company_id = ${companyId}
      ORDER BY occurred_at ASC, id ASC
    `);
    // Latest enrollment → next scheduled touch + step progress.
    const enr = await db.execute(sql`
      SELECT fe.id, fe.current_step, fe.next_fire_at, fe.stopped_at, fe.stopped_reason, fe.completed_at,
             (SELECT COUNT(*)::int FROM follow_up_steps s WHERE s.sequence_id = fe.sequence_id) AS total_steps,
             (SELECT channel FROM follow_up_steps s WHERE s.sequence_id = fe.sequence_id AND s.step_number = fe.current_step LIMIT 1) AS next_channel
      FROM follow_up_enrollments fe WHERE fe.estimate_id = ${id} AND fe.company_id = ${companyId}
      ORDER BY fe.id DESC LIMIT 1
    `);

    return res.json({
      estimate: est,
      counts: (counts as any).rows[0] ?? { opened: 0, clicked: 0, viewed: 0, touches_sent: 0 },
      timeline: (timeline as any).rows,
      enrollment: (enr as any).rows[0] ?? null,
    });
  } catch (err) {
    console.error("Estimate engagement error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Stop the follow-up drip for an estimate (office "Stop follow-ups" button).
router.post("/:id/stop-followups", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(String(req.params.id), 10);
    const exists = await db.execute(sql`SELECT id FROM estimates WHERE id = ${id} AND company_id = ${companyId} LIMIT 1`);
    if (!(exists as any).rows[0]) return res.status(404).json({ error: "Not Found" });
    await stopEnrollmentsForEstimate(id, "manual");
    return res.json({ ok: true });
  } catch (err) {
    console.error("Stop estimate follow-ups error:", err);
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
      SELECT e.*, c.name AS company_name, c.logo_url AS company_logo, c.brand_color AS company_brand_color,
             c.phone AS company_phone, c.email AS company_email,
             bz.name AS branch_name, bz.phone AS branch_phone
      FROM estimates e
      JOIN companies c ON c.id = e.company_id
      LEFT JOIN branches bz ON bz.id = e.branch_id
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
               q.frequency, q.frequency_options, q.selected_frequency,
               c.name AS company_name, c.logo_url AS company_logo, c.brand_color AS company_brand_color,
               c.phone AS company_phone, c.email AS company_email
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
        company_phone: qt.company_phone,
        company_email: qt.company_email,
        items,
        is_quote: true,
        // [multi-frequency] additive — the comparison tiers (empty array when the
        // quote has no snapshot, so the Pass-1 single-total render is unaffected).
        frequency: qt.frequency || null,
        options: Array.isArray(qt.frequency_options) ? qt.frequency_options : [],
        selected_frequency: qt.selected_frequency || null,
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
    // [engagement-phase4] Record the hosted-page view (web channel).
    recordEngagementEvent({ companyId: est.company_id, estimateId: est.id, eventType: "viewed", channel: "web",
      meta: { ua: req.get("user-agent") || null } }).catch(() => {});

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
    // SMS consent captured on the customer-facing quote-acceptance page (gated
    // there). Recorded in the lead audit note below for proof of consent.
    const smsConsent = req.body?.sms_consent === true;
    const rows = await db.execute(sql`
      SELECT id, company_id, status, valid_until FROM estimates WHERE public_token = ${token} AND status <> 'draft' LIMIT 1
    `);
    const est = (rows as any).rows[0];
    if (!est) {
      // Fallback: accepting a QUOTE (residential) via its sign_token.
      const qrows = await db.execute(sql`SELECT id, company_id, status, lead_id, lead_name FROM quotes WHERE sign_token = ${token} LIMIT 1`);
      const qt = (qrows as any).rows[0];
      if (!qt) return res.status(404).json({ error: "Not Found" });
      // [multi-frequency] the plan the customer selected (decision b: warm +
      // accept-intent — record the choice, mark accepted, warm the lead, notify
      // the office; booking stays office-confirmed, no public self-book).
      const FREQ_LABELS: Record<string, string> = { onetime: "One-time", weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Every 4 weeks" };
      const rawFreq = String(req.body?.selected_frequency || "").trim();
      const chosenFreq = FREQ_LABELS[rawFreq] ? rawFreq : null;
      if (qt.status === "accepted" || qt.status === "booked") {
        if (chosenFreq) await db.execute(sql`UPDATE quotes SET selected_frequency = ${chosenFreq}, selected_frequency_at = now() WHERE id = ${qt.id}`).catch(() => {});
        return res.json({ ok: true, status: "accepted" });
      }
      await db.execute(sql`
        UPDATE quotes SET status = 'accepted', accepted_at = now(),
          selected_frequency = ${chosenFreq}, selected_frequency_at = ${chosenFreq ? sql`now()` : sql`NULL`}
        WHERE id = ${qt.id}`);
      // Customer accepted → stop the quote-followup cadence (same as office accept).
      try {
        const { stopEnrollmentsForQuote } = await import("../services/followUpService.js");
        await stopEnrollmentsForQuote(Number(qt.id), "accepted");
      } catch (e) { console.warn("[quote accept] stop cadence failed:", e); }
      // Warm the lead + notify the office (non-blocking).
      const planLabel = chosenFreq ? FREQ_LABELS[chosenFreq] : null;
      (async () => {
        try {
          if (qt.lead_id) {
            await db.execute(sql`
              INSERT INTO lead_activity_log (lead_id, company_id, action_type, note, performed_by)
              VALUES (${qt.lead_id}, ${qt.company_id}, 'interested', ${`Customer accepted${planLabel ? " — " + planLabel + " plan" : ""} (${name})${smsConsent ? " — SMS consent given" : ""}`}, NULL)`).catch(() => {});
          }
          const { notifyOfficeUsers } = await import("../lib/notify.js");
          await notifyOfficeUsers(qt.company_id, {
            type: "quote_interest",
            title: "Quote interest",
            body: `${qt.lead_name || name || "A customer"} accepted quote Q-${qt.id}${planLabel ? ` — ${planLabel} plan` : ""}. Confirm to book.`,
            link: `/quotes/${qt.id}`,
            meta: { quote_id: qt.id, selected_frequency: chosenFreq },
          });
        } catch (e) { console.warn("[quote accept] warm/notify failed:", e); }
      })();
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
    // [estimate-drip-phase3] Accepted → stop the follow-up drip. Non-blocking.
    stopEnrollmentsForEstimate(Number(est.id), "accepted").catch(() => {});
    recordEngagementEvent({ companyId: Number(est.company_id), estimateId: Number(est.id), eventType: "accepted", channel: "web", meta: { name } }).catch(() => {});
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
      SELECT id, company_id, status FROM estimates WHERE public_token = ${token} AND status <> 'draft' LIMIT 1
    `);
    const est = (rows as any).rows[0];
    if (!est) return res.status(404).json({ error: "Not Found" });
    if (est.status === "accepted") return res.status(409).json({ error: "Conflict", message: "Already accepted" });
    if (est.status !== "declined") {
      await db.execute(sql`UPDATE estimates SET status = 'declined', declined_at = now(), updated_at = now() WHERE id = ${est.id}`);
      // [estimate-drip-phase3] Declined → stop the follow-up drip. Non-blocking.
      stopEnrollmentsForEstimate(Number(est.id), "declined").catch(() => {});
      recordEngagementEvent({ companyId: Number(est.company_id), estimateId: Number(est.id), eventType: "declined", channel: "web" }).catch(() => {});
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
             e.billing_mode, e.flat_price_unit,
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

// ─── Estimate PDF (office preview of exactly what the client receives) ────────
router.get("/:id/pdf", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id, 10);
    const e = await db.execute(sql`
      SELECT e.*, c.name AS company_name, c.logo_url AS company_logo, c.phone AS company_phone, c.email AS company_email
      FROM estimates e JOIN companies c ON c.id = e.company_id
      WHERE e.id = ${id} AND e.company_id = ${companyId} LIMIT 1
    `);
    const est = (e as any).rows[0];
    if (!est) return res.status(404).json({ error: "Not Found" });
    const items = await db.execute(sql`
      SELECT name, pricing_type, frequency, quantity, unit_rate, amount
      FROM estimate_line_items WHERE estimate_id = ${id} AND company_id = ${companyId} ORDER BY sort_order
    `);
    const logo = await fetchLogoBuffer(est.company_logo);
    const pdf = await renderEstimatePdf({
      companyName: est.company_name || "Estimate", logo,
      companyPhone: est.company_phone, companyEmail: est.company_email,
      estimateNumber: est.estimate_number, status: est.status,
      title: est.title, introNote: est.intro_note,
      contactName: est.contact_name, propertyName: est.property_name, serviceAddress: est.service_address,
      billingMode: est.billing_mode || "itemized", flatPriceUnit: est.flat_price_unit, scopeNote: est.scope_note,
      items: (items as any).rows,
      subtotal: est.subtotal, discount: est.discount_amount, total: est.total,
      terms: est.terms, validUntil: est.valid_until ? String(est.valid_until) : null,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${est.estimate_number || `estimate-${id}`}.pdf"`);
    return res.end(pdf);
  } catch (err) {
    console.error("Estimate PDF error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── Text the estimate (SMS) + preview ───────────────────────────────────────
// Loads the estimate, ensures a public link exists, and builds the SMS body.
// Shared by the preview (GET) and the send (POST) so they never drift.
async function loadEstimateForSms(companyId: number, id: number) {
  const e = await db.execute(sql`
    SELECT e.id, e.status, e.public_token, e.branch_id, e.contact_name, e.contact_phone, c.name AS company_name
    FROM estimates e JOIN companies c ON c.id = e.company_id
    WHERE e.id = ${id} AND e.company_id = ${companyId} LIMIT 1
  `);
  const est = (e as any).rows[0];
  if (!est) return null;
  // Ensure a resolvable link (generate token + flip draft→sent so the hosted
  // page renders) without touching the drip — that still starts via /send.
  let token = est.public_token as string | null;
  if (!token || est.status === "draft") {
    token = token || randomUUID();
    await db.execute(sql`
      UPDATE estimates SET public_token = ${token}, status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
        sent_at = COALESCE(sent_at, now()), updated_at = now()
      WHERE id = ${id} AND company_id = ${companyId}
    `);
  }
  const first = (est.contact_name || "").split(" ")[0] || "there";
  const link = `${appBaseUrl()}/estimate/${token}`;
  const body = `Hi ${first}, here is your cleaning estimate from ${est.company_name || "us"}: ${link}`;
  return { est, body };
}
const smsPhone = (p: string | null | undefined): string | null => {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d ? `+${d}` : null;
};

router.get("/:id/sms-preview", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id, 10);
    const r = await loadEstimateForSms(companyId, id);
    if (!r) return res.status(404).json({ error: "Not Found" });
    return res.json({ to: r.est.contact_phone || null, to_e164: smsPhone(r.est.contact_phone), body: r.body });
  } catch (err) {
    console.error("Estimate SMS preview error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/sms", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id, 10);
    const r = await loadEstimateForSms(companyId, id);
    if (!r) return res.status(404).json({ error: "Not Found" });
    // Honor an edited number from the modal (e.g. a personal cell given on a
    // call), else fall back to the contact on file.
    const to = smsPhone(req.body?.to) || smsPhone(r.est.contact_phone);
    if (!to) return res.json({ sent: false, reason: "no_phone" });

    const { resolveSender, sendSmsVia } = await import("../lib/comms-sender.js");
    const sender = await resolveSender(companyId, r.est.branch_id);
    if (sender.reason) return res.json({ sent: false, reason: sender.reason, to });
    await sendSmsVia(sender, to, r.body);
    // Record the manual SMS touch so it shows in the tracking timeline.
    recordEngagementEvent({ companyId, estimateId: id, eventType: "sent", channel: "sms", recipient: to,
      meta: { manual: true } }).catch(() => {});
    return res.json({ sent: true, to });
  } catch (err) {
    console.error("Estimate SMS send error:", err);
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
    const billingMode = billingModeOf(b.billing_mode);
    const { subtotal, discount, total } = computeTotals(items, b.discount_amount, billingMode, b.flat_price);
    const flatPrice = billingMode === "flat" ? subtotal : 0;

    const inserted = await db.execute(sql`
      INSERT INTO estimates
        (company_id, branch_id, account_id, account_property_id, client_id,
         contact_name, contact_email, cc_emails, contact_phone, property_name, service_address,
         title, intro_note, terms, internal_notes, status, billing_mode, flat_price, flat_price_unit, scope_note,
         subtotal, discount_amount, total, valid_until, created_by, updated_at)
      VALUES
        (${companyId}, ${intOrNull(b.branch_id)}, ${intOrNull(b.account_id)}, ${intOrNull(b.account_property_id)}, ${intOrNull(b.client_id)},
         ${str(b.contact_name, 200)}, ${str(b.contact_email, 200)}, ${normalizeEmails(b.cc_emails, str(b.contact_email, 200))}, ${str(b.contact_phone, 40)}, ${str(b.property_name, 300)}, ${str(b.service_address, 400)},
         ${str(b.title, 300)}, ${str(b.intro_note)}, ${str(b.terms)}, ${str(b.internal_notes)}, 'draft', ${billingMode}, ${flatPrice}, ${priceUnitOf(b.flat_price_unit)}, ${str(b.scope_note)},
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
    const billingMode = billingModeOf(b.billing_mode);
    const { subtotal, discount, total } = computeTotals(items, b.discount_amount, billingMode, b.flat_price);
    const flatPrice = billingMode === "flat" ? subtotal : 0;

    await db.execute(sql`
      UPDATE estimates SET
        account_id = ${intOrNull(b.account_id)},
        billing_mode = ${billingMode},
        flat_price = ${flatPrice},
        flat_price_unit = ${priceUnitOf(b.flat_price_unit)},
        scope_note = ${str(b.scope_note)},
        account_property_id = ${intOrNull(b.account_property_id)},
        client_id = ${intOrNull(b.client_id)},
        contact_name = ${str(b.contact_name, 200)},
        contact_email = ${str(b.contact_email, 200)},
        cc_emails = ${normalizeEmails(b.cc_emails, str(b.contact_email, 200))},
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
    const e = await db.execute(sql`SELECT title, intro_note, terms, billing_mode, flat_price FROM estimates WHERE id = ${id} AND company_id = ${companyId} LIMIT 1`);
    const est = (e as any).rows[0];
    if (!est) return res.status(404).json({ error: "Not Found" });
    // Carry the estimate's pricing mode → a flat estimate becomes a package.
    const inserted = await db.execute(sql`
      INSERT INTO estimate_templates (company_id, name, title, intro_note, terms, billing_mode, flat_price, created_by)
      VALUES (${companyId}, ${name}, ${est.title}, ${est.intro_note}, ${est.terms}, ${est.billing_mode ?? "itemized"}, ${est.flat_price ?? 0}, ${req.auth!.userId})
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

// ─── Send: mark sent + mint the public token (native — no external webhook) ──
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
    // [estimate-drip-phase3] Auto-enroll into the native estimate follow-up
    // cadence (no-op unless an ACTIVE estimate_followup sequence exists).
    // [estimate-send-now] Then fire the Day-0 email IMMEDIATELY (gated path) so
    // the prospect gets it now instead of waiting up to 30 min for the cron, and
    // we can confirm delivery back to the office. Both awaited so the response
    // carries the result.
    await enrollForEstimateSent(companyId as number, id);
    const day0 = await fireEstimateDay0(companyId as number, id);
    return res.json({ id, public_token: token, emailed: day0.emailed, email_status: day0.status, email_recipient: day0.recipient ?? null });
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
