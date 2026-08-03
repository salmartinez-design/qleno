# Batch Invoicing — Design

**Status:** proposed, 2026-08-03
**Origin:** KMA July 2026. Maribel: "They disappeared." Seven invoices on
screen for eight visits, $925 of banked money unrecorded, and $750 of
revenue that QuickBooks lost. QuickBooks was disconnected because this
same defect was pushing duplicate invoices and double-counting revenue.
**Source of truth for the invoicing engine. Read before touching
`ensure-invoice.ts`, `invoice-cadence.ts`, or the account invoice routes.**

---

## 1. The model (from Sal + Maribel, 2026-08-03)

MaidCentral parity, in their words:

- Every job produces an invoice — the per-visit record of billable work.
- The office **generates** the document deliberately, **batch or single**.
  That act is what creates A/R and what registers it in QuickBooks as
  unpaid. It is not a by-product of the job completing.
- Several buildings serviced for one account combine into ONE document the
  client pays in full.
- Marking it paid cascades — to the member visits, and to QuickBooks.

Maribel's correction to the first draft of this ("yes and no"): the
generate step is an office action. Qleno's two existing paths — wait for
completion to auto-create, or select uninvoiced jobs in advance and merge —
are both legitimate. The bug is that they are unaware of each other.

### The two rules everything else follows from

**R1 — Nothing is ever lost.** Every completed billable visit has its own
invoice record, always. It is how the office sees what was done, how job
costing works, and how a visit that was serviced but never billed becomes
visible instead of silent. A batch NEVER destroys its members.

**R2 — Exactly one document per dollar.** For any visit, at most one live
document is A/R at a time and at most one reaches QuickBooks. This is the
rule whose violation forced the QB disconnect.

R1 and R2 are in tension, and resolving that tension is the whole design.

---

## 2. Lifecycle

```
job completes
   └─> per-visit invoice, status = draft            (R1: the record exists)
          │
          ├── office issues it singly ──────> status = sent      → A/R, → QB
          │
          └── office batches it with others
                     │
                     ├─ parent: new invoice, sum of members, status = sent
                     │           → A/R, → QB   (R2: the ONLY document)
                     │
                     └─ members: status = batched                 (R1)
                                 amount PRESERVED
                                 visible in the list
                                 linked to parent
                                 NOT A/R, NOT pushed to QB
```

Payment on the parent cascades `paid` down to every member, so per-job
revenue reporting stays correct without the parent's total being counted
twice.

### What changes vs. today

Today the close marks members `superseded`, **zeroes their totals to
`$0.00`**, and the list view hides `superseded` outright
(`routes/invoices.ts:92`). That is not a batch — it is a merge that eats
its inputs. It is the literal mechanism behind "they disappeared."

`batched` replaces that: same parent/child link, but the child keeps its
amount, keeps its number, and stays on screen with a "Billed on #7173"
chip. Nothing vanishes.

---

## 3. Defects this closes

| # | Where | Defect |
|---|---|---|
| D1 | `routes/accounts.ts:1200` | The "already invoiced" filter is `status IN ('sent','paid')`. A bundled account's per-visit invoices are `draft` by design, so Generate Invoice cannot see them and re-bills work that already has an invoice. **This is the duplicate-push that double-counted revenue in QB.** |
| D2 | `lib/ensure-invoice.ts:129` | Dedup matches on `line_items[].job_id`, but the bundle path wrote lines with no `job_id` (KMA invoice 966: five lines, zero ids). Blind dedup. Already flagged as a KNOWN GAP in the file's own comment — it was not theoretical. |
| D3 | `lib/ensure-invoice.ts:126` | `ne(status,'void')` — a deliberately voided invoice gets regenerated. Confirmed in prod: 6342/6344/6349 voided as duplicates, recreated Jul 22 as 7112/7113/7114. Cleaning up duplicates creates duplicates. |
| D4 | `lib/invoice-cadence.ts:159` | Any `superseded` child in the window means "closed." `POST /invoices/merge` also writes `superseded`, so one manual merge on Jul 29 permanently blocked KMA's July close. The month can never bundle. |
| D5 | recurring engine | Generated jobs don't carry the schedule's rate. **107 of 108 future KMA jobs have `billed_amount` NULL.** Every one will hit `held_unpriced`, which only logs a console warning nobody reads. |

D1+D2 together are why QuickBooks had to be disconnected.

### Defects visible on the documents KMA actually received

The three PDFs emailed 2026-07-03 are invoices 964 / 966 / 967.

| # | Where | Defect |
|---|---|---|
| D6 | `lib/invoice-pdf.ts:123` | `statusLabel = (data.status \|\| "").toUpperCase()` renders unconditionally. A `draft` invoice prints a **DRAFT** badge — and all three documents the client received say DRAFT. A customer-facing PDF must never render an unissued state. |
| D7 | bundle path | `Service —` (blank) on both multi-visit invoices. Only the single-job 967 carried a service date. A batch covering a period must print the period, not a blank. |
| D8 | bundle path | `Issued Jul 1 / Due Jul 1` — due date equals issue date on a monthly commercial account. No terms applied. |
| D9 | `routes/accounts.ts:1261,1282` | Numbering is `ACC-5-1783100316269` — a raw epoch. June's were 6089 / 6090 / 6201. This is why Maribel "can't find" them: unsearchable, unquotable, and the client can't reference one on a check. |

### The real root cause: FOUR engines, not one

"Combine invoices" is implemented four separate times, each with its own
idempotency rule, each writing `superseded` its own way, none aware of the
others:

1. `lib/invoice-cadence.ts` — the 5 AM cron, keyed on `accounts.invoice_frequency`
2. `routes/batch-invoicing.ts` — keyed on `clients.billing_terms = 'batch_invoice'`
3. `routes/invoices.ts:1595` `POST /invoices/merge` — the manual merge
4. `routes/accounts.ts:1276,1370` `POST /accounts/:id/generate-invoice` — itself
   two modes, separate and bundle

Plus `ensure-invoice.ts` creating the per-visit rows underneath. Five writers,
one table, no shared rule. Patching one leaves four. **This is why it recurs
every month**, and it is why the fix has to be consolidation, not repair.

### Blast radius — this is not only KMA

Seven accounts holding 17 pending drafts that were never bundled:
KMA 4 ($450), Heritage 4 ($0), 4009 W 93rd 4 ($0), National Able 1 ($420),
Halper 1 ($210), ProManage 2 ($0), Cucci 1 ($0). National Able is
**weekly** and should have closed and emailed every Friday. It has not.
The $0 rows are unpriced visits, not free cleans.

---

## 4. Decisions

**D-1. `batched` is a new invoice status; `superseded` is retired for this
flow.** Members keep `total`, keep `invoice_number`, stay listed. Only
`void` hides an invoice from the default view.

**D-2. Generate Invoice stays enabled on bundled accounts.** Maribel
explicitly needs "go in advance, select the uninvoiced jobs and merge them
into one invoice." It becomes safe rather than removed.

**D-3. One dedup predicate, shared.** A single `isVisitBilled(jobId)`
used by `ensure-invoice`, `generate-invoice`, and the uninvoiced-jobs
selector. Live = anything not `void`. Draft counts as billed — that is
D1's fix.

**D-4. Every invoice line carries `job_id`.** Enforced at write time on
every path, so dedup can never go blind again.

**D-5. Void is a tombstone.** A voided invoice records that its visit was
deliberately un-billed; the completion engine does not regenerate it. Re-
billing is an explicit office action.

**D-6. Batch = one primitive, two triggers.** The office button and the
cadence cron call the same function. There is no second implementation.

**D-7. A/R excludes members.** Rollups count parents and un-batched
invoices only. Members are reporting records, not receivables.

**D-8. Unpriced visits surface in the UI.** `held_unpriced` becomes a
visible queue, not a console warning. A $0 commercial visit still never
issues into A/R — it means a rate is unset.

**D-9. QuickBooks push stays OFF.** The engine is built so exactly one
document per dollar is pushable, which is the precondition for
reconnecting. Reconnecting is Sal's call after this is verified in
production. No code here turns it back on.

---

## 5. What makes it stick

Convention has already failed here four times. The guarantees must be
structural, so that a future code path *cannot* reintroduce the bug:

**S-1. A billing-coverage table with a database constraint.**
`invoice_job_links (invoice_id, job_id)`, with a partial unique index:

```sql
CREATE UNIQUE INDEX invoice_job_links_one_live_per_job
  ON invoice_job_links (company_id, job_id)
  WHERE is_live;
```

Two live invoices covering one visit becomes a **constraint violation, not a
duplicate document**. Any future writer — one nobody has written yet — gets a
hard error instead of silently double-billing. This is the single most
important item on the list, because it is the only one that does not depend
on the next developer knowing about this doc. It also retires the fragile
`line_items @> job_id` jsonb probing that D2 defeated.

**S-2. One engine. The other three get deleted, not fixed.** The cron, the
account button, `/invoices/merge`, and `batch-invoicing.ts` all call one
`combineInvoices(jobIds[])`. Four call sites, one implementation.

**S-3. A nightly integrity check that reports.** Visits completed but not
covered by any live invoice; invoices whose lines don't sum to their total;
priced-at-$0 visits; windows with pending drafts past their close date. It
surfaces in the UI rather than a console warning nobody reads (D5/D8 both
failed exactly that way).

**S-4. Regression tests pinned to KMA July.** The real sequence — bundle
created, per-visit duplicates generated, duplicates voided, engine regenerates
them, manual merge blocks the close — as a test that fails on today's code.

---

## 6. Out of scope

- Reconnecting QuickBooks (D-9).
- The July KMA data cleanup — tracked separately; it lands after this so
  it is repaired on a stable engine.
- The silent-void audit gap: 964 and 966 went to `void` with no
  `app_audit_log` row and no identified actor. `lib/audit.ts` swallows
  insert failures, so a missing row does not prove the endpoint was not
  called. There is currently no reliable record of who voids an invoice.
  Worth closing, separately.
