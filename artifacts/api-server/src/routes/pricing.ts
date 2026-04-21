import { Router } from "express";
import { db } from "@workspace/db";
import {
  pricingScopesTable,
  pricingTiersTable,
  pricingFrequenciesTable,
  pricingAddonsTable,
  pricingDiscountsTable,
  pricingFeeRulesTable,
} from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

// ── Scopes ──────────────────────────────────────────────────────────────────

router.get("/scopes", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const officeOnly = req.query.office === "true";
    const scopes = await db
      .select()
      .from(pricingScopesTable)
      .where(eq(pricingScopesTable.company_id, companyId))
      .orderBy(pricingScopesTable.sort_order, pricingScopesTable.id);
    return res.json(officeOnly ? scopes.filter(s => s.displayed_for_office && s.is_active) : scopes);
  } catch (err) {
    console.error("GET /pricing/scopes:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/scopes/:id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    const [scope] = await db
      .select()
      .from(pricingScopesTable)
      .where(and(eq(pricingScopesTable.id, id), eq(pricingScopesTable.company_id, companyId)));
    if (!scope) return res.status(404).json({ error: "Not found" });
    return res.json(scope);
  } catch (err) {
    console.error("GET /pricing/scopes/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/scopes", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { name, scope_group, pricing_method, hourly_rate, minimum_bill, displayed_for_office, sort_order } = req.body;
    const [scope] = await db
      .insert(pricingScopesTable)
      .values({
        company_id: companyId,
        name,
        scope_group: scope_group || "Residential",
        pricing_method: pricing_method || "sqft",
        hourly_rate: hourly_rate || "0",
        minimum_bill: minimum_bill || "0",
        displayed_for_office: displayed_for_office !== false,
        sort_order: sort_order ?? 0,
      })
      .returning();
    return res.status(201).json(scope);
  } catch (err) {
    console.error("POST /pricing/scopes:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/scopes/:id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    const { name, scope_group, pricing_method, hourly_rate, minimum_bill, displayed_for_office, is_active, sort_order } = req.body;
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (name !== undefined) updates.name = name;
    if (scope_group !== undefined) updates.scope_group = scope_group;
    if (pricing_method !== undefined) updates.pricing_method = pricing_method;
    if (hourly_rate !== undefined) updates.hourly_rate = hourly_rate;
    if (minimum_bill !== undefined) updates.minimum_bill = minimum_bill;
    if (displayed_for_office !== undefined) updates.displayed_for_office = displayed_for_office;
    if (is_active !== undefined) updates.is_active = is_active;
    if (sort_order !== undefined) updates.sort_order = sort_order;
    const [scope] = await db
      .update(pricingScopesTable)
      .set(updates)
      .where(and(eq(pricingScopesTable.id, id), eq(pricingScopesTable.company_id, companyId)))
      .returning();
    if (!scope) return res.status(404).json({ error: "Not found" });
    return res.json(scope);
  } catch (err) {
    console.error("PUT /pricing/scopes/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/scopes/:id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    await db
      .update(pricingScopesTable)
      .set({ is_active: false, updated_at: new Date() })
      .where(and(eq(pricingScopesTable.id, id), eq(pricingScopesTable.company_id, companyId)));
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /pricing/scopes/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Tiers ────────────────────────────────────────────────────────────────────

router.get("/scopes/:id/tiers", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const scopeId = parseInt(req.params.id);
    const tiers = await db
      .select()
      .from(pricingTiersTable)
      .where(and(eq(pricingTiersTable.scope_id, scopeId), eq(pricingTiersTable.company_id, companyId)))
      .orderBy(pricingTiersTable.min_sqft);
    return res.json(tiers);
  } catch (err) {
    console.error("GET /pricing/scopes/:id/tiers:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/scopes/:id/tiers", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const scopeId = parseInt(req.params.id);
    const tiers: Array<{ min_sqft: number; max_sqft: number; hours: string | number }> = req.body;
    if (!Array.isArray(tiers)) return res.status(400).json({ error: "Body must be an array of tiers" });
    await db.delete(pricingTiersTable).where(and(eq(pricingTiersTable.scope_id, scopeId), eq(pricingTiersTable.company_id, companyId)));
    if (tiers.length > 0) {
      await db.insert(pricingTiersTable).values(
        tiers.map(t => ({ scope_id: scopeId, company_id: companyId, min_sqft: t.min_sqft, max_sqft: t.max_sqft, hours: String(t.hours) }))
      );
    }
    const result = await db.select().from(pricingTiersTable).where(and(eq(pricingTiersTable.scope_id, scopeId), eq(pricingTiersTable.company_id, companyId))).orderBy(pricingTiersTable.min_sqft);
    return res.json(result);
  } catch (err) {
    console.error("POST /pricing/scopes/:id/tiers:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Frequencies ──────────────────────────────────────────────────────────────

router.get("/scopes/:id/frequencies", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const scopeId = parseInt(req.params.id);
    const officeOnly = req.query.office === "true";
    const freqs = await db
      .select()
      .from(pricingFrequenciesTable)
      .where(and(eq(pricingFrequenciesTable.scope_id, scopeId), eq(pricingFrequenciesTable.company_id, companyId)))
      .orderBy(pricingFrequenciesTable.sort_order);
    return res.json(officeOnly ? freqs.filter(f => f.show_office) : freqs);
  } catch (err) {
    console.error("GET /pricing/scopes/:id/frequencies:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/scopes/:id/frequencies", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const scopeId = parseInt(req.params.id);
    const freqs: Array<{ frequency: string; label: string; rate_override?: string | null; multiplier?: string | number; show_office?: boolean; sort_order?: number }> = req.body;
    if (!Array.isArray(freqs)) return res.status(400).json({ error: "Body must be an array" });
    await db.delete(pricingFrequenciesTable).where(and(eq(pricingFrequenciesTable.scope_id, scopeId), eq(pricingFrequenciesTable.company_id, companyId)));
    if (freqs.length > 0) {
      await db.insert(pricingFrequenciesTable).values(
        freqs.map((f, i) => ({
          scope_id: scopeId,
          company_id: companyId,
          frequency: f.frequency,
          label: f.label,
          rate_override: f.rate_override ? String(f.rate_override) : null,
          multiplier: String(f.multiplier ?? "1.0000"),
          show_office: f.show_office !== false,
          sort_order: f.sort_order ?? i,
        }))
      );
    }
    const result = await db.select().from(pricingFrequenciesTable).where(and(eq(pricingFrequenciesTable.scope_id, scopeId), eq(pricingFrequenciesTable.company_id, companyId))).orderBy(pricingFrequenciesTable.sort_order);
    return res.json(result);
  } catch (err) {
    console.error("POST /pricing/scopes/:id/frequencies:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Add-ons (company-wide with scope_ids filter) ──────────────────────────────

router.get("/addons", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const scopeId = req.query.scope_id ? parseInt(req.query.scope_id as string) : null;
    const officeOnly = req.query.office === "true";
    const showAll = req.query.all === "true";

    let rows;
    if (scopeId) {
      if (showAll) {
        const result = await db.execute(sql`SELECT * FROM pricing_addons WHERE company_id = ${companyId} AND (scope_ids::jsonb @> ${JSON.stringify([scopeId])}::jsonb OR scope_id = ${scopeId}) ORDER BY sort_order, id`);
        rows = (result as any).rows ?? [];
      } else {
        const result = await db.execute(sql`SELECT * FROM pricing_addons WHERE company_id = ${companyId} AND is_active = true AND (scope_ids::jsonb @> ${JSON.stringify([scopeId])}::jsonb OR scope_id = ${scopeId}) ORDER BY sort_order, id`);
        rows = (result as any).rows ?? [];
      }
    } else {
      if (showAll) {
        const result = await db.execute(sql`SELECT * FROM pricing_addons WHERE company_id = ${companyId} ORDER BY sort_order, id`);
        rows = (result as any).rows ?? [];
      } else {
        const result = await db.execute(sql`SELECT * FROM pricing_addons WHERE company_id = ${companyId} AND is_active = true ORDER BY sort_order, id`);
        rows = (result as any).rows ?? [];
      }
    }

    if (officeOnly) {
      rows = rows.filter((r: any) => r.show_office);
    }

    return res.json(rows);
  } catch (err) {
    console.error("GET /pricing/addons:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Legacy: single-scope addons (backward compat for quote builder)
router.get("/scopes/:id/addons", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const scopeId = parseInt(req.params.id);
    const officeOnly = req.query.office === "true";

    const result = await db.execute(sql`
      SELECT * FROM pricing_addons
       WHERE company_id = ${companyId}
         AND is_active = true
         AND (scope_ids::jsonb @> ${JSON.stringify([scopeId])}::jsonb
              OR scope_id = ${scopeId})
       ORDER BY addon_type, sort_order, id
    `);
    let rows = (result as any).rows ?? [];
    if (officeOnly) {
      rows = rows.filter((r: any) => r.show_office);
    }
    return res.json(rows);
  } catch (err) {
    console.error("GET /pricing/scopes/:id/addons:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/addons", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const {
      name, addon_type, scope_ids, price_type, price_value,
      time_add_minutes, time_unit, is_itemized, is_taxed,
      show_office, show_online, show_portal, sort_order,
      description, icon,
    } = req.body;

    const scopeIdsArr = Array.isArray(scope_ids) ? scope_ids : [];
    const scopeIdsJson = JSON.stringify(scopeIdsArr);
    const firstScopeId = scopeIdsArr[0] ?? null;

    const result = await db.execute(sql`
      INSERT INTO pricing_addons
        (company_id, scope_id, name, addon_type, scope_ids,
         price_type, price_value, time_add_minutes, time_unit,
         is_itemized, is_taxed, show_office, show_online, show_portal,
         is_active, sort_order, description, icon)
      VALUES
        (${companyId}, ${firstScopeId}, ${name}, ${addon_type || "cleaning_extras"}, ${scopeIdsJson},
         ${price_type || "flat"}, ${price_value ?? 0}, ${time_add_minutes ?? 0}, ${time_unit || "each"},
         ${is_itemized !== false}, ${is_taxed === true}, ${show_office !== false}, ${show_online === true}, ${show_portal !== false},
         true, ${sort_order ?? 0}, ${description ?? null}, ${icon ?? null})
      RETURNING *
    `);
    const row = ((result as any).rows ?? [])[0];
    return res.status(201).json(row);
  } catch (err) {
    console.error("POST /pricing/addons:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

async function patchAddon(req: any, res: any) {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    const {
      name, addon_type, scope_ids, price_type, price_value,
      time_add_minutes, time_unit, is_itemized, is_taxed,
      show_office, show_online, show_portal, is_active, sort_order,
      description, icon, duration_minutes,
    } = req.body;

    // Build typed updates object — Drizzle accepts partial column sets
    const updates: Record<string, any> = {};
    if (name !== undefined)             updates.name = name;
    if (addon_type !== undefined)       updates.addon_type = addon_type;
    if (price_type !== undefined)       updates.price_type = price_type;
    if (price_value !== undefined)      updates.price_value = String(price_value);
    if (time_add_minutes !== undefined) updates.time_add_minutes = time_add_minutes;
    if (time_unit !== undefined)        updates.time_unit = time_unit;
    if (is_itemized !== undefined)      updates.is_itemized = is_itemized;
    if (is_taxed !== undefined)         updates.is_taxed = is_taxed;
    if (show_office !== undefined)      updates.show_office = show_office;
    if (show_online !== undefined)      updates.show_online = show_online;
    if (show_portal !== undefined)      updates.show_portal = show_portal;
    if (is_active !== undefined)        updates.is_active = is_active;
    if (sort_order !== undefined)       updates.sort_order = sort_order;
    if (description !== undefined)      updates.description = description;
    if (icon !== undefined)             updates.icon = icon;
    if (duration_minutes !== undefined) updates.duration_minutes = Number(duration_minutes);
    if (scope_ids !== undefined) {
      const arr = Array.isArray(scope_ids) ? scope_ids : [];
      updates.scope_ids = JSON.stringify(arr);
      updates.scope_id = arr[0] ?? null;
    }

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Nothing to update" });

    const [row] = await db
      .update(pricingAddonsTable)
      .set(updates)
      .where(and(eq(pricingAddonsTable.id, id), eq(pricingAddonsTable.company_id, companyId)))
      .returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json(row);
  } catch (err) {
    console.error("PATCH /pricing/addons/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

router.patch("/addons/:id", requireAuth, patchAddon);
router.put("/addons/:id", requireAuth, patchAddon);

router.delete("/addons/:id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    await db
      .update(pricingAddonsTable)
      .set({ is_active: false })
      .where(and(eq(pricingAddonsTable.id, id), eq(pricingAddonsTable.company_id, companyId)));
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /pricing/addons/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Discounts ─────────────────────────────────────────────────────────────────

router.get("/discounts", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const scopeId = req.query.scope_id ? parseInt(req.query.scope_id as string) : null;
    const officeOnly = req.query.office === "true";

    let rows;
    if (scopeId) {
      const result = await db.execute(sql`
        SELECT * FROM pricing_discounts
        WHERE company_id = ${companyId}
          AND is_active = true
          AND scope_ids::jsonb @> ${JSON.stringify([scopeId])}::jsonb
        ORDER BY id
      `);
      rows = (result as any).rows ?? [];
    } else {
      rows = await db.select().from(pricingDiscountsTable).where(eq(pricingDiscountsTable.company_id, companyId)).orderBy(pricingDiscountsTable.id);
    }

    if (officeOnly) {
      rows = rows.filter((r: any) => r.availability_office !== false);
    }

    return res.json(rows);
  } catch (err) {
    console.error("GET /pricing/discounts:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/discounts", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { code, description, discount_type, discount_value } = req.body;
    const [row] = await db.insert(pricingDiscountsTable).values({ company_id: companyId, code: (code || "").toUpperCase(), description: description || "", discount_type: discount_type || "flat", discount_value: String(discount_value) }).returning();
    return res.status(201).json(row);
  } catch (err) {
    console.error("POST /pricing/discounts:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/discounts/:id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    const { code, description, discount_type, discount_value, is_active } = req.body;
    const updates: Record<string, unknown> = {};
    if (code !== undefined) updates.code = (code || "").toUpperCase();
    if (description !== undefined) updates.description = description;
    if (discount_type !== undefined) updates.discount_type = discount_type;
    if (discount_value !== undefined) updates.discount_value = String(discount_value);
    if (is_active !== undefined) updates.is_active = is_active;
    const [row] = await db.update(pricingDiscountsTable).set(updates).where(and(eq(pricingDiscountsTable.id, id), eq(pricingDiscountsTable.company_id, companyId))).returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json(row);
  } catch (err) {
    console.error("PUT /pricing/discounts/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/discounts/:id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    await db.delete(pricingDiscountsTable).where(and(eq(pricingDiscountsTable.id, id), eq(pricingDiscountsTable.company_id, companyId)));
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /pricing/discounts/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Fee Rules ─────────────────────────────────────────────────────────────────

router.get("/fees", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const rows = await db.select().from(pricingFeeRulesTable).where(eq(pricingFeeRulesTable.company_id, companyId)).orderBy(pricingFeeRulesTable.id);
    return res.json(rows);
  } catch (err) {
    console.error("GET /pricing/fees:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/fees", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { rule_type, label, charge_percent, tech_split_percent, window_hours } = req.body;
    const [row] = await db.insert(pricingFeeRulesTable).values({ company_id: companyId, rule_type: rule_type || "custom", label, charge_percent: String(charge_percent ?? "100"), tech_split_percent: String(tech_split_percent ?? "0"), window_hours: window_hours ?? null }).returning();
    return res.status(201).json(row);
  } catch (err) {
    console.error("POST /pricing/fees:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/fees/:id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    const { rule_type, label, charge_percent, tech_split_percent, window_hours, is_active } = req.body;
    const updates: Record<string, unknown> = {};
    if (rule_type !== undefined) updates.rule_type = rule_type;
    if (label !== undefined) updates.label = label;
    if (charge_percent !== undefined) updates.charge_percent = String(charge_percent);
    if (tech_split_percent !== undefined) updates.tech_split_percent = String(tech_split_percent);
    if (window_hours !== undefined) updates.window_hours = window_hours;
    if (is_active !== undefined) updates.is_active = is_active;
    const [row] = await db.update(pricingFeeRulesTable).set(updates).where(and(eq(pricingFeeRulesTable.id, id), eq(pricingFeeRulesTable.company_id, companyId))).returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json(row);
  } catch (err) {
    console.error("PUT /pricing/fees/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/fees/:id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    await db.delete(pricingFeeRulesTable).where(and(eq(pricingFeeRulesTable.id, id), eq(pricingFeeRulesTable.company_id, companyId)));
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /pricing/fees/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Calculate ─────────────────────────────────────────────────────────────────

export function calcAddonAmount(addon: any, base_price: number, sqft: number | null): number {
  const pv = parseFloat(String(addon.price_value ?? addon.price ?? 0));
  switch (addon.price_type) {
    case "flat":       return pv;
    case "percentage": return (pv / 100) * base_price;
    case "sqft_pct":   return sqft ? (pv / 100) * sqft : 0;
    case "time_only":  return 0;
    case "manual_adj": return pv;
    // legacy
    case "percent": {
      const pob = parseFloat(String(addon.percent_of_base ?? 0));
      return (pob / 100) * base_price;
    }
    default: return pv;
  }
}

router.post("/calculate", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { scope_id, sqft, hours, frequency, addon_ids, discount_code, manual_adjustment, addon_quantities } = req.body;

    if (!scope_id) return res.status(400).json({ error: "scope_id is required" });

    const [scope] = await db.select().from(pricingScopesTable)
      .where(and(eq(pricingScopesTable.id, scope_id), eq(pricingScopesTable.company_id, companyId)));
    if (!scope) return res.status(404).json({ error: "Scope not found" });

    const method = scope.pricing_method || "sqft";

    const freqs = await db.select().from(pricingFrequenciesTable)
      .where(and(eq(pricingFrequenciesTable.scope_id, scope_id), eq(pricingFrequenciesTable.company_id, companyId)));
    const freqFactor = frequency ? freqs.find(f => f.frequency === frequency) : null;
    const scope_hourly = parseFloat(String(scope.hourly_rate));
    let hourly_rate: number;
    if (freqFactor?.rate_override != null && freqFactor.rate_override !== "") {
      hourly_rate = parseFloat(String(freqFactor.rate_override));
    } else {
      const mult = freqFactor ? parseFloat(String(freqFactor.multiplier)) : 1.0;
      hourly_rate = scope_hourly * mult;
    }

    let base_hours: number;
    let tier_id: number | null = null;
    let used_sqft: number | null = null;

    if (method === "sqft") {
      if (!sqft) return res.status(400).json({ error: "sqft is required for sqft-based scopes" });
      const tiers = await db.select().from(pricingTiersTable)
        .where(and(eq(pricingTiersTable.scope_id, scope_id), eq(pricingTiersTable.company_id, companyId)));
      const sortedTiers = [...tiers].sort((a, b) => a.min_sqft - b.min_sqft);
      const tier = sortedTiers.find(t => sqft >= t.min_sqft && sqft <= t.max_sqft)
        ?? (sqft < Number(sortedTiers[0]?.min_sqft) ? sortedTiers[0] : sortedTiers[sortedTiers.length - 1]);
      if (!tier) return res.status(422).json({ error: "No tier found for the given sqft" });
      base_hours = parseFloat(String(tier.hours));
      tier_id = tier.id;
      used_sqft = sqft;
    } else {
      if (!hours || Number(hours) <= 0) return res.status(400).json({ error: "hours is required for hourly/simplified scopes" });
      base_hours = parseFloat(String(hours));
      used_sqft = sqft ?? null;
    }

    let base_price = base_hours * hourly_rate;
    const minimum_bill = parseFloat(String(scope.minimum_bill));
    let minimum_applied = false;
    if (minimum_bill > 0 && base_price < minimum_bill) { base_price = minimum_bill; minimum_applied = true; }

    let addons_total = 0;
    let addon_minutes = 0;
    const addon_breakdown: Array<{ id: number; name: string; amount: number; price_type: string }> = [];

    if (Array.isArray(addon_ids) && addon_ids.length > 0) {
      const validIds = addon_ids.map((id: any) => parseInt(String(id))).filter(n => !isNaN(n));
      if (validIds.length > 0) {
        const result = await db.execute(sql`
          SELECT * FROM pricing_addons
           WHERE company_id = ${companyId}
             AND id = ANY(ARRAY[${sql.raw(validIds.join(','))}]::int[])
             AND is_active = true
        `);
        const addons = (result as any).rows ?? [];
        for (const addon of addons) {
          const qty = (addon_quantities && addon_quantities[String(addon.id)]) ? Math.max(1, parseInt(String(addon_quantities[String(addon.id)]))) : 1;
          addon_minutes += (parseInt(String(addon.time_add_minutes ?? 0)) || 0) * qty;
          if (addon.price_type === "time_only") continue;
          const unitAmount = calcAddonAmount(addon, base_price, used_sqft);
          const amount = unitAmount * qty;
          addons_total += amount;
          addon_breakdown.push({ id: addon.id, name: addon.name, amount: Math.round(amount * 100) / 100, price_type: addon.price_type });
        }
      }
    }
    const addon_hours = Math.round((addon_minutes / 60) * 100) / 100;
    const total_hours = Math.round((base_hours + addon_hours) * 100) / 100;

    // ── Bundle discounts (must match public/calculate logic exactly) ──────────
    let bundle_discount = 0;
    const bundle_breakdown: Array<{ name: string; discount: number }> = [];
    if (Array.isArray(addon_ids) && addon_ids.length > 0) {
      const validIdsForBundles = addon_ids.map((id: any) => parseInt(String(id))).filter(n => !isNaN(n));
      if (validIdsForBundles.length > 0) {
        const bundleResult = await db.execute(sql`
          SELECT ab.id, ab.name, ab.discount_type, ab.discount_value,
                 array_agg(abi.addon_id) as required_ids
            FROM addon_bundles ab
            JOIN addon_bundle_items abi ON abi.bundle_id = ab.id
           WHERE ab.company_id = ${companyId} AND ab.active = true
           GROUP BY ab.id, ab.name, ab.discount_type, ab.discount_value
        `);
        const bundles = (bundleResult as any).rows ?? [];
        for (const bundle of bundles) {
          const rawRequired: number[] = (bundle.required_ids ?? []).map((x: any) => parseInt(String(x))).filter((n: number) => !isNaN(n));
          const required: number[] = [...new Set(rawRequired)];
          const matched = required.filter(rid => validIdsForBundles.includes(rid));
          if (required.length > 0 && matched.length === required.length) {
            const dv = parseFloat(String(bundle.discount_value));
            let disc = 0;
            if (bundle.discount_type === "flat_per_item") {
              disc = dv * matched.length;
            } else if (bundle.discount_type === "flat" || bundle.discount_type === "flat_total") {
              disc = dv;
            } else if (bundle.discount_type === "percentage") {
              disc = (dv / 100) * base_price;
            }
            bundle_discount += disc;
            bundle_breakdown.push({ name: bundle.name, discount: Math.round(disc * 100) / 100 });
          }
        }
      }
    }
    addons_total -= bundle_discount;

    // Manual adjustment (office-entered free-form amount)
    if (manual_adjustment && manual_adjustment !== 0) {
      const adjAmt = parseFloat(String(manual_adjustment));
      if (!isNaN(adjAmt) && adjAmt !== 0) {
        addons_total += adjAmt;
        addon_breakdown.push({ id: -1, name: "Manual Adjustment", amount: Math.round(adjAmt * 100) / 100, price_type: "manual_adj" });
      }
    }

    let subtotal = base_price + addons_total;
    let discount_amount = 0;
    let final_total = subtotal;
    let discount_valid = false;

    if (discount_code) {
      const allDiscounts = await db.select().from(pricingDiscountsTable).where(eq(pricingDiscountsTable.company_id, companyId));
      const match = allDiscounts.find(d => {
        if (d.code.toUpperCase() !== discount_code.toUpperCase() || !d.is_active) return false;
        let scopes: number[] = []; try { scopes = JSON.parse((d as any).scope_ids || "[]"); } catch {}
        return scopes.length === 0 || scopes.includes(scope_id);
      });
      if (match) {
        discount_valid = true;
        if (match.discount_type === "flat") {
          discount_amount = parseFloat(String(match.discount_value));
        } else {
          discount_amount = (parseFloat(String(match.discount_value)) / 100) * subtotal;
        }
        final_total = Math.max(0, subtotal - discount_amount);
      }
    }

    return res.json({
      scope_id, pricing_method: method,
      sqft: used_sqft, hours: base_hours, frequency: frequency ?? null,
      tier_id, base_hours, addon_hours, total_hours,
      hourly_rate: Math.round(hourly_rate * 100) / 100,
      base_price: Math.round(base_price * 100) / 100,
      minimum_applied, minimum_bill: Math.round(minimum_bill * 100) / 100,
      addons_total: Math.round(addons_total * 100) / 100,
      addon_breakdown,
      bundle_discount: Math.round(bundle_discount * 100) / 100,
      bundle_breakdown,
      subtotal: Math.round(subtotal * 100) / 100,
      discount_amount: Math.round(discount_amount * 100) / 100,
      discount_valid: discount_code ? discount_valid : undefined,
      final_total: Math.round(final_total * 100) / 100,
    });
  } catch (err) {
    console.error("POST /pricing/calculate:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/pricing/offer-settings ─────────────────────────────────────────
router.get("/offer-settings", requireAuth, async (req, res) => {
  const companyId = (req as any).user?.company_id;
  const { sql: dsql } = await import("drizzle-orm");
  try {
    const result = await db.execute(dsql`SELECT * FROM offer_settings WHERE company_id = ${companyId} LIMIT 1`);
    if (!result.rows.length) {
      return res.json({ upsell_enabled: true, upsell_discount_percent: 15, rate_lock_enabled: true, rate_lock_duration_months: 24, overrun_threshold_percent: 20, overrun_jobs_trigger: 2, service_gap_days: 60, renewal_alert_days: 30 });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── PUT /api/pricing/offer-settings ─────────────────────────────────────────
router.put("/offer-settings", requireAuth, async (req, res) => {
  const companyId = (req as any).user?.company_id;
  const { sql: dsql } = await import("drizzle-orm");
  const { upsell_enabled, upsell_discount_percent, rate_lock_enabled, rate_lock_duration_months, overrun_threshold_percent, overrun_jobs_trigger, service_gap_days, renewal_alert_days } = req.body;
  try {
    await db.execute(
      dsql`
        INSERT INTO offer_settings (company_id, upsell_enabled, upsell_discount_percent, rate_lock_enabled, rate_lock_duration_months, overrun_threshold_percent, overrun_jobs_trigger, service_gap_days, renewal_alert_days, updated_at)
        VALUES (${companyId}, ${upsell_enabled}, ${upsell_discount_percent}, ${rate_lock_enabled}, ${rate_lock_duration_months}, ${overrun_threshold_percent}, ${overrun_jobs_trigger}, ${service_gap_days}, ${renewal_alert_days ?? 30}, NOW())
        ON CONFLICT (company_id) DO UPDATE SET
          upsell_enabled = EXCLUDED.upsell_enabled,
          upsell_discount_percent = EXCLUDED.upsell_discount_percent,
          rate_lock_enabled = EXCLUDED.rate_lock_enabled,
          rate_lock_duration_months = EXCLUDED.rate_lock_duration_months,
          overrun_threshold_percent = EXCLUDED.overrun_threshold_percent,
          overrun_jobs_trigger = EXCLUDED.overrun_jobs_trigger,
          service_gap_days = EXCLUDED.service_gap_days,
          renewal_alert_days = EXCLUDED.renewal_alert_days,
          updated_at = NOW()
      `
    );
    const updated = await db.execute(dsql`SELECT * FROM offer_settings WHERE company_id = ${companyId} LIMIT 1`);
    return res.json(updated.rows[0]);
  } catch (err) {
    console.error("PUT offer-settings:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Fee Rules ─────────────────────────────────────────────────────────────────

router.get("/fee-rules", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const result = await db.execute(sql`SELECT * FROM pricing_fee_rules WHERE company_id = ${companyId} ORDER BY id`);
    return res.json((result as any).rows ?? []);
  } catch (err) {
    console.error("GET /pricing/fee-rules:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/fee-rules/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    const { charge_percent, tech_comp_mode, tech_comp_value, is_active, window_hours } = req.body;
    await db.execute(sql`
      UPDATE pricing_fee_rules
         SET charge_percent  = COALESCE(${charge_percent ?? null}, charge_percent),
             tech_comp_mode  = COALESCE(${tech_comp_mode ?? null}, tech_comp_mode),
             tech_comp_value = COALESCE(${tech_comp_value != null ? String(tech_comp_value) : null}, tech_comp_value),
             is_active       = COALESCE(${is_active ?? null}, is_active),
             window_hours    = COALESCE(${window_hours ?? null}, window_hours)
       WHERE id = ${id} AND company_id = ${companyId}
    `);
    const updated = await db.execute(sql`SELECT * FROM pricing_fee_rules WHERE id = ${id} AND company_id = ${companyId}`);
    return res.json(((updated as any).rows ?? [])[0]);
  } catch (err) {
    console.error("PATCH /pricing/fee-rules/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
