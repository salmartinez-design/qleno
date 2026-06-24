/**
 * Leave cancel/restore + bucket-tag correctness (Sal 2026-06-24).
 *
 * Three bugs fixed:
 *  1. Cancel of an approved request now deletes EVERY usage day (keyed on the
 *     stable "leave_request #<id> approved" note prefix), not just start_date
 *     with a note string that no longer matched.
 *  2. Cancel reverses the auto-pay (voidApprovedLeavePay) so cancelled leave
 *     isn't paid.
 *  3. App-approved usage rows are bucket-tagged ("usage/<bucket>") so the
 *     per-bucket View History modal shows them.
 *
 * Pure tests on slugToBucket + a note/LIKE-pattern consistency check, plus
 * file-grep invariants on the route source (matching the cutover-3a pattern).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slugToBucket } from "../lib/leave-bucket.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const leaveRoute = readFileSync(
  path.join(__dirname, "../routes/leave.ts"),
  "utf8",
);
const leavePay = readFileSync(
  path.join(__dirname, "../lib/leave-pay.ts"),
  "utf8",
);

/** Minimal SQL-LIKE matcher for the prefix patterns we use ("...approved%"). */
function likeMatch(value: string, pattern: string): boolean {
  // Escape regex specials, then translate LIKE wildcards: % -> .*, _ -> .
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/%/g, ".*")
        .replace(/_/g, ".") +
      "$",
  );
  return re.test(value);
}

describe("slugToBucket — maps Phes slugs to View-History tags", () => {
  it("PTO bucket → 'pto' (contains '/pto' once tagged)", () => {
    assert.equal(slugToBucket("pto_phes"), "pto");
    assert.ok(`usage/${slugToBucket("pto_phes")}`.includes("/pto"));
  });
  it("PLAWA/sick bucket → 'plawa'", () => {
    assert.equal(slugToBucket("plawa"), "plawa");
    assert.ok(`usage/${slugToBucket("plawa")}`.includes("/plawa"));
  });
  it("unpaid + unexcused get their own tags, NOT pto/plawa", () => {
    assert.equal(slugToBucket("unpaid_leave"), "unpaid");
    assert.equal(slugToBucket("unexcused"), "unexcused");
    assert.ok(!`usage/${slugToBucket("unpaid_leave")}`.includes("/pto"));
    assert.ok(!`usage/${slugToBucket("unpaid_leave")}`.includes("/plawa"));
  });
  it("never collides: pto tag isn't matched by the /plawa filter and vice-versa", () => {
    assert.ok(!`usage/${slugToBucket("pto_phes")}`.includes("/plawa"));
    assert.ok(!`usage/${slugToBucket("plawa")}`.includes("/pto"));
  });
  it("null/unknown slug degrades safely", () => {
    assert.equal(slugToBucket(null), "other");
    assert.equal(slugToBucket(undefined), "other");
  });
});

describe("approval note ↔ cancel delete-pattern consistency", () => {
  // The cancel path deletes WHERE notes LIKE `leave_request #<id> approved%`.
  // Every note format the approve path can write MUST match that pattern, for
  // every day of the request, across all buckets.
  const id = 5;
  const cancelPattern = `leave_request #${id} approved%`;
  for (const unit of ["full_day", "morning", "afternoon"]) {
    for (const slug of ["pto_phes", "plawa", "unpaid_leave"]) {
      it(`matches ${unit}/${slug}`, () => {
        const note = `leave_request #${id} approved (${unit}) usage/${slugToBucket(slug)}`;
        assert.ok(likeMatch(note, cancelPattern), `"${note}" should match LIKE "${cancelPattern}"`);
      });
    }
  }
  it("does NOT match a different request id (#50 vs #5)", () => {
    const other = `leave_request #50 approved (full_day) usage/pto`;
    assert.ok(!likeMatch(other, cancelPattern));
  });
  it("does NOT match an [MC import] row", () => {
    const mc = `[MC import #1] usage/plawa — She felt sick - MC`;
    assert.ok(!likeMatch(mc, cancelPattern));
  });
});

describe("route source invariants", () => {
  it("approval tags usage notes with the bucket (usage/${bucket})", () => {
    assert.ok(/approved \(\$\{dayUnit\}\) usage\/\$\{bucket\}/.test(leaveRoute));
    assert.ok(leaveRoute.includes("slugToBucket("));
  });
  it("cancel deletes usage by stable prefix via like(), not by start_date", () => {
    assert.ok(/like\(\s*employeeLeaveUsageTable\.notes/.test(leaveRoute));
    assert.ok(leaveRoute.includes("approved%`"));
    // the old start_date-only match must be gone from the cancel path
    assert.ok(!leaveRoute.includes("date_used, String(reqRow.start_date)"));
  });
  it("cancel reverses auto-pay", () => {
    assert.ok(leaveRoute.includes("voidApprovedLeavePay(companyId, reqRow.id, actingUserId)"));
  });
  it("voidApprovedLeavePay is idempotent (only non-voided rows, sets voided)", () => {
    assert.ok(/SET\s+status\s*=\s*'voided'/.test(leavePay));
    assert.ok(/COALESCE\(status,'pending'\)\s*<>\s*'voided'/.test(leavePay));
    assert.ok(leavePay.includes("leave_req#"));
  });
});
