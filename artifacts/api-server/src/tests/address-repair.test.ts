/**
 * [quote-address-cascade 2026-08-19] #1513 stopped the leak; this repairs what
 * already leaked. Every client and job converted from a quote before that
 * deploy still carries the whole address in one column with city, state and zip
 * empty, and jobs sit on the board with a valid zip and no zone.
 *
 * A bulk rewrite of customer records earns a preview and a second confirmation.
 * The invariants below are what make it safe to run at all.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, "../routes/address-repair.ts"), "utf8");
const routes = readFileSync(path.join(__dirname, "../routes/index.ts"), "utf8");
const apply = src.slice(src.indexOf('router.post("/apply"'));

describe("preview before apply", () => {
  it("the audit is read-only", () => {
    const audit = src.slice(src.indexOf('router.get("/audit"'), src.indexOf('router.post("/apply"'));
    assert.ok(!/UPDATE |INSERT |DELETE /.test(audit), "an audit that writes is not an audit");
  });

  it("both endpoints share one planner, so the preview is the thing that runs", () => {
    // Two implementations would let the office approve one set and apply another.
    assert.ok((src.match(/await planRepair\(/g) ?? []).length === 2);
  });

  it("apply is owner-only; the audit is readable by the office", () => {
    assert.ok(apply.includes('requireRole("owner")'), "a bulk customer rewrite is not an everyday action");
    assert.ok(src.includes('router.get("/audit", requireAuth, requireRole("owner", "admin", "office")'));
  });

  it("is mounted", () => {
    assert.ok(routes.includes('router.use("/address-repair", addressRepairRouter)'));
  });
});

describe("it only ever fills blanks", () => {
  it("every written column is COALESCE-guarded against the existing value", () => {
    // The guard is in the WRITE as well as the plan: a row that gained a city
    // between preview and apply keeps the one a human typed.
    for (const col of ["city", "state", "zip"]) {
      assert.ok(
        new RegExp(`${col}\\s*=\\s*COALESCE\\(NULLIF\\(BTRIM\\(${col}\\), ''\\)`).test(apply),
        `clients.${col} must never be overwritten`,
      );
    }
    for (const col of ["address_city", "address_state", "address_zip"]) {
      assert.ok(
        new RegExp(`${col}\\s*=\\s*COALESCE\\(NULLIF\\(BTRIM\\(${col}\\), ''\\)`).test(apply),
        `jobs.${col} must never be overwritten`,
      );
    }
    assert.ok(/zone_id\s*=\s*COALESCE\(zone_id,/.test(apply), "an assigned zone must never be reassigned");
  });

  it("the planner also refuses to overwrite", () => {
    const plan = src.slice(src.indexOf("async function planRepair"), src.indexOf('router.get("/audit"'));
    assert.ok(plan.includes('if (!String(c.city ?? "").trim() && p.city)'), "blank-only, in the plan too");
  });
});

describe("it never invents an address or a zone", () => {
  it("unreadable rows are reported, not guessed at", () => {
    assert.ok(src.includes("clientUnparseable"), "a row the parser cannot read is left alone and surfaced");
    assert.ok(src.includes("unparseable_sample"));
  });

  it("a zone must belong to the same company and be active", () => {
    const zoneQ = src.slice(src.indexOf("SELECT id FROM service_zones"), src.indexOf("LIMIT 1`) as any).rows[0];"));
    assert.ok(zoneQ.includes("company_id = ${companyId}"), "no cross-tenant zone match is possible");
    assert.ok(zoneQ.includes("is_active = true"));
  });

  it("a zip in no zone is reported rather than forced", () => {
    assert.ok(src.includes("jobNoZone"), "a grey tile is visible and fixable; an invented zone is neither");
    assert.ok(src.includes("no_zone_possible"));
  });
});

describe("history is not rewritten", () => {
  it("past jobs are excluded unless explicitly asked for", () => {
    assert.ok(src.includes("includePast ? sql`` : sql`AND j.scheduled_date >= CURRENT_DATE`"));
  });

  it("only live work is touched", () => {
    assert.ok(src.includes("j.status IN ('scheduled', 'in_progress')"),
      "a completed or cancelled visit records what actually happened");
  });
});

describe("the client record stays canonical", () => {
  it("a job prefers the client's stored components over a parse of its own line", () => {
    const plan = src.slice(src.indexOf("if (String(j.address_street"));
    assert.ok(plan.includes('String(j.c_city ?? "").trim() || p.city'), "a corrected customer address wins");
  });
});
