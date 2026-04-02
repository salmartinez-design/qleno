import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

// GET /api/subscription/tiers — list all subscription tiers
router.get("/tiers", async (_req, res) => {
  try {
    const rows = await db.execute(sql`SELECT * FROM subscription_tiers ORDER BY sort_order`);
    return res.json({ data: (rows as any).rows ?? [] });
  } catch (err) {
    console.error("GET tiers error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /api/subscription/me — current company subscription + seat counts
router.get("/me", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;

    const compRows = await db.execute(sql`
      SELECT c.id, c.name, c.tier_id, c.subscription_status, c.trial_ends_at,
             c.stripe_subscription_id, c.stripe_customer_id, c.early_tenant,
             t.name AS tier_name, t.slug AS tier_slug, t.price_monthly,
             t.office_staff_included, t.technicians_included,
             t.office_staff_overage_per_user, t.technician_overage_per_user,
             t.features
      FROM companies c
      LEFT JOIN subscription_tiers t ON t.id=c.tier_id
      WHERE c.id=${companyId}
    `);
    const company = (compRows as any).rows?.[0];
    if (!company) return res.status(404).json({ error: "Not found" });

    // Count active technicians using is_active field
    const techRows = await db.execute(sql`
      SELECT COUNT(*)::int AS count FROM users
      WHERE company_id=${companyId} AND role='technician' AND is_active=true
    `);
    const activeTechs = (techRows as any).rows?.[0]?.count ?? 0;

    // Count active office staff
    const officeRows = await db.execute(sql`
      SELECT COUNT(*)::int AS count FROM users
      WHERE company_id=${companyId} AND role IN ('office','admin') AND is_active=true
    `);
    const activeOffice = (officeRows as any).rows?.[0]?.count ?? 0;

    // Calculate overages
    const techIncluded = company.technicians_included ?? 0;
    const officeIncluded = company.office_staff_included ?? 0;
    const techOverageRate = parseFloat(company.technician_overage_per_user ?? 0);
    const officeOverageRate = parseFloat(company.office_staff_overage_per_user ?? 0);

    const techOverage = Math.max(0, activeTechs - techIncluded) * techOverageRate;
    const officeOverage = Math.max(0, activeOffice - officeIncluded) * officeOverageRate;
    const totalOverage = techOverage + officeOverage;
    const projectedMonthly = parseFloat(company.price_monthly ?? 0) + totalOverage;

    // Upgrade banner logic for Team tier at 12+ techs
    const showUpgradeBanner = company.tier_slug === 'team' && activeTechs >= 12;
    const upgradeBannerDismissible = activeTechs < 14;

    return res.json({
      data: {
        ...company,
        active_techs: activeTechs,
        active_office_staff: activeOffice,
        tech_overage_amount: techOverage,
        office_overage_amount: officeOverage,
        total_overage_amount: totalOverage,
        projected_monthly_total: projectedMonthly,
        show_upgrade_banner: showUpgradeBanner,
        upgrade_banner_dismissible: upgradeBannerDismissible,
      }
    });
  } catch (err) {
    console.error("GET subscription/me error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /api/subscription/feature-gates — feature gates for current company
router.get("/feature-gates", requireAuth, async (req, res) => {
  try {
    const rows = await db.execute(sql`SELECT * FROM feature_gates WHERE company_id=${req.auth!.companyId}`);
    const row = (rows as any).rows?.[0];
    if (!row) {
      return res.json({ data: { all: true } });
    }
    return res.json({ data: row });
  } catch (err) {
    console.error("GET feature-gates error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
