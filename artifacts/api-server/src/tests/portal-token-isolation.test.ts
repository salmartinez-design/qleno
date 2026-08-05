/**
 * Portal token isolation — a CUSTOMER token must never authenticate a STAFF route.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `POST /api/portal/login` signs a normal application JWT that differs from a
 * staff token only by its `role` field ('portal_client'). `requireAuth` used to
 * admit any token it could verify, special-casing only 'accountant'. So a
 * customer's portal token satisfied requireAuth everywhere.
 *
 * That mattered because ~320 staff routes are guarded by requireAuth ALONE,
 * with no requireRole, and they scope their queries by `req.auth.companyId`
 * only. `GET /api/invoices/:id` is one of them: it filters on invoice id +
 * company id and nothing else. A logged-in customer could therefore increment
 * ids and read every other customer's invoice in the tenant — and
 * `GET /api/invoices/:id/pdf` handed over the document itself.
 *
 * The fix is a single reject in requireAuth. These tests pin it, because the
 * failure is silent: nothing errors, the wrong person just gets an answer.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-portal-isolation";

let signToken: typeof import("../lib/auth.js").signToken;
let requireAuth: typeof import("../lib/auth.js").requireAuth;

before(async () => {
  ({ signToken, requireAuth } = await import("../lib/auth.js"));
});

// Minimal express doubles: record whether next() ran and what status was sent.
function runGuard(token: string, method = "GET") {
  const req: any = { headers: { authorization: `Bearer ${token}` }, method };
  const sent: { status?: number } = {};
  const res: any = {
    status(code: number) { sent.status = code; return { json: () => res }; },
  };
  let admitted = false;
  requireAuth(req, res, () => { admitted = true; });
  return { admitted, status: sent.status, auth: req.auth };
}

describe("portal token isolation", () => {
  it("rejects a portal_client token on staff routes", () => {
    // The exact token routes/portal.ts issues on login.
    const portalToken = signToken({ userId: 42, companyId: 3, role: "portal_client", email: "contact@ppm.com" });
    const out = runGuard(portalToken);

    assert.equal(out.admitted, false, "a customer portal token reached a staff route");
    assert.equal(out.status, 403);
  });

  it("does not populate req.auth for a portal token", () => {
    // Load-bearing on its own: staff handlers read req.auth.companyId to scope
    // their queries. If the guard rejected but still set req.auth, any handler
    // that ran anyway would query with a customer's company as if it were staff.
    const portalToken = signToken({ userId: 42, companyId: 3, role: "portal_client", email: "c@ppm.com" });
    assert.equal(runGuard(portalToken).auth, undefined);
  });

  it("rejects the portal token on writes as well as reads", () => {
    const portalToken = signToken({ userId: 42, companyId: 3, role: "portal_client", email: "c@ppm.com" });
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(runGuard(portalToken, method).admitted, false, `${method} admitted a portal token`);
    }
  });

  it("still admits real staff roles", () => {
    // The guard must not have become a blanket denial.
    for (const role of ["owner", "admin", "office", "technician", "trainee"]) {
      const staff = signToken({ userId: 7, companyId: 3, role, email: `${role}@phes.io` });
      const out = runGuard(staff);
      assert.equal(out.admitted, true, `${role} was locked out`);
      assert.equal(out.auth?.companyId, 3);
    }
  });

  it("leaves the accountant read-only rule intact", () => {
    const cpa = signToken({ userId: 9, companyId: 3, role: "accountant", email: "cpa@firm.com" });
    assert.equal(runGuard(cpa, "GET").admitted, true, "accountant lost read access");
    assert.equal(runGuard(cpa, "POST").admitted, false, "accountant gained write access");
  });
});
