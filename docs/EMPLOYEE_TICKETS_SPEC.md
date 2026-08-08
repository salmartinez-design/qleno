# Employee Equipment & Supply Requests — Spec & Build Estimate

**Status:** Spec only. Nothing built or merged. **Lower priority** — the time-off
request flow (separate spec / PR #613) ships first. Kept as a draft for later.

> Re-scoped 2026-06-22: this was originally written as a generic "employee issue
> ticket." Sal clarified it's specifically an **equipment & supply request**
> feature (an employee's vacuum broke, they need parts, or new uniform shirts/
> pants). The time-off "ticket" flow he also described is a *different* thing and
> is specced separately (PR #613). This doc now covers equipment/supply only.

---

## Plain-English summary (for Sal)

A cleaner in the field needs something — their **vacuum broke and needs replacing**,
they need **vacuum parts**, or **new uniform shirts/pants**. They tap "Request
equipment/supplies" in the phone app, pick what they need, add a short note (and
optionally a photo), and send. The **office team and you** get an alert. The office
sees these in a simple inbox, orders/handles them, and marks each **Done** — with an
optional note back to the employee.

It reuses the same proven alert system as time off (notifies every owner/admin/
office person at once), so it's a contained add.

---

## Goal & scope

Let an employee request equipment/supplies from the field app; alert the office
team + owner; give the office an inbox to fulfill and close them.

**Categories (Sal-confirmed):** replacement vacuum · vacuum parts · uniform shirt ·
uniform pants · other. (Free-text note always; optional photo — Decision below.)

## What we reuse (already live)
- **Office+owner fan-out:** `notifyOfficeUsers(companyId, …)` — the same notifier
  used by time off (in-app + push + email, gated by the comms switch).
- **Employee "it's handled" message:** `notifyUser(…)`.
- **The whole submit → alert → inbox → resolve pattern** mirrors the time-off flow.
- **File storage** (R2) already exists if we include the optional photo.

Kept entirely separate from the customer `contact_tickets` and from time off.

## Data model — new `employee_supply_requests` table

`id`, `company_id`, `raised_by_user_id`, `category` (vacuum / parts / uniform_shirt /
uniform_pants / other), `note`, optional `photo` ref, `status` (open → fulfilled),
`fulfilled_by_user_id`, `fulfilled_at`, `resolution_note`, timestamps. Multi-tenant
by `company_id`.

## API (mirrors the leave-request routes)
- `POST /api/supply-requests` (employee) → create + fan-out alert to office + owner.
- `GET /api/supply-requests/mine` (employee) → own requests + status.
- `GET /api/supply-requests` (office) → inbox, filter by status.
- `POST /api/supply-requests/:id/fulfill` (office) → mark done + optional note → notify employee.

## Frontend
- Employee app: **"Request equipment/supplies"** button → form (category dropdown +
  note + optional photo) and a "My requests" list with status.
- Office app: an **inbox** (Open / Fulfilled tabs) with a Fulfill button + optional
  note; a menu link for office/owner.

## Build estimate
**~3–4 working days** for v1 (+~1 day if photos are included). It's the same shape
as the time-off flow, so most of the pattern is copy-and-adapt.

## Decisions for Sal (when this comes up)
1. **Photos** — let employees attach a photo of the broken item? (+~1 day.)
2. **Uniform sizes** — capture shirt/pants size on the request, or handle in the
   note? (A size field is a small add.)
3. **Status steps** — just Open → Fulfilled, or add "Ordered" in between?
4. **Audience** — alert all owner/admin/office (same as time off); confirm.
5. **Both branches** (Oak Lawn + Schaumburg) or one?

## Notes
Deliberately deferred behind the time-off flow. Threaded comments, vendor/PO links,
and inventory tracking are possible later but out of scope for v1.
