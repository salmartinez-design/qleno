import { Router } from "express";
import { db } from "@workspace/db";
import {
  serviceZonesTable, serviceZoneEmployeesTable, waitlistTable,
  clientsTable, jobsTable, usersTable, companiesTable,
} from "@workspace/db/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

// ─── PHES company_id=1 seed zones ───────────────────────────────────────────
const PHES_SEED: { name: string; color: string; zip_codes: string[] }[] = [
  {
    name: "Southwest Zone",
    color: "#FF69B4",
    zip_codes: ["60453","60456","60458","60459","60464","60465","60480","60482","60487"],
  },
  {
    name: "Chicago South Zone",
    color: "#5B9BD5",
    zip_codes: ["60629","60632","60636","60638","60643","60652","60655"],
  },
  {
    name: "Northwest Zone",
    color: "#F97316",
    zip_codes: ["60634","60630","60631","60646","60656","60068","60714"],
  },
  {
    name: "North Shore Zone",
    color: "#2D6A4F",
    zip_codes: ["60201","60202","60203","60091","60093","60076","60077"],
  },
];

async function autoSeedPhes(companyId: number) {
  const existing = await db
    .select({ id: serviceZonesTable.id })
    .from(serviceZonesTable)
    .where(eq(serviceZonesTable.company_id, companyId));
  if (existing.length > 0) return;

  for (let i = 0; i < PHES_SEED.length; i++) {
    const s = PHES_SEED[i];
    await db.insert(serviceZonesTable).values({
      company_id: companyId,
      name: s.name,
      color: s.color,
      zip_codes: s.zip_codes,
      sort_order: i,
    });
  }
}

// ─── Helper: resolve zone_id from zip code ───────────────────────────────────
export async function resolveZoneForZip(companyId: number, zip: string | null | undefined): Promise<number | null> {
  if (!zip) return null;
  const clean = zip.trim().replace(/\D/g, "").slice(0, 5);
  if (clean.length < 5) return null;

  const zones = await db
    .select({ id: serviceZonesTable.id, zip_codes: serviceZonesTable.zip_codes })
    .from(serviceZonesTable)
    .where(and(eq(serviceZonesTable.company_id, companyId), eq(serviceZonesTable.is_active, true)));

  for (const z of zones) {
    if (z.zip_codes && z.zip_codes.includes(clean)) return z.id;
  }
  return null;
}

// ─── GET /api/zones — list zones with stats ──────────────────────────────────
router.get("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;

    // Auto-seed PHES
    if (companyId === 1) await autoSeedPhes(companyId);

    const zones = await db
      .select()
      .from(serviceZonesTable)
      .where(eq(serviceZonesTable.company_id, companyId))
      .orderBy(serviceZonesTable.sort_order);

    if (zones.length === 0) return res.json([]);

    const zoneIds = zones.map(z => z.id);

    // Employee counts per zone
    const empCounts = await db
      .select({ zone_id: serviceZoneEmployeesTable.zone_id, count: sql<number>`count(*)::int` })
      .from(serviceZoneEmployeesTable)
      .where(inArray(serviceZoneEmployeesTable.zone_id, zoneIds))
      .groupBy(serviceZoneEmployeesTable.zone_id);

    const empMap: Record<number, number> = {};
    for (const r of empCounts) empMap[r.zone_id] = r.count;

    // Jobs this month per zone
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const nextMonthStart = now.getMonth() === 11
      ? `${now.getFullYear() + 1}-01-01`
      : `${now.getFullYear()}-${String(now.getMonth() + 2).padStart(2, "0")}-01`;

    const jobCounts = await db
      .select({ zone_id: jobsTable.zone_id, count: sql<number>`count(*)::int` })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.company_id, companyId),
          inArray(jobsTable.zone_id as any, zoneIds),
          sql`${jobsTable.scheduled_date} >= ${monthStart}`,
          sql`${jobsTable.scheduled_date} < ${nextMonthStart}`,
        )
      )
      .groupBy(jobsTable.zone_id);

    const jobMap: Record<number, number> = {};
    for (const r of jobCounts) if (r.zone_id) jobMap[r.zone_id] = r.count;

    // Employee names per zone
    const empRows = await db
      .select({
        zone_id: serviceZoneEmployeesTable.zone_id,
        user_id: serviceZoneEmployeesTable.user_id,
        name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
      })
      .from(serviceZoneEmployeesTable)
      .innerJoin(usersTable, eq(usersTable.id, serviceZoneEmployeesTable.user_id))
      .where(inArray(serviceZoneEmployeesTable.zone_id, zoneIds));

    const empNamesMap: Record<number, { id: number; name: string }[]> = {};
    for (const r of empRows) {
      if (!empNamesMap[r.zone_id]) empNamesMap[r.zone_id] = [];
      empNamesMap[r.zone_id].push({ id: r.user_id, name: r.name });
    }

    const result = zones.map(z => ({
      ...z,
      employee_count: empMap[z.id] ?? 0,
      jobs_this_month: jobMap[z.id] ?? 0,
      employees: empNamesMap[z.id] ?? [],
    }));

    return res.json(result);
  } catch (err) {
    console.error("[zones GET]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── GET /api/zones/public?company_id=X — for quote form zip check ───────────
router.get("/public", async (req, res) => {
  try {
    const companyId = parseInt(req.query.company_id as string);
    if (!companyId) return res.status(400).json({ error: "company_id required" });

    const zones = await db
      .select({ id: serviceZonesTable.id, name: serviceZonesTable.name, color: serviceZonesTable.color, zip_codes: serviceZonesTable.zip_codes })
      .from(serviceZonesTable)
      .where(and(eq(serviceZonesTable.company_id, companyId), eq(serviceZonesTable.is_active, true)));

    return res.json(zones);
  } catch {
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/zones — create ─────────────────────────────────────────────────
router.post("/", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { name, color, zip_codes, employee_ids, sort_order } = req.body;

    if (!name) return res.status(400).json({ error: "name required" });

    const [zone] = await db.insert(serviceZonesTable).values({
      company_id: companyId,
      name,
      color: color ?? "#5B9BD5",
      zip_codes: Array.isArray(zip_codes) ? zip_codes : [],
      sort_order: sort_order ?? 0,
    }).returning();

    // Assign employees
    if (Array.isArray(employee_ids) && employee_ids.length > 0) {
      await db.insert(serviceZoneEmployeesTable).values(
        employee_ids.map((uid: number) => ({ zone_id: zone.id, user_id: uid, company_id: companyId }))
      );
    }

    return res.status(201).json(zone);
  } catch (err) {
    console.error("[zones POST]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── PATCH /api/zones/:id — update ───────────────────────────────────────────
router.patch("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    const { name, color, zip_codes, employee_ids, is_active, sort_order } = req.body;

    const existing = await db.select().from(serviceZonesTable).where(
      and(eq(serviceZonesTable.id, id), eq(serviceZonesTable.company_id, companyId))
    );
    if (!existing.length) return res.status(404).json({ error: "Not found" });

    const patch: Record<string, any> = {};
    if (name !== undefined) patch.name = name;
    if (color !== undefined) patch.color = color;
    if (zip_codes !== undefined) patch.zip_codes = zip_codes;
    if (is_active !== undefined) patch.is_active = is_active;
    if (sort_order !== undefined) patch.sort_order = sort_order;

    if (Object.keys(patch).length > 0) {
      await db.update(serviceZonesTable).set(patch).where(
        and(eq(serviceZonesTable.id, id), eq(serviceZonesTable.company_id, companyId))
      );
    }

    // Re-sync employees if provided
    if (Array.isArray(employee_ids)) {
      await db.delete(serviceZoneEmployeesTable).where(eq(serviceZoneEmployeesTable.zone_id, id));
      if (employee_ids.length > 0) {
        await db.insert(serviceZoneEmployeesTable).values(
          employee_ids.map((uid: number) => ({ zone_id: id, user_id: uid, company_id: companyId }))
        );
      }
    }

    const [updated] = await db.select().from(serviceZonesTable).where(eq(serviceZonesTable.id, id));
    return res.json(updated);
  } catch (err) {
    console.error("[zones PATCH]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── DELETE /api/zones/:id ────────────────────────────────────────────────────
router.delete("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);

    const existing = await db.select().from(serviceZonesTable).where(
      and(eq(serviceZonesTable.id, id), eq(serviceZonesTable.company_id, companyId))
    );
    if (!existing.length) return res.status(404).json({ error: "Not found" });

    await db.delete(serviceZoneEmployeesTable).where(eq(serviceZoneEmployeesTable.zone_id, id));
    await db.delete(serviceZonesTable).where(eq(serviceZonesTable.id, id));

    return res.json({ success: true });
  } catch (err) {
    console.error("[zones DELETE]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── GET /api/zones/stats — performance table ────────────────────────────────
router.get("/stats", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;

    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const nextMonthStart = now.getMonth() === 11
      ? `${now.getFullYear() + 1}-01-01`
      : `${now.getFullYear()}-${String(now.getMonth() + 2).padStart(2, "0")}-01`;

    const zones = await db
      .select()
      .from(serviceZonesTable)
      .where(and(eq(serviceZonesTable.company_id, companyId), eq(serviceZonesTable.is_active, true)))
      .orderBy(serviceZonesTable.sort_order);

    if (!zones.length) return res.json([]);

    const zoneIds = zones.map(z => z.id);

    const stats = await db
      .select({
        zone_id: jobsTable.zone_id,
        job_count: sql<number>`count(*)::int`,
        revenue: sql<number>`sum(${jobsTable.base_fee})::numeric`,
      })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.company_id, companyId),
          inArray(jobsTable.zone_id as any, zoneIds),
          sql`${jobsTable.scheduled_date} >= ${monthStart}`,
          sql`${jobsTable.scheduled_date} < ${nextMonthStart}`,
        )
      )
      .groupBy(jobsTable.zone_id);

    const statsMap: Record<number, { job_count: number; revenue: number }> = {};
    for (const s of stats) if (s.zone_id) statsMap[s.zone_id] = { job_count: s.job_count, revenue: Number(s.revenue) };

    return res.json(
      zones.map(z => ({
        ...z,
        job_count: statsMap[z.id]?.job_count ?? 0,
        revenue: statsMap[z.id]?.revenue ?? 0,
        avg_bill: statsMap[z.id]?.job_count
          ? (statsMap[z.id].revenue / statsMap[z.id].job_count)
          : 0,
      }))
    );
  } catch (err) {
    console.error("[zones/stats GET]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/zones/waitlist — out-of-zone email capture ────────────────────
router.post("/waitlist", async (req, res) => {
  try {
    const { company_id, email, zip_code } = req.body;
    if (!company_id || !email || !zip_code) {
      return res.status(400).json({ error: "company_id, email, and zip_code required" });
    }

    await db.insert(waitlistTable).values({ company_id, email, zip_code });
    return res.status(201).json({ success: true });
  } catch (err) {
    console.error("[zones/waitlist POST]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── GET /api/zones/employee-zones — get zone assignments for all employees ──
router.get("/employee-zones", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;

    const rows = await db
      .select({
        user_id: serviceZoneEmployeesTable.user_id,
        zone_id: serviceZoneEmployeesTable.zone_id,
        zone_name: serviceZonesTable.name,
        zone_color: serviceZonesTable.color,
      })
      .from(serviceZoneEmployeesTable)
      .innerJoin(serviceZonesTable, eq(serviceZonesTable.id, serviceZoneEmployeesTable.zone_id))
      .where(eq(serviceZoneEmployeesTable.company_id, companyId));

    // Build map: user_id → primary zone (first found)
    const map: Record<number, { zone_id: number; zone_name: string; zone_color: string }> = {};
    for (const r of rows) {
      if (!map[r.user_id]) {
        map[r.user_id] = { zone_id: r.zone_id, zone_name: r.zone_name, zone_color: r.zone_color };
      }
    }

    return res.json(map);
  } catch (err) {
    console.error("[zones/employee-zones GET]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── PUT /api/zones/user-zone — assign employee to a zone (replaces all) ─────
router.put("/user-zone", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { user_id, zone_id } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id required" });

    // Remove from all zones first
    await db.delete(serviceZoneEmployeesTable)
      .where(and(eq(serviceZoneEmployeesTable.user_id, user_id), eq(serviceZoneEmployeesTable.company_id, companyId)));

    // If zone_id provided, add to that zone
    if (zone_id) {
      await db.insert(serviceZoneEmployeesTable)
        .values({ zone_id, user_id, company_id: companyId })
        .onConflictDoNothing();
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("[zones/user-zone PUT]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
