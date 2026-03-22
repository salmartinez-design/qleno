# Qleno

## Overview
Qleno is a multi-tenant SaaS platform designed for residential and commercial cleaning businesses. It offers a comprehensive suite of tools for managing operations, including job dispatch, employee and customer management, invoicing, payroll, and advanced HR functionalities. The platform aims to streamline business processes, improve efficiency, and provide deep insights through various reporting features. Key capabilities include multi-tenant JWT authentication, a dynamic dispatch board with geofencing, detailed employee and customer profiles, and robust HR policy configurations. The long-term vision is to become the leading operational platform for cleaning businesses, enhancing their ability to scale and optimize their services.

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
- **Auth:** JWT (`JWT_SECRET`), bcryptjs for authentication. Uses `requireAuth` and `requireRole` middleware with `req.auth!.companyId` and `req.auth!.userId` for access control.
- **Validation:** Manual validation in the API server, without Zod in API routes.
- **Multi-tenancy:** Application-level `company_id` scoping applied to all database queries.
- **Geofencing:** Utilizes the Haversine formula; Google Maps API is not used for geofencing but may be used for geocoding.
- **Database Management:** Drizzle ORM for PostgreSQL schema definition and migrations. `cd lib/db && pnpm run push-force` for DB schema updates.

**UI/UX Design:**
- **Font:** `'Plus Jakarta Sans', sans-serif`.
- **Brand Color:** `#00C9A0` (Electric Mint). Dark background: `#0A0E1A`.
- **Backgrounds:** `#F7F6F3` (base), `#FFFFFF` (cards), `#E5E2DC` (borders).
- **Text Colors:** `#1A1917` (primary), `#6B7280` (secondary), `#9E9B94` (muted).
- **Icons:** Lucide icons are used.

**Feature Specifications & System Design Choices:**
- **Core Functionality:** Multi-tenant JWT auth, KPI dashboard, dispatch board with Gantt, employee/customer/account management, invoice generation, payroll calculation, GPS geofencing, service zone management, smart dispatch, recurring job scheduling, cancellation logging, communication logging, incentive tracking, satisfaction surveys, HR policy configuration, close day flow, quote tool, security hardening (rate limiting, audit logging), agreement builder with e-sign, route sequencing, property groups, loyalty programs, discounts, payment links, churn scoring, retention snapshots, comprehensive reporting (21 pages), and a Super Admin portal.
- **Commercial Account Architecture:** Dedicated API routes and UI for commercial accounts, including account-specific rate cards, properties, contacts, and consolidated invoicing.
- **HR Module:** Configurable HR policies for pay, attendance, and leave. Logging for attendance, discipline, leave, and quality complaints.
- **Payments:** Stripe integration for Qleno SaaS billing and customer payments (if API keys are configured). Square payment integration is not built.
- **Notifications:** SMS notifications via Twilio (requires API keys).
- **Client Portal:** Basic shell exists for login and dashboard. Portal link in customer profile uses dynamic company slug (fetched from `/api/companies/me`).
- **Public Booking Widget:** `/book/:tenantSlug` — 6-step no-auth widget (Contact → Scope+Home → Frequency+Addons → Date → Payment → Confirmation). Brand color injected from company record. Live pricing via POST `/api/public/calculate`. Booking creates client + home + job + quote in DB. Rate-limited at 30 req/min per IP.
- **Pricing Engine Integration:** Quote Builder (`/quotes/new`) fetches scopes, frequencies, addons from pricing API and calls POST `/api/pricing/calculate` (200ms debounce) for live pricing. Discount code Apply button re-calls the calculate endpoint. Saved quote includes full price snapshot.
- **Public API routes:** `artifacts/api-server/src/routes/public.ts` — 6 no-auth endpoints: GET `/company/:slug`, `/scopes/:companyId`, `/frequencies/:scopeId`, `/addons/:scopeId`, POST `/calculate`, POST `/book`. Registered at `/api/public/*`.
- **Document Templates + eSign:** Full document management system: `document_templates`, `document_signatures`, `document_requests` tables. Template editor in Company Settings > Documents (rich text + variable insertion). Employee Onboarding tab (send packet, resend, status). Client Agreements tab (template picker, send, resend). Public `/onboard/:token` (multi-doc scroll-gate + signature pad) and `/sign-doc/:token` (single-doc client signing) pages.
- **Mileage Reimbursement:** `mileage_requests` table, `mileage` additionalPay type. Mileage form in My Jobs page (bottom-sheet modal). Owner/admin approve/deny queue in dashboard (MileagePendingBanner). Mileage rate configurable in Company Settings > Payroll.
- **API Routes:** A comprehensive set of API routes are defined, covering all aspects of the application from authentication and user management to specialized features like payroll, dispatch, HR, document templates/requests, and mileage requests.

## External Dependencies

**Configured (Replit Secrets):**
- `DATABASE_URL` (PostgreSQL)
- `JWT_SECRET`
- `CLOUDFLARE_R2_ACCESS_KEY`, `CLOUDFLARE_R2_SECRET_KEY` (Cloudflare R2 for storage)
- `GITHUB_PERSONAL_ACCESS_TOKEN`

**Not Configured (Features Blocked):**
- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_CLIENT_ID` (Stripe payments)
- `RESEND_API_KEY` (Invoice and survey emails)
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (SMS notifications)
- `GOOGLE_MAPS_API_KEY` (Address geocoding)
- `SQUARE_APPLICATION_ID`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID` (Square payment processing)