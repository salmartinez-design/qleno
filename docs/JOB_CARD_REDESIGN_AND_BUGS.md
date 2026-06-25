# Job Card Redesign + Bug Backlog (Maribel, 2026-06-25)

Source-of-truth so this doesn't get lost (like the console plan once did). Mockup
versions rendered in-session: `qleno_job_card_redesign`, `_v2`, `_v3` (recoverable
from the transcript widget code).

## Job card redesign (the dispatch `JobPanel` in `jobs.tsx`) — BUILD FIRST

Sal: the current card feels cramped. Agreed v3 layout, top→bottom:
1. **Header:** client name with a **zone-color dot beside it** (so the zone reads
   at a glance even when the open card covers the timeline chip — logistics calls);
   zone name in the subtitle next to the service type. `⋮` + `×` top-right. Status
   pills (Scheduled / Residential) below.
2. **Summary tiles:** Billed · **Commission (editable)** · Hours. Commission tile is
   a control (mint + pencil), not a readout.
3. **Pay basis · this job (Bug #6):** segmented toggle **Commission % ↔ Hourly**,
   live-recomputes the commission; **"set custom amount"** for a manual override.
4. **Rows (no redundant left icons):** time (with Edit), address → **Directions**
   (Google Maps) link, phone with **Call + Message** buttons, assigned cleaner with
   their **real photo** (avatar_url; initials fallback) + "Primary cleaner" + Add tech.
5. **Cleaner notes** textarea. **Actions:** Mark Complete (mint) / Start Job, then
   Duplicate / Reschedule / Cancel.

### Wiring requirements (what makes it real, not a mockup)
- **Commission edit → pays out everywhere.** Ride the EXISTING per-tech
  `job_technicians.pay_override` (already persisted via a PATCH endpoint and already
  consumed by payroll as `finalPayOverride` in payroll-compute). NEW: the pay-basis
  (commission% vs hourly) per-job toggle on top of it. Three commission sources of
  truth must stay consistent (`routes/dispatch.ts`, `routes/payroll.ts`,
  `lib/commission.ts`) — never inline a basis.
- **Address → Google Maps** directions link (job has lat/lng + address).
- **Tech photo:** dispatch already returns `avatar_url`; show it.
- **Call → Dialpad.** No integration today (all call buttons are `tel:`). Phes uses
  **Dialpad**; wire their click-to-call API (rings the agent's Dialpad, then bridges
  the customer). Needs a **Dialpad API key in Railway env** (secret — Sal pastes,
  like R2) + mapping office users → Dialpad accounts. Build with a `tel:` stub, flip
  to Dialpad when the key lands. (API is usually Pro/Enterprise tier — confirm plan.)
- **Message → Qleno SMS.** Job panel already has an SMS composer; wire the button to
  send + **log the thread to the client profile + the Messages page** (uses the
  existing sms.ts / communication-log.ts / comms-inbound.ts). Blocked on
  `COMMS_ENABLED` (currently OFF — the July-1 comms decision).
- **Reuse the whole card in the client profile / calendar** (her "very important"
  ask): clicking a job in `customer-profile` opens THIS editable panel, not just
  void/cancel. Same component, two mount points.
- Bug #6 use case: Alejandra & Lupe should default to **hourly**; today Maribel
  re-edits their commission to hourly daily. Connects to the greenlit pay-basis
  switch ([[project_pay_basis_switch]]) — build as ONE thing.

## Bug backlog — work AFTER the card
- **#7 — "Appliance Combo" add-on is non-removable.** It's forced onto jobs; must be
  **optional/removable** (per-job add-on removal, like the other add-ons). Find the
  combo add-on logic that auto-attaches / blocks removal.
- **#8 — Default note pollutes "Today's Job Notes — this visit only."** Text
  "Service Set: Hourly Standard Cleaning | Default · Start: 9:00 AM" is auto-injected
  into many jobs' per-visit notes. Stop auto-adding it (likely the recurring/job
  generator stamping a service-set/start line into the visit-note field).
- **#9 (enhancement) — Account-health / profitability score is too narrow.** Should
  factor **refunds, redos, contact tickets** into the score, not just scorecards.

## Also queued (from earlier today)
- July-1 cutover: Sal connects Oak Lawn QuickBooks; comms on/off decision; delete the
  Schaumburg test invoice. App-wide **mobile layout pass** ([[project_layout_standard]]).
  Commercial console **inline editing** ([[project_commercial_console]]).
