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
- **Document Templates + eSign:** Full document management system with templates, signatures, and requests. Includes a template editor, employee onboarding packet functionality, and client agreement signing. Public pages for `/onboard/:token` and `/sign-doc/:token`.
- **Mileage Reimbursement:** `mileage_requests` table with `mileage` as an additional pay type. Employees can submit requests via the My Jobs page, which are then approved/denied by owners/admins.
- **API Routes:** A comprehensive set of API routes covering authentication, user management, payroll, dispatch, HR, document management, and mileage requests.

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