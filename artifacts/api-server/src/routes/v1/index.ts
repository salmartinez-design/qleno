import { Router, type Request, type Response, type NextFunction } from "express";
import { logApiRequest } from "../../lib/api-auth.js";
import meRouter from "./me.js";
import jobsRouter from "./jobs.js";
import clientsRouter from "./clients.js";
import invoicesRouter from "./invoices.js";
import payrollRouter from "./payroll.js";
import reportsRouter from "./reports.js";

// [ai-access 2026-08-15] Qleno Connect — the tenant-facing REST API, mounted at
// /api/v1. Design: docs/AI_ACCESS_DESIGN.md §3.
//
// THIS IS A PUBLISHED CONTRACT. Everything under this router is something a
// tenant's integration — or an AI assistant acting for them — depends on. Adding
// a field is fine. Removing one, renaming one, or changing its type is a v2.
// See the header of _shared.ts for the response conventions all of these share.
//
// Nothing here trusts the caller for identity: requireApiKey resolves the key
// and every handler reads company_id from req.auth, never from a parameter.
/**
 * The endpoints themselves, WITHOUT the REST request log.
 *
 * Exported separately because the MCP server (routes/mcp.ts) answers its tools
 * by dispatching into this same router in-process — same SQL, same tenant
 * scoping, same serialization, so the two surfaces cannot drift apart and the
 * Phase 2 isolation guarantees extend to MCP for free. What MCP must NOT
 * inherit is the metering below: an MCP call is already logged once, as a tool,
 * and routing it through the REST logger would bill every tool call twice and
 * record it under a route name no tenant ever asked for.
 */
export const v1Routes = Router();

v1Routes.use(meRouter);
v1Routes.use(jobsRouter);
v1Routes.use(clientsRouter);
v1Routes.use(invoicesRouter);
v1Routes.use(payrollRouter);
v1Routes.use(reportsRouter);

const router = Router();

// Usage metering, on from day one (decision 2026-08-15: count it, don't charge
// yet). It runs BEFORE the sub-routers so it can time the response, and it
// records nothing until a key has resolved — an unauthenticated 401 belongs to
// no tenant. A counter added later cannot reconstruct the history a pricing
// conversation would need.
router.use(logApiRequest("rest"));

router.use(v1Routes);

// A wrong path should say so in this API's own vocabulary rather than falling
// through to the app's generic HTML 404, which an assistant would try to parse
// as JSON and report as a server failure.
router.use((req: Request, res: Response) => {
  res.status(404).json({
    error: "not_found",
    message: `No such endpoint: ${req.method} /api/v1${req.path}. See GET /api/v1/me for what this key can reach.`,
  });
});

// Errors thrown inside a handler land here. Published as a stable shape with no
// stack and no driver text: a Postgres error string can name columns and values
// from another part of the schema, and it would be going to a third party.
router.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  console.error(`[api/v1] ${req.method} ${req.path} failed`, err);
  if (res.headersSent) return;
  res.status(500).json({
    error: "internal_error",
    message: "The request could not be completed. If this persists, contact support with the time of the request.",
  });
});

export default router;
