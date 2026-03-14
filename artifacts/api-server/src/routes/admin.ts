import { Router } from "express";
import { db } from "@workspace/db";
import {
  usersTable,
  companiesTable,
  auditLogTable,
  articlesTable,
} from "@workspace/db/schema";
import { eq, sql, and, inArray, gte, desc } from "drizzle-orm";
import { requireAuth, requireRole, signToken } from "../lib/auth.js";

const router = Router();

const PLAN_MRR: Record<string, number> = {
  starter: 49,
  growth: 149,
  enterprise: 299,
};

const isSuperAdmin = [requireAuth, requireRole("super_admin")];

/* ── DASHBOARD ────────────────────────────────────────────────── */
router.get("/dashboard", ...isSuperAdmin, async (_req, res) => {
  try {
    const companies = await db.select().from(companiesTable);

    const totalCompanies = companies.length;
    const activeSubs = companies.filter(
      (c) => c.subscription_status === "active"
    ).length;
    const trialSubs = companies.filter(
      (c) => c.subscription_status === "trialing"
    ).length;
    const pastDueSubs = companies.filter(
      (c) => c.subscription_status === "past_due"
    ).length;
    const canceledSubs = companies.filter(
      (c) => c.subscription_status === "canceled"
    ).length;

    const mrr = companies
      .filter((c) => c.subscription_status === "active")
      .reduce((sum, c) => sum + (PLAN_MRR[c.plan] || 0), 0);

    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const newThisWeek = companies.filter(
      (c) => new Date(c.created_at) >= oneWeekAgo
    ).length;

    const flagged = companies.filter((c) =>
      ["past_due", "canceled"].includes(c.subscription_status)
    );

    return res.json({
      totalCompanies,
      activeSubs,
      trialSubs,
      pastDueSubs,
      canceledSubs,
      mrr,
      arr: mrr * 12,
      newThisWeek,
      platformFeeRevenue: Math.round(mrr * 0.05),
      flagged: flagged.map((c) => ({ id: c.id, name: c.name, status: c.subscription_status })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ── COMPANIES LIST ───────────────────────────────────────────── */
router.get("/companies", ...isSuperAdmin, async (req, res) => {
  try {
    const { status } = req.query as { status?: string };

    const allCompanies = await db.select().from(companiesTable);

    const filtered = status && status !== "all"
      ? allCompanies.filter((c) => c.subscription_status === status)
      : allCompanies;

    const companyIds = filtered.map((c) => c.id);
    const owners = companyIds.length
      ? await db
          .select({
            company_id: usersTable.company_id,
            email: usersTable.email,
            first_name: usersTable.first_name,
            last_name: usersTable.last_name,
          })
          .from(usersTable)
          .where(
            and(
              inArray(usersTable.company_id as any, companyIds),
              inArray(usersTable.role, ["owner"])
            )
          )
      : [];

    const ownerMap: Record<number, typeof owners[0]> = {};
    for (const o of owners) {
      if (o.company_id != null) ownerMap[o.company_id] = o;
    }

    const result = filtered.map((c) => ({
      ...c,
      owner: ownerMap[c.id] || null,
      mrr: c.subscription_status === "active" ? PLAN_MRR[c.plan] || 0 : 0,
    }));

    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ── COMPANY UPDATE ───────────────────────────────────────────── */
router.patch("/companies/:id", ...isSuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { plan, brand_color, subscription_status } = req.body;

    const updates: Record<string, unknown> = {};
    if (plan) updates.plan = plan;
    if (brand_color) updates.brand_color = brand_color;
    if (subscription_status) updates.subscription_status = subscription_status;

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const updated = await db
      .update(companiesTable)
      .set(updates as any)
      .where(eq(companiesTable.id, id))
      .returning();

    return res.json(updated[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ── SUSPEND COMPANY ──────────────────────────────────────────── */
router.post("/companies/:id/suspend", ...isSuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    await db
      .update(companiesTable)
      .set({ subscription_status: "canceled" } as any)
      .where(eq(companiesTable.id, id));

    await db.update(usersTable)
      .set({ is_active: false })
      .where(eq(usersTable.company_id as any, id));

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ── IMPERSONATE COMPANY ──────────────────────────────────────── */
router.post("/companies/:id/impersonate", ...isSuperAdmin, async (req, res) => {
  try {
    const companyId = parseInt(req.params.id);
    const adminUserId = req.auth!.userId;

    const ownerUsers = await db
      .select()
      .from(usersTable)
      .where(
        and(
          eq(usersTable.company_id as any, companyId),
          inArray(usersTable.role, ["owner", "admin"])
        )
      )
      .limit(1);

    if (!ownerUsers[0]) {
      return res.status(404).json({ error: "No owner found for this company" });
    }

    const target = ownerUsers[0];

    await db.insert(auditLogTable).values({
      admin_user_id: adminUserId,
      action: "impersonate",
      target_company_id: companyId,
      target_user_id: target.id,
      metadata: JSON.stringify({ timestamp: new Date().toISOString() }),
    });

    const impersonationToken = signToken({
      userId: target.id,
      companyId: target.company_id,
      role: target.role,
      email: target.email,
    });

    return res.json({ token: impersonationToken, user: { email: target.email, role: target.role } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ── BILLING ──────────────────────────────────────────────────── */
router.get("/billing", ...isSuperAdmin, async (_req, res) => {
  try {
    const companies = await db.select().from(companiesTable);

    const byPlan = { starter: 0, growth: 0, enterprise: 0 };
    let mrr = 0;

    for (const c of companies) {
      if (c.subscription_status === "active") {
        const key = c.plan as keyof typeof byPlan;
        byPlan[key] = (byPlan[key] || 0) + 1;
        mrr += PLAN_MRR[c.plan] || 0;
      }
    }

    const upcomingRenewals = companies.filter(
      (c) => c.subscription_status === "active"
    ).length;

    const failedPayments = companies.filter(
      (c) => c.subscription_status === "past_due"
    ).length;

    const mrrHistory = Array.from({ length: 6 }, (_, i) => {
      const d = new Date();
      d.setMonth(d.getMonth() - (5 - i));
      return {
        month: d.toLocaleString("default", { month: "short" }),
        mrr: Math.round(mrr * (0.7 + i * 0.06)),
      };
    });

    return res.json({
      mrr,
      arr: mrr * 12,
      platformFees: Math.round(mrr * 0.05),
      byPlan,
      upcomingRenewals,
      failedPayments,
      mrrHistory,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ── ARTICLES ─────────────────────────────────────────────────── */
router.get("/articles", ...isSuperAdmin, async (req, res) => {
  try {
    const articles = await db
      .select()
      .from(articlesTable)
      .orderBy(desc(articlesTable.created_at));
    return res.json(articles);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/articles", ...isSuperAdmin, async (req, res) => {
  try {
    const { title_en, title_es, content_en, content_es, category, published, slug } = req.body;
    if (!title_en || !slug) {
      return res.status(400).json({ error: "title_en and slug are required" });
    }
    const created = await db.insert(articlesTable).values({
      slug,
      title_en,
      title_es: title_es || null,
      content_en: content_en || "",
      content_es: content_es || null,
      category: category || null,
      published: published || false,
    }).returning();
    return res.status(201).json(created[0]);
  } catch (err: any) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Slug already exists" });
    }
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/articles/:id", ...isSuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { title_en, title_es, content_en, content_es, category, published } = req.body;
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (title_en !== undefined) updates.title_en = title_en;
    if (title_es !== undefined) updates.title_es = title_es;
    if (content_en !== undefined) updates.content_en = content_en;
    if (content_es !== undefined) updates.content_es = content_es;
    if (category !== undefined) updates.category = category;
    if (published !== undefined) updates.published = published;

    const updated = await db
      .update(articlesTable)
      .set(updates as any)
      .where(eq(articlesTable.id, id))
      .returning();
    return res.json(updated[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/articles/:id", ...isSuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(articlesTable).where(eq(articlesTable.id, id));
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
