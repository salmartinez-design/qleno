# Attendance Scoring — Session Handoff

**Written:** 2026-08-21 · **Updated:** 2026-08-21 19:45Z · **Branch:** `claude/attendance-score-impact-ulc09d` · **PR:** #1558 (draft, green, 7 commits)

**To resume:** start a session with database access and say *"Read `docs/ATTENDANCE_SCORING_HANDOFF.md` and continue."*

This document is self-contained. It assumes no memory of the prior session.

---

## 1. Why this exists

Sal asked whether an employee being late actually affects their attendance score, and whether the
total score is correct. The investigation found four real breaks. **All four are now fixed and
sitting in PR #1558**, including the fourth and most important one — that a tardy was worth almost
nothing (`2ae6f18`).

What is still outstanding is not code: it is the four things in §4 that need **database access**,
chief among them the before/after impact list, which should be seen before this ships because every
tech's attendance score moves the day it does.

Everything below is decided. Nothing here is a proposal awaiting an opinion unless it says
OPEN QUESTION.

---

## 2. What is already fixed (PR #1558, draft, CI green)

Seven commits. The load-bearing ones: `e282a2d` (nightly absence scan + display fixes), `f16162f` (NCNS weight 2 → 1), `2ae6f18` (**the ladder-based attendance score — the headline change**) and `6702a0d` (UI captions, so the screen stops claiming a 90-day window for attendance).

| # | Was broken | Fix |
|---|---|---|
| 1 | **Nothing detected unexcused absences.** The scanner's only caller was a "Run scan" button on the dispatch board, scoped to one selected date. Nobody clicked it, so the Attendance tab was empty and the ladder never advanced. | Scan body lifted into `lib/attendance-scan.ts`; nightly cron on the 1 AM tick scans yesterday per tenant. |
| 2 | **NCNS counted zero** in the occurrence count, the Unexcused tile, the benefit-year history, and both copies of the 40-hour bank. | All four routed through `countUnexcusedOccurrences` / widened to include `ncns`. |
| 3 | **The on-time ring could contradict its own tile** — "100% on time" beside "Tardy 1" when a tardy's job was later cancelled or reassigned. | Ring counts tardy dates not excluded as absence/leave; denominator widened to match. |
| 4 | **The score sat stale until 3 AM** after recording or deleting an absence. | `recomputeCompositeScore` on both the record and delete paths. |

**Safety property worth preserving:** the nightly scan writes `attendance_proposals` rows in status
`pending` only — never `employee_attendance_log`, never a discipline row. A human confirms each one.
A test asserts the scanner never imports the attendance-log table or the ladder writer. Do not
change this without a deliberate decision.

### ✅ The NCNS edit is DONE — do not redo it

`f16162f` dropped `NCNS_OCCURRENCE_WEIGHT` from 2 to 1 and updated the assertions
in three test files (`attendance-ncns-parity`, `plawa-attendance`,
`cutover-3d-occurrence-ladder` — the weight was pinned in all three, not just the
one this doc originally named).

**Sal has since said to stop touching NCNS altogether**: *"Why was a no call no
show even a thing. If someone here does that we just terminate them. That's
already in the system. stop messing with that."* At Phes a no-call/no-show is a
termination handled outside Qleno, so the ladder never reaches it and this code
path is effectively inert. Leave it alone.

### ✅ The attendance formula in §3 is IMPLEMENTED — do not rebuild it

`2ae6f18` shipped it. `lib/scorecard-composite.ts` now scores attendance as
position on the Benefit-Year ladder, with the pure arithmetic exported as
`ladderAttendancePct(worst, terminationOccurrences)` and 15 tests in
`src/tests/attendance-ladder-score.test.ts`.

What triggered it: Sal put two screenshots of the same tech side by side — the
Attendance tab reading **TARDY 1** (180-day window) and the Performance Score
beside it reading **ATTENDANCE 100% · 0 issues** (90-day window). The tardy was
older than 90 days and had aged out of the score. *"All i need you to do is
ensure that the tardiness again is being counted against their performance score
and tardiness counter."*

## 3. Decisions locked (do not re-litigate)

Sal answered all of these explicitly. Quotes are his.

### The formula

**Attendance score = position on the published 5-occurrence ladder, over the Benefit Year.**

```
attendanceScore(employee, asOf):
    if hire_date is null: return null          # and flag the employee — see below
    byStart = benefitYearStartDate(hire_date, asOf)      # lib/leave-grant-reset.ts

    tardyOcc = count(employee_attendance_log
                     where type='tardy' and not protected
                     and log_date between byStart and asOf)

    unexOcc  = countUnexcusedOccurrences(rows where type in ('absent','ncns')
                                         and log_date between byStart and asOf)

    worst = max(tardyOcc, unexOcc)            # WORSE of the two ladders, not blended
    return clamp(100 - (worst / TERMINATION_OCCURRENCES) * 100, 0, 100)
```

**`TERMINATION_OCCURRENCES` must be derived from the tenant's configured ladder** — the
`occurrence` value of the last step in `company_attendance_policy.tardy_occurrence_steps` /
`unexcused_occurrence_steps` — **not hardcoded to 5.** Both are currently `[{3, written}, {4,
final}, {5, termination}]` for companies 1 and 4. Hardcoding would break the moment the office
edits the ladder, and it would violate the house rule against hardcoding policy values.

Resulting scale at today's config:

| Occurrences | Handbook standing | Attendance | Total score (sat 95, cf 100) |
|---|---|---|---|
| 0 | clean | 100% | 97.0% |
| 1 | recorded, coaching | 80% | 92.0% |
| 2 | recorded, coaching | 60% | 87.0% |
| 3 | **written warning** | 40% | 82.0% |
| 4 | **final warning** | 20% | 77.0% |
| 5 | **termination** | 0% | 72.0% |

One tardy goes from **0.21 → 5.00 points** off the total.

### The rest

| Decision | Answer |
|---|---|
| **Window** | Benefit Year (work anniversary), **not** rolling 90 days. Chosen so the score and the write-up can never disagree — the failure case was an employee at "4 tardies, final warning" whose score only saw 1 because the others aged out. |
| **Two ladders** | Show the **worse** of tardy vs unexcused. Do not average — that lets someone one tardy from termination read as mid-range. |
| **NCNS** | *"Treat it as an unexcused absence is all. If it's a true no call no show then the office would make the decision to fire that employee not qleno."* → weight **1**. Qleno records that someone didn't show and didn't call; termination is a human decision made outside the system. |
| **Anniversary reset** | Score jumps back to **100%**, matching the handbook's Benefit Year reset. |
| **Other sub-scores** | Satisfaction and complaint-free **stay on rolling 90 days**. Only attendance has a ladder. ~~Relabel the UI~~ **DONE** (`6702a0d`) — headline now reads "Satisfaction + complaints: 90 days · Attendance: benefit year", and the attendance tile shows the ladder standing ("1 of 5 occurrences · this benefit year") instead of a 90-day day-count. |
| **Tech visibility** | **Yes** — techs see their own attendance score. Matches the handbook they signed; gives warning before a write-up. Sal should give the team a heads-up before it lands. |
| **Hire date** | *"All employees need to have hire date."* Make it required. No attendance score without one (show a dash, not a fake 100%), and flag those employees so the office can fill them in. |
| **Blend weights** | Stay **60 / 25 / 15**. At 20 points per occurrence, attendance bites plenty without touching the split. |

### Why this design (context, so it isn't undone later)

The handbook and LMS were reviewed before choosing this. Findings:

- **Section 3 of the handbook** defines a 20-minute grace window and a Tardiness Scale per Benefit
  Year: 1st/2nd recorded + coaching, 3rd written warning, 4th final warning, 5th termination. The
  system's configured ladder matches this exactly, and the 20-minute threshold matches
  `LATE_THRESHOLD_MINUTES` / `GRACE_MINUTES`.
- **The handbook never mentions a score. Not once.** Employees are taught, quizzed on, and
  disciplined by the *occurrence ladder*. The only performance number taught is Allowed Hours /
  efficiency, for pay.
- Therefore the seamless change is **not a new formula** — it is making the score restate the
  ladder employees already signed for. No new policy to communicate, no handbook revision, and the
  number reconciles out loud: *"your attendance is 60%, that's two tardies, one more is a written
  warning."* The old ratio (`days worked − violations ÷ days worked`) appears in no policy and is
  diluted by a ~60-day denominator, which is exactly why a tardy was worth 0.2 points.

### A handbook/system mismatch that is now resolved by decision

The handbook says *"a single no-call / no-show is grounds for immediate termination"* (with
protected-leave and verified-emergency guardrails). The system treated NCNS as 2 of 5 rungs —
implying three no-call/no-shows before the ladder terminates. Sal's answer resolves this: Qleno
records it as a plain unexcused absence and the office decides. **No handbook change needed.**

---

## 4. What needs DATABASE ACCESS (the reason for a new session)

The prior session had no `DATABASE_URL`. These four are blocked on that.

### 4.1 Confirm the go-live date — Sal asked for this explicitly

Sal believes Qleno entered operations **7/1**. Code evidence is consistent but cannot prove it.
What the code establishes:

| Date | Event | Source |
|---|---|---|
| 2026-06-17 | Clock punches switch to wall-clock storage | `[clock-tz 2026-06-17]` in `routes/timeclock.ts` |
| 2026-07-07 | Auto-tardy sweep ships. **Before this, no automatic tardy detection existed at all** — by design. | `lib/auto-tardy.ts` header, `index.ts` cron comment |
| 2026-08-18 | Timezone double-conversion bug fixed; sweep starts working | commit `d40d4f0` |

So the blind window is **7/7 – 8/18**, roughly six weeks — *not* the "June 17 – August 18" figure
quoted earlier in the prior session, which was wrong and was corrected.

```sql
-- Earliest real field punch = practical go-live
SELECT company_id, MIN(clock_in_at)::date AS first_punch, COUNT(*) AS punches
  FROM timeclock WHERE source = 'punched' GROUP BY company_id ORDER BY company_id;

-- Sanity: punches per week around the claimed start
SELECT date_trunc('week', clock_in_at)::date AS wk, COUNT(*)
  FROM timeclock WHERE source='punched' AND clock_in_at >= '2026-06-01'
 GROUP BY 1 ORDER BY 1;
```

### 4.2 Employees missing a hire date

Blocks the Benefit Year for those people. Sal wants them all filled in.

```sql
SELECT id, first_name, last_name, role, is_active
  FROM users
 WHERE company_id IN (1,4) AND hire_date IS NULL
   AND role IN ('technician','trainee','team_lead')
   AND is_active = true AND termination_date IS NULL AND archived_at IS NULL
 ORDER BY last_name;
```

### 4.3 Impact preview — run BEFORE shipping the formula

Every tech's score changes the day this lands. Produce a before/after list by name so Sal can see
it first. Compute per employee: current `scorecard_composite_90d`, benefit-year tardy count,
benefit-year unexcused count, new attendance %, new total, and the delta.

### 4.4 The backfill damage report (read-only first — Sal's standing preference)

**Feasibility note that matters:** `timeclock.late_by_min` did not exist before 2026-08-18, so
historical lateness cannot simply be read out of that column. It **can** be recomputed from
`timeclock.clock_in_at` + `jobs.scheduled_time` + `timeclock.tz_normalized`, which is exactly what
`punchMinsLocal()` in `lib/auto-tardy.ts` already does. So a backfill is possible, but must be
written deliberately as a script — the nightly sweep will never do it (it only ever processes
yesterday, and it skips any date that already has a tardy row).

Report first, in a dry-run that writes nothing: per employee, which dates between 7/7 and 8/18
would become tardies under the 20-minute rule, and what each person's resulting ladder standing
and score would be. **Sal decides after seeing real names.** Do not write rows without that.

Reuse `runAutoTardySweep`'s logic (first punched job of the day, >20 min past scheduled start,
`source='punched'` only, one per employee per date) so the backfill and the live sweep can't
disagree.

---

## 5. Implementation order

1. ~~**Edit PR #1558**: `NCNS_OCCURRENCE_WEIGHT` 2 → 1.~~ **DONE** — `f16162f`.
2. **Confirm go-live** (§4.1) and **list missing hire dates** (§4.2). Give Sal both.
3. ~~**Build the new attendance sub-score** in `lib/scorecard-composite.ts`.~~ **DONE** —
   `2ae6f18`. Ladder formula, tenant-derived termination rung, `null` on missing hire date,
   `ladderAttendancePct()` exported pure with 15 tests.
4. **Run the impact preview** (§4.3). Show Sal before shipping.
5. ~~**Relabel the UI**~~ **DONE** — `6702a0d`. Office Performance Score tab and the tech panel both
   updated; no "trailing 90 days" labels remain. The `N% weight` captions are unchanged and still
   correct — the blend weights did not move.
6. **Hire-date enforcement** — required on the employee form, plus a flag/list for existing gaps.
7. **Backfill report** (§4.4), then Sal's call.

---

## 6. File map

| Path | Role |
|---|---|
| `artifacts/api-server/src/lib/scorecard-composite.ts` | The composite engine. Attendance sub-score is the ~15 lines around the `violWeight` / `scheduledDays` queries — **this is what changes.** |
| `artifacts/api-server/src/lib/attendance-compliance.ts` | `countUnexcusedOccurrences`, `NCNS_OCCURRENCE_WEIGHT` — canonical counter. |
| `artifacts/api-server/src/lib/auto-tardy.ts` | Nightly tardy sweep. `punchMinsLocal()` is the timezone-correct punch reader the backfill needs. |
| `artifacts/api-server/src/lib/attendance-scan.ts` | **New in this PR.** Absence scanner + nightly cron. |
| `artifacts/api-server/src/lib/unexcused-ladder-writer.ts` | Writes attendance rows + drives discipline. `driveOccurrenceLadder` reads the tenant ladder. |
| `artifacts/api-server/src/lib/leave-grant-reset.ts` | `benefitYearStartDate(hireDate, asOf)` — the Benefit Year window. |
| `artifacts/api-server/src/routes/leave.ts` | `buildAttendanceSummary` (the Attendance card), the 40-hour bank, `/reliability`. |
| `artifacts/qleno/src/lib/training/curriculum.ts` | Handbook + LMS. Attendance policy is Section 3, around line 260. |
| `artifacts/qleno/src/pages/employee-profile.tsx` | Attendance tab, Performance Score tab, record form. Prints `N% weight` ~line 3056. |
| `artifacts/qleno/src/components/tech-scorecard-panel.tsx` | What the tech sees. Prints `N% weight`. |
| `artifacts/qleno/src/pages/reports/scorecard-report.tsx` | Office report. Prints `N% weight` ~line 109. |
| `artifacts/api-server/src/tests/attendance-ncns-parity.test.ts` | **New in this PR**, 22 tests. Update the NCNS-weight assertions. |

---

## 7. Gotchas that will bite you

- **A Railway PR preview is a second production server.** Same `DATABASE_URL`, same live keys.
  Any new cron or boot task must sit behind `backgroundWorkersAllowed()`. There is a test pinning
  this for the scan cron; keep the pattern.
- **The repo has ~1028 pre-existing TypeScript errors**, all in test files. `pnpm run typecheck`
  failing is not necessarily you. Get a baseline by stashing before you judge.
- **CI only runs `typecheck:libs`**, not the api-server, and never type-checks test files. Green CI
  is narrower than it looks — run the suite locally.
- **The full api-server suite has 17 pre-existing failures** in 11 unrelated files
  (`agreement-send-from-estimate`, `billing-single-path`, `boot-readiness`, `cutover-1b-tech-day-view`,
  `cutover-2a-mileage`, `estimate-tracking`, `mcp-tools`, `multi-recipient-estimates`,
  `req-auth-contract`, `sign-audit`, `v1-tenant-isolation`). Baseline: **1923 pass / 17 fail.**
- **Tests need a stub DB URL:** `DATABASE_URL=postgres://stub@stub/stub npx tsx --test <file>`.
- **The scorecard weights (60/25/15) have no writer anywhere** — no UI, no API, no test, no design
  doc. They are frozen at column defaults on `companies.score_weight_*`; only raw SQL changes them.
  Sal has not asked for a settings UI. Don't add one uninvited, but know they aren't editable.
- **Blend logic is duplicated** in `lib/scorecard-composite.ts` and `routes/scorecards.ts`. No
  shared helper. Change both or extract one.
- **Displayed weight ≠ effective weight** when a sub-score is null — the blend re-normalizes
  silently while the UI prints the raw number. With no completed jobs, satisfaction is really 70.6%
  and attendance 29.4%, both labelled 60/25.

---

## 8. Open questions

1. **Go-live date** — confirm 7/1 from §4.1, or tell Sal it stays unverified.
2. **Backfill** — blocked on the §4.4 report. Sal decides after seeing names.
3. ~~**Protected absences still hurt the attendance sub-score.**~~ **CLOSED by `2ae6f18`** — the
   ladder formula routes both tracks through `countUnexcusedOccurrences` and filters `!r.protected`
   on tardies, so PLAWA-covered rows now count zero. A test pins it.
4. **`HRAttendanceTab`** in `pages/employee-profile-hr-tabs.tsx` is exported but mounted nowhere —
   dead code. It is the only UI for `POST /hr-attendance`. Delete it or wire it; right now it just
   misleads.
