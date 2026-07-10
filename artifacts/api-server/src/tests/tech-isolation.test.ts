// [tech-isolation 2026-07-10] Proves a signed-in TECHNICIAN cannot view or act
// on other techs' jobs / pay / schedule via the API. Guards added in #1011
// (reads) and #1014 (writes). Runs offline against the REAL routers with a
// stub DATABASE_URL — every assertion here is a 403 produced by requireRole
// BEFORE any DB query runs, so no database is needed.
//
//   DATABASE_URL=postgres://stub@stub/stub tsx --test src/tests/tech-isolation.test.ts
//
// A 403 (not 401) is the point: the technician IS authenticated (valid token),
// but is still refused. 401 would only mean "not logged in".

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { signToken } from "../lib/auth.js";
import { requireAuth, requireRole } from "../lib/auth.js";
import jobsRouter from "../routes/jobs.js";
import usersRouter from "../routes/users.js";

const techToken = signToken({ userId: 999, companyId: 1, role: "technician", email: "tech@phes.io" });
const teamLeadToken = signToken({ userId: 998, companyId: 1, role: "team_lead", email: "lead@phes.io" });
const officeToken = signToken({ userId: 1, companyId: 1, role: "office", email: "office@phes.io" });

function startApp(): Promise<{ base: string; close: () => void }> {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", jobsRouter);
  app.use("/api/users", usersRouter);
  // Part B fixture: the EXACT guard chain the gated routes use.
  app.get("/guard-probe", requireAuth, requireRole("owner", "admin", "office", "super_admin"), (_req, res) => {
    res.json({ ok: true });
  });
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const { port } = server.address() as any;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

async function hit(base: string, method: string, path: string, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : {},
    body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify({}),
  });
  return res.status;
}

// Each of these leaks or mutates ANOTHER tech's job/pay/schedule. A technician
// must be refused (403) at the guard, before the handler touches the DB.
const FORBIDDEN_FOR_TECH: Array<[string, string, string]> = [
  ["GET", "/api/users/techs-with-status", "view every tech's live status + schedule"],
  ["GET", "/api/jobs", "view all jobs on the board (everyone's schedule)"],
  ["GET", "/api/users", "list every user in the company"],
  ["GET", "/api/jobs/5/technicians", "see who else is on a job"],
  ["POST", "/api/jobs/5/commission/set-pool-rate", "change the commission pool rate"],
  ["POST", "/api/jobs/5/technicians", "assign a tech to a job"],
  ["DELETE", "/api/jobs/5/technicians/2", "remove a teammate from a job"],
  ["PUT", "/api/jobs/5/technicians/2/override", "override another tech's pay"],
];

test("technician is refused (403) on every other-tech endpoint", async () => {
  const { base, close } = await startApp();
  try {
    for (const [method, path, desc] of FORBIDDEN_FOR_TECH) {
      const status = await hit(base, method, path, techToken);
      assert.equal(status, 403, `technician should be 403 (${desc}) on ${method} ${path}, got ${status}`);
    }
  } finally {
    close();
  }
});

test("team_lead (also a field role) is refused (403) the same way", async () => {
  const { base, close } = await startApp();
  try {
    for (const [method, path, desc] of FORBIDDEN_FOR_TECH) {
      const status = await hit(base, method, path, teamLeadToken);
      assert.equal(status, 403, `team_lead should be 403 (${desc}) on ${method} ${path}, got ${status}`);
    }
  } finally {
    close();
  }
});

test("the guard discriminates by role: office passes, tech 403, no-token 401", async () => {
  const { base, close } = await startApp();
  try {
    assert.equal(await hit(base, "GET", "/guard-probe", officeToken), 200, "office should pass the guard");
    assert.equal(await hit(base, "GET", "/guard-probe", techToken), 403, "technician should be blocked by the guard");
    assert.equal(await hit(base, "GET", "/guard-probe", teamLeadToken), 403, "team_lead should be blocked by the guard");
    assert.equal(await hit(base, "GET", "/guard-probe"), 401, "no token should be 401 (not authenticated)");
  } finally {
    close();
  }
});
