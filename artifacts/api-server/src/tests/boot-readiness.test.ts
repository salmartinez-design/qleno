/**
 * Boot ordering + readiness gate (Sal 2026-06-24).
 *
 * Durable fix for the chronic Railway deploy-healthcheck failures: the server
 * now binds the port and answers health FIRST, then runs the migration chain in
 * the background. A readiness gate holds non-health /api routes at 503 until the
 * chain completes, so no request hits partially-migrated schema (preserves the
 * 2026-05-17 read/write-divergence fix).
 *
 * Pure test of the readiness flag + file-grep invariants on the boot source
 * (matching the cutover-3a pattern — the route's wiring is the load-bearing
 * part and can't be unit-exercised without booting the server).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAppReady, setAppReady } from "../lib/readiness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(path.join(__dirname, "../index.ts"), "utf8");
const appSrc = readFileSync(path.join(__dirname, "../app.ts"), "utf8");

describe("readiness flag", () => {
  it("starts not-ready and flips once", () => {
    // Module starts false (nothing has flipped it in this test process yet).
    assert.equal(isAppReady(), false);
    setAppReady(true);
    assert.equal(isAppReady(), true);
    setAppReady(false);
    assert.equal(isAppReady(), false);
  });
});

describe("index.ts — port binds BEFORE migrations", () => {
  it("startup() calls app.listen()", () => {
    assert.ok(/async function startup\(\)\s*{[\s\S]*app\.listen\(port/.test(indexSrc));
  });
  it("migrations are extracted into runStartupMigrations()", () => {
    assert.ok(indexSrc.includes("async function runStartupMigrations()"));
  });
  it("runStartupMigrations() is awaited INSIDE the listen callback (after bind)", () => {
    const afterListen = indexSrc.slice(indexSrc.indexOf("app.listen(port"));
    assert.ok(afterListen.includes("await runStartupMigrations()"));
    // and readiness flips right after the chain completes
    assert.ok(/await runStartupMigrations\(\);\s*\n\s*setAppReady\(true\)/.test(afterListen));
  });
  it("does NOT await migrations before app.listen()", () => {
    const beforeListen = indexSrc.slice(0, indexSrc.indexOf("app.listen(port"));
    assert.ok(!beforeListen.includes("await runStartupMigrations()"));
  });
});

describe("app.ts — readiness gate", () => {
  it("gate checks isAppReady and 503s when not ready", () => {
    assert.ok(appSrc.includes("isAppReady()"));
    assert.ok(/status\(503\)/.test(appSrc));
    assert.ok(appSrc.includes("warming_up"));
  });
  it("gate exempts health + healthz so Railway's probe stays green", () => {
    assert.ok(appSrc.includes('req.path === "/api/health"'));
    assert.ok(appSrc.includes('req.path === "/api/healthz"'));
  });
  it("gate is mounted before the main /api router", () => {
    const gateIdx = appSrc.indexOf("warming_up");
    const routerIdx = appSrc.indexOf('app.use("/api", router)');
    assert.ok(gateIdx > -1 && routerIdx > -1 && gateIdx < routerIdx);
  });
});
