# Time-Off Request "Ticket" Flow — Spec & Build Plan

**Status:** Spec only. Nothing wired up or merged. Decisions locked except the
dashboard-placement pick (Sal is choosing from the preview); build starts on his
go. PR #611 is **kept** as a separate, lower-priority feature (employee equipment &
supply requests) — not the same thing as this time-off flow.

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
| 3b | Attachments (doctor's notes) — **required at submit** | ❌ **build** — mandatory employee upload; see attachments section |
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

**DECIDED (Sal): option (a), and MANDATORY.** The employee **must attach a file
when they submit** — it's a **required field**; the request can't be sent without
it (they photograph the doctor's note / file from their phone). The **office does
NOT attach** — there is no office-side upload on the review screen. So every
request that reaches the office already has its attachment.

*(One-line flag: "required on every request" is spec'd as Sal stated. A doctor's
note makes obvious sense for PLAWA/sick; if PTO/Unpaid shouldn't force a file, it's
a one-line change to require it for sick only — flagging, not re-deciding.)*

## Locked decisions (folded into this spec)

- **#2 — Full day / Morning / Afternoon (NO free-form hours). UPDATED per Sal.**
  The request form's unit is **Full day**, **Morning**, or **Afternoon** — there is
  **no arbitrary-hours entry**. A half-day draws half the bucket's daily hours.
  **Critically, a half-day leaves the tech AVAILABLE for the half they're working:**
  morning off → the board shows them **available in the afternoon** (and vice
  versa) — they are NOT blocked for the whole day. **Multi-day requests block every
  full day in the range.** So a request carries a per-day unit of
  full / AM / PM, and the board reflects the worked half.
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
   existing upload/storage plumbing. **Required at submit on the employee's phone —
   the submit button is disabled until a file is attached.** No office-side upload.
   Show + open the file on the review screen + the dashboard widget's attachment
   indicator. ~1–1.5 days.
3. **Schedule placement (5b).** On approval, mark the tech off for **every full day
   in the range**, tagged by **bucket type** so the board distinguishes all four.
   For a **half-day** (Morning/Afternoon), the board shows the tech off for that half
   and **available for the other half** — so the request carries a per-day
   full/AM/PM unit and the board renders the worked half as still-schedulable. The
   dispatch board already renders time-off, so this extends what approval writes +
   the board's color map + an AM/PM split. ~1.5 days.
4. **Audit + profile logging (6).** Write an audit-log entry on submit/approve/
   decline and surface a richer time-off activity list on the employee profile.
   ~0.5–1 day.

## Combined effort

**~4–6 working days** for the full set (widget + attachments + schedule + logging),
on top of the already-shipped request/approve/notify/pay/balance engine.

## Open items before/while building

- **Dashboard placement (ONLY open blocker)** — pick Option A (right rail) or B
  (inline card) from the preview. Build starts once Sal picks.
- ~~Attachments~~ — DECIDED: mandatory employee upload at submit.
- ~~Partial-day model~~ — DECIDED: Full day / Morning / Afternoon, available the
  worked half.
- ~~Logging~~ — DECIDED: company audit log + employee profile.
- **#611 — KEPT & reframed** (not closed): it's now the separate **employee
  equipment & supply request** feature (replacement vacuum, parts, uniform shirts/
  pants, other → routes to office + Sal, same inbox pattern). Lower priority; this
  time-off flow ships first.
