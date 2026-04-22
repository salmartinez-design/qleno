# Commit I — Emergency Rollback: Engine Flag Flipped OFF

- **Timestamp:** 2026-04-22 06:45 CT (America/Chicago) — morning audit triggered immediate rollback
- **Operator:** Claude Code (Sal approved emergency flip)
- **Company:** PHES (company_id=1)
- **Action:** `UPDATE companies SET recurring_engine_enabled = false WHERE id = 1 AND recurring_engine_enabled = true`
- **Rows affected:** 1 / 1 expected
- **Rollback triggered?** No (clean flip)
- **Duration of "engine ON" window:** 2026-04-21 19:43 CT (commit H) → 2026-04-22 06:45 CT — approximately **11 hours**

## Post-verification

```
id=1 name='Phes' recurring_engine_enabled=false
✓ flag is FALSE — engine is stopped
```

All four companies now: id=1 Phes **false**, id=2 Demo true, id=3 Evinco true, id=4 PHES Schaumburg true. PHES is off; the other 3 have no active clients/schedules so their flag state doesn't matter.

## Forensic evidence preserved (NOT deleted)

270 overnight-generated rows in `jobs` table are **intact**:
- Time span: `2026-04-22T13:17:34.826Z → 2026-04-22T13:17:37.331Z`
- All have `recurring_schedule_id NOT NULL` and `created_at` in that 3-second window
- Sal and Claude Code will investigate together before any cleanup

## Three observed problems

### (a) 5× concurrent startup runs created 270 rows (54 unique × 5 duplicates)

All 270 rows created within a 3-second window (13:17:34 – 13:17:37). Dedupe analysis:

| Metric | Value |
|---|---:|
| Total rows created | 270 |
| Unique (schedule_id, scheduled_date) pairs | 54 |
| Duplicate factor | **5.0×** |

Per-second histogram:
```
2026-04-22T13:17:34  40 rows
2026-04-22T13:17:35  110 rows
2026-04-22T13:17:36  80 rows
2026-04-22T13:17:37  40 rows
```

Interpretation: 5 concurrent executions of `runRecurringJobGeneration()` fired simultaneously. Each ran the dedupe query against stale DB state (before any other run committed) and each inserted the same 54 (schedule, date) occurrences. No row-level locks prevented the race.

Root-cause hypothesis: Railway restarted the service ~5 times in quick succession (possibly due to health check failures, OOM, instance auto-scaling, or a restart loop), and each startup fired `runRecurringJobGeneration()` in the `seedIfNeeded().then(...)` chain in `artifacts/api-server/src/index.ts:107-115`. Requires Railway log review to confirm.

### (b) Engine crashed mid-loop — only 10 of 79 schedules processed

Of 79 active recurring_schedules for PHES:
- **10 schedules** generated rows (11, 13, 15, 19, 29, 38, 40, 46, 47, 49)
- **69 schedules** got ZERO overnight rows (including sched 1 at $225/wk, sched 2 at $112.50/bi, and 67 other priced schedules)

The same 10 schedules were hit consistently across all 5 concurrent runs (each producing 5× dupes for those 10 only). This suggests each run crashed at the SAME schedule in the iteration order, not a random subset.

Root-cause hypothesis: a thrown exception in `generateJobsFromSchedule` for the 11th schedule in iteration order killed the whole `generateRecurringJobs` loop — the try/catch is at the COMPANY level in `runRecurringJobGeneration`, not per-schedule inside `generateRecurringJobs`. One bad schedule aborts the entire company's run. Candidate exception sources: bad address data, bad frequency enum, or a null reference that wasn't guarded.

### (c) 50 phantom $0 rows on sched 13 + 19 — NULL-fee guard did NOT fire for them

| NULL-fee sched | Client | base_fee | overnight rows | Guard |
|---:|---|---|---:|---|
| 13 | Anthony Saguto | NULL | **10** | ⚠ LEAKED |
| 19 | Bill Azzarello | NULL | **40** | ⚠ LEAKED |
| 27 | Ciana Lesley | NULL | 0 | ✓ worked |
| 78 | Tom and Carol Butler | NULL | 0 | ✓ worked |
| 86 | Yates Rubio | NULL | 0 | ✓ worked |

All 5 schedules have `base_fee IS NULL` verified at SQL level (`is_sql_null=true`, `octet_length=null`). The guard in `artifacts/api-server/src/lib/recurring-jobs.ts:307-340` should skip all 5 identically.

Most likely explanation: the guard DID work — and schedules 13, 19 were processed BEFORE the crash that halted processing of 27, 78, 86. The 50 phantom rows on 13 and 19 would have been prevented by the guard IF the guard had fired. So actually: **the guard DID NOT fire for 13, 19** — those rows slipped through.

Alternative hypothesis (needs code inspection): the deployed code on Railway may NOT match commit `9032111` (the NULL-fee guard). A build cache issue or failed redeploy could leave the old pre-guard code running. The `/api/recurring/trigger?dry_run=true` endpoint correctly returns `skipped_null_fee: 5` suggesting the guard IS deployed at least at the /trigger entry point — so this hypothesis is weaker.

Pending: confirm which version of `recurring-jobs.ts` is actually loaded in the Railway Node process. Railway logs or a deliberate instrumented redeploy would clarify.

## What Sal sees right now on `app.qleno.com/dispatch`

- **220 real-fee new jobs** across 8 schedules (Arianna Goose, Heather Kelly, Jennifer Joy, Anthony Cooke, Damian Ehrlicher, David De Arruda, Derik Jardine, Greg Ward) — each appears 5 times (dedupe-race artifacts)
- **50 phantom $0 jobs** on Anthony Saguto + Bill Azzarello rows (Saguto 10, Azzarello 40) — each appears 5 times
- **Zero jobs for 69 other schedules** — operationally those clients look like they have no recurring work scheduled

Dispatch Board will be confusing. Advise the office team NOT to act on the Dispatch Board for the 8 "live" schedules until cleanup is complete, since each real job has 4 duplicate rows.

## What is NOT being touched in this commit

- The 270 overnight-generated rows in `jobs` table — **preserved for forensics**. Cleanup will happen in a separate commit after root cause analysis.
- No code changes to `recurring-jobs.ts`, `index.ts`, or any other file.
- No recurring_schedules, clients, or job_history touched.
- No notifications cleared (there may be `job_unassigned` alerts firing, those will naturally stop when the flag is off and jobs get deleted).

## Rollback command (if ever needed to restore engine-on state)

```sql
UPDATE companies SET recurring_engine_enabled = true WHERE id = 1;
```

Not currently recommended until root cause is fixed.

## Next investigation steps (for Sal + Claude Code session)

1. **Pull Railway logs** for 2026-04-22 between 12:00 and 14:00 UTC — confirm the 5× restart hypothesis and identify what exception (if any) crashed the engine mid-loop
2. **Verify deployed code version** — compare Railway's built artifact to the guard commit `9032111`. If they mismatch, force a redeploy
3. **Add per-schedule try/catch** inside `generateRecurringJobs` so one bad schedule doesn't abort the run (defensive hardening)
4. **Add a startup-run guard** — only fire `runRecurringJobGeneration()` from the cron, not from the `seedIfNeeded().then(...)` chain, OR add a "last run" timestamp check to prevent restart-loop duplication
5. **Add a unique constraint** on `jobs (company_id, recurring_schedule_id, scheduled_date)` — this would have prevented the dedupe race from creating 5× duplicates regardless of application-layer dedupe correctness
6. **Plan cleanup** of the 270 rows after RCA — DELETE WHERE company_id=1 AND created_at BETWEEN ... AND recurring_schedule_id IS NOT NULL

## Related commits in today's chain

- `59871cc` — feat(engine): re-enable recurring job generation for PHES (commit H) — flipped flag from false → true at 19:43 CT Apr 21
- `1864b2d` — docs(migration): G-4 CS alias revenue patch (26 rows, $6,452.86) — parity commit before H
- `9032111` — fix(recurring): guard against NULL/zero base_fee inserts (Session 2, claimed deployed)
- `2ff1e4f` — fix(recurring): timezone bug in toDateStr (Session 2)

## Constraint maintained

- Engine flag **false** (post-rollback)
- No code changes
- No cleanup of the 270 overnight rows
- No other DB writes
- No engine restart attempts
