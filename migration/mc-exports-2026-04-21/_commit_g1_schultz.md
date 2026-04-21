# Commit G-1 — Abby Schultz revenue patch log

- **Timestamp:** 2026-04-21 18:46 CT (America/Chicago)
- **Operator:** Claude Code (Sal approved)
- **Company:** PHES (company_id=1)
- **Transaction mode:** single BEGIN/COMMIT with row-count gate
- **Deviation from prompt SQL:** adapted `client_id` → `customer_id` (actual column name on `job_history`)

## Result

| Metric | Value |
|---|---|
| Rows affected | **1** |
| Expected | 1 |
| Rollback triggered? | No |

## Row updated

- `job_history.id` = **8128**
- `customer_id` = 401 (Abby SCHULTZ, inactive, residential)
- `job_date` = 2025-03-26
- `revenue` = **$0.00 → $292.64**
- `notes` appended with `[mc_import_g1_2026_04_21 patch from CS 2025-03]`

Full notes field after patch:
```
[source: jc_only] [revenue_source: jc_unbilled] [month: 2025-03] [zone: Chicago Downtown/Loop Zone] [mc_import_g1_2026_04_21 patch from CS 2025-03]
```

## Context

The row was originally imported during a prior Prompt 4.5 job_history migration from Job Campaign files only (no matching revenue source). It was deliberately tagged `[revenue_source: jc_unbilled]` with `$0` because the original importer lacked a price. Customer Sales file (parsed tonight in Commit G) revealed MC's actual billed amount for 2025-03: $292.64. This patch closes that single-row gap.

Original matcher missed this record because the CS export has a typo in the customer name (`Schultultz, Abby` instead of `Schultz, Abby`), breaking fuzzy name matching. Verified by targeted client probe (Probe 3) which found `Abby SCHULTZ` (id 401) with a single $0 job on the exact matching date.

## Before / after period totals

| Period | Before | After | Delta |
|---|---:|---:|---:|
| 2025-03 total revenue | $64,434.73 | **$64,727.37** | +$292.64 |
| 2025 YTD total | $732,942.99 | $733,235.63 | +$292.64 |

## Rollback command if ever needed

```sql
UPDATE job_history
   SET revenue = 0,
       notes = replace(notes, ' [mc_import_g1_2026_04_21 patch from CS 2025-03]', '')
 WHERE id = 8128;
```

## Follow-up notes

- **Matcher bug not fixed.** The `schultultz abby` typo in MC's CS export is a one-off on this row. If MC exports the same file again, the matcher will still miss it. A general fix (Levenshtein tolerance >2) would be needed. Out of scope for this commit.
- **Still 12 CS-unmatched customers pending.** G-2 addresses Cucci Property Management routing; G-3 creates the 10 genuinely missing clients.
- **Engine flag unchanged.** `companies.recurring_engine_enabled=false` for PHES (id=1). Re-enable still gated on remaining work.
