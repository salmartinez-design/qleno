/**
 * Signed-document content registry — unit tests.
 *
 * Pure tests over the content registry + PDF render smoke. The DB-
 * touching pieces (POST /sign, version registry) require a live
 * Postgres + signed JWTs and are exercised by manual / integration
 * testing.
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:lms
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
import { hashContent } from "../lib/lms-signatures.js";

// ─────────────────────────────────────────────────────────────────────────────
// Registry shape + content integrity
// ─────────────────────────────────────────────────────────────────────────────

describe("SIGNED_DOCUMENT_CONTENT registry", () => {
  it("includes drug_alcohol (Phase 3 PR #4)", () => {
    assert.ok(SIGNED_DOCUMENT_CONTENT.drug_alcohol);
    assert.ok(SIGNED_DOCUMENT_CONTENT.drug_alcohol!.en);
    assert.ok(SIGNED_DOCUMENT_CONTENT.drug_alcohol!.es);
  });

  it("includes code_of_conduct (Phase 4 PR #5)", () => {
    assert.ok(SIGNED_DOCUMENT_CONTENT.code_of_conduct);
    assert.ok(SIGNED_DOCUMENT_CONTENT.code_of_conduct!.en);
    assert.ok(SIGNED_DOCUMENT_CONTENT.code_of_conduct!.es);
  });

  it("every registered document has BOTH en and es entries", () => {
    for (const [type, entry] of Object.entries(SIGNED_DOCUMENT_CONTENT)) {
      assert.ok(entry?.en?.contentHtml, `${type}: missing en.contentHtml`);
      assert.ok(entry?.en?.title, `${type}: missing en.title`);
      assert.ok(entry?.es?.contentHtml, `${type}: missing es.contentHtml`);
      assert.ok(entry?.es?.title, `${type}: missing es.title`);
    }
  });

  it("contains no em dashes or en dashes in any user-facing field", () => {
    for (const [type, entry] of Object.entries(SIGNED_DOCUMENT_CONTENT)) {
      for (const locale of ["en", "es"] as const) {
        const body = entry?.[locale]?.contentHtml ?? "";
        const title = entry?.[locale]?.title ?? "";
        assert.ok(
          !body.includes("—"),
          `${type} ${locale}: em dash in contentHtml`,
        );
        assert.ok(
          !body.includes("–"),
          `${type} ${locale}: en dash in contentHtml`,
        );
        assert.ok(
          !title.includes("—"),
          `${type} ${locale}: em dash in title`,
        );
        assert.ok(
          !title.includes("–"),
          `${type} ${locale}: en dash in title`,
        );
      }
    }
  });

  it("drug_alcohol Spanish entry is flagged pendingTranslationReview", () => {
    assert.equal(isSpanishPendingTranslationReview("drug_alcohol"), true);
  });

  it("drug_alcohol English entry is NOT flagged (English is binding)", () => {
    assert.equal(
      SIGNED_DOCUMENT_CONTENT.drug_alcohol!.en.pendingTranslationReview ?? false,
      false,
    );
  });

  it("Spanish content references the Illinois Cannabis Act with Spanish wording", () => {
    const es = SIGNED_DOCUMENT_CONTENT.drug_alcohol!.es.contentHtml;
    assert.ok(
      es.includes("Ley de Regulación e Impuestos del Cannabis"),
      "Spanish version must reference the Illinois Cannabis Act translation",
    );
  });

  it("English content includes the 72-hour DUI reporting window verbatim", () => {
    const en = SIGNED_DOCUMENT_CONTENT.drug_alcohol!.en.contentHtml;
    assert.ok(
      en.includes("seventy-two hours"),
      "English version must include the 72-hour DUI reporting window",
    );
  });

  it("English and Spanish content hash to DIFFERENT version hashes (legally distinct)", () => {
    const en = SIGNED_DOCUMENT_CONTENT.drug_alcohol!.en.contentHtml;
    const es = SIGNED_DOCUMENT_CONTENT.drug_alcohol!.es.contentHtml;
    const hEn = hashContent(en, "en");
    const hEs = hashContent(es, "es");
    assert.notEqual(hEn, hEs);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Resolver helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("getSignedDocumentContent", () => {
  it("returns en entry for known document type", () => {
    const c = getSignedDocumentContent("drug_alcohol", "en");
    assert.ok(c?.title);
    assert.ok(c?.contentHtml);
  });

  it("returns es entry for known document type", () => {
    const c = getSignedDocumentContent("drug_alcohol", "es");
    assert.ok(c?.title);
    assert.ok(c?.contentHtml);
  });

  it("returns null for unknown document type", () => {
    assert.equal(getSignedDocumentContent("not_a_real_doc", "en"), null);
  });
});

describe("listRegisteredDocumentTypes", () => {
  it("includes drug_alcohol after PR #4", () => {
    assert.ok(listRegisteredDocumentTypes().includes("drug_alcohol"));
  });

  it("includes code_of_conduct after PR #5", () => {
    assert.ok(listRegisteredDocumentTypes().includes("code_of_conduct"));
  });
});

describe("code_of_conduct content shape", () => {
  it("English entry is NOT flagged pendingTranslationReview", () => {
    assert.equal(
      SIGNED_DOCUMENT_CONTENT.code_of_conduct!.en.pendingTranslationReview ?? false,
      false,
    );
  });

  it("Spanish entry is NOT flagged pendingTranslationReview (not in the four flagged docs)", () => {
    assert.equal(
      SIGNED_DOCUMENT_CONTENT.code_of_conduct!.es.pendingTranslationReview ?? false,
      false,
    );
    assert.equal(isSpanishPendingTranslationReview("code_of_conduct"), false);
  });

  it("English content references the Illinois Human Rights Act", () => {
    const en = SIGNED_DOCUMENT_CONTENT.code_of_conduct!.en.contentHtml;
    assert.ok(
      en.includes("Illinois Human Rights Act"),
      "English version must reference the Illinois Human Rights Act protected classes",
    );
  });

  it("Spanish content references the Ley de Derechos Humanos de Illinois", () => {
    const es = SIGNED_DOCUMENT_CONTENT.code_of_conduct!.es.contentHtml;
    assert.ok(
      es.includes("Ley de Derechos Humanos de Illinois"),
      "Spanish version must reference the IL Human Rights Act translation",
    );
  });

  it("English content includes zero-tolerance theft clause verbatim", () => {
    const en = SIGNED_DOCUMENT_CONTENT.code_of_conduct!.en.contentHtml;
    assert.ok(
      en.includes("zero-tolerance theft policy"),
      "English version must include the zero-tolerance theft commitment",
    );
  });

  it("English and Spanish content hash to DIFFERENT version hashes (legally distinct)", () => {
    const en = SIGNED_DOCUMENT_CONTENT.code_of_conduct!.en.contentHtml;
    const es = SIGNED_DOCUMENT_CONTENT.code_of_conduct!.es.contentHtml;
    const hEn = hashContent(en, "en");
    const hEs = hashContent(es, "es");
    assert.notEqual(hEn, hEs);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateSignedDocumentPdf smoke tests
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_INPUT = {
  tenantName: "Phes",
  employeeName: "Jose Ardila",
  documentTitle: "Drug and Alcohol Policy Acknowledgment",
  documentType: "drug_alcohol",
  contentBody: SIGNED_DOCUMENT_CONTENT.drug_alcohol!.en.contentHtml,
  locale: "en",
  pendingTranslationReview: false,
  employeeSignature: "Jose Ardila",
  employeeSignatureMethod: "typed" as const,
  signedAt: new Date("2026-05-12T20:00:00Z"),
  ipAddress: "203.0.113.42",
  deviceInfo: "Chrome 120 / macOS",
  versionHash: "a".repeat(64),
};

describe("generateSignedDocumentPdf", () => {
  it("renders a valid PDF for an English drug-alcohol acknowledgment", async () => {
    const bytes = await generateSignedDocumentPdf(SAMPLE_INPUT);
    assert.ok(bytes.byteLength > 2000, "PDF should be at least 2KB");
    const header = Buffer.from(bytes.slice(0, 4)).toString("utf8");
    assert.equal(header, "%PDF");
  });

  it("renders a Spanish acknowledgment with the translation-review banner", async () => {
    const esBody = SIGNED_DOCUMENT_CONTENT.drug_alcohol!.es.contentHtml;
    const bytes = await generateSignedDocumentPdf({
      ...SAMPLE_INPUT,
      contentBody: esBody,
      locale: "es",
      pendingTranslationReview: true,
      documentTitle: "Reconocimiento de la Política de Drogas y Alcohol",
    });
    assert.ok(bytes.byteLength > 2000);
  });

  it("renders a co-signed document (representative signature block)", async () => {
    const bytes = await generateSignedDocumentPdf({
      ...SAMPLE_INPUT,
      representativeName: "Sal Martinez",
      representativeSignature: "Sal Martinez",
      representativeSignatureMethod: "typed",
      representativeSignedAt: new Date("2026-05-12T20:05:00Z"),
    });
    assert.ok(bytes.byteLength > 2000);
  });
});
