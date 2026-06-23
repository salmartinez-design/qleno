# Time-Off Request "Ticket" Flow — Spec & Build Plan

**Status:** Spec only. Nothing wired up or merged. Awaiting Sal's preview pick +
go. This is the flow Sal actually meant by "ticket" — it **supersedes** the
generic employee-issue spec (PR #611), pending his confirmation to close that one.

Preview mockup for the dashboard widget: `docs/timeoff-dashboard-widget-preview.html`.

---

## Plain-English summary (for Sal)

An employee requests time off (a bucket + hours) from their phone. That instantly
becomes a **request the office sees on the dashboard** and gets an alert about. The
office opens it, sees what the employee wrote (and any **doctor's note** attached),
and **approves or declines**. On approval the employee is notified, they're **marked
off on the dispatch schedule** for those exact dates/hours, the pay + balance update,
and the whole thing is **logged** in the company audit trail and on the employee's
own profile.

Most of this already works (submit, approve/decline, notify, pay, balance, and the
board can already show a tech as off). The remaining build is: the **dashboard
widget**, **attachments**, **full date-range + four distinct bucket colors on the
board**, and the **audit/profile logging**.

---

## The 6 steps — built vs. gap (from the code)

| # | Step | Status |
|---|------|--------|
| 1 | Employee picks bucket + hours, submits | ✅ built (`/leave`, `POST /api/leave/requests`) |
| 2a | Alert to office team + owner on submit | ✅ built (in-app/push now; email/text on comms switch) |
| 2b | Request shows as a ticket on the dashboard | ❌ **build** — dashboard widget (see preview) |
| 3a | Office opens it, populated with the request | ✅ built (the `leave-review` page) — needs a menu link |
| 3b | Attachments (doctor's notes) | ❌ **build** — see attachments section |
| 4 | Office approves / declines | ✅ built |
| 5a | Employee notified on decision | ✅ built |
| 5b | Marked off on the dispatch schedule | ⚠️ **partial** — board already renders time-off; needs full date-range + 4 distinct buckets |
| 6 | Logged in audit log + employee profile | ⚠️ **partial** — profile shows leave usage; **global audit log not written** |

## Attachments — the explanation Sal asked for

"Who attaches" means **where in the flow a file (like a doctor's note) gets added:**

- **(a) Employee at submit** — on their phone, they snap a photo / pick a file when
  they send the request. Best for doctor's notes the employee already has.
- **(b) Office on the review screen** — the office adds the file later (e.g. the
  employee emails/texts it in and the office files it against the request).
- **(c) Both** — employee can attach at submit; office can add or replace on review.

**Recommendation: (c) both.** It costs little extra over doing one, and it covers
every real case — the employee attaches their note up front, and the office can
still add one when the employee hands it over later. → **Sal to confirm (c), or
pick a/b.**

## Locked decisions (folded into this spec)

- **#2 — Partial days = hours. CONFIRMED.** Employees can request either full days
  or a specific number of hours (e.g. 4h), drawn from the chosen bucket. **Multi-day
  requests block every day in the range** on the schedule (not just day one — that's
  a current limitation being fixed). The request form offers "full day(s)" or "set
  hours."
- **#3 — All FOUR buckets distinct on the board. LOCKED.** The four active buckets
  are **PTO**, **PLAWA (sick)**, **Unpaid Leave**, and **Unexcused**. Each shows on
  the dispatch board with its **own label + color** (PTO mint / PLAWA amber / Unpaid
  slate / Unexcused red — see preview), never a single generic "off." Note: Unexcused
  is **office-recorded** (not employee-requested), but still renders distinctly.
- **#5 — Logging in BOTH places. CONFIRMED.** Every submit / approve / decline writes
  to the **company-wide audit log** AND to a **time-off section on the employee's
  profile** (who/what/when/decided-by).

## Build plan for the gaps

1. **Dashboard widget (2b).** A "Time Off Requests" widget listing pending requests
   (name, bucket chip, dates/hours, "Dr. note" indicator, Approve/Decline), reading
   the existing `GET /api/leave/requests?status=pending`. Placement per Sal's preview
   pick (right rail vs. inline card). Add the matching menu link to the full review
   page. ~1 day (either placement).
2. **Attachments (3b).** New `leave_request_attachments` (file refs), reusing the
   existing upload/storage plumbing; attach on submit (employee) and/or on review
   (office) per the decision; show + open on the review screen + the dashboard
   widget's "Dr. note" indicator. ~1–1.5 days.
3. **Schedule placement (5b).** On approval, mark the tech off for **every date in
   the range** (today only the start date is written), and tag the **bucket type** so
   the board distinguishes all four. The dispatch board already renders time-off, so
   this is mostly extending what approval writes + the board's color map. ~1–1.5 days
   (incl. partial-hours display: a 4h request shows the tech as partially off that
   day — exact half-day vs. all-day display per Sal, see open items).
4. **Audit + profile logging (6).** Write an audit-log entry on submit/approve/
   decline and surface a richer time-off activity list on the employee profile.
   ~0.5–1 day.

## Combined effort

**~4–6 working days** for the full set (widget + attachments + schedule + logging),
on top of the already-shipped request/approve/notify/pay/balance engine.

## Open items before/while building

- **Attachments decision** — confirm "both" (recommended) vs. employee-only / office-only.
- **Dashboard placement** — pick Option A (right rail) or B (inline card) from the preview.
- **Partial-hours on the board** — a 4-hour request: show the tech **off all day**
  with an "AM/PM/4h" tag, or show them **partially available**? (Simpler = off-all-day
  with the hours noted.)
- **#611 fate** — confirm the generic employee-issue ticket spec is superseded /
  should be closed, or kept as a separate future feature.
