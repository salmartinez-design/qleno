# Office Update — What Changed (PRs after #890)

**Date:** July 5, 2026
**Covers:** Everything shipped after update #890 (PRs #891 through #902 — 12 changes)
**Audience:** Office team. Plain-English. No code.

Quick read: this batch cleaned up the **Invoices dashboard**, made **payroll/pay
numbers correct for commercial jobs**, gave **each employee a private "My Pay"
page**, added a **Revenue History report** (so we keep MaidCentral numbers after
we lose access), and made sure **every website booking and online quote now
shows up in Leads**.

---

## 1. Invoices Dashboard — cleaner and clickable

### #892 — Revenue numbers now show REAL Qleno money only
**What changed:** The "Paid (30d)" and "YTD Revenue" tiles were counting old
MaidCentral history that got imported with 2026 dates. That made YTD look like
~$140K when only ~$6.8K of it was actual Qleno revenue (about 95% was old
imported money). Those tiles now count **Qleno-native invoices only**.
**What it means for you:** The revenue tiles on the Invoices page are now
trustworthy. If the number looks "smaller" than before, that's correct — the
old number was inflated by imported history. (Old MaidCentral revenue still
lives in its own report — see #898 below.)

### #899 / #892 — The four summary cards now DO something when clicked
**What changed:** Outstanding, Overdue, Paid, and YTD were dead tiles. Now each
one filters the list to match when you click it (Outstanding → Sent, Overdue →
Overdue, Paid → Paid, YTD → All), clears the date range, and scrolls you to the
results. The active card gets a mint outline.
**What it means for you:** Click a tile to instantly see the invoices behind
that number instead of setting filters by hand.

### #891 — The "Not yet invoiced" panel stops making the page jump
**What changed:** Clicking through filters (Today / Week / Month / Drafts…) made
the page jump up and down because the "Not yet invoiced" panel appeared and
disappeared. That panel now always shows the **full residential backlog that
still needs billing** and stays put.
**What it means for you:** Filtering is smooth now. The "Not yet invoiced" panel
is your steady to-do list of residential jobs still waiting to be billed
(account/commercial jobs are excluded — they bill under their Account). It only
changes when you actually invoice a job.

### #895 — Void invoices no longer clutter the list
**What changed:** Voided (and superseded) invoices used to stay in the default
"All" view as dead rows. They're now hidden from the default list.
**What it means for you:** The working list is cleaner. Voided invoices aren't
deleted — they're kept for the audit trail — and you can still see them anytime
by choosing the **Void** filter.

---

## 2. Pay & Payroll — commercial numbers are now correct

> This group fixed a real money bug: commercial jobs were **overpaying techs**.
> If you ran or exported any payroll between roughly July 1–4, re-check it
> against the corrected numbers.

### #896 + #897 — Commercial pay = hourly rate × hours (not the billed amount)
**What changed:** Commercial jobs were paying the tech off the job's **revenue**
(what we bill the client) instead of **allowed hours × the tech's hourly rate**.
Real examples that were overpaying:
- National Able: paid $400, should be $160
- Cucci: paid $586, should be $100
- 4009: paid $417, should be $40
That was roughly **$1,600 of overpay over just July 1–3**. #896 fixed the main
pay engines; #897 fixed one remaining fallback path (used when a tech hasn't
clocked in or left the clock open), so the number is now the same everywhere —
paycheck export, time-clock grid, and dispatch panel.
**What it means for you:** Commercial pay is now correct across the board.
Residential pay was never affected. If you exported commercial payroll before
these landed, the old export was too high.

### #893 — Company payroll reports now match the actual paychecks
**What changed:** The Reporting screens (`/reports/payroll`, `/job-costing`,
`/payroll-to-revenue`) used a different, older calculation that ignored
allowed-hours jobs and only credited the primary tech — so helpers and
commercial jobs showed $0 or wrong amounts (e.g. Hilda showed $0 on a report
where she actually earned $430.21). Reports now use the **same engine that cuts
the real paychecks**.
**What it means for you:** The payroll/job-costing reports now reconcile to the
paychecks to the penny (verified: July 1–3 total = $3,620.02 on both). You can
trust the reports for helper splits and commercial jobs now.

### #894 — Time-clock pay grid shows the allowed-hours budget and stop time
**What changed:** Two additions to the pay grid: each allowed-hours pay line now
shows a chip with the job's **allowed-hours budget** (e.g. "20.84 allowed hrs"),
and jobs with no budget show an amber "no budget — paying actual" chip. The
schedule line now shows the full **window** ("sched 6:00 AM – 11:00 AM") instead
of just the start time.
**What it means for you:** You can see budget-vs-actual at a glance and spot jobs
that are missing an allowed-hours budget (the amber chip = someone needs to set
one).

### #900 — Employees get a private "My Pay" tab
**What changed:** Each employee now has a **My Pay** page (sidebar → My Day →
My Pay) that shows **only their own published pay** — recent periods plus YTD
totals, each expandable into a per-job breakdown. The system locks every tech to
their own record, so **one tech can never see another's pay**. It updates
automatically when you **Publish** payroll.
**What it means for you:** Fewer "what did I make?" questions — techs can self-
serve. Important: they only see a period **after you Publish it**. Nothing is
visible until Publish.

---

## 3. Reports — keeping our MaidCentral history

### #898 — New "Revenue History (MaidCentral)" report
**What changed:** We lose MaidCentral access on **7/11/2026**, so this report
preserves our pre-Qleno revenue permanently. It shows monthly revenue by branch
from April 2024 through December 2026, reconciled exactly to MaidCentral's own
report ($1,589,984.47 actual through June 2026). Rows are clearly labeled
Actual / Partial / Projected. Find it under the **Financial** report group →
"Revenue History."
**What it means for you:** After MaidCentral goes away we still have our
historical revenue for reference. This report is **kept separate from the live
Qleno revenue tiles on purpose** — so old money never gets mixed back into
current Qleno numbers (this is the flip side of the #892 fix).

---

## 4. Leads — every website booking and quote now creates a Lead

> Before this batch, some website submissions created a client/job but **never
> showed up in the Leads pipeline**, so they could be missed for follow-up.
> These three plug those holes.

### #901 — Commercial website bookings + walkthrough requests now create a lead
**What changed:** Only residential website bookings were creating a lead.
Commercial bookings and walkthrough requests made the client and job but **no
lead**, so they never appeared in Leads. Both now create a lead — commercial
booking comes in as "booked," walkthrough as "needs contacted."
**What it means for you:** Commercial web inquiries now show up in the Leads
pipeline for follow-up like residential ones do. Watch for walkthrough requests
landing as **needs contacted**.

### #902 — Online residential QUOTES now create a lead too
**What changed:** When someone got an online quote (entered contact, saw a price,
but didn't book), it only logged internally and emailed the office — it never
hit the Leads pipeline. Now it creates a **"needs contacted" lead** tagged as a
web quote.
**What it means for you:** Price-shoppers who didn't book are now trackable
leads to follow up on — a new source of warm leads in the pipeline.

### Deduping (part of #902) — one lead per person, not duplicates
**What changed:** If someone gets a quote and later books, the system now
**updates the same lead** instead of creating a second one. Status only moves
forward (quote → booked), never backward.
**What it means for you:** No duplicate lead rows for the same person as they
move from quote to booking. One person, one lead.

---

## Bottom line — what to actually do

- **Trust the Invoices revenue tiles again** — they now show real Qleno money,
  and you can click any tile to see the invoices behind it.
- **Re-check any commercial payroll run/export from ~July 1–4** — commercial was
  overpaying before these fixes; the corrected numbers are lower and now match
  across reports, the time clock, and paychecks.
- **Tell techs about My Pay** — they can see their own pay after you Publish.
- **Use the new Revenue History report** for anything that needs pre-Qleno /
  MaidCentral numbers, especially before we lose MaidCentral access on 7/11.
- **Work the Leads pipeline** — commercial bookings, walkthroughs, and online
  quotes now all land there for follow-up.

---

*Reference: PRs #891, #892, #893, #894, #895, #896, #897, #898, #899, #900,
#901, #902. Cutoff = everything after #890.*
