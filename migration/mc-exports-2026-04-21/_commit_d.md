# Commit D — canceled client flips log

- **Timestamp:** 2026-04-21 17:36 CT (America/Chicago)
- **Operator:** Claude Code (Sal approved)
- **Company:** PHES (company_id=1)
- **Transaction mode:** single BEGIN/COMMIT with guard + rollback-on-mismatch
- **Source:** `Customer Report - Phes (6).xlsx` — clients with `Canceled Service` date set AND `is_active=true` in DB (see `_reconciliation.md` §6)

## Result

| Metric | Value |
|---|---|
| Clients targeted | 2 |
| Rows affected by UPDATE | **2** |
| Rollback triggered? | No |
| SQL deviation from prompt | Dropped `updated_at = NOW()` — column does not exist on `clients` schema (verified via information_schema) |

## Rows flipped

| client_id | first_name | last_name | was | now | last_job_date | active_schedules | MC cancel date (file) |
|---:|---|---|:-:|:-:|---|---:|---|
| 271 | Erika | Benda | true | **false** | 2026-03-19 | 0 | 2026-03-10 |
| 316 | Yaya | Liu | true | **false** | 2026-03-02 | 0 | 2025-02-17 |

Both clients had 0 active `recurring_schedules` and 0 future scheduled jobs at the time of flip — no cascade cleanup needed.

## Discrepancy noted (not resolved)

**Yaya Liu (id 316)** — MC file lists cancel date as `2/17/2025`, but `job_history` shows her most recent completed job on `2026-03-02`. Two plausible explanations:
1. MC cancel date is stale / wrong in the export
2. She was re-activated between Feb 2025 and Mar 2026, then re-canceled

The flip is correct either way (MC reflects her as canceled now), but if a follow-up clarification is needed, this row is the one to check.

## Post-commit verification

```
✓ client 271 Erika Benda: is_active=false
✓ client 316 Yaya Liu:    is_active=false
```

## Follow-up notes (out of scope for this commit)

- **Active-client count dropped from 289 → 287.**
- No impact on PHES commercial / residential counts (both are residential).
- No recurring_schedules or scheduled jobs affected (pre-flight gate confirmed 0 of each).
