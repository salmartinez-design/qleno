# Commit L3 — Schedule linking + tech parsing + status mapping complete

- **Timestamp:** 2026-04-22 CT (America/Chicago)
- **Operator:** Claude Code (Sal approved)
- **Company:** PHES (company_id=1)
- **Engine flag:** false across all 4 tenants (unchanged)

## Headline

`mc_dispatch_staging` is now fully enriched and ready for Phase 4 merge into `jobs`. All 983 rows have `matched_customer_id`, `parsed_techs`, and `mapped_status` populated. Schedule linking populated on 407 of 731 recurring rows (the rest either lack a matching Qleno schedule or are one-time/on-demand).

Apr 22–30 daily distribution still matches MC to the cent.

## Schema deltas vs prompt

The prompt assumed a few schema shapes that differ in reality:

| Prompt expected | Actual in Qleno | Resolution |
|---|---|---|
| `employees` table | `users` table (role=`technician`) | Used `users`; probed via role filter |
| `recurring_schedules.client_id` | `recurring_schedules.customer_id` | SQL adjusted |
| `jobs.status = 'completed'` enum | `jobs.status = 'complete'` enum | Mapping uses `'complete'` |
| `triweekly` enum value | Not present in `recurring_schedules.frequency` (only weekly/biweekly/monthly/custom) | "Every Three Weeks" → `custom` |
| "Delia Martinez" is a primary tech | **Not in `users` table** at all | Parser treats Delia like `Cleaner` (drop, no tech assignment) |

## Step 3.2 — Schedule linking

MC freq → Qleno freq mapping applied:

```
'Every Week'         → 'weekly'
'Every Two Weeks'    → 'biweekly'
'Every Four Weeks'   → 'monthly'
'Every Three Weeks'  → 'custom'
'Other Recurring'    → 'custom'
'Single'             → NULL (no link — correct by design)
'On Demand'          → NULL (no link — correct by design)
```

For customers with multiple active schedules at the same frequency, picked the earliest-created (`ORDER BY created_at ASC, id ASC`).

### Linking rate per MC frequency

| MC frequency | Rows | Linked | Unlinked |
|---|---:|---:|---:|
| Every Two Weeks | 263 | **170** | 93 |
| Single | 241 | 0 | 241 (by design) |
| Every Week | 201 | **120** | 81 |
| Other Recurring | 146 | **43** | 103 |
| Every Four Weeks | 103 | **65** | 38 |
| Every Three Weeks | 18 | **9** | 9 |
| On Demand | 11 | 0 | 11 (by design) |
| **TOTAL** | **983** | **407** | **576** |

Of 731 recurring-frequency rows, 407 linked (55.7%). 324 rows have recurring MC frequency but no matching Qleno `recurring_schedules` row at the same frequency — these still import into `jobs` with `recurring_schedule_id=NULL`.

### Unlinked-recurring breakdown by frequency

| Frequency | Unlinked rows | Unlinked unique clients |
|---|---:|---:|
| Other Recurring | 103 | 17 |
| Every Two Weeks | 93 | 16 |
| Every Week | 81 | 9 |
| Every Four Weeks | 38 | 11 |
| Every Three Weeks | 9 | 2 |
| **TOTAL** | **324** | (overlap) |

### Top unlinked-recurring customers (informational)

| Customer | MC freq | Rows | Qleno id |
|---|---|---:|---:|
| KMA Property Management | Other Recurring | 25 | 20 |
| Jaira Estrada | Other Recurring | 24 | 21 |
| 4009 West 93rd Place Condo Assoc | Every Week | 18 | 1330 |
| Heritage Condominium | Every Week | 18 | 40 |
| Chris Cucci | Every Week | 17 | 24 |
| Daniel Walter | Other Recurring | 16 | 19 |
| Chris Cucci | Every Two Weeks | 14 | 24 |
| Daniel Walter | Every Week | 9 | 19 |
| Nicholas Cooper | Every Two Weeks | 9 | 38 |
| Chicago Straford Memorial 7th-day Adventist Church | Every Two Weeks | 8 | 31 |
| Chris Cucci | Every Four Weeks | 8 | 24 |
| City Light Church | Every Two Weeks | 8 | 37 |
| Hickory Hills Condominium | Every Two Weeks | 8 | 66 |
| Joe Cusimano | Every Two Weeks | 8 | 36 |
| Joshua Hillian | Every Two Weeks | 8 | 70 |
| KMA Property Management | Every Four Weeks | 8 | 20 |
| Molly Leonard | Every Two Weeks | 7 | 83 |
| Weed Man Lawn Care | Every Week | 7 | 1299 |
| Bernardo Carvalho | Every Two Weeks | 6 | 101 |
| ... | | | |

**Cucci appears at 3 different MC frequencies (17 weekly + 14 biweekly + 8 four-weekly = 39 unlinked).** The Qleno `recurring_schedules` table has no Cucci row (his history was migrated to `job_history` directly via the G-2 decision — DB treats Cucci as dispatch-authoritative with no active recurring schedule). These 39 Cucci rows will import to `jobs` with `recurring_schedule_id=NULL`, which is the correct shape.

**"Other Recurring" has no Qleno freq equivalent** — these 103 rows (17 clients, biggest being KMA Property Management and Jaira Estrada) landed unlinked because the MC category doesn't map cleanly. Leaving `recurring_schedule_id=NULL` is the safe default.

## Step 3.3 — Tech parsing

Parser: greedy longest-match prefix against the known 11-tech roster + `Cleaner` placeholder + `Delia Martinez` (treated as skip — not in Qleno users).

### Tech name → Qleno user id map

| MC name | Qleno user id | Notes |
|---|---:|---|
| Norma Guerrero Puga | 32 | DB is "Norma Puga" — 3-word form matched first |
| Alejandra Cuervo | 41 | |
| Guadalupe Mejia | 40 | |
| Tatiana Merchan | 33 | |
| Juliana Loredo | 42 | |
| Diana Vasquez | 38 | |
| Rosa Gallegos | 36 | |
| Alma Salinas | 39 | |
| Juan Salazar | 43 | |
| Ana Valdez | 34 | |
| Delia Martinez | **—** | Not in users — drop (same as Cleaner) |
| Cleaner | — | Placeholder, drop |

### Parse results

| Tech count in parsed_techs | Rows |
|---:|---:|
| 0 | **39** (28 "Delia Martinez" solo + 11 "Cleaner" solo) |
| 1 | **846** |
| 2 | **86** |
| 3 | **12** |
| **Total** | **983** |
| Unparsed | **0** |
| Total tech-user assignments | **1,054** |

Zero parse failures across 59 unique `team_raw` strings and 983 rows.

## Step 3.4 — Status mapping

```
'Closed'      → 'complete'
'Completed'   → 'complete'
'Pending'     → 'scheduled'
'In Progress' → 'in_progress'
```

(Adjusted from prompt: enum is `'complete'` not `'completed'`.)

| status_raw | mapped_status | Rows |
|---|---|---:|
| Closed | complete | 820 |
| Completed | complete | 89 |
| Pending | scheduled | 72 |
| In Progress | in_progress | 2 |
| **TOTAL** | | **983** |

Zero rows with NULL `mapped_status`.

## Step 3.5 — Final staging integrity

| Field | Rows with value | Completeness |
|---|---:|---:|
| matched_customer_id | 983 | 100% |
| matched_schedule_id | 407 | 41.4% (by design — Single/On-Demand are NULL) |
| parsed_techs (JSONB) | 983 | 100% |
| mapped_status | 983 | 100% |
| scheduled_date | 983 | 100% |
| **All 4 required fields present** | **983 / 983** | **100%** |

Date range: 2026-01-01 → 2026-04-30. Total bill_rate: **$217,533.38**.

### Apr 22–30 reconciliation vs MC ground truth — exact match

| Date | MC jobs | MC $ | Staging jobs | Staging $ |
|---|---:|---:|---:|---:|
| Apr 22 Wed | 12 | $2,238.60 | 12 | $2,238.60 |
| Apr 23 Thu | 14 | $2,900.25 | 14 | $2,900.25 |
| Apr 24 Fri | 11 | $2,401.54 | 11 | $2,401.54 |
| Apr 25 Sat | 4 | $1,062.00 | 4 | $1,062.00 |
| Apr 26 Sun | 0 | $0.00 | 0 | $0.00 |
| Apr 27 Mon | 7 | $1,811.32 | 7 | $1,811.32 |
| Apr 28 Tue | 11 | $2,042.33 | 11 | $2,042.33 |
| Apr 29 Wed | 13 | $2,385.35 | 13 | $2,385.35 |
| Apr 30 Thu | 11 | $2,312.68 | 11 | $2,312.68 |

Values preserved through all 3 L-commits — nothing has disturbed the bill_rate or scheduled_date columns.

## What did NOT change

- `jobs` — still 83 rows, zero engine-generated. Only `mc_job_id` column (added in L1) exists.
- `job_history` — untouched. 4,514 rows / $935,252.
- `recurring_schedules` — untouched. Still has NULL `day_of_week` on 78 of 79 rows.
- `clients` — untouched since L2 (Carol Butler backfill + 6 new ids 1331-1336).
- `users` — untouched.
- Engine flag — `false` across all 4 tenants.
- No code changes.

## Rollback

```sql
-- Undo L3 entirely (restore staging to L2's state):
UPDATE mc_dispatch_staging
   SET matched_schedule_id = NULL,
       parsed_techs = NULL,
       mapped_status = NULL;
```

The L3 fields are isolated from everything else — rollback is a single UPDATE and has no cross-table impact.

## Commit chain

| SHA | Commit | Notes |
|---|---|---|
| `75d11ab` | fix(engine): K — rollback + engine off | DB-only |
| `7079276` | chore(migration): L1 — staging + CSV load | 983 rows in staging |
| `d867398` | chore(migration): L2 — customer matching | 983/983 linked to 266 clients |
| (this) | chore(migration): L3 — schedule+tech+status | Staging fully enriched |

## Next — Phase 4

Phase 4 performs the actual INSERT/UPDATE merge into `jobs`:
1. `INSERT INTO jobs (...) SELECT ... FROM mc_dispatch_staging s ... ON CONFLICT (mc_job_id) DO UPDATE SET ...`
2. For each row: base_fee ← bill_rate, client_id ← matched_customer_id, recurring_schedule_id ← matched_schedule_id, scheduled_date ← scheduled_date, status ← mapped_status, mc_job_id ← mc_job_id
3. Tech assignments: write rows into `job_technicians` where `parsed_techs` non-empty
4. Rowcount gates: expect 983 rows affected on jobs. Any mismatch → rollback.

After Phase 4 commits cleanly, the Dispatch Board will show MC's actual per-day counts (12 Apr 22, 14 Apr 23, etc) — replacing the cluster/gap pattern from the broken engine-generated rows.

## Constraint maintained

- Engine flag **false** across all 4 tenants
- No `jobs` writes (only column added in L1)
- No `job_history` writes
- No `recurring_schedules` writes
- No code changes
- No engine re-enable

---

# Addendum — Commit L3.1: Delia Martinez (former tech) fix

- **Timestamp:** 2026-04-22 CT (Sal confirmed Delia is a former employee)
- **Scope:** Create Delia as `is_active=false` user, re-parse the staging rows that reference her

## D.2 — Delia Martinez user row created

```sql
INSERT INTO users (
  company_id, email, password_hash, role,
  first_name, last_name, is_active, pay_type,
  notes, created_at
) VALUES (
  1,
  'delia.martinez.former@phes.internal',           -- synthetic, no login collision
  'IMPORT_PLACEHOLDER_<16-byte hex>',              -- blocked password (same pattern as L1/import techs)
  'technician',
  'Delia', 'Martinez', false, 'hourly',
  '[mc_import_phase3 2026-04-22 former employee]',
  NOW()
);
```

| Field | Value |
|---|---|
| **user id** | **283** |
| first_name / last_name | Delia / Martinez |
| role | technician |
| is_active | **false** |
| email | `delia.martinez.former@phes.internal` (synthetic `.internal` TLD — no real email collision) |
| password_hash | blocked placeholder — cannot be used to log in |
| pay_type | hourly (matches other tech shape) |
| notes | `[mc_import_phase3 2026-04-22 former employee]` (traceability tag, same pattern as `[mc_import_phase2]` and G-series) |

### Schema notes

`users` has 4 NOT-NULL columns without defaults: `email`, `password_hash`, `first_name`, `last_name`. Other fields (`hr_status`, `overtime_eligible`, `pay_type`, etc.) have defaults — omitted from the INSERT to inherit them. `tags` not set; Delia doesn't need the `['field','technician']` dispatch-visibility tag because she's inactive.

## D.3 — Re-parse Delia-containing rows

The parser roster now includes `{ name: 'Delia Martinez', userId: 283 }`. Re-ran greedy-prefix parsing on every staging row where `team_raw ILIKE '%Delia%'`.

**Correction to prompt's row count estimate**: 38 rows contain "Delia" in `team_raw`, not 33. Breakdown:

| team_raw pattern | Rows | Before → After |
|---|---:|---|
| `Delia Martinez` (solo) | 28 | `[]` → `[283]` |
| `Alejandra Cuervo Delia Martinez` | 3 | `[41]` → `[41, 283]` |
| `Ana Valdez Delia Martinez` | 2 | `[34]` → `[34, 283]` |
| `Delia Martinez Juliana Loredo` | 2 | `[42]` → `[283, 42]` |
| other minor combos | 3 | 1-tech → 2-tech |
| **TOTAL** | **38** | 38 UPDATEs ✓ |

Zero parse failures on any of the 38.

## D.4 — Updated tech distribution

| Tech count | Before L3.1 | After L3.1 | Δ |
|---:|---:|---:|---:|
| 0 | 39 | **11** | −28 (all 28 Delia-solo rows moved to 1-tech) |
| 1 | 846 | **864** | +18 (gained 28 Delia-solos, lost 10 to 2-tech) |
| 2 | 86 | **96** | +10 (paired Delia rows moved from 1-tech to 2-tech) |
| 3 | 12 | 12 | 0 (no Delia 3-tech combos) |
| **Total rows** | 983 | 983 | 0 |
| **Total tech assignments** | 1,054 | **1,092** | **+38** |

The 11 remaining "0 techs" rows are all pure-`Cleaner`. Every Delia row now has at least one tech id.

## Integrity after L3.1

| Field | Rows with value |
|---|---:|
| matched_customer_id | 983 |
| matched_schedule_id | 407 |
| parsed_techs (JSONB) | 983 |
| mapped_status | 983 |
| **All 4 required present** | 983 |

Apr 22–30 distribution unchanged — still exact match to MC.

## What changed vs L3

- `users` gained 1 row (id=283 Delia Martinez, inactive)
- `mc_dispatch_staging` — 38 rows had `parsed_techs` updated
- Nothing else

## Rollback

```sql
-- Revert L3.1 only (leaves L3 state intact)
-- 1) Reset the 38 Delia rows back to their pre-L3.1 parsed_techs
--    (easier: just re-run the L3 parser without Delia in the roster)
-- 2) DELETE FROM users WHERE id = 283;
--    (safe only if Delia has no job_technicians or other FK rows yet; she doesn't in L3.1)
```

## Next

Phase 4 — actual INSERT ... ON CONFLICT (mc_job_id) DO UPDATE into `jobs`, populating `job_technicians` from `parsed_techs`. Delia's 38 historical assignments will land as real rows in `job_technicians` linked to `users.id=283`.
