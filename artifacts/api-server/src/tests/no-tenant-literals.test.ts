/**
 * Phes is a tenant, not the product.
 *
 * Sal, 2026-08-19: "go through all codebase and ensure nothing is customized to
 * only work for phes. It can be used by Phes just as any other tenant would use
 * it."
 *
 * Qleno grew out of running one cleaning company and that company's identity
 * leaked into the product as literals — a name, two Chicago phone numbers, an
 * @phes.io sending domain, a branch slug as a schema DEFAULT. Every one is
 * right for exactly one customer and wrong for the next, in the worst possible
 * place: an email a stranger's client receives.
 *
 * This test is the ratchet. The allow-list is the honest record of what has not
 * been converted yet — entries come OFF it as the work lands, and adding one
 * back should take an argument. New runtime code cannot introduce a tenant
 * literal at all.
 *
 * Seed and migration files are excluded by directory, not by exception: loading
 * one tenant's historical data is legitimately about that tenant. What matters
 * is that no code path a DIFFERENT tenant executes can mention this one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(fileURLToPath(new URL("../", import.meta.url)));

// One tenant's data-loading scripts. Not executed on another tenant's behalf.
const TENANT_DATA_FILES = new Set([
  "phes-data-migration.ts",
  "cutover-data-migration.ts",
  "seed.ts",
  "seed-demo.ts",
  "user-companies-migration.ts",
  "smoke-test.ts",
  "lib/smoke-test.ts",
  "scripts/_phes_slug.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "tests") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Comments are the design record — "[phes-is-a-tenant]" notes and the history of
// why a literal was removed must stay readable. Only executable text counts.
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const FILES = walk(SRC)
  .map((f) => ({ path: relative(SRC, f), code: stripComments(readFileSync(f, "utf8")) }))
  .filter((f) => !TENANT_DATA_FILES.has(f.path));

/**
 * Files that still carry a tenant literal in executable code. THIS LIST SHOULD
 * ONLY EVER GET SHORTER. Each entry is a promise to a future tenant that has
 * not been kept yet.
 */
const NOT_YET_CONVERTED = new Set<string>([
  // Customer-facing email/SMS copy and senders — converting these is the next
  // slice; they need resolveTenantBrand threaded through every send path.
  "lib/branchRouter.ts",            // two Chicago numbers + @phes.io, and no companyId at all
  "lib/emailTemplates.ts",
  "lib/notify.ts",
  "lib/leave-notifications.ts",
  "lib/phes-booking-confirmation.ts",
  "lib/phes-email-shell.ts",
  "lib/phes-quote-email.ts",
  "lib/confirmation-pdf.ts",
  "lib/booking-confirmation.ts",
  "lib/pdf-gen.ts",
  "lib/lms-handbook-pdf.ts",
  "lib/lms-signed-documents-content.ts",   // one tenant's handbook, as code
  "services/notificationService.ts",
  "services/followUpService.ts",
  "services/testSendService.ts",
  "routes/public.ts",
  "routes/appointment.ts",
  "routes/contact.ts",
  "routes/employee-extended.ts",
  "routes/form-templates.ts",
  "routes/lms-certificates.ts",
  "routes/quotes.ts",
  "utils/rateLock.ts",

  // The branch slug 'oak_lawn' used as an identity, a default, or a seed.
  // A tenant in Denver should never meet this string.
  "routes/zones.ts",                // PHES_SEED: Chicago zips, auto-seeded (gated to company 1 — still a literal id)
  "routes/branches.ts",             // a hardcoded branch→company map: { 1: 1, 2: 4 }
  "routes/comms-inbound.ts",
  "routes/sms-inbound.ts",
  "routes/payment-links.ts",
  "routes/leads.ts",
  "routes/one-on-ones.ts",
  "routes/quote-scopes.ts",
  "routes/cancellation.ts",         // another `|| "noreply@phes.io"` sender fallback
  "lib/leave-cascade.ts",           // a "pto_phes" bucket slug
  "lib/webpush.ts",                 // VAPID subject defaults to support@phes.io
  "lib/square-customer-map.ts",
  "lib/agreement-merge.ts",
  "lib/leave-cascade.ts",

  // One tenant's LMS/handbook content, held as code rather than tenant data.
  "lib/lms-curriculum-titles.ts",
  "lib/lms-employee-helpers.ts",
  "routes/lms-handbook.ts",
  "routes/lms-signatures.ts",
]);

// "Phes" as a word, the sending domain, and the branch slug used as an identity.
const TENANT_LITERAL = /\bPHES\b|\bPhes\b|phes\.io|"oak_lawn"|'oak_lawn'/;

describe("no tenant is compiled into the product", () => {
  it("nothing outside the known list mentions one tenant by name", () => {
    const offenders = FILES
      .filter((f) => TENANT_LITERAL.test(f.code))
      .map((f) => f.path)
      .filter((p) => !NOT_YET_CONVERTED.has(p))
      .sort();

    assert.deepEqual(
      offenders,
      [],
      `Tenant literal in: ${offenders.join(", ")}. ` +
        "Qleno is the product; Phes is one customer of it. Resolve the name, " +
        "phone, reply-to and sending address from resolveTenantBrand(companyId) " +
        "in lib/tenant-brand.ts — never a literal, and never a fallback to " +
        "another tenant's details.",
    );
  });

  it("the conversion list only shrinks — every entry still has something to fix", () => {
    // A stale entry is worse than no list: it reserves permission nobody needs
    // and hides that the work is done.
    const byPath = new Map(FILES.map((f) => [f.path, f]));
    const clean = [...NOT_YET_CONVERTED]
      .filter((p) => byPath.has(p) && !TENANT_LITERAL.test(byPath.get(p)!.code))
      .sort();
    assert.deepEqual(clean, [], `Converted — remove from NOT_YET_CONVERTED: ${clean.join(", ")}`);
  });
});

describe("the resolver itself has no house defaults", () => {
  const brand = readFileSync(join(SRC, "lib/tenant-brand.ts"), "utf8");
  const code = stripComments(brand);

  it("carries no tenant literal of its own", () => {
    assert.ok(!TENANT_LITERAL.test(code), "the fix cannot contain the bug");
  });

  it("returns null for an unknown company rather than inventing an identity", () => {
    assert.ok(code.includes("if (!co) return null;"));
  });

  it("returns null rather than a house sending address", () => {
    // Sending a tenant's mail from another tenant's domain fails SPF/DKIM,
    // lands in spam, and puts a stranger's brand in the inbox.
    assert.ok(code.includes("if (!brand?.from_address) return null;"));
  });

  it("never treats a default branch as a catch-all for an unmapped zip", () => {
    assert.ok(!/is_default/.test(code), "an unmapped zip belongs to the company, not to a branch");
  });
});
