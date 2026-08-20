# Customer Portal — Design

Source of truth for the customer-facing portal build. Read before touching
`routes/portal.ts`, `lib/portal-auth.ts`, or anything under `/portal` in the
frontend.

Status: **design agreed 2026-08-05.** Security fix (§3) shipped. Steps 2, 3,
4, 6, 7 (Google) and 8 of §8 are built (2026-08-20); commercial capabilities
(step 5) and Apple sign-in are still open. §9 covers the residential account
surface and how a hold reaches it.

---

## 1. What exists today, and why it isn't the finished thing

A portal shipped 2026-07-01 (`routes/portal.ts`). It is real and wired up:
`POST /api/portal/login` (email + bcrypt password), `/me`, `/jobs`, `/rate`,
keyed on `clients.portal_access` + `clients.portal_password_hash`.

Two gaps against what the business needs:

1. **It only understands a residential client.** Identity is a `clients.id`.
   A commercial contact at a property-management company is an
   `account_contacts` row belonging to an `accounts` row that owns many
   buildings. There is no way to express "this person, that account, those
   45 buildings" in the current model.
2. **Password-only.** No signup, no reset, no Google, no Apple.

## 2. The one rule this document exists to protect

> **One identity system. Two capability sets.**

Signup, login (password / Google / Apple), reset, session issuance, and office
impersonation are built ONCE and shared. What a signed-in person may *see* and
*do* is a separate lookup driven by what they're attached to.

Do NOT build a second portal for commercial. The reason is not tidiness — it is
that authorization scoping is the failure mode of customer-facing code, and it
fails **silently**. Nothing errors; the wrong person simply receives an answer.
One login surface means one place to get it right and one place to test it.
Two surfaces means every endpoint added forever has to be correct in both.

§3 is what that failure looks like in practice.

## 3. The leak this build starts from (FIXED 2026-08-05)

`POST /api/portal/login` signed a NORMAL application JWT, differing from a staff
token only by `role: 'portal_client'`. `requireAuth` — the guard on every staff
endpoint — admitted any verifiable token, special-casing only `accountant`.

Roughly **320 staff routes are guarded by `requireAuth` alone**, with no
`requireRole`, and they scope their queries by `req.auth.companyId` only.
`GET /api/invoices/:id` filters on invoice id + company id and nothing else. So
a logged-in customer could increment invoice ids and read every other
customer's invoice in the tenant; `GET /invoices/:id/pdf` served the document.

Fixed in `lib/auth.ts` by rejecting `role === 'portal_client'` inside
`requireAuth`. Chosen there because the defect is the ABSENCE of a check on
hundreds of routes — an allowlist would have to stay perfect forever, while one
rejection is provably total. Pinned by `tests/portal-token-isolation.test.ts`.

**Invariant, do not reverse:** a portal session must never satisfy `requireAuth`.
Anything the portal legitimately needs gets an explicit `/api/portal/*` route
that scopes to the caller's own client/account. If you find yourself wanting to
let a portal token through a staff route, you are about to reopen this hole.

## 4. Identity model

Portal identity moves OFF `clients` and into its own tables. A portal user is a
person who logs in; what they can reach is an attachment, not their identity.

    portal_users
      id, company_id, email, name
      password_hash        NULL for social-only accounts
      client_id            NULL unless residential
      account_contact_id   NULL unless commercial
      is_active, email_verified_at, last_login_at, created_at

    portal_identities            one row per linked provider
      id, portal_user_id, provider ('google' | 'apple'), subject
      UNIQUE (company_id, provider, subject)

    portal_tokens                short-lived, single-use, hashed at rest
      id, portal_user_id, kind ('verify' | 'reset' | 'magic' | 'impersonation')
      token_hash, expires_at, used_at, issued_by_user_id

Rules:
- Exactly one of `client_id` / `account_contact_id` is set. That single column
  is what every portal query scopes by — never a value from the request body.
- `email` is unique per company, not globally: the same person may be a customer
  of two tenants.
- Tokens are stored **hashed**. A leaked database row must not be a usable
  reset link.
- The legacy `clients.portal_*` columns are migrated into `portal_users` and
  then left alone. They are not a second source of truth.

## 5. Capabilities — the two sets

Resolved by one function, `portalCapabilities(user)`. Every portal route asks it
rather than re-deriving "is this commercial?" inline.

| Capability            | Residential | Commercial |
|-----------------------|-------------|------------|
| View own visits       | yes         | yes, across all buildings |
| View schedule         | yes         | yes |
| Rate a clean          | yes         | no |
| View invoices         | own         | whole account |
| Download invoice PDFs | single      | single + bulk zip |
| Pay an invoice        | yes         | yes |
| Buildings list        | n/a         | yes |
| Request service       | yes         | yes |
| Submit a referral     | yes         | no |
| View agreement        | yes         | no |
| Manage hold           | yes         | no |
| Manage contacts       | no          | primary contact only |

Residential "Request service" was `later` in the original table. It shipped
2026-08-20 alongside the account surface in §9; the office queue that answers it
is `/service-requests`.

Commercial bulk download reuses `lib/zip.ts` and `buildInvoicePdfBuffer` behind
a portal route scoped to the caller's `account_id` — the office endpoint is NOT
reachable with a portal token (§3).

## 6. Authentication

- **Password** — signup, verify email, login, reset. Works with no third-party
  configuration; this is the floor.
- **Google / Apple** — OAuth. Config lives in env vars and each provider is
  **inert until its vars are set**, exactly as Square is gated today. Google
  needs a Cloud Console client id/secret; Apple needs a paid Developer account,
  a Services ID, and domain verification. Neither blocks the password path.
- Linking: signing in with a provider whose verified email matches an existing
  `portal_users.email` links a `portal_identities` row to that user rather than
  creating a duplicate. Only ever on a **verified** provider email.
- Sessions are portal-audience tokens (§3) and are short-lived.

## 7. Office "view as customer"

Mirrors the existing employee View-as and `admin.ts` company impersonation.

- Office/owner/admin only, per-tenant, always written to the audit log with who
  and which customer.
- Issues a short-lived portal token via `portal_tokens` kind `impersonation`,
  carrying the impersonating staff user id.
- The portal renders a persistent banner and an exit control, like the existing
  admin impersonation banner.
- **Read-only.** An impersonated session may not pay, may not request service,
  may not change contacts. Support staff walking a customer through a screen
  must never be able to spend that customer's money.

## 8. Build order

1. ~~Token isolation fix + tests~~ — done 2026-08-05.
2. ~~Schema + migration; backfill existing `clients.portal_*` users.~~ — done.
3. ~~Password auth: signup, verify, login, reset, session.~~ — done.
4. ~~Portal shell + residential capabilities.~~ — done 2026-08-20, and it went
   past parity: see §9.
5. Commercial capabilities: buildings, account invoices, bulk download. OPEN.
6. ~~Office view-as, read-only, audited.~~ — done. Reachable from an account
   contact (`account-detail.tsx`) and from a residential customer's Portal
   Account tab (`customer-profile.tsx`).
7. Google — done, inert until `GOOGLE_CLIENT_ID` is set. Apple OPEN.
8. ~~Request service → office queue as a pending request.~~ — done 2026-08-20.

Each step is its own PR. Step 1 ships alone and ahead of the rest: it closes a
live hole and must not wait on the feature work.


---

## 9. The residential account surface (built 2026-08-20)

Step 4 was written as "parity with today's portal". What shipped is larger,
because parity was not the problem: the customer could see three cards and had
to telephone the office for everything else.

### What the customer can reach

One screen, `pages/portal/dashboard.tsx`, with seven sections:

| Section          | Reads                                            |
|------------------|--------------------------------------------------|
| Home             | `GET /api/portal/me`, `/jobs`, `/plan`           |
| Schedule         | `GET /api/portal/jobs`                           |
| Billing          | `GET /api/portal/invoices`, `/invoices/:id/pdf`  |
| My Plan          | `GET /api/portal/plan`, `/hold/preview`          |
| Request Service  | `GET`+`POST /api/portal/service-requests`        |
| Refer a Friend   | `POST /api/portal/referrals`                     |
| Tip My Cleaner   | `POST /api/portal/tip`                           |

Two rules hold this together and must survive any addition to that file:

1. **Every screen reads an `/api/portal/*` route scoped to the session's own
   client.** Never reach for a staff endpoint with a portal token — §3 refuses
   it by design, and wanting to means the portal is missing a route.
2. **Capabilities decide what renders**, from the `capabilities` block on
   `GET /me`. It already accounts for a read-only support session, so a hidden
   control is one the server would refuse anyway. Never re-derive "is this
   commercial" or "is this impersonated" in a component.

`GET /jobs` returns two separate windows (`upcoming`, `past`) rather than one
flat page. It used to be a single 20-row window ordered by date descending,
which meant a customer with more than 20 past visits saw none of their upcoming
ones — the one thing they open the portal for.

`GET /me` returns an explicit column whitelist. It used to `select()` the whole
`clients` row: about 83 columns, including alarm codes, home-access notes,
internal office notes, suspension reasons, Stripe and Square handles, and the
raw invite and unsubscribe tokens. All of it went to the browser.

### Holds and the termination notice

`GET /plan` and `POST /hold` put the agreement's pause rules in front of the
customer (engine: `lib/service-hold.ts`, contract terms: §5 and §9 of the
residential agreement). The load-bearing rule:

> **Nothing that moves money is self-executing.** A pause inside the free
> allowance the customer takes themselves. A pause that exceeds it *is* a
> termination notice under the agreement, so it bills the visits their own
> cadence would have had in the notice period. That one the customer can preview
> and request, and only the office can execute: `POST /hold` returns **202** and
> a request id, never a completed hold.

The preview names the cadence, lists the actual dates, and totals the dollars
before the customer can send it. Do not add a path that skips that screen.

### The office side

| Surface                                   | What it does |
|-------------------------------------------|--------------|
| Customer profile → Portal Account tab     | invite, resend, password reset, turn access on/off, view-as |
| Account detail → contacts                 | same, for a commercial contact |
| `/service-requests`                       | the queue that answers Request Service |

The profile tab reads `GET /api/portal/auth/status`, not the legacy
`clients.portal_*` columns. Those columns stopped being the truth when login
moved to `portal_users`, and a tab reading them showed an active account for a
login that had been switched off. They are migrated and then left alone (§4);
they are not a second source of truth.

`/service-requests` deliberately does not create jobs. Booking means a price, a
cleaner, a slot and a rate card, and that already lives in the job and quote
flow. The office books the work normally and then records which job answered the
request, or declines with a note the customer reads. A request that goes quiet
is worse than a no.
