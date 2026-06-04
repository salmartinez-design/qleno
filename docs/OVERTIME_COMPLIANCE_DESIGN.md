# Overtime Compliance Design

Source of truth for the overtime engine. Read before touching
`lib/overtime.ts`, the `/payroll/overtime-check` / `/payroll/overtime-rules`
endpoints, or the OT settings UI.

> **Not legal advice.** This documents how Qleno *computes* an overtime
> estimate so the office can review and pay it. Labor law has industry
> carve-outs and changes over time. Every tenant must confirm thresholds with
> their own payroll provider / employment counsel. The engine estimates the
> premium — it does not file or pay it.

## 1. What counts as "hours worked"

Only **compensable** time counts toward overtime. For a cleaning tech who
drives between client homes:

| Segment | Clock runs? | Mileage tracked? | Counts as hours worked? |
|---|---|---|---|
| Home → first job ("On My Way", SMS) | No | No | **No** — commute (29 CFR 785.35) |
| Inside a house (clocked in→out) | Yes | — | **Yes** — job time |
| Job → job (between sites, during the day) | Yes | Yes | **Yes** — "all in a day's work" (29 CFR 785.38) |
| Last job → home | No | No | **No** — commute |

So hours worked = **job clock time (`timeclock`) + between-jobs drive
(`mileage_legs.minutes`)**. The commute bookends never enter the math — no
clock runs during them, and the mileage engine already excludes the commute
legs (`skip_first_leg_of_day` / `skip_no_from_job`). Idle/breaks are excluded.

**Allowed hours is NOT hours worked.** Allowed hours is a budget used for the
efficiency score and (on commercial jobs) the commission basis. Overtime is
always measured against *actual* clocked time, never allowed hours.

## 2. Threshold — jurisdiction aware

- **Federal FLSA + most states (incl. Illinois, 820 ILCS 105/4a):** time-and-a-half
  for hours worked over **40 in a workweek**. No daily overtime. This is the
  default every tenant gets, so Qleno is compliant out of the box regardless of
  where the tenant operates.
- **Daily-overtime states** (opt-in via the state preset, owner-overridable):
  - **California** — daily OT after 8h, double-time after 12h, 7th-consecutive-day rules.
  - **Alaska** — daily OT after 8h (4+ employees).
  - **Colorado** — daily OT after 12h (the 12-consecutive-hours test isn't modeled).
  - **Nevada** — daily OT after 8h, but only for employees under 1.5× minimum wage.
  - **Oregon** — weekly-40 for most industries; manufacturing has daily-10 (configure manually).

Rules resolve from the company's OT config columns; when unconfigured they fall
back to the preset for `companies.state`, then to the federal default. See
`STATE_OVERTIME_PRESETS` and `resolveOvertimeRules()` in `lib/overtime.ts`.

The no-pyramiding method is used: an hour counted as daily OT is not counted
again as weekly OT. With no daily threshold the math degenerates exactly to
"hours over 40 in the week" — the plain weekly-40 rule.

## 3. The premium — commission pay

Phes (and most Qleno tenants) pay **commission + mileage**, not hourly.
Commissions are part of the regular rate (29 CFR 778.117). For a
commission-paid employee, straight time for every hour is *already* covered by
the commission, so the only money owed on overtime is the **premium portion**:

- regular rate = **workweek commission ÷ total hours worked that week**
- OT hours owe an extra `(otMultiplier − 1) × rate` (i.e. +0.5× for 1.5×)
- double-time hours owe an extra `(dtMultiplier − 1) × rate` (i.e. +1.0× for 2×)
- **Mileage is excluded from the regular rate** — it's a bona-fide expense
  reimbursement (29 CFR 778.217), not wages.

The regular rate reuses the canonical commission engine (`computeCommissionRows`)
so it matches the payroll detail screen, including per-job `final_pay` overrides.

## 4. Visibility — office only

- **Office** sees the full picture: which weeks crossed the limit, OT/DT hours,
  the regular-rate math, and the estimated premium dollars. The
  `/payroll/overtime-check` endpoint is role-gated to **owner / admin / office**.
- **Technicians never see overtime, hours-worked totals, drive, or idle as pay
  lines.** A tech's view is dollars (commission/earnings). The clock runs in the
  background as the meter for commission/billing/efficiency — it is not surfaced
  to the tech as "hours." This is a deliberate anti-confusion decision: the
  moment a tech sees "hours," they assume hourly pay.

## 5. No money moves automatically

Consistent with the mileage engine, computed overtime is a **review signal**.
The banner surfaces the estimate; the office decides and pays it through the
normal additional-pay flow. The engine never writes a pay row on its own.

## Files

- `artifacts/api-server/src/lib/overtime.ts` — pure engine (presets, resolver, week math, premium).
- `artifacts/api-server/src/tests/overtime.test.ts` — unit tests.
- `artifacts/api-server/src/routes/payroll.ts` — `/overtime-check`, `/overtime-rules` (GET/PUT).
- `lib/db/src/schema/companies.ts` — `ot_*` config columns.
- `artifacts/api-server/src/cutover-data-migration.ts` — `addOvertimeColumns()` cold-start ALTER.
- `artifacts/qleno/src/pages/payroll.tsx` — office `OvertimeBanner`.
- `artifacts/qleno/src/pages/company.tsx` — `OvertimeSettingsCard` (Settings → Payroll).
