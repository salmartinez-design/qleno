/**
 * Estimate PDF: renderEstimatePdf produces a real PDF Buffer for both flat and
 * itemized estimates; the route streams it; the builder has a PDF preview button.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { renderEstimatePdf } from "../lib/estimate-pdf.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

const base = {
  companyName: "Phes", estimateNumber: "EST-1001", status: "draft",
  title: "Office Cleaning", introNote: "Thanks for the opportunity.",
  contactName: "Brenda Graham", propertyName: "616 S Maplewood", serviceAddress: "616 S Maplewood Ave, Chicago, IL 60612",
  subtotal: 150, discount: 0, total: 150, terms: "Net-15.", validUntil: "2026-07-26",
};

describe("estimate PDF", () => {
  it("renders a flat-price estimate to a valid PDF buffer", async () => {
    const buf = await renderEstimatePdf({
      ...base, billingMode: "flat", flatPriceUnit: "visit", scopeNote: "Full janitorial each visit.",
      items: [{ name: "Restrooms", pricing_type: "flat", frequency: "Bi-weekly", quantity: 1, unit_rate: 0, amount: 0 }],
    });
    assert.ok(Buffer.isBuffer(buf) && buf.length > 800);
    assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
  });

  it("renders an itemized estimate to a valid PDF buffer", async () => {
    const buf = await renderEstimatePdf({
      ...base, billingMode: "itemized", flatPriceUnit: "visit", scopeNote: null,
      items: [{ name: "Floors", pricing_type: "hourly", frequency: "Weekly", quantity: 1.5, unit_rate: 50, amount: 75 }],
    });
    assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
  });

  it("embeds a company logo when one is provided", async () => {
    // 1x1 transparent PNG.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const buf = await renderEstimatePdf({
      ...base, logo: png, billingMode: "flat", flatPriceUnit: "month", scopeNote: null,
      items: [{ name: "Restrooms", pricing_type: "flat", frequency: "Semi-monthly", quantity: 1, unit_rate: 0, amount: 0 }],
    });
    assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
  });

  it("route fetches the logo + streams inline; builder previews after saving", () => {
    const route = read("../routes/estimates.ts");
    const builder = read("../../../qleno/src/pages/estimate-builder.tsx");
    assert.match(route, /router\.get\("\/:id\/pdf"/);
    assert.match(route, /setHeader\("Content-Type", "application\/pdf"\)/);
    assert.match(route, /c\.logo_url AS company_logo/);
    assert.match(route, /const logo = await fetchLogoBuffer\(est\.company_logo\)/);
    assert.match(route, /renderEstimatePdf\(\{\s*companyName: est\.company_name \|\| "Estimate", logo,/);
    // PDF + Send must persist current edits first (no stale preview/send).
    assert.match(builder, /async function downloadPdf\(\) \{[\s\S]*?const savedId = await save\(\);/);
    assert.match(builder, /async function markSent\(\) \{[\s\S]*?const savedId = await save\(\);/);
    assert.match(builder, /PDF preview/);
  });

  // [estimate-pdf-pagination 2026-08-14] A long itemized estimate (4 locations +
  // full terms) used to emit a BLANK page: the total panel is a vector fill, so
  // it silently drew off the bottom of page 1 instead of paginating, and only
  // the terms text triggered a page break. Pin that every page has content and
  // the footer is stamped on all of them.
  const longItems = Array.from({ length: 4 }, (_, i) => ({
    name: `LOCATION ${i + 1}: a long service line with address and square footage, Chicago IL 6060${i}`,
    description: "Remove all trash and replace all liners. Clean and disinfect all restrooms. "
      + "Dust high and low. Vacuum all carpeted floors and area rugs. Mop all hard surface floors. "
      + "Disinfect high touch points including door handles, light switches and reception counters.",
    pricing_type: "flat", frequency: "5x/week", quantity: 1, unit_rate: 3033.33, amount: 3033.33,
  }));
  // Sized to the real 4-location estimate that surfaced the bug: a long intro
  // (scope list), four long line names, and a full terms block.
  const longIntro = "Thank you for the walk-through. Below is our proposal for all four locations. "
    + "SCOPE OF WORK (performed every visit, at all four locations): "
    + Array.from({ length: 8 }, (_, i) => `${i + 1}. A scope line describing the work performed at every visit`).join(" ")
    + " Areas serviced include reception and waiting areas, exam rooms, treatment rooms, infusion areas, "
    + "retail rooms, community rooms, private offices, hallways, break rooms and all restrooms. "
    + "Phes provides all cleaning chemicals, equipment and trash liners. Our cleaners are W-2 employees "
    + "covered by workers compensation and general liability.";
  const longTerms = Array.from({ length: 12 }, (_, i) =>
    `SECTION ${i + 1}: ${"Terms copy that runs long enough to wrap across several lines. ".repeat(3)}`
  ).join("\n\n");
  const pageCount = (b: Buffer) => (b.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;

  it("paginates a long itemized estimate without emitting a blank page", async () => {
    const buf = await renderEstimatePdf({
      ...base, introNote: longIntro, billingMode: "itemized", flatPriceUnit: "visit", scopeNote: null,
      subtotal: 8233.32, discount: 0, total: 8233.32, terms: longTerms, items: longItems as any,
    });
    assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
    // Measured against origin/main with this exact shape: the old renderer emitted
    // THREE pages, the middle one blank — the navy total panel is a vector fill
    // that drew off the bottom of page 1 instead of paginating, and only the
    // terms text triggered a break. Reserving space first collapses it to two.
    assert.equal(pageCount(buf), 2, "long estimate must not emit a blank filler page");
  });

  it("renders per-line scope text on itemized lines", async () => {
    const withScope = await renderEstimatePdf({
      ...base, billingMode: "itemized", flatPriceUnit: "visit", scopeNote: null,
      items: [{ name: "Floors", description: "Vacuum all carpet and mop hard surfaces each visit.",
        pricing_type: "hourly", frequency: "Weekly", quantity: 1.5, unit_rate: 50, amount: 75 }] as any,
    });
    const without = await renderEstimatePdf({
      ...base, billingMode: "itemized", flatPriceUnit: "visit", scopeNote: null,
      items: [{ name: "Floors", description: null,
        pricing_type: "hourly", frequency: "Weekly", quantity: 1.5, unit_rate: 50, amount: 75 }] as any,
    });
    // The scope paragraph is real drawn content, so it makes the stream longer.
    assert.ok(withScope.length > without.length,
      "line description should be drawn into the PDF, not dropped");
  });

  it("passes description through the PDF route query and opens preview in a tab", () => {
    const route = read("../routes/estimates.ts");
    const builder = read("../../../qleno/src/pages/estimate-builder.tsx");
    // The /pdf route must SELECT description or the renderer never sees it.
    assert.match(route, /SELECT name, description, pricing_type, frequency, quantity, unit_rate, amount\s*\n\s*FROM estimate_line_items WHERE estimate_id = \$\{id\}/);
    // Itemized mode must expose the per-line scope editor.
    assert.match(builder, /Scope for this line/);
    // window.open must happen BEFORE the first await, or the popup blocker wins.
    const fn = builder.slice(builder.indexOf("async function downloadPdf()"));
    const openAt = fn.indexOf("window.open");
    const awaitAt = fn.indexOf("await save()");
    assert.ok(openAt > -1 && openAt < awaitAt, "window.open must precede the first await");
  });
});
