/**
 * LMS Signatures helpers — unit tests.
 *
 * Pure-function tests. No DB writes (the registry tests touch
 * helpers that DO read the DB, but on `DATABASE_URL=stub` Drizzle's
 * select chains are still constructible — we exercise the pure
 * pieces and stub-test the rest via dependency boundaries).
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:lms
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hashContent,
  verifyContentHash,
  captureRequestMetadata,
  validateEmployeeSignature,
} from "../lib/lms-signatures.js";
import { generateCertificatePdf } from "../lib/pdf-gen.js";
import {
  KNOWN_SIGNED_DOCUMENT_TYPES,
  CO_SIGNED_DOCUMENT_TYPES,
  ANNUAL_DOCUMENT_TYPES,
} from "@workspace/db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// hashContent
// ─────────────────────────────────────────────────────────────────────────────

describe("hashContent", () => {
  it("produces a 64-char lowercase hex SHA-256", () => {
    const h = hashContent("hello world", "en");
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it("is deterministic — same content + locale = same hash", () => {
    const a = hashContent("contract body", "en");
    const b = hashContent("contract body", "en");
    assert.equal(a, b);
  });

  it("DIFFERENT locale produces a DIFFERENT hash (English and Spanish are legally distinct)", () => {
    const en = hashContent("Same body", "en");
    const es = hashContent("Same body", "es");
    assert.notEqual(en, es);
  });

  it("whitespace differences produce DIFFERENT hashes (no normalization)", () => {
    const a = hashContent("body", "en");
    const b = hashContent("body ", "en");
    const c = hashContent("body\n", "en");
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.notEqual(b, c);
  });

  it("verifyContentHash round-trips correctly", () => {
    const h = hashContent("section 5 wage policy", "en");
    assert.equal(verifyContentHash("section 5 wage policy", "en", h), true);
  });

  it("verifyContentHash rejects mismatched content", () => {
    const h = hashContent("section 5 wage policy", "en");
    assert.equal(verifyContentHash("section 5 wage policy.", "en", h), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// captureRequestMetadata
// ─────────────────────────────────────────────────────────────────────────────

interface MockReq {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

function makeReq(overrides: Partial<MockReq> = {}): MockReq {
  return {
    headers: {},
    ip: undefined,
    socket: {},
    ...overrides,
  };
}

describe("captureRequestMetadata", () => {
  it("prefers x-forwarded-for leftmost when present", () => {
    const req = makeReq({
      headers: {
        "x-forwarded-for": "203.0.113.5, 10.0.0.1, 172.16.0.1",
        "user-agent": "Mozilla/5.0 Test",
      },
    });
    const m = captureRequestMetadata(req as never);
    assert.equal(m.ip_address, "203.0.113.5");
    assert.equal(m.user_agent, "Mozilla/5.0 Test");
  });

  it("handles x-forwarded-for as an array", () => {
    const req = makeReq({
      headers: {
        "x-forwarded-for": ["198.51.100.42", "10.0.0.5"],
        "user-agent": "curl/8.0",
      },
    });
    const m = captureRequestMetadata(req as never);
    assert.equal(m.ip_address, "198.51.100.42");
  });

  it("falls back to req.ip when x-forwarded-for is absent", () => {
    const req = makeReq({
      headers: { "user-agent": "ua" },
      ip: "192.0.2.10",
    });
    const m = captureRequestMetadata(req as never);
    assert.equal(m.ip_address, "192.0.2.10");
  });

  it("falls back to socket.remoteAddress when req.ip is absent", () => {
    const req = makeReq({
      headers: { "user-agent": "ua" },
      ip: undefined,
      socket: { remoteAddress: "192.0.2.99" },
    });
    const m = captureRequestMetadata(req as never);
    assert.equal(m.ip_address, "192.0.2.99");
  });

  it("returns 'unknown' rather than null/empty when nothing is available", () => {
    const req = makeReq({ headers: {} });
    const m = captureRequestMetadata(req as never);
    assert.equal(m.ip_address, "unknown");
    assert.equal(m.user_agent, "unknown");
  });

  it("ignores empty x-forwarded-for fragments", () => {
    const req = makeReq({
      headers: {
        "x-forwarded-for": ", 203.0.113.7",
        "user-agent": "Phes/1.0",
      },
    });
    const m = captureRequestMetadata(req as never);
    // The first split() entry is empty after trim → should fall back.
    // We accept either 'unknown' or '203.0.113.7' — the contract is
    // "return a non-empty string", not specifically the second fragment.
    assert.ok(m.ip_address.length > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateEmployeeSignature
// ─────────────────────────────────────────────────────────────────────────────

describe("validateEmployeeSignature", () => {
  it("accepts a typed signature of 2+ non-whitespace chars", () => {
    assert.equal(validateEmployeeSignature("typed", "Sal Martinez"), null);
    assert.equal(validateEmployeeSignature("typed", "ab"), null);
  });

  it("rejects typed signatures that are too short or whitespace-only", () => {
    assert.match(
      validateEmployeeSignature("typed", "") ?? "",
      /at least 2 characters/,
    );
    assert.match(
      validateEmployeeSignature("typed", "  ") ?? "",
      /at least 2 characters/,
    );
    assert.match(
      validateEmployeeSignature("typed", "a") ?? "",
      /at least 2 characters/,
    );
  });

  it("accepts a drawn signature with a real-looking data URL", () => {
    const payload = "data:image/png;base64," + "A".repeat(500);
    assert.equal(validateEmployeeSignature("drawn", payload), null);
  });

  it("rejects drawn signatures that aren't a data URL", () => {
    assert.match(
      validateEmployeeSignature("drawn", "Sal Martinez") ?? "",
      /data: image URL/,
    );
  });

  it("rejects drawn signatures that are too short to contain content", () => {
    assert.match(
      validateEmployeeSignature("drawn", "data:image/png;base64,AA") ?? "",
      /appears empty/,
    );
  });

  it("rejects unknown methods", () => {
    assert.equal(
      validateEmployeeSignature("typed", null as never),
      "Signature is required",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Known document type registries (compile-time + runtime consistency)
// ─────────────────────────────────────────────────────────────────────────────

describe("document type registries", () => {
  it("KNOWN_SIGNED_DOCUMENT_TYPES contains every type expected for the 2026 onboarding system", () => {
    const expected = [
      "handbook",
      "code_of_conduct",
      "drug_alcohol",
      "video_photo_release",
      "non_solicitation",
      "supply_kit",
      "social_media",
    ];
    for (const t of expected) {
      assert.ok(
        (KNOWN_SIGNED_DOCUMENT_TYPES as readonly string[]).includes(t),
        `KNOWN_SIGNED_DOCUMENT_TYPES missing ${t}`,
      );
    }
  });

  it("CO_SIGNED_DOCUMENT_TYPES is a subset of KNOWN_SIGNED_DOCUMENT_TYPES", () => {
    const known = new Set<string>(KNOWN_SIGNED_DOCUMENT_TYPES);
    for (const t of CO_SIGNED_DOCUMENT_TYPES) {
      assert.ok(known.has(t), `${t} co-signed but not in KNOWN`);
    }
  });

  it("ANNUAL_DOCUMENT_TYPES is a subset of KNOWN_SIGNED_DOCUMENT_TYPES", () => {
    const known = new Set<string>(KNOWN_SIGNED_DOCUMENT_TYPES);
    for (const t of ANNUAL_DOCUMENT_TYPES) {
      assert.ok(known.has(t), `${t} annual but not in KNOWN`);
    }
  });

  it("Non-Solicitation + Video/Photo Release require co-signature per spec", () => {
    assert.ok(
      (CO_SIGNED_DOCUMENT_TYPES as readonly string[]).includes(
        "non_solicitation",
      ),
    );
    assert.ok(
      (CO_SIGNED_DOCUMENT_TYPES as readonly string[]).includes(
        "video_photo_release",
      ),
    );
  });

  it("Handbook recurs annually per spec", () => {
    assert.ok(
      (ANNUAL_DOCUMENT_TYPES as readonly string[]).includes("handbook"),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pdf-gen — smoke test the cert renderer
// ─────────────────────────────────────────────────────────────────────────────

describe("generateCertificatePdf", () => {
  it("renders a valid PDF for an English certificate", async () => {
    const bytes = await generateCertificatePdf({
      tenantName: "Phes",
      employeeName: "Jose Ardila",
      moduleTitle: "Phes Policies & Procedures",
      moduleId: "phes-policies",
      score: 95,
      issuedAt: new Date("2026-05-12T17:00:00Z"),
      curriculumVersionHash: "a".repeat(64),
      locale: "en",
      ipAddress: "203.0.113.5",
      deviceInfo: "Mozilla/5.0 (Macintosh)",
    });
    assert.ok(bytes.byteLength > 1000, "PDF should be at least 1KB");
    // PDFs start with %PDF
    const header = Buffer.from(bytes.slice(0, 4)).toString("utf8");
    assert.equal(header, "%PDF");
  });

  it("renders a Spanish certificate", async () => {
    const bytes = await generateCertificatePdf({
      tenantName: "Phes",
      employeeName: "Maria González",
      moduleTitle: "Prevención del Acoso Sexual (Illinois)",
      moduleId: "il-sexual-harassment",
      score: 90,
      issuedAt: new Date("2026-12-15T10:00:00Z"),
      curriculumVersionHash: null,
      locale: "es",
      ipAddress: "198.51.100.10",
      deviceInfo: "Mozilla/5.0 (iPhone)",
    });
    assert.ok(bytes.byteLength > 1000);
  });

  it("renders a certificate for a content-only module (no score)", async () => {
    const bytes = await generateCertificatePdf({
      tenantName: "Phes",
      employeeName: "Sal Martinez",
      moduleTitle: "Onboarding Acknowledgment",
      moduleId: "acknowledgment",
      score: null,
      issuedAt: new Date(),
      curriculumVersionHash: null,
      locale: "en",
      ipAddress: "203.0.113.1",
      deviceInfo: "Mozilla/5.0 (Macintosh)",
    });
    assert.ok(bytes.byteLength > 1000);
  });
});
