# Employee Tickets — Spec & Build Estimate

**Status:** Spec only. Nothing built or merged. For Sal's review + the decisions
listed at the bottom.

---

## Plain-English summary (for Sal)

Today's "tickets" are about **customers** — the office logs a breakage, complaint,
or compliment against a client/job, and nobody gets pinged. This feature adds a
**separate** kind of ticket: an **employee** taps "Report an issue" in their phone
app, types a short subject + description (optionally tagged to a job), and hits
send. The moment they do, the **whole office team and you** get an alert. The
office sees these in a simple inbox, works them, and marks each **Resolved** — with
an optional note that goes back to the employee.

It's deliberately built to look and behave like the time-off request flow we just
shipped (employee submits → office is alerted → office acts → status updates), so
we're reusing proven parts rather than inventing new ones. **In-app (bell) alerts
work immediately; the email/text versions turn on whenever you flip the company
comms switch** — same as time off.

Realistic build: **about 3–4 working days** for a solid first version (add ~1 day
if employees can attach photos). A few small decisions from you are at the end.

---

## Goal & scope

Let an employee raise an issue/ticket from the field app that fans out to the
office team + owner, and give the office a place to triage and resolve it.

**In scope (v1):** employee "Report an issue" form (subject + description + optional
job link); a dedicated employee-issue ticket type kept apart from customer tickets;
office + owner alert on submit; office inbox with open → resolved status; optional
resolved-note back to the employee; employee can see their own tickets + status.

**Out of scope (v1, future):** threaded back-and-forth chat on a ticket, SLA timers,
assignment to a specific person, categories beyond a simple list, analytics. Noted
at the end.

## What we reuse (already live in prod)

- **The office+owner fan-out:** `notifyOfficeUsers(companyId, …)` in
  `lib/notify.ts` already alerts every owner/admin/office user at once (in-app +
  push + email), gated by the comms switch. This is the exact piece that powers the
  time-off "Action required" alert — we point it at tickets too.
- **The employee alert:** `notifyUser(…)` (same file) sends the one-to-one in-app +
  push + email — reused for the "your ticket was resolved" message.
- **The end-to-end pattern:** the time-off request flow (`routes/leave.ts` +
  `lib/leave-notifications.ts` + the `leave-review` office page + the field-app
  "My Time Off" page) is a near-exact template for submit → notify → triage →
  status.
- **File storage** for photos already exists (Cloudflare R2; client attachments use
  it today) — only relevant if we include the photo option.

We do **not** reuse the customer `contact_tickets` table — employee issues stay in
their own table so HR/ops matters never mix into the customer-complaint records or
reports.

## Data model — new `employee_tickets` table

| Field | Meaning |
|---|---|
| `id` | ticket id |
| `company_id` | tenant (scopes everything, like all tables) |
| `raised_by_user_id` | the employee who opened it |
| `subject` | short title |
| `body` | the description |
| `category` | simple dropdown (see Decision 1) — e.g. equipment, pay, scheduling, safety, other |
| `job_id` | optional link to a job |
| `status` | `open` → `resolved` (optionally `acknowledged` in between — Decision 3) |
| `resolved_by_user_id`, `resolved_at`, `resolution_note` | filled when the office resolves |
| `created_at`, `updated_at` | timestamps |
| *(optional)* `attachments` | photo file references, only if Decision 2 = yes |

Multi-tenant scoped by `company_id` like everything else.

## API endpoints (mirrors the leave-request routes)

Employee (any authenticated tenant user, scoped to themselves):
- `POST /api/employee-tickets` — create (subject, body, category, optional job_id).
  On success → fan out the alert (below).
- `GET /api/employee-tickets/mine` — the employee's own tickets + statuses.

Office/owner (role-gated to owner/admin/office, like the leave review page):
- `GET /api/employee-tickets` — inbox; filter by status (open/resolved).
- `POST /api/employee-tickets/:id/resolve` — mark resolved + optional note → notify
  the employee.
- *(optional)* `POST /api/employee-tickets/:id/acknowledge` — if we keep an
  in-between "seen it" state (Decision 3).

## Notifications

- **On submit →** `notifyOfficeUsers(companyId, { type: "employee_ticket", title:
  "New issue from <employee>", body: <subject>, link: "/employee-tickets" })`.
  Every owner/admin/office person (that's the office team **and** you) gets the
  in-app bell alert immediately; the email/text versions ride the same call and
  start sending once the company comms switch is on — exactly like time off.
- **On resolve →** `notifyUser(…)` to the employee: "Your issue '<subject>' was
  resolved" + the optional note (in-app/push now; email/text with comms on).
- No new notification plumbing is written — both calls already exist and are proven.

## Frontend

**Employee app (field):**
- A **"Report an issue"** button (e.g., on the home/My-Jobs or profile screen) →
  opens a small form: subject, description, optional "related job" picker, and
  (if Decision 2 = yes) an "add photo" button.
- A **"My issues"** list showing each ticket's status and the resolution note when
  closed — same shape as the "My time-off requests" list.

**Office app:**
- An **Employee Issues inbox** page (Open / Resolved tabs) listing tickets with who
  raised it, when, the subject/body, the job link, and a **Resolve** button with an
  optional note — modeled on the existing leave-review page.
- A **menu/sidebar link** to it for office/owner. (Note: we should also add the
  matching menu link for the time-off review page, which is built but currently
  reachable only by its address.)

## Build estimate (realistic)

| Piece | Effort |
|---|---|
| New table + migration (idempotent, multi-tenant) | ~0.5 day |
| API endpoints (create, mine, inbox, resolve) | ~0.5–1 day |
| Wire the two notifications (reuse) | ~0.25 day |
| Employee form + "My issues" list (field app) | ~0.5–1 day |
| Office inbox page + menu link | ~0.5–1 day |
| Tests + QA + dry-run/deploy | ~0.5 day |
| **v1 total** | **~3–4 working days** |
| Photo attachments (if Decision 2 = yes) | **+~1 day** |

This is a contained feature: one new table, ~5 endpoints, two small screens, and
the notifier is already done — which is why the estimate is modest.

## Decisions Sal needs to make

1. **Categories.** What short list should the dropdown offer? Suggestion:
   *Equipment/supplies · Pay/hours · Scheduling · Safety · Other.* (Or start with
   just "Other" and no dropdown to keep it dead simple — your call.)
2. **Photos.** Can employees attach a photo (e.g., a broken vacuum)? Storage
   already exists; it adds ~1 day. Yes/no for v1.
3. **In-between status.** Do you want an "Acknowledged/Seen" step between Open and
   Resolved, or just **Open → Resolved**? (Simpler = just the two.)
4. **Who is "the office team + Sal"?** The alert goes to every owner/admin/office
   user. Confirm that's the right audience (it's the same group that gets the
   time-off alerts). Want it to also notify a specific person every time
   regardless of role?
5. **Can the office open a ticket on an employee's behalf** (e.g., someone calls
   it in)? Easy to allow; just confirm.
6. **Does the employee see status changes?** Default yes — they see their own list
   update and get the "resolved" message. Confirm that's wanted.
7. **Schaumburg (co4) too, or Oak Lawn only?** This is generic/multi-tenant, so it
   can apply to both branches — confirm scope.

## Notes / future (not v1)
Threaded comments on a ticket, assigning a ticket to a specific office person, SLA/
overdue flags, and a small "open issues" count on the office dashboard are natural
follow-ons but intentionally left out of the first version to keep it tight.
