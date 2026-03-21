import { db } from "./index.js";
import { accountsTable, accountRateCardsTable, accountPropertiesTable, accountContactsTable, companiesTable } from "./schema/index.js";
import { eq } from "drizzle-orm";

async function seedAccounts() {
  // Get the first company (PHES Cleaning LLC)
  const [company] = await db.select().from(companiesTable).limit(1);
  if (!company) {
    console.error("No company found — run main seed first.");
    process.exit(1);
  }

  const companyId = company.id;
  console.log(`Seeding commercial accounts for company: ${company.name} (id=${companyId})`);

  // Check if demo account already exists
  const existing = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.company_id, companyId));

  if (existing.some((a) => a.account_name === "Pinnacle Property Management")) {
    console.log("PPM Demo Account already exists — skipping.");
    process.exit(0);
  }

  // ── Create Pinnacle Property Management account ────────────────────────
  const [ppm] = await db
    .insert(accountsTable)
    .values({
      company_id: companyId,
      account_name: "Pinnacle Property Management",
      account_type: "property_management",
      payment_method: "card_on_file",
      invoice_frequency: "monthly",
      payment_terms_days: 30,
      auto_charge_on_completion: false,
      notes: "Demo account — Pinnacle manages 5 properties in the Chicagoland area. Monthly consolidated invoices. Net-30 terms.",
      is_active: true,
    })
    .returning();

  console.log(`Created account: ${ppm.account_name} (id=${ppm.id})`);

  // ── Rate cards ─────────────────────────────────────────────────────────
  const rateCards = [
    { service_type: "standard_cleaning", billing_method: "hourly" as const, rate_amount: "45.00", unit_label: "hr", notes: "Per cleaner per hour. Minimum 2 hours." },
    { service_type: "deep_cleaning",     billing_method: "hourly" as const, rate_amount: "55.00", unit_label: "hr", notes: "Per cleaner per hour. Minimum 4 hours." },
    { service_type: "move_out_cleaning", billing_method: "flat_rate" as const, rate_amount: "250.00", unit_label: "unit", notes: "Flat rate per unit regardless of size." },
    { service_type: "window_cleaning",   billing_method: "per_unit" as const, rate_amount: "8.00",  unit_label: "window", notes: "Interior + exterior per pane." },
    { service_type: "carpet_cleaning",   billing_method: "per_unit" as const, rate_amount: "35.00", unit_label: "room",   notes: "Per room. Includes pre-treatment." },
  ];

  const insertedCards = await db
    .insert(accountRateCardsTable)
    .values(rateCards.map((rc) => ({ ...rc, account_id: ppm.id, company_id: companyId })))
    .returning();

  console.log(`Created ${insertedCards.length} rate cards.`);

  // ── Properties ─────────────────────────────────────────────────────────
  const properties = [
    {
      property_name: "Oak Lawn Commons",
      address: "4801 W 95th St",
      city: "Oak Lawn",
      state: "IL",
      zip: "60453",
      unit_count: 48,
      property_type: "apartment_building" as const,
      default_service_type: "standard_cleaning",
      access_notes: "Key fob in lockbox at main entrance. Code: 2247. Management office open M-F 9am-5pm.",
    },
    {
      property_name: "Schaumburg Plaza Apts",
      address: "1200 E Higgins Rd",
      city: "Schaumburg",
      state: "IL",
      zip: "60173",
      unit_count: 64,
      property_type: "apartment_building" as const,
      default_service_type: "standard_cleaning",
      access_notes: "Contact super Mike Torres at 847-555-0192 for access. Gate code: 4411.",
    },
    {
      property_name: "Riverside Condos — Common Areas",
      address: "220 N Riverside Plaza",
      city: "Chicago",
      state: "IL",
      zip: "60606",
      unit_count: null,
      property_type: "common_area" as const,
      default_service_type: "standard_cleaning",
      access_notes: "Common area only — lobby, hallways, laundry room. Use service entrance on west side.",
    },
    {
      property_name: "Westmont Office Suites",
      address: "6600 S Cass Ave",
      city: "Westmont",
      state: "IL",
      zip: "60559",
      unit_count: 12,
      property_type: "office" as const,
      default_service_type: "standard_cleaning",
      access_notes: "After-hours cleaning only. Alarm code: 9823. Lock up and set alarm on exit.",
    },
    {
      property_name: "Bridgeview Retail Strip",
      address: "7300 W 87th St",
      city: "Bridgeview",
      state: "IL",
      zip: "60455",
      unit_count: 8,
      property_type: "retail" as const,
      default_service_type: "standard_cleaning",
      access_notes: "Strip mall. Each unit has its own key. Call PM office for key pickup the day before.",
    },
  ];

  const insertedProps = await db
    .insert(accountPropertiesTable)
    .values(properties.map((p) => ({ ...p, account_id: ppm.id, company_id: companyId, is_active: true })))
    .returning();

  console.log(`Created ${insertedProps.length} properties.`);

  // ── Contacts ──────────────────────────────────────────────────────────
  const contacts = [
    {
      name: "Diana Reyes",
      role: "billing" as const,
      email: "diana.reyes@pinnaclepm.com",
      phone: "(708) 555-0141",
      receives_invoices: true,
      receives_receipts: true,
      receives_on_way_sms: false,
      receives_completion_notifications: false,
      is_primary: true,
      notes: "Accounts payable. Prefers invoices by the 1st of each month.",
    },
    {
      name: "Marcus Webb",
      role: "property_manager" as const,
      email: "m.webb@pinnaclepm.com",
      phone: "(708) 555-0188",
      receives_invoices: false,
      receives_receipts: false,
      receives_on_way_sms: true,
      receives_completion_notifications: true,
      is_primary: false,
      notes: "Operations contact. Needs on-the-way SMS and completion notifications for all jobs.",
    },
  ];

  const insertedContacts = await db
    .insert(accountContactsTable)
    .values(contacts.map((c) => ({ ...c, account_id: ppm.id, company_id: companyId })))
    .returning();

  console.log(`Created ${insertedContacts.length} contacts.`);
  console.log("\nSeed complete!");
  console.log(`  Account:    ${ppm.account_name} (id=${ppm.id})`);
  console.log(`  Properties: ${insertedProps.map((p) => p.property_name).join(", ")}`);
  console.log(`  Contacts:   ${insertedContacts.map((c) => c.name).join(", ")}`);
}

seedAccounts()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
