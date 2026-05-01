// [PR #28 / 2026-04-30] Playwright DB helper.
//
// Direct Postgres access for test setup/teardown. Two responsibilities:
//
//   1. cloneClient(srcId)        — copy a real client + their
//      recurring_schedules + jobs (last 14 days back, 60 days
//      forward) + linked tech/addon rows to a fresh TEST_ client.
//      Test mutations target the clone; the source row is
//      untouched.
//
//   2. cleanupTestClient(id)     — hard-delete the cloned rows
//      after a test. The TEST_ prefix on first_name + last_name
//      makes them findable; cleanupAllTestClients() is the
//      panic-button for stuck CI runs.
//
// Uses the `pg` driver directly (NOT Drizzle) so the helper has
// zero dependency on the api-server's schema imports — which means
// these tests can run before the api-server even compiles.
//
// DATABASE_URL is sourced from the same env var the api-server
// reads. In CI this points to the local Postgres service container;
// locally it can point to a dev DB. We never run against
// production from this helper — the workflow file enforces that
// by setting DATABASE_URL to the service-container URL before
// invoking playwright.

import { Client } from "pg";

export type TestClientHandle = {
  id: number;
  companyId: number;
  sourceId: number;
};

export async function getDbClient(): Promise<Client> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("getDbClient: DATABASE_URL not set");
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

// Clone a real client + their schedule(s) + a window of jobs to a
// fresh TEST_ row. Called from each test's beforeEach; the cloned
// id is stable for the test's duration and torn down in afterEach.
//
// Cloning surface (intentionally narrow — we only copy what the
// cascade test exercises):
//   clients              — first_name/last_name prefixed TEST_
//   recurring_schedules  — all active rows for srcId
//   jobs                 — rows in [today-14d, today+60d] window
//   job_technicians      — for each cloned job
//   job_add_ons          — for each cloned job
//
// NOT cloned (out of scope for the cascade proof-of-life):
//   timeclock entries, scorecards, invoices, payments, photos,
//   recurring_schedule_technicians, recurring_schedule_add_ons.
// Add to this list as new tests need them — keep the surface small
// to keep the seed time tight.
export async function cloneClient(
  pg: Client,
  srcId: number,
  prefix = "TEST_",
): Promise<TestClientHandle> {
  // 1. Insert the cloned client. SELECT * the source, mutate
  //    first_name/last_name to TEST_-prefixed values, INSERT.
  const src = await pg.query(`SELECT * FROM clients WHERE id = $1 LIMIT 1`, [srcId]);
  if (!src.rows.length) throw new Error(`cloneClient: source id=${srcId} not found`);
  const s = src.rows[0];

  const cloned = await pg.query(
    `INSERT INTO clients (
       company_id, first_name, last_name, email, phone, address, city, state, zip,
       client_type, payment_method, net_terms, notes, is_active
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true)
     RETURNING id`,
    [
      s.company_id,
      `${prefix}${s.first_name ?? "Test"}`,
      `${prefix}${s.last_name ?? "Client"}`,
      // Use a per-clone email so unique constraints (if any) don't bite.
      `test+${Date.now()}@qleno-e2e.local`,
      s.phone, s.address, s.city, s.state, s.zip,
      s.client_type, s.payment_method, s.net_terms, s.notes,
    ],
  );
  const newClientId = Number(cloned.rows[0].id);

  // 2. Clone active recurring_schedules.
  const schedules = await pg.query(
    `SELECT * FROM recurring_schedules WHERE customer_id = $1 AND is_active = true`,
    [srcId],
  );
  for (const r of schedules.rows) {
    await pg.query(
      `INSERT INTO recurring_schedules (
         company_id, customer_id, frequency, day_of_week, days_of_week,
         custom_frequency_weeks, start_date, end_date, scheduled_time,
         assigned_employee_id, service_type, duration_minutes, base_fee,
         commercial_hourly_rate, notes, instructions, is_active,
         parking_fee_enabled, parking_fee_amount, parking_fee_days
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, true, $17, $18, $19
       )`,
      [
        r.company_id, newClientId, r.frequency, r.day_of_week, r.days_of_week,
        r.custom_frequency_weeks, r.start_date, r.end_date, r.scheduled_time,
        r.assigned_employee_id, r.service_type, r.duration_minutes, r.base_fee,
        r.commercial_hourly_rate, r.notes, r.instructions,
        r.parking_fee_enabled, r.parking_fee_amount, r.parking_fee_days,
      ],
    );
  }

  // 3. Clone jobs in the [today-14d, today+60d] window. The cascade
  //    test wants existing imported Tue–Fri jobs to overwrite + a
  //    Monday anchor — this window covers both with margin.
  const jobs = await pg.query(
    `SELECT * FROM jobs
       WHERE client_id = $1
         AND scheduled_date BETWEEN (CURRENT_DATE - INTERVAL '14 days')
                                AND (CURRENT_DATE + INTERVAL '60 days')`,
    [srcId],
  );
  const oldToNewJobId = new Map<number, number>();
  for (const j of jobs.rows) {
    const ins = await pg.query(
      `INSERT INTO jobs (
         company_id, client_id, assigned_user_id, service_type, status,
         scheduled_date, scheduled_time, frequency, base_fee, allowed_hours,
         notes, recurring_schedule_id, hourly_rate, manual_rate_override
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12, $13
       ) RETURNING id`,
      [
        j.company_id, newClientId, j.assigned_user_id, j.service_type, j.status,
        j.scheduled_date, j.scheduled_time, j.frequency, j.base_fee, j.allowed_hours,
        j.notes, j.hourly_rate, j.manual_rate_override,
      ],
    );
    oldToNewJobId.set(Number(j.id), Number(ins.rows[0].id));
  }

  // 4. Clone job_technicians + job_add_ons keyed by the new job ids.
  for (const [oldId, newId] of oldToNewJobId.entries()) {
    await pg.query(
      `INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
       SELECT $1, user_id, company_id, is_primary
       FROM job_technicians WHERE job_id = $2`,
      [newId, oldId],
    );
    await pg.query(
      `INSERT INTO job_add_ons (job_id, add_on_id, quantity, unit_price, subtotal, pricing_addon_id)
       SELECT $1, add_on_id, quantity, unit_price, subtotal, pricing_addon_id
       FROM job_add_ons WHERE job_id = $2`,
      [newId, oldId],
    );
  }

  return { id: newClientId, companyId: Number(s.company_id), sourceId: srcId };
}

// Hard-delete a TEST_ client + every dependent row the tests might
// have written. Order matters — FK chains require child rows first.
// Idempotent: missing rows don't throw.
export async function cleanupTestClient(pg: Client, clientId: number): Promise<void> {
  const jobIdsRes = await pg.query(`SELECT id FROM jobs WHERE client_id = $1`, [clientId]);
  const jobIds = jobIdsRes.rows.map(r => Number(r.id));
  if (jobIds.length > 0) {
    await pg.query(`DELETE FROM job_add_ons WHERE job_id = ANY($1::int[])`, [jobIds]);
    await pg.query(`DELETE FROM job_technicians WHERE job_id = ANY($1::int[])`, [jobIds]);
    await pg.query(`DELETE FROM invoices WHERE job_id = ANY($1::int[])`, [jobIds]);
  }
  await pg.query(`DELETE FROM jobs WHERE client_id = $1`, [clientId]);
  // Schedule children: tech/addon rows cascade-delete via FK.
  await pg.query(`DELETE FROM recurring_schedules WHERE customer_id = $1`, [clientId]);
  await pg.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
}

// Panic-button cleanup. Removes every client whose first_name OR
// last_name starts with TEST_. Useful when a test died mid-run and
// left orphans the per-test afterEach didn't reach. The workflow
// invokes this in a final `always()` step.
export async function cleanupAllTestClients(pg: Client): Promise<number> {
  const r = await pg.query(
    `SELECT id FROM clients WHERE first_name LIKE 'TEST\\_%' OR last_name LIKE 'TEST\\_%'`,
  );
  const ids = r.rows.map(row => Number(row.id));
  for (const id of ids) await cleanupTestClient(pg, id);
  return ids.length;
}
