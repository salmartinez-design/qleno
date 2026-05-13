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

  it("includes video_photo_release (Phase 5 PR #6)", () => {
    assert.ok(SIGNED_DOCUMENT_CONTENT.video_photo_release);
    assert.ok(SIGNED_DOCUMENT_CONTENT.video_photo_release!.en);
    assert.ok(SIGNED_DOCUMENT_CONTENT.video_photo_release!.es);
  });

  it("includes non_solicitation (Phase 6 PR #7)", () => {
    assert.ok(SIGNED_DOCUMENT_CONTENT.non_solicitation);
    assert.ok(SIGNED_DOCUMENT_CONTENT.non_solicitation!.en);
    assert.ok(SIGNED_DOCUMENT_CONTENT.non_solicitation!.es);
  });

  it("includes social_media (Phase 7 PR #8)", () => {
    assert.ok(SIGNED_DOCUMENT_CONTENT.social_media);
    assert.ok(SIGNED_DOCUMENT_CONTENT.social_media!.en);
    assert.ok(SIGNED_DOCUMENT_CONTENT.social_media!.es);
  });

  it("includes supply_kit (Phase 9 PR #10)", () => {
    assert.ok(SIGNED_DOCUMENT_CONTENT.supply_kit);
    assert.ok(SIGNED_DOCUMENT_CONTENT.supply_kit!.en);
    assert.ok(SIGNED_DOCUMENT_CONTENT.supply_kit!.es);
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

  it("includes video_photo_release after PR #6", () => {
    assert.ok(listRegisteredDocumentTypes().includes("video_photo_release"));
  });

  it("includes non_solicitation after PR #7", () => {
    assert.ok(listRegisteredDocumentTypes().includes("non_solicitation"));
  });

  it("includes social_media after PR #8", () => {
    assert.ok(listRegisteredDocumentTypes().includes("social_media"));
  });

  it("includes supply_kit after PR #10", () => {
    assert.ok(listRegisteredDocumentTypes().includes("supply_kit"));
  });
});

describe("supply_kit content shape (PR #10 spec checks)", () => {
  it("English entry is NOT flagged pendingTranslationReview", () => {
    assert.equal(
      SIGNED_DOCUMENT_CONTENT.supply_kit!.en.pendingTranslationReview ?? false,
      false,
    );
  });

  it("Spanish entry is NOT flagged pendingTranslationReview (not one of the four flagged docs)", () => {
    assert.equal(
      SIGNED_DOCUMENT_CONTENT.supply_kit!.es.pendingTranslationReview ?? false,
      false,
    );
    assert.equal(isSpanishPendingTranslationReview("supply_kit"), false);
  });

  it("English Section 10 cites the Illinois Wage Payment and Collection Act (820 ILCS 115) and explicitly says signing does NOT pre-authorize automatic deductions", () => {
    const en = SIGNED_DOCUMENT_CONTENT.supply_kit!.en.contentHtml;
    assert.ok(
      en.includes("Illinois Wage Payment and Collection Act"),
      "English must reference the Illinois Wage Payment and Collection Act",
    );
    assert.ok(
      en.includes("820 ILCS 115"),
      "English must include the 820 ILCS 115 citation",
    );
    assert.ok(
      en.includes("does NOT pre-authorize"),
      "English must explicitly state signing does NOT pre-authorize automatic payroll deductions",
    );
    assert.ok(
      en.includes("separate written authorization"),
      "English must reference the required separate written authorization at time of any specific deduction",
    );
  });

  it("Spanish Section 10 cites 820 ILCS 115 with Spanish act name and explains no automatic deduction", () => {
    const es = SIGNED_DOCUMENT_CONTENT.supply_kit!.es.contentHtml;
    assert.ok(
      es.includes("Ley de Pago de Salarios y Recolección de Illinois"),
      "Spanish must reference the IL Wage Payment and Collection Act translation",
    );
    assert.ok(
      es.includes("820 ILCS 115"),
      "Spanish must include the 820 ILCS 115 citation",
    );
    assert.ok(
      es.includes("NO pre-autoriza"),
      "Spanish must explicitly state signing does NOT pre-authorize deductions",
    );
  });

  it("English content distinguishes reasonable wear from negligent damage", () => {
    const en = SIGNED_DOCUMENT_CONTENT.supply_kit!.en.contentHtml;
    assert.ok(
      en.includes("REASONABLE WEAR AND TEAR"),
      "English must call out reasonable wear and tear",
    );
    assert.ok(
      en.includes("NEGLIGENT DAMAGE"),
      "English must call out negligent damage",
    );
  });

  it("English content requires return of ALL Phes property at separation", () => {
    const en = SIGNED_DOCUMENT_CONTENT.supply_kit!.en.contentHtml;
    assert.ok(
      en.includes("return ALL Phes property"),
      "English must require return of ALL Phes property at separation",
    );
  });

  it("English content prohibits personal use of Phes supplies/equipment/vehicle/uniform", () => {
    const en = SIGNED_DOCUMENT_CONTENT.supply_kit!.en.contentHtml;
    assert.ok(
      en.includes("NO PERSONAL USE"),
      "English must include the no-personal-use section header",
    );
  });

  it("English and Spanish content hash to DIFFERENT version hashes (legally distinct)", () => {
    const en = SIGNED_DOCUMENT_CONTENT.supply_kit!.en.contentHtml;
    const es = SIGNED_DOCUMENT_CONTENT.supply_kit!.es.contentHtml;
    const hEn = hashContent(en, "en");
    const hEs = hashContent(es, "es");
    assert.notEqual(hEn, hEs);
  });
});

describe("social_media content shape (PR #8 spec checks)", () => {
  it("English entry is NOT flagged pendingTranslationReview", () => {
    assert.equal(
      SIGNED_DOCUMENT_CONTENT.social_media!.en.pendingTranslationReview ?? false,
      false,
    );
  });

  it("Spanish entry is NOT flagged pendingTranslationReview (not one of the four flagged docs)", () => {
    assert.equal(
      SIGNED_DOCUMENT_CONTENT.social_media!.es.pendingTranslationReview ?? false,
      false,
    );
    assert.equal(isSpanishPendingTranslationReview("social_media"), false);
  });

  it("English content carves out NLRA Section 7 explicitly", () => {
    const en = SIGNED_DOCUMENT_CONTENT.social_media!.en.contentHtml;
    assert.ok(
      en.includes("Section 7 of the National Labor Relations Act"),
      "English must reference NLRA Section 7 explicitly",
    );
    assert.ok(
      en.includes("29 U.S.C. 157"),
      "English must include the 29 U.S.C. 157 citation",
    );
    assert.ok(
      en.includes("protected concerted activity"),
      "English must reference protected concerted activity language",
    );
  });

  it("Spanish content carves out NLRA Section 7 explicitly", () => {
    const es = SIGNED_DOCUMENT_CONTENT.social_media!.es.contentHtml;
    assert.ok(
      es.includes("Sección 7 de la Ley Nacional de Relaciones Laborales"),
      "Spanish must reference NLRA Section 7 translated",
    );
    assert.ok(
      es.includes("29 U.S.C. 157"),
      "Spanish must include the 29 U.S.C. 157 citation",
    );
  });

  it("English content references the Illinois Right to Privacy in the Workplace Act (820 ILCS 55)", () => {
    const en = SIGNED_DOCUMENT_CONTENT.social_media!.en.contentHtml;
    assert.ok(
      en.includes("Illinois Right to Privacy in the Workplace Act"),
      "English must reference the IL Right to Privacy in the Workplace Act",
    );
    assert.ok(
      en.includes("820 ILCS 55"),
      "English must include the 820 ILCS 55 citation",
    );
  });

  it("Spanish content references 820 ILCS 55 with Spanish act name", () => {
    const es = SIGNED_DOCUMENT_CONTENT.social_media!.es.contentHtml;
    assert.ok(
      es.includes("Ley del Derecho a la Privacidad en el Lugar de Trabajo"),
      "Spanish must reference the IL Right to Privacy in the Workplace Act translation",
    );
    assert.ok(
      es.includes("820 ILCS 55"),
      "Spanish must include the 820 ILCS 55 citation",
    );
  });

  it("English content prohibits in-uniform posing with alcohol / cannabis / weapons", () => {
    const en = SIGNED_DOCUMENT_CONTENT.social_media!.en.contentHtml;
    assert.ok(
      en.includes("PHES UNIFORM RESTRICTIONS"),
      "English must include the uniform-restrictions section",
    );
    assert.ok(
      en.includes("alcohol"),
      "English must mention alcohol in the in-uniform restriction",
    );
  });

  it("English content restricts DM solicitation but allows general advertising + inbound contact", () => {
    const en = SIGNED_DOCUMENT_CONTENT.social_media!.en.contentHtml;
    assert.ok(
      en.includes("CLIENT SOLICITATION VIA SOCIAL MEDIA"),
      "English must include the client-solicitation section",
    );
    assert.ok(
      en.includes("general advertising"),
      "English must call out general advertising as permitted",
    );
    assert.ok(
      en.includes("inbound contact"),
      "English must call out inbound contact as permitted",
    );
  });

  it("English and Spanish content hash to DIFFERENT version hashes (legally distinct)", () => {
    const en = SIGNED_DOCUMENT_CONTENT.social_media!.en.contentHtml;
    const es = SIGNED_DOCUMENT_CONTENT.social_media!.es.contentHtml;
    const hEn = hashContent(en, "en");
    const hEs = hashContent(es, "es");
    assert.notEqual(hEn, hEs);
  });
});

describe("non_solicitation content shape (PR #7 spec checks)", () => {
  it("Spanish entry IS flagged pendingTranslationReview (one of the four flagged docs)", () => {
    assert.equal(
      SIGNED_DOCUMENT_CONTENT.non_solicitation!.es.pendingTranslationReview ?? false,
      true,
    );
    assert.equal(isSpanishPendingTranslationReview("non_solicitation"), true);
  });

  it("English entry is NOT flagged pendingTranslationReview (English is binding)", () => {
    assert.equal(
      SIGNED_DOCUMENT_CONTENT.non_solicitation!.en.pendingTranslationReview ?? false,
      false,
    );
  });

  it("English content cites the Illinois Freedom to Work Act with the 820 ILCS 90 citation", () => {
    const en = SIGNED_DOCUMENT_CONTENT.non_solicitation!.en.contentHtml;
    assert.ok(
      en.includes("Illinois Freedom to Work Act"),
      "English version must reference the Illinois Freedom to Work Act by name",
    );
    assert.ok(
      en.includes("820 ILCS 90"),
      "English version must include the 820 ILCS 90 citation",
    );
  });

  it("Spanish content cites the Illinois Freedom to Work Act translation + the 820 ILCS 90 citation", () => {
    const es = SIGNED_DOCUMENT_CONTENT.non_solicitation!.es.contentHtml;
    assert.ok(
      es.includes("Ley de Libertad para Trabajar de Illinois"),
      "Spanish version must reference the IL Freedom to Work Act translation",
    );
    assert.ok(
      es.includes("820 ILCS 90"),
      "Spanish version must include the 820 ILCS 90 citation",
    );
  });

  it("English content states a 12-MONTH duration verbatim", () => {
    const en = SIGNED_DOCUMENT_CONTENT.non_solicitation!.en.contentHtml;
    assert.ok(
      en.includes("TWELVE MONTHS"),
      "English must state the 12-month duration explicitly",
    );
  });

  it("English content explicitly carves out coworkers from the restriction", () => {
    const en = SIGNED_DOCUMENT_CONTENT.non_solicitation!.en.contentHtml;
    assert.ok(
      en.includes("COWORKERS ARE NOT RESTRICTED"),
      "English must include the coworker carve-out section header",
    );
  });

  it("English content includes the inbound-contact carve-out", () => {
    const en = SIGNED_DOCUMENT_CONTENT.non_solicitation!.en.contentHtml;
    assert.ok(
      en.includes("INBOUND CONTACT"),
      "English must include the INBOUND CONTACT carve-out language",
    );
  });

  it("English content includes the general-advertising carve-out", () => {
    const en = SIGNED_DOCUMENT_CONTENT.non_solicitation!.en.contentHtml;
    assert.ok(
      en.includes("GENERAL ADVERTISING"),
      "English must include the general-advertising carve-out section header",
    );
  });

  it("English content explicitly disclaims being a non-compete", () => {
    const en = SIGNED_DOCUMENT_CONTENT.non_solicitation!.en.contentHtml;
    assert.ok(
      en.includes("NO NON-COMPETE"),
      "English must include the NO NON-COMPETE section",
    );
  });

  it("English content describes remedies as injunctive + documented damages + attorney fees only (no liquidated damages)", () => {
    const en = SIGNED_DOCUMENT_CONTENT.non_solicitation!.en.contentHtml;
    assert.ok(
      en.includes("injunctive relief"),
      "English must state injunctive relief as the primary remedy",
    );
    assert.ok(
      en.includes("does not impose liquidated damages"),
      "English must explicitly disclaim liquidated damages / penalty clauses",
    );
  });

  it("English and Spanish content hash to DIFFERENT version hashes (legally distinct)", () => {
    const en = SIGNED_DOCUMENT_CONTENT.non_solicitation!.en.contentHtml;
    const es = SIGNED_DOCUMENT_CONTENT.non_solicitation!.es.contentHtml;
    const hEn = hashContent(en, "en");
    const hEs = hashContent(es, "es");
    assert.notEqual(hEn, hEs);
  });
});

// Phase 6.5 amendment: trade-secret confidentiality + direct-payment ban +
// strengthened reasonableness acknowledgment. Coworker non-solicit and
// liquidated damages remain INTENTIONALLY OMITTED per IL Freedom to Work
// Act enforceability concerns.
describe("non_solicitation Phase 6.5 amendment (post-PR #7)", () => {
  it("English Section 12 prohibits direct payments from clients with explicit tip carve-out", () => {
    const en = SIGNED_DOCUMENT_CONTENT.non_solicitation!.en.contentHtml;
    assert.ok(
      en.includes("PROHIBITION ON DIRECT PAYMENTS FROM CLIENTS"),
      "English must include the direct-payment-prohibition section header",
    );
    assert.ok(
      en.includes("Customary cash tips offered by a client and noted on the Worksheet are not direct payments"),
      "English must carve out customary cash tips from the direct-payment prohibition",
    );
  });

  it("Spanish Section 12 prohibits direct payments from clients with explicit tip carve-out", () => {
    const es = SIGNED_DOCUMENT_CONTENT.non_solicitation!.es.contentHtml;
    assert.ok(
      es.includes("PROHIBICIÓN DE PAGOS DIRECTOS DE CLIENTES"),
      "Spanish must include the direct-payment-prohibition section header",
    );
    assert.ok(
      es.includes("Las propinas en efectivo de costumbre"),
      "Spanish must carve out customary cash tips from the direct-payment prohibition",
    );
  });

  it("English Section 13 establishes indefinite trade-secret confidentiality scoped to the Illinois Trade Secrets Act (765 ILCS 1065)", () => {
    const en = SIGNED_DOCUMENT_CONTENT.non_solicitation!.en.contentHtml;
    assert.ok(
      en.includes("CONFIDENTIAL TRADE SECRETS (INDEFINITE DURATION)"),
      "English must include the trade-secret confidentiality section header",
    );
    assert.ok(
      en.includes("Illinois Trade Secrets Act (765 ILCS 1065)"),
      "English must reference the Illinois Trade Secrets Act with the 765 ILCS 1065 citation",
    );
    assert.ok(
      en.includes("the Phes client list"),
      "English must enumerate the Phes client list as a trade secret",
    );
    assert.ok(
      en.includes("pricing structures, pricing rules, and quote formulas"),
      "English must enumerate pricing rules + quote formulas as a trade secret",
    );
  });

  it("Spanish Section 13 establishes indefinite trade-secret confidentiality scoped to the Illinois Trade Secrets Act", () => {
    const es = SIGNED_DOCUMENT_CONTENT.non_solicitation!.es.contentHtml;
    assert.ok(
      es.includes("SECRETOS COMERCIALES CONFIDENCIALES (DURACIÓN INDEFINIDA)"),
      "Spanish must include the trade-secret confidentiality section header",
    );
    assert.ok(
      es.includes("Ley de Secretos Comerciales de Illinois (765 ILCS 1065)"),
      "Spanish must reference the IL Trade Secrets Act translation with the 765 ILCS 1065 citation",
    );
  });

  it("English Section 13 carves out general knowledge and NLRA Section 7 protected concerted activity", () => {
    const en = SIGNED_DOCUMENT_CONTENT.non_solicitation!.en.contentHtml;
    assert.ok(
      en.includes("does not restrict my general knowledge, skill, or experience"),
      "English must preserve the general-knowledge carve-out",
    );
    assert.ok(
      en.includes("Section 7 of the National Labor Relations Act"),
      "English must preserve the NLRA Section 7 carve-out so wage / working-condition discussion stays protected",
    );
  });

  it("Spanish Section 13 carves out NLRA Section 7 protected activity", () => {
    const es = SIGNED_DOCUMENT_CONTENT.non_solicitation!.es.contentHtml;
    assert.ok(
      es.includes("Sección 7 federal de la Ley Nacional de Relaciones Laborales"),
      "Spanish must preserve the NLRA Section 7 carve-out",
    );
  });

  it("English Section 8 contains the strengthened express reasonableness acknowledgment", () => {
    const en = SIGNED_DOCUMENT_CONTENT.non_solicitation!.en.contentHtml;
    assert.ok(
      en.includes("I expressly acknowledge"),
      "English Section 8 must include the express reasonableness acknowledgment",
    );
    assert.ok(
      en.includes("the consideration described in section 7 is adequate"),
      "English Section 8 must include the explicit consideration-adequacy acknowledgment",
    );
  });

  it("Spanish Section 8 contains the strengthened express reasonableness acknowledgment", () => {
    const es = SIGNED_DOCUMENT_CONTENT.non_solicitation!.es.contentHtml;
    assert.ok(
      es.includes("Reconozco expresamente"),
      "Spanish Section 8 must include the express reasonableness acknowledgment",
    );
  });

  it("Amendment INTENTIONALLY OMITS coworker non-solicitation (IL Freedom to Work Act enforceability concern)", () => {
    const en = SIGNED_DOCUMENT_CONTENT.non_solicitation!.en.contentHtml;
    assert.ok(
      en.includes("COWORKERS ARE NOT RESTRICTED"),
      "English must preserve the coworker carve-out; adding a coworker non-solicit for hourly workers risks blue-penciling the whole agreement under IL Freedom to Work Act",
    );
  });

  it("Amendment INTENTIONALLY OMITS liquidated damages (IL courts disfavor in hourly-worker non-solicits)", () => {
    const en = SIGNED_DOCUMENT_CONTENT.non_solicitation!.en.contentHtml;
    assert.ok(
      en.includes("does not impose liquidated damages"),
      "English must preserve the explicit liquidated-damages disclaimer; IL courts routinely strike these as penalty clauses",
    );
  });
});

describe("video_photo_release content shape (PR #6 spec checks)", () => {
  it("English entry is NOT flagged pendingTranslationReview (not in the four flagged docs)", () => {
    assert.equal(
      SIGNED_DOCUMENT_CONTENT.video_photo_release!.en.pendingTranslationReview ?? false,
      false,
    );
  });

  it("Spanish entry is NOT flagged pendingTranslationReview", () => {
    assert.equal(
      SIGNED_DOCUMENT_CONTENT.video_photo_release!.es.pendingTranslationReview ?? false,
      false,
    );
    assert.equal(isSpanishPendingTranslationReview("video_photo_release"), false);
  });

  it("English content cites the Illinois Right of Publicity Act with the 765 ILCS 1075 citation", () => {
    const en = SIGNED_DOCUMENT_CONTENT.video_photo_release!.en.contentHtml;
    assert.ok(
      en.includes("Illinois Right of Publicity Act"),
      "English version must reference the Illinois Right of Publicity Act by name",
    );
    assert.ok(
      en.includes("765 ILCS 1075"),
      "English version must include the 765 ILCS 1075 citation",
    );
  });

  it("Spanish content cites the Illinois Right of Publicity Act translation + the 765 ILCS 1075 citation", () => {
    const es = SIGNED_DOCUMENT_CONTENT.video_photo_release!.es.contentHtml;
    assert.ok(
      es.includes("Ley del Derecho de Publicidad de Illinois"),
      "Spanish version must reference the IL Right of Publicity Act translation",
    );
    assert.ok(
      es.includes("765 ILCS 1075"),
      "Spanish version must include the 765 ILCS 1075 citation",
    );
  });

  it("English content includes the AI-training carve-out verbatim", () => {
    const en = SIGNED_DOCUMENT_CONTENT.video_photo_release!.en.contentHtml;
    assert.ok(
      en.includes("SEPARATE WRITTEN CONSENT"),
      "English must require SEPARATE WRITTEN CONSENT for AI training",
    );
    assert.ok(
      en.includes("deepfake"),
      "English must mention deepfake carve-out",
    );
    assert.ok(
      en.includes("synthetic-media"),
      "English must mention synthetic-media carve-out",
    );
  });

  it("English content includes the 5-year post-separation limit verbatim", () => {
    const en = SIGNED_DOCUMENT_CONTENT.video_photo_release!.en.contentHtml;
    assert.ok(
      en.includes("5-year limit on new uses"),
      "English must include the 5-year limit on new uses",
    );
    assert.ok(
      en.includes("already in active distribution"),
      "English must call out the active-distribution exception",
    );
  });

  it("English content includes the 30-day withdrawal removal effort", () => {
    const en = SIGNED_DOCUMENT_CONTENT.video_photo_release!.en.contentHtml;
    assert.ok(
      en.includes("within 30 days"),
      "English must include the 30-day withdrawal removal effort",
    );
    assert.ok(
      en.includes("Content distributed through third parties"),
      "English must call out the third-party limitation on withdrawal",
    );
  });

  it("English content includes the courtesy preview language", () => {
    const en = SIGNED_DOCUMENT_CONTENT.video_photo_release!.en.contentHtml;
    assert.ok(
      en.includes("courtesy preview"),
      "English must mention courtesy preview",
    );
    assert.ok(
      en.includes("not a veto"),
      "English must clarify that courtesy preview is not a veto",
    );
  });

  it("English content states the release is voluntary", () => {
    const en = SIGNED_DOCUMENT_CONTENT.video_photo_release!.en.contentHtml;
    assert.ok(
      en.includes("voluntary") || en.includes("voluntarily"),
      "English must call out that signing is voluntary",
    );
  });

  it("English and Spanish content hash to DIFFERENT version hashes (legally distinct)", () => {
    const en = SIGNED_DOCUMENT_CONTENT.video_photo_release!.en.contentHtml;
    const es = SIGNED_DOCUMENT_CONTENT.video_photo_release!.es.contentHtml;
    const hEn = hashContent(en, "en");
    const hEs = hashContent(es, "es");
    assert.notEqual(hEn, hEs);
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
