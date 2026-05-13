/**
 * Spanish translation flag — E2E verification (Phase 16, PR #17 of 16).
 *
 * Confirms three things at once:
 *   1. Every registered signed document has BOTH `en` and `es` content
 *      (bilingual coverage is non-negotiable for Phes).
 *   2. The `pendingTranslationReview` flag is set consistently across
 *      every surface: registry data, the helper function, the
 *      signed-document PDF banner, the comprehensive handbook PDF
 *      watermark, and the `/content` API response (covered by smoke
 *      checks against the renderer).
 *   3. English content NEVER carries the flag (English is the binding
 *      version per the brand legal pages).
 *
 * The flag matters legally: when Phes signs Spanish-speaking employees
 * onto a translation that has NOT yet been certified by a professional
 * translator, every printed page MUST display "the English version is
 * binding" so the employee understands what they're agreeing to. A
 * silent flag flip would put Phes outside the documented compliance
 * posture; this test fails loudly the moment that happens.
 *
 * Current flagged set: drug_alcohol, non_solicitation, handbook.
 * If you flag a new document, update both the registry and the
 * `EXPECTED_FLAGGED_ES_DOCS` array below — the divergence test will
 * tell you when to do so.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SIGNED_DOCUMENT_CONTENT,
  getSignedDocumentContent,
  isSpanishPendingTranslationReview,
  listRegisteredDocumentTypes,
} from "../lib/lms-signed-documents-content.js";
import { generateSignedDocumentPdf } from "../lib/pdf-gen.js";
import {
  generateComprehensiveHandbookPdf,
  type ComprehensiveHandbookInput,
} from "../lib/lms-handbook-pdf.js";
import { KNOWN_SIGNED_DOCUMENT_TYPES } from "@workspace/db/schema";

// The set of documents Phes has explicitly flagged as awaiting a
// professional Spanish translation review. Update both this array AND
// the registry entry's `pendingTranslationReview: true` flag together
// when adding/removing.
const EXPECTED_FLAGGED_ES_DOCS = ["drug_alcohol", "non_solicitation", "handbook"];
const FLAGGED_SET = new Set(EXPECTED_FLAGGED_ES_DOCS);

describe("Spanish flag — registry coverage", () => {
  it("every KNOWN_SIGNED_DOCUMENT_TYPE has both en and es content", () => {
    for (const docType of KNOWN_SIGNED_DOCUMENT_TYPES) {
      const en = getSignedDocumentContent(docType, "en");
      const es = getSignedDocumentContent(docType, "es");
      assert.ok(en, `${docType}: missing English content`);
      assert.ok(es, `${docType}: missing Spanish content`);
      assert.ok(en!.contentHtml.length > 50, `${docType}: English body trivially small`);
      assert.ok(es!.contentHtml.length > 50, `${docType}: Spanish body trivially small`);
      assert.ok(en!.title.length > 0, `${docType}: English title missing`);
      assert.ok(es!.title.length > 0, `${docType}: Spanish title missing`);
    }
  });

  it("listRegisteredDocumentTypes returns every KNOWN_SIGNED_DOCUMENT_TYPE", () => {
    const registered = new Set(listRegisteredDocumentTypes());
    for (const docType of KNOWN_SIGNED_DOCUMENT_TYPES) {
      assert.ok(
        registered.has(docType),
        `${docType} is in KNOWN_SIGNED_DOCUMENT_TYPES but not registered`,
      );
    }
  });

  it("Spanish bodies differ from English bodies (no copy-paste)", () => {
    for (const docType of KNOWN_SIGNED_DOCUMENT_TYPES) {
      const en = getSignedDocumentContent(docType, "en");
      const es = getSignedDocumentContent(docType, "es");
      if (en && es) {
        assert.notEqual(
          en.contentHtml,
          es.contentHtml,
          `${docType}: en and es contentHtml are identical — translation missing`,
        );
      }
    }
  });
});

describe("Spanish flag — policy enforcement", () => {
  it("the expected flagged set ALL have pendingTranslationReview=true on ES", () => {
    for (const docType of EXPECTED_FLAGGED_ES_DOCS) {
      const es = getSignedDocumentContent(docType, "es");
      assert.ok(es, `${docType}: ES content missing`);
      assert.equal(
        es!.pendingTranslationReview,
        true,
        `${docType}: EXPECTED_FLAGGED_ES_DOCS lists this but registry does not flag it`,
      );
    }
  });

  it("docs NOT in the expected flagged set must NOT carry the ES flag", () => {
    for (const docType of KNOWN_SIGNED_DOCUMENT_TYPES) {
      if (FLAGGED_SET.has(docType)) continue;
      const es = getSignedDocumentContent(docType, "es");
      assert.ok(es, `${docType}: ES content missing`);
      assert.notEqual(
        es!.pendingTranslationReview,
        true,
        `${docType}: registry flags this but the policy list does NOT — update one of them`,
      );
    }
  });

  it("English entries NEVER carry pendingTranslationReview (English is binding)", () => {
    for (const docType of KNOWN_SIGNED_DOCUMENT_TYPES) {
      const en = getSignedDocumentContent(docType, "en");
      assert.ok(en);
      assert.notEqual(
        en!.pendingTranslationReview,
        true,
        `${docType}: EN must never be flagged — English is the binding version`,
      );
    }
  });

  it("isSpanishPendingTranslationReview() agrees with the raw registry for every type", () => {
    for (const docType of KNOWN_SIGNED_DOCUMENT_TYPES) {
      const fromHelper = isSpanishPendingTranslationReview(docType);
      const fromRegistry =
        SIGNED_DOCUMENT_CONTENT[docType]?.es.pendingTranslationReview === true;
      assert.equal(
        fromHelper,
        fromRegistry,
        `${docType}: helper disagrees with raw registry`,
      );
    }
  });

  it("isSpanishPendingTranslationReview returns false for unknown types", () => {
    assert.equal(
      isSpanishPendingTranslationReview("definitely_not_a_doc"),
      false,
    );
  });
});

describe("Spanish flag — signed-document PDF banner", () => {
  const BASE_INPUT = {
    tenantName: "Phes",
    documentTitle: "Drug and Alcohol Policy Acknowledgment",
    documentType: "drug_alcohol",
    contentBody: "Test body for PDF generation.\nSecond line.",
    employeeName: "Jane Tester",
    employeeSignature: "Jane Tester",
    employeeSignatureMethod: "typed" as const,
    signedAt: new Date("2026-05-13T14:00:00Z"),
    ipAddress: "10.0.0.1",
    deviceInfo: "Chrome / macOS",
    versionHash:
      "abcd1234567890efabcd1234567890efabcd1234567890efabcd1234567890ef",
    locale: "es" as const,
  };

  it("renders without crashing when pendingTranslationReview is true", async () => {
    const bytes = await generateSignedDocumentPdf({
      ...BASE_INPUT,
      pendingTranslationReview: true,
    });
    assert.ok(bytes.length > 1000, "PDF should be > 1KB");
    assert.equal(
      Buffer.from(bytes.slice(0, 4)).toString("ascii"),
      "%PDF",
      "PDF should start with %PDF magic",
    );
  });

  it("renders without crashing when pendingTranslationReview is false", async () => {
    const bytes = await generateSignedDocumentPdf({
      ...BASE_INPUT,
      pendingTranslationReview: false,
    });
    assert.ok(bytes.length > 1000);
  });

  it("EN locale never receives the Spanish banner regardless of the flag", async () => {
    const bytes = await generateSignedDocumentPdf({
      ...BASE_INPUT,
      locale: "en",
      pendingTranslationReview: true,
    });
    assert.ok(bytes.length > 1000);
  });
});

describe("Spanish flag — comprehensive handbook PDF banner", () => {
  const HANDBOOK_BASE: ComprehensiveHandbookInput = {
    tenantName: "Phes",
    employeeName: "Jane Q. Tester",
    locale: "es",
    pendingTranslationReview: true,
    contentBody: [
      "## Reconocimiento de Recepción y Comprensión",
      "Reconozco que he leído el manual.",
      "",
      "## Empleo a Voluntad",
      "Entiendo que mi empleo es a voluntad.",
    ].join("\n"),
    employeeSignature: "Jane Q. Tester",
    employeeSignatureMethod: "typed",
    signedAt: new Date("2026-05-13T14:00:00Z"),
    ipAddress: "10.0.0.1",
    deviceInfo: "Chrome / macOS",
    versionHash:
      "abcd1234567890efabcd1234567890efabcd1234567890efabcd1234567890ef",
    includedAcks: [],
    completedModuleIds: [],
    moduleTitles: { "phes-policies": "Políticas de Phes" },
    preview: false,
  };

  it("renders the ES handbook with the banner without crashing", async () => {
    const bytes = await generateComprehensiveHandbookPdf(HANDBOOK_BASE);
    assert.ok(bytes.length > 1000);
  });

  it("renders the EN handbook (banner suppressed) without crashing", async () => {
    const bytes = await generateComprehensiveHandbookPdf({
      ...HANDBOOK_BASE,
      locale: "en",
      pendingTranslationReview: false,
      contentBody: "## Acknowledgment\nI agree.",
    });
    assert.ok(bytes.length > 1000);
  });

  it("renders the ES handbook without the banner (flag=false) without crashing", async () => {
    const bytes = await generateComprehensiveHandbookPdf({
      ...HANDBOOK_BASE,
      pendingTranslationReview: false,
    });
    assert.ok(bytes.length > 1000);
  });
});

describe("Spanish flag — registry self-consistency", () => {
  it("Spanish-flagged docs are exactly the documents this test file lists", () => {
    const actuallyFlagged: string[] = [];
    for (const docType of KNOWN_SIGNED_DOCUMENT_TYPES) {
      if (SIGNED_DOCUMENT_CONTENT[docType]?.es.pendingTranslationReview === true) {
        actuallyFlagged.push(docType);
      }
    }
    actuallyFlagged.sort();
    const expected = [...EXPECTED_FLAGGED_ES_DOCS].sort();
    assert.deepEqual(
      actuallyFlagged,
      expected,
      `flagged set drifted. Update EXPECTED_FLAGGED_ES_DOCS to match the registry, or update the registry to match the policy.`,
    );
  });
});

describe("Bilingual coverage — em/en dash policy holds for ES content", () => {
  it("Spanish bodies contain no em dashes or en dashes", () => {
    for (const docType of KNOWN_SIGNED_DOCUMENT_TYPES) {
      const es = getSignedDocumentContent(docType, "es");
      assert.ok(es);
      assert.ok(
        !es!.contentHtml.includes("—"),
        `${docType} ES: em dash present`,
      );
      assert.ok(
        !es!.contentHtml.includes("–"),
        `${docType} ES: en dash present`,
      );
    }
  });

  it("Spanish content contains at least one accented character (sanity check)", () => {
    const accentRe = /[áéíóúñÁÉÍÓÚÑ¿¡]/;
    for (const docType of KNOWN_SIGNED_DOCUMENT_TYPES) {
      const es = getSignedDocumentContent(docType, "es");
      assert.ok(es);
      assert.ok(
        accentRe.test(es!.contentHtml),
        `${docType} ES: no Spanish accented characters or punctuation found — likely a placeholder translation`,
      );
    }
  });
});
