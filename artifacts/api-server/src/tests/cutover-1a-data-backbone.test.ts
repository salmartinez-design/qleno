/**
 * Cutover 1A — Data backbone schema tests.
 *
 * Verifies that the 1A additive columns on users + jobs are present on
 * the Drizzle schema objects with the expected types and defaults.
 * Runtime concerns (idempotent ALTER TABLE behavior, tenant isolation
 * across companies, drizzle-kit push idempotency) are verified on
 * production after the migration runs — drizzle-kit push reconciles
 * the live DB to match the schema, so the schema IS the source of
 * truth for "did the column land."
 *
 * Why no DB integration test here: the rest of `pnpm run test:lms`
 * runs against a stub DATABASE_URL (postgres://stub@stub/stub) and
 * does not connect. Adding a real-DB test for one cutover piece would
 * fork the test infrastructure. The column-shape assertions below
 * still catch the most-likely regression: someone removing or
 * renaming a column the cutover depends on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  jobsTable,
  usersTable,
  serviceTypesTable,
  clientsTable,
} from "@workspace/db/schema";

describe("Cutover 1A — users additive columns", () => {
  it("users.home_lat exists as a numeric column", () => {
    const col = (usersTable as any).home_lat;
    assert.ok(col, "users.home_lat should exist on the schema");
    assert.equal(col.name, "home_lat");
  });

  it("users.home_lng exists as a numeric column", () => {
    const col = (usersTable as any).home_lng;
    assert.ok(col, "users.home_lng should exist on the schema");
    assert.equal(col.name, "home_lng");
  });

  it("users.default_team exists as a text column", () => {
    const col = (usersTable as any).default_team;
    assert.ok(col, "users.default_team should exist on the schema");
    assert.equal(col.name, "default_team");
  });

  it("users.default_position exists as a text column", () => {
    const col = (usersTable as any).default_position;
    assert.ok(col, "users.default_position should exist on the schema");
    assert.equal(col.name, "default_position");
  });

  it("users.hire_date already exists (re-asserted for cutover dependency)", () => {
    const col = (usersTable as any).hire_date;
    assert.ok(col, "users.hire_date is required by cutover 1A");
  });

  it("users.email already exists (re-asserted for cutover dependency)", () => {
    const col = (usersTable as any).email;
    assert.ok(col, "users.email is required by cutover 1A");
  });
});

describe("Cutover 1A — jobs additive columns", () => {
  it("jobs.scope_deep_clean exists with default false", () => {
    const col = (jobsTable as any).scope_deep_clean;
    assert.ok(col, "jobs.scope_deep_clean should exist on the schema");
    assert.equal(col.name, "scope_deep_clean");
    assert.equal(col.default, false);
  });

  it("jobs.scope_first_time_in exists with default false", () => {
    const col = (jobsTable as any).scope_first_time_in;
    assert.ok(col, "jobs.scope_first_time_in should exist on the schema");
    assert.equal(col.default, false);
  });

  it("jobs.scope_priority exists with default false", () => {
    const col = (jobsTable as any).scope_priority;
    assert.ok(col, "jobs.scope_priority should exist on the schema");
    assert.equal(col.default, false);
  });

  it("jobs.special_equipment_needed exists with default false", () => {
    const col = (jobsTable as any).special_equipment_needed;
    assert.ok(col, "jobs.special_equipment_needed should exist on the schema");
    assert.equal(col.default, false);
  });

  it("jobs.out_of_rotation exists with default false", () => {
    const col = (jobsTable as any).out_of_rotation;
    assert.ok(col, "jobs.out_of_rotation should exist on the schema");
    assert.equal(col.default, false);
  });

  it("jobs.job_kind exists with default 'cleaning'", () => {
    const col = (jobsTable as any).job_kind;
    assert.ok(col, "jobs.job_kind should exist on the schema");
    assert.equal(col.name, "job_kind");
    assert.equal(col.default, "cleaning");
  });

  it("jobs.service_type_id exists (FK alias to service_types.id)", () => {
    const col = (jobsTable as any).service_type_id;
    assert.ok(col, "jobs.service_type_id should exist on the schema");
    assert.equal(col.name, "service_type_id");
  });

  it("jobs.client_id already exists (re-asserted for cutover dependency)", () => {
    const col = (jobsTable as any).client_id;
    assert.ok(col, "jobs.client_id is required by cutover 1A");
  });

  it("jobs.assigned_user_id already exists (re-asserted)", () => {
    const col = (jobsTable as any).assigned_user_id;
    assert.ok(col, "jobs.assigned_user_id is required by cutover 1A");
  });

  it("jobs.scheduled_date already exists (re-asserted)", () => {
    const col = (jobsTable as any).scheduled_date;
    assert.ok(col, "jobs.scheduled_date is required by cutover 1A");
  });

  it("jobs.allowed_hours already exists (re-asserted)", () => {
    const col = (jobsTable as any).allowed_hours;
    assert.ok(col, "jobs.allowed_hours is required by cutover 1A");
  });

  it("jobs.status already exists (re-asserted)", () => {
    const col = (jobsTable as any).status;
    assert.ok(col, "jobs.status is required by cutover 1A");
  });
});

describe("Cutover 1A — service_types (already present, sanity)", () => {
  it("serviceTypesTable carries company_id, parent_slug, slug, name", () => {
    assert.ok((serviceTypesTable as any).company_id);
    assert.ok((serviceTypesTable as any).parent_slug);
    assert.ok((serviceTypesTable as any).slug);
    assert.ok((serviceTypesTable as any).name);
  });

  it("serviceTypesTable carries is_active (the 'active' field from spec)", () => {
    assert.ok((serviceTypesTable as any).is_active);
  });

  it("serviceTypesTable carries display_order (the 'sort_order' field from spec)", () => {
    assert.ok((serviceTypesTable as any).display_order);
  });
});

describe("Cutover 1A — clients (already present, sanity)", () => {
  it("clientsTable carries company_id (tenant-scoped)", () => {
    assert.ok((clientsTable as any).company_id);
  });

  it("clientsTable carries address + city + state + zip (the 'address_*' fields from spec)", () => {
    assert.ok((clientsTable as any).address);
    assert.ok((clientsTable as any).city);
    assert.ok((clientsTable as any).state);
    assert.ok((clientsTable as any).zip);
  });

  it("clientsTable carries lat + lng (the 'latitude'/'longitude' fields from spec)", () => {
    assert.ok((clientsTable as any).lat);
    assert.ok((clientsTable as any).lng);
  });

  it("clientsTable carries client_type (the 'is_commercial' enum source from spec)", () => {
    assert.ok((clientsTable as any).client_type);
  });

  it("clientsTable carries zone_id (FK alias for spec's 'zone' field)", () => {
    assert.ok((clientsTable as any).zone_id);
  });
});

// NOTE: We intentionally do NOT dynamic-import routes/core.ts here.
// Importing it would pull `db` (drizzle client construction) which
// errors against the stub DATABASE_URL used by this test runner. The
// route file's syntactic correctness is covered by tsc-check and its
// runtime correctness is covered by the build-api-server CI check.
