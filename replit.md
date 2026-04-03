# Qleno

## Overview
Qleno is a multi-tenant SaaS platform designed for residential and commercial cleaning businesses. Its primary purpose is to centralize and streamline critical business operations, including job dispatch, employee and customer management, invoicing, payroll, and HR. The platform aims to enhance efficiency, provide valuable business insights through reporting, and support scalability for cleaning service providers. Key features encompass JWT authentication, a dynamic dispatch board with geofencing capabilities, and comprehensive HR functionalities. Qleno's ambition is to become the leading operational solution in the cleaning industry.

## User Preferences
- **Design System:** STRICT — Do Not Deviate from specified fonts, colors, and UI elements.
- **UI Constraints:** No emojis in the UI; use Lucide icons or plain text. No dark backgrounds on content areas; light theme only, no dark mode.
- **TypeScript Errors:** Do not touch pre-existing TypeScript errors unless specifically asked.
- **HR Policy Rules:** Never reference specific laws by name in the UI. Never auto-populate wage floors or minimum wage. Never auto-detect employee state for compliance. Never auto-generate termination records. A persistent legal disclaimer banner on the HR Policies tab cannot be dismissed. Owner only can view/edit HR Policies and confirm discipline. Owner must annually update the IRS mileage rate, no auto-update.

## System Architecture

**Monorepo Structure:**
- **Frontend:** React 18, Vite, TanStack Query, Wouter routing, inline styles.
- **Backend:** Express 5, Drizzle ORM.
- **Database:** PostgreSQL with Drizzle ORM for schema management.

**Technical Implementations:**
- **Authentication:** JWT with `JWT_SECRET` and bcryptjs for password hashing. `requireAuth` and `requireRole` middleware are used for access control.
- **Validation:** Manual validation is performed within the API server.
- **Multi-tenancy:** All database queries are scoped by `company_id` at the application level.
- **Geofencing:** Utilizes the Haversine formula for distance calculations; Google Maps API is used solely for geocoding.
- **Database Management:** Drizzle ORM handles PostgreSQL schema definitions and migrations.

**UI/UX Design:**
- **Font:** `'Plus Jakarta Sans', sans-serif`.
- **Brand Color:** Electric Mint (`#00C9A0`).
- **Backgrounds:** Base (`#F7F6F3`), Cards (`#FFFFFF`), Borders (`#E5E2DC`).
- **Text Colors:** Primary (`#1A1917`), Secondary (`#6B7280`), Muted (`#9E9B94`).
- **Icons:** Lucide icons.

**Sidebar Navigation (`app-sidebar.tsx`):**
- Collapsed state: 56px wide icon-only rail
- Hover expand: overlays to 220px; main content does NOT shift (sidebar is `position: absolute` inside a `position: relative` 56px wrapper)
- Mobile: full-width slide-in drawer, unchanged
- Leads badge: dot in collapsed mode, count pill in expanded mode

**Customer Profile Page (`/customers/:id`) — 3-Panel, 4-Tab Layout:**
- **Hero Strip** (sticky, full width): breadcrumb, avatar, name, ACTIVE/RECURRING/freq badges, LTV dark box, action buttons, then 4-tab bar
- **Left Stats Panel** (260px, `position: sticky`, `top: 0`, `height: calc(100vh - 64px)`, ALWAYS VISIBLE on all tabs): Client Stats card — Client Since, Last/Next Cleaning (brand color if within 7 days), LTV, Last 12mo, Avg Bill, Total Visits, Pending, Skips, Bumps, eCard Rate, Tech Consistency ("X techs / Y visits")
- **Tab Content Area** (flex: 1, no max-width cap, scrolls independently) — 4 semantic tabs:
  - **CLIENT** (2-col grid): Left — Contact & Basic Info + Billing & Payments + Loyalty Program card (tier badge, points balance, progress bar to next tier, Add Points modal, Set Tier Manually modal, auto-save notes). Right — Invoices table (`BillingTab`) + QuickBooks (`QuickBooksTab`)
  - **PROPERTY** (2-col grid): Left — Service Addresses + Access & Entry (alarm code in yellow warning box) + Client Notes (auto-saves on blur). Right — Recurring Schedule (`ServiceDetailsSection`) + Rate History + Rate Locks (`OverviewTab`) + Home Images (`HomeImagesSection`)
  - **JOBS** (single column, full width): Job History table + Scorecards + Inspections + Communication Log
  - **ADMIN** (2-col grid top + full-width collapsibles): Left — Client Portal + Contacts & Notifications + Referrals card (Log Referral modal, status badges, Mark Reward Paid). Right — Tech Preferences (Do Not Schedule warning) + Contact Tickets + Agreements. Below (collapsed by default) — Quotes + Attachments
- Mobile: compact hero + Next/Visits summary row + horizontally scrollable tab bar + no side stats panel
- Default tab on load: `"client"` — `useState<ProfileTab>("client")`
- Sub-components in `customer-profile.tsx` (lines 1-2999); `PROFILE_TABS` const + `CustomerProfilePage` export at ~line 3000
- `CommLogTab` only accepts `{ clientId: number }` — no other props
- Scroll preservation on customers list via `sessionStorage`

**New tables (created via raw SQL, not drizzle schema):**
- `loyalty_tiers` (id, company_id INTEGER, tier_name, min_visits, min_lifetime_revenue, reward_description, created_at)
- `client_loyalty` (id, client_id INTEGER, company_id INTEGER, tier_id→loyalty_tiers, tier_override TEXT, points_balance, total_points_earned, notes, updated_at)
- `referrals` (id, company_id INTEGER, referrer_client_id INTEGER, referred_name, referred_phone, referred_email, status, reward_issued BOOLEAN, reward_amount, source, notes, created_at, updated_at)

**New API endpoints:**
- `GET /api/clients/:id/loyalty` — returns `{ loyalty, tiers, stats }` (stats = total_visits + lifetime_revenue for tier calculation)
- `PATCH /api/clients/:id/loyalty` — upserts loyalty record (tier_override, tier_id, notes)
- `POST /api/clients/:id/loyalty/points` — adds points to balance
- `GET /api/clients/:id/referrals` — list referrals for client
- `POST /api/clients/:id/referrals` — log new referral (source auto-set to 'manual')
- `PATCH /api/referrals/:id` — update status/reward_issued (in `referrals.ts` route)

**communication_log table** extended with: `source` (staff/system), `sent_by` TEXT, `recipient` TEXT, `subject` TEXT, `body` TEXT, `twilio_message_sid` TEXT, `resend_email_id` TEXT, `delivery_status` TEXT (pending/sent/delivered/undelivered/failed), `opened_at` TIMESTAMPTZ, `clicked_at` TIMESTAMPTZ. New **communication_events** table: (id, communication_log_id→communication_log, event_type, event_data JSONB, occurred_at TIMESTAMPTZ).

**CommLog API (`/api/comms`):**
- `GET /api/comms?customer_id=&filter=&limit=` — filter values: sms, email, phone, in_person, system, staff, inbound, outbound
- `GET /api/comms/:id/events` — event trail for a specific log entry
- `POST /api/comms` — manual staff log entry
- `POST /api/comms/ingest` — internal: auto-log system messages (SMS/email senders); no JWT auth, uses `x-internal-secret` header
- `POST /api/comms/sms/status` — Twilio delivery status webhook (updates delivery_status, inserts event)
- `POST /api/comms/email/webhook` — Resend delivery webhook (updates delivery_status, opened_at, clicked_at, inserts event)

**CommLog2 UI component** (`customer-profile-tabs2.tsx`): Full communication log card in CLIENT tab right column (below QuickBooks). Detail view (default) shows colored-border cards by channel/direction; List view shows sortable table. Features: filter dropdown, pagination, expandable event trail, collapsible manual log form. CommLogTab removed from JOBS tab.

**leads table:** All columns present — `status`, `city`, `state`, `zip`, `source`, `scope`, `bedrooms`, `bathrooms`, `notes`, `quote_amount`, `assigned_to`, `updated_at`, `quoted_at`, `contacted_at`, `booked_at`, `closed_reason`, `agreement_signed`, `job_id`

**Core Functionality & Feature Specifications:**
- **Comprehensive Management:** KPI dashboard, dispatch board, employee, customer, and account management.
- **Financial Tools:** Invoice generation, payroll processing, and quote management.
- **Scheduling & Dispatch:** GPS geofencing, service zone management, smart dispatch algorithms, and recurring job scheduling.
- **Communication:** Integrated communication logging.
- **HR Module:** Configurable HR policies for pay, attendance, and leave, with logging for attendance, discipline, and quality complaints.
- **Security:** Rate limiting and audit logging.
- **Client Interaction:** Agreement builder with e-sign, client portal, and a public booking widget.
- **Reporting:** Comprehensive reporting capabilities.
- **Commercial Accounts:** Dedicated API and UI supporting account-specific rate cards, properties, contacts, and consolidated invoicing.
- **Public Booking Widget:** A 6-step, no-authentication widget for booking services, supporting live pricing calculations and brand color injection.
- **Pricing Engine:** Supports `sqft`, `hourly`, and `simplified` pricing methods with a quote builder that fetches scopes, frequencies, and addons from a pricing API. Includes dynamic upsells and bundle discounts.
- **Document Management:** Full system with templates, e-signatures, and public pages for onboarding and document signing.
- **Mileage Reimbursement:** Employees can submit mileage requests which are then approved by owners/admins.
- **Lead Management:** Full lead pipeline with `leads` table, `lead_activity_log`, and `abandoned_bookings` tracking. Frontend provides a dedicated leads page with filtering, search, and detail drawers.

## External Dependencies

**Configured:**
- `DATABASE_URL` (PostgreSQL)
- `JWT_SECRET` (for authentication)
- Cloudflare R2 (`CLOUDFLARE_R2_ACCESS_KEY`, `CLOUDFLARE_R2_SECRET_KEY` for storage)
- `GITHUB_PERSONAL_ACCESS_TOKEN`
- Twilio (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` for SMS communications)

**Not Configured (Features Blocked):**
- Stripe (payments)
- Resend (emails)
- Google Maps API (address geocoding)
- Square (payment processing)