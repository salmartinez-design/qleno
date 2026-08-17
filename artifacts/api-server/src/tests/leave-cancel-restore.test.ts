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

// [leave-day 2026-08-17] Leave pay is dated to the day off, not the day the
// office clicked Approve. Payroll windows additional_pay by created_at, so an
// approval stamped NOW() put the money in the approval's pay week — live case:
// $100 stamped 2026-07-23 for leave actually taken 2026-07-28, two different
// weeks. Approval already writes a usage row per calendar day, so pay follows
// those days.
describe("approved leave pays on the day taken", () => {
  it("never stamps created_at at approval time", () => {
    // The old `..., 'pending', NOW())` insert is the whole bug — it must be gone.
    assert.ok(!/'pending',\s*NOW\(\)/.test(leavePay));
  });
  it("stamps each row to its own leave day", () => {
    assert.ok(leavePay.includes("(${d.day} || ' 12:00:00')::timestamp"));
  });
  it("reads the per-day truth from the usage rows approval wrote", () => {
    assert.ok(/FROM employee_leave_usage/.test(leavePay));
    assert.ok(leavePay.includes("leave_request #${requestId} approved%"));
  });
  it("falls back to the first day off, never to the approval moment", () => {
    assert.ok(/fallbackDay\s*=\s*String\(row\.start_date\)/.test(leavePay));
  });
  it("will not re-pay a request already paid as one pre-per-day row", () => {
    assert.ok(leavePay.includes("notes NOT LIKE '%[leave_usage:%'"));
    assert.ok(leavePay.includes("already paid (pre-per-day row)"));
  });

  // A bare `%leave_req#5%` also matches `leave_req#50`: request 5 would see 50's
  // row and skip its own insert (never paid), and cancelling 5 would void 50's
  // money. Parenthesising makes it exact. Every row ever written carries the
  // parens, so history still matches.
  it("matches the request marker parenthesised, so #5 cannot hit #50", () => {
    assert.ok(leavePay.includes("(leave_req#${requestId})"));
    assert.ok(!/`leave_req#\$\{requestId\}`/.test(leavePay));

    const noteFor = (id: number) => `Ana leave approved (leave_req#${id}) — 8.00h`;
    assert.ok(likeMatch(noteFor(50), "%leave_req#5%"), "bare pattern is ambiguous");
    assert.ok(!likeMatch(noteFor(50), "%(leave_req#5)%"), "parens disambiguate");
    assert.ok(likeMatch(noteFor(5), "%(leave_req#5)%"), "still matches its own row");
  });

  // The cancel route DELETEs the usage rows before it voids pay, so pay has to
  // stay findable by request id — a usage-keyed void would find nothing and
  // leave cancelled leave paid.
  it("keeps the request marker on per-day rows so cancel can still find them", () => {
    assert.ok(leavePay.includes("leave approved ${reqMarker}${usageMarker}"));
    const perDay = "Ana leave approved (leave_req#12) [leave_usage:88] — 8.00h × $20/hr, 2026-08-07";
    assert.ok(likeMatch(perDay, "%(leave_req#12)%"), "cancel finds it by request");
    assert.ok(likeMatch(perDay, "%[leave_usage:88]%"), "payroll dates it by usage day");
  });

  // Live double-pay this uncovered: Jose Ardila, 2026-08-07, 6h PLAWA paid
  // $60 by approval AND $120 by the office edit — $180 for one 6-hour day.
  // Approval's row carried no usage marker, so the edit path's
  // voidUsageLeavePay(146) matched nothing and wrote a second row on top.
  it("approval rows carry the usage marker, so an office edit voids instead of stacking", () => {
    const approvalRow = "Jose leave approved (leave_req#12) [leave_usage:146] — 6.00h × $20/hr, 2026-08-07";
    assert.ok(likeMatch(approvalRow, "%[leave_usage:146]%"),
      "voidUsageLeavePay must be able to find the approval row");
    const oldApprovalRow = "Jose leave approved (leave_req#12) — 3.00h × $20/hr, 2026-08-07";
    assert.ok(!likeMatch(oldApprovalRow, "%[leave_usage:146]%"),
      "the pre-fix row was invisible to the void — this is the double-pay");
  });

  // …and the reverse direction: once the edit path rewrites the row it must not
  // drop the request link, or cancelling the request would leave it paid.
  it("rewritten rows keep the request link so cancel still voids them", () => {
    assert.ok(/leave_request #\(\\d\+\) approved/.test(leavePay));
    assert.ok(leavePay.includes("leave recorded ${marker}${reqSuffix}"));
    const rewritten = "Jose leave recorded [leave_usage:146] (leave_req#12) — 6.00h × $20/hr, 2026-08-07";
    assert.ok(likeMatch(rewritten, "%(leave_req#12)%"), "cancel can still find it");
    assert.ok(likeMatch(rewritten, "%[leave_usage:146]%"), "and so can a later edit");
  });
});
