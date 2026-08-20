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

describe("turning a recurrence off and back on, for the right client", () => {
// ─── [recurring-scope 2026-08-20] ────────────────────────────────────────────
// The client profile's Recurring tab asked for one client's schedules
// (`?customer_id=`) and the server ignored the parameter, so it listed every
// schedule in the company on every client's profile. Turning one off from
// there turned off a stranger's schedule. These lock the scoping and the
// turn-off/turn-back-on pair.
  it("the recurring list is scoped to the client that was asked for", () => {
    const src = readFileSync(new URL("../routes/recurring.ts", import.meta.url), "utf8");
    const get = src.slice(src.indexOf('router.get("/", requireAuth'), src.indexOf('router.patch("/bulk"'));

    assert.ok(get.includes("req.query.customer_id"), "GET / must read customer_id");
    assert.ok(
    get.includes("eq(recurringSchedulesTable.customer_id, customerId)"),
    "GET / must filter on customer_id when one is given",
  );
    assert.ok(
    get.includes("eq(recurringSchedulesTable.company_id, req.auth!.companyId)"),
    "GET / must stay company-scoped",
  );
    // Default stays active-only so the company-wide page is unchanged.
    assert.ok(get.includes("include_inactive"), "GET / must offer include_inactive");
    assert.ok(
    get.includes("includeInactive ? [] : [eq(recurringSchedulesTable.is_active, true)]"),
    "active-only must remain the default",
  );
  });

  it("a turned-off schedule can be turned back on, unless a service hold owns it", () => {
    const src = readFileSync(new URL("../routes/recurring.ts", import.meta.url), "utf8");

    assert.ok(src.includes('router.post("/:id/reactivate"'), "reactivate endpoint must exist");
    const re = src.slice(src.indexOf('router.post("/:id/reactivate"'));
    const body = re.slice(0, re.indexOf('router.post("/trigger"'));

    assert.ok(body.includes("paused_by_suspension"), "reactivate must check the hold flag");
    assert.ok(body.includes("409"), "reactivate must refuse a hold-paused schedule");
    assert.ok(
    body.includes("eq(recurringSchedulesTable.company_id, companyId)"),
    "reactivate must be company-scoped",
  );

    // The turn-off path must never set the hold flag, or client-suspension's
    // resume ("re-activate ONLY the schedules this suspension paused") would
    // start reviving schedules the office turned off deliberately.
    const del = src.slice(src.indexOf('router.delete("/:id"'), src.indexOf('router.post("/:id/reactivate"'));
    assert.ok(
    !del.includes("paused_by_suspension: true"),
    "DELETE must not claim the service-hold flag",
  );
  });

  it("the Recurring tab asks for one client and offers turn off / turn back on", () => {
    const page = readFileSync(
    new URL("../../../qleno/src/pages/customer-profile.tsx", import.meta.url),
    "utf8",
  );

    assert.ok(
    page.includes("/api/recurring?customer_id=${clientId}&include_inactive=1"),
    "the tab must ask for this client's schedules, turned-off ones included",
  );
    assert.ok(page.includes("setConfirmOff("), "turning off must ask first");
    assert.ok(page.includes("/reactivate`"), "the tab must be able to turn one back on");
    assert.ok(page.includes("Turn back on"), "the turn-back-on control must be labelled plainly");
    assert.ok(!page.includes(">Pause</button>"), 'the misleading "Pause" label must be gone');
    assert.ok(page.includes("On service hold"), "a hold-paused schedule must say so");
  });

});

// [edit-from-recurring-list 2026-08-20] The same door, on the company-wide
// list at /recurring. That page already shows a "Wrong day" warning telling
// the office to "Edit the schedule to fix" — and then offered no way to edit
// it, only a link out to the customer profile. These assertions keep the list
// page mounting the SAME shared modal on the SAME anchor endpoint, so there is
// still exactly one cascade in the app.
describe("the company-wide recurring list can edit a schedule too", () => {
  const listPage = read("../../../qleno/src/pages/recurring-schedules.tsx");

  it("opens the shared edit modal, not a private one", () => {
    assert.match(
      listPage,
      /lazy\(\(\) => import\("@\/components\/edit-job-modal"\)\)/,
      "the list page must reuse the one edit screen",
    );
    assert.match(listPage, /<EditJobModal/);
  });

  it("gets the visit to open from the anchor endpoint", () => {
    assert.match(
      listPage,
      /\/api\/recurring\/\$\{scheduleId\}\/anchor/,
      "no second way of deciding which visit represents the series",
    );
  });

  it("has an Edit control on both the phone and desktop layouts", () => {
    const edits = listPage.match(/openEdit\(r\.id\)/g) || [];
    assert.equal(edits.length, 2, "one Edit button in the mobile card, one in the table row");
  });

  it("says something useful when a schedule has no visits yet", () => {
    assert.match(
      listPage,
      /no visits on the calendar yet/,
      "a schedule with nothing generated must explain itself, not fail silently",
    );
  });

  it("does not write its own recurrence cascade", () => {
    assert.doesNotMatch(
      listPage,
      /this_and_future|apply_to_future|future_jobs_updated/,
      "the list page must not reimplement the this-and-all-future rewrite",
    );
  });
});
