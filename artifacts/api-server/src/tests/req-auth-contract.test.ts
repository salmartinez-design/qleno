// [req-auth 2026-08-08] `requireAuth` sets ONE thing on the request: `req.auth`
// (AuthPayload — userId / companyId, camelCase). Nothing anywhere assigns
// `req.user`. Reading it throws "Cannot read properties of undefined (reading
// 'company_id')" at runtime, and because route handlers are frequently typed
// `(req: any, res)`, TypeScript never says a word.
//
// routes/square.ts carried that mistake in every handler, so the whole Square
// office surface — save-card, customer sync, the payment review queue — 500'd on
// first touch. GET /config was the only survivor: it never reads the user.
//
// This sweeps every route file so the same typo can't reappear anywhere.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routesDir = path.join(__dirname, "../routes");
const libDir = path.join(__dirname, "../lib");
const auth = readFileSync(path.join(libDir, "auth.ts"), "utf8");

// Comments legitimately mention `req.user` — this very bug is documented in
// square.ts and reports.ts, and storage.ts has it inside commented-out code.
// Strip comments so the sweep only sees executable source.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const sources = [routesDir, libDir].flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => [
      path.relative(path.join(__dirname, ".."), path.join(dir, f)),
      stripComments(readFileSync(path.join(dir, f), "utf8")),
    ] as const),
);

describe("request auth contract", () => {
  it("requireAuth assigns req.auth and never req.user", () => {
    assert.ok(auth.includes("req.auth = payload"));
    assert.ok(!/\breq\.user\s*=/.test(auth));
  });

  it("AuthPayload is camelCase (userId / companyId)", () => {
    // The runtime error was reading snake_case `company_id` off the payload.
    assert.match(auth, /interface AuthPayload\s*\{[^}]*\buserId\b[^}]*\bcompanyId\b/s);
  });

  it("no route or lib file reads req.user", () => {
    const offenders = sources
      .filter(([, src]) => /\breq\.user\b/.test(src))
      .map(([file]) => file);
    assert.deepEqual(
      offenders,
      [],
      `these read req.user, which is always undefined — use req.auth!.companyId / req.auth!.userId:\n  ${offenders.join("\n  ")}`,
    );
  });

  it("square.ts handlers are not typed `req: any` (that hid the bug)", () => {
    const square = readFileSync(path.join(routesDir, "square.ts"), "utf8");
    // Match the handler signature only — prose in comments may quote the old form.
    assert.ok(
      !/async \(_?req: any/.test(square),
      "an `any`-typed req disables the check that would catch req.user",
    );
    assert.ok(square.includes("req.auth!.companyId!"));
  });
});
