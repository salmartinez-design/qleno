# Commit B1b — base_fee backfill + commercial deactivations log

- **Timestamp:** 2026-04-21 18:17 CT (America/Chicago)
- **Operator:** Claude Code (Sal approved)
- **Company:** PHES (company_id=1)
- **Transaction mode:** single BEGIN/COMMIT with 3 ops; any op off-count → rollback the whole thing
- **Source:** `migration/mc-exports-2026-04-21/_b1b_disagree.md` (47 rows) + Sal's per-row decisions

## Result

| Op | Rows affected | Expected | Result |
|---|---:|---:|---|
| A — Deactivate (Cucci + Walter) | 8 | 8 | ✓ |
| B — Special updates (Joy, Cusimano, Ratulowski) | 1+1+1 = 3 | 3 | ✓ |
| C — SSP defaults | 36 | 36 | ✓ |
| **Total** | **47** | 47 | ✓ |

Rollback triggered? **No.**

## Before / after

| | active_null | active_priced | inactive | total |
|---|---:|---:|---:|---:|
| Before B1b | 52 | 35 | 0 | 87 |
| **After B1b** | **5** | **74** | **8** | 87 |

Net: 85% of active schedules now priced. 8 schedules moved out of the active set entirely (Cucci + Walter commercial).

## Op A — Deactivations (`is_active=false`)

| sched | client | freq |
|---:|---|---|
| 21 | Chris Cucci | monthly |
| 22 | Chris Cucci | custom |
| 23 | Chris Cucci | weekly |
| 24 | Chris Cucci | monthly |
| 30 | Daniel Walter | weekly |
| 31 | Daniel Walter | monthly |
| 32 | Daniel Walter | custom |
| 33 | Daniel Walter | custom |

**History preserved** — `job_history` untouched (Cucci id 24: 165 jobs, $24,271; Walter id 19: 514 jobs, $103,707). The 5 "Cucci Realty / Property Management" child client rows (ids 1265-1269) already exist as commercial entities — rebuild per-property recurring schedules post-cutover.

## Op B — Special updates

| sched | client | freq | base_fee set | note |
|---:|---|---|---:|---|
| 49 | Jennifer Joy | weekly | **$121.15** | Sal override — per-visit rate, not SSP $650 single-service |
| 53 | Joe Cusimano | monthly | **$720.00** | Sal override — accept SSP biweekly rate as monthly (over-bill flag) |
| 84 | Wesl Ratulowski | biweekly (no change) | **$175.00** | Sal override; DB already at biweekly so `frequency='biweekly'` was a no-op |

## Op C — SSP defaults (36 rows)

| sched | client | freq | base_fee |
|---:|---|---|---:|
| 7 | Amanda Shoemaker | monthly | $180.00 |
| 8 | Amber Swanson | monthly | $231.40 |
| 9 | Amee Noethe | monthly | $180.00 |
| 11 | Anthony Cooke | biweekly | $260.00 |
| 12 | Anthony Gill | weekly | $145.00 |
| 14 | Arianna Goose | weekly | $160.00 |
| 15 | Arianna Goose | weekly | $160.00 |
| 29 | Damian Ehrlicher | custom | $255.00 |
| 35 | Daveco properties | monthly | $150.00 |
| 36 | Daveco properties | monthly | $150.00 |
| 37 | Daveco properties | monthly | $150.00 |
| 38 | David De Arruda | biweekly | $195.00 |
| 40 | Derik Jardine | biweekly | $195.00 |
| 46 | Greg Ward | biweekly | $186.00 |
| 47 | Heather Kelly | weekly | $120.00 |
| 48 | Jalinia Logan | custom | $170.00 |
| 50 | Jerry Berlin | biweekly | $180.00 |
| 55 | Jordan Szczepanski | monthly | $210.00 |
| 56 | Joshua Hillian | monthly | $195.00 |
| 57 | Julie Mitros | custom | $210.00 |
| 58 | Karen Fergle | biweekly | $170.00 |
| 59 | Kassandra Harris | monthly | $317.40 |
| 60 | Kristen Ivy | monthly | $260.00 |
| 61 | Kristofer Bz | biweekly | $300.00 |
| 62 | Kriztofer Bz | biweekly | $300.00 |
| 63 | Marco Useche | custom | $175.00 |
| 64 | Marianne Reed | monthly | $180.00 |
| 67 | Michael Noiles | monthly | $180.00 |
| 68 | Nathan Martin | weekly | $180.00 |
| 72 | Robert Stortz | biweekly | $180.00 |
| 73 | Rone Tempest | biweekly | $260.00 |
| 76 | Stanley Kuba | biweekly | $190.00 |
| 79 | Trena Grady | biweekly | $195.00 |
| 81 | Vanessa Radtke | monthly | $200.85 |
| 82 | Violeta Vuckovic | biweekly | $195.00 |
| 85 | Yahya Kassem | monthly | $150.00 |

## Remaining `base_fee IS NULL` active schedules (5)

Intentionally untouched — LOW/MEDIUM confidence. Engine guard (commit `9032111`) skips them safely.

| id | client | freq | original confidence |
|---:|---|---|---|
| 13 | Anthony Saguto | monthly | LOW (D fallback only) |
| 19 | Bill Azzarello | weekly | MEDIUM (C only, $127) |
| 27 | Ciana Lesley | monthly | LOW (D fallback only) |
| 78 | Tom and Carol Butler | weekly | MEDIUM (C only, $180) |
| 86 | Yates Rubio | weekly | MEDIUM (C only, $173) |

(Ava Martinez sched 87 retained her pre-existing $201.50 — not in this cohort.)

## Follow-up notes

- **Cucci/Walter commercial rebuild** — post-cutover task. 5 per-property Cucci child rows already seeded in clients table (ids 1265-1269). Create one recurring_schedule per child once contract terms are confirmed.
- **Kriztofer (id 46) / Kristofer (id 61) Bz** — typo-split client dedupe, still open.
- **Cusimano $720 flagged for review** — SSP rate is for biweekly but schedule is monthly; revenue may over-bill.
- **Joy $121.15** — per-visit rate Sal confirmed. Different from SSP $650 which appeared to be a single-service rate.
- **Engine status** — still `recurring_engine_enabled=false`. Flip is now unblocked: 74 of 79 active schedules are priced (93.7% coverage), 5 remain NULL but are guarded from generating phantoms.
