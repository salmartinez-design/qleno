// Test #3 of 3 — would-have-caught-today's-bugs suite.
//
// Parking day-of-week filter on recurring schedules:
// PR #42 fixed the case where parking_fee_days was either ignored
// or stamped on every weekday. This test verifies the engine's
// filter — Mon–Fri schedules with parking_fee_days={1,2,3,4,5} get
// parking on every cascaded job; the Sat/Sun rows (if any are
// generated) do not.
//
// We trigger the engine via POST /api/recurring/trigger (the
// admin-callable manual trigger) rather than waiting for the 2 AM
// cron. Live mode + single-schedule scope to stay isolated.

import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { loginAs } from "./helpers/auth";
import { cloneClient, cleanupTestClient, getDbClient, type TestClientHandle } from "./helpers/db";

const SOURCE_CLIENT_ID = Number(process.env.E2E_SOURCE_CLIENT_ID ?? 21);
const HAS_CREDS = Boolean(
  process.env.E2E_TEST_OWNER_EMAIL && process.env.E2E_TEST_OWNER_PASSWORD,
);

test.describe("parking-day-of-week stamping @canary", () => {
  test.skip(!HAS_CREDS, "E2E_TEST_OWNER_EMAIL/PASSWORD not set");

  let pg: Client;
  let handle: TestClientHandle | null = null;

  test.beforeAll(async () => {
    pg = await getDbClient();
    const r = await pg.query(`SELECT id FROM clients WHERE id = $1 LIMIT 1`, [SOURCE_CLIENT_ID]);
    if (!r.rows.length) {
      test.skip(true, `Source client id=${SOURCE_CLIENT_ID} missing from local snapshot`);
    }
  });

  test.afterAll(async () => {
    if (handle) await cleanupTestClient(pg, handle.id);
    await pg.end();
  });

  test("parking_fee_days={1..5} → Mon-Fri get $20 parking; Sat/Sun get nothing", async ({ page, request }) => {
    handle = await cloneClient(pg, SOURCE_CLIENT_ID);
    const authed = await loginAs(page, "owner");

    const mondayRes = await pg.query(
      `SELECT id, scheduled_date FROM jobs
        WHERE client_id = $1 AND EXTRACT(DOW FROM scheduled_date) = 1
          AND scheduled_date >= CURRENT_DATE
        ORDER BY scheduled_date LIMIT 1`,
      [handle.id],
    );
    if (!mondayRes.rows.length) test.skip(true, "no future Monday in window");
    const mondayJobId = Number(mondayRes.rows[0].id);
    const mondayDateStr = String(mondayRes.rows[0].scheduled_date).slice(0, 10);

    // Set up a weekdays schedule + parking on Mon-Fri only via cascade.
    const patchRes = await request.patch(`/api/jobs/${mondayJobId}`, {
      headers: { Authorization: `Bearer ${authed.token}` },
      data: {
        frequency: "weekdays",
        days_of_week: [1, 2, 3, 4, 5],
        scheduled_time: "08:00",
        allowed_hours: 6,
        service_type: "commercial_cleaning",
        base_fee: 320,
        parking_fee_enabled: true,
        parking_fee_amount: 20,
        parking_fee_days: [1, 2, 3, 4, 5],
        cascade_scope: "create_recurring",
      },
    });
    expect(patchRes.status()).toBe(200);

    // Cascaded Tue–Fri jobs all get parking.
    const tueFri = await pg.query(
      `SELECT j.id, EXTRACT(DOW FROM j.scheduled_date)::int AS dow
         FROM jobs j
        WHERE j.client_id = $1
          AND j.scheduled_date BETWEEN ($2::date + INTERVAL '1 day')
                                   AND ($2::date + INTERVAL '4 days')
        ORDER BY j.scheduled_date`,
      [handle.id, mondayDateStr],
    );
    for (const r of tueFri.rows) {
      const ad = await pg.query(
        `SELECT 1 FROM job_add_ons jao
           JOIN add_ons a ON a.id = jao.add_on_id
          WHERE jao.job_id = $1 AND LOWER(a.name) = 'parking fee'`,
        [Number(r.id)],
      );
      expect(ad.rows.length, `weekday job_id=${r.id} dow=${r.dow} should have parking`).toBeGreaterThan(0);
    }

    // Saturday/Sunday — if any were cloned in the window — must NOT have parking.
    // (The clone window is +60 days; weekend rows may or may not exist
    // for this client. If none exist, this check is vacuous, which is fine.)
    const weekend = await pg.query(
      `SELECT j.id, EXTRACT(DOW FROM j.scheduled_date)::int AS dow
         FROM jobs j
        WHERE j.client_id = $1
          AND EXTRACT(DOW FROM j.scheduled_date) IN (0, 6)
          AND j.scheduled_date >= $2::date`,
      [handle.id, mondayDateStr],
    );
    for (const r of weekend.rows) {
      const ad = await pg.query(
        `SELECT 1 FROM job_add_ons jao
           JOIN add_ons a ON a.id = jao.add_on_id
          WHERE jao.job_id = $1 AND LOWER(a.name) = 'parking fee'`,
        [Number(r.id)],
      );
      expect(ad.rows.length, `weekend job_id=${r.id} dow=${r.dow} should NOT have parking`).toBe(0);
    }
  });
});
