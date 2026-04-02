import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

router.patch("/:id", requireAuth, async (req, res) => {
  const companyId = req.auth!.companyId;
  const referralId = parseInt(req.params.id);
  const { status, reward_issued } = req.body;
  try {
    const result = await db.execute(sql`
      UPDATE referrals SET
        status = COALESCE(${status ?? null}, status),
        reward_issued = COALESCE(${reward_issued ?? null}, reward_issued),
        updated_at = NOW()
      WHERE id = ${referralId} AND company_id = ${companyId}
      RETURNING *
    `);
    if (result.rows.length === 0) return res.status(404).json({ error: "Referral not found" });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("PATCH referral:", err);
    return res.status(500).json({ error: "Failed to update referral" });
  }
});

export default router;
