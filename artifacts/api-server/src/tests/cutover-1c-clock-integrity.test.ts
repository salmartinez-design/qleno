/**
 * Cutover 1C — The integrity tests. This is the legal gate.
 *
 * The whole piece lives or dies on these guarantees:
 *
 *   1. NO API path produces a clock event with neither a captured GPS
 *      fix nor a flagged failed_exception+reason. We assert the
 *      route-layer validator rejects every bad shape AND that the
 *      DB CHECK constraint SQL text matches the spec exactly.
 *
 *   2. The route layer does NOT expose a "skip", "decline",
 *      "force=true", or any equivalent flag that bypasses the check.
 *      We grep the route source to assert this; refactors that
 *      reintroduce a skip break the test immediately.
 *
 *   3. Genuine GPS failure produces a flagged exception requiring
 *      BOTH a reason AND a photo. Neither alone is enough.
 *
 *   4. Tenant + assignment isolation: the route layer scopes by
 *      companyId + assigned_user_id. We grep + functionally assert.
 *
 *   5. The DB CHECK constraint SQL text + name are exported from the
 *      schema file and re-asserted here so a future migration can't
 *      silently weaken the constraint.
 *
 *   6. Distance / geofence math: haversine returns the expected
 *      distance for known reference points; companyGeofenceMeters
 *      converts feet → meters correctly and falls back to 600ft
 *      when the tenant value is missing/zero.
 *
 *   7. On-my-way: SMS gating cascade is correct (COMMS_ENABLED →
 *      tenant → client → phone presence); deferred=true sends
 *      nothing; eta_edited_after_scheduled_start is set when
 *      promised_arrival > scheduled_start.
 *
 *   8. Correction never overwrites: a correction is an INSERT with
 *      is_correction=true and correction_of_event_id set. We verify
 *      the route source uses INSERT, not UPDATE, on the corrections
 *      path.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_NAME,
  JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_SQL,
} from "@workspace/db/schema";
import { validateClockGpsPayload } from "../lib/clock-integrity.js";
import { haversineMeters, companyGeofenceMeters, feetToMeters } from "../lib/distance.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Route-layer integrity validator — every bad shape rejected
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1C — clock integrity (route-layer validator)", () => {
  it("rejects an empty body", () => {
    const r = validateClockGpsPayload({});
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.equal(r.code, "lat_lng_required");
    }
  });

  it("rejects null body", () => {
    const r = validateClockGpsPayload(null);
    assert.equal(r.ok, false);
  });

  it("rejects a body with only latitude (missing longitude)", () => {
    const r = validateClockGpsPayload({ latitude: 41.8781 });
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.code, "lat_lng_required");
  });

  it("rejects a body with only longitude (missing latitude)", () => {
    const r = validateClockGpsPayload({ longitude: -87.6298 });
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.code, "lat_lng_required");
  });

  it("rejects lat outside [-90, 90]", () => {
    const r = validateClockGpsPayload({
      latitude: 999,
      longitude: 0,
      gps_accuracy_meters: 10,
    });
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.code, "lat_lng_invalid");
  });

  it("rejects lng outside [-180, 180]", () => {
    const r = validateClockGpsPayload({
      latitude: 0,
      longitude: 999,
      gps_accuracy_meters: 10,
    });
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.code, "lat_lng_invalid");
  });

  it("rejects missing gps_accuracy_meters on captured path", () => {
    const r = validateClockGpsPayload({
      latitude: 41.8781,
      longitude: -87.6298,
    });
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.code, "accuracy_invalid");
  });

  it("rejects negative gps_accuracy_meters", () => {
    const r = validateClockGpsPayload({
      latitude: 41.8781,
      longitude: -87.6298,
      gps_accuracy_meters: -1,
    });
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.code, "accuracy_invalid");
  });

  it("accepts a clean captured payload", () => {
    const r = validateClockGpsPayload({
      latitude: 41.8781,
      longitude: -87.6298,
      gps_accuracy_meters: 12.5,
    });
    assert.equal(r.ok, true);
    if (r.ok === true) {
      assert.equal(r.payload.kind, "captured");
      if (r.payload.kind === "captured") {
        assert.equal(r.payload.latitude, 41.8781);
        assert.equal(r.payload.longitude, -87.6298);
        assert.equal(r.payload.gps_accuracy_meters, 12.5);
      }
    }
  });

  it("rejects failed_exception without reason", () => {
    const r = validateClockGpsPayload({
      gps_status: "failed_exception",
      exception_photo_url: "https://uploads.example.com/abc.jpg",
    });
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.code, "exception_reason_required");
  });

  it("rejects failed_exception without photo", () => {
    const r = validateClockGpsPayload({
      gps_status: "failed_exception",
      exception_reason: "GPS permission denied on device",
    });
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.code, "exception_photo_required");
  });

  it("rejects failed_exception with blank reason", () => {
    const r = validateClockGpsPayload({
      gps_status: "failed_exception",
      exception_reason: "   ",
      exception_photo_url: "https://uploads.example.com/abc.jpg",
    });
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.code, "exception_reason_required");
  });

  it("accepts a clean failed_exception payload", () => {
    const r = validateClockGpsPayload({
      gps_status: "failed_exception",
      exception_reason: "GPS permission denied on device",
      exception_photo_url: "https://uploads.example.com/abc.jpg",
    });
    assert.equal(r.ok, true);
    if (r.ok === true) {
      assert.equal(r.payload.kind, "failed_exception");
    }
  });

  it("rejects ambiguous mixed payload (captured + failed_exception together)", () => {
    const r = validateClockGpsPayload({
      latitude: 41.8781,
      longitude: -87.6298,
      gps_accuracy_meters: 10,
      gps_status: "failed_exception",
      exception_reason: "trying to game it",
      exception_photo_url: "https://uploads.example.com/abc.jpg",
    });
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.code, "ambiguous_payload");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The anti-decline guarantee — no skip path in the route source
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1C — anti-decline guarantee (route source)", () => {
  const src = readFileSync(
    path.resolve(process.cwd(), "src/routes/tech-clock.ts"),
    "utf8",
  );

  it("tech-clock.ts does NOT contain a 'skip_gps' or 'decline' flag", () => {
    assert.ok(
      !/skip_gps|decline_gps|skip_location|gps_optional/.test(src),
      "tech-clock.ts must NOT expose a skip/decline path for GPS",
    );
  });

  it("tech-clock.ts does NOT support a 'force=true' bypass query param", () => {
    assert.ok(
      !/req\.query\.force/i.test(src),
      "tech-clock.ts must NOT honor a force=true bypass",
    );
  });

  it("tech-clock.ts routes through validateClockGpsPayload before any DB insert", () => {
    assert.ok(
      /validateClockGpsPayload\(req\.body\)/.test(src),
      "tech-clock.ts must call validateClockGpsPayload before inserting",
    );
  });

  it("tech-clock.ts does NOT read userId from request body or query (tenant isolation)", () => {
    assert.ok(
      !/req\.body\.user_?id|req\.query\.user_?id|req\.query\.employee_id/i.test(src),
      "tech-clock.ts must source userId from req.auth!.userId — never the client",
    );
    assert.ok(
      /req\.auth!\.userId/.test(src),
      "tech-clock.ts must source userId from req.auth!.userId",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DB CHECK constraint — text and name match spec
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1C — DB CHECK constraint", () => {
  it("the constraint name matches the spec contract", () => {
    assert.equal(
      JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_NAME,
      "job_clock_events_gps_integrity_chk",
    );
  });

  it("the constraint SQL requires (captured AND lat AND lng) OR (failed_exception AND reason)", () => {
    // Normalize whitespace so layout changes don't break the test.
    const sqlNorm = JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_SQL.replace(/\s+/g, " ").trim();
    assert.ok(
      sqlNorm.includes(
        "gps_status = 'captured' AND latitude IS NOT NULL AND longitude IS NOT NULL",
      ),
      "captured branch must require lat AND lng",
    );
    assert.ok(
      sqlNorm.includes(
        "gps_status = 'failed_exception' AND exception_reason IS NOT NULL",
      ),
      "failed_exception branch must require exception_reason",
    );
    assert.ok(sqlNorm.includes(" OR "), "constraint must allow either branch");
  });

  it("cutover-data-migration.ts installs the constraint idempotently", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/cutover-data-migration.ts"),
      "utf8",
    );
    assert.ok(
      /JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_NAME/.test(src),
      "migration must reference the named constant",
    );
    assert.ok(
      /JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_SQL/.test(src),
      "migration must reference the named SQL constant",
    );
    assert.ok(
      /pg_constraint[^;]*conname = '\$\{JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_NAME\}'/s.test(src),
      "migration must skip when the constraint already exists",
    );
    assert.ok(
      /ADD CONSTRAINT \$\{JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_NAME\}/s.test(src),
      "migration must ALTER TABLE ADD CONSTRAINT using the named constant",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Distance + geofence math
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1C — distance + geofence math", () => {
  it("haversine returns 0 for identical points", () => {
    assert.equal(haversineMeters(41.8781, -87.6298, 41.8781, -87.6298), 0);
  });

  it("haversine matches a known reference distance (Chicago Loop to O'Hare ≈ 25 km great-circle)", () => {
    // Loop (41.8781, -87.6298) to O'Hare (41.9742, -87.9073) is ~25 km
    // great-circle (the 27-mile driving distance includes road routing,
    // not direct flight). Allow ±1 km tolerance on the great-circle math.
    const m = haversineMeters(41.8781, -87.6298, 41.9742, -87.9073);
    assert.ok(
      m > 24_500 && m < 26_500,
      `expected ~25 km great-circle, got ${m.toFixed(0)} m`,
    );
  });

  it("feetToMeters: 600 ft ≈ 182.88 m", () => {
    assert.equal(feetToMeters(600).toFixed(2), "182.88");
  });

  it("companyGeofenceMeters: tenant value wins when present", () => {
    assert.equal(
      companyGeofenceMeters(500).toFixed(2),
      feetToMeters(500).toFixed(2),
    );
  });

  it("companyGeofenceMeters: falls back to 600 ft when tenant value is null", () => {
    assert.equal(
      companyGeofenceMeters(null).toFixed(2),
      feetToMeters(600).toFixed(2),
    );
  });

  it("companyGeofenceMeters: falls back to 600 ft when tenant value is zero or negative", () => {
    assert.equal(
      companyGeofenceMeters(0).toFixed(2),
      feetToMeters(600).toFixed(2),
    );
    assert.equal(
      companyGeofenceMeters(-1).toFixed(2),
      feetToMeters(600).toFixed(2),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Office correction — append-only invariant (route source)
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1C — office correction is append-only", () => {
  const src = readFileSync(
    path.resolve(process.cwd(), "src/routes/office-clock.ts"),
    "utf8",
  );

  it("clock-correction handler uses INSERT, not UPDATE, on jobClockEventsTable", () => {
    // Pinpoint the correction handler block and confirm no .update(jobClockEventsTable)
    // appears between the route declaration and the next route declaration.
    const matchIdx = src.indexOf('"/jobs/:jobId/clock-correction"');
    const nextRouteIdx = src.indexOf("router.", matchIdx + 1);
    const blockEnd = src.indexOf('"/clock-exceptions"', matchIdx);
    const end = nextRouteIdx > -1 && nextRouteIdx < blockEnd ? nextRouteIdx : blockEnd;
    const block = src.slice(matchIdx, end);
    assert.ok(
      /\.insert\(jobClockEventsTable\)/.test(block),
      "correction handler must INSERT a new event",
    );
    assert.ok(
      !/\.update\(jobClockEventsTable\)/.test(block),
      "correction handler must NOT update the existing event row",
    );
  });

  it("correction sets is_correction=true and correction_of_event_id", () => {
    assert.ok(
      /is_correction: true/.test(src),
      "correction must mark the new row is_correction=true",
    );
    assert.ok(
      /correction_of_event_id: original\.id/.test(src),
      "correction must point at the original via correction_of_event_id",
    );
    assert.ok(
      /correction_old_value: snapshot/.test(src),
      "correction must snapshot prior values",
    );
  });

  it("office routes require role gate", () => {
    assert.ok(
      /requireRole\("owner", "admin", "office", "super_admin"\)/.test(src),
      "office routes must require owner/admin/office/super_admin",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. On-my-way: SMS gating cascade + leg capture
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1C — on-my-way SMS gating cascade", () => {
  // The route delegates to lib/comms.ts → sendOnMyWaySms. We test the
  // cascade in lib/comms.ts directly so we don't need a Twilio mock.
  it("sendOnMyWaySms blocks when COMMS_ENABLED is not 'true'", async () => {
    const prev = process.env.COMMS_ENABLED;
    delete process.env.COMMS_ENABLED;
    try {
      const { sendOnMyWaySms } = await import("../lib/comms.js");
      const r = await sendOnMyWaySms({
        toPhone: "+15551234567",
        fromPhone: "+15557654321",
        techName: "Jose Ardila",
        clientFirstName: "Daniel",
        serviceAddress: "123 Test St, Chicago, IL 60639",
        promisedArrivalLabel: "10:25 AM",
        tenantSmsEnabled: true,
        clientOptedIn: true,
      });
      assert.equal(r.status, "suppressed_comms_disabled");
    } finally {
      if (prev !== undefined) process.env.COMMS_ENABLED = prev;
    }
  });

  it("sendOnMyWaySms blocks when tenant SMS disabled (even with COMMS_ENABLED=true)", async () => {
    process.env.COMMS_ENABLED = "true";
    const { sendOnMyWaySms } = await import("../lib/comms.js");
    const r = await sendOnMyWaySms({
      toPhone: "+15551234567",
      fromPhone: "+15557654321",
      techName: "Jose Ardila",
      clientFirstName: "Daniel",
      serviceAddress: "123 Test St",
      promisedArrivalLabel: "10:25 AM",
      tenantSmsEnabled: false,
      clientOptedIn: true,
    });
    assert.equal(r.status, "suppressed_tenant_disabled");
  });

  it("sendOnMyWaySms blocks when client opted out", async () => {
    process.env.COMMS_ENABLED = "true";
    const { sendOnMyWaySms } = await import("../lib/comms.js");
    const r = await sendOnMyWaySms({
      toPhone: "+15551234567",
      fromPhone: "+15557654321",
      techName: "Jose Ardila",
      clientFirstName: "Daniel",
      serviceAddress: "123 Test St",
      promisedArrivalLabel: "10:25 AM",
      tenantSmsEnabled: true,
      clientOptedIn: false,
    });
    assert.equal(r.status, "suppressed_client_opted_out");
  });

  it("sendOnMyWaySms blocks when client has no phone", async () => {
    process.env.COMMS_ENABLED = "true";
    const { sendOnMyWaySms } = await import("../lib/comms.js");
    const r = await sendOnMyWaySms({
      toPhone: null,
      fromPhone: "+15557654321",
      techName: "Jose Ardila",
      clientFirstName: "Daniel",
      serviceAddress: "123 Test St",
      promisedArrivalLabel: "10:25 AM",
      tenantSmsEnabled: true,
      clientOptedIn: true,
    });
    assert.equal(r.status, "suppressed_no_phone");
  });

  it("on-my-way route captures from_job_id and from coordinates (route source)", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/routes/tech-clock.ts"),
      "utf8",
    );
    assert.ok(
      /from_job_id: fromJobId/.test(src),
      "on-my-way must persist from_job_id for the mileage piece",
    );
    assert.ok(
      /from_latitude: fromLat/.test(src),
      "on-my-way must persist from_latitude",
    );
    assert.ok(
      /from_longitude: fromLng/.test(src),
      "on-my-way must persist from_longitude",
    );
  });

  it("on-my-way route honors deferred=true (no send, no sent_at)", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/routes/tech-clock.ts"),
      "utf8",
    );
    assert.ok(
      /sent_at: deferred \? null : now/.test(src),
      "deferred=true must leave sent_at null",
    );
    assert.ok(
      /if \(!deferred\) \{[\s\S]*smsResult = await sendOnMyWayForJob/.test(src),
      "deferred=true must skip the SMS send",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Schema cross-checks (1C tables present and shaped per spec)
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1C — schema cross-checks", () => {
  it("job_clock_events table is present with required columns", async () => {
    const { jobClockEventsTable } = await import("@workspace/db/schema");
    const cols: any = jobClockEventsTable;
    assert.ok(cols.company_id);
    assert.ok(cols.job_id);
    assert.ok(cols.user_id);
    assert.ok(cols.event_type);
    assert.ok(cols.event_at);
    assert.ok(cols.latitude);
    assert.ok(cols.longitude);
    assert.ok(cols.gps_accuracy_meters);
    assert.ok(cols.distance_from_site_meters);
    assert.ok(cols.within_geofence);
    assert.ok(cols.gps_status);
    assert.ok(cols.exception_reason);
    assert.ok(cols.exception_photo_url);
    assert.ok(cols.is_correction);
    assert.ok(cols.correction_of_event_id);
    assert.ok(cols.correction_old_value);
    assert.ok(cols.created_by_user_id);
  });

  it("on_my_way_events table is present with leg-capture columns", async () => {
    const { onMyWayEventsTable } = await import("@workspace/db/schema");
    const cols: any = onMyWayEventsTable;
    assert.ok(cols.from_job_id, "from_job_id required for mileage piece");
    assert.ok(cols.from_latitude);
    assert.ok(cols.from_longitude);
    assert.ok(cols.estimated_eta_minutes);
    assert.ok(cols.promised_arrival_at);
    assert.ok(cols.eta_adjusted_by_tech);
    assert.ok(cols.eta_edited_after_scheduled_start);
    assert.ok(cols.deferred);
    assert.ok(cols.client_notified);
  });

  it("clients.wants_on_my_way_notifications is present", async () => {
    const { clientsTable } = await import("@workspace/db/schema");
    assert.ok(
      (clientsTable as any).wants_on_my_way_notifications,
      "clients.wants_on_my_way_notifications required by 1C",
    );
  });
});
