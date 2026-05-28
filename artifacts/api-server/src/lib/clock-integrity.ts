/**
 * Cutover 1C — Clock-event integrity guard at the route layer.
 *
 * Single source of truth for "is this request shape allowed to produce
 * a clock event row?" There are exactly two valid shapes:
 *
 *   1. captured       — latitude + longitude + gps_accuracy_meters
 *                       provided. Distance + within_geofence are
 *                       computed downstream by the route handler.
 *
 *   2. failed_exception — gps_status='failed_exception' explicitly set
 *                         AND exception_reason populated AND
 *                         exception_photo_url populated.
 *
 * Anything else is rejected. There is NO "skip", "decline",
 * "continue without location", or any equivalent. The route returns
 * 400 with a structured error so the client cannot guess its way past.
 *
 * This module is the route-layer half of the defense-in-depth pair.
 * The DB CHECK constraint
 * (`JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_SQL`) is the other half —
 * installed by artifacts/api-server/src/cutover-data-migration.ts and
 * verified by cutover-1c tests. Either layer alone is enough to keep
 * the bad shape out of the table; both together are belt-and-suspenders.
 */

export type CapturedPayload = {
  kind: "captured";
  latitude: number;
  longitude: number;
  gps_accuracy_meters: number;
};

export type FailedExceptionPayload = {
  kind: "failed_exception";
  exception_reason: string;
  exception_photo_url: string;
};

export type ClockGpsPayload = CapturedPayload | FailedExceptionPayload;

export type ClockIntegrityRejection = {
  ok: false;
  status: 400;
  error: "Bad Request";
  message: string;
  // A stable code so the client can branch UI on the failure mode.
  code:
    | "gps_required"
    | "lat_lng_required"
    | "lat_lng_invalid"
    | "accuracy_invalid"
    | "exception_reason_required"
    | "exception_photo_required"
    | "ambiguous_payload";
};

/**
 * Validate a clock event request body. Returns either the parsed
 * payload (`{ ok: true, payload }`) or a structured rejection that
 * the route handler can serialize directly into the JSON response.
 *
 * NOTE — the spec rule: there is no "skip" flag and there is no
 * decline path. Both the route AND the DB CHECK enforce this. If you
 * are tempted to add a `force=true` query param or a `skip_gps` body
 * field — don't. Add a new exception kind first, write the test, and
 * extend the DB CHECK constraint to match.
 */
export function validateClockGpsPayload(
  body: unknown,
): { ok: true; payload: ClockGpsPayload } | ClockIntegrityRejection {
  if (!body || typeof body !== "object") {
    return rejection(
      "gps_required",
      "Body must include either a captured GPS fix or a failed_exception with reason + photo.",
    );
  }
  const raw = body as Record<string, unknown>;
  const explicitFailure = raw.gps_status === "failed_exception";
  const hasLatOrLng = raw.latitude !== undefined || raw.longitude !== undefined;

  // Ambiguous: client tried to send both shapes at once. Reject.
  if (explicitFailure && hasLatOrLng) {
    return rejection(
      "ambiguous_payload",
      "Cannot send a captured GPS fix and a failed_exception in the same request.",
    );
  }

  if (explicitFailure) {
    const reason = typeof raw.exception_reason === "string"
      ? raw.exception_reason.trim()
      : "";
    if (!reason) {
      return rejection(
        "exception_reason_required",
        "When GPS capture fails, you must provide a short reason. There is no skip.",
      );
    }
    const photo = typeof raw.exception_photo_url === "string"
      ? raw.exception_photo_url.trim()
      : "";
    if (!photo) {
      return rejection(
        "exception_photo_required",
        "When GPS capture fails, you must provide an entry photo URL.",
      );
    }
    return {
      ok: true,
      payload: {
        kind: "failed_exception",
        exception_reason: reason,
        exception_photo_url: photo,
      },
    };
  }

  // Captured path — require latitude + longitude + accuracy.
  if (raw.latitude === undefined || raw.longitude === undefined) {
    return rejection(
      "lat_lng_required",
      "Latitude and longitude are required for a GPS-captured clock event.",
    );
  }
  const lat = Number(raw.latitude);
  const lng = Number(raw.longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return rejection("lat_lng_invalid", "latitude must be a number in [-90, 90]");
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return rejection("lat_lng_invalid", "longitude must be a number in [-180, 180]");
  }
  const accuracy = Number(raw.gps_accuracy_meters);
  if (!Number.isFinite(accuracy) || accuracy < 0) {
    return rejection(
      "accuracy_invalid",
      "gps_accuracy_meters must be a non-negative number.",
    );
  }
  return {
    ok: true,
    payload: {
      kind: "captured",
      latitude: lat,
      longitude: lng,
      gps_accuracy_meters: accuracy,
    },
  };
}

function rejection(
  code: ClockIntegrityRejection["code"],
  message: string,
): ClockIntegrityRejection {
  return { ok: false, status: 400, error: "Bad Request", code, message };
}
