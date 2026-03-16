import { db } from "@workspace/db";
import { companiesTable, usersTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { seedDemoData } from "./seed-demo.js";

const SUPER_ADMINS = [
  { email: "sal@cleanopspro.com",   password: "SalCleanOps2026!",   first_name: "Sal",   last_name: "CleanOps" },
  { email: "admin@cleanopspro.com", password: "AdminCleanOps2026!", first_name: "Admin", last_name: "CleanOps" },
];

export async function seedIfNeeded() {
  try {
    const tableCheck = await db.execute(
      sql`SELECT to_regclass('public.companies') as exists`
    );
    const tableExists = (tableCheck.rows[0] as any)?.exists;
    if (!tableExists) {
      console.log("[seed] Tables not yet created — skipping seed (run db:push first)");
      return;
    }

    // ── Super admin accounts ────────────────────────────────────────────────
    for (const sa of SUPER_ADMINS) {
      const hash = await bcrypt.hash(sa.password, 12);
      const existing = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.email, sa.email))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(usersTable).values({
          company_id: null as any,
          email: sa.email,
          password_hash: hash,
          role: "super_admin",
          first_name: sa.first_name,
          last_name: sa.last_name,
          is_active: true,
        });
        console.log(`[seed] Super admin created: ${sa.email}`);
      } else {
        await db
          .update(usersTable)
          .set({ password_hash: hash, is_active: true })
          .where(eq(usersTable.email, sa.email));
        console.log(`[seed] Super admin ensured: ${sa.email}`);
      }
    }

    // ── PHES Cleaning LLC ───────────────────────────────────────────────────
    const existingCompany = await db
      .select({ id: companiesTable.id })
      .from(companiesTable)
      .where(eq(companiesTable.slug, "phes-cleaning"))
      .limit(1);

    let companyId: number;
    let ownerId: number;

    if (existingCompany.length > 0) {
      companyId = existingCompany[0].id;
      await db
        .update(companiesTable)
        .set({ brand_color: "#5B9BD5" })
        .where(eq(companiesTable.slug, "phes-cleaning"));
      console.log("[seed] PHES Cleaning already seeded — brand color ensured");

      const owner = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.email, "salmartinez@phes.io"))
        .limit(1);
      ownerId = owner[0]?.id ?? 0;
    } else {
      console.log("[seed] Seeding PHES Cleaning LLC...");

      const [company] = await db
        .insert(companiesTable)
        .values({
          name: "PHES Cleaning LLC",
          slug: "phes-cleaning",
          brand_color: "#5B9BD5",
          subscription_status: "active",
          plan: "growth",
          employee_count: 0,
          pay_cadence: "biweekly",
          geo_fence_threshold_ft: 500,
          sms_on_my_way_enabled: true,
          sms_arrived_enabled: false,
          sms_paused_enabled: false,
          sms_complete_enabled: true,
        })
        .returning({ id: companiesTable.id });

      companyId = company.id;

      const ownerHash = await bcrypt.hash("Avaseb2024$", 12);
      const [ownerRow] = await db.insert(usersTable).values({
        company_id: companyId,
        email: "salmartinez@phes.io",
        password_hash: ownerHash,
        role: "owner",
        first_name: "Sal",
        last_name: "Martinez",
        is_active: true,
      }).returning({ id: usersTable.id });

      ownerId = ownerRow.id;
      console.log("[seed] PHES Cleaning seeded — login: salmartinez@phes.io");
    }

    // ── Demo data (employees, clients, jobs, invoices) ──────────────────────
    // Idempotent: checks for Linda Torres as a sentinel before running
    const demoCheck = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, "linda.torres@phes.io"))
      .limit(1);

    if (demoCheck.length === 0) {
      console.log("[seed] Demo data missing — seeding employees, clients, jobs...");
      await seedDemoData(companyId, ownerId);
    } else {
      console.log("[seed] Demo data already present — skipping");
    }
  } catch (err) {
    console.error("[seed] Seed error (non-fatal):", err);
  }
}
