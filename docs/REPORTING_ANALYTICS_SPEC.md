# Qleno Reporting & Analytics — Working Spec

Captured 2026-06-04 from Sal. The thing MaidCentral does poorly: slicing the
same payroll/job data the many ways an owner actually needs. All of this is the
SAME underlying data (jobs → assigned tech, service_type, commission, hours;
mileage_legs; additional_pay) sliced by different filters. Build it once with
shared filters (date range, tech, branch, service_type), expose each slice as a
report + export.

> Not yet built — roadmap. Overtime engine (PR #295) is the first piece.

## 1. Time windows everywhere — MTD / YTD

Add **This Period / Month-to-Date / Year-to-Date** toggles to:
- **Tech** "My Earnings": their own commission, tips, mileage, job count, scope mix.
- **Office** payroll + every report below.

Decisions to lock:
- **YTD = calendar year** (aligns to W-2 / ADP). MTD = calendar month.
- Attribution date: be consistent. Commission/job reports key on `scheduled_date`
  (when the work happened); payroll/ADP cares about pay date. Pick per report and label it.

## 2. Per-technician reports ("how much did X make / drive")

For any tech, any window:
- **Commission earned** (e.g. "Maria, last month")
- **Mileage paid out** — APPLIED legs only (count `mileage_legs` status=applied /
  the pay_adjustment), shown separate from pending/computed so we never imply
  unpaid miles were paid.
- **Tips** (split cash vs CC — ADP has a CC Tips field)
- **Job count + scope mix**: deep clean / standard / move-in-out / commercial
- **Effective hourly rate** = commission ÷ hours worked (spots underpay vs minimum
  wage; this is the same regular-rate the OT engine uses)

## 3. Company-wide / cross-tech reports (distribution & fairness)

This is the MaidCentral gap that drives tech complaints. One row per tech:
- **Commission leaderboard** across the whole company, any window
- **Job-distribution equity**: deep cleans per tech, commercial vs residential per
  tech, total jobs, hours, efficiency
- **The fairness fix is a RATE, not a raw count.** "Maria got 12 deep cleans, Ana
  got 3" is misleading if Maria worked twice the weeks. Show deep cleans as a share
  (per 100 jobs, or per week worked) so part-timers aren't unfairly compared. Raw
  count + rate side by side.
- **Reporting is OFFICE-ONLY (locked 2026-06-04).** Technicians do NOT see
  distribution, fairness, leaderboards, or any "what's been dispatched to me"
  analytics. A tech sees only their OWN paystub (My Earnings). The office decides
  what, if anything, to share verbally. (Reverses an earlier "transparency to techs"
  idea — Sal's call.)

## 4. Things to not overlook (proactive)

- **OT premium YTD** — cumulative OT cost for compliance + budgeting (office only).
- **Revenue per tech vs commission earned** — margin/cost view (office only; never tech).
- **Reclean / complaint count per tech** — pair the "deep cleans" fairness lens with
  quality (we already track quality-probation data). Volume without quality is noise.
- **Commercial vs residential mix doubles as a pay-equity lens** — the two have
  different commission bases, so the mix explains pay differences.
- **Every report exports (CSV/JSON)** — this is the bridge to the Claude Dispatch →
  ADP workflow (see §5). Dispatch should pull a report, not scrape a screen.
- **Branch filter on everything** (Oak Lawn vs Schaumburg) — rollups already exist.
- **Permissions — reporting is OFFICE-ONLY.** Techs have NO access to reports,
  distribution, fairness, or "what's been dispatched to me" analytics. A tech sees
  only their OWN paystub (My Earnings). Everything else is owner/admin/office.

## 5. Claude Dispatch → ADP handoff (the "make it easier" goal)

Sal runs payroll by having Claude Dispatch read the payroll roll-up and enter each
employee into ADP (Tips → CC Tips, commission → Salary Amount, holiday confirmed).
To make that reliable:
- **Per-employee payroll roll-up** (one row/employee) with ADP-ready columns:
  `Employee | Reg Hours | Commission(→Salary Amt) | Tips(→CC Tips) | Holiday | PTO/Sick | Mileage | OT Premium* | Gross`
  (*OT premium flagged, office-approved before entry — never auto-added.)
- **One-click export (CSV + JSON)** matching those fields so Dispatch pulls exact
  numbers — no MaidCentral scraping, no transcription error.

## Build order (proposed)

1. Per-employee payroll roll-up + ADP export (unblocks Dispatch immediately).
2. MTD/YTD toggles on tech + office pay views.
3. Reports hub: per-tech (commission, mileage, scope mix) + company distribution/fairness.
4. Fairness transparency on the tech side.
