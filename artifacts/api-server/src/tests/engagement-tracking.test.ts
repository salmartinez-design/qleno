/**
 * Phase 4 — Engagement tracking (data layer).
 *
 * Stub-DB. Guards the unified engagement_events timeline, the native
 * click-redirect / open-pixel tokens, and that every source fans in:
 * estimate views/accept/decline, cadence sends (+ tracked link + open pixel),
 * and inbound-SMS replies.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { engagementEventsTable, trackedLinksTable } from "@workspace/db/schema";
import { recordEngagementEvent, createTrackedLink, createOpenPixel } from "../lib/engagement.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");
const migration = read("../phes-data-migration.ts");
const engine = read("../services/followUpService.ts");
const estimatesRoute = read("../routes/estimates.ts");
const trackRoute = read("../routes/track.ts");
const routesIndex = read("../routes/index.ts");

function cols(table: any, names: string[], label: string) {
  for (const n of names) {
    assert.ok(table[n], `${label}.${n} should exist`);
    assert.equal(table[n].name, n);
  }
}

describe("Phase 4 — schema + migration", () => {
  it("engagement_events columns on schema", () => {
    cols(engagementEventsTable, ["id", "company_id", "estimate_id", "enrollment_id", "event_type", "channel", "recipient", "meta", "occurred_at"], "engagement_events");
  });
  it("tracked_links columns on schema", () => {
    cols(trackedLinksTable, ["id", "token", "company_id", "estimate_id", "enrollment_id", "kind", "target_url"], "tracked_links");
  });
  it("migration creates both tables idempotently + indexes", () => {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS engagement_events/);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS tracked_links/);
    assert.match(migration, /idx_engagement_events_estimate/);
  });
});

describe("Phase 4 — engagement lib", () => {
  it("exports the recorder + link/pixel minters", () => {
    assert.equal(typeof recordEngagementEvent, "function");
    assert.equal(typeof createTrackedLink, "function");
    assert.equal(typeof createOpenPixel, "function");
  });
});

describe("Phase 4 — native click-redirect + open-pixel route", () => {
  it("is mounted at /track", () => {
    assert.match(routesIndex, /router\.use\("\/track", trackRouter\)/);
  });
  it("click endpoint records 'clicked' then 302-redirects", () => {
    assert.match(trackRoute, /\/c\/:token/);
    assert.match(trackRoute, /eventType:\s*"clicked"/);
    assert.match(trackRoute, /res\.redirect\(302/);
  });
  it("open endpoint records 'opened' then returns a pixel", () => {
    assert.match(trackRoute, /\/o\/:token/);
    assert.match(trackRoute, /eventType:\s*"opened"/);
    assert.match(trackRoute, /image\/gif/);
  });
});

describe("Phase 4 — fan-in wiring", () => {
  it("estimate public page records viewed / accepted / declined", () => {
    assert.match(estimatesRoute, /eventType:\s*"viewed"/);
    assert.match(estimatesRoute, /eventType:\s*"accepted"/);
    assert.match(estimatesRoute, /eventType:\s*"declined"/);
  });
  it("cadence estimate send records sent/failed + injects pixel + tracked link", () => {
    assert.match(engine, /eventType:\s*sendStatus === "sent" \? "sent" : "failed"/);
    assert.match(engine, /createOpenPixel/);
    assert.match(engine, /createTrackedLink/);
  });
  it("inbound reply records 'replied' against stopped estimates", () => {
    assert.match(engine, /eventType:\s*"replied"/);
    assert.match(engine, /RETURNING fe\.id AS enrollment_id, fe\.estimate_id/);
  });
});
