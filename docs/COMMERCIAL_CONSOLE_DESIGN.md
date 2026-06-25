# Commercial Accounts Console — Design (Layout B: master-detail)

> **Status (2026-06-24):** Designed + agreed (Sal picked Layout B). **Only "slice 1"
> shipped** — properties grouped by zone + search on the account detail page (#629).
> The full master-detail console below is **not yet built**. This doc exists so the
> plan can't get lost again (it previously lived only in a chat that got
> auto-summarized). Source-of-truth for the commercial console build.
>
> Mockups (rendered in-session, recoverable from the transcript widget code):
> `qleno_commercial_account_console_v2` (the console, Layout B),
> `qleno_commercial_layout_comparison` (A vs B), and
> `qleno_commercial_account_properties_layout` (earlier pass).

## The problem

The commercial account page is a flat list you navigate *away* from to do anything.
For a real portfolio (PPM = 45 buildings, KMA = 7, Cucci = 6) that means endless
scroll, losing your place every time you open a building, and no signal about what
actually needs attention tonight. The fix isn't decoration — the **interaction
model** is wrong.

## The decision — Layout B (master-detail console)

Compared two layouts; Sal chose **B**:

- **A — grouped scrolling list.** Properties grouped by zone, searchable. Simple,
  but still navigate-away to edit, and no "what needs me first."
- **B — master-detail console.** Pick a building on the left, see/edit it on the
  right, never lose your place (Stripe/Linear pattern). **Chosen.**

Why B wins even for small accounts: a 1-building account (Jennifer Halper) just shows
that one building selected — no downside. For a 45-building account it's the
difference between usable and not.

## The UI (from the agreed preview)

Three regions, top to bottom / left to right:

### 1. Exceptions strip (top) — "what needs you first"
A row of pills surfacing only what's actionable for this account, e.g.:
- `2 unassigned tonight` (red) — buildings with a visit today and no tech
- `56 uninvoiced` (amber) — completed visits not yet billed
- `COI · 9d` (amber) — certificate of insurance / compliance expiring soon

Tells the office what to *do*, not just what exists. Click a pill → filters the list
to those buildings.

### 2. Property list (left, ~248px) — dense + pivotable
- Search box ("Search 45 buildings…").
- **Pivot toggle: Zone | Service | Day | Tech** — regroup the same list by any of
  these (default Zone). Group headers are collapsible ("Gold Coast · 5",
  "Lincoln Park · 4 · collapsed").
- Each row: status dot (green ok / amber attention / red issue), address (truncated),
  primary cadence ("Weekly · Tue"), and hours.

### 3. Building detail (right, inline-editable) — never navigate away
Selected building shows, all on one pane:
- Flag banner if it has an issue ("No tech assigned for tonight").
- Address + zone + **Edit** affordance.
- Three metric cards: **Next visit · This month · Outstanding** (Outstanding tints
  amber when > $0).
- **Recurring services** — one card per service: name, rate ("$280 / visit" or
  "$15 / unit"), cadence + hours ("2×/wk · Mon, Thu · 4.0h"), assigned crew/tech
  (avatar). Unassigned shows a red "?" avatar.
- **Access notes** ("Alarm 8812 · use freight elevator", "Lockbox #2 · code 4471").
- Actions: **+ Add service · Skip a date · View invoices**.

### Responsive
Master-detail collapses to **list → bottom-sheet** on mobile (tap a building → sheet
slides up with the detail). Same data, phone-friendly.

## Data model (already exists — no new tables needed)
Built on the current `accounts` → `account_properties` → `recurring_schedules`
(per-site, with `account_id`/`account_property_id`/`service_address_*`) → rate cards
model. The console is a new *view* over data we already have.

## Phase-1 scope (as originally spawned)
> "Build the master-detail commercial console (Layout B): clean service types,
> commercial-only add-ons, per-building recurring with crews + per-unit/flat/hourly
> billing, and the generation engine."

Note: much of the **billing/engine** half already landed in this session —
per-site recurring scheduling (#639), monthly-batch billing (#637), and the
commercial commission routing (commission engine on `account_id`). So the **remaining
gap is mostly the console UI itself** plus the service-type/add-on cleanup.

## Build slices
- **Slice 1 — DONE (#629):** properties grouped by zone + search (account detail).
- **Slice 2 — DONE (#652):** master-detail shell — two-pane layout, left list +
  inline right detail, click-to-select, no navigate-away; mobile drills in.
- **Slice 3 — DONE:** exceptions strip (unassigned + uninvoiced, click-to-filter)
  + pivot toggle (Zone / Service / Cleaner). Derived on the frontend from the
  uninvoiced-jobs + jobs-calendar data (account_property_id, tech, date). COI is
  NOT built — there is no insurance-expiry data; needs a backend field first.
- **Slice 4 — DISPLAY DONE; inline-edit is the remaining backend gap:** the detail
  pane now shows Next visit + assigned Cleaner (from the calendar). The deeper
  master-detail editing — change a service's rate/cadence/crew, Add service, Skip
  a date — needs new per-property recurring-schedule endpoints (the account API
  has no per-building recurring summary or schedule-edit route yet). That's the
  next real build. (Edit-property and View-invoices already work via existing flows.)
- **Slice 5 — mobile DONE (via slice 2 drill-in + responsive strip/pivot).** The
  fancier bottom-sheet and the commercial service-type/add-on cleanup are polish,
  not blockers.

## Remaining after today
The console is complete and useful as a **read + navigate** surface. The one real
build left is **inline schedule editing in the detail pane**, which needs backend:
a per-property recurring summary (services with rate/cadence/crew/next-date) and
edit/add/skip endpoints. Plus optional COI tracking and service-type cleanup.

## Files
- Frontend: `artifacts/qleno/src/pages/account-detail.tsx` (slice 1 lives here;
  build the console here), `accounts.tsx` (outer list, unchanged).
- API: `artifacts/api-server/src/routes/accounts.ts`.
