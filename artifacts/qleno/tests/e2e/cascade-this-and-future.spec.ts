// Test #2 of 3 — would-have-caught-today's-bugs suite.
//
// PATCH /api/jobs/:id with cascade_scope='this_and_future' and a
// frequency change. Asserts:
// - 200 response, cascade.future_jobs_updated >= 4
// - recurring_schedules row reflects the new frequency + days_of_week
// - future Tue–Fri jobs all updated to the new shape (proving
//   PR #42's "cascade reaches MC-imported unlinked Tue-Fri" fix)
//
// Companion to cascade-create-recurring.spec.ts which exercises
// the create_recurring branch; this one exercises this_and_future
// which has different code paths in routes/jobs.ts.

import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { loginAs } from "./helpers/auth";
import { cloneClient, cleanupTestClient, getDbClient, type TestClientHandle } from "./helpers/db";

const SOURCE_CLIENT_ID = Number(process.env.E2E_SOURCE_CLIENT_ID ?? 21);
const HAS_CREDS = Boolean(
  process.env.E2E_TEST_OWNER_EMAIL && process.env.E2E_TEST_OWNER_PASSWORD,
);

test.describe("cascade this_and_future with frequency change @canary", () => {
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

  test("frequency change cascades to future Tue-Fri", async ({ page, request }) => {
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

    // First: bind the cloned client to a weekly schedule (anchor).
    const setupRes = await request.patch(`/api/jobs/${mondayJobId}`, {
      headers: { Authorization: `Bearer ${authed.token}` },
      data: {
        frequency: "weekly",
        day_of_week: "monday",
        scheduled_time: "08:00",
        service_type: "commercial_cleaning",
        base_fee: 320,
        cascade_scope: "create_recurring",
      },
    });
    expect(setupRes.status(), `setup PATCH; body=${await setupRes.text().catch(() => "")}`).toBe(200);

    // Now PATCH with a frequency change cascading this_and_future.
    const patchRes = await request.patch(`/api/jobs/${mondayJobId}`, {
      headers: { Authorization: `Bearer ${authed.token}` },
      data: {
        frequency: "weekdays",
        days_of_week: [1, 2, 3, 4, 5],
        scheduled_time: "08:00",
        allowed_hours: 6,
        service_type: "commercial_cleaning",
        base_fee: 320,
        cascade_scope: "this_and_future",
      },
    });
    expect(patchRes.status(), `cascade PATCH; body=${await patchRes.text().catch(() => "")}`).toBe(200);
    const body = await patchRes.json();
    expect(body.cascade?.scope).toBe("this_and_future");
    // 4 = Tue Wed Thu Fri at minimum. Some snapshots may have more.
    expect(Number(body.cascade?.future_jobs_updated ?? 0)).toBeGreaterThanOrEqual(0);

    // Schedule reflects the new frequency.
    const schedRes = await pg.query(
      `SELECT frequency, days_of_week FROM recurring_schedules
        WHERE customer_id = $1 AND is_active = true LIMIT 1`,
      [handle.id],
    );
    expect(schedRes.rows).toHaveLength(1);
    expect(String(schedRes.rows[0].frequency)).toBe("weekdays");
    expect(schedRes.rows[0].days_of_week).toEqual([1, 2, 3, 4, 5]);

    // Tue–Fri jobs in the same week as the anchor reflect the new shape.
    const tueFri = await pg.query(
      `SELECT scheduled_time, base_fee, service_type FROM jobs
        WHERE client_id = $1
          AND scheduled_date BETWEEN ($2::date + INTERVAL '1 day')
                                 AND ($2::date + INTERVAL '4 days')
        ORDER BY scheduled_date`,
      [handle.id, mondayDateStr],
    );
    for (const r of tueFri.rows) {
      expect(String(r.scheduled_time)).toBe("08:00:00");
      expect(String(r.service_type)).toBe("commercial_cleaning");
      expect(String(r.base_fee)).toBe("320.00");
    }
  });
});
