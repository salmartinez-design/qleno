# Qleno UI Consistency Audit — 2026-07-22

Method: live crawl of https://app.qleno.com in Chrome, logged in as owner (Oak Lawn / Phes).
Every route was screenshotted and probed with a computed-style tally (font-family, radius,
border color/width, shadow, container width/padding, heading scale, button fills).

Routes audited: `/dashboard` `/dispatch` `/customers` `/leads` `/accounts` `/invoices`
`/payroll` `/employees` `/time-clock` `/messages` `/reports`

---

## 1. The systemic problems (app-wide)

### 1.1 The brand accent is not in the product
CLAUDE.md declares Electric Mint `#00C9A0` as the accent. **Mint appears on exactly two
buttons in the entire app** (`+ New Account`, `+ New message`). The de-facto accent
everywhere else is a blue, `rgb(91,155,213)` / `#5B9BD5`, which is not a brand color at all:

| Surface | Accent used |
|---|---|
| Branch/company chips (`Oak Lawn`, `Phes`) | `rgba(91,155,213,0.15)` |
| Add Client / Add Team Member / New Invoice / Export | `#5B9BD5` |
| Revenue-chart line, Techs-Today bars, efficiency rings | `#5B9BD5` |
| Voice FAB (floating, every page) | `#5B9BD5` |
| Accounts `+ New Account`, Messages `+ New message` | `#00C9A0` (mint) |
| Top-bar `+ New` | `#1A1917` (near-black) |

So there are **three competing primary-button treatments** — black, blue, mint — visible
on the same screen. Plus strays: `rgb(29,78,216)` (NET 30 badge, invoices) and
`rgb(15,118,110)` teal (efficiency %, employees).

**Fix:** pick one. Mint is the brand answer; blue is the de-facto answer. Whichever wins,
it needs to be a single token and every one of the above has to consume it.

### 1.2 Corner radius has no scale
Measured per page: dashboard 12/10 · customers 8/10 · leads 8 · invoices 10 ·
payroll 10/8 · employees 10/8/12 · reports 10 · time-clock 12.
Buttons add 6px, 8px, 10px, 20px and 50%.

**Fix:** two radii — `10px` card, `8px` control. Pills stay `999px`.

### 1.3 Border and shadow tokens leak
Border is `0.625px rgb(229,226,220)` (= #E5E2DC) almost everywhere — good — except:
- `/leads` uses `rgb(232,229,224)` (a second, near-identical gray)
- one `/invoices` card uses `rgba(91,155,213,0.4)`
- shadows are `none` app-wide *except* one payroll card (`0 1px 2px rgba(0,0,0,.03)`)
  and a leads red ring (`0 0 0 2px rgba(220,38,38,.12)`)

Single stray values like these are exactly what reads as "not enterprise" — they aren't
decisions, they're leftovers.

### 1.4 Page-header pattern differs on every page
- **Two H1s** on Customers: top bar says "Customers", body says "Clients". Two names
  for the same object.
- Top bar "Lead Pipeline" vs body "Leads"; top bar "Jobs" vs route `/dispatch`.
- `/leads` renders its **own dark navy header bar with its own Q logo and its own tab
  row** — no other page does this. It looks like a different product.
- Invoices / Payroll / Employees have **no body H1 at all**; Dashboard, Accounts,
  Reports, Time Clock, Messages do.
- H1 weight varies: 22px/700 (Reports, Employees) vs 22px/800 (Time Clock).
- H2 varies: 13px/700 (Reports) vs 16px/800 (Employees).

### 1.5 Four different KPI-strip patterns
| Page | Treatment |
|---|---|
| Dashboard | 4 separate white cards, each with a different tinted fill |
| Accounts | 4 separate white cards, icon + label + value, no fill |
| Invoices | 4 separate white cards, **4 different value colors in one row** |
| Payroll / Time Clock | ONE bordered strip, values separated by rules |
| Dispatch | full-bleed, no card, no container at all |

Same information class, five looks.

### 1.6 `/dispatch` ignores the layout standard
Every page renders inside `max-width:1600px; padding:28px`. `/dispatch` has **no
container, no cards, no page padding** — the probe returned `container: null` and empty
radius/border tallies. It is the most-used screen in the app and the only one outside
the design system.

### 1.7 Number colors are arbitrary
Invoices KPI row: Outstanding = dark, Overdue = red, Paid = green, YTD = blue — four
colors, one row, no rule. Payroll: commission blue, labor% green, rest dark. Employees:
score blue, efficiency teal, and one row breaks its own rule (14px/700 blue where every
sibling is 11px/700 teal). Dashboard mixes dark and green numerals with no semantic.

**Fix:** color means *status* (good/warn/bad) or it means nothing. Right now it means
nothing, so it costs the operator a beat on every read.

### 1.8 Badge/label type scale drifts
Badges are 11px nearly everywhere; the `/leads` "REPLIED" chip is **8.5px/800** — below
readable minimum and unique in the app.

---

## 2. The main page (Dashboard) — design defects

Order on screen today: hero greeting → TODAY'S STATUS → LEADS · TODAY → OFFICE REMINDERS
→ DAILY REVENUE / NEW JOBS BOOKED → KEY NUMBERS → Revenue chart + Techs Today →
BUSINESS HEALTH → REVENUE FORECAST → RECENT ACTIVITY → COMMERCIAL ALERTS.

1. **Grid column counts don't align down the page.** Measured: 4-col (377px) → 4-col
   (380px) → 2-col (768px) → 4-col (375px) → 3-col (505px) → 7-col (205px). Gaps are
   12 / 8 / 8 / 14 / 14 / 10px. Nothing lines up vertically; the eye never finds a
   column edge. This is the single most visible "not enterprise" tell on the page.
2. **TODAY'S STATUS tiles are inconsistently treated.** Tile 1 is plain white; tiles 2–4
   are tinted blue/green/red; only tile 4 has a left stripe. Four tiles, three
   treatments. Also "0 COMPLETE" is tinted *green* (success) while it's the bad number
   at 6pm — the color is arguing against the data.
3. **Revenue chart doesn't fill its card.** The plot occupies the top ~55%; the bottom
   ~45% of the card is empty. Next to it, Techs Today is full-height — so the row reads
   broken.
4. **Chart x-axis is truncated** — final label renders `Jul '2` (clipped), and the
   current-month line runs off the right edge under the YTD label.
5. **Two revenue numbers disagree in the header.** Hero says "REVENUE THIS WEEK $16.4k";
   Revenue Forecast says "$14,002 booked · 55 jobs" for Jul 19–25 — the same week.
   Both are labeled plainly, neither explains the delta.
6. **DAILY REVENUE / NEW JOBS BOOKED is an orphan 2-col row** sitting between two 4-col
   rows, with a much taller cell height than any other card. It reads as a leftover.
7. **RECENT ACTIVITY is broken as shipped:** every one of the 15 rows says "just now";
   rows repeat ("Job #8741 updated" ×4, "Job #5966 updated" ×3); the deleted-job row is
   the only one missing the chevron (correct behavior, wrong presentation — it now looks
   like a rendering bug); and raw event keys leak to the operator ("Job #8460 job
   discount.remove"). It consumes ~1.5 screens of the dashboard to say nothing.
8. **OFFICE REMINDERS occupies a full-width card to display empty state** with example
   text, above the revenue numbers. Empty state should not outrank live money.
9. **BUSINESS HEALTH labels are un-anchored.** "RATE TREND −0.96%", "PAYROLL % 36.4%",
   "RETENTION 78%" — no target, no benchmark, no direction indicator. −0.96% is red,
   78% is green, 36.4% is black; the operator can't tell which of the three needs action.
10. **COMMERCIAL ALERTS is buried at the very bottom** — below 15 rows of noise — yet it
    contains the only genuinely urgent item on the page: "Charge failed". And that row
    reads `Charge failed — Account: $0.00 at unknown address`, i.e. null account name,
    $0 amount, no address. An alert that can't name what failed isn't an alert.
11. **Section labels are inconsistent in case and separator** — `TODAY'S STATUS`,
    `LEADS · TODAY` (middot), `KEY NUMBERS`, `BUSINESS HEALTH`, `RECENT ACTIVITY` vs
    in-card titles in sentence case (`Revenue — Last 12 Months`).
12. **Interactivity is unsignposted.** `Open pipeline →`, `Clock Monitor ›`, `View all →`
    are three different affordance styles for the same "go deeper" action, and the KPI
    cards themselves don't indicate whether they're clickable (some are).

---

## 3. The main page — information that is missing

For an owner opening this at 7am, the page does not answer the questions that matter:

**Money / risk**
- **A/R and aging.** Zero receivables on the dashboard. Outstanding, 30/60/90 buckets,
  and who owes the most live only on `/invoices`. For an owner this is the #1 number.
- **Unpaid completed jobs.** The `completed_unpaid` state exists in the job-status system
  and is invisible here.
- **Cash collected today/this week** vs revenue booked. Booked ≠ collected.
- **Gross margin / job costing.** Payroll % is present, but not revenue − labor.
- **Payroll liability for the open period** (what's owed right now if we ran payroll).

**Today's operations**
- **Nothing at risk is shown.** Late clock-ins, no-shows, unassigned-with-hours-left,
  jobs with missing addresses — all exist in `getJobVisualStatus` and on mobile's
  "Needs Attention" strip, but the desktop dashboard shows only a raw "0 UNASSIGNED"
  count with no drill-in. The mobile Jobs page is more risk-aware than the main page.
- **Schedule capacity for tomorrow / rest of week.** "41 open slots" appears inside the
  Techs card without context (open slots against what target?).
- **Time-clock exceptions** — outside-zone punches (Time Clock shows several today),
  missing clock-outs, GPS mismatches. Not surfaced.

**Growth**
- **Conversion rate.** Leads · Today shows counts (7 new / 1 online / 6 office / 7 booked)
  but no quote→book rate, no funnel, no trend vs last week.
- **Pipeline value.** "Quoted 35" is a count; the dollars behind it aren't shown.
- **Churn / cancellations this week** — the retention number is a static 78% with no
  movement, and cancellations don't appear at all.
- **Reviews / satisfaction / performance score** — the 90-day composite exists in the
  product and never reaches the dashboard.

**Structural**
- **No date-range control.** Every number is a different implicit window (today / this
  week / last 30 days / 12 months / MTD) with no way to change any of them, and several
  cards don't state their window at all ("MONTHLY REVENUE −36%" — vs what?).
- **No branch comparison.** Oak Lawn vs Schaumburg is a top-bar filter, not a view.
  An owner cannot see both branches at once anywhere in the app.
- **No drill-through contract.** Some tiles navigate, some don't, and none say which.

---

## 4. Recommended fix order

1. **Tokenize** — one accent, two radii, one border, one shadow, one number-color
   semantic. Purge `#5B9BD5`/teal/`#1D4ED8` strays. (Mechanical, highest visible payoff.)
2. **One page-header component** — icon + H1 + subtitle + right-aligned actions, adopted
   by all 11 routes; kill the `/leads` navy header and the Customers/Clients double-H1.
3. **One KPI-strip component** — one treatment, used by Dashboard, Accounts, Invoices,
   Payroll, Time Clock, Dispatch.
4. **Bring `/dispatch` inside the container/card system.**
5. **Rebuild the dashboard on a single 12-column grid** with one gap value, and re-rank
   it: risk first (commercial alerts + at-risk jobs), then money (A/R, collected,
   margin), then today's ops, then growth, then activity — activity last and capped at 5.
6. **Fix the data defects** the redesign will expose: "just now" timestamps, duplicate
   activity rows, the null-name charge-failed alert, the truncated chart axis, and the
   $16.4k vs $14,002 week-revenue disagreement.
