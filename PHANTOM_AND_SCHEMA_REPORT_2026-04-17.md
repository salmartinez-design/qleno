# Phantom Job Diagnostic + Schema Dump — 2026-04-17

## 1. Phantom Job Diagnostic

### 1.1 jobs table columns

| column_name | data_type | is_nullable | column_default | character_maximum_length |
| --- | --- | --- | --- | --- |
| id | integer | NO | nextval('jobs_id_seq'::regclass) |  |
| company_id | integer | NO |  |  |
| client_id | integer | YES |  |  |
| assigned_user_id | integer | YES |  |  |
| service_type | USER-DEFINED | NO |  |  |
| status | USER-DEFINED | NO | 'scheduled'::job_status |  |
| scheduled_date | date | NO |  |  |
| scheduled_time | text | YES |  |  |
| frequency | USER-DEFINED | NO | 'on_demand'::frequency |  |
| base_fee | numeric | NO |  |  |
| fee_split_pct | numeric | YES |  |  |
| allowed_hours | numeric | YES |  |  |
| actual_hours | numeric | YES |  |  |
| notes | text | YES |  |  |
| created_at | timestamp without time zone | NO | now() |  |
| completion_pdf_url | text | YES |  |  |
| completion_pdf_sent_at | timestamp without time zone | YES |  |  |
| job_lat | numeric | YES |  |  |
| job_lng | numeric | YES |  |  |
| geocode_failed | boolean | NO | false |  |
| zone_id | integer | YES |  |  |
| account_id | integer | YES |  |  |
| account_property_id | integer | YES |  |  |
| hourly_rate | numeric | YES |  |  |
| estimated_hours | numeric | YES |  |  |
| billed_hours | numeric | YES |  |  |
| billed_amount | numeric | YES |  |  |
| charge_attempted_at | timestamp without time zone | YES |  |  |
| charge_succeeded_at | timestamp without time zone | YES |  |  |
| charge_failed_at | timestamp without time zone | YES |  |  |
| charge_failure_reason | text | YES |  |  |
| billing_method | USER-DEFINED | YES |  |  |
| branch_id | integer | YES |  |  |
| recurring_schedule_id | integer | YES |  |  |
| home_condition_rating | integer | YES |  |  |
| condition_multiplier | numeric | YES |  |  |
| applied_bundle_id | integer | YES |  |  |
| bundle_discount_total | numeric | YES |  |  |
| last_cleaned_response | text | YES |  |  |
| last_cleaned_flag | text | YES |  |  |
| overage_disclaimer_acknowledged | boolean | YES | false |  |
| overage_rate | numeric | YES |  |  |
| upsell_shown | boolean | YES | false |  |
| upsell_accepted | boolean | YES | false |  |
| upsell_declined | boolean | YES | false |  |
| upsell_deferred | boolean | YES | false |  |
| upsell_cadence_selected | text | YES |  |  |
| property_vacant | boolean | YES | false |  |
| first_recurring_discounted | boolean | YES | false |  |
| booking_location | text | YES |  |  |
| address_street | text | YES |  |  |
| address_city | text | YES |  |  |
| address_state | text | YES |  |  |
| address_zip | text | YES |  |  |
| address_verified | boolean | YES | false |  |
| address_lat | numeric | YES |  |  |
| address_lng | numeric | YES |  |  |
| supply_cost | numeric | YES | 0.00 |  |
| office_notes | text | YES |  |  |
| arrival_window | text | YES |  |  |
| booking_street | text | YES |  |  |
| booking_unit | text | YES |  |  |
| booking_city | text | YES |  |  |
| booking_state | text | YES |  |  |
| booking_zip | text | YES |  |  |
| booking_apt | text | YES |  |  |
| preferred_contact_method | text | YES |  |  |
| address_line2 | text | YES |  |  |
| branch | text | YES |  |  |
| reminder_72h_sent | boolean | YES | false |  |
| reminder_24h_sent | boolean | YES | false |  |
| job_type | text | YES | 'residential'::text |  |
| commission_pool_rate | numeric | YES |  |  |
| estimated_hours_per_tech | numeric | YES |  |  |
| flagged | boolean | NO | false |  |

_Using `billed_amount` as price column (handoff used `total_price` which doesn't exist)._

### 1.2 Total jobs for PHES: **865**

### 1.3 Jobs by status

| status | count |
| --- | --- |
| scheduled | 807 |
| complete | 55 |
| cancelled | 3 |

### 1.4 Jobs created per day (last 60 days)

| creation_date | jobs_created | unique_clients | from_recurring | one_off |
| --- | --- | --- | --- | --- |
| 2026-04-17 | 3 | 2 | 1 | 2 |
| 2026-04-16 | 60 | 55 | 58 | 2 |
| 2026-04-15 | 8 | 2 | 8 | 0 |
| 2026-04-12 | 1 | 1 | 1 | 0 |
| 2026-04-10 | 1 | 1 | 1 | 0 |
| 2026-04-09 | 58 | 54 | 58 | 0 |
| 2026-04-08 | 6 | 1 | 4 | 2 |
| 2026-04-07 | 85 | 48 | 85 | 0 |
| 2026-04-06 | 74 | 1 | 20 | 54 |
| 2026-04-03 | 20 | 1 | 1 | 19 |
| 2026-04-02 | 54 | 54 | 54 | 0 |
| 2026-03-31 | 191 | 54 | 191 | 0 |
| 2026-03-28 | 24 | 24 | 24 | 0 |
| 2026-03-24 | 278 | 78 | 276 | 2 |
| 2026-03-21 | 2 | 0 | 0 | 2 |

### 1.5 Price distribution (last 30 days)

| price_bucket | jobs |
| --- | --- |
| $0 / null | 810 |
| $200-300 | 55 |

### 1.6 Scheduled dates for recent-created jobs (first 50)

| sched_date | jobs | recurring |
| --- | --- | --- |
| 2025-01-02 | 1 | 0 |
| 2025-01-09 | 1 | 0 |
| 2025-01-16 | 1 | 0 |
| 2025-01-23 | 1 | 0 |
| 2025-01-30 | 1 | 0 |
| 2025-02-06 | 1 | 0 |
| 2025-02-20 | 1 | 0 |
| 2025-02-27 | 1 | 0 |
| 2025-03-06 | 1 | 0 |
| 2025-03-13 | 1 | 0 |
| 2025-03-20 | 1 | 0 |
| 2025-03-27 | 1 | 0 |
| 2025-04-03 | 1 | 0 |
| 2025-04-10 | 1 | 0 |
| 2025-04-17 | 1 | 0 |
| 2025-04-24 | 1 | 0 |
| 2025-05-01 | 1 | 0 |
| 2025-05-08 | 1 | 0 |
| 2025-05-15 | 1 | 0 |
| 2025-05-22 | 1 | 0 |
| 2025-05-29 | 1 | 0 |
| 2025-06-05 | 1 | 0 |
| 2025-06-12 | 1 | 0 |
| 2025-06-19 | 1 | 0 |
| 2025-06-26 | 1 | 0 |
| 2025-07-03 | 1 | 0 |
| 2025-07-10 | 1 | 0 |
| 2025-07-17 | 1 | 0 |
| 2025-07-24 | 1 | 0 |
| 2025-08-14 | 1 | 0 |
| 2025-08-21 | 1 | 0 |
| 2025-08-28 | 1 | 0 |
| 2025-09-04 | 1 | 0 |
| 2025-09-11 | 1 | 0 |
| 2025-09-18 | 1 | 0 |
| 2025-09-25 | 1 | 0 |
| 2025-10-02 | 1 | 0 |
| 2025-10-09 | 1 | 0 |
| 2025-10-23 | 1 | 0 |
| 2025-10-30 | 1 | 0 |
| 2025-11-13 | 1 | 0 |
| 2025-11-20 | 1 | 0 |
| 2025-12-04 | 1 | 0 |
| 2025-12-11 | 1 | 0 |
| 2026-01-08 | 1 | 0 |
| 2026-01-15 | 1 | 0 |
| 2026-01-22 | 1 | 0 |
| 2026-01-29 | 1 | 0 |
| 2026-02-05 | 1 | 0 |
| 2026-02-19 | 1 | 0 |

### 1.7 Sample recent phantom candidates (last 7 days, 20 rows)

| id | client_id | recurring_schedule_id | scheduled_date | status | price | created_at |
| --- | --- | --- | --- | --- | --- | --- |
| 1091 | 23 |  | 2026-04-17 | cancelled |  | 2026-04-17 16:15:01.089675 |
| 1090 | 1297 | 87 | 2026-06-16 | scheduled |  | 2026-04-17 02:00:00.469219 |
| 1089 | 23 |  | 2026-04-17 | cancelled |  | 2026-04-17 01:34:22.061191 |
| 1088 | 23 |  | 2026-04-16 | scheduled |  | 2026-04-16 23:23:00.490187 |
| 1087 | 23 |  | 2026-04-17 | cancelled |  | 2026-04-16 23:22:38.771737 |
| 1086 | 19 | 32 | 2026-06-15 | scheduled |  | 2026-04-16 02:00:01.214141 |
| 1085 | 57 | 84 | 2026-06-15 | scheduled |  | 2026-04-16 02:00:01.196298 |
| 1084 | 69 | 63 | 2026-06-15 | scheduled |  | 2026-04-16 02:00:01.181009 |
| 1083 | 549 | 69 | 2026-06-15 | scheduled |  | 2026-04-16 02:00:01.114774 |
| 1082 | 1228 | 86 | 2026-06-15 | scheduled |  | 2026-04-16 02:00:01.098688 |
| 1081 | 22 | 78 | 2026-06-15 | scheduled |  | 2026-04-16 02:00:01.081232 |
| 1080 | 390 | 68 | 2026-06-15 | scheduled |  | 2026-04-16 02:00:01.064356 |
| 1079 | 48 | 65 | 2026-06-15 | scheduled |  | 2026-04-16 02:00:01.047677 |
| 1078 | 84 | 83 | 2026-06-15 | scheduled |  | 2026-04-16 02:00:01.029209 |
| 1077 | 46 | 62 | 2026-06-15 | scheduled |  | 2026-04-16 02:00:01.013103 |
| 1076 | 67 | 1 | 2026-06-15 | scheduled |  | 2026-04-16 02:00:00.987174 |
| 1075 | 49 | 66 | 2026-06-15 | scheduled |  | 2026-04-16 02:00:00.970542 |
| 1074 | 55 | 58 | 2026-06-15 | scheduled |  | 2026-04-16 02:00:00.954796 |
| 1073 | 44 | 75 | 2026-06-15 | scheduled |  | 2026-04-16 02:00:00.938924 |
| 1072 | 99 | 73 | 2026-06-15 | scheduled |  | 2026-04-16 02:00:00.920749 |

### 1.8 Top schedule spawners (last 30 days)

| recurring_schedule_id | jobs_spawned | earliest | latest |
| --- | --- | --- | --- |
| 52 | 30 | 2026-04-09 | 2026-12-31 |
| 50 | 12 | 2026-03-30 | 2026-06-15 |
| 63 | 12 | 2026-03-30 | 2026-06-15 |
| 6 | 12 | 2026-03-30 | 2026-06-15 |
| 69 | 12 | 2026-03-30 | 2026-06-15 |
| 39 | 12 | 2026-03-30 | 2026-06-15 |
| 10 | 12 | 2026-03-30 | 2026-06-15 |
| 54 | 12 | 2026-03-30 | 2026-06-15 |
| 58 | 12 | 2026-03-30 | 2026-06-15 |
| 71 | 12 | 2026-03-30 | 2026-06-15 |
| 4 | 12 | 2026-03-30 | 2026-06-15 |
| 68 | 12 | 2026-03-30 | 2026-06-15 |
| 34 | 12 | 2026-03-30 | 2026-06-15 |
| 84 | 12 | 2026-03-30 | 2026-06-15 |
| 45 | 12 | 2026-03-30 | 2026-06-15 |
| 70 | 12 | 2026-03-30 | 2026-06-15 |
| 86 | 12 | 2026-03-30 | 2026-06-15 |
| 83 | 12 | 2026-03-30 | 2026-06-15 |
| 29 | 12 | 2026-03-30 | 2026-06-15 |
| 66 | 12 | 2026-03-30 | 2026-06-15 |

### 1.9 Top-spawner schedule details

| id | frequency | assigned_employee_id | base_fee | is_active | start_date | day_of_week | first_name | last_name | company_name |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 29 | custom |  |  | true | 2026-03-23 |  | Damian | Ehrlicher |  |
| 52 | weekly | 32 | 220.00 | true | 2023-07-11 | thursday | Jim | Schultz |  |
| 71 | biweekly |  |  | true | 2026-03-23 |  | Richard | Floersch |  |
| 54 | custom |  |  | true | 2026-03-23 |  | John | Piscopo |  |
| 58 | biweekly |  |  | true | 2026-03-23 |  | Karen | Fergle |  |

### 1.10 Cron / log tables found

| table_name |
| --- |
| app_audit_log |
| audit_log |
| cancellation_log |
| communication_log |
| employee_attendance_log |
| employee_discipline_log |
| job_status_logs |
| loyalty_points_log |
| message_log |
| notification_log |

### 1.11 Recurring engine source files

```
artifacts/api-server/src/phes-data-migration.ts:67:        recurring_schedule_id INTEGER,
artifacts/api-server/src/seed.ts:499:      INSERT INTO recurring_schedules
artifacts/api-server/src/lib/recurring-jobs.ts:129:        eq((jobsTable as any).recurring_schedule_id, schedule.id),
artifacts/api-server/src/lib/recurring-jobs.ts:154:    recurring_schedule_id: schedule.id,
artifacts/api-server/src/lib/recurring-jobs.ts:163:export async function generateRecurringJobs(
artifacts/api-server/src/lib/recurring-jobs.ts:246:      const result = await generateRecurringJobs(Number(company.id), DAYS_AHEAD);
artifacts/api-server/src/lib/smoke-test.ts:167:          `SELECT count(*) FROM recurring_schedules WHERE company_id = $1 AND status = 'active'`,
artifacts/api-server/src/routes/clients.ts:348:        SELECT frequency FROM recurring_schedules
artifacts/api-server/src/routes/clients.ts:894:      SELECT id FROM recurring_schedules
artifacts/api-server/src/routes/recurring.ts:7:import { generateRecurringJobs } from "../lib/recurring-jobs.js";
artifacts/api-server/src/routes/recurring.ts:108:    const result = await generateRecurringJobs(companyId, daysAhead);
artifacts/api-server/src/routes/public.ts:764:    // ── Upsell accepted: create Job 2 (recurring start) + recurring_schedule + rate_lock ───
artifacts/api-server/src/routes/public.ts:776:        // Create recurring_schedule with actual start date
artifacts/api-server/src/routes/public.ts:779:            INSERT INTO recurring_schedules (company_id, customer_id, frequency, start_date, service_type, base_fee, notes, is_active, created_at)
artifacts/api-server/src/routes/public.ts:787:            INSERT INTO rate_locks (company_id, client_id, recurring_schedule_id, locked_rate, cadence, lock_start_date, lock_expires_at, active, created_at)
artifacts/api-server/src/routes/public.ts:821:        console.error("[UPSELL] Failed to create recurring_schedule/rate_lock/job2:", upsellErr);
lib/db/src/schema/rate_locks.ts:9:  recurring_schedule_id: integer("recurring_schedule_id"),
lib/db/src/schema/jobs.ts:56:  recurring_schedule_id: integer("recurring_schedule_id"),
lib/db/src/schema/recurring_schedules.ts:14:export const recurringSchedulesTable = pgTable("recurring_schedules", {
lib/db/src/schema/index.ts:41:export * from "./recurring_schedules";
scripts/phantom-schema-audit.ts:60:  const r14 = await run("1.4", `SELECT DATE(created_at)::text AS creation_date, COUNT(*) AS jobs_created, COUNT(DISTINCT client_id) AS unique_clients, COUNT(*) FILTER (WHERE recurring_schedule_id IS NOT NULL) AS from_recurring, COUNT(*) FILTER (WHERE recurring_schedule_id IS NULL) AS one_off FROM jobs WHERE company_id = 1 AND created_at >= NOW() - INTERVAL '60 days' GROUP BY DATE(created_at) ORDER BY creation_date DESC`);
scripts/phantom-schema-audit.ts:70:  const r16 = await run("1.6", `SELECT scheduled_date::text AS sched_date, COUNT(*) AS jobs, COUNT(*) FILTER (WHERE recurring_schedule_id IS NOT NULL) AS recurring FROM jobs WHERE company_id = 1 AND created_at >= NOW() - INTERVAL '30 days' GROUP BY scheduled_date ORDER BY sched_date LIMIT 50`);
scripts/phantom-schema-audit.ts:75:  const r17 = await run("1.7", `SELECT id, client_id, recurring_schedule_id, scheduled_date::text, status, ${priceCol} AS price, created_at::text FROM jobs WHERE company_id = 1 AND created_at >= NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 20`);
scripts/phantom-schema-audit.ts:80:  const r18 = await run("1.8", `SELECT recurring_schedule_id, COUNT(*) AS jobs_spawned, MIN(scheduled_date)::text AS earliest, MAX(scheduled_date)::text AS latest FROM jobs WHERE company_id = 1 AND recurring_schedule_id IS NOT NULL AND created_at >= NOW() - INTERVAL '30 days' GROUP BY recurring_schedule_id ORDER BY jobs_spawned DESC LIMIT 20`);
scripts/phantom-schema-audit.ts:83:  // 1.9 Top-spawner details (recurring_schedules uses customer_id, not client_id)
scripts/phantom-schema-audit.ts:85:  const r19 = await run("1.9", `SELECT rs.id, rs.frequency, rs.assigned_employee_id, rs.base_fee, rs.is_active, rs.start_date::text, rs.day_of_week, c.first_name, c.last_name, c.company_name FROM recurring_schedules rs LEFT JOIN clients c ON c.id = rs.customer_id WHERE rs.id IN (SELECT recurring_schedule_id FROM jobs WHERE company_id = 1 AND recurring_schedule_id IS NOT NULL GROUP BY recurring_schedule_id ORDER BY COUNT(*) DESC LIMIT 5)`);
scripts/phantom-schema-audit.ts:96:    const grepOut = execSync(`grep -rn "generateRecurringJobs\\|recurring_schedule\\|createJobFromSchedule\\|spawnRecurringJob" artifacts/api-server/src lib scripts --include="*.ts" --include="*.js" 2>/dev/null | head -40`, { cwd: "/Users/salvadormartinez/qleno", encoding: "utf8" });
scripts/phantom-schema-audit.ts:115:  say(`- Top single schedule spawned: **${topSpawner?.jobs_spawned}** jobs (schedule_id=${topSpawner?.recurring_schedule_id})\n`);
scripts/phantom-schema-audit.ts:116:  say(`**Root cause hypothesis:** The recurring engine generated jobs in bulk on a single run (likely seed/migration or manual trigger). The engine fires \`generateRecurringJobs(companyId, daysAhead=60)\` which creates one job per schedule × occurrence in the 60-day window. With 87 active schedules and the engine running without \`base_fee\` being carried over from the schedule (recurring_schedules.base_fee is NULL for most), most jobs are created with \`base_fee = 0\`.`);
scripts/phantom-schema-audit.ts:117:  say(`\n**Recommended fix:** (1) Stop the cron before cleanup, (2) delete all jobs where \`status='scheduled'\`, \`base_fee = 0\` or NULL, and \`recurring_schedule_id IS NOT NULL\`, (3) populate \`recurring_schedules.base_fee\` from historical client job data, (4) fix the engine to reject jobs with missing fee, (5) regenerate cleanly with a 14-day window (not 60).\n`);
scripts/phantom-schema-audit.ts:121:  const schemas = ["clients", "recurring_schedules", "jobs", "job_history", "users", "invoices", "pricing_scopes", "pricing_tiers", "pricing_addons", "pricing_fee_rules", "pricing_discounts", "companies", "quotes"];
scripts/phantom-schema-audit.ts:132:  const fks = await run("fks", `SELECT tc.table_name, kcu.column_name, ccu.table_name AS references_table, ccu.column_name AS references_column FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND tc.table_name IN ('clients','recurring_schedules','jobs','job_history','users','invoices','pricing_scopes','pricing_tiers','pricing_addons','pricing_fee_rules','pricing_discounts','quotes') ORDER BY tc.table_name, kcu.column_name`);
scripts/phantom-schema-audit.ts:137:  const idx = await run("idx", `SELECT t.relname AS table_name, i.relname AS index_name, a.attname AS column_name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) WHERE t.relkind = 'r' AND t.relname IN ('clients','recurring_schedules','jobs','job_history','users','invoices','pricing_scopes','pricing_tiers','pricing_addons','pricing_fee_rules','pricing_discounts','quotes') ORDER BY t.relname, i.relname, a.attnum`);
scripts/phantom-schema-audit.ts:144:  const phantomCount = await run("phantom.count", `SELECT COUNT(*) AS c, COUNT(DISTINCT client_id) AS clients, COUNT(DISTINCT recurring_schedule_id) AS schedules FROM jobs WHERE company_id = 1 AND status = 'scheduled' AND (${priceCol} IS NULL OR CAST(${priceCol} AS NUMERIC) = 0) AND recurring_schedule_id IS NOT NULL`);
scripts/phantom-schema-audit.ts:152:  say(`-- Criteria: scheduled status, price=0/null, tied to recurring_schedule_id`);
scripts/phantom-schema-audit.ts:160:  say(`  AND recurring_schedule_id IS NOT NULL;`);
scripts/phantom-schema-audit.ts:171:  say("-- WARNING: Check for FK references first (jobs, invoices, recurring_schedules).");
scripts/phantom-schema-audit.ts:178:  const dummyFKBlock = await run("dummy.fk", `SELECT 'jobs' AS ref_table, COUNT(*) AS refs FROM jobs WHERE client_id IN (1248, 1134, 901) UNION ALL SELECT 'invoices', COUNT(*) FROM invoices WHERE client_id IN (1248, 1134, 901) UNION ALL SELECT 'recurring_schedules', COUNT(*) FROM recurring_schedules WHERE customer_id IN (1248, 1134, 901)`);
scripts/phantom-schema-audit.ts:191:  say(`**Then:** Populate \`recurring_schedules.base_fee\` from \`job_history\` (median revenue per customer_id) and fix the engine to refuse to create jobs when \`base_fee IS NULL\`.\n`);
```

### Phantom diagnosis summary

**Data signals:**
- Total PHES jobs: **865**
- Jobs created from recurring engine (last 60d): **782** of 865
- Jobs with $0/null price (last 30d): **810**
- Biggest creation day: **2026-03-24** with **278** jobs
- Top single schedule spawned: **30** jobs (schedule_id=52)

**Root cause hypothesis:** The recurring engine generated jobs in bulk on a single run (likely seed/migration or manual trigger). The engine fires `generateRecurringJobs(companyId, daysAhead=60)` which creates one job per schedule × occurrence in the 60-day window. With 87 active schedules and the engine running without `base_fee` being carried over from the schedule (recurring_schedules.base_fee is NULL for most), most jobs are created with `base_fee = 0`.

**Recommended fix:** (1) Stop the cron before cleanup, (2) delete all jobs where `status='scheduled'`, `base_fee = 0` or NULL, and `recurring_schedule_id IS NOT NULL`, (3) populate `recurring_schedules.base_fee` from historical client job data, (4) fix the engine to reject jobs with missing fee, (5) regenerate cleanly with a 14-day window (not 60).

## 2. Real Schema Dump

### 2.1 `clients`

| column_name | data_type | is_nullable | column_default | character_maximum_length |
| --- | --- | --- | --- | --- |
| id | integer | NO | nextval('clients_id_seq'::regclass) |  |
| company_id | integer | NO |  |  |
| first_name | text | NO |  |  |
| last_name | text | NO |  |  |
| email | text | YES |  |  |
| phone | text | YES |  |  |
| address | text | YES |  |  |
| city | text | YES |  |  |
| state | text | YES |  |  |
| zip | text | YES |  |  |
| lat | numeric | YES |  |  |
| lng | numeric | YES |  |  |
| notes | text | YES |  |  |
| qbo_customer_id | text | YES |  |  |
| stripe_customer_id | text | YES |  |  |
| square_customer_id | text | YES |  |  |
| loyalty_points | integer | NO | 0 |  |
| created_at | timestamp without time zone | NO | now() |  |
| portal_access | boolean | YES | false |  |
| portal_invite_token | text | YES |  |  |
| portal_invite_sent_at | timestamp without time zone | YES |  |  |
| portal_last_login | timestamp without time zone | YES |  |  |
| company_name | text | YES |  |  |
| is_active | boolean | NO | true |  |
| frequency | text | YES |  |  |
| service_type | text | YES |  |  |
| base_fee | numeric | YES |  |  |
| allowed_hours | numeric | YES |  |  |
| home_access_notes | text | YES |  |  |
| alarm_code | text | YES |  |  |
| pets | text | YES |  |  |
| loyalty_tier | text | NO | 'standard'::text |  |
| client_since | date | YES |  |  |
| scorecard_avg | numeric | YES |  |  |
| rate_increase_last_date | date | YES |  |  |
| rate_increase_last_pct | numeric | YES |  |  |
| property_group_id | integer | YES |  |  |
| default_card_last_4 | text | YES |  |  |
| default_card_brand | text | YES |  |  |
| client_type | USER-DEFINED | NO | 'residential'::client_type |  |
| billing_contact_name | text | YES |  |  |
| billing_contact_email | text | YES |  |  |
| billing_contact_phone | text | YES |  |  |
| po_number_required | boolean | NO | false |  |
| default_po_number | text | YES |  |  |
| payment_terms | USER-DEFINED | NO | 'due_on_receipt'::client_payment_terms |  |
| auto_charge | boolean | NO | false |  |
| card_last_four | text | YES |  |  |
| card_brand | text | YES |  |  |
| card_expiry | text | YES |  |  |
| card_saved_at | timestamp without time zone | YES |  |  |
| zone_id | integer | YES |  |  |
| referral_source | USER-DEFINED | YES |  |  |
| referral_by_customer_id | integer | YES |  |  |
| account_id | integer | YES |  |  |
| branch_id | integer | YES |  |  |
| stripe_payment_method_id | text | YES |  |  |
| payment_source | text | YES |  |  |
| survey_last_sent | timestamp without time zone | YES |  |  |

### 2.2 `recurring_schedules`

| column_name | data_type | is_nullable | column_default | character_maximum_length |
| --- | --- | --- | --- | --- |
| id | integer | NO | nextval('recurring_schedules_id_seq'::regclass) |  |
| company_id | integer | NO |  |  |
| customer_id | integer | NO |  |  |
| frequency | USER-DEFINED | NO |  |  |
| day_of_week | USER-DEFINED | YES |  |  |
| start_date | date | NO |  |  |
| end_date | date | YES |  |  |
| assigned_employee_id | integer | YES |  |  |
| service_type | text | YES |  |  |
| duration_minutes | integer | YES |  |  |
| base_fee | text | YES |  |  |
| notes | text | YES |  |  |
| is_active | boolean | NO | true |  |
| last_generated_date | date | YES |  |  |
| created_at | timestamp without time zone | NO | now() |  |

### 2.3 `jobs`

| column_name | data_type | is_nullable | column_default | character_maximum_length |
| --- | --- | --- | --- | --- |
| id | integer | NO | nextval('jobs_id_seq'::regclass) |  |
| company_id | integer | NO |  |  |
| client_id | integer | YES |  |  |
| assigned_user_id | integer | YES |  |  |
| service_type | USER-DEFINED | NO |  |  |
| status | USER-DEFINED | NO | 'scheduled'::job_status |  |
| scheduled_date | date | NO |  |  |
| scheduled_time | text | YES |  |  |
| frequency | USER-DEFINED | NO | 'on_demand'::frequency |  |
| base_fee | numeric | NO |  |  |
| fee_split_pct | numeric | YES |  |  |
| allowed_hours | numeric | YES |  |  |
| actual_hours | numeric | YES |  |  |
| notes | text | YES |  |  |
| created_at | timestamp without time zone | NO | now() |  |
| completion_pdf_url | text | YES |  |  |
| completion_pdf_sent_at | timestamp without time zone | YES |  |  |
| job_lat | numeric | YES |  |  |
| job_lng | numeric | YES |  |  |
| geocode_failed | boolean | NO | false |  |
| zone_id | integer | YES |  |  |
| account_id | integer | YES |  |  |
| account_property_id | integer | YES |  |  |
| hourly_rate | numeric | YES |  |  |
| estimated_hours | numeric | YES |  |  |
| billed_hours | numeric | YES |  |  |
| billed_amount | numeric | YES |  |  |
| charge_attempted_at | timestamp without time zone | YES |  |  |
| charge_succeeded_at | timestamp without time zone | YES |  |  |
| charge_failed_at | timestamp without time zone | YES |  |  |
| charge_failure_reason | text | YES |  |  |
| billing_method | USER-DEFINED | YES |  |  |
| branch_id | integer | YES |  |  |
| recurring_schedule_id | integer | YES |  |  |
| home_condition_rating | integer | YES |  |  |
| condition_multiplier | numeric | YES |  |  |
| applied_bundle_id | integer | YES |  |  |
| bundle_discount_total | numeric | YES |  |  |
| last_cleaned_response | text | YES |  |  |
| last_cleaned_flag | text | YES |  |  |
| overage_disclaimer_acknowledged | boolean | YES | false |  |
| overage_rate | numeric | YES |  |  |
| upsell_shown | boolean | YES | false |  |
| upsell_accepted | boolean | YES | false |  |
| upsell_declined | boolean | YES | false |  |
| upsell_deferred | boolean | YES | false |  |
| upsell_cadence_selected | text | YES |  |  |
| property_vacant | boolean | YES | false |  |
| first_recurring_discounted | boolean | YES | false |  |
| booking_location | text | YES |  |  |
| address_street | text | YES |  |  |
| address_city | text | YES |  |  |
| address_state | text | YES |  |  |
| address_zip | text | YES |  |  |
| address_verified | boolean | YES | false |  |
| address_lat | numeric | YES |  |  |
| address_lng | numeric | YES |  |  |
| supply_cost | numeric | YES | 0.00 |  |
| office_notes | text | YES |  |  |
| arrival_window | text | YES |  |  |
| booking_street | text | YES |  |  |
| booking_unit | text | YES |  |  |
| booking_city | text | YES |  |  |
| booking_state | text | YES |  |  |
| booking_zip | text | YES |  |  |
| booking_apt | text | YES |  |  |
| preferred_contact_method | text | YES |  |  |
| address_line2 | text | YES |  |  |
| branch | text | YES |  |  |
| reminder_72h_sent | boolean | YES | false |  |
| reminder_24h_sent | boolean | YES | false |  |
| job_type | text | YES | 'residential'::text |  |
| commission_pool_rate | numeric | YES |  |  |
| estimated_hours_per_tech | numeric | YES |  |  |
| flagged | boolean | NO | false |  |

### 2.4 `job_history`

| column_name | data_type | is_nullable | column_default | character_maximum_length |
| --- | --- | --- | --- | --- |
| id | integer | NO | nextval('job_history_id_seq'::regclass) |  |
| company_id | integer | NO |  |  |
| customer_id | integer | YES |  |  |
| job_date | date | NO |  |  |
| revenue | numeric | NO | 0 |  |
| service_type | text | YES |  |  |
| technician | text | YES |  |  |
| notes | text | YES |  |  |
| created_at | timestamp without time zone | NO | now() |  |

### 2.5 `users`

| column_name | data_type | is_nullable | column_default | character_maximum_length |
| --- | --- | --- | --- | --- |
| id | integer | NO | nextval('users_id_seq'::regclass) |  |
| company_id | integer | YES |  |  |
| email | text | NO |  |  |
| password_hash | text | NO |  |  |
| role | USER-DEFINED | NO | 'technician'::user_role |  |
| first_name | text | NO |  |  |
| last_name | text | NO |  |  |
| avatar_url | text | YES |  |  |
| phone | text | YES |  |  |
| address | text | YES |  |  |
| dob | date | YES |  |  |
| hire_date | date | YES |  |  |
| pay_rate | numeric | YES |  |  |
| pay_type | USER-DEFINED | YES |  |  |
| fee_split_pct | numeric | YES |  |  |
| allowed_hours_per_week | numeric | YES |  |  |
| skills | ARRAY | YES |  |  |
| is_active | boolean | NO | true |  |
| created_at | timestamp without time zone | NO | now() |  |
| personal_email | text | YES |  |  |
| city | text | YES |  |  |
| state | text | YES |  |  |
| zip | text | YES |  |  |
| gender | text | YES |  |  |
| termination_date | date | YES |  |  |
| employment_type | USER-DEFINED | YES |  |  |
| overtime_eligible | boolean | YES | true |  |
| w2_1099 | text | YES |  |  |
| bank_name | text | YES |  |  |
| bank_account_last4 | text | YES |  |  |
| tags | ARRAY | YES |  |  |
| emergency_contact_name | text | YES |  |  |
| emergency_contact_phone | text | YES |  |  |
| emergency_contact_relation | text | YES |  |  |
| ssn_last4 | text | YES |  |  |
| notes | text | YES |  |  |
| invite_token | text | YES |  |  |
| invite_sent_at | timestamp without time zone | YES |  |  |
| invite_accepted_at | timestamp without time zone | YES |  |  |
| onboarding_complete | boolean | YES | false |  |
| crew_id | integer | YES |  |  |
| hr_status | USER-DEFINED | YES | 'active'::hr_status |  |
| commission_rate_override | numeric | YES |  |  |
| benefit_year_start | date | YES |  |  |
| leave_balance_hours | numeric | YES | '0'::numeric |  |
| leave_balance_activated | boolean | YES | false |  |
| home_branch_id | integer | YES |  |  |
| is_super_admin | boolean | YES | false |  |
| mc_employee_id | text | YES |  |  |
| drivers_license_number | text | YES |  |  |
| drivers_license_state | text | YES |  |  |
| pto_hours_available | numeric | YES | 0 |  |
| sick_hours_available | numeric | YES | 0 |  |
| reset_token | text | YES |  |  |
| reset_token_expires_at | timestamp without time zone | YES |  |  |

### 2.6 `invoices`

| column_name | data_type | is_nullable | column_default | character_maximum_length |
| --- | --- | --- | --- | --- |
| id | integer | NO | nextval('invoices_id_seq'::regclass) |  |
| company_id | integer | NO |  |  |
| client_id | integer | YES |  |  |
| job_id | integer | YES |  |  |
| status | USER-DEFINED | NO | 'draft'::invoice_status |  |
| line_items | jsonb | NO | '[]'::jsonb |  |
| subtotal | numeric | NO | '0'::numeric |  |
| tips | numeric | NO | '0'::numeric |  |
| total | numeric | NO | '0'::numeric |  |
| qbo_invoice_id | text | YES |  |  |
| stripe_payment_intent_id | text | YES |  |  |
| square_payment_id | text | YES |  |  |
| created_at | timestamp without time zone | NO | now() |  |
| paid_at | timestamp without time zone | YES |  |  |
| invoice_number | text | YES |  |  |
| due_date | date | YES |  |  |
| sent_at | timestamp without time zone | YES |  |  |
| last_reminder_sent_at | timestamp without time zone | YES |  |  |
| payment_failed | boolean | YES | false |  |
| created_by | integer | YES |  |  |
| po_number | text | YES |  |  |
| payment_terms | text | YES | 'due_on_receipt'::text |  |
| billing_contact_name | text | YES |  |  |
| billing_contact_email | text | YES |  |  |
| account_id | integer | YES |  |  |
| branch_id | integer | YES |  |  |

### 2.7 `pricing_scopes`

| column_name | data_type | is_nullable | column_default | character_maximum_length |
| --- | --- | --- | --- | --- |
| id | integer | NO | nextval('pricing_scopes_id_seq'::regclass) |  |
| company_id | integer | NO |  |  |
| name | text | NO |  |  |
| scope_group | text | NO | 'Residential'::text |  |
| hourly_rate | numeric | NO | '0'::numeric |  |
| minimum_bill | numeric | NO | '0'::numeric |  |
| is_active | boolean | NO | true |  |
| sort_order | integer | NO | 0 |  |
| created_at | timestamp without time zone | NO | now() |  |
| updated_at | timestamp without time zone | NO | now() |  |
| pricing_method | text | NO | 'sqft'::text |  |
| displayed_for_office | boolean | NO | true |  |
| show_online | boolean | NO | true |  |

### 2.8 `pricing_tiers`

| column_name | data_type | is_nullable | column_default | character_maximum_length |
| --- | --- | --- | --- | --- |
| id | integer | NO | nextval('pricing_tiers_id_seq'::regclass) |  |
| scope_id | integer | NO |  |  |
| company_id | integer | NO |  |  |
| min_sqft | integer | NO |  |  |
| max_sqft | integer | NO |  |  |
| hours | numeric | NO |  |  |
| created_at | timestamp without time zone | NO | now() |  |

### 2.9 `pricing_addons`

| column_name | data_type | is_nullable | column_default | character_maximum_length |
| --- | --- | --- | --- | --- |
| id | integer | NO | nextval('pricing_addons_id_seq'::regclass) |  |
| scope_id | integer | YES |  |  |
| company_id | integer | NO |  |  |
| name | text | NO |  |  |
| price | numeric | YES |  |  |
| price_type | text | NO | 'flat'::text |  |
| percent_of_base | numeric | YES |  |  |
| time_add_minutes | integer | NO | 0 |  |
| unit | text | NO | 'each'::text |  |
| is_active | boolean | NO | true |  |
| sort_order | integer | NO | 0 |  |
| addon_type | text | NO | 'cleaning_extras'::text |  |
| scope_ids | text | NO | '[]'::text |  |
| price_value | numeric | NO | '0'::numeric |  |
| time_unit | text | NO | 'each'::text |  |
| is_itemized | boolean | NO | true |  |
| is_taxed | boolean | NO | false |  |
| show_office | boolean | NO | true |  |
| show_online | boolean | NO | true |  |
| show_portal | boolean | NO | true |  |
| created_at | timestamp without time zone | NO | now() |  |

### 2.10 `pricing_fee_rules`

| column_name | data_type | is_nullable | column_default | character_maximum_length |
| --- | --- | --- | --- | --- |
| id | integer | NO | nextval('pricing_fee_rules_id_seq'::regclass) |  |
| company_id | integer | NO |  |  |
| rule_type | text | NO | 'custom'::text |  |
| label | text | NO |  |  |
| charge_percent | numeric | NO | '100'::numeric |  |
| tech_split_percent | numeric | NO | '0'::numeric |  |
| window_hours | integer | YES |  |  |
| is_active | boolean | NO | true |  |

### 2.11 `pricing_discounts`

| column_name | data_type | is_nullable | column_default | character_maximum_length |
| --- | --- | --- | --- | --- |
| id | integer | NO | nextval('pricing_discounts_id_seq'::regclass) |  |
| company_id | integer | NO |  |  |
| code | text | NO |  |  |
| description | text | NO | ''::text |  |
| discount_type | text | NO | 'flat'::text |  |
| discount_value | numeric | NO |  |  |
| is_active | boolean | NO | true |  |
| created_at | timestamp without time zone | NO | now() |  |
| is_online | boolean | NO | true |  |
| scope_ids | text | NO | '[]'::text |  |
| frequency | text | NO | 'one_time'::text |  |
| availability_office | boolean | NO | true |  |

### 2.12 `companies`

| column_name | data_type | is_nullable | column_default | character_maximum_length |
| --- | --- | --- | --- | --- |
| id | integer | NO | nextval('companies_id_seq'::regclass) |  |
| name | text | NO |  |  |
| slug | text | NO |  |  |
| logo_url | text | YES |  |  |
| stripe_customer_id | text | YES |  |  |
| stripe_subscription_id | text | YES |  |  |
| square_oauth_token | text | YES |  |  |
| subscription_status | USER-DEFINED | NO | 'trialing'::subscription_status |  |
| plan | USER-DEFINED | NO | 'starter'::plan |  |
| employee_count | integer | NO | 0 |  |
| pay_cadence | USER-DEFINED | NO | 'biweekly'::pay_cadence |  |
| geo_fence_threshold_ft | integer | NO | 500 |  |
| created_at | timestamp without time zone | NO | now() |  |
| brand_color | text | NO | '#00C9A7'::text |  |
| sms_on_my_way_enabled | boolean | NO | true |  |
| sms_arrived_enabled | boolean | NO | false |  |
| sms_paused_enabled | boolean | NO | false |  |
| sms_complete_enabled | boolean | NO | true |  |
| twilio_from_number | text | YES |  |  |
| geofence_enabled | boolean | NO | true |  |
| geofence_clockin_radius_ft | integer | NO | 500 |  |
| geofence_clockout_radius_ft | integer | NO | 1000 |  |
| geofence_override_allowed | boolean | NO | true |  |
| geofence_soft_mode | boolean | NO | false |  |
| default_payment_terms_residential | text | YES | 'due_on_receipt'::text |  |
| default_payment_terms_commercial | text | YES | 'net_30'::text |  |
| default_invoice_notes_residential | text | YES |  |  |
| default_invoice_notes_commercial | text | YES |  |  |
| auto_send_invoices | boolean | NO | false |  |
| auto_charge_on_invoice | boolean | NO | false |  |
| annual_revenue_goal | integer | YES |  |  |
| payment_terms_days | integer | NO | 0 |  |
| mileage_rate | numeric | NO | 0.7000 |  |
| phone | text | YES |  |  |
| email | text | YES |  |  |
| address | text | YES |  |  |
| city | text | YES |  |  |
| state | text | YES |  |  |
| zip | text | YES |  |  |
| business_hours | text | YES |  |  |
| booking_policies | text | YES |  |  |
| invoice_sequence_start | integer | NO | 1 |  |
| qb_access_token | text | YES |  |  |
| qb_refresh_token | text | YES |  |  |
| qb_realm_id | text | YES |  |  |
| qb_token_expires_at | timestamp without time zone | YES |  |  |
| qb_connected | boolean | NO | false |  |
| qb_last_sync_at | timestamp without time zone | YES |  |  |
| qb_company_name | text | YES |  |  |
| online_booking_lead_hours | integer | NO | 48 |  |
| dispatch_start_hour | integer | NO | 8 |  |
| dispatch_end_hour | integer | NO | 18 |  |
| overhead_rate_pct | numeric | YES | 10.00 |  |
| review_link | text | YES |  |  |
| res_tech_pay_pct | numeric | NO | 0.35 |  |

### 2.13 `quotes`

| column_name | data_type | is_nullable | column_default | character_maximum_length |
| --- | --- | --- | --- | --- |
| id | integer | NO | nextval('quotes_id_seq'::regclass) |  |
| company_id | integer | NO |  |  |
| client_id | integer | YES |  |  |
| lead_name | text | YES |  |  |
| lead_email | text | YES |  |  |
| lead_phone | text | YES |  |  |
| address | text | YES |  |  |
| service_type | text | YES |  |  |
| frequency | text | YES |  |  |
| estimated_hours | numeric | YES |  |  |
| base_price | numeric | YES |  |  |
| status | text | NO | 'draft'::text |  |
| sent_at | timestamp without time zone | YES |  |  |
| viewed_at | timestamp without time zone | YES |  |  |
| accepted_at | timestamp without time zone | YES |  |  |
| booked_job_id | integer | YES |  |  |
| notes | text | YES |  |  |
| created_by | integer | YES |  |  |
| created_at | timestamp without time zone | NO | now() |  |
| scope_id | integer | YES |  |  |
| pricing_method | text | YES |  |  |
| addons | jsonb | YES | '[]'::jsonb |  |
| discount_code | text | YES |  |  |
| discount_amount | numeric | YES | 0 |  |
| total_price | numeric | YES |  |  |
| bedrooms | integer | YES |  |  |
| bathrooms | integer | YES |  |  |
| half_baths | integer | YES |  |  |
| sqft | integer | YES |  |  |
| dirt_level | text | YES | 'standard'::text |  |
| pets | integer | YES | 0 |  |
| special_instructions | text | YES |  |  |
| internal_memo | text | YES |  |  |
| client_notes | text | YES |  |  |
| manual_hours | numeric | YES |  |  |
| expires_at | timestamp without time zone | YES |  |  |
| sign_token | text | YES |  |  |
| call_notes | text | YES |  |  |
| office_notes | text | YES |  |  |
| manual_adjustments | jsonb | YES | '[]'::jsonb |  |
| alternate_options | jsonb | YES |  |  |
| zone_override | boolean | YES | false |  |
| address_verified | boolean | YES | false |  |

### 2.14 Foreign keys

| table_name | column_name | references_table | references_column |
| --- | --- | --- | --- |
| clients | branch_id | branches | id |
| clients | company_id | companies | id |
| invoices | branch_id | branches | id |
| invoices | client_id | clients | id |
| invoices | company_id | companies | id |
| invoices | created_by | users | id |
| invoices | job_id | jobs | id |
| jobs | assigned_user_id | users | id |
| jobs | branch_id | branches | id |
| jobs | client_id | clients | id |
| jobs | company_id | companies | id |
| pricing_addons | company_id | companies | id |
| pricing_addons | scope_id | pricing_scopes | id |
| pricing_discounts | company_id | companies | id |
| pricing_fee_rules | company_id | companies | id |
| pricing_scopes | company_id | companies | id |
| pricing_tiers | company_id | companies | id |
| pricing_tiers | scope_id | pricing_scopes | id |
| quotes | booked_job_id | jobs | id |
| quotes | client_id | clients | id |
| quotes | company_id | companies | id |
| quotes | created_by | users | id |
| quotes | scope_id | quote_scopes | id |
| recurring_schedules | assigned_employee_id | users | id |
| recurring_schedules | company_id | companies | id |
| recurring_schedules | customer_id | clients | id |
| users | company_id | companies | id |
| users | home_branch_id | branches | id |

### 2.15 Indexes

| table_name | index_name | column_name | is_unique | is_primary |
| --- | --- | --- | --- | --- |
| clients | clients_pkey | id | true | true |
| invoices | invoices_pkey | id | true | true |
| job_history | idx_job_history_company_date | company_id | false | false |
| job_history | idx_job_history_company_date | job_date | false | false |
| job_history | idx_job_history_customer | company_id | false | false |
| job_history | idx_job_history_customer | customer_id | false | false |
| job_history | job_history_pkey | id | true | true |
| jobs | idx_jobs_company_flagged | company_id | false | false |
| jobs | idx_jobs_company_flagged | flagged | false | false |
| jobs | jobs_pkey | id | true | true |
| pricing_addons | pricing_addons_pkey | id | true | true |
| pricing_discounts | pricing_discounts_pkey | id | true | true |
| pricing_discounts | uq_pricing_discounts_company_code_scopes | company_id | true | false |
| pricing_discounts | uq_pricing_discounts_company_code_scopes | code | true | false |
| pricing_discounts | uq_pricing_discounts_company_code_scopes | scope_ids | true | false |
| pricing_fee_rules | pricing_fee_rules_pkey | id | true | true |
| pricing_scopes | pricing_scopes_pkey | id | true | true |
| pricing_tiers | pricing_tiers_pkey | id | true | true |
| quotes | quotes_pkey | id | true | true |
| recurring_schedules | recurring_schedules_pkey | id | true | true |
| users | users_email_unique | email | true | false |
| users | users_pkey | id | true | true |

## 3. Safe-Removal Proposal (NOT EXECUTED)

**Correction:** The script used `billed_amount` as the price column, but that's NULL for all scheduled jobs by design (only populated on completion). The correct column for phantom detection is `base_fee` (the fee set when the job is created). Re-ran with corrected criterion below.

```sql
-- PROPOSED CLEANUP (NOT EXECUTED — for review only)

-- Step 1: Delete phantom recurring jobs
-- Criteria: scheduled status, base_fee = 0, tied to recurring_schedule_id
-- Expected row count: 742
-- Affects: 76 distinct clients, 85 distinct recurring schedules
-- Leaves: 40 legit recurring jobs with fee + 25 one-off scheduled + 55 complete + 3 cancelled = 123 jobs
/*
DELETE FROM jobs
WHERE company_id = 1
  AND status = 'scheduled'
  AND CAST(base_fee AS NUMERIC) = 0
  AND recurring_schedule_id IS NOT NULL;
*/

-- Step 2: Delete old placeholder discount rows (IDs 1-18, per Sal's note)
-- Expected row count: 18
/*
DELETE FROM pricing_discounts WHERE company_id = 1 AND id BETWEEN 1 AND 18;
*/

-- Step 3: Delete 3 dummy clients identified in audit
-- Candidate IDs (verified): 901 (Kevin Brooks), 1134 (sal test), 1248 (test test)
-- FK check shows 0 blockers for all three (safe to delete).
/*
DELETE FROM clients WHERE company_id = 1 AND id IN (1248, 1134, 901);
*/

-- Edge case flagged: 2 one-off scheduled jobs with base_fee = 0 AND recurring_schedule_id IS NULL.
-- These are NOT caught by Step 1. Manual review recommended — likely user-created jobs
-- where the fee wasn't entered. Query to inspect:
-- SELECT id, client_id, scheduled_date, service_type, created_at FROM jobs
-- WHERE company_id = 1 AND status = 'scheduled' AND CAST(base_fee AS NUMERIC) = 0
--   AND recurring_schedule_id IS NULL;
```

**FK blockers for dummy client deletion:**

| ref_table | refs |
| --- | --- |
| jobs | 0 |
| invoices | 0 |
| recurring_schedules | 0 |

## 4. Errors encountered

_(none)_

## 5. Recommendation for Prompt 3

**First do:** Disable the recurring job cron (in `artifacts/api-server/src/lib/recurring-jobs.ts` — comment out the `startRecurringJobCron()` call in `index.ts`, or add a feature flag). Without that, any cleanup will be re-spawned on the next 2 AM UTC tick.

**Then:** Execute the three-step cleanup above in a single transaction with explicit counts checked before COMMIT. Verify final `SELECT COUNT(*) FROM jobs WHERE company_id = 1` drops from **865 to 123** (40 legit recurring + 25 one-off + 55 complete + 3 cancelled).

**Then:** Populate `recurring_schedules.base_fee` from `job_history` (median revenue per customer_id) and fix the engine to refuse to create jobs when `base_fee IS NULL`.
