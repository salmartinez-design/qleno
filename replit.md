# Qleno (formerly CleanOps Pro)

## Overview

Qleno is a multi-tenant SaaS platform for residential and commercial cleaning businesses.
Primary tenants being onboarded: **PHES Cleaning LLC** (Oak Lawn + Schaumburg, IL — residential)
and **Evinco Services** (commercial only).

**App name:** Qleno
**Brand components:** `QlenoMark` and `QlenoLogo` in `artifacts/cleanops-pro/src/components/brand/`
**Super admin login:** `sal@cleanopspro.com` / `SalCleanOps2026!`
**PHES owner login:** `salmartinez@phes.io` / `Avaseb2024$`

---

## Design System (STRICT — Do Not Deviate)

- **Font:** `'Plus Jakarta Sans', sans-serif` only. FORBIDDEN: Playfair Display, DM Mono, Inter, Roboto.
- **Brand color:** `#00C9A0` (Electric Mint). Dark background: `#0A0E1A`.
- **Background:** `#F7F6F3` (base), `#FFFFFF` (cards), `#E5E2DC` (borders).
- **Text:** `#1A1917` (primary), `#6B7280` (secondary), `#9E9B94` (muted).
- **No emojis anywhere in the UI.** Use Lucide icons or plain text only.
- **No dark backgrounds on content areas.**
- **Light theme only** — no dark mode.

---

## Architecture

**Monorepo:** pnpm workspaces

| Package | Path | Purpose |
|---|---|---|
| `@workspace/cleanops-pro` | `artifacts/cleanops-pro` | React 18 + Vite frontend |
| `@workspace/api-server` | `artifacts/api-server` | Express 5 API |
| `@workspace/db` | `lib/db` | Drizzle ORM + PostgreSQL schema |

**Frontend stack:** React 18, Vite, TanStack Query, Wouter routing, inline styles (NOT Tailwind in practice — pages use `style={{}}` with the design system constants)
**Backend stack:** Express 5, Drizzle ORM, PostgreSQL (DATABASE_URL)
**Auth:** JWT (`JWT_SECRET`), bcryptjs. Pattern: `requireAuth` always before `requireRole`. `req.auth!.companyId` and `req.auth!.userId`.
**Validation:** Manual validation in api-server. **No Zod in api-server routes.**
**Multi-tenancy:** Application-level `company_id` scoping on every query. No Supabase RLS policies in place.
**Geofencing:** Haversine formula built-in. **Google Maps API is NOT used for geofencing** — only for potential future geocoding.
**DB push command:** `cd lib/db && pnpm run push-force`

---

## Pre-existing TypeScript Errors (Do Not Touch Unless Asked)

- `chat-panel.tsx`
- `close-day-modal.tsx`
- `global-search.tsx`
- `employees.tsx`

---

## API Key Status

**Configured (in Replit Secrets):**
`DATABASE_URL`, `JWT_SECRET`, `CLOUDFLARE_R2_ACCESS_KEY`, `CLOUDFLARE_R2_SECRET_KEY`, `GITHUB_PERSONAL_ACCESS_TOKEN`

**NOT configured (features blocked):**
- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_CLIENT_ID` → all Stripe payment flows blocked
- `RESEND_API_KEY` → invoice emails, satisfaction survey emails blocked
- `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER` → SMS notifications blocked
- `GOOGLE_MAPS_API_KEY` → address geocoding (geofencing itself works without it)
- `SQUARE_APPLICATION_ID`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID` → ALL PHES payment processing blocked

---

## Database Schema Files (`lib/db/src/schema/`)

| File | Tables |
|---|---|
| `companies.ts` | `companies` (brand_color, geofence config, payment terms defaults) |
| `users.ts` | `users` (role, pay_rate, commission_rate_override, hr_status, leave_balance_hours) |
| `clients.ts` | `clients` (client_type enum residential/commercial, billing_contact_*, po_number_required, payment_terms, auto_charge, card_last_four, account_id FK) |
| `jobs.ts` | `jobs` (billing_method text, hourly_rate, estimated_hours, billed_hours, billed_amount, charge_attempted_at/succeeded_at/failed_at, charge_failure_reason) |
| `accounts.ts` | `accounts` (account_type: property_management/commercial_office/retail/other; payment_method: card_on_file/check/ach/invoice_only; auto_charge_on_completion, stripe/square_customer_id) |
| `account_rate_cards.ts` | `account_rate_cards` (billing_method: hourly/flat_rate/per_unit, service_type, rate_amount, unit_label, notes) |
| `account_properties.ts` | `account_properties` (property_type: apartment_building/condo/common_area/office/retail/other, city/state/zip, default_service_type, access_notes) |
| `account_contacts.ts` | `account_contacts` (role adds property_manager, receives_receipts, receives_on_way_sms, is_primary, notes) |
| `invoices.ts` | `invoices` (payment_terms) |
| `timeclock.ts` | `timeclock`, `clock_in_attempts` (geofence flags, radius_ft) |
| `service_zones.ts` | `service_zones` (zip_codes array, color) |
| `service_zone_employees.ts` | `service_zone_employees` |
| `recurring_schedules.ts` | `recurring_schedules` (frequency enum, day_of_week enum) |
| `cancellation_log.ts` | `cancellation_log` (cancel_reason enum, rescheduled_to_job_id) |
| `communication_log.ts` | `communication_log` (comm_direction, comm_channel enums) |
| `hr_policies.ts` | `company_pay_policy`, `company_attendance_policy`, `company_leave_policy` |
| `hr_logs.ts` | `employee_attendance_log`, `employee_discipline_log`, `quality_complaints`, `employee_leave_usage` |
| `satisfaction_surveys.ts` | `satisfaction_surveys` (nps_score, rating, token, 30-day throttle) |
| `incentive_programs.ts` | `incentive_programs` |
| `incentive_earned.ts` | `incentive_earned` (approval workflow, budget cap) |
| `churn_scores.ts` | `churn_scores` |
| `tech_retention_snapshots.ts` | `tech_retention_snapshots` |
| `payment_links.ts` | `payment_links` (token-based secure card-on-file flow) |
| `agreement_templates.ts` | `agreement_templates`, `client_agreements` (SHA-256 e-sign) |
| `quotes.ts` | `quotes` |
| `quote_scopes.ts` | `quote_scopes` |
| `discounts.ts` | `discounts` |
| `route_sequences.ts` | `route_sequences` |
| `property_groups.ts` | `property_groups` |
| `articles.ts` | `articles` (support center — admin CRUD only, no client-facing page) |
| `messages.ts` | `messages` (team chat) |
| `form_templates.ts` | `form_templates`, `form_submissions` |
| `audit_log.ts`, `app_audit_log.ts` | Audit logging |
| `daily_summaries.ts` | Daily job summaries |
| `scorecards.ts` | Employee scorecards |
| `waitlist.ts` | Zone waitlist |

---

## API Routes (`artifacts/api-server/src/routes/`)

All routes registered in `index.ts`. Full list:

`auth`, `admin`, `companies`, `users`, `clients`, `jobs`, `invoices`, `payroll`, `timeclock`, `dashboard`, `discounts`, `zones`, `dispatch`, `recurring`, `cancellation`, `communication-log`, `close-day`, `quotes`, `quote-scopes`, `reports`, `satisfaction`, `incentives`, `churn`, `retention`, `payment-links`, `payments`, `billing`, `policy`, `hr-attendance`, `hr-discipline`, `hr-leave`, `hr-quality`, `agreement-templates`, `sign`, `form-templates`, `notifications`, `messages`, `portal`, `search`, `addons`, `attachments`, `employee-extended`, `job-sms`, `loyalty`, `property-groups`, `route-sequences`, `scorecards`, `supplies`, `revenue-goal`, `health`, `accounts`

**accounts routes (commercial architecture):**
- `GET /api/accounts` — list with stats (revenue_mtd, revenue_12m, outstanding_balance, open_jobs, active_properties) per account
- `GET /api/accounts/:id` — detail with nested rate_cards[], properties[], contacts[], stats{}
- `POST /api/accounts` — create account
- `PATCH /api/accounts/:id` — update (includes auto_charge_on_completion, stripe/square_customer_id)
- `DELETE /api/accounts/:id` — soft delete
- `GET /api/accounts/:id/rate-cards` — list, with ?service_type= filter
- `GET /api/accounts/:id/rates/lookup?service_type=` — rate auto-fill for job wizard
- `POST/PATCH/DELETE /api/accounts/:id/rate-cards/:cardId`
- `GET/POST/PATCH/DELETE /api/accounts/:id/properties/:propId` — property CRUD (city/state/zip/access_notes)
- `GET/POST/PATCH/DELETE /api/accounts/:id/contacts/:contactId` — contact CRUD (is_primary, receives_receipts/on_way_sms)
- `GET /api/accounts/:id/uninvoiced-jobs` — completed jobs without sent/paid invoices
- `POST /api/accounts/:id/generate-invoice` — create consolidated invoice (?preview=true for dry run)
- `POST /api/accounts/:id/charge` — initiate payment on outstanding invoices
- `GET /api/accounts/:id/payment-status` — summary of paid/outstanding invoices

**HR routes (5 new):**
- `GET/PUT /api/policy/pay` — company pay policy (auto-creates on first read)
- `GET/PUT /api/policy/attendance` — attendance policy
- `GET/PUT /api/policy/leave` — leave policy
- `GET/POST /api/hr-attendance` — attendance log, today summary, history, threshold checker (auto-disciplines)
- `GET/POST /api/hr-discipline` — progressive discipline records, owner confirm/dismiss
- `GET/POST /api/hr-leave` — leave balance, deduct hours, activate eligibility
- `GET/POST /api/hr-quality` — complaint log, validate/invalidate, auto-triggers probation

---

## Frontend Pages (`artifacts/cleanops-pro/src/pages/`)

| Page | Notes |
|---|---|
| `dashboard.tsx` | KPIs, job status tiles, HR Alerts widget, Close Day button |
| `jobs.tsx` | Dispatch board (Gantt), cancel modal, zone color dots |
| `job-wizard.tsx` (component) | 3-step wizard; **Smart Dispatch panel in Step 3** |
| `employees.tsx` | Employee list |
| `employee-profile.tsx` | 15 tabs including 4 HR tabs |
| `employee-profile-hr-tabs.tsx` | HR Attendance, Leave Balance, Discipline, Quality tabs |
| `customers.tsx` | Client list |
| `customer-profile.tsx` | Tabs: Overview, Recurring, Comm Log, Jobs, Invoices, etc. |
| `accounts.tsx` | Commercial accounts list with summary bar (Revenue MTD, Outstanding, Open Jobs, Properties), type filter, active/inactive toggle, per-account stats |
| `account-detail.tsx` | 5-tab commercial account detail: Overview (billing settings + activity), Properties (city/state/zip/access_notes/units), Rate Cards (service/billing_method/rate table with PATCH), Contacts (is_primary, notification prefs), Uninvoiced Jobs (with Generate Invoice button) |
| `invoices.tsx` | Invoice list, batch drawer |
| `invoice-detail.tsx` | Invoice detail with charge/send actions |
| `payroll.tsx` | Payroll calculation (no Close Week lock) |
| `my-jobs.tsx` | Mobile-optimized tech job list with GPS clock-in |
| `clock-monitor.tsx` | Clock-in/out monitoring for owner/admin |
| `cleancyclopedia.tsx` | Training library — English-only static content (120 lines) |
| `zones.tsx` | Service zones management |
| `quotes.tsx`, `quote-builder.tsx`, `quote-detail.tsx` | Quote management |
| `discounts.tsx` | Discount code management |
| `company.tsx` | Company settings (General, Geofencing, HR Policies tabs) |
| `company/hr-policies.tsx` | HR Policies tab (4 accordions + persistent legal disclaimer) |
| `pay.tsx` | Public `/pay/:token` card-on-file page |
| `survey.tsx` | Public `/survey/:token` NPS survey page |
| `agreement-builder.tsx`, `sign.tsx` | Agreement creation and e-sign |
| `route-sequences.tsx` | Route sequencing |
| `property-groups.tsx` | Property groups |
| `loyalty.tsx` | Loyalty programs |
| `reports/` | 21 report pages: insights, revenue, receivables, job-costing, payroll-to-revenue, payroll, efficiency, employee-stats, tips, week-review, satisfaction, scorecards, incentives, referrals, revenue-goal, cancellations, first-time, hot-sheet, contact-tickets, churn, retention |
| `admin/` | Super admin: index, companies, billing, cleancyclopedia (article CRUD) |
| `portal/` | Client portal: dashboard, login (basic shell) |

---

## Feature Status Summary

### CONFIRMED BUILT AND WORKING
- Multi-tenant JWT auth with company_id scoping
- Dashboard with KPIs (avg_bill, job counts, revenue) and HR Alerts widget
- Dispatch board (Gantt, drag/drop, zone color dots, clock status)
- Employee management (15-tab profile including 4 HR tabs)
- Customer management with Recurring, Comm Log, Jobs, Invoices tabs
- Invoice creation, send, overdue detection, batch invoicing, charge-now (Stripe-gated)
- Payroll calculation
- GPS geofencing: 500ft clock-in, 1000ft clock-out, soft mode, override, violations
- Service Zones: zip-based, color-coded, dispatch integration, employee assignment
- Smart Dispatch suggestion (API + UI in job-wizard.tsx Step 3)
- Recurring job schedules (schema, API, customer profile tab)
- Cancel job with cancellation_log (cancel modal in dispatch)
- Client communication log (Comm Log tab, phone/email/SMS/note/in-person)
- Incentive + bonus tracking (full CRUD, approval workflow, budget cap)
- Satisfaction surveys + NPS (send, respond, 30-day throttle, reports)
- HR Policy Configuration: 7 tables, 5 route files, HR Policies tab, 4 employee HR tabs, PHES seeded
- Close Day flow (modal + API)
- Quote Tool (scopes, live preview, list, builder, detail)
- Security hardening (rate limiting, audit logging, env validation)
- Agreement builder + e-sign (SHA-256)
- Route sequences, property groups, loyalty, discounts
- Payment links schema + public /pay/:token page (Stripe-gated)
- Churn scoring (calculate + reports)
- Retention snapshots (calculate + reports)
- 21 reports pages
- Super Admin portal (companies, billing, article CRUD)
- Qleno brand (QlenoMark, QlenoLogo components)

### PARTIALLY BUILT
- Recurring dispatch board badge — frequency field in DispatchJob interface but no "R badge" rendered in UI
- Reschedule flow — cancel confirmed, reschedule link/UI not found
- Cleancyclopedia — UI exists, English-only static content, no Spanish, no DB-backed articles
- Client portal — shell exists (login + dashboard pages), full scope not verified
- Support Center client-facing page — admin article CRUD exists, no tenant-facing browser

### NOT BUILT
- **Square payment integration** — no SDK calls anywhere, PHES cannot collect payment
- **Close Week / Payroll Lock** — no week-closing or payroll lock flow
- **Auto-invoice on job completion** — job complete only sets status, no invoice created
- **Multi-branch support** — no branch/location model in schema
- **Stripe Connect** — not implemented (only Stripe for Qleno SaaS billing)
- **Tenant-type UI gating** — no commercial vs residential conditional rendering
- **Commercial KPIs** — avg contract value, jobs/account, on-time rate not built
- SMS notifications (Twilio routes exist, keys not configured)
- Mobile PWA (Sprint 18, not started)
- Client portal full scope

---

## HR Policy Rules (Legal Compliance)

- **Never** reference specific laws (FLSA, NLRA, FMLA, etc.) by name in UI
- **Never** auto-populate wage floors or minimum wage
- **Never** auto-detect employee state for compliance
- **Never** auto-generate termination records
- Persistent legal disclaimer banner on HR Policies tab — **cannot be dismissed**
- HR role access: View/edit HR Policies = owner only (admin view); Log attendance/leave = owner, admin, office; Confirm discipline = owner only
- IRS mileage rate seeded at $0.70/mile (2025 rate) — owner must update annually, no auto-update

## PHES Seeded Defaults

- Mileage: $0.70/mile, job-to-job only, 30-day submission deadline
- Pay: 35% commission, $20 floor, 3-hr minimum, $18 training rate
- Quality probation: 2 complaints in 30 days
- Attendance: 10-min grace, 4-step tardy progression, 3-step absence progression, NCNS policy on
- Leave: 40hr Paid Sick Leave, front-loaded, 90-day eligibility, work-anniversary reset
- Holidays: 6 federal holidays (2026)
