/**
 * Estimate "Send now" + sent confirmation.
 *
 * Stub-DB. Pins: fireEstimateDay0 exists and only fires the Day-0 (step 1) touch
 * through the gated processEnrollment path; the /send route awaits it and returns
 * the emailed result; the builder shows the confirmation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { fireEstimateDay0 } from "../services/followUpService.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("estimate send-now", () => {
  const engine = read("../services/followUpService.ts");
  const route = read("../routes/estimates.ts");
  const ui = read("../../../qleno/src/pages/estimate-builder.tsx");

  it("fireEstimateDay0 is exported", () => {
    assert.equal(typeof fireEstimateDay0, "function");
  });
  it("only fires the Day-0 step (never re-sends a later touch)", () => {
    assert.match(engine, /Number\(enr\.current_step\) !== 1/);
  });
  it("goes through the gated processEnrollment path (comms/opt-out/CC/engagement reused)", () => {
    assert.match(engine, /const r = await processEnrollment\(enr\)/);
    assert.match(engine, /emailed: r\.status === "sent" && r\.channel === "email"/);
  });
  it("/send awaits enroll + fireEstimateDay0 and returns the result", () => {
    assert.match(route, /await enrollForEstimateSent/);
    assert.match(route, /await fireEstimateDay0/);
    assert.match(route, /emailed: day0\.emailed/);
  });
  it("builder confirms the send (toast + badge)", () => {
    assert.match(ui, /setEmailedTo\(/);
    assert.match(ui, /Estimate emailed to/);
  });
});
