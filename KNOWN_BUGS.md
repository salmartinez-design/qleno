# Known Bugs

## RESOLVED — Tech reassignment didn't persist (2026-04-27, AI.1)

**Status:** Fixed in commit AI.1.

**Symptoms (production):**
- Open an unassigned job (e.g., CJ Jimenez · Standard Clean) in the dispatch
  drawer → click Add Team Member → pick Guadalupe Mejia → save → toast
  "Team member added" → reopen the job → reverts to Unassigned.

**Root cause:** Two bugs compounded on the drawer's `addTechToJob` path:
1. `POST /api/jobs/:id/technicians` referenced `drizzleSql` which was
   undefined at module scope (only some sibling handlers had local
   `const { sql: drizzleSql } = await import("drizzle-orm")` shims). The
   handler threw `ReferenceError` at runtime → returned 500 → toast still
   said "Team member added" because the catch only handles thrown
   exceptions in the promise chain, not non-2xx responses.
2. Even if the handler had worked, it never updated `jobs.assigned_user_id`.
   The dispatch grid reads `jobs.assigned_user_id` (not `job_technicians`),
   so the chip would have stayed in the Unassigned row regardless.

**Fix:**
- Replaced all `drizzleSql` references in `routes/jobs.ts` with `sql` (the
  actual module-top import name). Removed the now-redundant local shims.
  Also fixes `calculateTechPay` and several other handlers that had the
  same broken reference.
- POST handler now promotes the new tech to primary when no current primary
  exists, AND mirrors `jobs.assigned_user_id`. Drawer's `addTechToJob`
  passes `is_primary: true` explicitly when the job is unassigned.
- DELETE handler now promotes the next remaining tech on primary removal
  and mirrors (NULL when none remain).
- Both handlers write a `job_audit_log` row (`field_name='tech_assigned'`
  or `'tech_removed'`) with full before/after state.
- Added invariant note in CLAUDE.md so future code can't regress.

---

## RESOLVED — Recurring schedule edit modal missing AI frequency options (2026-04-27, AI.1)

**Status:** Fixed in commit AI.1.

**Symptom:** The Recurring section of the client profile (`ServiceDetailsSection`
in `customer-profile.tsx`) had a hard-coded frequency dropdown that never
got the AI multi-day options (daily/weekdays/custom_days). Operators editing
a recurring schedule from the client profile saw only the standard 5 options.

**Fix:** New shared `FREQ_OPTIONS_STANDARD` + `FREQ_OPTIONS_COMMERCIAL_MULTI`
arrays. Dropdown now uses `<optgroup>` with the commercial group rendered
only when `client.client_type === 'commercial' || client.account_id != null`
— same broadening as the job edit modal. `FREQ_LABELS` extended with daily,
weekdays, custom_days for downstream display.

(The dead `RecurringTab` component at line 1870 is unused and was left
alone — it doesn't render anywhere in the current UI.)

---

## RESOLVED — Job edit modal Frequency dropdown — defensive broadening (2026-04-27, AI.1)

**Status:** Fixed in commit AI.1.

**Symptom:** Job edit modal showed only standard 5 options for Jaira Estrada.
The AI optgroup code was correct; root cause was that Jaira's
`clients.client_type` may have been `'residential'` from MC import (the
PHES commercial-clients-stored-as-residential issue documented above).

**Fix (defensive):** `isCommercial` detection in `edit-job-modal.tsx` is now
`clientType === 'commercial' || job.account_id != null`. Aligned with how
`dispatch.ts:290` already determines commercial. Jobs flagged commercial by
either signal get the commercial UI fork. If Jaira's `client_type` is still
`'residential'` in the DB but her job has an `account_id`, the modal now
shows the commercial group correctly.

**Action item still pending (data, not code):** verify Jaira's
`clients.client_type` and `clients.account_id` values via Railway DB shell.
If both are residential / null, neither code signal will fire and her data
needs cleanup. SQL to inspect:
```sql
SELECT id, first_name, last_name, client_type, account_id
FROM clients
WHERE company_id = 1 AND first_name ILIKE 'jaira%';
```

---

## Add Client button does nothing (2026-04-18)

**Severity:** High (blocks new client onboarding via UI)

**Reproduction:**
1. Log into Qleno as any tenant owner
2. Navigate to Clients page
3. Click "+ Add Client" button
4. Nothing happens — URL changes to /customers/new, blank page renders

**Root cause:**
- `artifacts/qleno/src/pages/customers.tsx:141-151` — onClick navigates to `/customers/new`
- No `/customers/new` route registered in `App.tsx` (only `/customers` and `/customers/:id`)
- No `NewClientModal` / `AddClientModal` / `ClientForm` component exists in the codebase
- Wouter matches wildcard `/customers/:id` with `id = "new"` → `parseInt("new") = NaN` → `clientId = 0` → all queries disabled via `enabled: clientId > 0`
- Same bug affects Shift+C keyboard shortcut at `components/keyboard-shortcuts.tsx:13`

**Workaround (2026-04-18):**
4 missing clients (Cianan Lesley + 3 commercial) added via direct SQL INSERT during Prompt 4 preparation.

**Proper fix (estimated 20–30 min):**
- Build `<NewClientModal>` component with fields: first_name, last_name, company_name, address, city, state, zip, phone, email, client_type, branch_id
- Wire to `POST /api/clients` endpoint (verify endpoint exists or build it)
- Toggle modal from local state on `customers.tsx` instead of navigating
- Fix keyboard shortcut in `components/keyboard-shortcuts.tsx:13` to open the same modal

**Priority:** Should be fixed before Railway env var `RECURRING_ENGINE_ENABLED=false` is set and before first outside tenant onboards.

---

## Schema smell — commercial clients stored in first_name (2026-04-18)

All commercial clients have company name in `first_name`, `last_name=""`, `company_name=NULL`.
The `company_name` column exists but is unused. Name matcher treats company names
and person names identically because of this. Future refactor needed to populate
`company_name` correctly and update UI/queries.

**Affected rows:** All ~80+ commercial clients (e.g. KMA Ashland, KMA Eggleston, Caravel Health,
Technology Resource Experts LLC, WR ASSET ADMIN INC, plus the 3 added 2026-04-18).

**Risks:**
- UI that queries `WHERE company_name IS NOT NULL` finds zero commercial clients
- Sorting by `last_name` surfaces commercials first (empty strings sort first)
- Future export to QuickBooks / Stripe may require the proper column layout
- Name matching conflates residential "First Last" with commercial company names

**Proper fix:**
- Backfill `company_name` from `first_name` for all rows with `client_type='commercial'`
- Set `first_name=''`, `last_name=''` for commercial rows (or populate from billing_contact_name)
- Update any UI/query that reads `first_name + last_name` to check `client_type` and fall back to `company_name`
- Update name matcher to check both fields when matching source rows

---

## At-risk clients query uses jobs.status='complete' (2026-04-18)
Query in dashboard/churn detection uses EXISTS clause checking for
completed jobs in the `jobs` table. After Prompt 4.5, completed jobs
live in `job_history` instead. Query will under-count at-risk clients
until refactored to check job_history.

Location: `artifacts/api-server/src/routes/dashboard.ts` — at-risk EXISTS/NOT EXISTS
subquery inside the `/kpis` handler.

Fix approach: change first EXISTS to `job_history` (has completed_job history);
change NOT EXISTS to union of `jobs` (future scheduled) + `job_history`
(last 45d completed).

---

## Caravel Health has 3 duplicate client records (2026-04-18)
- id 26: Arianna Goose (residential)
- id 1264: Caravel Health (commercial, last_name="")
- id 1287: Caravel Health (commercial, last_name="Health")
Prompt 4.5 uses id 26 for historical reconciliation.
Duplicates should be consolidated in post-cutover client dedup pass.

---

## QB connection pending for PHES production (2026-04-23, AF)

**Severity:** Low (not a cutover blocker)

PHES's `companies.qb_connected=false` and tokens are null in dev/staging.
AF shipped the Mark Complete → `syncInvoice()` path fire-and-forget; on
the null-token branch it silently no-ops (returns before queueing). That
is the correct design for disconnected tenants.

**Before relying on QB for real invoices in production:**
1. Connect QB via `/company/integrations/quickbooks/connect` (owner/admin)
2. Complete the first couple manual `syncCustomer` pushes to prime
   `qb_customer_map` for active clients
3. Fire Mark Complete on one low-stakes job and verify a `qb_sync_queue`
   row appears (either `status='success'` or `status='failed'` with
   `last_error` populated)
4. Check the QB-side Invoices ledger for the new entry

Until this lives: every completion on PHES writes a Qleno-native draft
invoice (invoices table) but the QB push is a no-op. That's recoverable
— once connected, you can bulk backfill via the existing `syncAll()`
endpoint / cron.

---

## syncInvoice() has no observability on the null-token no-op path (2026-04-23, AF)

**Severity:** Low (housekeeping)

`quickbooks-sync.ts` functions follow this pattern:
```ts
const auth = await getValidToken(companyId);
if (!auth) return;  // silent no-op
```

This is correct for disconnected tenants, but silent — zero trace in
logs, zero row in `qb_sync_queue`. If the null-token path is ever
reached for a tenant that SHOULD be connected (e.g. token refresh
failed upstream, `qb_connected` not set correctly, etc.), we'd have
no telemetry.

**Fix (post-cutover housekeeping pass):**
Add a single-line debug log on the no-op branch:
```ts
if (!auth) {
  console.debug(`[QB] syncInvoice no-op: company ${companyId} not connected`);
  return;
}
```
Same for `syncCustomer` and `syncPayment`. Keep it debug-level so it
doesn't noise up prod logs, but available via log filter when
diagnosing "why isn't QB syncing?" questions.

---

## service_zones missing UNIQUE (company_id, name) constraint (2026-04-23)

**Severity:** Low (workaround exists; decide post-cutover)

Per CLAUDE.md "Seed files must always use ON CONFLICT DO UPDATE — never
plain INSERT," any seed/upsert of service_zones rows needs a unique
constraint on `(company_id, name)` to make ON CONFLICT work. Only
constraint today is `PRIMARY KEY (id)`. During the AE North Shore zone
add (2026-04-23) we worked around with `WHERE NOT EXISTS` in the INSERT
body — functional, idempotent, but drifts from the seed-discipline rule.

**Fix (post-cutover):**
```sql
ALTER TABLE service_zones
  ADD CONSTRAINT service_zones_company_name_uniq UNIQUE (company_id, name);
```
Pre-check for any dupe rows first (see next entry — Tinley/Orland Park).

---

## service_zones duplicate: "Tinley/Orland Park" vs "Tinley/Orlando/Palos Park" (2026-04-23, confirmed again)

Two near-identical rows for the same physical zone:

| id | name | color | zip_codes | sort_order |
|---:|---|---|---|---:|
| 26 | **Tinley/Orlando/Palos Park** (active) | `#FFD700` | 9 zips | 0 |
| 21 | **Tinley/Orland Park/Palos Park** (empty) | `#FFD700` | `[]` | 17 |

id 21 is the original mis-spelled row with empty zips; id 26 is the
working one (same color, actual zip coverage). Both flagged is_active=true.

Re-confirmed during AE audit on 2026-04-23. Still present.

**Fix (pre any unique-constraint addition):**
```sql
-- Verify no foreign keys point at id 21 first (clients.zone_id, jobs.zone_id)
SELECT COUNT(*) FROM clients WHERE zone_id = 21;
SELECT COUNT(*) FROM jobs    WHERE zone_id = 21;
-- If zero, safe to:
DELETE FROM service_zones WHERE id = 21;
```
If any FK points at id 21, re-point to id 26 before delete.

---

## Source file has unencoded HTML entities (2026-04-18)

**Severity:** Low (blocks 1 client match; trivial fix in ingest script)

MaidCentral exports contain literal HTML entities in some names (`&amp;` instead of `&`).
Example: `Weiss-Kunz &amp; Oliver LLC` in `Job_Campaign_-_Phes__1_.xlsx`.

**Impact:** Name matcher in `scripts/migration/preflight-job-history.ts` doesn't decode entities,
so `Weiss-Kunz &amp; Oliver LLC` (source) ≠ `Weiss-Kunz & Oliver LLC` (clients table).

**Fix:** Add HTML entity decoding to `normalizeName()` or run source rows through a decoder
before matching. One-line change:
```typescript
s = s.replace(/&amp;/gi, "&").replace(/&#?[a-z0-9]+;/gi, ""); // or use he/entities lib
```

---

## AH commercial-pricing — three parallel models in the codebase (2026-04-27)

**Severity:** Low — not blocking; design debt

AH ships per-client commercial hourly rates via `clients.commercial_hourly_rate`.
This makes the codebase have **three** parallel commercial-pricing models that
should eventually be consolidated:

1. **`clients.commercial_hourly_rate`** (NEW, AH) — per-client hourly rate.
   Used for single-location commercial clients like Jaira Estrada at
   National Able Network. The edit-job modal reads this when
   `client_type='commercial'`. Mirror column on
   `recurring_schedules.commercial_hourly_rate` cascades to spawned jobs.
2. **`accounts` + `account_rate_cards`** — per-account hourly rates,
   per-service-type. The "right" model for multi-property accounts (e.g.
   Daniel Walter PPM, KMA, Cucci). PHES doesn't currently use this
   (commercial clients live in `clients` with company name jammed into
   `first_name`).
3. **`pricing_scopes` (e.g. Commercial Cleaning)** — tenant-wide hourly
   rate. The pricing engine still reads from here for residential hourly
   scopes and for any client without a personal rate set.

**When to consolidate:** when PHES (or any tenant) onboards a true
multi-location commercial account, model #2 becomes necessary. At that
point, migrate model #1 → model #2: synthesize an `accounts` row per
existing commercial client (or a shared "PHES Commercial" account) and
move `commercial_hourly_rate` → `account_rate_cards.rate_amount`.

**Won't fix (intentionally):** the spec smell where `clients.first_name`
holds company names is left alone — see "Schema smell — commercial
clients stored in first_name" entry above. Backfill into `accounts` is
a separate project.
Apply this BEFORE the existing normalization steps so all downstream logic sees clean strings.

---

## AI day-of-week storage inconsistency (2026-04-27)

**Severity:** Low — design debt; both formats work; no operational impact

`recurring_schedules` now stores day-of-week in two parallel formats depending
on the frequency type:

- **`day_of_week`** (`recurring_day` enum: `monday | tuesday | ... | sunday`)
  used by `weekly`, `biweekly`, `every_3_weeks`, `monthly` schedules. Single
  string value. Original AG / pre-AI storage.
- **`days_of_week`** (`INTEGER[]`, 0=Sunday … 6=Saturday) used by `daily`
  (`[0,1,2,3,4,5,6]`), `weekdays` (`[1,2,3,4,5]`), `custom_days` (any subset).
  Added in AI for multi-day commercial scheduling.

`generateOccurrences()` in `recurring-jobs.ts` branches on which column is
populated. Schedules cannot have both populated simultaneously; the PATCH
endpoint validates this. If both end up set somehow, the engine prefers
`days_of_week` and logs a warning.

**Why two formats:** legacy weekly/biweekly logic uses string day names via
`DAY_NAME_TO_NUM`. Multi-day arrays are int-native because EXTRACT(DOW)
returns an int and array filtering is cleaner. Refactoring the legacy column
to int would touch every weekly/biweekly schedule across all tenants — risky
for no immediate operational benefit.

**Future cleanup pass:**
1. Normalize `day_of_week` → integer (0–6) so both columns match
2. OR collapse into a single `days_of_week INTEGER[]` and migrate weekly
   schedules to single-element arrays
3. Update engine + PATCH endpoint accordingly

Not blocking AJ or AK. Park until there's a quiet sprint.
