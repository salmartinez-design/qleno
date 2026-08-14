import { pgTable, serial, text, integer, timestamp, numeric, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { usersTable } from "./users";
import { jobsTable } from "./jobs";
import { pricingScopesTable } from "./pricing";

export const quotesTable = pgTable("quotes", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  client_id: integer("client_id").references(() => clientsTable.id),
  lead_name: text("lead_name"),
  lead_email: text("lead_email"),
  lead_phone: text("lead_phone"),
  address: text("address"),
  /**
   * The scope's display NAME, not a jobs.service_type enum value. This is what
   * the quote list, the quote email and the customer's booking page print.
   * Different semantics from `service_type_slug` below — do not confuse them.
   */
  service_type: text("service_type"),
  /**
   * [subtype-coinflip 2026-08-14] The EXACT service type the office picked,
   * when the UI knows it and the scope's name cannot express it.
   *
   * Phes has one scope, "Hourly Deep Clean or Move In/Out", sitting behind BOTH
   * the Deep Clean and the Move In / Move Out hourly buttons. Convert resolved
   * a job's type by reading that scope's NAME, so both buttons produced the
   * same answer and one of them was always wrong — whichever way the name
   * matching leaned. No amount of parsing fixes a name that genuinely describes
   * two services.
   *
   * So the picker records what was actually clicked. NULL means "nothing
   * explicit was chosen" and convert falls back to the old name resolution, so
   * every existing quote and every other booking path is unaffected.
   *
   * Holds a jobs.service_type enum slug (e.g. "deep_clean"). Convert casts it
   * into raw SQL, so it MUST be validated against the enum before use — see
   * SERVICE_TYPE_SLUGS in routes/quotes.ts.
   */
  service_type_slug: text("service_type_slug"),
  frequency: text("frequency"),
  estimated_hours: numeric("estimated_hours", { precision: 4, scale: 2 }),
  base_price: numeric("base_price", { precision: 10, scale: 2 }),
  // [rate-override 2026-07-11] Explicit per-quote $/hr the office typed (Sunday /
  // after-hours / special pricing). NULL = use the scope's configured rate. It's
  // baked into base_price/total_price already; stored on its own so it survives
  // edit + carries to the job on convert. Does NOT change base pricing config.
  hourly_rate_override: numeric("hourly_rate_override", { precision: 10, scale: 2 }),
  status: text("status").notNull().default("draft"),
  sent_at: timestamp("sent_at"),
  viewed_at: timestamp("viewed_at"),
  accepted_at: timestamp("accepted_at"),
  booked_job_id: integer("booked_job_id").references(() => jobsTable.id),
  notes: text("notes"),
  created_by: integer("created_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
  scope_id: integer("scope_id").references(() => pricingScopesTable.id),
  pricing_method: text("pricing_method"),
  addons: jsonb("addons").default([]),
  discount_code: text("discount_code"),
  discount_amount: numeric("discount_amount", { precision: 10, scale: 2 }).default("0"),
  total_price: numeric("total_price", { precision: 10, scale: 2 }),
  bedrooms: integer("bedrooms"),
  bathrooms: integer("bathrooms"),
  half_baths: integer("half_baths"),
  sqft: integer("sqft"),
  dirt_level: text("dirt_level").default("standard"),
  pets: integer("pets").default(0),
  special_instructions: text("special_instructions"),
  internal_memo: text("internal_memo"),
  client_notes: text("client_notes"),
  manual_hours: numeric("manual_hours", { precision: 6, scale: 2 }),
  expires_at: timestamp("expires_at"),
  sign_token: text("sign_token"),
  call_notes: text("call_notes"),
  office_notes: text("office_notes"),
  manual_adjustments: jsonb("manual_adjustments").default([]),
  // [leadsource-persist 2026-07-27] "How did you hear about us?" captured on the
  // office quote. Plain text (NOT the clients referral_source enum) because the
  // quote select also emits non-enum values like "existing_client". Previously
  // this column was absent from the schema, so drizzle silently DROPPED
  // referral_source on insert/update and the lead source was lost on every save.
  referral_source: text("referral_source"),
  // [quote-dropped-columns 2026-07-27] These five were referenced by the routes
  // (POST insert via `as any`, PATCH allowed-list) and sent by the quote-builder
  // buildPayload, but were ABSENT from the drizzle table — so drizzle silently
  // dropped them on every insert/update and getQuoteWithDetails never returned
  // them, exactly like the referral_source bug fixed in #1293. Same class of bug.
  unit_suite: text("unit_suite"),
  address_verified: boolean("address_verified").default(false),
  photo_urls: jsonb("photo_urls").default([]),
  alternate_options: jsonb("alternate_options"),
  zone_override: boolean("zone_override").default(false),
});

export const insertQuoteSchema = createInsertSchema(quotesTable).omit({ id: true, created_at: true });
export type InsertQuote = z.infer<typeof insertQuoteSchema>;
export type Quote = typeof quotesTable.$inferSelect;
