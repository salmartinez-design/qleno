# Commit H — Recurring engine re-enabled for PHES

- **Timestamp:** 2026-04-21 19:43 CT (America/Chicago)
- **Operator:** Claude Code (Sal approved)
- **Company:** PHES (company_id=1)
- **Action:** `UPDATE companies SET recurring_engine_enabled = true WHERE id = 1`
- **Rows affected:** 1 / 1 expected
- **Rollback triggered?** No

## Before / after

| | id=1 Phes | id=2 Demo | id=3 Evinco | id=4 PHES Schaumburg |
|---|:-:|:-:|:-:|:-:|
| Before | **false** | true | true | true |
| After | **true** | true | true | true |

All four company engine flags now `true`. PHES's flag was the last blocker.

## Dry-run preview captured at flip time

Fresh dry-run against `/api/recurring/trigger?dry_run=true` immediately before the flip — this is what the 2 AM CT cron will produce:

| Metric | Value |
|---|---:|
| total_schedules_evaluated | 79 |
| planned (new inserts) | **272** |
| skipped_duplicates | 13 |
| skipped_null_fee (guard active) | 5 |
| skipped_zero_fee | 0 |
| Distinct schedules producing inserts | 72 |

### 5 NULL-fee schedules the guard will block (LOW/MED confidence cohort)
- id=13 Anthony Saguto (monthly)
- id=19 Bill Azzarello (weekly)
- id=27 Ciana Lesley (monthly)
- id=78 Tom and Carol Butler (weekly)
- id=86 Yates Rubio (weekly)

These stay NULL until a future backfill pass OR you accept them as "no-schedule, manual-book only" clients.

## Pre-flight gates confirmed

| Gate | Status |
|---|---|
| Working tree clean | ✓ |
| On main | ✓ |
| Flag currently false | ✓ |
| NULL-fee guard deployed (commit `9032111`) | ✓ |
| ≥70 priced schedules | ✓ (74 priced) |
| Final dry-run in [100, 500] range | ✓ (272) |

## Next 2 AM CT cron behavior

The cron in `artifacts/api-server/src/lib/recurring-jobs.ts` schedules via `setTimeout` to the next 2 AM local server time. On the Railway host (timezone generally America/Chicago), the first generation run will fire **~02:00 CT on 2026-04-22**.

On that run:
- Engine fetches `companies` rows where `recurring_engine_enabled = true` → includes PHES
- Pulls 79 active recurring_schedules for company_id=1
- For each schedule, `generateJobsFromSchedule` runs:
  - **5 skipped** (guard blocks NULL base_fee) — warnings logged: `[recurring-engine] SKIP schedule id=X client=Y — base_fee is NULL`
  - **74 evaluated** for occurrence generation
  - Dedupe against existing jobs by `(company_id, recurring_schedule_id, scheduled_date)`
  - 272 new `jobs` rows inserted across the 60-day forward horizon
- Each schedule with a generation gets `last_generated_date` bumped to today
- Post-run job_unassigned notification sweep: jobs within 48h without tech → notifications table

After the run, `jobs` table grows from its current ~203 rows to ~475.

## Rollback — single command if anything goes wrong

```sql
UPDATE companies SET recurring_engine_enabled = false WHERE id = 1;
```

Then any jobs already generated can be cleaned up with a targeted DELETE by `created_at > '2026-04-22 01:00 UTC'` if needed. The engine's NULL-fee guard (9032111) and timezone fix (2ff1e4f) are code-level protections that remain regardless of flag state.

## Sal's verification plan for 2026-04-22

Morning of Apr 22, Sal will:
1. Open Dispatch Board at `app.qleno.com/dispatch` — should see ~136 jobs-with-tech populated for future dates
2. Check `job_unassigned` notifications — ~136 jobs-without-tech should fire alerts over the coming 48h cycles
3. Spot-check 3 schedules:
   - sched 49 Jennifer Joy (weekly $121.15) — expect 8 new jobs over 60 days
   - sched 14/15 Arianna Goose (weekly $160) — expect 8 each
   - sched 41 Diana Cade (monthly $200.85) — expect ~2 new jobs

## Session commit-chain summary

Today's 14 commits across today's session:

| # | SHA | Commit |
|---|---|---|
| 1 | `2ff1e4f` | fix(recurring): timezone bug in toDateStr |
| 2 | `9032111` | fix(recurring): guard against NULL/zero base_fee inserts |
| 3 | `b740bc4` | feat(recurring): dry-run mode on /trigger endpoint |
| 4 | `4d34a1a` | fix(dispatch): tech name prominent on job card, Team→Technician |
| 5 | `cc3a231` | feat(dispatch): zone color as card bg + /jobs routes to Gantt |
| 6 | `287dd72` | docs(migration): B1a base_fee backfill (33 schedules) |
| 7 | `9cf2ace` | docs(migration): D canceled client flips (2 clients) |
| 8 | `07ddffa` | docs(migration): E phantom cleanup (470 phantoms deleted) |
| 9 | `5998a89` | docs(migration): F tech assignment backfill (44 schedules) |
| 10 | `e502eab` | docs(migration): B1b backfill + 8 commercial deactivations (47 schedules) |
| 11 | `6ad67c9` | docs(migration): G-1 Schultz revenue patch ($292.64) |
| 12 | `e94d714` | docs(migration): G-2 no-op — CS CPM is reporting artifact |
| 13 | `1864b2d` | docs(migration): G-4 CS alias revenue patch (26 rows, $6,452.86) |
| 14 | (this) | feat(engine): re-enable recurring job generation for PHES (commit H) |

## Remaining cutover work (not in tonight's scope)

- Stan Bratt + Ray Rackman $450 unmatched (needs Sal's MC probe)
- $191 unexplained 2025 residual (post-cutover investigation)
- Cucci Property Management CS reporting anomaly documentation
- Client dedup cleanups (4009 W 93rd Place id 67↔1330; Kriztofer/Kristofer Bz; Caravel 1264↔1287)
- Evinco + Cannon REI `client_type` fixes (residential → commercial)
- Norfleet reactivation decision
- 42 no-tech schedules will start firing job_unassigned alerts — office team can assign from `/dispatch`
- PHES Schaumburg engine flag state (currently also true — verify intentional)

**Engine is live. Parity is 99.93%. Auto-generation resumes at 2 AM CT tomorrow.**
