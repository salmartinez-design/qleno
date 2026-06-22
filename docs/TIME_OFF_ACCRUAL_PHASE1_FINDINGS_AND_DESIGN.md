# Time-Off Accrual — Phase 1 Findings & Design

**Status:** Phase 1 (research + design). Read-only. **No engine built, no balances
written, no prod writes.** Awaiting Sal's confirmation of the rules before Phase 2.

**Scope:** Hours-based accrual + balances + annual reset + 90-day eligibility for
**Sick (PLAWA)**, **PTO**, and **Unpaid Personal Leave**, integrated with payroll, then
migrate every active employee's starting balances from MaidCentral.

**Branch:** `feat/time-off-accrual-phase1-design` · draft PR.

---

## TL;DR — the one thing that changes everything

**The leave engine already largely exists.** A prior workstream ("Cutover 3A") shipped a
tenant-configurable leave system: schema, a pure-math accrual/reset engine, request
lifecycle (with multi-bucket cascade), blackouts, and use-it-or-lose-it alerts. Phes's
PLAWA / PTO / Unpaid / Unexcused buckets are **already seeded** in the DB.

So this is **not** a green-field "build an accrual engine" job. The real Phase 2 work is
narrower and more surgical:

1. **Fix the seeded PLAWA config** — it currently contradicts the written policy (see
   discrepancy #1 below). This is a correctness bug, not a style choice.
2. **Wire the grant/accrual/reset to actually run** — the math exists but **nothing calls
   it**. Balances are inert (everyone shows 0). There is no reset cron and no
   grant-on-eligibility job.
3. **Connect leave to payroll** — paid sick/PTO hours do **not** flow into pay today.
   Office manually types dollar amounts as `additional_pay` lines.
4. **Resolve the split-brain** — there are **two** parallel leave subsystems (the new 3A
   tables and an older set of `users.*_balance_hours` columns). They disagree.
5. **Migrate balances from MaidCentral** — a load path already exists; we need the data.

And there is **one policy conflict that only Sal can resolve** (reset basis: calendar year
vs. work anniversary). Everything downstream — reset dates, migration, the 90-day gate —
depends on his answer. **Details and the full question list are at the bottom.**

---

## 1. Extracted policies (from the LMS)

**Source:** `artifacts/qleno/src/lib/training/curriculum.ts` (the bilingual
`phes-policies` LMS module). This is real, written, employee-facing policy — quoted
verbatim below. Mirror/answer-key: `lib/training/src/answer-key.ts`.

### The three-bucket model (curriculum.ts ~line 334, verbatim table)

| # | Bucket | Hours | Eligible | Notice | Deniable? | Paid out at separation? |
|---|--------|-------|----------|--------|-----------|-------------------------|
| 1 | Any-Reason Leave (**PLAWA / sick**) | 40 / year | After **90 days** | Grace call only | No — protected | No |
| 2 | **PTO** | 40 (yr 1) → 80 (yr 2+) | After **1 year** | 7 days advance | Yes — business needs | **Yes** |
| 3 | **Unpaid Personal Leave** | 40 / yr (5 days) | **Day one** | 7 days advance | Yes — business needs | No |

### Sick / PLAWA — verbatim

> "40 paid hours per Benefit Year, **front-loaded** after 90 days of employment."
> — curriculum.ts:356

> "Because Phes **frontloads the full 40 PLAWA hours** at the start of each Benefit Year,
> unused PLAWA hours from the prior Benefit Year **do not carry over**. Unused PLAWA hours
> are **not paid out at separation**, consistent with the Illinois Paid Leave for All
> Workers Act frontloading exception."
> — curriculum.ts:366

**This answers Sal's open questions directly:**
- Granted upfront vs. accrued? → **Front-loaded (granted in full)**, not accrued.
- Carryover vs. use-it-or-lose-it? → **No carryover** (reset to 40 each year). Matches
  Sal's "resets" intuition.
- Hours-based? → **Yes, 40 hours.**
- Eligibility? → **After 90 days.**
- Paid out at separation? → **No.**

### The "Benefit Year" definition — verbatim (this is the conflict)

> "Attendance tracking, **leave balances**, and disciplinary thresholds reset annually on
> the employee's **Work Anniversary (hire date)**. This twelve-month period is your Benefit
> Year. Different employees have different Benefit Year start dates because they were hired
> on different dates."
> — curriculum.ts:245

⚠️ **The LMS says leave resets on each employee's work anniversary, not the calendar
year.** Sal's instruction to me said sick "resets automatically **each calendar year**."
These disagree. This is question #1 for Sal — see the bottom of the doc.

### PTO — verbatim (from the agent crawl; consistent with the bucket table)

> "40 hours after 1 year. Tops up to 80 hours at 2-year anniversary." … "Hard cap: 80
> hours total. Unused PTO does NOT stack. We top up to the cap, we do not add on top." …
> "PTO IS paid out at separation per the Illinois Wage Payment and Collection Act."

The "top-up to 80, never 100" math is exactly what the existing reset engine implements
(grant 40 + capped carryover, ceiling 80 — see §3).

### Unpaid Personal Leave — verbatim

> "40 hours / 5 days of unpaid time off, available day one." … "Does NOT carry over to the
> next year. Not paid out at separation." … "Used for PLANNED absences only … Not for
> same-day call-offs."

### Cascade order (which bucket pays first) — verbatim

> "Same-day call-off: PLAWA is the only bucket that applies. … Planned absence (with 7+
> days advance notice): PLAWA → PTO → Unpaid Personal Leave → discipline scale."

### Adjacent benefits the LMS also defines (not in this build's core 3, but related)

- **Holiday top-up:** "8 hours of regular pay per Benefit Year," eligibility "after 90
  days" (curriculum.ts:538, 547-548). Today this is the manual `holiday_pay` additional-pay
  line.
- **Birthday day off:** discretionary, after 90 days, forfeited if unused, never paid out
  (curriculum.ts:563). Explicitly *not* vested wages.
- **Protected absences** (jury duty, voting, workers' comp, VESSA, bereavement, lactation —
  paid, etc.): never count as unexcused; out of scope for accrual but relevant to the
  request/approval flow that already exists.

### Policy gaps to confirm with Sal (not fully specified in the LMS)

- **PTO accrual mechanism inside year 1.** LMS says "40 after 1 year." Is PTO granted as a
  lump 40 at the 1-year mark (front-loaded, like PLAWA), or does it accrue over year 1 and
  become *usable* at 1 year? The current seed treats it as a flat grant at the 1-year gate.
- **PTO reset cadence** — anniversary (implied by "2-year anniversary" language) vs.
  calendar. See conflict #1.
- **Unpaid leave tracking unit** — "40 hours / 5 days." Track in hours (recommended,
  matches everything else) — confirm.
- **Mid-year hire proration** — does a partial first Benefit Year get a prorated PLAWA/PTO
  grant, or the full 40? (IL PLAWA frontloading is typically full; confirm.)

---

## 2. Current employee status from MaidCentral (BLOCKED — need Sal to pull)

I cannot reach `phes.maidcentral.com` (requires Sal's authenticated session). The crawl
needs Sal to either pull the report or get me into a logged-in Chrome tab.

**What I need, per active employee (Oak Lawn / co1 only — see scoping note):**

| Field | Why |
|-------|-----|
| Full name + MC employee ID | Match to the Qleno `users` row |
| **Hire date** | Drives the 90-day PLAWA gate, the 1-year PTO gate, and the anniversary reset |
| Sick / PLAWA — accrued, used, **remaining** (2026) | Seed starting balance |
| PTO / vacation — accrued, used, **remaining** (2026) | Seed starting balance |
| Personal / unpaid — used (2026) | Seed starting balance |

**Where to find it in MaidCentral (please confirm which screen actually has it):**
- **Office → Employees → [employee] → Time Off / PTO tab** — per-employee accrued/used/
  remaining is usually here.
- Or a **Payroll / Time-Off Balance report** under Reports, if one exists, which would
  export all employees at once (preferred — one CSV).

**Action for Sal:** pull that report/screen (CSV export if possible, or screenshots of each
employee's Time Off tab) and drop it here. If you'd rather, get me to a logged-in
MaidCentral tab in Chrome and I'll drive the extraction myself. Until then, balances in
§4's migration plan are a template, not real numbers.

> **Scoping note (hard rule):** CLAUDE.md — "Schaumburg branch does NOT migrate from
> MaidCentral." The Phes-specific leave buckets are seeded for **company_id = 1 (Oak Lawn)**
> only. So this MaidCentral migration covers **Oak Lawn (co1) employees only**. Schaumburg
> (co4) gets balances set natively, not imported from MC. Confirm co1 = the MaidCentral
> tenant.

---

## 3. Qleno today — what actually exists (corrected assessment)

The premise in the task ("sick_pay/holiday_pay/vacation_pay are manual additional_pay
dollar entries — NO accrual/balance tracking") is **half right**: payroll *is* still
manual dollars, but a full balance/accrual **engine already exists** — it's just not wired
to run or to pay. Here's the real state.

### 3a. The "Cutover 3A" leave system — BUILT (the good news)

| Piece | File | State |
|-------|------|-------|
| Schema: `leave_types`, `employee_leave_balances`, `leave_requests`, `leave_blackouts`, `employee_availability` | `lib/db/src/schema/leave.ts` | ✅ Complete, multi-tenant |
| Pure-math engine: `computeCurrentBalance`, `accrueFromWorkedHours`, **`applyReset`** (grant + capped carryover + ceiling + forfeiture), `isPastWaitingPeriod` (90-day gate) | `artifacts/api-server/src/lib/leave-balance.ts` | ✅ Complete + unit-tested (`tests/cutover-3a-leave.test.ts`) |
| Routes: types CRUD, balances, requests, **cascade** (PTO→PLAWA→Unpaid), approve/deny/cancel, blackouts, alerts, unexcused ladder | `artifacts/api-server/src/routes/leave.ts` (1157 lines, mounted at `/api/leave`) | ✅ Built |
| Per-tenant policy config | `company_leave_policy` table (`lib/db/src/schema/hr_policies.ts`), incl. `leave_reset_basis`, `balance_ceiling_hours` (80), carryover, payout, lead-days | ✅ Built |
| Phes bucket seed | `cutover-data-migration.ts` (`seedLeaveTypes…`, `seedPhesLeavePolicy3A`) | ✅ Runs on cold start |

`applyReset` already implements **exactly** Sal's PTO top-up story (grant 40 + carryover
capped at ceiling 80, excess forfeited — the doc comment even works the "60 → 80, forfeit
20" example).

### 3b. Three things that make the engine **inert or wrong today** (the work)

**(i) PLAWA is seeded against the written policy.** `cutover-data-migration.ts:450` seeds
PLAWA as:

```
(1, 'plawa', 'PLAWA', true, 40, 'accrue_per_hours', 0.025, 90, carryover=true, exempt=true)
```

i.e. **accrue 1 hr per 40 worked, with carryover**. But the LMS (and Sal) say
**front-loaded 40, no carryover**. Correct config is `accrual_mode='flat_grant'`,
`accrual_rate=0`, `carryover_allowed=false`. **This is discrepancy #1 — a real bug.** The
0.025 figure is the IL statutory *minimum* accrual, which Phes exceeds by frontloading; the
seed encoded the floor instead of Phes's actual richer policy.

**(ii) Nothing ever populates balances.** `applyReset` and `accrueFromWorkedHours` are
called **only by the test file** — there is no reset cron and no grant-on-eligibility job.
`buildBalancesForUser` (`routes/leave.ts:249`) reads `granted_hours` straight from the row,
which defaults to `0` and is never written for flat-grant buckets. It also does **not**
apply `accrueFromWorkedHours` for the accrue bucket. **Net: every employee's 3A balance
shows 0 today.** The engine is built but parked.

**(iii) Leave is disconnected from payroll.** `routes/payroll.ts:129-147` sums
`sick_pay + holiday_pay + vacation_pay` purely from manual `additional_pay` dollar rows
(`type` is free-text). Approved `leave_requests` hours are **never** converted to dollars.
Payroll also *excludes* these types from the OT regular-rate (payroll.ts:336) — correct,
but it confirms they're treated as opaque dollars, not hours×rate.

### 3c. The split-brain — TWO leave subsystems that disagree

| | **Old (users-column) system** | **New (3A) system** |
|---|---|---|
| Storage | `users.leave_balance_hours`, `users.pto_balance_hours`, `users.sick_balance_hours`, `users.benefit_year_start`, `users.leave_balance_activated` | `employee_leave_balances` (per user × leave_type) |
| Route | `/api/hr-leave` (`routes/hr-leave.ts`) — `GET/PUT /balance`, `POST /use`, `POST /activate` | `/api/leave` (`routes/leave.ts`) |
| Grant logic | `/activate` front-loads `leave_hours_granted` into `users.leave_balance_hours` at `eligibility_trigger_days` | `applyReset` / `accrueFromWorkedHours` (uncalled) |
| `POST /use` | decrements **only** `leave_balance_hours` (the legacy single bucket) — **not** pto/sick | balance decremented on request approval |
| UI | Employee Profile → Leave Balance / HR Attendance tab | Leave request / review pages |

These overlap and contradict: `/hr-leave POST /use` decrements `leave_balance_hours` while
PTO/sick are set absolutely via `PUT`; the 3A `employee_leave_balances` is a third copy.
**Phase 2 must pick ONE canonical store** (recommendation below) and make the other a
read-through or retire it. Shipping accrual on top of the split-brain would create exactly
the kind of pay-affecting "which number is right?" bug this build is supposed to prevent.

### 3d. Where it surfaces (UI)

- **Employee profile:** `artifacts/qleno/src/pages/employee-profile.tsx` (tabs incl. "Leave
  Balance", "HR Attendance", "Additional Pay", "Payroll History"); HR tab logic in
  `employee-profile-hr-tabs.tsx` (reads `/api/hr-leave/balance`).
- **Payroll:** `artifacts/qleno/src/pages/payroll.tsx` (groups `sick_pay/holiday_pay/
  vacation_pay` under a "Time Off" header).
- **Employee-facing leave:** `leave-request.tsx`, `leave-review.tsx`.

---

## 4. Proposed design (Phase 2)

**Guiding principle:** don't rebuild — **converge on the 3A engine**, fix its seed, wire
its automation, connect it to pay, and retire the duplicate. This matches the codebase's
own stated intent (the `PUT /hr-leave/balance` comment already calls itself "the load path
for the reconciliation import of MaidCentral PTO/sick balances").

### 4.1 Canonical store

Make **`employee_leave_balances` (3A) the single source of truth.** Treat
`users.{pto,sick,leave}_balance_hours` as **deprecated**: either (a) drop them after
migration, or (b) keep them as a denormalized read-mirror updated from 3A (like the
assignment-mirror pattern in CLAUDE.md). Recommend (a) for cleanliness once the profile UI
is repointed at `/api/leave/balances`.

### 4.2 Corrected Phes `leave_types` (the seed fix)

| slug | display | paid | cap | accrual_mode | rate | wait (days) | carryover | reset basis* | payout on sep |
|------|---------|------|-----|--------------|------|-------------|-----------|--------------|---------------|
| `plawa` | PLAWA (Sick) | yes | 40 | **flat_grant** | 0 | 90 | **false** | (see Q1) | no |
| `pto_phes` | PTO | yes | 40 | flat_grant | 0 | 365 | true (ceiling 80) | anniversary | **yes** |
| `unpaid_leave` | Unpaid Personal | no | 40 | flat_grant | 0 | 0 | false | (see Q1) | no |
| `unexcused` | Unexcused | no | 40 | office_recorded | 0 | 0 | n/a | per Benefit Yr | no |

\* `leave_types` has **no per-type reset-basis column today** — `company_leave_policy.
leave_reset_basis` is company-wide (currently `work_anniversary`). If PLAWA must reset on a
**different** cadence than PTO (e.g. calendar-year PLAWA + anniversary PTO), Phase 2 needs a
new `reset_basis` column on `leave_types`. **This hinges on Sal's answer to Q1.** Also set
`company_leave_policy.payout_on_separation` correctly per-type (PTO yes, others no) — today
it's a single company flag, may need to move to the type.

### 4.3 Grant + accrual + reset jobs (the automation that's missing)

Three pieces, all building on the existing pure-math engine (no new math):

1. **Grant-on-eligibility job** — daily. For each active employee × flat-grant bucket: if
   `isPastWaitingPeriod(hire_date, waiting_period_days, today)` flips true and no grant has
   landed for the current Benefit Year, write `granted_hours = annual_cap_hours` to
   `employee_leave_balances`. (PLAWA at 90 days; PTO at 365 days.)
2. **Annual reset job** — daily check, fires on each employee's reset boundary (calendar
   1/1 or work anniversary per Q1). Calls the existing `applyReset(...)` and persists
   `new_granted` + surfaces `forfeited_hours` to the office. Resets `used_hours` to 0,
   stamps `last_reset_at`.
3. **(Optional) accrue snapshot** — only needed if any bucket stays `accrue_per_hours`. Per
   the policy, PLAWA should be flat_grant, so this may be unnecessary for Phes. Keep the
   function for other tenants.

Wire these into the existing CT-timezone cron scheduler in
`artifacts/api-server/src/index.ts` (alongside `rate_lock_nightly`, `annual_cycle_auto_open`,
etc.). **Idempotent, guarded by `last_reset_at` / a grant marker** so a double-fire can't
double-grant.

### 4.4 Payroll integration (paid sick/PTO → dollars)

At the payroll assembly point (`routes/payroll.ts`, after `computePayLines`):

- Pull **approved** `leave_requests` for **paid** buckets (`leave_types.is_paid = true`)
  whose dates fall in the pay window.
- Convert `hours × effective hourly rate` — rate from `employee_pay_rates` (the dated table
  CLAUDE.md treats as canonical), **not** a hardcoded number, mirroring the
  commission/mileage "never inline a rate" rule.
- Emit as a derived pay line (or a typed `additional_pay` row written by the system, clearly
  marked `source='leave_engine'` so it's distinguishable from manual office entries and
  never double-counted).
- **Keep these excluded from the OT regular-rate** (payroll.ts already does this for the
  manual types — preserve it). Unpaid leave produces **no** pay line by definition.
- **No money moves automatically without office review** — same philosophy as mileage/OT in
  CLAUDE.md. Surface the computed paid-leave dollars at the payroll review gate; office
  confirms. (Confirm with Sal — Q6.)

### 4.5 Surfacing

- **Employee profile** → repoint the Leave Balance tab at `/api/leave/balances` so it shows
  all buckets (PLAWA / PTO / Unpaid) with granted / used / **available** + the 90-day/1-year
  eligibility state and next reset date. Retire the old single-bucket readout.
- **Payroll detail** → show paid-leave dollars as a derived, labeled line under the existing
  "Time Off" group, with the hours and rate visible (not an opaque dollar amount).
- **Office** → the existing use-it-or-lose-it alerts (`/api/leave/alerts/use-it-or-lose-it`)
  already exist; surface them on the dashboard ahead of reset boundaries.

### 4.6 Migration plan (MaidCentral → Qleno, co1 only)

The load path **already exists**: `PUT /api/hr-leave/balance/:employee_id` is documented as
"the load path for the reconciliation import of MaidCentral PTO/sick balances." For the 3A
store we'll write `employee_leave_balances` directly instead.

**Steps (Phase 2, after rules confirmed):**
1. Sal pulls the MaidCentral per-employee Time-Off report (§2).
2. **Reconcile names → Qleno `users.id`** for active co1 employees; confirm each
   `users.hire_date` matches MC (hire date drives every gate — fix mismatches first).
3. For each employee × bucket, seed `employee_leave_balances`:
   - `granted_hours` = MC **accrued/granted** for the current Benefit Year
   - `used_hours` = MC **used** for the current Benefit Year
   - → `available = granted − used` reproduces MC's remaining.
   - Set `last_reset_at` to the current Benefit Year start so the next reset fires correctly.
4. **Dry-run first** (CLAUDE.md DB rule) — produce a diff report (employee, bucket, granted,
   used, available) for Sal to eyeball **before** any write. Seed via `ON CONFLICT DO
   UPDATE` (CLAUDE.md seed rule).
5. Spot-check 3-5 employees against MC in the UI after load.

**Edge cases to decide (in Q-list):** employees still inside 90 days (no PLAWA yet —
seed 0?), employees between 1 and 2 years (PTO 40 vs 80), and anyone with a remaining
balance above the ceiling.

---

## 5. Questions for Sal (must answer before Phase 2 build)

**Q1 — Reset basis (BLOCKER, affects everything).** The LMS says leave resets on each
employee's **work anniversary** (individualized Benefit Year); your instruction said
**calendar year**. Which is correct — and is it the **same for all three** buckets, or does
PLAWA reset on a different cadence than PTO? (If they differ, we add a per-type reset column.)

**Q2 — PLAWA accrual method.** Confirm PLAWA is **front-loaded 40 hours at the 90-day mark,
no carryover** (matches the LMS), so I can fix the seed that currently has it accruing
0.025/hr with carryover. (I'm 95% sure from the LMS — just need your yes.)

**Q3 — PTO in year 1.** Is PTO **granted as a lump 40 at the 1-year anniversary**, or does
it **accrue over** year 1 and become usable at 1 year? And confirm the top-up to 80 at year
2 with a hard ceiling of 80 (no stacking).

**Q4 — Mid-year hire proration.** New hire partway through a Benefit Year — **full 40**
PLAWA/PTO grant, or **prorated**?

**Q5 — Unpaid personal leave.** Track in **hours (40)** like the others? Any balance to
migrate, or just track usage going forward (it's unpaid, so it never hits pay)?

**Q6 — Payroll auto-pay vs. review gate.** Should approved **paid** sick/PTO hours auto-
convert to dollars on the payroll run, or surface at the **review gate** for office
confirmation first (like mileage/OT)? Recommendation: review gate.

**Q7 — Canonical store + cleanup.** OK to make 3A `employee_leave_balances` the single
source of truth and **retire** the older `users.{pto,sick,leave}_balance_hours` columns +
`/api/hr-leave` flow after migration? (Removes the split-brain.)

**Q8 — Scope confirm.** MaidCentral migration is **Oak Lawn / co1 only** (Schaumburg/co4
does not migrate from MC — hard rule). Confirm co1 is the MaidCentral tenant, and confirm
the active-employee list.

**Q9 — Separation payout.** Confirm payout-on-separation: **PTO yes**, PLAWA no, Unpaid no
(per LMS). This affects whether the ceiling/forfeiture or a payout calc applies at offboard.

**Q10 — MaidCentral report.** Which exact MC screen/report has per-employee accrued / used /
remaining for sick + PTO + personal (and hire dates)? Pull it (CSV preferred) or get me into
a logged-in Chrome tab and I'll extract it.

---

## Appendix — key file references

- LMS policy: `artifacts/qleno/src/lib/training/curriculum.ts` (lines 245, 334, 356, 366,
  538, 547-548)
- Leave schema: `lib/db/src/schema/leave.ts`; policy schema:
  `lib/db/src/schema/hr_policies.ts` (`company_leave_policy`, line 98)
- Engine math: `artifacts/api-server/src/lib/leave-balance.ts`
- Leave routes (3A): `artifacts/api-server/src/routes/leave.ts` (mounted `/api/leave`)
- Old leave routes: `artifacts/api-server/src/routes/hr-leave.ts` (mounted `/api/hr-leave`)
- Phes seed: `artifacts/api-server/src/cutover-data-migration.ts` (lines 405-512)
- Payroll assembly: `artifacts/api-server/src/routes/payroll.ts` (lines 129-147, 336)
- Pay rates (canonical): `employee_pay_rates` in `lib/db/src/schema/pay.ts`
- Tests: `artifacts/api-server/src/tests/cutover-3a-leave.test.ts`
- Cron host: `artifacts/api-server/src/index.ts`

---

# Addendum (2026-06-19) — Hire dates received; migration + eligibility finalized

Sal pulled the MaidCentral Employee List (hire dates). I cross-checked it against the live
Qleno DB (read-only audit, `scripts/_timeoff_audit_readonly.mjs`, SELECT-only). Results below.

## A. Live-data confirmations of the Phase 1 assessment

- **3A balances are empty:** `employee_leave_balances` for co1 = **0 rows, 0 granted, 0
  used.** Old `users.{pto,sick,leave}_balance_hours` = all `0.00`, `leave_balance_activated
  = false` for everyone. The engine is inert, exactly as described. Nothing to "preserve" on
  migration — we seed from scratch.
- **PLAWA seed bug confirmed in prod:** `leave_types` id 9 `plawa` = `accrue_per_hours`,
  rate `0.0250`, `carryover_allowed = true`. Must become `flat_grant` / rate 0 /
  `carryover=false`.
- **NEW: duplicate active sick bucket.** co1 has **both** `plawa` (id 9, wait 90) **and**
  the generic `sick` (id 5, "Sick Time", flat_grant, wait 0, carryover false) **active**.
  The generic `pto` (id 1) was deactivated during seeding but the generic `sick` was not.
  Two sick-like buckets showing at once → Phase 2 must deactivate `sick` (id 5) for co1 so
  PLAWA is the single sick bucket.
- **`company_leave_policy` (co1):** `leave_program_enabled=true`,
  `leave_reset_basis='work_anniversary'`, `balance_ceiling_hours=80`,
  `eligibility_trigger_days=90`, **`payout_on_separation=false`**. The payout flag conflicts
  with the LMS (PTO *is* paid out) — see Q9.

## B. Roster reconciliation (MC → Qleno) — two data problems to fix first

| MC id | Name | MC hire | Qleno user | Qleno hire | Status |
|------|------|---------|-----------|-----------|--------|
| 26443 | Norma Puga | 2023-05-11 | 32 | 2023-05-11 | ✅ match |
| 26450 | Maribel Castillo (office) | 2023-02-21 | 35 | 2023-02-21 | ✅ match |
| 26451 | Salvador Martinez (owner) | 2019-09-01 | 1 | **NULL** | ⚠️ Qleno hire_date missing (owner — likely excluded from accrual anyway, Q11) |
| 26452 | Rosa Gallegos | 2020-04-01 | 36 | 2020-04-01 | ✅ match |
| 28968 | Francisco Estevez (office) | 2024-06-03 | 37 | 2024-06-03 | ✅ match |
| 29567 | Diana Vasquez | 2024-06-18 | 38 | 2024-06-18 | ✅ match |
| 30618 | Alma Salinas | 2025-06-03 | 39 | 2025-06-03 | ✅ match |
| 32094 | Guadalupe Mejia | 2025-06-11 | 40 | 2025-06-11 | ✅ match |
| 42877 | Alejandra Cuervo | 2025-08-01 | 41 | **2023-05-11** | 🔴 **WRONG** — Qleno copied Norma's date; would falsely grant PTO. Fix to 2025-08-01 before migration. |
| 47897 | Juliana Loredo | 2026-01-26 | 42 | 2026-01-26 | ✅ match |
| 51027 | Jose Ardila | 2026-05-01 | 44 | 2026-05-01 | ✅ match |
| 51901 | Hilda Gallegos | 2026-05-25 | 516 | 2026-05-25 | ✅ match |
| 28511 | Generic Cleaner (TEST) | 2024-05-15 | — | — | exclude (test) |
| — | **Maryury Colmenares** | **not in MC list** | 817 | 2026-06-16 | 🟡 In Qleno, hired 3 days ago, **absent from MC list**. Include in accrual? (Q12) |
| — | Test Auditor (TEST) | — | 493 | NULL | exclude (test) |

**Two blockers for the migration roster:** (1) fix Alejandra's hire_date (a spin-off task
is already queued), (2) decide on Maryury. Both are pre-migration data fixes.

## C. Per-employee eligibility (as of today, 2026-06-19; using MC hire dates)

90-day sick gate = `hire + 90d ≤ today`. PTO gate = `hire + 1yr ≤ today`. PTO tier: year-1
grant = 40h; after 2nd anniversary the ceiling top-up takes it to 80h.

| Employee | Hire | Sick (PLAWA) eligible? | PTO eligible? | PTO grant tier |
|----------|------|------------------------|---------------|----------------|
| Rosa Gallegos | 2020-04-01 | ✅ | ✅ | 80 (2yr+) |
| Maribel Castillo (office) | 2023-02-21 | ✅ | ✅ | 80 |
| Norma Puga | 2023-05-11 | ✅ | ✅ | 80 |
| Francisco Estevez (office) | 2024-06-03 | ✅ | ✅ | 80 (2nd anniv 2026-06-03, 16d ago) |
| Diana Vasquez | 2024-06-18 | ✅ | ✅ | 80 (2nd anniv **2026-06-18, yesterday**) |
| Alma Salinas | 2025-06-03 | ✅ | ✅ (1yr crossed 16d ago) | 40 (year 1) |
| Guadalupe Mejia | 2025-06-11 | ✅ | ✅ (1yr crossed 8d ago) | 40 (year 1) |
| Alejandra Cuervo | 2025-08-01 | ✅ (90d since 2025-10-30) | ❌ (1yr = 2026-08-01) | — |
| Juliana Loredo | 2026-01-26 | ✅ (90d since 2026-04-26) | ❌ (1yr = 2027-01-26) | — |
| Jose Ardila | 2026-05-01 | ❌ (90d = 2026-07-30) | ❌ | — |
| Hilda Gallegos | 2026-05-25 | ❌ (90d = 2026-08-23) | ❌ | — |
| Maryury Colmenares | 2026-06-16 | ❌ (90d = 2026-09-14) | ❌ | — |
| Sal Martinez (owner) | 2019-09-01 | (excluded? Q11) | (excluded? Q11) | — |

This matches Sal's stated implications exactly (Jose & Hilda not sick-eligible; Alejandra/
Juliana/Jose/Hilda not PTO-eligible; Alma & Guadalupe just crossed PTO). **Diana crossing
her 2-year anniversary yesterday and Francisco 16 days ago means their 40→80 top-up is
right on the boundary — the exact day depends on the reset basis (Q1).**

## D. The "used so far" balance — why I now recommend MaidCentral as the source

Sal suggested deriving 2026 "used" from Qleno's `additional_pay`. **I checked the real rows
— this is not reliable for hours:**

- `additional_pay` stores **dollars**, not hours. Hours appear only sporadically in
  free-text `notes` (e.g. *"Fever … 11am-6pm (7h)"*, *"Dentist … (6h)"*) and many entries
  (esp. PTO/vacation) have **no** hours noted.
- The implied rate is **inconsistent** ($100/5h = $20/h, but $144/8h = $18/h), and
  **`employee_pay_rates` is empty** — there is no canonical rate to divide dollars by.
- Only **two** employees have any 2026 time-off entries at all: Norma (user 32) and
  Alejandra (user 41). Everyone else = $0 in `additional_pay` for 2026.
- `holiday_pay` entries exist too, but **holiday is a separate benefit**, not one of the
  three accrual buckets — don't fold it into PLAWA/PTO used-hours.

**Recommendation:** use **MaidCentral's per-employee Time Off tab (hours)** as the
authoritative "used" source. MC tracks used *in hours* natively; Qleno's dollar ledger
can't be back-converted cleanly. The pull is small in practice (only Norma & Alejandra have
2026 usage), but get all active employees for a clean reconciliation.

**Critical dependency — the "used" window is undefined until Q1 is answered.** "Used so far
this Benefit Year" means:
- **Calendar-year reset:** used since 2026-01-01 (Norma's Jan–Mar PTO + Feb sick all count
  against this year's 40/80).
- **Work-anniversary reset:** used since each person's most recent anniversary (Norma's
  benefit year started **2026-05-11**, so her Jan–Mar usage is in the *prior* year and does
  **not** reduce her new grant — she'd start nearly full).

These produce **very different** starting balances for Norma. So the migration's per-person
`used_hours` cannot be finalized until Sal answers Q1.

## E. Finalized migration procedure (HELD pending Q1 + dry-run sign-off)

1. **Pre-fix data:** correct Alejandra's hire_date (→2025-08-01); decide Maryury (Q12); set
   Sal's hire_date or exclude (Q11).
2. **Fix the seed (Phase 2 code):** PLAWA → `flat_grant`/rate 0/`carryover=false`;
   deactivate generic `sick` (id 5) for co1; set per-type `payout_on_separation` (PTO yes).
3. **Grant:** the grant-on-eligibility job writes `granted_hours` per the §C table
   (PLAWA 40 to all sick-eligible; PTO 40 or 80 to PTO-eligible; 0 for not-yet-eligible).
   This is **engine-computed, not migrated** — MC "accrued/granted" is not imported.
4. **Used:** set `used_hours` per employee/bucket from **MC used-hours within the current
   Benefit Year** (window per Q1). Only Norma & Alejandra are non-zero in 2026.
5. **Stamp** `last_reset_at` = current Benefit Year start so the next reset fires correctly.
6. **Dry-run diff** (employee × bucket: granted / used / available) for Sal to eyeball
   **before any write**; seed via `ON CONFLICT DO UPDATE`. Spot-check 3–5 in the UI after.

## F. Updated / added questions for Sal

- **Q1 (still the blocker)** — reset basis: calendar year vs. work anniversary. Now doubly
  important: it sets both the reset date *and* the "used so far" window that determines every
  starting balance (see §D).
- **Q10 (resolved direction)** — "used" source: I recommend **MaidCentral Time Off tab
  (hours)**, not Qleno `additional_pay` (can't yield reliable hours). Confirm, and Sal pulls
  the per-employee used-hours (Employees → [employee] → Time Off / PTO tab, or a Time-Off
  report) once Q1 fixes the window.
- **Q11 (new)** — owner/office staff: do PLAWA/PTO accrual apply to Sal (owner) and the
  office staff (Maribel, Francisco), or techs only? Sal's Qleno hire_date is NULL.
- **Q12 (new)** — Maryury Colmenares (Qleno user 817, hired 2026-06-16) isn't in the MC
  list. Include her in accrual (she's pre-90-day, so 0 today either way)?
- **Q13 (new)** — duplicate sick bucket: OK to deactivate the generic `sick` (leave_types
  id 5) for co1 so PLAWA is the only sick bucket?

---

# Phase 2 — BUILD (2026-06-20)

> ⚠️ **SUPERSEDED — see "Phase 2b — Reset-basis correction" below.** My first
> read of Sal's answer was calendar-year (Jan 1); Sal corrected it to
> **WORK ANNIVERSARY** (per-employee benefit year). The code, tests, dry-run,
> and seed have all been reworked accordingly. This section's calendar-year
> framing and dry-run numbers are kept only as a record; the corrected
> numbers are in Phase 2b.

**Reset basis (initial read — later corrected): calendar year.** Sick = 40
front-loaded after 90 days, no carryover, not paid at separation; PTO = 40 after
1 year → 80 (hard cap) at 2 years; Unpaid = 40 from day one.

**Status: code built, CI-green, balance writes + deploy HELD for sign-off.** The
accrual cron is gated OFF by `LEAVE_ACCRUAL_ENABLED` (default false), so merging/
deploying writes NO balances until Sal confirms the dry-run and flips the
Railway env var.

## What was built

| Piece | File | Notes |
|-------|------|-------|
| PLAWA seed fix + dup-sick deactivation + calendar-year basis | `cutover-data-migration.ts` | PLAWA → `flat_grant`/0/no-carryover (corrective UPDATE fixes prod); generic `sick` (id 5) deactivated for co1; policy forced to `calendar_year` |
| Pure grant/reset engine | `lib/leave-grant-reset.ts` | `entitlementHours`, `completedYearsOfService`, `planLeaveGrant` (initial_grant / annual_reset / tier_topup). PTO "top-up to tier" (40→80), NOT carryover math |
| Unit tests | `tests/cutover-3b-leave-grant-reset.test.ts` | 21 tests, all green (incl. handbook "top to 80, never stack" case) |
| DB reconcile wrapper | `lib/leave-reconcile.ts` | loops employees × flat-grant buckets; `dryRun` mode powers the migration diff |
| Daily cron (gated) | `lib/leave-accrual-cron.ts` + `index.ts` (2 AM CT) | grant-on-eligibility + Jan-1 reset; `LEAVE_ACCRUAL_ENABLED` default OFF |
| Payroll review-gate preview | `lib/leave-pay-preview.ts` + `GET /api/payroll/leave-pay-preview` | approved paid leave × resolved rate; read-only, NOT folded into gross (like mileage/OT) |
| Employee-profile UI repoint | `employee-profile-hr-tabs.tsx` | per-bucket 3A balances + eligibility + calendar-reset note; legacy single-bucket readout + manual log-usage write removed |
| Legacy deprecation | `routes/hr-leave.ts` | deprecation banner; column DROP deferred to a post-sign-off follow-up |

CI: `typecheck:libs` clean; api-server esbuild bundle + frontend vite build pass;
382/382 cutover tests pass.

## Migration DRY-RUN (co1 / Oak Lawn, as of 2026-06-20)

Read-only, no writes: `scripts/_timeoff_migration_dryrun_readonly.mjs`. Granted =
engine entitlement; Used = derived from 2026 `additional_pay` (sick_pay→PLAWA,
vacation_pay→PTO; hours parsed from "(Xh)" notes else ÷ $20/h); Remaining =
max(0, granted − used). Unpaid = 40 day-one, used 0.

| Employee | Hire | PLAWA grant/used/rem | PTO grant/used/rem | Unpaid |
|----------|------|----------------------|--------------------|--------|
| Rosa Gallegos | 2020-04-01 | 40 / 0 / 40 | 80 / 0 / 80 | 40 |
| Maribel Castillo (office) | 2023-02-21 | 40 / 0 / 40 | 80 / 0 / 80 | 40 |
| Norma Puga | 2023-05-11 | 40 / 8 / 32 | 80 / 34.5 / 45.5 | 40 |
| Francisco Estevez (office) | 2024-06-03 | 40 / 0 / 40 | 80 / 0 / 80 | 40 |
| Diana Vasquez | 2024-06-18 | 40 / 0 / 40 | 80 / 0 / 80 | 40 |
| Alma Salinas | 2025-06-03 | 40 / 0 / 40 | 40 / 0 / 40 | 40 |
| Guadalupe Mejia | 2025-06-11 | 40 / 0 / 40 | 40 / 0 / 40 | 40 |
| Alejandra Cuervo | 2025-08-01 | 40 / 21 / 19 | — not eligible | 40 |
| Juliana Loredo | 2026-01-26 | 40 / 0 / 40 | — not eligible | 40 |
| Jose Ardila | 2026-05-01 | — not eligible | — not eligible | 40 |
| Hilda Gallegos | 2026-05-25 | — not eligible | — not eligible | 40 |

(Used derivation printed per-row by the script. Only Norma & Alejandra have 2026
usage. Holiday_pay is reported but NOT deducted — separate benefit.)

## Residual questions for Sal (sign-off gate — no writes until answered)

1. **PTO year-1 grant + mid-year 2-year top-up timing.** The dry-run grants the
   tenure tier as of today (40 < 2yr, 80 ≥ 2yr). The engine bumps the tier at the
   next Jan-1 reset, NOT on the mid-year work anniversary. The handbook says "tops
   up at 2-year anniversary" — confirm Jan-1 timing is acceptable, or we add a
   mid-year anniversary top-up.
2. **Mid-year-hire proration.** New hires get the FULL 40 at the gate (IL PLAWA
   frontloading norm), not prorated. Confirm.
3. **Leave pay rate source.** The payroll preview + the used-hours derivation use
   `employee_pay_rates` → company `commercial_hourly_rate` → $20 fallback (rate
   table is empty today). Confirm the rate Phes pays leave at, and whether to seed
   `employee_pay_rates`.
4. **Auto-pay vs preview.** Paid leave is surfaced as a review-gate preview, not
   auto-added to gross. Confirm (recommended) or switch to auto-pay.
5. **Pre-write data fixes:** Alejandra hire_date (→2025-08-01), Maryury inclusion
   (Q12), owner/office scope (Q11).

## Go-live sequence (after sign-off)

1. Apply the Alejandra hire_date fix + Maryury/owner decisions.
2. Deploy (seed fix lands: PLAWA corrected, dup sick off, calendar basis).
3. Re-run the dry-run; Sal eyeballs.
4. Flip `LEAVE_ACCRUAL_ENABLED=true` → the 2 AM cron grants balances; overlay the
   current-benefit-year `used` (one-time migration write, `ON CONFLICT DO UPDATE`).
5. Spot-check 3–5 employees in the profile UI.

---

# Phase 2b — Reset-basis correction + request workflow (2026-06-20)

## Reset basis CORRECTED → WORK ANNIVERSARY (per-employee benefit year)

Sal corrected the basis: each employee's benefit year is anchored to their
**hire date and resets on their work anniversary** — NOT a Jan-1 calendar reset.
This matches the handbook and the already-seeded 3A `work_anniversary` policy, so
**no handbook change is needed.** All buckets reset on the anniversary.

Reworked accordingly (still HELD behind `LEAVE_ACCRUAL_ENABLED`):
- **Seed** (`cutover-data-migration.ts`) reverted to `leave_reset_basis =
  'work_anniversary'` (COALESCE-preserving). PLAWA flat-grant fix + dup-sick
  deactivation stand.
- **Engine** (`lib/leave-grant-reset.ts`): added `benefitYearStartDate` (most
  recent hire anniversary ≤ today); `planLeaveGrant` now keys the reset off the
  benefit year, not the calendar year (`last_reset_at < benefitYearStart` →
  reset). 25 unit tests, incl. an explicit "no Jan-1 reset" case.
- **Dry-run** (`scripts/_timeoff_migration_dryrun_readonly.mjs`): "used" now
  counts `additional_pay` only within each employee's **current benefit year**
  (since their anniversary), not the calendar year.

### Corrected dry-run (co1, as of 2026-06-20, work-anniversary basis)

The big change: usage **before** an employee's most recent anniversary is in
their *prior* benefit year and is NOT deducted — so most employees start with
**full** balances. Only Alejandra (anniversary 8/1, so her whole benefit year of
usage counts) carries used hours.

| Employee | Hire | Benefit yr start | PLAWA (g/u/rem) | PTO (g/u/rem) | Unpaid |
|----------|------|------------------|-----------------|---------------|--------|
| Rosa Gallegos | 2020-04-01 | 2026-04-01 | 40/0/40 | 80/0/80 | 40 |
| Maribel Castillo (office) | 2023-02-21 | 2026-02-21 | 40/0/40 | 80/0/80 | 40 |
| Norma Puga | 2023-05-11 | 2026-05-11 | 40/0/40 | 80/0/80 | 40 |
| Francisco Estevez (office) | 2024-06-03 | 2026-06-03 | 40/0/40 | 80/0/80 | 40 |
| Diana Vasquez | 2024-06-18 | 2026-06-18 | 40/0/40 | 80/0/80 | 40 |
| Alma Salinas | 2025-06-03 | 2026-06-03 | 40/0/40 | 40/0/40 | 40 |
| Guadalupe Mejia | 2025-06-11 | 2026-06-11 | 40/0/40 | 40/0/40 | 40 |
| Alejandra Cuervo | 2025-08-01 | 2025-08-01 | 40/29/**11** | not eligible | 40 |
| Juliana Loredo | 2026-01-26 | 2026-01-26 | 40/0/40 | not eligible | 40 |
| Jose Ardila | 2026-05-01 | — | not eligible | not eligible | 40 |
| Hilda Gallegos | 2026-05-25 | — | not eligible | not eligible | 40 |

(Norma's Jan–Mar 2026 PTO/sick fall before her 5/11 anniversary → prior benefit
year → not deducted. Contrast the superseded calendar-year table above.)

## Request → approval → notification workflow (field app), mirroring MaidCentral

### What the 3A lifecycle ALREADY provided

| # | Step | Status before this build |
|---|------|--------------------------|
| 1 | Employee request from phone | ✅ `leave-request.tsx` at `/leave` (DashboardLayout = field app): per-bucket balances + submit form + my-requests list. Posts `POST /api/leave/requests`. |
| 3 | Balance check + deduction | ✅ `checkBalance` on submit; `used_hours` increments on approve; restored on cancel. Balances visible to employee (`/balances/me`) + office (`/balances?userId=`). |
| 5 | Approve / deny in app | ✅ `leave-review.tsx` + `POST /requests/:id/approve|deny` (office/owner gated). |
| — | Blackout auto-deny + cascade | ✅ Already present (PLAWA exempt; non-exempt auto-denied; multi-bucket cascade endpoint). |

### What was MISSING — and is now built in this PR

| # | Step | Gap | Built |
|---|------|-----|-------|
| 2 | 7-day notice rules | ❌ none — only the 90-day *employment* gate existed | ✅ `checkAdvanceNotice` (PTO + Unpaid require start ≥ today+7d; PLAWA/sick exempt = emergency). Wired into `POST /requests`; field-app hint added. |
| 4 | Office + owner on submit | ❌ stub (`console.log` only) | ✅ `notifyLeaveSubmitted` → `notifyOfficeUsers` (owner+admin+office): in-app + push + staff email, MC "ACTION REQUIRED: review & approve". |
| 6 | Employee on decision | ❌ stub + push only | ✅ `notifyLeaveDecision` → employee in-app + push + **email + SMS** for Approved/Denied (MC subjects). |
| 1+ | Employee on submit | ❌ no confirmation | ✅ employee "Pending" (email+SMS+in-app); short-notice/sick → "Emergency Request Received" variant. |

New module: `lib/leave-notifications.ts`. MC templates mirrored (subjects close to
MC's "Pending / Approved / Denied / Emergency"); Sal's superset = employee
decisions on **SMS + email** (MC is email-only).

**Channel gating:** in-app + push always fire (internal staff alerts, ungated).
Employee **email + SMS are gated by `COMMS_ENABLED`** (SMS additionally by the
per-tenant/branch gate via `resolveSender`) — honoring the hard rule that no
SMS/email leaves the system until comms are enabled. So in prod today employees
get in-app + push; email/SMS begin once `COMMS_ENABLED=true`. Office alerts use
the existing (ungated) staff-alert email path.

### Workflow items still open / flagged
- **Cascade requests** (`POST /requests/cascade`, office-driven multi-bucket
  fall-through) are NOT yet wired to the new notifier — the field app uses the
  simple `POST /requests` path, which is. Follow-up if office uses cascade.
- **Field-app nav**: ✅ confirmed — `/leave` is routed (`App.tsx`) and the sidebar
  exposes a "Time Off" entry for `technician`/`team_lead` roles
  (`app-sidebar.tsx`). Reachable on the phone today.
- **Notification prefs**: `notifyUser` email/push for employee in-app types
  depend on `TYPE_TO_CATEGORY` mapping; employee email/SMS here are sent directly
  (MC-mirrored), not pref-gated, so they always send when `COMMS_ENABLED`.

## Residual questions (unchanged + reconfirmed for the anniversary basis)
The Phase 2 residual list still stands: PTO mid-year 2-year top-up timing (now at
the **anniversary** reset, which is the natural boundary — confirm), mid-year
proration, leave pay **rate source** (`employee_pay_rates` empty), auto-pay vs
preview, and the pre-write data fixes (Alejandra hire_date, Maryury, owner/office
scope). All HELD for Sal's sign-off before any balance write or deploy.

---

# Phase 2c — FINALIZED (Sal's answers, 2026-06-20)

All residuals resolved. Build complete; still HELD (no balance writes, no deploy,
no `COMMS_ENABLED`/`LEAVE_ACCRUAL_ENABLED` flip) until Sal confirms this dry-run.

- **Leave pay rate = flat $20/hr** (company floor) for paid sick + PTO — NOT the
  tech's commission/blended rate. `LEAVE_PAY_RATE = 20` in `lib/leave-pay.ts`.
- **Auto-pay on approval.** Approval is the gate: approving a paid request writes
  a visible, labeled `additional_pay` line (`sick_pay` → "Sick Pay", `pto` →
  "PTO") = hours × $20, landing in the payroll period of the approval. No manual
  pay step. Idempotent (guarded on a `leave_req#<id>` marker). Wired in the
  approve route → `writeApprovedLeavePay`. Frontend payroll Time-Off group + the
  legacy `/summary` gross both include `pto`.
- **Both views in sync on approval.** Balance deduction (`used_hours`) + the paid
  line are read from shared sources: office sees `/leave/balances?userId=` + the
  payroll line; the employee sees `/leave/balances/me` (profile + field-app
  "My Time Off") + the same `additional_pay` row in their payroll history. One
  write, both views update.
- **PTO 2-year top-up = at the anniversary reset** (confirmed). The engine
  recomputes the tier (40 < 2yr, 80 ≥ 2yr) at each benefit-year boundary.
- **Proration:** full front-load at the gate, no proration — sensible under the
  work-anniversary model because each benefit year is a clean 12 months from
  hire (a new hire's first PLAWA covers the rest of their first benefit year).
- **Data fixes resolved:** Alejandra → MC hire 2025-08-01 (Qleno fix tracked
  separately); **Maryury Colmenares (uid 817) INCLUDED**; **owner (Sal) EXCLUDED**
  from accrual; **office staff (Maribel, Francisco) INCLUDED**.
- **Preview repurposed:** `GET /api/payroll/leave-pay-preview` now forecasts
  **PENDING** paid requests at $20/hr (approved leave already auto-pays — avoids
  double-counting). Read-only.

## FINAL migration dry-run (co1, as of 2026-06-20, work-anniversary, $20/hr)

`scripts/_timeoff_migration_dryrun_readonly.mjs` (read-only). `rem_$@20` =
remaining hours × $20 (sick + PTO; unpaid = $0) — what the bank is worth if used.

| Employee | Benefit yr | PLAWA g/u/rem | PTO g/u/rem | Unpaid | PLAWA $ | PTO $ |
|----------|-----------|---------------|-------------|--------|---------|-------|
| Rosa Gallegos | 2026-04-01 | 40/0/40 | 80/0/80 | 40 | $800 | $1600 |
| Maribel Castillo (office) | 2026-02-21 | 40/0/40 | 80/0/80 | 40 | $800 | $1600 |
| Norma Puga | 2026-05-11 | 40/0/40 | 80/0/80 | 40 | $800 | $1600 |
| Francisco Estevez (office) | 2026-06-03 | 40/0/40 | 80/0/80 | 40 | $800 | $1600 |
| Diana Vasquez | 2026-06-18 | 40/0/40 | 80/0/80 | 40 | $800 | $1600 |
| Alma Salinas | 2026-06-03 | 40/0/40 | 40/0/40 | 40 | $800 | $800 |
| Guadalupe Mejia | 2026-06-11 | 40/0/40 | 40/0/40 | 40 | $800 | $800 |
| Alejandra Cuervo | 2025-08-01 | 40/29/**11** | not elig. | 40 | $220 | — |
| Juliana Loredo | 2026-01-26 | 40/0/40 | not elig. | 40 | $800 | — |
| Jose Ardila | 2026-05-01 | not elig. | not elig. | 40 | — | — |
| Hilda Gallegos | 2026-05-25 | not elig. | not elig. | 40 | — | — |
| Maryury Colmenares | 2026-06-16 | not elig. | not elig. | 40 | — | — |

(Owner Sal excluded. Most start full; only Alejandra carries used PLAWA — her
benefit year began 2025-08-01 so her 2025-12→2026-06 sick usage = 29h counts.)

## Go-live sequence (after Sal confirms this dry-run)

1. Apply the Alejandra hire_date fix (uid 41 → 2025-08-01).
2. Deploy — seed lands (PLAWA flat-grant, dup sick off, work_anniversary basis);
   auto-pay-on-approval + notifications + 7-day-notice ship inert (gated).
3. Re-run the dry-run against deployed state; Sal eyeballs.
4. Flip `LEAVE_ACCRUAL_ENABLED=true` → the 2 AM cron grants/resets balances per
   the table above (initial grants at each employee's gate; resets on anniversary).
5. Flip `COMMS_ENABLED=true` when ready → employee email/SMS for pending/decision
   begin (office in-app/email already work; in-app/push need no flip).
6. From here, approving a request auto-pays at $20/hr as a payroll line; balances
   + pay stay in sync across office and employee views.
7. Spot-check 3–5 employees (profile + field-app "My Time Off" + payroll).

---

# Phase 2d — MaidCentral loader ready (2026-06-20)

PR #581 **rebased onto current main** (past #601–#605), **marked ready for review**,
all 4 CI checks green. Still NOT merged/deployed; no writes; accrual cron off.

## Loader status — what existed vs. what was added

- The earlier `_timeoff_migration_dryrun_readonly.mjs` and the engine
  (`leave-reconcile.ts`) only compute **default grants** from hire dates and
  *derive* "used" from `additional_pay`. **Neither ingests a real MC dataset**,
  and neither loads **history**.
- **NEW: `scripts/timeoff-mc-loader.mjs`** ingests the verified MC dataset and
  cascades all three things Sal wants:
  1. **Start dates** → `users.hire_date` corrections (eligibility depends on it).
  2. **Balances** → `employee_leave_balances` (granted + used), upsert on
     `(company_id, user_id, leave_type_id)`; `last_reset_at` = the employee's
     current benefit-year start (work anniversary ≤ as_of) so the cron does NOT
     immediately re-reset the imported balance.
  3. **History** → `employee_leave_usage` rows (date_used, hours, notes),
     deduped, prefixed `[MC import]`.
- **Dry-run by default** (prints the full diff, writes nothing); `--apply` writes
  in a transaction. Idempotent (balances upsert, history NOT-EXISTS dedup, hire
  set) — safe to re-run. Validated against a sample: hire fix, 5 balance upserts,
  history rows, and an availability-mismatch flag all surfaced correctly.

## Dataset format I need from the MC crawl

JSON (the loader prints this banner when run without `--dataset`):

```json
{
  "as_of": "2026-06-20",
  "company_id": 1,
  "employees": [
    {
      "match": { "qleno_user_id": 41, "name": "Alejandra Cuervo", "email": "..." },
      "mc_employee_id": 42877,
      "hire_date": "2025-08-01",
      "balances": [
        { "bucket": "plawa",  "granted_hours": 40, "used_hours": 29, "available_hours": 11 },
        { "bucket": "pto",    "granted_hours": 0,  "used_hours": 0,  "available_hours": 0  },
        { "bucket": "unpaid", "granted_hours": 40, "used_hours": 0,  "available_hours": 40 }
      ],
      "history": [
        { "bucket": "plawa", "date_used": "2026-01-07", "hours": 7, "notes": "Fever 11am-6pm" }
      ]
    }
  ]
}
```

- **match.qleno_user_id** preferred (name/email are fallback + sanity check).
- **bucket** ∈ `plawa|sick`, `pto|vacation`, `unpaid|personal` → maps to PLAWA /
  PTO / Unpaid Leave. `unexcused` is office-recorded, not imported here.
- **hire_date** required per employee (start-date cascade).
- **balances**: one row per bucket; `available_hours` validated against
  granted − used (mismatch is flagged, granted/used wins).
- **history**: optional but wanted — each row becomes a usage-ledger entry.
- A **CSV** is fine too if easier — same columns (employee, bucket, granted, used,
  available, hire_date) + a second history sheet (employee, bucket, date, hours,
  notes); I'll adapt the loader's parser. JSON is the path of least resistance.

## Load sequence when the dataset lands (still HELD for sign-off)

1. `node scripts/timeoff-mc-loader.mjs --dataset mc.json` → **dry-run**; Sal eyeballs
   the hire fixes + balances + history + flags.
2. On approval: `--apply` (transactional) writes hire dates + balances + history.
3. Then merge + deploy #581 and flip `LEAVE_ACCRUAL_ENABLED` so future
   anniversaries reset on top of the imported balances (the import's
   `last_reset_at` stops the cron from clobbering imported numbers mid-year).
4. Spot-check (profile + field-app + payroll).

---

# Phase 2e — MC "Employee Attendance Stats" dry-run (2026-06-22)

Sal's MC export = hire dates + balances (PTO + Sick) only, **no line-item
history** (separate report later). Bucket scheme: PTO ← MC PTO; PLAWA ← MC Sick;
Unpaid ← default 40 (day-one, all employees); Unexcused ← 0 (not imported).
Skips: Generic Cleaner (test), Alma Salinas (1099), Salvador Martinez (owner).
Dataset: `scripts/_mc_timeoff_dataset.json` (untracked — employee PII). Loaded via
`timeoff-mc-loader.mjs` (dry-run, no writes). granted = used + available.

**All 11 names matched a Qleno user** (none unmatched): Jose Ardila (44), Maribel
Castillo (35), Alejandra Cuervo (41), Francisco Estevez (37), Hilda Gallegos (516),
Rosa Gallegos (36), Katia Gonzalez (726), Juliana Loredo (42), Guadalupe Mejia (40),
Norma Puga (32), Diana Vasquez (38). Hire-date correction: **Alejandra 2023-05-11 →
2025-08-01** (1 fix). 33 balance upserts (3 buckets × 11). History inserts: 0.

## Decisions for Sal (from the 7 flags)

**A. Balances ABOVE the Qleno cap** — loaded as-is from MC; cap or honor?
- Rosa Gallegos **PTO 160h** (ceiling is 80) — likely 2 years stacked in MC.
- Guadalupe Mejia **PLAWA 69.5h**, Diana Vasquez **PLAWA 56h**, Juliana Loredo
  **PLAWA 42h** (PLAWA front-load is 40) — MC kept availability at 40 after usage,
  so used+avail exceeds 40.

**B. Balances BELOW the engine front-load** — the accrual cron (once #581 is live
+ enabled) front-loads the full entitlement, so its `tier_topup` would raise these
on its next run, **overwriting the import** (used preserved):
- Alejandra **PLAWA 12 → 40** (avail 0 → 28).
- Norma **PTO 40 → 80** (she's 3 yrs; tier is 80; avail 0 → 40).
- Decide per employee: **accept** the engine front-load (Qleno policy: 40/80), or
  **freeze** the imported MC number until the next anniversary.

**C. Katia Gonzalez (uid 726) is INACTIVE in Qleno** but active in the MC export —
reactivate the Qleno user or skip her?

**D. History** is absent from this MC report (balances + attendance stats only) —
`employee_leave_usage` stays empty until the separate usage report is loaded.

## Sequencing note (important)
Flags are computed against the **post-#581 target config** (PLAWA = flat_grant/40/
no-carryover). On current prod PLAWA is still `accrue_per_hours` (the cron skips
it). So the correct order is **deploy #581 first → re-run this dry-run → apply →
enable cron**, which makes the live `leave_types` match the flag assumptions.
