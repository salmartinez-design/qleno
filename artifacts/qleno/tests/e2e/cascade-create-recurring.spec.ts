// [PR #28 / 2026-04-30] Proof-of-life e2e test: cascade-create-recurring.
//
// Exercises the PATCH /api/jobs/:id cascade_scope='create_recurring'
// path that PR #25/#26/#27 shipped. Verifies the production-grade
// behavior: edit a Monday job → save → existing Tue–Fri imported
// jobs get overwritten in place + parking is stamped + the day
// picker re-renders on reopen.
//
// Why "proof-of-life": this is the FIRST automated e2e test in the
// repo. If it goes green we know:
//   (a) Playwright runs against the local stack
//   (b) auth helper mints a JWT and reaches the frontend
//   (c) DB helper clones a real client cleanly + tears down
//   (d) the cascade route works end-to-end via real HTTP
//   (e) the modal re-reads the schedule's days_of_week after save
//
// Subsequent PRs add tests for other surfaces (job-wizard,
// dispatch grid, quote builder, etc.) using the same helpers.
//
// Skip semantics: if SOURCE_CLIENT_ID isn't a real id in the
// snapshot DB, the test skips with a clear message (rather than
// fails). Lets the workflow decouple "Playwright infra works"
// from "snapshot has the right seed data" — the latter is its
// own debug.

import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { loginAs } from "./helpers/auth";
import { cloneClient, cleanupTestClient, getDbClient, type TestClientHandle } from "./helpers/db";

// Source client to clone. In the seeded local Postgres this is
// Jaira Estrada (customer_id=21 in production / Phes data
// migration); the workflow seeds the snapshot so id=21 is the
// commercial client with imported MaidCentral Tue–Fri jobs.
//
// Override via env if your snapshot uses a different id.
const SOURCE_CLIENT_ID = Number(process.env.E2E_SOURCE_CLIENT_ID ?? 21);

// Skip the entire suite when the test creds aren't present. This
// unblocks PR-time CI before Sal lands the GitHub Secrets — the
// workflow stays green and the cascade test flips on automatically
// the first PR after secrets are configured. Same gate is used by
// every auth-requiring spec in this directory.
const HAS_CREDS = Boolean(
  process.env.E2E_TEST_OWNER_EMAIL && process.env.E2E_TEST_OWNER_PASSWORD,
);

test.describe("cascade-create-recurring", () => {
  test.skip(!HAS_CREDS, "E2E_TEST_OWNER_EMAIL/PASSWORD not set — auth-requiring tests skipped");

  let pg: Client;
  let handle: TestClientHandle | null = null;

  test.beforeAll(async () => {
    pg = await getDbClient();
    // Sanity check the source exists. If not, every test in this
    // file skips — the workflow surfaces a clear "snapshot missing
    // seed" diagnostic without a wall of cryptic Playwright errors.
    const r = await pg.query(`SELECT id FROM clients WHERE id = $1 LIMIT 1`, [SOURCE_CLIENT_ID]);
    if (!r.rows.length) {
      test.skip(true, `Source client id=${SOURCE_CLIENT_ID} missing from local snapshot`);
    }
  });

  test.afterAll(async () => {
    if (handle) await cleanupTestClient(pg, handle.id);
    await pg.end();
  });

  test("PATCH cascade_scope=create_recurring overwrites Tue–Fri in place", async ({ page, request }) => {
    handle = await cloneClient(pg, SOURCE_CLIENT_ID);
    const authed = await loginAs(page, "owner");

    // Find the cloned Monday job. The clone window covers
    // [today-14d, today+60d]; Monday should be the most recent
    // Mon ≤ today+60d that has a row. We pick the first Monday
    // in the future (or today, if today is Monday).
    const mondayRes = await pg.query(
      `SELECT id, scheduled_date, scheduled_time, base_fee
         FROM jobs
        WHERE client_id = $1
          AND EXTRACT(DOW FROM scheduled_date) = 1
          AND scheduled_date >= CURRENT_DATE
        ORDER BY scheduled_date
        LIMIT 1`,
      [handle.id],
    );
    if (!mondayRes.rows.length) {
      test.skip(true, `Cloned client has no future Monday job in window — snapshot date drift?`);
    }
    const mondayJobId = Number(mondayRes.rows[0].id);
    const mondayDateStr = String(mondayRes.rows[0].scheduled_date).slice(0, 10);

    // Capture pre-cascade Tue–Fri job ids so we can prove the
    // cascade UPDATEd them in place rather than DELETE+INSERT
    // (which would have changed the ids — failing the test).
    const preTueFri = await pg.query(
      `SELECT id, scheduled_date FROM jobs
        WHERE client_id = $1
          AND scheduled_date BETWEEN ($2::date + INTERVAL '1 day')
                                 AND ($2::date + INTERVAL '4 days')
        ORDER BY scheduled_date, id`,
      [handle.id, mondayDateStr],
    );
    const preTueFriIds = new Set(preTueFri.rows.map(r => Number(r.id)));

    // Drive the cascade via the API directly. The modal-driven
    // path is exercised by Sal's manual verification + the
    // post-cascade modal-reopen step below; we're not testing the
    // form rendering here, we're testing the route's effect on
    // the DB.
    const patchRes = await request.patch(`/api/jobs/${mondayJobId}`, {
      headers: { Authorization: `Bearer ${authed.token}` },
      data: {
        frequency: "weekdays",
        days_of_week: [1, 2, 3, 4, 5],
        scheduled_time: "08:00",
        allowed_hours: 6,
        service_type: "commercial_cleaning",
        base_fee: 320,
        hourly_rate: 50,
        parking_fee_enabled: true,
        parking_fee_amount: 20,
        parking_fee_days: [1, 2, 3, 4, 5],
        cascade_scope: "create_recurring",
      },
    });
    expect(patchRes.status(), `PATCH should succeed; body=${await patchRes.text().catch(() => "")}`).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.cascade?.scope).toBe("create_recurring");
    expect(patchBody.cascade?.created_schedule_id).toBeGreaterThan(0);
    expect(patchBody.cascade?.create_recurring?.jobs_overwritten).toBeGreaterThanOrEqual(0);

    // (1) Exactly one active recurring_schedules row for the cloned client.
    const schedRes = await pg.query(
      `SELECT id, frequency, days_of_week, parking_fee_enabled, parking_fee_amount, parking_fee_days
         FROM recurring_schedules
        WHERE customer_id = $1 AND is_active = true`,
      [handle.id],
    );
    expect(schedRes.rows).toHaveLength(1);
    const sched = schedRes.rows[0];
    expect(String(sched.frequency)).toBe("weekdays");
    expect(sched.days_of_week).toEqual([1, 2, 3, 4, 5]);
    expect(sched.parking_fee_enabled).toBe(true);
    expect(String(sched.parking_fee_amount)).toBe("20");
    expect(sched.parking_fee_days).toEqual([1, 2, 3, 4, 5]);
    const newSchedId = Number(sched.id);

    // (2) Tue–Fri jobs share the new schedule_id and the cascaded
    //     values. Crucially, the ids are PRESERVED (= same set as
    //     pre-cascade) — proving UPDATE-in-place, not DELETE+INSERT.
    const postTueFri = await pg.query(
      `SELECT id, scheduled_date, scheduled_time, service_type, base_fee, recurring_schedule_id, allowed_hours
         FROM jobs
        WHERE client_id = $1
          AND scheduled_date BETWEEN ($2::date + INTERVAL '1 day')
                                 AND ($2::date + INTERVAL '4 days')
        ORDER BY scheduled_date, id`,
      [handle.id, mondayDateStr],
    );
    expect(postTueFri.rows.length).toBeGreaterThanOrEqual(preTueFri.rows.length);
    for (const r of postTueFri.rows) {
      expect(Number(r.recurring_schedule_id)).toBe(newSchedId);
      expect(String(r.service_type)).toBe("commercial_cleaning");
      expect(String(r.scheduled_time)).toBe("08:00:00");
      expect(String(r.base_fee)).toBe("320.00");
      expect(String(r.allowed_hours)).toBe("6.00");
    }
    const postTueFriIds = new Set(postTueFri.rows.map(r => Number(r.id)));
    for (const id of preTueFriIds) {
      expect(postTueFriIds.has(id), `pre-cascade job id=${id} should be preserved (UPDATE in place)`).toBe(true);
    }

    // (3) Each cascaded job has a Parking Fee job_add_ons row
    //     (engine stamped via parkingApplies → stampParkingFeeOnJob).
    for (const r of postTueFri.rows) {
      const ad = await pg.query(
        `SELECT 1 FROM job_add_ons jao
           JOIN add_ons a ON a.id = jao.add_on_id
          WHERE jao.job_id = $1 AND LOWER(a.name) = 'parking fee'`,
        [Number(r.id)],
      );
      expect(ad.rows.length, `job_id=${r.id} should have parking_fee stamped`).toBeGreaterThan(0);
    }

    // (4) Reopen the Monday job in the modal — the parking day
    //     picker should render now that the job is attached to a
    //     multi-day schedule. We assert via the dispatch payload
    //     (the actual data path the modal reads from), not pixel
    //     scraping — the render gate is purely a function of
    //     job.recurring_schedule_days_of_week being a multi-day
    //     array, which dispatch surfaces via the LEFT JOIN.
    const dispRes = await request.get(`/api/dispatch?date=${mondayDateStr}`, {
      headers: { Authorization: `Bearer ${authed.token}` },
    });
    expect(dispRes.ok()).toBe(true);
    const dispBody = await dispRes.json();
    const mondayJob = (dispBody.jobs ?? dispBody)
      .find((j: any) => Number(j.id) === mondayJobId);
    expect(mondayJob, "Monday job should appear in dispatch payload").toBeTruthy();
    expect(mondayJob.recurring_schedule_id).toBe(newSchedId);
    expect(mondayJob.recurring_schedule_days_of_week).toEqual([1, 2, 3, 4, 5]);
  });
});
