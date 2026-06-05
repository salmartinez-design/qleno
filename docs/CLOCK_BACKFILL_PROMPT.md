# Browser-agent prompt — backfill clock times into Qleno (June 1 → today)

Paste the block below into a Claude session that drives your Chrome browser
(Claude for Chrome / computer-use). You'll already be logged into **Qleno**
and **MaidCentral** in that browser.

Before you start (notes for Sal, not the agent):
- This writes **real payroll clocks into production Qleno.** Watch it.
- The agent **reads each day's times from MaidCentral** and types them into
  Qleno's Time Clock. June 1 is pre-loaded as a known-answer calibration day.
- It only *adds clock times and pay-type to existing jobs.* It will not create
  or delete jobs, won't touch settings, won't send comms.

---

## PROMPT (paste into the browser-driving Claude)

**Who you are and what we're doing — full disclosure.** Phes (a cleaning
company) is migrating from MaidCentral to our own app, Qleno. To prove Qleno's
payroll matches, we're running both **in parallel**: I need you to take the
**actual clock in/out times that already exist in MaidCentral** for each work
day from **June 1, 2026 through today**, and enter them into **Qleno's Time
Clock** screen for the same day. After you're done we compare each day's
commission between the two systems. This is real production payroll data —
work carefully, one day at a time, and **stop and ask me** if anything is
ambiguous (a job in one system but not the other, a name you can't match, a
field you can't set).

**Two systems, two roles:**
- **MaidCentral = READ ONLY.** Your source for each tech's job, clock-in, and
  clock-out times, and their pay type. Never change anything in MaidCentral.
- **Qleno = WRITE.** Where you enter those times. URL: `app.qleno.com/time-clock`.

### How Qleno's Time Clock screen works (read this carefully)
- Top has a date control: a **‹ ›** pair and a **calendar** button. Click the
  calendar to jump to a specific date.
- A summary row: **People · Jobs · Punched (X/Y) · Worked hours.** "Punched
  X/Y" is your progress bar — when every job has times, X should equal Y.
- Below, jobs are grouped **by tech**. Each job row shows the **client name**,
  the **service + scheduled time** (e.g. "Standard Clean · sched 9:00 AM"),
  then two time fields: **IN** and **OUT** (format `--:-- --`, i.e. HH:MM
  AM/PM), a worked-time readout, a green **Save** button, and a trash icon.
- Under each row is a **PAY** line: a dropdown (**Default / Fee Split /
  Allowed Hours / Hourly**), a rate box that appears for non-Default, a
  **Breakage −$** box, and a **Save pay** button.

### Your procedure — do ONE day at a time, in this order
**Start with June 1 (calibration), then June 2, 3, 4, and today.**

For each day:
1. In MaidCentral, open that day's timesheets. For every tech, note: the
   **client/job**, **clock-in**, **clock-out**, and the **pay type** MC shows
   (Fee Split / Hourly / Allowed Hours).
2. In Qleno, click the **calendar** and select the **same date**.
3. For each Qleno job row, find the matching MaidCentral timesheet **by client
   name + scheduled time + tech**. Then:
   a. Type MC's clock-in into **IN** and clock-out into **OUT** (exact, correct
      AM/PM). Click the row's green **Save**. Confirm the worked-time readout
      updates and the "Punched" count goes up by one.
   b. **Pay type:** leave the PAY dropdown on **Default** UNLESS MaidCentral
      shows this timesheet paid a way that differs from the default. Rules:
      - MC shows **Hourly** → set dropdown to **Hourly**, type the $/hr rate,
        click **Save pay**.
      - MC shows a **Fee Split %** that differs from what Qleno defaults to
        (Qleno defaults: Standard = 35%, Deep Clean / Move = 32%) → set
        **Fee Split** and type the % (e.g. `35`), click **Save pay**.
      - MC shows **Allowed Hours** on a commercial job → that's already the
        Default; leave it.
      - If MC notes a breakage/damage deduction against the tech → put the
        dollar amount in **Breakage −$** and **Save pay**. Otherwise leave 0.
4. When the day is done, read back the day's **Punched X/Y** (should be full)
   and the per-tech worked totals, and **report to me**:
   `Day <date>: entered N/N timesheets. Anomalies: <list or none>.`
5. **Wait for my OK after June 1** before continuing to June 2 — June 1 is the
   calibration check (see expected values below). After I confirm June 1 is
   right, proceed through the remaining days without stopping unless you hit an
   anomaly.

### June 1, 2026 — KNOWN-CORRECT calibration data
Enter exactly these. After saving, the day should show **11 timesheets across
9 jobs**. (These came straight from MaidCentral; use them to confirm you're
matching jobs and typing times correctly. The bold pay-types are the only
non-Default ones.)

| Tech | Job (client) | IN | OUT | Pay type to set |
|---|---|---|---|---|
| Alejandra Cuervo | Nitzsche — Deep Clean | 9:16 AM | 12:33 PM | Default |
| Juliana Loredo | Nitzsche — Deep Clean | 9:16 AM | 12:33 PM | Default |
| Norma Puga | Cusimano — Standard | 9:06 AM | 12:17 PM | Default |
| Jose Ardila | Cusimano — Standard | 9:07 AM | 12:17 PM | **Hourly, $20** |
| Guadalupe Mejia | Hundt — Deep Clean | 9:07 AM | 12:07 PM | **Fee Split, 35** |
| Guadalupe Mejia | Ward — Standard | 1:57 PM | 3:57 PM | Default |
| Juan Salazar | Walter — PPM Turnover | 10:30 AM | 12:44 PM | Default |
| Alejandra Cuervo | Halper — Common Areas | 1:36 PM | 3:22 PM | Default |
| Juliana Loredo | Nitzsche — Carpet | 1:14 PM | 3:24 PM | **Hourly, $25** |
| Jose Ardila | Walter — Weekly Commercial | 1:06 PM | 4:05 PM | Default |
| Juliana Loredo | Nitzsche — Common Areas | 3:51 PM | 5:22 PM | Default |

If a June 1 row above doesn't have a matching Qleno job, or Qleno shows a June 1
job not in this list, **stop and tell me** — don't guess.

### Hard rules (do not break)
- **Only add clock times + pay type to existing job rows.** Never create a job,
  never delete a job/clock (the trash icon), never change a client or schedule.
- **Don't log out** or change the company/branch selector.
- **Don't touch** MaidCentral data, Settings, Payroll runs, or anything sending
  messages.
- **Match individually:** on multi-tech jobs each tech has their own row and
  their own in/out — they can differ; enter each separately.
- **Idempotent:** if a row already has the correct times, skip it. If it has
  *wrong* times, correct them.
- **One save per action:** time changes need **Save**; pay-type changes need a
  separate **Save pay**. Don't assume one saves the other.
- **Times are clock times** (when they arrived/left), not durations. Keep
  AM/PM exactly as MC shows. No timezone conversion.
- If you're unsure about *any* row, leave it and add it to your anomaly report
  rather than guessing.

### What you do NOT need to do
- You don't compute pay or commission — Qleno does that. Your job is faithful
  transcription of **times** and **pay type**. We compare the dollars after.

When all days are entered, give me a final summary: per day, timesheets
entered and any anomalies. Then I'll compare Qleno's commission to MaidCentral
day-by-day and we fix any mismatches together.
