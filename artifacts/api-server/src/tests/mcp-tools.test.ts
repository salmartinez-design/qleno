// [ai-access 2026-08-15] The MCP tool table.
//
// WHY THIS FILE EXISTS
// --------------------
// These tools are consumed by a model, not by a programmer, and that inverts
// where the bugs live. A programmer reading a wrong description writes code that
// fails loudly. A model reading a wrong description produces a confident,
// plausible, wrong answer that an operator then acts on — a number in a Slack
// message, not a stack trace. Nobody sees an error.
//
// So the assertions here are about the two things that would fail that way:
//
//   1. The wiring. A tool whose build() points at the wrong path, or whose
//      declared scope does not match the endpoint it reaches, would still return
//      200s full of real data — just the wrong data, or data this key was not
//      meant to have. Cases at the bottom pin every tool's target.
//
//   2. The contract with the model. Descriptions that omit units, path ids that
//      are not validated before being interpolated into a URL, tools advertised
//      to keys that cannot call them.
//
// Run:
//   tsx --test src/tests/mcp-tools.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { MCP_TOOLS, TOOLS_BY_NAME, toolsForScopes } from "../lib/mcp-tools.js";
import { ALL_SCOPES, READ_SCOPES } from "../lib/api-keys.js";

/** Helper: build a tool and assert it did not error out. */
function built(name: string, args: Record<string, unknown> = {}) {
  const tool = TOOLS_BY_NAME.get(name);
  assert.ok(tool, `no such tool: ${name}`);
  const out = tool!.build(args);
  assert.ok(!("error" in out), `build failed: ${(out as any).error}`);
  return out as { path: string; query: Record<string, string | undefined> };
}

// ── Shape ────────────────────────────────────────────────────────────────────

test("every tool is well-formed and uniquely named", () => {
  const seen = new Set<string>();
  for (const t of MCP_TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, `${t.name} must be snake_case`);
    assert.ok(!seen.has(t.name), `duplicate tool name: ${t.name}`);
    seen.add(t.name);

    // A scope-less tool reads no business data (list_companies) and gates on the
    // credential alone; anything that DOES declare a scope must declare a real one.
    assert.ok(t.scope === undefined || (ALL_SCOPES as readonly string[]).includes(t.scope),
      `${t.name} declares an unknown scope`);
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.inputSchema.additionalProperties, false,
      `${t.name} must reject unknown arguments — a model that invents a filter should be told, not silently ignored`);

    for (const r of t.inputSchema.required ?? []) {
      assert.ok(r in t.inputSchema.properties, `${t.name} requires '${r}' but never declares it`);
    }
  }
});

test("every tool is read-only in Phase 3", () => {
  // The moment this stops being true, the annotations in routes/mcp.ts stop
  // being constant and a confirmation gate has to exist. Failing here is the
  // reminder.
  for (const t of MCP_TOOLS) {
    if (t.scope === undefined) continue;
    assert.ok((READ_SCOPES as readonly string[]).includes(t.scope),
      `${t.name} carries the write scope ${t.scope}; Phase 3 ships reads only`);
  }
});

test("descriptions tell the model what it is looking at", () => {
  for (const t of MCP_TOOLS) {
    // Length is a crude proxy, but the failure it catches is real: a one-line
    // description has no room to state what the tool excludes, and every wrong
    // answer this table can produce comes from an unstated exclusion.
    assert.ok(t.description.length > 200,
      `${t.name}'s description is too thin to state what it excludes (${t.description.length} chars)`);

    if (/hours/i.test(t.description)) {
      assert.match(t.description, /decimal hours/,
        `${t.name} mentions hours and must say they are decimal, not hours-and-minutes`);
    }

    for (const [param, schema] of Object.entries(t.inputSchema.properties)) {
      assert.ok((schema as any).description, `${t.name}.${param} has no description`);
    }
  }
});

test("every tool that returns money names the currency", () => {
  // Listed explicitly rather than sniffed out of the prose. The first version of
  // this test matched on keywords and failed get_technician_load — whose
  // description mentions pay only to say it deliberately returns none. A list
  // that has to be edited when a tool starts returning money is the point: that
  // edit is the moment to check the unit is stated.
  const RETURNS_MONEY = [
    "get_schedule", "find_jobs", "get_job", "get_client_history",
    "get_revenue", "get_kpis", "get_payroll_summary", "get_employee_pay",
    "get_invoices", "get_receivables",
  ];
  for (const name of RETURNS_MONEY) {
    const t = TOOLS_BY_NAME.get(name);
    assert.ok(t, `${name} is listed as returning money but does not exist`);
    assert.match(t!.description, /US dollars/, `${name} returns money and must say the unit`);
  }

  // The other side of the same coin: a tool that returns no money should not be
  // quietly added to the table without someone deciding which list it is on.
  const accounted = new Set([...RETURNS_MONEY, "get_unassigned_work", "get_technician_load", "find_client", "get_efficiency", "list_companies"]);
  for (const t of MCP_TOOLS) {
    assert.ok(accounted.has(t.name), `${t.name} is new — decide whether it returns money and add it to a list here`);
  }
});

// ── Scope filtering ──────────────────────────────────────────────────────────

test("tools/list only advertises what the key can actually call", () => {
  // Advertising a tool that tools/call would refuse teaches the model to retry
  // something that can never work, and names data this key was deliberately
  // denied.
  const jobsOnly = toolsForScopes(["jobs:read"]);
  assert.ok(jobsOnly.length > 0);
  assert.ok(jobsOnly.every((t) => t.scope === "jobs:read"));
  assert.ok(!jobsOnly.some((t) => t.name === "get_payroll_summary"),
    "a jobs-only key must not be shown payroll tools");

  assert.equal(toolsForScopes([]).length, 0, "a key with no scopes sees no tools");

  const crossTenantOnly = MCP_TOOLS.filter((t) => t.crossTenantOnly).length;
  assert.equal(toolsForScopes([...READ_SCOPES]).length, MCP_TOOLS.length - crossTenantOnly,
    "a default read-only key reaches every Phase 3 tool except the cross-tenant ones");
});

// ── Cross-tenant ─────────────────────────────────────────────────────────────

test("the company argument exists only on a cross-tenant connection", () => {
  // An advertised argument is an instruction. A single-tenant connection that
  // saw `company` would send it, and every one of those calls is a refusal the
  // tenant never needed — so the common case must be byte-identical to the
  // schema that shipped before this feature existed.
  for (const t of toolsForScopes([...READ_SCOPES], false)) {
    assert.ok(!("company" in t.inputSchema.properties),
      `${t.name} advertises 'company' on a single-tenant connection`);
  }

  const cross = toolsForScopes([...READ_SCOPES], true);
  assert.ok(cross.some((t) => t.name === "list_companies"),
    "a cross-tenant connection must be able to find out which companies it covers");
  for (const t of cross) {
    if (t.crossTenantOnly) continue;
    assert.ok("company" in t.inputSchema.properties,
      `${t.name} is unreachable for any company but the home one`);
  }
});

test("injecting the company argument does not mutate the shared tool table", () => {
  // toolsForScopes runs per request. If it edited MCP_TOOLS in place, the first
  // super-admin connection of the process would leave `company` advertised to
  // every single-tenant tenant served afterwards — a bug that only appears
  // under real traffic and never in a fresh test run.
  toolsForScopes([...READ_SCOPES], true);
  const after = MCP_TOOLS.find((t) => t.name === "get_schedule")!;
  assert.ok(!("company" in after.inputSchema.properties),
    "the cross-tenant argument leaked into the module-level tool table");
});

test("payroll is reachable only with the payroll scope", () => {
  // The most sensitive table published: named people's compensation. It must not
  // be reachable by a key scoped to jobs or reports.
  const payroll = MCP_TOOLS.filter((t) => t.name.includes("pay"));
  assert.equal(payroll.length, 2, "get_payroll_summary and get_employee_pay");
  for (const t of payroll) assert.equal(t.scope, "payroll:read");

  const noPayroll = toolsForScopes(["jobs:read", "clients:read", "invoices:read", "reports:read"]);
  assert.ok(!noPayroll.some((t) => t.scope === "payroll:read"));
});

// ── Path ids ─────────────────────────────────────────────────────────────────

test("a path id that is not a plain positive integer is refused", () => {
  // These are interpolated into the URL the dispatcher runs. "1/../technicians"
  // would quietly reach a different endpoint than the tool advertises — a model
  // relaying a value out of a customer note is enough to try it.
  const bad = ["1/../technicians", "1;drop", "-1", "0", "1.5", "abc", "", null, undefined, "  "];
  for (const v of bad) {
    const out = TOOLS_BY_NAME.get("get_job")!.build({ job_id: v });
    assert.ok("error" in out, `get_job accepted ${JSON.stringify(v)} as an id`);
  }
  for (const v of bad) {
    const out = TOOLS_BY_NAME.get("get_employee_pay")!.build({ employee_id: v, from: "2026-08-01", to: "2026-08-07" });
    assert.ok("error" in out, `get_employee_pay accepted ${JSON.stringify(v)} as an id`);
  }
});

test("a numeric id arriving as a string still works", () => {
  // Models send "20810" as readily as 20810. Refusing the string would be a
  // failure the operator sees as "the assistant can't look up jobs".
  assert.equal(built("get_job", { job_id: "20810" }).path, "/jobs/20810");
  assert.equal(built("get_job", { job_id: 20810 }).path, "/jobs/20810");
});

// ── Argument handling ────────────────────────────────────────────────────────

test("omitted arguments are dropped, not sent as empty or 'undefined'", () => {
  // A query of ?date=undefined reaches the v1 date validator as junk and comes
  // back as a 400 the model cannot explain.
  const q = built("find_jobs", { from: "2026-08-01" }).query;
  assert.equal(q.from, "2026-08-01");
  for (const [k, v] of Object.entries(q)) {
    assert.ok(v === undefined || v !== "undefined", `${k} carries the string "undefined"`);
  }
});

test("a full timestamp is trimmed to the date the API expects", () => {
  // Assistants reach for ISO timestamps constantly. Passing one through would
  // 400 on a request that was entirely reasonable.
  assert.equal(built("get_schedule", { date: "2026-08-15T14:30:00.000Z" }).query.date, "2026-08-15");
  assert.equal(built("get_revenue", { from: "2026-08-01T00:00:00Z", to: "2026-08-31" }).query.from, "2026-08-01");
});

test("booleans survive as the strings the query layer reads", () => {
  assert.equal(built("find_client", { active: true }).query.active, "true");
  assert.equal(built("find_client", { active: false }).query.active, "false");
  assert.equal(built("find_client", {}).query.active, undefined, "omitted means both, not false");
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test("every tool points at the endpoint its description promises", () => {
  // The failure this catches returns 200s full of the wrong data.
  assert.equal(built("get_schedule").path, "/schedule/day");
  assert.equal(built("find_jobs").path, "/jobs");
  assert.equal(built("get_unassigned_work").path, "/schedule/unassigned");
  assert.equal(built("get_technician_load").path, "/technicians");
  assert.equal(built("find_client").path, "/clients");
  assert.equal(built("get_revenue", { from: "2026-08-01", to: "2026-08-07" }).path, "/reports/revenue");
  assert.equal(built("get_kpis", { from: "2026-08-01", to: "2026-08-07" }).path, "/reports/kpis");
  assert.equal(built("get_efficiency", { from: "2026-08-01", to: "2026-08-07" }).path, "/reports/efficiency");
  assert.equal(built("get_payroll_summary", { from: "2026-08-01", to: "2026-08-07" }).path, "/payroll/summary");
  assert.equal(built("get_invoices").path, "/invoices");
  assert.equal(built("get_receivables").path, "/invoices");
});

test("get_client_history is a job search pinned to one client", () => {
  // /clients/:id returns the client RECORD and no visits, so history has to come
  // from the jobs endpoint. Pointing it at /clients/:id would return a customer
  // card while the model reported it as service history.
  const out = built("get_client_history", { client_id: 1296, from: "2026-01-01" });
  assert.equal(out.path, "/jobs");
  assert.equal(out.query.client_id, "1296");
  assert.equal(out.query.from, "2026-01-01");
});

test("get_receivables pins status=unpaid and a caller cannot widen it", () => {
  // The whole point of the tool is "what is owed". If a model could pass
  // status: "paid" through it, the tool would answer the opposite of its name
  // while still looking like it worked.
  assert.equal(built("get_receivables").query.status, "unpaid");
  assert.equal(built("get_receivables", { status: "paid" } as any).query.status, "unpaid");
  assert.ok(!("status" in TOOLS_BY_NAME.get("get_receivables")!.inputSchema.properties),
    "get_receivables must not advertise a status argument at all");
});

test("filters reach the query untouched", () => {
  const q = built("find_jobs", {
    from: "2026-08-01", to: "2026-08-31", status: "scheduled",
    client_id: 1296, tech_id: 38, zone_id: 4, limit: 200,
  }).query;
  assert.deepEqual(
    { from: q.from, to: q.to, status: q.status, client_id: q.client_id, tech_id: q.tech_id, zone_id: q.zone_id, limit: q.limit },
    { from: "2026-08-01", to: "2026-08-31", status: "scheduled", client_id: "1296", tech_id: "38", zone_id: "4", limit: "200" },
  );
});
