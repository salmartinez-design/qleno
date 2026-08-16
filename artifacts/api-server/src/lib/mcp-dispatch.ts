import type { Request } from "express";
import { v1Routes } from "../routes/v1/index.js";
import { markInternalDispatch } from "./api-auth.js";

// [ai-access 2026-08-15] In-process dispatch from an MCP tool call into the v1
// router. Design: docs/AI_ACCESS_DESIGN.md §9.
//
// WHY NOT JUST QUERY THE DATABASE FROM THE TOOL LAYER:
//   Because then there would be two implementations of "this tenant's jobs for
//   Tuesday" — the REST one and the MCP one — and they would drift. The drift
//   would not be loud: both would return plausible numbers, and only a tenant
//   comparing an assistant's answer against the dispatch board would notice.
//   Worse, every tenant-scoping guarantee proven in Phase 2 was proven about
//   the REST handlers specifically. Re-implementing the queries would put the
//   riskiest code in the codebase — the WHERE company_id clauses — in a second
//   place that the isolation test suite does not audit.
//
//   Dispatching in-process means the MCP surface runs the SAME SQL through the
//   SAME serializers. There is no second implementation to keep honest.
//
// WHY NOT LOOPBACK HTTP:
//   Calling our own URL over the network would re-authenticate a key we have
//   already verified, add a socket round-trip per tool call, and require the
//   server to know its own public address. The router is a function; call it.

export type DispatchResult = { status: number; body: any };

/**
 * Run one GET against the v1 router as the already-authenticated caller.
 *
 * `auth` and `apiKey` are copied from the live MCP request rather than rebuilt,
 * so the company, user, role, and scopes are exactly the ones requireApiKey
 * resolved. Nothing here can widen them: this function never accepts a company
 * id, and the handlers downstream read it only from req.auth.
 */
export function dispatchV1(
  source: Request,
  path: string,
  query: Record<string, string | undefined>,
): Promise<DispatchResult> {
  return new Promise((resolve) => {
    // Undefined values are dropped rather than passed as the string
    // "undefined", which is what a naive object spread would send and which the
    // parameter validators would then reject as a malformed date.
    const cleanQuery: Record<string, string> = {};
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") cleanQuery[k] = String(v);
    }

    let settled = false;
    const done = (status: number, body: any) => {
      if (settled) return;
      settled = true;
      resolve({ status, body });
    };

    const headers: Record<string, string> = {};
    const req: any = {
      method: "GET",
      url: path,
      originalUrl: `/api/v1${path}`,
      baseUrl: "/api/v1",
      path,
      query: cleanQuery,
      params: {},
      body: {},
      headers: {},
      // The verified identity is carried across; the raw credential deliberately
      // is not. The v1 routes still run requireApiKey, which sees the mark set
      // below, skips the database round-trip it already made at the MCP door,
      // and enforces the endpoint's scope against these same scopes.
      auth: source.auth,
      apiKey: source.apiKey,
      ip: source.ip,
      get(name: string) { return this.headers[name.toLowerCase()]; },
    };
    markInternalDispatch(req as Request);

    const res: any = {
      statusCode: 200,
      headersSent: false,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.headersSent = true; done(this.statusCode, body); return this; },
      send(body: any) { this.headersSent = true; done(this.statusCode, body); return this; },
      end() { this.headersSent = true; done(this.statusCode, null); return this; },
      setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); return this; },
      getHeader(k: string) { return headers[k.toLowerCase()]; },
      on() { return this; },
    };

    // v1Routes deliberately carries no 404 handler — the outer router owns that
    // for REST. Here, falling through means the tool named a path that does not
    // exist, which is a bug in the tool table rather than anything the caller
    // did. Resolving rather than hanging is the difference between a clear
    // error and an assistant waiting forever.
    v1Routes(req as Request, res, (err?: any) => {
      if (err) {
        console.error(`[mcp-dispatch] ${path} failed`, err);
        done(500, {
          error: "internal_error",
          message: "The request could not be completed.",
        });
        return;
      }
      done(404, {
        error: "not_found",
        message: `No v1 endpoint matched ${path}. This is a Qleno bug, not a problem with your request.`,
      });
    });
  });
}
