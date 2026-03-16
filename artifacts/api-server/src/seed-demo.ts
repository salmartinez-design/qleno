import { db } from "@workspace/db";
import {
  usersTable, clientsTable, jobsTable, invoicesTable,
  timeclockTable, scorecardsTable, contactTicketsTable,
} from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";

export async function seedDemoData(companyId: number, ownerId: number) {
  console.log("[demo-seed] Starting PHES demo data seed...");

  const pwHash = await bcrypt.hash("phes1234", 10);
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const dateOffset = (days: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  // ── 1. EMPLOYEES ────────────────────────────────────────────────────────────
  console.log("[demo-seed] Seeding employees...");
  const employeeDefs = [
    { first_name: "Maria",  last_name: "Gonzalez", email: "maria.gonzalez@phes.io",  role: "technician" as const, pay_rate: "18.00",  hire_date: "2023-03-15" },
    { first_name: "James",  last_name: "Okafor",   email: "james.okafor@phes.io",    role: "technician" as const, pay_rate: "17.00",  hire_date: "2023-06-01" },
    { first_name: "Sofia",  last_name: "Reyes",    email: "sofia.reyes@phes.io",     role: "technician" as const, pay_rate: "19.00",  hire_date: "2022-01-10" },
    { first_name: "Darius", last_name: "Williams", email: "darius.williams@phes.io", role: "technician" as const, pay_rate: "17.50",  hire_date: "2024-09-05" },
    { first_name: "Anika",  last_name: "Patel",    email: "anika.patel@phes.io",     role: "technician" as const, pay_rate: "18.00",  hire_date: "2023-11-20" },
    { first_name: "Carlos", last_name: "Mendoza",  email: "carlos.mendoza@phes.io",  role: "technician" as const, pay_rate: "16.00",  hire_date: "2025-02-14" },
    { first_name: "Tanya",  last_name: "Brooks",   email: "tanya.brooks@phes.io",    role: "technician" as const, pay_rate: "18.50",  hire_date: "2023-04-03" },
    { first_name: "Kevin",  last_name: "Osei",     email: "kevin.osei@phes.io",      role: "technician" as const, pay_rate: "17.00",  hire_date: "2024-07-22" },
    { first_name: "Rachel", last_name: "Kim",      email: "rachel.kim@phes.io",      role: "technician" as const, pay_rate: "19.00",  hire_date: "2022-08-15" },
    { first_name: "Linda",  last_name: "Torres",   email: "linda.torres@phes.io",    role: "admin"      as const, pay_rate: "22.00",  hire_date: "2021-05-01" },
  ];

  const employeeIds: number[] = [];
  for (const emp of employeeDefs) {
    const existing = await db.select({ id: usersTable.id }).from(usersTable)
      .where(eq(usersTable.email, emp.email)).limit(1);
    if (existing.length > 0) {
      employeeIds.push(existing[0].id);
      console.log(`  [skip] ${emp.email} already exists`);
      continue;
    }
    const [row] = await db.insert(usersTable).values({
      company_id: companyId,
      email: emp.email,
      password_hash: pwHash,
      role: emp.role,
      first_name: emp.first_name,
      last_name: emp.last_name,
      pay_type: "hourly",
      pay_rate: emp.pay_rate,
      hire_date: emp.hire_date,
      employment_type: "full_time",
      is_active: true,
    }).returning({ id: usersTable.id });
    employeeIds.push(row.id);
    console.log(`  Created ${emp.first_name} ${emp.last_name} (id=${row.id})`);
  }

  // ── 2. CLIENTS ──────────────────────────────────────────────────────────────
  console.log("[demo-seed] Seeding clients...");
  const clientDefs = [
    { first_name: "Robert",   last_name: "Mitchell",       email: "rmitchell@email.com",      phone: "(708) 555-0101", address: "4521 W 95th St",    city: "Oak Lawn",      state: "IL", zip: "60453", frequency: "biweekly",  service_type: "recurring_cleaning",  base_fee: "220.00", loyalty_tier: "gold",     loyalty_points: 824,  is_active: true,  notes: "Also care for Susan Mitchell" },
    { first_name: "Jennifer", last_name: "Kowalski",       email: "jkowalski@email.com",      phone: "(630) 555-0102", address: "2847 Maple Ave",    city: "Downers Grove", state: "IL", zip: "60515", frequency: "monthly",   service_type: "deep_clean",          base_fee: "380.00", loyalty_tier: "vip",      loyalty_points: 1250, is_active: true,  notes: null },
    { first_name: "Daniel",   last_name: "Novak",          email: "dnovak@email.com",         phone: "(708) 555-0103", address: "7732 W 111th St",   city: "Worth",         state: "IL", zip: "60482", frequency: "weekly",    service_type: "recurring_cleaning",  base_fee: "220.00", loyalty_tier: "vip",      loyalty_points: 2280, is_active: true,  notes: "Also care for Patricia Novak" },
    { first_name: "Sunrise",  last_name: "Property Mgmt",  email: "info@sunriseprop.com",     phone: "(847) 555-0104", address: "6600 Lincoln Ave",  city: "Lincolnwood",   state: "IL", zip: "60712", frequency: "biweekly",  service_type: "commercial_cleaning", base_fee: "420.00", loyalty_tier: "vip",      loyalty_points: 3150, is_active: true,  notes: "Property management — multiple units" },
    { first_name: "Amanda",   last_name: "Thornton",       email: "athornton@email.com",      phone: "(630) 555-0105", address: "1104 Elm St",       city: "Elmhurst",      state: "IL", zip: "60126", frequency: "biweekly",  service_type: "recurring_cleaning",  base_fee: "195.00", loyalty_tier: "silver",   loyalty_points: 560,  is_active: true,  notes: null },
    { first_name: "Kevin",    last_name: "Hargrove",       email: "khargrove@email.com",      phone: "(708) 555-0106", address: "903 Park Blvd",     city: "Oak Park",      state: "IL", zip: "60301", frequency: "on_demand", service_type: "deep_clean",          base_fee: "280.00", loyalty_tier: "standard", loyalty_points: 184,  is_active: false, notes: "Also care for Lisa Hargrove. One-time deep clean." },
    { first_name: "Margaret", last_name: "Schulz",         email: "mschulz@email.com",        phone: "(773) 555-0107", address: "5219 S Harlem Ave", city: "Chicago",       state: "IL", zip: "60638", frequency: "monthly",   service_type: "recurring_cleaning",  base_fee: "185.00", loyalty_tier: "standard", loyalty_points: 420,  is_active: true,  notes: null },
    { first_name: "Westside", last_name: "Dental Group",   email: "admin@westsidedental.com", phone: "(708) 555-0108", address: "8801 W Cermak Rd",  city: "Berwyn",        state: "IL", zip: "60402", frequency: "weekly",    service_type: "commercial_cleaning", base_fee: "310.00", loyalty_tier: "gold",     loyalty_points: 910,  is_active: true,  notes: "Commercial client — weekly dental office cleaning" },
    { first_name: "Thomas",   last_name: "Brennan",        email: "tbrennan@email.com",       phone: "(708) 555-0109", address: "420 Hickory Lane",  city: "Palos Hills",   state: "IL", zip: "60465", frequency: "biweekly",  service_type: "recurring_cleaning",  base_fee: "205.00", loyalty_tier: "standard", loyalty_points: 770,  is_active: true,  notes: "Also care for Claire Brennan. At-risk — no recent bookings." },
    { first_name: "Nina",     last_name: "Castillo",       email: "ncastillo@email.com",      phone: "(773) 555-0110", address: "3318 W 63rd St",    city: "Chicago",       state: "IL", zip: "60629", frequency: "on_demand", service_type: "standard_clean",      base_fee: "175.00", loyalty_tier: "standard", loyalty_points: 210,  is_active: true,  notes: null },
  ];

  const clientIds: number[] = [];
  for (const c of clientDefs) {
    const existing = await db.select({ id: clientsTable.id }).from(clientsTable)
      .where(and(eq(clientsTable.company_id, companyId), eq(clientsTable.email, c.email!))).limit(1);
    if (existing.length > 0) {
      clientIds.push(existing[0].id);
      console.log(`  [skip] client ${c.first_name} ${c.last_name} already exists`);
      continue;
    }
    const [row] = await db.insert(clientsTable).values({
      company_id: companyId,
      first_name: c.first_name,
      last_name: c.last_name,
      email: c.email,
      phone: c.phone,
      address: c.address,
      city: c.city,
      state: c.state,
      zip: c.zip,
      frequency: c.frequency as any,
      service_type: c.service_type,
      base_fee: c.base_fee,
      loyalty_tier: c.loyalty_tier,
      loyalty_points: c.loyalty_points,
      is_active: c.is_active,
      notes: c.notes,
    }).returning({ id: clientsTable.id });
    clientIds.push(row.id);
    console.log(`  Created ${c.first_name} ${c.last_name} (id=${row.id})`);
  }

  // ── 3. JOBS ──────────────────────────────────────────────────────────────────
  console.log("[demo-seed] Seeding jobs...");

  const cid = (i: number) => clientIds[i];
  const eid = (i: number) => employeeIds[i];

  const jobDefs = [
    { client: 0, emp: 0,    date: dateOffset(-28), time: "08:00", service: "recurring",        status: "complete",    fee: "220.00", notes: null },
    { client: 1, emp: 2,    date: dateOffset(-22), time: "09:30", service: "deep_clean",        status: "complete",    fee: "380.00", notes: null },
    { client: 5, emp: 6,    date: dateOffset(-18), time: "10:00", service: "deep_clean",        status: "complete",    fee: "280.00", notes: null },
    { client: 4, emp: 4,    date: dateOffset(-12), time: "08:30", service: "recurring",         status: "complete",    fee: "195.00", notes: null },
    { client: 7, emp: 1,    date: dateOffset(-7),  time: "07:30", service: "office_cleaning",   status: "complete",    fee: "310.00", notes: null },
    { client: 2, emp: 2,    date: todayStr,         time: "07:30", service: "recurring",         status: "in_progress", fee: "220.00", notes: null },
    { client: 3, emp: 3,    date: todayStr,         time: "09:00", service: "office_cleaning",   status: "in_progress", fee: "420.00", notes: null },
    { client: 9, emp: 7,    date: todayStr,         time: "10:30", service: "standard_clean",    status: "in_progress", fee: "175.00", notes: null },
    { client: 0, emp: 0,    date: dateOffset(3),   time: "08:00", service: "recurring",         status: "scheduled",   fee: "220.00", notes: null },
    { client: 6, emp: 8,    date: dateOffset(4),   time: "09:00", service: "recurring",         status: "scheduled",   fee: "185.00", notes: null },
    { client: 1, emp: 2,    date: dateOffset(5),   time: "09:30", service: "deep_clean",        status: "scheduled",   fee: "380.00", notes: null },
    { client: 4, emp: 4,    date: dateOffset(6),   time: "08:30", service: "recurring",         status: "scheduled",   fee: "195.00", notes: null },
    { client: 8, emp: 5,    date: dateOffset(-14), time: "08:00", service: "recurring",         status: "complete",    fee: "205.00", notes: "FLAGGED: Client reported items moved without permission. Needs review." },
    { client: 3, emp: 6,    date: dateOffset(-9),  time: "10:00", service: "office_cleaning",   status: "complete",    fee: "420.00", notes: "FLAGGED: Team arrived 45 minutes late. Client notified." },
    { client: 9, emp: null, date: dateOffset(10),  time: "11:00", service: "standard_clean",    status: "scheduled",   fee: "175.00", notes: "Unassigned — awaiting tech assignment" },
  ];

  const jobIds: number[] = [];
  for (const j of jobDefs) {
    const freq = ["weekly","biweekly","monthly","on_demand"].includes(clientDefs[j.client].frequency)
      ? clientDefs[j.client].frequency : "on_demand";
    const [row] = await db.insert(jobsTable).values({
      company_id: companyId,
      client_id: cid(j.client),
      assigned_user_id: j.emp !== null ? eid(j.emp) : null,
      service_type: j.service as any,
      status: j.status as any,
      scheduled_date: j.date,
      scheduled_time: j.time,
      frequency: freq as any,
      base_fee: j.fee,
      notes: j.notes,
    }).returning({ id: jobsTable.id });
    jobIds.push(row.id);
    console.log(`  Created job id=${row.id} status=${j.status}`);
  }

  // ── 4. INVOICES ─────────────────────────────────────────────────────────────
  console.log("[demo-seed] Seeding invoices...");
  const invoiceDefs = [
    { num: "INV-2026-0001", job: 0,  client: 0, status: "paid",    amount: "220.00", due: dateOffset(-20), paid: true },
    { num: "INV-2026-0002", job: 1,  client: 1, status: "paid",    amount: "380.00", due: dateOffset(-14), paid: true },
    { num: "INV-2026-0003", job: 2,  client: 5, status: "paid",    amount: "280.00", due: dateOffset(-10), paid: true },
    { num: "INV-2026-0004", job: 3,  client: 4, status: "sent",    amount: "195.00", due: dateOffset(3),   paid: false },
    { num: "INV-2026-0005", job: 4,  client: 7, status: "sent",    amount: "310.00", due: dateOffset(7),   paid: false },
    { num: "INV-2026-0006", job: 12, client: 8, status: "overdue", amount: "205.00", due: dateOffset(-10), paid: false },
    { num: "INV-2026-0007", job: 13, client: 3, status: "draft",   amount: "420.00", due: dateOffset(14),  paid: false },
    { num: "INV-2026-0008", job: 5,  client: 2, status: "draft",   amount: "220.00", due: dateOffset(14),  paid: false },
  ];

  for (const inv of invoiceDefs) {
    const sentAt = inv.status !== "draft" ? new Date(today.getTime() - 14 * 86400000) : null;
    const paidAt = inv.paid ? new Date(today.getTime() - 5 * 86400000) : null;
    await db.insert(invoicesTable).values({
      company_id: companyId,
      client_id: clientIds[inv.client],
      job_id: jobIds[inv.job],
      invoice_number: inv.num,
      status: inv.status as any,
      line_items: [{ description: "Cleaning Service", amount: inv.amount }] as any,
      subtotal: inv.amount,
      total: inv.amount,
      due_date: inv.due,
      sent_at: sentAt,
      paid_at: paidAt,
      created_by: ownerId,
    });
    console.log(`  Created invoice ${inv.num} status=${inv.status}`);
  }

  // ── 5. TIMECLOCK ENTRIES ─────────────────────────────────────────────────────
  console.log("[demo-seed] Seeding timeclock entries...");
  const timeclockDefs = [
    { empIdx: 2, jobIdx: 5, inH: 7,    inM: 30,  outH: 11,   outM: 15,   flagged: false, hoursAgo: 0 },
    { empIdx: 3, jobIdx: 6, inH: 9,    inM: 5,   outH: 12,   outM: 45,   flagged: false, hoursAgo: 0 },
    { empIdx: 7, jobIdx: 7, inH: 10,   inM: 35,  outH: null, outM: null, flagged: false, hoursAgo: 0 },
    { empIdx: 0, jobIdx: 0, inH: null, inM: null, outH: null, outM: null, flagged: true,  hoursAgo: 8 },
  ];

  for (const tc of timeclockDefs) {
    const inTime = new Date(today);
    if (tc.hoursAgo) {
      inTime.setTime(today.getTime() - tc.hoursAgo * 3600000);
    } else {
      inTime.setHours(tc.inH!, tc.inM!, 0, 0);
    }
    const outTime = tc.outH !== null ? new Date(today) : null;
    if (outTime && tc.outH !== null) outTime.setHours(tc.outH, tc.outM!, 0, 0);

    await db.insert(timeclockTable).values({
      company_id: companyId,
      user_id: employeeIds[tc.empIdx],
      job_id: jobIds[tc.jobIdx],
      clock_in_at: inTime,
      clock_out_at: outTime,
      flagged: tc.flagged,
    });
  }

  // ── 6. SCORECARDS ────────────────────────────────────────────────────────────
  console.log("[demo-seed] Seeding scorecards...");
  const scoreDefs = [
    { jobIdx: 0, empIdx: 0, clientIdx: 0, score: 4, comments: "We're thrilled! Maria was punctual, professional, and our home has never looked better. Will definitely book again." },
    { jobIdx: 1, empIdx: 2, clientIdx: 1, score: 3, comments: "We're happy overall. The deep clean was thorough, just a few spots in the bathrooms that could use more attention next time." },
    { jobIdx: 2, empIdx: 6, clientIdx: 5, score: 1, comments: "Considering switching to another company. Several areas were missed entirely and the team left without letting us know they were done." },
  ];

  for (const s of scoreDefs) {
    await db.insert(scorecardsTable).values({
      company_id: companyId,
      job_id: jobIds[s.jobIdx],
      user_id: employeeIds[s.empIdx],
      client_id: clientIds[s.clientIdx],
      score: s.score,
      comments: s.comments,
    });
  }

  // ── 7. CONTACT TICKET ───────────────────────────────────────────────────────
  console.log("[demo-seed] Seeding contact ticket...");
  await db.insert(contactTicketsTable).values({
    company_id: companyId,
    user_id: employeeIds[6],
    client_id: clientIds[5],
    job_id: jobIds[2],
    ticket_type: "complaint_poor_cleaning",
    notes: "Auto-generated from 1-star scorecard. Client commented: 'Several areas were missed entirely and the team left without letting us know they were done.' Follow up with client immediately.",
    created_by: ownerId,
  });

  console.log(`[demo-seed] Done — ${employeeIds.length} employees, ${clientIds.length} clients, ${jobIds.length} jobs, ${invoiceDefs.length} invoices`);
}

// Allow running directly: pnpm exec tsx src/seed-demo.ts
if (process.argv[1]?.endsWith("seed-demo.ts") || process.argv[1]?.endsWith("seed-demo.js")) {
  const { db: dbInst } = await import("@workspace/db");
  const { companiesTable: ct, usersTable: ut } = await import("@workspace/db/schema");
  const { eq: eqFn } = await import("drizzle-orm");
  const [company] = await dbInst.select({ id: ct.id }).from(ct).where(eqFn(ct.slug, "phes-cleaning")).limit(1);
  const [owner] = await dbInst.select({ id: ut.id }).from(ut).where(eqFn(ut.email, "salmartinez@phes.io")).limit(1);
  if (!company || !owner) { console.error("PHES company not found — run seed first"); process.exit(1); }
  await seedDemoData(company.id, owner.id);
  process.exit(0);
}
