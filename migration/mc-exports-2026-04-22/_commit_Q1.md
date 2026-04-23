# Commit Q1 — Backfill `clients.payment_method` from MC billing_terms consensus

- **Timestamp:** 2026-04-22 CT (America/Chicago)
- **Operator:** Claude Code (Sal approved after constraint-adaptation note)
- **Company:** PHES (company_id=1)
- **Engine flag:** false across all 4 tenants (unchanged)

## Commit-letter note

Sal's prompt called this "P1", but **P** is already taken (`7df6ee5` sidebar consolidation). Renamed **Q1** to preserve monotonic commit-letter history.

## Headline

**264 clients updated** in a single transaction. `clients.payment_method` was uniform `'manual'` across all 1,308 PHES clients before this commit; now the 266 MC-linked clients reflect their MC billing arrangement.

## Constraint-driven mapping adaptation

The dry-run reported the column as plain text, but missed a **CHECK constraint** that restricts values to:

```
CHECK (payment_method = ANY (ARRAY[
  'card_on_file'::text,
  'check'::text,
  'zelle'::text,
  'net_30'::text,
  'manual'::text
]))
```

My originally-proposed values (`credit_card`, `invoice`, `prepaid`) failed this check. Adapted to constraint-compatible values — same semantic intent:

| MC `billing_terms` | Clients | Original proposal | Final value (CHECK-valid) | Rationale |
|---|---:|---|---|---|
| Credit Card | 253 | `credit_card` | **`card_on_file`** | Exact semantic match — client has card stored for charging |
| Invoice | 4 | `invoice` | **`net_30`** | Standard invoicing bucket in allowed set |
| Batch Invoice | 7 | `invoice` | **`net_30`** | Same bucket (invoicing, not per-visit charge) |
| Prepay | 1 | `prepaid` | **`manual`** (no-op) | No allowed value maps to "prepay" — kept as existing default |
| Other | 1 | `manual` (no change) | `manual` (no change) | Unknown payment channel; preserve default |

**Updated count: 264** (Prepay + Other excluded from the filter — both already held `'manual'` and the UPDATE would have been a no-op).

## Execution

```sql
BEGIN;
UPDATE clients c
   SET payment_method = CASE stats.billing_terms
         WHEN 'Credit Card'    THEN 'card_on_file'
         WHEN 'Invoice'        THEN 'net_30'
         WHEN 'Batch Invoice'  THEN 'net_30'
         ELSE c.payment_method
       END
  FROM (
    SELECT DISTINCT ON (mcs.matched_customer_id)
           mcs.matched_customer_id AS customer_id,
           mcs.billing_terms
      FROM mc_dispatch_staging mcs
     WHERE mcs.matched_customer_id IS NOT NULL
       AND mcs.billing_terms IS NOT NULL
     ORDER BY mcs.matched_customer_id, mcs.billing_terms
  ) stats
 WHERE c.id = stats.customer_id
   AND c.company_id = 1
   AND stats.billing_terms IN ('Credit Card', 'Invoice', 'Batch Invoice')
RETURNING c.id, c.first_name, c.last_name, c.payment_method;
-- rowcount: 264 ✓
COMMIT;
```

(Note the earlier attempt ROLLED BACK cleanly on the CHECK-violation — no partial state leaked. This retry succeeded on first attempt with the correct mapping.)

## Post-state distribution

| `clients.payment_method` | Clients | Breakdown |
|---|---:|---|
| `manual` | **1,044** | 1,042 non-MC clients + 2 MC clients (Prepay + Other) |
| `card_on_file` | **253** | MC "Credit Card" |
| `net_30` | **11** | MC "Batch Invoice" (7) + MC "Invoice" (4) |

## MC-linked clients still on `manual` (expected — both had un-mappable MC values)

| id | Client | MC billing_terms |
|---:|---|---|
| 52 | Thriving Lifestyles Counseling Solutions | Prepay |
| 1200 | Nicole Gagliardo | Other |

These can be updated individually if Sal decides on a specific semantic mapping later (e.g., expand the CHECK constraint to allow `prepaid`, then UPDATE these 2 rows).

## Spot-check — top clients match expected MC context

| Client | Q1 payment_method | Matches prior context |
|---|---|---|
| Daniel Walter (id=19, 53 MC jobs) | `card_on_file` | ✓ |
| Chris Cucci (id=24, 40 MC jobs) | `card_on_file` | ✓ G-2 dispatch-authoritative |
| Arianna Goose (id=26, 34 MC jobs) | `card_on_file` | ✓ |
| KMA Property Management (id=20, 33 MC jobs) | `net_30` | ✓ Batch Invoice commercial |
| Jaira Estrada (id=21, 33 MC jobs) | `net_30` | ✓ |
| Heritage Condominium (id=40, 18 MC jobs) | `net_30` | ✓ |
| Tom and Carol Butler (id=22, 15 MC jobs) | `card_on_file` | ✓ |
| Jim Schultz (id=23, 15 MC jobs) | `card_on_file` | ✓ |
| Daveco properties (id=25, 13 MC jobs) | `net_30` | ✓ |
| Bill Azzarello (id=29, 17 MC jobs) | `net_30` | ✓ NULL-fee cohort |

## Rollback

```sql
UPDATE clients
   SET payment_method = 'manual'
 WHERE company_id = 1
   AND payment_method IN ('card_on_file', 'net_30')
   AND id IN (
     SELECT DISTINCT matched_customer_id
       FROM mc_dispatch_staging
      WHERE matched_customer_id IS NOT NULL
   );
-- expect 264 rows
```

Safe — every `card_on_file`/`net_30` value came from this one commit (baseline was 100% `manual`).

## What did NOT change

- `jobs` — no writes
- `job_history` — no writes
- `recurring_schedules` — no writes
- `users` — no writes
- `mc_dispatch_staging` — no writes
- Backend code — no changes
- Frontend code — no changes
- Engine flag — false across all 4 tenants

## Next — Q2

Q2 ships the dispatch endpoint extension + hover card rebuild + `/jobs` → `/reports/jobs` move + Reports index card, all in one commit.

## Commit chain

| SHA | Commit |
|---|---|
| `7df6ee5` | P — sidebar consolidation (Dispatch Board + Jobs → Jobs) |
| (this) | **Q1** — payment_method backfill (264 clients) |
| pending | Q2 — hover card rebuild + endpoint + route move |
