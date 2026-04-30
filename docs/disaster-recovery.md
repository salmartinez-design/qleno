# Disaster Recovery — Qleno production

Owner: Sal Martinez (operator). Reviewed: 2026-04-30.

## Purpose

This document describes how to recover Qleno's production data when something goes catastrophically wrong — a bad migration, a bad cascade, accidental row deletion, infrastructure failure. It's not a step-by-step automation; it's the runbook an operator opens when the system is on fire.

Read it once before you need it.

## Where the data lives

- **Primary database**: Railway Postgres, project `selfless-manifestation`, service `Postgres`. The Railway-managed instance is the only authoritative copy of production data.
- **Backups**: managed by Railway. The Hobby plan that Phes runs on includes **daily snapshots with 7-day retention**, taken automatically. There is no manual backup step today.
- **Source of truth pre-cutover**: MaidCentral (the legacy cleaning-business platform Phes is migrating off). Until the cutover completes, MaidCentral data is recoverable independently — for any pre-2026-04 record, MC is a second copy of truth.

## Recovery objectives

These are the targets the system can meet today on Railway Hobby. They are not contractual SLAs.

| Metric | Target | Notes |
|---|---|---|
| **RPO** (Recovery Point Objective — how much data can be lost) | ≤ 24 hours | Daily snapshots; worst case is losing one full operating day. |
| **RTO** (Recovery Time Objective — how long to restore service) | ≤ 30 minutes | Railway snapshot restore is operator-driven via the dashboard; takes a few minutes plus DNS settle. |

**Phes can tolerate these limits.** A $750k/yr operation with ~1,300 clients can run for 30 minutes from MC backup or paper records, and can recover a day of data manually from a combination of MC, bookkeeper exports, and operator memory of in-progress work.

If the business outgrows these limits — e.g. multi-tenant SaaS with stricter SLAs, or post-cutover when MC is no longer a fallback — revisit. Options at that point: continuous WAL archiving (Railway Pro), point-in-time recovery, off-platform replicas.

## Quarterly check (do this every January, April, July, October)

1. Open Railway dashboard → project `selfless-manifestation` → service `Postgres`.
2. Click **Backups** in the left nav.
3. Confirm:
   - Daily backups are enabled.
   - Retention is 7 days (or whatever the current Hobby plan offers — verify it hasn't been silently downgraded).
   - The most recent backup is from within the last 24 hours.
4. If anything is off, fix it before doing anything else. A backup-less production is a single bad PR away from disaster.

The api-server logs a static reminder on every cold start (`[backup-check] static reminder: …`) so this check is in the operator's eyeline. The reminder is intentionally static — implementing a live Railway API check requires an `RAILWAY_API_TOKEN` credential that adds operational surface area without solving a problem that matters more than twice a year.

## Scenario: I deployed a PR that corrupted production data

Symptoms: rows have wrong values, jobs got deleted that shouldn't have, a cascade did the wrong thing across hundreds of rows, etc.

**Stop deploying.** Revert the offending PR on `main` first so the next Railway redeploy doesn't recompound the damage. Then:

1. **Triage how bad it is.** Run `SELECT count(*) FROM jobs WHERE updated_at > NOW() - INTERVAL '4 hours'` and similar for affected tables. If the blast radius is small (< ~100 rows) and you can identify them precisely, hand-fix via SQL UPDATE/INSERT statements without a restore. Document what you ran in a postmortem.

2. **If the blast radius is large**, restore from snapshot:
   - Railway dashboard → Postgres service → Backups tab → pick the most recent snapshot **before** the bad deploy.
   - Click **Restore**. Railway prompts to confirm; the restore replaces the current database in place. **This loses any data written between the snapshot and now.**
   - Wait ~5 minutes for restore + healthcheck.
   - Verify with `SELECT count(*) FROM jobs`, `SELECT count(*) FROM clients`, etc. against pre-incident expectations.

3. **If you don't want to overwrite prod** (e.g. you need to extract specific rows from yesterday without losing today's writes), see "Spin up a recovery DB" below.

## Scenario: I want to extract specific rows from a backup without overwriting prod

This is the case when prod has good data from the last 24 hours that you want to keep, but you also need to recover a specific table/row that got corrupted earlier and is now overwritten in prod.

Railway doesn't natively support "restore to a side instance" on Hobby. The procedure:

1. Railway dashboard → Postgres service → Backups → pick the snapshot you want.
2. Download the snapshot (Railway provides a `.sql` or `.dump` export — formats vary; check the dashboard).
3. Locally, spin up a throwaway Postgres in Docker:
   ```bash
   docker run --rm -d --name qleno-recovery -p 5433:5432 \
     -e POSTGRES_PASSWORD=recover -e POSTGRES_DB=qleno_recovery \
     postgres:16
   ```
4. Restore the snapshot into the throwaway:
   ```bash
   pg_restore -h localhost -p 5433 -U postgres -d qleno_recovery <snapshot-file>
   # or for plain SQL:
   psql -h localhost -p 5433 -U postgres qleno_recovery -f <snapshot.sql>
   ```
5. Connect a client to the throwaway and SELECT the rows you need. Export to CSV / SQL inserts as needed.
6. Apply the extracted data to production via targeted INSERT/UPDATE statements. **Manual SQL only — do not script bulk migrations against prod from a recovery DB without a senior review.**
7. `docker rm -f qleno-recovery` when done.

Expected total time: 30-60 minutes including snapshot download. The bottleneck is usually the snapshot download size (Phes prod is currently <500 MB; this will grow).

## Scenario: Railway is fully down

Symptoms: `app.qleno.com` doesn't respond, Railway status page shows incident.

1. Tell operations: "we're down, fall back to MaidCentral or paper for jobs scheduled today, do not take new bookings until we're back."
2. Watch Railway's status page. There is no Qleno-side action that brings us back faster — we are downstream of their infra.
3. When Railway recovers, the api-server cold-starts and the data is intact (Railway maintains the disk; it's just compute that was down). Verify with the quarterly-check procedure above.
4. If the outage is >2 hours, evaluate whether to spin up an emergency replica on a different platform. This is a multi-day project, not an outage-day option — file as a BCP improvement task if it happens.

## Scenario: I deleted the wrong row(s) by hand

You ran a manual SQL UPDATE/DELETE in the Railway shell or a database client and zapped the wrong thing.

1. **Don't run anything else.** Including queries against the same table — concurrent transactions can complicate recovery.
2. If the deletion happened in the last few minutes and Postgres still has the row in WAL, contact Railway support. They can sometimes recover from WAL on Hobby; sometimes they can't. Don't count on this.
3. Otherwise, restore the affected rows from yesterday's snapshot via the "Spin up a recovery DB" procedure above.
4. Postmortem: document what got deleted, what got recovered, and what (if anything) is permanently gone. File a postmortem in `/docs/incidents/` (create directory if needed).

## What's NOT covered here

- **Stripe / Square refunds**: payment data lives at the payment processor. Recovering a database row that says "this job was paid" doesn't undo a real card charge. Refund flows are separate.
- **Twilio / Resend message logs**: comms providers retain their own logs; we don't restore them.
- **QuickBooks**: QB is write-only from Qleno's perspective. Qleno never pulls from QB. Restoring Qleno doesn't affect QB. If QB is also corrupted, that's a separate Intuit-side recovery.
- **Email / DNS / domain registrar**: out of scope for database disaster recovery.

## Postmortem expectations

Every restore-from-snapshot incident gets a postmortem in `/docs/incidents/YYYY-MM-DD-<short-name>.md`. Template:

- What happened (timeline)
- What we lost (rows, hours of data, customer impact)
- What we recovered (and how)
- What we'd do differently (engineering + operations)
- Action items with owners

Even if the impact was small. The point isn't blame; the point is that the next person who hits this scenario can read the runbook + last incident and skip the diagnosis phase.
