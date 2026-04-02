import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const rows = await db.execute(sql`SELECT * FROM compliance_settings WHERE company_id=${req.auth!.companyId}`);
    const row = (rows as any).rows?.[0] ?? null;
    return res.json({ data: row });
  } catch (err) {
    console.error("GET compliance-settings error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/", requireAuth, async (req, res) => {
  try {
    const b = req.body;
    await db.execute(sql`
      INSERT INTO compliance_settings (
        company_id, minimum_wage_floor, state_minimum_wage, local_minimum_wage,
        plawa_enabled, plawa_annual_hours, pto_enabled, pto_year1_credit, pto_max_cap,
        pto_payout_on_separation, holiday_pay_enabled, holiday_pay_hours,
        mileage_reimbursement_enabled, mileage_rate, quality_probation_enabled,
        re_clean_workflow_enabled, insubordination_reclassification_enabled,
        scorecard_enabled, scorecard_floor_pct, three_hour_minimum_enabled, minimum_job_pay_hours, updated_at
      ) VALUES (
        ${req.auth!.companyId},
        ${b.minimum_wage_floor ?? 18.00}, ${b.state_minimum_wage ?? 14.00}, ${b.local_minimum_wage ?? 16.20},
        ${b.plawa_enabled ?? true}, ${b.plawa_annual_hours ?? 40},
        ${b.pto_enabled ?? true}, ${b.pto_year1_credit ?? 40}, ${b.pto_max_cap ?? 80},
        ${b.pto_payout_on_separation ?? true}, ${b.holiday_pay_enabled ?? true}, ${b.holiday_pay_hours ?? 8},
        ${b.mileage_reimbursement_enabled ?? true}, ${b.mileage_rate ?? 0.70},
        ${b.quality_probation_enabled ?? true}, ${b.re_clean_workflow_enabled ?? true},
        ${b.insubordination_reclassification_enabled ?? true},
        ${b.scorecard_enabled ?? true}, ${b.scorecard_floor_pct ?? 95.00},
        ${b.three_hour_minimum_enabled ?? true}, ${b.minimum_job_pay_hours ?? 3.00}, NOW()
      )
      ON CONFLICT (company_id) DO UPDATE SET
        minimum_wage_floor=EXCLUDED.minimum_wage_floor,
        state_minimum_wage=EXCLUDED.state_minimum_wage,
        local_minimum_wage=EXCLUDED.local_minimum_wage,
        plawa_enabled=EXCLUDED.plawa_enabled,
        plawa_annual_hours=EXCLUDED.plawa_annual_hours,
        pto_enabled=EXCLUDED.pto_enabled,
        pto_year1_credit=EXCLUDED.pto_year1_credit,
        pto_max_cap=EXCLUDED.pto_max_cap,
        pto_payout_on_separation=EXCLUDED.pto_payout_on_separation,
        holiday_pay_enabled=EXCLUDED.holiday_pay_enabled,
        holiday_pay_hours=EXCLUDED.holiday_pay_hours,
        mileage_reimbursement_enabled=EXCLUDED.mileage_reimbursement_enabled,
        mileage_rate=EXCLUDED.mileage_rate,
        quality_probation_enabled=EXCLUDED.quality_probation_enabled,
        re_clean_workflow_enabled=EXCLUDED.re_clean_workflow_enabled,
        insubordination_reclassification_enabled=EXCLUDED.insubordination_reclassification_enabled,
        scorecard_enabled=EXCLUDED.scorecard_enabled,
        scorecard_floor_pct=EXCLUDED.scorecard_floor_pct,
        three_hour_minimum_enabled=EXCLUDED.three_hour_minimum_enabled,
        minimum_job_pay_hours=EXCLUDED.minimum_job_pay_hours,
        updated_at=NOW()
    `);
    const updated = await db.execute(sql`SELECT * FROM compliance_settings WHERE company_id=${req.auth!.companyId}`);
    return res.json({ data: (updated as any).rows?.[0] ?? null });
  } catch (err) {
    console.error("PATCH compliance-settings error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
