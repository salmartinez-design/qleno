# Phase 5 — Write access

*Companion to `AI_ACCESS_DESIGN.md` (the parent spec) and
`AI_ACCESS_OAUTH_DESIGN.md` (how assistants sign in). This document covers the
one phase where an assistant stops answering questions and starts changing the
business.*

**Status: design only. No code. Not ready to build — see §10.**

---

## 1. What actually changes

Phases 1–4 shipped a read surface. The worst outcome available to an attacker
today is a wrong number on someone's screen. That is a real failure, but it is a
*reporting* failure: the dispatch board still says what it said, the customer
still gets the visit they booked, and nobody's card gets charged.

Write access removes that floor. From the moment `reschedule_job` exists, the
worst outcome is a customer standing in an empty house on Tuesday.

This is not an argument against building it. Sal chose read/write knowingly, and
the whole point of the feature is that a tenant can *run* their business through
an assistant rather than interview it. It is an argument that Phase 5 needs a
different kind of engineering than Phases 1–4 did — and specifically, that the
defense the parent spec leaned on does not hold up. §4 is about that.

---

## 2. The write surface: what is in, and what is deliberately not

The parent spec (§9) listed nine write tools. Building all nine at once is the
wrong shape, because they are not the same kind of operation. Three groups:

**Group A — reversible, internal, no outside party learns anything.**

| Tool | Effect |
|---|---|
| `reschedule_job` | Move one job's date/time |
| `assign_technician` | Set or change who is on one job |
| `add_job_note` | Append an office note to one job |
| `update_client_contact` | Phone, email, address on one client |

Every one of these is a column change a person could undo in ten seconds from
the existing UI. Nothing leaves the building. No money moves.

**Group B — outward-facing or financial. Not reversible in any meaningful sense.**

| Tool | Why it is different |
|---|---|
| `cancel_job` | The customer is told. A cancellation email is not un-sent |
| `send_message` | An SMS delivered is delivered |
| `create_invoice` / `send_invoice` | A customer sees a bill; QBO may receive a push |
| `charge_card` | Money moves |

**Group C — not built, in any phase, until there is a specific reason.**

Pricing (`base_fee`, `commission_base`, rates), payroll, commission
configuration, employee records, and anything touching `recurring_schedules`.

The reason for C is not squeamishness, it is blast radius. A wrong price on one
job is a wrong paycheck (`base_fee` drags `commission_base` — see
`project_commission_base_drift`), and a wrong `recurring_schedules` row is a
wrong price on every future occurrence of that series. These are the exact
places where this codebase has historically produced quiet, expensive, hard-to-
find drift. An assistant should not be the first thing to touch them.

**Recommendation: build Group A as Phase 5a. Hold Group B for 5b, after 5a has
run on real traffic.** The parent spec's rollout table already applies this
principle between phases; it just did not apply it *within* the write phase, and
the write phase is where it matters most.

---

## 3. The uncomfortable fact about `confirm: true`

The parent spec's second injection defense reads:

> Irreversible operations require an explicit `confirm: true` argument and are
> annotated `destructiveHint` in the MCP tool definition, so compliant clients
> surface a human prompt.

**`confirm: true` is supplied by the model.** If an injected instruction in a
client note can make the model call `cancel_job`, the same instruction can make
it call `cancel_job` with `confirm: true`. The argument is not a gate against
the attack it was written to stop. Against a *confused* model it helps; against
a *steered* one it is decoration.

What actually protects the tenant is the second half of that sentence — the
client surfacing a human prompt — and that half runs on someone else's
computer. Claude's connector UI has a per-tool "Needs approval" setting, and it
defaults to needing approval today. That is genuinely good. But it is Anthropic's
default, not Qleno's guarantee: the tenant can switch it to "Always allow" in two
clicks, ChatGPT and Gemini make their own choices, and none of it is visible to
our server. We cannot build a safety story on a control we neither own nor can
observe.

So `confirm: true` stays — it is free, it helps with honest mistakes, and
compliant clients do the right thing with it — but **it is not counted as a
defense.** Everything in §4 assumes it was bypassed.

---

## 4. The defenses that do not depend on the client

**1. Blast radius caps, enforced server-side.**
One record per call, already the rule. Add: a per-grant write budget — *N* writes
per rolling hour, far tighter than the read limit, and a hard daily ceiling.
"Cancel all of tomorrow's jobs" then requires forty calls that trip a limiter on
call eleven. The limiter is not there to be polite about load; it is there so a
runaway loop is a small mess instead of a large one.

**2. Reversibility, as a product feature and not a promise.**
Every assistant write records an `undo` payload: table, row, the prior values of
exactly the columns it touched. Settings → AI & API Access grows a **Recent
assistant changes** list with a Revert button per row. This is worth more than
any guardrail, because it converts "an assistant did something wrong" from an
incident into a click. It also makes Group A genuinely low-stakes in a way that
is *demonstrable* rather than asserted.

**3. Attribution that survives the activity feed.** See §5 — there is a real gap
here today.

**4. Free text is fenced on the way out.**
Client notes, job notes, and SMS bodies get returned wrapped and explicitly
labeled as untrusted content the assistant must not treat as instructions. This
is the weakest of the four (a determined injection can talk its way past a
label) which is exactly why it is fourth and not first.

**5. An out-of-band approval queue for Group B.**
For the operations where "undo" is meaningless — a sent SMS, a charged card —
the confirmation must happen somewhere the model cannot reach. The shape:
`send_message` does not send. It creates a *pending* action, returns "queued for
approval", and a human approves it in Qleno (or on their phone). The assistant
can propose a message to a customer all day long; a person is the one who sends
it.

This is the single most important design decision in Phase 5, and it is the one
that makes Group B safe to build at all.

---

## 5. Attribution — a gap in the current code

The parent spec §7 promises:

> when Maribel asks "who moved this job?", the answer must be "Francisco's
> Gemini key", not a blank.

The current helpers cannot express that. `logAudit()` in `lib/audit.ts` writes
`performed_by = req.auth.userId`, and `logJobStatusChange()` resolves a display
name out of the `users` table. An assistant write today would appear in the
activity feed as **"Sal Martinez"** — indistinguishable from Sal doing it
himself.

That is worse than a blank. A blank prompts a question; a wrong name ends the
investigation.

Phase 5 must extend both helpers with an optional actor descriptor carrying the
credential (`api_key_id` XOR `oauth_grant_id`) and a display string —
*"Claude (Sal's connection)"* — and every write path must pass it. The activity
feed, the client audit trail, and the job audit trail all need to render it.

This is not optional polish. Attribution is what makes defenses 1–2 usable:
a rate limit tells you something ran away, and the audit trail is how you find
out what it was.

---

## 6. Cross-tenant reach and writes

The super-admin axis (`AI_ACCESS_OAUTH_DESIGN.md` §8.1) lets one connection read
more than one company, one company per request. Writes inherit the same rule
with one addition:

**A cross-tenant connection may write only to the home company.**

Reading another tenant's numbers under platform authority is defensible — that is
what a platform administrator does. Reaching into a tenant you do not operate
day-to-day and moving their schedule is a different act, and the consent screen
never asked for it. The `company` argument stays read-only, and a write tool that
receives one is refused rather than quietly applied to the home company.

If that turns out to be too narrow in practice, widening it later is a consent-
screen change and a one-line check. Narrowing it later, after a tenant has been
surprised, is not.

---

## 7. What the code needs

Concrete, from reading the current implementation:

- **`dispatchV1()` is GET-only.** `lib/mcp-dispatch.ts` hardcodes
  `method: "GET"` and `body: {}`. It needs a body-carrying sibling. The comments
  explaining *why* it dispatches in-process rather than re-querying apply
  unchanged and get more important, not less: a second implementation of "write
  a job" would be a second place for the `company_id` clause to go missing.
- **`/api/v1` has zero non-GET routes today.** The write surface is greenfield;
  there is no existing shape to match. Errors, idempotency (`Idempotency-Key`,
  so a retried tool call does not double-book), and the confirm argument should
  be settled once in `_shared.ts` before the first handler is written.
- **`jobs.created_source` must be stamped** by any create path — nine insert
  sites already do this, and the Activity feed derives "Booked" from it.
- **The assignment mirror is non-negotiable.** `assign_technician` writes
  `job_technicians` and therefore must mirror the primary onto
  `jobs.assigned_user_id`, same as the four existing entry points. A split-brain
  here puts a chip in the Unassigned row while a tech is actually assigned.
- **`COMMS_ENABLED` is not bypassed.** `send_message` routes through
  `notificationService`. Phase 5 creates no new exception to that gate.
- **Watch the `= ANY(array)` trap** (`reference_drizzle_any_array_trap`). Any
  new multi-id query uses `inArray()` or an expanded `IN` list.

---

## 8. Testing

The gate in the parent spec's rollout table is right and should be kept
verbatim: *hostile text in client notes must not produce a mutation.* Made
concrete:

A fixture client whose notes field contains a set of injection payloads —
direct instruction, fake system message, fake tool result, urgency, claimed
prior authorization, base64 — is read by a test harness holding write scopes.
The assertion is not "the model refused"; we do not control the model. The
assertion is **that no write reached the database**, which is a server-side fact
we can prove with a transaction count.

That framing matters. A test that checks what the model said is testing
Anthropic's alignment work. A test that checks what the database did is testing
ours.

---

## 9. Open decisions for Sal

1. **Scope of Phase 5a.** Recommendation: Group A only — reschedule, assign,
   note, client contact. Everything reversible, nothing customer-visible.
2. **How Group B confirms.** Recommendation: the approval queue in §4.5 — the
   assistant proposes, a person sends. Not `confirm: true`, for the reason in §3.
3. **Undo.** Recommendation: build it in 5a, not later. It is cheap while the
   write surface is four tools and expensive once it is thirteen.

---

## 10. Do not start yet

The parent spec's own gate:

> **Phase 5 does not start until Phases 1–4 have run on real Phes traffic for at
> least a week.** The read path is where tenant-scoping bugs surface, and it is
> much better to find them while the worst case is a wrong number on a screen.

Phases 1–4 merged **2026-08-15**. At the time of writing that is one day, not a
week, and the only traffic so far has been Sal's own testing. The earliest
honest start for 5a code is **2026-08-22**, and only if the read path has been
used in anger by more than one person in the meantime.

Writing this document now is the right use of the wait. Building against it now
is not.

---

## 11. Invariants this phase must respect

- Every query filters by `company_id`, resolved from the credential, never from
  the request.
- `COMMS_ENABLED=false` suppresses all automated customer comms. No new
  exception.
- Square is the office card rail; any future `charge_card` inherits that routing
  rather than choosing a processor.
- `getBranchByZip` routes any comms this surface triggers. No hardcoded branch.
- `base_fee` drags `commission_base` in the same UPDATE — which is why pricing is
  in Group C.
- Boot migrations idempotent, production-gated, loud on failure. Never a
  fixed-past-date sweep on the boot path.
