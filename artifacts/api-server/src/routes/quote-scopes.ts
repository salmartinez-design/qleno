import { Router } from "express";
import { db } from "@workspace/db";
import { quoteScopesTable, quoteScopeFrequenciesTable, quoteSqftTableEntry, quoteAddonsTable } from "@workspace/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

const PHES_SCOPES = [
  { name: "Deep Clean or Move In/Out", category: "house_cleaning", pricing_method: "sqft", base_hourly_rate: "70", min_bill_rate: "210", available_office: true, available_online: true },
  { name: "One-Time Flat-Rate Standard Cleaning", category: "house_cleaning", pricing_method: "sqft", base_hourly_rate: "65", min_bill_rate: "180", available_office: true, available_online: true },
  { name: "Recurring Cleaning", category: "house_cleaning", pricing_method: "sqft", base_hourly_rate: "65", min_bill_rate: "180", available_office: true, available_online: true },
  { name: "Hourly Deep Clean", category: "house_cleaning", pricing_method: "hourly", base_hourly_rate: "70", min_bill_rate: "210", available_office: true, available_online: false },
  { name: "Hourly Standard Cleaning", category: "house_cleaning", pricing_method: "hourly", base_hourly_rate: "65", min_bill_rate: "180", available_office: true, available_online: false },
];

const DEEP_CLEAN_SQFT: [number, number | null, string][] = [
  [0, 749, "3"], [750, 999, "3.2"], [1000, 1249, "5.2"], [1250, 1499, "6"],
  [1500, 1749, "6.2"], [1750, 1999, "6.5"], [2000, 2249, "7.6"], [2250, 2499, "8"],
  [2500, 2749, "8"], [2750, 2999, "8.4"], [3000, 3249, "9.5"], [3250, 3499, "10"],
  [3500, 3749, "10.5"], [3750, 3999, "11"], [4000, 4249, "13"], [4250, 4499, "14"],
  [4500, 4749, "16"], [4750, 5000, "18"], [5001, 5500, "20"], [5501, null, "29"],
];

const STANDARD_SQFT: [number, number | null, string][] = [
  [0, 749, "2"], [750, 999, "2.5"], [1000, 1249, "3"], [1250, 1499, "3.5"],
  [1500, 1749, "4"], [1750, 1999, "4.5"], [2000, 2249, "5"], [2250, 2499, "5.5"],
  [2500, 2749, "6"], [2750, 2999, "6.5"], [3000, 3249, "7"], [3250, 3499, "7.5"],
  [3500, 3749, "8"], [3750, 3999, "8.5"], [4000, 4249, "9.5"], [4250, 4499, "10.5"],
  [4500, 4749, "12"], [4750, 5000, "13"], [5001, 5500, "15"], [5501, null, "20"],
];

const DEFAULT_FREQUENCIES = [
  { frequency: "Every Week", factor: "0.85", min_cost: null, sort_order: 0 },
  { frequency: "Every Two Weeks", factor: "1.00", min_cost: null, sort_order: 1 },
  { frequency: "Every Three Weeks", factor: "1.05", min_cost: null, sort_order: 2 },
  { frequency: "Every Four Weeks", factor: "1.10", min_cost: null, sort_order: 3 },
  { frequency: "One Time", factor: "1.20", min_cost: null, sort_order: 4 },
  { frequency: "On Demand", factor: "1.20", min_cost: null, sort_order: 5 },
];

const PHES_ADDONS = [
  { name: "Oven", addon_type: "cleaning_extra", price_type: "flat", price_value: "50", time_minutes: 45, tech_pay: true, available_office: true },
  { name: "Refrigerator", addon_type: "cleaning_extra", price_type: "flat", price_value: "50", time_minutes: 45, tech_pay: true, available_office: true },
  { name: "Interior Windows", addon_type: "cleaning_extra", price_type: "flat", price_value: "75", time_minutes: 45, tech_pay: true, available_office: true },
  { name: "Basement", addon_type: "cleaning_extra", price_type: "flat", price_value: "75", time_minutes: 45, tech_pay: true, available_office: true },
  { name: "Baseboards", addon_type: "cleaning_extra", price_type: "flat", price_value: "50", time_minutes: 45, tech_pay: true, available_office: true },
  { name: "Kitchen Cabinets", addon_type: "cleaning_extra", price_type: "flat", price_value: "50", time_minutes: 45, tech_pay: true, available_office: true },
  { name: "Parking Fee", addon_type: "other", price_type: "flat", price_value: "20", time_minutes: 0, tech_pay: false, available_office: true },
];

async function getScopeWithRelations(scopeId: number, companyId: number) {
  const [scope] = await db.select().from(quoteScopesTable)
    .where(and(eq(quoteScopesTable.id, scopeId), eq(quoteScopesTable.company_id, companyId)))
    .limit(1);
  if (!scope) return null;

  const frequencies = await db.select().from(quoteScopeFrequenciesTable)
    .where(eq(quoteScopeFrequenciesTable.scope_id, scopeId))
    .orderBy(asc(quoteScopeFrequenciesTable.sort_order));

  const sqftTable = await db.select().from(quoteSqftTableEntry)
    .where(eq(quoteSqftTableEntry.scope_id, scopeId))
    .orderBy(asc(quoteSqftTableEntry.sqft_min));

  const addons = await db.select().from(quoteAddonsTable)
    .where(and(eq(quoteAddonsTable.scope_id, scopeId), eq(quoteAddonsTable.company_id, companyId)))
    .orderBy(asc(quoteAddonsTable.sort_order));

  return { ...scope, frequencies, sqft_table: sqftTable, addons };
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const scopes = await db.select().from(quoteScopesTable)
      .where(eq(quoteScopesTable.company_id, req.auth!.companyId))
      .orderBy(asc(quoteScopesTable.sort_order), asc(quoteScopesTable.id));

    const withRelations = await Promise.all(
      scopes.map(s => getScopeWithRelations(s.id, req.auth!.companyId))
    );

    return res.json(withRelations.filter(Boolean));
  } catch (err) {
    console.error("List quote scopes error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/seed-defaults", requireAuth, async (req, res) => {
  try {
    const existing = await db.select({ id: quoteScopesTable.id })
      .from(quoteScopesTable)
      .where(eq(quoteScopesTable.company_id, req.auth!.companyId));

    if (existing.length > 0) {
      return res.json({ message: "Already seeded", count: existing.length });
    }

    for (let i = 0; i < PHES_SCOPES.length; i++) {
      const scopeData = PHES_SCOPES[i];
      const [scope] = await db.insert(quoteScopesTable).values({
        ...scopeData,
        base_hourly_rate: scopeData.base_hourly_rate,
        min_bill_rate: scopeData.min_bill_rate,
        company_id: req.auth!.companyId,
        sort_order: i,
      }).returning();

      await db.insert(quoteScopeFrequenciesTable).values(
        DEFAULT_FREQUENCIES.map(f => ({ ...f, scope_id: scope.id }))
      );

      if (scopeData.pricing_method === "sqft") {
        const sqftData = (i === 0 || i === 3) ? DEEP_CLEAN_SQFT : STANDARD_SQFT;
        await db.insert(quoteSqftTableEntry).values(
          sqftData.map(([min, max, hrs]) => ({ scope_id: scope.id, sqft_min: min, sqft_max: max, estimated_hours: hrs }))
        );
      }

      await db.insert(quoteAddonsTable).values(
        PHES_ADDONS.map((a, j) => ({ ...a, company_id: req.auth!.companyId, scope_id: scope.id, sort_order: j }))
      );
    }

    return res.json({ message: "PHES defaults seeded", count: PHES_SCOPES.length });
  } catch (err) {
    console.error("Seed defaults error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const scope = await getScopeWithRelations(parseInt(req.params.id), req.auth!.companyId);
    if (!scope) return res.status(404).json({ error: "Not Found" });
    return res.json(scope);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const { name, category, pricing_method, base_hourly_rate, min_bill_rate, available_office, available_online } = req.body;
    const [scope] = await db.insert(quoteScopesTable).values({
      company_id: req.auth!.companyId,
      name, category: category || "house_cleaning",
      pricing_method: pricing_method || "sqft",
      base_hourly_rate: String(base_hourly_rate || 65),
      min_bill_rate: String(min_bill_rate || 180),
      available_office: available_office ?? true,
      available_online: available_online ?? false,
    }).returning();

    await db.insert(quoteScopeFrequenciesTable).values(
      DEFAULT_FREQUENCIES.map(f => ({ ...f, scope_id: scope.id }))
    );

    if (scope.pricing_method === "sqft") {
      await db.insert(quoteSqftTableEntry).values(
        STANDARD_SQFT.map(([min, max, hrs]) => ({ scope_id: scope.id, sqft_min: min, sqft_max: max, estimated_hours: hrs }))
      );
    }

    return res.status(201).json(await getScopeWithRelations(scope.id, req.auth!.companyId));
  } catch (err) {
    console.error("Create scope error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, category, pricing_method, base_hourly_rate, min_bill_rate, available_office, available_online, is_active } = req.body;
    await db.update(quoteScopesTable).set({
      ...(name !== undefined && { name }),
      ...(category !== undefined && { category }),
      ...(pricing_method !== undefined && { pricing_method }),
      ...(base_hourly_rate !== undefined && { base_hourly_rate: String(base_hourly_rate) }),
      ...(min_bill_rate !== undefined && { min_bill_rate: String(min_bill_rate) }),
      ...(available_office !== undefined && { available_office }),
      ...(available_online !== undefined && { available_online }),
      ...(is_active !== undefined && { is_active }),
      updated_at: new Date(),
    }).where(and(eq(quoteScopesTable.id, id), eq(quoteScopesTable.company_id, req.auth!.companyId)));

    return res.json(await getScopeWithRelations(id, req.auth!.companyId));
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(quoteScopesTable)
      .where(and(eq(quoteScopesTable.id, id), eq(quoteScopesTable.company_id, req.auth!.companyId)));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/:id/frequencies/:freqId", requireAuth, async (req, res) => {
  try {
    const { factor, min_cost, hourly_rate_override, available_office, available_online } = req.body;
    await db.update(quoteScopeFrequenciesTable).set({
      ...(factor !== undefined && { factor: String(factor) }),
      ...(min_cost !== undefined && { min_cost: min_cost ? String(min_cost) : null }),
      ...(hourly_rate_override !== undefined && { hourly_rate_override: hourly_rate_override ? String(hourly_rate_override) : null }),
      ...(available_office !== undefined && { available_office }),
      ...(available_online !== undefined && { available_online }),
    }).where(eq(quoteScopeFrequenciesTable.id, parseInt(req.params.freqId)));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/:id/sqft", requireAuth, async (req, res) => {
  try {
    const scopeId = parseInt(req.params.id);
    const { entries } = req.body;
    await db.delete(quoteSqftTableEntry).where(eq(quoteSqftTableEntry.scope_id, scopeId));
    if (entries?.length) {
      await db.insert(quoteSqftTableEntry).values(
        entries.map((e: any) => ({ scope_id: scopeId, sqft_min: e.sqft_min, sqft_max: e.sqft_max || null, estimated_hours: String(e.estimated_hours) }))
      );
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/addons", requireAuth, async (req, res) => {
  try {
    const scopeId = parseInt(req.params.id);
    const { name, addon_type, price_type, price_value, time_minutes, tech_pay, available_office, available_portal } = req.body;
    const [addon] = await db.insert(quoteAddonsTable).values({
      company_id: req.auth!.companyId,
      scope_id: scopeId,
      name, addon_type: addon_type || "cleaning_extra",
      price_type: price_type || "flat",
      price_value: String(price_value || 0),
      time_minutes: time_minutes || 0,
      tech_pay: tech_pay ?? true,
      available_office: available_office ?? true,
      available_portal: available_portal ?? false,
    }).returning();
    return res.status(201).json(addon);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/:id/addons/:addonId", requireAuth, async (req, res) => {
  try {
    const { name, addon_type, price_type, price_value, time_minutes, tech_pay, available_office, available_portal, is_active } = req.body;
    await db.update(quoteAddonsTable).set({
      ...(name !== undefined && { name }),
      ...(addon_type !== undefined && { addon_type }),
      ...(price_type !== undefined && { price_type }),
      ...(price_value !== undefined && { price_value: String(price_value) }),
      ...(time_minutes !== undefined && { time_minutes }),
      ...(tech_pay !== undefined && { tech_pay }),
      ...(available_office !== undefined && { available_office }),
      ...(available_portal !== undefined && { available_portal }),
      ...(is_active !== undefined && { is_active }),
    }).where(eq(quoteAddonsTable.id, parseInt(req.params.addonId)));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/:id/addons/:addonId", requireAuth, async (req, res) => {
  try {
    await db.delete(quoteAddonsTable).where(eq(quoteAddonsTable.id, parseInt(req.params.addonId)));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
