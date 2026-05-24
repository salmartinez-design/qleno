# Payroll Compliance Monitoring — Feature Spec (Deferred)

**Status:** SAVED FOR LATER — to be implemented AFTER the Nicholas Cooper
reconciliation work (engine fix + edit-job modal redesign) lands and is
verified on production.

**Owner:** salmartinez@phes.io
**Estimate:** 6–8 hours focused work
**Target sprint:** Post-reconciliation

---

## Why this exists

Phes operates a commission-based pay structure for cleaning technicians.
Federal and Illinois law require that commission divided by hours worked in
any workweek meet or exceed the applicable minimum wage. Current Illinois
minimum wage is $15.00/hour. Phes's internal floor commitment is $20.00/hour.

MaidCentral doesn't surface alerts when a tech's effective hourly rate
falls below threshold. As Phes migrates to Qleno, this monitoring needs to
be built in.

## What the feature does

For each pay period, for each technician, Qleno calculates:

```
Effective Hourly Rate = Total Gross Wages / Total Hours Worked
```

Where Total Hours Worked = sum of all Job Hours (Clock In to Clock Out)
within the pay period.

If the effective hourly rate falls below configurable thresholds, Qleno
displays an alert in the admin dashboard and queues a notification.

## Configurable thresholds (per tenant)

1. **Legal minimum** (default $15.00/hr — IL minimum wage 2025). Below
   triggers HIGH severity alert.
2. **Internal floor** (default $20.00/hr — Phes's stated floor). Below
   triggers MEDIUM severity alert.

Both editable by tenant **owners** (not regular admins) at
`/admin/settings/payroll-compliance`.

## DB schema additions

**`payroll_compliance_settings`** (one row per tenant):
- id, company_id, legal_minimum_threshold, internal_floor_threshold,
  alert_enabled, created_at, updated_at, updated_by_user_id

**`payroll_compliance_alerts`** (one row per alert per tech per period):
- id, company_id, user_id, pay_period_start, pay_period_end,
  effective_hourly_rate, threshold_breached (enum:
  legal_minimum|internal_floor), severity (high|medium), gross_wages,
  total_hours_worked, alert_status (open|acknowledged|resolved),
  acknowledged_at, acknowledged_by_user_id, resolution_notes, created_at

## Calculation service

`artifacts/api-server/src/lib/payroll-compliance.ts` →
`calculatePayrollCompliance(companyId, payPeriodStart, payPeriodEnd)`

- Fetches active techs for the company
- Computes gross wages + hours per tech
- Compares vs tenant thresholds
- Creates alerts for breaches
- Returns summary: { total_techs, above_all, below_internal,
  below_legal, alerts_created }

**Edge cases:**
- Zero hours → skip (no division by zero)
- Zero wages but positive hours → HIGH severity alert
- Mid-period start/end → use only active days
- Tech on Quality Probation at $20/hr flat → normal calc

**Tenant scoping enforced via company_id throughout.**

## Trigger points

1. Manual: Owner clicks "Run Compliance Check" button on dashboard. Runs
   current open + prior closed period.
2. Pay period close: auto-runs when a period is closed.
3. Scheduled: Monday 6:00 AM tenant local time for the prior week, across
   all tenants with `alert_enabled = true`.

## Admin dashboard sections (`/admin/payroll-compliance`)

1. **Active Alerts** — open alerts; tech name, period, effective rate
   (color-coded), severity badge, Acknowledge / View Details / Mark
   Resolved buttons.
2. **Compliance History** — last 12 months of check runs with summary
   metrics; click row to drill in.
3. **Settings Quick View** — current thresholds + link to full settings.

## Alert workflow

- **Created** → appears in dashboard, in-app notification to all `owner`
  users for the tenant (no email/SMS for V1).
- **Acknowledged** → status updates, timestamp + user recorded, moves to
  secondary "Acknowledged but Open" list.
- **Resolved** → status updates, resolution_notes REQUIRED (e.g., "Topped
  up via ADP supplemental for $24.50"), removed from active list.

## Settings page (`/admin/settings/payroll-compliance`)

Editable (owner only):
- legal_minimum_threshold (decimal, > 0)
- internal_floor_threshold (decimal, > legal_minimum)
- alert_enabled (toggle)

Display only:
- Last check timestamp, next scheduled, total alerts last 30 days, link
  to history.

Save behavior:
- Audit log entry on every change (old/new value, user, timestamp)
- Toast on save

## Access control

- `owner` → can edit thresholds, view dashboard, acknowledge, resolve
- `admin` → can view dashboard, acknowledge, resolve; cannot edit thresholds
- `technician` → 403 on any access
- All endpoints enforce tenant scoping via company_id

## API endpoints (`artifacts/api-server/src/routes/payroll-compliance.ts`)

- `GET    /api/payroll-compliance/settings`
- `PATCH  /api/payroll-compliance/settings` (owner only)
- `GET    /api/payroll-compliance/alerts` (active)
- `GET    /api/payroll-compliance/alerts/history` (filterable)
- `POST   /api/payroll-compliance/alerts/:id/acknowledge`
- `POST   /api/payroll-compliance/alerts/:id/resolve` (notes required)
- `POST   /api/payroll-compliance/run-check` (owner only, manual trigger)
- `GET    /api/payroll-compliance/summary` (dashboard widget)

## Tests required

**Unit (`artifacts/api-server/test/payroll-compliance.test.ts`):**
- effective rate calc — multiple inputs
- alert creation logic
- tenant scoping (no cross-tenant alerts)
- edge cases (zero hours, zero wages, mid-period)
- threshold comparison (>= vs >)

**Integration (`artifacts/api-server/test/integration/payroll-compliance-flow.test.ts`):**
- end-to-end: create tenant, employees, period data, run check, verify
  alerts
- cross-tenant isolation
- acknowledge flow
- resolution flow (requires notes)
- settings persistence
- manual trigger covers current + prior period
- scheduled trigger respects `alert_enabled`

**Frontend:**
- dashboard renders alerts
- acknowledge updates status
- resolve requires notes
- settings editable for owner, read-only for admin, 403 for technician

## Docs

`docs/payroll-compliance.md` — see spec for full contents (purpose, how
it works, configurable thresholds, trigger points, alert workflow, what
to do when an alert fires, legal context, privacy / tenant isolation).

## Verification checklist (for Sal before merge)

- [ ] Migration creates both tables
- [ ] Default Phes settings row created ($15 / $20)
- [ ] Dashboard renders for owner
- [ ] Manual "Run Compliance Check" button works
- [ ] Settings page editable by owner only, 403 for non-owner
- [ ] Acknowledge + Resolve workflows update correctly
- [ ] Resolution requires non-empty notes
- [ ] Tenant isolation (test with a second tenant)
- [ ] All endpoints enforce role + tenant scoping
- [ ] Audit log entries on settings changes
- [ ] `docs/payroll-compliance.md` committed
- [ ] Tests pass in CI

## Branch + PR

- Branch: `feature/qleno-payroll-compliance-monitoring`
- PR title: `feature: payroll compliance monitoring with configurable minimum wage thresholds`
- Description: feature overview + legal rationale, summary of components,
  verification checklist, "multi-tenant SaaS capable" note.
- Sequential cadence: do not merge until Sal verifies on production.

## OUT OF SCOPE for V1

- ADP / payroll-system integration (alerts are informational; actual
  payroll adjustments happen outside Qleno)
- Email or SMS notifications (in-app only V1)
- Predictive analytics / trend forecasting (point-in-time only)
- Automatic top-up calculation
- Multi-state minimum wage per tenant (single threshold per tenant)
- Historical backfill before deploy
- MaidCentral compliance data migration
- Modifying existing LMS modules
- Handbook / compensation policy changes

## Future enhancements (note in PR description)

- Email / SMS notifications
- Trend analysis ("Tech X within 5% of legal min for 3 weeks")
- Auto top-up suggestion ("Top up $X.XX to clear threshold")
- ADP integration for one-click top-up
- Per-tech configurable thresholds
- State-specific defaults (IL $15, CA $16, etc.)
- Compliance report export for accountant / attorney
- Mobile push for owners

---

**Order of operations (from Sal):**
1. ~~Finish Nicholas Cooper reconciliation work (engine fix + modal redesign)~~ — CURRENT SPRINT
2. LMS audit + MaidCentral module rewrite — separate prompt, Sal will resend
3. THIS spec — payroll compliance feature
