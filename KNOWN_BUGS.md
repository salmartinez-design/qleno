# Known Bugs

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
Apply this BEFORE the existing normalization steps so all downstream logic sees clean strings.
