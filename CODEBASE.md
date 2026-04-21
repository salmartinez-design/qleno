# Qleno — Codebase Reference Snapshot
Generated: March 24, 2026 | App: Qleno

---

## Monorepo Structure

```
workspace/
├── artifacts/
│   ├── qleno/          @workspace/qleno — React 18 + Vite frontend
│   └── api-server/            @workspace/api-server — Express 5 API
├── lib/
│   └── db/                    @workspace/db — Drizzle ORM + PostgreSQL schema
├── replit.md                  Live architecture reference
└── CODEBASE.md                This file
```

---

## Design System

- **Font:** `'Plus Jakarta Sans', sans-serif` — exclusively
- **Brand color:** `#00C9A0` (Electric Mint)
- **Dark background:** `#0A0E1A`
- **Base background:** `#F7F6F3`
- **Card background:** `#FFFFFF`
- **Border:** `#E5E2DC`
- **Text primary:** `#1A1917` | **Text secondary:** `#6B7280` | **Muted:** `#9E9B94`
- No emojis. No dark mode. No Tailwind in page files — pages use inline `style={{}}`.
- Brand components: `QlenoMark` and `QlenoLogo` in `artifacts/qleno/src/components/brand/`

---

## Database Schema (`lib/db/src/schema/`)

42 schema files. All major tables include `company_id` for tenant isolation.

### Core Operational Tables
| Table | File | Key Fields |
|---|---|---|
| `companies` | `companies.ts` | `brand_color`, `geofence_enabled`, `geofence_clockin_radius_ft` (500), `geofence_clockout_radius_ft` (1000), `geofence_soft_mode`, `geofence_override_allowed`, `default_payment_terms_residential`, `default_payment_terms_commercial` |
| `users` | `users.ts` | `role` (owner/admin/office/technician), `pay_rate`, `commission_rate_override`, `hr_status`, `leave_balance_hours`, `leave_balance_activated`, `benefit_year_start` |
| `clients` | `clients.ts` | `client_type` enum(residential/commercial), `billing_contact_name/email/phone`, `po_number_required`, `default_po_number`, `payment_terms` enum(due_on_receipt/net_15/net_30), `auto_charge`, `card_last_four`, `stripe_customer_id` |
| `jobs` | `jobs.ts` | Standard job fields + `zone_id` |
| `invoices` | `invoices.ts` | `payment_terms`, `status` (draft/sent/paid/overdue/cancelled) |
| `timeclock` | `timeclock.ts` | `clock_in_outside_geofence`, `clock_out_outside_geofence` |
| `clock_in_attempts` | (in timeclock.ts) | `radius_ft`, `distance_ft`, `is_override`, `override_reason` |

### HR Policy Tables (7 new — Sprint 5+)
| Table | File |
|---|---|
| `company_pay_policy` | `hr_policies.ts` |
| `company_attendance_policy` | `hr_policies.ts` |
| `company_leave_policy` | `hr_policies.ts` |
| `employee_attendance_log` | `hr_logs.ts` |
| `employee_discipline_log` | `hr_logs.ts` |
| `quality_complaints` | `hr_logs.ts` |
| `employee_leave_usage` | `hr_logs.ts` |

### Scheduling & Client Relations
| Table | File |
|---|---|
| `recurring_schedules` | `recurring_schedules.ts` — frequency enum (weekly/biweekly/triweekly/monthly/every_4_weeks) |
| `cancellation_log` | `cancellation_log.ts` — cancel_reason enum, rescheduled_to_job_id |
| `communication_log` | `communication_log.ts` — comm_direction (inbound/outbound), comm_channel (phone/email/sms/in_person/other) |
| `service_zones` | `service_zones.ts` — zip_codes text[], color |
| `service_zone_employees` | `service_zone_employees.ts` |

### Business Intelligence
| Table | File |
|---|---|
| `satisfaction_surveys` | `satisfaction_surveys.ts` — nps_score, rating, token, sent_at (30-day throttle), suppressed |
| `incentive_programs` | `incentive_programs.ts` |
| `incentive_earned` | `incentive_earned.ts` — approval_status, budget tracking |
| `churn_scores` | `churn_scores.ts` |
| `tech_retention_snapshots` | `tech_retention_snapshots.ts` |
| `scorecards` | `scorecards.ts` |
| `daily_summaries` | `daily_summaries.ts` |

### Payments & Agreements
| Table | File |
|---|---|
| `payment_links` | `payment_links.ts` — token, expires_at, card saved flag |
| `payments` | `payments.ts` |
| `agreement_templates` | `agreement_templates.ts` |
| `client_agreements` | `client_agreements.ts` — SHA-256 e-sign |

### Other
`discounts`, `quotes`, `quote_scopes`, `add_ons`, `job_add_ons`, `job_photos`, `job_status_logs`, `job_supplies`, `supply_items`, `route_sequences`, `property_groups`, `loyalty`, `messages`, `form_templates`, `form_submissions`, `articles`, `notification_templates`, `client_notifications`, `client_attachments`, `client_homes`, `client_ratings`, `contact_tickets`, `waitlist`, `additional_pay`, `audit_log`, `app_audit_log`, `employee_notes`, `availability`, `technician_preferences`

---

## API Routes (`artifacts/api-server/src/routes/`)

50 route files. All use `requireAuth` before data access. Public-only exceptions: `health`, `/survey/:token`, `/public/:token` (payment links), `sign` (e-sign token), `portal` (portal auth).

### Auth Pattern
```typescript
// Always requireAuth before requireRole
router.get("/", requireAuth, requireRole("owner", "admin"), handler);
// Access: req.auth!.companyId, req.auth!.userId
// No Zod — manual validation only
```

### HR Routes (5 files added)
| Route | File | Endpoints |
|---|---|---|
| `/api/policy/*` | `policy.ts` | GET/PUT pay, attendance, leave (auto-creates on first read) |
| `/api/hr-attendance` | `hr-attendance.ts` | GET list, POST log event, GET today summary, POST threshold check (auto-disciplines) |
| `/api/hr-discipline` | `hr-discipline.ts` | GET list, POST create, POST confirm (owner), POST dismiss |
| `/api/hr-leave` | `hr-leave.ts` | GET balance, POST deduct, POST activate eligibility |
| `/api/hr-quality` | `hr-quality.ts` | GET list, POST complaint, POST validate/invalidate (auto-probation) |

### Smart Dispatch
```
POST /api/jobs/suggest-tech
Body: { date, start_time, end_time, zip_code }
Returns: up to 5 ranked techs with tier (1–4), zone info, availability
```

### Key Operational Routes
- `GET/POST /api/clients` — with client_type filtering
- `GET/POST /api/jobs` — with uninvoiced filter
- `POST /api/jobs/:id/complete` — sets status only, **does NOT create invoice**
- `POST /api/timeclock/clock-in` — full GPS geofencing (Haversine, 500ft radius)
- `POST /api/timeclock/clock-out` — 1000ft radius
- `GET/POST /api/zones` — zip-based service zones
- `POST /api/satisfaction/send` — with 30-day throttle
- `POST /api/satisfaction/respond` — public, no auth
- `GET /api/satisfaction/results` — NPS stats (promoters/detractors/avg)
- `GET/POST /api/communication-log` — client comm logging
- `POST /api/payment-links` — create secure token link
- `GET /api/payment-links/public/:token` — public card-on-file page (Stripe-gated)
- `POST /api/payment-links/public/:token/save-card` — save card (Stripe-gated)
- `GET /api/dashboard/kpis` — avg_bill, revenue, job counts, HR alerts
- `GET /api/reports/*` — 14+ report endpoints

---

## Frontend Pages (`artifacts/qleno/src/pages/`)

### Core Operations
| File | Lines | Notes |
|---|---|---|
| `dashboard.tsx` | — | KPIs, status tiles, HR Alerts widget, Close Day trigger |
| `jobs.tsx` | 897 | Dispatch Gantt, cancel modal, zone color dots |
| `my-jobs.tsx` | 617 | Mobile-optimized tech view, GPS clock-in |
| `clock-monitor.tsx` | — | Owner/admin clock status view |
| `employees.tsx` | — | Employee list (pre-existing TS errors — do not touch) |
| `employee-profile.tsx` | — | 15 tabs total |
| `employee-profile-hr-tabs.tsx` | — | 4 HR tabs: HR Attendance, Leave Balance, Discipline, Quality |
| `customers.tsx` | — | Client list |
| `customer-profile.tsx` | — | Tabs: Overview, Recurring, Comm Log, Jobs, Invoices |
| `invoices.tsx` | — | Invoice list, batch drawer |
| `invoice-detail.tsx` | — | Detail with charge/send actions |
| `payroll.tsx` | — | Payroll calculation (no Close Week) |

### Job Creation
| File | Notes |
|---|---|
| `components/job-wizard.tsx` | 3-step wizard. Step 3 has **Smart Dispatch panel**: auto-fetches from `/api/jobs/suggest-tech`, shows ranked techs with tier badge, zone dot, availability text, Assign button |

### Settings & Configuration
| File | Notes |
|---|---|
| `company.tsx` | Company settings tabs |
| `company/hr-policies.tsx` | 4 HR accordions + persistent non-dismissible legal disclaimer |
| `zones.tsx` | Service zone management |

### Quotes & Agreements
`quotes.tsx`, `quote-builder.tsx`, `quote-detail.tsx`, `quoting.tsx`, `agreement-builder.tsx`, `sign.tsx`

### Reports (21 pages in `reports/`)
`insights`, `revenue`, `receivables`, `job-costing`, `payroll-to-revenue`, `payroll`, `efficiency`, `employee-stats`, `tips`, `week-review`, `satisfaction`, `scorecards`, `incentives`, `referrals`, `revenue-goal`, `cancellations`, `first-time`, `hot-sheet`, `contact-tickets`, `churn`, `retention`

### Public Pages
| File | Route | Notes |
|---|---|---|
| `pay.tsx` | `/pay/:token` | Card-on-file flow (Stripe-gated) |
| `survey.tsx` | `/survey/:token` | NPS survey response |
| `sign.tsx` | `/sign/:token` | Agreement e-sign |

### Admin (`admin/`)
`index.tsx`, `companies.tsx`, `billing.tsx`, `cleancyclopedia.tsx` — super admin only

### Portal (`portal/`)
`dashboard.tsx`, `login.tsx` — basic shell, full scope not verified

### Other
`cleancyclopedia.tsx` (120 lines, English-only static content — no Spanish), `discounts.tsx`, `loyalty.tsx`, `route-sequences.tsx`, `property-groups.tsx`, `forms.tsx`, `reports/`, `intelligence/`

---

## What Is NOT Built

| Missing Feature | Impact |
|---|---|
| **Square integration** | PHES cannot process any client payments |
| **Close Week / Payroll Lock** | Cannot finalize payroll period |
| **Auto-invoice on job completion** | Job complete only sets status — no invoice created, auto-charge never fires |
| **Multi-branch / location model** | PHES cannot manage Oak Lawn + Schaumburg under one login |
| **Stripe Connect** | Evinco cannot route payments to their bank |
| **Tenant-type UI gating** | No commercial/residential conditional rendering on any screen |
| **Commercial KPIs** | avg contract value, jobs/account, on-time rate — not designed |
| **Bilingual Cleancyclopedia** | Spanish content absent |
| **Reschedule UI** | Cancel exists, reschedule link not built |
| **Client-facing Support Center** | Admin article CRUD exists, no tenant browser page |
| **Mobile PWA** | Not started (Sprint 18) |
| **SMS via Twilio** | Route exists, keys not configured |

---

## PHES Seeded Configuration

- **Mileage:** $0.70/mile (2025 IRS rate), job-to-job only, 30-day submission deadline
- **Pay:** 35% commission, $20 floor, 3-hr minimum, $18 training rate
- **Quality:** 2 complaints in 30 days → probation
- **Attendance:** 10-min grace, 4-step tardy progression, 3-step absence, NCNS on
- **Leave:** 40hr Paid Sick Leave, front-loaded, 90-day eligibility, anniversary reset
- **Holidays (2026):** 6 federal holidays seeded

---

## Logins

| Role | Email | Password |
|---|---|---|
| Super Admin | `sal@qlenopro.com` | `SalQleno2026!` |
| PHES Owner | `salmartinez@phes.io` | `Avaseb2024$` |
