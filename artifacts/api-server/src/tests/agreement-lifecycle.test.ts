/**
 * Agreement lifecycle: reminders, decline, cancel/revise, resend, and the
 * rule that an office click is not a customer view.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

const lifecycle = read("../lib/agreement-lifecycle.ts");
const sign = read("../routes/sign.ts");
const forms = read("../routes/form-templates.ts");
const send = read("../lib/send-agreement.ts");
const index = read("../index.ts");
const mig = read("../phes-data-migration.ts");
const cert = read("../lib/agreement-certificate.ts");
const signUi = read("../../../qleno/src/pages/sign.tsx");
const listUi = read("../../../qleno/src/components/agreement-submissions.tsx");

describe("reminder cadence", () => {
  it("runs seven touches across thirty days, on both channels", () => {
    assert.match(lifecycle, /export const AGREEMENT_REMINDER_STEPS/);
    const days = [...lifecycle.matchAll(/\{ day: (\d+), channels:/g)].map(m => Number(m[1]));
    assert.deepEqual(days, [1, 3, 5, 8, 14, 21, 28]);
    assert.ok(days[days.length - 1] < 30, "the last touch must land before the link expires");
    assert.match(lifecycle, /channels: \["sms"\]/);
    assert.match(lifecycle, /final: true/);
  });

  it("only chases agreements that are still open", () => {
    assert.match(lifecycle, /fs\.status = 'pending'/);
    assert.match(lifecycle, /fs\.reminders_enabled = true/);
    assert.match(lifecycle, /fs\.expires_at IS NULL OR fs\.expires_at > now\(\)/);
  });

  it("advances the step even when comms are gated, so a tenant turning them on does not get all seven at once", () => {
    assert.match(lifecycle, /SET reminder_step = \$\{stepIndex \+ 1\}/);
  });

  it("is not transactional, so the comms gate and opt-outs still govern", () => {
    assert.doesNotMatch(lifecycle, /agreement_reminder[\s\S]{0,400}transactional:\s*true/);
  });

  it("fires once a day in the morning, not at night", () => {
    assert.match(index, /ctH === 10 && fired\["agreement_reminders"\]/);
    assert.match(index, /runAgreementReminders/);
  });

  it("the clock is seeded at send and restarted on a resend", () => {
    assert.match(send, /cadence_anchor_at/);
    assert.match(send, /nextReminderAt\(anchor, 0\)/);
    assert.match(forms, /reminder_step\s*=\s*0/);
  });
});

describe("decline", () => {
  it("the customer can decline by token and say why", () => {
    assert.match(sign, /router\.post\("\/:token\/decline"/);
    assert.match(sign, /decline_reason/);
    assert.match(sign, /status = 'declined'/);
  });

  it("declining stops the chase", () => {
    assert.match(sign, /reminders_enabled = false,\s*\n?\s*next_reminder_at = NULL/);
  });

  it("the office is told", () => {
    assert.match(sign, /alertOfficeDeclined/);
    assert.match(lifecycle, /export async function alertOfficeDeclined/);
  });

  it("the decline lands on the record and on the certificate", () => {
    assert.match(cert, /declined: "Declined by signer"/);
    assert.match(cert, /cancelled: "Cancelled by our office"/);
    assert.match(cert, /reminder_sent: "Reminder sent"/);
  });

  it("the sign page offers it without making them read to the end first", () => {
    assert.match(signUi, /handleDecline/);
    assert.match(signUi, /Something here needs to change/);
    assert.match(signUi, /api\/sign\/\$\{token\}\/decline/);
  });
});

describe("cancel or revise", () => {
  it("the office can stop an agreement two different ways", () => {
    assert.match(forms, /router\.post\("\/submissions\/:id\/cancel"/);
    assert.match(forms, /cancel_kind/);
    assert.match(forms, /revision/);
  });

  it("a signed agreement can never be stopped after the fact", () => {
    assert.match(forms, /already signed\. A signed agreement cannot be cancelled here/);
  });

  it("stopping kills the link and the reminders", () => {
    assert.match(forms, /status = 'cancelled'/);
    assert.match(forms, /reminders_enabled = false/);
  });
});

describe("resend", () => {
  it("goes out to a different email or phone without minting a second link", () => {
    assert.match(forms, /router\.post\("\/submissions\/:id\/resend"/);
    assert.match(forms, /also_text/);
    assert.doesNotMatch(forms.slice(forms.indexOf('"/submissions/:id/resend"')), /sign_token\s*=\s*\$\{/);
  });

  it("is office-only", () => {
    assert.match(forms, /router\.post\("\/submissions\/:id\/resend", requireAuth, requireRole\("owner", "admin", "office"\)/);
    assert.match(forms, /router\.post\("\/submissions\/:id\/cancel", requireAuth, requireRole\("owner", "admin", "office"\)/);
  });
});

describe("an office click is not a customer view", () => {
  it("a valid staff token for the same company skips the view write", () => {
    assert.match(sign, /const internalViewer = \(\(\) => \{/);
    assert.match(sign, /p\.companyId === submission\.company_id && p\.role !== "portal_client"/);
    assert.match(sign, /if \(!internalViewer\) try \{/);
  });

  it("anything unreadable still counts as a customer view", () => {
    assert.match(sign, /catch \{ return false; \}/);
  });

  it("the sign page sends the staff token when there is one", () => {
    assert.match(signUi, /localStorage\.getItem\("qleno_token"\)/);
    assert.match(signUi, /Authorization: `Bearer \$\{staffToken\}`/);
  });
});

describe("the office list", () => {
  it("splits pending into not-opened and opened, and shows every closed state", () => {
    for (const b of ["waiting", "opened", "signed", "declined", "cancelled", "expired"]) {
      assert.ok(listUi.includes(`${b}:`), `missing bucket ${b}`);
    }
    assert.match(listUi, /function bucketOf/);
  });

  it("carries the actions the office needs on a live agreement", () => {
    assert.match(listUi, /Resend/);
    assert.match(listUi, /Stop/);
    assert.match(listUi, /certificate\.pdf/);
    assert.match(listUi, /agreement\.pdf/);
    assert.match(listUi, /function Timeline/);
  });

  it("reads the history from the events endpoint", () => {
    assert.match(forms, /router\.get\("\/submissions\/:id\/events"/);
    assert.match(listUi, /submissions\/\$\{id\}\/events/);
  });
});

describe("customer copy", () => {
  it("the seeded agreement emails carry no em dashes", () => {
    const block = mig.slice(mig.indexOf("const REM_SUBJECT"), mig.indexOf("agreement lifecycle seed (non-fatal)"));
    assert.ok(!block.includes("—"), "em dash in customer-facing agreement copy");
    assert.ok(!block.includes("&mdash;"), "em dash entity in customer-facing agreement copy");
  });

  it("every company gets the new templates, and seeding is idempotent", () => {
    assert.match(mig, /agreement_final_notice/);
    assert.match(mig, /agreement_revising/);
    assert.match(mig, /agreement_cancelled/);
    assert.match(mig, /WHERE NOT EXISTS/);
  });
});
