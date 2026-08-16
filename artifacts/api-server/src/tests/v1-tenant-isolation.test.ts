// [ai-access 2026-08-15] Tenant isolation for Qleno Connect (/api/v1).
//
// WHY THIS FILE EXISTS
// --------------------
// v1 is the first surface Qleno hands to a third party — a tenant's own script,
// or an AI assistant acting on their behalf. Every request arrives with a
// credential that names exactly one company, and the entire safety of the
// feature rests on one invariant:
//
//     company_id ALWAYS comes from the verified key. Never from a parameter,
//     never from a header, never from a body field, never from a default.
//
// Authorization bugs don't throw. A missing `AND company_id = $1` returns a
// perfectly valid 200 full of somebody else's customers, and nothing in CI goes
// red. So this file checks the invariant three ways, none of which needs a
// database:
//
//   Part A — the door. Every published route refuses a login JWT, refuses no
//            credential, and refuses a malformed key, all BEFORE any query runs.
//   Part B — the queries. Every SQL statement in routes/v1 that reads a tenant
//            table carries a company scope, audited from the source itself.
//   Part C — the resolver. companyOf() throws rather than defaulting, so a
//            middleware-order mistake fails loudly instead of leaking.
//
// Run:
//   DATABASE_URL=postgres://stub@stub/stub tsx --test src/tests/v1-tenant-isolation.test.ts
//
// Part B is a source audit, deliberately. A behavioural test can only cover the
// endpoints someone remembered to write a case for; this one fails the moment a
// NEW unscoped query is added to any file in routes/v1, which is the mistake we
// are actually trying to prevent.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { signToken } from "../lib/auth.js";
import v1Router from "../routes/v1/index.js";
import { companyOf } from "../routes/v1/_shared.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V1_DIR = path.join(HERE, "..", "routes", "v1");

// ── Fixtures ────────────────────────────────────────────────────────────────

// A perfectly valid office login for company 1. It must NOT open v1: a session
// token is a human credential, and admitting it here would mean every browser
// tab could reach the published API with the user's ambient session.
const sessionToken = signToken({ userId: 1, companyId: 1, role: "owner", email: "owner@phes.io" });

// Shaped like a real key (qlno_live_<12>_<43>) but corresponds to no row. Used
// to prove the format check is not what grants access.
const wellFormedFakeKey = `qlno_live_${"A".repeat(12)}_${"B".repeat(43)}`;

// Every GET this API publishes. When a route is added to routes/v1, it belongs
// in this list — an endpoint nobody added here is an endpoint nobody proved
// refuses a session token.
const ROUTES: string[] = [
  "/api/v1/me",
  "/api/v1/jobs",
  "/api/v1/jobs/1",
  "/api/v1/schedule/day",
  "/api/v1/schedule/unassigned",
  "/api/v1/technicians",
  "/api/v1/clients",
  "/api/v1/clients/1",
  "/api/v1/accounts",
  "/api/v1/accounts/1/properties",
  "/api/v1/invoices",
  "/api/v1/invoices/1",
  "/api/v1/payroll/summary?from=2026-08-01&to=2026-08-07",
  "/api/v1/payroll/employee/1?from=2026-08-01&to=2026-08-07",
  "/api/v1/reports/revenue?from=2026-08-01&to=2026-08-07",
  "/api/v1/reports/kpis?from=2026-08-01&to=2026-08-07",
  "/api/v1/reports/efficiency?from=2026-08-01&to=2026-08-07",
];

function startApp(): Promise<{ base: string; close: () => void }> {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", v1Router);
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const { port } = server.address() as any;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

async function hit(base: string, route: string, token?: string) {
  const res = await fetch(`${base}${route}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON is itself a failure below */ }
  return { status: res.status, body };
}

// ── Part A: the door ────────────────────────────────────────────────────────

test("v1 refuses a login session token on every published route", async () => {
  const { base, close } = await startApp();
  try {
    for (const route of ROUTES) {
      const { status, body } = await hit(base, route, sessionToken);
      assert.equal(status, 401, `${route} accepted a login JWT (got ${status})`);
      // The message has to tell a developer what to do instead. A bare
      // "unauthorized" against a valid-looking token sends people hunting for a
      // bug in their token handling rather than reading the docs.
      assert.match(String(body?.message ?? ""), /API key/i, `${route} gave no usable reason`);
    }
  } finally { close(); }
});

test("v1 refuses a request with no credential at all", async () => {
  const { base, close } = await startApp();
  try {
    for (const route of ROUTES) {
      const { status } = await hit(base, route);
      assert.equal(status, 401, `${route} served an anonymous request (got ${status})`);
    }
  } finally { close(); }
});

test("v1 refuses a malformed key before any database work", async () => {
  const { base, close } = await startApp();
  try {
    // DATABASE_URL is a stub here. If any of these reached a query the process
    // would fail to connect, so a clean 401 IS the proof that the rejection
    // happens at the door.
    for (const bad of ["qlno_", "qlno_live_", "qlno_live_short", "not-a-key", "Bearer"]) {
      const { status } = await hit(base, "/api/v1/jobs", bad);
      assert.equal(status, 401, `malformed key ${JSON.stringify(bad)} was not refused (got ${status})`);
    }
  } finally { close(); }
});

test("a well-formed key that matches no row is never served", async () => {
  const { base, close } = await startApp();
  try {
    const { status } = await hit(base, "/api/v1/jobs", wellFormedFakeKey);
    // 401 if lookup ran and found nothing; 503 if the stub DB refused the
    // connection. Either is correct. 200 would mean the token FORMAT granted
    // access, which is the failure this asserts against.
    assert.ok([401, 503].includes(status), `unknown key produced ${status}, expected 401 or 503`);
  } finally { close(); }
});

test("an unknown v1 path answers in JSON, not the app's HTML 404", async () => {
  const { base, close } = await startApp();
  try {
    // An assistant that gets an HTML error page reports a server outage. The
    // shape of a wrong path has to stay parseable.
    const { status, body } = await hit(base, "/api/v1/nope", sessionToken);
    assert.ok([401, 404].includes(status));
    assert.ok(body && typeof body.error === "string", "v1 404 did not return a JSON error");
  } finally { close(); }
});

// ── Part B: the queries ─────────────────────────────────────────────────────

// Tables whose every row belongs to exactly one tenant. Reading any of these
// without a company scope is a cross-tenant leak.
const TENANT_TABLES = [
  "jobs", "clients", "accounts", "account_properties", "invoices",
  "invoice_job_links", "users", "mileage_legs", "companies",
];

// Tables that are scoped transitively — they carry no company_id of their own
// and are only ever reached through a join to something that does. Listing them
// explicitly is what stops the audit below from being quietly widened later.
const JOIN_ONLY_TABLES = new Set([
  "job_technicians",  // reached via jobs.id, which is company-scoped
  "timeclock",        // reached via job_id / user_id, both company-scoped
  "service_zones",    // every lookup correlates on sz.company_id = <parent>.company_id
  "pay_adjustments",  // reached via mileage_legs.applied_pay_adjustment_id
]);

/** Every `sql\`…\`` template literal in a file, with its line number. */
function sqlBlocks(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const re = /sql`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    // Walk to the matching backtick, stepping over ${…} interpolations so a
    // nested sql`` fragment doesn't terminate its parent early.
    let i = m.index + 4;
    let depth = 0;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === "\\") { i++; continue; }
      if (ch === "$" && source[i + 1] === "{") { depth++; i++; continue; }
      if (ch === "}" && depth > 0) { depth--; continue; }
      if (ch === "`" && depth === 0) break;
    }
    out.push({
      line: source.slice(0, m.index).split("\n").length,
      text: source.slice(m.index + 4, i),
    });
    re.lastIndex = i;
  }
  return out;
}

function v1Files(): string[] {
  return fs.readdirSync(V1_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(V1_DIR, f));
}

/**
 * Blank out comments, preserving line numbers so a reported line still points at
 * the right place. Without this the audit reads its own explanatory prose — a
 * comment that merely NAMES `req.query.company_id` to say never to write it
 * would fail the check that nobody writes it.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      // Leave anything before the marker; a `//` inside a string literal would
      // be over-stripped, but no v1 SQL or handler line contains one.
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

test("every v1 query that reads a tenant table is company-scoped", () => {
  const problems: string[] = [];

  for (const file of v1Files()) {
    const source = stripComments(fs.readFileSync(file, "utf8"));
    for (const block of sqlBlocks(source)) {
      const text = block.text;

      // Only whole statements are audited. Fragments (a bare WHERE clause, a
      // single ORDER BY) are composed into a parent that carries the scope.
      if (!/\bSELECT\b/i.test(text)) continue;

      const reads = TENANT_TABLES.filter((t) =>
        new RegExp(`\\b(FROM|JOIN)\\s+${t}\\b`, "i").test(text));
      const needsScope = reads.filter((t) => !JOIN_ONLY_TABLES.has(t));
      if (needsScope.length === 0) continue;

      // The scope must be a BOUND parameter — `company_id = ${companyId}` —
      // never a literal and never a correlation to something the caller chose.
      // A hardcoded `company_id = 1` would pass a naive substring check and
      // serve Phes's data to every tenant on the platform.
      const bound = /company_id\s*=\s*\$\{/.test(text);
      // Correlated scoping (`sz.company_id = j.company_id`) is legitimate for a
      // lateral that hangs off an already-scoped row.
      const correlated = /company_id\s*=\s*[a-z_]+\.company_id/i.test(text);
      const literal = /company_id\s*=\s*\d+/.test(text);

      if (literal) {
        problems.push(`${path.basename(file)}:${block.line} — company_id compared to a LITERAL`);
        continue;
      }
      if (!bound && !correlated) {
        problems.push(
          `${path.basename(file)}:${block.line} — reads ${needsScope.join(", ")} with no company scope`);
      }
    }
  }

  assert.deepEqual(problems, [], `\n  ${problems.join("\n  ")}\n`);
});

test("no v1 handler takes the company from anything the caller sent", () => {
  const problems: string[] = [];
  // The only legitimate source is req.auth.companyId, reached through
  // companyOf(). Anything pulling a company out of the request itself is the
  // exact bug this whole file exists to prevent.
  const FORBIDDEN = [
    /req\.query\.[a-z_]*compan/i,
    /req\.body\.[a-z_]*compan/i,
    /req\.params\.[a-z_]*compan/i,
    /req\.headers\[['"][^'"]*compan/i,
  ];
  for (const file of v1Files()) {
    const source = stripComments(fs.readFileSync(file, "utf8"));
    source.split("\n").forEach((line, i) => {
      for (const re of FORBIDDEN) {
        if (re.test(line)) problems.push(`${path.basename(file)}:${i + 1} — ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(problems, [], `\n  ${problems.join("\n  ")}\n`);
});

test("every v1 route is mounted behind requireApiKey with a scope", () => {
  const problems: string[] = [];
  for (const file of v1Files()) {
    if (path.basename(file) === "index.ts" || path.basename(file) === "_shared.ts") continue;
    const source = stripComments(fs.readFileSync(file, "utf8"));
    source.split("\n").forEach((line, i) => {
      const m = /^router\.(get|post|patch|put|delete)\((["'`])([^"'`]+)\2\s*,\s*(.*)$/.exec(line.trim());
      if (!m) return;
      const rest = m[4];
      if (!rest.startsWith("requireApiKey(")) {
        problems.push(`${path.basename(file)}:${i + 1} — ${m[3]} is not behind requireApiKey`);
        return;
      }
      // /me is the one route that needs no scope: a key must always be able to
      // describe itself, or an integration cannot debug its own permissions.
      if (m[3] !== "/me" && !/requireApiKey\("rest",\s*"[a-z]+:[a-z]+"/.test(rest)) {
        problems.push(`${path.basename(file)}:${i + 1} — ${m[3]} requires no scope`);
      }
    });
  }
  assert.deepEqual(problems, [], `\n  ${problems.join("\n  ")}\n`);
});

test("v1 publishes no route that writes", () => {
  // Version 1 is read-only by decision. Write endpoints land in a later phase
  // with confirm-before-destructive and their own injection defenses; until
  // then a POST or DELETE appearing under routes/v1 is an accident.
  const problems: string[] = [];
  for (const file of v1Files()) {
    const source = stripComments(fs.readFileSync(file, "utf8"));
    source.split("\n").forEach((line, i) => {
      if (/^router\.(post|patch|put|delete)\(/.test(line.trim())) {
        problems.push(`${path.basename(file)}:${i + 1} — ${line.trim().slice(0, 60)}`);
      }
    });
  }
  assert.deepEqual(problems, [], `\n  ${problems.join("\n  ")}\n`);
});

// ── Part C: the resolver ────────────────────────────────────────────────────

test("companyOf throws instead of defaulting when no company resolved", () => {
  // If middleware order is ever broken so a handler runs unauthenticated, this
  // must crash into the 500 handler. Returning 0, or NaN, or undefined would
  // produce a query with a garbage scope — and `company_id = NULL` matches
  // nothing, which reads as "this tenant has no jobs" rather than as a bug.
  assert.throws(() => companyOf({} as any), /without a resolved company/);
  assert.throws(() => companyOf({ auth: {} } as any), /without a resolved company/);
  assert.throws(() => companyOf({ auth: { companyId: 0 } } as any), /without a resolved company/);
  assert.equal(companyOf({ auth: { companyId: 7 } } as any), 7);
});
