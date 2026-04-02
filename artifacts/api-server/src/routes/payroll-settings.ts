import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const rows = await db.execute(sql`SELECT * FROM payroll_settings WHERE company_id=${req.auth!.companyId}`);
    const row = (rows as any).rows?.[0] ?? null;
    return res.json({ data: row });
  } catch (err) {
    console.error("GET payroll-settings error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/", requireAuth, async (req, res) => {
  try {
    const {
      res_tech_pay_pct,
      commercial_hourly_rate,
      commercial_pay_default,
      training_pay_rate,
      minimum_job_pay_hours,
      reclean_tech_rate,
      company_pay_floor,
      unavailable_reclassification_rate,
      quality_probation_threshold_complaints,
      quality_probation_window_days,
      quality_probation_pay_rate,
      mileage_rate,
    } = req.body;

    // Upsert payroll_settings row
    await db.execute(sql`
      INSERT INTO payroll_settings (company_id, res_tech_pay_pct, commercial_hourly_rate, commercial_pay_default,
        training_pay_rate, minimum_job_pay_hours, reclean_tech_rate, company_pay_floor,
        unavailable_reclassification_rate, quality_probation_threshold_complaints,
        quality_probation_window_days, quality_probation_pay_rate, mileage_rate, updated_at)
      VALUES (
        ${req.auth!.companyId},
        ${res_tech_pay_pct ?? 35},
        ${commercial_hourly_rate ?? 20},
        ${commercial_pay_default ?? 'allowed_hours'},
        ${training_pay_rate ?? 20},
        ${minimum_job_pay_hours ?? 3},
        ${reclean_tech_rate ?? 20},
        ${company_pay_floor ?? 18},
        ${unavailable_reclassification_rate ?? 20},
        ${quality_probation_threshold_complaints ?? 2},
        ${quality_probation_window_days ?? 30},
        ${quality_probation_pay_rate ?? 20},
        ${mileage_rate ?? 0.70},
        NOW()
      )
      ON CONFLICT (company_id) DO UPDATE SET
        res_tech_pay_pct=EXCLUDED.res_tech_pay_pct,
        commercial_hourly_rate=EXCLUDED.commercial_hourly_rate,
        commercial_pay_default=EXCLUDED.commercial_pay_default,
        training_pay_rate=EXCLUDED.training_pay_rate,
        minimum_job_pay_hours=EXCLUDED.minimum_job_pay_hours,
        reclean_tech_rate=EXCLUDED.reclean_tech_rate,
        company_pay_floor=EXCLUDED.company_pay_floor,
        unavailable_reclassification_rate=EXCLUDED.unavailable_reclassification_rate,
        quality_probation_threshold_complaints=EXCLUDED.quality_probation_threshold_complaints,
        quality_probation_window_days=EXCLUDED.quality_probation_window_days,
        quality_probation_pay_rate=EXCLUDED.quality_probation_pay_rate,
        mileage_rate=EXCLUDED.mileage_rate,
        updated_at=NOW()
    `);

    const updated = await db.execute(sql`SELECT * FROM payroll_settings WHERE company_id=${req.auth!.companyId}`);
    return res.json({ data: (updated as any).rows?.[0] ?? null });
  } catch (err) {
    console.error("PATCH payroll-settings error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
