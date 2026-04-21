# Commit E — Phantom job cleanup (Option B, broader scope)

- **Timestamp:** 2026-04-21 17:47 CT (America/Chicago)
- **Operator:** Claude Code (Sal approved Option B)
- **Company:** PHES (company_id=1)
- **Transaction mode:** single BEGIN/COMMIT with row-count gate + paranoia check + rollback-on-fail
- **Scope:** ALL future $0 recurring jobs on PHES — regardless of parent schedule's current `base_fee` state

## Context

Session 1 deleted 744 phantoms on Apr 17. Cron regrew 549 on Apr 19–20 before Session 2's NULL-fee guard shipped (commit `9032111`). Guard now prevents future regrowth.

Between audit and cleanup, B1a (commit `287dd72`) priced 33 schedules — which left 182 of the phantoms linked to newly-priced schedules. The original prompt's restrictive DELETE (only targeting NULL-fee schedules) would have left those 182 stranded.

Sal approved broadening scope: all 470 future $0 recurring jobs are verifiably Apr 19–20 regrowth artifacts, none exist from always-priced schedules (Jim Schultz sched 52 and Ava Martinez sched 87 have no phantoms).

## DELETE filter

```sql
WHERE company_id = 1
  AND (base_fee IS NULL OR base_fee::numeric = 0)
  AND status = 'scheduled'
  AND scheduled_date >= CURRENT_DATE
  AND recurring_schedule_id IS NOT NULL
```

Past-dated `scheduled` jobs (the 82 "past_still_scheduled" set flagged earlier in audit) were NOT touched — they live in a different problem domain (need status transition, not deletion).

## Gates enforced

| Gate | Rule | Actual | Result |
|---|---|---|---|
| Pre-count range | in [450, 490] | 470 | ✓ |
| Deleted-count range | in [450, 490] | 470 | ✓ |
| Paranoia check | rows with `base_fee > 0` in deleted set = 0 | 0 | ✓ |

## Result

| Metric | Before | After |
|---|---:|---:|
| Total PHES jobs | 673 | **203** |
| Priced jobs (`base_fee > 0`) | 124 (= 2 real + 122 other) | **124** |
| Unpriced jobs (`base_fee IS NULL OR = 0`) | 549 (future) + others | **79** (past-dated only) |
| Future $0 phantoms from recurring | 470 | **0** |

Net reduction: **470 rows deleted.** No rows affected outside the target profile.

## Deleted job IDs (first 10 of 470)

```
[1634, 1663, 1664, 1665, 1666, 1683, 1684, 1780, 1781, 1782]
```

Full list not captured — all 470 met the filter by definition (base_fee ∈ {NULL, 0} AND status='scheduled' AND scheduled_date ≥ today AND recurring_schedule_id NOT NULL).

## Follow-up notes (out of scope for this commit)

- **79 past-dated unpriced jobs remain.** These are the "past_still_scheduled" set — jobs with scheduled_date < today but still in 'scheduled' status. Needs a separate sweep: either mark complete (if real historical), or mark cancelled (if no-shows).
- **Recurring engine remains DISABLED** — unchanged. Re-enable is gated on B1b + tech assignment.
- **The guard in `artifacts/api-server/src/lib/recurring-jobs.ts`** (commit `9032111`) still prevents NULL-fee schedules from producing new phantoms. The 52 still-NULL schedules won't generate jobs next cron; they're blocked until B1b backfill lands.
