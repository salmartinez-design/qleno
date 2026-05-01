// Test #1 of 3 — would-have-caught-today's-bugs suite.
//
// Match schedule button on the parking days picker reads
// recurring_schedule_days_of_week from the dispatch payload.
// Today's session burned a PR fixing the case where the dispatch
// SELECT only returned `day_of_week` (single-day enum) and not
// `days_of_week` (multi-day int[]) for weekdays/daily/custom_days
// schedules — the modal then rendered "Match schedule (—)".
//
// This test asserts the dispatch endpoint exposes both shapes
// correctly: a weekdays schedule returns a multi-day array;
// the data feeds the modal's Match-schedule button label.
//
// We don't open the React modal here — that adds frontend render
// dependencies that flake under cold-start. The data-layer
// assertion is what matters: if /api/dispatch returns the right
// shape, the modal renders correctly (covered by component tests
// when those land).

import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { loginAs } from "./helpers/auth";
import { cloneClient, cleanupTestClient, getDbClient, type TestClientHandle } from "./helpers/db";

const SOURCE_CLIENT_ID = Number(process.env.E2E_SOURCE_CLIENT_ID ?? 21);
const HAS_CREDS = Boolean(
  process.env.E2E_TEST_OWNER_EMAIL && process.env.E2E_TEST_OWNER_PASSWORD,
);

test.describe("match-schedule reads days_of_week from dispatch payload @canary", () => {
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

  test("weekdays schedule surfaces days_of_week=[1,2,3,4,5] in dispatch payload", async ({ page, request }) => {
    handle = await cloneClient(pg, SOURCE_CLIENT_ID);
    const authed = await loginAs(page, "owner");

    // Pick the first future Monday on the cloned client.
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

    // Promote the cloned client to a weekdays recurring schedule.
    const patchRes = await request.patch(`/api/jobs/${mondayJobId}`, {
      headers: { Authorization: `Bearer ${authed.token}` },
      data: {
        frequency: "weekdays",
        days_of_week: [1, 2, 3, 4, 5],
        scheduled_time: "08:00",
        allowed_hours: 6,
        service_type: "commercial_cleaning",
        base_fee: 320,
        cascade_scope: "create_recurring",
      },
    });
    expect(patchRes.status()).toBe(200);

    // The Match-schedule button feeds off this exact field.
    const dispRes = await request.get(`/api/dispatch?date=${mondayDateStr}`, {
      headers: { Authorization: `Bearer ${authed.token}` },
    });
    expect(dispRes.ok()).toBe(true);
    const dispBody = await dispRes.json();
    const job = (dispBody.jobs ?? dispBody).find((j: any) => Number(j.id) === mondayJobId);
    expect(job, "Monday job in dispatch payload").toBeTruthy();
    expect(job.recurring_schedule_days_of_week).toEqual([1, 2, 3, 4, 5]);
  });
});
