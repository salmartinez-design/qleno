import { db } from "@workspace/db";
import { companiesTable, usersTable, branchesTable, jobsTable, clientsTable, invoicesTable, scorecardsTable, timeclockTable, contactTicketsTable, mileageRequestsTable, accountsTable } from "@workspace/db/schema";
import { eq, sql, isNull, and, gt, count, inArray, or } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { seedDemoData } from "./seed-demo.js";
import phesClientsData from "./phes-clients-seed.json";
import phesEmployeesData from "./phes-employees-seed.json";

const DEMO_EMPLOYEE_EMAILS = [
  "maria.gonzalez@phes.io", "james.okafor@phes.io", "sofia.reyes@phes.io",
  "darius.williams@phes.io", "anika.patel@phes.io", "carlos.mendoza@phes.io",
  "tanya.brooks@phes.io", "kevin.osei@phes.io", "rachel.kim@phes.io",
  "linda.torres@phes.io",
  "admin@phescleaning.com", "jessica@phescleaning.com",
  "carlos@phescleaning.com", "amber@phescleaning.com",
];

async function cleanupDemoData(companyId: number) {
  // Identify demo employees by known seed emails
  const demoEmps = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(eq(usersTable.company_id, companyId), inArray(usersTable.email, DEMO_EMPLOYEE_EMAILS)));
  const demoEmpIds = demoEmps.map(e => e.id);

  // Identify demo clients by 555 phone numbers (all seeded demo clients use these)
  const demoClients = await db.select({ id: clientsTable.id }).from(clientsTable)
    .where(and(eq(clientsTable.company_id, companyId), sql`phone LIKE '%(555)%'`));
  const demoClientIds = demoClients.map(c => c.id);

  let d = { emps: 0, clients: 0, jobs: 0, inv: 0, sc: 0, tc: 0, ct: 0 };

  // Delete jobs referencing demo clients or assigned to demo employees
  if (demoClientIds.length > 0 || demoEmpIds.length > 0) {
    const jobConds: any[] = [];
    if (demoClientIds.length > 0) jobConds.push(inArray(jobsTable.client_id, demoClientIds));
    if (demoEmpIds.length > 0)    jobConds.push(inArray(jobsTable.assigned_user_id, demoEmpIds));
    const demoJobs = await db.select({ id: jobsTable.id }).from(jobsTable)
      .where(and(eq(jobsTable.company_id, companyId), or(...jobConds)));
    const demoJobIds = demoJobs.map(j => j.id);
    if (demoJobIds.length > 0) {
      const jids = demoJobIds.join(',');
      // Each statement runs individually so a missing table in one env doesn't abort the rest.
      // Nullable FKs — NULL them out first so NOT NULL FKs can be deleted safely.
      const jobCascadeStmts = [
        `UPDATE contact_tickets     SET job_id = NULL              WHERE job_id IN (${jids})`,
        `UPDATE form_submissions    SET job_id = NULL              WHERE job_id IN (${jids})`,
        `UPDATE quotes              SET booked_job_id = NULL       WHERE booked_job_id IN (${jids})`,
        `UPDATE communication_log   SET job_id = NULL              WHERE job_id IN (${jids})`,
        `UPDATE mileage_requests    SET from_job_id = NULL         WHERE from_job_id IN (${jids})`,
        `UPDATE mileage_requests    SET to_job_id = NULL           WHERE to_job_id IN (${jids})`,
        `UPDATE additional_pay      SET job_id = NULL              WHERE job_id IN (${jids})`,
        `UPDATE cancellation_log    SET rescheduled_to_job_id = NULL WHERE rescheduled_to_job_id IN (${jids})`,
        `DELETE FROM job_photos          WHERE job_id IN (${jids})`,
        `DELETE FROM scorecards          WHERE job_id IN (${jids})`,
        `DELETE FROM job_status_logs     WHERE job_id IN (${jids})`,
        `DELETE FROM timeclock           WHERE job_id IN (${jids})`,
        `DELETE FROM cancellation_log    WHERE job_id IN (${jids})`,
        `DELETE FROM job_add_ons         WHERE job_id IN (${jids})`,
        `DELETE FROM job_supplies        WHERE job_id IN (${jids})`,
        `DELETE FROM satisfaction_surveys WHERE job_id IN (${jids})`,
        `DELETE FROM client_ratings      WHERE job_id IN (${jids})`,
        `DELETE FROM invoices            WHERE job_id IN (${jids})`,
      ];
      for (const stmt of jobCascadeStmts) {
        try { await db.execute(sql.raw(stmt)); } catch { /* table may not exist in all envs */ }
      }
      const rj = await db.delete(jobsTable).where(inArray(jobsTable.id, demoJobIds)).returning({ id: jobsTable.id });
      d.jobs += rj.length;
    }
  }
  // Delete any remaining invoices for demo clients
  if (demoClientIds.length > 0) {
    const ri = await db.delete(invoicesTable)
      .where(and(eq(invoicesTable.company_id, companyId), inArray(invoicesTable.client_id, demoClientIds))).returning({ id: invoicesTable.id });
    d.inv += ri.length;
  }
  // Delete scorecards
  if (demoEmpIds.length > 0) {
    const rs = await db.delete(scorecardsTable).where(and(eq(scorecardsTable.company_id, companyId), inArray(scorecardsTable.user_id, demoEmpIds))).returning({ id: scorecardsTable.id });
    d.sc += rs.length;
  }
  if (demoClientIds.length > 0) {
    const rs = await db.delete(scorecardsTable).where(and(eq(scorecardsTable.company_id, companyId), inArray(scorecardsTable.client_id, demoClientIds))).returning({ id: scorecardsTable.id });
    d.sc += rs.length;
  }
  // Delete timeclock entries for demo employees
  if (demoEmpIds.length > 0) {
    const rt = await db.delete(timeclockTable).where(inArray(timeclockTable.user_id, demoEmpIds)).returning({ id: timeclockTable.id });
    d.tc += rt.length;
  }
  // Delete contact tickets for demo clients
  if (demoClientIds.length > 0) {
    const rc = await db.delete(contactTicketsTable).where(inArray(contactTicketsTable.client_id, demoClientIds)).returning({ id: contactTicketsTable.id });
    d.ct += rc.length;
  }
  // Delete demo clients
  if (demoClientIds.length > 0) {
    const rc = await db.delete(clientsTable).where(inArray(clientsTable.id, demoClientIds)).returning({ id: clientsTable.id });
    d.clients += rc.length;
  }

  // Cascade-delete all FK dependencies for demo employees before deleting the users rows
  if (demoEmpIds.length > 0) {
    const ids = demoEmpIds.join(',');
    await db.execute(sql.raw(`
      DELETE FROM messages                WHERE sender_id    IN (${ids}) OR recipient_id   IN (${ids});
      DELETE FROM availability            WHERE user_id       IN (${ids});
      DELETE FROM additional_pay          WHERE user_id       IN (${ids}) OR voided_by IN (${ids});
      DELETE FROM contact_tickets         WHERE user_id       IN (${ids}) OR created_by IN (${ids});
      DELETE FROM employee_notes          WHERE user_id       IN (${ids}) OR created_by IN (${ids});
      DELETE FROM employee_attendance_log WHERE employee_id   IN (${ids}) OR logged_by  IN (${ids});
      DELETE FROM employee_discipline_log WHERE employee_id   IN (${ids}) OR issued_by  IN (${ids});
      DELETE FROM employee_leave_usage    WHERE employee_id   IN (${ids}) OR logged_by  IN (${ids});
      DELETE FROM employee_payroll_history WHERE employee_id  IN (${ids});
      DELETE FROM incentive_earned        WHERE employee_id   IN (${ids}) OR approved_by IN (${ids}) OR awarded_by IN (${ids});
      DELETE FROM clock_in_attempts       WHERE user_id       IN (${ids}) OR override_by IN (${ids});
      DELETE FROM document_requests       WHERE employee_id   IN (${ids});
      DELETE FROM document_signatures     WHERE employee_id   IN (${ids});
      DELETE FROM mileage_requests        WHERE user_id       IN (${ids});
      DELETE FROM service_zone_employees  WHERE user_id       IN (${ids});
      DELETE FROM audit_log               WHERE admin_user_id IN (${ids});
      UPDATE jobs               SET assigned_user_id = NULL WHERE assigned_user_id IN (${ids});
      UPDATE job_status_logs    SET user_id = NULL          WHERE user_id          IN (${ids});
      UPDATE communication_log  SET logged_by = NULL        WHERE logged_by        IN (${ids});
      UPDATE cancellation_log   SET cancelled_by = NULL     WHERE cancelled_by     IN (${ids});
      UPDATE daily_summaries    SET marked_complete_by = NULL WHERE marked_complete_by IN (${ids});
      UPDATE invoices           SET created_by = NULL       WHERE created_by       IN (${ids});
      UPDATE client_communications SET sent_by = NULL       WHERE sent_by          IN (${ids});
      UPDATE client_attachments SET uploaded_by = NULL      WHERE uploaded_by      IN (${ids});
      UPDATE job_photos         SET uploaded_by = NULL      WHERE uploaded_by      IN (${ids});
      UPDATE agreement_templates SET created_by = NULL      WHERE created_by       IN (${ids});
      UPDATE document_templates  SET created_by = NULL      WHERE created_by       IN (${ids});
      UPDATE form_templates      SET created_by = NULL      WHERE created_by       IN (${ids});
      UPDATE form_submissions    SET submitted_by = NULL    WHERE submitted_by     IN (${ids});
    `));
    const re = await db.delete(usersTable).where(inArray(usersTable.id, demoEmpIds)).returning({ id: usersTable.id });
    d.emps += re.length;
  }
  console.log(`[seed] Demo cleanup done — removed: ${d.emps} employees, ${d.clients} clients, ${d.jobs} jobs, ${d.inv} invoices, ${d.sc} scorecards, ${d.tc} clock entries, ${d.ct} contact tickets`);
}

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
          address: "9850 South Cicero Ave",
          city: "Oak Lawn",
          state: "IL",
          zip: "60453",
          logo_url: "/api/uploads/logos/phes-logo.jpeg",
          business_hours: "Monday \u2013 Friday: 9:00 AM \u2013 6:00 PM\nSaturday: 9:00 AM \u2013 12:00 PM\nSunday: Closed",
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

    // ── Demo data guard ──────────────────────────────────────────────────────
    // ALWAYS run cleanup first — it is fully idempotent (no-op when nothing to remove).
    // This fires on every startup regardless of environment so fake employees can never
    // survive a restart cycle. Never gate cleanup on NODE_ENV or a sentinel row.
    await cleanupDemoData(companyId);

    // Always clean up known test/demo records (idempotent — safe to run every startup)
    // 1. Remove seeded mileage request (Jennifer Williams → Robert Johnson, 8.50 mi)
    const deletedMileage = await db.delete(mileageRequestsTable)
      .where(and(
        eq(mileageRequestsTable.company_id, companyId),
        sql`from_client_name = 'Jennifer Williams'`,
        sql`to_client_name = 'Robert Johnson'`,
      )).returning({ id: mileageRequestsTable.id });
    if (deletedMileage.length > 0) console.log("[seed] Removed seeded mileage request record");

    // 2. Deactivate Pinnacle Property Management demo commercial account
    const deactivatedPinnacle = await db.update(accountsTable)
      .set({ is_active: false })
      .where(and(
        eq(accountsTable.company_id, companyId),
        sql`account_name = 'Pinnacle Property Management'`,
        eq(accountsTable.is_active, true),
      )).returning({ id: accountsTable.id });
    if (deactivatedPinnacle.length > 0) console.log("[seed] Deactivated Pinnacle Property Management demo account");

    // ── Real PHES employees: check presence (used for both demo-seed guard and import guard) ──
    // Query once — reused for both decisions below.
    const REAL_EMP_EMAILS = (phesEmployeesData as any[]).map((e: any) => e.email).filter(Boolean);
    const existingRealEmps = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(and(eq(usersTable.company_id, companyId), inArray(usersTable.email, REAL_EMP_EMAILS)));

    const realEmpCount = existingRealEmps.length;

    // Only seed demo data when no real PHES employees are present.
    // This guard is environment-agnostic — it works regardless of NODE_ENV.
    if (realEmpCount === 0) {
      // No real PHES employees found — this is a fresh dev environment; seed demo data.
      const demoCheck = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.email, "linda.torres@phes.io"))
        .limit(1);
      if (demoCheck.length === 0) {
        console.log("[seed] No real PHES employees and no demo data — seeding dev demo data...");
        await seedDemoData(companyId, ownerId);
      } else {
        console.log("[seed] Demo data already present — skipping");
      }
    } else {
      console.log(`[seed] Real PHES employees present (${realEmpCount}) — skipping demo seed entirely`);
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

    // ── Real PHES employees import ───────────────────────────────────────────
    // realEmpCount already fetched above — reuse it here.
    if (realEmpCount < phesEmployeesData.length) {
      console.log(`[seed] Only ${realEmpCount} real PHES employees found — importing ${phesEmployeesData.length} from bundle...`);
      const placeholder = await bcrypt.hash("ChangeMe2026!", 10);
      const empBatch = (phesEmployeesData as any[]).map((e: any) => ({
        id: e.id,
        company_id: companyId,
        first_name: e.first_name,
        last_name: e.last_name,
        email: e.email ?? null,
        phone: e.phone ?? null,
        personal_email: e.personal_email ?? null,
        address: e.address ?? null,
        city: e.city ?? null,
        state: e.state ?? null,
        zip: e.zip ?? null,
        dob: e.dob ?? null,
        gender: e.gender ?? null,
        hire_date: e.hire_date ?? null,
        role: e.role as any,
        employment_type: e.employment_type ?? null,
        pay_rate: e.pay_rate ?? null,
        pay_type: e.pay_type ?? null,
        fee_split_pct: e.fee_split_pct ?? null,
        allowed_hours_per_week: e.allowed_hours_per_week ?? null,
        overtime_eligible: e.overtime_eligible ?? false,
        w2_1099: e.w2_1099 ?? null,
        bank_name: e.bank_name ?? null,
        bank_account_last4: e.bank_account_last4 ?? null,
        skills: e.skills ?? null,
        tags: e.tags ?? null,
        emergency_contact_name: e.emergency_contact_name ?? null,
        emergency_contact_phone: e.emergency_contact_phone ?? null,
        emergency_contact_relation: e.emergency_contact_relation ?? null,
        ssn_last4: e.ssn_last4 ?? null,
        notes: e.notes ?? null,
        hr_status: e.hr_status ?? null,
        commission_rate_override: e.commission_rate_override ?? null,
        is_active: e.is_active ?? true,
        crew_id: e.crew_id ?? null,
        home_branch_id: oakLawnBranchId,
        password_hash: placeholder,
      }));
      await db.insert(usersTable).values(empBatch).onConflictDoNothing();
      await db.execute(sql`SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST(nextval(pg_get_serial_sequence('users', 'id')), 50))`);
      console.log(`[seed] Real PHES employees imported: ${empBatch.length}`);
    } else {
      console.log(`[seed] Real PHES employees OK (${realEmpCount} found) — skipping import`);
    }

    // ── Ensure office user credentials (always runs) ──────────────────────────
    const officeHash = await bcrypt.hash("phes1234", 10);
    await db.update(usersTable)
      .set({ password_hash: officeHash, role: "admin" } as any)
      .where(eq(usersTable.email, "info@phes.io"));
    await db.update(usersTable)
      .set({ password_hash: officeHash } as any)
      .where(eq(usersTable.email, "franciscojestevezs@gmail.com"));
    console.log("[seed] Office user credentials ensured (info@phes.io → admin, phes1234)");

  } catch (err) {
    console.error("[seed] Seed error (non-fatal):", err);
  }
}
