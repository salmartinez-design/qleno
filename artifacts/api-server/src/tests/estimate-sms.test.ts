/** Text-the-estimate: gated SMS send + preview, with a builder preview modal. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("text the estimate (SMS)", () => {
  const route = read("../routes/estimates.ts");
  const ui = read("../../../qleno/src/pages/estimate-builder.tsx");
  it("preview + send routes share one body builder and use the gated sender", () => {
    assert.match(route, /router\.get\("\/:id\/sms-preview"/);
    assert.match(route, /router\.post\("\/:id\/sms"/);
    assert.match(route, /async function loadEstimateForSms/);
    assert.match(route, /const sender = await resolveSender\(companyId, r\.est\.branch_id\)/);
    assert.match(route, /if \(sender\.reason\) return res\.json\(\{ sent: false, reason: sender\.reason/);
    assert.match(route, /await sendSmsVia\(sender, to, r\.body\)/);
  });
  it("builder has the Text-to-client button + preview modal", () => {
    assert.match(ui, /async function openSms/);
    assert.match(ui, /\/api\/estimates\/\$\{savedId\}\/sms-preview/);
    assert.match(ui, /\/api\/estimates\/\$\{id\}\/sms/);
    assert.match(ui, /Text to client/);
    assert.match(ui, /Text the estimate/);
  });
  it("recipient number is editable and honored by the send", () => {
    assert.match(route, /const to = smsPhone\(req\.body\?\.to\) \|\| smsPhone\(r\.est\.contact_phone\)/);
    assert.match(ui, /value=\{smsTo\} onChange=\{e => setSmsTo\(e\.target\.value\)\}/);
    assert.match(ui, /method: "POST", body: \{ to: smsTo\.trim\(\) \}/);
  });
});
