import { Router, type Request, type Response } from "express";
import { requireApiKey, logApiRequest } from "../lib/api-auth.js";
import { dispatchV1 } from "../lib/mcp-dispatch.js";
import { TOOLS_BY_NAME, toolsForScopes } from "../lib/mcp-tools.js";
import { readableCompanies, resolveTargetCompany, type CompanyRef } from "../lib/tenant-scope.js";

// [ai-access 2026-08-15] Qleno Agent — the MCP endpoint, mounted at /api/mcp.
// Design: docs/AI_ACCESS_DESIGN.md §9-§11.
//
// WHAT THIS IS
// ------------
// Model Context Protocol over streamable HTTP: one POST per JSON-RPC message,
// the API key as a bearer token. That transport was chosen because it is the
// one Claude custom connectors, ChatGPT, and Gemini all speak without
// per-client special cases — and this feature exists precisely because Sal is on
// Claude while Maribel and Francisco are on Gemini. An assistant-specific
// integration would have been a smaller build and the wrong product.
//
// WHY IT IS HAND-ROLLED
// ---------------------
// @modelcontextprotocol/sdk is not a dependency of this repo. The surface we
// actually need is five methods and a strict request/response shape — roughly
// this file's length — against a new dependency in the request path of a tenant
// feature that reaches customer data. Wiring it by hand keeps that path made of
// code this repo owns and can audit. If the protocol grows past what is here,
// revisit; the tool table in lib/mcp-tools.ts is already independent of this.
//
// WHAT IT DOES NOT DO
// -------------------
// No sessions, no resources, no prompts, no server-initiated messages, no SSE.
// Every tool is a stateless read, so there is nothing to keep between calls and
// nothing for the server to push. Advertising capabilities we do not implement
// would make clients wait on streams that never arrive.
//
// TWO ERAS ON ONE ENDPOINT
// ------------------------
// [ai-access-modern 2026-08-16] Revision 2026-07-28 retired the `initialize`
// handshake and the session header: every request now carries its own protocol
// version, client identity, and capabilities in `_meta`, and discovery is a
// plain `server/discover` call. Google's Antigravity client speaks only that
// era, so a tenant pointing it at this URL got METHOD_NOT_FOUND and had to run
// an `npx mcp-remote` bridge to connect at all. Claude, ChatGPT and Grok still
// speak the `initialize` era. The spec explicitly permits serving both on one
// endpoint, and that is what this does — the era is read off the request, never
// configured. Note the stateless model this file already had is exactly what
// 2026-07-28 standardised; only the method names and the version list were
// wrong.

const router = Router();

// The `initialize`-era revisions we can satisfy. A client that asks for
// something else is answered with our newest rather than refused: per the spec
// it may then continue or disconnect, and refusing outright would break clients
// that would have worked fine.
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

// The per-request-metadata revisions. Kept separate from the list above because
// the two eras are answered by different code paths, and a version in the wrong
// list would route a client into a handshake it does not implement.
const MODERN_PROTOCOLS = ["2026-07-28"];

const SERVER_INFO = { name: "qleno", title: "Qleno", version: "1.0.0" };

// JSON-RPC 2.0 error codes. The first four are the spec's; the negative-32xxx
// remainder are MCP's own: -32002 "understood and refused", -32020 the headers
// disagree with the body, -32022 we do not speak the version you asked for.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const REQUEST_DENIED = -32002;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

type JsonRpcId = string | number | null;

function rpcError(res: Response, id: JsonRpcId, code: number, message: string, data?: unknown, status = 200): void {
  // HTTP stays 200 for a well-formed JSON-RPC error: the transport succeeded and
  // the error is in the envelope. Clients that see a non-200 tend to retry or
  // surface a connection failure, which would misreport "you lack that scope"
  // as "Qleno is down".
  //
  // The exceptions are the three the 2026-07-28 transport pins to specific HTTP
  // statuses — unsupported version and header mismatch are 400, unknown method
  // is 404 — because that is how a dual-era client tells a modern server from a
  // legacy one. Answering those 200 would make it fall back to `initialize`.
  res.status(status).json({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function rpcResult(res: Response, id: JsonRpcId, result: unknown): void {
  // `resultType` is the 2026-07-28 discriminator between a finished result and
  // one that is asking for more input. We never ask, so it is always "complete"
  // — but it has to be present, and only for clients in that era: the older
  // ones have no such field and their schemas may reject it.
  const payload =
    (res as any).mcpModern === true && result && typeof result === "object" && !("resultType" in (result as object))
      ? { resultType: "complete", ...(result as object) }
      : result;
  res.status(200).json({ jsonrpc: "2.0", id, result: payload });
}

/**
 * The one piece of text every client puts in front of the model before it picks
 * a tool. Shared by both eras so the two can never drift — `initialize` returns
 * it as `instructions`, `server/discover` returns it under the same name.
 */
function serverInstructions(crossTenant: boolean): string {
  return (
    "Qleno runs a residential and commercial cleaning business: the job schedule, the customer book, invoices, and payroll. " +
    (crossTenant
      // Said here as well as in list_companies because a model that believes it
      // is looking at a single business will happily total two of them.
      ? "Every tool reads live data for ONE company at a time and nothing here can change anything. " +
        "This connection covers several separate companies: call list_companies for the ones it can read, then pass `company` on any tool to ask about one of them. " +
        "Omit `company` and the answer is about the home company listed first. Never combine figures from two companies unless the question is explicitly about the group. "
      : "Every tool reads live data for this company only and nothing here can change anything. ") +
    "Money is US dollars, hours are decimal hours, and dates are YYYY-MM-DD in the company's own timezone — omit a date to get today. " +
    "List results are paginated: when a response carries next_cursor there are more rows, so page through before stating any total. " +
    "Read each tool's description before choosing between similar ones; several draw a distinction that matters, such as booked revenue versus money actually owed."
  );
}

/**
 * A tool result the model can read.
 *
 * MCP carries tool output as content blocks, and every client renders text. The
 * payload is pretty-printed JSON rather than prose: the model is better at
 * reading structure than our summarizer would be at writing it, and a summary
 * would be a second place where units and edge cases could go wrong.
 */
function toolContent(payload: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

router.use(logApiRequest("mcp"));

/**
 * MCP is POST-only here.
 *
 * The 2025-03-26 transport allowed a GET that opened an SSE stream for
 * server-initiated messages; 2026-07-28 removed it outright and requires 405 in
 * its place, which is what this already returned. We have nothing to push
 * either way, so a client that opened one would hold a connection forever
 * waiting. Saying so plainly beats a silent hang.
 */
router.get("/", (_req: Request, res: Response) => {
  res.status(405).json({
    error: "method_not_allowed",
    message: "This MCP endpoint accepts POST only. It sends no server-initiated messages, so there is no stream to open.",
  });
});

router.post("/", requireApiKey("mcp"), async (req: Request, res: Response) => {
  const body = req.body;

  // Batches are refused rather than half-supported. Each entry could be a
  // different tool, and the usage log records ONE route name per HTTP request —
  // so a batch would be metered as a single call under whichever name we picked,
  // and a tenant reading their own activity would see fewer calls than they made.
  // Every client we target sends one message per request.
  if (Array.isArray(body)) {
    rpcError(res, null, INVALID_REQUEST, "Batched JSON-RPC requests are not supported. Send one message per request.");
    return;
  }
  if (!body || typeof body !== "object") {
    rpcError(res, null, PARSE_ERROR, "Request body must be a single JSON-RPC 2.0 object.");
    return;
  }

  const id: JsonRpcId = body.id === undefined ? null : body.id;
  const method = typeof body.method === "string" ? body.method : null;
  const params = (body.params ?? {}) as Record<string, any>;

  if (!method) {
    rpcError(res, id, INVALID_REQUEST, "Missing 'method'.");
    return;
  }

  // ── Which era is this client in? ─────────────────────────────────────────
  // Read off the request, not configured. A 2026-07-28 client states its
  // version in `params._meta` on every call; an `initialize`-era client never
  // does — it states one in `initialize` and then nothing. `server/discover`
  // only exists in the modern era, so it counts on its own.
  const meta = (params._meta ?? {}) as Record<string, any>;
  const metaVersion = typeof meta["io.modelcontextprotocol/protocolVersion"] === "string"
    ? (meta["io.modelcontextprotocol/protocolVersion"] as string)
    : null;
  const headerVersion = typeof req.headers["mcp-protocol-version"] === "string"
    ? (req.headers["mcp-protocol-version"] as string)
    : null;
  const modern = method === "server/discover" || metaVersion !== null;
  (res as any).mcpModern = modern;

  if (modern) {
    // The header mirrors the body so that load balancers can route without
    // parsing JSON. If the two disagree, one of them is lying to something —
    // the spec makes rejecting it mandatory rather than picking a winner.
    if (metaVersion && headerVersion && metaVersion !== headerVersion) {
      rpcError(res, id, HEADER_MISMATCH,
        `Header mismatch: MCP-Protocol-Version header '${headerVersion}' does not match the '${metaVersion}' in params._meta.`,
        undefined, 400);
      return;
    }
    const asked = metaVersion ?? headerVersion;
    if (asked && !MODERN_PROTOCOLS.includes(asked)) {
      // Named versions, not a flat refusal: the client is expected to pick one
      // from `supported` and retry, which is the only fall-forward path the
      // modern era has. Both lists go out — a client that can drop back to the
      // `initialize` handshake can see that option here.
      rpcError(res, id, UNSUPPORTED_PROTOCOL_VERSION,
        `This server does not implement protocol version ${asked}.`,
        { supported: [...MODERN_PROTOCOLS, ...SUPPORTED_PROTOCOLS], requested: asked },
        400);
      return;
    }
  }

  // The name recorded in the tenant's activity log. Overwritten with the actual
  // tool for tools/call, which is the row an operator wants to see.
  (req as any).mcpToolName = method;

  const scopes = req.apiKey?.scopes ?? [];
  // [ai-access-oauth 2026-08-16] Two credential shapes reach this router now,
  // and they are fixed in different places. A key's scopes are edited on the
  // settings page; a chat app's are frozen at the moment the tenant approved
  // it, so the only way to widen them is to connect the app again and approve
  // the larger set. Telling a Claude user to "add the scope under Settings"
  // sends them to a screen with no control that does it.
  const isChatApp = req.apiKey?.credential === "oauth";
  const widenScope = isChatApp
    ? "Disconnect it under Settings → AI & API Access and connect it again, approving that access."
    : "An owner or admin can add it under Settings → AI & API Access.";

  // [ai-access-superadmin 2026-08-16] May this connection be pointed at another
  // tenant? Already the AND of the grant's stored consent and the approver's
  // LIVE super-admin flag — see verifyAccessToken. False for every API key.
  const crossTenant = req.apiKey?.allCompanies === true;
  const homeCompanyId = req.auth?.companyId;

  switch (method) {
    // ── Handshake, 2026-07-28 era ────────────────────────────────────────────
    // The whole of it. There is no follow-up notification and nothing to
    // remember: the client re-states who it is on every later call, which is why
    // this server needs no session and never did.
    case "server/discover": {
      rpcResult(res, id, {
        resultType: "complete",
        supportedVersions: MODERN_PROTOCOLS,
        // `tools` only, and empty rather than `{listChanged: false}` — this era
        // moved list-change notifications behind `subscriptions/listen`, which
        // we do not implement because the tool set a credential can reach is
        // fixed by its scopes for the life of the credential.
        capabilities: { tools: {} },
        instructions: serverInstructions(crossTenant),
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
        // No ttlMs or cacheScope: both the instructions and the tool list vary
        // with the caller's scopes and super-admin reach, so this response is
        // per-credential and must not be cached across them.
      });
      return;
    }

    // ── Handshake, initialize era ────────────────────────────────────────────
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : null;
      rpcResult(res, id, {
        protocolVersion: asked && SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
        // Only tools. listChanged is false because the set a key can reach is
        // fixed by its scopes, and scopes cannot change mid-connection — the key
        // would have to be edited, which ends the session at the next request
        // anyway since every call re-verifies.
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: serverInstructions(crossTenant),
      });
      return;
    }

    // Notifications carry no id and get no result — only an acknowledgement that
    // the transport accepted them.
    case "notifications/initialized":
    case "notifications/cancelled":
      res.status(202).end();
      return;

    case "ping":
      rpcResult(res, id, {});
      return;

    // ── Discovery ────────────────────────────────────────────────────────────
    case "tools/list": {
      // Filtered by the key's scopes: advertising a tool that tools/call would
      // refuse teaches the model to retry something that can never work, and
      // leaks the shape of data this key was deliberately not given.
      const visible = toolsForScopes(scopes, crossTenant);
      rpcResult(res, id, {
        tools: visible.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          // Advertised on every tool because every tool here is a read. When
          // Phase 5 adds writes, this is the flag that must stop being constant.
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        })),
        // No nextCursor: the whole table is small and returned in one page.
      });
      return;
    }

    // ── Execution ────────────────────────────────────────────────────────────
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : null;
      if (!name) { rpcError(res, id, INVALID_PARAMS, "tools/call requires a tool name."); return; }

      (req as any).mcpToolName = name;

      const tool = TOOLS_BY_NAME.get(name);
      // A cross-tenant-only tool is not merely unadvertised on a single-tenant
      // connection — it does not exist there. Answering "you lack a scope" would
      // imply a scope could unlock it; nothing about this key can.
      if (!tool || (tool.crossTenantOnly && !crossTenant)) {
        rpcError(res, id, INVALID_PARAMS, `No such tool: ${name}. Call tools/list for what this ${isChatApp ? "connection" : "key"} can use.`, {
          available: toolsForScopes(scopes, crossTenant).map((t) => t.name),
        });
        return;
      }

      // Scope is re-checked here and not only at tools/list. A client may call a
      // tool name it learned from a stale list, from another tenant's
      // documentation, or from a prompt injection — the list is a convenience,
      // this is the control.
      //
      // A tool with no scope reads no business data (list_companies), so there is
      // nothing here to withhold. `scopes.includes(undefined)` is false, which
      // would have refused it outright.
      if (tool.scope && !scopes.includes(tool.scope)) {
        rpcError(res, id, REQUEST_DENIED,
          `${isChatApp ? "This connection" : "This key"} cannot use ${name}: ` +
          `it is missing the ${tool.scope} scope. ${widenScope}`);
        return;
      }

      // ── Which single tenant does this call read? ────────────────────────────
      // Exactly one, always. Cross-tenant reach means this value VARIES between
      // calls; it never becomes a set. See lib/tenant-scope.ts for why.
      const rawArgs = (params.arguments ?? {}) as Record<string, unknown>;
      const companyArg = rawArgs.company;
      let allowed: CompanyRef[] | null = null;
      let targetCompanyId: number | undefined;

      if (crossTenant && homeCompanyId) {
        try {
          allowed = await readableCompanies(homeCompanyId, true);
        } catch (err) {
          console.error("[mcp] readableCompanies failed", err);
          rpcError(res, id, INTERNAL_ERROR, "The request could not be completed.");
          return;
        }
        const picked = resolveTargetCompany(companyArg, allowed, homeCompanyId);
        if ("error" in picked) {
          rpcResult(res, id, toolContent({ error: "invalid_argument", message: picked.error }, true));
          return;
        }
        targetCompanyId = picked.companyId;
        // The activity log should name the tenant whose data was actually read,
        // not the connection's home company.
        (res as any).qlenoTargetCompanyId = targetCompanyId;
      } else if (companyArg !== undefined && companyArg !== null && companyArg !== "") {
        // Refused rather than ignored. Silently answering for the home company
        // would hand back real numbers about the wrong business, and nothing in
        // the response would look wrong.
        rpcResult(res, id, toolContent({
          error: "invalid_argument",
          message: "This connection covers one company, so it cannot be pointed at another. Drop the company argument and ask again.",
        }, true));
        return;
      }

      // Tools that describe the CONNECTION are answered here: there is no
      // business data to fetch and so no tenant to scope it to.
      if (tool.local) {
        if (!allowed) {
          rpcError(res, id, REQUEST_DENIED, `${name} is only available on a connection that covers more than one company.`);
          return;
        }
        (res as any).qlenoResultCount = allowed.length;
        rpcResult(res, id, toolContent({
          home_company_id: homeCompanyId,
          companies: allowed,
          note: "Each company is a separate business. Ask about one at a time.",
        }));
        return;
      }

      const built = tool.build(rawArgs);
      if ("error" in built) {
        // A bad argument comes back as a tool error rather than a protocol
        // error, so the model sees it as a result it can correct and retry
        // instead of a broken connection.
        rpcResult(res, id, toolContent({ error: "invalid_argument", message: built.error }, true));
        return;
      }

      let out;
      try {
        out = await dispatchV1(req, built.path, built.query, targetCompanyId);
      } catch (err) {
        console.error(`[mcp] ${name} threw`, err);
        rpcError(res, id, INTERNAL_ERROR, "The request could not be completed.");
        return;
      }

      // Row count for the usage log — the same field the REST path records, so
      // both surfaces are measured the same way.
      const rows = Array.isArray((out.body as any)?.data)
        ? (out.body as any).data.length
        : Array.isArray((out.body as any)?.jobs)
          ? (out.body as any).jobs.length
          : out.status === 200 ? 1 : 0;
      (res as any).qlenoResultCount = rows;

      // A 4xx from v1 is handed back as a tool error carrying v1's own message.
      // Those messages were written to be actionable ("from must be a date as
      // YYYY-MM-DD"), and replacing them with something generic here would throw
      // away the one thing that lets the model fix its own call.
      rpcResult(res, id, toolContent(out.body, out.status >= 400));
      return;
    }

    default:
      // 404 for a modern client, 200 for a legacy one. That status is how a
      // dual-era client tells "this server is modern and has no such method"
      // from "this URL is not an MCP endpoint at all" — the JSON-RPC body says
      // which, and answering 200 here would send it back to `initialize`.
      rpcError(res, id, METHOD_NOT_FOUND,
        `Unsupported method: ${method}. This server implements ` +
        (modern
          ? "server/discover, tools/list, tools/call, and ping."
          : "initialize, tools/list, tools/call, and ping."),
        undefined, modern ? 404 : 200);
      return;
  }
});

export default router;
