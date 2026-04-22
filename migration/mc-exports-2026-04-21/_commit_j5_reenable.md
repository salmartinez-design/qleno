# Commit J5 — Controlled engine re-enable for PHES

- **Timestamp:** 2026-04-22 14:47 CT / 19:47 UTC (America/Chicago)
- **Operator:** Claude Code (Sal approved)
- **Company:** PHES (company_id=1)
- **Railway build:** commit `4bdd2f3` (J3 hardening) — verified deployed via presence of `failed_schedules` field in API response
- **Flag state at end:** PHES **true**; Demo / Evinco / Schaumburg **false**

## Headline

The engine fired cleanly under the new J3 defenses. **272 rows inserted, 0 duplicates, 0 zero-fee inserts, 0 failed schedules, 0 lock contention.** The NULL-fee guard fired for all 5 schedules (13 Saguto, 19 Azzarello, 27 Lesley, 78 Butler, 86 Rubio) — including 13 and 19, the two that leaked 50 phantom rows in the overnight 2026-04-22 13:17 UTC incident.

## Pre-flight

| Gate | Value |
|---|---|
| HEAD commit | `4bdd2f3` |
| Engine flags (all 4 tenants) | all **false** |
| PHES baseline jobs | 124 (41 recurring-sourced, 55 future, **0 zero-fee**) |
| Duplicate tuples on `(company_id, recurring_schedule_id, scheduled_date)` | **0** |
| `jobs_recurring_dedupe_idx` (J2 partial unique) | present |
| PHES active schedules | 79 (5 NULL-or-zero base_fee) |

## Step 1 — Dry-run (flag false)

`POST /api/recurring/trigger?dry_run=true` with PHES owner JWT. Dry-run bypasses the tenant flag in engine code (`recurring-jobs.ts:237-245`).

| Field | Value |
|---|---:|
| `dry_run` | true |
| `inserted` | 0 |
| `planned_inserts_total` | **272** |
| `total_schedules_evaluated` | 79 |
| `skipped_null_fee` | **5** |
| `skipped_zero_fee` | 0 |
| `skipped_duplicates` | 13 |
| `total_occurrences_skipped_fee_guard` | 28 |
| `failed_schedules` | **[]** |
| `skipped_due_to_lock` | null (no contention) |

5 NULL-fee schedules exactly as expected:
- 13 Anthony Saguto (monthly)
- 19 Bill Azzarello (weekly)
- 27 Ciana Lesley (monthly)
- 78 Tom and Carol Butler (weekly)
- 86 Yates Rubio (weekly)

All gates pass (planned in [250, 300], null_fee=5, failed=[], no lock contention).

## Step 2 — Live trigger

Route handler at `artifacts/api-server/src/routes/recurring.ts:107` uses `requireAuth` and pulls `companyId` from `req.auth`. The engine itself (`generateRecurringJobs`) enforces the per-tenant flag when `dryRun=false`. **Option B confirmed** — flag must be flipped briefly.

### Flag flip transaction 1 (false → true)

```sql
BEGIN;
UPDATE companies SET recurring_engine_enabled = true WHERE id = 1;
-- rowcount: 1 ✓
COMMIT;
```

### Trigger request

`POST /api/recurring/trigger` with PHES owner JWT. HTTP 200 in 1.46s.

| Field | Value |
|---|---:|
| `inserted` / `jobs_created` | **272** |
| `schedules_processed` | 72 |
| `skipped_duplicates` | 13 |
| `unassigned_jobs` | 136 |
| `skipped_null_fee` | 5 |
| `skipped_zero_fee` | 0 |
| `failed_schedules` | **[]** |
| `skipped_due_to_lock` | null |

### Flag flip transaction 2 (true → false — safety before Step 3)

```sql
BEGIN;
UPDATE companies SET recurring_engine_enabled = false WHERE id = 1;
-- rowcount: 1 ✓
COMMIT;
```

## Step 3 — Post-trigger DB verification (flag was false during inspection)

| Metric | Value | Gate |
|---|---:|:-:|
| PHES `jobs` total | 396 (124 + 272) | ✓ |
| Rows created in last 10 min | **272** | ✓ |
| Zero-fee inserts in last 10 min | **0** | ✓ guard held |
| Distinct schedules with new rows | 72 | ✓ |
| Unassigned new rows | 136 | — (expected — 42 no-tech schedules) |
| Duplicate tuples in new set | **0** | ✓ |
| Duplicate tuples across all PHES | **0** | ✓ unique index holding |
| NULL-fee sched 13, 19, 27, 78, 86 new rows | **all 0** | ✓ **GUARD FIRED FOR ALL 5** |
| New date range | 2026-04-23 → 2026-06-15 (54-day horizon) | ✓ |

### Tech distribution on the 272 new rows

| Tech | Jobs |
|---|---:|
| Unassigned | 136 |
| Norma Puga | 34 |
| Alejandra Cuervo | 28 |
| Ana Valdez | 16 |
| Rosa Gallegos | 16 |
| Alma Salinas | 16 |
| Diana Vasquez | 14 |
| Guadalupe Mejia | 8 |
| Juliana Loredo | 4 |

The 136 unassigned count matches commit H's projection. These will fire `job_unassigned` alerts over the next 48h cycles; office team can assign from `/dispatch`.

### J3 defense proof points

- **Deterministic ORDER BY:** all 79 schedules evaluated in `id` order. No mid-loop crash. No early exit after the first 10.
- **Per-schedule try/catch:** `failed_schedules: []` — not a single schedule threw an exception. The catch never had to catch anything this run.
- **No startup cascade:** only one process fired the trigger (manual via curl). `skipped_due_to_lock: null` confirms no second process raced us.
- **Advisory lock acquired cleanly:** lock was taken, held for ~1.5s while the 272 inserts ran, then released in the `finally` block.
- **NULL-fee guard, now with zero leak:** sched 13 (Saguto) and 19 (Azzarello) — which leaked 10 and 40 rows in the overnight incident — produced **zero** new rows this time. Under deterministic iteration order with the guard actually reached for every schedule, it fires correctly for all 5.

## Step 4 — Flag flipped true permanently for ongoing cron

```sql
BEGIN;
UPDATE companies SET recurring_engine_enabled = true WHERE id = 1;
-- rowcount: 1 ✓
COMMIT;
```

Final flag state:

| id | Company | Flag |
|---:|---|:-:|
| 1 | Phes | **true** |
| 2 | Demo Cleaning Co | false |
| 3 | Evinco Services | false |
| 4 | PHES Schaumburg | false |

Ongoing operation:
- The 2 AM CT cron (`startRecurringJobCron` → `setTimeout` to next 02:00 local) fires nightly and will re-evaluate the 60-day horizon. Since we just ran today, tomorrow's cron will find mostly-duplicates and insert only the 1-day-forward rolling delta. Per-client new-row count per cron will average ~4-8 rows total company-wide, dominated by schedules whose 60-day horizon edge just advanced.
- The advisory lock prevents any concurrent startup / manual-trigger race.
- Per-schedule try/catch means a single bad schedule logs and continues; the remaining 78 still generate.
- If any schedule fails, the `/api/recurring/trigger` response's `failed_schedules` array and the Railway logs (prefix `[recurring-engine] Schedule X failed`) will surface it.

## Rollback — single command if anything goes wrong

```sql
UPDATE companies SET recurring_engine_enabled = false WHERE id = 1;
```

Future cron runs short-circuit in the tenant check (`recurring-jobs.ts:237-245`) with `{ skipped: true, reason: "tenant_disabled" }`. If a bad run produces rows, clean them by `created_at > '...'` with the usual transaction + rowcount gate pattern (Commit E / J4 precedent).

## Sal's follow-up actions for Apr 23

1. Open `app.qleno.com/dispatch` morning of Apr 23 — should see the 272 future-dated jobs populated on the Gantt.
2. Check `job_unassigned` notifications — ~136 alerts will fire over the coming 48h. Office team assigns techs from `/dispatch`.
3. Spot-check: sched 49 Jennifer Joy (weekly $121.15) should show 8 new jobs across the 60-day window; sched 14/15 Arianna Goose (weekly $160) should show 8 each; sched 41 Diana Cade (monthly $200.85) should show ~2.
4. At 2 AM CT Apr 23, the cron will fire. Expected insert count: single-digit (1-day rolling advance). Railway logs should show `[recurring-jobs] Done — created N, skipped M duplicates, 5 null-fee, 0 zero-fee, 79 schedules evaluated` with N much smaller than 272.

## Related commits

| SHA | Commit | Notes |
|---|---|---|
| `2ff1e4f` | fix(recurring): timezone bug in toDateStr | Session 2 |
| `9032111` | fix(recurring): guard against NULL/zero base_fee | Session 2 |
| `1864b2d` | docs(migration): G-4 CS alias revenue patch | Parity to 99.93% |
| `59871cc` | feat(engine): re-enable engine for PHES (Commit H) | Initial flip — overnight failure |
| `39cf49c` | fix(engine): emergency flag flip off (Commit I) | Rollback after incident |
| `b92d761` | fix(engine): defensive sweep (I addendum) | All tenants disabled |
| `4691069` | fix(engine): J1+J2+J4 cleanup + unique index | DB-only |
| `4bdd2f3` | fix(engine): J3 code hardening | ORDER BY + try/catch + no startup + advisory lock |
| (this) | feat(engine): J5 controlled re-enable | Manual trigger + flag ON |

## Remaining cutover work (not in tonight's scope)

- Stan Bratt + Ray Rackman $450 unmatched (needs Sal's MC probe)
- $191 unexplained 2025 residual (post-cutover investigation)
- Cucci Property Management CS reporting anomaly documentation
- Client dedup cleanups (4009 W 93rd Place id 67↔1330; Kriztofer/Kristofer Bz; Caravel 1264↔1287)
- Evinco + Cannon REI `client_type` fixes (residential → commercial)
- Norfleet reactivation decision
- 42 no-tech schedules will keep firing `job_unassigned` alerts — office team assigns from `/dispatch`
- PHES Schaumburg engine flag state (currently false; intentional until Schaumburg migrates)
- Railway log review of 2026-04-22 13:17 UTC incident (still deferred — the J3 defenses make recurrence unlikely, so root-cause Railway-side confirmation is nice-to-have not blocking)

**Engine is live. Parity is 99.93%. Auto-generation resumes at 2 AM CT tomorrow under the J3 defenses.**
