/**
 * Comprehensive handbook PDF — unit tests (Phase 11, PR #13).
 *
 * Covers:
 *   - PDF generator produces non-empty bytes for a typical input.
 *   - Preview mode renders without crashing when employee signature
 *     fields are null.
 *   - PDF generator handles missing standalone acks gracefully (the
 *     table page draws a "no acks on file" note instead of crashing).
 *   - PDF starts with the %PDF magic header.
 *   - Pending-translation Spanish input renders without error.
 *
 * Eligibility / route-level / tenant-isolation testing happens in
 * lms-signed-documents.test.ts and lms-signatures.test.ts where the
 * DB + Express stack is mocked; the handbook routes reuse those same
 * patterns. Keeping this unit test focused on the pure PDF generator
 * so the test suite stays fast.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateComprehensiveHandbookPdf,
  type ComprehensiveHandbookInput,
} from "../lib/lms-handbook-pdf.js";

const BASE_INPUT: ComprehensiveHandbookInput = {
  tenantName: "Phes",
  employeeName: "Jane Q. Tester",
  locale: "en",
  pendingTranslationReview: false,
  contentBody: [
    "## Acknowledgment of Receipt and Understanding",
    "I acknowledge I have read the handbook.",
    "",
    "## At-Will Employment",
    "I understand my employment is at-will.",
  ].join("\n"),
  employeeSignature: "Jane Q. Tester",
  employeeSignatureMethod: "typed",
  signedAt: new Date("2026-05-13T14:00:00Z"),
  ipAddress: "10.0.0.1",
  deviceInfo: "Chrome / macOS",
  versionHash: "abcd1234567890efabcd1234567890efabcd1234567890efabcd1234567890ef",
  includedAcks: [
    {
      documentType: "drug_alcohol",
      title: "Drug and Alcohol Policy Acknowledgment",
      signedAt: new Date("2026-05-10T09:00:00Z"),
      versionHash: "1111111111111111111111111111111111111111111111111111111111111111",
    },
    {
      documentType: "code_of_conduct",
      title: "Code of Conduct Acknowledgment",
      signedAt: new Date("2026-05-10T09:30:00Z"),
      versionHash: "2222222222222222222222222222222222222222222222222222222222222222",
    },
  ],
  completedModuleIds: [
    "phes-policies",
    "compensation",
    "cleaning-best-practices",
    "maidcentral",
    "products-tools",
    "il-sexual-harassment",
    "drug-alcohol",
    "code-of-conduct",
    "video-photo-release",
    "non-solicitation",
    "social-media",
    "phes-401k",
    "supply-kit",
  ],
  moduleTitles: {
    "phes-policies": "Phes Policies & Procedures",
    "compensation": "Compensation",
    "cleaning-best-practices": "Cleaning Best Practices",
    "maidcentral": "MaidCentral",
    "products-tools": "Products & Tools",
    "il-sexual-harassment": "Illinois Sexual Harassment",
    "drug-alcohol": "Drug & Alcohol",
    "code-of-conduct": "Code of Conduct",
    "video-photo-release": "Video & Photo Release",
    "non-solicitation": "Non-Solicitation",
    "social-media": "Social Media",
    "phes-401k": "Phes 401(k)",
    "supply-kit": "Supply Kit Responsibility",
  },
  preview: false,
};

describe("generateComprehensiveHandbookPdf", () => {
  it("produces a non-empty PDF for a typical signed input", async () => {
    const bytes = await generateComprehensiveHandbookPdf(BASE_INPUT);
    assert.ok(bytes.length > 1000, `PDF should be > 1KB; got ${bytes.length}`);
  });

  it("PDF starts with the %PDF magic header", async () => {
    const bytes = await generateComprehensiveHandbookPdf(BASE_INPUT);
    const header = Buffer.from(bytes.slice(0, 4)).toString("ascii");
    assert.equal(header, "%PDF");
  });

  it("renders preview mode without crashing when signature is null", async () => {
    const bytes = await generateComprehensiveHandbookPdf({
      ...BASE_INPUT,
      preview: true,
      employeeSignature: null,
      employeeSignatureMethod: null,
      signedAt: null,
      ipAddress: null,
      deviceInfo: null,
    });
    assert.ok(bytes.length > 1000, "preview PDF should still be > 1KB");
  });

  it("renders a drawn-signature variant without crashing (renders name + fallback note)", async () => {
    const bytes = await generateComprehensiveHandbookPdf({
      ...BASE_INPUT,
      employeeSignature: "data:image/png;base64,iVBORw0KGgoAAAA=",
      employeeSignatureMethod: "drawn",
    });
    assert.ok(bytes.length > 1000);
  });

  it("renders Spanish content with the pending-translation banner", async () => {
    const bytes = await generateComprehensiveHandbookPdf({
      ...BASE_INPUT,
      locale: "es",
      pendingTranslationReview: true,
      contentBody: [
        "## Reconocimiento de Recepción y Comprensión",
        "Reconozco que he leído el manual.",
      ].join("\n"),
    });
    assert.ok(bytes.length > 1000);
  });

  it("handles an empty includedAcks list gracefully (draws a no-acks note)", async () => {
    const bytes = await generateComprehensiveHandbookPdf({
      ...BASE_INPUT,
      includedAcks: [],
    });
    assert.ok(bytes.length > 1000);
  });

  it("handles an empty completedModuleIds list (falls back to moduleTitles keys)", async () => {
    const bytes = await generateComprehensiveHandbookPdf({
      ...BASE_INPUT,
      completedModuleIds: [],
    });
    assert.ok(bytes.length > 1000);
  });

  it("renders a long content body that wraps across multiple pages without crashing", async () => {
    // 30 sections × 200-char paragraphs forces page overflow.
    const longBody: string[] = [];
    for (let i = 0; i < 30; i++) {
      longBody.push(`## Section ${i + 1}`);
      longBody.push(
        `This is a long paragraph of text designed to test page wrapping in the PDF generator. ` +
          `It contains enough content that the renderer should need to allocate a new page once it ` +
          `runs out of vertical space on the current page. Section ${i + 1} of 30.`,
      );
      longBody.push("");
    }
    const bytes = await generateComprehensiveHandbookPdf({
      ...BASE_INPUT,
      contentBody: longBody.join("\n"),
    });
    assert.ok(bytes.length > 5000, "multi-page PDF should be substantially larger");
  });
});
