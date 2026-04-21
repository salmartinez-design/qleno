# Commit G-2 — NO-OP (Cucci Property Management import skipped)

- **Timestamp:** 2026-04-21 19:00 CT (America/Chicago)
- **Operator:** Claude Code (Sal approved Option A — no-op)
- **Company:** PHES (company_id=1)
- **Outcome:** **No DB writes.** The proposed import is a double-count risk.

## What was proposed

Route the unmatched CS "cucci property management" line ($5,328.75 across 16 months, 2025-01 → 2026-04) to DB client_id=1265 (Cucci Property Management - 10410 Moody Avenue). Import ~17 visits as new `job_history` rows, with revenue either from Dispatch CSV `Bill Rate` (where matched) or allocated from Customer Sales monthly totals.

## What the data actually showed

### MC Customer Sales (`Customer Sales - Phes (3).xlsx` + `(4).xlsx`)
- Line `"cucci property management"` = **$5,328.75** across 16 months
- Line `"chris cucci"` = **$0.00** — **does not exist in CS files at all**
- Conclusion: MC reports ALL Cucci commercial activity under the single "cucci property management" label; "chris cucci" as a customer name in CS is absent.

### MC Dispatch CSV (`Dispatch_Board_with_Service_Details.csv`)
- Rows with Customer = `"Chris Cucci"` = **138 visits, Bill Rate sum $22,563.50**
- Addresses served under that customer (Dispatch has no CPM label):

| Address | Visits | DB child client |
|---|---:|---|
| 10418 South Keating | 57 | id 1266 Cucci Realty 10418 S Keating |
| 10320 Ridgeland Avenue | 32 | none (no DB child) |
| 10410 Moody Avenue | 17 | **id 1265 Cucci Property Management** |
| 11901-05 South Lawndale | 16 | id 1267 |
| 9739 89th Avenue | 16 | none (no DB child) |

**Dispatch Bill Rate sum for just 10410 Moody Avenue visits ≈ $2,352.50** (12 × $150 + 2 × $276.25 + 3 × $0). That's **less than half** the CS CPM total of $5,328.75.

### Current DB state

- `clients.id = 24` (Chris Cucci, residential) has **165 job_history rows totaling $24,271.15**
- These rows were imported during the earlier Prompt 4.5 migration with notes tag `[source: cs_authoritative+jc_allocation+dispatch]`
- **27 of those rows fall on Moody Avenue visit dates**, summing to approximately $4,177
- `clients.id = 1265` (Cucci Property Management - 10410 Moody) has **0 job_history rows**

The DB's Chris Cucci revenue ($24,271) closely matches Dispatch billing ($22,564 Bill Rate sum + allocation padding). The prior migration correctly captured Cucci economics using Dispatch as source-of-truth. It did NOT use the CS CPM line.

## Why we're not importing

If G-2 had executed as originally scoped:

- **Before:** id 24 = $24,271, id 1265 = $0, total Cucci revenue in DB = **$24,271** (matching Dispatch reality)
- **After:** id 24 = $24,271, id 1265 ≈ $5,328, total Cucci revenue in DB = **$29,599**
- Every Moody Avenue date would have TWO job_history rows — one under id 24 (real billing), one under id 1265 (CS-allocated duplicate)
- Net effect: **revenue inflated by $5,328 with no new real visits, and 17 duplicate rows created.**

That's a data-integrity violation. CS "cucci property management" is a **reporting artifact**, not missing data.

## Why CS and Dispatch disagree

Best hypothesis: MC's Customer Sales report aggregates Cucci commercial activity under a single CPM line, but the report only captures ONE of the 5 Cucci properties (likely Moody Avenue) — or the CS line is restricted to a specific service set that excludes the other 4 properties. Either way:

- **Dispatch is the complete record** — 138 visits across 5 addresses, $22,564 total
- **CS is an incomplete slice** — $5,328 covering a subset
- DB followed Dispatch, which is correct

Whoever ran the original Prompt 4.5 migration made the right call treating Dispatch as authoritative for Cucci.

## Downstream impact — parity audit interpretation

The parity audit's `_commit_g_parity_report.md` flags this as a RED cell cohort:
- CS "cucci property management" says $5,328, DB id 1265 says $0 → 16 RED months
- Parity at the `(client, month)` level is NOT matched here

But at the **total-revenue level**, Cucci is correctly captured in DB under id 24. If parity is measured per-client-per-month against CS, this will always look broken for Cucci because CS mis-attributes the revenue. This is **a reporting discrepancy in the source file**, not a data gap in DB.

Document-level acceptance: when Sal reviews the parity report post-cutover, ignore all "cucci property management" RED cells — they are explained.

## Alternative paths considered (not taken)

| Option | Description | Why not |
|---|---|---|
| B | Move 27 Moody-dated rows from id 24 → id 1265 via `UPDATE customer_id` | Still wouldn't match CS CPM ($5,328 vs $4,177); introduces a $1,151 gap elsewhere and fragments Chris Cucci's history for no clear benefit |
| C | Delete the 5 Cucci Realty child clients (ids 1265-1269) since none have activity | Not in scope; those rows may be useful for future per-property recurring_schedule work |

## Action items captured (for later, not blocking)

1. **Post-cutover reconciliation:** Decide whether to continue using Dispatch as authoritative for Cucci or rebuild the per-property schedule model (5 Cucci Realty children, one recurring_schedule each).
2. **CS report deficiency:** Flag to Phes that MC's Customer Sales export under-reports Cucci revenue by ~75%. If MC admins can export a corrected or per-property CS file, that'd enable proper parity.
3. **Client 1265-1269 dedup vs split:** If the 5 Cucci Realty children stay separate, each needs its own recurring_schedule post-cutover. If consolidated, merge all 5 into id 24 and mark children inactive.

## Commit constraint maintained

- `companies.recurring_engine_enabled = false` for PHES (unchanged)
- No writes to any table
- No code changes
