/**
 * LMS Certificate helpers — unit tests.
 *
 * Pure-function tests. The DB-touching pieces (issueCertificate,
 * listCertificatesForUser, etc.) live in lms-certificates.ts which
 * imports from @workspace/db, so they cannot be exercised against a
 * stub DATABASE_URL without spinning up Postgres. Instead we test:
 *   - parseMinimalDeviceInfo (browser + OS detection)
 *   - getCurriculumModuleTitle (server-side title lookup)
 *
 * Issuance flow is exercised indirectly via the API routes in
 * integration tests (out of scope here).
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:lms
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMinimalDeviceInfo } from "../lib/lms-signatures.js";
import { getCurriculumModuleTitle } from "../lib/lms-curriculum-titles.js";

// ─────────────────────────────────────────────────────────────────────────────
// parseMinimalDeviceInfo
// ─────────────────────────────────────────────────────────────────────────────

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  firefoxLinux:
    "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  operaWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0",
};

describe("parseMinimalDeviceInfo", () => {
  it("identifies Chrome + macOS", () => {
    assert.equal(parseMinimalDeviceInfo(UA.chromeMac), "Chrome 120 / macOS");
  });

  it("identifies Safari + macOS (with Version/N)", () => {
    assert.equal(parseMinimalDeviceInfo(UA.safariMac), "Safari 17 / macOS");
  });

  it("identifies Firefox + Linux", () => {
    assert.equal(parseMinimalDeviceInfo(UA.firefoxLinux), "Firefox 121 / Linux");
  });

  it("identifies Edge + Windows (despite Chrome substring)", () => {
    assert.equal(parseMinimalDeviceInfo(UA.edgeWindows), "Edge 120 / Windows");
  });

  it("identifies Safari + iOS on iPhone", () => {
    assert.equal(parseMinimalDeviceInfo(UA.safariIphone), "Safari 17 / iOS");
  });

  it("identifies Chrome + Android", () => {
    assert.equal(
      parseMinimalDeviceInfo(UA.chromeAndroid),
      "Chrome 120 / Android",
    );
  });

  it("identifies Opera + Windows (despite OPR + Chrome substring)", () => {
    assert.equal(parseMinimalDeviceInfo(UA.operaWindows), "Opera 105 / Windows");
  });

  it("returns 'unknown' on empty / 'unknown' input (column NOT NULL fallback)", () => {
    assert.equal(parseMinimalDeviceInfo(""), "unknown");
    assert.equal(parseMinimalDeviceInfo("unknown"), "unknown");
  });

  it("falls through to 'Browser / OS' on unrecognized UA rather than crashing", () => {
    const result = parseMinimalDeviceInfo("Some custom crawler/1.0");
    // We don't care exactly what string we get, only that it's truthy
    // and contains a slash separator.
    assert.ok(result.includes("/"), `unexpected fallback: ${result}`);
    assert.notEqual(result, "unknown");
  });

  it("does NOT leak fingerprinting data (no screen, no fonts, no plugins)", () => {
    const noisy =
      UA.chromeMac +
      " (custom: screen=2560x1440; fonts=Helvetica,Arial,sans-serif; plugins=PDF,Java)";
    const parsed = parseMinimalDeviceInfo(noisy);
    assert.ok(!parsed.includes("2560"), "screen size leaked");
    assert.ok(!parsed.includes("Helvetica"), "font list leaked");
    assert.ok(!parsed.includes("plugins"), "plugin list leaked");
    assert.ok(!parsed.includes("PDF"), "plugin name leaked");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getCurriculumModuleTitle
// ─────────────────────────────────────────────────────────────────────────────

describe("getCurriculumModuleTitle", () => {
  it("returns the English title for phes-policies", () => {
    assert.equal(
      getCurriculumModuleTitle("phes-policies", "en"),
      "Phes Policies & Procedures",
    );
  });

  it("returns the Spanish title for phes-policies", () => {
    assert.equal(
      getCurriculumModuleTitle("phes-policies", "es"),
      "Políticas y Procedimientos de Phes",
    );
  });

  it("returns the English title for il-sexual-harassment", () => {
    assert.equal(
      getCurriculumModuleTitle("il-sexual-harassment", "en"),
      "Sexual Harassment Prevention (Illinois)",
    );
  });

  it("returns the Spanish title for il-sexual-harassment", () => {
    assert.equal(
      getCurriculumModuleTitle("il-sexual-harassment", "es"),
      "Prevención del Acoso Sexual (Illinois)",
    );
  });

  it("handles the final mixed test pseudo-id", () => {
    assert.equal(getCurriculumModuleTitle("__final", "en"), "Final Mixed Test");
    assert.equal(getCurriculumModuleTitle("__final", "es"), "Examen Final Mixto");
  });

  it("falls back to a sentence-cased version of an unknown id", () => {
    assert.equal(
      getCurriculumModuleTitle("brand-new-module", "en"),
      "Brand New Module",
    );
  });

  it("fallback handles snake_case ids", () => {
    assert.equal(
      getCurriculumModuleTitle("brand_new_module", "en"),
      "Brand New Module",
    );
  });
});
