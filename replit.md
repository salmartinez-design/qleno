# Qleno

## Overview
Qleno is a multi-tenant SaaS platform for residential and commercial cleaning businesses, providing tools for job dispatch, employee and customer management, invoicing, payroll, and HR. Its purpose is to streamline operations, improve efficiency, and offer business insights through reporting. Key features include JWT authentication, a dynamic dispatch board with geofencing, and robust HR functionalities. The platform aims to be the leading operational solution for cleaning businesses, enabling scalability and service optimization.

## User Preferences
- **Design System:** STRICT — Do Not Deviate from specified fonts, colors, and UI elements.
- **UI Constraints:** No emojis in the UI; use Lucide icons or plain text. No dark backgrounds on content areas; light theme only, no dark mode.
- **TypeScript Errors:** Do not touch pre-existing TypeScript errors unless specifically asked.
- **HR Policy Rules:** Never reference specific laws by name in the UI. Never auto-populate wage floors or minimum wage. Never auto-detect employee state for compliance. Never auto-generate termination records. A persistent legal disclaimer banner on the HR Policies tab cannot be dismissed. Owner only can view/edit HR Policies and confirm discipline. Owner must annually update the IRS mileage rate, no auto-update.

## System Architecture

**Monorepo Structure:**
- **Frontend:** `@workspace/cleanops-pro` (React 18, Vite, TanStack Query, Wouter routing, inline styles).
- **Backend:** `@workspace/api-server` (Express 5, Drizzle ORM).
- **Database:** `@workspace/db` (Drizzle ORM, PostgreSQL schema).

**Technical Implementations:**
- **Auth:** JWT (`JWT_SECRET`), bcryptjs for authentication with `requireAuth` and `requireRole` middleware.
- **Validation:** Manual validation in the API server.
- **Multi-tenancy:** Application-level `company_id` scoping for all database queries.
- **Geofencing:** Utilizes the Haversine formula; Google Maps API is used for geocoding, not geofencing.
- **Database Management:** Drizzle ORM for PostgreSQL schema and migrations.

**UI/UX Design:**
- **Font:** `'Plus Jakarta Sans', sans-serif`.
- **Brand Color:** `#00C9A0` (Electric Mint).
- **Backgrounds:** `#F7F6F3` (base), `#FFFFFF` (cards), `#E5E2DC` (borders).
- **Text Colors:** `#1A1917` (primary), `#6B7280` (secondary), `#9E9B94` (muted).
- **Icons:** Lucide icons.

**Client Profile Page (`/customers/:id`):**
- **2-zone viewport-filling layout** using `fullBleed` DashboardLayout prop
- Zone 1: Hero section (breadcrumb + `ProfileHero` component with 4 action buttons)
- Zone 2: Left 300px column (ClientDetailsPanel + ClientIntelligencePanel stacked, + VerticalSectionNav) + Right flex column (Details/Job History tabs)
- Hero buttons: Schedule Job → `/dispatch?client_id=`, Send Message → `SendMessageDrawer`, Create Invoice → `/clients/:id/invoices`, Edit Profile → `EditProfileDrawer`
- `SendMessageDrawer`: SMS/Email tabs, uses Twilio via `/api/clients/:id/communications/sms`
- `EditProfileDrawer`: Full profile field editor, calls `PUT /api/clients/:id`
- `ServiceDetailsSection`: Inline edit form for service fields + recurring schedule, saves to both `/api/clients/:id` and `PATCH /api/clients/:id/recurring-schedule`
- `HomeImagesSection`: Fetches job photos via `GET /api/clients/:id/job-photos`, groups by job with before/after badge labels
- `Toast`: Fixed-position bottom-right, auto-dismisses in 3.5s, success/error variants
- Mobile responsive: stacked layout with horizontal scroll section chips

**Feature Specifications & System Design Choices:**
- **Core Functionality:** Multi-tenant JWT auth, KPI dashboard, dispatch board, employee/customer/account management, invoice generation, payroll, GPS geofencing, service zone management, smart dispatch, recurring job scheduling, communication logging, HR policy configuration, quote tool, security hardening (rate limiting, audit logging), agreement builder with e-sign, client portal, public booking widget, and comprehensive reporting.
- **Commercial Account Architecture:** Dedicated API and UI for commercial accounts, supporting account-specific rate cards, properties, contacts, and consolidated invoicing.
- **HR Module:** Configurable HR policies for pay, attendance, and leave, with logging for attendance, discipline, and quality complaints.
- **Public Booking Widget:** A 6-step no-authentication widget at `/book/:tenantSlug` for contact, service scope, frequency/addons, date, payment, and confirmation. It injects brand color from company records and uses `/api/public/calculate` for live pricing.
- **Pricing Engine Integration:** Quote Builder (`/quotes/new`) fetches scopes, frequencies, and addons from a pricing API, using `/api/pricing/calculate` for live pricing with a 300ms debounce. Supports `sqft`, `hourly`, and `simplified` pricing methods. Addons are grouped by type, with specific rendering for `time_only` and `manual_adj` types.
- **Booking Widget (`/book/:slug`):** Public multi-step widget (5 steps + confirmation). Residential path: Contact → Scope (+ Home Details incl. home condition question) → Frequency → Date → Payment → Confirmed. Commercial path: Contact → Scope (+ Commercial Option Cards: Single Visit $180 or Walkthrough) → Date → Confirmed (skips Frequency + Payment for walkthrough). Home condition question (1=Very Clean / 2=Moderately Clean / 3=Very Dirty) shown only for Deep Clean, One-Time Standard, and Recurring scopes. "3 — Very Dirty" applies 1.08 multiplier to estimated total live; stored in `home_condition_rating` and `condition_multiplier` on jobs table. Commercial walkthrough POSTs to `/api/public/book/walkthrough` (no Stripe, sends Resend email to info@phes.io). Commercial single visit POSTs to `/api/public/book/commercial-confirm` ($180 flat). Backend uses `scopeNameToServiceType()` mapper to convert scope names to job `service_type` enum values.
- **Rate Lock & Offer Settings:** `rate_locks` table (company_id, client_id, recurring_schedule_id, locked_rate, cadence, lock_start_date, lock_expires_at, active, void_reason, voided_at, renewal_alert_30_sent) and `offer_settings` table (company_id UNIQUE, overrun_threshold_percent, overrun_jobs_trigger, service_gap_days, rate_lock_duration_months, renewal_alert_days) are in the Drizzle schema. Both tables are created by `drizzle-kit push --force` and also by a startup `runBookingSchemaGuard()` function in phes-data-migration.ts that runs each ALTER TABLE / CREATE TABLE statement with individual try/catch.
- **Jobs Booking Columns:** The `jobs` table has extra booking-widget columns in the Drizzle schema: `home_condition_rating`, `condition_multiplier`, `applied_bundle_id`, `bundle_discount_total`, `last_cleaned_response`, `last_cleaned_flag`, `overage_disclaimer_acknowledged`, `overage_rate`, `upsell_shown`, `upsell_accepted`, `upsell_declined`, `upsell_deferred`, `upsell_cadence_selected`, `property_vacant`, `first_recurring_discounted`, `arrival_window` (TEXT — added via raw ALTER TABLE). All created via push-force and the schema guard.
- **Booking Widget Fixes 8–13 (implemented):** (8) UPSELL_TIERS corrected — weekly=$60/hr, biweekly=$65/hr, monthly=$70/hr applied to each sqft tier's hours value; (9) `cadenceIntervalDays` keys fixed to `weekly/biweekly/monthly` matching `upsellCadence` values (was `every_2_weeks/every_4_weeks`); (10) `SimpleCalendar` auto-advances viewDate to next month when current month has no selectable dates; (11) Morning (9AM–12PM) / Afternoon (12PM–2PM) arrival window pills shown on both deep-clean and recurring calendars — no default, Continue disabled until date + time both selected; (12) `arrival_window` stored on both Job 1 (Deep Clean) and Job 2 (Recurring Start), shown in step 4 summary and step 5 confirmation, included in customer and office confirmation emails, office SMS sent to +17737869902 on every confirm; (13) Recurring calendar min = one cadence interval after deep clean, secondary text below calendar explaining cadence + rate lock.
- **Bundle System:** `addon_bundles` + `addon_bundle_items` tables with full CRUD API at `/api/bundles` (JWT protected). Public endpoint `GET /api/public/bundles/:companyId` returns active, date-valid bundles. Widget detects bundle completion in real time — when all bundled addons are selected: strikethrough pricing on each addon card, green bundle badge ("Appliance Bundle applied — you're saving $20.00"), partial nudge ("Add this to unlock the Appliance Bundle discount") when one bundle item selected. Bundles stored on jobs as `applied_bundle_id` + `bundle_discount_total`. Seeded: "Appliance Bundle" ($10 off each — Oven Cleaning + Refrigerator Cleaning). Admin UI in Company Settings → Pricing → Bundles & Promotions section with full CRUD modal. Widget also: "Most Popular" badges on bundle-linked addon cards, scope-aware persuasion lines above addons, "Add extras now" nudge, no cadence multiplier labels on frequency cards, Loyalty Discount addons hidden from public view.
- **Document Templates + eSign:** Full document management system with templates, signatures, and requests. Includes a template editor, employee onboarding packet functionality, and client agreement signing. Public pages for `/onboard/:token` and `/sign-doc/:token`.
- **Mileage Reimbursement:** `mileage_requests` table with `mileage` as an additional pay type. Employees can submit requests via the My Jobs page, which are then approved/denied by owners/admins.
- **API Routes:** A comprehensive set of API routes covering authentication, user management, payroll, dispatch, HR, document management, and mileage requests.
- **Lead Pipeline:** Full lead management system. DB: `leads` table (20+ columns: source, status, scope, sqft, bedrooms, bathrooms, quote_amount, assigned_to, booked_at, contacted_at, quoted_at, closed_reason, job_id, etc.), `lead_activity_log` (per-lead action history), `abandoned_bookings` (tracks users who started booking but didn't complete). API: `GET/POST /api/leads`, `GET/PATCH/DELETE /api/leads/:id`, `GET/POST /api/leads/:id/activity`, `GET /api/leads/:id/messages`, `GET /api/leads/:id/jobs`, `GET /api/leads/status-counts`. Also `POST /api/public/book/abandon-track` (upserts abandoned booking records). Booking widget auto-creates a `leads` record on successful confirm (source=`booking_widget`, status=`booked`) and deletes the corresponding abandoned_booking. Very-dirty flow (`POST /api/public/leads`) sets source=`very_dirty`, status=`needs_contacted`, sends office SMS+email alert. Frontend: `/leads` page (status filter pills with live counts, search, table with badges, pagination, Add Lead drawer, lead detail drawer with 4 tabs: Overview/Activity/Messages/Jobs). Leads link in sidebar Grow section.

## External Dependencies

**Configured (Replit Secrets):**
- `DATABASE_URL` (PostgreSQL)
- `JWT_SECRET`
- `CLOUDFLARE_R2_ACCESS_KEY`, `CLOUDFLARE_R2_SECRET_KEY` (Cloudflare R2 for storage)
- `GITHUB_PERSONAL_ACCESS_TOKEN`

**Configured (Replit Secrets — additional):**
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (SMS — wired to Send Message drawer on client profile)

**Not Configured (Features Blocked):**
- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_CLIENT_ID` (Stripe payments)
- `RESEND_API_KEY` (Invoice and survey emails)
- `GOOGLE_MAPS_API_KEY` (Address geocoding)
- `SQUARE_APPLICATION_ID`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID` (Square payment processing)