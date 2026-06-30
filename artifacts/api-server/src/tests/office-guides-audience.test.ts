/**
 * Office guides must NEVER be visible to techs.
 *
 * The route (routes/guides.ts visibleAudiences) walls technician/team_lead to
 * ['tech','all']. So an office guide is safe IFF its audience is exactly
 * 'office' (not 'all', which techs can see, and not 'tech'). This test locks
 * that — if someone later flips the tip guide to 'all', it fails here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OFFICE_GUIDES, TECH_GUIDES } from "../lib/guides-content.js";

// Mirror of routes/guides.ts visibleAudiences — the wall under test.
function visibleAudiences(role: string): string[] {
  if (role === "technician" || role === "team_lead") return ["tech", "all"];
  if (role === "owner" || role === "admin" || role === "super_admin") return ["tech", "office", "all"];
  return ["office", "all"];
}

describe("office guides are walled off from techs", () => {
  it("every office guide is audience 'office' (never 'all'/'tech')", () => {
    for (const g of OFFICE_GUIDES) {
      assert.equal(g.audience, "office", `guide '${g.slug}' must be audience 'office'`);
    }
  });

  it("a technician / team_lead cannot see any office guide", () => {
    for (const role of ["technician", "team_lead"]) {
      const seen = visibleAudiences(role);
      for (const g of OFFICE_GUIDES) {
        assert.ok(!seen.includes(g.audience), `${role} must NOT see office guide '${g.slug}'`);
      }
    }
  });

  it("office + owner/admin CAN see the tip guide", () => {
    const tip = OFFICE_GUIDES.find((g) => g.slug === "add-a-tip");
    assert.ok(tip, "add-a-tip office guide exists");
    for (const role of ["office", "accountant", "owner", "admin"]) {
      assert.ok(visibleAudiences(role).includes(tip!.audience), `${role} should see the tip guide`);
    }
  });

  it("the tip guide is not duplicated in the tech guide set", () => {
    assert.ok(!TECH_GUIDES.some((g) => g.slug === "add-a-tip"));
  });
});
