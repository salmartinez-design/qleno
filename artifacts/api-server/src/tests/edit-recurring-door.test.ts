// [edit-recurring 2026-08-20] Maribel: "We should be able to modify the
// recurrence of a client without having to delete it and create a new one."
//
// She was right, and what was missing was a DOOR, not an engine. Editing a
// recurring visit from the dispatch board and picking "this and all future"
// has rewritten both the schedule template and the visits already sitting on
// the calendar for months. The client profile's Recurring tab simply never
// offered a way in, so moving a client from Wednesday to Friday meant deleting
// the schedule and rebuilding it by hand — which is exactly what she was doing.
//
// The build is therefore an anchor endpoint (which visit should the modal open
// on?) plus an Edit button that mounts the SAME modal. These assertions exist
// to keep it that way. The failure mode they guard is somebody later "fixing"
// the tab by writing a second cascade inside the recurring routes: two copies
// of the rewrite logic drift, and the day they disagree, the calendar and the
// template stop describing the same service.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), "utf8");

const recurringRoutes = read("../routes/recurring.ts");
const profilePage = read("../../../qleno/src/pages/customer-profile.tsx");
const editModal = read("../../../qleno/src/components/edit-job-modal.tsx");

describe("editing a recurrence opens the existing cascade, not a new one", () => {
  it("serves an anchor visit for a schedule", () => {
    assert.match(
      recurringRoutes,
      /router\.get\(\s*["']\/:id\/anchor["']/,
      "GET /api/recurring/:id/anchor is what the Edit button opens on",
    );
  });

  it("keeps the anchor office-only and company-scoped", () => {
    const block = recurringRoutes.slice(recurringRoutes.indexOf('"/:id/anchor"'));
    assert.match(
      block.slice(0, 400),
      /requireAuth,\s*requireRole\("owner",\s*"admin",\s*"office"\)/,
      "a tech must not be able to pull a schedule's anchor visit",
    );
    assert.ok(
      block.slice(0, 3000).includes("j.company_id = ${companyId}"),
      "the anchor lookup must filter by company_id like every other query",
    );
  });

  it("does not grow a second cascade inside the recurring routes", () => {
    assert.ok(
      !/cascade_scope/.test(recurringRoutes),
      "the rewrite of already-scheduled visits lives in PATCH /api/jobs/:id — one copy only",
    );
    assert.ok(
      !/DELETE\s+FROM\s+jobs/i.test(recurringRoutes),
      "deleting visits a changed pattern no longer wants belongs to the jobs cascade",
    );
  });

  it("puts an Edit button on the client's Recurring tab", () => {
    assert.ok(
      profilePage.includes("openEdit(s.id)"),
      "each schedule row needs a way in; Add and Pause alone forced delete-and-rebuild",
    );
    assert.ok(
      profilePage.includes("/anchor`"),
      "Edit fetches the series' next visit before opening the modal",
    );
  });

  it("mounts the same edit modal the dispatch board uses", () => {
    assert.ok(
      profilePage.includes('lazy(() => import("@/components/edit-job-modal"))'),
      "reuse the modal; a bespoke recurrence form would be the second copy that drifts",
    );
    assert.match(
      profilePage,
      /<EditJobModal\b/,
      "the Edit button has to actually render it",
    );
  });

  it("says so plainly when a schedule has no visit to open", () => {
    assert.ok(
      profilePage.includes("setEditNotice("),
      "an empty modal is worse than a sentence explaining there is nothing to edit yet",
    );
  });

  it("still defaults a recurring edit to this and all future", () => {
    // This is the line that makes the whole feature answer Maribel's ask. If a
    // recurrence edit ever defaults back to a single visit, the schedule would
    // change while the visits already on the calendar stayed on the old day.
    assert.ok(
      editModal.includes('setCascadeChoice("this_and_future")'),
      "changing the day must move the visits already booked, not just the template",
    );
  });
});
