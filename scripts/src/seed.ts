import { db } from "@workspace/db";
import {
  companiesTable,
  usersTable,
  clientsTable,
  jobsTable,
  invoicesTable,
  scorecardsTable,
  timeclockTable,
  loyaltySettingsTable,
  loyaltyPointsLogTable,
} from "@workspace/db/schema";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";

async function seed() {
  console.log("Seeding database...");

  const existing = await db.select().from(companiesTable).where(eq(companiesTable.slug, "phes-cleaning")).limit(1);
  if (existing[0]) {
    console.log("Database already seeded. Skipping.");
    process.exit(0);
  }

  const [company] = await db.insert(companiesTable).values({
    name: "PHES Cleaning LLC",
    slug: "phes-cleaning",
    subscription_status: "active",
    plan: "growth",
    employee_count: 5,
    pay_cadence: "biweekly",
    geo_fence_threshold_ft: 500,
  }).returning();

  console.log("Created company:", company.name);

  const passwordHash = await bcrypt.hash("demo1234", 10);

  const [owner] = await db.insert(usersTable).values({
    company_id: company.id,
    email: "owner@phescleaning.com",
    password_hash: passwordHash,
    role: "owner",
    first_name: "Sal",
    last_name: "Martinez",
    is_active: true,
    pay_rate: "0",
    pay_type: "hourly",
  }).returning();

  const [admin] = await db.insert(usersTable).values({
    company_id: company.id,
    email: "admin@phescleaning.com",
    password_hash: passwordHash,
    role: "admin",
    first_name: "Maria",
    last_name: "Rodriguez",
    is_active: true,
    pay_rate: "22.00",
    pay_type: "hourly",
    hire_date: "2023-01-15",
  }).returning();

  const [tech1] = await db.insert(usersTable).values({
    company_id: company.id,
    email: "jessica@phescleaning.com",
    password_hash: passwordHash,
    role: "technician",
    first_name: "Jessica",
    last_name: "Chen",
    is_active: true,
    pay_rate: "18.50",
    pay_type: "hourly",
    hire_date: "2023-03-20",
    skills: ["Deep Clean", "Move Out", "Commercial"],
  }).returning();

  const [tech2] = await db.insert(usersTable).values({
    company_id: company.id,
    email: "carlos@phescleaning.com",
    password_hash: passwordHash,
    role: "technician",
    first_name: "Carlos",
    last_name: "Vega",
    is_active: true,
    pay_rate: "17.00",
    pay_type: "hourly",
    hire_date: "2023-06-01",
    skills: ["Standard Clean", "Commercial"],
  }).returning();

  const [tech3] = await db.insert(usersTable).values({
    company_id: company.id,
    email: "amber@phescleaning.com",
    password_hash: passwordHash,
    role: "technician",
    first_name: "Amber",
    last_name: "Thompson",
    is_active: true,
    pay_rate: "19.00",
    pay_type: "fee_split",
    fee_split_pct: "35.00",
    hire_date: "2022-11-10",
    skills: ["Deep Clean", "Move In", "Move Out"],
  }).returning();

  console.log("Created users");

  const clients = await db.insert(clientsTable).values([
    {
      company_id: company.id,
      first_name: "Jennifer",
      last_name: "Williams",
      email: "jennifer.w@email.com",
      phone: "555-0101",
      address: "1234 Oak Street",
      city: "Austin",
      state: "TX",
      zip: "78701",
      lat: "30.2672",
      lng: "-97.7431",
      loyalty_points: 350,
      notes: "Prefers eco-friendly products. Has two dogs — please use pet-safe solutions.",
    },
    {
      company_id: company.id,
      first_name: "Robert",
      last_name: "Johnson",
      email: "rjohnson@biz.com",
      phone: "555-0102",
      address: "567 Elm Drive",
      city: "Austin",
      state: "TX",
      zip: "78702",
      lat: "30.2500",
      lng: "-97.7400",
      loyalty_points: 120,
    },
    {
      company_id: company.id,
      first_name: "Sarah",
      last_name: "Martinez",
      email: "smartinez@email.com",
      phone: "555-0103",
      address: "890 Pine Avenue",
      city: "Austin",
      state: "TX",
      zip: "78703",
      lat: "30.2800",
      lng: "-97.7500",
      loyalty_points: 500,
      notes: "VIP client — 5 years. Always tip $20.",
    },
    {
      company_id: company.id,
      first_name: "Michael",
      last_name: "Davis",
      email: "mdavis@company.com",
      phone: "555-0104",
      address: "123 Business Blvd",
      city: "Austin",
      state: "TX",
      zip: "78704",
      loyalty_points: 75,
    },
    {
      company_id: company.id,
      first_name: "Emily",
      last_name: "Brown",
      email: "emily.brown@email.com",
      phone: "555-0105",
      address: "456 Cedar Lane",
      city: "Austin",
      state: "TX",
      zip: "78705",
      lat: "30.2900",
      lng: "-97.7600",
      loyalty_points: 200,
    },
  ]).returning();

  console.log("Created clients");

  const today = new Date();
  const dateStr = (offset: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    return d.toISOString().split("T")[0];
  };

  const jobs = await db.insert(jobsTable).values([
    {
      company_id: company.id,
      client_id: clients[0].id,
      assigned_user_id: tech1.id,
      service_type: "standard_clean",
      status: "complete",
      scheduled_date: dateStr(-7),
      scheduled_time: "09:00",
      frequency: "biweekly",
      base_fee: "150.00",
      allowed_hours: "3.00",
      actual_hours: "2.75",
    },
    {
      company_id: company.id,
      client_id: clients[1].id,
      assigned_user_id: tech2.id,
      service_type: "deep_clean",
      status: "complete",
      scheduled_date: dateStr(-5),
      scheduled_time: "10:00",
      frequency: "monthly",
      base_fee: "280.00",
      allowed_hours: "5.00",
      actual_hours: "5.5",
    },
    {
      company_id: company.id,
      client_id: clients[2].id,
      assigned_user_id: tech3.id,
      service_type: "recurring",
      status: "complete",
      scheduled_date: dateStr(-3),
      scheduled_time: "08:30",
      frequency: "weekly",
      base_fee: "120.00",
      allowed_hours: "2.50",
      actual_hours: "2.25",
    },
    {
      company_id: company.id,
      client_id: clients[0].id,
      assigned_user_id: tech1.id,
      service_type: "standard_clean",
      status: "scheduled",
      scheduled_date: dateStr(1),
      scheduled_time: "09:00",
      frequency: "biweekly",
      base_fee: "150.00",
      allowed_hours: "3.00",
    },
    {
      company_id: company.id,
      client_id: clients[3].id,
      assigned_user_id: tech2.id,
      service_type: "office_cleaning",
      status: "scheduled",
      scheduled_date: dateStr(1),
      scheduled_time: "13:00",
      frequency: "weekly",
      base_fee: "220.00",
      allowed_hours: "4.00",
    },
    {
      company_id: company.id,
      client_id: clients[2].id,
      assigned_user_id: tech3.id,
      service_type: "recurring",
      status: "scheduled",
      scheduled_date: dateStr(3),
      scheduled_time: "08:30",
      frequency: "weekly",
      base_fee: "120.00",
      allowed_hours: "2.50",
    },
    {
      company_id: company.id,
      client_id: clients[4].id,
      assigned_user_id: tech1.id,
      service_type: "move_out",
      status: "scheduled",
      scheduled_date: dateStr(5),
      scheduled_time: "10:00",
      frequency: "on_demand",
      base_fee: "350.00",
      allowed_hours: "6.00",
    },
    {
      company_id: company.id,
      client_id: clients[1].id,
      assigned_user_id: tech2.id,
      status: "in_progress" as any,
      status: "in_progress",
      scheduled_date: dateStr(0),
      scheduled_time: "09:30",
      frequency: "monthly",
      base_fee: "180.00",
      service_type: "deep_clean",
      allowed_hours: "3.50",
    },
  ]).returning();

  console.log("Created jobs");

  await db.insert(invoicesTable).values([
    {
      company_id: company.id,
      client_id: clients[0].id,
      job_id: jobs[0].id,
      status: "paid",
      line_items: [{ description: "Standard Clean - 3 bed/2 bath", quantity: 1, unit_price: 150, total: 150 }],
      subtotal: "150.00",
      tips: "20.00",
      total: "170.00",
      paid_at: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000),
    },
    {
      company_id: company.id,
      client_id: clients[1].id,
      job_id: jobs[1].id,
      status: "paid",
      line_items: [{ description: "Deep Clean - Full Home", quantity: 1, unit_price: 280, total: 280 }],
      subtotal: "280.00",
      tips: "0.00",
      total: "280.00",
      paid_at: new Date(today.getTime() - 5 * 24 * 60 * 60 * 1000),
    },
    {
      company_id: company.id,
      client_id: clients[2].id,
      job_id: jobs[2].id,
      status: "paid",
      line_items: [{ description: "Recurring Maintenance Clean", quantity: 1, unit_price: 120, total: 120 }],
      subtotal: "120.00",
      tips: "15.00",
      total: "135.00",
      paid_at: new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000),
    },
    {
      company_id: company.id,
      client_id: clients[3].id,
      status: "overdue",
      line_items: [{ description: "Office Cleaning - 2,000 sqft", quantity: 1, unit_price: 220, total: 220 }],
      subtotal: "220.00",
      tips: "0.00",
      total: "220.00",
    },
  ]);

  console.log("Created invoices");

  await db.insert(scorecardsTable).values([
    { company_id: company.id, job_id: jobs[0].id, user_id: tech1.id, client_id: clients[0].id, score: 4, comments: "Excellent work, very thorough!", excluded: false },
    { company_id: company.id, job_id: jobs[1].id, user_id: tech2.id, client_id: clients[1].id, score: 3, comments: "Good job overall", excluded: false },
    { company_id: company.id, job_id: jobs[2].id, user_id: tech3.id, client_id: clients[2].id, score: 4, comments: "Sarah is always satisfied with Amber!", excluded: false },
  ]);

  console.log("Created scorecards");

  await db.insert(timeclockTable).values([
    {
      job_id: jobs[0].id,
      user_id: tech1.id,
      company_id: company.id,
      clock_in_at: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000 + 9 * 3600 * 1000),
      clock_out_at: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000 + 11.75 * 3600 * 1000),
      clock_in_lat: "30.2672",
      clock_in_lng: "-97.7431",
      distance_from_job_ft: "45",
      flagged: false,
    },
    {
      job_id: jobs[1].id,
      user_id: tech2.id,
      company_id: company.id,
      clock_in_at: new Date(today.getTime() - 5 * 24 * 60 * 60 * 1000 + 10 * 3600 * 1000),
      clock_out_at: new Date(today.getTime() - 5 * 24 * 60 * 60 * 1000 + 15.5 * 3600 * 1000),
      clock_in_lat: "30.2500",
      clock_in_lng: "-97.7400",
      distance_from_job_ft: "720",
      flagged: true,
    },
  ]);

  console.log("Created timeclock entries");

  await db.insert(loyaltySettingsTable).values({
    company_id: company.id,
    program_style: "points",
    pts_per_cleaning: 50,
    pts_per_dollar: 1,
    referral_pts: 200,
    review_pts: 100,
    birthday_pts: 50,
    autopay_pts: 25,
    enabled: true,
  });

  await db.insert(loyaltyPointsLogTable).values([
    { company_id: company.id, client_id: clients[0].id, points: 50, action: "earn", reason: "Standard clean completed", job_id: jobs[0].id },
    { company_id: company.id, client_id: clients[0].id, points: 150, action: "earn", reason: "Dollar spend bonus (150 pts)", job_id: jobs[0].id },
    { company_id: company.id, client_id: clients[0].id, points: 100, action: "earn", reason: "Google review bonus" },
    { company_id: company.id, client_id: clients[0].id, points: 50, action: "redeem", reason: "$5 discount applied" },
    { company_id: company.id, client_id: clients[2].id, points: 200, action: "earn", reason: "Referral bonus" },
    { company_id: company.id, client_id: clients[2].id, points: 50, action: "earn", reason: "Recurring clean completed", job_id: jobs[2].id },
    { company_id: company.id, client_id: clients[2].id, points: 120, action: "earn", reason: "Dollar spend bonus (120 pts)", job_id: jobs[2].id },
    { company_id: company.id, client_id: clients[2].id, points: 50, action: "earn", reason: "Birthday bonus month" },
    { company_id: company.id, client_id: clients[2].id, points: 25, action: "earn", reason: "Auto-pay enrollment bonus" },
    { company_id: company.id, client_id: clients[2].id, points: 55, action: "redeem", reason: "Free add-on redeemed" },
  ]);

  console.log("Created loyalty data");

  console.log("\n✓ Seed complete!");
  console.log("\nLogin credentials:");
  console.log("  Owner:  owner@phescleaning.com / demo1234");
  console.log("  Admin:  admin@phescleaning.com / demo1234");
  console.log("  Tech:   jessica@phescleaning.com / demo1234");
  process.exit(0);
}

seed().catch(err => {
  console.error("Seed failed:", err);
  process.exit(1);
});
