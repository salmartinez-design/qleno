-- ============================================================================
-- Purge "ZZ E2E TEST" test data (jobs + payroll/cancellation footprint)
-- ----------------------------------------------------------------------------
-- Context: E2E/manual test jobs ("ZZ E2E TEST", 123 E2E Test Ave, Oak Lawn)
-- leaked onto real techs' schedules and the time clock (as phantom
-- "CANCELLATION FEE" lines). This script finds those rows and removes them.
--
-- SAFETY (per CLAUDE.md "Always dry-run before any destructive DB operation"):
--   1. Run STEP 0 + STEP 1 (SELECT only) and eyeball the rows. Confirm every
--      job listed really is test data before deleting anything.
--   2. Then run ONE of:
--        STEP 2A  — soft clear (recommended): cancels the test jobs and wipes
--                   their cancellation-fee payroll rows. Reversible-ish, low
--                   risk, immediately clears the schedule + time clock.
--        STEP 2B  — hard purge: fully deletes the test jobs, their child rows,
--                   and (optionally) the test client. Irreversible.
--   3. Everything runs inside a transaction — inspect the row counts the
--      DELETEs report, then COMMIT (or ROLLBACK if anything looks off).
--
-- Multi-tenant note: the CTE self-scopes to the test client's own company_id,
-- so it can only ever touch Phes's ZZ E2E TEST data. Run as a role that can
-- see the rows (RLS is enabled).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- STEP 0 — identify the test client(s). READ ONLY. Confirm this is only test data.
-- ---------------------------------------------------------------------------
SELECT id AS client_id, company_id,
       TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name,
       company_name, address, zip
  FROM clients
 WHERE TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ILIKE 'ZZ E2E TEST%'
    OR company_name ILIKE 'ZZ E2E TEST%'
    OR address ILIKE '%123 E2E Test Ave%';

-- ---------------------------------------------------------------------------
-- STEP 1 — the jobs + their payroll/cancellation footprint. READ ONLY.
-- ---------------------------------------------------------------------------
WITH test_clients AS (
  SELECT id, company_id
    FROM clients
   WHERE TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ILIKE 'ZZ E2E TEST%'
      OR company_name ILIKE 'ZZ E2E TEST%'
      OR address ILIKE '%123 E2E Test Ave%'
),
test_jobs AS (
  SELECT j.id, j.company_id
    FROM jobs j
    JOIN test_clients tc ON tc.id = j.client_id
   -- also catch jobs whose own address is the test address (belt & suspenders)
   UNION
  SELECT j.id, j.company_id
    FROM jobs j
   WHERE j.address_street ILIKE '%123 E2E Test Ave%'
)
SELECT
  (SELECT count(*) FROM test_jobs)                                                   AS test_jobs,
  (SELECT count(*) FROM job_technicians  WHERE job_id IN (SELECT id FROM test_jobs)) AS job_technician_rows,
  (SELECT count(*) FROM timeclock        WHERE job_id IN (SELECT id FROM test_jobs)) AS timeclock_rows,
  (SELECT count(*) FROM additional_pay   WHERE job_id IN (SELECT id FROM test_jobs)) AS additional_pay_rows,
  (SELECT count(*) FROM cancellation_log WHERE job_id IN (SELECT id FROM test_jobs)) AS cancellation_log_rows;

-- Detailed job list (verify each one is test data):
WITH test_clients AS (
  SELECT id FROM clients
   WHERE TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ILIKE 'ZZ E2E TEST%'
      OR company_name ILIKE 'ZZ E2E TEST%'
      OR address ILIKE '%123 E2E Test Ave%'
)
SELECT j.id AS job_id, j.status, j.scheduled_date, j.assigned_user_id,
       j.billed_amount, j.address_street
  FROM jobs j
 WHERE j.client_id IN (SELECT id FROM test_clients)
    OR j.address_street ILIKE '%123 E2E Test Ave%'
 ORDER BY j.scheduled_date, j.id;


-- ============================================================================
-- STEP 2A — SOFT CLEAR (RECOMMENDED). Cancels the test jobs and removes the
-- phantom cancellation-fee payroll rows, so they drop off dispatch, the time
-- clock, and reports immediately. Keeps the client + job shells around.
-- ============================================================================
BEGIN;

WITH test_clients AS (
  SELECT id FROM clients
   WHERE TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ILIKE 'ZZ E2E TEST%'
      OR company_name ILIKE 'ZZ E2E TEST%'
      OR address ILIKE '%123 E2E Test Ave%'
),
test_jobs AS (
  SELECT j.id
    FROM jobs j
   WHERE j.client_id IN (SELECT id FROM test_clients)
      OR j.address_street ILIKE '%123 E2E Test Ave%'
)
DELETE FROM additional_pay
 WHERE job_id IN (SELECT id FROM test_jobs)
   AND type = 'cancellation_pay';           -- phantom time-clock fee rows

WITH test_clients AS (
  SELECT id FROM clients
   WHERE TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ILIKE 'ZZ E2E TEST%'
      OR company_name ILIKE 'ZZ E2E TEST%'
      OR address ILIKE '%123 E2E Test Ave%'
)
UPDATE jobs
   SET status = 'cancelled', billed_amount = 0
 WHERE (client_id IN (SELECT id FROM test_clients) OR address_street ILIKE '%123 E2E Test Ave%')
   AND status <> 'cancelled';

-- Inspect the counts above. If correct:
--   COMMIT;
-- else:
--   ROLLBACK;


-- ============================================================================
-- STEP 2B — HARD PURGE (IRREVERSIBLE). Deletes the test jobs and every child
-- row, then the test client. Only run this if 2A isn't enough and you're sure.
-- Uncomment the block, run, verify counts, then COMMIT / ROLLBACK.
-- ============================================================================
-- BEGIN;
--
-- CREATE TEMP TABLE _tj ON COMMIT DROP AS
--   WITH test_clients AS (
--     SELECT id FROM clients
--      WHERE TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ILIKE 'ZZ E2E TEST%'
--         OR company_name ILIKE 'ZZ E2E TEST%'
--         OR address ILIKE '%123 E2E Test Ave%'
--   )
--   SELECT j.id
--     FROM jobs j
--    WHERE j.client_id IN (SELECT id FROM test_clients)
--       OR j.address_street ILIKE '%123 E2E Test Ave%';
--
-- DELETE FROM additional_pay    WHERE job_id IN (SELECT id FROM _tj);
-- DELETE FROM cancellation_log  WHERE job_id IN (SELECT id FROM _tj);
-- DELETE FROM timeclock         WHERE job_id IN (SELECT id FROM _tj);
-- DELETE FROM job_add_ons       WHERE job_id IN (SELECT id FROM _tj);  -- skip if table absent
-- DELETE FROM job_technicians   WHERE job_id IN (SELECT id FROM _tj);
-- DELETE FROM jobs              WHERE id     IN (SELECT id FROM _tj);
-- -- Optional: also remove the test client shell(s):
-- -- DELETE FROM clients
-- --  WHERE TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ILIKE 'ZZ E2E TEST%'
-- --     OR company_name ILIKE 'ZZ E2E TEST%'
-- --     OR address ILIKE '%123 E2E Test Ave%';
--
-- -- Verify counts, then:
-- --   COMMIT;   -- or ROLLBACK;
