import { db } from "@workspace/db";
import { companiesTable, usersTable, branchesTable, jobsTable, clientsTable, invoicesTable } from "@workspace/db/schema";
import { eq, sql, isNull, and, gt, count } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { seedDemoData } from "./seed-demo.js";
import phesClientsData from "./phes-clients-seed.json";

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

    // ── Phes ────────────────────────────────────────────────────────────────
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
        .set({
          name: "Phes",
          brand_color: "#5B9BD5",
          phone: "(773) 706-6000",
          email: "info@phes.io",
          address: "4800 W 95th St",
          city: "Oak Lawn",
          state: "IL",
          zip: "60453",
          business_hours: "Mon–Fri: 8:00 AM – 5:00 PM\nSat: 9:00 AM – 2:00 PM\nSun: Closed",
        })
        .where(eq(companiesTable.slug, "phes-cleaning"));
      console.log("[seed] Phes already seeded — name, brand color, and contact info ensured");

      const owner = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.email, "salmartinez@phes.io"))
        .limit(1);
      ownerId = owner[0]?.id ?? 0;
    } else {
      console.log("[seed] Seeding Phes...");

      const [company] = await db
        .insert(companiesTable)
        .values({
          name: "Phes",
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
      console.log("[seed] Phes seeded — login: salmartinez@phes.io");
    }

    // ── Branches: Oak Lawn (default) + Schaumburg ───────────────────────────
    let oakLawnBranchId: number;
    const existingBranches = await db
      .select({ id: branchesTable.id, name: branchesTable.name })
      .from(branchesTable)
      .where(eq(branchesTable.company_id, companyId));

    if (existingBranches.length === 0) {
      console.log("[seed] Creating Oak Lawn and Schaumburg branches...");
      const [oakLawn] = await db.insert(branchesTable).values({
        company_id: companyId,
        name: "Oak Lawn",
        city: "Oak Lawn",
        state: "IL",
        is_default: true,
        is_active: true,
      }).returning({ id: branchesTable.id });

      await db.insert(branchesTable).values({
        company_id: companyId,
        name: "Schaumburg",
        city: "Schaumburg",
        state: "IL",
        is_default: false,
        is_active: true,
      });

      oakLawnBranchId = oakLawn.id;
      console.log("[seed] Branches created — Oak Lawn id:", oakLawnBranchId);

      // Migrate all existing jobs / clients / invoices to Oak Lawn branch
      await db.update(jobsTable)
        .set({ branch_id: oakLawnBranchId })
        .where(and(eq(jobsTable.company_id, companyId), isNull(jobsTable.branch_id)));
      await db.update(clientsTable)
        .set({ branch_id: oakLawnBranchId })
        .where(and(eq(clientsTable.company_id, companyId), isNull(clientsTable.branch_id)));
      await db.update(invoicesTable)
        .set({ branch_id: oakLawnBranchId })
        .where(and(eq(invoicesTable.company_id, companyId), isNull(invoicesTable.branch_id)));
      console.log("[seed] Existing records migrated to Oak Lawn branch");
    } else {
      oakLawnBranchId = existingBranches.find(b => b.name === "Oak Lawn")?.id ?? existingBranches[0].id;

      // Ensure any newly created records without a branch get migrated
      await db.update(jobsTable)
        .set({ branch_id: oakLawnBranchId })
        .where(and(eq(jobsTable.company_id, companyId), isNull(jobsTable.branch_id)));
      await db.update(clientsTable)
        .set({ branch_id: oakLawnBranchId })
        .where(and(eq(clientsTable.company_id, companyId), isNull(clientsTable.branch_id)));
      await db.update(invoicesTable)
        .set({ branch_id: oakLawnBranchId })
        .where(and(eq(invoicesTable.company_id, companyId), isNull(invoicesTable.branch_id)));
      console.log("[seed] Branches already present — oak lawn id:", oakLawnBranchId);
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

    // ── Real PHES clients import ─────────────────────────────────────────────
    // If fewer than 100 real PHES clients exist, import from bundled JSON.
    // This handles fresh production Helium DB instances automatically.
    const [clientCountRow] = await db
      .select({ n: count() })
      .from(clientsTable)
      .where(and(eq(clientsTable.company_id, companyId), gt(clientsTable.id, 18)));

    const realCount = Number(clientCountRow?.n ?? 0);
    if (realCount < 100) {
      console.log(`[seed] Only ${realCount} real PHES clients found — importing ${phesClientsData.length} from bundle...`);
      const BATCH = 100;
      let inserted = 0;
      for (let i = 0; i < phesClientsData.length; i += BATCH) {
        const batch = phesClientsData.slice(i, i + BATCH).map((c: any) => ({
          id: c.id,
          company_id: companyId,
          first_name: c.first_name,
          last_name: c.last_name,
          email: c.email ?? null,
          phone: c.phone ?? null,
          address: c.address ?? null,
          city: c.city ?? null,
          state: c.state ?? null,
          zip: c.zip ?? null,
          notes: c.notes ?? null,
          company_name: c.company_name ?? null,
          is_active: c.is_active ?? true,
          frequency: c.frequency ?? null,
          service_type: c.service_type ?? null,
          base_fee: c.base_fee ?? null,
          allowed_hours: c.allowed_hours ?? null,
          home_access_notes: c.home_access_notes ?? null,
          alarm_code: c.alarm_code ?? null,
          pets: c.pets ?? null,
          loyalty_tier: c.loyalty_tier ?? null,
          client_since: c.client_since ?? null,
          scorecard_avg: c.scorecard_avg ?? null,
          branch_id: oakLawnBranchId,
        }));
        await db.insert(clientsTable).values(batch).onConflictDoNothing();
        inserted += batch.length;
      }
      // Advance the sequence past our imported IDs so future inserts don't collide
      await db.execute(sql`SELECT setval(pg_get_serial_sequence('clients', 'id'), GREATEST(nextval(pg_get_serial_sequence('clients', 'id')), 1250))`);
      console.log(`[seed] Real PHES clients imported: ${inserted}`);
    } else {
      console.log(`[seed] Real PHES clients OK (${realCount} found) — skipping import`);
    }
  } catch (err) {
    console.error("[seed] Seed error (non-fatal):", err);
  }
}
