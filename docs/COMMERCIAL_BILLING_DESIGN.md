# Commercial Multi-Day Scheduling & Weekly Invoicing — Design Spec

**Version:** 1.0
**Status:** Locked, ready for implementation
**Sessions covered:** AI (multi-day scheduling), AJ (weekly invoicing), AK (invoice email + polish)
**Author:** Sal Martinez + Claude (design phase Apr 27, 2026)

---

## 1. Problem

PHES has commercial clients with billing models that don't fit the existing residential-per-visit pattern:

- **Multi-day recurring schedules** (Jaira: M–F daily; some clients M/W/F; others daily including weekends)
- **Per-visit hourly billing** with parking fees and variable hours per visit
- **Weekly aggregated invoicing** — customer receives one invoice for the week with daily line items
- **Cancellation fees** with separate customer-billing and tech-payroll concepts
- **Effective-dated rate changes** for transparent rate increases

Current Qleno commercial support (after AH) handles per-visit hourly billing for single-frequency clients (one-time, weekly, biweekly, monthly). It cannot:
- Schedule a recurring job across multiple specific days per week
- Generate weekly aggregated invoices
- Enforce cancellation policies with proper customer + tech payroll splits
- Handle effective-dated rate changes with audit trail

This design covers the full build to close those gaps.

---

## 2. Locked design decisions

### 2.1 Billing week

**Decision:** Sunday through Saturday.

**Rationale:** US business norm. Matches typical accounting cycles. Per-tenant override capability deferred — can be added later if a tenant requests it without breaking schema.

### 2.2 Job-to-invoice attribution

**Decision:** A job appears on the invoice for the week it was *actually completed*, determined by `jobs.status = 'complete'` AND `jobs.completed_at` falling within the billing week's date range.

**Rationale:** Matches B2B service business norms (consulting, accounting, contractors). Aligns with QuickBooks revenue recognition. Survives reschedules cleanly: rescheduled jobs naturally land on whichever week they get completed in. No retroactive credit memos needed for canceled jobs.

**Edge cases handled:**
- Wednesday job rescheduled to next Monday → appears on next week's invoice
- Customer adds a Saturday make-up → appears on the same billing week's invoice
- Partial-hour completion → invoice uses `actual_hours × hourly_rate`

### 2.3 Mid-week cancellation handling

**Decision:** No real-time draft invoice. Invoice is generated end-of-week (Saturday night). Canceled jobs simply never appear on the invoice unless flagged with a cancellation fee.

**Cancel modal structure** (dual section):
- **Customer billing section:**
  - "Cancel without fee" — job doesn't appear on invoice
  - "Cancel with full fee" — appears on invoice as cancellation line item at the configured cancel fee %
- **Tech payroll section:**
  - "No tech pay" — tech earns $0 for this slot
  - "Flat cancellation pay" — tech earns the configured flat amount (PHES default $60)
  - "Percent of job pay" — tech earns a configured % of what they would've earned
- **Cancellation reason** (required, dropdown):
  - `customer_cancel_advance` — Customer canceled with advance notice
  - `customer_cancel_late` — Customer canceled last minute
  - `customer_no_show` — Tech arrived, customer not available
  - `tech_unavailable` — Tech called out / no-show
  - `mechanical` — Vehicle / equipment issue
  - `weather` — Weather-related cancellation
  - `other` — Free-text required if selected

The combination of customer-billing × tech-payroll × reason gives full operational coverage for every realistic cancellation scenario.

### 2.4 Cancellation fee + tech cancel pay storage

**Decision:** Per-tenant default + per-client override. Both customer cancel fee % and tech cancel pay (flat $/% of job).

**Storage:**
- `companies.default_cancel_fee_pct` (numeric, default 100)
- `companies.default_tech_cancel_pay_amount` (numeric, default 60.00)
- `companies.default_tech_cancel_pay_type` (enum: `flat | percent`, default `flat`)
- `clients.cancel_fee_pct_override` (nullable, falls back to company default)
- `clients.tech_cancel_pay_amount_override` (nullable)
- `clients.tech_cancel_pay_type_override` (nullable)

**Snapshotting:** When a cancellation is logged, the resolved fee + tech pay values are *snapshotted onto the job record* (`jobs.cancel_fee_charged`, `jobs.tech_cancel_pay_paid`). Future changes to defaults or client overrides do NOT retroactively change historical cancellations.

### 2.5 Cancellation reason tracking

**Decision:** Reason codes stored on `jobs.cancellation_reason` (enum, see 2.3) with `jobs.cancellation_notes` for free-text context. Required at cancel time. Powers retention and operational reporting later (e.g., "tech_unavailable" rate per technician, "weather" days per quarter).

### 2.6 Hourly rate change handling

**Decision:** Approach 1 + 2 — effective-date rate at client level *plus* per-job override capability.

**Schema:**
- New table: `client_hourly_rate_history`
  - `id`, `client_id`, `hourly_rate NUMERIC(10,2)`, `effective_from DATE`, `created_by_user_id`, `created_at`, `notes TEXT`
- `clients.commercial_hourly_rate` retained as "current effective rate" (denormalized for fast reads)
- `jobs.hourly_rate_override NUMERIC(10,2)` (nullable, AH-existing)
- `jobs.hourly_rate_at_completion NUMERIC(10,2)` (set at completion, snapshots the rate actually used for billing)

**Resolution at job completion:**
1. If `jobs.hourly_rate_override IS NOT NULL` → use override
2. Else look up `client_hourly_rate_history` for the most recent row where `effective_from <= jobs.completed_at::date AND client_id = jobs.client_id` → use that rate
3. Else use `clients.commercial_hourly_rate` (fallback for clients without history)

The resolved value is written to `jobs.hourly_rate_at_completion` and is what the invoice uses. Historical invoices are immutable.

**UI:**
- Client profile rate edit modal asks: "New rate $X effective from [date picker, defaults today]"
- Job edit modal shows the resolved rate + "Override rate" link that exposes manual entry. If overridden, "Reset to client default" link clears the override.

### 2.7 Net 30 terms

**Decision:** Net 30 clock starts on invoice generation date (Saturday for weekly clients, day-of-completion for per-visit clients).

**Rationale:** Industry standard. Stripe, QuickBooks, and every accounting platform use invoice date as day 1.

**Schema:** `invoices.invoice_date` (existing) drives `invoices.due_date = invoice_date + interval '30 days'` for Net 30 terms.

### 2.8 Frequency types

**Decision:** Three new frequency types for commercial scheduling:

- `daily` — every day, Sunday through Saturday
- `weekdays` — Monday through Friday only
- `custom_days` — pick any combination of M/Tu/W/Th/F/Sa/Su via checkboxes

Existing residential frequencies (`one_time`, `weekly`, `biweekly`, `every_3_weeks`, `monthly`) remain unchanged. Note: actual schema enum value is `monthly` (not `every_4_weeks_monthly` — the modal label "Every 4 weeks / Monthly" is just user-facing display).

**Storage:**
- `recurring_schedules.frequency` enum extended with the 3 new values (plus `every_3_weeks` to match `jobs.frequency` and stop falling back to `custom`)
- `recurring_schedules.days_of_week INTEGER[]` (array of 0–6 where 0=Sunday). Used for `custom_days`. For `daily` = [0,1,2,3,4,5,6]. For `weekdays` = [1,2,3,4,5].
- Existing `recurring_schedules.day_of_week` (string enum: monday, tuesday, etc.) retained for backward compat with weekly/biweekly/etc. Only one of `day_of_week` or `days_of_week` is populated per row. Inconsistency between string vs int array storage logged as design debt in KNOWN_BUGS.md, no refactor in AI.

### 2.9 Per-client billing cycle

**Decision:** `clients.billing_cycle` enum: `per_visit | weekly | biweekly | monthly`. Default `per_visit`.

- `per_visit` (default for residential and most commercial): invoice generated immediately on job completion, as today
- `weekly`: jobs aggregated into Saturday end-of-week invoice
- `biweekly`: jobs aggregated into bi-Saturday invoice (every other week, configurable anchor)
- `monthly`: jobs aggregated into last-day-of-month invoice

For AI/AJ/AK only `per_visit` and `weekly` are implemented. `biweekly` and `monthly` are schema-supported (enum values exist) but not yet wired into the invoice generation engine. Clear path to extend later.

---

## 3. Schema changes (full list)

### 3.1 New columns

```sql
-- Billing cycle and rate history
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_cycle TEXT NOT NULL DEFAULT 'per_visit';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS cancel_fee_pct_override NUMERIC(5,2);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tech_cancel_pay_amount_override NUMERIC(10,2);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tech_cancel_pay_type_override TEXT;

-- Company-level cancel defaults
ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_cancel_fee_pct NUMERIC(5,2) NOT NULL DEFAULT 100;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_tech_cancel_pay_amount NUMERIC(10,2) NOT NULL DEFAULT 60.00;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_tech_cancel_pay_type TEXT NOT NULL DEFAULT 'flat';

-- Cancellation tracking on jobs
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancellation_notes TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancel_fee_charged NUMERIC(10,2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tech_cancel_pay_paid NUMERIC(10,2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMP;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS canceled_by_user_id INTEGER REFERENCES users(id);

-- Rate snapshotting
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS hourly_rate_at_completion NUMERIC(10,2);

-- Multi-day scheduling
ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS days_of_week INTEGER[];

-- Weekly invoice tracking
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS billing_period_start DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS billing_period_end DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_type TEXT NOT NULL DEFAULT 'per_visit';
-- invoice_type: 'per_visit' | 'weekly_aggregated' | 'biweekly_aggregated' | 'monthly_aggregated'
```

### 3.2 New tables

```sql
-- Hourly rate history with effective dates
CREATE TABLE IF NOT EXISTS client_hourly_rate_history (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL,
  hourly_rate NUMERIC(10,2) NOT NULL,
  effective_from DATE NOT NULL,
  notes TEXT,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chrh_client_effective ON client_hourly_rate_history(client_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_chrh_company_id ON client_hourly_rate_history(company_id);
```

### 3.3 Enum extensions

Two separate enums need updates (audit confirmed):

```sql
-- jobs.frequency enum
ALTER TYPE frequency ADD VALUE IF NOT EXISTS 'daily';
ALTER TYPE frequency ADD VALUE IF NOT EXISTS 'weekdays';
ALTER TYPE frequency ADD VALUE IF NOT EXISTS 'custom_days';

-- recurring_schedules.frequency enum (recurring_frequency type)
ALTER TYPE recurring_frequency ADD VALUE IF NOT EXISTS 'every_3_weeks';  -- closes AG bug
ALTER TYPE recurring_frequency ADD VALUE IF NOT EXISTS 'daily';
ALTER TYPE recurring_frequency ADD VALUE IF NOT EXISTS 'weekdays';
ALTER TYPE recurring_frequency ADD VALUE IF NOT EXISTS 'custom_days';
```

---

## 4. Implementation phases

### 4.1 AI — Multi-day scheduling

**Scope:**
- Schema migrations: `recurring_schedules.days_of_week`, frequency enum extensions on both `frequency` and `recurring_frequency`, multi-day support in recurring engine
- Recurring engine update: when a recurring schedule has `days_of_week` populated, generate one job per day per week instead of one per week. Also fix the `every_3_weeks` bug (extend `generateOccurrences` to honor `frequency='custom' + custom_frequency_weeks=N` as N-week intervals; fallback to biweekly when null preserves current behavior)
- Edit modal: frequency dropdown gains Daily / Weekdays / Custom days options via `<optgroup>`. Custom days exposes a 7-checkbox picker (Sun–Sat). Commercial-only group.
- Cascade behavior — **hybrid strategy**: UPDATE jobs whose date matches new pattern (preserves tech assignments + instructions), DELETE jobs whose date doesn't match, INSERT new jobs for dates the old pattern didn't cover. Audit log summarizes preserved/dropped/created counts.
- Extend `POST /api/recurring/trigger` with optional `schedule_id` query param for per-schedule dry-run
- Add startup log line printing per-tenant `recurring_engine_enabled` state + env override

**No invoice changes in AI.** Each generated daily job creates its own draft invoice as today (per_visit billing model). Weekly invoicing comes in AJ.

**Acceptance criteria:**
1. Set Jaira to "Weekdays" frequency, save → next 4 weeks have 5 jobs per week (M–F)
2. Set another client to "Custom days" with M/W/F → next 4 weeks have 3 jobs per week on the right days
3. Set a residential client to "Weekly" (existing) → no behavior change, generates 1 job per week on the chosen day
4. Cascade "this and all future" preserves customizations on jobs whose dates still match the new pattern
5. Recurring engine handles holidays / month boundaries / DST transitions correctly
6. Existing `every_3_weeks` schedules generate at 21-day intervals, not 14
7. Startup log shows engine flag state for all 4 tenants

### 4.2 AJ — Weekly invoicing

**Scope:**
- Schema: `clients.billing_cycle`, `invoices.billing_period_start/end`, `invoices.invoice_type`, all cancellation columns, rate history table
- Cancel modal: replace existing single Cancel Job button with the dual-section modal (customer billing + tech payroll + reason)
- Hourly rate history: client profile rate edit becomes effective-date based, history table populated
- Job-to-invoice resolver: at completion, write `jobs.hourly_rate_at_completion` from override > history > current rate
- Weekly invoice generator: cron job runs Saturday night per tenant. For each `client.billing_cycle = 'weekly'`, query completed jobs in Sun–Sat range, build aggregated invoice
- Per-visit invoicing path: unchanged for `client.billing_cycle = 'per_visit'`

**Acceptance criteria:**
1. Saturday night cron runs → Jaira gets one invoice for the week with 5 daily line items + parking + total
2. Mid-week canceled job (with fee) → cancellation appears as line item on Saturday's invoice
3. Mid-week canceled job (without fee) → does not appear on invoice
4. Mid-week rate change effective Wednesday → Mon/Tue billed at old rate, Wed–Fri at new rate, single invoice
5. New client starts mid-week → first Saturday invoice prorates (3 days only)
6. Per-visit residential clients unaffected — invoice on completion as today

### 4.3 AK — Invoice email + polish

**Scope:**
- Weekly invoice email template (HTML + plaintext fallback) with itemized breakdown
- PDF generation for weekly invoice (matching email format)
- Customer portal view of weekly invoices (read-only list with PDF download)
- Net 30 due date display
- Resend integration for sending (gated by `COMMS_ENABLED` per system rules)

**Acceptance criteria:**
1. Email rendering shows correct daily breakdown, totals, parking, taxes if applicable, due date
2. PDF matches email layout, branded with tenant name + colors
3. Sending respects `COMMS_ENABLED` gate
4. Customer portal lists historical weekly invoices with download links
5. QuickBooks sync push includes the aggregated invoice (not the daily jobs as separate entries)

---

## 5. Open questions (resolved)

1. **Holiday handling for daily/weekdays frequencies**: Generate the job (don't auto-skip), but tag with `is_holiday=true` flag. Office cancels with reason="customer_cancel_advance" if customer doesn't want service. Holiday calendar per-tenant configurable later.

2. **DST transitions**: Store `scheduled_time` as wall-clock time in tenant's timezone. Job at "8:00 AM" stays 8:00 AM regardless of DST. Recurring engine respects this.

3. **Mid-week schedule changes that affect this week's already-completed jobs**: Completed jobs are immutable. Only future scheduled jobs follow the new pattern. The cascade prompt from AG already handles this.

4. **Empty invoice handling**: Skip invoice generation entirely for weeks with $0 billable. Log to ops dashboard.

5. **Mid-week billing_cycle change**: Change takes effect at next billing period. Current week completes as weekly aggregated. Following Sunday onward, per_visit applies.

6. **Tech multi-tenant cancel pay**: PHES eats it (it's payroll, not a customer charge). The customer cancel fee % is the customer-side charge; the tech cancel pay is internal payroll. Both are independent.

---

## 6. Migration / rollout plan

1. **AI ships first.** Multi-day scheduling lands. PHES operates Jaira's M–F schedule with each day as a separate job, each generating its own per_visit invoice as today. Manual aggregation if needed for the few weeks until AJ ships.

2. **Backfill Jaira's billing_cycle.** Once AI is stable, set `clients.billing_cycle = 'weekly'` on Jaira. This doesn't change anything yet because AJ isn't deployed.

3. **AJ ships.** Cron generates weekly invoices for all `billing_cycle = 'weekly'` clients on Saturday. Existing per_visit clients unaffected. Old draft per-visit invoices for Jaira from before the cycle switch remain — they were correctly generated as per_visit.

4. **AK ships.** Email + PDF templates go live. Customer portal updated. QB sync wired.

5. **Post-launch monitoring.** Watch the first 2 weekly invoice cycles closely. Verify line items, totals, dates, due dates. Fix bugs in next session.

---

## 7. Out of scope (deferred)

These will be future sessions, not part of AI/AJ/AK:

- **Bi-weekly and monthly invoice aggregation** (schema supports them, generation engine doesn't yet)
- **Tiered cancellation policies** (e.g., 50% fee with 24hr notice, 100% with no notice)
- **Per-tenant billing week override** (defaults to Sunday–Saturday for now)
- **Tax calculation** (taxes per jurisdiction, tax-exempt customers)
- **Statement of account / running balance** (ledger view across multiple invoices)
- **Late fees / interest** (after Net 30 expires)
- **Auto-charge for weekly invoices via Stripe** (for now, weekly invoices are manually paid; auto-charge can be added later)
- **Smart suggestions for "make-up day" reschedules** (still parked from AG)
- **Refactor `day_of_week` string vs `days_of_week` int array storage inconsistency** (logged as design debt)

---

*End of design spec — Apr 27, 2026*
