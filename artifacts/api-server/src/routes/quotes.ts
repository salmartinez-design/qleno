import { Router } from "express";
import { db } from "@workspace/db";
import { quotesTable, clientsTable, quoteScopesTable } from "@workspace/db/schema";
import { eq, and, desc, count, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

async function getQuoteWithDetails(id: number, companyId: number) {
  const [quote] = await db
    .select({
      id: quotesTable.id,
      company_id: quotesTable.company_id,
      client_id: quotesTable.client_id,
      lead_name: quotesTable.lead_name,
      lead_email: quotesTable.lead_email,
      lead_phone: quotesTable.lead_phone,
      address: quotesTable.address,
      service_type: quotesTable.service_type,
      frequency: quotesTable.frequency,
      estimated_hours: quotesTable.estimated_hours,
      base_price: quotesTable.base_price,
      total_price: quotesTable.total_price,
      discount_amount: quotesTable.discount_amount,
      discount_code: quotesTable.discount_code,
      status: quotesTable.status,
      sent_at: quotesTable.sent_at,
      viewed_at: quotesTable.viewed_at,
      accepted_at: quotesTable.accepted_at,
      booked_job_id: quotesTable.booked_job_id,
      notes: quotesTable.notes,
      created_by: quotesTable.created_by,
      created_at: quotesTable.created_at,
      scope_id: quotesTable.scope_id,
      pricing_method: quotesTable.pricing_method,
      addons: quotesTable.addons,
      bedrooms: quotesTable.bedrooms,
      bathrooms: quotesTable.bathrooms,
      half_baths: quotesTable.half_baths,
      sqft: quotesTable.sqft,
      dirt_level: quotesTable.dirt_level,
      pets: quotesTable.pets,
      special_instructions: quotesTable.special_instructions,
      internal_memo: quotesTable.internal_memo,
      client_notes: quotesTable.client_notes,
      manual_hours: quotesTable.manual_hours,
      expires_at: quotesTable.expires_at,
      sign_token: quotesTable.sign_token,
      client_first: clientsTable.first_name,
      client_last: clientsTable.last_name,
      client_email: clientsTable.email,
      client_phone: clientsTable.phone,
      scope_name: quoteScopesTable.name,
      scope_category: quoteScopesTable.category,
    })
    .from(quotesTable)
    .leftJoin(clientsTable, eq(quotesTable.client_id, clientsTable.id))
    .leftJoin(quoteScopesTable, eq(quotesTable.scope_id, quoteScopesTable.id))
    .where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, companyId)))
    .limit(1);
  return quote;
}

router.get("/stats", requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const allQuotes = await db.select({ status: quotesTable.status, accepted_at: quotesTable.accepted_at, booked_job_id: quotesTable.booked_job_id })
      .from(quotesTable)
      .where(eq(quotesTable.company_id, req.auth!.companyId));

    const total = allQuotes.length;
    const pending = allQuotes.filter(q => q.status === "sent" || q.status === "viewed").length;
    const accepted_this_month = allQuotes.filter(q => q.status === "accepted" && q.accepted_at && new Date(q.accepted_at) >= monthStart).length;
    const converted = allQuotes.filter(q => q.status === "booked" || q.booked_job_id).length;

    return res.json({ total, pending, accepted_this_month, converted });
  } catch (err) {
    console.error("Quote stats error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const { status, client_id } = req.query;
    const conditions: any[] = [eq(quotesTable.company_id, req.auth!.companyId)];
    if (status && status !== "all") conditions.push(eq(quotesTable.status, status as string));
    if (client_id) conditions.push(eq(quotesTable.client_id, parseInt(client_id as string)));

    const quotes = await db
      .select({
        id: quotesTable.id,
        company_id: quotesTable.company_id,
        client_id: quotesTable.client_id,
        lead_name: quotesTable.lead_name,
        lead_email: quotesTable.lead_email,
        address: quotesTable.address,
        frequency: quotesTable.frequency,
        estimated_hours: quotesTable.estimated_hours,
        base_price: quotesTable.base_price,
        total_price: quotesTable.total_price,
        discount_amount: quotesTable.discount_amount,
        status: quotesTable.status,
        sent_at: quotesTable.sent_at,
        accepted_at: quotesTable.accepted_at,
        created_at: quotesTable.created_at,
        scope_id: quotesTable.scope_id,
        bedrooms: quotesTable.bedrooms,
        bathrooms: quotesTable.bathrooms,
        sqft: quotesTable.sqft,
        client_first: clientsTable.first_name,
        client_last: clientsTable.last_name,
        client_email: clientsTable.email,
        scope_name: quoteScopesTable.name,
      })
      .from(quotesTable)
      .leftJoin(clientsTable, eq(quotesTable.client_id, clientsTable.id))
      .leftJoin(quoteScopesTable, eq(quotesTable.scope_id, quoteScopesTable.id))
      .where(and(...conditions))
      .orderBy(desc(quotesTable.created_at));

    return res.json(quotes);
  } catch (err) {
    console.error("List quotes error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const quote = await getQuoteWithDetails(parseInt(req.params.id), req.auth!.companyId);
    if (!quote) return res.status(404).json({ error: "Not Found" });
    return res.json(quote);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const {
      client_id, lead_name, lead_email, lead_phone, address,
      scope_id, pricing_method, frequency, estimated_hours, manual_hours,
      base_price, total_price, discount_amount, discount_code, addons,
      bedrooms, bathrooms, half_baths, sqft, dirt_level, pets,
      special_instructions, internal_memo, client_notes, notes, status,
    } = req.body;

    const scope = scope_id ? await db.select().from(quoteScopesTable).where(eq(quoteScopesTable.id, scope_id)).limit(1) : null;

    const [q] = await db.insert(quotesTable).values({
      company_id: req.auth!.companyId,
      client_id: client_id || null,
      lead_name, lead_email, lead_phone, address,
      service_type: scope?.[0]?.name || null,
      frequency, estimated_hours: estimated_hours ? String(estimated_hours) : null,
      manual_hours: manual_hours ? String(manual_hours) : null,
      base_price: base_price ? String(base_price) : null,
      total_price: total_price ? String(total_price) : null,
      discount_amount: discount_amount ? String(discount_amount) : "0",
      discount_code: discount_code || null,
      addons: addons || [],
      scope_id: scope_id || null,
      pricing_method: pricing_method || scope?.[0]?.pricing_method || null,
      bedrooms, bathrooms, half_baths, sqft,
      dirt_level: dirt_level || "standard",
      pets: pets || 0,
      special_instructions, internal_memo, client_notes, notes,
      status: status || "draft",
      created_by: req.auth!.userId,
    }).returning();

    return res.status(201).json(q);
  } catch (err) {
    console.error("Create quote error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const allowed = [
      "status", "base_price", "total_price", "estimated_hours", "manual_hours",
      "notes", "client_notes", "internal_memo", "special_instructions",
      "frequency", "scope_id", "pricing_method", "addons",
      "discount_code", "discount_amount", "bedrooms", "bathrooms", "half_baths",
      "sqft", "dirt_level", "pets", "sent_at", "viewed_at", "accepted_at",
      "lead_name", "lead_email", "lead_phone", "address", "client_id",
    ];
    const updates: any = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        if (["base_price", "total_price", "estimated_hours", "manual_hours", "discount_amount"].includes(k)) {
          updates[k] = req.body[k] !== null ? String(req.body[k]) : null;
        } else {
          updates[k] = req.body[k];
        }
      }
    }

    const [q] = await db.update(quotesTable).set(updates)
      .where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, req.auth!.companyId)))
      .returning();

    if (!q) return res.status(404).json({ error: "Not found" });
    return res.json(q);
  } catch (err) {
    console.error("Update quote error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/send", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const [q] = await db.update(quotesTable)
      .set({ status: "sent", sent_at: new Date() })
      .where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, companyId)))
      .returning();
    if (!q) return res.status(404).json({ error: "Not found" });
    console.log(`[QUOTE SENT] id=${id} lead_email=${q.lead_email}`);
    // Enroll in quote_followup sequence (non-blocking)
    import("../services/followUpService.js").then(({ enrollForQuoteSent }) => {
      enrollForQuoteSent(
        companyId,
        id,
        (q as any).client_id ?? null,
        (q as any).lead_name?.split(" ")[0] || "",
        (q as any).lead_email ?? null,
        (q as any).lead_phone ?? null,
      ).catch(() => {});
    });
    // fire quote_sent notification (non-blocking)
    import("../services/notificationService.js").then(({ sendNotification }) => {
      const mv = {
        first_name:     (q as any).lead_name?.split(" ")[0] || "",
        quote_number:   String(id),
        quote_total:    parseFloat((q as any).total_price || (q as any).base_price || "0").toFixed(2),
        quote_link:     `https://clean-ops-pro.replit.app/quote/${id}`,
        quote_expires:  new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
        service_address: (q as any).address || "",
      };
      sendNotification("quote_sent", "email", companyId, (q as any).lead_email ?? null, null, mv).catch(() => {});
      sendNotification("quote_sent", "sms",   companyId, null, (q as any).lead_phone ?? null, mv).catch(() => {});
    });
    return res.json({ success: true, quote: q });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/accept", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [q] = await db.update(quotesTable)
      .set({ status: "accepted", accepted_at: new Date() })
      .where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, req.auth!.companyId)))
      .returning();
    if (!q) return res.status(404).json({ error: "Not found" });
    // Stop quote_followup enrollment (non-blocking)
    import("../services/followUpService.js").then(({ stopEnrollmentsForQuote }) => {
      stopEnrollmentsForQuote(id, "booked").catch(() => {});
    });
    return res.json({ success: true, quote: q });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/convert", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [q] = await db.update(quotesTable)
      .set({ status: "booked" })
      .where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, req.auth!.companyId)))
      .returning();
    if (!q) return res.status(404).json({ error: "Not found" });
    // Stop quote_followup enrollment (non-blocking)
    import("../services/followUpService.js").then(({ stopEnrollmentsForQuote }) => {
      stopEnrollmentsForQuote(id, "booked").catch(() => {});
    });
    return res.json({ success: true, quote: q, message: "Quote converted. Create a job to complete." });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(quotesTable).where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, req.auth!.companyId)));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
