import { Router } from "express";
import { db } from "@workspace/db";
import { clientsTable, jobsTable, usersTable, invoicesTable } from "@workspace/db/schema";
import { eq, and, or, ilike, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const { q } = req.query as { q: string };
    if (!q || q.trim().length < 2) return res.json({ clients: [], jobs: [], employees: [], invoices: [] });

    const term = `%${q.trim()}%`;
    const companyId = req.auth!.companyId!;

    const [clients, jobs, employees, invoices] = await Promise.all([
      db.select({
        id: clientsTable.id,
        first_name: clientsTable.first_name,
        last_name: clientsTable.last_name,
        email: clientsTable.email,
        phone: clientsTable.phone,
        address: clientsTable.address,
        city: clientsTable.city,
        zip: clientsTable.zip,
        zone_color: sql<string | null>`(SELECT sz.color FROM service_zones sz WHERE sz.company_id = ${clientsTable.company_id} AND sz.is_active = true AND ${clientsTable.zip} = ANY(sz.zip_codes) LIMIT 1)`,
        zone_name: sql<string | null>`(SELECT sz.name FROM service_zones sz WHERE sz.company_id = ${clientsTable.company_id} AND sz.is_active = true AND ${clientsTable.zip} = ANY(sz.zip_codes) LIMIT 1)`,
      })
        .from(clientsTable)
        .where(and(
          eq(clientsTable.company_id, companyId),
          or(
            ilike(clientsTable.first_name, term),
            ilike(clientsTable.last_name, term),
            ilike(sql`trim(coalesce(${clientsTable.first_name},'')) || ' ' || trim(coalesce(${clientsTable.last_name},''))`, term),
            ilike(clientsTable.email, term),
            ilike(clientsTable.phone, term),
            ilike(clientsTable.address, term),
          )
        ))
        .limit(5),

      db.select({
        id: jobsTable.id,
        service_type: jobsTable.service_type,
        status: jobsTable.status,
        scheduled_date: jobsTable.scheduled_date,
        base_fee: jobsTable.base_fee,
        client_name: sql<string>`concat(${clientsTable.first_name},' ',${clientsTable.last_name})`,
      })
        .from(jobsTable)
        .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
        .where(and(
          eq(jobsTable.company_id, companyId),
          or(
            ilike(sql<string>`${jobsTable.service_type}::text`, term),
            ilike(sql<string>`${jobsTable.status}::text`, term),
            ilike(sql<string>`${jobsTable.scheduled_date}::text`, term),
            ilike(sql`trim(coalesce(${clientsTable.first_name},'')) || ' ' || trim(coalesce(${clientsTable.last_name},''))`, term),
          )
        ))
        .limit(5),

      db.select({
        id: usersTable.id,
        first_name: usersTable.first_name,
        last_name: usersTable.last_name,
        email: usersTable.email,
        role: usersTable.role,
        avatar_url: usersTable.avatar_url,
      })
        .from(usersTable)
        .where(and(
          eq(usersTable.company_id, companyId),
          eq(usersTable.is_active, true),
          or(
            ilike(usersTable.first_name, term),
            ilike(usersTable.last_name, term),
            ilike(sql`trim(coalesce(${usersTable.first_name},'')) || ' ' || trim(coalesce(${usersTable.last_name},''))`, term),
            ilike(usersTable.email, term),
          )
        ))
        .limit(5),

      db.select({
        id: invoicesTable.id,
        status: invoicesTable.status,
        total: invoicesTable.total,
        created_at: invoicesTable.created_at,
        client_name: sql<string>`concat(${clientsTable.first_name},' ',${clientsTable.last_name})`,
      })
        .from(invoicesTable)
        .leftJoin(clientsTable, eq(invoicesTable.client_id, clientsTable.id))
        .where(and(
          eq(invoicesTable.company_id, companyId),
          or(
            ilike(sql`trim(coalesce(${clientsTable.first_name},'')) || ' ' || trim(coalesce(${clientsTable.last_name},''))`, term),
            ilike(sql<string>`${invoicesTable.status}::text`, term),
          )
        ))
        .limit(5),
    ]);

    return res.json({ clients, jobs, employees, invoices });
  } catch (err) {
    console.error("Search error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
