/**
 * Phase 5 — Engagement dashboard read API + routing.
 *
 * Stub-DB. The dashboard is read-only UI over SQL aggregates, so we guard the
 * three read endpoints exist + are company-scoped, the summary computes the
 * rates, and the frontend route is ordered before /estimates/:id so the
 * dashboard isn't swallowed by the builder's :id route.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");
const estimatesRoute = read("../routes/estimates.ts");
const app = read("../../../qleno/src/App.tsx");
const page = read("../../../qleno/src/pages/estimate-engagement.tsx");

describe("Phase 5 — read endpoints", () => {
  it("pipeline, summary, and per-estimate engagement endpoints exist", () => {
    assert.match(estimatesRoute, /router\.get\("\/engagement\/pipeline"/);
    assert.match(estimatesRoute, /router\.get\("\/engagement\/summary"/);
    assert.match(estimatesRoute, /router\.get\("\/:id\/engagement"/);
  });
  it("all three are company-scoped", () => {
    const block = estimatesRoute.slice(estimatesRoute.indexOf("Engagement dashboard (Phase 5)"));
    // each handler references req.auth!.companyId and filters by it
    const scoped = (block.match(/company_id = \$\{companyId\}/g) || []).length;
    assert.ok(scoped >= 3, `expected >=3 company_id filters in engagement block, got ${scoped}`);
  });
  it("summary computes opened%/clicked% + avg touches to win", () => {
    assert.match(estimatesRoute, /opened_pct/);
    assert.match(estimatesRoute, /clicked_pct/);
    assert.match(estimatesRoute, /avg_touches_to_win/);
  });
  it("per-estimate returns a touchpoint timeline ordered by time", () => {
    assert.match(estimatesRoute, /FROM engagement_events WHERE estimate_id = \$\{id\}[\s\S]*ORDER BY occurred_at ASC/);
    assert.match(estimatesRoute, /next_fire_at/); // next-scheduled surfaced
  });
});

describe("Phase 5 — frontend wiring", () => {
  it("engagement route is registered BEFORE the /estimates/:id builder route", () => {
    const iEng = app.indexOf('path="/estimates/engagement"');
    const iId = app.indexOf('path="/estimates/:id"');
    assert.ok(iEng > 0, "engagement route present");
    assert.ok(iId > 0, "builder :id route present");
    assert.ok(iEng < iId, "engagement must be matched before :id");
  });
  it("dashboard page renders summary, pipeline, and a timeline", () => {
    assert.match(page, /engagement\/summary/);
    assert.match(page, /engagement\/pipeline/);
    assert.match(page, /\/engagement`/); // per-estimate fetch in Timeline
    assert.match(page, /Avg touches/);
  });
  it("estimates list links to the engagement dashboard", () => {
    const list = read("../../../qleno/src/pages/estimates.tsx");
    assert.match(list, /navigate\("\/estimates\/engagement"\)/);
  });
});
