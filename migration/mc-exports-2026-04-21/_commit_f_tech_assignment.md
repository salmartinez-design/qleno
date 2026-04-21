# Commit F — Tech assignment backfill log

- **Timestamp:** 2026-04-21 17:58 CT (America/Chicago)
- **Operator:** Claude Code (Sal approved)
- **Company:** PHES (company_id=1)
- **Transaction mode:** single BEGIN/COMMIT with row-count gate + rollback-on-fail
- **Source:** `Dispatch_Board_with_Service_Details.csv` (3,845 visits, 216 in the 60-day window)
- **Matcher:** exact → reverse → first+last-word (strips middle names like "Norma Guerrero Puga" → "Norma Puga") → first-name-only if unique

## Result

| Metric | Value |
|---|---|
| Schedules evaluated (NULL-tech, active) | 86 |
| Schedules assigned | **44** |
| Schedules skipped (left NULL) | 42 |
| Rollback triggered? | No |

### Skip reasons
| reason | count |
|---|---:|
| no recent visits | 21 |
| only 1 visit | 20 |
| unmappable team string | 1 |

## Before / after

| | still_null | now_assigned | total |
|---|---:|---:|---:|
| Before F | 86 | 1 | 87 |
| **After F** | **42** | **45** | 87 |

Net new tech assignments: 44.

## Post-commit tech distribution

| Tech | id | Schedules |
|---|---:|---:|
| Norma Puga | 32 | 10 |
| Diana Vasquez | 38 | 9 |
| Alejandra Cuervo | 41 | 9 |
| Alma Salinas | 39 | 8 |
| Ana Valdez | 34 | 4 |
| Guadalupe Mejia | 40 | 2 |
| Rosa Gallegos | 36 | 2 |
| Juliana Loredo | 42 | 1 |
| **Tatiana Merchan** | **33** | **0** |
| **Juan Salazar** | **43** | **0** |
| **Total** | | **45** |

All under 20 per tech — no overload. Tatiana and Juan picked up zero recurring schedules from this backfill; worth a post-commit office-team rebalance if that distribution doesn't match the real-world plan.

## Full assignments (44)

| sched | emp_id | tech | client |
|---:|---:|---|---|
| 4 | 32 | Norma Puga | Adam Coppelman |
| 11 | 41 | Alejandra Cuervo | Anthony Cooke |
| 13 | 38 | Diana Vasquez | Anthony Saguto |
| 14 | 36 | Rosa Gallegos | Arianna Goose |
| 15 | 36 | Rosa Gallegos | Arianna Goose |
| 16 | 40 | Guadalupe Mejia | Ashley Doss |
| 18 | 41 | Alejandra Cuervo | Bethany Schultz |
| 21 | 39 | Alma Salinas | Chris Cucci |
| 22 | 39 | Alma Salinas | Chris Cucci |
| 23 | 39 | Alma Salinas | Chris Cucci |
| 24 | 39 | Alma Salinas | Chris Cucci |
| 25 | 32 | Norma Puga | Chris Schultz |
| 28 | 32 | Norma Puga | Claudia Mosier |
| 30 | 38 | Diana Vasquez | Daniel Walter |
| 31 | 38 | Diana Vasquez | Daniel Walter |
| 32 | 38 | Diana Vasquez | Daniel Walter |
| 33 | 38 | Diana Vasquez | Daniel Walter |
| 34 | 39 | Alma Salinas | Danni Varenhorst |
| 35 | 41 | Alejandra Cuervo | Daveco properties |
| 36 | 41 | Alejandra Cuervo | Daveco properties |
| 37 | 41 | Alejandra Cuervo | Daveco properties |
| 38 | 34 | Ana Valdez | David De Arruda |
| 40 | 32 | Norma Puga | Derik Jardine |
| 42 | 38 | Diana Vasquez | Dina Owen |
| 43 | 32 | Norma Puga | Dylan Azadi |
| 45 | 34 | Ana Valdez | Geraldine Bowen |
| 46 | 40 | Guadalupe Mejia | Greg Ward |
| 47 | 41 | Alejandra Cuervo | Heather Kelly |
| 50 | 34 | Ana Valdez | Jerry Berlin |
| 56 | 38 | Diana Vasquez | Joshua Hillian |
| 57 | 32 | Norma Puga | Julie Mitros |
| 58 | 38 | Diana Vasquez | Karen Fergle |
| 60 | 41 | Alejandra Cuervo | Kristen Ivy |
| 61 | 39 | Alma Salinas | Kristofer Bz |
| 62 | 39 | Alma Salinas | Kriztofer Bz |
| 66 | 34 | Ana Valdez | Michael Baffoe |
| 69 | 32 | Norma Puga | Nathaniel Pomeroy |
| 72 | 32 | Norma Puga | Robert Stortz |
| 73 | 41 | Alejandra Cuervo | Rone Tempest |
| 75 | 38 | Diana Vasquez | Shellie Ehrenstrom |
| 76 | 42 | Juliana Loredo | Stanley Kuba |
| 78 | 41 | Alejandra Cuervo | Tom and Carol Butler |
| 81 | 32 | Norma Puga | Vanessa Radtke |
| 84 | 39 | Alma Salinas | Wesl Ratulowski |

## Unmapped team strings (informational — none triggered the >5 visit hard rule)

| team string | visits | interpretation |
|---|---:|---|
| Ana Valdez Norma Guerrero Puga | 5 | 2-tech team (space-separated) |
| Ana Valdez Juliana Loredo | 3 | 2-tech team |
| Alma Salinas Juan Salazar | 2 | 2-tech team |
| Cleaner | 2 | generic placeholder |
| Diana Vasquez Juan Salazar | 1 | 2-tech team |
| Cleaner Diana Vasquez | 1 | cleaner + tech |
| Alejandra Cuervo Guadalupe Mejia | 1 | 2-tech team |
| Juan Salazar Norma Guerrero Puga | 1 | 2-tech team |
| Cleaner Guadalupe Mejia | 1 | cleaner + tech |
| Cleaner Guadalupe Mejia Norma Guerrero Puga | 1 | 3-way |
| Diana Vasquez Juan Salazar Norma Guerrero Puga | 1 | 3-tech team |
| Guadalupe Mejia Juliana Loredo Norma Guerrero Puga | 1 | 3-tech team |
| Alma Salinas Ana Valdez | 1 | 2-tech team |

These 20 team-visit entries don't contribute to any schedule's top tech assignment. If a future refinement wants to credit team visits (each member gets a visit credit), the CSV parser would need to recognize multi-word team strings. Out of scope for this commit.

## Follow-up notes

- **42 schedules still have NULL assigned_employee_id** — most are clients with no recent visits (21) or only 1 visit (20) in the Dispatch CSV. Office team should triage: assign manually, or leave NULL (engine will generate jobs as unassigned).
- **Tatiana Merchan and Juan Salazar got 0 schedules** from this backfill — not a data issue, but worth confirming with the office whether they primarily handle one-time / hourly / commercial work outside the recurring set.
- **The Kriztofer / Kristofer Bz typo split** (client_ids 46, 61) still exists — both got Alma Salinas assigned. Post-cutover dedup should merge.
- **Recurring engine remains DISABLED** — F populates tech templates; engine re-enable is gated on B1b.
