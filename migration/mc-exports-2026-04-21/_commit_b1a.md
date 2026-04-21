# Commit B1a — base_fee backfill log

- **Timestamp:** 2026-04-21 17:34 CT (America/Chicago)
- **Operator:** Claude Code (Sal approved)
- **Company:** PHES (company_id=1)
- **Transaction mode:** single BEGIN/COMMIT with guard + rollback-on-mismatch
- **Source:** `migration/mc-exports-2026-04-21/_b1a_agree.md` (34 rows, corrected formula excluding D fallback from delta)

## Result

| Metric | Value |
|---|---|
| Schedules targeted | 34 |
| Rows affected by UPDATE | **33** |
| Skipped by guard (`base_fee IS NULL`) | 1 — sched 52 Jim Schultz already had `$220.00` |
| Rollback triggered? | No |

## Before / after counts (active recurring_schedules, company_id=1)

| | still_null | now_set | total | sum_set |
|---|---:|---:|---:|---:|
| Before | 85 | 2 | 87 | $421.50 |
| After | **52** | **35** | 87 | **$6,770.85** |

Net new base_fee assigned: $6,349.35 across 33 schedules.

## Schedule IDs updated (33)

`[1, 2, 3, 4, 5, 6, 10, 16, 17, 18, 20, 25, 26, 28, 34, 39, 41, 42, 43, 44, 45, 51, 54, 65, 66, 69, 70, 71, 74, 75, 77, 80, 83]`

Guard-skipped (already set): `[52]`

## Post-commit row snapshot

| sched | base_fee | freq |
|---:|---:|---|
| 1 | $225.00 | weekly |
| 2 | $112.50 | biweekly |
| 3 | $220.00 | custom |
| 4 | $220.00 | biweekly |
| 5 | $180.00 | monthly |
| 6 | $195.00 | custom |
| 10 | $180.00 | custom |
| 16 | $195.00 | custom |
| 17 | $195.00 | custom |
| 18 | $180.00 | biweekly |
| 20 | $195.00 | biweekly |
| 25 | $240.00 | biweekly |
| 26 | $176.00 | monthly |
| 28 | $180.00 | biweekly |
| 34 | $150.00 | biweekly |
| 39 | $180.00 | custom |
| 41 | $200.85 | monthly |
| 42 | $215.00 | custom |
| 43 | $240.00 | biweekly |
| 44 | $60.00 | biweekly |
| 45 | $195.00 | biweekly |
| 51 | $125.00 | monthly |
| 52 | $220.00 | weekly (was already set; guard skipped) |
| 54 | $180.00 | custom |
| 65 | $195.00 | custom |
| 66 | $180.00 | biweekly |
| 69 | $240.00 | biweekly |
| 70 | $180.00 | custom |
| 71 | $360.00 | biweekly |
| 74 | $195.00 | monthly |
| 75 | $220.00 | biweekly |
| 77 | $150.00 | monthly |
| 80 | $195.00 | monthly |
| 83 | $195.00 | custom |

## Follow-up notes (out of scope for this commit)

- **Sched 20 Cait Weyer** — schedule now has base_fee but the client record (client_id=139) has `is_active=false`. Data inconsistency flagged during dry-run; not blocking this commit but needs a follow-up decision: re-activate client, or deactivate schedule.
- **Remaining 52 NULL-fee schedules** are the B1b cohort (47 rows in `_b1b_disagree.md`) plus 5 not in the HIGH set (LOW/MEDIUM confidence). These require per-row manual review before any further UPDATE.
- **Recurring engine remains DISABLED** for PHES (`companies.recurring_engine_enabled=false`). This commit only populates base_fee; re-enabling the engine is a separate decision after the remaining schedules are addressed.
