# Chrome-driving prompt — enter June 1 clocks into Qleno & verify vs MaidCentral

Paste the block below into a Claude session that controls your Chrome browser
(Claude for Chrome / a Chrome MCP / computer-use). You'll already be logged
into Qleno in that browser. Read the "Before you start" notes first.

## Before you start (for you, Sal — not the agent)
- This writes **real payroll clocks into production Qleno.** Watch it; don't
  let it touch any date other than **June 1, 2026**.
- **Zero variance needs two things per timesheet: the clock AND the pay type.**
  Qleno's smart defaults already match MaidCentral on the 4 commercial
  (Allowed Hours) jobs and the 3 standard Fee-Split jobs. The **3 exceptions**
  must have their pay type set by hand or they'll diverge:
  - Carpet Cleaning (Juliana) → **Hourly @ $25/hr**
  - Cusimano / Hourly Standard (Jose Ardila) → **Hourly @ $20/hr**
  - Hundt / Hourly Deep Clean (Guadalupe) → **Fee Split at 35%** (not 32%)
  Each job row in the Time Clock screen now has a **PAY** control (a "Pay type"
  dropdown — Default / Fee Split / Allowed Hours / Hourly — plus a rate field
  and a "Breakage −$" field, then **Save pay**). Use it for those three. Leave
  it on **Default** for everything else.

---

## PROMPT (paste into the browser-driving Claude)

**What we're doing and why — full disclosure.** We migrated Phes from
MaidCentral to Qleno. To trust Qleno's payroll, we're reconciling **one full
day — June 1, 2026** — against MaidCentral's known-good paychecks. I'm giving
you the exact clock-in/out times, pay types, and the pay MaidCentral produced
for each tech. Your job: enter each clock into Qleno's **Time Clock** screen
for June 1, set the pay type where noted, then read back Qleno's computed
commission and compare it to the MaidCentral column. **Target: every tech
matches, day total = $801.99.** This is real production payroll data — only
touch June 1, 2026, and stop and report if anything looks off (a job missing,
a name not found, a field you can't set).

**Steps**
1. In Qleno, open **Time Clock** (left nav, under Team) and set the date to
   **June 1, 2026**.
2. For each row in the table below: find the job (by customer name), and for
   the named tech enter the **Clock In** and **Clock Out** times exactly.
3. Where the **Pay type** column says something other than the default, use
   that row's **PAY** control: pick the pay type, type the rate (Hourly →
   $/hr; Fee Split → the % like `35`), set Breakage −$ if noted, then click
   **Save pay**. Leave every other row on **Default**.
4. After all rows are entered, open the commission/payroll view for June 1
   (or trigger "compute commission") and read each tech's computed pay.
5. Produce a table: Tech · Job · MaidCentral pay · Qleno pay · match? Flag
   every row that differs by more than $0.01 and total both columns.

**June 1, 2026 — the data (times are exact; pay is MaidCentral's actual)**

| Job (find by customer) | Tech | Clock In | Clock Out | Pay type to set | MC pay |
|---|---|---|---|---|---|
| Jennifer Halper — Common Areas, 8901 S Roberts Rd | Alejandra Cuervo | 1:36 PM | 3:22 PM | default (Allowed Hours, $20) | $70.00 |
| Daniel Walter — Weekly Commercial | Jose Ardila | 1:06 PM | 4:05 PM | default (Allowed Hours, $20) | $60.00 |
| Richard Nitzsche — Commercial Common Areas, 338 S Oak Park Ave | Juliana Loredo | 3:51 PM | 5:22 PM | default (Allowed Hours, $20) | $60.00 |
| Daniel Walter — PPM Unit Turnover, 1120 N La Salle Dr | Juan Salazar | 10:30 AM | 12:44 PM | default (Allowed Hours, $20) | $60.00 |
| Richard Nitzsche — Carpet Cleaning, 338 S Oak Park Ave | Juliana Loredo | 1:14 PM | 3:24 PM | **Hourly, $25/hr** | $54.25 |
| Richard Nitzsche — Deep Clean / Move In-Out, 338 S Oak Park Ave | Alejandra Cuervo | 9:16 AM | 12:33 PM | default (Fee Split 32%) | $100.54 |
| Richard Nitzsche — Deep Clean / Move In-Out, 338 S Oak Park Ave | Juliana Loredo | 9:16 AM | 12:33 PM | default (Fee Split 32%) | $100.54 |
| Joe Cusimano — Hourly Standard, 4943 S Woodlawn Ave | Norma Puga | 9:06 AM | 12:17 PM | default (Fee Split 35%) | $94.66 |
| Joe Cusimano — Hourly Standard, 4943 S Woodlawn Ave | Jose Ardila | 9:07 AM | 12:17 PM | **Hourly, $20/hr** | $63.40 |
| Silas Hundt — Hourly Deep Clean, 1301 E 55th St | Guadalupe Mejia | 9:07 AM | 12:07 PM | **Fee Split 35%** (not 32%) | $73.50 |
| Greg Ward — Recurring Standard Clean, 1025 W Addison St | Guadalupe Mejia | 1:57 PM | 3:57 PM | default (Fee Split 35%) | $65.10 |

**Expected MaidCentral day total: $801.99.** When Qleno's total and every
per-tech row match, we're done. Report the comparison table and any row you
could not enter or set.

---

### Notes on the math (so you can sanity-check, not re-derive)
- **Allowed Hours** = the job's allowed (budget) hours × $20, and it pays the
  budget even when the tech finished faster (Halper: 3.5 allowed × $20 = $70
  though only 1.77 h worked).
- **Fee Split** = the job's gross service price × the scope % × the tech's
  hour-share. Two equal techs split the % evenly (Deep Clean 32% → 16% each
  on the $628.40 gross = $100.54). A **breakage/damage credit on the invoice
  does NOT reduce the tech's pay** — commission is on the gross base.
- **Hourly** = hours worked × the flat rate, independent of the job's price.
