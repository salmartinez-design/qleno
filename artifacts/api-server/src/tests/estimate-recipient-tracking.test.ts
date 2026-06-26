/** Per-recipient open/click attribution: tracked_links carry a recipient, the
 *  track route records it, and the drip mints recipient-tagged pixel + link. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("per-recipient open/click tracking", () => {
  const mig = read("../phes-data-migration.ts");
  const eng = read("../lib/engagement.ts");
  const track = read("../routes/track.ts");
  const svc = read("../services/followUpService.ts");
  const ui = read("../../../qleno/src/pages/estimate-builder.tsx");

  it("tracked_links gains a recipient column", () => {
    assert.match(mig, /ALTER TABLE tracked_links ADD COLUMN IF NOT EXISTS recipient TEXT/);
    assert.match(eng, /INSERT INTO tracked_links \(token, company_id, estimate_id, enrollment_id, kind, target_url, recipient\)/);
  });
  it("track route reads + records the recipient on open + click", () => {
    assert.match(track, /SELECT company_id, estimate_id, enrollment_id, target_url, recipient/);
    assert.match(track, /SELECT company_id, estimate_id, enrollment_id, recipient/);
    assert.match(track, /recipient: link\.recipient \?\? null/);
  });
  it("drip mints recipient-tagged pixel + link", () => {
    assert.match(svc, /createOpenPixel\(\{ companyId: enr\.company_id, estimateId: enr\.estimate_id, enrollmentId: enr\.id, recipient: recipientEmail \}\)/);
    assert.match(svc, /recipient: e\.contact_email \?\? null/);
  });
  it("tracking panel shows who opened / clicked", () => {
    assert.match(ui, /Email opened\$\{r \? ` by \$\{r\}` : ""\}/);
    assert.match(ui, /Link clicked\$\{r \? ` by \$\{r\}` : ""\}/);
  });
});
