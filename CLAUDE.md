# Qleno — Project Rules for Claude Code

## Project
- **Name:** Qleno — multi-tenant SaaS for residential cleaning businesses
- **Company:** Phes
- **Live app:** https://workspaceapi-server-production-b9d4.up.railway.app
- **GitHub:** salmartinez-design/qleno, branch main
- **Replit:** clean-ops-pro.replit.app — backup only, do not deploy from here

## Design docs
- `docs/COMMERCIAL_BILLING_DESIGN.md` — multi-day scheduling + weekly invoicing
  + cancellation policies + effective-dated rate changes. Source of truth for
  AI / AJ / AK sessions. Read before touching commercial billing code.

## Tech Stack
- Frontend: React 18, Tailwind CSS, Vite, Wouter (routing)
- Backend: Node.js, Express 5, TypeScript
- Database: Supabase Postgres, RLS enabled, Drizzle ORM, multi-tenant scoped by company_id
- Payments: Stripe (new bookings), Square (existing Phes clients only)
- Comms: Twilio (SMS), Resend (email)
- Hosting: Railway (production), auto-deploys from GitHub main

## Brand & Design System — NON-NEGOTIABLE
- Font: Plus Jakarta Sans ONLY — never any other font
- Background: #F7F6F3
- Cards: #FFFFFF
- Primary text: #1A1917
- Borders: #E5E2DC
- Accent: Electric Mint #00C9A0, Qleno Night #0A0E1A
- No dark mode — ever
- No emojis anywhere in the UI

## Pricing
- Solo: $100/mo
- Team: $200/mo (2–15 employees)
- Pro: $250/mo (16+ employees)

## Branch Routing
- `getBranchByZip` routes all comms (SMS, email, assignments) to Oak Lawn vs Schaumburg based on zip code
- Every communication must go through this function — never hardcode a branch

## Code invariants
- **Assignment mirror**: any code that writes to `job_technicians` MUST also
  mirror the primary tech onto `jobs.assigned_user_id`. The dispatch grid
  reads `jobs.assigned_user_id`, NOT `job_technicians`. Failure to mirror
  creates a split-brain (chip in Unassigned row even though a tech is
  actually assigned). All four entry points enforce this:
  - `PATCH /api/jobs/:id` (modal save) — mirrors team_user_ids[0]
  - `POST /api/jobs/:id/technicians` (drawer Add Team Member) — promotes
    new tech to primary on unassigned jobs and mirrors
  - `DELETE /api/jobs/:id/technicians/:techId` — promotes next remaining
    tech on primary removal and mirrors (NULL if none remain)
  - `PUT /api/jobs/:id` (drag-and-drop quick-reschedule) — only writes
    `assigned_user_id` directly; doesn't touch `job_technicians`. Acceptable
    because PATCH is the canonical full-edit path.
- **Tenant-managed commercial service types**: the dropdown in the
  edit-job modal's commercial branch reads from `commercial_service_types`
  (NOT a hardcoded constant). Each row has a `slug` matching a
  `jobs.service_type` Postgres enum value. When users add a new type via
  `POST /api/commercial-service-types`, the server slugifies the name,
  validates against `^[a-z][a-z0-9_]*$`, and runs
  `ALTER TYPE service_type ADD VALUE IF NOT EXISTS '<slug>'` (idempotent,
  outside transaction) before inserting the row. Soft-delete only
  (`is_active=false`) — historical jobs that reference a deactivated slug
  continue to render correctly via their `service_type` string.
  Slugs are immutable after creation. Setting page:
  `/settings/pricing` → "Commercial Service Types" section. Default
  hourly rate pre-fills the modal's hourly rate field on selection but
  does NOT update `clients.commercial_hourly_rate` — per-client default
  rate flow from AH stays untouched.
  *(AI.4)* Legacy/inactive `service_type` values are NOT auto-displayed
  in the dropdown — the `(current) <slug>` fallback option is removed.
  When a job has a `service_type` that isn't in the active tenant-managed
  list, the modal opens with NO service type selected and shows
  "Service type required" with Save disabled until the user picks a real
  current type. This forces explicit migration of legacy values and
  prevents silently re-saving outdated slugs.
- **Parking fee per-occurrence on recurring schedules**: configured at the
  schedule template level via three columns on `recurring_schedules`:
  `parking_fee_enabled` (bool), `parking_fee_amount` (numeric, null = use
  tenant default), `parking_fee_days` (int[], null = apply to all
  scheduled days; 0=Sun..6=Sat to match `days_of_week`). The recurring
  engine, when generating each child job, looks up the tenant's
  Parking Fee row in `pricing_addons` (by name, case-insensitive) and
  INSERTs a `job_add_ons` row when `parking_fee_enabled` AND
  (`parking_fee_days` IS NULL OR includes that occurrence's weekday).
  `parking_fee_amount` overrides the addon's default when set.
  Per-job override stays via the existing edit-job modal Add-ons section
  (PATCH replaces all `job_add_ons` rows on save), so office can flip
  parking on or off for any individual generated occurrence without
  touching the schedule template. Day picker only renders for multi-day
  frequencies (daily/weekdays/custom_days); single-day frequencies hide
  it because there's only one weekday per occurrence.
- **Auto-promote to primary**: when a tech is added via
  `POST /api/jobs/:id/technicians` to a job that has NO existing primary
  (typical: first Add Team Member on an unassigned job), the server
  promotes the new tech to `is_primary=true` by default. Callers override
  with explicit `is_primary: false` (helper/trainee workflows where the
  primary is set later). The default is what the dispatch UI almost always
  wants — without it, `jobs.assigned_user_id` stays NULL and the chip
  stays in the Unassigned row even though job_technicians has a row. Any
  new code path that writes `job_technicians` should preserve this default
  and only pass `is_primary: false` for deliberate non-primary intent.
- **Mobile risk-first dashboard (Jobs page)**: the mobile branch of
  `/jobs` is NOT a calendar — it's a dispatch dashboard. Layout order,
  top-to-bottom: header (date nav + "New Job"), sticky weekly summary
  card (total revenue + 7-bar chart with day labels and per-day revenue
  subtotals; tap a bar to jump focal day), Needs Attention strip
  (renders ONLY when isToday && there are late clock-ins / unassigned /
  missing-address jobs — never render an empty strip), location + zone
  filter row, TODAY/focal section with full `MobileJobCard`s, then
  UPCOMING with one row per other day collapsed by default. Tapping an
  UPCOMING row lazily fetches that day via `loadDayData()` (cached in
  `dayDataCache` keyed by date) and renders compact 44px-min rows
  (status bar + time + client name + tech-or-Unassigned + amount).
  Week summary feeds from `GET /api/dispatch/week-summary` which
  returns `{ from, to, days: [{date, job_count, revenue,
  unassigned_count}], total_jobs, total_revenue, total_unassigned }`
  for a Sun..Sat window (default = current week containing today, or
  pass `?from=YYYY-MM-DD&to=YYYY-MM-DD`). Desktop Gantt path is
  unchanged. Do NOT regress mobile back to a single-day list — the
  weekly chart + risk strip is the orientation surface and removing it
  forces operators to date-step blind.
- **Commission engine routing**: residential and commercial commissions
  use DIFFERENT bases — they are not interchangeable, and the wrong
  label on a commercial job is a hard bug, not a stylistic miss.
  Routing is on `!!jobs.account_id` (true = commercial). Bases:
  - Residential: `commission = jobTotal × companies.res_tech_pay_pct`
    (default 0.35). Pre-clock-in: equal split among assigned techs.
    Post-clock-in: proportional by actual minutes.
  - Commercial: `commission = companies.commercial_hourly_rate ×
    allowed_hours` (default $20/hr). Same split structure as
    residential. The hours signal honors
    `companies.commercial_comp_mode` ('allowed_hours' default,
    'actual_hours' when clock data is the source of truth).
  The frontend Commission panel (`jobs.tsx` JobPanel) reads
  `commission_basis` ('commercial_hourly' | 'residential_pool') from
  the dispatch payload to choose the label. The "Pool rate: 35% of
  job total" label MUST NOT render on commercial jobs — show
  "Hourly rate: $X/hr × Y hrs" instead. Estimated hours displayed in
  the panel come from `allowed_hours`, NOT the stale `estimated_hours`
  stamp (which is set at job creation and never updated on edit).
  All three surfaces enforce this routing:
  - `routes/dispatch.ts` (Commission panel data)
  - `routes/payroll.ts` /detail (payroll exports)
  - `lib/commission.ts` `calculateCommissionSplit(... basis)`
    (quote-builder)
  When adding a new commission surface, branch on `account_id` and
  delegate to one of these three sources of truth — never inline
  `× 0.35` or `× 20` again.
- **Job visual status — single source of truth**: every card surface
  (dispatch Gantt chip, list view, drag overlay, mobile MobileJobCard,
  mobile UPCOMING compact rows, my-jobs tech view) routes through
  `getJobVisualStatus(job, now)` in `lib/job-status.ts`. Returns one of
  nine canonical states; consumers compose the matching
  `STATUS_VISUALS[state]` (stripe color, body opacity, badge,
  strikethrough, desaturate, border override, car-icon flag) onto their
  card. New surfaces MUST NOT re-derive status from `job.status`
  directly.
  | State            | Trigger                                                                                  | Treatment                                                                  |
  |------------------|------------------------------------------------------------------------------------------|----------------------------------------------------------------------------|
  | scheduled        | default — no later state matches and now < scheduled_start_time OR no live signal        | Default tech color, full opacity                                           |
  | en_route         | en_route_at IS NOT NULL, no clock-in (inert until field-app column lands)                | Default tech color + animated side-profile car icon left of name           |
  | active           | clock_in_at && !clock_out_at, OR status='in_progress'                                    | Tech color + 4px amber (#F59E0B) left stripe + 2px orange ring (#EF9F27)   |
  | late_clockin     | today + now ≥ scheduled_start_time + 20 min, no clock-in, no manual no-show              | Existing red 2px border + LATE pill with dynamic minute count              |
  | no_show          | no_show_marked_by_tech IS NOT NULL (manual flag set by field-app "No Show" button)       | Solid dark-red border + "NO SHOW" badge, 85% opacity                       |
  | completed        | status='complete', not online-payment-unpaid                                             | Tech color at 60% opacity + green checkmark badge                          |
  | completed_unpaid | status='complete', payment is stripe/square, charge_succeeded_at IS NULL                 | 60% opacity + amber ring (#BA7517) + UNPAID pill + green checkmark         |
  | cancelled        | status='cancelled'                                                                       | Tech color desaturated to grayscale + strikethrough on title               |
  | unassigned       | assigned_user_id is null                                                                 | Amber border, full opacity                                                 |
  Active stripe animation uses CSS keyframes (`qleno-active-stripe-pulse`,
  2 s ease-in-out, 1.0 → 0.6 → 1.0). En-route car uses
  `qleno-en-route-drive` (translateX 0 → 1.5px, 0.8 s ease-in-out).
  `prefers-reduced-motion` drops both to steady. Inject once per
  session via `ensureJobStatusStyles()` from any component that mounts
  a card. The Legend popover (`components/legend-popover.tsx`) shows
  all nine states with example tiles + descriptions; mounted from the
  dispatch top bar's Legend button (desktop popover, mobile bottom
  sheet).
  Late + en_route are derived from time + columns, NOT stored. no_show
  IS stored (manual flag) — the field app's "No Show" button writes
  `no_show_marked_by_tech` (and `_by_user_id`) when the tech has waited
  long enough on-site for the customer. The DB job_status enum stays
  `scheduled | in_progress | complete | cancelled` — DO NOT add new
  enum values; operational state lives in the clock entry + scheduled
  time + the manual flag, not the status column.

  *(phes-lifecycle 2026-04-29)* Phes-specific simplifications:
  - Single 20-minute threshold for `late_clockin` (was 5/30 split).
    `LATE_THRESHOLD_MINUTES = 20` and `NO_SHOW_WAIT_MINUTES = 20`
    hardcoded in `lib/job-status.ts`. Multi-tenant later →
    `tenant_settings.late_threshold_minutes` /
    `.no_show_wait_minutes`.
  - `no_show` is a MANUAL flag (`no_show_marked_by_tech`), not
    time-derived. Set by the field-app "No Show" button only. Until
    the button ships the column stays null and no_show never fires
    in production.
  - **Hard scheduled-start gate**: nothing negative (late_clockin /
    en_route-as-late) fires before `scheduled_start_time`. A future
    job is always SCHEDULED. The William Rosenbloom regression
    (chip painted late before start time elapsed) is closed by the
    explicit `nowMins >= startMins + LATE_THRESHOLD_MINUTES` check
    in `getJobVisualStatus` and the matching guard on the page-level
    `lateClockIns` / `atRisk` counters.
  - Semantic: LATE = tech accountability ("where's the tech?"). 
    NO_SHOW = customer accountability ("where's the customer?").
    Both share the 20-minute wait threshold but represent different
    things — they're not interchangeable.
- **Address display — single canonical format**: every surface that
  renders an address MUST route through
  `formatAddress(street, city, state, zip)` in `lib/format-address.ts`.
  Format: `"<street>, <city>, <state> <zip>"` — comma + space between
  street/city/state-zip, single space between state and zip.
  **If address is shown, zip MUST be shown.** No exceptions.
  Do NOT inline `${address}, ${city}` concatenations — they always
  end up dropping zip + state. The dispatch API server returns a
  pre-formatted `address` string already in canonical shape (via the
  inlined `fmtAddr()` in `routes/dispatch.ts`), so consumers can
  render `{job.address}` directly. For surfaces that receive raw
  fields (customer profile, my-jobs, leads, hot-sheet, jobs-list,
  job-wizard property pickers), call `formatAddress()` explicitly.
  When data is missing (zip null on import), render whatever's
  available — the gap is then visible to the operator. Don't paper
  over with a default.
- **Job zone resolution — every job must surface its zone**: the
  dispatch SELECT resolves a job's zone via this priority chain:
  (1) `jobs.zone_id` direct join,
  (2) `jobs.address_zip` → `service_zones.zip_codes`,
  (3) `clients.zip` → `service_zones.zip_codes`,
  (4) `account_properties.zip` → `service_zones.zip_codes`,
  (5) regex-extracted 5-digit zip from any address text.
  A gray (zone-less) tile is a data error. Diagnose with
  `GET /api/dispatch/zone-coverage-audit?from=YYYY-MM-DD&to=YYYY-MM-DD`
  which returns failures segmented by root cause:
  `a_no_zip` (client missing zip entirely),
  `b_zip_outside_zones` (zip exists but doesn't match any zone),
  `c_other` (reserved). Do NOT bulk-assign unmatched zips to a default
  zone — fix the underlying client zip data or extend zone coverage.
  Phes data migration backfills `clients.zip` and `account_properties.zip`
  from any 5-digit pattern in the address text on every cold-start
  (idempotent, only fires when zip IS NULL).
  *(AI.7.7)* The `clients.*` backfill is multi-source: walks the
  client's most-recent `jobs.address_zip` first (the per-job override
  the MC import populated when `clients.*` was empty), falls back to
  parsing the zip out of `jobs.address_street`, then parses
  `clients.address`. State defaults to `IL` for Phes when the source
  doesn't provide one. **There are NO address columns on
  `recurring_schedules`** — historical assumption to the contrary
  led to AI.7.6 still leaving Geraldine / Pegah / Connie / Daveco
  with NULL zip until this fix landed. If a future spec refers to
  `recurring_schedules.service_address` or `recurring_schedules.zip`,
  flag it — those don't exist; the carrier is `jobs.address_*`.

## Hard Rules — Never Reverse
- No QuickBooks bidirectional sync — QB is write-only (Qleno pushes to QB, never pulls)
- Square is for existing Phes clients only — new bookings always use Stripe
- Schaumburg branch does NOT migrate from MaidCentral
- Seed files must always use ON CONFLICT DO UPDATE — never plain INSERT
- COMMS_ENABLED=false gate must never be bypassed — all SMS and email are suppressed until explicitly flipped to true in Railway env vars
- EXCEPTION: Contact form at /api/contact must bypass COMMS_ENABLED gate — it is a direct inbound lead, not an automated communication
- Never mix the Ares project with Qleno/Phes

## Database Rules
- All data scoped by company_id — every query must filter by company_id
- Always dry-run before any destructive DB operation
- RLS is enabled on Supabase — test queries with the correct role

## Known Bugs — Fix Before May 12
1. ~~Booking widget add-on ID mapping~~ — FIXED (dynamic lookup by name)
2. ~~Zone check failing for valid zips (e.g. 60805)~~ — FIXED (branchRouter updated)
3. Loyalty discount auto-applying with no code entered — OPEN (discount migration will fix)
4. Recurring job anchor dates landing on Monday instead of correct day — OPEN (timezone bug in parseDate)
5. ~~"Cook County" prefix showing in address display~~ — FIXED (no such logic exists)
6. ~~Callback button not clickable on Very Dirty flow~~ — FIXED (fully functional)
7. ~~"onetime" showing instead of "One Time" in booking summary~~ — FIXED (wLabel mapper)

## Session Notes — 2026-04-16
### Quote Builder Changes
- Wizard step order: Customer Info → Service & Pricing → Property Details → Add-ons & Notes → Review
- Quick Re-Book panel on Service & Pricing step (shows last 3 services for existing clients)
- Scopes grouped by: One-Time/Flat Rate, Recurring, Hourly, Commercial
- Hourly = single card with sub-type selector (Standard, Deep Clean, Move In/Out, Other)
- Commercial hidden for residential clients (filtered by client_type)
- Schedule & Assign section on Review step (date picker, time dropdown, tech pills)
- Convert endpoint creates actual job with date/time/tech assignment
- Address verification skipped for existing clients with known addresses
- Google Maps API key must be passed to Vite build: `source .env && GOOGLE_MAPS_API_KEY=$GOOGLE_MAPS_API_KEY pnpm run build`

### Commission System
- calculateCommissionSplit() utility at artifacts/qleno/src/lib/commission.ts
- 35% rate, equal split pre-clock-in, proportional by minutes after clock-in
- Displayed in Price Preview sidebar (single and multi-scope)
- Still needs: quote detail, job detail, dispatch board, My Jobs (tech view)

### Zone Colors
- All 18 zones synced to MaidCentral colors (2026-04-16)
- Zone dots in global search and quote builder client search
- Duplicate zone: "Tinley/Orland Park/Palos Park" vs "Tinley/Orlando/Palos Park" — clean up

### Pending Next Sessions
1. Discount Migration from MaidCentral (25 rows across 6 scopes, replace placeholders)
2. Jobs Page Full Build + Dispatch KPI Strip (full spec saved)
3. Frequency change revenue impact display (monthly/annual gain/loss)
4. Smart tech availability check (fires after date selected in Review)
5. UI cleanup: inline address verification, collapsible call notes
6. Recurring job timezone bug fix (parseDate local vs UTC)

## Session Notes — 2026-04-30

### Architecture-pass + ops hardening

Big day. Architecture-pass PRs landed earlier (#22 JobWizard two-level
picker, #24 parking-day-picker single-day-frequency hide, #25 cascade
create_recurring, #26 array-binding fix on the cascade INSERT). Then
the ops-hardening batch and a frequency-on-completed-anchor fix:

- PR #30 — `chore: verify backups on + document disaster recovery` —
  added `docs/disaster-recovery.md` runbook + a static `[backup-check]`
  reminder console.log on cold start. NO RAILWAY_API_TOKEN — doc-only
  per Q1.1 = (a). RPO/RTO baseline documented as Railway Hobby defaults
  (≤24h / ~30min); Phes can tolerate.
- PR #31 — `chore: pre-deploy schema drift verification` — added
  `src/scripts/verify-schema.ts` (one-way Drizzle-ahead-of-DB check
  per Q2.1 = a) wired into the boot sequence via top-level `await` +
  dynamic import. **REVERTED via PR #36** (see outage below).
- PR #32 — `feat: cascade dry-run mode for destructive operation
  preview` — added `dry_run: true` flag to PATCH `/api/jobs/:id`
  (counters-only per Q3.1 = a, write-then-rollback via
  DryRunRollback sentinel + `.catch()` chain). Frontend Preview button
  gated by `CASCADE_PREVIEW_ENABLED` via new
  `GET /api/config/feature-flags` endpoint (default off). **Live on
  main.**
- PR #33 — `feat: skip cascade picker when edit only touches schedule-
  template fields` — `FIELD_SCOPE_CLASSIFICATION` constant in
  `edit-job-modal.tsx` separates schedule-template fields (frequency,
  days_of_week, scheduled_time, allowed_hours, service_type,
  hourly_rate, base_fee, add_ons, parking_fee_*) from single-occurrence
  fields (team_user_ids, instructions, scheduled_date). Template-only
  edits auto-cascade `this_and_future`. Mixed edits show picker with
  amber footnote per Q1 = (c). **Live on main.**
- PR #34 — `fix: cascade_scope=this_and_future on completed anchor
  returns 200` — addressed Sal's "client completes Mon + calls Tue
  morning to change schedule going forward" workflow. Hard-lock at
  `routes/jobs.ts:902-917` was rejecting frequency changes on
  completed jobs regardless of cascade scope; fix made it scope-aware,
  stripped lock-protected fields from anchor `setParts` when
  cascading template/future, surfaced `anchor_protected` /
  `anchor_skipped_fields` / `schedule_updated` in response, added
  persistent in-modal error banner with verbatim API copy.
  **REVERTED via PR #35.**

### Production-down outage + recovery

Around end of session, `app.qleno.com` returned Railway 502
"Application failed to respond" — api-server failed to boot.

Sequence:
1. PR #34 deployed → 502 reported.
2. PR #35 (revert PR #34) merged at Sal's instruction (newest-first
   revert order). 502 persisted.
3. PR #36 (revert PR #31) merged. **Production restored.**

Root cause: PR #31's schema-drift verification at boot. Most likely
specifics (need Railway log forensics tomorrow to confirm):
- top-level `await` + dynamic `await import("./scripts/verify-schema.js")`
  in `src/index.ts` BEFORE `app.listen()` introduced an async boot
  edge case
- OR esbuild's bundler in Railway's Docker build resolved the dynamic
  import differently than locally, causing module-load failure
- OR the schema-introspection queries against `information_schema`
  hit a permission/timeout issue on prod that didn't repro locally

Lesson: a verifier that gates boot is asking for a 3am outage even in
`warn` mode if the verifier itself can throw before the try/catch
engages. Future iteration of this idea (if pursued) should run AFTER
`app.listen` so the healthcheck passes regardless, or run as a
separate post-deploy CI step rather than a runtime check.

### Net state of `main` after the dust settled

Live on main:
- PR #30 (DR docs + boot reminder) — kept
- PR #32 (cascade dry-run) — kept; backend always live, frontend
  gated by `CASCADE_PREVIEW_ENABLED`
- PR #33 (picker-skip / FIELD_SCOPE_CLASSIFICATION) — kept

Reverted:
- PR #31 (schema drift) — caused outage; reverted via #36
- PR #34 (cascade-409 fix on completed anchor) — reverted via #35
  during triage. Original problem (409 on Sal's "client called Tue
  to change schedule" workflow) is BACK. Re-implementing carefully
  is on tomorrow's plate.

Held with conflicts:
- **PR #27** (cascade-overwrite-existing-future-jobs + dispatch
  LEFT JOIN + days_of_week field) — opened earlier in the session
  but never merged. Conflicts against current main in
  `artifacts/api-server/src/routes/jobs.ts` (with #32's dry-run
  sentinel + .catch() chain) and `artifacts/qleno/src/components/
  edit-job-modal.tsx` (with #33's FIELD_SCOPE_CLASSIFICATION + save
  routing). Resolution requires reading both sides carefully and
  reconciling the cascade block + the modal save handler. **Held
  for tomorrow.**

### Open issues filed (not for tonight)

- #23 — JobWizard defaults to residential picker for non-hybrid
  commercial clients opened from customer profile
  (`job-wizard.tsx:346`)
- #29 — `GET /api/jobs/4147` returns 500 (likely NULL field
  assertion in response builder; surfaced during PR #29 picker-bug
  diagnosis)

### Tomorrow's first task

**Resolve PR #27 conflicts and merge.** Both conflict zones are
manageable with careful reading; the cascade-overwrite-in-place
behavior is the actual fix Sal needs to confirm Jaira's Tue-Fri
imported jobs get UPDATEd in place when she edits Monday. After PR
#27 lands and verifies, re-implement PR #34's frequency-on-completed-
anchor fix on top.

### Cadence rules locked-in this session

- `code-only verification on Claude's end (build clean, tsc net-zero,
  line-by-line diff). Sal runs the modal flow / curl repros / SQL
  queries post-deploy.` — standing rule, applies to every PR going
  forward without re-confirmation.
- `Auto-merge enabled by Claude when gates pass.` Repo-level
  Settings → General → Allow auto-merge currently OFF, so Claude
  invokes `mcp__github__merge_pull_request` directly after opening
  Ready. Sal's gating list still applies (>400-line diff, files
  outside spec, new env/dep, API contract change, design uncertainty,
  destructive schema → pause + ping).
- `Code-only verification was the working cadence. Bake it in for
  every PR going forward without me having to re-confirm each time.`
  — Sal, 2026-04-30.

## Dev Workflow
- Edit locally in Claude Code
- Verify changes work at localhost:3000 before pushing
- Push to GitHub: `bash push-to-github.sh 'message'`
- Railway auto-deploys from main branch — no manual deploy needed

## Scoped-commit discipline (when the working tree has unrelated uncommitted work)

This session has often had uncommitted work from prior prompts sitting in the working tree. Commits for a new prompt must NOT sweep up that unrelated work. The naive `git stash --keep-index` pattern is not enough on its own — here's the correct workflow:

**Problem:** `git stash --keep-index -u` only moves UNSTAGED changes. If you run `git add file.ts` on a file that already has uncommitted changes, those older changes go into the index alongside your new ones and end up in the commit.

**Correct workflow for scoped commits when working tree has unrelated uncommitted work:**

1. `git status --short` — inventory everything unclean
2. **For files where your new work is co-mingled with prior uncommitted work** (e.g. you added a column to a schema file that also has 148 other uncommitted lines from Session 1):
   - `git checkout HEAD -- <file>` — discard ALL uncommitted changes in that file (they go to /tmp or the other backups, not the stash — you lose them if you don't save first)
   - BEFORE the checkout, copy the file elsewhere: `cp <file> /tmp/<file>.full`
   - Re-apply ONLY your new hunks via Edit
   - After commit succeeds: `cp /tmp/<file>.full <file>` to restore the co-mingled state
3. **For files where your new work is the only change**, just `git add <file>` directly — safe
4. Once all target files are staged cleanly, `git stash push --keep-index -u -m "prompt-N-stash"` stashes everything else
5. `git diff --cached --stat` — sanity check shows ONLY expected files + line counts
6. If the stat looks wrong (extra files or inflated line counts), STOP and unstage
7. Commit + push
8. `git stash pop` to restore the other uncommitted work

**Never trust the stash to protect files that had both staged and unstaged changes simultaneously.** The staged content stays in the index; the stash only captures the unstaged portion. You end up committing content you didn't intend to.

**Quick check:** after `git add` and before `git stash`, run `git diff --cached --stat`. If a file shows +150 lines when you only wrote 3, you have a co-mingled file. Fix it before stashing.

This workflow has been followed cleanly in commits: 7d1c836, d21db36, 7f27299, 1f3d7d2.

## Start Local Dev
- Tab 1 (API): `PORT=5000 BASE_PATH=/ npx tsx --env-file=.env artifacts/api-server/src/index.ts`
- Tab 2 (Frontend build): `cd artifacts/qleno && PORT=5000 BASE_PATH=/ pnpm run build`
- Tab 3 (Serve): `npx serve artifacts/qleno/dist/public -p 3000`
- View at: http://localhost:3000

## Environment
- `COMMS_ENABLED=false` in Railway env vars — do not change without explicit instruction
- `DATABASE_URL` points to Railway Postgres — never copy dev DB to production
- `PORT` is injected by Railway at runtime — do not hardcode
