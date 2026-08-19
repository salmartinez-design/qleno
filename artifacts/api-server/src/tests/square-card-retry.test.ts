// [square-attach-hang 2026-08-19] Maribel, on the quote builder: "The secure
// card field couldn't load" — then "still not working" after Try again.
//
// The SDK load was already hardened ([square-sdk-retry 2026-08-18]). What was
// not hardened was what happens AFTER a load: the card field was attached
// directly into the persistent container div, and the effect cleanup fired
// `card.destroy()` without awaiting it. So a retry — which re-runs the same
// effect against the same DOM node — handed Square a container that still held
// the previous card's dying iframe.
//
// Verified live against the Oak Lawn merchant in a real browser: in that state
// `card.attach()` does not reject. It NEVER SETTLES. The effect therefore never
// reaches its catch, `status` stays "loading" forever, and Try again reproduces
// it every single time. Only a full page reload cleared it — which is exactly
// the dead end the 2026-08-18 fix was supposed to have removed.
//
// The same run confirmed the fix: attaching into a fresh node each time
// survives repeated destroy/re-attach cycles (attach1/attach2/attach3 all ok).
//
// So this pins the three properties that keep a retry recoverable:
//   1. every await against the SDK is time-bounded (a hang becomes an error),
//   2. the card mounts into a node React re-creates per attempt, and
//   3. teardown is awaited by the next mount rather than dropped.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const form = readFileSync(
  path.join(__dirname, "../../../qleno/src/components/square-card-form.tsx"),
  "utf8",
);

describe("a failed card field can actually be retried", () => {
  it("no await against the Square SDK can hang forever", () => {
    assert.ok(form.includes("function withTimeout"), "needs a timeout helper");
    // Both calls hang, not just attach — payments.card() can wedge the same way.
    assert.match(form, /withTimeout<any>\(\s*payments\.card\(\)/);
    assert.match(form, /withTimeout\(\s*card\.attach\(mount\)/);
  });

  it("the card mounts into a fresh node, never into the persistent container", () => {
    // Re-attaching into an element Square has already attached to is the hang.
    assert.ok(
      !form.includes("card.attach(containerRef.current)"),
      "must not attach into the container that survives a retry",
    );
    assert.ok(form.includes("card.attach(mount)"));
    assert.ok(form.includes("const mount = mountRef.current"));
  });

  it("React throws the mount node away on every attempt", () => {
    // The key has to cover a retry AND an identity swap — both re-run the effect.
    assert.match(
      form,
      /key=\{`\$\{applicationId\}\|\$\{locationId\}\|\$\{environment\}\|\$\{reloadKey\}`\}/,
    );
    assert.match(form, /ref=\{mountRef\}/);
  });

  it("teardown is chained and awaited, not fired and forgotten", () => {
    assert.ok(form.includes("teardownRef"));
    assert.ok(
      !/if \(c\) \{ try \{ c\.destroy\(\); \} catch/.test(form),
      "cleanup must not drop the destroy promise",
    );
    assert.match(form, /await Promise\.race\(\[teardownRef\.current, sleep\(TEARDOWN_WAIT_MS\)\]\)/);
  });

  it("a wedged destroy cannot block the next attempt", () => {
    // Bounded on both sides: we wait for teardown, but never indefinitely.
    assert.match(form, /const TEARDOWN_WAIT_MS = [\d_]+;/);
  });
});
